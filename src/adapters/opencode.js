/**
 * opencode 适配器。
 *
 * 实测基线：opencode-ai 1.19.5
 *
 * ★ 与另外两家的根本差异：**opencode 默认没有任何目录边界**。
 *   实测从 cwd 写 /tmp/outside_default.txt 直接成功，无提示无拒绝。
 *   所以「cwd 就是边界」这条只对 Claude 成立。opencode 必须靠配置文件约束。
 *
 * 权限用 cwd 里的 opencode.json 实现（不是命令行参数）：
 *  - 天然跟目录绑定，且每个 agent 一个 workdir，正好一一对应
 *  - 实测全 deny 时它会诚实拒绝（"I don't have file-write or shell access"）
 *
 * 已知坑（都实测过）：
 *  1. `external_directory: deny` 能挡住目录外读写，但**必须配硬超时**
 *  2. 混合档位（edit allow + bash deny）在**部分模型上会反复重试导致挂死**，
 *     换模型则直接成功。所以固定注入「用 write 工具，不要用 shell」提示，
 *     把模型差异抹平。
 *  3. bash 被拒时，有的模型会把工具调用语法（<｜｜DSML｜｜> 之类）**当纯文本吐出来**，
 *     用户会看到乱码。适配器要过滤，不能让它进聊天正文。
 *  4. `--format json` 是 JSONL，但 **text 整段出现、没有 token 级 delta**
 *     （和 Codex 一样）。P0 第 2 条"逐字流式"只有 Claude 能做到。
 *
 * 事件：step_start / text / tool_use / step_finish
 * 会话：`-s <sessionID>` 续聊，每个事件都带 sessionID
 * 用量：`step_finish.part.tokens` = {total, input, output, reasoning, cache:{write,read}}
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentAdapter, EXIT, withPersona } from './types.js';
import { runJsonCli, DEFAULT_TIMEOUT_MS } from '../core/runner.js';
import { modelArgs, effortArgs } from '../core/extraargs.js';

/**
 * 权限档位 → opencode.json 的 permission 块。
 * 注意外部目录必须显式 deny：默认是允许的。
 */
export function permissionConfig(tier) {
  const deny = 'deny';
  const allow = 'allow';

  /**
   * 可读档：读/搜/列目录放行，写与命令全禁。
   *
   * ⚠️ `external_directory: deny` 必须显式写：opencode **默认没有目录边界**
   * （实测能直接写 /tmp）。少这一行，"可读"就会变成"全盘可读"。
   */
  if (tier === 'read') {
    return {
      read: allow, glob: allow, grep: allow, list: allow,
      edit: deny, bash: deny, task: deny,
      external_directory: deny,
      webfetch: deny, skill: deny, todowrite: deny, websearch: deny, lsp: deny,
    };
  }

  if (tier === 'readonly') {
    return {
      read: deny, edit: deny, glob: deny, grep: deny, list: deny,
      bash: deny, task: deny, external_directory: deny,
      webfetch: deny, skill: deny, todowrite: deny, websearch: deny, lsp: deny,
    };
  }

  // write / write-exec：可动本目录，外部仍然一律禁
  return {
    read: allow, edit: allow, glob: allow, grep: allow, list: allow,
    bash: tier === 'write-exec' || tier === 'writeExec' ? allow : deny,
    task: deny,
    external_directory: deny,
    webfetch: deny, skill: deny, todowrite: deny, websearch: deny, lsp: deny,
  };
}

/** 中间档（可写不跑命令）必须显式告诉它用 write 工具，否则部分模型会反复试 shell 直到超时 */
const WRITE_HINT = '注意：本会话没有 shell 权限。创建或修改文件请使用 write/edit 工具，不要尝试执行命令。\n\n';

/** 过滤模型把工具调用语法当文本吐出来的乱码（全角竖线包裹的 DSML 标记） */
const DSML_MARKER = /<[/\\]?\s*[｜|]{2,}\s*DSML\s*[｜|]{2,}/;

export function cleanText(text) {
  if (!text) return '';
  const kept = String(text)
    .split('\n')
    .filter((line) => !DSML_MARKER.test(line))
    .join('\n');
  return kept.replace(/\n{3,}/g, '\n\n').trim();
}

export class OpencodeAdapter extends AgentAdapter {
  /** text 整段出现，没有 delta */
  get supportsStreaming() { return false; }

  /**
   * 把权限写成 cwd 里的 opencode.json。
   *
   * 共享目录：opencode 靠 `external_directory` 这一项控制，而它只有
   * deny/allow 两档——**没有"只读"**。所以共享目录一旦给出去就是可读写，
   * 和 claude 的 `--add-dir` 一样。只读档不给。
   */
  async prepare(cwd) {
    await mkdir(cwd, { recursive: true });
    const tier = this.config.tier ?? 'readonly';
    const permission = permissionConfig(tier);
    const shared = this.config.sharedDir;
    const writable = tier === 'write' || tier === 'writeExec' || tier === 'write-exec';
    if (shared && writable) {
      permission.external_directory = 'allow';
    }
    const cfg = { permission };
    await writeFile(join(cwd, 'opencode.json'), JSON.stringify(cfg, null, 2));
    return cfg;
  }

  #args(cwd, sessionId) {
    const args = ['run', '--format', 'json', '--dir', cwd];
    if (sessionId) args.push('-s', sessionId);
    if (this.config.agent) args.push('--agent', this.config.agent);
    // 共享目录：opencode 用 --dir 只能有一个，共享区靠 opencode.json 的
    // external_directory 放行（见 prepare）
    args.push(...modelArgs('opencode', this.config.model));
    args.push(...effortArgs('opencode', this.config.effort));
    // 附加参数放最后：让用户能盖过上面的默认值
    args.push(...(this.config.extraArgs ?? []));
    return args;
  }

  async run({ prompt, cwd, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS, onEvent, signal = null }) {
    await this.prepare(cwd);

    const tier = this.config.tier ?? 'readonly';
    const needsHint = tier === 'write' || tier === 'writeExec';
    /**
     * read 档也要注入提示：`edit:deny + bash:deny` 会让部分模型反复重试
     * 直到挂死（和"混合档位"是同一个病）。明确告诉它没写入权限，它才会收手。
     */
    const readHint = tier === 'read'
      ? '注意：本会话没有写入与命令权限，不要尝试用 shell 或编辑工具。只阅读和回答。\n\n'
      : '';
    const fullPrompt = withPersona(this.config.persona, readHint + (needsHint ? WRITE_HINT : '') + prompt);

    let newSessionId = sessionId ?? null;
    let sawFinish = false;
    let usage = null;
    const texts = [];
    let sawToolUse = false;

    const res = await runJsonCli({
      command: this.config.bin || 'opencode',
      args: this.#args(cwd, sessionId),
      cwd,
      backend: 'opencode',
      // 数据目录下的任何条目都不能出现在子进程 PATH 里（成员可写 → 可劫持命令）
      forbiddenRoots: this.config.forbiddenRoots ?? [],
      signal,
      prompt: fullPrompt,
      timeoutMs,
      onLine: (ev) => {
        // 任何一行输出都算活着（工具执行期间可能很久没有正文）
        onEvent?.({ type: 'activity' });
        if (ev.sessionID) {
          if (!newSessionId) {
            newSessionId = ev.sessionID;
            onEvent?.({ type: 'meta', sessionId: newSessionId });
          }
        }
        switch (ev.type) {
          case 'text': {
            const t = ev.part?.text;
            if (typeof t === 'string' && t) {
              // 乱码过滤：整段清洗后再下发
              const cleaned = cleanText(t);
              if (cleaned) {
                texts.push(cleaned);
                onEvent?.({ type: 'text', text: cleaned, done: false });
              }
            }
            break;
          }
          case 'tool_use': {
            sawToolUse = true;
            onEvent?.({ type: 'tool', name: ev.part?.tool ?? 'tool', input: ev.part?.state?.input ?? null });
            break;
          }
          case 'step_finish': {
            sawFinish = true;
            const tk = ev.part?.tokens;
            if (tk) {
              usage = {
                inputTokens: tk.input ?? 0,
                outputTokens: tk.output ?? 0,
                cacheReadTokens: tk.cache?.read ?? 0,
                cacheWriteTokens: tk.cache?.write ?? 0,
                reasoningTokens: tk.reasoning ?? 0,
                costUsd: ev.part?.cost ?? null,
                contextWindow: null,
              };
              onEvent?.({ type: 'usage', ...usage });
            }
            break;
          }
          default:
            break;
        }
      },
    });

    onEvent?.({ type: 'text', text: '', done: true });

    let reason;
    if (res.timedOut) reason = EXIT.TIMEOUT;
    else if (sawFinish && res.code === 0) reason = EXIT.COMPLETED;
    else if (res.spawnError) reason = EXIT.CRASHED;
    else reason = EXIT.FAILED;

    if (reason !== EXIT.COMPLETED && texts.length === 0) {
      onEvent?.({ type: 'error', message: res.stderr.trim().slice(0, 2000) || 'opencode 未产出内容' });
    }
    onEvent?.({ type: 'done', ok: reason === EXIT.COMPLETED, reason });

    return {
      sessionId: newSessionId,
      text: texts.join(''),
      usage,
      reason,
      stderr: res.stderr,
      sawToolUse,
    };
  }

  async probe(cwd, timeoutMs = 60_000) {
    await this.prepare(cwd);
    const res = await runJsonCli({
      command: this.config.bin || 'opencode',
      args: ['run', '--format', 'json', '--dir', cwd],
      cwd,
      backend: 'opencode',
      forbiddenRoots: this.config.forbiddenRoots ?? [],
      prompt: 'Reply with exactly: OK',
      timeoutMs,
    });
    if (res.timedOut) return { ok: false, reason: '探测超时' };
    const ok = res.lines.some((l) => l.type === 'step_finish');
    if (ok) {
      const first = res.lines.find((l) => l.sessionID);
      return { ok: true, sessionId: first?.sessionID ?? null };
    }
    return { ok: false, reason: res.stderr.trim().slice(0, 500) || '探测失败' };
  }
}
