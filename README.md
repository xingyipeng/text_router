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

## Docker 部署与打包

部署用 `docker compose`，打包发布用仓库里的构建脚本。

### 部署

「快速开始」里的 `docker compose up -d` 就是完整部署。compose 文件要点：

- **数据持久化**：宿主机 `./data` 挂载为容器内 `/app/data`——数据库、备份全在里面，升级镜像、删除容器都不丢数据
- **自动重启**：`restart: unless-stopped`，进程退出后 Docker 自动拉起（界面「恢复」功能依赖这一点）
- **环境变量**：从 `.env` 读取传给容器（`SUPER_ADMIN_*`、`PORT`、`SESSION_TTL_HOURS`、`COOKIE_SECURE`）；`DATA_DIR` / `BACKUP_DIR` 已由 compose 固定为容器内路径，无需额外设置

### 跨平台打包

在 x86 机器上构建的镜像拿到 arm 机器上跑会失败（反之亦然）：`better-sqlite3` 是原生模块，与构建机架构绑死。用构建脚本一次产出 `linux/amd64` + `linux/arm64` 双架构镜像并推送：

```bash
# 前提：Docker 19.03+ 自带 buildx。Linux 主机首次跨架构构建前注册一次 QEMU 模拟器：
#   docker run --rm --privileged tonistiigi/binfmt --install all
# Docker Desktop（macOS/Windows）已内置，无需这步。

scripts/build-docker.sh --push \
  -t registry.example.com/wx-router:1.0.0 \
  -t registry.example.com/wx-router:latest
```

服务器上把 compose 里的 `build: .` 换成 `image: registry.example.com/wx-router:1.0.0`，之后升级版本：

```bash
docker compose pull && docker compose up -d   # ./data 数据卷原样沿用，业务数据不受影响
```

脚本选项：`-t/--tag` 镜像名（**可重复**，一次构建打多个标签，如上例的版本号 + latest）、`--platform` 目标平台（默认双架构）、`--push` 推送、`--load` 只构建本机架构载入本地（试跑用）、`--no-cache`。不加 `--push/--load` 则只做双架构构建验证。

多平台构建需要**容器驱动**的 buildx 构建器（Docker Desktop 默认的 docker 驱动不支持）。脚本会优先复用机器上已有的容器驱动构建器——多个项目共用一个即可；一个都没有时才创建一个通用的 `multiarch`。

Dockerfile 无需改动：两阶段构建——第一阶段在 `node:22-slim` 里装 python3/make/g++ 编译 `better-sqlite3`，第二阶段只拷贝编译产物和代码，最终镜像不带编译工具链。依赖编译发生在目标平台的容器内部，宿主机上的 `node_modules` 从不进入镜像。

### 没有镜像仓库的内网

按服务器架构单独导出 tar 包，拷过去 `docker load`：

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

### 接入示例

本服务**只响应根路径的 `.txt`**（`/MP_verify_xxx.txt` 这类），子目录形如 `/h5/xxx.txt` 不会命中——微信校验本身也要求文件位于域名根路径。网关的匹配规则照此写即可。

#### Nginx

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    # 根路径的 .txt 转发给 wx_router。
    # 注意 proxy_pass 结尾不带 / —— 带了 / 会把路径重写掉，微信校验就失败了
    location ~* ^/[^/]+\.txt$ {
        proxy_pass http://127.0.0.1:3000;          # wx_router 在别的机器上就换成内网地址
        proxy_set_header Host $host;               # nginx 默认就传 Host，显式写出更稳
        proxy_set_header X-Forwarded-Host $host;   # 服务优先读这个头，双保险
    }

    location / {
        # 其余业务流量照常处理
    }
}
```

要点：

- 正则 location 优先级高于普通前缀 location，不会抢走其他业务流量
- 站内根路径本来就有 `.txt`（如 `robots.txt`）时用精确匹配排除——精确匹配优先级最高，不受书写顺序影响：`location = /robots.txt { ... }`
- 站点有 HTTP→HTTPS 强制跳转时，`return 301` 必须放在 `location /` 里而不是 server 级，否则 `.txt` 也会被跳转（微信不允许重定向）：

```nginx
server {
    listen 80;
    server_name example.com;

    location ~* ^/[^/]+\.txt$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
```

#### Traefik

Docker 标签方式（wx_router 与 Traefik 同一 compose 网络）：

```yaml
labels:
  - "traefik.enable=true"
  # 不指定 entrypoints 即监听全部入口（web + websecure），HTTP/HTTPS 都能验证
  - "traefik.http.routers.wxverify.rule=Host(`example.com`) && PathRegexp(`^/[^/]+\\.txt$`)"
  - "traefik.http.services.wxverify.loadbalancer.server.port=3000"
```

静态配置 / file provider 的等价写法：

```yaml
http:
  routers:
    wxverify:
      rule: "Host(`example.com`) && PathRegexp(`^/[^/]+\\.txt$`)"
      service: wxrouter
  services:
    wxrouter:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:3000"
```

要点：

- Traefik 转发时自动带上 `X-Forwarded-Host`，无需额外 middleware
- 不要加 stripPrefix 之类改写路径的 middleware
- `PathRegexp` 规则比单纯的 `Host(...)` 更具体，Traefik 按规则长度自动选优：不会抢其他业务流量；web 入口上只带 Host 的 HTTP→HTTPS 跳转路由也会自动让位给 `.txt` 路由
- 站内已有根路径 `.txt` 时用否定规则排除：`Host(`example.com`) && PathRegexp(`^/[^/]+\\.txt$`) && !Path(`/robots.txt`)`

接入后到「请求记录」面板确认：能看到 `.txt` 请求、且「解析后」域名正确，即链路已通。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `DATA_DIR` | `./data` | SQLite 文件目录 |
| `BACKUP_DIR` | `./backups` | 备份文件目录（compose 已改为 `/app/data/backups`，随数据卷持久化） |
| `SUPER_ADMIN_USER` | `admin` | 仅在数据库为空时用于创建超管 |
| `SUPER_ADMIN_PASSWORD` | `admin123` | 同上；至少 8 位 |
| `SESSION_TTL_HOURS` | `168` | 会话有效期（7 天），可在界面「设置」中覆盖（只影响新会话） |
| `COOKIE_SECURE` | `false` | 部署在 HTTPS 后面时设为 `true` |

数据库非空时 `SUPER_ADMIN_*` 会被忽略，重启不会重置任何账号。数据库为空且未设置时，会用默认账号 `admin/admin123` 自动创建超管，并在启动日志打印警告——**默认密码是弱口令，首次登录后请立即修改**。密码至少 8 位。

## 使用要点

**看板**：登录后的首页是「看板」，汇总文件统计（总数、绑定域名数、按域名分布）和请求统计（命中率、今日命中/未命中、最近 24 小时趋势）。文件统计来自数据库；请求统计来自内存，服务重启后清零。

**添加校验文件**：从微信后台下载 `.txt` 文件后，直接**拖到新增对话框的虚线框里**，文件名和内容会自动填入，避免手抄出错。

**批量迁移**：规则页「导出」把全部未删除规则打成 JSON 下载；「导入」上传该 JSON，按「域名 + 文件名」与现有规则合并，重复记录可选**跳过或覆盖**（默认跳过），完成后报告导入 / 跳过 / 错误明细。

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

超管还可以编辑任意用户的**显示名和用户名**（重名会返回 409）。改名不影响已登录的会话。

修改密码（无论自己改还是超管重置）都会清除该用户的**所有**会话。自己改密码时会当场补发一个新会话，所以不会掉线，但其他设备上的登录会失效。

## 备份

数据库是 `DATA_DIR/wx_router.db`（Docker 部署即宿主机 `./data/wx_router.db`）。备份已做成系统内置功能，**超管登录后在「备份」页**即可操作：

- **立即备份**：一键创建，走 SQLite 在线备份 API——任意时刻都是一致快照，服务无需停机
- **列表 / 下载 / 删除**：每份备份命名为 `wx_router-YYYYMMDD-HHMMSS.db`，写完先做 `integrity_check` 校验再原子改名，并按「保留份数」自动清理最旧的
- **每日定时备份**：进程内置定时器（默认关闭；开启后每天 03:17 执行，默认保留 14 份），不依赖外部 cron
- **恢复**：选一份备份恢复——服务先校验备份完整性，把现有库留底为 `wx_router.db.before-restore`，替换库文件后**自动重启**，期间服务短暂不可用
- **上传恢复**：把另一台服务器的库文件（或其备份）直接上传——服务校验完整性后同样替换库文件并自动重启，旧库同样留底。迁移时无需登录服务器拷贝文件

备份文件写在 `BACKUP_DIR`（默认 `./backups`；compose 已设为 `/app/data/backups`，即宿主机 `./data/backups`，备份随数据卷持久化）。

**恢复的自动重启前提**：进程退出后要有东西把它拉起来。Docker 部署已配置 `restart: unless-stopped`，无需额外操作；裸机部署需要 pm2 / systemd 等进程守护，否则恢复后服务就停了（此时手动启动即可，数据已经恢复完成）。

服务运行中**不要直接 `cp` 数据库文件**，可能拿到不一致的快照。CLI 脚本与界面共用同一套备份逻辑，仍然可用（也兼容 crontab 定时方案）：

```bash
# 本机部署：
node scripts/backup.js --dir ./backups --keep 14

# Docker 部署（备份写进已挂载的 ./data/backups，自然落在宿主机）：
docker compose exec -T wx_router node scripts/backup.js --dir /app/data/backups --keep 30
```

参数也可用环境变量 `BACKUP_DIR` / `KEEP` / `DATA_DIR` 代替（`KEEP` 只对 CLI 脚本生效；界面定时备份的保留份数在「设置」页设置）。脚本只读打开源库，不写运行中的库。配合 crontab 的定时示例：

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

## 设置

超管登录后的「设置」页集中了可调整的运行参数（原「备份」面板里的定时备份设置也挪到了这里）：

- **定时备份**：启用开关、每日执行时间、保留份数（见上文「备份」）
- **会话有效期**：1-720 小时（默认 168，即环境变量 `SESSION_TTL_HOURS` 的默认值）。**只影响之后新建立的会话**，当前已登录的设备不受影响
- **单机登录**：开启后同一账号只保留一个会话——新登录会把该账号在其它设备上的会话全部踢下线；改密码同样适用
- **自检超时**：规则自检时等待线上返回的最长时间，3-30 秒（默认 8）
- **请求记录容量**：内存中保留的请求条数，50-5000（默认 200）。改小后立即裁剪，重启仍会清空

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

微信校验失败时，第一个要回答的问题永远是"请求到底有没有到这台机器"。进「请求记录」面板看最近的 `.txt` 请求（默认保留 200 次，可在「设置」中调整容量；工具栏「清空」可一键清空内存记录）：

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

测试已在 **Node 22.21.1**（与 Dockerfile 同大版本）上全量跑通：17 个测试文件、**298 项全过**。

前端是原生 HTML/JS，无构建步骤，改完刷新即可。

**前端没有自动化测试覆盖**，改动后需要手动验证：登录、看板、增删改查、拖拽导入、自检、回收站恢复、用户管理、请求记录、备份与恢复。后端有完整测试，可以放心重构。

## 架构

```
src/
├── validate.js      纯函数：文件名校验、host 规范化、内容体检
├── password.js      纯函数：scrypt 哈希与常数时间校验
├── db.js            SQLite 连接与表结构
├── repo/            仓储层，只认识数据库，不认识 HTTP
├── verify.js        GET /{name}.txt 的匹配与响应
├── requestlog.js    .txt 请求的内存记录（排障、看板共用）
├── stats.js         看板统计聚合
├── backup.js        备份核心：在线备份、定时调度、恢复（界面与 CLI 共用）
├── settings.js      统一设置读写：备份 / 会话 / 自检 / 请求记录
├── selfcheck.js     两层自检与错误分类
├── auth.js          会话中间件与权限守卫
├── routes/          HTTP 接口层
├── app.js           装配路由，返回 Hono 实例（测试直接用它）
├── init.js          超管初始化与密码重置（server 与救援脚本共用）
└── server.js        读环境变量、开库、监听端口
```

`app.js` 与 `server.js` 分开是刻意的：测试拿到装配好的 Hono 实例就能发请求，不必监听端口、不必读环境变量。
