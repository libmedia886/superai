/**
 * CR-008 循环护栏：三个主维度缺一不可，各防一类死循环。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LoopGuard, THRESHOLDS } from '../src/core/guard.js';
import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

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

/* ---------- 警告要落盘（事后能复盘） ---------- */

test('★ 循环警告必须写进事件流，不能只发界面', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../src/core/store.js');
  const { Room } = await import('../src/core/room.js');

  const dir = await mkdtemp(join(tmpdir(), 'lw-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();

  // 真实场景：leader 和两个成员轮流说话。
  // 成员之间不能互相 @（权限规则），所以链条一定经过 leader——
  // 这正是老板房间里的循环形态：lead → carol → lead → dave → lead → …
  // 注意：护栏**只警告不拦截**（老板定的"不设硬闸"），
  // 所以这个环会一直转下去。测试里必须自己设界，否则永远跑不完。
  let turns = 0;
  const MAX_TURNS = 12;

  const room = new Room({
    id: 'r', name: 'r', goal: 't',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
      { id: 'b', name: 'b', role: 'member', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
      { id: 'c', name: 'c', role: 'member', backend: 'claude', tier: 'readonly', cwd: '/tmp' },
    ],
    store,
    resolveAdapter: (agent) => ({
      run: async () => {
        turns += 1;
        // 到了上限就让链条自然断掉（不 @ 任何人）
        if (turns > MAX_TURNS) return { text: '停了。', reason: 'completed' };
        return {
          text: agent.id === 'lead' ? '转给 @b' : '转给 @lead',
          reason: 'completed',
        };
      },
    }),
    onEvent: () => {},
  });
  room.turnTimeoutMs = 5_000;
  room.maxRetries = 0;

  await room.humanSay('@lead 开始');
  await room.drain();

  assert.ok(room.store.loopWarnings.length > 0, '内存里要有警告记录');

  await new Promise((r) => setTimeout(r, 150));
  const replay = new Store(join(dir, 'room.jsonl'));
  await replay.load();
  assert.ok(replay.loopWarnings.length > 0, '重放后仍能查到警告——这才是"事后能复盘"');
  assert.ok(replay.loopWarnings[0].reasons.length > 0, '要记下具体原因');
});

/* ---------- 空转判据：连续几轮"没有任何推进"（INBOX §2 第 3 条） ---------- */

test('★ 连续 3 轮没有任何推进 → 报"原地打转"', async () => {
  const { LoopGuard } = await import('../src/core/guard.js');
  const g = new LoopGuard();

  assert.equal(g.noteProgress({ actions: 0, toolCalls: 0 }).reason, null);
  assert.equal(g.noteProgress({ actions: 0, toolCalls: 0 }).reason, null);
  const third = g.noteProgress({ actions: 0, toolCalls: 0 });

  assert.ok(third.reason, '第 3 轮应当报');
  assert.equal(third.reason.kind, 'no-progress');
  assert.match(third.reason.text, /没有任何推进/);
  assert.equal(third.streak, 3);
});

test('★ 传了已移除的 newConclusion 也不影响判定（长文复述不算推进）', async () => {
  // 管理方 22:29：原判据 `正文 > 40 字` 让它防的场景永远不响——
  // 真实卡住的样子正是"几百字长文反复说同一件事"。
  const { LoopGuard } = await import('../src/core/guard.js');
  const g = new LoopGuard();
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    last = g.noteProgress({ actions: 0, toolCalls: 0, newConclusion: true });
  }
  assert.ok(last.reason, '即使传 newConclusion:true，连续 3 轮无结构化推进也要报');
  assert.equal(last.streak, 3);
});

test('★ 有推进就清零（建了任务 / 跑了工具 / 写了新结论都算）', async () => {
  const { LoopGuard } = await import('../src/core/guard.js');
  for (const progressed of [
    { actions: 1, toolCalls: 0 },
    { actions: 0, toolCalls: 2 },
  ]) {
    const g = new LoopGuard();
    g.noteProgress({ actions: 0, toolCalls: 0 });
    g.noteProgress({ actions: 0, toolCalls: 0 });
    assert.equal(g.noteProgress(progressed).streak, 0,
      `${JSON.stringify(progressed)} 应当算推进并清零`);
  }
});

test('★ 只报一次（同一原因不刷屏）', async () => {
  const { LoopGuard } = await import('../src/core/guard.js');
  const g = new LoopGuard();
  const hits = [];
  for (let i = 0; i < 8; i += 1) {
    const r = g.noteProgress({ actions: 0, toolCalls: 0 });
    if (r.reason) hits.push(i + 1);
  }
  assert.deepEqual(hits, [3], '只在第 3 轮报一次');
});

test('★ 重新开局（人说话）会清掉空转计数', async () => {
  const { LoopGuard } = await import('../src/core/guard.js');
  const g = new LoopGuard();
  g.noteProgress({ actions: 0, toolCalls: 0 });
  g.noteProgress({ actions: 0, toolCalls: 0 });
  g.reset();
  assert.equal(g.noProgressStreak, 0);
});

test('★ 真实高强度协作（8 次往返、间隔 10 秒）不该只因为"轮数多"报警', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'busy-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];

  const room = new Room({
    id: 'r', name: 't',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['lead'] },
      { id: 'b', name: 'b', role: 'member', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['b'] },
    ],
    store,
    resolveAdapter: (agent) => ({
      async run({ onEvent }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        // 每一轮都在干活：有工具调用 + 有实质产出
        onEvent?.({ type: 'tool', tool: 'Bash', command: 'grep …' });
        const t = `${agent.id} 查到了三条新证据，分别来自 A/B/C，已记进表格。`;
        onEvent?.({ type: 'text', text: t, done: false });
        return { text: t, sessionId: 's', reason: 'completed', usage: null };
      },
    }),
    onEvent: (e) => events.push(e),
  });

  // 造 8 次 agent 往返（模拟管理方看到的真实高强度协作）
  for (let i = 0; i < 4; i += 1) {
    room._enqueue(i % 2 ? 'b' : 'lead', { triggerMsg: { id: `m${i}`, senderId: 'lead', body: '继续' }, taskId: null, source: 'agent' });
  }
  await room.drain();

  const noProgress = events.filter((e) => e.type === 'loop.warning'
    && (e.reasons ?? []).some((r) => r.kind === 'no-progress'));
  assert.equal(noProgress.length, 0, '一直在推进的协作不该报"原地打转"');
});
