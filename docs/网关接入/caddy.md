# Caddy 接入

Caddy 自动申请与管理 HTTPS 证书，配置比 nginx 简洁得多。在站点块里加一个命名匹配器，把根路径的 `.txt` 反代给 wx_router 即可（子目录形如 `/h5/xxx.txt` 不会命中，微信校验本身也只认根路径）：

```caddy
example.com {
    # 根路径的 .txt
    @verify path_regexp ^/[^/]+\.txt$

    # 反代给 wx_router；Caddy 不重写路径，并自动带 X-Forwarded-Host
    reverse_proxy @verify 127.0.0.1:3000

    # 其余业务流量照常处理
}
```

## HTTP→HTTPS 跳转

Caddy 对 `example.com` 站点块默认同时在 80/443 监听，并在 80 上自动跳转 HTTPS，**这个自动跳转不拦截 `.txt` 反代**，无需任何额外配置。

只有当你显式写了 `http://example.com` 站点块（比如为了自定义跳转行为）时才需要注意，把 `.txt` 排除在跳转之外（微信不允许重定向）：

```caddy
http://example.com {
    @verify path_regexp ^/[^/]+\.txt$
    reverse_proxy @verify 127.0.0.1:3000   # .txt 直接反代，不跳转

    @notVerify not path_regexp ^/[^/]+\.txt$
    redir @notVerify https://example.com{uri} permanent
}
```

## 要点

- Caddy 自动 HTTPS（ACME）、自动带 `X-Forwarded-Host`，无需像 nginx 那样显式 set header
- `reverse_proxy` 默认保留原始路径与 Host，不要画蛇添足加 `rewrite` / `uri strip`
- 站内已有根路径 `.txt`（如 `robots.txt`）时收窄匹配器：`@verify path_regexp ^/[^/]+\.txt$ && not path /robots.txt`
- 接入后到「请求记录」面板确认：能看到 `.txt` 请求、且「解析后」域名正确，即链路已通
