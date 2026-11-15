/* ============================================================
 * CloudMusic 主题扩展 · 网易云音乐页内桥接（netease-core.js）
 * ------------------------------------------------------------
 * 与 js/qqmusic-core.js 同构的**页内桥接**：
 *   · 没有本地进程 / 端口 / 开关脚本，随主题页加载，随 foobar 启动而在；
 *   · 上游 HTTP 全部走宿主 foo_ui_webview2 的原生客户端（无 CORS）；
 *   · 一律 async:true + http:response 事件 + http.abort 超时（同 QQ 桥接：
 *     async:false 会让宿主在自己的 UI 线程上做完整个请求，请求多慢 foobar
 *     主窗口就假死多久）；
 *   · Cookie / 音质 / 直链↔曲目映射存 localStorage，随 WebView2 配置持久化。
 *
 * 上游接口（2026-10-06 实测，**全部免签名**，不需要 AES/RSA 那套 weapi/eapi）：
 *
 *   搜索   POST https://music.163.com/api/cloudsearch/pc
 *          s / type=1 / offset / limit / total=true（表单编码）
 *          → result.songs[] 自带 id、name、ar[]、al{name,picUrl}、dt(毫秒)、
 *            fee、privilege{pl,plLevel,dlLevel,maxBrLevel}
 *          免登录可用，而且**响应直接带封面直链**（不需要 picId 加密换算）。
 *   搜索兜底 GET /api/search/get/web?s=&type=1&offset=&limit=
 *          无封面字段，cloudsearch 被限流时用。
 *   直链   GET  https://music.163.com/api/song/enhance/player/url?ids=[..]&br=320000
 *          **批量**：实测一次 20 首 161ms。返回每首的**实际**档位 —— 要不到的
 *          档位会自动降级而不是报错（匿名请求无损会拿到 320K MP3），所以音质
 *          一律以返回的 level/br 为准回填，不按请求值假设。
 *          freeTrialInfo 非空 = 会员曲目的 30/45 秒试听切片，**必须过滤**：
 *          接口照样给一个能播的 URL，不理它 foobar 歌单里就会混进 30 秒的歌。
 *   歌词   GET  https://music.163.com/api/song/lyric?id=&lv=1&kv=1&tv=-1
 *          → lrc.lyric 原文 + tlyric.lyric 译文（同刻时间戳，直接追加在原文
 *            之后，交给主题的「同刻归组」配对成主/副行）；rv=1 另给 romalrc。
 *   歌单   GET  https://music.163.com/api/v6/playlist/detail?id=&n=1000&s=8
 *          公开歌单 / 官方榜单免 Cookie 直接读全曲目，每条带 al.picUrl ——
 *          所以这里**不需要** QQ 那套「导出脚本 + 文本匹配」。
 *   封面   https://p*.music.126.net/….jpg?param=500y500
 *          无防盗链（无 Referer / 任意 Referer 都 200），param 把原图 5MB
 *          压到 328KB，可以直接给 <img>。
 *
 * 为什么无损能在线流播了（2026-10-24 定位到真凶，详见 streamQuality 注释）：
 *   「foobar 按响应头 Content-Type 选解码器」只对了一半——audio/mpeg 标错
 *   会让 FLAC 打不开；但换对 mime 也不够，**http 明文**的 FLAC 在 foobar 里
 *   停滞在 ~0.5 秒（本机 HTTP 服务器发同一份字节却完美流播）。**换 https 后
 *   完全正常**（时长 / 实时进度 / seek 实测 3 分多钟精确实时）。所以无损直链
 *   交给宿主前经 streamifyUrl 整理成「https + 非 audio/mpeg 镜像」（探测把关），
 *   过不了关回落 320K MP3。音质下拉框同时作用于在线播放与下载。
 *
 * 链接过期：网易云 CDN **不校验查询串签名**（实测把 vuutv / authSecret 删掉
 *   或改成假值都照常 206），接口里的 expi=1200 只是建议缓存时长。稳妥起见仍按
 *   「播放失败回页面重新勾选」设计（和 QQ 页一致）。
 *
 * 会员：免费曲库免登录（多为 128K，部分 320K）；无损 / 会员曲目需要 Cookie。
 *   注意 **MUSIC_U 是 HttpOnly** —— 浏览器控制台里 copy(document.cookie) 拿不到
 *   它，登录态必须从开发者工具的请求头/存储里复制，见 UI 里的说明。
 *
 * 导出（window.NeteaseBridge）：见文件末尾。
 * ============================================================ */

(function () {
  'use strict';

  var VERSION = '1.0.0';
  var SITE = 'https://music.163.com';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  /* ------------------------------------------------------------
   * 宿主 HTTP（异步）—— 与 js/qqmusic-core.js 同一套：
   * async:false 会把 foobar 主窗口冻住整个请求时长，必须用
   * async:true + http:response 事件，超时用 http.abort 真取消。
   * responseType:'binary' 也要给：音频/图片字节按 UTF-8 序列化会直接报错，
   * 异步模式下连事件都不发（请求凭空消失）。
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
        // 宿主忽略 async、当场回了全量：直接当最终回包用
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

  /* ------------------------------------------------------------
   * 配置：Cookie / 音质 / 直链映射（localStorage）
   * ---------------------------------------------------------- */
  var LS_COOKIE = 'cm.netease.cookie';
  var LS_QUALITY = 'cm.netease.quality';
  var LS_URLMETA = 'cm.netease.urlmeta';

  function lsGet(k) {
    try { return localStorage.getItem(k) || ''; } catch (e) { return ''; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function lsDel(k) {
    try { localStorage.removeItem(k); } catch (e) {}
  }

  /* 匿名请求也要带的一对方便键：实测不带 Cookie 头也能搜、能解析，
     但带上 appver/os 更接近客户端，减小被风控的概率。 */
  var BASE_COOKIE = 'appver=8.9.70; os=pc';

  /* 只留与登录态/接口有关的键：从 DevTools 里复制出来的整串通常混着
     Hm_lvt_* / HMACCOUNT 这类统计 Cookie，全塞进请求头只会让头部变长 */
  var KEEP_COOKIE = { MUSIC_U: 1, __csrf: 1, NMTID: 1, __remember_me: 1, MUSIC_A: 1, _ntes_nuid: 1 };

  /* 粘贴内容容错：既接受裸 Cookie 串，也接受
     「Copy as cURL」出来的一整条命令（-H 'cookie: …'），
     还接受从 DevTools 应用面板里整行复制的 "Cookie: xxx"。 */
  function parseCookieInput(raw) {
    /* Windows cmd 的 curl 会写成 `-b ^"NMTID=…^"`（每个引号前一个 ^），
       先把 caret 全部去掉，否则第一个键会变成 `^"NMTID`、整条被当成解析失败。
       （PowerShell / bash 的 `Copy as cURL` 没有这层转义，去掉也不影响。） */
    var s = String(raw || '').replace(/\^/g, '');
    var m = /cookie\s*:\s*([^'"]+)/i.exec(s);
    if (m) s = m[1];
    var out = [], seen = {};
    s.split(/[;\n\r]+/).forEach(function (part) {
      var i = part.indexOf('=');
      if (i <= 0) return;
      // 键前面可能还挂着整条 curl（`curl 'url' -b 'MUSIC_U=…`）/ 引号 / caret 残留：
      // 取最后一个由空白或引号分隔的片段就是 Cookie 名
      var k = part.slice(0, i).trim().split(/[\s'"]+/).pop().replace(/^[^A-Za-z0-9_]+/, '');
      var v = part.slice(i + 1).trim().replace(/^["']+|["']+$/g, '');
      if (!/^[A-Za-z0-9_]+$/.test(k) || !v) return;
      if (!KEEP_COOKIE[k] || seen[k]) return;
      seen[k] = 1;
      out.push(k + '=' + v);
    });
    return out.join('; ');
  }

  function getCookie() { return lsGet(LS_COOKIE).trim(); }
  function setCookie(ck) {
    var parsed = parseCookieInput(ck);
    /* 解析不出东西按"清除"处理，但必须返回 false：clearCookie() 回的是 true，
       直接 `return clearCookie()` 会让调用方把"什么都没存下"当成保存成功，
       提示变成"已保存但账号接口不认"，用户完全猜不到原 Cookie 已被清掉。 */
    if (!parsed) { clearCookie(); return false; }
    lsSet(LS_COOKIE, parsed);
    return /(?:^|;\s*)MUSIC_U=/.test(parsed);     // 返回是否含登录态
  }

  /* 删键而不是写空串：留一个空键会让"到底清没清"看不出来 */
  function clearCookie() { lsDel(LS_COOKIE); return true; }
  function hasLogin() { return /(?:^|;\s*)MUSIC_U=/.test(getCookie()); }

  function cookieHeader() {
    var ck = getCookie();
    return ck ? (BASE_COOKIE + '; ' + ck) : BASE_COOKIE;
  }

  /* ------------------------------------------------------------
   * 音质表
   * ------------------------------------------------------------
   * 档位名用网易云自己的 level 命名（接口返回的 level 字段就是这几个），
   * br 是「普通直链接口」的参数值。请求高档位拿不到会自动降级，所以
   * **以返回的 level/br 为准**，见 RESOLVED_LEVEL_LABEL。
   * ---------------------------------------------------------- */
  var QUALS = ['standard', 'higher', 'exhigh', 'lossless', 'hires'];
  var QUAL_INFO = {
    standard: { br: 128000, label: '标准 128K' },
    higher: { br: 192000, label: '较高 192K' },
    exhigh: { br: 320000, label: '极高 320K' },
    lossless: { br: 999000, label: '无损 FLAC' },
    hires: { br: 1999000, label: 'Hi-Res' }
  };
  var LEVEL_LABEL = {
    standard: '128K MP3', higher: '192K MP3', exhigh: '320K MP3',
    lossless: '无损 FLAC', hires: 'Hi-Res', jyeffect: '空间音频',
    sky: '沉浸环绕', dolby: '杜比全景声', jymaster: '超清母带'
  };

  function normQuality(q) {
    q = String(q || '').toLowerCase();
    return QUAL_INFO[q] ? q : 'lossless';
  }
  function getQuality() { return normQuality(lsGet(LS_QUALITY) || 'lossless'); }
  function setQuality(q) { lsSet(LS_QUALITY, normQuality(q)); return getQuality(); }

  /* streamQuality() —— 在线**播放**用的档位（下载用用户选的档位，见 ui-netease）
     ------------------------------------------------------------
     演进史（都是实测，别再走回头路）：
     · 2026-10-23 第 15 轮：登录后无损直链能拿到，但 foobar 播不了 → 第 12 轮
       曾把播放封顶 320K（streamQuality 把 lossless/hires 压成 exhigh）。
       当时把原因记成「FLAC 直链被标成 audio/mpeg，foobar 按类型选解码器拒解」。
     · 2026-10-24 第 21 轮（会员账号 + MCP 直控 foobar 逐项 A/B）定位到**真凶**：
       - 「标错类型拒解」只对了一半：audio/mpeg 确实会让 foobar 选错解码器；
         但把 mime 换对（octet-stream）也**不够**——http 明文的 FLAC 照样停滞
         在 ~0.5 秒（curl 同 URL 全速 10MB/s；本机 HTTP 服务器发同一份字节、
         同样的 mime 却完美流播）。foobar 的**明文 HTTP 读取路径**与网易云 CDN
         在 FLAC 上的服务行为不兼容。
       - **https 完全正常**：同一条直链把 `http://` 换成 `https://`，时长、
         实时进度、seek 全部正常（实测连续 3 分多钟精确实时）。以前所有轮次
         测的都是网易云 API 返回的 http 直链，从未试过换协议交付。
       - 网易云各镜像对 Content-Type 的标注不一致（第 15 轮只测到 m701/m801）：
         m701/m801 标 audio/mpeg，m704/m804 标 application/octet-stream。
     · 结论：无损流播 = https + 非 audio/mpeg 的镜像（streamifyUrl 探测把关，
       过不了关回落 320K）。本函数恢复为「跟随用户档位」。
       · 2026-11-15 复测（第三十五轮，起因：用户反馈 VIP 曲拿到 320K）：CDN 的
         vuutv 签名已绑定 host —— 把 m7/m8 的直链改写到任何镜像一律 400/403/404
         （改写这条路死了）；但**能否无损流播本来就看 CDN 分桶**：m804 等桶原生
         下发的直链标 octet-stream，https 化即过闸（晴天/起风了/乌梅子酱实测全过）；
         ymusic 老桶（m7/m8，如求佛）把 .flac 标成 audio/mpeg —— 过不了闸回落
         320K。「audio/mpeg → MP3 解码器 → 必死」这道关当轮复确认仍然成立：把
         https+audio/mpeg 的 flac 直塞宿主，缓冲 ~5 秒后跳歌（audio.getStreamInfo
         报 codec=MP3 bitrate=320 才是终审，播放位置短暂推进只是缓冲，别被骗）。 */
  function streamQuality() {
    return getQuality();
  }

  /* 这条直链能不能直接交给宿主**流播**：只有**旧形态**（http 明文）的 FLAC
     直链不能（实测停滞，见 streamifyUrl 的注释）。老歌单里的 FLAC 行靠这个
     判定在播放前经 refreshUrl 重解析成 https 可流播直链；https 形态本身就能
     流（streamifyUrl 产出的一定是探测过的）。playback-model 的 pathFreshness
     把 true 当成"已过期"触发重解析。 */
  function needStreamRefetch(u) {
    var raw = String(u || '');
    var s = raw.split('?')[0].toLowerCase();
    return (/\.flac$/.test(s)) && /^http:\/\//i.test(raw);
  }

  /* 诊断：宿主拿到这条直链时，服务器到底回了什么（DevTools 里可调）。
     用法：NeteaseBridge.probeStream('http://…/xxx.flac?auth=…')
     回 { status, contentType, acceptRanges, contentLength, firstBytes, isFlac }：
     · isFlac=true 表示字节确实是 FLAC（开头 66 4c 61 43 = "fLaC"）；
     · contentType 是服务器给 foobar 的格式提示 —— foobar 的 HTTP reader 主要
       按它选解码器，标错就会出现"能播 FLAC 的播放器却报不支持的格式"。 */
  function probeStream(u, ms) {
    if (!/^https?:\/\//i.test(String(u || ''))) return Promise.reject(new Error('需要一个 http(s) 直链'));
    return hostHttp({
      url: u, responseType: 'binary', ms: ms || 15000, tag: 'probe',
      headers: { Range: 'bytes=0-15' }
    }).then(function (r) {
      var b64 = (r && r.body) || '';
      var bytes = [], hex = '';
      try {
        if (typeof atob === 'function') {
          var bin = atob(b64);
          for (var i = 0; i < Math.min(16, bin.length); i++) {
            bytes.push(bin.charCodeAt(i));
            hex += ('0' + bin.charCodeAt(i).toString(16)).slice(-2) + ' ';
          }
        }
      } catch (e) {}
      var hh = (r && r.headers) || {};
      function h(name) { return hh[name] || hh[name.toLowerCase()] || ''; }
      var info = {
        status: (r && r.status) || 0,
        contentType: h('Content-Type'),
        acceptRanges: h('Accept-Ranges'),
        contentLength: h('Content-Length'),
        firstBytes: hex.trim(),
        isFlac: bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43
      };
      try { console.log('[NeteaseBridge] probeStream', String(u).slice(0, 140), info); } catch (e) {}
      return info;
    });
  }

  /* 无损直链 → foobar **能流播**的形态；整理不出来返回 ''（调用方回落 320K）。
     两道关（见 streamQuality 注释里的实测）：① 换 https（明文 http 的 FLAC
     停滞）；② Content-Type 不能是 audio/mpeg（foobar 按它选解码器，flac 会被
     派给 MP3 解码器）。用 probeStream 探 16 字节把关，原 host 不行再试镜像。
     注意：2026-11-15 起签名绑定 host，镜像改写全部 400 —— 这条链只对"原生就
     下发到好桶（如 m804，标 octet-stream）"的直链有意义，坏桶（ymusic/m7/m8，
     标 audio/mpeg）无解，只能如实回落 320K；镜像表留作原 host 形态变化的保险。 */
  var STREAM_MIRRORS = ['m804', 'm704'];
  function probeStreamable(u) {
    return probeStream(u).then(function (p) {
      if (!p || !(p.status === 200 || p.status === 206)) return false;
      var ct = String(p.contentType || '').toLowerCase();
      // octet-stream / audio/flac 都行——foobar 对非 audio/mpeg 的响应做内容嗅探，
      // 实测都能认出 fLaC 并正常流播；唯独 audio/mpeg 会被派给 MP3 解码器
      return ct.indexOf('audio/mpeg') < 0;
    }, function () { return false; });
  }
  function streamifyUrl(url) {
    var u = String(url || '');
    if (!/\.flac(\?|$)/i.test(u)) return Promise.resolve(u);
    var httpsU = u.replace(/^http:\/\//i, 'https://');
    return probeStreamable(httpsU).then(function (ok) {
      if (ok) return httpsU;
      var host = (/\/\/([^/]+)\//.exec(u) || [])[1] || '';
      var cands = STREAM_MIRRORS
        .filter(function (m) { return host.indexOf(m) < 0; })
        .map(function (m) { return httpsU.replace(/\/\/[^/]+\//, '//' + m + '.music.126.net/'); });
      var chain = Promise.resolve('');
      cands.forEach(function (cand) {
        chain = chain.then(function (found) {
          return found ? found : probeStreamable(cand).then(function (ok2) { return ok2 ? cand : ''; });
        });
      });
      return chain;
    });
  }

  /* 解析结果收尾：flac 直链整理成可流播形态；整理不出来且 forStream（在线播放）
     时回落 320K MP3 —— 别把一首注定停滞的 FLAC 交给宿主（foobar 会停在
     ~0.5 秒然后跳歌）。下载路径（forStream=false）整理不出也**保留 flac 原链**：
     落盘走宿主 http.download，与流播无关，用户选的无损档必须如实给。 */
  function downgrade320(id) {
    function one(anonymous) {
      return resolveChunk([id], 'exhigh', anonymous).then(function (list) {
        var rv = (list || [])[0];
        return (rv && rv.url && !rv.trial) ? rv : null;
      });
    }
    return one(false).then(function (rv) {
      return rv || (hasLogin() ? one(true) : Promise.resolve(null));
    }, function () {
      return hasLogin() ? one(true) : Promise.resolve(null);
    });
  }
  function finishStreamRv(rv, forStream) {
    if (!rv || !rv.url || !/\.flac(\?|$)/i.test(rv.url)) return Promise.resolve(rv);
    return streamifyUrl(rv.url).then(function (u2) {
      if (u2) { rv.url = u2; return rv; }
      if (!forStream) return rv;
      return downgrade320(rv.id).then(function (rv2) {
        return rv2 || { id: rv.id, url: null, streamFail: true };
      });
    });
  }

  /* ------------------------------------------------------------
   * 基础请求
   * ---------------------------------------------------------- */
  var _netErr = 0;                                  // 网络/接口失败计数（区分"没匹配到"与"连不上"）
  function netErrs() { return _netErr; }

  function neHeaders(opt) {
    var headers = {
      'User-Agent': UA,
      Referer: SITE + '/',
      /* opt.anonymous：**故意不带登录 Cookie**（只留 appver/os）。
         用于「登录态拿不到、匿名却能拿到」的兜底重试 —— 用户实测过：同一首
         歌不登录能听，登录之后反而听不了（Cookie 失效 / 账号受限 / 服务端按
         账号判定都会这样）。 */
      Cookie: (opt && opt.anonymous) ? BASE_COOKIE : cookieHeader()
    };
    if (opt && opt.headers) {
      for (var k in opt.headers) {
        if (Object.prototype.hasOwnProperty.call(opt.headers, k)) headers[k] = opt.headers[k];
      }
    }
    return headers;
  }

  /* 一次请求 → { status, headers, body }（headers 也带回来，便于诊断） */
  function neRequest(path, opt) {
    opt = opt || {};
    return hostHttp({
      method: opt.method || 'GET',
      url: /^https?:/i.test(path) ? path : (SITE + path),
      body: opt.body,
      headers: neHeaders(opt),
      ms: opt.ms || 15000,
      tag: opt.tag || 'ne'
    }).then(function (r) { return r; }, function (e) {
      _netErr++;
      throw e;
    });
  }

  function getJson(path, opt) {
    return neRequest(path, opt).then(function (r) {
      try {
        return JSON.parse(r.body);
      } catch (e) {
        /* 解析失败同样是"这次没问成"：不计数的话，一次抖动（宿主回空体 /
           网关回 HTML）会被 findLyric 当成权威的"没有歌词"缓存 30 分钟。
           QQ 桥接的各个搜索通道也是这个口径（_netErr++ 后才返回空数组）。 */
        _netErr++;
        throw new Error('返回不是 JSON（HTTP ' + (r.status || '?') + '）');
      }
    });
  }


  function postForm(path, body, ms, tag) {
    return getJson(path, {
      method: 'POST',
      body: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      ms: ms || 15000,
      tag: tag || 'ne-post'
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ------------------------------------------------------------
   * 账号 / 会员
   * ---------------------------------------------------------- */
  function account() {
    if (!hasLogin()) return Promise.resolve({ ok: false, loggedIn: false });
    return getJson('/api/nuser/account/get', { ms: 8000, tag: 'account' }).then(function (j) {
      var p = j && j.profile;
      if (!p) return { ok: false, loggedIn: true };              // Cookie 在但接口不认（多半失效了）
      return { ok: true, loggedIn: true, nickname: p.nickname || '',
               userId: p.userId || 0, vipType: p.vipType || 0 };
    }, function () {
      return { ok: false, loggedIn: true, error: '账号接口不可用' };
    });
  }

  /* 会员到期时间（黑胶 VIP / 音乐包任一生效即视为会员） */
  function vipInfo() {
    if (!hasLogin()) return Promise.resolve({ vip: false });
    return getJson('/api/music-vip-membership/client/vip/info', { ms: 8000, tag: 'vip' })
      .then(function (j) {
        var d = (j && j.data) || {};
        var now = Date.now();
        function alive(x) { return !!(x && x.expireTime && x.expireTime > now); }
        var a = d.associator, m = d.musicPackage;
        var exp = Math.max((a && a.expireTime) || 0, (m && m.expireTime) || 0);
        return { vip: alive(a) || alive(m), expire: exp,
                 assoc: !!(a && a.expireTime), pack: !!(m && m.expireTime),
                 redVipLevel: d.redVipLevel || 0 };
      }, function () {
        return { vip: false, error: '会员接口不可用' };
      });
  }

  /* ------------------------------------------------------------
   * 搜索
   * ------------------------------------------------------------
   * 网易云的搜索接口有**显式限流**（实测连打 10 次就回 code=406
   * 「操作频繁，请稍候再试」，约 15 秒自行恢复；限流只作用于搜索 ——
   * 同一时刻直链/歌词/封面接口全部照常）。所以这里做了两件事：
   *   1) 串行化 + 最小间隔：同一时刻只有一个搜索在飞，两次之间隔 SEARCH_GAP；
   *   2) 被限流后进入冷却（LIMIT_COOLDOWN），冷却期内不再打接口而是直接
   *      报「稍后再试」，避免越点越久。
   * ---------------------------------------------------------- */
  var SEARCH_GAP = 1200;
  var LIMIT_COOLDOWN = 12000;
  var _searchQ = Promise.resolve();
  var _lastSearchAt = 0;
  var _limitedUntil = 0;

  function rateLimitErr() {
    var sec = Math.max(1, Math.ceil((_limitedUntil - Date.now()) / 1000));
    var e = new Error('网易云请求过于频繁，请等 ' + sec + ' 秒再搜');
    e.limited = true;
    e.retryAfter = sec;
    return e;
  }

  function queuedSearch(fn) {
    var p = _searchQ.then(function () {
      var gap = Math.max(0, SEARCH_GAP - (Date.now() - _lastSearchAt));
      var cool = Math.max(0, _limitedUntil - Date.now());
      var wait = Math.max(gap, cool);
      return wait ? sleep(wait) : null;
    }).then(fn);
    _searchQ = p.then(function () { _lastSearchAt = Date.now(); },
                      function () { _lastSearchAt = Date.now(); });
    return p;
  }

  function normalize(it) {
    if (!it) return null;
    var al = it.al || it.album || {};
    var ar = it.ar || it.artists || [];
    var priv = it.privilege || {};
    var dt = it.dt != null ? it.dt : (it.duration || 0);
    var names = [];
    for (var i = 0; i < (ar || []).length; i++) {
      if (ar[i] && ar[i].name) names.push(ar[i].name);
    }
    /* pl = 当前账号能播到的最高码率：0 表示只能试听 / 无版权 ——
       比 fee 更能说明"这首歌现在能不能放"（VIP 登录后 VIP 曲的 pl 会变成 999000） */
    var pl = priv.pl != null ? priv.pl : null;
    return {
      id: it.id,
      title: it.name || '',
      artist: names.join(' / '),
      album: al.name || '',
      albumId: al.id || 0,
      picUrl: al.picUrl || '',
      interval: Math.round(dt / 1000),
      fee: it.fee != null ? it.fee : 0,
      vip: (it.fee === 1),
      pl: pl,
      trialOnly: pl === 0,
      level: priv.plLevel || priv.maxBrLevel || '',
      dlLevel: priv.dlLevel || ''
    };
  }

  function normalizeList(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
      var n = normalize(list[i]);
      if (n && n.id) out.push(n);
    }
    return out;
  }

  /* 新版聚合搜索（带封面 / 时长 / 权限，优先用这个） */
  function cloudSearch(kw, page, size) {
    var body = 's=' + encodeURIComponent(kw) + '&type=1' +
               '&offset=' + ((page - 1) * size) + '&limit=' + size + '&total=true';
    return postForm('/api/cloudsearch/pc', body, 15000, 'search')
      .then(function (j) {
        if (j.code === 406) {
          _limitedUntil = Date.now() + LIMIT_COOLDOWN;
          throw rateLimitErr();
        }
        // 应用层错误体（风控 / 限流口径变化）按"这次没问成"计：歌词匹配据此把它标成
        // transient，不会被当成权威的"没有搜到"缓存 30 分钟（同 QQ 桥接的通道计数）
        if (j.code !== 200) { _netErr++; throw new Error('搜索接口返回 code=' + j.code); }
        var r = j.result || {};
        return { list: r.songs || [], total: r.songCount || 0 };
      });
  }

  /* 旧版搜索：没有封面字段，但结构简单、限流口径略有不同，用作兜底 */
  function webSearch(kw, page, size) {
    var qs = 's=' + encodeURIComponent(kw) + '&type=1' +
             '&offset=' + ((page - 1) * size) + '&limit=' + size;
    return getJson('/api/search/get/web?' + qs, { ms: 12000, tag: 'search-web' })
      .then(function (j) {
        if (j.code === 406) {
          _limitedUntil = Date.now() + LIMIT_COOLDOWN;
          throw rateLimitErr();
        }
        // 应用层错误体（风控 / 限流口径变化）按"这次没问成"计：歌词匹配据此把它标成
        // transient，不会被当成权威的"没有搜到"缓存 30 分钟（同 QQ 桥接的通道计数）
        if (j.code !== 200) { _netErr++; throw new Error('搜索接口返回 code=' + j.code); }
        var r = j.result || {};
        return { list: r.songs || [], total: r.songCount || 0 };
      });
  }

  function doSearch(kw, page, size) {
    return cloudSearch(kw, page, size).catch(function (e) {
      if (e && e.limited) throw e;               // 限流不再用兜底通道加重限流
      return webSearch(kw, page, size);
    });
  }

  /* 搜到 0 首 ≠ 搜索失败：ok 表示「这次查询问成了」，UI 才能把
     「没有搜到结果」和「网络/接口出错」分开显示 */
  function search(kw, page, size) {
    kw = String(kw || '').trim();
    page = Math.max(1, page | 0);
    size = Math.max(1, size | 0);
    if (!kw) return Promise.resolve({ ok: false, songs: [], more: false, error: '缺少关键词' });
    return queuedSearch(function () { return doSearch(kw, page, size); })
      .then(function (r) {
        var songs = normalizeList(r.list);
        var more = r.total ? ((page - 1) * size + songs.length < r.total)
                           : (songs.length >= size);
        return { ok: true, songs: songs, more: more, total: r.total, error: null };
      }, function (e) {
        return { ok: false, songs: [], more: false, error: (e && e.message) || '搜索失败',
                 limited: !!(e && e.limited), retryAfter: (e && e.retryAfter) || 0 };
      });
  }

  /* ------------------------------------------------------------
   * 直链解析（批量）
   * ------------------------------------------------------------
   * 一次请求解析一批 id，返回每首的**实际**档位；拿不到（无版权 / 未登录的
   * 会员曲目）返回 url:null，只拿到试听切片返回 trial:true。
   * ---------------------------------------------------------- */
  var RESOLVE_CHUNK = 10;      // 每个请求塞多少首（实测 20 首也没问题，留余量）
  var RESOLVE_PARALLEL = 3;    // 同时几个请求

  function resolveChunk(ids, quality, anonymous) {
    var q = QUAL_INFO[normQuality(quality)];
    var url = '/api/song/enhance/player/url?ids=%5B' + ids.join(',') + '%5D&br=' + q.br;
    return getJson(url, { ms: 20000, tag: anonymous ? 'url-anon' : 'url',
                          anonymous: !!anonymous }).then(function (j) {
      if (j.code !== 200) throw new Error('直链接口返回 code=' + j.code);
      var by = {};
      (j.data || []).forEach(function (x) { if (x && x.id) by[x.id] = x; });
      return ids.map(function (id) {
        var x = by[id];
        if (!x || !x.url) return { id: id, url: null, code: x ? x.code : 0 };
        var trial = !!(x.freeTrialInfo && (x.freeTrialInfo.end > 0));
        return {
          id: id,
          url: x.url,
          md5: x.md5 || '',
          br: x.br || 0,
          size: x.size || 0,
          type: x.type || '',
          level: x.level || '',
          time: x.time || 0,
          trial: trial,
          trialEnd: trial ? x.freeTrialInfo.end : 0
        };
      });
    });
  }

  /* ------------------------------------------------------------
   * 直链 ↔ 曲目信息（封面兜底 + 歌词精确匹配）
   * ------------------------------------------------------------
   * 在线曲目的「路径」是 CDN 直链：宿主取不到原生封面，文件系统里也无处
   * 可扫。直链文件名是音频文件的 md5（接口会一并给 md5 字段），把它映射回
   * 歌曲 id / 封面直链，封面兜底与歌词匹配就能从播放路径反查回来
   * （网易云直链里不带歌曲 id，所以只能这样记）。持久化上限 400 条。
   * ---------------------------------------------------------- */
  var URLMETA_MAX = 400;
  var _urlMeta = null;

  function urlMetaMap() {
    if (_urlMeta) return _urlMeta;
    try { _urlMeta = JSON.parse(lsGet(LS_URLMETA) || '{}') || {}; }
    catch (e) { _urlMeta = {}; }
    return _urlMeta;
  }

  function md5OfUrl(u) {
    var s = String(u || '').split('?')[0];
    var seg = s.slice(s.lastIndexOf('/') + 1);
    return seg.replace(/\.[a-z0-9]{2,4}$/i, '').toLowerCase();
  }

  /* 只写内存，返回"是否新增/更新"；落盘由调用方在整批结束后做一次 ——
     逐首 persistUrlMeta 会让 300 首的导入在主线程上做 300 次全量
     JSON.stringify（400 条约 80KB）+ 300 次同步 localStorage 写。 */
  function rememberUrlMeta(track, rv) {
    if (!track || !rv || !rv.url) return false;
    var key = rv.md5 ? String(rv.md5).toLowerCase() : md5OfUrl(rv.url);
    if (!key || key.length < 16) return false;        // 不像 md5 就不记，免得污染映射
    var map = urlMetaMap();
    map[key] = {
      id: track.id, picUrl: track.picUrl || '', title: track.title || '',
      artist: track.artist || '', album: track.album || '',
      level: rv.level || '', ts: Date.now()
    };
    return true;
  }

  function persistUrlMeta() {
    var map = _urlMeta || {};
    var keys = Object.keys(map);
    if (keys.length > URLMETA_MAX) {
      keys.sort(function (a, b) { return (map[a].ts || 0) - (map[b].ts || 0); });
      for (var i = 0; i < (keys.length - URLMETA_MAX); i++) delete map[keys[i]];
    }
    try { lsSet(LS_URLMETA, JSON.stringify(map)); } catch (e) {}
  }

  /* CDN 直链 → 曲目信息（播放路径反查；没有记录时返回 null） */
  function metaFromUrl(u) {
    u = String(u || '');
    if (!u) return null;
    /* 兼容「外链」形式 https://music.163.com/song/media/outer/url?id=123.mp3 */
    var m = /[?&]id=(\d+)/.exec(u);
    if (m && /music\.163\.com\/song\/media\/outer/i.test(u)) {
      var hit = null;
      var map = urlMetaMap();
      for (var k in map) {
        if (Object.prototype.hasOwnProperty.call(map, k) && String(map[k].id) === m[1]) { hit = map[k]; break; }
      }
      return { id: Number(m[1]), picUrl: hit ? hit.picUrl : '', title: hit ? hit.title : '',
               artist: hit ? hit.artist : '', album: hit ? hit.album : '',
               ts: (hit && hit.ts) || 0, key: '' };
    }
    if (!/music\.126\.net|music\.163\.com/i.test(u)) return null;
    var key = md5OfUrl(u);
    var rec = key ? urlMetaMap()[key] : null;
    if (!rec) return null;
    /* ts 一定要带出去：playback-model 的 pathFreshness 靠它判"这条还能用多久"，
       漏了就等于每次重播都当成"判不出来"→ 白解析一次（实测过这个坑）。 */
    return { id: rec.id, picUrl: rec.picUrl, title: rec.title, artist: rec.artist,
             album: rec.album, level: rec.level, ts: rec.ts || 0, key: key };
  }

  /* 这个路径是不是网易云的在线曲目（按域名判断，不要求有映射记录） */
  function isNeteaseUrl(u) {
    return /music\.126\.net|music\.163\.com/i.test(String(u || ''));
  }

  /* 把「直链 → 歌名/歌手」注册给主题：在线曲目在 foobar 里没有任何标签，
     CM.trackName / CM.trackArtist 取名时优先查这里 —— 否则界面会把直链
     签名参数里的碎片当成歌名（实测显示成 "GsvWzqeUwhOhb+2GUTYfbcNo="）。 */
  if (window.CloudMusic && window.CloudMusic.registerOnlineName) {
    window.CloudMusic.registerOnlineName(function (path) {
      var m = metaFromUrl(path);
      return m ? { title: m.title, artist: m.artist, album: m.album } : null;
    });
  }

  /* ------------------------------------------------------------
   * 批量解析（勾选播放 / 下载共用）
   * ---------------------------------------------------------- */
  function resolveMany(tracks, quality, opts) {
    var forStream = !!(opts && opts.forStream);
    tracks = (tracks || []).filter(function (t) { return t && t.id; });
    if (!tracks.length) {
      return Promise.resolve({ ok: false, urls: [], resolves: [], skipped: [],
                               usedLabel: '', error: '没有可解析的曲目' });
    }

    /* 一批 id → 结果数组（保序）。anonymous=true 时不带登录 Cookie。 */
    function runChunks(idList, anonymous) {
      var chunks = [];
      for (var i = 0; i < idList.length; i += RESOLVE_CHUNK) chunks.push(idList.slice(i, i + RESOLVE_CHUNK));
      var out = new Array(idList.length);
      var next = 0;
      function worker() {
        if (next >= chunks.length) return Promise.resolve();
        var at = next++;
        return resolveChunk(chunks[at], quality, anonymous).then(function (list) {
          var base = at * RESOLVE_CHUNK;
          for (var k = 0; k < list.length; k++) out[base + k] = list[k];
        }, function (e) {
          // 某一批失败不该让整批报废：标记空结果，其它批照常
          var base = at * RESOLVE_CHUNK;
          for (var k = 0; k < (chunks[at] || []).length; k++) {
            out[base + k] = { id: chunks[at][k], url: null, failed: true, error: e && e.message };
          }
        }).then(worker);
      }
      var runners = [];
      for (var w = 0; w < Math.min(RESOLVE_PARALLEL, chunks.length); w++) runners.push(worker());
      return Promise.all(runners).then(function () { return out; });
    }

    return runChunks(tracks.map(function (t) { return t.id; }), false).then(function (out) {
      /* 登录态的兜底：这批里"接口正常回了、但没给直链"的，用**匿名**再要一次。
         用户实测过「不登录能听、登录之后反而不能听」—— 不重试的话，一个失效 /
         受限的 Cookie 会把本来能播的免费曲目直接变成听不了。
         只在登录态下、且只重试"首轮明确没给直链"的那些（网络失败的批不重试）。 */
      var retry = [];
      if (hasLogin()) {
        for (var k = 0; k < out.length; k++) {
          var rv = out[k];
          /* 只兜**非会员**曲目：会员曲目拿不到是正常的（该账号没有授权），
             不能靠匿名去绕开账号权限。 */
          if (rv && !rv.url && !rv.trial && !rv.failed && !(tracks[k] && tracks[k].vip)) retry.push(k);
        }
      }
      if (!retry.length) return { out: out, anonUsed: 0 };
      return runChunks(retry.map(function (k) { return out[k].id; }), true).then(function (out2) {
        var anonUsed = 0;
        retry.forEach(function (k, j) {
          var r2 = out2[j];
          if (r2 && r2.url && !r2.trial) { out[k] = r2; anonUsed++; }
        });
        return { out: out, anonUsed: anonUsed };
      });
    }).then(function (res) {
      /* 无损直链整理成可流播形态（https + 非 audio/mpeg 镜像；探测是小请求，
         并发 3 与解析池同一量级）。放这一步：匿名兜底重试已经结束，整理的是
         最终结果。下载路径不整理也不回落（forStream=false，见 finishStreamRv）。 */
      var out0 = res.out || [];
      var pi = 0;
      function pworker() {
        if (pi >= out0.length) return Promise.resolve();
        var at = pi++;
        return finishStreamRv(out0[at], forStream).then(function (rv2) {
          out0[at] = rv2;
        }, function () {}).then(pworker);
      }
      var prunners = [];
      for (var pw = 0; pw < Math.min(3, out0.length); pw++) prunners.push(pworker());
      return Promise.all(prunners).then(function () { return res; });
    }).then(function (res) {
      var out = res.out || [];
      var anonUsed = res.anonUsed || 0;
      var urls = [], resolves = [], skipped = [], levels = {};
      var noLogin = !hasLogin();
      var netFail = 0, touched = false;
      for (var k = 0; k < tracks.length; k++) {
        var t = tracks[k], rv = out[k] || { id: t.id, url: null };
        if (rv.url && !rv.trial) {
          resolves.push({ id: t.id, url: rv.url, md5: rv.md5, br: rv.br, size: rv.size,
                          type: rv.type, level: rv.level, time: rv.time, trial: false });
          urls.push(rv.url);
          levels[rv.level || '?'] = (levels[rv.level || '?'] || 0) + 1;
          touched = rememberUrlMeta(t, rv) || touched;
        } else if (rv.trial) {
          skipped.push(t.title + '（仅 ' + (rv.trialEnd || 45) + ' 秒试听' +
                       (noLogin ? '，需登录会员' : '，需会员') + '）');
        } else if (rv.failed) {
          // 这一批请求根本没成（网络 / 接口异常），不是"没有音源"：
          // 混进「无版权 / 需会员」会让用户去登录一个根本没问题的账号
          netFail++;
          skipped.push(t.title + '（解析请求失败：' + (rv.error || '网络异常') + '）');
        } else if (rv.streamFail) {
          // 无损直链当前没有可流播的形态（https/镜像探测都不过），回落 320K
          // 也没拿到——如实按"没有可用音源"说，别交给宿主一首会停滞的 FLAC
          skipped.push(t.title + '（无损直链暂时不可流播，回落 320K 也未成功）');
        } else {
          skipped.push(t.title + '（' + (noLogin ? '未登录 / 无版权 / 需会员' : '无版权 / 需会员') + '）');
        }
      }
      if (touched) persistUrlMeta();               // 整批只落盘一次
      var best = '', bestRank = -1;
      Object.keys(levels).forEach(function (lv) {
        var rank = QUALS.indexOf(lv);
        if (rank > bestRank) { bestRank = rank; best = lv; }
      });
      return {
        ok: urls.length > 0,
        urls: urls,
        resolves: resolves,
        skipped: skipped,
        usedLabel: LEVEL_LABEL[best] || '',
        levels: levels,
        // 登录态拿不到、匿名补上的数量（UI 用它提示一句"已改用匿名音源"）
        anonFallback: anonUsed,
        note: anonUsed ? ('登录 Cookie 拿不到 ' + anonUsed + ' 首，已自动改用匿名音源') : '',
        error: urls.length ? null
             : (netFail && netFail === tracks.length
                ? '音源解析请求全部失败（网络或接口异常），请稍后重试'
                : (noLogin ? '这批曲目都没有可用音源（会员曲目请先在右上角「设置 Cookie」登录）'
                           : '这批曲目都没有可用音源（登录态和匿名都拿不到；Cookie 可能已失效，可试试点「清除 Cookie」）'))
      };
    });
  }

  /* 单首解析（播放前刷新 / 诊断用）。登录态拿不到时用匿名重试一次 —— 与批量同一套兜底。
     forStream（默认 true）：flac 直链整理成可流播形态、整理不出回落 320K。 */
  function resolveStream(id, quality, forStream) {
    function one(anonymous) {
      return resolveChunk([id], quality, anonymous).then(function (list) {
        var rv = (list || [])[0];
        if (!rv || !rv.url) throw new Error('拿不到直链（无版权 / 需要会员）');
        if (rv.trial) throw new Error('只有 ' + (rv.trialEnd || 45) + ' 秒试听片段（需要会员）');
        return rv;
      });
    }
    return one(false).then(null, function (e) {
      if (!hasLogin()) throw e;
      return one(true).then(null, function () { throw e; });
    }).then(function (rv) {
      return finishStreamRv(rv, forStream !== false);
    });
  }

  /* 播放前刷新直链：写进 foobar 歌单的是**带 CDN 签名和时效**的地址，过期后
     宿主打不开就自动跳下一首 —— 用户看到的是"这首还没开始就自己跳走了"。
     按直链反查出的歌曲 id 重新解析一次，并把新直链的映射记下来（歌名/封面要用）。 */
  function refreshUrl(u) {
    var meta = metaFromUrl(u);
    if (!meta || !meta.id) {
      // 映射丢了（超过 400 条被裁掉）：认不出是哪首，没法重新解析 —— 交给调用方
      // 原样播，别因为"刷新不了"就拒绝一首可能还有效的直链
      var e0 = new Error('这条直链反查不到歌曲 id');
      e0.cmUnidentifiable = true;
      return Promise.reject(e0);
    }
    function one(anonymous) {
      return resolveChunk([meta.id], streamQuality(), anonymous).then(function (list) {
        var rv = (list || [])[0];
        if (!rv || !rv.url || rv.trial) throw new Error('重新解析拿不到直链（无版权 / 需要会员）');
        return rv;
      });
    }
    return one(false).then(null, function (e) {
      if (!hasLogin()) throw e;
      // 登录态拿不到 → 匿名再试一次（用户实测：不登录能听、登录反而不行）
      return one(true).then(null, function () { throw e; });
    }).then(function (rv) {
      // 与 resolveStream 同一道收尾：flac 整理成 https 可流播形态（旧 http 形态
      // 在 foobar 里停滞），整理不出回落 320K——刷新路径本身就是播放路径
      return finishStreamRv(rv, true);
    }).then(function (rv) {
      if (!rv || !rv.url) throw new Error('重新解析拿不到可流播的直链');
      rememberUrlMeta({ id: meta.id, picUrl: meta.picUrl || '', title: meta.title || '',
                        artist: meta.artist || '', album: meta.album || '' }, rv);
      persistUrlMeta();
      return rv.url;
    });
  }

  /* ------------------------------------------------------------
   * 歌词
   * ------------------------------------------------------------
   * 上游给原文 lrc + 译文 tlyric（同刻时间戳）。主题的「同刻归组」会把它们
   * 配成 主行/副行，所以直接「原文 + 空行 + 译文」交给主题即可。
   * ---------------------------------------------------------- */
  var NO_LYRIC_RE = /纯音乐[，,]\s*请欣赏|此歌曲为没有填词的纯音乐|暂无歌词/;

  function lyricById(id) {
    return getJson('/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=1&kv=1&tv=-1',
                   { ms: 12000, tag: 'lyric' }).then(function (j) {
      if (!j || j.code !== 200) {
        throw new Error('歌词接口返回错误' + (j && j.code != null ? ' code=' + j.code : ''));
      }
      var text = (j.lrc && j.lrc.lyric) || '';
      var trans = (j.tlyric && j.tlyric.lyric) || '';
      if (!text || NO_LYRIC_RE.test(text)) return '';        // 上游明确回「没有歌词」
      return trans ? (text + '\n\n' + trans) : text;
    });
  }

  /* 繁→简：网易云曲库以简体为主，而本地文件名常是繁体。复用 QQ 桥接里那张
     对照表（同一个页面里已加载），取不到就退化成原样 —— 只是匹配略弱。 */
  function toSimplified(s) {
    if (window.QQBridge && typeof QQBridge.toSimplified === 'function') {
      return QQBridge.toSimplified(s);
    }
    return s;
  }

  function normKey(s) {
    s = toSimplified(String(s == null ? '' : s).toLowerCase());
    s = s.replace(/[\(\[（【{].*?[\)\]）】}]/g, '');
    // 与 qqmusic-core 同一口径（含谚文：缺了它韩语标题/艺人会被整串清空，相似度恒 0）
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
    for (var k in cb) { if (ca[k]) common += Math.min(ca[k], cb[k]); }
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

  /* 优先「标题命中 + 歌手命中 + 时长吻合」，避免抓到翻唱 / 伴奏 */
  function scoreHit(h, title, artist, duration) {
    var s = 0;
    if (title) s += shareRatio(title, h.title) * 1.0;
    if (artist) s += shareRatio(artist, h.artist) * 0.6;
    if (duration > 0 && h.interval > 0) {
      var d = Math.abs(h.interval - duration);
      if (d <= 3) s += 1.2;
      else if (d <= 8) s += 0.4;
      else if (d <= 25) s += 0.1;
    }
    var low = (h.title + ' ' + h.artist).toLowerCase();
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

  var MIN_SCORE = 0.8;
  var LYRIC_TTL = 30 * 60 * 1000;
  var _lyricCache = {};

  function cacheTrim(obj, max) {
    var keys = Object.keys(obj);
    if (keys.length <= (max || 120)) return;
    keys.sort(function (a, b) { return ((obj[a] && obj[a].ts) || 0) - ((obj[b] && obj[b].ts) || 0); });
    for (var i = 0; i < (keys.length >> 1); i++) delete obj[keys[i]];
  }

  /* 多轮放宽：raw → 清轨号 → 去括号 → 只按标题 */
  function findLyric(title, artist, duration) {
    var rounds = [
      { tag: 'raw', t: title, a: artist },
      { tag: 'cleantitle', t: cleanTitle(title), a: artist },
      { tag: 'nobracket', t: stripBrackets(title), a: artist },
      { tag: 'titleonly', t: title, a: '' }
    ];
    var err0 = _netErr;
    function runRound(i) {
      if (i >= rounds.length) {
        return { ok: false, lrc: '', note: 'no-match', transient: _netErr > err0 };
      }
      var r = rounds[i];
      var kw = (r.t + (r.a ? ' ' + r.a : '')).trim();
      if (!kw) return runRound(i + 1);
      if (i > 0 && r.t && rounds[0].t && normKey(r.t) === normKey(rounds[0].t) &&
          normKey(r.a) === normKey(rounds[0].a)) {
        return runRound(i + 1);          // 与本轮之前完全相同的关键词不重复打接口
      }
      return search(kw, 1, 10).then(function (d) {
        // 被限流就别再往下试了：后面每一轮都要等冷却，白让用户等几十秒。
        // 标记 transient，避免把这次"没问成"缓存成"这首歌没歌词"
        if (d && d.limited) {
          return { ok: false, lrc: '', note: 'limited', transient: true };
        }
        if (!d || !d.ok) return runRound(i + 1);            // 这一轮打不通 → 下一轮
        var best = pickBest(d.songs || [], title, artist, duration);
        if (!best || best.score < MIN_SCORE) return runRound(i + 1);
        return lyricById(best.hit.id).then(function (lrc) {
          if (!lrc) return { ok: false, lrc: '', note: 'no-lyric', id: best.hit.id, transient: false };
          return { ok: true, lrc: lrc, id: best.hit.id, title: best.hit.title,
                   singer: best.hit.artist, score: best.score, note: r.tag, transient: false };
        });
      });
    }
    return runRound(0);
  }

  /* 按「标题 + 歌手 + 时长」匹配歌词（本地没有 .lrc 时的联网兜底）。
     命中与**权威的未命中**都进 30 分钟缓存；网络失败不进缓存，
     否则一次抖动会让这首歌半小时内一直显示「暂无歌词」。 */
  function lyric(title, artist, duration) {
    title = String(title || '').trim();
    artist = String(artist || '').trim();
    duration = duration | 0;
    if (!title) return Promise.resolve({ ok: false, lrc: '', note: 'no-title' });
    var key = normKey(title) + '|' + normKey(artist) + '|' + duration;
    var hit = _lyricCache[key];
    if (hit && (Date.now() - hit.ts) < LYRIC_TTL) {
      var r0 = hit.r;
      return Promise.resolve({ ok: r0.ok, lrc: r0.lrc, id: r0.id, title: r0.title,
                               singer: r0.singer, score: r0.score, note: r0.note, cached: true });
    }
    return findLyric(title, artist, duration).then(function (r) {
      if (!r.transient) {
        _lyricCache[key] = { ts: Date.now(), r: r };
        cacheTrim(_lyricCache, 200);
      }
      return r;
    });
  }

  /* 按 id 取词（带缓存）—— 已知歌曲 id 时优先走这条：比「标题 + 歌手」
     模糊匹配准，不会张冠李戴。上游回「没有歌词」时退回模糊匹配
     （有些歌只有别的版本才有词，模糊匹配可能捞到同曲的另一份）。 */
  function lyricForId(id, title, artist, duration) {
    if (!id) return lyric(title, artist, duration);
    var key = 'id:' + id;
    var hit = _lyricCache[key];
    if (hit && (Date.now() - hit.ts) < LYRIC_TTL) {
      return Promise.resolve({ ok: hit.r.ok, lrc: hit.r.lrc, id: id,
                               note: hit.r.note, cached: true });
    }
    return lyricById(id).then(function (lrc) {
      if (!lrc) return lyric(title, artist, duration);
      var r = { ok: true, lrc: lrc, id: id, note: 'byid', transient: false };
      _lyricCache[key] = { ts: Date.now(), r: r };
      cacheTrim(_lyricCache, 200);
      return r;
    }, function () {
      return lyric(title, artist, duration);
    });
  }

  /* 在线曲目专用：能从直链反查出 id 就按 id 精确取词，反查不到再退回模糊匹配 */
  function lyricForTrack(url, title, artist, duration) {
    var meta = metaFromUrl(url);
    if (!meta || !meta.id) return lyric(title, artist, duration);
    return lyricForId(meta.id, title, artist, duration);
  }

  function lyricCacheClear() { _lyricCache = {}; return true; }

  /* ------------------------------------------------------------
   * 歌单（公开歌单 / 榜单免 Cookie 直接读全曲目）
   * ---------------------------------------------------------- */
  function parsePlaylistId(s) {
    s = String(s || '').trim();
    if (!s) return 0;
    var m = /[?&#]id=(\d+)/.exec(s);
    if (m) return Number(m[1]);
    m = /playlist\/(\d+)/.exec(s);
    if (m) return Number(m[1]);
    return /^\d+$/.test(s) ? Number(s) : 0;
  }

  function playlist(idOrLink) {
    var id = parsePlaylistId(idOrLink);
    if (!id) return Promise.resolve({ ok: false, error: '看不是歌单 ID 或链接' });
    return getJson('/api/v6/playlist/detail?id=' + id + '&n=1000&s=8', { ms: 20000, tag: 'playlist' })
      .then(function (j) {
        if (j.code === 406) { _limitedUntil = Date.now() + LIMIT_COOLDOWN; return { ok: false, error: rateLimitErr().message }; }
        var pl = j && j.playlist;
        if (!pl) {
          return { ok: false, error: j && j.code === 404 ? '歌单不存在或已删除'
                   : ('读歌单失败（code=' + (j && j.code) + '）—— 私密/自建歌单需要先设置 Cookie 登录') };
        }
        var tracks = normalizeList(pl.tracks || []);
        return { ok: true, id: id, name: pl.name || '', cover: pl.coverImgUrl || '',
                 total: pl.trackCount || tracks.length, tracks: tracks };
      }, function (e) {
        return { ok: false, error: (e && e.message) || '读歌单失败' };
      });
  }

  /* 文本导入：按「歌名 - 歌手」逐条搜一个最佳命中（宁缺勿错） */
  function matchSong(title, artist) {
    var kw = (title + (artist ? ' ' + artist : '')).trim();
    if (!kw) return Promise.resolve(null);
    return search(kw, 1, 10).then(function (d) {
      if (!d || !d.ok) return null;
      var best = pickBest(d.songs || [], title, artist, 0);
      if (!best || best.score < MIN_SCORE) return null;
      return best.hit;
    });
  }

  /* ------------------------------------------------------------
   * 封面
   * ---------------------------------------------------------- */
  function coverUrl(picUrl, size) {
    picUrl = String(picUrl || '').trim();
    if (!picUrl) return '';
    var u = picUrl.replace(/^http:/i, 'https:');
    if (size === false) return u;
    var s = size || 500;
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'param=' + s + 'y' + s;
  }

  /* 封面下载（异步宿主 HTTP + 会话缓存）：artwork-resolver 的封面兜底从这里取图。
     必须异步（同步会把主线程冻住整个下载时长）、必须缓存（每次重绘都重下会冻）。
     失败降级返回 CDN 原始 URL，<img> 仍能显示，只是取色会因 CORS 失败。 */
  var coverCache = Object.create(null);            // picUrl -> dataURL | 原始 URL | ''
  var coverPending = Object.create(null);
  var COVER_CACHE_MAX = 30;

  function coverDataUrl(picUrl) {
    picUrl = String(picUrl || '').trim();
    if (!picUrl) return Promise.resolve('');
    var url = coverUrl(picUrl);
    if (coverCache[url] !== undefined) return Promise.resolve(coverCache[url]);
    if (coverPending[url]) return coverPending[url];

    var p = hostHttp({
      url: url, responseType: 'binary',
      headers: { 'User-Agent': UA, Referer: SITE + '/' },
      ms: 10000, tag: 'cover'
    }).then(function (r) {
      var ct = 'image/jpeg';
      var h = r.headers || {};
      var ctKey = h['content-type'] || h['Content-Type'];
      if (ctKey) ct = String(ctKey).split(';')[0];
      if (r.status >= 200 && r.status < 300 && r.body) return 'data:' + ct + ';base64,' + r.body;
      return url;
    }, function () {
      return url;
    }).then(function (v) {
      delete coverPending[url];
      coverCache[url] = v;
      var keys = Object.keys(coverCache);
      if (keys.length > COVER_CACHE_MAX) {
        for (var i = 0; i < (keys.length >> 1); i++) delete coverCache[keys[i]];
      }
      return v;
    }).catch(function () {
      delete coverPending[url];
      return url;
    });
    coverPending[url] = p;
    return p;
  }

  /* 播放路径 → 封面：先从直链反查曲目，再取图 */
  function coverDataUrlForTrack(trackPath) {
    var meta = metaFromUrl(trackPath);
    if (!meta || !meta.picUrl) return Promise.resolve('');
    return coverDataUrl(meta.picUrl);
  }

  function coverCacheClear() {
    coverCache = Object.create(null);
    coverPending = Object.create(null);
    return true;
  }

  /* ------------------------------------------------------------
   * 自检：桥接依赖第三方接口，先跑一遍把"哪个环节断了"说清楚
   * ------------------------------------------------------------
   * 随页面加载跑一次（一次搜索 + 一次解析 + 一次取词），结果进 console，
   * UI 首屏也会读它来显示状态。放进 sessionStorage：一次会话只跑一遍。
   * ---------------------------------------------------------- */
  var _selfcheck = { state: 'idle', at: 0, steps: {}, ms: 0 };
  var SELFTEST_KEY = 'cm.netease.selfcheck';

  function selfcheck(force) {
    if (_selfcheck.state === 'running') return Promise.resolve(_selfcheck);
    if (!force) {
      try {
        var cached = sessionStorage.getItem(SELFTEST_KEY);
        if (cached) { _selfcheck = JSON.parse(cached); return Promise.resolve(_selfcheck); }
      } catch (e) {}
    }
    _selfcheck = { state: 'running', at: Date.now(), steps: {}, ms: 0 };
    var t0 = Date.now();
    var probe = null;
    _selfcheck.steps.login = hasLogin() ? 'on' : 'off';
    return search('晴天', 1, 3).then(function (d) {
      _selfcheck.steps.search = d && d.ok ? ('ok(' + (d.songs || []).length + ')') : ('fail:' + ((d && d.error) || '?'));
      probe = d && d.songs && d.songs[0];
      if (!probe) return null;
      // 自检只验证接口通不通：不走 streamify（无损探测/回落 320K 是播放路径的事，
      // 塞进自检会让每次启动多发探测请求、失败时还多一次回落解析）
      return resolveStream(probe.id, 'lossless', false).then(function (rv) {
        _selfcheck.steps.resolve = 'ok(' + (LEVEL_LABEL[rv.level] || rv.level || '?') + ')';
      }, function (e) {
        _selfcheck.steps.resolve = 'fail:' + ((e && e.message) || '?');
      });
    }).then(function () {
      if (!probe) return null;
      return lyricById(probe.id).then(function (lrc) {
        _selfcheck.steps.lyric = lrc ? 'ok' : 'none';
      }, function (e) {
        _selfcheck.steps.lyric = 'fail:' + ((e && e.message) || '?');
      });
    }).then(function () {
      _selfcheck.ms = Date.now() - t0;
      _selfcheck.state = (_selfcheck.steps.search || '').indexOf('ok') === 0 ? 'ok' : 'fail';
      try { sessionStorage.setItem(SELFTEST_KEY, JSON.stringify(_selfcheck)); } catch (e) {}
      if (typeof console !== 'undefined' && console.log) {
        console.log('[NeteaseBridge] 自检', _selfcheck.state, _selfcheck.ms + 'ms',
                    _selfcheck.steps, 'quality=' + getQuality(), 'cookie=' + (hasLogin() ? 'yes' : 'no'));
      }
      return _selfcheck;
    }, function (e) {
      _selfcheck.ms = Date.now() - t0;
      _selfcheck.state = 'fail';
      _selfcheck.steps.error = (e && e.message) || '?';
      try { sessionStorage.setItem(SELFTEST_KEY, JSON.stringify(_selfcheck)); } catch (e2) {}
      return _selfcheck;
    });
  }

  function selfcheckState() { return _selfcheck; }

  /* ------------------------------------------------------------
   * 配置 / 诊断 / 导出
   * ---------------------------------------------------------- */
  function config() {
    return {
      version: VERSION,
      hasCookie: hasLogin(),
      quality: getQuality(),
      selfcheck: _selfcheck.state
    };
  }

  function bridgeInfo() {
    return {
      version: VERSION,
      hasLogin: hasLogin(),
      cookieKeys: parseCookieInput(getCookie()).split(';').map(function (s) { return s.split('=')[0].trim(); }).filter(Boolean),
      quality: getQuality(),
      urlMeta: Object.keys(urlMetaMap()).length,
      lyricCache: Object.keys(_lyricCache).length,
      coverCache: Object.keys(coverCache).length,
      limitedFor: Math.max(0, Math.round((_limitedUntil - Date.now()) / 1000)) + 's',
      inflight: inflightCount(),
      netErrors: _netErr,
      selfcheck: _selfcheck
    };
  }

  window.NeteaseBridge = {
    version: VERSION,
    config: config,
    setQuality: setQuality, getQuality: getQuality,
    // 在线播放用的档位（无损/Hi-Res 会降到 320K MP3，见 streamQuality 的注释）
    streamQuality: streamQuality,
    needStreamRefetch: needStreamRefetch,
    probeStream: probeStream,
    streamifyUrl: streamifyUrl,
    getCookie: getCookie, setCookie: setCookie, clearCookie: clearCookie,
    hasLogin: hasLogin,
    account: account, vipInfo: vipInfo,
    search: search,
    resolveStream: resolveStream,
    refreshUrl: refreshUrl,
    resolveMany: resolveMany,
    lyric: lyric, lyricForTrack: lyricForTrack, lyricForId: lyricForId, lyricById: lyricById,
    lyricCacheClear: lyricCacheClear,
    matchSong: matchSong,
    playlist: playlist, parsePlaylistId: parsePlaylistId,
    coverUrl: coverUrl,
    coverDataUrl: coverDataUrl, coverDataUrlForTrack: coverDataUrlForTrack,
    coverCacheClear: coverCacheClear,
    metaFromUrl: metaFromUrl, isNeteaseUrl: isNeteaseUrl,
    selfcheck: selfcheck, selfcheckState: selfcheckState,
    netErrors: netErrs,
    bridgeInfo: bridgeInfo
  };

  /* 页面加载后跑一次自检（会话内只跑一次）：第三方接口哪天变了，
     状态栏与 console 能立刻指出是哪一段断了，而不是"搜不到东西"。 */
  if (typeof setTimeout === 'function') setTimeout(function () { selfcheck(false); }, 1800);
})();
