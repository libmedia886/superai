/**
 * 自动推进护栏（continue 动作）。
 *
 * 背景：房间默认"没人 @ 就停住"，这是为了防止两个 AI 互相吹捧一晚上。
 * 但有些任务确实需要连续推进（"这一步做完接着做下一步"），
 * 所以给 agent 一个**显式**手段：`{"action":"continue","reason":"..."}`。
 *
 * 三条约束：
 *  1. 必须带 reason —— 没理由的 continue 就是变相的无条件接龙
 *  2. 按 roster 顺序派给**一个人**，不是全员广播
 *  3. **连续 3 次就停** —— 人说话会重置计数
 *
 * 为什么计数要按"人类最后一条消息"重置：连续 continue 的本质是
 * "agent 在没有人类介入的情况下自己往前推"，所以只有人类说话才算打断这个链条。
 */

export const DEFAULT_MAX_CONTINUOUS = 3;

export class AutoAdvanceGuard {
  constructor({ maxContinuous = DEFAULT_MAX_CONTINUOUS } = {}) {
    this.maxContinuous = maxContinuous;
    this.reset();
  }

  /** 人类发言或任务完成时归零 */
  reset() {
    this.count = 0;
    this.lastReason = null;
    this.history = [];
  }

  /**
   * 记录一次 continue 声明。
   * @param {string} agentId
   * @param {string} reason
   * @returns {{ok:boolean, detail?:string, reason?:string, count:number}}
   */
  note(agentId, reason) {
    if (this.count >= this.maxContinuous) {
      return {
        ok: false,
        count: this.count,
        reason: `已连续自动推进 ${this.count} 次（上限 ${this.maxContinuous}），`
          + '房间停住等你确认。要不要继续请直接说一句。',
      };
    }

    this.count += 1;
    this.lastReason = reason;
    this.history.push({ agentId, reason, at: Date.now() });

    return {
      ok: true,
      count: this.count,
      detail: `自动推进 ${this.count}/${this.maxContinuous}：${reason}`,
    };
  }

  get remaining() {
    return Math.max(0, this.maxContinuous - this.count);
  }
}
