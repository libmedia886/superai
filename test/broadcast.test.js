/**
 * §6.4.1 广播规则。
 *  人不带 @ → 所有人依次回（头头优先）
 *  人 @A    → 只有 A 回
 *  人 @A @B → A 先、B 后
 *  agent 不带 @ → 停住
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

const members = () => [
  { id: 'bob', name: 'bob', role: 'member', backend: 'claude', cwd: '/tmp' },
  { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', cwd: '/tmp' },
  { id: 'carol', name: 'carol', role: 'member', backend: 'claude', cwd: '/tmp' },
];

async function makeRoom() {
  const dir = await mkdtemp(join(tmpdir(), 'bc-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const room = new Room({
    id: 'r', name: 'r', members: members(), store,
    resolveAdapter: () => ({ run: async () => ({ text: '', reason: 'completed' }) }),
    onEvent: (e) => events.push(e),
  });
  return { room, store, events };
}

test('人不带 @ → 全员入队，头头优先', async () => {
  const { room, events } = await makeRoom();
  const r = await room.humanSay('大家看一下这个方案');
  assert.equal(r.broadcast, true);
  assert.deepEqual(r.targets, ['lead', 'bob', 'carol'], '头头在前，其余按加入顺序');
  assert.deepEqual(room.queue.map((q) => q.agentId), ['lead', 'bob', 'carol']);
  assert.ok(events.some((e) => e.type === 'broadcast' && e.recipients.length === 3));
  assert.equal(room.waitingForHuman, false, '有人要发言，不该显示等待人类');
});

test('人 @ 单个 → 只有他被入队', async () => {
  const { room } = await makeRoom();
  const r = await room.humanSay('@bob 你看一下');
  assert.equal(r.broadcast, false);
  assert.deepEqual(r.targets, ['bob']);
  assert.deepEqual(room.queue.map((q) => q.agentId), ['bob']);
});

test('人 @ 两个 → 按出现顺序', async () => {
  const { room } = await makeRoom();
  const r = await room.humanSay('@carol 先说，然后 @bob 补充');
  assert.deepEqual(r.targets, ['carol', 'bob']);
  assert.deepEqual(room.queue.map((q) => q.agentId), ['carol', 'bob']);
});

test('@ 不存在的名字不算广播（避免"打错字导致全员被叫"）', async () => {
  const { room } = await makeRoom();
  const r = await room.humanSay('@nobody 你好 @bob');
  assert.equal(r.broadcast, false);
  assert.deepEqual(r.targets, ['bob']);
  assert.deepEqual(r.unknown, ['nobody']);
});

test('只有 @nobody 时 → 既非广播也不入队，房间停住', async () => {
  const { room } = await makeRoom();
  const r = await room.humanSay('@nobody 你好');
  assert.equal(r.targets.length, 0);
  assert.deepEqual(room.queue, []);
  assert.equal(room.waitingForHuman, true);
});

test('广播时人类插话可入队（不打断，排队语义）', async () => {
  const { room } = await makeRoom();
  await room.humanSay('大家看一下');
  const before = room.queue.length;
  await room.humanSay('@carol 你先别说了，只回一句');
  assert.equal(room.queue.length, before, 'carol 已在队列，不重复入队');
  await room.humanSay('@lead 追加一句');
  assert.ok(room.queue.some((q) => q.agentId === 'lead'));
});

test('广播不会被误判成循环：人类触发的轮次重置链条', async () => {
  const { room, events } = await makeRoom();
  room.guard.record({ agentId: 'bob' });
  room.guard.record({ agentId: 'bob' });
  room.guard.record({ agentId: 'bob' });

  // 模拟一轮人类触发的发言
  await room._detectLoop({ id: 'bob', name: 'bob' }, '随便一段话', { reset: true });
  assert.equal(room.guard.consecutive, 0, '人类触发应重置循环计数');
  assert.equal(room.guard.chainDepth, 0);
  assert.equal(room.guard.totalTurns, 0);
  assert.ok(!events.some((e) => e.type === 'loop.warning'));
});

test('AI 之间的接龙仍然会被检测', async () => {
  const { room, events } = await makeRoom();
  const bob = { id: 'bob', name: 'bob' };
  for (let i = 0; i < 5; i += 1) {
    await room._detectLoop(bob, `第 ${i} 条`, { reset: false });
  }
  assert.ok(events.some((e) => e.type === 'loop.warning'), '连续 5 次应触发提示');
});
