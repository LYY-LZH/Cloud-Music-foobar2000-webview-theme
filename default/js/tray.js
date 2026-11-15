/* ============================================
 * CloudMusic tray.js — 系统托盘（常驻托盘运行）
 * 图标 / 悬停提示 / 原生播放与系统菜单行 / 最小化与关闭到托盘
 * 依赖 core.js：CM.api / CM.apiOr / CM.caps / CM.settings / CM.saveSettings
 * ============================================ */
(function() {
  'use strict';
  var CM = window.CloudMusic;
  if (!CM) return;

  var _created = false;   // 本次页面生命周期内是否已建过图标
  var _bound = false;     // 托盘事件是否已绑定

  function supported() {
    return !!(CM.caps && CM.caps.has && CM.caps.has('tray.create'));
  }

  // 悬停提示：跟随当前曲目。页面被挂起（最小化 / 藏到托盘）后 JS 不再跑，
  // 提示会停在最后一条 —— 这是可接受的，托盘菜单本身由组件原生执行。
  function tooltipText() {
    var t = CM.currentTrack;
    var name = (t && CM.trackName) ? CM.trackName(t) : '';
    if (!name) return 'CloudMusic';
    var artist = (t && CM.trackArtist) ? CM.trackArtist(t) : '';
    return artist ? ('♪ ' + artist + ' - ' + name) : ('♪ ' + name);
  }

  function pushTooltip() {
    if (!_created) return;
    CM.api('tray.setTooltip', { tooltip: tooltipText() });
  }

  // 把主窗口叫回前台。window.focus 自己就带「最小化的先还原、隐藏的先显示」，
  // 不要叠一个 window.restore —— 那会把用户特意最大化的窗口还原成普通尺寸。
  // 注意：藏到托盘后主窗口那页可能被宿主深挂起（渲染计时器冻结），本函数要等页面
  // 恢复才执行；所以托盘菜单的「显示主窗口」内置行（showSystemItems，插件原生执行）
  // 与"小窗页的托盘兜底"（js/popup.js）都要留着。
  function revealMain() {
    CM.api('window.focus');
  }

  // 左键原生显隐（插件 2.1.0 的 tray.setClickAction = toggleMainWindow）：宿主直接
  // 切换主窗口显/隐，主窗口页面深挂起也响应 —— 旧方案靠 tray:click 事件路由，
  // 主窗口那页挂起后只能靠小窗页兜底。原生模式下 tray:click 不再派发、
  // tray:doubleClick 仍广播（宿主只切换一次），JS 侧路由停用；小窗页经
  // cm:trayNative 共享键同步停用（popup.js 读它），否则双击时 JS 的兜底 focus
  // 会把刚隐藏的主窗口又叫回来。失败（旧宿主 / 面板模式）回退事件路由，不影响开关。
  var _nativeClick = false;
  function pushNativeFlag(on) {
    try {
      if (fb.sharedState && typeof fb.sharedState.set === 'function') {
        fb.sharedState.set('cm:trayNative', { on: !!on }, false, 12 * 3600 * 1000);
      }
    } catch (e) {}
  }
  function applyNativeClick() {
    if (!CM.caps.has('tray.setClickAction')) {
      // 旧宿主（含从 2.1.0 回退的情形）也要把共享键清掉：标志带 12 小时 TTL，
      // 残留的 on:true 会让小窗页压住自己的托盘兜底 focus
      pushNativeFlag(false);
      return Promise.resolve(false);
    }
    return CM.apiOr('tray.setClickAction', { action: 'toggleMainWindow' }).then(function(r) {
      _nativeClick = !!r && r.success !== false;
      pushNativeFlag(_nativeClick);
      return _nativeClick;
    }, function() { _nativeClick = false; pushNativeFlag(false); return false; });
  }

  function bindEvents() {
    if (_bound || !fb || typeof fb.on !== 'function') return;
    _bound = true;
    // 左键单击 / 双击图标 = 把主窗口叫回前台（右键由组件弹菜单，不经页面）。
    // 原生显隐接管后停用：toggle 模式下 click 不派发、doubleClick 仍广播但宿主
    // 已切换过一次，再 focus 会把刚隐藏的窗口叫回来
    fb.on('tray:click', function(e) {
      if (_nativeClick) return;
      if (e && e.button !== undefined && e.button !== 0) return;
      revealMain();
    });
    fb.on('tray:doubleClick', function() { if (!_nativeClick) revealMain(); });
    fb.on('playback:trackChanged', pushTooltip);
    fb.on('playback:stateChanged', pushTooltip);
    fb.on('playback:stopped', pushTooltip);
  }

  // 菜单只声明一个「正在播放」行；播放控制与「显示主窗口 / 退出」交给组件的
  // 内置行（showPlaybackControls / showSystemItems）—— 内置行由插件原生执行，
  // 页面深挂起时仍然可用，这正是"最小化到托盘还能控制播放"的关键。
  function applyMenu() {
    return CM.apiOr('tray.setContextMenu', {
      items: [{ type: 'nowplaying', id: 'np' }],
      config: { autoNowPlaying: true, showPlaybackControls: true, showSystemItems: true }
    });
  }

  // 最小化 / 关闭时隐藏到托盘。这两项是宿主侧行为，与图标是否创建无关，
  // 所以关闭时必须显式复位，否则会出现"窗口关了就没了、托盘里又没有图标"的死局。
  // 两个调用都走 apiOr：被宿主拒时不能吞掉 —— 否则界面说"已开启常驻托盘"，
  // 实际最小化 / 关闭的行为并没设上（同文件 disable 里对 tray.destroy 的说明）。
  function setHiddenToTray(on) {
    var chain = Promise.resolve();
    if (CM.caps.has('tray.setMinimizeToTray')) {
      chain = chain.then(function() { return CM.apiOr('tray.setMinimizeToTray', { enabled: !!on }); });
    }
    if (CM.caps.has('tray.setCloseToTray')) {
      chain = chain.then(function() { return CM.apiOr('tray.setCloseToTray', { enabled: !!on }); });
    }
    return chain;
  }

  CM.tray = {
    supported: supported,
    isOn: function() { return !!CM.settings.tray; },

    enable: function() {
      if (!supported()) {
        CM.showToast('宿主不支持托盘', '需要较新的 foo_ui_webview2', 'error');
        return Promise.resolve(false);
      }
      // 只有建图标是硬要求（失败 = 没法用）；菜单/隐藏行为失败不阻断，
      // 因为图标已建、内置菜单仍可用，只是少了个性化项。
      var ensureIcon = _created ? Promise.resolve() : CM.apiOr('tray.create', { tooltip: tooltipText() }).then(function() {
        _created = true;
      });
      return ensureIcon.then(function() {
        bindEvents();
        pushTooltip();
        return applyMenu().catch(function(e) { CM.failToast(e, '托盘菜单设置失败'); });
      }).then(function() {
        return setHiddenToTray(true);
      }).then(function() {
        // 左键交给宿主原生显隐（2.1.0+；旧宿主自动跳过并保持事件路由）
        return applyNativeClick();
      }).then(function() {
        CM.settings.tray = true;
        CM.saveSettings();
        CM.showToast('已开启常驻托盘', '最小化 / 关闭时隐藏到托盘；托盘菜单可显示窗口或退出', 'success');
        return true;
      }, function(e) {
        CM.failToast(e, '无法开启托盘');
        return false;
      });
    },

    disable: function() {
      return setHiddenToTray(false).then(function() {
        // destroy 走 apiOr：失败就保持"开着"的状态与提示一致（CM.api 会把失败吞成
        // null —— 那会出现"设置说关了、图标还在"，下次开启还会重复 tray.create）
        if (!_created) return null;
        return CM.apiOr('tray.destroy');
      }).then(function() {
        _created = false;
        // destroy 会把点击动作重置回 event 模式，共享标志同步撤掉，
        // 小窗页的托盘兜底才能重新接管
        _nativeClick = false;
        pushNativeFlag(false);
        CM.settings.tray = false;
        CM.saveSettings();
        CM.showToast('已关闭常驻托盘', '最小化 / 关闭恢复为普通行为', 'success');
        return true;
      }, function(e) {
        CM.failToast(e, '无法关闭托盘');
        return false;
      });
    },

    toggle: function() {
      return CM.tray.isOn() ? CM.tray.disable() : CM.tray.enable();
    },

    // 启动时按设置恢复；设置是关的也要把宿主侧"隐藏到托盘"复位一次，
    // 防止上一轮遗留的开关把窗口藏起来却没有图标能叫回来。
    restore: function() {
      if (!supported()) return Promise.resolve(false);
      if (CM.settings.tray) return CM.tray.enable();
      // 托盘是关的，原生点击必然也该是关的：上一轮会话（哪怕异常退出）残留的
      // 共享标志在这里清掉，小窗页的托盘兜底 focus 不会被压住
      pushNativeFlag(false);
      // 复位失败不阻断启动（这里在 boot 的 promise 链上，不能让它变成未处理的拒绝）
      return setHiddenToTray(false).then(function() { return false; }, function(e) {
        CM.failToast(e, '无法复位「隐藏到托盘」');
        return false;
      });
    }
  };
})();