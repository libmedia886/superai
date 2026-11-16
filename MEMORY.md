
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
