/* ============================================
 * CloudMusic ui-library.js — 媒体库
 * 库树导航 / 概览统计 / 艺术家·流派·专辑网格
 * 文件夹浏览（面包屑/子目录） / 下钻详情 / 客户端分页
 * ============================================ */

(function() {
  'use strict';
  var CM = window.CloudMusic;
  var els = CM.els, state = CM.state, esc = CM.escHtml;
  var wildValue = CM.wildValue;

  /* libraryDetail 渲染代际号：每次进入视图渲染函数时递增，异步回包写 DOM 前
   * 校验代际 —— 慢响应（点开艺术家 A 后马上点 B，A 的回包后到）不得覆盖
   * 已切换到的新视图，否则"播放全部"等按钮还会绑着旧数据集。 */
  var _libSeq = 0;
  function libBegin() {
    var seq = ++_libSeq;
    return function() { return seq === _libSeq; };
  }
  // 多值标签匹配：SDK 1.13 起 GENRE / ARTIST 等可能返回数组（["流行","电子"]），
  // 也可能以 "; " 连接成单字符串返回
  function tagMatch(v, expected) {
    if (v == null || expected == null) return false;
    if (Array.isArray(v)) return v.indexOf(expected) >= 0;
    var s = String(v);
    if (s === expected) return true;
    return s.split(/\s*;\s*/).indexOf(expected) >= 0;
  }

  /* ============================================
   * 媒体库
   * ============================================ */
  var LIB_NODES = [
    { id: 'stats', name: '概览', icon: CM.icons.info },
    { id: 'tracks', name: '歌曲', icon: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>' },
    { id: 'artists', name: '艺术家', icon: '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
    { id: 'albums', name: '专辑', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>' },
    { id: 'genres', name: '流派', icon: '<svg viewBox="0 0 24 24"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>' },
    { id: 'folders', name: '文件夹', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>' }
  ];

  // 媒体库树节点缓存 + 事件委托（避免每次 renderLibrary 都 querySelectorAll + 逐节点绑事件）
  var _libTreeNodes = null;
  CM.renderLibrary = function() {
    if (!_libTreeNodes) {
      var html = '';
      LIB_NODES.forEach(function(n) {
        html += '<div class="tree-node' + (state.libraryView === n.id ? ' active' : '') + '" data-view="' + n.id + '">' + n.icon + '<span>' + n.name + '</span></div>';
      });
      els.libraryTree.innerHTML = html;
      _libTreeNodes = els.libraryTree.querySelectorAll('.tree-node');
    }
    // 事件委托：一次性绑定在 libraryTree 上
    CM.runOnce('libTreeDelegation', function() {
      els.libraryTree.addEventListener('click', function(e) {
        var el = e.target.closest('.tree-node');
        if (!el) return;
        state.libraryView = el.dataset.view;
        state.libraryArg = null;
        state.libScrollRestore = false; // 主动切节点不是"返回列表"，不恢复旧滚动位置
        CM.renderLibrary();
      });
    });
    // 后续切换只更新 active 状态，无需 querySelectorAll
    _libTreeNodes.forEach(function(el) {
      var v = state.libraryView === 'folder' ? 'folders' : state.libraryView;
      el.classList.toggle('active', el.dataset.view === v);
    });
    var view = state.libraryView;
    if (view === 'stats') CM.renderLibraryStats();
    else if (view === 'tracks') CM.renderLibraryTracks();
    else if (view === 'artists') CM.renderLibraryArtists();
    else if (view === 'albums') CM.renderLibraryAlbums();
    else if (view === 'genres') CM.renderLibraryGenres();
    else if (view === 'artist') CM.renderLibraryArtistDetail(state.libraryArg);
    else if (view === 'album') CM.renderLibraryAlbumDetail(state.libraryArg);
    else if (view === 'genre') CM.renderLibraryGenreDetail(state.libraryArg);
    else if (view === 'folders') CM.renderLibraryFolders();
    else if (view === 'folder') CM.renderLibraryFolder(state.libraryArg);
  };

  // 延迟加载指示器：API 快速返回（<150ms）时不闪烁，保留旧内容
  // 返回一个 cancel 函数，在 API 回调中调用以取消转圈
  CM.libLoadingDelayed = function() {
    return CM.delayedLoading(function() {
      els.libraryDetail.innerHTML = CM.loadingHTML();
    });
  };
  // 内容淡入：同步 reflow 模式，避免 innerHTML 后内容先以 opacity:1 渲染再变透明导致的闪烁
  // 原理：add(lib-transparent) 瞬间隐藏 → reflow 记录状态 → remove 触发 transition
  CM.libFadeIn = function() {
    var el = els.libraryDetail;
    el.classList.add('lib-transparent');
    void el.offsetHeight; // 强制 reflow，确保浏览器记录 opacity:0
    el.classList.remove('lib-transparent'); // 恢复，触发 0.2s transition
  };
  CM.libError = function(retry) {
    els.libraryDetail.innerHTML = '<div class="section-error">' + CM.icons.error + '<span>加载失败，媒体库可能未就绪</span><button class="retry-btn">重试</button></div>';
    var btn = els.libraryDetail.querySelector('.retry-btn');
    if (btn && retry) btn.addEventListener('click', retry);
  };
  // 从下钻详情返回列表时恢复滚动位置（专辑/艺术家/流派网格通用）
  CM._restoreLibScroll = function() {
    if (state.libScrollRestore) {
      state.libScrollRestore = false;
      els.libraryDetail.scrollTop = state.libScrollTop || 0;
    }
  };

  CM.renderLibraryStats = function() {
    var isCurrent = libBegin();
    var cancelLoading = CM.libLoadingDelayed();
    CM.api('library.getStats').then(function(r) {
      if (!isCurrent()) { cancelLoading(); return; }
      cancelLoading();
      if (!r || r.success === false) { CM.libError(CM.renderLibraryStats); return; }
      var durText = '';
      var totalSec = r.totalDuration || 0;
      if (totalSec >= 3600) durText = (totalSec / 3600).toFixed(1) + ' 小时';
      else durText = Math.round(totalSec / 60) + ' 分钟';
      var statCards = [
        [r.totalTracks || 0, '曲目'],
        [r.totalAlbums || 0, '专辑'],
        [r.totalArtists || 0, '艺术家'],
        [durText, '总时长'],
        [CM.formatSize(r.totalSize), '总大小']
      ].map(function(c) {
        return '<div class="stat-card"><div class="stat-value">' + c[0] + '</div><div class="stat-label">' + c[1] + '</div></div>';
      }).join('');
      els.libraryDetail.innerHTML =
        '<div class="library-stats">' + statCards + '</div>' +
        // 播放统计（foo_playcount；未装 / 全 0 时保持为空，不摆一块 0 0 0 的空架子）
        '<div class="library-stats" id="libPlayStats"></div>' +
        '<div style="display:flex;align-items:center;gap:12px;margin:18px 0 14px">' +
        '<div class="library-section-title" style="margin:0">最近添加</div>' +
        '<button class="pl-btn" id="libAddAllBtn" style="margin-left:auto">' +
        '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>添加全部到歌单</span></button>' +
        '</div>' +
        '<div class="dc-tracklist" id="libRecentRows"></div>';
      CM.libFadeIn();
      CM._restoreLibScroll(); // 从下钻详情返回概览时同样恢复滚动位置
      // 播放统计异步回填：playcount.getStats（2.2.0，需 foo_playcount）。
      // 全零（没装组件 / 新装库一首没播）就不显示
      CM.api('playcount.getStats').then(function(sr) {
        if (!isCurrent() || !sr || sr.success === false) return;
        if (!sr.totalPlayCount && !sr.playedTracks) return;
        var box = CM.$('libPlayStats');
        if (sr.playedTracks) fillTopPlayed();   // 有播放记录就接着排「最常播放」（统计行画不出来也不拦它）
        if (!box) return;
        var avg = (sr.averageRating != null && sr.averageRating > 0) ? (Math.round(sr.averageRating * 10) / 10) + ' ★' : '—';
        box.innerHTML = [
          [sr.totalPlayCount || 0, '总播放次数'],
          [sr.playedTracks || 0, '已播放曲目'],
          [sr.unplayedTracks || 0, '未播放曲目'],
          [avg, '平均评分']
        ].map(function(c) {
          return '<div class="stat-card"><div class="stat-value">' + c[0] + '</div><div class="stat-label">' + c[1] + '</div></div>';
        }).join('');
      });
      var addAllBtn = CM.$('libAddAllBtn');
      if (addAllBtn) {
        var resetAddAllBtn = function() {}; // 每次点击时由 setBtnLoading 生成
        addAllBtn.addEventListener('click', function(e) {
          resetAddAllBtn = CM.setBtnLoading(addAllBtn, '加载曲目中...');
          // 已经在「全部歌曲」里拉过整库就直接用（宿主那边也留着这份列表）——
          // 以前这里会为了"添加全部"再整套重拉一遍
          if (_songsCache && _songsCache.tracks.length) {
            var cachedPaths = CM.trackPaths(_songsCache.tracks);
            resetAddAllBtn();
            if (!cachedPaths.length) { CM.showToast('未找到曲目路径', null, 'error'); return; }
            CM.showAddToPlaylistMenu(e.clientX, e.clientY, cachedPaths);
            return;
          }
          CM.api('library.getCount').then(function(cr) {
            if (!cr) { resetAddAllBtn(); CM.showToast('加载失败', null, 'error'); return; }
            var total = CM.respCount(cr);
            if (!total) { resetAddAllBtn(); CM.showToast('媒体库为空', null, 'error'); return; }
            var pageSize = 2000, collected = [], pos = 0;
            function fetchPage() {
              // v2：分页参数名是 offset / limit（旧名 start / count 属未声明键，会被整个拒绝）
              CM.api('library.getAll', { offset: pos, limit: Math.min(pageSize, total - pos) }).then(function(pr) {
                if (!pr) { resetAddAllBtn(); CM.showToast('加载失败', null, 'error'); return; }
                var batch = CM.respTracks(pr);
                collected = collected.concat(batch);
                pos += batch.length;
                if (pos < total && batch.length > 0) { fetchPage(); return; }
                resetAddAllBtn();
                var paths = CM.trackPaths(collected);
                if (!paths.length) { CM.showToast('未找到曲目路径', null, 'error'); return; }
                CM.showAddToPlaylistMenu(e.clientX, e.clientY, paths);
              });
            }
            fetchPage();
          });
        });
      }
      CM.api('library.getRecentlyAdded', { limit: 10 }).then(function(rr) {
        if (!isCurrent()) return;
        var box = CM.$('libRecentRows');
        if (box) {
          var recent = CM.respTracks(rr);
          CM.renderTrackRows(box, recent, '暂无曲目', 0, { tracks: recent, title: '最近添加' });
        }
      });

      /* 最常播放（playcount.getBatch，2.2.0 + foo_playcount）：全库按播放次数排
         Top 10，整节由这里异步追加在「最近添加」之后。没有播放记录时统计行那边
         不会调它 —— 整节不出现，不留空壳。每次进概览都重算：播放次数是活数据，
         播一首就变，不值得为它再做一套缓存失效。paths 收原生路径（同
         CM.getPlaycounts），实测 494 条一发全回且序与给定一致；分段只为超大库兜底。 */
      function fillTopPlayed() {
        var gone = function() { return !isCurrent() || !CM.$('libTopRows'); };
        var secHead = document.createElement('div');
        secHead.style.cssText = 'display:flex;align-items:center;gap:12px;margin:18px 0 14px';
        secHead.innerHTML = '<div class="library-section-title" style="margin:0">最常播放</div>';
        var rowsBox = document.createElement('div');
        rowsBox.className = 'dc-tracklist';
        rowsBox.id = 'libTopRows';
        els.libraryDetail.appendChild(secHead);
        els.libraryDetail.appendChild(rowsBox);
        function paintTop(tracks, rows) {
          var box = CM.$('libTopRows');
          if (!box || !isCurrent()) return;
          var scored = [];
          for (var i = 0; i < tracks.length; i++) {
            var pc = rows[i] && rows[i].playCount;
            if (pc > 0) scored.push({ t: tracks[i], pc: pc, i: i });
          }
          if (!scored.length) return;   // 有 playedTracks 兜底才进来；真没有就安静收场
          // 次数降序，同次数按库序 —— 排序必须确定，否则两次进概览 Top 榜会抖
          scored.sort(function(a, b) { return b.pc - a.pc || a.i - b.i; });
          var top = scored.slice(0, 10).map(function(s) { return s.t; });
          CM.renderTrackRows(box, top, '暂无播放记录', 0, { tracks: top, title: '最常播放' });
        }
        function afterTracks(tracks) {
          if (gone() || !tracks || !tracks.length) return;
          var native = tracks.map(function(t) {
            var p = String(CM.trackPath(t) || '').replace(/^file:\/\/\/?/i, '');
            try { p = decodeURIComponent(p); } catch (e) {}
            return p;
          });
          var CH = 2000, pos = 0, rows = new Array(native.length);
          (function next() {
            if (gone()) return;
            if (pos >= native.length) return paintTop(tracks, rows);
            var seg = native.slice(pos, pos + CH);
            CM.api('playcount.getBatch', { paths: seg }).then(function(rb) {
              var got = (rb && rb.results) || [];
              for (var i = 0; i < seg.length; i++) rows[pos + i] = got[i] || null;
              pos += seg.length;
              next();
            });
          })();
        }
        if (_songsCache && _songsCache.tracks && _songsCache.tracks.length) return afterTracks(_songsCache.tracks);
        CM.api('library.getCount').then(function(cr) {
          if (gone()) return;
          var total = (cr && cr.success !== false) ? CM.respCount(cr) : 0;
          if (!total) return;
          var collected = [], pos = 0, PAGE = 2000;
          (function page() {
            if (gone()) return;
            CM.api('library.getAll', { offset: pos, limit: Math.min(PAGE, total - pos) }).then(function(pr) {
              var batch = pr ? CM.respTracks(pr) : [];
              collected = collected.concat(batch);
              pos += batch.length;
              if (pos < total && batch.length) { page(); return; }
              if (collected.length === total) _songsCache = { total: total, tracks: collected };   // 顺手喂给「全部歌曲」的缓存
              afterTracks(collected);
            });
          })();
        });
      }
    });
  };

  // 通用卡片网格渲染（艺术家 / 流派共用；传入 pageKey 则启用客户端分页）
  CM._renderLibraryGrid = function(apiMethod, apiParams, title, emptyText, cardRenderer, pageKey) {
    var isCurrent = libBegin();
    var cancelLoading = CM.libLoadingDelayed();
    CM.api(apiMethod, apiParams).then(function(r) {
      if (!isCurrent()) { cancelLoading(); return; }
      cancelLoading();
      if (!r || r.success === false) { CM.libError(function() { CM._renderLibraryGrid(apiMethod, apiParams, title, emptyText, cardRenderer, pageKey); }); return; }
      var items = r.items || r.artists || r.genres || [];
      if (!items.length) { els.libraryDetail.innerHTML = CM.emptyHTML(emptyText); return; }
      if (pageKey) {
        els.libraryDetail.innerHTML = CM._pagerBarHtml('libGrid', title, items.length) + '<div class="artist-grid" id="libGridRows"></div>';
        CM._bindPager('libGrid', items.length, pageKey, function(start, size) {
          var box = CM.$('libGridRows');
          if (!box) return;
          var parts = [];
          items.slice(start, start + size).forEach(function(a) {
            var name = typeof a === 'string' ? a : (a.name || a.artist || a.genre || '');
            var count = typeof a === 'object' ? (a.trackCount || a.count || '') : '';
            if (!name) return;
            parts.push(cardRenderer(name, count));
          });
          box.innerHTML = parts.join('');
        });
      } else {
        var parts = ['<div class="library-section-title" style="margin-top:0">' + title + '（' + items.length + '）</div><div class="artist-grid">'];
        items.forEach(function(a) {
          var name = typeof a === 'string' ? a : (a.name || a.artist || a.genre || '');
          var count = typeof a === 'object' ? (a.trackCount || a.count || '') : '';
          if (!name) return;
          parts.push(cardRenderer(name, count));
        });
        parts.push('</div>');
        els.libraryDetail.innerHTML = parts.join('');
      }
      CM.libFadeIn();
      CM._restoreLibScroll();
    });
  };

  // 媒体库详情区事件委托（艺术家/流派卡片点击，一次性绑定避免每次渲染都逐卡 attach）
  function ensureLibDetailDelegation() {
    CM.runOnce('libDetailDelegation', function() {
      els.libraryDetail.addEventListener('click', function(e) {
        var card = e.target.closest('.artist-card');
        if (!card) return;
        if (card.dataset.artist) CM.openLibraryDetail('artist', card.dataset.artist);
        else if (card.dataset.genre) CM.openLibraryDetail('genre', card.dataset.genre);
      });
    });
  }

  CM.renderLibraryArtists = function() {
    ensureLibDetailDelegation();
    CM._renderLibraryGrid('library.getArtists', { limit: 1000000 }, '全部艺术家', '媒体库为空',
      function(name, count) {
        return '<div class="artist-card" data-artist="' + esc(name) + '">' +
          '<div class="artist-avatar">' + esc(name.charAt(0).toUpperCase()) + '</div>' +
          '<div class="artist-name">' + esc(name) + '</div>' +
          (count ? '<div class="artist-meta">' + count + ' 首曲目</div>' : '') +
          '</div>';
      },
      'artists'
    );
  };

  // 全量曲目缓存：切走再切回「歌曲」时先用上次结果直接渲染，后台再核对总数 ——
  // 三千首每次切进来都重拉一遍（6 次 500 条）就是用户报的"切媒体库卡死"。
  var _songsCache = null;   // { total, tracks }
  CM.invalidateSongsCache = function() { _songsCache = null; };
  // 整库单次请求被宿主拒绝时只提示一次（避免每进一次「全部歌曲」刷一条 warn）
  var _fullLoadWarned = false;

  // 媒体库自动更新（宿主 2.1.0+ 的常驻订阅）：library:itemsAdded/Removed/Modified
  // 在条目真正落盘时广播（library.refresh 只是"排队重扫"，官方文档没有完成事件，
  // 点击后立即重拉拿到的还是旧库）。fromHook=true = 播放统计/评分类回填
  // （foo_playcount 写库），不该触发重画 —— 只认真实的内容变化。页面重载后随
  // 本模块重新挂载，无时间窗。2.0.0 的事件不带 fromHook（该判断恒不生效），
  // 统计写库引发的重画由下面的交互避让兜底。
  // 用户正在操作列表（连点/滚动/翻页）时推迟重画：事件驱动的整页重绘会打断双击
  // （DOM 在两次 click 之间被换掉，第二下落到别的行上）并甩走滚动位置。
  // 2.2.0 增量补丁：事件载荷自带受影响条目的 handles（原生路径）——按类型攒起来，
  // settle 时只 library.getTracks 这几首、原地替换/追加/删除 _songsCache，再走
  // renderLibraryTracks 的缓存快路径重画（补丁后的总数与宿主一致 → 不整库重拉；
  // 对不上会自动 fetchAll 自愈）。任何一条事件截断 / 不带 handles / 缓存不在 /
  // 累计 handles 超 5000（官方单次上限，超了整单被拒）/ getTracks 失败 → 回落
  // 整库重拉，自愈兜底与旧路径完全一致。
  var _libUserAt = 0;
  (function installLibraryWatcher() {
    if (!fb || typeof fb.on !== 'function') return;
    CM.runOnce('libUserActivity', function() {
      ['mousedown', 'dblclick', 'wheel', 'keydown', 'scroll'].forEach(function(ev) {
        els.libraryDetail.addEventListener(ev, function() { _libUserAt = Date.now(); }, { passive: true });
      });
    });
    // 事件 handles 是原生路径；缓存行存 file:// 形态 —— 两侧统一归一成小写反斜杠键
    function keyOf(p) { return String(p || '').replace(/^file:\/\/\/?/i, '').replace(/\//g, '\\').toLowerCase(); }
    var pendAdd = {}, pendMod = {}, pendDel = {};   // 归一键 → 原始 handle（最后一次为准）
    var pendFull = false;                            // 任一事件截断 / 不带 handles → 本轮放弃增量
    function fullReload(onTracks) {
      CM.invalidateSongsCache();
      // 只在用户还停在「歌曲」列表时重画；切走就只丢缓存，下次进来自动重拉。
      // 重画不甩走滚动位置：记住 scrollTop，renderLibraryDrill 末尾经 _restoreLibScroll
      // 恢复（页码本来就走 state.libPages，事件重画不掉页）
      if (onTracks) CM.renderLibraryTracks();
    }
    function doSettle() {
      // 桶里存的是原始 handle，别把归一键发给 getTracks（官方按路径匹配虽不区分
      // 大小写，但回传原始形态才不依赖这个实现细节）
      var add = Object.values(pendAdd), mod = Object.values(pendMod), del = Object.values(pendDel);
      var full = pendFull;
      pendAdd = {}; pendMod = {}; pendDel = {}; pendFull = false;
      if (CM.invalidateSearchSuggest) CM.invalidateSearchSuggest();   // 搜索联想的值缓存一并失效
      if (CM.npFlowInvalidate) CM.npFlowInvalidate();                 // 沉浸页专辑河流的专辑缓存一并失效
      var onTracks = state.currentTab === 'library' && state.libraryView === 'tracks';
      if (onTracks) {
        state.libScrollRestore = true;
        state.libScrollTop = els.libraryDetail.scrollTop;
      }
      // 增量补丁的前提：缓存还在 + 这批事件全部带 handles 且没截断 + 宿主支持 getTracks
      var patchable = !full && _songsCache && _songsCache.tracks.length &&
        (add.length || mod.length || del.length) && CM.caps.has('library.getTracks');
      if (!patchable) return fullReload(onTracks);
      // 官方 getTracks 单次 ≤5000 handles，超了整单被拒 —— 与其白打一枪留一条
      // console.warn，不如直接走整库回落（批量导入本就会带截断事件）
      if (add.length + mod.length + del.length > 5000) return fullReload(onTracks);
      CM.api('library.getTracks', { handles: add.concat(mod, del) }).then(function(r) {
        // 查询失败 → 整库兜底，绝不做半截补丁
        var got = (r && r.success !== false) ? (CM.respTracks(r) || []) : null;
        if (!got) return fullReload(onTracks);
        var byKey = {};
        got.forEach(function(t) { byKey[keyOf(CM.trackPath(t))] = t; });
        var cache = _songsCache.tracks;
        var map = {};
        cache.forEach(function(t, i) { map[keyOf(CM.trackPath(t))] = i; });
        var changed = false;
        // add/mod/del 这时是原始 handle，对号入座前先归一成缓存同款键
        del.forEach(function(h) {
          var k = keyOf(h);
          if (map[k] != null) { cache[map[k]] = null; changed = true; }   // 标删，最后统一压掉
        });
        add.concat(mod).forEach(function(h) {
          var k = keyOf(h);
          var t = byKey[k];
          if (!t) return;                              // 已删 / 查不回的（同批删除）不算数
          if (map[k] != null) { cache[map[k]] = t; changed = true; }
          else { cache.push(t); map[k] = cache.length - 1; changed = true; }
        });
        if (!changed) return;                          // 键都对不上号 → 不重画，下次整库核对自愈
        _songsCache.tracks = cache.filter(Boolean);
        _songsCache.total = _songsCache.tracks.length;
        // 补丁成功才在这里重画（走缓存快路径：零等待重画 + 总数一致不整库重拉）
        if (onTracks) CM.renderLibraryTracks();
      });
    }
    var settle = CM.debounce(function() {
      if (Date.now() - _libUserAt < 4000) { setTimeout(settle, 2500); return; }   // 正在操作：稍后再试
      doSettle();
    }, 1500);
    function onLibChange(kind, e) {
      if (e && e.fromHook) return;
      var hs = (e && e.handles) || null;
      // 截断事件同样要排程 settle：官方文档明确 truncated 时省略 handles，批量
      // 变更的最后一条常常就是它 —— 只设标记不排程的话这轮增量就永远不收敛了
      if (!hs || !hs.length || (e && e.truncated)) { pendFull = true; settle(); return; }
      var bucket = kind === 'add' ? pendAdd : (kind === 'mod' ? pendMod : pendDel);
      hs.forEach(function(h) { bucket[keyOf(h)] = h; });
      settle();
    }
    [
      ['library:itemsAdded', 'add'],
      ['library:itemsRemoved', 'del'],
      ['library:itemsModified', 'mod']
    ].forEach(function(pair) {
      try { fb.on(pair[0], function(e) { onLibChange(pair[1], e); }); } catch (e) {}
    });
  })();

  // 全部歌曲视图：分页加载全部曲目
  CM.renderLibraryTracks = function() {
    state.libraryBack = 'stats';
    var isCurrent = libBegin();
    var cancelLoading = CM.libLoadingDelayed();
    function paint(tracks, total) {
      if (!isCurrent()) return;
      cancelLoading();
      // 客户端按路径稳定排序：插件 2.1.0 实测 library.getAll 每次重取的顺序可能
      // 不同（播一首 → foo_playcount 写库 → 重取 → 中段重排），视图行会在用户
      // 眼皮底下换位置，双击就播到别的歌。固定按路径排序后，重取多少次行都不动。
      tracks.sort(function(a, b) {
        var pa = (CM.trackPath(a) || '').toLowerCase();
        var pb = (CM.trackPath(b) || '').toLowerCase();
        return pa < pb ? -1 : pa > pb ? 1 : 0;
      });
      CM.renderLibraryDrill('全部歌曲', total + ' 首曲目', tracks, { pageSizes: LIB_PAGE_SIZES, pageKey: 'songTracks' });
      CM.libFadeIn();
      // 追加"刷新媒体库"按钮
      var btnBar = CM.$('libAddToPlBtn');
      var btnParent = btnBar ? btnBar.parentElement : null;
      if (btnParent) {
        var refBtn = document.createElement('button');
        refBtn.className = 'pl-btn';
        refBtn.innerHTML = CM.icons.refresh + '<span>刷新媒体库</span>';
        btnParent.insertBefore(refBtn, btnParent.firstChild);
        refBtn.addEventListener('click', function() {
          var resetRefBtn = CM.setBtnLoading(refBtn, '扫描中...');
          CM.api('library.refresh').then(function(res) {
            if (res && res.success !== false) {
              // refresh 只是排队重扫，此刻重拉到的还是旧库 —— 先重画一遍；
              // 扫描落盘后条目增删改事件会到，常驻监听（installLibraryWatcher）
              // 自动补一次真刷新
              CM.showToast('已开始重新扫描', '扫描完成后歌曲列表会自动更新', 'success');
              CM.invalidateSongsCache();
              CM.renderLibraryTracks();
            } else {
              CM.showToast('刷新失败', null, 'error');
              resetRefBtn();
            }
          });
        });
      }
    }
    function fetchAll(total, done) {
      /* 宿主 v2 的 library.getAll 有两个能力以前完全没用上：
         · 一次「从 0 取到 total」的请求会被宿主**留在自己的缓存里**（useCache；
           文档原话：A request from 0 covering every track is kept either way），
           下次进「全部歌曲」直接命中，不必重建；
         · asyncResult 让宿主在自己的工作线程上建这份列表、用 library:getAllResult
           事件送回 —— 不带它就是在宿主 UI 线程上建，建的过程中 foobar 界面是冻的。
         以前按 2000 一页分两次要、也没带 asyncResult：三千首时每一页都在主线程上建，
         这才是"切媒体库卡死"的主因（一次整库回包约 1~2MB，传输本身不是瓶颈）。
         接口不存在 / 被拒（老宿主）时退回原来的分页取法。
         注意 timeout 参数：2.0.0 收、2.2.0 起不认（整单 INVALID_PARAMS，
         2026-11-14 实测）→ 不能带；慢回去的兜底靠下面的被拒分支。 */
      var lib = (typeof window !== 'undefined' && window.fb && window.fb.library) || null;
      // 超大纲不一次拿（一次要回几十万行没必要，也怕宿主自己给 limit 设了上限）
      if (lib && typeof lib.getAll === 'function' && total <= 20000) {
        lib.getAll(0, total, { useCache: true, asyncResult: true })
          .then(function(r) {
            if (!isCurrent()) return;
            if (r && r.success === false) {
              if (!_fullLoadWarned) {
                _fullLoadWarned = true;
                try { console.warn('[CloudMusic] library.getAll(整库) 被拒：' + (r.code || '') + ' ' + (r.error || '') + ' → 退回分页'); } catch (e) {}
              }
              fetchPaged(total, done);
              return;
            }
            var tracks = CM.respTracks(r);
            // 宿主把 limit 截断过（回得比 total 少）→ 按页补齐，别把半张列表当全部
            if (tracks.length >= total) { done(tracks, total); return; }
            fetchPaged(total, done);
          }, function(e) {
            if (!isCurrent()) return;
            if (!_fullLoadWarned) {
              _fullLoadWarned = true;
              try { console.warn('[CloudMusic] 整库请求失败（' + ((e && e.message) || e) + '）→ 退回分页'); } catch (e2) {}
            }
            fetchPaged(total, done);
          });
        return;
      }
      fetchPaged(total, done);
    }
    // 兜底：老宿主 / 整库请求被拒时按页取（每页 2000，三千首两次往返）
    function fetchPaged(total, done) {
      // 每页 2000：三千首只需 2 次往返（以前固定 500，要 6 次串行，全部拉完才画第一屏）。
      // v2：分页参数名是 offset / limit（旧名 start / count 会被严格校验整体拒绝）。
      var PAGE = 2000;
      var all = [];
      var offset = 0;
      var loadPage = function() {
        CM.api('library.getAll', { offset: offset, limit: Math.min(PAGE, total - offset) }).then(function(r) {
          if (!isCurrent()) return;
          if (!r || r.success === false) {
            // 第 1 页成功、后续页失败时页面上还挂着 loading：必须给出明确错误态
            // （带重试按钮），不能让"加载中"永远转下去
            if (!all.length) { cancelLoading(); CM.libError(CM.renderLibraryTracks); }
            // 只拿到一部分：按**实际拿到的条数**收尾（用 total 会让标题写着 3000 首、
            // 列表里只有 2000 行）；下次进来缓存条数对不上总数，会自动重拉
            else done(all, all.length);
            return;
          }
          var batch = CM.respTracks(r);
          for (var i = 0; i < batch.length; i++) all.push(batch[i]);
          offset += batch.length;
          if (batch.length > 0 && offset < total) { loadPage(); return; }
          // 中途回空页（offset<total 却没有行）：total 不可信，按实际条数收尾 ——
          // 缓存条数对不上总数，下次进来会自动重拉（与上面失败分支同一口径）
          done(all, all.length);
        });
      };
      loadPage();
    }

    // 有缓存：先画出来（零等待），再核对总数决定要不要重拉
    if (_songsCache && _songsCache.tracks.length) {
      paint(_songsCache.tracks, _songsCache.total);
      CM.api('library.getCount').then(function(cr) {
        if (!isCurrent()) return;
        // 失败信封 / invoke 异常都不是"媒体库为空"：宿主没答上来时缓存还在就
        // 继续用，别把 3000 首的库在一次瞬时失败后显示成空
        if (!cr || cr.success === false) return;
        var total = CM.respCount(cr);
        // 媒体库被清空（total 0）时不能继续显示缓存：丢掉缓存并给空态
        if (!total) {
          _songsCache = null;
          els.libraryDetail.innerHTML = CM.emptyHTML('媒体库为空');
          return;
        }
        if (total === _songsCache.total) return;
        fetchAll(total, function(tracks, t) {
          _songsCache = { total: t, tracks: tracks };
          paint(tracks, t);
        });
      });
      return;
    }
    CM.api('library.getCount').then(function(cr) {
      if (!isCurrent()) { cancelLoading(); return; }
      // 查询失败 ≠ 空库：给错误态（带重试），不能显示"媒体库为空"
      if (!cr || cr.success === false) { cancelLoading(); CM.libError(CM.renderLibraryTracks); return; }
      var total = CM.respCount(cr);
      if (!total) { cancelLoading(); els.libraryDetail.innerHTML = CM.emptyHTML('媒体库为空'); return; }
      fetchAll(total, function(tracks, t) {
        _songsCache = { total: t, tracks: tracks };
        paint(tracks, t);
      });
    });
  };

  /* 媒体库客户端分页（专辑/艺术家/流派共用）：全量拉取后按页渲染，页尺寸可切、页码记忆 */
  var LIB_PAGE_SIZES = [50, 100, 300, 500];
  CM._libPageSize = function() {
    var n = parseInt(state.libPageSize, 10) || 50;
    return LIB_PAGE_SIZES.indexOf(n) >= 0 ? n : 50;
  };
  // 媒体库浮动分页栏（sticky 吸顶）：标题+数量徽标 + 每页尺寸 + 上一页/页码/下一页
  CM._pagerBarHtml = function(prefix, title, total) {
    var pageSize = CM._libPageSize();
    var sizeOpts = LIB_PAGE_SIZES.map(function(n) {
      return '<option value="' + n + '"' + (n === pageSize ? ' selected' : '') + '>' + n + '</option>';
    }).join('');
    var head = title
      ? '<div class="lib-page-title">' + esc(title) + '</div>' +
        '<span class="lib-page-count">' + total + '</span>'
      : '';
    return '<div class="lib-pager">' + head +
      '<div class="lib-pager-controls">' +
      '<span class="lib-pager-label">每页</span>' +
      '<select class="lib-page-size" id="' + prefix + 'PageSize">' + sizeOpts + '</select>' +
      '<div class="lib-page-nav">' +
      '<button class="lib-page-btn" id="' + prefix + 'Prev" type="button">' +
      '<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg><span>上一页</span></button>' +
      '<span class="lib-page-info" id="' + prefix + 'PageInfo"></span>' +
      '<button class="lib-page-btn" id="' + prefix + 'Next" type="button">' +
      '<span>下一页</span><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></button>' +
      '</div></div></div>';
  };
  CM._bindPager = function(prefix, total, pageKey, onPage) {
    if (!state.libPages) state.libPages = {};
    var pageSize = CM._libPageSize();
    var page = state.libPages[pageKey] || 1;
    var renderPage = function(scrollTop) {
      var totalPages = Math.max(1, Math.ceil((total || 0) / pageSize));
      if (page > totalPages) page = totalPages;
      if (page < 1) page = 1;
      state.libPages[pageKey] = page;
      state.libPageSize = pageSize;
      var start = (page - 1) * pageSize;
      onPage(start, pageSize, page, totalPages);
      var info = CM.$(prefix + 'PageInfo');
      if (info) info.textContent = page + ' / ' + totalPages;
      var prev = CM.$(prefix + 'Prev');
      var next = CM.$(prefix + 'Next');
      if (prev) prev.disabled = page <= 1;
      if (next) next.disabled = page >= totalPages;
      if (scrollTop) els.libraryDetail.scrollTop = 0;
    };
    var sizeEl = CM.$(prefix + 'PageSize');
    if (sizeEl) {
      sizeEl.addEventListener('change', function() {
        pageSize = parseInt(sizeEl.value, 10) || LIB_PAGE_SIZES[0];
        page = 1;
        renderPage(true);
      });
    }
    var prevBtn = CM.$(prefix + 'Prev');
    var nextBtn = CM.$(prefix + 'Next');
    if (prevBtn) prevBtn.addEventListener('click', function() { if (page > 1) { page--; renderPage(true); } });
    if (nextBtn) nextBtn.addEventListener('click', function() {
      if (page < Math.ceil(total / pageSize)) { page++; renderPage(true); }
    });
    renderPage(false);
  };

  CM.renderLibraryAlbums = function() {
    var isCurrent = libBegin();
    var cancelLoading = CM.libLoadingDelayed();
    // 全量拉取专辑（解除 limit:200 上限），客户端分页渲染
    CM.api('library.getAlbums', { limit: 1000000 }).then(function(r) {
      if (!isCurrent()) { cancelLoading(); return; }
      cancelLoading();
      if (!r || r.success === false) { CM.libError(CM.renderLibraryAlbums); return; }
      var albums = r.albums || [];
      if (!albums.length) { els.libraryDetail.innerHTML = CM.emptyHTML('媒体库为空'); return; }
      els.libraryDetail.innerHTML = CM._pagerBarHtml('libAlbum', '全部专辑', albums.length) +
        '<div class="album-grid" id="libAlbumRows"></div>';
      CM._bindPager('libAlbum', albums.length, 'albums', function(start, size) {
        var box = CM.$('libAlbumRows');
        if (!box) return;
        var slice = albums.slice(start, start + size);
        var parts = [];
        slice.forEach(function(al) { parts.push(CM._renderAlbumCard(al)); });
        box.innerHTML = parts.join('');
        // 异步批量加载封面：并行获取每张专辑首曲路径，再批量请求封面
        CM._loadAlbumCovers(box, slice, 320);
        CM._bindAlbumCards(box);
      });
      CM.libFadeIn();
      CM._restoreLibScroll();
    });
  };

  CM.renderLibraryGenres = function() {
    ensureLibDetailDelegation();
    // library.getGenres 是**零参数**方法（SDK: getGenres: () => call("library.getGenres")）：
    // 多传 limit 属未声明键，v2 严格校验会整单拒绝 → 流派页一直错误态
    CM._renderLibraryGrid('library.getGenres', null, '全部流派', '暂无流派信息',
      function(name, count) {
        return '<div class="artist-card" data-genre="' + esc(name) + '">' +
          '<div class="artist-avatar">♪</div>' +
          '<div class="artist-name">' + esc(name) + '</div>' +
          (count ? '<div class="artist-meta">' + count + ' 首曲目</div>' : '') +
          '</div>';
      },
      'genres'
    );
  };

  // 文件夹图标（与左侧树节点保持一致）
  var FOLDER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';

  // 文件夹卡片渲染（根目录 + 子目录共用）
  // root 结构: { id, displayName, absolutePath, trackCount }
  // dir 结构:  { pathId, displayName/name, trackCount }（rootId 由调用方 parentRootId 传入）
  CM._renderFolderCard = function(folder, parentRootId) {
    var name = folder.displayName || folder.name || folder.title || folder.path || '未命名文件夹';
    var rootId = '';
    var pathId = '';
    var isRoot = folder.pathId === undefined && folder.id !== undefined;
    if (isRoot) {
      rootId = folder.id || folder.rootId || '';
      pathId = '';
    } else {
      rootId = parentRootId || folder.rootId || '';
      pathId = folder.pathId || folder.path_id || '';
    }
    var sub = folder.absolutePath || folder.path || folder.relativePath || '';
    var count = folder.trackCount || folder.count || 0;
    return '<div class="artist-card folder-card" data-root-id="' + esc(rootId) + '" data-path-id="' + esc(pathId) + '" data-folder-name="' + esc(name) + '">' +
      '<div class="artist-avatar">' + FOLDER_ICON + '</div>' +
      '<div class="artist-name">' + esc(name) + '</div>' +
      (sub ? '<div class="artist-meta">' + esc(sub) + '</div>' : '') +
      '</div>';
  };

  CM._pushFolderTrail = function(rootId, pathId, name) {
    rootId = rootId || '';
    pathId = pathId || '';
    var trail = (state.libFolderTrail || []).slice();
    var idx = -1;
    for (var i = 0; i < trail.length; i++) {
      if (trail[i].rootId === rootId && (trail[i].pathId || '') === pathId) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      if (name) trail[idx].name = name;
      state.libFolderTrail = trail.slice(0, idx + 1);
      return;
    }
    if (trail.length && trail[0].rootId !== rootId) trail = [];
    var last = trail[trail.length - 1];
    var isChild = !trail.length || (last && last.rootId === rootId && (
      !(last.pathId || '') ? !!pathId : pathId.indexOf(last.pathId + '/') === 0
    ));
    if (!isChild) {
      var rootName = (trail[0] && trail[0].name) || (!pathId ? name : '') || '根目录';
      trail = [{ rootId: rootId, pathId: '', name: rootName }];
      if (pathId) {
        var acc = [];
        pathId.split('/').filter(Boolean).forEach(function(part, n, arr) {
          acc.push(part);
          trail.push({
            rootId: rootId,
            pathId: acc.join('/'),
            name: n === arr.length - 1 ? (name || part) : part
          });
        });
      }
      state.libFolderTrail = trail;
      return;
    }
    trail.push({
      rootId: rootId,
      pathId: pathId,
      name: name || (pathId.split('/').pop()) || '文件夹'
    });
    state.libFolderTrail = trail;
  };

  CM._folderCrumbHtml = function() {
    var trail = state.libFolderTrail || [];
    var parts = ['<span class="lib-crumb" data-crumb="0" style="cursor:pointer">文件夹</span>'];
    trail.forEach(function(item, i) {
      var isLast = i === trail.length - 1;
      parts.push('<span style="opacity:0.4;margin:0 6px">/</span>');
      if (isLast) {
        // 这里的"当前文件夹"用最亮的正文色（--text-1 从未定义，var() 会让整条
        // 声明作废、颜色回落到继承值，看不出层级）
        parts.push('<span style="color:var(--text)">' + esc(item.name || '') + '</span>');
      } else {
        parts.push('<span class="lib-crumb" data-crumb="' + (i + 1) + '" style="cursor:pointer">' + esc(item.name || '') + '</span>');
      }
    });
    return parts.join('');
  };

  CM._goFolderCrumb = function(index) {
    if (index <= 0) {
      state.libraryView = 'folders';
      state.libraryArg = null;
      state.libFolderTrail = [];
      state.libScrollRestore = true;
      CM.renderLibrary();
      return;
    }
    var trail = state.libFolderTrail || [];
    var target = trail[index - 1];
    if (!target) return;
    state.libFolderTrail = trail.slice(0, index);
    CM.openLibraryDetail('folder', { rootId: target.rootId, pathId: target.pathId || '' });
  };

  CM._folderGoBack = function() {
    var trail = state.libFolderTrail || [];
    CM._goFolderCrumb(trail.length <= 1 ? 0 : trail.length - 1);
  };

  CM._openLibraryFolder = function(rootId, pathId, name) {
    CM._pushFolderTrail(rootId, pathId, name);
    CM.openLibraryDetail('folder', { rootId: rootId || '', pathId: pathId || '' });
  };

  function ensureFolderDelegation() {
    CM.runOnce('folderDelegation', function() {
      els.libraryDetail.addEventListener('click', function(e) {
        var crumb = e.target.closest('.lib-crumb');
        if (crumb) {
          CM._goFolderCrumb(parseInt(crumb.dataset.crumb, 10) || 0);
          return;
        }
        var card = e.target.closest('.folder-card');
        if (!card) return;
        CM._openLibraryFolder(card.dataset.rootId, card.dataset.pathId, card.dataset.folderName);
      });
    });
  }

  // 文件夹视图：列出媒体库根目录
  CM.renderLibraryFolders = function() {
    ensureFolderDelegation();
    state.libraryBack = 'stats';
    var isCurrent = libBegin();
    var cancelLoading = CM.libLoadingDelayed();
    CM.api('library.getRoots').then(function(r) {
      if (!isCurrent()) { cancelLoading(); return; }
      cancelLoading();
      if (!r || r.success === false) { CM.libError(CM.renderLibraryFolders); return; }
      var roots = r.roots || r.items || r.directories || [];
      if (!roots.length) { els.libraryDetail.innerHTML = CM.emptyHTML('媒体库未配置文件夹'); return; }
      var parts = ['<div class="library-section-title" style="margin-top:0">媒体库文件夹（' + roots.length + '）</div><div class="artist-grid">'];
      roots.forEach(function(root) {
        parts.push(CM._renderFolderCard(root));
      });
      parts.push('</div>');
      els.libraryDetail.innerHTML = parts.join('');
      CM.libFadeIn();
      CM._restoreLibScroll();
    });
  };

  // 文件夹详情：面包屑导航 + 子文件夹网格 + 分页曲目 + 播放全部/添加到歌单
  CM.renderLibraryFolder = function(arg) {
    ensureFolderDelegation();
    arg = arg || {};
    var rootId = arg.rootId || '';
    var pathId = arg.pathId || '';
    if (!state.libFolderTrail || !state.libFolderTrail.length) {
      CM._pushFolderTrail(rootId, pathId, pathId ? pathId.split('/').pop() : '');
    }
    state.libraryBack = 'folders';
    var isCurrent = libBegin();
    var cancelLoading = CM.libLoadingDelayed();
    CM.api('library.browseTree', { rootId: rootId, pathId: pathId, includeFiles: true, recursiveFiles: false }).then(function(r) {
      if (!isCurrent()) { cancelLoading(); return; }
      cancelLoading();
      if (!r || r.success === false) { CM.libError(function() { CM.renderLibraryFolder(arg); }); return; }
      var dirs = r.directories || r.dirs || [];
      var files = r.files || r.tracks || [];
      var trail = state.libFolderTrail || [];
      var title = (trail.length && trail[trail.length - 1].name) || (pathId ? pathId.split('/').pop() : '文件夹');
      if (!dirs.length && !files.length) {
        els.libraryDetail.innerHTML =
          '<div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">' +
          '<button class="retry-btn" id="libBackBtn">← 返回</button>' +
          '<div><div class="library-section-title" style="margin:0">' + CM._folderCrumbHtml() + '</div></div></div>' +
          CM.emptyHTML('此文件夹为空');
        CM.$('libBackBtn').addEventListener('click', CM._folderGoBack);
        return;
      }
      var folderKey = rootId + '::' + pathId;
      if (state.libFolderKey !== folderKey) {
        state.libFolderKey = folderKey;
        if (!state.libPages) state.libPages = {};
        state.libPages.folder = 1;
      }
      var extraHtml = '';
      if (dirs.length) {
        extraHtml = '<div class="library-section-title">子文件夹（' + dirs.length + '）</div><div class="artist-grid">';
        dirs.forEach(function(d) {
          extraHtml += CM._renderFolderCard(d, rootId);
        });
        extraHtml += '</div>';
      }
      var stats = dirs.length + ' 个子文件夹 · ' + files.length + ' 首曲目';
      if (files.length) {
        CM.renderLibraryDrill(title, stats, files, {
          extraHtml: extraHtml,
          pageSizes: LIB_PAGE_SIZES,
          pageKey: 'folder',
          onBack: CM._folderGoBack,
          titleHtml: CM._folderCrumbHtml()
        });
      } else {
        els.libraryDetail.innerHTML =
          '<div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">' +
          '<button class="retry-btn" id="libBackBtn">← 返回</button>' +
          '<div><div class="library-section-title" style="margin:0">' + CM._folderCrumbHtml() + '</div>' +
          '<div style="font-size:11.5px;color:var(--text-3);margin-top:2px">' + stats + '</div></div></div>' +
          extraHtml;
        CM.$('libBackBtn').addEventListener('click', CM._folderGoBack);
      }
      CM.libFadeIn();
    });
  };

  // 下钻详情通用：标题 + 播放全部 + 添加到歌单 + 曲目行
  // opts.extraHtml: 标题与曲目之间的附加内容（如子文件夹网格）
  // opts.pageSizes: 启用曲目分页；播放全部/添加到歌单始终使用完整 tracks
  // opts.pageKey: 分页页码缓存键；opts.onBack: 自定义返回；opts.titleHtml: 自定义标题（如面包屑）
  CM.renderLibraryDrill = function(title, subtitle, tracks, opts) {
    opts = opts || {};
    var paged = !!(opts.pageSizes && opts.pageSizes.length);
    var extraHtml = opts.extraHtml || '';
    var titleInner = opts.titleHtml || esc(title);
    var html =
      '<div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">' +
      '<button class="retry-btn" id="libBackBtn">← 返回</button>' +
      '<div><div class="library-section-title" style="margin:0">' + titleInner + '</div>' +
      (subtitle ? '<div style="font-size:11.5px;color:var(--text-3);margin-top:2px">' + esc(subtitle) + '</div>' : '') +
      '</div>' +
      '<div style="margin-left:auto;display:flex;gap:8px">' +
      '<button class="pl-btn pl-btn-primary" id="libPlayAllBtn">' +
      CM.icons.play + '<span>播放全部</span></button>' +
      '<button class="pl-btn" id="libAddToPlBtn">' +
      CM.icons.plus + '<span>添加到歌单</span></button>' +
      '</div>' +
      '</div>' +
      extraHtml +
      (paged ? CM._pagerBarHtml('libDrill', (typeof title === 'string' ? title : '曲目'), tracks.length) : '') +
      '<div class="dc-tracklist" id="libDrillRows"></div>';
    els.libraryDetail.innerHTML = html;
    CM.$('libBackBtn').addEventListener('click', function() {
      if (opts.onBack) { opts.onBack(); return; }
      state.libraryView = state.libraryBack || 'artists';
      state.libraryArg = null;
      state.libScrollRestore = true; // 返回列表时恢复滚动位置
      CM.renderLibrary();
    });
    CM.$('libPlayAllBtn').addEventListener('click', function() {
      CM.playAllTracks(tracks, title);
    });
    CM.$('libAddToPlBtn').addEventListener('click', function(e) {
      CM.addToPlaylistMenu(tracks, e.clientX, e.clientY);
    });
    if (paged) {
      CM._bindPager('libDrill', tracks.length, opts.pageKey || 'drill', function(start, size) {
        // 上下文传的是**完整列表**：data-i 用的是完整列表下标，双击/右键播放按它定位
        CM.renderTrackRows(CM.$('libDrillRows'), tracks.slice(start, start + size), '未找到曲目', start,
          { tracks: tracks, title: typeof title === 'string' ? title : '' });
      });
    } else {
      CM.renderTrackRows(CM.$('libDrillRows'), tracks, '未找到曲目', 0, { tracks: tracks, title: typeof title === 'string' ? title : '' });
    }
    CM._restoreLibScroll();
  };

  // 通用下钻详情：设置 backView → loading → API → drill 渲染
  // resultFilter/resultSorter：含引号标签走 ? 通配查询时，按原值客户端精确过滤并排序
  CM._renderLibraryDetail = function(backView, apiMethod, apiParams, title, subtitleBuilder, retryFn, resultFilter, resultSorter) {
    state.libraryBack = backView;
    var isCurrent = libBegin();
    var cancelLoading = CM.libLoadingDelayed();
    CM.api(apiMethod, apiParams).then(function(r) {
      if (!isCurrent()) { cancelLoading(); return; }
      cancelLoading();
      if (!r || r.success === false) { CM.libError(retryFn); return; }
      var tracks = CM.respTracks(r);
      if (resultFilter) tracks = tracks.filter(resultFilter);
      if (resultSorter) resultSorter(tracks);
      CM.renderLibraryDrill(title, subtitleBuilder(tracks), tracks);
      CM.libFadeIn();
    });
  };

  // 通配结果按碟号/音轨号排序，与 getAlbumTracks 行为一致
  function sortByDiscTrack(tracks) {
    return tracks.sort(function(a, b) {
      return (a.discNumber || 0) - (b.discNumber || 0) || (a.trackNumber || 0) - (b.trackNumber || 0);
    });
  }

  CM.renderLibraryArtistDetail = function(artist) {
    var retry = function() { CM.renderLibraryArtistDetail(artist); };
    // 艺术家名含引号：宿主 getArtistTracks 内部查询无法转义必然返回空，直接走 ? 通配查询。
    // 通配查询（? 可匹配任意字符）可能带回同形名，limit 放宽 + 客户端按原值精确过滤
    var wild = artist.indexOf('"') >= 0 ? wildValue(artist) : null;
    // 2.1.0 的 library.getArtistAlbums：该艺术家的专辑行（只有名字/年份/首曲路径，
    // 没有封面 —— 封面由 _loadAlbumCovers 按 firstTrackPath 懒取）。失败不致命：
    // 只少专辑网格，曲目列表照常
    var albumsP = CM.api('library.getArtistAlbums', { artist: artist, limit: 200 })
      .then(function(r) { return (r && r.success !== false && r.albums) || []; },
            function() { return []; });
    var tracksP = wild
      ? CM.api('library.search', { query: '(artist IS "' + wild + '" OR albumartist IS "' + wild + '")', limit: 5000 })
      : CM.api('library.getArtistTracks', { artist: artist, limit: 5000 });
    state.libraryBack = 'artists';
    var isCurrent = libBegin();
    var cancelLoading = CM.libLoadingDelayed();
    Promise.all([tracksP, albumsP]).then(function(rs) {
      if (!isCurrent()) { cancelLoading(); return; }
      cancelLoading();
      var r = rs[0], albums = rs[1];
      if (!r || r.success === false) { CM.libError(retry); return; }
      var tracks = CM.respTracks(r);
      if (wild) tracks = tracks.filter(function(t) { return tagMatch(t.artist, artist) || tagMatch(t.albumArtist, artist); });
      var extra = albums.length
        ? '<div class="library-section-title" style="margin:0 0 10px">专辑 · ' + albums.length + '</div>' +
          '<div class="album-grid" id="libArtistAlbums"></div>' +
          '<div class="library-section-title" style="margin:18px 0 10px">曲目</div>'
        : '';
      CM.renderLibraryDrill(artist, tracks.length + ' 首曲目', tracks, { extraHtml: extra });
      if (albums.length) {
        var box = CM.$('libArtistAlbums');
        if (box) {
          box.innerHTML = albums.map(function(al) { return CM._renderAlbumCard(al); }).join('');
          CM._loadAlbumCovers(box, albums, 320);
          // 卡片的点击进详情 / 播放按钮走主内容区统一委托（openLibraryAlbum / playAlbum）
          CM._ensureMainContentDelegation();
        }
      }
      CM.libFadeIn();
    });
  };

  CM.renderLibraryAlbumDetail = function(arg) {
    if (!arg) { state.libraryView = 'albums'; CM.renderLibrary(); return; }
    // 专辑行的 albumArtist 才是 v2 library.getAlbumTracks 要的值（逐字节比较，不能用 artist 顶替）
    var albumArtist = arg.albumArtist || arg.artist || '';
    var sub = function(tracks) { return (albumArtist ? albumArtist + ' · ' : '') + tracks.length + ' 首曲目'; };
    var retry = function() { CM.renderLibraryAlbumDetail(arg); };
    // 专辑名或艺术家名含引号：宿主 getAlbumTracks 内部查询无法转义必然返回空，直接走 ? 通配查询
    var wild = arg.album.indexOf('"') >= 0 ? wildValue(arg.album) : null;
    var wildArtist = albumArtist.indexOf('"') >= 0 ? wildValue(albumArtist) : null;
    if (wild || wildArtist) {
      var q = wild ? 'album IS "' + wild + '"' : 'album HAS "' + arg.album + '"';
      if (wildArtist) q += ' AND (artist IS "' + wildArtist + '" OR albumartist IS "' + wildArtist + '")';
      else if (albumArtist) q += ' AND (artist IS "' + albumArtist + '" OR albumartist IS "' + albumArtist + '")';
      CM._renderLibraryDetail('albums', 'library.search', { query: q, limit: 5000 },
        arg.album, sub, retry,
        // 通配 artist 子句可能过匹配（? 命中同形名），客户端一并按原值过滤
        function(t) {
          if (!tagMatch(t.album, arg.album)) return false;
          return !albumArtist || tagMatch(t.artist, albumArtist) || tagMatch(t.albumArtist, albumArtist);
        }, sortByDiscTrack);
      return;
    }
    CM._renderLibraryDetail('albums', 'library.getAlbumTracks', { album: arg.album, albumArtist: albumArtist },
      arg.album, sub, retry);
  };

  CM.renderLibraryGenreDetail = function(genre) {
    var sub = function(tracks) { return tracks.length + ' 首曲目'; };
    var retry = function() { CM.renderLibraryGenreDetail(genre); };
    // 流派名含引号：查询无法转义，用 ? 通配替换 + 客户端精确过滤
    var wild = genre.indexOf('"') >= 0 ? wildValue(genre) : null;
    if (wild) {
      CM._renderLibraryDetail('genres', 'library.search', { query: 'genre IS "' + wild + '"', limit: 5000 },
        genre, sub, retry,
        function(t) { return tagMatch(t.genre, genre); });
      return;
    }
    // genre HAS 是子串/通配匹配：流派名本身含 ? 或 * 时会带回别的流派，客户端按原值过滤
    CM._renderLibraryDetail('genres', 'library.search', { query: 'genre HAS "' + genre + '"', limit: 5000 },
      genre, sub, retry,
      function(t) { return tagMatch(t.genre, genre); });
  };
})();
