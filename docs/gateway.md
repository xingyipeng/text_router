# 网关接入（Nginx / Traefik）

本服务只响应根路径的 `.txt`（`/MP_verify_xxx.txt` 这类），子目录形如 `/h5/xxx.txt` 不会命中——微信校验本身也要求文件位于域名根路径。网关的匹配规则照此写即可。

## Nginx

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

## Traefik

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
