/**
 * Codex CLI 适配器。
 *
 * 实测基线：codex-cli 0.167.0
 *  - `codex exec --json` 事件只有 thread.started / turn.started / item.completed / turn.completed
 *    **没有 token 级 delta，无法逐字流式** —— supportsStreaming = false
 *  - `-s read-only` 不可省略，否则 agent 具备默认写权限
 *  - `codex exec resume <id>` 续聊；`--all` 会关掉 cwd 过滤（说明会话是按 cwd 索引的）
 *  - prompt 用 `-` 从 stdin 读
 *  - `codex login status` 不可作为可用性判据（实测报未登录但 exec 正常），probe 必须真跑
 */

import { AgentAdapter, EXIT, withPersona } from './types.js';
import { runJsonCli, DEFAULT_TIMEOUT_MS } from '../core/runner.js';

export class CodexAdapter extends AgentAdapter {
  get supportsStreaming() { return false; }

  constructor(config) {
    super(config);
    // 中间档在 Codex 上无法实现：静默降级成 workspace-write 会意外给出执行权限，
    // 所以这里硬失败，而不是"看起来配了、实际更宽松"。
    if (config.tier === 'write') {
      throw new Error('Codex 不支持「可写本目录」档：workspace-write 会同时允许执行命令。请选 readonly 或 write-exec。');
    }
  }

  /**
   * Codex 只有两档（§6.11）：
   *  - readonly    `-s read-only`（只禁写，允许读）
   *  - write-exec  `-s workspace-write`（一开就同时允许写文件与跑命令）
   * 中间档「可写但不跑命令」**不存在**——`codex features list` 没有单独关 shell 的开关。
   * 调用方必须先查 supportsTier()，不要给用户一个选了不生效的选项。
   */
  #sandboxMode(tier) {
    return tier === 'write' || tier === 'writeExec' || tier === 'write-exec'
      ? 'workspace-write'
      : 'read-only';
  }

  #baseArgs(cwd) {
    return ['exec', '--json', '--skip-git-repo-check', '-s', this.#sandboxMode(this.config.tier), '-C', cwd];
  }

  /**
   * 注意：`codex exec resume` 子命令**不支持** `-s` 与 `-C`（实测 0.167.0），
   * 只能在 resume 上用 `-c sandbox_mode=` 打补丁，cwd 靠 spawn 的 cwd 参数。
   */
  #resumeArgs(sessionId) {
    return [
      'exec', 'resume', '--json', '--skip-git-repo-check',
      '-c', `sandbox_mode=${this.#sandboxMode(this.config.tier)}`, sessionId, '-',
    ];
  }

  async run({ prompt, cwd, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS, onEvent, signal = null }) {
    const args = sessionId
      ? this.#resumeArgs(sessionId)
      : [...this.#baseArgs(cwd), '-'];

    let newSessionId = sessionId ?? null;
    let sawTurnCompleted = false;
    let usage = null;
    const texts = [];

    const res = await runJsonCli({
      command: this.config.bin || 'codex',
      args,
      cwd,
      backend: 'codex',
      signal,
      prompt: withPersona(this.config.persona, prompt),
      timeoutMs,
      onLine: (ev) => {
        switch (ev.type) {
          case 'thread.started':
            newSessionId = ev.thread_id ?? newSessionId;
            onEvent?.({ type: 'meta', sessionId: newSessionId });
            break;
          case 'item.completed': {
            const item = ev.item ?? {};
            if (item.type === 'agent_message' && typeof item.text === 'string') {
              texts.push(item.text);
              // 无 delta：整段一次性下发
              onEvent?.({ type: 'text', text: item.text, done: false });
            } else if (item.type === 'reasoning' && typeof item.text === 'string') {
              onEvent?.({ type: 'thinking', text: item.text });
            }
            break;
          }
          case 'turn.completed':
            sawTurnCompleted = true;
            if (ev.usage) {
              usage = {
                inputTokens: ev.usage.input_tokens ?? 0,
                outputTokens: ev.usage.output_tokens ?? 0,
                cacheReadTokens: ev.usage.cached_input_tokens ?? 0,
                cacheWriteTokens: ev.usage.cache_write_input_tokens ?? 0,
                costUsd: null,
                contextWindow: null,
                reasoningTokens: ev.usage.reasoning_output_tokens ?? 0,
              };
              onEvent?.({ type: 'usage', ...usage });
            }
            break;
          case 'turn.failed':
          case 'error':
            onEvent?.({ type: 'error', message: JSON.stringify(ev).slice(0, 2000) });
            break;
          default:
            break;
        }
      },
    });

    onEvent?.({ type: 'text', text: '', done: true });

    let reason;
    if (res.timedOut) reason = EXIT.TIMEOUT;
    else if (sawTurnCompleted && res.code === 0) reason = EXIT.COMPLETED;
    else if (res.spawnError) reason = EXIT.CRASHED;
    else reason = EXIT.FAILED;

    if (reason !== EXIT.COMPLETED && texts.length === 0) {
      onEvent?.({ type: 'error', message: res.stderr.trim().slice(0, 2000) || 'codex 未产出内容' });
    }
    onEvent?.({ type: 'done', ok: reason === EXIT.COMPLETED, reason });

    return { sessionId: newSessionId, text: texts.join('\n'), usage, reason, stderr: res.stderr };
  }

  async probe(cwd, timeoutMs = 30_000) {
    const res = await runJsonCli({
      command: this.config.bin || 'codex',
      args: [...this.#baseArgs(cwd), '-'],
      cwd,
      backend: 'codex',
      prompt: 'Reply with exactly: OK',
      timeoutMs,
    });
    const ok = res.lines.some((l) => l.type === 'turn.completed');
    if (res.timedOut) return { ok: false, reason: '探测超时' };
    if (ok) {
      const started = res.lines.find((l) => l.type === 'thread.started');
      return { ok: true, sessionId: started?.thread_id ?? null };
    }
    return { ok: false, reason: res.stderr.trim().slice(0, 500) || '探测失败' };
  }
}
