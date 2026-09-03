/* ============================================================
   万界稳定局内网 BBS · Cloudflare Workers + D1 后端
   契约：backend-design.md §三（API 一览）/ §六（安全要点）
   - 原生 fetch handler，无第三方依赖
   - PBKDF2-SHA256 / 200,000 次 / 固定盐 'msb-bbs-auth-salt:v1'（Web Crypto）
   - token 32 字节随机 hex，7 天过期；所有 SQL 用绑定参数
   - 公开 API 一律带 CORS 头并处理 OPTIONS 预检
   ============================================================ */

import { AI_PERSONAS } from './personas.js';

/* ---------------- 常量 ---------------- */
var PBKDF2_ITER = 100000; /* Workers WebCrypto 上限 100,000 次，勿调高 */
var SALT = 'msb-bbs-auth-salt:v1';
var LOCK_THRESHOLD = 5;
var LOCK_MS = 5 * 60 * 1000;
var SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
var REG_LIMIT = 5;                    // 注册防滥用：每 IP 每小时最多 5 次登记请求
var REG_WINDOW_MS = 60 * 60 * 1000;

var LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'];
function lvRank(l) { return LEVELS.indexOf(l); }

/* ---------------- AI 人格回复（站方默认 AI · DeepSeek） ---------------- */
var AI_DAILY_LIMIT = 20;                 // 站方 AI 每用户每天额度（超限返回 quota-exceeded，前端回退模板引擎）
var DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions';
var DEEPSEEK_MODEL = 'deepseek-v4-flash';
var AI_TIMEOUT_MS = 30000;              /* 推理模型经边缘节点回源国内服务，15s 偏紧 */

/* UTC+8 当日日期串（与 nowStr 口径一致），ai_quota 的 day 键 */
function todayStr() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }

/* DeepSeek chat（OpenAI 兼容）。任何失败/超时/空结果 → null（调用方回退） */
async function deepseekChat(env, messages, maxTokens, temperature) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, AI_TIMEOUT_MS);
  try {
    var res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.DEEPSEEK_API_KEY },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL || DEEPSEEK_MODEL,
        messages: messages, max_tokens: maxTokens, temperature: temperature,
        thinking: { type: 'disabled' }   /* 人格选人与短回复不需要推理；reasoning 会吃光 max_tokens 导致 content 为空 */
      }),
      signal: ctrl.signal
    });
    if (!res.ok) return null;
    var data = await res.json();
    var txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return (typeof txt === 'string' && txt.trim()) ? txt.trim() : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

/* 版块定义（与 assets/bbs-data.js 的 BOARDS 一致；ro=只读仅管理员可发，lock=所需最低等级） */
var BOARDS = {
  notice: { ro: true,  lock: null },
  ops:    { ro: false, lock: null },
  theory: { ro: false, lock: null },
  lounge: { ro: false, lock: null },
  vault:  { ro: false, lock: 'L3' }
};
/* 种子帖/生成帖 id → 版块（种子帖首字母前缀；生成帖 g_<board>_<序号>） */
var SEED_PREFIX_BOARD = { n: 'notice', o: 'ops', t: 'theory', l: 'lounge', v: 'vault' };

/* ---------------- 基础工具 ---------------- */
function corsHeaders(extra) {
  var h = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}
function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}
function errResp(status, message) {
  var body = { error: message };
  if (status === 401) body.message = message;   // 兼容前端 bad-credentials 提示
  return json(body, status);
}
function nowIso() { return new Date().toISOString(); }
/* 'YYYY-MM-DD HH:mm'（UTC+8，与前端浏览器本地时间口径一致） */
function nowStr() {
  var d = new Date(Date.now() + 8 * 3600 * 1000);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}
function randomToken() {
  var b = new Uint8Array(32);
  crypto.getRandomValues(b);
  var out = '';
  for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return out;
}

/* PBKDF2-SHA256 → 64 字符小写 hex（参数与前端/seed 完全一致） */
async function pbkdf2Hex(pwd) {
  var enc = new TextEncoder();
  var key = await crypto.subtle.importKey('raw', enc.encode(String(pwd)), 'PBKDF2', false, ['deriveBits']);
  var bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: PBKDF2_ITER },
    key, 256);
  var b = new Uint8Array(bits), out = '';
  for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return out;
}

async function readBody(request) {
  try { return await request.json(); } catch (e) { return null; }
}

/* ---------------- 会话 ---------------- */
function bearerToken(request) {
  var h = request.headers.get('Authorization') || '';
  var m = /^Bearer\s+([0-9a-f]{64})$/i.exec(h);
  return m ? m[1].toLowerCase() : null;
}
/* → { account, token } 或 null。过期会话顺手删除。 */
async function getSession(env, request) {
  var token = bearerToken(request);
  if (!token) return null;
  var row = await env.DB.prepare(
    'SELECT s.token AS token, s.expires_at AS expires_at, a.id AS id, a.name AS name, a.role AS role, a.level AS level, a.source AS source, a.active AS active ' +
    'FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = ?'
  ).bind(token).first();
  if (!row || row.active !== 1) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return { token: row.token, account: { id: row.id, name: row.name, role: row.role, level: row.level, admin: row.source === 'admin' } };
}
async function requireUser(env, request) {
  var s = await getSession(env, request);
  if (!s) return { error: errResp(401, 'unauthorized') };
  return s;
}
async function requireAdmin(env, request) {
  var s = await requireUser(env, request);
  if (s.error) return s;
  /* 管理接口二次校验：token 对应账号 source='admin' */
  if (!s.account.admin) return { error: errResp(403, 'forbidden') };
  return s;
}

/* ---------------- 登录锁定（全局单行，与现行行为一致） ---------------- */
async function loadLock(env) {
  var row = await env.DB.prepare('SELECT fails, until FROM login_lock WHERE id = 1').first();
  return row || { fails: 0, until: 0 };
}
async function lockRemainMs(env) {
  var l = await loadLock(env);
  return Math.max(0, l.until - Date.now());
}

/* ---------------- 版块/帖子归属 ---------------- */
/* 由 postId 推版块：用户帖查 threads 表；种子帖看首字母；生成帖 g_<board>_* */
async function boardOfPost(env, postId) {
  var t = await env.DB.prepare('SELECT board FROM threads WHERE id = ?').bind(postId).first();
  if (t) return t.board;
  if (/^g_[a-z]+_/.test(postId)) return postId.split('_')[1];
  var b = SEED_PREFIX_BOARD[postId.charAt(0)];
  return b || null;
}
function userAuthorString(account) { return account.name + ' · ' + account.role; }

/* ---------------- 路由：认证 ---------------- */
async function handleLogin(env, request) {
  var body = await readBody(request);
  if (!body) return errResp(400, 'bad-request');
  var acc = String(body.acc || '').trim().toLowerCase();
  var pwd = String(body.pwd || '');

  var remain = await lockRemainMs(env);
  if (remain > 0) return json({ locked: true, remain: Math.ceil(remain / 1000) }, 423);

  var account = await env.DB.prepare(
    'SELECT id, name, role, level, pass_hash, source FROM accounts WHERE id = ? AND active = 1'
  ).bind(acc).first();

  var ok = false;
  if (account) ok = (await pbkdf2Hex(pwd)) === account.pass_hash;

  if (!ok) {
    var l = await loadLock(env);
    var fails = (l.fails || 0) + 1;
    var until = 0;
    if (fails >= LOCK_THRESHOLD) { until = Date.now() + LOCK_MS; fails = 0; }
    await env.DB.prepare('INSERT INTO login_lock (id, fails, until) VALUES (1, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET fails = excluded.fails, until = excluded.until').bind(fails, until).run();
    if (until > 0) return json({ locked: true, remain: Math.ceil((until - Date.now()) / 1000) }, 423);
    return errResp(401, 'bad-credentials');
  }

  /* 成功：清锁、签发 7 天会话 */
  await env.DB.prepare('UPDATE login_lock SET fails = 0, until = 0 WHERE id = 1').run();
  var token = randomToken();
  var now = nowIso();
  await env.DB.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, account.id, now, new Date(Date.now() + SESSION_TTL_MS).toISOString()).run();
  return json({
    user: { id: account.id, name: account.name, role: account.role, level: account.level, admin: account.source === 'admin' },
    token: token
  });
}

async function handleLogout(env, request) {
  var token = bearerToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return json({ ok: true });
}

async function handleMe(env, request) {
  var s = await getSession(env, request);
  if (!s) return errResp(401, 'unauthorized');
  return json({ user: s.account });
}

/* ---------------- 路由：公开注册（内部登记通道，不自动登录） ---------------- */
function clientIp(request) {
  var cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  var xff = (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim();
  return xff || 'local';
}
async function handleRegister(env, request) {
  var ip = clientIp(request);
  var nowMs = Date.now();
  /* 限流优先于一切校验（含失败请求也计数），超限一律 429 */
  var cnt = await env.DB.prepare('SELECT COUNT(*) AS c FROM register_guard WHERE ip = ? AND created_at > ?')
    .bind(ip, nowMs - REG_WINDOW_MS).first();
  if ((cnt ? cnt.c : 0) >= REG_LIMIT) return errResp(429, '登记过于频繁，请一小时后再试');
  await env.DB.prepare('INSERT INTO register_guard (ip, created_at) VALUES (?, ?)').bind(ip, nowMs).run();
  /* 顺手清理一天前的记录，表保持小 */
  await env.DB.prepare('DELETE FROM register_guard WHERE created_at < ?').bind(nowMs - 24 * 3600 * 1000).run();

  var body = await readBody(request);
  if (!body) return errResp(400, 'bad-request');
  var id = String(body.id || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,15}$/.test(id)) return errResp(400, '用户名须为小写字母开头的小写字母/数字/下划线（2–16 位）');
  var name = String(body.name || '').trim();
  if (!name || name.length > 20) return errResp(400, '显示名必填且不超过 20 字');
  var pass = String(body.pass || '');
  if (pass.length < 6) return errResp(400, '密码至少 6 位');

  /* 不得与现有账号重复（含已停用的 inactive 记录） */
  var exists = await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE id = ?').bind(id).first();
  if (exists) return errResp(409, '该用户名已存在');

  /* 公开注册固定 L1 / 编外协作员 / added；PBKDF2 入库参数与现有账号一致 */
  var hash = await pbkdf2Hex(pass);
  await env.DB.prepare(
    'INSERT INTO accounts (id, name, role, level, pass_hash, source, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
  ).bind(id, name, '编外协作员', 'L1', hash, 'added', nowIso()).run();
  return json({ user: { id: id, name: name, role: '编外协作员', level: 'L1', admin: false } });
}

/* ---------------- 路由：论坛数据 ---------------- */
async function handleGetForum(env) {
  var threadsRs = await env.DB.prepare(
    'SELECT t.id, t.board, t.title, t.author_id, t.author, t.lv, t.time, t.body, t.official FROM threads t ' +
    'WHERE t.id NOT IN (SELECT post_id FROM mods WHERE deleted = 1) ORDER BY t.created_at DESC'
  ).all();
  var modsRs = await env.DB.prepare('SELECT post_id, pinned, deleted FROM mods').all();
  var delRs = await env.DB.prepare('SELECT key FROM deleted_replies').all();
  var repliesRs = await env.DB.prepare(
    'SELECT id, post_id, author, lv, time, body, ai FROM replies ORDER BY id ASC'
  ).all();

  var mods = { deleted: [], pinned: [], unpinned: [] };
  (modsRs.results || []).forEach(function (m) {
    if (m.deleted === 1) mods.deleted.push(m.post_id);
    else if (m.pinned === 1) mods.pinned.push(m.post_id);
    else mods.unpinned.push(m.post_id);
  });
  var replies = {};
  (repliesRs.results || []).forEach(function (r) {
    (replies[r.post_id] = replies[r.post_id] || []).push({
      id: r.id, author: r.author, lv: r.lv, time: r.time, body: r.body, ai: r.ai === 1
    });
  });
  var threads = (threadsRs.results || []).map(function (t) {
    return {
      id: t.id, board: t.board, title: t.title, author_id: t.author_id, author: t.author,
      lv: t.lv, time: t.time, body: t.body, official: t.official === 1
    };
  });
  return json({
    threads: threads,
    mods: mods,
    delReplies: (delRs.results || []).map(function (r) { return r.key; }),
    replies: replies
  });
}

async function handleCreateThread(env, request) {
  var s = await requireUser(env, request);
  if (s.error) return s.error;
  var u = s.account;
  var body = await readBody(request);
  if (!body) return errResp(400, 'bad-request');
  var board = String(body.board || '');
  var b = BOARDS[board];
  if (!b) return errResp(400, 'unknown-board');
  /* 服务端校验（客户端闸门只是 UX，这里重做）：notice 仅 admin；vault 需 L3+ */
  if (b.ro && !u.admin) return errResp(403, 'forbidden');
  if (b.lock && lvRank(u.level) < lvRank(b.lock)) return errResp(403, 'forbidden');
  var official = body.official === true || body.official === 1;
  if (official && !u.admin) return errResp(403, 'forbidden');

  var title = String(body.title || '').trim();
  var text = String(body.body || '').trim();
  if (!title || !text) return errResp(400, 'title-and-body-required');
  if (title.length > 200 || text.length > 20000) return errResp(400, 'too-long');

  var author = userAuthorString(u);
  if (official && typeof body.author === 'string' && body.author.trim()) author = body.author.trim().slice(0, 60);

  var id = 'u' + Date.now();
  var time = nowStr();
  await env.DB.prepare(
    'INSERT INTO threads (id, board, title, author_id, author, lv, time, body, official, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, board, title, u.id, author, u.level, time, text, official ? 1 : 0, nowIso()).run();
  return json({ id: id, board: board, title: title, author_id: u.id, author: author, lv: u.level, time: time, body: text, official: official });
}

async function handleDeleteThread(env, request, id) {
  var s = await requireUser(env, request);
  if (s.error) return s.error;
  var u = s.account;
  var t = await env.DB.prepare('SELECT author_id FROM threads WHERE id = ?').bind(id).first();
  if (t) {
    if (t.author_id !== u.id && !u.admin) return errResp(403, 'forbidden');
  } else {
    /* 种子/生成帖：只有管理员可删（走覆盖层） */
    if (!u.admin) return errResp(403, 'forbidden');
  }
  /* 统一走 mods 覆盖层（deleted=1），不物理删除 */
  await env.DB.prepare('INSERT INTO mods (post_id, pinned, deleted) VALUES (?, 0, 1) ' +
    'ON CONFLICT(post_id) DO UPDATE SET deleted = 1').bind(id).run();
  return json({ ok: true });
}

async function handleCreateReply(env, request, postId) {
  var s = await requireUser(env, request);
  if (s.error) return s.error;
  var u = s.account;
  var boardId = await boardOfPost(env, postId);
  var b = boardId && BOARDS[boardId];
  if (!b) return errResp(404, 'unknown-post');
  /* 对锁定版块下的帖子仍需校验等级；ro 版块仅 admin 可回（与前端 canPost 一致） */
  if (b.ro && !u.admin) return errResp(403, 'forbidden');
  if (b.lock && lvRank(u.level) < lvRank(b.lock)) return errResp(403, 'forbidden');

  var body = await readBody(request);
  if (!body) return errResp(400, 'bad-request');
  var text = String(body.body || '').trim();
  if (!text) return errResp(400, 'body-required');
  if (text.length > 20000) return errResp(400, 'too-long');

  var ai = body.ai === true || body.ai === 1;
  var author = userAuthorString(u);
  var lv = u.level;
  if (ai) {
    /* 人格回复：允许覆盖 author/lv 为人格名（由前端人格引擎带正常用户 token 发出） */
    if (typeof body.author === 'string' && body.author.trim()) author = body.author.trim().slice(0, 60);
    if (LEVELS.indexOf(body.lv) >= 0) lv = body.lv;
  }
  var time = (typeof body.time === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(body.time)) ? body.time : nowStr();
  var rs = await env.DB.prepare(
    'INSERT INTO replies (post_id, author, lv, time, body, ai, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(postId, author, lv, time, text, ai ? 1 : 0, nowIso()).run();
  return json({ id: rs.meta.last_row_id, author: author, lv: lv, time: time, body: text, ai: ai });
}

async function handleDeleteReply(env, request, key) {
  var s = await requireUser(env, request);
  if (s.error) return s.error;
  var u = s.account;
  var m = /^(.+)#r(\d+)$/.exec(key);
  if (!m) return errResp(400, 'bad-key');
  var postId = m[1], idx = parseInt(m[2], 10);

  if (!u.admin) {
    /* 本人回复才允许删除：用户帖按索引直接定位（用户帖回复全部在 replies 表） */
    var isUserThread = await env.DB.prepare('SELECT 1 AS x FROM threads WHERE id = ?').bind(postId).first();
    var rows = await env.DB.prepare('SELECT author FROM replies WHERE post_id = ? ORDER BY id ASC').bind(postId).all();
    var list = rows.results || [];
    var mine = userAuthorString(u);
    if (isUserThread) {
      if (idx < 0 || idx >= list.length || list[idx].author !== mine) return errResp(403, 'forbidden');
    } else {
      /* 种子/生成帖：回复索引含前端种子自带回复的偏移量，服务端无法精确对位；
         收紧为「本人在该帖确有回复」即允许登记（前端只会对本人回复渲染删除按钮） */
      var hasMine = list.some(function (r) { return r.author === mine; });
      if (!hasMine) return errResp(403, 'forbidden');
    }
  }
  await env.DB.prepare('INSERT OR IGNORE INTO deleted_replies (key) VALUES (?)').bind(key).run();
  return json({ ok: true });
}

/* ---------------- 路由：AI 人格回复（站方默认 AI） ---------------- */
/* GET /api/personas —— 公开返回 20 人格池（含 sys，前端 BYOK 路径需要它拼 prompt） */
function handleGetPersonas() {
  return json({ personas: AI_PERSONAS });
}

/* POST /api/threads/:id/ai-reply —— 需登录。服务端选人 + 生成，回复直接入 replies 表。
   永不抛给前端错误态的约定：notice/vault 版、选人 0 人、生成失败 → {replies:[]}（前端回退本地模板引擎）；
   未配置 Key → {replies:[], reason:'no-key'}；当日额度用尽 → {replies:[], reason:'quota-exceeded'} */
async function handleAiReply(env, request, postId) {
  var s = await requireUser(env, request);
  if (s.error) return s.error;
  var u = s.account;

  /* 帖子存在且未删除（用户帖查 threads；种子/生成帖由 id 规则推版块）；mods.deleted 按不存在处理 */
  var boardId = await boardOfPost(env, postId);
  var b = boardId && BOARDS[boardId];
  if (!b) return errResp(404, 'unknown-post');
  var del = await env.DB.prepare('SELECT deleted FROM mods WHERE post_id = ?').bind(postId).first();
  if (del && del.deleted === 1) return errResp(404, 'unknown-post');
  /* 公告版 / 封存区不触发人格回复 */
  if (boardId === 'notice' || boardId === 'vault') return json({ replies: [] });

  if (!env.DEEPSEEK_API_KEY) return json({ replies: [], reason: 'no-key' });

  /* 配额：每用户每天 20 次（计数在决定真调模型时消耗一次，即便最终选人 0 人） */
  var day = todayStr();
  var q = await env.DB.prepare('SELECT count FROM ai_quota WHERE user_id = ? AND day = ?').bind(u.id, day).first();
  if (q && q.count >= AI_DAILY_LIMIT) return json({ replies: [], reason: 'quota-exceeded' });

  var body = await readBody(request);
  if (!body) return errResp(400, 'bad-request');
  var title = String(body.title || '').slice(0, 200);
  var text = String(body.body || '').slice(0, 2000);
  if (!title && !text) {
    /* 客户端未带正文时，用户帖可从 threads 表取标题正文兜底 */
    var t = await env.DB.prepare('SELECT title, body FROM threads WHERE id = ?').bind(postId).first();
    if (t) { title = t.title; text = t.body; }
  }

  /* 同帖同一人格只回一次：查该帖已有 AI 回复的作者串，从候选池剔除 */
  var existRs = await env.DB.prepare('SELECT author FROM replies WHERE post_id = ? AND ai = 1').bind(postId).all();
  var replied = {};
  (existRs.results || []).forEach(function (r) { replied[r.author] = true; });
  var candidates = AI_PERSONAS.filter(function (p) { return !replied[p.name + ' · ' + p.role]; });
  /* 人格账号本人发的帖，其对应人格不出场 */
  candidates = candidates.filter(function (p) { return p.name !== u.name; });
  if (!candidates.length) return json({ replies: [] });

  /* 消耗一次当日配额 */
  await env.DB.prepare('INSERT INTO ai_quota (user_id, day, count) VALUES (?, ?, 1) ' +
    'ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1').bind(u.id, day).run();

  /* ---- 选人：把标题正文 + 候选人格一句话简介发给 DeepSeek，只收 JSON {"pick":[id...]} ---- */
  var roster = candidates.map(function (p) {
    return '- ' + p.id + '｜' + p.name + '｜' + p.role + '｜' + p.lv + '｜' + p.tagline +
      (p.triggers && p.triggers.length ? '｜常接话题:' + p.triggers.join('/') : '');
  }).join('\n');
  var pickText = await deepseekChat(env, [
    { role: 'system', content: '你是万界稳定局内网论坛的「人格调度员」。下面是一份论坛帖子和一份人格候选名单。' +
      '这个论坛是内部闲聊与工作氛围，人格们都很乐于接话。请选出 1 到 2 个最适合回复此帖的人格：优先挑话题契合的（如设备故障找维保、食堂茶水间找话痨、情绪低落找医师）；' +
      '话题模糊时挑喜欢闲聊的人格。只有公告、纯系统内容或完全无人能接的帖子才选 0 人。' +
      '只输出 JSON，格式 {"pick":["id1","id2"]}，不要输出任何其他内容。id 必须来自名单。\n\n候选名单：\n' + roster },
    { role: 'user', content: '帖子标题：' + title + '\n帖子内容：' + text.slice(0, 600) }
  ], 800, 0.2);   /* deepseek-v4-flash 带 reasoning：max_tokens 需覆盖思考 token，否则 content 可能为空 */
  var picks = [];
  if (pickText) {
    try {
      var mj = /\{[\s\S]*\}/.exec(pickText);
      var parsed = mj && JSON.parse(mj[0]);
      var validIds = {};
      candidates.forEach(function (p) { validIds[p.id] = true; });
      if (parsed && Array.isArray(parsed.pick)) {
        parsed.pick.forEach(function (id) {
          if (validIds[id] && picks.indexOf(id) < 0 && picks.length < 2) picks.push(id);
        });
      } else if (typeof pickText === 'string') {
        /* 模型没按格式输出时不猜，按 0 人处理 */
      }
    } catch (e) { picks = []; }
  } else {
    /* 选人调用失败/超时：返回空并标记原因，前端回退本地模板引擎 */
    return json({ replies: [], reason: 'pick-failed' });
  }
  if (!picks.length) return json({ replies: [], reason: 'none-picked' });

  /* ---- 生成：每个被选中人格一次调用（system=人格 sys，user=标题+正文） ---- */
  var out = [];
  for (var i = 0; i < picks.length; i++) {
    var p = null;
    for (var j = 0; j < AI_PERSONAS.length; j++) if (AI_PERSONAS[j].id === picks[i]) { p = AI_PERSONAS[j]; break; }
    if (!p) continue;
    var replyText = await deepseekChat(env, [
      { role: 'system', content: p.sys },
      { role: 'user', content: '帖子标题：' + title + '\n帖子内容：' + text.slice(0, 600) + '\n请以人设写一条回复，不超过150字。' }
    ], 220, 0.8);
    if (!replyText) continue;   /* 单人失败不影响其他人 */
    var author = p.name + ' · ' + p.role;
    var time = nowStr();
    /* 落库前再查一次，防并发重复（同帖同人格只回一次） */
    var dup = await env.DB.prepare('SELECT 1 AS x FROM replies WHERE post_id = ? AND ai = 1 AND author = ?').bind(postId, author).first();
    if (dup) continue;
    var rs = await env.DB.prepare(
      'INSERT INTO replies (post_id, author, lv, time, body, ai, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).bind(postId, author, p.lv, time, replyText, nowIso()).run();
    out.push({ id: rs.meta.last_row_id, author: author, lv: p.lv, time: time, body: replyText, ai: true });
  }
  return json({ replies: out });
}

/* ---------------- 路由：管理 ---------------- */
async function handleAdminPin(env, request) {
  var s = await requireAdmin(env, request);
  if (s.error) return s.error;
  var body = await readBody(request);
  if (!body || typeof body.postId !== 'string' || !body.postId) return errResp(400, 'bad-request');
  var pinned = body.pinned === true || body.pinned === 1 ? 1 : 0;
  await env.DB.prepare('INSERT INTO mods (post_id, pinned, deleted) VALUES (?, ?, 0) ' +
    'ON CONFLICT(post_id) DO UPDATE SET pinned = excluded.pinned').bind(body.postId, pinned).run();
  return json({ ok: true });
}

var SOURCE_LABEL = { admin: '内置 · 管理员', builtin: '内置', added: '新增' };
async function handleAdminListAccounts(env, request) {
  var s = await requireAdmin(env, request);
  if (s.error) return s.error;
  var rs = await env.DB.prepare(
    'SELECT id, name, role, level, source FROM accounts WHERE active = 1 ORDER BY created_at ASC, id ASC'
  ).all();
  var out = (rs.results || []).map(function (a) {
    return {
      id: a.id, name: a.name, role: a.role, level: a.level,
      source: SOURCE_LABEL[a.source] || a.source,
      admin: a.source === 'admin'
    };
  });
  return json(out);
}

async function handleAdminAddAccount(env, request) {
  var s = await requireAdmin(env, request);
  if (s.error) return s.error;
  var body = await readBody(request);
  if (!body) return errResp(400, 'bad-request');
  var id = String(body.id || '').trim();
  /* 校验规则与现行一致 */
  if (!/^[a-z][a-z0-9_]{1,15}$/.test(id)) return errResp(400, '用户名须为小写字母开头的小写字母/数字/下划线（2–16 位）');
  if (!body.name || !body.role) return errResp(400, '姓名与职务必填');
  if (LEVELS.indexOf(body.level) < 0) return errResp(400, '权限等级须为 L1–L5');
  if (!body.pass || String(body.pass).length < 6) return errResp(400, '初始密码至少 6 位');
  var exists = await env.DB.prepare('SELECT active FROM accounts WHERE id = ?').bind(id).first();
  if (exists && exists.active === 1) return errResp(409, '该用户名已存在');
  var hash = await pbkdf2Hex(String(body.pass));
  if (exists) {
    /* 曾被删除（active=0）的同名账号：复活并覆盖资料 */
    await env.DB.prepare(
      'UPDATE accounts SET name = ?, role = ?, level = ?, pass_hash = ?, source = ?, active = 1 WHERE id = ?'
    ).bind(String(body.name), String(body.role), body.level, hash, 'added', id).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO accounts (id, name, role, level, pass_hash, source, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
    ).bind(id, String(body.name), String(body.role), body.level, hash, 'added', nowIso()).run();
  }
  return json({ id: id, name: String(body.name), role: String(body.role), level: body.level, source: '新增', admin: false });
}

async function handleAdminRemoveAccount(env, request, id) {
  var s = await requireAdmin(env, request);
  if (s.error) return s.error;
  if (id === s.account.id) return errResp(400, '禁止删除管理员账号');
  var row = await env.DB.prepare('SELECT source FROM accounts WHERE id = ? AND active = 1').bind(id).first();
  if (!row) return errResp(404, '账号不存在');
  if (row.source === 'admin') return errResp(400, '禁止删除管理员账号');
  /* 删除 = active=0（保留记录可审计）；同时吊销该账号全部会话 */
  await env.DB.prepare('UPDATE accounts SET active = 0 WHERE id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(id).run();
  return json({ ok: true });
}

/* ---------------- 入口 ---------------- */
export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;
    var method = request.method;

    /* CORS 预检 */
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    try {
      if (path === '/api/login' && method === 'POST') return await handleLogin(env, request);
      if (path === '/api/logout' && method === 'POST') return await handleLogout(env, request);
      if (path === '/api/me' && method === 'GET') return await handleMe(env, request);
      if (path === '/api/register' && method === 'POST') return await handleRegister(env, request);
      if (path === '/api/forum' && method === 'GET') return await handleGetForum(env);
      if (path === '/api/personas' && method === 'GET') return handleGetPersonas();
      if (path === '/api/threads' && method === 'POST') return await handleCreateThread(env, request);
      if (path === '/api/admin/pin' && method === 'POST') return await handleAdminPin(env, request);
      if (path === '/api/admin/accounts' && method === 'GET') return await handleAdminListAccounts(env, request);
      if (path === '/api/admin/accounts' && method === 'POST') return await handleAdminAddAccount(env, request);

      var m;
      if ((m = /^\/api\/threads\/([^/]+)$/.exec(path))) {
        var tid = decodeURIComponent(m[1]);
        if (method === 'DELETE') return await handleDeleteThread(env, request, tid);
      }
      if ((m = /^\/api\/threads\/([^/]+)\/replies$/.exec(path))) {
        if (method === 'POST') return await handleCreateReply(env, request, decodeURIComponent(m[1]));
      }
      if ((m = /^\/api\/threads\/([^/]+)\/ai-reply$/.exec(path))) {
        if (method === 'POST') return await handleAiReply(env, request, decodeURIComponent(m[1]));
      }
      if ((m = /^\/api\/replies\/(.+)$/.exec(path))) {
        if (method === 'DELETE') return await handleDeleteReply(env, request, decodeURIComponent(m[1]));
      }
      if ((m = /^\/api\/admin\/accounts\/([^/]+)$/.exec(path))) {
        if (method === 'DELETE') return await handleAdminRemoveAccount(env, request, decodeURIComponent(m[1]));
      }

      if (path.indexOf('/api/') === 0) return errResp(404, 'not-found');

      /* 非 API 路径：交给静态资产（[assets] 指向上级站点目录） */
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return errResp(404, 'not-found');
    } catch (e) {
      return errResp(500, 'internal-error');
    }
  }
};
