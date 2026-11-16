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

/* ---------------- 撞上限自动续做（管理方的 MGMT 补丁）+ 打断要有原因 ---------------- */

test('★ 撞上限但在干活（有工具调用）→ 自动续做，且不再标"失败"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capcont-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  let round = 0;

  const room = new Room({
    id: 'r', name: '测试',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        round += 1;
        onEvent?.({ type: 'meta', sessionId: 's' });
        onEvent?.({ type: 'tool', tool: 'Bash', command: 'curl …' });
        if (round === 1) return { text: '', sessionId: 's', reason: 'timeout', usage: null };
        onEvent?.({ type: 'text', text: '续做完成', done: false });
        return { text: '续做完成', sessionId: 's', reason: 'completed', usage: null };
      },
    }),
    onEvent: (e) => events.push(e),
  });

  await room.humanSay('@a 取证');
  await room.drain();

  const cont = events.find((e) => e.type === 'cap.continue');
  assert.ok(cont, '撞上限且有工具调用 → 自动续做');
  assert.equal(cont.toolCalls, 1);
  assert.equal(round, 2, '第二轮真的跑了');
  assert.ok(!events.some((e) => e.type === 'room.paused' && e.reason === 'error'),
    '已经自动续做，就不能再挂"失败"——否则界面和实际状态相反');
});

test('★ 撞上限但没跑过工具 → 不续做，直接说超时（那是空转）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capcont2-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const room = new Room({
    id: 'r', name: '测试',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        return { text: '', sessionId: 's', reason: 'timeout', usage: null };
      },
    }),
    onEvent: (e) => events.push(e),
  });

  await room.humanSay('@a 想事情');
  await room.drain();

  assert.ok(!events.some((e) => e.type === 'cap.continue'), '没有工具调用就是空转，不该续做');
  // 只读档会自动重试，重试后仍空转 → 熔断。两者都是真实原因；
  // 关键是**绝不能**落到 no_target（"说完了"）。
  assert.ok(['timeout', 'breaker'].includes(room.pauseReason?.reason),
    `应是超时或熔断，实际：${room.pauseReason?.reason}`);
});

test('★ 被打断的轮次必须留下原因（不能显示成"等待人类"）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abort-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  let release;
  const gate = new Promise((r) => { release = r; });

  const room = new Room({
    id: 'r', name: '测试',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent, signal }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        await Promise.race([gate, new Promise((res) => signal?.addEventListener('abort', res, { once: true }))]);
        return { text: '', sessionId: 's', reason: 'interrupted' };
      },
    }),
    onEvent: (e) => events.push(e),
  });

  await room.humanSay('@a 干活');
  const draining = room.drain();
  await new Promise((r) => setTimeout(r, 30));
  room.interrupt();
  release();
  await draining;

  assert.equal(room.pauseReason?.reason, 'interrupted',
    '打断后不能是 null/等待人类，否则用户不知道这轮被打断了');
});

test('★ 撞上限续做的那一轮，prompt 里要说明"这不是失败，接着做"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capcont3-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const prompts = [];
  let round = 0;

  const room = new Room({
    id: 'r', name: '测试',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent, prompt }) {
        round += 1;
        prompts.push(prompt);
        onEvent?.({ type: 'meta', sessionId: 's' });
        onEvent?.({ type: 'tool', tool: 'Bash', command: 'curl' });
        if (round === 1) return { text: '', sessionId: 's', reason: 'timeout', usage: null };
        onEvent?.({ type: 'text', text: '做完了', done: false });
        return { text: '做完了', sessionId: 's', reason: 'completed', usage: null };
      },
    }),
    onEvent: () => {},
  });

  await room.humanSay('@a 取证');
  await room.drain();

  assert.equal(round, 2);
  assert.match(prompts[1], /被系统中止/);
  assert.match(prompts[1], /不是你的错|不是失败/, '要说清这不是失败');
  assert.match(prompts[1], /不要把?已完成|不要重写|从断掉的地方/, '要告诉它别重头再来');
});

/* ---------------- 管理方 18:12 要求的两条 ---------------- */

test('★ 被看门狗判死时的文案不能写"跑满 N 秒"（三句假话的事故）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stalltext-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];

  const room = new Room({
    id: 'r', name: '测试',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent, signal }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        // 零输出、零工具调用，等到被看门狗/中止
        await new Promise((res) => signal?.addEventListener('abort', res, { once: true }));
        return { text: '', sessionId: 's', reason: 'timeout' };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  room.maxRetries = 0;
  room.turnTimeoutMs = 4_000;

  await room.humanSay('@a 干个没输出的活');
  const draining = room.drain();
  await new Promise((r) => setTimeout(r, 120));
  room.stop();       // 人为中止，走 aborted 分支
  await draining;

  const paused = events.find((e) => e.type === 'room.paused');
  assert.ok(paused);
  // 被打断（人为）时说"被中途打断"，不该说"跑满 N 秒"
  assert.doesNotMatch(paused.detail ?? '', /跑满 \d+ 秒/, `不该声称跑满上限：${paused.detail}`);
});

test('★ 新一轮开始要清掉上一轮的暂停原因（跨轮不能比优先级）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clearpause-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  let round = 0;

  const room = new Room({
    id: 'r', name: '测试',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        round += 1;
        onEvent?.({ type: 'meta', sessionId: 's' });
        if (round === 1) return { text: '', sessionId: 's', reason: 'timeout', usage: null };
        onEvent?.({ type: 'text', text: '好了', done: false });
        return { text: '好了', sessionId: 's', reason: 'completed', usage: null };
      },
    }),
    onEvent: () => {},
  });
  room.maxRetries = 0;

  await room.humanSay('@a 第一轮');
  await room.drain();
  assert.equal(room.pauseReason?.reason, 'timeout', '第一轮留下 timeout');

  await room.humanSay('@a 第二轮');
  await room.drain();

  assert.notEqual(room.pauseReason?.reason, 'timeout',
    'timeout 已被事实推翻（第二轮成功了），不能因为优先级高就永久挂着');
});

/* ---------------- 停因文案的每个数字都必须来自真实事件 ---------------- */

/**
 * 今天从「停下不说明」修到「说明准确」改了四轮，每轮都是**文案与事实的偏差**，
 * 不是逻辑错误。所以这里对纯函数 `timeoutPauseText` 逐个数字断言：
 *   - 耗时用 durationMs（不是配置的 timeoutMs）
 *   - rowToolsInTurn === 0 不等于"没有输出"
 *   - stalled 与硬上限是两种完全不同的说法
 */
const base = {
  name: 'a', stalledOut: false, durationMs: 112_584, timeoutMs: 1_800_000,
  toolCalls: 0, textChars: 0, capContinues: 0, maxCapContinues: 2, stallMs: 90_000,
};

test('★ 看门狗判死：说"静默…判定卡死"，且耗时来自 durationMs 不是上限', async () => {
  const { timeoutPauseText } = await import('../src/core/room.js');
  const t = timeoutPauseText({ ...base, stalledOut: true });

  assert.match(t, /被看门狗判定卡死/, 'stalled:true 就是看门狗判的，不能说"没有判"');
  assert.doesNotMatch(t, /看门狗没有判/, '这是原事故里最反的一句');
  assert.match(t, /静默 90 秒/);
  assert.match(t, /耗时 113 秒/, '实际 112.6 秒 → 113；不能拿配置的 1800 秒当耗时');
  assert.doesNotMatch(t, /跑满上限 1800 秒被中止/, 'stalled 不是撞硬上限');
});

test('★ 硬上限：用"跑满上限 N 秒 + 耗时 X 秒"两个数字区分配置与事实', async () => {
  const { timeoutPauseText } = await import('../src/core/room.js');
  const t = timeoutPauseText({ ...base, stalledOut: false, durationMs: 1_800_000, toolCalls: 3 });
  assert.match(t, /跑满上限 1800 秒/);
  assert.match(t, /耗时 1800 秒/);
  assert.match(t, /3 次工具调用/);
});

test('★ rowToolsInTurn=0 但已输出正文 → 不得说"没有输出"', async () => {
  // 管理方 18:34 实测：已经输出了 9 个字，文案却说"也没有输出"
  const { timeoutPauseText } = await import('../src/core/room.js');
  const t = timeoutPauseText({ ...base, stalledOut: true, textChars: 9 });
  assert.doesNotMatch(t, /也没有输出/, `已输出内容时不能说"也没有输出"：${t}`);
  assert.match(t, /已输出 9 字/);
  assert.match(t, /接着写完|接着做完/, '要给出可操作的下一步');
});

test('★ 有工具调用时：不说空转，说"结果还在会话里"', async () => {
  const { timeoutPauseText } = await import('../src/core/room.js');
  const t = timeoutPauseText({ ...base, stalledOut: true, toolCalls: 2 });
  assert.match(t, /2 次工具调用/);
  assert.match(t, /结果都还在会话里/);
  assert.doesNotMatch(t, /空转/, '跑过工具就不能说空转');
});

test('真的什么都没干时才说"空转"', async () => {
  const { timeoutPauseText } = await import('../src/core/room.js');
  const t = timeoutPauseText({ ...base, stalledOut: true, toolCalls: 0, textChars: 0 });
  assert.match(t, /空转|没有任何工具调用、也没有输出/);
});

test('续做次数到上限时的说法要把"已续做 N 次"说出来', async () => {
  const { timeoutPauseText } = await import('../src/core/room.js');
  const t = timeoutPauseText({
    ...base, stalledOut: false, toolCalls: 4, capContinues: 2, maxCapContinues: 2,
  });
  assert.match(t, /已自动续做 2 次/);
  assert.match(t, /原地打转/);
});

/* ---------------- 「提示里的按钮必须真实存在」不变量 ---------------- */

test('★ pause.detail 提到「接着做完」时，resumeTarget 必须存在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'btnguard-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];

  const room = new Room({
    id: 'r', name: '测试',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent, signal }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        onEvent?.({ type: 'text', text: '写了九个字啊', done: false });
        await new Promise((res) => signal?.addEventListener('abort', res, { once: true }));
        return { text: '写了九个字啊', sessionId: 's', reason: 'timeout' };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  room.maxRetries = 0;
  room.turnTimeoutMs = 4_000;

  await room.humanSay('@a 干活');
  const draining = room.drain();
  await new Promise((r) => setTimeout(r, 100));
  room.stop();
  await draining;

  const paused = events.find((e) => e.type === 'room.paused' && /接着做完/.test(e.detail ?? ''));
  if (paused) {
    assert.ok(paused.resumeTarget, '文案让用户点「接着做完」，就必须真的有可续的轮次');
  }
});

test('★ timeout 且有产出 → 设 resumeTarget（让按钮变成「接着做完」）', async () => {
  const { Room } = await import('../src/core/room.js');
  // 纯函数层面验不了 resumeTarget，这里用源码断言 + 行为测（上面那条）
  const src = Room.prototype._runTurn.toString();
  assert.match(src, /didSomething/, '要判断"有没有产出"');
  assert.match(src, /this\.resumeTarget = \{/, 'timeout 分支也要设 resumeTarget');
});

test('★ 纯空转（0 工具 0 输出）不设 resumeTarget —— 没有可续的东西', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'btnguard2-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();

  const room = new Room({
    id: 'r', name: '测试',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    // 直接返回 timeout（模拟撞硬上限被中止），不经过 abort
    resolveAdapter: () => ({
      async run({ onEvent }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        return { text: '', sessionId: 's', reason: 'timeout' };
      },
    }),
    onEvent: () => {},
  });
  room.maxRetries = 0;

  await room.humanSay('@a 干个没输出的活');
  await room.drain();

  assert.equal(room.resumeTarget, null, '什么都没干过，没有可续的轮次');
  assert.doesNotMatch(room.pauseReason?.detail ?? '', /接着做完|接着写/,
    '没有可续的东西就不该让用户去点');
});

/* ---------------- 双入队守卫（INBOX 欠了 5 轮的行为测试） ---------------- */

/**
 * `capAutoContinued ? {retry:false} : retryDecision(...)` 是"同一轮被入队两次、
 * 白跑一轮"的唯一防线。之前只有 `invariants.test.js` 的文本检查——
 * 那只能证明"这行代码还在"，不能证明"它真的挡住了"。
 *
 * 这里构造两条路径**同时成立**的场景：
 *   - 撞上限续做：非 stalled、有工具调用、未到 MAX_CAP_CONTINUES
 *   - 失败重试：readonly 档 + timeout + 未到 maxAttempts
 * 然后断言：队列只多 1 条、第二轮只跑 1 次。
 */
test('★ 双入队守卫：撞上限续做与失败重试同时成立时，只入队 1 次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'double-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const runs = [];

  const room = new Room({
    id: 'r', name: '测试',
    // readonly 档：retryDecision 本来会允许 timeout 重试
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        runs.push(1);
        onEvent?.({ type: 'meta', sessionId: 's' });
        // 有工具调用 → 满足"撞上限续做"；非 stalled → canContinue 成立
        onEvent?.({ type: 'tool', tool: 'Bash', command: 'curl' });
        if (runs.length === 1) return { text: '', sessionId: 's', reason: 'timeout', usage: null };
        onEvent?.({ type: 'text', text: '做完了', done: false });
        return { text: '做完了', sessionId: 's', reason: 'completed', usage: null };
      },
    }),
    onEvent: () => {},
  });
  room.maxRetries = 2;   // 确保"失败重试"那条路也成立

  await room.humanSay('@a 取证');
  await room.drain();

  assert.equal(runs.length, 2,
    `第一轮超时后只应该续做一次、共 2 轮；实际跑了 ${runs.length} 轮（>2 说明被双入队）`);
  // 队列在 drain 结束时应当空
  assert.equal(room.queue.length, 0);
});

test('★ 双入队守卫：续做那一轮若又撞上限，仍只各入队 1 次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'double2-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const runs = [];
  const events = [];

  const room = new Room({
    id: 'r', name: '测试',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        runs.push(1);
        onEvent?.({ type: 'meta', sessionId: 's' });
        onEvent?.({ type: 'tool', tool: 'Bash', command: 'curl' });
        // 每一轮都超时，直到 MAX_CAP_CONTINUES 用完
        return { text: '', sessionId: 's', reason: 'timeout', usage: null };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  room.maxRetries = 2;

  await room.humanSay('@a 一直取证');
  await room.drain();

  // MAX_CAP_CONTINUES = 2 → 首轮 + 2 次续做 = 3 轮，之后停止
  const { MAX_CAP_CONTINUES } = await import('../src/core/room.js');
  assert.equal(runs.length, MAX_CAP_CONTINUES + 1,
    `应该是首轮 + ${MAX_CAP_CONTINUES} 次续做；实际 ${runs.length} 轮`);
  // 每一轮都只续做一次：cap.continue 事件条数 == 上限，不能多
  const continues = events.filter((e) => e.type === 'cap.continue');
  assert.equal(continues.length, MAX_CAP_CONTINUES,
    `每次续做只该发一条 cap.continue；实际 ${continues.length} 条（>上限说明双入队）`);
  assert.deepEqual(continues.map((e) => e.attempt), [1, 2], '续做次数要递增，不能重复');
  assert.ok(room.pauseReason, '续做用完应当停下并说明原因');
  // 停下的原因可能是 timeout 也可能是 breaker（连续失败同样成立）——
  // 两者都是真话，重点是不能停在一个"没事发生"的原因上。
  assert.ok(['timeout', 'breaker'].includes(room.pauseReason.reason),
    `实际停因：${room.pauseReason.reason}`);
});

test('★ 双入队守卫：只有失败重试那一条成立时，正常走重试', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'single-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const runs = [];

  const room = new Room({
    id: 'r', name: '测试',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        runs.push(1);
        onEvent?.({ type: 'meta', sessionId: 's' });
        // 零工具调用 → 不满足"撞上限续做"，只有失败重试成立
        if (runs.length === 1) return { text: '', sessionId: 's', reason: 'timeout', usage: null };
        onEvent?.({ type: 'text', text: '好了', done: false });
        return { text: '好了', sessionId: 's', reason: 'completed', usage: null };
      },
    }),
    onEvent: () => {},
  });
  room.maxRetries = 2;

  await room.humanSay('@a 想事情');
  await room.drain();

  assert.equal(runs.length, 2, '失败重试仍然生效（不能因为加了守卫而把这条路也堵死）');
});
