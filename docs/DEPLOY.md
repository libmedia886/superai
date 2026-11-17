# 部署与核对

面向：负责把新版本放到线上的人（不是老板，老板只需要打开浏览器）。

## 为什么需要这一步

2026-11-16 一天之内，线上跑了**三次不是当前 HEAD 的构建**：

| 现象 | 真实原因 |
|---|---|
| 修好的功能又出现了 | 从旧基线出包，中间并进去的修复掉了 |
| 核对说"一致"，实际不一致 | 核对只 `diff` 了 `src` 和 `public`，**漏了 `bin/`** |
| 修复上线了，行为没变 | 部署目录里的 `bin/netget` 还是旧的那份 |

共同点：**"知道该检查" ≠ "会去检查"**。所以这一步不能靠记性。

## 部署流程（按顺序，一步都不能跳）

```bash
# 0. 记下你要部署的基线 —— 后面每次报告都要引用它
cd <仓库>
git log -1 --format='%h %s'

# 1. 出包
npm test                                  # 必须全绿
npm pack --pack-destination /tmp/verify2

# 2. 解包到新目录（不要覆盖旧的，出问题要能退回）
mkdir -p /home/hope/multiagent-chat-app/<hash>
tar xzf /tmp/verify2/multiagent-chat-0.1.0.tgz \
  -C /home/hope/multiagent-chat-app/<hash> --strip-components=1

# 3. ★ 部署前核对：新目录必须与 HEAD 逐文件一致
bash scripts/verify-deploy.sh /home/hope/multiagent-chat-app/<hash>
#    exit=0 → 继续。
#    exit=1 → **先看差的是什么文件**（见下面「exit=1 不等于必须重启」）。

# 4. 确认房间空闲再切换（有人正在发言时不要重启）
curl -s http://127.0.0.1:4340/api/health
#    busy:false 且 pending:0 才切换

# 5. 停旧、起新（只换这一个 PID，不要 pkill node）
#    ...（按你们现有的启动方式）

# 6. ★ 部署后再核对一次：线上进程的 cwd 必须就是那份
readlink /proc/<pid>/cwd
bash scripts/verify-deploy.sh "$(readlink /proc/<pid>/cwd)"
#    exit=0 → 部署确认完成
#    exit=1 → 看差异清单，判断要不要重来

# 7. 冒烟：确认服务真的活着、令牌没变、数据还在
curl -s http://127.0.0.1:4340/api/health
curl -s http://127.0.0.1:4340/api/rooms
```

## `verify-deploy.sh` 只能在仓库内运行

它靠 `git -C <脚本所在仓库> archive HEAD` 取基线，**部署目录里没有 `.git`**。

```bash
cd <仓库> && bash scripts/verify-deploy.sh <部署目录>   # ✅
cd <部署目录> && bash scripts/verify-deploy.sh .        # ❌ 会干净地 exit 2
```

在部署目录里跑时，现在会直接给一句人话（"必须在仓库内运行"）并 exit 2 ——
**不会再输出一堆 `fatal:` 后继续跑**。后者比报错更糟：它会给出一个误导性的核对结论。

## `verify-deploy.sh` 的判据

它用 `git archive HEAD` 导出**全集**，与目标目录逐文件比 —— **不列举目录**。
列举会漏（`src` + `public` 就漏了 `bin`），全集不会。

三类报告：

- **缺少**（HEAD 有、线上没有）→ 功能丢失
- **内容不同** → 线上跑的是旧版本
- **多出**（线上有、HEAD 没有）→ 仅供参考，不影响功能

退出码：

| 码 | 含义 | 该做什么 |
|---|---|---|
| 0 | 一致 | 继续 |
| 1 | 不一致 | **停下来**，看报告里点名了哪些文件 |
| 2 | 无法判定 | 脚本自身失效（locale 或 diff 格式变了）——**不要当作一致** |

> 退出码 2 是刻意设计的。这个脚本第一版自己就有 bug：中文 locale 下
> `diff` 输出「文件 X 和 Y 不同」，而分类匹配的是英文 `Files ... differ`
> → **所有内容差异被静默漏掉**，脚本报了"完全一致"。
> 一个用来防漏查的工具，第一次运行就漏查了。所以它必须能报告"我失效了"。

## 关于测试里会出现的 `skipped`

在**解包产物**里跑 `npm test` 会看到：

```
ℹ tests 552
ℹ pass 547
ℹ fail 0
ℹ skipped 5
```

**这不是被绕过了。** 跳过的是 `test/verify-deploy.test.js` 里那几条依赖 git 的用例
（它们要 `git archive HEAD` 导出基线，而解包产物没有 `.git`）。

- **仓库内跑**：550+ 全过（0 skipped）
- **解包产物里跑**：547 过 + 5 跳过

要补跑那几条，在仓库里单独执行：

```bash
node --test test/verify-deploy.test.js    # 8/8 全过
```

**判断标准不是"记住这个数字"，而是 `fail 0` + 跳过原因合理。**
条数会随测试增加而变化。如果你加了新测试却忘了加 skip 守卫，
解包验证时会看到 `failed` —— 那正是它该起的作用（我自己就犯过一次）。

但报告里要把 `skipped` 的条数和原因写出来 —— 否则下一个人看到这个数字会怀疑被绕过了。

## `exit=1` 不等于必须重启

`verify-deploy.sh` 报退出码 1 时，**第一件事是看它点名的文件**，而不是立刻重启。

判断分界：

| 差的文件 | 要不要重启 |
|---|---|
| `src/` `public/` `bin/` 任何一个 | **要**——这些是运行时行为 |
| 只有 `docs/` `test/` `scripts/`（工具类） | **不必**——不影响正在跑的房间 |
| `package.json` 里的 scripts/bin | 看具体改了什么 |

管理方 2026-11-17 07:54 的实际判断：线上 `v37` 只差 `docs/DEPLOY.md` 和
`test/verify-deploy.test.js` 两个非运行时文件，他**没有重启**——因为
当天已经因重启打断过一次正在跑的轮次（04:07）。

**核对脚本的正确用法不是"不一致就重启"，而是"先看差的是什么"。**
`exit=1` 是提示，不是判决。但**必须是人在看**，不能默认跳过。

### 不重启，也要让部署目录追上 HEAD

只有文档/测试/工具差异时可以不重启，但**必须把那几个文件同步进部署目录**：

```bash
# 从解包产物同步（或直接从仓库复制）
cp docs/DEPLOY.md  <部署目录>/docs/
cp test/verify-deploy.test.js <部署目录>/test/
cp scripts/verify-deploy.sh   <部署目录>/scripts/
bash scripts/verify-deploy.sh <部署目录>    # 现在必须是 exit=0
```

**为什么不能放着不管**：`部署目录 == HEAD` 是一个不变量。破了它之后，
**下次真需要重启时你分不清差异是"新旧版本"还是"上次漏同步"**——
而这两种情况的处置完全不同。

管理方 2026-11-17 08:19 的实际做法：进程已跑 1 小时 57 分，房间空闲但无需打断，
于是**同步三个文件、不重启**，复核 `verify-deploy.sh` → exit=0。

## 常见陷阱

1. **管道会吃掉退出码。**
   `bash verify-deploy.sh <dir> | tail` → `$?` 是 `tail` 的码，永远 0。
   测退出码时不要接管道，或者用 `${PIPESTATUS[0]}`。

2. **不要 `pkill node`。**
   会误伤另一个会话正在跑的服务。按 PID 停。

3. **测试绿 ≠ 线上对。**
   `npm test` 跑的是仓库里的代码；线上跑的是部署目录里的那份。
   这两件事只有 `verify-deploy.sh` 能连起来。

4. **报告里要带基线 hash。**
   「已部署」这句话没有信息量；「已部署 `abc1234`」才能被别人核对。
