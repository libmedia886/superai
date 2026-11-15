/**
 * 房间目标字段。
 *
 * 起因：实测两个 agent 在没有目标时会互相推诿"你先定目标"，来回三轮。
 * 这不是 bug，是没有信息时模型的自然行为——所以要给它信息。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/core/prompt.js';

function fakeStore() {
  return {
    roster: new Map(),
    tasks: new Map(),
    messages: [],
    messagesSince: () => [],
  };
}

const agent = { id: 'lead', name: 'lead', role: 'leader', tier: 'readonly', backend: 'claude' };

test('有目标时直接写进 prompt', () => {
  const p = buildPrompt({
    agent,
    room: { name: '房间', members: [agent], goal: '产出一份三个人能执行的周计划' },
    store: fakeStore(),
    trigger: { senderId: 'human', body: '开始吧' },
  });
  assert.match(p, /本房间的目标：产出一份三个人能执行的周计划/);
  assert.doesNotMatch(p, /还没有设定目标/);
});

test('★ 没有目标时给出明确指引，而不是让它去问别人', () => {
  const p = buildPrompt({
    agent,
    room: { name: '房间', members: [agent], goal: '' },
    store: fakeStore(),
    trigger: { senderId: 'human', body: '大家都说说' },
  });
  assert.match(p, /还没有设定目标/);
  assert.match(p, /不要和其他人互相推诿/);
  assert.match(p, /要产出什么、怎么算完成/);
});

test('没目标时给成员一个判断依据，避免重复问同一个问题', () => {
  const member = { id: 'bob', name: 'bob', role: 'member', tier: 'readonly', backend: 'codex' };
  const p = buildPrompt({
    agent: member,
    room: { name: '房间', members: [member], goal: '' },
    store: fakeStore(),
    trigger: { senderId: 'human', body: '大家都说说' },
  });
  assert.match(p, /头头已经问过目标的话/);
  assert.match(p, /不要重复问/);
});

test('有目标时不需要这条提示（省 token，也避免噪音）', () => {
  const member = { id: 'bob', name: 'bob', role: 'member', tier: 'readonly', backend: 'codex' };
  const p = buildPrompt({
    agent: member,
    room: { name: '房间', members: [member], goal: '做个登录页' },
    store: fakeStore(),
    trigger: { senderId: 'human', body: '开始' },
  });
  assert.doesNotMatch(p, /头头已经问过目标/);
});

test('目标和成员列表同时存在时顺序稳定（目标在前）', () => {
  const lead = { id: 'lead', name: 'lead', role: 'leader', tier: 'readonly', backend: 'claude' };
  const bob = { id: 'bob', name: 'bob', role: 'member', tier: 'readonly', backend: 'codex' };
  const p = buildPrompt({
    agent: lead,
    room: { name: '房间', members: [lead, bob], goal: '做一个登录页' },
    store: fakeStore(),
    trigger: { senderId: 'human', body: '开始' },
  });
  const goalIdx = p.indexOf('本房间的目标');
  const memberIdx = p.indexOf('群成员');
  assert.ok(goalIdx > 0 && memberIdx > goalIdx, '目标应在成员列表之前，先给方向再给人员');
});
