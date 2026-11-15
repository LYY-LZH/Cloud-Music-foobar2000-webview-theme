/* ============================================
 * CloudMusic popup.js — 小窗（两种形态，同一个页面）
 *
 *   mini   迷你播放器：封面 + 曲名/歌手 + 进度 + 音量 + 上一首/播放/下一首
 *   lyrics 歌词窗（竖版）：上大封面 → 封面下方小字歌曲信息 → 中间整首可滚动歌词
 *          （当前行放大高亮、自动居中）→ 底部进度与控制
 *
 * 两个形态是同一个页面，用 v2 的 window.setSize 现场换尺寸（不重建窗口）；
 * 曲名 / 歌词 / 封面 / 强调色由主窗口经 fb.sharedState（cm:now / cm:lyrics /
 * cm:theme）送来，进度由小窗自己的 PlaybackClock 推进。
 *
 * 位置、尺寸与形态不回写 localStorage —— 小窗与主窗口共享同一份 localStorage，
 * 小窗自己写会把主窗口刚存下的其它设置（频谱模式、音量…）用旧快照覆盖掉。
 * 小窗改用 window.sendMessage 把"形态 + 窗口几何"报给主窗口，由主窗口
 * 统一并进设置；主窗口开窗时再把几何交回来（createPopup 的 x/y/width/height）。
 * 主窗口也已开着小窗时不会再开第二个，而是发消息让它换形态。
 * ============================================ */
(function () {
  'use strict';

  var qs = new URLSearchParams(location.search);

  // 尺寸一律按 CSS 像素写（人看到的大小）；宿主的 createPopup / setSize /
  // setMinSize 收的是**物理像素**，调用前用 px() 乘上窗口的缩放比 ——
  // 否则在 125% / 150% 缩放的屏幕上，420 物理像素只有 300 来个 CSS 像素，
  // 组件会挤成一团（这正是之前"迷你窗又小又挤"的原因）。
  var MODE_CFG = {
    mini:   { w: 520, h: 168, minW: 400, minH: 150, label: '迷你播放器' },
    lyrics: { w: 460, h: 720, minW: 380, minH: 480, label: '歌词窗' }
  };

  function dpr() {
    var s = window.devicePixelRatio;
    return (typeof s === 'number' && s > 0 && isFinite(s)) ? s : 1;
  }
  function px(css) { return Math.max(1, Math.round(css * dpr())); }

  var IDS = ['root', 'bg', 'cap', 'drag', 'btnMode', 'btnPin', 'btnClose',
             'miniBody', 'cover', 'coverImg', 'mTitle', 'mArtist', 'mCur', 'mSeek', 'mTot',
             'mVol', 'mPrev', 'mPlay', 'mNext',
             'lyricsBody', 'art', 'artImg', 'infoTitle', 'infoSub', 'lyrWrap', 'lyrList', 'lyrEmpty',
             'tCur', 'seek', 'tTot', 'btnPrev', 'btnPlay', 'btnNext'];
  var els = {};
  IDS.forEach(function (id) { els[id] = document.getElementById(id); });

  var S = {
    mode: (qs.get('mode') === 'lyrics') ? 'lyrics' : 'mini',
    now: { title: '未在播放', artist: '', album: '', duration: 0, playing: false },
    lyrics: { lines: [], synced: false },
    canSeek: true,
    seeking: false,
    curLine: -1,
    pinned: true,
    clock: null,
    clockSeen: false,        // 时钟是否已经拿到过真实位置（没拿到之前用 fallbackPos）
    raf: 0,
    artKey: '',              // 封面缓存键（曲目路径 + 标题），避免重复请求
    artUrl: '',
    artInfo: null,           // 主窗口送来的封面 { path, url }
    rows: null,
    geomSaved: '',           // 已上报过的几何签名（去重用）
    geomByMode: {},          // 本窗口见过的各形态尺寸（切回来沿用，不用重新拖）
    manualUntil: 0           // 用户手动滚动歌词后到这一刻为止不自动居中
  };

  /* ---------- 工具 ---------- */
  function fmtTime(sec) {
    if (!sec || sec <= 0 || !isFinite(sec)) return '0:00';
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function api(method, params) {
    return fb.invoke(method, params || {}).catch(function () { return null; });
  }
  function isRemote(p) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(p || '');
  }
  // 小窗 → 主窗口：形态 / 窗口几何。旧宿主没有 window.sendMessage 时静默跳过
  // （几何就只在本窗口里生效，不影响使用）
  function sendToMain(message) {
    try { api('window.sendMessage', { targetWindowId: 'main', message: message }); } catch (e) {}
  }

  /* ---------- 形态切换 ---------- */
  function setMinSize(cfg) {
    api('window.setMinSize', { width: px(cfg.minW), height: px(cfg.minH) });
  }

  function applyMode(mode, isInit) {
    if (!MODE_CFG[mode]) mode = 'mini';
    var changed = (mode !== S.mode);
    // 先记下"换出去的那个形态"的几何：saveGeom 是异步的，等它回来时 S.mode
    // 已经变了，所以要显式把当时是哪个形态带进去
    if (!isInit && changed) saveGeom(S.mode);
    S.mode = mode;
    var cfg = MODE_CFG[mode];
    var isMini = mode === 'mini';

    els.miniBody.classList.toggle('hidden', !isMini);
    els.lyricsBody.classList.toggle('hidden', isMini);
    if (els.cap) els.cap.textContent = cfg.label;
    if (els.btnMode) els.btnMode.title = isMini ? '切换为歌词窗（竖版）' : '切换为迷你播放器';
    document.title = 'CloudMusic ' + cfg.label;

    if (!isInit && changed) {
      // 换形态一并换窗口尺寸与最小尺寸（v2 的窗口 API，不重建窗口、播放不中断）。
      // 目标形态上次的尺寸还在就沿用它（同一次开窗里切回来还是那个大小）
      var keep = S.geomByMode[mode];           // 本窗口里见过的那个形态的尺寸（物理像素）
      setMinSize(cfg);
      api('window.setSize', {
        width: (keep && keep.w) || px(cfg.w),
        height: (keep && keep.h) || px(cfg.h)
      });
    } else if (isInit) {
      setMinSize(cfg);
    }
    if (!isInit) sendToMain({ type: 'cloudmusic-popup', kind: 'mode', mode: mode });

    renderNow();
    renderArt();
    renderList();
    renderProgress(position(), total(), true);
  }

  /* ---------- 曲目信息 ---------- */
  function renderNow() {
    var n = S.now;
    var title = n.title || '未在播放';
    var artist = n.artist || '';
    if (els.mTitle) {
      els.mTitle.textContent = title;
      els.mTitle.title = title + (artist ? ' - ' + artist : '');
    }
    if (els.mArtist) els.mArtist.textContent = artist || '--';
    if (els.infoTitle) els.infoTitle.textContent = title;
    if (els.infoSub) els.infoSub.textContent = [artist, n.album || ''].filter(Boolean).join(' · ') || '--';
    document.title = 'CloudMusic · ' + title;
    var playing = !!n.playing;
    [els.mPlay, els.btnPlay].forEach(function (b) { if (b) b.classList.toggle('playing', playing); });
    loadArt();
  }

  // 封面取色：小窗用与主界面同一套强调色
  function applyTheme(t) {
    if (!t || typeof t.h !== 'number') return;
    var root = document.documentElement.style;
    root.setProperty('--accent-h', t.h);
    root.setProperty('--accent-s', t.s + '%');
    root.setProperty('--accent-l', t.l + '%');
    root.setProperty('--accent', 'hsl(' + t.h + ',' + t.s + '%,' + t.l + '%)');
  }

  /* ---------- 封面 ----------
     优先级：主窗口按当前曲目送来的封面（在线曲目也是对的）→ 本地曲目按
     路径问宿主 → 正在播放曲目的封面（兜底）。按"曲目路径"缓存：同一次
     播放状态里来回切换播放/暂停不会反复发请求；换曲先清掉上一张，
     宁可短暂占位也不要挂着上一首的封面。 */
  var _artReq = 0, _artRetry = 0;
  function setArt(url) {
    S.artUrl = url || '';
    renderArt();
  }
  function artForPath(path) {
    return (S.artInfo && S.artInfo.path && S.artInfo.path === path && S.artInfo.url) ? S.artInfo.url : '';
  }
  function loadArt() {
    var path = S.now.path || '';
    var key = path + '\u0000' + (S.now.title || '');
    if (key === S.artKey) return;
    S.artKey = key;
    clearTimeout(_artRetry);
    setArt('');
    resolveArt(path, 0);
  }
  function resolveArt(path, attempt) {
    var req = ++_artReq;
    var given = artForPath(path);
    var finish = function (url) {
      if (req !== _artReq) return;
      if (url) { setArt(url); return; }
      // 在线曲目的封面由主窗口反查后送来（cm:art），可能比曲目信息晚一步
      if (attempt < 3) {
        _artRetry = setTimeout(function () { resolveArt(path, attempt + 1); }, 1200);
      }
    };
    if (given) { finish(given); return; }
    var p = (path && !isRemote(path))
      ? api('artwork.getFb2kUrlByPath', { path: path, type: 'front' })
      : api('artwork.getFb2kUrl', { type: 'front' });
    p.then(function (r) {
      finish((r && r.dataUrl && r.available !== false) ? r.dataUrl : '');
    });
  }

  // 同一张封面喂给：迷你封面 / 歌词窗大图 / 模糊背景。
  // 无封面时用主题的默认封面（与主窗口 CM.setArtwork 同一张），不再留空：
  // 小窗和主界面看到的应该是同一张图，而不是"主界面有占位图、小窗一个空框"。
  var DEFAULT_ART = 'static/img/no_cover.svg';

  // 一张图 → 一个盒子。真封面加载失败同样回退到默认封面；连默认封面都拿不到
  // （资源缺失）才退回音符占位，不留一个加载失败的破图。
  function applyArt(img, box, url) {
    if (!img || !box || img.dataset.artUrl === url) return;
    img.dataset.artUrl = url;
    img.onerror = function () {
      img.onerror = null;
      if (url === DEFAULT_ART) {
        img.style.display = 'none';
        box.classList.remove('has-img');
        return;
      }
      applyArt(img, box, DEFAULT_ART);
    };
    img.style.display = '';
    box.classList.add('has-img');
    img.src = url;
  }

  function renderArt() {
    var url = S.artUrl || DEFAULT_ART;
    applyArt(els.coverImg, els.cover, url);
    applyArt(els.artImg, els.art, url);
    if (els.bg) {
      // 无真封面时也用默认封面（主窗口的沉浸页就是这么做的），整块背景不至于空着
      els.bg.style.backgroundImage = 'url("' + url + '")';
      els.bg.classList.add('on');
    }
  }

  /* ---------- 歌词列表 ---------- */
  function renderList() {
    if (!els.lyrList) return;
    var lines = (S.lyrics && S.lyrics.lines) || [];
    if (!lines.length) {
      els.lyrList.innerHTML = '';
      S.rows = null;
      if (els.lyrEmpty) els.lyrEmpty.classList.remove('hidden');
      return;
    }
    if (els.lyrEmpty) els.lyrEmpty.classList.add('hidden');
    var parts = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      parts.push('<div class="ll"' + (l.t == null ? '' : ' data-t="' + l.t + '"') + '>' + esc(l.x || '') +
        ((l.s && l.s.length) ? '<span class="ll-sub">' + esc(l.s.join(' / ')) + '</span>' : '') +
        '</div>');
    }
    els.lyrList.innerHTML = parts.join('');
    S.rows = els.lyrList.children;
    S.curLine = -1;
    updateActive(true);
  }

  function indexAt(pos) {
    var lines = (S.lyrics && S.lyrics.lines) || [];
    if (!S.lyrics.synced || !lines.length) return -1;
    var idx = -1, lo = 0, hi = lines.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t != null && lines[mid].t <= pos) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return idx;
  }

  function updateActive(force) {
    if (S.mode !== 'lyrics' || !S.rows || !S.rows.length) return;
    var idx = indexAt(position() + 0.2);
    if (!force && idx === S.curLine) return;
    S.curLine = idx;
    for (var i = 0; i < S.rows.length; i++) S.rows[i].classList.toggle('active', i === idx);
    // 用户刚自己滚过歌词（可能在看后面的句子）：这段时间只换高亮，不抢滚动条
    if (Date.now() < S.manualUntil) return;
    if (idx >= 0 && S.rows[idx] && els.lyrWrap) {
      // 用视口坐标算目标位置（不依赖 offsetParent 是谁）：当前行正好落在可见区正中
      var wrap = els.lyrWrap;
      var rowRect = S.rows[idx].getBoundingClientRect();
      var wrapRect = wrap.getBoundingClientRect();
      var top = wrap.scrollTop + (rowRect.top - wrapRect.top) - wrap.clientHeight / 2 + rowRect.height / 2;
      if (top < 0) top = 0;
      wrap.scrollTo({ top: top, behavior: force ? 'auto' : 'smooth' });
    }
  }

  /* ---------- 进度 ---------- */
  function position() {
    if (S.clock && S.clockSeen) {
      try {
        var p = S.clock.position();
        if (typeof p === 'number' && isFinite(p)) return p;
      } catch (e) { /* 回退 */ }
    }
    return S.fallbackPos || 0;
  }
  function total() {
    if (S.clock) {
      try {
        var d = S.clock.duration;
        if (d > 0) return d;
      } catch (e) {}
    }
    return S.now.duration || 0;
  }
  function renderProgress(pos, dur, force) {
    var pct = (dur > 0) ? Math.max(0, Math.min(1, pos / dur)) : 0;
    var v = Math.round(pct * 1000);
    [els.mSeek, els.seek].forEach(function (s) { if (s && !S.seeking) s.value = v; });
    if (els.mCur) els.mCur.textContent = fmtTime(pos);
    if (els.mTot) els.mTot.textContent = fmtTime(dur);
    if (els.tCur) els.tCur.textContent = fmtTime(pos);
    if (els.tTot) els.tTot.textContent = fmtTime(dur);
  }

  var _lastUiPos = -1;
  function tick() {
    S.raf = requestAnimationFrame(tick);
    var pos = position();
    if (Math.abs(pos - _lastUiPos) < 0.2) { updateActive(false); return; }
    _lastUiPos = pos;
    renderProgress(pos, total());
    updateActive(false);
  }

  function setPosition(t) {
    if (!S.canSeek) { flashSeekBlocked(); return; }
    // v2：参数名是 position（旧名 seconds 会被严格校验拒掉）
    api('playback.setPosition', { position: t }).then(function () { });
  }
  function setCanSeek(v) {
    S.canSeek = v !== false;
    [els.mSeek, els.seek].forEach(function (s) {
      if (!s) return;
      s.disabled = !S.canSeek;
      s.title = S.canSeek ? '' : '当前曲目不可跳转（网络流 / 直播）';
    });
  }
  var _blockedAt = 0;
  // 标题栏临时替词（小窗没有 toast：失败/限制都在这里说一句，1.2 秒后还原）
  function flashCap(text) {
    if (!els.cap) return;
    var old = els.cap.textContent;
    els.cap.textContent = text;
    setTimeout(function () { if (els.cap && els.cap.textContent === text) els.cap.textContent = old; }, 1200);
  }
  function flashSeekBlocked() {
    var now = Date.now();
    if (now - _blockedAt < 1500) return;
    _blockedAt = now;
    flashCap('这首歌不可跳转');
  }

  /* ---------- 交互 ---------- */
  // 标题栏：两种形态共用
  if (els.drag) els.drag.addEventListener('mousedown', function (e) { if (e.button === 0) api('window.startDrag'); });
  if (els.btnMode) els.btnMode.addEventListener('click', function () { applyMode(S.mode === 'mini' ? 'lyrics' : 'mini'); });
  if (els.btnClose) els.btnClose.addEventListener('click', function () { api('window.close'); });
  if (els.btnPin) {
    els.btnPin.classList.toggle('on', S.pinned);
    els.btnPin.addEventListener('click', function () {
      var want = !S.pinned;
      // api() 把失败吞成 null：被宿主拒绝时不能把按钮点亮成「已置顶」（假成功）
      api('window.setAlwaysOnTop', { enabled: want }).then(function (r) {
        if (!r || r.success === false) { flashCap('置顶失败'); return; }
        setPinned(want);
      });
    });
  }
  function setPinned(pinned) {
    S.pinned = !!pinned;
    if (els.btnPin) {
      els.btnPin.classList.toggle('on', S.pinned);
      els.btnPin.title = S.pinned ? '已置顶（点击取消）' : '窗口置顶';
    }
  }
  // 迷你播放器
  if (els.mPrev) els.mPrev.addEventListener('click', function () { api('playback.previous'); });
  if (els.mNext) els.mNext.addEventListener('click', function () { api('playback.next'); });
  if (els.mPlay) els.mPlay.addEventListener('click', function () { api('playback.playOrPause'); });
  if (els.mVol) els.mVol.addEventListener('input', function () { api('playback.setVolume', { volume: +els.mVol.value }); });
  // 音量条是"悬停展开"的：按住滑块往外拖时指针会离开那个小图标，展开态会被
  // :hover 收回去、拖动直接断掉 —— 按下时给包装层钉一个 .open，松开再撤掉
  if (els.mVol) {
    var volWrap = document.getElementById('mVolWrap');
    var unpinVol = function () { if (volWrap) volWrap.classList.remove('open'); };
    els.mVol.addEventListener('pointerdown', function () { if (volWrap) volWrap.classList.add('open'); });
    els.mVol.addEventListener('pointerup', unpinVol);
    els.mVol.addEventListener('change', unpinVol);
  }
  // 歌词窗
  if (els.btnPrev) els.btnPrev.addEventListener('click', function () { api('playback.previous'); });
  if (els.btnNext) els.btnNext.addEventListener('click', function () { api('playback.next'); });
  if (els.btnPlay) els.btnPlay.addEventListener('click', function () { api('playback.playOrPause'); });
  // 两条进度条同一套行为
  [els.mSeek, els.seek].forEach(function (bar) {
    if (!bar) return;
    bar.addEventListener('input', function () {
      S.seeking = true;
      if (els.mCur) els.mCur.textContent = fmtTime(bar.value / 1000 * total());
      if (els.tCur) els.tCur.textContent = fmtTime(bar.value / 1000 * total());
    });
    bar.addEventListener('change', function () {
      var target = bar.value / 1000 * total();
      S.seeking = false;
      setPosition(target);
      renderProgress(target, total(), true);
    });
  });
  // 点歌词行 = 跳到那一句（跳转后重新跟随）
  if (els.lyrList) {
    els.lyrList.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.ll') : null;
      if (!row || !row.dataset.t) return;
      var t = parseFloat(row.dataset.t);
      if (isFinite(t)) { S.manualUntil = 0; setPosition(t); }
    });
  }
  // 自己滚动歌词后短时间内不要被自动居中拽回去（看后面的句子时很烦）
  if (els.lyrWrap) {
    els.lyrWrap.addEventListener('wheel', function () {
      S.manualUntil = Date.now() + 4000;
    }, { passive: true });
    els.lyrWrap.addEventListener('touchstart', function () {
      S.manualUntil = Date.now() + 4000;
    }, { passive: true });
  }
  // 迷你形态上滚轮调音量（与音量条等价，方便不点开窗口就调）。
  // 一次滚动会来一串 wheel 事件，节流成"每 60ms 一步、一步 2%"，
  // 否则轻轻一滚音量就从一个极端跳到另一个极端。
  var _wheelAt = 0;
  if (els.miniBody) {
    els.miniBody.addEventListener('wheel', function (e) {
      if (S.mode !== 'mini') return;
      e.preventDefault();
      var now = Date.now();
      if (now - _wheelAt < 60) return;
      _wheelAt = now;
      var cur = (els.mVol ? +els.mVol.value : 100);
      var v = Math.max(0, Math.min(100, cur + (e.deltaY > 0 ? -2 : 2)));
      if (v === cur) return;
      if (els.mVol) els.mVol.value = v;
      api('playback.setVolume', { volume: v });
    }, { passive: false });
  }
  // 双击封面/标题栏：呼出主窗口（小窗被置顶挡住主界面时够用）
  function focusMain() { api('window.focus', { windowId: 'main' }); }
  if (els.cover) els.cover.addEventListener('dblclick', focusMain);
  if (els.art) els.art.addEventListener('dblclick', focusMain);

  // 托盘图标的兜底：主窗口藏到托盘后它那页可能已被宿主深挂起（JS 不跑），
  // 而小窗是可见的、事件循环照常 —— 单击 / 双击托盘由这里把主窗口叫回来。
  // 托盘事件宿主广播给所有窗口，所以两边都处理不会互相干扰。
  // 例外：主窗口开启 2.1.0 的原生托盘左键（toggleMainWindow，经 cm:trayNative
  // 共享键广而告之）后，宿主自己切换显隐 —— doubleClick 仍会广播到这里，若再
  // focusMain 会把刚隐藏的主窗口又叫回来。读一次 + onChange 跟随，事件里复查。
  var trayNativeToggle = false;
  function syncTrayNative(v) { trayNativeToggle = !!(v && v.on); }
  function bindTrayFocus() {
    if (typeof fb.on !== 'function') return;
    fb.on('tray:click', function (e) {
      if (trayNativeToggle) return;
      if (e && e.button !== undefined && e.button !== 0) return;
      focusMain();
    });
    fb.on('tray:doubleClick', function () {
      if (trayNativeToggle) return;
      focusMain();
    });
    if (fb.sharedState && typeof fb.sharedState.get === 'function') {
      // 回包契约（2.2.0 文档 + 实机 CDP 双证）：键命中时字段是 **exists**（无 found）。
      // SDK JSDoc 写的 found 与实机不符 —— 第二十七轮照它把这里改成 r.found，
      // 结果一次同步从未生效过；两个名字都认，跨宿主版本兜住
      fb.sharedState.get('cm:trayNative').then(function (r) {
        var present = r && (r.found !== undefined ? r.found : r.exists);
        if (r && r.success !== false && present && r.value) syncTrayNative(r.value);
      }, function () {});
    }
  }

  /* ---------- 窗口几何：报给主窗口，按形态记 ---------- */
  function saveGeom(modeAtCall) {
    var mode = MODE_CFG[modeAtCall] ? modeAtCall : S.mode;
    api('window.getBounds').then(function (r) {
      if (!r || r.success === false || r.width == null) return;
      S.geomByMode[mode] = { x: r.x, y: r.y, w: r.width, h: r.height };
      var sig = [mode, r.x, r.y, r.width, r.height].join(',');
      if (sig === S.geomSaved) return;
      S.geomSaved = sig;
      sendToMain({
        type: 'cloudmusic-popup', kind: 'geom', mode: mode, scale: dpr(),
        bounds: { x: r.x, y: r.y, width: r.width, height: r.height }
      });
    });
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', function () {
      saveGeom();
      // 改窗口大小后当前句可能已经不在可见区：立刻重新居中一次
      // （用户刚自己滚过歌词时 updateActive 内部会跳过，不会抢滚动条）
      if (S.mode === 'lyrics') updateActive(true);
    });
  }

  /* ---------- 主窗口的跨窗口状态 ---------- */
  // cm:now 是主窗口算好的曲目信息，它可能比宿主的 trackChanged 先到或后到：
  // 这里自己比对"是不是换了曲目"，换了就重置进度并重新读一次位置 ——
  // 否则小窗会停在 0:00（暂停中的曲目没有 timeHighRes 事件来纠正）。
  function applyNow(value) {
    if (!value) return;
    var prevPath = (S.now && S.now.path) || '';
    var prevTitle = (S.now && S.now.title) || '';
    var changed = (value.path || '') !== prevPath || (value.title || '') !== prevTitle;
    S.now = value;
    if (changed) {
      S.fallbackPos = 0;
      S.artKey = '';
      if (S.clock && S.clock.resync) {
        try { var pr = S.clock.resync(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
      }
      api('playback.getPosition').then(function (r) {
        if (!r) return;
        if (r.duration) S.now.duration = r.duration;
        if (r.position != null) S.fallbackPos = r.position;
        renderProgress(position(), total(), true);
      });
    }
    renderNow();
  }

  function applyShared() {
    if (!fb.sharedState || typeof fb.sharedState.get !== 'function') return;
    fb.sharedState.get('cm:now').then(function (r) {
      if (r && r.success !== false && r.exists && r.value) applyNow(r.value);
    }, function () {});
    fb.sharedState.get('cm:lyrics').then(function (r) {
      if (r && r.success !== false && r.exists && r.value) {
        S.lyrics = r.value;
        renderList();
      }
    }, function () {});
    fb.sharedState.get('cm:theme').then(function (r) {
      if (r && r.success !== false && r.exists && r.value) applyTheme(r.value);
    }, function () {});
    fb.sharedState.get('cm:art').then(function (r) {
      if (r && r.success !== false && r.exists && r.value) { S.artInfo = r.value; loadArt(); }
    }, function () {});
  }

  function subscribeShared() {
    if (!fb.sharedState || typeof fb.sharedState.onChange !== 'function') return;
    fb.sharedState.onChange(function (data) {
      if (!data || !data.key) return;
      if (data.key === 'cm:now') applyNow(data.value);
      else if (data.key === 'cm:lyrics') {
        S.lyrics = data.value || { lines: [], synced: false };
        renderList();
      }
      else if (data.key === 'cm:theme') applyTheme(data.value);
      else if (data.key === 'cm:trayNative') syncTrayNative(data.value);
      else if (data.key === 'cm:art') {
        S.artInfo = data.value || {};
        // 主窗口送来的封面属于当前曲目才用（切歌与取图是两条异步路径）
        if (artForPath(S.now.path || '')) setArt(S.artInfo.url);
      }
    });
  }

  // 主窗口发来的命令（当前只有"换形态"：已经开着一个小窗时不再开第二个）
  function subscribeMessages() {
    if (typeof fb.on !== 'function') return;
    fb.on('window:message', function (data) {
      var m = data && data.message;
      if (!m || m.type !== 'cloudmusic-popup') return;
      if (m.cmd === 'setMode' && MODE_CFG[m.mode] && m.mode !== S.mode) applyMode(m.mode);
      else if (m.cmd === 'reveal') revealSelf();
      else if (m.cmd === 'ping') sendToMain({ type: 'cloudmusic-popup', kind: 'hello', mode: S.mode });
    });
  }

  // 主窗口重新叫出这个小窗（或它刚被别的窗口挡住 / 表面停在旧画面）时：
  // refreshWebView 清掉残留画面（黑屏就是它），再把自己置前并重绘一遍。
  // 只有这个窗口自己能做这两件事 —— 窗口 API 只作用于调用方窗口。
  function revealSelf() {
    api('window.refreshWebView');
    api('window.focus');
    renderNow();
    renderArt();
    renderList();
    renderProgress(position(), total(), true);
    if (S.mode === 'lyrics') updateActive(true);
  }

  /* ---------- 宿主事件 / 初始同步 ---------- */
  function syncTrack() {
    api('playback.getCurrentTrack').then(function (r) {
      var t = r && (r.track || (r.found ? r : null));
      if (!t) return;
      if (!S.now.title || S.now.title === '未在播放') {
        S.now.title = t.title || '未知曲目';
        S.now.artist = t.artist || t.albumArtist || '';
      }
      var newPath = t.absolutePath || t.path || '';
      if (newPath && newPath !== (S.now.path || '')) {
        S.now.path = newPath;
        S.fallbackPos = 0;
        S.artKey = '';
      } else if (newPath) {
        S.now.path = newPath;
      }
      if (t.duration) S.now.duration = t.duration;
      renderNow();
    });
    api('playback.getState').then(function (r) {
      if (!r) return;
      S.now.playing = (r.state === 'playing');
      if (r.canSeek != null) setCanSeek(r.canSeek);
      renderNow();
    });
    api('playback.getPosition').then(function (r) {
      if (!r) return;
      if (r.duration) S.now.duration = r.duration;
      if (r.position != null) S.fallbackPos = r.position;
      renderProgress(position(), total(), true);
    });
    api('playback.getVolume').then(function (r) {
      if (r && r.volume != null && els.mVol) els.mVol.value = r.volume;
    });
    api('window.isAlwaysOnTop').then(function (r) {
      if (r && (r.enabled != null || r.isAlwaysOnTop != null)) {
        setPinned(r.enabled != null ? r.enabled : r.isAlwaysOnTop);
      }
    });
  }

  function subscribeHost() {
    fb.on('playback:trackChanged', function () {
      S.artKey = '';
      syncTrack();
      renderArt();
      renderList();
    });
    fb.on('playback:stateChanged', function (data) {
      if (!data) return;
      if (data.duration) S.now.duration = data.duration;
      if (data.position != null) S.fallbackPos = data.position;
      if (data.canSeek != null) setCanSeek(data.canSeek);
      if (data.state) S.now.playing = (data.state === 'playing');
      renderNow();
      renderProgress(position(), total(), true);
    });
    fb.on('playback:seeked', function (data) {
      if (data && data.position != null) S.fallbackPos = data.position;
      if (S.clock && S.clock.resync) {
        try { var pr = S.clock.resync(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
      }
      S.manualUntil = 0;                    // 跳转后回到跟随
      if (data && data.position != null) renderProgress(data.position, total(), true);
      updateActive(true);
    });
    fb.on('playback:volumeChanged', function (data) {
      if (data && data.volume != null && els.mVol) els.mVol.value = data.volume;
    });
    fb.on('playback:stopped', function () {
      S.now.playing = false;
      S.fallbackPos = 0;
      S.curLine = -1;
      renderNow();
      renderProgress(0, total(), true);
      updateActive(true);
    });
  }

  function boot() {
    applyMode(S.mode, true);
    setCanSeek(true);
    if (fb.PlaybackClock) {
      try { S.clock = new fb.PlaybackClock(); } catch (e) { S.clock = null; }
    }
    if (S.clock) {
      if (typeof S.clock.onChange === 'function') {
        try { S.clock.onChange(function () { S.clockSeen = true; }); } catch (e) {}
      }
      // 小窗可能是"看着播了一半的曲目"时打开的：先主动读一次状态与位置，
      // 否则要等下一次宿主事件（暂停状态根本没有）时钟才不是 0
      if (typeof S.clock.resync === 'function') {
        try {
          var pr = S.clock.resync();
          if (pr && pr.then) pr.then(function () { S.clockSeen = true; }, function () {});
        } catch (e) {}
      }
    }
    var start = function () {
      syncTrack();
      subscribeHost();
      applyShared();
      subscribeShared();
      subscribeMessages();
      bindTrayFocus();
      sendToMain({ type: 'cloudmusic-popup', kind: 'hello', mode: S.mode });
      setInterval(saveGeom, 2500);       // 轻量：一次 getBounds，按形态记位置/尺寸
      window.addEventListener('beforeunload', saveGeom);
      if (S.raf) cancelAnimationFrame(S.raf);
      S.raf = requestAnimationFrame(tick);
    };
    var ready = (typeof fb.ready === 'function') ? fb.ready() : Promise.resolve();
    ready.then(start, start);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
