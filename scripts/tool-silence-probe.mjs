/**
 * 探针：一次"长时间只有一个工具在跑"的轮次，会不会被看门狗杀掉？
 *
 * 用假 claude CLI（stream-json 格式）：
 *   init → assistant[tool_use] → sleep 45s → assistant[text] → result
 *
 * 真实 claude 在执行工具期间**不产生任何事件**（tool_use 在 assistant 消息里
 * 就发出来了，工具结果在 user 消息里，而我们的适配器忽略 user 事件）。
 * 所以一次 45 秒的 curl 在 app 看来就是 45 秒静默。
 *
 * 用法：node /tmp/tool-silence-probe.mjs <appDir>
 */
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const appDir = process.argv[2];
if (!appDir) { console.error('需要 appDir'); process.exit(2); }

const { startServer } = await import(join(appDir, 'src/server.js'));

const dir = await mkdtemp(join(tmpdir(), 'silence-probe-'));
const roomDir = join(dir, 'rooms', 'r-p');
await mkdir(join(roomDir, 'agents'), { recursive: true });

const fake = join(dir, 'fake-claude.mjs');
await writeFile(fake, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'sess-probe' });
out({ type: 'assistant', message: { content: [
  { type: 'tool_use', name: 'Bash', input: { command: 'curl -m 40 https://example.com' } },
] } });
await new Promise((r) => setTimeout(r, 45000));   // 工具在跑，期间零事件
out({ type: 'assistant', message: { content: [{ type: 'text', text: '工具跑完了' }] } });
out({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 5 } });
`);
await chmod(fake, 0o755);

await writeFile(join(roomDir, 'room.json'), JSON.stringify({
  name: '静默探针',
  members: [{
    id: 'lead', name: '管理员', role: 'leader', backend: 'claude', tier: 'readonly',
    bin: fake,
    // 60 秒硬上限 → 看门狗阈值 max(20s, min(90s, 20s)) = 20 秒
    timeoutMs: 60_000,
  }],
}));
await writeFile(join(roomDir, 'room.jsonl'), '');
await writeFile(join(dir, 'rooms.json'), JSON.stringify({
  version: 1, activeRoomId: 'r-p',
  rooms: [{ id: 'r-p', name: '静默探针', createdAt: '2026-11-16T00:00:00.000Z' }],
}, null, 2));

const { server, url } = await startServer({ port: 0, dataDir: dir, allowMigrate: false });

const t0 = Date.now();
await fetch(`${url}/api/say`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '@管理员 跑一下' }),
});

// 等 40 秒：足够让 20 秒看门狗开火，也足够让 45 秒的工具跑完
await new Promise((r) => setTimeout(r, 40000));

const { readFile } = await import('node:fs/promises');
const lines = (await readFile(join(roomDir, 'room.jsonl'), 'utf8')).trim().split('\n').filter(Boolean);
let verdict = null;
for (const l of lines) {
  const e = JSON.parse(l);
  if (e.kind === 'failure') verdict = { kind: 'failure', ...e };
  if (e.kind === 'message' && e.message.senderId === 'lead') {
    verdict = { kind: 'message', status: e.message.status, body: e.message.body, durationMs: e.message.durationMs };
  }
}

console.log(`appDir: ${appDir}`);
console.log(`耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('结果:', JSON.stringify(verdict));

const killed = verdict?.kind === 'failure' || verdict?.status === 'timeout';
console.log(killed
  ? '\n❌ 工具还在跑就被判卡死杀掉了（工具执行期间没有事件）'
  : '\n✅ 工具跑完，轮次正常结束');

server.close();
await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
process.exit(0);
