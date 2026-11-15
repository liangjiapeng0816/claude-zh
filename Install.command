#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
for node_dir in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do
  PATH="$PATH:$node_dir"
done
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  printf '%s\n' '需要 Node.js 22 或更新版本。'
  exit 1
fi
if [ ! -d node_modules/@formatjs/icu-messageformat-parser ]; then npm ci --ignore-scripts; fi
npm run build
npm run install:app
printf '%s\n' '安装完成。请退出原版 Claude，再从“应用程序”打开 Claude 中文版。'
