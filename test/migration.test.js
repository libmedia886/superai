/**
 * 单房间 → 多房间迁移。
 *
 * 验收 1-3：
 *   1. 备份存在；rooms/r-legacy/ 里事件一条不少
 *   2. 幂等：重启两次不重复迁移、不报错
 *   3. 迁移失败演练：备份失败 → 仍能启动、数据还在、回到单房间模式并给提示
 *
 * 这条改动只做迁移，不碰运行时和界面。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectLayout, backupBeforeMigration, migrateSingleRoom, restoreFromBackup,
  LEGACY_ROOM_ID, ROOMS_FILE,
} from '../src/core/rooms.js';

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/** 造一个"旧版单房间"数据目录 */
async function makeLegacy({ lines = 13, agents = ['lead', 'bob'], name = '旧房间' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mig-'));
  await writeFile(join(dir, 'room.json'), JSON.stringify({
    name, goal: '旧目标', registry: [{ path: '/tmp/x' }],
    members: agents.map((a, i) => ({ id: a, name: a, role: i === 0 ? 'leader' : 'member', backend: 'claude', tier: 'readonly' })),
  }, null, 2));

  const events = [];
  for (let i = 0; i < lines; i += 1) {
    events.push(JSON.stringify({ v: 1, seq: i + 1, kind: 'message', message: { id: `M-${i}`, senderId: 'human', body: `第 ${i} 条` } }));
  }
  await writeFile(join(dir, 'room.jsonl'), events.join('\n') + '\n');

  for (const a of agents) {
    await mkdir(join(dir, 'agents', a), { recursive: true });
    await writeFile(join(dir, 'agents', a, 'notes.txt'), `我是 ${a}`);
  }
  await writeFile(join(dir, 'access-token'), 'a'.repeat(32));
  return dir;
}

const countLines = async (p) => {
  try { return (await readFile(p, 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; }
};

/* ---------- 布局识别 ---------- */

test('识别单房间布局', async () => {
  const dir = await makeLegacy();
  assert.equal((await detectLayout(dir)).mode, 'single');
});

test('识别空目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'empty-'));
  assert.equal((await detectLayout(dir)).mode, 'empty');
});

test('识别已迁移的多房间布局', async () => {
  const dir = await makeLegacy();
  await migrateSingleRoom(dir);
  const l = await detectLayout(dir);
  assert.equal(l.mode, 'multi');
  assert.equal(l.rooms.length, 1);
});

/* ---------- 验收 1：备份 + 数据一条不少 ---------- */

test('★ 验收1：备份目录存在，且备份内容与原数据一致', async () => {
  const dir = await makeLegacy({ lines: 13 });
  const backup = await backupBeforeMigration(dir);

  assert.equal(backup.ok, true);
  assert.ok(await exists(backup.path), '备份目录要真的存在');
  assert.equal(await countLines(join(backup.path, 'room.jsonl')), 13, '备份里 13 条一条不少');
  assert.ok(await exists(join(backup.path, 'room.json')));
  assert.ok(await exists(join(backup.path, 'agents', 'lead')), 'agents 目录也要备份');

  // 关键：备份完原数据还在（复制不是移动）
  assert.equal(await countLines(join(dir, 'room.jsonl')), 13, '备份不能动原数据');
});

test('★ 验收1：迁移后 rooms/r-legacy/ 里 13 条事件一条不少', async () => {
  const dir = await makeLegacy({ lines: 13, name: '旧房间' });
  const r = await migrateSingleRoom(dir);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.lines, 13);

  const roomDir = join(dir, 'rooms', LEGACY_ROOM_ID);
  assert.equal(await countLines(join(roomDir, 'room.jsonl')), 13, '一条都不能丢');
  assert.ok(await exists(join(roomDir, 'room.json')), 'room.json 也要搬过来');
  assert.ok(await exists(join(roomDir, 'agents', 'lead')), 'agent 目录要搬过来');
  assert.ok(await exists(join(roomDir, 'agents', 'bob')));

  // rooms.json 记下房间名和来源
  const meta = JSON.parse(await readFile(join(dir, ROOMS_FILE), 'utf8'));
  assert.equal(meta.rooms.length, 1);
  assert.equal(meta.rooms[0].id, LEGACY_ROOM_ID);
  assert.equal(meta.rooms[0].name, '旧房间', '房间名要沿用原来的');
  assert.equal(meta.migratedFromSingle, true, '要有迁移标记');
});

test('迁移后 room.json 内容与原文件完全一致（不能改写用户配置）', async () => {
  const dir = await makeLegacy();
  const before = await readFile(join(dir, 'room.json'), 'utf8');
  await migrateSingleRoom(dir);
  const after = await readFile(join(dir, 'rooms', LEGACY_ROOM_ID, 'room.json'), 'utf8');
  assert.equal(after, before);
});

/* ---------- 验收 2：幂等 ---------- */

test('★ 验收2：重复迁移不重复、不报错', async () => {
  const dir = await makeLegacy();
  const first = await migrateSingleRoom(dir);
  assert.equal(first.ok, true);

  const second = await migrateSingleRoom(dir);
  assert.equal(second.ok, true, '第二次不该报错');
  assert.equal(second.alreadyMigrated, true, '要识别出已迁移');

  const meta = JSON.parse(await readFile(join(dir, ROOMS_FILE), 'utf8'));
  assert.equal(meta.rooms.length, 1, '不能凭空多出一个房间');
  assert.equal(await countLines(join(dir, 'rooms', LEGACY_ROOM_ID, 'room.jsonl')), 13);
});

test('★ 验收2：模拟"重启两次"——每次都调一遍迁移入口', async () => {
  const dir = await makeLegacy({ lines: 7 });
  const logs = [];

  // 第一次启动
  const r1 = await migrateSingleRoom(dir, { log: (m) => logs.push(m) });
  assert.equal(r1.ok, true);

  // 第二次启动（同一个目录）
  const r2 = await migrateSingleRoom(dir, { log: (m) => logs.push(m) });
  assert.equal(r2.ok, true);
  assert.equal(r2.alreadyMigrated, true);

  // 只有一个备份目录（第二次不该再备份）
  const backups = (await readdir(dir)).filter((n) => n.startsWith('.multiagent-chat.bak-'));
  assert.equal(backups.length, 1, '不能每次都备份一份，会撑爆磁盘');

  assert.equal(await countLines(join(dir, 'rooms', LEGACY_ROOM_ID, 'room.jsonl')), 7);
});

/* ---------- 验收 3：迁移失败演练 ---------- */

test('★ 验收3：备份失败 → 中止迁移，数据原样保留，回到单房间模式', async () => {
  const dir = await makeLegacy({ lines: 5 });
  const now = Date.now();

  // 用一个可预测的时间戳算出备份目录名，提前把它占成一个**文件**。
  // 这样备份的 mkdir 必然失败（同名文件挡路），而且 root 也绕不过去
  // ——不能靠 chmod，root 无视权限位。
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await writeFile(join(dir, `.multiagent-chat.bak-${stamp}`), 'blocker');

  const logs = [];
  const r = await migrateSingleRoom(dir, { log: (m) => logs.push(m), now });

  assert.equal(r.ok, false, '备份失败必须中止迁移');
  assert.ok(
    /备份失败|备份不完整|EEXIST|没有可备份/.test(r.reason),
    `原因应指向备份：${r.reason}`,
  );

  // 数据一条不能丢，仍在单房间位置
  assert.equal(await countLines(join(dir, 'room.jsonl')), 5, '数据必须原样保留');
  assert.ok(await exists(join(dir, 'room.json')), 'room.json 还在原处');
  assert.equal((await detectLayout(dir)).mode, 'single', '仍是单房间模式，程序能照旧启动');
});

test('★ 验收3：备份函数失败时返回 ok:false 且不动数据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nofail-'));
  // 没有任何可备份的数据
  const r = await backupBeforeMigration(dir);
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有可备份的数据/);
});

test('★ 验收3：迁移中途失败 → 自动恢复，回到单房间模式', async () => {
  const dir = await makeLegacy({ lines: 9 });

  // 制造一个必然失败的迁移：把 rooms/ 建成一个文件（mkdir 会失败）
  await writeFile(join(dir, 'rooms'), 'blocker');

  const logs = [];
  const r = await migrateSingleRoom(dir, { log: (m) => logs.push(m) });

  assert.equal(r.ok, false, '应该失败');
  assert.equal(r.restored, true, '应该已从备份恢复');

  // 数据必须还在，且回到单房间布局
  assert.equal(await countLines(join(dir, 'room.jsonl')), 9, '数据一条不能丢');
  assert.ok(await exists(join(dir, 'room.json')), 'room.json 要回到原处');
  assert.equal(await exists(join(dir, ROOMS_FILE)), false, '不能留下半成品的 rooms.json');
  assert.equal((await detectLayout(dir)).mode, 'single', '应该回到单房间模式');
});

test('恢复后可以再次尝试迁移（不卡死）', async () => {
  const dir = await makeLegacy({ lines: 4 });
  await writeFile(join(dir, 'rooms'), 'blocker');

  const failed = await migrateSingleRoom(dir);
  assert.equal(failed.ok, false);

  // 移开障碍再试一次
  const { rm } = await import('node:fs/promises');
  await rm(join(dir, 'rooms'), { force: true });

  const retry = await migrateSingleRoom(dir);
  assert.equal(retry.ok, true, '障碍排除后应该能成功');
  assert.equal(await countLines(join(dir, 'rooms', LEGACY_ROOM_ID, 'room.jsonl')), 4);
});

/* ---------- 空目录 ---------- */

test('空目录不迁移也不报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blank-'));
  const r = await migrateSingleRoom(dir);
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有任何数据/);
});

test('★ 迁移不动 access-token（令牌是服务级的，不是房间级的）', async () => {
  const dir = await makeLegacy();
  const before = await readFile(join(dir, 'access-token'), 'utf8');
  await migrateSingleRoom(dir);
  assert.equal(
    await readFile(join(dir, 'access-token'), 'utf8'), before,
    '令牌必须留在根目录，否则重启会重新生成，老板的链接失效',
  );
  assert.equal(
    await exists(join(dir, 'rooms', LEGACY_ROOM_ID, 'access-token')), false,
    '不能把令牌搬进房间目录',
  );
});

/* ---------- 迁移必须是人明确要求的动作 ---------- */

test('★ 默认不迁移：服务重启不能悄悄动真实数据', async () => {
  const dir = await makeLegacy({ lines: 5 });
  const { ensureRoomsLayout } = await import('../src/core/rooms.js');

  const r = await ensureRoomsLayout(dir, { allowMigrate: false });

  assert.equal(r.single, true, '应保持单房间模式');
  assert.equal(r.meta.pendingMigration, true);
  assert.match(r.warning, /尚未迁移/);

  // 磁盘一个字节都没动
  assert.equal(await exists(join(dir, 'room.json')), true, 'room.json 还在原处');
  assert.equal(await countLines(join(dir, 'room.jsonl')), 5);
  assert.equal(await exists(join(dir, ROOMS_FILE)), false, '不能写 rooms.json');
  assert.equal(await exists(join(dir, 'rooms')), false, '不能建 rooms/ 目录');
});

test('显式允许时才迁移', async () => {
  const dir = await makeLegacy({ lines: 5 });
  const { ensureRoomsLayout } = await import('../src/core/rooms.js');
  const r = await ensureRoomsLayout(dir, { allowMigrate: true });
  assert.equal(r.single, false);
  assert.equal(await countLines(join(dir, 'rooms', LEGACY_ROOM_ID, 'room.jsonl')), 5);
});

test('★ startServer 默认不迁移（生产重启不会动数据）', async () => {
  const dir = await makeLegacy({ lines: 3 });
  const { startServer } = await import('../src/server.js');
  const { server, manager } = await startServer({ port: 0, dataDir: dir });
  try {
    assert.equal(manager.meta.pendingMigration, true);
    assert.equal(await exists(join(dir, 'rooms', LEGACY_ROOM_ID)), false, '不能建 rooms/r-legacy');
    assert.equal(await exists(join(dir, 'room.json')), true);
  } finally {
    server.close();
  }
});
