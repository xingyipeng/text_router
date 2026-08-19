# wx_router — 微信校验文件管理与响应服务

**日期**：2026-08-19
**状态**：设计已确认，待实现

---

## 1. 目标

提供一个自托管的轻量服务，集中管理并响应所有微信平台的域名校验文件（`MP_verify_xxx.txt`、小程序业务域名校验文件等）。

具体要做到两件事：

1. **响应**：收到 `GET /{filename}.txt` 时，返回该校验文件的精确内容，供微信爬虫抓取。
2. **管理**：提供一个 Web 界面，让多人协作维护这些文件，并记录每条记录由谁创建、修改、删除。

## 2. 部署环境与约束

服务部署在**公司内部服务器**上，前面有公司统一网关。网关配置策略，将所有 `*.txt` 请求转发到本服务。

由此产生的约束：

- **本服务不关心网关的具体实现**。它只是一个普通 HTTP 服务：流量进来，匹配 `*.txt`，返回内容。
- **原始 Host 头是否保留未知**。网关可能保留、可能改写。设计必须对两种情况都成立（见 §5.2）。
- **出网能力未知**。内网服务器可能无法主动访问公网，这会影响自检功能的外部检查部分（见 §9）。
- **无外部身份提供方**。没有 SSO、没有 LDAP、没有 Cloudflare Access，身份必须由应用自己管理（见 §7）。

### 硬约束：公网可达性

微信的校验爬虫从公网发起请求。校验能否通过，前提是 `https://目标域名/{filename}.txt` 在公网可访问并返回正确内容。本服务只负责"流量到达之后"的部分；"流量能否到达"由公司网关的转发策略保证，不在本服务职责范围内。

## 3. 非目标

以下内容明确不做：

- **操作日志 / 历史版本回溯**。不记录每次增删改的完整轨迹，不支持恢复到旧版本内容。归属信息通过 `created_by` / `updated_by` / `deleted_by` 三个字段覆盖。
- **只读角色**。权限只有超级管理员和普通用户两级。
- **多租户 / 组织隔离**。
- **前端构建工具链**。管理界面用原生 HTML/CSS/JS，不引入 React/Vue/Vite。
- **自动向微信提交校验**。本服务只负责让文件可被抓取，提交动作仍在微信后台手动完成。

## 4. 技术栈与项目结构

### 4.1 技术选型

| 组件 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node.js 22 LTS | 由 Docker 镜像固定，不依赖宿主机 Node 版本 |
| HTTP 框架 | Hono | 自身零依赖，路由与中间件清晰 |
| 数据库 | SQLite（better-sqlite3） | 单文件、同步 API、无需独立数据库进程 |
| 密码哈希 | `node:crypto` 的 scrypt | 标准库已足够，不必再增加依赖面 |
| 前端 | 原生 HTML/CSS/JS | 无构建步骤，`docker build` 即全部产物 |
| 测试 | vitest | — |
| 部署 | Docker + docker compose | 不污染宿主机环境 |

生产依赖共两个：`hono`、`better-sqlite3`。

**关于 `node:sqlite`**：Node 内置的 `node:sqlite` 可以做到零原生依赖，但其 API 仍标记为实验性。本服务需要长期稳定运行，因此选择 API 稳定、有预编译二进制的 better-sqlite3，不为"零依赖"这一美学目标承担 API 变更风险。

### 4.2 目录结构

```
wx_router/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── src/
│   ├── server.js          # 启动入口，装配中间件与路由
│   ├── db.js              # SQLite 连接、建表、查询封装
│   ├── auth.js            # 登录、会话、权限中间件
│   ├── verify.js          # GET /{name}.txt 的匹配与响应
│   ├── validate.js        # 文件名 / host / 内容校验（纯函数）
│   ├── diagnostics.js     # 最近请求环形缓冲区
│   └── routes/
│       ├── files.js       # /api/files/*
│       ├── users.js       # /api/users/*
│       └── auth.js        # /api/auth/*
├── public/                # 管理界面静态文件
│   ├── index.html
│   ├── app.js
│   └── style.css
├── data/                  # SQLite 文件所在（Docker volume 挂载点）
└── test/
```

`validate.js` 刻意做成纯函数模块，不依赖数据库和请求对象，因为它承载的是安全关键逻辑（路径穿越防护），必须能被独立、密集地测试。

## 5. 数据模型

### 5.1 表结构

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,          -- scrypt: salt:hash（hex）
  display_name  TEXT    NOT NULL DEFAULT '',
  is_super      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  created_by    INTEGER,
  disabled_at   INTEGER                    -- NULL = 启用
);
CREATE UNIQUE INDEX idx_users_active
  ON users(username) WHERE disabled_at IS NULL;

CREATE TABLE sessions (
  token      TEXT    PRIMARY KEY,          -- 32 字节随机，hex
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE verify_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  host       TEXT    NOT NULL DEFAULT '',  -- '' = 全局，匹配任何 Host
  filename   TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  created_by INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER,
  deleted_at INTEGER,                      -- NULL = 未删除
  deleted_by INTEGER
);
CREATE UNIQUE INDEX idx_active_host_filename
  ON verify_files(host, filename) WHERE deleted_at IS NULL;
```

时间戳统一用 epoch 毫秒（INTEGER）。

**为什么唯一索引必须带 `WHERE deleted_at IS NULL`**：如果用普通的 `UNIQUE(host, filename)`，软删除一条记录后就再也无法添加同名文件——已删除的旧记录仍然占据唯一约束。而"删掉再加回来"恰恰是软删除最典型的使用场景。条件唯一索引让约束只作用于未删除的记录。

**为什么删除用户是软禁用**：`verify_files.created_by` 指向 `users.id`。硬删用户会让所有历史记录的归属变成悬空引用，"谁加的"这一信息随即丢失——而这正是引入用户管理的原始目的。软禁用后账号立即无法登录，历史归属完整保留。

### 5.2 Host 双模匹配

`host` 字段为空字符串时表示"全局记录"，匹配任何 Host。

Host 的取值顺序为：`X-Forwarded-Host` → `Host` → `''`。网关在转发时可能把 `Host` 改写成内部地址，同时用 `X-Forwarded-Host` 保留原始域名，因此必须优先读取后者。取到值后统一规范化：转小写、去端口、去尾部点。

匹配查询：

```sql
SELECT id, content FROM verify_files
WHERE filename = ?
  AND deleted_at IS NULL
  AND (host = ? OR host = '')
ORDER BY (host = '') ASC   -- 精确 host 优先，全局记录兜底
LIMIT 1;
```

这个设计让服务在两种网关行为下都能工作：网关保留域名时，可以按域名精确隔离；网关不保留时，用全局记录兜底。管理界面会显示服务实际收到的 Host（见 §10），因此上线后可以立即看到真实情况，再决定是否收紧为精确绑定。

## 6. 请求处理

### 6.1 路由分发

| 路径 | 处理 | 鉴权 |
|---|---|---|
| `GET /{name}.txt` | 查库返回校验文件 | **公开** |
| `/api/auth/*` | 登录、登出、当前用户 | 部分公开 |
| `/api/files/*` | 校验文件 CRUD、自检 | 需登录 |
| `/api/users/*` | 用户管理 | 需超级管理员 |
| `/api/diagnostics/*` | 诊断数据 | 需登录 |
| `/`、`/app.js`、`/style.css` | 管理界面静态文件 | 公开 |
| 其他 | 404 | — |

静态文件不做鉴权：HTML/CSS/JS 里不含任何数据或密钥，所有数据一律通过需鉴权的 `/api/*` 获取。页面加载后先调 `GET /api/auth/me`，拿到 401 就渲染登录表单。这样避免了"给静态资源加鉴权、又要为登录页开例外"的循环依赖。

### 6.2 校验文件响应

命中时：

```
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Cache-Control: no-store
X-Content-Type-Options: nosniff

<content 原样，不追加任何字符>
```

**为什么是 `no-store`**：如果中间任何一层（公司网关、CDN、浏览器）缓存住了一个 404 响应，那么在后台修好数据之后，微信那边仍会持续抓到 404。这类故障的表现是"数据库里明明是对的，线上就是不对"，排查代价极高。校验文件的访问频率极低（一个域名一生可能只被抓几次），缓存收益为零，而风险是实打实的。

未命中时：返回 404，`Content-Type: text/plain`，响应体为固定的简短说明。**不列出任何已有文件名**，避免通过 404 页面枚举出所有已配置的校验文件。

## 7. 认证与权限

### 7.1 权限模型

两级，没有第三级：

- **超级管理员**（`is_super = 1`）：管理用户 + 管理校验文件
- **普通用户**：仅管理校验文件

超级管理员**不可被删除、不可被降级**，包括他自己。这是为了杜绝"把自己锁在门外"这一不可恢复的状态。代价是超管密码丢失后需要人工介入（见 §14 救援步骤）。

### 7.2 超管初始化

容器首次启动时，若 `users` 表为空，则用环境变量 `SUPER_ADMIN_USER` 和 `SUPER_ADMIN_PASSWORD` 创建超级管理员。若表非空，这两个环境变量被忽略——避免重启时意外重置。

若表为空且环境变量缺失，服务拒绝启动并输出明确错误，而不是以无人可登录的状态运行。

### 7.3 会话

登录成功后生成 32 字节随机 token，存入 `sessions` 表，通过 Cookie 下发：

```
Set-Cookie: sid=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=<SESSION_TTL>
```

**为什么用服务端会话表而不是无状态 JWT**：需求要求能删除用户。JWT 一旦签发就无法撤回，删除用户后其手中的 token 仍然有效直到过期。会话存表则可以在禁用用户的同一个事务里删掉他的所有会话，**立即踢下线**。

`Secure` 标志由 `COOKIE_SECURE` 环境变量控制，默认关闭（内网可能是纯 HTTP），部署在 HTTPS 后面时应置为 `true`。

过期会话在每次会话查询时顺带惰性删除（`DELETE FROM sessions WHERE expires_at < ?`），不引入定时任务。这个表的规模是"用户数 × 活跃会话数"，量级极小，不需要专门的清理机制。

### 7.4 密码

使用 `crypto.scrypt`，每个密码独立 16 字节随机 salt，存储格式 `salt:hash`（均为 hex）。校验时用 `crypto.timingSafeEqual` 做常数时间比较。

密码最小长度 12 字符，在创建用户和修改密码时校验。

### 7.5 未认证响应

`/api/*` 在未登录时返回 **401 JSON**，而不是 302 重定向到登录页。重定向会让前端 `fetch` 拿到一个 HTML 页面并在 JSON 解析处报出无关的错误，掩盖真实原因。跳转由前端在收到 401 后自行处理。

## 8. API

### 认证

```
POST   /api/auth/login       {username, password}      → 200 + Set-Cookie / 401
POST   /api/auth/logout                                → 204
GET    /api/auth/me                                    → {id, username, display_name, is_super}
POST   /api/auth/password    {old_password, new_password} → 204
```

### 校验文件（需登录）

```
GET    /api/files?host=&q=&by=&include_deleted=
POST   /api/files            {host, filename, content, note}
PUT    /api/files/:id        {host, filename, content, note}
DELETE /api/files/:id                                  → 软删除
POST   /api/files/:id/restore
POST   /api/files/:id/check                            → 自检，见 §9
```

`GET /api/files` 支持按 `host` 过滤、按 `q` 搜索（匹配 filename 与 note）、按 `by` 过滤操作人（`created_by` 或 `updated_by` 任一命中即返回，因为"这条跟某人有关"通常比"是否由某人创建"更贴近实际查找意图）。`include_deleted=1` 时返回已删除记录，用于"回收站"视图。

响应中的 `created_by` / `updated_by` / `deleted_by` 会 JOIN `users` 表返回 `username` 和 `display_name`，前端无需二次查询。用户被禁用后其历史归属仍能正常显示。

### 用户（需超级管理员）

```
GET    /api/users?include_disabled=
POST   /api/users            {username, password, display_name}
DELETE /api/users/:id                                  → 软禁用 + 清除其会话
POST   /api/users/:id/restore                          → 重新启用
POST   /api/users/:id/password  {new_password}         → 超管重置他人密码
```

对超级管理员执行 `DELETE` 返回 403。

`restore` 是必须的：禁用是软操作，没有恢复入口的话，一次误禁用就变成了不可逆操作，只能进容器改数据库——这与软禁用的初衷相悖。恢复时若同名的启用账号已存在，返回 409。

### 诊断（需登录）

```
GET    /api/diagnostics/recent-requests
```

## 9. 自检

自检分两层，分别报告，因为它们的失败原因和修法完全不同。

**内部检查**（总是可执行）：记录存在且未删除、文件名合法、内容非空、且用 §5.2 的匹配逻辑能命中该记录。这一层验证"数据本身是对的"。

**外部检查**（尽力而为）：实际发起 `fetch('https://{host}/{filename}', { redirect: 'manual' })`，比对状态码、Content-Type 和内容是否逐字节相等。这一层验证"链路是通的"。

外部检查失败时不返回笼统的错误，而是分类：

| 结果码 | 含义 |
|---|---|
| `OK` | 状态码、Content-Type、内容全部匹配 |
| `EGRESS_BLOCKED` | 本机无法访问公网，外部检查不可用 |
| `DNS_OR_CONNECT_FAILED` | 域名解析失败或连接不通 |
| `REDIRECTED` | 收到 3xx，附跳转目标 |
| `STATUS_NOT_200` | 附实际状态码 |
| `CONTENT_TYPE_WRONG` | 附实际 Content-Type |
| `CONTENT_MISMATCH` | 并排显示期望与实际，可视化不可见字符 |

`EGRESS_BLOCKED` 时界面明确显示"内部检查已通过，外部检查因本机无法出网而不可用，请在能访问公网的机器上手动验证 URL"，**不把无法验证伪装成验证通过**。

`host` 为空（全局记录）时，外部检查无法确定要请求哪个域名，此时只做内部检查，并在界面上说明原因。

## 10. 诊断面板

内存中维护一个环形缓冲区，记录最近 200 次 `.txt` 请求：**接收到的 Host 头、`X-Forwarded-Host`、请求路径、是否命中、命中的记录 id、时间戳**。不落库、不占磁盘、进程重启即清空。

这个面板解决两个实际问题：

1. **回答"网关到底传不传原始域名"**。这是 §5.2 双模设计留下的未知数，面板上线后一眼可见，据此可以决定是否把记录收紧为精确 host 绑定。
2. **区分"请求没到"和"请求到了但没匹配上"**。微信校验失败时，这永远是第一个要回答的问题，而这两种情况的排查方向完全相反——前者要找网关，后者要查本服务的数据。

## 11. 输入校验与错误处理

### 文件名

正则：`/^[A-Za-z0-9_-]{1,80}\.txt$/`

这条正则同时挡掉 `/`、`\`、`..`、空字节和百分号编码残留，路径穿越从源头断绝。

**不能只允许 `MP_verify_` 前缀**：微信公众号 JS 安全域名的校验文件形如 `MP_verify_xxxxxxxx.txt`，而小程序业务域名的校验文件是无前缀的纯随机串 `xxxxxxxx.txt`。两者都必须支持。

### Host

规范化：转小写 → 去端口 → 去尾部点。写入和查询共用同一个规范化函数，保证两条路径的结果一致。

### 内容

**原样存储，绝不 trim**——微信要求逐字节精确匹配。

但界面会**检测并警告**三种情况，同时提供"一键清理"按钮，绝不自动修改：

- BOM（`\uFEFF`）
- CRLF 换行
- 首尾空白字符

内容长度上限 4 KB。真实的校验文件都是几十字节，超出这个量级必然是粘贴错了内容。

### 错误响应

| 情况 | 响应 |
|---|---|
| 未登录访问 `/api/*` | 401 JSON |
| 普通用户访问 `/api/users/*` | 403 JSON |
| 删除超级管理员 | 403 JSON |
| 文件名非法 | 400 JSON，附具体原因 |
| `(host, filename)` 已存在 | 409 JSON，提示"已存在，是否改为编辑" |
| 记录不存在 | 404 JSON |
| 数据库异常 | 500 JSON + 服务端日志（不向前端暴露 SQL） |

## 12. 微信平台的具体要求

实现时必须满足，测试需覆盖：

1. **Content-Type 必须是 `text/plain`**，编码 UTF-8。
2. **内容不能含 BOM**。
3. **必须返回 200，不能有重定向**。若链路上存在 HTTP→HTTPS 强制跳转，需为该路径配置例外。自检的外部检查用 `redirect: 'manual'` 专门捕获这种情况。
4. **内容逐字节精确匹配**。尾部换行是最高频的翻车点，界面显示字节数并可视化不可见字符。
5. **文件必须位于域名根路径**。这依赖公司网关的转发策略把 `/{name}.txt` 原样转发过来，不做路径重写。

## 13. 管理界面

单页，原生实现，不引框架。包含：

- **登录页**：用户名 + 密码。
- **文件列表**：表格显示 host、文件名、备注、创建人、最后修改人、修改时间。支持按 host 和操作人筛选、按文件名/备注搜索。自检结果**不持久化**——每行有一个自检按钮，点击后结果就地显示在该行，刷新页面即消失。存储自检状态会带来一个更糟的问题：一个几天前的"通过"标记会让人误以为现在也是通的，而链路随时可能因网关配置变更而断掉。
- **新增/编辑表单**：支持**拖拽导入**——把从微信后台下载的 `.txt` 文件拖进来，自动填充文件名和内容，避免手抄出错。
- **内容检查提示**：BOM / CRLF / 首尾空白的警告与一键清理。
- **自检按钮**：单条触发，就地显示分类结果。
- **回收站视图**：查看已软删除的记录及删除人，支持恢复。
- **用户管理页**（仅超管可见）：列表、创建、禁用、重置密码。
- **诊断面板**：最近 200 次 `.txt` 请求。

## 14. 部署

### 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `./data` | SQLite 文件目录 |
| `SUPER_ADMIN_USER` | — | 首次启动创建超管，之后忽略 |
| `SUPER_ADMIN_PASSWORD` | — | 同上 |
| `SESSION_TTL_HOURS` | `168` | 会话有效期（7 天） |
| `COOKIE_SECURE` | `false` | 部署在 HTTPS 后应设为 `true` |

### 启动

```bash
docker compose up -d
```

`docker-compose.yml` 把 `./data` 挂载为 volume，SQLite 文件持久化在宿主机上。

### 备份

**不要直接 `cp` 正在使用的 SQLite 文件**，可能拿到不一致的快照。正确做法：

```bash
docker compose exec wx_router \
  node -e "require('better-sqlite3')('/app/data/wx_router.db').backup('/app/data/backup.db')"
```

或用 SQL：`VACUUM INTO '/app/data/backup.db';`

### 超管密码丢失的救援

由于超管不可删除也不可降级，密码丢失后唯一的恢复路径是直接改数据库：

```bash
docker compose exec wx_router node scripts/reset-super-password.js <新密码>
```

实现时需提供这个脚本。它直接操作 SQLite 文件，重算 scrypt 哈希，不经过 HTTP 层。

## 15. 测试策略

用 vitest。数据库测试对临时文件建真实 SQLite 库，不做 mock——被测的正是 SQL 行为（尤其是条件唯一索引），mock 掉就失去意义。

必测清单：

**匹配逻辑**
1. Host 双模：精确 host 记录优先于全局记录命中
2. Host 双模：无精确匹配时全局记录兜底
3. `X-Forwarded-Host` 优先于 `Host`
4. Host 规范化：大小写、端口、尾部点

**软删除**
5. 软删除后 `.txt` 返回 404，记录仍在库中
6. 软删除后可添加同名文件（验证条件唯一索引）
7. restore 后 `.txt` 恢复正常返回

**安全**
8. 路径穿越：`/a/b.txt`、`/..%2Fetc%2Fpasswd.txt`、含空字节的文件名全部被拒
9. 未登录访问 `/api/files` → 401（而非 302）
10. 普通用户访问 `/api/users` → 403
11. 删除超级管理员 → 403
12. 禁用用户后，其既有会话立即失效
13. 密码校验：正确通过、错误拒绝、scrypt 格式正确

**用户管理**
14. 禁用用户后可通过 restore 重新启用，且能正常登录
15. restore 时若同名启用账号已存在 → 409
16. 用户被禁用后，其创建的文件记录仍能正确显示归属

**响应正确性**
17. 内容逐字节返回，覆盖尾部换行、Unicode、空白字符
18. 响应头包含 `text/plain; charset=utf-8`、`no-store`、`nosniff`
19. 404 响应不泄露已有文件名

**初始化**
20. 空库 + 缺失超管环境变量时，服务拒绝启动
21. 非空库时忽略超管环境变量，不重置已有账号

## 16. 已知取舍与风险

| 项 | 取舍 | 缓解 |
|---|---|---|
| 超管不可删除 | 杜绝自锁门外，代价是密码丢失需人工介入 | 提供 `reset-super-password.js` 脚本 |
| 诊断面板存内存 | 重启即丢，换来零存储成本 | 有意为之；需要长期留存则应上真正的日志系统 |
| 外部自检可能不可用 | 内网服务器可能无法出网 | 明确报 `EGRESS_BLOCKED`，不伪装成通过 |
| Host 双模兜底 | 比单一模式多一层理解成本 | 诊断面板暴露真实 Host，可据此收紧 |
| 不记录操作日志 | 无法回答"这条内容之前是什么" | 归属信息覆盖"谁做的"；软删除覆盖误删恢复 |
| 依赖网关转发 | 本服务无法自证公网可达 | 自检的外部检查 + 诊断面板共同定位断点 |
