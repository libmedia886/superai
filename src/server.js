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

import { loadConfig, saveConfig, buildRoom, DEFAULT_DATA_DIR } from './core/config.js';
import { availableTiers, TIER } from './core/probe.js';
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
export async function startServer({ port = 4321, host = '127.0.0.1', dataDir = DEFAULT_DATA_DIR, token = null } = {}) {
  const cfg = await loadConfig(dataDir);
  const clients = new Set();
  const replay = [];   // 最近事件，供新连上的页面补齐状态

  const broadcast = (ev) => {
    const payload = { id: randomUUID(), at: Date.now(), ...ev };
    replay.push(payload);
    if (replay.length > 500) replay.shift();
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try { res.write(line); } catch { clients.delete(res); }
    }
  };

  const { room, store, members, warnings } = await buildRoom({ cfg, dataDir, onEvent: broadcast });
  for (const w of warnings) broadcast({ type: 'notice', level: 'warn', text: w });

  const nameOf = (id) => (id === 'human' ? '老板' : (members.find((m) => m.id === id)?.name ?? id));

  // 注意：初始化信息**不能只广播一次**——页面通常在服务启动之后才连上来，
  // 所以每个新连接都要收到一份完整的 init，否则界面是空的。
  const initPayload = () => ({
    type: 'room.init',
    room: { name: cfg.name, leaderId: room.leaderId },
    members: members.map((m) => ({
      id: m.id, name: m.name, role: m.role, backend: m.backend,
      tier: m.tier, persona: m.persona, colors: m.color ?? null,
      tiers: availableTiers(m.backend),
    })),
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
  });

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
        res.write(`data: ${JSON.stringify({ id: randomUUID(), at: Date.now(), ...initPayload() })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: randomUUID(), at: Date.now(), type: 'snapshot', busy: Boolean(room.current) })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }

      if (url.pathname === '/api/say' && req.method === 'POST') {
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
        });
      }

      if (url.pathname === '/api/stop' && req.method === 'POST') {
        room.stop();
        return json(res, 200, { ok: true });
      }

      /** 一键接管：暂停头头，人直接指挥 */
      if (url.pathname === '/api/takeover' && req.method === 'POST') {
        room.takeOver();
        return json(res, 200, { ok: true, overridden: true });
      }

      /** 交还控制权：把自动发言权还给头头（不重置熔断） */
      if (url.pathname === '/api/handback' && req.method === 'POST') {
        room.handBack();
        return json(res, 200, { ok: true, overridden: false });
      }

      /** 指定某人做总结（不进入接力，说完房间停住） */
      if (url.pathname === '/api/summarize' && req.method === 'POST') {
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
        const body = await readJson(req);
        const tier = body.tier;
        if (!['readonly', 'write', 'write-exec'].includes(tier)) {
          return json(res, 400, { error: 'tier 必须是 readonly / write / write-exec' });
        }
        room.aiCabTier = tier;
        cfg.aiCabTier = tier;
        await saveConfig(cfg, dataDir);
        broadcast({ type: 'cabtier.updated', tier });
        return json(res, 200, { ok: true, tier });
      }

      /** 登记可用仓库（只有人能加，头头加不了） */
      if (url.pathname === '/api/registry' && req.method === 'POST') {
        const body = await readJson(req);
        const path = String(body.path ?? '').trim();
        if (!path || !path.startsWith('/')) return json(res, 400, { error: '请填写绝对路径' });
        cfg.registry = cfg.registry ?? [];
        if (cfg.registry.some((r) => r.path === path)) {
          return json(res, 400, { error: '这个仓库已经登记过了' });
        }
        cfg.registry.push({ path });
        room.registry = cfg.registry;
        await saveConfig(cfg, dataDir);
        broadcast({ type: 'registry.updated', registry: cfg.registry });
        return json(res, 200, { ok: true, registry: cfg.registry });
      }

      /** 建房/加成员（改配置并落盘，重启后仍在） */
      if (url.pathname === '/api/member' && req.method === 'POST') {
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
        const member = {
          id: `m${Date.now().toString(36)}`,
          name,
          backend,
          tier,
          role: body.role === 'leader' ? 'leader' : 'member',
          persona: body.persona ?? '',
        };
        cfg.members.push(member);
        await saveConfig(cfg, dataDir);

        // 热添加：不用重启
        const cwd = join(dataDir, 'agents', member.id);
        await mkdir(cwd, { recursive: true });
        room.members.push({ ...member, cwd, aliases: [name.toLowerCase()] });
        if (member.role === 'leader') room.leaderIds.push(member.id);

        broadcast({
          type: 'room.init',
          room: { name: cfg.name, leaderId: room.leaderId },
          members: room.members.map((m) => ({
            id: m.id, name: m.name, role: m.role, backend: m.backend,
            tier: m.tier, persona: m.persona,
            tiers: availableTiers(m.backend),
          })),
          history: store.messages.slice(-200),
          tasks: [...store.tasks.values()],
          roster: [...store.roster.entries()],
          registry: cfg.registry ?? [],
          toolLog: store.toolLog.slice(-200),
        });
        return json(res, 200, { ok: true, member });
      }

      if (url.pathname === '/api/interrupt' && req.method === 'POST') {
        return json(res, 200, { ok: room.interrupt() });
      }

      if (url.pathname === '/api/task' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body.id || !body.status) return json(res, 400, { error: '缺少 id 或 status' });
        await store.updateTask(body.id, { status: body.status });
        broadcast({ type: 'task.updated', id: body.id, patch: { status: body.status } });
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/api/diff' && url.searchParams.get('task')) {
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
        return json(res, 200, { ok: true, members: members.length, busy: Boolean(room.current) });
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
  return { server, port: actualPort, host, room, store, members, url: `http://${shownHost}:${actualPort}` };
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
