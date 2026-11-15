/**
 * continue 动作（自动推进）。
 *
 * 背景：房间默认"没人 @ 就停住"，防两个 AI 互相吹捧。但有些任务确实要连续推进。
 * 所以给一个**显式**手段，而不是改默认行为——否则会变成无限互刷。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';
import { AutoAdvanceGuard } from '../src/core/autoadvance.js';
import { validateAction, authorize } from '../src/core/actions.js';

async function makeRoom({ continues = true, reply } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cont-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  let n = 0;
  const room = new Room({
    id: 'r', name: 'r', goal: 't',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
      { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
      { id: 'carol', name: 'carol', role: 'member', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
    ],
    store,
    resolveAdapter: () => ({
      run: async () => {
        n += 1;
        const text = reply ?? (continues
          ? `第 ${n} 轮。\n\`\`\`action\n{"action":"continue","localId":"c${n}","reason":"还有下一步没做"}\n\`\`\``
          : `第 ${n} 轮，完事了。`);
        return { text, reason: 'completed' };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  room.turnTimeoutMs = 5_000;
  room.maxRetries = 0;
  return { room, events };
}

/* ---------- 校验 ---------- */

test('continue 必须带 reason', () => {
  assert.match(validateAction({ action: 'continue' }), /需要 reason/);
  assert.match(validateAction({ action: 'continue', reason: '' }), /需要 reason/);
});

test('reason 太短也算不合格（防敷衍）', () => {
  assert.match(validateAction({ action: 'continue', reason: '嗯' }), /太短/);
});

test('合格的 continue 通过校验', () => {
  assert.equal(validateAction({ action: 'continue', reason: '还有下一步没做' }), null);
});

test('所有角色都可以声明 continue（这不是权限，是表达需求）', () => {
  assert.equal(authorize({ action: 'continue' }, { role: 'member', actorId: 'bob' }), null);
  assert.equal(authorize({ action: 'continue' }, { role: 'leader', actorId: 'lead' }), null);
});

/* ---------- 护栏 ---------- */

test('★ 连续 3 次后拒绝（默认上限）', () => {
  const g = new AutoAdvanceGuard();
  assert.equal(g.note('a', 'r1').ok, true);
  assert.equal(g.note('a', 'r2').ok, true);
  assert.equal(g.note('a', 'r3').ok, true);
  const blocked = g.note('a', 'r4');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /连续自动推进 3 次/);
});

test('reset 后可以继续', () => {
  const g = new AutoAdvanceGuard();
  for (let i = 0; i < 3; i += 1) g.note('a', `r${i}`);
  assert.equal(g.note('a', 'x').ok, false);
  g.reset();
  assert.equal(g.note('a', 'y').ok, true);
});

/* ---------- 端到端 ---------- */

test('★ agent 声明 continue → 按 roster 顺序唤起下一位', async () => {
  const { room, events } = await makeRoom();
  await room.humanSay('@lead 开始');
  await room.drain();

  const advances = events.filter((e) => e.type === 'auto.advance');
  assert.ok(advances.length > 0, '应该发生自动推进');
  assert.equal(advances[0].from, 'lead');
  assert.equal(advances[0].to, 'bob', '按名单顺序，lead 的下一位是 bob');
  assert.ok(advances.every((a) => a.to !== a.from), '不能派给自己');
});

test('★ 连续 3 次后房间停住等人', async () => {
  const { room, events } = await makeRoom();
  await room.humanSay('@lead 开始');
  await room.drain();

  assert.equal(room.autoAdvance.count, 3);
  assert.ok(events.some((e) => e.type === 'notice' && /连续自动推进/.test(e.text ?? '')));
  assert.equal(room.waitingForHuman, true);
});

test('★ 人类发言重置计数（打断自动推进链条）', async () => {
  const { room } = await makeRoom();
  await room.humanSay('@lead 开始');
  await room.drain();
  assert.equal(room.autoAdvance.count, 3);

  await room.humanSay('@bob 我改主意了');
  assert.equal(room.autoAdvance.count, 0, '人说话就是打断');
});

test('没写 continue 时照旧停住（默认行为不变）', async () => {
  const { room, events } = await makeRoom({ continues: false });
  await room.humanSay('@lead 说说看');
  await room.drain();

  assert.equal(events.filter((e) => e.type === 'auto.advance').length, 0);
  assert.equal(room.waitingForHuman, true, '默认行为没被改，仍然停住');
  assert.equal(room.autoAdvance.count, 0);
});

test('同时 @ 了人又写了 continue：以 @ 为准，不双发', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cont2-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const room = new Room({
    id: 'r', name: 'r', goal: 't',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
      { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
      { id: 'carol', name: 'carol', role: 'member', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
    ],
    store,
    resolveAdapter: (agent) => ({
      run: async () => ({
        // 只有 lead 这样回；其他成员正常说完就停（否则假数据会自己无限接龙）
        text: agent.id === 'lead'
          ? '@carol 你来看。\n```action\n{"action":"continue","localId":"c1","reason":"还需要继续"}\n```'
          : '我看过了，没问题。',
        reason: 'completed',
      }),
    }),
    onEvent: (e) => events.push(e),
  });
  room.turnTimeoutMs = 5_000;
  room.maxRetries = 0;

  await room.humanSay('@lead 开始');
  await room.drain();

  // lead 那轮 @ 了 carol，同时写了 continue → 以 @ 为准，不额外自动推进
  const advancesFromLead = events.filter((e) => e.type === 'auto.advance' && e.from === 'lead');
  assert.equal(advancesFromLead.length, 0, '@ 了人就不该额外自动推进');
  assert.equal(room.autoAdvance.count, 0, '被 @ 覆盖掉的 continue 不该计入护栏');
});

test('nextInRoster 跳过暂停中的成员', async () => {
  const { room } = await makeRoom();
  room.health.failure('bob');
  room.health.failure('bob');
  room.health.failure('bob');   // 熔断 bob
  assert.equal(room.health.canRun('bob').ok, false);

  const next = room.nextInRoster('lead');
  assert.equal(next.agent.id, 'carol', 'bob 在暂停中，应跳到 carol');
});
