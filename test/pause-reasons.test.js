/**
 * 「总是停下来」的修法（CR-030）。
 *
 * 管理方用真实记录回放得出：19 次 agent 发言里 5 次是链条终点。
 * 三类停法：
 *  - 没 @ 任何人
 *  - 只 @ 了老板（没人可跑）
 *  - @ 了没权限叫的人（成员不能 @ 成员），而且**只弹了界面、没告诉 dave 自己被拦**
 *
 * 这里测的是：每一类停都要能叫人说得出原因，越权必须回注给发言者。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

function adapterWith(answers) {
  const adapter = { calls: [] };
  adapter.run = async ({ onEvent }) => {
    const who = adapter.current;
    const text = answers[who] ?? '';
    adapter.calls.push({ who, prompt: '' });
    onEvent?.({ type: 'meta', sessionId: `s-${adapter.calls.length}` });
    if (text) onEvent?.({ type: 'text', text, done: false });
    onEvent?.({ type: 'text', text: '', done: true });
    return { sessionId: `s-${adapter.calls.length}`, text, reason: 'completed', usage: null };
  };
  adapter.prompts = [];
  return adapter;
}

async function makeRoom({ answers = {}, members, headPassiveWake = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pause-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const list = members ?? [
    { id: 'lead', name: 'lead', role: 'leader' },
    { id: 'bob', name: 'bob', role: 'member' },
    { id: 'carol', name: 'carol', role: 'member' },
  ];
  const events = [];
  const adapter = adapterWith(answers);
  const room = new Room({
    id: 'r', name: '测试',
    members: list.map((m) => ({ backend: 'claude', tier: 'readonly', cwd: dir, aliases: [m.name], ...m })),
    store,
    resolveAdapter: (agent) => { adapter.current = agent.id; return adapter; },
    onEvent: (e) => events.push(e),
    headPassiveWake,
  });
  // 记录每次 run 的 prompt 便于断言"回注有没有进 prompt"
  const origRun = adapter.run;
  adapter.run = async (input) => {
    adapter.prompts.push({ who: adapter.current, prompt: input.prompt });
    return origRun(input);
  };
  return { room, store, adapter, events, dir };
}

test('★ 头头无 @ 说完 → 停下并给出原因（不是无声停住）', async () => {
  const { room, events } = await makeRoom({ answers: { lead: '我说完了，没点名谁' } });

  await room.humanSay('@lead 说一下');
  await room.drain();

  assert.ok(events.some((e) => e.type === 'room.paused' && e.reason === 'no_target'));
  assert.equal(room.pauseReason?.reason, 'no_target');
});

test('★ 只 @ 老板 → 停下原因说"等你"（而不是"没点名人"）', async () => {
  const { room, events } = await makeRoom({ answers: { bob: '@老板 请说说要产出什么' } });

  await room.humanSay('@bob 说说');
  await room.drain();

  const paused = events.find((e) => e.type === 'room.paused');
  assert.equal(paused.reason, 'only_human');
});

test('★ 越权 @ 被拦 → 下一轮 prompt 里明确告诉发言者（dave @carol 事故）', async () => {
  const answers = {
    bob: '@carol 等你的交付给我',
    lead: '好，我知道了你没法直接叫 carol',
  };
  const { room, adapter, events } = await makeRoom({ answers });

  await room.humanSay('@bob 把活分一下');
  await room.drain();

  // 界面提示照旧
  assert.ok(events.some((e) => e.type === 'notice' && /越权/.test(e.text ?? '')));
  // ★ 关键：回注本身
  assert.ok(room._notes?.get('bob')?.length > 0 || adapter.prompts.some((p) => p.who === 'bob' && /没有生效/.test(p.prompt)),
    '被拦的人必须知道自己的 @ 没生效');
});

test('★ 越权回注会进入下一轮的 prompt 正文（不是只弹给界面）', async () => {
  const { room, adapter } = await makeRoom({ answers: { bob: '好' } });

  room._note('bob', '你上一条消息里 @carol 没有生效');
  await room.humanSay('@bob 继续');
  await room.drain();

  const bobPrompt = adapter.prompts.find((p) => p.who === 'bob')?.prompt ?? '';
  assert.match(bobPrompt, /@carol 没有生效/, '回注必须进 prompt，否则它下次还会犯');
  assert.equal(room._notes.get('bob'), undefined, '取走即清空，不重复提示');
});

test('★ 一条消息里重复 @ 同一个人只排一次；不同消息各排一次', async () => {
  const { room } = await makeRoom();
  await room.humanSay('@bob @bob 看一下');
  assert.equal(room.queue.filter((q) => q.agentId === 'bob').length, 1);

  await room.humanSay('@bob 再看一下');
  assert.equal(room.queue.filter((q) => q.agentId === 'bob').length, 2, '新消息是新的一轮');
});

test('★ 「继续」= 清掉暂停原因 + 叫头头接着推进 + 重置接力计数', async () => {
  const answers = { lead: '我接着做', bob: '说完了' };
  const { room, events } = await makeRoom({ answers });

  await room.humanSay('@bob 说说');
  await room.drain();
  assert.ok(room.pauseReason, '先要处于停顿状态');

  room.autoAdvance.count = 3;   // 假设已经用到上限
  const r = room.continueAfterPause();
  assert.equal(r.ok, true);
  assert.equal(r.agentId, 'lead');
  assert.equal(room.pauseReason, null, '暂停原因要清掉');
  assert.equal(room.autoAdvance.count, 0, '人介入了，接力计数重来');
  assert.ok(events.some((e) => e.type === 'continue.kicked'));
});

test('「继续」在接管状态下拒绝并说明原因（不能偷偷替头头答应）', async () => {
  const { room } = await makeRoom();
  room.takeOver();
  const r = room.continueAfterPause();
  assert.equal(r.ok, false);
  assert.match(r.reason, /接管/);
});

test('★ 交回头头受 autoAdvance 上限约束：第 4 次停住并说明', async () => {
  const answers = { bob: '没点名', carol: '没点名', lead: '没点名' };
  const { room, events } = await makeRoom({ answers });

  // 直接驱动 member→head 的交回四次（每次都由人先说一句，模拟不同话题）
  for (let i = 0; i < 4; i += 1) {
    room.autoAdvance.count = 0;   // 每次人说话会重置——这里手工模拟
    await room.humanSay(`@bob 第 ${i} 件事`);
    await room.drain();
    if (i < 3) room.autoAdvance.count = i + 1;
  }
  // 第 4 次达到上限。注意 humanSay 会把计数归零（人说话＝新任务），
  // 所以要在它之后、drain 之前把计数补到上限。
  await room.humanSay('@bob 再来一件');
  room.autoAdvance.count = 3;
  await room.drain();

  const paused = events.filter((e) => e.type === 'room.paused').pop();
  assert.ok(paused, '应该停住');
  assert.equal(paused.reason, 'continue_cap');
});

/* ---------------- 指派 = 真的交给它做 ---------------- */

const ACTION_ADAPTER = (action, onlyFor = 'lead') => ({
  run: async ({ onEvent }) => {
    const who = ACTION_ADAPTER.current;
    onEvent?.({ type: 'meta', sessionId: `s-${who}` });
    const text = who === onlyFor
      ? `好。\n\`\`\`action\n${JSON.stringify(action)}\n\`\`\``
      : '收到。';
    onEvent?.({ type: 'text', text, done: false });
    return { sessionId: `s-${who}`, text, reason: 'completed', usage: null };
  },
});

async function makeActionRoom(action, { onlyFor = 'lead' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const room = new Room({
    id: 'r', name: '测试',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['lead'] },
      { id: 'data', name: '资料搜集员', role: 'member', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['资料搜集员'] },
    ],
    store,
    resolveAdapter: (agent) => {
      ACTION_ADAPTER.current = agent.id;
      return ACTION_ADAPTER(action, onlyFor);
    },
    onEvent: (e) => events.push(e),
  });
  return { room, store, events };
}

test('★ task.create 带 assignee → 被指派人真的收到一轮（不只是改字段）', async () => {
  const { room, events } = await makeActionRoom({
    action: 'task.create', title: '取 AQ-120 参数', assignee: '资料搜集员',
  });

  await room.humanSay('@lead 安排一下');
  await room.drain();

  const dispatched = events.find((e) => e.type === 'task.dispatched');
  assert.ok(dispatched, '要有 task.dispatched 事件');
  assert.equal(dispatched.agentId, 'data');
  assert.ok(room.store.tasks.size >= 1, '任务落库');
  // 被指派人的那一轮真的跑了（用请求数判断：它没有动作，回「收到。」）
  assert.ok(events.some((e) => e.type === 'message' && e.message.senderId === 'data'),
    '资料搜集员必须真的发言一轮，而不是只被写进 assignee 字段');
});

test('★ 派活之后有人真的接手：头头不会在"没人接手"上停住', async () => {
  const { room, events } = await makeActionRoom({
    action: 'task.create', title: '查资料', assignee: '资料搜集员',
  });
  await room.humanSay('@lead 派个活');
  await room.drain();

  // 关键：被派活的人干完后要能回话给头头（否则"干完了没人知道"）
  assert.ok(events.some((e) => e.type === 'task.dispatched'));
  assert.ok(
    events.some((e) => e.type === 'message' && e.message.senderId === 'data'),
    '被指派人真的跑了一轮',
  );
  assert.ok(
    events.some((e) => e.type === 'head.passive_wake'),
    '他干完要能交回头头，而不是停在"没人接手"',
  );
  // 停也可以（头头汇报完就该停），但不能停在"刚派活的头头不需要再被叫一次"上
  const detail = room.pauseReason?.detail ?? '';
  assert.doesNotMatch(detail, /不需要再被叫一次/);
});

test('★ assignee 是空 → 不进队列（不能凭空叫人）', async () => {
  const { room, events } = await makeActionRoom({ action: 'task.create', title: '无主任务' });
  await room.humanSay('@lead 建个任务');
  await room.drain();
  assert.ok(!events.some((e) => e.type === 'task.dispatched'));
  assert.equal(room.store.tasks.size, 1, '任务本身还是要建');
});

test('★ assignee 找不到 → 拒绝并回注', async () => {
  const { room, events } = await makeActionRoom({
    action: 'task.create', title: '给不存在的人', assignee: '幽灵',
  });
  await room.humanSay('@lead 派给幽灵');
  await room.drain();
  const results = events.find((e) => e.type === 'action.results')?.results ?? [];
  assert.ok(results.some((r) => !r.ok && /找不到成员/.test(r.reason ?? '')));
});

test('★ task.update 改派给别人 → 新人被叫起来；改成完成 → 不叫', async () => {
  const { room, store, events } = await makeActionRoom({
    action: 'task.update', id: 'T-001', assignee: '资料搜集员',
  });
  await store.createTask({
    id: 'T-001', title: '已有任务', assignee: null, status: '待办', createdBy: 'lead',
  });

  await room.humanSay('@lead 改派 T-001');
  await room.drain();
  assert.ok(events.some((e) => e.type === 'task.dispatched' && e.taskId === 'T-001'));

  // 状态改成完成时不派活
  const { room: r2, store: s2, events: e2 } = await makeActionRoom({
    action: 'task.update', id: 'T-002', status: '已完成', assignee: '资料搜集员',
  });
  await s2.createTask({ id: 'T-002', title: 'x', assignee: null, status: '待办', createdBy: 'lead' });
  await r2.humanSay('@lead 关掉 T-002');
  await r2.drain();
  assert.ok(!e2.some((e) => e.type === 'task.dispatched'), '完成的任务不该再叫人');
  assert.equal(s2.tasks.get('T-002').status, '完成', '同义词归一化后落库');
});

/* ---------------- CR-035：失败轮次不能被"说完了"覆盖 ---------------- */

test('★ 失败的一轮不进接力，且原因压得住 no_target（CR-035 事故回归）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr035-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];

  const room = new Room({
    id: 'r', name: '测试',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['lead'] },
      { id: 'm', name: 'm', role: 'member', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['m'] },
    ],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        // 失败：没有产出、reason 是 failed（不是 timeout，也不是 aborted）
        return { text: '', sessionId: 's', reason: 'failed', usage: null };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  room.maxRetries = 0;

  await room.humanSay('@m 干活');
  await room.drain();

  assert.equal(room.pauseReason?.reason, 'error',
    '失败必须显示成失败，不能被覆盖成"说完了，没点名下一位"');
  assert.match(room.pauseReason.detail, /失败/);
  assert.ok(!events.some((e) => e.type === 'room.paused' && e.reason === 'no_target'),
    '不能再发出 no_target 的暂停事件');
});

test('★ 失败轮次不把话传给下一位（它没有可交接的产出）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cr035b-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const calls = [];
  const room = new Room({
    id: 'r', name: '测试',
    members: [
      { id: 'a', name: 'a', role: 'member', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] },
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['lead'] },
    ],
    store,
    resolveAdapter: (agent) => ({
      async run({ onEvent }) {
        calls.push(agent.id);
        onEvent?.({ type: 'meta', sessionId: 's' });
        return { text: '', sessionId: 's', reason: 'failed', usage: null };
      },
    }),
    onEvent: () => {},
  });
  room.maxRetries = 0;

  await room.humanSay('@a 干活');
  await room.drain();
  assert.deepEqual(calls, ['a'], '失败之后不该自动叫头头');
  assert.equal(room.queue.length, 0);
});

test('优先级：timeout 压得住后到的 no_target，但 stopped 压得住 timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prio-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const room = new Room({ id: 'r', name: 't', members: [], store, resolveAdapter: () => ({}), onEvent: () => {} });

  room._pause('timeout', '跑满 20 分钟');
  room._pause('no_target', '说完了');
  assert.equal(room.pauseReason.reason, 'timeout', '低优先级不能覆盖高优先级');

  room._pause('stopped', '你点了停止');
  assert.equal(room.pauseReason.reason, 'stopped', '停止是最高优先级');

  room._clearPause();
  room._pause('no_target', '说完了');
  assert.equal(room.pauseReason.reason, 'no_target', '清空后低优先级仍可正常使用');
});
