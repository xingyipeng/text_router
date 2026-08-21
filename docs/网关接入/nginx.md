# Nginx 接入

微信校验文件必须位于域名根路径；本服务同时支持子目录路径（如 `/h5/xxx.txt`），一条规则转发任意深度的 `.txt` 即可。若站内其他业务在子目录有自己的 `.txt`，把正则收窄到实际路径前缀（见文末要点）。

## 443 站点

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    # 任意路径的 .txt 转发给 wx_router。
    # 注意 proxy_pass 结尾不带 / —— 带了 / 会把路径重写掉，微信校验就失败了
    location ~* \.txt$ {
        proxy_pass http://127.0.0.1:3000;          # wx_router 在别的机器上就换成内网地址
        proxy_set_header Host $host;               # nginx 默认就传 Host，显式写出更稳
        proxy_set_header X-Forwarded-Host $host;   # 服务优先读这个头，双保险
    }

    location / {
        # 其余业务流量照常处理
    }
}
```

## 80 站点（HTTP→HTTPS 跳转例外）

站点有 HTTP→HTTPS 强制跳转时，`return 301` 必须放在 `location /` 里而不是 server 级，否则 `.txt` 也会被跳转（微信不允许重定向）：

```nginx
server {
    listen 80;
    server_name example.com;

    location ~* \.txt$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
```

## 要点

- 正则 location 优先级高于普通前缀 location，不会抢走其他业务流量
- 站内已有 `.txt`（如 `robots.txt`）时用精确匹配排除——精确匹配优先级最高，不受书写顺序影响：`location = /robots.txt { ... }`
- 站内业务在子目录有自己的 `.txt`（如 `/static/app.txt`）时，把正则收窄到实际路径前缀：`location ~* ^/(verify|h5)/.*\.txt$ { ... }`
- 接入后到「请求记录」面板确认：能看到 `.txt` 请求、且「解析后」域名正确，即链路已通
