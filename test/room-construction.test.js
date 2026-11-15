/**
 * 房间构造的完整性。
 *
 * 起因：CR-006 接进 Room 时，`this.handoff` 一度是 undefined，
 * 因为新模块建好了但构造注入没跟上。这类疏漏的特点是——
 * **只有构造路径覆盖不全时才暴露**，写这个文件就是为了让它早点暴露。
 *
 * 原则：子模块（护栏/健康/握手）必须**内部初始化给默认值**，
 * 不能要求每个调用点都记得传，否则新加调用点就会踩。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

async function bareRoom(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ctor-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  return new Room({
    id: 'r', name: 'r',
    members: [{ id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' }],
    store,
    resolveAdapter: () => ({ run: async () => ({ text: '', reason: 'completed' }) }),
    ...overrides,
  });
}

test('★ 最小参数构造即可用：所有子系统都要有默认值', async () => {
  const room = await bareRoom();

  assert.ok(room.handoff, 'handoff 必须内部初始化，不能要求调用点传入');
  assert.equal(typeof room.handoff.canFire, 'function', '且要是可用实例');

  assert.ok(room.health, 'health 必须内部初始化');
  assert.equal(typeof room.health.canRun, 'function');

  assert.ok(room.guard, 'guard 必须内部初始化');
  assert.equal(typeof room.guard.record, 'function');

  assert.equal(room.goal, '', 'goal 缺省为空串，不是 undefined');
  assert.deepEqual(room.leaderIds, ['lead']);
});

test('构造后立刻能跑一轮（不留半初始化状态）', async () => {
  const room = await bareRoom();
  await room.humanSay('@lead 你好');
  await room.drain();
  assert.equal(room.waitingForHuman, true, '跑完应回到等待人类');
  assert.equal(room.health.snapshot('lead').state, 'closed');
});

test('多头部：构造时收集全部头头', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctor2-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const room = new Room({
    id: 'r', name: 'r',
    members: [
      { id: 'l1', name: 'l1', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
      { id: 'l2', name: 'l2', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
      { id: 'm1', name: 'm1', role: 'member', backend: 'codex', tier: 'readonly', cwd: '/tmp' },
    ],
    store,
    resolveAdapter: () => ({ run: async () => ({ text: '', reason: 'completed' }) }),
  });
  assert.deepEqual(room.leaderIds, ['l1', 'l2']);
  assert.equal(room.leaderId, 'l1', '兼容字段仍指向第一个');
});

test('没有头头的房间也能构造（全员成员）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctor3-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const room = new Room({
    id: 'r', name: 'r',
    members: [{ id: 'm1', name: 'm1', role: 'member', backend: 'codex', tier: 'readonly', cwd: '/tmp' }],
    store,
    resolveAdapter: () => ({ run: async () => ({ text: '', reason: 'completed' }) }),
  });
  assert.deepEqual(room.leaderIds, []);
  assert.equal(room.leaderId, null);
});
