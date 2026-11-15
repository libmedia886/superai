/**
 * 仓库登记与 worktree 生命周期（P0 #22 / #23，§6.12）。
 *
 * 安全支点：**app 自己跑 git，agent 永远拿不到 git 命令权限。**
 * 头头只能在人登记的仓库列表里挑；越界的 repo 直接拒并回注原因。
 *
 * worktree 规则：
 *  - 路径 `<数据目录>/worktrees/<任务id>`，只用任务 id（标题会变、含特殊字符）
 *  - 验收后保留（人定的），但 **转 detached HEAD** 再删分支，否则分支删不掉
 *  - 启动时对已登记仓库 prune 僵尸 worktree 记录
 */

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, normalize, sep, join } from 'node:path';

function git(cwd, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim(),
      });
    });
  });
}

/** 路径归一化，用于白名单比较（防 ../ 逃逸与符号差异） */
export function normalizePath(p) {
  return normalize(isAbsolute(p) ? p : '/').replace(new RegExp(`${sep}+$`), '');
}

/**
 * 校验头头声明的仓库是否落在人登记的范围内。
 * 必须用「包含」而非「相等」：登记 /code/proj 时，/code/proj/src 也应算在内。
 */
export function isRepoAllowed(declaredPath, registry) {
  const target = normalizePath(declaredPath);
  if (!target || target === '/') return false;
  if (!isAbsolute(declaredPath)) return false;
  return registry.some((entry) => {
    const root = normalizePath(entry.path);
    return target === root || target.startsWith(root + sep);
  });
}

/**
 * 创建任务 worktree 的三步校验 + 创建。
 * 任何一步失败都返回原因（调用方负责回注给 agent，不得静默）。
 */
export async function createTaskWorktree({ repoPath, baseBranch, taskId, worktreesRoot, registry }) {
  // ① 在不在登记列表
  if (!isRepoAllowed(repoPath, registry)) {
    return {
      ok: false,
      reason: `仓库 ${repoPath} 不在登记列表内。可选：${registry.map((r) => r.path).join('、') || '（空，请先由人添加）'}`,
    };
  }

  // ② 是不是 git 仓库
  const isRepo = await git(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!isRepo.ok || isRepo.stdout !== 'true') {
    return { ok: false, reason: `${repoPath} 不是 git 仓库，需先 git init 并做一次初始提交（此步须由人确认）` };
  }

  // ③ 基线分支是否存在
  const baseCheck = await git(repoPath, ['rev-parse', '--verify', `refs/heads/${baseBranch}`]);
  if (!baseCheck.ok) {
    const branches = await git(repoPath, ['branch', '--format=%(refname:short)']);
    return {
      ok: false,
      reason: `基线分支 ${baseBranch} 不存在。现有分支：${branches.stdout || '（无）'}`,
    };
  }

  // 路径只用任务 id
  await mkdir(worktreesRoot, { recursive: true });
  const wtPath = join(worktreesRoot, taskId);
  const branch = `task/${taskId}`;

  const add = await git(repoPath, ['worktree', 'add', wtPath, '-b', branch, baseBranch]);
  if (!add.ok) {
    return { ok: false, reason: `git worktree add 失败：${add.stderr || add.stdout}` };
  }

  return { ok: true, worktree: wtPath, branch, baseBranch, repo: repoPath };
}

/**
 * 验收后收尾：worktree 转 detached → 删分支 → worktree 保留。
 * 不做这一步，"一直保留 worktree" 会挡住分支删除（实测报 cannot delete branch used by worktree）。
 */
export async function finalizeTaskWorktree({ repoPath, worktree, branch, keepWorktree = true }) {
  const detach = await git(worktree, ['checkout', '--detach']);
  if (!detach.ok) {
    return { ok: false, reason: `worktree 转 detached 失败：${detach.stderr || detach.stdout}` };
  }

  const del = await git(repoPath, ['branch', '-D', branch]);
  const note = del.ok ? null : `分支删除失败：${del.stderr || del.stdout}`;

  if (!keepWorktree) {
    const rm = await git(repoPath, ['worktree', 'remove', '--force', worktree]);
    if (!rm.ok) return { ok: false, reason: `worktree 清理失败：${rm.stderr || rm.stdout}` };
    return { ok: true, branchDeleted: del.ok, worktreeRemoved: true, note };
  }

  return { ok: true, branchDeleted: del.ok, worktreeRemoved: false, note };
}

/**
 * 把 worktree 里的改动提交到任务分支。
 *
 * 为什么必须由 app 做，而不是 agent：agent 没有 git 命令权限（安全核心）。
 * 但如果不提交，`git merge task/X` 就是空操作——**分支上没有新 commit**。
 * 这条是需求里漏掉的：流程写了"人验收 → 合并"，但没人规定谁把改动变成 commit。
 *
 * 由 app 在**验收时**做，而不是每轮做：这样 agent 中途改坏了，人可以先看 diff
 * 再决定要不要留下，不会污染分支历史。
 */
export async function commitWorktree({ worktree, message, taskId = null }) {
  const status = await git(worktree, ['status', '--porcelain']);
  if (!status.ok) return { ok: false, reason: `读取改动失败：${status.stderr}`, committed: false };
  if (!status.stdout.trim()) return { ok: true, committed: false, reason: '没有改动' };

  const add = await git(worktree, ['add', '-A']);
  if (!add.ok) return { ok: false, reason: `git add 失败：${add.stderr}`, committed: false };

  const commit = await git(worktree, [
    '-c', 'user.name=MultiAgent Chat',
    '-c', 'user.email=chat@local',
    'commit', '-q', '-m', message || `task ${taskId ?? ''}: agent 改动`,
  ]);
  if (!commit.ok) return { ok: false, reason: `git commit 失败：${commit.stderr}`, committed: false };

  const head = await git(worktree, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, committed: true, commit: head.stdout, files: status.stdout.split('\n').filter(Boolean) };
}

/**
 * 把任务分支合并回基线分支。合并由**人**触发（不是 agent）。
 * 冲突时不硬来：返回失败原因，让人自己处理。
 */
export async function mergeTaskBranch({ repoPath, branch, baseBranch }) {
  const checkout = await git(repoPath, ['checkout', baseBranch]);
  if (!checkout.ok) return { ok: false, reason: `切换分支失败：${checkout.stderr}` };

  const merge = await git(repoPath, ['merge', '--no-edit', branch]);
  if (!merge.ok) {
    // 冲突：把状态如实报出去，别留下半合并的烂摊子
    await git(repoPath, ['merge', '--abort']);
    return { ok: false, reason: `合并冲突（已回滚）：${merge.stderr || merge.stdout}` };
  }

  const head = await git(repoPath, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, commit: head.stdout, output: merge.stdout };
}

/** 启动时清理僵尸记录（用户清过应用数据后仓库里会留下指向不存在目录的记录） */
export async function pruneWorktrees(repoPath) {
  return git(repoPath, ['worktree', 'prune']);
}

/** 列出现存 worktree，供清理入口显示 */
export async function listWorktrees(repoPath) {
  const r = await git(repoPath, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), branch: null, detached: false };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'detached' && cur) {
      cur.detached = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 相对主仓库的改动，供人验收时看 diff（P0 #24） */
export async function diffAgainstBase(worktree, baseBranch) {
  const files = await git(worktree, ['diff', '--name-status', baseBranch]);
  const patch = await git(worktree, ['diff', baseBranch]);
  return {
    files: files.ok ? files.stdout.split('\n').filter(Boolean) : [],
    patch: patch.ok ? patch.stdout : '',
  };
}
