/**
 * 部署核对脚本的自我测试。
 *
 * 起因（管理方 03:55）：他核对 v33 与 HEAD 时只 `diff` 了 `src` 和 `public`，
 * 漏了 `bin/` —— 而修复恰好在 `bin/netget`。于是得出"一致"的错误结论。
 *
 * 我写了 `scripts/verify-deploy.sh`（用 `git archive HEAD` 导出全集逐文件比），
 * **第一版自己也有 bug**：中文 locale 下 diff 输出是「文件 X 和 Y 不同」，
 * 而分类匹配的是英文 `Files ... differ` → **所有内容差异被静默漏掉**，
 * 脚本错误地报了"完全一致"。
 *
 * 所以这个文件测两件事：
 *   1. 脚本能正确识别"内容不同"（不能漏报）
 *   2. 分类逻辑失效时脚本会报"无法判定"，而不是误报一致（自检）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/verify-deploy.sh', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

const runScript = async (target) => {
  try {
    const r = await exec('bash', [SCRIPT, target], { timeout: 60_000 });
    return { code: 0, stdout: r.stdout };
  } catch (err) {
    return { code: err.code ?? -1, stdout: err.stdout ?? '' };
  }
};

test('★ 部署目录内容不同 → 必须报"内容不同"（不能漏报）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vd-'));
  // 用 git archive 铺一份，然后改掉一个文件
  await exec('bash', ['-c', `git -C ${REPO} archive HEAD | tar -x -C ${dir}`], { timeout: 60_000 });
  await writeFile(join(dir, 'bin/netget'), '# tampered\n');

  const r = await runScript(dir);
  assert.equal(r.code, 1, '有内容差异时必须非 0 退出');
  assert.match(r.stdout, /内容不同/, '要明确指出是"内容不同"（不是只看文件在不在）');
  assert.match(r.stdout, /bin\/netget/, '要点名哪个文件');
});

test('★ 部署目录少文件 → 报"缺少"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vd2-'));
  await exec('bash', ['-c', `git -C ${REPO} archive HEAD | tar -x -C ${dir}`], { timeout: 60_000 });
  const { rm } = await import('node:fs/promises');
  await rm(join(dir, 'bin/netget'));

  const r = await runScript(dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /缺少/, '要说清"线上没有这个文件"');
  assert.match(r.stdout, /bin\/netget/);
});

test('★ 完全一致 → 退出 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vd3-'));
  await exec('bash', ['-c', `git -C ${REPO} archive HEAD | tar -x -C ${dir}`], { timeout: 60_000 });
  const r = await runScript(dir);
  assert.equal(r.code, 0, `应当一致：${r.stdout.slice(0, 300)}`);
  assert.match(r.stdout, /完全一致/);
});

test('★ 脚本必须锁住 locale（否则中文环境下所有差异被静默漏掉）', async () => {
  const src = await readFile(SCRIPT, 'utf8');
  assert.match(src, /LC_ALL=C diff/, 'diff 必须强制 C locale，否则分类匹配失效');
  assert.match(src, /核对脚本自身失效/, '必须有"分类失效时报无法判定"的自检');
  assert.doesNotMatch(src, /--exclude=src|--exclude=public/,
    '不能列举目录——那正是漏掉 bin/ 的原因');
});
