/* ============================================
 * CloudMusic ui-tags.js — 标签编辑器
 * 单曲/批量标签编辑 / 封面查看·更换·移除
 * ============================================ */

(function() {
  'use strict';
  var CM = window.CloudMusic;
  var els = CM.els, state = CM.state, esc = CM.escHtml;

  /* ============================================
   * 标签编辑器（单曲 + 批量）
   * ============================================ */
  // 标签字段定义：SDK 键名 → 中文标签
  var TAG_FIELDS = [
    { key: 'TITLE', label: '标题' },
    { key: 'ARTIST', label: '艺术家' },
    { key: 'ALBUM', label: '专辑' },
    { key: 'ALBUM ARTIST', label: '专辑艺术家' },
    { key: 'GENRE', label: '流派' },
    { key: 'DATE', label: '年份' },
    { key: 'TRACKNUMBER', label: '音轨号' },
    { key: 'DISCNUMBER', label: 'CD号' },
    { key: 'COMPOSER', label: '作曲' },
    { key: 'COMMENT', label: '备注' }
  ];

  // 标签编辑器内部状态
  var _tagCtx = null; // { mode: 'single'|'batch', tracks: [], original: {} }

  // 标签值 → 输入框文本。多值标签（metadata.readByPath 对多值字段返回数组，如
  // GENRE: ["流行","电子"]）统一以 "; " 连接：既符合 foobar2000 的编辑习惯，
  // 也保证"显示 → 未改动 → 保存"不会把多值压成一个值。
  function tagText(v) {
    return Array.isArray(v) ? v.join('; ') : (v == null ? '' : String(v));
  }

  // 支持多值的常见字段（v2 的 metadata.write / writeBatch 接受字符串数组，
  // 空数组=删除该标签）。输入里用「;」或「；」分隔即写成真正的多值标签；
  // 只有一个值（或该字段不是多值字段）时仍发字符串 —— 于是 "AC/DC" 这种
  // 带斜杠的值不会被拆开，旧宿主（只认字符串）也照样工作。
  var MULTI_VALUE_FIELDS = { ARTIST: 1, 'ALBUM ARTIST': 1, GENRE: 1, COMPOSER: 1, PERFORMER: 1 };
  function splitMulti(key, text) {
    var v = String(text == null ? '' : text);
    if (!v) return null;                              // 空值 = 清除该标签
    if (!MULTI_VALUE_FIELDS[key] || v.indexOf(';') < 0) return v;
    var parts = v.split(/[;；]/).map(function(s) { return s.trim(); }).filter(Boolean);
    if (parts.length <= 1) return parts[0] || null;
    return parts;
  }
  // 本地曲目缓存里统一存"展示文本"（列表渲染/排序只认字符串）
  function cacheText(v) {
    return Array.isArray(v) ? v.join('; ') : (v == null ? '' : v);
  }

  CM.showTagEditor = function(track) {
    var path = CM.trackPath(track);
    if (!path) { CM.showToast('无法编辑', '未获取到文件路径', 'error'); return; }
    // 在线曲目（QQ 音乐直链）没有可写的文件：metadata.read 只会返回空标签、
    // 保存必然失败。与其开一个空编辑器让人白填一遍，不如直接说清楚。
    if (CM.isUrlPath && CM.isUrlPath(path)) {
      CM.showToast('无法编辑标签', '在线曲目没有本地文件 —— 需要改标签请先「下载选中」落盘',
                   'error');
      return;
    }
    var ctx = { mode: 'single', tracks: [track], path: path };
    _tagCtx = ctx;
    els.tagEditorTitle.textContent = '编辑标签';
    els.tagEditorTrack.textContent = CM.trackName(track) + ' — ' + path;
    els.tagEditorHint.textContent = '正在读取标签...';
    // 立即打开编辑器，显示加载态
    els.tagEditorBody.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-3);font-size:13px"><div class="spinner" style="margin:0 auto 10px"></div>正在读取标签...</div>';
    els.tagEditorOverlay.classList.add('open');
    // 读取元数据（扁平格式，大写键名）
    CM.api('metadata.readByPath', { path: path }).then(function(r) {
      // 必须比对身份而非 mode：先开 A 再开 B 时，A 的迟到响应若被放进 B 的
      // 编辑器，保存就会把 A 派生的标签写进 B 的文件
      if (_tagCtx !== ctx) return; // 已关闭或已切换曲目
      if (!r || r.success === false) {
        CM.showToast('读取失败', '无法读取文件标签', 'error');
        CM.hideTagEditor();
        return;
      }
      ctx.original = r;
      _renderTagFields(false, r);
      _renderTagCover(path);
      els.tagEditorHint.textContent = '修改后点击保存写入文件';
    });
  };

  CM.showBatchTagEditor = function(tracks) {
    if (!tracks || tracks.length < 2) return;
    _tagCtx = { mode: 'batch', tracks: tracks };
    els.tagEditorTitle.textContent = '批量编辑标签（' + tracks.length + '首）';
    // 显示前3首曲目名 + 省略
    var names = tracks.slice(0, 3).map(CM.trackName).join('、');
    if (tracks.length > 3) names += ' 等' + tracks.length + '首';
    els.tagEditorTrack.textContent = names;
    // 在线曲目写不进去：先讲清楚，别等保存完只看到"部分失败"
    var onlineN = tracks.filter(function(t) {
      return CM.isUrlPath && CM.isUrlPath(CM.trackPath(t));
    }).length;
    if (onlineN) {
      CM.showToast('有 ' + onlineN + ' 首在线曲目不会写入',
                   '在线曲目没有本地文件，本次批量保存会跳过它们', 'error');
    }
    els.tagEditorHint.textContent = '勾选要批量修改的字段，未勾选的字段保持原值';
    _renderTagFields(true, {});
    // 批量模式隐藏封面区
    var coverSec = els.tagEditorBody.querySelector('.tag-cover-section');
    if (coverSec) coverSec.style.display = 'none';
    els.tagEditorOverlay.classList.add('open');
  };

  CM.hideTagEditor = function() {
    els.tagEditorOverlay.classList.remove('open');
    _tagCtx = null;
  };

  // 渲染标签输入字段
  function _renderTagFields(isBatch, tags) {
    var parts = [];
    if (!isBatch) {
      // 单曲模式：显示封面区
      parts.push('<div class="tag-cover-section" id="tagCoverSection">' +
        '<div class="tag-cover-preview" id="tagCoverPreview"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>' +
        '<div class="tag-cover-actions">' +
        '<button class="tag-btn" id="tagCoverReplace">更换封面</button>' +
        '<button class="tag-btn danger" id="tagCoverRemove">移除封面</button>' +
        '</div></div>');
    }
    TAG_FIELDS.forEach(function(f) {
      var val = tagText(tags[f.key]);
      var multiHint = MULTI_VALUE_FIELDS[f.key] ? '多个值用「;」分隔，会写成多值标签' : '';
      if (isBatch) {
        parts.push('<div class="tag-field batch">' +
          '<input type="checkbox" class="tag-field-check" data-field="' + f.key + '">' +
          '<label class="tag-field-label"' + (multiHint ? ' title="' + multiHint + '"' : '') + '>' + f.label + '</label>' +
          '<input type="text" class="tag-field-input" data-field="' + f.key + '" placeholder="保持原值" disabled>' +
          '</div>');
      } else {
        parts.push('<div class="tag-field">' +
          '<label class="tag-field-label"' + (multiHint ? ' title="' + multiHint + '"' : '') + '>' + f.label + '</label>' +
          '<input type="text" class="tag-field-input" data-field="' + f.key + '" value="' + esc(val) + '"' +
          (multiHint ? ' placeholder="多个值用 ; 分隔"' : '') + '>' +
          '</div>');
      }
    });
    els.tagEditorBody.innerHTML = parts.join('');
    // 批量模式：checkbox 启用/禁用对应输入框
    if (isBatch) {
      els.tagEditorBody.querySelectorAll('.tag-field-check').forEach(function(cb) {
        cb.addEventListener('change', function() {
          var input = els.tagEditorBody.querySelector('.tag-field-input[data-field="' + cb.dataset.field + '"]');
          if (input) input.disabled = !cb.checked;
        });
      });
    }
  }

  // 渲染封面预览
  function _renderTagCover(path) {
    CM.api('artwork.getForTrack', { path: path, type: 'front' }).then(function(r) {
      if (r && r.success !== false && r.dataUrl) {
        var preview = CM.$('tagCoverPreview');
        if (preview) preview.innerHTML = '<img src="' + r.dataUrl + '" alt="">';
      }
    });
  }

  // 保存标签
  CM._saveTagEditor = function() {
    if (!_tagCtx) return;
    if (_tagCtx.mode === 'single') {
      _saveSingleTags();
    } else {
      _saveBatchTags();
    }
  };

  function _saveSingleTags() {
    var ctx = _tagCtx;
    if (!ctx) return;
    var path = ctx.path;
    var tags = {};
    var changed = false;
    TAG_FIELDS.forEach(function(f) {
      var input = els.tagEditorBody.querySelector('.tag-field-input[data-field="' + f.key + '"]');
      if (!input) return;
      var newVal = input.value.trim();
      // 与原值比较前统一取文本：多值字段原值是数组，直接比较会恒判为"已改动"，
      // 于是未改动的多值标签也被写回成单值（多值语义被压掉）。
      // 另外原始输入须与原值全等比较一次：只 trim 新值会把"标签本身带首尾
      // 空格"的字段恒判为已改动，未编辑也被重写并顺带剥掉原空格
      var oldVal = tagText(ctx.original && ctx.original[f.key]);
      if (input.value !== oldVal && newVal !== oldVal) {
        tags[f.key] = splitMulti(f.key, newVal); // 空值 → null（清除）；多个值 → 数组（多值标签）
        changed = true;
      }
    });
    if (!changed) { CM.showToast('无变更', '没有检测到修改的标签', null); CM.hideTagEditor(); return; }
    els.tagEditorHint.textContent = '正在写入...';
    // 走 CM.writeTags：回执只表示"已投递"，真正的写盘结果在 metadata:writeComplete
    // 事件里。写盘失败时**不更新本地缓存、不关编辑器**，否则列表会显示根本没写进去的值。
    CM.writeTags('metadata.write', { path: path, tags: tags }, [path]).then(function(out) {
      var d = out.dispatch, c = out.confirmed;
      if (!d || d.success === false) {
        if (_tagCtx === ctx) els.tagEditorHint.textContent = '写入失败，请重试';
        CM.showToast('写入失败', (d && (CM.errText(d.code) || d.error)) || '标签写入出错', 'error');
        return;
      }
      if (c.failed.length) {
        if (_tagCtx === ctx) els.tagEditorHint.textContent = '写入失败，请重试';
        // failed[].msg = 特定格式的专门提示（如 WAV 非 ASCII 限制），优先于笼统的错误码
        var f0 = c.failed[0];
        CM.showToast('标签写入失败', f0.msg || (CM.errKindLabel(f0.code) + (f0.error ? ' · ' + f0.error : '')), 'error');
        return;
      }
      var track = ctx.tracks[0];
      if (c.unconfirmed) {
        CM.showToast('标签已提交', '未收到宿主写入完成回执，请核对列表里的标签', null);
      } else {
        CM.showToast('标签已保存', track ? CM.trackName(track) : null, 'success');
      }
      // 更新本地缓存（写入已完成，即使编辑器已在写入期间被关闭也要刷新列表）。
      // 清空的标签（null）同样要反映到缓存，否则列表一直显示旧值
      if (track) {
        if (tags.TITLE != null) track.title = cacheText(tags.TITLE); else if ('TITLE' in tags) track.title = '';
        if (tags.ARTIST != null) track.artist = cacheText(tags.ARTIST); else if ('ARTIST' in tags) track.artist = '';
        if (tags.ALBUM != null) track.album = cacheText(tags.ALBUM); else if ('ALBUM' in tags) track.album = '';
        if (tags['ALBUM ARTIST'] != null) track.albumArtist = cacheText(tags['ALBUM ARTIST']); else if ('ALBUM ARTIST' in tags) track.albumArtist = '';
        if (tags.GENRE != null) track.genre = cacheText(tags.GENRE); else if ('GENRE' in tags) track.genre = '';
        if (tags.DATE != null) track.date = cacheText(tags.DATE); else if ('DATE' in tags) track.date = '';
        if (tags.TRACKNUMBER != null) track.trackNumber = parseInt(tags.TRACKNUMBER, 10) || 0; else if ('TRACKNUMBER' in tags) track.trackNumber = 0;
        if (tags.DISCNUMBER != null) track.discNumber = parseInt(tags.DISCNUMBER, 10) || 0; else if ('DISCNUMBER' in tags) track.discNumber = 0;
        CM.renderTrackTable();
      }
      // 期间用户可能已关闭本编辑器（甚至打开了另一首）：只在仍是同一个上下文时关闭
      if (_tagCtx === ctx) CM.hideTagEditor();
    });
  }

  function _saveBatchTags() {
    var ctx = _tagCtx;
    if (!ctx) return;
    var tags = {};
    var hasChecked = false;
    TAG_FIELDS.forEach(function(f) {
      var cb = els.tagEditorBody.querySelector('.tag-field-check[data-field="' + f.key + '"]');
      if (!cb || !cb.checked) return;
      var input = els.tagEditorBody.querySelector('.tag-field-input[data-field="' + f.key + '"]');
      if (!input) return;
      tags[f.key] = splitMulti(f.key, input.value.trim());
      hasChecked = true;
    });
    if (!hasChecked) { CM.showToast('未选择字段', '请勾选要批量修改的标签字段', 'error'); return; }
    els.tagEditorHint.textContent = '正在批量写入...';
    var skipped = 0;
    var items = ctx.tracks.map(function(t) {
      var p = CM.trackPath(t);
      if (!p) { skipped++; return null; } // 无路径曲目同样无法写入，计入跳过数
      // 在线曲目没有可写文件：不计入 items，否则成败统计里会多出一批
      // "失败"（其实是本来就写不了），用户还会以为写入出错
      if (CM.isUrlPath && CM.isUrlPath(p)) { skipped++; return null; }
      return { path: p, tags: tags };
    }).filter(Boolean);
    if (!items.length) {
      els.tagEditorHint.textContent = '没有可写入的本地曲目';
      CM.showToast('没有可写入的曲目', '选中的都是在线的曲目 —— 先「下载选中」落盘再改标签', 'error');
      return;
    }
    var batchPaths = items.map(function(it) { return it.path; });
    CM.writeTags('metadata.writeBatch', { items: items }, batchPaths).then(function(out) {
      var d = out.dispatch, c = out.confirmed;
      if (!d || d.success === false) {
        if (_tagCtx === ctx) els.tagEditorHint.textContent = '写入失败，请重试';
        // 回执里可能带 successCount/failCount（部分条目参数非法时宿主仍会投递其余条目）
        var dispNote = d && (d.successCount || d.failCount)
          ? '已投递 ' + (d.successCount || 0) + ' 首、被拒 ' + (d.failCount || 0) + ' 首' : '';
        CM.showToast('批量写入失败',
          (d && (CM.errText(d.code) || d.error)) || dispNote || '标签写入出错', 'error');
        return;
      }
      // 写盘成败只认事件：事件里报失败的路径既不算成功、也不写进缓存
      var failPaths = {};
      c.failed.forEach(function(f) { failPaths[f.path] = 1; });
      var written = {};
      batchPaths.forEach(function(p) { if (!failPaths[p]) written[p] = 1; });
      var ok = Object.keys(written).length, fail = c.failed.length;
      var skipNote = skipped ? '，' + skipped + '首在线曲目已跳过' : '';
      if (fail > 0) {
        CM.showToast('部分成功', ok + '首成功，' + fail + '首写入失败' + skipNote, 'error');
      } else if (c.unconfirmed) {
        CM.showToast('已提交批量写入', ok + '首（未收到宿主完成回执，请核对列表）' + skipNote, null);
      } else {
        CM.showToast('批量保存成功', ok + '首曲目标签已更新' + skipNote, 'success');
      }
      // 更新本地缓存：只更新真正写进去的曲目 —— 在线/无路径曲目被跳过，
      // 写盘失败的也不更新，否则列表会显示从未写入过的新值
      ctx.tracks.forEach(function(track) {
        if (!track) return;
        var p = CM.trackPath(track);
        if (!p || !written[p]) return;
        if (tags.TITLE != null) track.title = cacheText(tags.TITLE);
        if (tags.ARTIST != null) track.artist = cacheText(tags.ARTIST);
        if (tags.ALBUM != null) track.album = cacheText(tags.ALBUM);
        if (tags['ALBUM ARTIST'] != null) track.albumArtist = cacheText(tags['ALBUM ARTIST']);
        if (tags.GENRE != null) track.genre = cacheText(tags.GENRE);
        if (tags.DATE != null) track.date = cacheText(tags.DATE);
        if (tags.TRACKNUMBER != null) track.trackNumber = parseInt(tags.TRACKNUMBER, 10) || 0;
        if (tags.DISCNUMBER != null) track.discNumber = parseInt(tags.DISCNUMBER, 10) || 0;
      });
      CM.renderTrackTable();
      if (_tagCtx === ctx) CM.hideTagEditor();
    });
  }

  // 封面管理：更换封面
  CM._replaceCover = function() {
    if (!_tagCtx || _tagCtx.mode !== 'single') return;
    els.tagCoverFile.click();
  };

  // 封面管理：移除封面
  CM._removeCover = function() {
    if (!_tagCtx || _tagCtx.mode !== 'single') return;
    var path = _tagCtx.path;
    CM.showModal({
      title: '移除封面',
      desc: '确定要移除这首曲目的嵌入封面吗？',
      okText: '移除',
      danger: true
    }).then(function(result) {
      if (!result) return;
      CM.api('metadata.removeEmbeddedArt', { path: path, removeAll: true }).then(function(r) {
        if (r && r.success !== false) {
          CM.showToast('封面已移除', null, 'success');
          var preview = CM.$('tagCoverPreview');
          if (preview) preview.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
        } else {
          CM.showToast('移除失败', '该格式可能不支持嵌入封面操作', 'error');
        }
      });
    });
  };

  // 文件选择回调：读取 Base64 并嵌入封面
  CM._onCoverFileSelected = function() {
    if (!_tagCtx || _tagCtx.mode !== 'single') return;
    var file = els.tagCoverFile.files[0];
    if (!file) return;
    els.tagCoverFile.value = ''; // 重置以便重复选择同一文件
    var path = _tagCtx.path;
    var reader = new FileReader();
    reader.onload = function(e) {
      var dataUrl = e.target.result;
      var base64 = dataUrl.slice(dataUrl.indexOf(',') + 1); // 去掉 data:image/...;base64, 前缀
      CM.api('metadata.embedArtwork', { path: path, imageData: base64, type: 'front' }).then(function(r) {
        if (r && r.success !== false) {
          CM.showToast('封面已更新', null, 'success');
          var preview = CM.$('tagCoverPreview');
          if (preview) preview.innerHTML = '<img src="' + dataUrl + '" alt="">';
        } else {
          CM.showToast('嵌入失败', '该格式可能不支持嵌入封面', 'error');
        }
      });
    };
    reader.readAsDataURL(file);
  };
})();
