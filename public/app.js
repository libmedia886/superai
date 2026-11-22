/* SuperAI 多 AI 协作工作台前端 · 纯原生 ES Module，零外部依赖 */

const $ = (id) => document.getElementById(id);

const BACKEND_ORDER = ['agy', 'claude', 'codex', 'opencode'];

const DEFAULT_BACKEND_TIERS = {
  agy: ['read', 'write', 'write-exec', 'full'],
  claude: ['readonly', 'read', 'write-ask', 'write', 'write-exec', 'full'],
  codex: ['read', 'write-exec', 'full'],
  opencode: ['readonly', 'read', 'write', 'write-exec', 'full'],
};

const DEFAULT_EFFORT_HINTS = {
  agy: ['low', 'medium', 'high', 'xhigh', 'max'],
  claude: ['low', 'medium', 'high', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  opencode: ['low', 'medium', 'high'],
};

const FALLBACK_MODEL_HINTS = {
  agy: ['gemini-4-neon-high', 'gemini-3-pro', 'claude-sonnet-4-5'],
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5.4', 'o3', 'codex-mini'],
  opencode: [],
};

/** 档位说明文案（后端也有一份，前端兜底以保持零延迟显示） */
const TIER_TEXT = {
  full: ['完全开放', '无目录限制、可读写任意文件、可执行任意命令与联网（免审批）'],
  'write-exec': ['可写+执行', '能改工作目录内的文件；命令默认全禁，需单独允许（允许后不受目录限制）'],
  write: ['可写', '能改工作目录内的文件，不能执行命令'],
  'write-ask': ['可写·每次询问', '能改文件，但每次写入都要你批准'],
  read: ['可读', '能读文件和搜代码，不能改、不能执行命令'],
  readonly: ['无工具', '完全碰不到文件：看不见也改不了，只能对话'],
};

/** 停顿原因 → 人话（和后端 PAUSE_LABEL 保持完全一致） */
const PAUSE_LABEL = {
  no_target: '说完了，没点名下一位',
  timeout: '超时被中止（不是说完）',
  interrupted: '被打断（这一轮没做完）',
  overreach: '@ 了没权限叫的人',
  only_human: '把话交回给老板',
  continue_cap: '自动接力次数到上限',
  breaker: '连续失败，暂时停用',
  stopped: '你点了「停止」',
  summary: '总结完毕',
  error: '出错停住',
  cleared: '已恢复',
};

const state = {
  room: null,           // { id, name, goal, leaderId, sharedDir }
  members: [],
  messages: [],         // 已渲染消息（供任务抽屉关联讨论）
  tasks: new Map(),
  roster: new Map(),
  registry: [],
  toolLog: [],
  activeTurns: new Map(),      // agentId -> { agentId, el, head, timerEl, interruptBtn, thinking, toolFeed, toolStripEl, toolListEl, textEl, actions, text, thinkText, startedAt, tools, toolCount, lastToolMeta }
  lastTurnByAgent: new Map(),  // agentId -> 最近刚结束的气泡（供轮后 action.results 挂载）
  turnCount: 0,
  usage: 0,
  busy: false,
  pending: 0,
  currentSpeakerLast: null,
  leaderId: null,
  aiCabTier: 'full',
  overridden: false,
  stopped: false,
  allowPeerMentions: true,
  collaborationStyle: 'discuss', // 'discuss' | 'deliver'
  headPassiveWake: true,
  executionMode: 'auto',       // 'auto' | 'parallel' | 'serial'
  effectiveMode: 'parallel',   // 'parallel' | 'serial'
  maxConcurrency: 4,
  runtime: null,               // { executionMode, effectiveMode, maxConcurrency, active, queue, memberStates }
  resumeTarget: null,   // 有可续轮次时，「继续」按钮变成「接着做完」
  paused: null,         // { reason, detail, at }
  // ---- 多房间 ----
  rooms: [],            // [{ id, name, memberCount, lastActivityAt, eventCount }]
  activeRoomId: null,
  singleFallback: false,
  // ---- 后端诊断与模型发现 ----
  backends: [],         // [{ id, label, installed, version, bin, tiers, defaultTier, effortHints, supportsStreaming, models, configuredModel, status, issues, probe }]
  backendsCheckedAt: null,
  backendsLoaded: false,
  probingBackends: new Set(),
  // ---- 文件浏览器 & 右栏标签 ----
  activeTab: 'board',   // 'board' | 'files' | 'activity'
  activityFilter: 'all',
  filesData: null,      // { sharedDir, shared: [], agents: [] }
  filesLoading: false,
  filesError: null,
  // ---- 失败横幅去重 ----
  lastFailureBanner: null, // { agentId, detail, at }
  // ---- SSE 连接状态 ----
  connected: false,
  disconnectedNotified: false,
};

const COLORS = ['#58a6ff', '#a78bfa', '#3fb950', '#f0a050', '#f85149', '#38bdf8', '#f472b6'];

/* ==========================================================================
   基础工具函数
   ========================================================================== */

function colorFor(name) {
  let h = 0;
  for (const ch of String(name ?? '')) h = (h * 31 + ch.charCodeAt(0)) % COLORS.length;
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

function fmtSize(bytes) {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtAgo(iso) {
  if (!iso) return '还没有对话';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function parseTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string' && ts) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function fmtElapsed(startedAt) {
  const sec = Math.max(0, Math.floor((Date.now() - parseTs(startedAt)) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 统一工具展示信息：覆盖搜索/读/写/改/命令等全部工具 */
function describeTool({ tool = '', action = '', path = null, command = null, detail = '' } = {}) {
  const rawName = String(tool ?? '').trim();
  const lower = rawName.toLowerCase();
  const act = String(action ?? '').toLowerCase();

  let icon = '🔧';
  let label = rawName || '调用工具';

  if (/web_?search|search_web|websearch|google|bing/.test(lower)) {
    icon = '🔍';
    label = '检索网页';
  } else if (/web_?fetch|fetch_url|read_url|netget|curl/.test(lower)) {
    icon = '🌐';
    label = '抓取网页';
  } else if (act === 'write' || /^(write|write_file|write_to_file|create_file)$/.test(lower)) {
    icon = '✏️';
    label = '写入文件';
  } else if (act === 'edit' || /^(edit|edit_file|replace_file_content|multi_replace_file_content|apply_patch|patch)$/.test(lower)) {
    icon = '🛠';
    label = '编辑文件';
  } else if (act === 'bash' || /^(bash|shell|run_command|execute|terminal)$/.test(lower)) {
    icon = '⚙';
    label = '执行命令';
  } else if (/grep|glob|find|search|list_dir/.test(lower)) {
    icon = '🔎';
    label = '检索文件';
  } else if (act === 'read' || /^(read|read_file|view_file|cat)$/.test(lower)) {
    icon = '📖';
    label = '读取文件';
  }

  const rawDetail = String(
    detail
    || (act === 'bash' ? command : path)
    || command
    || path
    || '',
  ).trim();

  // 若详情是冗长绝对路径，展示简洁尾部（完整内容放在 title）
  let compactDetail = rawDetail;
  if (compactDetail.startsWith('/') && compactDetail.length > 54 && !/\s/.test(compactDetail)) {
    const segs = compactDetail.split('/').filter(Boolean);
    compactDetail = segs.length > 2 ? `…/${segs.slice(-2).join('/')}` : compactDetail;
  }
  if (compactDetail.length > 96) compactDetail = `${compactDetail.slice(0, 95)}…`;

  return {
    icon,
    label,
    shortTool: rawName || label,
    detail: rawDetail,
    compactDetail,
  };
}

let liveTimerInterval = null;

function hasAnyLiveRunner() {
  if (state.activeTurns.size > 0) return true;
  if ((state.runtime?.active?.length ?? 0) > 0) return true;
  return false;
}

function tickLiveTimers() {
  for (const turn of state.activeTurns.values()) {
    if (turn.timerEl) turn.timerEl.textContent = fmtElapsed(turn.startedAt);
  }
  document.querySelectorAll('[data-member-timer="1"]').forEach((el) => {
    const ts = Number(el.dataset.startedAt);
    if (Number.isFinite(ts)) el.textContent = fmtElapsed(ts);
  });
  if (!hasAnyLiveRunner() && liveTimerInterval) {
    clearInterval(liveTimerInterval);
    liveTimerInterval = null;
  }
}

function ensureTicker() {
  if (hasAnyLiveRunner()) {
    if (!liveTimerInterval) {
      liveTimerInterval = setInterval(tickLiveTimers, 1000);
    }
    tickLiveTimers();
  } else if (liveTimerInterval) {
    clearInterval(liveTimerInterval);
    liveTimerInterval = null;
  }
}

async function interruptAgent(agentId = null) {
  const payload = agentId ? { agentId } : {};
  const res = await fetch('/api/interrupt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && !data.ok) {
    appendSystemNote(agentId ? `@${nameOf(agentId)} 当前没有在发言` : '当前没有正在发言的人', 'warn');
  }
}

function recallMember(name) {
  const input = $('input');
  const tag = `@${name} `;
  const cur = input.value;
  if (!cur.includes(`@${name}`)) {
    input.value = cur.trim() ? `${tag}${cur}` : tag;
  }
  closeMobileDrawers();
  autoGrow(input);
  updateMentionHint();
  input.focus();
  const len = input.value.length;
  input.setSelectionRange(len, len);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fallback below */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function memberById(id) {
  return state.members.find((m) => m.id === id) ?? null;
}

function nameOf(id) {
  if (id === 'human') return '老板';
  if (id === 'system') return '系统';
  return memberById(id)?.name ?? id;
}

function backendInfo(id) {
  return state.backends.find((b) => b.id === id) ?? null;
}

function backendPillHtml(backend) {
  const b = String(backend ?? '');
  const cls = ['agy', 'claude', 'codex', 'opencode'].includes(b) ? b : '';
  return `<span class="backend-pill ${cls}">${escapeHtml(b)}</span>`;
}

function tierLabel(tier) {
  return {
    full: '完全开放',
    'write-exec': '可写+执行',
    write: '可写',
    'write-ask': '可写·询问',
    read: '可读',
    readonly: '无工具',
  }[tier] ?? (tier ?? '');
}

function cabTierLabel(tier) {
  return tierLabel(tier);
}

function avatarEl(name) {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.style.background = colorFor(name);
  el.textContent = String(name ?? '?').slice(0, 1).toUpperCase();
  return el;
}

/* ==========================================================================
   XSS-Safe Rich Markdown Renderer
   支持标题、粗体/斜体/删除线、行内代码、围栏代码块(+复制)、表格、列表、引用、分割线、安全链接
   ========================================================================== */

function formatInlineMarkdown(raw, { highlightMentions = false } = {}) {
  const codeTokens = [];
  // 先抽出行内代码，避免内部 Markdown 符号被二次解析
  let text = String(raw ?? '').replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codeTokens.push(`<code>${escapeHtml(code)}</code>`) - 1;
    return `\u0000IC${idx}\u0000`;
  });

  // 全量 HTML 转义（从这里往后只插入受控标签，杜绝 XSS）
  text = escapeHtml(text);

  // 安全链接：仅放行 http:// 与 https://
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => (
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
  ));

  // 粗体、删除线、斜体
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  text = text.replace(/(^|[\s(（【\[])\*([^*\n]+)\*(?=[\s.,!?;:)\]}）】]|$)/g, '$1<em>$2</em>');

  // 已知成员 @ 高亮
  if (highlightMentions && state.members.length) {
    const sortedNames = [...state.members]
      .map((m) => m.name)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (sortedNames.length) {
      const pattern = new RegExp(`(@(?:${sortedNames.map((n) => escapeRegExp(escapeHtml(n))).join('|')}))(?![\\w-])`, 'g');
      text = text.replace(pattern, '<span class="mention-chip">$1</span>');
    }
  }

  // 还原行内代码
  text = text.replace(/\u0000IC(\d+)\u0000/g, (_, i) => codeTokens[Number(i)] ?? '');
  return text;
}

function isTableSeparator(line) {
  return /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function splitTableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function renderMarkdown(text, { stripActions = true, highlightMentions = false } = {}) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return '';

  // 1. 提取围栏代码块（同时按需剔除 action/actions 块）
  const blocks = [];
  const withPlaceholders = src.replace(/```([a-zA-Z0-9_+-]*)[ \t]*\n?([\s\S]*?)```/g, (_, langRaw, codeRaw) => {
    const lang = String(langRaw ?? '').trim().toLowerCase();
    if (stripActions && (lang === 'action' || lang === 'actions')) {
      return '\n';
    }
    const cleanCode = String(codeRaw ?? '').replace(/\n$/, '');
    const html = `
      <div class="code-block">
        <div class="code-block-head">
          <span class="code-lang">${escapeHtml(lang || 'text')}</span>
          <button class="code-copy-btn" type="button" data-copy-code="1">复制</button>
        </div>
        <pre><code>${escapeHtml(cleanCode)}</code></pre>
      </div>`;
    const idx = blocks.push(html) - 1;
    return `\n\u0000CB${idx}\u0000\n`;
  });

  // 2. 逐行块级解析
  const lines = withPlaceholders.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i += 1; continue; }

    // 围栏代码块占位符
    const cbMatch = trimmed.match(/^\u0000CB(\d+)\u0000$/);
    if (cbMatch) {
      out.push(blocks[Number(cbMatch[1])] ?? '');
      i += 1;
      continue;
    }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    // 标题 h1-h4
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level}>${formatInlineMarkdown(hMatch[2].trim(), { highlightMentions })}</h${level}>`);
      i += 1;
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !/^\u0000CB\d+\u0000$/.test(lines[i].trim())) {
        rows.push(splitTableCells(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${formatInlineMarkdown(h, { highlightMentions })}</th>`).join('')}</tr></thead>`;
      const tbody = rows.length
        ? `<tbody>${rows.map((r) => `<tr>${headers.map((_, ci) => `<td>${formatInlineMarkdown(r[ci] ?? '', { highlightMentions })}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '';
      out.push(`<div class="md-table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    // 引用块
    if (/^>\s?/.test(trimmed)) {
      const qLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        qLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${qLines.map((q) => formatInlineMarkdown(q, { highlightMentions })).join('<br>')}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^\s*[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((it) => `<li>${formatInlineMarkdown(it, { highlightMentions })}</li>`).join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map((it) => `<li>${formatInlineMarkdown(it, { highlightMentions })}</li>`).join('')}</ol>`);
      continue;
    }

    // 普通段落
    const pLines = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !/^\u0000CB\d+\u0000$/.test(lines[i].trim())
      && !/^#{1,4}\s+/.test(lines[i])
      && !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())
      && !/^>\s?/.test(lines[i].trim())
      && !/^\s*[-*•]\s+/.test(lines[i])
      && !/^\s*\d+\.\s+/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      pLines.push(lines[i]);
      i += 1;
    }
    if (pLines.length) {
      out.push(`<p>${pLines.map((pl) => formatInlineMarkdown(pl, { highlightMentions })).join('<br>')}</p>`);
    }
  }

  return out.join('');
}

function renderBody(text, { live = false } = {}) {
  const cleaned = live ? String(text ?? '').split(/```actions?\b/)[0] : String(text ?? '');
  return renderMarkdown(cleaned, { stripActions: true, highlightMentions: true });
}

/* 代码块复制按钮事件委托 */
function bindCodeCopyDelegation(container) {
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy-code]');
    if (!btn) return;
    const codeEl = btn.closest('.code-block')?.querySelector('pre code');
    if (!codeEl) return;
    const ok = await copyText(codeEl.textContent ?? '');
    if (ok) {
      btn.textContent = '已复制 ✓';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '复制';
        btn.classList.remove('copied');
      }, 1600);
    }
  });
}

/* ==========================================================================
   左栏渲染：成员 / 名册 / 仓库 / 房间列表
   ========================================================================== */

function approvalNote(member) {
  const tier = member.tier;
  if (tier === 'readonly' || tier === 'read') return '';
  if (tier === 'full') {
    return '<div class="approval-note full-note">完全开放：任意文件、命令与联网（免审批）</div>';
  }
  if (tier === 'write-ask') return '<div class="approval-note">文件写入：每次询问</div>';
  const base = '<div class="approval-note auto">文件写入：自动批准，不会询问</div>';
  if (tier !== 'write-exec') return base;

  const cmds = String(member.allowedCommands ?? '').trim().split(/\s+/).filter(Boolean);
  if (!cmds.length) {
    return '<div class="approval-note">命令：<b>一条都不许</b>（需要的话在设置里填）</div>';
  }
  const hasNetget = cmds.includes('netget');
  const rawCmds = cmds.filter((c) => c !== 'netget');
  if (hasNetget && !rawCmds.length) {
    return '<div class="approval-note">命令：仅联网查资料（受限 GET，写不出工作目录）</div>';
  }
  const netPart = hasNetget ? '＋联网查资料 ' : '';
  return `<div class="approval-note cmd">命令：${netPart}仅 ${escapeHtml(rawCmds.join(' '))}<br>`
    + '<span class="cmd-risk">自定义命令不受目录限制</span></div>';
}

function memberLiveState(m) {
  const rtState = state.runtime?.memberStates?.[m.id] ?? null;
  const activeTurn = state.activeTurns.get(m.id) ?? null;

  if (rtState?.status === 'running' || activeTurn) {
    const startedAt = parseTs(rtState?.startedAt ?? activeTurn?.startedAt ?? Date.now());
    const toolCount = Math.max(Number(rtState?.toolCount ?? 0), Number(activeTurn?.toolCount ?? 0));
    const lastTool = rtState?.lastTool ?? activeTurn?.lastToolMeta?.shortTool ?? '';
    const lastAction = rtState?.lastAction ?? activeTurn?.lastToolMeta?.action ?? '';
    const lastDetail = rtState?.lastDetail ?? activeTurn?.lastToolMeta?.detail ?? '';
    return {
      status: 'running',
      startedAt,
      toolCount,
      lastTool,
      lastAction,
      lastDetail,
    };
  }
  if (rtState?.status === 'queued') {
    return {
      status: 'queued',
      queuePos: rtState.queuePos ?? 1,
      waitingFanIn: Boolean(rtState.waitingFanIn),
    };
  }
  if (rtState?.status === 'failed') {
    return {
      status: 'failed',
      lastError: rtState.lastError ?? '上轮执行失败',
    };
  }
  return { status: 'idle' };
}

function renderMemberLiveBar(m, ms) {
  if (ms.status === 'running') {
    let toolLine = '思考 / 生成中…';
    let toolTitle = '正在思考或生成回复';
    if (ms.toolCount > 0 || ms.lastTool) {
      const info = describeTool({
        tool: ms.lastTool,
        action: ms.lastAction,
        detail: ms.lastDetail,
      });
      const stepPart = ms.toolCount > 0 ? ` · 第 ${ms.toolCount} 步` : '';
      toolLine = `${info.icon} ${info.shortTool}${stepPart}`;
      toolTitle = `${info.label}${stepPart}${info.detail ? `：${info.detail}` : ''}`;
    }
    return `
      <div class="member-live-bar">
        <div class="member-live-top">
          <span class="ml-dot-run" aria-hidden="true"></span>
          <span class="ml-state-run">运行中</span>
          <span class="ml-timer" data-member-timer="1" data-started-at="${ms.startedAt}">${escapeHtml(fmtElapsed(ms.startedAt))}</span>
          <button class="member-act-btn stop-one" type="button" title="仅打断 @${escapeHtml(m.name)}">⏹</button>
        </div>
        <div class="member-live-tool" title="${escapeHtml(toolTitle)}">${escapeHtml(toolLine)}</div>
      </div>`;
  }

  if (ms.status === 'queued') {
    const text = ms.waitingFanIn
      ? '⏳ 等待并行成员全部完成后汇总'
      : `◷ 排队第 ${ms.queuePos} 位`;
    return `
      <div class="member-live-bar">
        <span class="ml-queue${ms.waitingFanIn ? ' fanin' : ''}" title="${escapeHtml(text)}">${escapeHtml(text)}</span>
      </div>`;
  }

  if (ms.status === 'failed') {
    return `
      <div class="member-live-bar">
        <div class="member-live-top">
          <span class="ml-fail" title="${escapeHtml(ms.lastError)}">⚠ 上轮失败</span>
          <button class="member-act-btn recall-one" type="button" title="在输入框填入 @${escapeHtml(m.name)} 以便重叫">↻ 重叫</button>
        </div>
      </div>`;
  }

  return '';
}

function renderMemberList() {
  const ul = $('member-list');
  ul.innerHTML = '';
  $('member-count').textContent = String(state.members.length);
  $('btn-first-member').classList.toggle('hidden', state.members.length > 0);

  for (const m of state.members) {
    const ms = memberLiveState(m);
    const li = document.createElement('li');
    li.className = `member${ms.status !== 'idle' ? ` is-${ms.status}` : ''}`;
    li.title = '点击编辑：后端 / 档位 / 模型 / 思考等级 / 人设';
    const modelInfo = [m.model, m.effort].filter(Boolean).join(' · ');
    li.innerHTML = `
      <div class="member-top">
        <span class="member-name">${escapeHtml(m.name)}</span>
        <span class="member-role ${m.role === 'leader' ? '' : 'member'}">${m.role === 'leader' ? '头头' : '成员'}</span>
        <span class="member-edit-icon" aria-hidden="true">⚙</span>
      </div>
      <div class="member-meta">
        ${backendPillHtml(m.backend)}
        <span class="tier-badge ${escapeHtml(m.tier)}">${escapeHtml(tierLabel(m.tier))}</span>
        ${modelInfo ? `<span class="member-model" title="${escapeHtml(modelInfo)}">${escapeHtml(modelInfo)}</span>` : ''}
        ${m.overridesTier ? '<span class="member-flag" title="启动参数里有覆盖档位的项">档位被参数覆盖</span>' : ''}
      </div>
      ${renderMemberLiveBar(m, ms)}
      ${m.sessionResetReason && m.role === 'leader' ? `<div class="session-reset" title="${escapeHtml(m.sessionResetReason)}">上下文已重置</div>` : ''}
      ${m.timeoutSource === 'legacy' ? `<div class="timeout-legacy" title="room.json 里手写了 timeoutMs，界面上的单轮上限对它不生效">上限来自配置手写 · 实际 ${escapeHtml(String(m.effectiveTimeoutMinutes))} 分钟</div>` : ''}
      ${approvalNote(m)}`;
    li.querySelector('.member-top').prepend(avatarEl(m.name));
    li.querySelector('.stop-one')?.addEventListener('click', (e) => {
      e.stopPropagation();
      interruptAgent(m.id);
    });
    li.querySelector('.recall-one')?.addEventListener('click', (e) => {
      e.stopPropagation();
      recallMember(m.name);
    });
    li.onclick = () => openMemberSettings(m.id);
    ul.appendChild(li);
  }
  ensureTicker();
}

function renderRoster() {
  const ul = $('roster-list');
  ul.innerHTML = '';
  if (!state.members.length) {
    ul.innerHTML = '<li class="empty-hint">暂无成员</li>';
    return;
  }
  for (const m of state.members) {
    const r = state.roster.get(m.id) ?? {};
    const duty = r.humanDuties ?? r.selfDuties ?? '（未填写）';
    const edited = r.humanDuties != null;

    const li = document.createElement('li');
    li.className = 'roster-item';
    li.innerHTML = `
      <div class="roster-line">
        <b>${escapeHtml(m.name)}</b><span class="roster-duty">${escapeHtml(duty)}</span>
        <button class="mini-btn edit-roster" type="button" title="编辑职责">✎</button>
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
        <button class="btn primary tiny save" type="button">保存</button>
        <button class="btn ghost tiny cancel" type="button">取消</button>
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
  $('repo-count').textContent = String(state.registry.length);
  if (!state.registry.length) {
    ul.innerHTML = '<li class="empty-hint">未登记仓库（点上方 ＋ 登记本机 Git 仓库路径）</li>';
    return;
  }
  for (const r of state.registry) {
    const li = document.createElement('li');
    li.className = 'repo-item';
    li.title = r.path;
    li.innerHTML = `
      <span class="repo-path">${escapeHtml(r.path)}</span>
      <button class="repo-del" type="button" title="移除此仓库登记">×</button>`;
    li.querySelector('.repo-del').onclick = () => removeRepo(r.path);
    ul.appendChild(li);
  }
}

async function removeRepo(path) {
  if (!window.confirm(`从本房间移除仓库登记？\n${path}\n\n（不会删除磁盘上的仓库，只是不再对房间开放）`)) return;
  const res = await fetch('/api/registry/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return appendSystemNote(`移除仓库失败：${data.error ?? res.status}`, 'warn');
  state.registry = data.registry ?? state.registry.filter((r) => r.path !== path);
  renderRepos();
  appendSystemNote(`已移除仓库登记：${path}`);
}

/* ==========================================================================
   右栏渲染：看板 / 文件 / 动态
   ========================================================================== */

const STATUS_ORDER = ['待办', '进行中', '待确认', '完成', '阻塞'];

/**
 * 任务卡「账不平」标记：说明里写着阻塞、状态仍是「待办」。
 */
function taskLooksStuck(t) {
  const note = String(t.note ?? '');
  return t.status === '待办' && /阻塞|需外部渠道|等外部/.test(note);
}

function renderBoard() {
  const board = $('board');
  board.innerHTML = '';
  const tasks = [...state.tasks.values()];
  $('tab-badge-board').textContent = String(tasks.length);

  if (!tasks.length) {
    board.innerHTML = '<div class="empty-hint">暂无任务。让头头或成员拆解并派发任务后会实时出现在这里。</div>';
    return;
  }

  for (const status of STATUS_ORDER) {
    const group = tasks.filter((t) => t.status === status);
    if (!group.length) continue;
    const col = document.createElement('div');
    col.className = 'board-col';
    col.innerHTML = `<div class="board-col-title">${escapeHtml(status)}<span class="count">${group.length}</span></div>`;
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

function switchRightTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.panel-tab').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  $('tab-board').classList.toggle('hidden', tab !== 'board');
  $('tab-files').classList.toggle('hidden', tab !== 'files');
  $('tab-activity').classList.toggle('hidden', tab !== 'activity');

  if (tab === 'files' && !state.filesLoading) {
    fetchFiles();
  }
  if (tab === 'activity') {
    renderActivity();
  }
}

let filesRefreshTimer = null;
function scheduleFilesRefresh() {
  if (filesRefreshTimer) clearTimeout(filesRefreshTimer);
  filesRefreshTimer = setTimeout(() => {
    filesRefreshTimer = null;
    if (state.room) fetchFiles({ silent: true });
  }, 800);
}

async function fetchFiles({ silent = false } = {}) {
  if (!state.room) {
    state.filesData = null;
    renderFiles();
    return;
  }
  state.filesLoading = true;
  if (!silent && !state.filesData) renderFiles();

  try {
    const res = await fetch('/api/files?scope=all');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      state.filesError = data.error ?? `读取文件列表失败（${res.status}）`;
    } else {
      state.filesData = data;
      state.filesError = null;
    }
  } catch (err) {
    state.filesError = err.message || '网络错误';
  } finally {
    state.filesLoading = false;
    renderFiles();
  }
}

function fileIconFor(relPath) {
  const lower = String(relPath ?? '').toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return '📝';
  if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) return '⚙';
  if (/\.(js|ts|jsx|tsx|py|go|rs|java|c|cpp|h|sh|css|html|sql)$/.test(lower)) return '⟨/⟩';
  if (/\.(png|jpg|jpeg|gif|svg|webp)$/.test(lower)) return '🖼';
  return '📄';
}

function renderFiles() {
  const tree = $('files-tree');
  const pathEl = $('files-shared-path');

  const d = state.filesData;
  const sharedDir = d?.sharedDir ?? state.room?.sharedDir ?? '';
  pathEl.textContent = sharedDir ? sharedDir.split('/').slice(-2).join('/') : '共享目录';
  pathEl.title = sharedDir;
  $('goal-shared-btn').classList.toggle('hidden', !sharedDir);

  if (state.filesLoading && !d) {
    tree.innerHTML = '<div class="empty-hint">加载文件列表中…</div>';
    return;
  }
  if (state.filesError && !d) {
    tree.innerHTML = `<div class="empty-hint">${escapeHtml(state.filesError)}</div>`;
    $('tab-badge-files').textContent = '0';
    return;
  }

  const shared = d?.shared ?? [];
  const agents = d?.agents ?? [];
  const totalCount = shared.length + agents.reduce((acc, a) => acc + (a.files?.length ?? 0), 0);
  $('tab-badge-files').textContent = String(totalCount);

  tree.innerHTML = '';

  // 共享目录分组
  const sharedGroup = document.createElement('details');
  sharedGroup.className = 'file-group';
  sharedGroup.open = true;
  sharedGroup.innerHTML = `
    <summary>
      <span>📁 房间共享目录</span>
      <span class="file-group-count">${shared.length}</span>
    </summary>`;
  if (!shared.length) {
    sharedGroup.insertAdjacentHTML('beforeend', '<div class="empty-hint">暂无共享文件。AI 写入共享目录的文档与产出将展示在这里。</div>');
  } else {
    const ul = document.createElement('ul');
    ul.className = 'file-list';
    for (const f of shared) {
      ul.appendChild(buildFileRow(f, { scope: 'shared' }));
    }
    sharedGroup.appendChild(ul);
  }
  tree.appendChild(sharedGroup);

  // 成员工作区分组
  for (const ag of agents) {
    const list = ag.files ?? [];
    const det = document.createElement('details');
    det.className = 'file-group';
    det.open = list.length > 0 && list.length <= 12;
    det.innerHTML = `
      <summary>
        <span>🤖 @${escapeHtml(ag.name ?? nameOf(ag.agentId))} 工作区</span>
        <span class="file-group-count">${list.length}</span>
      </summary>`;
    if (!list.length) {
      det.insertAdjacentHTML('beforeend', '<div class="empty-hint">工作区为空</div>');
    } else {
      const ul = document.createElement('ul');
      ul.className = 'file-list';
      for (const f of list) {
        ul.appendChild(buildFileRow(f, { scope: 'agent', agentId: ag.agentId, agentName: ag.name ?? nameOf(ag.agentId) }));
      }
      det.appendChild(ul);
    }
    tree.appendChild(det);
  }
}

function buildFileRow(file, ctx) {
  const li = document.createElement('li');
  const parts = String(file.relPath ?? '').split('/');
  const baseName = parts[parts.length - 1] || file.relPath;
  const dirPart = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  const metaBits = [dirPart, file.mtime ? fmtAgo(file.mtime) : ''].filter(Boolean).join(' · ');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'file-row';
  btn.title = file.relPath;
  btn.innerHTML = `
    <span class="file-icon">${fileIconFor(file.relPath)}</span>
    <span class="file-info">
      <span class="file-name">${escapeHtml(baseName)}</span>
      ${metaBits ? `<span class="file-sub">${escapeHtml(metaBits)}</span>` : ''}
    </span>
    <span class="file-size">${escapeHtml(fmtSize(file.size))}</span>`;
  btn.onclick = () => openFilePreview({ ...ctx, relPath: file.relPath });
  li.appendChild(btn);
  return li;
}

async function openFilePreview({ scope, agentId, agentName, relPath }) {
  $('drawer').classList.remove('hidden');
  $('drawer-title').textContent = relPath;
  $('drawer-meta').innerHTML = scope === 'shared'
    ? '<span class="tier-badge read">共享目录</span>'
    : `<span class="tier-badge">@${escapeHtml(agentName ?? nameOf(agentId))} 工作区</span>`;
  $('drawer-actions').innerHTML = '';
  const body = $('drawer-body');
  body.innerHTML = '<div class="link-note">正在读取文件内容…</div>';

  const qs = scope === 'shared'
    ? `scope=shared&path=${encodeURIComponent(relPath)}`
    : `scope=agent&agentId=${encodeURIComponent(agentId)}&path=${encodeURIComponent(relPath)}`;

  try {
    const res = await fetch(`/api/file?${qs}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      body.innerHTML = `<div class="modal-error">无法读取文件：${escapeHtml(data.error ?? String(res.status))}</div>`;
      return;
    }

    const content = String(data.content ?? '');
    const isBinary = Boolean(data.binary);
    const isMd = !isBinary && /\.(md|markdown)$/i.test(relPath);
    $('drawer-meta').innerHTML += `<span>${escapeHtml(fmtSize(data.size))}</span>`;

    if (isBinary) {
      $('drawer-actions').innerHTML = '';
      body.innerHTML = `<div class="truncated-banner">📦 二进制文件（${escapeHtml(fmtSize(data.size))}），不支持纯文本预览。</div>`;
      return;
    }

    // 抽屉操作按钮：Markdown 切换预览/源码 + 复制内容
    let renderMode = isMd ? 'preview' : 'source';
    const renderFileBody = () => {
      body.innerHTML = '';
      if (data.truncated) {
        body.insertAdjacentHTML('beforeend',
          '<div class="truncated-banner">⚠ 文件较大，已截断展示前部内容。</div>');
      }
      if (renderMode === 'preview') {
        const mdWrap = document.createElement('div');
        mdWrap.className = 'drawer-md-view md-body';
        mdWrap.innerHTML = renderMarkdown(content, { stripActions: false, highlightMentions: false })
          || '<div class="empty-hint">（空文件）</div>';
        body.appendChild(mdWrap);
      } else {
        const pre = document.createElement('pre');
        pre.className = 'file-code-pre';
        const code = document.createElement('code');
        code.textContent = content || '（空文件）';
        pre.appendChild(code);
        body.appendChild(pre);
      }
    };

    const actions = $('drawer-actions');
    actions.innerHTML = '';
    if (isMd) {
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn ghost sm';
      toggleBtn.textContent = '查看源码';
      toggleBtn.onclick = () => {
        renderMode = renderMode === 'preview' ? 'source' : 'preview';
        toggleBtn.textContent = renderMode === 'preview' ? '查看源码' : 'Markdown 预览';
        renderFileBody();
      };
      actions.appendChild(toggleBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn ghost sm';
    copyBtn.textContent = '复制全文';
    copyBtn.onclick = async () => {
      const ok = await copyText(content);
      if (ok) {
        copyBtn.textContent = '已复制 ✓';
        setTimeout(() => { copyBtn.textContent = '复制全文'; }, 1500);
      }
    };
    actions.appendChild(copyBtn);

    renderFileBody();
  } catch (err) {
    body.innerHTML = `<div class="modal-error">读取失败：${escapeHtml(err.message || String(err))}</div>`;
  }
}

function renderActivity() {
  const listEl = $('activity-list');
  const all = state.toolLog ?? [];
  $('tab-badge-activity').textContent = String(all.length);

  const filtered = all.filter((e) => {
    if (state.activityFilter === 'write') return e.action === 'write' || e.action === 'edit';
    if (state.activityFilter === 'bash') return e.action === 'bash';
    return true;
  });

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty-hint">暂无匹配的工具操作记录</div>';
    return;
  }

  listEl.innerHTML = '';
  // 最新操作排在最上面
  const recent = filtered.slice(-150).reverse();
  for (const e of recent) {
    const label = { write: '写入', edit: '编辑', bash: '命令', read: '读取' }[e.action] ?? (e.action ?? '工具');
    const target = e.action === 'bash' ? (e.command ?? '') : (e.path ?? e.command ?? '');
    const row = document.createElement('div');
    row.className = `activity-item ${escapeHtml(e.action ?? '')}`;
    row.innerHTML = `
      <div class="activity-top">
        <span class="tool-badge">${escapeHtml(label)}</span>
        <span class="activity-actor">@${escapeHtml(nameOf(e.agentId))}</span>
        <span class="activity-time">${escapeHtml(fmtTime(e.at))}</span>
      </div>
      <div class="activity-target">${escapeHtml(String(target).slice(0, 260))}</div>`;
    listEl.appendChild(row);
  }
}

/* ==========================================================================
   状态栏、目标栏与后端健康胶囊
   ========================================================================== */

function renderGoalBar() {
  const goal = String(state.room?.goal ?? '').trim();
  const textEl = $('goal-text');
  if (goal) {
    textEl.textContent = goal;
    textEl.classList.remove('placeholder');
    textEl.title = goal;
  } else {
    textEl.textContent = '点击设定本房间目标，让 AI 团队明确交付标准…';
    textEl.classList.add('placeholder');
    textEl.title = '';
  }
  $('goal-shared-btn').classList.toggle('hidden', !(state.room?.sharedDir || state.filesData?.sharedDir));
}

function openGoalEditor() {
  if (!state.room) return;
  $('goal-display').classList.add('hidden');
  $('goal-editor').classList.remove('hidden');
  const inp = $('goal-input');
  inp.value = state.room.goal ?? '';
  inp.focus();
  inp.select();
}

function closeGoalEditor() {
  $('goal-editor').classList.add('hidden');
  $('goal-display').classList.remove('hidden');
}

async function saveGoal(e) {
  e.preventDefault();
  if (!state.room) return;
  const goal = $('goal-input').value.trim();
  const res = await fetch('/api/room-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    appendSystemNote(`保存房间目标失败：${data.error ?? res.status}`, 'warn');
    return;
  }
  state.room.goal = goal;
  renderGoalBar();
  closeGoalEditor();
}

function computeEffectiveMode() {
  if (state.runtime?.effectiveMode === 'parallel' || state.runtime?.effectiveMode === 'serial') {
    return state.runtime.effectiveMode;
  }
  if (state.effectiveMode === 'parallel' || state.effectiveMode === 'serial') {
    return state.effectiveMode;
  }
  if (state.executionMode === 'serial') return 'serial';
  if (state.executionMode === 'parallel') return 'parallel';
  return state.members.length <= state.maxConcurrency ? 'parallel' : 'serial';
}

function renderExecModeControls() {
  const mode = state.executionMode ?? 'auto';
  const maxC = Number(state.maxConcurrency) || 4;
  const effective = computeEffectiveMode();
  const count = state.members.length;

  const sel = $('exec-mode');
  if (sel) sel.value = mode;

  const maxRow = $('max-concurrency-row');
  if (maxRow) maxRow.classList.toggle('hidden', mode === 'serial');
  const maxInp = $('max-concurrency');
  if (maxInp && document.activeElement !== maxInp) maxInp.value = String(maxC);

  const hint = $('exec-mode-hint');
  if (hint) {
    if (mode === 'auto') {
      hint.textContent = effective === 'parallel'
        ? `当前 ${count} 人 → 并行中（最多 ${maxC} 并发，头头等待汇合）`
        : `当前 ${count} 人 → 人多已自动切为串行（阈值 ≤${maxC} 人）`;
    } else if (mode === 'parallel') {
      hint.textContent = `始终并行：最多 ${maxC} 并发（跨成员同时运行，头头等待汇合）`;
    } else {
      hint.textContent = '严格串行：每次仅 1 位成员发言，顺序稳定可控。';
    }
  }

  const badge = $('exec-mode-badge');
  if (badge) {
    badge.className = `exec-mode-badge ${effective === 'parallel' ? 'parallel' : 'serial'}`;
    badge.textContent = effective === 'parallel' ? '⚡ 并行' : '⛓ 串行';
    const modeName = { auto: '智能', parallel: '始终并行', serial: '严格串行' }[mode] ?? mode;
    badge.title = `当前生效：${effective === 'parallel' ? `并行（最多 ${maxC} 并发）` : '串行'} · 配置模式：${modeName}（点击调整）`;
  }
}

function renderCollabStyleControls() {
  const style = state.collaborationStyle === 'deliver' ? 'deliver' : 'discuss';
  const sel = $('collab-style');
  if (sel && sel.value !== style) sel.value = style;
  const hint = $('collab-style-hint');
  if (hint) {
    if (style === 'discuss') {
      hint.textContent = state.allowPeerMentions
        ? '已开启交叉质询：成员初稿后必须直接互 @ 挑刺对齐，禁止客套附和直接交差。'
        : '已开启深度讨论（建议同时开启下方「允许成员互 @」，让成员直接对线讨论）。';
    } else {
      hint.textContent = '高效交付：各成员完成各自子任务后直接交由头头汇总，减少往返轮次。';
    }
  }
}

function applyRuntime(rt, { hydrateTurns = false } = {}) {
  if (!rt || typeof rt !== 'object') return;
  state.runtime = rt;
  if (rt.executionMode) state.executionMode = rt.executionMode;
  if (rt.effectiveMode) state.effectiveMode = rt.effectiveMode;
  if (rt.maxConcurrency != null) state.maxConcurrency = Number(rt.maxConcurrency) || 4;

  const activeList = Array.isArray(rt.active) ? rt.active : [];
  const queueList = Array.isArray(rt.queue) ? rt.queue : [];

  state.pending = queueList.length;
  state.busy = activeList.length > 0 || state.activeTurns.size > 0 || queueList.length > 0;

  for (const a of activeList) {
    if (!a?.agentId) continue;
    const existing = state.activeTurns.get(a.agentId);
    if (existing) {
      if (a.startedAt) existing.startedAt = parseTs(a.startedAt);
      if (a.toolCount > existing.toolCount || (a.lastTool && !existing.lastToolMeta)) {
        syncTurnFromRuntime(existing, a);
      }
    } else if (hydrateTurns) {
      ensureTurnEl(a.agentId, {
        startedAt: a.startedAt,
        toolCount: a.toolCount ?? 0,
        lastTool: a.lastTool ?? '',
        lastAction: a.lastAction ?? '',
        lastDetail: a.lastDetail ?? '',
      });
    }
  }

  renderExecModeControls();
  renderMemberList();
  renderStatus();
  ensureTicker();
}

function collectActiveAgentIds() {
  const seen = new Set();
  const ordered = [];
  for (const a of (state.runtime?.active ?? [])) {
    if (a?.agentId && !seen.has(a.agentId)) {
      seen.add(a.agentId);
      ordered.push(a.agentId);
    }
  }
  for (const agentId of state.activeTurns.keys()) {
    if (!seen.has(agentId)) {
      seen.add(agentId);
      ordered.push(agentId);
    }
  }
  return ordered;
}

function renderStatus() {
  const sp = $('speaker');
  const activeIds = collectActiveAgentIds();
  const queueList = Array.isArray(state.runtime?.queue) ? state.runtime.queue : [];
  const hasActive = activeIds.length > 0;

  if (activeIds.length > 1) {
    const namesAll = activeIds.map((id) => `@${nameOf(id)}`);
    const preview = namesAll.length <= 3
      ? namesAll.join('、')
      : `${namesAll.slice(0, 3).join('、')} 等`;
    sp.innerHTML = `<span class="dot busy"></span><span><b>${activeIds.length} 人并行中</b>：${escapeHtml(preview)}</span>`;
    sp.title = `正在并行运行：${namesAll.join('、')}`;
  } else if (activeIds.length === 1) {
    const who = nameOf(activeIds[0]);
    sp.innerHTML = `<span class="dot busy"></span><span><b>@${escapeHtml(who)}</b> 正在发言</span>`;
    sp.title = `@${who} 正在运行`;
  } else if (queueList.length > 0) {
    const qNames = queueList.map((q) => `${q.waitingFanIn ? '⏳' : ''}@${nameOf(q.agentId)}`);
    sp.innerHTML = `<span class="dot busy"></span><span>待发言：${escapeHtml(qNames.slice(0, 3).join('、'))}</span>`;
    sp.title = `排队中：${qNames.join('、')}`;
  } else if (state.busy) {
    sp.innerHTML = `<span class="dot busy"></span><span>执行中…</span>`;
    sp.title = '';
  } else if (state.pending > 0) {
    sp.innerHTML = `<span class="dot busy"></span><span>还有 <b>${state.pending}</b> 人待发言</span>`;
    sp.title = '';
  } else if (state.currentSpeakerLast) {
    sp.innerHTML = `<span class="dot idle"></span><span>已停手，等你指示</span>`;
    sp.title = '';
  } else {
    sp.innerHTML = `<span class="dot idle"></span><span>等待人类</span>`;
    sp.title = '';
  }

  $('turn-count').textContent = String(state.turnCount);
  $('usage').textContent = fmtTokens(state.usage);
  $('btn-interrupt').disabled = !hasActive;
  $('btn-interrupt').textContent = activeIds.length > 1 ? `打断 (${activeIds.length})` : '打断';
  $('stopped-badge').classList.toggle('hidden', !state.stopped);

  const qEl = $('queue');
  if (queueList.length > 0) {
    const tags = queueList.map((q) => `${q.waitingFanIn ? '⏳' : ''}@${nameOf(q.agentId)}`);
    qEl.textContent = `排队 ${queueList.length}：${tags.join('、')}`;
    const details = queueList.map((q, idx) => (
      `${idx + 1}. @${nameOf(q.agentId)}${q.waitingFanIn ? '（等待并行成员全部完成后汇总）' : ''}`
    ));
    qEl.title = details.join('\n');
    qEl.classList.remove('hidden');
  } else if (state.pending > 0 && hasActive) {
    qEl.textContent = `排队 ${state.pending}`;
    qEl.title = `当前有 ${state.pending} 人排队等待发言`;
    qEl.classList.remove('hidden');
  } else {
    qEl.classList.add('hidden');
  }

  // 停顿原因：停下/思考/坏了必须可分
  const pausedEl = $('paused-badge');
  if (state.paused && !state.stopped && !hasActive && !state.busy) {
    pausedEl.classList.remove('hidden');
    pausedEl.innerHTML = `停在：<strong>${escapeHtml(PAUSE_LABEL[state.paused.reason] ?? state.paused.reason)}</strong>`
      + (state.paused.detail ? ` · ${escapeHtml(state.paused.detail.slice(0, 72))}` : '');
    pausedEl.title = state.paused.detail ?? '';
  } else {
    pausedEl.classList.add('hidden');
  }

  // 「继续」在停止时用来松刹车，在停住时用来接着往下走（保持不变量表达式）
  const canContinue = state.stopped || (Boolean(state.paused) && !state.busy && !hasActive);
  $('btn-resume').classList.toggle('hidden', !canContinue);
  $('btn-resume').textContent = state.stopped
    ? '▶ 继续'
    : (state.resumeTarget ? '▶ 接着做完' : '▶ 接着推进');
  $('btn-stop').classList.toggle('hidden', state.stopped);
}

function renderBackendPills() {
  const host = $('bp-dots');
  if (!host) return;
  if (!state.backends.length) {
    host.innerHTML = '<span class="bp-item"><span class="dot idle"></span>检测中</span>';
    return;
  }
  const ordered = BACKEND_ORDER
    .map((id) => backendInfo(id))
    .filter(Boolean);
  const extra = state.backends.filter((b) => !BACKEND_ORDER.includes(b.id));
  const list = [...ordered, ...extra];

  host.innerHTML = list.map((b) => {
    const st = b.status ?? (b.installed ? 'ready' : 'missing');
    return `<span class="bp-item" title="${escapeHtml(`${b.id}: ${st}${b.version ? ` (${b.version})` : ''}`)}">`
      + `<span class="dot ${escapeHtml(st)}"></span>${escapeHtml(b.id)}</span>`;
  }).join('');
}

/* ==========================================================================
   后端诊断与模型发现弹窗 (#backends-modal)
   ========================================================================== */

async function fetchBackends({ silent = true, force = false } = {}) {
  try {
    const res = await fetch(force ? '/api/backends?force=1' : '/api/backends');
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (!data?.backends) return;
    state.backends = data.backends;
    state.backendsCheckedAt = data.checkedAt ?? new Date().toISOString();
    state.backendsLoaded = true;
    renderBackendPills();
    if (!$('backends-modal').classList.contains('hidden')) renderBackendsModal();
    if (mm && !$('member-modal').classList.contains('hidden')) {
      syncBackendSelectOptions();
      renderModelHints();
    }
  } catch (err) {
    if (!silent) appendSystemNote(`获取后端诊断失败：${err.message}`, 'warn');
  }
}

async function probeBackend(target) {
  const key = target === 'all' ? 'all' : target;
  state.probingBackends.add(key);
  renderBackendsModal();
  try {
    const res = await fetch('/api/backends/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: key }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      appendSystemNote(`后端探测失败：${data.error ?? res.status}`, 'warn');
    } else if (Array.isArray(data.backends)) {
      state.backends = data.backends;
      state.backendsCheckedAt = new Date().toISOString();
      state.backendsLoaded = true;
      renderBackendPills();
    }
  } catch (err) {
    appendSystemNote(`后端探测异常：${err.message}`, 'warn');
  } finally {
    state.probingBackends.delete(key);
    renderBackendsModal();
    if (mm && !$('member-modal').classList.contains('hidden')) {
      syncBackendSelectOptions();
      renderModelHints();
    }
  }
}

function openBackendsModal() {
  $('backends-modal').classList.remove('hidden');
  renderBackendsModal();
  fetchBackends({ silent: false });
}

function closeBackendsModal() {
  $('backends-modal').classList.add('hidden');
}

function backendStatusLabel(status) {
  if (status === 'ready') return '可用';
  if (status === 'warn') return '需注意';
  return '未安装 / 不可用';
}

function renderBackendsModal() {
  const listEl = $('bm-list');
  const checkedEl = $('bm-checked-at');
  checkedEl.textContent = state.backendsCheckedAt
    ? `上次检测：${fmtAgo(state.backendsCheckedAt)} · 实测连通性会向 CLI 发送极简探针请求`
    : '检测本机 agy / claude / codex / opencode 安装状态、可用模型与连通性';

  const probingAll = state.probingBackends.has('all');
  $('bm-probe-all').disabled = probingAll;
  $('bm-probe-all').textContent = probingAll ? '探测中…' : '⚡ 全部探测';

  if (!state.backends.length) {
    listEl.innerHTML = '<div class="empty-hint">暂无后端诊断数据，请点击右上角「刷新列表」。</div>';
    return;
  }

  const ordered = [
    ...BACKEND_ORDER.map((id) => backendInfo(id)).filter(Boolean),
    ...state.backends.filter((b) => !BACKEND_ORDER.includes(b.id)),
  ];

  listEl.innerHTML = '';
  for (const b of ordered) {
    const st = b.status ?? (b.installed ? 'ready' : 'missing');
    const probing = probingAll || state.probingBackends.has(b.id);
    const models = Array.isArray(b.models) ? b.models : [];
    const issues = Array.isArray(b.issues) ? b.issues : [];
    const tiers = Array.isArray(b.tiers) ? b.tiers : (DEFAULT_BACKEND_TIERS[b.id] ?? []);

    const card = document.createElement('div');
    card.className = `backend-card status-${escapeHtml(st)}`;
    card.innerHTML = `
      <div class="bc-head">
        <div class="bc-title-group">
          ${backendPillHtml(b.id)}
          <span class="bc-label">${escapeHtml(b.label ?? b.id)}</span>
        </div>
        <span class="bc-status ${escapeHtml(st)}">
          <span class="dot ${escapeHtml(st)}"></span>${escapeHtml(backendStatusLabel(st))}
        </span>
      </div>

      <div class="bc-meta">
        ${b.version ? `<span class="bc-tag">v ${escapeHtml(b.version)}</span>` : '<span class="bc-tag">未检测到版本</span>'}
        <span class="bc-tag">${b.supportsStreaming ? '流式输出' : '整段返回'}</span>
        ${b.bin ? `<span class="bc-tag" title="${escapeHtml(b.bin)}">${escapeHtml(b.bin)}</span>` : ''}
      </div>

      <div>
        <div class="bc-section-label">已发现模型（${models.length}）${b.configuredModel ? ` · 当前配置：${escapeHtml(b.configuredModel)}` : ''}</div>
        <div class="bc-models">
          ${models.length
            ? models.map((m) => `<button type="button" class="bc-model-pill${m === b.configuredModel ? ' configured' : ''}" data-copy-model="${escapeHtml(m)}" title="点击复制模型名：${escapeHtml(m)}">${escapeHtml(m)}</button>`).join('')
            : '<span class="field-hint">未发现模型列表（留空将使用 CLI 默认配置）</span>'}
        </div>
      </div>

      <div>
        <div class="bc-section-label">支持档位</div>
        <div class="member-meta">
          ${tiers.map((t) => `<span class="tier-badge ${escapeHtml(t)}">${escapeHtml(tierLabel(t))}</span>`).join('')}
        </div>
      </div>

      ${issues.length ? `
        <div class="bc-issues">
          ${issues.map((iss) => `<div class="bc-issue">⚠ ${escapeHtml(iss)}</div>`).join('')}
        </div>` : ''}

      ${b.probe ? `
        <div class="bc-probe-res ${b.probe.ok ? 'ok' : 'fail'}">
          ${b.probe.ok ? '✓ 连通性实测通过' : '✗ 连通性实测失败'}
          ${b.probe.reason ? ` · ${escapeHtml(b.probe.reason)}` : ''}
          ${b.probe.at ? `（${escapeHtml(fmtAgo(b.probe.at))}）` : ''}
        </div>` : ''}

      <div class="bc-foot">
        <span class="field-hint">${b.defaultTier ? `默认档位：${escapeHtml(tierLabel(b.defaultTier))}` : ''}</span>
        <button class="btn ghost sm probe-btn" type="button" ${probing || !b.installed ? 'disabled' : ''}>
          ${probing ? '实测中…' : '⚡ 实测连通性'}
        </button>
      </div>`;

    card.querySelector('.probe-btn').onclick = () => probeBackend(b.id);
    card.querySelectorAll('[data-copy-model]').forEach((pill) => {
      pill.onclick = async () => {
        const modelId = pill.dataset.copyModel;
        const ok = await copyText(modelId);
        if (ok) {
          const orig = pill.textContent;
          pill.textContent = `${orig} ✓`;
          setTimeout(() => { pill.textContent = orig; }, 1200);
        }
      };
    });
    listEl.appendChild(card);
  }
}

/* ==========================================================================
   多房间管理
   ========================================================================== */

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
  $('rooms-close').classList.toggle('hidden', !state.activeRoomId);
  renderRoomList();
  $('rooms-new-name').focus();
}

function hideRoomList() {
  $('rooms-view').classList.add('hidden');
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
    empty.textContent = '还没有房间。在下面输入名字即可创建第一个协作空间。';
    list.appendChild(empty);
    return;
  }

  for (const r of state.rooms) {
    const card = document.createElement('div');
    card.className = `room-card${r.id === state.activeRoomId ? ' active' : ''}`;
    const evMeta = r.eventCount != null ? ` · ${r.eventCount} 条记录` : '';
    card.innerHTML = `
      <div class="room-card-main">
        <div class="room-card-name">${escapeHtml(r.name)}</div>
        <div class="room-card-meta">${r.memberCount} 个成员${evMeta} · ${fmtAgo(r.lastActivityAt)}</div>
      </div>
      ${r.id === state.activeRoomId ? '<span class="room-card-current">当前</span>' : ''}
      <button class="icon-btn rename" type="button" title="只改显示名，不影响对话记录">重命名</button>
      <button class="icon-btn del" type="button" title="删除房间（目录移入 .trash，不清空）">删除</button>`;

    card.onclick = (e) => {
      if (e.target.closest('.rename, .del, .room-rename-inline')) return;
      enterRoom(r.id);
    };
    card.querySelector('.del').onclick = (e) => {
      e.stopPropagation();
      deleteRoom(r);
    };
    card.querySelector('.rename').onclick = (e) => {
      e.stopPropagation();
      startInlineRoomRename(card, r);
    };
    list.appendChild(card);
  }
}

function startInlineRoomRename(card, r) {
  const main = card.querySelector('.room-card-main');
  main.innerHTML = `
    <div class="room-rename-inline">
      <input type="text" value="${escapeHtml(r.name)}" maxlength="40" autocomplete="off">
      <button class="btn primary tiny save" type="button">保存</button>
      <button class="btn ghost tiny cancel" type="button">取消</button>
    </div>`;
  const inp = main.querySelector('input');
  inp.focus();
  inp.select();

  const submit = async () => {
    const name = inp.value.trim();
    if (!name || name === r.name) { renderRoomList(); return; }
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename', id: r.id, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      appendSystemNote(`重命名失败：${data.error ?? res.status}`, 'warn');
      renderRoomList();
      return;
    }
    r.name = data.room?.name ?? name;
    if (r.id === state.activeRoomId) {
      if (state.room) state.room.name = r.name;
      $('room-name').textContent = r.name;
      document.title = `${r.name} · SuperAI`;
    }
    renderSidebarRooms();
    renderRoomList();
  };

  main.querySelector('.save').onclick = submit;
  main.querySelector('.cancel').onclick = () => renderRoomList();
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') renderRoomList();
  };
}

function renderSidebarRooms() {
  const ul = $('room-list');
  if (!ul) return;
  ul.innerHTML = '';

  if (!state.rooms.length) {
    ul.innerHTML = '<li class="room-item empty">还没有房间</li>';
    return;
  }

  for (const r of state.rooms) {
    const li = document.createElement('li');
    li.className = `room-item${r.id === state.activeRoomId ? ' active' : ''}`;
    li.innerHTML = `
      <button class="room-item-main" type="button">
        <span class="room-item-name">${escapeHtml(r.name)}</span>
        <span class="room-item-meta">${r.memberCount}</span>
      </button>
      <button class="room-item-del" type="button" title="删除房间">×</button>`;
    li.querySelector('.room-item-main').onclick = () => {
      closeMobileDrawers();
      enterRoom(r.id);
    };
    li.querySelector('.room-item-del').onclick = (e) => {
      e.stopPropagation();
      deleteRoom(r);
    };
    ul.appendChild(li);
  }
}

async function deleteRoom(r) {
  if (state.rooms.length <= 1) {
    appendSystemNote('不能删除最后一个房间。先新建一个，再删这个。', 'warn');
    return;
  }
  const isActive = r.id === state.activeRoomId;
  const lines = [`删除房间「${r.name}」？`, ''];
  if (isActive) lines.push('这是当前房间：会先切到另一个房间，然后再删除。');
  lines.push('房间目录会移到 rooms/.trash-*（不会被清空），但界面上不再出现。');
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

  state.rooms = state.rooms.filter((x) => x.id !== r.id);
  if (isActive && data.switchedTo) {
    state.activeRoomId = data.switchedTo;
    setHashRoom(data.switchedTo);
  }
  renderSidebarRooms();
  renderRoomList();
}

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

  if (data.changed === false) {
    pendingEnter = null;
    state.activeRoomId = id;
    hideRoomList();
  }
}

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
    enterRoom(wanted);
    return;
  }
  if (!previousRoomId || !wanted) setHashRoom(null);
  showRoomList();
}

function resetRoomView() {
  state.room = null;
  state.members = [];
  state.messages = [];
  state.tasks = new Map();
  state.roster = new Map();
  state.registry = [];
  state.toolLog = [];
  state.filesData = null;
  state.filesError = null;
  state.activeTurns = new Map();
  state.lastTurnByAgent = new Map();
  state.runtime = null;
  state.turnCount = 0;
  state.usage = 0;
  state.busy = false;
  state.pending = 0;
  state.currentSpeakerLast = null;
  state.stopped = false;
  state.paused = null;
  state.resumeTarget = null;
  state.lastFailureBanner = null;
  ensureTicker();
  seqWarningDismissed = false;
  $('seq-warn')?.classList.add('hidden');
  $('stream').innerHTML = '';
  $('loop-warn').classList.add('hidden');
  $('btn-stop').classList.remove('urgent');
  $('mention-hint').textContent = '';
  closeGoalEditor();
  closeMentionMenu();
  setOverridden(false);
}

/* ==========================================================================
   聊天流与失败横幅
   ========================================================================== */

function clearWelcomeCard() {
  $('stream').querySelector('.welcome-card')?.remove();
}

function maybeRenderWelcomeCard() {
  const s = $('stream');
  if (s.children.length > 0 || !state.room) return;
  const card = document.createElement('div');
  card.className = 'welcome-card';
  const hasMembers = state.members.length > 0;
  card.innerHTML = `
    <h3>欢迎来到「${escapeHtml(state.room.name)}」</h3>
    <p>${hasMembers
      ? '在下方直接发消息或输入 @ 点名成员开始协作。你也可以先设定房间目标，或在顶部查看本机 CLI 后端状态。'
      : '这是一个全新的空房间。先添加第一个 AI 成员（会自动成为头头），即可开始多智能体协作。'}</p>
    <div class="welcome-actions">
      ${hasMembers
        ? '<button class="btn ghost sm" type="button" data-welcome-goal="1">◎ 设定房间目标</button>'
        : '<button class="btn primary sm" type="button" data-welcome-add="1">＋ 添加第一个成员</button>'}
      <button class="btn ghost sm" type="button" data-welcome-diag="1">⚡ 检查后端与模型</button>
    </div>`;
  card.querySelector('[data-welcome-add]')?.addEventListener('click', () => openNewMember());
  card.querySelector('[data-welcome-goal]')?.addEventListener('click', () => openGoalEditor());
  card.querySelector('[data-welcome-diag]')?.addEventListener('click', () => openBackendsModal());
  s.appendChild(card);
}

function isNearBottom() {
  const s = $('stream');
  return (s.scrollHeight - s.scrollTop - s.clientHeight) < 140;
}

function scrollToBottom({ force = false } = {}) {
  const s = $('stream');
  if (force || isNearBottom()) {
    s.scrollTop = s.scrollHeight;
    $('btn-scroll-bottom').classList.add('hidden');
  }
}

function renderToolStripSummary(turn, { done = false } = {}) {
  const info = turn.lastToolMeta;
  const count = turn.toolCount;
  if (!info && count <= 0) return;

  turn.toolFeed.classList.remove('hidden');
  turn.toolFeed.classList.toggle('live', !done);
  turn.toolFeed.classList.toggle('done', done);

  const icon = info?.icon ?? '🔧';
  const label = info?.label ?? '执行工具';
  const detail = info?.compactDetail ?? '';
  const fullDetail = info?.detail ?? '';

  if (done) {
    turn.toolStripEl.title = fullDetail ? `最后一步：${label} — ${fullDetail}` : `共执行 ${count} 步工具调用`;
    turn.toolStripEl.innerHTML = `
      <span class="tts-done-icon" aria-hidden="true">✓</span>
      <span class="tts-label">共执行工具</span>
      <span class="tts-step">${count} 步</span>
      <span class="tts-detail">${escapeHtml(detail ? `最后：${label} · ${detail}` : `最后：${label}`)}</span>
      <span class="tts-chevron" aria-hidden="true">▸</span>`;
  } else {
    turn.toolStripEl.title = fullDetail ? `${label}（第 ${count} 步）：${fullDetail}` : `${label}（第 ${count} 步）`;
    turn.toolStripEl.innerHTML = `
      <span class="tts-pulse" aria-hidden="true"></span>
      <span class="tts-icon" aria-hidden="true">${icon}</span>
      <span class="tts-label">${escapeHtml(label)}</span>
      <span class="tts-step">第 ${count} 步</span>
      ${detail ? `<span class="tts-detail">${escapeHtml(detail)}</span>` : '<span class="tts-detail">执行中…</span>'}
      <span class="tts-chevron" aria-hidden="true">▸</span>`;
  }
}

function syncTurnFromRuntime(turn, activeInfo) {
  if (!turn || !activeInfo) return;
  const count = Number(activeInfo.toolCount ?? 0);
  if (count > turn.toolCount) turn.toolCount = count;
  if (activeInfo.lastTool || activeInfo.lastAction || activeInfo.lastDetail) {
    turn.lastToolMeta = describeTool({
      tool: activeInfo.lastTool ?? '',
      action: activeInfo.lastAction ?? '',
      detail: activeInfo.lastDetail ?? '',
    });
    turn.lastToolMeta.action = activeInfo.lastAction ?? '';
  }
  if (turn.toolCount > 0 || turn.lastToolMeta) {
    if (turn.toolCount <= 0) turn.toolCount = 1;
    renderToolStripSummary(turn, { done: false });
  }
}

function recordTurnTool(agentId, ev) {
  if (!agentId) return;
  const turn = ensureTurnEl(agentId);
  const info = describeTool(ev);
  info.action = ev.action ?? '';
  turn.toolCount += 1;
  turn.lastToolMeta = info;

  const step = turn.toolCount;
  const row = document.createElement('div');
  row.className = 'tool-feed-row';
  row.title = info.detail || info.label;
  row.innerHTML = `
    <span class="tfr-num">#${step}</span>
    <span class="tfr-icon" aria-hidden="true">${info.icon}</span>
    <span class="tfr-label">${escapeHtml(info.label)}</span>
    <span class="tfr-detail">${escapeHtml(info.compactDetail || info.shortTool)}</span>
    <span class="tfr-time">${escapeHtml(fmtTime(ev.at ?? Date.now()))}</span>`;
  turn.toolListEl.appendChild(row);
  turn.toolListEl.scrollTop = turn.toolListEl.scrollHeight;
  turn.tools.push({ step, ...info, at: ev.at ?? Date.now() });

  renderToolStripSummary(turn, { done: false });
  scrollToBottom();
}

function ensureTurnEl(agentId, init = {}) {
  const existing = state.activeTurns.get(agentId);
  if (existing) {
    if (init.startedAt) existing.startedAt = Math.min(existing.startedAt, parseTs(init.startedAt));
    if (init.toolCount || init.lastTool || init.lastDetail) syncTurnFromRuntime(existing, init);
    return existing;
  }
  clearWelcomeCard();

  const startedAt = parseTs(init.startedAt ?? Date.now());
  const member = memberById(agentId);
  const wrap = document.createElement('div');
  wrap.className = 'msg agent streaming';
  wrap.dataset.agentId = agentId;

  const av = avatarEl(nameOf(agentId));
  const content = document.createElement('div');

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = `
    <span class="msg-who" style="color:${colorFor(nameOf(agentId))}">${escapeHtml(nameOf(agentId))}</span>
    <span class="msg-role">${member?.role === 'leader' ? '头头' : '成员'}</span>
    ${member?.backend ? backendPillHtml(member.backend) : ''}
    <span class="turn-timer" title="本轮已运行时长">${escapeHtml(fmtElapsed(startedAt))}</span>
    <span class="msg-time"></span>
    <button class="turn-interrupt-btn" type="button" title="仅打断 @${escapeHtml(nameOf(agentId))} 当前这一轮">⏹ 打断</button>`;

  const timerEl = head.querySelector('.turn-timer');
  const interruptBtn = head.querySelector('.turn-interrupt-btn');
  interruptBtn.onclick = () => interruptAgent(agentId);

  const thinking = document.createElement('details');
  thinking.className = 'thinking hidden';
  thinking.innerHTML = '<summary>思考了 0.0 秒</summary><div class="thinking-body"></div>';

  const toolFeed = document.createElement('details');
  toolFeed.className = 'tool-feed live hidden';
  toolFeed.innerHTML = '<summary class="turn-tool-strip"></summary><div class="tool-feed-list"></div>';
  const toolStripEl = toolFeed.querySelector('.turn-tool-strip');
  const toolListEl = toolFeed.querySelector('.tool-feed-list');

  const textEl = document.createElement('div');
  textEl.className = 'msg-body md-body';

  const actions = document.createElement('div');
  actions.className = 'action-area';

  content.append(head, thinking, toolFeed, textEl, actions);
  wrap.append(av, content);
  $('stream').appendChild(wrap);
  scrollToBottom();

  const turn = {
    agentId,
    el: wrap,
    head,
    timerEl,
    interruptBtn,
    thinking,
    toolFeed,
    toolStripEl,
    toolListEl,
    textEl,
    actions,
    text: '',
    thinkText: '',
    startedAt,
    tools: [],
    toolCount: 0,
    lastToolMeta: null,
  };
  state.activeTurns.set(agentId, turn);

  if (init.toolCount || init.lastTool || init.lastDetail) {
    syncTurnFromRuntime(turn, init);
  }
  ensureTicker();
  return turn;
}

function finishSingleTurn(turn, durationMs, { fromFailure = false } = {}) {
  if (!turn) return;
  turn.el.classList.remove('streaming');
  turn.timerEl?.remove();
  turn.interruptBtn?.remove();

  const timeEl = turn.head.querySelector('.msg-time');
  const ms = durationMs ?? (Date.now() - turn.startedAt);
  if (timeEl && ms > 0) timeEl.textContent = `${(ms / 1000).toFixed(1)}s`;
  else if (timeEl) timeEl.textContent = '';

  if (turn.text) turn.textEl.innerHTML = renderBody(turn.text);
  if (turn.thinking.classList.contains('hidden')) turn.thinking.remove();

  if (turn.toolCount > 0) {
    renderToolStripSummary(turn, { done: true });
  } else {
    turn.toolFeed.remove();
  }

  turn.finishedByFailure = fromFailure;
  turn.finishedAt = Date.now();
  state.activeTurns.delete(turn.agentId);
  state.lastTurnByAgent.set(turn.agentId, turn);
  state.turnCount += 1;
}

function finishTurn(agentId = null, durationMs = null, opts = {}) {
  if (agentId != null) {
    const turn = state.activeTurns.get(agentId);
    if (!turn) return;
    finishSingleTurn(turn, durationMs, opts);
  } else {
    for (const turn of [...state.activeTurns.values()]) {
      finishSingleTurn(turn, durationMs, opts);
    }
  }
  ensureTicker();
  renderStatus();
}

function appendHumanMessage(m) {
  clearWelcomeCard();
  const wrap = document.createElement('div');
  wrap.className = 'msg human';
  const av = avatarEl('老板');
  const content = document.createElement('div');
  content.innerHTML = `
    <div class="msg-head">
      <span class="msg-who">老板</span>
      <span class="msg-time">${escapeHtml(fmtTime(m.at))}</span>
    </div>
    <div class="msg-body md-body">${renderBody(m.body)}</div>`;
  wrap.append(av, content);
  $('stream').appendChild(wrap);
  scrollToBottom({ force: true });
}

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

function appendHistoryAgentMessage(m) {
  clearWelcomeCard();
  if (m.passed) return appendPassedNote(m.senderId);
  const failText = turnFailureText(m);
  if (!m.body && !failText) return;

  const member = memberById(m.senderId);
  const wrap = document.createElement('div');
  wrap.className = 'msg agent';
  wrap.dataset.agentId = m.senderId;
  if (m.isSummary) wrap.classList.add('summary');
  const av = avatarEl(nameOf(m.senderId));
  const content = document.createElement('div');
  content.innerHTML = `
    <div class="msg-head">
      <span class="msg-who" style="color:${colorFor(nameOf(m.senderId))}">${escapeHtml(nameOf(m.senderId))}</span>
      <span class="msg-role">${member?.role === 'leader' ? '头头' : '成员'}</span>
      ${member?.backend ? backendPillHtml(member.backend) : ''}
      ${m.isSummary ? '<span class="summary-tag">总结</span>' : ''}
      <span class="msg-time">${escapeHtml(fmtTime(m.at))}${m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(1)}s` : ''}</span>
    </div>
    <div class="msg-body md-body">${renderBody(m.body)}</div>`;
  wrap.append(av, content);
  $('stream').appendChild(wrap);
  if (failText) appendSystemNote(`${nameOf(m.senderId)} ${failText}`, 'warn');
}

function markAsSummary(agentId = null) {
  let targetEl = agentId ? state.lastTurnByAgent.get(agentId)?.el : null;
  if (!targetEl) {
    const msgs = agentId
      ? $('stream').querySelectorAll(`.msg.agent[data-agent-id="${CSS.escape(agentId)}"]`)
      : $('stream').querySelectorAll('.msg.agent');
    targetEl = msgs[msgs.length - 1] ?? null;
  }
  if (!targetEl) return;
  targetEl.classList.add('summary');
  const head = targetEl.querySelector('.msg-head');
  if (head && !head.querySelector('.summary-tag')) {
    const tag = document.createElement('span');
    tag.className = 'summary-tag';
    tag.textContent = '总结';
    head.appendChild(tag);
  }
}

/** 可操作的失败横幅：把真实 CLI 报错直接展示出来，并给一键直达设置/诊断的入口 */
function appendFailureBanner({ agentId = null, title, detail = '' }) {
  clearWelcomeCard();
  const member = agentId ? memberById(agentId) : null;
  const el = document.createElement('div');
  el.className = 'failure-banner';
  el.innerHTML = `
    <div class="failure-banner-head">
      <div class="failure-banner-title">
        <span>⚠</span>
        <span>${escapeHtml(title)}</span>
        ${member?.backend ? backendPillHtml(member.backend) : ''}
      </div>
    </div>
    ${detail ? `<pre class="failure-banner-detail">${escapeHtml(detail)}</pre>` : ''}
    <div class="failure-banner-actions">
      ${member ? `<button class="btn sm primary open-member-btn" type="button">⚙ 打开设置检查模型/后端</button>` : ''}
      <button class="btn sm ghost open-diag-btn" type="button">⚡ 打开后端诊断</button>
    </div>`;

  el.querySelector('.open-member-btn')?.addEventListener('click', () => openMemberSettings(member.id));
  el.querySelector('.open-diag-btn')?.addEventListener('click', () => openBackendsModal());

  $('stream').appendChild(el);
  scrollToBottom();
}

function appendToolNote(ev) {
  const host = (ev.agentId ? state.activeTurns.get(ev.agentId)?.actions : null) ?? $('stream');
  const label = { write: '写入', edit: '编辑', bash: '执行命令', read: '读取' }[ev.action] ?? ev.action;
  const target = ev.action === 'bash' ? ev.command : ev.path;
  const el = document.createElement('div');
  el.className = `tool-note ${escapeHtml(ev.action ?? '')}`;
  el.innerHTML = `<span class="tool-badge">${escapeHtml(label)}</span><code>${escapeHtml(String(target ?? '').slice(0, 220))}</code>`;
  host.appendChild(el);
  scrollToBottom();
}

function renderHistoricalTools(log) {
  const writes = log.filter((e) => e.action === 'write' || e.action === 'edit' || e.action === 'bash');
  if (!writes.length) return;

  const details = document.createElement('details');
  details.className = 'tool-history';
  const head = document.createElement('summary');
  head.textContent = `历史写操作与命令（${writes.length} 条 · 详细记录见右侧「动态」标签）`;
  details.appendChild(head);

  for (const e of writes.slice(-60)) {
    const label = { write: '写入', edit: '编辑', bash: '执行' }[e.action] ?? e.action;
    const target = e.action === 'bash' ? e.command : e.path;
    const row = document.createElement('div');
    row.className = `tool-note ${escapeHtml(e.action ?? '')}`;
    row.innerHTML = `
      <span class="tool-badge">${escapeHtml(label)}</span>
      <code>${escapeHtml(String(target ?? '').slice(0, 200))}</code>
      <span class="tool-who">${escapeHtml(nameOf(e.agentId))}</span>`;
    details.appendChild(row);
  }
  $('stream').appendChild(details);
}

function appendUsageNote(text) {
  clearWelcomeCard();
  const el = document.createElement('div');
  el.className = 'usage-note';
  el.innerHTML = `<span class="usage-note-icon">◔</span><span>${escapeHtml(text)}</span>`;
  $('stream').appendChild(el);
  scrollToBottom();
}

function appendPassedNote(agentId) {
  clearWelcomeCard();
  const el = document.createElement('div');
  el.className = 'passed-note';
  el.innerHTML = `<span class="passed-icon">✓✓</span><span>${escapeHtml(nameOf(agentId))} 已读，未回应</span>`;
  $('stream').appendChild(el);
  scrollToBottom();
}

function appendSystemNote(text, level = 'info') {
  clearWelcomeCard();
  const el = document.createElement('div');
  el.className = `sys-note ${level === 'warn' ? 'warn' : ''}`;
  el.textContent = text;
  $('stream').appendChild(el);
  scrollToBottom();
}

function appendActionCard(results, agentId = null) {
  const host = (agentId
    ? (state.activeTurns.get(agentId)?.actions ?? state.lastTurnByAgent.get(agentId)?.actions)
    : null) ?? $('stream');
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

/* ==========================================================================
   SSE 事件处理
   ========================================================================== */

function handle(ev) {
  switch (ev.type) {
    case 'room.init': {
      const previousRoomId = state.activeRoomId;
      state.activeRoomId = ev.activeRoomId ?? null;
      state.rooms = ev.rooms ?? [];
      state.singleFallback = Boolean(ev.singleFallback);

      if (!ev.room) {
        resetRoomView();
        $('room-name').textContent = '房间';
        renderGoalBar();
        renderMemberList();
        renderRoster();
        renderRepos();
        renderBoard();
        renderFiles();
        renderActivity();
        renderSidebarRooms();
        setHashRoom(null);
        showRoomList();
        break;
      }

      if (previousRoomId && previousRoomId !== ev.room.id) resetRoomView();

      state.room = { ...ev.room };
      state.members = ev.members ?? [];
      state.leaderId = ev.room.leaderId;
      state.registry = ev.registry ?? [];
      state.toolLog = ev.toolLog ?? [];
      state.aiCabTier = ev.aiCabTier ?? 'full';
      $('cabtier').value = state.aiCabTier;
      setOverridden(Boolean(ev.overridden));
      state.stopped = Boolean(ev.stopped);
      state.paused = ev.paused ?? null;
      state.resumeTarget = ev.resumeTarget ?? null;
      renderSeqWarning(ev.seqWarning ?? null);

      state.allowPeerMentions = ev.allowPeerMentions !== false;
      $('peer-mentions').checked = state.allowPeerMentions;
      state.collaborationStyle = ev.collaborationStyle === 'deliver' ? 'deliver' : 'discuss';
      state.headPassiveWake = ev.headPassiveWake !== false;
      $('passive-wake').checked = state.headPassiveWake;
      $('room-timeout').value = ev.turnTimeoutMinutes != null ? String(ev.turnTimeoutMinutes) : '';

      state.executionMode = ev.executionMode ?? ev.runtime?.executionMode ?? 'auto';
      state.effectiveMode = ev.effectiveExecutionMode ?? ev.runtime?.effectiveMode ?? computeEffectiveMode();
      state.maxConcurrency = Number(ev.maxConcurrency ?? ev.runtime?.maxConcurrency ?? 4) || 4;
      state.runtime = ev.runtime ?? null;
      state.activeTurns = new Map();
      state.lastTurnByAgent = new Map();

      $('room-name').textContent = ev.room.name;
      document.title = `${ev.room.name} · SuperAI`;
      renderGoalBar();
      renderExecModeControls();
      renderCollabStyleControls();

      state.tasks = new Map();
      for (const t of (ev.tasks ?? [])) state.tasks.set(t.id, t);
      state.roster = new Map();
      for (const [k, v] of (ev.roster ?? [])) state.roster.set(k, v);

      renderMemberList();
      renderRoster();
      renderRepos();
      renderBoard();
      renderActivity();

      const history = ev.history ?? [];
      state.messages = [...history];
      state.turnCount = history.filter((m) => m.senderId !== 'human').length;
      state.usage = history.reduce((sum, m) => sum + (m.usageTokens ?? 0), 0);

      $('stream').innerHTML = '';
      for (const m of state.members) {
        if (m.sessionResetReason) {
          appendSystemNote(`@${m.name} 的上下文已重置（${m.sessionResetReason}），它会忘记之前的对话`, 'warn');
        }
      }
      for (const m of history) {
        if (m.senderId === 'human') appendHumanMessage(m);
        else appendHistoryAgentMessage(m);
      }
      renderHistoricalTools(state.toolLog);

      // 刷新恢复：若当前已有成员正在运行，立刻恢复其进行中气泡与最新工具进度
      if (ev.runtime) {
        applyRuntime(ev.runtime, { hydrateTurns: true });
      }
      maybeRenderWelcomeCard();

      renderSidebarRooms();
      renderRoomList();
      scrollToBottom({ force: true });
      renderStatus();
      fetchFiles({ silent: true });

      decideView(previousRoomId);
      break;
    }

    case 'runtime.state':
      applyRuntime(ev, { hydrateTurns: false });
      break;

    case 'room.paused': {
      state.paused = { reason: ev.reason, detail: ev.detail ?? '', at: new Date().toISOString() };
      // 实时事件同步 resumeTarget，保证按钮文案「接着做完」与后端一致
      state.resumeTarget = ev.resumeTarget ?? null;
      state.busy = false;
      state.pending = 0;

      if (ev.reason === 'error') {
        const recentSame = state.lastFailureBanner
          && (Date.now() - state.lastFailureBanner.at < 4000)
          && (!ev.detail || state.lastFailureBanner.detail === ev.detail);
        if (!recentSame) {
          appendFailureBanner({
            agentId: ev.agentId ?? state.lastFailureBanner?.agentId ?? state.currentSpeakerLast,
            title: `停在：${PAUSE_LABEL.error}`,
            detail: ev.detail ?? '',
          });
        }
      } else if (ev.reason !== 'no_target') {
        appendSystemNote(`停在：${PAUSE_LABEL[ev.reason] ?? ev.reason}${ev.detail ? ` · ${ev.detail}` : ''}`, 'warn');
      }
      renderStatus();
      break;
    }

    case 'room.resumed':
    case 'resumed':
      state.stopped = false;
      if (ev.reason !== 'cleared') state.paused = null;
      if (ev.text) appendSystemNote(ev.text);
      renderStatus();
      break;

    case 'backends.updated':
      if (Array.isArray(ev.backends)) {
        state.backends = ev.backends;
        state.backendsCheckedAt = new Date().toISOString();
        state.backendsLoaded = true;
        renderBackendPills();
        if (!$('backends-modal').classList.contains('hidden')) renderBackendsModal();
        if (mm && !$('member-modal').classList.contains('hidden')) {
          syncBackendSelectOptions();
          renderModelHints();
        }
      }
      break;

    case 'cap.continue':
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
      renderExecModeControls();
      break;

    case 'rooms.updated':
      state.rooms = ev.rooms ?? [];
      renderSidebarRooms();
      renderRoomList();
      break;

    case 'room.renamed':
      if (ev.id === state.activeRoomId) {
        if (state.room) state.room.name = ev.name;
        $('room-name').textContent = ev.name;
        document.title = `${ev.name} · SuperAI`;
      }
      renderSidebarRooms();
      renderRoomList();
      break;

    case 'room.settings': {
      const notes = [];
      if (ev.goal !== undefined) {
        if (state.room) state.room.goal = ev.goal ?? '';
        renderGoalBar();
        notes.push(ev.goal ? `房间目标已更新` : '已清空房间目标');
      }
      if (ev.allowPeerMentions !== undefined) {
        state.allowPeerMentions = Boolean(ev.allowPeerMentions);
        $('peer-mentions').checked = state.allowPeerMentions;
        renderCollabStyleControls();
        notes.push(state.allowPeerMentions ? '已开启成员之间互相 @ 协作' : '已关闭成员之间互相 @ 协作');
      }
      if (ev.collaborationStyle !== undefined) {
        state.collaborationStyle = ev.collaborationStyle === 'deliver' ? 'deliver' : 'discuss';
        renderCollabStyleControls();
        notes.push(state.collaborationStyle === 'discuss'
          ? '协作风格已切换为「深度讨论（交叉质询）」'
          : '协作风格已切换为「高效交付」');
      }
      if (ev.headPassiveWake !== undefined) {
        state.headPassiveWake = Boolean(ev.headPassiveWake);
        $('passive-wake').checked = state.headPassiveWake;
        notes.push(state.headPassiveWake ? '成员不 @ 发言会叫醒头头' : '已关闭：成员不 @ 发言不再叫醒头头');
      }
      if (ev.turnTimeoutMinutes !== undefined) {
        $('room-timeout').value = ev.turnTimeoutMinutes != null ? String(ev.turnTimeoutMinutes) : '';
        notes.push(ev.turnTimeoutMinutes ? `单轮上限已改为 ${ev.turnTimeoutMinutes} 分钟` : '单轮上限已恢复默认（20 分钟）');
      }
      if (ev.executionMode !== undefined || ev.effectiveExecutionMode !== undefined || ev.maxConcurrency !== undefined) {
        if (ev.executionMode !== undefined) state.executionMode = ev.executionMode;
        if (ev.effectiveExecutionMode !== undefined) state.effectiveMode = ev.effectiveExecutionMode;
        if (ev.maxConcurrency !== undefined) state.maxConcurrency = Number(ev.maxConcurrency) || 4;
        if (state.runtime) {
          if (ev.executionMode !== undefined) state.runtime.executionMode = state.executionMode;
          if (ev.effectiveExecutionMode !== undefined) state.runtime.effectiveMode = state.effectiveMode;
          if (ev.maxConcurrency !== undefined) state.runtime.maxConcurrency = state.maxConcurrency;
        }
        renderExecModeControls();
        const modeCn = { auto: '智能模式', parallel: '始终并行', serial: '严格串行' }[state.executionMode] ?? state.executionMode;
        const effCn = computeEffectiveMode() === 'parallel' ? `当前并行（最多 ${state.maxConcurrency} 并发）` : '当前串行';
        notes.push(`执行模式：${modeCn}（${effCn}）`);
      }
      if (notes.length) appendSystemNote(notes.join('；'));
      break;
    }

    case 'head.passive_wake':
      appendSystemNote(ev.text ?? `成员无 @ 发言，已叫醒头头（${ev.count} 条）`);
      break;

    case 'room.switched':
      appendSystemNote(`已切换到房间「${ev.room.name}」${ev.dropped ? `，丢弃 ${ev.dropped} 条过期发言` : ''}`);
      break;

    case 'halted':
      if (ev.dropped) appendSystemNote(`已停止当前发言，丢弃 ${ev.dropped} 条排队发言`, 'warn');
      break;

    case 'snapshot':
      if (Array.isArray(ev.tasks)) {
        for (const t of ev.tasks) state.tasks.set(t.id, t);
        renderBoard();
      }
      if (Array.isArray(ev.roster)) {
        for (const [k, v] of ev.roster) state.roster.set(k, v);
        renderRoster();
      }
      if (ev.runtime) {
        applyRuntime(ev.runtime, { hydrateTurns: false });
      }
      state.busy = Boolean(ev.busy);
      renderStatus();
      break;

    case 'turn.start':
      state.busy = true;
      state.paused = null;
      if (ev.pending != null) state.pending = ev.pending;
      ensureTurnEl(ev.agentId, { startedAt: ev.startedAt ?? Date.now() });
      renderMemberList();
      renderStatus();
      break;

    case 'queued':
      if (!ev.alreadyQueued) state.pending = Math.max(state.pending, ev.pending ?? 1);
      renderStatus();
      break;

    case 'text': {
      const cur = state.activeTurns.get(ev.agentId) ?? ensureTurnEl(ev.agentId);
      if (!ev.text) break;
      cur.text += ev.text;
      cur.textEl.textContent = /```actions?\b/.test(cur.text)
        ? cur.text.split(/```actions?\b/)[0]
        : cur.text;
      scrollToBottom();
      break;
    }

    case 'thinking': {
      const cur = state.activeTurns.get(ev.agentId) ?? ensureTurnEl(ev.agentId);
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
      if (!m) break;
      state.messages.push(m);
      if (m.senderId === 'human') {
        appendHumanMessage(m);
        break;
      }
      if (m.passed) {
        finishTurn(m.senderId, m.durationMs);
        appendPassedNote(m.senderId);
        state.pending = ev.pending ?? state.pending;
        state.busy = state.activeTurns.size > 0 || state.pending > 0;
        renderMemberList();
        renderStatus();
        break;
      }
      const activeTurn = state.activeTurns.get(m.senderId);
      const recentFailTurn = state.lastTurnByAgent.get(m.senderId);
      if (activeTurn) {
        activeTurn.text = m.body;
        activeTurn.textEl.innerHTML = renderBody(m.body, { live: true });
        finishTurn(m.senderId, m.durationMs);
      } else if (recentFailTurn?.finishedByFailure && (Date.now() - recentFailTurn.finishedAt < 5000)) {
        recentFailTurn.finishedByFailure = false;
        if (m.body) {
          recentFailTurn.text = m.body;
          recentFailTurn.textEl.innerHTML = renderBody(m.body, { live: true });
        }
      } else if (m.body) {
        appendHistoryAgentMessage(m);
      }
      if (m.isSummary) markAsSummary(m.senderId);
      const failText = turnFailureText(m);
      if (failText) appendSystemNote(`${nameOf(m.senderId)} ${failText}`, 'warn');
      state.currentSpeakerLast = m.senderId;
      state.pending = ev.pending ?? 0;
      state.busy = state.activeTurns.size > 0 || state.pending > 0;
      renderMemberList();
      renderStatus();
      scheduleFilesRefresh();
      break;
    }

    case 'action.results':
      appendActionCard(ev.results ?? [], ev.agentId ?? null);
      break;

    case 'task.created':
      state.tasks.set(ev.task.id, ev.task);
      renderBoard();
      appendActionCard(
        [{ ok: true, label: '新任务', detail: `${ev.task.id} ${ev.task.title}` }],
        ev.agentId ?? ev.task?.createdBy ?? null,
      );
      break;

    case 'tool': {
      // 全量工具（read / write / edit / bash / other）均实时更新聊天气泡工具进度条
      if (ev.agentId) {
        recordTurnTool(ev.agentId, ev);
      }
      if (ev.action === 'write' || ev.action === 'edit' || ev.action === 'bash') {
        appendToolNote(ev);
        scheduleFilesRefresh();
      }
      state.toolLog.push({ ...ev, at: ev.at ?? new Date().toISOString() });
      renderActivity();
      renderMemberList();
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

    case 'broadcast': {
      const isPar = computeEffectiveMode() === 'parallel';
      const sep = isPar ? '、' : ' → ';
      appendSystemNote(`广播：${ev.recipients.length} 人将${isPar ? '并行' : '依次'}回应（${ev.recipients.map((r) => '@' + nameOf(r)).join(sep)}）`);
      break;
    }

    case 'cabtier.updated':
      state.aiCabTier = ev.tier;
      $('cabtier').value = ev.tier;
      appendSystemNote(`AI 创建成员的最高权限已改为「${cabTierLabel(ev.tier)}」`);
      break;

    case 'member.created':
      if (!state.members.some((m) => m.id === ev.member.id)) {
        state.members.push(ev.member);
        renderMemberList();
        renderRoster();
        renderExecModeControls();
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

    case 'usage.warning':
      appendUsageNote(ev.text);
      break;

    case 'notice':
      appendSystemNote(ev.text, ev.slowStart ? 'info' : ev.level);
      break;

    case 'retry':
      appendSystemNote(`${nameOf(ev.agentId)} 续做一次：${ev.reason}`, 'info');
      break;

    case 'retry.given-up':
      appendSystemNote(`${nameOf(ev.agentId)} 不会自动续做：${ev.reason}`, 'warn');
      break;

    case 'failure': {
      const REASON_CN = { timeout: '超时', crashed: '崩溃', failed: '运行失败', interrupted: '被打断' };
      const title = `${nameOf(ev.agentId)} ${REASON_CN[ev.reason] ?? ev.reason}`;
      const detail = String(ev.detail ?? '').trim();
      state.lastFailureBanner = { agentId: ev.agentId, detail, at: Date.now() };
      appendFailureBanner({ agentId: ev.agentId, title, detail });
      if (ev.agentId && ev.agentId !== 'system') finishTurn(ev.agentId, null, { fromFailure: true });
      state.busy = state.activeTurns.size > 0 || state.pending > 0;
      renderMemberList();
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
      if (state.activeTurns.size > 0) finishTurn(null);
      state.busy = false;
      state.pending = 0;
      renderMemberList();
      renderStatus();
      break;

    case 'stopped':
      state.stopped = true;
      state.busy = false;
      state.pending = 0;
      appendSystemNote(ev.text ?? '房间已停止', 'warn');
      finishTurn(null);
      renderMemberList();
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
  es.onopen = () => {
    state.connected = true;
    $('conn-dot').className = 'dot ok';
    if (state.disconnectedNotified) {
      state.disconnectedNotified = false;
      appendSystemNote('已重新连接到后台服务');
    }
  };
  es.onmessage = (e) => {
    try { handle(JSON.parse(e.data)); } catch (err) { console.error('bad event', err, e.data); }
  };
  es.onerror = () => {
    state.connected = false;
    $('conn-dot').className = 'dot warn';
    if (!state.disconnectedNotified) {
      state.disconnectedNotified = true;
      appendSystemNote('与后台断开连接，正在自动重连…', 'warn');
    }
  };
}

/* ==========================================================================
   输入区与 @ 候选自动补全
   ========================================================================== */

const mention = {
  open: false,
  items: [],
  active: 0,
  atIndex: -1,
};

function findMentionContext(value, caret) {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const frag = before.slice(at + 1);
  if (/\s/.test(frag)) return null;
  return { atIndex: at, frag };
}

function openMentionMenu(ctx) {
  const frag = ctx.frag.toLowerCase();
  const ordered = [...state.members].sort((a, b) => (a.role === 'leader' ? 0 : 1) - (b.role === 'leader' ? 0 : 1));
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
      <span class="mention-backend">${backendPillHtml(m.backend ?? '')}</span>`;
    row.prepend(avatarEl(m.name));
    row.onmousedown = (e) => {
      e.preventDefault();
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

function broadcastOrder() {
  const leader = state.members.filter((m) => m.role === 'leader');
  const rest = state.members.filter((m) => m.role !== 'leader');
  return [...leader, ...rest].map((m) => m.name);
}

function updateMentionHint() {
  const v = $('input').value;
  const hint = $('mention-hint');
  const caret = $('input').selectionStart ?? v.length;

  const ctx = findMentionContext(v, caret);
  if (ctx) {
    openMentionMenu(ctx);
    hint.textContent = '';
    hint.className = 'mention-hint';
    return;
  }
  closeMentionMenu();

  const mentionsAnyone = /[@＠]\s*[\w一-鿿]/.test(v);
  if (v.trim() && !mentionsAnyone && state.members.length > 0) {
    const order = broadcastOrder();
    const isPar = computeEffectiveMode() === 'parallel';
    hint.textContent = isPar
      ? `未点名 → 将并行通知 ${order.length} 人：${order.map((n) => '@' + n).join('、')}`
      : `未点名 → 将依次通知 ${order.length} 人：${order.map((n) => '@' + n).join(' → ')}`;
    hint.className = 'mention-hint warn';
    return;
  }

  hint.textContent = '';
  hint.className = 'mention-hint';
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
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

/* ==========================================================================
   seq 撞号常驻提示
   ========================================================================== */

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

/* ==========================================================================
   任务抽屉与 Diff 验收
   ========================================================================== */

async function openTask(id) {
  const t = state.tasks.get(id);
  if (!t) return;
  $('drawer').classList.remove('hidden');
  $('drawer-title').textContent = `${t.id}  ${t.title}`;
  $('drawer-meta').innerHTML = `<span class="tier-badge">${escapeHtml(t.status)}</span>`
    + (t.assignee ? `<span>负责人：@${escapeHtml(nameOf(t.assignee))}</span>` : '<span>未指派</span>');
  $('drawer-actions').innerHTML = '';

  const body = $('drawer-body');
  body.innerHTML = '<div class="link-note">加载任务详情与改动中…</div>';

  const related = state.messages.filter((m) => m.taskId === id);

  let html = `
    <h3>状态与备注</h3>
    <div class="link-note">${escapeHtml(t.status)}${t.assignee ? ` → @${escapeHtml(nameOf(t.assignee))}` : ''}${t.note ? ` · ${escapeHtml(t.note)}` : ''}</div>
    <h3>相关讨论</h3>`;
  if (related.length) {
    html += related.map((m) => (
      `<div class="link-note"><b>${escapeHtml(nameOf(m.senderId))}</b>：${escapeHtml(String(m.body ?? '').slice(0, 400))}</div>`
    )).join('');
  } else {
    html += '<div class="link-note">该任务还没有关联讨论</div>';
  }
  body.innerHTML = html;

  const diffRes = await fetch(`/api/diff?task=${encodeURIComponent(id)}`).catch(() => null);
  if (!diffRes?.ok) return;

  const d = await diffRes.json();
  if (!d.files?.length) {
    body.insertAdjacentHTML('beforeend',
      '<h3>改动</h3><div class="link-note">这个任务还没有任何代码改动</div>');
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
      <button id="btn-merge" class="btn primary" type="button">合并进主分支</button>
      <button id="btn-discard" class="btn danger" type="button">丢弃改动</button>
    </div>`);

  $('btn-merge').onclick = () => acceptTask(t, 'merge');
  $('btn-discard').onclick = () => acceptTask(t, 'discard', () => (
    window.confirm(`确定丢弃 ${t.id} 的改动？\n会删除 ${t.worktree}\n（${d.files.length} 个文件的改动将丢失）`)
  ));
}

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

function closeDrawer() {
  $('drawer').classList.add('hidden');
}

/* ==========================================================================
   总结成员选择弹窗 (#picker-modal)
   ========================================================================== */

function openSummarizePicker() {
  if (!state.members.length) {
    appendSystemNote('房间里还没有成员，无法发起总结', 'warn');
    return;
  }
  const list = $('pm-list');
  list.innerHTML = '';
  for (const m of state.members) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'picker-row';
    btn.innerHTML = `
      <span class="picker-row-name">${escapeHtml(m.name)}</span>
      <span class="member-role ${m.role === 'leader' ? '' : 'member'}">${m.role === 'leader' ? '头头' : '成员'}</span>
      <span class="picker-row-meta">${backendPillHtml(m.backend)}</span>`;
    btn.prepend(avatarEl(m.name));
    btn.onclick = async () => {
      closePickerModal();
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: m.id }),
      });
      if (res.ok) appendSystemNote(`${m.name} 开始总结（说完房间会停住）`);
      else appendSystemNote('发起总结失败', 'warn');
    };
    list.appendChild(btn);
  }
  $('picker-modal').classList.remove('hidden');
}

function closePickerModal() {
  $('picker-modal').classList.add('hidden');
}

/* ==========================================================================
   成员设置弹窗 v2 (#member-modal)
   ========================================================================== */

let mm = null;

function pickDefaultBackend() {
  const pref = ['agy', 'claude', 'opencode', 'codex'];
  for (const id of pref) {
    if (backendInfo(id)?.status === 'ready') return id;
  }
  for (const id of pref) {
    if (backendInfo(id)?.installed) return id;
  }
  return 'agy';
}

function tiersForBackend(backend, member = null) {
  const b = backendInfo(backend);
  if (Array.isArray(b?.tiers) && b.tiers.length) return b.tiers;
  if (Array.isArray(member?.tiers) && member.tiers.length && member.backend === backend) return member.tiers;
  return DEFAULT_BACKEND_TIERS[backend] ?? ['readonly', 'read', 'write', 'write-exec', 'full'];
}

function syncBackendSelectOptions() {
  const sel = $('mm-backend');
  const currentVal = sel.value;
  sel.innerHTML = '';
  for (const id of BACKEND_ORDER) {
    const b = backendInfo(id);
    const opt = document.createElement('option');
    opt.value = id;
    if (b) {
      const icon = b.status === 'ready' ? '●' : (b.status === 'warn' ? '▲' : '○');
      const mCount = b.models?.length ? ` · ${b.models.length} 模型` : '';
      opt.textContent = `${icon} ${id}（${backendStatusLabel(b.status)}${mCount}）`;
    } else {
      opt.textContent = id;
    }
    sel.appendChild(opt);
  }
  if (currentVal && BACKEND_ORDER.includes(currentVal)) sel.value = currentVal;
}

function openMemberSettings(id) {
  const m = memberById(id);
  if (!m) return;

  syncBackendSelectOptions();
  mm = {
    id: m.id,
    original: { ...m },
    backend: m.backend,
    tier: m.tier,
    confirmOverride: false,
    isNew: false,
  };

  $('mm-title').textContent = `成员设置 · ${m.name}`;
  $('mm-subtitle').textContent = `ID: ${m.id} · 修改后下一轮立即生效，无需重启`;
  $('mm-name').value = m.name;
  $('mm-backend').value = m.backend;
  $('mm-model').value = m.model ?? '';
  $('mm-effort').value = m.effort ?? '';
  $('mm-extra').value = m.extraArgs ?? '';
  $('mm-commands').value = (m.allowedCommands ?? '').replace(/\bnetget\b\s*/g, '').trim();
  $('mm-netget').checked = /\bnetget\b/.test(m.allowedCommands ?? '');
  updateCurlWarn();
  $('mm-timeout').value = m.timeoutMinutes ?? '';
  $('mm-timeout-hint').textContent = m.timeoutSource === 'legacy'
    ? `⚠️ 当前实际生效 ${m.effectiveTimeoutMinutes} 分钟（来自配置手写 timeoutMs）；在此填入新值将覆盖它。`
    : `实际生效：${m.effectiveTimeoutMinutes} 分钟。留空 = 使用房间默认上限。`;
  $('mm-role').value = m.role;
  $('mm-role').disabled = false;
  $('mm-persona').value = m.persona ?? '';
  $('mm-remove').classList.remove('hidden');
  $('mm-error').classList.add('hidden');

  renderTierChoices(tiersForBackend(m.backend, m));
  renderModelHints();
  updateTierDependentControls();
  updatePreview();
  $('member-modal').classList.remove('hidden');
  $('mm-name').focus();
}

function openNewMember() {
  const isFirst = state.members.length === 0;
  const defaultBackend = pickDefaultBackend();
  const support = tiersForBackend(defaultBackend);
  const defaultTier = support.includes('full') ? 'full' : support[support.length - 1];

  syncBackendSelectOptions();
  mm = {
    id: null,
    original: null,
    backend: defaultBackend,
    tier: defaultTier,
    confirmOverride: false,
    isNew: true,
    isFirst,
  };

  $('mm-title').textContent = isFirst ? '添加第一个成员（自动成为头头）' : '添加新成员';
  $('mm-subtitle').textContent = '默认选择已就绪后端与完全开放档位，开箱即可高效协作';
  $('mm-name').value = isFirst ? 'lead' : '';
  $('mm-backend').value = defaultBackend;
  $('mm-model').value = '';
  $('mm-effort').value = '';
  $('mm-extra').value = '';
  $('mm-commands').value = '';
  $('mm-netget').checked = false;
  updateCurlWarn();
  $('mm-timeout').value = '';
  $('mm-timeout-hint').textContent = '防无限跑上限；卡死另由看门狗判（90 秒无输出）。';
  $('mm-role').value = isFirst ? 'leader' : 'member';
  $('mm-role').disabled = isFirst;
  $('mm-persona').value = '';
  $('mm-remove').classList.add('hidden');
  $('mm-error').classList.add('hidden');

  renderTierChoices(support);
  renderModelHints();
  updateTierDependentControls();
  updatePreview();
  $('member-modal').classList.remove('hidden');
  $('mm-name').focus();
  if (isFirst) $('mm-name').select();
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
  // 将 full 放在最前面（推荐），其余按从强到弱清晰排列
  const order = ['full', 'write-exec', 'write', 'write-ask', 'read', 'readonly'];
  const sorted = [...new Set(list)].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  for (const tier of sorted) {
    const [name, desc] = TIER_TEXT[tier] ?? [tier, ''];
    const label = document.createElement('label');
    const isFull = tier === 'full';
    label.className = `tier-choice${isFull ? ' full-option' : ''}${mm.tier === tier ? ' selected' : ''}`;
    label.innerHTML = `
      <input type="radio" name="mm-tier" value="${escapeHtml(tier)}" ${mm.tier === tier ? 'checked' : ''}>
      <span class="tier-choice-main">
        <span class="tier-choice-head">
          <span class="tier-choice-name">${escapeHtml(name)}</span>
          ${isFull ? '<span class="tier-rec-tag">推荐</span>' : ''}
        </span>
        <span class="tier-choice-desc">${escapeHtml(desc)}</span>
      </span>`;
    label.querySelector('input').onchange = () => {
      mm.tier = tier;
      renderTierChoices(list);
      updateTierDependentControls();
      updatePreview();
    };
    box.appendChild(label);
  }

  $('mm-tier-hint').textContent = list.includes(mm.tier)
    ? ''
    : `当前后端不支持「${mm.tier}」，请重选一档。`;
}

function renderModelHints() {
  const b = backendInfo(mm.backend);
  const discovered = Array.isArray(b?.models) && b.models.length
    ? b.models
    : (FALLBACK_MODEL_HINTS[mm.backend] ?? []);

  // datalist
  $('mm-model-list').innerHTML = discovered.map((h) => `<option value="${escapeHtml(h)}">`).join('');

  // clickable model chips
  const modelChips = $('mm-model-chips');
  modelChips.innerHTML = '';
  const currentModel = $('mm-model').value.trim();
  for (const modelName of discovered.slice(0, 12)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `quick-chip${currentModel === modelName ? ' active' : ''}`;
    chip.textContent = modelName;
    chip.title = currentModel === modelName ? '点击清除模型覆盖' : `点击选用模型 ${modelName}`;
    chip.onclick = () => {
      $('mm-model').value = $('mm-model').value.trim() === modelName ? '' : modelName;
      renderModelHints();
      updatePreview();
    };
    modelChips.appendChild(chip);
  }

  // effort hints + chips
  const m = mm.isNew ? null : memberById(mm.id);
  const efforts = (Array.isArray(b?.effortHints) && b.effortHints.length)
    ? b.effortHints
    : ((m?.effortHints?.length ? m.effortHints : null) ?? DEFAULT_EFFORT_HINTS[mm.backend] ?? []);
  $('mm-effort-list').innerHTML = efforts.map((h) => `<option value="${escapeHtml(h)}">`).join('');

  const effortChips = $('mm-effort-chips');
  effortChips.innerHTML = '';
  const currentEffort = $('mm-effort').value.trim();
  for (const ef of efforts) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `quick-chip${currentEffort === ef ? ' active' : ''}`;
    chip.textContent = ef;
    chip.onclick = () => {
      $('mm-effort').value = $('mm-effort').value.trim() === ef ? '' : ef;
      renderModelHints();
      updatePreview();
    };
    effortChips.appendChild(chip);
  }

  // backend live inline status
  const statusEl = $('mm-backend-status');
  if (b) {
    const st = b.status ?? (b.installed ? 'ready' : 'missing');
    const issueStr = b.issues?.length ? ` · ⚠ ${b.issues[0]}` : '';
    statusEl.innerHTML = `
      <span class="bc-status ${escapeHtml(st)}"><span class="dot ${escapeHtml(st)}"></span>${escapeHtml(backendStatusLabel(st))}</span>
      ${b.version ? `<span class="bc-tag">v ${escapeHtml(b.version)}</span>` : ''}
      ${b.configuredModel ? `<span class="bc-tag">默认：${escapeHtml(b.configuredModel)}</span>` : ''}
      ${issueStr ? `<span class="danger-hint">${escapeHtml(issueStr)}</span>` : ''}`;
  } else {
    statusEl.innerHTML = '';
  }

  $('mm-backend-hint').textContent = mm.backend === 'codex'
    ? 'codex 支持「完全开放」「可写+执行」「可读」三档；模型留空使用本机 codex 配置。'
    : (mm.backend === 'agy' ? 'agy 原生支持流式输出与模型自动发现，推荐使用完全开放档。' : '');
}

/** 根据当前档位（特别是 full vs write-exec vs 其他）切换联网与白名单控件 */
function updateTierDependentControls() {
  const isFull = mm?.tier === 'full';
  $('mm-full-note').classList.toggle('hidden', !isFull);
  $('mm-netget-field').classList.toggle('hidden', isFull);
  $('mm-commands-field').classList.toggle('hidden', isFull);

  if (isFull) return;

  const isExec = mm?.tier === 'write-exec';
  const box = $('mm-netget');
  box.disabled = !isExec;
  if (!isExec) box.checked = false;
  const hint = $('mm-netget-hint');
  if (hint) {
    hint.dataset.orig ??= hint.innerHTML;
    if (isExec) {
      hint.innerHTML = hint.dataset.orig;
    } else {
      hint.textContent = '只有「可写+执行」或「完全开放」档才能联网：当前档位不开放命令工具。';
    }
  }
}

function updateCurlWarn() {
  const v = $('mm-commands').value;
  const risky = /(^|\s)(curl|wget)(\s|$)/.test(v);
  const el = $('mm-curl-warn');
  el.textContent = risky
    ? '⚠️ curl/wget 不受目录限制：能读本机任意文件（如 file:///etc/hostname）、能写到工作目录之外、能上传外传。'
    : '';
  el.classList.toggle('hidden', !risky);
}

function updatePreview() {
  const backend = $('mm-backend').value;
  const model = $('mm-model').value.trim();
  const effort = $('mm-effort').value.trim();
  const extra = $('mm-extra').value.trim();
  const tier = mm?.tier ?? 'full';

  const parts = [];

  if (backend === 'agy') {
    parts.push('agy', '--output-format', 'stream-json');
    if (tier === 'full') parts.push('--dangerously-skip-permissions', '--disable-slash-commands');
    else if (tier === 'write-exec') parts.push('--mode', 'auto', '--disable-slash-commands');
    else if (tier === 'write') parts.push('--mode', 'accept-edits', '--disable-slash-commands');
    else parts.push('--mode', 'plan');
  } else if (backend === 'claude') {
    parts.push('claude', '-p', '--output-format', 'stream-json');
    if (tier === 'full') parts.push('--dangerously-skip-permissions');
    else if (tier === 'readonly') parts.push('--tools', '""');
    else if (tier === 'read') parts.push('--tools', '"Read,Grep,Glob"');
    else if (tier === 'write-ask') parts.push('--tools', '"Read,Write,Edit"', '--permission-prompts', 'host');
    else if (tier === 'write') parts.push('--tools', '"Read,Write,Edit"', '--permission-mode', 'acceptEdits');
    else if (tier === 'write-exec') parts.push('--tools', '"Read,Write,Edit,Bash"');
  } else if (backend === 'codex') {
    parts.push('codex', 'exec', '--json');
    if (tier === 'full') parts.push('--dangerously-bypass-approvals-and-sandbox');
    else if (tier === 'write-exec') parts.push('-s', 'workspace-write');
    else parts.push('-s', 'read-only');
  } else if (backend === 'opencode') {
    parts.push('opencode', 'run', '--format', 'json');
    if (tier === 'full') parts.push('--auto');
  } else {
    parts.push(backend);
  }

  if (model) {
    if (backend === 'claude' || backend === 'agy') parts.push('--model', model);
    else if (backend === 'codex') parts.push(`-c model="${model}"`);
    else parts.push('-m', model);
  }
  if (effort) {
    if (backend === 'claude' || backend === 'agy') parts.push('--effort', effort);
    else if (backend === 'codex') parts.push(`-c model_reasoning_effort="${effort}"`);
    else parts.push('--variant', effort);
  }

  if (tier !== 'full') {
    const cmds = [
      $('mm-netget').checked ? 'netget' : null,
      ...$('mm-commands').value.trim().split(/[\s,，]+/).filter(Boolean),
    ].filter(Boolean);
    if (cmds.length && tier === 'write-exec') {
      if (backend === 'claude') {
        parts.push('--allowedTools', ...cmds.map((c) => (
          c === 'netget' ? '"Bash(<数据目录>/bin/netget:*)"' : `"Bash(${c}:*)"`
        )));
      } else {
        parts.push(`（${backend} 的可写+执行档默认放行命令，无需 --allowedTools）`);
      }
    } else if (cmds.length) {
      parts.push('（命令白名单只对「可写+执行」档生效）');
    }
  }

  if (extra) parts.push(extra);

  $('mm-preview').textContent = parts.join(' ');

  const overrides = /(^|\s)(--tools|--permission-mode|--permission-prompts|--dangerously-skip-permissions|--mode|-s|--sandbox|sandbox_mode=|--dangerously-bypass-approvals-and-sandbox|--variant)(\s|$|=)/.test(` ${extra} `);
  $('mm-override-warn').classList.toggle('hidden', !overrides || !extra);
}

async function saveMemberSettings() {
  if (!mm) return;
  const err = $('mm-error');
  err.classList.add('hidden');

  const backend = $('mm-backend').value;
  const name = $('mm-name').value.trim();
  if (!name) return showModalError('名字不能为空');

  const changingBackend = !mm.isNew && backend !== mm.original.backend;
  if (changingBackend && !window.confirm(
    `把这个成员的后端从 ${mm.original.backend} 换成 ${backend}？\n\n`
    + '会话 id 属于原来的 CLI，换后端会重置上下文——它之前的对话记忆会清空。\n继续？',
  )) return;

  const extraText = $('mm-extra').value;
  const overrides = /(--tools|--permission-mode|--permission-prompts|--dangerously-skip-permissions|--mode|(^|\s)-s(\s|$)|--sandbox|sandbox_mode=|--dangerously-bypass-approvals-and-sandbox)/.test(extraText);
  if (overrides && !mm.confirmOverride) {
    if (!window.confirm(
      '这些启动参数会覆盖能力档位，实际权限以参数为准。\n\n'
      + `参数：${extraText}\n\n确认要用这些参数？保存后卡片上会常驻标注「档位被参数覆盖」。`,
    )) return;
    mm.confirmOverride = true;
  }

  const allowedCommands = mm.tier === 'full'
    ? ''
    : [
      $('mm-netget').checked ? 'netget' : null,
      $('mm-commands').value.trim(),
    ].filter(Boolean).join(' ');

  const payload = {
    name,
    backend,
    tier: mm.tier,
    model: $('mm-model').value.trim(),
    effort: $('mm-effort').value.trim(),
    extraArgs: extraText,
    allowedCommands,
    timeoutMinutes: $('mm-timeout').value,
    role: $('mm-role').value,
    persona: $('mm-persona').value,
  };

  if (mm.isNew) {
    const res = await fetch('/api/member', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, tier: mm.tier, confirmOverride: mm.confirmOverride }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showModalError(data.error ?? `保存失败（${res.status}）`);
    appendSystemNote(`已添加成员 @${data.member?.name ?? name}（${backend} · ${tierLabel(mm.tier)}${data.role === 'leader' ? ' · 头头' : ''}）`);
    closeMemberSettings();
    return;
  }

  const res = await fetch('/api/member/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: mm.id, patch: payload, confirmOverride: mm.confirmOverride }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showModalError(data.error ?? `保存失败（${res.status}）`);

  const bits = [];
  if (data.changed?.includes('backend')) bits.push('后端');
  if (data.changed?.includes('tier')) bits.push('档位');
  if (data.changed?.includes('model')) bits.push('模型');
  if (data.changed?.includes('effort')) bits.push('思考等级');
  if (data.changed?.includes('extraArgs')) bits.push('启动参数');
  if (data.changed?.includes('allowedCommands')) bits.push('允许的命令');
  if (data.changed?.includes('timeoutMinutes')) bits.push('单轮上限');
  if (data.changed?.includes('name')) bits.push('名字');
  if (data.sessionReset) bits.push('会话已重置');
  appendSystemNote(bits.length ? `已更新 ${name}：${bits.join('、')}（立即生效）` : '已保存设置');
  closeMemberSettings();
}

function showModalError(text) {
  const el = $('mm-error');
  el.textContent = text;
  el.classList.remove('hidden');
}

async function removeMember() {
  if (!mm?.id) return;
  const m = memberById(mm.id);
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

/* ==========================================================================
   事件绑定与启动
   ========================================================================== */

function setOverridden(on) {
  state.overridden = on;
  $('takeover-badge').classList.toggle('hidden', !on);
  $('btn-takeover').classList.toggle('hidden', on);
  $('btn-handback').classList.toggle('hidden', !on);
}

function closeMobileDrawers() {
  $('sidebar').classList.remove('open');
  $('right-panel').classList.remove('open');
}

// 移动端侧栏切换
$('btn-toggle-sidebar').onclick = () => {
  $('right-panel').classList.remove('open');
  $('sidebar').classList.toggle('open');
};
$('btn-toggle-board').onclick = () => {
  $('sidebar').classList.remove('open');
  $('right-panel').classList.toggle('open');
};

// 房间目标行内编辑
$('goal-display').onclick = openGoalEditor;
$('goal-display').onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGoalEditor(); }
};
$('goal-editor').onsubmit = saveGoal;
$('goal-cancel').onclick = closeGoalEditor;
$('goal-input').onkeydown = (e) => {
  if (e.key === 'Escape') closeGoalEditor();
};
$('goal-shared-btn').onclick = () => {
  switchRightTab('files');
  if (window.innerWidth <= 960) $('right-panel').classList.add('open');
};

// 房间设置控件：执行模式与并发上限
$('exec-mode').onchange = async (e) => {
  const mode = e.target.value;
  const prev = state.executionMode;
  state.executionMode = mode;
  renderExecModeControls();
  const res = await fetch('/api/room-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executionMode: mode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    state.executionMode = prev;
    renderExecModeControls();
    return appendSystemNote(`修改执行模式失败：${data.error ?? res.status}`, 'warn');
  }
  if (data.effectiveExecutionMode) state.effectiveMode = data.effectiveExecutionMode;
  renderExecModeControls();
};

$('max-concurrency').onchange = async (e) => {
  const raw = Number(e.target.value);
  const prev = state.maxConcurrency;
  if (!Number.isInteger(raw) || raw < 1 || raw > 8) {
    e.target.value = String(prev);
    return appendSystemNote('并发上限必须是 1~8 之间的整数', 'warn');
  }
  state.maxConcurrency = raw;
  renderExecModeControls();
  const res = await fetch('/api/room-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxConcurrency: raw }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    state.maxConcurrency = prev;
    renderExecModeControls();
    return appendSystemNote(`修改并发上限失败：${data.error ?? res.status}`, 'warn');
  }
  if (data.effectiveExecutionMode) state.effectiveMode = data.effectiveExecutionMode;
  renderExecModeControls();
};

$('exec-mode-badge').onclick = () => {
  if (window.innerWidth <= 960) {
    $('right-panel').classList.remove('open');
    $('sidebar').classList.add('open');
  }
  const sec = $('room-settings-section');
  if (sec) sec.open = true;
  const card = $('exec-mode-card');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash-focus');
    setTimeout(() => card.classList.remove('flash-focus'), 1200);
  }
  $('exec-mode')?.focus();
};

$('collab-style').onchange = async (e) => {
  const style = e.target.value;
  const prev = state.collaborationStyle;
  state.collaborationStyle = style;
  renderCollabStyleControls();
  const res = await fetch('/api/room-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collaborationStyle: style }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    state.collaborationStyle = prev;
    renderCollabStyleControls();
    return appendSystemNote(`修改协作风格失败：${data.error ?? res.status}`, 'warn');
  }
};

// 房间设置控件
$('cabtier').onchange = async (e) => {
  const tier = e.target.value;
  const label = cabTierLabel(tier);
  if ((tier === 'write-exec' || tier === 'full') && !window.confirm(
    `把 AI 创建成员的最高权限改成「${label}」？\n\n`
    + (tier === 'full'
      ? '这意味着头头新拉入的成员将拥有完全开放权限（任意文件、任意命令与联网，免审批）。'
      : '这意味着头头新拉入的成员可以改文件并按白名单执行命令。')
    + '\n确认修改？',
  )) {
    e.target.value = state.aiCabTier;
    return;
  }
  const res = await fetch('/api/cabtier', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier }),
  });
  if (!res.ok) {
    e.target.value = state.aiCabTier;
    const d = await res.json().catch(() => ({}));
    appendSystemNote(`设置最高权限失败：${d.error ?? res.status}`, 'warn');
  }
};

$('peer-mentions').onchange = async (e) => {
  const on = e.target.checked;
  const res = await fetch('/api/room-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowPeerMentions: on }),
  });
  if (!res.ok) {
    e.target.checked = !on;
    return appendSystemNote('更新成员互 @ 设置失败', 'warn');
  }
  state.allowPeerMentions = on;
  renderCollabStyleControls();
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

// 仓库登记（行内表单替代 window.prompt）
$('btn-add-repo').onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  $('repos-section').open = true;
  const form = $('repo-add-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    $('repo-add-input').focus();
  }
};
$('repo-add-cancel').onclick = () => {
  $('repo-add-form').classList.add('hidden');
  $('repo-add-input').value = '';
};
$('repo-add-form').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('repo-add-input');
  const path = input.value.trim();
  if (!path) return;
  const res = await fetch('/api/registry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return appendSystemNote(`登记仓库失败：${data.error ?? res.status}`, 'warn');
  state.registry = data.registry ?? [];
  renderRepos();
  input.value = '';
  $('repo-add-form').classList.add('hidden');
  appendSystemNote(`已登记仓库：${path}`);
};

// 快捷操作
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

$('btn-summarize').onclick = openSummarizePicker;
$('pm-close').onclick = closePickerModal;
$('picker-modal').onclick = (e) => { if (e.target.id === 'picker-modal') closePickerModal(); };

// 成员设置弹窗事件
$('btn-add-member').onclick = () => openNewMember();
$('btn-first-member').onclick = () => openNewMember();
$('mm-close').onclick = closeMemberSettings;
$('mm-cancel').onclick = closeMemberSettings;
$('mm-save').onclick = saveMemberSettings;
$('mm-remove').onclick = removeMember;
$('mm-open-diag').onclick = () => openBackendsModal();
$('member-modal').onclick = (e) => { if (e.target.id === 'member-modal') closeMemberSettings(); };

$('mm-backend').onchange = (e) => {
  mm.backend = e.target.value;
  const support = tiersForBackend(mm.backend);
  if (!support.includes(mm.tier)) {
    mm.tier = support.includes('full') ? 'full' : support[0];
  }
  renderTierChoices(support);
  renderModelHints();
  updateTierDependentControls();
  updatePreview();
};

for (const id of ['mm-model', 'mm-effort', 'mm-extra', 'mm-commands']) {
  $(id).addEventListener('input', () => {
    if (id === 'mm-model' || id === 'mm-effort') renderModelHints();
    updatePreview();
  });
}
$('mm-commands').addEventListener('input', updateCurlWarn);
$('mm-netget').addEventListener('change', updatePreview);

// 后端诊断面板事件
$('backend-pills').onclick = openBackendsModal;
$('bm-close').onclick = closeBackendsModal;
$('bm-refresh').onclick = () => fetchBackends({ silent: false, force: true });
$('bm-probe-all').onclick = () => probeBackend('all');
$('backends-modal').onclick = (e) => { if (e.target.id === 'backends-modal') closeBackendsModal(); };

// 右栏标签切换与筛选
document.querySelectorAll('.panel-tab').forEach((btn) => {
  btn.onclick = () => switchRightTab(btn.dataset.tab);
});
$('btn-refresh-files').onclick = () => fetchFiles({ silent: false });
document.querySelectorAll('#activity-filters .filter-pill').forEach((btn) => {
  btn.onclick = () => {
    state.activityFilter = btn.dataset.filter;
    document.querySelectorAll('#activity-filters .filter-pill').forEach((p) => {
      p.classList.toggle('active', p === btn);
    });
    renderActivity();
  };
});

// 房间切换
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

window.addEventListener('hashchange', () => {
  const id = hashRoomId();
  if (!id) return showRoomList();
  if (id !== state.activeRoomId) enterRoom(id);
  else hideRoomList();
});

// 状态栏控制按钮
$('btn-send').onclick = send;
$('btn-stop').onclick = async () => {
  if (!window.confirm('停止整间房？\n\n会打断当前发言，并清空排队中的发言。\n说一句话或点「继续」就能恢复。')) return;
  const res = await fetch('/api/stop', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return appendSystemNote('停止失败', 'warn');
  if (data.dropped) appendSystemNote(`已丢弃 ${data.dropped} 条排队发言`, 'warn');
};

$('btn-resume').onclick = async () => {
  const kick = !state.stopped;
  const res = await fetch('/api/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kick }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return appendSystemNote(`恢复失败：${data.error ?? res.status}`, 'warn');
};

$('btn-interrupt').onclick = () => interruptAgent(null);

// 抽屉与滚动
$('drawer-close').onclick = closeDrawer;
$('drawer').onclick = (e) => { if (e.target.id === 'drawer') closeDrawer(); };
$('stream').addEventListener('scroll', () => {
  $('btn-scroll-bottom').classList.toggle('hidden', isNearBottom());
});
$('btn-scroll-bottom').onclick = () => scrollToBottom({ force: true });

// 代码块复制委托
bindCodeCopyDelegation($('stream'));
bindCodeCopyDelegation($('drawer-body'));

// 全局 Escape 关闭顶层弹窗/抽屉
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('drawer').classList.contains('hidden')) return closeDrawer();
  if (!$('backends-modal').classList.contains('hidden')) return closeBackendsModal();
  if (!$('member-modal').classList.contains('hidden')) return closeMemberSettings();
  if (!$('picker-modal').classList.contains('hidden')) return closePickerModal();
  closeMobileDrawers();
});

// 输入框交互
$('input').addEventListener('input', (e) => { autoGrow(e.target); updateMentionHint(); });
$('input').addEventListener('keydown', (e) => {
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
$('input').addEventListener('click', updateMentionHint);
$('input').addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMentionHint();
});

// 启动初始化
renderExecModeControls();
renderStatus();
renderBackendPills();
fetchBackends({ silent: true });
connect();
