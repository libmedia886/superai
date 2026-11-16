#!/usr/bin/env node
/**
 * 启动界面。
 *
 *   node bin/serve.mjs                     默认 4321，只绑 127.0.0.1，无需令牌
 *   node bin/serve.mjs --port 8080         换端口
 *   node bin/serve.mjs --host 0.0.0.0      绑定所有网卡（局域网可访问），自动生成令牌
 *   node bin/serve.mjs --no-open           不自动开浏览器
 *   node bin/serve.mjs --no-token          关掉令牌（仅在你完全信任网络时）
 *
 * ⚠️ 令牌是否启用取决于**绑定地址**，不是请求来源：
 *    一旦绑 0.0.0.0，**所有地址都要令牌**，包括你自己用 127.0.0.1 打开。
 *    这样才不会出现"从本机打开不用认证、从局域网打开要认证"这种半吊子状态。
 */

import { startServer } from '../src/server.js';
import { DEFAULT_DATA_DIR } from '../src/core/config.js';
import { resolveAccessToken } from '../src/core/token.js';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 4321;
const hostArg = args.indexOf('--host');
const host = hostArg >= 0 ? args[hostArg + 1] : '127.0.0.1';
const noOpen = args.includes('--no-open');
const noToken = args.includes('--no-token');

const exposed = host === '0.0.0.0' || host === '::';

/**
 * 令牌按**绑定地址**决定，不按请求来源。
 * 绑 0.0.0.0 时连 127.0.0.1 也要令牌——否则认证就是漏的
 * （同一台机器上的任何进程都能绕过）。宁可多输一次，不留半吊子状态。
 *
 * ★ 令牌**持久化到数据目录根目录**：每次重启换一个的话，发出去的链接就失效了，
 * 用户每次都得重新要一次——这不是安全，是麻烦。
 *
 * ★ 令牌是**服务级**的，不跟房间走。读取时如果根目录没有，会先从旧房间目录
 *   捞回被搬走的那个（历史迁移踩过这个坑），见 src/core/token.js。
 */
async function resolveToken() {
  if (noToken || !exposed) return { token: null, resolved: null };

  const dataDir = process.env.MAROOM_DATA || DEFAULT_DATA_DIR;
  try {
    const resolved = await resolveAccessToken(dataDir);
    return { token: resolved.token, resolved };
  } catch (err) {
    console.warn(`⚠️  令牌无法保存到 ${dataDir}/access-token（${err.message}），本次令牌重启后会变。`);
    return { token: await readOnlyFresh(), resolved: null };
  }
}

/** 兜底：文件写不了时至少本次能用（重启后会变，已在上方警告） */
async function readOnlyFresh() {
  const { randomBytes } = await import('node:crypto');
  return randomBytes(16).toString('hex');
}

const { token, resolved: tokenInfo } = await resolveToken();

const { url, port: actualPort } = await startServer({ port, host, token });

// 令牌从旧房间目录捞回来时必须说一声：这说明历史迁移搬错过它，
// 而且这次没换令牌（老板的链接还能用）。
if (tokenInfo?.recoveredFrom) {
  console.log(`⚠️  根目录没有 access-token，已从 ${tokenInfo.recoveredFrom} 恢复（令牌未变）。`);
}

console.log(`房间界面已启动：${url}`);
if (exposed) {
  console.log('');
  if (token) {
    console.log('局域网访问链接（含一次性令牌，只需点一次，之后走 Cookie）：');
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) {
          console.log(`  http://${a.address}:${actualPort}/?t=${token}   (${name})`);
        }
      }
    }
    console.log('');
    console.log('令牌只打在这里，不会显示在页面上。不带令牌的请求一律 401。');
    console.log('⚠️  令牌属于这个服务（端口），不属于任何房间；切换房间不会改变它。');
  } else {
    console.log('⚠️  已用 --no-token 关闭访问令牌。');
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) {
          console.log(`  http://${a.address}:${actualPort}/   (${name})`);
        }
      }
    }
    console.log('⚠️  同一网络内任何人都能操作这些 agent。');
  }
  console.log('⚠️  用 http:// 打开，不要用 https:// —— 本地服务没有证书。');
  console.log('⚠️  演示完请 Ctrl+C 关掉。');
} else {
  console.log('如需从其他设备访问，加 --host 0.0.0.0（会自动生成访问令牌）');
}
console.log('');
// ★ 打印**绝对路径**，不只是 "~/.multiagent-chat"。
// 两个人同时起服务时，缩写看不出来谁在用哪份数据——撞上了就是写坏数据。
const dataDir = process.env.MAROOM_DATA || DEFAULT_DATA_DIR;
const isDefaultData = !process.env.MAROOM_DATA;
console.log(`按 Ctrl+C 停止。数据目录：${resolve(dataDir)}`);
if (isDefaultData) {
  console.log('⚠️  这是默认数据目录（真实数据）。测试请设 MAROOM_DATA=/tmp/xxx。');
} else {
  console.log(`   （由 MAROOM_DATA 指定，非默认目录）`);
}
// 网页打不开时最可能的原因是"这个终端关了/进程没了"。
// 用户看到的第一反应应该是"重跑这条命令"，而不是怀疑软件坏了。
console.log('');
console.log(`💡 如果网页打不开了，重新运行这条命令即可：`);
console.log(`   node bin/serve.mjs${process.argv.slice(2).filter((a) => a !== '--no-open').join(' ').replace(/^/, ' ')}`);
if (token) {
  console.log('   访问令牌已保存，重启后链接不变。');
}

if (!noOpen) openBrowser(url);

function openBrowser(target) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  try {
    const p = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch { /* 无浏览器环境，忽略 */ }
}
