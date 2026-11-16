/**
 * 会话 id 必须跟着房间走（验收第 7 条的后半句）。
 *
 * "两个房间的 lead session id 不同"只是表象。真正要保证的是：
 *   每个房间的会话 id **存在自己的 room.jsonl 里**，切回来 / 重启之后能接上。
 *
 * 缺陷背景：`store.saveSession()` 一直在写 `session` 事件，但 `buildRoom()`
 * 从来没有把 `store.sessions` 读回成员身上。于是：
 *   - 重启 → 所有 agent 丢上下文，从头开始，**界面上看不出来**
 *   - 切到别的房间再切回来 → 同一件事，因为切房间会新建 Room
 * 这和项目里一直在抓的"界面撒谎"是同一类：它不报错，只是悄悄忘事。
 *
 * cwd 不匹配时**不能**恢复：claude/codex 用错的 cwd resume 会挂住不报错
 * （实测 60 秒超时才被杀）。宁可开新会话，也不要挂死。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRoom } from '../src/core/config.js';
import { RoomManager } from '../src/core/sessions.js';
import { TIER } from '../src/core/probe.js';

const roomCfg = (name, members) => ({ name, goal: '', registry: [], members });

const mkMembers = () => ([
  { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: TIER.READONLY },
  { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: TIER.READONLY },
]);

/** 造一个房间目录，并按需写入 session 事件 */
async function makeRoomDir({ sessions = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sess-'));
  await writeFile(join(dir, 'room.json'), JSON.stringify(roomCfg('会话房间', mkMembers()), null, 2));
  const lines = sessions.map((s, i) => JSON.stringify({
    v: 1, seq: i + 1, at: new Date().toISOString(), kind: 'session', ...s,
  }));
  if (lines.length) await writeFile(join(dir, 'room.jsonl'), lines.join('\n') + '\n');
  return dir;
}

test('★ 重启后从 room.jsonl 恢复成员会话 id（否则悄悄丢上下文）', async () => {
  const dir = await makeRoomDir();
  const cwd = join(dir, 'agents', 'lead');

  const first = await buildRoom({ cfg: JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'room.json'), 'utf8')), dataDir: dir });
  // 模拟跑了一轮，拿到 session id 并落盘
  await first.store.saveSession('lead', { sessionId: 'sess-aaa', cwd, backend: 'claude' });
  await first.store.flush?.();

  // "重启"：重新装配一次
  const second = await buildRoom({ cfg: roomCfg('会话房间', mkMembers()), dataDir: dir });
  const lead = second.members.find((m) => m.id === 'lead');

  assert.equal(lead.sessionId, 'sess-aaa', '重启后必须接上原来的会话，而不是开新的');
});

test('★ cwd 对不上时不恢复会话（错误 cwd resume 会挂死不报错）', async () => {
  const dir = await makeRoomDir();
  const { readFile } = await import('node:fs/promises');

  const first = await buildRoom({ cfg: JSON.parse(await readFile(join(dir, 'room.json'), 'utf8')), dataDir: dir });
  await first.store.saveSession('lead', {
    sessionId: 'sess-bbb', cwd: '/somewhere/else', backend: 'claude',
  });

  const second = await buildRoom({ cfg: roomCfg('会话房间', mkMembers()), dataDir: dir });
  const lead = second.members.find((m) => m.id === 'lead');
  assert.equal(lead.sessionId ?? null, null, 'cwd 不匹配时必须放弃恢复，避免 resume 挂住');
});

test('★ 两个房间的 lead 会话 id 不同，且切换来回各自保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sess-multi-'));
  const ids = ['r-a', 'r-b'];
  const meta = { version: 1, rooms: [], activeRoomId: 'r-a' };

  for (const id of ids) {
    const d = join(root, 'rooms', id);
    await mkdir(join(d, 'agents'), { recursive: true });
    await writeFile(join(d, 'room.json'), JSON.stringify(roomCfg(`房间 ${id}`, mkMembers()), null, 2));
    meta.rooms.push({ id, name: `房间 ${id}`, createdAt: new Date().toISOString() });
  }
  await writeFile(join(root, 'rooms.json'), JSON.stringify(meta, null, 2));

  const mgr = await new RoomManager({ dataDir: root, onEvent: () => {} }).init();
  assert.equal(mgr.session.id, 'r-a');

  // 两个房间各跑出一轮，留下各自不同的会话 id（真实流程里由 _runTurn 落盘）
  await mgr.session.store.saveSession('lead', {
    sessionId: 'sess-room-a', cwd: join(root, 'rooms', 'r-a', 'agents', 'lead'), backend: 'claude',
  });

  await mgr.switchTo('r-b');
  assert.equal(
    mgr.session.members.find((m) => m.id === 'lead').sessionId ?? null, null,
    'B 房间还没跑过，不该凭空继承 A 的会话',
  );
  await mgr.session.store.saveSession('lead', {
    sessionId: 'sess-room-b', cwd: join(root, 'rooms', 'r-b', 'agents', 'lead'), backend: 'claude',
  });

  // 切回 A → 房间整体重建，会话 id 必须从 A 自己的 jsonl 恢复
  await mgr.switchTo('r-a');
  const leadA = mgr.session.members.find((m) => m.id === 'lead');
  assert.equal(leadA.sessionId, 'sess-room-a', '切回房间要接上该房间自己的会话');

  // 再切到 B → 拿回 B 的，不能是 A 的
  await mgr.switchTo('r-b');
  const leadB = mgr.session.members.find((m) => m.id === 'lead');
  assert.equal(leadB.sessionId, 'sess-room-b', '切到这个房间要接上它自己的会话');
  assert.notEqual(leadA.sessionId, leadB.sessionId, '两个房间的 lead 会话 id 必须不同');
});
