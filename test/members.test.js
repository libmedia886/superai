/**
 * agent 造人（member.create）。
 *
 * 核心是房间级权限天花板 `aiCabTier`：
 *   人设上限，agent 请求的档位不能超过它。默认只读。
 *
 * 为什么超限要"拒绝"而不是"静默降级"：静默降级会让它以为造出了一个可写成员，
 * 然后派活、等结果、什么也没发生——它永远不知道问题在哪。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';
import {
  planMemberCreation, capTier, MAX_MEMBERS, DEFAULT_AI_CAB_TIER,
} from '../src/core/members.js';
import { validateAction, authorize } from '../src/core/actions.js';
import { TIER } from '../src/core/probe.js';

const baseMembers = [
  { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: TIER.READONLY, cwd: '/tmp' },
  { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: TIER.READONLY, cwd: '/tmp' },
];

/* ---------- 天花板逻辑 ---------- */

test('天花板默认是只读', () => {
  assert.equal(DEFAULT_AI_CAB_TIER, TIER.READONLY);
});

test('没写 tier → 用天花板档位', () => {
  assert.deepEqual(capTier(undefined, TIER.READONLY), { tier: TIER.READONLY, capped: false });
  assert.deepEqual(capTier(undefined, TIER.WRITE), { tier: TIER.WRITE, capped: false });
});

test('★ 请求超过天花板 → 标记 capped 且说明原因', () => {
  const r = capTier(TIER.WRITE, TIER.READONLY);
  assert.equal(r.capped, true);
  assert.match(r.reason, /最高只能到「readonly」/);
  assert.match(r.reason, /不能是「write」/);
  assert.match(r.reason, /让老板手动调整/);
});

test('请求等于天花板 → 允许', () => {
  assert.equal(capTier(TIER.WRITE, TIER.WRITE).capped, false);
});

test('请求低于天花板 → 允许', () => {
  assert.equal(capTier(TIER.READONLY, TIER.WRITE).capped, false);
});

test('未知档位按超限处理（保守）', () => {
  const r = capTier('superuser', TIER.READONLY);
  assert.equal(r.capped, true);
});

test('write-exec 天花板允许 write', () => {
  assert.equal(capTier(TIER.WRITE, TIER.WRITE_EXEC).capped, false);
  assert.equal(capTier(TIER.WRITE_EXEC, TIER.WRITE).capped, true);
});

/* ---------- 校验 ---------- */

test('reason 必填且不能太短', () => {
  assert.match(validateAction({ action: 'member.create', name: 'x' }), /需要 reason/);
  assert.match(validateAction({ action: 'member.create', name: 'x', reason: '要' }), /太短/);
  assert.equal(validateAction({ action: 'member.create', name: 'x', reason: '缺一个查资料的人' }), null);
});

test('缺 name 被拒', () => {
  assert.match(validateAction({ action: 'member.create', reason: '缺一个查资料的人' }), /缺少 name/);
});

test('★ 只有头头能造人', () => {
  assert.equal(authorize({ action: 'member.create' }, { role: 'leader' }), null);
  assert.match(authorize({ action: 'member.create' }, { role: 'member' }), /只有头头/);
});

/* ---------- plan 的各拒绝分支 ---------- */

test('重名被拒', () => {
  const r = planMemberCreation({
    action: { name: 'bob', reason: '缺一个查资料的人' }, members: baseMembers,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /已存在/);
});

test('人数达上限被拒', () => {
  const many = Array.from({ length: MAX_MEMBERS }, (_, i) => ({ id: `m${i}`, name: `m${i}`, backend: 'claude' }));
  const r = planMemberCreation({
    action: { name: 'newbie', reason: '缺一个查资料的人' }, members: many,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /上限 8/);
});

test('不支持的 backend 被拒', () => {
  const r = planMemberCreation({
    action: { name: 'x', backend: 'gpt5', reason: '缺一个查资料的人' }, members: baseMembers,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不支持的后端/);
});

test('★ 请求超过天花板 → plan 直接拒绝（不是降级）', () => {
  const r = planMemberCreation({
    action: { name: 'x', tier: TIER.WRITE, reason: '需要能改文件的人' },
    members: baseMembers, ceiling: TIER.READONLY,
  });
  assert.equal(r.ok, false, '不能静默降级成只读');
  assert.match(r.reason, /最高只能到/);
});

test('请求在天花板内 → 按请求的档位创建', () => {
  const r = planMemberCreation({
    action: { name: 'x', tier: TIER.WRITE, reason: '需要能改文件的人' },
    members: baseMembers, ceiling: TIER.WRITE,
  });
  assert.equal(r.ok, true);
  assert.equal(r.member.tier, TIER.WRITE);
});

/* ---------- 端到端 ---------- */

async function makeRoom({ ceiling = TIER.READONLY } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mem-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const created = [];

  const room = new Room({
    id: 'r', name: 'r', goal: 't',
    members: baseMembers.map((m) => ({ ...m })),
    store,
    aiCabTier: ceiling,
    onMemberCreate: async (m) => { created.push(m); return { ...m, cwd: '/tmp', aliases: [m.name] }; },
    resolveAdapter: () => ({ run: async () => ({ text: '', reason: 'completed' }) }),
    onEvent: (e) => events.push(e),
  });
  room.turnTimeoutMs = 5_000;
  room.maxRetries = 0;
  return { room, events, created, dir };
}

/** 让某个 agent 说一句带 member.create 的话 */
async function runAction(room, agentId, action) {
  room.resolveAdapter = () => ({
    run: async () => ({
      text: `好的。\n\`\`\`action\n${JSON.stringify(action)}\n\`\`\``,
      reason: 'completed',
    }),
  });
  await room.humanSay(`@${agentId} 处理一下`);
  await room.drain();
  return room.toolLog;   // 占位
}

test('★ 头头造人成功 → 成员真的加进来了，且是只读', async () => {
  const { room, events, created } = await makeRoom();
  await roomAction(room, 'lead', {
    action: 'member.create', name: 'carol', backend: 'claude', reason: '缺一个专门查资料的人',
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].tier, TIER.READONLY, '默认天花板只读');
  assert.equal(room.members.length, 3);
  assert.ok(room.members.some((m) => m.name === 'carol'));
  assert.ok(events.some((e) => e.type === 'member.created' && e.member.name === 'carol'));
});

test('★ 成员造人 → 拒绝，且成员没被加进来', async () => {
  const { room, events, created } = await makeRoom();
  await roomAction(room, 'bob', {
    action: 'member.create', name: 'eve', backend: 'claude', reason: '我想加个帮手',
  });

  assert.equal(created.length, 0, '不该真的创建');
  assert.equal(room.members.length, 2);
  assert.ok(events.some((e) => e.type === 'action.results'
    && e.results.some((r) => !r.ok && /只有头头/.test(r.reason ?? ''))));
});

test('★ 天花板只读时，头头请求 write → 拒绝并说明', async () => {
  const { room, events, created } = await makeRoom({ ceiling: TIER.READONLY });
  await roomAction(room, 'lead', {
    action: 'member.create', name: 'dev', backend: 'claude', tier: TIER.WRITE,
    reason: '需要一个能直接改代码的人',
  });

  assert.equal(created.length, 0, '超天花板不能创建');
  const res = events.find((e) => e.type === 'action.results')?.results?.[0];
  assert.equal(res.ok, false);
  assert.match(res.reason, /最高只能到/);
  assert.match(res.reason, /让老板手动调整/);
});

test('天花板提到 write 时，头头就能造可写成员', async () => {
  const { room, created } = await makeRoom({ ceiling: TIER.WRITE });
  await roomAction(room, 'lead', {
    action: 'member.create', name: 'dev', backend: 'claude', tier: TIER.WRITE,
    reason: '需要一个能直接改代码的人',
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].tier, TIER.WRITE);
});

test('★ 天花板 write 时，请求 write-exec 仍被拒', async () => {
  const { room, created, events } = await makeRoom({ ceiling: TIER.WRITE });
  await roomAction(room, 'lead', {
    action: 'member.create', name: 'ops', backend: 'claude', tier: TIER.WRITE_EXEC,
    reason: '需要一个能跑命令的人',
  });
  assert.equal(created.length, 0);
  const res = events.find((e) => e.type === 'action.results')?.results?.[0];
  assert.match(res.reason, /最高只能到「write」/);
});

test('重名 / 上限 / 理由太短 都走拒绝分支', async () => {
  const { room, created } = await makeRoom();

  await roomAction(room, 'lead', {
    action: 'member.create', name: 'bob', backend: 'claude', reason: '重复名字测试',
  });
  assert.equal(created.length, 0, '重名不该创建');

  await roomAction(room, 'lead', {
    action: 'member.create', name: 'x', backend: 'claude', reason: '要',
  });
  assert.equal(created.length, 0, '理由太短不该创建');
});

/** 让某个 agent 执行一句话里的动作（不污染 toolLog） */
async function roomAction(room, agentId, action) {
  room.resolveAdapter = () => ({
    run: async () => ({
      text: `好的。\n\`\`\`action\n${JSON.stringify(action)}\n\`\`\``,
      reason: 'completed',
    }),
  });
  await room.humanSay(`@${agentId} 处理一下`);
  await room.drain();
}
