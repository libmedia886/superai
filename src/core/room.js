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
import {
  HealthTracker, retryDecision, stallThreshold, slowStartThreshold, STALL_MS,
} from './health.js';
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
/**
 * 停顿原因的优先级：高的不能被低的覆盖。
 * 真实故障（超时/出错/被刹住）永远压过"没点名下一位"这类常规收尾。
 */
export const PAUSE_PRIORITY = {
  no_target: 1,
  only_human: 1,
  summary: 1,
  overreach: 2,
  continue_cap: 2,
  error: 3,
  timeout: 3,
  breaker: 3,
  stopped: 4,
  interrupted: 2,
};

/** 停顿原因 → 人话。状态栏直接显示这个，不要让人猜。 */
/** 默认单轮硬上限：20 分钟。看门狗负责"死了"，这里只防"无限跑" */
export const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;

/**
 * 工具执行期间的静默窗口。
 *
 * 一次 `curl -m 60`、一次大仓库的 grep 都可能几分钟没有任何流事件，
 * 这期间进程是活的。窗口给到 10 分钟，超了仍然判死——
 * 而且真正的兜底是本轮硬上限，不会变成"永不杀"。
 */
export const TOOL_FLIGHT_SILENCE_MS = 10 * 60_000;

/**
 * 撞到单轮上限、但确实在干活 → 最多自动续做几次。
 *
 * 「跑得久」不是错误信号，「没有任何产出」才是（那个交给看门狗）。
 * 实测事故：管理员连跑 30 分钟、17 次工具调用，正在取证，被硬上限一刀切掉。
 * 但续做次数必须有上限：否则等于取消了硬上限，那才是真失控。
 */
export const MAX_CAP_CONTINUES = 2;

/**
 * 解析某个成员本轮实际生效的单轮上限。
 *
 * 优先级：`timeoutMinutes`（界面字段） > `timeoutMs`（旧的手写字段） > 房间默认。
 *
 * ★ 为什么保留旧的 `timeoutMs` 支路、但要单独暴露出来：
 *   删掉它会让 room.json 里已有的手写值**静默失效**——老板刚经历过
 *   "界面显示 20 分钟、实际 30 分钟"，反向再来一次同样不可接受。
 *   所以：行为不变，但把"这个值不是从界面来的"显式告诉界面（见 timeoutSource）。
 */
export function resolveMemberTimeoutMs(agent, roomDefaultMs = DEFAULT_TURN_TIMEOUT_MS) {
  if (agent?.timeoutMinutes) return Math.round(agent.timeoutMinutes * 60_000);
  if (agent?.timeoutMs) return agent.timeoutMs;
  return roomDefaultMs;
}

/**
 * 这个上限是从哪来的。界面必须显示它——否则"界面上的值和实际值不一样"
 * 这类问题会一直复发。
 * @returns {'member'|'legacy'|'room'}
 */
export function timeoutSource(agent) {
  if (agent?.timeoutMinutes) return 'member';
  if (agent?.timeoutMs) return 'legacy';
  return 'room';
}

export const PAUSE_LABEL = {
  no_target: '说完了，没点名下一位',
  timeout: '超时被中止（不是说完）',
  interrupted: '这一轮被中途打断',
  overreach: '@ 了没权限叫的人',
  only_human: '把话交回给老板',
  continue_cap: '自动接力次数到上限',
  breaker: '连续失败，暂时停用',
  stopped: '你点了「停止」',
  summary: '总结完毕',
  error: '出错停住',
};

/**
 * ★ CLI 的例行警告不能当失败原因（@li 2026-11-16 13:25 实际贴出来的原话）。
 *
 * 他看到的是一行：「审校员 失败：timeout — [claude-code:unrecognized_model] {...}」
 * 那是网关模型名不被识别的警告（功能一直正常），与本次失败毫无关系，
 * 却把真正的原因盖掉了。用户拿到的是一句看不懂的技术噪音。
 *
 * 这条在合并 CR-036 时被我冲掉过一次——所以现在有单独的测试盯着。
 */
const STDERR_NOISE = /^(?:\[claude-code:[^\]]*\]|Claude Code doesn't recognize the model|Claude Code does not recognize the model)/;

export function cleanStderr(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim())
    .filter((l) => l && !STDERR_NOISE.test(l));
  return lines.join('\n').slice(0, 500);
}

const PASS_MARKERS = /^\[?\s*(pass|no_reply|no-reply|skip|无需回应|不用回复|不需要回应)\s*\]?[。.!！]?$/i;

export function isPassReply(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  return PASS_MARKERS.test(t);
}

function isStall(result, durationMs) {
  if (result?.reason !== EXIT.TIMEOUT) return false;
  const text = result?.text ?? '';
  // 只看"有没有产出"。判据里不能再夹"跑了多久"——跑了很久但一直在干活
  // 是**正常**的（实测审校员 6 次 curl 就超过 180 秒），那由看门狗另行判定。
  return text.trim().length === 0;
}

/**
 * 超时/卡死的中止文案。
 *
 * ★ 抽成纯函数，是因为这段文案今天改了四轮，**每轮都是数字与事实的偏差**：
 *   - 用 `timeoutMs`（配置上限）冒充实际耗时 → 实际跑了 112 秒却写"跑满 1800 秒"
 *   - `stalled:true` 是看门狗判的，却写"看门狗没有判它卡死"
 *   - `rowToolsInTurn === 0` 不等于"没有输出"（它可能已经写了一段）
 * 纯函数才能把这些数字逐个断言出来；埋在 200 行的方法里只能靠读代码。
 *
 * @param {object} o
 * @param {string} o.name            成员名
 * @param {boolean} o.stalledOut     是否被看门狗判死
 * @param {number} o.durationMs      实际耗时（**不是**配置上限）
 * @param {number} o.timeoutMs       配置的单轮上限
 * @param {number} o.toolCalls       本轮工具调用次数
 * @param {number} o.textChars       本轮已输出字数
 * @param {number} o.capContinues    已自动续做次数
 * @param {number} o.maxCapContinues 上限
 * @param {number} o.stallMs         卡死窗口（毫秒）
 */
export function timeoutPauseText({
  name, stalledOut, durationMs, timeoutMs, toolCalls, textChars,
  capContinues = 0, maxCapContinues = MAX_CAP_CONTINUES, stallMs = STALL_MS,
  /**
   * 是否有可续的轮次（= 调用方是否设了 resumeTarget）。
   *
   * ★ 这个入参存在的唯一目的：让**文案**和**按钮**用同一份事实。
   * 之前两次翻车都是两边各算各的——一次是文案说有按钮但没设 resumeTarget
   * （用户点了发现行为不对），一次是设了 resumeTarget 但文案不提
   * （按钮存在却不告诉用户）。共用一个布尔值，两边就不可能分叉。
   */
  canResume = false,
}) {
  const secs = Math.max(1, Math.round(durationMs / 1000));
  const capSecs = Math.round(timeoutMs / 1000);
  const stallSecs = Math.round(stallMs / 1000);
  const toolPart = `本轮 ${toolCalls} 次工具调用`;
  const hadText = textChars > 0;
  const didSomething = toolCalls > 0 || hadText;
  const textPart = hadText ? `，已输出 ${textChars} 字` : '';

  const resumeHint = canResume ? '点「接着做完」可以接着做，不会重做已完成的部分。' : '';

  if (stalledOut) {
    return `${name} 静默 ${stallSecs} 秒，被看门狗判定卡死（耗时 ${secs} 秒，${toolPart}${textPart}）。`
      + (toolCalls > 0
        ? '它跑过工具，结果都还在会话里。' + resumeHint
        : hadText
          ? '它已经写了一部分，会话仍在。' + (resumeHint || '点「接着做完」接着写，不会重来。')
          : '本轮没有任何工具调用、也没有输出，多半是空转了。');
  }
  if (capContinues >= maxCapContinues) {
    return `${name} 跑满上限 ${capSecs} 秒被中止（耗时 ${secs} 秒，${toolPart}${textPart}）。`
      + `已自动续做 ${maxCapContinues} 次仍未收尾，不再自动续——请确认它是不是在原地打转。`
      + resumeHint;
  }
  if (didSomething) {
    return `${name} 跑满上限 ${capSecs} 秒被中止（耗时 ${secs} 秒，${toolPart}${textPart}）。`
      + '它确实在干活，但这一轮没能在上限内收尾。'
      + resumeHint;
  }
  return `${name} 跑满上限 ${capSecs} 秒被中止（耗时 ${secs} 秒，${toolPart}）。`
    + '没有任何工具调用、也没有输出，多半是空转。';
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
    aiCabTier = DEFAULT_AI_CAB_TIER, headPassiveWake = true, sharedDir = null,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
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
    /** 房间共享目录（成员交换文件用；不靠 prompt 里贴全文） */
    this.sharedDir = sharedDir;
    /**
     * 共享目录挂在房间上，同时镜像到每个成员：适配器按 agent 配置构建，
     * 拿不到 room。两处都设，防止"prompt 说有、适配器不知道"这种半生效状态。
     */
    if (sharedDir) for (const m of this.members) m.sharedDir = sharedDir;
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
    /**
     * 单轮硬上限。
     *
     * ★ 这是"防无限跑"的闸，**不是卡死判定**。卡死由看门狗负责
     * （90 秒无任何输出即判死），两者职责不同，别混。
     *
     * 曾经是 180 秒扁平常量，结果把正在干活的轮次全杀了：
     * 实测审校员跑 6 次 `curl -m 25` 就超过 180 秒，抓到的网页还在磁盘上、
     * 正文一个字没产出。越认真干活越容易被杀——这是设计错误，不是参数没调好。
     */
    this.turnTimeoutMs = turnTimeoutMs;
    /** 慢启动提示阈值（毫秒）。null = 按硬上限推算；测试可覆盖。 */
    this.slowStartMs = null;
    /** 被打断的那一轮：供「接着做完」直接续做（CR-036） */
    this.resumeTarget = null;
    /** 重启后恢复上次的暂停原因（否则界面说"等待人类"，实际是停在一个原因上） */
    this.pauseReason = store?.pause ? { ...store.pause } : null;
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
     * ★ 人的新指令作废「待续」。
     *
     * `resumeTarget` 原本只在「用掉」「本轮正常收尾」「构造」三处清空，
     * 人直接说新任务时不会清。实测后果不是文案难听，而是**指向错的东西**：
     *   1. 某轮超时且有产出 → resumeTarget 记下任务 A
     *   2. 人不点按钮，改说一件新事 → 旧值还在
     *   3. 新事跑一轮零产出（0 工具 0 正文）→ 不覆盖旧值
     *   4. 界面仍显示「接着做完」，点下去恢复的是**任务 A**
     * 人的新指令本来就覆盖旧的「待续」，这是 CR-036 规格里的原话。
     */
    this.resumeTarget = null;

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
    const agentId = this.current.agentId;
    this.current.abort?.();
    /**
     * 落盘（CR-036）。
     *
     * 原来只发 SSE：事后翻 room.jsonl 只能看到某轮 status:"已中断"，
     * 查不到是谁、因为什么中止的——「系统做了事、事后查不到」。
     * 人工干预必须是可追责的动作，所以记一条 control 事件。
     */
    this.store.append({
      kind: 'control',
      action: 'interrupt',
      who: 'human',
      agentId,
      at: Date.now(),
    }).catch(() => {});
    this.onEvent({ type: 'interrupted', agentId });
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
    // 落盘（CR-036）：事后要能回答"谁在什么时候停了房间、丢了几条"
    this.store.append({
      kind: 'control',
      action: 'stop',
      who: 'human',
      dropped,
      interrupted: wasRunning,
      at: Date.now(),
    }).catch(() => {});
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
    /**
     * 原因有优先级：低优先级不能覆盖高优先级的理由。
     *
     * 事故（CR-035，管理方在 13:47:45 那条记录上抓到的）：
     * 同一秒既有 `failure reason:"failed"`（282 秒、16 次工具调用），
     * 又有 `pausedReason{reason:"no_target", detail:"说完了，没有点名下一位"}`。
     * 也就是说：它明明失败了，界面却告诉用户"它说完了"。
     *
     * 真实失败的原因必须压得住"没点名下一位"这种常规收尾理由。
     * 反过来，同一轮里先 no_target 再 timeout（比如先停住又被判超时）要能覆盖。
     */
    const prev = this.pauseReason;
    if (prev && (PAUSE_PRIORITY[prev.reason] ?? 0) > (PAUSE_PRIORITY[reason] ?? 0)) {
      this.onEvent({
        type: 'notice',
        level: 'info',
        text: `（不再显示"${PAUSE_LABEL[reason] ?? reason}"：本轮的真正原因是「${PAUSE_LABEL[prev.reason] ?? prev.reason}」）`,
      });
      this.waitingForHuman = true;
      return prev;
    }
    this.waitingForHuman = true;
    const text = String(detail ?? '');

    /**
     * ★ 按钮与暂停原因必须成对出现 —— **双向**。
     *
     * 管理方 20:18 用复现脚本抓到反方向的分叉：
     *   turn2 超时 → 设 resumeTarget(A) + 暂停 timeout（此时一致）
     *   turn3 零产出 → 熔断暂停 breaker
     *   结果：breakert 的文案不提按钮，但 resumeTarget 还是 turn2 的 A
     *   → 界面上并排放着一个「接着做完」和一个「连续失败，已暂停」，谁也没说它们不是一回事
     *
     * `canResume` 只统一了「文案→按钮」；这里统一「按钮→文案」，判据是**文案本身**：
     * 只有提到「接着做完」的暂停才有按钮。反过来，不提到的暂停一律清掉。
     * 于是 `Boolean(resumeTarget) === detail.includes('接着做完')` 恒成立，
     * 不依赖任何一处"记得清"。
     */
    if (!text.includes('接着做完')) this.resumeTarget = null;

    this.pauseReason = { reason, detail: text, at: new Date().toISOString() };
    // 落盘：内存字段活不过重启，重启后"为什么停着"不能变成谜
    this.store?.append?.({ kind: 'room.pause', reason, detail: this.pauseReason.detail }).catch?.(() => {});
    /**
     * 带上 resumeTarget：界面靠它决定按钮显示「接着做完」还是「接着推进」。
     * 不带就会出现"提示里让你点接着做完、按钮却写着接着推进"（管理方 18:42 抓到的那处）。
     */
    this.onEvent({
      type: 'room.paused',
      reason,
      detail: this.pauseReason.detail,
      resumeTarget: this.resumeTarget ? { ...this.resumeTarget } : null,
    });
    return this.pauseReason;
  }

  /** 恢复发言时清掉暂停原因（否则状态栏会一直挂着一个过期理由） */
  _clearPause() {
    /**
     * ★ `resumeTarget` 与 `pauseReason` 是**同一次暂停的两个面向**，必须同生共死。
     *
     * 管理方 20:11 补的这条比"被覆盖"更准：零产出的一轮不会覆盖 resumeTarget，
     * 所以只要人不说新话、系统自己空转一轮，界面上那个「接着做完」
     * 仍然指向**上一件事**——而且点下去跑得很正常，只是内容不是他要的。
     * 那比文案说错更隐蔽：用户能看出文案不对，看不出按钮指错了对象。
     *
     * 放进 `_clearPause()` 之后，"按钮存在 ⟺ 状态栏正显示着那次暂停"永远成立，
     * 不需要额外记时间戳，也不需要第二处清空点。
     */
    this.resumeTarget = null;
    if (!this.pauseReason) return;
    this.pauseReason = null;
    this.store?.append?.({ kind: 'room.resume' }).catch?.(() => {});
    this.onEvent({ type: 'room.resumed', reason: 'cleared' });
  }

  /**
   * 把任务交给某个人：走正常入队（护栏、去重键都照旧）。
   *
   * @returns {boolean} 是否真的排进去了（被接管/停止/熔断时为 false）
   */
  _dispatchTo(agentId, { taskId = null, by = null } = {}) {
    const target = this.members.find((m) => m.id === agentId);
    if (!target) return false;
    if (this.stopped) return false;
    if (this.overridden && target.role === 'leader') return false;

    const ok = this._enqueue(agentId, {
      triggerMsg: { id: `dispatch-${taskId ?? Date.now()}-${agentId}`, senderId: by ?? 'human', body: `任务 ${taskId ?? ''} 指派给你` },
      taskId,
      source: 'agent',
      dispatched: true,
    });
    if (ok) {
      this.onEvent({
        type: 'task.dispatched',
        taskId,
        agentId,
        by,
        text: `已把 ${taskId ?? '任务'} 交给 @${target.name}（真正入队，不只是改字段）`,
      });
    }
    return ok;
  }

  /**
   * 未完成清单：**跨轮保留**的"没做成的动作"。
   *
   * ★ 为什么必须是"清单"而不是"上一轮的回注"：
   * 实测事故（15:27:54）：管理员连续三次 `task.update T-008 status=阻塞·需外部渠道`
   * 三次都被拒。被拒结果确实回注进了下一轮 prompt —— 但**只活那一轮**。
   * 它跨了很多轮之后写报告，那条"你被拒了"早已被长上下文淹掉，
   * 于是报告里明确写着「T-008/T-009 已改为阻塞」，而任务板至今是「待办」。
   *
   * 从 `store.actionLog` 派生（同一个 label 以最新一条为准），所以：
   *  - 重启后仍然有效（actionLog 是落盘事件流）
   *  - 后面成功一次自动消失（不需要额外的"解决"动作）
   */
  unresolvedActions({ limit = 20 } = {}) {
    const last = new Map();
    for (const e of this.store?.actionLog ?? []) {
      if (!e?.label) continue;
      last.set(e.label, e);   // 后出现的覆盖先出现的
    }
    return [...last.entries()]
      .filter(([, e]) => e.ok === false)
      .map(([label, e]) => ({ label, reason: e.reason ?? '', at: e?.at ?? null }))
      .slice(-limit);
  }

  /**
   * 检测"把没做成的动作写成已完成"。
   *
   * 光在 prompt 里提醒不够——模型仍可能按自己的意图写报告。所以在它写完、
   * 落库之前做一次对照：正文若把某个**仍未成功**的任务 id 说成已改/已完成，
   * 就在界面上标出来，并把这条塞进它下一轮的说明里。
   * 这不是拦截（不擅改它的正文），是**不让界面替它圆谎**。
   */
  _detectFalseClaims(body, agentId) {
    const text = String(body ?? '');
    if (!text) return [];
    const claimed = [];
    for (const p of this.unresolvedActions()) {
      // label 形如 "task.update T-008"；取出目标 id
      const id = p.label.split(/\s+/).slice(1).join(' ').trim();
      if (!id || !text.includes(id)) continue;

      /**
       * 只在 id **附近**找"已完成"的说法，且必须排除意图句。
       *
       * 误报的代价很高：老板看到「系统说它在撒谎」，而它其实只是写了
       * "我打算把 T-008 改成阻塞"——那他下次就不信这个警告了。
       * 所以：
       *   - 窗口：id 前后各 30 字
       *   - 有意图词（打算/计划/将/需要/建议…）→ 是提议，不是声称
       *   - 有完成态动词（已改/改为/改成…）→ 才算声称
       */
      const idx = text.indexOf(id);
      const near = text.slice(Math.max(0, idx - 30), idx + id.length + 30);
      const INTENT = /(打算|计划|准备|将要|将会|将|需要|还需|建议|拟|是否要|要不要|待)/;
      const CLAIM = /(已改|已完成|已更新|已设为|已调整|已处理|改成|改为|设成|设置为)/;
      if (INTENT.test(near)) continue;
      if (CLAIM.test(near)) {
        claimed.push({ id, label: p.label, reason: p.reason });
      }
    }
    if (claimed.length) {
      this.onEvent({
        type: 'notice',
        level: 'warn',
        agentId,
        text: `正文声称 ${claimed.map((c) => c.id).join('、')} 已处理，但系统里这些动作**没有成功**`
          + `（${claimed[0].reason || '被拒'}）。任务板上它们仍是原状态。`,
      });
      for (const c of claimed) {
        this._note(agentId, `${c.id} 的那个动作（${c.label}）**没有成功**（${c.reason || '被拒'}），`
          + '但你在正文里写成了已完成。下一轮请如实说明，或重新发一次正确的动作。');
      }
    }
    return claimed;
  }

  /**
   * 把被打断的那一轮重新交给同一个人（CR-036）。
   *
   * 与 `resumeRoom()` 不同：那个只解「停止」这个总闸，这个是**真的重跑**。
   * 「继续」在两种停法下含义不同：
   *   - stopped     → 让房间重新接受消息
   *   - interrupted → 让被打断的人接着做
   *
   * 为什么必须有这一条：@li 打断管理员那一轮后房间静默 19 分钟——
   * 落盘只解决"事后能查"，他当场看到的是"一片空白"。
   */
  resumeInterruptedTurn() {
    const t = this.resumeTarget;
    if (!t) return { ok: false, reason: '没有被中断的轮次' };
    const agent = this.members.find((m) => m.id === t.agentId);
    if (!agent) return { ok: false, reason: '被中断的成员已不在房间里' };
    this.resumeTarget = null;
    this._clearPause();
    this._enqueue(agent.id, {
      triggerMsg: { id: `resume-${Date.now()}`, senderId: 'human', body: '（继续被中断的那一轮，接着往下做）' },
      taskId: t.taskId,
      source: 'human',
      resumed: true,
    });
    this.onEvent({ type: 'resumed.turn', agentId: agent.id, partialChars: t.partialChars });
    return { ok: true, agentId: agent.id };
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

    /**
     * 未完成清单必须**每轮**出现，不能只靠上一轮的回注。
     * 实测：被拒三次的动作，跨十轮之后模型已经"不记得"，照样在报告里写"已改"。
     */
    const pendingActions = this.unresolvedActions();

    let prompt = rebootstrap ?? buildPrompt({
      agent, room: this, store: this.store,
      trigger: job.triggerMsg, mode: delivery,
      taskId: job.taskId, actionResults,
      notes: pendingNotes,
      pendingActions,
    });
    if (rebootstrap && pendingNotes.length) {
      prompt += '\n\n--- 系统上次拦下了你的一个动作 ---\n'
        + pendingNotes.map((n) => `- ${n.text}`).join('\n');
    }
    if (rebootstrap && pendingActions.length) {
      prompt += '\n\n--- 未完成清单（这些动作没有成功，不要写成已完成）---\n'
        + pendingActions.map((p) => `- ❌ ${p.label}${p.reason ? ` —— ${p.reason}` : ''}`).join('\n');
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

    /**
     * 撞上限自动续做：必须说清"这不是失败，是接着做"。
     *
     * 不说的话模型会把打断当失败：要么重头再来（白烧一遍），要么停下来问
     * "刚才出错了"。它已经做过的结论都在会话里，要的是从断点继续。
     */
    if (job.capContinue) {
      prompt += `\n\n--- 上一轮被系统中止（第 ${job.capContinue} 次续做） ---\n`
        + '上一轮做到一半被系统中止（撞到单轮上限，或长时间没有输出被判定卡住），'
        + '**不是你的错，也不是失败**。接着把它做完：已完成的结论不要重写，'
        + '从断掉的地方继续；能收尾就收尾，不能收尾就说清还差什么。';
    }

    /**
     * 人点了「接着做完」：续一条被打断的轮次。
     *
     * 和 `capContinue`（撞上限自动续做）是同一件事，只是触发者不同，
     * 所以必须给同样的说明。没有这段时，模型只看到一句合成人话
     * 「（继续被中断的那一轮，接着往下做）」，很可能先去解释/道歉，
     * 或者从头重做一遍——它做过的东西都还在会话里。
     */
    if (job.resumed) {
      prompt += '\n\n--- 老板点了「接着做完」 ---\n'
        + '上一轮做到一半被中断（**不是你的错，也不是失败**）。接着把它做完：'
        + '已完成的部分不要重写，从断掉的地方继续；能收尾就收尾，不能收尾就说清还差什么。';
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

    /**
     * ★ 新一轮开始 = 上一轮的理由作废。
     *
     * `PAUSE_PRIORITY` 的用途是"同一轮内部别被低优先级覆盖"，
     * 但它原来跨轮也比较：一条 timeout 挂上去后，后面每轮正常收尾的
     * `no_target` 都被静默拒收 → 界面永久挂着一条已被事实推翻的理由。
     *
     * 实测（管理方 10:17）：零产出重试成功、房间正常收尾，
     * /api/health 仍显示那条假 timeout。所以这里必须清。
     */
    this._clearPause();
    this.onEvent({ type: 'turn.start', agentId: agent.id, pending: this.queue.length });

    let aborted = false;
    let acc = '';
    let adapterResult = null;
    /** 本轮工具调用次数：决定"零产出能不能续做"与超时原因的措辞 */
    let rowToolsInTurn = 0;
    /**
     * 本轮撞上限后是否已经排了自动续做。
     * 必须在**重试判定之前**可见：两条路径（撞上限续做 / 失败重试）
     * 会同时满足同一个超时，重复入队会让这个成员白跑一轮。
     */
    let capAutoContinued = false;
    /** 是否已经吐出过第一个 token（正文或思考都算） */
    let sawFirstToken = false;

    // 成员可单独配单轮上限（分钟）；留空用房间默认
    const timeoutMs = resolveMemberTimeoutMs(agent, this.turnTimeoutMs);

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
        if (ev.type === 'text' && ev.text) { acc += ev.text; sawFirstToken = true; }
        if (ev.type === 'thinking' && ev.text) sawFirstToken = true;
        if (ev.type === 'tool') sawFirstToken = true;
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
        if (ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool' || ev.type === 'activity') {
          this.health.touch(agent.id);
        }
        /**
         * 工具执行中：静默窗口必须放宽。
         *
         * claude 在 curl 跑着的 45 秒里一条流事件都不发（tool_use 已发、
         * tool_result 要等命令结束）。90 秒窗口一到就会把一个正在干活的轮次判死，
         * 实测线上出现过 11 次工具调用的轮次被 "stalled" 杀掉。
         *
         * 放宽不等于永不杀：硬上限（本轮 timeoutMs）仍然兜底。
         */
        if (ev.type === 'tool') {
          rowToolsInTurn += 1;
          this._toolFlight = this._toolFlight ?? new Map();
          const cur = this._toolFlight.get(agent.id) ?? { count: 0, since: Date.now() };
          this._toolFlight.set(agent.id, { count: cur.count + 1, since: Date.now() });
        }
        if (ev.type === 'tool.result') {
          this._toolFlight?.delete(agent.id);
          this.health.touch(agent.id);
        }
        if (ev.type === 'text' || ev.type === 'usage' || ev.type === 'thinking') {
          this.onEvent({ ...ev, agentId: agent.id });
        }
      },
    };

    this._toolFlight?.delete(agent.id);
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
      // 工具正在跑 → 用更长的静默窗口（但仍受本轮硬上限约束）
      const inFlight = this._toolFlight?.get(agent.id);
      const effTimeout = inFlight ? Math.max(timeoutMs, TOOL_FLIGHT_SILENCE_MS) : timeoutMs;
      if (!this.health.isStalled(agent.id, { timeoutMs: effTimeout })) return;
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

    /**
     * 慢启动提示。
     *
     * 首 token 之前应用里什么都没有，用户看到的就是"卡住了"——而它可能正在
     * 很深地思考。说一句"还在等第一个 token（已 N 秒）"改变不了速度，
     * 但能让人知道系统没死，别去点停止（点了就是这一轮全废）。
     *
     * 只提示一次，且不打断任何东西（这只是个 notice）。
     */
    // 允许测试压缩时间；生产用阈值函数
    const slowStartMs = this.slowStartMs ?? slowStartThreshold(timeoutMs);
    const slowTimer = setTimeout(() => {
      if (sawFirstToken || ac.signal.aborted) return;
      this.onEvent({
        type: 'notice',
        level: 'info',
        agentId: agent.id,
        slowStart: true,
        elapsedMs: slowStartMs,
        text: `${agent.name} 还在等第一个 token（已 ${Math.round(slowStartMs / 1000)} 秒）——它没死，只是还没开始说话`,
      });
    }, slowStartMs);

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
      clearTimeout(slowTimer);
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

    // 写完先对一遍账：正文有没有把"没成功"写成"已完成"（见 _detectFalseClaims）
    if (!aborted && displayBody) this._detectFalseClaims(displayBody, agent.id);

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
    for (const e of errors) {
      // 带目标的错误用真名（`task.update T-008`），这样清单能对上、成功了能清掉；
      // 纯解析失败（JSON 坏了、没有 id）才退回「未识别动作」。
      const label = e.action && e.targetId
        ? `${e.action} ${e.targetId}`
        : (e.action ? e.action : '未识别动作');
      results.push({ ok: false, label, reason: e.reason });
    }
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

    /** timeout 分支已经算过的重试决定；下面复用，避免两次判定分叉 */
    let retryDecided = null;
    const timedOut = adapterResult?.reason === EXIT.TIMEOUT && !aborted;
    if (timedOut) {
      this.store.append({
        kind: 'failure',
        agentId: agent.id,
        taskId: job.taskId ?? null,
        reason: EXIT.TIMEOUT,
        stalled: stalledOut,
        durationMs,
        timeoutMs,
        toolCalls: rowToolsInTurn,
        at: Date.now(),
      }).catch(() => {});
      /**
       * 撞上限但确实在干活 → 系统自己接着做。
       *
       * 判据与"卡死"不同：这里看的是**这一轮有没有在做事**（有工具调用），
       * 不是"有没有产出"。没有工具调用还撞满上限，说明它在空转，不该续做。
       */
      const capContinues = job.capContinue ?? 0;
      const canContinue = !stalledOut && rowToolsInTurn > 0 && capContinues < MAX_CAP_CONTINUES;
      if (canContinue) {
        capAutoContinued = true;
        this._enqueue(agent.id, {
          triggerMsg: {
            id: `cap-continue-${Date.now()}-${agent.id}`,
            senderId: 'system',
            body: '撞到单轮上限，自动续做',
          },
          taskId: job.taskId ?? null,
          source: 'agent',
          kick: true,
          capContinue: capContinues + 1,
        });
        this._clearPause();
        this.onEvent({
          type: 'cap.continue',
          agentId: agent.id,
          attempt: capContinues + 1,
          max: MAX_CAP_CONTINUES,
          toolCalls: rowToolsInTurn,
          // 用 durationMs（实际跑了多久），不是 timeoutMs（配置的上限）
          text: `${agent.name} 跑满上限（实际 ${Math.round(durationMs / 1000)} 秒，`
            + `本轮 ${rowToolsInTurn} 次工具调用），正在干活，自动接着做`
            + `（第 ${capContinues + 1}/${MAX_CAP_CONTINUES} 次）`,
        });
      } else {
        /**
         * ★ 停因必须说真话（管理方在 09:56:13 那条记录上抓到三句假话）。
         *
         * 真实事件：`stalled:true, durationMs:112584, toolCalls:0`，而文案写的是
         * 「跑满 1800 秒…看门狗没有判它卡死…它可能正在干活」——三句全反：
         *   - 1800 是**配置的上限**，实际跑了 112.6 秒；能说"跑了多久"的只有 durationMs
         *   - `stalled:true` 恰恰就是看门狗判的（它把 reason 设成 TIMEOUT，于是走到这里）
         *   - 本轮 0 次工具调用、零输出，最可能是空转，不该说"可能正在干活"
         *
         * 停因说错比不说明更糟：一整天在修"停下却不说明原因"，
         * 结果说明本身是假的，用户会按错的方向去处理。
         */
        const textChars = String(body ?? '').trim().length;
        const didSomething = rowToolsInTurn > 0 || textChars > 0;

        /**
         * ★ 文案里说了「点接着做完」，就必须真的有那个按钮。
         *
         * 管理方 18:42 抓到：timeout/看门狗分支的文案写着"点「接着做完」"，
         * 但只有 interrupted 分支设 `resumeTarget`，于是按钮实际显示「接着推进」，
         * 点下去是叫头头开新轮——**提示里的按钮不存在，点击行为也不是那回事**。
         *
         * 语义上它们本就同类：工作做到一半、会话还在、应当接着那条做。
         * 所以有产出（跑过工具或写过正文）就设 resumeTarget；
         * 纯空转（0 工具 0 输出）没有可续的东西，按钮不出现、文案也不提。
         */
        /**
         * ★ 先算"会不会自动重试"，再决定要不要暂停。
         *
         * 管理方 19:17 的 SSE 时序实测：`room.paused{timeout}` → 同一毫秒 `retry`
         * → `room.resumed` → `turn.start`。于是聊天流里永久留着
         * 「点『接着做完』接着写」，而按钮已经被 turn.start 重置隐藏——
         * **用户被要求点一个 0 秒后就不存在的东西**。
         *
         * 房间根本没停下等人，就不该发暂停原因、也不该设 resumeTarget。
         */
        const timeoutDecision = capAutoContinued
          ? { retry: false, reason: '已安排自动续做' }
          : retryDecision({
            tier: agent.tier,
            reason: EXIT.TIMEOUT,
            attempt: job.attempt ?? 0,
            maxAttempts: this.maxRetries,
            stalled: stalledOut || isStall(adapterResult, durationMs),
            toolCalls: rowToolsInTurn,
          });
        retryDecided = timeoutDecision;
        const willRetry = timeoutDecision.retry;

        if (willRetry) {
          // 系统马上自己接着跑：只说一句，不设暂停原因、不设 resumeTarget
          this.onEvent({
            type: 'notice',
            level: 'info',
            agentId: agent.id,
            text: `${agent.name} 这一轮被中止（耗时 ${Math.round(durationMs / 1000)} 秒），`
              + '系统已自动重试，不需要你操作。',
          });
        } else if (didSomething) {
          this.resumeTarget = {
            agentId: agent.id,
            taskId: job.taskId ?? null,
            at: new Date().toISOString(),
            partialChars: textChars,
            reason: 'timeout',
          };
        }
        // 文案与按钮共用同一个布尔值，两边不可能再分叉
        const canResume = Boolean(this.resumeTarget) && !willRetry;

        if (!willRetry) this._pause('timeout', timeoutPauseText({
          name: agent.name,
          stalledOut,
          durationMs,          // 实际耗时，不是配置上限
          timeoutMs,
          toolCalls: rowToolsInTurn,
          textChars,
          capContinues,
          maxCapContinues: MAX_CAP_CONTINUES,
          stallMs: stallThreshold(timeoutMs),
          canResume,
        }));
      }
    }

    // 3) 失败不回滚但要让界面看见，并记账到熔断器
    if (aborted) {
      // 人为打断不算 agent 的失败，不该计进熔断
      this.health.touch(agent.id);
      /**
       * ★ 打断必须留下「没做完」的痕迹（CR-036 的真实事故）。
       *
       * @li 打断管理员那一轮后，房间静默停了 19 分钟：被中断的活没人接手，
       * `pauseReason` 仍是 null，状态栏一片空白，他只能判断成"卡死"。
       *
       * 打断是"砍掉正在进行的工作"，不是"这件事做完了"。所以：
       *   1. 记下被中断的人，供「接着做完」一键续做；
       *   2. 状态栏写明是谁、哪一轮被中断；
       *   3. 会话仍在，续做不会重做已完成的部分。
       */
      this.resumeTarget = {
        agentId: agent.id,
        taskId: job.taskId ?? null,
        at: new Date().toISOString(),
        partialChars: String(body).length,
      };
      if (this.queue.length === 0) {
        this._pause('interrupted',
          `${agent.name} 的这一轮被打断（已输出 ${String(body).length} 字，未完成）。`
          + '点「接着做完」让它继续——会话还在，不会重做已完成的部分。');
      }
    } else if (adapterResult?.reason === EXIT.COMPLETED) {
      this.resumeTarget = null;
      this.health.success(agent.id);
    } else {
      const reason = adapterResult?.reason ?? 'failed';
      const stalled = stalledOut || isStall(adapterResult, durationMs);

      const tripped = this.health.failure(agent.id, { stall: stalled });
      if (tripped.tripped) this._pause('breaker', `${agent.name} 连续失败，已暂停`);

      /**
       * 看门狗在判死那一刻已经发过一条 failure（带"超过 X 秒没有输出"的具体说明）。
       * 这里再发一条，同一个失败会在界面上显示两次，其中一条还是没有原因的重复。
       * 所以：stalled 的那一轮不再重复 failure，只保留看门狗那条。
       */
      if (!stalledOut) {
        this.onEvent({
          type: 'failure',
          agentId: agent.id,
          reason,
          stalled,
          detail: cleanStderr(adapterResult?.error ?? adapterResult?.stderr ?? ''),
          health: this.health.snapshot(agent.id),
        });
      }

      if (tripped.tripped) {
        this.onEvent({
          type: 'health.tripped',
          agentId: agent.id,
          state: tripped.state,
          cooldownMs: tripped.cooldownMs,
          text: `${agent.name} 连续失败，已暂停；${Math.round(tripped.cooldownMs / 1000)} 秒后自动试探恢复`,
        });
      }

      /**
       * 自动重试。
       *
       * ★ 已经排了 cap-continue 就不能再排一次：那是两条独立路径
       * （撞上限续做 vs 失败重试），同一轮超时会同时满足，
       * 结果这个成员被入队两次、白跑一轮。测试抓到的就是这个。
       */
      const decision = retryDecided ?? (capAutoContinued
        ? { retry: false, reason: '已安排自动续做' }
        : retryDecision({
          tier: agent.tier,
          reason,
          attempt: job.attempt ?? 0,
          maxAttempts: this.maxRetries,
          stalled: stalledOut || isStall(adapterResult, durationMs),
          toolCalls: rowToolsInTurn,
        }));
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

    /**
     * 超时（含被看门狗判死）必须：
     *  1. 落一条 failure 事件（jsonl 里只有 message.status=timeout 时，
     *     重启后无法回答"那次为什么没动静"）
     *  2. 给出 `timeout` 的暂停原因——不能显示成"说完了"
     */
    /**
     * 失败的一轮不进接力。
     *
     * CR-035：失败不是 aborted，所以原来照样走接力，然后被
     * `_pause('no_target')` 覆盖成"说完了"。用户看到的是"它聊完了"，
     * 实际是"它 282 秒、16 次工具调用之后失败了"。
     *
     * 失败时也不该把话往下传：它没产出可交接的内容。
     */
    const failedTurn = !aborted
      && adapterResult?.reason !== EXIT.COMPLETED
      && adapterResult?.reason !== 'interrupted';

    /**
     * 已经决定"自动续做"的轮次，不允许再被写成失败。
     *
     * 两者是不同的判断：失败 = 这轮白跑了；撞上限但自动续做 = 这一轮被打断、
     * 下一轮接着做。如果续做之后还挂一条"本轮失败（timeout）"，状态栏会和
     * 实际状态相反：房间里明明已经有人在接着干，界面却写着失败。
     */
    // 超时已经有更精确的原因了（"跑满 N 秒" vs 泛泛的"失败"），不要覆盖成 error
    if (failedTurn && !job.passive && !capAutoContinued && !timedOut) {
      // 失败也要有原因，且这个原因优先级高于任何"没点名下一位"
      this._pause('error', `${agent.name} 本轮失败（${adapterResult?.reason ?? 'unknown'}）`
        + `，耗时 ${Math.round(durationMs / 1000)} 秒、工具调用 ${rowToolsInTurn} 次。`
        + '没有产出可交接的内容，所以没有把话往下传。');
    }

    // 5) 接力：解析它 @ 了谁
    if (!aborted && !failedTurn) {
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

      /**
       * 派出去的活也算"有人接手"。
       *
       * 如果这一轮创建/改派了任务并且真的入队了，房间就不该停——
       * 否则会出现"任务已经派给人了，房间却显示停住"，用户看到的是
       * 一个待办任务和一个静止的房间，不知道到底有没有人在做。
       */
      const dispatchedAny = results.some((r) => r?.dispatchedTo);

      // 超时的轮次已经有明确原因了，不能再被覆盖成"说完了"（那正是界面撒谎）
      if (!hasAgentTarget && !continued && !job.isSummary && !timedOut && !dispatchedAny) {
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
      if (woken || dispatchedAny) {
        this.waitingForHuman = false;
        this._clearPause();
      }

      // 注意：不在这里发 idle 事件。队列可能还有别人在等（比如人同时 @ 了两位），
      // 真正的「等待人类」由 drain() 在队列跑空时统一发出，避免重复提示。
      if (!hasAgentTarget && !continued && !woken && !dispatchedAny && !this.pauseReason) {
        this.waitingForHuman = true;
      }
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
    /**
     * ★ 例外：这一轮是「派给他的活」。
     *
     * 头头把任务交给他，他干完当然要回话——这时把他排除掉就等于
     * "活干完了没人知道"。所以 dispatched 的轮次允许回叫头头，
     * 但仍然受下面 autoAdvance 的 3 次上限约束，不会变成乒乓。
     */
    const triggerSender = job?.triggerMsg?.senderId ?? null;
    const leaders = this.members.filter((m) => m.role === 'leader'
      && m.id !== agent.id
      && (job?.dispatched || m.id !== triggerSender));
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

      /**
       * ★ 指派 = 交给它做，不只是改一个字段。
       *
       * 实测事故：管理员写 `task.create{assignee:"资料搜集员"}` 且没 @ 任何人，
       * 系统回了 ok 和一句「→ 资料搜集员」，看起来像派出去了 ——
       * 但队列里没有任何人，房间就这么空了 7 分钟，界面上也没有原因。
       *
       * 所以任务创建成功后自动入队被指派人，走正常 enqueue（计入护栏、
       * 去重键用触发消息 id）。这不是"顺手优化"，是让「说派了活」和
       * 「活真的在跑」成为同一件事。
       */
      const dispatched = assignee ? this._dispatchTo(assignee, { taskId: id, by: agent.id }) : null;
      const dispatchNote = dispatched
        ? ''
        : (assignee ? '（但该成员当前不可发言，没派成）' : '');
      if (assignee && !dispatched) {
        this._note(agent.id, `${id} 指派给了 ${assignee}，但对方当前不可发言（被接管/熔断/已停止），任务没有开始。`
          + '请改派或让老板处理。');
      }

      return {
        ok: true,
        label,
        detail: `${id} ${a.title} → ${assignee ?? '未指派'}${where}${dispatchNote}`,
        dispatchedTo: dispatched ? assignee : null,
      };
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
      // ★ 先记下原指派人：updateTask 会就地修改同一个对象，
      // 之后再比较就等于"新值 vs 新值"，永远相等 —— 改派永远不会触发。
      const previousAssignee = targetTask.assignee ?? null;
      await this.store.updateTask(a.id, patch);
      this.onEvent({ type: 'task.updated', id: a.id, patch });

      // 改派给另一个人 = 这次真的叫他开工；改成「完成」不需要
      let dispatchedTo = null;
      if (patch.assignee && patch.assignee !== previousAssignee && patch.status !== '完成') {
        if (this._dispatchTo(patch.assignee, { taskId: a.id, by: agent.id })) {
          dispatchedTo = patch.assignee;
        } else {
          this._note(agent.id, `${a.id} 改派给了 ${patch.assignee}，但对方当前不可发言，任务没有开始。`);
        }
      }
      return { ok: true, label, detail: `${a.id} ${JSON.stringify(patch)}`, dispatchedTo };
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
