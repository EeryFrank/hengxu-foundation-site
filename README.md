# 恒序基金会 · HENGXU FOUNDATION（我的 OC 创作项目虚构网站）

> **本站是我的原创角色（OC）创作设定 · 虚构网站。**
> 恒序基金会、万界稳定局及站内所有数据、人物、组织、事件、联系方式均为虚构，
> 不代表任何真实机构，**不接受任何实际捐赠**。仅供创作交流与非商业演示。

---

## 一、这是什么

这是我的小说创作项目「万界稳定局」OC 宇宙的**设定道具网站**，我做了「表里双站」结构：

- **表页面（公开伪装层）**：虚构的「恒序基金会」官网——一家 1879 年创立、为各类灾害地区提供援助的非公募公益基金会。包含首页、关于我们（大事记时间线）、工作团队、公益项目（恒灯计划 / 拾光档案 / 韧性社区，均可点开详情）、信息公开（近五年年报摘要、捐赠去向查询演示）、基金会动态（报道全文）、加入我们等页面。支持**黑白主题切换**（默认米白）。
- **里页面（内网论坛）**：万界稳定局内部 BBS。直接访问 `bbs.html` 只会看到伪装 404 页；需从表页面页脚的「内部通道」登录进入，内含 5 个版块、1050+ 帖子（手写精品 + 固定种子确定性生成）、L1–L5 权限闸门、人格化自动回复等玩法。

## 二、用途

- 我的 OC 宇宙设定的可视化呈现与粉丝互动（解谜式入口 + 分级权限阅读）
- 小说世界观（组织、人物、异常体系）的沉浸式展示
- 纯前端静态站点的技术演示

**演示账号**（全部为虚构角色，初始口令不入库源码，想要的朋友直接找我要）：
`linwu`（林雾 · L3）、`shenyan`（沈砚 · L1）、`wenshi`（温拾 · L3）等 18 个内置账号。
管理员演示账号 `EeryFrank`（删除/置顶/账号后台管理）。
也可以在「加入我们」页页脚的「登记通道」自助注册新账号（L1 · 编外协作员）。

## 三、技术说明

- 纯静态 HTML/CSS/JS + Cloudflare Workers + D1 后端（见第六节）；无构建步骤
- 用户发帖、回复、账号增删、管理员操作存服务端 D1 数据库；BYOK 密钥仍只存在访客本机浏览器 localStorage
- 「AI 回复」我做成了**双轨制**，论坛 `[ AI 设置 ]` 里二选一：
  - **站方默认 AI（默认选中，无需任何 Key）**：我的 Worker 服务端用 DeepSeek 先「选人」（把帖子标题正文 + 20 人格的一句话简介发给它，挑出最合适的 0–2 个人格账号），再用各人格的完整 system prompt 生成回复并入库。每个账号每天 20 次站方额度，用完后当天自动切回本地人格模板引擎接管，用户无感知、不报错
  - **自带 API Key（BYOK）**：自愿填入自己的 Moonshot/Kimi Key，沿用原来的浏览器直调路径（密钥只存本机 localStorage，不写入任何文件）
- 人格池从 10 人扩到了 **20 人**：原有的 10 位都补完了设定（职务背景、说话方式、会回什么、不会做什么），新增 10 位原创职员覆盖不同部门、不同等级和互补性格（技术宅、老油条、毒舌、玄学爱好者、新人恐惧症患者……）；人格数据在服务端统一维护（`worker/src/personas.js`），前端启动时拉取，拉不到就用内置极简兜底，本地模板引擎永远可用
- 表页面多语言引擎已预留（`assets/i18n.js` 语言包缺席时语言按钮自动隐藏）

## 四、免责声明

1. 本站及关联仓库中的一切名称、人物、组织、数据、财务数字、新闻、档案、联系方式（地址/邮箱/电话/备案号）**均为虚构**，只为我的小说创作服务，与任何真实机构无关；如有雷同，纯属巧合。
2. 本站**不接受、不处理任何实际捐赠或付款**，所有「捐赠查询」「账号登录」均为演示性质。
3. 本站内容不构成任何真实的信息公开、募捐或求助渠道。
4. 本项目仅供学习交流，禁止将本站用于任何可能使他人误认为真实机构的用途。

## 五、仓库结构

```
index / about / team / programs / disclosure / news / join .html   表页面
project / article / report .html                                   详情模板页（?id= 数据驱动）
bbs.html                                                           里页面：内网论坛（伪装 404 闸门）
admin.html                                                         里页面：账号后台（仅管理员）
assets/
  style.css      表页面样式（含暗色主题变量）
  bbs.css        里页面终端样式
  bbs-data.js    版块/帖子数据（确定性生成器；账号已全部入库 D1）
  bbs.js         论坛逻辑（权限闸门/分页/发帖/人格回复引擎）
  auth.js        统一认证 API 客户端（登录/注册/会话恢复/账号管理）
  main.js        表页面公共逻辑（登录弹窗/详情渲染/捐赠查询）
  site-data.js   表页面内容数据（项目/动态/年报/大事记）
  hx-ui.js       主题切换 + 多语言引擎
worker/
  src/index.js   Workers API（认证/论坛/管理/注册/AI 人格回复）
  src/personas.js  AI 人格池唯一数据源（20 人，含 system prompt 与模板池）
  schema.sql     D1 表结构（含 ai_quota 站方 AI 每日配额表）
  wrangler.toml  部署配置
```

## 六、后端（Cloudflare Workers + D1）

论坛动态数据（账号、会话、用户帖、回复、置顶/删除覆盖层、登录锁定）我放在
**Cloudflare Workers + D1** 上，种子帖/生成帖仍留在前端确定性生成。

### 本地开发

```bash
# 1. 安装 worker 依赖（wrangler）
npm.cmd --prefix worker install        # Windows；macOS/Linux 用 npm --prefix worker install

# 2. 初始化本地 D1（miniflare SQLite 模拟，不需要 Cloudflare 账号）
npm.cmd --prefix worker run db:init:local

# 3. 起本地预览：静态站 + API 同端口（默认 http://localhost:8787）
npm run dev
```

### 部署到 Cloudflare

```bash
# 1. 登录并创建 D1 数据库，把返回的 database_id 填进 worker/wrangler.toml
cd worker
npx wrangler login
npx wrangler d1 create msb-bbs-db

# 2. 初始化远端表结构与种子数据（18 个内置账号 + 管理员 eeryfrank）
#    注意：seed.sql 含初始账号哈希，我有意不放进公开仓库，需要部署的朋友找我要
npx wrangler d1 execute msb-bbs-db --remote --file=schema.sql
npx wrangler d1 execute msb-bbs-db --remote --file=seed.sql

# 3. 部署 Worker（含静态资产托管）
npx wrangler deploy

# 4. 站方默认 AI 需要服务端密钥（不配置也能跑：站方 AI 返回 no-key，
#    前端自动改用本地人格模板引擎，用户无感知）
npx wrangler secret put DEEPSEEK_API_KEY
```

**Pages 关联 GitHub**（可选，静态站走 Pages、API 走 Worker 的分离部署）：
Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git，
选择本仓库，构建命令留空、输出目录填仓库根目录。随后把
`bbs.html` / `admin.html` / `index.html` 里 `<meta name="api-base" content="">`
的 content 改成 Worker 的 workers.dev 地址（API 已带 CORS 头，跨域可用）。
我的线上站直接用 `wrangler deploy` 的 [assets] 托管静态站，content 留空即可（同域）。

### 安全要点

- 密码一律 PBKDF2-SHA256 / 100,000 次迭代 / 固定盐（这是 Workers WebCrypto 的实际上限），库中只存 hex
- 会话 token 32 字节随机 hex，7 天过期，存 sessionStorage `msb_auth`（`{id, ts, token}`）
- 连续登录失败 5 次全局锁定 5 分钟（服务端判定，423 响应带回剩余秒数）
- 所有 SQL 绑定参数；管理接口二次校验 token 对应账号 `source='admin'`
- 注册接口按 IP 限流（每小时 5 个），防刷号
