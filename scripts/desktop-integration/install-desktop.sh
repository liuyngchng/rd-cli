#!/usr/bin/env bash
# rdCLI Desktop Integration Installer
# 将 AppImage 安装为桌面应用（带图标）
#
# 用法:
#   ./install-desktop.sh                          # 默认路径
#   ./install-desktop.sh /path/to/rdcli.AppImage   # 指定 AppImage 路径
#   ./install-desktop.sh --uninstall               # 卸载

set -euo pipefail

APPIMAGE_DEFAULT="$HOME/workspace/rd-cli/release/desktop/rdcli-desktop-1.0.0-linux-x86_64.AppImage"
APP_ID="ai.rdcli.desktop"
DESKTOP_FILE="$HOME/.local/share/applications/${APP_ID}"
ICON_BASE="$HOME/.local/share/icons/hicolor"

# ---- 颜色输出 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ---- 卸载 ----
do_uninstall() {
    log_info "正在卸载 rdCLI 桌面集成..."
    rm -f "$DESKTOP_FILE"
    for size in 256 128 64 48 32; do
        rm -f "$ICON_BASE/${size}x${size}/apps/rdcli.png"
    done
    command -v update-desktop-database &>/dev/null && update-desktop-database "$HOME/.local/share/applications/" 2>/dev/null || true
    command -v gtk-update-icon-cache &>/dev/null && gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor/" 2>/dev/null || true
    log_info "卸载完成。"
    exit 0
}

# ---- 参数解析 ----
APPIMAGE_PATH=""
case "${1:-}" in
    --uninstall|-u) do_uninstall ;;
    --help|-h)
        echo "用法: $0 [AppImage路径 | --uninstall]"
        echo "  (无参数)    使用默认 AppImage 路径安装"
        echo "  /path/to    指定 AppImage 路径"
        echo "  --uninstall 移除桌面集成"
        exit 0
        ;;
    "") APPIMAGE_PATH="$APPIMAGE_DEFAULT" ;;
    *)  APPIMAGE_PATH="$(realpath "$1")" ;;
esac

# ---- 校验 AppImage ----
if [ ! -f "$APPIMAGE_PATH" ]; then
    log_error "找不到 AppImage: $APPIMAGE_PATH"
    exit 1
fi

if [ ! -x "$APPIMAGE_PATH" ]; then
    log_warn "AppImage 不可执行，正在添加执行权限..."
    chmod +x "$APPIMAGE_PATH"
fi

log_info "AppImage 路径: $APPIMAGE_PATH"

# ---- 提取图标 ----
log_info "正在从 AppImage 提取图标..."
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# 在临时目录内解压，避免污染当前目录
(
    cd "$TMPDIR"
    "$APPIMAGE_PATH" --appimage-extract >/dev/null 2>&1 || true
)

SOURCE_ICON=""
for candidate in \
    "$TMPDIR/squashfs-root/usr/share/icons/hicolor/1024x1024/apps/rdcli.png" \
    "$TMPDIR/squashfs-root/usr/share/icons/hicolor/512x512/apps/rdcli.png" \
    "$TMPDIR/squashfs-root/rdcli.png" \
    "$TMPDIR/squashfs-root/.DirIcon"; do
    if [ -f "$candidate" ]; then
        SOURCE_ICON="$candidate"
        break
    fi
done

# Fallback: 用项目源码中的图标
if [ -z "$SOURCE_ICON" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
    SOURCE_ICON="$SCRIPT_DIR/../../electron/assets/logo-linux.png"
    log_warn "无法从 AppImage 提取图标，改用源码图标: $SOURCE_ICON"
fi

if [ ! -f "$SOURCE_ICON" ]; then
    log_error "找不到图标文件！"
    exit 1
fi

log_info "源图标: $SOURCE_ICON"

# ---- 安装图标（多尺寸） ----
log_info "正在安装图标..."
SIZES=(256 128 64 48 32)
for size in "${SIZES[@]}"; do
    ICON_DIR="$ICON_BASE/${size}x${size}/apps"
    mkdir -p "$ICON_DIR"
    DEST="$ICON_DIR/rdcli.png"
    if command -v convert &>/dev/null; then
        convert "$SOURCE_ICON" -resize "${size}x${size}" "$DEST"
    elif command -v magick &>/dev/null; then
        magick "$SOURCE_ICON" -resize "${size}x${size}" "$DEST"
    elif python3 -c "from PIL import Image" 2>/dev/null; then
        python3 - "$SOURCE_ICON" "$DEST" "$size" <<'PYEOF'
import sys
from PIL import Image
src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
img = Image.open(src).convert('RGBA')
img.thumbnail((size, size), Image.LANCZOS)
img.save(dst)
PYEOF
    else
        cp "$SOURCE_ICON" "$DEST"
    fi
    log_info "  已安装 ${size}x${size} 图标"
done

# ---- 更新图标缓存 ----
if command -v gtk-update-icon-cache &>/dev/null; then
    gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor/" 2>/dev/null || true
    log_info "已更新 GTK 图标缓存"
fi

# ---- 安装 .desktop 文件 ----
log_info "正在安装桌面入口文件..."
mkdir -p "$HOME/.local/share/applications"

cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Name=rdCLI
Comment=rdCLI Desktop Shell
GenericName=AI Coding Assistant
Exec=${APPIMAGE_PATH} --no-sandbox %U
Terminal=false
Type=Application
Icon=rdcli
StartupWMClass=rdCLI
Categories=Development;Utility;
MimeType=x-scheme-handler/rdcli;
Keywords=AI;Claude;Code;Assistant;Terminal;
EOF

chmod +x "$DESKTOP_FILE"

# ---- 更新桌面数据库 ----
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database "$HOME/.local/share/applications/" 2>/dev/null || true
    log_info "已更新桌面数据库"
fi

# ---- 验证 ----
if [ -f "$DESKTOP_FILE" ]; then
    log_info "============================================"
    log_info "rdCLI 桌面集成安装完成！"
    log_info ""
    log_info "你现在可以:"
    log_info "  1. 按 Super 键搜索 'rdCLI' 启动应用"
    log_info "  2. 在应用菜单中找到 rdCLI 图标"
    log_info "  3. 右键点击 AppImage 选择固定到收藏夹"
    log_info ""
    log_info "卸载命令: $0 --uninstall"
    log_info "============================================"
else
    log_error "安装失败！"
    exit 1
fi