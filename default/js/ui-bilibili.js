/* ============================================================
 * CloudMusic 主题扩展 · B 站在线音源页（ui-bilibili.js）
 * ------------------------------------------------------------
 * 依赖页内桥接模块 js/bilibili-core.js（window.BilibiliBridge）：
 *   搜索 / 视频详情 / 取音频直链都在同一个页面进程里完成，走宿主
 *   foo_ui_webview2 的原生 HTTP 客户端（无 CORS），播放交给 foobar2000 自己的歌单。
 *
 * 与「网易云 / QQ 音乐」页的差异（都是实测结果决定的，别照着改回"统一"）：
 *   · **没有登录这一项**：搜索与取流都只走游客接口，不需要 Cookie 面板。
 *   · **取到的是 MP4（含 AAC 音轨），不是纯音频**：html5 档的 durl[0] 是普通
 *     MP4，宿主按视频容器解析出音轨来播；免 Referer、支持 Range，所以能直接
 *     流播。DASH 音轨虽小但必带 Referer，宿主发不了自定义头，不能用。
 *   · **一个视频 = 一首"歌"**：多 P 视频在搜索结果里拿不到分 P 信息，播放时
 *     统一取第 1 P；想指定分 P 用下面的「链接」框（支持 ?p=N）。
 *   · **直链几小时就过期**（带 e/deadline 签名）：歌单里留着的是旧地址，真正
 *     播放前由 playback-model.js 的 CM.refreshOnlinePath 重新解析一次。
 *   · **能下载**：与另两页共用 online-common 的落盘链路（http.download +
 *     同名 .lrc），只是把一个视频的所有 durl 段拼成一个 .mp4；歌词 B 站没有
 *     接口，交给多源聚合按歌名匹配，匹配不上就不写。
 * ============================================================ */
(function () {
  'use strict';

  var CM = window.CloudMusic;
  if (!CM) return;

  /* 固定歌单名：勾选播放 / 链接播放都只往这一个歌单里追加 */
  var BL_PLAYLIST = 'B站音乐';
  /* B 站 web 搜索接口固定每页 20 条，传别的数字也只回 20 —— 不要当成分页参数用 */
  var PAGE_SIZE = 20;

  var S = {
    items: [],          // 当前这一页的搜索结果（翻页整页替换）
    /* 已勾选的视频：{bvid: 视频对象}。按 bvid 记而不是按下标记 —— 翻页会整页
       换掉列表，用下标立刻就乱了；这样还能跨页攒一批一起播放。 */
    picked: {},
    online: false,      // 页内桥接是否就绪
    kw: '',
    page: 1,
    pages: 0,           // 接口回的总页数（0 = 还不知道）
    total: 0,           // 总结果数（仅用于状态栏）
    busy: false,
    paging: false,
    seq: 0,             // 列表操作序号：旧响应回来对不上就丢弃
    firstShown: false,
    dlDone: 0,          // 本轮下载已完成数
    dlTotal: 0,         // 本轮下载总数（0 = 还没开始）
    dlRun: false,       // 正在下载（只有它为真时再点「下载选中」才算停止）
    dlCancel: false     // 请求停止（当前这个下完就停）
  };

  /* 通用件：样式表、歌单写入、通用小工具都来自 js/online-common.js
     （与「QQ 音乐」「网易云」两页共用同一份实现）。 */
  var K = CM.onlineCommon({
    prefix: 'bl',
    statusId: 'blStatus', cssId: 'blStyle',
    bridge: function () { return window.BilibiliBridge; },
    dirName: 'B站音乐下载',
    state: S,
    onProgress: function () { updateToolbar(); },
    /* B 站没有歌词接口 —— 交给多源聚合（LRCLIB / 网易云 / QQ）按歌名匹配，
       匹配不上就不写 .lrc（宁缺勿错，与歌词链路同一条规矩）。 */
    getLyric: function (it) {
      var L = CM.lyricSources;
      if (!L || typeof L.auto !== 'function') return Promise.resolve({ ok: false, lrc: '' });
      return L.auto({ title: it.title || '', artist: it.artist || '', album: '',
                      duration: it.duration | 0, path: '' })
        .then(function (r) { return { ok: !!(r && r.ok && r.lrc), lrc: (r && r.lrc) || '' }; },
              function () { return { ok: false, lrc: '' }; });
    }
  });
  var $ = K.$, mmss = K.mmss, api = K.api, apiOr = K.apiOr, toast = K.toast, setStatus = K.setStatus,
      ensurePlaylist = K.ensurePlaylist, dedupePlaylists = K.dedupePlaylists, injectCss = K.injectCss,
      safeName = K.safeName, runDownloads = K.runDownloads,
      openDlFolder = K.openDlFolder, copyDlPath = K.copyDlPath;

  var esc = CM.escHtml;

  /* ------------------------------------------------------------
   * 小工具
   * ---------------------------------------------------------- */
  /* 播放量：B 站自己的单位是「万 / 亿」，照搬比一串数字好认 */
  function cntTxt(n) {
    n = Math.max(0, Number(n) || 0);
    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
    return String(n);
  }

  /* ------------------------------------------------------------
   * 状态：桥接自检
   * ---------------------------------------------------------- */
  function reconnect() {
    var B = window.BilibiliBridge;
    if (!B) {
      S.online = false;
      setStatus('内置桥接模块（js/bilibili-core.js）未加载 —— 检查 index.html 里的脚本引用', 'err');
      return Promise.resolve(false);
    }
    S.online = true;
    var info = B.bridgeInfo ? B.bridgeInfo() : {};
    setStatus('桥接就绪 · v' + (info.version || '?') +
              ' · 搜索与取流走宿主 HTTP（无需登录），流播为 html5 档（约 157kbps）');
    return Promise.resolve(true);
  }

  function renderLoading() {
    var l = $('blList');
    if (l) l.innerHTML = CM.emptyHTML('搜索中…');
    renderPager();
  }

  function renderEmpty(msg) {
    var l = $('blList');
    if (l) l.innerHTML = CM.emptyHTML(msg);
    renderPager();
  }

  /* ------------------------------------------------------------
   * 列表
   * ---------------------------------------------------------- */
  function renderList() {
    var html = S.items.map(function (v) {
      var on = !!S.picked[v.bvid];
      var cover = v.pic
        ? '<img src="' + esc(window.BilibiliBridge ? BilibiliBridge.coverUrl(v.pic, 160) : v.pic) + '" alt="" loading="lazy" ' +
          'referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
        : '';
      return '' +
        '<div class="bl-row' + (on ? ' sel' : '') + '" data-bvid="' + esc(v.bvid) + '">' +
          '<label class="bl-check" onclick="event.stopPropagation()">' +
            '<input type="checkbox" data-bvid="' + esc(v.bvid) + '"' + (on ? ' checked' : '') + '>' +
          '</label>' +
          '<div class="bl-cover">' + cover + '</div>' +
          '<div class="bl-meta">' +
            '<div class="bl-name">' + esc(v.title) +
              '<span class="bl-tag bl-tag-sq">视频</span></div>' +
            '<div class="bl-artist">' + esc(v.artist) +
              ' · ' + cntTxt(v.play) + ' 播放</div>' +
          '</div>' +
          '<div class="bl-dur">' + (v.duration ? mmss(v.duration) : '--:--') + '</div>' +
          '<button class="bl-btn bl-btn-sm" data-act="one" data-bvid="' + esc(v.bvid) + '">播放</button>' +
        '</div>';
    }).join('');

    var l = $('blList');
    if (l) l.innerHTML = '<div class="bl-rows">' + html + '</div>';
    renderPager();
    syncAllBox();
    updateToolbar();
  }

  function itemByBvid(bvid) {
    if (!bvid) return null;
    for (var i = 0; i < S.items.length; i++) {
      if (S.items[i].bvid === bvid) return S.items[i];
    }
    return S.picked[bvid] || null;
  }

  /* 勾选表 → 去重后的列表。
     两类来源都要带：当前页里勾中的、以及跨页/换搜索词前勾中的。
     **必须按 bvid 去重**：翻页回来时 S.items 是一批新对象，旧实现拿对象身份
     （S.items.indexOf(picked)）判断"在不在当前页"，换回这一页就会同一条 push 两遍 ——
     表现是「已选」数目翻倍、下载同一个视频两次（多出一个 ` (2).mp4`）。 */
  function pickedList() {
    var seen = {}, out = [];
    function add(v) {
      if (!v || !v.bvid || seen[v.bvid]) return;
      seen[v.bvid] = 1;
      out.push(v);
    }
    S.items.forEach(function (v) { if (S.picked[v.bvid]) add(S.picked[v.bvid]); });
    for (var k in S.picked) {
      if (Object.prototype.hasOwnProperty.call(S.picked, k)) add(S.picked[k]);
    }
    return out;
  }

  function syncAllBox() {
    var cb = $('blAll');
    if (!cb) return;
    cb.checked = S.items.length > 0 && S.items.every(function (v) { return !!S.picked[v.bvid]; });
  }

  function updateToolbar() {
    var n = pickedList().length;
    if ($('blCount')) $('blCount').textContent = '已选 ' + n + ' 个';
    if ($('blPlayBtn')) $('blPlayBtn').disabled = S.busy || S.dlRun || !n;
    if ($('blUrlBtn')) $('blUrlBtn').disabled = S.busy || S.dlRun;
    if ($('blDownloadBtn')) {
      $('blDownloadBtn').disabled = !S.dlRun && (S.busy || !n);
      var txt = $('blDownloadBtn').querySelector('span');
      if (txt) txt.textContent = S.dlRun ? '停止' : '下载选中';
    }
  }

  /* ------------------------------------------------------------
   * 搜索 / 翻页
   * ---------------------------------------------------------- */
  function search() {
    var kw = (($('blInput') || {}).value || '').trim();
    if (!kw) return;
    if (!S.online) { reconnect(); return; }
    S.kw = kw;
    S.page = 1;
    S.pages = 0;
    S.total = 0;
    // 上一次翻页可能还在途：它回来时代际对不上会直接 return，不会清 paging ——
    // 这里必须清掉，否则「上一页 / 下一页」永久置灰（搜索把 S.paging 留在 true）
    S.paging = false;
    var seq = ++S.seq;
    setStatus('正在搜索「' + kw + '」…');
    renderLoading();

    window.BilibiliBridge.search(kw, 1).then(function (d) {
      if (seq !== S.seq) return;
      if (!d || !d.ok) throw new Error((d && d.error) || '搜索失败');
      S.items = d.items || [];
      S.picked = {};
      S.page = d.page || 1;
      S.pages = d.numPages || 0;
      S.total = d.numResults || 0;
      if (!S.items.length) {
        setStatus('「' + kw + '」没有搜到结果');
        renderEmpty('没有搜到结果，换个关键词试试');
      } else {
        setStatus(searchSummary());
        renderList();
      }
      updateToolbar();
    }).catch(function (e) {
      if (seq !== S.seq) return;
      S.items = [];
      S.pages = 0;
      S.total = 0;
      // 刻意不清 S.picked：瞬时失败不该丢掉用户勾好的曲目（仍可下载/播放）；
      // 只有搜索**成功**才整体换勾选（与上面成功分支对称）
      setStatus('搜索失败：' + ((e && e.message) || e), 'err');
      renderEmpty('搜索失败 —— 换关键词重试；连续失败多半是 WBI 签名被风控，刷新页面即可');
      updateToolbar();
    });
  }

  function searchSummary() {
    return '「' + S.kw + '」第 ' + S.page + ' 页 · ' + S.items.length + ' 个视频' +
      (S.total ? '（共约 ' + S.total + ' 个结果）' : '') + ' · 双击行播放';
  }

  function gotoPage(p) {
    p = Math.max(1, p | 0);
    if (!S.online || !S.kw || S.paging) return;
    if (p === S.page && S.items.length) return;
    S.paging = true;
    var seq = ++S.seq;
    setStatus('正在翻到第 ' + p + ' 页…');
    renderPager();
    window.BilibiliBridge.search(S.kw, p).then(function (d) {
      if (seq !== S.seq) return;
      if (!d || !d.ok) throw new Error((d && d.error) || '翻页失败');
      S.items = d.items || [];
      S.page = d.page || p;
      S.pages = d.numPages || 0;
      S.total = d.numResults || S.total;
      S.paging = false;
      if (!S.items.length) {
        setStatus('第 ' + p + ' 页没有内容'); renderEmpty('这一页没有内容，试试上一页');
      } else {
        setStatus(searchSummary());
        renderList();
      }
      updateToolbar();
    }).catch(function (e) {
      if (seq !== S.seq) return;
      S.paging = false;
      setStatus('翻页失败：' + ((e && e.message) || e), 'err');
      renderPager();
    });
  }

  function prevPage() { if (S.page > 1) gotoPage(S.page - 1); }
  function nextPage() { if (!S.pages || S.page < S.pages) gotoPage(S.page + 1); }

  function renderPager() {
    var p = $('blPager');
    if (p) p.className = 'bl-pager' + (S.online && S.kw ? ' on' : '');
    if ($('blPageNo')) $('blPageNo').textContent = String(S.page);
    if ($('blPrevBtn')) $('blPrevBtn').disabled = S.paging || S.page <= 1;
    if ($('blNextBtn')) {
      $('blNextBtn').disabled = S.paging || (!!S.pages && S.page >= S.pages);
    }
    if ($('blPageInput')) $('blPageInput').disabled = S.paging;
    if ($('blGoBtn')) $('blGoBtn').disabled = S.paging;
  }

  /* ------------------------------------------------------------
   * 播放：解析 → 追加到固定歌单 → 从新曲开播
   * ---------------------------------------------------------- */
  function playTracks(tracks) {
    tracks = (tracks || []).filter(Boolean);
    if (!tracks.length) { toast('先勾选几个视频', null, 'error'); return; }
    if (!S.online) { toast('桥接未就绪', '稍等片刻再试，或刷新页面', 'error'); reconnect(); return; }
    // 与「链接播放」互斥：两条链各自"追加前取总数 → playTrack(index)"，
    // 并发时 base 会互踩，index 可能落到别的视频上（正是用户报的"点这首播那首"）
    if (S.busy) { toast('正在处理上一批', '稍等一下再点', 'error'); return; }
    S.busy = true;
    updateToolbar();

    var used = 0;
    setStatus('正在解析 ' + tracks.length + ' 个视频的音源…');

    window.BilibiliBridge.resolveMany(tracks).then(function (r) {
      if (r && r.failed && r.failed.length) {
        toast('跳过 ' + r.failed.length + ' 个', r.failed.slice(0, 3).join('；'), 'error');
      }
      if (!r || !r.urls || !r.urls.length) throw new Error('这批视频都没有可用的音源');
      used = r.urls.length;
      setStatus('解析完成（' + used + ' 个），正在写入歌单…');
      return ensurePlaylist(BL_PLAYLIST).then(function (idx) {
        if (idx == null || idx < 0) throw new Error('无法创建播放列表');
        // 追加而不是整单替换：之前播的歌原地保留。
        // 总数取不到就报错，不能拿 0 当索引（那会从歌单第一首开始播）
        return apiOr('playlist.getTracks', { playlist: idx, start: 0, count: 1 }).then(function (cnt) {
          if (cnt.total == null) throw new Error('取不到歌单曲目数，无法定位新曲');
          var base = cnt.total;
          // addPathsSequential：addPaths 由宿主按"添加文件"解析，行不保序
          return apiOr('playlist.addPathsSequential', { playlist: idx, paths: r.urls }).then(function () {
            // apiOr 已把失败信封转成 reject，这里不需要再判 success
            return apiOr('playlist.playTrack', { playlist: idx, index: base });
          });
        });
      });
    }).then(function () {
      setStatus('已追加到 ' + BL_PLAYLIST + ' 并开播（' + used + ' 个视频）', 'ok');
      toast('开始播放', BL_PLAYLIST + ' · 追加 ' + used + ' 个视频', 'success');
      dedupePlaylists(BL_PLAYLIST);
    }).catch(function (e) {
      setStatus('播放失败：' + ((e && e.message) || e), 'err');
      toast('播放失败', String((e && e.message) || e), 'error');
    }).then(function () {
      S.busy = false;
      updateToolbar();
    });
  }

  /* ------------------------------------------------------------
   * 下载：解析整段 durl → http.download 落盘（+ 同名 .lrc）
   * ------------------------------------------------------------
   * 与另外两个平台同一套：保存到 <配置目录>\B站音乐下载\，进度进状态栏，
   * 下载中再点一次 = 停止（当前这个下完就停，不会留半个文件）。
   * 差异只在「一个视频可能有多段」和扩展名（.mp4，见 bilibili-core.js 文件头）。
   * ---------------------------------------------------------- */
  function buildPlan(items) {
    var used = {};
    return (items || []).map(function (it) {
      // 「UP 主 - 歌名」与另两页的「歌手 - 歌名」同一口径；多 UP 主用 & 连
      var artist = String(it.artist || '').replace(/\s*\/\s*/g, ' & ');
      var base = safeName((artist ? artist + ' - ' : '') + (it.title || 'track'));
      var n = used[base] || 0;
      used[base] = n + 1;
      var finalBase = n ? base + ' (' + (n + 1) + ')' : base;
      return {
        parts: it.urls,
        name: finalBase + '.mp4',
        lrcName: finalBase + '.lrc',
        title: it.title || '',
        artist: it.artist || '',
        duration: it.duration | 0
      };
    });
  }

  function downloadTracks(tracks) {
    if (S.dlRun) { S.dlCancel = true; setStatus('正在停止 —— 当前这个下完就停', 'warn'); return; }
    if (S.busy) { toast('正在处理上一批', '稍等一下再点', 'error'); return; }
    if (!tracks.length) { toast('先勾选几个视频', null, 'error'); return; }
    if (!S.online) { toast('桥接未就绪', '稍等片刻再试，或刷新页面', 'error'); reconnect(); return; }

    S.busy = true;
    S.dlRun = true;
    S.dlCancel = false;
    S.dlDone = 0;
    S.dlTotal = 0;
    updateToolbar();
    setStatus('正在解析 ' + tracks.length + ' 个视频的音源…');

    window.BilibiliBridge.resolveForDownload(tracks).then(function (r) {
      if (r && r.failed && r.failed.length) {
        toast('跳过 ' + r.failed.length + ' 个', r.failed.slice(0, 3).join('；'), 'error');
      }
      if (!r || !r.items || !r.items.length) throw new Error('这批视频都没有可下载的音源');
      return runDownloads(buildPlan(r.items));
    }).catch(function (e) {
      setStatus('下载失败：' + (e && e.message || e), 'err');
      toast('下载失败', String((e && e.message) || e), 'error');
    }).then(function () {
      S.busy = false;
      S.dlRun = false;
      S.dlTotal = 0;
      updateToolbar();
    });
  }

  /* 链接 / BV 号 / av 号 → 单个视频。多 P 视频按 ?p=N 选分 P，没写就播第 1 P */
  function playLink() {
    var raw = (($('blUrlInput') || {}).value || '').trim();
    if (!raw) { toast('先粘贴链接、BV 号或 av 号', null, 'error'); return; }
    if (!S.online) { toast('桥接未就绪', '稍等片刻再试，或刷新页面', 'error'); reconnect(); return; }
    var p = window.BilibiliBridge.parseInput(raw);
    if (!p || (!p.bvid && !p.aid)) {
      toast('认不出这个链接', '支持视频页链接（含 ?p=N 分 P）、BV 号或 av 号', 'error');
      return;
    }
    if (S.busy) { toast('正在处理上一批', '稍等一下再点', 'error'); return; }
    S.busy = true;
    updateToolbar();
    setStatus('正在读取视频信息（' + (p.bvid || ('av' + p.aid)) + '）…');

    // bvid / av 号都走同一个 wbi/view（aid 参数实测可用）
    window.BilibiliBridge.videoDetail(p.bvid ? p.bvid : { aid: p.aid }).then(function (d) {
      var pages = (d && d.pages) || [];
      var at = p.page > 0 ? (p.page - 1) : 0;
      var part = pages[at];
      if (!part) {
        throw new Error(p.page > 0 ? ('第 ' + p.page + ' P 不存在（这个视频共 ' + pages.length + ' P）')
                                   : '这个视频没有可用的分 P');
      }
      var title = d.title || p.bvid || ('av' + p.aid);
      if (pages.length > 1) {
        title += ' · P' + (at + 1) + (part.part ? ' ' + part.part : '');
      }
      var track = {
        bvid: d.bvid || p.bvid || '', cid: part.cid, aid: d.aid || p.aid || 0,
        title: title, artist: d.artist || '', pic: d.pic || ''
      };
      S.busy = false;
      updateToolbar();
      playTracks([track]);
    }).catch(function (e) {
      S.busy = false;
      updateToolbar();
      setStatus('读取视频失败：' + ((e && e.message) || e), 'err');
      toast('读取视频失败', String((e && e.message) || e), 'error');
    });
  }

  /* ------------------------------------------------------------
   * 事件绑定
   * ---------------------------------------------------------- */
  function bind() {
    if ($('blInput')) {
      $('blInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') search();
      });
    }
    if ($('blSearchBtn')) $('blSearchBtn').addEventListener('click', search);
    if ($('blUrlInput')) {
      $('blUrlInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') playLink();
      });
    }
    if ($('blUrlBtn')) $('blUrlBtn').addEventListener('click', playLink);
    if ($('blAll')) {
      $('blAll').addEventListener('change', function (e) {
        if (e.target.checked) S.items.forEach(function (v) { if (v.bvid) S.picked[v.bvid] = v; });
        else S.items.forEach(function (v) { if (v.bvid) delete S.picked[v.bvid]; });
        renderList();
        updateToolbar();
      });
    }
    if ($('blPlayBtn')) {
      $('blPlayBtn').addEventListener('click', function () { playTracks(pickedList()); });
    }
    if ($('blDownloadBtn')) {
      $('blDownloadBtn').addEventListener('click', function () { downloadTracks(pickedList()); });
    }
    if ($('blDlOpen')) $('blDlOpen').addEventListener('click', openDlFolder);
    if ($('blDlCopy')) $('blDlCopy').addEventListener('click', copyDlPath);

    var list = $('blList');
    if (list) {
      list.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || t.type !== 'checkbox') return;
        var bvid = t.getAttribute('data-bvid');
        var v = itemByBvid(bvid);
        if (!v) return;
        if (t.checked) S.picked[bvid] = v; else delete S.picked[bvid];
        var row = t.closest ? t.closest('.bl-row') : null;
        if (row) row.className = 'bl-row' + (t.checked ? ' sel' : '');
        syncAllBox();
        updateToolbar();
      });
      list.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var one = t.closest('[data-act="one"]');
        if (one) {
          var v = itemByBvid(one.getAttribute('data-bvid'));
          if (v) playTracks([v]);
          return;
        }
        /* 点整行也能勾选；复选框所在的 label 自己会翻转，别重复处理 */
        var row = t.closest('.bl-row');
        if (row && !t.closest('label')) {
          var cb = row.querySelector('input[type=checkbox]');
          if (cb) {
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
      list.addEventListener('dblclick', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        // 行内「播放」按钮要排除：单击已经播了，不排除的话第二次会被 busy 守卫拦下
        if (t.closest('[data-act="one"]')) return;
        var row = t.closest('.bl-row');
        if (!row) return;
        var v = itemByBvid(row.getAttribute('data-bvid'));
        if (v) playTracks([v]);
      });
    }

    if ($('blPrevBtn')) $('blPrevBtn').addEventListener('click', prevPage);
    if ($('blNextBtn')) $('blNextBtn').addEventListener('click', nextPage);
    if ($('blGoBtn')) {
      $('blGoBtn').addEventListener('click', function () {
        var v = parseInt(($('blPageInput') || {}).value, 10);
        if (v > 0) gotoPage(v);
      });
    }
    if ($('blPageInput')) {
      $('blPageInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var v = parseInt(this.value, 10);
          if (v > 0) gotoPage(v);
        }
      });
      $('blPageInput').addEventListener('input', function () {
        this.value = this.value.replace(/[^0-9]/g, '');
      });
    }
  }

  /* ------------------------------------------------------------
   * 启动：首次进入该页时才做连接检查
   * ---------------------------------------------------------- */
  function onShow() {
    injectCss();          // 首次进入才注入样式：没打开过这一页就白算一遍 CSS
    if (S.firstShown) { renderPager(); return; }
    S.firstShown = true;
    reconnect();
    renderPager();
  }

  // 钩住 switchTab：切到 bilibili 时初始化（不改主题原有代码）
  if (typeof CM.switchTab === 'function') {
    var _switchTab = CM.switchTab;
    CM.switchTab = function (tab) {
      _switchTab.apply(CM, arguments);
      if (tab === 'bilibili') onShow();
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  // 调试入口（DevTools 里可直接调；window.BilibiliBridge 上还有 bridgeInfo() 等）
  CM.bilibili = {
    state: S, reconnect: reconnect, search: search, gotoPage: gotoPage,
    prevPage: prevPage, nextPage: nextPage, playTracks: playTracks, playLink: playLink,
    downloadTracks: downloadTracks, buildPlan: buildPlan,
    PAGE_SIZE: PAGE_SIZE
  };
})();
