/**
 * 头头被动唤醒（B 项需求）。
 *
 * 老板原话："任何人在群里评论，即使不 at，头头都能收到。他可以回复，也可以不回复。"
 *
 * 这组测试盯的都是"会失控"的地方：
 *  - 头头无 @ 不能再叫醒任何人（否则乒乓）
 *  - 多条无 @ 消息合并成一轮（否则 token 爆炸）
 *  - 不计入护栏（否则警告失去意义）
 *  - 接管期间不唤醒
 *  - "已读未回应"必须能被识别，且不能把正常短回复误判成未回应
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room, isPassReply } from '../src/core/room.js';

function fakeAdapter(textFor) {
  const adapter = { calls: [] };
  adapter.run = async ({ prompt, onEvent }) => {
    const who = adapter.current;
    const text = typeof textFor === 'function' ? textFor(who, adapter.calls.length) : textFor;
    adapter.calls.push({ who, prompt });
    onEvent?.({ type: 'meta', sessionId: `s-${adapter.calls.length}` });
    if (text) onEvent?.({ type: 'text', text, done: false });
    onEvent?.({ type: 'text', text: '', done: true });
    return { sessionId: `s-${adapter.calls.length}`, text, reason: 'completed', usage: null };
  };
  return adapter;
}

async function makeRoom({ members, textFor, headPassiveWake = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'passive-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const list = members ?? [
    { id: 'lead', name: 'lead', role: 'leader' },
    { id: 'bob', name: 'bob', role: 'member' },
    { id: 'carol', name: 'carol', role: 'member' },
  ];
  const adapter = fakeAdapter(textFor ?? '收到');
  const events = [];
  const room = new Room({
    id: 'r1', name: '测试',
    members: list.map((m) => ({ backend: 'claude', tier: 'readonly', cwd: dir, aliases: [m.name], ...m })),
    store,
    resolveAdapter: (agent) => { adapter.current = agent.id; return adapter; },
    onEvent: (e) => events.push(e),
    headPassiveWake,
  });
  return { room, store, adapter, events };
}

test('isPassReply：空与明确标记算免回应，正常短回复不算', () => {
  for (const t of ['', '   ', '[PASS]', 'PASS', 'no_reply', '无需回应', '不用回复。']) {
    assert.equal(isPassReply(t), true, `「${t}」应算免回应`);
  }
  for (const t of ['好', '收到', '我来看一下', '[PASS] 但另外…']) {
    assert.equal(isPassReply(t), false, `「${t}」不算免回应`);
  }
});

test('★ 成员无 @ 发言 → 只叫醒头头，其他成员不叫', async () => {
  const { room, events } = await makeRoom();

  await room._passiveWake(
    room.members.find((m) => m.id === 'bob'),
    { id: 'M-1', senderId: 'bob', body: '随便说一句' },
    { taskId: null },
  );

  const queued = room.queue.map((q) => q.agentId);
  assert.deepEqual(queued, ['lead'], '只叫头头');
  assert.ok(events.some((e) => e.type === 'head.passive_wake'));
});

test('★ 多条无 @ 消息合并成一轮（不排队跑 N 轮）', async () => {
  const { room } = await makeRoom();
  const bob = room.members.find((m) => m.id === 'bob');
  const carol = room.members.find((m) => m.id === 'carol');

  room._passiveWake(bob, { id: 'M-1', senderId: 'bob', body: '一' }, { taskId: null });
  room._passiveWake(carol, { id: 'M-2', senderId: 'carol', body: '二' }, { taskId: null });
  room._passiveWake(bob, { id: 'M-3', senderId: 'bob', body: '三' }, { taskId: null });

  assert.equal(room.queue.filter((q) => q.agentId === 'lead').length, 1, '头头只排一轮');
  assert.equal(room._passiveBatch.messages.length, 3, '三条都要并入这一轮');
});

test('★ 头头无 @ 发言不再叫醒任何人（链条最多一跳）', async () => {
  const { room } = await makeRoom();
  const lead = room.members.find((m) => m.id === 'lead');
  const woke = room._passiveWake(lead, { id: 'M-9', senderId: 'lead', body: '我随便说说' }, { taskId: null });
  assert.equal(woke, false);
  assert.equal(room.queue.length, 0);
});

test('接管期间不唤醒头头', async () => {
  const { room } = await makeRoom();
  room.takeOver();
  const woke = room._passiveWake(
    room.members.find((m) => m.id === 'bob'),
    { id: 'M-1', senderId: 'bob', body: 'hi' },
    { taskId: null },
  );
  assert.equal(woke, false);
  assert.equal(room.queue.length, 0);
});

test('房间级开关关掉 → 不唤醒', async () => {
  const { room } = await makeRoom({ headPassiveWake: false });
  const woke = room._passiveWake(
    room.members.find((m) => m.id === 'bob'),
    { id: 'M-1', senderId: 'bob', body: 'hi' },
    { taskId: null },
  );
  assert.equal(woke, false);
});

test('没有头头时无 @ 消息不会唤醒任何人（不报错）', async () => {
  const { room } = await makeRoom({
    members: [{ id: 'bob', name: 'bob', role: 'member' }],
  });
  const woke = room._passiveWake(
    room.members[0], { id: 'M-1', senderId: 'bob', body: 'hi' }, { taskId: null },
  );
  assert.equal(woke, false);
});

test('★ 被动唤醒不推进护栏计数（否则警告天天响）', async () => {
  const { room, store } = await makeRoom({ textFor: '[PASS]' });

  for (let i = 0; i < 6; i += 1) {
    room._passiveWake(
      room.members.find((m) => m.id === 'bob'),
      { id: `M-${i}`, senderId: 'bob', body: `第${i}条` },
      { taskId: null },
    );
    await room.drain();
  }
  assert.equal(room.guard.totalTurns, 0, '被动机器人轮次不能计入累计');
  assert.equal(room.guard.consecutive, 0);
  assert.equal(store.loopWarnings.length, 0);
});

test('★ 头头回 [PASS] → 存成"已读未回应"，不是失败', async () => {
  const { room, store } = await makeRoom({ textFor: '[PASS]' });

  room._passiveWake(
    room.members.find((m) => m.id === 'bob'),
    { id: 'M-1', senderId: 'bob', body: '闲聊一句' },
    { taskId: null },
  );
  await room.drain();

  const last = store.messages[store.messages.length - 1];
  assert.equal(last.senderId, 'lead');
  assert.equal(last.passed, true);
  assert.equal(last.status, 'completed', '不能记成失败');
});

test('★ 端到端：成员真的说完一轮（无 @）→ 头头被叫起，且 prompt 里能看到那几条', async () => {
  const answers = { bob: '我随手记一句，没点名', lead: '[PASS]' };
  const { room, adapter } = await makeRoom({ textFor: (who) => answers[who] ?? '' });

  // 人 @ bob，bob 回话时不 @ 任何人
  await room.humanSay('@bob 你怎么看');
  await room.drain();

  assert.deepEqual(adapter.calls.map((c) => c.who), ['bob', 'lead'], 'bob 说完应该轮到头头');
  const leadPrompt = adapter.calls[1].prompt;
  assert.match(leadPrompt, /没有 @ 你/, '要明确告诉头头这些消息没点名它');
  assert.match(leadPrompt, /我随手记一句/, '合并批次的内容必须进 prompt');
  assert.match(leadPrompt, /\[PASS\]/, '要告诉它怎么表示"不需要回应"');
});

test('★ 端到端：头头回话也 @ 了谁 → 正常接力（被动唤醒不打断原有接力）', async () => {
  const answers = { bob: '我记一句', lead: '@carol 你接一下' };
  const { room, adapter } = await makeRoom({ textFor: (who) => answers[who] ?? '' });

  await room.humanSay('@bob 说说');
  await room.drain();

  assert.deepEqual(adapter.calls.map((c) => c.who), ['bob', 'lead', 'carol']);
});

test('★ 刚对我说话的头头不再被我无 @ 的回复叫醒（防不受监控的死循环）', async () => {
  const answers = { bob: '我不知道，你先说吧', lead: '@bob 你说说' };
  const { room, adapter } = await makeRoom({ textFor: (who) => answers[who] ?? '' });

  // 头头被叫醒后 @bob；bob 回一句不 @ 任何人。
  // 如果这里又去叫醒 lead，就形成 lead→bob→lead 的环，而这条路径不计入 LoopGuard。
  room._enqueue('bob', {
    triggerMsg: { id: 'M-trigger', senderId: 'lead', body: '@bob 你说说' },
    taskId: null,
    source: 'agent',
  });
  await room.drain();

  assert.deepEqual(adapter.calls.map((c) => c.who), ['bob'], 'bob 说完就停，不能回头叫醒 lead');
  assert.equal(room.pauseReason?.reason, 'no_target', '并且要说清楚为什么停');
});
