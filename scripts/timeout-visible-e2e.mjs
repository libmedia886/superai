/**
 * 超时/失败的一轮必须**在界面上看得见**（真浏览器 + 真超时）。
 *
 *   node scripts/timeout-visible-e2e.mjs
 *
 * 背景：老板房间的 jsonl 里有 6 条
 *   `status=timeout dur=180049 tok=0 body=""`
 * 历史路径 `if (!m.body) return` 整条跳过，实时路径把空 body 渲染成空气泡，
 * 于是六轮各烧 180 秒、界面上一点痕迹都没有。老板的原话是「为什么又要停在我啊」。
 *
 * 验什么：
 *  1. 历史：空 body + status=timeout 必须产生一条可见记录（不是被跳过）
 *  2. 历史：有部分输出 + timeout → 正文照常 + 「输出不完整」
 *  3. 历史：crashed 同理
 *  4. 正常完成的消息不加任何失败提示（不加噪音）
 *  5. 实时：真的跑一轮并真的超时 → 聊天流里出现超时记录
 *
 * 第 5 条用假 CLI（room.json 的 `bin` 指向一个只 sleep 的脚本）+ 1.5 秒上限，
 * 不依赖本机 claude 登录态，也不烧 token。
 */

import { spawn } from 'node:child_process';
import { chmod, mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
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

/* ---------- 数据目录 ---------- */
const dir = await mkdtemp(join(tmpdir(), 'timeout-visible-'));
const roomDir = join(dir, 'rooms', 'r-t');
await mkdir(join(roomDir, 'agents'), { recursive: true });

/** 假 CLI：只睡眠，永远不产出。超时由 app 的硬上限负责。 */
const fakeBin = join(dir, 'fake-claude.sh');
await writeFile(fakeBin, '#!/bin/sh\nsleep 30\n');
await chmod(fakeBin, 0o755);

await writeFile(join(roomDir, 'room.json'), JSON.stringify({
  name: '超时验收',
  members: [{
    id: 'lead', name: '管理员', role: 'leader', backend: 'claude', tier: 'readonly',
    bin: fakeBin,
    // 用毫秒字段把上限压到 1.5 秒，否则这条 e2e 要跑 20 分钟
    timeoutMs: 1500,
  }],
}));

const at = (iso) => ({ at: iso });
const msg = (seq, id, extra) => JSON.stringify({
  v: 1, seq, kind: 'message',
  message: {
    id, senderId: 'lead', role: 'leader', taskId: null, sessionId: null,
    isSummary: false, usageTokens: 0, ...extra,
  },
});
await writeFile(join(roomDir, 'room.jsonl'), [
  msg(1, 'M-1', { ...at('2026-11-16T04:15:03.000Z'), body: '', status: 'timeout', durationMs: 180049 }),
  msg(2, 'M-2', { ...at('2026-11-16T04:30:25.000Z'), body: '**网络已通。** 取到一半证据', status: 'timeout', durationMs: 180046 }),
  msg(3, 'M-3', { ...at('2026-11-16T04:40:00.000Z'), body: '', status: 'crashed', durationMs: 812 }),
  msg(4, 'M-4', { ...at('2026-11-16T04:41:00.000Z'), body: '这一轮正常说完了', status: 'completed', durationMs: 4210 }),
].join('\n') + '\n');

await writeFile(join(dir, 'rooms.json'), JSON.stringify({
  version: 1,
  activeRoomId: 'r-t',
  rooms: [{ id: 'r-t', name: '超时验收', createdAt: '2026-11-16T04:00:00.000Z' }],
}, null, 2));

const { server, url } = await startServer({ port: 0, dataDir: dir, allowMigrate: false });

/* ---------- headless Chrome（CDP） ---------- */
async function withPage(fn) {
  const userDir = await mkdtemp(join(tmpdir(), 'chr-timeout-'));
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
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
    return await fn({ evaluate });
  } finally {
    ws.close();
    chrome.kill();
    await new Promise((r) => setTimeout(r, 300));
    await rm(userDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

const notes = `[...document.querySelectorAll('#stream .sys-note.warn')]
  .map((e) => ({ text: e.textContent.trim(), visible: e.getClientRects().length > 0 }))`;

console.log('=== 超时轮是否可见（浏览器级） ===');

try {
  await withPage(async ({ evaluate }) => {
    // 落地页是房间列表 → 点进唯一的房间
    await evaluate(`(() => {
      const card = document.querySelector('.room-card');
      if (card) card.click();
    })()`);
    await new Promise((r) => setTimeout(r, 1200));

    const history = await evaluate(`(() => ({
      agentBlocks: document.querySelectorAll('#stream .msg.agent').length,
      bodies: [...document.querySelectorAll('#stream .msg.agent .msg-body')].map((e) => e.textContent.trim()),
      notes: ${notes},
    }))()`);

    // 1) 空 body + timeout 不能被整条跳过
    check(history.agentBlocks === 4, `四条历史都有消息块（实际 ${history.agentBlocks}）`);
    check(
      history.notes.some((n) => n.text === '管理员 本轮超时（180s，无输出）' && n.visible),
      '空 body + timeout → 历史里有一条可见的「本轮超时（180s，无输出）」',
      JSON.stringify(history.notes),
    );

    // 2) 有部分输出：正文还在，提示改说「输出不完整」
    check(history.bodies.some((b) => b.includes('取到一半证据')), '超时前的部分输出仍然显示');
    check(
      history.notes.some((n) => n.text === '管理员 本轮超时（180s，输出不完整）' && n.visible),
      '有部分输出的超时 → 「输出不完整」',
      JSON.stringify(history.notes),
    );

    // 3) 崩溃
    check(
      history.notes.some((n) => n.text === '管理员 本轮崩溃（无输出）' && n.visible),
      'crashed → 历史里可见',
    );

    // 4) 正常完成不加噪音
    check(history.notes.length === 3, `正常完成的消息不加失败提示（提示共 ${history.notes.length} 条，应为 3）`);

    // 5) 实时路径：真发一句，让假 CLI 真的被硬上限杀掉
    await fetch(`${url}/api/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '@管理员 再说一次' }),
    });
    // 1.5s 上限 + 收尾，留足时间
    await new Promise((r) => setTimeout(r, 5000));

    const live = await evaluate(`(() => ({
      notes: ${notes},
      lastBubbleEmpty: (() => {
        const bs = [...document.querySelectorAll('#stream .msg.agent .msg-body')];
        const last = bs[bs.length - 1];
        return last ? last.textContent.trim() === '' : null;
      })(),
    }))()`);

    check(
      live.notes.length > 3 && live.notes.some((n) => /^管理员 本轮超时（\d+s，无输出）$/.test(n.text) && n.visible),
      '实时超时 → 聊天流里立刻出现一条可见记录',
      JSON.stringify(live.notes),
    );
    check(live.lastBubbleEmpty !== true || live.notes.length > 3, '实时路径没有留下"空气泡后无声收尾"');
  });
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}

console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
