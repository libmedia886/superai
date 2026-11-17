#!/bin/bash
# 检查仓库里"测退出码"的命令有没有接管道（管道会让 $? 变成最后一个命令的码）。
#
#   bash scripts/check-exitcode-usage.sh
#
# 来源：管理方 2026-11-17 10:19 第二次踩同一个坑 ——
#   `bash verify-deploy.sh … | tail -3; echo $?` → 拿到的是 tail 的 0，差点判定"拒绝逻辑失效"。
# 这是今天最反复的一类错误：**测量方式本身没被验证**。

set -u
FILE_SHOWN=""
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 2

BAD=0

# 在文档/脚本/测试里找「命令 | tail/head ...; echo $?」这种形状
# 允许 `${PIPESTATUS[0]}` 的写法（那是正确的）
scan() {
  local file="$1"
  local n=0 line
  # 关键点：管道和 `$?` **经常不在同一行**（实战写法就是
  #   `cmd | tail`
  #   `echo "exit=$?"`）
  # 所以判据是"读取 $?，且**前两行内**有管道"。只看同一行会漏掉真实违规
  # —— 我第一版就是这么写的，拿一个真实的反例都测不出来。
  while IFS= read -r line; do
    n=$((n + 1))
    case "$line" in
      '#'*|'*'*|'') continue ;;        # 注释/空行（去掉前导空白再判）
    esac
    case "${line#"${line%%[![:space:]]*}"}" in
      '#'*|'*'*|'') continue ;;        # 同上，处理缩进注释
    esac
    # 这一行真的读了 $?（排除 ${PIPESTATUS[0]}）
    case "$line" in
      *'$?'*) ;;
      *) continue ;;
    esac
    case "$line" in
      *PIPESTATUS*) continue ;;
    esac
    # 看本行与前两行有没有管道
    local ctx
    ctx=$(awk -v n="$n" 'NR>=n-2 && NR<=n' "$file")
    case "$ctx" in
      *'|'*)
        # 文件名只打一次
        if [ "$FILE_SHOWN" != "$file" ]; then
          echo "⚠️  $file:"
          FILE_SHOWN="$file"
        fi
        echo "     line $n: $line"
        BAD=1
        ;;
    esac
  done < "$file"
}

# 只扫**可执行代码**。文档里写「`cmd | tail` → $? 是 tail 的码」是在**教学**，
# 不是在犯这个错 —— 扫文档会把它自己的正确示范报成错误。
for f in scripts/*.sh scripts/*.mjs; do
  [ -f "$f" ] || continue
  scan "$f"
done

if [ "$BAD" = "1" ]; then
  echo
  echo "❌ 上面这些地方把 \$? 和管道放在一起了 —— 拿到的是最后一个命令的码。"
  echo "   要么去掉管道，要么用 \${PIPESTATUS[0]}。"
  exit 1
fi

echo "✅ 没有发现「管道 + \$?」的写法"
exit 0
