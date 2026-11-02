#!/bin/bash
# 将 rd-cli 源码打成 tar.gz，排除 node_modules、构建产物等大目录
# 用法：在 /home/rd/workspace/ 下执行 ./rd-cli/tar.sh -> 输出 ./rd-cli.tar.gz

set -euo pipefail

# 脚本自身所在目录，即 rd-cli 源码目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 当前工作目录，即脚本执行时所在的目录
WORK_DIR="$(pwd)"

OUT_FILE="${WORK_DIR}/rd-cli.tar.gz"

echo "源码目录: $SCRIPT_DIR"
echo "输出文件: $OUT_FILE"
echo ""

EXCLUDES=(
  --exclude='node_modules'
  --exclude='.git'
  --exclude='dist'
  --exclude='dist-server'
  --exclude='release'
  --exclude='.desktop-build'
)

echo "正在打包..."
tar -czf "$OUT_FILE" "${EXCLUDES[@]}" -C "$SCRIPT_DIR" .

SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "完成: $OUT_FILE ($SIZE)"