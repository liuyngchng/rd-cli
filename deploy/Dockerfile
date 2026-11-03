# syntax=docker/dockerfile:1

# ============================================================================
# Stage 1 – build rdcli from local source
# ============================================================================
FROM ubuntu:24.04 AS rdcli-builder

# ---- Proxy support (apt + npm in this stage) -------------------------------
# Proxy is needed at BUILD time only. We use ARG (not ENV) so the proxy
# variables are never baked into the final image — the runtime container must
# reach llm_net / the public internet directly, not through the build proxy.
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY=""
# Lowercase variants: pip ignores the uppercase HTTP_PROXY var for security
# (httpoxy), so provide the lowercase forms too, derived from the build args.
ARG http_proxy="$HTTP_PROXY"
ARG https_proxy="$HTTPS_PROXY"
ARG no_proxy="$NO_PROXY"

RUN if [ -n "$HTTP_PROXY" ]; then \
        echo 'Acquire::http::Proxy "'$HTTP_PROXY'";' > /etc/apt/apt.conf.d/01proxy; \
    fi; \
    if [ -n "$HTTPS_PROXY" ]; then \
        echo 'Acquire::https::Proxy "'$HTTPS_PROXY'";' >> /etc/apt/apt.conf.d/01proxy; \
    fi

# Build tools for native npm modules (better-sqlite3, bcrypt, node-pty)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential python3 python3-setuptools

# Node.js from local tarball
COPY deploy/node-v22.23.2-linux-x64.tar.xz /tmp/
RUN tar -xJf /tmp/node-v22.23.2-linux-x64.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node-v22.23.2-linux-x64.tar.xz

# Skip Electron binary download (not needed for server build)
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Install all dependencies + build
WORKDIR /build
COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund \
    && npm run build

# ============================================================================
# Stage 2 – final runtime image
# ============================================================================
FROM ubuntu:24.04

# ---- Proxy support (apt + npm + pip in this stage) -------------------------
# Proxy is needed at BUILD time only. ARG (not ENV) — never baked into the
# final image. Lowercase variants are provided for pip (httpoxy — pip ignores
# the uppercase HTTP_PROXY for security).
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY=""
ARG http_proxy="$HTTP_PROXY"
ARG https_proxy="$HTTPS_PROXY"
ARG no_proxy="$NO_PROXY"

RUN if [ -n "$HTTP_PROXY" ]; then \
        echo 'Acquire::http::Proxy "'$HTTP_PROXY'";' > /etc/apt/apt.conf.d/01proxy; \
    fi; \
    if [ -n "$HTTPS_PROXY" ]; then \
        echo 'Acquire::https::Proxy "'$HTTPS_PROXY'";' >> /etc/apt/apt.conf.d/01proxy; \
    fi

# ---------------------------------------------------------------------------
# Locale, timezone & misc
# ---------------------------------------------------------------------------
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Asia/Shanghai \
    NODE_TLS_REJECT_UNAUTHORIZED=0

# ============================================================================
# Root phase — install system packages & Node.js, then switch to rdcli
# ============================================================================

# ---- System dependencies (apt) ---------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    python3 \
    python3-pip \
    python3-setuptools \
    virtualenv \
    pandoc \
    ffmpeg \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    libreoffice-draw \
    jq \
    ripgrep \
    sqlite3 \
    zip \
    unzip \
    tree \
    vim-tiny

# ---- Node.js – installed system-wide, readable by all users ----------------
COPY deploy/node-v22.23.2-linux-x64.tar.xz /tmp/
RUN tar -xJf /tmp/node-v22.23.2-linux-x64.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node-v22.23.2-linux-x64.tar.xz

# ---- Runtime user -----------------------------------------------------------
# Ubuntu 24.04 ships with a default 'ubuntu' user (UID 1000). Remove it so we
# can reuse UID 1000 for rdcli.
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -r -m -d /home/rdcli -u 1000 -s /bin/bash rdcli \
    && mkdir -p /home/rdcli/.claude && chown rdcli:rdcli /home/rdcli/.claude

# ============================================================================
# rdcli phase — everything below runs as rdcli, all files naturally owned
# ============================================================================
USER rdcli
ENV HOME=/home/rdcli \
    NPM_CONFIG_PREFIX=/home/rdcli/.npm-global

ENV PATH=/home/rdcli/llm_py_env/bin:/home/rdcli/.npm-global/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/sbin:/bin

# ---- Claude Code global memory – office document assistant role -------------
COPY --chown=rdcli:rdcli deploy/CLAUDE.md /home/rdcli/.claude/CLAUDE.md

# ---- Python virtualenv – Office document processing -------------------------
# Set PIP_OFFLINE_=1 to install from pre-downloaded packages offline
# (build.sh pip_download_dir=<dir> does this automatically).
ARG PIP_OFFLINE_=""
COPY --chown=rdcli:rdcli deploy/requirements.txt /tmp/requirements.txt

# Pre-downloaded pip packages (build.sh populates deploy/.pip-offline/ when
# pip_download_dir=<dir> is given; otherwise it contains only a .gitkeep).
COPY --chown=rdcli:rdcli deploy/.pip-offline/ /tmp/.pip-offline/

RUN virtualenv /home/rdcli/llm_py_env

# Offline path: install from local packages, no network needed.
RUN if [ -n "$PIP_OFFLINE_" ] && ls /tmp/.pip-offline/*.whl /tmp/.pip-offline/*.tar.gz 2>/dev/null; then \
      echo "Pip offline install from /tmp/.pip-offline"; \
      /home/rdcli/llm_py_env/bin/pip install \
        --no-index \
        --find-links /tmp/.pip-offline \
        -r /tmp/requirements.txt; \
    fi

# Online path (skipped when offline install succeeded above).
RUN --mount=type=cache,target=/home/rdcli/.cache/pip,uid=1000,gid=1000 \
    if [ -z "$PIP_OFFLINE_" ] || ! ls /tmp/.pip-offline/*.whl /tmp/.pip-offline/*.tar.gz 2>/dev/null; then \
      /home/rdcli/llm_py_env/bin/pip install -r /tmp/requirements.txt; \
    fi

RUN rm -rf /tmp/.pip-offline /tmp/requirements.txt

# ---- Claude Code CLI --------------------------------------------------------
# When build.sh finds a host-installed claude binary, it copies it into
# deploy/claude-code/ and sets CLAUDE_CODE_OFFLINE=1 — offline install.
# Otherwise falls back to `npm install -g` (requires network).
ARG CLAUDE_CODE_OFFLINE=""
COPY --chown=rdcli:rdcli deploy/claude-code/ /tmp/claude-code/

# Offline path: use the host-provided binary, no network.
RUN if [ -n "$CLAUDE_CODE_OFFLINE" ] && [ -f /tmp/claude-code/claude ]; then \
      echo "Installing Claude Code CLI from local binary"; \
      mkdir -p /home/rdcli/.npm-global/bin; \
      cp /tmp/claude-code/claude /home/rdcli/.npm-global/bin/claude; \
      chmod +x /home/rdcli/.npm-global/bin/claude; \
    fi

# Online fallback path (skipped when the binary was installed above).
RUN --mount=type=cache,target=/home/rdcli/.npm,uid=1000,gid=1000 \
    if [ -z "$CLAUDE_CODE_OFFLINE" ] || [ ! -f /tmp/claude-code/claude ]; then \
      echo "Claude Code CLI local binary not found, falling back to npm install"; \
      npm install -g @anthropic-ai/claude-code \
        --fetch-retries=5 \
        --fetch-retry-mintimeout=20000 \
        --fetch-retry-maxtimeout=120000 \
        --fetch-timeout=600000 \
        --no-audit \
        --no-fund; \
    fi

RUN rm -rf /tmp/claude-code

# ---- rdCLI – built from local source (Stage 1), never published to npm ------
COPY --chown=rdcli:rdcli --from=rdcli-builder /build/dist        /home/rdcli/rdcli/dist
COPY --chown=rdcli:rdcli --from=rdcli-builder /build/dist-server /home/rdcli/rdcli/dist-server
COPY --chown=rdcli:rdcli --from=rdcli-builder /build/public      /home/rdcli/rdcli/public
COPY --chown=rdcli:rdcli --from=rdcli-builder /build/shared      /home/rdcli/rdcli/shared
COPY --chown=rdcli:rdcli --from=rdcli-builder /build/package.json      /home/rdcli/rdcli/
COPY --chown=rdcli:rdcli --from=rdcli-builder /build/package-lock.json /home/rdcli/rdcli/
COPY --chown=rdcli:rdcli --from=rdcli-builder /build/scripts/fix-node-pty.js /home/rdcli/rdcli/scripts/

WORKDIR /home/rdcli/rdcli

# Install production dependencies + compile native modules
RUN --mount=type=cache,target=/home/rdcli/.npm,uid=1000,gid=1000 \
    npm ci --omit=dev --no-audit --no-fund

# Wire up the rdcli command
# (tsc emits cli.js with 0644 perms and no exec bit – chmod it so runc can exec it)
RUN chmod +x /home/rdcli/rdcli/dist-server/server/modules/cli/cli.js \
    && mkdir -p /home/rdcli/.npm-global/bin /home/rdcli/workspace \
    && ln -s /home/rdcli/rdcli/dist-server/server/modules/cli/cli.js \
          /home/rdcli/.npm-global/bin/rdcli

# ---------------------------------------------------------------------------
# HTTPS certs (self-signed, generated by build.sh)
# ---------------------------------------------------------------------------
# Certs live under /home/rdcli/.rdcli-certs, outside the runtime data dir
# (~/.rdcli), so they stay cleanly separated from user data.
ARG HTTPS_CERT=""
COPY --chown=rdcli:rdcli deploy/certs/ /tmp/rdcli-certs/
RUN if [ -n "$HTTPS_CERT" ] && [ -f /tmp/rdcli-certs/cert.pem ]; then \
      mkdir -p /home/rdcli/.rdcli-certs && \
      cp /tmp/rdcli-certs/cert.pem /tmp/rdcli-certs/key.pem /home/rdcli/.rdcli-certs/; \
    fi && \
    rm -rf /tmp/rdcli-certs
ENV RDCLI_HTTPS_CERT=/home/rdcli/.rdcli-certs/cert.pem \
    RDCLI_HTTPS_KEY=/home/rdcli/.rdcli-certs/key.pem

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
WORKDIR /home/rdcli/workspace
EXPOSE 3001

CMD ["/home/rdcli/.npm-global/bin/rdcli"]