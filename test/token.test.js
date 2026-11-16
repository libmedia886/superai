/**
 * 访问令牌是**服务级**的，不跟房间走。
 *
 * 这条规则的由来：多房间迁移曾把 `<data>/access-token` 一起搬进
 * `rooms/r-legacy/`，重启后根目录找不到就生成了新的 —— 老板手上的链接失效。
 * 所以这里的测试重点不是"能生成令牌"，而是**不再换掉已有的令牌**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAccessToken, findLegacyToken, isPlausibleToken, TOKEN_FILE } from '../src/core/token.js';
import { migrateSingleRoom, LEGACY_ROOM_ID } from '../src/core/rooms.js';

const OLD = 'a'.repeat(32);

const exists = async (p) => { try { await readFile(p); return true; } catch { return false; } };

async function makeDataDir({ token = OLD, room = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tok-'));
  if (room) {
    await writeFile(join(dir, 'room.json'), JSON.stringify({
      name: '旧房间', members: [{ id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly' }],
    }));
    await writeFile(join(dir, 'room.jsonl'), '{"v":1,"seq":1,"kind":"message","message":{"id":"M-1","senderId":"human","body":"hi"}}\n');
    await mkdir(join(dir, 'agents', 'lead'), { recursive: true });
  }
  if (token) await writeFile(join(dir, TOKEN_FILE), token);
  return dir;
}

test('根目录已有令牌 → 原样复用，不生成新的', async () => {
  const dir = await makeDataDir();
  const r = await resolveAccessToken(dir);
  assert.equal(r.token, OLD);
  assert.equal(r.reused, true);
  assert.equal(await readFile(join(dir, TOKEN_FILE), 'utf8'), OLD);
});

test('★ 迁移后根目录没有令牌 → 从房间目录捞回，且沿用旧值', async () => {
  const dir = await makeDataDir();
  await migrateSingleRoom(dir);

  // 迁移本身不搬令牌（MOVABLE 里没有它）
  assert.equal(await exists(join(dir, TOKEN_FILE)), true, '迁移不能动根目录令牌');

  // 再造一次"历史事故"：令牌只在房间里，根目录没有
  await rename(join(dir, TOKEN_FILE), join(dir, 'rooms', LEGACY_ROOM_ID, TOKEN_FILE));

  const r = await resolveAccessToken(dir);
  assert.equal(r.token, OLD, '必须沿用旧令牌，不能重新生成');
  assert.equal(r.recoveredFrom, join(dir, 'rooms', LEGACY_ROOM_ID, TOKEN_FILE));
  assert.equal(await readFile(join(dir, TOKEN_FILE), 'utf8'), OLD, '根目录必须有权威副本');

  // 是复制不是移动：房间目录里的那份还在（删不删都行，但不能靠 rename 完成恢复）
  assert.equal(await exists(join(dir, 'rooms', LEGACY_ROOM_ID, TOKEN_FILE)), true);
});

test('捞回之后再次启动 → 直接用根目录的，不再扫描房间', async () => {
  const dir = await makeDataDir({ token: null });
  await mkdir(join(dir, 'rooms', 'r-x'), { recursive: true });
  await writeFile(join(dir, 'rooms', 'r-x', TOKEN_FILE), OLD);

  const first = await resolveAccessToken(dir);
  assert.equal(first.token, OLD);
  assert.ok(first.recoveredFrom);

  const second = await resolveAccessToken(dir);
  assert.equal(second.token, OLD);
  assert.equal(second.recoveredFrom, null, '第二次应该直接读根目录');
});

test('哪都没有令牌 → 生成新的并落盘', async () => {
  const dir = await makeDataDir({ token: null });
  const r = await resolveAccessToken(dir);
  assert.equal(isPlausibleToken(r.token), true);
  assert.equal(r.reused, false);
  assert.equal(await readFile(join(dir, TOKEN_FILE), 'utf8'), r.token);
});

test('被写坏的文件（不是 32 位 hex）不算令牌', async () => {
  const dir = await makeDataDir({ token: '' });
  await writeFile(join(dir, TOKEN_FILE), 'not-a-token');
  const r = await resolveAccessToken(dir);
  assert.notEqual(r.token, 'not-a-token');
  assert.equal(isPlausibleToken(r.token), true);
});

test('显式指定令牌时直接用（不读文件）', async () => {
  const dir = await makeDataDir({ token: null });
  const r = await resolveAccessToken(dir, 'b'.repeat(32));
  assert.equal(r.token, 'b'.repeat(32));
  await assert.rejects(() => resolveAccessToken(dir, 'short'), /32 位/);
});

test('findLegacyToken 只认合法令牌', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tok-scan-'));
  await mkdir(join(dir, 'rooms', 'r-a'), { recursive: true });
  await writeFile(join(dir, 'rooms', 'r-a', TOKEN_FILE), 'garbage');
  assert.equal((await findLegacyToken(dir)).token, null);

  await mkdir(join(dir, 'rooms', 'r-b'), { recursive: true });
  await writeFile(join(dir, 'rooms', 'r-b', TOKEN_FILE), 'c'.repeat(32));
  const found = await findLegacyToken(dir);
  assert.equal(found.token, 'c'.repeat(32));
});
