/**
 * @ 候选列表的浏览器级验证。
 *
 *   node scripts/mention-e2e.mjs
 *
 * 用真实的 headless Chrome 打键盘、点鼠标，不是查 DOM 字符串。
 * 验的是老板报的那件事："打 @ 不出人"。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../src/server.js';

const ok = (c) => (c ? '✅' : '❌');
const CHROME = process.env.CHROME || 'google-chrome';

const dir = await mkdtemp(join(tmpdir(), 'mention-'));
await writeFile(join(dir, 'room.json'), JSON.stringify({
  name: '补全测试', goal: '验证 @ 候选', registry: [],
  members: [
    { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly' },
    { id: 'bob', name: 'bob', role: 'member', backend: 'codex', tier: 'readonly' },
    { id: 'carol', name: 'carol', role: 'member', backend: 'opencode', tier: 'readonly' },
  ],
}, null, 2));

const { server, url } = await startServer({ port: 0, dataDir: dir });

/** 用 Chrome DevTools Protocol 驱动页面 */
async function withPage(fn) {
  const userDir = await mkdtemp(join(tmpdir(), 'chr-'));
  const chrome = spawn(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome 启动超时')), 20000);
    chrome.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    chrome.on('exit', () => reject(new Error('Chrome 退出了')));
  });

  const base = wsUrl.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*$/, '');
  const targets = await (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(targets.webSocketDebuggerUrl);

  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await new Promise((r) => setTimeout(r, 1200));   // 等页面脚本加载

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  try {
    return await fn({ send, evaluate });
  } finally {
    ws.close();
    chrome.kill();
    // Chrome 退出时会继续写 profile 目录，删不掉不算失败
    await new Promise((r) => setTimeout(r, 300));
    await rm(userDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

console.log('=== 浏览器级验证 ===');

await withPage(async ({ send, evaluate }) => {
  // 1. 只打一个 @，菜单就该出现
  await evaluate(`document.getElementById('input').focus()`);
  await send('Input.insertText', { text: '@' });
  await evaluate(`document.getElementById('input').dispatchEvent(new Event('input', {bubbles:true}))`);
  await new Promise((r) => setTimeout(r, 200));

  const afterAt = await evaluate(`(() => {
    const m = document.getElementById('mention-menu');
    return {
      visible: !m.classList.contains('hidden'),
      count: m.children.length,
      names: [...m.querySelectorAll('.mention-name')].map(e => e.textContent),
      firstActive: m.children[0]?.classList.contains('active') ?? false,
    };
  })()`);
  console.log(`${ok(afterAt.visible)} 只打一个 @ 菜单就出现`);
  console.log(`${ok(afterAt.count === 3)} 列出全部 3 个成员：${afterAt.names.join(' ')}`);
  console.log(`${ok(afterAt.firstActive)} 第一项默认高亮`);

  // 2. 头头排第一
  console.log(`${ok(afterAt.names[0] === '@lead')} 头头排在第一位`);

  // 3. 上下键移动高亮
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await new Promise((r) => setTimeout(r, 150));
  const afterDown = await evaluate(`(() => {
    const m = document.getElementById('mention-menu');
    const idx = [...m.children].findIndex(e => e.classList.contains('active'));
    return idx;
  })()`);
  console.log(`${ok(afterDown === 1)} 按 ↓ 高亮移到第二项（当前 ${afterDown}）`);

  // 4. 回车插入
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await new Promise((r) => setTimeout(r, 200));

  const afterEnter = await evaluate(`(() => {
    const i = document.getElementById('input');
    return { value: i.value, caret: i.selectionStart,
             menuHidden: document.getElementById('mention-menu').classList.contains('hidden') };
  })()`);
  console.log(`${ok(afterEnter.value === '@bob ')} 回车插入完整名字 + 空格（实际 "${afterEnter.value}"）`);
  console.log(`${ok(afterEnter.caret === 5)} 光标落在名字后面（位置 ${afterEnter.caret}）`);
  console.log(`${ok(afterEnter.menuHidden)} 插入后菜单关闭`);

  // 5. 继续打字能缩小范围
  await evaluate(`(() => {
    const i = document.getElementById('input');
    i.value = '@ca'; i.setSelectionRange(3,3);
    i.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const filtered = await evaluate(`(() => {
    const m = document.getElementById('mention-menu');
    return [...m.querySelectorAll('.mention-name')].map(e => e.textContent);
  })()`);
  console.log(`${ok(filtered.length === 1 && filtered[0] === '@carol')} 打 "@ca" 只剩 @carol`);

  // 6. 点选
  await evaluate(`(() => {
    const i = document.getElementById('input');
    i.value = '@'; i.setSelectionRange(1,1);
    i.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  await evaluate(`(() => {
    const item = document.getElementById('mention-menu').children[2];
    item.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}));
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const afterClick = await evaluate(`document.getElementById('input').value`);
  console.log(`${ok(afterClick === '@carol ')} 点第三项插入 @carol（实际 "${afterClick}"）`);

  // 7. 没有匹配时不残留菜单
  await evaluate(`(() => {
    const i = document.getElementById('input');
    i.value = '@zzz'; i.setSelectionRange(4,4);
    i.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const noMatch = await evaluate(`document.getElementById('mention-menu').classList.contains('hidden')`);
  console.log(`${ok(noMatch)} 没有匹配时菜单关闭（不留空框）`);
});

server.close();
await rm(dir, { recursive: true, force: true });
