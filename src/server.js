/**
 * 本地 Web 界面服务。
 *
 * 为什么先做网页而不是直接 Electron：
 *  - 现在就能跑、能截图给人看
 *  - 套 Electron 壳只是把同一个页面装进窗口，不影响工作量
 *
 * 事件出口用 SSE；人发的消息走 POST。
 * 只监听 127.0.0.1，不对外暴露。
 */

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { DEFAULT_DATA_DIR } from './core/config.js';
import { RoomManager } from './core/sessions.js';
import { availableTiers, TIER, TIER_DESC, normalizeTier } from './core/probe.js';
import { DEFAULT_TURN_TIMEOUT_MS, resolveMemberTimeoutMs, timeoutSource } from './core/room.js';
import { planMemberUpdate } from './core/memberSettings.js';
import { detectTierOverride, EFFORT_HINTS } from './core/extraargs.js';
import { exportMarkdown } from './core/export.js';
import {
  diffAgainstBase, commitWorktree, mergeTaskBranch, finalizeTaskWorktree,
} from './core/worktree.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * @param {object} o
 * @param {string} [o.token] 访问令牌。绑定非本机地址时**必须**提供，
 *   否则这个 URL 就是一台能让 AI 改你代码的遥控器。
 */
export async function startServer({
  port = 4321, host = '127.0.0.1', dataDir = DEFAULT_DATA_DIR, token = null,
  /**
   * 是否允许启动时把单房间旧布局迁到多房间。
   *
   * **默认关。** 迁移会动真实数据，必须是人的明确决定，不能因为
   * "服务重启了一次"就悄悄发生——生产上踩过一次。
   */
  allowMigrate = false,
} = {}) {
  const clients = new Set();
  const replay = [];   // 最近事件，供新连上的页面补齐状态

  /**
   * 事件出口。带 `roomId` 的事件只在该房间正处于活动状态时转发——
   * 切换房间后旧房间的残留 turn 还在收尾，它的事件不能画进新房间。
   */
  let activeRoomId = null;
  const broadcast = (ev) => {
    if (ev.roomId && activeRoomId && ev.roomId !== activeRoomId) return;
    const payload = { id: randomUUID(), at: Date.now(), ...ev };
    replay.push(payload);
    if (replay.length > 500) replay.shift();
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try { res.write(line); } catch { clients.delete(res); }
    }
  };

  const manager = new RoomManager({ dataDir, onEvent: broadcast, allowMigrate });
  await manager.init();

  // 这些引用随房间切换而更新。全部经由 sync() 刷新，**不要**在别处缓存它们。
  let room, store, members, cfg, session;
  function sync() {
    session = manager.session;
    room = session?.room ?? null;
    store = session?.store ?? null;
    members = session?.members ?? [];
    cfg = session?.cfg ?? null;
    activeRoomId = session?.id ?? null;
  }
  sync();
  for (const w of manager.notices) broadcast({ type: 'notice', level: 'warn', text: w });
  manager.notices.length = 0;

  const nameOf = (id) => (id === 'human' ? '老板' : (members.find((m) => m.id === id)?.name ?? id));

  /**
   * 成员对外表示。档位覆盖标记**每次现算**，不从存储里读——
   * 参数删掉后标记必须自己消失，否则又是一条"界面撒谎"。
   */
  const publicMember = (m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    backend: m.backend,
    tier: m.tier,
    tierDesc: TIER_DESC[m.tier] ?? '',
    persona: m.persona ?? '',
    model: m.model ?? '',
    effort: m.effort ?? '',
    extraArgs: m.extraArgsText ?? '',
    allowedCommands: (m.allowedCommands ?? []).join(' '),
    timeoutMinutes: m.timeoutMinutes ?? null,
    // 实际生效值 + 来源：界面据此显示，避免"界面一个值、实际另一个值"
    effectiveTimeoutMinutes: Math.round(resolveMemberTimeoutMs(m, room?.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) / 60_000),
    timeoutSource: timeoutSource(m),
    overridesTier: detectTierOverride(m.backend, m.extraArgs ?? []),
    colors: m.color ?? null,
    tiers: availableTiers(m.backend),
    effortHints: EFFORT_HINTS[m.backend] ?? [],
    createdBy: m.createdBy ?? null,
    createdReason: m.createdReason ?? null,
    // 会话为什么没接上：界面必须说清「上下文已重置」，不能让它静默失忆
    hasSession: Boolean(m.sessionId),
    sessionResetReason: m.sessionResetReason ?? null,
  });

  // 注意：初始化信息**不能只广播一次**——页面通常在服务启动之后才连上来，
  // 所以每个新连接都要收到一份完整的 init，否则界面是空的。
  const initPayload = async () => {
    const rooms = await manager.list();
    if (!session) {
      return {
        type: 'room.init',
        room: null,
        rooms: rooms.rooms,
        activeRoomId: null,
        singleFallback: rooms.singleFallback,
        members: [], history: [], tasks: [], roster: [], registry: [], toolLog: [],
        aiCabTier: 'readonly', maxMembers: 8, overridden: false, stopped: false,
        headPassiveWake: true, paused: null, turnTimeoutMinutes: 20,
      };
    }
    return {
      type: 'room.init',
      room: { id: session.id, name: session.name, leaderId: room.leaderId },
      rooms: rooms.rooms,
      activeRoomId: session.id,
      singleFallback: rooms.singleFallback,
      members: members.map(publicMember),
      history: store.messages.slice(-200),
      tasks: [...store.tasks.values()],
      roster: [...store.roster.entries()],
      registry: cfg.registry ?? [],
      toolLog: store.toolLog.slice(-200),
      /** AI 能创建的成员最高档位（人设定） */
      aiCabTier: room.aiCabTier,
      maxMembers: 8,
      // 接管状态必须带上：否则刷新后 badge 消失，用户会忘了自己接管过
      overridden: Boolean(room.overridden),
      // 停止状态同理：刷新一下就把红色常驻提示弄丢，用户会以为房间还能用
      stopped: Boolean(room.stopped),
      headPassiveWake: room.headPassiveWake !== false,
      turnTimeoutMinutes: Math.round((room.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) / 60_000),
      // 停顿原因必须随状态一起下发：刷新后"为什么停着"不能变成一个谜
      paused: room.pauseReason ? { ...room.pauseReason } : null,
    };
  };

  /** 切完房间后广播整个房间的状态（顺序：先切引用，再广播） */
  async function broadcastInit() {
    sync();
    broadcast({ ...(await initPayload()), roomId: null });
  }

  const requireRoom = (res) => {
    if (!session) {
      json(res, 409, { error: '还没有打开任何房间。请先在房间列表里新建或进入一个房间。' });
      return false;
    }
    return true;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    // 令牌校验。用 query 参数是因为 EventSource 不能自定义请求头；
    // 同时接受 Cookie，这样刷新和后续请求不必反复带 ?t=。
    if (token && !isAuthorized(req, url, token)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('需要访问令牌。请用启动时打印的完整链接（含 ?t=...）打开。');
      return;
    }

    try {
      // 首次带 ?t= 打开**页面**：种 Cookie 并跳到不带参数的地址，避免 token 留在地址栏历史里。
      // API 请求不做这个跳转——它们不是浏览器导航，302 会让调用方拿不到数据。
      const isNavigation = req.method === 'GET' && !url.pathname.startsWith('/api')
        && url.pathname !== '/events';
      if (token && isNavigation && url.searchParams.get('t') === token && !hasCookie(req, token)) {
        res.writeHead(302, {
          'Set-Cookie': `maroom_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
          Location: url.pathname + (url.searchParams.has('task') ? `?task=${url.searchParams.get('task')}` : ''),
        });
        res.end();
        return;
      }

      if (url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('retry: 1000\n\n');
        // 每个新连接先收完整初始化状态，刷新后不会空白
        res.write(`data: ${JSON.stringify({ id: randomUUID(), at: Date.now(), ...(await initPayload()) })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: randomUUID(), at: Date.now(), type: 'snapshot', busy: Boolean(room?.current) })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }

      if (url.pathname === '/api/say' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '空消息' });
        if (room.current) {
          // 有人正在说：入队，界面会显示"已排队"
          broadcast({ type: 'notice', level: 'info', text: '有人正在发言，你的消息已排队' });
        }
        const r = await room.humanSay(text, { taskId: body.taskId ?? null });
        // 不 await drain：发言要立刻返回，后续由 SSE 推送
        room.drain().catch((err) => broadcast({
          type: 'failure', agentId: 'system', reason: 'crashed', detail: String(err),
        }));
        return json(res, 200, {
          ok: true, targets: r.targets, unknown: r.unknown, broadcast: r.broadcast,
          resumed: Boolean(r.resumed),
        });
      }

      if (url.pathname === '/api/stop' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const r = room.stop();
        return json(res, 200, { ok: true, ...r });
      }

      /**
       * 继续：解除「停止」。
       * 没有这个接口时，「停止」是一条单行道——只能靠人再发一句话去恢复，
       * 而用户在界面上找不到任何"松开刹车"的东西。
       */
      if (url.pathname === '/api/resume' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req).catch(() => ({}));
        // 两件事分开：
        //  - 解除「停止」（resumeRoom）
        //  - 或者「接着刚才那条往下走」（continueAfterPause：清暂停原因 + 叫头头）
        if (body.kick) {
          const r = room.continueAfterPause();
          room.drain().catch((err) => broadcast({
            type: 'failure', agentId: 'system', reason: 'crashed', detail: String(err),
          }));
          if (!r.ok) return json(res, 400, { error: r.reason });
          return json(res, 200, { ok: true, ...r });
        }
        const r = room.resumeRoom({ reason: 'human' });
        return json(res, 200, { ok: true, ...r });
      }

      /** 一键接管：暂停头头，人直接指挥 */
      if (url.pathname === '/api/takeover' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        room.takeOver();
        return json(res, 200, { ok: true, overridden: true });
      }

      /** 交还控制权：把自动发言权还给头头（不重置熔断） */
      if (url.pathname === '/api/handback' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        room.handBack();
        return json(res, 200, { ok: true, overridden: false });
      }

      /** 指定某人做总结（不进入接力，说完房间停住） */
      if (url.pathname === '/api/summarize' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req);
        const agentId = body.agentId;
        if (!agentId) return json(res, 400, { error: '缺少 agentId' });
        const r = await room.requestSummary(agentId);
        if (!r.ok) return json(res, 400, r);
        room.drain().catch(() => {});
        return json(res, 200, { ok: true });
      }

      /** 设置权限天花板：AI 能创建的成员最高档位（只有人能改） */
      if (url.pathname === '/api/cabtier' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req);
        const tier = body.tier;
        if (!['readonly', 'write', 'write-exec'].includes(tier)) {
          return json(res, 400, { error: 'tier 必须是 readonly / write / write-exec' });
        }
        room.aiCabTier = tier;
        cfg.aiCabTier = tier;
        await manager.persist();
        broadcast({ type: 'cabtier.updated', tier });
        return json(res, 200, { ok: true, tier });
      }

      /**
       * 房间级设置。目前只有一项：成员不 @ 发言是否叫醒头头。
       * 只有人能改（agent 动作协议里没有这个动作）。
       */
      if (url.pathname === '/api/room-settings' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req);
          if (body.turnTimeoutMinutes !== undefined) {
          const raw = String(body.turnTimeoutMinutes ?? '').trim();
          if (!raw) {
            room.turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS;
            cfg.turnTimeoutMinutes = null;
          } else {
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 1 || n > 120) {
              return json(res, 400, { error: '单轮上限必须在 1~120 分钟之间（留空 = 默认 20 分钟）' });
            }
            room.turnTimeoutMs = Math.round(n * 60_000);   // 立即生效
            cfg.turnTimeoutMinutes = n;
          }
          await manager.persist();
          broadcast({ type: 'room.settings', turnTimeoutMinutes: cfg.turnTimeoutMinutes ?? null });
        }

      if (body.headPassiveWake !== undefined) {
          room.headPassiveWake = Boolean(body.headPassiveWake);
          cfg.headPassiveWake = room.headPassiveWake;
          await manager.persist();
          broadcast({ type: 'room.settings', headPassiveWake: room.headPassiveWake });
        }
        return json(res, 200, { ok: true, headPassiveWake: room.headPassiveWake });
      }

      /** 登记可用仓库（只有人能加，头头加不了） */
      if (url.pathname === '/api/registry' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req);
        const path = String(body.path ?? '').trim();
        if (!path || !path.startsWith('/')) return json(res, 400, { error: '请填写绝对路径' });
        cfg.registry = cfg.registry ?? [];
        if (cfg.registry.some((r) => r.path === path)) {
          return json(res, 400, { error: '这个仓库已经登记过了' });
        }
        cfg.registry.push({ path });
        room.registry = cfg.registry;
        await manager.persist();
        broadcast({ type: 'registry.updated', registry: cfg.registry });
        return json(res, 200, { ok: true, registry: cfg.registry });
      }

      /* ---------- 房间：列表 / 新建 / 重命名 / 切换 ---------- */

      if (url.pathname === '/api/rooms' && req.method === 'GET') {
        return json(res, 200, await manager.list());
      }

      if (url.pathname === '/api/rooms' && req.method === 'POST') {
        const body = await readJson(req);
        const action = String(body.action ?? 'create');

        if (action === 'create') {
          // 新建房间只问名字，建完是**空房间**——不偷偷预置 lead/bob
          const r = await manager.create(body.name);
          if (!r.ok) return json(res, 400, { error: r.reason });
          await broadcastInit();
          return json(res, 200, { ok: true, room: r.room, dropped: r.dropped ?? 0 });
        }

        if (action === 'switch') {
          const id = String(body.id ?? '');
          if (!id) return json(res, 400, { error: '缺少房间 id' });
          if (manager.session?.id === id) return json(res, 200, { ok: true, changed: false });
          const r = await manager.switchTo(id);
          if (!r.ok) return json(res, 400, { error: r.reason });
          await broadcastInit();
          return json(res, 200, {
            ok: true, changed: r.changed, dropped: r.dropped, killed: r.killed,
            room: { id, name: manager.session.name },
          });
        }

        if (action === 'rename') {
          const id = String(body.id ?? '');
          const r = await manager.rename(id, body.name);
          if (!r.ok) return json(res, 400, { error: r.reason });
          // 改的是当前房间 → 界面上的名字也要跟着变
          if (manager.session?.id === id) {
            manager.session.name = r.room.name;
            broadcast({ type: 'room.renamed', id, name: r.room.name });
          }
          broadcast({ type: 'rooms.updated', rooms: (await manager.list()).rooms });
          return json(res, 200, { ok: true, room: r.room });
        }

        if (action === 'delete') {
          const id = String(body.id ?? '');
          if (!id) return json(res, 400, { error: '缺少房间 id' });
          // 二次确认由界面做（那是"人确认过"的地方），服务端只负责两条硬规矩：
          // 不能删最后一个；删当前房间先切到另一个再删。目录进 .trash-*，不 rm。
          const r = await manager.remove(id);
          if (!r.ok) return json(res, 400, { error: r.reason });
          broadcast({
            type: 'rooms.updated',
            rooms: (await manager.list()).rooms,
            deleted: { id, name: r.room.name },
          });
          if (r.switchedTo) {
            // 删的是当前房间：新房间的完整状态必须广播，否则界面还停在旧房间
            await broadcastInit();
          }
          return json(res, 200, {
            ok: true, deleted: r.room, trashed: r.trashed,
            switchedTo: r.switchedTo, dropped: r.dropped, killed: r.killed,
          });
        }

        // 直接切到某个房间的简写：POST {id} 不带 action
        if (body.id) {
          const r = await manager.switchTo(String(body.id));
          if (!r.ok) return json(res, 400, { error: r.reason });
          await broadcastInit();
          return json(res, 200, { ok: true, dropped: r.dropped, killed: r.killed });
        }

        return json(res, 400, { error: 'action 必须是 create / switch / rename / delete' });
      }

      /** 建房/加成员（改配置并落盘，重启后仍在） */
      if (url.pathname === '/api/member' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req);
        const name = String(body.name ?? '').trim();
        const backend = String(body.backend ?? '').trim();
        if (!name || !backend) return json(res, 400, { error: '需要名字和后端' });
        if (!availableTiers(backend).length) return json(res, 400, { error: `不支持的 backend：${backend}` });
        if (room.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
          return json(res, 400, { error: '这个名字已存在' });
        }

        // 档位必须该后端真支持，**不能静默降级**。
        // 用户给 codex 选了 write、实际存成 readonly，他会以为 agent 能改文件，
        // 结果跑了半天什么都没改——这种"看起来配了、实际没生效"是最难查的。
        const tiers = availableTiers(backend);
        const tier = body.tier ?? TIER.READONLY;
        if (!tiers.includes(tier)) {
          return json(res, 400, {
            error: `${backend} 不支持档位「${tier}」，可选：${tiers.join(' / ')}`,
            availableTiers: tiers,
          });
        }

        // ★ 空房间第一个成员默认是头头。
        // 老板的实际用法是"先有头头，再让头头造人"；如果第一个是普通成员，
        // 他不知道去哪儿点，房间就卡在"没人能分派任务"的状态。
        const first = room.members.length === 0;
        const role = body.role ? (body.role === 'leader' ? 'leader' : 'member')
          : (first ? 'leader' : 'member');

        const member = {
          id: `m${Date.now().toString(36)}`,
          name,
          backend,
          tier,
          role,
          persona: body.persona ?? '',
        };
        cfg.members.push(member);
        await manager.persist();

        // 热添加：不用重启
        const cwd = join(session.dir, 'agents', member.id);
        await mkdir(cwd, { recursive: true });
        room.members.push({ ...member, cwd, aliases: [name.toLowerCase()] });
        if (member.role === 'leader') {
          room.leaderIds.push(member.id);
          room.leaderId = room.leaderIds[0];
        }

        await broadcastInit();
        return json(res, 200, { ok: true, member, role });
      }

      /**
       * 修改成员（人类专用）。
       *
       * 为什么单独一个接口而不是复用 /api/member：
       * 改档位/换后端有额外的前置条件（confirmOverride、会话重置），
       * 塞进"新建"里会让新建那条路径也带上这些含义模糊的开关。
       */
      if (url.pathname === '/api/member/update' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req);
        const agentId = String(body.id ?? body.agentId ?? '');
        const target = room.members.find((m) => m.id === agentId);
        if (!target) return json(res, 404, { error: '找不到这个成员' });

        const plan = planMemberUpdate({
          member: {
            ...cfg.members.find((m) => m.id === agentId) ?? {},
            id: target.id,
            name: target.name,
            backend: target.backend,
            tier: target.tier,
            role: target.role,
            persona: target.persona,
            model: target.model,
            effort: target.effort,
            extraArgs: target.extraArgs ?? [],
            extraArgsText: target.extraArgsText ?? '',
            allowedCommands: target.allowedCommands ?? [],
            timeoutMinutes: target.timeoutMinutes ?? null,
            timeoutMs: target.timeoutMs ?? null,
          },
          patch: body.patch ?? body,
          members: room.members,
          confirmOverride: Boolean(body.confirmOverride),
        });
        if (!plan.ok) {
          return json(res, 400, {
            error: plan.reason, code: plan.code ?? null,
            needingConfirm: plan.needingConfirm ?? null,
            rejected: plan.rejected ?? null,
            availableTiers: plan.availableTiers ?? null,
          });
        }

        const before = publicMember(target);
        const next = plan.member;
        const changed = plan.changed;

        // 写回 cfg（配置）与 room.members（内存）——两处必须一起改，
        // 只改一处就是"界面变了重启就回去"或"重启变了界面没变"。
        const cfgMember = cfg.members.find((m) => m.id === agentId);
        if (cfgMember) {
          Object.assign(cfgMember, {
            name: next.name,
            backend: next.backend,
            tier: next.tier,
            role: next.role,
            persona: next.persona,
            model: next.model ?? null,
            effort: next.effort ?? null,
            extraArgs: next.extraArgs ?? [],
            extraArgsText: next.extraArgsText ?? '',
            allowedCommands: next.allowedCommands ?? [],
            allowedCommandsText: next.allowedCommandsText ?? '',
            timeoutMinutes: next.timeoutMinutes ?? null,
            // 清空界面字段时也要把手写的旧字段一起清掉（见 memberSettings）
            timeoutMs: next.timeoutMs ?? null,
          });
        }
        Object.assign(target, {
          name: next.name,
          backend: next.backend,
          tier: next.tier,
          role: next.role,
          persona: next.persona,
          model: next.model ?? null,
          effort: next.effort ?? null,
          extraArgs: next.extraArgs ?? [],
          extraArgsText: next.extraArgsText ?? '',
          allowedCommands: next.allowedCommands ?? [],
          allowedCommandsText: next.allowedCommandsText ?? '',
          timeoutMinutes: next.timeoutMinutes ?? null,
          timeoutMs: next.timeoutMs ?? null,
          aliases: [next.name.toLowerCase()],
        });

        // 换后端：会话 id 必须清掉（旧 CLI 的 session 交错会空轮/挂死）
        if (next.sessionReset) {
          target.sessionId = null;
          store.sessions.delete(agentId);
          await store.saveSession(agentId, { sessionId: null, cwd: target.cwd ?? null, backend: next.backend });
        }

        // 角色变化 → 头头列表要跟着变
        if (changed.includes('role')) {
          room.leaderIds = room.members.filter((m) => m.role === 'leader').map((m) => m.id);
          room.leaderId = room.leaderIds[0] ?? null;
        }

        await manager.persist();

        const after = publicMember(target);
        const audit = {
          kind: 'member.updated', agentId, by: 'human', changed,
          before: pickAudit(before), after: pickAudit(after),
        };
        await store.append(audit).catch(() => {});

        await broadcastInit();
        broadcast({ type: 'member.updated', member: after, changed, sessionReset: Boolean(next.sessionReset) });
        return json(res, 200, {
          ok: true, member: after, changed, sessionReset: Boolean(next.sessionReset),
          overridesTier: after.overridesTier,
        });
      }

      /** 删除成员（人类专用）。历史消息保留，只从名册移除。 */
      if (url.pathname === '/api/member/remove' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req);
        const agentId = String(body.id ?? body.agentId ?? '');
        const idx = room.members.findIndex((m) => m.id === agentId);
        if (idx < 0) return json(res, 404, { error: '找不到这个成员' });

        const target = room.members[idx];
        const wasLeader = target.role === 'leader';
        const otherLeaders = room.members.filter((m) => m.id !== agentId && m.role === 'leader');

        // 删掉最后一个头头会让房间失去"默认接手的人"，必须让操作者知道
        if (wasLeader && otherLeaders.length === 0 && body.confirmNoLeader !== true) {
          return json(res, 400, {
            error: '这是房间里唯一的头头。删掉之后没有人能自动接手任务；确认要继续请带 confirmNoLeader。',
            code: 'LAST_LEADER',
          });
        }

        const before = publicMember(target);
        room.members.splice(idx, 1);
        cfg.members = (cfg.members ?? []).filter((m) => m.id !== agentId);
        room.leaderIds = room.members.filter((m) => m.role === 'leader').map((m) => m.id);
        room.leaderId = room.leaderIds[0] ?? null;
        // 队列里排着的它也不能再跑
        room.queue = room.queue.filter((q) => q.agentId !== agentId);

        await manager.persist();
        await store.append({
          kind: 'member.removed', agentId, by: 'human', changed: ['removed'],
          before: pickAudit(before), after: null,
        }).catch(() => {});

        await broadcastInit();
        broadcast({ type: 'member.removed', agentId, name: before.name });
        return json(res, 200, { ok: true, removed: before, historyKept: true });
      }

      if (url.pathname === '/api/interrupt' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        return json(res, 200, { ok: room.interrupt() });
      }

      if (url.pathname === '/api/task' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req);
        if (!body.id || !body.status) return json(res, 400, { error: '缺少 id 或 status' });
        await store.updateTask(body.id, { status: body.status });
        broadcast({ type: 'task.updated', id: body.id, patch: { status: body.status } });
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/api/diff' && url.searchParams.get('task')) {
        if (!requireRoom(res)) return;
        const taskId = url.searchParams.get('task');
        const t = store.tasks.get(taskId);
        if (!t?.worktree || !t?.repo) return json(res, 404, { error: '该任务还没有 worktree' });
        const d = await diffAgainstBase(t.worktree, t.baseBranch ?? 'main');
        return json(res, 200, d);
      }

      /**
       * 验收：把 worktree 里的改动提交到任务分支，然后合并或丢弃。
       * **只有人能触发**，agent 没有这个接口的访问权。
       */
      if (url.pathname === '/api/accept' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req);
        const taskId = body.id;
        const t = taskId ? store.tasks.get(taskId) : null;
        if (!t) return json(res, 404, { error: '任务不存在' });
        if (!t.worktree || !t.repo) return json(res, 400, { error: '该任务没有 worktree，无需验收' });

        if (body.action === 'merge') {
          const c = await commitWorktree({
            worktree: t.worktree,
            message: `${t.id}: ${t.title}`,
            taskId: t.id,
          });
          if (!c.ok) return json(res, 500, { error: c.reason });
          if (!c.committed) return json(res, 400, { error: '没有可合并的改动' });

          const m = await mergeTaskBranch({
            repoPath: t.repo, branch: `task/${t.id}`, baseBranch: t.baseBranch ?? 'main',
          });
          if (!m.ok) return json(res, 409, { error: m.reason, commit: c.commit });

          // 合并成功：worktree 转 detached 再删分支，保留目录供事后追问
          const f = await finalizeTaskWorktree({
            repoPath: t.repo, worktree: t.worktree, branch: `task/${t.id}`, keepWorktree: true,
          });

          await store.updateTask(t.id, { status: '完成', acceptedAt: new Date().toISOString() });
          broadcast({
            type: 'task.accepted', id: t.id, action: 'merge',
            commit: m.commit, worktreeKept: !f.worktreeRemoved,
          });
          return json(res, 200, { ok: true, commit: m.commit });
        }

        if (body.action === 'discard') {
          const f = await finalizeTaskWorktree({
            repoPath: t.repo, worktree: t.worktree, branch: `task/${t.id}`, keepWorktree: false,
          });
          await store.updateTask(t.id, { status: '阻塞', discardedAt: new Date().toISOString() });
          broadcast({ type: 'task.accepted', id: t.id, action: 'discard', ok: f.ok });
          return json(res, 200, { ok: f.ok, reason: f.reason ?? null });
        }

        return json(res, 400, { error: 'action 必须是 merge 或 discard' });
      }

      if (url.pathname === '/api/roster' && req.method === 'POST') {
        if (!requireRoom(res)) return;
        const body = await readJson(req);
        if (!body.agentId) return json(res, 400, { error: '缺少 agentId' });
        await store.updateRoster(body.agentId, { humanDuties: body.duties ?? undefined });
        broadcast({
          type: 'roster.updated',
          agentId: body.agentId,
          by: 'human',
          roster: store.roster.get(body.agentId) ?? null,
        });
        return json(res, 200, { ok: true });
      }

      /** 导出 Markdown：干完活要能交出去 */
      if (url.pathname === '/api/export') {
        if (!requireRoom(res)) return;
        const md = exportMarkdown({
          room: { name: cfg.name, goal: room.goal },
          messages: store.messages,
          tasks: [...store.tasks.values()],
          roster: store.roster,
          toolLog: store.toolLog,
          actionLog: store.actionLog,
          members: room.members,
          nameOf,
        });
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="room-${stamp}.md"`,
        });
        res.end(md);
        return;
      }

      if (url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          roomId: session?.id ?? null,
          members: members.length,
          busy: Boolean(room?.current),
          stopped: Boolean(room?.stopped),
          pausedReason: room?.pauseReason ?? null,
          paused: Boolean(room?.overridden),
          pending: room?.queue?.length ?? 0,
          rooms: manager.meta?.rooms?.length ?? 0,
        });
      }

      // 静态文件
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
      const file = join(PUBLIC_DIR, safe);
      if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      return res.end(data);
    } catch (err) {
      if (err.code === 'ENOENT') return json(res, 404, { error: 'not found' });
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  // room / store / members 用 getter：切换房间后调用方拿到的永远是当前房间的对象。
  // 直接返回值会让外部持有旧引用，然后往旧房间写数据——正是要防的那类问题。
  const out = { server, port: actualPort, host, manager, url: `http://${shownHost}:${actualPort}` };
  for (const key of ['room', 'store', 'members']) {
    Object.defineProperty(out, key, { enumerable: true, get: () => manager.session?.[key === 'room' ? 'room' : key === 'store' ? 'store' : 'members'] });
  }
  return out;
}

/** 访问校验：query 参数或 Cookie 任一匹配即可 */
export function isAuthorized(req, url, token) {
  if (!token) return true;
  if (url.searchParams.get('t') === token) return true;
  const cookie = req.headers?.cookie ?? '';
  return cookie.split(';').some((c) => c.trim() === `maroom_token=${token}`);
}

function hasCookie(req, token) {
  const cookie = req.headers?.cookie ?? '';
  return cookie.split(';').some((c) => c.trim() === `maroom_token=${token}`);
}

/** 审计只记"变了什么"，不把整个 persona 复制一遍（日志会爆） */
function pickAudit(m) {
  return {
    name: m.name, backend: m.backend, tier: m.tier, model: m.model,
    effort: m.effort, extraArgs: m.extraArgs, role: m.role,
    allowedCommands: m.allowedCommands ?? [],
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
