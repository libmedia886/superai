/**
 * CR-032 真机验证：netget 是不是真的把边界立住了。
 *
 *   node scripts/netget-e2e.mjs
 *
 * 管理方要求「真机测试必须断言：真实 HTTP 状态码；file:// 被拒；写 /tmp 被拒」。
 * 这个脚本**不看模型自述**，每一步都去磁盘和网络核对事实。
 *
 * 分两层：
 *   A. 包装器本身（纯 bash，秒级）：协议、上传参数、越界写、符号链接绕过
 *   B. 经 claude CLI 真跑（`--allowedTools "Bash(<abs>/netget:*)"`）：
 *      拿到真实状态码、file:// 被拒、越界写被拒
 *
 * `--skip-llm` 只跑 A。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ClaudeAdapter } from '../src/adapters/claude.js';

const exec = promisify(execFile);
const skipLlm = process.argv.includes('--skip-llm');
const NETGET = fileURLToPath(new URL('../bin/netget', import.meta.url));

const ok = (c) => (c ? '✅' : '❌');
let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${ok(cond)} ${label}${!cond && extra ? `（${extra}）` : ''}`);
  if (!cond) failed += 1;
};

const exists = async (p) => { try { await readFile(p); return true; } catch { return false; } };

/** 跑 netget，返回 { code, stderr } —— 不抛错 */
const ng = async (cwd, args) => {
  try {
    const r = await exec(NETGET, args, { cwd, timeout: 60_000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
};

/* ================= A. 包装器本身 ================= */
const work = await mkdtemp(join(tmpdir(), 'netget-work-'));
console.log('=== A. 包装器（不经模型）===\n');

// A1 正常下载
{
  const r = await ng(work, ['-o', './ok.html', 'https://example.com']);
  check(r.code === 0, '正常下载（http 200 → 落盘）', r.stderr.slice(0, 120));
  check(await exists(join(work, 'ok.html')), '磁盘上确实有文件');
}

// A2 file:// 被拒
{
  const r = await ng(work, ['file:///etc/hostname']);
  check(r.code === 2, 'file:// 被拒（exit 2）', `实际 ${r.code}`);
  check(!/hope-System|localhost|^[a-z0-9-]+$/m.test(r.stdout.trim()),
    '没有把 /etc/hostname 的内容吐出来', r.stdout.slice(0, 80));
}

// A3 其他协议
for (const url of ['ftp://example.com/x', 'scp://host/x', 'gopher://host/x']) {
  const r = await ng(work, [url]);
  check(r.code === 2, `${url.split(':')[0]}:// 被拒`, `实际 ${r.code}`);
}

// A4 上传类参数
for (const args of [
  ['-T', '/etc/hostname', 'https://example.com'],
  ['-d', 'k=v', 'https://example.com'],
  ['-F', 'f=@/etc/hostname', 'https://example.com'],
  ['-X', 'POST', 'https://example.com'],
  ['--data-binary', '@/etc/hostname', 'https://example.com'],
]) {
  const r = await ng(work, args);
  check(r.code === 2, `上传参数被拒：${args[0]}`, `实际 ${r.code}`);
}

// A5 越界写
{
  const outside = `/tmp/netget-outside-${Date.now()}.txt`;
  const r = await ng(work, ['-o', outside, 'https://example.com']);
  check(r.code === 3, '写到 /tmp（目录外）被拒（exit 3）', `实际 ${r.code}`);
  check(!(await exists(outside)), '磁盘上确实没有那个文件');
}

// A6 ../ 绕过
{
  const r = await ng(work, ['-o', '../escaped.txt', 'https://example.com']);
  check(r.code === 3, '../ 绕过被拒', `实际 ${r.code}`);
}

// A7 符号链接绕过
{
  await exec('ln', ['-sfn', '/tmp', join(work, 'escape')]);
  const outside = `/tmp/symlink-outside-${Date.now()}.txt`;
  const r = await ng(work, ['-o', `./escape/${outside.split('/').pop()}`, 'https://example.com']);
  check(r.code === 3, '符号链接指向目录外 → 被拒', `实际 ${r.code}`);
  check(!(await exists(outside)), '磁盘上没有那个文件');
}

/* ================= B. 经 claude CLI 真跑 ================= */
if (skipLlm) {
  console.log('\n（--skip-llm：跳过 B 层真机验证）');
} else {
  console.log('\n=== B. 经 claude CLI 真跑（`--allowedTools "Bash(<abs>/netget:*)"`）===\n');

  const agentCwd = await mkdtemp(join(tmpdir(), 'netget-agent-'));
  const adapter = new ClaudeAdapter({
    id: 'probe',
    backend: 'claude',
    tier: 'write-exec',
    persona: '',
    allowedCommands: ['netget'],
    netgetPath: NETGET,
  });

  const ask = async (prompt) => {
    let text = '';
    const r = await adapter.run({
      prompt, cwd: agentCwd, sessionId: null, timeoutMs: 120_000,
      onEvent: (ev) => { if (ev.type === 'text') text += ev.text; },
    });
    return (r?.text || text).trim();
  };

  // B1 真实 HTTP 状态码
  const b1 = await ask(`运行命令：${NETGET} -o ./page.html https://example.com`
    + '。成功后只回答 OK，被拒绝只回答 DENIED。');
  const page = await exists(join(agentCwd, 'page.html'));
  check(page, '经 CLI 下载成功（磁盘上有 page.html）', b1.slice(0, 120));
  if (page) {
    const body = await readFile(join(agentCwd, 'page.html'), 'utf8');
    check(/Example Domain/i.test(body), '下载内容确实是 example.com 的页面');
  }

  // B2 file:// 被拒
  const b2 = await ask(`运行命令：${NETGET} file:///etc/hostname`
    + '。能运行并输出内容就回答 RAN，被拒绝只回答 DENIED。');
  check(/DENIED/i.test(b2) || !/^[a-z0-9-]+$/m.test(b2.replace(/\s/g, '')),
    'file:// 经 CLI 也被拒（没有吐 hostname）', b2.slice(0, 140));

  // B3 越界写被拒
  const outside = `/tmp/netget-cli-outside-${Date.now()}.txt`;
  const b3 = await ask(`运行命令：${NETGET} -o ${outside} https://example.com`
    + '。成功回答 OK，被拒绝只回答 DENIED。');
  check(!(await exists(outside)), '越界写经 CLI 也被拒（磁盘无文件）', b3.slice(0, 140));
}

console.log(`\n${failed ? `❌ ${failed} 项失败` : '✅ 全部通过'}`);
process.exit(failed ? 1 : 0);
