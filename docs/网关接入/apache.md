# Apache / httpd 接入

Apache 用 `mod_proxy` 做反向代理。前提是启用三个模块：

```bash
a2enmod proxy proxy_http rewrite   # Debian / Ubuntu
```

（CentOS / RHEL 系在配置里 `LoadModule`，或用 `httpd -M | grep proxy` 确认已加载。）

微信校验文件必须位于域名根路径；本服务同时支持子目录路径（如 `/h5/xxx.txt`），一条规则转发任意深度的 `.txt` 即可。若站内其他业务在子目录有自己的 `.txt`，把正则收窄到实际路径前缀（见文末要点）。

## 443 vhost

```apache
<VirtualHost *:443>
    ServerName example.com
    # ... 证书等现有配置 ...

    # 任意路径的 .txt 转发给 text_router。
    # 注意 ProxyPass 结尾不带 / —— 带了 / 会把路径重写掉，微信校验就失败了
    ProxyPreserveHost On
    <LocationMatch "\.txt$">
        ProxyPass http://127.0.0.1:3000
    </LocationMatch>

    # 其余业务流量照常处理
</VirtualHost>
```

## 80 vhost（HTTP→HTTPS 跳转例外）

有 HTTP→HTTPS 强制跳转时，用 `RewriteCond` 把 `.txt` 排除在跳转之外（微信不允许重定向）：

```apache
<VirtualHost *:80>
    ServerName example.com

    RewriteEngine On
    # 不是 .txt 才跳转
    RewriteCond %{REQUEST_URI} !\.txt$
    RewriteRule ^ https://example.com%{REQUEST_URI} [R=301,L]

    ProxyPreserveHost On
    <LocationMatch "\.txt$">
        ProxyPass http://127.0.0.1:3000
    </LocationMatch>
</VirtualHost>
```

## 要点

- **`.htaccess` 不支持 `ProxyPass`**（mod_proxy 指令只允许出现在 server / vhost 配置里）。共享主机、只有 .htaccess 权限的环境没法用 Apache 做这个反代，需要换 Nginx / Caddy，或联系主机商在 vhost 里配置
- `ProxyPreserveHost On` 把原始域名传给 text_router（Apache 默认会把 Host 改成代理目标的主机名）；`X-Forwarded-Host` 由 mod_proxy 自动携带
- 站内已有 `.txt`（如 `robots.txt`）时精确排除，不代理。注意排除块要写在转发块**之后**——Apache 按配置顺序合并，后写的生效：

```apache
    <LocationMatch "\.txt$">
        ProxyPass http://127.0.0.1:3000
    </LocationMatch>

    <LocationMatch "^/robots\.txt$">
        ProxyPass !
    </LocationMatch>
```

- 站内业务在子目录有自己的 `.txt` 时，收窄到实际路径前缀：`<LocationMatch "^/(verify|h5)/.*\.txt$">`

- 接入后到「请求记录」面板确认：能看到 `.txt` 请求、且「解析后」域名正确，即链路已通
