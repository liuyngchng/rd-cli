#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 容器名，同时也是 llm_net 网络内其它容器解析该服务时使用的 DNS 名。
CONTAINER_NAME=my_rd_cli

# 宿主机端口映射（host_port:container_port）。下方 PUBLIC_PORT 与 HOST_PORT 保持一致，
# 容器日志才能给出容器外可访问的 URL。
HOST_PORT=19004
CONTAINER_PORT=3001

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
docker run -dit \
    --name "$CONTAINER_NAME" \
    --rm \
    --security-opt seccomp=unconfined \
    --network llm_net \
    --add-host api.anthropic.com:127.0.0.1 \
    --add-host "api.anthropic.com:::1" \
    --add-host anthropic.com:127.0.0.1 \
    --add-host "anthropic.com:::1" \
    --add-host claude.ai:127.0.0.1 \
    --add-host "claude.ai:::1" \
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
    -e RDCLI_LOG_LEVEL=debug \
    -p ${HOST_PORT}:${CONTAINER_PORT} \
    rd_cli:1.0.1

docker logs -f "$CONTAINER_NAME"
