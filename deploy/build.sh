#!/bin/bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Build script for rd-cli Docker image
#
# Includes:
#   - Node.js v22.23.2 + Claude Code CLI + rdCLI web UI
#   - Python virtualenv /home/rdcli/llm_py_env (Office doc processing: Word, PDF, Excel, PPT)
#   - LibreOffice (doc → docx conversion)
#
# Usage:
#   ./build.sh                          # Version from package.json, fallback to "1.0"
#   ./build.sh 2.0                      # Explicit version (positional)
#   VERSION=2.0 ./build.sh              # Via environment variable
#
# Proxy (optional; falls back to environment variables):
#   http_proxy=<url>        HTTP proxy for apt/npm/pip/docker
#   https_proxy=<url>       HTTPS proxy
#   no_proxy=<url>          Comma-separated list of hosts to bypass
#
#   ./build.sh http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890
#
# Pip offline install (optional; speeds up repeated builds on poor networks):
#   pip_download_dir=<dir>  Local directory holding .whl packages for pip.
#                           Before build: pip download --dest <dir> uses proxy
#                           to sync missing packages. During build: pip installs
#                           from <dir> offline (--no-index --find-links), no
#                           network needed.
#
#   ./build.sh pip_download_dir=/media/rd/SD2TB/whl_py_dir_docx
#
#   Falls back to PIP_DOWNLOAD_DIR env var if set:
#   PIP_DOWNLOAD_DIR=/media/rd/SD2TB/whl_py_dir_docx ./build.sh
# ---------------------------------------------------------------------------

# 计时起点：统计整个 build.sh 的墙钟耗时（含 pip 同步、证书生成、docker build、镜像清理）。
BUILD_START=$SECONDS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-rd-cli}"
PIP_OFFLINE_STAGING="${SCRIPT_DIR}/.pip-offline"

# ── Usage ────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
用法: ./build.sh [version] [pip_download_dir=<dir>] [proxy...]

参数说明:
  version                 镜像版本号（位置参数，如 2.0）
  -h | --help             显示本帮助并退出

Pip 离线目录（可选；网络差时推荐，之后构建跳过所有 pip 下载）:
  pip_download_dir=<dir>  本地 .whl 存放目录；构建前先 pip download 补齐，
                          构建时完全离线安装。

代理参数（可选，不带 = 时继承环境变量）:
  http_proxy=<url>        设置 HTTP 代理
  https_proxy=<url>       设置 HTTPS 代理
  no_proxy=<url>          设置不走代理的地址列表

示例:
  ./build.sh 1.0.1 pip_download_dir=/media/rd/SD2TB/whl_py_dir_docx http_proxy=http://127.0.0.1:7890
  VERSION=1.0.1 ./build.sh
EOF
}

# ── 参数解析 ────────────────────────────────────────────────────
TAG_VERSION=""
HTTP_PROXY_VAL=""
HTTPS_PROXY_VAL=""
NO_PROXY_VAL=""
PIP_DOWNLOAD_DIR_VAL=""

for arg in "$@"; do
  case "$arg" in
    http_proxy=*|HTTP_PROXY=*)        HTTP_PROXY_VAL="${arg#*=}" ;;
    https_proxy=*|HTTPS_PROXY=*)      HTTPS_PROXY_VAL="${arg#*=}" ;;
    no_proxy=*|NO_PROXY=*)            NO_PROXY_VAL="${arg#*=}" ;;
    pip_download_dir=*|PIP_DOWNLOAD_DIR=*) PIP_DOWNLOAD_DIR_VAL="${arg#*=}" ;;
    -h|--help|help)                   usage; exit 0 ;;
    -*)                               echo "WARNING: 未知参数 '$arg'，已忽略（用 -h 查看用法）" ;;
    *)                                TAG_VERSION="$arg" ;;
  esac
done

# ---- Resolve version -------------------------------------------------------
# Priority: $VERSION env > positional arg > package.json > "1.0"
if [ -z "$TAG_VERSION" ]; then
  if [ -n "${VERSION:-}" ]; then
    TAG_VERSION="$VERSION"
  else
    PKG_JSON="$PROJECT_ROOT/package.json"
    if [ -f "$PKG_JSON" ]; then
      TAG_VERSION=$(node -e "process.stdout.write(require('$PKG_JSON').version)" 2>/dev/null) || true
    fi
    TAG_VERSION="${TAG_VERSION:-1.0}"
  fi
fi

# 不带 = 时继承环境变量
HTTP_PROXY_VAL="${HTTP_PROXY_VAL:-${HTTP_PROXY:-${http_proxy:-}}}"
HTTPS_PROXY_VAL="${HTTPS_PROXY_VAL:-${HTTPS_PROXY:-${https_proxy:-}}}"
NO_PROXY_VAL="${NO_PROXY_VAL:-${NO_PROXY:-${no_proxy:-}}}"
PIP_DOWNLOAD_DIR_VAL="${PIP_DOWNLOAD_DIR_VAL:-${PIP_DOWNLOAD_DIR:-}}"

# ---- Interactive pip offline dir prompt (only when not already set) ----------
PIP_LAST_DIR_FILE="${SCRIPT_DIR}/.last-pip-dir"

# Restore last used directory as suggestion
PIP_SUGGESTED_DIR=""
if [[ -f "$PIP_LAST_DIR_FILE" ]]; then
  PIP_SUGGESTED_DIR="$(head -1 "$PIP_LAST_DIR_FILE")"
fi
# Fallback: if a known directory exists, suggest it
if [[ -z "$PIP_SUGGESTED_DIR" ]] || [[ ! -d "$PIP_SUGGESTED_DIR" ]]; then
  for guess in /media/rd/SD2TB/whl_py_dir_docx; do
    if [[ -d "$guess" ]]; then
      PIP_SUGGESTED_DIR="$guess"
      break
    fi
  done
fi

if [[ -z "$PIP_DOWNLOAD_DIR_VAL" ]] && [[ -t 0 ]]; then
  echo ""
  echo -n "使用 pip 离线目录？ [y/n]: "
  read -r USER_CHOICE
  case "$USER_CHOICE" in
    n|N|no|No|NO)
      echo " → 跳过离线目录，pip 将在线安装"
      ;;
    y|Y|yes|Yes|YES)
      if [[ -n "$PIP_SUGGESTED_DIR" ]]; then
        read -e -i "$PIP_SUGGESTED_DIR" -r -p "pip 离线目录路径: " PIP_DOWNLOAD_DIR_VAL
      else
        read -r -p "pip 离线目录路径: " PIP_DOWNLOAD_DIR_VAL
      fi
      echo " → 使用: $PIP_DOWNLOAD_DIR_VAL"
      ;;
    *)
      # Treat any non-n input as a direct path
      PIP_DOWNLOAD_DIR_VAL="$USER_CHOICE"
      echo " → 使用: $PIP_DOWNLOAD_DIR_VAL"
      ;;
  esac
fi

# Persist the chosen directory for next time
if [[ -n "$PIP_DOWNLOAD_DIR_VAL" ]]; then
  echo "$PIP_DOWNLOAD_DIR_VAL" > "$PIP_LAST_DIR_FILE"
fi

# 自动补全 scheme（裸 IP:端口 → http://IP:端口）
add_scheme() {
  local v="$1"
  [[ -z "$v" || "$v" == *"://"* ]] && { printf '%s' "$v"; return; }
  printf 'http://%s' "$v"
}
HTTP_PROXY_VAL="$(add_scheme "$HTTP_PROXY_VAL")"
HTTPS_PROXY_VAL="$(add_scheme "$HTTPS_PROXY_VAL")"

FULL_TAG="${IMAGE_NAME}:${TAG_VERSION}"

echo "============================================"
echo " Building ${FULL_TAG}"
echo "============================================"
if [[ -n "$HTTP_PROXY_VAL" || -n "$HTTPS_PROXY_VAL" ]]; then
  echo " 代理: http=$HTTP_PROXY_VAL https=$HTTPS_PROXY_VAL no_proxy=$NO_PROXY_VAL"
fi
if [[ -n "$PIP_DOWNLOAD_DIR_VAL" ]]; then
  echo " Pip 离线目录: $PIP_DOWNLOAD_DIR_VAL"
fi
echo ""

# ---- Docker build args -----------------------------------------------------
DOCKER_BUILD_ARGS=()
if [[ -n "$HTTP_PROXY_VAL" || -n "$HTTPS_PROXY_VAL" ]]; then
  DOCKER_BUILD_ARGS=(
    --build-arg "HTTP_PROXY=$HTTP_PROXY_VAL"
    --build-arg "HTTPS_PROXY=$HTTPS_PROXY_VAL"
    --build-arg "NO_PROXY=$NO_PROXY_VAL"
  )
fi

# ---- Pip offline preparation ------------------------------------------------
cleanup_pip_offline_staging() {
  if [[ -d "$PIP_OFFLINE_STAGING" ]]; then
    rm -rf "$PIP_OFFLINE_STAGING"
  fi
}

if [[ -n "$PIP_DOWNLOAD_DIR_VAL" ]]; then
  # Validate the directory exists
  if [[ ! -d "$PIP_DOWNLOAD_DIR_VAL" ]]; then
    echo "ERROR: pip_download_dir 目录不存在: $PIP_DOWNLOAD_DIR_VAL"
    exit 1
  fi

  # Sync packages: download any missing .whl /.tar.gz files
  REQUIREMENTS_TXT="${SCRIPT_DIR}/requirements.txt"
  if [[ ! -f "$REQUIREMENTS_TXT" ]]; then
    echo "ERROR: requirements.txt not found: $REQUIREMENTS_TXT"
    exit 1
  fi

  echo "=== Pip download: 同步离线包到 $PIP_DOWNLOAD_DIR_VAL ==="
  # Export proxy for pip download to use
  if [[ -n "$HTTP_PROXY_VAL" ]]; then
    export HTTP_PROXY="$HTTP_PROXY_VAL" HTTPS_PROXY="$HTTPS_PROXY_VAL"
    export http_proxy="$HTTP_PROXY_VAL" https_proxy="$HTTPS_PROXY_VAL"
  fi
  pip download \
    --dest "$PIP_DOWNLOAD_DIR_VAL" \
    --exists-action i \
    -r "$REQUIREMENTS_TXT" \
    --prefer-binary \
    --timeout 120 \
    --retries 5 \
    ${NO_PROXY_VAL:+--proxy ""} \
    || {
    echo "ERROR: pip download 失败。请检查网络 / 代理设置"
    exit 1
  }
  echo ""

  # Copy to a staging directory inside the Docker build context
  cleanup_pip_offline_staging
  mkdir -p "$PIP_OFFLINE_STAGING"
  cp -a "$PIP_DOWNLOAD_DIR_VAL"/* "$PIP_OFFLINE_STAGING/"
  echo "Pip 离线包已准备: $PIP_OFFLINE_STAGING ($(ls "$PIP_OFFLINE_STAGING" | wc -l) 个文件)"
  echo ""

  # Tell Dockerfile to use offline install
  DOCKER_BUILD_ARGS+=(--build-arg "PIP_OFFLINE_=1")
else
  # Ensure the staging directory exists so the Dockerfile COPY doesn't fail.
  # A .gitkeep placeholder keeps the directory non-empty when no offline
  # packages are present.
  cleanup_pip_offline_staging
  mkdir -p "$PIP_OFFLINE_STAGING"
  touch "$PIP_OFFLINE_STAGING/.gitkeep"
fi

# ---- Claude Code CLI local binary sync --------------------------------------
# The Claude Code CLI is a ~280MB native binary. Rather than `npm install -g`
# (which downloads from the network each build), we copy it from the host's
# installed copy into the deploy context so the Dockerfile can install offline.
# Source: host-global install (linuxbrew / nvm / npm -g).
CLAUDE_CODE_SRC=""
for candidate in \
  "$(command -v claude 2>/dev/null)" \
  "/home/linuxbrew/.linuxbrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude" \
  "$HOME/.nvm/versions/node/$(node -v 2>/dev/null | tr -d v)/lib/node_modules/@anthropic-ai/claude-code/bin/claude"; do
  if [[ -n "$candidate" && -f "$candidate" ]]; then
    CLAUDE_CODE_SRC="$candidate"
    break
  fi
done

CLAUDE_CODE_STAGING="${SCRIPT_DIR}/claude-code"

if [[ -z "$CLAUDE_CODE_SRC" ]]; then
  echo "WARNING: 未找到本地 claude-code，将回退到镜像内 npm install（需联网）"
  # Ensure directory exists so Dockerfile COPY doesn't fail; .gitkeep placeholder.
  mkdir -p "$CLAUDE_CODE_STAGING"
  touch "$CLAUDE_CODE_STAGING/.gitkeep"
else
  mkdir -p "$CLAUDE_CODE_STAGING"
  cp -f "$CLAUDE_CODE_SRC" "$CLAUDE_CODE_STAGING/claude"
  chmod +x "$CLAUDE_CODE_STAGING/claude"
  echo "Claude Code CLI 已本地化: $CLAUDE_CODE_STAGING/claude ($(du -h "$CLAUDE_CODE_STAGING/claude" | cut -f1))"
  DOCKER_BUILD_ARGS+=(--build-arg "CLAUDE_CODE_OFFLINE=1")
fi

# ---- Self-signed certificate for HTTPS ---------------------------------------
# Generated once; reused on subsequent builds.
# RSA 1024-bit key, validity 2 years (730 days).
CERTS_DIR="${SCRIPT_DIR}/certs"
CERT_FILE="${CERTS_DIR}/cert.pem"
KEY_FILE="${CERTS_DIR}/key.pem"

if [[ -f "$CERT_FILE" && -f "$KEY_FILE" ]]; then
  echo "HTTPS 证书已存在，直接使用: $CERTS_DIR/"
else
  echo "=== 生成自签 HTTPS 证书 (RSA 1024, 有效期 2 年) ==="
  mkdir -p "$CERTS_DIR"
  openssl req -x509 -newkey rsa:1024 -nodes \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -days 730 \
    -subj "/C=CN/ST=Beijing/L=Beijing/O=rdCLI/CN=rdcli.local"
  echo "自签证书已生成:"
  echo "  证书: $CERT_FILE"
  echo "  密钥: $KEY_FILE"
  echo "  ⚠  自签证书在浏览器中会显示安全警告，属正常现象。"
fi
echo ""

# Wire certs into the image: Dockerfile copies them under /home/rdcli/.rdcli/https
# when HTTPS_CERT=1 is set.
if [[ -f "$CERT_FILE" && -f "$KEY_FILE" ]]; then
  DOCKER_BUILD_ARGS+=(--build-arg "HTTPS_CERT=1")
fi

# ---- Build ------------------------------------------------------------------
echo "=== Docker build ==="
DOCKER_BUILDKIT=1 docker build \
    "${DOCKER_BUILD_ARGS[@]+"${DOCKER_BUILD_ARGS[@]}"}" \
    -t "${FULL_TAG}" \
    -f "${SCRIPT_DIR}/Dockerfile" \
    "${PROJECT_ROOT}"

cleanup_pip_offline_staging

# Remove dangling (<none>) images left behind when a tag is rebuilt.
echo ""
echo "=== 清理 dangling 镜像 ==="
docker image prune -f --filter "dangling=true" || true

BUILD_ELAPSED=$(( SECONDS - BUILD_START ))
echo "============================================"
echo " Build complete: ${FULL_TAG}"
printf " 总耗时: %dm %ds\n" $(( BUILD_ELAPSED / 60 )) $(( BUILD_ELAPSED % 60 ))
echo "============================================"
echo ""
echo "Run with:"
echo ""
echo "  ./deploy.sh"
echo ""