/**
 * 未完成清单：被拒的动作必须**跨轮**重现，且不许被写成"已完成"。
 *
 * 真实事故（15:27:54，管理方逐条核过 jsonl）：
 *  管理员连续三次 `{"action":"task.update","id":"T-008","status":"阻塞·需外部渠道"}`
 *  三次都被拒（非法状态）。被拒结果确实回注进了下一轮 prompt——但只活那一轮。
 *  它跨了很多轮之后写报告，明确声称「T-008/T-009 已改为阻塞」，
 *  而任务板上它们至今是「待办」。
 *
 * 这一族的共同点：**系统说了不行，模型当成了行**。修法必须覆盖两层：
 *  1. 每轮 prompt 里重现（不能只靠上一轮的回注）
 *  2. 正文与真实状态对账（它真要写"已改"，界面不能替它圆谎）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

async function makeRoom({ answers = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pending-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const prompts = [];
  const adapter = {
    current: 'lead',
    async run({ onEvent, prompt }) {
      const who = adapter.current;
      prompts.push({ who, prompt });
      onEvent?.({ type: 'meta', sessionId: `s-${who}` });
      const text = answers[who] ?? '收到。';
      if (text) onEvent?.({ type: 'text', text, done: false });
      return { text, sessionId: `s-${who}`, reason: 'completed', usage: null };
    },
  };
  const room = new Room({
    id: 'r', name: '测试',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['lead'] },
    ],
    store,
    resolveAdapter: (agent) => { adapter.current = agent.id; return adapter; },
    onEvent: (e) => events.push(e),
  });
  return { room, store, events, prompts, dir };
}

const rejectAction = {
  action: 'task.update', id: 'T-008', status: '量子态',
};

test('★ 被拒的动作从 actionLog 派生成未完成清单', async () => {
  const { room, store } = await makeRoom({
    answers: { lead: `好\n\`\`\`action\n${JSON.stringify(rejectAction)}\n\`\`\`` },
  });
  await store.createTask({ id: 'T-008', title: '取证', assignee: null, status: '待办', createdBy: 'lead' });

  await room.humanSay('@lead 改 T-008');
  await room.drain();

  const pending = room.unresolvedActions();
  assert.equal(pending.length, 1, '被拒的动作要进清单');
  assert.match(pending[0].label, /task\.update T-008/);
  assert.match(pending[0].reason, /合法值|非法状态/);
});

test('★ 未完成清单在**后续每一轮**都重现（不是只回注一次）', async () => {
  const { room, store, prompts } = await makeRoom({
    answers: { lead: `好\n\`\`\`action\n${JSON.stringify(rejectAction)}\n\`\`\`` },
  });
  await store.createTask({ id: 'T-008', title: '取证', assignee: null, status: '待办', createdBy: 'lead' });

  await room.humanSay('@lead 改 T-008');
  await room.drain();

  // 之后又聊了好几轮，每轮都不再提这个动作
  room.resolveAdapter = (agent) => ({
    async run({ onEvent, prompt }) {
      prompts.push({ who: 'lead', prompt });
      onEvent?.({ type: 'meta', sessionId: 's2' });
      return { text: '继续别的', sessionId: 's2', reason: 'completed', usage: null };
    },
  });
  for (let i = 0; i < 3; i += 1) {
    await room.humanSay(`@lead 第 ${i} 件别的事`);
    await room.drain();
  }

  const later = prompts.slice(-3);
  assert.equal(later.length, 3);
  for (const p of later) {
    assert.match(p.prompt, /未完成清单/, '每轮都要出现');
    assert.match(p.prompt, /T-008/, '要指出具体是哪一条');
    assert.match(p.prompt, /没有成功|没有成功\*\*/, '要说明它没成功');
  }
});

test('★ 动作后来成功了 → 自动从清单消失（不需要额外的"解决"动作）', async () => {
  const { room, store } = await makeRoom({
    answers: { lead: `好\n\`\`\`action\n${JSON.stringify(rejectAction)}\n\`\`\`` },
  });
  await store.createTask({ id: 'T-008', title: '取证', assignee: null, status: '待办', createdBy: 'lead' });
  await room.humanSay('@lead 改 T-008');
  await room.drain();
  assert.equal(room.unresolvedActions().length, 1);

  // 第二次发正确的动作
  room.resolveAdapter = () => ({
    async run({ onEvent }) {
      onEvent?.({ type: 'meta', sessionId: 's3' });
      const text = `这次对了\n\`\`\`action\n{"action":"task.update","id":"T-008","status":"阻塞"}\n\`\`\``;
      onEvent?.({ type: 'text', text, done: false });
      return { text, sessionId: 's3', reason: 'completed', usage: null };
    },
  });
  await room.humanSay('@lead 再改一次');
  await room.drain();

  assert.equal(room.unresolvedActions().length, 0, '成功之后不该还挂在清单里');
  assert.equal(store.tasks.get('T-008').status, '阻塞');
});

test('★ 清单重启后仍在（来自落盘的 actionLog，不是内存字段）', async () => {
  const { room, store, dir } = await makeRoom({
    answers: { lead: `好\n\`\`\`action\n${JSON.stringify(rejectAction)}\n\`\`\`` },
  });
  await store.createTask({ id: 'T-008', title: '取证', assignee: null, status: '待办', createdBy: 'lead' });
  await room.humanSay('@lead 改 T-008');
  await room.drain();
  await store.flush();

  // "重启"：新 Store 读同一个 jsonl，新 Room
  const store2 = new Store(join(dir, 'room.jsonl'));
  await store2.load();
  const room2 = new Room({
    id: 'r', name: '测试',
    members: [{ id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['lead'] }],
    store: store2,
    resolveAdapter: () => ({ async run() { return { text: '', reason: 'completed' }; } }),
    onEvent: () => {},
  });
  const pending = room2.unresolvedActions();
  assert.equal(pending.length, 1, '重启后仍要记得"这个动作没做成"');
  assert.match(pending[0].label, /T-008/);
});

test('★ 正文声称"已改"但动作没成功 → 界面标出来 + 塞进下一轮说明', async () => {
  const { room, store, events } = await makeRoom({
    answers: { lead: 'T-008/T-009 已改为「阻塞·需外部渠道」，报告见附件。' },
  });
  await store.createTask({ id: 'T-008', title: '取证', assignee: null, status: '待办', createdBy: 'lead' });

  // 手工把"失败"写进 actionLog（模拟之前三次被拒）
  await store.append({
    kind: 'action', agentId: 'lead', taskId: null,
    label: 'task.update T-008', ok: false, reason: '非法状态「阻塞·需外部渠道」', at: Date.now(),
  });

  await room.humanSay('@lead 写个报告');
  await room.drain();

  const warn = events.find((e) => e.type === 'notice' && /没有成功/.test(e.text ?? ''));
  assert.ok(warn, '必须在界面上指出"它说已改，但系统里没成功"');
  assert.match(warn.text, /T-008/);

  assert.ok(room._notes?.get('lead')?.length > 0, '还要塞进它下一轮必须看到的说明里');
  assert.equal(store.tasks.get('T-008').status, '待办', '任务板状态不能因为一句话就变了');
});

test('没有未完成动作时，正文提到 id 不会被误判为撒谎', async () => {
  const { room, store, events } = await makeRoom({
    answers: { lead: 'T-008 还需要更多资料，我继续查。' },
  });
  await store.createTask({ id: 'T-008', title: '取证', assignee: null, status: '待办', createdBy: 'lead' });

  await room.humanSay('@lead 说说进度');
  await room.drain();

  assert.ok(!events.some((e) => e.type === 'notice' && /没有成功/.test(e.text ?? '')),
    '没有未完成动作时不能乱报警');
});

test('清单有条数上限（不能让 prompt 无限膨胀）', async () => {
  const { room, store } = await makeRoom();
  for (let i = 0; i < 30; i += 1) {
    await store.append({
      kind: 'action', agentId: 'lead', taskId: null,
      label: `task.update T-${String(i).padStart(3, '0')}`, ok: false, reason: '非法状态', at: Date.now(),
    });
  }
  assert.ok(room.unresolvedActions({ limit: 20 }).length <= 20);
});

test('★ 意图句不能被当成"谎称已完成"（误报会让警告失去信任）', async () => {
  const { room, store, events } = await makeRoom();
  await store.append({
    kind: 'action', agentId: 'lead', taskId: null,
    label: 'task.update T-008', ok: false, reason: '非法状态', at: Date.now(),
  });

  const intent = [
    '我打算把 T-008 改成阻塞，等渠道确认。',
    '建议 T-008 改为阻塞。',
    'T-008 还需要等待外部渠道。',
    '计划将 T-008 设为阻塞。',
  ];
  for (const t of intent) {
    events.length = 0;
    room._detectFalseClaims(t, 'lead');
    assert.ok(!events.some((e) => /没有成功/.test(e.text ?? '')),
      `这是提议不是声称，不该报：${t}`);
  }

  const claims = [
    'T-008 已改为阻塞。',
    '已把 T-008 改成阻塞，报告见附件。',
    'T-008 设置为阻塞。',
  ];
  for (const t of claims) {
    events.length = 0;
    room._detectFalseClaims(t, 'lead');
    assert.ok(events.some((e) => /没有成功/.test(e.text ?? '')),
      `这是声称已处理，必须报：${t}`);
  }
});
