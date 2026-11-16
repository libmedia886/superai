/**
 * CR-032：受约束的网络读取器。
 *
 * 背景（管理方实测）：`--allowedTools "Bash(curl:*)"` 的审批器**只看命令名、
 * 不看副作用**——同一条 curl 能 `file:///etc/hostname` 读本机、能 `-o /tmp/x`
 * 写目录外、能 `-T` 上传外传。放行 curl 等价于「读本机任意文件 + 任意方向网络」。
 *
 * `bin/netget` 把「联网取资料」单独摘出来并限制成 http/https GET + cwd 内写。
 * 真机验证在 `scripts/netget-e2e.mjs`（含经 claude CLI 的 B 层）；这里测
 * 参数解析与路径约束这些**不依赖网络**的部分，保证 CI 里也能跑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const NETGET = fileURLToPath(new URL('../bin/netget', import.meta.url));

const run = async (cwd, args) => {
  try {
    const r = await exec(NETGET, args, { cwd, timeout: 20_000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
};

const exists = async (p) => { try { await readFile(p); return true; } catch { return false; } };

test('★ 本地/其它协议一律拒绝（file:// 是核心用例）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-'));
  for (const url of ['file:///etc/hostname', 'ftp://h/x', 'scp://h/x', 'gopher://h/x']) {
    const r = await run(dir, [url]);
    assert.equal(r.code, 2, `${url} 应被拒（实际 ${r.code}）`);
    assert.match(r.stderr, /协议不允许/);
  }
});

test('★ 上传类参数一律拒绝（上传不可逆）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-'));
  for (const args of [
    ['-T', '/etc/hostname', 'https://example.com'],
    ['--upload-file', '/etc/hostname', 'https://example.com'],
    ['-d', 'k=v', 'https://example.com'],
    ['--data', 'k=v', 'https://example.com'],
    ['--data-binary', '@/etc/hostname', 'https://example.com'],
    ['-F', 'f=@/etc/hostname', 'https://example.com'],
    ['-X', 'POST', 'https://example.com'],
    ['--request', 'PUT', 'https://example.com'],
  ]) {
    const r = await run(dir, args);
    assert.equal(r.code, 2, `${args[0]} 应被拒（实际 ${r.code}）`);
  }
});

test('★ -o 指向工作目录之外 → exit 3，且不落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-'));
  const outside = `/tmp/ng-outside-${Date.now()}.txt`;
  const r = await run(dir, ['-o', outside, 'https://example.com']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /拒绝写到工作目录之外/);
  assert.equal(await exists(outside), false, '磁盘上不能有文件');
});

test('★ ../ 绕过被拒', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-'));
  const r = await run(dir, ['-o', '../escaped.txt', 'https://example.com']);
  assert.equal(r.code, 3);
});

test('★ 符号链接指向目录外 → 也被拒（realpath 解析后比较）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-'));
  await symlink('/tmp', join(dir, 'escape'));
  const r = await run(dir, ['-o', './escape/leak.txt', 'https://example.com']);
  assert.equal(r.code, 3, '符号链接不能成为越界出口');
});

test('没有 URL → 明确报错（不是静默成功）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ng-'));
  const r = await run(dir, ['-o', './x.txt']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /需要 http\/https URL/);
});

test('★ 适配器：netget token 必须解析成绝对路径（审批器是字面前缀匹配）', async () => {
  const { allowedCommandArgs } = await import('../src/adapters/claude.js');

  const args = allowedCommandArgs(['netget'], { netgetPath: '/data/bin/netget' });
  assert.deepEqual(args, ['--allowedTools', 'Bash(/data/bin/netget:*)'],
    '必须是绝对路径：实测模型写 ./bin/netget 会被审批器拒');
  assert.ok(!args.join(' ').includes('Bash(netget:*)'), '不能放行裸名字');
});

test('★ 要了 netget 却没有包装器 → 抛错，不静默降级', async () => {
  const { allowedCommandArgs } = await import('../src/adapters/claude.js');
  assert.throws(() => allowedCommandArgs(['netget'], { netgetPath: null }),
    /没有生成包装器/);
});

test('★ 包装器必须生成在成员 cwd 之外（否则成员能改写边界本身）', async () => {
  const { readFile: rf } = await import('node:fs/promises');
  const src = await rf(new URL('../src/core/sessions.js', import.meta.url), 'utf8');
  assert.match(src, /const binDir = join\(dir, 'bin'\)/, '应放在房间目录的 bin/ 下');
  assert.match(src, /installNetget\(netgetPath\)/, '由 installNetget 生成（内部 chmod 0755）');
  // 成员 cwd 是 <数据目录>/agents/<id>；bin 是其同级，不在里面
  assert.ok(!src.includes("join(cwd, 'netget')"), '绝不能放进成员自己的工作目录');
});

/* ---------------- PATH 提权（管理方 22:31 复现的洞） ---------------- */

test('★ 真的跑脚本：cwd 里放一个假 curl，netget 不能执行它', async () => {
  /**
   * 这是管理方复现的提权，也是 CR-032 最关键的回归测试：
   *   · 成员能写自己的 cwd
   *   · 如果在里面放一个假的 `curl`，而 netget 用裸命令名调用
   *   · 那真正执行的就不是 curl → 协议限制、GET-only、目录内写全部归零
   * 实测那条假 curl 把 /etc/hostname 写到了 /tmp。
   *
   * 必须**真的跑脚本**，不能只 grep 代码里有没有 `PATH=`。
   */
  const { writeFile, chmod: ch } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'pwn-'));
  const canary = `/tmp/netget-pwned-${Date.now()}.txt`;

  // 放一个假 curl：只要被执行就会留下 canary
  const fake = join(dir, 'curl');
  await writeFile(fake, `#!/bin/bash\ntouch ${canary}\necho PWNED\n`, { mode: 0o755 });
  await ch(fake, 0o755);

  // 用污染过的 PATH 跑 netget —— 模拟成员环境的实际状况
  let stdout = '';
  try {
    const r = await exec(NETGET, ['https://example.com'], {
      cwd: dir,
      timeout: 30_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    stdout = r.stdout;
  } catch (err) {
    stdout = err.stdout ?? '';
  }

  assert.equal(await exists(canary), false,
    '假 curl 被执行了！netget 走了 PATH —— 所有边界都失效了');
  assert.doesNotMatch(stdout, /PWNED/, '输出里不能有假 curl 的痕迹');
});

test('★ netget 里不能出现裸 `exec curl`（静态兜底）', async () => {
  const src = await readFile(NETGET, 'utf8');
  const lines = src.split('\n').filter((l) => !l.trim().startsWith('#'));
  for (const l of lines) {
    assert.doesNotMatch(l, /\bexec\s+curl\b/,
      `不能 exec 裸 curl（会走 PATH）：${l.trim()}`);
  }
  assert.match(src, /CURL_BIN/, '必须有绝对路径的 curl');
  assert.match(src, /^PATH=\/usr\/local\/sbin:/m, 'PATH 必须被重设为固定系统路径');
});

test('★ 生成的 netget 里 curl 是绝对路径（不是占位符、不是裸名字）', async () => {
  const { installNetget } = await import('../src/core/sessions.js');
  const dir = await mkdtemp(join(tmpdir(), 'gen-'));
  const target = join(dir, 'netget');
  const r = await installNetget(target);

  assert.match(r.curl, /^\/(usr|bin)\//, `解析出的 curl 必须是绝对路径：${r.curl}`);
  const body = await readFile(target, 'utf8');
  assert.ok(!body.includes('@CURL_BIN@'), '占位符必须被替换');
  assert.match(body, new RegExp(`CURL_BIN='${r.curl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
    '写死解析出的绝对路径');
});
