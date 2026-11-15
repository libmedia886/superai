import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isRepoAllowed, createTaskWorktree, finalizeTaskWorktree, listWorktrees, pruneWorktrees, diffAgainstBase,
} from '../src/core/worktree.js';

test('白名单：登记目录内允许，目录外拒绝', () => {
  const registry = [{ path: '/code/proj-a' }];
  assert.equal(isRepoAllowed('/code/proj-a', registry), true);
  assert.equal(isRepoAllowed('/code/proj-a/src', registry), true);
  assert.equal(isRepoAllowed('/code/proj-ab', registry), false, '前缀相似但不同目录不能放行');
  assert.equal(isRepoAllowed('/code/other', registry), false);
  assert.equal(isRepoAllowed('/home/user/.ssh', registry), false);
});

test('白名单：路径穿越不能逃逸', () => {
  const registry = [{ path: '/code/proj-a' }];
  assert.equal(isRepoAllowed('/code/proj-a/../../.ssh', registry), false);
  assert.equal(isRepoAllowed('/code/proj-a/../proj-b', registry), false);
});

test('白名单：相对路径与非绝对路径一律拒绝', () => {
  const registry = [{ path: '/code/proj-a' }];
  assert.equal(isRepoAllowed('proj-a', registry), false);
  assert.equal(isRepoAllowed('.', registry), false);
});

test('白名单为空时谁也不放行', () => {
  assert.equal(isRepoAllowed('/code/proj-a', []), false);
});

const git = (cwd, args) => new Promise((res) => {
  execFile('git', args, { cwd }, (e, o) => res({ ok: !e, out: String(o).trim() }));
});

async function makeRepo() {
  const base = await mkdtemp(join(tmpdir(), 'wt-'));
  const repo = join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@t']);
  await git(repo, ['config', 'user.name', 't']);
  await writeFile(join(repo, 'a.txt'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'init']);
  return { base, repo };
}

test('未登记仓库被拒，理由里带可选列表', async () => {
  const { base, repo } = await makeRepo();
  const r = await createTaskWorktree({
    repoPath: repo, baseBranch: 'main', taskId: 'T-001',
    worktreesRoot: join(base, 'wt'), registry: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不在登记列表内/);
});

test('不是 git 仓库时明确提示需人确认 git init', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wt-'));
  const plain = join(base, 'plain');
  await mkdir(plain, { recursive: true });
  const r = await createTaskWorktree({
    repoPath: plain, baseBranch: 'main', taskId: 'T-001',
    worktreesRoot: join(base, 'wt'), registry: [{ path: plain }],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不是 git 仓库/);
  assert.match(r.reason, /人确认/);
});

test('基线分支不存在时列出可用分支', async () => {
  const { base, repo } = await makeRepo();
  const r = await createTaskWorktree({
    repoPath: repo, baseBranch: 'develop', taskId: 'T-001',
    worktreesRoot: join(base, 'wt'), registry: [{ path: repo }],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /基线分支 develop 不存在/);
  assert.match(r.reason, /main/);
});

test('正常创建：路径只用任务 id、处于任务分支', async () => {
  const { base, repo } = await makeRepo();
  const r = await createTaskWorktree({
    repoPath: repo, baseBranch: 'main', taskId: 'T-001',
    worktreesRoot: join(base, 'wt'), registry: [{ path: repo }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.worktree, join(base, 'wt', 'T-001'));
  const br = await git(r.worktree, ['branch', '--show-current']);
  assert.equal(br.out, 'task/T-001');
});

test('验收后：转 detached 才能删分支，worktree 保留且文件仍在', async () => {
  const { base, repo } = await makeRepo();
  const c = await createTaskWorktree({
    repoPath: repo, baseBranch: 'main', taskId: 'T-001',
    worktreesRoot: join(base, 'wt'), registry: [{ path: repo }],
  });
  assert.equal(c.ok, true);

  await writeFile(join(c.worktree, 'a.txt'), 'changed\n');

  // 未 detach 时删分支应当失败（这正是我们要避免的僵局）
  const before = await git(repo, ['branch', '-d', 'task/T-001']);
  assert.equal(before.ok, false, '未 detach 时分支删不掉，说明 detach 步骤是必要的');

  const f = await finalizeTaskWorktree({ repoPath: repo, worktree: c.worktree, branch: 'task/T-001' });
  assert.equal(f.ok, true);
  assert.equal(f.branchDeleted, true);
  assert.equal(f.worktreeRemoved, false, '一直保留策略下 worktree 不删');

  // 文件仍在，成果可查
  const content = await readFile(join(c.worktree, 'a.txt'), 'utf8');
  assert.equal(content, 'changed\n');

  // worktree 仍在列表里且是 detached
  const list = await listWorktrees(repo);
  const entry = list.find((w) => w.path.endsWith('T-001'));
  assert.ok(entry);
  assert.equal(entry.detached, true);
});

test('diff 能列出改动供人验收', async () => {
  const { base, repo } = await makeRepo();
  const c = await createTaskWorktree({
    repoPath: repo, baseBranch: 'main', taskId: 'T-002',
    worktreesRoot: join(base, 'wt'), registry: [{ path: repo }],
  });
  await writeFile(join(c.worktree, 'a.txt'), 'modified\n');
  const d = await diffAgainstBase(c.worktree, 'main');
  assert.ok(d.files.some((f) => f.includes('a.txt')));
  assert.match(d.patch, /modified/);
});

test('prune 不会误删活着的 worktree', async () => {
  const { base, repo } = await makeRepo();
  const c = await createTaskWorktree({
    repoPath: repo, baseBranch: 'main', taskId: 'T-003',
    worktreesRoot: join(base, 'wt'), registry: [{ path: repo }],
  });
  await pruneWorktrees(repo);
  const list = await listWorktrees(repo);
  assert.ok(list.some((w) => w.path.endsWith('T-003')));
  assert.equal(c.ok, true);
});
