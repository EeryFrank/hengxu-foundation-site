/* ============================================================
   里页面：万界稳定局内网 BBS —— 渲染层重写
   数据来源：assets/bbs-data.js 全局量 BOARDS / POSTS（账号与口令已全部入库，认证走 assets/auth.js → API）
   铁律：
     1. 渲染前清空容器（boardList / threadList / threadView / pager / crumb）
     2. 先校验再赋值：canAccess 通过前不取数据、不生成节点
   ============================================================ */
(function(){
'use strict';

/* ================= 身份与权限 ================= */
var LEVELS = ['L1','L2','L3','L4','L5'];   // L1<L2<L3<L4<L5
function lvRank(l){ return LEVELS.indexOf(l); }

/* 会话只存 {id, ts}，完整用户对象由 AUTH 按 id 重新查出（admin 派生，不信 session 字段）。
   AUTH 未加载完成前返回 null —— init 会等 auth.js 就绪后才进入身份闸门。 */
function currentUser(){
  if(typeof window !== 'undefined' && window.AUTH && window.AUTH.currentUser){
    return window.AUTH.currentUser();
  }
  return null;
}
/* auth.js 可能未被 html 引入（bbs.html 不归本文件管），动态注入加载 */
var _authReady = null;
function ensureAuth(){
  if(typeof window !== 'undefined' && window.AUTH) return Promise.resolve();
  if(_authReady) return _authReady;
  _authReady = new Promise(function(res, rej){
    var s = document.createElement('script');
    s.src = 'assets/auth.js';
    s.onload = function(){ res(); };
    s.onerror = function(){ rej(new Error('auth.js 加载失败')); };
    document.head.appendChild(s);
  });
  return _authReady;
}

/* 纯函数：先校验再取数。board 元信息（名称/锁定标记）可展示，帖子数据不行 */
function canAccess(board, user){
  if(!board) return false;
  if(!board.lock) return true;
  if(!user) return false;
  return lvRank(user.level) >= lvRank(board.lock);
}

/* ================= 状态与存储（Wave 3：localStorage → Workers + D1） =================
   msb_user_posts_v1 / msb_admin_mods_v1 两键废弃，不再写入。
   页加载时先 AUTH.init() 恢复会话，再 GET /api/forum 把全量动态数据拉进内存缓存；
   之后渲染全走内存缓存（与旧 localStorage 读法等价），写操作成功后同步更新缓存。 */
var PAGE_SIZE = 15;
var state = { board:'notice', thread:null, composerMode:null, pages:{}, user:null };
function resetState(){
  state.board = 'notice'; state.thread = null; state.composerMode = null;
  state.pages = {}; state.user = null;
}

/* 内存缓存：userPosts 按版块分组（仅 API 返回的用户帖）；replies 以 postId 为键（含种子帖回复） */
var _cache = { userPosts:{}, mods:null, replies:{}, ready:false };

function loadUserPosts(){ return _cache.userPosts; }
function saveUserPosts(d){ _cache.userPosts = d || {}; }

/* API 封装：带 token；非 2xx 抛 Error（err.status / err.data 可供分支处理） */
function apiFetch(path, opts){
  opts = opts || {};
  var headers = { 'Content-Type':'application/json' };
  if(typeof window !== 'undefined' && window.AUTH && window.AUTH.authHeader){
    var ah = window.AUTH.authHeader();
    for(var k in ah) headers[k] = ah[k];
  }
  var base = (typeof window !== 'undefined' && window.AUTH && window.AUTH.API_BASE) || '';
  return fetch(base + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  }).then(function(res){
    return res.json().catch(function(){ return {}; }).then(function(data){
      if(!res.ok){
        var err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
        err.status = res.status; err.data = data;
        throw err;
      }
      return data;
    });
  });
}

/* 启动时拉全量动态数据进缓存（state.user 须已就绪，用于计算 mine 标记） */
function loadForumData(){
  return apiFetch('/api/forum').then(function(d){
    var posts = {};
    var uid = state.user ? state.user.id : null;
    (d.threads || []).forEach(function(t){
      var th = { id:t.id, title:t.title, author:t.author, lv:t.lv, time:t.time, body:t.body,
                 official:!!t.official, mine:!!uid && t.author_id === uid, replies:[] };
      (posts[t.board] = posts[t.board] || []).push(th);
    });
    _cache.userPosts = posts;
    _cache.mods = normMods({
      deleted: d.mods && d.mods.deleted,
      delReplies: d.delReplies,
      pinned: d.mods && d.mods.pinned,
      unpinned: d.mods && d.mods.unpinned
    });
    _cache.replies = d.replies || {};
    _cache.ready = true;
  });
}

/* ================= 管理员删帖/置顶 overrides =================
   覆盖层由服务端 mods / deleted_replies 表承载；这里只读写内存缓存。
   回复无 id，用 postId#r<index> 定位（索引基于「帖内自带回复 + 服务端回复」的合并视图）。
   置顶：pinned 补置顶、unpinned 取消手写帖自带 pin。 */
function normMods(m){
  m = m || {};
  if(!Array.isArray(m.deleted)) m.deleted = [];
  if(!Array.isArray(m.delReplies)) m.delReplies = [];
  if(!Array.isArray(m.pinned)) m.pinned = [];
  if(!Array.isArray(m.unpinned)) m.unpinned = [];
  return m;
}
if(!_cache.mods) _cache.mods = normMods({});
function loadMods(){ return _cache.mods; }
function saveMods(m){ _cache.mods = normMods(m); }

function isAdmin(){ return !!(state.user && state.user.admin); }
/* 发帖权：先过访问闸门；ro 版块（公告）仅管理员可发 */
function canPost(b, u){ return !!(b && u && canAccess(b, u) && (!b.ro || u.admin === true)); }
function myAuthor(){ var u = state.user; return u ? u.name + ' · ' + u.role : ''; }

/* 有效置顶状态：overrides 优先于帖内 pin 字段 */
function effectivePin(t, mods){
  mods = mods || loadMods();
  if(mods.pinned.indexOf(t.id) >= 0) return true;
  if(mods.unpinned.indexOf(t.id) >= 0) return false;
  return !!t.pin;
}
/* 套用回复级 overrides：delReplies 过滤；
   回复 = 帖内自带回复（种子/生成帖）+ 服务端回复（_cache.replies[t.id]，用户帖自带为空数组故不重复）。
   每条回复带 _ridx（在合并数组中的索引，供 postId#r<index> 定位用）。返回新数组，不改源数据 */
function effectiveReplies(t, mods){
  mods = mods || loadMods();
  var out = [];
  var reps = (t.replies || []).concat(_cache.replies[t.id] || []);
  for(var i=0;i<reps.length;i++){
    var key = t.id + '#r' + i;
    if(mods.delReplies.indexOf(key) >= 0) continue;
    var r = reps[i];
    out.push({ author:r.author, lv:r.lv, time:r.time, body:r.body, ai:!!r.ai, _ridx:i });
  }
  return out;
}

function getBoard(boardId){
  for(var i=0;i<BOARDS.length;i++) if(BOARDS[i].id === boardId) return BOARDS[i];
  return null;
}
/* 用户帖 + 种子/生成帖（按 id 去重），运行时套用管理员 overrides（删除 + 置顶）。
   置顶通过浅拷贝覆盖 pin 字段套用，绝不改写源数据。仅在 canAccess 通过后才允许调用 */
function allThreads(boardId){
  var mods = loadMods();
  var deleted = {};
  mods.deleted.forEach(function(id){ deleted[id] = true; });
  function applyPin(t){
    var ep = effectivePin(t, mods);
    if(ep === !!t.pin) return t;
    var c = {};
    for(var k in t) c[k] = t[k];
    c.pin = ep;
    return c;
  }
  var user = (loadUserPosts()[boardId] || [])
    .filter(function(t){ return !deleted[t.id]; })
    .map(applyPin);
  var userIds = {};
  user.forEach(function(t){ userIds[t.id] = true; });
  var seed = (POSTS[boardId] || [])
    .filter(function(t){ return !userIds[t.id] && !deleted[t.id]; })
    .map(applyPin);
  return user.concat(seed);
}
/* pin 帖排在最前，其余按时间倒序 */
function sortThreads(arr){
  return arr.slice().sort(function(x,y){
    return ((y.pin?1:0)-(x.pin?1:0)) || String(y.time).localeCompare(String(x.time));
  });
}
function findThread(boardId, tid){
  var list = allThreads(boardId);
  for(var i=0;i<list.length;i++) if(list[i].id === tid) return list[i];
  return null;
}

/* ================= 分页（纯函数） ================= */
function paginate(list, page, per){
  var totalPages = Math.max(1, Math.ceil(list.length / per));
  var p = Math.min(Math.max(1, page|0), totalPages);
  return { items:list.slice((p-1)*per, p*per), page:p, totalPages:totalPages, total:list.length };
}

/* ================= DOM 引用（init 时缓存） ================= */
var bbsEl, page404El, bootEl, bootTextEl, bbsMainEl, whoLineEl, dRTickerEl,
    boardListEl, threadListEl, threadViewEl, pagerEl, crumbEl, composerEl,
    newThreadBtn, postTitleEl, postBodyEl, composerTitleEl;
function $(id){ return document.getElementById(id); }
function cacheEls(){
  bbsEl = $('bbs'); page404El = $('page404');
  bootEl = $('boot'); bootTextEl = $('bootText'); bbsMainEl = $('bbsMain');
  whoLineEl = $('whoLine'); dRTickerEl = $('dRTicker');
  boardListEl = $('boardList'); threadListEl = $('threadList');
  threadViewEl = $('threadView'); pagerEl = $('pager'); crumbEl = $('crumb');
  composerEl = $('composer'); newThreadBtn = $('newThreadBtn');
  postTitleEl = $('postTitle'); postBodyEl = $('postBody'); composerTitleEl = $('composerTitle');
}

/* 铁律1：渲染前清空容器 —— 所有动态容器一次性清场 */
function clearContainers(){
  boardListEl.innerHTML = '';
  threadListEl.innerHTML = '';
  threadViewEl.innerHTML = '';
  pagerEl.innerHTML = '';
  crumbEl.textContent = '';
}
function clearAll(){
  clearContainers();
  bootTextEl.innerHTML = '';
  threadViewEl.style.display = 'none';
  composerEl.style.display = 'none';
  newThreadBtn.style.display = 'none';
  whoLineEl.textContent = '—';
}

/* ================= 启动序列（逐字台本 + 打字机，msb_booted 只播一次） ================= */
var booted = false;
function enterBBS(){
  var u = currentUser();
  if(!u){ show404(); return; }
  state.user = u;
  whoLineEl.textContent = u.name + ' · ' + u.role + ' · 权限 ' + u.level;
  /* 管理员专属入口：[ 系统管理 ] → admin.html（只渲染给管理员） */
  var statusEl = document.querySelector('.bbs-status');
  if(u.admin && statusEl && !document.getElementById('adminBtn')){
    var ab = document.createElement('button');
    ab.className = 't-btn admin-entry-btn';
    ab.id = 'adminBtn';
    ab.textContent = '[ 系统管理 ]';
    ab.addEventListener('click', function(){ location.href = 'admin.html'; });
    statusEl.insertBefore(ab, $('logoutBtn'));
  }
  if(sessionStorage.getItem('msb_booted')){ showForum(); return; }
  if(booted){ showForum(); return; }
  booted = true;
  runBoot(u);
}
function runBoot(u){
  bbsMainEl.style.display = 'none';
  bootEl.style.display = '';
  bootTextEl.innerHTML = '';
  var lines = [
    ['> 建立加密链路 ………………………… 完成','ok'],
    ['> 认知防火墙 v4.2 校验中 ………… 通过','ok'],
    ['> 检测阅读者认知污染指数 ……… 0.03（安全）','ok'],
    ['> 身份核验：' + u.name + ' · ' + u.role,'ok'],
    ['> 权限等级：' + u.level + ' —— 超出权限的内容将不予渲染','warn'],
    ['> 正在接入 万界稳定局内部通讯网络 …','ok'],
    ['','ok'],
    ['  欢迎回来。','ok'],
    ['  请记住：你看到的一切，以你能承受为限。','warn']
  ];
  var li = 0;
  function nextLine(){
    if(li >= lines.length){
      setTimeout(function(){
        bootEl.style.display = 'none';
        sessionStorage.setItem('msb_booted','1');
        showForum();
      }, 900);
      return;
    }
    var pair = lines[li++], text = pair[0], cls = pair[1];
    var span = document.createElement('span');
    span.className = cls;
    bootTextEl.appendChild(span);
    var ci = 0;
    var iv = setInterval(function(){
      span.textContent = text.slice(0, ++ci);
      if(ci >= text.length){
        clearInterval(iv);
        bootTextEl.appendChild(document.createTextNode('\n'));
        setTimeout(nextLine, 160);
      }
    }, 14);
  }
  nextLine();
}

/* ================= ΔR ticker ================= */
var drIv = null;
function startTicker(){
  stopTicker();
  drIv = setInterval(function(){
    var v = (0.31 + (Math.random()-.5)*0.02).toFixed(3);
    var arrow = Math.random() > .45 ? '▲' : '▼';
    dRTickerEl.textContent = '全域 ΔR 均值 ' + v + ' ' + arrow + ' 缓升中';
  }, 2600);
}
function stopTicker(){ if(drIv !== null){ clearInterval(drIv); drIv = null; } }

function showForum(){
  bootEl.style.display = 'none';
  bbsMainEl.style.display = '';
  renderBoards();
  renderThreadList(state.board);
  startTicker();
}

/* ================= 渲染：版块列表 ================= */
function renderBoards(){
  boardListEl.innerHTML = '';   // 铁律1
  BOARDS.forEach(function(b){
    var locked = !!b.lock && !canAccess(b, state.user);   // 铁律2：只读元信息，不取帖子数据
    var div = document.createElement('div');
    div.className = 'board' + (state.board === b.id ? ' active' : '') + (locked ? ' locked' : '');
    var head = '<div class="board-head">' + b.name +
      (b.lock ? '<span class="lock-tag">[' + b.lock + ']</span>' : '');
    if(!locked) head += '<span class="cnt">' + allThreads(b.id).length + ' 帖</span>';  // 帖数（仅有权时统计）
    head += '</div>';
    div.innerHTML = head + '<div class="board-desc">' + (locked ? '权限不足，内容不予渲染。' : b.desc) + '</div>';
    div.addEventListener('click', function(){
      state.board = b.id; state.thread = null;
      state.pages[b.id] = 1;            // 切版块回到第 1 页
      renderBoards();
      if(locked){ showDenied(b); return; }   // 只在内容区提示，帖子内容永不进入 DOM
      renderThreadList(b.id);
    });
    boardListEl.appendChild(div);
  });
}

/* ================= 渲染：无权限提示（内容区） ================= */
function showDenied(b){
  state.thread = null;
  threadListEl.innerHTML = '';            // 铁律1
  threadViewEl.innerHTML = '';
  threadViewEl.style.display = 'none';
  pagerEl.innerHTML = '';
  composerEl.style.display = 'none';
  newThreadBtn.style.display = 'none';    // 无权限版块不渲染发帖按钮
  crumbEl.textContent = '> /' + b.id + ' — 访问被拒绝';
  threadListEl.style.display = '';
  var lv = state.user ? state.user.level : '—';
  threadListEl.innerHTML =
    '<div class="fw-block">⚠ 认知防火墙拦截 ⚠<br><br>权限不足，条目不予渲染。<br>' +
    '访问 [' + b.name + '] 需要 ' + b.lock + ' 及以上权限。<br>' +
    '你当前的权限为 ' + lv + '。<br><br>本次访问尝试已被记录。</div>';
}

/* ================= 渲染：帖子列表 + 分页 ================= */
function renderThreadList(boardId){
  var b = getBoard(boardId);
  // 铁律1：渲染前清空容器
  state.thread = null;
  threadListEl.innerHTML = '';
  threadViewEl.innerHTML = '';
  threadViewEl.style.display = 'none';
  pagerEl.innerHTML = '';
  composerEl.style.display = 'none';
  crumbEl.textContent = '';
  // 铁律2：先校验再取数据
  if(!b || !canAccess(b, state.user)){ if(b) showDenied(b); return; }

  threadListEl.style.display = '';
  crumbEl.textContent = '> /' + b.id + ' ' + b.name;
  newThreadBtn.style.display = canPost(b, state.user) ? '' : 'none';   // 无权限不渲染；管理员可破 ro

  var threads = sortThreads(allThreads(boardId));    // pin 帖排在最前
  if(!threads.length){
    threadListEl.innerHTML = '<div class="empty-tip">— 本版块暂无帖子，等你来发第一帖 —</div>';
    return;
  }
  var pg = paginate(threads, state.pages[boardId] || 1, PAGE_SIZE);
  state.pages[boardId] = pg.page;
  pg.items.forEach(function(t){
    var row = document.createElement('div');
    row.className = 'thread-row';
    var rc = effectiveReplies(t).length;
    row.innerHTML = '<div class="thread-title">' + (t.pin ? '<span class="pin">[置顶]</span>' : '') + t.title + '</div>' +
      '<div class="thread-count">回复 ' + rc + '</div>' +
      '<div class="thread-meta">' + t.author + ' · [' + t.lv + '] · ' + t.time + (t.mine ? ' · （我发的）' : '') + '</div>';
    row.addEventListener('click', function(){ openThread(boardId, t.id); });
    threadListEl.appendChild(row);
  });
  renderPager(b, pg);
}

/* 终端风分页条：[ 上一页 ] 1/3 [ 下一页 ] */
function renderPager(b, pg){
  pagerEl.innerHTML = '';                 // 铁律1
  if(pg.totalPages <= 1) return;
  var prev = document.createElement('span');
  prev.className = 'pg-btn' + (pg.page <= 1 ? ' off' : '');
  prev.textContent = '[ 上一页 ]';
  prev.addEventListener('click', function(){
    if(state.pages[b.id] > 1){ state.pages[b.id]--; renderThreadList(b.id); }
  });
  var info = document.createElement('span');
  info.textContent = pg.page + '/' + pg.totalPages;
  var next = document.createElement('span');
  next.className = 'pg-btn' + (pg.page >= pg.totalPages ? ' off' : '');
  next.textContent = '[ 下一页 ]';
  next.addEventListener('click', function(){
    if(state.pages[b.id] < pg.totalPages){ state.pages[b.id]++; renderThreadList(b.id); }
  });
  pagerEl.appendChild(prev);
  pagerEl.appendChild(info);
  pagerEl.appendChild(next);
}

/* ================= 渲染：帖子正文 ================= */
function postHTML(p){
  return '<div class="post">' +
    '<div class="post-head"><span>' + p.author + ' <span class="lv">[' + p.lv + ']</span></span><span>' + p.time + '</span></div>' +
    '<div class="post-body">' + p.body + '</div>' +
  '</div>';
}

/* 主题帖/回复的操作按钮（终端风小按钮）：
   - 自己发的主题帖（mine:true 且作者串匹配）：[ 删除 ]
   - 自己发的回复（非人格回复、作者串匹配）：[ 删除 ]
   - 管理员：主题帖 [ 置顶/取消置顶 ] + [ 删除 ]；回复 [ 删除 ]（管理员无编辑能力） */
function threadBtns(t){
  var html = '';
  var mine = t.mine && t.author === myAuthor();
  if(isAdmin()){
    html += '<button class="mini-btn" data-act="pin-t" data-tid="' + t.id + '">[ ' + (t.pin ? '取消置顶' : '置顶') + ' ]</button>';
    html += '<button class="mini-btn danger" data-act="del-t" data-tid="' + t.id + '">[ 删除 ]</button>';
  }else if(mine){
    html += '<button class="mini-btn danger" data-act="del-t" data-tid="' + t.id + '">[ 删除 ]</button>';
  }
  return html ? '<div class="post-ops">' + html + '</div>' : '';
}
function replyBtns(t, r){
  var html = '';
  var mine = !r.ai && r.author === myAuthor() && !isAdmin();
  if(isAdmin() || mine) html += '<button class="mini-btn danger" data-act="del-r" data-tid="' + t.id + '" data-r="' + r._ridx + '">[ 删除 ]</button>';
  return html ? '<div class="post-ops">' + html + '</div>' : '';
}

function openThread(boardId, tid, opts){
  opts = opts || {};
  var b = getBoard(boardId);
  if(!b || !canAccess(b, state.user)){ if(b) showDenied(b); return; }  // 铁律2：先校验
  var t = findThread(boardId, tid);
  if(!t) return;
  state.thread = tid;
  threadListEl.style.display = 'none';
  pagerEl.innerHTML = '';                 // 铁律1
  threadViewEl.innerHTML = '';
  composerEl.style.display = 'none';
  threadViewEl.style.display = '';
  crumbEl.textContent = '> /' + b.id + ' / 帖 #' + tid;
  var html = '<span class="back-link" id="backToList">&lt;&lt; 返回帖子列表</span>' +
    '<div class="thread-title-big">' + (t.pin ? '<span class="pin-tag">[置顶]</span> ' : '') + t.title + '</div>' +
    postHTML(t) + threadBtns(t);
  var reps = effectiveReplies(t);
  for(var i=0;i<reps.length;i++){
    var r = reps[i];
    html += postHTML(r) + replyBtns(t, r);
  }
  if(canPost(b, state.user)){
    html += '<div style="margin-top:8px"><button class="t-btn" id="replyBtn">[ 回复本帖 ]</button></div>';
  }
  threadViewEl.innerHTML = html;
  $('backToList').addEventListener('click', function(){ renderThreadList(boardId); });
  var rb = $('replyBtn');
  if(rb) rb.addEventListener('click', function(){ openComposer('reply'); });
  /* 操作按钮统一委托绑定 */
  var btns = threadViewEl.querySelectorAll('.mini-btn');
  for(var j=0;j<btns.length;j++){
    btns[j].addEventListener('click', onOpBtn);
  }
  if(opts.highlightLast){
    var posts = threadViewEl.querySelectorAll('.post');
    if(posts.length) posts[posts.length-1].classList.add('ai-new');
  }
  /* 人格回复兜底调度：打开发帖人自己 90 秒内的新帖时补触发一次。
     覆盖「发帖后刷新/重开页面导致 setTimeout 丢失」的场景；
     triggerPersonas 内部会按已有人格回复去重，落库前再校验，不会重复回复。 */
  if(t.mine && state.user && !state.user.admin && t.author === myAuthor()){
    var age = Date.now() - new Date(String(t.time).replace(' ','T')).getTime();
    if(age >= 0 && age < 90000){
      triggerPersonas(boardId, tid, String(t.title), String(t.body));
    }
  }
  if(!opts.noScroll) threadViewEl.scrollIntoView({behavior:'smooth', block:'start'});
}

/* 终端风确认弹窗（替代原生 confirm——原生弹窗会被自动化环境默认 dismiss，导致删除被静默中止） */
function termConfirm(msg, onOk){
  var old = document.querySelector('.term-confirm-mask');
  if(old) old.parentNode.removeChild(old);
  var mask = document.createElement('div');
  mask.className = 'term-confirm-mask';
  mask.innerHTML =
    '<div class="term-confirm">' +
      '<div class="tc-msg">' + msg + '</div>' +
      '<div class="tc-actions">' +
        '<button class="mini-btn danger" data-tc="ok">[ 确认删除 ]</button>' +
        '<button class="mini-btn" data-tc="no">[ 取消 ]</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(mask);
  function close(){ if(mask.parentNode) mask.parentNode.removeChild(mask); }
  mask.querySelector('[data-tc="ok"]').addEventListener('click', function(){ close(); onOk(); });
  mask.querySelector('[data-tc="no"]').addEventListener('click', close);
  mask.addEventListener('click', function(e){ if(e.target === mask) close(); });
}

/* 小按钮点击：删自己帖 / 管理员删除与置顶 */
function onOpBtn(e){
  var el = e.currentTarget;
  var act = el.getAttribute('data-act');
  var tid = el.getAttribute('data-tid');
  var ridx = el.getAttribute('data-r');
  var bid = state.board;
  if(act === 'del-t'){
    termConfirm('确认删除该主题帖？此操作不可撤销。', function(){ deleteThread(bid, tid); });
  }else if(act === 'del-r'){
    termConfirm('确认删除该回复？', function(){ deleteReply(bid, tid, parseInt(ridx,10)); });
  }else if(act === 'pin-t'){
    togglePin(bid, tid);
  }
}

/* 置顶/取消置顶（仅管理员）：POST /api/admin/pin，成功后更新缓存并清容器重渲染 */
function togglePinData(bid, tid){
  if(!isAdmin()) return Promise.resolve();
  var mods = loadMods();
  var t = findThread(bid, tid);
  if(!t) return Promise.resolve();
  var cur = effectivePin(t, mods);
  return apiFetch('/api/admin/pin', { method:'POST', body:{ postId:tid, pinned:!cur } }).then(function(){
    var m = loadMods();
    var pi = m.pinned.indexOf(tid), ui = m.unpinned.indexOf(tid);
    if(pi >= 0) m.pinned.splice(pi,1);
    if(ui >= 0) m.unpinned.splice(ui,1);
    if(cur){ m.unpinned.push(tid); } else { m.pinned.push(tid); }
  });
}
function togglePin(bid, tid){
  togglePinData(bid, tid).then(function(){
    state.thread = null;
    renderBoards();
    renderThreadList(bid);
  }).catch(function(e){ alert(e.message || '操作失败'); });
}

/* 删除主题帖：DELETE /api/threads/:id（服务端统一走 mods 覆盖层，不物理删除）。
   成功后更新缓存：用户帖移出 userPosts，同时登记 mods.deleted。 */
/* 数据层（不含渲染，node 可测；返回 Promise） */
function deleteThreadData(bid, tid){
  return apiFetch('/api/threads/' + encodeURIComponent(tid), { method:'DELETE' }).then(function(){
    var store = loadUserPosts();
    if(store[bid]){
      store[bid] = store[bid].filter(function(t){ return t.id !== tid; });
    }
    var mods = loadMods();
    if(mods.deleted.indexOf(tid) < 0) mods.deleted.push(tid);
  });
}
function deleteThread(bid, tid){
  /* 视图清理无论成败都执行：必须离开「正在查看中的已删帖」
     （铁律：清容器、state.thread 置空、回列表重渲染） */
  function cleanup(){
    state.thread = null;
    threadViewEl.innerHTML = '';
    threadViewEl.style.display = 'none';
    threadListEl.style.display = '';
    crumbEl.textContent = '';
    renderBoards();
    renderThreadList(bid);
  }
  deleteThreadData(bid, tid).then(cleanup, function(e){ cleanup(); alert(e.message || '删除失败'); });
}

/* 删除回复：DELETE /api/replies/<postId>#r<index>（URL 编码）。
   服务端统一写入 deleted_replies 登记；成功后把 key 登记进缓存 mods.delReplies，
   effectiveReplies 过滤后对种子/生成/用户帖统一生效。 */
/* 数据层（不含渲染，node 可测；返回 Promise） */
function deleteReplyData(bid, tid, ridx){
  var key = tid + '#r' + ridx;
  return apiFetch('/api/replies/' + encodeURIComponent(key), { method:'DELETE' }).then(function(){
    var mods = loadMods();
    if(mods.delReplies.indexOf(key) < 0) mods.delReplies.push(key);
  });
}
function deleteReply(bid, tid, ridx){
  deleteReplyData(bid, tid, ridx).then(function(){
    openThread(bid, tid, { noScroll:true });
  }).catch(function(e){ alert(e.message || '删除失败'); });
}

/* ================= 发帖 / 回帖 ================= */
function openComposer(mode){
  var b = getBoard(state.board);
  if(!canPost(b, state.user)) return;   // 铁律2：无权限不可发帖（管理员可破 ro）
  state.composerMode = mode;
  composerEl.style.display = '';
  composerTitleEl.textContent = mode === 'reply' ? '回复本帖' : (b.ro ? '发布公告' : '发布新帖');
  postTitleEl.style.display = mode === 'reply' ? 'none' : '';
  postTitleEl.value = ''; postBodyEl.value = '';
  /* 管理员在公告版（ro）发帖：提供官方署名输入 */
  var signEl = $('postSign');
  if(mode === 'new' && b.ro && state.user.admin === true){
    if(!signEl){
      signEl = document.createElement('input');
      signEl.type = 'text'; signEl.id = 'postSign'; signEl.maxLength = 30;
      signEl.placeholder = '署名（默认：中央总署 · 总务）';
      postTitleEl.parentNode.insertBefore(signEl, postTitleEl.nextSibling);
    }
    signEl.style.display = ''; signEl.value = '';
  }else if(signEl){ signEl.style.display = 'none'; }
  composerEl.scrollIntoView({behavior:'smooth', block:'center'});
  postBodyEl.focus();
}

function nowStr(){
  var d = new Date(), p = function(n){ return String(n).padStart(2,'0'); };
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 写入一条回复（用户回复与人格回复共用）：POST /api/threads/:id/replies。
   ai:true 的人格回复带 author/lv 覆盖（服务端仅 ai 时允许覆盖）；成功后更新缓存。返回 Promise */
function appendReplyToStore(bid, tid, reply){
  var body = { body: reply.body };
  if(reply.ai){ body.ai = true; body.author = reply.author; body.lv = reply.lv; }
  if(reply.time) body.time = reply.time;
  return apiFetch('/api/threads/' + encodeURIComponent(tid) + '/replies', { method:'POST', body:body })
    .then(function(saved){
      var r = { author:saved.author, lv:saved.lv, time:saved.time, body:saved.body, ai:!!saved.ai };
      (_cache.replies[tid] = _cache.replies[tid] || []).push(r);
      return r;
    });
}

var _submitting = false;
function submitPost(){
  if(_submitting) return;
  var u = state.user;
  var b = getBoard(state.board);
  if(!canPost(b, u)) return;   // 铁律2（管理员可破 ro）
  var body = postBodyEl.value.trim();
  if(!body){ postBodyEl.focus(); return; }
  var bid = state.board;
  var mode = state.composerMode;
  _submitting = true;
  function done(){ _submitting = false; }

  if(mode === 'new'){
    var title = postTitleEl.value.trim();
    if(!title){ done(); postTitleEl.focus(); return; }
    /* 管理员在公告版发帖：可用官方署名（默认 中央总署 · 总务），标记 official */
    var official = false, sign = '';
    if(b.ro && u.admin === true){
      var signEl = $('postSign');
      sign = signEl && signEl.value.trim();
      official = true;
    }
    var payload = { board:bid, title:title.replace(/</g,'&lt;'), body:body.replace(/</g,'&lt;') };
    if(official){ payload.official = true; payload.author = (sign || '中央总署 · 总务').replace(/</g,'&lt;'); }
    apiFetch('/api/threads', { method:'POST', body:payload }).then(function(t){
      /* 写操作成功后更新缓存（与旧 saveUserPosts 后渲染等价） */
      var store = loadUserPosts();
      store[bid] = store[bid] || [];
      store[bid].unshift({ id:t.id, mine:true, official:!!t.official, title:t.title,
        author:t.author, lv:t.lv, time:t.time, body:t.body, replies:[] });
      composerEl.style.display = 'none';
      state.pages[bid] = 1;                 // 新帖回第 1 页可见
      renderThreadList(bid);
      triggerPersonas(bid, t.id, title, body);
      done();
    }).catch(function(e){ done(); alert(e.message || '发帖失败'); });
  } else {
    var tid = state.thread;
    var reply = { author:u.name + ' · ' + u.role, lv:u.level, time:nowStr(), body:body.replace(/</g,'&lt;') };
    appendReplyToStore(bid, tid, reply).then(function(){
      composerEl.style.display = 'none';
      var t0 = findThread(bid, tid);
      openThread(bid, tid);
      triggerPersonas(bid, tid, t0 ? String(t0.title) : '', body);
      done();
    }).catch(function(e){ done(); alert(e.message || '回复失败'); });
  }
}

/* ================= 登出：停 ticker、清容器、重置 state、通知服务端吊销会话、回表站 ================= */
function logout(){
  stopTicker();
  clearAll();
  resetState();
  booted = false;
  _cache.userPosts = {}; _cache.mods = normMods({}); _cache.replies = {}; _cache.ready = false;
  if(typeof window !== 'undefined' && window.AUTH && window.AUTH.logout){
    window.AUTH.logout();   // POST /api/logout + 清 msb_auth（fire-and-forget）
  }else{
    sessionStorage.removeItem('msb_auth');
  }
  sessionStorage.removeItem('msb_booted');
  location.href = 'index.html';
}

/* ================= 入口：同步身份闸门 ================= */
function show404(){
  document.title = '404 · 恒序基金会';
  bbsEl.classList.remove('on');
  bbsMainEl.style.display = 'none';
  bootEl.style.display = 'none';
  page404El.classList.add('on');
}

/* ============================================================
   人格回复引擎 · 双轨 AI（站方默认 DeepSeek / BYOK 自带 Key）
   - 人格池唯一数据源在服务端 worker/src/personas.js（20 人），init 时 GET /api/personas 拉取；
     拉取失败保留下方极简内置兜底，保证 mockReply 本地模板引擎永远可用
   - 触发：非人格账号、非管理员用户发新帖或回复后；notice/vault 不触发
   - 站方默认（默认选中）：延迟 4–9 秒后 POST /api/threads/:id/ai-reply（服务端选人+生成+落库），
     配额用尽/未配 Key/生成失败 → 自动回退本地模板引擎（用户无感知）
   - BYOK（沿用 msb_ai_key）：本地关键词+概率选人，浏览器直调 Moonshot，失败回退 mock
   - 同一主题帖同一人格只回一次（服务端去重 + 本地合并视图去重双保险）
   ============================================================ */
var AI_PERSONAS_FALLBACK = [
  { id:'jiran', name:'纪燃', role:'规则干预官', lv:'L2', prob:0.5,
    triggers:['离谱','凭什么','后勤','配额','违规','吵'],
    sys:'你是万界稳定局内网论坛的纪燃，规则干预官，L2。性格火爆直率，恨流程癌也恨违规，说话带火气但有分寸。以内网论坛口吻回复，不超过150字，不泄露任何高危条目与编号，保持人设。',
    open:['看到这种帖子我火气就上来了。','我说句直话。'],
    line:[
      '规定是人写的，但违规是事教你的，别把两者搞混了。',
      '流程癌我第一个骂，但跳过流程的人我第一个抓，这两件事不矛盾。',
      '有火气冲我来，别冲规程，规程不疼了，疼的是你。'
    ] },
  { id:'anhuai', name:'安槐', role:'存在医师', lv:'L2', prob:0.7,
    triggers:['怕','睡不着','梦','累','撑不住','难受'],
    sys:'你是万界稳定局内网论坛的安槐，存在医师，L2。温柔安抚，关心睡眠与情绪，说话轻、慢、具体，会给出可执行的小建议。以内网论坛口吻回复，不超过150字，不泄露任何高危条目与编号，保持人设。',
    open:['看到了，先抱抱你。','先深呼吸，慢慢来。'],
    line:[
      '睡前把姓名、岗位、今天吃了什么写在纸上放枕边，老办法，管用。',
      '你已经做得很好了，这句话不收钱，也不用回。',
      '如果连续三晚睡不好，来找我，别自己扛到第四晚。'
    ] }
];
var AI_PERSONAS = AI_PERSONAS_FALLBACK.slice();
/* init 时拉取服务端 20 人格池（原地替换数组内容，保持导出引用有效）；失败保留极简兜底 */
function loadPersonas(){
  return apiFetch('/api/personas').then(function(d){
    if(d && Array.isArray(d.personas) && d.personas.length){
      AI_PERSONAS.length = 0;
      d.personas.forEach(function(p){ AI_PERSONAS.push(p); });
    }
  }).catch(function(){ /* 保留极简内置兜底 */ });
}
var AI_KEY_STORE = 'msb_ai_key';
var AI_MODE_STORE = 'msb_ai_mode';      // 'site'（默认，站方 AI）| 'byok'（自带 Key）
function getAiKey(){ try{ return localStorage.getItem(AI_KEY_STORE) || ''; }catch(e){ return ''; } }
function getAiMode(){ try{ return localStorage.getItem(AI_MODE_STORE) || 'site'; }catch(e){ return 'site'; } }

/* 纯逻辑：选人。命中触发词 + 各人格概率，至多 2 人；同帖已回复过的人格不再入选 */
function selectPersonas(user, boardId, text, existingReplies, rand){
  rand = rand || Math.random;
  if(!user || user.admin) return [];
  if(boardId === 'notice' || boardId === 'vault') return [];
  for(var i=0;i<AI_PERSONAS.length;i++) if(AI_PERSONAS[i].name === user.name) return [];
  var replied = {};
  (existingReplies || []).forEach(function(r){
    for(var j=0;j<AI_PERSONAS.length;j++) if(r.author === AI_PERSONAS[j].name + ' · ' + AI_PERSONAS[j].role) replied[AI_PERSONAS[j].id] = true;
  });
  var hit = [];
  for(var k=0;k<AI_PERSONAS.length;k++){
    var p = AI_PERSONAS[k];
    if(replied[p.id]) continue;
    var matched = false;
    for(var m=0;m<p.triggers.length;m++) if(text.indexOf(p.triggers[m]) >= 0){ matched = true; break; }
    if(matched && rand() < p.prob) hit.push(p);
  }
  for(var s=hit.length-1;s>0;s--){ var r = Math.floor(rand()*(s+1)), tmp = hit[s]; hit[s]=hit[r]; hit[r]=tmp; }
  return hit.slice(0,2);
}

/* Mock 组合：开场（50%）+ 1–2 条人格片段；terse 人格（商陆）只取一条，保证不超过两句 */
function mockReply(p, rand){
  rand = rand || Math.random;
  if(p.terse) return p.line[Math.floor(rand()*p.line.length)];
  var parts = [];
  if(p.open.length && rand() < 0.5) parts.push(p.open[Math.floor(rand()*p.open.length)]);
  var li1 = Math.floor(rand()*p.line.length);
  parts.push(p.line[li1]);
  if(rand() < 0.45){
    var li2 = Math.floor(rand()*(p.line.length-1));
    if(li2 >= li1) li2++;
    parts.push(p.line[li2]);
  }
  return parts.join('');
}

/* BYOK：调用 Moonshot/Kimi，10s 超时，失败回退 null（调用方走 mock） */
function callMoonshot(apiKey, persona, title, body, cb){
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = setTimeout(function(){ if(ctrl) ctrl.abort(); }, 10000);
  var userPrompt = '帖子标题：' + title + '\n帖子内容：' + String(body).slice(0, 600) + '\n请以人设写一条回复，不超过150字。';
  fetch('https://api.moonshot.cn/v1/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + apiKey },
    body: JSON.stringify({
      model:'moonshot-v1-8k',
      messages:[ { role:'system', content:persona.sys }, { role:'user', content:userPrompt } ],
      temperature:0.8, max_tokens:220
    }),
    signal: ctrl ? ctrl.signal : undefined
  }).then(function(res){
    if(!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).then(function(data){
    clearTimeout(timer);
    var txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    txt = typeof txt === 'string' ? txt.trim() : '';
    cb(txt || null);
  }).catch(function(){ clearTimeout(timer); cb(null); });
}

/* 触发入口：发帖/回帖成功后调用（submitPost 内）。
   双轨分流：BYOK（msb_ai_mode=byok 且已填 Key）走本地选人 + Moonshot；
   站方默认（默认）延迟 4–9 秒后调服务端 /ai-reply（选人+生成+落库一体）。
   去重依据用 effectiveReplies（含服务端回复合并视图），刷新后也不会重复触发。 */
function triggerPersonas(bid, tid, title, body){
  var u = state.user;
  if(getAiMode() === 'byok' && getAiKey()){
    var t = findThread(bid, tid);
    var chosen = selectPersonas(u, bid, String(title) + '\n' + String(body), t ? effectiveReplies(t) : [], Math.random);
    for(var i=0;i<chosen.length;i++){
      schedulePersona(chosen[i], bid, tid, String(title), String(body), 4000 + Math.random()*4200 + i*700);
    }
  }else{
    setTimeout(function(){ siteAiReply(bid, tid, String(title), String(body)); }, 4000 + Math.random()*4200);
  }
}

/* 站方默认 AI：到点后调服务端选人+生成。replies 已落库，回包同步进缓存并高亮重渲染；
   配额用尽 / 未配 Key / 选人失败 / 网络异常 → 回退本地模板引擎（用户无感知、不报错）；
   服务端明确「无人适合回复」（none-picked）时尊重该结果，不兜底。 */
function siteAiReply(bid, tid, title, body){
  if(!state.user) return;                       // 已登出
  var t = findThread(bid, tid);
  if(!t){                                       // 帖子已被删
    if(state.thread === tid){                   // 且用户正停在该帖视图：清视图回列表（铁律）
      state.thread = null;
      threadViewEl.innerHTML = '';
      threadViewEl.style.display = 'none';
      threadListEl.style.display = '';
      crumbEl.textContent = '';
      renderThreadList(bid);
    }
    return;
  }
  apiFetch('/api/threads/' + encodeURIComponent(tid) + '/ai-reply', { method:'POST', body:{ title:title, body:body } })
    .then(function(d){
      var reps = d && Array.isArray(d.replies) ? d.replies : [];
      if(reps.length){
        var arr = (_cache.replies[tid] = _cache.replies[tid] || []);
        reps.forEach(function(r){
          for(var i=0;i<arr.length;i++) if(arr[i].author === r.author) return;   // 合并视图已含则跳过
          arr.push({ author:r.author, lv:r.lv, time:r.time, body:r.body, ai:true });
        });
        if(state.user && state.board === bid && state.thread === tid){
          openThread(bid, tid, { highlightLast:true, noScroll:true });
        }
      }else if(!d || d.reason !== 'none-picked'){
        mockFallback(bid, tid, title, body);
      }
    })
    .catch(function(){ mockFallback(bid, tid, title, body); });
}

/* 本地模板引擎兜底：关键词+概率选人 + mockReply 组合，走普通回复接口落库（ai:true） */
function mockFallback(bid, tid, title, body){
  if(!state.user) return;
  var t = findThread(bid, tid);
  if(!t) return;
  var chosen = selectPersonas(state.user, bid, String(title) + '\n' + String(body), effectiveReplies(t), Math.random);
  chosen.forEach(function(p){
    var author = p.name + ' · ' + p.role;
    var text = mockReply(p, Math.random);
    appendReplyToStore(bid, tid, { author:author, lv:p.lv, time:nowStr(), body:String(text).replace(/</g,'&lt;'), ai:true })
      .then(function(){
        if(state.user && state.board === bid && state.thread === tid){
          openThread(bid, tid, { highlightLast:true, noScroll:true });
        }
      })
      .catch(function(){ /* 持久化失败：静默丢弃，不打扰阅读 */ });
  });
}

function schedulePersona(p, bid, tid, title, body, delay){
  setTimeout(function(){
    if(!state.user) return;                       // 已登出
    var t = findThread(bid, tid);
    if(!t){                                       // 帖子已被删
      if(state.thread === tid){                   // 且用户正停在该帖视图：清视图回列表（铁律）
        state.thread = null;
        threadViewEl.innerHTML = '';
        threadViewEl.style.display = 'none';
        threadListEl.style.display = '';
        crumbEl.textContent = '';
        renderThreadList(bid);
      }
      return;
    }
    var author = p.name + ' · ' + p.role;
    var reps = effectiveReplies(t);       // 合并视图（含服务端回复），同帖同人格只回一次
    for(var i=0;i<reps.length;i++) if(reps[i].author === author) return;
    var done = function(text){
      if(!text) text = mockReply(p, Math.random);
      /* 人格回复持久化：POST /api/threads/:id/replies（ai:true，带 author/lv 覆盖），成功后更新缓存 */
      appendReplyToStore(bid, tid, { author:author, lv:p.lv, time:nowStr(), body:String(text).replace(/</g,'&lt;'), ai:true })
        .then(function(){
          if(state.user && state.board === bid && state.thread === tid){
            openThread(bid, tid, { highlightLast:true, noScroll:true });
          }
        })
        .catch(function(){ /* 持久化失败：静默丢弃，不打扰阅读 */ });
    };
    var key = getAiKey();
    if(key) callMoonshot(key, p, title, body, done);
    else done(null);
  }, delay);
}

/* ================= AI 设置界面（bbs-head 动态注入 [ AI 设置 ] 按钮；双轨：站方默认 / BYOK） ================= */
function initAiSettings(){
  var statusEl = document.querySelector('.bbs-status');
  if(!statusEl || $('aiSettingsBtn')) return;
  var btn = document.createElement('button');
  btn.className = 't-btn ai-settings-btn';
  btn.id = 'aiSettingsBtn';
  btn.textContent = '[ AI 设置 ]';
  statusEl.insertBefore(btn, $('logoutBtn'));
  var mask = document.createElement('div');
  mask.className = 'ai-mask';
  mask.id = 'aiMask';
  mask.innerHTML =
    '<div class="ai-modal" id="aiModal">' +
      '<div class="ai-title">[ 人格回复引擎 · AI 设置 ]</div>' +
      '<div class="ai-desc">' +
        '<label class="ai-mode"><input type="radio" name="aiMode" id="aiModeSite"> <span class="ai-hl">站方默认 AI</span>（无需 Key）</label>' +
        '<div class="ai-mode-desc">由服务端 DeepSeek 选人并生成 20 人格回复；每天 20 次站方额度，用尽后当日自动切本地模板引擎，无感知。</div>' +
        '<label class="ai-mode"><input type="radio" name="aiMode" id="aiModeByok"> <span class="ai-hl">自带 API Key</span>（BYOK）</label>' +
        '<div class="ai-mode-desc">填入 Moonshot / Kimi Key 后，由你的浏览器直调 <span class="ai-hl">moonshot-v1-8k</span>；失败或超时（10s）自动回退模板引擎。</div>' +
      '</div>' +
      '<div class="ai-note">※ 密钥仅存本机浏览器 localStorage（msb_ai_key），不上传、不写入任何文件。</div>' +
      '<input type="password" id="aiKeyInput" autocomplete="off" placeholder="sk-...（仅 BYOK 模式使用；留空保存 = 清除密钥）">' +
      '<div class="ai-status" id="aiStatus"></div>' +
      '<div class="composer-actions">' +
        '<button class="t-btn primary" id="aiSave">[ 保存 ]</button>' +
        '<button class="t-btn" id="aiClear">[ 清除 ]</button>' +
        '<button class="t-btn" id="aiClose">[ 关闭 ]</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(mask);
  function refreshStatus(){
    var mode = getAiMode(), hasKey = !!getAiKey();
    $('aiModeSite').checked = (mode !== 'byok');
    $('aiModeByok').checked = (mode === 'byok');
    $('aiKeyInput').style.display = (mode === 'byok') ? '' : 'none';
    $('aiStatus').textContent = (mode === 'byok')
      ? (hasKey ? '当前模式：自带 Key（BYOK · 真 AI）' : '当前模式：自带 Key（未填 Key，将按站方默认走）')
      : '当前模式：站方默认 AI（服务端生成，无需 Key）';
  }
  $('aiModeSite').addEventListener('change', function(){
    try{ localStorage.setItem(AI_MODE_STORE, 'site'); }catch(e){}
    refreshStatus();
  });
  $('aiModeByok').addEventListener('change', function(){
    try{ localStorage.setItem(AI_MODE_STORE, 'byok'); }catch(e){}
    refreshStatus();
  });
  btn.addEventListener('click', function(){
    $('aiKeyInput').value = getAiKey();
    refreshStatus();
    mask.classList.add('on');
  });
  $('aiSave').addEventListener('click', function(){
    var k = $('aiKeyInput').value.trim();
    try{
      if(k) localStorage.setItem(AI_KEY_STORE, k);
      else localStorage.removeItem(AI_KEY_STORE);
    }catch(e){}
    refreshStatus();
    mask.classList.remove('on');
  });
  $('aiClear').addEventListener('click', function(){
    try{ localStorage.removeItem(AI_KEY_STORE); }catch(e){}
    $('aiKeyInput').value = '';
    refreshStatus();
  });
  $('aiClose').addEventListener('click', function(){ mask.classList.remove('on'); });
  mask.addEventListener('click', function(e){ if(e.target === mask) mask.classList.remove('on'); });
}

function init(){
  cacheEls();
  clearAll();                 // 不信赖任何残留 DOM，从头渲染
  $('logoutBtn').addEventListener('click', logout);
  initAiSettings();
  newThreadBtn.addEventListener('click', function(){ openComposer('new'); });
  $('postCancel').addEventListener('click', function(){ composerEl.style.display = 'none'; });
  $('postSubmit').addEventListener('click', submitPost);

  /* 身份闸门：等 auth.js 就绪 → AUTH.init() 用 token 调 /api/me 恢复会话 →
     GET /api/forum 拉全量动态数据进内存缓存，之后才允许进入论坛。
     未登录或数据拉取失败只显示伪装 404，任何帖子内容不得进入 DOM */
  ensureAuth().then(function(){
    return window.AUTH.init();
  }).then(function(u){
    if(!u){ show404(); return null; }
    state.user = u;                       // loadForumData 需要 user.id 计算 mine 标记
    loadPersonas();                       // 拉服务端 20 人格池（不等结果，失败走内置兜底）
    return loadForumData().then(function(){
      document.title = 'MSB-BBS';
      bbsEl.classList.add('on');
      enterBBS();
    });
  }).catch(function(){ show404(); });
}

if(typeof document !== 'undefined'){
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

/* 供 node 自测使用的纯逻辑导出（浏览器中无 module，不影响） */
if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    lvRank:lvRank, canAccess:canAccess, paginate:paginate, sortThreads:sortThreads,
    allThreads:allThreads, PAGE_SIZE:PAGE_SIZE,
    loadUserPosts:loadUserPosts, saveUserPosts:saveUserPosts,
    loadMods:loadMods, saveMods:saveMods,
    effectivePin:effectivePin, effectiveReplies:effectiveReplies,
    appendReplyToStore:appendReplyToStore,
    deleteThreadData:deleteThreadData, deleteReplyData:deleteReplyData, togglePinData:togglePinData,
    PERSONAS:AI_PERSONAS, AI_PERSONAS:AI_PERSONAS, selectPersonas:selectPersonas, mockReply:mockReply,
    triggerPersonas:triggerPersonas,
    _state:state, _resetState:resetState
  };
}

})();

/* ============================================================
 * OC 免责声明：本文件为原创角色（OC）创作项目的虚构网站组成部分。
 * 恒序基金会、万界稳定局及站内所有数据、人物、组织、事件均为虚构，
 * 不代表任何真实机构，亦不接受任何实际捐赠。仅供创作交流与非商业演示。
 * ============================================================ */
