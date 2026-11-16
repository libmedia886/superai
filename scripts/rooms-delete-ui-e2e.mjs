/**
 * 删除房间的浏览器级验证（真的点、真的确认、真的查磁盘）。
 *
 *   node scripts/rooms-delete-ui-e2e.mjs
 *
 * 为什么单独写：删除是唯一"点错就以为数据没了"的操作。单测能证明 API 正确，
 * 但证明不了「二次确认真的弹了」「取消真的不删」「左栏真的有这个按钮」。
 *
 * 盲点（管理方点名）：删除必须在**左栏**，不是另加的顶部下拉。
 *
 * 验：
 *  1. 左栏列出房间，每个房间有删除按钮
 *  2. 点删除 → 弹确认 → **取消** → 房间还在
 *  3. 点删除 → 确认 → 房间从列表消失，目录进了 .trash-*
 *  4. 删当前房间 → 自动切到另一个房间，界面不留在死房间
 *  5. 只剩一个房间时删除被明确拒绝
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
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
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/* ---------- 数据目录：三个房间 ---------- */
const dir = await mkdtemp(join(tmpdir(), 'rooms-del-ui-'));
const rooms = [
  { id: 'r-a', name: '甲房间', members: [{ id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly' }] },
  { id: 'r-b', name: '乙房间', members: [{ id: 'boss2', name: 'boss2', role: 'leader', backend: 'codex', tier: 'readonly' }] },
  { id: 'r-c', name: '丙房间', members: [] },
];
for (const r of rooms) {
  await mkdir(join(dir, 'rooms', r.id, 'agents'), { recursive: true });
  await writeFile(join(dir, 'rooms', r.id, 'room.json'), JSON.stringify({ name: r.name, members: r.members }));
  await writeFile(join(dir, 'rooms', r.id, 'room.jsonl'),
    `${JSON.stringify({ v: 1, seq: 1, kind: 'message', message: { id: 'M-1', senderId: 'human', body: `${r.name} 的重要记录` } })}\n`);
}
await writeFile(join(dir, 'rooms.json'), JSON.stringify({
  version: 1,
  activeRoomId: 'r-a',
  rooms: rooms.map((r, i) => ({ id: r.id, name: r.name, createdAt: `2026-01-0${i + 1}T00:00:00.000Z` })),
}, null, 2));

const { server, url } = await startServer({ port: 0, dataDir: dir });

async function withPage(fn) {
  const userDir = await mkdtemp(join(tmpdir(), 'chr-rooms-del-'));
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
  const target = await (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
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
  await new Promise((r) => setTimeout(r, 1500));

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  try {
    return await fn({ send, evaluate });
  } finally {
    ws.close();
    chrome.kill();
    await new Promise((r) => setTimeout(r, 300));
    await rm(userDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

console.log('=== 删除房间（浏览器 + 磁盘） ===');

await withPage(async ({ evaluate }) => {
  // 让 confirm 可控：默认"取消"，需要时改成"确认"
  await evaluate(`(() => {
    window.__confirmAnswer = false;
    window.__confirmCalls = [];
    window.confirm = (msg) => { window.__confirmCalls.push(msg); return window.__confirmAnswer; };
  })()`);

  // 1. 左栏有房间列表 + 删除按钮
  const sidebar = await evaluate(`(() => ({
    items: [...document.querySelectorAll('#room-list .room-item-name')].map(e => e.textContent),
    delButtons: document.querySelectorAll('#room-list .room-item-del').length,
    active: document.querySelector('#room-list .room-item.active .room-item-name')?.textContent ?? null,
  }))()`);
  check(sidebar.items.length === 3, `左栏列出三个房间：${sidebar.items.join(' / ')}`);
  check(sidebar.delButtons === 3, `每个房间都有删除按钮（${sidebar.delButtons} 个）`);
  check(sidebar.active === '甲房间', `左栏标出当前房间（${sidebar.active}）`);

  // 2. 点删除 → 弹确认 → 取消 → 不删
  await evaluate(`(() => {
    window.__confirmAnswer = false;
    const items = [...document.querySelectorAll('#room-list .room-item')];
    items.find(i => i.textContent.includes('乙房间')).querySelector('.room-item-del').click();
  })()`);
  await new Promise((r) => setTimeout(r, 800));

  const afterCancel = await evaluate(`(() => ({
    confirmAsked: window.__confirmCalls.length,
    confirmText: window.__confirmCalls[0] ?? '',
    items: [...document.querySelectorAll('#room-list .room-item-name')].map(e => e.textContent),
  }))()`);
  check(afterCancel.confirmAsked === 1, '点删除会先弹二次确认');
  check(/删除房间/.test(afterCancel.confirmText), `确认框说明在删什么：${afterCancel.confirmText.split('\n')[0]}`);
  check(afterCancel.items.includes('乙房间'), '取消后房间还在');
  check(await exists(join(dir, 'rooms', 'r-b')), '取消后目录也还在');

  // 3. 点删除 → 确认 → 房间消失，目录进 .trash
  await evaluate(`(() => {
    window.__confirmAnswer = true;
    const items = [...document.querySelectorAll('#room-list .room-item')];
    items.find(i => i.textContent.includes('乙房间')).querySelector('.room-item-del').click();
  })()`);
  await new Promise((r) => setTimeout(r, 1500));

  const afterDelete = await evaluate(`(() => ({
    items: [...document.querySelectorAll('#room-list .room-item-name')].map(e => e.textContent),
  }))()`);
  check(!afterDelete.items.includes('乙房间'), `确认后房间从左栏消失：${afterDelete.items.join(' / ')}`);
  check(!(await exists(join(dir, 'rooms', 'r-b'))), '原目录不在了');

  const trashDirs = (await readdir(join(dir, 'rooms'))).filter((n) => n.startsWith('.trash-'));
  check(trashDirs.length === 1, `目录进了 .trash-*（${trashDirs[0] ?? '无'}）`);
  if (trashDirs.length) {
    const kept = await readdir(join(dir, 'rooms', trashDirs[0]));
    check(kept.includes('room.jsonl'), '垃圾桶里还有房间数据（不是 rm）');
  }

  // 4. 删当前房间 → 自动切走，界面不留在死房间
  await evaluate(`(() => {
    window.__confirmAnswer = true;
    const items = [...document.querySelectorAll('#room-list .room-item')];
    const active = items.find(i => i.classList.contains('active'));
    active.querySelector('.room-item-del').click();
  })()`);
  await new Promise((r) => setTimeout(r, 2000));

  const afterActiveDelete = await evaluate(`(() => ({
    roomName: document.getElementById('room-name').textContent,
    items: [...document.querySelectorAll('#room-list .room-item-name')].map(e => e.textContent),
    hash: location.hash,
    listVisible: !document.getElementById('rooms-view').classList.contains('hidden'),
  }))()`);
  check(afterActiveDelete.items.length === 1, `删当前房间后只剩一个：${afterActiveDelete.items.join(' / ')}`);
  check(afterActiveDelete.roomName === '丙房间', `自动切到剩下的房间（${afterActiveDelete.roomName}）`);
  check(afterActiveDelete.hash === '#room=r-c', `URL 指向新房间（${afterActiveDelete.hash}）`);

  // 5. 最后一个不能删
  await evaluate(`(() => {
    window.__confirmAnswer = true;
    window.__confirmCalls = [];
    document.querySelector('#room-list .room-item-del').click();
  })()`);
  await new Promise((r) => setTimeout(r, 800));

  const lastOne = await evaluate(`(() => ({
    items: [...document.querySelectorAll('#room-list .room-item-name')].map(e => e.textContent),
    notices: [...document.querySelectorAll('.sys-note')].map(e => e.textContent).join(' | '),
  }))()`);
  check(lastOne.items.length === 1, '最后一个房间仍在');
  check(/不能删除最后一个房间/.test(lastOne.notices), `给出了明确理由：${lastOne.notices.slice(-60)}`);
  check(await exists(join(dir, 'rooms', 'r-c')), '最后一个房间的目录也没动');
});

server.close();
console.log(`\n${failed ? `❌ ${failed} 项失败` : '✅ 全部通过'}`);
process.exit(failed ? 1 : 0);
