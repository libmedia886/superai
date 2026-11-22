#!/usr/bin/env node
/**
 * 环境自检：告诉你这台机器上什么能用、什么不能用。
 *
 *   node bin/doctor.mjs
 *
 * 检查顺序很重要——先看装没装，再看能不能真跑通，最后看沙箱有没有真的生效。
 * 只看"装了没有"是不够的：CLI 装了但没登录、沙箱配了但没生效，
 * 这两种情况都会让你以为能用，实际跑起来才发现。
 */

import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAdapter } from '../src/adapters/index.js';
import { probeSandbox, VERDICT_LABEL, availableTiers, TIER } from '../src/core/probe.js';

const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const DIM = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const mark = { ok: `${G}✓${X}`, bad: `${R}✗${X}`, warn: `${Y}!${X}`, skip: `${DIM}–${X}` };

const backends = ['agy', 'claude', 'codex', 'opencode'];
const base = await mkdtemp(join(tmpdir(), 'doctor-'));

console.log(`${B}多 AI 协作房间 · 环境自检${X}\n`);

const results = [];

for (const backend of backends) {
  const cwd = join(base, backend);
  // 必须先建目录：spawn 的 cwd 不存在时也报 ENOENT，会误导成"命令没装"
  await mkdir(cwd, { recursive: true });
  console.log(`${B}${backend}${X}`);

  const adapter = createAdapter({ backend, tier: TIER.READONLY });
  const p = await adapter.probe(cwd, 60_000);

  if (!p.ok) {
    const installed = Boolean(p.version);
    console.log(`  ${installed ? mark.warn : mark.bad} ${installed ? `已安装（${p.version}）但跑不通` : '未安装'}`);
    if (p.reason) console.log(`    ${DIM}${p.reason}${X}`);
    if (!installed) {
      const hint = {
        agy: 'antigravity CLI（agy）',
        claude: 'npm i -g @anthropic-ai/claude-code',
        codex: 'npm i -g @openai/codex',
        opencode: 'npm i -g opencode-ai',
      }[backend];
      if (hint) console.log(`    ${DIM}安装：${hint}${X}`);
    }
    console.log('');
    results.push({ backend, usable: false, sandbox: null });
    continue;
  }

  console.log(`  ${mark.ok} 可正常调用`);
  console.log(`  ${DIM}支持档位：${availableTiers(backend).join(' / ')}${X}`);

  // 只读档自检：读写都该被拦住
  console.log(`  ${DIM}检查只读限制是否真的生效…${X}`);
  const sb = await probeSandbox(adapter, { cwd, tier: TIER.READONLY });
  const label = VERDICT_LABEL[sb.verdict];
  if (sb.verdict === 'VERIFIED') {
    console.log(`  ${mark.ok} 只读限制：${label}`);
  } else if (sb.verdict === 'LEAKY') {
    console.log(`  ${mark.bad} 只读限制：${label}`);
    console.log(`    ${DIM}它能读取或写入工作目录之外的文件${X}`);
  } else {
    console.log(`  ${mark.warn} 只读限制：${label}`);
    console.log(`    ${DIM}可能是限制没生效，也可能是环境异常——两者都意味着现在不该给它可写权限${X}`);
  }
  if (sb.details?.list) console.log(`    ${DIM}列目录测试：${String(sb.details.list).slice(0, 100)}${X}`);

  console.log('');
  results.push({ backend, usable: true, sandbox: sb.verdict });
}

await rm(base, { recursive: true, force: true });

// ---------- 总结 ----------
console.log(`${B}结论${X}`);
const usable = results.filter((r) => r.usable);
if (!usable.length) {
  console.log(`  ${mark.bad} 没有一个后端可用，房间跑不起来。`);
  console.log(`  ${DIM}先装上其中一个并登录，再跑一次本检查。${X}`);
  process.exit(1);
}

for (const r of results) {
  if (!r.usable) continue;
  const sb = r.sandbox === 'VERIFIED' ? `${G}只读已生效${X}`
    : r.sandbox === 'LEAKY' ? `${R}只读未生效${X}`
      : `${Y}沙箱状态未知${X}`;
  console.log(`  ${mark.ok} ${r.backend}：可用，${sb}`);
}

console.log(`\n${B}下一步${X}`);
console.log('  起服务：node bin/serve.mjs');
console.log('  演示：  node bin/room.mjs --demo');
console.log(`  ${DIM}数据保存在 ~/.multiagent-chat（MAROOM_DATA 可改）${X}`);

if (results.some((r) => r.usable && r.sandbox !== 'VERIFIED')) {
  console.log(`\n${Y}注意${X}：有后端的只读限制未确认生效。给 agent 可写档之前，请先弄清楚这一点——`);
  console.log(`${DIM}否则它可能改到你工作目录之外的文件。${X}`);
}
