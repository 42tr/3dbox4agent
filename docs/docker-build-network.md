# Docker 构建网络与代理

`pip` 报 `Network is unreachable` 表示构建环境无法连到依赖下载地址。紧接着的 `No matching distribution found for wheel` 可能是读取索引失败的结果，应先检查前面的连接错误。Rust 步骤被标为 `CANCELED` 表示构建整体中止，不能据此认定 Rust 编译失败。

宿主机、Docker daemon 和构建容器的代理设置分别生效。为构建内的 npm、pip、Cargo、apt 提供代理时，使用 Docker 的预定义 `HTTP_PROXY`、`HTTPS_PROXY` 构建参数，具体行为见 [Docker 代理配置文档](https://docs.docker.com/engine/cli/proxy/)。这些参数无需写入 Dockerfile。

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
