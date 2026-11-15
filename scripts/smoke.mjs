/**
 * 端到端冒烟：用真实的 claude / codex 跑一遍房间调度。
 *
 *   node scripts/smoke.mjs            # 两家都跑
 *   node scripts/smoke.mjs claude     # 只跑一家
 *
 * 检验的东西：探测、流式、会话持久化、@ 接力、动作协议落库。
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';
import { createAdapter } from '../src/adapters/index.js';

const only = process.argv[2];

const base = await mkdtemp(join(tmpdir(), 'ma-smoke-'));
const store = new Store(join(base, 'room.jsonl'));
await store.load();

const members = [
  {
    id: 'lead', name: 'lead', role: 'leader', backend: 'claude',
    persona: '你是任务拆解者，话极少。',
    cwd: join(base, 'agents', 'lead'),
  },
  {
    id: 'bob', name: 'bob', role: 'member', backend: 'codex',
    persona: '你是执行者，回答简短。',
    cwd: join(base, 'agents', 'bob'),
  },
].filter((m) => !only || m.backend === only);

const { mkdir } = await import('node:fs/promises');
for (const m of members) await mkdir(m.cwd, { recursive: true });

const adapters = new Map();
const events = [];

const room = new Room({
  id: 'r1',
  name: '冒烟房',
  members,
  store,
  resolveAdapter: (agent) => {
    if (!adapters.has(agent.id)) adapters.set(agent.id, createAdapter(agent));
    return adapters.get(agent.id);
  },
  onEvent: (ev) => {
    events.push(ev);
    if (ev.type === 'turn.start') console.log(`\n>>> ${ev.agentId} 开始发言`);
    if (ev.type === 'text' && ev.text) process.stdout.write(ev.text);
    if (ev.type === 'usage') console.log(`\n    [usage] in=${ev.inputTokens} out=${ev.outputTokens}`);
    if (ev.type === 'message') console.log(`\n<<< ${ev.message.senderId} 结束（${ev.durationMs}ms）`);
    if (ev.type === 'notice') console.log(`\n    [提示] ${ev.text}`);
    if (ev.type === 'action.results') console.log(`\n    [动作] ${JSON.stringify(ev.results)}`);
    if (ev.type === 'failure') console.log(`\n    [失败] ${ev.reason} ${ev.detail ?? ''}`);
    if (ev.type === 'task.created') console.log(`\n    [任务] ${JSON.stringify(ev.task)}`);
  },
});

// 1. 探测
console.log('== 探测 ==');
for (const m of members) {
  const a = room.resolveAdapter(m);
  const r = await a.probe(m.cwd, 45_000);
  console.log(`${m.backend}: ${r.ok ? '可用' : '不可用'} ${r.reason ?? ''}`);
  if (!r.ok && !r.version) console.log(`  ↳ 跳过 ${m.id}`);
}

// 2. 人下任务，@ 头头
const leadName = members.find((m) => m.role === 'leader')?.name;
console.log('\n== 人发言 ==');
const res = await room.humanSay(
  `@${leadName} 把"写一句关于海洋的话"拆成一个任务派给 bob，然后 @bob 让他做。`,
  { taskId: null },
);
console.log('解析结果：', res);

console.log('\n== 串行执行 ==');
await room.drain();

// 3. 验证落库
console.log('\n== 校验 ==');
const raw = await readFile(store.filePath, 'utf8');
const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
console.log(`事件条数：${lines.length}`);
console.log(`消息条数：${store.messages.length}`);
console.log(`任务：${JSON.stringify([...store.tasks.values()])}`);
console.log(`会话映射：${JSON.stringify([...store.sessions.entries()])}`);
const hasSession = [...store.sessions.values()].every((s) => s.sessionId);
console.log(`每个成员都有 session id：${hasSession ? '是' : '否'}`);
console.log(`房间最终等待人工：${room.waitingForHuman ? '是' : '否'}`);
console.log(`\n数据目录：${base}`);
