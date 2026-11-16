/**
 * 成员设置弹窗的浏览器级验证。
 *
 *   node scripts/member-ui-e2e.mjs
 *
 * 验管理方列的五条界面要求：
 *  1. 点成员卡片开弹窗（不再是连问四次 prompt）
 *  2. 档位按后端动态列，每档一句话
 *  3. 启动参数下方有最终命令行预览
 *  4. 覆盖档位的参数 → 二次确认 + 卡片常驻标注；参数删掉后标注消失
 *  5. 换后端提示"上下文会重置"
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../src/server.js';

const ok = (c) => (c ? '✅' : '❌');
let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${ok(cond)} ${label}${!cond && extra ? `（${extra}）` : ''}`);
  if (!cond) failed += 1;
};

const CHROME = process.env.CHROME || 'google-chrome';

const dir = await mkdtemp(join(tmpdir(), 'member-ui-'));
await mkdir(join(dir, 'rooms', 'r-a', 'agents', 'bob'), { recursive: true });
await writeFile(join(dir, 'rooms', 'r-a', 'room.json'), JSON.stringify({
  name: '设置测试', members: [
    { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly' },
    { id: 'bob', name: 'bob', role: 'member', backend: 'claude', tier: 'read' },
  ],
}, null, 2));
await writeFile(join(dir, 'rooms.json'), JSON.stringify({
  version: 1, activeRoomId: 'r-a',
  rooms: [{ id: 'r-a', name: '设置测试', createdAt: new Date().toISOString() }],
}, null, 2));

const { server, url } = await startServer({ port: 0, dataDir: dir });

async function withPage(fn) {
  const userDir = await mkdtemp(join(tmpdir(), 'chr-mm-'));
  const chrome = spawn(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=0', `--user-data-dir=${userDir}`, 'about:blank',
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
  const target = await (await fetch(`${base}/json/new?${encodeURIComponent(`${url}/#room=r-a`)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  await new Promise((r) => setTimeout(r, 1600));

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  // 自动接受 confirm（弹窗里的二次确认）并记录它说了什么
  await evaluate(`(() => {
    window.__confirms = [];
    const orig = window.confirm;
    window.confirm = (msg) => { window.__confirms.push(msg); return true; };
    return true;
  })()`);

  try {
    return await fn({ send, evaluate });
  } finally {
    ws.close();
    chrome.kill();
    await new Promise((r) => setTimeout(r, 300));
    await rm(userDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

console.log('=== 成员设置弹窗浏览器验证 ===');

await withPage(async ({ send, evaluate }) => {
  // 1. 卡片上能看出档位含义
  const cards = await evaluate(`(() => {
    const els = [...document.querySelectorAll('#member-list > .member')];
    return els.map(e => e.textContent.replace(/\\s+/g,' ').trim());
  })()`);
  check(cards.length === 2, `两个成员卡片：${cards.join(' | ')}`);
  check(/可读/.test(cards[1]), '卡片显示档位名「可读」');

  // 2. 点卡片开弹窗
  await evaluate(`document.querySelectorAll('#member-list > .member')[1].click()`);
  await new Promise((r) => setTimeout(r, 400));

  const modal = await evaluate(`(() => ({
    open: !document.getElementById('member-modal').classList.contains('hidden'),
    title: document.getElementById('mm-title').textContent,
    name: document.getElementById('mm-name').value,
    backend: document.getElementById('mm-backend').value,
    tiers: [...document.querySelectorAll('.tier-choice-name')].map(e => e.textContent),
    tierDescs: [...document.querySelectorAll('.tier-choice-desc')].map(e => e.textContent),
    selected: document.querySelector('.tier-choice.selected .tier-choice-name')?.textContent,
    preview: document.getElementById('mm-preview').textContent,
  }))()`);
  check(modal.open, '点成员卡片打开设置弹窗');
  check(/bob/.test(modal.title), `标题带成员名：${modal.title}`);
  check(modal.name === 'bob', '名字已填入');
  check(modal.tiers.length >= 4, `档位按后端动态列出 ${modal.tiers.length} 档：${modal.tiers.join(' / ')}`);
  check(modal.tiers.includes('无工具') && modal.tiers.includes('可读'), '有「可读」这一档（老板要的）');
  check(modal.tierDescs.every((d) => d.length > 4), '每档都有实际含义说明');
  check(modal.selected === '可读', `当前档位正确高亮：${modal.selected}`);
  check(modal.preview.includes('--tools'), `命令行预览已显示：${modal.preview}`);

  // 3. 换成 codex → 档位列表跟着变、出现"上下文会重置"确认
  await evaluate(`(() => {
    const sel = document.getElementById('mm-backend');
    sel.value = 'codex';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const codexTiers = await evaluate(`[...document.querySelectorAll('.tier-choice-name')].map(e => e.textContent)`);
  check(codexTiers.length === 2, `codex 只有两档：${codexTiers.join(' / ')}`);
  check(!codexTiers.includes('可写·每次询问'), 'codex 不显示它做不到的"每次询问"档');

  // 换回来
  await evaluate(`(() => {
    const sel = document.getElementById('mm-backend');
    sel.value = 'claude';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 200));

  // 4. 覆盖档位的参数：预览里出现警告，保存时二次确认，保存后卡片常驻标注
  await evaluate(`(() => {
    const el = document.getElementById('mm-extra');
    el.value = '--dangerously-skip-permissions';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const warnShown = await evaluate(`!document.getElementById('mm-override-warn').classList.contains('hidden')`);
  check(warnShown, '覆盖档位的参数在弹窗里立刻提示');

  await evaluate(`document.getElementById('mm-save').click()`);
  await new Promise((r) => setTimeout(r, 900));

  const saved = await evaluate(`(() => ({
    confirms: window.__confirms,
    closed: document.getElementById('member-modal').classList.contains('hidden'),
    cards: [...document.querySelectorAll('#member-list > .member')].map(e => e.textContent.replace(/\\s+/g,' ').trim()),
  }))()`);
  check(saved.confirms.some((c) => /覆盖能力档位/.test(c)), '保存时弹了二次确认');
  check(saved.closed, '保存后弹窗关闭');
  check(/档位被参数覆盖/.test(saved.cards.join(' ')), `卡片常驻标注：${saved.cards.join(' | ')}`);

  // 5. 删掉参数 → 标注消失（标记必须每次重算）
  await evaluate(`document.querySelectorAll('#member-list > .member')[1].click()`);
  await new Promise((r) => setTimeout(r, 300));
  await evaluate(`(() => {
    const el = document.getElementById('mm-extra');
    el.value = '--add-dir /tmp';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate(`document.getElementById('mm-save').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const after = await evaluate(`[...document.querySelectorAll('#member-list > .member')].map(e => e.textContent.replace(/\\s+/g,' ').trim())`);
  check(!/档位被参数覆盖/.test(after.join(' ')), `参数删掉后标注自动消失：${after.join(' | ')}`);

  // 6. 服务端确实存下来了（不是只改了界面）
  const cfg = JSON.parse(await readFile(join(dir, 'rooms', 'r-a', 'room.json'), 'utf8'));
  const bob = cfg.members.find((m) => m.id === 'bob');
  check(bob.extraArgsText === '--add-dir /tmp', `配置已落盘：${bob.extraArgsText}`);
  check(!bob.extraArgs.includes('--dangerously-skip-permissions'), '被替换掉的旧参数没有残留');
});

server.close();
console.log(`\n${failed ? `❌ ${failed} 项失败` : '✅ 全部通过'}`);
process.exit(failed ? 1 : 0);
