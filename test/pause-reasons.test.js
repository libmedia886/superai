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
