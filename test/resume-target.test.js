/**
 * 「接着做完」这条链的两个不变量（管理方 2026-11-16 19:10 / 19:25 提出）。
 *
 * 背景：`resumeTarget`（待续的那一轮）只有三处会清——用掉、本轮正常收尾、构造。
 * 人直接下新指令时不清，于是会出现：
 *   1. 某轮超时且有产出 → resumeTarget 记下任务 A
 *   2. 人不点按钮，改说一件新事 → 旧值还在
 *   3. 新事跑一轮零产出（0 工具 0 正文）→ 不覆盖旧值
 *   4. 界面仍显示「接着做完」，点下去恢复的是**任务 A**
 * 这不是文案问题，是"照提示操作会作用在错误的对象上"。
 *
 * 另一个不变量：人点「接着做完」时，模型必须知道"这不是失败、已完成别重写"。
 * 自动续做（capContinue）早就有这段说明，人手点的时候反而没有——同一件事两种待遇。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

/** 记下每轮收到的 prompt，方便断言"模型到底被交代了什么" */
function promptCapturingAdapter(reply = '收到') {
  const adapter = {
    prompts: [],
    async run({ prompt, onEvent }) {
      adapter.prompts.push(prompt);
      onEvent?.({ type: 'meta', sessionId: `s-${adapter.prompts.length}` });
      onEvent?.({ type: 'text', text: reply, done: false });
      onEvent?.({ type: 'text', text: '', done: true });
      return { sessionId: `s-${adapter.prompts.length}`, text: reply, reason: 'completed', usage: null };
    },
  };
  return adapter;
}

async function makeRoom() {
  const dir = await mkdtemp(join(tmpdir(), 'resume-target-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const adapter = promptCapturingAdapter();
  const room = new Room({
    id: 'r1',
    name: '测试',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['lead'] },
    ],
    store,
    resolveAdapter: () => adapter,
    onEvent: () => {},
  });
  return { room, adapter, dir };
}

test('★ 人发新指令 → 旧的「待续」失效（不能指向上一件事）', async () => {
  const { room } = await makeRoom();

  // 模拟"上一轮超时、有产出、留下待续"
  room.resumeTarget = { agentId: 'lead', taskId: 'T-A', partialChars: 120, reason: 'timeout' };

  await room.humanSay('@lead 这是一件全新的事');

  assert.equal(room.resumeTarget, null,
    '人下新指令后，旧的待续必须作废——否则「接着做完」会恢复上一件事');
});

test('★ 人点「接着做完」时，prompt 必须说明"不是失败、别重写已完成"', async () => {
  const { room, adapter } = await makeRoom();

  room.resumeTarget = { agentId: 'lead', taskId: null, partialChars: 50, reason: 'timeout' };
  const r = room.resumeInterruptedTurn();
  assert.equal(r.ok, true);
  await room.drain();

  const prompt = adapter.prompts.at(-1) ?? '';
  assert.match(prompt, /接着做完/, '要说明这是人点的「接着做完」');
  assert.match(prompt, /不是你的错|不是失败/, '要说清这不是失败，否则模型会先道歉/解释');
  assert.match(prompt, /不要重写|从断掉的地方/, '要告诉它别从头再来');
});

test('对照：自动续做（capContinue）仍然有同样的说明', async () => {
  const { room, adapter } = await makeRoom();

  await room.drain();   // 空队列，确保干净状态
  room._enqueue('lead', {
    triggerMsg: { id: 'cap-1', senderId: 'system', body: '撞到单轮上限，自动续做' },
    taskId: null,
    source: 'agent',
    kick: true,
    capContinue: 1,
  });
  await room.drain();

  const prompt = adapter.prompts.at(-1) ?? '';
  assert.match(prompt, /被系统中止|续做/, 'capContinue 的说明不能丢');
  assert.match(prompt, /不是你的错|不是失败/);
});
