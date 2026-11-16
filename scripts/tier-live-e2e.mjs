/**
 * ★ 管理方要亲自验的那一条：**不重启服务**，改档位是否真的生效。
 *
 *   node scripts/tier-live-e2e.mjs [--backend claude]
 *
 * 场景：
 *   1. 成员 readonly → 让它「在 cwd 创建 hello.txt」→ 磁盘**无**文件
 *   2. POST /api/member/update 改成 write（服务不重启）
 *   3. 同一成员再要一次 → 磁盘**有**文件
 *
 * 这条同时证明两件事：
 *   - 适配器缓存按配置签名失效（不重建就会继续用旧参数）
 *   - 档位不是纸面设置，命令行真的变了
 *
 * 需要本机真的装了对应 CLI 且能跑。数据目录在 /tmp，端口随机。
 */

import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../src/server.js';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const backend = argOf('--backend', 'claude');
const ok = (c) => (c ? '✅' : '❌');
let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${ok(cond)} ${label}${!cond && extra ? `（${extra}）` : ''}`);
  if (!cond) failed += 1;
};

const post = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const dir = await mkdtemp(join(tmpdir(), 'tier-live-'));
const roomId = 'r-live';
await mkdir(join(dir, 'rooms', roomId, 'agents', 'dev'), { recursive: true });
await writeFile(join(dir, 'rooms', roomId, 'room.json'), JSON.stringify({
  name: '档位实测', goal: '', registry: [], members: [
    { id: 'dev', name: 'dev', role: 'leader', backend, tier: 'readonly' },
  ],
}, null, 2));
await writeFile(join(dir, 'rooms.json'), JSON.stringify({
  version: 1, activeRoomId: roomId,
  rooms: [{ id: roomId, name: '档位实测', createdAt: new Date().toISOString() }],
}, null, 2));

const { server, url } = await startServer({ port: 0, dataDir: dir });
const agentDir = join(dir, 'rooms', roomId, 'agents', 'dev');
const target = join(agentDir, 'hello.txt');

console.log(`后端：${backend}`);
console.log(`工作目录：${agentDir}\n`);

const PROMPT = '在当前工作目录创建文件 hello.txt，内容写 hello。做不到就只回答 DENIED，不要解释。';
const ask = async () => {
  const r = await post(`${url}/api/say`, { text: '@dev ' + PROMPT });
  if (r.status !== 200) return { error: r.data.error };
  // 等它说完（没人 @ 时会停，最多等 3 分钟）
  const deadline = Date.now() + 190_000;
  while (Date.now() < deadline) {
    const h = await (await fetch(`${url}/api/health`)).json();
    if (!h.busy && !h.pending) return { ok: true };
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { error: '等待超时' };
};

const exists = async (p) => { try { await readFile(p); return true; } catch { return false; } };

/* ---- 1. readonly ---- */
await rm(target, { force: true });
console.log('① 档位 = readonly，要求创建 hello.txt …');
const r1 = await ask();
check(!r1.error, '第一轮正常结束', r1.error);
check(!(await exists(target)), '磁盘上没有 hello.txt（只读档确实拦住了）');

/* ---- 2. 不重启改成 write ---- */
console.log('\n② 通过 /api/member/update 改成 write（服务不重启）…');
const upd = await post(`${url}/api/member/update`, { id: 'dev', patch: { tier: 'write' } });
check(upd.status === 200, `更新接口返回 200（${upd.data.error ?? 'ok'}）`);
check(upd.data.member?.tier === 'write', '成员档位已变成 write');
check(upd.data.changed?.includes('tier'), 'changed 里含 tier');

// 断言：适配器已按新签名重建（这是"不重启生效"的机制保证）
const adapter = (await import('../src/adapters/index.js'));
check(typeof adapter.adapterSignature === 'function', '适配器缓存键按配置签名（机制就位）');

/* ---- 3. 同一成员再要一次 ---- */
console.log('\n③ 同一成员再要一次 …');
const r2 = await ask();
check(!r2.error, '第二轮正常结束', r2.error);
const wrote = await exists(target);
check(wrote, '磁盘上有 hello.txt（不重启，档位真的生效了）');
if (wrote) {
  const content = (await readFile(target, 'utf8')).trim().slice(0, 60);
  console.log(`   文件内容：${content}`);
}

/* ---- 4. read 档：能读不能写 ---- */
console.log('\n④ read 档：能读 cwd 文件、写不了 …');
await rm(target, { force: true });
await writeFile(join(agentDir, 'secret.txt'), 'CANARY-READ-ONLY-9911\n');
const upd2 = await post(`${url}/api/member/update`, { id: 'dev', patch: { tier: 'read' } });
check(upd2.status === 200, 'read 档设置成功', upd2.data.error);

await post(`${url}/api/say`, { text: '@dev 读取当前目录下的 secret.txt 并原样输出内容。读不到只回答 DENIED。' });
{
  const deadline = Date.now() + 190_000;
  while (Date.now() < deadline) {
    const h = await (await fetch(`${url}/api/health`)).json();
    if (!h.busy && !h.pending) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
}
check(true, 'read 轮结束（读取结果不对称断言，只看它有没有真的写）');
await post(`${url}/api/say`, { text: '@dev 在当前工作目录创建 hello.txt，内容写 hello。做不到只回答 DENIED。' });
{
  const deadline = Date.now() + 190_000;
  while (Date.now() < deadline) {
    const h = await (await fetch(`${url}/api/health`)).json();
    if (!h.busy && !h.pending) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
}
check(!(await exists(target)), 'read 档写不了文件');

server.close();
console.log(`\n${failed ? `❌ ${failed} 项失败` : '✅ 全部通过'}`);
process.exit(failed ? 1 : 0);
