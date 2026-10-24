/* ============================================
 * CloudMusic lyrics-resolver.js v2 — 歌词「实时匹配」
 *
 * 为什么改版（2026-09-15）：
 *   1) 要的是播放时【实时匹配】，不是预先下载 .lrc 再读文件；
 *   2) 整轨 FLAC + CUE 的专辑不要被"展开成分轨"来处理。
 *   这两点其实是一体的：整轨 + cue 里每首歌的标题/歌手，只有播放时才由宿主解析出来
 *   （播放项是 xxx.cue|subsong:N）。预先展开成文件既笨重又会留下一堆假分轨，
 *   把匹配挪到播放时，就没有这个矛盾了。
 *
 * 2026-09-29：联网匹配改为调用**页内桥接** QQBridge.lyric()（js/qqmusic-core.js），
 *   QQ 音乐的搜索 + 取词全部走宿主原生 HTTP 客户端（无 CORS），随主题页加载，
 *   无本地进程 —— 随 foobar 启动而在、关闭而消。
 *
 * 数据流（本地优先）：
 *   CM.loadLyrics()
 *     -> 本地「音频同名 .lrc」/「%profile%\lyrics 歌词库」命中？直接渲染
 *        （用户自己的歌词 —— 多半用 tools/lrc-normalizer.html 精修过双语配对与
 *          时间轴，优先级最高；读文件也更快、离线可用）
 *     -> 本地没有 -> 内存缓存 -> QQBridge.lyric(title, artist, duration)
 *          （多轮放宽搜索 + 打分 + 取词，见 qqmusic-core.js）
 *     -> 匹配失败 / 模块未加载 -> 「暂无歌词」
 *
 * 本地只认「音频同名 .lrc」与「%profile%\lyrics\」歌词库，**不再**按
 * 「专辑目录\艺术家 - 标题.lrc」去找 —— 那正是"整轨被判成多首分轨"留下的痕迹。
 * （整轨 CUE 的分轨本来就没有同名文件，这类会自然落到联网匹配。）
 *
 * 加载位置：index.html 里紧接 ui-lyrics.js（本模块接管 CM.loadLyrics）。
 *          依赖 js/qqmusic-core.js（须先于本文件加载）。
 * ============================================ */

(function () {
  'use strict';

  var CM = window.CloudMusic;
  if (!CM || typeof CM.api !== 'function' || !CM.els) return;

  var BS = String.fromCharCode(92);          // 反斜杠，避免踩转义
  var PLACEHOLDER_ARTIST = '未知艺术家';
  var PLACEHOLDER_TITLE = '未知曲目';

  /* ============================================
   * 小工具
   * ============================================ */
  function dirOf(p) {
    var i = String(p).lastIndexOf(BS);
    return i > 0 ? String(p).slice(0, i) : '';
  }
  function baseOf(p) {
    var i = String(p).lastIndexOf(BS);
    return i >= 0 ? String(p).slice(i + 1) : String(p);
  }
  function stripExt(s) { return String(s).replace(/\.\w+$/, ''); }
  function safe(s) {
    return String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  }
  function uniq(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      if (!arr[i] || seen[arr[i]]) continue;
      seen[arr[i]] = 1;
      out.push(arr[i]);
    }
    return out;
  }

  /* ============================================
   * 本会话内存缓存：同一首歌来回切不重复联网
   * （服务端也有 30 分钟缓存，这里省掉的是一次网络往返）
   * ============================================ */
  var memo = {}, memoN = 0, MEMO_MAX = 200;
  function memoKey(title, artist, dur) {
    return (title + '\u0001' + artist + '\u0001' + (dur | 0));
  }
  // 曲目 → 缓存键。**一处算法两处用**：lyricReload 要删的键必须与 loadLyrics 存的
  // 键逐字节相同 —— 占位符（'未知艺术家' / '未在播放'）与 duration 兜底链
  // （track.duration → track.length → state.duration）都要按同一口径处理，
  // 否则无艺人标签的曲目上「刷新歌词」删不掉缓存、看起来毫无作用
  function memoKeyFor(track) {
    if (!track) return '';
    var title = CM.trackName ? CM.trackName(track) : (track.title || '');
    if (!title || title === PLACEHOLDER_TITLE) return '';
    var artist = CM.trackArtist ? CM.trackArtist(track) : (track.artist || '');
    var artistOk = !!artist && artist !== PLACEHOLDER_ARTIST;
    var duration = track.duration || track.length || CM.state.duration || 0;
    return memoKey(title, artistOk ? artist : '', duration);
  }
  function memoPut(k, v) {
    if (!k) return;
    if (!(k in memo) && memoN >= MEMO_MAX) {
      // 淘汰一半：条数直接由 Object.keys 现算，不再单独维护计数
      // （计数与实际条目一旦不同步，上限就形同虚设）
      var keys = Object.keys(memo);
      for (var i = 0; i < (keys.length >> 1); i++) delete memo[keys[i]];
      memoN = Object.keys(memo).length;
    }
    if (!(k in memo)) memoN++;
    memo[k] = v;
  }
  function memoDel(k) {
    if (k && (k in memo)) { delete memo[k]; memoN = Math.max(0, memoN - 1); }
  }

  /* ============================================
   * profile 路径（core.js 里共享，取一次就缓存）
   * _prof 是本模块的同步镜像：localCandidates 是同步的，等不起 promise
   * ============================================ */
  var _prof = '';
  function profilePath() {
    if (_prof) return Promise.resolve(_prof);
    return CM.profilePath().then(function (p) { _prof = p || ''; return _prof; });
  }

  /* ============================================
   * 本地兜底候选（只认同名 / 歌词库，不认"分轨式"命名）
   * ============================================ */
  function localCandidates(path, artist, title) {
    var list = [];
    if (path && !CM.isUrlPath(path)) {
      // CUE 子曲路径形如 xxx.cue|subsong:N：先剥掉子曲后缀再取同名候选，
      // 否则 stem 会带着后缀拼出永不存在的 "xxx.cue|subsong:N.lrc"，
      // 用户放在 cue 旁边的同名 .lrc 永远匹配不上
      var pFile = String(path).split('|')[0];
      var dir = dirOf(pFile), base = baseOf(pFile), stem = stripExt(base);
      if (dir && stem) {
        list.push(dir + BS + stem + '.lrc');                   // 音频同名，宿主原生规则
        if (/\.cue$/i.test(base)) list.push(dir + BS + base + '.lrc');   // xxx.cue.lrc 变体
      }
    }
    var prof = _prof || '';
    if (prof) {
      var dirs = [prof + BS + 'lyrics', prof + BS + 'eslyric-data' + BS + 'lyrics'];
      for (var d = 0; d < dirs.length; d++) {
        if (artist && title) list.push(dirs[d] + BS + safe(artist) + ' - ' + safe(title) + '.lrc');
        if (title) list.push(dirs[d] + BS + safe(title) + '.lrc');
      }
    }
    return uniq(list);
  }

  function readLrcFile(p) {
    // 期望中的未命中（没放同名 .lrc / 歌词库里没有这首）不该刷控制台：直接走
    // fb.invoke，失败 = 没有这个文件（CM.api 会把每次未命中都 console.warn，
    // 每首歌切换最多 6 条 NOT_FOUND）。路径与顺序与旧版逐个试探完全一致。
    return fb.invoke('file.read', { path: p, encoding: 'binary' }).then(function (fr) {
      return (fr && fr.success !== false && fr.content &&
              String(fr.content).replace(/\s/g, '').length > 0) ? fr : null;
    }, function () { return null; });
  }

  function readFirst(cands, loadId, onHit, onMiss) {
    var i = 0;
    function step() {
      if (loadId !== CM._lyricLoadId) return;
      if (i >= cands.length) { onMiss(); return; }
      var p = cands[i++];
      readLrcFile(p).then(function (fr) {
        if (loadId !== CM._lyricLoadId) return;
        if (fr) {
          var text = CM.decodeTextBytes(fr.content);
          if (text && text.trim()) { onHit(p, text); return; }
        }
        step();
      });
    }
    step();
  }

  /* ============================================
   * 实时匹配（多源聚合，见 js/lyrics-sources.js）
   * ============================================ */
  /* 在线曲目按「这条直链属于哪个平台」精确取词：网易云直链不带歌曲 id，但播放时
     记下的映射能把直链反查回 id，有映射就按 id 取词（比"标题 + 歌手"模糊匹配准得多）。
     返回 null 表示没有可精确取词的平台 —— 交给多源聚合。 */
  function fetchPlatformExact(title, artist, duration) {
    var path = CM.trackPath ? CM.trackPath(CM.currentTrack) : '';
    if (window.NeteaseBridge && typeof NeteaseBridge.isNeteaseUrl === 'function' &&
        path && NeteaseBridge.isNeteaseUrl(path)) {
      return NeteaseBridge.lyricForTrack(path, title, artist, duration);
    }
    return null;
  }

  /* ============================================
   * 诊断信息（DevTools 里 CM.lyricStatus() 看最近一次匹配）
   * ============================================ */
  var lastStatus = { title: '', artist: '', state: 'idle', from: '', note: '' };

  /* ============================================
   * 接管 CM.loadLyrics
   * ============================================ */
  CM.loadLyrics = function () {
    CM.currentLyrics = [];
    CM.activeLyricIndex = -1;
    // 换歌先清"原文 + 来源"并同步给小窗：在线匹配可能耗时数秒，这段窗口里右键
    // 「保存到文件 / 嵌入标签」会把**上一首**的原文写进新曲目的 .lrc / 标签
    CM.currentLyricsRaw = '';
    CM.lyricSourcePath = '';
    if (CM.publishLyrics) CM.publishLyrics();
    if (!CM.currentTrack) { CM.renderLyricsEmpty('暂无播放曲目'); return; }

    var track = CM.currentTrack;
    var path = CM.trackPath ? CM.trackPath(track) : (track.path || '');
    var title = CM.trackName ? CM.trackName(track) : (track.title || '');
    var artist = CM.trackArtist ? CM.trackArtist(track) : (track.artist || '');
    // ui.updateTrackInfo 已把 duration 写进 state，这里 track 字段优先
    var duration = track.duration || track.length || CM.state.duration || 0;
    var loadId = ++CM._lyricLoadId;

    var titleOk = !!title && title !== PLACEHOLDER_TITLE;
    var artistOk = !!artist && artist !== PLACEHOLDER_ARTIST;
    // 与 lyricReload 共用同一个键算法（见 memoKeyFor）：两处算法不一致时
    // 「刷新歌词」删不掉内存缓存，看起来毫无作用
    var mKey = titleOk ? memoKey(title, artistOk ? artist : '', duration) : '';

    function render(srcTag, text, from) {
      if (loadId !== CM._lyricLoadId) return;
      lastStatus = { title: title, artist: artist, state: 'hit', from: from, note: '' };
      // srcTag 传 ''：让 _renderLyrics 回落到「音频路径」做配对模式的记忆键。
      // 不能用 'memo://'/'online://' 这类虚拟路径 —— 同一份歌词经网络命中和内存缓存
      // 命中会拿到不同的键，用户手动指定的对齐方式会在缓存命中时悄悄失效；
      // 且右键「打开所在文件夹」会拿着假路径去 showInExplorer，静默无操作。
      CM._renderLyrics({ available: true, source: from, sourcePath: srcTag }, text);
    }

    /* 失败原因分级（改进指南 §3.6）：不再笼统「暂无歌词」，四种态各说各话，
       并且都给一个可点的出口（搜索歌词 / 重试）。 */
    function gradeEmpty(kind, detail) {
      if (loadId !== CM._lyricLoadId) return;
      var map = {
        'meta-missing': { state: 'meta-missing', text: '无法识别曲目信息' },
        'miss': { state: 'miss', text: '暂无歌词' },
        'match-error': { state: 'match-error', text: '在线取词失败，可重试' }
      };
      var m = map[kind] || map['miss'];
      lastStatus = { title: title, artist: artist, state: m.state, from: '', note: detail || '' };
      CM.renderLyricsEmpty(m.text, false, kind === 'match-error' ? 'retry' : 'search');
    }

    /* 宿主原生歌词（v2 的 lyrics.get）：补上本地同名候选漏掉的两类 ——
       ① 歌词写在标签里（LYRICS / UNSYNCEDLYRICS / SYNCEDLYRICS 等内嵌歌词）；
       ② 宿主自己认识的旁挂文件名变体。
       取回来的文本照样走主题的编码检测 / LRC 解析 / 双语归组（render 只负责渲染）。
       v2 顺带修掉了「LYRICIST 标签被当成歌词读取」，这里不会拿到作词人标签。 */
    function tryHost() {
      if (!path || CM.isUrlPath(path)) { tryOnline(); return; }
      CM.api('lyrics.get', { path: path }).then(function (r) {
        if (loadId !== CM._lyricLoadId) return;
        if (r && r.success !== false && r.available && r.lyrics &&
            String(r.lyrics).replace(/\s/g, '').length > 0) {
          lastStatus = { title: title, artist: artist, state: 'hit',
                         from: 'host-' + (r.source || 'any'), note: '' };
          // 内嵌歌词没有文件路径：srcTag 传 '' 让对齐方式仍按音频路径记忆
          render(r.source === 'file' ? (r.sourcePath || '') : '', String(r.lyrics), 'host');
          return;
        }
        tryOnline();
      }, function () {
        // 换歌后旧一轮的失败续体不能再发起整轮联网（会白打三个源）
        if (loadId !== CM._lyricLoadId) return;
        tryOnline();
      });
    }

    /* 联网匹配：手动选择（按文件记忆）→ 平台精确取词 → 多源聚合。
       内存缓存只服务"多源聚合"这条路 —— 本地文件每次现读，改了立刻生效。 */
    function tryOnline() {
      if (!titleOk) { gradeEmpty('meta-missing'); return; }
      var pickKey = path || (CM.currentTrack && CM.trackPath ? CM.trackPath(CM.currentTrack) : '');
      var pin = (CM.lyricSources && CM.lyricSources.pick) ? CM.lyricSources.pick(pickKey) : null;
      if (pin) { tryPinned(pin); return; }
      if (mKey && memo[mKey]) { render('', memo[mKey], 'memo'); return; }
      autoMatch();
    }

    /* 用户在候选面板里手动选过这首歌的歌词 → 优先用它（按文件记忆，重启后仍生效）。
       取不到时静默回落到自动匹配，不把用户卡在"选过就再也搜不了"的死角里。 */
    function tryPinned(pin) {
      if (!CM.lyricSources) { autoMatch(); return; }
      CM.lyricSources.fetch(pin).then(function (text) {
        if (loadId !== CM._lyricLoadId) return;
        if (text) {
          lastStatus = { title: title, artist: artist, state: 'hit', from: 'picked', note: pin.src };
          render('', text, 'picked');
          return;
        }
        autoMatch();
      }, function () {
        if (loadId !== CM._lyricLoadId) return;
        autoMatch();
      });
    }

    function autoMatch() {
      var exact = fetchPlatformExact(title, artistOk ? artist : '', duration);
      if (exact) {
        exact.then(function (r) {
          if (loadId !== CM._lyricLoadId) return;
          if (r && r.ok && r.lrc) { memoPut(mKey, r.lrc); render('', r.lrc, 'online'); return; }
          multiSource();
        }, function () {
          if (loadId !== CM._lyricLoadId) return;
          multiSource();
        });
        return;
      }
      multiSource();
    }

    function multiSource() {
      if (!CM.lyricSources) { gradeEmpty('match-error', '歌词源模块未加载'); return; }
      CM.lyricSources.auto({
        title: title, artist: artistOk ? artist : '',
        album: track.album || '', duration: duration, path: path
      }).then(function (r) {
        if (loadId !== CM._lyricLoadId) return;
        if (r && r.ok && r.lrc) { memoPut(mKey, r.lrc); render('', r.lrc, 'online'); return; }
        // 分级：至少一个源正常应答 = "在线确实没有"；全部源都失败 = "取词失败可重试"
        if (r && r.anyOk) gradeEmpty('miss', (r && r.note) || '');
        else gradeEmpty('match-error', (r && r.errors && r.errors[0] && r.errors[0].message) || '');
      }, function (e) {
        if (loadId !== CM._lyricLoadId) return;
        gradeEmpty('match-error', (e && e.message) || '');
      });
    }

    CM.els.lyricsScroll.innerHTML = CM.loadingHTML('歌词匹配中...');

    /* 本地优先：
       同名 .lrc / 歌词库是「用户自己的」歌词 —— 多半用 tools/lrc-normalizer.html
       精修过双语配对与时间轴，也可能整轨 CUE 就是照它对齐的；联网结果再"全"也不该
       把它盖掉（旧版是联网优先，本地只在离线时兜底，等于让精修白做）。
       本地的读文件也更快、不依赖桥接服务；本地确实没有时再联网匹配。 */
    profilePath().then(function () {
      if (loadId !== CM._lyricLoadId) return;
      var cands = localCandidates(path, artistOk ? artist : '', titleOk ? title : '');
      readFirst(cands, loadId, function (p, text) {
        render(p, text, 'file');
      }, function () {
        if (loadId !== CM._lyricLoadId) return;
        lastStatus = { title: title, artist: artist, state: 'local-miss', from: '', note: '' };
        tryHost();   // 本地同名/歌词库没有 → 先问宿主（内嵌歌词 + 宿主认识的旁挂文件名）→ 再联网
      });
    });
  };

  /* ============================================
   * 调试 / 手动刷新
   * ============================================ */
  CM.lyricCandidates = function () {
    return localCandidates(
      CM.trackPath ? CM.trackPath(CM.currentTrack) : '',
      CM.trackArtist ? CM.trackArtist(CM.currentTrack) : '',
      CM.trackName ? CM.trackName(CM.currentTrack) : '');
  };

  CM.lyricStatus = function () { return lastStatus; };

  // 强制重新匹配当前曲目（跳过内存缓存与在线匹配缓存）
  CM.lyricReload = function () {
    var t = CM.currentTrack;
    if (!t) return;
    memoDel(memoKeyFor(t));
    // 本地的 .lrc 也要重读：解析结果的缓存键是"路径+模式+长度+头部 64 字"，
    // 就地改错别字 / 改行内时间戳不会改变键，不清就只能刷出旧解析
    if (CM.clearLRCCache) CM.clearLRCCache();
    // 在线匹配的命中/未命中同样要作废：只清本模块的 memo，
    // 上一次的「暂无歌词」会被 QQBridge 自己的 30 分钟缓存又送回同一个结果
    if (window.QQBridge && QQBridge.lyricCacheClear) QQBridge.lyricCacheClear();
    if (window.NeteaseBridge && NeteaseBridge.lyricCacheClear) NeteaseBridge.lyricCacheClear();
    CM.loadLyrics();
  };
})();
