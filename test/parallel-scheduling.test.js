/**
 * SuperAI v2.1 自适应并行/串行调度引擎、实时运行态快照与实机问题修复测试。
 *
 * 覆盖：
 *  1. executionMode (auto / parallel / serial) + maxConcurrency 有效模式与并发度计算
 *  2. 跨成员并行执行与并发槽位上限（maxConcurrency）
 *  3. Per-Agent 硬锁：同一成员绝不并发
 *  4. 智能 Fan-in 汇合屏障与头头去重合并（含 @lead 与 passiveWake；人类 @lead 永不暂缓）
 *  5. 并发隔离：_lastActionResultsByAgent 与 _pendingContinueByAgent 互不串台
 *  6. 并发下的 _pause 保护（单人结束/失败/被打断不误停仍在干活的其他成员）
 *  7. 定向 interrupt(agentId)、全量 interrupt()、stop() 与 halt()
 *  8. runtimeSnapshot() 与 runtime.state 实时状态流转
 *  9. HTTP/SSE 集成：/api/room-settings 热切并行唤醒排队任务、/api/interrupt 定向打断、
 *     /api/health 并发指标、/events 初始快照、auto 模式下增删成员动态切换并行/串行
 * 10. 3 项实机发现问题修复（classifyTool 工具映射、prompt 动态后端与防覆盖约定）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyTool, Room } from '../src/core/room.js';
import { Store } from '../src/core/store.js';
import { createRoom } from '../src/core/rooms.js';
import { buildRoom } from '../src/core/config.js';
import { buildPrompt } from '../src/core/prompt.js';
import { startServer } from '../src/server.js';

function closeServer(server) {
  server.closeAllConnections?.();
  server.close();
}

async function cleanupRoom(room, store, dir) {
  if (room?.activeTurns?.size > 0 || room?.queue?.length > 0) room.stop();
  await store?.flush?.();
  await rm(dir, { recursive: true, force: true });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

async function fetchInitialFrames(url) {
  const ac = new AbortController();
  let text = '';
  try {
    const res = await fetch(`${url}/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    while ((text.match(/data: /g) ?? []).length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
  } finally {
    ac.abort();
  }
  const lines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  return { init: lines[0], snapshot: lines[1] };
}

async function makeRoom({
  members,
  executionMode = 'parallel',
  maxConcurrency = 4,
  headPassiveWake = true,
  allowPeerMentions = true,
  resolveAdapter,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'par-room-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const list = (members ?? [
    { id: 'lead', name: 'lead', role: 'leader' },
    { id: 'bob', name: 'bob', role: 'member' },
    { id: 'carol', name: 'carol', role: 'member' },
    { id: 'dave', name: 'dave', role: 'member' },
  ]).map((m) => ({
    backend: 'agy',
    tier: 'full',
    cwd: dir,
    aliases: [m.name.toLowerCase()],
    ...m,
  }));

  const room = new Room({
    id: 'r-par',
    name: '并行测试房',
    goal: '并行协作',
    members: list,
    store,
    executionMode,
    maxConcurrency,
    headPassiveWake,
    allowPeerMentions,
    resolveAdapter: resolveAdapter ?? (() => ({ run: async () => ({ text: '好', reason: 'completed' }) })),
    onEvent: (ev) => events.push(ev),
  });
  room.maxRetries = 0;
  return { room, store, events, dir };
}

async function makeHttpServer(roomCfg = null) {
  const dir = await mkdtemp(join(tmpdir(), 'par-srv-'));
  const cfg = roomCfg ?? {
    name: '并发接口测试',
    goal: '',
    registry: [],
    aiCabTier: 'full',
    allowPeerMentions: true,
    headPassiveWake: true,
    executionMode: 'auto',
    maxConcurrency: 4,
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'agy', tier: 'full' },
      { id: 'bob', name: 'bob', role: 'member', backend: 'agy', tier: 'full' },
      { id: 'carol', name: 'carol', role: 'member', backend: 'agy', tier: 'full' },
    ],
  };
  for (const m of cfg.members) {
    await mkdir(join(dir, 'rooms', 'r-a', 'agents', m.id), { recursive: true });
  }
  await writeFile(join(dir, 'rooms', 'r-a', 'room.json'), JSON.stringify(cfg, null, 2));
  await writeFile(join(dir, 'rooms.json'), JSON.stringify({
    version: 1,
    activeRoomId: 'r-a',
    rooms: [{ id: 'r-a', name: cfg.name, createdAt: new Date().toISOString() }],
  }, null, 2));
  const srv = await startServer({ port: 0, dataDir: dir });
  return { ...srv, dir };
}

/* ---------- 1. 自适应模式与并发上限计算 ---------- */

test('executionMode 与 maxConcurrency：auto/parallel/serial 判定准确，createRoom/buildRoom 默认 auto+4', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'par-cfg-'));
  try {
    const meta = { version: 1, rooms: [], activeRoomId: null };
    const r = await createRoom(dir, meta, '自动并发房');
    assert.equal(r.ok, true);

    const roomDir = join(dir, 'rooms', r.room.id);
    const saved = JSON.parse(await readFile(join(roomDir, 'room.json'), 'utf8'));
    assert.equal(saved.executionMode, 'auto');
    assert.equal(saved.maxConcurrency, 4);

    // 4 人（<= 4）→ parallel(4)
    const cfg4 = {
      ...saved,
      members: ['a', 'b', 'c', 'd'].map((id, i) => ({
        id, name: id, role: i === 0 ? 'leader' : 'member', backend: 'agy', tier: 'full',
      })),
    };
    const b4 = await buildRoom({ cfg: cfg4, dataDir: roomDir });
    assert.equal(b4.room.executionMode, 'auto');
    assert.equal(b4.room.effectiveExecutionMode(), 'parallel');
    assert.equal(b4.room.effectiveConcurrency(), 4);

    // 5 人（> 4）→ serial(1)
    const cfg5 = {
      ...cfg4,
      members: [...cfg4.members, { id: 'e', name: 'e', role: 'member', backend: 'agy', tier: 'full' }],
    };
    const b5 = await buildRoom({ cfg: cfg5, dataDir: roomDir });
    assert.equal(b5.room.effectiveExecutionMode(), 'serial');
    assert.equal(b5.room.effectiveConcurrency(), 1);

    // 显式 parallel 覆盖人数阈值
    b5.room.executionMode = 'parallel';
    b5.room.maxConcurrency = 3;
    assert.equal(b5.room.effectiveExecutionMode(), 'parallel');
    assert.equal(b5.room.effectiveConcurrency(), 3);

    // 显式 serial 始终为 1
    b4.room.executionMode = 'serial';
    assert.equal(b4.room.effectiveExecutionMode(), 'serial');
    assert.equal(b4.room.effectiveConcurrency(), 1);

    // 直接 new Room() 默认保持串行兼容
    const directStore = new Store(join(dir, 'direct.jsonl'));
    await directStore.load();
    const direct = new Room({ id: 'd', name: 'd', members: [], store: directStore, resolveAdapter: () => ({}) });
    assert.equal(direct.executionMode, 'serial');
    assert.equal(direct.effectiveConcurrency(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- 2. 跨成员并行执行 + maxConcurrency 限流 ---------- */

test('跨成员并行执行：遵守 maxConcurrency 槽位上限且真正并发重叠', async () => {
  const gates = { bob: deferred(), carol: deferred(), dave: deferred() };
  let active = 0;
  let peak = 0;
  const started = [];

  const { room, store, dir } = await makeRoom({
    executionMode: 'parallel',
    maxConcurrency: 2,
    headPassiveWake: false,
    resolveAdapter: (agent) => ({
      async run() {
        started.push(agent.id);
        active += 1;
        peak = Math.max(peak, active);
        await gates[agent.id].promise;
        active -= 1;
        return { text: `${agent.id} 完成`, reason: 'completed' };
      },
    }),
  });

  try {
    await room.humanSay('@bob @carol @dave 同时开工');
    const draining = room.drain();

    assert.equal(await waitFor(() => started.length === 2), true, '应立即并发启动前 2 人');
    assert.deepEqual(started, ['bob', 'carol']);
    assert.equal(room.activeTurns.size, 2);
    assert.equal(room.queue.length, 1);
    assert.equal(room.queue[0].agentId, 'dave');

    // 释放 bob → 腾出槽位，dave 立即启动，此时 carol 与 dave 并行
    gates.bob.resolve();
    assert.equal(await waitFor(() => started.length === 3), true, 'bob 完成后 dave 应立即补位');
    assert.deepEqual(started, ['bob', 'carol', 'dave']);
    assert.equal(room.activeTurns.size, 2);

    gates.carol.resolve();
    gates.dave.resolve();
    await draining;

    assert.equal(peak, 2, '峰值并发不得超过 maxConcurrency=2');
    assert.equal(room.activeTurns.size, 0);
    assert.equal(room.current, null);
    assert.equal(room.waitingForHuman, true);
  } finally {
    Object.values(gates).forEach((g) => g.resolve());
    await cleanupRoom(room, store, dir);
  }
});

/* ---------- 3. Per-Agent 硬锁：同一成员永不并发 ---------- */

test('Per-Agent 锁：同一成员多条排队任务严格串行，其他成员不受阻塞', async () => {
  const bobGate1 = deferred();
  const bobGate2 = deferred();
  const carolGate = deferred();
  let bobActive = 0;
  let bobPeak = 0;
  let bobCount = 0;
  let carolStartedWhileBobBusy = false;

  const { room, store, dir } = await makeRoom({
    executionMode: 'parallel',
    maxConcurrency: 4,
    headPassiveWake: false,
    resolveAdapter: (agent) => ({
      async run() {
        if (agent.id === 'bob') {
          bobCount += 1;
          const idx = bobCount;
          bobActive += 1;
          bobPeak = Math.max(bobPeak, bobActive);
          await (idx === 1 ? bobGate1.promise : bobGate2.promise);
          bobActive -= 1;
          return { text: `bob #${idx}`, reason: 'completed' };
        }
        if (agent.id === 'carol') {
          if (bobActive === 1) carolStartedWhileBobBusy = true;
          await carolGate.promise;
          return { text: 'carol #1', reason: 'completed' };
        }
        return { text: 'ok', reason: 'completed' };
      },
    }),
  });

  try {
    await room.humanSay('@bob 第一件事');
    await room.humanSay('@bob 第二件事');
    await room.humanSay('@carol 同步查一下');

    const draining = room.drain();
    assert.equal(await waitFor(() => bobCount === 1 && carolStartedWhileBobBusy), true);
    assert.equal(bobPeak, 1, '同一成员 bob 绝不能并发');
    assert.equal(room.activeTurns.size, 2);
    assert.equal(room.queue.length, 1);
    assert.equal(room.queue[0].agentId, 'bob');

    bobGate1.resolve();
    assert.equal(await waitFor(() => bobCount === 2), true, 'bob 第一轮结束后才启动第二轮');
    assert.equal(bobPeak, 1);

    bobGate2.resolve();
    carolGate.resolve();
    await draining;

    assert.equal(bobCount, 2);
    assert.equal(bobPeak, 1);
  } finally {
    bobGate1.resolve();
    bobGate2.resolve();
    carolGate.resolve();
    await cleanupRoom(room, store, dir);
  }
});

/* ---------- 4. 智能 Fan-in 汇合屏障 + 头头去重合并 ---------- */

test('Fan-in 汇合：并行成员陆续 @lead 时暂缓头头，全部完成后一次性合并唤醒一次', async () => {
  const gates = { bob: deferred(), carol: deferred(), dave: deferred() };
  const order = [];
  const leadPrompts = [];

  const { room, store, dir } = await makeRoom({
    executionMode: 'parallel',
    maxConcurrency: 4,
    resolveAdapter: (agent) => ({
      async run({ prompt }) {
        order.push(`start:${agent.id}`);
        if (gates[agent.id]) {
          await gates[agent.id].promise;
          order.push(`end:${agent.id}`);
          return { text: `@lead ${agent.id}已完成模块调研`, reason: 'completed' };
        }
        leadPrompts.push(prompt);
        order.push(`end:${agent.id}`);
        return { text: '汇总完毕，结论如下。', reason: 'completed' };
      },
    }),
  });

  try {
    // 注意：老板消息里只点名三位执行成员（不直接 @lead），由成员完成后分别 @lead 触发 Fan-in
    await room.humanSay('@bob @carol @dave 各自调研，完成后汇报给头头汇总');
    const draining = room.drain();

    assert.equal(await waitFor(() => room.activeTurns.size === 3), true, '3 名非 leader 成员应并发启动');

    // bob 先完成并 @lead：因为 carol 与 dave 仍在运行，lead 必须被 Fan-in 暂缓
    gates.bob.resolve();
    assert.equal(await waitFor(() => order.includes('end:bob') && room.queue.some((q) => q.agentId === 'lead')), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(order.includes('start:lead'), false, '其他成员未完成前，lead 不得提前启动');
    const snapMid = room.runtimeSnapshot();
    assert.equal(snapMid.memberStates.lead.status, 'queued');
    assert.equal(snapMid.memberStates.lead.waitingFanIn, true);

    // carol 接着完成并 @lead：应合并到同一条 lead 任务，不产生重复排队
    gates.carol.resolve();
    assert.equal(await waitFor(() => order.includes('end:carol')), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(order.includes('start:lead'), false, 'dave 仍在跑，lead 仍应等待');
    assert.equal(room.queue.filter((q) => q.agentId === 'lead').length, 1, '多个 @lead 必须去重合并为 1 条');

    // 最后 dave 完成并 @lead：全部非 leader 结束，lead 启动且只跑一次
    gates.dave.resolve();
    await draining;

    assert.equal(leadPrompts.length, 1, '头头应只执行一次汇总，而非连跑三轮');
    assert.match(leadPrompts[0], /bob已完成模块调研/);
    assert.match(leadPrompts[0], /carol已完成模块调研/);
    assert.match(leadPrompts[0], /dave已完成模块调研/);
    assert.ok(order.indexOf('start:lead') > order.indexOf('end:dave'), 'lead 必须在最后一个非 leader 结束后启动');
  } finally {
    Object.values(gates).forEach((g) => g.resolve());
    await cleanupRoom(room, store, dir);
  }
});

test('Fan-in 汇合：并行成员无 @ 触发被动唤醒，合并为一次头头轮次且不因并发人数撞 autoAdvance 上限', async () => {
  const gates = { m1: deferred(), m2: deferred(), m3: deferred(), m4: deferred() };
  const leadPrompts = [];
  const finished = [];

  const { room, store, dir } = await makeRoom({
    members: [
      { id: 'lead', name: 'lead', role: 'leader' },
      { id: 'm1', name: 'm1', role: 'member' },
      { id: 'm2', name: 'm2', role: 'member' },
      { id: 'm3', name: 'm3', role: 'member' },
      { id: 'm4', name: 'm4', role: 'member' },
    ],
    executionMode: 'parallel',
    maxConcurrency: 4,
    headPassiveWake: true,
    resolveAdapter: (agent) => ({
      async run({ prompt }) {
        if (gates[agent.id]) {
          await gates[agent.id].promise;
          finished.push(agent.id);
          return { text: `${agent.id}产出无at报告`, reason: 'completed' };
        }
        leadPrompts.push(prompt);
        return { text: '收到四份报告，已全部汇总。', reason: 'completed' };
      },
    }),
  });

  try {
    await room.humanSay('@m1 @m2 @m3 @m4 各自并行输出');
    const draining = room.drain();
    assert.equal(await waitFor(() => room.activeTurns.size === 4), true);

    gates.m1.resolve();
    gates.m2.resolve();
    gates.m3.resolve();
    assert.equal(await waitFor(() => finished.length === 3), true);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(leadPrompts.length, 0, 'm4 尚未完成前，被动唤醒的头头也应等待 Fan-in');

    gates.m4.resolve();
    await draining;

    assert.equal(leadPrompts.length, 1, '4 名并行成员无 @ 应合并唤醒头头 1 次');
    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      assert.match(leadPrompts[0], new RegExp(`${id}产出无at报告`));
    }
  } finally {
    Object.values(gates).forEach((g) => g.resolve());
    await cleanupRoom(room, store, dir);
  }
});

test('Fan-in 汇合：人类直接 @lead 永不受暂缓，立刻与在跑成员并行启动', async () => {
  const bobGate = deferred();
  const leadStarted = deferred();

  const { room, store, dir } = await makeRoom({
    executionMode: 'parallel',
    maxConcurrency: 4,
    headPassiveWake: false,
    resolveAdapter: (agent) => ({
      async run() {
        if (agent.id === 'bob') {
          await bobGate.promise;
          return { text: 'bob 完事', reason: 'completed' };
        }
        if (agent.id === 'lead') {
          leadStarted.resolve(true);
          return { text: '老板我立刻响应', reason: 'completed' };
        }
        return { text: 'ok', reason: 'completed' };
      },
    }),
  });

  try {
    await room.humanSay('@bob 慢活');
    const draining = room.drain();
    assert.equal(await waitFor(() => room.activeTurns.has('bob')), true);

    // 人类在 bob 正在跑时直接 @lead：必须立刻并行执行
    await room.humanSay('@lead 立刻回复老板');
    await room.drain();
    const ran = await Promise.race([
      leadStarted.promise,
      new Promise((r) => setTimeout(() => r(false), 500)),
    ]);
    assert.equal(ran, true, '人类触发的 @lead 绝不能被 Fan-in 阻塞');

    bobGate.resolve();
    await draining;
  } finally {
    bobGate.resolve();
    await cleanupRoom(room, store, dir);
  }
});

/* ---------- 5. 并发隔离 + 并发 _pause 保护 ---------- */

test('并发隔离：动作回注按 agentId 隔离，单成员失败/常规结束不误停其他并发成员', async () => {
  const carolGate = deferred();
  const promptsByAgent = { bob: [], carol: [] };
  let bobTurn = 0;

  const { room, store, events, dir } = await makeRoom({
    members: [
      { id: 'lead', name: 'lead', role: 'leader' },
      { id: 'bob', name: 'bob', role: 'member' },
      { id: 'carol', name: 'carol', role: 'member' },
    ],
    executionMode: 'parallel',
    maxConcurrency: 4,
    headPassiveWake: false,
    resolveAdapter: (agent) => ({
      async run({ prompt }) {
        if (promptsByAgent[agent.id]) promptsByAgent[agent.id].push(prompt);
        if (agent.id === 'bob') {
          bobTurn += 1;
          if (bobTurn === 1) {
            // bob 发出一条成员无权的 task.create（会失败进 actionResults）
            return {
              text: '我试试\n```action\n{"action":"task.create","title":"越权任务"}\n```',
              reason: 'completed',
            };
          }
          return { text: 'bob 第二轮收到', reason: 'completed' };
        }
        if (agent.id === 'carol') {
          await carolGate.promise;
          return { text: 'carol 正常完成', reason: 'completed' };
        }
        return { text: 'ok', reason: 'completed' };
      },
    }),
  });

  try {
    await room.humanSay('@bob @carol 各自处理');
    const draining = room.drain();

    // bob 先完成且无 @（headPassiveWake=false），但 carol 仍在跑 → 房间不能被标成 paused！
    assert.equal(await waitFor(() => bobTurn === 1 && !room.activeTurns.has('bob')), true);
    assert.equal(room.activeTurns.has('carol'), true);
    assert.equal(room.pauseReason, null, '还有其他并发成员在跑，不能把房间标成 paused');
    assert.equal(events.some((e) => e.type === 'room.paused'), false);

    // 释放 carol
    carolGate.resolve();
    await draining;

    // carol 下一轮不应看到 bob 的失败动作回注；bob 下一轮应该看到自己的失败动作回注
    await room.humanSay('@carol 再说一句');
    await room.drain();
    assert.doesNotMatch(promptsByAgent.carol.at(-1), /越权任务|只有头头/, 'carol 不能串台看到 bob 的动作回注');

    await room.humanSay('@bob 再说一句');
    await room.drain();
    assert.match(promptsByAgent.bob.at(-1), /上一条消息里的动作执行结果/, 'bob 应准确收到自己的动作回注');
  } finally {
    carolGate.resolve();
    await cleanupRoom(room, store, dir);
  }
});

test('并发失败隔离与状态恢复：单成员失败记为 failed+lastError 且不阻断并发同伴，下次成功自动清除 failed', async () => {
  const carolGate = deferred();
  let bobFailOnce = true;

  const { room, store, events, dir } = await makeRoom({
    members: [
      { id: 'lead', name: 'lead', role: 'leader' },
      { id: 'bob', name: 'bob', role: 'member' },
      { id: 'carol', name: 'carol', role: 'member' },
    ],
    executionMode: 'parallel',
    maxConcurrency: 4,
    headPassiveWake: false,
    resolveAdapter: (agent) => ({
      async run() {
        if (agent.id === 'bob') {
          if (bobFailOnce) {
            bobFailOnce = false;
            return { text: '', reason: 'failed', error: 'API Error 400 bad model' };
          }
          return { text: 'bob 恢复成功', reason: 'completed' };
        }
        if (agent.id === 'carol') {
          await carolGate.promise;
          return { text: 'carol 顺利完成', reason: 'completed' };
        }
        return { text: 'ok', reason: 'completed' };
      },
    }),
  });

  try {
    await room.humanSay('@bob @carol 并发干活');
    const draining = room.drain();

    // bob 失败后：立即发出 failure、memberStates.bob 呈 failed + lastError，但 carol 继续跑且房间不误 pause
    assert.equal(await waitFor(() => !room.activeTurns.has('bob') && room.runtimeSnapshot().memberStates.bob.status === 'failed'), true);
    const snapMid = room.runtimeSnapshot();
    assert.match(snapMid.memberStates.bob.lastError ?? '', /API Error 400 bad model/);
    assert.equal(snapMid.memberStates.carol.status, 'running');
    assert.equal(room.pauseReason, null, 'carol 仍在运行，不能误停整间房');
    assert.ok(events.some((e) => e.type === 'failure' && e.agentId === 'bob'));

    carolGate.resolve();
    await draining;

    // bob 下一轮成功完成后，failed 标记与 lastError 自动清零
    await room.humanSay('@bob 再试一次');
    await room.drain();
    const snapAfter = room.runtimeSnapshot();
    assert.equal(snapAfter.memberStates.bob.status, 'idle');
    assert.equal(snapAfter.memberStates.bob.lastError, null);
    assert.ok(snapAfter.memberStates.bob.lastCompletedAt > 0);
  } finally {
    carolGate.resolve();
    await cleanupRoom(room, store, dir);
  }
});

/* ---------- 6. 定向打断 interrupt(agentId) + halt() + runtimeSnapshot ---------- */

test('定向 interrupt(agentId) 只杀目标成员不影响并发同伴；runtimeSnapshot 实时追踪 tool 与状态', async () => {
  const bobGate = deferred();
  const carolGate = deferred();
  let bobAborted = false;
  let carolAborted = false;

  const { room, store, events, dir } = await makeRoom({
    members: [
      { id: 'lead', name: 'lead', role: 'leader' },
      { id: 'bob', name: 'bob', role: 'member' },
      { id: 'carol', name: 'carol', role: 'member' },
    ],
    executionMode: 'parallel',
    maxConcurrency: 4,
    headPassiveWake: false,
    resolveAdapter: (agent) => ({
      async run({ onEvent, signal }) {
        if (agent.id === 'bob') {
          onEvent?.({ type: 'tool', tool: 'write_file', path: '/tmp/a.md', detail: 'write a.md' });
          await Promise.race([
            bobGate.promise,
            new Promise((res) => signal?.addEventListener('abort', () => { bobAborted = true; res(); }, { once: true })),
          ]);
          return { text: 'bob 半截', reason: bobAborted ? 'interrupted' : 'completed' };
        }
        if (agent.id === 'carol') {
          onEvent?.({ type: 'tool', tool: 'Grep', detail: 'search pattern' });
          await Promise.race([
            carolGate.promise,
            new Promise((res) => signal?.addEventListener('abort', () => { carolAborted = true; res(); }, { once: true })),
          ]);
          return { text: 'carol 完整输出', reason: carolAborted ? 'interrupted' : 'completed' };
        }
        return { text: 'ok', reason: 'completed' };
      },
    }),
  });

  try {
    await room.humanSay('@bob @carol 并发干活');
    const draining = room.drain();

    assert.equal(await waitFor(() => {
      const s = room.runtimeSnapshot();
      return s.active.length === 2 && s.memberStates.bob.toolCount === 1 && s.memberStates.carol.toolCount === 1;
    }), true);

    const midSnap = room.runtimeSnapshot();
    assert.equal(midSnap.memberStates.bob.status, 'running');
    assert.equal(midSnap.memberStates.bob.lastTool, 'write_file');
    assert.equal(midSnap.memberStates.bob.lastAction, 'write');
    assert.equal(midSnap.memberStates.carol.lastTool, 'Grep');
    assert.equal(midSnap.memberStates.carol.lastAction, 'read');
    assert.equal(midSnap.memberStates.lead.status, 'idle');

    // 定向打断 bob：只中止 bob，carol 必须继续运行，房间不误停
    assert.equal(room.interrupt('bob'), true);
    assert.equal(room.interrupt('nonexistent'), false);
    assert.equal(await waitFor(() => bobAborted && !room.activeTurns.has('bob')), true);
    assert.equal(carolAborted, false, '定向打断 bob 不能波及 carol');
    assert.equal(room.activeTurns.has('carol'), true);
    assert.equal(room.pauseReason, null, 'carol 仍在干活，不能挂房间级 interrupted pause');

    // 放行 carol 正常收尾
    carolGate.resolve();
    await draining;

    const endSnap = room.runtimeSnapshot();
    assert.equal(endSnap.active.length, 0);
    assert.equal(endSnap.memberStates.carol.status, 'idle');
    assert.ok(endSnap.memberStates.carol.lastCompletedAt > 0);
    assert.ok(events.some((e) => e.type === 'runtime.state'));
  } finally {
    bobGate.resolve();
    carolGate.resolve();
    await cleanupRoom(room, store, dir);
  }
});

test('halt() 中止全部并行活跃轮次并等待 activeTurns 清空', async () => {
  const { room, dir } = await makeRoom({
    members: [
      { id: 'bob', name: 'bob', role: 'member' },
      { id: 'carol', name: 'carol', role: 'member' },
    ],
    executionMode: 'parallel',
    maxConcurrency: 4,
    headPassiveWake: false,
    resolveAdapter: () => ({
      async run({ signal }) {
        await new Promise((res) => signal?.addEventListener('abort', res, { once: true }));
        return { text: '', reason: 'interrupted' };
      },
    }),
  });

  try {
    await room.humanSay('@bob @carol 挂起');
    const draining = room.drain();
    assert.equal(await waitFor(() => room.activeTurns.size === 2), true);

    const h = await room.halt({ timeoutMs: 3000 });
    await draining;
    assert.equal(h.killed, true);
    assert.equal(room.activeTurns.size, 0);
    assert.equal(room.current, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- 7. HTTP + SSE 集成：热切模式唤醒、定向打断、auto 增删成员阈值 ---------- */

test('HTTP：串行运行中通过 /api/room-settings 热切为并行，排队任务立刻并发启动；并支持定向 /api/interrupt', async () => {
  const { server, url, manager, dir } = await makeHttpServer({
    name: '热切并发房',
    goal: '',
    registry: [],
    aiCabTier: 'full',
    allowPeerMentions: true,
    headPassiveWake: false,
    executionMode: 'serial',
    maxConcurrency: 4,
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'agy', tier: 'full' },
      { id: 'bob', name: 'bob', role: 'member', backend: 'agy', tier: 'full' },
      { id: 'carol', name: 'carol', role: 'member', backend: 'agy', tier: 'full' },
    ],
  });

  const bobGate = deferred();
  const carolGate = deferred();
  let bobAborted = false;

  try {
    manager.session.room.resolveAdapter = (agent) => ({
      async run({ signal }) {
        const gate = agent.id === 'bob' ? bobGate : carolGate;
        let aborted = false;
        await Promise.race([
          gate.promise,
          new Promise((res) => signal?.addEventListener('abort', () => { aborted = true; res(); }, { once: true })),
        ]);
        if (agent.id === 'bob' && aborted) bobAborted = true;
        return { text: `${agent.id} done`, reason: aborted ? 'interrupted' : 'completed' };
      },
    });

    // 校验 /api/room-settings 参数合法性检查
    const badMode = await fetch(`${url}/api/room-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionMode: 'turbo' }),
    });
    assert.equal(badMode.status, 400);

    const badConc = await fetch(`${url}/api/room-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrency: 9 }),
    });
    assert.equal(badConc.status, 400);

    // 串行模式下发给 bob 和 carol：只有 bob 运行，carol 排队
    const sayRes = await fetch(`${url}/api/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '@bob @carol 开工' }),
    });
    assert.equal(sayRes.status, 200);
    assert.equal(await waitFor(() => manager.session.room.activeTurns.has('bob')), true);
    assert.equal(manager.session.room.activeTurns.size, 1);
    assert.equal(manager.session.room.queue.length, 1);

    // 在线切到 parallel：carol 必须无需等 bob 结束就立刻并发启动！
    const swRes = await fetch(`${url}/api/room-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionMode: 'parallel', maxConcurrency: 4 }),
    });
    assert.equal(swRes.status, 200);
    const swBody = await swRes.json();
    assert.equal(swBody.executionMode, 'parallel');
    assert.equal(swBody.effectiveExecutionMode, 'parallel');
    assert.equal(swBody.maxConcurrency, 4);

    assert.equal(await waitFor(() => manager.session.room.activeTurns.size === 2), true, '切并行后排队中的 carol 必须立刻启动');

    // 校验 /api/health 实时并发字段
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.activeCount, 2);
    assert.deepEqual(health.activeAgents.sort(), ['bob', 'carol']);
    assert.equal(health.executionMode, 'parallel');
    assert.equal(health.effectiveExecutionMode, 'parallel');
    assert.equal(health.maxConcurrency, 4);

    // 校验 /events 初始帧带 executionMode / runtime 与 snapshot.activeCount
    const { init, snapshot } = await fetchInitialFrames(url);
    assert.equal(init.executionMode, 'parallel');
    assert.equal(init.effectiveExecutionMode, 'parallel');
    assert.equal(init.maxConcurrency, 4);
    assert.equal(init.runtime.active.length, 2);
    assert.equal(snapshot.activeCount, 2);
    assert.equal(snapshot.runtime.active.length, 2);

    // 校验 POST /api/interrupt 定向打断 bob
    const intRes = await fetch(`${url}/api/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'bob' }),
    });
    assert.equal(intRes.status, 200);
    const intBody = await intRes.json();
    assert.equal(intBody.ok, true);
    assert.equal(intBody.agentId, 'bob');
    assert.equal(await waitFor(() => bobAborted && !manager.session.room.activeTurns.has('bob')), true);
    assert.equal(manager.session.room.activeTurns.has('carol'), true, 'carol 仍在运行');

    // 释放 carol 并验证落盘
    carolGate.resolve();
    assert.equal(await waitFor(() => manager.session.room.activeTurns.size === 0), true);

    const saved = JSON.parse(await readFile(join(dir, 'rooms', 'r-a', 'room.json'), 'utf8'));
    assert.equal(saved.executionMode, 'parallel');
    assert.equal(saved.maxConcurrency, 4);
  } finally {
    bobGate.resolve();
    carolGate.resolve();
    closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP：auto 模式下增删成员跨越 maxConcurrency 阈值时，room.init 实时切换 effectiveExecutionMode', async () => {
  const { server, url, dir } = await makeHttpServer({
    name: '自动阈值房',
    goal: '',
    registry: [],
    aiCabTier: 'full',
    allowPeerMentions: true,
    headPassiveWake: true,
    executionMode: 'auto',
    maxConcurrency: 4,
    members: [
      { id: 'm1', name: 'm1', role: 'leader', backend: 'agy', tier: 'full' },
      { id: 'm2', name: 'm2', role: 'member', backend: 'agy', tier: 'full' },
      { id: 'm3', name: 'm3', role: 'member', backend: 'agy', tier: 'full' },
      { id: 'm4', name: 'm4', role: 'member', backend: 'agy', tier: 'full' },
    ],
  });

  try {
    // 4 人 → parallel
    let { init } = await fetchInitialFrames(url);
    assert.equal(init.effectiveExecutionMode, 'parallel');
    assert.equal(init.runtime.effectiveMode, 'parallel');

    // 加入第 5 人 → 自动切 serial
    const addRes = await fetch(`${url}/api/member`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'm5', backend: 'agy' }),
    });
    assert.equal(addRes.status, 200);
    const addedId = (await addRes.json()).member.id;

    ({ init } = await fetchInitialFrames(url));
    assert.equal(init.effectiveExecutionMode, 'serial');
    assert.equal(init.runtime.effectiveMode, 'serial');

    // 删除第 5 人 → 自动切回 parallel
    const remRes = await fetch(`${url}/api/member/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: addedId }),
    });
    assert.equal(remRes.status, 200);

    ({ init } = await fetchInitialFrames(url));
    assert.equal(init.effectiveExecutionMode, 'parallel');
    assert.equal(init.runtime.effectiveMode, 'parallel');
  } finally {
    closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- 8. 3 项实机发现的问题修复 ---------- */

test('实机修复：classifyTool 覆盖 write_file / edit_file / read_file / Grep / Glob / WebFetch / WebSearch', () => {
  assert.equal(classifyTool('write_file'), 'write');
  assert.equal(classifyTool('edit_file'), 'edit');
  for (const t of ['read_file', 'Grep', 'Glob', 'grep', 'glob', 'WebFetch', 'WebSearch']) {
    assert.equal(classifyTool(t), 'read', `${t} 应归类为 read`);
  }
});

test('实机修复：prompt.js 头头造人示例跟随自身后端，共享目录含并行防覆盖命名约定', () => {
  const fakeStore = { roster: new Map(), tasks: new Map(), messages: [], messagesSince: () => [] };
  const agyLead = { id: 'lead', name: '架构师', role: 'leader', tier: 'full', backend: 'agy' };
  const p = buildPrompt({
    agent: agyLead,
    room: { name: '研发室', goal: '交付 v2.1', members: [agyLead], sharedDir: '/tmp/shared', aiCabTier: 'full' },
    store: fakeStore,
    trigger: { senderId: 'human', body: '开工' },
  });

  assert.match(p, /"backend":"agy"/, '头头为 agy 时示例应使用 agy 而非硬编码 claude');
  assert.match(p, /优先使用与你一致的可用后端（agy）/);
  assert.match(p, /T-001-架构师\.md/, '共享目录段落应提示并行产出按任务号或自己名字命名独立文件');
  assert.match(p, /不要覆盖他人文件/);
});
