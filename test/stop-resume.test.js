/**
 * 停止 / 恢复。
 *
 * 这是一个真实事故的回归测试：老板点过一次「停止」，之后 @111 / @lead
 * 一共四条消息全部 200 OK 却没有一个回复。根因是 drain 的
 * `while (queue.length && !this.stopped)` —— 停止后 drain 立刻退出，
 * 任务永远留在队列里，而 `resumeRoom()` 全项目没有调用点。
 *
 * 所以这里测的不是"停止能停下"，而是**停下之后还能重新动起来**，
 * 以及"界面能看见它是停着的"（刷新之后也要能）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

/** 一句话就答完的假 adapter：用来数它到底跑了几轮 */
function countingAdapter(text = '收到') {
  const adapter = {
    calls: 0,
    async run({ onEvent }) {
      adapter.calls += 1;
      onEvent?.({ type: 'meta', sessionId: `s-${adapter.calls}` });
      onEvent?.({ type: 'text', text, done: false });
      onEvent?.({ type: 'text', text: '', done: true });
      onEvent?.({ type: 'done', ok: true, reason: 'completed' });
      return { sessionId: `s-${adapter.calls}`, text, reason: 'completed', usage: null };
    },
  };
  return adapter;
}

async function makeRoom({ members = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'stop-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const agents = [
    { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['lead'] },
    { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['bob'] },
  ].slice(0, members);
  const adapter = countingAdapter();
  const events = [];
  const room = new Room({
    id: 'r1', name: '测试', members: agents, store,
    resolveAdapter: () => adapter,
    onEvent: (e) => events.push(e),
  });
  return { room, store, adapter, events, dir };
}

test('★ 停止后 humanSay 自动恢复，并且真的跑了一轮（事故回归）', async () => {
  const { room, adapter, events } = await makeRoom();

  room.stop();
  assert.equal(room.stopped, true);

  const r = await room.humanSay('@lead 你好');
  assert.equal(room.stopped, false, '人说话必须自动解除停止');
  assert.equal(r.resumed, true);
  assert.ok(events.some((e) => e.type === 'resumed'), '要有一条"已恢复"的提示');

  await room.drain();
  assert.equal(adapter.calls, 1, '恢复后必须真的发起一轮，而不是消息躺在队列里');
});

test('★ 停止后 drain 不会偷偷把队列吃掉（停止就是停止）', async () => {
  const { room, adapter } = await makeRoom();
  await room.humanSay('@lead 做点事');
  room.stop();
  await room.drain();
  assert.equal(adapter.calls, 0, '停止后不该再跑任何一轮');
  assert.equal(room.queue.length, 0, 'stop 要清空队列');
});

test('停止清空队列并如实报告丢弃条数', async () => {
  const { room } = await makeRoom();
  room.queue.push(
    { agentId: 'lead', triggerMsg: {}, taskId: null },
    { agentId: 'bob', triggerMsg: {}, taskId: null },
  );
  const r = room.stop();
  assert.equal(r.dropped, 2);
  assert.equal(room.queue.length, 0);
});

test('resumeRoom 幂等：没停的时候调用不报错也不重复发事件', async () => {
  const { room, events } = await makeRoom();
  const first = room.resumeRoom();
  assert.equal(first.changed, false);
  assert.equal(events.filter((e) => e.type === 'resumed').length, 0);
});

test('★ isStopped 反映真实状态（/api/health 与 room.init 都用它）', async () => {
  const { room } = await makeRoom();
  assert.equal(room.isStopped, false);
  room.stop();
  assert.equal(room.isStopped, true);
  room.resumeRoom();
  assert.equal(room.isStopped, false);
});

test('★ drain 重入：停止后人在 turn 收尾期间说话也不会丢消息', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stop-race-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();

  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const room = new Room({
    id: 'r1', name: 't',
    members: [{ id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['lead'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        calls += 1;
        const my = calls;
        if (my === 1) await gate;   // 第一轮挂住，模拟"正在跑"
        onEvent?.({ type: 'text', text: `第${my}轮`, done: false });
        return { text: `第${my}轮`, sessionId: `s${my}`, reason: 'completed', usage: null };
      },
    }),
  });

  // 第一轮开始
  await room.humanSay('@lead 一');
  const firstDrain = room.drain();
  await new Promise((r) => setTimeout(r, 20));

  // drain 还在栈上时停止，再让人说话（这正是事故的时序）
  room.stop();
  release();
  await firstDrain;

  await room.humanSay('@lead 二');
  const secondDrain = room.drain();
  await secondDrain;

  assert.equal(room.queue.length, 0, '第二条消息不能被晾在队列里');
  assert.equal(calls, 2, '恢复后应该跑第二轮');
});
