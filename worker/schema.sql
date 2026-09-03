-- 万界稳定局内网 BBS · D1 表结构（契约见 backend-design.md §二）

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,            -- 小写字母开头的登录名
  name TEXT NOT NULL,             -- 显示名（如 林雾）
  role TEXT NOT NULL,             -- 职务
  level TEXT NOT NULL,            -- L1..L5
  pass_hash TEXT NOT NULL,        -- PBKDF2-SHA256 hex（与前端同一盐/迭代参数）
  source TEXT NOT NULL DEFAULT 'added',  -- 'builtin' | 'admin' | 'added'
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,         -- 32 字节随机 hex
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL        -- 7 天
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,            -- 'u' + Date.now()，保持前端现有 id 规则
  board TEXT NOT NULL,
  title TEXT NOT NULL,
  author_id TEXT NOT NULL,        -- 登录账号 id
  author TEXT NOT NULL,           -- 显示名快照
  lv TEXT NOT NULL,
  time TEXT NOT NULL,             -- 'YYYY-MM-DD HH:mm'
  body TEXT NOT NULL,
  official INTEGER NOT NULL DEFAULT 0,  -- 管理员公告
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT NOT NULL,          -- 可是用户帖 u<ts>，也可是种子帖 n1/g_notice_3 等
  author TEXT NOT NULL,
  lv TEXT NOT NULL,
  time TEXT NOT NULL,
  body TEXT NOT NULL,
  ai INTEGER NOT NULL DEFAULT 0,  -- AI 人格回复
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replies_post ON replies(post_id);

-- 管理覆盖层：置顶/删除可作用于任意帖子（含种子帖），不改源数据
CREATE TABLE IF NOT EXISTS mods (
  post_id TEXT PRIMARY KEY,
  pinned INTEGER NOT NULL DEFAULT 0,   -- 1 置顶；取消置顶=删除该行或 pinned=0
  deleted INTEGER NOT NULL DEFAULT 0
);

-- 回复删除登记：key = '<post_id>#r<index>'，与前端现有定位规则一致
CREATE TABLE IF NOT EXISTS deleted_replies (
  key TEXT PRIMARY KEY
);

-- 登录失败锁定（全局单行，与现行行为一致）
CREATE TABLE IF NOT EXISTS login_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fails INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0
);

-- 注册防滥用：按 IP 记录登记请求，每 IP 每小时最多 5 个
CREATE TABLE IF NOT EXISTS register_guard (
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL     -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_register_guard_ip ON register_guard(ip, created_at);

-- 站方 AI 配额：每用户每天 20 次（day 为 UTC+8 日期串）
CREATE TABLE IF NOT EXISTS ai_quota (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
