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

version_status=0
node scripts/cli.mjs check-version || version_status=$?
case "$version_status" in
  0) ;;
  2)
    printf '%s' '仍要继续构建并安装吗？ [y/N] '
    IFS= read -r answer || answer=''
    case "$answer" in
      [Yy]|[Yy][Ee][Ss]) ;;
      *) printf '%s\n' '已取消安装。'; exit 1 ;;
    esac
    ;;
  *) exit "$version_status" ;;
esac

if [ ! -d node_modules/@formatjs/icu-messageformat-parser ]; then npm ci --ignore-scripts; fi
npm run build
npm run install:app
printf '%s\n' '安装完成。请退出原版 Claude，再从“应用程序”打开 Claude 中文版。'
