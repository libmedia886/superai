# multiagent-chat — M1

多个 `claude` / `codex`（预留 `opencode`）实例在同一个房间里通过 **@ 点名** 串行协作。

**现在就能跑。** 不需要配置、不需要 API key——直接用本机已登录的 CLI：

```bash
node bin/room.mjs --demo    # 一键演示：头头拆任务 → 派给成员 → 成员产出 → 看板更新
node bin/room.mjs           # 交互模式
```

终端界面是内核的可体验外壳；Electron 界面是后续步骤，两者共用同一套 `src/core/`。

## 已验证

```
node --test "test/*.test.js"   # 54 项单元测试全通过
node scripts/smoke.mjs         # 真实 CLI 端到端：claude + codex
node bin/room.mjs --demo       # 真实多 agent 闭环
```

交互命令：`@名字 内容`、`/board`、`/roster`、`/who`、`/stop`、`/interrupt`、`/history`。

数据目录默认 `~/.multiagent-chat/`（可用 `MAROOM_DATA` 覆盖）：
`room.json`（成员与仓库登记）、`room.jsonl`（追加式事件流）、`agents/<id>/`（各自工作目录）。

冒烟实测输出（本机 claude-code 2.1.325 / codex-cli 0.167.0）：

```
== 探测 ==        claude: 可用    codex: 可用
== 人发言 ==      解析结果：{ targets: ['lead','bob'], unknown: [] }
>>> lead 开始发言  @bob 写一句关于海洋的话。
                  ```action {"action":"task.create",...,"assignee":"bob"} ```
<<< lead 结束（2417ms）
    [任务] {"id":"T-001",... ,"assignee":"bob","status":"待办","createdBy":"lead"}
>>> bob 开始发言   海把远处的天光揉成细碎的金色，潮声一遍遍漫过沙滩。
<<< bob 结束（4843ms）
任务：[T-001 ...]   会话映射：lead/claude sessionId✓  bob/codex sessionId✓
```

即：**人类一句 @ → 头头拆任务 → 动作协议落库 → 自动 @ 接力 → 成员产出 → 全部持久化**。

## 实测校正（写进需求的依据）

| 事项 | 结论 |
|---|---|
| `claude -p --output-format stream-json` | **必须加 `--verbose`**，否则直接报错退出 |
| `codex exec resume` 的参数 | **不支持 `-s` 与 `-C`**。只能用 `-c sandbox_mode=read-only`，cwd 靠 spawn 的 cwd。需求 §6.1 原写法跑不通，已在本实现中修正 |
| `codex exec --json` 流式 | **无 token 级 delta**，只能整段出字（`supportsStreaming=false`） |
| `codex login status` | 本机报「Not logged in」+ 退出码 1，但 `exec` 正常 → **不可作可用性判据**，一律用真实探测 |
| resume 按 cwd 隔离 | `codex exec resume --all` 说明为 "disables cwd filtering"，确认会话按 cwd 索引；工作目录必须持久不变 |
| prompt 走 stdin | 两家都支持（`codex exec -`、`claude -p` 无位置参数），已验证 |
| 环境变量 | 本机登录态走 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`，**清环境会断登录**。只覆盖 `NO_COLOR`/`TERM`/`LANG` |

## 结构

```
bin/room.mjs           可运行外壳（演示 + 交互）
src/core/mentions.js   @ 解析（长名优先、全角、未知 @、越权 @ 策略）
src/core/actions.js    结构化动作协议（提取/校验/鉴权/幂等/剥离）
src/core/room.js       房间调度：串行队列、接力、打断、循环检测、压缩、动作执行
src/core/prompt.js     投递策略（增量 / 仅被 @ / 摘要）、动作结果回注
src/core/compact.js    上下文压缩与 session 轮换（70% 阈值）
src/core/probe.js      环境探测 + 沙箱自检（三项分测、按档位双向判定）
src/core/worktree.js   仓库白名单 + worktree 生命周期
src/core/store.js      追加式 JSONL，可重放重建
src/core/runner.js     子进程：NDJSON 行缓冲、UTF-8、硬超时、进程组 kill
src/adapters/          claude / codex / opencode(骨架)
scripts/smoke.mjs      真实端到端
```

## P0 覆盖情况

| 已实现 | 说明 |
|---|---|
| #3 #4 #5 | @ 点名、接力、无 @ 停住 |
| #7 | 排队 + 强制打断 |
| #8 | 持久化（含任务、名册、会话映射，重启续聊） |
| #9 | 无硬闸，只做循环检测提示 |
| #12 | 环境探测（真实探测调用）+ 沙箱自检 |
| #13 | 会话隔离（每 agent 独立 session + cwd） |
| #14 | 上下文压缩与轮换 |
| #15 | 三档权限（Claude 三档；Codex 只有两档，中间档硬失败） |
| #16 #17 | 任务对象 + 看板 |
| #18 | 名册（人编辑区与自述区分开） |
| #21 | 结构化动作协议（8 条硬规则） |
| #22 #23 #24 | 仓库白名单、worktree 生命周期、验收 diff |

未做：Electron 图形界面、#6 总结入口的完整交互、#10 #11 的界面态展示（内核事件已备）。

## 刻意做成这样的地方

- **动作在轮结束后才解析**，流式期间绝不执行半截 JSON。
- **只认本人直接输出**：嵌套/引用块里的 action 一律不执行，且**回注**告知，避免幻觉式"已分配"。
- **幂等**：`(actor, session, turn, localId|内容哈希)` 去重，重试不会重复建任务。
- **成员越权 @** 消息照发但不触发，并回报，不静默吞。
- **无硬性轮数上限**，只做循环检测（连续发言 / 文本相似度 ≥0.85）并提示。
- **失败四分类**（completed / failed / timeout / crashed），界面据此区分。

## 未做（等需求定稿或属 P1）

- Electron 界面、任务看板、名册编辑
- 上下文压缩（阈值 70% → 摘要 → 轮换 session）
- opencode 适配器（本机未安装，参数未实测，**故意抛错而不是猜参数**）
- 并行执行（P0 定为串行）
