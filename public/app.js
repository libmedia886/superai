/* 群聊界面。与内核通过 SSE 单向接收、POST 单向发送。 */

const $ = (id) => document.getElementById(id);

const state = {
  members: [],
  messages: [],       // 已渲染的消息
  tasks: new Map(),
  roster: new Map(),
  registry: [],
  current: null,      // { agentId, el, textEl, thinkingEl, text }
  turnCount: 0,
  usage: 0,
  busy: false,
  pending: 0,
  currentSpeakerLast: null,
  leaderId: null,
  toolLog: [],
};

const COLORS = ['#5b9dff', '#b76cf0', '#3fb950', '#d29922', '#f85149', '#39c5cf', '#e06c9f'];

function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % COLORS.length;
  return COLORS[h];
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 极简 Markdown：代码块 + 行内代码 + 粗体。
 * action 块不进聊天正文——实时流里由动作卡片承载；历史里直接省略
 * （历史不重放动作状态，留着占位符反而是误导）。
 */
function renderBody(text, { live = false } = {}) {
  const parts = String(text ?? '').split(/(```[\s\S]*?```)/g);
  return parts.map((p) => {
    if (p.startsWith('```')) {
      const m = p.match(/^```([a-zA-Z]*)\n?([\s\S]*?)```$/);
      const lang = m?.[1] ?? '';
      const code = m?.[2] ?? p.slice(3, -3);
      if (lang === 'action' || lang === 'actions') {
        return live ? '' : '';
      }
      return `<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
    }
    return escapeHtml(p)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }).join('').trim();
}

/* ---------------- 渲染 ---------------- */

function memberById(id) {
  return state.members.find((m) => m.id === id);
}

function nameOf(id) {
  if (id === 'human') return '老板';
  return memberById(id)?.name ?? id;
}

function avatarEl(name) {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.style.background = colorFor(name);
  el.textContent = name.slice(0, 1).toUpperCase();
  return el;
}

function renderMemberList() {
  const ul = $('member-list');
  ul.innerHTML = '';
  for (const m of state.members) {
    const li = document.createElement('li');
    li.className = 'member';
    const tierKey = m.tier;
    li.innerHTML = `
      <div class="member-top">
        <span class="member-name">${escapeHtml(m.name)}</span>
        <span class="member-role ${m.role === 'leader' ? '' : 'member'}">${m.role === 'leader' ? '头头' : '成员'}</span>
      </div>
      <div class="member-meta">
        <span>${escapeHtml(m.backend)}</span>
        <span class="tier-badge ${tierKey}">${tierLabel(tierKey)}</span>
      </div>
      ${approvalNote(m.tier)}`;
    li.querySelector('.member-top').prepend(avatarEl(m.name));
    ul.appendChild(li);
  }
}

function tierLabel(tier) {
  if (tier === 'readonly') return '只读';
  if (tier === 'write-ask') return '可写·询问';
  if (tier === 'write') return '可写';
  if (tier === 'write-exec') return '可写+执行';
  return tier ?? '';
}

/**
 * 说清"问不问人"，而不是只说"能不能写"。
 * 默认档是**从来不问**，用户经常误以为"每次都会问我"。
 */
function approvalNote(tier) {
  if (tier === 'readonly') return '';
  if (tier === 'write-ask') return '<div class="approval-note">文件写入：每次询问</div>';
  return '<div class="approval-note auto">文件写入：自动批准，不会询问</div>';
}

function renderRoster() {
  const ul = $('roster-list');
  ul.innerHTML = '';
  if (!state.roster.size) {
    ul.innerHTML = '<li class="empty-hint">尚无职责自述</li>';
    return;
  }
  for (const [agentId, r] of state.roster) {
    const li = document.createElement('li');
    li.className = 'roster-item';
    const duty = r.humanDuties ?? r.selfDuties ?? '（未填写）';
    li.innerHTML = `<b>${escapeHtml(nameOf(agentId))}</b>：${escapeHtml(duty)}`;
    ul.appendChild(li);
  }
}

function renderRepos() {
  const ul = $('repo-list');
  ul.innerHTML = '';
  if (!state.registry.length) {
    ul.innerHTML = '<li class="empty-hint">未登记仓库<br>（agent 暂不能改你的项目）</li>';
    return;
  }
  for (const r of state.registry) {
    const li = document.createElement('li');
    li.className = 'repo-item';
    li.textContent = r.path;
    ul.appendChild(li);
  }
}

const STATUS_ORDER = ['待办', '进行中', '待确认', '完成', '阻塞'];

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  const tasks = [...state.tasks.values()];
  if (!tasks.length) {
    board.innerHTML = '<div class="empty-hint">暂无任务</div>';
    return;
  }
  for (const status of STATUS_ORDER) {
    const group = tasks.filter((t) => t.status === status);
    if (!group.length) continue;
    const col = document.createElement('div');
    col.className = 'board-col';
    col.innerHTML = `<div class="board-col-title">${status}<span class="count">${group.length}</span></div>`;
    for (const t of group) {
      const card = document.createElement('div');
      card.className = 'task-card';
      card.innerHTML = `
        <div class="task-id">${escapeHtml(t.id)}</div>
        <div class="task-title">${escapeHtml(t.title)}</div>
        <div class="task-meta">
          <span>${t.assignee ? '@' + escapeHtml(nameOf(t.assignee)) : '未指派'}</span>
        </div>`;
      card.onclick = () => openTask(t.id);
      col.appendChild(card);
    }
    board.appendChild(col);
  }
}

function renderStatus() {
  const sp = $('speaker');
  if (state.current) {
    sp.innerHTML = `<span class="dot busy"></span><span><b>${escapeHtml(nameOf(state.current.agentId))}</b> 正在发言</span>`;
  } else if (state.busy) {
    sp.innerHTML = `<span class="dot busy"></span><span>执行中…</span>`;
  } else if (state.pending > 0) {
    // 队列里还有人：不能说"等待人类"，否则看起来像卡住了
    sp.innerHTML = `<span class="dot busy"></span><span>还有 <b>${state.pending}</b> 人待发言</span>`;
  } else if (state.currentSpeakerLast) {
    sp.innerHTML = `<span class="dot idle"></span><span>已停止发言，等你决定</span>`;
  } else {
    sp.innerHTML = `<span class="dot idle"></span><span>等待人类</span>`;
  }
  $('turn-count').textContent = String(state.turnCount);
  $('usage').textContent = fmtTokens(state.usage);
  $('btn-interrupt').disabled = !state.current;
}

/* ---------------- 消息流 ---------------- */

function ensureTurnEl(agentId) {
  if (state.current?.agentId === agentId) return state.current;

  const wrap = document.createElement('div');
  wrap.className = 'msg agent streaming';

  const av = avatarEl(nameOf(agentId));
  const content = document.createElement('div');

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = `
    <span class="msg-who" style="color:${colorFor(nameOf(agentId))}">${escapeHtml(nameOf(agentId))}</span>
    <span class="msg-role">${memberById(agentId)?.role === 'leader' ? '头头' : '成员'}</span>
    <span class="msg-time"></span>`;

  const thinking = document.createElement('details');
  thinking.className = 'thinking hidden';
  thinking.innerHTML = '<summary>思考了 0.0 秒</summary><div class="thinking-body"></div>';

  const textEl = document.createElement('div');
  textEl.className = 'msg-body';

  const actions = document.createElement('div');
  actions.className = 'action-area';

  content.append(head, thinking, textEl, actions);
  wrap.append(av, content);
  $('stream').appendChild(wrap);
  scrollToBottom();

  state.current = { agentId, el: wrap, textEl, thinking, actions, head, text: '', thinkText: '', startedAt: Date.now() };
  return state.current;
}

function finishTurn(durationMs) {
  const cur = state.current;
  if (!cur) return;
  cur.el.classList.remove('streaming');
  const timeEl = cur.head.querySelector('.msg-time');
  if (timeEl && durationMs) timeEl.textContent = `${(durationMs / 1000).toFixed(1)}s`;
  else if (timeEl) timeEl.textContent = '';
  if (cur.text) cur.textEl.innerHTML = renderBody(cur.text);
  if (cur.thinking.classList.contains('hidden')) cur.thinking.remove();
  state.current = null;
  state.turnCount += 1;
  renderStatus();
}

function appendHumanMessage(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg human';
  const av = avatarEl('老板');
  const content = document.createElement('div');
  content.innerHTML = `
    <div class="msg-head">
      <span class="msg-who">老板</span>
      <span class="msg-time">${fmtTime(m.at)}</span>
    </div>
    <div class="msg-body">${renderBody(m.body)}</div>`;
  wrap.append(av, content);
  $('stream').appendChild(wrap);
  scrollToBottom();
}

/** 历史里的 agent 消息（重开应用时补渲染，不带流式状态） */
function appendHistoryAgentMessage(m) {
  if (!m.body) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg agent';
  const av = avatarEl(nameOf(m.senderId));
  const content = document.createElement('div');
  content.innerHTML = `
    <div class="msg-head">
      <span class="msg-who" style="color:${colorFor(nameOf(m.senderId))}">${escapeHtml(nameOf(m.senderId))}</span>
      <span class="msg-role">${memberById(m.senderId)?.role === 'leader' ? '头头' : '成员'}</span>
      <span class="msg-time">${fmtTime(m.at)}${m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(1)}s` : ''}</span>
    </div>
    <div class="msg-body">${renderBody(m.body)}</div>`;
  wrap.append(av, content);
  $('stream').appendChild(wrap);
}

/** 写操作小行：挂在当前发言下面，让人能实时看到"它动了什么" */
function appendToolNote(ev) {
  const host = state.current?.actions ?? $('stream');
  const label = { write: '写入', edit: '编辑', bash: '执行命令' }[ev.action] ?? ev.action;
  const target = ev.action === 'bash' ? ev.command : ev.path;
  const el = document.createElement('div');
  el.className = `tool-note ${ev.action}`;
  el.innerHTML = `<span class="tool-badge">${label}</span><code>${escapeHtml(String(target ?? '').slice(0, 200))}</code>`;
  host.appendChild(el);
  scrollToBottom();
}

/** 历史上发生过的写操作，统一收在消息流末尾（不打断对话可读性） */
function renderHistoricalTools(log) {
  const writes = log.filter((e) => e.action === 'write' || e.action === 'edit' || e.action === 'bash');
  if (!writes.length) return;

  const details = document.createElement('details');
  details.className = 'tool-history';
  const head = document.createElement('summary');
  head.textContent = `历史写操作（${writes.length} 条）`;
  details.appendChild(head);

  for (const e of writes) {
    const label = { write: '写入', edit: '编辑', bash: '执行' }[e.action] ?? e.action;
    const target = e.action === 'bash' ? e.command : e.path;
    const row = document.createElement('div');
    row.className = `tool-note ${e.action}`;
    row.innerHTML = `
      <span class="tool-badge">${label}</span>
      <code>${escapeHtml(String(target ?? '').slice(0, 200))}</code>
      <span class="tool-who">${escapeHtml(nameOf(e.agentId))}</span>`;
    details.appendChild(row);
  }
  $('stream').appendChild(details);
}

function appendSystemNote(text, level = 'info') {
  const el = document.createElement('div');
  el.className = `sys-note ${level === 'warn' ? 'warn' : ''}`;
  el.textContent = text;
  $('stream').appendChild(el);
  scrollToBottom();
}

function appendActionCard(results) {
  const host = state.current?.actions ?? $('stream');
  for (const r of results) {
    const card = document.createElement('div');
    card.className = `action-card ${r.ok ? 'ok' : 'fail'}`;
    card.innerHTML = `
      <span class="icon">${r.ok ? '✓' : '✗'}</span>
      <span>
        <span class="label">${escapeHtml(r.label ?? '')}</span>
        ${r.detail ? ` <span class="detail">${escapeHtml(r.detail)}</span>` : ''}
        ${r.reason ? ` <span class="detail">${escapeHtml(r.reason)}</span>` : ''}
      </span>`;
    host.appendChild(card);
  }
  scrollToBottom();
}

function scrollToBottom() {
  const s = $('stream');
  s.scrollTop = s.scrollHeight;
}

/* ---------------- SSE ---------------- */

function handle(ev) {
  switch (ev.type) {
    case 'room.init':
      state.members = ev.members;
      state.leaderId = ev.room.leaderId;
      state.registry = ev.registry ?? [];
      state.toolLog = ev.toolLog ?? [];
      $('room-name').textContent = ev.room.name;
      for (const t of ev.tasks) state.tasks.set(t.id, t);
      for (const [k, v] of ev.roster) state.roster.set(k, v);
      renderMemberList();
      renderRoster();
      renderRepos();
      renderBoard();
      // 计数与用量从历史恢复，否则刷新后看起来像没跑过
      state.turnCount = ev.history.filter((m) => m.senderId !== 'human').length;
      state.usage = ev.history.reduce((sum, m) => sum + (m.usageTokens ?? 0), 0);
      for (const m of ev.history) {
        if (m.senderId === 'human') appendHumanMessage(m);
        else appendHistoryAgentMessage(m);
      }
      // 刷新后也要能看到历史写操作（否则"日志"只活在当轮，等于没用）
      renderHistoricalTools(ev.toolLog ?? []);
      scrollToBottom();
      renderStatus();
      break;

    case 'snapshot':
      for (const t of ev.tasks) state.tasks.set(t.id, t);
      for (const [k, v] of ev.roster) state.roster.set(k, v);
      renderBoard();
      renderRoster();
      state.busy = ev.busy;
      renderStatus();
      break;

    case 'turn.start': {
      state.busy = true;
      state.pending = ev.pending ?? 0;
      ensureTurnEl(ev.agentId);
      renderStatus();
      break;
    }

    case 'queued':
      if (!ev.alreadyQueued) state.pending = Math.max(state.pending, ev.pending ?? 1);
      renderStatus();
      break;

    case 'text': {
      const cur = state.current ?? ensureTurnEl(ev.agentId);
      if (!ev.text) break;
      cur.text += ev.text;
      cur.textEl.textContent = cur.text;
      // 流式期间不解析动作块，只做轻量截断显示
      if (/```action/.test(cur.text)) {
        cur.textEl.textContent = cur.text.split('```action')[0];
      }
      scrollToBottom();
      break;
    }

    case 'thinking': {
      const cur = state.current ?? ensureTurnEl(ev.agentId);
      cur.thinkText += ev.text;
      cur.thinking.classList.remove('hidden');
      cur.thinking.querySelector('.thinking-body').textContent = cur.thinkText;
      const secs = ((Date.now() - cur.startedAt) / 1000).toFixed(1);
      cur.thinking.querySelector('summary').textContent = `思考了 ${secs} 秒`;
      break;
    }

    case 'usage':
      state.usage += (ev.inputTokens ?? 0) + (ev.outputTokens ?? 0);
      renderStatus();
      break;

    case 'message': {
      const m = ev.message;
      if (m.senderId === 'human') break;
      if (state.current?.agentId === m.senderId) {
        state.current.text = m.body;
        state.current.textEl.innerHTML = renderBody(m.body);
      }
      finishTurn(m.durationMs);
      state.currentSpeakerLast = m.senderId;
      // 队列里还有人就不能显示"等待人类"
      state.pending = ev.pending ?? 0;
      state.busy = state.pending > 0;
      renderStatus();
      break;
    }

    case 'action.results':
      appendActionCard(ev.results);
      break;

    case 'task.created':
      state.tasks.set(ev.task.id, ev.task);
      renderBoard();
      appendActionCard([{ ok: true, label: '新任务', detail: `${ev.task.id} ${ev.task.title}` }]);
      break;

    case 'tool': {
      // 写操作实时显示成小行：改了什么，一眼看到
      if (ev.action === 'write' || ev.action === 'edit' || ev.action === 'bash') {
        appendToolNote(ev);
      }
      state.toolLog.push(ev);
      break;
    }

    case 'task.updated': {
      const t = state.tasks.get(ev.id);
      if (t) Object.assign(t, ev.patch);
      renderBoard();
      break;
    }

    case 'roster.updated':
      if (ev.roster) state.roster.set(ev.agentId, ev.roster);
      renderRoster();
      break;

    case 'broadcast':
      appendSystemNote(`广播：${ev.recipients.length} 人将依次回应（${ev.recipients.map((r) => '@' + nameOf(r)).join(' → ')}）`);
      break;

    case 'loop.warning': {
      const detail = (ev.reasons ?? []).map((r) => r.text).join('；');
      appendSystemNote(`循环迹象：${detail}`, 'warn');
      $('loop-warn').classList.remove('hidden');
      $('loop-warn').title = detail;
      $('btn-stop').classList.add('urgent');
      break;
    }

    case 'guard.reset':
      $('loop-warn').classList.add('hidden');
      $('btn-stop').classList.remove('urgent');
      break;

    case 'notice':
      appendSystemNote(ev.text, ev.level);
      break;

    case 'failure':
      appendSystemNote(`${nameOf(ev.agentId)} 失败：${ev.reason}${ev.detail ? ' — ' + ev.detail : ''}`, 'warn');
      finishTurn();
      state.busy = false;
      renderStatus();
      break;

    case 'context.nearLimit':
      appendSystemNote(`上下文接近上限（${Math.round((ev.ratio ?? 0) * 100)}%），下一轮将压缩`, 'warn');
      break;

    case 'compact.start':
      appendSystemNote('正在压缩上下文…');
      break;

    case 'compact.done':
      appendSystemNote('已压缩并轮换会话');
      break;

    case 'idle':
      state.busy = false;
      state.pending = 0;
      renderStatus();
      break;

    case 'stopped':
      appendSystemNote('房间已停止', 'warn');
      finishTurn();
      state.busy = false;
      renderStatus();
      break;

    case 'interrupted':
      appendSystemNote(`${nameOf(ev.agentId)} 被打断（已输出内容保留）`, 'warn');
      break;

    default:
      break;
  }
}

function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    try { handle(JSON.parse(e.data)); } catch (err) { console.error('bad event', err, e.data); }
  };
  es.onerror = () => {
    appendSystemNote('与后台断开，正在重连…', 'warn');
  };
}

/* ---------------- 输入 ---------------- */

const names = () => state.members.map((m) => m.name);

function updateMentionHint() {
  const v = $('input').value;
  const hint = $('mention-hint');

  // 补全：正在打某个 @名字
  const at = v.lastIndexOf('@');
  if (at >= 0) {
    const frag = v.slice(at + 1).split(/\s/)[0];
    if (frag.length > 0 && !v.slice(at + 1).includes(' ')) {
      const hits = names().filter((n) => n.toLowerCase().startsWith(frag.toLowerCase()));
      if (hits.length) {
        hint.textContent = '点名：' + hits.map((h) => '@' + h).join('  ');
        hint.className = 'mention-hint';
        return;
      }
    }
  }

  // 广播预告：不写 @ 会叫起所有人，得先让人知道
  const mentionsAnyone = /[@＠]\s*[\w一-鿿]/.test(v);
  if (v.trim() && !mentionsAnyone) {
    const order = broadcastOrder();
    hint.textContent = `未点名 → 将依次通知 ${order.length} 人：${order.map((n) => '@' + n).join(' → ')}`;
    hint.className = 'mention-hint warn';
    return;
  }

  hint.textContent = '';
  hint.className = 'mention-hint';
}

/** 与后端一致：头头优先，其余按成员顺序 */
function broadcastOrder() {
  const leader = state.members.filter((m) => m.role === 'leader');
  const rest = state.members.filter((m) => m.role !== 'leader');
  return [...leader, ...rest].map((m) => m.name);
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  updateMentionHint();

  const res = await fetch('/api/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    appendSystemNote(`发送失败：${e.error ?? res.status}`, 'warn');
  }
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

/* ---------------- 任务抽屉 ---------------- */

async function openTask(id) {
  const t = state.tasks.get(id);
  if (!t) return;
  $('drawer').classList.remove('hidden');
  $('drawer-title').textContent = `${t.id}  ${t.title}`;
  const body = $('drawer-body');
  body.innerHTML = `<div class="link-note">加载中…</div>`;

  const related = state.messages.filter((m) => m.taskId === id);

  let html = `
    <h3>状态</h3>
    <div>${escapeHtml(t.status)} ${t.assignee ? `→ @${escapeHtml(nameOf(t.assignee))}` : ''}</div>
    <h3>相关讨论</h3>`;
  if (related.length) {
    html += related.map((m) => `<div class="link-note"><b>${escapeHtml(nameOf(m.senderId))}</b>：${escapeHtml(m.body.slice(0, 400))}</div>`).join('');
  } else {
    html += `<div class="link-note">该任务还没有关联讨论</div>`;
  }

  body.innerHTML = html;

  // 尝试拉 diff（只有建过 worktree 的任务才有）
  try {
    const res = await fetch(`/api/diff?task=${encodeURIComponent(id)}`);
    if (res.ok) {
      const d = await res.json();
      const esc = escapeHtml(d.patch ?? '');
      const colored = esc.split('\n').map((line) => {
        if (line.startsWith('+')) return `<span class="diff-add">${line}</span>`;
        if (line.startsWith('-')) return `<span class="diff-del">${line}</span>`;
        return line;
      }).join('\n');
      body.insertAdjacentHTML('beforeend', `<h3>改动（${d.files.length} 个文件）</h3><pre>${colored}</pre>`);
    }
  } catch { /* 没有 worktree，正常 */ }
}

/* ---------------- 启动 ---------------- */

$('btn-send').onclick = send;
$('btn-stop').onclick = async () => { await fetch('/api/stop', { method: 'POST' }); };
$('btn-interrupt').onclick = async () => { await fetch('/api/interrupt', { method: 'POST' }); };
$('drawer-close').onclick = () => $('drawer').classList.add('hidden');
$('drawer').onclick = (e) => { if (e.target.id === 'drawer') $('drawer').classList.add('hidden'); };

$('input').addEventListener('input', (e) => { autoGrow(e.target); updateMentionHint(); });
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

renderStatus();
connect();
