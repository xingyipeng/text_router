# wx_router

集中管理微信域名校验文件（`MP_verify_xxx.txt`、小程序业务域名校验文件等），并响应微信爬虫的抓取请求。

自托管、单进程、单个 SQLite 文件，无云依赖、无前端构建步骤。

## 快速开始

```bash
cp .env.example .env
# 编辑 .env，至少改掉 SUPER_ADMIN_PASSWORD
docker compose up -d
```

打开 `http://<服务器地址>:3000/`，用 `.env` 里的超管账号登录。

不用 Docker 也行：

```bash
npm install
SUPER_ADMIN_USER=admin SUPER_ADMIN_PASSWORD=your-password npm start
```

## Docker 跨平台构建

在 x86 机器上构建的镜像拿到 arm 机器上跑会失败（反之亦然）：`better-sqlite3` 是原生模块，与构建机架构绑死。用仓库里的构建脚本一次产出 `linux/amd64` + `linux/arm64` 双架构镜像：

```bash
# 前提：Docker 19.03+ 自带 buildx。Linux 主机首次跨架构构建前注册一次 QEMU 模拟器：
#   docker run --rm --privileged tonistiigi/binfmt --install all
# Docker Desktop（macOS/Windows）已内置，无需这步。

scripts/build-docker.sh --push -t registry.example.com/wx-router:1.0.0
```

服务器上 `docker pull` 后，把 compose 里的 `build: .` 换成 `image: registry.example.com/wx-router:1.0.0` 即可。脚本选项：`-t/--tag` 镜像名、`--platform` 目标平台（默认双架构）、`--push` 推送、`--load` 只构建本机架构载入本地（试跑用）、`--no-cache`。不加 `--push/--load` 则只做双架构构建验证。

Dockerfile 无需改动：依赖编译发生在镜像构建内部（`npm ci` 在目标平台的容器里执行），宿主机上的 `node_modules` 从不进入镜像。

**没有镜像仓库的内网**：按服务器架构单独导出 tar 包，拷过去 `docker load`：

```bash
# 服务器是 x86_64（arm64 就把平台换成 linux/arm64）：
docker buildx build --platform linux/amd64 -t wx-router:1.0.0 -o type=docker,dest=wx-router-amd64.tar .
# 服务器上：
docker load -i wx-router-amd64.tar
```

## 网关需要做什么

本服务只处理"流量到达之后"的部分。上游网关需要保证两件事：

1. **把 `/*.txt` 的请求转发到本服务的 3000 端口**，且**不重写路径**——微信要求校验文件位于域名根路径。
2. **保留原始域名**，通过 `Host` 或 `X-Forwarded-Host` 任一 header 传递。

第 2 点做不到也能用：把记录的"域名"字段留空，它就对所有域名生效。登录后进「请求记录」面板可以直接看到本服务实际收到的 Host 是什么，据此决定用哪种模式。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `./data` | SQLite 文件目录 |
| `SUPER_ADMIN_USER` | `admin` | 仅在数据库为空时用于创建超管 |
| `SUPER_ADMIN_PASSWORD` | `admin123` | 同上；至少 8 位 |
| `SESSION_TTL_HOURS` | `168` | 会话有效期（7 天） |
| `COOKIE_SECURE` | `false` | 部署在 HTTPS 后面时设为 `true` |

数据库非空时 `SUPER_ADMIN_*` 会被忽略，重启不会重置任何账号。数据库为空且未设置时，会用默认账号 `admin/admin123` 自动创建超管，并在启动日志打印警告——**默认密码是弱口令，首次登录后请立即修改**。密码至少 8 位。

## 使用要点

**添加校验文件**：从微信后台下载 `.txt` 文件后，直接**拖到新增对话框的虚线框里**，文件名和内容会自动填入，避免手抄出错。

**提交微信审核前先点「自检」。** 自检分两层：内部检查确认数据本身正确（记录存在、内容非空、当前匹配规则下真的会命中这一条）；外部检查实际发起一次 HTTPS 请求，验证链路是通的。外部检查失败时会明确区分：

| 结果 | 含义 |
|---|---|
| `OK` | 状态码、Content-Type、内容全部匹配 |
| `NO_HOST` | 全局记录，无法确定该验证哪个域名 |
| `EGRESS_BLOCKED` | 本机无法出网，**外部验证不可用**（不代表通过） |
| `DNS_OR_CONNECT_FAILED` | 域名解析或连接失败 |
| `REDIRECTED` | 有跳转，附跳转目标 |
| `STATUS_NOT_200` | 附实际状态码 |
| `CONTENT_TYPE_WRONG` | 附实际 Content-Type |
| `CONTENT_MISMATCH` | 并排显示期望与实际 |

**内容不会被自动清理。** 微信要求逐字节精确匹配，所以 BOM、CRLF、首尾空白只会被标黄警告，需要你点「一键清理」才会改动。

**唯一的例外是回车符。** 浏览器的 `<textarea>` 按 HTML 规范会把 CRLF/CR 强制规范化成 LF，这一层我们控制不了。所以拖拽导入一个含回车符的文件时，输入框里的内容已经和原文件不是逐字节相同了——遇到这种情况界面会明确弹窗告知，不会让它悄悄发生。真要保留 CR，只能绕过界面直接调 `POST /api/rules`。

**内部检查会发现"被遮蔽"的记录。** 如果同时存在一条全局记录和一条精确域名记录，全局那条永远不会被命中——自检会直接告诉你它被 id=X 挡住了。

## 用户管理

只有两级权限：超级管理员（管用户 + 管文件）和普通用户（只管文件）。超级管理员**不可被禁用、不可被降级**，这是为了杜绝把所有人锁在门外的不可恢复状态。

删除用户是**软禁用**：账号立即无法登录、既有会话立即失效，但他创建过的记录归属信息完整保留。禁用后可以随时恢复。

修改密码（无论自己改还是超管重置）都会清除该用户的**所有**会话。自己改密码时会当场补发一个新会话，所以不会掉线，但其他设备上的登录会失效。

## 备份

数据库是 `DATA_DIR/wx_router.db`（Docker 部署即宿主机 `./data/wx_router.db`）。备份已做成系统内置功能，**超管登录后在「备份」页**即可操作：

- **立即备份**：一键创建，走 SQLite 在线备份 API——任意时刻都是一致快照，服务无需停机
- **列表 / 下载 / 删除**：每份备份命名为 `wx_router-YYYYMMDD-HHMMSS.db`，写完先做 `integrity_check` 校验再原子改名，并按「保留份数」自动清理最旧的
- **每日定时备份**：进程内置定时器（默认关闭；开启后每天 03:17 执行，默认保留 14 份），不依赖外部 cron
- **恢复**：选一份备份恢复——服务先校验备份完整性，把现有库留底为 `wx_router.db.before-restore`，替换库文件后**自动重启**，期间服务短暂不可用

备份文件写在 `BACKUP_DIR`（默认 `./backups`；compose 已设为 `/app/data/backups`，即宿主机 `./data/backups`，备份随数据卷持久化）。

**恢复的自动重启前提**：进程退出后要有东西把它拉起来。Docker 部署已配置 `restart: unless-stopped`，无需额外操作；裸机部署需要 pm2 / systemd 等进程守护，否则恢复后服务就停了（此时手动启动即可，数据已经恢复完成）。

服务运行中**不要直接 `cp` 数据库文件**，可能拿到不一致的快照。CLI 脚本与界面共用同一套备份逻辑，仍然可用（也兼容 crontab 定时方案）：

```bash
# 本机部署：
node scripts/backup.js --dir ./backups --keep 14

# Docker 部署（备份写进已挂载的 ./data/backups，自然落在宿主机）：
docker compose exec -T wx_router node scripts/backup.js --dir /app/data/backups --keep 30
```

参数也可用环境变量 `BACKUP_DIR` / `KEEP` / `DATA_DIR` 代替。脚本只读打开源库，不写运行中的库。配合 crontab 的定时示例：

```cron
17 3 * * * cd /opt/wx_router && docker compose exec -T wx_router node scripts/backup.js --dir /app/data/backups --keep 30 >> /var/log/wx_router-backup.log 2>&1
```

**手工恢复**（界面恢复不可用时，把 `YYYYMMDD-HHMMSS` 换成实际备份名）：

```bash
docker compose stop
rm -f data/wx_router.db-wal data/wx_router.db-shm     # 清掉旧库的 WAL 残留
mv data/wx_router.db data/wx_router.db.before-restore # 现有库留底
cp backups/wx_router-YYYYMMDD-HHMMSS.db data/wx_router.db
docker compose start
```

## 超管密码丢失了怎么办

超管不可被删除也不可降级，所以没有 HTTP 途径可以重置。用救援脚本：

```bash
docker compose exec wx_router node scripts/reset-super-password.js <新密码>
```

它直接操作数据库，重算密码哈希、清除该账号所有会话，并顺带解除禁用状态（万一有人直接改库把超管禁用了）。

## 微信校验的几个坑

1. 内容必须**逐字节精确匹配**，尾部多一个换行就会失败
2. 内容**不能含 BOM**
3. 必须返回 **200，不能有任何重定向**。如果链路上有 HTTP→HTTPS 强制跳转，需要为 `.txt` 路径配置例外
4. `Content-Type` 必须是 `text/plain`（本服务已固定，并附 `Cache-Control: no-store` 防止中间层缓存住 404）
5. 文件必须在**域名根路径**，依赖网关不重写路径

## 排障

微信校验失败时，第一个要回答的问题永远是"请求到底有没有到这台机器"。进「请求记录」面板看最近 200 次 `.txt` 请求：

- **面板里没有对应记录** → 请求根本没到，去查网关转发规则
- **有记录但"未命中"** → 请求到了，问题在本服务的数据。看「解析后」那一列是什么域名，和记录里的域名对不对得上

这两种情况的排查方向完全相反，先分清再动手。

## 开发

```bash
npm install
npm test        # 后端全部单元与集成测试
SUPER_ADMIN_USER=root SUPER_ADMIN_PASSWORD=password1234 npm run dev
```

### 切换 Node 版本后必须 npm rebuild

`better-sqlite3` 是原生模块，编译产物和安装时的 Node 版本 ABI 绑死。用 fnm/nvm 切了 Node 大版本之后，测试会整片失败并报：

```
The module '.../better_sqlite3.node' was compiled against a different
Node.js version using NODE_MODULE_VERSION 131. This version of Node.js
requires NODE_MODULE_VERSION 127.
```

这不是代码问题，执行一次即可：

```bash
npm rebuild better-sqlite3
```

**Docker 不受影响** —— 镜像里的 `npm ci` 是在 `node:22-slim` 内执行的，天然对准生产的 Node 版本。

测试已在 **Node 22.21.1**（与 Dockerfile 同大版本）和 **Node 23.10.0** 上分别跑通，178 项全过。

前端是原生 HTML/JS，无构建步骤，改完刷新即可。

**前端没有自动化测试覆盖**，改动后需要手动验证：登录、增删改查、拖拽导入、自检、回收站恢复、用户管理、请求记录面板。后端有完整测试，可以放心重构。

## 架构

```
src/
├── validate.js      纯函数：文件名校验、host 规范化、内容体检
├── password.js      纯函数：scrypt 哈希与常数时间校验
├── db.js            SQLite 连接与表结构
├── repo/            仓储层，只认识数据库，不认识 HTTP
├── verify.js        GET /{name}.txt 的匹配与响应
├── selfcheck.js     两层自检与错误分类
├── auth.js          会话中间件与权限守卫
├── routes/          HTTP 接口层
├── app.js           装配路由，返回 Hono 实例（测试直接用它）
└── server.js        读环境变量、开库、初始化超管、监听端口
```

`app.js` 与 `server.js` 分开是刻意的：测试拿到装配好的 Hono 实例就能发请求，不必监听端口、不必读环境变量。
