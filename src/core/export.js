/**
 * 导出为 Markdown（P1）。
 *
 * 为什么做这个：老板拿工具干活，干完要能**交出去**——给别人看、存档、汇报。
 * 现在内容都在 jsonl 里，人能看的只有界面，关掉就没了。
 *
 * 导出要能回答四个问题：
 *  1. 谁说的，什么时候
 *  2. 花了多少（token、耗时）
 *  3. 哪些是任务动作、哪些是总结（不能混在正文里）
 *  4. 任务最后成了什么样（状态 + 改了什么文件）
 */

const STATUS_ORDER = ['待办', '进行中', '待确认', '完成', '阻塞'];

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** 把 ```action 块从正文里摘掉（它们是技术细节，不进给人看的记录） */
function stripActionBlocks(text) {
  return String(text ?? '')
    .replace(/```actions?[ \t]*\n[\s\S]*?```/g, '')
    .replace(/```handoff[ \t]*\n[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 生成 Markdown。
 *
 * @param {object} o
 * @param {{name:string, goal?:string}} o.room
 * @param {Array} o.messages
 * @param {Array} o.tasks
 * @param {Map|Array} o.roster
 * @param {Array} o.toolLog   写操作日志
 * @param {Array} [o.actionLog] 动作结果
 * @param {Array} [o.members]  成员（用于 role 展示）
 * @param {(id:string)=>string} [o.nameOf]
 * @param {string} [o.generatedAt]
 */
export function exportMarkdown({
  room, messages = [], tasks = [], roster = [], toolLog = [], actionLog = [],
  members = [], nameOf, generatedAt = new Date().toISOString(),
  seqWarning = null,
}) {
  const who = nameOf ?? ((id) => (id === 'human' ? '老板' : (members.find((m) => m.id === id)?.name ?? id)));
  const rosterMap = roster instanceof Map ? roster : new Map(roster);

  const out = [];
  const agentMsgs = messages.filter((m) => m.senderId !== 'human');
  const totalTokens = agentMsgs.reduce((s, m) => s + (m.usageTokens ?? 0), 0);
  const summaryCount = agentMsgs.filter((m) => m.isSummary).length;
  const writeOps = toolLog.filter((t) => t.action === 'write' || t.action === 'edit' || t.action === 'bash');

  // ---------- 头部 ----------
  out.push(`# ${room.name}`);
  out.push('');
  if (room.goal) {
    out.push(`> **目标**：${room.goal}`);
    out.push('');
  }
  out.push(`导出时间：${fmtTime(generatedAt)}`);
  out.push('');
  if (seqWarning) {
    // 导出件会被别人拿去对账，这句必须写在最前面
    out.push(`> ⚠️ **${seqWarning}**`);
    out.push('');
  }
  out.push('| 项目 | 数量 |');
  out.push('| --- | --- |');
  out.push(`| 对话条数 | ${messages.length}（其中 AI 发言 ${agentMsgs.length}） |`);
  out.push(`| 总结 | ${summaryCount} |`);
  out.push(`| 任务 | ${tasks.length} |`);
  out.push(`| 写操作 | ${writeOps.length} |`);
  out.push(`| 累计用量 | ${fmtTokens(totalTokens)} token |`);
  out.push('');

  // ---------- 成员 ----------
  if (members.length) {
    out.push('## 成员');
    out.push('');
    out.push('| 名字 | 角色 | 后端 | 职责 |');
    out.push('| --- | --- | --- | --- |');
    for (const m of members) {
      const r = rosterMap.get(m.id) ?? {};
      const duties = (r.humanDuties ?? r.selfDuties ?? '').replace(/\|/g, '\\|') || '—';
      out.push(`| ${m.name} | ${m.role === 'leader' ? '头头' : '成员'} | ${m.backend} | ${duties} |`);
    }
    out.push('');
  }

  // ---------- 任务看板 ----------
  if (tasks.length) {
    out.push('## 任务');
    out.push('');
    const byStatus = new Map();
    for (const t of tasks) {
      const k = t.status ?? '未知';
      if (!byStatus.has(k)) byStatus.set(k, []);
      byStatus.get(k).push(t);
    }
    const order = [...STATUS_ORDER.filter((s) => byStatus.has(s)),
      ...[...byStatus.keys()].filter((s) => !STATUS_ORDER.includes(s))];

    for (const status of order) {
      out.push(`### ${status}（${byStatus.get(status).length}）`);
      out.push('');
      for (const t of byStatus.get(status)) {
        const assignee = t.assignee ? who(t.assignee) : '未指派';
        out.push(`- **${t.id}** ${t.title} — @${assignee}`);
        if (t.createdBy) out.push(`  - 创建：${who(t.createdBy)}`);
        if (t.repo) out.push(`  - 仓库：\`${t.repo}\`（基线 ${t.baseBranch ?? '自动'}）`);

        // 这个任务改了什么
        const ops = writeOps.filter((x) => x.taskId === t.id);
        if (ops.length) {
          const files = [...new Set(ops.map((o) => o.path).filter(Boolean))];
          const cmds = ops.filter((o) => o.command).length;
          const parts = [];
          if (files.length) parts.push(`${files.length} 个文件`);
          if (cmds) parts.push(`${cmds} 条命令`);
          out.push(`  - 改动：${parts.join('、')}`);
          for (const f of files.slice(0, 8)) out.push(`    - \`${f}\``);
          if (files.length > 8) out.push(`    - …还有 ${files.length - 8} 个`);
        }

        // 这个任务的动作结果（失败的要留痕）
        const acts = actionLog.filter((a) => a.taskId === t.id && !a.ok);
        if (acts.length) {
          out.push('  - 失败的动作：');
          for (const a of acts.slice(0, 5)) out.push(`    - ${a.label}：${a.reason ?? '（无原因）'}`);
        }
      }
      out.push('');
    }
  }

  // ---------- 对话 ----------
  out.push('## 对话');
  out.push('');
  if (!messages.length) {
    out.push('（还没有任何对话）');
  }
  // 动作结果按 agent 分组、按时间排序，供"这一轮只有动作没有正文"时补说明
  const actsByAgent = new Map();
  for (const a of actionLog) {
    if (!actsByAgent.has(a.agentId)) actsByAgent.set(a.agentId, []);
    actsByAgent.get(a.agentId).push(a);
  }
  for (const list of actsByAgent.values()) list.sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
  const actCursor = new Map();

  for (const m of messages) {
    const isHuman = m.senderId === 'human';
    const name = who(m.senderId);

    // 取该 agent 的下一批动作（按顺序消费，不靠时间戳猜）
    let agentActs = [];
    if (!isHuman) {
      const list = actsByAgent.get(m.senderId) ?? [];
      const seen = actCursor.get(m.senderId) ?? 0;
      const isLast = messages.indexOf(m) === messages.length - 1;
      if (isLast) {
        agentActs = list.slice(seen);
        actCursor.set(m.senderId, list.length);
      } else {
        agentActs = list.slice(seen, seen + 1);
        actCursor.set(m.senderId, seen + 1);
      }
    }
    const meta = [];
    if (m.at) meta.push(fmtTime(m.at));
    if (m.durationMs) meta.push(`${(m.durationMs / 1000).toFixed(1)}s`);
    if (m.usageTokens) meta.push(`${fmtTokens(m.usageTokens)} tok`);
    if (m.taskId) meta.push(m.taskId);

    // 总结和普通发言必须能一眼分开
    const heading = m.isSummary
      ? `### 📌 ${name}（总结）`
      : isHuman ? `### 👤 ${name}` : `### ${name}`;
    out.push(heading);
    if (meta.length) {
      out.push(`<sub>${meta.join(' · ')}</sub>`);
      out.push('');
    }

    const body = stripActionBlocks(m.body);
    if (body) {
      out.push(body);
    } else {
      // 正文被剥光了（整条只有动作块）。别写"（空）"——那看着像出错，
      // 实际它做了事。把它做了什么说出来。
      const mine = agentActs.filter((a) => a.ok);
      if (mine.length) {
        out.push(`*（本轮只执行了动作，没有正文：${mine.map((a) => a.label).join('、')}）*`);
      } else {
        out.push('*（本轮没有正文输出）*');
      }
    }
    out.push('');

  }

  // ---------- 写操作附录 ----------
  if (writeOps.length) {
    out.push('## 附录：写操作明细');
    out.push('');
    out.push('| 时间 | 谁 | 动作 | 目标 |');
    out.push('| --- | --- | --- | --- |');
    for (const t of writeOps) {
      const target = t.action === 'bash' ? t.command : t.path;
      out.push(`| ${fmtTime(t.at)} | ${who(t.agentId)} | ${t.action} | \`${String(target ?? '').replace(/\|/g, '\\|').slice(0, 100)}\` |`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(`*由多 AI 协作房间导出 · ${fmtTime(generatedAt)}*`);
  out.push('');

  return out.join('\n');
}
