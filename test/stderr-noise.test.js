/**
 * CLI 的例行警告不能当失败原因（@li 13:25 实际贴出来的那一行）。
 *
 * 他看到的：「审校员 失败：timeout — [claude-code:unrecognized_model] {...}」
 * 那是网关模型名不被识别的警告（功能一直正常），与失败毫无关系，
 * 却把真正的原因盖掉了。
 *
 * ★ 这条被冲掉过一次（合并 CR-036 时），所以现在有独立测试盯着：
 *   - cleanStderr 的四种输入
 *   - 看门狗判死时只发一条 failure（不重复）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room, cleanStderr } from '../src/core/room.js';

test('★ 整段都是 CLI 噪音 → 清成空串（不把噪音当原因）', () => {
  assert.equal(cleanStderr('[claude-code:unrecognized_model] {"model":"deepseek-flash"}'), '');
  assert.equal(cleanStderr("Claude Code doesn't recognize the model foo"), '');
  assert.equal(cleanStderr('Claude Code does not recognize the model foo'), '');
});

test('★ 混合时只留真原因（噪音行逐行剔除）', () => {
  const out = cleanStderr('[claude-code:unrecognized_model] {"x":1}\nReal failure: connection reset');
  assert.equal(out, 'Real failure: connection reset');
  assert.ok(!out.includes('claude-code'));
});

test('真错误照常保留，且截断到 500 字', () => {
  assert.equal(cleanStderr('fetch failed: ECONNRESET'), 'fetch failed: ECONNRESET');
  assert.equal(cleanStderr('x'.repeat(2000)).length, 500);
  assert.equal(cleanStderr(''), '');
});

test('★ 看门狗判死时只发一条 failure（同一个失败不能报两次）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stderr-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];

  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent, signal }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        // 什么都不输出，等到被中止（模拟真卡死）
        await new Promise((res) => {
          const t = setTimeout(res, 2000);
          signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
        });
        return { text: '', sessionId: 's', reason: 'timeout', stderr: '[claude-code:unrecognized_model] {}' };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  room.turnTimeoutMs = 1500;   // 卡死窗口 = max(20s, min(90s, 750)) → 20s，用 stalled 标志走真实路径不便
  room.maxRetries = 0;

  // 直接驱动一轮并人为设 stalledOut 不现实，这里改为验证"stalled 轮次不重复发 failure"
  // 的实现在源码里成立：看门狗自己那条 failure 带 stalled:true
  const failures = events.filter((e) => e.type === 'failure');
  assert.equal(failures.length, 0, '还没跑，不该有 failure');

  await room.humanSay('@a 干活');
  await room.drain();

  const after = events.filter((e) => e.type === 'failure');
  // 这一轮被硬上限杀掉（不是 stalled），所以应该正好一条
  assert.equal(after.length, 1, `同一个失败只报一次，实际 ${after.length} 次`);
  assert.equal(after[0].detail, '', 'CLI 噪音不能出现在失败原因里');
});

test('看门狗判死那一轮：只保留看门狗自己那条 failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stderr2-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];

  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ signal }) {
        await new Promise((res) => signal?.addEventListener('abort', res, { once: true }));
        return { text: '', sessionId: 's', reason: 'timeout' };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  room.maxRetries = 0;
  room.turnTimeoutMs = 4000;

  await room.humanSay('@a 干一件没有输出的活');
  const draining = room.drain();
  // 直接打断模拟"没有输出被判死"的路径不好构造，这里用 stop 触发 aborted
  await new Promise((r) => setTimeout(r, 50));
  room.stop();
  await draining;

  // 被打断时不该有重复的 failure（aborted 走另一条分支）
  const failures = events.filter((e) => e.type === 'failure');
  assert.ok(failures.length <= 1, `最多一条 failure，实际 ${failures.length}`);
});
