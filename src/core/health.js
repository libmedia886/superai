/**
 * 卡死检测（CR-007）与熔断半开。
 *
 * 为什么我们比 claudelink 好做：进程是我们 spawn 的，pid、管道、退出码都在手里，
 * 不需要去猜"终端里显示了什么"。
 *
 * 四类可检测的异常（都不需要新机制）：
 *  1. **静默超时** —— 进程活着但长时间没有新输出。真卡死就长这样，最有价值。
 *  2. **无响应退出** —— 进程已退出，但没收到 done 事件。
 *  3. **硬超时** —— 超过单轮上限仍在跑（runner 里 kill）。
 *  4. **连续失败** —— 同一 agent 连续 N 次失败。
 *
 * 熔断三态（**没有半开就永久停住**，这是管理方点名要补的）：
 *   CLOSED    正常
 *   OPEN      失败太多，暂停该 agent
 *   HALF_OPEN 冷却结束，放一个探针任务过去；成功则恢复，失败则再次 OPEN 且冷却加倍
 */

export const STATE = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' };

/** 静默多久算卡死。取单轮超时的 1/3，但不能低于 20 秒 */
/**
 * 卡死阈值：多久没有任何输出就判定"死了"。
 *
 * ★ 和硬上限**解耦**。以前它是 `timeoutMs / 3`，于是把硬上限从 180 秒
 * 放宽到 20 分钟时，卡死判定会跟着变成 400 秒——那等于把看门狗也关了一半：
 * 一个真的挂住的进程要烧 400 秒才被杀。
 *
 * 现在的规则：硬上限只防"无限跑"；"死没死"由这个固定窗口判断。
 * 默认 90 秒无任何输出（含 thinking/tool 事件）即判死。
 * 保留 timeoutMs 参数是为了兼容按成员配置的短上限（不会超过上限的一半）。
 */
export const STALL_MS = 90_000;

export function stallThreshold(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return STALL_MS;
  // 上限很短时（比如测试里 30 秒），窗口不能比上限还长，否则永远等不到判定
  return Math.max(20_000, Math.min(STALL_MS, Math.floor(timeoutMs / 2)));
}

export class HealthTracker {
  constructor({
    failureThreshold = 3,
    cooldownMs = 60_000,
    maxCooldownMs = 30 * 60_000,
  } = {}) {
    this.failureThreshold = failureThreshold;
    this.baseCooldownMs = cooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.agents = new Map();  // agentId -> state
  }

  #get(agentId) {
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, {
        state: STATE.CLOSED,
        failures: 0,
        openedAt: 0,
        cooldownMs: this.baseCooldownMs,
        lastOkAt: 0,
        lastActivityAt: 0,
        stallCount: 0,
      });
    }
    return this.agents.get(agentId);
  }

  /** 能否让这个 agent 发言？半开状态允许一次探针 */
  canRun(agentId, now = Date.now()) {
    const a = this.#get(agentId);
    if (a.state === STATE.CLOSED) return { ok: true };

    if (a.state === STATE.OPEN) {
      if (now - a.openedAt >= a.cooldownMs) {
        a.state = STATE.HALF_OPEN;
        return { ok: true, probe: true, reason: '熔断冷却结束，本次为试探性调用' };
      }
      return {
        ok: false,
        reason: `已暂停（连续失败 ${a.failures} 次），${Math.ceil((a.cooldownMs - (now - a.openedAt)) / 1000)} 秒后自动试探`,
      };
    }

    // HALF_OPEN：只放一个探针（调用方串行执行，天然只有一个）
    return { ok: true, probe: true, reason: '熔断半开，试探性调用' };
  }

  /** 记录活动（有输出就说明没卡死） */
  touch(agentId, now = Date.now()) {
    this.#get(agentId).lastActivityAt = now;
  }

  /** 记录成功 */
  success(agentId, now = Date.now()) {
    const a = this.#get(agentId);
    a.state = STATE.CLOSED;
    a.failures = 0;
    a.cooldownMs = this.baseCooldownMs;  // 恢复正常后冷却重置
    a.lastOkAt = now;
    a.lastActivityAt = now;
  }

  /**
   * 记录失败。
   * @param {string} agentId
   * @param {object} o
   * @param {boolean} [o.stall] 是否是静默卡死（这类更容易是环境问题，计数更快）
   */
  failure(agentId, { stall = false, now = Date.now() } = {}) {
    const a = this.#get(agentId);
    a.failures += 1;
    if (stall) a.stallCount += 1;

    if (a.state === STATE.HALF_OPEN) {
      // 探针失败：立即重新熔断，且冷却加倍（避免反复试探打扰）
      a.state = STATE.OPEN;
      a.openedAt = now;
      a.cooldownMs = Math.min(a.cooldownMs * 2, this.maxCooldownMs);
      return { tripped: true, state: a.state, cooldownMs: a.cooldownMs };
    }

    if (a.failures >= this.failureThreshold) {
      a.state = STATE.OPEN;
      a.openedAt = now;
      return { tripped: true, state: a.state, cooldownMs: a.cooldownMs };
    }

    return { tripped: false, state: a.state };
  }

  /**
   * 是否卡死：进程还活着、但从上次活动到现在超过阈值。
   * @param {string} agentId
   * @param {{timeoutMs:number, now?:number}} o
   */
  isStalled(agentId, { timeoutMs, now = Date.now() }) {
    const a = this.#get(agentId);
    if (!a.lastActivityAt) return false;
    return now - a.lastActivityAt >= stallThreshold(timeoutMs);
  }

  snapshot(agentId) {
    return { ...this.#get(agentId) };
  }

  all() {
    return [...this.agents.entries()].map(([id, s]) => ({ agentId: id, ...s }));
  }
}

/**
 * 自动重试策略。
 *
 * ★ 只允许只读档自动重试。
 * 可写及以上一律标红等人——重试意味着重发同一轮 prompt，而那一轮可能已经
 * 改了文件、提交了 git、发了请求、动了数据库。重复执行这些是不可接受的。
 */
export function canAutoRetry(tier) {
  return tier === 'readonly';
}

/** 重试决策与原因（供界面显示） */
export function retryDecision({ tier, reason, attempt = 0, maxAttempts = 2 }) {
  if (!canAutoRetry(tier)) {
    return {
      retry: false,
      reason: tier === 'readonly'
        ? '已达重试上限'
        : `该 agent 权限为「${tierLabel(tier)}」，失败后不自动重试（可能已产生副作用），请人工确认`,
    };
  }
  if (attempt >= maxAttempts) return { retry: false, reason: '已达重试上限' };
  // 超时和崩溃可以重试；业务失败（模型明确拒绝/报错）重试意义不大
  if (reason === 'failed') return { retry: false, reason: '业务失败，重试通常无效' };
  return { retry: true, reason: `自动重试第 ${attempt + 1} 次` };
}

function tierLabel(tier) {
  return { readonly: '只读', write: '可写', 'write-exec': '可写+执行' }[tier] ?? tier;
}
