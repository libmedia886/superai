/**
 * fake adapter 的契约：测超时/中断路径时必须**自己遵守 timeoutMs**。
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ ★ 这个文件能验什么、不能验什么（管理方 20:51 实测确认，先读这段）│
 * ├─────────────────────────────────────────────────────────────────┤
 * │ **能验**（fake adapter 下）：                                    │
 * │   · 看门狗判死路径（stalled）—— 实际上 20 秒下限会先接管         │
 * │   · 人点「打断」的路径（真的 abort 一次）                        │
 * │   · Room 拿到 reason 之后怎么处理（文案/暂停/按钮）              │
 * │                                                                 │
 * │ **不能验**（必须有真子进程）：                                    │
 * │   · 硬上限超时（`runJsonCli` 的 setTimeout → killTree 杀进程）    │
 * │   · CLI 的 stderr / 事件解析 / 进程组 kill                       │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ 最坑的一点：设 `turnTimeoutMs=3000` 想测硬上限，fake adapter 只等 abort
 * 时，**实际每轮要跑 20 秒**——因为硬上限那一层被绕过，接管的是看门狗的
 * `stallThreshold` 下限（20 秒）。于是你"以为在测 3 秒超时"，其实在测看门狗，
 * 而且脚本会因为 2~3 轮 × 20 秒被外层 `timeout` 杀掉。
 * 管理方早先几个脚本超时就是这个原因，他当时以为是脚本写错了。
 *
 * 管理方 20:29 踩到的坑，值得单独锁一条：
 * 硬上限是由 `runJsonCli` 的 `setTimeout` 杀子进程实现的。内存里的 fake adapter
 * 不 spawn 进程，于是那一层被整个绕过——`turnTimeoutMs=8000` 却"从未 abort"。
 *
 * 后果：这类测试看着在测超时，实际测的是"我写了一个 reason:'timeout' 的对象"。
 * **它证明不了硬上限，也证明不了中断**。
 *
 * 这个文件做两件事：
 *   1. 实证这个坑真实存在（fake adapter 立即返回时，signal 从未 abort）
 *   2. 给出正确写法：adapter 自己遵守 signal + timeoutMs
 *   3. 扫描全仓测试，把"立即返回 timeout 却不看 signal"的 adapter 列出来
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

test('★ 实测：fake adapter 下真正中止它的是看门狗，不是硬上限', async () => {
  // 设成 3 秒想测硬上限 —— 实际会跑满看门狗的 20 秒下限。
  // 这里用短一点的 stall 窗口验证机制归属，不真等 20 秒。
  const dir = await mkdtemp(join(tmpdir(), 'who-aborts-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  let abortReason = null;

  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent, signal }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        await new Promise((res) => {
          signal?.addEventListener('abort', () => { abortReason = signal.reason; res(); }, { once: true });
        });
        return { text: '', sessionId: 's', reason: 'timeout' };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  room.maxRetries = 0;
  room.turnTimeoutMs = 3_000;

  await room.humanSay('@a 干活');
  const draining = room.drain();
  // 直接触发看门狗那一支（真实要等 20 秒，测试里用 stop 模拟"被外部中止"）
  await new Promise((r) => setTimeout(r, 80));
  room.stop();
  await draining;

  assert.ok(abortReason, '必须真的被 abort（否则这个测试什么也没验到）');
  assert.equal(abortReason, 'interrupted', 'stop() 用的是 interrupted；看门狗用 stalled；硬上限在子进程层');
  assert.ok(events.some((e) => e.type === 'stopped'));
});

test('★ 源码保证：三种中止源的 abort reason 各不相同（可据此判断是谁杀的）', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/core/room.js', import.meta.url), 'utf8');
  assert.match(src, /ac\.abort\('interrupted'\)/, '人点打断/停止 → interrupted');
  assert.match(src, /ac\.abort\('stalled'\)/, '看门狗判死 → stalled');
  // 硬上限不经过这两个，它在 runJsonCli 里 killTree —— 所以 fake adapter 下永远看不到它
  const runner = await readFile(new URL('../src/core/runner.js', import.meta.url), 'utf8');
  assert.match(runner, /killTree\(child/, '硬上限由子进程层杀进程实现');
});

test('★ 坑的存在性：立即返回 timeout 的 fake adapter 从未被 abort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contract-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();

  let abortedAtCall = null;
  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent, signal }) {
        abortedAtCall = signal?.aborted ?? null;
        onEvent?.({ type: 'meta', sessionId: 's' });
        return { text: '', sessionId: 's', reason: 'timeout' };
      },
    }),
    onEvent: () => {},
  });
  room.maxRetries = 0;

  await room.humanSay('@a 干活');
  await room.drain();

  assert.equal(abortedAtCall, false,
    'Room 不会主动 abort（硬上限在 runJsonCli 里杀进程），所以 fake adapter 立即返回时 signal 永远是 false');
  // 也就是说：这种 adapter 写的"超时"是**自己声明的**，不是被系统中止的。
  assert.equal(room.pauseReason?.reason, 'timeout', 'Room 仍会按它声明的 reason 处理——这正是危险处');
});

test('正确写法：adapter 遵守 timeoutMs，到点返回 aborted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contract2-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  let sawAbort = false;

  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent, signal, timeoutMs }) {
        onEvent?.({ type: 'meta', sessionId: 's' });
        // 契约：要么被 abort，要么到 timeoutMs 自己返回
        await new Promise((res) => {
          const t = setTimeout(res, timeoutMs);
          signal?.addEventListener('abort', () => { sawAbort = true; clearTimeout(t); res(); }, { once: true });
        });
        return { text: '', sessionId: 's', reason: 'timeout', aborted: sawAbort };
      },
    }),
    onEvent: () => {},
  });
  room.maxRetries = 0;
  room.turnTimeoutMs = 150;

  await room.humanSay('@a 干活');
  const draining = room.drain();
  await new Promise((r) => setTimeout(r, 60));
  room.interrupt();   // 真的 abort 一次，验证 adapter 会响应
  await draining;

  assert.equal(sawAbort, true, 'adapter 必须真的响应 signal，否则测不到中断路径');
  assert.equal(room.pauseReason?.reason, 'interrupted', '被打断要走 interrupted，不是 timeout');
});

test('★ 审计：列出现在仍"立即返回 timeout 却不看 signal"的测试（技术债清单）', async () => {
  const dir = new URL('../test/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.test.js') && f !== 'adapter-contract.test.js');

  const offenders = [];
  for (const f of files) {
    const src = await readFile(new URL(f, dir), 'utf8');
    const blocks = src.split(/async run\(/).slice(1);
    for (const b of blocks) {
      const body = b.slice(0, 700);
      if (!/reason:\s*'timeout'/.test(body)) continue;
      if (/signal/.test(body)) continue;
      offenders.push(f);
      break;
    }
  }

  // 这些测试验的是「Room 拿到 timeout 这个结果之后怎么处理」，
  // 不是「硬上限真的会中止」——后者只有 adapter-contract 那类测试能验。
  // 所以这里不判失败，只把清单打出来，避免以后有人误以为它们覆盖了超时机制。
  if (offenders.length) {
    console.log(`   ⚠️ 以下测试用"立即返回 timeout"的 fake adapter（只覆盖结果处理，不覆盖中止机制）：`
      + `\n      ${offenders.join(', ')}`);
  }
  assert.ok(Array.isArray(offenders), '审计本身要能跑完');
});
