#!/usr/bin/env node
/**
 * M1 可运行版本：终端里的多 agent 房间。
 *
 *   npx . --demo            一键演示（不需要任何配置）
 *   npx .                   进入交互模式
 *
 * 这是内核的可体验外壳。Electron 界面是后续步骤，两者共用同一套 core/。
 */

import { createInterface } from 'node:readline';

import { loadConfig, buildRoom, DEFAULT_DATA_DIR } from '../src/core/config.js';
import { availableTiers } from '../src/core/probe.js';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', grey: '\x1b[90m',
};

const DATA_DIR = DEFAULT_DATA_DIR;

function colorFor(name) {
  const palette = [C.cyan, C.magenta, C.green, C.yellow, C.blue];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % palette.length;
  return palette[h];
}

const HELP = `${C.bold}可用命令${C.reset}
  @名字 内容     发言并点名（例：@lead 把这件事拆一下）
  纯文字         直接发言，不点名（房间会停住等下一步）
  /board         看任务看板
  /roster        看成员名册
  /who           看成员与权限档位
  /stop          停止房间当前所有活动
  /interrupt     打断正在发言的人（保留已输出）
  /history       看最近消息
  /help          本帮助
  /quit          退出`;

async function main() {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');

  const cfg = await loadConfig(DATA_DIR);
  const events = [];

  const onEvent = (ev) => {
    events.push(ev);
    switch (ev.type) {
      case 'turn.start':
        process.stdout.write(`\n${C.grey}─── ${ev.agentId} 开始 ───${C.reset}\n`);
        break;
      case 'text':
        if (ev.text) process.stdout.write(ev.text);
        break;
      case 'message': {
        const m = ev.message;
        if (m.senderId === 'human') break;
        process.stdout.write(`\n${C.grey}   （${(m.durationMs / 1000).toFixed(1)}s）${C.reset}\n`);
        break;
      }
      case 'usage':
        break;
      case 'action.results':
        for (const r of ev.results) {
          if (r.ok) console.log(`${C.green}   ✓ ${r.label}${r.detail ? `：${r.detail}` : ''}${C.reset}`);
          else console.log(`${C.red}   ✗ ${r.label}：${r.reason}${C.reset}`);
        }
        break;
      case 'task.created':
        console.log(`${C.blue}   [新任务] ${ev.task.id} ${ev.task.title} → ${ev.task.assignee ?? '未指派'}${C.reset}`);
        break;
      case 'task.updated':
        console.log(`${C.blue}   [任务更新] ${ev.id} ${JSON.stringify(ev.patch)}${C.reset}`);
        break;
      case 'notice':
        console.log(`${ev.level === 'warn' ? C.yellow : C.grey}   ⚠ ${ev.text}${C.reset}`);
        break;
      case 'failure':
        console.log(`${C.red}   ✗ ${ev.agentId} ${ev.reason}${ev.detail ? `：${ev.detail.slice(0, 200)}` : ''}${C.reset}`);
        break;
      case 'context.nearLimit':
        console.log(`${C.yellow}   ⚠ 上下文接近上限（${(ev.ratio * 100).toFixed(0)}%），下一轮将压缩${C.reset}`);
        break;
      case 'compact.start':
        console.log(`${C.grey}   ⋯ 压缩上下文中${C.reset}`);
        break;
      case 'compact.done':
        console.log(`${C.green}   ✓ 已压缩并轮换会话${C.reset}`);
        break;
      case 'idle':
        if (ev.waitingForHuman) console.log(`${C.grey}   （等待人类）${C.reset}`);
        break;
      case 'failure_done':
        break;
      default:
        break;
    }
  };

  const { room, store, members, warnings } = await buildRoom({ cfg, dataDir: DATA_DIR, onEvent });
  for (const w of warnings) console.error(`${C.yellow}${w}${C.reset}`);

  const nameOf = (id) => (id === 'human' ? '我' : (members.find((m) => m.id === id)?.name ?? id));

  console.log(`${C.bold}${cfg.name}${C.reset}  ${C.grey}${members.map((m) => `${m.name}(${m.backend}/${m.tier})`).join('  ')}${C.reset}`);
  console.log(`${C.grey}输入 /help 看命令。用 @名字 点名让谁发言。${C.reset}\n`);

  if (demo) {
    console.log(`${C.grey}== 演示：让头头拆一个任务并派给成员 ==${C.reset}`);
    await room.humanSay('@lead 把「用一句话描述海洋」拆成一个子任务，派给 bob 完成。');
    await room.drain();
    printBoard(store);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.cyan}你 > ${C.reset}` });
  rl.prompt();

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (!line) return rl.prompt();

    if (line === '/quit' || line === '/exit') return rl.close();
    if (line === '/help') { console.log(HELP); return rl.prompt(); }
    if (line === '/board') { printBoard(store); return rl.prompt(); }
    if (line === '/roster') { printRoster(store, members); return rl.prompt(); }
    if (line === '/who') {
      for (const m of members) {
        console.log(`  ${colorFor(m.name)}${m.name}${C.reset}  ${m.backend}  档位=${m.tier}  角色=${m.role}  可选档位=${availableTiers(m.backend).join('/')}`);
      }
      return rl.prompt();
    }
    if (line === '/stop') { room.stop(); console.log(`${C.yellow}已停止${C.reset}`); return rl.prompt(); }
    if (line === '/interrupt') { console.log(room.interrupt() ? `${C.yellow}已打断${C.reset}` : '当前无人发言'); return rl.prompt(); }
    if (line === '/history') {
      for (const m of store.messages.slice(-15)) {
        console.log(`${C.grey}${nameOf(m.senderId)}：${C.reset}${m.body.slice(0, 160)}`);
      }
      return rl.prompt();
    }

    rl.pause();
    try {
      const r = await room.humanSay(line);
      if (r.unknown.length) console.log(`${C.yellow}未找到 ${r.unknown.map((u) => '@' + u).join(' ')}${C.reset}`);
      await room.drain();
    } catch (err) {
      console.error(`${C.red}出错：${err.message}${C.reset}`);
    }
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(`\n${C.grey}数据保存在 ${DATA_DIR}${C.reset}`);
    process.exit(0);
  });
}

function printBoard(store) {
  const tasks = [...store.tasks.values()];
  if (!tasks.length) return console.log(`${C.grey}（暂无任务）${C.reset}`);
  console.log(`${C.bold}任务看板${C.reset}`);
  const order = ['待办', '进行中', '待确认', '完成', '阻塞'];
  for (const status of order) {
    const group = tasks.filter((t) => t.status === status);
    if (!group.length) continue;
    console.log(`  ${C.blue}${status}${C.reset}`);
    for (const t of group) {
      console.log(`    ${t.id}  ${t.title}   → ${t.assignee ?? '未指派'}`);
    }
  }
}

function printRoster(store, members) {
  console.log(`${C.bold}成员名册${C.reset}`);
  for (const m of members) {
    const r = store.roster.get(m.id);
    const duty = r?.humanDuties ?? r?.selfDuties ?? '（未填写）';
    console.log(`  ${colorFor(m.name)}${m.name}${C.reset}（${m.role === 'leader' ? '头头' : '成员'}）：${duty}`);
  }
}

main().catch((err) => {
  console.error(`${C.red}${err.stack}${C.reset}`);
  process.exit(1);
});
