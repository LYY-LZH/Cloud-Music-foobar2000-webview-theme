/* ============================================
 * CloudMusic ui-lyrics.js — 歌词
 * 多编码解码 / LRC 解析结果渲染 / 同步高亮 / 逐字高亮
 * 主歌词面板显隐（右栏开合动画）
 * ============================================ */

(function() {
  'use strict';
  var CM = window.CloudMusic;
  var els = CM.els, state = CM.state, esc = CM.escHtml;

  /* ============================================
   * 歌词
   * ============================================ */
  // 健壮解码：base64 raw bytes → 编码探测 + TextDecoder
  CM.decodeTextBytes = function(b64) {
    var raw = atob(b64);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return CM.lyric.decodeBytes(bytes).text;
  };

  CM._renderLyrics = function(r, lyricsText) {
    if (!r || r.success === false || !r.available || !lyricsText) {
      // 清掉旧歌词：沉浸页与主面板共用 currentLyrics，否则会停留在上一首
      CM.currentLyrics = [];
      CM.currentLyricsRaw = '';
      CM._lyricsSynced = false;
      CM.renderLyricsEmpty('暂无歌词');
      return;
    }
    // 原始文本留一份：右键「保存歌词到文件 / 嵌入到标签」要的是原文（不重排、不改字）
    CM.currentLyricsRaw = String(lyricsText);
    // 双语配对模式按"歌词来源路径"记忆（右键菜单可改）；路径同时用于"打开所在文件夹"
    var srcPath = r.sourcePath || (CM.currentTrack && CM.trackPath(CM.currentTrack)) || '';
    CM.lyricSourcePath = srcPath;
    var mode = CM.lyricModeFor(srcPath);
    // 以"路径+模式+长度+头部"为 key 缓存解析结果：切回已播过的曲目时免去重新解析
    var parsed = CM.parseLRCCached(
      CM.makeLRCCacheKey(srcPath, lyricsText, mode),
      lyricsText, mode
    );
    // 只有解析出时间戳才按同步歌词渲染/高亮。整首无时间轴的纯文本歌词若走同步分支，
    // 高亮的二分查找会把 null 当作 0 而永远命中最后一行 —— 表现为末行固定高亮、
    // 面板被滚到底部、点击任意行都无法跳转。
    // 纯文本仍放入 currentLyrics（沉浸页据此显示歌词正文），仅关闭时间轴高亮。
    var timed = false;
    for (var i = 0; i < parsed.length; i++) {
      if (parsed[i].time != null) { timed = true; break; }
    }
    CM.currentLyrics = parsed;
    CM._lyricsSynced = timed;
    if (timed) CM.renderSyncedLyrics(parsed);
    else CM.renderPlainLyrics(lyricsText, parsed);
    CM._syncNpLyrics();
    CM.publishLyrics();
  };

  // 歌词加载链路已由 lyrics-resolver.js 接管（本地同名 .lrc / 歌词库优先 → 页内桥接
  // 联网匹配兜底），本文件不再自带一份实现：两份同名函数只会让后加载的那份生效、
  // 另一份变成带行为差异的死代码（旧实现不做在线匹配，容易误导后续维护）。
  CM._lyricLoadId = 0;

  CM._lyricsSynced = false;   // 当前歌词是否带时间轴（纯文本时不做时间高亮）
  CM.lyricSourcePath = '';    // 当前歌词来源路径（右键菜单：模式记忆键 + 打开所在文件夹）

  // action：空态的下一步出口。'retry' = 取词失败可重试（再走一次链路）；
  // 'search' = 在线确实没有，直接开候选面板手动找。不给出口时只显示文字。
  CM.renderLyricsEmpty = function(text, keepNp, action) {
    var acts = '';
    if (action === 'retry') {
      acts = '<div class="lyrics-empty-acts">' +
        '<button class="lyrics-empty-act" data-act="retry">重试</button>' +
        '<button class="lyrics-empty-act" data-act="search">搜索歌词</button></div>';
    } else if (action === 'search') {
      acts = '<div class="lyrics-empty-acts">' +
        '<button class="lyrics-empty-act" data-act="search">搜索歌词</button></div>';
    }
    els.lyricsScroll.innerHTML =
      '<div class="lyrics-empty">' + CM.icons.note + '<span>' + esc(text) + '</span>' + acts + '</div>';
    if (acts) {
      var box = els.lyricsScroll.querySelector('.lyrics-empty-acts');
      if (box) box.addEventListener('click', function(e) {
        var b = e.target.closest('.lyrics-empty-act');
        if (!b) return;
        // 重试走 CM.lyricReload：它同时清掉本模块 memo 与桥接的在线匹配缓存，
        // 否则"刷新十次还是同一个结果"
        if (b.dataset.act === 'retry') {
          if (typeof CM.lyricReload === 'function') CM.lyricReload(); else CM.loadLyrics();
        } else {
          CM.openLyricSearch();
        }
      });
    }
    // 空态一并清掉判定结果：否则切到没有歌词的曲目后，右键菜单仍会显示上一个文件的
    // 「翻译对齐方式 / 识别为：X」，像是这首歌识别出来的
    CM.lyric.lastVerdict = 'none';
    // 同样清掉歌词来源路径：否则「暂无歌词」时右键菜单的「打开所在文件夹 /
    // 对齐方式」仍指向上一首有词的曲目
    CM.lyricSourcePath = '';
    if (!keepNp) CM._syncNpLyrics();
    CM.publishLyrics();   // 小窗同步清空，不能停着上一首的歌词
  };

  CM.publishLyrics = function() {
    if (!fb.sharedState || typeof fb.sharedState.set !== 'function') return;
    var lines = CM.currentLyrics || [];
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      out.push({
        t: l.time == null ? null : l.time,
        x: l.text || '',
        s: (l.subs && l.subs.length) ? l.subs : undefined
      });
    }
    var payload = { lines: out, synced: !!CM._lyricsSynced, at: Date.now() };
    try {
      /* 体积判断不整份 JSON.stringify：几千行歌词每次渲染 / 每次开小窗都序列化一遍
         是白花钱。按行文本长度粗估（每条 24 字节的结构开销 + 文本长度），超过阈值
         才截断到 600 行。 */
      var est = 0;
      for (var e2 = 0; e2 < out.length; e2++) {
        est += 24 + (out[e2].x ? out[e2].x.length : 0);
        var subs = out[e2].s;
        if (subs) for (var s2 = 0; s2 < subs.length; s2++) est += 24 + subs[s2].length;
        if (est > 60000) break;
      }
      if (est > 60000) {
        payload.lines = out.slice(0, 600);
        payload.truncated = true;
      }
      fb.sharedState.set('cm:lyrics', payload, false, 12 * 3600 * 1000);
    } catch (e) { /* 状态写入失败不影响主界面 */ }
  };

  // 封面取色的结果也发一份给小窗：桌面歌词 / 迷你播放器的强调色与主界面保持一致
  // （主界面是 JS 写 documentElement 的内联变量，小窗拿不到，必须这样传）
  CM.publishTheme = function(h, s, l) {
    if (!fb.sharedState || typeof fb.sharedState.set !== 'function') return;
    try { fb.sharedState.set('cm:theme', { h: h, s: s, l: l }, false, 12 * 3600 * 1000); } catch (e) {}
  };

  // 当前封面也发一份给小窗：在线曲目的封面由主题反查/下载成 dataURL，小窗自己
  // 问宿主是拿不到的（宿主对在线曲目给的是加载不出来的代理地址）。带上 path 让
  // 小窗能核对"这张图属于哪首"——切歌与取图是两条异步路径，可能前后脚到。
  CM.publishArt = function(path, url) {
    if (!fb.sharedState || typeof fb.sharedState.set !== 'function') return;
    try { fb.sharedState.set('cm:art', { path: path || '', url: url || '' }, false, 12 * 3600 * 1000); } catch (e) {}
  };

  // 小窗的曲名/歌手用主窗口算好的显示名（在线曲目在主题里有「直链 → 歌名」映射表），
  // 外加播放状态；事件驱动，一次切歌/一次状态变化才发一条
  CM.publishNow = function(playing) {
    if (!fb.sharedState || typeof fb.sharedState.set !== 'function') return;
    var t = CM.currentTrack;
    var payload = {
      title: t ? CM.trackName(t) : '未在播放',
      artist: t ? CM.trackArtist(t) : '',
      album: t ? (t.album || '') : '',
      duration: (t && (t.duration || t.length)) || CM.state.duration || 0,
      playing: !!playing,
      // 本地曲目：小窗按这个路径自己问宿主取封面（每首都是确定的）；
      // 在线曲目：路径是直链，小窗走 cm:art 那份反查好的封面
      path: t ? CM.trackPath(t) : '',
      at: Date.now()
    };
    try { fb.sharedState.set('cm:now', payload, false, 12 * 3600 * 1000); } catch (e) {}
  };

  /* ============================================
   * 小窗（两种形态）— 插件 v2 的弹窗 API
   *
   *   mini   迷你播放器：封面 + 曲名/歌手 + 进度 + 音量 + 上一首/播放/下一首
   *   lyrics 歌词窗（竖版）：上大封面 / 封面下小字歌曲信息 / 中间整首可滚动歌词 /
   *          底部进度与控制
   *
   * 两个形态是同一个页面 popup.html，靠 window.setSize 现场切换（不重建窗口）；
   * 曲名/歌词/封面/强调色由主窗口经 fb.sharedState 送来（主窗口已经解析/归组好）。
   * 窗口几何与小窗形态由**主窗口**持有（settings.popupGeom / popupMode），开窗时
   * 经 createPopup 的 x/y/width/height 交给小窗；小窗运行中用 window.sendMessage
   * 把新的形态与几何报回来。两个窗口共享同一份 localStorage，小窗自己写设置会用
   * 它的旧快照把主窗口刚存下的其它设置冲掉，所以那边一个字都不写。
   * ============================================ */
  // 尺寸按 CSS 像素写（人看到的大小）；createPopup / setSize / setMinSize 收的是
  // **物理像素**，所以开窗时统一乘窗口缩放比 —— 否则 125% / 150% 缩放下小窗会
  // 只有 2/3 大，组件挤成一团、歌词显示不全。
  var POPUP_CFG = {
    mini:   { label: '迷你播放器', w: 520, h: 168, minW: 400, minH: 150 },
    lyrics: { label: '歌词窗',     w: 460, h: 720, minW: 380, minH: 480 }
  };

  function popupScale() {
    // 缩放比只从 CM.dpr() 取（与主窗口/沉浸页同一口径），不要在本文件各写一份
    return CM.dpr ? CM.dpr() : ((window.devicePixelRatio > 0) ? window.devicePixelRatio : 1);
  }

  // 某个形态该用多大（物理像素）：优先沿用上次那次的几何，但
  //   · 换过显示器 / 改过缩放比例时按比例换算回来（存的是当时的物理像素）
  //   · 明显不合理的旧值（比最小尺寸还小，或比默认大三倍以上）直接丢弃用默认值 ——
  //     旧版本在错误单位下存下的值就落在这一档里
  function popupGeometry(mode) {
    var cfg = POPUP_CFG[mode], scale = popupScale();
    var g = (CM.settings.popupGeom && typeof CM.settings.popupGeom === 'object') ? (CM.settings.popupGeom[mode] || {}) : {};
    var w = +g.w || 0, h = +g.h || 0;
    if (w && h) {
      if (+g.scale > 0 && Math.abs(+g.scale - scale) / scale > 0.05) {
        w = Math.round(w * scale / +g.scale);
        h = Math.round(h * scale / +g.scale);
      }
      // 合理性检查：比最小尺寸还小、比默认大三倍以上，或者长宽比根本不像这个形态
      // （迷你播放器是横条、歌词窗是竖版）—— 旧版本在错误单位/错形态下存下的值会被丢掉
      var badAspect = (mode === 'mini') ? (h > w * 0.8) : (w > h * 1.1);
      if (w < cfg.minW * scale * 0.9 || h < cfg.minH * scale * 0.9 ||
          w > cfg.w * scale * 3 || h > cfg.h * scale * 3 || badAspect) {
        w = h = 0;
      }
    }
    return {
      w: w || Math.round(cfg.w * scale),
      h: h || Math.round(cfg.h * scale),
      minW: Math.round(cfg.minW * scale),
      minH: Math.round(cfg.minH * scale),
      x: (w && g.x != null) ? g.x : null,
      y: (w && g.y != null) ? g.y : null
    };
  }

  // 已开的小窗（window:popupOpened / popupClosed 维护，主窗口只保留一个）：
  // 已经开着时再点「小窗」不再开第二个，而是让已有的那个换形态并置前。
  var _popupWindows = {};
  var _popupBound = false;

  function bindPopupTracking() {
    if (_popupBound || typeof fb.on !== 'function') return;
    _popupBound = true;
    fb.on('window:popupOpened', function(e) {
      if (!e || !e.windowId) return;
      var url = String(e.url || '');
      if (url.indexOf('popup.html') < 0) return;        // 宿主自己用的弹窗不管
      var m = (url.match(/[?&]mode=(\w+)/) || [])[1];
      _popupWindows[e.windowId] = { mode: POPUP_CFG[m] ? m : 'mini' };
    });
    fb.on('window:popupClosed', function(e) {
      if (e && e.windowId) delete _popupWindows[e.windowId];
    });
    // 小窗把形态 / 几何报回来 → 由主窗口并进设置
    fb.on('window:message', function(e) {
      var m = e && e.message;
      if (!m || m.type !== 'cloudmusic-popup') return;
      if (e.sourceWindowId) {
        _popupWindows[e.sourceWindowId] = { mode: POPUP_CFG[m.mode] ? m.mode : 'mini' };
      }
      if (m.kind === 'mode' && POPUP_CFG[m.mode]) {
        CM.settings.popupMode = m.mode;
        CM.saveSettings();
      } else if (m.kind === 'geom' && m.bounds && POPUP_CFG[m.mode]) {
        var geo = CM.settings.popupGeom;
        if (!geo || typeof geo !== 'object') geo = CM.settings.popupGeom = {};
        // 记下当时的缩放比：换显示器 / 改缩放比例后按比例换算，尺寸不会变味
        geo[m.mode] = {
          x: m.bounds.x, y: m.bounds.y, w: m.bounds.width, h: m.bounds.height,
          scale: +m.scale > 0 ? +m.scale : popupScale()
        };
        CM.saveSettings();
      }
    });
  }

  function firstPopupId() {
    for (var k in _popupWindows) {
      if (Object.prototype.hasOwnProperty.call(_popupWindows, k)) return k;
    }
    return '';
  }
  CM.bindPopupTracking = bindPopupTracking;

  // 复用已有的小窗：换形态 → 让它重绘并置前 → 存活探测。
  // 三种情况都要管：
  //   · 正常：消息+focus 就够；
  //   · 画面停住（黑屏 / 旧画面）：只有那个窗口自己能 refreshWebView，靠 cmd:'reveal'；
  //   · 渲染进程已经没了：它不会回 hello，1.5 秒后关掉重开 —— 否则用户对着一个
  //     点不动的黑框，只能重启 foobar2000。
  function reusePopup(id, m) {
    var cur = _popupWindows[id] && _popupWindows[id].mode;
    CM.api('window.sendMessage', {
      targetWindowId: id,
      message: { type: 'cloudmusic-popup', cmd: 'setMode', mode: m }
    });
    CM.api('window.sendMessage', {
      targetWindowId: id,
      message: { type: 'cloudmusic-popup', cmd: 'reveal', mode: m }
    });
    CM.api('window.focus', { windowId: id });
    if (cur !== m) CM.showToast('小窗已切换为' + POPUP_CFG[m].label, null, 'success');

    var alive = false;
    var un = (typeof fb.on === 'function') ? fb.on('window:message', function(e) {
      var msg = e && e.message;
      if (msg && msg.type === 'cloudmusic-popup' && msg.kind === 'hello' &&
          e.sourceWindowId === id) alive = true;
    }) : null;
    CM.api('window.sendMessage', {
      targetWindowId: id,
      message: { type: 'cloudmusic-popup', cmd: 'ping' }
    });
    setTimeout(function() {
      if (un) un();
      if (alive) return;
      delete _popupWindows[id];
      CM.api('window.closePopup', { windowId: id }).then(function() {
        createPopupWindow(m);
        CM.showToast('小窗无响应，已重开', '上一个窗口的画面已经卡死', 'error');
      });
    }, 1500);
  }

  CM.openPopupWindow = function(mode) {
    var m = POPUP_CFG[mode] ? mode : (POPUP_CFG[CM.settings.popupMode] ? CM.settings.popupMode : 'mini');
    CM.settings.popupMode = m;
    CM.saveSettings();
    bindPopupTracking();

    var existing = firstPopupId();
    if (existing) {
      // 已经有小窗：换形态 + 置前。开第二个窗口只会让用户多出一个要关的窗口
      // （宿主上限 8 个），而且两个窗共享同一份跨窗口状态，没必要
      reusePopup(existing, m);
      return;
    }
    createPopupWindow(m);
  };

  function createPopupWindow(m) {
    var cfg = POPUP_CFG[m];
    var g = popupGeometry(m);
    var opts = {
      // 带版本号：popup.html 自己也改了（结构/CSS）时，避免 WebView2 命中旧页面
      // 却加载了新的 popup.js —— 两边版本对不上会出现元素找不到的怪问题
      url: 'popup.html?mode=' + m + '&v=16',
      title: 'CloudMusic ' + cfg.label,
      width: g.w,
      height: g.h,
      minWidth: g.minW,
      minHeight: g.minH,
      resizable: true,
      frame: false,                 // 自绘标题栏（拖动 / 换形态 / 置顶 / 关闭）
      transparent: false,
      alwaysOnTop: true,            // 默认置顶，小窗标题栏的图钉可关
      showInTaskbar: false,
      // 2.0 的 popup 行为。**owner 必须是 none**：owner:'main' 的语义是
      // "位于主窗口之上并随主窗口最小化"（官方文档原文），主窗口最小化 / 藏到托盘时
      // 小窗会跟着消失 —— 那就等于没有小窗（小窗存在的意义正是主窗口让位时还能看）。
      // keepVisibleOnShowDesktop：Win+D 显示桌面时小窗不被收走。旧宿主忽略未知键
      behavior: {
        owner: 'none',
        showInTaskbar: false,
        showInAltTab: false,
        keepVisibleOnShowDesktop: true,
        allowMinimize: false,
        noActivate: false
      }
    };
    if (g.x != null && g.y != null) { opts.x = g.x; opts.y = g.y; }
    CM.api('window.createPopup', opts).then(function(r) {
      if (!r || r.success === false) {
        CM.showToast('小窗打开失败', (r && r.error) || '宿主不接受弹窗（最多 8 个）', 'error');
        return;
      }
      if (r.windowId) _popupWindows[r.windowId] = { mode: m };
      CM.publishNow(!!CM.state.playing);
      CM.publishLyrics();
      CM.showToast(cfg.label + '已打开', m === 'mini' ? '滚轮可调音量' : '点歌词行可跳转', 'success');
    });
  };

  // 把当前歌词写回文件 / 嵌入标签（v2 的 lyrics.save：target = file / embedded / all）
  CM.saveLyricsToFile = function(embed) {
    var raw = CM.currentLyricsRaw || '';
    var track = CM.currentTrack;
    var path = track ? CM.trackPath(track) : '';
    if (!raw.trim()) { CM.showToast('没有可保存的歌词', null, 'error'); return; }
    if (!path || CM.isUrlPath(path)) {
      CM.showToast('无法保存', '在线曲目没有本地文件 —— 先「下载选中」落盘', 'error');
      return;
    }
    if (/\|subsong:/i.test(path)) {
      // v2 起子曲目不再自动共用一个歌词文件，必须显式给 filename；
      // 主题不猜名字（猜错会覆盖整轨的歌词），这类直接说明
      CM.showToast('无法保存', '整轨 / CUE 子曲目需要在 foobar2000 里手动保存歌词', 'error');
      return;
    }
    var target = embed ? ['embedded'] : ['file'];
    CM.api('lyrics.save', { path: path, lyrics: raw, target: target }).then(function(r) {
      if (!r || r.success === false) {
        CM.showToast('保存失败', (r && r.error) || '该格式可能不支持', 'error');
        return;
      }
      CM.showToast(embed ? '歌词已嵌入标签' : '歌词已保存到音频同目录', CM.trackName(track), 'success');
    });
  };

  // 沉浸式页与主面板共用 CM.currentLyrics：歌词异步到达（可能晚于沉浸页打开或
  // 晚于 onTrackChanged 里 200ms 的延迟重绘）时必须重绘，否则沉浸页会一直停在
  // 打开瞬间的空态「暂无歌词」，直到下次手动打开沉浸页。
  CM._syncNpLyrics = function() {
    if (state.npOpen && typeof CM.renderNpLyrics === 'function') CM.renderNpLyrics();
  };

  // 通用歌词 HTML 生成（主歌词面板 + 沉浸式共用）
  // 同一时刻的多行（翻译/音译）由解析层归为一组：主行照常渲染，副行以 .lyric-sub
  // 依次附在同一容器内，整组共享 active 高亮与滚动定位，任何一行都不会被丢弃。
  // wrapClass：可选，把整段歌词包进一个包裹层 —— 沉浸式用它实现"整块歌词像贴在一面
  // 斜墙上"的 3D 透视（旋转挂在包裹层、不挂在滚动容器上，故滚动/居中/遮罩全不受影响）。
  CM._renderLyricHTML = function(lines, lineClass, topPadPct, wrapClass) {
    var parts = ['<div style="height:' + topPadPct + '%"></div>'];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      parts.push('<div class="' + lineClass + (line.words ? ' has-words' : '') +
        (line.subs && line.subs.length ? ' has-subs' : '') +
        '" data-idx="' + i + '" data-time="' + line.time + '">');
      if (line.words) {
        for (var w = 0; w < line.words.length; w++) {
          parts.push('<span class="lyric-word" data-time="' + line.words[w].time + '">' + esc(line.words[w].text) + '</span>');
        }
      } else {
        parts.push(esc(line.text));
      }
      if (line.subs) {
        for (var s = 0; s < line.subs.length; s++) {
          parts.push('<div class="lyric-sub">' + esc(line.subs[s]) + '</div>');
        }
      }
      parts.push('</div>');
    }
    parts.push('<div style="height:40%"></div>');
    var html = parts.join('');
    return wrapClass ? '<div class="' + wrapClass + '">' + html + '</div>' : html;
  };

  // 通用歌词点击跳转：事件委托（一次性绑定在容器上，避免逐行 addEventListener）
  // 守卫挂在**容器元素**上而不是选择器字符串：主面板与沉浸页恰好用了不同选择器
  // 才没撞车，一旦有第二个容器复用同一选择器，第二次绑定会被静默跳过、点击失效
  CM._bindLyricClicks = function(container, lineSelector) {
    if (!container || container.__cmLyricClickBound) return;
    container.__cmLyricClickBound = true;
    container.addEventListener('click', function(e) {
      var el = e.target.closest(lineSelector);
      if (!el) return;
      var t = parseFloat(el.dataset.time);
      // v2：参数名 position（seconds 会被严格校验拒绝）；不可跳转的流直接不给假反馈
      if (isFinite(t) && state.canSeek !== false) CM.api('playback.setPosition', { position: t });
    });
  };

  // 通用歌词高亮（主面板 + 沉浸式共用）
  // 缓存节点列表，避免每次 timeHighRes 事件都 querySelectorAll
  CM._lyricNodesCache = null;      // 主面板歌词节点
  CM._npLyricNodesCache = null;    // 沉浸式歌词节点
  CM._wordCache = null;            // 主面板逐字节点 { lineIdx: NodeList }
  CM._npWordCache = null;          // 沉浸式逐字节点
  CM._updateLyricHighlight = function(container, lineSelector, activeIdxField, force, pos, cacheKey, wordCacheKey) {
    var lines = CM.currentLyrics;
    // 纯文本歌词（无时间轴）不做时间高亮：lines[i].time 为 null，
    // 二分查找会把 null 当 0 而恒命中最后一行
    if (!CM._lyricsSynced || !lines.length) return;
    // 二分查找最后一个 time <= pos 的行（行按时间升序），超长歌词（播客/长音频）下避免每帧从头线性扫描
    var idx = -1, lo = 0, hi = lines.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].time <= pos) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    var lineChanged = idx !== CM[activeIdxField];
    if (!lineChanged && !force) {
      CM._updateWordHighlight(container, idx, pos, wordCacheKey);
      return;
    }
    CM[activeIdxField] = idx;
    // 使用缓存节点（渲染时已缓存），避免每次都 querySelectorAll
    var nodes = cacheKey ? CM[cacheKey] : null;
    if (!nodes || nodes.length !== lines.length) {
      nodes = container.querySelectorAll(lineSelector);
      if (cacheKey) CM[cacheKey] = nodes;
    }
    for (var ni = 0; ni < nodes.length; ni++) {
      nodes[ni].classList.toggle('active', ni === idx);
    }
    CM._updateWordHighlight(container, idx, pos, wordCacheKey);
    if (idx >= 0 && nodes[idx]) {
      var target = nodes[idx];
      var top = target.offsetTop - container.clientHeight / 2 + target.clientHeight / 2;
      container.scrollTo({ top: top, behavior: force ? 'auto' : 'smooth' });
    }
  };

  CM.renderSyncedLyrics = function(lines) {
    els.lyricsScroll.innerHTML = CM._renderLyricHTML(lines, 'lyric-line', 34);
    CM._lyricNodesCache = null;
    CM._wordCache = null;
    CM._bindLyricClicks(els.lyricsScroll, '.lyric-line');
    CM.updateLyricHighlight(true);
  };

  CM.renderPlainLyrics = function(raw, parsed) {
    // 无时间轴：按行静态展示（若解析出文本行则用解析结果）。
    // 同时清掉同步渲染的节点缓存，避免纯文本模式下残留上一首的节点引用。
    CM._lyricNodesCache = null;
    CM._wordCache = null;
    var lines = parsed.length ? parsed.map(function(l) { return l.text; })
      : raw.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
    if (!lines.length) { CM.renderLyricsEmpty('暂无歌词'); return; }
    var parts = ['<div style="height:12px"></div>'];
    lines.forEach(function(text) { parts.push('<div class="lyric-line">' + esc(text) + '</div>'); });
    parts.push('<div style="height:20px"></div>');
    els.lyricsScroll.innerHTML = parts.join('');
  };

  CM.updateLyricHighlight = function(force) {
    if (!state.lyricsVisible) return;
    CM._updateLyricHighlight(els.lyricsScroll, '.lyric-line', 'activeLyricIndex', force, state.position + 0.25, '_lyricNodesCache', '_wordCache');
  };

  // 逐字高亮：在活动行内标记已唱词（.sung）
  // 缓存每行的 .lyric-word NodeList，避免 30fps 每帧都 querySelector
  CM._updateWordHighlight = function(container, lineIdx, pos, wordCacheKey) {
    if (lineIdx < 0) return;
    var line = CM.currentLyrics[lineIdx];
    if (!line || !line.words) return;
    var wordEls;
    if (wordCacheKey) {
      if (!CM[wordCacheKey]) CM[wordCacheKey] = {};
      wordEls = CM[wordCacheKey][lineIdx];
      if (!wordEls) {
        var lineEl = container.querySelector('[data-idx="' + lineIdx + '"]');
        if (!lineEl) return;
        wordEls = lineEl.querySelectorAll('.lyric-word');
        CM[wordCacheKey][lineIdx] = wordEls;
      }
    } else {
      var lineEl0 = container.querySelector('[data-idx="' + lineIdx + '"]');
      if (!lineEl0) return;
      wordEls = lineEl0.querySelectorAll('.lyric-word');
    }
    for (var i = 0; i < wordEls.length; i++) {
      var t = parseFloat(wordEls[i].dataset.time);
      wordEls[i].classList.toggle('sung', t <= pos);
    }
  };

  /* ============================================
   * 歌词面板显隐
   * ============================================ */
  var _rpAnimTimer = null;
  // 解冻主内容（恢复自适应宽度）
  function _unfreezeMain() {
    var tab = els.mainBody.querySelector('.tab-content[data-rp-frozen]');
    if (tab) { tab.style.width = ''; tab.style.right = ''; delete tab.dataset.rpFrozen; }
  }
  CM.setLyricsVisible = function(visible, instant) {
    state.lyricsVisible = visible;
    CM.settings.lyricsVisible = visible;
    CM.saveSettings();
    els.btnLyricsToggle.classList.toggle('active', visible);
    // 平滑开合且零卡顿的"冻结"方案（详见下方非对称冻结注释）：
    //   列轨道 0.26s 动画驱动 320px 固定宽面板平移进出（内部零重排、模糊背景零重绘），
    //   主内容冻结在像素宽度使动画期间零重排，全程每方向只有一次重排且时机自然。
    if (_rpAnimTimer) { clearTimeout(_rpAnimTimer); _rpAnimTimer = null; _unfreezeMain(); }
    var tab = els.mainBody.querySelector('.tab-content.active');
    if (instant || !tab) {
      els.app.classList.toggle('lyrics-hidden', !visible);
    } else {
      var rightW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--right-w'), 10) || 320;
      var cur = els.mainBody.clientWidth;
      // 对称冻结在"目标宽度"（两方向均把唯一一次重排放置在动画起点，被面板滑动掩盖）：
      //   显示：内容立刻重排变窄让位，面板滑入右侧空条；终点容器宽=冻结宽，解冻零变化。
      //   隐藏：内容立刻重排变宽（右侧 320px 被裁剪的部分恰好被尚未离开的面板遮住），
      //        面板滑出时逐像素显露已是最终布局的内容；终点同样零跳变。
      var target = visible ? cur - rightW : cur + rightW;
      tab.style.width = Math.max(0, target) + 'px';
      tab.style.right = 'auto'; // 左锚定，右侧被裁剪/展开的部分由滑动中的面板遮盖
      tab.dataset.rpFrozen = '1';
      els.app.classList.toggle('lyrics-hidden', !visible);
      _rpAnimTimer = setTimeout(function() {
        _rpAnimTimer = null;
        _unfreezeMain();
      }, 300); // > 0.26s CSS 动画
    }
    if (visible) setTimeout(function() { CM.updateLyricHighlight(true); }, 300);
  };

  /* ============================================
   * 歌词面板右键菜单
   *
   * 双语配对协议在真实歌词里没有统一规范（同刻 / 译文晚一行，还有部分翻译、
   * 未翻译原词夹在中间等混合形态），自动判据不可能全覆盖。这里给用户一条权限：
   * 按文件（歌词来源路径）指定配对方式，另外放上几个常用操作。
   * 文案用日常说法：同刻 = 译文跟原文同时；延后 = 译文晚一行。
   * ============================================ */
  // 三种对齐方式：自动识别 / 标准双语（译文与原文同刻）/ 兼容旧版（译文写在下一句时间上）
  var _MODE_LABEL = { auto: '自动识别', same: '标准双语', offset: '兼容旧版' };
  function _verdictText() {
    switch (CM.lyric.lastVerdict) {
      case 'delay': return '兼容旧版';
      case 'same': return '标准双语';
      case 'none': return '没有双语行';
      default: return '没认出来';
    }
  }

  CM.showLyricMenu = function(x, y) {
    var path = CM.lyricSourcePath || '';
    var cur = CM.lyricModeFor(path);
    // 仅本地盘路径可打开：在线播放 / 在线匹配的歌词会回落成 http(s) 直链，
    // 宿主无法定位这类路径，可点但静默无操作不如置灰
    var canOpenFolder = /^[a-z]:[\\/]/i.test(path) || path.indexOf('\\\\') === 0;
    // 只有存在"重复时间戳"（同一时刻多行）才可能有对齐问题：单语言、纯文本、
    // 逐字（ESLyric）歌词的 lastVerdict 为 'none'。此时不显示这一项，
    // 但若该文件已被手动指定过方式，仍显示（否则用户无法改回自动）
    var hasAlign = CM.lyric.lastVerdict !== 'none' || cur !== 'auto';
    function apply(mode) { CM.setLyricMode(path, mode); CM.loadLyrics(); }
    var items = [{ label: '歌词', isLabel: true }];
    if (hasAlign) {
      items.push({ label: '翻译对齐方式：' + (_MODE_LABEL[cur] || _MODE_LABEL.auto), submenu: [
        { label: '自动识别：', desc: '自动判断歌词格式', checked: cur === 'auto', action: function() { apply('auto'); } },
        { label: '标准双语：', desc: '原词和翻译在同一时间戳', checked: cur === 'same', action: function() { apply('same'); } },
        { label: '兼容旧版：', desc: '翻译在下一时间戳', checked: cur === 'offset', action: function() { apply('offset'); } }
      ] });
      // 手动指定时父项已写明方式，再报"自动识别结果"反而绕；只在使用自动时给出识别结果
      if (cur === 'auto') items.push({ label: '识别为：' + _verdictText(), isLabel: true });
    }
    // 音频文件自身的路径（保存/嵌入歌词要用它，而不是歌词来源 .lrc 的路径）
    var trackPath = CM.currentTrack ? CM.trackPath(CM.currentTrack) : '';
    var canSave = !!String(CM.currentLyricsRaw || '').trim() && !!trackPath &&
                  !CM.isUrlPath(trackPath);
    // 手动选择（按文件记忆）用的键与 lyrics-resolver 保持一致：歌词来源路径优先，
    // 在线/内嵌歌词回落到音频路径
    var pickKey = path || trackPath;
    var pinned = (CM.lyricSources && CM.lyricSources.pick) ? CM.lyricSources.pick(pickKey) : null;
    items.push({ divider: true },
      // 走 CM.lyricReload：它不仅重载，还会清掉本模块的内存 memo 与 QQBridge 的
      // 30 分钟在线匹配缓存。直接调 CM.loadLyrics 时两者都还在，刷新十次也是同一结果。
      { label: '刷新歌词', action: function() {
        if (typeof CM.lyricReload === 'function') CM.lyricReload(); else CM.loadLyrics();
      } },
      // 歌词工具：搜索 / 复制 / 嵌入 / 保存 —— 都是"对这份歌词做点什么"，
      // 收成一个二级菜单（与「翻译对齐方式」同一种悬停展开方式，不把主菜单撑长）
      { label: '歌词工具', submenu: [
        // 多源候选面板：自动匹配够不着时手动找（冷门曲 / 翻唱 / 多版本）
        { label: '搜索歌词…', action: function() { CM.openLyricSearch(); } },
        { label: '复制歌词', disabled: !CM.currentLyrics.length, action: function() { CM.copyLyrics(); } },
        // v2 的 lyrics.save：写回文件 / 嵌入标签（原文照写，不重排不改字）
        { label: '嵌入到歌曲标签', disabled: !canSave, action: function() { CM.saveLyricsToFile(true); } },
        { label: '保存歌词到文件', disabled: !canSave, action: function() { CM.saveLyricsToFile(false); } }
      ] });
    if (pinned) {
      var pinSrc = CM.lyricSources.sourceById(pinned.src);
      items.push({ label: '恢复自动匹配',
        desc: '清除手动选择的歌词（' + (pinSrc ? pinSrc.label : pinned.src) +
              (pinned.title ? ' · ' + pinned.title : '') + '）',
        action: function() {
          CM.lyricSources.clearPick(pickKey);
          if (typeof CM.lyricReload === 'function') CM.lyricReload(); else CM.loadLyrics();
        } });
    }
    items.push(
      // 小窗（v2 的 window.createPopup）：两种形态收进二级菜单，与「翻译对齐方式」同一种展开方式
      { label: '小窗', submenu: [
        { label: '迷你播放器', action: function() { CM.openPopupWindow('mini'); } },
        { label: '歌词窗（竖版）', action: function() { CM.openPopupWindow('lyrics'); } }
      ] },
      { divider: true },
      { label: '打开所在文件夹', disabled: !canOpenFolder, action: function() { CM.api('shell.showInExplorer', { path: path }); } });
    CM.showCtxMenu(x, y, items);
  };

  // 复制歌词为纯文本（主行与副行各占一行），便于分享
  CM.copyLyrics = function() {
    var ls = CM.currentLyrics || [];
    if (!ls.length) return;
    var out = [], i, s;
    for (i = 0; i < ls.length; i++) {
      if (ls[i].text) out.push(ls[i].text);
      if (ls[i].subs) for (s = 0; s < ls[i].subs.length; s++) out.push(ls[i].subs[s]);
    }
    var txt = out.join('\n');
    function done() { CM.showToast('已复制歌词', ls.length + ' 行', 'success'); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { CM.showToast('复制失败', '', 'error'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(fallback);
    } else fallback();
  };

  /* ============================================
   * 歌词候选面板（多源搜索 / 预览 / 点选 / 按文件记忆）
   *
   * 自动匹配够不着时（冷门曲、翻唱、多版本）给用户一条手动通道：
   * 并行问所有启用的歌词源 → 归一化成同一形状（js/lyrics-sources.js）→
   * 按标题/艺人/时长打分排序 → 点一条预览 → 「使用」写入按文件记忆并立即渲染。
   *
   * 面板 DOM 现场创建（惰性）：只在真正打开时建，避免给不用的用户增加启动节点。
   * 与主歌词面板共用 CM.currentLyrics：选中的歌词直接走 CM._renderLyrics 渲染，
   * 不做第二套渲染路径。
   * ============================================ */
  var _lsEls = null;
  var _lsState = { open: false, results: [], sel: -1, previewHTML: '' };
  // 搜索代际：连续回车两次（先 A 后 B）时，若 A 较慢后到，不能让它把候选列表
  // 覆盖成 A 的结果（界面显示的会与输入框里的关键词不符，点「使用」还会记错）
  var _lsSeq = 0;

  function lyrSearchEls() {
    if (_lsEls) return _lsEls;
    var mask = document.createElement('div');
    mask.className = 'lyr-search-mask';
    mask.innerHTML =
      '<div class="lyr-search-panel">' +
        '<div class="lyr-search-head">' +
          '<div class="lyr-search-title">搜索歌词</div>' +
          '<span class="lyr-search-hint"></span>' +
          '<button class="lyr-search-x" title="关闭">✕</button>' +
        '</div>' +
        '<div class="lyr-search-bar">' +
          '<input type="text" class="lyr-search-in" spellcheck="false" placeholder="歌名 / 歌手，回车搜索" />' +
          '<button class="lyr-search-go">搜索</button>' +
        '</div>' +
        '<div class="lyr-search-srcs"></div>' +
        '<div class="lyr-search-status"></div>' +
        '<div class="lyr-search-list"></div>' +
      '</div>';
    document.body.appendChild(mask);
    _lsEls = {
      mask: mask,
      hint: mask.querySelector('.lyr-search-hint'),
      x: mask.querySelector('.lyr-search-x'),
      input: mask.querySelector('.lyr-search-in'),
      go: mask.querySelector('.lyr-search-go'),
      srcs: mask.querySelector('.lyr-search-srcs'),
      status: mask.querySelector('.lyr-search-status'),
      list: mask.querySelector('.lyr-search-list')
    };
    _lsEls.x.addEventListener('click', function() { CM.closeLyricSearch(); });
    _lsEls.go.addEventListener('click', function() { runSearch(); });
    _lsEls.input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') runSearch();
      else if (e.key === 'Escape') CM.closeLyricSearch();
    });
    // 点遮罩空白处关闭（点在面板内不关）
    _lsEls.mask.addEventListener('mousedown', function(e) {
      if (e.target === mask) CM.closeLyricSearch();
    });
    // 源开关：点一下就启停该源，并立刻重搜（设置落 CM.settings.lyricSources）
    _lsEls.srcs.addEventListener('click', function(e) {
      var chip = e.target.closest('.lyr-src-chip');
      if (!chip) return;
      var m = CM.lyricSources.enabledMap();
      m[chip.dataset.src] = m[chip.dataset.src] === false;
      CM.saveSettings();
      renderChips();
      if (_lsEls.input.value.trim()) runSearch();
    });
    _lsEls.list.addEventListener('click', function(e) {
      if (e.target.closest('.lyr-cand-apply')) { applyPick(); return; }
      var row = e.target.closest('.lyr-cand');
      if (row) selectCandidate(+row.dataset.i);
    });
    return _lsEls;
  }

  function renderChips() {
    var m = CM.lyricSources.enabledMap();
    var srcs = CM.lyricSources.sources, html = '';
    for (var i = 0; i < srcs.length; i++) {
      html += '<span class="lyr-src-chip' + (m[srcs[i].id] !== false ? ' on' : '') +
        '" data-src="' + esc(srcs[i].id) + '" title="点击启用 / 停用该歌词源">' +
        esc(srcs[i].label) + '</span>';
    }
    lyrSearchEls().srcs.innerHTML = html;
  }

  function candRowHTML(c, i, sel) {
    var badges = '';
    if (c.synced) badges += '<span class="lyr-cand-badge sync">同步</span>';
    if (c.words) badges += '<span class="lyr-cand-badge words">逐字</span>';
    if (c.plain && !c.synced) badges += '<span class="lyr-cand-badge plain">纯文本</span>';
    var sub = [c.artist, c.album].filter(Boolean).join(' · ') || '—';
    return '<div class="lyr-cand' + (sel ? ' sel' : '') + '" data-i="' + i + '">' +
      '<span class="lyr-cand-src ' + esc(c.src) + '">' + esc(c.label || c.src) + '</span>' +
      '<div class="lyr-cand-main">' +
        '<div class="lyr-cand-title">' + esc(c.title || '(无标题)') + '</div>' +
        '<div class="lyr-cand-sub">' + esc(sub) + '</div>' +
      '</div>' +
      '<div class="lyr-cand-badges">' + badges + '</div>' +
      '<span class="lyr-cand-dur">' + (c.duration ? CM.formatTime(c.duration) : '') + '</span>' +
    '</div>';
  }

  function renderCands() {
    var el = lyrSearchEls(), st = _lsState;
    if (!st.results.length) {
      el.list.innerHTML = '<div class="lyr-cand-empty">' + esc(st.emptyText || '没有搜索到候选歌词') + '</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < st.results.length; i++) {
      html += candRowHTML(st.results[i], i, i === st.sel);
      if (i === st.sel && st.previewHTML) {
        html += '<div class="lyr-cand-preview">' + st.previewHTML +
          '<div class="pv-actions"><button class="lyr-cand-apply">使用这份歌词</button></div></div>';
      }
    }
    el.list.innerHTML = html;
  }

  // 预览只截前 60 行：够看清语种 / 是否带时间轴，又不至于把长歌词整段塞进 DOM
  function previewHTML(text) {
    var head = String(text).split('\n').slice(0, 60).join('\n');
    return esc(head);
  }

  function runSearch() {
    var el = lyrSearchEls(), st = _lsState;
    var kw = el.input.value.trim();
    if (!kw) return;
    var seq = ++_lsSeq;
    st.results = []; st.sel = -1; st.previewHTML = ''; st.emptyText = '';
    el.status.classList.remove('err');
    el.status.textContent = '正在搜索…';
    el.list.innerHTML = '<div class="lyr-cand-empty">搜索中…</div>';
    // 手动搜索不传时长：用户可能在找另一版本，时长吻合加成会误伤排序
    var meta = { title: kw, artist: '', album: '', duration: 0, path: '' };
    CM.lyricSources.searchAll(meta).then(function(res) {
      if (!st.open || seq !== _lsSeq) return;
      var ranked = CM.lyricSources.rank(res.candidates, meta);
      st.results = ranked.map(function(r) { return r.cand; });
      if (!st.results.length) {
        st.emptyText = res.anyOk ? '没有搜索到候选歌词' : '所有歌词源都没能应答，稍后重试';
        if (!res.anyOk) el.status.classList.add('err');
      }
      el.status.textContent = st.results.length
        ? ('共 ' + st.results.length + ' 条' +
           (res.errors.length ? '，' + res.errors.length + ' 个源失败' : ''))
        : '';
      renderCands();
    }, function(e) {
      if (!st.open || seq !== _lsSeq) return;
      st.emptyText = '搜索失败：' + ((e && e.message) || '未知错误');
      el.status.textContent = st.emptyText;
      el.status.classList.add('err');
      renderCands();
    });
  }

  function selectCandidate(i) {
    var el = lyrSearchEls(), st = _lsState;
    var c = st.results[i];
    if (!c) return;
    st.sel = i; st.previewHTML = '';
    renderCands();                    // 先高亮选中行
    el.status.classList.remove('err');
    el.status.textContent = '正在取词…';
    CM.lyricSources.fetch(c).then(function(text) {
      if (!st.open || st.sel !== i) return;
      el.status.textContent = '';
      st.previewHTML = previewHTML(text);
      renderCands();
    }, function(e) {
      if (!st.open || st.sel !== i) return;
      st.previewHTML = '';
      el.status.textContent = '取词失败：' + ((e && e.message) || '未知错误');
      el.status.classList.add('err');
      renderCands();
    });
  }

  function applyPick() {
    var st = _lsState;
    var c = st.results[st.sel];
    if (!c) return;
    // 按文件记忆（CM.settings.lyricPicks）：下次播这首歌直接命中，不再走自动匹配
    var path = CM.currentTrack && CM.trackPath ? CM.trackPath(CM.currentTrack) : '';
    var loadId = CM._lyricLoadId;
    CM.lyricSources.fetch(c).then(function(text) {
      if (!text) {
        if (loadId === CM._lyricLoadId) CM.showToast('取词失败', '换一条候选试试', 'error');
        return;
      }
      // 落盘放在"真取到词"之后：取词失败也记下来的话，这首歌以后每次播放都会先走
      // 这条必然失败的记忆，再静默回落自动匹配 —— 用户看不到上次那条其实失败了
      CM.lyricSources.setPick(path, c);
      // 取词是异步的：期间切了歌就别把这首歌的歌词渲染到新曲目上
      if (loadId !== CM._lyricLoadId) return;
      CM._renderLyrics({ available: true, source: 'picked', sourcePath: '' }, text);
      CM.closeLyricSearch();
      CM.showToast('已应用歌词', (c.label || c.src) + ' · ' + (c.title || ''), 'success');
    }, function(e) {
      if (loadId !== CM._lyricLoadId) return;
      CM.showToast('取词失败', (e && e.message) || '', 'error');
    });
  }

  CM.openLyricSearch = function(prefill) {
    if (!CM.lyricSources) { CM.showToast('歌词源未加载', '多源模块不可用', 'error'); return; }
    var el = lyrSearchEls();
    var meta = CM.lyricSources.metaFor();
    el.input.value = prefill ||
      ((meta.title || '') + (meta.artist ? ' ' + meta.artist : '')).trim();
    el.hint.textContent = meta.title ? ('当前：' + meta.title) : '';
    renderChips();
    el.mask.classList.add('open');
    _lsState.open = true;
    setTimeout(function() { el.input.focus(); el.input.select(); }, 60);
    if (el.input.value) runSearch();
    else { el.list.innerHTML = '<div class="lyr-cand-empty">输入关键词后回车搜索</div>'; }
  };

  CM.closeLyricSearch = function() {
    if (!_lsEls) return;
    _lsEls.mask.classList.remove('open');
    _lsState.open = false;
  };

  CM.runOnce('lyricPanelMenu', function() {
    var bind = function(el) {
      if (!el) return;
      el.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        CM.showLyricMenu(e.clientX, e.clientY);
      });
    };
    bind(els.rightPanel);   // 右侧歌词面板
    bind(els.npLyrics);     // 沉浸式页面的歌词区
  });
})();
