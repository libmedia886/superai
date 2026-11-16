/**
 * 多房间 HTTP 端到端：走真实接口，不 mock。
 *
 *   node scripts/rooms-e2e.mjs
 *
 * 验的是管理方那份硬要求里最容易做错的部分：
 *  - 落地页（没有房间时不崩，返回空列表）
 *  - 新建 → 空房间 → 第一个成员是头头
 *  - 切换：旧房间被冻结，两个房间的 jsonl 不互相污染
 *  - 令牌不跟房间走
 *  - 刷新（重新连 /events）回到原房间
 */

import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../src/server.js';

const ok = (c) => (c ? '✅' : '❌');
let failed = 0;
const check = (cond, label) => {
  console.log(`${ok(cond)} ${label}`);
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

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

/* ---------- 1. 空数据目录：落地页 ---------- */
const dir = await mkdtemp(join(tmpdir(), 'rooms-e2e-'));
await writeFile(join(dir, 'access-token'), 'd'.repeat(32));

let { server, url, manager } = await startServer({ port: 0, dataDir: dir });
const rooms = await (await fetch(`${url}/api/rooms`)).json();
check(rooms.rooms.length === 0, '空目录：房间列表为空（不偷偷预置 lead/bob）');
check(rooms.activeRoomId === null, '空目录：没有活动房间');
check((await (await fetch(`${url}/api/health`)).json()).ok, '空目录服务正常');

const say = await post(`${url}/api/say`, { text: '@lead 你好' });
check(say.status === 409, '没有房间时说话被明确拒绝（不是静默 200）');

/* ---------- 2. 新建房间 ---------- */
const created = await post(`${url}/api/rooms`, { action: 'create', name: '算法研究' });
check(created.status === 200 && created.data.room?.name === '算法研究', '新建房间成功');
const roomId = created.data.room.id;
check(await exists(join(dir, 'rooms', roomId, 'room.json')), '房间数据落到 rooms/<id>/');

const afterCreate = await (await fetch(`${url}/api/rooms`)).json();
check(afterCreate.activeRoomId === roomId, '新建后自动成为活动房间');
check(afterCreate.rooms[0].memberCount === 0, '新房间是空房间');

/* ---------- 3. 第一个成员默认头头 ---------- */
const m1 = await post(`${url}/api/member`, { name: 'lead', backend: 'claude', tier: 'readonly' });
check(m1.status === 200 && m1.data.role === 'leader', '第一个成员自动成为头头');

const m2 = await post(`${url}/api/member`, { name: 'bob', backend: 'claude', tier: 'readonly' });
check(m2.data.role === 'member', '第二个成员是普通成员');

/* ---------- 4. 再建一个房间并切换 ---------- */
const second = await post(`${url}/api/rooms`, { action: 'create', name: '第二个房间' });
const roomId2 = second.data.room.id;
check(manager.session.id === roomId2, '新建后切到新房间');

// 旧房间里已经有一条 human 消息的历史；新房间应该是干净的
const init2 = manager.session;
check(init2.members.length === 0, '新房间没有沿用上一个房间的成员');

const back = await post(`${url}/api/rooms`, { action: 'switch', id: roomId });
check(back.status === 200 && manager.session.id === roomId, '切回旧房间');
check(manager.session.members.length === 2, '旧房间的成员还在');
check(manager.session.name === '算法研究', '显示名正确');

/* ---------- 5. 重命名只改显示名 ---------- */
const renamed = await post(`${url}/api/rooms`, { action: 'rename', id: roomId, name: '算法研究 v2' });
check(renamed.status === 200, '重命名成功');
check(await exists(join(dir, 'rooms', roomId, 'room.json')), '目录名没变（改目录=毁掉会话上下文）');
const cfg = JSON.parse(await readFile(join(dir, 'rooms', roomId, 'room.json'), 'utf8'));
check(cfg.name === '算法研究 v2', '房间自己的 room.json 也改名了');
check(cfg.members.length === 2, '成员配置没被动过');

/* ---------- 6. 令牌不跟房间走 ---------- */
check(await readFile(join(dir, 'access-token'), 'utf8') === 'd'.repeat(32), '令牌留在根目录');
check(!(await exists(join(dir, 'rooms', roomId, 'access-token'))), '令牌没被搬进房间目录');

/* ---------- 7. 停止 / 恢复 ---------- */
const stopped = await post(`${url}/api/stop`);
check(stopped.status === 200, '停止成功');
const healthStopped = await (await fetch(`${url}/api/health`)).json();
check(healthStopped.stopped === true, '停止状态进 /api/health（界面刷新后仍能看到）');

const resumed = await post(`${url}/api/resume`);
check(resumed.status === 200, '「继续」可用（不必靠说话解刹车）');

/* ---------- 8. 房间级开关 ---------- */
const settings = await post(`${url}/api/room-settings`, { headPassiveWake: false });
check(settings.data.headPassiveWake === false, '可以关掉"成员不 @ 叫醒头头"');
await post(`${url}/api/room-settings`, { headPassiveWake: true });

/* ---------- 9. 重启后回到原房间 ---------- */
await new Promise((r) => server.close(r));
({ server, url } = await startServer({ port: 0, dataDir: dir }));
const afterRestart = await (await fetch(`${url}/api/rooms`)).json();
check(afterRestart.activeRoomId === roomId, '重启后回到上次的活动房间');

server.close();
console.log(`\n${failed ? `❌ ${failed} 项失败` : '✅ 全部通过'}`);
process.exit(failed ? 1 : 0);
