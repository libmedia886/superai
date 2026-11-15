/**
 * 循环护栏（CR-008）。
 *
 * 三个维度缺一不可，各防一类死循环：
 *  1. 连续次数 —— 防一个人自说自话（A→A→A）
 *  2. 链深度   —— 防一群人轮流转圈（A→B→C→A→B→C，谁都没连续，但永不停）
 *  3. 总发言数 —— 防广播时人多导致的长链
 *
 * P0 只提示、不拦截（人定的：不设硬闸）。所以这里只做判定 + 给出可读原因。
 * 所有计数以「人类最后一条消息」为原点重置——人说话就是新任务开始。
 */

export const THRESHOLDS = {
  consecutive: 5,     // 同一 agent 连续发言次数
  chainDepth: 8,      // 从人类最后一条消息起，agent 之间接力的层数
  totalTurns: 20,     // 自人类最后一条消息起累计发言数
  minGapMs: 30_000,   // 两次发言间隔小于这个值，视为"过于密集"（辅助信号）
};

export class LoopGuard {
  constructor(thresholds = {}) {
    this.t = { ...THRESHOLDS, ...thresholds };
    this.reset();
  }

  /** 人类发言：新任务开始，全部归零 */
  reset() {
    this.lastSpeaker = null;
    this.consecutive = 0;
    this.chainDepth = 0;
    this.totalTurns = 0;
    this.lastAt = 0;
    this._reported = new Set();  // 同一原因只提示一次，避免刷屏
  }

  /**
   * 记录一次发言，返回应当提示的原因（数组，可能为空）。
   * @param {{agentId:string, at?:number}} info
   */
  record({ agentId, at = Date.now() }) {
    const reasons = [];

    if (this.lastSpeaker === agentId) {
      this.consecutive += 1;
    } else {
      this.consecutive = 1;
      // 换人了：链深度 +1（同一人的连续发言不再加深链条）
      this.chainDepth += 1;
    }
    this.totalTurns += 1;

    const gap = this.lastAt ? at - this.lastAt : Infinity;
    this.lastSpeaker = agentId;
    this.lastAt = at;

    if (this.consecutive >= this.t.consecutive) {
      reasons.push({
        kind: 'consecutive',
        text: `${agentId} 已连续发言 ${this.consecutive} 次，可能在自己跟自己绕`,
      });
    }

    if (this.chainDepth >= this.t.chainDepth) {
      reasons.push({
        kind: 'chain',
        text: `自你上次发言起已接力 ${this.chainDepth} 层，可能在互相转圈`,
      });
    }

    if (this.totalTurns >= this.t.totalTurns) {
      reasons.push({
        kind: 'total',
        text: `自你上次发言起已累计 ${this.totalTurns} 条发言`,
      });
    }

    // 辅助信号：极密集的往复（不单独触发，配合前三个一起看更可信）
    if (gap < this.t.minGapMs && this.consecutive >= 3) {
      reasons.push({
        kind: 'rapid',
        text: `连续快速往复（间隔 ${(gap / 1000).toFixed(1)}s）`,
      });
    }

    // 同一原因只报一次
    return reasons.filter((r) => {
      if (this._reported.has(r.kind)) return false;
      this._reported.add(r.kind);
      return true;
    });
  }

  /** 当前状态（界面展示用） */
  snapshot() {
    return {
      consecutive: this.consecutive,
      chainDepth: this.chainDepth,
      totalTurns: this.totalTurns,
      thresholds: { ...this.t },
    };
  }
}
