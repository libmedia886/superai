/**
 * agent 造人：八条验收分支逐条跑，把每个拒绝的 reason 文本打出来。
 *
 *   node scripts/member-e2e.mjs
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';
import { TIER } from '../src/core/probe.js';
import { MAX_MEMBERS } from '../src/core/members.js';

const ok = (c) => (c ? '✅' : '❌');
const results = [];
const check = (label, pass, detail = '') => {
  results.push(pass);
  console.log(`${ok(pass)} ${label}${detail ? `  →  ${detail}` : ''}`);
};

async function makeRoom({ ceiling = TIER.READONLY } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mem-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const created = [];
  const events = [];

  const room = new Room({
    id: 'r', name: '造人测试', goal: 't',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: TIER.READONLY, cwd: '/tmp' },
      { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: TIER.READONLY, cwd: '/tmp' },
    ],
    store,
    aiCabTier: ceiling,
    onMemberCreate: async (m) => { created.push(m); return { ...m, cwd: '/tmp', aliases: [m.name] }; },
    resolveAdapter: () => ({ run: async () => ({ text: '', reason: 'completed' }) }),
    onEvent: (e) => events.push(e),
  });
  room.turnTimeoutMs = 5_000;
  room.maxRetries = 0;
  return { room, created, events };
}

/** 让某个 agent 说一句带动作的话，返回该动作的执行结果 */
async function act(room, agentId, action) {
  room.resolveAdapter = () => ({
    run: async () => ({
      text: `好。\n\`\`\`action\n${JSON.stringify(action)}\n\`\`\``,
      reason: 'completed',
    }),
  });
  const before = room.onEvent;
  const captured = [];
  room.onEvent = (e) => { captured.push(e); before(e); };
  await room.humanSay(`@${agentId} 照做`);
  await room.drain();
  room.onEvent = before;
  return captured.find((e) => e.type === 'action.results')?.results?.[0] ?? null;
}

console.log('=== 验收：八条分支 ===\n');

/* 1. 天花板只读 + 不写 tier → readonly */
{
  const { room, created } = await makeRoom({ ceiling: TIER.READONLY });
  const r = await act(room, 'lead', {
    action: 'member.create', name: 'carol', backend: 'claude', reason: '缺一个专门查资料的人',
  });
  check('天花板=readonly，不写 tier → 只读',
    r?.ok && created[0]?.tier === TIER.READONLY,
    `实际 tier=${created[0]?.tier}`);
}

/* 2. 天花板只读 + 请求 write → 拒绝 */
{
  const { room, created } = await makeRoom({ ceiling: TIER.READONLY });
  const r = await act(room, 'lead', {
    action: 'member.create', name: 'dev', backend: 'claude', tier: TIER.WRITE, reason: '需要一个能改代码的人',
  });
  check('天花板=readonly，请求 write → 拒绝',
    r && !r.ok && created.length === 0, `reason="${r?.reason}"`);
}

/* 3. 天花板可写 + 请求 write → 允许 */
{
  const { room, created } = await makeRoom({ ceiling: TIER.WRITE });
  const r = await act(room, 'lead', {
    action: 'member.create', name: 'dev', backend: 'claude', tier: TIER.WRITE, reason: '需要一个能改代码的人',
  });
  check('天花板=write，请求 write → 允许',
    r?.ok && created[0]?.tier === TIER.WRITE, `实际 tier=${created[0]?.tier}`);
}

/* 4. 天花板可写 + 请求 write-exec → 拒绝 */
{
  const { room, created } = await makeRoom({ ceiling: TIER.WRITE });
  const r = await act(room, 'lead', {
    action: 'member.create', name: 'ops', backend: 'claude', tier: TIER.WRITE_EXEC, reason: '需要一个能跑命令的人',
  });
  check('天花板=write，请求 write-exec → 拒绝',
    r && !r.ok && created.length === 0, `reason="${r?.reason}"`);
}

/* 5. 成员造人 → 拒绝 */
{
  const { room, created } = await makeRoom();
  const r = await act(room, 'bob', {
    action: 'member.create', name: 'eve', backend: 'claude', reason: '我想给自己加个帮手',
  });
  check('成员造人 → 拒绝',
    r && !r.ok && created.length === 0, `reason="${r?.reason}"`);
}

/* 6. 第 9 个 → 拒绝 */
{
  const { room, created } = await makeRoom();
  const filler = Array.from({ length: MAX_MEMBERS - 2 }, (_, i) => ({
    id: `f${i}`, name: `f${i}`, role: 'member', backend: 'claude', tier: TIER.READONLY, cwd: '/tmp',
  }));
  room.members.push(...filler);
  const r = await act(room, 'lead', {
    action: 'member.create', name: 'nine', backend: 'claude', reason: '还想再加一个人',
  });
  check(`第 ${MAX_MEMBERS + 1} 个 → 拒绝`,
    r && !r.ok && created.length === 0, `reason="${r?.reason}"`);
}

/* 7. 重名 → 拒绝 */
{
  const { room, created } = await makeRoom();
  const r = await act(room, 'lead', {
    action: 'member.create', name: 'bob', backend: 'claude', reason: '再加一个 bob',
  });
  check('重名 → 拒绝',
    r && !r.ok && created.length === 0, `reason="${r?.reason}"`);
}

/* 8. 理由太短 → 拒绝 */
{
  const { room, created } = await makeRoom();
  const r = await act(room, 'lead', {
    action: 'member.create', name: 'x', backend: 'claude', reason: '要',
  });
  check('理由太短 → 拒绝',
    r && !r.ok && created.length === 0, `reason="${r?.reason}"`);
}

/* 9. 成功时成员真的进名册且出现在成员列表 */
{
  const { room, events } = await makeRoom();
  await act(room, 'lead', {
    action: 'member.create', name: 'carol', backend: 'codex', reason: '需要一个跑 codex 的人',
  });
  const ev = events.find((e) => e.type === 'member.created');
  check('成功后真的加进房间（含 member.created 事件）',
    room.members.length === 3 && Boolean(ev),
    `成员数 ${room.members.length}，新成员 tier=${ev?.member?.tier}`);
}

console.log(`\n=== 汇总：${results.filter(Boolean).length}/${results.length} 通过 ===`);
process.exit(results.every(Boolean) ? 0 : 1);
