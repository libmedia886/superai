/**
 * 用量异常提示的三项要求：
 *  1. 正常对话时不提示
 *  2. 人为构造大用量时提示
 *  3. 提示不重复刷屏
 *
 *   node scripts/usage-e2e.mjs
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

const ok = (c) => (c ? '✅' : '❌');

async function makeRoom(tokenSequence) {
  const dir = await mkdtemp(join(tmpdir(), 'usage-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  let i = 0;
  const room = new Room({
    id: 'r', name: 'r', goal: '用量测试',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
      { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
    ],
    store,
    resolveAdapter: (agent) => ({
      run: async ({ onEvent }) => {
        const tokens = tokenSequence[Math.min(i, tokenSequence.length - 1)];
        i += 1;
        onEvent({
          type: 'usage',
          inputTokens: tokens, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, contextWindow: 1_000_000,
        });
        return { text: '收到。', reason: 'completed', usage: { inputTokens: tokens, outputTokens: 0, contextWindow: 1_000_000 } };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  room.turnTimeoutMs = 5_000;
  room.maxRetries = 0;
  return { room, events };
}

/* ---------- 1. 正常对话不提示 ---------- */
console.log('=== 1. 正常对话（用量平稳）===');
{
  const { room, events } = await makeRoom([1000, 1050, 980, 1020, 1010, 1030]);
  for (let i = 0; i < 6; i += 1) {
    await room.humanSay(`@${i % 2 ? 'bob' : 'lead'} 第 ${i + 1} 轮`);
    await room.drain();
  }
  const warns = events.filter((e) => e.type === 'usage.warning');
  console.log(`   用量提示：${warns.length} 条`);
  console.log(`${ok(warns.length === 0)} 平稳用量不提示（不是每轮都喊狼来了）`);
}

/* ---------- 2. 突增要提示 ---------- */
console.log('\n=== 2. 人为构造大用量 ===');
{
  const { room, events } = await makeRoom([1000, 1000, 1000, 1000, 50_000, 50_000]);
  for (let i = 0; i < 6; i += 1) {
    await room.humanSay(`@lead 第 ${i + 1} 轮`);
    await room.drain();
  }
  const warns = events.filter((e) => e.type === 'usage.warning');
  console.log(`   用量提示：${warns.length} 条`);
  if (warns.length) {
    for (const w of warns) console.log(`   [${w.kind}] ${w.text}`);
  }
  console.log(`${ok(warns.length >= 1)} 突增被提示`);
}

/* ---------- 3. 不刷屏 ---------- */
console.log('\n=== 3. 连续大用量不刷屏 ===');
{
  const seq = [1000, 1000, 1000, 1000];
  for (let i = 0; i < 8; i += 1) seq.push(50_000);   // 连续 8 轮都用大用量
  const { room, events } = await makeRoom(seq);
  for (let i = 0; i < seq.length; i += 1) {
    await room.humanSay(`@lead 第 ${i + 1} 轮`);
    await room.drain();
  }
  const warns = events.filter((e) => e.type === 'usage.warning');
  console.log(`   8 轮大用量共提示：${warns.length} 条`);
  console.log(`${ok(warns.length <= 2)} 没有每轮都提示（冷却期生效）`);
}

/* ---------- 4. 不拦截 ---------- */
console.log('\n=== 4. 只提示不拦截 ===');
{
  const { room, events } = await makeRoom([1000, 1000, 1000, 99_999_999]);
  for (let i = 0; i < 4; i += 1) {
    await room.humanSay(`@lead 第 ${i + 1} 轮`);
    await room.drain();
  }
  const warns = events.filter((e) => e.type === 'usage.warning');
  const msgs = events.filter((e) => e.type === 'message' && e.message.senderId === 'lead');
  console.log(`   提示 ${warns.length} 条，但 agent 发言 ${msgs.length} 条`);
  console.log(`${ok(warns.length > 0 && msgs.length === 4)} 提示了但没拦住任何一轮`);
}
