#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'HELP'
用法：bash scripts/build-image.sh [选项]

构建 World、Control、Console 和 Agent 镜像并导出部署包，自动传递终端代理变量。

  --arch amd64|arm64   目标 CPU 架构，默认 amd64
  --image NAME:TAG     自定义 World 镜像名，默认使用 Git 短号和时间生成
  --network MODE      host、default 或 none；Linux 默认 host，其他系统默认 default
  -h, --help          显示帮助

可用 PIP_INDEX_URL 和 NPM_REGISTRY 环境变量覆盖依赖下载源。
部署包输出到 .3dbox/releases/，成功后打印完整路径。
HELP
}

require_value() {
  if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then
    printf '选项 %s 需要一个值。\n' "$1" >&2
    exit 2
  fi
}

release_arch=amd64
release_image=''
build_network=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) require_value "$@"; release_arch="$2"; shift 2 ;;
    --image) require_value "$@"; release_image="$2"; shift 2 ;;
    --network) require_value "$@"; build_network="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知选项：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$release_arch" in
  amd64|arm64) ;;
  *) printf '不支持的目标架构：%s\n' "$release_arch" >&2; exit 2 ;;
esac
if [[ -z "$build_network" ]]; then
  if [[ "$(uname -s)" == Linux ]]; then build_network=host; else build_network=default; fi
fi
case "$build_network" in
  host|default|none) ;;
  *) printf '不支持的网络模式：%s\n' "$build_network" >&2; exit 2 ;;
esac

for build_command in docker git tar gzip mktemp od tr; do
  if ! command -v "$build_command" >/dev/null 2>&1; then
    printf '缺少命令：%s\n' "$build_command" >&2
    exit 1
  fi
done
if command -v sha256sum >/dev/null 2>&1; then
  release_sha() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then
  release_sha() { shasum -a 256 "$@"; }
else
  printf '缺少 SHA-256 工具：请安装 sha256sum 或 shasum。\n' >&2
  exit 1
fi
docker buildx version >/dev/null

build_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$build_root"
source_commit="$(git rev-parse HEAD)"
source_dirty=false
if [[ -n "$(git status --porcelain)" ]]; then source_dirty=true; fi
release_id="$(git rev-parse --short=12 HEAD)-$(date +%Y%m%d-%H%M%S)-$$"
release_platform="linux/${release_arch}"
release_name="3dbox4agent-${release_id}-linux-${release_arch}"
release_dir="$build_root/.3dbox/releases/$release_name"
release_archive="${release_dir}.tar.gz"
release_checksum="${release_archive}.sha256"
if [[ -z "$release_image" ]]; then release_image="${release_name}:world-rust"; fi
release_control_image="${release_name}:control"
release_console_image="${release_name}:console"
release_agent_image="${release_name}:agent"
for package_source in "$build_root/deploy/compose.runtime.yaml" "$build_root/deploy/README.md"; do
  if [[ ! -f "$package_source" ]]; then
    printf '缺少部署模板：%s\n' "$package_source" >&2
    exit 1
  fi
done
for package_output in "$release_dir" "$release_archive" "$release_checksum"; do
  if [[ -e "$package_output" ]]; then
    printf '输出已存在：%s\n' "$package_output" >&2
    exit 1
  fi
done

build_args=(
  buildx build
  --platform "$release_platform"
  --load
  --progress=plain
  --network "$build_network"
  --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL:-https://pypi.org/simple}"
  --build-arg "NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org}"
)
if [[ "$build_network" == host ]]; then build_args+=(--allow=network.host); fi
for build_proxy_key in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do
  if printenv "$build_proxy_key" >/dev/null; then
    build_args+=(--build-arg "$build_proxy_key")
  fi
done

build_release_image() {
  local image="$1" dockerfile="$2"
  shift 2
  printf '构建镜像：%s\n' "$image"
  docker "${build_args[@]}" --file "$dockerfile" -t "$image" "$@" .
}

release_image_id_for() {
  local image="$1" actual_platform
  actual_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
  if [[ "$actual_platform" != "$release_platform" ]]; then
    printf '镜像 %s 平台不匹配：期望 %s，实际 %s\n' "$image" "$release_platform" "$actual_platform" >&2
    return 1
  fi
  docker image inspect --format '{{.Id}}' "$image"
}

printf '目标平台：%s\n构建网络：%s\n' "$release_platform" "$build_network"
build_release_image "$release_image" packages/world/Dockerfile --target world-rust
release_image_id="$(release_image_id_for "$release_image")"
build_release_image "$release_control_image" packages/control-server/Dockerfile
release_control_id="$(release_image_id_for "$release_control_image")"
build_release_image "$release_console_image" packages/console/Dockerfile
release_console_id="$(release_image_id_for "$release_console_image")"
build_release_image "$release_agent_image" packages/agent/Dockerfile
release_agent_id="$(release_image_id_for "$release_agent_image")"

build_stage=''
build_env_tmp=''
cleanup() {
  if [[ -n "$build_stage" ]]; then rm -rf -- "$build_stage"; fi
  if [[ -n "$build_env_tmp" ]]; then rm -f -- "$build_env_tmp"; fi
}
trap cleanup EXIT

mkdir -p "$build_root/.3dbox/releases"
build_stage="$(mktemp -d "$build_root/.3dbox/releases/.package.XXXXXX")"
package_dir="$build_stage/$release_name"
mkdir "$package_dir"
cp "$build_root/deploy/compose.runtime.yaml" "$package_dir/compose.yaml"
cp "$build_root/deploy/README.md" "$package_dir/README.md"
chmod 700 "$package_dir"
runner_operator_token="$(od -An -v -N32 -tx1 /dev/urandom | tr -d '[:space:]')"
cat > "$package_dir/.env" <<ENV
BOX_IMAGE=$release_image
BOX_CONTROL_IMAGE=$release_control_image
BOX_CONSOLE_IMAGE=$release_console_image
BOX_AGENT_IMAGE=$release_agent_image
BOX_PLATFORM=$release_platform
BOX_HTTP_BIND=0.0.0.0
BOX_HTTP_PORT=8787
BOX_WORLD_WORKERS=2
BOX_RUNNER_OPERATOR_TOKEN=$runner_operator_token
ENV
chmod 600 "$package_dir/.env"
cat > "$package_dir/RELEASE.txt" <<RELEASE
source_commit=$source_commit
source_dirty=$source_dirty
platform=$release_platform
image=$release_image
image_id=$release_image_id
control_image=$release_control_image
control_image_id=$release_control_id
console_image=$release_console_image
console_image_id=$release_console_id
agent_image=$release_agent_image
agent_image_id=$release_agent_id
RELEASE

printf '\n正在导出镜像并生成部署压缩包……\n'
docker image save "$release_image" "$release_control_image" "$release_console_image" "$release_agent_image" | gzip -1 > "$package_dir/image.tar.gz"
(
  cd "$package_dir"
  release_sha image.tar.gz compose.yaml .env README.md RELEASE.txt > SHA256SUMS
)
tar -cf - -C "$build_stage" "$release_name" | gzip -1 > "$build_stage/$release_name.tar.gz"
chmod 600 "$build_stage/$release_name.tar.gz"
(
  cd "$build_stage"
  release_sha "$release_name.tar.gz" > "$release_name.tar.gz.sha256"
)

mv "$package_dir" "$release_dir"
mv "$build_stage/$release_name.tar.gz" "$release_archive"
mv "$build_stage/$release_name.tar.gz.sha256" "$release_checksum"

build_result_dir="$build_root/.3dbox/builds"
mkdir -p "$build_result_dir"
build_env_tmp="$(mktemp "$build_result_dir/.last-build.env.XXXXXX")"
{
  printf 'source_commit=%q\n' "$source_commit"
  printf 'source_dirty=%q\n' "$source_dirty"
  printf 'release_id=%q\n' "$release_id"
  printf 'release_arch=%q\n' "$release_arch"
  printf 'release_platform=%q\n' "$release_platform"
  printf 'release_name=%q\n' "$release_name"
  printf 'release_image=%q\n' "$release_image"
  printf 'release_control_image=%q\n' "$release_control_image"
  printf 'release_console_image=%q\n' "$release_console_image"
  printf 'release_agent_image=%q\n' "$release_agent_image"
  printf 'release_dir=%q\n' "$release_dir"
  printf 'release_archive=%q\n' "$release_archive"
  printf 'release_checksum=%q\n' "$release_checksum"
} > "$build_env_tmp"
mv -f -- "$build_env_tmp" "$build_result_dir/last-build.env"

printf '\n构建及打包完成。\n镜像：%s\n部署包：%s\n校验文件：%s\n' "$release_image" "$release_archive" "$release_checksum"
