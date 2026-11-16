/**
 * 真机验证「改完立即生效，不用重启」对**每一项**设置都成立。
 *
 *   node scripts/settings-live-e2e.mjs [--skip-llm]
 *
 * 为什么要这个脚本：使用说明里写了「改完立即生效，不用重启」。
 * 如果只有档位成立、其余要重启，那句话就是假的——而"文档说能、实际不能"
 * 和"界面说能、实际不能"是同一类问题。
 *
 * 分两层验：
 *   A. 机制层（不需要真模型）：改设置 → 同一个 Room 实例 → 下一轮 adapter
 *      收到的参数里就是新值。覆盖 档位 / 模型 / 思考等级 / 命令白名单 /
 *      单轮上限 / 成员级上限。
 *   B. 行为层（需要真 CLI）：改命令白名单 → 不重启 → 下一轮 curl 真的能跑。
 *
 * `--skip-llm` 跳过 B，只跑 A（CI 里没网络时用）。
 */

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../src/server.js';

const skipLlm = process.argv.includes('--skip-llm');
const ok = (c) => (c ? '✅' : '❌');
let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${ok(cond)} ${label}${!cond && extra ? `（${extra}）` : ''}`);
  if (!cond) failed += 1;
};

const post = async (url, path, body) => {
  const res = await fetch(url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const dir = await mkdtemp(join(tmpdir(), 'settings-live-'));
const roomId = 'r-live';
await mkdir(join(dir, 'rooms', roomId, 'agents', 'dev'), { recursive: true });
await writeFile(join(dir, 'rooms', roomId, 'room.json'), JSON.stringify({
  name: '设置实测', goal: '', registry: [],
  members: [{ id: 'dev', name: 'dev', role: 'leader', backend: 'claude', tier: 'readonly' }],
}, null, 2));
await writeFile(join(dir, 'rooms.json'), JSON.stringify({
  version: 1, activeRoomId: roomId,
  rooms: [{ id: roomId, name: '设置实测', createdAt: new Date().toISOString() }],
}));

const { server, url, manager } = await startServer({ port: 0, dataDir: dir });
const room = () => manager.session.room;
const agent = () => room().members.find((m) => m.id === 'dev');

/**
 * 让下一轮跑一次，捕获 adapter 实际收到的参数。
 *
 * ★ 这一层**不调真模型**：包一层假 run 就行。
 * 要验的是"改完设置后，下一轮构造出的参数变没变"，
 * 与模型说什么无关；真模型会让这一步变成分钟级的网络等待。
 */
async function captureNextRun({ text = '好' } = {}) {
  const seen = {};
  const orig = room().resolveAdapter;
  room().resolveAdapter = (a) => {
    const real = orig(a);
    return {
      backend: real.backend,
      config: real.config,
      // 用真实适配器的参数构造，但不跑进程
      buildArgs: real.buildArgs ? real.buildArgs.bind(real) : null,
      async run(input) {
        seen.agent = a;
        seen.args = real.buildArgs ? real.buildArgs({ sessionId: input.sessionId }) : null;
        seen.timeoutMs = input.timeoutMs;
        seen.config = { ...real.config };
        input.onEvent?.({ type: 'meta', sessionId: 'stub' });
        return { text: '好', sessionId: 'stub', reason: 'completed', usage: null };
      },
    };
  };
  await room().humanSay(`@dev ${text}`);
  await room().drain();
  room().resolveAdapter = orig;
  return seen;
}

console.log('=== A. 机制层：改完不重启，下一轮参数就是新值 ===');

/* --- 档位 --- */
let r = await post(url, '/api/member/update', { id: 'dev', patch: { tier: 'read' } });
check(r.status === 200, '改档位成功', r.data.error);
let seen = await captureNextRun();
check(seen.config?.tier === 'read', `下一轮读到的档位是 read（实际 ${seen.config?.tier}）`);
check((seen.args ?? []).join(' ').includes('Read,Grep,Glob'), '命令行里出现 read 档参数');

/* --- 模型 + 思考等级 --- */
r = await post(url, '/api/member/update', { id: 'dev', patch: { model: 'opus', effort: 'high' } });
check(r.status === 200, '改模型/思考等级成功', r.data.error);
seen = await captureNextRun();
const argsText = (seen.args ?? []).join(' ');
check(/--model opus/.test(argsText), `命令行带模型（${argsText.slice(0, 80)}…）`);
check(/--effort high/.test(argsText), '命令行带思考等级');

/* --- 清空：一个参数都不传 --- */
r = await post(url, '/api/member/update', { id: 'dev', patch: { model: '', effort: '' } });
seen = await captureNextRun();
const cleared = (seen.args ?? []).join(' ');
check(r.status === 200 && !/--model/.test(cleared) && !/--effort/.test(cleared),
  '留空后命令行里一个模型/等级参数都没有');

/* --- 命令白名单 --- */
r = await post(url, '/api/member/update', {
  id: 'dev', patch: { tier: 'write-exec', allowedCommands: 'curl' },
});
check(r.status === 200, '改命令白名单成功', r.data.error);
seen = await captureNextRun();
const withCmd = (seen.args ?? []).join(' ');
check(withCmd.includes('Bash(curl:*)'), `命令行带白名单授权（${withCmd.slice(0, 90)}…）`);

/* --- 单轮上限（房间级 + 成员级） --- */
r = await post(url, '/api/room-settings', { turnTimeoutMinutes: 7 });
check(r.status === 200, '改房间级单轮上限成功');
check(room().turnTimeoutMs === 7 * 60_000, '同一实例立刻是新值（不等重启）');
seen = await captureNextRun();
check(seen.timeoutMs === 7 * 60_000, `下一轮 adapter 收到 7 分钟（实际 ${seen.timeoutMs}）`);

r = await post(url, '/api/member/update', { id: 'dev', patch: { timeoutMinutes: '3' } });
check(r.status === 200, '改成员级上限成功');
seen = await captureNextRun();
check(seen.timeoutMs === 3 * 60_000, '成员级优先，下一轮收到 3 分钟');

/* --- 落盘：重启后仍是新值 --- */
const cfg = JSON.parse(await readFile(join(dir, 'rooms', roomId, 'room.json'), 'utf8'));
const saved = cfg.members.find((m) => m.id === 'dev');
check(saved.tier === 'write-exec' && saved.model == null && saved.timeoutMinutes === 3,
  '全部落盘到 room.json（重启后不会回退）');

if (!skipLlm) {
  console.log('\n=== B. 行为层：不重启改白名单 → 下一轮命令真的能跑 ===');

  /**
   * ★ A 层用假 run 跑过，它写了一个假 sessionId（'stub'）。
   * 真 CLI 拿它去 --resume 会挂/空产出。所以这里先清掉会话——
   * 清会话不影响"不重启改白名单"这个论点，它是另一条独立的设置路径。
   */
  const devA = manager.session.room.members.find((m) => m.id === 'dev');
  devA.sessionId = null;
  manager.session.room._sessions?.delete('dev');   // _sessionFor 有缓存，也要清

  /**
   * 等这一轮说完。
   *
   * ★ 不能只等 `!busy && !pending`：POST 返回时房间还没开始跑，
   * 第一次健康检查必然"空闲"，于是立刻返回、读到的还是上一条消息。
   * 正确做法是等**新消息出现**。
   */
  const askReal = async (prompt) => {
    const count = async () => {
      const raw = await readFile(join(dir, 'rooms', roomId, 'room.jsonl'), 'utf8').catch(() => '');
      return raw.split('\n').filter(Boolean).length;
    };
    const before = await count();
    await post(url, '/api/say', { text: `@dev ${prompt}` });

    const deadline = Date.now() + 200_000;
    let started = false;
    while (Date.now() < deadline) {
      const h = await (await fetch(`${url}/api/health`)).json();
      if (h.busy || h.pending) started = true;
      if (started && !h.busy && !h.pending) return true;
      await new Promise((res) => setTimeout(res, 500));
    }
    return false;
  };

  /** 读最近一条 agent 发言，判断它说 RAN 还是 DENIED */
  const lastAgentBody = async () => {
    const raw = await readFile(join(dir, 'rooms', roomId, 'room.jsonl'), 'utf8').catch(() => '');
    const msgs = raw.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e?.kind === 'message' && e.message?.senderId === 'dev');
    return String(msgs[msgs.length - 1]?.message?.body ?? '');
  };

  const ASK = '运行命令 curl -s -o /dev/null -w "%{http_code}" https://example.com。'
    + '能运行就只回答 RAN，被拒绝只回答 DENIED。';

  // ① 清空白名单：应当跑不了
  await post(url, '/api/member/update', { id: 'dev', patch: { tier: 'write-exec', allowedCommands: '' } });
  const ok1 = await askReal(ASK);
  check(ok1, '第一轮（无白名单）跑完了');
  const denied = await lastAgentBody();
  console.log(`   第一轮正文：${JSON.stringify(denied.slice(0, 160))}`);
  check(/DENIED|拒绝|没有权限|无法/i.test(denied) && !/RAN/.test(denied),
    '无白名单：它如实说跑不了', denied.slice(0, 100));

  // ② 不重启，直接开 curl
  await post(url, '/api/member/update', { id: 'dev', patch: { allowedCommands: 'curl' } });
  const mem = manager.session.room.members.find((m) => m.id === 'dev');
  check(mem.allowedCommands?.[0] === 'curl', '内存里立刻是新白名单（没有重建 Room）');

  const ok2 = await askReal(ASK);
  check(ok2, '第二轮（有白名单）跑完了');
  const allowed = await lastAgentBody();
  check(/RAN/.test(allowed), '★ 不重启：白名单一开，下一轮 curl 真的跑了', allowed.slice(0, 100));
}

server.close();
console.log(`\n${failed ? `❌ ${failed} 项失败` : '✅ 全部通过'}`);
process.exit(failed ? 1 : 0);
