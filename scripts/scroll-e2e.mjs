/**
 * 滚动 bug 的浏览器级验证。
 *
 *   node scripts/scroll-e2e.mjs [端口]
 *
 * 老板报"看不到下面、没有滚动条"。根因是 flex 容器缺 min-height:0，
 * 消息流把 .stream 撑到几千像素高，overflow-y 失效。
 *
 * 这条必须真测：**scrollHeight > clientHeight 且能滚到顶/底**，
 * 光看 CSS 有没有那一行证明不了什么。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ok = (c) => (c ? '✅' : '❌');
const CHROME = process.env.CHROME || 'google-chrome';
const target = process.argv[2] || 'http://127.0.0.1:4400/';

const userDir = await mkdtemp(join(tmpdir(), 'scroll-'));
const chrome = spawn(CHROME, [
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
const t = await (await fetch(`${base}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => {
  const my = ++id;
  pending.set(my, r);
  ws.send(JSON.stringify({ id: my, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 800, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 1500));

console.log(`目标：${target}`);
console.log('视口：1440 × 800\n');

// 塞进 40 条长消息，模拟真实的长对话
await evaluate(`(() => {
  const stream = document.getElementById('stream');
  for (let i = 0; i < 40; i += 1) {
    const d = document.createElement('div');
    d.className = 'msg';
    d.innerHTML = '<div></div><div><div class="msg-head"><span class="msg-who">测试</span></div>'
      + '<div class="msg-body">' + ('第 ' + i + ' 条消息，'.repeat(3)) + '内容'.repeat(40) + '</div></div>';
    stream.appendChild(d);
  }
})()`);
await new Promise((r) => setTimeout(r, 400));

const m = await evaluate(`(() => {
  const s = document.getElementById('stream');
  const main = document.querySelector('.main');
  const app = document.getElementById('app');
  return {
    streamScrollH: s.scrollHeight,
    streamClientH: s.clientHeight,
    streamOverflow: getComputedStyle(s).overflowY,
    mainH: main.getBoundingClientRect().height,
    appH: app.getBoundingClientRect().height,
    docScrollH: document.documentElement.scrollHeight,
    winH: window.innerHeight,
  };
})()`);

console.log('测量结果：');
console.log(`  .stream scrollHeight = ${m.streamScrollH}px，clientHeight = ${m.streamClientH}px`);
console.log(`  .main 高度 = ${Math.round(m.mainH)}px，视口 = ${m.winH}px`);
console.log(`  页面总高 = ${m.docScrollH}px`);

console.log('');
console.log(`${ok(m.streamScrollH > m.streamClientH)} 内容超出可视区（scrollHeight > clientHeight）`);
console.log(`${ok(m.mainH <= m.winH + 2)} .main 没有被内容撑开（受视口约束）`);
console.log(`${ok(m.docScrollH <= m.winH + 2)} 整个页面没有溢出（不该出现外层滚动条）`);

// 真滚一下：滚到底再看是否真的到了底。
// 注意 scroll-behavior: smooth 会让赋值变成动画，要等它停下来。
await evaluate(`(() => {
  const s = document.getElementById('stream');
  s.style.scrollBehavior = 'auto';   // 测试里不用动画，否则测的是动画进度
  s.scrollTop = s.scrollHeight;
})()`);
await new Promise((r) => setTimeout(r, 300));
const scrolled = await evaluate(`(() => {
  const s = document.getElementById('stream');
  return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight };
})()`);
console.log(`${ok(scrolled.top > 0)} 能滚动（scrollTop=${scrolled.top}）`);
console.log(`${ok(Math.abs(scrolled.top - scrolled.max) < 3)} 能滚到底（${scrolled.top} / ${scrolled.max}）`);

ws.close();
chrome.kill();
await new Promise((r) => setTimeout(r, 300));
await rm(userDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});

const allOk = m.streamScrollH > m.streamClientH
  && m.mainH <= m.winH + 2
  && m.docScrollH <= m.winH + 2
  && scrolled.top > 0;
process.exit(allOk ? 0 : 1);
