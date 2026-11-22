/**
 * Antigravity CLI (`agy`) 适配器。
 *
 * 实测基线：agy 1.5.14
 *  - `--output-format stream-json` 输出 NDJSON，含 `init` / `step_update` / `result` 事件，
 *    `agent_response` 带 token 级 `text_delta` / `thinking_delta`，支持逐字流式（supportsStreaming = true）
 *  - 权限档位映射：
 *    - `full`       → `--dangerously-skip-permissions`（免审批、完全开放）
 *    - `write-exec` → `--mode auto`（可写且自动执行）
 *    - `write`      → `--mode accept-edits`（自动批准编辑）
 *    - `read`       → `--mode plan`（只读规划，不执行修改）
 *  - ★ 实测 `--mode plan` 与 `--disable-slash-commands` 同传时会发出警告并使 plan 无效，
 *    因此只读（read / readonly）档不传 `--disable-slash-commands`，其余档位传。
 *  - ★ prompt 必须通过 `-p <promptText>` 放在所有其它参数之后传递：实测 `-p -` 会把 `-` 当字面文本，
 *    不读 stdin。超过 96 KB 的超长 prompt 落盘到临时文件并在 finally 中清理，避免撞 ARG_MAX。
 */

import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentAdapter, EXIT, withPersona } from './types.js';
import { runJsonCli, DEFAULT_TIMEOUT_MS } from '../core/runner.js';
import { modelArgs, effortArgs } from '../core/extraargs.js';

/** 超过该字节数的 prompt 走临时文件投递，避免撞操作系统命令行参数长度上限 */
export const MAX_INLINE_PROMPT_BYTES = 96_000;

/** 权限档位 → agy CLI 参数 */
export function agyTierArgs(tier = 'read') {
  if (tier === 'full') return ['--dangerously-skip-permissions'];
  if (tier === 'write-exec' || tier === 'writeExec') return ['--mode', 'auto'];
  if (tier === 'write') return ['--mode', 'accept-edits'];
  // read / readonly / 默认 → plan 模式（只读规划）
  return ['--mode', 'plan'];
}

export class AgyAdapter extends AgentAdapter {
  get supportsStreaming() { return true; }

  /**
   * 参数顺序：输出协议 → 档位参数 → (非只读时禁斜杠命令) → 模型/思考等级 → 会话 → 共享目录 → 附加参数 → `-p <prompt>`。
   *
   * 附加参数放在 `-p` 之前、应用默认参数之后，既保留"后者优先"的 CLI 语义，
   * 又确保 `-p` 后的 prompt 不会被误解析为其他 flag 的值。
   */
  buildArgs({ sessionId = null, prompt = null } = {}) {
    const tier = this.config.tier ?? 'read';
    const args = [
      '--output-format', 'stream-json',
      ...agyTierArgs(tier),
    ];

    // 实测 `--mode plan` 配合 `--disable-slash-commands` 会告警并导致 plan 模式不生效
    if (tier !== 'read' && tier !== 'readonly') {
      args.push('--disable-slash-commands');
    }

    args.push(
      ...modelArgs('agy', this.config.model),
      ...effortArgs('agy', this.config.effort),
    );

    if (sessionId) args.push('--conversation', sessionId);
    if (this.config.sharedDir) args.push('--add-dir', this.config.sharedDir);
    args.push(...(this.config.extraArgs ?? []));

    if (prompt != null) args.push('-p', String(prompt));
    return args;
  }

  async run({ prompt, cwd, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS, onEvent, signal = null }) {
    const fullPrompt = withPersona(this.config.persona, prompt ?? '');
    let promptArg = fullPrompt;
    let tmpPromptPath = null;

    if (Buffer.byteLength(fullPrompt, 'utf8') > MAX_INLINE_PROMPT_BYTES) {
      const name = `.agy-prompt-${randomBytes(6).toString('hex')}.txt`;
      try {
        await mkdir(cwd, { recursive: true });
        tmpPromptPath = join(cwd, name);
        await writeFile(tmpPromptPath, fullPrompt, 'utf8');
      } catch {
        // cwd 不可写时回退到系统临时目录
        tmpPromptPath = join(tmpdir(), name);
        await writeFile(tmpPromptPath, fullPrompt, 'utf8');
      }
      promptArg = `请读取并严格按此文件中的完整指令执行：${tmpPromptPath}`;
    }

    const args = this.buildArgs({ sessionId, prompt: promptArg });

    let newSessionId = sessionId ?? null;
    let sawResult = false;
    let resultOk = false;
    let usage = null;
    let lastError = null;
    let text = '';
    const seenStepIndexes = new Set();

    try {
      const res = await runJsonCli({
        command: this.config.bin || 'agy',
        args,
        cwd,
        backend: 'agy',
        // 数据目录下的任何条目都不能出现在子进程 PATH 里（成员可写 → 可劫持命令）
        forbiddenRoots: this.config.forbiddenRoots ?? [],
        signal,
        // agy 通过 `-p` 接收指令，stdin 传空串并立即关闭，避免子进程阻塞等待 EOF
        prompt: '',
        timeoutMs,
        onLine: (ev) => {
          // 任何一行 NDJSON 都算进程存活，刷新看门狗
          onEvent?.({ type: 'activity' });

          if (ev.event === 'init') {
            if (ev.conversation_id) {
              newSessionId = ev.conversation_id;
              onEvent?.({ type: 'meta', sessionId: newSessionId });
            }
            return;
          }

          if (ev.event === 'step_update') {
            const su = ev.step_update ?? {};
            if (su.conversation_id && !newSessionId) {
              newSessionId = su.conversation_id;
              onEvent?.({ type: 'meta', sessionId: newSessionId });
            }

            if (su.step_type === 'agent_response') {
              const thought = su.thinking_delta || su.thought_delta;
              if (thought) {
                onEvent?.({ type: 'thinking', text: thought });
              }
              if (su.text_delta) {
                text += su.text_delta;
                onEvent?.({ type: 'text', text: su.text_delta, done: false });
              }
              return;
            }

            if (su.step_type === 'tool') {
              const hasIdx = su.step_index !== undefined && su.step_index !== null;
              // 同一 step_index 会依次收到 ACTIVE 和 DONE，只记一次工具调用，避免重复计数
              if (!hasIdx || !seenStepIndexes.has(su.step_index)) {
                if (hasIdx) seenStepIndexes.add(su.step_index);
                const toolName = su.tool_name ?? su.tool_info?.name ?? 'unknown';
                const params = su.tool_info?.parameters ?? {};
                const filePath = params.Path ?? params.TargetFile ?? params.AbsolutePath
                  ?? params.DirectoryPath ?? params.path ?? params.file_path ?? null;
                const command = params.CommandLine ?? params.command ?? params.Url ?? params.query ?? null;
                const detail = command
                  ? String(command).slice(0, 300)
                  : (filePath ? String(filePath) : toolName);
                onEvent?.({
                  type: 'tool',
                  tool: toolName,
                  path: filePath,
                  command,
                  detail,
                });
              }
              if (su.state === 'DONE' || su.state === 'ERROR' || su.state === 'FAILED') {
                onEvent?.({ type: 'tool.result' });
              }
              return;
            }
            return;
          }

          if (ev.event === 'result') {
            const r = ev.result ?? {};
            onEvent?.({ type: 'tool.result' });
            sawResult = true;
            resultOk = r.status === 'SUCCESS';
            if (r.conversation_id) {
              const changed = r.conversation_id !== newSessionId;
              newSessionId = r.conversation_id;
              if (changed) onEvent?.({ type: 'meta', sessionId: newSessionId });
            }
            if (r.usage) {
              usage = {
                inputTokens: r.usage.input_tokens ?? 0,
                outputTokens: r.usage.output_tokens ?? 0,
                cacheReadTokens: r.usage.cache_read_tokens ?? 0,
                cacheWriteTokens: 0,
                reasoningTokens: r.usage.thinking_tokens ?? 0,
                costUsd: null,
                contextWindow: null,
              };
              onEvent?.({ type: 'usage', ...usage });
            }
            if (resultOk && typeof r.response === 'string' && r.response && !text) {
              text = r.response;
              onEvent?.({ type: 'text', text: r.response, done: false });
            }
            if (!resultOk) {
              lastError = String(r.error || r.response || 'agy 执行失败').slice(0, 2000);
            }
          }
        },
      });

      onEvent?.({ type: 'text', text: '', done: true });

      let reason;
      if (res.timedOut) reason = EXIT.TIMEOUT;
      else if (sawResult && resultOk && res.code === 0) reason = EXIT.COMPLETED;
      else if (res.spawnError) reason = EXIT.CRASHED;
      else if (res.code === 0 && !sawResult) reason = EXIT.CRASHED;
      else reason = EXIT.FAILED;

      const errorText = lastError || res.stderr.trim().slice(0, 2000) || null;
      if (reason !== EXIT.COMPLETED && (!text || lastError)) {
        onEvent?.({ type: 'error', message: errorText || 'agy 未产出内容' });
      }
      onEvent?.({ type: 'done', ok: reason === EXIT.COMPLETED, reason });

      return {
        sessionId: newSessionId,
        text,
        usage,
        reason,
        error: reason === EXIT.COMPLETED ? null : errorText,
        stderr: res.stderr,
      };
    } finally {
      if (tmpPromptPath) {
        await rm(tmpPromptPath, { force: true }).catch(() => {});
      }
    }
  }

  /** 真实探测：用短指令真实跑一轮，不依赖版本号或登录提示 */
  async probe(cwd, timeoutMs = 45_000) {
    const tier = this.config.tier || 'full';
    const args = [
      '--output-format', 'stream-json',
      ...agyTierArgs(tier),
      ...(tier !== 'read' && tier !== 'readonly' ? ['--disable-slash-commands'] : []),
      ...modelArgs('agy', this.config.model),
      '-p', 'Reply with exactly: OK',
    ];
    const res = await runJsonCli({
      command: this.config.bin || 'agy',
      args,
      cwd,
      backend: 'agy',
      forbiddenRoots: this.config.forbiddenRoots ?? [],
      prompt: '',
      timeoutMs,
    });
    if (res.timedOut) return { ok: false, reason: '探测超时' };
    const resultEv = res.lines.find((l) => l.event === 'result');
    const r = resultEv?.result;
    if (r && r.status === 'SUCCESS') {
      const initEv = res.lines.find((l) => l.event === 'init');
      return { ok: true, sessionId: r.conversation_id ?? initEv?.conversation_id ?? null };
    }
    const jsonErr = r && r.status !== 'SUCCESS' ? (r.error || r.response || '') : '';
    return { ok: false, reason: String(jsonErr || res.stderr.trim()).slice(0, 500) || '探测失败' };
  }
}
