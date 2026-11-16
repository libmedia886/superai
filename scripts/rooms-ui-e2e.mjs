/**
 * 房间列表的浏览器级验证（真的点、真的刷新）。
 *
 *   node scripts/rooms-ui-e2e.mjs
 *
 * 验四件事：
 *  1. 打开应用 → 落地页是房间列表（不是空聊天框）
 *  2. 新建房间 → 进房 → 空状态有「添加第一个成员」且写明是头头
 *  3. 刷新 → 回到原房间（不是退回列表）
 *  4. 从列表点另一个房间 → 内容整体换掉（成员/消息不残留）
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
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

/* ---------- 起一个多房间的数据目录 ---------- */
const dir = await mkdtemp(join(tmpdir(), 'rooms-ui-'));
await mkdir(join(dir, 'rooms', 'r-a'), { recursive: true });
await mkdir(join(dir, 'rooms', 'r-b'), { recursive: true });
await mkdir(join(dir, 'rooms', 'r-a', 'agents'), { recursive: true });
await mkdir(join(dir, 'rooms', 'r-b', 'agents'), { recursive: true });
await writeFile(join(dir, 'rooms', 'r-a', 'room.json'), JSON.stringify({
  name: '甲房间', members: [
    { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly' },
  ],
}));
await writeFile(join(dir, 'rooms', 'r-b', 'room.json'), JSON.stringify({
  name: '乙房间', members: [
    { id: 'boss2', name: 'boss2', role: 'leader', backend: 'codex', tier: 'readonly' },
    { id: 'helper', name: 'helper', role: 'member', backend: 'claude', tier: 'readonly' },
  ],
}));
await writeFile(join(dir, 'rooms.json'), JSON.stringify({
  version: 1,
  activeRoomId: 'r-a',
  rooms: [
    { id: 'r-a', name: '甲房间', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'r-b', name: '乙房间', createdAt: '2026-01-02T00:00:00.000Z' },
  ],
}, null, 2));

const { server, url } = await startServer({ port: 0, dataDir: dir });

async function withPage(fn) {
  const userDir = await mkdtemp(join(tmpdir(), 'chr-rooms-'));
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

console.log('=== 房间列表浏览器验证 ===');

await withPage(async ({ send, evaluate }) => {
  // 1. 落地页是房间列表
  const landing = await evaluate(`(() => ({
    listVisible: !document.getElementById('rooms-view').classList.contains('hidden'),
    cards: [...document.querySelectorAll('.room-card-name')].map(e => e.textContent),
    roomNameShown: document.getElementById('room-name').textContent,
    hash: location.hash,
  }))()`);
  check(landing.listVisible, '打开应用先看到房间列表');
  check(landing.cards.length === 2, `列出两个房间：${landing.cards.join(' / ')}`);
  check(landing.hash === '', '列表页不写房间 hash（刷新才能回到"上次进入的房间"）');

  // 2. 点进乙房间
  await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.room-card')];
    cards.find(c => c.textContent.includes('乙房间')).click();
  })()`);
  await new Promise((r) => setTimeout(r, 1200));

  const inRoom = await evaluate(`(() => ({
    listHidden: document.getElementById('rooms-view').classList.contains('hidden'),
    hash: location.hash,
    roomName: document.getElementById('room-name').textContent,
    members: [...document.querySelectorAll('.member-name')].map(e => e.textContent),
    firstBtnShown: !document.getElementById('btn-first-member').classList.contains('hidden'),
    title: document.title,
  }))()`);
  check(inRoom.listHidden, '点选后进入房间');
  check(inRoom.hash === '#room=r-b', `URL 带上房间 id（${inRoom.hash}）`);
  check(inRoom.roomName === '乙房间', '房间名换了');
  check(inRoom.members.join(',') === 'boss2,helper', `成员整体换掉，不残留甲房间的：${inRoom.members.join(',')}`);
  check(inRoom.firstBtnShown === false, '已有成员时不显示"添加第一个成员"');

  // 3. 刷新 → 回原房间
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 2000));
  const afterReload = await evaluate(`(() => ({
    listHidden: document.getElementById('rooms-view').classList.contains('hidden'),
    roomName: document.getElementById('room-name').textContent,
    hash: location.hash,
  }))()`);
  check(afterReload.listHidden, '刷新后仍在房间里（不退回列表）');
  check(afterReload.roomName === '乙房间', `刷新后还是乙房间（${afterReload.roomName}）`);

  // 4. 回到列表并切到甲房间
  await evaluate(`document.getElementById('btn-rooms').click()`);
  await new Promise((r) => setTimeout(r, 400));
  const openedList = await evaluate(`!document.getElementById('rooms-view').classList.contains('hidden')`);
  check(openedList, '「⇄」打开房间列表');

  await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.room-card')];
    cards.find(c => c.textContent.includes('甲房间')).click();
  })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const switched = await evaluate(`(() => ({
    members: [...document.querySelectorAll('.member-name')].map(e => e.textContent),
    roomName: document.getElementById('room-name').textContent,
    hash: location.hash,
  }))()`);
  check(switched.roomName === '甲房间', `切到甲房间（${switched.roomName}）`);
  check(switched.members.join(',') === 'lead', `成员只剩甲房间的：${switched.members.join(',')}`);
  check(switched.hash === '#room=r-a', 'URL 跟着换');

  // 5. 新建房间 → 空房间 → 显眼的「添加第一个成员」
  await evaluate(`document.getElementById('btn-rooms').click()`);
  await new Promise((r) => setTimeout(r, 400));
  await evaluate(`(() => {
    document.getElementById('rooms-new-name').value = '丙房间';
    document.getElementById('rooms-create').requestSubmit();
  })()`);
  await new Promise((r) => setTimeout(r, 1500));

  const empty = await evaluate(`(() => ({
    listHidden: document.getElementById('rooms-view').classList.contains('hidden'),
    roomName: document.getElementById('room-name').textContent,
    firstShown: !document.getElementById('btn-first-member').classList.contains('hidden'),
    firstText: document.getElementById('btn-first-member').textContent.replace(/\s+/g, ' ').trim(),
    members: document.querySelectorAll('.member').length,
    hash: location.hash,
  }))()`);
  check(empty.listHidden, '新建后直接进房间');
  check(empty.roomName === '丙房间', `房间名是新的（${empty.roomName}）`);
  check(empty.members === 0, '新房间没有成员（不预置 lead/bob）');
  check(empty.firstShown, '空房间显示「添加第一个成员」入口');
  check(/第一个成员会自动成为「头头」/.test(empty.firstText), `入口写明第一个成员是头头：${empty.firstText}`);
});

server.close();
console.log(`\n${failed ? `❌ ${failed} 项失败` : '✅ 全部通过'}`);
process.exit(failed ? 1 : 0);
