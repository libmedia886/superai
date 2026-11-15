/**
 * continue 动作端到端：agent 声明 continue → 下一位被唤起 → 连续 3 次被拦 → 人说话重置。
 *
 *   node scripts/continue-e2e.mjs
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

const ok = (c) => (c ? '✅' : '❌');

const dir = await mkdtemp(join(tmpdir(), 'cont-'));
const store = new Store(join(dir, 'room.jsonl'));
await store.load();

const members = [
  { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
  { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
  { id: 'carol', name: 'carol', role: 'member', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
];

const events = [];
let turn = 0;

/** 每个 agent 都声明 continue，模拟"事情一直没完" */
const room = new Room({
  id: 'r', name: 'continue 测试', goal: '验证自动推进',
  members, store,
  resolveAdapter: () => ({
    run: async ({ prompt }) => {
      turn += 1;
      return {
        text: `第 ${turn} 轮已处理完。\n\`\`\`action\n{"action":"continue","localId":"c${turn}","reason":"还有下一步没做"}\n\`\`\``,
        reason: 'completed',
      };
    },
  }),
  onEvent: (e) => events.push(e),
});
room.turnTimeoutMs = 5_000;
room.maxRetries = 0;

console.log('=== 1. agent 声明 continue → 下一位被唤起 ===');
await room.humanSay('@lead 开始干活');
await room.drain();

const advances = events.filter((e) => e.type === 'auto.advance');
console.log(`   自动推进次数：${advances.length}`);
for (const a of advances) {
  console.log(`   ${a.from} → ${a.to}（${a.reason}）第 ${a.count} 次`);
}
console.log(`${ok(advances.length > 0)} 有人被自动唤起`);
console.log(`${ok(advances.every((a) => a.to !== a.from))} 没派给自己`);

console.log('\n=== 2. 连续 continue 3 次后被拦 ===');
const blocked = events.filter((e) => e.type === 'notice' && /连续自动推进/.test(e.text ?? ''));
console.log(`   被拦次数：${blocked.length}`);
if (blocked.length) console.log(`   提示：${blocked[0].text}`);
console.log(`${ok(room.autoAdvance.count === room.autoAdvance.maxContinuous)} 计数停在上限 ${room.autoAdvance.maxContinuous}`);
console.log(`${ok(room.waitingForHuman)} 房间已停住等人`);

console.log('\n=== 3. 人类发言能重置计数 ===');
const before = room.autoAdvance.count;
await room.humanSay('@bob 继续吧');
console.log(`${ok(room.autoAdvance.count === 0)} 人类说话后计数归零（之前 ${before}）`);

await room.drain();
const afterReset = room.autoAdvance.count;
console.log(`${ok(afterReset > 0)} 重置后又能自动推进了（现在 ${afterReset} 次）`);

console.log('\n=== 汇总 ===');
console.log(`失败事件：${events.filter((e) => e.type === 'failure').length}`);
console.log(`数据目录：${dir}`);
