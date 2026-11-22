/**
 * 附加启动参数（CR-027 §3）。
 *
 * 老板要"能给每个成员设启动参数"，但这东西直接拼到命令行上，
 * 有两种能立刻把系统弄坏的方式，所以分三类处理：
 *
 *  1. **破坏通信协议 → 直接拒绝**
 *     这类参数会让事件解析坏掉（agent 说话乱了 / 整轮空），不是权限问题。
 *     例：claude 的 `--output-format`、codex 的 `--json`。
 *
 *  2. **覆盖权限档位 → 需要显式确认，且界面常驻标注**
 *     边界由人画，不该被工具藏起来；但界面也绝不能撒谎说档位还在起作用。
 *     例：claude 的 `--dangerously-skip-permissions`。
 *
 *  3. **其余 → 放行**
 *     例：`--add-dir`、`--mcp-config`。
 *
 * ★ 档位覆盖标记必须**每次从参数重新判定**，不能存布尔值——
 *   参数删掉后标记要自己消失，否则又是一条"界面撒谎"。
 */

export const PROTOCOL_ARGS = {
  claude: [
    '-p', '--print', '--output-format', '--input-format',
    '--resume', '--continue', '--include-partial-messages',
  ],
  codex: ['exec', 'resume', '--json', '--skip-git-repo-check', '-C', '--last', '--all', '-'],
  opencode: ['run', '--format', '-s', '--session'],
  agy: [
    '-p', '--print', '--prompt', '--output-format', '--input-format',
    '--conversation', '-c', '--continue',
  ],
};

export const TIER_OVERRIDE_ARGS = {
  claude: ['--tools', '--permission-mode', '--permission-prompts', '--dangerously-skip-permissions'],
  codex: ['-s', '--sandbox', '--dangerously-bypass-approvals-and-sandbox'],
  opencode: ['--dangerously-skip-permissions', '--auto'],
  agy: ['--mode', '--dangerously-skip-permissions', '--sandbox'],
};

/** codex 的档位参数也能写成 `-c sandbox_mode=...`，单独认一下 */
const CODEX_TIER_KEYS = ['sandbox_mode', 'approval_policy'];

/**
 * 解析一段附加参数文本。
 *
 * 支持引号（`--mcp-config "/path/a b.json"`），因为路径里有空格很常见。
 * 解析失败（引号不配对）时返回错误，而不是把畸形字符串塞给 CLI。
 *
 * @returns {{ok:true, tokens:string[]} | {ok:false, reason:string}}
 */
export function tokenizeArgs(text) {
  const src = String(text ?? '').trim();
  if (!src) return { ok: true, tokens: [] };

  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && src[i + 1] === quote) { cur += quote; i += 1; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || cur) { tokens.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quote) return { ok: false, reason: `引号没有闭合：${text}` };
  if (started || cur) tokens.push(cur);
  return { ok: true, tokens };
}

/** 取 `--flag=value` / `-c key=value` 的参数名部分 */
function argName(token) {
  if (!token) return '';
  if (token.startsWith('--')) return token.split('=')[0];
  if (token.startsWith('-') && token.length === 2) return token;
  return token;
}

/**
 * 把一条参数的"身份"拆出来，用于分类。
 * `-c sandbox_mode=workspace-write` 的身份是 `-c:sandbox_mode`。
 */
function identify(backend, tokens, i) {
  const tok = tokens[i];
  const name = argName(tok);
  if ((name === '-c' || name === '--config') && tokens[i + 1]) {
    const key = String(tokens[i + 1]).split('=')[0].trim();
    return { name, detail: key, value: tokens[i + 1] };
  }
  return { name, detail: null, value: tok.includes('=') ? tok.slice(tok.indexOf('=') + 1) : null };
}

/**
 * 分类。返回三段：拒绝的、需确认的、放行的（放行的已还原成 token 数组）。
 *
 * @param {string} backend
 * @param {string|string[]} input 原始文本或已 token 化的数组
 */
export function classifyExtraArgs(backend, input) {
  const parsed = Array.isArray(input) ? { ok: true, tokens: input } : tokenizeArgs(input);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const protocol = new Set(PROTOCOL_ARGS[backend] ?? []);
  const overrides = new Set(TIER_OVERRIDE_ARGS[backend] ?? []);

  const rejected = [];
  const needingConfirm = [];
  const accepted = [];

  const tokens = parsed.tokens;
  for (let i = 0; i < tokens.length; i += 1) {
    const id = identify(backend, tokens, i);
    const takesValue = tokens[i + 1] && !tokens[i + 1].startsWith('-');

    // ① 协议参数：拒绝
    if (protocol.has(id.name) || (id.name === '-' && tokens[i] === '-')) {
      rejected.push({ arg: tokens[i], reason: '会破坏与应用的通信协议（事件解析会坏掉）' });
      i += takesValue && !tokens[i].includes('=') ? 1 : 0;
      continue;
    }

    // ② 档位参数：需要确认
    const isTierArg = overrides.has(id.name)
      || (id.name === '-c' && CODEX_TIER_KEYS.includes(id.detail));
    if (isTierArg) {
      needingConfirm.push({ arg: id.detail ? `${tokens[i]} ${tokens[i + 1]}` : tokens[i] });
      if (takesValue && !tokens[i].includes('=')) {
        accepted.push(tokens[i], tokens[i + 1]);
        i += 1;
      } else {
        accepted.push(tokens[i]);
      }
      continue;
    }

    // ③ 其余：放行（连同它的值）
    accepted.push(tokens[i]);
    if (takesValue && !tokens[i].includes('=')) {
      accepted.push(tokens[i + 1]);
      i += 1;
    }
  }

  return {
    ok: true,
    rejected,
    needingConfirm,
    accepted,
    overridesTier: needingConfirm.length > 0,
  };
}

/**
 * 参数文本里是否覆盖了档位——界面每次渲染都要重新问一遍，
 * **不要**把它存成成员字段（参数删掉后标记必须自己消失）。
 */
export function detectTierOverride(backend, text) {
  const r = classifyExtraArgs(backend, text);
  return r.ok ? r.overridesTier : false;
}

/** 供界面展示的最终命令行预览（不含 prompt，prompt 走 stdin） */
export function previewCommand({ backend, bin, tierArgs = [], model, effort, extraArgs = [] }) {
  const parts = [bin ?? backend, ...tierArgs];
  if (model) parts.push(...modelArgs(backend, model));
  if (effort) parts.push(...effortArgs(backend, effort));
  parts.push(...(Array.isArray(extraArgs) ? extraArgs : []));
  return parts.join(' ');
}

/** 模型参数名（各家都不同，且 codex 首轮/resume 只能用 -c） */
export function modelArgs(backend, model) {
  if (!model) return [];
  if (backend === 'claude') return ['--model', model];
  if (backend === 'codex') return ['-c', `model="${model}"`];
  if (backend === 'opencode') return ['-m', model];
  if (backend === 'agy') return ['--model', model];
  return [];
}

/** 思考等级参数名 */
export function effortArgs(backend, effort) {
  if (!effort) return [];
  if (backend === 'claude') return ['--effort', effort];
  if (backend === 'codex') return ['-c', `model_reasoning_effort="${effort}"`];
  if (backend === 'opencode') return ['--variant', effort];
  if (backend === 'agy') return ['--effort', effort];
  return [];
}

/**
 * 留空 = 一个参数都不传。这是硬约束：
 * 本机 codex 指向自家配置（~/.codex/config.toml 有 model / model_provider），
 * 硬塞一个默认模型会直接把它弄坏。
 */
export const EFFORT_HINTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  opencode: ['minimal', 'high', 'max'],
  agy: ['low', 'medium', 'high', 'xhigh', 'max'],
};
