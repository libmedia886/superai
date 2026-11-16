/**
 * 迁移之后会话必须还能接上（否则上下文静默归零）。
 *
 * 场景（真实发生过）：
 *   迁移前 `session` 事件记的 cwd 是 `<data>/agents/<id>`，
 *   迁移后成员目录变成 `<data>/rooms/r-legacy/agents/<id>`。
 *   旧代码用字符串相等比 cwd → 判为"接不上" → 5 个成员全部从头开始，
 *   界面上看不出任何异常（它只是忘了以前所有的事）。
 *
 * 修法两件：
 *   1. `realpath` 比较（同一个目录的两个名字算相同）
 *   2. 迁移在根目录留 `agents -> rooms/r-legacy/agents` 链接（老路径仍然指得到）
 *
 * 反面要求同样重要：**真的换了目录时不能硬接**——claude/codex 用错 cwd
 * resume 会挂住不报错，所以那种情况必须重置并说明。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, lstat, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRoom } from '../src/core/config.js';
import { migrateSingleRoom, LEGACY_ROOM_ID } from '../src/core/rooms.js';

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const countLines = async (p) => {
  try { return (await readFile(p, 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; }
};

/** 造一个旧布局：room.json + room.jsonl（带 session 事件，cwd 指向老路径） */
async function makeLegacyWithSession() {
  const dir = await mkdtemp(join(tmpdir(), 'sess-'));
  const agents = join(dir, 'agents');
  await mkdir(join(agents, 'lead'), { recursive: true });
  await mkdir(join(agents, 'bob'), { recursive: true });

  await writeFile(join(dir, 'room.json'), JSON.stringify({
    name: '旧房间', members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly' },
      { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: 'readonly' },
    ],
  }, null, 2));

  const events = [
    { v: 1, seq: 1, kind: 'session', agentId: 'lead', sessionId: 'sess-lead-1', cwd: join(agents, 'lead'), backend: 'claude' },
    { v: 1, seq: 2, kind: 'session', agentId: 'bob', sessionId: 'sess-bob-1', cwd: join(agents, 'bob'), backend: 'claude' },
  ];
  await writeFile(join(dir, 'room.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

test('★ 迁移后根目录有 agents 兼容链接，老 cwd 仍然指得到', async () => {
  const dir = await makeLegacyWithSession();
  const r = await migrateSingleRoom(dir);
  assert.equal(r.ok, true);

  const link = join(dir, 'agents');
  assert.ok(await exists(link), '根目录 agents 应该存在（符号链接）');
  // 必须用 lstat：stat 会跟随链接，看到的永远是目标目录
  const st = await lstat(link);
  assert.ok(st.isSymbolicLink(), '应该是符号链接，不是复制一份');

  // 双方指向同一批目录
  assert.equal(await realpath(link), await realpath(join(dir, 'rooms', LEGACY_ROOM_ID, 'agents')));
  assert.ok(await exists(join(dir, 'agents', 'lead')), '老路径还能进到成员目录');
});

test('★ 迁移后会话能接上（realpath 比较，不是字符串相等）', async () => {
  const dir = await makeLegacyWithSession();
  await migrateSingleRoom(dir);

  const cfg = JSON.parse(await readFile(join(dir, 'rooms', LEGACY_ROOM_ID, 'room.json'), 'utf8'));
  const { members } = await buildRoom({ cfg, dataDir: join(dir, 'rooms', LEGACY_ROOM_ID) });

  const lead = members.find((m) => m.id === 'lead');
  const bob = members.find((m) => m.id === 'bob');
  assert.equal(lead.sessionId, 'sess-lead-1', 'lead 的会话必须接上');
  assert.equal(bob.sessionId, 'sess-bob-1', 'bob 的会话必须接上');
  assert.equal(lead.sessionResetReason, null, '接上了就不该说"已重置"');
});

test('★ 真的换了目录 → 不硬接，并给出可显示的原因', async () => {
  const dir = await makeLegacyWithSession();
  const cfg = JSON.parse(await readFile(join(dir, 'room.json'), 'utf8'));

  // 把数据目录换到别处（成员 cwd 变了，session 里记的还是老路径）
  const moved = await mkdtemp(join(tmpdir(), 'sess-moved-'));
  await mkdir(join(moved, 'agents', 'lead'), { recursive: true });
  await mkdir(join(moved, 'agents', 'bob'), { recursive: true });
  await writeFile(join(moved, 'room.json'), JSON.stringify(cfg, null, 2));
  // 数据一起搬走：session 事件里的 cwd 还是老路径，这正是要处理的情形
  await writeFile(join(moved, 'room.jsonl'), await readFile(join(dir, 'room.jsonl'), 'utf8'));
  const { members } = await buildRoom({ cfg, dataDir: moved });

  for (const m of members) {
    assert.equal(m.sessionId, null, 'cwd 不匹配时绝不能拿旧 session 去 resume（会挂住不报错）');
    assert.match(m.sessionResetReason, /工作目录已变/);
  }
});

test('★ 没有 session 记录时不报"已重置"（新房间不该显示警告）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sess-new-'));
  const cfg = { name: '新', members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly' }] };
  const { members } = await buildRoom({ cfg, dataDir: dir });
  assert.equal(members[0].sessionId, null);
  assert.equal(members[0].sessionResetReason, null, '从来没聊过，不能弹"上下文已重置"');
});

test('迁移失败回滚会清掉 agents 兼容链接（不留半成品）', async () => {
  const dir = await makeLegacyWithSession();
  const { restoreFromBackup, backupBeforeMigration } = await import('../src/core/rooms.js');
  const backup = await backupBeforeMigration(dir);
  assert.equal(backup.ok, true);

  await migrateSingleRoom(dir);
  assert.ok(await exists(join(dir, 'agents')), '迁移后链接在');

  await restoreFromBackup(dir, backup.path);
  const st = await lstat(join(dir, 'agents')).catch(() => null);
  assert.ok(st, 'agents 目录要恢复');
  assert.equal(st.isSymbolicLink(), false, '回滚后不能留下指向已删除 rooms/ 的断链');
  assert.ok(await exists(join(dir, 'agents', 'lead')), '恢复成真实目录，数据还在');
  assert.ok(await exists(join(dir, 'agents', 'bob')), '每个成员目录都要在');

  // 关键：备份复制不能顺着链接写进 rooms/（那样接着 rm -rf rooms/ 就丢数据）
  assert.ok(await exists(join(dir, 'room.json')), 'room.json 回到原处');
  assert.equal(await countLines(join(dir, 'room.jsonl')), 2, '事件一条不少');
});
