/**
 * M4 端到端验证：agent 真改代码 → worktree 隔离 → 人看 diff → 合并/丢弃。
 *
 * 这不是单测。每一步都**由 app 自己去磁盘核对**，不信 agent 说的。
 *
 *   node scripts/m4-e2e.mjs            # 完整流程
 *   node scripts/m4-e2e.mjs --keep     # 保留数据目录便于查看
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';
import { createAdapter } from '../src/adapters/index.js';
import { diffAgainstBase, listWorktrees } from '../src/core/worktree.js';

const exec = promisify(execFile);
const keep = process.argv.includes('--keep');

const ok = (c) => (c ? '✅' : '❌');
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const git = async (cwd, args) => (await exec('git', args, { cwd })).stdout.trim();

const base = await mkdtemp(join(tmpdir(), 'm4-'));
const repo = join(base, 'repo');
const dataDir = join(base, 'data');

// ---------- 准备真实仓库 ----------
await exec('git', ['init', '-q', '-b', 'main', repo]);
await git(repo, ['config', 'user.email', 'm4@test']);
await git(repo, ['config', 'user.name', 'm4']);
await writeFile(join(repo, 'app.js'), [
  '// 简单计数器',
  'let count = 0;',
  'function increment() {',
  '  count += 1;',
  '}',
  'module.exports = { increment, getCount: () => count };',
  '',
].join('\n'));
await git(repo, ['add', '.']);
await git(repo, ['commit', '-qm', 'init']);

console.log(`仓库：${repo}`);
console.log(`数据：${dataDir}\n`);

// ---------- 建房间：一个可写的 agent ----------
const store = new Store(join(dataDir, 'room.jsonl'));
await store.load();

const agents = [
  {
    id: 'dev', name: 'dev', role: 'leader', backend: 'claude', tier: 'write',
    cwd: join(dataDir, 'agents', 'dev'),
    persona: '你是开发者。只做被要求的最小改动，改完一句话说明改了什么。不要执行 shell 命令。',
  },
];
await exec('mkdir', ['-p', agents[0].cwd]);

const events = [];
const room = new Room({
  id: 'r1', name: 'M4 验证', goal: '证明 agent 能在 worktree 里真改代码',
  members: agents, store,
  registry: [{ path: repo }],
  worktreesRoot: join(dataDir, 'worktrees'),
  resolveAdapter: (a) => createAdapter({ ...a }),
  onEvent: (e) => {
    events.push(e);
    if (e.type === 'turn.start') console.log(`\n─── ${e.agentId} 开始 ───`);
    if (e.type === 'text' && e.text) process.stdout.write(e.text);
    if (e.type === 'failure') console.log(`\n❌ 失败：${e.reason} ${e.detail ?? ''}`);
    if (e.type === 'action.results') {
      for (const r of e.results) {
        console.log(`\n${r.ok ? '✓' : '✗'} ${r.label}${r.detail ? `：${r.detail}` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
      }
    }
    if (e.type === 'worktree.created') console.log(`\n[worktree] ${e.worktree} (${e.branch})`);
    if (e.type === 'message') console.log(`\n   （${(e.durationMs / 1000).toFixed(1)}s）`);
  },
});

// ---------- 第 1 步：建任务（带仓库） ----------
console.log('\n=== 第 1 步：头头建任务并指定仓库 ===');
await room.humanSay('@dev 建一个任务：给 app.js 的 increment 加上参数 n，让它能一次加 n，默认 1。仓库用 ' + repo);
await room.drain();

const task = [...store.tasks.values()][0];
console.log(`${ok(Boolean(task))} 任务已建：${task?.id ?? '(无)'}`);
console.log(`${ok(Boolean(task?.worktree))} worktree 已建：${task?.worktree ?? '(无)'}`);
if (task?.worktree) {
  console.log(`${ok(!task.worktree.startsWith(repo))} worktree 不在主仓库目录内`);
  console.log(`${ok(await exists(task.worktree))} worktree 目录存在`);
}

// ---------- 第 2 步：让 agent 真改文件 ----------
console.log('\n=== 第 2 步：让 agent 改 app.js ===');
if (task) {
  await room.humanSay(`@dev 现在改 app.js：increment 接受参数 n（默认 1），count += n。只改这一个文件。`, {
    taskId: task.id,
  });
  await room.drain();
}

// ★ 不信 agent 说改好了，自己读磁盘
const wtFile = task?.worktree ? join(task.worktree, 'app.js') : null;
let content = '';
if (wtFile && await exists(wtFile)) content = await readFile(wtFile, 'utf8');
const changed = content.includes('n ') || content.includes('n)') || content.includes('+= n') || content.includes('n =');
console.log(`\n${ok(changed)} 磁盘上的 app.js 真的变了`);
console.log('--- worktree/app.js ---');
console.log(content || '(文件不存在)');

// 主仓库不该被改
const mainContent = await readFile(join(repo, 'app.js'), 'utf8');
const mainUnchanged = !mainContent.includes('+= n');
console.log(`${ok(mainUnchanged)} 主仓库的 app.js 未被直接修改（worktree 隔离生效）`);

// ---------- 第 3 步：diff ----------
console.log('\n=== 第 3 步：看 diff ===');
if (task?.worktree) {
  const d = await diffAgainstBase(task.worktree, task.baseBranch ?? 'main');
  console.log(`${ok(d.files.length > 0)} diff 有 ${d.files.length} 个文件改动`);
  for (const f of d.files) console.log(`      ${f}`);
  if (d.patch) console.log(d.patch.split('\n').slice(0, 12).join('\n'));
}

// ---------- 第 4 步：验收（提交 + 合并） ----------
console.log('\n=== 第 4 步：人验收 → app 提交 → 合并回主仓库 ===');
if (task?.worktree) {
  const { commitWorktree, mergeTaskBranch } = await import('../src/core/worktree.js');

  const c = await commitWorktree({
    worktree: task.worktree,
    message: `${task.id}: ${task.title}`,
    taskId: task.id,
  });
  console.log(`${ok(c.ok && c.committed)} 改动已提交到任务分支 ${c.commit ?? ''}`);
  if (!c.ok) console.log(`      原因：${c.reason}`);

  const m = await mergeTaskBranch({
    repoPath: repo, branch: `task/${task.id}`, baseBranch: task.baseBranch ?? 'main',
  });
  console.log(`${ok(m.ok)} 合并进 ${task.baseBranch ?? 'main'} ${m.commit ?? ''}`);
  if (!m.ok) console.log(`      原因：${m.reason}`);

  const merged = await readFile(join(repo, 'app.js'), 'utf8');
  console.log(`${ok(merged.includes('+= n'))} 主仓库 app.js 已包含 agent 的改动`);
  const latest = await git(repo, ['log', '--oneline', '-1']);
  console.log(`      最新 commit: ${latest}`);
}

// ---------- 第 5 步：丢弃 ----------
console.log('\n=== 第 5 步：另开任务乱改，然后丢弃 ===');
const before = await git(repo, ['status', '--porcelain']);
await room.humanSay('@dev 再建一个任务，仓库用 ' + repo + '，随便改点什么');
await room.drain();
const t2 = [...store.tasks.values()].find((t) => t.id !== task?.id);
if (t2) {
  await room.humanSay('@dev 在这个任务里把 app.js 改成 hello world，任意方式。', { taskId: t2.id });
  await room.drain();

  // 丢弃：删 worktree 和分支，主仓库不该有任何变化
  const { finalizeTaskWorktree } = await import('../src/core/worktree.js');
  const r = await finalizeTaskWorktree({
    repoPath: repo, worktree: t2.worktree, branch: `task/${t2.id}`, keepWorktree: false,
  });
  console.log(`${ok(r.ok)} 丢弃完成：${JSON.stringify(r)}`);
  const after = await git(repo, ['status', '--porcelain']);
  console.log(`${ok(before === after)} 主仓库 git status 与丢弃前一致`);
  const mainNow = await readFile(join(repo, 'app.js'), 'utf8');
  console.log(`${ok(!mainNow.includes('hello world'))} 主仓库没有被乱改的内容污染`);
}

// ---------- 结果 ----------
console.log('\n=== 汇总 ===');
const failures = events.filter((e) => e.type === 'failure');
console.log(`失败事件：${failures.length}`);
console.log(`数据目录：${base}`);
if (!keep) {
  // 保留以便排查时用 --keep
  console.log('（数据目录保留，用 rm -rf 清理）');
}
