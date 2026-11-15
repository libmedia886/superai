/**
 * 用量异常提示。
 *
 * 三条要验的：正常不提示、异常要提示、提示不刷屏。
 * 另外验"中位数而非均值"——这是设计核心，均值被尖峰拉高后就废了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageWatcher, median, DEFAULTS } from '../src/core/usage.js';

test('中位数：偶数取中间两数平均', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([]), 0);
});

test('★ 中位数抗离群值（均值不行）', () => {
  const normal = [1000, 1100, 900, 1050];
  const withSpike = [...normal, 100_000];
  const mean = withSpike.reduce((a, b) => a + b, 0) / withSpike.length;
  assert.ok(mean > 19_000, '均值被尖峰拉到 1.9 万');
  assert.ok(median(withSpike) < 1100, '中位数几乎不受影响——这才是可靠的基线');
});

/* ---------- 正常对话不提示 ---------- */

test('★ 用量平稳时不提示', () => {
  const w = new UsageWatcher();
  let t = 1_000_000;
  for (const tokens of [1000, 1100, 900, 1050, 980, 1020]) {
    const r = w.record({ agentId: 'bob', tokens, now: t });
    t += 60_000;
    assert.equal(r, null, `稳定用量 ${tokens} 不该提示`);
  }
});

test('样本太少时不提示（基线还没建立）', () => {
  const w = new UsageWatcher();
  const r1 = w.record({ agentId: 'bob', tokens: 1000, now: 1_000_000 });
  const r2 = w.record({ agentId: 'bob', tokens: 50_000, now: 1_060_000 });
  assert.equal(r1, null);
  assert.equal(r2, null, '只有 1 个样本时中位数没意义，不该提示');
});

/* ---------- 异常要提示 ---------- */

test('★ 单轮超出中位数 3 倍时提示', () => {
  const w = new UsageWatcher();
  let t = 1_000_000;
  for (let i = 0; i < 4; i += 1) {
    w.record({ agentId: 'bob', tokens: 1000, now: t });
    t += 60_000;
  }
  const r = w.record({ agentId: 'bob', tokens: 5000, now: t });
  assert.ok(r, '应该提示');
  assert.equal(r.kind, 'spike');
  assert.match(r.text, /5\.0k token/);
  assert.match(r.text, /5\.0 倍/);
});

test('不到 3 倍不提示（2 倍算正常波动）', () => {
  const w = new UsageWatcher();
  let t = 1_000_000;
  for (let i = 0; i < 4; i += 1) {
    w.record({ agentId: 'bob', tokens: 1000, now: t });
    t += 60_000;
  }
  assert.equal(w.record({ agentId: 'bob', tokens: 2000, now: t }), null);
});

test('不同 agent 的基线互不影响', () => {
  const w = new UsageWatcher();
  let t = 1_000_000;
  // bob 平时 1000
  for (let i = 0; i < 4; i += 1) { w.record({ agentId: 'bob', tokens: 1000, now: t }); t += 1000; }
  // lead 平时 20k
  for (let i = 0; i < 4; i += 1) { w.record({ agentId: 'lead', tokens: 20_000, now: t }); t += 1000; }

  // lead 用 25k 不该报警（对它正常）
  assert.equal(w.record({ agentId: 'lead', tokens: 25_000, now: t }), null);
  // bob 用 5k 该报警（对它异常）
  assert.ok(w.record({ agentId: 'bob', tokens: 5000, now: t + 1 }));
});

/* ---------- 不刷屏 ---------- */

test('★ 冷却期内不重复提示（防狼来了）', () => {
  const w = new UsageWatcher();
  let t = 1_000_000;
  for (let i = 0; i < 4; i += 1) { w.record({ agentId: 'bob', tokens: 1000, now: t }); t += 60_000; }

  const first = w.record({ agentId: 'bob', tokens: 10_000, now: t });
  assert.ok(first, '第一次要提示');

  t += 1000;
  assert.equal(w.record({ agentId: 'bob', tokens: 10_000, now: t }), null, '冷却期内不提示');
  t += 1000;
  assert.equal(w.record({ agentId: 'bob', tokens: 10_000, now: t }), null);
});

test('冷却期过后可以再提示', () => {
  const w = new UsageWatcher({ cooldownMs: 1000 });
  let t = 1_000_000;
  for (let i = 0; i < 4; i += 1) { w.record({ agentId: 'bob', tokens: 1000, now: t }); t += 100; }
  assert.ok(w.record({ agentId: 'bob', tokens: 10_000, now: t }));
  assert.ok(w.record({ agentId: 'bob', tokens: 10_000, now: t + 2000 }), '冷却期过了可以再提示');
});

test('★ 绝不拦截：只返回提示，不改任何状态', () => {
  const w = new UsageWatcher();
  let t = 1_000_000;
  for (let i = 0; i < 4; i += 1) { w.record({ agentId: 'bob', tokens: 1000, now: t }); t += 1000; }
  const before = w.byAgent.get('bob').length;
  const r = w.record({ agentId: 'bob', tokens: 999_999, now: t });
  assert.ok(r, '会提示');
  // 但没有任何"禁止继续"的信号——返回值里没有 blocking 之类的字段
  assert.equal(r.blocking, undefined);
  assert.ok(w.byAgent.get('bob').length > before, '记录照常写入，不受提示影响');
});

/* ---------- 房间累计 ---------- */

test('★ 房间累计激增时提示（单轮都不异常、但短时间连着来）', () => {
  const w = new UsageWatcher({ windowMs: 60_000, minSamples: 2, cooldownMs: 0, spikeRatio: 99 });
  const W = 60_000;
  let t = 1_000_000;

  // 前一个窗口（t-W*2 ~ t-W）：只有 1 轮 1000，节奏很慢
  w.record({ agentId: 'bob', tokens: 1000, now: t });
  t += W;                                  // 进入"最近窗口"的边界
  // 前窗口末尾再来一轮，确保 prev 窗口有基线
  w.record({ agentId: 'bob', tokens: 1000, now: t - 1 });
  t += 1;

  // 最近窗口内：连来 5 轮、每轮 1000。单轮都不异常，但累计是前窗口的 5 倍
  let surge = null;
  for (let i = 0; i < 5 && !surge; i += 1) {
    surge = w.record({ agentId: 'bob', tokens: 1000, now: t });
    t += 5_000;
  }
  assert.ok(surge, '短时间累计激增应提示');
  assert.equal(surge.kind, 'surge');
  assert.match(surge.text, /分钟累计/);
});

test('resetRoom 清空房间趋势（换话题时不延续）', () => {
  const w = new UsageWatcher();
  w.record({ agentId: 'bob', tokens: 1000, now: 1_000_000 });
  assert.equal(w.roomEvents.length, 1);
  w.resetRoom();
  assert.equal(w.roomEvents.length, 0);
});

test('snapshot 供界面显示基线', () => {
  const w = new UsageWatcher();
  for (let i = 0; i < 3; i += 1) w.record({ agentId: 'bob', tokens: 1000 + i, now: 1_000_000 + i });
  const s = w.snapshot('bob');
  assert.equal(s.samples, 3);
  assert.equal(s.median, 1001);
});

test('默认参数符合约定', () => {
  assert.equal(DEFAULTS.spikeRatio, 3);
  assert.ok(DEFAULTS.cooldownMs >= 60_000, '冷却期不能太短，否则就是刷屏');
});
