#!/usr/bin/env bash
# 跨平台构建 text_router Docker 镜像（默认 linux/amd64 + linux/arm64）
# 用法见 README「Docker 部署与打包」，或 scripts/build-docker.sh --help
set -euo pipefail

PLATFORMS="linux/amd64,linux/arm64"
TAGS=() # 可重复 -t 指定多个标签，如 -t ...:1.0.0 -t ...:latest
MODE="build" # build：只构建验证（结果进构建缓存）；push：推送到仓库；load：载入本地 Docker
NO_CACHE=""
# 部分仓库（如阿里云个人版）不认识 buildx 默认附加的 OCI attestation 清单，
# 报 unknown manifest class；关闭 provenance 保证兼容
PROVENANCE="--provenance=false"

usage() {
  cat <<'EOF'
用法：scripts/build-docker.sh [选项]

选项：
  -t, --tag TAG      镜像名，可重复指定多个标签（默认 text-router:latest；推送时写成 registry.example.com/命名空间/名字:版本）
  --platform LIST    目标平台，逗号分隔（默认 linux/amd64,linux/arm64）
  --push             构建后推送到镜像仓库（需配合 -t 指定仓库地址）
  --load             只构建本机架构并载入本地 Docker（试跑用；不能与 --push 同用，不能多平台）
  --no-cache         不使用构建缓存
  -h, --help         显示本帮助

示例：
  scripts/build-docker.sh --push -t registry.example.com/text-router:1.0.0 -t registry.example.com/text-router:latest
  scripts/build-docker.sh --load              # 本机试跑
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--tag) TAGS+=("$2"); shift 2 ;;
    --platform) PLATFORMS="$2"; shift 2 ;;
    --push) MODE="push"; shift ;;
    --load) MODE="load"; shift ;;
    --no-cache) NO_CACHE="--no-cache"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ ${#TAGS[@]} -eq 0 ]; then
  TAGS=(text-router:latest)
fi
TAG_ARGS=()
for t in "${TAGS[@]}"; do TAG_ARGS+=(-t "$t"); done

if [[ "$MODE" == "load" && "$PLATFORMS" == *","* ]]; then
  echo "错误：--load 只能构建单一平台（本机架构），请改用 --platform linux/arm64 这类写法" >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || { echo "错误：未找到 docker 命令" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "错误：Docker 缺少 buildx 插件（Docker 19.03+ 一般自带）" >&2; exit 1; }
# 默认构建器（如 Docker Desktop 的 desktop-linux）是 docker 驱动，做不了多平台构建，
# 必须用容器驱动（docker-container）的构建器。一个 buildkit 容器可服务多个项目，
# 所以优先复用机器上已有的容器驱动构建器，一个都没有才创建一个通用的 multiarch。
BUILDER_NAME=$(docker buildx ls 2>/dev/null | awk '$2=="docker-container"{print $1; exit}')
if [ -z "$BUILDER_NAME" ]; then
  BUILDER_NAME="multiarch"
  echo "没有可复用的容器驱动构建器，正在创建 ${BUILDER_NAME}（首次需要下载 buildkit 镜像）…"
  docker buildx create --name "$BUILDER_NAME"
fi
echo "使用构建器：$BUILDER_NAME"
BUILDER="--builder $BUILDER_NAME"

# Linux 主机首次跨架构构建前，需要注册一次 QEMU 模拟器（Docker Desktop 已内置，无需执行）：
#   docker run --rm --privileged tonistiigi/binfmt --install all

cd "$(dirname "$0")/.." # 统一在仓库根目录执行，构建上下文是仓库根

case "$MODE" in
  push)  docker buildx build $BUILDER --platform "$PLATFORMS" $NO_CACHE $PROVENANCE "${TAG_ARGS[@]}" --push . ;;
  load)  docker buildx build $BUILDER --platform "$PLATFORMS" $NO_CACHE $PROVENANCE "${TAG_ARGS[@]}" --load . ;;
  build) docker buildx build $BUILDER --platform "$PLATFORMS" $NO_CACHE $PROVENANCE "${TAG_ARGS[@]}" . ;;
esac

echo "完成：${TAGS[*]}（${PLATFORMS}）"
