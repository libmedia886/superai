/**
 * 上下文压缩与 session 轮换（需求 P0 #14 / §6.3）。
 *
 * 背景：CLI 的 resume 自己存历史，越聊越长。**真正的天花板是 CLI 上下文窗口**，
 * 不是轮数——所以接近上限时必须压缩并轮换新 session，否则长任务中途直接报错。
 *
 * 三条约束：
 *  1. 只在达阈值时压缩，**不是每轮重算**
 *  2. 轮换到新 session 时，**它自己之前的观点必须进摘要**，否则新会话里自相矛盾
 *  3. 头头默认收摘要投递（它是上下文涨得最快的人）
 */

export const DEFAULT_THRESHOLD = 0.7;

/** 各后端在拿不到 contextWindow 时的保守缺省 */
export const FALLBACK_WINDOW = {
  claude: 200_000,
  codex: 200_000,
  opencode: 128_000,
};

/**
 * 是否该轮换。
 * @param {{usedTokens:number, window:number|null, backend:string, threshold?:number}} o
 */
export function shouldCompact({ usedTokens, window, backend, threshold = DEFAULT_THRESHOLD }) {
  const win = window ?? FALLBACK_WINDOW[backend] ?? 128_000;
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return false;
  return usedTokens / win >= threshold;
}

/** 用量占比，用于界面显示（0~1，不知道窗口时按缺省估） */
export function usageRatio({ usedTokens, window, backend }) {
  const win = window ?? FALLBACK_WINDOW[backend] ?? 128_000;
  return Math.min(1, usedTokens / win);
}

/**
 * 生成摘要用的 prompt。
 * 必须显式要求保留「它自己的立场/结论」，否则轮换后自相矛盾。
 */
export function buildSummaryPrompt({ agentName, messages, previousSummary = null, tasks = [] }) {
  const parts = [];
  parts.push(`你是 ${agentName}。请把下面这段多人讨论压缩成一份便于继续工作的摘要。`);
  parts.push('');
  parts.push('必须包含 5 项，每项尽量短：');
  parts.push('1. 讨论主题与目标');
  parts.push('2. 已达成的结论 / 决定');
  parts.push('3. 尚未解决的分歧与待办');
  parts.push(`4. **你自己（${agentName}）表达过的立场与结论** —— 这项不能漏，你之后要接着自己的观点说`);
  parts.push('5. 关键事实与数据（去掉客套、重复、过程性内容）');
  parts.push('');
  parts.push('不要写"大家好""感谢"这类内容。直接输出摘要正文，不要加标题前缀。');

  if (tasks.length) {
    parts.push('');
    parts.push('当前任务状态（可直接引用）：');
    for (const t of tasks) parts.push(`- ${t.id} [${t.status}] ${t.title} → ${t.assignee ?? '未指派'}`);
  }

  if (previousSummary) {
    parts.push('');
    parts.push('此前的摘要（需要与新内容合并，不要丢失）：');
    parts.push(previousSummary);
  }

  parts.push('');
  parts.push('--- 待压缩的讨论 ---');
  for (const m of messages) {
    parts.push(`${m.senderName}：${m.body}`);
  }

  return parts.join('\n');
}

/**
 * 轮换后的新会话首轮 prompt。
 * 关键：这里**不能**再说"不含它自己说过的话"——摘要里已经有它自己的立场了。
 */
export function buildRebootstrap({ agentName, summary, recent = [], tasks = [] }) {
  const parts = [];
  parts.push(`你是 ${agentName}。这是一次上下文轮换后的接续，请接着之前的讨论继续。`);
  parts.push('');
  parts.push('[此前的讨论摘要]');
  parts.push(summary);
  parts.push('[/此前的讨论摘要]');
  parts.push('');
  if (tasks.length) {
    parts.push('当前任务：');
    for (const t of tasks) parts.push(`- ${t.id} [${t.status}] ${t.title} → ${t.assignee ?? '未指派'}`);
    parts.push('');
  }
  if (recent.length) {
    parts.push('最近几条原始消息：');
    for (const m of recent) parts.push(`${m.senderName}：${m.body}`);
    parts.push('');
  }
  parts.push('摘要里对你观点的记录是有效的，请与之保持一致；如需修正请明确说明是修正。');
  return parts.join('\n');
}

/** 从消息列表挑出「最近 N 条」作为轮换后的原始上下文 */
export function pickRecent(messages, n = 6) {
  return messages.slice(-n);
}

/** 把 store 消息补上发送者名字，供摘要 prompt 使用 */
export function decorate(messages, members) {
  return messages.map((m) => ({
    body: m.body,
    senderName: m.senderId === 'human'
      ? '老板'
      : (members.find((x) => x.id === m.senderId)?.name ?? m.senderId),
  }));
}
