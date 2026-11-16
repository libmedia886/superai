/**
 * 房间调度器（需求 §5 P0 #3/#4/#5/#7/#9/#19/#20、§6.4）。
 *
 * 三条硬设计：
 *  1. 严格串行 —— 同一时刻只有一个 agent 在说话（队列），想并行要换设计
 *  2. 无硬性轮数上限 —— 只做循环检测 + 提示，停不停由人决定
 *  3. 动作在「轮结束后」才解析执行，且只认本人直接输出
 */

import { parseMentions, applyMentionPolicy } from './mentions.js';
import { extractActions, dedupeActions, authorize } from './actions.js';
import { buildPrompt, DELIVERY } from './prompt.js';
import {
  shouldCompact, buildSummaryPrompt, buildRebootstrap, pickRecent, decorate, usageRatio,
} from './compact.js';
import { EXIT } from '../adapters/types.js';
import { LoopGuard } from './guard.js';
import { HealthTracker, retryDecision, stallThreshold } from './health.js';
import { HandoffState, ASK_INSTRUCTION, buildHandoffRebootstrap, extractHandoff } from './handoff.js';
import { AutoAdvanceGuard } from './autoadvance.js';
import { UsageWatcher } from './usage.js';
import { planMemberCreation, DEFAULT_AI_CAB_TIER } from './members.js';
import { availableTiers } from './probe.js';
import { createTaskWorktree, finalizeTaskWorktree, diffAgainstBase } from './worktree.js';

/**
 * 判断一次失败是否属于"静默卡死"。
 * 卡死的特征：跑了很久、但一个字都没输出。这类失败多半是环境问题
 * （沙箱坏了、网络挂住），和模型自己拒绝不是一回事。
 */
/** 把工具名归类成写操作日志里的动作类型 */
function classifyTool(name) {
  switch (name) {
    case 'Write': case 'write': return 'write';
    case 'Edit': case 'edit': case 'apply_patch': return 'edit';
    case 'Bash': case 'bash': case 'shell': return 'bash';
    case 'Read': case 'read': return 'read';
    default: return 'other';
  }
}

/**
 * 头头对"没有 @ 我的消息"的免回应标记。
 *
 * 判据刻意收紧：只认空内容或明确的标记词。不能按"短"来判断——
 * 「好」「收到」是正常回复，把它们记成"未回应"会让老板以为它没理人。
 */
/** 停顿原因 → 人话。状态栏直接显示这个，不要让人猜。 */
export const PAUSE_LABEL = {
  no_target: '说完了，没点名下一位',
  overreach: '@ 了没权限叫的人',
  only_human: '把话交回给老板',
  continue_cap: '自动接力次数到上限',
  breaker: '连续失败，暂时停用',
  stopped: '你点了「停止」',
  summary: '总结完毕',
  error: '出错停住',
};

const PASS_MARKERS = /^\[?\s*(pass|no_reply|no-reply|skip|无需回应|不用回复|不需要回应)\s*\]?[。.!！]?$/i;

export function isPassReply(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  return PASS_MARKERS.test(t);
}

function isStall(result, durationMs) {
  if (result?.reason !== EXIT.TIMEOUT) return false;
  const text = result?.text ?? '';
  return text.trim().length === 0 || durationMs >= stallThreshold(180_000);
}

export class Room {
  /**
   * @param {object} o
   * @param {string} o.id
   * @param {string} o.name
   * @param {Array} o.members  [{id,name,aliases,role,backend,model,persona,cwd,sessionId}]
   * @param {import('./store.js').Store} o.store
   * @param {(agent:any)=>object} o.resolveAdapter 返回符合 AgentAdapter 的实例
   * @param {(ev:object)=>void} [o.onEvent] UI 事件出口
   */
  constructor({
    id, name, goal = '', members, store, resolveAdapter, onEvent,
    registry = [], worktreesRoot = null, onMemberCreate = null,
    aiCabTier = DEFAULT_AI_CAB_TIER, headPassiveWake = true,
  }) {
    /** 造人落地钩子（由 config 注入，负责建目录 + 写配置） */
    this.onMemberCreate = onMemberCreate;
    /** AI 能创建的成员的最高档位（人设定，默认只读） */
    this.aiCabTier = aiCabTier;
    /**
     * 头头被动唤醒：成员**不 @** 任何人的发言也会叫醒头头。
     * 老板的要求原话："任何人在群里评论，即使不 at，头头都能收到。"
     * 头头可以回，也可以不回。默认开（房间级开关）。
     */
    this.headPassiveWake = headPassiveWake !== false;
    /** 累积中的被动唤醒批次：几条不 @ 的消息合并成头头的一轮，而不是排队跑 N 轮 */
    this._passiveBatch = null;
    this.id = id;
    this.name = name;
    this.goal = goal;
    this.members = members;
    /** 人登记的可用仓库（头头只能在里面选） */
    this.registry = registry;
    /** worktree 集中放在这里，路径只用任务 id */
    this.worktreesRoot = worktreesRoot;
    this.store = store;
    this.resolveAdapter = resolveAdapter;
    this.onEvent = onEvent ?? (() => {});

    // 支持多头部组织（§4.1）：存数组，不再只取第一个。
    // 单头头是数组长度为 1 的特例，规则完全一致。
    this.leaderIds = members.filter((m) => m.role === 'leader').map((m) => m.id);
    /** @deprecated 兼容旧调用；新代码用 leaderIds */
    this.leaderId = this.leaderIds[0] ?? null;
    this.compactThreshold = 0.7;
    /** 单轮超时：进程级保护，不是对话轮数限制（§7） */
    this.turnTimeoutMs = 180_000;
    /** 只读档的自动重试次数。可写及以上永不自动重试（可能已产生副作用） */
    this.maxRetries = 2;
    this.summaries = new Map(); // agentId -> 最新摘要
    this.queue = [];               // [{agentId, triggerMsg, taskId, source:'human'|'agent'}]
    this.running = false;
    this.stopped = false;
    this.current = null;           // {agentId, abort}
    this._executedActions = new Set(); // 幂等键
    this.guard = new LoopGuard();
    this.health = new HealthTracker();
    this.handoff = new HandoffState();
    this.autoAdvance = new AutoAdvanceGuard();
    /** 用量异常观察器（只提示，不拦截） */
    this.usage = new UsageWatcher();
    this._pendingContinue = null;
    /** 写操作日志（内存 + 落盘）。验收时用它回答"它到底改了什么" */
    this.toolLog = [];
    this.waitingForHuman = true;
  }

  // ---------- 输入 ----------

  /**
   * 人发消息：解析 @，入队。
   *
   * §6.4.1 广播规则（人 14:51 定）：
   *  - 人不带 @ → **所有人依次回**（头头优先，其余按加入顺序）
   *  - 人 @A      → 只有 A 回
   *  - 人 @A @B   → A 先回、B 后回
   *  - agent 不带 @ → 停住（广播只对人生效，否则两个 AI 会无限接龙）
   */
  async humanSay(body, { taskId = null } = {}) {
    // 人说话 = 打断自动推进链条，计数归零
    this.autoAdvance.reset();
    this._pendingContinue = null;

    /**
     * ★ 房间被"停止"过，人一说话就自动恢复。
     *
     * 「停止」的用途是掐断当前失控的连锁，不是让人从此叫不动它。
     * 之前这里是死锁：停止后 drain 立刻退出（`!this.stopped`），
     * 人发的消息 200 OK 落进 jsonl 却永远没人处理，界面还说一切正常。
     * 人主动说话本身就是一次新的指令——拒绝处理才是错的。
     */
    const wasStopped = this.stopped;
    this._clearPause();
    if (wasStopped) {
      this.stopped = false;
      this.onEvent({
        type: 'resumed',
        reason: 'human_say',
        text: '房间已恢复（你说了一句话，等于给出新的指令）',
      });
    }

    const { targets, unknown, selfTargets } = parseMentions(body, { members: this.members }, 'human');
    const msg = await this.store.addMessage({
      senderId: 'human',
      role: 'human',
      body,
      taskId,
      mentions: targets,
      unknownMentions: unknown,
    });

    this.onEvent({ type: 'message', message: msg.message });
    if (unknown.length) {
      this.onEvent({ type: 'notice', level: 'warn', text: `未找到 ${unknown.map((u) => `@${u}`).join(' ')}` });
    }

    // 只有"完全没写 @"才是广播。写了 @ 但没解析出人（打错名字 / @了自己）就停住——
    // 否则打错一个字就会把全员叫起来，那是最容易被误触的破坏性行为。
    const wroteMention = targets.length > 0 || unknown.length > 0 || selfTargets.length > 0;
    const broadcast = !wroteMention;
    const recipients = broadcast ? this._broadcastOrder() : targets;

    this.waitingForHuman = recipients.length === 0;
    for (const t of recipients) {
      this._enqueue(t, { triggerMsg: msg.message, taskId, source: 'human', broadcast });
    }

    if (broadcast) {
      this.onEvent({ type: 'broadcast', recipients, messageId: msg.message.id });
    }

    return { messageId: msg.message.id, targets: recipients, unknown, broadcast, resumed: wasStopped };
  }

  /** 广播顺序：头头优先，其余按加入顺序（§6.4.1） */
  _broadcastOrder() {
    const leader = this.members.filter((m) => m.role === 'leader');
    const rest = this.members.filter((m) => m.role !== 'leader');
    return [...leader, ...rest].map((m) => m.id);
  }

  _enqueue(agentId, entry) {
    /**
     * 去重键用**触发消息 id**，不用 (agentId, taskId)。
     *
     * 原来的键在 taskId 为 null 时退化成"这个 agent 只能排一条"，于是
     * 人连着 @ 同一个 agent 两次，第二次会被无提示地丢掉——用户看到自己发了
     * 两条消息，agent 只回了一次，也不知道为什么。
     */
    const key = entry.triggerMsg?.id ?? null;
    const dup = key
      ? this.queue.find((q) => q.agentId === agentId && (q.triggerMsg?.id ?? null) === key)
      : this.queue.find((q) => q.agentId === agentId
        && (q.triggerMsg?.id ?? null) === null
        && (q.taskId ?? null) === (entry.taskId ?? null)
        && q.source === entry.source
        && Boolean(q.passive) === Boolean(entry.passive));
    if (dup) {
      this.onEvent({ type: 'queued', agentId, alreadyQueued: true });
      return false;
    }
    this.queue.push({ ...entry, agentId });
    this.onEvent({ type: 'queued', agentId, pending: this.queue.length });
    return true;
  }

  // ---------- 运行 ----------

  /**
   * 把队列跑空。串行：一次一个。
   *
   * ★ `_drainAgain` 是必需的：调用方在已经 `running` 时再调 drain 会被直接忽略。
   * 而「停止」之后人一说话就恢复，这条路径恰恰会撞上——stop 打断当前轮时
   * drain 还在栈上，humanSay 紧接着调用 drain 被 `if (this.running) return` 吞掉，
   * 消息就永远留在队列里。表现就是"发了消息 200 OK，但没人理"。
   */
  async drain() {
    if (this.running) {
      this._drainAgain = true;
      return;
    }
    this.running = true;
    try {
      do {
        this._drainAgain = false;
        while (this.queue.length > 0 && !this.stopped) {
          const job = this.queue.shift();
          await this._runTurn(job);
        }
      } while (this._drainAgain && !this.stopped);
      if (this.queue.length === 0 && !this.stopped) {
        this.waitingForHuman = true;
        this.onEvent({ type: 'idle', waitingForHuman: true });
      }
    } finally {
      this.running = false;
      this._drainAgain = false;
    }
  }

  /** 立即打断当前发言人：杀进程，保留已输出；队列继续（P0 #7） */
  interrupt() {
    if (!this.current) return false;
    this.current.abort?.();
    this.onEvent({ type: 'interrupted', agentId: this.current.agentId });
    return true;
  }

  /**
   * 指定某人做总结。
   *
   * 和普通发言的区别：**总结说完房间就停住，不进入互 @ 接力**。
   * 否则总结者 @ 了谁，讨论又开始了——老板要的是"收敛出结论"，不是继续聊。
   */
  async requestSummary(agentId) {
    const agent = this.members.find((m) => m.id === agentId);
    if (!agent) return { ok: false, error: `找不到成员 ${agentId}` };

    this.summarizing = agentId;
    this.waitingForHuman = false;
    this._enqueue(agentId, {
      triggerMsg: { senderId: 'human', body: '请总结本次讨论，给出结论。' },
      taskId: null,
      source: 'human',
      isSummary: true,
    });
    this.onEvent({ type: 'summary.requested', agentId });
    return { ok: true };
  }

  /**
   * 一键停止整个房间（唯一的硬闸）。
   *
   * 语义（和人点「打断」区分开，别混）：
   *   - 打断(interrupt)：只掐当前这一轮，队列继续
   *   - 停止(stop)：整间房停手，清空队列，人不说话就不动
   *
   * 这是个"刹车"：必须有反馈（事件里说清楚丢了什么）、必须可松开
   * （resumeRoom / 人说一句话自动恢复），否则界面会显示一切正常但什么也不干。
   */
  stop() {
    this.stopped = true;
    const dropped = this.queue.length;
    const wasRunning = Boolean(this.current);
    this.queue = [];
    this._pendingContinue = null;
    if (this.current) this.current.abort?.();
    this._pause('stopped', '房间已停止');
    this.onEvent({
      type: 'stopped',
      dropped,
      interrupted: wasRunning,
      text: `房间已停止${wasRunning ? '，当前发言被打断' : ''}`
        + `${dropped ? `，丢弃 ${dropped} 条排队发言` : ''}。`
        + '再发一句话或点「继续」即可恢复。',
    });
    return { dropped, interrupted: wasRunning };
  }

  /**
   * 切换房间前把这一轮**真正停下来**。
   *
   * `stop()` 只是把 abort 信号发出去——本项目历史上出过「interrupt 只 reject promise、
   * 子进程还在烧 token」的事故。所以这里额外等 `current` 被清空（_runTurn 的 finally
   * 里做的），超时了就如实说没停干净，而不是假装停好了。
   *
   * @param {{timeoutMs?:number}} [o]
   * @returns {Promise<{killed:boolean, dropped:number, waitMs:number}>}
   */
  async halt({ timeoutMs = 15_000 } = {}) {
    this.stopped = true;
    const dropped = this.queue.length;
    this.queue = [];
    this._pendingContinue = null;

    if (!this.current) {
      this.onEvent({ type: 'halted', dropped, killed: true, waitMs: 0 });
      return { killed: true, dropped, waitMs: 0 };
    }

    this.current.abort?.();
    const startedAt = Date.now();
    // 等 _runTurn 的 finally 把 this.current 置空——那才代表子进程的收尾逻辑跑完
    while (this.current && Date.now() - startedAt < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const waitMs = Date.now() - startedAt;
    const killed = !this.current;
    this.onEvent({ type: 'halted', dropped, killed, waitMs });
    return { killed, dropped, waitMs };
  }

  resumeRoom({ reason = 'human' } = {}) {
    this._clearPause();
    if (!this.stopped) return { ok: true, changed: false };
    this.stopped = false;
    this.onEvent({
      type: 'resumed',
      reason,
      text: reason === 'human' ? '房间已恢复，成员可以继续发言' : '房间已恢复',
    });
    return { ok: true, changed: true };
  }

  /** 是否处于"停止"状态（界面要把这个状态常驻显示，刷新后也得在） */
  get isStopped() {
    return Boolean(this.stopped);
  }

  /**
   * 人点「继续」：清掉暂停原因，并把话交回给头头。
   *
   * 和"说一句话"的区别：说话是给新指令，继续是"接着刚才那条往下走"。
   * 只清状态不叫人是不够的——房间会停在原地，用户还是得自己想该 @ 谁。
   * 这里同时重置 autoAdvance 计数：人介入了，就重新给 3 次机会。
   */
  continueAfterPause() {
    const had = Boolean(this.pauseReason);
    const reason = this.pauseReason?.reason ?? null;
    this._clearPause();
    this.autoAdvance.reset();

    const leaders = this.members.filter((m) => m.role === 'leader');
    const target = leaders[0] ?? this.members[0] ?? null;
    if (!target) return { ok: false, reason: '房间里还没有成员' };

    if (this.overridden && target.role === 'leader') {
      return { ok: false, reason: '房间处于人工接管状态，头头不会自动发言；直接 @ 某个成员即可' };
    }

    this._enqueue(target.id, {
      triggerMsg: { id: `continue-${Date.now()}`, senderId: 'human', body: '继续。' },
      taskId: null,
      source: 'human',
      kick: true,
    });
    this.onEvent({
      type: 'continue.kicked',
      agentId: target.id,
      pausedReason: reason,
      text: `已让 ${target.name} 接着推进（之前的停顿原因：${PAUSE_LABEL[reason] ?? reason ?? '无'}）`,
    });
    return { ok: true, agentId: target.id, hadPause: had, pausedReason: reason };
  }

  /**
   * 头头接管（P0 #20）：暂停头头，不再自动入队。
   *
   * 接管期间**丢弃队列里排着的头头发言**——那些是它接管前的意图，已经过期了。
   * 等交还后一口气补发，就像把几天前的邮件一股脑发出去一样，会让人莫名其妙。
   */
  takeOver() {
    this.overridden = true;
    const dropped = this.queue.filter((q) => {
      const m = this.members.find((x) => x.id === q.agentId);
      return m?.role === 'leader';
    });
    this.queue = this.queue.filter((q) => !dropped.includes(q));

    this.onEvent({
      type: 'takeover',
      at: new Date().toISOString(),
      dropped: dropped.length,
      text: dropped.length ? `已接管，丢弃 ${dropped.length} 条过期排队的头头发言` : '已接管',
    });
  }

  /**
   * 交还控制权。
   *
   * **不重置熔断计数**——熔断看的是它自己失败了几次，接管是人的决定，
   * 两者不能互相掩盖。交还只是把头头的自动发言权还回去。
   */
  handBack() {
    this.overridden = false;
    this.onEvent({ type: 'handback', at: new Date().toISOString() });
  }

  /**
   * 停下要说原因。
   *
   * 「停下」「正在思考」「坏了」三种状态在界面上长得一样时，用户没法判断
   * 该做什么——他只能反复问"怎么又停了"。所以每次停都发一条 room.paused，
   * 并把原因留在 `this.pauseReason` 上（刷新后 room.init 也要能带上）。
   *
   * @param {'no_target'|'overreach'|'only_human'|'continue_cap'|'breaker'|'stopped'|'summary'|'error'} reason
   */
  _pause(reason, detail = '') {
    this.waitingForHuman = true;
    this.pauseReason = { reason, detail: String(detail ?? ''), at: new Date().toISOString() };
    this.onEvent({ type: 'room.paused', reason, detail: this.pauseReason.detail });
    return this.pauseReason;
  }

  /** 恢复发言时清掉暂停原因（否则状态栏会一直挂着一个过期理由） */
  _clearPause() {
    if (!this.pauseReason) return;
    this.pauseReason = null;
    this.onEvent({ type: 'room.resumed', reason: 'cleared' });
  }

  /** 给某个 agent 留一条"下一轮必须看到"的说明（越权、被拒等） */
  _note(agentId, text) {
    if (!agentId || !text) return;
    if (!this._notes) this._notes = new Map();
    const list = this._notes.get(agentId) ?? [];
    list.push({ text, at: new Date().toISOString() });
    this._notes.set(agentId, list);
  }

  /** 取走该 agent 的待读说明（取走即清空，不会重复提示） */
  _takeNotes(agentId) {
    if (!this._notes?.has(agentId)) return [];
    const list = this._notes.get(agentId);
    this._notes.delete(agentId);
    return list;
  }

  // ---------- 单轮 ----------

  async _runTurn(job) {
    const agent = this.members.find((m) => m.id === job.agentId);
    if (!agent) return;
    if (this.overridden && agent.role === 'leader') {
      this.onEvent({ type: 'skipped', agentId: agent.id, reason: '已被人工接管' });
      return;
    }

    // 熔断：暂停中的 agent 不发言（半开会放行一次探针）
    const gate = this.health.canRun(agent.id);
    if (!gate.ok) {
      this.onEvent({ type: 'skipped', agentId: agent.id, reason: gate.reason });
      return;
    }
    if (gate.probe) this.onEvent({ type: 'health.probe', agentId: agent.id, reason: gate.reason });

    const adapter = this.resolveAdapter(agent);
    const startedAt = Date.now();
    const delivery = agent.role === 'leader' ? DELIVERY.SUMMARY : DELIVERY.SINCE_LAST;

    // 上一个轮次的动作结果回注
    const actionResults = this._lastActionResults ?? [];
    this._lastActionResults = [];

    // 到达阈值只要「开始握手」——先把要交接这件事挂上，本轮在正常回复末尾请它交接。
    // 真正的轮换要等它交上来（CR-006：没拿到交接绝不轮换，否则丢工作）。
    if (agent.pendingCompact && !this.handoff.canFire(agent.id)) {
      this.handoff.ask(agent.id);
      this.onEvent({ type: 'compact.asking', agentId: agent.id });
    }
    agent.pendingCompact = false;

    // 已有交接 → 本轮开头轮换（用 agent 自己写的交接重建上下文，不是我们的摘要）
    let rebootstrap = null;
    if (this.handoff.canFire(agent.id)) {
      rebootstrap = await this._compact(agent, adapter);
    }

    // 上一轮被拒的越权 @ 等说明：必须在它开口之前告诉它，否则它会继续按错误的理解做
    const pendingNotes = this._takeNotes(agent.id);

    let prompt = rebootstrap ?? buildPrompt({
      agent, room: this, store: this.store,
      trigger: job.triggerMsg, mode: delivery,
      taskId: job.taskId, actionResults,
      notes: pendingNotes,
    });
    if (rebootstrap && pendingNotes.length) {
      prompt += '\n\n--- 系统上次拦下了你的一个动作 ---\n'
        + pendingNotes.map((n) => `- ${n.text}`).join('\n');
    }

    // 总结模式：明确告诉它这是收尾，不是继续讨论
    if (job.isSummary) {
      prompt += [
        '',
        '--- 老板请你总结 ---',
        '本次讨论该收尾了。请给出：',
        '1. 已达成的结论（只写结论，不写过程）',
        '2. 还没解决的问题',
        '3. 建议的下一步',
        '不要 @ 任何人——说完房间就停住，等老板决定。',
      ].join('\n');
    }

    // 还在等交接：把 ASK 段附在正常 prompt 末尾（不影响它正常干活）
    if (!rebootstrap && this.handoff.needsAsk(agent.id) && !this.handoff.canFire(agent.id)) {
      prompt += ASK_INSTRUCTION;
    }

    // 人点了「继续」：明确告诉它这是接着往下走，不是新任务
    if (job.kick) {
      prompt += '\n\n--- 老板点了「继续」 ---\n'
        + '上一轮之后房间停住了。请接着把这件事往下推：该派活的派活，'
        + '该收尾的收尾，该向老板汇报的直接说结论。';
    }

    // 被动唤醒/交回头头：说明这一轮为什么会轮到你
    if (job.relay) {
      prompt += `\n\n--- 交回给你 ---\n${job.relay.fromName} 说完了，没有点名下一位。`
        + '需要你决定下一步：收尾、派活，或者向老板汇报。不需要继续就停住。';
    }

    // 被动唤醒：把合并批次明确列出来，并说明"可以不回"。
    // 不写清楚的话，头头会以为每条都得回应，无 @ 的闲聊就会变成噪音源。
    if (job.passive) {
      const batch = this._passiveBatch;
      this._passiveBatch = null;   // 这一轮消费掉；之后的新消息开新批次
      const lines = ['', '--- 以下消息没有 @ 你 ---'];
      for (const m of batch?.messages ?? []) {
        const who = this.members.find((x) => x.id === m.senderId)?.name ?? m.senderId;
        lines.push(`@${who}：${m.body}`);
      }
      lines.push(
        '',
        '它们是在群里直接说的，没有点名你。**你可以回复，也可以不回复。**',
        '如果不需要回应（只是闲聊 / 别人之间的对话 / 你已经知道），',
        '只输出 [PASS] 这一行，不要写别的——系统会记成「已读，未回应」，不是失败。',
        '如果需要回应，就正常回答，需要谁接着说就 @ 谁。',
      );
      prompt += lines.join('\n');
    }

    this.onEvent({ type: 'turn.start', agentId: agent.id, pending: this.queue.length });

    let aborted = false;
    let acc = '';
    let adapterResult = null;

    const timeoutMs = agent.timeoutMs ?? this.turnTimeoutMs;

    /**
     * 会话与工作目录按 **(agent, 任务)** 绑定，不是按 agent。
     *
     * 两个原因：
     *  1. 任务有 worktree 时，agent 必须在 worktree 里干活——cwd 就是它的边界
     *  2. 新任务应该有干净的上下文，不该继承上一个任务的文件和讨论
     *
     * 拿不到任务时退回 agent 自己的目录（头头就是这种：跨任务复用上下文）。
     */
    const bound = this._sessionFor(agent, job.taskId);
    const runCwd = bound.cwd;
    let runSessionId = bound.sessionId;

    const runInput = {
      prompt,
      timeoutMs,
      cwd: runCwd,
      sessionId: runSessionId,
      onEvent: (ev) => {
        if (ev.type === 'meta' && ev.sessionId) {
          bound.sessionId = ev.sessionId;
          runSessionId = ev.sessionId;
          if (!job.taskId) agent.sessionId = ev.sessionId;
          this.store.saveSession(agent.id, {
            sessionId: ev.sessionId, cwd: runCwd, backend: agent.backend, taskId: job.taskId ?? null,
          }).catch(() => {});
        }
        if (ev.type === 'text' && ev.text) acc += ev.text;
        // 写操作日志：每次工具调用落一条事件。
        // 可写档出问题时，没有这个就只能靠猜"它到底改了什么"。
        if (ev.type === 'tool') {
          const entry = {
            agentId: agent.id,
            taskId: job.taskId ?? null,
            tool: ev.tool ?? 'unknown',
            action: classifyTool(ev.tool),
            path: ev.path ?? null,
            command: ev.command ?? null,
            detail: ev.detail ?? '',
            at: Date.now(),
          };
          this.toolLog.push(entry);
          this.store.append({ kind: 'tool', ...entry }).catch(() => {});
          this.onEvent({ type: 'tool', ...entry });
        }
        // 有输出就说明没卡死：刷新健康计时
        if (ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool') {
          this.health.touch(agent.id);
        }
        if (ev.type === 'text' || ev.type === 'usage' || ev.type === 'thinking') {
          this.onEvent({ ...ev, agentId: agent.id });
        }
      },
    };

    // 用 AbortController：中断必须**真的杀死子进程**。
    // 只 reject Promise 的话进程会变孤儿继续跑、继续占额度。
    const ac = new AbortController();
    const live = { agentId: agent.id, abort: () => ac.abort('interrupted') };
    this.current = live;

    // 卡死看门狗：进程活着但长时间没输出，主动判死并杀掉。
    // 先 touch 一次作为"本轮起点"——否则一个从头到尾不输出的进程
    // 因为 lastActivityAt 一直是 0，isStalled 永远返回 false，看门狗等于不存在。
    this.health.touch(agent.id);
    let stalledOut = false;   // 本次是否被看门狗判死（要和"人为打断"区分开）

    const stallTimer = setInterval(() => {
      if (!this.health.isStalled(agent.id, { timeoutMs })) return;
      if (ac.signal.aborted) return;
      stalledOut = true;
      this.onEvent({
        type: 'failure',
        agentId: agent.id,
        reason: EXIT.TIMEOUT,
        stalled: true,
        detail: `超过 ${Math.round(stallThreshold(timeoutMs) / 1000)} 秒没有任何输出，判定卡死并终止`,
        health: this.health.snapshot(agent.id),
      });
      ac.abort('stalled');
    }, Math.max(5000, Math.floor(stallThreshold(timeoutMs) / 4)));

    try {
      adapterResult = await adapter.run({ ...runInput, signal: ac.signal });
      if (ac.signal.aborted) {
        // 看门狗判死 → 算失败（进熔断）；人为打断 → 不算 agent 的锅
        aborted = !stalledOut;
        adapterResult = {
          ...adapterResult,
          aborted: true,
          text: adapterResult?.text || acc,
          reason: stalledOut ? EXIT.TIMEOUT : 'interrupted',
        };
      }
    } catch (err) {
      adapterResult = { text: acc, reason: EXIT.CRASHED, error: String(err?.message ?? err) };
    } finally {
      clearInterval(stallTimer);
      this.current = null;
    }

    const durationMs = Date.now() - startedAt;
    const body = (adapterResult?.text ?? acc) || '';

    // 1) 落库（带上用量，界面刷新后才能恢复"累计用量"）
    const usageTokens = adapterResult?.usage
      ? (adapterResult.usage.inputTokens ?? 0) + (adapterResult.usage.outputTokens ?? 0)
      : 0;
    // 交接块：从正文里摘出来（聊天流里不该出现这段技术性内容），
    // 交给握手状态机。摘不出来就保持等待，下一轮再要。
    const handoffInfo = this.handoff.needsAsk(agent.id)
      ? this.handoff.observe(agent.id, body)
      : { gotHandoff: false, handoff: null, text: body, malformed: false };
    let displayBody = handoffInfo.text ?? body;

    /**
     * 被动唤醒的"已读未回应"。
     *
     * 必须和失败区分开：失败要报警、要进熔断；"我看过了，不需要说话"是正常结果。
     * 界面上显示成一条灰色「已读，未回应」，不是错误提示。
     */
    const passivePass = Boolean(job.passive) && isPassReply(displayBody);
    if (passivePass) displayBody = '';

    if (handoffInfo.gotHandoff) {
      this.onEvent({ type: 'handoff.received', agentId: agent.id, chars: handoffInfo.handoff.length });
    } else if (handoffInfo.malformed) {
      this.onEvent({
        type: 'notice', level: 'warn', agentId: agent.id,
        text: `${agent.name} 的交接块内容不完整，下一轮会再要一次`,
      });
    }

    const msg = await this.store.addMessage({
      senderId: agent.id,
      role: agent.role,
      body: displayBody,
      taskId: job.taskId,
      status: aborted ? '已中断' : (adapterResult?.reason ?? 'failed'),
      sessionId: agent.sessionId ?? null,
      durationMs,
      usageTokens,
      // 总结要显式标记：否则事后翻记录分不清哪条是结论、哪条是过程
      isSummary: Boolean(job.isSummary),
      // 被动唤醒却没回应：既不是失败也不是发言，界面要能分开显示
      passed: passivePass || undefined,
    });
    // 带上队列剩余数：界面据此区分"还要继续说"和"真的在等人"。
    // 不带的话，一轮说完就显示"等待人类"，而队列里可能还排着两三个人。
    this.onEvent({
      type: 'message',
      message: msg.message,
      durationMs,
      pending: this.queue.length,
      waitingForHuman: this.queue.length === 0,
    });

    // 2) 动作：只在轮结束后解析，且只认本人输出
    const { actions, errors } = extractActions(displayBody, {
      actor: agent.id, turn: this._turnNo ?? 0, sessionId: agent.sessionId ?? '',
    });
    this._turnNo = (this._turnNo ?? 0) + 1;
    const { fresh, skipped } = dedupeActions(actions, this._executedActions);
    const results = [];
    for (const a of fresh) {
      this._executedActions.add(a.idemKey);
      const r = await this._applyAction(a, agent);
      results.push(r);
    }
    for (const s of skipped) results.push({ ok: true, label: s.action, detail: '该动作此前已执行，跳过' });
    for (const e of errors) results.push({ ok: false, label: '未识别动作', reason: e.reason });
    this._lastActionResults = results;
    if (results.length) {
      // 动作结果也要落盘：出事之后能不能查，全看这一条。
      // 内存里的事件流重启就没了，而"它到底派没派成这个活"必须能追溯。
      for (const r of results) {
        this.store.append({
          kind: 'action',
          agentId: agent.id,
          taskId: job.taskId ?? null,
          label: r.label ?? '',
          ok: Boolean(r.ok),
          reason: r.reason ?? null,
          detail: r.detail ?? null,
          at: Date.now(),
        }).catch(() => {});
      }
      this.onEvent({ type: 'action.results', agentId: agent.id, results });
    }

    // 3) 失败不回滚但要让界面看见，并记账到熔断器
    if (aborted) {
      // 人为打断不算 agent 的失败，不该计进熔断
      this.health.touch(agent.id);
    } else if (adapterResult?.reason === EXIT.COMPLETED) {
      this.health.success(agent.id);
    } else {
      const reason = adapterResult?.reason ?? 'failed';
      const stalled = stalledOut || isStall(adapterResult, durationMs);

      const tripped = this.health.failure(agent.id, { stall: stalled });
      if (tripped.tripped) this._pause('breaker', `${agent.name} 连续失败，已暂停`);
      this.onEvent({
        type: 'failure',
        agentId: agent.id,
        reason,
        stalled,
        detail: adapterResult?.error ?? adapterResult?.stderr?.slice(0, 500) ?? '',
        health: this.health.snapshot(agent.id),
      });

      if (tripped.tripped) {
        this.onEvent({
          type: 'health.tripped',
          agentId: agent.id,
          state: tripped.state,
          cooldownMs: tripped.cooldownMs,
          text: `${agent.name} 连续失败，已暂停；${Math.round(tripped.cooldownMs / 1000)} 秒后自动试探恢复`,
        });
      }

      // 自动重试：只允许只读档（可写档重试可能重复执行副作用）
      const decision = retryDecision({
        tier: agent.tier, reason, attempt: job.attempt ?? 0, maxAttempts: this.maxRetries,
      });
      if (decision.retry) {
        this.onEvent({ type: 'retry', agentId: agent.id, reason: decision.reason });
        this.queue.unshift({ ...job, attempt: (job.attempt ?? 0) + 1 });
      } else if (job.attempt) {
        this.onEvent({ type: 'retry.given-up', agentId: agent.id, reason: decision.reason });
      }
    }

    // 4) 循环护栏（CR-008，只提示不拦截）
    //    人类触发的轮次视为新任务起点，三个维度全部归零。
    // 被动唤醒不计入护栏：一个话多的成员天天无 @ 发言，不能让头头那边
    // 一直刷"检测到循环迹象"——警告一旦不稀缺就没人信了。
    if (!job.passive) this._detectLoop(agent, body, { reset: job.source !== 'agent' });

    // 4.5) 上下文水位：达阈值就标记，下一轮开头压缩 + 轮换 session
    if (adapterResult?.usage) {
      const used = (adapterResult.usage.inputTokens ?? 0)
        + (adapterResult.usage.cacheReadTokens ?? 0)
        + (adapterResult.usage.cacheWriteTokens ?? 0);
      const window = adapterResult.usage.contextWindow ?? null;
      const ratio = usageRatio({ usedTokens: used, window, backend: agent.backend });
      this.onEvent({ type: 'context.usage', agentId: agent.id, usedTokens: used, ratio });

      // 用量异常提示：**只提示，不拦截**。老板说过不用考虑消耗，
      // 这里只是让他知道钱花在哪，不替他做决定。
      const usageWarn = this.usage.record({ agentId: agent.id, tokens: usageTokens });
      if (usageWarn) {
        this.onEvent({
          type: 'usage.warning',
          kind: usageWarn.kind,
          agentId: agent.id,
          text: usageWarn.text,
          ratio: usageWarn.ratio,
        });
      }
      if (shouldCompact({ usedTokens: used, window, backend: agent.backend, threshold: this.compactThreshold })) {
        agent.pendingCompact = true;
        this.onEvent({ type: 'context.nearLimit', agentId: agent.id, ratio });
      }
    }

    // 5) 接力：解析它 @ 了谁
    if (!aborted) {
      const { targets, unknown } = parseMentions(displayBody, { members: this.members }, agent.id);
      const { allowed, overreach } = applyMentionPolicy({
        targets,
        actorRole: agent.role,
        leaderIds: this.leaderIds,
        reportsTo: agent.reportsTo ?? null,
        humanId: 'human',
      });
      if (unknown.length || overreach.length) {
        const text = [
          unknown.length ? `未找到 ${unknown.map((u) => `@${u}`).join(' ')}` : '',
          overreach.length ? `越权 @ ${overreach.join(' ')}，未生效` : '',
        ].filter(Boolean).join('；');
        this.onEvent({ type: 'notice', level: 'warn', agentId: agent.id, text });

        /**
         * ★ 越权必须**回注给发言者**。
         *
         * 只弹给界面的后果实测过：dave 写了「@carol 等你的交付」，
         * 系统拦住了，但 dave 自己不知道 —— 它以为交出去了，于是不再叫任何人，
         * 房间停在那里。用户看到的是"AI 突然不说话"，而 AI 以为自己在等。
         * 下一轮 prompt 里明确告诉它，它才有机会改走合法路径（@头头 / continue）。
         */
        if (overreach.length) {
          const names = overreach.map((id) => this.members.find((m) => m.id === id)?.name ?? id);
          this._note(agent.id, `你上一条消息里 @${names.join(' @')} **没有生效**：成员不能直接 @ 其他成员。`
            + `如果你需要交接，请改 @ 头头（${this.members.filter((m) => m.role === 'leader').map((m) => `@${m.name}`).join(' / ') || '（无）'}），`
            + '或在动作块里写 continue。');
        }
      }
      // 总结不进入接力：它 @ 了谁也不继续，说完就停。
      if (job.isSummary) {
        this.summarizing = null;
        this.waitingForHuman = true;
        this.onEvent({ type: 'summary.done', agentId: agent.id });
        return;
      }

      // 'human' 不是 agent：@老板 只是"向人汇报"，不能被当成一个可跑的成员排队。
      // 之前这里会把 'human' 塞进队列，_runTurn 找不到人静默返回——看起来就是"没人理"。
      const agentTargets = allowed.filter((t) => t !== 'human');
      const toHuman = allowed.length !== agentTargets.length;

      for (const t of agentTargets) {
        this._enqueue(t, { triggerMsg: msg.message, taskId: job.taskId, source: 'agent' });
      }

      // 没有人被 @，但它声明了 continue → 按 roster 顺序唤下一个人。
      // 只在"没 @ 任何人"时生效：@ 了谁就听 @ 的，不要两条路径打架。
      let continued = false;
      // 无论走不走自动推进，本轮的 continue 声明都要消费掉——
      // 否则它会残留到下一轮，被别人（甚至是完全不同的话题）误用。
      const pending = this._pendingContinue;
      this._pendingContinue = null;

      if (allowed.length === 0 && pending) {
        // 真正要推进了，这时才计入护栏
        const check = this.autoAdvance.note(agent.id, pending.reason);
        if (!check.ok) {
          this.onEvent({ type: 'notice', level: 'warn', text: check.reason });
          this.waitingForHuman = true;
          return;
        }

        const next = this.nextInRoster(agent.id);
        if (next.agent) {
          this._enqueue(next.agent.id, {
            triggerMsg: msg.message,
            taskId: job.taskId,
            source: 'agent',
            viaContinue: true,
            continueReason: pending.reason,
          });
          continued = true;
          this.onEvent({
            type: 'auto.advance',
            from: agent.id,
            to: next.agent.id,
            reason: pending.reason,
            count: this.autoAdvance.count,
            remaining: this.autoAdvance.remaining,
          });
        } else {
          this.onEvent({ type: 'notice', level: 'warn', text: `无法自动推进：${next.reason}` });
        }
      }

      // 5.5) 没人可接：交给头头（被动唤醒），交不出去就**说清楚为什么停**。
      //
      //      成员无 @ → 叫醒头头（它可以回，也可以不回；多条合并成一轮）。
      //      头头无 @ → 谁都不叫（它该向人汇报，不是继续聊）。
      //
      //      「说了话但没人接」和「正在思考」在界面上必须长得不一样，
      //      所以下面每一种停法都带一个明确原因。
      let woken = false;
      const hasAgentTarget = agentTargets.length > 0;
      if (!hasAgentTarget && !continued && !job.isSummary) {
        if (toHuman) {
          // 只 @ 了老板：等人类，不需要叫任何人
          this._pause('only_human', `${agent.name} 把话交回给老板，等你的回复`);
        } else if (agent.role === 'member') {
          woken = this._passiveWake(agent, msg.message, job);
          if (!woken) {
            // 叫不醒（被上限拦下 / 没有头头 / 接管中）
            this._pause(this._passiveWakeBlocked?.reason ?? 'no_target',
              this._passiveWakeBlocked?.detail ?? `${agent.name} 说完了，没有下一位`);
          }
        } else {
          // 头头无 @ 且无 continue：这是"向你汇报完，停住"，属于正常收尾
          this._pause('no_target', `${agent.name} 说完了，没有点名下一位`);
        }
      }
      if (woken) {
        this.waitingForHuman = false;
        this._clearPause();
      }

      // 注意：不在这里发 idle 事件。队列可能还有别人在等（比如人同时 @ 了两位），
      // 真正的「等待人类」由 drain() 在队列跑空时统一发出，避免重复提示。
      if (!hasAgentTarget && !continued && !woken && !this.pauseReason) this.waitingForHuman = true;
    }
  }

  /**
   * 成员无 @ 发言 → 只叫头头，且把多条合并成一轮。
   *
   * 为什么只叫头头：如果叫所有人，两个成员互相无 @ 就会无限接龙；
   * 只叫头头则链条最多一跳，天然有界（头头无 @ 不再唤醒任何人）。
   *
   * 为什么合并：一轮正在跑的时候连着来了三条消息，逐条排队会让头头跑三轮、
   * 三轮都带完整上下文——这是 token 爆炸和噪音的主要来源。这里用一个批次对象，
   * 头头那一轮看到的是"这几条"，一次说完。
   *
   * @returns {boolean} 是否叫醒了人
   */
  _passiveWake(agent, message, job) {
    this._passiveWakeBlocked = null;
    if (!this.headPassiveWake) {
      this._passiveWakeBlocked = { reason: 'no_target', detail: '头头被动唤醒已关闭（房间设置）' };
      return false;
    }
    if (agent.role === 'leader') return false;   // 头头无 @ → 谁都不叫
    if (this.overridden) {
      this._passiveWakeBlocked = { reason: 'no_target', detail: '已被人工接管，头头不自动发言' };
      return false;
    }
    if (job.isSummary) return false;

    /**
     * ★ 不叫醒"刚刚对我说话的那个头头"。
     *
     * 少了这一条就是无限循环：头头 @ 了成员 → 成员不回 @ 地答一句 → 成员的无 @
     * 又把它叫醒 → 它再 @ 成员…… 而且这条路径按设计不计入 LoopGuard，
     * 所以循环检测也不会响——等于给自己造了一个不受监控的死循环。
     * 头头刚派完活，成员那句回复它上下文里本来就有，没必要再被叫一次。
     */
    const triggerSender = job?.triggerMsg?.senderId ?? null;
    const leaders = this.members.filter(
      (m) => m.role === 'leader' && m.id !== agent.id && m.id !== triggerSender,
    );
    if (!leaders.length) {
      this._passiveWakeBlocked = {
        reason: 'no_target',
        detail: triggerSender
          ? '刚派活的头头不需要再被叫一次，其他成员也不能接手'
          : '房间里没有可被唤醒的头头',
      };
      return false;
    }

    /**
     * 交回头头也要有上限。
     *
     * 用 autoAdvance 计数（它不是 LoopGuard，因此不会污染"循环迹象"警告）：
     * 连续 3 次「成员说完 → 头头接」而没有人类介入，就该停下来问人。
     * 没有上限的话，一个爱说话的头头 + 一个爱回应的成员能自己聊到天亮。
     */
    const check = this.autoAdvance.note(agent.id, `无 @ 交回头头（${agent.name}）`);
    if (!check.ok) {
      this._passiveWakeBlocked = { reason: 'continue_cap', detail: check.reason };
      this.onEvent({ type: 'notice', level: 'warn', text: check.reason });
      return false;
    }

    // 批次：同一批消息合并到头头的一轮里
    if (!this._passiveBatch) this._passiveBatch = { messages: [], by: [], taskId: null };
    const batch = this._passiveBatch;
    if (!batch.messages.some((m) => m.id === message.id)) batch.messages.push(message);
    if (!batch.by.includes(agent.id)) batch.by.push(agent.id);
    if (job.taskId) batch.taskId = job.taskId;

    let woke = false;
    for (const leader of leaders) {
      // 已经有一个被动唤醒的轮次排着 → 不再排新的，它开始时会看到最新批次
      const already = this.queue.find((q) => q.agentId === leader.id && q.passive);
      if (already) { woke = true; continue; }
      this._enqueue(leader.id, {
        triggerMsg: message,
        taskId: job.taskId,
        source: 'agent',
        passive: true,
        relay: { from: agent.id, fromName: agent.name },
      });
      woke = true;
    }

    if (woke) {
      this.onEvent({
        type: 'head.passive_wake',
        by: batch.by.slice(),
        count: batch.messages.length,
        leaders: leaders.map((l) => l.id),
        relayCount: this.autoAdvance.count,
        text: `${batch.by.map((id) => `@${this.members.find((m) => m.id === id)?.name ?? id}`).join('、')} 没有 @ 任何人，已交回头头（合并 ${batch.messages.length} 条，第 ${this.autoAdvance.count}/${this.autoAdvance.maxContinuous} 次）`,
      });
    }
    return woke;
  }

  /**
   * 把新成员加进房间（内存 + 持久化）。
   * server 的手动加成员和 agent 造人走同一条路，避免两处逻辑不一致。
   */
  async addMember(member, { createdBy = 'human', reason = '' } = {}) {
    if (!this.onMemberCreate) {
      return { ok: false, reason: '当前运行方式不支持动态加成员' };
    }
    try {
      const added = await this.onMemberCreate(member, { createdBy, reason });
      this.members.push(added);
      if (added.role === 'leader') this.leaderIds.push(added.id);

      const payload = {
        member: {
          id: added.id, name: added.name, role: added.role,
          backend: added.backend, tier: added.tier,
          tiers: availableTiers(added.backend),
        },
        createdBy,
        reason,
      };

      // ★ 落盘：事件流里要留痕。光发事件不行——进程重启后事件流就没了，
      // 而"这个人是谁加的、为什么加"是事后要能查的东西。
      this.store.append({ kind: 'member.created', ...payload, at: Date.now() }).catch(() => {});
      this.onEvent({ type: 'member.created', ...payload });
      return { ok: true, member: added };
    } catch (err) {
      return { ok: false, reason: String(err?.message ?? err) };
    }
  }

  /** 头头默认收摘要投递（prompt.js 会调） */
  summaryFor(agentId) {
    return this.summaries.get(agentId) ?? null;
  }

  /**
   * 压缩并轮换 session（P0 #14）。
   * 用一次性调用生成摘要，然后清掉 sessionId —— 下一次发言就是新会话，
   * 且首轮 prompt 用 buildRebootstrap（摘要里含它自己的立场）。
   */
  async _compact(agent, adapter) {
    const tasks = [...this.store.tasks.values()];
    const msgs = decorate(this.store.messages, this.members);

    this.onEvent({ type: 'compact.start', agentId: agent.id });

    // ★ 优先用 agent 自己写的交接（CR-006）。
    // 交接是它亲手写的，比我们事后总结的更贴近它的真实状态；
    // 我们的摘要只作为它没给交接时的兜底。
    const staged = this.handoff.snapshot(agent.id);
    if (staged.phase === 'ready' && staged.handoff) {
      const oldSessionId = agent.sessionId ?? null;
      agent.sessionId = null;
      this.handoff.reset(agent.id);

      await this.store.append({
        kind: 'compact',
        agentId: agent.id,
        oldSessionId,
        newSessionId: null,
        summary: staged.handoff,
        mode: 'handoff',
      });
      this.onEvent({
        type: 'compact.done',
        agentId: agent.id,
        oldSessionId,
        mode: 'handoff',
        chars: staged.handoff.length,
      });

      return buildHandoffRebootstrap({
        agentName: agent.name,
        handoff: staged.handoff,
        recent: pickRecent(msgs, 6),
        tasks,
      });
    }

    const prompt = buildSummaryPrompt({
      agentName: agent.name,
      messages: msgs.length > 120 ? msgs.slice(-120) : msgs,
      previousSummary: this.summaries.get(agent.id) ?? null,
      tasks,
    });

    let summary = '';
    try {
      const r = await adapter.run({
        prompt,
        cwd: agent.cwd,
        sessionId: null,          // 摘要用独立一次性会话，不污染正式会话
        timeoutMs: 120_000,
        onEvent: () => {},
      });
      summary = (r?.text ?? '').trim();
    } catch (err) {
      summary = '';
      this.onEvent({ type: 'compact.failed', agentId: agent.id, detail: String(err?.message ?? err) });
    }

    if (!summary) {
      // 摘要失败不能让房间卡住：降级为「保留最近消息 + 旧摘要」，标记未压缩
      this.onEvent({
        type: 'notice', level: 'warn', agentId: agent.id,
        text: '上下文压缩失败，本轮沿用原会话继续；再次触及上限会重试',
      });
      agent.pendingCompact = false;
      return null;
    }

    this.summaries.set(agent.id, summary);
    const oldSessionId = agent.sessionId ?? null;
    agent.sessionId = null;               // 下一轮开新会话
    delete agent.pendingCompact;

    await this.store.append({
      kind: 'compact',
      agentId: agent.id,
      oldSessionId,
      newSessionId: null,
      summary,
    });
    this.onEvent({ type: 'compact.done', agentId: agent.id, oldSessionId, chars: summary.length });

    return buildRebootstrap({
      agentName: agent.name,
      summary,
      recent: pickRecent(msgs, 6),
      tasks,
    });
  }

  /**
   * 取该 (agent, 任务) 的会话与工作目录。
   * 任务有 worktree → cwd 用 worktree（这就是它的边界）；
   * 否则退回 agent 自己的目录（头头、以及没有仓库的纯讨论任务）。
   */
  _sessionFor(agent, taskId) {
    const key = taskId ? `${agent.id}::${taskId}` : agent.id;
    if (!this._sessions) this._sessions = new Map();
    if (!this._sessions.has(key)) {
      const task = taskId ? this.store.tasks.get(taskId) : null;
      const cwd = task?.worktree || agent.cwd;
      this._sessions.set(key, { sessionId: taskId ? (task?.sessionId ?? null) : (agent.sessionId ?? null), cwd });
    }
    const s = this._sessions.get(key);
    // worktree 可能在会话建立之后才创建，每次取用时校正
    const task = taskId ? this.store.tasks.get(taskId) : null;
    if (task?.worktree && s.cwd !== task.worktree) {
      s.cwd = task.worktree;
      s.sessionId = null;   // 目录变了，旧会话接不上
    }
    return s;
  }

  /** 给任务开 worktree。仓库必须在人登记的列表内（头头只能选，不能指定任意路径） */
  async openWorktree(task) {
    if (!this.registry?.length) {
      return { ok: false, reason: '房间还没有登记任何仓库，无法开 worktree（需由人先添加）' };
    }
    const r = await createTaskWorktree({
      repoPath: this.registry.find((x) => task.repo === x.path)?.path ?? task.repo,
      baseBranch: task.baseBranch,
      taskId: task.id,
      worktreesRoot: this.worktreesRoot,
      registry: this.registry,
    });
    if (!r.ok) return r;
    this.onEvent({ type: 'worktree.created', taskId: task.id, worktree: r.worktree, branch: r.branch });
    return r;
  }

  async _applyAction(a, agent) {
    const label = `${a.action}${a.id ? ` ${a.id}` : ''}`;

    // 权限在协议层强制，不靠提示词
    const targetTask = a.id ? this.store.tasks.get(a.id) : null;
    const deny = authorize(a, { role: agent.role, actorId: agent.id, task: targetTask });
    if (deny) {
      this.onEvent({ type: 'action.denied', agentId: agent.id, action: a.action, reason: deny });
      return { ok: false, label, reason: deny };
    }

    if (a.action === 'task.create') {
      const id = this.store.nextId('T');
      const assignee = this._resolveAgentId(a.assignee);
      if (a.assignee && !assignee) return { ok: false, label, reason: `找不到成员「${a.assignee}」` };

      const task = {
        id,
        title: a.title,
        parentId: a.parent ?? null,
        assignee,
        status: '待办',
        createdBy: agent.id,
        note: '',
        repo: a.repo ?? null,
        // 不传就由 createTaskWorktree 自动探测默认分支（老仓库是 master，硬编码 main 会全线失败）
        // 兼容模型直觉写法：base_branch / baseBranch / branch 都认
        baseBranch: a.base_branch ?? a.baseBranch ?? a.branch ?? null,
        worktree: null,
      };

      // 声明了仓库就开 worktree。校验失败必须回注原因，不能静默——
      // 否则头头以为派了活，成员实际还是在自己的空目录里改。
      if (task.repo) {
        const wt = await this.openWorktree(task);
        if (!wt.ok) {
          // 带上步骤名：不然模型会把"分支不存在"当成"仓库没登记"来回折腾
          return { ok: false, label, reason: wt.step ? `开 worktree 失败（${wt.step}）：${wt.reason}` : wt.reason };
        }
        task.worktree = wt.worktree;
        task.baseBranch = wt.baseBranch;
      }

      await this.store.createTask(task);
      this.onEvent({ type: 'task.created', task });
      const where = task.worktree ? `（worktree: ${task.worktree}）` : '';
      return { ok: true, label, detail: `${id} ${a.title} → ${assignee ?? '未指派'}${where}` };
    }

    if (a.action === 'task.update') {
      if (!targetTask) return { ok: false, label, reason: `任务 ${a.id} 不存在` };
      const patch = {};
      if (a.status != null) patch.status = a.status;
      if (a.assignee != null) {
        const assignee = this._resolveAgentId(a.assignee);
        if (!assignee) return { ok: false, label, reason: `找不到成员「${a.assignee}」` };
        patch.assignee = assignee;
      }
      if (a.note != null) patch.note = a.note;
      await this.store.updateTask(a.id, patch);
      this.onEvent({ type: 'task.updated', id: a.id, patch });
      return { ok: true, label, detail: `${a.id} ${JSON.stringify(patch)}` };
    }

    if (a.action === 'roster.update') {
      // 成员只能改自己；头头改下属
      const targetId = agent.role === 'member' ? agent.id : (this._resolveAgentId(a.of) ?? agent.id);
      await this.store.updateRoster(targetId, {
        selfDuties: a.duties ?? undefined,
        accepts: a.accepts ?? undefined,
      });
      this.onEvent({ type: 'roster.updated', agentId: targetId });
      return { ok: true, label, detail: `${targetId} 职责已更新` };
    }

    if (a.action === 'member.create') {
      const plan = planMemberCreation({
        action: a, members: this.members, ceiling: this.aiCabTier,
      });
      if (!plan.ok) {
        // 超天花板这种情况尤其要说清——否则它会反复重试同一个请求
        this.onEvent({
          type: 'notice', level: 'warn', agentId: agent.id,
          text: `不能加成员：${plan.reason}`,
        });
        return { ok: false, label: 'member.create', reason: plan.reason };
      }

      const created = await this.addMember(plan.member, { createdBy: agent.id, reason: a.reason });
      if (!created.ok) return { ok: false, label: 'member.create', reason: created.reason };

      return {
        ok: true,
        label: 'member.create',
        detail: `已加入 @${plan.member.name}（${plan.member.backend}，${plan.member.tier}）`,
      };
    }

    if (a.action === 'continue') {
      // 「这件事没完，请下一位接着说」。真正的派发在 _runTurn 里做
      // （那里才知道谁刚说完、有没有 @ 别人）。
      //
      // 注意：**护栏计数不在这里做**。如果这次 continue 最后被 @ 覆盖掉、
      // 根本没发生自动推进，它不该占用额度——否则模型多写一句 continue
      // 就把后面真正需要的推进额度耗掉了。
      this._pendingContinue = { from: a.actor, reason: a.reason };
      return { ok: true, label: 'continue', detail: `待推进：${a.reason}` };
    }

    return { ok: false, label, reason: '未知动作' };
  }

  /**
   * 按 roster 顺序找下一个该说话的人。
   *
   * 从发起者之后开始找人（不是从头发起），所以「头头 → 成员 A → 成员 B」
   * 这种顺序才自然；轮到最后一个人会绕回最前面。
   *
   * @param {string} fromId 谁发的 continue
   * @returns {{agent:object|null, reason?:string}}
   */
  nextInRoster(fromId) {
    const idx = this.members.findIndex((m) => m.id === fromId);
    const n = this.members.length;
    if (n === 0) return { agent: null, reason: '房间里没有人' };

    for (let i = 1; i <= n; i += 1) {
      const cand = this.members[(idx + i) % n];
      // 跳过被熔断的——派给一个正在暂停的人等于没派
      if (!this.health.canRun(cand.id).ok) continue;
      // 跳过已经派出去的
      if (this.queue.some((q) => q.agentId === cand.id)) continue;
      return { agent: cand };
    }
    return { agent: null, reason: '没有可继续的成员（都在暂停中或已在队列里）' };
  }

  _resolveAgentId(nameOrId) {
    if (!nameOrId) return null;
    if (nameOrId === 'human' || nameOrId === '老板') return 'human';
    const m = this.members.find(
      (x) => x.id === nameOrId || x.name === nameOrId
        || (x.aliases ?? []).includes(nameOrId),
    );
    return m?.id ?? null;
  }

  /**
   * 循环护栏（CR-008）：只提示不阻断。
   *
   * 四个信号，前三个是主判据（缺一个就漏一类死循环），第四个是辅助：
   *  1. consecutive 连续次数 —— 防一个人自说自话
   *  2. chainDepth  链深度   —— 防一群人轮流转圈（谁都没连续，但永不停）
   *  3. totalTurns  总发言数 —— 防广播时人数多导致的长链
   *  4. similarity  内容重复 —— 追加信号，AI 互相客套时最明显
   */
  _detectLoop(agent, body, { reset = false } = {}) {
    if (reset) {
      this.guard.reset();
      this.onEvent({ type: 'guard.reset' });
      return;
    }

    const reasons = this.guard.record({ agentId: agent.id });

    const prev = this.store.messages.filter((m) => m.senderId === agent.id).at(-2);
    if (prev && similarity(prev.body, body) >= 0.85 && !this.guard._reported.has('similar')) {
      this.guard._reported.add('similar');
      reasons.push({ kind: 'similar', text: '与上次发言内容高度重复' });
    }

    if (reasons.length) {
      const payload = {
        type: 'loop.warning',
        level: 'warn',
        agentId: agent.id,
        reasons,
        stats: this.guard.snapshot(),
        highlightStop: true,
      };
      // ★ 落盘。只发界面的话，事后查记录只能看到"他们聊了 12 轮"，
      // 查不到"系统当时警告过"——那这个警告就没法复盘，
      // 也没法回答老板"为什么没人告诉我它在绕圈"。
      this.store.append({
        kind: 'loop.warning',
        agentId: agent.id,
        reasons: reasons.map((r) => ({ kind: r.kind, text: r.text })),
        stats: payload.stats,
        at: Date.now(),
      }).catch(() => {});
      this.onEvent(payload);
    }
  }
}

/** 粗糙的相似度：按字符二元组重合率，够用来触发提示 */
export function similarity(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(sa);
  const B = grams(sb);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}
