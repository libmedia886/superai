/**
 * 接管 / 交还的语义。
 *
 * 四条产品决策（管理方定的）：
 *  1. 交还要有确认（界面上做，这里验服务端状态切换）
 *  2. 接管状态要能显示（状态条 badge）
 *  3. **接管期间排队的头头发言要丢弃**，不补发——那些意图已经过期
 *  4. **交还不重置熔断计数**——熔断看它自己失败几次，接管是人的决定
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

async function makeRoom() {
  const dir = await mkdtemp(join(tmpdir(), 'to-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const room = new Room({
    id: 'r', name: 'r', goal: '测试',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
      { id: 'bob', name: 'bob', role: 'member', backend: 'codex', tier: 'readonly', cwd: '/tmp' },
    ],
    store,
    resolveAdapter: () => ({ run: async () => ({ text: '收到。', reason: 'completed' }) }),
    onEvent: (e) => events.push(e),
  });
  room.turnTimeoutMs = 5_000;
  room.maxRetries = 0;
  return { room, store, events };
}

test('接管后头头被跳过，成员不受影响', async () => {
  const { room, events } = await makeRoom();
  room.takeOver();
  assert.equal(room.overridden, true);

  await room.humanSay('@lead 干活');
  await room.drain();
  assert.ok(events.some((e) => e.type === 'skipped' && e.agentId === 'lead'), '头头应被跳过');

  await room.humanSay('@bob 你干');
  await room.drain();
  assert.ok(events.some((e) => e.type === 'message' && e.message.senderId === 'bob'), '成员照常');
});

test('★ 接管时丢弃队列里过期的头头发言（不补发）', async () => {
  const { room, events } = await makeRoom();

  // 先让头头入队但别跑
  await room.humanSay('@lead 第一件事 @lead');
  const before = room.queue.length;
  assert.ok(before > 0, '头头应在队列里');

  room.takeOver();
  const leaderQueued = room.queue.filter((q) => q.agentId === 'lead');
  assert.equal(leaderQueued.length, 0, '接管应清掉排队的头头发言');

  const ev = events.find((e) => e.type === 'takeover');
  assert.ok(ev.dropped >= 1, '要如实报告丢弃了几条');
});

test('★ 交还不重置熔断计数', async () => {
  const { room } = await makeRoom();

  room.health.failure('lead');
  room.health.failure('lead');
  const before = room.health.snapshot('lead').failures;
  assert.equal(before, 2);

  room.takeOver();
  room.handBack();

  const after = room.health.snapshot('lead').failures;
  assert.equal(after, before, '接管是人的决定，不该掩盖它自己的失败记录');
});

test('交还恢复头头自动发言权', async () => {
  const { room, events } = await makeRoom();
  room.takeOver();
  room.handBack();
  assert.equal(room.overridden, false);

  await room.humanSay('@lead 现在可以了');
  await room.drain();
  assert.ok(
    events.some((e) => e.type === 'message' && e.message.senderId === 'lead'),
    '交还后头头应能正常发言',
  );
});

test('接管/交还都发事件，界面据此显示状态', async () => {
  const { room, events } = await makeRoom();
  room.takeOver();
  const t = events.find((e) => e.type === 'takeover');
  assert.ok(t, '接管要有事件');
  assert.ok(t.at, '要带时间戳');

  room.handBack();
  assert.ok(events.some((e) => e.type === 'handback'));
});

test('★ 总结消息被显式标记（否则事后分不清结论和过程）', async () => {
  const { room, events } = await makeRoom();
  await room.humanSay('@lead 先聊两句');
  await room.drain();

  await room.requestSummary('lead');
  await room.drain();

  const msgs = events.filter((e) => e.type === 'message' && e.message.senderId === 'lead');
  const summaryMsg = msgs.find((m) => m.message.isSummary === true);
  assert.ok(summaryMsg, '总结消息必须带 isSummary 标记');
  assert.ok(events.some((e) => e.type === 'summary.requested'));
  assert.ok(events.some((e) => e.type === 'summary.done'));
});

test('总结不进入接力：它 @ 谁也不继续', async () => {
  const { room } = await makeRoom();
  const dir = await mkdtemp(join(tmpdir(), 'to2-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();

  const room2 = new Room({
    id: 'r', name: 'r', goal: 't',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
      { id: 'bob', name: 'bob', role: 'member', backend: 'codex', tier: 'readonly', cwd: '/tmp' },
    ],
    store,
    // 总结时会 @bob，但不应触发 bob
    resolveAdapter: () => ({ run: async () => ({ text: '总结完毕。@bob 你注意一下。', reason: 'completed' }) }),
    onEvent: () => {},
  });
  room2.turnTimeoutMs = 5_000;
  room2.maxRetries = 0;

  await room2.requestSummary('lead');
  await room2.drain();

  assert.equal(room2.queue.length, 0, '总结 @ 了人也不该入队');
  assert.equal(room2.waitingForHuman, true);
});
