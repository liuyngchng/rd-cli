#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 镜像版本号：优先用 VERSION 环境变量，否则从 package.json 读取
IMAGE_VERSION="${VERSION:-}"
if [ -z "$IMAGE_VERSION" ]; then
  PKG_JSON="$PROJECT_ROOT/package.json"
  if [ -f "$PKG_JSON" ]; then
    IMAGE_VERSION=$(node -e "process.stdout.write(require('$PKG_JSON').version)" 2>/dev/null) || true
  fi
  IMAGE_VERSION="${IMAGE_VERSION:-1.0}"
fi
IMAGE_NAME="${IMAGE_NAME:-rd-cli}"

# 容器名，同时也是 llm_net 网络内其它容器解析该服务时使用的 DNS 名。
CONTAINER_NAME=rd-cli

# 宿主机端口映射（host_port:container_port）。下方 PUBLIC_PORT 与 HOST_PORT 保持一致，
# 容器日志才能给出容器外可访问的 URL。
HOST_PORT=19004
CONTAINER_PORT=3001

# 阻断容器内直连 Claude Code 官方/遥测域名，全部指向本地环回。
# API 请求已通过 ANTHROPIC_BASE_URL 走 llm_net 内的 api_adapter_g_app 代理，不受影响；
# 这里只拦截官网、更新、遥测、托管 MCP 等非必需外联，保证离线部署不泄露数据。
ADD_HOSTS=(
    # Anthropic 核心 API / 站点
    api.anthropic.com
    api-staging.anthropic.com
    anthropic.com
    www.anthropic.com
    claude.ai
    claude.com
    platform.claude.com
    mcp-proxy.anthropic.com
    # 更新 / 下载
    downloads.claude.ai
    # 文档 / 状态 / 支持
    code.claude.com
    docs.anthropic.com
    status.anthropic.com
    status.claude.com
    support.anthropic.com
    support.claude.com
    # 遥测 / 分析
    api.datadoghq.com
    browser-intake-us5-datadoghq.com
    http-intake.logs.us5.datadoghq.com
    mcp.amplitude.com
    mcp.intercom.com
    mcp.sentry.dev
    telemetry.googleapis.com
    # 托管 MCP 集成
    microsoft365.mcp.claude.com
    slack.mcp.claude.com
)

# 探测宿主机局域网 IP，用于容器日志中给出容器外可访问的 URL。
detect_host_ip() {
    local ip
    ip="$(ip route get 1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}')"
    if [ -z "$ip" ]; then
        ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    fi
    echo "${ip:-localhost}"
}
PUBLIC_HOST="$(detect_host_ip)"

echo 'stop current container'
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

echo 'ensure network llm_net exists'
docker network create llm_net 2>/dev/null || true

echo 'start container'
# 持久化数据目录: ~/.rdcli (auth.db, users, plugins, logs 等)，映射到项目根目录的 data/rdcli
DATA_DIR="${PROJECT_ROOT}/data/rdcli"
mkdir -p "$DATA_DIR" \
         "${DATA_DIR}/claude-projects"

# 容器内 rdcli 用户 UID=1000 (与 Dockerfile 保持一致)，确保目录权限匹配。
# 若出现权限问题，手动执行: sudo chown -R 1000 "$DATA_DIR"

# 构建 --add-host 参数数组（每个域名同时封 IPv4 和 IPv6）
ADD_HOST_ARGS=()
for d in "${ADD_HOSTS[@]}"; do
    ADD_HOST_ARGS+=(--add-host "$d:127.0.0.1" --add-host "$d:::1")
done

docker run -dit \
    --name "$CONTAINER_NAME" \
    --rm \
    --security-opt seccomp=unconfined \
    --network llm_net \
    "${ADD_HOST_ARGS[@]}" \
    -v "${DATA_DIR}:/home/rdcli/.rdcli" \
    -v "${DATA_DIR}/claude-projects:/home/rdcli/.claude/projects" \
    -w /home/rdcli/workspace \
    -e PUBLIC_HOST="$PUBLIC_HOST" \
    -e PUBLIC_PORT="$HOST_PORT" \
    -e CONTAINER_NAME="$CONTAINER_NAME" \
    -e ANTHROPIC_BASE_URL=http://api_adapter_g_app:16005 \
    -e ANTHROPIC_AUTH_TOKEN=sk-12345 \
    -e API_TIMEOUT_MS=600000 \
    -e ANTHROPIC_MODEL=deepseek-v4-pro \
    -e ANTHROPIC_SMALL_FAST_MODEL=deepseek-v4-pro \
    -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    -e CLAUDE_CODE_ATTRIBUTION_HEADER=0 \
    -p ${HOST_PORT}:${CONTAINER_PORT} \
    ${IMAGE_NAME}:${IMAGE_VERSION}

docker logs -f "$CONTAINER_NAME"
