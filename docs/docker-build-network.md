# Docker 构建网络与代理

`pip` 报 `Network is unreachable` 表示构建环境无法连到依赖下载地址。紧接着的 `No matching distribution found for wheel` 可能是读取索引失败的结果，应先检查前面的连接错误。Rust 步骤被标为 `CANCELED` 表示构建整体中止，不能据此认定 Rust 编译失败。

宿主机、Docker daemon 和构建容器的代理设置分别生效。为构建内的 npm、pip、Cargo、apt 提供代理时，使用 Docker 的预定义 `HTTP_PROXY`、`HTTPS_PROXY` 构建参数，具体行为见 [Docker 代理配置文档](https://docs.docker.com/engine/cli/proxy/)。这些参数无需写入 Dockerfile。

## 使用构建脚本

在拉取源码后，执行一条命令即可完成构建和部署包导出：

```bash
bash scripts/build-image.sh
```

脚本默认构建并加载 `linux/amd64` 的 `world-rust` 镜像，随后导出镜像、生成部署配置和校验文件，最后输出完整压缩包路径。代理使用终端已导出的大小写环境变量；Linux 默认采用宿主机网络，其他系统默认采用 `default` 网络。构建机器需要 Bash、Git、Docker、Buildx、tar、gzip，以及 sha256sum 或 shasum。源码更新由你在运行脚本前执行。

支持以下选项：

```bash
# ARM64 目标服务器
bash scripts/build-image.sh --arch arm64

# 指定镜像名称，包内配置会同步使用这个镜像
bash scripts/build-image.sh --image 3dbox4agent:world-rust

# 使用默认构建网络
bash scripts/build-image.sh --network default

# 查看全部选项
bash scripts/build-image.sh --help
```

脚本默认使用官方 PyPI 和 npm 下载源；可通过 `PIP_INDEX_URL`、`NPM_REGISTRY` 环境变量覆盖。宿主机网络及代理地址的适用条件见下文。

产物位于 `.3dbox/releases/`：

```text
3dbox4agent-版本-linux-amd64.tar.gz
3dbox4agent-版本-linux-amd64.tar.gz.sha256
3dbox4agent-版本-linux-amd64/            # 同时保留解包后的内容
  image.tar.gz
  compose.yaml
  .env
  README.md
  RELEASE.txt
  SHA256SUMS
```

上传压缩包与同名 `.sha256` 文件，在目标 Linux 服务器上执行以下命令；将“实际包名”替换为脚本输出的文件名中 `.tar.gz` 前的部分：

```bash
sha256sum -c 实际包名.tar.gz.sha256
tar -xzf 实际包名.tar.gz
cd 实际包名
sha256sum -c SHA256SUMS
docker image load -i image.tar.gz
docker compose -p 3dbox4agent up --no-build --pull never --wait control
curl -fsS http://127.0.0.1:8787/control/world/health
```

目标服务器的 CPU 架构须与镜像一致，只需要 Docker Engine 和 Compose。包内 `.env` 已写入实际镜像名和平台，默认映射 `0.0.0.0:8787`；绑定地址、端口与世界并发数可在解压后修改。Compose 配置没有源码路径或 `build` 依赖，重启策略为 `unless-stopped`，世界服务默认上限为 2 CPU、2 GiB 内存。更完整的操作说明随包提供。

构建、镜像导出或压缩失败时脚本返回失败状态，清理临时打包文件，并保留上次成功的结果记录。成功后 `.3dbox/builds/last-build.env` 仍记录镜像与压缩包路径，供自动化使用；手工部署无需加载此文件。校验归档、代理转发和失败处理可执行 `npm run test:build-image` 验证，该检查模拟 Docker，实际创建并检查压缩包。

## Linux 上沿用终端代理或宿主机路由

以下命令适用于同一台 Linux 服务器上的 Docker Engine 和默认 `docker` 构建驱动。宿主机 `curl https://google.com` 成功，只确认了宿主机到该地址的访问；还需要检查 PyPI 地址和构建容器的联网路径。

在源码仓库根目录、同一个 Bash 终端中，先沿用当前代理配置读取 PyPI 索引：

```bash
curl --fail --silent --show-error --location \
  --connect-timeout 10 --max-time 30 \
  --output /dev/null https://pypi.org/simple/wheel/
```

仅在这一步成功后继续。下面自动把已导出的大小写代理环境变量传给构建，不需要填写代理端口。`--network=host` 让构建步骤使用宿主机网络，以访问监听在宿主机 `127.0.0.1` 上的代理，或使用宿主机的路由。网络模式含义见 [Docker Buildx 文档](https://docs.docker.com/reference/cli/docker/buildx/build/#network)。

```bash
build_network_args=(
  --network=host
  --allow=network.host
  --build-arg 'PIP_INDEX_URL=https://pypi.org/simple'
  --build-arg 'NPM_REGISTRY=https://registry.npmjs.org'
)

for build_proxy_key in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do
  if printenv "$build_proxy_key" >/dev/null; then
    build_network_args+=(--build-arg "$build_proxy_key")
  fi
done

release_platform="${release_platform:-linux/amd64}"

docker buildx build \
  "${build_network_args[@]}" \
  --platform "$release_platform" \
  --target python-dependencies \
  --progress=plain \
  .
```

如果环境变量中没有代理地址，但宿主机通过 TUN 等路由方式联网，此命令仍使用宿主机网络；能否访问下载站点以 Python 依赖阶段的结果为准。

Python 依赖阶段成功后，沿用此前设置的 `release_image` 镜像标签构建完整服务：

```bash
docker buildx build \
  "${build_network_args[@]}" \
  --platform "$release_platform" \
  --target world-rust \
  --load \
  --progress=plain \
  -t "${release_image:?请先按打包步骤设置 release_image}" \
  .
```

## 需要手动指定 HTTP 代理时

若终端只有 `ALL_PROXY=socks5://...` 或 `socks5h://...`，`curl` 能用该代理不代表构建内的 pip 已安装 SOCKS 支持。请使用代理软件的 HTTP 或 mixed 监听地址；以下 `7890` 是示例端口，必须替换成实际端口：

```bash
export http_proxy='http://127.0.0.1:7890'
export https_proxy="$http_proxy"
export HTTP_PROXY="$http_proxy"
export HTTPS_PROXY="$http_proxy"
```

设置后重新执行上面的代理参数收集及 Python 依赖阶段验证。

若使用远程或 `docker-container` 构建器，`host` 指构建器所在的网络环境，需确认它能够访问代理地址；此时不能直接套用宿主机回环地址。如果提示不允许 `network.host`，需要调整所选构建器的网络或授权，或改用构建器能够访问的 HTTP 代理地址。

以上参数控制构建步骤的联网，不会更改服务容器的运行网络。基础镜像拉取阶段仍由 Docker daemon／BuildKit 自身的网络及代理配置决定。
