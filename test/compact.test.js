import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldCompact, usageRatio, buildSummaryPrompt, buildRebootstrap, pickRecent, FALLBACK_WINDOW,
} from '../src/core/compact.js';

test('达阈值才压缩，不是每轮都压', () => {
  assert.equal(shouldCompact({ usedTokens: 100_000, window: 200_000, backend: 'claude' }), false);
  assert.equal(shouldCompact({ usedTokens: 139_000, window: 200_000, backend: 'claude' }), false);
  assert.equal(shouldCompact({ usedTokens: 140_000, window: 200_000, backend: 'claude' }), true);
  assert.equal(shouldCompact({ usedTokens: 150_000, window: 200_000, backend: 'claude' }), true);
});

test('自定义阈值', () => {
  assert.equal(shouldCompact({ usedTokens: 51_000, window: 100_000, backend: 'claude', threshold: 0.5 }), true);
});

test('拿不到 contextWindow 时按后端缺省估，不崩', () => {
  assert.equal(shouldCompact({ usedTokens: 10, window: null, backend: 'codex' }), false);
  const near = FALLBACK_WINDOW.codex * 0.8;
  assert.equal(shouldCompact({ usedTokens: near, window: null, backend: 'codex' }), true);
});

test('用量为 0 / 非法值不触发', () => {
  assert.equal(shouldCompact({ usedTokens: 0, window: 100, backend: 'claude' }), false);
  assert.equal(shouldCompact({ usedTokens: NaN, window: 100, backend: 'claude' }), false);
});

test('usageRatio 封顶 1', () => {
  assert.equal(usageRatio({ usedTokens: 500_000, window: 200_000, backend: 'claude' }), 1);
  assert.ok(Math.abs(usageRatio({ usedTokens: 100_000, window: 200_000, backend: 'claude' }) - 0.5) < 1e-9);
});

test('摘要 prompt 必须要求保留自己的立场', () => {
  const p = buildSummaryPrompt({
    agentName: 'lead',
    messages: [{ senderName: 'bob', body: '我建议用方案A' }],
  });
  assert.match(p, /你自己（lead）表达过的立场/);
  assert.match(p, /不要写"大家好"/);
  assert.match(p, /bob：我建议用方案A/);
});

test('摘要 prompt 会带上旧摘要与任务状态', () => {
  const p = buildSummaryPrompt({
    agentName: 'lead',
    messages: [],
    previousSummary: '上次结论：选方案A',
    tasks: [{ id: 'T-001', status: '进行中', title: '调研', assignee: 'bob' }],
  });
  assert.match(p, /上次结论：选方案A/);
  assert.match(p, /T-001 \[进行中\] 调研 → bob/);
});

test('轮换后的首轮不能再声称"不含自己说过的话"', () => {
  const p = buildRebootstrap({
    agentName: 'lead',
    summary: '结论：采用方案A，因为扩展性好',
    recent: [{ senderName: 'bob', body: '同意' }],
  });
  assert.match(p, /摘要里对你观点的记录是有效的/);
  assert.doesNotMatch(p, /不含它自己说过的话/);
  assert.match(p, /结论：采用方案A/);
});

test('pickRecent 取尾部', () => {
  const msgs = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  assert.deepEqual(pickRecent(msgs, 2), [{ id: 3 }, { id: 4 }]);
});
