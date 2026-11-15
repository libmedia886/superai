/**
 * 中断必须真的杀死子进程。
 *
 * 这是本轮最该验的一条：只 resolve/reject Promise 而不杀进程，
 * 子进程会变孤儿——继续跑、继续占额度、继续可能有副作用，
 * 而界面上已经显示"已停止"。用户完全不知道后面还在烧钱。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { runJsonCli } from '../src/core/runner.js';

const exec = promisify(execFile);

/**
 * 生成一个会长时间睡眠的 node 子进程命令，并把自己 pid 写进文件。
 * 注意 `node -e script a b` 的 argv 是 [node, a, b]——从 1 开始，不是 2。
 */
function sleeperScript() {
  return [
    'const fs=require("fs");',
    'fs.writeFileSync(process.argv[1], String(process.pid));',
    'setTimeout(()=>{fs.writeFileSync(process.argv[2],"finished")}, 600000);',
  ].join('');
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('★ abort 真的杀死子进程（不留孤儿）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abort-'));
  const pidFile = join(dir, 'pid');
  const doneFile = join(dir, 'done');

  const ac = new AbortController();

  const run = runJsonCli({
    command: process.execPath,
    args: ['-e', sleeperScript(), pidFile, doneFile],
    cwd: dir,
    prompt: '',
    timeoutMs: 60_000,
    signal: ac.signal,
  });

  // 等子进程写好自己的 pid
  for (let i = 0; i < 100; i += 1) {
    try {
      await exec('cat', [pidFile]);
      break;
    } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  const { stdout } = await exec('cat', [pidFile]);
  const pid = Number(stdout.trim());
  assert.ok(pid > 0, '子进程应已启动');
  assert.equal(isAlive(pid), true, '中断前进程应该活着');

  ac.abort('interrupted');
  const result = await run;

  assert.equal(result.aborted, 'interrupted', '结果里要标明是被中断的');
  assert.equal(result.timedOut, false, '中断不是超时');

  // 给内核一点时间回收
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(isAlive(pid), false, '中断后子进程必须已死，不能留孤儿');
});

test('超时也会杀死子进程', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timeout-'));
  const pidFile = join(dir, 'pid');
  const doneFile = join(dir, 'done');

  const run = runJsonCli({
    command: process.execPath,
    args: ['-e', sleeperScript(), pidFile, doneFile],
    cwd: dir,
    prompt: '',
    timeoutMs: 1500,
  });

  for (let i = 0; i < 100; i += 1) {
    try { await exec('cat', [pidFile]); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  const { stdout } = await exec('cat', [pidFile]);
  const pid = Number(stdout.trim());

  const result = await run;
  assert.equal(result.timedOut, true);

  await new Promise((r) => setTimeout(r, 500));
  assert.equal(isAlive(pid), false, '超时后子进程必须已死');
});

test('已 abort 的 signal 立即生效（不会先启动再杀）', async () => {
  const ac = new AbortController();
  ac.abort('pre-aborted');

  const dir = await mkdtemp(join(tmpdir(), 'pre-'));
  const result = await runJsonCli({
    command: process.execPath,
    args: ['-e', 'setTimeout(()=>{}, 60000)'],
    cwd: dir,
    prompt: '',
    timeoutMs: 60_000,
    signal: ac.signal,
  });

  assert.equal(result.aborted, 'pre-aborted');
});

test('正常结束不受 signal 影响', async () => {
  const ac = new AbortController();
  const dir = await mkdtemp(join(tmpdir(), 'ok-'));

  const result = await runJsonCli({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({type:"ok"})+"\\n")'],
    cwd: dir,
    prompt: '',
    timeoutMs: 30_000,
    signal: ac.signal,
  });

  assert.equal(result.aborted, null, '正常结束不该标记为中断');
  assert.equal(result.code, 0);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].type, 'ok');
});
