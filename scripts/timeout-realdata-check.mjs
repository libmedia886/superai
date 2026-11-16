/**
 * 用**真实房间数据的副本**验证 CR-034（不是造的数据）。
 *
 *   MAROOM_DATA=/tmp/realdata-check node scripts/timeout-realdata-check.mjs
 *
 * 数据来自 ~/.multiagent-chat 的只读副本（six 条 status=timeout 且 body 为空的
 * 记录都在里面）。这里只读副本、不碰真实目录。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../src/server.js';

const dataDir = process.env.MAROOM_DATA;
if (!dataDir) { console.error('需要 MAROOM_DATA'); process.exit(2); }

const { server, url } = await startServer({ port: 0, dataDir, allowMigrate: false });

const userDir = await mkdtemp(join(tmpdir(), 'chr-real-'));
const chrome = spawn(process.env.CHROME || 'google-chrome', [
  '--headless', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0',
  `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('Chrome 启动超时')), 20000);
  chrome.stderr.on('data', (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
});

const base = wsUrl.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*$/, '');
const target = await (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const myId = ++id;
  pending.set(myId, resolve);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await new Promise((r) => setTimeout(r, 2000));
await evaluate(`(() => { const c = document.querySelector('.room-card'); if (c) c.click(); })()`);
await new Promise((r) => setTimeout(r, 2500));

const out = await evaluate(`(() => {
  const notes = [...document.querySelectorAll('#stream .sys-note.warn')]
    .map((e) => ({ text: e.textContent.trim(), visible: e.getClientRects().length > 0 }));
  return {
    notes,
    emptyBubbles: [...document.querySelectorAll('#stream .msg.agent .msg-body')]
      .filter((e) => e.textContent.trim() === '' && e.getClientRects().length > 0).length,
    timeoutNotes: notes.filter((n) => n.text.includes('本轮超时')).length,
  };
})()`);

console.log('真实数据副本上的结果：');
console.log('  超时提示条数：', out.timeoutNotes);
console.log('  可见的空气泡：', out.emptyBubbles);
for (const n of out.notes) console.log(`  [${n.visible ? '可见' : '隐藏'}] ${n.text}`);

ws.close();
chrome.kill();
server.close();
await rm(userDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});

const pass = out.timeoutNotes >= 5 && out.emptyBubbles === 0;
console.log(pass ? '\n✅ 真实数据上成立' : '\n❌ 不成立');
process.exit(pass ? 0 : 1);
