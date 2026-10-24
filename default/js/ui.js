/* ============================================
 * CloudMusic ui.js — 渲染基础层
 * Toast / 模态框 / 右键菜单框架 / 标题栏 / Tab / 底栏图标
 * 当前曲目信息与封面 / 专辑卡片 / 曲目行渲染 / 即时播放
 * （页面级渲染模块拆分至 ui-*.js，此处仅保留跨模块共享部分）
 * ============================================ */

(function() {
  'use strict';
  var CM = window.CloudMusic;
  var els = CM.els, state = CM.state, esc = CM.escHtml;

  /* ============================================
   * Toast
   * ============================================ */
  CM.showToast = function(title, sub, type) {
    var toast = document.createElement('div');
    toast.className = 'toast';
    var icon = type === 'success' ? CM.icons.check : type === 'error' ? CM.icons.error : CM.icons.note;
    toast.innerHTML =
      '<div class="toast-icon ' + (type || '') + '">' + icon + '</div>' +
      '<div class="toast-info"><div class="toast-title">' + esc(title) + '</div>' +
      (sub ? '<div class="toast-sub">' + esc(sub) + '</div>' : '') + '</div>';
    els.toastContainer.appendChild(toast);
    // 进场动画由 .toast 的 animation 自动播放；定时退出
    setTimeout(function() {
      toast.classList.add('removing');
      setTimeout(function() { toast.remove(); }, 320);
    }, 2600);
  };

  /* ============================================
   * 通用 HTML 片段
   * ============================================ */
  CM.loadingHTML = function(text, extraStyle) {
    return '<div class="loading-spinner"' + (extraStyle ? ' style="' + extraStyle + '"' : '') +
      '><div class="spinner"></div><span>' + (text || '加载中...') + '</span></div>';
  };
  CM.emptyHTML = function(text, icon, extraStyle) {
    return '<div class="empty-illustration"' + (extraStyle ? ' style="' + extraStyle + '"' : '') + '>' +
      (icon || CM.icons.note) + '<span>' + esc(text || '暂无内容') + '</span></div>';
  };
  CM.trackPaths = function(tracks) {
    return tracks.map(function(t) { return CM.trackPath(t); }).filter(Boolean);
  };
  /* 曲目列表 → { paths, sourceIndex }：paths 只含有效路径，sourceIndex[k] 是
     paths[k] 在**原始列表**里的下标。视图里的 data-i 一律是原始下标，而上下文
     歌单只收有效路径 —— 不做这层映射的话，列表里只要有一项没有路径，它后面
     所有行都会整体错位（表现：点这首播那首 / 双击播到下一行）。 */
  CM.trackPathPlan = function(tracks) {
    var paths = [], sourceIndex = [];
    (tracks || []).forEach(function(t, i) {
      var p = CM.trackPath(t);
      if (!p) return;
      paths.push(p);
      sourceIndex.push(i);
    });
    return { paths: paths, sourceIndex: sourceIndex };
  };
  // 从 API 响应中提取曲目数组（兼容 tracks/items 两种字段名）
  CM.respTracks = function(r) {
    return (r && (r.tracks || r.items)) || [];
  };
  // 从 API 响应中提取计数值（兼容 count/total 两种字段名）
  CM.respCount = function(r) {
    return (r && (r.count != null ? r.count : r.total)) || 0;
  };

  // 通用：播放一个"视图列表"（专辑 / 每日推荐 / 库页播放全部等）。
  // 双轨制模型：列表进上下文歌单（`_MediaLibraryContext_`）并定位播放，
  // 不再"替换当前活动歌单"——用户自己的歌单不会被顶掉内容。
  CM.playAllTracks = function(tracks, title, onDone) {
    var paths = CM.trackPaths(tracks);
    if (!paths.length) { CM.showToast('无法播放', '未找到有效文件路径', 'error'); if (onDone) onDone(false); return; }
    CM.playContextList(tracks, null, title, {
      onDone: function(ok) {
        if (ok && !onDone) CM.showToast('开始播放', (title || '全部') + ' · ' + paths.length + ' 首', 'success');
        if (onDone) onDone(ok);
      }
    });
  };

  // 通用：提取曲目路径并弹出"添加到歌单"菜单
  CM.addToPlaylistMenu = function(tracks, x, y) {
    var paths = CM.trackPaths(tracks);
    if (!paths.length) { CM.showToast('无可添加曲目', null, 'error'); return; }
    CM.showAddToPlaylistMenu(x, y, paths);
  };

  /* ============================================
   * 模态框（Promise 化）
   * resolve: 输入模式返回字符串 / 确认模式返回 true；取消返回 null
   * ============================================ */
  var modalResolve = null;
  CM.showModal = function(opts) {
    return new Promise(function(resolve) {
      if (modalResolve) { modalResolve(null); modalResolve = null; }
      modalResolve = resolve;
      els.modalTitle.textContent = opts.title || '';
      els.modalDesc.textContent = opts.desc || '';
      els.modalDesc.style.display = opts.desc ? '' : 'none';
      var hasInput = opts.input !== undefined;
      els.modalInput.style.display = hasInput ? '' : 'none';
      els.modalInput.value = hasInput ? (opts.input || '') : '';
      els.modalOk.textContent = opts.okText || '确定';
      els.modalOk.className = 'modal-btn ' + (opts.danger ? 'danger' : 'primary');
      els.modalMask.classList.add('open');
      if (hasInput) setTimeout(function() { els.modalInput.focus(); els.modalInput.select(); }, 80);
    });
  };
  CM.closeModal = function(result) {
    els.modalMask.classList.remove('open');
    if (modalResolve) { modalResolve(result); modalResolve = null; }
  };
  els.modalOk.addEventListener('click', function() {
    var hasInput = els.modalInput.style.display !== 'none';
    CM.closeModal(hasInput ? els.modalInput.value.trim() : true);
  });
  els.modalCancel.addEventListener('click', function() { CM.closeModal(null); });
  els.modalMask.addEventListener('mousedown', function(e) {
    if (e.target === els.modalMask) CM.closeModal(null);
  });
  els.modalInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') CM.closeModal(els.modalInput.value.trim());
    if (e.key === 'Escape') CM.closeModal(null);
  });
  // 确认类弹窗（没有输入框）也要能按 Esc 取消：上面的 Esc 只挂在输入框上，
  // 而确认模式下输入框是 display:none（不可聚焦）→ 之前 Esc 完全没反应。
  // 弹窗在最上层，stopImmediatePropagation 吞掉本次事件，避免同一次 Esc 把
  // 下面的队列抽屉 / 菜单 / 标签编辑器也一并关掉（Esc 一次只关一层）。
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape' || !els.modalMask.classList.contains('open')) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    CM.closeModal(null);
  });

  /* ============================================
   * 右键菜单
   * items: [{label, desc?, icon?, html?, danger?, checked?, disabled?, action?, submenu?:[...]} | {divider:true} | {label:..., isLabel:true}]
   *   desc：第二行小字说明（两行式菜单项，用于"名称 + 说明"的选项）
   *   submenu：鼠标悬停时在它右侧展开二级菜单（Windows 菜单栏式）
   * ============================================ */
  // 菜单项 → HTML。父项带 submenu 时追加箭头与 data-sub 标记；
  // 菜单内只要有一项带勾选，就给所有项留出勾选列（否则勾选会把该项文字顶偏）
  function ctxItemsHtml(items) {
    var html = '', hasCheck = false, i;
    for (i = 0; i < items.length; i++) if (items[i].checked) { hasCheck = true; break; }
    items.forEach(function(item, i) {
      if (item.divider) { html += '<div class="ctx-divider"></div>'; return; }
      if (item.isLabel) { html += '<div class="ctx-label">' + esc(item.label) + '</div>'; return; }
      var sub = item.submenu && item.submenu.length;
      var body = item.html || (item.desc
        ? '<span class="ctx-text"><span class="ctx-name">' + esc(item.label) + '</span>' +
          '<span class="ctx-desc">' + esc(item.desc) + '</span></span>'
        : '<span>' + esc(item.label) + '</span>');
      html += '<div class="ctx-item' + (item.danger ? ' danger' : '') + (item.checked ? ' checked' : '') +
        (item.disabled ? ' disabled' : '') + (sub ? ' has-sub' : '') + '" data-idx="' + i + '"' +
        (sub ? ' data-sub="1"' : '') + '>' +
        (hasCheck ? '<span class="ctx-check">' + (item.checked ? '✓' : '') + '</span>' : '') +
        (item.icon || '') + body +
        (sub ? '<span class="ctx-arrow">›</span>' : '') + '</div>';
    });
    return html;
  }

  // 事件委托：一次性绑定，避免每次 showCtxMenu 都逐项 addEventListener
  var _ctxMenuItems = null;  // 主菜单项引用（供委托回调使用）
  var _ctxSubItems = null;   // 二级菜单项引用
  var _subParentEl = null;   // 当前展开二级菜单的父项节点（避免重复重建）
  var _subHideTimer = null;  // 二级菜单延迟关闭：鼠标从父项斜向移入子菜单时不能立刻收起
  function ensureCtxMenuDelegation() {
    CM.runOnce('ctxMenuDelegation', function() {
    var onClick = function(getItems) {
      return function(e) {
        var el = e.target.closest('.ctx-item');
        if (!el) return;
        if (el.classList.contains('disabled')) return; // 禁用项不触发也不关闭菜单
        e.stopPropagation();
        var item = (getItems() || [])[parseInt(el.dataset.idx, 10)];
        if (el.dataset.sub) { showSubMenu(el, item && item.submenu); return; } // 父项：点击也展开
        CM.hideCtxMenu();
        if (item && item.action) item.action();
      };
    };
    els.ctxMenu.addEventListener('click', onClick(function() { return _ctxMenuItems; }));
    els.ctxSubMenu.addEventListener('click', onClick(function() { return _ctxSubItems; }));
    // 悬停父项即展开；移到普通项上则收起
    els.ctxMenu.addEventListener('mouseover', function(e) {
      var el = e.target.closest('.ctx-item[data-sub]');
      if (!el) { hideSubMenu(); return; }
      if (el === _subParentEl) return;
      showSubMenu(el, (_ctxMenuItems || [])[parseInt(el.dataset.idx, 10)].submenu);
    });
    els.ctxMenu.addEventListener('mouseleave', function() { scheduleHideSub(); });
    // 主菜单受 max-height 限制可滚动：滚动时子菜单不跟随父项会悬空错位，直接收起
    els.ctxMenu.addEventListener('scroll', function() { hideSubMenu(); });
    els.ctxSubMenu.addEventListener('mouseenter', function() {
      if (_subHideTimer) { clearTimeout(_subHideTimer); _subHideTimer = null; }
    });
    els.ctxSubMenu.addEventListener('mouseleave', function() { scheduleHideSub(); });
    });
  }

  function showSubMenu(parentEl, items) {
    if (!parentEl || !items || !items.length) return;
    var sub = els.ctxSubMenu;
    if (_subParentEl === parentEl && !sub.classList.contains('hidden')) return;
    if (_subHideTimer) { clearTimeout(_subHideTimer); _subHideTimer = null; }
    _ctxSubItems = items;
    _subParentEl = parentEl;
    sub.innerHTML = ctxItemsHtml(items);
    sub.classList.remove('hidden', 'removing');
    sub.style.left = '0px';
    sub.style.top = '0px';
    var GAP = 8;
    sub.style.maxHeight = Math.max(160, Math.min(window.innerHeight - GAP * 2, 460)) + 'px';
    var pr = parentEl.getBoundingClientRect();
    var sr = sub.getBoundingClientRect();
    var left = pr.right + 2;                                   // 默认贴父项右侧
    if (left + sr.width + GAP > window.innerWidth)              // 右侧放不下 → 翻到左侧
      left = Math.max(GAP, pr.left - sr.width - 2);
    var top = pr.top - 6;                                      // 与父项顶部对齐（补菜单内边距）
    if (top + sr.height + GAP > window.innerHeight)
      top = Math.max(GAP, window.innerHeight - sr.height - GAP);
    sub.style.left = left + 'px';
    sub.style.top = top + 'px';
  }

  function hideSubMenu() {
    var sub = els.ctxSubMenu;
    if (_subHideTimer) { clearTimeout(_subHideTimer); _subHideTimer = null; }
    _subParentEl = null;
    _ctxSubItems = null;
    if (sub.classList.contains('hidden')) return;
    sub.classList.add('hidden');
    sub.innerHTML = '';
  }

  function scheduleHideSub() {
    if (_subHideTimer) clearTimeout(_subHideTimer);
    _subHideTimer = setTimeout(function() { _subHideTimer = null; hideSubMenu(); }, 180);
  }

  var _ctxHideTimer = null; // hideCtxMenu 的隐藏定时器：showCtxMenu 时须清除，否则嵌套菜单会被延迟隐藏（添加到歌单闪退）
  // 菜单贴近视口边缘时自动翻转定位 + 限制高度可滚动，确保任何触发点都不会让菜单底部/顶部组件超出视口被遮挡
  CM.showCtxMenu = function(x, y, items) {
    if (_ctxHideTimer) { clearTimeout(_ctxHideTimer); _ctxHideTimer = null; }
    hideSubMenu();
    ensureCtxMenuDelegation();
    _ctxMenuItems = items;
    var menu = els.ctxMenu;
    // 构建 HTML 字符串一次性写入，避免逐项 createElement + appendChild
    menu.innerHTML = ctxItemsHtml(items);
    menu.classList.remove('hidden', 'removing');
    menu.style.left = '0px'; menu.style.top = '0px';
    // 高度限制随视口自适应，超长内容始终可滚动到达
    var GAP = 8;
    var maxH = Math.max(180, Math.min(window.innerHeight - GAP, 480));
    menu.style.maxHeight = maxH + 'px';
    var rect = menu.getBoundingClientRect();
    var mw = rect.width, mh = rect.height;
    // 水平：默认在 x 右侧展开；放不下则贴右缘
    var left = (x + mw + GAP <= window.innerWidth) ? x : Math.max(GAP, window.innerWidth - mw - GAP);
    // 垂直：默认在 y 下方展开；放不下则向上翻转（菜单整体落在触发点上方，编入视口内）
    var top;
    if (y + mh + GAP <= window.innerHeight) top = y;
    else top = Math.max(GAP, Math.min(y - mh - GAP, window.innerHeight - mh - GAP));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  };
  CM.hideCtxMenu = function() {
    hideSubMenu();
    var menu = els.ctxMenu;
    if (menu.classList.contains('hidden')) return;
    menu.classList.add('removing');
    if (_ctxHideTimer) clearTimeout(_ctxHideTimer);
    _ctxHideTimer = setTimeout(function() { _ctxHideTimer = null; menu.classList.add('hidden'); menu.classList.remove('removing'); }, 110);
  };
  document.addEventListener('mousedown', function(e) {
    if (!els.ctxMenu.contains(e.target) && !els.ctxSubMenu.contains(e.target)) CM.hideCtxMenu();
  });
  window.addEventListener('blur', function() { CM.hideCtxMenu(); });

  /* ============================================
   * 标题栏（窗口控制按钮）
   * ============================================ */
  CM.initTitlebar = function() {
    els.titlebarControls.innerHTML =
      '<button class="caption-btn" id="capMin" title="最小化"><svg viewBox="0 0 12 12"><line x1="1" y1="6" x2="11" y2="6"/></svg></button>' +
      '<button class="caption-btn" id="capMax" title="最大化/还原">' +
        '<svg viewBox="0 0 12 12" class="icon-max"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/></svg>' +
        '<svg viewBox="0 0 12 12" class="icon-restore"><rect x="1.5" y="3.5" width="7" height="7" rx="1"/><path d="M3.5 3.5v-2h7v7h-2"/></svg>' +
      '</button>' +
      '<button class="caption-btn close" id="capClose" title="关闭"><svg viewBox="0 0 12 12"><line x1="1.5" y1="1.5" x2="10.5" y2="10.5"/><line x1="10.5" y1="1.5" x2="1.5" y2="10.5"/></svg></button>';
    CM.$('capMin').addEventListener('click', function() { CM.api('window.minimize'); });
    CM.$('capMax').addEventListener('click', function() { CM.api('window.toggleMaximize'); });
    CM.$('capClose').addEventListener('click', function() { CM.api('window.close'); });
    els.titlebarDrag.addEventListener('mousedown', function(e) {
      if (e.button === 0) CM.api('window.startDrag');
    });
    els.titlebarDrag.addEventListener('dblclick', function() { CM.api('window.toggleMaximize'); });
    CM.updateMaxIcon();
    fb.on('window:stateChanged', function() {
      CM.updateMaxIcon();
      CM.pushSnapRegion();
    });
    CM.initSnapRegion();
  };

  /* Win11 贴靠布局（插件 v2 的 window.setMaximizeButtonRegion）
     把自绘最大化按钮的矩形报给宿主，在它上面悬停才会弹贴靠面板。
     矩形随窗口尺寸/最大化状态变化，用 ResizeObserver + resize 跟随（去重后上报）。
     单位是 **CSS 像素**（SDK 文档明确），与 getBoundingClientRect 一致，不要乘 DPR；
     但缩放比变化会改变物理几何，所以也监听 DPI 变化重报一次。

     **按钮被盖住时必须撤销区域**（SDK：省略 region 即撤销）：沉浸页是 fixed + z-index:200，
     盖在标题栏（z-index:100）之上，但 DOM 里按钮位置没变 —— 只按矩形去重的话，鼠标停在
     沉浸页右上角（那里是沉浸页自己的按钮）也会弹出贴靠布局。所以每次上报前先做一次
     命中测试：那个点最上层不是最大化按钮（或它被隐藏、点不在视口内）就撤销区域。 */
  CM._snapSig = '';
  CM.pushSnapRegion = function() {
    var b = CM.$('capMax');
    if (!b) return;
    var r = b.getBoundingClientRect();
    var covered = true;
    if (r.width > 0 && r.height > 0) {
      var hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      covered = !(hit && (hit === b || b.contains(hit)));
    }
    var sig = covered ? 'none'
      : Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ',' + Math.round(r.height);
    if (sig === CM._snapSig) return;
    CM._snapSig = sig;
    if (covered) CM.api('window.setMaximizeButtonRegion');   // 省略 region = 撤销
    else CM.api('window.setMaximizeButtonRegion', {
      region: {
        x: Math.round(r.left), y: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height)
      }
    });
  };
  CM.initSnapRegion = function() {
    if (CM._snapBound) return;
    CM._snapBound = true;
    if (window.ResizeObserver) {
      try {
        new ResizeObserver(function() { requestAnimationFrame(CM.pushSnapRegion); })
          .observe(document.documentElement);
      } catch (e) { /* 观察不了就只靠 resize */ }
    }
    window.addEventListener('resize', function() { requestAnimationFrame(CM.pushSnapRegion); });
    // 换显示器 / 改缩放后，窗口尺寸可能没变但按钮的物理位置变了 —— 强制重报
    if (CM.onDpiChange) CM.onDpiChange(function() { CM._snapSig = ''; requestAnimationFrame(CM.pushSnapRegion); });
    // 覆盖物一开一合也要重判（否则"被盖住"这件事没人通知我们）：
    // 沉浸页 / 标签编辑器 / 模态遮罩 / 右键菜单 —— 观察 class/style/hidden，rAF 里统一重报
    if (window.MutationObserver) {
      try {
        var mo = new MutationObserver(function() { requestAnimationFrame(CM.pushSnapRegion); });
        var watch = function(el) { if (el) mo.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] }); };
        watch(document.body);
        watch(CM.els.npOverlay); watch(CM.els.tagEditorOverlay); watch(CM.els.modalMask);
        watch(CM.els.ctxMenu); watch(CM.els.ctxSubMenu);
      } catch (e) { /* 观察不了就退化成只在 resize/DPI 时重判 */ }
    }
    // 首帧布局可能还没稳定（字体/封面加载会改变标题栏），稍后再报一次
    setTimeout(CM.pushSnapRegion, 500);
    setTimeout(CM.pushSnapRegion, 2000);
  };
  CM.updateMaxIcon = function() {
    CM.api('window.isMaximized').then(function(r) {
      var btn = CM.$('capMax');
      if (btn && r) btn.classList.toggle('is-max', !!r.maximized || r.isMaximized === true || r.result === true);
    });
  };

  /* ============================================
   * Tab 切换
   * ============================================ */
  var TAB_IDS = { discover: 'tabDiscover', playlist: 'tabPlaylist', library: 'tabLibrary', search: 'tabSearch', qqmusic: 'tabQqmusic', netease: 'tabNetease', bilibili: 'tabBilibili', settings: 'tabSettings' };
  // 缓存 Tab 相关 DOM（静态元素，无需每次 switchTab 都查询）
  var _tabNavItems, _tabMainTabs, _tabContents;
  CM.switchTab = function(tab) {
    if (!TAB_IDS[tab]) return;
    state.currentTab = tab;
    // 批量选择只属于播放列表页：切到其他页时清掉 —— 否则 fixed 定位的批量栏
    // 会悬浮在其他标签页上，还能对已经看不见的歌单执行"从歌单删除"
    if (tab !== 'playlist' && state.batchSelected.size > 0) CM.clearBatchSelection();
    CM.settings.tab = tab;
    CM.saveSettings();
    if (!_tabNavItems) _tabNavItems = document.querySelectorAll('.nav-item[data-tab]');
    if (!_tabMainTabs) _tabMainTabs = document.querySelectorAll('.main-tab[data-tab]');
    if (!_tabContents) _tabContents = document.querySelectorAll('.tab-content');
    _tabNavItems.forEach(function(el) { el.classList.toggle('active', el.dataset.tab === tab); });
    _tabMainTabs.forEach(function(el) { el.classList.toggle('active', el.dataset.tab === tab); });
    _tabContents.forEach(function(el) { el.classList.toggle('active', el.id === TAB_IDS[tab]); });
    if (tab === 'playlist' && state.currentPlaylistIndex >= 0) CM.renderPlaylistView(state.currentPlaylistIndex);
    if (tab === 'library') CM.renderLibrary();
    if (tab === 'search') setTimeout(function() { els.searchInput.focus(); }, 60);
    if (tab === 'settings' && CM.renderSettings) CM.renderSettings();
  };

  /* ============================================
   * 底栏图标状态
   * ============================================ */
  CM.updatePlayPauseIcon = function(isPlaying) {
    els.iconPlay.style.display = isPlaying ? 'none' : '';
    els.iconPause.style.display = isPlaying ? '' : 'none';
  };

  var ORDER_ICONS = null; // 延迟初始化（els 尚未就绪）
  CM.updateOrderIcon = function() {
    if (!ORDER_ICONS) ORDER_ICONS = { seq: els.iconOrderSeq, loop: els.iconOrderLoop, one: els.iconOrderOne, shuffle: els.iconOrderShuffle };
    var order = CM.ORDERS[state.order] || CM.ORDERS[0];
    for (var icon in ORDER_ICONS) ORDER_ICONS[icon].style.display = order.icon === icon ? '' : 'none';
    els.btnOrder.title = '播放顺序：' + order.name;
    els.btnOrder.classList.toggle('active', order.key !== 'seq');
  };

  // 音量图标只有三档（静音 / 低于半 / 半以上）：常量化 + 按档位去重。
  // volumeChanged 事件在拖音量条时能连发几十次，原来每次都重新解析一份 SVG 的 innerHTML
  var VOL_ICONS = {
    mute: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
    low: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
    high: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'
  };
  var _volIconTier = '';
  CM.updateVolumeIcon = function() {
    var vol = state.muted ? 0 : state.volume;
    var tier = vol <= 0 ? 'mute' : (vol < 50 ? 'low' : 'high');
    if (tier !== _volIconTier) { _volIconTier = tier; els.volIcon.innerHTML = VOL_ICONS[tier]; }
    els.volSlider.value = vol;
    els.volSlider.style.setProperty('--vol-pct', vol + '%');
  };

  // 通用进度条更新（主进度条 + 沉浸式进度条共用）
  CM._updateSeekBar = function(bar, curLabel, totalLabel, cssVar, seekingFlag) {
    if (state[seekingFlag]) return;
    var pct = state.duration > 0 ? (state.position / state.duration) : 0;
    bar.value = Math.round(pct * 1000);
    bar.style.setProperty(cssVar, (pct * 100).toFixed(2) + '%');
    curLabel.textContent = CM.formatTimeCached(state.position);
    totalLabel.textContent = CM.formatTimeCached(state.duration);
  };

  CM.updateSeekUI = function() {
    CM._updateSeekBar(els.seekBar, els.seekCurrent, els.seekTotal, '--seek-pct', 'seeking');
  };

  CM.updateStopAfterIcon = function() {
    els.btnStopAfter.classList.toggle('active', state.stopAfterCurrent);
  };

  /* ============================================
   * 当前曲目信息 + 封面 + 取色
   * ============================================ */
  var DEFAULT_TRACK_COVER = CM.DEFAULT_TRACK_COVER = 'static/img/no_cover.svg';
  CM.setArtwork = function(url) {
    var next = (typeof url === 'string' && url.trim()) ? url.trim() : DEFAULT_TRACK_COVER;
    // 真实封面加载失败时回退占位图，避免无封面时闪空
    if (next !== DEFAULT_TRACK_COVER) {
      var onErr = function() {
        els.bottomArt.onerror = null;
        els.lyricsArt.onerror = null;
        if (els.npArtwork) els.npArtwork.onerror = null;
        if (els.bottomArt.getAttribute('src') !== DEFAULT_TRACK_COVER) els.bottomArt.src = DEFAULT_TRACK_COVER;
        if (els.lyricsArt.getAttribute('src') !== DEFAULT_TRACK_COVER) els.lyricsArt.src = DEFAULT_TRACK_COVER;
        if (els.npArtwork && els.npArtwork.getAttribute('src') !== DEFAULT_TRACK_COVER) els.npArtwork.src = DEFAULT_TRACK_COVER;
      };
      els.bottomArt.onerror = onErr;
      els.lyricsArt.onerror = onErr;
      if (els.npArtwork) els.npArtwork.onerror = onErr;
    } else {
      els.bottomArt.onerror = null;
      els.lyricsArt.onerror = null;
      if (els.npArtwork) els.npArtwork.onerror = null;
    }
    if (els.bottomArt.getAttribute('src') !== next) els.bottomArt.src = next;
    if (els.lyricsArt.getAttribute('src') !== next) els.lyricsArt.src = next;
    if (els.npArtwork && els.npArtwork.getAttribute('src') !== next) els.npArtwork.src = next;
    els.lyricsBlurBg.style.backgroundImage = 'url("' + next + '")';
    // 同步给小窗：在线曲目的封面只有主窗口拿得到（反查 + 下载成 dataURL），
    // 小窗自己问宿主只会得到加载不出来的代理地址
    if (CM.publishArt) {
      CM.publishArt(CM.trackPath(CM.currentTrack), next === DEFAULT_TRACK_COVER ? '' : next);
    }
    CM.extractColorFromImage(next);
  };

  CM.updateTrackInfo = function(track) {
    CM.currentTrack = track || null;
    var name = track ? CM.trackName(track) : '未在播放';
    var artist = track ? CM.trackArtist(track) : '--';
    els.bottomTitle.textContent = name;
    els.bottomTitle.title = name;
    els.bottomArtist.textContent = artist;
    els.lyricsTrackTitle.textContent = name;
    els.lyricsTrackArtist.textContent = artist;
    // duration 为 0/无效时回退到 length（如部分 .aac 流 duration=0 但 length 有效）
    var dur = track ? (track.duration || track.length) : null;
    if (track && dur != null) state.duration = dur;
    document.title = track ? (name + ' - ' + artist) : 'CloudMusic';
  };

  // 竞态防护：快速切歌时旧请求后返回会覆盖新数据，用递增 loadId 确保只有最新请求生效
  CM._artworkLoadId = 0;
  CM.loadCurrentArtwork = function() {
    var loadId = ++CM._artworkLoadId;
    CM.api('artwork.getFb2kUrl', { type: 'front', maxSize: 600 }).then(function(r) {
      if (loadId !== CM._artworkLoadId) return;
      // 宿主响应无 success 字段：{available, dataUrl, type}
      if (r && r.dataUrl && r.available !== false) CM.setArtwork(r.dataUrl);
      else CM.setArtwork(null);
    });
  };

  // 更新“喜欢”按钮（5 星 = 喜欢，与 CM.setRating / 「我喜欢的音乐」同一口径；
  // 旧实现把 4 星也算喜欢，于是 4 星时心形是亮的、那首歌却不在歌单里）
  CM._ratingLoadId = 0;
  CM.refreshLikeState = function() {
    var path = CM.trackPath(CM.currentTrack);
    if (!path) { els.likeBtn.classList.remove('liked'); return; }
    var loadId = ++CM._ratingLoadId;
    CM.api('rating.get', { path: path }).then(function(r) {
      if (loadId !== CM._ratingLoadId) return;
      var rt = r && r.success !== false ? (r.rating || 0) : 0;
      els.likeBtn.classList.toggle('liked', rt >= 5);
    });
  };

  /* ============================================
   * 批量封面（fb2k:// URL）
   * container 内查找 [data-path] 的 .art-slot 元素并填充
   * ============================================ */
  // 批量填充封面：分批请求避免大批量超时（每批 50 个）
  // 各批并行发起（原串行递归 N 批延迟 ×N），全部完成后统一结束
  CM.fillArtworkBatch = function(container, maxSize) {
    var slots = container.querySelectorAll('[data-art-path]');
    if (!slots.length) return Promise.resolve();
    var CHUNK = 50;
    // 先收集未填充的 slot：跳过已有封面的（"加载更多"重渲染时避免重复请求）
    // 注意：IMG.src 属性在未设置时返回页面基址 URL（truthy），需用 getAttribute 判断
    var pendSlots = [], pendPaths = [];
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (s.style.backgroundImage || (s.tagName === 'IMG' && s.getAttribute('src'))) continue;
      pendSlots.push(s);
      pendPaths.push(s.dataset.artPath);
    }
    if (!pendPaths.length) return Promise.resolve();
    function fillOne(el, entry) {
      if (!el || !entry) return;
      var url = entry.dataUrl || entry.url;
      if (entry.success === false || !url) return;
      if (el.tagName === 'IMG') { el.src = url; el.classList.remove('ph'); el.innerHTML = ''; }
      else { el.style.backgroundImage = 'url("' + url + '")'; el.innerHTML = ''; }
    }
    var reqs = [];
    // 并发上限 2 批：每批 50 条、宿主每条都要扫一次目录，一页 300/500 首时同时甩
    // 10 批过去会把宿主 UI 线程压住（页尺寸调大后最容易复现的"卡"就是这个）。
    var jobs = [];
    for (var start = 0; start < pendPaths.length; start += CHUNK) {
      jobs.push({ slots: pendSlots.slice(start, start + CHUNK), paths: pendPaths.slice(start, start + CHUNK) });
    }
    var nextJob = 0;
    function runJob() {
      if (nextJob >= jobs.length) return Promise.resolve();
      var job = jobs[nextJob++];
      return CM.api('artwork.getFb2kUrlByPathBatch', { paths: job.paths, type: 'front', maxSize: maxSize || 160 }).then(function(r) {
        if (r && r.artworks) r.artworks.forEach(function(entry, i) { fillOne(job.slots[i], entry); });
      }).then(runJob, runJob);
    }
    for (var w = 0; w < Math.min(2, jobs.length); w++) reqs.push(runJob());
    return Promise.all(reqs);
  };

  // 专辑卡片渲染（复用：发现页 + 媒体库全部专辑）
  // 不含封面数据；封面通过 _loadAlbumCovers 异步批量加载
  // data-album-artist 单独带出：v2 的 library.getAlbumTracks 要求传专辑行的 albumArtist
  // （逐字节比较，不能用 artist 顶替），展示仍用 artist 兜底
  CM._renderAlbumCard = function(al) {
    var albumArtist = al.albumArtist || al.artist || '';
    return '<div class="album-card fade-in" data-album="' + esc(al.name || al.album || '') +
      '" data-album-artist="' + esc(albumArtist) +
      '" data-artist="' + esc(al.artist || al.albumArtist || '') + '">' +
      '<div class="album-card-art">' +
      '<div class="art-placeholder">' + CM.icons.note + '</div>' +
      '<div class="album-card-play">' + CM.icons.play + '</div>' +
      '</div>' +
      '<div class="album-card-name">' + esc(al.name || al.album || '未知专辑') + '</div>' +
      '<div class="album-card-artist">' + esc(al.artist || al.albumArtist || '未知艺术家') + '</div>' +
      '</div>';
  };

  // 主内容区统一事件委托（专辑卡片 / dc-track / 搜索结果）
  // 一次性绑定在 els.mainContent 上，所有子元素动态渲染后自动生效
  // 挂 CM 供 ui-discover.js（搜索结果）等跨模块调用
  CM._ensureMainContentDelegation = function() {
    CM.runOnce('mainContentDelegation', function() {
    // 行所属的列表容器：renderTrackRows / 搜索结果都会把列表上下文挂在容器上
    // （_cmTracks / _cmTitle），双击与右键「播放」据此切播放上下文
    function listHostOf(el) {
      var n = el.parentElement;
      while (n && n !== els.mainContent) {
        if (n._cmTracks) return n;
        n = n.parentElement;
      }
      return null;
    }
    function rowPlayCtx(el) {
      var host = listHostOf(el);
      var i = parseInt(el.dataset.i, 10);
      if (host && !isNaN(i) && i >= 0 && i < host._cmTracks.length) {
        return { tracks: host._cmTracks, index: i, title: host._cmTitle || '' };
      }
      return { path: el.dataset.path };
    }
    // 专辑卡片：播放按钮 + 点击进详情
    els.mainContent.addEventListener('click', function(e) {
      var playBtn = e.target.closest('.album-card-play');
      if (playBtn) {
        e.stopPropagation();
        var card = playBtn.closest('.album-card');
        if (card) CM.playAlbum(card.dataset.album, card.dataset.albumArtist || card.dataset.artist);
        return;
      }
      var card = e.target.closest('.album-card');
      if (card) CM.openLibraryAlbum(card.dataset.album, card.dataset.albumArtist || card.dataset.artist);
    });
    // dc-track / search-result-item：双击播放（切播放上下文）+ 右键菜单
    els.mainContent.addEventListener('dblclick', function(e) {
      var el = e.target.closest('.dc-track[data-path], .search-result-item[data-path]');
      if (!el) return;
      CM.playRow(rowPlayCtx(el));
    });
    /* 在线曲目：鼠标一按下就开始重解析直链 —— 双击的两次按下之间足够一个往返，
       等 dblclick 才解析就要多等一次网才出声（过期地址的真实痛点在"等"）。
       已新鲜的直链在这里直接返回，不发请求（见 playback-model.js 的 pathFreshness）。 */
    els.mainContent.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      var el = e.target.closest('.dc-track[data-path], .search-result-item[data-path]');
      if (!el || !CM.prefetchOnlinePath) return;
      var ctx = rowPlayCtx(el);
      var raw = ctx.tracks ? CM.trackPath(ctx.tracks[ctx.index]) : ctx.path;
      if (raw) CM.prefetchOnlinePath(raw);
    });
    els.mainContent.addEventListener('contextmenu', function(e) {
      var el = e.target.closest('.dc-track[data-path], .search-result-item[data-path]');
      if (!el) return;
      e.preventDefault();
      // 从 DOM 构造最小 track 对象（showTrackCtxMenu 只需 path + title）；
      // 带上列表上下文，右键「播放」与双击同一条路径（切上下文而不是游离曲）
      var path = el.dataset.path;
      var titleEl = el.querySelector('.dc-track-title, .search-result-title');
      var ctx = rowPlayCtx(el);
      ctx.path = path;
      CM.showTrackCtxMenu(e.clientX, e.clientY, { absolutePath: path, title: titleEl ? titleEl.textContent : '' }, ctx);
    });
    });
  };

  // 专辑卡片事件委托（实际由 _ensureMainContentDelegation 统一处理，保留空函数兼容旧调用）
  CM._bindAlbumCards = function(container) {
    CM._ensureMainContentDelegation();
  };

  // 批量加载专辑封面。
  // v2 起 library.getAlbums 的行自带首曲路径（firstTrackAbsolutePath / firstTrackPath），
  // 直接用它即可 —— 旧的「逐张专辑调 library.getAlbumTracks 取首曲」写法有两个问题：
  //   ① 参数 artist / limit 在 v2 属于未声明键，调用被整体拒绝（INVALID_PARAMS）；
  //   ② 几百张专辑就是几百次宿主调用。
  // 每批 50 条与 fillArtworkBatch 的分片一致，避免一次上百条进封面批接口。
  CM._loadAlbumCovers = function(container, albums, maxSize) {
    if (!albums || !albums.length) return;
    var cards = container.querySelectorAll('.album-card');
    if (!cards.length) return;
    var slots = [], paths = [];
    var n = Math.min(albums.length, cards.length);
    for (var i = 0; i < n; i++) {
      var al = albums[i] || {};
      var p = al.firstTrackAbsolutePath || al.firstTrackPath || '';
      if (!p) continue;
      // 封面要挂在 .art-placeholder 上（它带 background-size:cover 等样式），
      // 挂到外层 .album-card-art 会被占位图标盖住 —— 与 fillArtworkBatch 的做法一致
      var artEl = cards[i].querySelector('.art-placeholder') || cards[i].querySelector('.album-card-art');
      if (!artEl) continue;
      slots.push(artEl);
      paths.push(p);
    }
    if (!paths.length) return;
    // 分批请求封面：每批 50 张，最多 3 批并发 —— 全串行要等 N 个往返
    //（500 张专辑 = 10 次，每次都等前一批回来），全并行又会把 N×50 次目录扫描
    // 同时压给宿主的 UI 线程，所以取一个折中（fillArtworkBatch 是纯并行，
    // 那边一批最多几十个；专辑页可能是几百张，需要限流）。
    var CHUNK = 50, MAX_CONCURRENT = 3;
    var jobs = [];
    for (var s = 0; s < paths.length; s += CHUNK) {
      jobs.push({ slots: slots.slice(s, s + CHUNK), paths: paths.slice(s, s + CHUNK) });
    }
    var nextJob = 0;
    function runJob() {
      if (nextJob >= jobs.length) return Promise.resolve();
      var job = jobs[nextJob++];
      return CM.api('artwork.getFb2kUrlByPathBatch', { paths: job.paths, type: 'front', maxSize: maxSize || 320 }).then(function(r) {
        if (!r || !r.artworks) return;
        r.artworks.forEach(function(entry, j) {
          var el = job.slots[j];
          if (!el || !entry) return;
          var url = entry.dataUrl || entry.url;
          if (entry.success === false || !url) return;
          el.style.backgroundImage = 'url("' + url + '")';
          el.innerHTML = '';
        });
      }).then(runJob, runJob);
    }
    var workers = [];
    for (var w = 0; w < Math.min(MAX_CONCURRENT, jobs.length); w++) workers.push(runJob());
    return Promise.all(workers);
  };

  // v2：library.getAlbumTracks 的必填参数是 album + albumArtist（专辑行的值，逐字节比较）
  CM.playAlbum = function(album, albumArtist) {
    CM.showToast('正在加载', '正在获取专辑「' + album + '」...', null);
    CM.api('library.getAlbumTracks', { album: album, albumArtist: albumArtist || '' }).then(function(r) {
      var tracks = CM.respTracks(r);
      if (!tracks.length) { CM.showToast('无法播放', '未找到专辑曲目', 'error'); return; }
      CM.playAllTracks(tracks, '专辑 ' + album);
    });
  };

  // 打开专辑详情视图（媒体库下钻）
  CM.openLibraryAlbum = function(album, albumArtist) {
    CM.openLibraryDetail('album', { album: album, albumArtist: albumArtist || '', artist: albumArtist || '' });
  };

  // 通用媒体库下钻导航（切换到媒体库标签页并设置视图）
  CM.openLibraryDetail = function(view, arg) {
    // 进入下钻详情前保存列表滚动位置，返回时恢复
    state.libScrollTop = els.libraryDetail.scrollTop;
    state.libraryView = view;
    state.libraryArg = arg;
    if (state.currentTab === 'library') {
      CM.renderLibrary();
    } else {
      CM.switchTab('library'); // switchTab 内部会调用 renderLibrary()
    }
  };

  // 注：旧的「单曲即时播放 playNow（加入队列顶部并 next）」已并入
  // playback-model.js —— 统一入口是 CM.playRow（按行所属列表切上下文）与
  // CM.playNowPath（游离曲：插队后立即播放）。不要再在 ui.js 里重开一份。

  CM.renderTrackRows = function(container, tracks, emptyText, startIdx, listCtx) {
    // 列表上下文：双击 / 右键「播放」要按"这一行属于哪个列表"来切播放上下文
    // （媒体库视图、发现页列表、搜索结果都是视图列表，见 playback-model.js 的 playContextList）。
    // listCtx = {tracks: 完整列表, title: 列表名}；分页渲染时 container 里只有一页，
    // 但 data-i 用的是完整列表下标，所以上下文必须另存完整列表。
    if (container) {
      container._cmTracks = (listCtx && listCtx.tracks) || tracks || [];
      container._cmTitle = (listCtx && listCtx.title) || '';
    }
    if (!tracks.length) {
      container.innerHTML = CM.emptyHTML(emptyText);
      return;
    }
    startIdx = startIdx || 0;
    var curPath = CM.trackPath(CM.currentTrack);
    // 预转义曲目字段，避免循环内重复调用 esc()
    var escTracks = tracks.map(function(t) {
      var p = CM.trackPath(t);
      return {
        raw: p,
        path: esc(p),
        name: esc(CM.trackName(t)),
        sub: esc(CM.trackArtist(t)) + (t.album ? ' · ' + esc(t.album) : ''),
        duration: CM.formatTime(t.duration)
      };
    });
    var parts = [];
    escTracks.forEach(function(t, i) {
      // 播放行比较必须用原始路径：t.path 已被 esc() 转义（& → &amp; 等），
      // 拿它与原始 curPath 比较会让含 &/<>/"/ 的路径永远不高亮
      parts.push(
        '<div class="dc-track fade-in' + (curPath && t.raw === curPath ? ' playing' : '') + '" data-path="' + t.path + '" data-i="' + (startIdx + i) + '">' +
        '<span class="dc-track-idx">' + (startIdx + i + 1) + '</span>' +
        '<div class="dc-track-art ph" data-art-path="' + t.path + '">' + CM.icons.note + '</div>' +
        '<div class="dc-track-info">' +
        '<div class="dc-track-title">' + t.name + '</div>' +
        '<div class="dc-track-sub">' + t.sub + '</div>' +
        '</div>' +
        '<span class="dc-track-dur">' + t.duration + '</span>' +
        '</div>'
      );
    });
    container.innerHTML = parts.join('');
    // 登记本次渲染标记的播放行，供 refreshPlayingMarks 切换时清除（避免旧行残留高亮）
    if (curPath) {
      var _dc = container.querySelector('.dc-track.playing');
      if (_dc) CM._lastPlayingDc = _dc;
    }
    CM.fillArtworkBatch(container, 120);
    CM._ensureMainContentDelegation(); // 事件由 mainContent 统一委托
  };
})();
