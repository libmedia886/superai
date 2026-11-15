/**
 * 压缩两阶段握手（CR-006）：ASK → checkpoint → FIRE。
 *
 * 为什么需要它：直接压缩的风险是**在错误的时刻清空上下文**。
 * agent 正说到一半、正要写文件、正拿着刚查到的东西——这时轮换 session，
 * 工作就丢了，而且它自己不知道丢了。
 *
 * 和 claudelink 的差别：他们的握手是为了解决**按键注入的不确定性**
 * （不知道 agent 到底收到没有），所以要做超时重试、要验证"这条 checkpoint
 * 是不是在请求之后产生的"。我们的进程和输出都在手里，ask 是我们发的、
 * checkpoint 是它这轮回复里解析出来的——两个时间戳天然在不同记录里，不用防串。
 *
 * 所以这里**简化成三件事**，不做超时重试那套：
 *  1. ASK：在 prompt 里要求它先给交接摘要（不是单独一轮，附带在正常回复里）
 *  2. CHECKPOINT：解析这一轮回复里的交接块
 *  3. FIRE：拿到 checkpoint 才轮换 session；拿不到就下轮再问
 */

/** 交接块的标记。用独立 fence 名，和 action 块区分开 */
export const HANDOFF_LANG = 'handoff';

/** 追加到 prompt 末尾的 ASK 段 */
export const ASK_INSTRUCTION = [
  '',
  '--- 上下文即将压缩，请先交接 ---',
  '你的会话很快会被压缩重置。请在本轮回复的**最后**，用一个 ```handoff 代码块写下交接内容，',
  '让压缩后的你能无缝接上。必须包含这 4 项：',
  '1. 当前正在做什么（一句话）',
  '2. 已经确定下来的结论（只写结论，不写过程）',
  '3. 还没做完的事与下一步',
  '4. **你自己表达过的立场**（压缩后你要与之保持一致）',
  '',
  '示例：',
  '```handoff',
  '正在做：给登录页加失败重试',
  '已定：重试 3 次，指数退避',
  '待办：bob 还没回测试结果',
  '我的立场：重试不应该弹窗打扰用户',
  '```',
  '交接块不影响你正常回答问题，正常内容照常写在它前面。',
].join('\n');

/**
 * 从回复里提取交接内容。
 * @returns {{handoff:string|null, text:string, malformed:boolean}}
 *   text 是去掉交接块后的正文；malformed 表示有块但内容不合要求
 */
export function extractHandoff(reply) {
  const src = String(reply ?? '');
  const fence = /```handoff[ \t]*\n([\s\S]*?)```/i;
  const m = fence.exec(src);
  if (!m) return { handoff: null, text: src.trim(), malformed: false };

  const body = m[1].trim();
  const text = (src.slice(0, m.index) + src.slice(m.index + m[0].length)).trim();

  // 空块、或者明显不是交接内容（太短）算不合格
  if (body.length < 12) return { handoff: null, text, malformed: true };

  return { handoff: body, text, malformed: false };
}

/** 握手状态机。每个 agent 一份，跨轮次保留。 */
export const PHASE = {
  /** 正常说话 */
  IDLE: 'idle',
  /** 已发出 ASK，等它给交接块 */
  AWAITING: 'awaiting',
  /** 拿到了交接，下一轮可以安全轮换 */
  READY: 'ready',
};

export class HandoffState {
  constructor() {
    this.phases = new Map();  // agentId -> {phase, askedAt, handoff, attempts}
  }

  #get(agentId) {
    if (!this.phases.has(agentId)) {
      this.phases.set(agentId, { phase: PHASE.IDLE, askedAt: 0, handoff: null, attempts: 0 });
    }
    return this.phases.get(agentId);
  }

  /** 需要压缩了：标记为等交接，并记下请求时间 */
  ask(agentId, now = Date.now()) {
    const s = this.#get(agentId);
    if (s.phase === PHASE.READY) return s;   // 已经有交接了，别重复问
    s.phase = PHASE.AWAITING;
    s.askedAt = now;
    s.attempts += 1;
    return s;
  }

  /** 本轮回复里有没有交接块 */
  observe(agentId, reply, now = Date.now()) {
    const s = this.#get(agentId);
    const { handoff, text, malformed } = extractHandoff(reply);

    if (handoff) {
      s.phase = PHASE.READY;
      s.handoff = handoff;
      s.receivedAt = now;
      return { gotHandoff: true, handoff, text, malformed: false };
    }

    // 它没给（或给了个空壳）——保持 AWAITING，下一轮再要
    return { gotHandoff: false, handoff: null, text, malformed };
  }

  /** 能不能安全轮换？只有 READY 才行 */
  canFire(agentId) {
    const s = this.#get(agentId);
    return s.phase === PHASE.READY && Boolean(s.handoff);
  }

  /** 轮换完成后重置 */
  reset(agentId) {
    this.phases.set(agentId, { phase: PHASE.IDLE, askedAt: 0, handoff: null, attempts: 0 });
  }

  snapshot(agentId) {
    return { ...this.#get(agentId) };
  }

  /** 是否该在下一轮 prompt 里加 ASK */
  needsAsk(agentId) {
    const s = this.#get(agentId);
    return s.phase === PHASE.AWAITING || s.phase === PHASE.READY;
  }
}

/**
 * 轮换后的首轮 prompt：交接内容优先于自动摘要。
 * 因为交接是 agent 自己写的，比我们事后总结的更贴近它的真实状态。
 */
export function buildHandoffRebootstrap({ agentName, handoff, recent = [], tasks = [] }) {
  const parts = [];
  parts.push(`你是 ${agentName}。上下文刚刚压缩过，下面是压缩前你自己写的交接，请接着它继续。`);
  parts.push('');
  parts.push('[你的交接]');
  parts.push(handoff);
  parts.push('[/你的交接]');
  parts.push('');
  if (tasks.length) {
    parts.push('当前任务：');
    for (const t of tasks) parts.push(`- ${t.id} [${t.status}] ${t.title} → ${t.assignee ?? '未指派'}`);
    parts.push('');
  }
  if (recent.length) {
    parts.push('最近几条原始消息（仅供核对事实）：');
    for (const m of recent) parts.push(`${m.senderName}：${m.body}`);
    parts.push('');
  }
  parts.push('交接里记录的立场和结论是有效的，请与之保持一致；如果你现在想改主意，明确说明是修正。');
  return parts.join('\n');
}
