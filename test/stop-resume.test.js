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

test('★ 停止与打断必须落盘（CR-036：事后要能查"谁停的、打断了谁"）', async () => {
  const { room, store } = await makeRoom();

  room.stop();
  await store.flush();

  const stopped = store.controlLog.find((c) => c.action === 'stop');
  assert.ok(stopped, '停止要落一条 control 事件');
  assert.equal(stopped.who, 'human');

  // 打断一条正在跑的轮次
  const dir = await mkdtemp(join(tmpdir(), 'ctl-'));
  const s2 = new Store(join(dir, 'room.jsonl'));
  await s2.load();
  const { Room } = await import('../src/core/room.js');
  let release;
  const gate = new Promise((r) => { release = r; });
  const r2 = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store: s2,
    resolveAdapter: () => ({
      async run({ signal }) {
        await Promise.race([gate, new Promise((res) => signal?.addEventListener('abort', res, { once: true }))]);
        return { text: '', reason: 'interrupted' };
      },
    }),
    onEvent: () => {},
  });
  await r2.humanSay('@a 干活');
  const draining = r2.drain();
  await new Promise((res) => setTimeout(res, 30));
  r2.interrupt();
  release();
  await draining;
  await s2.flush();

  const interrupted = s2.controlLog.find((c) => c.action === 'interrupt');
  assert.ok(interrupted, '打断也要落盘，否则只能看到 status:"已中断"，查不到是谁');
  assert.equal(interrupted.agentId, 'a');
});

test('打断时没有在跑的一轮 → 不落空事件（不制造噪音）', async () => {
  const { room, store } = await makeRoom();
  assert.equal(room.interrupt(), false);
  await store.flush();
  assert.equal(store.controlLog.filter((c) => c.action === 'interrupt').length, 0);
});

/* ---------- CR-036：打断之后要能「接着做完」 ---------- */

test('★ 打断 → pauseReason=interrupted + resumeTarget 记下是谁', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Room } = await import('../src/core/room.js');
  const { Store } = await import('../src/core/store.js');

  const dir = await mkdtemp(join(tmpdir(), 'resume-turn-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  let release;
  const gate = new Promise((r) => { release = r; });

  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent, signal }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        onEvent?.({ type: 'text', text: '我正在写第一段', done: false });
        await Promise.race([gate, new Promise((res) => signal?.addEventListener('abort', res, { once: true }))]);
        return { text: '我正在写第一段', sessionId: 's', reason: 'interrupted' };
      },
    }),
    onEvent: () => {},
  });

  await room.humanSay('@a 写报告');
  const draining = room.drain();
  await new Promise((r) => setTimeout(r, 40));
  room.interrupt();
  release();
  await draining;

  assert.equal(room.pauseReason?.reason, 'interrupted');
  assert.match(room.pauseReason.detail, /接着做完/);
  assert.ok(room.resumeTarget, '要记下被中断的人，否则「继续」不知道找谁');
  assert.equal(room.resumeTarget.agentId, 'a');
  assert.ok(room.resumeTarget.partialChars > 0, '已输出的字数要说出来');
});

test('★ 「接着做完」→ 同一成员真的再跑一轮', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Room } = await import('../src/core/room.js');
  const { Store } = await import('../src/core/store.js');

  const dir = await mkdtemp(join(tmpdir(), 'resume-turn2-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let first = true;

  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent, signal }) {
        calls.push(agent => agent);
        onEvent?.({ type: 'meta', sessionId: 's' });
        if (first) {
          first = false;
          await Promise.race([gate, new Promise((res) => signal?.addEventListener('abort', res, { once: true }))]);
          return { text: '半截', sessionId: 's', reason: 'interrupted' };
        }
        onEvent?.({ type: 'text', text: '做完了', done: false });
        return { text: '做完了', sessionId: 's', reason: 'completed', usage: null };
      },
    }),
    onEvent: () => {},
  });

  await room.humanSay('@a 写报告');
  const draining = room.drain();
  await new Promise((r) => setTimeout(r, 40));
  room.interrupt();
  release();
  await draining;

  const before = calls.length;
  const r = room.resumeInterruptedTurn();
  assert.equal(r.ok, true);
  assert.equal(r.agentId, 'a');
  assert.equal(room.resumeTarget, null, '取走即清空，不能反复续做同一轮');
  await room.drain();
  assert.ok(calls.length > before, '续做必须真的再跑一轮');
  // 续做跑完后又停住了（它没 @ 任何人）——但停下来是因为"说完了"，
  // 不能还是 "interrupted"（那会让人以为活还没接上）
  assert.notEqual(room.pauseReason?.reason, 'interrupted',
    '续做之后不能再挂着"被打断"的旧原因');
});

test('没有被中断的轮次时「接着做完」明确报错（不静默失败）', async () => {
  const { room } = await makeRoom();
  const r = room.resumeInterruptedTurn();
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有/);
});

test('成功完成会清掉 resumeTarget（否则「接着做完」会回到已经做完的活）', async () => {
  const { room, store } = await makeRoom();
  room.resumeTarget = { agentId: 'lead', taskId: null };
  await room.humanSay('@lead 再说一句');
  await room.drain();
  assert.equal(room.resumeTarget, null);
  assert.ok(store.messages.length > 0);
});

test('★ 暂停原因要落盘：重启后仍能回答"为什么停着"', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Room } = await import('../src/core/room.js');
  const { Store } = await import('../src/core/store.js');

  const dir = await mkdtemp(join(tmpdir(), 'pause-persist-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const room = new Room({
    id: 'r', name: 't', members: [], store, resolveAdapter: () => ({}), onEvent: () => {},
  });
  room._pause('timeout', '跑满 20 分钟被中止');
  await store.flush();

  // 重启：重新读同一个 jsonl
  const store2 = new Store(join(dir, 'room.jsonl'));
  await store2.load();
  assert.equal(store2.pause?.reason, 'timeout', '暂停原因必须能从事件流恢复');
  assert.match(store2.pause.detail, /20 分钟/);

  const room2 = new Room({
    id: 'r', name: 't', members: [], store: store2, resolveAdapter: () => ({}), onEvent: () => {},
  });
  assert.equal(room2.pauseReason?.reason, 'timeout', '新 Room 要接上这个原因');

  // 恢复后也要落盘（否则重启又回到旧的暂停状态）
  room2._clearPause();
  await store2.flush();
  const store3 = new Store(join(dir, 'room.jsonl'));
  await store3.load();
  assert.equal(store3.pause, null);
});
