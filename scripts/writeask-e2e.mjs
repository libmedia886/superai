/**
 * `write-ask` 档真机验证。
 *
 * 这条档位之前只验了"命令行参数存在"，没验过"在真实流程里真的会问"。
 * 关键问题：没有主进程应答时，它的行为是什么？会不会挂死？会不会写成功？
 */

import { mkdtemp, readFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAdapter } from '../src/adapters/index.js';
import { tierArgs, approvalLabel } from '../src/adapters/claude.js';

const ok = (c) => (c ? '✅' : '❌');
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const base = await mkdtemp(join(tmpdir(), 'writeask-'));
const cwd = join(base, 'agent');
await mkdir(cwd, { recursive: true });

console.log('=== 参数检查 ===');
console.log('tierArgs:', tierArgs('write-ask').join(' '));
console.log(`${ok(!tierArgs('write-ask').includes('acceptEdits'))} 不含 acceptEdits（那等于自动批准，询问档就成假的）`);
console.log(`${ok(tierArgs('write-ask').includes('host'))} permission-prompts 是 host（要人应答）`);
console.log('界面文案:', approvalLabel('write-ask'));

console.log('\n=== 真机行为 ===');
const adapter = createAdapter({ backend: 'claude', tier: 'write-ask' });
const target = join(cwd, 'should-need-approval.txt');

const t0 = Date.now();
const r = await adapter.run({
  prompt: `创建文件 ${target}，内容写 hello。做不到就只回答 DENIED。`,
  cwd,
  sessionId: null,
  timeoutMs: 120_000,
  onEvent: () => {},
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const wrote = await exists(target);
console.log(`${ok(!wrote)} 文件没有被写出来（没人在场批准）`);
console.log(`${ok(r.reason === 'completed')} 进程正常结束，不挂死（${elapsed}s，reason=${r.reason}）`);
console.log(`   它的回答：${r.text.slice(0, 150).replace(/\n/g, ' ')}`);

// 对照：同样的任务在 write 档下应该直接成功
console.log('\n=== 对照：write 档应该直接写成功 ===');
const autoAdapter = createAdapter({ backend: 'claude', tier: 'write' });
const autoTarget = join(cwd, 'auto-approved.txt');
await adapter.run({ prompt: 'say ok', cwd, sessionId: null, timeoutMs: 30_000, onEvent: () => {} }).catch(() => {});
const r2 = await autoAdapter.run({
  prompt: `创建文件 ${autoTarget}，内容写 hello。`,
  cwd, sessionId: null, timeoutMs: 120_000, onEvent: () => {},
});
const wrote2 = await exists(autoTarget);
console.log(`${ok(wrote2)} write 档直接写成功（不需要批准）`);

if (wrote2) console.log('   内容:', JSON.stringify((await readFile(autoTarget, 'utf8')).trim()));

console.log('\n=== 结论 ===');
if (!wrote && r.reason === 'completed' && wrote2) {
  console.log('✅ write-ask 真的会拦、真的不挂死；write 档真的不拦。两者行为确实不同。');
} else {
  console.log('❌ 行为不符合预期，需要进一步查。');
}
