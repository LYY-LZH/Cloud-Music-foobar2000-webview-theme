/* ============================================================
 * CloudMusic 主题扩展 · QQ 音乐在线音源页（ui-qqmusic.js）
 * ------------------------------------------------------------
 * 依赖页内桥接模块 js/qqmusic-core.js（window.QQBridge）：
 *   搜索 / 直链解析 / 歌词 / Cookie 都在同一个页面进程里完成，
 *   走宿主 foo_ui_webview2 的原生 HTTP 客户端（无 CORS）；
 *   播放交给 foobar2000 宿主自己的 API，下载落盘走宿主文件 API。
 *   模块随主题页面加载，随 foobar 启动而在、关闭而消，
 *   无本地进程 / 端口 / 外部运行时依赖。
 * ============================================================ */
(function () {
  'use strict';

  var CM = window.CloudMusic;
  if (!CM) return;

  var QUALITY_LABEL = { master: '臻品母带', hires: 'Hi-Res 24bit', flac: 'SQ 无损 FLAC',
                        aac192: 'AAC 192K', '320': '320K MP3', aac96: 'AAC 96K',
                        '128': '128K MP3' };

  /* ------------------------------------------------------------
   * Cookie 面板显隐
   * ------------------------------------------------------------
   * 默认收起。只有用户主动点「设置 Cookie」时才展开（qqmusic-core.js
   * 没加载成功时不展开 —— 没有 QQBridge 可保存，面板给了也没用，
   * 那时状态栏会写清楚缺哪个脚本）。
   * ---------------------------------------------------------- */

  var S = {
    songs: [],          // 当前**这一页**的搜索结果（翻页会整页替换）
    // 已勾选的曲目：{songmid: 曲目对象}。按 songmid 记而不是按下标记 ——
    // 翻页时整个列表会被换掉，用下标的话勾选立刻就乱了。这样还能跨页攒一批
    // （第 1 页勾 3 首、翻到第 4 页再勾 2 首），一起送去播放。
    picked: {},
    quality: 'master',
    online: false,      // 页内桥接是否就绪（qqmusic-core.js 加载成功即 true）
    hasCookie: false,   // 是否已登录 QQ 音乐
    kw: '',             // 最近一次搜索词
    busy: false,
    page: 1,            // 当前是第几页（从 1 开始）
    more: false,        // 上游还有没有下一页
    loadingMore: false,
    paging: false,      // 正在翻页（期间禁用翻页控件，防连点）
    seq: 0,             // 列表操作序号：搜索 / 翻页自增，旧响应回来时对不上即丢弃（在途响应不可取消）
    dlDone: 0,          // 本轮下载已完成数
    dlTotal: 0,         // 本轮下载总数（0 = 还没开始下载）
    dlRun: false,       // 正在下载（区别于 playTracks 的 busy，只有它为真时点击才算「停止」）
    dlCancel: false,    // 请求停止（当前这首下完就停）
    impRun: false,      // 正在导入歌单（逐首搜索 + 解析 + 追加）
    impCancel: false    // 请求停止导入
  };

  /* 通用件：样式表、下载落盘、歌单写入、通用小工具都来自 js/online-common.js
     （与「网易云」页共用同一份实现；以前两边各存一份，已经漂移过）。
     这里只做本地别名 —— 下面的调用点一行都不用改。 */
  var K = CM.onlineCommon({
    prefix: 'qqm',
    statusId: 'qqmStatus', setupId: 'qqmSetup', cookieInputId: 'qqmCookieInput',
    dlRowId: 'qqmDlRow', dlPathId: 'qqmDlPath', cssId: 'qqmStyle',
    bridge: function () { return window.QQBridge; },
    dirName: 'QQ音乐下载', dirNameOld: 'qqmusic-downloads',
    state: S,
    onProgress: function () { updateToolbar(); },
    getLyric: function (it) { return QQBridge.lyric(it.title || '', it.artist || '', it.duration | 0); }
  });
  /* 只别名本页真正用到的（K.buildPlan / K.saveLyric 的包装原来也在这，但都被
     下面同名函数声明覆盖、从未执行过，连同 hostErr / listsOf / joinPath /
     grabToFile / showDlRow / dlRowPath 这些只有别名没有调用点的死别名一起删了） */
  var $ = K.$, mmss = K.mmss, apiOr = K.apiOr, toast = K.toast, setStatus = K.setStatus,
      copyText = K.copyText, ensurePlaylist = K.ensurePlaylist,
      dedupePlaylists = K.dedupePlaylists, safeName = K.safeName, extOfUrl = K.extOfUrl,
      downloadDir = K.downloadDir,
      openDlFolder = K.openDlFolder, copyDlPath = K.copyDlPath, runDownloads = K.runDownloads,
      showSetup = K.showSetup, openCookiePanel = K.toggleSetup, injectCss = K.injectCss;

  /* ------------------------------------------------------------
   * 通用小工具
   * ---------------------------------------------------------- */
  var esc = CM.escHtml;                     // 转义复用 core.js 的实现

  /* ------------------------------------------------------------
   * 状态：桥接自检 / 刷新登录态
   * ---------------------------------------------------------- */
  function reconnect() {
    if (!window.QQBridge) {
      S.online = false;
      setStatus('内置桥接模块（js/qqmusic-core.js）未加载 —— 检查 index.html 里的脚本引用', 'err');
      showSetup(false);
      return Promise.resolve(false);
    }
    var c = QQBridge.config();
    S.online = true;
    S.hasCookie = !!c.hasCookie;
    if (c.quality) {
      S.quality = c.quality;
      if ($('qqmQuality')) $('qqmQuality').value = c.quality;
    }
    setStatus(
      '内置桥接就绪 · ' + (S.hasCookie ? '已登录' : '未登录（仅免费曲库）') +
      ' · 当前音质 ' + (QUALITY_LABEL[S.quality] || S.quality) +
      ' · 歌词服务可用',
      S.hasCookie ? 'ok' : 'warn'
    );
    showSetup(false);
    return Promise.resolve(true);
  }

  /* ------------------------------------------------------------
   * 搜索
   * ---------------------------------------------------------- */
  /* 每页 30 首。搜索歌手名时结果常常上百首，所以带上页码 p，
   * 列表底部给一个「加载更多」把下一页追加进来（不翻页、不清空，
   * 这样已经勾选的曲目不会被弄丢）。 */
  var PAGE_SIZE = 30;

  function search() {
    var kw = ($('qqmInput') || {}).value || '';
    kw = kw.trim();
    if (!kw) return;
    if (!S.online) { reconnect(); return; }
    S.kw = kw;
    S.page = 1;
    S.more = false;
    S.paging = false;
    // 在途的「加载更多」已被本搜索作废（seq 拦截），标志必须立刻清掉：
    // 否则新结果先渲染时底部还挂着「正在加载…」、翻页全被禁用，而过期响应
    // 落地时只丢数据不重绘，界面会卡在这个状态
    S.loadingMore = false;
    var seq = ++S.seq;                 // 在途的旧 搜索/翻页/加载更多 响应回来后按序号丢弃
    setStatus('正在搜索「' + kw + '」…');
    renderLoading();

    QQBridge.search(kw, 1, PAGE_SIZE)
      .then(function (d) {
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
          setStatus(searchSummary(), S.hasCookie ? 'ok' : 'warn');
          renderList();
        }
        updateToolbar();
      }).catch(function (e) {
        if (seq !== S.seq) return;
        // 清掉旧列表：否则错误提示下面是空列表、翻页条却还亮着上一轮的状态
        // （已勾选的曲目保留在 S.picked 里，跨页攒的选择不会因一次失败丢掉）
        S.songs = [];
        S.more = false;
        setStatus('搜索失败：' + (e && e.message || e), 'err');
        renderEmpty('搜索失败，稍后再试');
      });
  }

  /* 列表底部的状态摘要：搜到了多少 / 还能不能翻 */
  function searchSummary() {
    return '「' + S.kw + '」已加载 ' + S.songs.length + ' 首' +
      (S.more ? '（还有更多）' : '') + ' · ' +
      (S.hasCookie ? '已登录' : '未登录（VIP 曲目会被跳过）');
  }

  /* 加载下一页并追加到列表末尾 */
  function loadMore() {
    // S.paging 也要拦：翻页只重绘翻页条、不清列表，旧列表上的"加载更多"
    // 仍可点 —— 不拦的话两个响应都会通过各自的 seq 校验，把页码/追加状态搅乱
    if (S.loadingMore || S.paging || !S.more || !S.online || !S.kw) return;
    S.loadingMore = true;
    var seq = S.seq;                   // 期间若发起新搜索 / 翻页，这个响应就成了旧数据
    setStatus('正在加载第 ' + (S.page + 1) + ' 页…');
    renderList();                                   // 让按钮进入"加载中"
    QQBridge.search(S.kw, S.page + 1, PAGE_SIZE).then(function (d) {
      // 旧响应直接丢弃，**不要碰标志位**：旗标此时归新操作所有，
      // 这里清掉会把正在进行的加载显示成"没在加载"，还能再点出第二个请求
      if (seq !== S.seq) return;
      if (!d || !d.ok) throw new Error((d && d.error) || '加载失败');
      var rows = d.songs || [];
      // 去重：万一上游分页有重叠，别让同一首出现两次
      var seen = {};
      for (var i = 0; i < S.songs.length; i++) seen[S.songs[i].songmid] = 1;
      var fresh = rows.filter(function (x) { return x && !seen[x.songmid]; });
      S.songs = S.songs.concat(fresh);
      S.page++;
      // 这一页没装满、或者全是重复的 → 后面不会再有了
      S.more = !!d.more && fresh.length > 0;
      S.loadingMore = false;
      setStatus(searchSummary(), S.hasCookie ? 'ok' : 'warn');
      renderList();
      updateToolbar();
    }).catch(function (e) {
      if (seq !== S.seq) return;
      S.loadingMore = false;
      renderList();
      toast('加载更多失败', String((e && e.message) || e), 'error');
      setStatus('加载更多失败：' + ((e && e.message) || e), 'err');
    });
  }

  /* ------------------------------------------------------------
   * 翻页
   * ------------------------------------------------------------
   * 和「加载更多」的区别：
   *   翻页（上一页 / 下一页 / 跳页）= 把列表**整页替换**成第 N 页
   *   加载更多                      = 把下一页**追加**到列表末尾
   * 两者都基于 S.page（列表当前显示到第几页）。
   *
   * 注意：上游**不返回总页数**，所以画面上只能显示"第 N 页"，
   * 没有"共 N 页"；「下一页」能不能点，靠 more 推断。
   * 越界也只能"请求完发现是空的"才知道 —— 那时**不动列表**，
   * 只提示一句，别让用户对着空列表以为坏了。
   * ---------------------------------------------------------- */
  function gotoPage(p) {
    if (S.paging || !S.online || !S.kw) return;
    p = parseInt(p, 10);
    if (!(p >= 1)) p = 1;
    if (p === S.page && S.songs.length) { renderPager(); return; }

    S.paging = true;
    S.loadingMore = false;             // 同 search：作废在途的「加载更多」，别让页脚卡在加载态
    var seq = ++S.seq;
    renderPager();
    setStatus('正在打开第 ' + p + ' 页…');

    QQBridge.search(S.kw, p, PAGE_SIZE)
      .then(function (d) {
        if (seq !== S.seq) return;                 // 旧响应：标志位归新操作，不碰
        if (!d || !d.ok) throw new Error((d && d.error) || '翻页失败');
        var rows = d.songs || [];
        S.paging = false;
        if (!rows.length) {
          renderPager();
          toast('没有第 ' + p + ' 页', '已经到底了', 'error');
          setStatus(searchSummary(), S.hasCookie ? 'ok' : 'warn');
          return;
        }
        S.songs = rows;
        S.page = p;
        S.more = !!d.more;
        setStatus(searchSummary(), S.hasCookie ? 'ok' : 'warn');
        renderList();
        updateToolbar();
        // 翻页后把列表滚回顶部 —— 不然内容换了、滚动条还停在下半截，
        // 看起来就像"点了没反应"
        var l = $('qqmList');
        if (l) l.scrollTop = 0;
      }).catch(function (e) {
        if (seq !== S.seq) return;
        S.paging = false;
        renderPager();
        toast('翻页失败', String((e && e.message) || e), 'error');
        setStatus('翻页失败：' + ((e && e.message) || e), 'err');
      });
  }

  function prevPage() { if (S.page > 1) gotoPage(S.page - 1); }
  function nextPage() { if (S.more) gotoPage(S.page + 1); }

  /* 翻页条状态同步：只改文字和禁用态，**不重建 DOM** —— 输入框重建会把
   * 用户打到一半的页码吃掉。 */
  function renderPager() {
    var box = $('qqmPager');
    if (!box) return;
    box.classList.toggle('on', !!S.songs.length);
    if (!S.songs.length) return;
    if ($('qqmPageNo')) $('qqmPageNo').textContent = S.page;
    var busy = !!(S.paging || S.loadingMore);
    if ($('qqmPrevBtn')) $('qqmPrevBtn').disabled = busy || S.page <= 1;
    if ($('qqmNextBtn')) $('qqmNextBtn').disabled = busy || !S.more;
    if ($('qqmGoBtn')) $('qqmGoBtn').disabled = busy;
    var inp = $('qqmPageInput');
    if (inp) {
      inp.disabled = busy;
      // 只在用户没在输入时回填，免得打字打到一半被覆盖
      if (document.activeElement !== inp) inp.value = S.page;
    }
  }

  /* ------------------------------------------------------------
   * 渲染
   * ---------------------------------------------------------- */
  function renderLoading() {
    var l = $('qqmList');
    if (l) l.innerHTML = CM.emptyHTML('搜索中…');
    renderPager();
  }

  function renderEmpty(msg) {
    var l = $('qqmList');
    if (l) l.innerHTML = CM.emptyHTML(msg);
    renderPager();
  }

  function renderList() {
    // 行标识用 songmid、不用下标 —— 翻页会整页换掉 songs，下标立刻就对不上了
    var html = S.songs.map(function (s) {
      var mid = s.songmid || '';
      var on = !!S.picked[mid];
      var cover = s.albummid
        ? '<img src="' + esc(QQBridge.coverUrl(s.albummid)) + '" alt="" loading="lazy" ' +
          'onerror="this.style.display=\'none\'">'
        : '';
      var avail = s.avail || [];
      var tags = '';
      if (avail.indexOf('master') >= 0) tags += '<span class="qqm-tag qqm-tag-hi">母带</span>';
      else if (avail.indexOf('hires') >= 0) tags += '<span class="qqm-tag qqm-tag-hi">Hi-Res</span>';
      else if (avail.indexOf('flac') >= 0) tags += '<span class="qqm-tag qqm-tag-sq">无损</span>';
      if (s.vip) tags += '<span class="qqm-tag">VIP</span>';
      return '' +
        '<div class="qqm-row' + (on ? ' sel' : '') + '" data-mid="' + esc(mid) + '">' +
          '<label class="qqm-check" onclick="event.stopPropagation()">' +
            '<input type="checkbox" data-mid="' + esc(mid) + '"' + (on ? ' checked' : '') + '>' +
          '</label>' +
          '<div class="qqm-cover">' + cover + '</div>' +
          '<div class="qqm-meta">' +
            '<div class="qqm-name">' + esc(s.title) + tags + '</div>' +
            '<div class="qqm-artist">' + esc(s.artist) +
              (s.album ? ' · ' + esc(s.album) : '') + '</div>' +
          '</div>' +
          '<div class="qqm-dur">' + mmss(s.interval) + '</div>' +
          '<button class="qqm-btn qqm-btn-sm" data-act="one" data-mid="' + esc(mid) + '">播放</button>' +
        '</div>';
    }).join('');

    // 列表底部：还有更多就给按钮，否则给一句"到底了"，让用户知道不是卡住了
    var foot = '';
    if (S.songs.length) {
      if (S.loadingMore) {
        foot = '<div class="qqm-more"><span class="qqm-more-hint">正在加载…</span></div>';
      } else if (S.more) {
        foot = '<div class="qqm-more"><button class="qqm-btn qqm-more-btn" data-act="more">' +
               '加载更多（已加载 ' + S.songs.length + ' 首）</button></div>';
      } else {
        foot = '<div class="qqm-more"><span class="qqm-more-hint">没有更多了 · 共 ' +
               S.songs.length + ' 首</span></div>';
      }
    }

    var l = $('qqmList');
    if (l) l.innerHTML = '<div class="qqm-rows">' + html + '</div>' + foot;
    renderPager();
    syncAllBox();
  }

  /* ------------------------------------------------------------
   * 已选曲目
   * ---------------------------------------------------------- */
  /* 按 songmid 找回曲目 —— 行上的 data-mid 靠它对上号。
   * 当前页找不到就翻已选表（翻页走了、但还留着勾选的情况）。 */
  function songByMid(mid) {
    if (!mid) return null;
    for (var i = 0; i < S.songs.length; i++) {
      if (S.songs[i].songmid === mid) return S.songs[i];
    }
    return S.picked[mid] || null;
  }

  /* 已勾选的曲目，按勾选先后（可以跨页攒） */
  function pickedList() {
    var out = [];
    for (var k in S.picked) {
      if (Object.prototype.hasOwnProperty.call(S.picked, k)) out.push(S.picked[k]);
    }
    return out;
  }

  /* 全选框只反映"当前这一页是否都选了" */
  function syncAllBox() {
    var cb = $('qqmAll');
    if (!cb) return;
    cb.checked = S.songs.length > 0 && S.songs.every(function (s) {
      return !s.songmid || !!S.picked[s.songmid];
    });
  }

  function updateToolbar() {
    var n = Object.keys(S.picked).length;
    if ($('qqmCount')) $('qqmCount').textContent = '已选 ' + n + ' 首';
    if ($('qqmPlayBtn')) {
      $('qqmPlayBtn').disabled = S.busy || n === 0;
      var sp = $('qqmPlayBtn').querySelector('span');
      if (sp) sp.textContent = S.busy ? '处理中…' : '在 foobar2000 播放';
    }
    if ($('qqmDownloadBtn')) {
      // 下载中保持可点 —— 再点一次是「停止」，所以这时不能跟着 busy 禁用
      $('qqmDownloadBtn').disabled = S.dlRun ? false : (S.busy || n === 0);
      var sd = $('qqmDownloadBtn').querySelector('span');
      if (sd) {
        sd.textContent = S.dlRun
          ? (S.dlTotal ? '停止下载 ' + S.dlDone + '/' + S.dlTotal : '解析中…')
          : '下载选中';
      }
    }
  }

  /* ------------------------------------------------------------
   * 播放：解析音源 → 追加进固定的「QQ音乐」歌单并从新曲开播
   *   1) QQBridge.resolveMany() → { urls[] }（页内逐首解析 + 探测可用性）
   *   2) ensurePlaylist() → 找到 / 新建固定的「QQ音乐」歌单
   *   3) playlist.addPathsSequential 追加到歌单末尾（保序 —— 之后按"追加前的
   *      总数"起播才一定是这批的第一首；之前播的歌原地保留，听完可以直接在
   *      歌单里接着选），playlist.playTrack 从新曲开播
   * ---------------------------------------------------------- */
  /* playlist.getAll 的回包归一：宿主直接返回**数组**
     [{index,name,trackCount,isActive,isPlaying,…}]（ui-playlist.js 同款判断），
     对象信封只是兼容写法。此前按 {playlists:…} 解包，数组上取不到字段、
     永远得到 [] —— 查重永远查空、每次播放都新建「QQ音乐」的真正根因。
     （listsOf / ensurePlaylist / dedupePlaylists 均已上移到 online-common。） */

  /* 播放固定用这一个歌单：勾选的曲目**追加**进去并从新曲开播 ——
     之前播的歌原地保留，听完可以直接在歌单里接着选下一首；
     歌单固定只此一个，侧边栏不会堆满。 */
  var QQ_PLAYLIST = 'QQ音乐';

  function playTracks(tracks) {
    if (!tracks.length) { toast('先勾选几首', null, 'error'); return; }
    if (!S.online) { toast('桥接未就绪', '稍等片刻再试，或刷新页面', 'error'); reconnect(); return; }
    // 与 downloadTracks 同款并发守卫：批量解析进行中，行内「播放」/双击仍可点，
    // 不拦的话会并发跑第二条解析链、两批追加/开播互相竞态
    if (S.busy) { toast('正在处理上一批', '稍等一下再点', 'error'); return; }
    S.busy = true;
    updateToolbar();

    // 记 mediaMid→专辑 映射：在线播放的封面兜底靠它（artwork-resolver 从直链反查）
    if (window.QQBridge) QQBridge.rememberMediaCovers(tracks);

    var plName = QQ_PLAYLIST;
    var usedLabel = '';
    var skippedN = 0;   // 解析被跳过的首数：成功 toast 报实际追加数，不虚报
    /* 流播固定 MP3 档：未登录时服务端对无损档一律不给直链（实测 M800/F000/
       RS01/AI00 的 purl 全空）；登录态 F000（FLAC）直链的 Content-Type 已实测
       （2026-10-24，会员 Cookie）：audio/x-ogg——五台流媒体镜像主机全部一致、
       http / https 相同（字节其实是 fLaC），foobar 按类型选解码器当作 Ogg 拒解，
       换 https 也救不了（不同于网易云：那边有 octet-stream 镜像且 https 能流）。
       无损 / Hi-Res 请用「下载选中」落盘后本地播放（文件字节完好）。 */
    setStatus('正在解析 ' + tracks.length + ' 首曲目的音源（流播 MP3）…');

    QQBridge.resolveMany(tracks, 'mp3').then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || '音源解析失败');
      usedLabel = r.usedLabel || '';
      if (r.skipped && r.skipped.length) {
        skippedN = r.skipped.length;
        toast('跳过 ' + r.skipped.length + ' 首',
              r.skipped.join('、') +
              (S.hasCookie ? ' —— 没有版权 / 已下架，或 Cookie 已失效（重贴一次试试）'
                           : ' —— 需要先点右上角「设置 Cookie」'), 'error');
      }
      if (!r.urls || !r.urls.length) {
        throw new Error('这批曲目都没有可用音源，先点右上角「设置 Cookie」再试');
      }
      return ensurePlaylist(plName).then(function (idx) {
        if (idx == null || idx < 0) throw new Error('无法创建播放列表');
        // 追加而不是整单替换：之前播放的歌原地保留（直链 vkey 约两小时过期，
        // 过期条目再点会播放失败，重新勾选播放即可刷新）。
        // 先取曲目总数定位新曲起始索引：getTracks 回包自带 total，
        // count:1 只拖一项、不拉全单。
        // 这里一律用 apiOr：取不到总数时宁可报错，也不能拿 0 当索引 ——
        // 那会变成从歌单第一首（可能是很久以前播的歌）开始播。
        return apiOr('playlist.getTracks', { playlist: idx, start: 0, count: 1 })
          .then(function (cnt) {
            if (cnt.total == null) throw new Error('取不到歌单曲目数，无法定位新曲');
            var base = cnt.total;
            // 必须用 addPathsSequential：playlist.addPaths 由 foobar 按"添加文件"的
            // 方式解析，**行不保持给定顺序** —— 那样 index: base 播的未必是这批第一首
            return apiOr('playlist.addPathsSequential', { playlist: idx, paths: r.urls })
              .then(function () {
                // apiOr 已把失败信封转成 reject，这里不需要再判 success
                return apiOr('playlist.playTrack', { playlist: idx, index: base });
              });
          });
      });
    }).then(function () {
      setStatus('已追加到 ' + plName + ' 并开播' + (usedLabel ? ' · ' + usedLabel : ''), 'ok');
      toast('开始播放', plName + ' · 追加 ' + (tracks.length - skippedN) + ' 首' +
            (usedLabel ? ' · ' + usedLabel : ''), 'success');
      // getAll 抖动可能攒下同名歌单 —— 播放成功后顺手清一遍
      dedupePlaylists(plName);
    }).catch(function (e) {
      setStatus('播放失败：' + (e && e.message || e), 'err');
      toast('播放失败', String(e && e.message || e), 'error');
    }).then(function () {
      S.busy = false;
      updateToolbar();
    });
  }

  /* 下载目录 / 文件名清洗 / 取流落盘（grabToFile）/ 保存位置条都搬进了
     js/online-common.js，与网易云页共用同一份实现，本页不再各自留存。 */

  /* 解析结果 + 曲目 → 下载计划（文件名带歌手，同一批里重名加序号；
     同时带出歌词要用的字段 —— .lrc 与音频同名同目录，宿主会当成同名歌词）。
     resolves[] 里每项带 songmid（CDN 直链不能附加自定义参数，会破坏签名），
     所以不再像原版那样从 URL 的 sm 参数倒查。 */
  function buildPlan(resolves, tracks) {
    var byMid = {};
    (tracks || []).forEach(function (t) { if (t && t.songmid) byMid[t.songmid] = t; });
    var used = {};
    return (resolves || []).map(function (rv) {
      var t = byMid[rv.songmid] || {};
      var ext = extOfUrl(rv.url);
      // 「洛天依 / 亞細亞曠世奇才」这种多歌手用 & 连，别让斜杠被清洗成下划线
      var artist = String(t.artist || '').replace(/\s*\/\s*/g, ' & ');
      var base = safeName((artist ? artist + ' - ' : '') +
                          (t.title || rv.songmid || 'track'));
      var n = used[base] || 0;
      used[base] = n + 1;
      var finalBase = (n ? base + ' (' + (n + 1) + ')' : base);
      return {
        url: rv.url,
        name: finalBase + ext,
        lrcName: finalBase + '.lrc',
        title: t.title || '',
        artist: t.artist || '',
        duration: t.interval || 0
      };
    });
  }


  /* 歌词（下载时附带的同名 .lrc）走 online-common 的 saveLyric，
     由 cfg.getLyric 回调到 QQBridge.lyric —— 本页不再存一份实现。 */

  function downloadTracks(tracks) {
    // 下载中再点一次 = 停止（当前这首下完就停，不会留下半个文件）
    if (S.dlRun) { S.dlCancel = true; setStatus('正在停止 —— 当前这首下完就停', 'warn'); return; }
    if (S.busy) { toast('正在处理上一批', '稍等一下再点', 'error'); return; }
    if (!tracks.length) { toast('先勾选几首', null, 'error'); return; }
    if (!S.online) { toast('桥接未就绪', '稍等片刻再试，或刷新页面', 'error'); reconnect(); return; }

    // 记 mediaMid→专辑 映射（与 playTracks 同理，供封面兜底反查）
    if (window.QQBridge) QQBridge.rememberMediaCovers(tracks);

    S.busy = true;
    S.dlRun = true;
    S.dlCancel = false;
    S.dlDone = 0;
    S.dlTotal = 0;
    updateToolbar();
    setStatus('正在解析 ' + tracks.length + ' 首曲目的音源…');

    QQBridge.resolveMany(tracks, S.quality).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || '音源解析失败');
      if (r.skipped && r.skipped.length) {
        toast('跳过 ' + r.skipped.length + ' 首',
              r.skipped.join('、') +
              (S.hasCookie ? ' —— VIP 曲目需要会员账号（Cookie 失效也会这样，重新粘贴一次）'
                           : ' —— 需要先点右上角「设置 Cookie」'),
              'error');
      }
      if (!r.urls || !r.urls.length) {
        throw new Error('没有可下载的音源（VIP 曲目需要会员账号）');
      }
      return runDownloads(buildPlan(r.resolves, tracks));
    }).catch(function (e) {
      setStatus('下载失败：' + (e && e.message || e), 'err');
      toast('下载失败', String(e && e.message || e), 'error');
    }).then(function () {
      S.busy = false;
      S.dlRun = false;
      S.dlTotal = 0;
      updateToolbar();
    });
  }

  /* ------------------------------------------------------------
   * 歌单导入（按曲目文本匹配）
   * ------------------------------------------------------------
   * 账号歌单的「曲目详情」接口官方已启用请求签名 + 加密通道
   * （网页端走 musics.fcg 的 ag-1 加密请求体），主题侧无法可靠复刻；
   * 改为「曲目文本 → 搜索匹配」：每行「歌名 - 歌手」，用聚合搜索找
   * 同一首歌，解直链后逐首追加进歌单，第一首落地即开播。
   * ---------------------------------------------------------- */
  function parseImportLines(text) {
    var out = [], seen = {};
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var s = raw.replace(/\s+/g, ' ').trim();
      if (!s) return;
      s = s.replace(/^\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]\s*/, '');   // 行首时间戳
      s = s.replace(/^\d{1,3}\s*[.、)\]]\s*/, '');                 // 行首序号
      s = s.replace(/\s*[—–｜]\s*/g, ' - ')                        // 其他分隔符归一
           .replace(/\s*\|\s*/g, ' - ');
      if (!s || seen[s]) return;
      seen[s] = 1;
      var sep = s.indexOf(' - ');
      var title = sep > 0 ? s.slice(0, sep).trim() : s;
      var artist = sep > 0 ? s.slice(sep + 3).trim() : '';
      if (!title) return;
      out.push({ raw: s, title: title, artist: artist });
    });
    return out;
  }

  var IMPORT_MAX = 300;    // 单次导入上限（逐首搜索 + 解析，避免失控）

  function showImportRunning(on) {
    var a = $('qqmImportStart'), b = $('qqmImportStop');
    if (a) a.hidden = !!on;
    if (b) b.hidden = !on;
  }

  function startImport() {
    if (S.impRun) { S.impCancel = true; setStatus('正在停止 —— 当前这首完成后停', 'warn'); return; }
    if (S.busy) { toast('正在处理上一批', '稍等一下再点', 'error'); return; }
    if (!S.online) { reconnect(); return; }
    var ta = $('qqmImportText');
    var nameEl = $('qqmImportName');
    var lines = parseImportLines(ta ? ta.value : '');
    if (!lines.length) { toast('没有可导入的行', '每行一首：歌名 - 歌手', 'error'); return; }
    if (lines.length > IMPORT_MAX) {
      toast('行数超限', '单次最多 ' + IMPORT_MAX + ' 首（当前 ' + lines.length + '），已截断', 'warn');
      lines = lines.slice(0, IMPORT_MAX);
    }
    var plName = ((nameEl && nameEl.value) || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'QQ音乐导入';
    var noCookie = !(window.QQBridge && QQBridge.getCookie && QQBridge.getCookie());
    S.busy = true;
    S.impRun = true;
    S.impCancel = false;
    updateToolbar();
    showImportRunning(true);
    setStatus((noCookie ? '未登录（免费曲库）—— ' : '') + '开始导入 ' + lines.length + ' 首 → ' + plName);

    ensurePlaylist(plName).then(function (idx) {
      if (idx == null || idx < 0) throw new Error('无法创建歌单');
      return apiOr('playlist.getTracks', { playlist: idx, start: 0, count: 1 }).then(function (cnt) {
        if (cnt.total == null) throw new Error('取不到歌单曲目数，无法定位新曲');
        var base = cnt.total;
        var ok = 0, failed = [], firstPlayed = false, coverMids = [];
        function step(i) {
          if (S.impCancel) {
            setStatus('导入已停止：完成 ' + ok + '/' + lines.length +
                      (failed.length ? '，失败 ' + failed.length : ''), 'warn');
            return Promise.resolve();
          }
          var it = lines[i];
          setStatus('导入中 ' + (i + 1) + '/' + lines.length + '：' + it.title);
          var net0 = QQBridge.netErrors ? QQBridge.netErrors() : 0;
          return QQBridge.matchSong(it.title, it.artist).then(function (m) {
            if (!m) {
              // 网络异常导致整轮搜不到时，别写成「未匹配到歌曲」——
              // 那会让用户以为歌名写错了，其实是没连上
              var netFail = QQBridge.netErrors && QQBridge.netErrors() > net0;
              failed.push({ raw: it.raw, why: netFail ? '搜索失败（网络）' : '未匹配到歌曲' });
              return;
            }
            /* 记 mediaMid→专辑 映射：导入歌单的封面反查靠它（同 playTracks）。
               先攒起来、整批落盘 —— rememberMediaCovers 每次都把整张映射表
               JSON.stringify 后同步写 localStorage（外加 rememberNames 再写一张），
               逐行调用在几百首的导入里就是几百次全量序列化 */
            if (m.mediaMid && m.albummid) coverMids.push(m);
            /* 流播固定 MP3（同 playTracks；无损请用下载） */
            return QQBridge.resolveStream(m.songmid, 'mp3').then(function (rv) {
              // 与两页其余写入点统一用 addPathsSequential：addPaths 由 foobar 按"添加
              // 文件"的方式解析、不保序（此处单路径侥幸正确，统一口径免得日后改批量踩坑）
              return apiOr('playlist.addPathsSequential', { playlist: idx, paths: [rv.url] }).then(function () {
                ok++;
                if (!firstPlayed) {
                  firstPlayed = true;
                  return apiOr('playlist.playTrack', { playlist: idx, index: base })
                    .then(null, function () {});
                }
              }, function () { failed.push({ raw: it.raw, why: '写入歌单失败' }); });
            }, function (e) {
              failed.push({ raw: it.raw, why: (e && e.message) || '解析失败' });
            });
          }, function () { failed.push({ raw: it.raw, why: '搜索失败' }); });
        }
        function run(i) {
          if (i >= lines.length) return Promise.resolve();
          return step(i).then(function () { return run(i + 1); });
        }
        return run(0).then(function () {
          // 封面/歌名映射整批落盘一次（取消导入也照落 —— 已经解析过的曲目以后会遇到）
          if (coverMids.length) QQBridge.rememberMediaCovers(coverMids);
          if (S.impCancel) {
            // 最后一行处理期间取消：step 里的取消分支已过、汇总又被跳过 ——
            // 在这里补一条停止汇总，否则状态栏永远停在「导入中 N/N」
            setStatus('导入已停止：完成 ' + ok + '/' + lines.length +
                      (failed.length ? '，失败 ' + failed.length : ''), 'warn');
            return;
          }
          /* 按原因归类汇总 */
          var groups = {};
          failed.forEach(function (f) {
            var key = f.why.indexOf('未登录') >= 0 ? '未登录拿不到付费直链'
                    : f.why === '未匹配到歌曲' ? '未匹配'
                    : f.why.indexOf('拿不到直链') >= 0 ? '拿不到直链'
                    : f.why;
            groups[key] = (groups[key] || 0) + 1;
          });          var summary = Object.keys(groups).map(function (k) { return k + ' ' + groups[k]; }).join('，');
          var msg = '导入完成：成功 ' + ok + '/' + lines.length +
                    (failed.length ? '，失败 ' + failed.length + '（' + summary + '）' : '');
          setStatus(msg, ok ? 'ok' : 'err');
          if (failed.length) {
            /* 失败行放回文本框：可编辑后单独重试 */
            if (ta) ta.value = failed.map(function (f) { return f.raw; }).join('\n');
            toast(ok ? '导入完成（部分失败）' : '导入失败',
                  '成功 ' + ok + '，失败 ' + failed.length + '（' + summary + '）。\n' +
                  '失败行已放回文本框，改后可重试。',
                  ok ? 'warn' : 'error');
          } else {
            toast('导入完成', '成功 ' + ok + ' 首 → ' + plName, 'success');
          }
          if (ok) dedupePlaylists(plName);
        });
      });
    }).catch(function (e) {
      setStatus('导入失败：' + (e && e.message || e), 'err');
      toast('导入失败', String(e && e.message || e), 'error');
    }).then(function () {
      S.busy = false;
      S.impRun = false;
      updateToolbar();
      showImportRunning(false);
    });
  }

  function toggleImportPanel() {
    // 与「登录 / Cookie」完全同一套开关实现（K.togglePanel），手感统一
    K.togglePanel('qqmImportPanel');
  }

  /* 复制导出脚本：源码就是 js/qq-playlist-export.js 里定义的那个函数，
     toString() 取回源文本，补上定义 + 自动运行两行 —— 粘贴进 y.qq.com
     歌单页的控制台回车即跑（那边域名匹配、粘贴即执行） */
  function copyExportScript() {
    if (typeof window.qqPlaylistExport !== 'function') {
      toast('导出脚本未加载', '检查 index.html 里的 js/qq-playlist-export.js 引用', 'error');
      return;
    }
    var text = 'window.qqPlaylistExport = ' + window.qqPlaylistExport.toString() +
               ';\nwindow.qqPlaylistExport();';
    copyText(text, function (ok) {
      toast(ok ? '导出脚本已复制' : '复制失败',
            ok ? '去 y.qq.com 歌单页 → F12 → 控制台粘贴回车'
               : '请手动打开 js/qq-playlist-export.js 复制全文',
            ok ? 'success' : 'error');
    });
  }

  /* ------------------------------------------------------------
   * Cookie 设置（粘贴保存到 localStorage，一次粘贴长期有效，失效重贴）
   * ------------------------------------------------------------
   *   1) 浏览器打开 y.qq.com 并登录；
   *   2) F12 → 控制台(Console) → 运行面板里那条 copy(document.cookie) 命令
   *      （Cookie 自动进剪贴板）；
   *   3) 粘进 Cookie 面板保存。
   * 不填 Cookie 也能用：免费曲库（128K/AAC 96K）照常可播可下载。
   * ---------------------------------------------------------- */

  function copyCookieCommand() {
    var code = $('qqmCookieCmd');
    var cmd = code ? code.textContent : 'copy(document.cookie)';
    copyText(cmd, function (ok) {
      toast(ok ? '命令已复制' : '复制失败，请手动选中复制',
            '去 y.qq.com 页面的控制台里粘贴运行，Cookie 会自动进剪贴板',
            ok ? 'success' : 'error');
    });
  }

  function saveCookieFromPanel() {
    var ta = $('qqmCookieInput');
    if (!ta || !window.QQBridge) return;
    var ck = ta.value.trim();
    if (!ck) { toast('还没有输入 Cookie', '免费曲库不需要登录，直接搜索即可', 'error'); return; }
    QQBridge.setCookie(ck);
    reconnect();
    toast('Cookie 已保存', 'VIP 曲目 / 无损音质已按账号权限解析', 'success');
    showSetup(false);
  }

  function clearCookieFromPanel() {
    if (!window.QQBridge) return;
    QQBridge.clearCookie();
    var ta = $('qqmCookieInput');
    if (ta) ta.value = '';
    reconnect();
    toast('Cookie 已清除', '回到免登录模式（仅免费曲库）', 'success');
  }

  /* ------------------------------------------------------------
   * 事件绑定
   * ---------------------------------------------------------- */
  function bind() {
    if (!$('qqmList')) return;

    if ($('qqmInput')) {
      $('qqmInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') search();
      });
    }
    if ($('qqmSearchBtn')) $('qqmSearchBtn').addEventListener('click', search);
    if ($('qqmLoginBtn')) $('qqmLoginBtn').addEventListener('click', openCookiePanel);

    if ($('qqmImportBtn')) $('qqmImportBtn').addEventListener('click', toggleImportPanel);
    if ($('qqmImportStart')) $('qqmImportStart').addEventListener('click', startImport);
    if ($('qqmImportStop')) $('qqmImportStop').addEventListener('click', startImport);   // 运行中再点 = 停止
    if ($('qqmImportClose')) $('qqmImportClose').addEventListener('click', function () {
      var p = $('qqmImportPanel');
      if (p && !S.impRun) p.hidden = true;
    });
    if ($('qqmExportScriptCopy')) $('qqmExportScriptCopy').addEventListener('click', copyExportScript);

    /* Cookie 面板上的按钮 */
    if ($('qqmCookieSave')) $('qqmCookieSave').addEventListener('click', saveCookieFromPanel);
    if ($('qqmCookieClear')) $('qqmCookieClear').addEventListener('click', clearCookieFromPanel);
    if ($('qqmCookieCmdCopy')) $('qqmCookieCmdCopy').addEventListener('click', copyCookieCommand);

    /* 下载保存位置条 */
    if ($('qqmDlOpen')) $('qqmDlOpen').addEventListener('click', openDlFolder);
    if ($('qqmDlCopy')) $('qqmDlCopy').addEventListener('click', copyDlPath);

    if ($('qqmSetupRetry')) {
      $('qqmSetupRetry').addEventListener('click', function () {
        showSetup(false);
      });
    }

    if ($('qqmQuality')) {
      $('qqmQuality').addEventListener('change', function (e) {
        S.quality = e.target.value;
        if (window.QQBridge) QQBridge.setQuality(S.quality);
        setStatus('音质切换为 ' + (QUALITY_LABEL[S.quality] || S.quality), 'ok');
      });
    }

    if ($('qqmAll')) {
      $('qqmAll').addEventListener('change', function (e) {
        // 全选只作用于**当前这一页**。跨页已经勾好的保留着 ——
        // 否则翻几页回来点一下全选，前面选的就被无声清掉了。
        if (e.target.checked) {
          S.songs.forEach(function (s) { if (s.songmid) S.picked[s.songmid] = s; });
        } else {
          S.songs.forEach(function (s) { if (s.songmid) delete S.picked[s.songmid]; });
        }
        renderList();
        updateToolbar();
      });
    }

    if ($('qqmPlayBtn')) {
      $('qqmPlayBtn').addEventListener('click', function () {
        playTracks(pickedList());
      });
    }

    if ($('qqmDownloadBtn')) {
      $('qqmDownloadBtn').addEventListener('click', function () {
        downloadTracks(pickedList());
      });
    }

    var list = $('qqmList');
    if (list) {
      // 勾选框
      list.addEventListener('change', function (e) {
        var cb = e.target;
        if (cb && cb.type === 'checkbox') {
          var mid = cb.dataset.mid;
          if (cb.checked) {
            var s = songByMid(mid);
            if (s) S.picked[mid] = s;
          } else {
            delete S.picked[mid];
          }
          var row = cb.closest('.qqm-row');
          if (row) row.classList.toggle('sel', !!cb.checked);
          syncAllBox();
          updateToolbar();
        }
      });
      // 播放单曲 / 加载更多 / 整行点选
      list.addEventListener('click', function (e) {
        var more = e.target.closest('[data-act="more"]');
        if (more) {
          e.stopPropagation();
          loadMore();
          return;
        }
        var btn = e.target.closest('[data-act="one"]');
        if (btn) {
          e.stopPropagation();
          var s = songByMid(btn.dataset.mid);
          if (s) playTracks([s]);
          return;
        }
        var row = e.target.closest('.qqm-row');
        if (row && !e.target.closest('label')) {
          var cb = row.querySelector('input[type=checkbox]');
          if (cb) {
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
      // 双击整行直接播放
      list.addEventListener('dblclick', function (e) {
        if (e.target.closest('[data-act="one"]')) return;
        var row = e.target.closest('.qqm-row');
        if (row) {
          var s = songByMid(row.dataset.mid);
          if (s) playTracks([s]);
        }
      });
    }

    /* -------- 翻页条 -------- */
    if ($('qqmPrevBtn')) $('qqmPrevBtn').addEventListener('click', prevPage);
    if ($('qqmNextBtn')) $('qqmNextBtn').addEventListener('click', nextPage);
    if ($('qqmGoBtn')) $('qqmGoBtn').addEventListener('click', function () {
      gotoPage($('qqmPageInput').value);
    });
    if ($('qqmPageInput')) {
      $('qqmPageInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          gotoPage(this.value);
        }
      });
      // 只留数字，省得输进去一堆没用的字符
      $('qqmPageInput').addEventListener('input', function () {
        this.value = this.value.replace(/[^0-9]/g, '');
      });
    }
  }

  /* ------------------------------------------------------------
   * 样式（自包含，不进主题 CSS 文件，删掉本文件即可完全还原）
   * ---------------------------------------------------------- */


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

  // 钩住 switchTab：切到 qqmusic 时初始化（不改主题原有代码）
  if (typeof CM.switchTab === 'function') {
    var _switchTab = CM.switchTab;
    CM.switchTab = function (tab) {
      _switchTab.apply(CM, arguments);
      if (tab === 'qqmusic') onShow();
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  // 调试入口（在 foobar2000 的开发者工具 / 无头验证里可直接调；
  // window.QQBridge 上还有 bridgeInfo() 等诊断方法）
  CM.qqMusic = {
    state: S, reconnect: reconnect, search: search, loadMore: loadMore,
    gotoPage: gotoPage, prevPage: prevPage, nextPage: nextPage,
    playTracks: playTracks, downloadTracks: downloadTracks,
    startImport: startImport,
    downloadDir: downloadDir,
    PAGE_SIZE: PAGE_SIZE,
    showSetup: showSetup
  };
})();
