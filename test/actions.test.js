import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractActions, stripActionBlocks, dedupeActions, validateAction, authorize,
} from '../src/core/actions.js';

test('解析 JSONL 动作块并从正文剥离', () => {
  const text = `我拆成两个子任务。
\`\`\`action
{"action":"task.create","localId":"l1","title":"调研A","assignee":"bob"}
{"action":"task.update","localId":"l2","id":"T-001","status":"进行中"}
\`\`\`
@bob 先做第一个。`;
  const { actions, errors } = extractActions(text, { actor: 'lead', turn: 1, sessionId: 's1' });
  assert.equal(actions.length, 2);
  assert.equal(errors.length, 0);
  assert.equal(actions[0].actor, 'lead');
  assert.match(actions[0].idemKey, /^lead\|s1\|1\|l1$/);

  const body = stripActionBlocks(text);
  assert.ok(!body.includes('task.create'));
  assert.ok(body.includes('@bob 先做第一个'));
});

test('解析失败不静默：坏行进 errors', () => {
  const text = '```action\n{"action":"task.create","title":"x"\n```';
  const { actions, errors } = extractActions(text, { actor: 'lead' });
  assert.equal(actions.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /解析失败/);
});

test('未知动作类型被拒绝', () => {
  const { errors } = extractActions('```action\n{"action":"task.delete","id":"T-1"}\n```', { actor: 'lead' });
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /未知动作类型/);
});

test('非法状态值被拒绝', () => {
  const { errors } = extractActions(
    '```action\n{"action":"task.update","id":"T-1","status":"做完了"}\n```',
    { actor: 'lead' },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /非法状态/);
});

test('加固 A：引用/嵌套内容里的动作不执行', () => {
  const text = [
    'bob 刚才说：',
    '````markdown',
    '他建议这样写：',
    '```action',
    '{"action":"task.update","id":"T-001","status":"完成"}',
    '```',
    '````',
  ].join('\n');
  const { actions, errors } = extractActions(text, { actor: 'lead' });
  assert.equal(actions.length, 0, '嵌套动作不能被当成当前发言人的动作执行');
  assert.ok(errors.length >= 1);
});

test('加固 B：幂等去重（重试重发同一轮不重复建任务）', () => {
  const text = '```action\n{"action":"task.create","localId":"l1","title":"调研A","assignee":"bob"}\n```';
  const first = extractActions(text, { actor: 'lead', turn: 3, sessionId: 's1' });
  const seen = new Set(first.actions.map((a) => a.idemKey));

  const retry = extractActions(text, { actor: 'lead', turn: 3, sessionId: 's1' });
  const { fresh, skipped } = dedupeActions(retry.actions, seen);
  assert.equal(fresh.length, 0);
  assert.equal(skipped.length, 1);
});

test('没有 localId 时按内容哈希去重', () => {
  const text = '```action\n{"action":"roster.update","duties":"负责审查"}\n```';
  const a = extractActions(text, { actor: 'bob', turn: 1, sessionId: 's1' });
  const b = extractActions(text, { actor: 'bob', turn: 1, sessionId: 's1' });
  assert.equal(a.actions[0].idemKey, b.actions[0].idemKey);
});

test('权限矩阵：成员不能建任务', () => {
  const deny = authorize({ action: 'task.create' }, { role: 'member', actorId: 'bob' });
  assert.ok(deny);
});

test('权限矩阵：成员只能改派给自己的任务', () => {
  assert.equal(authorize({ action: 'task.update', id: 'T-1' }, { role: 'member', actorId: 'bob', task: { assignee: 'bob' } }), null);
  assert.ok(authorize({ action: 'task.update', id: 'T-1' }, { role: 'member', actorId: 'bob', task: { assignee: 'alice' } }));
});

test('权限矩阵：头头只能改自己派出的任务', () => {
  assert.ok(authorize({ action: 'task.update', id: 'T-1' }, { role: 'leader', actorId: 'lead', task: { createdBy: 'human' } }));
  assert.equal(authorize({ action: 'task.update', id: 'T-1' }, { role: 'leader', actorId: 'lead', task: { createdBy: 'lead' } }), null);
});

test('字段校验', () => {
  assert.match(validateAction({ action: 'task.create' }), /缺少 title/);
  assert.match(validateAction({ action: 'task.update', id: 'T-1' }), /没有任何要改的字段/);
  assert.equal(validateAction({ action: 'task.update', id: 'T-1', status: '完成' }), null);
});
