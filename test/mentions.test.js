import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions, applyMentionPolicy } from '../src/core/mentions.js';

const members = [
  { id: 'a1', name: 'alice' },
  { id: 'a2', name: 'bob' },
  { id: 'a3', name: 'bobby' },
  { id: 'a4', name: '架构师', aliases: ['arch'] },
];

test('按出现顺序、去重', () => {
  const r = parseMentions('@bob 你先说，然后 @alice 补充，@bob 再说', { members });
  assert.deepEqual(r.targets, ['a2', 'a1']);
  assert.deepEqual(r.unknown, []);
});

test('最长匹配：@bobby 不会命中 bob', () => {
  const r = parseMentions('@bobby 你来', { members });
  assert.deepEqual(r.targets, ['a3']);
});

test('中文名与别名、全角 @', () => {
  const r = parseMentions('＠架构师 看一下 @arch 也看', { members });
  assert.deepEqual(r.targets, ['a4']);
});

test('忽略对自己的 @', () => {
  const r = parseMentions('@alice 我说完了，@bob 你呢', { members }, 'a1');
  assert.deepEqual(r.targets, ['a2']);
});

test('未知 @ 单独记录且不触发', () => {
  const r = parseMentions('@nobody 你好 @bob', { members });
  assert.deepEqual(r.targets, ['a2']);
  assert.deepEqual(r.unknown, ['nobody']);
});

test('@ 后紧跟拉丁字母不算命中', () => {
  const r = parseMentions('@bobx', { members });
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.unknown, ['bobx']);
});

test('成员越权 @ 被拦下但不静默', () => {
  const { allowed, overreach } = applyMentionPolicy({
    targets: ['leader', 'human', 'other'],
    actorRole: 'member',
    leaderId: 'leader',
    humanId: 'human',
  });
  assert.deepEqual(allowed, ['leader', 'human']);
  assert.deepEqual(overreach, ['other']);
});

test('头头与人不受限', () => {
  const r = applyMentionPolicy({ targets: ['x'], actorRole: 'leader', leaderId: 'l', humanId: 'human' });
  assert.deepEqual(r.overreach, []);
});
