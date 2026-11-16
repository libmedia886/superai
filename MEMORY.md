
## 2026-11-16 11:0x **房间列表 + 停止后失聪 + 停下必有原因 + 令牌服务级 全部完成**（commit b062d7f）
测试 **329 全过**；包 `/tmp/verify2/multiagent-chat-0.1.0.tgz`（95 文件）；e2e `scripts/rooms-e2e.mjs`(26)/`rooms-ui-e2e.mjs`(17)

**★ 令牌规则（管理方实测确认过的坑）**：
- 令牌是**服务级**，绑端口不绑房间。`<data>/access-token` 为权威副本
- 根目录缺失 → 扫 `rooms/*/access-token` → **复制**回根目录并沿用（不 rename）；都没有才生成
- 迁移 MOVABLE **去掉 access-token**（历史事故：搬进 rooms/r-legacy → 重启换令牌 → li 链接第4次失效）
- `src/core/token.js` + `test/token.test.js`（8 条）

**多房间**：`src/core/sessions.js` RoomManager
- 切换顺序：**先校验目标存在** → halt（真 kill 并等 current 清空）→ 清队列报 dropped → 冻结旧 store → 重建 Room/Store/adapter/成员 → 广播 room.init
- store.freeze()：冻结后 append 只计数不落盘（防残留 turn 污染）
- 事件带 roomId，server 端过滤掉非活动房间的事件
- 界面：落地页=列表；URL `#room=<id>`；刷新回原房间；空房间第一个成员默认 leader；删除→rename 到 rooms/.trash-*
- **重命名只改显示名，目录名不动**（改目录=毁会话上下文）

**CR-028 停止后失聪（老板真实踩到）**：
- 根因：`while (queue && !stopped)` 停止后 drain 立刻退出 + `resumeRoom()` 无调用点
- 修：stopped 进 health/init；人说话自动恢复；POST /api/resume；界面红色常驻+继续按钮
- **另一个隐藏 bug**：`drain()` 的 `if (running) return` 会吞掉停止后收尾期间的新消息 → 加 `_drainAgain` 重试环

**CR-030（管理方只批了部分）**：
- 已做：越权 @ **回注给发言者**（`this._note()` → 下一轮 prompt）；成员无 @ 交回头头（合并批次）；room.paused 带原因；`_enqueue` 去重键改触发消息 id
- **未做：成员互 @**（等 li 点头）
- **我加的**：`_passiveWake` 排除 `triggerSender`——否则 lead→bob→lead 成环且该路径不计入 LoopGuard = 无告警死循环（管理方认可，要测试锁住：已加）

**2026-11-16 通讯故障与替代通道**：
- Telegram 拒收（含 `--reply-to` 引用 agent 消息）→ 去掉 `--reply-to` 重发；再不行改发 `group:91df1aa9...`（#需求分析）
- 已设常设心跳 reminder 20m（`#01a1e23e`）

**下一步**：CR-027 成员设置（spec `/tmp/handoff/spec-member-settings.md`）——read 档、设置弹窗、模型/思考等级、启动参数三类判定、适配器按签名失效

## 2026-11-16 13:0x–14:0x **CR-027 完成 + 命令白名单 + 状态归一化 + 共享目录 + CR-033 超时/看门狗/派活**（commit 43d0946 / d9c44d6 / 9c53e6d / b9c3423）
测试 **389 全过**；包 `/tmp/verify2/multiagent-chat-0.1.0.tgz`（108 文件，14:02）

**★ 本机实测新结论（别重复验）**
- `claude --allowedTools "Bash(curl:*)"` = 白名单，**但 `id`/`echo` 这类被 claude 自带安全分类器直接放行**，不受白名单控制 → 反向测试用 `wget`，不能用 `id`
- **没有白名单时 Bash 一律自动拒**（acceptEdits 只批文件编辑，`--permission-prompts none` 没有审批通道）→ write-exec 名不副实；所以没白名单干脆不给 Bash 工具
- `--add-dir` 同时给**读和写**，claude 没有"只读目录"表达方式 → 不要声称共享区只读
- `codex exec resume` **不认 --add-dir**（只有首轮支持）
- **claude 工具执行期间不发任何流事件**（tool_use 立即发，tool_result 等命令结束）→ 看门狗会把正在干活的轮次判死（线上 11 次工具调用被杀）

**CR-033 三件**
1. 单轮上限可配：房间级 `turnTimeoutMinutes`（默认 20 分钟）+ 成员级 `timeoutMinutes`（优先）；`/api/room-settings` + `/api/member/update`；**改完直接改 Room 实例**（不重启）
2. 卡死窗口与硬上限解耦：固定 `STALL_MS = 90s`（上限很短时才 timeout/2）；isStall 只看有无产出
3. 工具 in-flight：适配器任何 stdout 行发 `activity`；`tool_use` 记 in-flight、`tool_result` 清；in-flight 时窗口放宽 10 分钟，硬上限兜底

**派活 = 真入队**：`task.create{assignee}` / `task.update` 改派成功后 `_dispatchTo()` 入队；完成状态不入队；对方不可发言→回注；派活成功房间不停；被派活的人干完可回叫头头（`job.dispatched` 绕过 triggerSender 排除）
**真 bug**：`updateTask` 就地改对象 → 比较 assignee 变成"新值 vs 新值"，改派永不触发 → 先存旧值

**迁移安全**：
- `startServer` 默认 **不迁移**，必须 `--migrate`（起因：生产重启自动迁了真实数据，没人决定过）
- 迁移在根目录留 `agents -> rooms/r-legacy/agents` 符号链接；session cwd 用 **realpath** 比较（字符串比较会让迁移后全部会话判为接不上 → 上下文静默归零）
- `restoreFromBackup` 必须**先拆符号链接再恢复**（否则 cp 顺着链接写进 rooms/，随后 rm -rf rooms/ 丢数据）

**★ 多会话共用同一个工作目录**：另一个会话（`01a1dda9-...-c3`）也在改 `public/app.js`。我 `git add -A` 把它的 1dcf192 改动（turnFailureText / `.msg-body:empty` / timeout-visible-e2e）扫进了 b9c3423。**以后只 `git add <具体文件>`，不用 -A**。已通知对方 rebase 时 skip。

**待老板/管理方决定**：
- 命令白名单默认值（我做成"人点开才给"，管理方想要默认给 curl/wget）——未答复
- `~/.multiagent-chat/room.json` 里 4 个成员手写的 `timeoutMs: 1800000` 建议删除（与 timeoutMinutes 并存会"界面显示 20 分钟、实际 30 分钟"）
