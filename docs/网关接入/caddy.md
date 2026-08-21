# Caddy 接入

Caddy 自动申请与管理 HTTPS 证书，配置比 nginx 简洁得多。微信校验文件必须位于域名根路径；本服务同时支持子目录路径（如 `/h5/xxx.txt`），一条规则转发任意深度的 `.txt` 即可。若站内其他业务在子目录有自己的 `.txt`，把匹配器收窄到实际路径前缀（见文末要点）：

```caddy
example.com {
    # 任意路径的 .txt
    @verify path_regexp \.txt$

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
    @verify path_regexp \.txt$
    reverse_proxy @verify 127.0.0.1:3000   # .txt 直接反代，不跳转

    @notVerify not path_regexp \.txt$
    redir @notVerify https://example.com{uri} permanent
}
```

## 要点

- Caddy 自动 HTTPS（ACME）、自动带 `X-Forwarded-Host`，无需像 nginx 那样显式 set header
- `reverse_proxy` 默认保留原始路径与 Host，不要画蛇添足加 `rewrite` / `uri strip`
- 站内已有 `.txt`（如 `robots.txt`）时收窄匹配器：`@verify path_regexp \.txt$ && not path /robots.txt`
- 站内业务在子目录有自己的 `.txt` 时，收窄到实际路径前缀：`@verify path_regexp ^/(verify|h5)/.*\.txt$`
- 接入后到「请求记录」面板确认：能看到 `.txt` 请求、且「解析后」域名正确，即链路已通
