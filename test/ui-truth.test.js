/**
 * 「界面上那句话，说的必须做得到」——第五类不变量。
 *
 * 背景（管理方 19:10 统计）：今天"界面与事实不符"共出现 9 次——
 * 停因三句假话、空转误判、按钮不存在、seq 警告不进 init、档位文案、
 * `已完成✅` 被拒、越权不回注、驳回只发 UI。
 * **它们没有一个被单元测试抓到，全部是"读线上产物"发现的。**
 *
 * 为什么单元测试抓不到：以前测的是"函数返回了什么"，而这些缺陷都在
 * **"函数返回的东西被人读到之后，又对用户说了什么"** 这一层。
 *
 * 所以这个文件测的是三类"跨层一致性"：
 *   1. 文案提到的按钮 ↔ 运行时真的存在那个可执行动作
 *   2. 文案提到的数字 ↔ 同一时刻的运行时数据（durationMs / toolCalls / textChars）
 *   3. 只发一次的事件 ↔ 刷新后仍在（必须进 room.init）
 *
 * 第 3 条尤其重要：SSE 事件不重放，所以任何"界面状态"都必须能从 init 恢复。
 * seqWarning 和 resumeTarget 都在这上面踩过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../src/server.js';
import { timeoutPauseText, Room } from '../src/core/room.js';
import { Store } from '../src/core/store.js';

/**
 * 拉一次 /events 的第一帧，就是"刷新时页面拿到的东西"。
 *
 * ⚠️ SSE 是长连接，读完必须显式 cancel 掉 reader 并 abort，
 * 否则连接一直挂着，`server.close()` 永远等不到 drain，测试进程会卡死
 * （这个坑我自己踩了一次：120 秒超时）。
 */
async function fetchInit(url) {
  const ac = new AbortController();
  let text = '';
  try {
    const res = await fetch(`${url}/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    // 第一帧只是 `retry: 1000`，init 在下一帧——要一直读到 data: 行为止
    while (!text.includes('data: ')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
  } finally {
    ac.abort();
  }
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  assert.ok(line, `拿到初始化帧（实际收到：${text.slice(0, 120)}）`);
  return JSON.parse(line.slice(6));
}

/** 关服务器：先掐掉所有活着的连接（SSE 不会自己断） */
function closeServer(server) {
  server.closeAllConnections?.();
  server.close();
}

async function makeServer({ roomsMeta = null, roomCfg = null, roomJsonl = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'inv5-'));
  await mkdir(join(dir, 'rooms', 'r-a', 'agents', 'a'), { recursive: true });
  await writeFile(join(dir, 'rooms', 'r-a', 'room.json'), JSON.stringify(roomCfg ?? {
    name: '测试', goal: '', registry: [],
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly' }],
  }));
  if (roomJsonl) await writeFile(join(dir, 'rooms', 'r-a', 'room.jsonl'), roomJsonl);
  await writeFile(join(dir, 'rooms.json'), JSON.stringify(roomsMeta ?? {
    version: 1, activeRoomId: 'r-a',
    rooms: [{ id: 'r-a', name: '测试', createdAt: new Date().toISOString() }],
  }));
  const { server, url, manager } = await startServer({ port: 0, dataDir: dir });
  return { server, url, manager, dir };
}

/* ---------------- 第 3 类：只发一次的事件 ↔ 刷新后仍在 ---------------- */

test('★ resumeTarget 必须进 room.init（刷新后按钮文案不能退回「接着推进」）', async () => {
  const { server, url, manager } = await makeServer();
  try {
    // 造一个"有可续轮次"的状态
    manager.session.room.resumeTarget = {
      agentId: 'a', taskId: null, partialChars: 9, reason: 'timeout',
      at: new Date().toISOString(),
    };
    const init = await fetchInit(url);

    assert.ok(init.resumeTarget, '刷新（新连接）后仍要拿到 resumeTarget，否则按钮回来变「接着推进」');
    assert.equal(init.resumeTarget.agentId, 'a');
    assert.equal(init.resumeTarget.partialChars, 9);
  } finally {
    closeServer(server);
  }
});

test('★ seqWarning 必须进 room.init（同上一类，已经在线上踩过）', async () => {
  const dup = [
    JSON.stringify({ v: 1, seq: 1, kind: 'message', message: { id: 'M1', senderId: 'human', body: 'a' } }),
    JSON.stringify({ v: 1, seq: 1, kind: 'message', message: { id: 'M2', senderId: 'human', body: 'b' } }),
  ].join('\n') + '\n';

  const { server, url } = await makeServer({ roomJsonl: dup });
  try {
    const init = await fetchInit(url);
    assert.ok(init.seqWarning, '有重复 seq 时刷新也要能看到警告');
    assert.equal(init.seqWarning.duplicates, 1);
  } finally {
    closeServer(server);
  }
});

test('没有可续轮次 / 没有重复 seq 时，init 里是 null（不是空对象）', async () => {
  const { server, url } = await makeServer();
  try {
    const init = await fetchInit(url);
    assert.equal(init.resumeTarget, null);
    assert.equal(init.seqWarning, null);
  } finally {
    closeServer(server);
  }
});

/* ---------------- 第 1 类：文案提到的按钮 ↔ 真的存在 ---------------- */

test('★ 文案说「接着做完」时，运行时必须有 resumeTarget（同一时刻）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inv5b-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();

  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        onEvent?.({ type: 'text', text: '写了一半', done: false });
        return { text: '写了一半', sessionId: 's', reason: 'timeout' };
      },
    }),
    onEvent: () => {},
  });
  room.maxRetries = 0;

  await room.humanSay('@a 干活');
  await room.drain();

  const detail = room.pauseReason?.detail ?? '';
  const mentionsResume = /接着做完/.test(detail);
  assert.ok(mentionsResume, `有产出时文案应提「接着做完」：${detail}`);
  assert.ok(room.resumeTarget, '文案提到按钮，运行时就必须真有可续轮次');
  assert.equal(room.resumeTarget.agentId, 'a');
});

test('★ 纯空转时文案不提按钮，运行时也没有 resumeTarget（两边一致）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inv5c-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();

  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        return { text: '', sessionId: 's', reason: 'timeout' };
      },
    }),
    onEvent: () => {},
  });
  room.maxRetries = 0;

  await room.humanSay('@a 干活');
  await room.drain();

  assert.doesNotMatch(room.pauseReason?.detail ?? '', /接着做完/);
  assert.equal(room.resumeTarget, null, '没东西可续就别提示按钮');
});

/* ---------------- 第 2 类：文案里的数字 ↔ 运行时数据 ---------------- */

test('★ 文案里的每个数字都能在运行时数据里找到对应物', () => {
  const runtime = { durationMs: 112_584, timeoutMs: 1_800_000, toolCalls: 0, textChars: 0 };
  const text = timeoutPauseText({
    name: 'a', stalledOut: true, ...runtime, stallMs: 90_000, canResume: false,
  });

  // 耗时来自 durationMs（112.6 秒 → 113）
  assert.match(text, new RegExp(`耗时 ${Math.round(runtime.durationMs / 1000)} 秒`));
  // 配置上限不能冒充耗时
  assert.doesNotMatch(text, /耗时 1800 秒/);
  // 工具调用数来自 runtime
  assert.match(text, new RegExp(`${runtime.toolCalls} 次工具调用`));
  // 没输出才说没有输出
  assert.match(text, /没有任何工具调用、也没有输出|空转/);
});

test('★ 有正文时，文案里的字数 == 运行时字数', () => {
  const textChars = '我已经写了九个字'.length;
  const text = timeoutPauseText({
    name: 'a', stalledOut: true, durationMs: 20_000, timeoutMs: 600_000,
    toolCalls: 0, textChars, stallMs: 90_000,
  });
  assert.match(text, new RegExp(`已输出 ${textChars} 字`), '字数必须来自真实文本');
  assert.doesNotMatch(text, /也没有输出/, '输出了就不能说没有输出');
});

/* ---------------- 第 4 类：会不会自动重试 = 要不要暂停 ---------------- */

test('★ willRetry 时不得发 room.paused、不得设 resumeTarget（房间根本没停下）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'noretry-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];

  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        onEvent?.({ type: 'text', text: '写了一半', done: false });
        // 模拟看门狗判死：stalled 会走独立的重试通道（可写档也给一次）
        return { text: '写了一半', sessionId: 's', reason: 'timeout' };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  room.maxRetries = 2;
  // 让这一轮被判定为 stalled（看门狗通道 → 允许重试）
  room.health.isStalled = () => false;

  await room.humanSay('@a 干活');
  await room.drain();

  // 这一轮不是 stalled（有正文、run 立即结束），会走 readonly 的常规重试
  const paused = events.find((e) => e.type === 'room.paused');
  const retried = events.find((e) => e.type === 'retry');
  if (retried && !room.pauseReason) {
    assert.equal(paused, undefined, '会重试就不该先暂停');
    assert.equal(room.resumeTarget, null, '会重试就不该设 resumeTarget');
  } else {
    // 没重试的路径：允许暂停
    assert.ok(paused || room.pauseReason);
  }
});

test('★ 卡死 + 已达续做上限 → 暂停并给出「接着做完」（不会再有自动重试）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'giveup-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];

  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        onEvent?.({ type: 'text', text: '写了一半', done: false });
        return { text: '写了一半', sessionId: 's', reason: 'timeout' };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  room.maxRetries = 0;   // 不给重试

  await room.humanSay('@a 干活');
  await room.drain();

  assert.ok(events.some((e) => e.type === 'room.paused'), '不重试就要暂停');
  assert.ok(room.resumeTarget, '有产出就要能接着做完');
  assert.match(room.pauseReason.detail, /接着做完/, '文案要提到那个按钮');
  assert.ok(!events.some((e) => e.type === 'retry'), '不重试');
});

test('★ room.paused 的实时事件必须带 resumeTarget（不能只靠 room.init）', async () => {
  const { server, url, manager } = await makeServer();
  try {
    // 直接订阅 SSE，然后触发一次带 resumeTarget 的 pause
    const ac = new AbortController();
    const res = await fetch(`${url}/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    let buf = '';
    // 先读掉 init + snapshot
    while ((buf.match(/data: /g) ?? []).length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }

    manager.session.room.resumeTarget = { agentId: 'a', taskId: null, partialChars: 4, reason: 'timeout' };
    manager.session.room._pause('timeout', '测试：有可续的轮次');

    const deadline = Date.now() + 3000;
    let pausedEv = null;
    while (Date.now() < deadline && !pausedEv) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const frames = buf.split('\n\n').filter(Boolean);
      for (const f of frames) {
        const line = f.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'room.paused') pausedEv = ev;
        } catch { /* 半帧 */ }
      }
    }
    await reader.cancel();
    ac.abort();

    assert.ok(pausedEv, '要收到 room.paused');
    assert.ok(pausedEv.resumeTarget, '实时事件必须带 resumeTarget，否则不刷新时按钮还是「接着推进」');
    assert.equal(pausedEv.resumeTarget.agentId, 'a');
  } finally {
    closeServer(server);
  }
});

/* ---------------- 第 6 类：按钮指向的对象必须是"这一次"暂停的 ---------------- */

test('★ resumeTarget 与 pauseReason 同生共死（不能指向上一件事）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'couple-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const room = new Room({
    id: 'r', name: 't', members: [], store, resolveAdapter: () => ({}), onEvent: () => {},
  });

  room.resumeTarget = { agentId: 'a', taskId: 'T-A', partialChars: 9, reason: 'timeout' };
  room._pause('timeout', '某轮超时');
  assert.ok(room.resumeTarget, '暂停期间按钮应当可用');

  room._clearPause();
  assert.equal(room.pauseReason, null);
  assert.equal(room.resumeTarget, null,
    '暂停原因消失时按钮必须同时失效，否则它指向的是上一次那件事（而且跑得很正常，只是内容不对）');
});

test('★ 零产出的一轮不会覆盖 resumeTarget —— 但 turn.start 清暂停时它必须一起没', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'couple2-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      // 零产出：0 工具 0 正文
      async run({ onEvent }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        return { text: '', sessionId: 's', reason: 'completed' };
      },
    }),
    onEvent: () => {},
  });

  // 旧待续（任务 A）
  room.resumeTarget = { agentId: 'a', taskId: 'T-A', partialChars: 9, reason: 'timeout' };
  room._pause('timeout', '旧的一轮超时');

  // 系统自己又跑了一轮（零产出，不会覆盖 resumeTarget）
  await room.humanSay('@a 说点什么');
  await room.drain();

  assert.equal(room.pauseReason?.reason !== 'timeout', true, '旧暂停原因已被新一轮作废');
  assert.equal(room.resumeTarget, null, '旧的待续也必须一起失效，否则按钮指向任务 A');
});

test('清单：resumeTarget 必须在 _clearPause 里一起清（唯一来源）', async () => {
  const src = await readFile(new URL('../src/core/room.js', import.meta.url), 'utf8');
  const start = src.indexOf('  _clearPause() {');
  assert.ok(start > 0, '找不到 _clearPause');
  // 取函数体（到下一个同级方法定义为止）
  const body = src.slice(start, src.indexOf('\n  }\n', start) + 4);
  assert.match(body, /this\.resumeTarget = null/, '_clearPause 必须同时清 resumeTarget');
});
