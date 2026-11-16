/**
 * 多房间运行时：切换房间。
 *
 * 管理方定死的顺序：
 *   1. 真的 kill 正在跑的一轮（不是只 reject promise）
 *   2. 清空排队，如实报「丢弃 N 条」
 *   3. 冻结旧 store：残留 turn 不许写旧房间的 jsonl
 *   4. 重建 Room / Store / 适配器缓存 / 成员 / **全部房间私有状态**
 *
 * 第 4 条是本文件重点：复用 Room 实例会带着上一个房间的护栏计数、
 * autoadvance、接管状态、用量基线——那些都不会报错，只会在界面上撒谎。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RoomManager } from '../src/core/sessions.js';
import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';
import { TIER } from '../src/core/probe.js';

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

const roomCfg = (name, members) => JSON.stringify({ name, goal: '', registry: [], members }, null, 2);

const members = [
  { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: TIER.READONLY },
  { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: TIER.READONLY },
];

/** 造一个已经是多房间布局的数据目录 */
async function makeMultiRoom({ rooms = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rooms-'));
  const meta = { version: 1, rooms: [], activeRoomId: null };
  for (let i = 0; i < rooms; i += 1) {
    const id = `r-${i}`;
    const d = join(dir, 'rooms', id);
    await mkdir(join(d, 'agents'), { recursive: true });
    await writeFile(join(d, 'room.json'), roomCfg(`房间${i}`, i === 0 ? members : []));
    meta.rooms.push({ id, name: `房间${i}`, createdAt: new Date(2026, 0, i + 1).toISOString() });
  }
  meta.activeRoomId = 'r-0';
  await writeFile(join(dir, 'rooms.json'), JSON.stringify(meta, null, 2));
  return dir;
}

test('打开时读 rooms.json 的活动房间', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();
  assert.equal(mgr.session.id, 'r-0');
  assert.equal(mgr.session.name, '房间0');
  assert.equal(mgr.session.members.length, 2);
});

test('空数据目录 → 没有活动房间（不偷偷预置 lead/bob）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rooms-empty-'));
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();
  assert.equal(mgr.session, null);
  assert.deepEqual(mgr.meta.rooms, []);
});

test('★ 新建房间是空房间，并立即切过去', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();

  const r = await mgr.create('新房间');
  assert.equal(r.ok, true);
  assert.equal(mgr.session.name, '新房间');
  assert.deepEqual(mgr.session.members, [], '新房间不能预置成员');
  assert.ok(await exists(join(dir, 'rooms', r.room.id, 'room.json')));

  const saved = JSON.parse(await readFile(join(dir, 'rooms.json'), 'utf8'));
  assert.equal(saved.activeRoomId, r.room.id, '活动房间要落盘，重启能回来');
});

test('★ 切换房间：旧 store 被冻结，写不进旧房间的 jsonl', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();

  const oldStore = mgr.session.store;
  const oldFile = oldStore.filePath;
  const before = (await readFile(oldFile, 'utf8').catch(() => '')).length;

  const r = await mgr.switchTo('r-1');
  assert.equal(r.ok, true);
  assert.equal(oldStore.frozen, true, '旧 store 必须冻结');

  // 模拟"残留 turn"在切换后才收尾写事件
  await oldStore.append({ kind: 'message', message: { id: 'M-X', senderId: 'lead', body: '迟到的发言' } });
  const after = (await readFile(oldFile, 'utf8').catch(() => '')).length;
  assert.equal(after, before, '冻结后写入不能落盘');
  assert.ok(oldStore.rejectedWrites > 0);
});

test('★ 切换房间：Room 实例必须是新的，房间私有状态不能沿用', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();

  // 在旧房间里制造一堆私有状态
  const oldRoom = mgr.session.room;
  oldRoom.takeOver();
  oldRoom.guard.record?.('lead', {});
  oldRoom.usage.note?.('lead', { inputTokens: 999_999, outputTokens: 1 });
  oldRoom.queue.push({ agentId: 'bob', triggerMsg: {}, taskId: null });
  oldRoom.stopped = true;

  await mgr.switchTo('r-1');
  const newRoom = mgr.session.room;

  assert.notEqual(newRoom, oldRoom, '不能复用 Room 实例');
  assert.equal(newRoom.overridden, undefined, '接管状态要重置（新房间不能显示"已被接管"）');
  assert.equal(newRoom.guard.consecutive?.size ?? 0, 0);
  assert.equal(newRoom.queue.length, 0);
  assert.equal(newRoom.stopped, false, '新房间不能继承"已停止"');
  assert.equal(newRoom.members.length, 0);
});

test('★ 切换时排队发言被清空并如实计数', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();

  mgr.session.room.queue.push(
    { agentId: 'lead', triggerMsg: {}, taskId: null },
    { agentId: 'bob', triggerMsg: {}, taskId: null },
  );
  const r = await mgr.switchTo('r-1');
  assert.equal(r.dropped, 2);
  assert.equal(mgr.session.room.queue.length, 0);
});

test('切到同一个房间是空操作（不重建、不丢排队）', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();
  mgr.session.room.queue.push({ agentId: 'lead', triggerMsg: {}, taskId: null });

  const r = await mgr.switchTo('r-0');
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(mgr.session.room.queue.length, 1);
});

test('切到不存在的房间 → 拒绝，当前房间不受影响', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();
  const r = await mgr.switchTo('r-nope');
  assert.equal(r.ok, false);
  assert.equal(mgr.session.id, 'r-0');
  assert.equal(mgr.session.store.frozen, false);
});

test('★ 重命名只改显示名，目录名不动（改目录=毁掉所有会话上下文）', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();

  const r = await mgr.rename('r-0', '换个名字');
  assert.equal(r.ok, true);
  assert.equal(mgr.meta.rooms.find((x) => x.id === 'r-0').name, '换个名字');

  assert.ok(await exists(join(dir, 'rooms', 'r-0', 'room.json')), '目录名不能变');
  const cfg = JSON.parse(await readFile(join(dir, 'rooms', 'r-0', 'room.json'), 'utf8'));
  assert.equal(cfg.name, '换个名字', '房间自己的 room.json 也要跟着改');
  assert.equal(cfg.members.length, 2, '成员配置不能动');
});

test('同名房间不允许（否则列表里两个一样的名字）', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();
  const r = await mgr.create('房间0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /同名/);
});

test('切换后 emit 的事件带房间标记（旧房间事件能被界面丢掉）', async () => {
  const dir = await makeMultiRoom();
  const events = [];
  const mgr = await new RoomManager({ dataDir: dir, onEvent: (ev) => events.push(ev) }).init();
  await mgr.switchTo('r-1');
  const withRoom = events.filter((e) => e.roomId);
  assert.ok(withRoom.length > 0);
  assert.ok(withRoom.every((e) => e.roomId === 'r-1' || e.roomId === 'r-0'));
});

/* ---------------- Room.halt：真的停，不是只 reject ---------------- */

function hangingAdapter() {
  return {
    async run({ signal }) {
      // 永不产出；只有 abort 时才退出——模拟真实 CLI 挂住
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve({ text: '', reason: 'interrupted' }), { once: true });
      });
    },
  };
}

test('★ halt 会等当前 turn 真正退出，并报 dropped 数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'halt-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const room = new Room({
    id: 'r1', name: '测试', members: [{
      id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'],
    }],
    store, resolveAdapter: () => hangingAdapter(),
  });

  room.queue.push({ agentId: 'a', triggerMsg: {}, taskId: null });
  const draining = room.drain();

  // 等它真的开始跑
  for (let i = 0; i < 100 && !room.current; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(room.current, 'turn 应该已经开始');

  room.queue.push({ agentId: 'a', triggerMsg: {}, taskId: null });
  const halted = await room.halt({ timeoutMs: 3000 });
  await draining;

  assert.equal(halted.killed, true, '进程要在超时内退出');
  assert.equal(halted.dropped, 1);
  assert.equal(room.current, null);
});

test('halt 时没有在跑的 turn → 立即返回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'halt2-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const room = new Room({
    id: 'r1', name: 't', members: [], store, resolveAdapter: () => hangingAdapter(),
  });
  const r = await room.halt();
  assert.deepEqual({ killed: r.killed, dropped: r.dropped }, { killed: true, dropped: 0 });
});

test('★ 切换时旧房间有 turn 在跑：切换后旧 store 写入被拒，新房间能正常跑一轮', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'rooms-live-'));

  // 两个房间，各一个成员
  const meta = { version: 1, activeRoomId: 'r-a', rooms: [
    { id: 'r-a', name: 'A', createdAt: new Date().toISOString() },
    { id: 'r-b', name: 'B', createdAt: new Date().toISOString() },
  ] };
  for (const id of ['r-a', 'r-b']) {
    await mkdir(join(dir, 'rooms', id, 'agents'), { recursive: true });
    await writeFile(join(dir, 'rooms', id, 'room.json'), JSON.stringify({
      name: id,
      members: [{ id: `w-${id}`, name: `w${id}`, role: 'leader', backend: 'claude', tier: 'readonly' }],
    }));
  }
  await writeFile(join(dir, 'rooms.json'), JSON.stringify(meta, null, 2));

  let release;
  const gate = new Promise((r) => { release = r; });
  const ran = [];

  const mgr = new RoomManager({ dataDir: dir, onEvent: () => {} });
  await mgr.init();

  // 给 A 房间塞一个会挂住的适配器
  mgr.session.room.resolveAdapter = () => ({
    async run({ onEvent }) {
      ran.push('A');
      await gate;
      onEvent?.({ type: 'text', text: 'A 完成', done: false });
      return { text: 'A 完成', reason: 'completed', usage: null };
    },
  });

  await mgr.session.room.humanSay('@wr-a 干活');
  const running = mgr.session.room.drain();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(mgr.session.room.current, 'A 房间确实在跑');

  const oldStore = mgr.session.store;
  const oldFile = oldStore.filePath;

  // 切换（会 abort 并等它退出）
  release();
  const sw = await mgr.switchTo('r-b', { timeoutMs: 3000 });
  await running;
  assert.equal(sw.ok, true);
  assert.equal(oldStore.frozen, true, '旧 store 必须冻结');

  // 切换完成之后，任何"迟到的收尾写入"都不能再进 A 的 jsonl
  const settled = (await readFile(oldFile, 'utf8').catch(() => '')).length;
  await oldStore.append({ kind: 'message', message: { id: 'M-late', senderId: 'w-r-a', body: '迟到的' } });
  const afterSize = (await readFile(oldFile, 'utf8').catch(() => '')).length;
  assert.equal(afterSize, settled, 'A 的 jsonl 不能被残留 turn 写入');
  assert.ok(oldStore.rejectedWrites > 0);

  // 新房间照常能跑
  mgr.session.room.resolveAdapter = () => ({
    async run({ onEvent }) {
      ran.push('B');
      onEvent?.({ type: 'text', text: 'B 完成', done: false });
      return { text: 'B 完成', reason: 'completed', usage: null };
    },
  });
  await mgr.session.room.humanSay('@wr-b 干活');
  await mgr.session.room.drain();
  assert.deepEqual(ran, ['A', 'B'], '新房间能正常跑一轮');
  const bLog = await readFile(join(dir, 'rooms', 'r-b', 'room.jsonl'), 'utf8');
  assert.ok(bLog.includes('w-r-b'), 'B 的对话落在 B 自己的文件里');
});

test('★ 每个房间有共享目录，成员都能看到（协作不用把内容贴进群）', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();
  const shared = mgr.session.room.sharedDir;
  assert.ok(shared, '房间要暴露 sharedDir');
  assert.ok(await exists(shared), '共享目录要真的建出来');
  assert.ok(shared.endsWith(join('r-0', 'shared')), `路径在房间目录下：${shared}`);
  assert.ok(mgr.session.members.every((m) => m.sharedDir === shared), '每个成员都拿到同一个路径');
});

test('★ 换房间后共享目录跟着换（不能还指着上一个房间的）', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();
  const a = mgr.session.room.sharedDir;
  await mgr.switchTo('r-1');
  const b = mgr.session.room.sharedDir;
  assert.notEqual(a, b);
  assert.ok(b.includes('r-1'));
});

test('★ 房间级单轮上限：设为 N 分钟后，Room 立即用新值（不等重启）', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();

  const { DEFAULT_TURN_TIMEOUT_MS } = await import('../src/core/room.js');
  assert.equal(mgr.session.room.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);

  // 模拟 /api/room-settings 的行为：直接改实例字段
  mgr.session.room.turnTimeoutMs = 45 * 60_000;
  mgr.session.cfg.turnTimeoutMinutes = 45;
  await mgr.persist();

  const saved = JSON.parse(await readFile(join(dir, 'rooms', 'r-0', 'room.json'), 'utf8'));
  assert.equal(saved.turnTimeoutMinutes, 45, '房间配置要落盘');

  // 下一轮拿到的就是新值
  const seen = [];
  mgr.session.room.resolveAdapter = () => ({
    async run({ timeoutMs }) {
      seen.push(timeoutMs);
      return { text: '好', reason: 'completed', usage: null };
    },
  });
  await mgr.session.room.humanSay('@lead 干活');
  await mgr.session.room.drain();
  assert.deepEqual(seen, [45 * 60_000], '下一轮 adapter.run 收到的 timeoutMs 必须是新值');
});

test('★ 成员级单轮上限优先于房间默认', async () => {
  const dir = await makeMultiRoom();
  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();
  mgr.session.room.members[0].timeoutMinutes = 5;

  const seen = [];
  mgr.session.room.resolveAdapter = () => ({
    async run({ timeoutMs }) {
      seen.push(timeoutMs);
      return { text: '好', reason: 'completed', usage: null };
    },
  });
  await mgr.session.room.humanSay('@lead 干活');
  await mgr.session.room.drain();
  assert.deepEqual(seen, [5 * 60_000]);
});

test('★ 手写 timeoutMs 会压过界面设置 → 必须显式暴露，不能静默', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'legacy-timeout-'));
  await mkdir(join(dir, 'rooms', 'r-a', 'agents', 'a1'), { recursive: true });
  await writeFile(join(dir, 'rooms', 'r-a', 'room.json'), JSON.stringify({
    name: '手改上限',
    members: [
      // 这条是外部手改的：没有 timeoutMinutes，只有 timeoutMs
      { id: 'a1', name: 'a1', role: 'leader', backend: 'claude', tier: 'readonly', timeoutMs: 30 * 60_000 },
      { id: 'a2', name: 'a2', role: 'member', backend: 'claude', tier: 'readonly' },
    ],
  }));
  await writeFile(join(dir, 'rooms.json'), JSON.stringify({
    version: 1, activeRoomId: 'r-a',
    rooms: [{ id: 'r-a', name: '手改上限', createdAt: new Date().toISOString() }],
  }));

  const notices = [];
  const mgr = new RoomManager({ dataDir: dir, onEvent: (e) => notices.push(e) });
  await mgr.init();

  // 1. 启动时必须告诉用户"这个值不是界面写的"
  assert.ok(mgr.notices.some((n) => /手写的 timeoutMs/.test(n)),
    '要有明确警告，否则界面显示 20 分钟、实际 30 分钟');

  // 2. 实际生效值确实是 30 分钟（行为不变，不静默改数据）
  const { resolveMemberTimeoutMs, timeoutSource } = await import('../src/core/room.js');
  const a1 = mgr.session.room.members.find((m) => m.id === 'a1');
  assert.equal(timeoutSource(a1), 'legacy');
  assert.equal(resolveMemberTimeoutMs(a1, 20 * 60_000), 30 * 60_000);
  assert.equal(timeoutSource(mgr.session.room.members.find((m) => m.id === 'a2')), 'room');

  // 3. 用界面字段覆盖后就回到正常（来源变 member，警告来源消失）
  const { planMemberUpdate } = await import('../src/core/memberSettings.js');
  const plan = planMemberUpdate({ member: a1, patch: { timeoutMinutes: '25' } });
  assert.equal(plan.ok, true);
  const merged = { ...a1, ...plan.member };
  assert.equal(timeoutSource(merged), 'member');
  assert.equal(resolveMemberTimeoutMs(merged, 20 * 60_000), 25 * 60_000);
});
