#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'HELP'
用法：bash scripts/build-image.sh [选项]

构建并加载 world-rust 镜像，自动传递终端已导出的代理变量。

  --arch amd64|arm64   目标 CPU 架构，默认 amd64
  --image NAME:TAG     自定义镜像名，默认使用 Git 短号和时间生成
  --network MODE      host、default 或 none；Linux 默认 host，其他系统默认 default
  -h, --help          显示帮助

可用 PIP_INDEX_URL 和 NPM_REGISTRY 环境变量覆盖依赖下载源。
成功后将打包所需变量保存到 .3dbox/builds/last-build.env。
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

for build_command in docker git; do
  if ! command -v "$build_command" >/dev/null 2>&1; then
    printf '缺少命令：%s\n' "$build_command" >&2
    exit 1
  fi
done
docker buildx version >/dev/null

build_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$build_root"
source_commit="$(git rev-parse HEAD)"
release_id="$(git rev-parse --short=12 HEAD)-$(date +%Y%m%d-%H%M%S)"
release_platform="linux/${release_arch}"
release_name="3dbox4agent-${release_id}-linux-${release_arch}"
release_dir="$build_root/.3dbox/releases/$release_name"
if [[ -z "$release_image" ]]; then release_image="${release_name}:world-rust"; fi

build_args=(
  buildx build
  --platform "$release_platform"
  --target world-rust
  --load
  --progress=plain
  --network "$build_network"
  --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL:-https://pypi.org/simple}"
  --build-arg "NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org}"
  -t "$release_image"
)
if [[ "$build_network" == host ]]; then build_args+=(--allow=network.host); fi
for build_proxy_key in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; do
  if printenv "$build_proxy_key" >/dev/null; then
    build_args+=(--build-arg "$build_proxy_key")
  fi
done

printf '构建镜像：%s\n目标平台：%s\n构建网络：%s\n' "$release_image" "$release_platform" "$build_network"
docker "${build_args[@]}" .

build_result_dir="$build_root/.3dbox/builds"
mkdir -p "$build_result_dir"
build_env_tmp="$(mktemp "$build_result_dir/.last-build.env.XXXXXX")"
trap 'rm -f -- "$build_env_tmp"' EXIT
{
  printf 'source_commit=%q\n' "$source_commit"
  printf 'release_id=%q\n' "$release_id"
  printf 'release_arch=%q\n' "$release_arch"
  printf 'release_platform=%q\n' "$release_platform"
  printf 'release_name=%q\n' "$release_name"
  printf 'release_image=%q\n' "$release_image"
  printf 'release_dir=%q\n' "$release_dir"
} > "$build_env_tmp"
mv -f -- "$build_env_tmp" "$build_result_dir/last-build.env"

printf '\n构建完成：%s\n后续打包前加载变量：\n  source %q\n' "$release_image" "$build_result_dir/last-build.env"
