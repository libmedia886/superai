/**
 * Claude Code 适配器。
 *
 * 实测基线：claude-code 2.1.325
 *  - `-p --output-format stream-json` 必须带 `--verbose`，否则直接报错退出
 *  - 事件：system/init（含 session_id）、stream_event(content_block_delta)、assistant、result
 *  - `--tools ""` 禁用全部工具（只读讨论），`--permission-prompts none` 让一切需要授权的操作直接拒绝
 *  - prompt 不带位置参数时从 stdin 读（已验证）
 */

import { AgentAdapter, EXIT, withPersona } from './types.js';
import { runJsonCli, DEFAULT_TIMEOUT_MS } from '../core/runner.js';
import { modelArgs, effortArgs } from '../core/extraargs.js';

const BASE_ARGS = [
  '-p',
  '--verbose',
  '--output-format', 'stream-json',
  '--include-partial-messages',
];

/**
 * 权限档位（§6.11，全部实测）：
 *  - readonly    `--tools ""`                    → 完全无工具，无读文件能力（硬隔离）
 *  - write       `--tools "Read,Write,Edit" --permission-mode acceptEdits`
 *                只有 --tools 不够：没人应答权限请求，写会被自动拒（实测 DENIED）
 *  - write-exec  上一档 + Bash
 *  - write-ask   `--tools "Read,Write,Edit" --permission-prompts host`
 *                **每次写都要人批准**。这是用户在重要目录上的最后一道防线。
 *                注意：不能用 acceptEdits——那个模式本身就是"自动批准编辑"。
 *
 * ⚠️ 静默自动批准 vs 每次询问的差别必须在界面上写清：
 *    默认档是"从来不问"，不是"每次都会问我"。
 */
/**
 * 命令白名单 → `--allowedTools "Bash(curl:*)" "Bash(wget:*)"`。
 *
 * ★ 为什么必须用白名单而不是整片放开 Bash：
 *   实测 `--allowedTools "Bash"` 之后，agent 能 `echo LEAK > /tmp/outside`，
 *   也就是**命令行走廊没有目录墙**（文件工具反而有）。所以"能跑命令"和
 *   "只能在目录内动手"这两个承诺无法同时成立。
 *   白名单让老板自己决定放开到什么程度，界面必须明说这层风险。
 */
/**
 * 命令白名单 → `--allowedTools` 参数。
 *
 * ★ token `netget` 必须解析成**绝对路径**再放行。
 *   实测审批器是**字面前缀匹配**：模型写 `./bin/netget` 会被拒，
 *   只认绝对路径。所以这里必须替模型把路径补全，否则它会以为没权限。
 *
 * @param {string[]} cmds  成员配置里的命令清单
 * @param {{netgetPath?: string|null}} [o]  app 生成的包装器绝对路径
 */
export function allowedCommandArgs(cmds = [], { netgetPath = null } = {}) {
  const list = (cmds ?? []).map((c) => String(c ?? '').trim()).filter(Boolean);
  if (!list.length) return [];

  const resolved = list.map((c) => {
    if (c === 'netget') {
      // 没生成包装器时不能静默降级成 "Bash(netget:*)"——那会被审批器拒，
      // 表现为"配了却用不了"，正是本项目一路在抓的界面撒谎。
      if (!netgetPath) throw new Error('成员要了 netget，但 app 没有生成包装器');
      return netgetPath;
    }
    return c;
  });

  return ['--allowedTools', ...resolved.map((c) => `Bash(${c}:*)`)];
}

export function tierArgs(tier = 'readonly', { allowedCommands = [], netgetPath = null } = {}) {
  if (tier === 'read') {
    // 可读档：实测 `--tools "Read,Grep,Glob" --permission-prompts none`
    // 能读 cwd 内文件，目录外被权限系统拦下。这是老板说的「可读」。
    return ['--tools', 'Read,Grep,Glob', '--permission-prompts', 'none'];
  }
  if (tier === 'write-ask') {
    return ['--tools', 'Read,Write,Edit', '--permission-mode', 'default', '--permission-prompts', 'host'];
  }
  if (tier === 'write' || tier === 'writeExec' || tier === 'write-exec') {
    /**
     * write-exec 的 Bash 只在有白名单时给出。
     *
     * 没有白名单时给了 Bash 也没用：`acceptEdits` 只自动批准文件编辑，
     * Bash 每次仍要审批，而 `--permission-prompts none` 没有审批通道 →
     * 一律自动拒绝。于是"可写+执行"名不副实，agent 会反复尝试、白烧 token。
     * 干脆不给这个工具，并在 prompt 里说清楚。
     */
    const hasCommands = (allowedCommands ?? []).length > 0;
    const tools = tier === 'write'
      ? 'Read,Write,Edit'
      : (hasCommands ? 'Read,Write,Edit,Bash' : 'Read,Write,Edit');
    const args = ['--tools', tools, '--permission-mode', 'acceptEdits', '--permission-prompts', 'none'];
    if (hasCommands) args.push(...allowedCommandArgs(allowedCommands, { netgetPath }));
    return args;
  }
  return ['--tools', '', '--permission-prompts', 'none'];
}

/** 界面文案：说清楚"问不问人"，而不是只说"能不能写" */
export function approvalLabel(tier) {
  if (tier === 'readonly') return '不碰文件';
  if (tier === 'read') return '只读';
  if (tier === 'write-ask') return '每次询问';
  return '自动批准';
}

/**
 * 过滤模型把工具调用语法当正文吐出来的乱码。
 * 和 opencode 那边同一个问题：工具被禁用后，有的模型不回答 DENIED，
 * 而是把想调用的工具写成一串特殊标记。
 */
const DSML_MARK = /<[/\\]?\s*[｜|]{2,}\s*DSML\s*[｜|]{2,}|\n?\s*<[/\\]?\s*[｜|]{2,}\s*DSML/;
function cleanLeakedToolSyntax(chunk) {
  if (!chunk || !DSML_MARK.test(chunk)) return chunk;
  return chunk.split('\n').filter((line) => !DSML_MARK.test(line)).join('\n');
}

/** 把工具入参压成一行可读摘要，供写操作日志使用 */
function summarizeToolInput(name, input) {
  if (name === 'Bash') return String(input.command ?? '').slice(0, 300);
  if (input.file_path) {
    const n = typeof input.content === 'string' ? ` (${input.content.length} 字符)` : '';
    return `${input.file_path}${n}`;
  }
  if (input.pattern) return String(input.pattern).slice(0, 120);
  const keys = Object.keys(input);
  return keys.length ? keys.slice(0, 5).join(',') : '';
}

export class ClaudeAdapter extends AgentAdapter {
  get supportsStreaming() { return true; }

  /**
   * 参数顺序：应用自有参数 → 模型/思考等级 → 会话 → 用户附加参数。
   *
   * 附加参数放最后，让用户的 `-c` / 覆盖值能盖过自家配置里同名的项，
   * 和 CLI 自身的"后者优先"语义一致。协议参数与档位参数在保存时就被
   * 拒绝/确认过了，不会走到这里。
   */
  buildArgs({ sessionId = null } = {}) {
    const args = [
      ...BASE_ARGS,
      ...tierArgs(this.config.tier, {
        allowedCommands: this.config.allowedCommands,
        netgetPath: this.config.netgetPath ?? null,
      }),
      ...modelArgs('claude', this.config.model),
      ...effortArgs('claude', this.config.effort),
    ];
    if (sessionId) args.push('--resume', sessionId);

    /**
     * 房间共享目录。
     *
     * 实测 `--add-dir` 同时给**读和写**——claude 没有"这个目录只读"的表达方式。
     * 所以不要声称成员在共享目录里是只读的：规则由 prompt 约束，
     * 所有写入都会进工具日志（可追责）。这一点在界面与 prompt 里都要如实说。
     * 只读档（readonly/read）不给这个参数：它们本来就没有写工具。
     */
    const tier = this.config.tier;
    const canUseFiles = tier && tier !== 'readonly';
    if (this.config.sharedDir && canUseFiles) {
      args.push('--add-dir', this.config.sharedDir);
    }

    args.push(...(this.config.extraArgs ?? []));
    return args;
  }

  async run({ prompt, cwd, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS, onEvent, signal = null }) {
    const args = this.buildArgs({ sessionId });

    let newSessionId = sessionId ?? null;
    let sawResult = false;
    let resultOk = false;
    let usage = null;
    let text = '';

    const res = await runJsonCli({
      command: this.config.bin || 'claude',
      args,
      cwd,
      backend: 'claude',
      signal,
      prompt: withPersona(this.config.persona, prompt),
      timeoutMs,
      onLine: (ev) => {
        /**
         * 任何一行输出都算"还活着"。
         *
         * 否则 runJsonCli 收到但业务层不认识的类型（比如 user/tool_result）
         * 会被当成静默——而 claude 在工具执行期间**一条流事件都不发**，
         * 一次 45 秒的 curl 在应用看来就是 45 秒静默，看门狗直接判死。
         */
        onEvent?.({ type: 'activity' });

        if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
          newSessionId = ev.session_id;
          onEvent?.({ type: 'meta', sessionId: newSessionId });
          return;
        }
        if (ev.type === 'stream_event') {
          const inner = ev.event;
          if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
            text += inner.delta.text;
            // 工具被禁用时，部分模型会把工具调用语法当正文吐出来（DSML 乱码）。
            // 让它进聊天流，用户会看到一大坨奇怪的东西。
            onEvent?.({ type: 'text', text: cleanLeakedToolSyntax(inner.delta.text), done: false });
            return;
          }
          // 思考过程单独走 thinking 事件，界面默认折叠
          if (inner?.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta') {
            onEvent?.({ type: 'thinking', text: inner.delta.thinking ?? '' });
            return;
          }
          return;
        }
        // 工具调用：写操作日志靠它。没有这个，可写档出问题时只能靠猜。
        // 工具调用开始/结束：in-flight 期间静默窗口要放宽（工具可能跑很久）
        if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
          if (ev.message.content.some((b) => b.type === 'tool_result')) {
            onEvent?.({ type: 'tool.result' });
          }
          return;
        }
        if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type !== 'tool_use') continue;
            const input = block.input ?? {};
            onEvent?.({
              type: 'tool',
              tool: block.name ?? 'unknown',
              // Write/Edit 带 file_path，Bash 带 command，Read 带 file_path
              path: input.file_path ?? input.path ?? null,
              command: input.command ?? null,
              detail: summarizeToolInput(block.name, input),
            });
          }
          return;
        }
        if (ev.type === 'result') {
          onEvent?.({ type: 'tool.result' });
          sawResult = true;
          resultOk = ev.subtype === 'success' && ev.is_error !== true;
          if (ev.usage) {
            usage = {
              inputTokens: ev.usage.input_tokens ?? 0,
              outputTokens: ev.usage.output_tokens ?? 0,
              cacheReadTokens: ev.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: ev.usage.cache_creation_input_tokens ?? 0,
              costUsd: ev.total_cost_usd ?? null,
              contextWindow: ev.modelUsage ? Object.values(ev.modelUsage)[0]?.contextWindow ?? null : null,
            };
            onEvent?.({ type: 'usage', ...usage });
          }
          if (typeof ev.result === 'string' && ev.result && !text) {
            text = ev.result;
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

    if (reason !== EXIT.COMPLETED && !text) {
      onEvent?.({ type: 'error', message: res.stderr.trim().slice(0, 2000) || 'claude 未产出内容' });
    }
    onEvent?.({ type: 'done', ok: reason === EXIT.COMPLETED, reason });

    return { sessionId: newSessionId, text, usage, reason, stderr: res.stderr };
  }

  /** 真实探测：不要再依赖版本/登录提示，直接跑一轮极短对话 */
  async probe(cwd, timeoutMs = 30_000) {
    // 探测用当前档位真实跑一轮，不依赖版本号/登录提示
    const res = await runJsonCli({
      command: this.config.bin || 'claude',
      args: ['-p', '--output-format', 'json', ...tierArgs(this.config.tier)],
      cwd,
      backend: 'claude',
      prompt: 'Reply with exactly: OK',
      timeoutMs,
    });
    const last = res.lines.find((l) => l.type === 'result');
    if (res.timedOut) return { ok: false, reason: '探测超时' };
    if (last && last.subtype === 'success' && last.is_error !== true) {
      return { ok: true, sessionId: last.session_id ?? null };
    }
    return { ok: false, reason: res.stderr.trim().slice(0, 500) || '探测失败' };
  }
}
