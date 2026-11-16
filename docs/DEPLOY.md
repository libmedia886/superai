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
#    必须 exit=0。不是 0 就不要继续。

# 4. 确认房间空闲再切换（有人正在发言时不要重启）
curl -s http://127.0.0.1:4340/api/health
#    busy:false 且 pending:0 才切换

# 5. 停旧、起新（只换这一个 PID，不要 pkill node）
#    ...（按你们现有的启动方式）

# 6. ★ 部署后再核对一次：线上进程的 cwd 必须就是那份
readlink /proc/<pid>/cwd
bash scripts/verify-deploy.sh "$(readlink /proc/<pid>/cwd)"
#    仍然必须 exit=0

# 7. 冒烟：确认服务真的活着、令牌没变、数据还在
curl -s http://127.0.0.1:4340/api/health
curl -s http://127.0.0.1:4340/api/rooms
```

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
