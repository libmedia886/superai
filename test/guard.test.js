/**
 * CR-008 循环护栏：三个主维度缺一不可，各防一类死循环。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, THRESHOLDS } from '../src/core/guard.js';

test('维度 1：同一 agent 自说自话 → 连续次数触发', () => {
  const g = new LoopGuard();
  let last = [];
  for (let i = 0; i < THRESHOLDS.consecutive; i += 1) {
    last = g.record({ agentId: 'bob' });
  }
  assert.ok(last.some((r) => r.kind === 'consecutive'), '连续 5 次应提示');
});

test('★ 维度 2：一群人轮流转圈 → 链深度触发（谁都没有连续）', () => {
  const g = new LoopGuard({ consecutive: 99, chainDepth: 4, totalTurns: 99 });
  const order = ['a', 'b', 'c', 'a'];
  let reasons = [];
  for (const id of order) reasons = g.record({ agentId: id });

  assert.equal(g.consecutive, 1, '没人连续，维度 1 不会触发');
  assert.ok(reasons.some((r) => r.kind === 'chain'), '链深度应能单独抓住这种情况');
});

test('★ 维度 3：广播人多导致长链 → 总发言数触发', () => {
  const g = new LoopGuard({ consecutive: 99, chainDepth: 99, totalTurns: 6 });
  const people = ['a', 'b', 'c', 'd', 'e', 'f'];
  let reasons = [];
  for (const id of people) reasons = g.record({ agentId: id });

  assert.ok(reasons.some((r) => r.kind === 'total'), '总发言数应能单独抓住这种情况');
});

test('三个维度缺一个就漏一类：验证彼此不可替代', () => {
  // 只配连续次数，抓不住轮转
  const onlyConsecutive = new LoopGuard({ consecutive: 3, chainDepth: 999, totalTurns: 999 });
  for (const id of ['a', 'b', 'c', 'a', 'b', 'c']) onlyConsecutive.record({ agentId: id });
  assert.equal(onlyConsecutive.consecutive, 1);
  assert.ok(!onlyConsecutive.snapshot().chainDepth >= 0);

  // 只配链深度，抓不住自说自话
  const onlyChain = new LoopGuard({ consecutive: 999, chainDepth: 2, totalTurns: 999 });
  for (let i = 0; i < 5; i += 1) onlyChain.record({ agentId: 'a' });
  assert.equal(onlyChain.chainDepth, 1, '同一人连续不加深链深度');
});

test('人类发言重置全部计数（新任务起点）', () => {
  const g = new LoopGuard();
  g.record({ agentId: 'a' });
  g.record({ agentId: 'a' });
  g.record({ agentId: 'b' });
  assert.ok(g.totalTurns > 0);

  g.reset();
  assert.equal(g.consecutive, 0);
  assert.equal(g.chainDepth, 0);
  assert.equal(g.totalTurns, 0);
  assert.equal(g.lastSpeaker, null);
});

test('同一原因只提示一次，不刷屏', () => {
  const g = new LoopGuard({ consecutive: 2, chainDepth: 99, totalTurns: 999 });
  const first = g.record({ agentId: 'a' });
  const second = g.record({ agentId: 'a' });
  // 第 2 次触发 consecutive，第 3 次不该再报同一个原因
  assert.ok(first.length + second.length >= 1);
  const third = g.record({ agentId: 'a' });
  assert.ok(!third.some((r) => r.kind === 'consecutive'), '同一原因不应重复提示');

  // 但人说话重置后，可以再次提示
  g.reset();
  const afterReset = [];
  for (let i = 0; i < 3; i += 1) afterReset.push(...g.record({ agentId: 'a' }));
  assert.ok(afterReset.some((r) => r.kind === 'consecutive'));
});

test('snapshot 供界面展示', () => {
  const g = new LoopGuard();
  g.record({ agentId: 'a' });
  const s = g.snapshot();
  assert.equal(typeof s.consecutive, 'number');
  assert.equal(typeof s.chainDepth, 'number');
  assert.equal(typeof s.totalTurns, 'number');
  assert.equal(s.thresholds.consecutive, THRESHOLDS.consecutive);
});

test('快速往复作为辅助信号', () => {
  const g = new LoopGuard({ consecutive: 99, chainDepth: 99, totalTurns: 999, minGapMs: 30_000 });
  const t0 = 1000;
  g.record({ agentId: 'a', at: t0 });
  g.record({ agentId: 'a', at: t0 + 100 });
  const r = g.record({ agentId: 'a', at: t0 + 200 });
  assert.ok(r.some((x) => x.kind === 'rapid'));
});
