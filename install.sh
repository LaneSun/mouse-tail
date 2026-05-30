#!/usr/bin/env bash
#
# Mouse Tail - 一键安装脚本
#
# 用法（一键安装最新版）：
#   curl -fsSL https://raw.githubusercontent.com/LaneSun/mouse-tail/main/install.sh | bash
#
# 可选环境变量：
#   BRANCH=dev   指定安装的分支（默认 main）
#
set -euo pipefail

REPO_URL="https://github.com/LaneSun/mouse-tail.git"
BRANCH="${BRANCH:-main}"

info()  { printf '\033[1;34m[*]\033[0m %s\n' "$1"; }
ok()    { printf '\033[1;32m[+]\033[0m %s\n' "$1"; }
err()   { printf '\033[1;31m[!]\033[0m %s\n' "$1" >&2; }

# 检查依赖
for cmd in git glib-compile-schemas; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "缺少依赖：$cmd，请先安装后重试。"
    exit 1
  fi
done

# 在临时目录克隆，成功后再替换到目标位置，避免安装中途失败留下损坏的扩展
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info "正在从仓库克隆（分支：$BRANCH）..."
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TMP_DIR/src"

# 从 metadata.json 读取 UUID，避免硬编码出错
UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_DIR/src/metadata.json")"
if [ -z "$UUID" ]; then
  err "无法从 metadata.json 解析 UUID。"
  exit 1
fi
info "扩展 UUID：$UUID"

# 编译 GSettings schema（仓库未包含已编译产物，必须编译，否则扩展无法加载设置）
info "正在编译 settings schema..."
glib-compile-schemas "$TMP_DIR/src/schemas"

# 替换安装目录
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
info "正在安装到：$TARGET_DIR"
mkdir -p "$(dirname "$TARGET_DIR")"
rm -rf "$TARGET_DIR"
mv "$TMP_DIR/src" "$TARGET_DIR"

# 尝试启用（首次安装可能需要先重新加载 shell 才能识别）
if command -v gnome-extensions >/dev/null 2>&1; then
  gnome-extensions enable "$UUID" 2>/dev/null || true
fi

ok "安装完成！"
echo
echo "  Wayland 会话下无法原地重启 GNOME Shell，请【注销并重新登录】以加载新版本。"
echo "  （X11 会话可用 Alt+F2 输入 r 重启 Shell。）"
echo "  登录后如未自动启用，可运行： gnome-extensions enable $UUID"
