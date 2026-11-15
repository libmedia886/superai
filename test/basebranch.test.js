/**
 * 基线分支自动探测。
 *
 * 起因：默认写死 `main`，而**老仓库的默认分支几乎都是 master**。
 * 意味着老板随便找个老项目用，第一个任务就会失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectDefaultBranch, createTaskWorktree } from '../src/core/worktree.js';
import { validateAction } from '../src/core/actions.js';

const exec = promisify(execFile);
const git = (cwd, args) => new Promise((res) => {
  execFile('git', args, { cwd }, (e, o) => res({ ok: !e, out: String(o).trim() }));
});

async function makeRepo(branchName) {
  const base = await mkdtemp(join(tmpdir(), 'bb-'));
  const repo = join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q', '-b', branchName]);
  await git(repo, ['config', 'user.email', 't@t']);
  await git(repo, ['config', 'user.name', 't']);
  await writeFile(join(repo, 'a.txt'), 'x\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'init']);
  return { base, repo };
}

test('★ 老仓库（master）能自动探测出默认分支', async () => {
  const { repo } = await makeRepo('master');
  assert.equal(await detectDefaultBranch(repo), 'master');
});

test('新仓库（main）也能探测', async () => {
  const { repo } = await makeRepo('main');
  assert.equal(await detectDefaultBranch(repo), 'main');
});

test('非标准分支名（trunk）也能探测', async () => {
  const { repo } = await makeRepo('trunk');
  assert.equal(await detectDefaultBranch(repo), 'trunk');
});

test('★ 不传 baseBranch 时用探测到的分支，不硬编码 main', async () => {
  const { base, repo } = await makeRepo('master');
  const r = await createTaskWorktree({
    repoPath: repo, taskId: 'T-001',
    worktreesRoot: join(base, 'wt'), registry: [{ path: repo }],
  });
  assert.equal(r.ok, true, 'master 仓库不该因为默认 main 而失败');
  assert.equal(r.baseBranch, 'master');
});

test('显式传错分支时，错误信息要说清"默认分支是什么"', async () => {
  const { base, repo } = await makeRepo('master');
  const r = await createTaskWorktree({
    repoPath: repo, baseBranch: 'main', taskId: 'T-002',
    worktreesRoot: join(base, 'wt'), registry: [{ path: repo }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.step, '基线分支', '要带步骤名，否则模型会张冠李戴');
  assert.match(r.reason, /默认分支看起来是「master」/, '要直接告诉它正确值，而不是只说"不存在"');
  assert.match(r.reason, /base_branch/);
});

test('★ 每个失败都带步骤名（回注时能说清卡在哪一步）', async () => {
  const { base, repo } = await makeRepo('main');

  const notRegistered = await createTaskWorktree({
    repoPath: repo, taskId: 'T-1', worktreesRoot: join(base, 'wt'), registry: [],
  });
  assert.equal(notRegistered.step, '仓库登记');

  const plain = join(base, 'not-git');
  await mkdir(plain, { recursive: true });
  const notGit = await createTaskWorktree({
    repoPath: plain, taskId: 'T-2', worktreesRoot: join(base, 'wt'), registry: [{ path: plain }],
  });
  assert.equal(notGit.step, 'git 仓库检查');
});

test('空仓库（还没提交）给可读提示', async () => {
  const base = await mkdtemp(join(tmpdir(), 'bb2-'));
  const repo = join(base, 'empty');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q', '-b', 'main']);
  const r = await createTaskWorktree({
    repoPath: repo, taskId: 'T-1', worktreesRoot: join(base, 'wt'), registry: [{ path: repo }],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /提交/, '要提示先做一次提交');
});

test('branch 作为 base_branch 的别名（模型直觉写法）', () => {
  assert.equal(validateAction({
    action: 'task.create', title: 'x', branch: 'develop',
  }), null, 'branch 应该被接受');
  assert.equal(validateAction({
    action: 'task.create', title: 'x', base_branch: 'develop',
  }), null);
  assert.match(validateAction({
    action: 'task.create', title: 'x', branch: { bad: 1 },
  }), /必须是分支名/);
});
