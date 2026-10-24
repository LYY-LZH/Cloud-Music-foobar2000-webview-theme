/* ============================================================
 * CloudMusic 主题扩展 · QQ 音乐页内桥接（qqmusic-core.js）
 * ------------------------------------------------------------
 * QQ 音乐在线音源：功能创意与原版外部桥接程序来自贴吧大佬 @凌月冰天。
 * 本版把整条链路搬进主题页面，作为**页内模块**随主题加载：
 *
 *   · 没有本地进程 / 端口 / 开关脚本，随 foobar 启动而在、关闭而消；
 *   · 上游 HTTP 全部走宿主 foo_ui_webview2 的原生客户端
 *     （fb.invoke('http.get'/'http.post')，无 CORS、无跨域限制，
 *      WebView2 页面自己 fetch 是会被 CORS 拦的，所以必须走宿主）；
 *   · 一律 **async:true + http:response 事件**：async:false 会让宿主在
 *     自己的 UI 线程上把整条请求做完才返回，请求多慢 foobar 就冻多久
 *     （连不上的 CDN 是 21 秒 TCP 超时）；超时用 http.abort 真取消。
 *     详见下方 hostHttp 的注释。
 *   · Cookie / 音质 / guid 存 localStorage，随 WebView2 配置持久化。
 *
 * 上游接口（全部实测可用，2026-09-29，无签名要求）：
 *   聚合搜索  POST https://u.y.qq.com/cgi-bin/musicu.fcg
 *             req_0 = music.search.SearchCgiService / DoSearchForQQMusicDesktop
 *             注意 key 是 req_0、**不带 comm** —— 带 comm 会被风控成空结果。
 *             匿名会被限流成空列表，所以要有兜底：
 *   旧版搜索  GET  https://c.y.qq.com/soso/fcgi-bin/client_search_cp
 *   联想搜索  GET  https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg
 *             （无 Cookie 时唯一稳定通道；无时长无 mediaMid，可补查）
 *   单曲详情  GET  https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg
 *             （补查 file.media_mid —— 直链文件名必须用它，songmid 会 404）
 *   播放直链  POST musicu.fcg  req_0 = vkey.GetVkeyServer / CgiGetVkey
 *             comm = {uin, format:'json', ct:'24', cv:0}
 *             param.filename = 档位前缀 + mediaMid + 扩展名，与 songmid
 *             一一配对（重复填同一个 songmid），一次拿回整条降级链的 purl。
 *             档位前缀：AI00=臻品母带 RS01=Hi-Res F000=FLAC C600=AAC192
 *                       M800=320K C400=AAC96 M500=128K
 *             purl 拼上 sip 主机名即为可播 URL；实测 CDN 无需任何请求头，
 *             foobar2000 / http.download 可直接播放与下载（免费曲库验证，
 *             会员音质需要有效 Cookie —— 解析不到时自动沿降级链下探）。
 *   歌词      GET  https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg
 *             nobase64=1 直接给明文；trans 字段是译文 LRC，追加在原文之后
 *             （主题的「同刻归组」会把两组按时间戳配对成 主/副 行）。
 *   封面      https://y.gtimg.cn/music/photo_new/T002R500x500M000<albummid>.jpg
 *             直链 <img> 引用，不需要代理。
 *
 * 导出（window.QQBridge）：
 *   config() / setQuality() / getQuality() / getCookie() / setCookie() / clearCookie()
 *   search(kw, page, n)          -> {ok, songs[], more, error}
 *                                   songs: {songmid, mediaMid, songid, title,
 *                                   subtitle, artist, album, albummid,
 *                                   interval, vip, avail[]}
 *   resolveMany(tracks, quality) -> {ok, urls[], resolves[], skipped[],
 *                                   usedLabel, error}
 *   resolveStream(songmid, quality[, mediaMid]) -> 单首直链（诊断用）
 *   lyric(title, artist, dur)    -> {ok, lrc, songmid, title, singer,
 *                                   score, note, cached}
 *   coverUrl(albummid)           -> 图片直链
 *   coverDataUrl(mediaMid)       -> 封面（异步经宿主下载成 dataURL，带会话缓存；
 *                                   下载失败退回 CDN 原始 URL，取不到映射退回 ''）
 *   coverCacheClear()            -> 清封面缓存
 *   mediaMidFromUrl(url) / mediaCover(mediaMid) / rememberMediaCovers(tracks)
 *                                -> CDN 直链 ↔ 专辑封面的反查映射
 *                                （在线播放的封面兜底，见 artwork-resolver.js）
 *   lyricCacheClear()            -> 清空歌词匹配缓存
 *   bridgeInfo()                 -> 诊断信息（DevTools: QQBridge.bridgeInfo()）
 *
 * 歌词匹配算法（多轮放宽搜索 × 逐候选打分）：
 *   多轮放宽搜索（原文 → 清轨号 → 拆「歌手 - 标题」→ 去括号 → 只按标题）
 *   × 逐候选打分（标题重合度×1.0 + 歌手×0.6 + 时长吻合加分 − 伴奏惩罚），
 *   达到 min_score(0.8) 即取，繁体标题经内置繁→简表归一化后参与打分。
 * ============================================================ */

(function () {
  'use strict';

  var VERSION = '1.0.0';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  /* ------------------------------------------------------------
   * 宿主 HTTP（无 CORS）
   * ------------------------------------------------------------
   * 必须用 async:true + http:response 事件，**不能**用 async:false：
   * 实测 async:false 时宿主是在自己的 UI 线程上把整条请求做完才返回
   * （请求有多慢，foobar 主窗口就假死多久 —— 连不上的 CDN 走 TCP 超时
   * 是 21 秒，整窗冻结 21 秒；页面侧 setTimeout 也救不了，因为冻结的是
   * 宿主线程，后续请求还会在宿主侧排队）。async:true 由宿主网络线程完成，
   * 页面线程全程可响应，超时用 http.abort 真正取消请求。
   *
   * 注意两点：
   *   · responseType:'binary' 必须给 —— 音频/图片字节如果按 UTF-8 文本
   *     序列化，宿主会直接报 invalid UTF-8；异步模式下连 http:response
   *     事件都不会发出（请求凭空消失）。
   *   · 监听器在模块加载时就挂上并按 requestId 缓存回包，而不是每个请求
   *     各自 invoke 完再挂 —— 回包可能比监听器先到，那样会永久等不到。
   * ---------------------------------------------------------- */
  var _inflight = {};              // requestId -> { resolve, reject, timer }
  var _httpListening = false;

  function httpListen() {
    if (_httpListening) return;
    if (typeof fb.on !== 'function') return;
    _httpListening = true;
    fb.on('http:response', function (e) {
      if (!e || !e.requestId) return;
      var w = _inflight[e.requestId];
      if (!w) return;
      delete _inflight[e.requestId];
      clearTimeout(w.timer);
      if (e.success === false) w.reject(new Error(e.error || ('HTTP ' + (e.status || '失败'))));
      else w.resolve(e);                          // { status, body, headers }
    });
  }

  function inflightCount() { return Object.keys(_inflight).length; }

  function hostHttp(opt) {
    if (typeof fb.invoke !== 'function') {
      return Promise.reject(new Error('宿主 HTTP 不可用'));
    }
    httpListen();
    var fn = opt.method === 'POST' ? 'http.post' : 'http.get';
    var params = { url: opt.url, async: true };
    if (opt.body != null) params.body = opt.body;
    if (opt.responseType) params.responseType = opt.responseType;
    if (opt.headers) params.headers = opt.headers;
    var tag = opt.tag || 'http';
    var ms = opt.ms || 15000;

    return fb.invoke(fn, params).then(function (init) {
      if (!init) throw new Error('宿主没有响应');
      if (init.async !== true || !init.requestId) {
        // 宿主忽略 async、当场回了全量（同 http.download 的行为）：直接当最终回包用
        if (init.success === false && !init.status) {
          throw new Error(init.error || init.code || '宿主请求失败');
        }
        return init;
      }
      return new Promise(function (resolve, reject) {
        _inflight[init.requestId] = {
          resolve: resolve,
          reject: reject,
          timer: setTimeout(function () {
            delete _inflight[init.requestId];
            /* abort 之后宿主不会再发 http:response，就地失败即可 */
            fb.invoke('http.abort', { requestId: init.requestId }).catch(function () {});
            reject(new Error('超时:' + tag));
          }, ms)
        };
      });
    });
  }

  function getJson(url, opt) {
    opt = opt || {};
    var headers = { 'User-Agent': UA, Referer: opt.referer || 'https://y.qq.com/' };
    if (opt.cookie) headers.Cookie = opt.cookie;
    if (opt.method === 'POST') headers['Content-Type'] = 'application/json';
    return hostHttp({
      method: opt.method || 'GET',
      url: url,
      body: opt.body,
      headers: headers,
      ms: opt.ms || 15000,
      tag: opt.tag || 'qq'
    }).then(function (r) {
      try {
        return JSON.parse(r.body);
      } catch (e) {
        throw new Error('返回不是 JSON（HTTP ' + (r.status || '?') + '）');
      }
    });
  }

  /* ------------------------------------------------------------
   * 配置：Cookie / 音质 / guid（localStorage 持久化）
   * ---------------------------------------------------------- */
  var LS_COOKIE = 'cm.qqmusic.cookie';
  var LS_QUALITY = 'cm.qqmusic.quality';
  var LS_GUID = 'cm.qqmusic.guid';

  function lsGet(k) {
    try { return localStorage.getItem(k) || ''; } catch (e) { return ''; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function lsDel(k) {
    try { localStorage.removeItem(k); } catch (e) {}
  }

  function getCookie() { return lsGet(LS_COOKIE).trim(); }
  function setCookie(ck) {
    ck = String(ck || '').trim();
    // 容错：整行从开发者工具里连 "Cookie: xxx" 一起复制的情况
    ck = ck.replace(/^cookie\s*:\s*/i, '');
    if (!ck) return clearCookie();               // 空串按"清除"处理
    lsSet(LS_COOKIE, ck);
    return true;
  }
  /* 删除键而不是写空串：留一个空键会让"到底清没清"看不出来 */
  function clearCookie() { lsDel(LS_COOKIE); return true; }

  /* 从 Cookie 里抠 uin（"uin=o0123456789" / "uin=123456789" 都认） */
  function cookieUin(ck) {
    ck = ck || getCookie();
    var m = /(?:^|;\s*)uin=o?0*(\d+)/i.exec(ck);
    return m ? m[1] : '';
  }

  function normQuality(q) {
    q = String(q || '').toLowerCase();
    if (q === 'mp3') return 'mp3';                               // 流播专用：纯 MP3 降级链
    if (q === 'm4a') return 'aac96';
    if (q === 'flac16' || q === 'sq') return 'flac';
    if (q === 'hi' || q === 'hires24') return 'hires';
    if (QUALS.indexOf(q) < 0) return 'master';
    return q;
  }

  function getQuality() { return normQuality(lsGet(LS_QUALITY) || 'master'); }
  function setQuality(q) { lsSet(LS_QUALITY, normQuality(q)); return getQuality(); }

  /* guid：vkey 与它绑定，生成一次后长期复用（换 guid 旧 vkey 失效） */
  function guid() {
    var g = lsGet(LS_GUID);
    if (!g) {
      g = String(Math.floor(Math.random() * 9e13) + 1000000000000);
      lsSet(LS_GUID, g);
    }
    return g;
  }

  /* ------------------------------------------------------------
   * 音质表（前缀 / 扩展名 / 标签 / 降级链）
   * ---------------------------------------------------------- */
  var QUALS = ['master', 'hires', 'flac', 'aac192', '320', 'aac96', '128'];
  var FILE_PREFIX = { master: 'AI00', hires: 'RS01', flac: 'F000',
                      aac192: 'C600', '320': 'M800', aac96: 'C400', '128': 'M500' };
  var FILE_EXT = { master: '.flac', hires: '.flac', flac: '.flac',
                   aac192: '.m4a', '320': '.mp3', aac96: '.m4a', '128': '.mp3' };
  var QUALITY_LABEL = { master: '臻品母带', hires: 'Hi-Res 24bit', flac: 'SQ 无损 FLAC',
                        aac192: 'AAC 192K', '320': '320K MP3', aac96: 'AAC 96K', '128': '128K MP3' };
  var CHAIN = {
    master: QUALS.slice(),
    hires: ['hires', 'flac', 'aac192', '320', 'aac96', '128'],
    flac: ['flac', 'aac192', '320', 'aac96', '128'],
    aac192: ['aac192', '320', 'aac96', '128'],
    '320': ['320', 'aac96', '128'],
    aac96: ['aac96', '128'],
    '128': ['128'],
    /* 流播专用：纯 MP3 链。
       **2026-10-23 实测**：M500(128K) 直链在 `aqqmusic.tc.qq.com` / `sjy6` /
       `ws` / `dl` / `isure` 五个主机上**全部**回 `Content-Type: audio/mpeg`、
       字节是 ID3 —— 以前"QQ CDN 一律打 audio/x-ogg"的说法至少对 mp3 不成立。
       320K(M800) 与无损(F000 / RS01 / AI00)：未登录时一律 `104003` / `101404`，
       连直链都拿不到，所以**它们的类型尚未实测**（要量必须有登录 Cookie）。
       在量到之前，播放固定走 MP3（320 → 128）—— 无论 CDN 怎么标都能播；
       无损仍请用下载落盘。 */
    mp3: ['320', '128']
  };
  /* 接口 sip 之外的兜底主机 */
  var SIPS = ['https://ws.stream.qqmusic.qq.com/', 'http://ws.stream.qqmusic.qq.com/',
              'https://isure.stream.qqmusic.qq.com/', 'https://dl.stream.qqmusic.qq.com/',
              'https://aqqmusic.tc.qq.com/', 'http://aqqmusic.tc.qq.com/',
              'https://sjy6.stream.qqmusic.qq.com/'];

  /* 从搜索结果的 file 字段推断有哪些档位
     （size_new 对应臻品母带，aac96 看 96/48 两档） */
  function availableQualities(file) {
    if (!file) return [];
    function big(v) { v = parseInt(v, 10); return v > 0; }
    var out = [];
    if (big(file.size_new)) out.push('master');
    if (big(file.size_hires)) out.push('hires');
    if (big(file.size_flac)) out.push('flac');
    if (big(file.size_192aac)) out.push('aac192');
    if (big(file.size_320mp3)) out.push('320');
    if (big(file.size_96aac) || big(file.size_48aac)) out.push('aac96');
    if (big(file.size_128mp3)) out.push('128');
    return out;
  }

  /* ------------------------------------------------------------
   * mediaMid → albummid 封面映射（在线播放的封面兜底）
   * ------------------------------------------------------------
   * 在线曲目的「路径」是 CDN 直链，宿主原生封面取不到、文件系统里也
   * 无处可扫（artwork-resolver 的目录扫描对 URL 无能为力）。但直链的
   * 文件名里带着这首歌的 mediaMid（C400<mediaMid>.m4a），而搜索结果
   * 恰好知道 mediaMid 对应哪张专辑 —— 在播放 / 下载时把映射记下来，
   * 封面兜底就能从直链反查出腾讯图床的专辑图。
   * 映射持久化在 localStorage（上限 400 条，超出粗略截断）。
   * ---------------------------------------------------------- */
  var LS_MEDIA_COVER = 'cm.qqmusic.mediacover';
  var MEDIA_COVER_MAX = 400;
  var _mediaCover = null;

  function mediaCoverMap() {
    if (_mediaCover) return _mediaCover;
    try {
      _mediaCover = JSON.parse(lsGet(LS_MEDIA_COVER) || '{}') || {};
    } catch (e) { _mediaCover = {}; }
    return _mediaCover;
  }

  function rememberMediaCovers(tracks) {
    (tracks || []).forEach(function (t) {
      if (t && t.mediaMid && t.albummid) mediaCoverMap()[t.mediaMid] = t.albummid;
    });
    // 歌名/歌手映射与封面映射是同一时机记的，必须放在下面的提前 return 之前 ——
    // 传入的曲目若都没带 albummid（例如只走联想通道的搜索结果），_mediaCover 仍是
    // null，提前 return 会把 rememberNames 一起跳过，在线曲目的歌名就退回 URL 碎片
    rememberNames(tracks);
    var map = _mediaCover;
    if (!map) return;
    var keys = Object.keys(map);
    if (keys.length > MEDIA_COVER_MAX) {
      for (var i = 0; i < keys.length - MEDIA_COVER_MAX; i++) delete map[keys[i]];
    }
    try { localStorage.setItem(LS_MEDIA_COVER, JSON.stringify(map)); } catch (e) {}
  }

  /* mediaMid → {title, artist, album, songmid, interval, ts, expiresAt}
     ------------------------------------------------------------
     直链本身不带任何标签：放到 foobar 里播放时，主题只能从 URL 尾巴猜名字，
     而 CDN 的签名参数里带 `/`，猜出来就是一段签名碎片（实测界面标题会变成
     "GsvWzqeUwhOhb+2GUTYfbcNo=" 这种）。所以播放 / 下载时把搜索结果里的
     歌名歌手一起记下来，由 core.js 的 CM.onlineName 取名时优先查。
     与封面映射同样持久化，上限 400 条。

     **songmid 必须一起记**：播放前重解析直链时，vkey 接口要求 songmid 与
     filename 一一配对。实测同一首歌（免费曲目）同一个 filename：
       songmid=001LcPEv1TEenh → purl 210 字符
       songmid=''            → purl 空串（result 仍是 0，不报错）
     所以"只有 mediaMid 也能刷直链"是不成立的 —— 早前 refreshUrl 传 ''，
     每次重播都必然失败，还报成「可能需要 VIP / 版权受限」。
     · ts        = 这次解析出直链的时刻（判新鲜度用）
     · expiresAt = 回包里的 expiration（秒）换算的绝对到期时间（实测 ≈22 小时）
     · interval  = 时长（秒），重搜兜底时用来区分同名原曲 / 伴奏 */
  var LS_NAMES = 'cm.qqmusic.names';
  var _names = null;

  function namesMap() {
    if (_names) return _names;
    try { _names = JSON.parse(lsGet(LS_NAMES) || '{}') || {}; }
    catch (e) { _names = {}; }
    return _names;
  }

  /* 合并写入（一批只落一次盘）。touch=true 表示"这是刚解析出的直链"：
     刷新 ts / expiresAt；false 只补字段（搜索时记歌名）。 */
  function storeNames(entries) {
    var map = namesMap(), changed = false;
    (entries || []).forEach(function (en) {
      var mid = en && en.mid;
      if (!mid) return;
      var meta = en.meta || {};
      var prev = map[mid] || {};
      var rec = {
        title: meta.title || prev.title || '',
        artist: meta.artist || prev.artist || '',
        album: meta.album || prev.album || '',
        songmid: meta.songmid || prev.songmid || '',
        interval: meta.interval || prev.interval || 0,
        ts: prev.ts || 0,
        expiresAt: prev.expiresAt || 0
      };
      if (en.touch) {
        rec.ts = Date.now();
        if (meta.expiresAt) rec.expiresAt = meta.expiresAt;
      }
      if (!rec.ts) rec.ts = Date.now();      // 只有歌名、没解析过：ts 记"首次见到"
      if (!rec.title && !rec.songmid) return; // 什么都不知道就不写
      map[mid] = rec;
      changed = true;
    });
    if (!changed) return;
    var keys = Object.keys(map);
    if (keys.length > MEDIA_COVER_MAX) {
      keys.sort(function (a, b) { return ((map[a] && map[a].ts) || 0) - ((map[b] && map[b].ts) || 0); });
      for (var i = 0; i < keys.length - MEDIA_COVER_MAX; i++) delete map[keys[i]];
    }
    try { lsSet(LS_NAMES, JSON.stringify(map)); } catch (e) {}
  }

  function rememberNames(tracks) {
    storeNames((tracks || []).map(function (t) {
      return { mid: t && t.mediaMid, meta: t ? {
        title: t.title, artist: t.artist || t.singer || '', album: t.album,
        songmid: t.songmid, interval: t.interval
      } : {} };
    }));
  }

  /* 这条直链是什么时候签发的（播放前判断"还要不要重新解析"用）。
     直链本身不带到期时间，借解析时记下的 ts。 */
  function pathIssuedAt(u) {
    var mid = mediaMidFromUrl(u);
    var n = mid && namesMap()[mid];
    return (n && n.ts) || 0;
  }

  /* 这条直链什么时候到期（QQ 的 vkey 回包带 expiration，秒）。
     有它就精确判新鲜度，没有就交回调用方的保守窗口。 */
  function pathExpiresAt(u) {
    var mid = mediaMidFromUrl(u);
    var n = mid && namesMap()[mid];
    return (n && n.expiresAt) || 0;
  }

  /* 直链 → 歌名/歌手（注册给主题的 CM.onlineName） */
  function onlineName(path) {
    var mid = mediaMidFromUrl(path);
    if (!mid) return null;
    var n = namesMap()[mid];
    return n ? { title: n.title, artist: n.artist, album: n.album } : null;
  }

  if (window.CloudMusic && window.CloudMusic.registerOnlineName) {
    window.CloudMusic.registerOnlineName(onlineName);
  }

  function mediaCover(mediaMid) {
    return mediaCoverMap()[mediaMid] || '';
  }

  /* 从 CDN 直链里抠 mediaMid：文件名就是 档位前缀 + mediaMid + 扩展名 */
  var MEDIA_MID_RE = /\/(?:C400|M500|M800|C600|F000|AI00|RS01)([0-9A-Za-z]{10,16})\.(?:m4a|mp3|flac)/i;

  function mediaMidFromUrl(url) {
    var m = MEDIA_MID_RE.exec(String(url || ''));
    return m ? m[1] : '';
  }

  /* ------------------------------------------------------------
   * 搜索：聚合（首选）→ 旧版 Web → 联想，三通道归一
   * ---------------------------------------------------------- */
  /* 通道失败计数：全是网络/接口异常时，空结果不等于「这首歌没有歌词」，
     调用方据此区分「上游明确没有」与「这次没问成」（后者不进负缓存）。 */
  var _netErr = 0;
  function netErrs() { return _netErr; }
  /* 本轮 search() 期间是否有任一通道「正常应答」（code 0 / 返回了预期结构）。
     正常应答下的 0 结果是权威的「没有搜到」；全部通道都没正常应答才算网络失败。
     模块级变量存在并发互踩的理论可能，但只会让错误分类退化成旧行为（空态），可接受。 */
  var _channelOk = false;

  function musicuPost(payload, ms) {
    return getJson('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      body: JSON.stringify(payload),
      cookie: getCookie(),
      ms: ms || 15000,
      tag: 'musicu'
    });
  }

  /* 桌面端聚合搜索。key 固定 req_0、不带 comm（带上反而被风控成空） */
  function searchMusicu(kw, page, size) {
    return musicuPost({
      req_0: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicDesktop',
        param: { query: kw, page_num: page, num_per_page: size, search_type: 0 }
      }
    }).then(function (j) {
      var q = j && j.req_0;
      // code 非 0（匿名被限流 / 风控）不是「搜到 0 首」：按网络失败计数，
      // 歌词链路据此把这次的空结果标记为 transient，不进 30 分钟负缓存
      if (!q || q.code !== 0) { _netErr++; return []; }
      _channelOk = true;
      var d = q.data || {};
      var list = d.body && d.body.song && d.body.song.list;
      return Array.isArray(list) ? list : [];
    }, function () { _netErr++; return []; });
  }

  /* 旧版 Web 搜索（聚合接口失效时的回退） */
  function searchLegacy(kw, page, size) {
    var qs = 'ct=24&qqmusic_ver=1298&new_json=1&remoteplace=txt.yqq.song&searchid=0' +
             '&t=0&aggr=1&cr=1&catZhida=1&lossless=0&flag_qc=1' +
             '&p=' + page + '&n=' + size + '&w=' + encodeURIComponent(kw) +
             '&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8' +
             '&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';
    return getJson('https://c.y.qq.com/soso/fcgi-bin/client_search_cp?' + qs, {
      ms: 12000, tag: 'legacy'
    }).then(function (j) {
      // 应用层错误体（code 非 0）按网络失败计，与「正常返回但 0 结果」区分开
      if (!j || (j.code != null && j.code !== 0)) { _netErr++; return []; }
      if (j.data && j.data.song) _channelOk = true;   // 预期结构在 → 0 结果也是权威空态
      var list = j && j.data && j.data.song && j.data.song.list;
      return Array.isArray(list) ? list : [];
    }, function () { _netErr++; return []; });
  }

  /* 联想搜索：结果只有 mid/名称/歌手（无时长无 mediaMid），但匿名也稳定 */
  function searchSmartbox(kw) {
    var qs = 'key=' + encodeURIComponent(kw) + '&format=json&utf8=1';
    return getJson('https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?' + qs, {
      ms: 10000, tag: 'smartbox'
    }).then(function (j) {
      // 应用层错误体按网络失败计；code 为 0 但没有 song 分类是正常的「联想无结果」
      if (!j || (j.code != null && j.code !== 0)) { _netErr++; return []; }
      if (j.data && j.data.song) _channelOk = true;
      var list = j && j.data && j.data.song && j.data.song.itemlist;
      return Array.isArray(list) ? list : [];
    }, function () { _netErr++; return []; });
  }

  /* 单曲详情：补 media_mid / interval / pay（联想结果的兜底信息源） */
  function songDetail(songmid) {
    var qs = 'songmid=' + encodeURIComponent(songmid) + '&platform=yqq.json&format=json';
    return getJson('https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?' + qs, {
      ms: 10000, tag: 'songdetail'
    }).then(function (j) {
      var arr = j && j.data;
      return (Array.isArray(arr) && arr[0]) || null;
    }, function () { _netErr++; return null; });
  }

  function joinSinger(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
      if (list[i] && list[i].name) out.push(list[i].name);
    }
    return out.join(' / ');
  }

  /* 两种接口的返回 → 前端要的字段 */
  function normalize(item) {
    if (!item) return null;
    var file = item.file || {};
    var album = item.album || {};
    var pay = item.pay || {};
    var title = item.name || item.title || '';
    var subtitle = item.subtitle || '';
    if (subtitle) title = title + '（' + subtitle + '）';
    var singer = item.singer;
    if (typeof singer === 'string') {
      return {
        songmid: item.mid || item.songmid || '',
        mediaMid: file.media_mid || '',
        songid: item.id || item.songid || 0,
        title: title, subtitle: '', artist: singer,
        album: album.name || '', albummid: album.mid || album.pmid || '',
        interval: item.interval || 0,
        vip: pay.payplay === 1 || pay.pay_play === 1,
        avail: []
      };
    }
    return {
      songmid: item.mid || item.songmid || '',
      mediaMid: file.media_mid || '',
      songid: item.id || item.songid || 0,
      title: title, subtitle: '',
      artist: joinSinger(singer),
      album: album.name || '',
      albummid: album.mid || album.pmid || '',
      interval: item.interval || 0,
      vip: pay.payplay === 1 || pay.pay_play === 1,
      avail: availableQualities(file)
    };
  }

  function dedupe(songs) {
    var seen = {}, out = [];
    for (var i = 0; i < songs.length; i++) {
      var s = songs[i];
      if (!s || !s.songmid || seen[s.songmid]) continue;
      seen[s.songmid] = 1;
      out.push(s);
    }
    return out;
  }

  /* 搜到 0 首 ≠ 搜索失败：ok 表示「这次查询问成了」，UI 才能区分
     「没有搜到结果」（空态提示）与「网络/接口出错」（错误提示）。 */
  function search(kw, page, size) {
    kw = String(kw || '').trim();
    page = Math.max(1, page | 0);
    size = Math.max(1, size | 0);
    if (!kw) return Promise.resolve({ ok: false, songs: [], more: false, error: '缺少关键词' });

    _channelOk = false;   // 本轮是否至少有一个通道正常应答（含权威的 0 结果）
    return searchMusicu(kw, page, size).then(function (list) {
      if (list.length) return list;
      return searchLegacy(kw, page, size);          // 聚合被限流 → 旧版接口
    }).then(function (list) {
      if (list.length || page > 1) return list;
      return searchSmartbox(kw).then(function (sb) {
        // 联想结果缺时长 / mediaMid / 专辑，把前几首用单曲详情补齐
        var top = sb.slice(0, 8);
        return Promise.all(top.map(function (it) {
          return it && it.mid ? songDetail(it.mid).then(function (d) {
            return d || it;
          }) : Promise.resolve(it || null);
        }));
      });
    }).then(function (list) {
      var songs = dedupe(list.map(normalize).filter(Boolean));
      // 三个通道全都没正常应答 → 这次是「没问成」而非「没有结果」：
      // 断网/全被限流时不能让用户等完所有超时还看到「没有搜到结果」。
      // 只要有任一通道正常应答，0 结果就是权威的空态（如翻到最后一页之后）
      if (!songs.length && !_channelOk) {
        return { ok: false, songs: [], more: false, error: '网络异常，请检查连接后重试' };
      }
      return { ok: true, songs: songs, more: songs.length >= size, error: null };
    }, function (e) {
      return { ok: false, songs: [], more: false, error: (e && e.message) || '搜索失败' };
    });
  }

  /* ------------------------------------------------------------
   * 直链解析：一次请求拿回整条降级链，逐个轻量探测
   * ---------------------------------------------------------- */
  var _midCache = {};                               // songmid -> mediaMid

  function getMediaMid(songmid) {
    if (_midCache[songmid]) return Promise.resolve(_midCache[songmid]);
    return songDetail(songmid).then(function (d) {
      var mid = d && d.file && d.file.media_mid || '';
      if (mid) { _midCache[songmid] = mid; cacheTrim(_midCache); }
      return mid;
    });
  }

  /* 轻量探测：Range 只要 1 字节，200/206 都算可用。
     必须带 responseType:'binary' —— 响应体是音频字节，宿主按 UTF-8 文本
     序列化会整个请求报错（异步模式下更糟：事件都不发，看起来像探测超时）。 */
  function probe(url) {
    var headers = { 'User-Agent': UA, Referer: 'https://y.qq.com/', Range: 'bytes=0-0' };
    var ck = getCookie();
    if (ck) headers.Cookie = ck;
    return hostHttp({ url: url, headers: headers, responseType: 'binary',
                      ms: 8000, tag: 'probe' })
      .then(function (r) { return r.status === 206 || r.status === 200; },
            function () { return false; });
  }

  function _vkeyChain(songmid, mediaMid, chain) {
    var uin = cookieUin() || '0';
    var filenames = chain.map(function (q) {
      return FILE_PREFIX[q] + mediaMid + FILE_EXT[q];
    });
    return musicuPost({
      comm: { uin: uin, format: 'json', ct: '24', cv: 0 },
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid: guid(),
          songmid: chain.map(function () { return songmid; }),
          songtype: chain.map(function () { return 0; }),
          uin: uin,
          loginflag: 1,
          platform: '20',
          filename: filenames
        }
      }
    }, 25000).then(function (j) {
      var q = j && j.req_0;
      var d = q && q.data;
      if (!d || !Array.isArray(d.midurlinfo) || !d.midurlinfo.length) {
        throw new Error('接口未返回任何音源数据（检查网络或接口变动）');
      }
      var hosts = (Array.isArray(d.sip) && d.sip.length ? d.sip : SIPS).filter(Boolean);
      // expiration 是秒（实测 80400 ≈ 22 小时），给判新鲜度用
      return { infos: d.midurlinfo, hosts: hosts, chain: chain,
               expiration: Number(d.expiration) || 0 };
    });
  }

  /* 播放前刷新直链：旧 vkey 过期后 foobar 打不开就自动跳下一首（"还没开始就跳歌"）。
     直链文件名里带 mediaMid，但**光有 mediaMid 不够**：vkey 接口要求 songmid 与
     filename 配对，songmid 传空时 purl 恒为空串（实测，见文件头 namesMap 注释）。
     所以刷新一律优先用解析时记下的 songmid；老记录（这次修复之前写下的映射没有
     songmid）按歌名 / 歌手 / 时长重搜一次把 songmid 找回来 —— 同名伴奏与原曲的
     mediaMid 不同，能用 mediaMid 命中就直接锁定。 */
  function refreshUrl(u) {
    var mid = mediaMidFromUrl(u);
    if (!mid) {
      // 认不出 mediaMid：没法重新解析，交给调用方原样播（不能因为刷新不了就拒绝）
      var e0 = new Error('这条直链里没有 mediaMid');
      e0.cmUnidentifiable = true;
      return Promise.reject(e0);
    }
    // 播放路径固定 MP3 档（与 playTracks 的 resolveMany(tracks,'mp3') 同一口径）：
    // getQuality() 是下载档，跟随它会把登录态解析出的 FLAC/母带直链交给宿主流播
    var quality = 'mp3';
    var rec = namesMap()[mid] || {};

    /* 解析成功：记下 songmid 与新直链的签发 / 到期时间（下次判新鲜度用） */
    function accept(r, song) {
      if (!r || !r.url) throw new Error('重新解析拿不到直链');
      // 落库要用**实际解析用的** mediaMid（重搜兜底可能换 mid）：记到旧 mid 名下
      // 的话新直链查不到映射 —— 新鲜度判定失效、下次刷新误报"缺映射"、歌名退回签名碎片
      storeNames([{ mid: (r.mediaMid || mid), touch: true, meta: {
        title: rec.title || (song && song.title) || '',
        artist: rec.artist || (song && song.artist) || '',
        album: rec.album || (song && song.album) || '',
        songmid: r.songmid || (song && song.songmid) || '',
        interval: rec.interval || (song && song.interval) || 0,
        expiresAt: r.expiresAt || 0
      } }]);
      return r.url;
    }

    if (rec.songmid) {
      return resolveStream(rec.songmid, quality, mid).then(function (r) { return accept(r); });
    }

    if (rec.title) {
      return refindSong(rec, mid).then(function (song) {
        return resolveStream(song.songmid, quality, song.mediaMid || mid)
          .then(function (r) { return accept(r, song); });
      });
    }

    // 什么都不知道（映射被裁掉 / 手工贴的直链）：只能按 mediaMid 试一次，
    // 大概率拿不到 —— 交给调用方如实报错，别假装能播
    return resolveStream('', quality, mid).then(function (r) { return accept(r); },
      function (e) {
        throw new Error('缺少这首歌的映射（songmid），重新搜索后再播一次即可刷新' +
                        '（原报错：' + ((e && e.message) || '解析失败') + '）');
      });
  }

  /* 老记录缺 songmid 时的兜底：按「歌手 + 歌名」重搜，挑回同一首。
     优先级：mediaMid 完全一致 > 同名同歌手且时长差 ≤2 秒（伴奏与原曲常常同名，
     只能靠时长）> 同名同歌手且只有一首。挑不唯一就失败 —— 宁可报错也不要
     把伴奏当成原曲播出去。 */
  function refindSong(rec, mid) {
    var kw = ((rec.artist ? rec.artist + ' ' : '') + (rec.title || '')).trim();
    if (!kw) return Promise.reject(new Error('没有可用于重搜的歌名'));
    return search(kw, 1, 20).then(function (r) {
      var songs = (r && r.songs) || [];
      var exactMid = null, byDur = null, sameName = [];
      songs.forEach(function (s) {
        if (!s || !s.songmid) return;
        if (s.mediaMid && s.mediaMid === mid) { exactMid = s; return; }
        if (s.title !== rec.title) return;
        if (rec.artist && (s.artist || '') !== rec.artist) return;
        sameName.push(s);
        if (rec.interval && Math.abs((s.interval || 0) - rec.interval) <= 2) {
          if (!byDur || Math.abs((s.interval || 0) - rec.interval) <
                       Math.abs((byDur.interval || 0) - rec.interval)) byDur = s;
        }
      });
      if (exactMid) return exactMid;
      if (byDur) return byDur;
      if (sameName.length === 1) return sameName[0];
      throw new Error(sameName.length ? '同名曲目有多首，无法确定是哪一首' : '重搜没有找到同名同歌手的曲目');
    });
  }

  /* 依次探测「降级链」上的 purl，返回第一个可用的直链 */
  function resolveStream(songmid, quality, mediaMid) {
    quality = normQuality(quality);
    var chain = CHAIN[quality] || CHAIN.master;
    if (!songmid && !mediaMid) {
      return Promise.reject(new Error('缺少 songmid，无法解析直链'));
    }

    function tryResolve(mid) {
      return _vkeyChain(songmid, mid, chain).then(function (r) {
        var hosts = r.hosts;
        function tryInfo(i) {
          if (i >= r.infos.length) {
            /* 整条链都空：区分「未登录拿不到付费直链」和「版权 / 下架」两种情况 */
            return Promise.reject(new Error(getCookie()
              ? '拿不到直链（可能需要 VIP / 版权受限）'
              : '拿不到直链（未登录：付费曲目需要点右上角「设置 Cookie」）'));
          }
          var info = r.infos[i];
          var purl = info && info.purl;
          if (!purl) return tryInfo(i + 1);
          var urls = hosts.map(function (h) {
            return (/^https?:\/\//i.test(h) ? h : 'https://' + h) + purl;
          });
          function tryHost(k) {
            if (k >= urls.length) return tryInfo(i + 1);
            return probe(urls[k]).then(function (ok) {
              if (ok) {
                return { ok: true, url: urls[k], quality: r.chain[i],
                         mediaMid: mid, songmid: songmid,
                         expiresAt: r.expiration ? Date.now() + r.expiration * 1000 : 0 };
              }
              return tryHost(k + 1);
            });
          }
          return tryHost(0);
        }
        return tryInfo(0);
      });
    }

    if (mediaMid) return tryResolve(mediaMid);
    return getMediaMid(songmid).then(function (mid) {
      if (!mid) {
        return Promise.reject(new Error('查不到这首歌的 media_mid，无法解析直链'));
      }
      return tryResolve(mid);
    });
  }

  /* 会话缓存：同一首同档位 30 分钟内不重解析（vkey 本身约 2 小时有效） */
  var _streamCache = {};
  var STREAM_TTL = 30 * 60 * 1000;

  /* 缓存裁剪：超过上限就丢一半。带 ts 的按时间丢最旧的（同一首反复解析
     才不会被早期条目挤掉），不带 ts 的退回插入序。 */
  function cacheTrim(obj) {
    var keys = Object.keys(obj);
    if (keys.length <= 120) return;
    keys.sort(function (a, b) {
      return ((obj[a] && obj[a].ts) || 0) - ((obj[b] && obj[b].ts) || 0);
    });
    for (var i = 0; i < (keys.length >> 1); i++) delete obj[keys[i]];
  }

  /* 批量解析：整批解析，返回直链 + 跳过名单 + 实际档位统计。
     并发 3 条：宿主 HTTP 已异步，串行 30 首要等 10 秒以上，并发后基本
     由网络往返决定；结果按**输入顺序**回填 —— 第一首必须是 urls[0]，
     调用方靠「追加前的曲目数」定位新曲并开播，顺序错了会播错曲目。 */
  var RESOLVE_CONCURRENCY = 3;

  function resolveMany(tracks, quality) {
    quality = normQuality(quality);
    tracks = tracks || [];
    if (!tracks.length) {
      return Promise.resolve({ ok: false, urls: [], resolves: [], skipped: [],
                               usedLabel: '', error: '没有曲目' });
    }
    var results = new Array(tracks.length);
    var next = 0;

    function worker() {
      if (next >= tracks.length) return Promise.resolve();
      var i = next++;
      var t = tracks[i] || {};
      /* 缓存键必须能标识这首歌：songmid 缺失时退回 mediaMid。
         两者都没有的话不缓存 —— 全都落到 '@mp3' 上会互相污染，
         下一首会拿到上一首的直链。 */
      var id = t.songmid || t.mediaMid || '';
      var key = id ? (id + '@' + quality) : '';
      var cached = key ? _streamCache[key] : null;
      var p = (cached && (Date.now() - cached.ts) < STREAM_TTL)
        ? Promise.resolve(cached.r)
        : resolveStream(t.songmid, quality, t.mediaMid).then(function (r) {
            if (key) {
              _streamCache[key] = { ts: Date.now(), r: r };
              cacheTrim(_streamCache);
            }
            return r;
          });
      return p.then(function (r) {
        results[i] = { ok: true, r: r, t: t };
      }, function (e) {
        results[i] = { ok: false, e: e, t: t };
      }).then(worker);
    }

    var workers = [];
    var n = Math.min(RESOLVE_CONCURRENCY, tracks.length);
    // 用 Promise.resolve().then(worker) 起链：worker 内部万一同步抛错，
    // 也会变成 rejected promise（而不是从 resolveMany 同步抛出 →
    // 调用方的 .catch 收不到、busy 标志卡住）
    for (var w = 0; w < n; w++) workers.push(Promise.resolve().then(worker));

    return Promise.all(workers).then(function () {
      // 解析完就把「直链 → 歌名/歌手」记下来（不等调用方记得调 rememberMediaCovers）：
      // 在线曲目在 foobar 里没有标签，主题取名只能靠这张表
      rememberNames(tracks);
      /* 再补一条"解析结果"：这批才有 mediaMid（搜索结果不带 file.media_mid 时
         是靠 songDetail 补的）与 **songmid**。songmid 是重播时重解析直链的钥匙，
         少了它 vkey 只会回空 purl（见 namesMap 注释），重播就会报"找不到"。 */
      storeNames(results.map(function (r) {
        if (!r || !r.ok || !r.r) return null;
        var t = r.t || {};
        return { mid: r.r.mediaMid, touch: true, meta: {
          songmid: r.r.songmid || t.songmid || '',
          expiresAt: r.r.expiresAt || 0,
          title: t.title, artist: t.artist, album: t.album, interval: t.interval
        } };
      }).filter(Boolean));
      var urls = [], resolves = [], skipped = [], qCount = {};
      for (var i = 0; i < results.length; i++) {
        var r = results[i] || { ok: false, e: new Error('解析中断'), t: tracks[i] || {} };
        if (r.ok) {
          urls.push(r.r.url);
          resolves.push(r.r);
          qCount[r.r.quality] = (qCount[r.r.quality] || 0) + 1;
        } else {
          skipped.push((r.t.title || r.t.songmid || '未知曲目') +
                       '（' + ((r.e && r.e.message) || '解析失败') + '）');
        }
      }
      var usedLabel = Object.keys(qCount).map(function (q) {
        return QUALITY_LABEL[q] + ' ×' + qCount[q];
      }).join(' · ');
      return {
        ok: urls.length > 0,
        urls: urls, resolves: resolves, skipped: skipped,
        usedLabel: usedLabel,
        error: urls.length ? null : '这批曲目都没有可用音源'
      };
    });
  }

  /* ------------------------------------------------------------
   * 歌词实时匹配（多轮放宽搜索 × 逐候选打分）
   * ---------------------------------------------------------- */
  /* 繁→简对照：平铺的 (繁,简) 字对，逐字查，查不到原样保留 */
  var T2S = '㑯㑔㑳㑇㑶㐹㓨刾㗲𠵾㘚㘎㜄㚯㜏㛣㜢𡞱㠏㟆㠣𫵷㥮㤘㩜㨫㩳㧐㩵擜㺏𤠋䁪𥇢䁻䀥䃮鿎䊷䌶䋙䌺䋚䌻䋹䌿䋻䌾䍦䍠䎱䎬䓣𬜯䙡䙌䜀䜧䝼䞍䡵𫟦䥇䦂䥑鿏䥕𬭯䥱䥾䦛䦶䦟䦷䧢𨸟䮄𫠊䯀䯅䰾鲃䱷䲣䱽䲝䲁鳚䲘鳤䴉鹮丟丢並并乾干亂乱亙亘亞亚佇伫佈布佔占併并來来侖仑侶侣侷局俁俣係系俔伣俠侠俥伡俬私倀伥倆俩倈俫倉仓個个們们倖幸倫伦倲㑈偉伟偑㐽側侧偵侦偽伪傌㐷傑杰傖伧傘伞備备傢家傭佣傯偬傳传傴伛債债傷伤傾倾僂偻僅仅僉佥僑侨僕仆僞伪僤𫢸僥侥僨偾僱雇價价儀仪儁俊儂侬億亿儈侩儉俭儎傤儐傧儔俦儕侪儘尽償偿優优儲储儷俪儸㑩儺傩儻傥儼俨兇凶兌兑兒儿兗兖內内兩两冊册冑胄冪幂凈净凍冻凜凛凱凯別别刪删剄刭則则剋克剎刹剗刬剛刚剝剥剮剐剴剀創创剷铲劃划劄札劇剧劉刘劊刽劌刿劍剑劏㓥劑剂劚㔉勁劲動动務务勛勋勝胜勞劳勢势勣𪟝勩勚勱劢勳勋勵励勸劝勻匀匭匦匯汇匱匮區区協协卹恤卻却卽即厙厍厠厕厤历厭厌厲厉厴厣參参叄叁叢丛吒咤吳吴吶呐呂吕咼呙員员唄呗唸念問问啓启啞哑啟启啢唡喎㖞喚唤喪丧喫吃喬乔單单喲哟嗆呛嗇啬嗊唝嗎吗嗚呜嗩唢嗰𠮶嗶哔嘆叹嘍喽嘓啯嘔呕嘖啧嘗尝嘜唛嘩哗嘮唠嘯啸嘰叽嘵哓嘸呒嘽啴噁恶噓嘘噚㖊噝咝噠哒噥哝噦哕噯嗳噲哙噴喷噸吨噹当嚀咛嚇吓嚌哜嚐尝嚕噜嚙啮嚥咽嚦呖嚧𠰷嚨咙嚮向嚲亸嚳喾嚴严嚶嘤囀啭囁嗫囂嚣囅冁囈呓囉啰囌苏囑嘱囪囱圇囵國国圍围園园圓圆圖图團团垻坝埡垭埨𫭢埰采執执堅坚堊垩堖垴堝埚堯尧報报場场塊块塋茔塏垲塒埘塗涂塚冢塢坞塤埙塵尘塸𫭟塹堑塿𪣻墊垫墜坠墠𫮃墮堕墰坛墳坟墶垯墻墙墾垦壇坛壋垱壎埙壓压壗𡋤壘垒壙圹壚垆壜坛壞坏壟垄壠垅壢坜壩坝壪塆壯壮壺壶壼壸壽寿夠够夢梦夥伙夾夹奐奂奧奥奩奁奪夺奬奖奮奋奼姹妝妆姍姗姦奸娙𫰛娛娱婁娄婦妇婭娅媧娲媯妫媰㛀媼媪媽妈嫋袅嫗妪嫵妩嫺娴嫻娴嫿婳嬀妫嬃媭嬈娆嬋婵嬌娇嬙嫱嬡嫒嬤嬷嬪嫔嬰婴嬸婶孃娘孋㛤孌娈孫孙學学孻𡥧孿孪宮宫寀采寢寝實实寧宁審审寫写寬宽寵宠寶宝將将專专尋寻對对導导尷尴屆届屍尸屓屃屜屉屢屡層层屨屦屬属岡冈峯峰峴岘島岛峽峡崍崃崑昆崗岗崙仑崢峥崬岽嵐岚嵗岁嵽𫶇嵾㟥嶁嵝嶄崭嶇岖嶔嵚嶗崂嶠峤嶢峣嶧峄嶨峃嶮崄嶸嵘嶺岭嶼屿嶽岳巋岿巒峦巔巅巖岩巘𪩘巰巯巹卺帥帅師师帳帐帶带幀帧幃帏幓㡎幗帼幘帻幟帜幣币幫帮幬帱幷并幹干幾几庫库廁厕廂厢廄厩廈厦廎庼廕荫廚厨廝厮廞𫷷廟庙廠厂廡庑廢废廣广廩廪廬庐廳厅弒弑弔吊弳弪張张強强彄𫸩彆别彈弹彌弥彎弯彔录彙汇彠彟彥彦彫雕彲彨彿佛後后徑径從从徠徕復复徵征徹彻恆恒恥耻悅悦悞悮悵怅悶闷悽凄惡恶惱恼惲恽惻恻愛爱愜惬愨悫愴怆愷恺愾忾慄栗態态慍愠慘惨慚惭慟恸慣惯慤悫慪怄慫怂慮虑慳悭慶庆慺㥪慼戚慾欲憂忧憊惫憐怜憑凭憒愦憖慭憚惮憤愤憫悯憮怃憲宪憶忆懇恳應应懌怿懍懔懞蒙懟怼懣懑懤㤽懨恹懲惩懶懒懷怀懸悬懺忏懼惧懾慑戀恋戇戆戔戋戧戗戩戬戰战戱戯戲戏戶户扞捍拋抛拚拼挩捝挱挲挾挟捨舍捫扪捱挨捲卷掃扫掄抡掆㧏掗挜掙挣掛挂採采揀拣揚扬換换揮挥揯搄損损搖摇搗捣搧扇搵揾搶抢摑掴摜掼摟搂摯挚摳抠摶抟摺折摻掺撈捞撏挦撐撑撓挠撝㧑撟挢撣掸撥拨撫抚撲扑撳揿撻挞撾挝撿捡擁拥擄掳擇择擊击擋挡擓㧟擔担據据擠挤擡抬擣捣擬拟擯摈擰拧擱搁擲掷擴扩擷撷擺摆擻擞擼撸擽㧰擾扰攄摅攆撵攏拢攔拦攖撄攙搀攛撺攜携攝摄攢攒攣挛攤摊攪搅攬揽敎教敓敚敗败敘叙敵敌數数斂敛斃毙斆敩斕斓斬斩斷断於于旂旗旣既昇升時时晉晋晛𬀪晝昼暈晕暉晖暐𬀩暘旸暢畅暫暂曄晔曆历曇昙曉晓曏向曖暧曠旷曥𣆐曨昽曬晒書书會会朥𦛨朧胧朮术東东枴拐柵栅柺拐査查桱𣐕桿杆梔栀梘枧梜𬂩條条梟枭梲棁棄弃棊棋棖枨棗枣棟栋棡㭎棧栈棲栖棶梾椏桠椲㭏楊杨楓枫楨桢業业極极榘矩榦干榪杩榮荣榲榅榿桤構构槍枪槓杠槤梿槧椠槨椁槮椮槳桨槶椢槼椝樁桩樂乐樅枞樑梁樓楼標标樞枢樢㭤樣样樧榝樫㭴樳桪樸朴樹树樺桦樿椫橈桡橋桥機机橢椭橫横橯𣓿檁檩檉柽檔档檜桧檟槚檢检檣樯檮梼檯台檳槟檸柠檻槛櫃柜櫍𬃊櫓橹櫚榈櫛栉櫝椟櫞橼櫟栎櫥橱櫧槠櫨栌櫪枥櫫橥櫬榇櫱蘖櫳栊櫸榉櫻樱欄栏欅榉權权欏椤欒栾欓𣗋欖榄欞棂欽钦歎叹歐欧歟欤歡欢歲岁歷历歸归歿殁殘残殞殒殤殇殨㱮殫殚殭僵殮殓殯殡殰㱩殲歼殺杀殻壳殼壳毀毁毆殴毿毵氂牦氈毡氌氇氣气氫氢氬氩氳氲氾泛汎泛汙污決决沒没沖冲況况泝溯洩泄洶汹浹浃浿𬇙涇泾涗涚涼凉淒凄淚泪淥渌淨净淩凌淪沦淵渊淶涞淺浅渙涣減减渢沨渦涡測测渾浑湊凑湋𣲗湞浈湧涌湯汤溈沩準准溝沟溫温溮浉溳涢溼湿滄沧滅灭滌涤滎荥滙汇滬沪滯滞滲渗滷卤滸浒滻浐滾滚滿满漁渔漊溇漍𬇹漚沤漢汉漣涟漬渍漲涨漵溆漸渐漿浆潁颍潑泼潔洁潕𣲘潙沩潚㴋潛潜潤润潯浔潰溃潷滗潿涠澀涩澆浇澇涝澐沄澗涧澠渑澤泽澦滪澩泶澫𬇕澮浍澱淀澾㳠濁浊濃浓濄㳡濆𣸣濕湿濘泞濚溁濛蒙濜浕濟济濤涛濧㳔濫滥濰潍濱滨濺溅濼泺濾滤瀂澛瀅滢瀆渎瀇㲿瀉泻瀋沈瀏浏瀕濒瀘泸瀝沥瀟潇瀠潆瀦潴瀧泷瀨濑瀰弥瀲潋瀾澜灃沣灄滠灑洒灒𪷽灕漓灘滩灙𣺼灝灏灡㳕灣湾灤滦灧滟灩滟災灾為为烏乌烴烃無无煉炼煒炜煙烟煢茕煥焕煩烦煬炀煱㶽熅煴熒荧熗炝熰𬉼熱热熲颎熾炽燀𬊤燁烨燈灯燉炖燒烧燖𬊈燙烫燜焖營营燦灿燬毁燭烛燴烩燶㶶燻熏燼烬燾焘爍烁爐炉爛烂爭争爲为爺爷爾尔牀床牆墙牘牍牴抵牽牵犖荦犛牦犢犊犧牺狀状狹狭狽狈猙狰猶犹猻狲獁犸獃呆獄狱獅狮獎奖獨独獪狯獫猃獮狝獰狞獱㺍獲获獵猎獷犷獸兽獺獭獻献獼猕玀猡現现琱雕琺珐琿珲瑋玮瑒玚瑣琐瑤瑶瑩莹瑪玛瑲玱璉琏璊𫞩璕𬍤璗𬍡璡琎璣玑璦瑷璫珰璯㻅環环璵玙璸瑸璽玺璿璇瓅𬍛瓊琼瓏珑瓔璎瓚瓒瓛𤩽甌瓯甕瓮產产産产畝亩畢毕畫画異异畵画當当疇畴疊叠痙痉痠酸痾疴瘂痖瘋疯瘍疡瘓痪瘞瘗瘡疮瘧疟瘮瘆瘲疭瘺瘘瘻瘘療疗癆痨癇痫癉瘅癒愈癘疠癟瘪癡痴癢痒癤疖癥症癧疬癩癞癬癣癭瘿癮瘾癰痈癱瘫癲癫發发皁皂皚皑皰疱皸皲皺皱盃杯盜盗盞盏盡尽監监盤盘盧卢盪荡眞真眥眦眾众睍𪾢睏困睜睁睞睐瞘眍瞜䁖瞞瞒瞶瞆瞼睑矇蒙矓眬矚瞩矯矫硃朱硜硁硤硖硨砗硯砚碕埼碩硕碭砀碸砜確确碼码碽䂵磑硙磚砖磠硵磣碜磧碛磯矶磽硗磾䃅礄硚礎础礐𬒈礙碍礦矿礪砺礫砾礬矾礱砻祕秘祿禄禍祸禎祯禕祎禡祃禦御禪禅禮礼禰祢禱祷禿秃秈籼稅税稈秆稏䅉稜棱稟禀種种稱称穀谷穇䅟穌稣積积穎颖穠秾穡穑穢秽穩稳穫获穭穞窩窝窪洼窮穷窯窑窵窎窶窭窺窥竄窜竅窍竇窦竈灶竊窃竪竖競竞筆笔筍笋筧笕筴䇲箇个箋笺箏筝箚札節节範范築筑篋箧篔筼篠筿篢𬕂篤笃篩筛篳筚篸𥮾簀箦簍篓簑蓑簞箪簡简簣篑簫箫簹筜簽签簾帘籃篮籅𥫣籌筹籔䉤籙箓籛篯籜箨籟籁籠笼籤签籩笾籪簖籬篱籮箩籲吁粵粤糉粽糝糁糞粪糧粮糰团糲粝糴籴糶粜糹纟糾纠紀纪紂纣紃𬘓約约紅红紆纡紇纥紈纨紉纫紋纹納纳紐纽紓纾純纯紕纰紖纼紗纱紘纮紙纸級级紛纷紜纭紝纴紞𬘘紡纺紬䌷紮扎細细紱绂紲绁紳绅紵纻紹绍紺绀紼绋紿绐絀绌終终絃弦組组絅䌹絆绊絎绗結结絕绝絛绦絝绔絞绞絡络絢绚給给絨绒絪𬘡絰绖統统絲丝絳绛絶绝絹绢絺𫄨綁绑綃绡綄𬘫綆绠綈绨綉绣綌绤綎𬘩綏绥綐䌼綑捆經经綖𫄧綜综綝𬘭綞缍綠绿綡𫟅綢绸綣绻綧𬘯綪𬘬綫线綬绶維维綯绹綰绾綱纲網网綳绷綴缀綵彩綸纶綹绺綺绮綻绽綽绰綾绫綿绵緄绲緇缁緊紧緋绯緑绿緒绪緓绬緔绱緗缃緘缄緙缂線线緝缉緞缎締缔緡缗緣缘緦缌編编緩缓緬缅緯纬緱缑緲缈練练緶缏緹缇緻致緼缊縈萦縉缙縊缢縋缒縐绉縑缣縕缊縗缞縛缚縝缜縞缟縟缛縣县縧绦縫缝縭缡縮缩縯𬙂縱纵縲缧縳䌸縴纤縵缦縶絷縷缕縹缥總总績绩繃绷繅缫繆缪繒缯織织繕缮繚缭繞绕繡绣繢缋繩绳繪绘繫系繭茧繮缰繯缳繰缲繳缴繶𫄷繸䍁繹绎繻𦈡繼继繽缤繾缱繿䍀纁𫄸纆𬙊纇颣纈缬纊纩續续纍累纏缠纓缨纔才纕𬙋纖纤纘缵纜缆缽钵罃䓨罈坛罌罂罎坛罰罚罵骂罷罢羅罗羆罴羈羁羋芈羣群羥羟羨羡義义羶膻習习翫玩翬翚翹翘翽翙耬耧耮耢聖圣聞闻聯联聰聪聲声聳耸聵聩聶聂職职聹聍聽听聾聋肅肃脅胁脈脉脛胫脣唇脩修脫脱脹胀腎肾腖胨腡脶腦脑腫肿腳脚腸肠膃腽膕腘膚肤膞䏝膠胶膢𦝼膩腻膽胆膾脍膿脓臉脸臍脐臏膑臘腊臚胪臟脏臠脔臢臜臥卧臨临臺台與与興兴舉举舊旧舖铺舘馆艙舱艤舣艦舰艫舻艱艰艷艳芻刍苧苎茲兹荊荆莊庄莖茎莢荚莧苋華华菴庵菸烟萇苌萊莱萬万萴荝萵莴葉叶葒荭葤荮葦苇葯药葷荤蒍𫇭蒐搜蒓莼蒔莳蒕蒀蒞莅蒼苍蓀荪蓆席蓋盖蓮莲蓯苁蓴莼蓽荜蔄𬜬蔔卜蔘参蔞蒌蔣蒋蔥葱蔦茑蔭荫蔯𫈟蔿𫇭蕁荨蕆蒇蕎荞蕒荬蕓芸蕕莸蕘荛蕢蒉蕩荡蕪芜蕭萧蕷蓣薀蕰薈荟薊蓟薌芗薑姜薔蔷薘荙薟莶薦荐薩萨薳䓕薴苧薵䓓薹苔薺荠藍蓝藎荩藝艺藥药藪薮藭䓖藴蕴藶苈藹蔼藺蔺蘀萚蘄蕲蘆芦蘇苏蘊蕴蘋苹蘚藓蘞蔹蘟𦻕蘢茏蘭兰蘺蓠蘿萝虆蔂虉𬟁處处虛虚虜虏號号虧亏虯虬蛺蛱蛻蜕蜆蚬蝀𬟽蝕蚀蝟猬蝦虾蝨虱蝸蜗螄蛳螞蚂螢萤螮䗖螻蝼螿螀蟄蛰蟈蝈蟎螨蟣虮蟬蝉蟯蛲蟲虫蟳𫊻蟶蛏蟻蚁蠁蚃蠅蝇蠆虿蠍蝎蠐蛴蠑蝾蠔蚝蠟蜡蠣蛎蠨蟏蠱蛊蠶蚕蠻蛮衆众衊蔑術术衕同衚胡衛卫衝冲袞衮袷夹裊袅裏里補补裝装裡里製制複复褌裈褘袆褲裤褳裢褸褛褻亵襀𫌀襇裥襉裥襏袯襖袄襝裣襠裆襤褴襪袜襬摆襯衬襲袭襴襕覈核見见覎觃規规覓觅視视覘觇覡觋覥觍覦觎親亲覬觊覯觏覲觐覷觑覺觉覽览覿觌觀观觴觞觶觯觸触訁讠訂订訃讣計计訊讯訌讧討讨訏𬣙訐讦訒讱訓训訕讪訖讫託托記记訛讹訝讶訟讼訢䜣訣诀訥讷訩讻訪访設设許许訴诉訶诃診诊註注証证詀𧮪詁诂詆诋詎讵詐诈詒诒詔诏評评詖诐詗诇詘诎詛诅詝𬣞詞词詠咏詡诩詢询詣诣試试詩诗詪𬣳詫诧詬诟詭诡詮诠詰诘話话該该詳详詵诜詷𫍣詼诙詿诖誄诔誅诛誆诓誇夸誌志認认誑诳誒诶誕诞誘诱誚诮語语誠诚誡诫誣诬誤误誥诰誦诵誨诲說说説说誰谁課课誶谇誹诽誼谊誾訚調调諂谄諄谆談谈諉诿請请諍诤諏诹諑诼諒谅諓𬣡論论諗谂諛谀諜谍諝谞諞谝諟𬤊諡谥諢诨諤谔諦谛諧谐諫谏諭谕諮咨諱讳諲𬤇諳谙諴𫍯諶谌諷讽諸诸諺谚諼谖諾诺謀谋謁谒謂谓謄誊謅诌謊谎謎谜謏𫍲謐谧謔谑謖谡謗谤謙谦謚谥講讲謝谢謠谣謡谣謨谟謫谪謬谬謭谫謳讴謹谨謾谩譁哗證证譎谲譏讥譓𬤝譖谮識识譙谯譚谭譜谱譞𫍽譟噪譫谵譭毁譯译議议譴谴護护譸诪譽誉譾谫讀读讅谉變变讋詟讌䜩讎雠讒谗讓让讕谰讖谶讚赞讜谠讞谳谿溪豈岂豎竖豐丰豔艳豬猪豶豮貍狸貓猫貙䝙貝贝貞贞貟贠負负財财貢贡貧贫貨货販贩貪贪貫贯責责貯贮貰贳貲赀貳贰貴贵貶贬買买貸贷貺贶費费貼贴貽贻貿贸賀贺賁贲賂赂賃赁賄贿賅赅資资賈贾賊贼賑赈賒赊賓宾賕赇賙赒賚赉賜赐賞赏賠赔賡赓賢贤賣卖賤贱賦赋賧赕質质賫赍賬账賭赌賰䞐賴赖賵赗賺赚賻赙購购賽赛賾赜贄贽贅赘贇赟贈赠贊赞贋赝贍赡贏赢贐赆贓赃贔赑贖赎贗赝贛赣贜赃赬赪趕赶趙赵趨趋趲趱跡迹踐践踰逾踴踊蹌跄蹕跸蹟迹蹠跖蹣蹒蹤踪蹺跷躂跶躉趸躊踌躋跻躍跃躎䟢躑踯躒跞躓踬躕蹰躚跹躡蹑躥蹿躦躜躪躏軀躯車车軋轧軌轨軍军軏𫐄軑轪軒轩軔轫軛轭軝𬨂軟软軤轷軫轸軲轱軸轴軹轵軺轺軻轲軼轶軾轼較较輄𨐈輅辂輇辁輈辀載载輊轾輋𪨶輒辄輓挽輔辅輕轻輗𫐐輛辆輜辎輝辉輞辋輟辍輥辊輦辇輩辈輪轮輬辌輮𫐓輯辑輳辏輶𬨎輸输輻辐輼辒輾辗輿舆轀辒轂毂轄辖轅辕轆辘轉转轍辙轎轿轔辚轟轰轡辔轢轹轤轳辦办辭辞辮辫辯辩農农迴回逕径這这連连週周進进遊游運运過过達达違违遙遥遜逊遞递遠远遡溯適适遲迟遶绕遷迁選选遺遗遼辽邁迈還还邇迩邊边邏逻邐逦郟郏郵邮鄆郓鄉乡鄒邹鄔邬鄖郧鄧邓鄩𬩽鄭郑鄰邻鄲郸鄳𫑡鄴邺鄶郐鄺邝酇酂酈郦醃腌醖酝醜丑醞酝醟蒏醣糖醫医醬酱醱酦醲𬪩釀酿釁衅釃酾釅酽釋释釐厘釒钅釓钆釔钇釕钌釗钊釘钉釙钋針针釣钓釤钐釦扣釧钏釩钒釴𬬩釵钗釷钍釹钕釺钎釾䥺釿𬬱鈀钯鈁钫鈃钘鈄钭鈅钥鈇𫓧鈈钚鈉钠鈍钝鈎钩鈐钤鈑钣鈒钑鈔钞鈕钮鈞钧鈡钟鈣钙鈥钬鈦钛鈧钪鈮铌鈰铈鈳钶鈴铃鈷钴鈸钹鈹铍鈺钰鈽钸鈾铀鈿钿鉀钾鉅巨鉆钻鉈铊鉉铉鉊𬬿鉋铇鉍铋鉑铂鉕钷鉗钳鉚铆鉛铅鉝𫟷鉞钺鉢钵鉤钩鉥𬬸鉦钲鉧𬭁鉬钼鉭钽鉮𬬹鉳锫鉶铏鉷𫟹鉸铰鉺铒鉻铬鉿铪銀银銃铳銅铜銈𫓯銍铚銑铣銓铨銖铢銘铭銚铫銛铦銜衔銠铑銣铷銥铱銦铟銨铵銩铥銪铕銫铯銬铐銱铞銳锐銶𨱇銷销銹锈銻锑銼锉鋁铝鋃锒鋅锌鋇钡鋌铤鋏铗鋐𬭎鋒锋鋗𫓶鋙铻鋝锊鋟锓鋣铘鋤锄鋥锃鋦锔鋨锇鋩铓鋪铺鋭锐鋮铖鋯锆鋰锂鋱铽鋶锍鋸锯鋹𬬮鋼钢錀𬬭錁锞錄录錆锖錇锫錈锩錏铔錐锥錒锕錕锟錘锤錙锱錚铮錛锛錞𬭚錟锬錠锭錡锜錢钱錤𫓹錦锦錨锚錩锠錫锡錮锢錯错録录錳锰錶表錸铼錼镎鍀锝鍁锨鍃锪鍅钫鍆钔鍇锴鍈锳鍊炼鍋锅鍍镀鍔锷鍘铡鍚钖鍛锻鍠锽鍤锸鍥锲鍩锘鍬锹鍭𬭤鍰锾鍵键鍶锶鍺锗鍼针鍾钟鎂镁鎄锿鎇镅鎊镑鎌镰鎓𬭩鎔镕鎖锁鎘镉鎚锤鎛镈鎝𨱏鎡镃鎢钨鎣蓥鎦镏鎧铠鎩铩鎪锼鎬镐鎭镇鎮镇鎰镒鎲镋鎳镍鎵镓鎶鿔鎸镌鎿镎鏃镞鏇旋鏈链鏌镆鏍镙鏏𬭬鏐镠鏑镝鏗铿鏘锵鏜镗鏝镘鏞镛鏟铲鏡镜鏢镖鏤镂鏨錾鏰镚鏵铧鏷镤鏹镪鏺䥽鏻𬭸鏽锈鐃铙鐄𨱑鐇𫔍鐋铴鐍𫔎鐏𨱔鐐镣鐒铹鐓镦鐔镡鐘钟鐙镫鐝镢鐠镨鐥䦅鐦锎鐧锏鐨镄鐩𬭼鐫镌鐮镰鐯䦃鐲镯鐳镭鐵铁鐶镮鐸铎鐺铛鐽𫟼鐿镱鑄铸鑊镬鑌镔鑑鉴鑒鉴鑔镲鑕锧鑞镴鑠铄鑣镳鑥镥鑪𬬻鑭镧鑰钥鑱镵鑲镶鑷镊鑹镩鑼锣鑽钻鑾銮鑿凿钁镢钂镋長长門门閂闩閃闪閆闫閈闬閉闭開开閌闶閎闳閏闰閑闲閒闲間间閔闵閘闸閡阂閣阁閤合閥阀閨闺閩闽閫阃閬阆閭闾閱阅閲阅閶阊閹阉閻阎閼阏閽阍閾阈閿阌闃阒闆板闇暗闈闱闉𬮱闊阔闋阕闌阑闍阇闐阗闑𫔶闒阘闓闿闔阖闕阙闖闯關关闞阚闠阓闡阐闢辟闤阛闥闼陘陉陝陕陞升陣阵陰阴陳陈陸陆陽阳隉陧隊队階阶隑𬮿隕陨際际隤𬯎隨随險险隮𬯀隯陦隱隐隴陇隸隶隻只雋隽雖虽雙双雛雏雜杂雞鸡離离難难雲云電电霑沾霢霡霧雾霽霁靂雳靄霭靆叇靈灵靉叆靚靓靜静靝靔靦腼靨靥鞏巩鞝绱鞦秋鞽鞒韁缰韃鞑韆千韉鞯韋韦韌韧韍韨韓韩韙韪韜韬韝鞲韞韫韻韵響响頁页頂顶頃顷項项順顺頇顸須须頊顼頌颂頍𫠆頎颀頏颃預预頑顽頒颁頓顿頔𬱖頗颇領领頜颌頠𬱟頡颉頤颐頦颏頫𫖯頭头頮颒頰颊頲颋頴颕頵𫖳頷颔頸颈頹颓頻频頽颓顆颗題题額额顎颚顏颜顒颙顓颛顔颜顗𫖮願愿顙颡顛颠類类顢颟顥颢顧顾顫颤顬颥顯显顰颦顱颅顳颞顴颧風风颭飐颮飑颯飒颱台颳刮颶飓颸飔颺飏颻飖颼飕飀飗飄飘飆飙飈飚飛飞飠饣飢饥飣饤飥饦飩饨飪饪飫饫飭饬飯饭飱飧飲饮飴饴飼饲飽饱飾饰飿饳餃饺餄饸餅饼餈糍餉饷養养餌饵餎饹餏饻餑饽餒馁餓饿餕馂餖饾餗𫗧餘余餚肴餛馄餜馃餞饯餡馅館馆餬糊餱糇餳饧餵喂餶馉餷馇餸𩠌餺馎餼饩餾馏餿馊饁馌饃馍饅馒饈馐饉馑饊馓饋馈饌馔饑饥饒饶饗飨饘𫗴饜餍饞馋饢馕馬马馭驭馮冯馱驮馳驰馴驯馹驲馼𫘜駁驳駃𫘝駉𬳶駐驻駑驽駒驹駓𬳵駔驵駕驾駘骀駙驸駛驶駝驼駟驷駡骂駢骈駪𬳽駭骇駰骃駱骆駸骎駼𬳿駿骏騁骋騂骍騄𫘧騅骓騊𫘦騌骔騍骒騎骑騏骐騑𬴂騖骛騙骗騞𬴃騠𫘨騤骙騧䯄騫骞騭骘騮骝騰腾騱𫘬騵𫘪騶驺騷骚騸骟騾骡驀蓦驁骜驂骖驃骠驄骢驅驱驊骅驌骕驍骁驎𬴊驏骣驕骄驗验驚惊驛驿驟骤驢驴驤骧驥骥驦骦驪骊驫骉骯肮髏髅髒脏體体髕髌髖髋髮发鬆松鬍胡鬚须鬢鬓鬥斗鬧闹鬨哄鬩阋鬮阄鬱郁鬹鬶魎魉魘魇魚鱼魛鱽魟𫚉魢鱾魨鲀魯鲁魴鲂魷鱿魺鲄鮀𬶍鮁鲅鮃鲆鮆𫚖鮈𬶋鮊鲌鮋鲉鮍鲏鮎鲇鮐鲐鮑鲍鮒鲋鮓鲊鮚鲒鮜鲘鮝鲞鮞鲕鮟𩽾鮠𬶏鮡𬶐鮣䲟鮦鲖鮪鲔鮫鲛鮭鲑鮮鲜鮳鲓鮶鲪鮸𩾃鮺鲝鯀鲧鯁鲠鯇鲩鯉鲤鯊鲨鯒鲬鯔鲻鯕鲯鯖鲭鯗鲞鯛鲷鯝鲴鯡鲱鯢鲵鯤鲲鯧鲳鯨鲸鯪鲮鯫鲰鯰鲶鯴鲺鯷鳀鯻𬶟鯽鲫鯿鳊鰁鳈鰂鲗鰃鳂鰆䲠鰈鲽鰉鳇鰊𬶠鰌䲡鰍鳅鰏鲾鰐鳄鰒鳆鰓鳃鰛鳁鰜鳒鰟鳑鰠鳋鰣鲥鰤𫚕鰥鳏鰧䲢鰨鳎鰩鳐鰭鳍鰮鳁鰱鲢鰲鳌鰳鳓鰵鳘鰶𬶭鰷鲦鰹鲣鰺鲹鰻鳗鰼鳛鰾鳔鱀𬶨鱂鳉鱅鳙鱇𩾌鱈鳕鱉鳖鱒鳟鱔鳝鱖鳜鱗鳞鱘鲟鱚𬶮鱝鲼鱟鲎鱠鲙鱣鳣鱤鳡鱧鳢鱨鲿鱭鲚鱯鳠鱲𫚭鱷鳄鱸鲈鱺鲡鳥鸟鳧凫鳩鸠鳬凫鳲鸤鳳凤鳴鸣鳶鸢鳾䴓鴆鸩鴇鸨鴉鸦鴒鸰鴕鸵鴛鸳鴝鸲鴞鸮鴟鸱鴣鸪鴦鸯鴨鸭鴯鸸鴰鸹鴴鸻鴷䴕鴻鸿鴿鸽鵁䴔鵂鸺鵃鸼鵏𬷕鵐鹀鵑鹃鵒鹆鵓鹁鵜鹈鵝鹅鵟𫛭鵠鹄鵡鹉鵪鹌鵬鹏鵮鹐鵯鹎鵰雕鵲鹊鵷鹓鵾鹍鶄䴖鶇鸫鶉鹑鶊鹒鶓鹋鶖鹙鶘鹕鶚鹗鶠𬸘鶡鹖鶥鹛鶩鹜鶪䴗鶬鸧鶯莺鶱𬸣鶲鹟鶴鹤鶹鹠鶺鹡鶻鹘鶼鹣鶿鹚鷀鹚鷁鹢鷂鹞鷄鸡鷉䴘鷊鹝鷓鹧鷖鹥鷗鸥鷙鸷鷚鹨鷟𬸦鷥鸶鷦鹪鷫鹔鷭𬸪鷯鹩鷲鹫鷳鹇鷴鹇鷸鹬鷹鹰鷺鹭鷽鸴鸂㶉鸇鹯鸊䴙鸌鹱鸏鹲鸑𬸚鸕鸬鸘鹴鸚鹦鸛鹳鸝鹂鸞鸾鹵卤鹹咸鹺鹾鹼碱鹽盐麗丽麥麦麩麸麪面麫面麬𤿲麯曲麳𪎌麴曲麵面麼么麽么黃黄黌黉點点黨党黲黪黴霉黶黡黷黩黽黾黿鼋鼂鼌鼉鼍鼕冬鼴鼹齊齐齋斋齎赍齏齑齒齿齔龀齕龁齗龂齘𬹼齙龅齜龇齟龃齠龆齡龄齣出齦龈齧啮齪龊齬龉齮𬺈齯𫠜齲龋齶腭齷龌齼𬺓龍龙龎厐龐庞龑䶮龔龚龕龛龜龟鿁䜤鿓鿒𠁞𠀾𠗣㓆𡃕𠴛𡅏𠲥𡑍𫭼𡑭𡋗𡓾𡋀𡔖𡍣𡞵㛟𡠹㛿𡢃㛠𡮉𡭜𡮣𡭬𡳳𡳃𡻕岁𡾱㟜𢣚𢘝𢶫𢫞𢹿𢬦𣈶暅𣙎㭣𣞻𣘓𣠩𣞎𣠲𣑶𣯶毶𣾷㳢𤁣𣺽𤅶𣷷𤓩𤊰𤪺㻘𤫩㻏𤳸𤳄𥊝𥅿𥌃𥅘𥕥𥐰𥖅𥐯𥗽𬒗𥢢䅪𥸠𥮋𥼽𥹥𦘧𡳒𦣎𦟗𦪙䑽𧜗䘞𧜵䙊𧝞䘛𧟀𧝧𧩙䜥𧵳䞌𧶧䞎𨊰䢀𨊸䢁𨋢䢂𨤻𨤰𨦫䦀𨧀𬭊𨧜䦁𨨏𬭛𨭆𬭶𨭎𬭳𨯅䥿𩞯䭪𩠴𩠠𩣑䯃𩶘䲞𰻞𰻝';
  /* 表里含 293 个非 BMP 字符（如 𠮶），它们在 UTF-16 里占**两个**码元 ——
     早先按「下标奇偶」配对的写法会在第一个非 BMP 字符之后整体错位：
     实测 3222 对里只有 1388 对能转对，而且会把「周」转成「進」这种**错转**
     （错位后取到了相邻对的第二个字），等于给曲名打分喂了噪音。
     所以改成先按**码点**成对解析成映射表，再逐字查；查不到原样保留。 */
  var _t2sMap = null;
  function t2sMap() {
    if (_t2sMap) return _t2sMap;
    _t2sMap = Object.create(null);
    for (var i = 0; i < T2S.length;) {
      var a = String.fromCodePoint(T2S.codePointAt(i));
      i += a.length;
      if (i >= T2S.length) break;                 // 表尾落单，忽略
      var b = String.fromCodePoint(T2S.codePointAt(i));
      i += b.length;
      if (_t2sMap[a] === undefined) _t2sMap[a] = b;
    }
    return _t2sMap;
  }
  function toSimplified(s) {
    if (!T2S) return s;
    var m = t2sMap();
    var out = '';
    for (var i = 0; i < s.length;) {
      var ch = String.fromCodePoint(s.codePointAt(i));
      i += ch.length;
      var simp = m[ch];
      out += (simp === undefined) ? ch : simp;
    }
    return out;
  }

  function normKey(s) {
    s = toSimplified(String(s == null ? '' : s).toLowerCase());
    s = s.replace(/[\(\[（【{].*?[\)\]）】}]/g, '');
    // 字符类必须含谚文（韩语标题/艺人在缺了它的情况下会被整串清空 → 相似度恒为 0，
    // 韩语曲目永远匹配不上；编码检测本身是支持 euc-kr 的）
    s = s.replace(/[^0-9a-z\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u1100-\u11ff]/g, '');
    return s;
  }

  /* 两个归一化名字的字符重合度（0~1），容忍「姚苏容/姚苏蓉」这类异写 */
  function shareRatio(a, b) {
    a = normKey(a); b = normKey(b);
    if (!a || !b) return 0;
    var ca = {}, cb = {}, common = 0, i;
    for (i = 0; i < a.length; i++) ca[a.charAt(i)] = (ca[a.charAt(i)] || 0) + 1;
    for (i = 0; i < b.length; i++) cb[b.charAt(i)] = (cb[b.charAt(i)] || 0) + 1;
    for (var k in cb) {
      if (ca[k]) common += Math.min(ca[k], cb[k]);
    }
    return common / Math.max(a.length, b.length);
  }

  /* 「01 - HOTEL CALIFORNIA」这类带轨号前缀的标题 */
  function cleanTitle(t) {
    return String(t || '').replace(/^\s*(?:\[\d+\]|\d{1,3})\s*[-._、)]\s*/, '');
  }

  /* 去掉 ()/[]/【】 及内容，并清掉结尾的 (1)(2) 计数 */
  function stripBrackets(t) {
    t = String(t || '').replace(/[\(\[（【{].*?[\)\]）】}]/g, ' ');
    t = t.replace(/\s*[\(\[（【]\d+[\)\]）】]\s*$/, '');
    return t.replace(/\s+/g, ' ').trim();
  }

  /* 「后弦 - 公主抱」→ { title:'公主抱', artist:'后弦' }（整轨 FLAC 的 TITLE 常这么写） */
  function splitTitleArtist(t, artist) {
    var s = String(t || '');
    // 无空格的连字符只在含中日韩文字时当分隔符（「周杰伦-晴天」这种写法）：
    // 英文标题里的连字符属于词本身（"Self-Control" 不能被切成 Self / Control，
    // 否则会拿"Control"去搜到同名歌、拿到错误歌词后提前收工）
    var cjk = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(s);
    var parts = s.split(cjk ? /\s*[-–—]\s*/ : /\s+[-–—]\s+/);
    if (parts.length < 2) return null;
    var a = parts[0].trim(), b = parts[1].trim();
    if (!a || !b) return null;
    if (a.length > 40 || b.length > 40) return null;
    // 哪边像歌手归哪边：先看与已知歌手的重合度，没有已知歌手就按「歌手 - 歌名」惯例
    if (artist) {
      if (shareRatio(a, artist) >= 0.6 && shareRatio(a, artist) >= shareRatio(b, artist)) {
        return { title: b, artist: a };
      }
      if (shareRatio(b, artist) >= 0.6) return { title: a, artist: b };
      return null;
    }
    return { title: b, artist: a };
  }

  /* 联想通道的条目没有 mid 之外的字段，不做深度归一；
     mediaMid / albummid 补空串，和 musicuHit 对齐格式 */
  function smartboxHit(it) {
    return {
      songmid: (it && it.mid) || '', title: (it && it.name) || '',
      singer: (it && it.singer) || '', album: '', interval: 0,
      mediaMid: '', albummid: ''
    };
  }

  function musicuHit(it) {
    return {
      songmid: (it && (it.mid || it.songmid)) || '',
      title: (it && (it.name || it.title)) || '',
      singer: typeof (it && it.singer) === 'string' ? it.singer : joinSinger(it && it.singer),
      album: (it && it.album && it.album.name) || '',
      interval: (it && it.interval) || 0,
      /* 封面反查用：mediaMid → albummid 映射（歌单导入链路依赖） */
      mediaMid: (it && it.file && it.file.media_mid) || '',
      albummid: (it && it.album && (it.album.mid || it.album.pmid)) || ''
    };
  }

  /* 多通道搜索：有 Cookie 打聚合（带时长可精确打分）+ 联想；无 Cookie 只用联想 */
  function qqSearch(title, artist, limit) {
    var kw = (title + (artist ? ' ' + artist : '')).trim();
    var jobs = [];
    if (getCookie()) {
      jobs.push(searchMusicu(kw, 1, limit || 8).then(function (list) {
        return list.map(musicuHit).filter(function (h) { return h.songmid; });
      }, function () { return []; }));
    }
    jobs.push(searchSmartbox(title).then(function (list) {
      return list.slice(0, limit || 8).map(smartboxHit).filter(function (h) { return h.songmid; });
    }, function () { return []; }));
    return Promise.all(jobs).then(function (groups) {
      var seen = {}, out = [];
      for (var g = 0; g < groups.length; g++) {
        var arr = groups[g] || [];
        for (var i = 0; i < arr.length && out.length < 12; i++) {
          var h = arr[i];
          if (h && !seen[h.songmid]) { seen[h.songmid] = 1; out.push(h); }
        }
      }
      return out;
    });
  }

  /* 优先「标题命中 + 歌手命中 + 时长吻合」，避免抓到翻唱 / 伴奏 */
  function scoreHit(h, title, artist, duration) {
    var s = 0;
    if (title) s += shareRatio(title, h.title) * 1.0;
    if (artist) s += shareRatio(artist, h.singer) * 0.6;
    if (duration > 0 && h.interval > 0) {
      var d = Math.abs(h.interval - duration);
      if (d <= 3) s += 1.2;
      else if (d <= 8) s += 0.4;
      else if (d <= 25) s += 0.1;
    }
    var low = (h.title + ' ' + h.singer).toLowerCase();
    if (/伴奏|remix|instrumental|纯音乐|off vocal/.test(low)) s -= 0.8;
    if (/伴奏|纯音乐|instrumental|off vocal/.test(String(h.title).toLowerCase())) s -= 99;
    return s;
  }

  function pickBest(hits, title, artist, duration) {
    var best = null, bestScore = -99;
    for (var i = 0; i < hits.length; i++) {
      if (!hits[i]) continue;
      var s = scoreHit(hits[i], title, artist, duration);
      if (s > bestScore) { bestScore = s; best = hits[i]; }
    }
    return best ? { hit: best, score: bestScore } : null;
  }

  /* 上游「这首歌没有歌词」的固定文案（不是失败，不需要重试） */
  var NO_LYRIC_RE = /纯音乐[，,]\s*请欣赏|此歌曲为没有填词的纯音乐|暂无歌词/;

  /* 拉歌词（nobase64=1 直接给明文；trans 是译文，追加在原文之后）。
     失败向上抛：网络异常与「上游说没有歌词」必须分开 —— 前者不能被缓存成
     「这首歌没歌词」，否则一次网络抖动会让这首歌半小时内一直显示暂无歌词。 */
  function qqLyric(songmid) {
    var qs = 'songmid=' + encodeURIComponent(songmid) +
             '&format=json&nobase64=1&g_tk=5381&loginUin=0&hostUin=0' +
             '&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=1';
    return getJson('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?' + qs, {
      ms: 10000, tag: 'lyric',
      referer: 'https://y.qq.com/portal/player.html'
    }).then(function (j) {
      // 应用层错误体（限流 / 风控，code 非 0 且没有歌词字段）按失败上抛：
      // 它会被 findLyric 的拒绝分支标记为 transient，而不是被缓存成「没有歌词」
      if (!j || (j.code != null && j.code !== 0) || (j.retcode != null && String(j.retcode) !== '0')) {
        throw new Error('歌词接口返回错误' + (j && j.code != null ? ' code=' + j.code : ''));
      }
      var text = (j && (j.lyric || j.lrc)) || '';
      var trans = (j && j.trans) || '';
      if (!text || NO_LYRIC_RE.test(text)) return '';       // 上游明确回「没有歌词」
      return trans ? (text + '\n\n' + trans) : text;
    });
  }

  /* 多轮放宽：raw → cleantitle → split → nobracket → titleonly */
  var LYRIC_TTL = 30 * 60 * 1000;
  var _lyricCache = {};
  var MIN_SCORE = 0.8;

  function findLyric(title, artist, duration) {
    var rounds = [
      { tag: 'raw', t: title, a: artist },
      { tag: 'cleantitle', t: cleanTitle(title), a: artist },
      { tag: 'split', sp: splitTitleArtist(title, artist) },
      { tag: 'nobracket', t: stripBrackets(title), a: artist },
      { tag: 'titleonly', t: cleanTitle(title), a: '' },
      { tag: 'titleonly2', t: title, a: '' }
    ];
    // 去重：相邻两轮若 (歌名, 歌手) 完全相同（如 cleanTitle 没改变标题、
    // 或 stripBrackets 与 cleanTitle 结果一致）就跳过，避免同一查询打两次网络
    var seen = {}, uniq = [];
    for (var ri = 0; ri < rounds.length; ri++) {
      var rr = rounds[ri];
      var kt = rr.sp ? (rr.sp.title + '\u0001' + rr.sp.artist) : (String(rr.t || '') + '\u0001' + String(rr.a || ''));
      if (seen[kt]) continue;
      seen[kt] = 1;
      uniq.push(rr);
    }
    rounds = uniq;
    var bestAll = null, notes = [];

    function runRound(i) {
      if (i >= rounds.length) return Promise.resolve(bestAll);
      var r = rounds[i];
      var st, sa;
      if (r.sp) {
        st = r.sp.title; sa = r.sp.artist;
      } else { st = r.t; sa = r.a; }
      st = String(st || '').trim();
      sa = String(sa || '').trim();
      if (!st) { notes.push(r.tag + '=0.0'); return runRound(i + 1); }

      return qqSearch(st, sa, 8).then(function (hits) {
        var picked = pickBest(hits, st, sa, duration);
        var score = picked ? picked.score : 0;
        notes.push(r.tag + '=' + score.toFixed(1));
        if (picked && (!bestAll || score > bestAll.score)) {
          bestAll = { hit: picked.hit, score: score, tag: r.tag };
        }
        if (picked && score >= MIN_SCORE) return bestAll;   // 足够好，提前收工
        return runRound(i + 1);
      });
    }

    return runRound(0).then(function (best) {
      if (!best || best.score < MIN_SCORE) {
        return { ok: false, lrc: '', note: best ? 'weak(' + best.tag + '=' + best.score.toFixed(1) + ')'
                                                 : 'no-hit(' + notes.join(',') + ')' };
      }
      return qqLyric(best.hit.songmid).then(function (lrc) {
        if (!lrc) return { ok: false, lrc: '', note: 'no-lyric(' + best.tag + ')' };
        return {
          ok: true, lrc: lrc,
          title: best.hit.title, singer: best.hit.singer, album: best.hit.album,
          songmid: best.hit.songmid, score: best.score, note: best.tag
        };
      }, function (e) {
        return { ok: false, lrc: '', transient: true,
                 note: 'lyric-err:' + ((e && e.message) || e) };
      });
    }, function (e) {
      return { ok: false, lrc: '', transient: true, note: 'search-err:' + ((e && e.message) || e) };
    });
  }

  /* 按「歌名 + 歌手」匹配一首歌（歌单导入用）：多轮放宽搜索 + 打分，
     与歌词匹配同一置信阈值，宁可漏配不可错配。
     轮次：原名 → 去括号 → 清轨号 → 只按歌名 → 只按清洁歌名 → 歌手歌名互换
     （容错「歌手 - 歌名」写反的行）。 */
  function matchSong(title, artist) {
    var base = String(title || '').trim();
    var rounds = [
      { t: base, a: artist },
      { t: stripBrackets(base), a: artist },
      { t: cleanTitle(base), a: artist },
      { t: cleanTitle(stripBrackets(base)), a: artist },
      { t: base, a: '' },
      { t: cleanTitle(stripBrackets(base)), a: '' }
    ];
    if (artist) rounds.push({ t: String(artist).trim(), a: base, swap: true });   // 写反的行
    var best = null;
    function runRound(i) {
      if (i >= rounds.length) return Promise.resolve(best);
      var r = rounds[i];
      var st = String(r.t || '').trim();
      var sa = String(r.a || '').trim();
      if (!st) return runRound(i + 1);
      return qqSearch(st, sa, 8).then(function (hits) {
        var picked;
        if (r.swap) {
          /* 写反的行：按 歌手↔歌名 互换方向打分（权重与常规轮一致，防止只对上歌手就误配同歌手的其他歌） */
          for (var k = 0; k < hits.length; k++) {
            if (!hits[k]) continue;
            var s = shareRatio(st, hits[k].singer) * 0.6 + shareRatio(sa, hits[k].title) * 1.0;
            if (!picked || s > picked.score) picked = { hit: hits[k], score: s };
          }
        } else {
          picked = pickBest(hits, st, sa, 0);
        }
        if (picked && picked.score >= MIN_SCORE) {
          best = {
            songmid: picked.hit.songmid,
            title: picked.hit.title, singer: picked.hit.singer,
            mediaMid: picked.hit.mediaMid || '',
            albummid: picked.hit.albummid || '',
            score: picked.score
          };
          return best;                                   // 达标即收工
        }
        return runRound(i + 1);
      });
    }
    return runRound(0);
  }

  function lyric(title, artist, duration) {
    title = String(title || '').trim();
    duration = duration | 0;
    if (!title) return Promise.resolve({ ok: false, lrc: '', note: 'empty-title' });
    var key = [title, artist || '', duration].join('\u001f');
    var cached = _lyricCache[key];
    if (cached && (Date.now() - cached.ts) < LYRIC_TTL) {
      var r0 = cached.r;
      return Promise.resolve(Object.assign({}, r0, { cached: true }));
    }
    var err0 = _netErr;
    return findLyric(title, artist, duration).then(function (r) {
      /* 没匹配上、但期间有通道是网络失败 → 这次结果不可信，不进负缓存
         （否则一次网络抖动 = 这首歌半小时内一直「暂无歌词」） */
      if (!r.ok && _netErr > err0) r.transient = true;
      if (!r.transient) {
        _lyricCache[key] = { ts: Date.now(), r: r };
        cacheTrim(_lyricCache);
      }
      return r;
    });
  }

  function lyricCacheClear() { _lyricCache = {}; return true; }

  /* ------------------------------------------------------------
   * 封面 / 配置 / 诊断
   * ---------------------------------------------------------- */
  function coverUrl(albummid) {
    albummid = String(albummid || '');
    return albummid ? 'https://y.gtimg.cn/music/photo_new/T002R500x500M000' + albummid + '.jpg' : '';
  }

  /* 在线封面下载（异步宿主 HTTP + 会话缓存）
     ------------------------------------------------------------
     artwork-resolver 的封面兜底从这里取图：把下载/缓存/异步都收在
     QQ 模块里，那边只管调用。

     · 必须异步：async:false 下载一张封面会把 foobar 主线程冻住
       整个下载时长（实测 3 张 1.2 秒），列表每重绘一次就冻一次。
     · 必须缓存：同一首歌/专辑反复取图（切歌、翻页、重渲染）不该重复下载。
     · 失败降级返回 CDN 原始 URL：<img> 仍能显示封面，只是取色会因
       CORS 失败（好过看不到封面）。失败结果也缓存，避免反复重试。
     ---------------------------------------------------------- */
  var coverCache = Object.create(null);            // mediaMid -> dataURL | 原始 URL | ''
  var coverPending = Object.create(null);          // mediaMid -> Promise
  var COVER_CACHE_MAX = 30;

  function coverCacheTrim() {
    var keys = Object.keys(coverCache);
    if (keys.length <= COVER_CACHE_MAX) return;
    for (var i = 0; i < (keys.length >> 1); i++) delete coverCache[keys[i]];
  }

  /* mediaMid -> 封面（dataURL；拿不到时 ''，下载失败时 CDN 原始 URL） */
  function coverDataUrl(mediaMid) {
    mediaMid = String(mediaMid || '');
    if (!mediaMid) return Promise.resolve('');
    if (coverCache[mediaMid] !== undefined) return Promise.resolve(coverCache[mediaMid]);
    if (coverPending[mediaMid]) return coverPending[mediaMid];

    var mid = mediaCover(mediaMid);
    var url = mid ? coverUrl(mid) : '';
    /* 映射还没记下来（搜索后、播放前就会发生）不缓存：
       rememberMediaCovers 之后必须还能查到，否则''会一直poison到会话结束 */
    if (!url) return Promise.resolve('');

    var p = hostHttp({
      url: url, responseType: 'binary',
      headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' },
      ms: 10000, tag: 'cover'
    }).then(function (r) {
      var ct = 'image/jpeg';                     // y.gtimg.cn 封面固定 JPEG
      var h = r.headers || {};
      var ctKey = h['content-type'] || h['Content-Type'];
      if (ctKey) ct = ctKey;
      if (r.status >= 200 && r.status < 300 && r.body) return 'data:' + ct + ';base64,' + r.body;
      return url;                                // 状态码不对：退回原始 URL 让 <img> 试
    }, function () {
      return url;                                // 下载失败：退回原始 URL 让 <img> 试
    }).then(function (v) {
      delete coverPending[mediaMid];
      coverCache[mediaMid] = v;
      coverCacheTrim();
      return v;
    }).catch(function () {
      // 兜底：任何意外异常都不能让 coverPending 留下悬空条目 ——
      // 留下了这张专辑以后就再也取不到封面（同一个 promise 永远复用）
      delete coverPending[mediaMid];
      return url;
    });
    coverPending[mediaMid] = p;
    return p;
  }
  function coverCacheClear() {
    coverCache = Object.create(null);
    coverPending = Object.create(null);
    return true;
  }

  function config() {
    return { version: VERSION, hasCookie: !!getCookie(), quality: getQuality() };
  }

  function bridgeInfo() {
    return {
      version: VERSION,
      hasCookie: !!getCookie(),
      cookieUin: cookieUin(),
      quality: getQuality(),
      guid: guid(),
      streamCache: Object.keys(_streamCache).length,
      lyricCache: Object.keys(_lyricCache).length,
      midCache: Object.keys(_midCache).length,
      coverCache: Object.keys(coverCache).length,
      inflight: inflightCount(),
      netErrors: _netErr
    };
  }

  /* ------------------------------------------------------------
   * 导出
   * ---------------------------------------------------------- */
  window.QQBridge = {
    version: VERSION,
    config: config,
    setQuality: setQuality, getQuality: getQuality,
    getCookie: getCookie, setCookie: setCookie, clearCookie: clearCookie,
    search: search,
    resolveStream: resolveStream,
    refreshUrl: refreshUrl,
    resolveMany: resolveMany,
    lyric: lyric, lyricCacheClear: lyricCacheClear,
    /* 按 songmid 精确取词：候选列表点选时用（已知 mid 就别再靠"标题+歌手"模糊匹配） */
    lyricById: qqLyric,
    matchSong: matchSong,
    coverUrl: coverUrl,
    coverDataUrl: coverDataUrl, coverCacheClear: coverCacheClear,
    rememberMediaCovers: rememberMediaCovers,
    mediaCover: mediaCover,
    mediaMidFromUrl: mediaMidFromUrl,
    pathIssuedAt: pathIssuedAt,
    pathExpiresAt: pathExpiresAt,
    /* 直链 → 歌名/歌手（主题取名用；也方便在控制台里核对映射有没有记上） */
    onlineName: onlineName,
    /* 繁→简对照表对外公开：网易云桥接（netease-core.js）拿它归一化曲名，
       免得同一张几千字的表在两个模块里各存一份 */
    toSimplified: toSimplified,
    netErrors: netErrs,
    bridgeInfo: bridgeInfo
  };
})();
