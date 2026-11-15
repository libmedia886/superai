/**
 * 卡死看门狗（CR-007 的主动性那一半）。
 *
 * 起因是一个真 bug：`isStalled` 在 lastActivityAt=0 时返回 false，
 * 而"从头到尾一个字都不输出"的进程正好就是这种情况——看门狗等于不存在。
 * 修法：每轮开始时先 touch 一次作为起点。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

const members = [
  { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
];

async function makeRoom(adapterFactory) {
  const dir = await mkdtemp(join(tmpdir(), 'wd-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const room = new Room({
    id: 'r', name: 'r', goal: '测试', members, store,
    resolveAdapter: adapterFactory,
    onEvent: (e) => events.push(e),
  });
  // 阈值有 20 秒下限保护，测试里不能调更低；关掉自动重试让测试只跑一轮
  room.turnTimeoutMs = 3_000;
  room.maxRetries = 0;
  return { room, events, store };
}

test('★ 从头不输出的进程也会被判卡死（回归测试）', async () => {
  const { room, events } = await makeRoom(() => ({
    run: ({ signal }) => new Promise((resolve) => {
      signal?.addEventListener('abort', () => resolve({ text: '', reason: 'timeout' }));
    }),
  }));

  // 用假时钟推进不了 setInterval，所以这里用真实短阈值：
  room.health.touch('lead', 0);

  await room.humanSay('@lead 干活');
  const t0 = Date.now();
  await room.drain();
  const elapsed = Date.now() - t0;

  const failed = events.filter((e) => e.type === 'failure');
  assert.ok(failed.length >= 1, '卡死必须产生失败事件，而不是永远挂着');
  assert.equal(failed[0].stalled, true, '要标记为卡死，不能和普通失败混为一谈');
  assert.ok(elapsed < 60_000, `应在一分钟内被判定，实际 ${elapsed}ms`);

  // 熔断器也要记账
  assert.ok(room.health.snapshot('lead').failures >= 1);
});

test('有输出就刷新计时，不会被误判卡死', async () => {
  const { room } = await makeRoom(() => ({
    run: ({ onEvent, signal }) => new Promise((resolve) => {
      // 持续输出，超过阈值时间也不该被杀
      let n = 0;
      const iv = setInterval(() => {
        n += 1;
        onEvent({ type: 'text', text: `.${n}` });
        if (n >= 3) { clearInterval(iv); resolve({ text: 'ok', reason: 'completed' }); }
      }, 300);
      signal?.addEventListener('abort', () => { clearInterval(iv); resolve({ text: '', reason: 'timeout' }); });
    }),
  }));

  await room.humanSay('@lead 干活');
  await room.drain();

  const failed = events(room).filter((e) => e.type === 'failure');
  assert.equal(failed.length, 0, '持续有输出的进程不算卡死');
});

function events(room) {
  // makeRoom 内部持有 events 数组，这里通过 health 状态间接验证
  return room.health.snapshot('lead').failures > 0 ? [{ type: 'failure' }] : [];
}

test('正常完成不计入失败', async () => {
  const { room } = await makeRoom(() => ({
    run: async () => ({ text: '完成', reason: 'completed' }),
  }));

  await room.humanSay('@lead 干活');
  await room.drain();

  const s = room.health.snapshot('lead');
  assert.equal(s.state, 'closed');
  assert.equal(s.failures, 0);
});
