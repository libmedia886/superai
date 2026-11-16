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

/**
 * 这个测试依赖 git 仓库（用 `git archive HEAD` 导出基线）。
 * **npm 包解包后没有 .git** —— 那不是"产品坏了"，是环境不适用。
 * 报失败会让人误以为交付物有问题，所以显式跳过并说清原因。
 */
const hasGit = async () => {
  try {
    await exec('git', ['-C', REPO, 'rev-parse', '--git-dir'], { timeout: 10_000 });
    return true;
  } catch { return false; }
};
const SKIP = (await hasGit()) ? false : '无 .git（解包产物里跳过：本测试测的是仓库内的核对脚本）';

const runScript = async (target) => {
  try {
    const r = await exec('bash', [SCRIPT, target], { timeout: 60_000 });
    return { code: 0, stdout: r.stdout };
  } catch (err) {
    return { code: err.code ?? -1, stdout: err.stdout ?? '' };
  }
};

test('★ 部署目录内容不同 → 必须报"内容不同"（不能漏报）', { skip: SKIP }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vd-'));
  // 用 git archive 铺一份，然后改掉一个文件
  await exec('bash', ['-c', `git -C ${REPO} archive HEAD | tar -x -C ${dir}`], { timeout: 60_000 });
  await writeFile(join(dir, 'bin/netget'), '# tampered\n');

  const r = await runScript(dir);
  assert.equal(r.code, 1, '有内容差异时必须非 0 退出');
  assert.match(r.stdout, /内容不同/, '要明确指出是"内容不同"（不是只看文件在不在）');
  assert.match(r.stdout, /bin\/netget/, '要点名哪个文件');
});

test('★ 部署目录少文件 → 报"缺少"', { skip: SKIP }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vd2-'));
  await exec('bash', ['-c', `git -C ${REPO} archive HEAD | tar -x -C ${dir}`], { timeout: 60_000 });
  const { rm } = await import('node:fs/promises');
  await rm(join(dir, 'bin/netget'));

  const r = await runScript(dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /缺少/, '要说清"线上没有这个文件"');
  assert.match(r.stdout, /bin\/netget/);
});

test('★ 完全一致 → 退出 0', { skip: SKIP }, async () => {
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

test('清单：部署流程文档存在，且写明「核对是硬门槛」', async () => {
  const doc = await readFile(new URL('../docs/DEPLOY.md', import.meta.url), 'utf8');
  assert.match(doc, /verify-deploy\.sh/, '必须点名核对脚本');
  // 管理方 07:54 纠正：exit=1 不是判决，要"先看差的是什么"
  assert.match(doc, /exit=1 不等于必须重启/, '必须说明 exit=1 不等于必须重启');
  assert.match(doc, /先看差的是什么/, '必须说明要先看差异文件类型');
  assert.match(doc, /运行时/, '必须区分运行时文件与文档/工具');
  assert.match(doc, /部署前/, '要有部署前核对');
  assert.match(doc, /部署后/, '要有部署后核对（核对进程 cwd）');
  assert.match(doc, /PIPESTATUS|管道会吃掉退出码/, '要提醒管道会吃掉退出码（管理方踩过）');
  assert.match(doc, /pkill node/, '要提醒不要 pkill node');
});

test('清单：文档必须解释 skipped（否则读者以为被绕过）', async () => {
  const doc = await readFile(new URL('../docs/DEPLOY.md', import.meta.url), 'utf8');
  assert.match(doc, /skipped/, '要点名这个现象');
  assert.match(doc, /fail 0/, '要给出判据（fail 0 + 原因合理），而不是让人记数字');
  assert.match(doc, /不是被绕过|不是.*掩盖/, '要说明它不是绕过');
  assert.match(doc, /没有 \.git|无 \.git|解包产物没有/, '要说清为什么跳过');
  assert.match(doc, /仓库内跑|仓库里单独/, '要给出补跑的方法');
});

test('★ 差异只在文档/测试时，要点明"运行时一致、是否重启由人判断"', { skip: SKIP }, async () => {
  /**
   * 管理方 2026-11-17 07:54 的判断：线上 v37 只差 docs/ 和 test/，
   * 他**没有重启**——因为当天已因重启打断过一次正在跑的轮次。
   * **核对脚本的正确用法不是"不一致就重启"，而是"先看差的是什么"。**
   *
   * 所以脚本必须替人把判据摆清楚，但**不替人决定**。
   */
  const dir = await mkdtemp(join(tmpdir(), 'vd4-'));
  await exec('bash', ['-c', `git -C ${REPO} archive HEAD | tar -x -C ${dir}`], { timeout: 60_000 });
  await writeFile(join(dir, 'docs/DEPLOY.md'), '# 改过的文档\n');

  const r = await runScript(dir);
  assert.equal(r.code, 1, '仍要报不一致（不能因为"只差文档"就悄悄放过）');
  assert.match(r.stdout, /只在文档\/测试\/工具|只在文档/, '要指出差异只有非运行时文件');
  assert.match(r.stdout, /运行时文件全一致/, '要明确说运行时没变');
  assert.match(r.stdout, /由人判断|是否重启由人/, '**不能替人决定是否重启**');
});

test('★ 差异涉及 src/ 时必须警告"应当重新部署"', { skip: SKIP }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vd5-'));
  await exec('bash', ['-c', `git -C ${REPO} archive HEAD | tar -x -C ${dir}`], { timeout: 60_000 });
  await writeFile(join(dir, 'src/core/room.js'), '// tampered\n');

  const r = await runScript(dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /涉及运行时文件|应当重新部署/, '运行时文件变了就得重新部署');
  assert.doesNotMatch(r.stdout, /可以继续运行当前版本/, '不能说"可以继续"——行为可能已经不同');
});
