/* ============================================
 * CloudMusic controls.js — 交互事件绑定
 * 播放控制 / 进度音量 / 频谱 / 队列 / 更多菜单
 * 拖放 / 键盘快捷键 / 任务栏
 * ============================================ */
(function() {
  'use strict';
  var CM = window.CloudMusic;
  var els = CM.els, state = CM.state;


  /* ============================================
   * 导航 / Tab
   * ============================================ */
  CM.bindNavigation = function() {
    document.querySelectorAll('.nav-item[data-tab]').forEach(function(el) {
      el.addEventListener('click', function() { CM.switchTab(el.dataset.tab); });
      el.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          // 阻止冒泡到全局快捷键：聚焦导航项按空格只切标签，
          // 不再叠加触发底栏的播放/暂停
          e.stopPropagation();
          CM.switchTab(el.dataset.tab);
        }
      });
    });

    /* 在线音源折叠分组：收起时导航回到原本 4 项的高度，「我的歌单」不被挤下去。
       表头点击 / 回车 / 空格展开收起，展开状态记忆在 settings；
       切到 qqmusic / netease（含顶部 main-tabs 的切换）时自动展开，
       避免激活项藏在收起组里 —— 自动展开只改 UI，不覆盖用户的收起偏好。 */
    var navGroup = document.getElementById('navOnlineGroup');
    var navSub = document.getElementById('navOnlineSub');
    function setOnlineGroup(open, persist) {
      if (!navGroup || !navSub) return;
      navSub.hidden = !open;
      navGroup.classList.toggle('open', open);
      navGroup.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (persist) { CM.settings.onlineNavOpen = open; CM.saveSettings(); }
    }
    if (navGroup && navSub) {
      setOnlineGroup(!!CM.settings.onlineNavOpen, false);      // 启动恢复：只同步 UI
      navGroup.addEventListener('click', function() { setOnlineGroup(navSub.hidden, true); });
      navGroup.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();      // 与导航项同款：别叠加触发底栏的播放/暂停
          setOnlineGroup(navSub.hidden, true);
        }
      });
      var _switchTabNav = CM.switchTab;
      CM.switchTab = function(tab) {
        if (tab === 'qqmusic' || tab === 'netease' || tab === 'bilibili') setOnlineGroup(true, false);
        _switchTabNav.apply(this, arguments);
      };
    }

    document.querySelectorAll('.main-tab[data-tab]').forEach(function(el) {
      el.addEventListener('click', function() { CM.switchTab(el.dataset.tab); });
    });

    // 侧栏搜索 → 跳到搜索页
    els.sidebarSearch.addEventListener('input', function() {
      els.sidebarSearchWrap.classList.toggle('has-text', !!els.sidebarSearch.value);
    });
    els.sidebarSearch.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && els.sidebarSearch.value.trim()) {
        CM.switchTab('search');
        els.searchInput.value = els.sidebarSearch.value;
        CM.doSearch(els.searchInput.value);
      }
    });
    els.sidebarSearchClear.addEventListener('click', function() {
      els.sidebarSearch.value = '';
      els.sidebarSearchWrap.classList.remove('has-text');
      els.sidebarSearch.focus();
    });

    // 搜索页输入（防抖）
    els.searchInput.addEventListener('input', CM.debounce(function() {
      CM.doSearch(els.searchInput.value);
    }, 350));

    // 搜索联想：library.getFieldValues 的会话内缓存 + 输入下拉（fixed 定位挂在 body，
    // 不受搜索页滚动容器裁剪）。缓存随媒体库变更失效（ui-library 的常驻监听会调
    // CM.invalidateSearchSuggest）；取值失败不缓存，下次输入重试。
    var _sugCache = null;
    CM.invalidateSearchSuggest = function() { _sugCache = null; };
    function sugEnsure() {
      if (_sugCache) return _sugCache;
      _sugCache = Promise.all([
        CM.api('library.getFieldValues', { field: 'artist', limit: 5000 }),
        CM.api('library.getFieldValues', { field: 'album', limit: 5000 }),
        CM.api('library.getFieldValues', { field: 'genre', limit: 5000 })
      ]).then(function(rs) {
        function pick(r) {
          return (r && r.success !== false && Array.isArray(r.values)) ? r.values.filter(function(v) { return v && v.name; }) : [];
        }
        return { artist: pick(rs[0]), album: pick(rs[1]), genre: pick(rs[2]) };
      }, function() {
        _sugCache = null;
        return { artist: [], album: [], genre: [] };
      });
      return _sugCache;
    }
    var sugBox = null;
    function sugHide() { if (sugBox) { sugBox.hidden = true; sugBox.innerHTML = ''; } }
    function sugShow(q) {
      sugEnsure().then(function(cache) {
        // 取值期间输入又变了：这次联想作废，别拿旧关键词的结果盖住新输入
        if (els.searchInput.value.trim() !== q) return;
        var key = q.toLowerCase();
        var TYPES = [['artist', '艺人'], ['album', '专辑'], ['genre', '流派']];
        var hits = [];
        for (var t = 0; t < TYPES.length && hits.length < 24; t++) {
          var arr = cache[TYPES[t][0]];
          for (var i = 0; i < arr.length; i++) {
            var nm = arr[i].name;
            var at = nm.toLowerCase().indexOf(key);
            if (at < 0) continue;
            hits.push({ name: nm, count: arr[i].trackCount || 0, type: TYPES[t][1], rank: at === 0 ? 0 : 1 });
            if (hits.length >= 24) break;
          }
        }
        // 前缀命中排前，同档按曲目数（getFieldValues 本身就按曲目数降序，稳定复用）
        hits.sort(function(a, b) { return a.rank - b.rank || b.count - a.count; });
        hits = hits.slice(0, 8);
        if (!hits.length) { sugHide(); return; }
        if (!sugBox) {
          sugBox = document.createElement('div');
          sugBox.className = 'search-suggest';
          sugBox.hidden = true;
          document.body.appendChild(sugBox);
          sugBox.addEventListener('mousedown', function(e) {
            var it = e.target.closest('.search-suggest-item');
            if (!it) return;
            e.preventDefault();   // 点候选不让 input 失焦
            els.searchInput.value = it.dataset.q;
            CM.doSearch(it.dataset.q);
            sugHide();
          });
          // 点外关闭（mousedown 捕获，早于 blur）
          document.addEventListener('mousedown', function(e) {
            if (!sugBox || sugBox.hidden) return;
            if (e.target === els.searchInput || sugBox.contains(e.target)) return;
            sugHide();
          }, true);
        }
        var html = '';
        for (var h = 0; h < hits.length; h++) {
          html += '<div class="search-suggest-item" data-q="' + CM.escHtml(hits[h].name) + '">' +
            '<span class="search-suggest-type">' + hits[h].type + '</span>' +
            '<span>' + CM.escHtml(hits[h].name) + '</span>' +
            '<span class="search-suggest-count">' + hits[h].count + ' 首</span></div>';
        }
        sugBox.innerHTML = html;
        var rect = els.searchInput.getBoundingClientRect();
        sugBox.style.left = rect.left + 'px';
        sugBox.style.top = (rect.bottom + 6) + 'px';
        sugBox.style.width = Math.max(rect.width, 260) + 'px';
        sugBox.hidden = false;
      });
    }
    els.searchInput.addEventListener('input', CM.debounce(function() {
      var q = els.searchInput.value.trim();
      if (!q) { sugHide(); return; }
      sugShow(q);
    }, 220));
    els.searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') sugHide();
    });

    // 新建歌单
    els.addPlaylistBtn.addEventListener('click', function() {
      CM.showModal({ title: '新建歌单', input: '', okText: '创建' }).then(function(name) {
        if (!name) return;
        // 写操作走 apiOr：重名 / 被拒时用户得知道为什么，不能只是"点了没反应"
        CM.apiOr('playlist.create', { name: name }).then(function() {
          CM.showToast('已创建歌单', name, 'success');
        }, function(e) { CM.failToast(e, '无法创建歌单'); });
      });
    });
  };

  /* ============================================
   * 发现页按钮
   * ============================================ */
  CM.bindDiscover = function() {
    els.btnPlayDaily.addEventListener('click', function() { CM.playDaily(); });
    els.btnRefreshDiscover.addEventListener('click', function() { CM.renderDiscover(); });
    els.refreshRandom.addEventListener('click', function() { CM.renderDiscoverRandom(); });
    els.moreAlbums.addEventListener('click', function() {
      CM.openLibraryDetail('albums', null);
    });
    els.moreRecent.addEventListener('click', function() {
      CM.openLibraryDetail('stats', null);
    });
  };

  /* ============================================
   * 播放列表页按钮 / 表头排序
   * ============================================ */
  CM.bindPlaylistView = function() {
    els.btnPlayAll.addEventListener('click', function() {
      if (state.currentPlaylistIndex < 0) return;
      // 播放全部 = 切播放上下文：该歌单成为活动歌单并从第一首开播，插队队列清空
      CM.playRow({ playlist: state.currentPlaylistIndex, index: 0 });
    });
    els.btnPlaylistMore.addEventListener('click', function(e) {
      e.stopPropagation();
      var rect = els.btnPlaylistMore.getBoundingClientRect();
      var idx = state.currentPlaylistIndex;
      if (idx < 0) return;
      // 自动歌单/锁定歌单不接受手动编辑：隐藏 添加/排序/撤销 等操作
      var pl = (CM.playlists || []).find(function(p) { return p.index === idx; }) || {};
      var editable = !pl.isAutoplaylist && !pl.isLocked;
      var items = [
        { isLabel: true, label: '添加到歌单' }
      ];
      // 歌单结构类写操作（随机 / 排序）：成功报一句、失败按错误码归因
      function plWrite(failTitle, okMsg, method, params) {
        CM.apiOr(method, params).then(function() {
          CM.showToast(okMsg, null, 'success');
        }, function(e) { CM.failToast(e, failTitle); });
      }
      if (editable) {
        items.push({ label: '添加本地文件', icon: CM.icons.folder, action: function() {
          CM.addFilesToPlaylist(idx);
        } });
        items.push({ label: '添加文件夹', icon: CM.icons.folder, action: function() {
          CM.addFolderToPlaylist(idx);
        } });
        items.push({ label: '添加网络地址', icon: CM.icons.plus, action: function() {
          CM.addUrlToPlaylist(idx);
        } });
        items.push({ divider: true });
        // 歌单结构类写操作统一走 apiOr + 失败归因提示：用了 CM.api 的话，
        // 被宿主拒（锁定 / 索引失效）时只是"点了没反应"，界面上查不出原因
        items.push({ label: '随机排列', icon: CM.icons.refresh, action: function() {
          plWrite('无法随机排列', '已随机排列', 'playlist.shuffle', { playlist: idx });
        } });
        items.push({ label: '按标题排序', action: function() {
          plWrite('无法排序', '已按标题排序', 'playlist.sort', { playlist: idx, pattern: '%title%' });
        } });
        items.push({ label: '按艺术家排序', action: function() {
          plWrite('无法排序', '已按艺术家排序', 'playlist.sort',
            { playlist: idx, pattern: '%artist% | %album% | %tracknumber%' });
        } });
        items.push({ label: '反转列表', icon: CM.icons.reverse, action: function() {
          plWrite('无法反转列表', '已反转列表顺序', 'playlist.reverse', { playlist: idx });
        } });
        items.push({ divider: true });
        items.push({ label: '撤销上一步', action: function() {
          // NOT_FOUND = 没有可撤销的历史：如实提示，别装作成功（写操作走 apiOr）
          CM.apiOr('playlist.undo', { playlist: idx }).then(function() {
            CM.showToast('已撤销', null, 'success');
          }, function(e) { CM.failToast(e, '无法撤销'); });
        } });
        items.push({ label: '重做', action: function() {
          CM.apiOr('playlist.redo', { playlist: idx }).then(function() {
            CM.showToast('已重做', null, 'success');
          }, function(e) { CM.failToast(e, '无法重做'); });
        } });
      }
      CM.showCtxMenu(rect.left, rect.bottom + 6, items);
    });
    // 表头点击排序（客户端视图排序）
    els.trackTable.querySelectorAll('thead th[data-sort]').forEach(function(th) {
      th.addEventListener('click', function() {
        var key = th.dataset.sort;
        if (state.sortKey === key) {
          if (state.sortAsc) { state.sortAsc = false; }
          else { state.sortKey = null; state.sortAsc = true; } // 第三次点击取消排序
        } else {
          state.sortKey = key; state.sortAsc = true;
        }
        CM.renderTrackTable();
      });
    });
  };

  /* ============================================
   * 位置驱动（事件 + 播放时钟两条来源共用）
   * ============================================ */
  var _lastAppliedPos = -1;
  CM.applyPosition = function(pos, force) {
    if (typeof pos !== 'number' || !isFinite(pos)) return;
    _lastAppliedPos = pos;
    if (!state.seeking) { state.position = pos; CM.updateSeekUI(); }
    CM.updateLyricHighlight(force);
    CM.updateTaskbarProgress();
    if (state.npOpen) {
      if (!state.npSeeking) CM.updateNpSeekUI();
      CM.updateNpLyricHighlight(force);
    }
  };

  // 播放时钟插值循环：只在"正在播放 + 页面可见"时跑，位置变化不足 1/20 秒就跳过。
  // 宿主 ~30fps 的事件路径仍然照常更新，这里补的是两次事件之间的平滑
  //（负载高时事件会抖/掉，进度条与歌词高亮就会一跳一跳）。
  CM.startPlayhead = function() {
    if (CM._playheadRaf || !CM.clock) return;
    var step = function() {
      CM._playheadRaf = requestAnimationFrame(step);
      if (!CM.clock || document.hidden) return;
      if (!CM.clockPlaying()) return;
      var p = CM.nowPosition();
      if (p < 0) return;
      if (Math.abs(p - _lastAppliedPos) < 0.05) return;
      CM.applyPosition(p);
    };
    CM._playheadRaf = requestAnimationFrame(step);
  };
  CM.stopPlayhead = function() {
    if (CM._playheadRaf) { cancelAnimationFrame(CM._playheadRaf); CM._playheadRaf = 0; }
  };

  /* ============================================
   * 通用 seekbar 绑定（主进度条 + 沉浸式进度条共用）
   * ============================================ */
  // v2：playback.getState / playback:stateChanged 会带 canSeek（电台等网络流为 false）。
  // false 时把两条进度条一起禁用，避免拖了没有任何反应的"假交互"。
  CM._seekBars = [];
  CM.setSeekable = function(canSeek) {
    state.canSeek = canSeek !== false;
    CM._seekBars.forEach(function(bar) {
      if (!bar) return;
      bar.disabled = !state.canSeek;
      // 类名要与标记一致：主进度条外层是 .seek-bar-wrap、沉浸页是 .np-seek-rail
      // （此前写的 .seekbar-wrap/.np-seekbar-wrap 两个都不存在 → 禁用态没有视觉反馈）
      var wrap = bar.closest ? bar.closest('.seek-bar-wrap, .np-seek-rail') : null;
      if (wrap) wrap.classList.toggle('seek-disabled', !state.canSeek);
      bar.title = state.canSeek ? '' : '当前曲目不可跳转（网络流 / 直播）';
    });
  };

  CM.bindSeekBar = function(bar, timeLabel, cssVar, seekingKey, updateFn) {
    CM._seekBars.push(bar);
    bar.addEventListener('input', function() {
      if (!state.canSeek) return;
      state[seekingKey] = true;
      var pct = bar.value / 1000;
      bar.style.setProperty(cssVar, (pct * 100).toFixed(2) + '%');
      timeLabel.textContent = CM.formatTime(pct * state.duration);
    });
    bar.addEventListener('change', function() {
      if (!state.canSeek) { state[seekingKey] = false; updateFn(); return; }
      var pct = bar.value / 1000;
      var target = pct * state.duration;
      // 不在此处更新 state.position，交给 playback:seeked / timeHighRes 事件统一处理，
      // 避免因 API 返回 undefined/null 时误把旧位置覆盖掉 seeked 事件已写入的正确位置。
      // v2 起参数名是 position：旧的 seconds 属于未声明键，会被严格校验整个拒掉（INVALID_PARAMS）
      CM.api('playback.setPosition', { position: target }).then(function(r) {
        state[seekingKey] = false;
        if (r && r.success === false) CM.showToast('跳转失败', r.error || null, 'error');
        updateFn();
      });
    });
  };

  /* ============================================
   * 底栏播放控制
   * ============================================ */
  CM.bindPlaybackControls = function() {
    els.btnPlayPause.addEventListener('click', function() { CM.api('playback.playOrPause'); });
    // 上一首/下一首走双轨制（playback-model.js）：下一首优先播插队队首，
    // 上一首优先回溯播放历史，历史没有才交回宿主
    els.btnPrev.addEventListener('click', function() { CM.prevTrack(); });
    els.btnNext.addEventListener('click', function() { CM.nextTrack(); });

    // 播放顺序：单按钮循环 顺序→列表循环→单曲循环→随机
    els.btnOrder.addEventListener('click', function() {
      var next = CM.ORDERS[(state.order + 1) % CM.ORDERS.length];
      // 用 name 下发（宿主的 order 是序号 0..6，不是 foobar 标志位；名字不随序号表变）
      CM.api('playback.setPlaybackOrder', { name: next.host }).then(function(r) {
        // SDK v1.13 错误信封是正常 resolve 的 {success:false}（真值）：只判 !r
        // 会把失败当成功 —— 图标翻转、提示成功，实际顺序没变
        if (!r || r.success === false) { CM.showToast('切换失败', (r && r.error) || null, 'error'); return; }
        state.order = CM.orderIndexOf(next.host);
        CM.updateOrderIcon();
        CM.showToast(next.name, null);
      });
    });

    // 播完当前停止
    els.btnStopAfter.addEventListener('click', function() {
      CM.api('playback.toggleStopAfterCurrent').then(function(r) {
        if (r && r.enabled !== undefined) state.stopAfterCurrent = !!r.enabled;
        else if (r && r.success !== false) state.stopAfterCurrent = !state.stopAfterCurrent;
        else { CM.showToast('操作失败', null, 'error'); return; }
        CM.updateStopAfterIcon();
        CM.showToast(state.stopAfterCurrent ? '将在当前曲目播完后停止' : '已取消单曲停止', null);
      });
    });

    // 喜欢 = 评分 5 星 + 追加进「我喜欢的音乐」歌单（只写评分的旧做法在界面上看不见）
    // 走 CM.setRating：曲目右键的「评分 ▸」也是同一条路，5 星都进歌单
    els.likeBtn.addEventListener('click', function() {
      var path = CM.trackPath(CM.currentTrack);
      if (!path) return;
      var liked = els.likeBtn.classList.contains('liked');
      var name = CM.trackName(CM.currentTrack);
      CM.setRating(path, liked ? 0 : 5).then(function(res) {
        els.likeBtn.classList.toggle('liked', res.rating >= 5);
        if (liked) {
          if (res.liked === 'error') {
            // 评分已经清了，但歌单里那行没删掉：如实说，别让用户以为已经移出
            CM.showToast('已清除评分，但没能从「我喜欢的音乐」移出', (res.error && res.error.message) || null, 'error');
            return;
          }
          CM.showToast('已取消喜欢',
                       res.liked === 'kept' ? '正在播放的这一首暂时留在歌单里，切歌后再取消一次即可移除' : null);
        } else if (res.liked === 'error') {
          // 评分已经写成功：歌单没跟上要单独说清楚，否则用户以为"点了喜欢没反应"
          CM.showToast('已评分，但没能加入「我喜欢的音乐」', (res.error && res.error.message) || null, 'error');
        } else {
          CM.showToast(res.liked === 'exists' ? '已在「我喜欢的音乐」里' : '已添加到「我喜欢的音乐」', name,
                       res.liked === 'exists' ? null : 'success');
        }
      }, function(e) {
        CM.showToast('没能标记喜欢', (e && e.message) || null, 'error');
      });
    });

    // 进度条
    CM.bindSeekBar(els.seekBar, els.seekCurrent, '--seek-pct', 'seeking', CM.updateSeekUI);

    // 音量
    els.volSlider.addEventListener('input', function() {
      var v = parseInt(els.volSlider.value, 10);
      state.volume = v;
      state.muted = false;
      els.volSlider.style.setProperty('--vol-pct', v + '%');
      CM.api('playback.setVolume', { volume: v });
      CM.updateVolumeIcon();
    });
    els.volBtn.addEventListener('click', function() { CM.api('playback.toggleMute'); });
    // 音量滚轮微调
    els.volBtn.parentElement.addEventListener('wheel', function(e) {
      e.preventDefault();
      var v = Math.max(0, Math.min(100, state.volume + (e.deltaY < 0 ? 5 : -5)));
      state.volume = v; state.muted = false;
      CM.api('playback.setVolume', { volume: v });
      CM.updateVolumeIcon();
    }, { passive: false });

    // 队列抽屉
    els.btnQueue.addEventListener('click', function() { CM.toggleQueue(); });
    els.queueClose.addEventListener('click', function() { CM.toggleQueue(false); });
    els.queueClear.addEventListener('click', function() {
      CM.api('queue.clear').then(function(r) {
        // 失败（回执为空或错误信封）要如实提示，不能照常弹"已清空"
        if (!r || r.success === false) { CM.showToast('清空失败', (r && r.error) || null, 'error'); return; }
        CM.renderQueue();
        CM.refreshQueueBadge();
        CM.showToast('已清空插队队列', null);
      });
    });
    // 播放历史面板的展开按钮 / 清空按钮由 playback-model.js 的 CM.history.init() 绑定（随启动执行）

    // 歌词面板开关
    els.btnLyricsToggle.addEventListener('click', function() {
      CM.setLyricsVisible(!state.lyricsVisible);
    });
    // 底栏封面：单击展开歌词面板，双击进入沉浸式模式
    var artClickTimer = null;
    els.bottomArtWrap.addEventListener('click', function() {
      if (artClickTimer) {
        clearTimeout(artClickTimer);
        artClickTimer = null;
        CM.toggleNpOverlay(true);
      } else {
        artClickTimer = setTimeout(function() {
          artClickTimer = null;
          if (!state.lyricsVisible) CM.setLyricsVisible(true);
        }, 250);
      }
    });

    // 频谱开关
    els.btnVisualizer.addEventListener('click', function() {
      CM.setVisualizerActive(!state.visualizerActive);
    });

    // 更多菜单
    els.btnMore.addEventListener('click', function(e) {
      e.stopPropagation();
      CM.toggleMorePopover();
    });
    document.addEventListener('mousedown', function(e) {
      if (els.morePopover.classList.contains('open') &&
          !els.morePopover.contains(e.target) && e.target !== els.btnMore && !els.btnMore.contains(e.target)) {
        els.morePopover.classList.remove('open');
      }
      if (els.rgPopover.classList.contains('open') &&
          !els.rgPopover.contains(e.target) && e.target !== els.btnMore && !els.btnMore.contains(e.target)) {
        els.rgPopover.classList.remove('open');
      }
    });
  };

  /* ============================================
   * 更多菜单（Popover）
   * ============================================ */
  // Popover 一次构建 + 状态更新（避免每次打开重建 innerHTML + 重绑监听器）
  var popoverBuilt = false;
  function buildMorePopover() {
    if (popoverBuilt) return;
    popoverBuilt = true;
    var pop = els.morePopover;
    // 分区顺序沿用旧版菜单（歌词 → 窗口 → 音频 → foobar2000），新项落进各自的区：
    // 小窗是窗口形态、放「窗口」，低频项搬进「设置与工具」页后「foobar2000」只剩主菜单与它。
    // 长内容一律折叠：桌面歌词、小窗、音频三组各收成一个可展开的组（点标题展开/收起），
    // 默认收起，菜单打开时只看到分区骨架。
    pop.innerHTML =
      '<div class="popover-section">' +
      '<div class="popover-label">歌词</div>' +
      // 桌面歌词：ESLyric 的四个命令收进折叠组（状态由 syncEslyricStates 回填）
      '<button class="pop-sub-header" id="popSubDesktop">' + CM.icons.desktopLyric + '<span>桌面歌词</span><span class="pop-sub-arrow">▶</span></button>' +
      '<div class="pop-sub-body" id="popSubDesktopBody">' +
        '<button class="pop-sub-item" id="popDesktopLyricShow">' + CM.icons.desktopLyric + '<span>显示</span><span class="pop-item-note" id="popDesktopLyricNote"></span></button>' +
        '<button class="pop-sub-item" id="popDesktopLyricPin" disabled>' + CM.icons.pin + '<span>置顶</span><span class="pop-item-note" id="popDesktopLyricPinNote"></span></button>' +
        '<button class="pop-sub-item" id="popDesktopLyricLock" disabled>' + CM.icons.lock + '<span>锁定</span><span class="pop-item-note" id="popDesktopLyricLockNote"></span></button>' +
        '<button class="pop-sub-item" id="popDesktopLyricReset">' + CM.icons.refresh + '<span>重置位置</span></button>' +
      '</div>' +
      '</div>' +
      '<div class="popover-section">' +
      '<div class="popover-label">窗口</div>' +
      // 小窗：两种形态收进折叠组
      '<button class="pop-sub-header" id="popSubPopup">' + CM.icons.desktopLyric + '<span>小窗</span><span class="pop-sub-arrow">▶</span></button>' +
      '<div class="pop-sub-body" id="popSubPopupBody">' +
        '<button class="pop-sub-item" id="popPopupMini">' + CM.icons.desktopLyric + '<span>迷你播放器</span><span class="pop-item-note">胶囊</span></button>' +
        '<button class="pop-sub-item" id="popPopupLyrics">' + CM.icons.note + '<span>歌词窗（竖版）</span><span class="pop-item-note">竖版</span></button>' +
      '</div>' +
      '<button class="pop-item" id="popRefresh">' + CM.icons.refresh + '<span>刷新界面</span></button>' +
      '</div>' +
      '<div class="popover-section">' +
      // 音频没有分区小标签：折叠组的标题就是分区名，再挂一个「音频」标签是重复的
      '<button class="pop-sub-header" id="popSubAudio">' + CM.icons.eq + '<span>音频</span><span class="pop-sub-arrow">▶</span></button>' +
      '<div class="pop-sub-body" id="popSubAudioBody">' +
        '<button class="pop-sub-item" id="popEQ">' + CM.icons.eq + '<span>均衡器</span><span class="pop-item-note" id="popEQNote"></span></button>' +
        '<button class="pop-sub-item" id="popOutput">' + CM.icons.output + '<span>输出设备</span><span class="pop-item-note" id="popOutputNote"></span></button>' +
        '<button class="pop-sub-item" id="popRG">' + CM.icons.eq + '<span>播放增益</span><span class="pop-item-note" id="popRGNote"></span></button>' +
      '</div>' +
      '</div>' +
      '<div class="popover-section">' +
      '<div class="popover-label">foobar2000</div>' +
      '<button class="pop-item" id="popMainMenu">' + CM.icons.menu + '<span>主菜单</span><span class="pop-item-note">全部命令</span></button>' +
      '<button class="pop-item" id="popSettings">' + CM.icons.gear + '<span>设置与工具</span><span class="pop-item-note">›</span></button>' +
      '</div>';
    // 绑定一次，永久有效
    function closePop() { pop.classList.remove('open'); }
    // 折叠组：点标题展开/收起（沿用旧版那套 class，箭头随之旋转）
    function toggleSubMenu(headerId, bodyId) {
      var header = CM.$(headerId);
      var body = CM.$(bodyId);
      if (!header || !body) return;
      var isOpen = header.classList.toggle('open');
      body.classList.toggle('open', isOpen);
    }
    CM.$('popSubPopup').addEventListener('click', function() { toggleSubMenu('popSubPopup', 'popSubPopupBody'); });
    CM.$('popSubDesktop').addEventListener('click', function() { toggleSubMenu('popSubDesktop', 'popSubDesktopBody'); });
    CM.$('popSubAudio').addEventListener('click', function() { toggleSubMenu('popSubAudio', 'popSubAudioBody'); });
    // 小窗
    CM.$('popPopupMini').addEventListener('click', function() { CM.openPopupWindow('mini'); closePop(); });
    CM.$('popPopupLyrics').addEventListener('click', function() { CM.openPopupWindow('lyrics'); closePop(); });
    // 桌面歌词（ESLyric）：显示 / 置顶 / 锁定 / 重置位置；勾选状态由 syncEslyricStates 异步回填
    CM.$('popDesktopLyricShow').addEventListener('click', function() { CM.toggleDesktopLyric(); });
    CM.$('popDesktopLyricPin').addEventListener('click', function() { CM.toggleDesktopLyricPin(); });
    CM.$('popDesktopLyricLock').addEventListener('click', function() { CM.toggleDesktopLyricLock(); });
    CM.$('popDesktopLyricReset').addEventListener('click', function() { CM.execDesktopLyricReset(); });
    // 音频
    CM.$('popEQ').addEventListener('click', function() { CM.toggleEQ(); closePop(); });
    CM.$('popOutput').addEventListener('click', function() { CM.showOutputDevices(); closePop(); });
    CM.$('popRG').addEventListener('click', function() { closePop(); CM.toggleRgPopover(); });
    // 主题
    CM.$('popMainMenu').addEventListener('click', function() { closePop(); CM.showMainMenu(); });
    CM.$('popSettings').addEventListener('click', function() { closePop(); CM.switchTab('settings'); });
    CM.$('popRefresh').addEventListener('click', function() { location.reload(); });
  }

  /* ============================================
   * 主菜单命令开关的统一实现（桌面歌词 / 置顶 / 锁定）
   * --------------------------------------------
   * 这三个开关原本各写一遍「忙锁 + GUID 缓存 + 搜两次 + 翻转状态」，
   * 逻辑完全相同、只有匹配关键词和提示语不同，所以收成一个工厂，各持一份状态。
   *   search / fallback  先按前者精确搜，搜不到再按后者宽泛搜一次
   *   match(hay)         hay = 命令名 + 描述，怎么认定是目标命令
   *   onLabel/offLabel   翻转后的提示语；failMsg 找不到命令时的提示
   *   execFailTitle      执行失败时的提示标题
   * ============================================ */
  function makeMenuToggle(cfg) {
    var cmd = null, busy = false, on = false;

    function pick(r) {
      var list = (r && r.results) || [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.type && c.type !== 'mainmenu') continue;   // 只认主菜单命令
        if (cfg.match((c.name || '') + (c.description || ''))) {
          return { guid: c.guid, subGuid: c.subGuid || null };
        }
      }
      return null;
    }

    function run(c) {
      busy = true;
      var params = c.subGuid ? { guid: c.guid, subGuid: c.subGuid } : { guid: c.guid };
      CM.api('discovery.executeMainMenuCommand', params).then(function(r) {
        busy = false;
        if (!r || r.success === false) {
          cmd = null;        // GUID 可能已失效（插件更新/重装会变），下次重新搜索
          CM.showToast(cfg.execFailTitle, '命令执行失败，将重新检测组件', 'error');
          return;
        }
        on = !on;
        CM.showToast(on ? cfg.onLabel : cfg.offLabel, null, on ? 'success' : null);
        updateMorePopoverState();
      });
    }

    return {
      toggle: function() {
        if (busy) return;                                 // 连点保护：搜索阶段也要上锁
        if (cmd) { run(cmd); return; }
        // 搜索阶段同样要上锁：否则搜索返回前的连点会各发一次搜索、各执行一次命令，
        // 开关被翻转两次（表现为「点了没反应」）且弹出两个提示
        busy = true;
        // includeHidden 避免命令被判为「宿主不显示」而被过滤
        CM.api('discovery.searchCommands', { query: cfg.search, includeHidden: true }).then(function(r) {
          var c = pick(r);
          if (c) { cmd = c; run(c); return; }
          // 兜底：命令名可能因版本而异，再宽泛搜一次
          CM.api('discovery.searchCommands', { query: cfg.fallback, includeHidden: true }).then(function(r2) {
            var c2 = pick(r2);
            busy = false;
            if (c2) { cmd = c2; run(c2); return; }
            cmd = null;
            CM.showToast('启动失败', cfg.failMsg, 'error');
          });
        });
      },
      isOn: function() { return on; },
      setOn: function(v) { on = !!v; }
    };
  }

  var dlShow = makeMenuToggle({
    search: '显示桌面歌词', fallback: '歌词',
    match: function(hay) {
      return hay.indexOf('显示桌面歌词') >= 0 || hay.indexOf('桌面歌词') >= 0;
    },
    onLabel: '桌面歌词已开启', offLabel: '桌面歌词已关闭',
    failMsg: '请确认已安装 ESLyric 插件', execFailTitle: '启动失败'
  });
  CM.toggleDesktopLyric = function() { dlShow.toggle(); };

  var dlPin = makeMenuToggle({
    search: '窗口置顶', fallback: '置顶',
    match: function(hay) {
      return hay.indexOf('窗口置顶') >= 0 || (hay.indexOf('置顶') >= 0 && hay.indexOf('歌词') >= 0);
    },
    onLabel: '桌面歌词置顶已开启', offLabel: '桌面歌词置顶已关闭',
    failMsg: '未找到置顶命令，请确认 ESLyric 已安装', execFailTitle: '操作失败'
  });
  CM.toggleDesktopLyricPin = function() { dlPin.toggle(); };

  var dlLock = makeMenuToggle({
    search: '锁定桌面歌词', fallback: '锁定',
    match: function(hay) {
      return hay.indexOf('锁定') >= 0 && (hay.indexOf('歌词') >= 0 || hay.indexOf('桌面') >= 0);
    },
    onLabel: '桌面歌词锁定已开启', offLabel: '桌面歌词锁定已关闭',
    failMsg: '未找到锁定命令，请确认 ESLyric 已安装', execFailTitle: '操作失败'
  });
  CM.toggleDesktopLyricLock = function() { dlLock.toggle(); };

  function updateMorePopoverState() {
    // 桌面歌词状态
    var showOn = dlShow.isOn();
    var dlNote = CM.$('popDesktopLyricNote');
    var dlItem = CM.$('popDesktopLyricShow');
    if (dlNote) dlNote.textContent = showOn ? '开' : '关';
    if (dlItem) dlItem.classList.toggle('checked', showOn);
    // 桌面歌词置顶状态（显示关闭时禁用）
    var dlPinNote = CM.$('popDesktopLyricPinNote');
    var dlPinItem = CM.$('popDesktopLyricPin');
    if (dlPinNote) dlPinNote.textContent = dlPin.isOn() ? '开' : '关';
    if (dlPinItem) {
      dlPinItem.classList.toggle('checked', dlPin.isOn());
      dlPinItem.disabled = !showOn;
    }
    // 桌面歌词锁定状态（显示关闭时禁用）
    var dlLockNote = CM.$('popDesktopLyricLockNote');
    var dlLockItem = CM.$('popDesktopLyricLock');
    if (dlLockNote) dlLockNote.textContent = dlLock.isOn() ? '开' : '关';
    if (dlLockItem) {
      dlLockItem.classList.toggle('checked', dlLock.isOn());
      dlLockItem.disabled = !showOn;
    }
    // 常驻托盘开关已搬进「设置与工具」页（菜单里不再有这一行）——
    // 不要再在这里读写 popTray/popTrayNote（那两个 id 已不存在）
    // 均衡器状态
    CM.syncEQState();
    // 输出设备名称
    CM.api('config.getOutputConfig').then(function(r) {
      var note = CM.$('popOutputNote');
      if (note && r) note.textContent = r.outputName || r.deviceName || '';
    });
    // 播放增益状态
    CM.api('replaygain.getSettings').then(function(s) {
      var note = CM.$('popRGNote'), txt = '';
      if (s) {
        if (s.sourceMode === 'album') txt = '专辑';
        else if (s.sourceMode === 'track') txt = '音轨';
        if (s.processingMode !== 'none') txt += ' · 已启用';
        else txt += ' · 关闭';
      }
      if (note) note.textContent = txt;
    });
  }
  CM.toggleMorePopover = function() {
    var pop = els.morePopover;
    if (pop.classList.contains('open')) { pop.classList.remove('open'); return; }
    // 两个弹层互斥：更多菜单打开时收起 ReplayGain 弹层（否则叠在一起，且
    // 外点击处理器豁免了 btnMore，ReplayGain 弹层不会被顺带关掉）
    if (els.rgPopover) els.rgPopover.classList.remove('open');
    buildMorePopover();
    syncEslyricStates();  // 异步，完成后会调用 updateMorePopoverState
    pop.classList.add('open');
  };

  /* ============================================
   * 同步 ESLyric 命令的实际勾选状态
   * ============================================ */
  // 读 ESLyric「桌面歌词」相关命令的真实勾选状态，并同步到界面（更多菜单 + 设置页都用）。
  // 返回 Promise<{show,pin,lock}>：设置页要按它渲染开关，所以不能只是内部同步完就结束。
  function syncEslyricStates() {
    return CM.api('discovery.searchCommands', { query: '桌面歌词', includeHidden: true }).then(function(r) {
      if (r && r.results) {
        for (var i = 0; i < r.results.length; i++) {
          var c = r.results[i];
          if (c.type && c.type !== 'mainmenu') continue;
          var hay = (c.name || '') + (c.description || '');
          // 桌面歌词：显示
          if (hay.indexOf('显示桌面歌词') >= 0 || (hay.indexOf('桌面歌词') >= 0 && hay.indexOf('显示') >= 0)) {
            dlShow.setOn(c.checked);
          }
          // 桌面歌词：置顶
          if (hay.indexOf('窗口置顶') >= 0) {
            dlPin.setOn(c.checked);
          }
          // 桌面歌词：锁定
          if (hay.indexOf('锁定') >= 0 && hay.indexOf('桌面歌词') >= 0) {
            dlLock.setOn(c.checked);
          }
        }
      }
      updateMorePopoverState();
      return { show: dlShow.isOn(), pin: dlPin.isOn(), lock: dlLock.isOn() };
    }, function() {
      // 命令搜索失败（宿主不支持 / ESLyric 未装）：保持原状态，但也要把界面同步一次
      updateMorePopoverState();
      return { show: dlShow.isOn(), pin: dlPin.isOn(), lock: dlLock.isOn() };
    });
  }
  CM.syncEslyricStates = syncEslyricStates;

  /* ============================================
   * 播放增益（ReplayGain）面板
   * ============================================ */
  var rgBuilt = false;
  var RG_MODES = [
    { v: 'none', name: '关闭' },
    { v: 'gain', name: '增益' },
    { v: 'gain_and_peak', name: '增益+峰值' },
    { v: 'peak', name: '峰值' }
  ];
  function setSegActive(containerId, val) {
    var c = CM.$(containerId); if (!c) return;
    c.querySelectorAll('button').forEach(function(b) { b.classList.toggle('on', b.dataset.v === val); });
  }
  function setRg(key, val) {
    var params = key === 'sourceMode' ? { sourceMode: val } : { processingMode: val };
    CM.api('replaygain.setMode', params).then(function(r) {
      if (!r || r.success === false) CM.showToast('增益设置失败', null, 'error');
    });
  }
  function buildRgPopover() {
    if (rgBuilt) return;
    rgBuilt = true;
    var pop = els.rgPopover;
    pop.innerHTML =
      '<div class="popover-section">' +
      '<div class="popover-label">增益来源</div>' +
      '<div class="rg-seg" id="rgSource">' +
      '<button data-v="track">音轨</button><button data-v="album">专辑</button>' +
      '</div>' +
      '<div class="popover-label">处理方式</div>' +
      '<div class="rg-seg" id="rgMode">' +
      RG_MODES.map(function(m) { return '<button data-v="' + m.v + '">' + m.name + '</button>'; }).join('') +
      '</div>' +
      '<div class="popover-label">前置增益 <span class="rg-val" id="rgPreampVal">--</span></div>' +
      '<input type="range" class="rg-slider" id="rgPreamp" min="-12" max="12" step="0.5" value="0" />' +
      '</div>';
    CM.$('rgSource').addEventListener('click', function(e) {
      var b = e.target.closest('button'); if (!b) return;
      setSegActive('rgSource', b.dataset.v);
      setRg('sourceMode', b.dataset.v);
    });
    CM.$('rgMode').addEventListener('click', function(e) {
      var b = e.target.closest('button'); if (!b) return;
      setSegActive('rgMode', b.dataset.v);
      setRg('processingMode', b.dataset.v);
    });
    CM.$('rgPreamp').addEventListener('input', function() {
      var v = parseFloat(CM.$('rgPreamp').value);
      CM.$('rgPreampVal').textContent = (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB';
    });
    CM.$('rgPreamp').addEventListener('change', function() {
      // 写操作走 apiOr：被宿主拒时滑杆上已经显示新值，必须如实报错，
      // 否则用户以为前置增益已经生效
      CM.apiOr('replaygain.setPreamp', { withRg: parseFloat(CM.$('rgPreamp').value) })
        .then(null, function(e) { CM.failToast(e, '前置增益设置失败'); });
    });
  }
  CM.toggleRgPopover = function() {
    var pop = els.rgPopover;
    if (pop.classList.contains('open')) { pop.classList.remove('open'); return; }
    buildRgPopover();
    // 载入当前状态
    CM.api('replaygain.getSettings').then(function(s) {
      if (!s) return;
      var src = s.sourceMode === 'album' ? 'album' : 'track';
      setSegActive('rgSource', src);
      setSegActive('rgMode', s.processingMode || 'none');
    });
    CM.api('replaygain.getPreamp').then(function(p) {
      if (!p || p.withRg === undefined) return;
      var v = p.withRg;
      CM.$('rgPreamp').value = v;
      CM.$('rgPreampVal').textContent = (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB';
    });
    pop.classList.add('open');
  };

  /* ============================================
   * 迷你频谱
   * ============================================ */
  var SPEC_BARS = 16;
  var specBarEls = [];

  // 通用频谱条生成器（迷你频谱 + 沉浸式频谱共用）
  CM.createSpectrumBars = function(container, count, barClass) {
    var html = '';
    for (var i = 0; i < count; i++) html += '<div class="' + barClass + '"></div>';
    container.innerHTML = html;
    return Array.prototype.slice.call(container.children);
  };

  CM.initSpectrumBars = function() {
    specBarEls = CM.createSpectrumBars(els.miniSpectrum, SPEC_BARS, 'mini-spec-bar');
  };

  CM.setVisualizerActive = function(active) {
    state.visualizerActive = active;
    CM.settings.visualizer = active;
    CM.saveSettings();
    els.btnVisualizer.classList.toggle('active', active);
    els.miniSpectrum.style.display = active ? '' : 'none';
    if (active) CM.startSpectrum();
    else CM.stopSpectrum();
  };

  // 频谱订阅统一交给 js/audio-viz.js：v2 起用 bins（原始 FFT 频点）+ 立体声，
  // 失败自动回退频带输出；顺带把 fftSize 从 8192 降到 2048（宿主侧 FFT 计算量 1/4）。
  // 这里只把算好的条数喂给主题自己的频谱条 —— 不再新增任何可视化元件。
  // 帧分发统一走 CM.sched：这里的 'mini' 只管底栏那条迷你频谱，沉浸页自己注册
  // 一份（'np'）—— 关掉底栏频谱开关不会连带把沉浸页那条频谱也停掉，反之亦然。
  CM.startSpectrum = function() {
    if (!fb.isAvailable() || !CM.sched) return;
    CM.sched.want('mini', { fps: 30, onFrame: function(frame) {
      CM.updateSpectrumBars(specBarEls, CM.viz.barsFor(frame, SPEC_BARS), SPEC_BARS, 18, 20);
    }});
  };

  CM.stopSpectrum = function() {
    if (CM.sched) CM.sched.release('mini');
    specBarEls.forEach(function(el) { el.style.transform = 'scaleY(0.1)'; });
  };

  /* ============================================
   * 拖放（宿主 dnd API，回退 HTML5 提示）
   * ============================================ */
  var AUDIO_EXT = /\.(mp3|flac|wav|aac|m4a|mp4|opus|ogg|oga|wma|ape|wv|alac|aiff|aif|dsf|dff|tak|tta|mpc|mka|m4b|m4r)$/i;
  // 目录 + 文件名拼完整路径（file.list 非递归回包只有名字）
  function joinDirName(dir, name) {
    if (/[\\/]$/.test(dir)) return dir + name;
    return dir + (dir.indexOf('\\') >= 0 ? '\\' : '/') + name;
  }

  // 把拖入 / 选中的路径展开成可播放的音频文件：
  // 目录用宿主 file.list 递归枚举，普通文件按扩展名保留。宿主 addPathsAsync 不会展开
  // 文件夹，会把文件夹当一个音轨加入导致"无法打开（文件格式不支持）"。
  // 插件 2.0.0 只加载 bridge.global.js，旧 SMP 兼容层的 window.utils（IsDirectory /
  // ListFiles）默认**不存在** —— 早先那条分支永远走不到，选文件夹后静默返回空数组，
  // 表现就是"添加文件夹扫描不到里面的歌曲"。这里改用宿主 file.exists + file.list，
  // 读不到就把原因记进 CM._expandFailures，由调用方如实提示，不再静默丢。
  CM.expandDroppedPaths = function(raw) {
    var rawPaths = (raw || []).map(function(f) {
      return typeof f === 'string' ? f : (f.path || f.name || '');
    }).filter(Boolean);
    var failures = [];
    var jobs = rawPaths.map(function(p) {
      return Promise.resolve().then(function() {
        if (CM.isUrlPath && CM.isUrlPath(p)) return [p];      // 网络地址原样交给歌单
        return CM.api('file.exists', { path: p }).then(function(ex) {
          if (!ex || ex.success === false) {
            // 宿主没有 file.* 接口：至少别把普通音频文件丢掉，同时把原因报上去
            failures.push(p + '（宿主未提供 file.exists）');
            return AUDIO_EXT.test(p) ? [p] : [];
          }
          if (ex.isDirectory !== true) return AUDIO_EXT.test(p) ? [p] : [];
          return CM.api('file.list', { path: p, recursive: true }).then(function(ls) {
            if (!ls || ls.success === false) {
              failures.push(p + '（' + ((ls && (ls.error || ls.code)) || '目录读取失败') + '）');
              return [];
            }
            var files = ls.files || ls.items || [];
            var out = [];
            for (var i = 0; i < files.length; i++) {
              var f = files[i];
              var name = typeof f === 'string' ? f : (f.path || f.name || '');
              if (!name) continue;
              // 递归回包是完整路径；万一只回了文件名，补回目录前缀
              if (name.indexOf('\\') < 0 && name.indexOf('/') < 0) name = joinDirName(p, name);
              if (AUDIO_EXT.test(name)) out.push(name);
            }
            return out;
          });
        });
      }).catch(function(e) {
        failures.push(p + '（' + ((e && e.message) || '读取失败') + '）');
        return [];
      });
    });
    return Promise.all(jobs).then(function(groups) {
      CM._expandFailures = failures;
      return Array.prototype.concat.apply([], groups);
    });
  };

  // 展开失败 / 没找到音频时的一句实话（调用方在拿到空列表时用）
  CM.expandFailText = function(fallback) {
    var f = CM._expandFailures || [];
    return f.length ? f.join('；') : (fallback || '没有找到可添加的音频文件');
  };

  // 统一入口：把拖进来的（文件/文件夹）路径加到当前歌单
  CM.addDroppedPaths = function(raw) {
    CM.expandDroppedPaths(raw).then(function(paths) {
      if (!paths.length) {
        CM.showToast('没有可添加的歌曲', CM.expandFailText('文件夹里没有音频文件'), 'error');
        return;
      }
      var target = state.currentPlaylistIndex >= 0 ? state.currentPlaylistIndex : undefined;
      var params = { paths: paths };
      if (target !== undefined) params.playlist = target;
      CM.api('playlist.addPathsAsync', params).then(function(res) {
        if (res && res.success !== false) {
          CM.showToast('正在添加 ' + paths.length + ' 个项目', null, 'success');
        } else {
          CM.showToast('添加失败', (res && res.error) || '路径可能无效', 'error');
        }
      });
    });
  };

  CM.initDragDrop = function() {
    // v1.12.0 起 dnd 改为主机原生观察，不再注册 drop zone；
    // 读路径统一走 dnd.getPathsAsync（await 安全、不依赖消息顺序）。
    var lastDropAt = 0;
    // 宿主 dnd:drop 事件与 HTML5 window drop 事件先后顺序不定，谁先处理谁生效，
    // 另一路在 500ms 内直接跳过，避免同一批文件被重复添加
    function claimDrop() {
      var now = Date.now();
      if (now - lastDropAt < 500) return false;
      lastDropAt = now;
      return true;
    }
    fb.on('dnd:enter', function(data) {
      // v2 的 dnd 事件带 source：本页面 / 同一 foobar2000 的其他窗口 / 外部拖动
      var src = data && data.source;
      if (els.dropOverlay) {
        var sub = els.dropOverlay.querySelector('.drop-overlay-sub');
        if (sub) {
          sub.textContent = src === 'other-window' ? '来自其他 foobar2000 窗口'
                          : src === 'self' ? '来自本页面'
                          : '支持音频文件与文件夹';
        }
      }
      els.dropOverlay.classList.add('active');
    });
    fb.on('dnd:leave', function() { els.dropOverlay.classList.remove('active'); });
    fb.on('dnd:drop', function(data) {
      els.dropOverlay.classList.remove('active');
      if (data && data.source === 'self') return;   // 页面内部拖动：不当作"从外部添加"
      if (!claimDrop()) return;
      var sessionId = data && data.sessionId;
      CM.api('dnd.getPathsAsync', sessionId ? { sessionId: sessionId } : {}).then(function(r) {
        var paths = (r && (r.paths || r.files)) || [];
        if (!paths.length && data && data.paths) paths = data.paths;
        CM.addDroppedPaths(paths);
      });
    });
    // 视觉反馈（WebView2 内 dragover 依然会触发）
    // 仅处理"外部文件拖入"（dataTransfer 含 Files）
    function isFileDrag(e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      if (!t) return false;
      for (var i = 0; i < t.length; i++) {
        if (t[i] === 'Files' || t[i] === 'files') return true;
      }
      return false;
    }
    var dragDepth = 0;
    window.addEventListener('dragenter', function(e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth++;
      els.dropOverlay.classList.add('active');
    });
    window.addEventListener('dragleave', function(e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (--dragDepth <= 0) { dragDepth = 0; els.dropOverlay.classList.remove('active'); }
    });
    window.addEventListener('dragover', function(e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
    });
    window.addEventListener('drop', function(e) {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth = 0;
      els.dropOverlay.classList.remove('active');
      if (!claimDrop()) return;
      // 文档推荐在 HTML5 drop handler 内用 getPathsAsync 读取宿主会话的真实路径
      //（同步 getPaths 在快速拖放时会读到空数组，故不用它做唯一来源）。
      // 文件夹路径由宿主端 addPathsAsync 自动展开其中的音频文件。
      CM.api('dnd.getPathsAsync').then(function(r) {
        var paths = (r && (r.paths || r.files)) || [];
        if (!paths.length) return;
        CM.addDroppedPaths(paths);
      });
    });
  };

  /* ============================================
   * 键盘快捷键
   * ============================================ */
  CM.initKeyboard = function() {
    document.addEventListener('keydown', function(e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          CM.api('playback.playOrPause');
          break;
        case 'ArrowLeft':
          if (e.ctrlKey) { CM.prevTrack(); }
          else if (state.canSeek) { CM.api('playback.setPosition', { position: Math.max(0, state.position - 5) }); }
          break;
        case 'ArrowRight':
          if (e.ctrlKey) { CM.nextTrack(); }
          else if (state.canSeek) { CM.api('playback.setPosition', { position: Math.min(state.duration, state.position + 5) }); }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (e.altKey) { CM.keyboardMoveTracks(-1); }  // Alt+↑ 上移选中/聚焦曲目
          else { CM.api('playback.volumeUp'); }
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (e.altKey) { CM.keyboardMoveTracks(1); }   // Alt+↓ 下移选中/聚焦曲目
          else { CM.api('playback.volumeDown'); }
          break;
        case 'm': case 'M':
          CM.api('playback.toggleMute');
          break;
        case 'l': case 'L':
          CM.setLyricsVisible(!state.lyricsVisible);
          break;
        case 'q': case 'Q':
          CM.toggleQueue();
          break;
        case 'Escape':
          // 优先级链：一次 Esc 只关最上面一层（与指南一致：队列 → 菜单 →
          // 标签编辑器 → 批量选择）。原先一次全关，会让 Esc 在标签编辑器
          // 上顺带清掉派生它的批量多选；队列拖拽的取消在 ui-queue 的
          // 捕获监听里处理（stopPropagation），到不了这里
          if (!els.ctxMenu.classList.contains('hidden')) { CM.hideCtxMenu(); break; }
          var escTeo = CM.$('tagEditorOverlay');
          if (escTeo && escTeo.classList.contains('open')) { CM.hideTagEditor(); break; }
          // 沉浸页盖在底栏/抽屉之上（z-index 200）：它开着时 Esc 只关沉浸页
          //（bindNpOverlay 的独立监听负责关），垫在底下的队列抽屉/批量选择留给
          // 下一次 —— 原先两个 document 级监听互不通气，一次 Esc 会连关两层
          if (state.npOpen) break;
          if (state.queueOpen) { CM.toggleQueue(false); break; }
          if (els.morePopover.classList.contains('open') ||
              (els.rgPopover && els.rgPopover.classList.contains('open'))) {
            els.morePopover.classList.remove('open');
            if (els.rgPopover) els.rgPopover.classList.remove('open');
            break;
          }
          // 清除批量选择
          if (state.batchSelected.size > 0) CM.clearBatchSelection();
          break;
      }
    });
  };

  /* ============================================
   * 任务栏进度条
   * 缩略按钮交给 foobar 原生系统媒体控制（SMTC / 全局媒体键），后台也能用；
   * 主题自设按钮在窗口最小化时页面 JS 挂起、taskbar:buttonClicked 不可靠，故不再设置，
   * 仅保留 taskbar.setProgress 进度条（调用即下发、无后台依赖）。
   * ============================================ */
  CM.initTaskbar = function() {
    // 任务栏按钮要等宿主窗口真正显示后才存在，boot 早期的下发会 OPERATION_FAILED ——
    // 而且一次性探测失败会把 taskbarAvailable 永久钉在 false，进度条功能整个失效。
    // 改成失败退避重试（最多 10 次）；探测走裸 fb.invoke，预期中的前几次失败不刷控制台。
    var tries = 0;
    function probe() {
      tries++;
      fb.invoke('taskbar.setProgress', { state: 'none' }).then(function (r) {
        if (r && r.success !== false) { CM.taskbarAvailable = true; return; }
        if (tries < 10) setTimeout(probe, Math.min(1000 * tries, 5000));
      }, function () {
        if (tries < 10) setTimeout(probe, Math.min(1000 * tries, 5000));
      });
    }
    probe();
  };

  // 节流：仅当可见进度 1% 变化时才通过 IPC 更新任务栏，避免 timeHighRes 高频事件（~30次/秒）反复调用宿主 API
  CM._lastTaskbarVal = -1;
  CM._lastTaskbarState = '';
  CM.updateTaskbarProgress = function() {
    if (!CM.taskbarAvailable) return;
    if (!CM.currentTrack || state.duration <= 0) {
      if (CM._lastTaskbarVal !== -2) {
        CM._lastTaskbarVal = -2;
        CM.api('taskbar.setProgress', { state: 'none' });
      }
      return;
    }
    // 播放态统一读 CM.state.playing：SDK 那份 fb.state 镜像只由 stateChanged /
    // trackChanged / stopped 更新，走 playback:paused 恢复时不跟着变（会显示成暂停）
    var stateName = CM.state.playing ? 'normal' : 'paused';
    var v = Math.max(0, Math.min(1, state.position / state.duration));
    var pct = Math.round(v * 100);
    if (pct === CM._lastTaskbarVal && stateName === CM._lastTaskbarState) return;
    CM._lastTaskbarVal = pct;
    CM._lastTaskbarState = stateName;
    CM.api('taskbar.setProgress', { state: stateName, value: v });
  };

  /* ============================================
   * 沉浸式 NowPlaying 事件绑定
   * ============================================ */
  CM.bindNpOverlay = function() {
    // 右侧面板进入沉浸式按钮
    els.rpImmersiveBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      CM.toggleNpOverlay(true);
    });

    // 关闭按钮
    els.npCloseBtn.addEventListener('click', function() {
      CM.toggleNpOverlay(false);
    });

    // 沉浸式顶部拖拽条：无系统标题栏时仍可移动窗口
    var npDrag = CM.$('npDragHandle');
    if (npDrag) {
      npDrag.addEventListener('mousedown', function(e) { if (e.button === 0) CM.api('window.startDrag'); });
      npDrag.addEventListener('dblclick', function() { CM.api('window.toggleMaximize'); });
    }

    // 模式切换按钮
    els.npModeBtn.addEventListener('click', function() {
      CM.toggleNpMode();
    });

    // 歌词 3D 倾斜开关（右上角小钮，设置持久化）
    if (els.npTiltBtn) els.npTiltBtn.addEventListener('click', function() { CM.toggleNpTilt(); });
    CM.applyNpTilt();

    // 频谱显示开关（频谱条 → 声场 → 瀑布图 → 示波器 → 矢量示波器，点击循环；五种都画在那条频谱的位置上）
    if (els.npVizBtn) els.npVizBtn.addEventListener('click', function() {
      if (CM.spectrumMode) CM.spectrumMode.cycle();
    });

    // 专辑河流开关（沉浸页内的 3D 专辑浏览；交互与播放逻辑见 ui-nowplaying.js 的 flow 模块）
    var npFlowBtn = CM.$('npFlowBtn');
    if (npFlowBtn) npFlowBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      CM.npFlowToggle();
    });

    // 播放控制
    els.npBtnPlay.addEventListener('click', function() { CM.api('playback.playOrPause'); });
    els.npBtnPrev.addEventListener('click', function() { CM.prevTrack(); });
    els.npBtnNext.addEventListener('click', function() { CM.nextTrack(); });
    // 歌词侧控制（纯歌词模式）
    els.npLcPlay.addEventListener('click', function() { CM.api('playback.playOrPause'); });
    els.npLcPrev.addEventListener('click', function() { CM.prevTrack(); });
    els.npLcNext.addEventListener('click', function() { CM.nextTrack(); });

    // 沉浸式进度条
    CM.bindSeekBar(els.npSeekBar, els.npTimeCurrent, '--np-seek-pct', 'npSeeking', CM.updateNpSeekUI);

    // ESC 关闭沉浸式
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && state.npOpen) {
        CM.toggleNpOverlay(false);
      }
    });
  };


  /* ============================================
   * ESLyric 通用命令执行辅助
   * ============================================ */
  var _eslyricExecBusy = false;

  function eslyricExecOne(query, matchFn, onOk, onErr) {
    if (_eslyricExecBusy) return;
    _eslyricExecBusy = true;
    CM.api('discovery.searchCommands', { query: query, includeHidden: true }).then(function(r) {
      if (!r || !r.results) { _eslyricExecBusy = false; onErr('未找到命令'); return; }
      for (var i = 0; i < r.results.length; i++) {
        var c = r.results[i];
        if (c.type && c.type !== 'mainmenu') continue;
        if (matchFn(c)) {
          var params = c.subGuid ? { guid: c.guid, subGuid: c.subGuid } : { guid: c.guid };
          CM.api('discovery.executeMainMenuCommand', params).then(function(r2) {
            _eslyricExecBusy = false;
            if (!r2 || r2.success === false) { onErr('命令执行失败'); return; }
            onOk();
          });
          return;
        }
      }
      _eslyricExecBusy = false;
      onErr('未找到匹配命令');
    });
  }

  /* ============================================
   * ESLyric 工具命令（共用 eslyricExecOne）
   * --------------------------------------------
   * 四条命令只有「关键词 + 提示语」不同：匹配与提示逻辑收在 execEslyricCmd 里，
   * 入口仍逐个显式声明 —— 这样按名字就能搜到定义，不必靠猜。
   * ============================================ */
  function execEslyricCmd(key, okMsg, notFoundMsg) {
    eslyricExecOne(key,
      function(c) { return ((c.name || '') + (c.description || '')).indexOf(key) >= 0; },
      function() { CM.showToast(okMsg, null, 'success'); },
      function(err) { CM.showToast('启动失败', err === '未找到命令' ? notFoundMsg : err, 'error'); });
  }

  CM.execDesktopLyricReset = function() {
    execEslyricCmd('重置位置', '桌面歌词位置已重置', '未找到重置位置命令');
  };
  // 注：ESLyric 的「搜索歌词 / 重载歌词 / 脚本测试」已去掉（搜索走多源候选面板、
  // 重载走「刷新歌词」），对应的 CM.execEslyric* 导出一并删除 —— 不要再加回来。

  /* ============================================
   * 均衡器 — 通过 DSP API 切换 EQ
   * 均衡器 GUID 来自 dsp.getAvailable
   * ============================================ */
  var EQ_GUID = '{82AEF845-DCC3-4DA5-9D80-E9A972B2140D}';
  var eqMode = false;

  // 在 DSP 链中查找 EQ 的索引（-1 表示不存在）
  function findEQInChain(dsps) {
    if (!dsps) return -1;
    for (var i = 0; i < dsps.length; i++) {
      if (dsps[i].guid === EQ_GUID) return i;
    }
    return -1;
  }

  // 更新 EQ 按钮状态
  function updateEQUI() {
    var note = CM.$('popEQNote');
    var item = CM.$('popEQ');
    if (note) note.textContent = eqMode ? '开' : '关';
    if (item) item.classList.toggle('checked', eqMode);
  }

  CM.syncEQState = function() {
    CM.api('dsp.getChain').then(function(r) {
      // 失败信封是真值：不判 success 会把"没问到"当成"链里没有"，备注显示"关"
      if (!r || r.success === false) return;
      eqMode = findEQInChain(r.dsps) >= 0;
      updateEQUI();
    });
  };

  CM.toggleEQ = function() {
    CM.api('dsp.getChain').then(function(r) {
      // 失败信封是真值：不判 success 会把读链失败当"链里没有 EQ"，
      // 接着 addDsp 给已在链中的均衡器再添一份
      if (!r || r.success === false) { CM.showToast('操作失败', '无法获取 DSP 链', 'error'); return; }
      var eqIndex = findEQInChain(r.dsps);
      if (eqIndex >= 0) {
        CM.api('dsp.removeDsp', { index: eqIndex }).then(function(res) {
          if (res && res.success !== false) { eqMode = false; updateEQUI(); CM.showToast('均衡器已关闭', null); }
          else { CM.showToast('操作失败', null, 'error'); }
        });
      } else {
        CM.api('dsp.addDsp', { guid: EQ_GUID }).then(function(res) {
          if (res && res.success !== false) { eqMode = true; updateEQUI(); CM.showToast('均衡器已开启', null, 'success'); }
          else { CM.showToast('操作失败', null, 'error'); }
        });
      }
    });
  };

  /* ============================================
   * 原生主菜单 — 拉取 foobar2000 主菜单树，用主题自己的菜单渲染
   * --------------------------------------------
   * 一次接入即可触达宿主全部命令与组件菜单。命令优先用 GUID 执行（唯一不受宿主
   * 语言影响的形式），没有 GUID 的项退回路径（仅在标签语言与宿主一致时可用）；
   * 禁用的项灰显不可点。
   *
   * 主题菜单渲染器只支持两级（二级菜单复用同一渲染器，第三级会把二级覆盖掉），
   * 而 foobar 主菜单存在三级（如 播放 → 顺序 → 随机），故把二级以下展平到第二级，
   * 用「父 › 子」前缀保留层级信息，保证所有命令都能到达。
   * ============================================ */
  function runMainMenuNode(node) {
    var fail = function(e) { CM.showToast('命令未执行', CM.errText(e && e.code), 'error'); };
    if (node.guid) {
      var params = { command: node.guid };
      if (node.subGuid) params.subGuid = node.subGuid;   // 动态子命令必须与父 GUID 一起传
      CM.apiOr('menu.runMainMenuCommand', params).then(null, fail);
      return;
    }
    var path = node.displayPath || node.path;
    if (!path) { CM.showToast('该命令无法执行', '宿主未提供稳定地址', 'error'); return; }
    CM.apiOr('menu.runMainMenuCommand', { command: path }).then(null, fail);
  }

  // 节点列表 → 菜单项。submenu 就地展平，prefix 累积「父 › 子」层级
  function menuNodesToItems(nodes, prefix) {
    var out = [];
    prefix = prefix || '';
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n) continue;
      if (n.type === 'separator') {
        if (out.length && !out[out.length - 1].divider) out.push({ divider: true });
        continue;
      }
      var label = n.displayLabel || n.label || '';
      if (n.type === 'submenu') {
        out = out.concat(menuNodesToItems(n.children || [], prefix + label + ' › '));
      } else {
        if (n.hidden) continue;
        out.push({
          label: prefix + label,
          checked: !!n.checked,
          disabled: n.enabled === false,
          action: (function(node) { return function() { runMainMenuNode(node); }; })(n)
        });
      }
    }
    while (out.length && out[out.length - 1].divider) out.pop();  // 去掉悬挂分隔符
    return out;
  }

  CM.showMainMenu = function() {
    // 能力探测：旧宿主没有主菜单 API 时直接说明，而不是点了没反应
    if (CM.caps && CM.caps.set && !CM.caps.has('menu.getMainMenu')) {
      CM.showToast('宿主不支持主菜单', '需要 foo_ui_webview2 1.2.0+', 'error');
      return;
    }
    CM.api('menu.getMainMenu').then(function(r) {
      if (!r || r.success === false) {
        CM.showToast('无法获取主菜单', CM.errText(r && r.code), 'error');
        return;
      }
      var nodes = Array.isArray(r.items) ? r.items : [];
      var items = [];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n) continue;
        if (n.type === 'separator') {
          if (items.length && !items[items.length - 1].divider) items.push({ divider: true });
          continue;
        }
        var label = n.displayLabel || n.label || '';
        if (n.type === 'submenu') {
          var kids = menuNodesToItems(n.children || [], '');
          if (kids.length) items.push({ label: label, submenu: kids });
        } else if (!n.hidden) {
          items.push({
            label: label,
            checked: !!n.checked,
            disabled: n.enabled === false,
            action: (function(node) { return function() { runMainMenuNode(node); }; })(n)
          });
        }
      }
      while (items.length && items[items.length - 1].divider) items.pop();
      if (!items.length) { CM.showToast('主菜单为空', '宿主未返回任何命令', 'error'); return; }
      var rect = els.btnMore.getBoundingClientRect();
      CM.showCtxMenu(rect.left, rect.bottom + 6, items);
    });
  };

  /* ============================================
   * 输出设备 — 列出设备并切换
   * ============================================ */
  CM.showOutputDevices = function() {
    // 能力显隐：旧宿主没有这个 API 时直接说明，而不是"点了没反应"
    if (CM.caps && CM.caps.set && !CM.caps.has('config.getOutputDevices')) {
      CM.showToast('宿主不支持输出设备切换', '需要较新的 foo_ui_webview2', 'error');
      return;
    }
    CM.api('config.getOutputDevices').then(function(resp) {
      var devices = Array.isArray(resp) ? resp : (resp && Array.isArray(resp.devices) ? resp.devices : []);
      if (!devices.length) {
        CM.showToast('无法获取输出设备', '宿主未返回设备列表', 'error');
        return;
      }
      var items = [{ label: '输出设备', isLabel: true }];
      devices.forEach(function(d) {
        items.push({
          label: d.name,
          checked: !!d.isCurrent,
          action: function() {
            // 写操作走 apiOr：失败必须如实提示（带错误码归因），不能静默
            CM.apiOr('config.setOutputDevice', { outputId: d.outputId, deviceId: d.deviceId }).then(function() {
              CM.showToast('已切换输出设备', d.name, 'success');
            }, function(e) {
              CM.failToast(e, '切换输出设备失败');
            });
          }
        });
      });
      var rect = els.btnMore.getBoundingClientRect();
      CM.showCtxMenu(rect.left, rect.bottom + 6, items);
    });
  };

  /* ============================================
   * 诊断面板 — 关于 + 排障信息（迭代 1.3）
   * ------------------------------------------------------------
   * 把"排障第一站"从控制台搬到界面上：宿主版本 / 组件路径 / 页面来源（安全限制看这里）/
   * 能力清单（哪些新 API 可用）/ 最近失败的宿主调用（CM.lastApiError + 环形缓冲）。
   * 「复制诊断报告」把 CM.diagReport() 写进剪贴板，用户贴到反馈里就够定位。
   * ============================================ */
  // 关键能力清单：宿主方法名 → 界面上的人话（决定这些功能在当前宿主是否可用）
  var KEY_CAPS = [
    ['menu.getMainMenu', '原生主菜单'],
    ['playlist.undo', '播放列表撤销/重做'],
    ['playlist.createAutoplaylist', '筛选存自动歌单'],
    ['replaygain.scan', 'ReplayGain 扫描'],
    ['config.getOutputDevices', '输出设备切换'],
    ['keyboard.registerHotkey', '全局热键'],
    ['taskbar.setThumbnailButtons', '任务栏缩略图按钮'],
    ['tray.create', '系统托盘'],
    ['titleformat.evalFieldsBatch', '批量字段求值']
  ];
  function infoRow(label, value) {
    return '<span class="ctx-info-label">' + CM.escHtml(label) + '</span>' +
      '<span class="ctx-info-value">' + CM.escHtml(value == null ? '' : String(value)) + '</span>';
  }

  CM.showAbout = function() {
    // 宿主信息（组件清单 / 来源 / 路径）在启动后才完整：打开面板时顺手刷一次（失败沿用缓存）
    if (CM.caps && CM.caps.loadHostInfo) CM.caps.loadHostInfo();
    Promise.all([
      CM.api('config.getVersionInfo'),
      CM.api('playcount.getStats'),
      CM.api('config.getOutputConfig'),
      CM.api('config.getComponents'),
      CM.api('audio.getStreamInfo'),
      CM.api('webview.getSource'),
      CM.api('misc.getComponentPath')
    ]).then(function(results) {
      var ver = results[0] || {};
      var stats = results[1] || {};
      var out = results[2] || {};
      var compsRaw = results[3];
      var comps = Array.isArray(compsRaw) ? compsRaw : (compsRaw && Array.isArray(compsRaw.components) ? compsRaw.components : []);
      var stream = results[4] || {};
      var src = results[5] || {};
      var pathRaw = results[6];
      // 缓存给「复制诊断报告」用（diagReport 读 CM._* 三个字段）
      if (comps.length) CM._componentList = comps;
      if (src) CM._sourceText = CM.sourceText(src);
      var compPath = pathRaw && (pathRaw.path || pathRaw.componentPath || pathRaw.directory);
      if (typeof pathRaw === 'string') compPath = pathRaw;
      if (compPath) CM._componentPath = compPath;

      var pluginVer = ver.plugin;
      if (pluginVer && typeof pluginVer === 'object') pluginVer = pluginVer.version || pluginVer.name;

      var caps = CM.caps || {};
      var last = CM.lastApiError;
      var capCount = caps.ready ? (caps.set ? caps.set.size : 0) + ' 个方法' : '未获取';

      // 可视化调度器现状（谁在拉数据、是否后台降帧）——排障"频谱不动"的第一站
      var sch = (CM.sched && CM.sched.stats) ? CM.sched.stats() : null;
      var schText = sch
        ? (sch.subscribed
            ? sch.subCount + ' 视图' + (sch.waveCount ? ' + ' + sch.waveCount + ' 波形' : '') + (sch.hidden ? '（后台降帧）' : '')
            : '未订阅')
        : '--';

      var items = [
        { label: 'CloudMusic 主题', isLabel: true },
        { html: infoRow('版本', 'v' + CM.VERSION) },
        { html: infoRow('作者', '灵芝含') },
        { html: infoRow('主题 SDK', 'v2.0.0') },
        { divider: true },
        { label: '宿主', isLabel: true },
        { html: infoRow('foobar2000', ver.foobar2000 || '--') },
        { html: infoRow('WebView2 组件', 'v' + (pluginVer || '--')) },
        { html: infoRow('组件路径', compPath || '--') },
        { html: infoRow('页面来源', CM.sourceText(src)) },
        { html: infoRow('DPR / 缩放', CM.dpr() + 'x') },
        { html: infoRow('频谱数据', (CM.viz && CM.viz.binsMode) ? '原始频点 (bins)' : '频带 (bands)') },
        { html: infoRow('可视化调度', schText) },
        { divider: true },
        { label: '能力（' + capCount + '）', isLabel: true }
      ];
      for (var ci = 0; ci < KEY_CAPS.length; ci++) {
        var ok = caps.ready ? caps.has(KEY_CAPS[ci][0]) : null;
        items.push({ html: infoRow(KEY_CAPS[ci][1], ok === null ? '未知' : (ok ? '✓ 可用' : '✗ 不可用')) });
      }
      items.push({ divider: true });
      items.push({ label: '媒体库', isLabel: true });
      items.push({ html: infoRow('总曲目', stats.totalTracks || 0) });
      items.push({ html: infoRow('已播放', stats.playedTracks || 0) });
      items.push({ html: infoRow('未播放', stats.unplayedTracks || 0) });
      items.push({ html: infoRow('总播放次数', stats.totalPlayCount || 0) });
      items.push({ html: infoRow('平均播放', (parseFloat(stats.averagePlayCount) || 0).toFixed(1) + ' 次') });
      items.push({ divider: true });
      items.push({ label: '输出', isLabel: true });
      items.push({ html: infoRow('输出模式', out.outputName || '--') });
      items.push({ html: infoRow('设备', out.deviceName || '--') });
      items.push({ html: infoRow('位深', (out.bitDepth || '--') + ' bit') });
      items.push({ html: infoRow('缓冲', (out.bufferLength || '--') + ' s') });

      if (stream.playing) {
        items.push({ divider: true });
        items.push({ label: '当前播放', isLabel: true });
        items.push({ html: infoRow('编码', stream.codec || '--') });
        items.push({ html: infoRow('采样率', stream.sampleRate ? (stream.sampleRate / 1000).toFixed(1) + ' kHz' : '--') });
        items.push({ html: infoRow('比特率', (stream.bitrate || '--') + ' kbps') });
        items.push({ html: infoRow('声道', (stream.channels || '--') + ' ch') });
      }

      items.push({ divider: true });
      items.push({ label: '已安装组件（' + (comps.length || 0) + ' 个）', isLabel: true });
      // 只列前 24 个：菜单受 max-height 限制可滚动，但几十条组件会把"最近失败"
      // 压到很远；完整清单在「复制诊断报告」里，这里给个概览即可。
      var COMP_LIST_MAX = 24;
      for (var ci2 = 0; ci2 < Math.min(comps.length, COMP_LIST_MAX); ci2++) {
        var comp = comps[ci2] || {};
        items.push({ html: infoRow(comp.name || comp.filename || comp.fileName || '?', comp.version || '') });
      }
      if (comps.length > COMP_LIST_MAX) {
        items.push({ label: '…另有 ' + (comps.length - COMP_LIST_MAX) + ' 个（见诊断报告）', isLabel: true });
      }
      items.push({ divider: true });
      items.push({ label: '最近失败', isLabel: true });
      if (last) {
        items.push({ html: infoRow(last.method, (last.code || '?') + ' · ' + CM.errKindLabel(last.code)) });
        items.push({ label: CM.errAdvice(last.code), isLabel: true });
      } else {
        items.push({ html: infoRow('无', '本次会话没有失败调用') });
      }

      items.push({ divider: true });
      items.push({ label: '复制诊断报告', icon: CM.icons.copy, action: function() {
        CM.copyText(CM.diagReport()).then(function(ok) {
          CM.showToast(ok ? '诊断报告已复制' : '复制失败',
            ok ? '贴到反馈里即可定位' : '请从控制台手动复制', ok ? 'success' : 'error');
        });
      } });
      items.push({ label: '打开控制台', icon: CM.icons.console, action: function() { CM.api('misc.showConsole'); } });

      var rect = els.btnMore.getBoundingClientRect();
      CM.showCtxMenu(rect.left, rect.bottom + 6, items);
    }).catch(function() {
      CM.showToast('获取信息失败', null, 'error');
    });
  };

  /* ============================================
   * 标签编辑器 — 事件绑定
   * ============================================ */
  CM.bindTagEditor = function() {
    // 关闭/取消
    els.tagEditorClose.addEventListener('click', CM.hideTagEditor);
    els.tagEditorCancel.addEventListener('click', CM.hideTagEditor);
    // 点击遮罩关闭
    els.tagEditorOverlay.addEventListener('mousedown', function(e) {
      if (e.target === els.tagEditorOverlay) CM.hideTagEditor();
    });
    // 保存
    els.tagEditorSave.addEventListener('click', CM._saveTagEditor);
    // 封面管理（事件委托，因为按钮是动态渲染的）
    els.tagEditorBody.addEventListener('click', function(e) {
      if (e.target.id === 'tagCoverReplace') CM._replaceCover();
      else if (e.target.id === 'tagCoverRemove') CM._removeCover();
    });
    // 文件选择回调
    els.tagCoverFile.addEventListener('change', CM._onCoverFileSelected);

    // 批量操作栏
    els.batchEditTags.addEventListener('click', CM._batchEditFromBar);
    els.batchDeleteTracks.addEventListener('click', CM._batchDeleteFromBar);
    els.batchClear.addEventListener('click', CM.clearBatchSelection);
  };

  /* ============================================
   * 在线标签获取 — 通过 discovery API 调用 foo_freedb2
   * 首次搜索后缓存命令，后续直接执行
   * ============================================ */
  var _freedbCmd = null; // 缓存：{ guid, path, name } 或 null（已确认不可用）
  var _freedbTarget = ''; // 本次要作用的目标曲目路径

  // 命令名 → 标签路径：discovery.executeContextMenuByPath 按"父级/子级"标签路径匹配，
  // 而 getContextMenuCommands 的行里只有 parentGuid，所以沿链条向上拼名字（最多 4 层，防环）
  function contextMenuLabelPath(cmds, cmd) {
    var parts = [cmd.name || ''];
    var cur = cmd, depth = 0;
    while (cur && cur.parentGuid && depth++ < 4) {
      var parent = null;
      for (var i = 0; i < cmds.length; i++) if (cmds[i].guid === cur.parentGuid) { parent = cmds[i]; break; }
      if (!parent || !parent.name) break;
      parts.unshift(parent.name);
      cur = parent;
    }
    return parts.filter(Boolean).join('/');
  }

  CM.fetchTagsOnline = function(path) {
    if (!path) return;
    _freedbTarget = path;

    var fallbackByGuid = function(cmd) {
      // v2：该方法的 subGuid 不是声明过的参数（mainmenu 才有），带上会被严格校验拒掉
      CM.api('discovery.executeContextMenuCommand', { guid: cmd.guid }).then(function(r) {
        if (!r || r.success === false) {
          _freedbCmd = null; // 清除失效的缓存命令，下次重新探测
          CM.showToast('获取失败', (r && r.error) || '命令执行失败，请尝试在 foobar2000 中手动操作', 'error');
          return;
        }
        CM.showToast('已触发在线获取', '请在弹出的窗口中完成操作', null);
      });
    };

    var execCmd = function(cmd) {
      // v2 起 executeContextMenuCommand 不再回退到"正在播放曲目 / 选中项 / 播放列表"，
      // 无选中项时会以 INVALID_PARAMS 失败 —— 要作用于指定曲目必须走
      // discovery.executeContextMenuByPath 的 trackPath（标签路径匹配）。
      if (!cmd.path) { fallbackByGuid(cmd); return; }
      CM.api('discovery.executeContextMenuByPath', { path: cmd.path, trackPath: _freedbTarget }).then(function(r) {
        if (r && r.success !== false) {
          CM.showToast('已触发在线获取', '请在弹出的窗口中完成操作', null);
          return;
        }
        fallbackByGuid(cmd);
      });
    };

    if (_freedbCmd) { execCmd(_freedbCmd); return; }

    // 搜索右键菜单中包含 freedb 关键词的命令
    CM.api('discovery.getContextMenuCommands').then(function(r) {
      if (!r || !r.commands) {
        CM.showToast('获取失败', '请确认已安装「在线标签获取器」(foo_freedb2) 组件', 'error');
        return;
      }
      // 搜索包含 freedb 或 "在线" 或 "获取标签" 的命令
      var found = null;
      for (var i = 0; i < r.commands.length; i++) {
        var c = r.commands[i];
        var name = (c.name || '').toLowerCase();
        var desc = (c.description || '').toLowerCase();
        if (name.indexOf('freedb') >= 0 || desc.indexOf('freedb') >= 0 ||
            name.indexOf('在线') >= 0 || name.indexOf('获取') >= 0 ||
            name.indexOf('tag from') >= 0 || name.indexOf('get tags') >= 0) {
          found = c;
          break;
        }
      }
      if (!found) {
        CM.showToast('未找到组件', '请确认已安装「在线标签获取器」(foo_freedb2) 组件', 'error');
        return;
      }
      _freedbCmd = {
        guid: found.guid,
        path: contextMenuLabelPath(r.commands, found),
        name: found.name
      };
      execCmd(_freedbCmd);
    });
  };

  /* ============================================
   * 播放列表「更多」菜单 — 批量编辑入口
   * ============================================ */
  // 在 more 菜单中追加「批量编辑标签」选项（当有多选时显示）
  // 通过包装 showCtxMenu 实现：拦截 more 按钮的 click 事件
  // 在原菜单项后追加批量编辑项
  els.btnPlaylistMore.addEventListener('click', function(e) {
    if (state.batchSelected.size >= 2) {
      // 延迟追加，确保在原菜单渲染后执行
      setTimeout(function() {
        var menu = els.ctxMenu;
        if (menu.classList.contains('hidden')) return;
        var divider = document.createElement('div');
        divider.className = 'ctx-divider';
        var item = document.createElement('div');
        item.className = 'ctx-item';
        // 自己带 click 监听；idx 给一个永远越界的 -1，防止 ctx 菜单的委托处理器
        //（按 _ctxMenuItems[dataset.idx] 取 action）将来因条目数变化误触别的命令
        item.dataset.idx = '-1';
        item.innerHTML = (CM.icons.tag || '') + '<span>批量编辑标签（' + state.batchSelected.size + '首）</span>';
        item.addEventListener('click', function() {
          CM.hideCtxMenu();
          CM._batchEditFromBar();
        });
        menu.appendChild(divider);
        menu.appendChild(item);
      }, 0);
    }
  }, true); // 使用捕获阶段，确保在原 handler 之前执行

})();
