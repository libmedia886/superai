/**
 * agent 想叫人的时候不会写 @human，会写 @老板。
 * 之前没处理，导致 agent 说"@老板 收到"时界面报"未找到 @老板"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions, HUMAN_ALIASES } from '../src/core/mentions.js';

const members = [
  { id: 'lead', name: 'lead', role: 'leader' },
  { id: 'bob', name: 'bob', role: 'member' },
];

test('★ @老板 能被识别为人类', () => {
  const r = parseMentions('@老板 收到', { members }, 'bob');
  assert.deepEqual(r.targets, ['human']);
  assert.deepEqual(r.unknown, [], '不能报"未找到 @老板"');
});

test('各种人类称呼都能识别', () => {
  for (const alias of HUMAN_ALIASES) {
    const r = parseMentions(`@${alias} 你好`, { members }, 'bob');
    assert.deepEqual(r.targets, ['human'], `@${alias} 应识别为人类`);
  }
});

test('@human 与 @老板 混用去重', () => {
  const r = parseMentions('@老板 @human', { members }, 'bob');
  assert.deepEqual(r.targets, ['human']);
});

test('人类和 agent 混在一起 @ 时顺序正确', () => {
  const r = parseMentions('@bob 先说，@老板 补充', { members }, 'lead');
  assert.deepEqual(r.targets, ['bob', 'human']);
});

test('人自己写 @老板 不算目标（忽略对自己的 @）', () => {
  const r = parseMentions('@老板 我说一下', { members }, 'human');
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.selfTargets, ['human'], '要记下"确实写了 @"，否则会被误判成广播');
});

test('@老板 不会和成员名冲突（最长匹配仍成立）', () => {
  const withBoss = [...members, { id: 'boss', name: 'bossy' }];
  const r = parseMentions('@bossy 你来', { members: withBoss }, 'lead');
  assert.deepEqual(r.targets, ['boss'], '应该匹配成员 bossy 而不是人类别名 boss');
});

test('humanId 传 null 时不匹配人类称呼', () => {
  const r = parseMentions('@老板 你好', { members, humanId: null }, 'bob');
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.unknown, ['老板']);
});
