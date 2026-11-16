/**
 * 多房间：存储布局与迁移。
 *
 * 这一轮**只做迁移**，不碰运行时和界面。理由是迁移是唯一会破坏已有数据的步骤，
 * 它必须先单独做对、单独验过，再让别的改动叠上来。
 *
 * 布局：
 *   旧（单房间）          新（多房间）
 *   <data>/room.json  →  <data>/rooms/<id>/room.json
 *   <data>/room.jsonl →  <data>/rooms/<id>/room.jsonl
 *   <data>/agents/    →  <data>/rooms/<id>/agents/
 *   （无）             →  <data>/rooms.json   {rooms:[{id,name,createdAt}], migratedFromSingle:true}
 *
 * 三条硬约束（管理方定的）：
 *  1. **先备份，再迁移**。备份是复制不是移动，失败了原始数据还在。
 *  2. **任何一步失败 → 从备份恢复 → 以旧逻辑继续跑**。不能因为迁移失败让人打不开。
 *  3. **幂等**。rooms.json 里留标记，重启不会重复迁移。
 */

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LEGACY_ROOM_ID = 'r-legacy';
export const ROOMS_FILE = 'rooms.json';
export const ROOMS_DIR = 'rooms';
export const BACKUP_PREFIX = '.multiagent-chat.bak-';

/** 迁移时移动的东西。备份也按这个清单来，保证"备份 == 迁移前状态"。 */
const MOVABLE = ['room.json', 'room.jsonl', 'agents', 'worktrees', 'access-token'];

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
