/* ============================================
 * CloudMusic ui-nowplaying.js — 沉浸式 NowPlaying
 * 唱片/纯歌词双模式 / 波形进度条背景 / 频谱 / 编码信息栏
 * ============================================ */

(function() {
  'use strict';
  var CM = window.CloudMusic;
  var els = CM.els, state = CM.state, esc = CM.escHtml;
  var DEFAULT_TRACK_COVER = CM.DEFAULT_TRACK_COVER;

  /* ============================================
   * 沉浸式 NowPlaying
   * ============================================ */
  // 进入沉浸页前的歌词面板可见状态：退出时据此恢复 —— 不能看到"本来就关着
  // 面板"的用户在退出沉浸页时被强制打开（setLyricsVisible 会持久化设置）
  var _npPrevLyricsVisible = false;
  CM.toggleNpOverlay = function(open) {
    state.npOpen = open !== undefined ? open : !state.npOpen;
    // body 上的 np-open 供 CSS 压掉盖在沉浸页之上的"页面级"浮层（批量操作栏
    // 是 body 子元素、z-index 1500，比 .np-overlay 的 200 高，不压会浮在沉浸页上）
    document.body.classList.toggle('np-open', state.npOpen);
    if (state.npOpen) {
      CM.renderNpOverlay();
      els.npOverlay.classList.add('open');
      // 沉浸页注册自己的频谱帧消费方：底栏那条频谱关掉时这条照样动
      // （调度器按持有者计数，最后一个消费方离开才真正退订）
      if (CM.sched) CM.sched.want('np', { fps: 30, onFrame: CM.updateNpSpectrum });
      syncWave();
      document.body.style.overflow = 'hidden';
      // 关闭歌词面板节省资源
      _npPrevLyricsVisible = state.lyricsVisible;
      if (state.lyricsVisible) CM.setLyricsVisible(false, true);
    } else {
      els.npOverlay.classList.remove('open');
      if (CM.npFlowToggle) CM.npFlowToggle(false);   // 退出沉浸页顺带关掉专辑河流
      if (CM.sched) CM.sched.release('np');
      stopWave();
      document.body.style.overflow = '';
      // 退出沉浸页：停掉瀑布/示波器/矢量示波器的画布轮询与实时波形轮询（都不该在后台常驻）
      if (CM.spectrumMode && CM.spectrumMode.suspend) CM.spectrumMode.suspend();
      // 恢复歌词面板（仅当进入前它是可见的）
      if (_npPrevLyricsVisible) CM.setLyricsVisible(true, true);
      _npPrevLyricsVisible = false;
    }
  };

  CM.renderNpOverlay = function() {
    // 同步封面（getAttribute 判断：未设置 src 时 .src 返回页面基址 URL，恒为 truthy）
    var artUrl = els.bottomArt.getAttribute('src');
    if (artUrl) {
      els.npArtwork.src = artUrl;
      els.npBgBlur.style.backgroundImage = 'url("' + artUrl + '")';
    } else {
      els.npArtwork.src = DEFAULT_TRACK_COVER;
      els.npBgBlur.style.backgroundImage = 'url("' + DEFAULT_TRACK_COVER + '")';
    }
    // 同步曲目信息
    els.npTrackTitle.textContent = els.bottomTitle.textContent;
    els.npTrackArtist.textContent = els.bottomArtist.textContent;
    CM.updateNpFormat();
    CM.loadNpWaveform(CM.trackPath(CM.currentTrack));
    // 同步播放按钮状态。播放态统一读 CM.state.playing（app.js 的 setPlayingVisual
    // 维护）：SDK 那份 fb.state 镜像只由 stateChanged/trackChanged/stopped 更新，
    // 走 playback:paused 恢复时不跟着变 —— 会出现"在播但按钮/唱片显示暂停"
    var playing = !!CM.state.playing;
    els.npBtnPlay.classList.toggle('playing', playing);
    els.npLcPlay.classList.toggle('playing', playing);
    // 同步进度条
    CM.updateNpSeekUI();
    // 渲染歌词
    CM.renderNpLyrics();
    // 初始化频谱
    CM.initNpSpectrum();
    // 恢复上次选中的频谱显示（频谱条 / 声场 / 瀑布图 / 示波器 / 矢量示波器），并同步画布尺寸
    if (CM.spectrumMode) { CM.spectrumMode.set(CM.settings.spectrumMode || 'bars'); CM.spectrumMode.refresh(); }
    // 更新唱片动画
    CM.updateNpVinylState();
    // 设置初始模式
    els.npOverlay.classList.toggle('lyrics-only', state.npMode === 'lyrics');
    CM.updateNpModeIcon();
    CM.applyNpTilt();   // 同步 3D 倾斜开关的类与按钮状态（设置可能来自上次会话）
  };

  // 曲目编码信息栏（编码 · 比特率 · 采样率 · 声道）
  CM.updateNpFormat = function() {
    var el = els.npTrackFormat; if (!el) return;
    CM.api('audio.getStreamInfo').then(function(s) {
      if (!s || !s.codec) { el.textContent = ''; return; }
      var parts = [s.codec];
      if (s.bitrate) parts.push(Math.round(s.bitrate) + ' kbps');
      if (s.sampleRate) parts.push((s.sampleRate / 1000).toFixed(1) + ' kHz');
      if (s.channels) parts.push(s.channels === 1 ? '单声道' : s.channels === 2 ? '立体声' : s.channels + ' 声道');
      el.textContent = parts.join(' · ');
    });
  };

  // 沉浸式波形：把当前曲目完整波形作为进度条背景
  // 缓存上限：每首一份 256 点的 SVG 字符串，不设上限的话长会话会一直涨
  var WAVE_CACHE_MAX = 40;
  var _waveCache = {}, _waveCacheKeys = [], _wavePending = null, _waveBound = false;
  function putWaveCache(path, svg) {
    if (!path) return;
    if (_waveCache[path] === undefined) {
      _waveCacheKeys.push(path);
      if (_waveCacheKeys.length > WAVE_CACHE_MAX) delete _waveCache[_waveCacheKeys.shift()];
    }
    _waveCache[path] = svg;
  }
  CM.waveformSVG = function(data, w, h) {
    var n = data.length, step = w / n, mid = h / 2, amp = (h - 6) / 2;
    var d = 'M0 ' + mid.toFixed(1);
    for (var i = 0; i < n; i++) {
      var v = data[i]; if (v < 0) v = -v; if (v > 1) v = 1;
      d += ' L' + (i * step).toFixed(1) + ' ' + (mid - v * amp).toFixed(1);
    }
    d += ' L' + w + ' ' + mid.toFixed(1) + ' Z';
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="' + d + '" fill="var(--accent)" opacity="0.55"/></svg>';
  };
  CM.loadNpWaveform = function(path) {
    var el = els.npWaveform; if (!el) return;
    // 两个早退分支都必须清掉在途请求：留着的话，旧曲目迟到的 ready/failed 回包
    // 会走到"路径对不上"分支，把当前正在显示的波形条 hide 掉
    if (!path) { _wavePending = null; el.classList.add('hide'); return; }
    if (_waveCache[path]) {
      _wavePending = null;
      el.innerHTML = _waveCache[path]; el.classList.remove('hide'); return;
    }
    if (!_waveBound) {
      _waveBound = true;
      fb.on('audio:fullWaveformReady', function(e) {
        if (!e || !e.taskId || !_wavePending || e.taskId !== _wavePending.taskId) return;
        var reqPath = _wavePending.path;
        _wavePending = null;
        if (e.waveform && e.waveform.length) {
          // 波形属于"发起请求的那条曲目"：按请求路径缓存；仅当它仍是当前曲目时展示
          // （期间切歌且新请求尚未发出时，旧曲目波形不能缓存到新曲目名下）
          if (reqPath) putWaveCache(reqPath, CM.waveformSVG(e.waveform, 100, 44));
          var cur = CM.trackPath(CM.currentTrack);
          if (reqPath && cur === reqPath && _waveCache[reqPath]) {
            el.innerHTML = _waveCache[reqPath];
            el.classList.remove('hide');
          } else el.classList.add('hide');
        } else el.classList.add('hide');
      });
      fb.on('audio:fullWaveformFailed', function(e) {
        // 迟到的旧任务失败不能清掉新任务的 pending（否则新任务 ready 时被丢弃）；
        // 没有在途请求时（缓存命中 / 无路径早退）更不能把正在显示的波形藏掉
        if (!e || !_wavePending) return;
        if (e.taskId && e.taskId !== _wavePending.taskId) return;
        _wavePending = null; el.classList.add('hide');
      });
    }
    // req 是本轮请求的身份：回执只在它仍是"最新一轮"时才允许写入 _wavePending。
    // 否则快速切歌时 A 的回执会把 A 的 taskId 写进 B 的 pending，A 的 ready 事件
    // 于是命中 B 的记录 —— A 的波形被缓存/显示到 B 名下（_waveCache 被污染）。
    var req = { taskId: null, path: path };
    _wavePending = req;
    CM.api('audio.generateFullWaveform', { path: path, resolution: 256, method: 'rms', preferCache: true }).then(function(r) {
      if (_wavePending !== req) return;                 // 期间又发起了新一轮请求，本轮作废
      if (r && r.taskId) { req.taskId = r.taskId; return; }
      if (r && r.waveform && r.waveform.length) {       // 命中宿主缓存，直接可用
        _wavePending = null;
        putWaveCache(path, CM.waveformSVG(r.waveform, 100, 44));
        if (CM.trackPath(CM.currentTrack) === path) {
          el.innerHTML = _waveCache[path]; el.classList.remove('hide');
        } else el.classList.add('hide');
      } else { _wavePending = null; el.classList.add('hide'); }
    });
  };

  CM.updateNpModeIcon = function() {
    var vinylIcon = els.npModeBtn.querySelector('.np-mode-vinyl');
    var lyricsIcon = els.npModeBtn.querySelector('.np-mode-lyrics');
    if (state.npMode === 'lyrics') {
      vinylIcon.style.display = 'none';
      lyricsIcon.style.display = 'inline';
      els.npModeBtn.title = '显示唱片';
    } else {
      vinylIcon.style.display = 'inline';
      lyricsIcon.style.display = 'none';
      els.npModeBtn.title = '纯歌词模式';
    }
  };

  /* 歌词 3D 倾斜（纯 CSS 效果，仅切换 #npOverlay 上的 tilt3d 类）
   * applyNpTilt 只同步界面，toggleNpTilt 额外落盘到 settings（与 visualizer 同一套持久化） */
  CM.applyNpTilt = function() {
    var on = !!CM.settings.tilt3d;
    if (els.npOverlay) els.npOverlay.classList.toggle('tilt3d', on);
    if (els.npTiltBtn) {
      els.npTiltBtn.classList.toggle('on', on);
      els.npTiltBtn.title = '歌词 3D 倾斜：' + (on ? '开' : '关');
    }
  };
  CM.toggleNpTilt = function() {
    CM.settings.tilt3d = !CM.settings.tilt3d;
    CM.saveSettings();
    CM.applyNpTilt();
  };

  CM.toggleNpMode = function() {
    state.npMode = state.npMode === 'vinyl' ? 'lyrics' : 'vinyl';
    els.npOverlay.classList.toggle('lyrics-only', state.npMode === 'lyrics');
    CM.updateNpModeIcon();
    // 切换模式后重新高亮歌词
    setTimeout(function() { CM.updateNpLyricHighlight(true); }, 400);
  };

  CM.updateNpVinylState = function() {
    var isPlaying = !!CM.state.playing;   // 同上：不用 SDK 的 fb.state 镜像
    els.npVinylDisc.classList.toggle('playing', !!isPlaying);
    els.npTonearm.classList.toggle('playing', !!isPlaying);
  };

  CM.renderNpLyrics = function() {
    var lines = CM.currentLyrics;
    if (!lines.length) {
      els.npLyrics.innerHTML = '<div class="lyrics-empty" style="padding:40px;text-align:center;color:var(--text-3)"><svg viewBox="0 0 24 24" style="width:40px;height:40px;margin:0 auto 12px;stroke:var(--text-4);fill:none"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><span>暂无歌词</span></div>';
      return;
    }
    els.npLyrics.innerHTML = CM._renderLyricHTML(lines, 'np-lyric-line', 30, 'np-lyric-wall');
    CM._npLyricNodesCache = null;
    CM._npWordCache = null;
    CM._bindLyricClicks(els.npLyrics, '.np-lyric-line');
    CM.updateNpLyricHighlight(true);
  };

  CM.updateNpLyricHighlight = function(force) {
    if (!state.npOpen) return;
    CM._updateLyricHighlight(els.npLyrics, '.np-lyric-line', 'npActiveLyricIndex', force, state.position + 0.25, '_npLyricNodesCache', '_npWordCache');
  };

  CM.updateNpSeekUI = function() {
    CM._updateSeekBar(els.npSeekBar, els.npTimeCurrent, els.npTimeTotal, '--np-seek-pct', 'npSeeking');
  };

  var NP_SPEC_BARS = 32;
  var npSpecBarEls = [];
  CM.initNpSpectrum = function() {
    npSpecBarEls = CM.createSpectrumBars(els.npSpectrum, NP_SPEC_BARS, 'np-spec-bar');
    // createSpectrumBars 是 innerHTML 重建：瀑布/示波器/矢量示波器那张画布会被一起清掉。
    // 画布是复用同一个元素的（不重建、不重设 bitmap），这里必须重新挂回去 ——
    // 否则第二次打开沉浸页时画的是一张已经脱离文档的画布，看起来就是"没反应"。
    if (specCanvas && specCanvas.parentNode !== els.npSpectrum) {
      els.npSpectrum.appendChild(specCanvas);
    }
  };

  /* ============================================
   * 沉浸页频谱的显示模式 —— 五种都画在主题自己那一条频谱的位置上
   *
   *   bars      频谱条（默认，就是主题原来的样子）
   *   field     声场：同一排 32 条，中缝左右分开（低频靠中缝，蝶形对称）
   *   waterfall 瀑布图：同一条 40px 槽位里的画布，时间 × 频率，配色取自封面强调色
   *   oscillo   示波器：同槽位画布 + 宿主可视化流的实时 PCM（audio.getWaveform）
   *   vector    矢量示波器：同一份 PCM 的左右声道当 (L,R) 坐标打点（相位图）
   *
   * 尺寸与位置完全不变（画布就叠在频谱条的槽位里），所以不会挤动布局；
   * 切换方式是"点这一条频谱"——不新增任何按钮或元件。选择记进设置。
   * ============================================ */
  var SPEC_MODES = ['bars', 'field', 'waterfall', 'oscillo', 'vector'];
  var SPEC_LABEL = {
    bars: '频谱条', field: '声场', waterfall: '瀑布图',
    oscillo: '示波器（实时波形）', vector: '矢量示波器（相位图）'
  };
  var specMode = 'bars';
  var specCanvas = null, specCtx = null, specBitmap = { w: 0, h: 0, dpr: 1 }, specRO = null;

  // 实时波形类模式（示波器 / 矢量示波器）都靠 audio.getWaveform 供数，且都依赖可视化流
  function needsWave(mode) { return mode === 'oscillo' || mode === 'vector'; }
  // 画布类模式：频谱条让位给叠在槽位里的画布
  function isCanvasMode(mode) { return mode === 'waterfall' || needsWave(mode); }
  function canUseSpecMode(mode) {
    return !needsWave(mode) || waveAvailable();
  }

  function ensureSpecCanvas() {
    if (specCanvas) {
      // 被 innerHTML 重建甩出文档时挂回来（见 initNpSpectrum 的说明）
      if (els.npSpectrum && specCanvas.parentNode !== els.npSpectrum) {
        els.npSpectrum.appendChild(specCanvas);
      }
      return specCanvas;
    }
    var box = els.npSpectrum;
    if (!box) return null;
    specCanvas = document.createElement('canvas');
    specCanvas.className = 'np-spec-canvas';
    box.appendChild(specCanvas);
    return specCanvas;
  }

  // 布局变化（开窗、改窗口大小、DPI 变化）后重新量画布：画布是替换元素，
  // 位图尺寸必须跟着 CSS 尺寸走，否则要么糊、要么只画到一角。
  // 重量的同时按当前模式补一张：瀑布图不能因为一次窗口缩放就从右边重新长起。
  var specSizeWatched = false;
  function watchSpecSize() {
    if (!specSizeWatched) {
      specSizeWatched = true;
      // DPI 变化（换显示器 / 改缩放）不会触发 ResizeObserver（CSS 尺寸没变），
      // 但位图要换：清掉缓存尺寸，下一帧按新 DPR 重量
      if (CM.onDpiChange) CM.onDpiChange(function() {
        specBitmap = { w: 0, h: 0, dpr: specBitmap.dpr || 1 };
        if (specCtx) clearSpecCanvas(true);
        if (specMode === 'waterfall') prefillSpecWaterfall(CM.viz && CM.viz.frame);
      });
    }
    if (specRO || typeof ResizeObserver !== 'function') return;
    var box = els.npSpectrum;
    if (!box) return;
    specRO = new ResizeObserver(function() {
      if (!specCanvas || specCanvas.classList.contains('hide')) return;
      if (!sizeSpecCanvas(true)) return;
      clearSpecCanvas(true);
      if (specMode === 'waterfall') prefillSpecWaterfall(CM.viz && CM.viz.frame);
    });
    specRO.observe(box);
  }

  // force = true 时才真的量一次（首次 / 开沉浸页 / 切模式 / 布局或 DPI 变化）；
  // 画布模式的绘制是 30fps，每帧 getBoundingClientRect() 是白花钱，其余帧用缓存尺寸。
  function sizeSpecCanvas(force) {
    var c = ensureSpecCanvas();
    if (!c) return false;
    if (!force && specBitmap.w > 0 && specBitmap.h > 0) return true;
    var r = c.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    // 缩放比统一走 CM.dpr()（与主窗口/小窗同一口径）；画布位图上限 2x，避免 4K 下过度绘制
    var dpr = Math.min(CM.dpr ? CM.dpr() : (window.devicePixelRatio || 1), 2);
    if (specBitmap.w === w && specBitmap.h === h && specBitmap.dpr === dpr) return true;
    specBitmap = { w: w, h: h, dpr: dpr };
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    specCtx = c.getContext('2d');
    return true;
  }

  function clearSpecCanvas(soft) {
    if (!specCtx || !specCanvas) return;
    specCtx.setTransform(1, 0, 0, 1, 0, 0);
    specCtx.clearRect(0, 0, specCanvas.width, specCanvas.height);
    if (soft) {
      specCtx.fillStyle = 'rgba(0,0,0,0.28)';
      specCtx.fillRect(0, 0, specCanvas.width, specCanvas.height);
    }
  }

  // 画布配色跟随主题的封面取色。色相由 core.js 在写 --accent-h 时同步到
  // CM._accentHue：画布类模式是 30fps，每帧 getComputedStyle() 会强制样式重算。
  function specHue() {
    var h = (typeof CM._accentHue === 'number' && isFinite(CM._accentHue)) ? CM._accentHue : 0;
    return ((h % 360) + 360) % 360;
  }
  var _specLut = null, _specLutHue = -1;
  function specLut() {
    var hue = specHue();
    if (_specLut && _specLutHue === hue) return _specLut;
    var out = new Array(64);
    for (var i = 0; i < 64; i++) {
      var v = i / 63;
      // 低强度：偏暗偏灰；高强度：亮到接近强调色本体（与主题那条频谱的观感一致）
      out[i] = 'hsl(' + hue + ',' + (66 + v * 26).toFixed(0) + '%,' + (12 + v * 52).toFixed(0) + '%)';
    }
    _specLut = out; _specLutHue = hue;
    return out;
  }

  // 画布上的提示文字（等数据 / 不可用时的唯一反馈 —— 那块地方本来什么都没有）
  function specHint(text) {
    if (!specCtx || !specCanvas) return;
    var dpr = specBitmap.dpr || 1;
    specCtx.fillStyle = 'rgba(255,255,255,0.42)';
    specCtx.font = (10 * dpr) + 'px "Segoe UI","Microsoft YaHei UI",sans-serif';
    specCtx.textAlign = 'center';
    specCtx.fillText(text, specCanvas.width / 2, specCanvas.height / 2 + 3.5 * dpr);
  }

  // 瀑布图是"从右往左一条条推出去"的：刚切进来（或刚重建画布）时左边一大片
  // 还是空的，看着像没生效。这里用当前这一帧把整幅填满，之后照常向左滚动。
  function prefillSpecWaterfall(frame) {
    if (!frame || !CM.viz || !sizeSpecCanvas()) return;
    var bars = CM.viz.barsFor(frame, 96);
    var c = specCanvas, ctx = specCtx, W = c.width, H = c.height, lut = specLut();
    var n = bars.length;
    if (!n) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, 0, W, H);
    for (var y = 0; y < H; y++) {
      var f = (H - 1 - y) / H;
      var idx = Math.floor(f * n);
      if (idx < 0) idx = 0; else if (idx >= n) idx = n - 1;
      var v = bars[idx] || 0;
      if (v < 0.04) continue;
      ctx.fillStyle = lut[Math.round(v * 63)];
      ctx.fillRect(0, y, W, 1);
    }
  }

  function drawSpecWaterfall(frame) {
    if (!sizeSpecCanvas()) return;
    var c = specCanvas, ctx = specCtx;
    var shift = Math.max(1, Math.round(specBitmap.dpr));   // 每帧向左滚动 1 设备像素
    var W = c.width, H = c.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(c, -shift, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    if (!frame || !CM.viz) { specHint('等待音频数据…'); return; }
    var bars = CM.viz.barsFor(frame, 96);
    var lut = specLut();
    var n = bars.length;
    for (var y = 0; y < H; y++) {
      // 纵向：底=低频。条数组本身已按对数频率轴排列，这里线性取值即对数纵轴
      var f = (H - 1 - y) / H;
      var idx = Math.floor(f * n);
      if (idx < 0) idx = 0; else if (idx >= n) idx = n - 1;
      var v = bars[idx] || 0;
      if (v < 0.04) continue;                       // 近静音不画，保留底色
      ctx.fillStyle = lut[Math.round(v * 63)];
      ctx.fillRect(W - shift, y, shift, 1);
    }
  }

  /* ---------- 实时波形（示波器 / 矢量示波器） ----------
     v2 官方给可视化流留了 audio.getWaveform：最近 duration 秒的 PCM，
     signed 直接给 [-1, 1] 的正负波形。旧实现走 fb.audio.subscribeStream
     （实验性的共享缓冲接口）：宿主没给共享缓冲时既没有帧也没有错误，画布上
     永远只有"等待音频数据…"。这里改成官方接口。
     拉取不再自己起 rAF —— 交给 CM.sched.wantWave：它统一单飞（上一次没回来
     不发下一次）、未播放即停、页面隐藏即停，多个视图也只发一份请求。
     这里只管"拿到数据后画一帧"。频谱订阅同时是可视化流的保活，沉浸页开着
     时它一直持有（见 toggleNpOverlay 里的 sched.want('np')）。 */
  var wave = { buf: null, lr: null, fails: 0, ok: false };

  function waveAvailable() {
    return !!(fb.audio && typeof fb.audio.getWaveform === 'function');
  }

  function onWaveData(r) {
    var stereo = specMode === 'vector';
    if (r && r.success !== false) {
      if (stereo) {
        if (r.left && r.right && r.left.length) {
          wave.lr = { left: r.left, right: r.right };
          wave.ok = true;
          wave.fails = 0;
        }
      } else if (r.waveform && r.waveform.length) {
        wave.buf = r.waveform;
        wave.ok = true;
        wave.fails = 0;
      }
      // success 但没数据（起播头几十毫秒 / 静音）：不算失败，等下一拍
    } else {
      wave.fails++;
      // 连续拿不到（宿主没有可视化流 / 一直在停止态之外的地方失败）就不要再
      // 停在一块空画布上：说明原因并切回频谱条（示波器与矢量示波器共用这条兜底）
      if (wave.fails >= 8 && needsWave(specMode)) {
        var was = SPEC_LABEL[specMode];
        applySpecMode('bars');
        if (CM.showToast) CM.showToast(was + '不可用', '宿主暂时给不出实时波形，已切回频谱条', 'error');
        return;
      }
    }
    if (!state.npOpen || !needsWave(specMode)) return;
    if (specMode === 'vector') drawSpecVector(); else drawSpecOscillo();
  }

  // 波形消费方只在"沉浸页开着 + 当前是波形类模式 + 宿主有该接口"时注册；
  // 其余情况一律退订，避免后台白拉
  function syncWave() {
    if (state.npOpen && needsWave(specMode) && waveAvailable() && CM.sched) {
      CM.sched.wantWave('np', {
        fps: 30,
        channels: specMode === 'vector' ? 'stereo' : 'mix',
        points: specMode === 'vector' ? 512 : 600,
        onWave: onWaveData
      });
    } else {
      stopWave();
    }
  }

  function stopWave() {
    if (CM.sched) CM.sched.releaseWave('np');
    wave.buf = null;
    wave.lr = null;
    wave.fails = 0;
    wave.ok = false;
  }

  function drawSpecOscillo() {
    if (!sizeSpecCanvas()) return;
    var c = specCanvas, ctx = specCtx;
    var W = c.width, H = c.height, dpr = specBitmap.dpr, mid = H / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 轻微拖尾（0.72 覆盖）比整幅清屏更像示波器，也让快扫的线不至于抖
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, W, H);
    // 中线
    ctx.strokeStyle = 'hsla(' + specHue() + ',60%,60%,0.22)';
    ctx.lineWidth = Math.max(1, Math.round(dpr * 0.5));
    ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(W, mid + 0.5); ctx.stroke();
    var buf = wave.buf;
    if (!buf || buf.length < 2) {
      if (!wave.ok) specHint('等待音频数据…');
      return;
    }
    ctx.strokeStyle = 'hsl(' + specHue() + ',88%,62%)';
    ctx.shadowColor = 'hsla(' + specHue() + ',88%,60%,0.8)';
    ctx.shadowBlur = 6 * dpr;
    ctx.lineWidth = Math.max(1, 1.4 * dpr);
    ctx.beginPath();
    for (var i = 0; i < buf.length; i++) {
      var x = (i / (buf.length - 1)) * W;
      var val = buf[i];
      if (val > 1) val = 1; else if (val < -1) val = -1;
      var y = mid - val * (mid * 0.86);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /* 矢量示波器（Lissajous / 相位图）：把左右声道的时域样本当 (L, R) 坐标打点。
     与"声场"互补 —— 声场看的是频谱左右声道，这里看的是相位关系：
     全相关（单声道）的点全落在主对角线上，反相落在副对角线上，声像偏移则整团偏向一侧。
     槽位是"宽而矮"的一条（40px），按等比例画会把九成宽度浪费掉，
     故 X/Y 各自按半宽/半高铺满；单声道的主对角线仍是直线，方向判读不受影响。 */
  function drawSpecVector() {
    if (!sizeSpecCanvas()) return;
    var c = specCanvas, ctx = specCtx;
    var W = c.width, H = c.height, dpr = specBitmap.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 轻拖尾：靠余晖把散点连成轨迹，快速扫过时更像示波器
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fillRect(0, 0, W, H);
    var hue = specHue();
    var pad = 3 * dpr;
    var cx = W / 2, cy = H / 2;
    var rx = Math.max(1, W / 2 - pad), ry = Math.max(1, H / 2 - pad);
    // 参考框：外椭圆 + 主对角线（单声道信号所在的那条线）
    ctx.strokeStyle = 'hsla(' + hue + ',50%,58%,0.20)';
    ctx.lineWidth = Math.max(1, Math.round(dpr * 0.5));
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - rx * 0.7071, cy + ry * 0.7071);
    ctx.lineTo(cx + rx * 0.7071, cy - ry * 0.7071);
    ctx.stroke();
    var lr = wave.lr;
    if (!lr || !lr.left || !lr.right || lr.left.length < 2) {
      if (!wave.ok) specHint('等待音频数据…');
      return;
    }
    var L = lr.left, R = lr.right, n = Math.min(L.length, R.length);
    // 一条路径画完所有点（moveTo+lineTo 成对、圆头端点 => 圆点），
    // 再同路径描两遍当辉光；比逐点 arc+fill / shadowBlur 省下几百次绘制调用
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var l = L[i], r = R[i];
      if (l > 1) l = 1; else if (l < -1) l = -1;
      if (r > 1) r = 1; else if (r < -1) r = -1;
      // Lissajous 旋转 45°：X 走 L-R（左右声像），Y 走 L+R（同相在正上方）
      var x = cx + (l - r) * 0.7071 * rx;
      var y = cy - (l + r) * 0.7071 * ry;
      ctx.moveTo(x, y);
      ctx.lineTo(x, y);   // 零长线段 + 圆头端点 = 一个圆点
    }
    ctx.strokeStyle = 'hsla(' + hue + ',90%,60%,0.20)';
    ctx.lineWidth = Math.max(2, 4 * dpr);
    ctx.stroke();
    ctx.strokeStyle = 'hsla(' + hue + ',92%,70%,0.95)';
    ctx.lineWidth = Math.max(1, 1.4 * dpr);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  // 声场：还是这 32 条，中缝左右分别走右/左声道（低频靠中缝，蝶形对称）
  function drawSpecField(frame) {
    if (!npSpecBarEls.length) return;
    var half = npSpecBarEls.length >> 1;
    if (!half) return;
    var L = CM.viz.barsFor(frame, half, 'left');
    var R = CM.viz.barsFor(frame, half, 'right');
    var vals = new Array(npSpecBarEls.length);
    for (var i = 0; i < half; i++) {
      vals[half - 1 - i] = L[i];   // 左半：从中心往左，低频在中心
      vals[half + i] = R[i];       // 右半：从中心往右，低频在中心
    }
    CM.updateSpectrumBars(npSpecBarEls, vals, vals.length, 36, 28);
  }

  /* ---------- 模式切换 ---------- */
  function specModeTip() {
    return '点击切换频谱显示：频谱条 / 声场 / 瀑布图 / 示波器 / 矢量示波器（当前：' + SPEC_LABEL[specMode] + '）';
  }
  function applySpecMode(mode, silent) {
    if (!SPEC_LABEL[mode] || !canUseSpecMode(mode)) mode = 'bars';
    specMode = mode;
    // 只在档位真的变了才落盘：renderNpOverlay 每次打开沉浸页都会 set() 同一个值，
    // 无条件 saveSettings 等于每次开窗写一遍 localStorage
    if (CM.settings.spectrumMode !== mode) {
      CM.settings.spectrumMode = mode;
      if (typeof CM.saveSettings === 'function') CM.saveSettings();
    }
    var box = els.npSpectrum;
    if (box) {
      box.classList.toggle('field', mode === 'field');
      box.classList.toggle('mode-canvas', isCanvasMode(mode));
      box.title = specModeTip();
    }
    // 右上角那个按钮：显示当前模式；非"频谱条"时点亮，一眼能看出正处在别的显示上
    if (els.npVizBtn) {
      els.npVizBtn.title = '频谱显示：' + SPEC_LABEL[specMode] + '（点击切换）';
      els.npVizBtn.classList.toggle('non-bars', mode !== 'bars');
    }
    if (isCanvasMode(mode)) {
      var c = ensureSpecCanvas();
      if (c) c.classList.remove('hide');
      watchSpecSize();
      if (sizeSpecCanvas(true)) clearSpecCanvas(true);
    } else if (specCanvas) {
      specCanvas.classList.add('hide');
    }
    // 换波形类模式时清掉上一模式的缓冲（mix 与 stereo 的数据形状不同，不能混用），
    // 再按"是否开着沉浸页"决定注册/退订波形消费方
    if (needsWave(mode)) { wave.buf = null; wave.lr = null; wave.ok = false; wave.fails = 0; }
    syncWave();
    if ((mode === 'bars' || mode === 'field') && CM.viz && CM.viz.frame) {
      CM.updateNpSpectrum(CM.viz.frame);   // 切回来立刻画一帧，不留空白
    } else if (mode === 'waterfall') {
      prefillSpecWaterfall(CM.viz && CM.viz.frame);   // 整幅填满，不留半张黑
    }
    if (!silent && CM.showToast) {
      CM.showToast('频谱显示：' + SPEC_LABEL[mode], '点击频谱可继续切换', null);
    }
  }

  CM.spectrumMode = {
    cycle: function() {
      var i = SPEC_MODES.indexOf(specMode);
      for (var k = 1; k <= SPEC_MODES.length; k++) {
        var m = SPEC_MODES[(i + k) % SPEC_MODES.length];
        if (canUseSpecMode(m)) { applySpecMode(m); return; }
      }
    },
    set: function(m) { applySpecMode(m, true); },
    current: function() { return specMode; },
    // 布局变化（打开沉浸页 / 窗口缩放）后重新量一次画布
    refresh: function() {
      if (els.npSpectrum) els.npSpectrum.title = specModeTip();
      if (isCanvasMode(specMode)) {
        if (ensureSpecCanvas()) specCanvas.classList.remove('hide');
        watchSpecSize();
        if (sizeSpecCanvas(true)) clearSpecCanvas(true);
        if (specMode === 'waterfall') prefillSpecWaterfall(CM.viz && CM.viz.frame);
      }
    },
    // 关闭沉浸页 / 关掉可视化：停掉实时波形与画布轮询，画布回到空态
    suspend: function() {
      stopWave();
      if (isCanvasMode(specMode)) clearSpecCanvas(true);
    }
  };

  CM.updateNpSpectrum = function(frame) {
    if (!state.npOpen || !CM.viz) return;
    if (specMode === 'bars') {
      if (!npSpecBarEls.length) return;
      // 频点按对数轴合并成这条频谱的确切条数（每条取频段内最大值）
      CM.updateSpectrumBars(npSpecBarEls, CM.viz.barsFor(frame, NP_SPEC_BARS), NP_SPEC_BARS, 36, 28);
    } else if (specMode === 'field') {
      drawSpecField(frame);
    } else if (specMode === 'waterfall') {
      drawSpecWaterfall(frame);
    }
    // oscillo / vector：由 CM.sched 拉取波形后回调 onWaveData 自绘
  };

  CM.showSpectrumMenu = function(x, y) {
    var items = [{ label: '频谱显示方式', isLabel: true }];
    SPEC_MODES.forEach(function(m) {
      if (!canUseSpecMode(m)) return;
      items.push({ label: SPEC_LABEL[m], checked: specMode === m, action: function() { applySpecMode(m); } });
    });
    items.push({ divider: true });
    items.push({ label: '显示在沉浸页那条频谱上', isLabel: true });
    CM.showCtxMenu(x, y, items);
  };

  // 初值：设置里记住的模式（没有 PCM 时自动回落 bars）
  specMode = canUseSpecMode(CM.settings.spectrumMode) ? CM.settings.spectrumMode : 'bars';
  if (!SPEC_LABEL[specMode]) specMode = 'bars';

  /* 切换入口（只有沉浸页那条频谱）：
       · 左键点一下 = 循环切换到下一种
       · 右键 = 列出各种显示让人直接挑（与主题其它右键菜单同一套语言）
     底栏那条迷你频谱**始终是频谱条**，点它不切显示（它是底栏的一格状态指示，
     不是显示切换开关 —— 想换显示去沉浸页）。
     用文档级事件委托：频谱条的 innerHTML 每次初始化都会重建，挂在容器上容易失效。 */
  CM.runOnce('spectrumModeBind', function() {
    function hit(e) {
      var t = e.target;
      // 只认沉浸页那条：底栏迷你频谱固定为频谱条（点它不切显示）
      return (t && t.closest) ? t.closest('#npSpectrum') : null;
    }
    document.addEventListener('click', function(e) {
      if (!hit(e)) return;
      CM.spectrumMode.cycle();
    });
    document.addEventListener('contextmenu', function(e) {
      if (!hit(e)) return;
      e.preventDefault();
      CM.showSpectrumMenu(e.clientX, e.clientY);
    });
  });

  CM.npActiveLyricIndex = -1;

  /* ============================================
   * 专辑河流（Coverflow）：沉浸页内的 3D 专辑浏览
   * --------------------------------------------
   * 数据 = library.getAlbums（不带封面，行自带 firstTrackPath）；封面按需
   * artwork.getFb2kUrlByPath（会话内缓存，FIFO 上限 120 张）。
   * 交互 = ←/→ / Home/End / 滚轮（节流）浏览，点击侧卡聚焦、点当前卡或回车播放
   * （CM.playAlbum → playAllTracks → 双轨制的 _MediaLibraryContext_，不写用户歌单）。
   * 放在沉浸页**内部**而不是新开顶层覆盖层：贴靠区域命中测试由沉浸页的开合统一
   * 处理，不引入"看不见的最大化按钮"那类问题（AGENTS 第五节）。
   * ============================================ */
  var flow = { on: false, idx: 0, albums: null };
  var _flowCovers = {};   // path -> dataUrl
  var _flowCoverN = 0;
  var FLOW_COVER_MAX = 120;
  function flowCachePut(p, u) {
    if (_flowCovers[p]) return;
    if (_flowCoverN >= FLOW_COVER_MAX) { _flowCovers = {}; _flowCoverN = 0; }   // 简单 FIFO：满了整表清
    _flowCovers[p] = u;
    _flowCoverN++;
  }
  CM.npFlowInvalidate = function() { flow.albums = null; };   // 媒体库变更时由 ui-library 的监听调
  function flowEls() {
    return {
      box: CM.$('npFlow'), stage: CM.$('npFlowStage'),
      name: CM.$('npFlowName'), artist: CM.$('npFlowArtist'), btn: CM.$('npFlowBtn')
    };
  }
  function flowAlbums() {
    if (flow.albums) return Promise.resolve(flow.albums);
    // 不传 sort（宿主默认即按名称；2.0.0 的 getAlbums 参数面更窄，少传更稳）
    return CM.api('library.getAlbums', { limit: 2000 }).then(function(r) {
      flow.albums = (r && r.success !== false && r.albums) || [];
      return flow.albums;
    });
  }
  function flowApplyCover(al, artEl) {
    var p = al.firstTrackAbsolutePath || al.firstTrackPath || '';
    if (!p || !artEl) return;
    if (_flowCovers[p]) {
      artEl.style.backgroundImage = 'url("' + _flowCovers[p] + '")';
      artEl.classList.add('has-art');
      return;
    }
    CM.api('artwork.getFb2kUrlByPath', { path: p, type: 'front', maxSize: 320 }).then(function(r) {
      var u = r && r.available !== false && r.dataUrl;
      if (!u) return;
      flowCachePut(p, u);
      // 卡片可能在请求途中被整批重画：按归属校验，别贴到错误的卡上
      if (artEl.dataset.path !== p) return;
      artEl.style.backgroundImage = 'url("' + u + '")';
      artEl.classList.add('has-art');
    });
  }
  function flowTransform(off) {
    var x = off * 200, z = -Math.abs(off) * 180;
    var rY = off === 0 ? 0 : (off < 0 ? 30 : -30);
    var op = Math.max(0.22, 1 - Math.abs(off) * 0.17);
    return 'transform:translate3d(' + x + 'px,0,' + z + 'px) rotateY(' + rY + 'deg);opacity:' + op + ';z-index:' + (10 - Math.abs(off));
  }
  function flowRender() {
    var E = flowEls();
    if (!E.box || !flow.on) return;
    var list = flow.albums;
    if (!list) {
      E.stage.innerHTML = '<div class="np-flow-empty">加载专辑中…</div>';
      return;
    }
    var n = list.length;
    if (!n) { E.stage.innerHTML = '<div class="np-flow-empty">媒体库还没有专辑</div>'; return; }
    flow.idx = Math.max(0, Math.min(n - 1, flow.idx));
    var W = 5;   // 当前两侧各 5 张（超出屏幕的自然裁掉）
    var parts = [];
    for (var off = -W; off <= W; off++) {
      var i = flow.idx + off;
      if (i < 0 || i >= n) continue;
      var al = list[i] || {};
      var p = al.firstTrackAbsolutePath || al.firstTrackPath || '';
      parts.push('<div class="np-flow-card' + (off === 0 ? ' np-flow-card-cur' : '') + '" data-i="' + i + '" style="' + flowTransform(off) + '">' +
        '<div class="np-flow-art" data-path="' + esc(p) + '"></div>' +
        '<div class="np-flow-cap">' + esc(al.name || al.album || '未知专辑') + '</div></div>');
    }
    E.stage.innerHTML = parts.join('');
    var cur = list[flow.idx] || {};
    E.name.textContent = cur.name || cur.album || '未知专辑';
    E.artist.textContent = (cur.albumArtist || cur.artist || '') + (cur.year ? ' · ' + cur.year : '') + ' · ' + n + ' 张专辑';
    // 封面懒取：可见的都取（约 11 张），命中缓存的立即贴上
    var cards = E.stage.querySelectorAll('.np-flow-card');
    for (var c = 0; c < cards.length; c++) {
      var ci = parseInt(cards[c].dataset.i, 10);
      if (!list[ci]) continue;
      flowApplyCover(list[ci], cards[c].querySelector('.np-flow-art'));
    }
  }
  function flowMove(d) {
    var list = flow.albums || [];
    if (!list.length) return;
    var next = flow.idx + d;
    if (next < 0 || next >= list.length) return;
    flow.idx = next;
    flowRender();
  }
  function flowPlayAt(i) {
    var al = (flow.albums || [])[i];
    if (!al) return;
    CM.playAlbum(al.name || al.album || '', al.albumArtist || al.artist || '');
  }
  CM.npFlowToggle = function(force) {
    flow.on = force !== undefined ? !!force : !flow.on;
    var E = flowEls();
    if (!E.box) return;
    E.box.hidden = !flow.on;
    if (E.btn) E.btn.classList.toggle('active', flow.on);
    if (flow.on) {
      flowRender();
      flowAlbums().then(function() { flowRender(); });   // 异步取到专辑后重画一次
    } else {
      E.stage.innerHTML = '';
    }
  };
  // 键盘/滚轮/点击。键盘走捕获阶段：Esc 要先关河流而不是关沉浸页，←/→ 也不能
  // 再落到全局键盘里变成快进/快退（initKeyboard 的滚动寻址）。
  CM.runOnce('npFlowKeys', function() {
    document.addEventListener('keydown', function(e) {
      if (!flow.on) return;
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); e.stopPropagation(); flowMove(-1); break;
        case 'ArrowRight': e.preventDefault(); e.stopPropagation(); flowMove(1); break;
        case 'Home': e.preventDefault(); e.stopPropagation(); flow.idx = 0; flowRender(); break;
        case 'End': e.preventDefault(); e.stopPropagation(); if (flow.albums) { flow.idx = flow.albums.length - 1; flowRender(); } break;
        case 'Enter': e.preventDefault(); e.stopPropagation(); flowPlayAt(flow.idx); break;
        case 'Escape': e.preventDefault(); e.stopPropagation(); CM.npFlowToggle(false); break;
      }
    }, true);
    var stageEl = CM.$('npFlowStage');
    if (stageEl) {
      var lastWheel = 0;
      stageEl.addEventListener('wheel', function(e) {
        if (!flow.on) return;
        e.preventDefault();
        var now = Date.now();
        if (now - lastWheel < 140) return;   // 触控板/滚轮一帧连发，节流避免一次转十张
        lastWheel = now;
        flowMove(e.deltaY > 0 ? 1 : -1);
      }, { passive: false });
    }
    var boxEl = CM.$('npFlow');
    if (boxEl) {
      boxEl.addEventListener('click', function(e) {
        var card = e.target.closest('.np-flow-card');
        if (!card || !flow.albums) return;
        var i = parseInt(card.dataset.i, 10);
        if (isNaN(i)) return;
        if (i === flow.idx) { flowPlayAt(i); return; }   // 点当前卡 = 播放
        flow.idx = i;
        flowRender();
      });
    }
  });
})();
