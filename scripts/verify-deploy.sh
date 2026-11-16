#!/bin/bash
# 部署基线核对：**整个 git archive HEAD** 与部署目录逐文件比。
#
#   bash scripts/verify-deploy.sh <部署目录>
#
# 为什么不是"比 src 和 public"：管理方 03:55 的核对就是这么做的，
# 漏了 `bin/` —— 而 `df8134a` 改的正是 `bin/netget`。于是得出"一致"的
# 错误结论，线上实际跑的是不含修复的那份。
#
# **判据必须是"enumerable 全集"，不是"我记得要查的目录"** ——
# 与今天所有白名单/黑名单的教训同源：列举会漏，全集不会。

set -u
TARGET="${1:-}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "$TARGET" ] || [ ! -d "$TARGET" ]; then
  echo "用法：$0 <部署目录>" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 用 git archive 导出 HEAD 的完整内容（不受 package.json "files" 白名单影响）
git -C "$REPO" archive HEAD | tar -x -C "$TMP"

echo "HEAD: $(git -C "$REPO" log -1 --format='%h %s')"
echo "对比: $TMP  vs  $TARGET"
echo

# 逐文件比对（排除部署目录里本来就会有的东西）
#
# ★ 必须强制 LC_ALL=C：中文 locale 下 diff 输出是「文件 X 和 Y 不同」，
#   而下面的分类匹配的是英文 "Files ... differ" —— 不加这一行，
#   **所有内容差异都会被静默漏掉**，脚本会错误地报"完全一致"。
#   这个 bug 我自己写出来又被自己的第一次运行抓到（它漏报了 bin/netget）。
DIFF_OUT="$(
  LC_ALL=C diff -rq --exclude=node_modules --exclude=.git --exclude=MEMORY.md \
    --exclude='*.log' --exclude='.trash-*' \
    "$TMP" "$TARGET" 2>&1
)"

if [ -z "$DIFF_OUT" ]; then
  echo "✅ 完全一致（HEAD 的每个文件都在部署目录里，内容相同）"
  exit 0
fi

# 分类：部署目录缺的 / 多的 / 内容不同的
# ★ 注意 grep 的是 diff 在 LC_ALL=C 下的英文输出（"Only in" / "Files ... differ"）
MISSING=$(echo "$DIFF_OUT" | grep -F "Only in $TMP" || true)
EXTRA=$(echo "$DIFF_OUT" | grep -F "Only in $TARGET" || true)
DIFFER=$(echo "$DIFF_OUT" | grep "^Files " || true)

# diff 的 `Only in <dir>: <name>` 把文件名和目录分开，人看着不直观。
# 归一化成完整路径，这样报告里能直接复制去核对。
norm_only_in() {
  # $1 = 原始行（Only in /a/b: name），输出 /a/b/name
  sed -E 's#^Only in (.*): (.*)$#\1/\2#'
}

FAIL=0
if [ -n "$MISSING" ]; then
  echo "❌ 部署目录缺少（HEAD 有、线上没有）——**这些是功能丢失**："
  echo "$MISSING" | norm_only_in | sed 's/^/   /'
  FAIL=1
fi
if [ -n "$DIFFER" ]; then
  echo "❌ 内容不同——**线上跑的是旧版本**："
  echo "$DIFFER" | sed 's/^/   /'
  FAIL=1
fi
if [ -n "$EXTRA" ]; then
  echo "⚠️  部署目录多出的（仅供参考，不影响功能）："
  echo "$EXTRA" | norm_only_in | sed 's/^/   /'
fi

# ★ 自检：diff 报了差异、但三个分类都没匹配上 → 说明分类逻辑坏了（locale/格式变了）
if [ "$FAIL" = "0" ] && [ -n "$DIFF_OUT" ]; then
  echo "❌ 核对脚本自身失效：diff 报了差异但无法分类（可能是 locale 或 diff 输出格式变化）"
  echo "   原始输出："
  echo "$DIFF_OUT" | sed 's/^/   /'
  echo
  echo "结论：**无法判定**，不要当作一致。"
  exit 2
fi

echo
if [ "$FAIL" = "1" ]; then
  echo "结论：部署目录 **不是** HEAD —— 不要以它为准做验收。"
  exit 1
fi

echo "结论：HEAD 的文件全在且一致（部署目录另有附加文件）。"
exit 0
