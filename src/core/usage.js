/**
 * 用量异常提示（P1）：**只提示，不拦截**。
 *
 * 老板明确说过"不用考虑 token 消耗"，所以这里不做任何限制——
 * 目的是让他知道钱花在哪了，不是替他做决定。
 *
 * 三条设计约束：
 *  1. **基线用中位数，不用平均值**。均值被单个尖峰拉高后就再也触发不了了；
 *     中位数抗离群值，能一直反映"这个 agent 平时花多少"。
 *  2. **不按绝对值判断**。不同模型、不同上下文长度差异太大，
 *     "5 万 token"对一个 agent 是常态、对另一个是异常。
 *  3. **不刷屏**。同一个 agent 在冷却期内只提示一次——
 *     反复提示会变成"狼来了"，和循环提示一个下场。
 */

export const DEFAULTS = {
  /** 单轮超过中位数的几倍算异常 */
  spikeRatio: 3,
  /** 房间累计在窗口内增长超过基线几倍算异常 */
  surgeRatio: 3,
  /** 建立基线至少要几轮（样本太少时中位数没意义） */
  minSamples: 3,
  /** 同一个 agent 的提示冷却期 */
  cooldownMs: 10 * 60_000,
  /** 房间累计增幅的观察窗口 */
  windowMs: 5 * 60_000,
};

export function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export class UsageWatcher {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.byAgent = new Map();   // agentId -> number[]
    this.lastWarned = new Map();// agentId -> 时间戳
    this.roomEvents = [];       // [{at, tokens}]
    this.lastRoomWarned = 0;
  }

  /**
   * 记录一轮用量，返回需要提示的内容（null = 不提示）。
   *
   * @param {object} o
   * @param {string} o.agentId
   * @param {number} o.tokens
   * @param {number} [o.now]
   * @returns {null | {kind:'spike'|'surge', text:string, ...}}
   */
  record({ agentId, tokens, now = Date.now() }) {
    if (!Number.isFinite(tokens) || tokens <= 0) return null;

    const history = this.byAgent.get(agentId) ?? [];
    const base = median(history);
    const hasBaseline = history.length >= this.o.minSamples;

    // 先记房间趋势（无论是否提示都要记，否则窗口统计会断）。
    // **保留两个窗口**：要拿"最近一个窗口"和"再往前一个窗口"比。
    // 只留一个窗口的话，对比基线永远为空，这个检测形同虚设。
    this.roomEvents.push({ at: now, tokens });
    this.roomEvents = this.roomEvents.filter((e) => now - e.at <= this.o.windowMs * 2);

    // 再把这轮加进该 agent 的历史（留最近 20 轮，避免无限增长）
    history.push(tokens);
    if (history.length > 20) history.shift();
    this.byAgent.set(agentId, history);

    // ---- 单轮异常 ----
    if (hasBaseline && base > 0 && tokens >= base * this.o.spikeRatio) {
      const last = this.lastWarned.get(agentId) ?? 0;
      if (now - last >= this.o.cooldownMs) {
        this.lastWarned.set(agentId, now);
        return {
          kind: 'spike',
          agentId,
          tokens,
          baseline: base,
          ratio: tokens / base,
          text: `${agentId} 这轮用了 ${fmt(tokens)} token，是它平时（中位数 ${fmt(base)}）的 ${(tokens / base).toFixed(1)} 倍`,
        };
      }
      return null;   // 冷却期内，不重复提示
    }

    // ---- 房间累计增长过快 ----
    // 比较"最近一个窗口"和"再往前同样的窗口"
    const roomWarn = this._checkSurge(now);
    if (roomWarn) return roomWarn;

    return null;
  }

  /**
   * 房间累计激增。
   *
   * 判据是**「最近一个窗口内的累计」vs「再往前同样长度窗口内的累计」**。
   *
   * 不能用"单轮中位数 × 轮数"当期望值：那个数只跟轮数有关，
   * 轮数一多它就跟着涨，永远追不上实际值——测不出来。
   * 而"过去同样长的时间里花了多少"才真正反映节奏变化。
   */
  _checkSurge(now) {
    if (now - this.lastRoomWarned < this.o.cooldownMs) return null;

    const win = this.o.windowMs;
    const recent = this.roomEvents.filter((e) => now - e.at <= win);
    const previous = this.roomEvents.filter((e) => {
      const age = now - e.at;
      return age > win && age <= win * 2;
    });
    if (recent.length < 2 || previous.length < 1) return null;

    const recentSum = recent.reduce((s, e) => s + e.tokens, 0);
    const previousSum = previous.reduce((s, e) => s + e.tokens, 0);
    if (previousSum <= 0) return null;

    if (recentSum >= previousSum * this.o.surgeRatio) {
      this.lastRoomWarned = now;
      return {
        kind: 'surge',
        windowMs: win,
        total: recentSum,
        expected: previousSum,
        ratio: recentSum / previousSum,
        text: `最近 ${Math.round(win / 60_000)} 分钟累计 ${fmt(recentSum)} token，`
          + `是此前同样时长的 ${(recentSum / previousSum).toFixed(1)} 倍`,
      };
    }
    return null;
  }

  /** 人类发言或任务完成时可以清空房间趋势，让提示不跨话题 */
  resetRoom() {
    this.roomEvents = [];
  }

  snapshot(agentId) {
    const h = this.byAgent.get(agentId) ?? [];
    return { samples: h.length, median: median(h), lastWarned: this.lastWarned.get(agentId) ?? null };
  }
}

function fmt(n) {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
