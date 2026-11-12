# 域名与 IP 访问

世界服务支持通过 HTTP IP 地址和 HTTPS 域名访问，例如 `https://3dbox.42tr.cn/`。HTTP 接口和 WebSocket 接受有效的域名或 IP Host，不再只接受 `localhost`／`127.0.0.1`。浏览器请求的 Origin 必须与 Host 对应；HTTPS 可以在反向代理处终止，转发到容器内的 HTTP 服务。

前端从当前页面的同源 `/health` 发现服务，使用相对路径调用 API，并根据页面协议连接 `ws://` 或 `wss://`。HTTPS 页面中的目录回放新窗口同样可用。静态预览没有世界服务健康接口时仍保持浏览器预览模式。

## 部署配置

反向代理和 Docker 在同一台服务器时，继续使用默认的 `127.0.0.1:8787` 端口映射，代理转发到该地址。

需要让其他机器直接连接服务器 8787 端口时，将部署包 `compose.yaml` 的 `world.ports` 对应行改为：

```yaml
ports:
  - "0.0.0.0:${BOX_HTTP_PORT:-8787}:8787"
```

`.env` 中的 `BOX_HTTP_PORT` 控制宿主机端口，默认仍为 8787。

需要重新构建并部署包含此修改的镜像，旧镜像中的代码不会随源码拉取而更新。沿用此前的构建网络／代理参数构建镜像，再按原打包流程导入目标服务器，并在部署目录执行：

```bash
docker compose -p 3dbox4agent up --no-build --pull never --wait control
```

## HTTPS 反向代理

代理需保留原请求的 Host，并转发 `/stream` 的 WebSocket Upgrade。Caddy 的 HTTP 上游可直接使用：

```caddyfile
3dbox.42tr.cn {
    reverse_proxy 127.0.0.1:8787
}
```

若使用 Nginx，在已有 HTTPS `server` 配置中设置：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

浏览器访问域名后点击“连接世界服务”。可先用以下命令确认域名已连接到新版服务：

```bash
curl -fsS https://3dbox.42tr.cn/control/world/health
```

健康接口应返回 `"ok": true`；页面连接后，开发者工具中的 `/stream` 应完成 WebSocket 握手。若页面可打开，但浏览器 API 或 WebSocket 报 Origin 错误，应核对反向代理是否保留了外部域名的 Host。

会话、管理员、观察者、设备与协调者继续按各自凭据访问。此变更提供同源远程访问，不新增登录或多用户账户系统。容器内 Python Agent 默认通过本机 8789 端口访问 Control。
