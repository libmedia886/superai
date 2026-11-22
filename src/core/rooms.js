/**
 * 多房间：存储布局、迁移、房间增删改查。
 *
 * 布局：
 *   旧（单房间）          新（多房间）
 *   <data>/room.json  →  <data>/rooms/<id>/room.json
 *   <data>/room.jsonl →  <data>/rooms/<id>/room.jsonl
 *   <data>/agents/    →  <data>/rooms/<id>/agents/
 *   （无）             →  <data>/rooms.json   {rooms:[{id,name,createdAt}], activeRoomId}
 *
 * ★ 令牌**不跟房间走**：`<data>/access-token` 是服务级的，迁移不动它。
 *   （曾经把它一起搬进 rooms/r-legacy，结果重启时根目录找不到令牌就重新生成，
 *    老板手里的链接失效——这是本文件历史上犯过的错，别再犯。）
 *
 * 四条硬约束（管理方定的）：
 *  1. **先备份，再迁移**。备份是复制不是移动，失败了原始数据还在。
 *  2. **任何一步失败 → 从备份恢复 → 以旧逻辑继续跑**。不能因为迁移失败让人打不开。
 *  3. **幂等**。rooms.json 里留标记，重启不会重复迁移。
 *  4. **目录名不可改**。成员会话按 cwd 索引，改目录名等于毁掉所有会话上下文。
 */

import { cp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LEGACY_ROOM_ID = 'r-legacy';
export const ROOMS_FILE = 'rooms.json';
export const ROOMS_DIR = 'rooms';
export const BACKUP_PREFIX = '.multiagent-chat.bak-';
/** 删除房间时目录的去处：rooms/.trash-<ts>。不直接用 rm，删错了还能捞回来。 */
export const TRASH_PREFIX = '.trash-';

/**
 * 迁移时移动的东西。备份也按这个清单来，保证"备份 == 迁移前状态"。
 *
 * ★ 不含 `access-token`：令牌是**服务级**的（绑定端口的那个链接），
 *   不是房间级的。把它搬走会让根目录丢失权威副本。
 */
const MOVABLE = ['room.json', 'room.jsonl', 'agents', 'worktrees'];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function readJson(p, fallback = null) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}

async function countLines(p) {
  try {
    const raw = await readFile(p, 'utf8');
    return raw.split('\n').filter((l) => l.trim()).length;
  } catch { return 0; }
}

/**
 * 判断当前是什么状态。
 * @returns {{mode:'multi'|'single'|'empty', rooms?:Array, reason?:string}}
 */
export async function detectLayout(dataDir) {
  const roomsFile = await readJson(join(dataDir, ROOMS_FILE));
  if (roomsFile?.rooms?.length) {
    return { mode: 'multi', rooms: roomsFile.rooms, meta: roomsFile };
  }

  const hasLegacy = await exists(join(dataDir, 'room.json'))
    || await exists(join(dataDir, 'room.jsonl'));
  if (hasLegacy) return { mode: 'single' };

  return { mode: 'empty' };
}

/**
 * 备份：把数据目录里"会被迁移动到的东西"复制到一个带时间戳的目录。
 *
 * **复制不是移动**——备份完原数据必须还在。这是"迁移失败还能退回"的前提。
 *
 * @returns {{ok:true, path:string, files:string[]} | {ok:false, reason:string}}
 */
export async function backupBeforeMigration(dataDir, { now = Date.now() } = {}) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = join(dataDir, `${BACKUP_PREFIX}${stamp}`);

  try {
    await mkdir(backupDir, { recursive: true });
    const copied = [];
    for (const name of MOVABLE) {
      const src = join(dataDir, name);
      if (!(await exists(src))) continue;
      await cp(src, join(backupDir, name), { recursive: true });
      copied.push(name);
    }
    if (!copied.length) {
      return { ok: false, reason: '没有可备份的数据（迁移不该在这个状态下发生）', path: null };
    }

    // 验证：备份里的行数和原件一致，否则这个"备份"是假的
    const srcLines = await countLines(join(dataDir, 'room.jsonl'));
    const bakLines = await countLines(join(backupDir, 'room.jsonl'));
    if (srcLines !== bakLines) {
      return {
        ok: false,
        reason: `备份不完整：原 ${srcLines} 行，备份 ${bakLines} 行`,
        path: backupDir,
      };
    }

    return { ok: true, path: backupDir, files: copied, lines: bakLines };
  } catch (err) {
    return { ok: false, reason: `备份失败：${err.message}`, path: backupDir };
  }
}

/** 从备份恢复（迁移中途失败时用） */
export async function restoreFromBackup(dataDir, backupDir) {
  const restored = [];

  /**
   * ★ 先拆掉迁移留下的 `agents` 兼容链接，**再**恢复。
   *
   * 顺序反了会丢数据：链接指向 `rooms/<id>/agents`，备份复制会顺着链接写进
   * `rooms/` 里面，紧接着我们又 rm -rf rooms/ —— 恢复出来的成员目录就这么没了。
   * 这条是回滚演练测试抓到的（test/session-restore.test.js）。
   */
  const link = join(dataDir, 'agents');
  try {
    const st = await stat(link);
    if (st.isSymbolicLink()) await rm(link, { force: true });
  } catch { /* 没有链接，正常 */ }

  for (const name of MOVABLE) {
    const src = join(backupDir, name);
    if (!(await exists(src))) continue;
    const dst = join(dataDir, name);
    await rm(dst, { recursive: true, force: true });
    await cp(src, dst, { recursive: true });
    restored.push(name);
  }
  // 清掉半成品的新布局，让程序回到"单房间模式"能认的状态
  await rm(join(dataDir, ROOMS_FILE), { force: true });
  await rm(join(dataDir, ROOMS_DIR), { recursive: true, force: true });
  return restored;
}

/**
 * 迁移：单房间 → 多房间。
 *
 * @param {string} dataDir
 * @param {object} [o]
 * @param {(msg:string)=>void} [o.log]
 * @param {number} [o.now]
 * @returns {Promise<
 *   {ok:true, roomId:string, backup:string, name:string, lines:number} |
 *   {ok:false, reason:string, backup?:string, restored?:boolean}
 * >}
 */
export async function migrateSingleRoom(dataDir, { log = () => {}, now = Date.now() } = {}) {
  const layout = await detectLayout(dataDir);
  if (layout.mode === 'multi') {
    return { ok: true, alreadyMigrated: true, reason: '已经是多房间布局，跳过' };
  }
  if (layout.mode === 'empty') {
    return { ok: false, reason: '没有任何数据，不需要迁移' };
  }

  // ---- 1. 读旧数据（迁移前先看清楚有什么） ----
  const oldCfg = await readJson(join(dataDir, 'room.json'), {});
  const oldLines = await countLines(join(dataDir, 'room.jsonl'));
  const name = oldCfg?.name ?? '默认房间';
  log(`检测到单房间数据：「${name}」，${oldLines} 条事件`);

  // ---- 2. 备份 ----
  const backup = await backupBeforeMigration(dataDir, { now });
  if (!backup.ok) {
    log(`备份失败，中止迁移：${backup.reason}`);
    return { ok: false, reason: backup.reason, backup: backup.path };
  }
  log(`已备份到 ${backup.path}（${backup.files.join('、')}）`);

  const roomDir = join(dataDir, ROOMS_DIR, LEGACY_ROOM_ID);

  try {
    // ---- 3. 建目录 ----
    await mkdir(roomDir, { recursive: true });

    // ---- 4. 移动文件 ----
    for (const nm of MOVABLE) {
      const src = join(dataDir, nm);
      if (!(await exists(src))) continue;
      await rename(src, join(roomDir, nm));
    }

    // ---- 5. 写 rooms.json ----
    const meta = {
      version: 1,
      migratedFromSingle: true,
      migratedAt: new Date(now).toISOString(),
      activeRoomId: LEGACY_ROOM_ID,
      rooms: [{
        id: LEGACY_ROOM_ID,
        name,
        createdAt: new Date(now).toISOString(),
      }],
    };
    await writeFile(join(dataDir, ROOMS_FILE), JSON.stringify(meta, null, 2), 'utf8');

    // ---- 6. 验证：一条都不能少 ----
    const newLines = await countLines(join(roomDir, 'room.jsonl'));
    if (newLines !== oldLines) {
      throw new Error(`迁移后事件数不符：原 ${oldLines} 条，现在 ${newLines} 条`);
    }
    const newCfg = await readJson(join(roomDir, 'room.json'));
    if (JSON.stringify(newCfg) !== JSON.stringify(oldCfg)) {
      throw new Error('迁移后 room.json 内容不一致');
    }
    // agents 下每个目录都要在
    if (await exists(join(backup.path, 'agents'))) {
      const before = await readdir(join(backup.path, 'agents'));
      const after = await exists(join(roomDir, 'agents'))
        ? await readdir(join(roomDir, 'agents')) : [];
      const missing = before.filter((d) => !after.includes(d));
      if (missing.length) throw new Error(`迁移后缺少 agent 目录：${missing.join('、')}`);
    }

    /**
     * ★ 根目录留一个 `agents -> rooms/r-legacy/agents` 符号链接。
     *
     * 原因：旧 `session` 事件里记的 cwd 是 `<data>/agents/<id>`。迁移把目录搬走了，
     * 如果不留链接，重启时按 cwd 匹配不上 → 所有成员的会话被判"接不上" →
     * 上下文归零，而且界面上看不出异常（它只是忘了以前所有的事）。
     *
     * 留链接之后老路径仍然指得到同一批目录；同时读取侧改用 realpath 比较，
     * 两条路都能接上（见 config.js）。
     */
    try {
      const legacyAgents = join(roomDir, 'agents');
      if (await exists(legacyAgents) && !(await exists(join(dataDir, 'agents')))) {
        await symlink(join(ROOMS_DIR, LEGACY_ROOM_ID, 'agents'), join(dataDir, 'agents'), 'dir');
      }
    } catch (err) {
      // 做不成也不能让迁移失败：读取侧还有 realpath 兜底
      log(`提示：无法建立 agents 兼容链接（${err.message}），将依赖路径归一化恢复会话`);
    }

    log(`迁移完成：${oldLines} 条事件 → rooms/${LEGACY_ROOM_ID}/`);
    return { ok: true, roomId: LEGACY_ROOM_ID, backup: backup.path, name, lines: newLines };
  } catch (err) {
    // ---- 任何一步失败：从备份恢复，回到旧逻辑 ----
    log(`迁移失败（${err.message}），正在从备份恢复…`);
    try {
      await restoreFromBackup(dataDir, backup.path);
      log('已从备份恢复，将以单房间模式继续运行');
      return { ok: false, reason: err.message, backup: backup.path, restored: true };
    } catch (restoreErr) {
      return {
        ok: false,
        reason: `${err.message}（且恢复失败：${restoreErr.message}。备份在 ${backup.path}）`,
        backup: backup.path,
        restored: false,
      };
    }
  }
}

/* ==================== 房间集合（多房间第二步） ==================== */

const MAX_NAME = 40;

/** 房间 id：目录名，**一旦生成永不改名** */
export function newRoomId(now = Date.now()) {
  return `r-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function validRoomId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{1,40}$/.test(id);
}

export async function loadRoomsMeta(dataDir) {
  return readJson(join(dataDir, ROOMS_FILE), null);
}

export async function saveRoomsMeta(dataDir, meta) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, ROOMS_FILE), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/**
 * 某个房间的数据目录。
 *
 * 正常情况下是 `<data>/rooms/<id>`。唯一的例外是「迁移失败退回单房间模式」——
 * 那时房间数据就留在根目录（旧布局），`meta.singleFallback` 为真。
 */
export function roomDataDir(dataDir, meta, id) {
  if (meta?.singleFallback) return dataDir;
  return join(dataDir, ROOMS_DIR, id);
}

/**
 * 启动时保证有一个可用的房间集合。
 *
 * - 已是多房间 → 原样返回
 * - 单房间旧布局 → 迁移；**迁移失败不阻塞启动**，退回单房间模式（数据仍在根目录）
 * - 空目录 → 空列表（落地页让用户自己建房间，不偷偷预置 lead/bob）
 *
 * @returns {Promise<{meta:object, single:boolean, warning:string|null}>}
 */
export async function ensureRoomsLayout(dataDir, { log = () => {}, allowMigrate = true } = {}) {
  const layout = await detectLayout(dataDir);

  if (layout.mode === 'multi') {
    layout.meta.rooms = layout.meta.rooms ?? [];
    return { meta: layout.meta, single: false, warning: null };
  }

  if (layout.mode === 'single') {
    /**
     * ★ 迁移必须是人明确要求的动作，不能因为"服务重启了一次"就自动发生。
     *
     * 这条是被真实事故推出来的：生产服务重启时自动迁移了真实数据。
     * 结果没错（有备份、逐项核对通过），但流程上的问题是**没人决定过**。
     * 在老板的机器上，一次没被批准的迁移如果出错，损失不可逆。
     *
     * 所以默认只识别、不动盘；要迁移请显式 `--migrate`。
     */
    if (!allowMigrate) {
      const oldCfg = await readJson(join(dataDir, 'room.json'), {});
      const meta = {
        version: 1,
        singleFallback: true,
        pendingMigration: true,
        rooms: [{ id: LEGACY_ROOM_ID, name: oldCfg?.name ?? '默认房间', createdAt: null }],
        activeRoomId: LEGACY_ROOM_ID,
      };
      return {
        meta,
        single: true,
        warning: '检测到单房间旧数据，尚未迁移。数据未被改动；确认要迁移请用 `node bin/serve.mjs --migrate` 启动（会先备份，失败自动回滚）。',
      };
    }

    const r = await migrateSingleRoom(dataDir, { log });
    if (r.ok) {
      const meta = await loadRoomsMeta(dataDir);
      return { meta, single: false, warning: null };
    }

    // 迁移失败：数据已由 migrateSingleRoom 从备份恢复，继续按旧布局跑
    const oldCfg = await readJson(join(dataDir, 'room.json'), {});
    const meta = {
      version: 1,
      singleFallback: true,
      rooms: [{ id: LEGACY_ROOM_ID, name: oldCfg?.name ?? '默认房间', createdAt: new Date().toISOString() }],
      activeRoomId: LEGACY_ROOM_ID,
    };
    return {
      meta,
      single: true,
      warning: `多房间迁移未完成（${r.reason}），已按单房间模式启动；数据未改动，备份在 ${r.backup ?? '（无）'}`,
    };
  }

  const meta = { version: 1, rooms: [], activeRoomId: null };
  await saveRoomsMeta(dataDir, meta);
  return { meta, single: false, warning: null };
}

/** 房间列表（带成员数与最后活动时间，供落地页显示） */
export async function listRooms(dataDir, meta) {
  const out = [];
  for (const r of meta?.rooms ?? []) {
    const dir = roomDataDir(dataDir, meta, r.id);
    const cfg = await readJson(join(dir, 'room.json'), null);
    let lastActivityAt = null;
    let eventCount = 0;
    try {
      const st = await stat(join(dir, 'room.jsonl'));
      lastActivityAt = st.mtime.toISOString();
      eventCount = await countLines(join(dir, 'room.jsonl'));
    } catch { /* 新房间还没有对话 */ }
    out.push({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt ?? null,
      memberCount: cfg?.members?.length ?? 0,
      lastActivityAt,
      eventCount,
    });
  }
  return out;
}

/**
 * 新建房间：只写 `rooms/<id>/room.json`，**空成员**。
 * 第一个成员由界面引导添加，默认角色是头头（见 server 的 /api/member）。
 */
export async function createRoom(dataDir, meta, name, { now = Date.now() } = {}) {
  const clean = String(name ?? '').trim().slice(0, MAX_NAME);
  if (!clean) return { ok: false, reason: '房间名不能为空' };
  if (meta?.singleFallback) {
    return { ok: false, reason: '当前是单房间回退模式（迁移未完成），暂不能新建房间' };
  }
  if (meta.rooms.some((r) => r.name === clean)) {
    return { ok: false, reason: `已存在同名房间「${clean}」` };
  }

  let id = newRoomId(now);
  while (meta.rooms.some((r) => r.id === id)) id = newRoomId(now + 1);

  const dir = join(dataDir, ROOMS_DIR, id);
  await mkdir(join(dir, 'agents'), { recursive: true });
  await writeFile(
    join(dir, 'room.json'),
    JSON.stringify({
      name: clean,
      goal: '',
      registry: [],
      members: [],
      aiCabTier: 'full',
      allowPeerMentions: true,
      headPassiveWake: true,
      executionMode: 'auto',
      maxConcurrency: 4,
    }, null, 2),
    'utf8',
  );

  const room = { id, name: clean, createdAt: new Date(now).toISOString() };
  meta.rooms.push(room);
  meta.activeRoomId = id;
  await saveRoomsMeta(dataDir, meta);
  return { ok: true, room };
}

/** 重命名：只改 rooms.json 里的显示名，**目录名不动** */
export async function renameRoom(dataDir, meta, id, name) {
  const clean = String(name ?? '').trim().slice(0, MAX_NAME);
  if (!clean) return { ok: false, reason: '房间名不能为空' };
  const room = meta.rooms.find((r) => r.id === id);
  if (!room) return { ok: false, reason: '房间不存在' };
  if (meta.singleFallback) return { ok: false, reason: '单房间回退模式下不能重命名' };

  room.name = clean;

  // 房间自己的 room.json 也带上名字（界面/导出读它；目录名保持不变）
  const cfgPath = join(roomDataDir(dataDir, meta, id), 'room.json');
  const cfg = await readJson(cfgPath, null);
  if (cfg) {
    cfg.name = clean;
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  }

  await saveRoomsMeta(dataDir, meta);
  return { ok: true, room };
}

/**
 * 删除房间。
 *
 * 两条硬规矩（管理方）：
 *  1. **目录 rename 到 `rooms/.trash-<ts>/`，不直接 rm。** 删错了还能从垃圾桶捞回来；
 *     rm 掉就真没了，而这个应用里房间等于老板几个小时的对话记录。
 *  2. **不能删最后一个房间。** 删光了界面无处可去，而且很容易被理解成"数据没了"。
 *
 * 删的是"当前房间"时，调用方（RoomManager.remove）必须先切到别的房间再调这里——
 * 直接换 activeRoomId 而不停旧进程，就是 spec 里禁止的"只换指针"。
 *
 * @returns {{ok:true, room:object, trashed:string|null} | {ok:false, reason:string}}
 */
export async function deleteRoom(dataDir, meta, id, { now = Date.now() } = {}) {
  if (meta?.singleFallback) {
    return { ok: false, reason: '单房间回退模式下不能删除房间' };
  }
  const idx = meta.rooms.findIndex((r) => r.id === id);
  if (idx < 0) return { ok: false, reason: '房间不存在' };
  if (meta.rooms.length <= 1) {
    return { ok: false, reason: '不能删除最后一个房间' };
  }
  if (!validRoomId(id)) {
    // 防路径穿越：id 直接拼进路径
    return { ok: false, reason: `非法房间 id：${id}` };
  }

  const room = meta.rooms[idx];
  const dir = join(dataDir, ROOMS_DIR, id);

  // 先 rename 到垃圾桶，再改 rooms.json。
  // 顺序反过来的话，rename 失败会留下"列表里没了、目录还在"的孤儿——
  // 下次新建同名房间时看不出来，但磁盘上已经有两份。
  let trashed = null;
  if (await exists(dir)) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    let target = join(dataDir, ROOMS_DIR, `${TRASH_PREFIX}${stamp}`);
    let n = 1;
    while (await exists(target)) target = join(dataDir, ROOMS_DIR, `${TRASH_PREFIX}${stamp}-${n++}`);
    await rename(dir, target);
    trashed = target;
  }

  meta.rooms.splice(idx, 1);
  if (meta.activeRoomId === id) meta.activeRoomId = meta.rooms[0]?.id ?? null;
  await saveRoomsMeta(dataDir, meta);
  return { ok: true, room, trashed };
}

export async function setActiveRoom(dataDir, meta, id) {
  if (!meta.rooms.some((r) => r.id === id)) return { ok: false, reason: '房间不存在' };
  if (meta.activeRoomId === id) return { ok: true, changed: false };
  meta.activeRoomId = id;
  await saveRoomsMeta(dataDir, meta);
  return { ok: true, changed: true };
}

/** 给终端外壳（bin/room.mjs）用：解析当前应该打开哪个数据目录 */
export async function resolveActiveRoomDir(dataDir) {
  const { meta } = await ensureRoomsLayout(dataDir);
  const id = meta.activeRoomId ?? meta.rooms[0]?.id ?? null;
  if (!id) return { id: null, dir: dataDir, name: meta.rooms[0]?.name ?? '默认房间' };
  const name = meta.rooms.find((r) => r.id === id)?.name ?? '默认房间';
  return { id, dir: roomDataDir(dataDir, meta, id), name };
}
