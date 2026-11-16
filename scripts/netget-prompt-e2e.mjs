/**
 * CR-046 真机验证：成员配了「联网查询」，**真实路径**下到底能不能跑通。
 *
 *   node scripts/netget-prompt-e2e.mjs
 *
 * 为什么单独写这个：`netget-e2e.mjs` 的 B 层是**我手工把绝对路径拼进提示词**的，
 * 那验证的是"如果提示词对了，命令能跑"。但 CR-046 的 bug 恰恰在中间这一段——
 * `prompt.js` 不告诉模型绝对路径，模型就写裸 `netget`，而审批器是字面前缀匹配，
 * 于是 **功能做完了、界面勾了、成员配了，实际一条也跑不了**。
 *
 * 所以这里走完整链路：
 *   真实 Room → 真实 buildPrompt() → 真实 claude CLI → 磁盘核对
 * 不看模型自述。
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RoomManager } from '../src/core/sessions.js';

const ok = (c) => (c ? '✅' : '❌');
let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${ok(cond)} ${label}${!cond && extra ? `（${extra}）` : ''}`);
  if (!cond) failed += 1;
};
const exists = async (p) => { try { await readFile(p); return true; } catch { return false; } };

/* ---------- 造一个真实房间：一个 write-exec + netget 的成员 ---------- */
/**
 * ⚠️ 必须走 `RoomManager`，不能直接用 `buildRoom`。
 * `netgetPath` 是 RoomManager 在打开房间时生成包装器并挂到成员上的；
 * 直接用 buildRoom 拿到的成员没有这个字段 —— 那是**测试走旁路**，
 * 会得出"产品坏了"的错误结论（这个脚本第一版就是这么错的）。
 */
const dataDir = await mkdtemp(join(tmpdir(), 'cr046-'));
const roomDir = join(dataDir, 'rooms', 'r-t');
await mkdir(join(roomDir, 'agents', 'scout'), { recursive: true });
await writeFile(join(dataDir, 'rooms.json'), JSON.stringify({
  version: 1, activeRoomId: 'r-t',
  rooms: [{ id: 'r-t', name: 'CR-046 实测', createdAt: new Date().toISOString() }],
}));
await writeFile(join(roomDir, 'room.json'), JSON.stringify({
  name: 'CR-046 实测',
  goal: '查资料',
  registry: [],
  members: [{
    id: 'scout', name: 'scout', role: 'leader', backend: 'claude',
    tier: 'write-exec', allowedCommands: ['netget'],
  }],
}, null, 2));

const manager = new RoomManager({ dataDir, onEvent: () => {} });
await manager.init();
if (!manager.session) {
  console.log('❌ RoomManager 没能打开房间（房间配置文件可能不合规）');
  process.exit(1);
}
const room = manager.session.room;
const agent = manager.session.members[0];
const netgetPath = agent.netgetPath;

console.log('=== A. 链路是否接上 ===\n');
check(Boolean(netgetPath), `包装器路径已挂到成员上（${netgetPath}）`);
check(Boolean(netgetPath) && await exists(netgetPath), '包装器文件真实存在');

/* ---------- B. 真实 buildPrompt：里面有没有绝对路径 ---------- */
const { buildPrompt } = await import('../src/core/prompt.js');
const prompt = buildPrompt({
  agent,
  room,
  store: room.store,
  trigger: { senderId: 'human', body: '查一下 example.com' },
  mode: 'since-last',
  taskId: null,
  actionResults: [],
});

console.log('\n=== B. 真实 prompt 的内容 ===\n');
check(prompt.includes(netgetPath), '提示词里给出了**绝对路径**（这是 CR-046 的核心）');
check(/必须写全路径|写 `netget` 或 `\.\/netget` 都会被拒/.test(prompt),
  '明确警告"裸名字会被拒"');
check(/只允许 http\/https GET|file:\/\/ 会被拒/.test(prompt), '写清了协议限制');
check(!/只能执行这些命令：netget/.test(prompt), '不能只给裸名字（那就是原来的 bug）');

/* ---------- C. 真 CLI 跑一轮：用 prompt.js 生成的那段 ---------- */
console.log('\n=== C. 真 claude 跑一轮（提示词来自 prompt.js，不是我手拼的）===\n');

const ask = `查一下 example.com 首页，把内容存到 work/page.html。
（你可以修改工作目录内的文件。请只用一个动作完成。）`;

const result = await room.humanSay('@scout ' + ask);
await room.drain();

const agentDir = join(roomDir, 'agents', 'scout');
const pagePath = join(agentDir, 'page.html');
const got = await exists(pagePath);

// 也接受模型存到别的相对路径（它可能写 tmp/page.html 之类）
let found = got;
if (!found) {
  const { readdir } = await import('node:fs/promises');
  try {
    const entries = await readdir(agentDir, { recursive: true });
    found = entries.some((f) => /\.(html?|txt)$/.test(f));
  } catch { /* ignore */ }
}

check(found, '磁盘上出现了下载的文件（说明命令真的跑起来了）',
  found ? '' : `工作目录：${agentDir}`);

const msgs = room.store.messages.filter((m) => m.senderId === 'scout');
const last = msgs[msgs.length - 1];
console.log(`   模型最后一条：${String(last?.body ?? '').slice(0, 200).replace(/\n/g, ' ')}`);

if (got) {
  const body = await readFile(pagePath, 'utf8');
  check(/Example Domain/i.test(body), '文件内容确实是 example.com 的页面');
} else if (found) {
  // 模型可能落在 work/page.html 之类的相对路径（prompt 里就是这么示例的）
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(agentDir, { recursive: true });
  const hit = entries.find((f) => /\.html?$/.test(f));
  const body = hit ? await readFile(join(agentDir, hit), 'utf8') : '';
  check(/Example Domain/i.test(body), `文件内容确实是 example.com 的页面（${hit}）`);
} else {
  console.log('   （没有任何下载产物，跳过内容核对）');
}

console.log(`\n${failed ? `❌ ${failed} 项失败` : '✅ 全部通过'}`);
process.exit(failed ? 1 : 0);
