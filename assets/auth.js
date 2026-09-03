/* ============================================================
   统一登录校验 AUTH（Wave 3 · Cloudflare Workers + D1 API 客户端）
   契约：backend-design.md §四.1
     - 对外仍暴露 window.AUTH，保持 login/currentUser/getAccount/listAccounts/
       addAccount/removeAccount/lockRemainSec 的签名与 Promise 行为兼容
     - 新增 init()（恢复会话：用 token 调 /api/me 换用户对象并缓存）、authHeader()
       与 register()（公开注册口 POST /api/register，不自动登录）
     - 口令哈希只在服务端计算与比对，本文件不含任何密码/哈希常量
     - 会话 msb_auth（sessionStorage）结构变为 {id, ts, token}
     - 登录锁定由服务端判定：423 响应带回 remain，lockRemainSec 读本地缓存的锁定截止时刻
     - 废弃 localStorage 键：msb_accounts_v1、msb_login_lock_v1（不再写入）
   ============================================================ */
(function(){
'use strict';

/* ---------------- API 基址 ----------------
   本地开发（wrangler dev）静态站与 API 同端口，留空 '' 即可。
   部署后若 Pages 与 Worker 分离，填 workers.dev 地址（如 https://msb-bbs.<sub>.workers.dev），
   或在 html 里加 <meta name="api-base" content="https://..."> / 设 window.API_BASE。 */
var API_BASE = '';
if(typeof window !== 'undefined' && window.API_BASE) API_BASE = window.API_BASE;
if(typeof document !== 'undefined'){
  var meta = document.querySelector('meta[name="api-base"]');
  if(meta && meta.content) API_BASE = meta.content;
}

/* ---------------- 会话与缓存 ---------------- */
var _me = null;          // currentUser() 同步读这份缓存；由 init()/login() 写入
var _token = null;
var _lockUntil = 0;      // 最近一次 423 响应带回的锁定截止时刻（epoch ms），供 lockRemainSec 倒计时

function readSession(){
  try{
    var raw = sessionStorage.getItem('msb_auth');
    if(!raw) return null;
    var s = JSON.parse(raw);
    if(!s || typeof s.id !== 'string' || typeof s.ts !== 'number' || typeof s.token !== 'string') return null;
    return s;
  }catch(e){ return null; }
}
function writeSession(id, token){
  try{ sessionStorage.setItem('msb_auth', JSON.stringify({ id:id, ts:Date.now(), token:token })); }catch(e){}
}
function clearSession(){
  try{ sessionStorage.removeItem('msb_auth'); }catch(e){}
  _me = null; _token = null;
}

/* ---------------- fetch 封装 ---------------- */
function apiFetch(path, opts){
  opts = opts || {};
  var headers = { 'Content-Type':'application/json' };
  var ah = authHeader();
  for(var k in ah) headers[k] = ah[k];
  return fetch(API_BASE + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  }).then(function(res){
    return res.json().catch(function(){ return {}; }).then(function(data){
      return { status:res.status, data:data };
    });
  });
}

function authHeader(){
  var t = _token || (readSession() || {}).token;
  return t ? { 'Authorization':'Bearer ' + t } : {};
}

/* ---------------- 会话恢复 ---------------- */
/* AUTH.init() → Promise<user|null>：有 token 则调 /api/me 换用户对象并缓存；无效会话就地清除 */
function init(){
  var s = readSession();
  if(!s){ _me = null; _token = null; return Promise.resolve(null); }
  _token = s.token;
  return apiFetch('/api/me').then(function(r){
    if(r.status === 200 && r.data && r.data.user){ _me = r.data.user; return _me; }
    clearSession();
    return null;
  }).catch(function(){
    /* 网络故障不清会话（下次刷新再试），但本次按未登录处理 */
    _me = null;
    return null;
  });
}

/* ---------------- 同步读取 ---------------- */
function currentUser(){ return _me; }

/* 兼容旧签名：只能返回已缓存的当前用户（账号表在服务端，无本地副本可查） */
function getAccount(id){
  if(!id || typeof id !== 'string') return null;
  if(_me && _me.id === id.toLowerCase()) return _me;
  return null;
}

/* ---------------- 登录 ---------------- */
/* AUTH.login(acc, pwd) → Promise<user>；失败 reject({locked?, remain?, message})，与旧版一致 */
function login(acc, pwd){
  acc = String(acc || '').trim().toLowerCase();
  pwd = String(pwd || '');
  var remain = lockRemainSec();
  if(remain > 0){
    return Promise.reject({ locked:true, remain:remain, message:'locked' });
  }
  return apiFetch('/api/login', { method:'POST', body:{ acc:acc, pwd:pwd } }).then(function(r){
    if(r.status === 200 && r.data && r.data.user && r.data.token){
      _me = r.data.user; _token = r.data.token;
      _lockUntil = 0;
      writeSession(r.data.user.id, r.data.token);
      return r.data.user;
    }
    if(r.status === 423 || (r.data && r.data.locked)){
      var sec = (r.data && typeof r.data.remain === 'number') ? r.data.remain : 300;
      _lockUntil = Date.now() + sec * 1000;
      throw { locked:true, remain:sec, message:'locked' };
    }
    throw { locked:false, message:(r.data && r.data.message) || 'bad-credentials' };
  }, function(){
    throw { locked:false, message:'network-error' };
  });
}

/* 锁定倒计时：读 423 响应缓存的截止时刻（msb_login_lock_v1 已废弃） */
function lockRemainSec(){
  var r = Math.ceil((_lockUntil - Date.now()) / 1000);
  return r > 0 ? r : 0;
}

/* ---------------- 登出 ---------------- */
function logout(){
  var p = apiFetch('/api/logout', { method:'POST' }).catch(function(){});
  clearSession();
  return p;
}

/* ---------------- 账号管理（管理员后台；服务端校验 admin token） ---------------- */
function listAccounts(){
  return apiFetch('/api/admin/accounts').then(function(r){
    if(r.status !== 200) throw new Error((r.data && r.data.error) || '账号列表获取失败');
    return r.data;
  });
}

function addAccount(id, fields){
  fields = fields || {};
  return apiFetch('/api/admin/accounts', { method:'POST', body:{
    id:String(id || '').trim(), name:fields.name, role:fields.role, level:fields.level, pass:fields.pass
  }}).then(function(r){
    if(r.status !== 200) throw new Error((r.data && r.data.error) || '添加失败');
    return r.data;
  });
}

function removeAccount(id){
  id = String(id || '').toLowerCase();
  return apiFetch('/api/admin/accounts/' + encodeURIComponent(id), { method:'DELETE' }).then(function(r){
    if(r.status !== 200) throw new Error((r.data && r.data.error) || '删除失败');
  });
}

/* ---------------- 公开注册（内部登记通道；不自动登录） ---------------- */
/* AUTH.register(id, name, pass) → Promise<user>；失败 reject(Error(服务端错误信息)) */
function register(id, name, pass){
  return apiFetch('/api/register', { method:'POST', body:{
    id:String(id || '').trim().toLowerCase(), name:String(name || '').trim(), pass:String(pass || '')
  }}).then(function(r){
    if(r.status === 200 && r.data && r.data.user) return r.data.user;
    throw new Error((r.data && r.data.error) || '登记失败，请稍后再试');
  }, function(){
    throw new Error('network-error');
  });
}

var AUTH = {
  login:login, logout:logout, init:init, register:register,
  currentUser:currentUser, getAccount:getAccount,
  listAccounts:listAccounts, addAccount:addAccount, removeAccount:removeAccount,
  lockRemainSec:lockRemainSec, authHeader:authHeader,
  API_BASE:API_BASE
};

if(typeof window !== 'undefined') window.AUTH = AUTH;
if(typeof module !== 'undefined' && module.exports) module.exports = AUTH;

})();

/* ============================================================
 * OC 免责声明：本文件为原创角色（OC）创作项目的虚构网站组成部分。
 * 恒序基金会、万界稳定局及站内所有数据、人物、组织、事件均为虚构，
 * 不代表任何真实机构，亦不接受任何实际捐赠。仅供创作交流与非商业演示。
 * ============================================================ */
