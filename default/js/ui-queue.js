/* ============================================
 * CloudMusic ui-queue.js — 插队队列抽屉
 * 队列渲染（签名去重） / 指针拖拽调序 / 清空重建 / 播放历史列表
 * ============================================ */

(function() {
  'use strict';
  var CM = window.CloudMusic;
  var els = CM.els, state = CM.state, esc = CM.escHtml;

  /* ============================================
   * 插队队列抽屉（UpNext）
   * 队列 = foobar 原生播放队列：全局、优先级最高、播完一首移除一首、
   * 播完回到 Context 当前游标继续（宿主的消费模型即如此，这里只负责显示与编辑）
   * ============================================ */
  /* 队列徽标 / 条数
     ------------------------------------------------------------
     `playback:queueChanged` 的载荷本来就带 `count`（队列长度）—— 事件驱动路径直接采信它，
     就不必每次队列变化（含播完一首自动出队）再打一次 `queue.getCount`。
     但载荷语义只以官方文档一句话为准，所以**先校准一次**：首次收到带 count 的事件时，
     拿同一次查询回来的条数对一遍；对不上（或宿主没带 count）就永远走查询，不做猜测。 */
  function applyQueueCount(n) {
    CM._queueCount = n;      // 供"追加到队尾"用：insertNext 的 position = 当前长度
    els.queueBadge.textContent = n > 99 ? '99+' : n;
    els.queueBadge.classList.toggle('hidden', n <= 0);
    els.queueCount.textContent = n ? n + ' 首' : '';
  }
  // 最后一次已知的队列长度（count 来自 queueChanged 载荷 / queue.get(Count) 回包，
  // 两条来源都是宿主自己给的，不是估算）—— 插件/托盘/在线桥接改了队列都会有事件，
  // 所以它足够新；拿不到（null）时调用方自己查一次
  CM._queueCount = null;
  CM._queueCountTrust = null;   // null = 未校准 / true = 采信事件里的 count / false = 只信队列查询
  CM.refreshQueueBadge = function(ev) {
    if (CM._queueRebuilding) return; // 排序重建期间跳过，完成后统一刷新
    var evCount = (ev && typeof ev.count === 'number') ? ev.count : null;
    if (evCount != null && CM._queueCountTrust === true) { applyQueueCount(evCount); return; }
    CM.api('queue.getCount').then(function(r) {
      if (CM._queueRebuilding) return;
      var n = CM.respCount(r);
      if (evCount != null && CM._queueCountTrust === null) CM._queueCountTrust = (evCount === n);
      applyQueueCount(n);
    });
  };

  // 队列抽屉顶部"正在播放"卡片：展示当前曲目（不属于队列，不参与拖拽排序/删除）
  CM._renderQueueNow = function() {
    if (!els.queueNow) return;
    var t = CM.currentTrack;
    if (!t) { els.queueNow.classList.add('hidden'); els.queueNow.innerHTML = ''; return; }
    var path = CM.trackPath(t);
    els.queueNow.innerHTML =
      '<div class="queue-now-art ph">' + CM.icons.note + '</div>' +
      '<div class="queue-now-info">' +
        '<div class="queue-now-label"><span class="eq-bars"><i></i><i></i><i></i></span>正在播放</div>' +
        '<div class="queue-now-title">' + esc(CM.trackName(t)) + '</div>' +
        '<div class="queue-now-artist">' + esc(CM.trackArtist(t)) + '</div>' +
      '</div>';
    els.queueNow.classList.remove('hidden');
    if (!path || !state.queueOpen) return; // 无路径曲目不取封面；抽屉关闭时省一次请求（打开时 renderQueue 会补渲染）
    // 封面小图；响应到达时校验曲目未变更，避免切歌竞态贴错封面
    CM.api('artwork.getFb2kUrl', { type: 'front', maxSize: 120 }).then(function(r) {
      if (!r || !r.dataUrl || r.available === false) return;
      if (CM.trackPath(CM.currentTrack) !== path) return;
      var art = els.queueNow.querySelector('.queue-now-art');
      if (art) { art.style.backgroundImage = 'url("' + r.dataUrl + '")'; art.classList.remove('ph'); art.innerHTML = ''; }
    });
  };

  CM.renderQueue = function() {
    // 队列重建（排序提交）期间宿主会连续广播 queueChanged，此时渲染会读到中间态，跳过
    if (CM._queueRebuilding) return;
    // 拖拽进行中禁止重渲染：记下 pending 标记，拖拽结束时统一补渲染
    if (_qDragIndex >= 0) { CM._queueRefreshPending = true; return; }
    CM._renderQueueNow();
    // 已有内容时延迟 150ms 才显示 loading：queue.get 通常即时返回，避免每次事件都闪一下转圈；
    // 首次（缓存为空，含真·空队列）立即 loading，保证空抽屉的视觉反馈
    var loadingShown = false;
    var cancelLoading = CM.delayedLoading(function() {
      loadingShown = true;
      els.queueList.innerHTML = CM.loadingHTML('');
    }, (CM._queueItems && CM._queueItems.length) ? 150 : 0);
    CM.api('queue.get').then(function(r) {
      cancelLoading();
      if (CM._queueRebuilding) return;
      if (_qDragIndex >= 0) { CM._queueRefreshPending = true; return; } // 取数期间用户又开始了拖拽
      var items = (r && (r.items || r.queue || r.tracks)) || [];
      if (r && r.contentVersion != null) CM._queueVersion = r.contentVersion;
      CM._queueItems = items; // 缓存完整队列（拖拽排序时据此生成新顺序）
      CM._queueCount = items.length;
      els.queueCount.textContent = items.length ? items.length + ' 首' : '';
      if (!items.length) {
        CM._queueSig = '';
        // 空态必须回答"为什么播完插队歌没回到我现在的歌单"这个最常见的困惑
        els.queueList.innerHTML = '<div class="queue-empty">' + CM.icons.queue +
          '<div class="queue-empty-title">插队队列为空</div>' +
          '<div class="queue-empty-sub">当前无插队歌曲，将按中间列表顺序播放</div></div>';
        return;
      }
      // 队列即"待播列表"（正在播放的曲目出队即播，不会出现在列表中）
      // 队列 > 1 项时启用拖拽调序
      var canDrag = items.length > 1;
      // 预转义曲目字段，避免循环内重复调用 esc()
      var escItems = items.map(function(it) {
        var t = it.track || it;
        // 来源歌单：2.1.0 起队列行自带 playlist/playlistItem 坐标（插队来源是歌单时
        // 才有）；内部歌单（上下文容器 / 宿主影子歌单）不标，避免噪音
        var src = '';
        if (typeof it.playlist === 'number' && it.playlist >= 0) {
          var row = CM.playlistRow ? CM.playlistRow(it.playlist) : null;
          if (row && !CM.isInternalPlaylist(row)) src = row.name || '';
        }
        return {
          name: esc(CM.trackName(t)),
          artist: esc(CM.trackArtist(t)),
          src: src
        };
      });
      // 内容签名未变则跳过重渲染（queueChanged 事件频繁但内容未必变化；签名含全部渲染输入）
      // 例外：loading 已显示时内容被转圈替换，必须走完整渲染恢复列表
      var sig = canDrag + '|' + escItems.map(function(t) { return t.name + '|' + t.artist; }).join('\n');
      if (sig === CM._queueSig && !loadingShown) return;
      CM._queueSig = sig;
      var parts = [];
      escItems.forEach(function(t, i) {
        parts.push(
          '<div class="queue-item' + (canDrag ? ' can-drag' : '') + '" data-i="' + i + '">' +
          (canDrag ? '<span class="queue-grip" title="拖拽调整顺序">' + CM.icons.grip + '</span>' : '') +
          '<span class="queue-item-idx">' + (i + 1) + '</span>' +
          '<div class="queue-item-info">' +
          '<div class="queue-item-title">' + t.name + '</div>' +
          '<div class="queue-item-artist">' + t.artist + (t.src ? '<span class="queue-item-src"> · 来自「' + esc(t.src) + '」</span>' : '') + '</div>' +
          '</div>' +
          '<button class="queue-item-del" title="移出队列"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
          '</div>'
        );
      });
      els.queueList.innerHTML = parts.join('');
      ensureQueueDelegation();
    });
  };

  // 队列项事件委托（一次性绑定在 queueList 上）
  var _qPointerDrag = null; // { index, startX, startY, active } 进行中的指针拖拽会话
  var _qDragIndex = -1;   // 拖拽激活项索引（用于抑制拖拽期间的队列重渲染）
  var _qDropTarget = null; // { el, before } 插入指示位置
  var _qMoveAt = 0;       // 上一次落点判定的时间（pointermove 节流）
  function _qClearIndicator() {
    if (_qDropTarget) {
      _qDropTarget.el.classList.remove('drop-before', 'drop-after');
      _qDropTarget = null;
    }
  }
  // 按纵坐标计算落点：目标行上半 → 插到该行之前，否则插到最后
  function _queueDropTargetAt(clientY) {
    var items = els.queueList.querySelectorAll('.queue-item');
    if (!items.length) return null;
    for (var i = 0; i < items.length; i++) {
      var rect = items[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return { el: items[i], before: true };
    }
    return { el: items[items.length - 1], before: false };
  }
  // 拖拽范围限制：指示线与提交仅在指针位于队列列表区域内时生效
  function _qInList(clientX, clientY) {
    var r = els.queueList.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }
  // 结束一次拖拽的统一清理 + 补做拖拽期间被延迟的队列渲染
  function _qFinishDrag() {
    _qClearIndicator();
    _qPointerDrag = null;
    _qDragIndex = -1;
    document.body.classList.remove('is-reordering');
    var d = els.queueList.querySelectorAll('.queue-item.dragging');
    for (var i = 0; i < d.length; i++) d[i].classList.remove('dragging');
    if (CM._queueRefreshPending) {
      CM._queueRefreshPending = false;
      CM.renderQueue();
    }
  }
  function ensureQueueDelegation() {
    CM.runOnce('queueDelegation', function() {
    els.queueList.addEventListener('click', function(e) {
      var btn = e.target.closest('.queue-item-del');
      if (!btn) return;
      e.stopPropagation();
      // 排序重建期间宿主队列正在清空+重加，按旧索引 remove 会删错曲目
      // （pointerdown 已有同款守卫，这里补齐 click 入口）
      if (CM._queueRebuilding) return;
      var idx = parseInt(btn.closest('.queue-item').dataset.i, 10);
      if (isNaN(idx)) return;
      // 移除失败（索引越界 / 宿主忙）要如实提示，并把列表重画回真实状态。
      // expectedVersion：按渲染快照里的 queueIndex 写，播放推进出队会让索引
      // 前移 —— 版本对不上宿主直接拒绝，总比删错条目好
      var rmParams = { index: idx };
      if (CM._queueVersion != null) rmParams.expectedVersion = CM._queueVersion;
      CM.apiOr('queue.remove', rmParams).then(function(res) {
        if (res && res.contentVersion != null) CM._queueVersion = res.contentVersion;
        CM.renderQueue();
        CM.refreshQueueBadge();
      }, function(e) {
        // 版本过期不算失败：抽屉按真实队列重画即可，用户再点一次
        if (e && e.code === 'STALE_TARGET') CM.showToast('队列已变化', '列表已刷新，请重试', 'error');
        else CM.failToast(e, '移出队列失败');
        CM.renderQueue();
        CM.refreshQueueBadge();
      });
    });
    // ---- 拖拽调整队列顺序（指针事件实现，不走 HTML5 DnD）----
    // 宿主持有本窗口的原生放置目标（v1.12.0 起 dnd 改为主机原生观察）：页面内
    // HTML5 拖拽的 dragover/drop 不会回投到页面，且宿主对非文件拖拽返回"禁止"光标，
    // 因此队列调序用 pointerdown/move/up 自行实现，拖拽范围与提交都由页面控制。
    // 宿主队列 API 无任意移动接口（仅 moveToTop），故排序走 清空+按新顺序重建，
    // 重建期间 _queueRebuilding 抑制 queueChanged 引发的中间态渲染（见 renderQueue）。
    els.queueList.addEventListener('pointerdown', function(e) {
      if (e.button !== 0 || e.pointerType === 'touch') return; // 触屏保留列表滚动
      if (CM._queueRebuilding || _qPointerDrag) return;
      if (e.target.closest && e.target.closest('.queue-item-del')) return; // 删除按钮不发起拖拽
      var qit = e.target.closest ? e.target.closest('.queue-item.can-drag') : null;
      if (!qit) return;
      var idx = parseInt(qit.dataset.i, 10);
      if (isNaN(idx) || !CM._queueItems || CM._queueItems.length < 2) return;
      e.preventDefault();
      // 指针捕获：保证移出窗口后仍能收到 move/up，松手必有着落
      try { els.queueList.setPointerCapture(e.pointerId); } catch (err) {}
      _qPointerDrag = { index: idx, startX: e.clientX, startY: e.clientY, active: false };
    });
    els.queueList.addEventListener('pointermove', function(e) {
      var drag = _qPointerDrag;
      if (!drag) return;
      if (!drag.active) {
        // 小位移视为点击，越过阈值才进入拖拽态
        if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < 4) return;
        drag.active = true;
        _qDragIndex = drag.index;
        var src = els.queueList.querySelector('.queue-item[data-i="' + drag.index + '"]');
        if (src) src.classList.add('dragging');
        document.body.classList.add('is-reordering');
      }
      if (!_qInList(e.clientX, e.clientY)) { _qClearIndicator(); return; }
      // 节流：指针移动可达 60~120Hz，而落点判定要逐行 getBoundingClientRect ——
      // 按约 60fps 处理已经跟手，松手时还会按最终坐标重算一次，不会漏最后一帧
      var moveNow = Date.now();
      if (moveNow - _qMoveAt < 16) return;
      _qMoveAt = moveNow;
      // 指针靠近列表上下边缘时自动滚动
      var rect = els.queueList.getBoundingClientRect();
      if (e.clientY < rect.top + 24) els.queueList.scrollTop -= 8;
      else if (e.clientY > rect.bottom - 24) els.queueList.scrollTop += 8;
      var t = _queueDropTargetAt(e.clientY);
      if (!t) return;
      if (_qDropTarget && _qDropTarget.el === t.el && _qDropTarget.before === t.before) return;
      _qClearIndicator();
      _qDropTarget = t;
      t.el.classList.add(t.before ? 'drop-before' : 'drop-after');
    });
    // 提交：落点按释放坐标现算；在队列范围外松手视为取消
    els.queueList.addEventListener('pointerup', function(e) {
      var drag = _qPointerDrag;
      if (!drag) return;
      var t = null;
      if (drag.active && _qInList(e.clientX, e.clientY)) t = _queueDropTargetAt(e.clientY);
      _qFinishDrag();
      if (!t) return;
      var targetIdx = parseInt(t.el.dataset.i, 10);
      if (isNaN(targetIdx)) return;
      // 插入位置（原索引空间）：before → 目标行之前；否则目标行之后
      var pos = t.before ? targetIdx : targetIdx + 1;
      CM._queueMoveTo(drag.index, pos);
    });
    els.queueList.addEventListener('pointercancel', function() {
      _qFinishDrag();
    });
    // Esc 取消进行中的拖拽（捕获阶段优先于全局 Esc 关闭队列抽屉）
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Escape' || !_qPointerDrag || !_qPointerDrag.active) return;
      e.stopPropagation();
      _qFinishDrag();
    }, true);
    window.addEventListener('blur', function() {
      if (_qPointerDrag) _qFinishDrag();
    });
    });
  }

  // 单项移动：from（原索引）移动到 pos（原索引空间的插入点，0..n）→ 生成置换并重建队列
  CM._queueMoveTo = function(from, pos) {
    var items = CM._queueItems || [];
    var n = items.length;
    if (from < 0 || from >= n) return;
    pos = Math.max(0, Math.min(n, pos));
    var rest = [];
    for (var i = 0; i < n; i++) if (i !== from) rest.push(i);
    var insertAt = pos - (from < pos ? 1 : 0);
    insertAt = Math.max(0, Math.min(rest.length, insertAt));
    var newOrder = rest.slice(0, insertAt).concat([from]).concat(rest.slice(insertAt));
    CM.reorderQueue(newOrder);
  };

  // 按新顺序重建播放队列（SDK 无任意移动接口）：快照 → clear → 按来源分组依次重新入队
  // newOrder[i] = 新位置上原条目的索引；来源信息（歌单引用 / 路径）保持原样
  CM._queueRebuilding = false;
  CM._queueItems = [];
  // 最近一次 queue.get / 队列变更回包里的 contentVersion（插件 2.1.0 乐观锁）：
  // 写操作作 expectedVersion 传回，宿主发现队列已被播放推进/其它窗口改过就拒绝
  // （STALE_TARGET），我们重读重画而不是按旧 queueIndex 盲写。旧宿主不回这个
  // 字段 → 保持 null → 参数缺省，行为与从前一致
  CM._queueVersion = null;
  CM.reorderQueue = function(newOrder) {
    var items = CM._queueItems || [];
    var n = items.length;
    if (!n || newOrder.length !== n || CM._queueRebuilding) return Promise.resolve(null);
    var changed = false;
    for (var i = 0; i < n; i++) if (newOrder[i] !== i) { changed = true; break; }
    if (!changed) return Promise.resolve(null); // 原地拖拽，不做任何事
    var reordered = [];
    for (var j = 0; j < n; j++) reordered.push(items[newOrder[j]]);

    CM._queueRebuilding = true;
    // 歌单引用元数据（兼容裸条目与 {track:...} 包装两种形态），无引用返回 null
    function playlistRef(it) {
      var m = it || {};
      var cands = [m, m.track || {}];
      for (var ci = 0; ci < cands.length; ci++) {
        var c = cands[ci];
        if (typeof c.playlist === 'number' && c.playlist >= 0 &&
            typeof c.playlistItem === 'number' && c.playlistItem >= 0) return c;
      }
      return null;
    }
    function finish(err) {
      // 无论中途个别条目成败，必须复位重建标志，否则后续调序会被永久静默拦截
      CM._queueRebuilding = false;
      CM.renderQueue();
      CM.refreshQueueBadge();
      if (err) CM.showToast('调整失败', err, 'error');
      else CM.showToast('已调整队列顺序', null, 'success');
    }
    // 版本过期的收尾：与 finish 的区别是不假装成功 —— 队列在拖拽期间被宿主
    // 推进/修改过，这次重排整体作废，重读重画后让用户重新拖
    function staleFinish() {
      CM._queueRebuilding = false;
      CM.renderQueue();
      CM.refreshQueueBadge();
      CM.showToast('队列已变化', '本次顺序调整未生效，请重新拖拽', 'error');
    }
    // 回退路径（旧宿主没有 queue.setContents 时）：clear + 逐项按来源重新入队
    function legacyRebuild() {
      var failCount = 0;
      return CM.api('queue.clear').then(function(clearRes) {
        // 回执为空（CM.api 吞掉的桥接级失败）也算失败：否则会跳过中止分支，
        // 在没清掉的旧队列上重加一遍 —— 每首曲目都变成两份
        if (!clearRes || clearRes.success === false) {
          finish((clearRes && clearRes.error) || '无法清空队列');
          return null;
        }
        // 逐项串行重新入队：保证顺序与重复项完全保真（队列通常很小，开销可忽略）
        var chain = Promise.resolve();
        reordered.forEach(function(it) {
          chain = chain.then(function() {
            var ref = playlistRef(it);
            var p;
            if (ref) {
              p = CM.api('queue.add', { playlist: ref.playlist, tracks: [ref.playlistItem] });
            } else {
              var tt = it.track || it;
              var pp = tt.absolutePath || tt.path || '';
              p = pp ? CM.api('queue.addPaths', { paths: [pp] }) : Promise.resolve(null);
            }
            return p.then(function(res) {
              if (!res || res.success === false) failCount++;
            });
          });
        });
        return chain.then(function() {
          if (failCount > 0) {
            CM._queueRebuilding = false;
            CM.renderQueue();
            CM.refreshQueueBadge();
            CM.showToast('队列顺序已调整', failCount + ' 首曲目重新入队失败', 'error');
          } else finish(null);
          return true;
        }, function() {
          finish('队列重建中断，请重试');
          return null;
        });
      });
    }

    // 快路径（插件 v2）：queue.setContents 用"队列槽位引用"一次性写完整个队列。
    // 逐项 clear + add 在拖一次时要发 2N 次宿主调用，还会让 queueChanged
    // 连发 N 次（列表反复重排）—— 队列项都带 queueIndex 时优先走这一条。
    var slots = [];
    var allSlots = true;
    for (var k = 0; k < n; k++) {
      var qi = reordered[k] && reordered[k].queueIndex;
      if (typeof qi !== 'number' || qi < 0) { allSlots = false; break; }
      slots.push({ queueIndex: qi });
    }
    if (allSlots) {
      var scParams = { items: slots };
      if (CM._queueVersion != null) scParams.expectedVersion = CM._queueVersion;
      return CM.api('queue.setContents', scParams).then(function(r) {
        // 版本过期（拖拽期间播完一首出队 / 其它窗口改了队列）时绝不能走
        // legacyRebuild：那会按旧快照"清空+重加"，把宿主刚消费掉的新队列状态
        // 整个冲掉 —— 作废重画即可
        if (r && r.success === false && r.code === 'STALE_TARGET') { staleFinish(); return true; }
        if (r && r.success !== false) {
          if (r.contentVersion != null) CM._queueVersion = r.contentVersion;
          finish(null); return true;
        }
        return legacyRebuild();
      }, function(e) {
        if (e && e.code === 'STALE_TARGET') { staleFinish(); return true; }
        return legacyRebuild();
      });
    }
    return legacyRebuild();
  };

  CM.toggleQueue = function(open) {
    state.queueOpen = open !== undefined ? open : !state.queueOpen;
    els.queueDrawer.classList.toggle('open', state.queueOpen);
    // 底栏按钮跟随开合亮起 —— 与歌词面板、迷你频谱两个开关同一套 .active 状态
    // （抽屉只能从这里开合：底栏按钮 / 抽屉里的关闭 / Esc 都走本函数）
    els.btnQueue.classList.toggle('active', state.queueOpen);
    if (state.queueOpen) {
      CM.renderQueue();
      CM.renderHistory();   // 展开的播放历史面板（只读时间线）
    }
  };
})();
