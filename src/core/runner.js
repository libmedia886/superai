/**
 * 子进程执行骨架：NDJSON 行缓冲 + UTF-8 显式解码 + 硬超时 + 进程组 kill。
 * 对应需求 §6.2 / §6.6。
 *
 * 设计要点：
 *  - prompt 一律走 stdin（Windows 有命令长度上限），写完显式 close
 *  - 环境变量走**白名单**，不是全量继承：agent 能看到的进程环境里不该有
 *    与它无关的密钥（数据库密码、云凭据、CI token 等）
 *  - 超时杀进程组，POSIX 用 detached + kill(-pid)
 */

import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * 白名单。
 *
 * 分成四类，每类理由不同：
 *  1. 运行必需：PATH / HOME / 临时目录 / Windows 系统变量
 *  2. 地区与终端：LANG / LC_* / TERM / NO_COLOR —— 保证输出可解析
 *  3. **CLI 认证**：不继承这些，agent 根本登录不上（本机实测登录态就是走环境变量的）
 *  4. 代理：企业网络下没它连不出去
 *
 * ⚠️ 注意第 3 类：它意味着 agent 进程**能看到这些 token**。
 * 这是"必须能登录"和"不泄露其它密钥"之间的取舍——我们只能保证
 * 除了它自己的认证信息，看不到与它无关的东西。
 */
const EXACT_ALLOW = new Set([
  // 运行必需
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'PWD',
  // 地区与终端
  'LANG', 'LANGUAGE', 'TERM', 'NO_COLOR', 'FORCE_COLOR', 'TZ',
  // 代理
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  // Windows 系统（缺了 CLI 会找不到自己的配置目录）
  'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
]);

/**
 * 按前缀放行。三家 CLI 的认证与配置都可能走环境变量
 * （实测本机 claude 用 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN）。
 */
const PREFIX_ALLOW = [
  'LC_',            // 地区细分
  'ANTHROPIC_',     // Claude Code
  'CLAUDE_',        // Claude Code 内部
  'OPENAI_',        // Codex
  'CODEX_',         // Codex
  'OPENCODE_',      // opencode
  'XDG_',           // Linux 标准目录（CLI 存会话用）
  'GIT_',           // 身份与配置；agent 可能需要
];

/** 后端的认证变量要显式点名，不能只靠前缀——避免把 ANTHROPIC_ 下的任意变量都漏出去 */
export const AUTH_VARS_BY_BACKEND = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME'],
  opencode: ['OPENCODE_'],
};

/**
 * ★ PATH 里的攻击面必须结构性消除。
 *
 * 成员的 cwd 是它自己可写的目录。如果 PATH 里有任何一个目录落在数据目录内，
 * 成员往那里放一个同名可执行文件（`curl`、`git`…），子进程就会执行它，
 * 而这个项目的所有约束（档位、命令白名单、netget）都建立在"执行的是真命令"上。
 *
 * 管理方 22:55 指出的方向：**只要允许裸命令，PATH 就是攻击面**。
 * netget 自己重设 PATH 所以安全，但成员直接跑 `curl`（自定义命令那条路）没有这层保护。
 * 所以在**子进程环境**这一层过滤掉数据目录内的 PATH 条目——这是唯一覆盖所有后端的点。
 *
 * @param {object} [o]
 * @param {Record<string,string>} [o.extra]     强制覆盖
 * @param {string} [o.backend]                  只放行该后端的认证变量（不传则放行全部前缀）
 * @param {string[]} [o.forbiddenRoots]         PATH 里不许出现的目录前缀（数据目录）
 */
export function childEnv(extra = {}, { backend = null, forbiddenRoots = [] } = {}) {
  const base = {};
  const allowedAuth = backend ? new Set(AUTH_VARS_BY_BACKEND[backend] ?? []) : null;

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (EXACT_ALLOW.has(key)) { base[key] = value; continue; }

    const byPrefix = PREFIX_ALLOW.some((p) => key.startsWith(p));
    if (!byPrefix) continue;

    // 指定了后端时，认证类前缀再收窄到该后端明确的变量名
    if (allowedAuth && /AUTH|KEY|TOKEN|BASE_URL|MODEL|HOME/.test(key)) {
      if (!allowedAuth.has(key)) continue;
    }
    base[key] = value;
  }

  const out = {
    ...base,
    NO_COLOR: '1',
    TERM: 'dumb',
    LANG: base.LANG || 'C.UTF-8',
    ...extra,
  };

  /**
   * ★ PATH 用**白名单**，不是黑名单（管理方 23:10 纠正），且必须作用在**最终结果**上。
   *
   * 我第一版是"剔除落在数据目录下的条目"。它挡不住等价写法：
   *   `.:/usr/bin`   —— `.` 就是当前目录，而当前目录正是成员可写的 cwd
   *   `bin:/usr/bin` —— 任何相对路径都相对于子进程 cwd，而 cwd 永远在数据目录内
   * 这些写法里**根本没有数据目录的字符串**，黑名单匹配不到。
   *
   * 判据改成：**只接受绝对路径**（`/` 开头），其余一律剔除
   * —— 空段、`.`、`..`、相对路径全部不要。
   * 系统 PATH 里没有相对条目，剔除它们不影响任何正常命令。
   *
   * 这与 netget 里 `CURL_BIN` 的前缀白名单是同一个标准：
   * "我过滤了我知道的写法"挡不住"我不知道的等价写法"。
   *
   * ★ 第二层（管理方 2026-11-17 实测）：净化必须作用在**最终结果** `out` 上。
   *   原来先净化 `base.PATH`、再 `...extra`，任何调用方传 `extra.PATH`
   *   就把它覆盖回去了 —— **净化和旁路同时存在，而注释还写着"结构性消除"**。
   *   目前没有调用方这么传（潜在旁路而非线上漏洞），但
   *   "只要有机会传错就一定会被传错"，所以净化放在最后一道。
   */
  if (out.PATH) {
    const kept = out.PATH.split(':').filter((dir) => {
      if (!dir.startsWith('/')) return false;   // 相对路径 / . / .. / 空段
      if (forbiddenRoots.length) {
        const norm = dir.replace(/\/+$/, '');
        if (forbiddenRoots.some((root) => norm === root || norm.startsWith(`${root}/`))) return false;
      }
      return true;
    });
    out.PATH = kept.join(':');
  }

  return out;
}

/** 供诊断：列出某个环境里"可能敏感"的变量名（只列名不列值） */
export function sensitiveVarNames(env) {
  return Object.keys(env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(k)).sort();
}

/**
 * 跑一个 CLI，逐行回调 JSON 事件。
 *
 * @param {object} o
 * @param {string} o.command
 * @param {string[]} o.args
 * @param {string} o.cwd
 * @param {string} o.prompt
 * @param {number} [o.timeoutMs]
 * @param {(json:any)=>void} [o.onLine]
 * @param {(line:string)=>void} [o.onStderrLine]
 * @returns {Promise<{code:number|null, signal:string|null, timedOut:boolean, lines:any[], stderr:string}>}
 */
export function runJsonCli({
  command,
  args,
  cwd,
  prompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onLine,
  onStderrLine,
  backend = null,
  env = {},
  signal = null,
  forbiddenRoots = [],
}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(command, args, {
      cwd,
      env: childEnv(env, { backend, forbiddenRoots }),
      stdio: ['pipe', 'pipe', 'pipe'],
      // 非 Windows 建独立进程组，便于整组 kill
      detached: !isWin,
      windowsHide: true,
    });

    const lines = [];
    let stderr = '';
    let timedOut = false;
    let buf = '';
    let errBuf = '';

    let abortedBySignal = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, isWin);
    }, timeoutMs);

    // 外部中断（人点"打断"、或看门狗判定卡死）。必须真的杀进程，
    // 只 resolve Promise 的话进程会变成孤儿继续占额度。
    const onAbort = () => {
      abortedBySignal = signal?.reason ?? 'aborted';
      killTree(child, isWin);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const handleLine = (raw) => {
      const line = raw.trim();
      if (!line) return;
      let json;
      try {
        json = JSON.parse(line);
      } catch {
        // CLI 偶尔在 stdout 混入非 JSON 噪音（如 "[claude-code:...]"），当作调试信息
        onStderrLine?.(line);
        return;
      }
      lines.push(json);
      onLine?.(json);
    };

    // buffer 按字节累积再按行切，避免 UTF-8 多字节被 chunk 截断
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });

    child.stderr.on('data', (chunk) => {
      errBuf += chunk.toString('utf8');
      const parts = errBuf.split('\n');
      errBuf = parts.pop() ?? '';
      for (const p of parts) {
        stderr += p + '\n';
        onStderrLine?.(p);
      }
    });

    const finish = (code, sig) => {
      if (buf.trim()) handleLine(buf);
      if (errBuf.trim()) stderr += errBuf;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ code, signal: sig, timedOut, aborted: abortedBySignal, lines, stderr });
    };

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        code: null, signal: null, timedOut: false, aborted: abortedBySignal,
        lines, stderr: stderr + String(err?.message ?? err), spawnError: true,
      });
    });
    child.on('close', finish);

    // 写 prompt 并显式关闭；EPIPE 说明进程提前退出，忽略即可
    child.stdin.on('error', () => {});
    child.stdin.end(prompt ?? '');
  });
}

function killTree(child, isWin) {
  try {
    if (isWin) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
}
