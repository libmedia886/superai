/**
 * 「验证退出码时不能接管道」——今天最反复的一类错误。
 *
 * 管理方 2026-11-17 10:19 **第二次**踩同一个坑：
 *   `bash verify-deploy.sh … | tail -3; echo $?` → 拿到的是 tail 的 0，
 *   差点判定"拒绝逻辑失效"。
 *
 * 这和今天的「旁路测试」「列举会漏」「注释比代码自信」是同源：
 * **测量方式本身没被验证，结论就不可信。**
 *
 * 所以加一个静态检查器，扫仓库里的脚本代码。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));

/** 在 npm 包里没有 node_modules/npm 环境，跳过依赖 npm 的那条 */
const SKIP_NO_GIT = false;
const CHECKER = fileURLToPath(new URL('../scripts/check-exitcode-usage.sh', import.meta.url));

const runChecker = async () => {
  try {
    const r = await exec('bash', [CHECKER], { timeout: 30_000, cwd: REPO });
    return { code: 0, stdout: r.stdout };
  } catch (err) {
    return { code: err.code ?? -1, stdout: err.stdout ?? '' };
  }
};

test('★ 当前仓库没有「管道 + $?」的写法', async () => {
  const r = await runChecker();
  assert.equal(r.code, 0, `发现违规：\n${r.stdout}`);
});

test('★ 检查器必须能抓到真实的违规（反证）', async () => {
  /**
   * 一个抓不到东西的检查器等于没有。这里塞一个真实的反例进去：
   * 管道和 `$?` **不在同一行**（实战写法就是这样），
   * 只看同一行的实现会漏掉它 —— 我第一版就是这么写的。
   */
  const bad = join(REPO, 'scripts', '_bad_exitcode_probe.sh');
  await writeFile(bad, [
    '#!/bin/bash',
    'bash scripts/verify-deploy.sh /tmp | tail -3',
    'echo "exit=$?"',
  ].join('\n') + '\n');

  try {
    const r = await runChecker();
    assert.equal(r.code, 1, '必须报错');
    assert.match(r.stdout, /_bad_exitcode_probe\.sh/, '要点名文件');
    assert.match(r.stdout, /line 3/, '要指出是读了 $? 的那一行');
  } finally {
    await rm(bad, { force: true });
  }
});

test('★ 检查器不得误报正常的管道用法', async () => {
  const ok = join(REPO, 'scripts', '_ok_pipe_probe.sh');
  await writeFile(ok, [
    '#!/bin/bash',
    '# 注释里提到 $? 和管道不算违规',
    'ls | head -3',
    'echo done',
    'code=${PIPESTATUS[0]}',
  ].join('\n') + '\n');
  try {
    const r = await runChecker();
    assert.equal(r.code, 0, `误报了正常用法：\n${r.stdout}`);
  } finally {
    await rm(ok, { force: true });
  }
});

test('检查器只扫可执行代码，不扫文档（文档里的反例是教学）', async () => {
  const src = await readFile(CHECKER, 'utf8');
  assert.match(src, /for f in scripts\/\*\.sh scripts\/\*\.mjs/,
    '只扫脚本，不扫 docs —— 否则会把文档里的正确示范当成错误');
  assert.doesNotMatch(src, /for f in docs\//);
});

test('★ 检查器接进了 pretest（npm test 会先跑它）', async () => {
  /**
   * 管理方 2026-11-17 12:19 的建议：「需要记着跑的检查，最终会被忘掉」。
   * 他在这条上**第三次**踩同一个坑（用 `| tail` 测检查器的退出码）。
   */
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.pretest, 'bash scripts/check-exitcode-usage.sh',
    'pretest 必须跑检查器 —— 否则它就是个"需要记着跑"的检查');
  assert.ok(pkg.scripts['check:exitcode'], '也要保留独立命令（临时单独跑）');
});

test('★ pretest 真的会拦住违规：npm test 必须失败', { skip: SKIP_NO_GIT }, async () => {
  /**
   * 反证：塞一个违规脚本进去，`npm test` 必须非 0 退出。
   * ⚠️ 量退出码时**不能接管道**（`npm test | head` 拿到的是 head 的码）——
   *    我刚差点又犯这个错，正好被这个检查器自己抓到。
   */
  const probe = join(REPO, 'scripts', '_probe_pretest.sh');
  await writeFile(probe, '#!/bin/bash\nls | tail -3\necho "code=$?"\n');
  try {
    // 直接跑 pretest（而不是 npm test）——
    // npm test 会跑全部测试、其中包括本条，形成嵌套；虽然 probe
    // 会让 pretest 立刻失败从而不会死循环，但没必要冒这个险。
    let code = 0;
    try {
      await exec('npm', ['run', 'pretest'], { timeout: 60_000, cwd: REPO });
    } catch (err) {
      code = err.code ?? -1;
    }
    assert.notEqual(code, 0, '有违规时 pretest 必须失败');
  } finally {
    await rm(probe, { force: true });
  }
});
