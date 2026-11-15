/* ============================================
 * CloudMusic app.js — 初始化编排
 * 顺序：设置 → UI 绑定 → fb.ready → 状态同步 → 事件订阅 → 首屏渲染
 * ============================================ */
(function() {
  'use strict';
  var CM = window.CloudMusic;

  // 音量落盘防抖：拖动音量条时 playback:volumeChanged 会连发几十次，而
  // CM.saveSettings 是一次同步的 localStorage 写（整个设置 JSON）
  var saveVolumeSetting = CM.debounce(function() {
    CM.settings.volume = CM.state.volume;
    CM.saveSettings();
  }, 400);

  /* ============================================
   * 播放/暂停可视状态（图标 + 表格均衡器动画 + 任务栏）
   * ============================================ */
  function setPlayingVisual(isPlaying) {
    CM.state.playing = !!isPlaying;
    // 播放时钟插值循环随播放状态起停（暂停/停止时位置不再前进，没必要烧 rAF）
    if (isPlaying) { if (CM.startPlayhead) CM.startPlayhead(); }
    else if (CM.stopPlayhead) CM.stopPlayhead();
    CM.updatePlayPauseIcon(isPlaying);
    if (CM.publishNow) CM.publishNow(!!isPlaying);   // 小窗同步播放/暂停状态
    document.body.classList.toggle('is-playing', isPlaying);
    CM.updateTaskbarProgress();
    // 更新沉浸式唱片旋转 + 播放按钮状态
    if (CM.state.npOpen) {
      CM.updateNpVinylState();
      CM.els.npBtnPlay.classList.toggle('playing', !!isPlaying);
      CM.els.npLcPlay.classList.toggle('playing', !!isPlaying);
    }
  }

  /* ============================================
   * 曲目切换统一处理
   * ============================================ */
  function onTrackChanged(track) {
    CM.updateTrackInfo(track);
    CM.loadCurrentArtwork();
    CM.loadLyrics();
    CM.refreshLikeState();
    CM._renderQueueNow(); // 队列抽屉"正在播放"卡片
    CM.history.note(track); // 播放历史（事件栈 + cursor，见 playback-model.js）
    if (CM.publishNow) CM.publishNow(!!CM.state.playing);   // 小窗同步曲目信息
    // 如果沉浸式页面打开，重新渲染
    if (CM.state.npOpen) {
      setTimeout(function() { CM.renderNpOverlay(); }, 200);
    }
    // 同步"正在播放"标记（列表行 / 侧栏歌单徽标）
    Promise.all([
      CM.api('playback.getPlayingPlaylist'),
      CM.api('playback.getCurrentTrackIndex')
    ]).then(function(rs) {
      var pl = rs[0], ti = rs[1];
      var newPl = pl && pl.playlist != null ? pl.playlist : (pl && pl.index != null ? pl.index : -1);
      var changed = newPl !== CM.state.playingPlaylistIndex;
      CM.state.playingPlaylistIndex = newPl;
      CM.state.playingTrackIndex = ti && ti.index != null ? ti.index : -1;
      CM.refreshPlayingMarks();
      // 光标跟随播放（设置页开关）：换曲后把可视表格滚到正在播放那一行
      if (CM.state.cursorFollow && CM.scrollToPlayingRow) CM.scrollToPlayingRow();
      if (changed) CM.loadPlaylists();
    }).catch(function() { /* 静默忽略 */ });
  }

  function onStopped() {
    CM.currentTrack = null;
    if (CM.publishNow) CM.publishNow(false);   // 小窗同步"未在播放"
    CM._renderQueueNow(); // 隐藏队列抽屉"正在播放"卡片
    CM.state.playingTrackIndex = -1;
    CM.state.position = 0;
    CM.state.duration = 0;
    CM.updateTrackInfo(null);
    CM.setArtwork(null);
    // keepNp：切歌时 stopped 会短暂触发，沉浸页保持上一首歌词，避免闪一下空态
    CM.renderLyricsEmpty('暂无播放曲目', true);
    CM.updateSeekUI();
    setPlayingVisual(false);
    CM.refreshPlayingMarks();
    // 不关闭沉浸式页面 — 切歌时 stopped 会短暂触发，关闭会导致闪烁退出
  }

  /* ============================================
   * 初始状态同步（fb.ready 之后）
   * ============================================ */
  function syncInitialState() {
    CM.api('playback.getState').then(function(r) {
      if (!r) return;
      // 宿主 playback.getState 返回的是 state（'stopped'|'paused'|'playing'）——
      // SDK 自己的组件（components.global.js）与 SMP 兼容层都读这个字段；
      // isPlaying / playing 只在没有 state 的旧回包上兜底，否则加载时正在播放
      // 也会被判成"未播放"，图标与 body.is-playing 都是错的。
      var playing;
      if (r.state != null) playing = (r.state === 'playing' || r.state === 1);
      else playing = !!(r.isPlaying != null ? r.isPlaying : r.playing);
      var paused = r.isPaused != null ? r.isPaused : r.paused;
      CM.state.duration = r.duration || r.length || 0;
      CM.state.position = r.position || 0;
      // v2 的 getState 会带 canSeek（网络流多不可跳转）：不可跳转时禁用两条进度条
      if (r.canSeek != null && CM.setSeekable) CM.setSeekable(r.canSeek);
      CM.updateSeekUI();
      setPlayingVisual(!!playing && !paused);
    });
    // getState 回包里没有 duration / position（只有 state/canSeek/canPause），
    // 另外取一次进度，否则页面加载时进度条与总时长停在 0:00，要等下一次
    // stateChanged 才补上。
    CM.api('playback.getPosition').then(function(r) {
      if (!r) return;
      if (r.duration) CM.state.duration = r.duration;
      if (r.position != null && !CM.state.seeking) CM.state.position = r.position;
      CM.updateSeekUI();
      CM.updateTaskbarProgress();
    });
    CM.api('playback.getCurrentTrack').then(function(r) {
      var track = r && (r.track || (r.title || r.path ? r : null));
      if (track) onTrackChanged(track);
    });
    CM.api('playback.getVolume').then(function(r) {
      if (!r) return;
      if (r.volume != null) CM.state.volume = r.volume;
      if (r.isMuted != null) CM.state.muted = r.isMuted;
      if (CM.els.volSlider) CM.els.volSlider.value = CM.state.volume;
      CM.updateVolumeIcon();
    });
    CM.api('playback.getPlaybackOrder').then(function(r) {
      if (!r) return;
      // 宿主的 order 是序号（0..6），name 才是权威：优先按 name 认档位
      CM.state.order = CM.orderIndexOf(r.name, r.order != null ? r.order : r.index);
      CM.updateOrderIcon();
    });
    CM.api('playback.getStopAfterCurrent').then(function(r) {
      if (!r) return;
      CM.state.stopAfterCurrent = !!(r.enabled != null ? r.enabled : r.stopAfterCurrent);
      CM.updateStopAfterIcon();
    });
    CM.refreshQueueBadge();
  }

  /* ============================================
   * 事件订阅（全部事件驱动，不做轮询）
   * ============================================ */
  function subscribeEvents() {
    fb.on('playback:trackChanged', function(data) {
      var track = data && (data.track || data);
      onTrackChanged(track);
      if (CM.state.npOpen) { CM.updateNpFormat(); CM.loadNpWaveform(CM.trackPath(CM.currentTrack)); }
      setPlayingVisual(true);
    });

    fb.on('playback:stateChanged', function(data) {
      if (!data) return;
      // duration 为 0/无效时回退到 length（如部分 .aac 流 duration=0 但 length 有效）
      var dur = data.duration || data.length;
      if (dur != null) CM.state.duration = dur;
      // v2：stateChanged 每次都带 canSeek（电台流等不可跳转）
      if (data.canSeek != null && CM.setSeekable) CM.setSeekable(data.canSeek);
      // 位置交给时钟推算（无时钟时用事件值）
      if (data.position != null && !CM.state.seeking) {
        CM.applyPosition(CM.clock ? CM.nowPosition() : data.position);
      }
      if (data.state != null) setPlayingVisual(data.state === 'playing' || data.state === 1);
      else setPlayingVisual(CM.clockPlaying ? CM.clockPlaying() : !!CM.state.playing);
    });

    fb.on('playback:paused', function(data) {
      setPlayingVisual(!(data && data.paused));
    });

    // 高分辨率进度事件 — 驱动进度条 + 歌词高亮 + 任务栏进度
    // v2：位置以播放时钟为准（事件 ≈30fps 且高负载会抖），事件值只作无时钟时的回退；
    // 两次事件之间由 CM.startPlayhead 的 rAF 循环插值
    fb.on('playback:timeHighRes', function(data) {
      if (!data || data.position == null) return;
      CM.applyPosition(CM.clock ? CM.nowPosition() : data.position);
    });

    fb.on('playback:seeked', function(data) {
      if (data && data.position != null) {
        CM.state.seeking = false;
        CM.state.npSeeking = false;
        CM.applyPosition(data.position, true);
      }
      // 时钟里可能还留着跳转前的锚点：重新读一次状态与位置（异步，失败忽略）
      if (CM.clock && CM.clock.resync) {
        try { var pr = CM.clock.resync(); if (pr && pr.catch) pr.catch(function() {}); } catch (e) {}
      }
      CM.updateLyricHighlight(true);
    });

    fb.on('playback:volumeChanged', function(data) {
      if (!data) return;
      if (data.volume != null) CM.state.volume = data.volume;
      if (data.isMuted != null) CM.state.muted = data.isMuted;
      if (CM.els.volSlider) CM.els.volSlider.value = CM.state.volume;
      CM.updateVolumeIcon();
      // 拖动音量条一次会连发几十次事件：落盘防抖，避免每次都同步写一遍设置 JSON
      saveVolumeSetting();
    });

    fb.on('playback:orderChanged', function(data) {
      if (!data) return;
      CM.state.order = CM.orderIndexOf(data.name, data.order != null ? data.order : data.index);
      CM.updateOrderIcon();
    });

    fb.on('playback:stopAfterCurrentChanged', function(data) {
      CM.state.stopAfterCurrent = !!(data && data.enabled);
      CM.updateStopAfterIcon();
    });

    fb.on('playback:queueChanged', function(e) {
      // 载荷带 { origin, count }：徽标借 count 省掉一次 queue.getCount（内部先校准）
      CM.refreshQueueBadge(e);
      if (CM.state.queueOpen) CM.renderQueue();
    });

    // foobar 把曲目记为「已播放」（播满 60 秒，或播到结尾且至少播过 1/3 —— 与
    // 播放统计同一次判定）→ 播放历史里那一行打 ✓
    fb.on('playback:itemPlayed', function(track) {
      if (CM.history && CM.history.markPlayed) CM.history.markPlayed(track && (track.track || track));
    });

    // 输出设备切换（如接入解码器）会打断宿主侧的频谱计算管线，但页面仍持有旧订阅句柄，
    // 导致频谱流永久中断（直到刷新页面）。这里直接重启订阅（音频可视化模块内部另有
    // "播放中 N 秒没有帧" 的看门狗兜底）——持有者计数不受影响。
    fb.on('audio:outputDeviceChanged', function() {
      if (CM.viz && CM.viz.restart) CM.viz.restart();
    });

    fb.on('playback:stopped', onStopped);

    // 播放列表结构变化 → 刷新侧栏 + 当前列表视图
    var refreshPlaylistUI = CM.debounce(function() {
      // 歌单结构可能被外部改动（宿主界面 / 其它窗口）：上下文"路径 → 行号"映射
      // 随之行号失效，弃用快路径，下一次双击重新读回
      if (CM._ctxSynced) CM._ctxSynced = null;
      CM.loadPlaylists();
      if (CM.state.currentTab === 'playlist' && CM.state.currentPlaylistIndex >= 0) {
        CM.renderPlaylistView(CM.state.currentPlaylistIndex);
      }
    }, 200);
    ['playlist:created', 'playlist:renamed', 'playlist:removed', 'playlist:activated',
     'playlist:itemsAdded', 'playlist:itemsRemoved', 'playlist:itemsReordered'
    ].forEach(function(ev) { fb.on(ev, refreshPlaylistUI); });

    // 媒体库就绪后重绘发现页（首次启动时库可能延迟初始化）
    fb.on('library:initialized', function() {
      if (CM.state.currentTab === 'discover') CM.renderDiscover();
    });

    // 标签写入完成事件（metadata.write / removeTag 异步完成时广播）
    fb.on('metadata:writeComplete', function(e) {
      if (e && e.success) {
        // 刷新播放列表表格以显示更新后的标签
        if (CM.state.currentTab === 'playlist') CM.renderTrackTable();
      }
    });
  }

  /* ============================================
   * 启动
   * ============================================ */
  function boot() {
    CM.loadSettings();
    CM.history.init();   // 播放历史：读 localStorage + 挂「播放历史」展开按钮（默认收起，状态持久化）
    CM.state.lyricsVisible = CM.settings.lyricsVisible !== false;
    CM.state.visualizerActive = CM.settings.visualizer !== false;

    // UI 绑定（不依赖宿主，先行执行保证界面可交互）
    CM.initTitlebar();
    CM.bindNavigation();
    CM.bindDiscover();
    CM.bindPlaylistView();
    CM.bindPlaylistFilter();
    CM.bindPlaybackControls();
    CM.initSpectrumBars();
    CM.initKeyboard();
    CM.bindNpOverlay();
    CM.bindTagEditor();

    CM.setLyricsVisible(CM.state.lyricsVisible, true);
    CM.setVisualizerActive(CM.state.visualizerActive);
    CM.updateOrderIcon();
    CM.updateVolumeIcon();
    CM.updateStopAfterIcon();
    // 未播放启动：底栏 / 歌词 / 沉浸式封面先填占位图（有曲目时会被真实封面覆盖）
    CM.setArtwork(null);

    // 首屏渲染（API 失败时各渲染函数自带空态/错误态）
    CM.renderDiscover();
    var plPromise = CM.loadPlaylists();
    CM.switchTab(CM.settings.tab || 'discover');

    // 宿主就绪后：状态同步 + 事件订阅 + 宿主专属能力
    var readyFn = (typeof fb.ready === 'function') ? fb.ready.bind(fb) : function() { return Promise.resolve(); };
    readyFn().then(function() {
      CM.initClock();
      // 能力探测：拉一次宿主方法表，新功能据此显隐（失败保持"未知"，不误藏功能）
      var capsP = (CM.caps && CM.caps.init) ? CM.caps.init() : Promise.resolve();
      // 常驻托盘：等能力表回来再按设置恢复（旧宿主上 supported() 为假，自动跳过）
      capsP.then(function() {
        if (CM.tray && CM.tray.restore) CM.tray.restore();
        // 窗口材质与全局热键同样依赖能力表（旧宿主自动跳过），各自恢复持久化状态
        if (CM.applyMaterial && CM.settings.material) CM.applyMaterial(CM.settings.material);
        if (CM.hotkeys && CM.hotkeys.restore) CM.hotkeys.restore();
        // 插件 2.2.0 起：页面聚焦时含 Ctrl/Alt/Win 的组合先走 foobar 自己的快捷键
        // 绑定 —— 把主题用到的组合登记为「页面保留键」，不与用户的 foobar 快捷键互抢
        // （保留列表随页面重载清空，boot 重挂；录制热键期间临时 all:true，见 ui-settings）
        if (CM.caps.has('keyboard.setReservedKeys')) {
          // 键名是宿主侧语法（Win32 风）：方向键写作 Left/Up，不认 e.key 的 ArrowLeft
          CM.RESERVED_KEYS = ['Ctrl+Left', 'Ctrl+Right', 'Alt+Up', 'Alt+Down'];
          CM.api('keyboard.setReservedKeys', { keys: CM.RESERVED_KEYS });
        }
        // 两个「跟随」同时开启会互相触发（光标跟着播放走、播放跟着光标跳，宿主文档
        // 明说通常互斥）—— 启动读到同时开启时自动关掉「播放跟随光标」并提示一次，
        // 否则表现为"播着播着自己乱跳"
        if (CM.caps.has('config.getCursorFollowPlayback')) {
          CM.api('config.getCursorFollowPlayback').then(function(rc) {
            CM.state.cursorFollow = !!(rc && rc.enabled);
            return CM.api('config.getPlaybackFollowCursor').then(function(rp) {
              CM.state.playbackFollow = !!(rp && rp.enabled);
              if (CM.state.cursorFollow && CM.state.playbackFollow) {
                return CM.apiOr('config.setPlaybackFollowCursor', { enabled: false }).then(function() {
                  CM.state.playbackFollow = false;
                  CM.showToast('已关闭「播放跟随光标」', '它与「光标跟随播放」同时开启会互相触发、来回跳曲', null);
                });
              }
            });
          }).catch(function() {});
        }
      });
      // 缩放比变化（换显示器 / 改系统缩放 / 页面缩放）——供依赖 DPR 的布局重算
      if (CM.watchDpi) CM.watchDpi();
      syncInitialState();
      subscribeEvents();
      if (CM.bindPopupTracking) CM.bindPopupTracking();   // 小窗的形态/几何回报
      CM.initDragDrop();
      CM.initTaskbar();
      // 宿主可能晚于本页注入（SDK checkAvailability 轮询可达 5 秒）：boot 时
      // startSpectrum 会因 fb 不可用静默跳过，就绪后补一次（内部幂等）
      if (CM.state.visualizerActive) CM.startSpectrum();
      // 打开”上次听歌的歌单”：优先按 v2 的 playlist guid 恢复（改名/挪位也能命中），
      // guid 失效时退回按名称，都没有则退回活跃歌单
      plPromise.then(function() {
        var saved = CM.settings.lastPlaylist;
        var target = -1;
        if (CM.settings.rememberGuid) target = CM.playlistIndexByGuid(CM.settings.rememberGuid);
        if (target < 0 && saved) {
          var lists = CM.playlists || [];
          for (var i = 0; i < lists.length; i++) {
            if (lists[i].name === saved) { target = lists[i].index; break; }
          }
        }
        // 侧栏不显示的内部歌单（上下文容器 / 宿主的 [WebView Queue]）不该被自动打开：
        // 记着它们的时候退回活动歌单
        if (target >= 0 && CM.isInternalPlaylist(CM.playlistRow(target))) target = -1;
        CM.api('playlist.getActive').then(function(r) {
          var idx = r && (r.index != null ? r.index : r.playlist);
          var use = target >= 0 ? target : (idx != null && idx >= 0 ? idx : target);
          if (use >= 0) {
            CM.state.currentPlaylistIndex = use;
            CM.loadPlaylists(); // 刷新侧栏”当前歌单”高亮
            if (CM.state.currentTab === 'playlist') CM.renderPlaylistView(use);
          } else if (CM.state.currentTab === 'playlist' && CM.renderPlaylistEmptyState) {
            // 一张歌单都没有（或没恢复出任何一张）：给引导空态而不是空白
            CM.renderPlaylistEmptyState();
          }
        });
      });
    }).catch(function() {
      // 宿主桥接未就绪，以受限模式运行
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
