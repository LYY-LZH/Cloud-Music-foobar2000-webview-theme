/* ============================================================
 * CloudMusic 主题扩展 · B 站在线音源桥接（bilibili-core.js）
 * ------------------------------------------------------------
 * 页面逻辑在 js/ui-bilibili.js。这里只做「B 站接口 → 可播放直链」这一层：
 *
 *   搜索   x/web-interface/wbi/search/type   （需 WBI 签名）
 *   详情   x/web-interface/wbi/view          （未签名版本恒 412）
 *   取流   x/player/wbi/playurl              （需 WBI 签名）
 *
 * 为什么流播固定用 fnval:0 + platform:'html5'：
 *   实测 fnval:16（DASH）回的音频直链**不带 Referer 恒 403**，而 foobar2000
 *   取流时发不了自定义头；fnval:0 的 html5 档回的是 durl[0] —— 一个普通 MP4
 *   容器（内含 AAC 音轨），不带 Referer 也 200、支持 Range，可以直接交给宿主
 *   流播。代价是码率约 157kbps（够听，但不是无损）。
 *
 * 下载：同一个 durl 表逐段 http.download 后按字节拼接（长视频会被切成多段，
 *   实测 4.5 分钟的音乐视频是 1 段、5.1MB）。容器里有 avc1 视频轨 + AAC 音轨，
 *   所以落地扩展名用 .mp4（foobar2000 只取音轨播放），不是 .m4a。
 *
 * 风控相关：
 *   · 未登录也要带 buvid3/buvid4（x/frontend/finger/spi 拿），否则部分接口
 *     直接回 -352；
 *   · 所有 WBI 接口都要 wts + w_rid，w_rid = md5(query + mixinKey)。签名必须
 *     **同步**算，页面里 crypto.subtle 是异步的，所以这里自带一份 MD5。
 *   · 签名有效期按 6 小时算，遇到 -403（签名过期）自动重取一次。
 *
 * 导出（window.BilibiliBridge）：见文件末尾。
 * ============================================================ */
(function () {
  'use strict';

  var CM = window.CloudMusic;
  var VERSION = '1.1.0';
  var API = 'https://api.bilibili.com';
  var SITE = 'https://www.bilibili.com';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  /* ------------------------------------------------------------
   * 同步 MD5（WBI 签名要用）
   * ------------------------------------------------------------
   * WBI 的 query 已经过 encodeURIComponent（纯 ASCII），但这里仍按 UTF-8
   * 编码，免得以后拿它算歌名时踩坑。
   * ---------------------------------------------------------- */
  function utf8Bytes(s) {
    var str = unescape(encodeURIComponent(String(s == null ? '' : s)));
    var out = [];
    for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xff);
    return out;
  }

  var MD5_K = null;
  function md5K() {
    if (MD5_K) return MD5_K;
    MD5_K = [];
    for (var i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    return MD5_K;
  }

  function md5(s) {
    var K = md5K();
    var S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    var bytes = utf8Bytes(s);
    var bits = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (var k = 0; k < 8; k++) bytes.push(k < 4 ? ((bits >>> (8 * k)) & 0xff) : 0);
    var a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }
    for (var off = 0; off < bytes.length; off += 64) {
      var M = [];
      for (var j = 0; j < 16; j++) {
        var p = off + j * 4;
        M[j] = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24);
      }
      var A = a0, B = b0, C = c0, D = d0;
      for (var i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        var tmp = D;
        D = C;
        C = B;
        var sum = (F + A + K[i] + M[g]) | 0;
        B = (B + rotl(sum, S[(i >> 4) * 4 + (i % 4)])) | 0;
        A = tmp;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }
    var out = '';
    [a0, b0, c0, d0].forEach(function (w) {
      for (var k2 = 0; k2 < 4; k2++) {
        var b = (w >> (8 * k2)) & 0xff;
        out += (b < 16 ? '0' : '') + b.toString(16);
      }
    });
    return out;
  }

  /* ------------------------------------------------------------
   * 宿主 HTTP（异步）
   * ------------------------------------------------------------
   * async:false 会把 foobar 主窗口冻住整个请求时长，必须用 async:true +
   * http:response 事件，超时用 http.abort 真取消。
   * ---------------------------------------------------------- */
  var _inflight = {};
  var _httpListening = false;
  var _netErr = 0;

  function httpListen() {
    if (_httpListening) return;
    if (typeof fb === 'undefined' || typeof fb.on !== 'function') return;
    _httpListening = true;
    fb.on('http:response', function (e) {
      if (!e || !e.requestId) return;
      var w = _inflight[e.requestId];
      if (!w) return;
      delete _inflight[e.requestId];
      clearTimeout(w.timer);
      if (e.success === false) w.reject(new Error(e.error || ('HTTP ' + (e.status || '失败'))));
      else w.resolve(e);
    });
  }

  function hostHttp(opt) {
    if (typeof fb === 'undefined' || typeof fb.invoke !== 'function') {
      return Promise.reject(new Error('宿主 HTTP 不可用'));
    }
    httpListen();
    var params = { url: opt.url, async: true };
    if (opt.body != null) params.body = opt.body;
    if (opt.responseType) params.responseType = opt.responseType;
    if (opt.headers) params.headers = opt.headers;
    var tag = opt.tag || 'bili';
    var ms = opt.ms || 15000;
    return fb.invoke('http.get', params).then(function (init) {
      if (!init) throw new Error('宿主没有响应');
      if (init.async !== true || !init.requestId) {
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
            fb.invoke('http.abort', { requestId: init.requestId }).catch(function () {});
            reject(new Error('超时:' + tag));
          }, ms)
        };
      });
    });
  }

  function getJson(url, opt) {
    opt = opt || {};
    return hostHttp({
      url: url,
      headers: opt.headers,
      ms: opt.ms || 15000,
      tag: opt.tag || 'bili'
    }).then(function (r) {
      var body = (r && r.body) || '';
      try {
        return JSON.parse(body);
      } catch (e) {
        _netErr++;
        throw new Error('返回不是 JSON（HTTP ' + ((r && r.status) || '?') + '）');
      }
    }, function (e) {
      _netErr++;
      throw e;
    });
  }

  /* ------------------------------------------------------------
   * buvid（未登录也要带）
   * ---------------------------------------------------------- */
  var _buvid = null;
  var _buvidFailAt = 0;
  var BUVID_FAIL_RETRY = 60 * 1000;

  function ensureBuvid() {
    if (_buvid) return Promise.resolve(_buvid);
    // 失败/空结果**不进缓存**：空 buvid 缓存住会让本会话所有 WBI 请求都不带
    // Cookie、-403 重签也救不回，唯一恢复手段变成本来就难遇的刷新页面。
    // 只做 60 秒冷却，别一次瞬时失败就反复打 spi。
    if (_buvidFailAt && Date.now() - _buvidFailAt < BUVID_FAIL_RETRY) {
      return Promise.resolve({ b3: '', b4: '' });
    }
    return getJson(API + '/x/frontend/finger/spi', { ms: 10000, tag: 'spi' }).then(function (j) {
      var d = (j && j.data) || {};
      var b3 = d.b_3 || '', b4 = d.b_4 || '';
      if (b3 || b4) { _buvid = { b3: b3, b4: b4 }; return _buvid; }
      _buvidFailAt = Date.now();
      return { b3: '', b4: '' };
    }, function () {
      // 拿不到也继续：搜索/取流本身不需要 buvid，只是更容易被风控
      _buvidFailAt = Date.now();
      return { b3: '', b4: '' };
    });
  }

  function headers(extra) {
    var h = {
      'User-Agent': UA,
      Referer: SITE + '/',
      Origin: SITE
    };
    if (_buvid && (_buvid.b3 || _buvid.b4)) {
      h.Cookie = (_buvid.b3 ? 'buvid3=' + _buvid.b3 + '; ' : '') +
                 (_buvid.b4 ? 'buvid4=' + _buvid.b4 : '');
    }
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
    return h;
  }

  /* ------------------------------------------------------------
   * WBI 签名
   * ---------------------------------------------------------- */
  var mixinKeyEncTab = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
    14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
    21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
  ];
  var SIGN_TTL = 6 * 3600 * 1000;
  var _sign = { imgKey: '', subKey: '', at: 0 };
  var _signPending = null;

  function mixinKey(img, sub) {
    var orig = String(img || '') + String(sub || '');
    var out = '';
    for (var i = 0; i < mixinKeyEncTab.length; i++) out += orig.charAt(mixinKeyEncTab[i]);
    return out.slice(0, 32);
  }

  function ensureSign(force) {
    if (!force && _sign.imgKey && _sign.subKey && (Date.now() - _sign.at) < SIGN_TTL) {
      return Promise.resolve(_sign);
    }
    // 在途去重：签名未就绪时并发的多个 WBI 请求（如进页立刻搜索 + 解析）只发一份 nav。
    // 失败清掉在途标记，下一个请求照常重试；-403 重签（force）加入在途请求即可 ——
    // 那份请求本来就是新取的密钥，不必再打一次。
    if (_signPending) return _signPending;
    _signPending = ensureBuvid().then(function () {
      return getJson(API + '/x/web-interface/nav', { headers: headers(), ms: 12000, tag: 'nav' });
    }).then(function (j) {
      // 未登录时 code = -101，但 wbi_img 照常给 —— 只取密钥，不要求登录态
      var img = (j && j.data && j.data.wbi_img) || null;
      if (!img || !img.img_url || !img.sub_url) {
        throw new Error('拿不到 WBI 密钥（nav 接口没有返回 wbi_img）');
      }
      function keyOf(u) {
        u = String(u);
        return u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
      }
      _sign = { imgKey: keyOf(img.img_url), subKey: keyOf(img.sub_url), at: Date.now() };
      return _sign;
    }).then(function (s) {
      _signPending = null;
      return s;
    }, function (e) {
      _signPending = null;
      throw e;
    });
    return _signPending;
  }

  function wbiQuery(params, sign) {
    var all = {};
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      if (params[k] === undefined || params[k] === null) continue;
      all[k] = params[k];
    }
    all.wts = Math.round(Date.now() / 1000);
    var keys = Object.keys(all).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var v = String(all[keys[i]]).replace(/[!'()*]/g, '');
      parts.push(encodeURIComponent(keys[i]) + '=' + encodeURIComponent(v));
    }
    var query = parts.join('&');
    return query + '&w_rid=' + md5(query + mixinKey(sign.imgKey, sign.subKey));
  }

  /* 签名 GET：-403（签名过期 / 密钥轮换）自动重取密钥再试一次 */
  function apiGet(path, params, opt) {
    opt = opt || {};
    return ensureSign(opt.forceSign).then(function (sign) {
      return getJson(API + path + '?' + wbiQuery(params, sign), {
        headers: headers(), ms: opt.ms || 15000, tag: opt.tag || 'bili'
      });
    }).then(function (j) {
      if (j && j.code === -403 && !opt._retried) {
        opt._retried = true;
        opt.forceSign = true;
        return apiGet(path, params, opt);
      }
      return j;
    });
  }

  /* ------------------------------------------------------------
   * 数据归一
   * ---------------------------------------------------------- */
  var HTML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  // 搜索结果标题带 <em class="keyword"> 高亮标签、实体也是转义过的
  function cleanText(s) {
    return String(s == null ? '' : s)
      .replace(/<[^>]*>/g, '')
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, function (m, n) { return HTML_ENT[n] || m; })
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 封面地址常以 // 开头
  function fixUrl(u) {
    u = String(u == null ? '' : u);
    if (!u) return '';
    if (u.indexOf('//') === 0) return 'https:' + u;
    return u.replace(/^http:\/\//i, 'https://');
  }

  function parseDur(v) {
    if (typeof v === 'number') return v;
    var s = String(v == null ? '' : v).trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var p = s.split(':');
    var sec = 0;
    for (var i = 0; i < p.length; i++) sec = sec * 60 + (parseInt(p[i], 10) || 0);
    return sec;
  }

  /* ------------------------------------------------------------
   * 直链 → 曲目信息（歌名/歌手/封面/歌词匹配都要用）
   * ------------------------------------------------------------
   * 宿主对 URL 曲目查不出标签，主题靠 CM.registerOnlineName 注册的函数取名。
   * 这里把每次解析出来的直链与曲目信息记下来（持久化上限 400 条），
   * 键 = 直链文件名（不含查询串）：B 站的直链文件名里就带 aid/cid，够区分。
   * ---------------------------------------------------------- */
  var LS_URLMETA = 'cm.bili.urlmeta';
  var URLMETA_MAX = 400;
  var _urlMeta = null;

  function urlMetaMap() {
    if (_urlMeta) return _urlMeta;
    try { _urlMeta = JSON.parse(localStorage.getItem(LS_URLMETA) || '{}') || {}; }
    catch (e) { _urlMeta = {}; }
    return _urlMeta;
  }

  function urlKey(u) {
    var s = String(u || '').split('?')[0];
    var seg = s.slice(s.lastIndexOf('/') + 1);
    return seg.toLowerCase();
  }

  function rememberUrl(url, meta) {
    if (!url || !meta) return;
    var key = urlKey(url);
    if (!key) return;
    var map = urlMetaMap();
    map[key] = {
      bvid: meta.bvid || '', aid: meta.aid || 0, cid: meta.cid || 0,
      title: meta.title || '', artist: meta.artist || '', album: meta.album || '',
      pic: meta.pic || '', ts: Date.now()
    };
    var keys = Object.keys(map);
    if (keys.length > URLMETA_MAX) {
      keys.sort(function (a, b) { return (map[a].ts || 0) - (map[b].ts || 0); });
      for (var i = 0; i < keys.length - URLMETA_MAX; i++) delete map[keys[i]];
    }
    try { localStorage.setItem(LS_URLMETA, JSON.stringify(map)); } catch (e) {}
  }

  function metaFromUrl(u) {
    var key = urlKey(u);
    if (!key) return null;
    var rec = urlMetaMap()[key];
    return rec || null;
  }

  /* B 站音视频直链的域名白名单（封面 hdslb 不在内：那是图片，不是音源） */
  var MEDIA_HOST_RE = /(?:^https?:\/\/)(?:[\w-]+\.)*(?:bilivideo\.com|bilivideo\.cn|akamaized\.net|szbdyd\.com|hdslb\.com\/[^/]*\/(?:upgcxcode|v1\/resource)|mcdn\.bilivideo|xycdn\.com)/i;

  function isBiliUrl(u) {
    u = String(u || '');
    if (!/^https?:\/\//i.test(u)) return false;
    if (!MEDIA_HOST_RE.test(u)) return false;
    // 图片/歌词接口不算音源
    return !/\.(?:jpg|jpeg|png|webp|gif|json)(?:\?|$)/i.test(u);
  }

  /* ------------------------------------------------------------
   * 搜索 / 详情 / 取流
   * ---------------------------------------------------------- */
  function search(keyword, page) {
    var kw = String(keyword || '').trim();
    if (!kw) return Promise.resolve({ ok: false, items: [], error: '请输入关键词' });
    page = Math.max(1, parseInt(page, 10) || 1);
    return apiGet('/x/web-interface/wbi/search/type', {
      search_type: 'video', keyword: kw, page: page
    }, { ms: 15000, tag: 'bili-search' }).then(function (j) {
      if (!j || j.code !== 0) {
        throw new Error('搜索失败' + (j && j.code != null ? '（code ' + j.code + '）' : ''));
      }
      var d = j.data || {};
      var list = d.result || [];
      var items = [];
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (!v || !v.bvid) continue;
        items.push({
          bvid: v.bvid,
          aid: v.aid || 0,
          title: cleanText(v.title),
          artist: cleanText(v.author),
          duration: parseDur(v.duration),
          pic: fixUrl(v.pic),
          play: v.play != null ? v.play : 0
        });
      }
      return { ok: true, items: items, page: page, numResults: d.numResults || 0, numPages: d.numPages || 0 };
    });
  }

  /* 视频详情：接受 bvid 字符串，或 {bvid} / {aid}
     ------------------------------------------------------------
     aid 这条路径有两个用处：① 界面支持 av 号链接；② 映射丢了（localStorage 被
     清 / 超过 400 条被裁）时，直链文件名里还剩 aid，用它把 bvid + cid 找回来。
     官方 wbi/view 同时认 bvid 与 aid（实测见 AGENTS 第十一轮）。 */
  function videoDetail(sel) {
    var params = {};
    if (typeof sel === 'string') params.bvid = sel;
    else if (sel && sel.bvid) params.bvid = sel.bvid;
    else if (sel && sel.aid) params.aid = sel.aid;
    if (!params.bvid && !params.aid) return Promise.reject(new Error('缺少 bvid / aid'));
    return apiGet('/x/web-interface/wbi/view', params, { ms: 12000, tag: 'bili-view' })
      .then(function (j) {
        if (!j || j.code !== 0) {
          throw new Error('取视频详情失败' + (j && j.code != null ? '（code ' + j.code + '）' : '') +
                          (j && j.message ? '：' + j.message : ''));
        }
        var d = j.data || {};
        var pages = [];
        (d.pages || []).forEach(function (p) {
          if (p && p.cid) pages.push({ cid: p.cid, part: p.part || '', duration: p.duration || 0 });
        });
        if (!pages.length && d.cid) {
          pages.push({ cid: d.cid, part: d.title || '', duration: d.duration || 0 });
        }
        return {
          bvid: d.bvid || params.bvid || '',
          aid: d.aid || params.aid || 0,
          cid: pages.length ? pages[0].cid : 0,
          title: d.title || '',
          artist: (d.owner && d.owner.name) || '',
          pic: fixUrl(d.pic),
          duration: d.duration || 0,
          pages: pages
        };
      });
  }

  /* 取音频地址（见文件头：固定 html5 档，免 Referer，宿主流播直接可用）
     ------------------------------------------------------------
     回的是**所有分段**（durl 数组）：短音频只有 1 段，长视频会被切成多段，
     每段是同一个 MP4 的字节区间。流播只吃第一段（宿主跟着 Range 续传，
     位置也只在第一段的时长内），下载则必须按顺序拼起来 —— 这才是把
     durl 整表留在这里、而不是只挑 first 的原因。 */
  function audioParts(bvid, cid) {
    return apiGet('/x/player/wbi/playurl', {
      bvid: bvid, cid: cid, fnval: 0, platform: 'html5', high_quality: 1
    }, { ms: 15000, tag: 'bili-url' }).then(function (j) {
      if (!j || j.code !== 0) {
        throw new Error('取音源失败' + (j && j.code != null ? '（code ' + j.code + '）' : '') +
                        (j && j.message ? '：' + j.message : ''));
      }
      var d = j.data || {};
      var segs = (d.durl || []).filter(function (s) { return s && s.url; });
      if (!segs.length) throw new Error('这个视频没有可用的音频地址（可能需要大会员 / 已下架）');
      var size = 0, length = 0;
      segs.forEach(function (s) { size += s.size || 0; length += s.length || 0; });
      return {
        urls: segs.map(function (s) { return s.url; }),
        size: size, length: length,
        quality: d.quality || 0, format: d.format || ''
      };
    });
  }

  function audioUrl(bvid, cid) {
    return audioParts(bvid, cid).then(function (r) {
      return { url: r.urls[0], quality: r.quality, length: r.length };
    });
  }

  /* 一首（一个视频的某一 P）→ 可播放直链 + 记下歌名映射 */
  function resolveTrack(track) {
    track = track || {};
    var meta = {
      bvid: track.bvid || '', aid: track.aid || 0, cid: track.cid || 0,
      title: track.title || '', artist: track.artist || '', album: track.album || '',
      pic: track.pic || ''
    };
    var step = meta.cid
      ? Promise.resolve(meta)
      : videoDetail(meta.bvid).then(function (d) {
          meta.cid = d.cid;
          meta.aid = meta.aid || d.aid;
          meta.title = meta.title || d.title;
          meta.artist = meta.artist || d.artist;
          meta.pic = meta.pic || d.pic;
          return meta;
        });
    return step.then(function (m) {
      if (!m.bvid || !m.cid) throw new Error('缺少 bvid / cid，无法取流');
      return audioUrl(m.bvid, m.cid).then(function (r) {
        rememberUrl(r.url, m);
        return { url: r.url, quality: r.quality, length: r.length, meta: m };
      });
    });
  }

  /* 批量解析：并发 2（逐首两次往返，再快容易触发风控），结果保序 */
  function resolveMany(tracks) {
    tracks = (tracks || []).slice();
    var out = new Array(tracks.length);
    var next = 0;
    var failed = [];
    function worker() {
      var i = next++;
      if (i >= tracks.length) return Promise.resolve();
      return resolveTrack(tracks[i]).then(function (r) {
        out[i] = r.url;
      }, function (e) {
        failed.push((tracks[i].title || tracks[i].bvid || '?') + '（' + ((e && e.message) || '解析失败') + '）');
      }).then(worker);
    }
    var workers = [];
    for (var w = 0; w < Math.min(2, tracks.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () {
      return { urls: out.filter(Boolean), failed: failed };
    });
  }

  /* 下载用批量解析：每首 → 完整分段列表 + 元信息（并发 2、保序、失败汇总）。
     与 resolveMany（只要可播 URL）分开：下载要拼所有段、要拿到歌名歌手做文件名，
     而且不能因为某一首失败就丢掉它在计划里的位置。 */
  function resolveForDownload(tracks) {
    tracks = (tracks || []).slice();
    var out = new Array(tracks.length);
    var failed = [];
    var next = 0;
    function one(t) {
      var meta = {
        bvid: t.bvid || '', aid: t.aid || 0, cid: t.cid || 0,
        title: t.title || '', artist: t.artist || '', album: t.album || '',
        pic: t.pic || ''
      };
      var step = meta.cid ? Promise.resolve(meta) : videoDetail(meta.bvid).then(function (d) {
        meta.cid = d.cid;
        meta.aid = meta.aid || d.aid;
        meta.title = meta.title || d.title;
        meta.artist = meta.artist || d.artist;
        meta.pic = meta.pic || d.pic;
        return meta;
      });
      return step.then(function (m) {
        if (!m.bvid || !m.cid) throw new Error('缺少 bvid / cid，无法取流');
        return audioParts(m.bvid, m.cid).then(function (r) {
          rememberUrl(r.urls[0], m);
          return {
            urls: r.urls, size: r.size, length: r.length,
            title: m.title, artist: m.artist, duration: t.duration || Math.round(r.length / 1000)
          };
        });
      });
    }
    function worker() {
      var i = next++;
      if (i >= tracks.length) return Promise.resolve();
      return one(tracks[i]).then(function (r) {
        out[i] = r;
      }, function (e) {
        failed.push((tracks[i].title || tracks[i].bvid || '?') + '（' + ((e && e.message) || '解析失败') + '）');
      }).then(worker);
    }
    var workers = [];
    for (var w = 0; w < Math.min(2, tracks.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () {
      return { items: out.filter(Boolean), failed: failed };
    });
  }

  /* 播放前刷新直链：B 站直链带 e/deadline 签名，几小时后就 403 —— 宿主打不开
     会直接跳下一首。按记下的 bvid/cid 重新取一次（地址变了也重新记映射）。
     映射丢了（localStorage 被清 / 超过 400 条被裁）就没法救：直链文件名里那个
     数字是 **cid**，不是 aid（实测 `279786_da3-1-16.mp4` 对应 av170001 的 cid=279786），
     而 `wbi/view`、`player/pagelist`、`player/wbi/playurl` 都不接受只有 cid（全为
     `-400 请求错误`）—— 别再试着从 URL 里反推视频了，反推不出来。 */
  function refreshUrl(u) {
    var meta = metaFromUrl(u);
    if (!meta || !meta.bvid || !meta.cid) {
      var e0 = new Error('这条直链的映射丢了（可能被 400 条上限裁掉），重新搜索这个视频再播一次即可');
      e0.cmUnidentifiable = true;
      return Promise.reject(e0);
    }
    return audioUrl(meta.bvid, meta.cid).then(function (r) {
      rememberUrl(r.url, meta);
      return r.url;
    });
  }

  function onlineName(path) {
    var m = metaFromUrl(path);
    return m ? { title: m.title, artist: m.artist, album: m.album } : null;
  }

  if (CM && CM.registerOnlineName) CM.registerOnlineName(onlineName);

  /* ------------------------------------------------------------
   * 封面
   * ------------------------------------------------------------
   * 搜索 / 详情回包里自带 pic（`//i0.hdslb.com/bfs/archive/xxx.jpg`）。
   * 实测：免登录、**免 Referer**，加 `@480w_480h_1c.webp` 后缀由 CDN 缩图
   * （原图常 200~600KB，缩完约 20KB 的 webp）。
   * 但取图仍然走宿主 HTTP 转 data URL，而不是把 CDN 地址直接挂到 <img>：
   * 主题要拿封面取主色调，`canvas.getImageData` 对跨域图片会抛 SecurityError，
   * 只有同源（data URL）才能取色 —— 与网易云桥接同一套理由。
   * ---------------------------------------------------------- */
  var COVER_MAX = 30;
  var _coverCache = Object.create(null);      // 图片地址 → dataURL | 原始地址 | ''
  var _coverPending = Object.create(null);

  function coverUrl(pic, size) {
    var u = fixUrl(pic);
    if (!u) return '';
    if (size === false) return u;
    // 已经带图片处理后缀（@xxx.webp 之类）就不再叠加
    if (/@[^/]*\.(?:webp|jpg|jpeg|png)$/i.test(u)) return u;
    var s = size || 480;
    return u + '@' + s + 'w_' + s + 'h_1c.webp';
  }

  function coverDataUrl(pic) {
    var url = coverUrl(pic);
    if (!url) return Promise.resolve('');
    if (_coverCache[url] !== undefined) return Promise.resolve(_coverCache[url]);
    if (_coverPending[url]) return _coverPending[url];

    var p = hostHttp({
      url: url, responseType: 'binary', ms: 10000, tag: 'bili-cover'
    }).then(function (r) {
      var ct = 'image/webp';
      var h = (r && r.headers) || {};
      var ctKey = h['content-type'] || h['Content-Type'];
      if (ctKey) ct = String(ctKey).split(';')[0];
      if (r && r.status >= 200 && r.status < 300 && r.body) return 'data:' + ct + ';base64,' + r.body;
      return url;      // 下载失败退回原始地址：<img> 能显示，取色会失败
    }, function () {
      return url;
    }).then(function (v) {
      delete _coverPending[url];
      _coverCache[url] = v;
      var keys = Object.keys(_coverCache);
      if (keys.length > COVER_MAX) {
        for (var i = 0; i < (keys.length >> 1); i++) delete _coverCache[keys[i]];
      }
      return v;
    });
    _coverPending[url] = p;
    return p;
  }

  /* 播放路径 → 封面：先按直链反查记下的视频，再取图 */
  function coverDataUrlForTrack(trackPath) {
    var meta = metaFromUrl(trackPath);
    if (!meta || !meta.pic) return Promise.resolve('');
    return coverDataUrl(meta.pic);
  }

  /* 这条直链是什么时候签发的（播放前判断"还要不要重新解析"用）。
     B 站把到期时间直接写进了直链（deadline=），见 playback-model.js —— 这里只是兜底。 */
  function pathIssuedAt(u) {
    var m = metaFromUrl(u);
    return (m && m.ts) || 0;
  }


  /* 从链接 / BV 号 / av 号里抠 bvid 或 aid（支持 ?p=N 分 P）。
     av 号走 wbi/view 的 aid 参数（实测可用），界面不再提示"不支持"。 */
  function parseInput(text) {
    var s = String(text || '').trim();
    if (!s) return null;
    var p = /[?&]p=(\d+)/i.exec(s);
    var page = p ? parseInt(p[1], 10) : 0;
    var bv = /(BV[0-9A-Za-z]{10})/.exec(s);
    if (bv) return { bvid: bv[1], page: page };
    var av = /(?:^|\/|av)(\d{5,})/i.exec(s);
    if (av) return { aid: parseInt(av[1], 10), page: page };
    return null;
  }

  function bridgeInfo() {
    return {
      version: VERSION,
      signed: !!(_sign.imgKey && _sign.subKey),
      signAge: _sign.at ? Math.round((Date.now() - _sign.at) / 1000) + 's' : '-',
      buvid: !!(_buvid && (_buvid.b3 || _buvid.b4)),
      urlMeta: Object.keys(urlMetaMap()).length,
      netErrors: _netErr,
      inflight: Object.keys(_inflight).length
    };
  }

  window.BilibiliBridge = {
    version: VERSION,
    search: search,
    videoDetail: videoDetail,
    resolveTrack: resolveTrack,
    resolveMany: resolveMany,
    resolveForDownload: resolveForDownload,
    refreshUrl: refreshUrl,
    audioUrl: audioUrl,
    audioParts: audioParts,
    metaFromUrl: metaFromUrl,
    pathIssuedAt: pathIssuedAt,
    coverUrl: coverUrl,
    coverDataUrl: coverDataUrl,
    coverDataUrlForTrack: coverDataUrlForTrack,
    onlineName: onlineName,
    isBiliUrl: isBiliUrl,
    parseInput: parseInput,
    md5: md5,
    netErrors: function () { return _netErr; },
    bridgeInfo: bridgeInfo
  };
})();
