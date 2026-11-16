/**
 * 命令白名单的**真机**验证（claude）。
 *
 *   node scripts/cmd-allow-e2e.mjs
 *
 * 三件事分别验：
 *  1. 没有白名单：让它 curl → 跑不了（这是当前"可写+执行"的实际状态）
 *  2. 白名单 = ["curl"]：curl 真的能跑（正向）
 *  3. 白名单 = ["curl"]：清单外的命令仍被拒（反向）
 *
 * 第 3 条是关键：只验"能跑"会把"整片放开"当成成功。
 * 数据目录在 /tmp，端口随机，跑完即弃。
 */

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../src/server.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';

const ok = (c) => (c ? '✅' : '❌');
let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${ok(cond)} ${label}${!cond && extra ? `（${extra}）` : ''}`);
  if (!cond) failed += 1;
};

const cwd = await mkdtemp(join(tmpdir(), 'cmdallow-'));
await mkdir(cwd, { recursive: true });

const ask = async (adapter, prompt, timeoutMs = 150_000) => {
  let text = '';
  try {
    const r = await adapter.run({ prompt, cwd, sessionId: null, timeoutMs, onEvent: (ev) => {
      if (ev.type === 'text') text += ev.text;
    } });
    return (r?.text || text).trim();
  } catch (err) {
    return `__ERROR__ ${err.message}`;
  }
};

/* ---- 1. 无白名单 ---- */
console.log('① 没有命令白名单（当前"可写+执行"的实际行为）');
const bare = new ClaudeAdapter({ id: 'a', backend: 'claude', tier: 'write-exec', persona: '' });
const out1 = await ask(bare, '运行命令 `curl -s -o /dev/null -w "%{http_code}" https://example.com`。'
  + '能运行就只回答 RAN <状态码>，被拒绝就只回答 DENIED。');
check(!/RAN/.test(out1), 'curl 跑不了（和老板房间里的现象一致）', out1.slice(0, 120));
check(/DENIED|denied|拒绝|没有权限|无法/.test(out1), '它如实说明被拒（不是假装跑过）', out1.slice(0, 120));

/* ---- 2 & 3. 白名单 = curl ---- */
console.log('\n② 白名单 = ["curl"]');
const withCmd = new ClaudeAdapter({
  id: 'b', backend: 'claude', tier: 'write-exec', persona: '', allowedCommands: ['curl'],
});
const out2 = await ask(withCmd, '运行命令 `curl -s -o /dev/null -w "%{http_code}" https://example.com`。'
  + '能运行就只回答 RAN <状态码>，被拒绝就只回答 DENIED。');
check(/RAN/.test(out2), 'curl 真的能跑（正向）', out2.slice(0, 160));

/**
 * 反向探针用 `wget`（清单里只有 curl），**不要用 `id`**：
 * 实测 claude 自带的只读安全分类器会直接放行 `id`/`echo` 这类命令，
 * 无论有没有白名单。它们不是我们控制的，不能拿来做"清单外被拒"的证据。
 */
const out3 = await ask(withCmd, '运行命令 `wget -q -O /dev/null https://example.com`。'
  + '能运行就回答 RAN，被拒绝只回答 DENIED。');
check(/DENIED|denied|拒绝|没有权限|无法/.test(out3), '清单外的联网命令仍被拒（反向）', out3.slice(0, 160));
check(!/RAN/.test(out3), '没有跑成（不是"被拒但仍然执行了"）', out3.slice(0, 160));

/* ---- 4. 目录墙：白名单命令能碰到工作目录之外 ---- */
console.log('\n③ 白名单命令不受目录限制（这是界面必须警告的风险）');
const canary = `/tmp/cmd-allow-outside-${Date.now()}.txt`;
const out4 = await ask(withCmd, `执行命令：curl -s -o ${canary} https://example.com`
  + '。成功了就回答 RAN，被拒绝只回答 DENIED。');
const leaked = await readFile(canary, 'utf8').then(() => true).catch(() => false);
check(/RAN/.test(out4) || leaked, 'curl 能写到工作目录之外（证明"命令行没有目录墙"这条警告是真的）');
if (leaked) {
  const body = (await readFile(canary, 'utf8')).slice(0, 40).replace(/\s+/g, ' ');
  console.log(`   写到 ${canary}：${body}…`);
}

/* ---- 5. 服务层：字段能落盘、能读回 ---- */
console.log('\n④ 服务层：字段落盘与回读');
const dir = await mkdtemp(join(tmpdir(), 'cmdallow-srv-'));
await mkdir(join(dir, 'rooms', 'r-a', 'agents', 'dev'), { recursive: true });
await writeFile(join(dir, 'rooms', 'r-a', 'room.json'), JSON.stringify({
  name: '命令白名单', members: [
    { id: 'dev', name: 'dev', role: 'leader', backend: 'claude', tier: 'write-exec' },
  ],
}, null, 2));
await writeFile(join(dir, 'rooms.json'), JSON.stringify({
  version: 1, activeRoomId: 'r-a',
  rooms: [{ id: 'r-a', name: '命令白名单', createdAt: new Date().toISOString() }],
}, null, 2));

const { server, url } = await startServer({ port: 0, dataDir: dir });
const post = async (path, body) => {
  const res = await fetch(url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const upd = await post('/api/member/update', { id: 'dev', patch: { allowedCommands: 'curl' } });
check(upd.status === 200 && upd.data.member?.allowedCommands === 'curl', '接口能设置命令清单');
const cfg = JSON.parse(await readFile(join(dir, 'rooms', 'r-a', 'room.json'), 'utf8'));
check(cfg.members[0].allowedCommands?.[0] === 'curl', '落盘到 room.json');

server.close();
console.log(`\n${failed ? `❌ ${failed} 项失败` : '✅ 全部通过'}`);
process.exit(failed ? 1 : 0);
