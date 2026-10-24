/* ============================================
 * CloudMusic artwork-resolver.js v2 — 封面「就近兜底」（页内原生版）
 *
 * 为什么需要（2026-09-16）：
 *   foobar2000 的专辑封面只在**音频所在的那个目录**里按
 *   front.* / cover.* / folder.* 去找。子目录不看，上一级目录也不看。
 *   实测两个「有封面但显示不出来」的专辑：
 *     * Eagles《Hotel California》DSD：
 *         音频在  ...\Eagles ...\DSDIFF分轨\01 - HOTEL CALIFORNIA.dff
 *         封面在  ...\Eagles ...\Artworks\front.jpg          ← 同级，差一层
 *     * 张宇《悲伤情歌》DSD：
 *         音频在  张宇 -《悲伤情歌DSD》[低速原抓WAV+CUE]\
 *         封面在  ...\张宇 -《悲伤情歌DSD》[低速原抓WAV+CUE]\Artwork\  ← 子目录
 *   而且这台 foobar2000（WebView2 UI）连「显示 > 专辑封面」这个设置页都没有，
 *   搜索模式无处可改。宿主 API 也明确拒绝 `..` 遍历
 *   （artwork.getFolderImages: "Path traversal detected"）。
 *
 * 做法（2026-09-29 页内原生版）：
 *   封面捞取在**页面里**用宿主原生文件 API 完成：
 *     1) 宿主 file.list 列出【音频目录 → 其封面子目录 → 上一级目录 →
 *        上一级的封面子目录】里的图片（front/cover/folder… 按名字打分）；
 *     2) 宿主 file.read(binary) 读出得分最高的那张 → base64 → dataURL；
 *     3) 经 CM.api 钩子回给 <img>/background-image。
 *   注意：宿主对系统盘路径有白名单限制（实测 profile 目录 read 被拒），
 *   但媒体库所在的非系统盘路径 file.list / file.read 都可用 —— 与
 *   lyrics-resolver.js 读 .lrc 是同一套权限，实测正常。
 *
 * 加载位置：index.html 里排在 js/app.js 之前（app.js 初始化时会立刻取封面）。
 * ============================================ */

(function () {
  'use strict';

  var CM = window.CloudMusic;
  if (!CM || typeof CM.api !== 'function') return;

  var BS = String.fromCharCode(92);              // 反斜杠
  var ENABLED_KEY = 'cm.artworkFallback';

  /* 可用开关（默认开）：DevTools 里 CM.artworkFallback(false) 可关掉排查 */
  var enabled = true;
  try {
    if (localStorage.getItem(ENABLED_KEY) === '0') enabled = false;
  } catch (e) {}

  /* ============================================
   * 诊断状态（DevTools: CM.artworkStatus()）
   * ============================================ */
  var lastStatus = { state: 'idle', hooked: 0, asked: 0, hits: 0,
                     misses: 0, rawFallback: 0, last: '' };

  /* ============================================
   * 图片筛选与打分表
   * ============================================ */
  var IMG_EXT = { jpg: 1, jpeg: 1, jpe: 1, png: 1, bmp: 1, gif: 1, webp: 1, jfif: 1 };
  var MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
               jfif: 'image/jpeg', png: 'image/png', bmp: 'image/bmp',
               gif: 'image/gif', webp: 'image/webp' };
  /* 封面子目录名（命中其一才算「封面目录」） */
  var ART_DIR_WORDS = ['artwork', 'art', 'cover', 'scan', '封面', '图片'];
  /* 负面词：命中说明多半是封底 / 内页扫描 */
  var BACK_WORDS = ['back', 'rear', 'backcover', 'rearcover', '封底', 'disc',
                    'disk', 'cd', 'obi', 'inlay', 'booklet', 'inside', 'tray',
                    'matrix', 'label'];
  /* 正面词：文件名里带这些的优先 */
  var FRONT_WORDS = ['front', 'cover', 'folder', 'album', 'albumart', 'case',
                     'frontcover', 'coverfront', 'main', 'default', '封面', '专辑封面'];

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }
  function isImage(name) { return !!IMG_EXT[extOf(name)]; }
  function hasWord(lowerName, words) {
    for (var i = 0; i < words.length; i++) {
      if (lowerName.indexOf(words[i]) >= 0) return true;
    }
    return false;
  }
  function isArtDir(name) {
    var n = String(name || '').toLowerCase();
    return hasWord(n, ART_DIR_WORDS);
  }
  /* 文件名打分：正面词 6 / 中性 2 / 负面词 -5 */
  function nameTier(name) {
    var n = String(name || '').toLowerCase();
    if (hasWord(n, BACK_WORDS)) return -5;
    if (hasWord(n, FRONT_WORDS)) return 6;
    return 2;
  }
  /* 「10」 < 「9」 的自然序修正：数字段前补零再比较 */
  function natKey(name) {
    return String(name || '').replace(/\d+/g, function (m) {
      return ('000000000' + m).slice(-10);
    });
  }

  /* ============================================
   * 宿主 file.list 归一（回包形状不统一，这里兜成 {dirs[], files[]}）
   * ============================================ */
  var origApi = CM.api;                          // 直接走宿主原方法，绕开本文件的钩子
  function api(method, params) { return origApi.call(CM, method, params); }
  function nameOf(e) {
    if (e == null) return '';
    if (typeof e === 'string') return e;
    return String((e && (e.name || e.path || e.fileName || e.fullName)) || '');
  }
  function listDir(dir) {
    return api('file.list', { path: dir }).then(function (r) {
      var dirs = null, files = null, k;
      if (r && typeof r === 'object') {
        var dirKeys = ['directories', 'dirs', 'subdirs', 'folders'];
        var fileKeys = ['files', 'entries', 'items', 'list', 'children'];
        for (k = 0; k < dirKeys.length && !dirs; k++) {
          if (Array.isArray(r[dirKeys[k]])) dirs = r[dirKeys[k]];
        }
        for (k = 0; k < fileKeys.length && !files; k++) {
          if (Array.isArray(r[fileKeys[k]])) files = r[fileKeys[k]];
        }
      } else if (Array.isArray(r)) {
        files = r;
      }
      var dNames = [], fNames = [], i;
      for (i = 0; dirs && i < dirs.length; i++) {
        var d = nameOf(dirs[i]).replace(/[\\/]+$/, '');
        if (d) dNames.push(d.split(/[\\/]/).pop());
      }
      for (i = 0; files && i < files.length; i++) {
        var f = nameOf(files[i]).replace(/[\\/]+$/, '');
        if (f) fNames.push(f.split(/[\\/]/).pop());
      }
      return { dirs: dNames, files: fNames };
    }, function () { return { dirs: [], files: [] }; });
  }

  /* ============================================
   * 目录计划：音频目录 → 封面子目录 → 上一级 → 上一级的封面子目录
   * 每个候选带「目录加分」，封面子目录的正面图会赢过上级目录的杂图
   * ============================================ */
  function dirOf(p) {
    var s = String(p || '');
    var i = s.lastIndexOf(BS);
    return i > 0 ? s.slice(0, i) : '';
  }
  function parentOf(dir) {
    var i = dir.lastIndexOf(BS);
    if (i <= 2) return '';                          // 到盘根为止，不再往上
    return dir.slice(0, i);
  }
  function scanPlan(trackPath, listDirs) {
    var dir = dirOf(trackPath);
    if (!dir) return Promise.resolve([]);
    return listDirs(dir).then(function (top) {
      var plan = [];
      plan.push({ dir: dir, bonus: 3 });
      top.dirs.forEach(function (d) {
        if (isArtDir(d)) plan.push({ dir: dir + BS + d, bonus: 2 });
      });
      var up = parentOf(dir);
      if (up) {
        plan.push({ dir: up, bonus: 1 });
        return listDirs(up).then(function (upper) {
          upper.dirs.forEach(function (d) {
            if (isArtDir(d) && plan.every(function (e) { return e.dir !== up + BS + d; })) {
              plan.push({ dir: up + BS + d, bonus: 0 });
            }
          });
          return plan;
        });
      }
      return plan;
    });
  }

  /* 依次扫计划里的目录，收集打分后的图片候选，返回最高分的那张 */
  function pickImage(plan, listDirs) {
    var best = null;                                // { dir, name, score }
    function scoreOf(entry, name) {
      return entry.bonus + nameTier(name);
    }
    function step(i) {
      if (i >= plan.length) return Promise.resolve(best);
      var entry = plan[i];
      return listDirs(entry.dir).then(function (r) {
        var imgs = r.files.filter(isImage);
        imgs.sort(function (a, b) {
          var d = scoreOf(entry, b) - scoreOf(entry, a);
          if (d !== 0) return d;
          return natKey(a) < natKey(b) ? -1 : (natKey(a) > natKey(b) ? 1 : 0);
        });
        for (var j = 0; j < imgs.length; j++) {
          var sc = scoreOf(entry, imgs[j]);
          if (!best || sc > best.score) {
            best = { dir: entry.dir, name: imgs[j], score: sc };
          }
        }
        return step(i + 1);
      });
    }
    return step(0);
  }

  function readAsDataUrl(dir, name) {
    return api('file.read', { path: dir + BS + name, encoding: 'binary' })
      .then(function (fr) {
        if (!fr || fr.success === false || !fr.content) return '';
        return 'data:' + (MIME[extOf(name)] || 'application/octet-stream') +
               ';base64,' + fr.content;
      }, function () { return ''; });
  }

  /* 一条音频路径 → 封面 dataURL（找不到回 ''）。
     listDirs：本次查找内的列目录 memo —— scanPlan 与 pickImage 会先后看
     同一批目录（音频目录 / 封面子目录 / 上一级），不复用的话每个目录要列两次。 */
  function lookupArtwork(trackPath) {
    var once = Object.create(null);                 // dir -> Promise<{dirs,files}>
    function listDirs(dir) {
      if (!once[dir]) once[dir] = listDir(dir);
      return once[dir];
    }
    return scanPlan(trackPath, listDirs).then(function (plan) {
      if (!plan.length) return '';
      return pickImage(plan, listDirs).then(function (best) {
        if (!best) { lastStatus.state = 'miss'; return ''; }
        return readAsDataUrl(best.dir, best.name);
      });
    });
  }

  /* ============================================
   * 目录级会话缓存：一张专辑问一次（dataURL 很占内存，上限压低）
   * ============================================ */
  var dirCache = Object.create(null);            // dir -> dataURL | ''
  var dirPending = Object.create(null);          // dir -> Promise<dataURL|''>
  var CACHE_MAX = 40;

  function cacheTrim() {
    var keys = Object.keys(dirCache);
    if (keys.length <= CACHE_MAX) return;
    for (var i = 0; i < (keys.length >> 1); i++) delete dirCache[keys[i]];
  }

  /* file:// 前缀与 CUE 的 |subsong 后缀都不参与目录判断 */
  function cleanPath(p) {
    return String(p || '').replace(/^file:\/\//i, '').split('|')[0];
  }

  /* ============================================
   * 在线音源（QQ 音乐 / 网易云 CDN 直链）的封面
   * ============================================
   * 在线曲目的「路径」是 http 直链 —— 宿主原生封面取不到，文件系统里
   * 也无处可扫。两个平台各自想办法把直链反查回专辑图：
   *   · QQ 音乐：直链文件名自带 mediaMid（C400<mediaMid>.m4a），
   *     ui-qqmusic 播放 / 下载时记下 mediaMid→albummid 映射；
   *   · 网易云：直链文件名是音频 md5（不含歌曲 id），
   *     ui-netease 播放 / 下载时记下 md5→{id, 封面直链} 映射。
   * 取图统一交给对应桥接模块（下面按直链归属分发）。
   *
   * 为什么取图交给桥接模块：
   *   · 必须走宿主 HTTP 客户端（无 CORS）：直接把 CDN 的原始 URL
   *     交给取色器会因跨域在 canvas.getImageData 抛 SecurityError，
   *     封面颜色永远取不到。宿主下载后转 data URL 就和本地文件同链路。
   *   · 必须异步 + 带缓存：下载与缓存都在桥接里做（async:false 下载一张
   *     封面会冻住 foobar 主线程整个下载时长；而切歌 / 翻页 / 列表重绘会
   *     反复要同一张图）。
   * ============================================ */
  /* 这条直链属于哪个在线音源（'' = 不是在线曲目）。
     按域名/文件名特征判断，**不要求**映射表里已经有记录 ——
     有记录才有图，但"是在线曲目"这件事本身要认出来（否则会去扫磁盘目录）。 */
  function onlineProviderOf(trackPath) {
    var p = String(trackPath || '');
    if (!/^https?:\/\//i.test(p)) return '';
    if (window.NeteaseBridge && typeof NeteaseBridge.isNeteaseUrl === 'function' &&
        NeteaseBridge.isNeteaseUrl(p)) return 'netease';
    if (window.QQBridge && typeof QQBridge.mediaMidFromUrl === 'function' &&
        QQBridge.mediaMidFromUrl(p)) return 'qq';
    // B 站：域名白名单判断（hdslb 封面 / 图片不算音源，见 bilibili-core.js 的 isBiliUrl）
    if (window.BilibiliBridge && typeof BilibiliBridge.isBiliUrl === 'function' &&
        BilibiliBridge.isBiliUrl(p)) return 'bili';
    return '';
  }

  function askOnline(trackPath) {
    var prov = onlineProviderOf(trackPath);
    if (!prov) return Promise.resolve('');
    lastStatus.asked++;
    var job;
    if (prov === 'netease') job = NeteaseBridge.coverDataUrlForTrack(trackPath);
    else if (prov === 'bili') job = BilibiliBridge.coverDataUrlForTrack(trackPath);
    else job = QQBridge.coverDataUrl(QQBridge.mediaMidFromUrl(trackPath));
    return job.then(function (url) {
      if (!url) {
        lastStatus.misses++; lastStatus.state = 'miss';
        return '';
      }
      if (url.indexOf('data:') === 0) {
        lastStatus.hits++; lastStatus.state = 'hit'; lastStatus.last = trackPath;
      } else {
        /* 宿主下载失败退回原始 URL：<img> 能显示，取色会失败 —— 单独计数，
           别让诊断信息显示成"命中"（否则排查取色问题时看不出差别） */
        lastStatus.rawFallback++; lastStatus.state = 'raw'; lastStatus.last = trackPath;
      }
      return url;
    }, function () {
      lastStatus.misses++; lastStatus.state = 'miss';
      return '';
    });
  }

  /* 是在线音源直链吗？（QQ / 网易云任一，且不是本地盘路径） */
  function isOnlineTrack(trackPath) {
    return !!onlineProviderOf(trackPath);
  }

  /* 宿主的封面回包能否直接用？
     · 本地文件：fb2k://artwork/?path=<本地路径> 是宿主的代理地址，<img> 能加载 —— 可用；
     · 在线直链：宿主同样发 fb2k://artwork/?path=<http直链>，但在线流的内嵌封面
       它取不到，<img> 必然加载失败回落 no_cover —— 不能当作成功，要交给在线兜底。 */
  function nativeLooksUsable(r, trackPath) {
    if (!r || r.available === false || r.success === false) return false;
    var d = String(r.dataUrl || r.url || '');
    if (!d) return false;
    if (/^fb2k:\/\//i.test(d) && /^https?:\/\//i.test(String(trackPath || ''))) return false;
    return true;
  }

  function askOne(trackPath) {
    trackPath = cleanPath(trackPath);
    if (isOnlineTrack(trackPath)) return askOnline(trackPath);
    var dir = dirOf(trackPath);
    if (!dir) return Promise.resolve('');
    if (dirCache[dir] !== undefined) return Promise.resolve(dirCache[dir]);
    if (dirPending[dir]) return dirPending[dir];

    var p = lookupArtwork(trackPath).then(function (url) {
      if (dir) { dirCache[dir] = url; cacheTrim(); }
      lastStatus.asked++;
      if (url) {
        lastStatus.hits++; lastStatus.state = 'hit'; lastStatus.last = dir;
      } else {
        lastStatus.misses++; lastStatus.state = 'miss';
      }
      return url;
    }).catch(function () {
      lastStatus.state = 'error';               // 文件 API 不可用：静默失败
      return '';
    }).then(function (url) {
      if (dir) delete dirPending[dir];
      return url;
    });

    if (dir) dirPending[dir] = p;
    return p;
  }

  function askBatch(paths) {
    // 逐条走 askOne：本地路径在 askOne 内部按目录去重合并，
    // 在线直链是纯映射查询，开销可忽略；统计也在 askOne 里累计。
    return Promise.all((paths || []).map(function (p) { return askOne(p); }))
      .then(function (urls) {
        lastStatus.state = urls.some(function (u) { return u; }) ? 'hit' : 'miss';
        return urls;
      });
  }

  /* ============================================
   * 包一层 CM.api（对调用方透明）
   * ============================================ */
  CM.api = function (method, params) {
    var call = origApi.apply(this, arguments);
    if (!enabled || typeof method !== 'string') return call;
    if (method.indexOf('artwork.') !== 0) return call;
    if (!(call && typeof call.then === 'function')) return call;

    /* --- 当前播放曲目（调用方不传 path，从 CM.currentTrack 取）--- */
    if (method === 'artwork.getFb2kUrl' || method === 'artwork.getCurrent') {
      var path0 = CM.trackPath ? CM.trackPath(CM.currentTrack) : '';
      return call.then(function (r) {
        if (nativeLooksUsable(r, path0)) return r;
        if (!path0) return r;
        return askOne(path0).then(function (url) {
          if (!url) return r;
          lastStatus.hooked++;
          return { available: true, success: true, dataUrl: url, url: url,
                   path: path0, type: (r && r.type) || 'front', fallback: 'inproc' };
        });
      }, function () {
        // 原生调用本身失败（在线直链曲目上会发生）—— 同样走兜底
        if (!path0) return { available: false };
        return askOne(path0).then(function (url) {
          if (!url) return { available: false };
          lastStatus.hooked++;
          return { available: true, success: true, dataUrl: url, url: url,
                   path: path0, type: 'front', fallback: 'inproc' };
        });
      });
    }

    /* --- 单条按路径 --- */
    if (method === 'artwork.getFb2kUrlByPath' || method === 'artwork.getForTrack') {
      var p1 = (params && params.path) || '';
      if (!p1) return call;
      return call.then(function (r) {
        if (nativeLooksUsable(r, p1)) return r;
        return askOne(p1).then(function (url) {
          if (!url) return r;
          lastStatus.hooked++;
          return { available: true, success: true, dataUrl: url, url: url,
                   path: p1, type: (r && r.type) || 'front', fallback: 'inproc' };
        });
      }, function () {
        return askOne(p1).then(function (url) {
          if (!url) return { available: false };
          lastStatus.hooked++;
          return { available: true, success: true, dataUrl: url, url: url,
                   path: p1, type: 'front', fallback: 'inproc' };
        });
      });
    }

    /* --- 批量按路径 --- */
    if (method === 'artwork.getFb2kUrlByPathBatch') {
      var ps = (params && params.paths) || [];
      if (!ps.length) return call;
      return call.then(function (r) {
        var list = (r && r.artworks) || [];
        var missing = [], missIdx = [], i;
        for (i = 0; i < ps.length; i++) {
          var e = list[i];
          // fb2k:// 代理地址对在线直链取不到图（img 会加载失败），按缺失处理
          if (nativeLooksUsable(e, ps[i])) continue;
          missing.push(ps[i]);
          missIdx.push(i);
        }
        if (!missing.length) return r;
        return askBatch(missing).then(function (urls) {
          var filled = 0;
          for (var k = 0; k < missIdx.length; k++) {
            var idx = missIdx[k], url = urls[k];
            if (!url) continue;
            if (!list[idx]) list[idx] = { success: true };
            list[idx].success = true;
            list[idx].dataUrl = url;
            list[idx].url = url;
            list[idx].fallback = 'inproc';
            filled++;
          }
          if (!r) r = {};
          r.artworks = list;
          lastStatus.hooked += filled;
          return r;
        });
      }, function () {
        return askBatch(ps).then(function (urls) {
          var list = [], filled = 0;
          for (var k = 0; k < ps.length; k++) {
            var url = urls[k];
            list[k] = url ? { success: true, dataUrl: url, url: url, fallback: 'inproc' }
                          : { success: false };
            if (url) filled++;
          }
          lastStatus.hooked += filled;
          return { artworks: list };
        });
      });
    }

    return call;
  };

  /* ============================================
   * 调试 / 手动刷新（DevTools）
   * ============================================ */
  CM.artworkStatus = function () { return lastStatus; };

  CM.artworkFallback = function (on) {
    if (on === undefined) return enabled;
    enabled = !!on;
    try { localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0'); } catch (e) {}
    lastStatus.state = enabled ? 'on' : 'off';
    return enabled;
  };

  /* 清缓存并重取当前封面（换了封面文件后不必重启 foobar） */
  CM.artworkReload = function () {
    dirCache = Object.create(null);
    dirPending = Object.create(null);
    if (window.QQBridge && QQBridge.coverCacheClear) QQBridge.coverCacheClear();
    if (window.NeteaseBridge && NeteaseBridge.coverCacheClear) NeteaseBridge.coverCacheClear();
    lastStatus.asked = lastStatus.hits = lastStatus.misses = lastStatus.rawFallback = 0;
    lastStatus.state = 'reloaded';
    if (typeof CM.loadCurrentArtwork === 'function') CM.loadCurrentArtwork();
    return true;
  };
})();
