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
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { loadConfig, saveConfig, buildRoom, DEFAULT_DATA_DIR } from './core/config.js';
import { availableTiers, TIER } from './core/probe.js';
import { diffAgainstBase } from './core/worktree.js';

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
