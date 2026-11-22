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
import { modelArgs, effortArgs } from '../core/extraargs.js';

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

  /**
   * 模型 / 思考等级：**两条路径都用 `-c`**。
   *
   * `codex exec resume` 不认 `-m`（实测 0.167.0 只有 -c/--json/--last/--all/-i），
   * 首轮如果改用 `-m`，就会出现"首轮生效、第二轮丢了"这种最难查的半生效状态。
   * 所以首轮也用 `-c`，保证两条路径参数一致。
   *
   * 留空 = 一个参数都不传：本机 codex 指向自家配置（~/.codex/config.toml
   * 里有 model / model_provider），硬塞默认值会直接把它弄坏。
   */
  #modelEffortArgs() {
    return [
      ...modelArgs('codex', this.config.model),
      ...effortArgs('codex', this.config.effort),
    ];
  }

  #baseArgs(cwd) {
    return [
      'exec', '--json', '--skip-git-repo-check',
      '-s', this.#sandboxMode(this.config.tier), '-C', cwd,
      // 共享目录：只读档不加（read-only 沙箱下加了也写不了，只会误导）
      ...(this.config.sharedDir && this.config.tier === 'write-exec'
        ? ['--add-dir', this.config.sharedDir] : []),
      ...this.#modelEffortArgs(),
      ...(this.config.extraArgs ?? []),
    ];
  }

  /**
   * 注意：`codex exec resume` 子命令**不支持** `-s` 与 `-C`（实测 0.167.0），
   * 只能在 resume 上用 `-c sandbox_mode=` 打补丁，cwd 靠 spawn 的 cwd 参数。
   */
  #resumeArgs(sessionId) {
    return [
      'exec', 'resume', '--json', '--skip-git-repo-check',
      '-c', `sandbox_mode=${this.#sandboxMode(this.config.tier)}`,
      ...this.#modelEffortArgs(),
      ...(this.config.extraArgs ?? []),
      sessionId, '-',
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
    const seenToolItems = new Set();

    const emitToolItem = (item) => {
      const t = item?.type;
      if (!t || t === 'agent_message' || t === 'reasoning') return false;
      if (t === 'command_execution') {
        const command = item.command ?? null;
        onEvent?.({
          type: 'tool',
          tool: 'Bash',
          path: null,
          command,
          detail: command ? String(command).slice(0, 300) : '',
        });
        return true;
      }
      if (t === 'file_change') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const firstPath = changes[0]?.path ?? item.path ?? null;
        const summary = changes.length > 1
          ? `${firstPath ?? ''} 等 ${changes.length} 个文件`
          : (firstPath ?? '');
        onEvent?.({
          type: 'tool',
          tool: 'Edit',
          path: firstPath,
          command: null,
          detail: summary,
        });
        return true;
      }
      if (t === 'mcp_tool_call' || t === 'web_search' || t === 'tool_call') {
        const name = item.tool ?? item.name ?? t;
        onEvent?.({
          type: 'tool',
          tool: name,
          path: item.path ?? null,
          command: item.query ?? item.command ?? null,
          detail: String(item.query ?? item.tool ?? item.name ?? t).slice(0, 300),
        });
        return true;
      }
      return false;
    };

    const res = await runJsonCli({
      command: this.config.bin || 'codex',
      args,
      cwd,
      backend: 'codex',
      // 数据目录下的任何条目都不能出现在子进程 PATH 里（成员可写 → 可劫持命令）
      forbiddenRoots: this.config.forbiddenRoots ?? [],
      signal,
      prompt: withPersona(this.config.persona, prompt),
      timeoutMs,
      onLine: (ev) => {
        // 任何一行输出都算活着（工具执行期间可能很久没有正文）
        onEvent?.({ type: 'activity' });
        switch (ev.type) {
          case 'thread.started':
            newSessionId = ev.thread_id ?? newSessionId;
            onEvent?.({ type: 'meta', sessionId: newSessionId });
            break;
          case 'item.started': {
            const item = ev.item ?? {};
            if (emitToolItem(item) && item.id) seenToolItems.add(item.id);
            break;
          }
          case 'item.completed': {
            const item = ev.item ?? {};
            if (item.type === 'agent_message' && typeof item.text === 'string') {
              texts.push(item.text);
              // 无 delta：整段一次性下发
              onEvent?.({ type: 'text', text: item.text, done: false });
            } else if (item.type === 'reasoning' && typeof item.text === 'string') {
              onEvent?.({ type: 'thinking', text: item.text });
            } else {
              const alreadyEmitted = item.id && seenToolItems.has(item.id);
              const isTool = alreadyEmitted || emitToolItem(item);
              if (isTool) onEvent?.({ type: 'tool.result' });
            }
            break;
          }
          case 'turn.completed':
            onEvent?.({ type: 'tool.result' });
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
            onEvent?.({ type: 'tool.result' });
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
      forbiddenRoots: this.config.forbiddenRoots ?? [],
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
