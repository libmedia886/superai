/**
 * 两个变更单里指出的缺陷：
 *  1. 权限说明写死"只读"——可写档的 agent 会自我否定
 *  2. leaderId 只取第一个——多头部组织时第二个头头带的人被判越权
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionSentence } from '../src/core/prompt.js';
import { applyMentionPolicy } from '../src/core/mentions.js';

/* ---------- 1. 权限说明按档位生成 ---------- */

test('只读档：明确说不能改文件、不能跑命令', () => {
  const s = permissionSentence({ tier: 'readonly', backend: 'claude' });
  assert.match(s, /只读/);
  assert.match(s, /不能修改文件/);
  assert.match(s, /不能执行/);
});

test('可写档：不能再自称只读，必须说「可以改文件、不能执行命令」', () => {
  const s = permissionSentence({ tier: 'write', backend: 'claude' });
  assert.doesNotMatch(s, /只读模式/, '可写档不能自我否定');
  assert.match(s, /可以修改.*文件/);
  assert.match(s, /不能执行命令/);
});

test('可写+执行档：允许命令，但说明仍限工作目录', () => {
  const s = permissionSentence({ tier: 'write-exec', backend: 'claude' });
  assert.doesNotMatch(s, /只读/);
  assert.match(s, /可以修改文件并执行命令/);
  assert.match(s, /工作目录/);
});

test('opencode 可写档：额外注入「用 write 工具不要用 shell」(双保险)', () => {
  const s = permissionSentence({ tier: 'write', backend: 'opencode' });
  assert.match(s, /write\/edit 工具/);
  assert.match(s, /不要.*shell/);

  // Claude 没有这个限制，不该出现这句
  const claude = permissionSentence({ tier: 'write', backend: 'claude' });
  assert.doesNotMatch(claude, /write\/edit 工具/);
});

test('缺省档位按只读处理（不知道权限时保守）', () => {
  assert.match(permissionSentence({ backend: 'claude' }), /只读/);
});

/* ---------- 2. 多头部组织 ---------- */

const targets = ['lead1', 'lead2', 'lead3', 'human'];

test('多头部：成员可以 @ 自己的头头', () => {
  const r = applyMentionPolicy({
    targets: ['lead2'], actorRole: 'member',
    leaderIds: ['lead1', 'lead2'], reportsTo: ['lead2'], humanId: 'human',
  });
  assert.deepEqual(r.allowed, ['lead2']);
  assert.deepEqual(r.overreach, []);
});

test('★ 多头部：第二个头头带的人 @ 自己头头，不能被判越权', () => {
  // 旧实现只取 leaderId=lead1，所以 lead2 的下属 @lead2 会被误判
  const r = applyMentionPolicy({
    targets: ['lead2'], actorRole: 'member',
    leaderIds: ['lead1', 'lead2'], reportsTo: ['lead2'], humanId: 'human',
  });
  assert.equal(r.overreach.length, 0, '这是旧实现的核心 bug');
});

test('多头部：成员的上级必须是自己的头头，别人的头头仍算越权', () => {
  const r = applyMentionPolicy({
    targets: ['lead1', 'lead2'], actorRole: 'member',
    leaderIds: ['lead1', 'lead2'], reportsTo: ['lead2'], humanId: 'human',
  });
  assert.deepEqual(r.allowed, ['lead2']);
  assert.deepEqual(r.overreach, ['lead1']);
});

test('多头部：成员 @ 人类始终允许', () => {
  const r = applyMentionPolicy({
    targets: ['human'], actorRole: 'member',
    leaderIds: ['lead1'], reportsTo: ['lead1'], humanId: 'human',
  });
  assert.deepEqual(r.allowed, ['human']);
});

test('未指定 reportsTo 时，任一头头都可 @（兼容旧配置）', () => {
  const r = applyMentionPolicy({
    targets: ['lead1', 'lead2'], actorRole: 'member',
    leaderIds: ['lead1', 'lead2'], humanId: 'human',
  });
  assert.deepEqual(r.allowed, ['lead1', 'lead2']);
  assert.deepEqual(r.overreach, []);
});

test('兼容旧的单 leaderId 调用方式', () => {
  const r = applyMentionPolicy({
    targets: ['lead1', 'bob'], actorRole: 'member', leaderId: 'lead1', humanId: 'human',
  });
  assert.deepEqual(r.allowed, ['lead1']);
  assert.deepEqual(r.overreach, ['bob']);
});

test('头头自己不受 @ 限制', () => {
  const r = applyMentionPolicy({
    targets: ['bob', 'carol'], actorRole: 'leader', leaderIds: ['lead1'], humanId: 'human',
  });
  assert.deepEqual(r.overreach, []);
});
