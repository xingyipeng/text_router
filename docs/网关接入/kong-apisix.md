# Kong / APISIX 接入

微信校验文件必须位于域名根路径；本服务同时支持子目录路径（如 `/h5/xxx.txt`），一条规则转发任意深度的 `.txt` 即可。若站内其他业务在子目录有自己的 `.txt`，把正则收窄到实际路径前缀（见下文要点）。两条网关都用「正则路由 + 不重写路径 + 保留原 Host」的方式接入。

## Kong

用一条正则路由把任意路径的 `.txt` 指向 wx_router 的 service：

```yaml
# 声明式配置（kong.yml），Admin API 等价写法同理
_format_version: "3.0"
services:
  - name: wx-router
    url: http://127.0.0.1:3000

routes:
  - name: wx-verify
    paths: ["~/^/.*\\.txt$"]      # ~ 前缀表示正则路由
    strip_path: false             # 不重写路径，保留原始 URI
    preserve_host: true           # 原始 Host 原样传给上游
    service: wx-router
```

要点：

- 正则路由要用 `~` 前缀（Kong 3.x 语法），且正则以 `^` 开头
- 保持 `strip_path: false`（默认就是 false）——路径一旦被改写，微信校验就失败
- `preserve_host: true` 保留原始域名；Kong 同时会自动带上 `X-Forwarded-Host`
- 只保留这一个 route 就不会影响其他业务路由；若已有兜底 route，注意 Kong 按 `regex_priority`（默认 0）选路，必要时调高本路由的 `regex_priority`（如 100）
- 站内业务在子目录有自己的 `.txt` 时，收窄到实际路径前缀：`paths: ["~/^/(verify|h5)/.*\\.txt$"]`

## APISIX

用 `vars` 的正则匹配把任意路径的 `.txt` 指向上游：

```yaml
routes:
  - id: wx-verify
    vars:
      - ["uri", "~~", ".*\\.txt$"]        # ~~ 表示正则匹配
    upstream:
      type: roundrobin
      pass_host: pass                     # 原始 Host 原样传给 wx_router
      nodes:
        "127.0.0.1:3000": 1
```

要点：

- `vars` 里的 `~~` 表示对 uri 做正则匹配
- `pass_host: pass` 保留原始 Host（默认 `rewrite` 会改成上游节点的主机名，wx_router 就认不出域名了）
- 不配置 proxy-rewrite 插件即不重写路径
- 站内已有 `.txt`（如 `robots.txt`）时，加一条 `["uri", "!", "~~", "^/robots\\.txt$"]` 到 vars 里否定排除
- 站内业务在子目录有自己的 `.txt` 时，收窄到实际路径前缀：`["uri", "~~", "^/(verify|h5)/.*\\.txt$"]`
- 接入后到「请求记录」面板确认：能看到 `.txt` 请求、且「解析后」域名正确，即链路已通
