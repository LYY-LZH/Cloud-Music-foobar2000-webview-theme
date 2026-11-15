/* ============================================
 * CloudMusic playback-model.js — 双轨制播放模型
 * ------------------------------------------------------------
 * 中间列表 = 播放上下文 Context（活动播放列表）：决定默认播放顺序（顺序/随机/
 *   列表循环/单曲循环都由宿主 order 决定），双击才切换。
 * 右侧列表 = 插队队列 UpNext（foobar 原生播放队列）：全局、优先级最高、播完一首
 *   移除一首、播完回到 Context 当前游标继续。队列的"优先"与"播完自动移除"由宿主
 *   原生保证；本模块只把两条必须显式的地方做出来 ——「手动下一首」走队首、
 *   「切换上下文」清空插队队列。
 * 播放历史 = 事件栈 + cursor（localStorage，上限 20）：支撑「上一首」回溯，
 *   而不是"把过去推入顶部"。
 * ============================================ */
(function() {
  'use strict';
  var CM = window.CloudMusic;
  var state = CM.state;

  /* ============================================
   * 播放上下文 Context
   * ------------------------------------------------------------
   * 媒体库 / 发现页 / 搜索结果是「视图」，不是 foobar 歌单 —— 要让它们能当作
   * Context（这一首播完顺着列表继续），必须把当前视图映射进一个专用歌单。
   * 旧实现是"替换当前活动歌单"（replaceAllAndPlay）：活动歌单如果是用户自己的
   * 歌单，内容就被顶掉了。现在统一写进这个专用歌单，用户歌单绝不参与替换。
   * 命名沿用重构规范：_MediaLibraryContext_（侧栏不显示，见 ui-playlist.js）。
   * ============================================ */
  CM.CONTEXT_PLAYLIST = '_MediaLibraryContext_';
  CM.isContextPlaylist = function(row) {
    return !!(row && row.name === CM.CONTEXT_PLAYLIST);
  };
  // 不该出现在用户界面上的歌单（侧栏 / 「添加到歌单」菜单）：
  //   · `_MediaLibraryContext_` —— 本模块自己的"当前视图"容器；
  //   · `[WebView Queue]`       —— 宿主自己的影子歌单：queue.addPaths 默认把路径
  //     写进它（官方文档：追加到专用的 [WebView Queue] 播放列表，不存在则创建），
  //     它跟用户歌单一样可见可编辑，但内容只是"曾经按路径插过队的曲目"，交给用户管理没有意义。
  CM.INTERNAL_PLAYLISTS = { '_MediaLibraryContext_': 1, '[WebView Queue]': 1 };
  CM.isInternalPlaylist = function(row) {
    return !!(row && row.name && CM.INTERNAL_PLAYLISTS[row.name]);
  };
  CM._ctxPlaylistIndex = -1;  // 最近一次解析到的上下文歌单索引
  CM._ctxSynced = null;       // { sig } 最近一次同步的内容签名（同一视图重复播放时跳过重建）

  // 找/建上下文歌单：guid 优先（改名/挪位后仍认得），其次同名，都没有则新建。
  CM.ensureContextPlaylist = function() {
    var lists = CM.playlists || [];
    var row = null;
    if (CM.settings.contextGuid) {
      var gi = CM.playlistIndexByGuid(CM.settings.contextGuid);
      if (gi >= 0) row = CM.playlistRow(gi);
    }
    if (!row) {
      for (var i = 0; i < lists.length; i++) {
        if (CM.isContextPlaylist(lists[i]) && lists[i].index != null) { row = lists[i]; break; }
      }
    }
    if (row && row.index != null) {
      CM._ctxPlaylistIndex = row.index;
      if (row.guid && CM.settings.contextGuid !== row.guid) {
        CM.settings.contextGuid = row.guid;
        CM.saveSettings();
      }
      return Promise.resolve(row.index);
    }
    return CM.api('playlist.create', { name: CM.CONTEXT_PLAYLIST }).then(function(r) {
      if (!r || r.success === false) return -1;
      var idx = r.index != null ? r.index : r.playlist;
      if (idx == null || idx < 0) return -1;
      CM._ctxPlaylistIndex = idx;
      if (r.guid) { CM.settings.contextGuid = r.guid; CM.saveSettings(); }
      CM.loadPlaylists();   // 侧栏缓存要含它（隐藏只发生在渲染层，索引/guid 查找仍需要）
      return idx;
    });
  };

  // 视图签名：标题 + **全量路径**（顺序敏感）。旧实现只比 首/尾/长度 —— 实测
  // （插件 2.1.0）library.getAll 每次重取的顺序可能不同：媒体库视图被重取后
  // 中段重排、首尾长度不变，弱签名照样匹配 → 快路径拿新顺序的行号去播旧顺序
  // 的上下文，必跳到别的歌。改成全量 join 后，任何重排都会miss签名 → 整体重建
  // （顺序没变时字符串相等，快路径照常生效）。
  function ctxSig(title, paths) {
    return (title || '') + '\u001f' + paths.join('\u001e');
  }

  /* 视图重建串行化：replaceAllAndPlay 要把整张视图写进上下文歌单（三千首时宿主
     会有明显停顿），连点几行会并发叠起多份重建请求，宿主 UI 被拖住 —— 表现就是
     "操作一快就卡死"。同一时刻只跑一份重建，在途期间的点击只记下最后一次。 */
  var ctxBusy = false;
  var ctxWaiting = null;

  /* 播放一个「视图列表」（列表行双击 / 播放全部共用）：
     视图 → 上下文歌单（整体重建）→ 定位播放 → 清空插队队列。
     startIndex 是**视图里的原始行下标**（含没有路径的条目），这里换算成上下文
     歌单里的行号；null / 越界 = 从第一首有效曲目开始。
     opts.queueClear === false 时不动插队队列；opts.onDone(ok) 回结果。 */
  CM.playContextList = function(tracks, startIndex, title, opts) {
    opts = opts || {};
    var plan = CM.trackPathPlan(tracks || []);
    var paths = plan.paths;
    if (!paths.length) {
      CM.showToast('无法播放', '未找到有效文件路径', 'error');
      if (opts.onDone) opts.onDone(false);
      return;
    }
    var rowIndex = (startIndex == null || startIndex < 0) ? null : startIndex;
    var mapped = rowIndex == null ? 0 : plan.sourceIndex.indexOf(rowIndex);
    if (mapped < 0) {
      // 点的那一行没有可用路径：旧实现会把它从 paths 里滤掉，于是"点这首播那首"
      // （整份列表往后挪一位）。这里宁可报错，也不能悄悄播到别的曲目上。
      CM.showToast('无法播放这一首', '这一行没有可用的文件路径（可能已从媒体库移除）', 'error');
      if (opts.onDone) opts.onDone(false);
      return;
    }
    startIndex = mapped;
    var sig = ctxSig(title, paths);
    if (ctxBusy) {
      ctxWaiting = { tracks: tracks, index: rowIndex, title: title, opts: opts };
      return;
    }
    ctxBusy = true;
    // 歌单被锁定 / 参数被拒等：按错误码给一句能照着做的话，不静默
    function finish(ok, resp) {
      ctxBusy = false;
      var next = ctxWaiting;
      ctxWaiting = null;
      if (!ok) {
        var code = resp && resp.code;
        var sub = (resp && resp.error) || CM.errText(code) || '宿主拒绝了这次播放请求';
        if (code === 'LOCKED') sub = '「' + CM.CONTEXT_PLAYLIST + '」被锁定，请在 foobar2000 中解锁后再试';
        CM.showToast('播放失败', sub, 'error');
        if (opts.onDone) opts.onDone(false);
        if (next) CM.playContextList(next.tracks, next.index, next.title, next.opts);
        return;
      }
      // _ctxSynced（含路径→行号映射）在 replaceAll 的读回之后统一写入，这里不再碰
      if (opts.onDone) opts.onDone(true);
      if (next) CM.playContextList(next.tracks, next.index, next.title, next.opts);
    }
    CM.ensureContextPlaylist().then(function(idx) {
      if (idx == null || idx < 0) { finish(false, null); return; }
      // 清插队队列放在**起播之前**：插件 2.1.0 起，queue.clear 落在起播窗口内会与
      // 宿主 JIT 队列的"起播尝试接纳"竞态 —— 实测（MCP 复现）表现为起播后自己跳到
      // 列表里另一首（stop reason starting_another）。清空本来就属于"切上下文"，
      // 放到起播前语义也更顺；代价是起播失败时队列已清，可接受。
      // （opts.queueClear === false 的调用方维持原样不碰队列。）
      var clearP = (opts.queueClear !== false) ? CM.clearUpNext() : Promise.resolve();
      clearP.then(function() {
      function replaceAll() {
        // ⭐ 插件 2.1.0 实测（MCP 复现）：replaceAllAndPlay **不保序** —— 给定
        // [Eat You, Duvet, APT, 5_20AM]，落盘变成 [5_20AM, APT, Duvet, Eat You]
        // （按文件名排），playIndex 按给定序解释就播到别的歌。改用：
        // autoPlay:false 先落盘 → 读回上下文建立「路径 → 真实行号」映射 →
        // playTrack 点击那一行。"播哪首"只有读回这一份权威；映射缓存进
        // _ctxSynced 给快路径免读回复用。宿主将来若恢复保序，读回结果不变，写法仍对。
        CM.api('playlist.replaceAllAndPlay', {
          playlist: idx, paths: paths, playIndex: startIndex, autoPlay: false, stopFirst: true
        }).then(function(r) {
          if (r && r.success === false) { finish(false, r); return; }
          readContextRowMap(idx).then(function(rowOf) {
            var row = rowOf[paths[startIndex]];
            // 读回里找不到点击的那一首 = 写入没有按预期落盘（桥接级失败被 CM.api 吞成
            // null、或宿主静默跳过了这条路径）。退回 startIndex 就是"点这首播那首"的
            // 旧行为，宁可报错也不猜；此时映射不可信，_ctxSynced 不写
            if (row == null) { finish(false, { error: '上下文写入后读不回这一首，可能文件已被移除' }); return; }
            CM._ctxSynced = { sig: sig, title: title || '', idx: idx, rowOf: rowOf };
            CM.api('playlist.playTrack', { playlist: idx, index: row }).then(
              function(r2) { finish(!(r2 && r2.success === false), r2); },
              function(e) { finish(false, { error: (e && e.message) || '宿主无响应' }); });
          }, function(e) { finish(false, { error: (e && e.message) || '读不回上下文歌单' }); });
        }, function(e) { finish(false, { error: (e && e.message) || '宿主无响应' }); });
      }
      // 同一份视图、且上下文歌单已在活动位：按上次读回的「路径 → 行号」映射只定位
      // 播放 —— 行号**不能**用给定序的 mapped（宿主落盘顺序 ≠ 给定顺序，见上），
      // 也避免"在同一列表里连点几首"每次都把歌单清空重填
      if (CM._ctxSynced && CM._ctxSynced.sig === sig && CM._ctxSynced.idx === idx && CM._ctxSynced.rowOf) {
        CM.api('playlist.getActive').then(function(a) {
          var act = a && (a.index != null ? a.index : a.playlist);
          if (act === idx) {
            var row = CM._ctxSynced.rowOf[paths[startIndex]];
            // 映射里查不到（上下文被外部改动而事件还没送到）：缓存不可信，
            // 退回整体重建，由重建路径自己的守卫兜底
            if (row == null) { replaceAll(); return; }
            CM.api('playlist.playTrack', { playlist: idx, index: row }).then(function(r) {
              finish(!(r && r.success === false), r);
            }, function(e) { finish(false, { error: (e && e.message) || '宿主无响应' }); });
          } else {
            replaceAll();
          }
        }, replaceAll);
        return;
      }
      replaceAll();
      });
    }, function(e) { finish(false, { error: (e && e.message) || '建不出上下文歌单' }); });
  };

  // 清空插队队列（切换上下文时调用；宿主清空只影响"待播"项，不会打断当前曲目）
  CM.clearUpNext = function() {
    return CM.api('queue.clear').then(function(r) {
      if (CM.refreshQueueBadge) CM.refreshQueueBadge();
      if (state.queueOpen && CM.renderQueue) CM.renderQueue();
      return !(r && r.success === false);
    });
  };

  // 读回上下文歌单全部行，建「路径 → 行号」映射。插件 2.1.0 起 replaceAllAndPlay
  // 落盘顺序 ≠ 给定的 paths 顺序（宿主自行重排），行号只能以读回为准。
  // 单次 count 按 500 档分页（与 ui-playlist 的 PL_CHUNK 同档）。
  function readContextRowMap(idx) {
    var rowOf = Object.create(null);
    function step(start) {
      return CM.api('playlist.getTracks', { playlist: idx, start: start, count: 500 }).then(function(r) {
        if (!r || r.success === false) throw new Error((r && r.error) || '读不回上下文歌单');
        var rows = CM.respTracks(r);
        for (var i = 0; i < rows.length; i++) {
          var p = CM.trackPath(rows[i]);
          if (p && rowOf[p] == null) rowOf[p] = rows[i].index != null ? rows[i].index : start + i;
        }
        var total = r.total != null ? r.total : (start + rows.length);
        if (rows.length && start + rows.length < total) return step(start + rows.length);
        return rowOf;
      });
    }
    return step(0);
  }

  /* 统一「播放这一行」入口（列表双击 / 右键「播放」）：
     · 歌单行（playlist + index）→ 该歌单就是 Context：切活动歌单 + 定位播放 + 清空插队队列
     · 视图行（tracks + index）  → 视图同步进上下文歌单 + 定位播放 + 清空插队队列
     · 裸路径（path）            → 游离曲：立即播放，不动任何歌单与队列 */
  CM.playRow = function(o) {
    o = o || {};
    if (o.playlist != null && o.index != null) {
      playPlaylistRow(o.playlist, o.index);
      return;
    }
    if (o.tracks && o.tracks.length) {
      CM.playContextList(o.tracks, o.index == null ? null : o.index, o.title);
      return;
    }
    CM.playNowPath(o.path);
  };

  // 歌单行播放：只在活动歌单不是它时才 setActive ——
  // setActive 会触发 playlist:activated → 整表重载，重载期间行级操作被守卫挡住
  // （表现为"点完一首马上双击/右键另一首没反应"），而且 playTrack 本身就会让该歌单成为活动歌单
  //
  // 行里存的是在线直链时先刷新一次：QQ vkey 约两小时、网易云 CDN 签名同样有期限，
  // 过期后宿主拿到就打不开、直接跳到下一首。刷新后地址变了就走"游离曲"播放（
  // 歌单里的旧行原样保留，不为了换一条直链去删改用户歌单）；刷新不出来就明说，
  // 不让 foobar 去静默跳歌。
  function playPlaylistRow(plIndex, rowIndex) {
    function startRow() {
      // 清插队队列放在起播之前（JIT 竞态说明同 playContextList；失败也要起播）
      CM.clearUpNext().then(function() {
      CM.api('playlist.getActive').then(function (a) {
        var act = a && (a.index != null ? a.index : a.playlist);
        if (act === plIndex) return null;
        return CM.apiOr('playlist.setActive', { playlist: plIndex });
      }).then(function () {
        return CM.apiOr('playlist.playTrack', { playlist: plIndex, index: rowIndex });
      }).then(function () {
        // 成功后无需再清（起播前已清）
      }, function (e) { CM.failToast(e, '播放失败'); });
      });
    }
    CM.api('playlist.getTracksAt', { playlist: plIndex, rows: [rowIndex] }).then(function (r) {
      var path = CM.trackPath(CM.respTracks(r)[0]);
      if (!path || !CM.isUrlPath(path)) { startRow(); return; }
      CM.ensureOnlinePath(path).then(function (rr) {
        if (!rr.path) {
          CM.showToast('这首在线曲目打不开', rr.error || '直链已失效', 'error');
          return;
        }
        // 地址没变（本来就新鲜 / 解析出来是同一个）→ 交给宿主播歌单里那一行，
        // 播放上下文保持不变；地址换了才走"游离曲"，歌单里的旧行原样留着。
        // 游离曲分支同样要清插队队列（与正常路径同一契约：双击歌单行 = 切上下文
        // + 清空插队队列），否则队列里的旧插队曲会在这首播完后突然接上。
        // 必须先清再插：clear 只清待播项、不打断当前曲；要是在 playNow 之后清，
        // 刚插进去那条还没算"播放中"，有被一并清掉的竞态窗口。
        if (!rr.refreshed) { startRow(); return; }
        var go = function() { CM.playFreshPath(rr.path); };
        CM.clearUpNext().then(go, go);
      });
    }, startRow);
  }

  /* ============================================
   * 在线直链：播放前要不要重新解析？
   * ============================================
   * 写进歌单 / 播放历史的都是**带签名和时效**的地址（B 站 deadline 2 小时、
   * QQ vkey 约两小时、网易云 CDN 签名更短），过期即 403。死链交给宿主 =
   * foobar 打不开 = 它自己跳下一首（用户看到的就是"晴天还没开始就跳成别的歌"）。
   *
   * 但"每首都先解析一次再播"是拿延迟换稳定性：B 站要两个往返（view + playurl），
   * 刚搜出来就播的常见场景纯属白等。所以先判断这条还能用多久：
   *   · B 站：直链自带 `deadline=<unix 秒>`（实测 = 签发时刻 + 2 小时），精确可得；
   *   · 网易云 / QQ：直链本身没有到期时间，用桥接记下的签发时间 ts + 保守余量；
   *   · 判不了（映射被裁掉 / 改过地址）：按"不确定"处理，仍然解析一次。
   * 新鲜 → 直接播（零额外延迟）；过期 → 解析（一个往返），结果缓存 2 分钟，
   * 连点 / 重播 / 按下鼠标的预取都不会重复请求。
   * ============================================ */
  var FRESH_MARGIN = 3 * 60 * 1000;                 // 到期前 3 分钟就当作已过期
  var FRESH_WINDOW = { qq: 100 * 60 * 1000, netease: 30 * 60 * 1000 };
  var FRESH_CACHE_MS = 120 * 1000;                  // 刚解析出的结果复用 2 分钟
  var _freshCache = Object.create(null);            // 原路径 → {url, at}
  var _freshPending = Object.create(null);          // 原路径 → Promise（并发去重）

  /* 这条直链的签发时间（毫秒；认不出 = 0） */
  CM.onlineIssuedAt = function(path) {
    var p = String(path || '');
    try {
      if (window.BilibiliBridge && BilibiliBridge.pathIssuedAt &&
          BilibiliBridge.isBiliUrl && BilibiliBridge.isBiliUrl(p)) {
        return BilibiliBridge.pathIssuedAt(p) || 0;
      }
      if (window.NeteaseBridge && NeteaseBridge.metaFromUrl &&
          NeteaseBridge.isNeteaseUrl && NeteaseBridge.isNeteaseUrl(p)) {
        var n = NeteaseBridge.metaFromUrl(p);
        return (n && n.ts) || 0;
      }
      if (window.QQBridge && QQBridge.pathIssuedAt) return QQBridge.pathIssuedAt(p) || 0;
    } catch (e) {}
    return 0;
  };

  /* 这条直链还新鲜吗？回 {known, fresh, expiresAt}
     known=false = 判不了（调用方应保守地解析一次）。 */
  CM.pathFreshness = function(path) {
    var p = String(path || '');
    var unknown = { known: false, fresh: false, expiresAt: 0 };
    if (!p || !CM.isUrlPath(p)) return unknown;
    // ① 直链自己写了到期时间（B 站）
    var m = /[?&]deadline=(\d{9,})/.exec(p);
    if (m) {
      var exp = parseInt(m[1], 10) * 1000;
      return { known: true, fresh: Date.now() < exp - FRESH_MARGIN, expiresAt: exp };
    }
    // ② 平台回包里带了到期时间（QQ 的 vkey expiration，实测 ≈22 小时）
    try {
      if (window.QQBridge && typeof QQBridge.pathExpiresAt === 'function') {
        var qexp = QQBridge.pathExpiresAt(p);
        if (qexp) return { known: true, fresh: Date.now() < qexp - FRESH_MARGIN, expiresAt: qexp };
      }
    } catch (e) {}
    /* ③ 平台声明"这条不能流播"：旧形态 http 明文的网易云 FLAC 直链在 foobar
       里停滞在 ~0.5 秒（2026-10-24 实测定位；https 形态能流，见 netease-core.js
       的 streamifyUrl / needStreamRefetch）。当作已过期触发重解析——老歌单里的
       FLAC 行靠这条自动换成可流播的 https 直链。 */
    try {
      // 只对网易云直链生效：判定本身只看 .flac 后缀，不限域名的话任何来源的
      // .flac 直链都会被永久判"已过期"，每次播放白跑一遍重解析
      if (window.NeteaseBridge && typeof NeteaseBridge.isNeteaseUrl === 'function' &&
          NeteaseBridge.isNeteaseUrl(p) &&
          typeof NeteaseBridge.needStreamRefetch === 'function' &&
          NeteaseBridge.needStreamRefetch(p)) {
        return { known: true, fresh: false, expiresAt: 0, refetch: '非MP3' };
      }
    } catch (e) {}
    // ④ 用签发时间 + 各平台的保守有效窗口
    var issued = CM.onlineIssuedAt(p);
    if (!issued) return unknown;
    var win = FRESH_WINDOW.netease;
    try {
      if (window.QQBridge && QQBridge.mediaMidFromUrl && QQBridge.mediaMidFromUrl(p)) win = FRESH_WINDOW.qq;
    } catch (e) {}
    return { known: true, fresh: Date.now() < issued + win, expiresAt: issued + win };
  };

  /* 强制解析一条在线直链（带 2 分钟结果缓存 + 并发去重）。
     回 {path, refreshed, error}：path 为空 = 确定拿不到可用音源，调用方必须提示，
     **不能把死链交给宿主**。path 原样返回 = 本地文件 / 不是可刷新的在线源 /
     认不出是哪一首（没有映射就没法重解析，原样播总比拒绝好）。 */
  CM.refreshOnlinePath = function(path) {
    var keep = function() { return { path: path }; };
    if (!path || !CM.isUrlPath(path)) return Promise.resolve(keep());
    var hit = _freshCache[path];
    if (hit && Date.now() - hit.at < FRESH_CACHE_MS) {
      return Promise.resolve({ path: hit.url, refreshed: hit.url !== path });
    }
    if (_freshPending[path]) return _freshPending[path];
    var job = null;
    try {
      if (window.NeteaseBridge && NeteaseBridge.isNeteaseUrl(path) &&
          typeof NeteaseBridge.refreshUrl === 'function') {
        job = NeteaseBridge.refreshUrl(path);
      } else if (window.QQBridge && typeof QQBridge.refreshUrl === 'function' &&
                 QQBridge.mediaMidFromUrl && QQBridge.mediaMidFromUrl(path)) {
        job = QQBridge.refreshUrl(path);
      } else if (window.BilibiliBridge && typeof BilibiliBridge.refreshUrl === 'function' &&
                 BilibiliBridge.isBiliUrl && BilibiliBridge.isBiliUrl(path)) {
        job = BilibiliBridge.refreshUrl(path);
      }
    } catch (e) { job = null; }
    if (!job || typeof job.then !== 'function') return Promise.resolve(keep());
    var p = job.then(function(url) {
      if (!url || typeof url !== 'string') {
        return { path: '', error: '重新解析没有拿到可用直链（可能已下架）' };
      }
      _freshCache[path] = { url: url, at: Date.now() };
      return { path: url, refreshed: url !== path };
    }, function(e) {
      if (e && e.cmUnidentifiable) return keep();
      return { path: '', error: (e && e.message) || '重新解析直链失败' };
    });
    // 并发去重：按下鼠标的预取 + 双击的播放会同时要同一首，只发一份请求
    _freshPending[path] = p;
    p.then(function() { delete _freshPending[path]; }, function() { delete _freshPending[path]; });
    return p;
  };

  /* 播放前入口：新鲜就直接给原样路径（零额外延迟），过期 / 判不了才解析一次。
     opts.quiet = 不弹"正在重新解析"提示（预取用）。
     回 {path, refreshed, cached, error}，形状与 refreshOnlinePath 兼容。 */
  CM.ensureOnlinePath = function(path, opts) {
    opts = opts || {};
    if (!path || !CM.isUrlPath(path)) return Promise.resolve({ path: path });
    var f = CM.pathFreshness(path);
    if (f.known && f.fresh) return Promise.resolve({ path: path, refreshed: false, cached: true });
    var timer = null;
    if (!opts.quiet && typeof CM.showToast === 'function') {
      // 解析要一个往返（B 站是两个）；超过 600ms 才提示，避免一闪而过
      timer = setTimeout(function() {
        CM.showToast('正在重新解析直链', '这条在线地址已过期，正在换一条新地址', null);
      }, 600);
    }
    var clear = function() { if (timer) { clearTimeout(timer); timer = null; } };
    return CM.refreshOnlinePath(path).then(function(r) {
      clear();
      return r;
    }, function(e) {
      clear();
      throw e;
    });
  };

  /* 预取：在线行鼠标按下就开始解析（双击的第二下之前就能拿到新地址），
     已经新鲜的不请求；失败静默（真播时 ensureOnlinePath 会如实报错）。 */
  CM.prefetchOnlinePath = function(path) {
    if (!path || !CM.isUrlPath(path)) return;
    if (typeof CM.pathFreshness === 'function') {
      var f = CM.pathFreshness(path);
      if (f.known && f.fresh) return;
    }
    CM.refreshOnlinePath(path).then(null, function() {});
  };

  /* 立即播放一个路径（游离曲）：把它作为**不带歌单坐标**的队列项插到队首，再让宿主立刻播它 ——
     队列里已有的插队项原样保留。用 `insertNext({paths})` 而不是 `addPaths`：后者的路径会先写进
     宿主的 `[WebView Queue]` 影子歌单、成为一个**带坐标**的队列项 —— 带坐标的队列项被播放时
     宿主会把播放上下文带到那张歌单（详见 ui-playlist.js 的 enqueueTrack 注释），播完就不会
     回到原来的清单了；裸路径项则只是"插播这一项"。
     不写任何用户歌单。在线直链先按新鲜度决定要不要刷新（见 ensureOnlinePath）。 */
  CM.playNowPath = function(path) {
    if (!path) return Promise.resolve(false);
    return CM.ensureOnlinePath(path).then(function(r) {
      if (!r.path) {
        CM.showToast('无法播放', r.error || '这首在线曲目的直链已失效', 'error');
        return false;
      }
      return playPathNow(r.path);
    });
  };

  // 已经刷新过的直链直接播（避免 playNowPath 再解析一次）
  CM.playFreshPath = function(path) { return playPathNow(path); };

  function playPathNow(path) {
    return CM.api('queue.insertNext', { paths: [path], position: 0 }).then(function(ar) {
      // 入队失败、或被宿主静默跳过（超 2048 字符的 URL 只计入 invalidCount）：队列里没有这一条，
      // 后面的播放调用会播到别的曲目上去 —— 直接走 playPath
      if (!ar || ar.success === false || ar.invalidCount) {
        CM.api('playback.playPath', { path: path });
        return true;
      }
      // queue.playNow 是宿主内置的"立刻播这一条队列项"（播完照常出队）
      return CM.api('queue.playNow', { index: 0 }).then(function(p) {
        // 老宿主没有 queue.playNow：退回宿主 next —— 我们刚把这条插在队首，
        // 而 next() 会先消费队列（旧版 playNow 一直靠这个约定）
        if (!p || p.success === false) CM.api('playback.next');
        return true;
      });
    });
  };

  /* ============================================
   * 手动 上一首 / 下一首
   * ============================================ */

  /* 下一首：插队队列非空 → 显式播队首（不依赖"宿主 next() 是否先消费队列"的隐含约定）；
     队列空 → 交回宿主的 Context 下一首。 */
  CM.nextTrack = function() {
    CM.api('queue.getCount').then(function(r) {
      if (CM.respCount(r) <= 0) { CM.api('playback.next'); return; }
      CM.api('queue.playNow', { index: 0 }).then(function(p) {
        // 老宿主没有 queue.playNow：退回宿主 next（宿主同样会先消费队列）
        if (!p || p.success === false) CM.api('playback.next');
      });
    }, function() { CM.api('playback.next'); });
  };

  /* 上一首：优先回溯播放历史；历史里没有更早的不同曲目才交回 Context 上一首。 */
  CM.prevTrack = function() {
    if (CM.history && CM.history.prev()) return;
    CM.api('playback.previous');
  };

  /* ============================================
   * 播放历史（事件栈 + cursor）
   * ------------------------------------------------------------
   * 只记录"播放事件"：连续相同曲目去重（单曲循环不刷屏）；新的播放事件截断
   * cursor 之后的未来再追加（与浏览器后退/前进同构）。「上一首」= cursor 往前
   * 找第一首不同曲目并把它设为当前（不截断，未来保留）；从历史行点播 = 同样
   * 把 cursor 移过去。上限 20 条，localStorage 持久化（只有主窗口写）。
   * ============================================ */
  var HIST_KEY = 'cloudmusic-history-v1';
  CM.history = {
    DEFAULT_MAX: 20,
    MAX_LIMITS: [5, 200],
    items: [],
    cursor: -1,
    // 历史回溯/点播的目标路径集合：这些路径的 trackChanged 不写新事件。
    // 用集合而不是单个槽位：连点两次「上一首」时两条跳转链会在途重叠，
    // 后到的 trackChanged 不该被当成新的播放事件（否则历史被截断写乱）。
    // 值 = 登记时间，超过 _navTtl 未兑现就丢弃 —— 否则"跳转的曲目根本没能播起来"
    // （直链失效 / 宿主拒绝）会把该路径永久留在集合里，之后用户手动播同一首时
    // 那次播放就不会进历史。
    _navPaths: Object.create(null),
    _navTtl: 30000,
    /* 回溯目标的「歌名/歌手」。在线直链过期后播放会被换成一条新地址（见
       playback-model.js 的 ensureOnlinePath），trackChanged 报的路径和 history 里
       存的那条**不一样** —— 只按路径抑制会让这次回溯被当成新的播放事件：写一条
       重复历史，还把 cursor 后面的"未来"截掉。路径对不上时用它认人。 */
    _navWant: null,
    _purgeNav: function(now) {
      var t = (now || Date.now()) - this._navTtl;
      var map = this._navPaths;
      for (var p in map) if (map[p] < t) delete map[p];
    },
    // 上限可配（设置页「播放历史条数」）；被改坏时回默认值
    max: function() {
      var n = parseInt(CM.settings.historyMax, 10);
      if (!n || isNaN(n)) n = this.DEFAULT_MAX;
      return Math.max(this.MAX_LIMITS[0], Math.min(this.MAX_LIMITS[1], n));
    },
    load: function() {
      var MAX = this.max();
      try {
        var raw = localStorage.getItem(HIST_KEY);
        if (!raw) return;
        var d = JSON.parse(raw);
        if (!d || Object.prototype.toString.call(d.items) !== '[object Array]') return;
        this.items = d.items.filter(function(it) { return it && it.path; }).slice(-MAX);
        var c = parseInt(d.cursor, 10);
        this.cursor = (c >= 0 && c < this.items.length) ? c : this.items.length - 1;
      } catch (e) { this.items = []; this.cursor = -1; }
    },
    save: function() {
      var MAX = this.max();
      if (this.items.length > MAX) {
        this.items = this.items.slice(this.items.length - MAX);
        this.cursor = this.items.length - 1;
      }
      try { localStorage.setItem(HIST_KEY, JSON.stringify({ items: this.items, cursor: this.cursor })); } catch (e) {}
      if (state.queueOpen && CM.renderHistory) CM.renderHistory();
    },
    clear: function() { this.items = []; this.cursor = -1; this._navPaths = Object.create(null); this._navWant = null; this.save(); },
    // 记录一次播放事件（app.js 的 playback:trackChanged 调用）
    note: function(track) {
      var path = CM.trackPath(track);
      if (!path) return;
      this._purgeNav();
      if (this._navPaths[path]) {
        // 本次换曲来自历史回溯/点播：cursor 已就位，不再写入也不截断（未来保留）
        delete this._navPaths[path];
        this._navWant = null;
        this.save();
        return;
      }
      // 路径对不上但确实是同一次回溯（在线直链被刷新成新地址）：按歌名/歌手认，
      // 同样不写新事件、不截断未来
      var want = this._navWant;
      if (want && Date.now() - want.at < this._navTtl) {
        var tName = CM.trackName(track) || '', tArtist = CM.trackArtist(track) || '';
        if ((!want.title || tName === want.title) && (!want.artist || tArtist === want.artist)) {
          this._navWant = null;
          this.save();
          return;
        }
      }
      if (this.cursor < this.items.length - 1) this.items = this.items.slice(0, this.cursor + 1);
      var last = this.items[this.items.length - 1];
      if (last && last.path === path) { this.cursor = this.items.length - 1; this.save(); return; }
      this.items.push({ path: path, title: CM.trackName(track), artist: CM.trackArtist(track), at: Date.now() });
      this.cursor = this.items.length - 1;
      this.save();
    },
    // foobar 把曲目记为「已播放」（playback:itemPlayed：播满 60 秒，或播到结尾且
    // 至少播过 1/3 —— 与播放统计同一次判定）→ 给最近的历史行打 ✓。在线直链被刷新
    // 后路径会变（见上 note），路径对不上时按歌名/歌手认。只查 cursor 与其前一条：
    // trackChanged 与 itemPlayed 的到达顺序不保证，再往前就没有意义了。
    markPlayed: function(track) {
      if (!this.items.length || this.cursor < 0) return false;
      var path = CM.trackPath(track);
      var tName = CM.trackName(track) || '';
      var tArtist = CM.trackArtist(track) || '';
      for (var i = this.cursor; i >= 0 && i >= this.cursor - 1; i--) {
        var it = this.items[i];
        if (!it || it.played) continue;
        var same = it.path === path ||
          (!!tName && it.title === tName && (!tArtist || !it.artist || it.artist === tArtist));
        if (same) { it.played = true; this.save(); return true; }
      }
      return false;
    },
    // 回溯：cursor 往前找第一首不同曲目并播放（找不到返回 false → 交回 Context 上一首）
    prev: function() {
      var curPath = CM.trackPath(CM.currentTrack);
      for (var i = this.cursor - 1; i >= 0; i--) {
        if (this.items[i].path !== curPath) return this.jump(i);
      }
      return false;
    },
    // 定位到历史第 i 条并播放（上一首回溯 / 历史行双击共用）
    jump: function(i) {
      var it = this.items[i];
      if (!it) return false;
      this._purgeNav();
      this._navPaths[it.path] = Date.now();
      this._navWant = { title: it.title || '', artist: it.artist || '', at: Date.now() };
      this.cursor = i;
      this.save();
      CM.playNowPath(it.path);
      return true;
    }
  };

  /* 历史列表渲染（插队队列上方的可展开面板）
     ------------------------------------------------------------
     默认收起（`settings.historyOpen`），点标题行展开。展开后的列表**由旧到新向下排**：
     最下面一条紧贴"正在播放"卡片，整条抽屉自上而下就是「过去 → 现在 → 接下来」的时间线。
     行内双击 = 回到那一条（`jump`）。 */
  function fmtClock(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  CM.history.setOpen = function(open, persist) {
    var on = !!open;
    state.historyOpen = on;
    var toggle = CM.els.historyToggle;
    var region = CM.els.historyRegion;
    if (toggle) toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (region) region.classList.toggle('open', on);
    if (persist !== false) { CM.settings.historyOpen = on; CM.saveSettings(); }
    if (on) CM.renderHistory();
  };
  CM.history.toggle = function() { CM.history.setOpen(!state.historyOpen); };
  CM.renderHistory = function() {
    var list = CM.els.historyList;
    if (!list) return;
    var h = CM.history;
    var esc = CM.escHtml;
    var n = h.items.length;
    var countEl = CM.els.historyCount;
    if (countEl) countEl.textContent = n ? n : '';
    var hint = CM.els.historyHint;
    var clearBtn = CM.els.historyClear;
    if (!n) {
      if (hint) hint.textContent = '暂无播放记录';
      if (clearBtn) clearBtn.hidden = true;
      list.innerHTML = '<div class="queue-hist-empty">播放过的曲目会按时间记在这里（连续同一首只记一条）</div>';
      return;
    }
    if (hint) hint.textContent = '共 ' + n + ' 条 · 上限 ' + h.max() + ' 条（由旧到新）';
    if (clearBtn) clearBtn.hidden = false;
    var parts = [];
    for (var i = 0; i < n; i++) {
      var it = h.items[i];
      parts.push(
        '<div class="queue-item queue-hist-item' + (i === h.cursor ? ' hist-cur' : '') + '" data-h="' + i + '" title="双击回到这一条">' +
        '<span class="queue-hist-num">' + (i + 1) + '</span>' +
        '<div class="queue-item-info">' +
        '<div class="queue-item-title">' + esc(it.title || it.path) + '</div>' +
        '<div class="queue-item-artist">' + esc(it.artist || '') + '</div>' +
        '</div>' +
        '<span class="queue-hist-time">' + (it.played ? '<span class="hist-played" title="foobar 已计入播放统计">✓</span>' : '') + fmtClock(it.at) + '</span>' +
        '</div>'
      );
    }
    list.innerHTML = parts.join('');
    // 展开状态下贴住底部：最新一条紧邻"正在播放"，往回滚才看到更早的
    if (state.historyOpen) list.scrollTop = list.scrollHeight;
    CM.runOnce('historyDelegation', function() {
      list.addEventListener('dblclick', function(e) {
        var row = e.target.closest('.queue-hist-item');
        if (!row) return;
        var i = parseInt(row.dataset.h, 10);
        if (!isNaN(i)) CM.history.jump(i);
      });
    });
  };

  // 启动挂 UI：读持久化状态、绑定展开按钮 / 清空按钮（只绑一次）
  CM.history.init = function() {
    CM.history.load();
    state.historyOpen = !!CM.settings.historyOpen;
    CM.runOnce('historyChrome', function() {
      var toggle = CM.els.historyToggle;
      if (toggle) toggle.addEventListener('click', function() { CM.history.toggle(); });
      var clearBtn = CM.els.historyClear;
      if (clearBtn) clearBtn.addEventListener('click', function() {
        CM.history.clear();
        CM.showToast('已清空播放历史');
      });
    });
    CM.history.setOpen(state.historyOpen, false);
  };
})();
