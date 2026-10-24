/* ============================================================
 * CloudMusic 主题扩展 · 网易云音乐在线音源页（ui-netease.js）
 * ------------------------------------------------------------
 * 依赖页内桥接模块 js/netease-core.js（window.NeteaseBridge）：
 *   搜索 / 直链解析 / 歌词 / 封面 / 歌单读取都在同一个页面进程里完成，
 *   走宿主 foo_ui_webview2 的原生 HTTP 客户端（无 CORS）；
 *   播放交给 foobar2000 宿主自己的 API，下载落盘走宿主文件 API。
 *   模块随主题页面加载，无本地进程 / 端口 / 外部运行时依赖。
 *
 * 与「QQ 音乐」页（ui-qqmusic.js）的差异（都是实测结果决定的）：
 *   · **无损 / Hi-Res 也能在线流播**（2026-10-24 定位真凶后恢复）：foobar 的
 *     明文 HTTP 读取路径与网易云 CDN 在 FLAC 上不兼容（停滞在 ~0.5 秒），
 *     **https 正常**；netease-core 的 streamifyUrl 会把无损直链整理成
 *     「https + 探测过的非 audio/mpeg 镜像」，过不了关自动回落 320K MP3。
 *     音质下拉框同时作用于在线播放与下载。
 *   · **歌单导入按 ID / 链接**：公开歌单与官方榜单免登录直接读全曲目，
 *     不需要 QQ 那套「复制导出脚本 → 控制台跑 → 文本匹配」。
 *   · **试听切片要标出来**：会员曲目在未登录/非会员时接口照样返回一个可播
 *     的 URL，内容是 30/45 秒片段 —— 不拦就会往歌单里塞 30 秒的"歌"。
 * ============================================================ */
(function () {
  'use strict';

  var CM = window.CloudMusic;
  if (!CM) return;

  var LEVEL_LABEL = { standard: '128K MP3', higher: '192K MP3', exhigh: '320K MP3',
                      lossless: '无损 FLAC', hires: 'Hi-Res' };

  /* 固定歌单名：勾选播放 / 导入都只往这一个歌单里追加 */
  var NE_PLAYLIST = '网易云音乐';
  var PAGE_SIZE = 30;
  var IMPORT_MAX = 300;

  var S = {
    songs: [],          // 当前这一页的搜索结果（翻页整页替换）
    /* 已勾选的曲目：{id: 曲目对象}。按 id 记而不是按下标记 —— 翻页会整页
       换掉列表，用下标立刻就乱了；这样还能跨页攒一批一起播放。 */
    picked: {},
    quality: 'lossless',
    online: false,      // 页内桥接是否就绪
    hasCookie: false,   // 是否已登录网易云
    vip: null,          // 会员信息（登录后异步补齐）
    acct: null,         // account() 结果：把"Cookie 失效"与"真的不是会员"分开
    kw: '',
    busy: false,
    page: 1,
    more: false,
    loadingMore: false,
    paging: false,
    seq: 0,             // 列表操作序号：旧响应回来对不上就丢弃
    dlDone: 0,
    dlTotal: 0,
    dlRun: false,
    dlCancel: false,
    impRun: false,
    impCancel: false
  };

  /* 通用件：样式表、下载落盘、歌单写入、通用小工具都来自 js/online-common.js
     （与「QQ 音乐」页共用同一份实现；以前两边各存一份，已经漂移过）。
     这里只做本地别名 —— 下面的调用点一行都不用改。 */
  var K = CM.onlineCommon({
    prefix: 'nem',
    statusId: 'nemStatus', setupId: 'nemSetup', cookieInputId: 'nemCookieInput',
    dlRowId: 'nemDlRow', dlPathId: 'nemDlPath', cssId: 'nemStyle',
    bridge: function () { return window.NeteaseBridge; },
    dirName: '网易云音乐下载', dirNameOld: 'netease-downloads',
    state: S,
    onProgress: function () { updateToolbar(); },
    getLyric: function (it) { return NeteaseBridge.lyricForId(it.id, it.title, it.artist || '', it.duration | 0); }
  });
  /* 只别名本页真正用到的（K.buildPlan / K.saveLyric 的包装原来也在这，但都被
     下面同名函数声明覆盖、从未执行过，连同 copyText / listsOf / joinPath /
     hostErr / grabToFile / showDlRow / dlRowPath 这些只有别名没有调用点的
     死别名一起删了）。下载 / 歌单写入的实现在 js/online-common.js。 */
  var $ = K.$, mmss = K.mmss, apiOr = K.apiOr, toast = K.toast, setStatus = K.setStatus,
      ensurePlaylist = K.ensurePlaylist,
      dedupePlaylists = K.dedupePlaylists, safeName = K.safeName, extOfUrl = K.extOfUrl,
      downloadDir = K.downloadDir,
      openDlFolder = K.openDlFolder, copyDlPath = K.copyDlPath, runDownloads = K.runDownloads,
      showSetup = K.showSetup, openCookiePanel = K.toggleSetup, injectCss = K.injectCss;

  /* ------------------------------------------------------------
   * 通用小工具
   * ---------------------------------------------------------- */
  var esc = CM.escHtml;

  /* ------------------------------------------------------------
   * 状态：桥接自检 / 登录态 / 会员
   * ---------------------------------------------------------- */
  function reconnect() {
    if (!window.NeteaseBridge) {
      S.online = false;
      setStatus('内置桥接模块（js/netease-core.js）未加载 —— 检查 index.html 里的脚本引用', 'err');
      showSetup(false);
      return Promise.resolve(false);
    }
    var c = NeteaseBridge.config();
    S.online = true;
    S.hasCookie = !!c.hasCookie;
    if (c.quality) {
      S.quality = c.quality;
      if ($('nemQuality')) $('nemQuality').value = c.quality;
    }
    renderStatus();
    showSetup(false);

    // 登录了就把账号与会员状态都查出来（有效期一并显示，省得用户猜 Cookie 是不是失效了）。
    // account() 是这里的关键：会员接口对**失效**的 Cookie 也只会安静地回 vip:false，
    // 少了它，状态栏会把"登录态已过期"说成「已登录（非会员）」。
    if (S.hasCookie) fetchAcctState();
    return Promise.resolve(true);
  }

  /* 登录态查询的代际守卫：账号接口 8 秒超时，"清除 Cookie / 重存 Cookie"之后
     旧 Cookie 的慢回包才到，会把 S.acct 覆盖回旧值 —— 状态栏随即钉死在与当前
     登录态相反的结论上（且不会自愈）。每次登录态变化都递增 acctSeq，旧回包丢弃。 */
  var acctSeq = 0;
  function fetchAcctState() {
    var seq = ++acctSeq;
    NeteaseBridge.account().then(function (a) {
      if (seq !== acctSeq) return;
      S.acct = a; renderStatus();
    }, function () {});
    NeteaseBridge.vipInfo().then(function (v) {
      if (seq !== acctSeq) return;
      S.vip = v; renderStatus();
    }, function () {});
  }

  function renderStatus() {
    if (!S.online) return;
    var sc = NeteaseBridge.selfcheckState ? NeteaseBridge.selfcheckState() : { state: 'idle' };
    var tail = '';
    if (sc && sc.state === 'ok') tail = ' · 自检通过';
    else if (sc && sc.state === 'fail') tail = ' · 自检异常（详见控制台）';

    /* Cookie 在、账号接口却不认 = 失效（而不是"非会员"）：这两种情况的
       处理完全不同，状态栏必须分开说。带 error 的是"接口没问成"（网络问题），
       不能跟着一起判成失效，否则断网时会冤枉用户重新登录。 */
    var dead = !!(S.acct && S.acct.loggedIn && !S.acct.ok && !S.acct.error);
    var who;
    if (!S.hasCookie) who = '未登录（免费曲库）';
    else if (dead) who = 'Cookie 已失效，请重新登录';
    else if (S.vip && S.vip.vip) {
      var exp = S.vip.expire ? new Date(S.vip.expire) : null;
      who = '会员' + (exp ? '（有效至 ' + exp.getFullYear() + '-' +
        ('0' + (exp.getMonth() + 1)).slice(-2) + '-' + ('0' + exp.getDate()).slice(-2) + '）' : '');
    } else if (S.vip && S.vip.error) who = '已登录（会员状态未知）';
    else who = '已登录（非会员）';

    setStatus('内置桥接就绪 · ' + who + ' · 下载音质 ' + (LEVEL_LABEL[S.quality] || S.quality) +
              '、在线播放 ' + (LEVEL_LABEL[NeteaseBridge.streamQuality()] || NeteaseBridge.streamQuality()) +
              ' · 歌词服务可用' + tail,
              dead ? 'err' : (S.hasCookie ? 'ok' : 'warn'));
  }


  /* 登录面板显隐：跟「QQ 音乐」页同一套开关模型（实现在 online-common 的
     toggleSetup / showSetup）—— 点「登录 / Cookie」展开、再点一次收起，
     面板里另有「收起」按钮；面板与搜索 / 列表**共存**，不去动它们的显隐。
     早先为了"面板占满整块"去临时收起搜索条/工具条/列表/翻页，开合两个方向的
     状态要各自维护 —— 漏掉一支就会出现"面板关了、搜索条却回不来"。
     少一处状态就少一类 bug。 */

  /* ------------------------------------------------------------
   * 搜索
   * ---------------------------------------------------------- */
  function search() {
    var kw = ($('nemInput') || {}).value || '';
    kw = kw.trim();
    if (!kw) return;
    if (!S.online) { reconnect(); return; }
    S.kw = kw;
    S.page = 1;
    S.more = false;
    S.paging = false;
    S.loadingMore = false;
    var seq = ++S.seq;
    setStatus('正在搜索「' + kw + '」…');
    renderLoading();

    NeteaseBridge.search(kw, 1, PAGE_SIZE).then(function (d) {
      if (seq !== S.seq) return;
      if (!d || !d.ok) throw new Error((d && d.error) || '搜索失败');
      S.songs = d.songs || [];
      S.picked = {};
      S.page = 1;
      S.more = !!d.more;
      if (!S.songs.length) {
        setStatus('「' + kw + '」没有搜到结果');
        renderEmpty('没有搜到结果，换个关键词试试');
      } else {
        setStatus(searchSummary());
        renderList();
      }
      updateToolbar();
    }).catch(function (e) {
      if (seq !== S.seq) return;
      S.songs = [];
      S.more = false;
      setStatus('搜索失败：' + (e && e.message || e), 'err');
      renderEmpty('搜索失败，稍后再试');
      updateToolbar();
    });
  }

  function searchSummary() {
    // 登录后把会员身份一起带上：VIP 状态直接决定"这些 VIP 曲目能不能整首放"
    var who = '未登录（会员曲目只能试听）';
    if (S.hasCookie) who = (S.vip && S.vip.vip) ? '已登录（会员）' : '已登录';
    return '「' + S.kw + '」已加载 ' + S.songs.length + ' 首' +
      (S.more ? '（还有更多）' : '') + ' · ' + who;
  }

  function loadMore() {
    if (S.loadingMore || S.paging || !S.more || !S.online || !S.kw) return;
    S.loadingMore = true;
    var seq = S.seq;
    setStatus('正在加载第 ' + (S.page + 1) + ' 页…');
    renderList();
    NeteaseBridge.search(S.kw, S.page + 1, PAGE_SIZE).then(function (d) {
      if (seq !== S.seq) return;
      if (!d || !d.ok) throw new Error((d && d.error) || '加载失败');
      var rows = d.songs || [];
      var seen = {};
      S.songs.forEach(function (x) { seen[x.id] = 1; });
      var fresh = rows.filter(function (x) { return x && !seen[x.id]; });
      S.songs = S.songs.concat(fresh);
      S.page = S.page + 1;
      S.more = !!d.more;
      S.loadingMore = false;
      setStatus(searchSummary());
      renderList();
      updateToolbar();
    }).catch(function (e) {
      if (seq !== S.seq) return;
      S.loadingMore = false;
      S.more = false;
      setStatus('加载下一页失败：' + (e && e.message || e), 'err');
      renderList();
    });
  }

  function gotoPage(p) {
    p = Math.max(1, p | 0);
    if (!S.online || !S.kw || S.paging) return;
    if (p === S.page && S.songs.length) return;
    S.paging = true;
    var seq = ++S.seq;
    S.loadingMore = false;
    setStatus('正在翻到第 ' + p + ' 页…');
    renderPager();
    NeteaseBridge.search(S.kw, p, PAGE_SIZE).then(function (d) {
      if (seq !== S.seq) return;
      if (!d || !d.ok) throw new Error((d && d.error) || '翻页失败');
      S.songs = d.songs || [];
      S.page = p;
      S.more = !!d.more;
      S.paging = false;
      if (!S.songs.length) {
        setStatus('第 ' + p + ' 页没有内容'); renderEmpty('这一页没有内容，试试上一页');
      } else {
        setStatus(searchSummary());
        renderList();
      }
      updateToolbar();
    }).catch(function (e) {
      if (seq !== S.seq) return;
      S.paging = false;
      setStatus('翻页失败：' + (e && e.message || e), 'err');
      renderPager();
    });
  }

  function prevPage() { if (S.page > 1) gotoPage(S.page - 1); }
  function nextPage() { if (S.more) gotoPage(S.page + 1); }

  function renderPager() {
    var p = $('nemPager');
    if (p) p.className = 'nem-pager' + (S.online && S.kw ? ' on' : '');
    var no = $('nemPageNo');
    if (no) no.textContent = String(S.page);
    if ($('nemPrevBtn')) $('nemPrevBtn').disabled = S.paging || S.page <= 1;
    if ($('nemNextBtn')) $('nemNextBtn').disabled = S.paging || !S.more;
    if ($('nemPageInput')) $('nemPageInput').disabled = S.paging;
    if ($('nemGoBtn')) $('nemGoBtn').disabled = S.paging;
  }

  function renderLoading() {
    var l = $('nemList');
    if (l) l.innerHTML = CM.emptyHTML('搜索中…');
    renderPager();
  }

  function renderEmpty(msg) {
    var l = $('nemList');
    if (l) l.innerHTML = CM.emptyHTML(msg);
    renderPager();
  }

  function renderList() {
    var html = S.songs.map(function (s) {
      var id = s.id || 0;
      var on = !!S.picked[id];
      var cover = s.picUrl
        ? '<img src="' + esc(NeteaseBridge.coverUrl(s.picUrl, 120)) + '" alt="" loading="lazy" ' +
          'onerror="this.style.display=\'none\'">'
        : '';
      var tags = '';
      if (s.level === 'hires') tags += '<span class="nem-tag nem-tag-hi">Hi-Res</span>';
      else if (s.level === 'lossless') tags += '<span class="nem-tag nem-tag-sq">无损</span>';
      else if (s.level === 'exhigh') tags += '<span class="nem-tag">320K</span>';
      if (s.vip) tags += '<span class="nem-tag">VIP</span>';
      // pl=0：当前账号只能试听（未登录或非会员）—— 明确标出来，别让用户以为能整首放
      if (s.trialOnly) tags += '<span class="nem-tag nem-tag-warn">试听</span>';
      return '' +
        '<div class="nem-row' + (on ? ' sel' : '') + '" data-id="' + id + '">' +
          '<label class="nem-check" onclick="event.stopPropagation()">' +
            '<input type="checkbox" data-id="' + id + '"' + (on ? ' checked' : '') + '>' +
          '</label>' +
          '<div class="nem-cover">' + cover + '</div>' +
          '<div class="nem-meta">' +
            '<div class="nem-name">' + esc(s.title) + tags + '</div>' +
            '<div class="nem-artist">' + esc(s.artist) +
              (s.album ? ' · ' + esc(s.album) : '') + '</div>' +
          '</div>' +
          '<div class="nem-dur">' + mmss(s.interval) + '</div>' +
          '<button class="nem-btn nem-btn-sm" data-act="one" data-id="' + id + '">播放</button>' +
        '</div>';
    }).join('');

    var foot = '';
    if (S.songs.length) {
      if (S.loadingMore) {
        foot = '<div class="nem-more"><span class="nem-more-hint">正在加载…</span></div>';
      } else if (S.more) {
        foot = '<div class="nem-more"><button class="nem-btn nem-more-btn" data-act="more">' +
               '加载更多（已加载 ' + S.songs.length + ' 首）</button></div>';
      } else {
        foot = '<div class="nem-more"><span class="nem-more-hint">没有更多了 · 共 ' +
               S.songs.length + ' 首</span></div>';
      }
    }

    var l = $('nemList');
    if (l) l.innerHTML = '<div class="nem-rows">' + html + '</div>' + foot;
    renderPager();
    syncAllBox();
  }

  /* ------------------------------------------------------------
   * 已选曲目
   * ---------------------------------------------------------- */
  function songById(id) {
    if (!id) return null;
    id = Number(id);
    for (var i = 0; i < S.songs.length; i++) {
      if (S.songs[i].id === id) return S.songs[i];
    }
    return S.picked[id] || null;
  }

  function pickedList() {
    var out = [];
    for (var k in S.picked) {
      if (Object.prototype.hasOwnProperty.call(S.picked, k)) out.push(S.picked[k]);
    }
    return out;
  }

  function syncAllBox() {
    var cb = $('nemAll');
    if (!cb) return;
    cb.checked = S.songs.length > 0 && S.songs.every(function (s) {
      return !!S.picked[s.id];
    });
  }

  function updateToolbar() {
    var n = pickedList().length;
    if ($('nemCount')) $('nemCount').textContent = '已选 ' + n + ' 首';
    var busy = S.busy || S.dlRun || S.impRun;
    if ($('nemPlayBtn')) $('nemPlayBtn').disabled = busy || !n;
    if ($('nemDownloadBtn')) {
      $('nemDownloadBtn').disabled = !S.dlRun && (busy || !n);
      var txt = $('nemDownloadBtn').querySelector('span');
      if (txt) txt.textContent = S.dlRun ? '停止' : '下载选中';
    }
  }

  /* ------------------------------------------------------------
   * 播放：解析 → 追加到固定歌单 → 从新曲开播
   * ---------------------------------------------------------- */
  function playTracks(tracks) {
    if (!tracks.length) { toast('先勾选几首', null, 'error'); return; }
    if (!S.online) { toast('桥接未就绪', '稍等片刻再试，或刷新页面', 'error'); reconnect(); return; }
    // 与下载、导入互斥：三条链各自 ensurePlaylist / 追加 / 定位播放，并发时
    // "追加前总数"会互踩，playTrack 的 index 可能落到别的曲目上
    if (S.busy || S.dlRun || S.impRun) { toast('正在处理上一批', '稍等一下再点', 'error'); return; }
    S.busy = true;
    updateToolbar();

    var usedLabel = '';
    var anonNote = '';
    var skippedN = 0;   // 解析被跳过的首数：成功 toast 报实际追加数，不虚报
    setStatus('正在解析 ' + tracks.length + ' 首曲目的音源…');

    NeteaseBridge.resolveMany(tracks, NeteaseBridge.streamQuality(), { forStream: true }).then(function (r) {
      usedLabel = (r && r.usedLabel) || '';
      anonNote = (r && r.note) || '';
      if (anonNote) {
        // 登录态拿不到、匿名补上了：说清楚，别让人以为是音质降级或巧合
        toast('已自动改用匿名音源', anonNote);
      }
      if (r && r.skipped && r.skipped.length) {
        skippedN = r.skipped.length;
        toast('跳过 ' + r.skipped.length + ' 首', r.skipped.join('、'), 'error');
      }
      if (!r || !r.ok || !r.urls.length) {
        throw new Error((r && r.error) || '这批曲目都没有可用音源');
      }
      setStatus('解析完成（' + (usedLabel || '?') + (anonNote ? ' · 部分改用匿名音源' : '') + '），正在写入歌单…');
      return ensurePlaylist(NE_PLAYLIST).then(function (idx) {
        if (idx == null || idx < 0) throw new Error('无法创建播放列表');
        // 追加而不是整单替换：之前播的歌原地保留。
        // 一律用 apiOr 取曲目总数定位新曲起始索引 —— 取不到宁可报错，
        // 也不能拿 0 当索引（那会变成从歌单第一首开始播）
        return apiOr('playlist.getTracks', { playlist: idx, start: 0, count: 1 })
          .then(function (cnt) {
            if (cnt.total == null) throw new Error('取不到歌单曲目数，无法定位新曲');
            var base = cnt.total;
            // 必须用 addPathsSequential：playlist.addPaths 由 foobar 按"添加文件"的
            // 方式解析，**行不保持给定顺序** —— 那样 index: base 播的未必是这批第一首
            return apiOr('playlist.addPathsSequential', { playlist: idx, paths: r.urls })
              .then(function (res) {
                if (res.success === false) throw new Error(res.error || '宿主拒绝写入歌单');
                return apiOr('playlist.playTrack', { playlist: idx, index: base })
                  .then(function (pr) {
                    if (pr.success === false) throw new Error(pr.error || '播放请求被宿主拒绝');
                  });
              });
          });
      });
    }).then(function () {
      setStatus('已追加到 ' + NE_PLAYLIST + ' 并开播' + (usedLabel ? ' · ' + usedLabel : ''), 'ok');
      toast('开始播放', NE_PLAYLIST + ' · 追加 ' + (tracks.length - skippedN) + ' 首' +
            (usedLabel ? ' · ' + usedLabel : ''), 'success');
      dedupePlaylists(NE_PLAYLIST);
    }).catch(function (e) {
      setStatus('播放失败：' + (e && e.message || e), 'err');
      toast('播放失败', String(e && e.message || e), 'error');
    }).then(function () {
      S.busy = false;
      updateToolbar();
    });
  }

  /* 下载的取流落盘（grabToFile）/ 保存位置条 / 歌词写入都搬进了
     js/online-common.js。歌词由 cfg.getLyric 回调到 NeteaseBridge.lyricForId ——
     解析结果里带着歌曲 id，按 id 精确取词比「标题 + 歌手」模糊匹配准。 */

  /* 解析结果 + 曲目 → 下载计划（文件名带歌手，同批重名加序号；
     带 id 供 cfg.getLyric 按 id 取词；.lrc 与音频同名同目录） */
  function buildPlan(resolves, tracks) {
    var byId = {};
    (tracks || []).forEach(function (t) { if (t && t.id) byId[t.id] = t; });
    var used = {};
    return (resolves || []).map(function (rv) {
      var t = byId[rv.id] || {};
      var base = safeName((t.artist ? t.artist + ' - ' : '') + (t.title || rv.id));
      var name = base + extOfUrl(rv.url, rv.type);
      var n = 1;
      while (used[name]) { name = base + ' (' + (++n) + ')' + extOfUrl(rv.url, rv.type); }
      used[name] = 1;
      return {
        url: rv.url, name: name,
        lrcName: name.replace(/\.[a-z0-9]+$/i, '') + '.lrc',
        id: rv.id, title: t.title || '', artist: t.artist || '',
        duration: t.interval || 0, level: rv.level
      };
    });
  }

  function downloadTracks(tracks) {
    if (!tracks.length) { toast('先勾选几首', null, 'error'); return; }
    if (!S.online) { toast('桥接未就绪', '稍等片刻再试', 'error'); return; }
    if (S.dlRun) { S.dlCancel = true; setStatus('已请求停止：当前这首下完就停…'); return; }
    if (S.busy || S.impRun) { toast('正在处理上一批', '稍等一下再点', 'error'); return; }
    S.busy = true;
    // 与另外两页一致：解析阶段也把按钮切成「停止」，并按停止就真的不下
    // （runDownloads 不再清 dlCancel，所以这里必须自己清，否则上次的停止会留到这一轮）
    S.dlRun = true;
    S.dlCancel = false;
    S.dlDone = 0;
    S.dlTotal = 0;
    updateToolbar();
    setStatus('正在解析 ' + tracks.length + ' 首（' + (LEVEL_LABEL[S.quality] || S.quality) + '）…');

    NeteaseBridge.resolveMany(tracks, S.quality).then(function (r) {
      S.busy = false;
      if (S.dlCancel) { S.dlRun = false; updateToolbar(); setStatus('已停止（解析完成，未开始下载）', 'warn'); return; }
      if (r && r.note) toast('已自动改用匿名音源', r.note);
      if (r && r.skipped && r.skipped.length) {
        toast('跳过 ' + r.skipped.length + ' 首', r.skipped.join('、'), 'error');
      }
      if (!r || !r.ok || !r.resolves.length) {
        throw new Error((r && r.error) || '这批曲目都没有可用音源');
      }
      return runDownloads(buildPlan(r.resolves, tracks));
    }).catch(function (e) {
      S.busy = false;
      S.dlRun = false;
      setStatus('解析失败：' + (e && e.message || e), 'err');
      toast('解析失败', String(e && e.message || e), 'error');
      updateToolbar();
    });
  }

  /* ------------------------------------------------------------
   * 歌单导入（粘贴链接 / ID → 读曲目 → 批量解析 → 追加开播）
   * ---------------------------------------------------------- */
  function showImportRunning(on) {
    if ($('nemImportStart')) $('nemImportStart').hidden = !!on;
    if ($('nemImportStop')) $('nemImportStop').hidden = !on;
  }

  function toggleImportPanel() {
    // 与「登录 / Cookie」完全同一套开关实现（K.togglePanel），手感统一
    K.togglePanel('nemImportPanel');
  }

  function startImport() {
    if (!S.online) { toast('桥接未就绪', '稍等片刻再试', 'error'); return; }
    // 与播放 / 下载互斥（导入不置 S.busy，所以必须在这里显式拦这两条）
    if (S.busy || S.dlRun) { toast('正在处理上一批', '稍等一下再点', 'error'); return; }
    if (S.impRun) return;
    var raw = ($('nemImportInput') || {}).value || '';
    var id = NeteaseBridge.parsePlaylistId(raw);
    if (!id) { toast('请填歌单链接或 ID', '例如 https://music.163.com/#/playlist?id=3778678', 'error'); return; }
    var name = (($('nemImportName') || {}).value || '').trim() || '网易云导入';

    S.impRun = true;
    S.impCancel = false;
    showImportRunning(true);
    updateToolbar();
    setStatus('正在读取歌单 ' + id + '…');

    NeteaseBridge.playlist(id).then(function (pl) {
      if (!pl.ok) throw new Error(pl.error || '读歌单失败');
      var tracks = pl.tracks || [];
      if (!tracks.length) throw new Error('这个歌单里没有曲目（私密歌单需要先设置 Cookie）');
      var clipped = tracks.slice(0, IMPORT_MAX);
      var over = tracks.length - clipped.length;
      setStatus('「' + pl.name + '」共 ' + tracks.length + ' 首，正在解析音源（' +
                clipped.length + ' 首，在线播放固定 ' +
                (LEVEL_LABEL[NeteaseBridge.streamQuality()] || NeteaseBridge.streamQuality()) + '）…');

      // 批量解析：网易云一次请求能出 10 首，比逐首搜索快得多
      // 注意用 streamQuality()：导入的曲目是要**播放**的，不能拿无损 FLAC 直链
      // 交给宿主（CDN 的 Content-Type 不对，foobar 会报"不支持的格式或文件损坏"）
      var urls = [], failed = [];
      return NeteaseBridge.resolveMany(clipped, NeteaseBridge.streamQuality(), { forStream: true }).then(function (r) {
        if (r.resolves && r.resolves.length) {
          r.resolves.forEach(function (rv) {
            urls.push(rv.url);
          });
        }
        (r.skipped || []).forEach(function (why) { failed.push(why); });
        if (!urls.length) throw new Error('这个歌单里没有可播放的曲目（' + (r.error || '') + '）');
        if (S.impCancel) { setStatus('已停止导入', 'warn'); return null; }

        setStatus('正在写入歌单「' + name + '」（' + urls.length + ' 首）…');
        return ensurePlaylist(name).then(function (idx) {
          if (idx == null || idx < 0) throw new Error('无法创建播放列表');
          return apiOr('playlist.getTracks', { playlist: idx, start: 0, count: 1 })
            .then(function (cnt) {
              if (cnt.total == null) throw new Error('取不到歌单曲目数，无法定位新曲');
              var base = cnt.total;
              // addPathsSequential：导入整个歌单时行顺序必须与原歌单一致，
              // addPaths 由 foobar 按"添加文件"的方式解析、不保序（导入后顺序会乱）
              return apiOr('playlist.addPathsSequential', { playlist: idx, paths: urls })
                .then(function (res) {
                  if (res.success === false) throw new Error(res.error || '宿主拒绝写入歌单');
                  if (base === 0) {
                    return apiOr('playlist.playTrack', { playlist: idx, index: 0 });
                  }
                  return null;
                });
            }).then(function () {
              setStatus('导入完成：' + urls.length + ' 首已写入「' + name + '」' +
                        (failed.length ? ' · ' + failed.length + ' 首未导入' : '') +
                        (over > 0 ? ' · 超出上限 ' + over + ' 首未处理' : ''),
                        failed.length ? 'warn' : 'ok');
              toast('导入完成', name + ' · ' + urls.length + ' 首' +
                    (failed.length ? '（' + failed.length + ' 首未导入）' : ''), 'success');
              // 与 QQ 导入同口径：顺手清掉同名空壳歌单（getAll 抖动攒下的）
              dedupePlaylists(name);
            });
        });
      });
    }).catch(function (e) {
      setStatus('导入失败：' + (e && e.message || e), 'err');
      toast('导入失败', String(e && e.message || e), 'error');
    }).then(function () {
      S.impRun = false;
      showImportRunning(false);
      updateToolbar();
    });
  }

  /* ------------------------------------------------------------
   * Cookie 面板
   * ---------------------------------------------------------- */

  /* 登录成功后**立刻校验**并把结果说清楚：是不是有效登录态、能不能拿到无损。 */
  function verifyLogin() {
    S.hasCookie = NeteaseBridge.hasLogin();
    S.vip = null;
    var seq = ++acctSeq;   // 连续保存两次 Cookie：上一次校验的慢回包不许覆盖这次
    setStatus('正在校验登录状态…');
    NeteaseBridge.account().then(function (a) {
      if (seq !== acctSeq) return;
      S.acct = a;
      if (!a || !a.ok) {
        // 分清"Cookie 不认"和"接口没问成"：account() 把网络失败也归成 !ok，
        // 一律报"请重新登录"会让断网的用户白忙一场
        if (a && a.error) {
          setStatus('已保存 Cookie，但账号接口暂时不可用（网络问题？稍后再点一次）', 'warn');
          return;
        }
        toast('Cookie 未通过校验', '可能复制不全或已过期 —— 请重新登录一次', 'error');
        // 不调 renderStatus()：它只会给出通用的「Cookie 已失效」，这句更具体
        setStatus('已保存 Cookie，但账号接口不认（多半失效了）：重登一次即可', 'warn');
        return;
      }
      return NeteaseBridge.vipInfo().then(function (v) {
        if (seq !== acctSeq) return;
        S.vip = v;
        var name = a.nickname ? '「' + a.nickname + '」' : '';
        if (v && v.vip) {
          var exp = v.expire ? new Date(v.expire) : null;
          var day = exp ? (exp.getFullYear() + '-' + ('0' + (exp.getMonth() + 1)).slice(-2) + '-' + ('0' + exp.getDate()).slice(-2)) : '';
          toast('登录成功' + name, '会员有效至 ' + (day || '未知') + ' —— 无损 / 会员曲目已可用', 'success');
        } else {
          toast('登录成功' + name, '该账号不是会员：会员曲目仍只能试听 30/45 秒，无损会降级到 320K', 'warn');
        }
        renderStatus();
      });
    }).catch(function () {
      setStatus('已保存 Cookie，但校验请求失败（网络问题？稍后再试）', 'warn');
    });
  }

  function saveCookieFromPanel() {
    var ta = $('nemCookieInput');
    if (!ta || !window.NeteaseBridge) return;
    if (!NeteaseBridge.setCookie(ta.value)) {
      // setCookie 解析不出内容时按「清除」处理（已存登录态会被删掉）——如实告诉用户，
      // 否则他以为"只是没识别到"，重试时用的还是那份存不进去的东西
      S.hasCookie = false;
      S.vip = null;
      S.acct = null;
      toast('没识别到登录态', 'Cookie 里必须有 MUSIC_U —— 原有登录态已清除，请按「怎么取？」重新复制一次', 'error');
      renderStatus();
      return;
    }
    verifyLogin();
  }

  /* 扫码登录（已移除，别再按旧版思路加回来）
     ------------------------------------------------------------
     链路本身是通的（取 unikey → 轮询 → 803「授权登陆成功」都到了），但宿主的
     HTTP 客户端对多个 Set-Cookie **只保留最后一个**，而网易云在这一步会连发
     MUSIC_U 与其它 Cookie —— MUSIC_U 必然丢，登录态拿不到。这是宿主的限制，
     解析层面无解，所以二维码渲染与轮询逻辑（含二维码库）已整体删除，
     只保留手动粘贴。详见 README / 指南里的说明。 */

  function clearCookieFromPanel() {
    if (!window.NeteaseBridge) return;
    NeteaseBridge.clearCookie();
    acctSeq++;               // 在途的登录校验回包一律作废，别覆盖"已清除"的状态
    S.hasCookie = false;
    S.vip = null;
    S.acct = null;
    var ta = $('nemCookieInput');
    if (ta) ta.value = '';
    toast('已清除 Cookie', '回到未登录状态（免费曲库仍可用）', 'success');
    reconnect();
  }

  /* ------------------------------------------------------------
   * 事件绑定
   * ---------------------------------------------------------- */
  function bind() {
    if ($('nemInput')) {
      $('nemInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') search();
      });
    }
    if ($('nemSearchBtn')) $('nemSearchBtn').addEventListener('click', search);
    if ($('nemQuality')) {
      $('nemQuality').addEventListener('change', function (e) {
        S.quality = NeteaseBridge.setQuality(e.target.value);
        setStatus('音质已切换为 ' + (LEVEL_LABEL[S.quality] || S.quality) +
                  '（同时作用于在线播放与下载）', 'ok');
      });
    }
    if ($('nemAll')) {
      $('nemAll').addEventListener('change', function (e) {
        if (e.target.checked) {
          S.songs.forEach(function (s) { if (s.id) S.picked[s.id] = s; });
        } else {
          S.songs.forEach(function (s) { if (s.id) delete S.picked[s.id]; });
        }
        renderList();
        updateToolbar();
      });
    }
    if ($('nemPlayBtn')) {
      $('nemPlayBtn').addEventListener('click', function () { playTracks(pickedList()); });
    }
    if ($('nemDownloadBtn')) {
      $('nemDownloadBtn').addEventListener('click', function () { downloadTracks(pickedList()); });
    }
    if ($('nemDlOpen')) $('nemDlOpen').addEventListener('click', openDlFolder);
    if ($('nemDlCopy')) $('nemDlCopy').addEventListener('click', copyDlPath);

    var list = $('nemList');
    if (list) {
      list.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || t.type !== 'checkbox') return;
        var id = Number(t.getAttribute('data-id'));
        var s = songById(id);
        if (!s) return;
        if (t.checked) S.picked[id] = s; else delete S.picked[id];
        var row = t.closest ? t.closest('.nem-row') : null;
        if (row) row.className = 'nem-row' + (t.checked ? ' sel' : '');
        syncAllBox();
        updateToolbar();
      });
      list.addEventListener('click', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('[data-act="more"]')) { loadMore(); return; }
        var one = t.closest('[data-act="one"]');
        if (one) {
          var s = songById(Number(one.getAttribute('data-id')));
          if (s) playTracks([s]);
          return;
        }
        /* 点整行也能勾选（「QQ 音乐」页就是这么做的，指南里也这么写）。
           复选框所在的 label 自己会翻转，别重复处理。 */
        var row = t.closest('.nem-row');
        if (row && !t.closest('label')) {
          var cb = row.querySelector('input[type=checkbox]');
          if (cb) {
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
      list.addEventListener('dblclick', function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        // 行内「播放」按钮要排除：单击已经播了，不排除的话第二次 playTracks
        // 会撞上 busy 守卫，弹出"正在处理上一批"这种莫名其妙的报错
        if (t.closest('[data-act="one"]')) return;
        var row = t.closest('.nem-row');
        if (!row) return;
        var s = songById(Number(row.getAttribute('data-id')));
        if (s) playTracks([s]);
      });
    }

    if ($('nemPrevBtn')) $('nemPrevBtn').addEventListener('click', prevPage);
    if ($('nemNextBtn')) $('nemNextBtn').addEventListener('click', nextPage);
    if ($('nemGoBtn')) {
      $('nemGoBtn').addEventListener('click', function () {
        var v = parseInt(($('nemPageInput') || {}).value, 10);
        if (v > 0) gotoPage(v);
      });
    }
    if ($('nemPageInput')) {
      $('nemPageInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var v = parseInt(this.value, 10);
          if (v > 0) gotoPage(v);
        }
      });
      $('nemPageInput').addEventListener('input', function () {
        this.value = this.value.replace(/[^0-9]/g, '');
      });
    }

    if ($('nemLoginBtn')) $('nemLoginBtn').addEventListener('click', openCookiePanel);
    if ($('nemSetupRetry')) $('nemSetupRetry').addEventListener('click', function () { showSetup(false); });
    if ($('nemCookieHelpBtn')) {
      $('nemCookieHelpBtn').addEventListener('click', function () {
        var h = $('nemCookieHelp');
        if (h) h.hidden = !h.hidden;        // 只切换自己那一块，不牵动别的元素
      });
    }
    if ($('nemCookieSave')) $('nemCookieSave').addEventListener('click', saveCookieFromPanel);
    if ($('nemCookieClear')) $('nemCookieClear').addEventListener('click', clearCookieFromPanel);
    if ($('nemImportBtn')) $('nemImportBtn').addEventListener('click', toggleImportPanel);
    if ($('nemImportClose')) $('nemImportClose').addEventListener('click', function () {
      var p = $('nemImportPanel'); if (p) p.hidden = true;
    });
    if ($('nemImportStart')) $('nemImportStart').addEventListener('click', startImport);
    if ($('nemImportStop')) {
      $('nemImportStop').addEventListener('click', function () {
        S.impCancel = true;
        setStatus('已请求停止导入…', 'warn');
      });
    }
  }

  /* ------------------------------------------------------------
   * 启动：首次进入该页时才做连接检查
   * ---------------------------------------------------------- */
  var firstShown = false;

  function onShow() {
    injectCss();
    if (firstShown) return;
    firstShown = true;
    reconnect();
  }

  // 钩住 switchTab：切到 netease 时初始化（不改主题原有代码）
  if (typeof CM.switchTab === 'function') {
    var _switchTab = CM.switchTab;
    CM.switchTab = function (tab) {
      _switchTab.apply(CM, arguments);
      if (tab === 'netease') onShow();
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  // 调试入口（DevTools 里可直接调；window.NeteaseBridge 上还有 bridgeInfo() 等）
  CM.netease = {
    state: S, reconnect: reconnect, search: search, loadMore: loadMore,
    gotoPage: gotoPage, prevPage: prevPage, nextPage: nextPage,
    playTracks: playTracks, downloadTracks: downloadTracks,
    startImport: startImport, downloadDir: downloadDir,
    PAGE_SIZE: PAGE_SIZE, showSetup: showSetup
  };
})();
