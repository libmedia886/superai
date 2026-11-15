/**
 * 验收接口端到端：模拟界面点"合并"和"丢弃"。
 *
 *   node scripts/accept-e2e.mjs
 *
 * 用真实的 HTTP 接口 + 真实 git 仓库，不 mock。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, access, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../src/server.js';
import { Store } from '../src/core/store.js';
import { createTaskWorktree } from '../src/core/worktree.js';

const exec = promisify(execFile);
const ok = (c) => (c ? '✅' : '❌');
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const git = async (cwd, args) => (await exec('git', args, { cwd })).stdout.trim();

const post = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const base = await mkdtemp(join(tmpdir(), 'accept-'));
const repo = join(base, 'repo');
const dataDir = join(base, 'data');
await mkdir(repo, { recursive: true });
await mkdir(dataDir, { recursive: true });

await exec('git', ['init', '-q', '-b', 'main', repo]);
await git(repo, ['config', 'user.email', 't@t']);
await git(repo, ['config', 'user.name', 't']);
await writeFile(join(repo, 'app.js'), 'let n = 0;\n');
await git(repo, ['add', '.']);
await git(repo, ['commit', '-qm', 'init']);

const cfg = {
  name: '验收测试',
  goal: '验证合并与丢弃',
  registry: [{ path: repo }],
  members: [{ id: 'dev', name: 'dev', role: 'leader', backend: 'claude', tier: 'write', persona: '简短。' }],
};
await writeFile(join(dataDir, 'room.json'), JSON.stringify(cfg, null, 2));

const { server, url, store } = await startServer({ port: 0, dataDir });
const worktreesRoot = join(dataDir, 'worktrees');

/** 手工造一个"agent 改完但未提交"的任务 */
async function makePendingTask(taskId, newContent) {
  const wt = await createTaskWorktree({
    repoPath: repo, baseBranch: 'main', taskId,
    worktreesRoot, registry: [{ path: repo }],
  });
  if (!wt.ok) throw new Error(wt.reason);
  await writeFile(join(wt.worktree, 'app.js'), newContent);
  await store.createTask({
    id: taskId, title: `任务 ${taskId}`, assignee: 'dev', status: '进行中',
    createdBy: 'human', repo, baseBranch: 'main', worktree: wt.worktree,
  });
  return wt;
}

console.log('=== 1. 合并路径 ===');
const t1 = await makePendingTask('T-001', 'let n = 0;\nfunction inc(k = 1) { n += k; }\n');
console.log(`${ok(await exists(t1.worktree))} worktree 已建`);

const diffRes = await fetch(`${url}/api/diff?task=T-001`);
const diff = await diffRes.json();
console.log(`${ok(diff.files?.length > 0)} diff 接口能列出改动（${diff.files?.length ?? 0} 个文件）`);

const merge = await post(`${url}/api/accept`, { id: 'T-001', action: 'merge' });
console.log(`${ok(merge.status === 200)} 合并接口返回 200 ${JSON.stringify(merge.data)}`);

const merged = await readFile(join(repo, 'app.js'), 'utf8');
console.log(`${ok(merged.includes('function inc(k = 1)'))} 主仓库真的有 agent 的改动`);
console.log(`${ok(await exists(t1.worktree))} 合并后 worktree 保留（可事后追问）`);
const t1State = store.tasks.get('T-001');
console.log(`${ok(t1State.status === '完成')} 任务状态变成「完成」`);

console.log('\n=== 2. 丢弃路径 ===');
const t2 = await makePendingTask('T-002', 'BROKEN CODE SHOULD NOT LAND\n');
const beforeStatus = await git(repo, ['status', '--porcelain']);
const beforeApp = await readFile(join(repo, 'app.js'), 'utf8');

const discard = await post(`${url}/api/accept`, { id: 'T-002', action: 'discard' });
console.log(`${ok(discard.status === 200)} 丢弃接口返回 200 ${JSON.stringify(discard.data)}`);
console.log(`${ok(!(await exists(t2.worktree)))} worktree 已被清理`);

const afterStatus = await git(repo, ['status', '--porcelain']);
const afterApp = await readFile(join(repo, 'app.js'), 'utf8');
console.log(`${ok(beforeStatus === afterStatus)} 主仓库 git status 没变`);
console.log(`${ok(!afterApp.includes('BROKEN CODE'))} 主仓库没有污染`);
console.log(`${ok(store.tasks.get('T-002').status === '阻塞')} 任务状态标为「阻塞」`);

console.log('\n=== 3. 错误路径 ===');
const noTask = await post(`${url}/api/accept`, { id: 'T-999', action: 'merge' });
console.log(`${ok(noTask.status === 404)} 不存在的任务返回 404`);

const badAction = await post(`${url}/api/accept`, { id: 'T-001', action: 'nonsense' });
console.log(`${ok(badAction.status === 400)} 非法 action 返回 400`);

// 没有改动就合并
const t3 = await makePendingTask('T-003', await readFile(join(repo, 'app.js'), 'utf8'));
const noChanges = await post(`${url}/api/accept`, { id: 'T-003', action: 'merge' });
console.log(`${ok(noChanges.status === 400)} 无改动时合并不硬来（${noChanges.data.error}）`);

server.close();
console.log(`\n数据：${base}`);
