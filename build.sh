#!/bin/bash
# 打包并安装到本地 VS Code：./build.sh
set -euo pipefail
cd "$(dirname "$0")"
OUT=$(./package.sh)
code --install-extension "$OUT"
echo "已安装 $OUT；在 VS Code 里执行 Developer: Reload Window 生效。"
