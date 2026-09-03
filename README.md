# 恒序基金会 · HENGXU FOUNDATION（OC 创作项目虚构网站）

> **本站为原创角色（OC）创作设定 · 虚构网站。**
> 恒序基金会、万界稳定局及站内所有数据、人物、组织、事件、联系方式均为虚构，
> 不代表任何真实机构，**不接受任何实际捐赠**。仅供创作交流与非商业演示。

---

## 一、这是什么

这是小说创作项目「万界稳定局」OC 宇宙的**设定道具网站**，采用「表里双站」结构：

- **表页面（公开伪装层）**：虚构的「恒序基金会」官网——一家 1879 年创立、为各类灾害地区提供援助的非公募公益基金会。包含首页、关于我们（大事记时间线）、工作团队、公益项目（恒灯计划 / 拾光档案 / 韧性社区，均可点开详情）、信息公开（近五年年报摘要、捐赠去向查询演示）、基金会动态（报道全文）、加入我们等页面。支持**黑白主题切换**。
- **里页面（内网论坛）**：万界稳定局内部 BBS。直接访问 `bbs.html` 只会看到伪装 404 页；需从表页面页脚的「内部通道」登录进入，内含 5 个版块、1050+ 帖子（手写精品 + 固定种子确定性生成）、L1–L5 权限闸门、人格化自动回复等玩法。

## 二、用途

- OC 宇宙设定的可视化呈现与粉丝互动（解谜式入口 + 分级权限阅读）
- 小说世界观（组织、人物、异常体系）的沉浸式展示
- 纯前端静态站点的技术演示

**演示账号**（全部为虚构角色，初始口令已不入库源码，请向站长索取）：
`linwu`（林雾 · L3）、`shenyan`（沈砚 · L1）、`wenshi`（温拾 · L3）等 18 个内置账号。
管理员演示账号 `EeryFrank`（删除/置顶/账号后台管理）。
也可在「加入我们」页页脚的「登记通道」自助注册新账号（L1 · 编外协作员）。

## 三、技术说明

- 纯静态 HTML/CSS/JS + Cloudflare Workers + D1 后端（见第六节）；无构建步骤
- 用户发帖、回复、账号增删、管理员操作存服务端 D1 数据库；AI 密钥仍仅存访问者本机浏览器 localStorage
- 「AI 回复」默认为本地人格模板引擎；可在论坛 `[ AI 设置 ]` 中自愿填入自己的 Moonshot/Kimi API Key 切换为真实大模型回复（密钥仅存本机 localStorage，不写入任何文件）
- 表页面多语言引擎已预留（`assets/i18n.js` 语言包缺席时语言按钮自动隐藏）

## 四、免责声明

1. 本站及关联仓库中的一切名称、人物、组织、数据、财务数字、新闻、档案、联系方式（地址/邮箱/电话/备案号）**均为虚构**，仅为小说创作服务，与任何真实机构无关；如有雷同，纯属巧合。
2. 本站**不接受、不处理任何实际捐赠或付款**，所有「捐赠查询」「账号登录」均为演示性质的前端模拟。
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
```

## 六、后端（Cloudflare Workers + D1）

论坛动态数据（账号、会话、用户帖、回复、置顶/删除覆盖层、登录锁定）已迁移到
**Cloudflare Workers + D1**，种子帖/生成帖仍留在前端确定性生成。契约见
`backend-design.md`，前端现状分析见 `backend-migration-analysis.md`。

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
#    注意：seed.sql 含初始账号哈希，不随公开仓库发布，需向站长索取后放到 worker/ 下
npx wrangler d1 execute msb-bbs-db --remote --file=schema.sql
npx wrangler d1 execute msb-bbs-db --remote --file=seed.sql

# 3. 部署 Worker（含静态资产托管）
npx wrangler deploy
```

**Pages 关联 GitHub**（可选，静态站走 Pages、API 走 Worker 的分离部署）：
Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git，
选择本仓库，构建命令留空、输出目录填仓库根目录。随后把
`bbs.html` / `admin.html` / `index.html` 里 `<meta name="api-base" content="">`
的 content 改成 Worker 的 workers.dev 地址（API 已带 CORS 头，跨域可用）。
若直接用 `wrangler deploy` 的 [assets] 托管静态站，则保持 content 为空即可（同域）。

### 安全要点

- 密码一律 PBKDF2-SHA256 / 200,000 次 / 固定盐，库中只存 hex（`worker/scripts/hash.js` 可复算）
- 会话 token 32 字节随机 hex，7 天过期，存 sessionStorage `msb_auth`（`{id, ts, token}`）
- 连续登录失败 5 次全局锁定 5 分钟（服务端判定，423 响应带回剩余秒数）
- 所有 SQL 绑定参数；管理接口二次校验 token 对应账号 `source='admin'`

