/**
 * 房间会话管理：同一时刻只有一个活动房间。
 *
 * 为什么不是"每个房间一个 server"：这是本地单用户应用，一个端口、一份数据目录。
 * 两个标签页各开一个房间会同时写同一个数据目录——那是最难查的一类数据损坏。
 * 所以**先明确拒绝，不要半支持**。
 *
 * 切换房间的顺序（管理方定死，错了会丢数据）：
 *   1. 中断正在跑的一轮 —— **真的 kill 进程**，并等它退出
 *   2. 清空排队发言，如实报「丢弃 N 条」
 *   3. 冻结旧 store：任何残留 turn 都不允许再写旧房间的 jsonl
 *   4. 重建 Room / Store / 适配器 / 成员列表 / 所有房间私有状态
 *   5. 广播新房间的 room.init
 *
 * 「房间私有状态」不需要逐项清理，因为新房间是**新建的 Room 实例**：
 * 护栏计数、autoadvance、接管状态、轮次与用量基线全在构造函数里初始化。
 * 复用实例才是 bug 的源头，所以这里绝不复用。
 */

import { access, chmod, constants, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadConfig, saveConfig, buildRoom } from './config.js';
import {
  ensureRoomsLayout, listRooms, createRoom, renameRoom, deleteRoom, setActiveRoom,
  roomDataDir, loadRoomsMeta,
} from './rooms.js';

/** curl 的候选绝对路径。**绝不查 PATH**——PATH 可能含成员的 cwd（见 installNetget）。 */
const CURL_CANDIDATES = ['/usr/bin/curl', '/bin/curl', '/usr/local/bin/curl'];

async function resolveCurlBin() {
  for (const p of CURL_CANDIDATES) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch { /* 下一个 */ }
  }
  return null;
}

/**
 * 生成受约束的网络读取器。
 *
 * ★ `exec curl` 里那个 `curl` 必须是**绝对路径**，且生成时就定下来。
 *   管理方 22:31 复现的提权：成员能写自己的 cwd，往里面放一个假的 `curl`，
 *   而包装器用裸命令名调用 → 真正执行的就不是 curl，协议限制 / GET-only /
 *   目录内写**全部归零**。实测那条假 curl 把 /etc/hostname 写到了 /tmp。
 *   **能写自己目录 + 走 PATH 找工具 = 提权。**
 *
 * 找不到 curl 时**拒绝生成**，不回退到裸名字（否则洞又回来了）。
 */
export async function installNetget(targetPath) {
  const curl = await resolveCurlBin();
  if (!curl) throw new Error('找不到 curl 的绝对路径（/usr/bin/curl 等），拒绝生成 netget');

  const template = await readFile(fileURLToPath(new URL('../../bin/netget', import.meta.url)), 'utf8');
  const body = template.replace("'@CURL_BIN@'", `'${curl}'`);
  if (body.includes('@CURL_BIN@')) throw new Error('netget 模板里没有 @CURL_BIN@ 占位符，生成会失效');

  await writeFile(targetPath, body, { mode: 0o755 });
  await chmod(targetPath, 0o755);
  return { path: targetPath, curl };
}

export class RoomManager {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {(ev:object)=>void} o.onEvent
   */
  constructor({ dataDir, onEvent, allowMigrate = true }) {
    this.dataDir = dataDir;
    this.onEvent = onEvent;
    /** 是否允许在启动时迁移旧布局。生产服务默认关，必须显式 --migrate。 */
    this.allowMigrate = allowMigrate;
    this.meta = null;
    /** @type {null | {id:string, name:string, dir:string, cfg:object, room:object, store:object, members:Array}} */
    this.session = null;
    this.singleFallback = false;
    this.notices = [];
    this.switching = false;
  }

  async init() {
    const { meta, single, warning } = await ensureRoomsLayout(this.dataDir, {
      allowMigrate: this.allowMigrate,
    });
    this.meta = meta;
    this.singleFallback = single;
    if (warning) this.notices.push(warning);

    const id = meta.activeRoomId ?? meta.rooms[0]?.id ?? null;
    if (id) await this._open(id);
    return this;
  }

  /** 只读状态：给 /api/rooms 和 room.init 用 */
  async list() {
    return {
      rooms: await listRooms(this.dataDir, this.meta),
      activeRoomId: this.session?.id ?? null,
      singleFallback: this.singleFallback,
    };
  }

  /** 打开房间（不做切换流程，调用方保证当前没有活动 turn） */
  async _open(id) {
    const entry = this.meta.rooms.find((r) => r.id === id);
    if (!entry) throw new Error(`房间不存在：${id}`);

    const dir = roomDataDir(this.dataDir, this.meta, id);
    const cfg = await loadConfig(dir);
    // room.json 里的名字是权威显示名；rooms.json 是索引。
    // 两边不一致时以房间自身为准（迁移前的老数据只有这一个来源）。
    if (!cfg.name) cfg.name = entry.name;
    entry.name = cfg.name;

    // 给每条事件打上房间标记：旧房间的残留事件到达界面时必须能被丢掉，
    // 否则切换瞬间会把上一个房间的消息画进新房间。
    const onEvent = (ev) => this.onEvent({ ...ev, roomId: id });

    /**
     * 房间共享目录。
     *
     * 成员之间读不到彼此的文件，协作就退化成"把整张表贴进群"——实测一轮 123k token
     * 里有相当部分是正文搬运。私有目录的隔离保留（防乱写），只开一个共享区。
     */
    const sharedDir = join(dir, 'shared');
    await mkdir(sharedDir, { recursive: true });

    /**
     * ★ 受约束的网络读取器必须生成在**成员 cwd 之外**。
     *
     * 包装器是安全边界本身（只允许 http/https GET、-o 限定在 cwd 内）。
     * 如果它躺在成员自己的工作目录里，那个有 Write 权限的成员可以改写它——
     * 边界就成了它自己写的。所以放在 `<data>/bin/netget`，
     * 而成员的 cwd 是 `<data>/agents/<id>`。
     */
    const binDir = join(dir, 'bin');
    await mkdir(binDir, { recursive: true });
    const netgetPath = join(binDir, 'netget');
    try {
      await installNetget(netgetPath);
    } catch (err) {
      // 生成失败不能静默：成员配了 netget 也跑不了，界面必须知道
      this.notices.push(`网络读取器生成失败（${err.message}），配了 netget 的成员将无法联网`);
    }

    const { room, store, members, warnings } = await buildRoom({
      cfg, dataDir: dir, onEvent, sharedDir,
    });
    for (const w of warnings) this.notices.push(w);

    // netget 路径挂到每个成员上：适配器按 agent 配置构建，拿不到 session
    for (const m of members) m.netgetPath = netgetPath;

    this.session = {
      id, name: cfg.name, dir, cfg, room, store, members, netgetPath,
      saveConfig: () => saveConfig(cfg, dir),
    };
    return this.session;
  }

  /**
   * 切换活动房间。返回 {ok, dropped, killed, reason?}
   *
   * `killed=false` 表示旧房间的 turn 在超时内没退干净——这时仍然切换，
   * 但旧 store 已冻结，不会写脏数据；界面要如实报出来。
   */
  async switchTo(id, { timeoutMs = 15_000 } = {}) {
    if (this.switching) return { ok: false, reason: '正在切换房间，请稍候' };
    if (this.session?.id === id) return { ok: true, dropped: 0, killed: true, changed: false };

    // ★ 先校验目标存在，**再**停旧房间。
    // 顺序反过来的话，切一个不存在的 id 会把当前房间停掉并冻结，
    // 然后抛错——用户眼前的房间就变成只读的了，且没有任何提示。
    if (!this.meta.rooms.some((r) => r.id === id)) {
      return { ok: false, reason: `房间不存在：${id}` };
    }

    this.switching = true;
    try {
      let dropped = 0;
      let killed = true;

      if (this.session) {
        const halted = await this.session.room.halt({ timeoutMs });
        dropped = halted.dropped;
        killed = halted.killed;
        // 冻结必须无论 halt 是否干净退出都执行：宁可这次丢几条后台事件，
        // 也不能让旧房间的残留写入污染新房间的数据文件。
        this.session.store.freeze();
      }

      await this._open(id);
      await setActiveRoom(this.dataDir, this.meta, id);

      this.onEvent({
        type: 'room.switched',
        room: { id, name: this.session.name },
        dropped,
        killed,
        notice: dropped ? `切换房间，丢弃了 ${dropped} 条过期排队发言` : null,
        warning: killed ? null : '旧房间的进程未在超时内退出，已冻结其写入',
      });
      return { ok: true, dropped, killed, changed: true, session: this.session };
    } catch (err) {
      return { ok: false, reason: String(err?.message ?? err) };
    } finally {
      this.switching = false;
    }
  }

  async create(name) {
    const r = await createRoom(this.dataDir, this.meta, name);
    if (!r.ok) return r;
    const sw = await this.switchTo(r.room.id);
    if (!sw.ok) return { ok: false, reason: sw.reason };
    return { ok: true, room: r.room, dropped: sw.dropped };
  }

  async rename(id, name) {
    return renameRoom(this.dataDir, this.meta, id, name);
  }

  /**
   * 删除房间。**删当前房间时先切到另一个再删**（管理方定死）。
   *
   * 顺序不能反：先切走 → 旧进程被杀、队列被清、store 被冻结 → 目录才进垃圾桶。
   * 反过来会留一个"目录已经没了、但还有个 turn 正拿着它写"的窗口。
   *
   * @returns {{ok:true, room:object, trashed:string|null, switchedTo:string|null,
   *            dropped:number, killed:boolean} | {ok:false, reason:string}}
   */
  async remove(id, { timeoutMs = 15_000 } = {}) {
    if (!this.meta.rooms.some((r) => r.id === id)) {
      return { ok: false, reason: '房间不存在' };
    }
    if (this.meta.rooms.length <= 1) {
      return { ok: false, reason: '不能删除最后一个房间' };
    }

    let switchedTo = null;
    let dropped = 0;
    let killed = true;

    if (this.session?.id === id) {
      const target = this.meta.rooms.find((r) => r.id !== id);
      const sw = await this.switchTo(target.id, { timeoutMs });
      if (!sw.ok) {
        return { ok: false, reason: `删除前切换房间失败：${sw.reason}` };
      }
      switchedTo = target.id;
      dropped = sw.dropped ?? 0;
      killed = sw.killed ?? true;
    }

    const r = await deleteRoom(this.dataDir, this.meta, id, { now: Date.now() });
    if (!r.ok) return r;

    this.onEvent({
      type: 'room.deleted',
      id,
      name: r.room.name,
      trashed: r.trashed,
      switchedTo,
    });
    return {
      ok: true, room: r.room, trashed: r.trashed, switchedTo, dropped, killed,
    };
  }

  /** 配置变更后重写磁盘（成员增删都是这一类） */
  async persist() {
    if (!this.session) return;
    await this.session.saveConfig();
  }

  /** 进程退出前把待写事件刷完 */
  async flush() {
    await this.session?.store?.flush?.();
  }

  /** 重新读 rooms.json（别的进程改过时用；本地单用户一般不需要） */
  async reloadMeta() {
    this.meta = (await loadRoomsMeta(this.dataDir)) ?? this.meta;
    return this.meta;
  }
}
