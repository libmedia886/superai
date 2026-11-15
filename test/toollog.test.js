/**
 * 写操作日志（P0 #24）。
 *
 * 为什么单独测：日志的价值不在成功时，在于**事后追"它到底改了什么"**。
 * 可写档下出问题时，没有日志就只能靠猜。所以验的是"能不能追"，不是"有没有写"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

async function makeRoom(adapterEvents = []) {
  const dir = await mkdtemp(join(tmpdir(), 'tl-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const room = new Room({
    id: 'r', name: 'r', goal: '写日志测试',
    members: [{ id: 'dev', name: 'dev', role: 'leader', backend: 'claude', tier: 'write', cwd: dir }],
    store,
    resolveAdapter: () => ({
      run: async ({ onEvent }) => {
        for (const ev of adapterEvents) onEvent(ev);
        return { text: '完成。', reason: 'completed' };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  return { room, store, events, dir };
}

test('★ write 工具调用落进日志（能追到具体路径）', async () => {
  const { room, events } = await makeRoom([
    { type: 'tool', tool: 'Write', path: '/repo/app.js', detail: '/repo/app.js (120 字符)' },
  ]);

  await room.humanSay('@dev 改 app.js');
  await room.drain();

  assert.equal(room.toolLog.length, 1);
  const entry = room.toolLog[0];
  assert.equal(entry.agentId, 'dev');
  assert.equal(entry.tool, 'Write');
  assert.equal(entry.action, 'write');
  assert.equal(entry.path, '/repo/app.js');
  assert.ok(entry.at > 0, '必须有时间戳');

  assert.ok(events.some((e) => e.type === 'tool' && e.path === '/repo/app.js'), '界面也要收到');
});

test('★ bash 调用记下命令（可写+执行档下这是唯一的追责依据）', async () => {
  const { room } = await makeRoom([
    { type: 'tool', tool: 'Bash', command: 'rm -rf /tmp/x' },
  ]);
  await room.humanSay('@dev 干活');
  await room.drain();

  const e = room.toolLog[0];
  assert.equal(e.action, 'bash');
  assert.equal(e.command, 'rm -rf /tmp/x');
});

test('edit 与 read 分别归类（read 也要记，能看出它翻过什么）', async () => {
  const { room } = await makeRoom([
    { type: 'tool', tool: 'Read', path: '/repo/a.js' },
    { type: 'tool', tool: 'Edit', path: '/repo/b.js' },
  ]);
  await room.humanSay('@dev 干活');
  await room.drain();

  assert.equal(room.toolLog[0].action, 'read');
  assert.equal(room.toolLog[1].action, 'edit');
});

test('日志带 taskId（能回答"这个任务改了哪些文件"）', async () => {
  const { room, store } = await makeRoom([
    { type: 'tool', tool: 'Write', path: '/repo/x.js' },
  ]);
  await store.createTask({ id: 'T-001', title: 'x', status: '进行中', assignee: 'dev' });

  await room.humanSay('@dev 干活', { taskId: 'T-001' });
  await room.drain();

  assert.equal(room.toolLog[0].taskId, 'T-001');
  const forTask = room.toolLog.filter((e) => e.taskId === 'T-001');
  assert.equal(forTask.length, 1);
});

test('日志持久化并能重放（重启后仍可追责）', async () => {
  const { room, store, dir } = await makeRoom([
    { type: 'tool', tool: 'Write', path: '/repo/a.js' },
    { type: 'tool', tool: 'Bash', command: 'echo hi' },
  ]);
  await room.humanSay('@dev 干活');
  await room.drain();

  await new Promise((r) => setTimeout(r, 100));   // 等落盘
  const raw = await readFile(join(dir, 'room.jsonl'), 'utf8');
  const kinds = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l).kind);
  assert.equal(kinds.filter((k) => k === 'tool').length, 2);

  const replay = new Store(join(dir, 'room.jsonl'));
  await replay.load();
  assert.equal(replay.toolLog.length, 2);
  assert.equal(replay.toolLog[0].path, '/repo/a.js');
  assert.equal(replay.toolLog[1].command, 'echo hi');
});

test('没有工具调用时不产生空记录（不制造噪音）', async () => {
  const { room } = await makeRoom([]);
  await room.humanSay('@dev 只是聊聊');
  await room.drain();
  assert.equal(room.toolLog.length, 0);
});

/* ---------- write-exec 档：bash 类调用 ---------- */

test('★ 可写+执行档：bash 调用落日志且 command 有值', async () => {
  const { room } = await makeRoom([
    { type: 'tool', tool: 'Bash', command: 'echo hello > made-by-bash.txt' },
  ]);
  await room.humanSay('@dev 跑个命令');
  await room.drain();

  const e = room.toolLog[0];
  assert.equal(e.action, 'bash', 'action 必须是 bash');
  assert.equal(e.tool, 'Bash');
  assert.equal(e.command, 'echo hello > made-by-bash.txt', 'command 不能是 null');
  assert.equal(e.path, null, 'bash 没有 file_path，path 就该是 null');
});

test('可写档 vs 可写+执行档：档位不同，日志里出现的动作类型不同', async () => {
  // write 档只会有 read/edit/write；write-exec 才会出现 bash
  const writeTier = await makeRoom([
    { type: 'tool', tool: 'Read', path: '/r/a.js' },
    { type: 'tool', tool: 'Edit', path: '/r/a.js' },
  ]);
  await writeTier.room.humanSay('@dev 改文件');
  await writeTier.room.drain();
  const writeActions = new Set(writeTier.room.toolLog.map((e) => e.action));
  assert.ok(!writeActions.has('bash'), '可写档不该出现 bash 动作');

  const execTier = await makeRoom([
    { type: 'tool', tool: 'Bash', command: 'ls -la' },
  ]);
  await execTier.room.humanSay('@dev 跑命令');
  await execTier.room.drain();
  assert.ok(execTier.room.toolLog.some((e) => e.action === 'bash'));
});

test('bash 日志也持久化并可重放（追责依据不能只活在内存）', async () => {
  const { room, dir } = await makeRoom([
    { type: 'tool', tool: 'Bash', command: 'rm -rf /tmp/dangerous' },
  ]);
  await room.humanSay('@dev 干活');
  await room.drain();

  await new Promise((r) => setTimeout(r, 100));
  const replay = new Store(join(dir, 'room.jsonl'));
  await replay.load();

  const bashEntry = replay.toolLog.find((e) => e.action === 'bash');
  assert.ok(bashEntry, '重放后仍能找到 bash 记录');
  assert.equal(bashEntry.command, 'rm -rf /tmp/dangerous', '命令内容必须保留');
});
