/**
 * 统一适配器接口与事件模型（需求 §6.1）。
 *
 * 事件类型：
 *   {type:'meta',  sessionId}                     本轮/会话标识
 *   {type:'text',  text, done:boolean}            正文增量（done=true 表示该段结束）
 *   {type:'usage', inputTokens, outputTokens, ...} 用量（只展示不拦截）
 *   {type:'done',  ok, reason}                    reason: completed|failed|timeout|crashed
 *   {type:'error', message}
 */

export const EXIT = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CRASHED: 'crashed',
};

/**
 * @typedef {object} AdapterRunInput
 * @property {string} prompt
 * @property {string} cwd
 * @property {string|null} sessionId
 * @property {number} [timeoutMs]
 */

export class AgentAdapter {
  /** @param {{id:string, backend:string, model?:string, persona?:string, bin?:string}} config */
  constructor(config) {
    this.config = config;
  }
  get backend() { return this.config.backend; }
  /** 是否支持逐字流式（Codex 为 false） */
  get supportsStreaming() { return true; }
  /** @param {AdapterRunInput} _input */
  async run(_input) { throw new Error('not implemented'); }
  /** 真实探测：能否正常跑一轮（不依赖 login status） */
  async probe(_cwd) { throw new Error('not implemented'); }
}

/** 把 persona 拼到 prompt 前面——CLI 没有 system prompt 参数时用这个兜底 */
export function withPersona(persona, prompt) {
  if (!persona) return prompt;
  return [
    '[角色设定]',
    persona,
    '[/角色设定]',
    '',
    prompt,
  ].join('\n');
}
