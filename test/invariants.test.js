/**
 * 能力清单（capability manifest）。
 *
 * ★ 这个文件存在的唯一理由：**测试全绿不能证明能力还在**。
 *
 * 真实事故（CR-037）：`b9c3423` 跑了 389 个测试全绿，但生产构建里
 * HOTFIX3 的 `stalled` 续做、`normalizeStatus`、`sharedDir`、`turnTimeoutMinutes`
 * 全都不见了——因为那些功能**没有任何测试盯着**，代码被整段替换掉也不会有人发现。
 * 管理方是靠在部署目录里 `grep -rn "stalled"` 才发现的。
 *
 * 所以这里分两层：
 *  1. **行为断言**（首选）：真的调用，看它是否还具备那个能力
 *  2. **符号断言**（兜底）：源码里那个具名能力还在
 *
 * 第二层看着粗糙，但它挡的正是"整段替换"这种事故：功能没了，符号也一定没了。
 * 新增能力时**必须在这里加一行**，否则下次回退同样无人察觉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../src/', import.meta.url);
const read = (rel) => readFile(new URL(rel, ROOT), 'utf8');

/** 断言某个具名能力还在源码里（注册即承诺） */
const mustMention = async (file, symbol, why) => {
  const src = await read(file);
  assert.ok(src.includes(symbol), `${file} 里找不到「${symbol}」——${why}`);
};

test('清单：CR-027 成员能力设置', async () => {
  await mustMention('core/probe.js', "READ: 'read'", 'read 档（老板要的"可读"）');
  await mustMention('core/probe.js', 'normalizeTier', '旧配置 codex+readonly 归一化');
  await mustMention('adapters/index.js', 'adapterSignature', '适配器按配置签名失效（改档位不重启生效）');
  await mustMention('core/extraargs.js', 'classifyExtraArgs', '启动参数三类判定');
  await mustMention('core/memberSettings.js', 'planMemberUpdate', '成员设置的校验与归一化');

  const { TIER, availableTiers } = await import('../src/core/probe.js');
  assert.ok(availableTiers('claude').includes(TIER.READ));
  assert.ok(availableTiers('opencode').includes(TIER.READ));
  assert.ok(!availableTiers('codex').includes(TIER.WRITE_ASK), 'codex 表达不了"每次询问"');
});

test('清单：命令白名单（没有白名单就不给 Bash 工具）', async () => {
  await mustMention('adapters/claude.js', 'allowedCommandArgs', '命令白名单参数拼装');
  await mustMention('core/memberSettings.js', 'allowedCommands', '成员上的白名单字段');

  const { tierArgs } = await import('../src/adapters/claude.js');
  const without = tierArgs('write-exec', { allowedCommands: [] });
  assert.ok(!without[without.indexOf('--tools') + 1].includes('Bash'),
    '没有白名单时不能给 Bash：给了也没有审批通道，只会被自动拒绝');

  const withCmds = tierArgs('write-exec', { allowedCommands: ['curl'] });
  assert.ok(withCmds.includes('Bash(curl:*)'));
});

test('清单：CR-028 停止之后还能恢复', async () => {
  await mustMention('core/room.js', 'resumeRoom', '「继续」的入口');
  await mustMention('core/room.js', 'isStopped', '停止状态要能进 health/init');
  await mustMention('server.js', '/api/resume', '松刹车的接口');
  await mustMention('core/room.js', '_drainAgain', 'drain 重入时不能吞掉新消息');
});

test('清单：CR-030 停下必有原因 + 越权回注', async () => {
  await mustMention('core/room.js', '_pause(', '每次停都要说明原因');
  await mustMention('core/room.js', 'PAUSE_PRIORITY', '真实失败不能被"说完了"覆盖');
  await mustMention('core/room.js', '_passiveWake', '成员无 @ 交回头头');
  await mustMention('core/room.js', '_takeNotes', '越权被拦要回注给发言者');
});

test('清单：CR-033 超时可配 + 卡死窗口解耦', async () => {
  await mustMention('core/room.js', 'DEFAULT_TURN_TIMEOUT_MS', '硬上限常量');
  await mustMention('core/health.js', 'STALL_MS', '卡死窗口与硬上限解耦');
  await mustMention('core/room.js', 'resolveMemberTimeoutMs', '成员级上限');
  await mustMention('core/room.js', 'timeoutSource', '实际生效值来源（防"界面一个值、实际另一个值"）');
  await mustMention('server.js', 'turnTimeoutMinutes', '房间级上限');

  const { STALL_MS, stallThreshold, slowStartThreshold } = await import('../src/core/health.js');
  assert.equal(stallThreshold(20 * 60_000), STALL_MS, '放宽硬上限不能顺带放宽卡死判定');
  assert.ok(slowStartThreshold(20 * 60_000) < stallThreshold(20 * 60_000),
    '慢启动提示必须早于卡死判定，否则提示还没出来就被杀了');
});

test('清单：CR-034 工具执行期间不判死', async () => {
  await mustMention('core/room.js', 'TOOL_FLIGHT_SILENCE_MS', '工具 in-flight 时的静默窗口');
  await mustMention('core/room.js', '_toolFlight', '工具调用登记');
  await mustMention('adapters/claude.js', "type: 'activity'", '任何一行 stdout 都算存活');
  await mustMention('adapters/claude.js', 'tool.result', '工具结束要清 in-flight');
});

test('清单：CR-035 失败不被"说完了"覆盖', async () => {
  await mustMention('core/room.js', 'failedTurn', '失败的一轮不进接力');
  const { PAUSE_PRIORITY } = await import('../src/core/room.js');
  assert.ok(PAUSE_PRIORITY.error > PAUSE_PRIORITY.no_target, '失败压得住"没点名下一位"');
  assert.ok(PAUSE_PRIORITY.timeout > PAUSE_PRIORITY.no_target, '超时压得住"没点名下一位"');
  assert.ok(PAUSE_PRIORITY.stopped >= PAUSE_PRIORITY.timeout, '停止是最高优先级');
});

test('清单：CR-036 停止/打断必须落盘，且能「接着做完」', async () => {
  await mustMention('core/room.js', "kind: 'control'", '人的干预要可追责');
  await mustMention('core/store.js', 'controlLog', '重放后能查到');
  // 落盘只解决"事后能查"；当场看到的必须是"被打断、可以接着做"
  await mustMention('core/room.js', 'resumeTarget', '记下被中断的那一轮');
  await mustMention('core/room.js', 'resumeInterruptedTurn', '「接着做完」的入口');
  await mustMention('server.js', 'resumeTarget = null', '人发新指令时清掉过期的待续');
});

test('清单：CR-037 卡死后续做一次', async () => {
  await mustMention('core/health.js', 'stalled', '被看门狗判死的轮次要能续做');
  const { retryDecision } = await import('../src/core/health.js');
  assert.equal(retryDecision({
    tier: 'write-exec', reason: 'timeout', attempt: 0, maxAttempts: 2, stalled: true, toolCalls: 11,
  }).retry, true, '可写档卡死后续做一次（进程已死，结果在会话里）');
  assert.equal(retryDecision({
    tier: 'write-exec', reason: 'timeout', attempt: 1, maxAttempts: 2, stalled: true, toolCalls: 11,
  }).retry, false, '只给一次');
});

test('清单：令牌是服务级的，不跟房间走', async () => {
  await mustMention('core/token.js', 'findLegacyToken', '从旧房间目录捞回令牌');
  await mustMention('core/rooms.js', 'MOVABLE', '迁移清单');
  const roomsSrc = await read('core/rooms.js');
  const movable = roomsSrc.match(/const MOVABLE = \[([^\]]*)\]/)?.[1] ?? '';
  assert.ok(!movable.includes('access-token'), '迁移绝不能把令牌搬走（搬走=重启换令牌）');
});

test('清单：迁移必须显式触发', async () => {
  await mustMention('core/rooms.js', 'allowMigrate', '默认不迁移');
  await mustMention('server.js', 'allowMigrate', '服务默认不迁移');
  const { ensureRoomsLayout } = await import('../src/core/rooms.js');
  const dir = await mkdtemp(join(tmpdir(), 'inv-'));
  await writeFile(join(dir, 'room.json'), JSON.stringify({ name: 'x', members: [] }));
  await writeFile(join(dir, 'room.jsonl'), '');
  await mkdir(join(dir, 'agents'), { recursive: true });
  const r = await ensureRoomsLayout(dir, { allowMigrate: false });
  assert.equal(r.single, true);
  assert.equal(r.meta.pendingMigration, true);
});

test('清单：状态同义词归一化', async () => {
  await mustMention('core/actions.js', 'normalizeStatus', '「已完成/done」不能判非法');
  const { normalizeStatus } = await import('../src/core/actions.js');
  assert.equal(normalizeStatus('已完成'), '完成');
  assert.equal(normalizeStatus('done'), '完成');
});

test('清单：房间共享目录', async () => {
  await mustMention('core/sessions.js', 'sharedDir', '每房间一个共享目录');
  await mustMention('core/prompt.js', '房间共享目录', '不写进 prompt 模型就不知道它存在');
});

test('清单：派活 = 真的入队', async () => {
  await mustMention('core/room.js', '_dispatchTo', '指派要真的叫人');
  await mustMention('core/room.js', 'dispatchedAny', '派活成功时房间不停');
});

test('清单：迁移后会话能接上', async () => {
  await mustMention('core/config.js', 'realpath', 'cwd 比较要用真实路径');
  await mustMention('core/rooms.js', 'symlink', '根目录留 agents 兼容链接');
  await mustMention('core/config.js', 'sessionResetReason', '接不上时界面上要说出来');
});

test('清单：每个后端暂停原因都要有中文文案（否则状态栏显示原始 key）', async () => {
  const { PAUSE_LABEL } = await import('../src/core/room.js');
  const uiSrc = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const uiBlock = uiSrc.slice(uiSrc.indexOf('const PAUSE_LABEL = {'), uiSrc.indexOf('};', uiSrc.indexOf('const PAUSE_LABEL = {')));

  for (const key of Object.keys(PAUSE_LABEL)) {
    if (key === 'cleared') continue;   // 后端没有这个（它是 UI 专用）
    // 前端 map 少一个 key，状态栏就会把 "timeout" 这样的原始英文直接显示给老板
    assert.ok(new RegExp(`\\b${key}:`).test(uiBlock),
      `前端 PAUSE_LABEL 缺少「${key}」—— 状态栏会显示原始 key 而不是人话`);
  }
});

test('清单：撞上限自动续做与失败重试互斥（否则白跑一轮）', async () => {
  await mustMention('core/room.js', 'capAutoContinued', '两条路径会同时满足同一个超时');
  await mustMention('core/room.js', 'MAX_CAP_CONTINUES', '续做次数必须有上限');
});

test('清单：被拒的动作要跨轮重现，且不许写成已完成（16:27 事故）', async () => {
  await mustMention('core/room.js', 'unresolvedActions', '未完成清单');
  await mustMention('core/room.js', '_detectFalseClaims', '正文与真实状态对账');
  await mustMention('core/prompt.js', '未完成清单', '每轮 prompt 都要重现');
  await mustMention('core/actions.js', 'targetId', '校验失败也要带上"想改哪个对象"');
});
