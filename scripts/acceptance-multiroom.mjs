/**
 * 验收（管理方点名的三条 + spec 七条）。
 *
 *   node scripts/acceptance-multiroom.mjs
 *
 * 1. 迁移幂等：跑两次不重复迁移、不报错、数据一条不少
 * 2. 备份失败 → 照常启动，数据不动，单房间回退
 * 3. 切换房间 → 旧房间的 CLI **真的退出**（不是只 reject promise）
 *    且两个房间的 lead session id 不同，切回来能接上
 * 4. 删除房间 → 目录进 .trash，数据还能读；最后一个不能删
 * 5. 令牌是服务级的：不随房间切换变化
 *
 * 第 3 条用**真的子进程**：造一个假 CLI（node 脚本，收到 prompt 就不停输出），
 * 切房间后检查 pid 是否还活着。查 promise 是查不出这个的。
 */

import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { detectLayout, migrateSingleRoom, LEGACY_ROOM_ID, TRASH_PREFIX } from '../src/core/rooms.js';
import { ensureRoomsLayout } from '../src/core/rooms.js';
import { RoomManager } from '../src/core/sessions.js';

const ok = (c) => (c ? '✅' : '❌');
let failed = 0;
const check = (cond, label, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${ok(cond)} ${label}${extra ? ` — ${extra}` : ''}`);
};

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const countLines = async (p) => {
  try { return (await readFile(p, 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** 造旧版单房间数据 */
async function makeLegacy({ lines = 11 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'acc-legacy-'));
  await writeFile(join(dir, 'room.json'), JSON.stringify({
    name: '老板的房间', goal: '', registry: [{ path: '/tmp' }],
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly' },
      { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: 'readonly' },
    ],
  }, null, 2));
  const ev = [];
  for (let i = 0; i < lines; i += 1) {
    ev.push(JSON.stringify({ v: 1, seq: i + 1, kind: 'message', message: { id: `M-${i}`, senderId: 'human', body: `第 ${i} 条` } }));
  }
  await writeFile(join(dir, 'room.jsonl'), ev.join('\n') + '\n');
  for (const a of ['lead', 'bob']) {
    await mkdir(join(dir, 'agents', a), { recursive: true });
    await writeFile(join(dir, 'agents', a, 'note.txt'), a);
  }
  await writeFile(join(dir, 'access-token'), 'c'.repeat(32));
  return dir;
}

console.log('=== 1. 迁移幂等 ===');
{
  const dir = await makeLegacy({ lines: 11 });
  const before = await countLines(join(dir, 'room.jsonl'));

  const r1 = await migrateSingleRoom(dir);
  const r2 = await migrateSingleRoom(dir);

  check(r1.ok === true, '第一次迁移成功');
  check(r2.ok === true && r2.alreadyMigrated === true, '第二次迁移识别为已完成，不重复迁移');
  check(await countLines(join(dir, 'rooms', LEGACY_ROOM_ID, 'room.jsonl')) === before,
    `事件一条不少（${before} 条）`);
  check((await detectLayout(dir)).mode === 'multi', '布局是多房间');
  check((await readdir(join(dir, 'rooms'))).length === 1, '没有多出重复房间目录');
  check(await exists(join(dir, 'access-token')), '令牌留在根目录（服务级）');
  const backups = (await readdir(dir)).filter((n) => n.startsWith('.multiagent-chat.bak-'));
  check(backups.length === 1, '只备份一次', `实际 ${backups.length} 个`);
  void r1;
}

console.log('\n=== 2. 备份失败 / 迁移失败 → 照常启动 ===');
{
  const dir = await makeLegacy({ lines: 7 });
  // 让备份必然失败：预先占住备份目录路径（同一 now 值 → 同一目录名）
  const now = Date.now();
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // 把备份路径占成一个**文件**：mkdir 必然 EEXIST/ENOTDIR → 备份失败
  await writeFile(join(dir, `.multiagent-chat.bak-${stamp}`), 'blocked');

  const layout = await ensureRoomsLayout(dir, { now, log: () => {} });
  check(layout.single === true, '迁移未完成时退回单房间模式（不阻塞启动）');
  check(Boolean(layout.warning), '给出了警告，说明为什么没迁移');
  check(await countLines(join(dir, 'room.jsonl')) === 7, '原始数据一条没动');
  check((await detectLayout(dir)).mode === 'single', '仍可被识别为单房间布局');

  // 而且这个"启动"确实能装配出一个可用房间
  const mgr = new RoomManager({ dataDir: dir, onEvent: () => {} }).init
    ? await new RoomManager({ dataDir: dir, onEvent: () => {} }).init()
    : null;
  check(Boolean(mgr?.session), '回退模式下仍然有可用房间（界面不会是空的）');
  check(mgr.session.members.length === 2, '成员还在');
}

console.log('\n=== 3. 切换房间：旧 CLI 真的退出 + 会话 id 各自保留 ===');
{
  const root = await mkdtemp(join(tmpdir(), 'acc-switch-'));
  const fakeBin = join(root, 'fake-cli.mjs');
  // 假 CLI：无限输出，直到被杀。pid 写进文件，好从外面查。
  // 注意：runner 会过滤子进程环境变量（只放行白名单），所以不能用 env 传路径。
  // 改为从 cwd 推出来：cwd = <root>/rooms/<roomId>/agents/lead
  await writeFile(fakeBin, `#!/usr/bin/env node
    import { writeFileSync } from 'node:fs';
    import { basename, dirname, join } from 'node:path';
    const cwd = process.cwd();
    const roomId = basename(dirname(dirname(cwd)));
    const pidFile = join(dirname(dirname(dirname(dirname(cwd)))), 'pid-' + roomId + '.pid');
    writeFileSync(pidFile, String(process.pid));
    const sid = 'sid-' + Math.random().toString(36).slice(2, 10);
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));
    const t = setInterval(() => {
      console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '思考中…' } } }));
    }, 200);
    process.on('SIGTERM', () => process.exit(0));
    void t;
  `);
  await chmod(fakeBin, 0o755);

  const meta = { version: 1, rooms: [], activeRoomId: 'r-a' };
  for (const id of ['r-a', 'r-b']) {
    const d = join(root, 'rooms', id);
    await mkdir(join(d, 'agents'), { recursive: true });
    await writeFile(join(d, 'room.json'), JSON.stringify({
      name: `房间${id}`, goal: '', registry: [],
      members: [{ id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', bin: fakeBin }],
    }, null, 2));
    meta.rooms.push({ id, name: `房间${id}`, createdAt: new Date().toISOString() });
  }
  await writeFile(join(root, 'rooms.json'), JSON.stringify(meta, null, 2));

  const mgr = await new RoomManager({ dataDir: root, onEvent: () => {} }).init();
  const pidFile = join(root, 'pid-r-a.pid');

  await mgr.session.room.humanSay('@lead 开始干活');
  mgr.session.room.drain().catch(() => {});

  // 等假 CLI 起来
  let cliPid = null;
  for (let i = 0; i < 60; i += 1) {
    try { cliPid = Number((await readFile(pidFile, 'utf8')).trim()); break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  check(Number.isFinite(cliPid) && alive(cliPid), '假 CLI 已启动（拿到 pid）', `pid=${cliPid}`);

  // 先让房间 A 记下一个会话 id（假 CLI 的 init 事件会触发 saveSession）
  await new Promise((r) => setTimeout(r, 400));
  const sidA = mgr.session.members.find((m) => m.id === 'lead')?.sessionId;
  check(Boolean(sidA), '房间 A 记录了 lead 的会话 id', String(sidA ?? ''));

  const sw = await mgr.switchTo('r-b', { timeoutMs: 10_000 });
  check(sw.ok === true, '切换成功');
  check(sw.killed === true, '旧房间的 turn 在超时内退出（killed=true）');
  await new Promise((r) => setTimeout(r, 300));
  check(!alive(cliPid), '旧房间的 CLI 进程真的没了（不是只 reject promise）', `pid=${cliPid}`);

  const leadB0 = mgr.session.members.find((m) => m.id === 'lead');
  check(!leadB0.sessionId, '新房间不继承旧房间的会话 id');

  // 房间 B 跑一轮，得到自己的会话 id
  await mgr.session.room.humanSay('@lead 你也开始');
  mgr.session.room.drain().catch(() => {});
  let sidB = null;
  for (let i = 0; i < 80; i += 1) {
    sidB = mgr.session.members.find((m) => m.id === 'lead')?.sessionId;
    if (sidB) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check(Boolean(sidB), '房间 B 记录了 lead 的会话 id', String(sidB ?? ''));
  check(sidA && sidB && sidA !== sidB, '两个房间的 lead 会话 id 不同');

  await mgr.session.room.halt({ timeoutMs: 8000 });

  // 切回 A：必须接回 A 的会话 id
  await mgr.switchTo('r-a', { timeoutMs: 10_000 });
  const leadA = mgr.session.members.find((m) => m.id === 'lead');
  check(leadA.sessionId === sidA, '切回房间 A 能接上它自己的会话 id', `${leadA.sessionId} vs ${sidA}`);
}

console.log('\n=== 4. 删除房间 ===');
{
  const root = await mkdtemp(join(tmpdir(), 'acc-del-'));
  const meta = { version: 1, rooms: [], activeRoomId: 'r-a' };
  for (const id of ['r-a', 'r-b']) {
    const d = join(root, 'rooms', id);
    await mkdir(join(d, 'agents'), { recursive: true });
    await writeFile(join(d, 'room.json'), JSON.stringify({ name: id, goal: '', registry: [], members: [] }, null, 2));
    await writeFile(join(d, 'room.jsonl'), `{"v":1,"seq":1,"kind":"message","message":{"id":"M-1","senderId":"human","body":"重要记录"}}\n`);
    meta.rooms.push({ id, name: id, createdAt: new Date().toISOString() });
  }
  await writeFile(join(root, 'rooms.json'), JSON.stringify(meta, null, 2));

  const mgr = await new RoomManager({ dataDir: root, onEvent: () => {} }).init();
  const r = await mgr.remove('r-a');
  check(r.ok === true, '删除成功');
  check(r.switchedTo === 'r-b', '删的是当前房间 → 先切到另一个');
  check(r.trashed && r.trashed.includes(TRASH_PREFIX), '目录进了 .trash-*');
  check(await exists(join(root, 'rooms', 'r-a')) === false, '原目录已不在');
  const kept = await readFile(join(r.trashed, 'room.jsonl'), 'utf8');
  check(kept.includes('重要记录'), '数据还能从垃圾桶读回来（不是 rm）');

  const last = await mgr.remove('r-b');
  check(last.ok === false, '最后一个房间不能删');
  check(await exists(join(root, 'rooms', 'r-b')), '被拒时目录原地不动');
}

console.log('\n=== 5. 令牌不随房间切换变化 ===');
{
  const root = await mkdtemp(join(tmpdir(), 'acc-token-'));
  const meta = { version: 1, rooms: [], activeRoomId: 'r-a' };
  for (const id of ['r-a', 'r-b']) {
    const d = join(root, 'rooms', id);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'room.json'), JSON.stringify({ name: id, goal: '', registry: [], members: [] }, null, 2));
    meta.rooms.push({ id, name: id, createdAt: new Date().toISOString() });
  }
  await writeFile(join(root, 'rooms.json'), JSON.stringify(meta, null, 2));
  await writeFile(join(root, 'access-token'), 'd'.repeat(32), { mode: 0o600 });

  const mgr = await new RoomManager({ dataDir: root, onEvent: () => {} }).init();
  await mgr.switchTo('r-b');
  await mgr.switchTo('r-a');
  check((await readFile(join(root, 'access-token'), 'utf8')) === 'd'.repeat(32),
    '切换房间后根目录令牌不变');
  check(!(await exists(join(root, 'rooms', 'r-a', 'access-token'))), '令牌不会被复制进房间目录');
}

console.log(`\n${failed ? `❌ ${failed} 项失败` : '✅ 全部通过'}`);
process.exit(failed ? 1 : 0);
