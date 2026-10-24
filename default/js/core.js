/* ============================================
 * CloudMusic core.js — API 包装 + 状态 + 工具 + 配色
 * 挂载到 window.CloudMusic 命名空间
 * ============================================ */
(function() {
  'use strict';
  var CM = window.CloudMusic = window.CloudMusic || {};

  // 主题版本：界面上所有"显示版本号"的地方都读这一个常量，
  // 避免「更多」菜单、诊断面板、诊断报告各写一份后互相对不上。
  CM.VERSION = '3.0.1';

  /* ============================================
   * API 包装器 — 出错时resolve null，调用方只需判空
   * v2 起失败回包带 code（INVALID_PARAMS / LOCKED / NO_ACTIVE_ITEM / ORIGIN_DENIED …）
   * 与 error 文案：这里把它们记进 CM.lastApiError 并打一条 console.warn ——
   * 主题大量使用"失败即空态"的写法，没有这条日志就只能看到"点了没反应"而查不出原因。
   * ============================================ */
  // 失败记录 + 诊断环形缓冲
  // ------------------------------------------------------------
  // 只留"最后一次"在长会话里会被后续噪音冲掉（尤其是启动阶段的一批失败），
  // 排障时最想看的恰恰是"最开始那几条"。所以除 lastApiError 外再留一个
  // 定长环形缓冲（最近 40 条），给诊断面板与「复制报告」用。
  var _apiLog = [];
  var _apiLogSeq = 0;
  CM.API_LOG_MAX = 40;
  CM.apiLog = function() { return _apiLog.slice(); };

  function recordApiFailure(method, code, error, details) {
    var rec = {
      n: ++_apiLogSeq,
      at: Date.now(),
      method: method,
      code: code || '',
      error: error || '',
      kind: CM.errKind(code),
      details: details
    };
    CM.lastApiError = rec;
    _apiLog.push(rec);
    if (_apiLog.length > CM.API_LOG_MAX) _apiLog.shift();
    return rec;
  }

  CM.api = function(method, params) {
    return fb.invoke(method, params || {}).then(function(r) {
      if (r && r.success === false) {
        recordApiFailure(method, r.code, r.error, r.details);
        try { console.warn('[CloudMusic] ' + method + ' 失败：' + (r.code || '') + ' ' + (r.error || '')); } catch (e) {}
      }
      return r;
    }, function(e) {
      recordApiFailure(method, (e && e.code) || 'TRANSPORT', (e && e.message) || String(e));
      try { console.warn('[CloudMusic] ' + method + ' 调用异常：' + ((e && e.message) || e)); } catch (e2) {}
      return null;
    });
  };
  // 错误码 → 人话（写操作失败提示统一走这里；未知码原样回显，便于排障）
  CM.ERR_TEXT = {
    INVALID_PARAMS: '参数不被宿主接受',
    METHOD_NOT_FOUND: '当前宿主版本不支持该功能',
    ORIGIN_DENIED: '页面来源不被信任（仅内置页面 / 模板目录可调用）',
    NOT_FOUND: '目标不存在',
    NO_ACTIVE_ITEM: '没有可操作的对象（未播放 / 未选中）',
    LOCKED: '目标被锁定，无法修改',
    INVALID_INDEX: '索引超出范围',
    OPERATION_FAILED: '宿主执行失败',
    MENU_ITEM_DISABLED: '该命令当前不可用',
    MENU_COMMAND_NOT_FOUND: '未找到该命令',
    MENU_MATCH_AMBIGUOUS: '命令名不唯一，无法确定目标',
    NOT_SUPPORTED: '当前宿主版本不支持该功能',
    DISABLED: '该功能已被禁用',
    ACCESS_DENIED: '没有权限执行该操作',
    BUSY: '宿主正忙，稍后重试',
    TRANSPORT: '与宿主通信失败'
  };
  CM.errText = function(code) {
    return (code && CM.ERR_TEXT[code]) || code || '未知错误';
  };

  /* 失败归因 + 处理建议
     ------------------------------------------------------------
     主题的约定是"失败必须如实提示"，而"怎么修"取决于**哪一类**失败：
     宿主没这个 API（升级组件）、参数写错（我们的 bug）、来源不被信任
     （主题目录选错 / 从开发服务器打开）、目标不存在（用户操作前提没满足）。
     把分类和一句话建议集中在这里，调用点就不必各写一套 if。 */
  CM.ERR_KIND = {
    INVALID_PARAMS: 'params',
    NOT_SUPPORTED: 'unsupported',
    METHOD_NOT_FOUND: 'unsupported',
    ORIGIN_DENIED: 'origin',
    ACCESS_DENIED: 'origin',
    NOT_FOUND: 'missing',
    NO_ACTIVE_ITEM: 'missing',
    INVALID_INDEX: 'missing',
    LOCKED: 'locked',
    BUSY: 'busy',
    TRANSPORT: 'transport',
    OPERATION_FAILED: 'host'
  };
  CM.ERR_KIND_LABEL = {
    unsupported: '宿主不支持', params: '参数被拒', origin: '来源被信任限制',
    missing: '目标不存在', locked: '目标被锁定', busy: '宿主忙',
    transport: '通信失败', host: '宿主执行失败', unknown: '未知失败'
  };
  CM.ERR_KIND_ADVICE = {
    unsupported: '升级 foo_ui_webview2 组件，或让该项在界面上自动隐藏',
    params: '这是主题侧的调用错误，请带着诊断报告反馈',
    origin: '主题目录要选到含 index.html 的那一层，且不要用开发服务器打开',
    missing: '先让操作前提成立（选中曲目、进入歌单、开始播放）',
    locked: '解锁该歌单 / 目标后再试',
    busy: '稍后重试',
    transport: '宿主可能正在忙或已退出，重试一次',
    host: '看 foobar2000 控制台里的组件日志',
    unknown: '带诊断报告反馈'
  };
  CM.errKind = function(code) {
    return CM.ERR_KIND[code] || (code ? 'unknown' : 'unknown');
  };
  CM.errKindLabel = function(code) { return CM.ERR_KIND_LABEL[CM.errKind(code)]; };
  CM.errAdvice = function(code) { return CM.ERR_KIND_ADVICE[CM.errKind(code)]; };

  // webview.getSource 回包 → 一句人话（诊断面板与诊断报告共用，别在两处各写一份）
  CM.SRC_LABEL = {
    devServer: '开发服务器', url: '面板配置的 URL / 弹窗',
    panelTemplate: '面板模板', activeTemplate: '全局模板',
    componentDirectory: '组件资源目录', defaultTemplate: '默认模板目录',
    builtInPage: '内置页面'
  };
  CM.sourceText = function(src) {
    if (!src) return '未知';
    var t = CM.SRC_LABEL[src.source] || src.source || '--';
    if (src.url) t += '（' + src.url + '）';
    else if (src.directory) t += '（' + src.directory + '）';
    return t;
  };

  // 诊断报告（纯文本）：诊断面板的「复制报告」用它，用户贴到 issue 里就够定位
  CM.diagReport = function() {
    var L = [];
    L.push('== CloudMusic 主题诊断报告 ==');
    L.push('主题版本: v' + CM.VERSION);
    L.push('生成时间: ' + new Date().toISOString());
    var caps = CM.caps || {};
    var ver = caps.version || {};
    var plug = ver.plugin;
    if (plug && typeof plug === 'object') plug = plug.version || plug.name;
    L.push('foobar2000: ' + (ver.foobar2000 || caps.host || '未知'));
    L.push('WebView2 组件: ' + (plug || caps.plugin || '未知'));
    L.push('组件路径: ' + (CM._componentPath || '未知'));
    L.push('能力表: ' + (caps.ready ? ('已获取（' + (caps.set ? caps.set.size : 0) + ' 个方法）') : '未获取'));
    L.push('页面来源: ' + (CM._sourceText || '未知'));
    L.push('DPR / 缩放: ' + CM.dpr() + 'x');
    L.push('分辨率: ' + window.innerWidth + 'x' + window.innerHeight + ' (CSS)');
    L.push('可视化可用: ' + (CM.viz && CM.viz.binsMode ? '原始频点 bins' : '频带 bands'));
    var sch = (CM.sched && CM.sched.stats) ? CM.sched.stats() : null;
    L.push('可视化调度: ' + (sch
      ? ((sch.subscribed ? '已订阅' : '未订阅') + ' · ' + sch.subCount + ' 视图'
         + (sch.waveCount ? ' + ' + sch.waveCount + ' 波形' : '')
         + (sch.hidden ? ' · 后台降帧' : ''))
      : '未知'));
    L.push('');
    L.push('-- 已安装组件 --');
    var comps = CM._componentList || null;
    if (comps && comps.length) {
      for (var i = 0; i < comps.length; i++) {
        var c = comps[i] || {};
        L.push('  ' + (c.name || c.filename || c.fileName || '?') + ' ' + (c.version || ''));
      }
    } else {
      L.push('  （未读取）');
    }
    L.push('');
    L.push('-- 最近失败的宿主调用（新的在后）--');
    if (!_apiLog.length) {
      L.push('  无');
    } else {
      for (var j = 0; j < _apiLog.length; j++) {
        var r = _apiLog[j];
        var t = new Date(r.at);
        var hh = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
        L.push('  [' + hh + '] ' + r.method + ' → ' + (r.code || '?') + '（' + CM.errKindLabel(r.code) + '）' + (r.error ? ' ' + r.error : ''));
        if (r.details) {
          try { L.push('        details: ' + JSON.stringify(r.details)); } catch (e) {}
        }
      }
    }
    return L.join('\n');
  };
  // 剪贴板：v2 有 fb.clipboard.write；拿不到就退回 execCommand（老办法仍然可用）
  CM.copyText = function(text) {
    return CM.api('clipboard.write', { text: text }).then(function(r) {
      if (r && r.success !== false) return true;
      return legacyCopy(text);
    }, function() { return legacyCopy(text); });
  };
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  // 写操作用：失败必须 reject（"调用没成功"和"返回 null"不能混为一谈）。
  // 抛出的 Error 带 code / method / kind / detail：调用方既可直接 showToast(err.message)，
  // 也可按 err.code 分类处理；同时写进诊断缓冲（CM.lastApiError / CM.apiLog）。
  CM.apiOr = function(method, params) {
    function fail(code, detail) {
      var e = new Error(CM.errText(code) + (detail ? '（' + detail + '）' : ''));
      e.code = code || ''; e.method = method; e.detail = detail || '';
      e.kind = CM.errKind(e.code);
      recordApiFailure(method, e.code, detail || '');
      try { console.warn('[CloudMusic] ' + method + ' 失败：' + e.code + ' ' + e.message); } catch (e2) {}
      return e;
    }
    return fb.invoke(method, params || {}).then(function(r) {
      if (!r) throw fail('TRANSPORT', '宿主没有响应');
      if (r.success === false) throw fail(r.code || 'OPERATION_FAILED', r.error || '');
      return r;
    }, function(err) {
      throw fail((err && err.code) || 'TRANSPORT', (err && err.message) || String(err));
    });
  };

  /* 写操作的统一失败提示
     ------------------------------------------------------------
     写操作静默失败 = 用户以为功能坏了。所有 apiOr 的拒绝都走这里：
     一句人话 + 归因标签（宿主不支持 / 参数被拒 / 来源被信任限制 …），
     排障信息（method + code）收进诊断面板，不往提示里塞噪音。 */
  CM.failToast = function(err, title, opts) {
    var o = opts || {};
    var code = (err && err.code) || '';
    var head = title || '操作失败';
    if (o.verbose !== false && code) head += ' · ' + CM.errKindLabel(code);
    var sub = (err && err.message) || CM.errText(code);
    if (o.detail) sub += '（' + o.detail + '）';
    CM.showToast(head, sub, 'error');
    return err;
  };
  // 包一层：CM.tryApi('标题', method, params) —— 成功走 then，失败自动提示并 reject
  CM.tryApi = function(title, method, params) {
    return CM.apiOr(method, params).catch(function(e) {
      CM.failToast(e, title);
      throw e;
    });
  };

  /* 标签写入的最终结果
     ------------------------------------------------------------
     metadata.write / writeBatch 的**回执只表示"已投递"**，写盘成败由宿主另发
     metadata:writeComplete 事件（SDK 原话：the returned receipt describes the
     dispatch; the final outcome is on the event payload）。只认回执就会出现
     "文件只读 / 被占用 / 格式不支持"时界面照常弹"标签已保存"、表格还改成新值，
     实际一个字节都没写进去 —— 也就是"看起来成功的假象"。
     所以写入统一走这里：先挂监听再发起调用，收齐期望路径（或 4 秒无事件）后
     回一份 { ok, failed, unconfirmed }，由调用方决定怎么提示、要不要写缓存。
     unconfirmed = 宿主压根没发完成事件（老宿主）：不假装成功，也不当成失败。 */
  CM.WRITE_CONFIRM_MS = 4000;
  CM.writeTags = function(method, params, paths) {
    var expect = {}, i;
    for (i = 0; i < (paths || []).length; i++) if (paths[i]) expect[paths[i]] = false;
    var wantN = Object.keys(expect).length;
    var failed = [], seen = 0, settled = false, off = null, timer = null, finish = null;
    var confirmed = new Promise(function(res) { finish = res; });
    function settle() {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (off) { try { off(); } catch (e) {} }
      finish({ ok: failed.length === 0 && seen >= wantN, failed: failed, unconfirmed: seen < wantN });
    }
    if (wantN && fb && typeof fb.on === 'function') {
      off = fb.on('metadata:writeComplete', function(e) {
        if (!e || !e.path || !(e.path in expect) || expect[e.path]) return;
        expect[e.path] = true; seen++;
        if (e.success === false) failed.push({ path: e.path, code: e.code || '', error: e.error || e.status || '' });
        if (seen >= wantN) settle();
      });
      timer = setTimeout(settle, CM.WRITE_CONFIRM_MS);
    }
    // 回执本身也可能失败（参数被拒 / 目标不存在）：那种情况不必再等事件
    var dispatch = CM.api(method, params).then(function(r) {
      if (!r) { settle(); return r; }
      if (r.success === false) { settle(); return r; }
      if (!wantN) settle();
      return r;
    });
    return Promise.all([dispatch, confirmed]).then(function(rs) {
      return { dispatch: rs[0], confirmed: rs[1] };
    });
  };

  /* ============================================
   * 能力探测层 CM.caps
   * ------------------------------------------------------------
   * 启动时向宿主要一次完整方法表（system.listAvailableApis 的 apis[].fullName），
   * 缓存成 Set。所有"只有新宿主才有"的功能用 CM.caps.has('namespace.method')
   * 决定显隐 —— 旧宿主上自动隐藏，而不是等调用失败。
   * 探测未完成（或探测本身失败）时 has() 返回 true：只有明确拿到方法表之后，
   * "缺失"才是可信的判断，否则一次探测抖动就会把所有功能都藏掉。
   * ============================================ */
  CM.caps = {
    ready: false,     // 是否已拿到方法表
    set: null,        // Set<string>，null = 尚未探测
    version: null,    // config.getVersionInfo 回包
    host: '',         // 宿主 foobar2000 版本
    plugin: '',       // WebView2 组件版本
    has: function(name) {
      if (!this.set) return true;
      return this.set.has(name);
    },
    // 便捷判定：某命名空间下有没有任意方法（只关心"这一组功能在不在"时用）
    hasNs: function(ns) {
      if (!this.set) return true;
      var pre = ns + '.';
      var it = this.set.values();
      for (var v = it.next(); !v.done; v = it.next()) {
        if (String(v.value).indexOf(pre) === 0) return true;
      }
      return false;
    }
  };
  // 宿主信息（组件清单 / 页面来源 / 组件路径）：诊断面板与诊断报告都要，
  // 拉一次缓存在 CM._* 上；面板打开时可再刷一次（宿主信息在启动后才完整）
  CM.caps.loadHostInfo = function() {
    if (!fb || typeof fb.invoke !== 'function') return Promise.resolve();
    var compsP = CM.api('config.getComponents').then(function(r) {
      var list = Array.isArray(r) ? r : (r && Array.isArray(r.components) ? r.components : []);
      if (list.length) CM._componentList = list;
    });
    var srcP = CM.api('webview.getSource').then(function(r) {
      if (r) CM._sourceText = CM.sourceText(r);
    });
    var pathP = CM.api('misc.getComponentPath').then(function(r) {
      var p = r && (r.path || r.componentPath || r.directory);
      if (typeof r === 'string') p = r;
      if (p) CM._componentPath = p;
    });
    return Promise.all([compsP, srcP, pathP]).catch(function() {});
  };
  CM.caps.init = function() {
    if (!fb || typeof fb.invoke !== 'function') return Promise.resolve();
    // 宿主方法名是 system.listAvailableApis（SDK 的 fb.system.listApis 就是它的封装）；
    // 直接 invoke 'system.listApis' 会被判 METHOD_NOT_FOUND，探测就永远拿不到表。
    var listP = CM.api('system.listAvailableApis').then(function(r) {
      if (!r || r.success === false || !Array.isArray(r.apis)) return;  // 探测失败：保持"未知"
      var set = new Set();
      for (var i = 0; i < r.apis.length; i++) {
        var a = r.apis[i];
        var n = a && (a.fullName || a.name);
        if (n) set.add(n);
      }
      CM.caps.set = set;
      CM.caps.ready = true;
    });
    var verP = CM.api('config.getVersionInfo').then(function(r) {
      if (!r) return;
      CM.caps.version = r;
      CM.caps.host = r.foobar2000 || '';
      var p = r.plugin;
      CM.caps.plugin = (p && typeof p === 'object') ? (p.version || p.name || '') : (p || '');
    });
    return Promise.all([listP, verP, CM.caps.loadHostInfo()]).catch(function() {});
  };

  /* ============================================
   * 像素口径（DPI / 多屏）
   * ------------------------------------------------------------
   * 宿主的窗口几何 API 分两套单位，混用就是"小窗又小又挤"那类 bug 的根源：
   *   · CSS 像素：window.setMaximizeButtonRegion（文档明确写 CSS pixels）、
   *     页面里所有 getBoundingClientRect / style 值；
   *   · 物理像素：window.createPopup 的 width/height、setSize / setMinSize /
   *     setBounds / getBounds。
   * CM.dpr() 是唯一的缩放比来源；CM.toPhysical() / CM.toCss() 是唯一换算口。
   * 页面缩放（Ctrl+滚轮改的是 window.getZoom）也会影响 devicePixelRatio，
   * 所以缩放变化要当作几何变化处理（见 CM.onDpiChange）。
   * ============================================ */
  CM.dpr = function() {
    var s = window.devicePixelRatio;
    return (typeof s === 'number' && s > 0 && isFinite(s)) ? s : 1;
  };
  CM.toPhysical = function(cssPx) { return Math.round((+cssPx || 0) * CM.dpr()); };
  CM.toCss = function(physPx) { return (+physPx || 0) / CM.dpr(); };
  // 宿主侧的 DPI 缩放（window.getDpiScale）：与 devicePixelRatio 一般相等，
  // 但页面被 setZoom 改过缩放时会分叉 —— 报给宿主的坐标要用这一个。
  CM.hostDpiScale = function() {
    return CM.api('window.getDpiScale').then(function(r) {
      var s = r && (r.scale != null ? r.scale : r.dpiScale);
      return (typeof s === 'number' && s > 0) ? s : CM.dpr();
    }, function() { return CM.dpr(); });
  };
  // 缩放比变化通知（换显示器 / 改系统缩放 / 页面缩放）：监听 media query 变化，
  // 这是唯一能在不改窗口尺寸的情况下察觉到 DPR 变化的手段。
  CM._dpi = CM.dpr();
  CM._dpiCbs = [];
  CM.onDpiChange = function(fn) {
    if (typeof fn === 'function') CM._dpiCbs.push(fn);
  };
  CM.watchDpi = function() {
    if (CM._dpiWatching || !window.matchMedia) return;
    CM._dpiWatching = true;
    function listen(q) {
      try {
        var mq = window.matchMedia(q);
        var handler = function() {
          var now = CM.dpr();
          if (now === CM._dpi) { listen(q); return; }   // 同 DPR 的另一档，继续往后听
          CM._dpi = now;
          for (var i = 0; i < CM._dpiCbs.length; i++) {
            try { CM._dpiCbs[i](now); } catch (e) {}
          }
          // 必须按新 DPR 重新装监听：沿用旧查询串会永远匹配不上当前分辨率，
          // 此后再改缩放 / 换显示器都不会触发 onDpiChange（旧写法只第一次生效）
          listen('(resolution: ' + now + 'dppx)');
        };
        if (mq.addEventListener) mq.addEventListener('change', handler, { once: true });
        else if (mq.addListener) mq.addListener(handler);
      } catch (e) { /* 不支持就算了：resize 事件仍会兜住大部分场景 */ }
    }
    // 逼近当前 DPR 的窄区间：任一方向越界都能被捕捉到
    listen('(resolution: ' + CM._dpi + 'dppx)');
  };

  /* ============================================
   * DOM 引用
   * ============================================ */
  CM.$ = function(id) { return document.getElementById(id); };

  CM.els = {
    app: CM.$('app'),
    titlebar: CM.$('titlebar'), titlebarDrag: CM.$('titlebarDrag'), titlebarControls: CM.$('titlebarControls'),
    sidebarSearchWrap: CM.$('sidebarSearchWrap'), sidebarSearch: CM.$('sidebarSearch'), sidebarSearchClear: CM.$('sidebarSearchClear'),
    sidebarNav: CM.$('sidebarNav'), playlistList: CM.$('playlistList'), addPlaylistBtn: CM.$('addPlaylistBtn'),
    mainTabs: CM.$('mainTabs'), mainBody: CM.$('mainBody'), mainContent: CM.$('mainContent'),
    // Discover
    heroDate: CM.$('heroDate'), heroTitle: CM.$('heroTitle'), heroSub: CM.$('heroSub'),
    btnPlayDaily: CM.$('btnPlayDaily'), btnRefreshDiscover: CM.$('btnRefreshDiscover'),
    discoverAlbums: CM.$('discoverAlbums'), discoverRecent: CM.$('discoverRecent'), discoverRandom: CM.$('discoverRandom'),
    moreAlbums: CM.$('moreAlbums'), moreRecent: CM.$('moreRecent'), refreshRandom: CM.$('refreshRandom'),
    // Playlist
    playlistHeader: CM.$('playlistHeader'), plCoverWrap: CM.$('plCoverWrap'), plCover: CM.$('plCover'),
    playlistHeaderName: CM.$('playlistHeaderName'), playlistHeaderMeta: CM.$('playlistHeaderMeta'),
    playlistHeaderTag: CM.$('playlistHeaderTag'),
    plFilter: CM.$('plFilter'), plFilterClear: CM.$('plFilterClear'), plFilterMeta: CM.$('plFilterMeta'),
    plFilterSave: CM.$('plFilterSave'),
    btnPlayAll: CM.$('btnPlayAll'), btnPlaylistMore: CM.$('btnPlaylistMore'),
    trackTableWrap: CM.$('trackTableWrap'), trackTable: CM.$('trackTable'), trackTbody: CM.$('trackTbody'),
    // Library / Search
    libraryTree: CM.$('libraryTree'), libraryDetail: CM.$('libraryDetail'),
    searchInput: CM.$('searchInput'), searchResults: CM.$('searchResults'),
    // Right panel
    rightPanel: CM.$('rightPanel'), lyricsBlurBg: CM.$('lyricsBlurBg'), lyricsArt: CM.$('lyricsArt'),
    lyricsTrackTitle: CM.$('lyricsTrackTitle'), lyricsTrackArtist: CM.$('lyricsTrackArtist'),
    lyricsScroll: CM.$('lyricsScroll'), lyricsEmpty: CM.$('lyricsEmpty'),
    // Bottom bar
    bottomArtWrap: CM.$('bottomArtWrap'), bottomArt: CM.$('bottomArt'),
    bottomTitle: CM.$('bottomTitle'), bottomArtist: CM.$('bottomArtist'), likeBtn: CM.$('likeBtn'),
    btnOrder: CM.$('btnOrder'), iconOrderSeq: CM.$('iconOrderSeq'), iconOrderLoop: CM.$('iconOrderLoop'),
    iconOrderOne: CM.$('iconOrderOne'), iconOrderShuffle: CM.$('iconOrderShuffle'),
    btnPrev: CM.$('btnPrev'), btnPlayPause: CM.$('btnPlayPause'), iconPlay: CM.$('iconPlay'), iconPause: CM.$('iconPause'),
    btnNext: CM.$('btnNext'), btnStopAfter: CM.$('btnStopAfter'),
    seekBar: CM.$('seekBar'), seekCurrent: CM.$('seekCurrent'), seekTotal: CM.$('seekTotal'),
    miniSpectrum: CM.$('miniSpectrum'), btnVisualizer: CM.$('btnVisualizer'),
    volBtn: CM.$('volBtn'), volIcon: CM.$('volIcon'), volSlider: CM.$('volSlider'),
    btnQueue: CM.$('btnQueue'), queueBadge: CM.$('queueBadge'),
    btnLyricsToggle: CM.$('btnLyricsToggle'), btnMore: CM.$('btnMore'),
    // Queue drawer
    queueDrawer: CM.$('queueDrawer'), queueCount: CM.$('queueCount'), queueList: CM.$('queueList'), queueNow: CM.$('queueNow'),
    queueClear: CM.$('queueClear'), queueClose: CM.$('queueClose'),
    historyToggle: CM.$('historyToggle'), historyRegion: CM.$('historyRegion'), historyList: CM.$('historyList'),
    historyClear: CM.$('historyClear'), historyCount: CM.$('historyCount'), historyHint: CM.$('historyHint'),
    // Overlays
    morePopover: CM.$('morePopover'), rgPopover: CM.$('rgPopover'),
    modalMask: CM.$('modalMask'), modalTitle: CM.$('modalTitle'), modalDesc: CM.$('modalDesc'),
    modalInput: CM.$('modalInput'), modalOk: CM.$('modalOk'), modalCancel: CM.$('modalCancel'),
    toastContainer: CM.$('toastContainer'), ctxMenu: CM.$('ctxMenu'), ctxSubMenu: CM.$('ctxSubMenu'), dropOverlay: CM.$('dropOverlay'),
    // Immersive NowPlaying
    npOverlay: CM.$('npOverlay'), npBgBlur: CM.$('npBgBlur'), npVinylDisc: CM.$('npVinylDisc'),
    npTonearm: CM.$('npTonearm'), npArtwork: CM.$('npArtwork'),
    npTrackTitle: CM.$('npTrackTitle'), npTrackArtist: CM.$('npTrackArtist'),
    npTrackFormat: CM.$('npTrackFormat'), npWaveform: CM.$('npWaveform'),
    npSpectrum: CM.$('npSpectrum'), npLyrics: CM.$('npLyrics'), npVizBtn: CM.$('npVizBtn'),
    npSeekBar: CM.$('npSeekBar'), npTimeCurrent: CM.$('npTimeCurrent'), npTimeTotal: CM.$('npTimeTotal'),
    npCloseBtn: CM.$('npCloseBtn'), npModeBtn: CM.$('npModeBtn'), npTiltBtn: CM.$('npTiltBtn'),
    npBtnPrev: CM.$('npBtnPrev'), npBtnPlay: CM.$('npBtnPlay'), npBtnNext: CM.$('npBtnNext'),
    npLcPrev: CM.$('npLcPrev'), npLcPlay: CM.$('npLcPlay'), npLcNext: CM.$('npLcNext'),
    rpImmersiveBtn: CM.$('rpImmersiveBtn'),
    // Tag Editor
    tagEditorOverlay: CM.$('tagEditorOverlay'), tagEditorTitle: CM.$('tagEditorTitle'),
    tagEditorTrack: CM.$('tagEditorTrack'), tagEditorBody: CM.$('tagEditorBody'),
    tagEditorHint: CM.$('tagEditorHint'), tagEditorSave: CM.$('tagEditorSave'),
    tagEditorCancel: CM.$('tagEditorCancel'), tagEditorClose: CM.$('tagEditorClose'),
    tagCoverFile: CM.$('tagCoverFile'),
    // Batch Bar
    batchBar: CM.$('batchBar'), batchBarCount: CM.$('batchBarCount'),
    batchEditTags: CM.$('batchEditTags'), batchDeleteTracks: CM.$('batchDeleteTracks'), batchClear: CM.$('batchClear')
  };

  /* ============================================
   * 播放顺序（宿主 PlaybackOrderName）
   * 宿主的 order 是**序号** 0..6，顺序为 default / repeat-playlist / repeat-track /
   * random / shuffle-tracks / shuffle-albums / shuffle-folders —— 不是 foobar 的
   * 标志位（0/1/2/4）。所以：下发一律用 name（名字不随序号表变），回读优先认 name，
   * 只有序号时才查 HOST_ORDER_NAMES；三种 shuffle 都归到「随机播放」这一档显示。
   * ============================================ */
  var HOST_ORDER_NAMES = ['default', 'repeat-playlist', 'repeat-track', 'random',
                          'shuffle-tracks', 'shuffle-albums', 'shuffle-folders'];
  CM.ORDERS = [
    { key: 'seq', host: 'default', name: '顺序播放', icon: 'seq' },
    { key: 'loop', host: 'repeat-playlist', name: '列表循环', icon: 'loop' },
    { key: 'one', host: 'repeat-track', name: '单曲循环', icon: 'one' },
    { key: 'shuffle', host: 'random', name: '随机播放', icon: 'shuffle' }
  ];
  // (name, index) → 我方档位下标；name 优先，认不出再看序号
  CM.orderIndexOf = function(orderName, orderIndex) {
    var host = orderName || HOST_ORDER_NAMES[orderIndex | 0] || '';
    if (host === 'shuffle-tracks' || host === 'shuffle-albums' || host === 'shuffle-folders') host = 'random';
    for (var i = 0; i < CM.ORDERS.length; i++) if (CM.ORDERS[i].host === host) return i;
    return 0;
  };

  /* ============================================
   * 状态
   * ============================================ */
  CM.state = {
    currentTab: 'discover',
    currentPlaylistIndex: -1,   // 正在查看的播放列表
    playingPlaylistIndex: -1,   // 正在播放的播放列表
    playingTrackIndex: -1,      // 正在播放的曲目索引
    order: 0,                   // 当前档位（CM.ORDERS 的下标，不是宿主序号）
    stopAfterCurrent: false,
    lyricsVisible: true,
    visualizerActive: true,
    queueOpen: false,
    historyOpen: false,          // 队列抽屉里「播放历史」面板是否展开（持久化在 settings.historyOpen）
    seeking: false,
    playing: false,              // 播放中（PlaybackClock 不可用时的回退标志）
    canSeek: true,               // v2：当前曲目可否跳转（电台流为 false）
    npOpen: false,              // 沉浸式页面是否打开
    npMode: 'vinyl',            // 'vinyl' | 'lyrics'
    npSeeking: false,
    duration: 0,
    position: 0,
    volume: 100,
    muted: false,
    libraryView: 'stats',       // stats | artists | albums | genres | artist | album | genre
    libraryArg: null,
    libScrollTop: 0,             // 进入下钻详情前的列表滚动位置（返回时恢复）
    libScrollRestore: false,     // 标志：从详情返回列表时需恢复滚动位置
    sortKey: null,
    sortAsc: true,
    trackCache: [],             // 当前播放列表曲目缓存（排序/右键用）
    playlistTracksTotal: 0,
    searchTracks: [],            // 最近一次搜索结果缓存（添加到歌单用）
    batchSelected: new Set(),    // 批量选中的曲目索引集合（Ctrl+click 多选）
    focusedTrackIndex: -1,       // 播放列表中最后单击聚焦的曲目索引（Alt+↑/↓ 移动用）
    focusedPlaylistIndex: -1,    // 聚焦行所属歌单（仅在当前歌单内有效，防止跨歌单误移动）
    plFilter: '',                // 歌单内筛选的查询串（v2 getMatchingRows）
    filterRows: null,            // 筛选命中的歌单真实行号（null = 未筛选）
    filterTracks: null           // 与 filterRows 一一对应的曲目（超出已加载窗口时由 getTracksAt 取回）
  };
  CM.currentTrack = null;
  CM.currentLyrics = [];
  CM.activeLyricIndex = -1;

  /* ============================================
   * 设置持久化（localStorage）
   * ============================================ */
  var SETTINGS_KEY = 'cloudmusic-settings-v2';
  // 权威副本只在主窗口（小窗不写 localStorage），小窗经 window:message 回报。
  CM.settings = { lyricsVisible: true, visualizer: true, tab: 'discover', volume: null, tilt3d: false, lyricModes: {}, lyricPicks: {}, lyricSources: {}, onlineNavOpen: false, spectrumMode: 'bars', popupMode: 'mini', popupGeom: null, rememberGuid: '', tray: false, lastPlaylist: '', contextGuid: '', historyMax: 20, historyOpen: false };
  CM.loadSettings = function() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        for (var k in CM.settings) if (s[k] !== undefined) CM.settings[k] = s[k];
      }
    } catch (e) {}
    // 设置可能被手工改坏或来自旧版本：lyricModes 必须是普通对象，
    // 否则下面按路径读写会抛 TypeError（严格模式下给字符串/数字/ null 挂属性即报错）
    if (!CM.settings.lyricModes || typeof CM.settings.lyricModes !== 'object' || Array.isArray(CM.settings.lyricModes)) {
      CM.settings.lyricModes = {};
    }
    // 同理由：lyricPicks（按文件记忆的手动取词选择）/ lyricSources（多源启停）
    // 被改坏会让按路径读写抛 TypeError 或让某源被静默关掉
    if (!CM.settings.lyricPicks || typeof CM.settings.lyricPicks !== 'object' || Array.isArray(CM.settings.lyricPicks)) {
      CM.settings.lyricPicks = {};
    }
    if (!CM.settings.lyricSources || typeof CM.settings.lyricSources !== 'object' || Array.isArray(CM.settings.lyricSources)) {
      CM.settings.lyricSources = {};
    }
  };
  CM.saveSettings = function() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(CM.settings)); } catch (e) {}
  };

  // 双语配对模式：按文件（歌词来源路径）记忆用户的手动选择，
  // 'auto' 不落盘（删除该项即回到自动判定）。上限 500 条，超出按插入顺序淘汰。
  CM.lyricModeFor = function(path) {
    var m = CM.settings.lyricModes;
    return (path && m && typeof m[path] === 'string' && m[path]) || 'auto';
  };
  CM.setLyricMode = function(path, mode) {
    if (!path) return;
    var m = CM.settings.lyricModes;
    if (!m || typeof m !== 'object' || Array.isArray(m)) m = CM.settings.lyricModes = {};
    if (mode === 'auto') delete m[path]; else m[path] = mode;
    var keys = Object.keys(m);
    for (var i = 0; keys.length - i > 500; i++) delete m[keys[i]];
    CM.saveSettings();
  };

  /* ============================================
   * 播放时钟（插件 v2 的 PlaybackClock）
   * playback:timeHighRes 只有约 30fps，且宿主负载高时会抖动/掉帧 ——
   * 两次更新之间的位置用时钟（hostTime 锚点 + 本地单调时钟）推算，
   * 进度条与歌词高亮就不会一跳一跳。取不到时钟（旧宿主 / 无宿主预览）时
   * 静默退回事件驱动的 state.position。
   * 注意：宿主给的 position 已经扣掉了输出与 DSP 延迟，不要再自己补。
   * ============================================ */
  CM.clock = null;
  CM.initClock = function() {
    if (CM.clock || !fb.PlaybackClock) return;
    try { CM.clock = new fb.PlaybackClock(); } catch (e) { CM.clock = null; }
  };
  CM.nowPosition = function() {
    if (CM.clock) {
      try {
        var p = CM.clock.position();
        if (typeof p === 'number' && isFinite(p)) return p;
      } catch (e) { /* 时钟不可用时回退 */ }
    }
    return CM.state.position;
  };
  CM.clockPlaying = function() {
    if (CM.clock) {
      try { return CM.clock.state === 'playing'; } catch (e) {}
    }
    return !!CM.state.playing;
  };

  /* ============================================
   * 工具函数
   * ============================================ */
  CM.formatTime = function(sec) {
    if (!sec || sec <= 0 || !isFinite(sec)) return '0:00';
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    return m + ':' + (s < 10 ? '0' : '') + s;
  };

  // formatTime 的小容量缓存：timeHighRes ~30fps 对同一秒值重复格式化，
  // position 每秒才变一次、duration 恒定，16 项 FIFO 命中率接近 100%
  var _ftCache = {}, _ftKeys = [];
  CM.formatTimeCached = function(sec) {
    if (!sec || sec <= 0 || !isFinite(sec)) return '0:00';
    var k = Math.floor(sec);
    var hit = _ftCache[k];
    if (hit !== undefined) return hit;
    var s = CM.formatTime(k);
    _ftCache[k] = s;
    _ftKeys.push(k);
    if (_ftKeys.length > 16) delete _ftCache[_ftKeys.shift()];
    return s;
  };

  CM.formatSize = function(bytes) {
    bytes = +bytes || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  };

  // foobar 查询引擎的字符串无任何转义机制（\"、/\"、双写引号、单引号包裹实测均不支持），
  // 但 IS/HAS 支持 glob 通配符：含引号的标签值用 ? 逐位替换引号，构造等长近精确查询，
  // 再由调用方按原值在客户端二次过滤
  CM.wildValue = function(v) {
    return typeof v === 'string' && v ? v.replace(/"/g, '?') : null;
  };

  /* 在线曲目的显示名
     ------------------------------------------------------------
     在线曲目在 foobar 里是**裸直链**，没有任何标签（宿主对 URL 曲目查不出
     标题），主题只能退回「URL 最后一段」当名字 —— 而 CDN 直链的签名参数里
     常带 `/`（网易云的 vuutv、QQ 的 vkey），于是界面会把签名碎片当成歌名
     （实测标题显示成 "GsvWzqeUwhOhb+2GUTYfbcNo="）。搜索列表里名字是对的、
     一放进 foobar 播放就变乱码，说的就是这里。
     各在线音源桥接模块在加载时把「直链 → 曲目信息」的查询函数注册进来
     （QQBridge / NeteaseBridge 播放与下载时都会记下映射并持久化），取名时
     优先查它，查不到才退回 URL 推断。 */
  CM.onlineNameProviders = [];
  CM.registerOnlineName = function(fn) {
    if (typeof fn === 'function' && CM.onlineNameProviders.indexOf(fn) < 0) {
      CM.onlineNameProviders.push(fn);
    }
  };
  CM.onlineName = function(path) {
    if (!path || !CM.isUrlPath(path)) return null;
    for (var i = 0; i < CM.onlineNameProviders.length; i++) {
      var r = null;
      try { r = CM.onlineNameProviders[i](path); } catch (e) { r = null; }
      if (r && (r.title || r.artist)) return r;
    }
    return null;
  };

  CM.trackName = function(t) {
    if (!t) return '未知曲目';
    if (t.title) return t.title;
    var p = CM.trackPath(t);
    var nm = CM.onlineName(p);
    if (nm && nm.title) return nm.title;
    if (!p) return '未知曲目';
    var s = String(p).replace(/\\/g, '/');
    // 直链的查询串里会带 `/`（签名参数），不先切掉就会把碎片当成歌名
    var q = s.indexOf('?');
    if (q >= 0) s = s.slice(0, q);
    return s.split('/').pop() || '未知曲目';
  };

  CM.trackArtist = function(t) {
    if (!t) return '';
    if (t.artist || t.albumArtist) return t.artist || t.albumArtist;
    var nm = CM.onlineName(CM.trackPath(t));
    return (nm && nm.artist) || '未知艺术家';
  };

  /* ============================================
   * 播放列表身份（插件 v2 起 playlist.* 都带 guid）
   * 索引会随歌单增删/移动而变，guid 不会 —— 记住"上次听歌的歌单"、
   * 固定在线歌单都用它，索引只当当前会话的定位方式。
   * ============================================ */
  CM.playlistRow = function(index) {
    var lists = CM.playlists || [];
    for (var i = 0; i < lists.length; i++) {
      if (lists[i] && lists[i].index === index) return lists[i];
    }
    return null;
  };
  CM.playlistGuid = function(index) {
    var row = CM.playlistRow(index);
    return (row && row.guid) || '';
  };
  CM.playlistIndexByGuid = function(guid) {
    if (!guid) return -1;
    var lists = CM.playlists || [];
    for (var i = 0; i < lists.length; i++) {
      if (lists[i] && lists[i].guid === guid) return lists[i].index;
    }
    return -1;
  };

  // 用于 artwork/rating 等 API 的最佳路径
  CM.trackPath = function(t) {
    if (!t) return '';
    return t.absolutePath || t.path || '';
  };

  // 在线曲目（QQ 音乐 CDN 直链等）：「路径」是 http(s) URL，不是磁盘文件。
  // 标签编辑 / 在资源管理器中显示 / 读同名 .lrc 这类文件操作对它没有意义，
  // 各调用点用这两个判定决定禁用或改走在线链路。
  CM.isUrlPath = function(p) {
    return /^https?:\/\//i.test(String(p || ''));
  };

  // foobar2000 配置目录（宿主只给一次就缓存；取不到回 ''）。
  // 下载目录、歌词库、ESLyric 数据目录都挂在它下面，多处复用。
  var _profilePathCache = null;
  CM.profilePath = function() {
    if (_profilePathCache !== null) return Promise.resolve(_profilePathCache);
    return CM.api('misc.getProfilePath').then(function(r) {
      _profilePathCache = (r && (r.path || r.value)) || '';
      return _profilePathCache;
    }, function() {
      _profilePathCache = '';
      return '';
    });
  };

  /* 把一个目录里的内容整体搬到另一个目录（下载目录改名后的自动迁移）。
     逐个搬、逐个容错：某个条目搬不动就留在原地，绝不影响别的；
     搬完若源目录已空就删掉它（宿主同步 file.delete 不删非空目录，所以有残留时
     删除会失败、原目录保留 —— 不会丢文件）。任何异常都安静降级。
     返回 Promise<成功搬走的条目数>。
     注：反斜杠一律用 String.fromCharCode(92) 取，避免源码里出现转义歧义。 */
  CM.moveDirContents = function(from, to) {
    var BS = String.fromCharCode(92);
    function isSep(ch) { return ch === BS || ch === '/'; }
    function join(dir, name) {
      var d = String(dir);
      while (d.length > 1 && isSep(d.charAt(d.length - 1))) d = d.slice(0, -1);
      return d + BS + name;
    }
    function baseName(path) {
      var t = String(path);
      while (t.length > 1 && isSep(t.charAt(t.length - 1))) t = t.slice(0, -1);
      var i = Math.max(t.lastIndexOf(BS), t.lastIndexOf('/'));
      return i >= 0 ? t.slice(i + 1) : t;
    }
    // v2 的 file.list 应答同时给 files 与 items（同一份列表的两个名字）以及 directories。
    // 旧实现把认得的数组键全部 concat —— 每个条目录两遍、目录也被当成文件搬
    // （失败被吞所以不丢文件，但搬迁计数虚高）。改为：文件列表取第一个存在的键，
    // 目录单独列出，最后按名字去重。
    function entriesOf(r, keys) {
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(r[keys[i]])) return r[keys[i]];
      }
      return [];
    }
    function toNames(list) {
      var out = [];
      for (var j = 0; j < list.length; j++) {
        var e = list[j];
        var nm = (typeof e === 'string') ? e
               : String((e && (e.name || e.path || e.fileName || e.fullName)) || '');
        nm = baseName(nm);
        if (nm && out.indexOf(nm) < 0) out.push(nm);
      }
      return out;
    }
    function names(r) {
      if (Array.isArray(r)) return toNames(r);
      if (r && typeof r === 'object') {
        var files = entriesOf(r, ['files', 'items', 'entries', 'list', 'children']);
        var dirs = entriesOf(r, ['directories', 'dirs', 'subdirs', 'folders']);
        if (files.length || dirs.length) return toNames(files.concat(dirs));
        return toNames(entriesOf(r, ['files', 'entries', 'items', 'list', 'children', 'dirs', 'directories', 'subdirs', 'folders']));
      }
      return [];
    }
    return CM.api('file.exists', { path: from }).then(function(e) {
      if (!e || e.exists === false) return 0;
      return CM.api('file.list', { path: from }).then(function(r) {
        var list = names(r);
        if (!list.length) return 0;
        var chain = Promise.resolve(0);
        list.forEach(function(n) {
          chain = chain.then(function(count) {
            return CM.api('file.move', { source: join(from, n), destination: join(to, n) })
              .then(function() { return count + 1; }, function() { return count; });
          });
        });
        return chain;
      }).then(function(moved) {
        return CM.api('file.delete', { path: from })
          .then(function() { return moved; }, function() { return moved; });
      });
    }).catch(function() { return 0; });
  };

  CM.escHtml = function(s) {
    return s == null ? '' : String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  CM.debounce = function(fn, ms) {
    var timer = null;
    return function() {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function() { fn.apply(self, args); }, ms);
    };
  };

  // 一次性执行工厂：统一各模块"事件委托只绑一次"的守卫模式
  // 用法：CM.runOnce('ctxMenuDelegation', function() { ...addEventListener... });
  var _runOnceKeys = {};
  CM.runOnce = function(key, setupFn) {
    if (_runOnceKeys[key]) return false;
    _runOnceKeys[key] = true;
    setupFn();
    return true;
  };

  // 延迟加载指示器：API 快速返回（<ms）时不闪烁，保留旧内容
  // 返回 cancel 函数，在 API 回调中调用以取消转圈
  CM.delayedLoading = function(showFn, ms) {
    var timer = setTimeout(showFn, ms == null ? 150 : ms);
    return function() { clearTimeout(timer); };
  };

  // 按钮 loading 状态：禁用并替换文本，返回恢复函数（自动还原原文本）
  // 用法：var resetBtn = CM.setBtnLoading(btn, '加载中...'); ... resetBtn();
  CM.setBtnLoading = function(btn, loadingText) {
    if (!btn) return function() {};
    var span = btn.querySelector('span');
    var prevText = span ? span.textContent : null;
    btn.disabled = true;
    if (span) span.textContent = loadingText;
    return function() {
      btn.disabled = false;
      if (span) span.textContent = prevText;
    };
  };

  // 通用频谱条更新（迷你频谱 + 沉浸式频谱共用）
  // 对数压缩 (pow 0.7) 使视觉更平滑；maxH/mult 由调用方按频谱条尺寸传入
  // 使用 transform:scaleY 代替 height，避免每帧 layout 重排（composite-only）
  // Math.pow(v, 0.7) 每帧每条都调用，量化为 256 级查找表（频谱值为 0..1 归一化）
  var _powLut = new Float32Array(256);
  for (var _pi = 0; _pi < 256; _pi++) _powLut[_pi] = Math.pow(_pi / 255, 0.7);
  CM.updateSpectrumBars = function(barEls, spec, count, maxH, mult) {
    if (!barEls || !barEls.length || !spec || !spec.length) return;
    var step = spec.length / count;
    for (var i = 0; i < count; i++) {
      var v = spec[Math.floor(i * step)] || 0;
      var q = (v * 255 + 0.5) | 0; // 四舍五入量化到 0..255
      if (q < 0) q = 0; else if (q > 255) q = 255;
      var h = Math.max(2, Math.min(maxH, _powLut[q] * mult));
      barEls[i].style.transform = 'scaleY(' + (h / maxH).toFixed(3) + ')';
    }
  };

  // 歌词解析缓存（歌词面板热路径）：key = 路径 + 模式 + 长度 + 头部 64 字符
  // 模式必须进 key：同一文件切换"同刻/延后"后需要重新解析，否则会命中旧结果
  var _lrcCache = {}, _lrcKeys = [], _lrcVerdicts = {};
  CM.parseLRCCached = function(key, lrcText, mode) {
    if (!lrcText) return [];
    var hit = _lrcCache[key];
    if (hit) {
      // 命中缓存时一并恢复判定结果，否则右键菜单会显示上一个文件的识别状态
      CM.lyric.lastVerdict = _lrcVerdicts[key] || 'none';
      return hit;
    }
    var parsed = CM.lyric.parse(lrcText, null, mode);
    _lrcVerdicts[key] = CM.lyric.lastVerdict;
    // 新解析器返回毫秒，渲染层期望秒
    for (var i = 0; i < parsed.length; i++) {
      parsed[i].time = parsed[i].time != null ? parsed[i].time / 1000 : null;
      parsed[i].startTime = parsed[i].startTime / 1000;
      if (parsed[i].endTime != null) parsed[i].endTime = parsed[i].endTime / 1000;
      if (parsed[i].words) {
        for (var w = 0; w < parsed[i].words.length; w++) {
          parsed[i].words[w].time /= 1000;
          parsed[i].words[w].startTime /= 1000;
          parsed[i].words[w].endTime /= 1000;
        }
      }
    }
    _lrcCache[key] = parsed;
    _lrcKeys.push(key);
    if (_lrcKeys.length > 8) { var old = _lrcKeys.shift(); delete _lrcCache[old]; delete _lrcVerdicts[old]; }
    return parsed;
  };
  CM.makeLRCCacheKey = function(path, lrcText, mode) {
    return (path || '') + '|' + (mode || 'auto') + '|' + lrcText.length + '|' + lrcText.slice(0, 64);
  };
  // 缓存键含"长度 + 头部 64 字符"——本地 .lrc 被改动而这两者不变时（改错别字、
  // 改行内时间戳）会命中旧解析结果，「刷新歌词」看起来毫无作用。刷新入口要能清它。
  CM.clearLRCCache = function() { _lrcCache = {}; _lrcKeys = []; _lrcVerdicts = {}; };

  /* ============================================
   * 动态配色 — 从封面提取活力色写入 HSL 令牌
   * ============================================ */
  CM.rgbToHsl = function(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        default: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return [h, s, l];
  };

  // 按饱和度加权取样，避免平均色发灰
  // 复用 Image 和 canvas 对象，避免每次切歌都创建新对象
  var _colorImg = new Image();
  _colorImg.crossOrigin = 'anonymous';
  var _colorCanvas = document.createElement('canvas');
  _colorCanvas.width = 48; _colorCanvas.height = 48;
  var _colorCtx = _colorCanvas.getContext('2d');
  var _colorSize = 48;
  CM._accentHue = 0;              // --accent-h 的初始值（variables.css 里是 0）

  CM.extractColorFromImage = function(url) {
    if (!url) { CM.resetAccent(); return; }
    _colorImg.onload = function() {
      try {
        _colorCtx.clearRect(0, 0, _colorSize, _colorSize);
        _colorCtx.drawImage(_colorImg, 0, 0, _colorSize, _colorSize);
        var data = _colorCtx.getImageData(0, 0, _colorSize, _colorSize).data;
        var wr = 0, wg = 0, wb = 0, wSum = 0;
        for (var i = 0; i < data.length; i += 4) {
          var r = data[i], g = data[i + 1], b = data[i + 2];
          var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          var sat = mx === 0 ? 0 : (mx - mn) / mx;
          var lum = (mx + mn) / 510;
          // 偏好饱和且亮度适中的像素
          var w = sat * sat * (1 - Math.abs(lum - 0.5) * 1.2) + 0.02;
          wr += r * w; wg += g * w; wb += b * w; wSum += w;
        }
        if (wSum <= 0) return;
        var hsl = CM.rgbToHsl(wr / wSum, wg / wSum, wb / wSum);
        var h = Math.round(hsl[0] * 360);
        var s = Math.round(Math.max(0.55, Math.min(0.9, hsl[1])) * 100);
        var l = Math.round(Math.max(0.5, Math.min(0.62, hsl[2])) * 100);
        var root = document.documentElement.style;
        root.setProperty('--accent', 'hsl(' + h + ',' + s + '%,' + l + '%)');
        root.setProperty('--accent-h', h);
        root.setProperty('--accent-s', s + '%');
        root.setProperty('--accent-l', l + '%');
        // 同步给 JS 侧一份：沉浸页画布每帧都要色相，read 一次 getComputedStyle()
        // 会强制样式重算 —— 缓存在这里，改色时更新（见 ui-nowplaying 的 specHue）
        CM._accentHue = h;
        // 小窗（桌面歌词 / 迷你播放器）用同一套配色：把取色结果发到跨窗口状态
        if (CM.publishTheme) CM.publishTheme(h, s, l);
      } catch (e) { /* 跨域或解码失败时保持默认色 */ }
    };
    _colorImg.onerror = function() {};
    _colorImg.src = url;
  };

  CM.resetAccent = function() {
    var root = document.documentElement.style;
    root.setProperty('--accent', '#EC4141');
    root.setProperty('--accent-h', '0');
    root.setProperty('--accent-s', '81%');
    root.setProperty('--accent-l', '59%');
    CM._accentHue = 0;
    if (CM.publishTheme) CM.publishTheme(0, 81, 59);
  };

  /* ============================================
   * SVG 图标库（供渲染函数复用）
   * ============================================ */
  CM.icons = {
    play: '<svg viewBox="0 0 24 24"><polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
    queue: '<svg viewBox="0 0 24 24"><path d="M21 15V6"/><path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/><path d="M12 12H3"/><path d="M16 6H3"/><path d="M12 18H3"/></svg>',
    star: '<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    check: '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    // Popover 专用图标
    desktopLyric: '<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-2.5c0-.5-.5-1-1-1h-1.5l-1-7.5h-7l-1 7.5H6c-.5 0-1 .5-1 1V17z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    eq: '<svg viewBox="0 0 24 24"><path d="M3 12h2l2-8 4 16 3-10 2 4h5"/></svg>',
    output: '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    console: '<svg viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    preferences: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    // 标签编辑/封面/下载
    tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    // 曲目排序 / 调整顺序
    up: '<svg viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    down: '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
    toTop: '<svg viewBox="0 0 24 24"><line x1="4" y1="4" x2="20" y2="4"/><line x1="12" y1="20" x2="12" y2="8"/><polyline points="7 13 12 8 17 13"/></svg>',
    toBottom: '<svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="20"/><line x1="12" y1="4" x2="12" y2="16"/><polyline points="7 11 12 16 17 11"/></svg>',
    reverse: '<svg viewBox="0 0 24 24"><polyline points="7 3 3 7 7 11"/><path d="M3 7h13a5 5 0 0 1 5 5v1"/><polyline points="17 21 21 17 17 13"/><path d="M21 17H8a5 5 0 0 1-5-5v-1"/></svg>',
    grip: '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    // 系统托盘（最小化到托盘）
    tray: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10"/><polyline points="7 9 12 14 17 9"/><path d="M4 18h16"/></svg>',
    // 更多菜单 / 设置页导航（本轮新增）
    menu: '<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
  };
})();
