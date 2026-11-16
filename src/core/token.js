/**
 * 访问令牌的持久化。
 *
 * ★ 令牌是**服务级**的，不是房间级的。它绑的是"这个端口上跑的这个服务"，
 *   和当前打开哪个房间毫无关系。
 *
 * 为什么单独成文件：这条规则被违反过一次——多房间迁移把 `<data>/access-token`
 * 一起搬进了 `rooms/r-legacy/`，重启后根目录找不到令牌就生成了新的，
 * 老板手里的链接失效。把读取逻辑集中在这里，并让它知道"旧布局里可能藏着令牌"，
 * 以后再迁移就不会重犯。
 *
 * 规则：
 *  1. 根目录 `<data>/access-token` 是**权威副本**。
 *  2. 根目录缺失时，先从旧房间目录（如 `rooms/r-legacy/access-token`）**捞回来**，
 *     而不是直接生成新的。
 *  3. 切换房间/新建房间/迁移，**都不碰令牌**。
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { ROOMS_DIR } from './rooms.js';

/** 令牌格式：32 位小写 hex。别的形状一律视为文件被写坏。 */
const VALID = /^[a-f0-9]{32}$/;

export const TOKEN_FILE = 'access-token';

async function readTokenFile(p) {
  try {
    const t = (await readFile(p, 'utf8')).trim();
    return VALID.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * 从旧布局里找被误搬走的令牌。
 * 只认 `rooms/<任意房间>/access-token`，且必须格式合法。
 */
export async function findLegacyToken(dataDir) {
  let entries;
  try {
    entries = await readdir(join(dataDir, ROOMS_DIR), { withFileTypes: true });
  } catch {
    return { token: null, path: null };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(dataDir, ROOMS_DIR, e.name, TOKEN_FILE);
    const t = await readTokenFile(p);
    if (t) return { token: t, path: p };
  }
  return { token: null, path: null };
}

/**
 * 取得本次服务要用的令牌。会写文件（持久化），重启后复用同一个。
 *
 * @param {string} dataDir
 * @param {string} [preferred] 显式指定（`--token xxx`），直接用它
 * @returns {Promise<{token:string, reused:boolean, recoveredFrom:string|null, path:string}>}
 */
export async function resolveAccessToken(dataDir, preferred = null) {
  const rootPath = join(dataDir, TOKEN_FILE);

  if (preferred) {
    if (!VALID.test(preferred)) {
      throw new Error('令牌必须是 32 位小写十六进制字符');
    }
    return { token: preferred, reused: true, recoveredFrom: null, path: rootPath };
  }

  const root = await readTokenFile(rootPath);
  if (root) return { token: root, reused: true, recoveredFrom: null, path: rootPath };

  // 根目录没有：先看是不是旧迁移搬走了
  const legacy = await findLegacyToken(dataDir);
  if (legacy.token) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(rootPath, legacy.token, { mode: 0o600 });
    return { token: legacy.token, reused: true, recoveredFrom: legacy.path, path: rootPath };
  }

  const fresh = randomBytes(16).toString('hex');
  await mkdir(dataDir, { recursive: true });
  await writeFile(rootPath, fresh, { mode: 0o600 });
  return { token: fresh, reused: false, recoveredFrom: null, path: rootPath };
}

export function isPlausibleToken(t) {
  return typeof t === 'string' && VALID.test(t);
}
