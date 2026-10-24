/* ============================================================
 * CloudMusic 主题扩展 · 在线音源页通用件（online-common.js）
 * ------------------------------------------------------------
 * 「QQ 音乐」页（js/ui-qqmusic.js）与「网易云」页（js/ui-netease.js）
 * 共用的部分集中在这里，改一处两边都生效：
 *
 *   · 通用小工具：$ / mmss / copyText / toast / setStatus / api / apiOr
 *   · 下载落盘整条链路：宿主 http.download（异步 + http:downloadComplete
 *     事件）、同名 .lrc、下载目录（含旧目录自动迁移）、「下载保存到」条
 *   · 歌单写入：固定歌单的查找 / 创建 / 去重（宿主 playlist.* 抖动已在
 *     这里处理过一次，两页不必各写一遍）
 *   · 样式表：同一套规则按页面前缀生成（两页原本各存一份，已经漂移出
 *     三条差异规则 —— 现在只有一份）
 *
 * 页面各自保留：搜索与翻页、列表渲染与勾选、导入、播放编排。这些依赖各自
 * 平台的数据形状（QQ 是 songmid/mediaKey/avail，网易云是 id/level/trial），
 * 硬参数化反而更难读，所以刻意不合并。
 *
 * 用法：
 *   var K = CM.onlineCommon({ prefix:'nem', statusId:'nemStatus', ... });
 *   然后把 K.xxx 挂到本地同名变量，原有调用点一行都不用改。
 * ============================================================ */
(function () {
  'use strict';

  var CM = window.CloudMusic;
  if (!CM) return;

  /* 样式表：__P__ 会被替换成页面前缀（qqm / nem）。
     两个页面共用这一份 —— 同一套外观，不再各存各的。 */
  var CSS_RULES = [
    '.__P__-root{height:100%;display:flex;flex-direction:column;min-height:0;padding:16px 18px 12px;gap:12px}',
    '.__P__-head{display:flex;align-items:flex-start;gap:12px}',
    '.__P__-title{font-size:16px;font-weight:600;color:var(--text)}',
    '.__P__-sub{font-size:12px;color:var(--text-2);margin-top:3px}',
    '.__P__-sub.__P__-ok{color:#7ed49b}',
    '.__P__-sub.__P__-warn{color:#e0b070}',
    '.__P__-sub.__P__-err{color:#ff8188}',
    '.__P__-head-actions{margin-left:auto;display:flex;gap:8px;flex:none}',
    '.__P__-bar{display:flex;gap:8px;align-items:center;flex:none}',
    '.__P__-search{flex:1;display:flex;align-items:center;gap:8px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-m);padding:0 12px;height:36px}',
    '.__P__-search svg{width:15px;height:15px;flex:none;fill:none;stroke:var(--text-3);stroke-width:2;stroke-linecap:round}',
    '.__P__-search input{flex:1;background:none;border:none;outline:none;color:var(--text);font:inherit;height:100%}',
    '.__P__-select{height:36px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-m);color:var(--text);font:inherit;padding:0 8px;outline:none}',
    '.__P__-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;border-radius:var(--r-m);background:var(--bg-3);color:var(--text);font:inherit;cursor:pointer;border:1px solid var(--border);transition:var(--t-fast)}',
    '.__P__-btn:hover{background:var(--bg-4)}',
    '.__P__-btn:disabled{opacity:.42;cursor:not-allowed}',
    '.__P__-btn svg{width:13px;height:13px;fill:currentColor;stroke:none}',
    '.__P__-btn-primary{background:var(--accent);border-color:transparent;color:var(--on-accent)}',
    '.__P__-btn-primary:hover{filter:brightness(1.08)}',
    '.__P__-btn-sm{height:26px;padding:0 12px;font-size:12px}',
    // hidden 属性必须显式兜底：.__P__-btn{display:inline-flex} 会顶掉 [hidden] 的 display:none
    '.__P__-btn[hidden]{display:none!important}',
    '.__P__-toolbar{display:flex;align-items:center;gap:14px;flex:none;font-size:12px;color:var(--text-2)}',
    '.__P__-flex{flex:1}',
    '.__P__-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer}',
    '.__P__-check input{accent-color:var(--accent);cursor:pointer}',
    '.__P__-list{flex:1;min-height:0;overflow:auto;border:1px solid var(--border);border-radius:var(--r-l)}',
    '.__P__-rows{display:flex;flex-direction:column}',
    '.__P__-row{display:flex;align-items:center;gap:12px;padding:8px 14px;cursor:default;border-bottom:1px solid var(--border)}',
    '.__P__-row:last-child{border-bottom:none}',
    '.__P__-row:hover{background:var(--bg-2)}',
    '.__P__-row.sel{background:var(--accent-soft)}',
    '.__P__-cover{width:38px;height:38px;flex:none;border-radius:var(--r-s);overflow:hidden;background:var(--bg-3);display:flex;align-items:center;justify-content:center}',
    '.__P__-cover img{width:100%;height:100%;object-fit:cover;display:block}',
    '.__P__-meta{min-width:0;flex:1}',
    '.__P__-name{font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.__P__-artist{font-size:12px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.__P__-tag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;font-size:10px;line-height:15px;background:var(--accent-soft-2);color:var(--accent);vertical-align:1px}',
    '.__P__-tag-hi{background:rgba(232,74,58,.16);color:#e84a3a;font-weight:600}',
    '.__P__-tag-sq{background:rgba(64,150,255,.16);color:#4096ff}',
    '.__P__-tag-warn{background:rgba(224,176,112,.2);color:#e0b070}',
    '.__P__-dur{flex:none;font-size:12px;color:var(--text-3);font-variant-numeric:tabular-nums}',
    '.__P__-more{display:flex;justify-content:center;align-items:center;padding:14px 0 16px}',
    '.__P__-more-btn{min-width:190px}',
    '.__P__-more-hint{font-size:12px;color:var(--text-4)}',
    '.__P__-pager{display:none;align-items:center;gap:10px;flex:none;font-size:12px;color:var(--text-2);padding:10px 4px 0}',
    '.__P__-pager.on{display:flex}',
    '.__P__-page-info{font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.__P__-page-info b{color:var(--text);font-weight:600;margin:0 2px}',
    '.__P__-jump{display:flex;align-items:center;gap:6px;color:var(--text-3);white-space:nowrap}',
    '.__P__-jump input{width:54px;height:26px;text-align:center;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-s);color:var(--text);font:inherit;outline:none;font-variant-numeric:tabular-nums}',
    '.__P__-jump input:focus{border-color:var(--accent)}',
    '.__P__-jump input:disabled{opacity:.42;cursor:not-allowed}',
    // 面板自带 display:flex，[hidden] 必须显式兜底，否则永远挂在那儿
    '.__P__-setup{display:flex;flex-direction:column;gap:6px;flex:none;padding:10px 14px;border-radius:var(--r-m);border:1px solid rgba(224,176,112,.45);background:linear-gradient(rgba(224,176,112,.10),rgba(224,176,112,.10)),var(--bg-1)}',
    '.__P__-setup[hidden]{display:none!important}',
    '.__P__-setup-t{font-size:13px;font-weight:600;color:#e0b070}',
    '.__P__-setup-d{font-size:12px;line-height:1.6;color:var(--text-2)}',
    '.__P__-setup-d code{font-family:Consolas,Menlo,monospace;font-size:11px;color:var(--text-3)}',
    '.__P__-setup-d ol{margin:4px 0 0 18px;padding:0}',
    '.__P__-setup-d li{margin:2px 0}',
    '.__P__-setup-input{width:100%;min-height:60px;max-height:140px;resize:vertical;background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-s);color:var(--text);font-family:Consolas,Menlo,monospace;font-size:11px;padding:6px 8px;outline:none;line-height:1.5;user-select:text}',
    '.__P__-setup-input:focus{border-color:var(--accent)}',
    '.__P__-setup-cmd-row{display:flex;align-items:center;gap:8px}',
    '.__P__-setup-cmd{flex:1;padding:6px 10px;border-radius:var(--r-s);background:var(--bg-1);border:1px solid var(--border);color:var(--text);font-family:Consolas,Menlo,monospace;font-size:12px;user-select:text;overflow-x:auto;white-space:nowrap}',
    '.__P__-setup-a{display:flex;align-items:center;gap:8px;margin-top:2px}',
    '.__P__-setup-name{flex:1;height:26px;background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-s);color:var(--text);font:inherit;padding:0 8px;outline:none}',
    '.__P__-setup-name:focus{border-color:var(--accent)}',
    '.__P__-link{background:none;border:none;padding:0;margin-left:4px;color:var(--accent);font:inherit;cursor:pointer;text-decoration:underline}',
    '.__P__-link:hover{filter:brightness(1.15)}',
    '.__P__-dlrow{display:flex;align-items:center;gap:8px;flex:none;font-size:12px;color:var(--text-2)}',
    '.__P__-dlrow[hidden]{display:none!important}',
    '.__P__-dl-label{flex:none;color:var(--text-3)}',
    '.__P__-dl-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-s);padding:4px 8px;color:var(--text);font-family:Consolas,Menlo,monospace;font-size:11px;user-select:text;cursor:default}'
  ];

  /* clipboard API 不可用时的退路：textarea + execCommand。
     WebView2 里 navigator.clipboard 可能整个缺失、也可能存在但被策略挡到
     reject —— 老的 QQ 页实现两种都兜了，抽成公共件时漏掉，于是两页的
     「复制路径 / 复制导出脚本 / 复制命令」在这些环境下静默失败（只弹一句
     "复制失败"）。ui-lyrics.js 里的复制至今保留同一条兜底，这里对齐。 */
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------
   * 组装：按配置返回一套绑定好的通用件
   * ---------------------------------------------------------- */
  function makeKit(cfg) {
    cfg = cfg || {};
    var P = cfg.prefix || 'x';                       // 页面前缀（qqm / nem）
    var statusId = cfg.statusId || (P + 'Status');
    var setupId = cfg.setupId || (P + 'Setup');
    var cookieInputId = cfg.cookieInputId || (P + 'CookieInput');
    var dlRowId = cfg.dlRowId || (P + 'DlRow');
    var dlPathId = cfg.dlPathId || (P + 'DlPath');
    var cssId = cfg.cssId || (P + 'Style');
    var bridge = cfg.bridge || function () { return null; };   // → 桥接模块（QQBridge / NeteaseBridge）
    var dirName = cfg.dirName || 'downloads';        // 下载目录名（中文）
    var dirNameOld = cfg.dirNameOld || '';           // 旧目录名（自动迁移用）

    function $(id) { return document.getElementById(id); }
    function api(method, params) { return CM.api(method, params); }

    /* 写操作专用：失败必须 reject。CM.api 会把任何失败吞成 null
       （"调用没成功"和"返回 null"混为一谈），歌单写入用它就会出现
       「没写进去也报成功」甚至播错曲目（索引取 0）。 */
    function apiOr(method, params) {
      return fb.invoke(method, params || {}).then(function (r) {
        if (!r) throw new Error(method + '：宿主没有响应');
        // 失败信封是正常 resolve 的 {success:false}（真值）：漏掉这一判就会把
        // "宿主拒绝了这次写入"当成成功（与 core.js 的 CM.apiOr 保持同一判据）
        if (r.success === false) {
          var err = new Error(r.error || (method + '：宿主拒绝了这次调用'));
          err.code = r.code || 'FAILED';
          err.method = method;
          err.details = r.details;
          throw err;
        }
        return r;
      });
    }

    function mmss(v) {
      v = Math.max(0, parseInt(v, 10) || 0);
      return Math.floor(v / 60) + ':' + ('0' + (v % 60)).slice(-2);
    }

    function toast(title, sub, type) {
      if (CM.showToast) CM.showToast(title, sub, type || 'success');
    }

    function setStatus(text, kind) {
      var e = $(statusId);
      if (!e) return;
      e.textContent = text;
      e.className = P + '-sub' + (kind ? ' ' + P + '-' + kind : '');
    }

    function copyText(text, done) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true); },
                                                function () { done(legacyCopy(text)); });
      } else { done(legacyCopy(text)); }
    }

    /* ---------- 样式 ---------- */
    var css = CSS_RULES.join('\n').split('__P__').join(P);
    function injectCss() {
      if (document.getElementById(cssId)) return;
      var st = document.createElement('style');
      st.id = cssId;
      st.textContent = css;
      document.head.appendChild(st);
    }

    /* ---------- 歌单（固定一个，追加播放） ---------- */
    function listsOf(all) {
      if (!all) return [];
      if (Object.prototype.toString.call(all) === '[object Array]') return all;
      return all.playlists || all.items || all.list || [];
    }

    // 记忆固定歌单的 guid（v2 起 playlist.* 都返回 guid）：歌单被改名或移动后
    // 索引会变、guid 不会，所以解析顺序是「记忆的 guid → 名字」。
    var PL_GUID_KEY = 'cm-plguid-' + P;
    function savedGuid() {
      try { return localStorage.getItem(PL_GUID_KEY) || ''; } catch (e) { return ''; }
    }
    function saveGuid(g) {
      try { if (g) localStorage.setItem(PL_GUID_KEY, g); } catch (e) {}
    }

    function ensurePlaylist(name) {
      function fetchAll() {
        return api('playlist.getAll').then(function (all) { return listsOf(all); },
                                           function () { return []; });
      }
      function findIn(lists) {
        var g = savedGuid();
        if (g) {
          for (var i = 0; i < lists.length; i++) {
            var gi = lists[i] || {};
            // guid 命中还要核对名字：这个键被「固定歌单」与「导入歌单」两路共用，
            // 谁最后按名字命中/创建谁就会覆写它 —— 不核对名字两边会互相劫持
            //（300 首导入曲被追加进固定歌单、或播放被追加进用户命名的导入歌单）
            var gnm = gi.name || gi.title || '';
            if (gi.guid === g && gnm === name && gi.index != null) return gi.index;
          }
        }
        for (var j = 0; j < lists.length; j++) {
          var it = lists[j] || {};
          var nm = it.name || it.title || '';
          if (nm === name && it.index != null) {
            if (it.guid) saveGuid(it.guid);
            return it.index;
          }
        }
        return -1;
      }
      function tryFind(tries) {
        return fetchAll().then(function (lists) {
          var idx = findIn(lists);
          if (idx >= 0 || tries <= 0) return idx;
          return new Promise(function (res) { setTimeout(res, 250); })
            .then(function () { return tryFind(tries - 1); });
        });
      }
      return tryFind(4).then(function (idx) {
        if (idx >= 0) return idx;
        return apiOr('playlist.create', { name: name }).then(function (cr) {
          if (cr && cr.guid) saveGuid(cr.guid);
          if (cr && cr.index != null) return cr.index;
          return tryFind(3).then(function (idx2) {
            if (idx2 >= 0) return idx2;
            // 建不出来也不能拿用户的**活动歌单**顶上 —— 那会把在线直链追加进
            // 用户自己的歌单并从那里开播（静默降级）。回 -1，调用方如实报错。
            return -1;
          });
        });
      });
    }

    /* getAll 抖动可能攒下同名歌单：播放成功后清理"空壳"
       注意只删空歌单 —— 同名但**有曲目**的那张可能是用户自己建的（按名字删会连他的歌
       一起删掉），也可能是上一次导入的内容；留着让用户自己看着办 */
    function dedupePlaylists(name) {
      return api('playlist.getAll').then(function (all) {
        var same = listsOf(all).filter(function (it) {
          return it && (it.name || it.title || '') === name && it.index != null;
        });
        if (same.length <= 1) return 0;
        same.sort(function (a, b) { return a.index - b.index; });
        // 空壳判定与 ui-playlist.js 同口径：宿主可能回 trackCount 也可能回 itemCount
        var removes = same.slice(1).filter(function (s) {
                        return (s.trackCount != null ? s.trackCount : s.itemCount) === 0;
                      })
                          .map(function (s) { return s.index; })
                          .sort(function (a, b) { return b - a; });   // 从大到小删，避开索引位移
        if (!removes.length) return 0;
        var p = Promise.resolve();
        removes.forEach(function (ri) {
          // api 失败返回 null（不 reject），这里不必再挂 catch
          p = p.then(function () { return api('playlist.remove', { playlist: ri }); });
        });
        return p.then(function () { return removes.length; });
      }).catch(function () {
        // api 失败回 null（不 reject），所以这里兜的不是"宿主拒绝"，而是链上万一
        // 出现的意外异常：本函数是 fire-and-forget 调的（各页 dedupePlaylists(...)
        // 不带 then），返回一个会 reject 的 Promise 就是一条未处理的拒绝
        return 0;
      });
    }

    /* ---------- 下载：路径与落盘 ---------- */
    function joinPath(dir, name) {
      return String(dir).replace(/[\\/]+$/, '') + '\\' + name;
    }

    /* 文件名清洗：Windows 非法字符 + 结尾的点 / 空格（会被系统静默吞掉） */
    function safeName(s) {
      s = String(s == null ? '' : s)
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/[\u0000-\u001f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '');
      return s.slice(0, 110) || 'track';
    }

    var DL_EXT = { flac: 1, m4a: 1, mp3: 1, ogg: 1, wav: 1, aac: 1, ape: 1, wma: 1 };
    function extOfUrl(u, fallback) {
      var m = /\.([a-z0-9]{2,4})$/.exec(String(u).split('?')[0] || '');
      var e = m ? m[1].toLowerCase() : '';
      if (DL_EXT[e]) return '.' + e;
      return fallback === 'flac' ? '.flac' : '.mp3';
    }

    function hostErr(r) {
      if (!r) return '宿主没有响应';
      return r.message || r.error || r.detail || r.code || '未知错误';
    }

    /* 取流落盘 —— 只能走宿主的下载器 http.download：
       CDN 不给跨源头，页面 fetch 会被 CORS 拦掉；宿主是原生 HTTP 客户端，
       没有这层限制，且 saveTo 写在配置目录里正好符合它的写盘策略。
       默认同步会占住宿主线程，必须显式 async:true。 */
    var DL_TIMEOUT = 180000;
    var _dlWaiters = {};
    var _dlSubscribed = false;

    function dlSubscribe() {
      if (_dlSubscribed) return;
      var f = window.fb;
      if (!f || typeof f.on !== 'function') return;
      _dlSubscribed = true;
      f.on('http:downloadComplete', function (e) {
        if (!e) return;
        var keys = [];
        if (e.requestId) keys.push('id:' + e.requestId);
        if (e.path) keys.push('path:' + String(e.path).toLowerCase());
        for (var i = 0; i < keys.length; i++) {
          var w = _dlWaiters[keys[i]];
          if (w) { w.settle(e); return; }
        }
      });
    }

    /* 多段下载（B 站长视频会被切成多段 durl）：
       逐段落到 .pN 临时文件，再按字节拼成一个文件。
       宿主 file.read 用 encoding:'binary' 回 base64、file.write 吃 `base64:` 前缀，
       所以拼接在页面里做 —— 一两段 5MB 没问题，但要给总大小上限：
       再大就会把 WebView 的字符串内存撑到几百 MB，宁可明确报错让人换工具。 */
    var CONCAT_MAX = 32 * 1024 * 1024;
    function b64ToBytes(b64) {
      var bin = atob(b64), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    function bytesToB64(bytes) {
      var CHUNK = 0x8000, s = '';
      for (var i = 0; i < bytes.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(s);
    }
    function concatFiles(paths, dest) {
      var bufs = [], total = 0;
      var chain = Promise.resolve();
      paths.forEach(function (path) {
        chain = chain.then(function () {
          return api('file.read', { path: path, encoding: 'binary' }).then(function (r) {
            if (!r || typeof r.content !== 'string') throw new Error('读取分段失败：' + path);
            var b = b64ToBytes(r.content);
            total += b.length;
            if (total > CONCAT_MAX) {
              throw new Error('分段合计超过 ' + Math.round(CONCAT_MAX / 1048576) + 'MB，请改用其他工具下载');
            }
            bufs.push(b);
          });
        });
      });
      return chain.then(function () {
        var all = new Uint8Array(total), at = 0;
        bufs.forEach(function (b) { all.set(b, at); at += b.length; });
        return api('file.write', {
          path: dest, content: 'base64:' + bytesToB64(all), encoding: 'binary'
        }).then(function (r) {
          // 失败信封是正常 resolve 的真值：不判就会把写盘失败（磁盘满 / 权限 /
          // 路径被拒）计成「下载完成 · 成功 N/N」，磁盘上其实没有文件
          if (!r || r.success === false) {
            throw new Error('拼接写盘失败：' + ((r && (r.error || hostErr(r))) || dest));
          }
          return r;
        });
      });
    }

    /* 一个计划项 → 一个文件：单段直接下，多段先下临时文件再拼（拼完 / 失败都清临时文件） */
    function grabItem(it, saveTo) {
      var parts = (it.parts && it.parts.length) ? it.parts : [it.url];
      if (parts.length <= 1) return grabToFile(parts[0], saveTo);
      var tmps = parts.map(function (_, i) { return saveTo + '.p' + (i + 1); });
      function clean() {
        tmps.forEach(function (tmp) {
          api('file.delete', { path: tmp }).then(function () {}, function () {});
        });
      }
      var chain = Promise.resolve();
      tmps.forEach(function (tmp, i) {
        chain = chain.then(function () { return grabToFile(parts[i], tmp); });
      });
      return chain.then(function () {
        return concatFiles(tmps, saveTo).then(function (r) { clean(); return r; },
                                                function (e) { clean(); throw e; });
      }, function (e) { clean(); throw e; });
    }

    function grabToFile(url, saveTo) {
      dlSubscribe();
      return new Promise(function (resolve, reject) {
        var keys = ['path:' + saveTo.toLowerCase()];
        var done = false, timer = null;
        function settle(e) {
          if (done) return;
          done = true;
          keys.forEach(function (k) { delete _dlWaiters[k]; });
          if (timer) clearTimeout(timer);
          if (e === null) {
            // 超时不中止宿主侧下载，留墓碑等待器：迟到完成时如实提示「实际已落盘」
            keys.forEach(function (k) {
              _dlWaiters[k] = { settle: function (late) {
                delete _dlWaiters[k];
                if (late && late.success !== false) toast('下载超时但已完成', saveTo, 'warn');
              } };
            });
            reject(new Error('等待宿主下载超时'));
            return;
          }
          if (e.success === false) { reject(new Error(hostErr(e))); return; }
          resolve(e);
        }
        keys.forEach(function (k) { _dlWaiters[k] = { settle: settle }; });
        timer = setTimeout(function () { settle(null); }, DL_TIMEOUT);

        api('http.download', { url: url, saveTo: saveTo, async: true }).then(function (r) {
          if (done) return;
          if (!r) { settle({ success: false, error: '宿主没有响应 http.download' }); return; }
          if (r.success === false) { settle({ success: false, error: hostErr(r) }); return; }
          if (r.path || r.bytesWritten != null) { settle({ success: true, path: r.path }); return; }
          var rid = r.requestId || (r.data && r.data.requestId);
          if (rid) { keys.push('id:' + rid); _dlWaiters['id:' + rid] = { settle: settle }; return; }
          settle({ success: false, error: '宿主未响应 http.download' });
        }, function (e) {
          settle({ success: false, error: (e && e.message) || '下载请求失败' });
        });
      });
    }

    /* 下载目录（配置目录下一层中文目录）。
       目录必须真实存在：实测目录不存在时 file.write 会失败（哪怕文档说会自动
       建父目录），所以先 mkdir 一次；已存在时幂等。首次用到时把旧版目录里的
       文件搬过来（CM.moveDirContents，逐个容错，不会丢文件）。 */
    var _dlDir = '';
    var _dlMigrated = false;
    function downloadDir() {
      if (_dlDir) return Promise.resolve(_dlDir);
      var profDir = '';
      return CM.profilePath().then(function (prof) {
        if (!prof) throw new Error('取不到 foobar2000 配置目录');
        profDir = prof;
        _dlDir = joinPath(prof, dirName);
        return api('file.mkdir', { path: _dlDir }).then(function () { return _dlDir; },
                                                         function () { return _dlDir; });
      }).then(function (dir) {
        if (_dlMigrated || !dirNameOld || !CM.moveDirContents) return dir;
        _dlMigrated = true;                      // 一次会话只搬一次
        return CM.moveDirContents(joinPath(profDir, dirNameOld), dir)
          .then(function () { return dir; }, function () { return dir; });
      });
    }

    /* ---------- 下载保存位置条 ---------- */
    function showDlRow(dir) {
      if (!dir) return;
      var row = $(dlRowId);
      if (row) row.hidden = false;
      var p = $(dlPathId);
      if (p) p.textContent = dir;
    }
    function dlRowPath() {
      var p = $(dlPathId);
      return (p && p.textContent) || '';
    }
    function openDlFolder() {
      var dir = dlRowPath();
      if (!dir) return;
      api('shell.showInExplorer', { path: dir }).then(function (r) {
        if (r && r.success !== false) return null;
        return api('shell.exec', { command: 'explorer "' + dir + '"' });
      }).then(function () {}, function () {
        toast('打开文件夹失败', dir, 'error');
      });
    }
    function copyDlPath() {
      var dir = dlRowPath();
      if (!dir) return;
      copyText(dir, function (ok) {
        toast(ok ? '已复制路径' : '复制失败', dir, ok ? 'success' : 'error');
      });
    }

    /* ---------- 下载计划与执行 ---------- */
    /* 下载计划的构造（文件名 + 同批重名序号 + .lrc 字段）由**各页自己**实现：
       QQ 与网易云的字段名（songmid / id）与去重口径不同。这里曾导出一份"通用版"
       buildPlan，两个页面都不用（各自有本地版），属死代码 —— 已删，避免三份实现漂移。 */

    /* 歌词：各页自己给 getLyric(it) → Promise<{ok,lrc}>（QQ 走标题+歌手匹配，
       网易云能拿到 id 就按 id 精确取词；都不是本模块的事）。 */
    function saveLyric(it, dir) {
      if (!cfg.getLyric) return Promise.resolve('none');
      return cfg.getLyric(it).then(function (r) {
        var text = (r && r.ok && r.lrc) ? String(r.lrc) : '';
        if (!text) return 'none';
        // 统一成 CRLF + UTF-8 BOM：Windows 上的播放器认这个，主题自己的检测也吃得下
        var body = '\ufeff' + text.replace(/\r\n|\r|\n/g, '\r\n');
        // v2：file.write 支持 atomic（临时文件 + 改名）。歌词是"顺手写"的附属文件，
        // 写一半被打断（退出 / 停止下载）会留下半截 .lrc —— 加原子写避免。
        return api('file.write', { path: joinPath(dir, it.lrcName), content: body, atomic: true }).then(function (w) {
          if (!w) return 'fail';
          return (w.success === false) ? 'fail' : 'ok';
        }, function () { return 'fail'; });
      }, function () { return 'fail'; });
    }

    /* 逐首下载：进度写状态栏，失败归类汇总；state 由页面提供（S），
       onProgress 通常就是页面的 updateToolbar。 */
    function runDownloads(plan) {
      var state = cfg.state;
      if (!plan.length) {
        if (state) { state.dlRun = false; state.dlTotal = 0; }
        if (cfg.onProgress) cfg.onProgress();
        toast('没有可下载的曲目', null, 'error');
        return Promise.resolve();
      }
      /* dlCancel 不在这里清：三个页面在「开始新一轮」时各自清（ui-bilibili 370 /
         ui-qqmusic 540 / ui-netease 470）。这里清会把**解析阶段按下的停止**抹掉 ——
         用户点了「停止」，解析完成后照样把一整批全下完。 */
      if (state) { state.dlRun = true; state.dlDone = 0; state.dlTotal = plan.length; }
      if (cfg.onProgress) cfg.onProgress();
      var okN = 0, lyricOk = 0, fails = [];
      setStatus('开始下载 ' + plan.length + ' 首到 ' + dirName + '…');

      return downloadDir().then(function (dir) {
        showDlRow(dir);
        function step(i) {
          if (state && state.dlCancel) { state.dlDone = i; return Promise.resolve(); }
          if (i >= plan.length) return Promise.resolve();
          var it = plan[i];
          setStatus('下载中 ' + (i + 1) + '/' + plan.length + '：' + it.name);
          return grabItem(it, joinPath(dir, it.name)).then(function () {
            okN++;
            if (state) state.dlDone = i + 1;
            return saveLyric(it, dir).then(function (r) { if (r === 'ok') lyricOk++; });
          }, function (err) {
            fails.push(it.name + '（' + ((err && err.message) || '下载失败') + '）');
            if (state) state.dlDone = i + 1;
          }).then(function () {
            if (cfg.onProgress) cfg.onProgress();
            return step(i + 1);
          });
        }
        return step(0).then(function () {
          var stopped = !!(state && state.dlCancel);
          setStatus((stopped ? '已停止 · ' : '下载完成 · ') + '成功 ' + okN + '/' + plan.length +
                    '，歌词 ' + lyricOk + ' 个' + (fails.length ? '，失败 ' + fails.length : ''),
                    fails.length ? 'warn' : 'ok');
          toast(stopped ? '已停止下载' : '下载完成',
                '成功 ' + okN + ' 首' + (fails.length ? '，失败 ' + fails.length + ' 首（' + fails[0] + '）' : ''),
                fails.length ? 'warn' : 'success');
        });
      }).catch(function (e) {
        setStatus('下载失败：' + (e && e.message || e), 'err');
        toast('下载失败', String(e && e.message || e), 'error');
      }).then(function () {
        if (state) { state.dlRun = false; state.dlTotal = 0; }
        if (cfg.onProgress) cfg.onProgress();
      });
    }

    /* ---------- 通用装配 ---------- */
    /* 面板显隐。两个在线音源页的所有面板（登录 / 导入歌单）**统一是开关**：
       点按钮展开、再点一次收起，面板里另外都给一个「收起」按钮。
       页面之间不再各写一套开合逻辑 —— 早先登录面板只开不收、导入面板却是开关，
       同一个界面两种手感；更早还为了"面板占满整块"去临时收起搜索条/列表，
       开合两个方向各自维护，漏掉一支就出现"面板关了、搜索条却回不来"。
       面板与搜索 / 列表始终共存，不动它们的显隐，少一处状态就少一类 bug。 */
    function showSetup(on) {
      var box = $(setupId);
      if (!box) return;
      if (!on) { box.hidden = true; return; }
      box.hidden = false;
      var ta = $(cookieInputId);
      var b = bridge();
      if (ta && b && document.activeElement !== ta) ta.value = b.getCookie();
    }

    /* 通用面板开关：页面上任何面板都用它，展开 ↔ 收起的手感只有这一处实现。
       返回 true 表示"现在是展开的"，调用方据此决定要不要顺带做点什么。 */
    function togglePanel(id) {
      var box = $(id);
      if (!box) return false;
      box.hidden = !box.hidden;
      return !box.hidden;
    }

    /* 登录面板的开关（面板 id 由配置给出） */
    function toggleSetup() {
      var box = $(setupId);
      if (!box) return;
      showSetup(box.hidden);
    }

    return {
      $: $, api: api, apiOr: apiOr, mmss: mmss, toast: toast, setStatus: setStatus, copyText: copyText,
      css: css, injectCss: injectCss,
      listsOf: listsOf, ensurePlaylist: ensurePlaylist, dedupePlaylists: dedupePlaylists,
      joinPath: joinPath, safeName: safeName, extOfUrl: extOfUrl, hostErr: hostErr,
      dlSubscribe: dlSubscribe, grabToFile: grabToFile, grabItem: grabItem, downloadDir: downloadDir,
      showDlRow: showDlRow, dlRowPath: dlRowPath, openDlFolder: openDlFolder, copyDlPath: copyDlPath,
      saveLyric: saveLyric, runDownloads: runDownloads,
      showSetup: showSetup, toggleSetup: toggleSetup, togglePanel: togglePanel,
      dirName: dirName, prefix: P
    };
  }

  CM.onlineCommon = makeKit;
})();
