# 构建与部署

## 从源码生成离线包

在源码仓库根目录运行，构建机需要 Docker Engine、Buildx 和 Git：

```sh
bash scripts/build-image.sh --arch amd64
```

ARM64 服务器使用 `--arch arm64`。脚本在 `.3dbox/releases/` 生成部署压缩包和同名 `.sha256`，内含 World（Rust 后端）、Control、Console 和 Agent 四个镜像。用 `--help` 查看自定义 World 镜像名和构建网络选项。

脚本会传递终端已导出的 HTTP(S) 代理变量。Linux 默认使用 `host` 构建网络，以便访问宿主机的回环代理。构建器使用自己的网络或拒绝 `network.host` 时，可指定 `--network default` 并使用构建环境可达的代理。可用 `NPM_REGISTRY` 和 `PIP_INDEX_URL` 覆盖下载源。

## 校验、导入和启动

在目标服务器上，用实际压缩包文件名替换示例中的 `release.tar.gz`：

```sh
sha256sum -c release.tar.gz.sha256
tar -xzf release.tar.gz
```

进入解压目录，核对 `RELEASE.txt` 中的平台与服务器架构一致，然后执行：

```sh
sha256sum -c SHA256SUMS
docker image load -i image.tar.gz
docker compose -p 3dbox4agent config --quiet
docker compose -p 3dbox4agent up --no-build --pull never --wait --wait-timeout 120
curl -fsS http://127.0.0.1:8787/control/world/health
```

打开 `http://服务器IP:8787/`，点击 **连接世界服务**。启动失败时可用 `docker compose -p 3dbox4agent logs --tail=100 world control console runner` 查看日志。

部署默认启动 World、Control、Console 和 Runner。进入 Console 的 **Runner 实验 → 管理令牌与外部 Runner**，应用部署包 `.env` 中的 `BOX_RUNNER_OPERATOR_TOKEN`，然后选择内置 Runner，配置并启动实验。运行结束后可以直接打开或下载回放。

原有的单次命令行实验也可以运行：

```sh
docker compose -p 3dbox4agent run --rm -T runner \
  python3 packages/agent/python/multi_agent_demo.py --fault none --physics rapier --archive > agent-run.json
```

## 端口与 HTTPS

部署包的 `.env` 已记录镜像和平台，可调整以下设置：

```dotenv
BOX_HTTP_BIND=0.0.0.0
BOX_HTTP_PORT=8787
BOX_CONTROL_PORT=8789
BOX_WORLD_WORKERS=2
```

Console 使用 `BOX_HTTP_BIND` 和 `BOX_HTTP_PORT`。Control 的宿主机端口仅绑定回环地址，World 留在 Compose 内部网络。使用同机 HTTPS 反向代理时，可把 `BOX_HTTP_BIND` 设为 `127.0.0.1`。代理需保留外部 Host，并把 `/stream` 的 WebSocket Upgrade 转发给 Console。

## 接入外部 Runner

部署包自动生成 `BOX_RUNNER_OPERATOR_TOKEN`。在 Console 应用令牌后，即可在 **管理令牌与外部 Runner** 签发凭据。升级时可将上一个部署的令牌复制到新包的 `.env`，以继续使用同一个管理令牌。

远程 Runner 需要能通过 HTTPS 访问 Control 的 `/runners/v1/*`。可在 HTTPS 反向代理上将 Runner 协议路径转发到服务器回环地址上的 Control 端口。协议及示例见源码仓库的 `docs/runner-protocol.md`。

## 更新与数据

用同一 Compose 项目名导入并启动新部署包，继续使用原来的 `world-data` 卷。`world-data` 保存事件日志和实验目录，`control-data` 保存 Runner 注册、运行记录和回放，`runner-auth` 保存内置 Runner 凭据。World 容器重建会结束内存会话。迁移到另一台主机时，另行迁移这些数据卷。

`docker compose -p 3dbox4agent down` 保留卷，附加 `--volumes` 会删除卷。从旧日志恢复仿真时，保留生成该日志的 World 镜像和原日志访问凭据。
