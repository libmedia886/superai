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
  /**
   * 连续多少轮"什么都没推进"才算空转。
   *
   * ★ 这是比"发言人轮换/间隔过密"更可信的信号（管理方 20:41 提出）：
   * 真实协作里 8 个人高强度往返完全正常，但**如果连续几轮下来
   * 没有新任务、没有任务状态变化、没有工具调用、没有新结论**，
   * 那才是真的在原地打转。
   * 光看轮次和间隔会把"认真干活"误判成"转圈"——
   * 误报的代价是以后没人信这个警告。
   */
  noProgressTurns: 3,
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
    /** 连续"没有任何推进"的轮数（见 noteProgress） */
    this.noProgressStreak = 0;
  }

  /**
   * 记录一轮**推进了多少**。
   *
   * 与 `record()` 分开，因为它们是两件事：record 记"谁说了话"，
   * 这个记"说的话有没有产生效果"。空转判据只看后者。
   *
   * @param {object} o
   * @param {number} [o.actions]     本轮成功执行的动作数（建任务/改状态/改职责…）
   * @param {number} [o.toolCalls]   本轮工具调用数
   *
   * ★ 判据**只有结构化事实**。曾经还有一个 `newConclusion`（按正文字数判断），
   *   已被实测否决：它要防的恰恰是"几百字长文反复说同一件事"，
   *   而"有长文就算推进"正好把这个场景清零——**功能存在、被调用、永远不响**。
   *
   *   换成文本相似度也不行。实测三种真实形态：
   *     · 原文 + 新增一行      → 0.886
   *     · 同一件事换个说法复述 → 0.648   ← 真实卡住的样子
   *     · 真正的新发现         → 0.068
   *   **改写复述比"加一行"还低**，任何单一阈值都必然要么漏掉复述、要么误杀小增量。
   *   文本不是可靠信号。
   *
   * 传了已移除的 `newConclusion` 也不影响判定（见测试）。
   * 文字重复由 `_detectLoop` 里独立的 `similar` 分支提示，两者互不替代。
   *
   * @returns {{reason:object|null, streak:number}}
   */
  noteProgress({ actions = 0, toolCalls = 0 } = {}) {
    const progressed = actions > 0 || toolCalls > 0;
    this.noProgressStreak = progressed ? 0 : this.noProgressStreak + 1;

    if (this.noProgressStreak >= this.t.noProgressTurns && !this._reported.has('no-progress')) {
      this._reported.add('no-progress');
      return {
        streak: this.noProgressStreak,
        reason: {
          kind: 'no-progress',
          text: `已连续 ${this.noProgressStreak} 轮没有任何推进`
            + '（没有新任务、没有状态变化、没有工具调用）——这比"轮数多"更能说明在原地打转',
        },
      };
    }
    return { streak: this.noProgressStreak, reason: null };
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

    /**
     * 辅助信号：极密集的往复。
     *
     * ★ 管理方实测过它的误报：真实房间里 8 次 agent 发言、间隔 10.4 秒、
     * 链深 8 —— 那是正常的高强度协作，不是转圈。所以它**不单独成立**，
     * 只在"同时没有任何推进"时才算（见 noteProgress 的 no-progress）。
     */
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
