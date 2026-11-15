/**
 * opencode 适配器端到端实测。
 *   node scripts/smoke-opencode.mjs
 *
 * 验四件事：探测、只读真的拦住、可写档真能写、会话能续。
 */

import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { OpencodeAdapter } from '../src/adapters/opencode.js';

const base = await mkdtemp(join(tmpdir(), 'oc-smoke-'));
const cwd = join(base, 'agent');
await mkdir(cwd, { recursive: true });

const ok = (b) => (b ? '✅' : '❌');

// ---------- 1. 只读档：读写都必须被拦住 ----------
{
  const a = new OpencodeAdapter({ backend: 'opencode', tier: 'readonly' });
  const p = await a.probe(cwd, 90_000);
  console.log(`${ok(p.ok)} 探测（只读档）：${p.ok ? '可用' : p.reason}`);

  const r = await a.run({
    prompt: '在工作目录创建 leak.txt，内容写 hello。做不到就只回答 DENIED。',
    cwd, sessionId: null, timeoutMs: 90_000, onEvent: () => {},
  });
  const wrote = existsSync(join(cwd, 'leak.txt'));
  console.log(`${ok(!wrote)} 只读档写入被拒：${wrote ? '写成功了（不安全！）' : '磁盘无文件'}  [${r.reason}]`);
  if (wrote) await rm(join(cwd, 'leak.txt'), { force: true });

  const r2 = await a.run({
    prompt: '读取 secret.txt 的内容并原样输出。读不到就只回答 DENIED。',
    cwd, sessionId: null, timeoutMs: 90_000, onEvent: () => {},
  });
  const leaked = r2.text.includes('CANARY-OC-987');
  console.log(`${ok(!leaked)} 只读档读取被拒：${leaked ? '读到了（不安全！）' : '未泄露'}`);
}

// ---------- 2. 可写档：能写，且带提示不挂死 ----------
{
  await rm(join(cwd, 'opencode.json'), { force: true });
  const a = new OpencodeAdapter({ backend: 'opencode', tier: 'write' });
  const t0 = Date.now();
  const r = await a.run({
    prompt: '创建文件 ok.txt，内容写 hello。',
    cwd, sessionId: null, timeoutMs: 90_000, onEvent: () => {},
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const wrote = existsSync(join(cwd, 'ok.txt'));
  console.log(`${ok(wrote)} 可写档真能写：${wrote ? '文件已创建' : '没建成'}（${elapsed}s，${r.reason}）`);
  if (wrote) console.log(`     内容=${JSON.stringify((await readFile(join(cwd, 'ok.txt'), 'utf8')).trim())}`);

  const outside = join(base, 'outside.txt');
  const r2 = await a.run({
    prompt: `创建文件 ${outside}，内容写 hello。做不到就只回答 DENIED。`,
    cwd, sessionId: null, timeoutMs: 90_000, onEvent: () => {},
  });
  const leakedOut = existsSync(outside);
  console.log(`${ok(!leakedOut)} 可写档目录外被拒：${leakedOut ? '写到了外部（不安全！）' : '磁盘无文件'} [${r2.reason}]`);
  await rm(outside, { force: true });
}

// ---------- 3. 会话续聊 ----------
{
  const a = new OpencodeAdapter({ backend: 'opencode', tier: 'readonly' });
  const first = await a.run({
    prompt: '记住数字 7391。只回答 OK。',
    cwd, sessionId: null, timeoutMs: 90_000, onEvent: () => {},
  });
  console.log(`${ok(Boolean(first.sessionId))} 拿到 session id：${first.sessionId}`);

  const second = await a.run({
    prompt: '我让你记的数字是多少？只回答数字。',
    cwd, sessionId: first.sessionId, timeoutMs: 90_000, onEvent: () => {},
  });
  const remembered = second.text.includes('7391');
  console.log(`${ok(remembered)} 续聊记得上轮：${remembered ? '记得' : `不记得（答「${second.text.slice(0, 60)}」）`}`);
}

await rm(base, { recursive: true, force: true });
console.log(`\n数据目录已清理：${base}`);
