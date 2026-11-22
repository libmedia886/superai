/**
 * 房间工作区与共享目录的安全文件浏览模块。
 *
 * 设计目标：
 *  1. 列出房间共享目录与各成员工作目录中的产出文件（有深度与数量上限，避免扫爆大目录）。
 *  2. 只读查看文件内容：严格路径包含校验（词法 resolve + 真实 realpath 双重拦截），
 *     防止 `..` 路径穿越、绝对路径注入与符号链接逃逸。
 *  3. 自动识别二进制文件（前 4KB 含 NUL 字节），截断超大文本，避免撑爆内存与前端。
 */

import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_WALK_DEPTH = 5;
export const MAX_WALK_FILES = 200;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const BINARY_SNIFF_BYTES = 4096;

const SHARED_SKIP_NAMES = new Set(['.git', 'node_modules', 'opencode.json']);
const AGENT_SKIP_NAMES = new Set(['.git', 'node_modules', 'opencode.json']);

/**
 * 严格判定 candidatePath 位于 rootDir 内部（不能等于 rootDir，不能通过前缀碰撞或 .. 逃逸）。
 */
function isStrictlyInside(rootDir, candidatePath) {
  const rel = relative(rootDir, candidatePath);
  if (!rel || isAbsolute(rel)) return false;
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../')) return false;
  return true;
}

/**
 * 有界广度优先遍历目录，跳过忽略项与符号链接，按修改时间倒序返回文件列表。
 */
async function walkDir(rootDir, {
  skipNames = SHARED_SKIP_NAMES,
  skipDotfiles = false,
  maxDepth = MAX_WALK_DEPTH,
  maxFiles = MAX_WALK_FILES,
} = {}) {
  if (!rootDir) return [];
  let rootReal;
  try {
    rootReal = await realpath(rootDir);
    const st = await stat(rootReal);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }

  const collected = [];
  const queue = [{ dir: rootReal, relPrefix: '', depth: 0 }];

  while (queue.length > 0 && collected.length < maxFiles) {
    const { dir, relPrefix, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (collected.length >= maxFiles) break;
      const name = ent.name;
      if (skipNames.has(name)) continue;
      if (skipDotfiles && name.startsWith('.')) continue;
      // 列表阶段绝不跟随符号链接，既防目录环，也防泄露目录外文件元信息
      if (ent.isSymbolicLink()) continue;

      const full = join(dir, name);
      const relPath = relPrefix ? `${relPrefix}/${name}` : name;

      if (ent.isDirectory()) {
        if (depth < maxDepth) {
          queue.push({ dir: full, relPrefix: relPath, depth: depth + 1 });
        }
      } else if (ent.isFile()) {
        try {
          const st = await stat(full);
          collected.push({
            relPath,
            size: st.size,
            mtime: st.mtime.toISOString(),
            _ms: st.mtimeMs,
          });
        } catch {
          // 遍历期间文件被删或不可读时静默跳过
        }
      }
    }
  }

  collected.sort((a, b) => b._ms - a._ms);
  return collected.map(({ relPath, size, mtime }) => ({ relPath, size, mtime }));
}

/**
 * 列出当前房间共享目录与各成员工作目录中的文件。
 *
 * @param {object} o
 * @param {string|null} [o.sharedDir]
 * @param {Array<{id:string, name:string, cwd?:string}>} [o.members]
 */
export async function listRoomFiles({ sharedDir = null, members = [] } = {}) {
  const shared = sharedDir
    ? await walkDir(sharedDir, { skipNames: SHARED_SKIP_NAMES, skipDotfiles: false })
    : [];

  const agents = [];
  for (const m of members ?? []) {
    const files = m?.cwd
      ? await walkDir(m.cwd, { skipNames: AGENT_SKIP_NAMES, skipDotfiles: true })
      : [];
    agents.push({
      agentId: m.id,
      name: m.name,
      files,
    });
  }

  return {
    ok: true,
    sharedDir: sharedDir ?? null,
    shared,
    agents,
  };
}

/**
 * 安全读取房间共享目录或某个成员工作目录内的单个文件内容。
 *
 * @param {object} o
 * @param {'shared'|'agent'} [o.scope]
 * @param {string} [o.relPath]
 * @param {string|null} [o.sharedDir]
 * @param {Array<{id:string, name:string, cwd?:string}>} [o.members]
 * @param {string|null} [o.agentId]
 * @param {number} [o.maxBytes]
 */
export async function readRoomFile({
  scope = 'shared',
  relPath = '',
  sharedDir = null,
  members = [],
  agentId = null,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
} = {}) {
  let root = null;
  if (scope === 'shared') {
    root = sharedDir;
    if (!root) return { ok: false, status: 404, error: '文件不存在' };
  } else if (scope === 'agent') {
    if (!agentId) return { ok: false, status: 400, error: '缺少 agentId' };
    const member = (members ?? []).find((m) => m.id === agentId);
    if (!member?.cwd) return { ok: false, status: 404, error: '文件不存在' };
    root = member.cwd;
  } else {
    return { ok: false, status: 400, error: 'scope 必须是 shared 或 agent' };
  }

  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { ok: false, status: 400, error: '缺少文件路径' };
  }

  // 1) 词法与危险字符拦截：NUL 字节、绝对路径、.. 路径穿越
  if (
    relPath.includes('\0')
    || isAbsolute(relPath)
    || relPath.startsWith('/')
    || relPath.startsWith('\\')
    || /^[A-Za-z]:/.test(relPath)
    || relPath.split(/[/\\]/).includes('..')
  ) {
    return { ok: false, status: 403, error: '路径越界' };
  }

  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(resolvedRoot, relPath);
  if (!isStrictlyInside(resolvedRoot, resolvedTarget)) {
    return { ok: false, status: 403, error: '路径越界' };
  }

  // 2) 真实路径拦截（防止通过符号链接逃逸到目录外）
  let rootReal;
  try {
    rootReal = await realpath(resolvedRoot);
  } catch {
    return { ok: false, status: 404, error: '文件不存在' };
  }

  let targetReal;
  try {
    targetReal = await realpath(resolvedTarget);
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      return { ok: false, status: 403, error: '路径越界' };
    }
    return { ok: false, status: 404, error: '文件不存在' };
  }

  if (!isStrictlyInside(rootReal, targetReal)) {
    return { ok: false, status: 403, error: '路径越界' };
  }

  let st;
  try {
    st = await stat(targetReal);
  } catch {
    return { ok: false, status: 404, error: '文件不存在' };
  }
  if (!st.isFile()) {
    return { ok: false, status: 400, error: '只能读取普通文件' };
  }

  const size = st.size;
  const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : DEFAULT_MAX_FILE_BYTES;
  const toRead = Math.min(size, Math.max(limit, BINARY_SNIFF_BYTES));

  let buf = Buffer.alloc(0);
  if (toRead > 0) {
    const fh = await open(targetReal, 'r');
    try {
      const raw = Buffer.allocUnsafe(toRead);
      let offset = 0;
      while (offset < toRead) {
        const { bytesRead } = await fh.read(raw, offset, toRead - offset, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      buf = raw.subarray(0, offset);
    } finally {
      await fh.close();
    }
  }

  const sniff = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES));
  if (sniff.includes(0)) {
    return {
      ok: true,
      binary: true,
      path: relPath,
      size,
      truncated: false,
      content: '',
    };
  }

  const contentBuf = buf.length > limit ? buf.subarray(0, limit) : buf;
  return {
    ok: true,
    binary: false,
    path: relPath,
    size,
    truncated: size > limit,
    content: contentBuf.toString('utf8'),
  };
}
