# Traefik 接入

本服务只响应根路径的 `.txt`（`/MP_verify_xxx.txt` 这类），子目录形如 `/h5/xxx.txt` 不会命中——微信校验本身也要求文件位于域名根路径。网关的匹配规则照此写即可。

## Docker 标签方式

（wx_router 与 Traefik 同一 compose 网络）：

```yaml
labels:
  - "traefik.enable=true"
  # 不指定 entrypoints 即监听全部入口（web + websecure），HTTP/HTTPS 都能验证
  - "traefik.http.routers.wxverify.rule=Host(`example.com`) && PathRegexp(`^/[^/]+\\.txt$`)"
  - "traefik.http.services.wxverify.loadbalancer.server.port=3000"
```

## 静态配置 / file provider

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

## 要点

- Traefik 转发时自动带上 `X-Forwarded-Host`，无需额外 middleware
- 不要加 stripPrefix 之类改写路径的 middleware
- `PathRegexp` 规则比单纯的 `Host(...)` 更具体，Traefik 按规则长度自动选优：不会抢其他业务流量；web 入口上只带 Host 的 HTTP→HTTPS 跳转路由也会自动让位给 `.txt` 路由
- 站内已有根路径 `.txt` 时用否定规则排除：`Host(`example.com`) && PathRegexp(`^/[^/]+\\.txt$`) && !Path(`/robots.txt`)`
- 接入后到「请求记录」面板确认：能看到 `.txt` 请求、且「解析后」域名正确，即链路已通
