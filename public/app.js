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
  overridden: false,
  stopped: false,
  headPassiveWake: true,
  resumeTarget: null,   // 有可续的轮次时，「继续」按钮变成「接着做完」
  paused: null,      // {reason, detail, at}
  continueToken: 0,  // "继续"按钮的用途：停止时=解除停止；停顿原因在时=接着往下走
  // ---- 多房间 ----
  rooms: [],          // [{id,name,memberCount,lastActivityAt}]
  activeRoomId: null,
  singleFallback: false,
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
  // 空房间：把"添加第一个成员"放在最显眼的位置。
  // 老板的用法是"先有头头，再让头头造人"，第一个成员默认就是头头。
  $('btn-first-member').classList.toggle('hidden', state.members.length > 0);
  for (const m of state.members) {
    const li = document.createElement('li');
    li.className = 'member';
    li.title = '点开设置：档位 / 模型 / 思考等级 / 启动参数';
    const modelInfo = [m.model, m.effort].filter(Boolean).join(' · ');
    li.innerHTML = `
      <div class="member-top">
        <span class="member-name">${escapeHtml(m.name)}</span>
        <span class="member-role ${m.role === 'leader' ? '' : 'member'}">${m.role === 'leader' ? '头头' : '成员'}</span>
      </div>
      <div class="member-meta">
        <span>${escapeHtml(m.backend)}</span>
        <span class="tier-badge ${m.tier}">${tierLabel(m.tier)}</span>
        ${modelInfo ? `<span class="member-model">${escapeHtml(modelInfo)}</span>` : ''}
        ${m.overridesTier ? '<span class="member-flag" title="启动参数里有覆盖档位的项">档位被参数覆盖</span>' : ''}
      </div>
      ${m.sessionResetReason && m.role === 'leader' ? `<div class="session-reset" title="${escapeHtml(m.sessionResetReason)}">上下文已重置</div>` : ''}
      ${m.timeoutSource === 'legacy' ? `<div class="timeout-legacy" title="room.json 里手写了 timeoutMs，界面上的单轮上限对它不生效">上限来自配置手写 · 实际 ${escapeHtml(String(m.effectiveTimeoutMinutes))} 分钟</div>` : ''}
      ${approvalNote(m)}`;
    li.querySelector('.member-top').prepend(avatarEl(m.name));
    li.onclick = () => openMemberSettings(m.id);
    ul.appendChild(li);
  }
}

function cabTierLabel(tier) {
  return {
    readonly: '无工具', read: '可读', 'write-ask': '可写·询问', write: '可写', 'write-exec': '可写+执行',
  }[tier] ?? tier;
}

function tierLabel(tier) {
  if (tier === 'readonly') return '无工具';
  if (tier === 'read') return '可读';
  if (tier === 'write-ask') return '可写·询问';
  if (tier === 'write') return '可写';
  if (tier === 'write-exec') return '可写+执行';
  return tier ?? '';
}

/**
 * 说清"问不问人"，而不是只说"能不能写"。
 * 默认档是**从来不问**，用户经常误以为"每次都会问我"。
 */
/**
 * 说清这个档位**实际**能干什么。
 *
 * "自动批准"这种话不够：write-exec 在没有命令白名单时**一条命令都跑不了**，
 * 有白名单时能跑的那几条又不受目录限制。界面必须把这两种情况分开写，
 * 否则就会重演"界面说有、实际没有"，或者反过来"界面没说、实际能连外网"。
 */
function approvalNote(member) {
  const tier = member.tier;
  if (tier === 'readonly' || tier === 'read') return '';
  if (tier === 'write-ask') return '<div class="approval-note">文件写入：每次询问</div>';
  const base = '<div class="approval-note auto">文件写入：自动批准，不会询问</div>';
  if (tier !== 'write-exec') return base;

  const cmds = String(member.allowedCommands ?? '').trim();
  if (!cmds) {
    return '<div class="approval-note">命令：<b>一条都不许</b>（需要的话在设置里填）</div>';
  }
  return `<div class="approval-note cmd">命令：仅 ${escapeHtml(cmds)} <br>`
    + '<span class="cmd-risk">这些命令不受目录限制</span></div>';
}

function renderRoster() {
  const ul = $('roster-list');
  ul.innerHTML = '';
  // 每个成员都列出来（不只是有自述的），否则没自述的人根本没法编辑
  for (const m of state.members) {
    const r = state.roster.get(m.id) ?? {};
    const duty = r.humanDuties ?? r.selfDuties ?? '（未填写）';
    const edited = r.humanDuties != null;

    const li = document.createElement('li');
    li.className = 'roster-item';
    li.innerHTML = `
      <div class="roster-line">
        <b>${escapeHtml(m.name)}</b>：<span class="roster-duty">${escapeHtml(duty)}</span>
        <button class="mini-btn edit-roster" title="编辑职责">✎</button>
      </div>
      ${edited ? '<div class="roster-flag">人已编辑</div>' : ''}`;

    li.querySelector('.edit-roster').onclick = (e) => {
      e.stopPropagation();
      startRosterEdit(li, m, duty === '（未填写）' ? '' : duty);
    };
    ul.appendChild(li);
  }
}

function startRosterEdit(li, member, current) {
  li.innerHTML = `
    <div class="roster-edit">
      <input class="roster-input" value="${escapeHtml(current)}" placeholder="这个成员负责什么、能接什么任务">
      <div class="roster-edit-actions">
        <button class="btn primary tiny save">保存</button>
        <button class="btn ghost tiny cancel">取消</button>
      </div>
    </div>`;
  const input = li.querySelector('.roster-input');
  input.focus();
  input.select();

  const save = async () => {
    const duties = input.value.trim();
    const res = await fetch('/api/roster', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: member.id, duties }),
    });
    if (!res.ok) {
      appendSystemNote('保存职责失败', 'warn');
      renderRoster();
      return;
    }
    appendSystemNote(`已更新 ${member.name} 的职责（之后它发言时会看到新版本）`);
    renderRoster();
  };

  li.querySelector('.save').onclick = save;
  li.querySelector('.cancel').onclick = () => renderRoster();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') renderRoster();
  };
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
          ${taskLooksStuck(t) ? '<span class="task-warn" title="说明里写着阻塞，但状态仍是待办——账不平，点开核对">⚠️ 账不平</span>' : ''}
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
  // 停止是一个"刹车"，必须一眼看到，而且要有松开的地方
  $('stopped-badge').classList.toggle('hidden', !state.stopped);

  // 停顿原因：有就写清楚（"停在：@ 了没权限叫的人"），没有就不显示
  const pausedEl = $('paused-badge');
  if (state.paused && !state.stopped && !state.current && !state.busy) {
    pausedEl.classList.remove('hidden');
    pausedEl.innerHTML = `停在：<strong>${escapeHtml(PAUSE_LABEL[state.paused.reason] ?? state.paused.reason)}</strong>`
      + (state.paused.detail ? ` · ${escapeHtml(state.paused.detail.slice(0, 80))}` : '');
    pausedEl.title = state.paused.detail ?? '';
  } else {
    pausedEl.classList.add('hidden');
  }

  // 「继续」在停止时用来松刹车，在停住时用来接着往下走
  const canContinue = state.stopped || (Boolean(state.paused) && !state.busy && !state.current);
  $('btn-resume').classList.toggle('hidden', !canContinue);
  $('btn-resume').textContent = state.stopped
    ? '▶ 继续'
    : (state.resumeTarget ? '▶ 接着做完' : '▶ 接着推进');
  $('btn-stop').classList.toggle('hidden', state.stopped);
}

/* ---------------- 房间列表 ---------------- */

/** URL 里的房间：`#room=<id>`。刷新要回到原房间，所以必须进 URL。 */
function hashRoomId() {
  const m = location.hash.match(/^#room=([^&]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function setHashRoom(id) {
  if (id) history.replaceState(null, '', `#room=${encodeURIComponent(id)}`);
  else history.replaceState(null, '', location.pathname + location.search);
}

function showRoomList() {
  $('rooms-view').classList.remove('hidden');
  // 有当前房间时给一个"返回"出口；没有房间时列表本身就是唯一界面
  $('rooms-close').classList.toggle('hidden', !state.activeRoomId);
  renderRoomList();
  $('rooms-new-name').focus();
}

function hideRoomList() {
  $('rooms-view').classList.add('hidden');
}

function fmtAgo(iso) {
  if (!iso) return '还没有对话';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚有动静';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function renderRoomList() {
  const list = $('rooms-list');
  list.innerHTML = '';

  $('rooms-fallback').classList.toggle('hidden', !state.singleFallback);
  if (state.singleFallback) {
    $('rooms-fallback').textContent = '多房间迁移未完成，当前只能使用这一个房间（数据未被改动）。';
  }

  if (!state.rooms.length) {
    const empty = document.createElement('div');
    empty.className = 'rooms-empty';
    empty.textContent = '还没有房间。在下面输入一个名字就能建第一个。';
    list.appendChild(empty);
    return;
  }

  for (const r of state.rooms) {
    const card = document.createElement('div');
    card.className = `room-card${r.id === state.activeRoomId ? ' active' : ''}`;
    card.innerHTML = `
      <div class="room-card-main">
        <div class="room-card-name">${escapeHtml(r.name)}</div>
        <div class="room-card-meta">${r.memberCount} 个成员 · ${fmtAgo(r.lastActivityAt)}</div>
      </div>
      ${r.id === state.activeRoomId ? '<span class="room-card-current">当前</span>' : ''}
      <button class="icon-btn rename" title="只改显示名，不影响对话记录">重命名</button>
      <button class="icon-btn del" title="删除房间（目录进 .trash，不清空）">删除</button>`;

    card.onclick = (e) => {
      if (e.target.closest('.rename, .del')) return;
      enterRoom(r.id);
    };
    card.querySelector('.del').onclick = (e) => {
      e.stopPropagation();
      deleteRoom(r);
    };
    card.querySelector('.rename').onclick = async (e) => {
      e.stopPropagation();
      const name = window.prompt('房间的新名字（只改显示名，对话记录不受影响）：', r.name);
      if (!name || name.trim() === r.name) return;
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', id: r.id, name: name.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return appendSystemNote(`重命名失败：${data.error ?? res.status}`, 'warn');
      r.name = data.room?.name ?? name.trim();
      if (r.id === state.activeRoomId) $('room-name').textContent = r.name;
      renderRoomList();
    };
    list.appendChild(card);
  }
}

/** 左栏的房间列表。这里才是日常入口；房间里也能看到别的房间并一键切过去。 */
function renderSidebarRooms() {
  const ul = $('room-list');
  if (!ul) return;
  ul.innerHTML = '';

  if (!state.rooms.length) {
    const li = document.createElement('li');
    li.className = 'room-item empty';
    li.textContent = '还没有房间';
    ul.appendChild(li);
    return;
  }

  for (const r of state.rooms) {
    const li = document.createElement('li');
    li.className = `room-item${r.id === state.activeRoomId ? ' active' : ''}`;
    li.innerHTML = `
      <button class="room-item-main" type="button">
        <span class="room-item-name">${escapeHtml(r.name)}</span>
        <span class="room-item-meta">${r.memberCount} 人</span>
      </button>
      <button class="room-item-del" type="button" title="删除房间">×</button>`;
    li.querySelector('.room-item-main').onclick = () => enterRoom(r.id);
    li.querySelector('.room-item-del').onclick = (e) => {
      e.stopPropagation();
      deleteRoom(r);
    };
    ul.appendChild(li);
  }
}

/**
 * 删除房间。**二次确认在这里**（服务端只管"不能删最后一个"和"先切后删"）。
 * 文案要说清两件事：数据进了 .trash 而不是被清空；删的是当前房间会先换房间。
 */
async function deleteRoom(r) {
  if (state.rooms.length <= 1) {
    appendSystemNote('不能删除最后一个房间。先新建一个，再删这个。', 'warn');
    return;
  }
  const isActive = r.id === state.activeRoomId;
  const lines = [`删除房间「${r.name}」？`, ''];
  if (isActive) lines.push('这是当前房间：会先切到另一个房间，然后再删除。');
  lines.push('房间目录会移到 rooms/.trash-*（不会被清空），但界面上不再出现，对话也不会再显示。');
  lines.push('', '确认删除吗？');
  if (!window.confirm(lines.join('\n'))) return;

  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', id: r.id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return appendSystemNote(`删除失败：${data.error ?? res.status}`, 'warn');

  if (data.dropped) appendSystemNote(`切换房间时丢弃了 ${data.dropped} 条过期排队发言`, 'warn');
  if (data.killed === false) appendSystemNote('旧房间的进程未在超时内退出，已冻结其写入', 'warn');
  appendSystemNote(`已删除房间「${data.deleted?.name ?? r.name}」`);

  // 通常 rooms.updated / room.init 会先到；这里同步一份，避免列表短暂显示已删房间
  state.rooms = state.rooms.filter((x) => x.id !== r.id);
  if (isActive && data.switchedTo) {
    state.activeRoomId = data.switchedTo;
    setHashRoom(data.switchedTo);
  }
  renderSidebarRooms();
  renderRoomList();
}

/** 进入房间：写 hash 并让服务端切过去。状态由随后的 room.init 驱动。 */
let pendingEnter = null;

async function enterRoom(id) {
  setHashRoom(id);
  if (id === state.activeRoomId) {
    hideRoomList();
    return;
  }
  pendingEnter = id;
  appendSystemNote('正在切换房间…');
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'switch', id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    appendSystemNote(`切换失败：${data.error ?? res.status}`, 'warn');
    setHashRoom(state.activeRoomId);
    return;
  }
  if (data.dropped) appendSystemNote(`切换房间，丢弃了 ${data.dropped} 条过期排队发言`, 'warn');
  if (data.killed === false) appendSystemNote('旧房间的进程未在超时内退出，已冻结其写入', 'warn');

  // 服务端说"本来就是这个房间"（比如刚建完就已经切过去了）→ 不会有新的 room.init 到达，
  // 必须就地收尾，否则会卡在列表页等一个永远不来的事件。
  if (data.changed === false) {
    pendingEnter = null;
    state.activeRoomId = id;
    hideRoomList();
  }
}

/**
 * room.init 到达后决定显示列表还是房间内容。规则只有三条：
 *  1. 刚从列表点进来（pendingEnter 命中）→ 进房间
 *  2. URL 里的房间就是当前房间（刷新 / 收藏链接）→ 进房间
 *  3. 其余（首次打开、URL 指向不存在的房间）→ 落地页 = 房间列表
 */
function decideView(previousRoomId) {
  const wanted = hashRoomId();

  if (pendingEnter && pendingEnter === state.activeRoomId) {
    pendingEnter = null;
    setHashRoom(state.activeRoomId);
    hideRoomList();
    return;
  }
  pendingEnter = null;

  if (wanted && wanted === state.activeRoomId) {
    hideRoomList();
    return;
  }
  if (wanted && wanted !== state.activeRoomId && state.rooms.some((r) => r.id === wanted)) {
    // 链接指向另一个房间：切过去（enterRoom 会写 hash 并等新的 room.init）
    enterRoom(wanted);
    return;
  }
  // 首次打开 / 无效链接 → 房间列表。
  // 注意这里不改 hash：用户从列表点进房间时才写，刷新才能回到原房间。
  if (!previousRoomId || !wanted) setHashRoom(null);
  showRoomList();
}

/** 把界面清成"刚打开这个房间"的状态（切换房间时用，不能沿用上一个房间的任何东西） */
function resetRoomView() {
  state.members = [];
  state.messages = [];
  state.tasks = new Map();
  state.roster = new Map();
  state.registry = [];
  state.toolLog = [];
  state.current = null;
  state.turnCount = 0;
  state.usage = 0;
  state.busy = false;
  state.pending = 0;
  state.currentSpeakerLast = null;
  // 停止/停顿状态属于房间私有：换房间时必须清掉，
  // 否则新房间会顶着上一个房间的红色「已停止」——和"刷新后徽章撒谎"同一类 bug。
  state.stopped = false;
  state.paused = null;
  state.resumeTarget = null;
  // 换房间要重新判断：新房间可能没有这个问题（也可能是另一个）
  seqWarningDismissed = false;
  $('seq-warn')?.classList.add('hidden');
  $('stream').innerHTML = '';
  $('loop-warn').classList.add('hidden');
  $('btn-stop').classList.remove('urgent');
  $('mention-hint').textContent = '';
  closeMentionMenu();
  setOverridden(false);
}

/** 停顿原因 → 人话（和后端 PAUSE_LABEL 保持一致） */
const PAUSE_LABEL = {
  no_target: '说完了，没点名下一位',
  overreach: '@ 了没权限叫的人',
  only_human: '把话交回给老板',
  continue_cap: '自动接力次数到上限',
  breaker: '连续失败，暂时停用',
  stopped: '你点了「停止」',
  summary: '总结完毕',
  timeout: '超时被中止（不是说完）',
  interrupted: '被打断（这一轮没做完）',
  error: '出错停住',
  cleared: '已恢复',
};

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

/**
 * 一轮没有正常结束 → 一句人话；正常轮返回 null。
 *
 * 硬上限杀掉的那一轮最常见的形态是**一个字都没有**：AI 还在联网取资料，
 * 进程到点被杀，body 为空。以前历史里 `if (!m.body) return` 整条跳过，
 * 实时分支渲染成空气泡后照常收尾——用户只看到房间停了，一句解释都没有。
 *
 * `status` 是 room.js 落的原值：completed / timeout / crashed / failed /
 * interrupted / 已中断。只有非正常值才显示，正常轮不加噪音。
 */
function turnFailureText(m) {
  const secs = m?.durationMs ? `${Math.round(m.durationMs / 1000)}s` : null;
  const hasBody = Boolean(String(m?.body ?? '').trim());
  const partial = hasBody ? '输出不完整' : '无输出';
  switch (m?.status) {
    case 'timeout':
      return secs ? `本轮超时（${secs}，${partial}）` : `本轮超时（${partial}）`;
    case 'crashed':
      return `本轮崩溃（${partial}）`;
    case 'failed':
      return `本轮失败（${partial}）`;
    case 'interrupted':
    case '已中断':
      return `本轮已中断（${partial}）`;
    default:
      return null;
  }
}

/** 历史里的 agent 消息（重开应用时补渲染，不带流式状态） */
function appendHistoryAgentMessage(m) {
  if (m.passed) return appendPassedNote(m.senderId);
  const failText = turnFailureText(m);
  // 正文为空、也不是异常结束（旧数据里的空轮）：没有可说的，保持不显示
  if (!m.body && !failText) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg agent';
  const av = avatarEl(nameOf(m.senderId));
  const content = document.createElement('div');
  content.innerHTML = `
    <div class="msg-head">
      <span class="msg-who" style="color:${colorFor(nameOf(m.senderId))}">${escapeHtml(nameOf(m.senderId))}</span>
      <span class="msg-role">${memberById(m.senderId)?.role === 'leader' ? '头头' : '成员'}</span>
      ${m.isSummary ? '<span class="summary-tag">总结</span>' : ''}
      <span class="msg-time">${fmtTime(m.at)}${m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(1)}s` : ''}</span>
    </div>
    <div class="msg-body">${renderBody(m.body)}</div>`;
  if (m.isSummary) wrap.classList.add('summary');
  wrap.append(av, content);
  $('stream').appendChild(wrap);
  // 失败/超时单独一行，不混进正常发言；空 body 的那一轮也靠它才算"看得见"
  if (failText) appendSystemNote(`${nameOf(m.senderId)} ${failText}`, 'warn');
}

/** 把刚说完的那条标记成总结：事后翻记录要能一眼分清结论和过程 */
function markAsSummary() {
  const msgs = $('stream').querySelectorAll('.msg.agent');
  const last = msgs[msgs.length - 1];
  if (!last) return;
  last.classList.add('summary');
  const head = last.querySelector('.msg-head');
  if (head && !head.querySelector('.summary-tag')) {
    const tag = document.createElement('span');
    tag.className = 'summary-tag';
    tag.textContent = '总结';
    head.appendChild(tag);
  }
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

/** 用量提示：比普通提示更醒目一点，但不用警告色（这不是错误） */
function appendUsageNote(text) {
  const el = document.createElement('div');
  el.className = 'usage-note';
  el.innerHTML = `<span class="usage-note-icon">◔</span><span>${escapeHtml(text)}</span>`;
  $('stream').appendChild(el);
  scrollToBottom();
}

/** 被动唤醒后头头选择不回应——灰色小条，和失败的红黄提示分开 */
function appendPassedNote(agentId) {
  const el = document.createElement('div');
  el.className = 'passed-note';
  el.innerHTML = `<span class="passed-icon">✓✓</span><span>${escapeHtml(nameOf(agentId))} 已读，未回应</span>`;
  $('stream').appendChild(el);
  scrollToBottom();
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
    case 'room.init': {
      const previousRoomId = state.activeRoomId;
      state.activeRoomId = ev.activeRoomId ?? null;
      state.rooms = ev.rooms ?? [];
      state.singleFallback = Boolean(ev.singleFallback);

      // 没有房间：界面上只剩"新建房间"这一条路
      if (!ev.room) {
        resetRoomView();
        $('room-name').textContent = '房间';
        renderMemberList();
        renderRoster();
        renderRepos();
        renderBoard();
        renderSidebarRooms();
        setHashRoom(null);
        showRoomList();
        break;
      }

      // 换了房间必须整屏重建：成员、消息、看板、护栏、接管徽章全部来自上一个房间的
      // 东西都不能留（"刷新后徽章消失"和"新房间显示已被接管"是同一类界面撒谎）。
      if (previousRoomId && previousRoomId !== ev.room.id) resetRoomView();

      state.members = ev.members;
      state.leaderId = ev.room.leaderId;
      state.registry = ev.registry ?? [];
      state.toolLog = ev.toolLog ?? [];
      state.aiCabTier = ev.aiCabTier ?? 'readonly';
      $('cabtier').value = state.aiCabTier;
      setOverridden(Boolean(ev.overridden));
      state.stopped = Boolean(ev.stopped);
      state.paused = ev.paused ?? null;
      state.resumeTarget = ev.resumeTarget ?? null;
      renderSeqWarning(ev.seqWarning ?? null);
      state.headPassiveWake = ev.headPassiveWake !== false;
      $('passive-wake').checked = state.headPassiveWake;
      if (ev.turnTimeoutMinutes != null) $('room-timeout').value = ev.turnTimeoutMinutes;
      $('room-name').textContent = ev.room.name;
      document.title = `${ev.room.name} · 多 AI 协作房间`;
      for (const t of ev.tasks) state.tasks.set(t.id, t);
      for (const [k, v] of ev.roster) state.roster.set(k, v);
      renderMemberList();
      renderRoster();
      renderRepos();
      renderBoard();
      // 有成员的会话没接上 → 必须在聊天流里说一次，不能只挂在卡片上
      for (const m of state.members) {
        if (m.sessionResetReason) {
          appendSystemNote(`@${m.name} 的上下文已重置（${m.sessionResetReason}），它会忘记之前的对话`, 'warn');
        }
      }
      // 计数与用量从历史恢复，否则刷新后看起来像没跑过
      state.turnCount = ev.history.filter((m) => m.senderId !== 'human').length;
      state.usage = ev.history.reduce((sum, m) => sum + (m.usageTokens ?? 0), 0);
      $('stream').innerHTML = '';
      for (const m of ev.history) {
        if (m.senderId === 'human') appendHumanMessage(m);
        else appendHistoryAgentMessage(m);
      }
      // 刷新后也要能看到历史写操作（否则"日志"只活在当轮，等于没用）
      renderHistoricalTools(ev.toolLog ?? []);
      renderSidebarRooms();
      renderRoomList();
      scrollToBottom();
      renderStatus();

      decideView(previousRoomId);
      break;
    }

    case 'room.paused':
      state.paused = { reason: ev.reason, detail: ev.detail ?? '', at: new Date().toISOString() };
      /**
       * 实时事件也要同步 resumeTarget。
       *
       * 之前只从 room.init 读它，于是**只有刷新后按钮才变「接着做完」**。
       * "刷新才正确"就是错的：用户不会为了看对按钮去刷新。
       */
      state.resumeTarget = ev.resumeTarget ?? null;
      state.busy = false;
      state.pending = 0;
      // 只在真有内容时提示一次；"头头汇报完停住"不该刷成警告色
      if (ev.reason !== 'no_target') {
        appendSystemNote(`停在：${PAUSE_LABEL[ev.reason] ?? ev.reason}${ev.detail ? ` · ${ev.detail}` : ''}`, 'warn');
      }
      renderStatus();
      break;

    case 'cap.continue':
      // 撞到单轮上限但确实在干活 → 系统自己接着做，必须说出来
      state.paused = null;
      appendSystemNote(ev.text ?? '撞到单轮上限，自动接着做');
      renderStatus();
      break;

    case 'resumed.turn':
      appendSystemNote(`${nameOf(ev.agentId)} 接着做上一轮（已输出 ${ev.partialChars ?? 0} 字，不会重做已完成的部分）`);
      break;

    case 'continue.kicked':
      state.paused = null;
      appendSystemNote(ev.text ?? '已让头头接着推进');
      renderStatus();
      break;

    case 'member.updated': {
      const idx = state.members.findIndex((x) => x.id === ev.member.id);
      if (idx >= 0) state.members[idx] = ev.member;
      renderMemberList();
      renderRoster();
      appendSystemNote(`@${ev.member.name} 的设置已更新`
        + (ev.sessionReset ? '（换后端，会话已重置）' : '')
        + (ev.member.overridesTier ? '；档位被启动参数覆盖' : ''));
      break;
    }

    case 'member.removed':
      state.members = state.members.filter((x) => x.id !== ev.agentId);
      renderMemberList();
      renderRoster();
      break;

    case 'rooms.updated':
      state.rooms = ev.rooms ?? [];
      renderRoomList();
      break;

    case 'room.renamed':
      if (ev.id === state.activeRoomId) {
        $('room-name').textContent = ev.name;
        document.title = `${ev.name} · 多 AI 协作房间`;
      }
      renderRoomList();
      break;

    case 'room.settings':
      state.headPassiveWake = ev.headPassiveWake !== false;
      $('passive-wake').checked = state.headPassiveWake;
      if (ev.turnTimeoutMinutes != null) $('room-timeout').value = ev.turnTimeoutMinutes;
      appendSystemNote(ev.headPassiveWake
        ? '成员不 @ 发言会叫醒头头'
        : '已关闭：成员不 @ 发言不再叫醒头头');
      break;

    case 'head.passive_wake':
      // 让老板看得懂头头为什么突然说话
      appendSystemNote(ev.text ?? `成员无 @ 发言，已叫醒头头（${ev.count} 条）`);
      break;

    case 'room.switched':
      appendSystemNote(`已切换到房间「${ev.room.name}」${ev.dropped ? `，丢弃 ${ev.dropped} 条过期发言` : ''}`);
      break;

    case 'halted':
      if (ev.dropped) appendSystemNote(`已停止当前发言，丢弃 ${ev.dropped} 条排队发言`, 'warn');
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
      state.paused = null;
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
      if (m.passed) {
        // 「已读，未回应」：不是失败，也不是发言，必须能一眼区分
        finishTurn(m.durationMs);
        if (state.current?.agentId === m.senderId) state.current = null;
        appendPassedNote(m.senderId);
        state.pending = ev.pending ?? 0;
        state.busy = state.pending > 0;
        renderStatus();
        break;
      }
      if (state.current?.agentId === m.senderId) {
        state.current.text = m.body;
        state.current.textEl.innerHTML = renderBody(m.body, { live: true });
      }
      finishTurn(m.durationMs);
      if (m.isSummary) markAsSummary();
      // 超时/崩溃/中断必须留一条可见记录：空 body 的空气泡等于什么都没说
      const failText = turnFailureText(m);
      if (failText) appendSystemNote(`${nameOf(m.senderId)} ${failText}`, 'warn');
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

    case 'cabtier.updated':
      state.aiCabTier = ev.tier;
      $('cabtier').value = ev.tier;
      appendSystemNote(`AI 创建成员的最高权限已改为「${cabTierLabel(ev.tier)}」`);
      break;

    case 'member.created':
      // 头头自己加的人：立即出现在成员列表里
      if (!state.members.some((m) => m.id === ev.member.id)) {
        state.members.push(ev.member);
        renderMemberList();
        renderRoster();
      }
      appendSystemNote(
        `@${ev.member.name} 已加入（${ev.member.backend} · ${tierLabel(ev.member.tier)}）`
        + (ev.reason ? `—— 理由：${ev.reason}` : ''),
      );
      break;

    case 'registry.updated':
      state.registry = ev.registry ?? [];
      renderRepos();
      break;

    case 'takeover':
      setOverridden(true);
      appendSystemNote(ev.dropped ? `已接管，丢弃了 ${ev.dropped} 条过期的排队发言` : '已接管：头头暂停自动发言', 'warn');
      break;

    case 'handback':
      setOverridden(false);
      appendSystemNote('已交还控制权');
      break;

    case 'summary.requested':
      appendSystemNote(`${nameOf(ev.agentId)} 正在总结（说完房间会停住）`);
      break;

    case 'summary.done':
      appendSystemNote('总结完成，房间已停住等你决定');
      break;

    case 'task.accepted':
      appendSystemNote(ev.action === 'merge'
        ? `任务 ${ev.id} 已合并进主分支（commit ${ev.commit ?? '?'}）`
        : `任务 ${ev.id} 的改动已丢弃`);
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

    case 'usage.warning':   // 用量提示：只提示不拦截
      // 只提示不拦截：老板说过不用考虑消耗，这里只让他知道钱花在哪
      appendUsageNote(ev.text);
      break;

    case 'notice':
      // 慢启动提示是"它还活着"的信号，不是警告：用 info 样式，别用黄色
      appendSystemNote(ev.text, ev.slowStart ? 'info' : ev.level);
      break;

    case 'retry':
      appendSystemNote(`${nameOf(ev.agentId)} 续做一次：${ev.reason}`, 'info');
      break;

    case 'retry.given-up':
      appendSystemNote(`${nameOf(ev.agentId)} 不会自动续做：${ev.reason}`, 'warn');
      break;

    case 'failure': {
      // reason 是代码里的枚举值，直接给人看很生硬；detail 已由后端清掉 CLI 噪音
      const REASON_CN = { timeout: '超时', crashed: '崩溃', failed: '运行失败', interrupted: '被打断' };
      appendSystemNote(
        `${nameOf(ev.agentId)} ${REASON_CN[ev.reason] ?? ev.reason}${ev.detail ? ' — ' + ev.detail : ''}`,
        'warn',
      );
      finishTurn();
      state.busy = false;
      renderStatus();
      break;
    }

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
      state.stopped = true;
      state.busy = false;
      state.pending = 0;
      appendSystemNote(ev.text ?? '房间已停止', 'warn');
      finishTurn();
      renderStatus();
      break;

    case 'resumed':
      state.stopped = false;
      if (ev.reason !== 'cleared') state.paused = null;
      if (ev.text) appendSystemNote(ev.text);
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

/** @ 候选菜单的状态 */
const mention = {
  open: false,
  items: [],        // [{name, role, backend, id}]
  active: 0,        // 当前高亮项
  atIndex: -1,      // 触发这次补全的 '@' 在输入框里的位置
};

/**
 * 找出光标前是否有"正在输入的 @"。
 *
 * 关键：**只打一个 @ 也要出列表**（frag 为空时返回全部候选）。
 * 之前要求 frag.length > 0 才算，所以用户打 @ 什么都没出现，
 * 感觉就是"这功能不存在"。
 */
function findMentionContext(value, caret) {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;

  const frag = before.slice(at + 1);
  // 名字里不会有空格/换行，所以遇到空白就说明这个 @ 已经结束了
  if (/\s/.test(frag)) return null;
  return { atIndex: at, frag };
}

function openMentionMenu(ctx) {
  const frag = ctx.frag.toLowerCase();
  // 头头优先，其余按加入顺序——和广播顺序一致，用户看到的就是联系人顺序
  const ordered = [...state.members].sort((a, b) => {
    const la = a.role === 'leader' ? 0 : 1;
    const lb = b.role === 'leader' ? 0 : 1;
    return la - lb;
  });

  const hits = ordered.filter((m) => m.name.toLowerCase().startsWith(frag));
  if (!hits.length) { closeMentionMenu(); return; }

  mention.open = true;
  mention.items = hits;
  mention.atIndex = ctx.atIndex;
  mention.active = 0;

  const menu = $('mention-menu');
  menu.classList.remove('hidden');
  menu.innerHTML = '';
  hits.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = `mention-item${i === 0 ? ' active' : ''}`;
    row.setAttribute('role', 'option');
    row.dataset.index = String(i);
    row.innerHTML = `
      <span class="mention-name">@${escapeHtml(m.name)}</span>
      <span class="mention-role ${m.role === 'leader' ? '' : 'member'}">${m.role === 'leader' ? '头头' : '成员'}</span>
      <span class="mention-backend">${escapeHtml(m.backend ?? '')}</span>`;
    // 点选
    row.onmousedown = (e) => {
      e.preventDefault();   // 别让输入框失焦
      pickMention(i);
    };
    menu.appendChild(row);
  });
}

function closeMentionMenu() {
  mention.open = false;
  mention.items = [];
  mention.atIndex = -1;
  $('mention-menu').classList.add('hidden');
  $('mention-menu').innerHTML = '';
}

function highlightMention(index) {
  mention.active = index;
  const menu = $('mention-menu');
  [...menu.children].forEach((el, i) => el.classList.toggle('active', i === index));
  menu.children[index]?.scrollIntoView({ block: 'nearest' });
}

/** 选中第 i 个候选：把 @frag 替换成 @名字 + 空格，光标放到名字后 */
function pickMention(i) {
  const item = mention.items[i];
  if (!item) return;

  const input = $('input');
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  const start = mention.atIndex;
  const insert = `@${item.name} `;

  input.value = v.slice(0, start) + insert + v.slice(caret);
  const pos = start + insert.length;
  input.setSelectionRange(pos, pos);
  input.focus();

  closeMentionMenu();
  autoGrow(input);
  updateMentionHint();
}

function updateMentionHint() {
  const v = $('input').value;
  const hint = $('mention-hint');
  const caret = $('input').selectionStart ?? v.length;

  // 光标前有未完成的 @ → 弹候选列表
  const ctx = findMentionContext(v, caret);
  if (ctx) {
    openMentionMenu(ctx);
    hint.textContent = '';
    hint.className = 'mention-hint';
    return;
  }
  closeMentionMenu();

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

/**
 * seq 撞号提示。
 *
 * 不能只在启动时弹一次 notice：启动时没人在线、或者用户刷新一次，提示就没了，
 * 而导出件里却写着"别用 seq 对账"——两边对不上。所以它跟着 room.init 走，
 * 常驻显示，可以手动收起（本次会话内）。
 */
let seqWarningDismissed = false;
function renderSeqWarning(warning) {
  const el = $('seq-warn');
  if (!warning || seqWarningDismissed) {
    el.classList.add('hidden');
    return;
  }
  $('seq-warn-text').textContent = warning.text ?? '本房间历史事件的 seq 有重复，回溯请以行序与时间为准。';
  el.classList.remove('hidden');
}

$('seq-warn-hide').onclick = () => {
  seqWarningDismissed = true;
  $('seq-warn').classList.add('hidden');
};

/**
 * 任务卡「账不平」标记：说明里写着阻塞、状态仍是「待办」。
 *
 * 这是给"报告说改了、板上没改"这类不一致做的**可见提示**。
 * 根因修复在服务端（未成功动作必须跨轮重现），但界面也不能让这种账
 * 平白无故地看起来一致 —— 那才是最容易被当成"系统说一切正常"的形态。
 *
 * 判据刻意保守：只认明确的阻塞词，避免把普通备注误标成异常。
 */
function taskLooksStuck(t) {
  const note = String(t.note ?? '');
  return t.status === '待办' && /阻塞|需外部渠道|等外部/.test(note);
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
  const diffRes = await fetch(`/api/diff?task=${encodeURIComponent(id)}`).catch(() => null);
  if (!diffRes?.ok) {
    // 没有 worktree：纯讨论任务，没什么可验收的
    return;
  }

  const d = await diffRes.json();
  if (!d.files?.length) {
    body.insertAdjacentHTML('beforeend',
      '<h3>改动</h3><div class="link-note">这个任务还没有任何改动</div>');
    return;
  }

  const esc = escapeHtml(d.patch ?? '');
  const colored = esc.split('\n').map((line) => {
    if (line.startsWith('+')) return `<span class="diff-add">${line}</span>`;
    if (line.startsWith('-')) return `<span class="diff-del">${line}</span>`;
    return line;
  }).join('\n');

  body.insertAdjacentHTML('beforeend', `
    <h3>改动（${d.files.length} 个文件）</h3>
    <pre>${colored}</pre>
    <div class="accept-bar">
      <div class="accept-note">合并会把改动写进主仓库；丢弃会删掉这个任务的副本。</div>
      <button id="btn-merge" class="btn primary">合并进主分支</button>
      <button id="btn-discard" class="btn danger">丢弃改动</button>
    </div>`);

  $('btn-merge').onclick = () => acceptTask(t, 'merge');
  $('btn-discard').onclick = () => acceptTask(t, 'discard', () => {
    // 丢弃是不可逆的，问一次
    const hasChanges = d.files.length;
    return window.confirm(`确定丢弃 ${t.id} 的改动？\n会删除 ${t.worktree}\n（${hasChanges} 个文件的改动将丢失）`);
  });
}

/** 验收：合并或丢弃。两者都需要人明确点击。 */
async function acceptTask(task, action, confirmFn) {
  if (confirmFn && !confirmFn()) return;

  const btn = action === 'merge' ? $('btn-merge') : $('btn-discard');
  const other = action === 'merge' ? $('btn-discard') : $('btn-merge');
  const original = btn.textContent;
  btn.disabled = true;
  other.disabled = true;
  btn.textContent = action === 'merge' ? '合并中…' : '清理中…';

  try {
    const res = await fetch('/api/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.id, action }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // 冲突等失败情形：说清原因，不要把按钮留在假死状态
      showDrawerResult(`失败：${data.error ?? res.status}`, 'fail');
      btn.disabled = false;
      other.disabled = false;
      btn.textContent = original;
      return;
    }

    showDrawerResult(
      action === 'merge'
        ? `已合并进主分支（commit ${data.commit ?? '?'}）。任务副本保留，可事后追问。`
        : '已丢弃。主仓库未受影响，任务副本已清理。',
      'ok',
    );
  } catch (err) {
    showDrawerResult(`失败：${err.message}`, 'fail');
    btn.disabled = false;
    other.disabled = false;
    btn.textContent = original;
  }
}

function showDrawerResult(text, kind) {
  const bar = document.querySelector('.accept-bar');
  if (!bar) return;
  bar.innerHTML = `<div class="accept-result ${kind}">${escapeHtml(text)}</div>`;
}

/* ---------------- 启动 ---------------- */

/* ---------------- 侧栏操作 ---------------- */

function setOverridden(on) {
  state.overridden = on;
  $('takeover-badge').classList.toggle('hidden', !on);
  $('btn-takeover').classList.toggle('hidden', on);
  $('btn-handback').classList.toggle('hidden', !on);
}

$('cabtier').onchange = async (e) => {
  const tier = e.target.value;
  const label = cabTierLabel(tier);
  if (tier !== 'readonly' && !window.confirm(
    `把 AI 创建成员的最高权限改成「${label}」？\n\n`
    + '这意味着头头自己加的人可以直接改文件'
    + (tier === 'write-exec' ? '并执行命令' : '')
    + '。只有你信任房间里的 AI 时才这么做。',
  )) {
    e.target.value = state.aiCabTier;   // 取消就还原
    return;
  }
  const res = await fetch('/api/cabtier', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier }),
  });
  if (!res.ok) {
    e.target.value = state.aiCabTier;
    appendSystemNote('设置失败', 'warn');
  }
};

$('room-timeout').onchange = async (e) => {
  const v = e.target.value;
  const res = await fetch('/api/room-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnTimeoutMinutes: v }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    appendSystemNote(`设置失败：${data.error ?? res.status}`, 'warn');
    e.target.value = '';
  }
};

$('passive-wake').onchange = async (e) => {
  const on = e.target.checked;
  const res = await fetch('/api/room-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ headPassiveWake: on }),
  });
  if (!res.ok) {
    e.target.checked = !on;
    return appendSystemNote('设置失败', 'warn');
  }
  state.headPassiveWake = on;
};

$('btn-takeover').onclick = async () => {
  if (!window.confirm('接管后头头会暂停自动发言，你直接 @ 任何成员。继续？')) return;
  const res = await fetch('/api/takeover', { method: 'POST' });
  if (res.ok) {
    setOverridden(true);
    appendSystemNote('已接管：头头暂停，你可以直接 @ 任何成员', 'warn');
  }
};

$('btn-handback').onclick = async () => {
  if (!window.confirm('交还后头头会恢复自动发言（接管期间的排队发言不会补发）。继续？')) return;
  const res = await fetch('/api/handback', { method: 'POST' });
  if (res.ok) {
    setOverridden(false);
    appendSystemNote('已交还控制权：头头恢复自动发言');
  }
};

$('btn-summarize').onclick = () => {
  if (!state.members.length) return;
  const names = state.members.map((m, i) => `${i + 1}. ${m.name}`).join('\n');
  const pick = window.prompt(`让谁做总结？输入编号：\n${names}`);
  if (!pick) return;
  const m = state.members[Number(pick) - 1];
  if (!m) return appendSystemNote('编号无效', 'warn');
  fetch('/api/summarize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: m.id }),
  }).then((r) => {
    if (r.ok) appendSystemNote(`${m.name} 开始总结（说完房间会停住）`);
    else appendSystemNote('发起总结失败', 'warn');
  });
};

$('btn-add-repo').onclick = async () => {
  const path = window.prompt('登记一个可用仓库（绝对路径）：\n头头只能在登记的仓库里选。');
  if (!path) return;
  const res = await fetch('/api/registry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path.trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return appendSystemNote(`登记失败：${data.error ?? res.status}`, 'warn');
  state.registry = data.registry ?? [];
  renderRepos();
  appendSystemNote(`已登记仓库：${path.trim()}`);
};

$('btn-add-member').onclick = () => openNewMember();

$('mm-close').onclick = closeMemberSettings;
$('mm-cancel').onclick = closeMemberSettings;
$('mm-save').onclick = saveMemberSettings;
$('mm-remove').onclick = removeMember;
$('member-modal').onclick = (e) => { if (e.target.id === 'member-modal') closeMemberSettings(); };

// 换后端：档位列表要跟着变（codex 没有 write-ask，claude 没有 read 之外的差别）
$('mm-backend').onchange = (e) => {
  mm.backend = e.target.value;
  // 档位收敛：新后端不支持当前档就落到它最保守的一档
  const support = {
    claude: ['readonly', 'read', 'write-ask', 'write', 'write-exec'],
    codex: ['read', 'write-exec'],
    opencode: ['readonly', 'read', 'write', 'write-exec'],
  }[mm.backend] ?? ['readonly'];
  if (!support.includes(mm.tier)) mm.tier = support[0];
  renderTierChoices(support);
  renderModelHints();
  updatePreview();
};

for (const id of ['mm-model', 'mm-effort', 'mm-extra', 'mm-commands']) {
  $(id).addEventListener('input', updatePreview);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('member-modal').classList.contains('hidden')) closeMemberSettings();
});

/* ---------------- 成员设置弹窗 ---------------- */

/** 档位说明文案（后端也有一份，这里是为了不依赖网络就能显示） */
const TIER_TEXT = {
  readonly: ['无工具', '完全碰不到文件：看不见也改不了，只能对话'],
  read: ['可读', '能读文件和搜代码，不能改、不能执行命令'],
  'write-ask': ['可写·每次询问', '能改文件，但每次写入都要你批准'],
  write: ['可写', '能改工作目录内的文件，不能执行命令'],
  // 别写「命令也限制在工作目录内」——放开的命令没有目录墙（实测 curl 能写 /tmp）
  'write-exec': ['可写+执行', '能改工作目录内的文件；命令默认全禁，需单独允许（允许后不受目录限制）'],
};

const MODEL_HINTS = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  codex: [],
  opencode: [],
};

/** 当前弹窗状态。id 为 null 表示"新建"。 */
let mm = null;

function memberByIdForSettings(id) {
  return state.members.find((m) => m.id === id) ?? null;
}

function openMemberSettings(id) {
  const m = memberByIdForSettings(id);
  if (!m) return;

  mm = {
    id: m.id,
    original: { ...m },
    backend: m.backend,
    tier: m.tier,
    confirmOverride: false,
    isNew: false,
  };

  $('mm-title').textContent = `成员设置 · ${m.name}`;
  $('mm-name').value = m.name;
  $('mm-backend').value = m.backend;
  $('mm-model').value = m.model ?? '';
  $('mm-effort').value = m.effort ?? '';
  $('mm-extra').value = m.extraArgs ?? '';
  $('mm-commands').value = m.allowedCommands ?? '';
  $('mm-timeout').value = m.timeoutMinutes ?? '';
  $('mm-timeout-hint').textContent = m.timeoutSource === 'legacy'
    ? `⚠️ 当前实际生效的是 ${m.effectiveTimeoutMinutes} 分钟，来自 room.json 里手写的 timeoutMs；`
      + '在这里填一个值会覆盖它，并让界面与实际情况重新一致。'
    : `实际生效：${m.effectiveTimeoutMinutes} 分钟。清空 = 用房间默认，并删除配置里手写的旧值。`;
  $('mm-role').value = m.role;
  $('mm-persona').value = m.persona ?? '';
  $('mm-remove').classList.remove('hidden');
  $('mm-error').classList.add('hidden');

  renderTierChoices(m.tiers ?? []);
  renderModelHints();
  updatePreview();
  $('member-modal').classList.remove('hidden');
  $('mm-name').focus();
}

/** 新建成员也走同一个弹窗（现在新增成员要连问四次 prompt） */
function openNewMember() {
  const isFirst = state.members.length === 0;
  mm = {
    id: null, original: null, backend: 'claude',
    tier: isFirst ? 'readonly' : 'readonly', confirmOverride: false, isNew: true, isFirst,
  };
  $('mm-title').textContent = isFirst ? '添加第一个成员（它会是头头）' : '添加成员';
  $('mm-name').value = '';
  $('mm-backend').value = 'claude';
  $('mm-model').value = '';
  $('mm-effort').value = '';
  $('mm-extra').value = '';
  $('mm-commands').value = '';
  $('mm-timeout').value = '';
  $('mm-timeout-hint').textContent = '这是「防无限跑」的上限，不是卡死判定——卡死由看门狗判（90 秒无输出）。';
  $('mm-role').value = isFirst ? 'leader' : 'member';
  $('mm-role').disabled = isFirst;   // 第一个成员固定头头，不再多问一次
  $('mm-persona').value = '';
  $('mm-remove').classList.add('hidden');
  $('mm-error').classList.add('hidden');
  renderTierChoices(['readonly', 'read', 'write-ask', 'write', 'write-exec']);
  renderModelHints();
  updatePreview();
  $('member-modal').classList.remove('hidden');
  $('mm-name').focus();
}

function closeMemberSettings() {
  $('member-modal').classList.add('hidden');
  $('mm-role').disabled = false;
  mm = null;
}

function renderTierChoices(tiers) {
  const box = $('mm-tiers');
  box.innerHTML = '';
  const list = tiers.length ? tiers : ['readonly'];

  // 档位按强弱排序，和"只读→可写→可执行"的直觉一致
  const order = ['readonly', 'read', 'write-ask', 'write', 'write-exec'];
  const sorted = [...list].sort((a, b) => order.indexOf(a) - order.indexOf(b));

  for (const tier of sorted) {
    const [name, desc] = TIER_TEXT[tier] ?? [tier, ''];
    const label = document.createElement('label');
    label.className = `tier-choice${mm.tier === tier ? ' selected' : ''}`;
    label.innerHTML = `
      <input type="radio" name="mm-tier" value="${tier}" ${mm.tier === tier ? 'checked' : ''}>
      <span class="tier-choice-main">
        <span class="tier-choice-name">${escapeHtml(name)}</span>
        <span class="tier-choice-desc">${escapeHtml(desc)}</span>
      </span>`;
    label.querySelector('input').onchange = () => {
      mm.tier = tier;
      renderTierChoices(list);
      updatePreview();
    };
    box.appendChild(label);
  }

  // 当前档位不在该后端支持列表里（换后端后）：明确说一声，别让界面显示一个选不中的档
  $('mm-tier-hint').textContent = list.includes(mm.tier)
    ? ''
    : `当前后端不支持「${mm.tier}」，请重选一档。`;
}

function renderModelHints() {
  const hints = MODEL_HINTS[mm.backend] ?? [];
  $('mm-model-list').innerHTML = hints.map((h) => `<option value="${escapeHtml(h)}">`).join('');
  const m = mm.isNew ? null : memberByIdForSettings(mm.id);
  const efforts = (m?.effortHints) ?? [];
  $('mm-effort-list').innerHTML = efforts.map((h) => `<option value="${escapeHtml(h)}">`).join('');
  $('mm-backend-hint').textContent = mm.backend === 'codex'
    ? 'codex 的沙箱只有"可读"和"可写+执行"两档；模型/等级必须留空或填它自己认识的值。'
    : '';
}

/** 参数预览：只做展示，真正的拒绝/确认在保存时由服务端判定 */
function updatePreview() {
  const backend = $('mm-backend').value;
  const model = $('mm-model').value.trim();
  const effort = $('mm-effort').value.trim();
  const extra = $('mm-extra').value.trim();
  const tier = mm?.tier ?? 'readonly';

  const parts = [backend];
  // 档位参数（按后端近似拼，只为让人看懂会发生什么）
  if (backend === 'claude') {
    if (tier === 'readonly') parts.push('--tools ""');
    else if (tier === 'read') parts.push('--tools "Read,Grep,Glob"');
    else parts.push('--tools "Read,Write,Edit"');
  } else if (backend === 'codex') {
    parts.push('-s', tier === 'write-exec' ? 'workspace-write' : 'read-only');
  }
  if (model) {
    if (backend === 'claude') parts.push('--model', model);
    else if (backend === 'codex') parts.push(`-c model="${model}"`);
    else parts.push('-m', model);
  }
  if (effort) {
    if (backend === 'claude') parts.push('--effort', effort);
    else if (backend === 'codex') parts.push(`-c model_reasoning_effort="${effort}"`);
    else parts.push('--variant', effort);
  }
  const cmds = $('mm-commands').value.trim().split(/[\s,，]+/).filter(Boolean);
  if (cmds.length && tier === 'write-exec') {
    parts.push('--allowedTools', ...cmds.map((c) => `"Bash(${c}:*)"`));
  } else if (cmds.length) {
    parts.push('（命令只对「可写+执行」档生效）');
  }
  if (extra) parts.push(extra);

  $('mm-preview').textContent = parts.join(' ');
  // 覆盖标注：每次输入都重算，参数删掉就消失
  const overrides = /(^|\s)(--tools|--permission-mode|--permission-prompts|--dangerously-skip-permissions|-s|--sandbox|sandbox_mode=|--dangerously-bypass-approvals-and-sandbox|--variant)/.test(` ${extra} `);
  $('mm-override-warn').classList.toggle('hidden', !overrides || !extra);
}

async function saveMemberSettings() {
  if (!mm) return;
  const err = $('mm-error');
  err.classList.add('hidden');

  const backend = $('mm-backend').value;
  const name = $('mm-name').value.trim();
  if (!name) { return showModalError('名字不能为空'); }

  // 换后端要说清上下文会重置（会话 id 属于旧 CLI）
  const changingBackend = !mm.isNew && backend !== mm.original.backend;
  if (changingBackend && !window.confirm(
    `把这个成员的后端从 ${mm.original.backend} 换成 ${backend}？\n\n`
    + '会话 id 属于原来的 CLI，换后端会**重置上下文**——它之前的对话记忆会丢。\n继续？',
  )) return;

  // 覆盖档位的参数要二次确认
  const extraText = $('mm-extra').value;
  const overrides = /(--tools|--permission-mode|--permission-prompts|--dangerously-skip-permissions|(^|\s)-s(\s|$)|--sandbox|sandbox_mode=|--dangerously-bypass-approvals-and-sandbox)/.test(extraText);
  if (overrides && !mm.confirmOverride) {
    if (!window.confirm(
      '这些启动参数会覆盖能力档位，实际权限以参数为准。\n\n'
      + `参数：${extraText}\n\n确认要用这些参数？保存后卡片上会常驻标注"档位被参数覆盖"。`,
    )) return;
    mm.confirmOverride = true;
  }

  const payload = {
    name,
    backend,
    tier: mm.tier,
    model: $('mm-model').value.trim(),
    effort: $('mm-effort').value.trim(),
    extraArgs: extraText,
    allowedCommands: $('mm-commands').value,
    timeoutMinutes: $('mm-timeout').value,
    role: $('mm-role').value,
    persona: $('mm-persona').value,
  };

  if (mm.isNew) {
    const res = await fetch('/api/member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, tier: mm.tier }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showModalError(data.error ?? `保存失败（${res.status}）`);
    appendSystemNote(`已添加成员 @${data.member?.name ?? name}（${backend} / ${tierLabel(mm.tier)}${data.role === 'leader' ? ' · 头头' : ''}）`);
    closeMemberSettings();
    return;
  }

  const res = await fetch('/api/member/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: mm.id, patch: payload, confirmOverride: mm.confirmOverride }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return showModalError(data.error ?? `保存失败（${res.status}）`);
  }

  const bits = [];
  if (data.changed?.includes('tier')) bits.push('档位');
  if (data.changed?.includes('model')) bits.push('模型');
  if (data.changed?.includes('effort')) bits.push('思考等级');
  if (data.changed?.includes('extraArgs')) bits.push('启动参数');
  if (data.changed?.includes('allowedCommands')) bits.push('允许的命令');
  if (data.changed?.includes('timeoutMinutes')) bits.push('单轮上限');
  if (data.changed?.includes('name')) bits.push('名字');
  if (data.sessionReset) bits.push('会话已重置');
  appendSystemNote(bits.length ? `已更新 ${name}：${bits.join('、')}（立即生效，不用重启）` : '没有改动');
  closeMemberSettings();
}

function showModalError(text) {
  const el = $('mm-error');
  el.textContent = text;
  el.classList.remove('hidden');
}

async function removeMember() {
  if (!mm?.id) return;
  const m = memberByIdForSettings(mm.id);
  const isOnlyLeader = m?.role === 'leader' && state.members.filter((x) => x.role === 'leader').length === 1;
  const warn = isOnlyLeader ? '\n\n注意：这是唯一的头头，删掉之后没有人能自动接手任务。' : '';
  if (!window.confirm(`删除成员「${m?.name}」？\n\n历史消息会保留，只从名册移除。${warn}`)) return;

  const res = await fetch('/api/member/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: mm.id, confirmNoLeader: isOnlyLeader }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showModalError(data.error ?? `删除失败（${res.status}）`);
  appendSystemNote(`已删除成员 ${data.removed?.name ?? ''}（历史消息保留）`);
  closeMemberSettings();
}

/* ---------------- 房间切换 ---------------- */

$('btn-rooms').onclick = async () => {
  const r = await fetch('/api/rooms').catch(() => null);
  if (r?.ok) {
    const d = await r.json();
    state.rooms = d.rooms ?? [];
    state.activeRoomId = d.activeRoomId ?? state.activeRoomId;
    state.singleFallback = Boolean(d.singleFallback);
  }
  showRoomList();
};

$('rooms-close').onclick = () => {
  setHashRoom(state.activeRoomId);
  hideRoomList();
};

/** 左栏「+ 新建房间」：打开列表并直接聚焦到新房间名输入框 */
$('btn-new-room').onclick = () => {
  showRoomList();
  $('rooms-new-name').focus();
};

$('rooms-create').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('rooms-new-name');
  const name = input.value.trim();
  if (!name) return;
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return appendSystemNote(`新建失败：${data.error ?? res.status}`, 'warn');
  input.value = '';
  // 服务端建完会直接切到新房间并广播 room.init。
  // 但如果那个 init 已经先到了（activeRoomId 已是新房间），就就地收尾。
  const newId = data.room?.id;
  if (newId) {
    setHashRoom(newId);
    if (state.activeRoomId === newId) {
      pendingEnter = null;
      hideRoomList();
    } else {
      pendingEnter = newId;
    }
  }
};

// 浏览器前进/后退也要跟着换房间
window.addEventListener('hashchange', () => {
  const id = hashRoomId();
  if (!id) return showRoomList();
  if (id !== state.activeRoomId) enterRoom(id);
  else hideRoomList();
});

$('btn-first-member').onclick = () => openNewMember();

$('btn-send').onclick = send;
$('btn-stop').onclick = async () => {
  // 停止会清空队列并打断当前发言，问一次（和"打断"不同：打断不用问，它可逆）
  if (!window.confirm('停止整间房？\n\n会打断当前发言，并清空排队中的发言。\n说一句话或点「继续」就能恢复。')) return;
  const res = await fetch('/api/stop', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return appendSystemNote('停止失败', 'warn');
  if (data.dropped) appendSystemNote(`已丢弃 ${data.dropped} 条排队发言`, 'warn');
};

$('btn-resume').onclick = async () => {
  // 停止中 → 先松刹车（不发消息）；已经停住但有原因 → 让头头接着推进
  const kick = !state.stopped;
  const res = await fetch('/api/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kick }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return appendSystemNote(`恢复失败：${data.error ?? res.status}`, 'warn');
};
$('btn-interrupt').onclick = async () => {
  const res = await fetch('/api/interrupt', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  // 没有在跑的一轮时说清楚，别让按钮看起来没反应
  if (res.ok && !data.ok) appendSystemNote('当前没有正在发言的人', 'warn');
};
$('drawer-close').onclick = () => $('drawer').classList.add('hidden');
$('drawer').onclick = (e) => { if (e.target.id === 'drawer') $('drawer').classList.add('hidden'); };

$('input').addEventListener('input', (e) => { autoGrow(e.target); updateMentionHint(); });
$('input').addEventListener('keydown', (e) => {
  // 候选列表开着时，方向键/回车/Tab 归它用
  if (mention.open) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightMention((mention.active + 1) % mention.items.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightMention((mention.active - 1 + mention.items.length) % mention.items.length);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickMention(mention.active);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMentionMenu();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// 光标移动也要更新候选（在已有 @ 中间点来点去时）
$('input').addEventListener('click', updateMentionHint);
$('input').addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMentionHint();
});

renderStatus();
connect();
