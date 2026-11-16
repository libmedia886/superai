/**
 * 删除房间（spec 验收第 5 条）。
 *
 * 管理方定的三条：
 *   1. **不能删最后一个房间**（删光了界面无处可去，也容易被理解成数据没了）
 *   2. **删当前房间先切到另一个再删**（不能只换指针，旧进程必须先停）
 *   3. **目录 rename 到 rooms/.trash-<ts>/，不 rm**（删错了还能捞回来）
 *
 * 另外防路径穿越：房间 id 直接拼进路径，非法 id 必须在碰磁盘之前被拒。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteRoom, loadRoomsMeta, validRoomId, TRASH_PREFIX } from '../src/core/rooms.js';
import { RoomManager } from '../src/core/sessions.js';
import { startServer } from '../src/server.js';
import { TIER } from '../src/core/probe.js';

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

const roomCfg = (name, members = []) => JSON.stringify({ name, goal: '', registry: [], members }, null, 2);

const members = [
  { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: TIER.READONLY },
  { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: TIER.READONLY },
];

/** 造一个多房间数据目录；r-0 有历史事件 */
async function makeMultiRoom({ rooms = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'del-'));
  const meta = { version: 1, rooms: [], activeRoomId: null };
  for (let i = 0; i < rooms; i += 1) {
    const id = `r-${i}`;
    const d = join(dir, 'rooms', id);
    await mkdir(join(d, 'agents', `a${i}`), { recursive: true });
    await writeFile(join(d, 'room.json'), roomCfg(`房间${i}`, i === 0 ? members : []));
    if (i === 0) {
      await writeFile(join(d, 'room.jsonl'), [
        JSON.stringify({ v: 1, seq: 1, kind: 'message', message: { id: 'M-1', senderId: 'human', body: '你好' } }),
        JSON.stringify({ v: 1, seq: 2, kind: 'message', message: { id: 'M-2', senderId: 'lead', body: '收到' } }),
      ].join('\n') + '\n');
    }
    meta.rooms.push({ id, name: `房间${i}`, createdAt: new Date(2026, 0, i + 1).toISOString() });
  }
  meta.activeRoomId = 'r-0';
  await writeFile(join(dir, 'rooms.json'), JSON.stringify(meta, null, 2));
  return dir;
}

/* ---------------- 底层：deleteRoom ---------------- */

test('★ 删除房间：目录进 .trash-*，数据一条不少（不是 rm）', async () => {
  const dir = await makeMultiRoom();
  const meta = await loadRoomsMeta(dir);

  const r = await deleteRoom(dir, meta, 'r-0');
  assert.equal(r.ok, true);

  assert.equal(await exists(join(dir, 'rooms', 'r-0')), false, '原目录不应还在');
  assert.ok(r.trashed, '要返回垃圾桶路径');
  assert.ok(r.trashed.includes(TRASH_PREFIX), `垃圾桶目录名应含 ${TRASH_PREFIX}`);

  // 数据必须还在垃圾桶里，能读回原样
  const jsonl = await readFile(join(r.trashed, 'room.jsonl'), 'utf8');
  assert.match(jsonl, /你好/);
  assert.match(jsonl, /收到/);
  assert.ok(await exists(join(r.trashed, 'agents', 'a0')), 'agent 目录也要在垃圾桶里');

  // rooms.json 同步更新
  const saved = await loadRoomsMeta(dir);
  assert.deepEqual(saved.rooms.map((x) => x.id), ['r-1']);
  assert.equal(saved.activeRoomId, 'r-1', '删的是活动房间时，活动房间要指向剩下的');
});

test('★ 不能删最后一个房间', async () => {
  const dir = await makeMultiRoom({ rooms: 1 });
  const meta = await loadRoomsMeta(dir);

  const r = await deleteRoom(dir, meta, 'r-0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /不能删除最后一个房间/);
  assert.ok(await exists(join(dir, 'rooms', 'r-0')), '被拒时目录必须原地不动');
});

test('删除不存在的房间 → 明确报错，不碰磁盘', async () => {
  const dir = await makeMultiRoom();
  const meta = await loadRoomsMeta(dir);
  const r = await deleteRoom(dir, meta, 'r-nope');
  assert.equal(r.ok, false);
  assert.match(r.reason, /不存在/);
});

test('★ 非法房间 id（路径穿越）在碰磁盘之前被拒', async () => {
  const dir = await makeMultiRoom();
  const meta = await loadRoomsMeta(dir);
  // 直接在列表里塞一个坏 id，模拟 rooms.json 被写坏
  meta.rooms.push({ id: '../../etc', name: '坏房间' });

  const r = await deleteRoom(dir, meta, '../../etc');
  assert.equal(r.ok, false);
  assert.match(r.reason, /非法房间 id/);
  assert.equal(validRoomId('../../etc'), false);
});

test('删两个房间后只剩一个，再删被拒（逐步删到最后一个）', async () => {
  const dir = await makeMultiRoom({ rooms: 3 });
  let meta = await loadRoomsMeta(dir);

  assert.equal((await deleteRoom(dir, meta, 'r-1')).ok, true);
  meta = await loadRoomsMeta(dir);
  assert.equal((await deleteRoom(dir, meta, 'r-2')).ok, true);
  meta = await loadRoomsMeta(dir);

  const last = await deleteRoom(dir, meta, 'r-0');
  assert.equal(last.ok, false);
  assert.match(last.reason, /最后一个/);
});

/* ---------------- RoomManager：删当前房间必须先切走 ---------------- */

test('★ 删当前房间：先切到另一个（旧 store 冻结），再删', async () => {
  const dir = await makeMultiRoom();
  const events = [];
  const mgr = await new RoomManager({ dataDir: dir, onEvent: (e) => events.push(e) }).init();
  assert.equal(mgr.session.id, 'r-0');

  const oldStore = mgr.session.store;
  const oldRoom = mgr.session.room;

  const r = await mgr.remove('r-0');
  assert.equal(r.ok, true);
  assert.equal(r.switchedTo, 'r-1', '要先切到另一个房间');
  assert.equal(mgr.session.id, 'r-1', '当前房间应已是 r-1');

  assert.equal(oldStore.frozen, true, '旧 store 必须被冻结，残留 turn 写不进去');
  assert.equal(oldRoom.stopped, true, '旧房间必须真的停下');

  // 冻结有效：写旧 store 不落盘
  await oldStore.append({ kind: 'message', message: { id: 'M-x', senderId: 'lead', body: '残留' } });
  const trashed = r.trashed;
  const jsonl = await readFile(join(trashed, 'room.jsonl'), 'utf8');
  assert.equal(/残留/.test(jsonl), false, '冻结后旧房间的 jsonl 不能再被写入');

  assert.ok(events.some((e) => e.type === 'room.deleted'), '要广播删除事件');
});

test('删非当前房间：不切房间，直接删', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();

  const r = await mgr.remove('r-1');
  assert.equal(r.ok, true);
  assert.equal(r.switchedTo, null, '删的不是当前房间，不该切换');
  assert.equal(mgr.session.id, 'r-0', '当前房间保持不变');
});

test('RoomManager 拒绝删最后一个房间（与底层同一规则）', async () => {
  const dir = await makeMultiRoom({ rooms: 1 });
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();
  const r = await mgr.remove('r-0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /最后一个/);
});

/* ---------------- HTTP 接口 ---------------- */

test('★ POST /api/rooms {action:delete} 端到端', async () => {
  const dir = await makeMultiRoom();
  const { server, url } = await startServer({ port: 0, dataDir: dir });

  const r1 = await fetch(`${url}/api/rooms`);
  const before = await r1.json();
  assert.equal(before.rooms.length, 2);

  const res = await fetch(`${url}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', id: 'r-0' }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.switchedTo, 'r-1');
  assert.ok(data.trashed, '要告诉调用方数据去了哪个垃圾桶');

  const after = await (await fetch(`${url}/api/rooms`)).json();
  assert.deepEqual(after.rooms.map((x) => x.id), ['r-1']);
  assert.equal(after.activeRoomId, 'r-1');

  // 垃圾桶目录真实存在
  const trash = await readdir(join(dir, 'rooms'));
  assert.ok(trash.some((n) => n.startsWith(TRASH_PREFIX)));

  server.close();
});

test('/api/rooms delete 缺 id → 400', async () => {
  const dir = await makeMultiRoom();
  const { server, url } = await startServer({ port: 0, dataDir: dir });

  const res = await fetch(`${url}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /缺少房间 id/);

  server.close();
});

test('/api/rooms delete 最后一个 → 400 且房间还在', async () => {
  const dir = await makeMultiRoom({ rooms: 1 });
  const { server, url } = await startServer({ port: 0, dataDir: dir });

  const res = await fetch(`${url}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', id: 'r-0' }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /最后一个/);
  assert.ok(await exists(join(dir, 'rooms', 'r-0')));

  server.close();
});
