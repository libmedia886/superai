/**
 * CR-007 卡死检测 + 熔断半开。
 *
 * 重点验两件事：
 *  1. 静默（有进程但没输出）能被检测到——真卡死就长这样
 *  2. 熔断有半开，不会"暂停即永久"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthTracker, STATE, stallThreshold, canAutoRetry, retryDecision } from '../src/core/health.js';

/* ---------- 卡死检测 ---------- */

test('静默超阈值判定为卡死', () => {
  const h = new HealthTracker();
  const t0 = 1_000_000;
  h.touch('a', t0);
  const timeoutMs = 180_000;

  assert.equal(h.isStalled('a', { timeoutMs, now: t0 + 10_000 }), false, '刚有输出，不算卡死');
  // 阈值 = max(20s, timeout/3) = 60s
  assert.equal(stallThreshold(timeoutMs), 60_000);
  assert.equal(h.isStalled('a', { timeoutMs, now: t0 + 61_000 }), true, '超过 60s 无输出应判卡死');
});

test('短超时的下限保护：不低于 20 秒', () => {
  assert.equal(stallThreshold(30_000), 20_000);
  assert.equal(stallThreshold(1_000), 20_000);
});

test('从未有活动的 agent 不算卡死（还没开始跑）', () => {
  const h = new HealthTracker();
  assert.equal(h.isStalled('never-run', { timeoutMs: 180_000 }), false);
});

test('活动会刷新卡死计时（流式输出期间不会误判）', () => {
  const h = new HealthTracker();
  const t0 = 1_000_000;
  h.touch('a', t0);
  h.touch('a', t0 + 50_000);
  assert.equal(h.isStalled('a', { timeoutMs: 180_000, now: t0 + 100_000 }), false, '中间有输出就不算卡死');
});

/* ---------- 熔断三态 ---------- */

test('连续失败达阈值 → 熔断 OPEN', () => {
  const h = new HealthTracker({ failureThreshold: 3 });
  assert.equal(h.canRun('a').ok, true);
  h.failure('a');
  h.failure('a');
  const r = h.failure('a');
  assert.equal(r.tripped, true);
  assert.equal(h.canRun('a').ok, false, '熔断后应拒绝调用');
});

test('★ 冷却结束进入半开，而不是永久停住', () => {
  const h = new HealthTracker({ failureThreshold: 1, cooldownMs: 1000 });
  const t0 = 1_000_000;
  h.failure('a', { now: t0 });
  assert.equal(h.canRun('a', t0 + 500).ok, false, '冷却中');

  const half = h.canRun('a', t0 + 1500);
  assert.equal(half.ok, true, '冷却结束应放行');
  assert.equal(half.probe, true, '并标记为试探');
  assert.match(half.reason, /试探/);
});

test('★ 半开探针成功 → 恢复 CLOSED，冷却重置', () => {
  const h = new HealthTracker({ failureThreshold: 1, cooldownMs: 1000 });
  const t0 = 1_000_000;
  h.failure('a', { now: t0 });
  h.canRun('a', t0 + 1500);            // 进入半开
  h.success('a', t0 + 1600);

  const s = h.snapshot('a');
  assert.equal(s.state, STATE.CLOSED);
  assert.equal(s.failures, 0);
  assert.equal(s.cooldownMs, 1000, '恢复正常后冷却应重置为初始值');
  assert.equal(h.canRun('a', t0 + 1700).ok, true);
});

test('★ 半开探针失败 → 再次熔断且冷却加倍', () => {
  const h = new HealthTracker({ failureThreshold: 1, cooldownMs: 1000, maxCooldownMs: 8000 });
  const t0 = 1_000_000;
  h.failure('a', { now: t0 });
  h.canRun('a', t0 + 1500);            // 半开
  const r = h.failure('a', { now: t0 + 1600 });
  assert.equal(r.state, STATE.OPEN);
  assert.equal(r.cooldownMs, 2000, '冷却应加倍');

  // 冷却上限封顶
  for (let i = 0; i < 5; i += 1) {
    h.canRun('a', t0 + 100_000 + i * 100_000);
    h.failure('a', { now: t0 + 100_000 + i * 100_000 + 10 });
  }
  assert.ok(h.snapshot('a').cooldownMs <= 8000, '冷却不能无限增长');
});

test('熔断拒绝时给出可读的剩余时间', () => {
  const h = new HealthTracker({ failureThreshold: 1, cooldownMs: 60_000 });
  const t0 = 1_000_000;
  h.failure('a', { now: t0 });
  const r = h.canRun('a', t0 + 10_000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /暂停/);
  assert.match(r.reason, /\d+ 秒后自动试探/);
});

/* ---------- 自动重试策略 ---------- */

test('★ 只有只读档允许自动重试', () => {
  assert.equal(canAutoRetry('readonly'), true);
  assert.equal(canAutoRetry('write'), false);
  assert.equal(canAutoRetry('write-exec'), false);
});

test('可写档失败后不自动重试，且原因说明副作用风险', () => {
  const d = retryDecision({ tier: 'write', reason: 'timeout' });
  assert.equal(d.retry, false);
  assert.match(d.reason, /副作用/);
  assert.match(d.reason, /人工确认/);
});

test('只读档超时可重试，业务失败不重试', () => {
  assert.equal(retryDecision({ tier: 'readonly', reason: 'timeout' }).retry, true);
  assert.equal(retryDecision({ tier: 'readonly', reason: 'crashed' }).retry, true);
  assert.equal(retryDecision({ tier: 'readonly', reason: 'failed' }).retry, false);
});

test('只读档也有重试上限', () => {
  assert.equal(retryDecision({ tier: 'readonly', reason: 'timeout', attempt: 2, maxAttempts: 2 }).retry, false);
});

test('snapshot 供界面展示每个 agent 的健康状态', () => {
  const h = new HealthTracker({ failureThreshold: 1 });
  h.failure('a');
  h.success('b');
  const all = h.all();
  assert.equal(all.length, 2);
  assert.equal(all.find((x) => x.agentId === 'a').state, STATE.OPEN);
  assert.equal(all.find((x) => x.agentId === 'b').state, STATE.CLOSED);
});
