/* ============================================
 * CloudMusic ui-playlist.js — 播放列表
 * 侧栏歌单列表 / 歌单详情曲目表格（差量渲染/排序/元数据预加载）
 * 曲目右键菜单（插队 / 添加到歌单 / 评分） / 批量多选
 * ============================================ */

(function() {
  'use strict';
  var CM = window.CloudMusic;
  var els = CM.els, state = CM.state, esc = CM.escHtml;

  /* ============================================
   * 侧栏歌单列表
   * ============================================ */
  // 侧栏歌单列表事件委托（一次性绑定，避免每次 loadPlaylists 都逐个 attach）
  function ensurePlaylistDelegation() {
    CM.runOnce('playlistDelegation', function() {
      els.playlistList.addEventListener('click', function(e) {
        var el = e.target.closest('.pl-item');
        if (!el) return;
        CM.openPlaylist(parseInt(el.dataset.index, 10));
      });
      els.playlistList.addEventListener('contextmenu', function(e) {
        var el = e.target.closest('.pl-item');
        if (!el) return;
        e.preventDefault();
        CM.showPlaylistCtxMenu(e.clientX, e.clientY, parseInt(el.dataset.index, 10));
      });
    });
  }

  CM.loadPlaylists = function() {
    return CM.api('playlist.getAll').then(function(r) {
      // 宿主直接返回数组 [{index,name,trackCount,isActive,isPlaying,...}]
      var lists = Array.isArray(r) ? r : ((r && r.playlists) || []);
      CM.playlists = lists;   // 缓存保留全量（索引/guid 查找需要用到上下文歌单）
      // 主题自己/宿主的内部歌单不显示（见 playback-model.js 的 isInternalPlaylist）：
      //   `_MediaLibraryContext_` = 当前视图容器；`[WebView Queue]` = queue.addPaths 的落点
      var visible = lists.filter(function(pl) { return !CM.isInternalPlaylist(pl); });
      // 预计算所有歌单项的 HTML 片段，避免循环内重复条件判断
      var parts = visible.map(function(pl) {
        var idx = pl.index !== undefined ? pl.index : lists.indexOf(pl);
        var cls = 'pl-item';
        if (idx === state.currentPlaylistIndex) cls += ' active';
        if (idx === state.playingPlaylistIndex) cls += ' playing';
        var count = pl.trackCount != null ? pl.trackCount : (pl.itemCount != null ? pl.itemCount : '');
        return '<div class="' + cls + '" data-index="' + idx + '">' +
          CM.icons.note +
          '<span class="pl-item-name">' + esc(pl.name) + '</span>' +
          (pl.isAutoplaylist ? '<span class="pl-auto-badge">AUTO</span>' : '') +
          '<span class="pl-item-count">' + count + '</span>' +
          '</div>';
      });
      els.playlistList.innerHTML = parts.length ? parts.join('') : '<div class="queue-empty" style="padding:24px">暂无歌单</div>';
      ensurePlaylistDelegation();
      return lists;
    });
  };

  // 网络地址 → 歌单（弹出输入框 → 校验 → addPathsAsync）
  CM.addUrlToPlaylist = function(playlistIdx) {
    CM.showModal({
      title: '添加网络地址',
      input: '',
      desc: '输入音频流或文件 URL（http:// 或 https://）',
      okText: '添加'
    }).then(function(url) {
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) {
        CM.showToast('地址无效', '请以 http:// 或 https:// 开头', 'error');
        return;
      }
      CM._addPaths(playlistIdx, [url], '正在添加' + (url.length > 50 ? url.slice(0, 50) + '…' : url));
    });
  };

  // 本地文件 → 歌单（系统文件对话框）
  var AUDIO_FILTERS = [
    { name: '音频文件', extensions: ['mp3', 'flac', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'mp4', 'ape', 'wv', 'tta', 'ac3', 'dts', 'dsf', 'dff', 'aiff', 'au'] },
    { name: '播放列表', extensions: ['cue', 'm3u', 'm3u8', 'pls', 'xspf'] }
  ];
  CM.addFilesToPlaylist = function(playlistIdx) {
    CM.api('dialog.openFile', { title: '选择要添加的音频文件', multiple: true, filters: AUDIO_FILTERS }).then(function(r) {
      if (!r || r.canceled) return;
      var paths = (r.filePaths || []).filter(Boolean);
      if (paths.length) CM._addPaths(playlistIdx, paths, '正在添加 ' + paths.length + ' 个文件');
    });
  };

  // 本地文件夹 → 歌单（系统文件夹对话框）
  CM.addFolderToPlaylist = function(playlistIdx) {
    CM.api('dialog.openFolder', { title: '选择要添加的音乐文件夹' }).then(function(r) {
      if (!r || r.canceled || !r.folderPath) return;
      // 宿主 addPathsAsync 不会展开文件夹，会把它当单音轨加入导致"格式不支持"，
      // 这里复用 expandDroppedPaths 递归枚举文件夹内的音频文件后再添加。
      CM.expandDroppedPaths([r.folderPath]).then(function(paths) {
        if (!paths.length) {
          // 以前这里是 `if (!paths.length) return;` —— 选完文件夹什么都不发生，
          // 用户只能看到"扫描不到歌曲"。现在把宿主给的原因如实说出来。
          CM.showToast('没有可添加的歌曲', CM.expandFailText('这个文件夹里没有音频文件'), 'error');
          return;
        }
        CM._addPaths(playlistIdx, paths, '正在添加 ' + paths.length + ' 个文件');
      });
    });
  };

  // 统一路径添加（本地/文件夹/网络共用）
  CM._addPaths = function(playlistIdx, paths, okMsg) {
    var params = { paths: paths };
    if (playlistIdx !== undefined && playlistIdx >= 0) params.playlist = playlistIdx;
    CM.api('playlist.addPathsAsync', params).then(function(res) {
      if (res && res.success !== false) CM.showToast(okMsg, null, 'success');
      else CM.showToast('添加失败', res && res.error ? res.error : '路径可能无效', 'error');
    });
  };

  /* ============================================
   * 喜欢 → 「我喜欢的音乐」歌单
   * ------------------------------------------------------------
   * 「喜欢」按钮本职只是写评分（foo_playcount 5 星），但评分在界面里看不见 ——
   * 用户点了心形，媒体库/侧栏毫无变化，反馈就是"点了喜欢无法加入喜欢歌单"。
   * 这里评分照写，同时把路径追加进固定歌单（没有就建），取消喜欢时再移出。
   * 移出会跳过"正在播放的那一首"：foobar2000 里删掉正在播的行会直接打断播放。
   * ============================================ */
  var LIKE_PLAYLIST = '我喜欢的音乐';

  /* 读全部歌单。宿主明确失败时 reject —— 不能当成"没有这个歌单"：
     那样 addToLikedPlaylist 会再建一张同名的，用户侧就出现两个「我喜欢的音乐」。 */
  function allPlaylistRows() {
    return CM.api('playlist.getAll').then(function(all) {
      if (!all || all.success === false) {
        throw new Error((all && (all.error || all.code)) || '读不到播放列表清单');
      }
      if (Array.isArray(all)) return all;
      return all.playlists || all.items || [];
    });
  }

  function findLikedIndex(rows) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].name === LIKE_PLAYLIST && rows[i].index != null) return rows[i].index;
    }
    return -1;
  }

  /* 路径归一：页面里的路径和宿主 %path% 的值不是同一个字符串 ——
     本地文件页面存 `file://E:\…mp3`，而查询引擎里的 %path% 是 `E:\…mp3`
     （实测 `%path% IS "file://E:\…"` 恒 0 命中，坑过一轮）；在线曲目两边都是原样 URL。
     比对一律走这里：去 file:// 前缀、斜杠统一、小写（Windows 路径不区分大小写）。 */
  function normPath(p) {
    var s = String(p || '').trim().replace(/^file:\/\/\/?/i, '');
    try { s = decodeURIComponent(s); } catch (e) {}
    return s.replace(/\//g, '\\').toLowerCase();
  }

  function sameTrackPath(a, b) { return !!a && !!b && normPath(a) === normPath(b); }

  /* 预筛用的「文件名」：URL 先切掉 ?query#hash，再取最后一段。
     实测 %path% HAS 是子串匹配（`%path% HAS 1567500666` 能命中整条 B 站直链），
     所以拿文件名当粗筛，命中后再用 normPath 精确比对。别指望 IS ——
     带 `?` 与 `&` 的长 URL 用 `IS` 实测 0 命中（窗口里看着像"歌单里没有"）。
     文件名里带查询语法保留字符（`& | ! ( ) "`）时干脆不预筛：那些字符可能被
     解析成运算符，回一个"成功但少几行"的结果会让去重判断静默失效。 */
  function pathNeedle(p) {
    var s = String(p || '').split(/[?#]/)[0];
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (i >= 0) s = s.slice(i + 1);
    s = s.replace(/"/g, '').trim();
    // % 也要挡：查询语法里 %name% 是字段引用，文件名里带 % 可能让粗筛静默失真
    return /[&|!()%]/.test(s) ? '' : s;
  }

  // 在指定歌单里找出这个路径的所有行号。
  // 先用宿主的查询引擎粗筛（一次调用、多长的歌单都一样快），拿回行号后只取这几行
  // 做精确比对；查询不可用（老宿主 / 接口缺失 / 粗筛太泛）才退回分页扫描 —— 绝不用
  // count:20000 那种一把梭（宿主会真的构造两万个行对象）。两条路都读不到时
  // reject：不能拿"没扫到"当"不在歌单里"（否则会写入重复行 / 误报已移出）。
  function findRowsByPath(idx, path) {
    var needle = pathNeedle(path);
    var MAX_PICK = 300;
    function pick(tracks, rows) {
      var hits = [];
      for (var i = 0; i < tracks.length; i++) {
        if (!sameTrackPath(CM.trackPath(tracks[i]), path)) continue;
        hits.push(tracks[i].index != null ? tracks[i].index : (rows && rows[i] != null ? rows[i] : i));
      }
      return hits;
    }
    function viaQuery() {
      if (!needle) return Promise.resolve(null);
      return CM.api('playlist.getMatchingRows', { query: '%path% HAS "' + needle + '"', playlist: idx })
        .then(function(r) {
          if (!r || r.success === false || !Array.isArray(r.items)) return null;
          if (!r.items.length) return [];
          // 粗筛命中太多 = 这个名字不足以定位（同名文件成批），交回全量扫描
          if (r.items.length > MAX_PICK) return null;
          // 粗筛只回行号，取回行本身再精确比对（同一文件名可能有多首，别拿名字当身份）
          var rows = r.items.slice();
          return CM.api('playlist.getTracksAt', { playlist: idx, rows: rows }).then(function(g) {
            if (!g || g.success === false) return null;
            return pick((g.tracks || g.items) || [], rows);
          }, function() { return null; });
        }, function() { return null; });
    }
    return viaQuery().then(function(hits) {
      if (hits) return hits;
      return scanRowsByPath(idx, path);
    });
  }

  function scanRowsByPath(idx, path) {
    var hits = [];
    var start = 0;
    function step() {
      return CM.api('playlist.getTracks', { playlist: idx, start: start, count: 500 }).then(function(r) {
        if (!r || r.success === false) throw new Error('读不到歌单曲目列表');
        var rows = (r.tracks || r.items) || [];
        var total = r.total != null ? r.total : (start + rows.length);
        for (var i = 0; i < rows.length; i++) {
          if (sameTrackPath(CM.trackPath(rows[i]), path)) hits.push(rows[i].index != null ? rows[i].index : start + i);
        }
        start += rows.length;
        if (rows.length && start < total) return step();
        return hits;
      });
    }
    return step();
  }

  CM.likedPlaylistIndex = function() {
    return allPlaylistRows().then(function(rows) {
      var idx = findLikedIndex(rows);
      if (idx >= 0) return idx;
      return CM.api('playlist.create', { name: LIKE_PLAYLIST }).then(function(r) {
        if (!r || r.success === false) return -1;
        var created = r.index != null ? r.index : r.playlist;
        if (created != null && created >= 0) CM.loadPlaylists();
        return created != null ? created : -1;
      });
    });
  };

  // 追加到「我喜欢的音乐」；已在歌单里就报 'exists'（不产生重复行）
  CM.addToLikedPlaylist = function(path) {
    if (!path) return Promise.resolve('skip');
    return CM.likedPlaylistIndex().then(function(idx) {
      if (idx == null || idx < 0) throw new Error('无法创建「' + LIKE_PLAYLIST + '」歌单');
      return findRowsByPath(idx, path).then(function(rows) {
        if (rows && rows.length) return 'exists';
        return CM.api('playlist.addPathsSequential', { playlist: idx, paths: [path] }).then(function(res) {
          if (!res || res.success === false) throw new Error((res && res.error) || '宿主拒绝写入歌单');
          CM.loadPlaylists();
          return 'added';
        });
      });
    });
  };

  // 从「我喜欢的音乐」移出；'kept' = 这首正在播放（删行会打断播放，故保留）
  CM.removeFromLikedPlaylist = function(path) {
    if (!path) return Promise.resolve('skip');
    // 正在播放的这一首暂不移出：foobar2000 删掉正在播的行会直接打断播放
    if (sameTrackPath(CM.trackPath(CM.currentTrack), path)) return Promise.resolve('kept');
    return allPlaylistRows().then(function(rows) {
      var idx = findLikedIndex(rows);
      if (idx < 0) return 'absent';
      return findRowsByPath(idx, path).then(function(hits) {
        if (!hits || !hits.length) return 'absent';
        return CM.api('playlist.removeTracks', { playlist: idx, items: hits }).then(function(res) {
          if (!res || res.success === false) throw new Error((res && res.error) || '宿主拒绝从歌单移除');
          CM.loadPlaylists();
          return 'removed';
        });
      });
    });
  };

  /* 统一的「改评分」入口：评分落盘后同步「我喜欢的音乐」——
     5 星 = 喜欢（追加进歌单），4 星及以下 / 清除评分 = 取消喜欢（移出）。
     心形按钮与曲目右键的「评分 ▸」都走这一条，别再各写一遍：
     之前只有心形接歌单，右键评 5 星却什么都不发生，用户会直接判定"功能没做"。
     返回 {rating, liked}：liked ∈ added / exists / removed / absent / kept / error，
     歌单那一步失败会带回 error（评分本身已经成功，调用方各自决定怎么提示）。 */
  CM.setRating = function(path, stars) {
    if (!path) return Promise.reject(new Error('这条曲目没有可用的路径'));
    stars = Math.max(0, Math.min(5, parseInt(stars, 10) || 0));
    return CM.api('rating.set', { path: path, rating: stars }).then(function(r) {
      if (!r || r.success === false) {
        // 宿主拒（组件缺失 / 在线曲目没进播放统计）时把自己的话放前面，再把宿主原文附上
        var detail = (r && (r.error || r.message)) || '';
        throw new Error('评分写入被拒绝（需要 foo_playcount 组件，在线曲目要先在播放统计里留有记录）' +
                        (detail ? '：' + detail : ''));
      }
      var job = stars >= 5 ? CM.addToLikedPlaylist(path) : CM.removeFromLikedPlaylist(path);
      return job.then(function(how) { return { rating: stars, liked: how }; },
        function(e) { return { rating: stars, liked: 'error', error: e }; });
    });
  };

  CM.showPlaylistCtxMenu = function(x, y, idx) {
    var pl = (CM.playlists || []).find(function(p) { return p.index === idx; }) || {};
    // 自动歌单/锁定歌单（如默认「媒体库」）不接受手动编辑：隐藏 添加/重命名/清空/删除
    var editable = !pl.isAutoplaylist && !pl.isLocked;
    var items = [
      { label: '播放', icon: CM.icons.play, action: function() {
        // 歌单即播放上下文：切活动歌单 + 定位播放 + 清空插队队列（双轨制，见 playback-model.js）
        CM.playRow({ playlist: idx, index: 0 });
      } }
    ];
    if (editable) {
      items.push({ isLabel: true, label: '添加到歌单' });
      items.push({ label: '添加本地文件', icon: CM.icons.folder, action: function() {
        CM.addFilesToPlaylist(idx);
      } });
      items.push({ label: '添加文件夹', icon: CM.icons.folder, action: function() {
        CM.addFolderToPlaylist(idx);
      } });
      items.push({ label: '添加网络地址', icon: CM.icons.plus, action: function() {
        CM.addUrlToPlaylist(idx);
      } });
      items.push({ label: '重命名', icon: CM.icons.edit, action: function() {
        CM.showModal({ title: '重命名歌单', input: pl.name || '', okText: '重命名' }).then(function(name) {
          if (!name) return;
          // 写操作走 apiOr：宿主拒（锁定 / 索引失效）时不能静默，否则只是"点了没反应"
          CM.apiOr('playlist.rename', { playlist: idx, name: name }).then(function() {
            CM.showToast('已重命名', name, 'success');
          }, function(e) { CM.failToast(e, '重命名失败'); });
        });
      } });
      items.push({ divider: true });
      items.push({ label: '清空歌单', icon: CM.icons.trash, action: function() {
        CM.showModal({ title: '清空歌单', desc: '将移除「' + (pl.name || '') + '」中的全部曲目，此操作不可撤销。', okText: '清空', danger: true }).then(function(ok) {
          if (!ok) return;
          CM.apiOr('playlist.clear', { playlist: idx }).then(function() {
            CM.showToast('已清空歌单', pl.name || null, 'success');
          }, function(e) { CM.failToast(e, '清空失败'); });
        });
      } });
      items.push({ label: '删除歌单', icon: CM.icons.trash, danger: true, action: function() {
        CM.showModal({ title: '删除歌单', desc: '确定删除「' + (pl.name || '') + '」吗？此操作不可撤销。', okText: '删除', danger: true }).then(function(ok) {
          if (!ok) return;
          CM.apiOr('playlist.remove', { playlist: idx }).then(function() {
            CM.showToast('已删除歌单', pl.name || null, 'success');
          }, function(e) { CM.failToast(e, '删除失败'); });
        });
      } });
    } else {
      items.push({ isLabel: true, label: pl.isAutoplaylist ? '自动播放列表' : '锁定播放列表' });
    }
    CM.showCtxMenu(x, y, items);
  };

  /* ============================================
   * 播放列表详情（曲目表格）
   * ============================================ */
  CM.openPlaylist = function(idx) {
    state.currentPlaylistIndex = idx;
    state.sortKey = null;
    // 切歌单时清掉筛选：查询是按歌单求值的，跨歌单留着会显示另一个歌单的命中行
    CM.clearPlaylistFilter(idx);
    // 表格还显示着上一个歌单的行：立即清掉多选，防止批量栏带着旧索引
    // 在新歌单上执行删除/编辑
    if (state.batchSelected.size > 0) CM.clearBatchSelection();
    CM.switchTab('playlist'); // 进入播放列表标签会自行渲染该歌单
    CM.loadPlaylists();
  };

  /* ============================================
   * 歌单内筛选（插件 v2：playlist.getMatchingRows / getTracksAt）
   *
   * 查询串交给宿主的 foobar2000 查询引擎求值（与 foobar 搜索框同一套语法：
   *   %title% HAS 晴天、artist IS 周杰伦、rating GREATER 3 …），返回的是
   * **歌单真实行号**：页面只按行号取回需要的那几首（getTracksAt），
   * 不必把整张歌单拉下来在客户端过滤 —— 几万首的歌单也一样快。
   * ============================================ */
  CM._filterLoadId = 0;
  CM.setPlFilterMeta = function(matched, total) {
    var meta = els.plFilterMeta;
    var clear = els.plFilterClear;
    if (clear) clear.hidden = !state.plFilter;
    // 「存为自动歌单」只在有查询条件时有意义
    if (els.plFilterSave) els.plFilterSave.hidden = !state.plFilter;
    if (!meta) return;
    if (!state.plFilter) { meta.hidden = true; meta.textContent = ''; return; }
    meta.hidden = false;
    meta.textContent = (matched == null ? '' : matched + ' 首命中') +
      (total ? ' / 共 ' + total + ' 首' : '');
  };

  CM.clearPlaylistFilter = function() {
    state.plFilter = '';
    state.filterRows = null;
    state.filterTracks = null;
    CM._filterLoadId++;
    if (els.plFilter && els.plFilter.value) els.plFilter.value = '';
    CM.setPlFilterMeta(null, null);
  };

  // 应用筛选：空串 = 退回完整视图
  CM.applyPlaylistFilter = function(query) {
    var idx = state.currentPlaylistIndex;
    state.plFilter = query == null ? '' : String(query);
    if (els.plFilter && els.plFilter.value !== state.plFilter) els.plFilter.value = state.plFilter;
    if (idx == null || idx < 0) return;
    if (!state.plFilter) {
      state.filterRows = null;
      state.filterTracks = null;
      CM.setPlFilterMeta(null, null);
      CM.renderPlaylistView(idx);
      return;
    }
    var loadId = ++CM._filterLoadId;
    CM.api('playlist.getMatchingRows', { playlist: idx, query: state.plFilter }).then(function(r) {
      if (loadId !== CM._filterLoadId || idx !== state.currentPlaylistIndex) return;
      if (!r || r.success === false) {
        // 查询被解析器拒绝时宿主给 INVALID_PARAMS + details.param='query'：如实提示而不是空表
        state.filterRows = [];
        state.filterTracks = [];
        CM.renderTrackTable();
        CM.setPlFilterMeta(0, state.playlistTracksTotal);
        CM.showToast('筛选失败', (r && r.error) || '查询语法可能有误', 'error');
        return;
      }
      var rows = r.rows || r.matches || r.items || [];
      if (!rows.length) {
        state.filterRows = [];
        state.filterTracks = [];
        CM.renderTrackTable();
        CM.setPlFilterMeta(0, state.playlistTracksTotal);
        return;
      }
      var need = [];
      for (var i = 0; i < rows.length; i++) {
        if (!state.trackCache[rows[i]]) need.push(rows[i]);
      }
      var finish = function(extra) {
        if (loadId !== CM._filterLoadId) return;
        var byRow = null;
        if (extra) {
          byRow = {};
          for (var j = 0; j < need.length; j++) if (extra[j]) byRow[need[j]] = extra[j];
        }
        var tracks = [];
        for (var k = 0; k < rows.length; k++) {
          tracks.push(state.trackCache[rows[k]] || (byRow && byRow[rows[k]]) || {});
        }
        state.filterRows = rows;
        state.filterTracks = tracks;
        CM.renderTrackTable();
        CM.setPlFilterMeta(rows.length, state.playlistTracksTotal);
      };
      if (!need.length) { finish(null); return; }
      CM.api('playlist.getTracksAt', { playlist: idx, rows: need }).then(function(tr) {
        if (loadId !== CM._filterLoadId) return;
        var got = CM.respTracks(tr);
        var ordered = new Array(need.length);
        got.forEach(function(t, gi) {
          // 行回包里带 index（歌单行号）；没有就按请求顺序对齐
          var pos = (t && t.index != null) ? need.indexOf(t.index) : gi;
          if (pos >= 0 && pos < ordered.length) ordered[pos] = t;
        });
        finish(ordered);
      }, function() { finish(null); });
    });
  };

  CM.bindPlaylistFilter = function() {
    if (!els.plFilter) return;
    var deb = CM.debounce(function() {
      CM.applyPlaylistFilter(els.plFilter.value.trim());
    }, 260);
    els.plFilter.addEventListener('input', deb);
    els.plFilter.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); CM.applyPlaylistFilter(els.plFilter.value.trim()); }
      else if (e.key === 'Escape') { CM.clearPlaylistFilter(); CM.applyPlaylistFilter(''); }
    });
    if (els.plFilterClear) els.plFilterClear.addEventListener('click', function() {
      CM.clearPlaylistFilter();
      CM.applyPlaylistFilter('');
    });
    if (els.plFilterSave) els.plFilterSave.addEventListener('click', function() {
      CM.saveFilterAsAutoplaylist();
    });
  };

  // 把当前筛选条件存成一个自动歌单（v2：playlist.createAutoplaylist）。
  // 查询串原样交给宿主、不做任何改写 —— 存出来的自动歌单与眼前看到的命中集一致。
  CM.saveFilterAsAutoplaylist = function() {
    var query = state.plFilter;
    if (!query) { CM.showToast('没有筛选条件', '先在筛选框里输入查询', 'error'); return; }
    CM.showModal({
      title: '存为自动歌单',
      input: query.length > 40 ? query.slice(0, 40) : query,
      desc: '新建的自动歌单按此条件实时求值：' + query,
      okText: '创建'
    }).then(function(name) {
      if (!name) return;
      CM.apiOr('playlist.createAutoplaylist', { name: name, query: query, keepSorted: false }).then(function() {
        CM.showToast('已创建自动歌单', name, 'success');
        CM.loadPlaylists();
      }, function(e) {
        CM.failToast(e, '无法创建自动歌单');
      });
    });
  };

  CM._playlistViewLoadId = 0;
  // 当前表格内容归属的歌单索引：getTracks 返回前表格仍是上一个歌单的行，
  // 行级操作（播放/右键/调序/批量）必须校验归属，否则会用旧行索引操作新歌单
  CM._tablePlaylist = null;
  CM.renderPlaylistView = function(idx) {
    var pl = (CM.playlists || []).find(function(p) { return p.index === idx; }) || {};
    els.playlistHeaderName.textContent = pl.name || '播放列表';
    els.playlistHeaderTag.textContent = pl.isAutoplaylist ? 'AUTOPLAYLIST' : 'PLAYLIST';
    // 记忆最近打开的歌单（v2：优先记 guid —— 歌单改名/挪位后索引会变、guid 不会；
    // 名字继续留着，作为 guid 失效时的回退）
    if (pl.guid && CM.settings.rememberGuid !== pl.guid) {
      CM.settings.rememberGuid = pl.guid;
      CM.settings.lastPlaylist = pl.name || '';
      CM.saveSettings();
    } else if (CM.settings.lastPlaylist !== (pl.name || '')) {
      CM.settings.lastPlaylist = pl.name || '';
      CM.saveSettings();
    }

    var loadId = ++CM._playlistViewLoadId;
    // 请求在途：现有行属于旧歌单，行级操作一律拒绝。但**同一歌单的重载**保留旧值 ——
    // 行还是那些行（data-index 不变），而置空会让播放后的自动刷新期间出现几百毫秒的
    // "双击/右键没反应"死窗口（_tablePlaylist 守卫见 dblclick / contextmenu）。
    if (CM._tablePlaylist !== idx) CM._tablePlaylist = null;
    // 延迟加载指示器：API 快速返回（<150ms）时不闪烁，保留旧表格内容
    var cancelLoading = CM.delayedLoading(function() {
      if (loadId !== CM._playlistViewLoadId) return;
      els.trackTbody.innerHTML = '<tr><td colspan="6"><div class="table-loading"><div class="spinner"></div>加载中...</div></td></tr>';
    });

    var PL_CHUNK = 500;    // 单次 getTracks 的条数（宿主单次请求按 500 档设计）
    var PL_MAX = 20000;    // 一次渲染的硬上限：超过则不再续拉，并在表头写明"仅显示前 N 首"
    // 分块拉全（旧实现固定 count:5000，超过 5000 首的歌单会被静默截断 ——
    // 表头显示真实总数，表格却只有前 5000 行，后半段无法选中/排序/删除）
    function loadChunk(start, acc) {
      var want = Math.min(PL_CHUNK, PL_MAX - start);
      if (want <= 0) return Promise.resolve(acc);
      return CM.api('playlist.getTracks', { playlist: idx, start: start, count: want }).then(function(r) {
        if (loadId !== CM._playlistViewLoadId) return null;   // 已切歌单：整轮作废
        if (!r || r.success === false) {
          if (!acc.length) {
            els.trackTbody.innerHTML = '<tr><td colspan="6"><div class="table-error">加载失败</div></td></tr>';
            return null;
          }
          CM.showToast('部分曲目未加载', '从第 ' + (start + 1) + ' 首起加载失败', 'error');
          return acc;
        }
        var batch = CM.respTracks(r);
        acc = acc.concat(batch);
        state.playlistTracksTotal = r.total != null ? r.total : acc.length;
        // 续拉条件看"这一页是否装满"而不是只看 total：宿主没回 total 时也能拉到最后一页
        if (batch.length >= want && acc.length < PL_MAX) return loadChunk(acc.length, acc);
        return acc;
      });
    }
    loadChunk(0, []).then(function(tracks) {
      if (loadId !== CM._playlistViewLoadId || tracks == null) { cancelLoading(); return; }
      cancelLoading();
      CM._tablePlaylist = idx;
      state.trackCache = tracks;
      state.playlistTracksTotal = state.playlistTracksTotal || tracks.length;
      var total = state.playlistTracksTotal;
      var totalDur = 0;
      tracks.forEach(function(t) { totalDur += t.duration || 0; });
      els.playlistHeaderMeta.textContent = total + ' 首曲目 · ' + CM.formatTime(totalDur) +
        (tracks.length < total ? '（仅显示前 ' + tracks.length + ' 首）' : '');
      // 歌单封面取第一首歌；无封面或空歌单回退占位图
      if (tracks.length) {
        CM.api('artwork.getFb2kUrlByPath', { path: CM.trackPath(tracks[0]), type: 'front', maxSize: 300 }).then(function(ar) {
          if (loadId !== CM._playlistViewLoadId) return;
          els.plCover.onerror = ar && ar.dataUrl && ar.available !== false
            ? function() { els.plCover.onerror = null; els.plCover.src = CM.DEFAULT_TRACK_COVER; els.plCover.style.display = ''; }
            : null;
          els.plCover.src = (ar && ar.dataUrl && ar.available !== false) ? ar.dataUrl : CM.DEFAULT_TRACK_COVER;
          els.plCover.style.display = '';
        });
      } else {
        els.plCover.onerror = null;
        els.plCover.src = CM.DEFAULT_TRACK_COVER;
        els.plCover.style.display = '';
      }
      CM.renderTrackTable();
      // 筛选视图在数据刷新后重新求值（命中行可能因增删而变化）
      if (state.plFilter) CM.applyPlaylistFilter(state.plFilter);
      // 预加载缺失元数据（foobar2000 延迟加载机制：异步添加文件时不立即读取标签）
      CM.preloadTrackMetadata(tracks);
    });
  };

  // 大写键名（readBatch）→ 小写键名（playlist.getTracks）映射
  var META_TAG_MAP = {
    ARTIST: 'artist', ALBUM: 'album', 'ALBUM ARTIST': 'albumArtist',
    TITLE: 'title', GENRE: 'genre', DATE: 'date'
  };
  var META_INT_TAGS = { TRACKNUMBER: 'trackNumber', DISCNUMBER: 'discNumber' };

  // 批量预加载缺失元数据（foobar2000 延迟加载：异步添加文件时不立即读取标签）
  // 增量更新：无排序时只更新变化的行，避免全量重渲染闪烁；有排序时防抖重渲染
  //
  // 读盘走宿主的**异步探测** metadata.probeBatchAsync：探测在宿主工作线程上跑，
  // 结果按 metadata:probeProgress 分批回包；metadata.readBatch 是在宿主 UI 线程上
  // 同步读盘（SDK 文档原话：probe 让"几百个路径不再像 readBatch 那样卡住 UI"），
  // 几千首未读标签的新歌单会连续上百次卡住主窗口。探测不可用（宿主不收/无回执/
  // 事件形状不符）时退回 readBatch，保证"该出来的标签一定出来"。
  var _metaRenderTimer = null;
  var _metaProbeOps = Object.create(null);   // operationId -> { cache, indexByPath, applied, done, timer, resolve }
  var META_BATCH = 200;                      // 每批（=一次探测操作）的路径数
  var META_PROBE_TIMEOUT = 1500;             // 回执后等首个事件的上限，超时退回 readBatch

  // 把一批 tags 合并进曲目缓存（readBatch 的 results[] 与 probe 的单条结果同形），
  // 返回实际发生变化的行号
  function mergeMetaTags(cache, indexByPath, results) {
    if (!cache || !indexByPath || !results || !results.length) return [];
    var changedIdxs = [];
    for (var ri = 0; ri < results.length; ri++) {
      var res = results[ri];
      if (!res || res.success === false || !res.tags) continue;
      var idx = indexByPath[res.path];
      if (idx == null) continue;
      var t = cache[idx];
      if (!t) continue;
      var tags = res.tags, changed = false, up, lo;
      for (up in META_TAG_MAP) {
        lo = META_TAG_MAP[up];
        if (tags[up] && !t[lo]) { t[lo] = Array.isArray(tags[up]) ? tags[up].join('; ') : tags[up]; changed = true; }
      }
      for (up in META_INT_TAGS) {
        lo = META_INT_TAGS[up];
        if (tags[up] && t[lo] == null) { t[lo] = parseInt(tags[up], 10) || 0; changed = true; }
      }
      if (changed) changedIdxs.push(idx);
    }
    return changedIdxs;
  }

  function metaTagsChanged(changedIdxs) {
    if (!changedIdxs.length) return;
    if (state.sortKey) {
      // 排序模式下防抖全量重渲染（多批合并为一次）
      clearTimeout(_metaRenderTimer);
      _metaRenderTimer = setTimeout(CM.renderTrackTable, 100);
    } else {
      CM._updateTrackRows(changedIdxs);
    }
  }

  // 兜底：宿主同步批量读（探测不可用时才走这里）
  function readMetaSync(batch, cache) {
    var paths = batch.map(function(m) { return m.path; });
    return CM.api('metadata.readBatch', { paths: paths }).then(function(r) {
      if (!r || r.success === false || !r.results) return;
      if (state.trackCache !== cache) return;      // 歌单已切换，放弃写入
      var indexByPath = {};
      batch.forEach(function(m) { indexByPath[m.path] = m.idx; });
      var results = r.results.map(function(res, ri) {
        // readBatch 按请求顺序返回，可能不带 path：用下标补齐，交给同一套合并逻辑
        return res && res.path == null ? { path: paths[ri], success: res.success, tags: res.tags } : res;
      });
      metaTagsChanged(mergeMetaTags(cache, indexByPath, results));
    });
  }

  function ensureMetaProbeEvents() {
    CM.runOnce('metaProbeEvents', function() {
      fb.on('metadata:probeProgress', function(e) {
        var op = e && _metaProbeOps[e.operationId];
        if (!op || op.done || state.trackCache !== op.cache) return;
        var idxs = mergeMetaTags(op.cache, op.indexByPath, e.results || e.items || []);
        if (idxs.length) { op.applied = true; metaTagsChanged(idxs); }
      });
      fb.on('metadata:probeComplete', function(e) {
        var op = e && _metaProbeOps[e.operationId];
        if (!op) return;
        delete _metaProbeOps[e.operationId];
        if (op.done) return;
        op.done = true;
        if (op.timer) clearTimeout(op.timer);
        // 有的实现把最后一批结果一并挂在 complete 上：同样合并一次（幂等）
        if (state.trackCache === op.cache) {
          metaTagsChanged(mergeMetaTags(op.cache, op.indexByPath, (e && (e.results || e.items)) || []));
        }
        op.resolve();
      });
    });
  }

  function probeMetaBatch(batch, cache) {
    var paths = batch.map(function(m) { return m.path; });
    var indexByPath = {};
    batch.forEach(function(m) { indexByPath[m.path] = m.idx; });
    return CM.api('metadata.probeBatchAsync', { paths: paths, includeTags: true }).then(function(rec) {
      var opId = rec && (rec.operationId || rec.operation);
      if (!rec || rec.success === false || !opId) return readMetaSync(batch, cache);
      return new Promise(function(resolve) {
        var op = { cache: cache, indexByPath: indexByPath, applied: false, done: false, timer: null, resolve: resolve };
        _metaProbeOps[opId] = op;
        // 看门狗：宿主不回事件（或事件字段与预期不符）时退回同步读，
        // 不让"标签永远不出来"成为探测路径的失败模式。合并是幂等的
        // （只填空字段），已由事件补上的标签再读一遍也不会被覆盖。
        op.timer = setTimeout(function() {
          if (op.done) return;
          delete _metaProbeOps[opId];
          op.done = true;
          if (state.trackCache !== cache) { resolve(); return; }
          readMetaSync(batch, cache).then(resolve);
        }, META_PROBE_TIMEOUT);
      });
    });
  }

  CM.preloadTrackMetadata = function(tracks) {
    if (!tracks || !tracks.length) return;
    var missing = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (!t.artist && !t.album && !t.albumArtist) {
        var p = CM.trackPath(t);
        // 跳过在线直链：expired vkey URL 的 metadata.read 会触发
        // foobar 内部 HTTP 请求 → CDN 超时 → 几十秒阻塞主线程
        if (!p || /^https?:\/\//i.test(p)) continue;
        missing.push({ idx: i, path: p });
      }
    }
    if (!missing.length) return;

    var currentCache = state.trackCache; // 捕获当前引用，防止快速切歌后写入错误歌单
    ensureMetaProbeEvents();
    // 逐批串行：一批完成（或超时回退）再发下一批，避免几百个路径的探测同时压给宿主
    var next = 0;
    (function step() {
      if (next >= missing.length || state.trackCache !== currentCache) return;
      var batch = missing.slice(next, next + META_BATCH);
      next += META_BATCH;
      probeMetaBatch(batch, currentCache).then(step, step);
    })();
  };

  // 增量更新表格行（仅更新指定索引的单元格内容，不重建整个表格）
  CM._updateTrackRows = function(idxs) {
    idxs.forEach(function(idx) {
      var tr = els.trackTbody.querySelector('tr[data-index="' + idx + '"]');
      if (!tr) return;
      var t = state.trackCache[idx];
      if (!t) return;
      var cells = tr.children;
      // cells[0]=track-num, [1]=title, [2]=artist, [3]=album, [4]=duration, [5]=bitrate
      if (cells[1]) cells[1].textContent = CM.trackName(t);
      if (cells[2]) cells[2].textContent = CM.trackArtist(t);
      if (cells[3]) cells[3].textContent = t.album || '';
    });
  };

  // 播放列表表格事件委托（一次性绑定，避免每次渲染都逐行 attach N 个监听器）
  var _sortHeaders = null; // 缓存排序表头单元格
  function ensureTrackTableDelegation() {
    CM.runOnce('trackTableDelegation', function() {
    els.trackTbody.addEventListener('click', function(e) {
      var tr = e.target.closest('tr[data-index]');
      if (!tr) return;
      var realIdx = parseInt(tr.dataset.index, 10);
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+click：批量多选
        if (state.batchSelected.has(realIdx)) {
          state.batchSelected.delete(realIdx);
          tr.classList.remove('batch-selected');
        } else {
          state.batchSelected.add(realIdx);
          tr.classList.add('batch-selected');
        }
        CM._updateBatchBar();
      } else {
        // 普通点击：清除多选，单选高亮，并记录聚焦行（Alt+↑/↓ 移动用）
        if (state.batchSelected.size > 0) CM.clearBatchSelection();
        var sel = els.trackTbody.querySelector('tr.selected');
        if (sel) sel.classList.remove('selected');
        tr.classList.add('selected');
        state.focusedTrackIndex = realIdx;
        state.focusedPlaylistIndex = state.currentPlaylistIndex;
      }
    });
    els.trackTbody.addEventListener('dblclick', function(e) {
      var tr = e.target.closest('tr[data-index]');
      if (!tr) return;
      if (CM._tablePlaylist !== state.currentPlaylistIndex) return; // 表格仍是旧歌单的内容
      var idx = parseInt(tr.dataset.index, 10);
      // 双击 = 切换播放上下文：该歌单成为活动歌单并定位播放，插队队列清空
      // （原生 Autoplaylist 无需任何同步 —— 它本身就是完整 Context）
      CM.playRow({ playlist: state.currentPlaylistIndex, index: idx });
    });
    els.trackTbody.addEventListener('contextmenu', function(e) {
      var tr = e.target.closest('tr[data-index]');
      if (!tr) return;
      e.preventDefault();
      if (CM._tablePlaylist !== state.currentPlaylistIndex) return; // 表格仍是旧歌单的内容
      var realIdx = parseInt(tr.dataset.index, 10);
      CM.showTrackCtxMenu(e.clientX, e.clientY, state.trackCache[realIdx], {
        playlist: state.currentPlaylistIndex, index: realIdx
      });
    });
    });
  }

  /* ============================================
   * 播放列表曲目调序（右键菜单 / Alt+↑↓ 快捷键）
   * 宿主侧：playlist.moveTracks({ playlist, items, delta }) — 按增量移动（负上正下）
   * 宿主完成后 playlist:itemsReordered 事件会自动刷新视图（见 app.js）
   * 注：不提供表格行拖拽 — 会与"拖入外部文件导入歌单"的全局 drop 冲突
   * ============================================ */
  // 歌单是否可编辑（锁定 / 自动歌单不可增删改）
  CM.canEditPlaylist = function(playlistIdx) {
    var idx = playlistIdx != null ? playlistIdx : state.currentPlaylistIndex;
    if (idx < 0) return false;
    var pl = (CM.playlists || []).find(function(p) { return p.index === idx; }) || {};
    return !pl.isAutoplaylist && !pl.isLocked;
  };
  // 歌单是否允许手动排序（等同可编辑）
  CM.canReorderPlaylist = function(playlistIdx) {
    return CM.canEditPlaylist(playlistIdx);
  };
  // 从歌单移除曲目（单曲/批量共用）：成功后清空多选；视图刷新由宿主 itemsRemoved 事件驱动
  CM.removeTracksFromPlaylist = function(playlistIdx, indices, onDone) {
    var idx = playlistIdx != null ? playlistIdx : state.currentPlaylistIndex;
    if (idx < 0 || !indices || !indices.length) { if (onDone) onDone(false); return; }
    if (!CM.canEditPlaylist(idx)) {
      CM.showToast('无法删除', '该歌单为锁定或自动播放列表', 'error');
      if (onDone) onDone(false);
      return;
    }
    var items = indices.slice().sort(function(a, b) { return a - b; });
    CM.api('playlist.removeTracks', { playlist: idx, items: items }).then(function(r) {
      if (!r || r.success === false) {
        CM.showToast('删除失败', (r && r.error) ? r.error : '请稍后重试', 'error');
        if (onDone) onDone(false);
        return;
      }
      if (state.batchSelected.size > 0) CM.clearBatchSelection();
      if (onDone) onDone(true);
    });
  };
  // 参与移动的索引集合：多选集含锚点时返回排序后的整个选择集，否则仅锚点
  CM._selectionIndices = function(anchorIdx) {
    if (state.batchSelected.size >= 2 && state.batchSelected.has(anchorIdx)) {
      var arr = [];
      state.batchSelected.forEach(function(i) { arr.push(i); });
      return arr.sort(function(a, b) { return a - b; });
    }
    return [anchorIdx];
  };
  // moveTracks 包装：校验可编辑性，统一错误提示；msg=[title, sub] 时成功后弹 toast
  CM.movePlaylistTracks = function(indices, delta, msg) {
    var idx = state.currentPlaylistIndex;
    if (idx < 0 || !indices || !indices.length || !delta) return Promise.resolve(null);
    if (!CM.canReorderPlaylist(idx)) {
      CM.showToast('无法调整顺序', '该歌单为锁定或自动播放列表', 'error');
      return Promise.resolve(null);
    }
    if (state.sortKey) {
      CM.showToast('无法调整顺序', '请先点击已排序的表头取消排序', 'error');
      return Promise.resolve(null);
    }
    return CM.api('playlist.moveTracks', { playlist: idx, items: indices, delta: delta }).then(function(r) {
      if (!r || r.success === false) {
        CM.showToast('移动失败', (r && r.error) ? r.error : '请稍后重试', 'error');
        return null;
      }
      if (msg) CM.showToast(msg[0], msg[1] || null, 'success');
      return r;
    });
  };
  // 快捷键移动：批量选择优先，否则移动聚焦行；焦点随移动跟随
  CM.keyboardMoveTracks = function(delta) {
    if (state.currentTab !== 'playlist' || state.currentPlaylistIndex < 0) return;
    if (CM._tablePlaylist !== state.currentPlaylistIndex) return; // 表格尚未切换到当前歌单
    if (!state.trackCache.length) return;
    var indices, anchor;
    if (state.batchSelected.size > 0) {
      indices = CM._selectionIndices(state.batchSelected.values().next().value);
      // 焦点跟随移动方向的前缘：上移取最顶行，下移取最底行
      anchor = delta < 0 ? indices[0] : indices[indices.length - 1];
    } else if (state.focusedPlaylistIndex === state.currentPlaylistIndex && state.focusedTrackIndex >= 0) {
      // 聚焦索引仅在录制时的歌单内有效，且需钳制在当前曲目数内
      anchor = Math.min(state.focusedTrackIndex, state.trackCache.length - 1);
      indices = [anchor];
    } else {
      return;
    }
    if (!CM.canReorderPlaylist() || state.sortKey) {
      CM.movePlaylistTracks(indices, delta); // 走统一提示
      return;
    }
    var n = state.trackCache.length;
    // 先本地重映射焦点，保证长按连按时目标跟随（宿主事件随后会完整刷新）
    var newFocus = Math.max(0, Math.min(n - 1, anchor + delta));
    CM.movePlaylistTracks(indices, delta).then(function(r) {
      if (r) {
        state.focusedTrackIndex = newFocus;
        state.focusedPlaylistIndex = state.currentPlaylistIndex;
      }
    });
  };
  CM.renderTrackTable = function() {
    CM._lastPlayingTr = null; // 清除旧引用（innerHTML 替换后旧 DOM 已分离）
    // 清除批量选择（表格重建后旧索引失效）
    if (state.batchSelected.size > 0) {
      state.batchSelected.clear();
      CM._updateBatchBar();
    }
    // 筛选视图（v2 的 playlist.getMatchingRows / getTracksAt）：只显示命中的行，
    // 但行号仍是歌单真实行号 —— 播放 / 右键 / 删除 / 调序等行级操作一行都不用改
    // 用 != null 判"处于筛选视图"：零命中时 filterRows 是**空数组**，用 length 判会
    // 让表格退回渲染整张歌单（元信息却写着"0 首命中"），用户还会在"筛选视图"里
    // 对全表行做批量操作
    var isFiltered = state.filterRows != null;
    var tracks = state.trackCache.slice();
    var viewIndex;
    if (isFiltered) {
      viewIndex = state.filterRows.slice();
    } else {
      // 客户端排序视图（不改动实际播放列表顺序）
      viewIndex = tracks.map(function(_, i) { return i; });
      if (state.sortKey) {
        var key = state.sortKey, asc = state.sortAsc ? 1 : -1;
        viewIndex.sort(function(a, b) {
          var va = tracks[a][key], vb = tracks[b][key];
          if (key === 'duration' || key === 'bitrate') {
            return ((va || 0) - (vb || 0)) * asc;
          }
          return String(va || '').localeCompare(String(vb || ''), 'zh-CN') * asc;
        });
      }
    }
    // 排序箭头（缓存表头单元格，避免每次渲染都 querySelectorAll）
    if (!_sortHeaders) _sortHeaders = els.trackTable.querySelectorAll('thead th[data-sort]');
    _sortHeaders.forEach(function(th) {
      var arrow = th.querySelector('.sort-arrow');
      if (th.dataset.sort === state.sortKey) {
        th.classList.add('sorted');
        arrow.textContent = state.sortAsc ? '▲' : '▼';
      } else {
        th.classList.remove('sorted');
        arrow.textContent = '';
      }
    });

    if (!viewIndex.length) {
      els.trackTbody.innerHTML = isFiltered
        ? '<tr><td colspan="6"><div class="table-empty">没有匹配的曲目<br><span style="font-size:11.5px;opacity:0.7">清空筛选框即可回到整张歌单</span></div></td></tr>'
        : '<tr><td colspan="6"><div class="table-empty">这个歌单还没有曲目<br><span style="font-size:11.5px;opacity:0.7">拖放音频文件到窗口即可添加</span></div></td></tr>';
      return;
    }

    var isPlayingList = state.currentPlaylistIndex === state.playingPlaylistIndex;
    // 预转义曲目字段，避免循环内重复调用 esc()；顺序与 viewIndex 一一对应
    // （筛选视图的曲目来自 getTracksAt，可能不在已加载的 trackCache 里）
    var escTracks = viewIndex.map(function(realIdx, vi) {
      var t = isFiltered
        ? ((state.filterTracks && state.filterTracks[vi]) || tracks[realIdx] || {})
        : tracks[realIdx];
      return {
        name: esc(CM.trackName(t)),
        artist: esc(CM.trackArtist(t)),
        album: esc(t.album || ''),
        duration: CM.formatTime(t.duration),
        bitrate: t.bitrate ? t.bitrate + 'k' : ''
      };
    });
    // —— keyed 差量渲染：按 data-index 复用内容未变的行节点 ——
    // 全量 innerHTML 重写时 N 行 = N 行 HTML 解析 + 全表重排；差量仅重建签名变化的行，
    // 纯排序场景 0 次 HTML 解析（仅节点移动 + 行号 textContent 更新）
    var EQ_HTML = '<span class="eq-bars"><i></i><i></i><i></i></span>';
    var tbody = els.trackTbody;
    // 收集现有可复用行（仅差量渲染产生的行带 _rowSig；empty/loading 行无此标记自动失配）
    var oldByIdx = {};
    for (var ci = 0; ci < tbody.children.length; ci++) {
      var ctr = tbody.children[ci];
      if (ctr._rowSig != null) oldByIdx[ctr.dataset.index] = ctr;
    }
    var frag = document.createDocumentFragment();
    viewIndex.forEach(function(realIdx, row) {
      var t = escTracks[row];
      var playing = isPlayingList && realIdx === state.playingTrackIndex;
      // 行签名 = 除行号外的全部渲染输入（行号在复用时单独更新；签名不含 refreshPlayingMarks
      // 命令式改动的 playing 态——该改动会使签名失配触发单行重建，结果自愈为正确状态）
      var sig = realIdx + '|' + (playing ? 1 : 0) + '|' + t.name + '|' + t.artist + '|' + t.album + '|' + t.duration + '|' + t.bitrate;
      var tr = oldByIdx[realIdx];
      if (tr && tr._rowSig === sig) {
        // 复用：与全量重建行为一致地清除选择态（入口已 clear batchSelected）
        if (tr.classList.contains('batch-selected') || tr.classList.contains('selected')) {
          tr.classList.remove('batch-selected', 'selected');
        }
        var numCell = tr.children[0];
        if (playing) { if (!numCell.querySelector('.eq-bars')) numCell.innerHTML = EQ_HTML; }
        else if (numCell.textContent !== String(row + 1)) numCell.textContent = row + 1;
      } else {
        tr = document.createElement('tr');
        if (playing) tr.className = 'playing';
        tr.setAttribute('data-index', realIdx);
        tr._rowSig = sig;
        tr.innerHTML =
          '<td class="track-num">' + (playing ? EQ_HTML : (row + 1)) + '</td>' +
          '<td class="track-title">' + t.name + '</td>' +
          '<td class="track-artist-cell">' + t.artist + '</td>' +
          '<td class="track-artist-cell">' + t.album + '</td>' +
          '<td class="track-duration">' + t.duration + '</td>' +
          '<td class="track-bitrate">' + t.bitrate + '</td>';
      }
      // 登记播放行，供 refreshPlayingMarks 切换时清除，避免残留导致两行同时高亮
      if (playing) CM._lastPlayingTr = tr;
      frag.appendChild(tr); // 复用节点为 move 操作，不触发 HTML 解析
    });
    tbody.textContent = ''; // 移除未被复用的旧行（已复用的行已移入 frag）
    tbody.appendChild(frag);
    ensureTrackTableDelegation();
  };

  // 标记表格/发现页/搜索中的"正在播放"行
  // 只更新变化的行（旧播放行 → 恢复序号，新播放行 → 显示均衡器），避免全表扫描
  CM._lastPlayingTr = null;
  CM._lastPlayingDc = null; // 上一次标记为 playing 的 dc-track/search-result-item
  CM.refreshPlayingMarks = function() {
    var isPlayingList = state.currentPlaylistIndex === state.playingPlaylistIndex;
    // 清除旧的播放行
    if (CM._lastPlayingTr && CM._lastPlayingTr.parentNode) {
      CM._lastPlayingTr.classList.remove('playing');
      var oldNum = CM._lastPlayingTr.querySelector('.track-num');
      if (oldNum && oldNum.querySelector('.eq-bars')) {
        oldNum.textContent = String(CM._lastPlayingTr.sectionRowIndex + 1);
      }
      CM._lastPlayingTr = null;
    }
    // 设置新的播放行
    if (isPlayingList && state.playingTrackIndex >= 0) {
      var tr = els.trackTbody.querySelector('tr[data-index="' + state.playingTrackIndex + '"]');
      if (tr) {
        tr.classList.add('playing');
        var numCell = tr.querySelector('.track-num');
        if (numCell) numCell.innerHTML = '<span class="eq-bars"><i></i><i></i><i></i></span>';
        CM._lastPlayingTr = tr;
      }
    }
    // dc-track / search-result-item：只更新变化的元素，避免每次都全量扫描 mainContent
    var curPath = CM.trackPath(CM.currentTrack);
    // 清除旧的 playing 标记
    if (CM._lastPlayingDc && CM._lastPlayingDc.parentNode) {
      CM._lastPlayingDc.classList.remove('playing');
      CM._lastPlayingDc = null;
    }
    // 同一首曲目可能同时出现在多个列表里（如发现页"最近添加 + 随机曲目"），
    // 渲染时每处都烙了 playing 类，而 _lastPlayingDc 只记得最后一个 ——
    // 切歌时全量扫一遍清掉其余残留（事件驱动才执行，开销可忽略）
    var _stalePlaying = els.mainContent.querySelectorAll('.dc-track.playing, .search-result-item.playing');
    for (var _si = 0; _si < _stalePlaying.length; _si++) {
      _stalePlaying[_si].classList.remove('playing');
    }
    // 设置新的 playing 标记：逐项比较 dataset.path（属性选择器在下划线/引号等特殊路径下会失效）。
    // 同一曲目可能同时渲染在多个列表里：全部点亮（_lastPlayingDc 只登记第一个，
    // 供下次清除时兜底 —— 其余已由上面的全量清扫处理）
    if (curPath) {
      var _nodes = els.mainContent.querySelectorAll('.dc-track, .search-result-item');
      var _markedFirst = false;
      for (var _ni = 0; _ni < _nodes.length; _ni++) {
        if (_nodes[_ni].dataset.path === curPath) {
          _nodes[_ni].classList.add('playing');
          if (!_markedFirst) { CM._lastPlayingDc = _nodes[_ni]; _markedFirst = true; }
        }
      }
    }
  };

  /* 插队：把曲目放进右侧「插队队列」（foobar 原生播放队列）
     ------------------------------------------------------------
     mode = 'next'：插到队首（下一首就播）；mode = 'end'：追加到队尾。

     **为什么尽量不用"歌单坐标"入队**：队列项有两种形态 ——
       · 带坐标（`items:[{playlist,item}]` / `queue.add`）：文档明说坐标的意义是
         "能从该歌单那条的位置继续播"，所以它被播放时**宿主会把播放上下文带到那张歌单**：
         正在播歌单 A 的 x，去歌单 B 右键"下一首播放" b 之后，b 播完**下一首就是 B 的歌**，
         不会回到 A（用户实测；指南《示例 1》要求的是回 A）。
       · 不带坐标（裸路径 / handle 字符串）：`queue.insertNext({paths:[…]})` 的文档写明
         "新入队的裸路径没有歌单坐标" —— 它只是"插播这一项"，上下文不动，播完回到原来的
         歌单继续。作者版主题重建队列时也走这个形态（`insertNext([...handles], position)`）。
     所以：**只有插队来源就是"当前正在播的那张歌单"时才用坐标**（此时上下文本来就不变，
     还保留坐标的好处：宿主界面里的队列标记、CUE 子曲目身份最准）；来自别的歌单一律用
     handle/路径，不把上下文带走。 */
  function queueEntryFor(track) {
    var h = track && track.handle;
    if (typeof h === 'string' && h) return h;              // 宿主自己的 handle：精确指向该项
    return CM.trackPath(track);                            // 普通文件用绝对路径即可
  }
  // 明显是 CUE 整轨的子曲目？（行上带 subsong，或路径本身已带 |subsong:N 后缀）
  function isCueEntry(track) {
    if (!track) return false;
    if (track.subsong != null) return true;
    return /\|subsong:/i.test(CM.trackPath(track));
  }
  function enqueueTrack(track, ctx, mode) {
    var hasCoord = ctx && ctx.playlist != null && ctx.index != null;
    var hasHandle = !!(track && typeof track.handle === 'string' && track.handle);
    var sameAsContext = hasCoord && state.playingPlaylistIndex === ctx.playlist;
    // 跨歌单时**不用坐标**（见上面的长注释：坐标会把播放上下文带到那张歌单）。
    // 唯一的例外：拿不到 handle、又明显是 CUE 子曲目 —— 这时裸路径指不准是哪一轨，
    // 宁可让上下文跟过去（退回坐标）也不能播错曲目。
    var useCoord = sameAsContext || (hasCoord && !hasHandle && isCueEntry(track));
    var entry = useCoord ? '' : queueEntryFor(track);
    var atTail = mode === 'end';
    var p;
    if (useCoord) {
      p = atTail ? CM.api('queue.add', { playlist: ctx.playlist, tracks: [ctx.index] })
                 : CM.api('queue.insertNext', { items: [{ playlist: ctx.playlist, item: ctx.index }], position: 0 });
    } else {
      if (!entry) { CM.showToast('无法插队', '未找到文件路径', 'error'); return; }
      if (!atTail) {
        p = CM.api('queue.insertNext', { paths: [entry], position: 0 });
      } else {
        // 追加到队尾：insertNext 的 position 是"插到这个下标之前"，当前长度 = 队尾。
        // 长度用 CM._queueCount（queueChanged 载荷 / queue.get 回包给的真值，不是估算）——
        // 这样"跨歌单追加"和改前的 queue.add 一样只发 1 次调用；拿不到才查一次
        var cached = CM._queueCount;
        if (typeof cached === 'number') {
          p = CM.api('queue.insertNext', { paths: [entry], position: cached });
        } else {
          p = CM.api('queue.getCount').then(function (r) {
            // 查询失败时不能拿 respCount 的 0 当"空队列"——position 0 是队首，
            // 那是"下一首播放"的语义；失败交到下面统一的错误提示里
            if (!r || r.success === false) {
              return { success: false, error: '拿不到插队队列长度，无法追加' };
            }
            return CM.api('queue.insertNext', { paths: [entry], position: CM.respCount(r) });
          });
        }
      }
    }
    p.then(function(r) {
      // 静默跳过（超长 URL 只计入 invalidCount）与失败都要如实说，不能装作加上了
      if (!r || r.success === false) {
        CM.showToast('插队失败', (r && (r.error || CM.errText(r.code))) || '宿主拒绝了这次操作', 'error');
        return;
      }
      if (r.invalidCount) {
        CM.showToast('插队失败', '这条路径超长或不合法，宿主没有接受', 'error');
        return;
      }
      CM.showToast(mode === 'next' ? '已在下一首播放' : '已加入插队队列', CM.trackName(track), 'success');
      CM.refreshQueueBadge();
      if (state.queueOpen) CM.renderQueue();
    });
  }

  /* ============================================
   * 曲目右键菜单（通用）
   * track: 曲目对象；ctx: {playlist?, index?} 在播放列表内时可删除
   *      ctx 还可能是视图列表上下文 {tracks, index, title}（媒体库/发现/搜索结果行）
   * ============================================ */
  CM.showTrackCtxMenu = function(x, y, track, ctx) {
    if (!track) return;
    var path = CM.trackPath(track);
    var inPlaylist = !!(ctx && ctx.playlist != null);
    var items = [
      { label: '播放', icon: CM.icons.play, action: function() {
        // 列表行：切播放上下文再定位播放；无列表归属的裸曲目：立即播放（游离曲）
        if (inPlaylist) CM.playRow({ playlist: ctx.playlist, index: ctx.index });
        else if (ctx && ctx.tracks && ctx.tracks.length) CM.playRow({ tracks: ctx.tracks, index: ctx.index, title: ctx.title });
        else CM.playRow({ path: path });
      } },
      { label: '添加到插入队列', icon: CM.icons.queue, action: function() {
        enqueueTrack(track, ctx, 'end');
      } },
      { label: '下一首播放', icon: CM.icons.queue, action: function() {
        enqueueTrack(track, ctx, 'next');
      } },
      { label: '添加到歌单', icon: CM.icons.plus, action: function() {
        CM.showAddToPlaylistMenu(x, y, [path]);
      } },
      { divider: true }
    ];
    // 评分收成一个二级菜单（与歌词右键的「小窗 / 歌词工具」同一种悬停展开方式）：
    // 5 个星级 + 清除评分共 6 行，平铺在主菜单里会把"编辑标签 / 从歌单删除"一直往下挤
    // 评 5 星 = 喜欢（同时追加进「我喜欢的音乐」），评更低或清除 = 取消喜欢 ——
    // 一律走 CM.setRating，与底栏心形按钮同一条路
    var ratingItems = [];
    for (var s = 5; s >= 1; s--) {
      (function(stars) {
        ratingItems.push({
          html: '<span class="ctx-stars">' + '★'.repeat(stars) + '<span style="opacity:0.25">' + '★'.repeat(5 - stars) + '</span></span>',
          action: function() {
            CM.setRating(path, stars).then(function(res) {
              if (path === CM.trackPath(CM.currentTrack)) CM.refreshLikeState();
              if (res.liked === 'error') {
                CM.showToast(stars >= 5 ? '已评分 5 星，但没能加入「我喜欢的音乐」' : '已评分 ' + stars + ' 星，但没能从「我喜欢的音乐」移出',
                             (res.error && res.error.message) || null, 'error');
                return;
              }
              var note = stars >= 5
                ? (res.liked === 'exists' ? '已经在「我喜欢的音乐」里' : '加入「我喜欢的音乐」')
                : (res.liked === 'kept' ? '正在播放的这一首暂时留在歌单里，切歌后再评一次即可移出' : null);
              CM.showToast('已评分 ' + stars + ' 星', note, 'success');
            }, function(e) {
              CM.showToast('评分失败', (e && e.message) || null, 'error');
            });
          }
        });
      })(s);
    }
    ratingItems.push({ label: '清除评分', action: function() {
      CM.setRating(path, 0).then(function(res) {
        if (path === CM.trackPath(CM.currentTrack)) CM.refreshLikeState();
        // 评分已清但移出歌单失败（liked:'error'）要说出来，别报"已清除"了事
        if (res && res.liked === 'error') {
          CM.showToast('已清除评分，但没能从「我喜欢的音乐」移出',
                       (res.error && res.error.message) || null, 'error');
          return;
        }
        CM.showToast('已清除评分', CM.trackName(track));
      }, function(e) {
        // 与上面的评分项一致：失败要说出来，不能静默
        CM.showToast('清除失败', (e && e.message) || null, 'error');
      });
    } });
    items.push({ label: '评分', icon: CM.icons.star, submenu: ratingItems });
    items.push({ divider: true });
    // 在线曲目（QQ 音乐直链）没有本地文件：这两项点了必然失败（或静默无操作），
    // 直接置灰并写明原因，别让用户对着"没反应 / 写入失败"猜
    var online = CM.isUrlPath ? CM.isUrlPath(path) : /^https?:\/\//i.test(String(path || ''));
    items.push({ label: '在资源管理器中显示', icon: CM.icons.folder, disabled: online,
                 desc: online ? '在线曲目没有本地文件' : '', action: function() {
      CM.api('shell.showInExplorer', { path: path });
    } });
    items.push({ label: '编辑标签', icon: CM.icons.tag, disabled: online,
                 desc: online ? '在线曲目没有可写的文件' : '', action: function() {
      CM.showTagEditor(track);
    } });
    items.push({ label: '在线获取标签', icon: CM.icons.download, action: function() {
      CM.fetchTagsOnline(path);
    } });
    // 批量编辑入口（有多选时显示）
    if (ctx && ctx.playlist != null && state.batchSelected.size >= 2) {
      items.push({ divider: true });
      items.push({ label: '批量编辑标签（' + state.batchSelected.size + '首）', icon: CM.icons.tag, action: function() {
        var tracks = [];
        state.batchSelected.forEach(function(idx) {
          if (state.trackCache[idx]) tracks.push(state.trackCache[idx]);
        });
        if (tracks.length >= 2) CM.showBatchTagEditor(tracks);
      } });
    }
    if (ctx && ctx.playlist != null) {
      // 调整顺序（仅可编辑歌单且曲目 > 1 时显示；多选时整组移动）
      var plInfo = (CM.playlists || []).find(function(p) { return p.index === ctx.playlist; }) || {};
      if (!plInfo.isAutoplaylist && !plInfo.isLocked && state.trackCache.length > 1) {
        var selIdxs = CM._selectionIndices(ctx.index);
        var nTracks = state.trackCache.length;
        var topDelta = -selIdxs[0];
        var botDelta = (nTracks - 1) - selIdxs[selIdxs.length - 1];
        var suffix = selIdxs.length > 1 ? '（' + selIdxs.length + ' 首）' : '';
        items.push({ divider: true });
        items.push({ isLabel: true, label: '调整顺序' });
        items.push({ label: '上移' + suffix, icon: CM.icons.up, disabled: topDelta === 0, action: function() {
          CM.movePlaylistTracks(selIdxs, -1);
        } });
        items.push({ label: '下移' + suffix, icon: CM.icons.down, disabled: botDelta === 0, action: function() {
          CM.movePlaylistTracks(selIdxs, 1);
        } });
        items.push({ label: '移到顶部' + suffix, icon: CM.icons.toTop, disabled: topDelta === 0, action: function() {
          CM.movePlaylistTracks(selIdxs, topDelta, ['已移到顶部', selIdxs.length > 1 ? selIdxs.length + ' 首曲目' : CM.trackName(track)]);
        } });
        items.push({ label: '移到底部' + suffix, icon: CM.icons.toBottom, disabled: botDelta === 0, action: function() {
          CM.movePlaylistTracks(selIdxs, botDelta, ['已移到底部', selIdxs.length > 1 ? selIdxs.length + ' 首曲目' : CM.trackName(track)]);
        } });
      }
      // 从歌单删除：右键到已多选的曲目时删整组（与"调整顺序"一致的语义），否则只删这一首。
      // 锁定/自动歌单不可增删，故仅在可编辑歌单显示该项（避免点了静默失败）。
      if (CM.canEditPlaylist(ctx.playlist)) {
        var delIdxs = CM._selectionIndices(ctx.index);
        var delLabel = delIdxs.length > 1 ? '从歌单中删除（' + delIdxs.length + ' 首）' : '从歌单中删除';
        items.push({ divider: true });
        items.push({ label: delLabel, icon: CM.icons.trash, danger: true, action: function() {
          CM.removeTracksFromPlaylist(ctx.playlist, delIdxs, function(ok) {
            if (ok) CM.showToast('已从歌单删除', delIdxs.length + ' 首曲目', 'success');
          });
        } });
      }
    }
    CM.showCtxMenu(x, y, items);
  };

  /* ============================================
   * 添加到歌单 — 弹出歌单选择菜单
   * paths: 要添加的文件路径数组
   * ============================================ */
  CM.showAddToPlaylistMenu = function(x, y, paths) {
    if (!paths || !paths.length) return;
    // 优先复用已缓存的歌单列表（loadPlaylists 已缓存至 CM.playlists），
    // 避免每次打开菜单都发起 playlist.getAll 请求；缓存为空时回退到 API
    var renderMenu = function(lists) {
      var items = [{ isLabel: true, label: '添加 ' + paths.length + ' 首到歌单' }];
      if (lists.length) {
        lists.forEach(function(pl) {
          var idx = pl.index !== undefined ? pl.index : null;
          // 内部歌单（上下文容器 / 宿主的 [WebView Queue]）不列进"添加到歌单"：
          // 前者内容会被下一次视图同步整体重建，后者只是队列的落脚点
          if (idx === null || pl.isLocked || pl.isAutoplaylist || CM.isInternalPlaylist(pl)) return;
          var name = pl.name || '未命名';
          var count = pl.trackCount != null ? pl.trackCount : (pl.itemCount != null ? pl.itemCount : '');
          items.push({
            label: name + (count ? ' (' + count + ')' : ''),
            action: function() {
              CM.api('playlist.addPathsAsync', { playlist: idx, paths: paths }).then(function(res) {
                if (res && res.success !== false) {
                  // addPathsAsync 是"已在后台开始添加"的投递回执 —— 提示语照这个口径写
                  CM.showToast('正在添加', paths.length + ' 首到「' + name + '」', 'success');
                } else {
                  CM.showToast('添加失败', res && res.error ? res.error : '歌单可能被锁定', 'error');
                }
              });
            }
          });
        });
      }
      items.push({ divider: true });
      items.push({ label: '新建歌单并添加', icon: CM.icons.plus, action: function() {
        CM.showModal({ title: '新建歌单', input: '', okText: '创建并添加' }).then(function(name) {
          if (!name) return;
          // create + addPathsAsync 两步都要看回执：addPathsAsync 是"已在后台开始添加"
          // 的投递回执，所以提示语也照这个口径写，不写成"已完成添加"
          CM.apiOr('playlist.create', { name: name }).then(function(cr) {
            var newIdx = cr && (cr.index != null ? cr.index : cr.playlist);
            if (newIdx == null || newIdx < 0) throw new Error('宿主未返回新歌单索引');
            return CM.apiOr('playlist.addPathsAsync', { playlist: newIdx, paths: paths }).then(function() {
              CM.showToast('已创建歌单', name + ' · 正在添加 ' + paths.length + ' 首', 'success');
            });
          }).catch(function(e) { CM.failToast(e, '无法创建并添加'); });
        });
      } });
      CM.showCtxMenu(x, y, items);
    };
    if (CM.playlists && CM.playlists.length) {
      renderMenu(CM.playlists);
    } else {
      CM.api('playlist.getAll').then(function(r) {
        renderMenu(Array.isArray(r) ? r : ((r && r.playlists) || []));
      });
    }
  };

  /* ============================================
   * 批量选择（Ctrl+click 多选）
   * ============================================ */
  CM.clearBatchSelection = function() {
    state.batchSelected.clear();
    els.trackTbody.querySelectorAll('tr.batch-selected').forEach(function(tr) {
      tr.classList.remove('batch-selected');
    });
    CM._updateBatchBar();
  };

  CM._updateBatchBar = function() {
    var count = state.batchSelected.size;
    if (count >= 2) {
      els.batchBarCount.textContent = count;
      els.batchBar.classList.remove('hidden');
    } else {
      els.batchBar.classList.add('hidden');
    }
  };

  // 批量编辑入口（从 batch bar 触发）
  CM._batchEditFromBar = function() {
    if (state.batchSelected.size < 2) return;
    if (CM._tablePlaylist !== state.currentPlaylistIndex) return; // 表格仍是旧歌单的内容
    var tracks = [];
    state.batchSelected.forEach(function(idx) {
      if (state.trackCache[idx]) tracks.push(state.trackCache[idx]);
    });
    if (tracks.length >= 2) CM.showBatchTagEditor(tracks);
  };

  // 批量删除入口（从 batch bar 触发）：把整组选中曲目从当前歌单移除
  CM._batchDeleteFromBar = function() {
    var n = state.batchSelected.size;
    if (n < 2) return;
    if (CM._tablePlaylist !== state.currentPlaylistIndex) return; // 表格仍是旧歌单的内容
    var indices = [];
    state.batchSelected.forEach(function(i) { indices.push(i); });
    CM.removeTracksFromPlaylist(state.currentPlaylistIndex, indices, function(ok) {
      if (ok) CM.showToast('已从歌单删除', n + ' 首曲目', 'success');
    });
  };
})();
