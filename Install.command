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

node scripts/cli.mjs check-version

if [ ! -d node_modules/@formatjs/icu-messageformat-parser ]; then npm ci --ignore-scripts; fi
npm run build || {
  build_status=$?
  printf '%s\n' '本地构建未完成。可从最新 Release 下载 DMG 直接安装。' \
    'https://github.com/liangjiapeng0816/claude-zh/releases/latest' >&2
  exit "$build_status"
}
npm run install:app
printf '%s\n' '安装完成。请退出原版 Claude，再从“应用程序”打开 Claude 中文版。'
