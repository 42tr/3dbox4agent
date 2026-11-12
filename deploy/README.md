# 3DBox 部署包

服务器需要 Docker Engine 与 Docker Compose，CPU 架构须与 `RELEASE.txt` 中的平台一致。`image.tar.gz` 包含 World、Control、Console 和 Agent 四个镜像及各自的运行依赖。

## 上传与解压

将生成的 `.tar.gz` 和同名 `.tar.gz.sha256` 文件上传到服务器。以下用 `实际包名` 代替文件名中 `.tar.gz` 前的部分：

```bash
sha256sum -c 实际包名.tar.gz.sha256
tar -xzf 实际包名.tar.gz
cd 实际包名
```

## 导入并启动

先检查包内文件，再导入镜像、启动服务：

```bash
sha256sum -c SHA256SUMS
docker image load -i image.tar.gz
docker compose -p 3dbox4agent config --quiet
docker compose -p 3dbox4agent up --no-build --pull never --wait --wait-timeout 120 console
docker compose -p 3dbox4agent ps
curl -fsS http://127.0.0.1:8787/control/world/health
```

容器应显示 `healthy`，健康接口应返回 `"ok": true`。启动失败时执行：

```bash
docker compose -p 3dbox4agent logs --tail=100 world control console
```

包内 `.env` 已记录实际镜像名和 CPU 平台，无需从构建终端加载变量。默认映射 `0.0.0.0:8787`、最多同时运行 2 个世界进程；世界容器上限为 2 CPU、2 GiB 内存。容器重启策略为 `unless-stopped`，运行配置不包含构建路径。

## 访问与配置

浏览器打开 `http://服务器IP:8787/`，点击“连接世界服务”。也可以通过 HTTPS 反向代理访问；代理需保留原 Host 并转发 `/stream` 的 WebSocket Upgrade。8787 由 Console 提供，Control 的 8789 仅发布到服务器回环地址。按需运行 Agent 时执行 `docker compose -p 3dbox4agent run --rm -T runner`。

端口、绑定地址和世界并发数可在包内 `.env` 修改：

```dotenv
BOX_HTTP_BIND=0.0.0.0
BOX_HTTP_PORT=8787
BOX_WORLD_WORKERS=2
```

若只供同机反向代理访问，可将 `BOX_HTTP_BIND` 改为 `127.0.0.1`。配置修改后再次执行上述启动命令；若端口已修改，健康检查命令同步使用新端口。

## 更新与数据

新版本使用同一 Compose 项目名 `3dbox4agent`，导入新镜像后执行同一启动命令，即可复用原数据卷中的日志和实验目录。服务重建会结束原内存会话。

部署包包含应用镜像与配置，历史数据卷和正在运行的会话不随包迁移。`RELEASE.txt` 记录源码提交、镜像标签、镜像 ID 和平台；校验包内文件后再修改部署配置。
