/**
 * CR-006 端到端：ASK → checkpoint → FIRE。
 *
 * 这条测的是**跨轮次编排**，单测各模块分别通过也可能接错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';
import { PHASE } from '../src/core/handoff.js';

const HIGH_USAGE = { inputTokens: 150_000, outputTokens: 100, contextWindow: 200_000 };  // 75%

async function makeRoom(responder) {
  const dir = await mkdtemp(join(tmpdir(), 'ho-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const prompts = [];
  const room = new Room({
    id: 'r', name: 'r', goal: '测试',
    members: [{ id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' }],
    store,
    resolveAdapter: () => ({
      run: async ({ prompt }) => {
        prompts.push(prompt);
        return responder(prompt);
      },
    }),
    onEvent: (e) => events.push(e),
  });
  return { room, events, prompts };
}

const HANDOFF_REPLY = [
  '正常回答如下。',
  '```handoff',
  '正在做：测试交接',
  '已定：握手有效',
  '待办：无',
  '我的立场：先交接再压缩',
  '```',
].join('\n');

test('★ 完整流程：高用量 → ASK → 交接 → 轮换（用交接而非摘要）', async () => {
  const { room, events, prompts } = await makeRoom((prompt) => ({
    text: prompt.includes('请先交接') ? HANDOFF_REPLY : '收到。',
    reason: 'completed',
    usage: HIGH_USAGE,
  }));

  // 第一轮：用量到 75%，标记需要压缩
  await room.humanSay('@lead 第一轮');
  await room.drain();
  assert.ok(events.some((e) => e.type === 'context.nearLimit'), '应标记上下文接近上限');

  // 第二轮：开头发 ASK，回复里带交接块
  await room.humanSay('@lead 第二轮');
  await room.drain();
  assert.ok(events.some((e) => e.type === 'compact.asking'), '应发出 ASK');
  assert.ok(events.some((e) => e.type === 'handoff.received'), '应收到交接');
  assert.match(prompts[1], /请先交接/, '第二轮的 prompt 必须带上 ASK 指令');
  assert.equal(room.handoff.snapshot('lead').phase, PHASE.READY);

  // 第三轮：真正轮换
  await room.humanSay('@lead 第三轮');
  await room.drain();
  const done = events.filter((e) => e.type === 'compact.done');
  assert.equal(done.length, 1);
  assert.equal(done[0].mode, 'handoff', '必须优先用 agent 自己的交接，不是我们的摘要');

  // 轮换后的 prompt 带着交接内容
  assert.match(prompts[2], /压缩前你自己写的交接/);
  assert.match(prompts[2], /先交接再压缩/, 'agent 自己的立场必须进新上下文');
});

test('★ 它不交就绝不轮换（可以一直等）', async () => {
  const { room, events } = await makeRoom((prompt) => ({
    text: prompt.includes('请先交接') ? '我继续干活，没写交接。' : '收到。',
    reason: 'completed',
    usage: HIGH_USAGE,
  }));

  await room.humanSay('@lead 第一轮');
  await room.drain();
  for (let i = 0; i < 3; i += 1) {
    await room.humanSay(`@lead 第 ${i + 2} 轮`);
    await room.drain();
  }

  assert.equal(events.filter((e) => e.type === 'compact.done').length, 0, '没交接就一次都不能压');
  assert.equal(room.handoff.snapshot('lead').phase, PHASE.AWAITING, '保持等待，不放弃也不硬来');
  assert.ok(events.filter((e) => e.type === 'compact.asking').length >= 1, '每轮都该再要一次');
});

test('交接块不进入聊天正文（技术内容不该露给用户）', async () => {
  const { room, events } = await makeRoom((prompt) => ({
    text: prompt.includes('请先交接') ? HANDOFF_REPLY : '收到。',
    reason: 'completed',
    usage: HIGH_USAGE,
  }));

  await room.humanSay('@lead 第一轮');
  await room.drain();
  await room.humanSay('@lead 第二轮');
  await room.drain();

  const agentMsgs = events
    .filter((e) => e.type === 'message' && e.message.senderId === 'lead')
    .map((e) => e.message.body);
  assert.ok(agentMsgs.some((b) => b.includes('正常回答如下')), '正常内容要在');
  assert.ok(!agentMsgs.some((b) => b.includes('```handoff')), '交接块不该出现在聊天流里');
  assert.ok(!agentMsgs.some((b) => b.includes('先交接再压缩')), '交接内容也不该露出来');
});

test('空壳交接不算交（下一轮继续要）', async () => {
  const { room } = await makeRoom((prompt) => ({
    text: prompt.includes('请先交接') ? '回答。\n```handoff\n\n```' : '收到。',
    reason: 'completed',
    usage: HIGH_USAGE,
  }));

  await room.humanSay('@lead 第一轮');
  await room.drain();
  await room.humanSay('@lead 第二轮');
  await room.drain();

  assert.equal(room.handoff.canFire('lead'), false);
  assert.equal(room.handoff.snapshot('lead').phase, PHASE.AWAITING);
});
