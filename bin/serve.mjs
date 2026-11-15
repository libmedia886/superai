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
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

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
 */
const token = noToken ? null : (exposed ? randomBytes(16).toString('hex') : null);

const { url, port: actualPort } = await startServer({ port, host, token });

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
console.log('按 Ctrl+C 停止。数据保存在 ~/.multiagent-chat（可用 MAROOM_DATA 覆盖）');

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
