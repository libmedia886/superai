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
    registry = [], worktreesRoot = null,
  }) {
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

    return { messageId: msg.message.id, targets: recipients, unknown, broadcast };
  }

  /** 广播顺序：头头优先，其余按加入顺序（§6.4.1） */
  _broadcastOrder() {
    const leader = this.members.filter((m) => m.role === 'leader');
    const rest = this.members.filter((m) => m.role !== 'leader');
    return [...leader, ...rest].map((m) => m.id);
  }

  _enqueue(agentId, entry) {
    const dup = this.queue.find((q) => q.agentId === agentId && q.taskId === entry.taskId);
    if (dup) {
      this.onEvent({ type: 'queued', agentId, alreadyQueued: true });
      return false;
    }
    this.queue.push({ ...entry, agentId });
    this.onEvent({ type: 'queued', agentId, pending: this.queue.length });
    return true;
  }

  // ---------- 运行 ----------

  /** 把队列跑空。串行：一次一个。 */
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const job = this.queue.shift();
        await this._runTurn(job);
      }
      if (this.queue.length === 0 && !this.stopped) {
        this.waitingForHuman = true;
        this.onEvent({ type: 'idle', waitingForHuman: true });
      }
    } finally {
      this.running = false;
    }
  }

  /** 立即打断当前发言人：杀进程，保留已输出；队列继续（P0 #7） */
  interrupt() {
    if (!this.current) return false;
    this.current.abort?.();
    this.onEvent({ type: 'interrupted', agentId: this.current.agentId });
    return true;
  }

  /** 一键停止整个房间（唯一的硬闸） */
  stop() {
    this.stopped = true;
    this.queue = [];
    if (this.current) this.current.abort?.();
    this.onEvent({ type: 'stopped' });
  }

  resumeRoom() {
    this.stopped = false;
    this.onEvent({ type: 'resumed' });
  }

  /** 头头接管（P0 #20）：暂停头头，不再自动入队 */
  takeOver() {
    this.overridden = true;
    this.onEvent({ type: 'takeover' });
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

    let prompt = rebootstrap ?? buildPrompt({
      agent, room: this, store: this.store,
      trigger: job.triggerMsg, mode: delivery,
      taskId: job.taskId, actionResults,
    });

    // 还在等交接：把 ASK 段附在正常 prompt 末尾（不影响它正常干活）
    if (!rebootstrap && this.handoff.needsAsk(agent.id) && !this.handoff.canFire(agent.id)) {
      prompt += ASK_INSTRUCTION;
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
    const displayBody = handoffInfo.text ?? body;

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
    if (results.length) this.onEvent({ type: 'action.results', agentId: agent.id, results });

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
    this._detectLoop(agent, body, { reset: job.source !== 'agent' });

    // 4.5) 上下文水位：达阈值就标记，下一轮开头压缩 + 轮换 session
    if (adapterResult?.usage) {
      const used = (adapterResult.usage.inputTokens ?? 0)
        + (adapterResult.usage.cacheReadTokens ?? 0)
        + (adapterResult.usage.cacheWriteTokens ?? 0);
      const window = adapterResult.usage.contextWindow ?? null;
      const ratio = usageRatio({ usedTokens: used, window, backend: agent.backend });
      this.onEvent({ type: 'context.usage', agentId: agent.id, usedTokens: used, ratio });
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
        this.onEvent({
          type: 'notice', level: 'warn', agentId: agent.id,
          text: [
            unknown.length ? `未找到 ${unknown.map((u) => `@${u}`).join(' ')}` : '',
            overreach.length ? `越权 @ ${overreach.join(' ')}，未生效` : '',
          ].filter(Boolean).join('；'),
        });
      }
      for (const t of allowed) {
        this._enqueue(t, { triggerMsg: msg.message, taskId: job.taskId, source: 'agent' });
      }
      // 注意：不在这里发 idle 事件。队列可能还有别人在等（比如人同时 @ 了两位），
      // 真正的「等待人类」由 drain() 在队列跑空时统一发出，避免重复提示。
      if (allowed.length === 0) this.waitingForHuman = true;
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
        baseBranch: a.base_branch ?? 'main',
        worktree: null,
      };

      // 声明了仓库就开 worktree。校验失败必须回注原因，不能静默——
      // 否则头头以为派了活，成员实际还是在自己的空目录里改。
      if (task.repo) {
        const wt = await this.openWorktree(task);
        if (!wt.ok) {
          return { ok: false, label, reason: wt.reason };
        }
        task.worktree = wt.worktree;
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

    return { ok: false, label, reason: '未知动作' };
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
      this.onEvent({
        type: 'loop.warning',
        level: 'warn',
        agentId: agent.id,
        reasons,
        stats: this.guard.snapshot(),
        highlightStop: true,
      });
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
