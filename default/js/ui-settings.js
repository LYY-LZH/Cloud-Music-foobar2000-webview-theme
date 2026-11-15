/* ============================================
 * CloudMusic ui-settings.js — 设置与工具页
 *
 * 定位：把「低频但要有」的东西从底栏「更多」菜单里搬出来。
 * 菜单只留当下要用、点一下就要生效的入口（小窗 / 桌面歌词 / 沉浸 / 音频三件套 /
 * 主菜单 / 刷新），其余一次性或排障类（foobar 工具、诊断、帮助、
 * 默认形态、重置几何…）全收在这一页，避免把一个 popover 塞成二十行加三层子菜单。
 *
 * 页面内容是脚本生成的（不是 index.html 里的静态标记）：分区与行的状态要跟
 * CM.settings / 宿主回包实时对上，写在同一处才不容易对不上号。
 * ============================================ */
(function() {
  'use strict';
  var CM = window.CloudMusic;
  var built = false;

  function on(v) { return v ? '开' : '关'; }

  function esc(s) { return CM.escHtml(String(s == null ? '' : s)); }

  // 一行开关：data-act="toggle:<键>"，状态由 sync() 回填（class 'on' + note）
  function rowSwitch(id, label, sub, note) {
    return '<div class="set-row">' +
      '<div class="set-row-main"><div class="set-row-label">' + label + '</div>' +
      (sub ? '<div class="set-row-sub">' + sub + '</div>' : '') + '</div>' +
      '<div class="set-right">' +
      (note ? '<span class="set-note" id="' + id + 'Note">' + note + '</span>' : '') +
      '<button class="set-switch" id="' + id + '" role="switch" aria-checked="false" data-act="toggle:' + id + '">' +
      '<span class="set-knob"></span></button>' +
      '</div></div>';
  }

  // 一行按钮
  function rowButton(label, sub, btnText, act, btnId) {
    return '<div class="set-row">' +
      '<div class="set-row-main"><div class="set-row-label">' + label + '</div>' +
      (sub ? '<div class="set-row-sub">' + sub + '</div>' : '') + '</div>' +
      '<button class="set-btn" ' + (btnId ? 'id="' + btnId + '" ' : '') + 'data-act="' + act + '">' + btnText + '</button>' +
      '</div>';
  }

  // 一行分段选择：data-act="<act>" data-v="<值>"
  function rowSeg(label, sub, act, items, hostId) {
    var s = '<div class="set-row"><div class="set-row-main"><div class="set-row-label">' + label + '</div>' +
      (sub ? '<div class="set-row-sub">' + sub + '</div>' : '') + '</div><div class="set-seg" ' +
      (hostId ? 'id="' + hostId + '" ' : '') + 'data-act="' + act + '">';
    for (var i = 0; i < items.length; i++) {
      s += '<button class="set-seg-btn" data-v="' + items[i][0] + '" data-act="' + act + '">' + items[i][1] + '</button>';
    }
    return s + '</div></div>';
  }

  function build() {
    if (built) return;
    var el = CM.$('tabSettings');
    if (!el) return;
    built = true;

    var srcs = (CM.lyricSources && CM.lyricSources.sources) || [];
    var srcHtml = '';
    for (var i = 0; i < srcs.length; i++) {
      srcHtml += '<button class="set-chip" data-act="src" data-v="' + esc(srcs[i].id) + '">' + esc(srcs[i].label) + '</button>';
    }

    // 全局热键的四行动作按钮（键值由 sync() 按设置回填）
    var hkRows = '';
    for (var hk = 0; hk < CM.hotkeys.ACTIONS.length; hk++) {
      var hact = CM.hotkeys.ACTIONS[hk];
      hkRows += '<div class="set-row"><div class="set-row-main"><div class="set-row-label">' + hact.label + '</div></div>' +
        '<button class="set-btn set-hk-key" id="setHk_' + hact.id + '" data-act="hkset:' + hact.id + '">点击设置</button></div>';
    }

    el.innerHTML =
      '<div class="set-page">' +
      '<div class="set-head"><div class="set-title">设置与工具</div>' +
      '<div class="set-head-sub">底栏「更多」只留常用入口；低频项与排障工具都在这里</div></div>' +

      '<div class="set-group"><div class="set-group-title">外观与可视化</div>' +
      rowSwitch('setVisualizer', '迷你频谱', '底栏那条频谱开关（沉浸页的频谱不受它影响）', '开') +
      rowSwitch('setTilt3d', '歌词 3D 倾斜', '沉浸页把整块歌词贴成一面斜墙', '关') +
      rowSeg('频谱显示方式', '沉浸页那条频谱的档位，也可直接点频谱循环切换', 'spectrum',
        [['bars', '频谱条'], ['field', '声场'], ['waterfall', '瀑布图'], ['oscillo', '示波器'], ['vector', '矢量示波器']], 'setSpectrum') +
      rowSeg('窗口材质', 'Win11 的窗口背景材质（Win10 自动回退纯色）；开启后主窗口背景半透明，小窗暂不参与', 'material',
        [['', '关'], ['mica', 'Mica'], ['acrylic', '亚克力']], 'setMaterial') +
      '</div>' +

      '<div class="set-group"><div class="set-group-title">歌词</div>' +
      '<div class="set-row"><div class="set-row-main"><div class="set-row-label">在线歌词源</div>' +
      '<div class="set-row-sub">本地同名 .lrc / 歌词库永远优先；匹配不到时才联网问这些源</div></div>' +
      '<div class="set-chips" id="setLyricSrc">' + srcHtml + '</div></div>' +
      rowButton('搜索歌词…', '列出各来源的候选，挑一条应用（按文件记住）', '打开候选列表', 'lyricSearch') +
      '</div>' +

      '<div class="set-group"><div class="set-group-title">播放与队列</div>' +
      rowSeg('播放历史条数', '「上一首」回溯用的时间线（插队队列上方的「播放历史」按钮里），超出后淘汰最早的记录', 'historymax',
        [[10, '10 条'], [20, '20 条'], [50, '50 条'], [100, '100 条']], 'setHistoryMax') +
      rowSwitch('setCursorFollow', '光标跟随播放', '切歌时把当前表格滚动定位到正在播放的那一行；同时写回 foobar 的同名设置（原生视图也生效）', '关') +
      rowSwitch('setPlaybackFollow', '播放跟随光标', 'foobar 原生行为：光标/选中处开始播放（主要影响原生视图与其它组件，对本主题界面影响小）', '关') +
      '</div>' +

      '<div class="set-group"><div class="set-group-title">全局热键</div>' +
      rowSwitch('setHotkeysOn', '启用全局热键', '窗口未聚焦也能用；可能与 foobar 首选项里的全局热键抢注，失败会如实提示', '关') +
      '<div class="set-row"><div class="set-row-main"><div class="set-row-label">按键</div>' +
      '<div class="set-row-sub">点右侧按钮后直接按下想要的组合键（至少带 Ctrl 或 Alt；Delete 清除该热键；Esc 取消）</div></div></div>' +
      hkRows +
      '</div>' +

      '<div class="set-group"><div class="set-group-title">窗口与小窗</div>' +
      rowSeg('默认小窗形态', '「更多 → 迷你播放器 / 歌词窗」与下次开窗都用它', 'popupmode',
        [['mini', '迷你播放器'], ['lyrics', '歌词窗']], 'setPopupMode') +
      rowButton('打开小窗', '当前默认形态', '打开', 'openPopup') +
      rowButton('重置小窗位置与尺寸', '会忘掉拖过的位置与大小，下次开窗用默认值', '重置', 'resetGeom') +
      rowSwitch('setTray', '常驻托盘', '托盘菜单的播放控制由组件原生执行，页面挂起也能用', '关') +
      '</div>' +

      '<div class="set-group"><div class="set-group-title">音频与 DSP</div>' +
      '<div class="set-row"><div class="set-row-main"><div class="set-row-label">DSP 预设</div>' +
      '<div class="set-row-sub">foobar 配置目录 dsp-presets 下的效果链整包（均衡器等），点击即应用、当前项带 ✓</div></div></div>' +
      '<div class="set-chips" id="setDspPresets"><span class="set-note">读取中…</span></div>' +
      '</div>' +

      '<div class="set-group"><div class="set-group-title">foobar2000 工具</div>' +
      rowButton('主菜单', '用主题的样式打开 foobar 的完整主菜单（全部命令）', '打开', 'mainMenu') +
      rowButton('首选项', '打开 foobar2000 的设置窗口', '打开', 'prefs') +
      rowButton('控制台', '查看组件与主题的输出日志（排障用）', '打开', 'console') +
      rowButton('刷新媒体库缓存', '媒体库有新增文件但没出现时用', '刷新', 'rescan') +
      rowButton('高级首选项搜索', 'foobar 的高级首选项是 GUID 树、只能按 GUID 读写 —— 这里按「显示名」搜出条目与当前值（只读，结果可复制）', '搜索', 'advPref') +
      '</div>' +

      '<div class="set-group"><div class="set-group-title">关于与帮助</div>' +
      '<div class="set-row"><div class="set-row-main"><div class="set-row-label">CloudMusic 主题</div>' +
      '<div class="set-row-sub" id="setAboutVer"></div></div>' +
      '<button class="set-btn" data-act="about">关于 / 诊断</button></div>' +
      rowButton('复制诊断报告', '主题版本、宿主版本、能力表、最近失败的调用 —— 反馈时贴这一份就够', '复制', 'copyReport') +
      rowButton('使用帮助', '功能指南与更新日志（guide.html）', '打开', 'help') +
      '<div class="set-row"><div class="set-row-main"><div class="set-row-label">页面来源</div>' +
      '<div class="set-row-sub" id="setSource">读取中…</div></div></div>' +
      '</div>' +

      '</div>';

    bind(el);
    CM.syncSettingsState();
  }

  function toggleSwitch(btn, onState) {
    btn.classList.toggle('on', !!onState);
    btn.setAttribute('aria-checked', onState ? 'true' : 'false');
  }
  function setNote(id, text) {
    var el = CM.$(id);
    if (el) el.textContent = text == null ? '' : text;
  }
  function segActive(hostId, val) {
    var host = CM.$(hostId);
    if (!host) return;
    var btns = host.querySelectorAll('.set-seg-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.v === val);
  }

  /* ---------- 状态同步（每次进入本页 / 每次改动后调用） ---------- */
  CM.syncSettingsState = function() {
    if (!built) return;
    // 外观与可视化
    toggleSwitch(CM.$('setVisualizer'), CM.state.visualizerActive);
    setNote('setVisualizerNote', on(CM.state.visualizerActive));
    toggleSwitch(CM.$('setTilt3d'), !!CM.settings.tilt3d);
    setNote('setTilt3dNote', on(CM.settings.tilt3d));
    segActive('setSpectrum', (CM.spectrumMode && CM.spectrumMode.current()) || CM.settings.spectrumMode || 'bars');
    // 歌词源
    var map = CM.lyricSources ? CM.lyricSources.enabledMap() : {};
    var chips = CM.$('setLyricSrc');
    if (chips) {
      var list = chips.querySelectorAll('.set-chip');
      for (var i = 0; i < list.length; i++) list[i].classList.toggle('on', map[list[i].dataset.v] !== false);
    }
    // 小窗
    segActive('setPopupMode', CM.settings.popupMode === 'lyrics' ? 'lyrics' : 'mini');
    // 播放历史条数（上限可配；超出的记录在写入时淘汰）
    segActive('setHistoryMax', String(CM.history ? CM.history.max() : 20));
    // 光标/播放跟随：状态以 foobar 配置为准，进页面时实时读回（不落我们的 localStorage）
    var cfOk = !!(CM.caps && CM.caps.has('config.getCursorFollowPlayback'));
    var cfBtn = CM.$('setCursorFollow'), pfBtn = CM.$('setPlaybackFollow');
    if (cfBtn) cfBtn.disabled = !cfOk;
    if (pfBtn) pfBtn.disabled = !cfOk;
    if (cfOk) {
      CM.api('config.getCursorFollowPlayback').then(function(r) {
        if (!r || r.success === false || !cfBtn.isConnected) return;
        CM.state.cursorFollow = !!r.enabled;
        toggleSwitch(cfBtn, CM.state.cursorFollow);
        setNote('setCursorFollowNote', on(CM.state.cursorFollow));
      });
      CM.api('config.getPlaybackFollowCursor').then(function(r) {
        if (!r || r.success === false || !pfBtn.isConnected) return;
        CM.state.playbackFollow = !!r.enabled;
        toggleSwitch(pfBtn, CM.state.playbackFollow);
        setNote('setPlaybackFollowNote', on(CM.state.playbackFollow));
      });
    } else {
      setNote('setCursorFollowNote', '宿主不支持');
      setNote('setPlaybackFollowNote', '宿主不支持');
    }
    // 全局热键
    var hkOk = !!(CM.caps && CM.caps.has('keyboard.registerHotkey'));
    var hkBtn = CM.$('setHotkeysOn');
    var hcfg = CM.settings.hotkeys || { on: false, binds: {} };
    var hkBinds = hcfg.binds || {};
    if (hkBtn) hkBtn.disabled = !hkOk;
    toggleSwitch(hkBtn, hkOk && !!hcfg.on);
    setNote('setHotkeysOnNote', hkOk ? on(!!hcfg.on) : '宿主不支持');
    for (var hi = 0; hi < CM.hotkeys.ACTIONS.length; hi++) {
      var hact = CM.hotkeys.ACTIONS[hi].id;
      var hkKeyBtn = CM.$('setHk_' + hact);
      if (hkKeyBtn) {
        // 老设置可能存着 e.key 形态（ArrowLeft），显示前归一成宿主语法（Left），
        // 与注册值 / 冲突提示里的键名保持一致
        var hkDisp = hkBinds[hact];
        if (hkDisp && CM.hotkeys.normKeyName) hkDisp = CM.hotkeys.normKeyName(hkDisp);
        hkKeyBtn.textContent = hkDisp || '点击设置';
        hkKeyBtn.disabled = !hkOk;
      }
    }
    // 窗口材质
    segActive('setMaterial', CM.settings.material || '');
    // 托盘（旧宿主禁用并说明，而不是让用户点了没反应）
    var trayBtn = CM.$('setTray'), trayOk = !!(CM.tray && CM.tray.supported());
    if (trayBtn) {
      trayBtn.disabled = !trayOk;
      toggleSwitch(trayBtn, trayOk && CM.tray.isOn());
    }
    setNote('setTrayNote', trayOk ? on(CM.tray.isOn()) : '宿主不支持');
    // 版本与来源
    var caps = CM.caps || {}, ver = caps.version || {};
    var plug = ver.plugin;
    if (plug && typeof plug === 'object') plug = plug.version || plug.name;
    setNote('setAboutVer', '主题 v' + CM.VERSION +
      ' · foobar2000 ' + (ver.foobar2000 || caps.host || '未知') +
      ' · 组件 ' + (plug || caps.plugin || '未知'));
    if (CM._sourceText) setNote('setSource', CM._sourceText);
    else if (CM.caps && CM.caps.loadHostInfo) {
      CM.caps.loadHostInfo().then(function() { setNote('setSource', CM._sourceText || '未知'); });
    }
  };

  /* ---------- 交互（一个委托监听器，行是脚本生成的，逐行绑定容易漏） ---------- */
  function bind(root) {
    root.addEventListener('click', function(e) {
      var t = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!t || t.disabled) return;
      var act = t.dataset.act;
      if (act.indexOf('toggle:') === 0) return actToggle(act.slice(7));
      if (act.indexOf('hkset:') === 0) return CM.hotkeys.capture(act.slice(6), t);
      switch (act) {
        case 'spectrum':
          if (CM.spectrumMode) CM.spectrumMode.set(t.dataset.v);
          CM.syncSettingsState();
          break;
        case 'src': {
          var m = CM.lyricSources.enabledMap();
          m[t.dataset.v] = (m[t.dataset.v] === false);   // 取反（默认全开）
          CM.saveSettings();
          CM.syncSettingsState();
          break;
        }
        case 'lyricSearch': CM.openLyricSearch(); break;
        case 'popupmode':
          CM.settings.popupMode = (t.dataset.v === 'lyrics') ? 'lyrics' : 'mini';
          CM.saveSettings();
          CM.syncSettingsState();
          break;
        case 'historymax': {
          var n = parseInt(t.dataset.v, 10);
          if (!n) break;
          CM.settings.historyMax = n;
          CM.saveSettings();
          CM.history.save();   // 立刻按新上限裁剪并重绘
          CM.syncSettingsState();
          CM.showToast('播放历史上限已改为 ' + n + ' 条', null, 'success');
          break;
        }
        case 'openPopup': CM.openPopupWindow(CM.settings.popupMode === 'lyrics' ? 'lyrics' : 'mini'); break;
        case 'resetGeom':
          CM.settings.popupGeom = null;
          CM.saveSettings();
          CM.showToast('小窗位置已重置', '下次打开小窗用默认位置与尺寸', 'success');
          break;
        case 'mainMenu': CM.showMainMenu(); break;
        case 'prefs': CM.api('misc.showPreferences'); break;
        case 'console': CM.api('misc.showConsole'); break;
        case 'rescan':
          CM.api('library.refresh').then(function(r) {
            if (!r || r.success === false) { CM.showToast('刷新失败', (r && r.error) || null, 'error'); return; }
            CM.showToast('媒体库缓存已刷新', null, 'success');
          });
          break;
        case 'about': CM.showAbout(); break;
        case 'copyReport':
          CM.copyText(CM.diagReport()).then(function(ok) {
            CM.showToast(ok ? '诊断报告已复制' : '复制失败', ok ? '反馈时贴这一份即可' : '可以到「关于 / 诊断」里手动复制', ok ? 'success' : 'error');
          });
          break;
        case 'help': window.open('guide.html', '_blank'); break;
        case 'advPref': CM.searchAdvancedPrefs(); break;
        case 'material':
          CM.settings.material = t.dataset.v || '';
          CM.saveSettings();
          CM.applyMaterial(CM.settings.material);
          CM.syncSettingsState();
          break;
        case 'dsppreset': {
          var dpi = parseInt(t.dataset.i, 10);
          if (!isNaN(dpi)) CM.applyDspPreset(dpi);
          break;
        }
      }
    });
  }

  function actToggle(key) {
    switch (key) {
      case 'setVisualizer':
        CM.setVisualizerActive(!CM.state.visualizerActive);
        CM.syncSettingsState();
        break;
      case 'setTilt3d':
        CM.toggleNpTilt();           // 内部会落盘 + 同步界面
        CM.syncSettingsState();
        break;
      case 'setTray':
        if (!CM.tray || !CM.tray.supported()) { CM.showToast('宿主不支持托盘', null, 'error'); return; }
        CM.tray.toggle().then(function() { CM.syncSettingsState(); });
        break;
      case 'setCursorFollow':
        if (!(CM.caps && CM.caps.has('config.setCursorFollowPlayback'))) { CM.showToast('宿主不支持该设置', null, 'error'); return; }
        CM.apiOr('config.setCursorFollowPlayback', { enabled: !CM.state.cursorFollow }).then(function(r) {
          CM.state.cursorFollow = !!(r && r.enabled);
          // 两个"跟随"同时开启会互相触发（光标跟着播放走、播放跟着光标跳），
          // 宿主文档明说通常互斥 —— 开启其中一个时把另一个写回关
          if (CM.state.cursorFollow && CM.state.playbackFollow) {
            CM.apiOr('config.setPlaybackFollowCursor', { enabled: false }).then(function() {
              CM.state.playbackFollow = false;
              CM.showToast('已关闭「播放跟随光标」', '两个跟随同时开启会互相触发、来回跳曲', null);
              CM.syncSettingsState();
            }, function() {});
          }
          CM.syncSettingsState();
        }, function(e) { CM.failToast(e, '设置失败'); });
        break;
      case 'setPlaybackFollow':
        if (!(CM.caps && CM.caps.has('config.setPlaybackFollowCursor'))) { CM.showToast('宿主不支持该设置', null, 'error'); return; }
        CM.apiOr('config.setPlaybackFollowCursor', { enabled: !CM.state.playbackFollow }).then(function(r) {
          CM.state.playbackFollow = !!(r && r.enabled);
          if (CM.state.playbackFollow && CM.state.cursorFollow) {
            CM.apiOr('config.setCursorFollowPlayback', { enabled: false }).then(function() {
              CM.state.cursorFollow = false;
              CM.showToast('已关闭「光标跟随播放」', '两个跟随同时开启会互相触发、来回跳曲', null);
              CM.syncSettingsState();
            }, function() {});
          }
          CM.syncSettingsState();
        }, function(e) { CM.failToast(e, '设置失败'); });
        break;
      case 'setHotkeysOn':
        CM.hotkeys.setEnabled(!(CM.settings.hotkeys && CM.settings.hotkeys.on));
        break;
    }
  }

  // 进入本页时渲染一次；之后每次进入只刷新状态（DOM 不重建，避免丢滚动位置）
  CM.renderSettings = function() {
    build();
    CM.syncSettingsState();
    refreshDspPresets();   // 每次进页面刷新一次：用户可能在 foobar 的 DSP 管理器里改过预设
  };

  /* ============================================
   * 高级首选项：按「显示名」搜索（只读诊断）
   * ------------------------------------------------------------
   * foobar 的高级首选项是一棵 GUID 树 —— **只能按 guid 读写**，但树里每一项都带
   * 显示名（`config.getAdvancedConfig` 的 entries[].name/guid），而
   * `config.getAdvancedConfigValue({guid})` 还会连名字和当前值一起回。
   * 所以"按名字找一项，再拿 guid 读/写"是可行的 —— 这正是主题以前认为做不到、
   * 因而搁置了某些功能（例如想关掉 foobar 自带的播放错误提示）的那一步。
   * 这里只做**只读**搜索：遍历树 → 名字含关键词 → 逐条读值 → 列出来可复制。
   * ============================================ */
  var _advEntries = null;     // 扁平化缓存：{name, guid, path}
  CM.searchAdvancedPrefs = function() {
    CM.showModal({
      title: '搜索高级首选项',
      input: '',
      desc: '按显示名搜索 foobar 高级首选项（例如「错误」「弹窗」「歌词」），只读，不会修改任何设置',
      okText: '搜索'
    }).then(function (kw) {
      if (!kw) return;
      var key = kw.toLowerCase();
      var toast = CM.showToast('正在读取高级首选项…', '首次搜索需要遍历整棵树', null);
      loadAdvancedEntries().then(function (list) {
        var hits = [];
        for (var i = 0; i < list.length && hits.length < 40; i++) {
          if (list[i].name.toLowerCase().indexOf(key) >= 0) hits.push(list[i]);
        }
        if (!hits.length) {
          CM.showToast('没有匹配项', '换个关键词试试（高级首选项的名字是 foobar 自己的语言）', 'error');
          return;
        }
        // 逐条读当前值（只读；值可能是数字/字符串/布尔）
        var vals = hits.slice(0, 12);
        Promise.all(vals.map(function (h) {
          return CM.api('config.getAdvancedConfigValue', { guid: h.guid }).then(function (r) {
            h.value = r && (r.value !== undefined ? r.value : r.data && r.data.value);
            return h;
          }, function () { return h; });
        })).then(function (rows) {
          var items = [{ isLabel: true, label: '匹配 ' + hits.length + ' 项' + (hits.length > rows.length ? '（列出前 ' + rows.length + ' 项）' : '') }];
          rows.forEach(function (h) {
            items.push({ label: h.path ? h.path + ' › ' + h.name : h.name, desc: '值：' + fmtVal(h.value) + ' · ' + h.guid });
          });
          if (hits.length > rows.length) {
            items.push({ isLabel: true, label: '其余 ' + (hits.length - rows.length) + ' 项见「复制全部结果」' });
          }
          items.push({ divider: true });
          items.push({ label: '复制全部结果', icon: CM.icons.copy, action: function () {
            var L = ['== 高级首选项搜索：' + kw + ' =='];
            hits.forEach(function (h) {
              L.push((h.path ? h.path + ' › ' : '') + h.name + ' | ' + h.guid + ' | 值：' + fmtVal(h.value));
            });
            CM.copyText(L.join('\n')).then(function (ok) {
              CM.showToast(ok ? '结果已复制' : '复制失败', ok ? hits.length + ' 项（含 GUID 与当前值）' : null, ok ? 'success' : 'error');
            });
          } });
          var rect = CM.$('tabSettings') ? CM.$('tabSettings').getBoundingClientRect() : { left: 120, top: 120 };
          CM.showCtxMenu(rect.left + 40, rect.top + 120, items);
        });
      }, function (e) {
        CM.failToast(e, '读取高级首选项失败');
      });
    });
  };
  function fmtVal(v) {
    if (v === undefined || v === null) return '（未读取）';
    if (typeof v === 'boolean') return v ? '开' : '关';
    var s = String(v);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }
  // 遍历整棵高级首选项树（首次按需拉取 + 会话内缓存）。
  // 两种可能的回包形状都兼容：① 树是嵌套的（entries[].children）；② 一次只给一层
  // （子项要按 parentGuid 再取）—— 后者才逐分支展开，节点数与展开次数都设上限。
  function loadAdvancedEntries() {
    if (_advEntries) return Promise.resolve(_advEntries);
    var MAX_NODES = 4000, MAX_EXPAND = 400, DEPTH_MAX = 8;
    var out = [], seen = Object.create(null), expanded = 0, sawChildren = false;
    function push(entries, path, depth) {
      if (!entries || !entries.length || depth > DEPTH_MAX) return;
      for (var i = 0; i < entries.length && out.length < MAX_NODES; i++) {
        var e = entries[i] || {};
        if (!e.guid || seen[e.guid]) continue;
        seen[e.guid] = 1;
        out.push({ name: e.name || '', guid: e.guid, path: path });
        if (e.children && e.children.length) {
          sawChildren = true;
          push(e.children, (path ? path + ' › ' : '') + (e.name || ''), depth + 1);
        }
      }
    }
    return CM.api('config.getAdvancedConfig').then(function (r) {
      var root = (r && (r.entries || r.items)) || [];
      if (!root.length) throw new Error('宿主没有返回高级首选项树');
      push(root, '', 0);
      if (sawChildren || out.length >= 20) { _advEntries = out; return out; }   // 树已嵌套：一层就够
      // 只给了一层：拿每个节点当分支，按 parentGuid 串行展开（去重 + 上限）
      var queue = out.slice();
      return (function step() {
        if (!queue.length || expanded >= MAX_EXPAND || out.length >= MAX_NODES) return Promise.resolve();
        var node = queue.shift();
        expanded++;
        return CM.api('config.getAdvancedConfig', { parentGuid: node.guid }).then(function (rr) {
          var kids = (rr && (rr.entries || rr.items)) || [];
          var before = out.length;
          // 子项的路径 = 父项的完整路径链（扁平形状下逐层拼出来）
          push(kids, node.path ? node.path + ' › ' + node.name : node.name, 1);
          for (var i = before; i < out.length; i++) queue.push(out[i]);
          return step();
        }, function () { return step(); });
      })().then(function () { _advEntries = out; return out; });
    });
  }

  /* ============================================
   * 音频与 DSP：预设列表与应用
   * --------------------------------------------
   * dsp.getPresets 是零参数方法（SDK: () => call(...)），多传参数会被 v2 严格校验
   * 整单拒绝；applyPreset 传 index（名称同名单一匹配首条，index 最稳）。
   * 预设 = foobar 配置目录 dsp-presets/<名称>.fb2k-dsp，应用即整链替换（只改内存）。
   * ============================================ */
  function refreshDspPresets() {
    var box = CM.$('setDspPresets');
    if (!box) return;
    if (!(CM.caps && CM.caps.has('dsp.getPresets'))) {
      box.innerHTML = '<span class="set-note">宿主不支持</span>';
      return;
    }
    CM.api('dsp.getPresets').then(function(r) {
      if (!box.isConnected) return;   // 已切走页面：别再写 DOM
      var list = (r && r.presets) || [];
      if (!list.length) {
        box.innerHTML = '<span class="set-note">还没有预设 —— 在 foobar 的 DSP 管理器里「保存预设」后这里会出现</span>';
        return;
      }
      var html = '';
      for (var i = 0; i < list.length; i++) {
        html += '<button class="set-chip' + (list[i].active ? ' on' : '') + '" data-act="dsppreset" data-i="' + list[i].index + '">' +
          (list[i].active ? '✓ ' : '') + esc(list[i].name) + '</button>';
      }
      box.innerHTML = html;
    });
  }
  CM.applyDspPreset = function(index) {
    CM.apiOr('dsp.applyPreset', { index: index }).then(function(r) {
      CM.showToast('已应用 DSP 预设', (r && r.appliedPreset) || null, 'success');
      refreshDspPresets();
    }, function(e) {
      CM.failToast(e, '应用预设失败');
    });
  };

  /* ============================================
   * 窗口材质（Win11 Mica / 亚克力）
   * --------------------------------------------
   * 材质本体（setMica / setAcrylic）与「页面背景透明」（setBackgroundTransparency，
   * 参数是 transparent 不是 enabled）是两步：**材质被平台拒绝时绝不能把页面放透明**，
   * 否则透明页面背在默认背景上会花。关闭 = 两者都显式关（enabled:false 会"去掉经
   * 它们设置的背景"）+ 恢复不透明。小窗不参与：popup 的透明在胶囊窗尝试时已实测
   * 不可用，不再碰。CSS 侧由 body.material-on 把 --bg-0/1/2 换成半透明值。
   * ============================================ */
  CM.applyMaterial = function(mode) {
    mode = (mode === 'mica' || mode === 'acrylic') ? mode : '';
    CM._materialApplied = mode;
    function paint() {
      document.body.classList.toggle('material-on', !!mode);
      document.body.classList.toggle('material-acrylic', mode === 'acrylic');
    }
    if (!(CM.caps && CM.caps.has('window.setMica'))) {
      if (mode) CM.showToast('宿主不支持窗口材质', '需要较新的 foo_ui_webview2（Win11）', 'error');
      paint();
      return Promise.resolve(false);
    }
    if (!mode) {
      return Promise.all([
        CM.api('window.setMica', { enabled: false }),
        CM.api('window.setAcrylic', { enabled: false }),
        CM.api('window.setBackgroundTransparency', { transparent: false })
      ]).then(paint);
    }
    var apply = mode === 'acrylic'
      ? CM.api('window.setAcrylic', { enabled: true, darkMode: true })
      : CM.api('window.setMica', { enabled: true, variant: 'mica', darkMode: true });
    return apply.then(function(r) {
      if (!r || r.success === false || r.enabled === false) {
        CM.showToast('窗口材质未生效', (r && (r.error || r.code)) || '平台拒绝了该效果', 'error');
        paint();
        return false;
      }
      // 材质确认应用之后才放页面背景透明（透出材质）
      return CM.api('window.setBackgroundTransparency', { transparent: true }).then(function(t) {
        if (!t || t.success === false) {
          CM.showToast('背景透明未生效', '材质可能被页面背景挡住', 'error');
        }
        paint();
        return true;
      });
    }, function(e) {
      CM.failToast(e, '窗口材质设置失败');
      paint();
      return false;
    });
  };

  /* ============================================
   * 全局热键（keyboard.registerHotkey）
   * --------------------------------------------
   * 注册是系统级的、随宿主存活：页面重载后宿主侧还留着旧注册，所以恢复时先按
   * action 前缀 'cm.' 清掉自己的旧注册再按设置重挂（按 id 注销，不动别人的）。
   * 事件 keyboard:hotkey 载荷 {id,key,action}；action 带 'cm.' 前缀避免撞名。
   * 下一首/上一首走 CM.nextTrack/prevTrack：插队队列非空时先播插队，与底栏一致。
   * ============================================ */
  CM.hotkeys = (function() {
    var KEY_PREFIX = 'cm.';
    var ids = {};   // action -> registerHotkey 回执 id（会话内）
    var ACTIONS = [
      { id: 'play_pause', label: '播放 / 暂停' },
      { id: 'next', label: '下一首' },
      { id: 'prev', label: '上一首' },
      { id: 'stop', label: '停止' }
    ];
    function labelOf(action) {
      for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].id === action) return ACTIONS[i].label;
      return action;
    }
    // 宿主的按键串解析认 Win32 风键名（方向键 = Left/Right/Up/Down），不认 e.key
    // 的 ArrowLeft 形态（2.2.0 实测 INVALID_PARAMS: Invalid key string）——
    // e.key 收来的组合在存档/注册前统一归一
    function normKeyName(key) {
      var s = String(key || '');
      return s.replace('ArrowLeft', 'Left').replace('ArrowRight', 'Right')
              .replace('ArrowUp', 'Up').replace('ArrowDown', 'Down');
    }
    // 注册失败的提示：区分两种原因 —— ① 按键串本身不合法（INVALID_PARAMS，如
    // 键名不被语法认）；② 组合被占用（宿主只给笼统错误，再查一次已注册表：同键
    // 还在列表里 = 本组件/其它窗口注册过；否则是被其它程序占了 —— 2.2.0 起
    // getRegisteredHotkeys 对被占组合能报持有者 windowId / win32Error）
    function hotkeyFailToast(key, e) {
      var kn = normKeyName(key);
      // apiOr 拒绝的对象没有 .error 字段，宿主原话在 .detail（错误原文）/ .message（人话+原文）
      var eDetail = (e && (e.detail || e.message)) || '';
      if (e && e.code === 'INVALID_PARAMS') {
        CM.showToast('热键注册失败', kn + ' · ' + (eDetail || '按键串无法解析'), 'error');
        return;
      }
      CM.api('keyboard.getRegisteredHotkeys').then(function(r) {
        if (!r) {
          // 查不到已注册表（查询本身失败）：别武断说"被其它程序占用"，亮注册的原话
          CM.showToast('热键注册失败', kn + ' · ' + (eDetail || CM.errText(e && e.code) || '注册被拒绝'), 'error');
          return;
        }
        var list = r.hotkeys || [];
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].key === kn) {
            CM.showToast('热键注册失败', kn + ' · 已被占用（' + (list[i].windowId ? '窗口 ' + list[i].windowId : '本组件') + ' 注册的同名组合）', 'error');
            return;
          }
        }
        CM.showToast('热键注册失败', kn + ' · 被其它程序占用，换一个组合试试', 'error');
      }, function() {
        CM.showToast('热键注册失败', kn + ' · ' + (eDetail || CM.errText(e && e.code) || '注册被拒绝'), 'error');
      });
    }
    function cfg() {
      if (!CM.settings.hotkeys || typeof CM.settings.hotkeys.binds !== 'object') {
        CM.settings.hotkeys = { on: false, binds: {} };
      }
      if (!CM.settings.hotkeys.binds) CM.settings.hotkeys.binds = {};
      return CM.settings.hotkeys;
    }
    function exec(action) {
      switch (action) {
        case 'cm.play_pause': CM.apiOr('playback.playOrPause').catch(function() {}); break;
        case 'cm.next': if (CM.nextTrack) CM.nextTrack(); break;
        case 'cm.prev': if (CM.prevTrack) CM.prevTrack(); break;
        case 'cm.stop': CM.apiOr('playback.stop').catch(function() {}); break;
      }
    }
    var inited = false;
    function init() {
      if (inited) return;
      inited = true;
      try {
        fb.on('keyboard:hotkey', function(e) {
          if (e && typeof e.action === 'string' && e.action.indexOf(KEY_PREFIX) === 0) exec(e.action);
        });
      } catch (e) {}
    }
    function clearOurs() {
      return CM.api('keyboard.getRegisteredHotkeys').then(function(r) {
        var list = (r && r.hotkeys) || [];
        var chain = Promise.resolve();
        for (var i = 0; i < list.length; i++) {
          (function(h) {
            if (h && h.id >= 1 && typeof h.action === 'string' && h.action.indexOf(KEY_PREFIX) === 0) {
              chain = chain.then(function() { return CM.api('keyboard.unregisterHotkey', { id: h.id }); });
            }
          })(list[i]);
        }
        return chain;
      });
    }
    function registerAll() {
      var c = cfg();
      var chain = Promise.resolve();
      for (var a in c.binds) {
        (function(action, key) {
          if (!key) return;
          chain = chain.then(function() {
            return CM.apiOr('keyboard.registerHotkey', { key: normKeyName(key), action: KEY_PREFIX + action, global: true })
              .then(function(r) { if (r && r.id != null) ids[action] = r.id; },
                    function(e) { hotkeyFailToast(key, e); });
          });
        })(a, c.binds[a]);
      }
      return chain;
    }
    function setEnabled(onState) {
      var c = cfg();
      c.on = !!onState;
      CM.saveSettings();
      ids = {};
      return clearOurs().then(function() {
        return c.on ? registerAll() : null;
      }).then(function() {
        CM.syncSettingsState();
        if (c.on) CM.showToast('全局热键已启用', '已按保存的按键注册；失败的那几条会有单独提示', 'success');
        else CM.showToast('全局热键已关闭', null, 'success');
      });
    }
    function setBind(action, key) {
      var c = cfg();
      var old = c.binds[action] || '';
      c.binds[action] = key || '';
      CM.saveSettings();
      var chain = Promise.resolve();
      if (ids[action] != null) {
        var oldId = ids[action];
        delete ids[action];
        chain = chain.then(function() { return CM.api('keyboard.unregisterHotkey', { id: oldId }); });
      }
      if (!key) {
        CM.showToast('已清除热键', labelOf(action), 'success');
        return chain.then(function() { CM.syncSettingsState(); });
      }
      if (!c.on) {
        CM.showToast('热键已记录', '打开「启用全局热键」后生效：' + key, 'success');
        return chain.then(function() { CM.syncSettingsState(); });
      }
      return chain.then(function() {
        return CM.apiOr('keyboard.registerHotkey', { key: normKeyName(key), action: KEY_PREFIX + action, global: true })
          .then(function(r) {
            if (r && r.id != null) ids[action] = r.id;
            CM.showToast('热键已设置', normKeyName(key) + ' → ' + labelOf(action), 'success');
          }, function(e) {
            c.binds[action] = old; CM.saveSettings();   // 注册失败回滚，别让设置里留着无效键
            // 旧组合刚才被注销了：能注册回去就注册回去 —— 别让一次改键失败
            // 把原本能用的热键也弄没（设置里留着旧键、宿主却没注册 = 静默失效）
            if (old && c.on) {
              CM.apiOr('keyboard.registerHotkey', { key: normKeyName(old), action: KEY_PREFIX + action, global: true })
                .then(function(r) { if (r && r.id != null) ids[action] = r.id; },
                      function() { CM.showToast('热键已失效', '原组合 ' + normKeyName(old) + ' 恢复注册失败，请重新录制一次', 'error'); });
            }
            hotkeyFailToast(key, e);
          });
      }).then(function() { CM.syncSettingsState(); });
    }
    // 捕获一次组合键：Esc 取消；无修饰键的 Delete/Backspace 清除；其它至少带 Ctrl/Alt（或 F 功能键）
    function capture(action, btn) {
      if (!btn || btn.dataset.capturing) return;
      btn.dataset.capturing = '1';
      btn.classList.add('capturing');
      btn.textContent = '按下组合键…';
      // 录制期间把全部按键留给页面（2.2.0 的页面保留键；否则按 Ctrl/Alt 组合时
      // foobar 自己绑定的快捷键也会同时触发）。录完恢复主题的常规保留列表。
      if (CM.caps.has('keyboard.setReservedKeys')) {
        CM.api('keyboard.setReservedKeys', { keys: [], all: true });
      }
      function finish() {
        delete btn.dataset.capturing;
        btn.classList.remove('capturing');
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', cancel, true);
        if (CM.caps.has('keyboard.setReservedKeys')) {
          CM.api('keyboard.setReservedKeys', { keys: (CM.RESERVED_KEYS && CM.RESERVED_KEYS.slice()) || [] });
        }
        CM.syncSettingsState();
      }
      function cancel() { finish(); }
      function onKey(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { finish(); return; }
        if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
          finish();
          setBind(action, '');
          return;
        }
        if (['Control', 'Alt', 'Shift', 'Meta'].indexOf(e.key) >= 0) return;   // 只按了修饰键，等完整组合
        var base = e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
        if (!e.ctrlKey && !e.altKey && !/^F\d{1,2}$/.test(base)) {
          CM.showToast('需要修饰键', '全局热键至少要带 Ctrl 或 Alt（避免抢掉普通按键）', 'error');
          return;
        }
        var parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Win');
        parts.push(base);
        finish();
        setBind(action, normKeyName(parts.join('+')));
      }
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', cancel, true);
    }
    return {
      ACTIONS: ACTIONS,
      // 暴露给设置页回填：老设置里存的可能是 e.key 形态（Ctrl+ArrowLeft），显示前归一
      normKeyName: normKeyName,
      restore: function() {
        if (!(CM.caps && CM.caps.has('keyboard.registerHotkey'))) return Promise.resolve(false);
        init();
        return clearOurs().then(function() {
          return cfg().on ? registerAll() : null;
        }).then(function() { return true; }, function() { return false; });
      },
      setEnabled: setEnabled,
      setBind: setBind,
      capture: capture
    };
  })();
})();
