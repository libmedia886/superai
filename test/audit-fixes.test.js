/**
 * 代码审查修复回归测试：覆盖真实调用链中单测曾遗漏的 6 类问题。
 *
 *  1. 工具执行期间看门狗静默窗口真正放宽（不再被 STALL_MS=90s 硬钳死）
 *  2. room._sessions 缓存随上下文轮换（_compact）与热切后端（/api/member/update）同步清理
 *  3. 网页热加成员 / 头头造人补齐 sharedDir / netgetPath / forbiddenRoots，且不静默丢弃新建表单字段
 *  4. opencode 共享目录改用路径白名单（不再 external_directory:'allow' 击穿沙箱），
 *     opencode 与 codex 工具事件标准化上报
 *  5. worktree 验收闭环：diff 含未跟踪新文件、合并失败后可重试、冲突回退分支名持久化
 *  6. netget 拦截本机/内网 SSRF、/api/cabtier 支持 read、stop() 不残留 resumeTarget
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { HealthTracker, STALL_MS } from '../src/core/health.js';
import { Room, TOOL_FLIGHT_SILENCE_MS } from '../src/core/room.js';
import { Store } from '../src/core/store.js';
import { RoomManager } from '../src/core/sessions.js';
import { startServer } from '../src/server.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { OpencodeAdapter } from '../src/adapters/opencode.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { createTaskWorktree, diffAgainstBase } from '../src/core/worktree.js';

const exec = promisify(execFile);
const NETGET = fileURLToPath(new URL('../bin/netget', import.meta.url));

function closeServer(server) {
  server.closeAllConnections?.();
  server.close();
}

const git = (cwd, args) => new Promise((resolve) => {
  execFile('git', args, { cwd }, (err, stdout, stderr) => {
    resolve({ ok: !err, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() });
  });
});

async function makeGitRepo() {
  const base = await mkdtemp(join(tmpdir(), 'fix-wt-'));
  const repo = join(base, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@t']);
  await git(repo, ['config', 'user.name', 't']);
  await writeFile(join(repo, 'a.txt'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'init']);
  return { base, repo };
}

async function makeHttpServer(roomCfg = null) {
  const dir = await mkdtemp(join(tmpdir(), 'fix-srv-'));
  await mkdir(join(dir, 'rooms', 'r-a', 'agents', 'a'), { recursive: true });
  await writeFile(join(dir, 'rooms', 'r-a', 'room.json'), JSON.stringify(roomCfg ?? {
    name: '回归测试',
    goal: '',
    registry: [],
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly' }],
  }));
  await writeFile(join(dir, 'rooms.json'), JSON.stringify({
    version: 1,
    activeRoomId: 'r-a',
    rooms: [{ id: 'r-a', name: '回归测试', createdAt: new Date().toISOString() }],
  }));
  const srv = await startServer({ port: 0, dataDir: dir });
  return { ...srv, dir };
}

/* ---------- 1. 看门狗工具期静默窗口真正放宽 ---------- */

test('★ 工具执行期 windowMs 真正放宽静默窗口（不被 STALL_MS=90s 钳死）', () => {
  const h = new HealthTracker();
  const t0 = 1_000_000;
  h.touch('a', t0);

  const turnTimeout = 20 * 60_000;
  // 常规（无工具执行）：91 秒即判卡死
  assert.equal(h.isStalled('a', { timeoutMs: turnTimeout, now: t0 + STALL_MS + 1000 }), true);

  // 工具执行期：传 windowMs = 10 分钟 → 3 分钟时绝不误杀，超过 10 分钟才判死
  assert.equal(
    h.isStalled('a', { timeoutMs: turnTimeout, windowMs: TOOL_FLIGHT_SILENCE_MS, now: t0 + 180_000 }),
    false,
    '工具跑了 3 分钟不应被 90s 窗口误杀',
  );
  assert.equal(
    h.isStalled('a', { timeoutMs: turnTimeout, windowMs: TOOL_FLIGHT_SILENCE_MS, now: t0 + TOOL_FLIGHT_SILENCE_MS + 1000 }),
    true,
    '超过 10 分钟工具静默窗口仍应判死',
  );

  // 硬上限兜底：若本轮上限仅 5 分钟，工具窗口也受 5 分钟封顶
  assert.equal(
    h.isStalled('a', { timeoutMs: 300_000, windowMs: TOOL_FLIGHT_SILENCE_MS, now: t0 + 301_000 }),
    true,
    '工具静默窗口不能超过本轮硬上限',
  );
});

/* ---------- 2. room._sessions 缓存随轮换 / 换后端同步清理 ---------- */

test('★ 上下文轮换（_compact）后下一轮收到的 sessionId 必须是 null（不能复用旧缓存）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fix-compact-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();

  const seenSessionIds = [];
  const HIGH_USAGE = { inputTokens: 160_000, outputTokens: 100, contextWindow: 200_000 };
  const HANDOFF = [
    '收到。',
    '```handoff',
    '正在做：验证会话轮换',
    '已定：轮换必须清掉内存缓存',
    '待办：开新会话',
    '我的立场：绝不把摘要塞进旧会话',
    '```',
  ].join('\n');

  let turn = 0;
  const room = new Room({
    id: 'r', name: 'r', goal: '测试',
    members: [{ id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['lead'] }],
    store,
    resolveAdapter: () => ({
      async run({ prompt, sessionId, onEvent }) {
        turn += 1;
        seenSessionIds.push(sessionId);
        const sid = turn <= 2 ? 'sess-old-1' : 'sess-new-2';
        onEvent?.({ type: 'meta', sessionId: sid });
        return {
          text: prompt.includes('请先交接') ? HANDOFF : '好的',
          sessionId: sid,
          reason: 'completed',
          usage: HIGH_USAGE,
        };
      },
    }),
  });

  // Turn 1: 建立 sess-old-1 并触及 70% 水位
  await room.humanSay('@lead 第一轮');
  await room.drain();
  // Turn 2: 带着 sess-old-1 收到 ASK 并回复 handoff
  await room.humanSay('@lead 第二轮');
  await room.drain();
  // Turn 3: 触发 _compact 轮换，sessionId 必须归零！
  await room.humanSay('@lead 第三轮');
  await room.drain();

  assert.deepEqual(seenSessionIds, [null, 'sess-old-1', null],
    `轮换后的第三轮必须以 sessionId=null 开启新会话，实际序列：${JSON.stringify(seenSessionIds)}`);
});

test('★ 热切后端（/api/member/update）必须清掉 room._sessions，下一轮不能传旧后端的 sessionId', async () => {
  const { server, url, manager } = await makeHttpServer();
  try {
    const seen = [];
    manager.session.room.resolveAdapter = (agent) => ({
      async run({ sessionId, onEvent }) {
        seen.push({ backend: agent.backend, sessionId });
        const sid = `${agent.backend}-sess-1`;
        onEvent?.({ type: 'meta', sessionId: sid });
        return { text: '收到', sessionId: sid, reason: 'completed', usage: null };
      },
    });

    // 先以 claude 跑一轮，在 room._sessions 里种下 claude-sess-1
    await manager.session.room.humanSay('@a 第一轮');
    await manager.session.room.drain();
    assert.deepEqual(seen[0], { backend: 'claude', sessionId: null });

    // 通过 HTTP 接口把后端换成 codex
    const res = await fetch(`${url}/api/member/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'a', patch: { backend: 'codex' } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sessionReset, true);

    // 再跑一轮：新后端 codex 拿到的 sessionId 必须是 null，绝不能是 claude-sess-1
    await manager.session.room.humanSay('@a 换后端后的第一轮');
    await manager.session.room.drain();
    assert.deepEqual(seen[1], { backend: 'codex', sessionId: null },
      `换后端后不能带旧 sessionId，实际：${JSON.stringify(seen[1])}`);
  } finally {
    closeServer(server);
  }
});

/* ---------- 3. 热加成员 / 头头造人上下文补齐与表单字段保留 ---------- */

test('★ 网页热加成员（/api/member）保留所有配置字段并补齐 netgetPath / sharedDir / forbiddenRoots', async () => {
  const { server, url, manager } = await makeHttpServer();
  try {
    const res = await fetch(`${url}/api/member`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'scout',
        backend: 'claude',
        tier: 'write-exec',
        model: 'opus',
        effort: 'high',
        allowedCommands: 'netget',
        timeoutMinutes: '15',
        persona: '查资料专家',
      }),
    });
    assert.equal(res.status, 200, `新建成员应成功，实际 ${res.status}`);

    const m = manager.session.room.members.find((x) => x.name === 'scout');
    assert.ok(m, '新成员应在 room.members 里');
    assert.equal(m.model, 'opus', '新建时填的 model 不能被静默丢弃');
    assert.equal(m.effort, 'high', '新建时填的 effort 不能被静默丢弃');
    assert.deepEqual(m.allowedCommands, ['netget'], '新建时勾的 netget 不能被静默丢弃');
    assert.equal(m.timeoutMinutes, 15, '新建时填的 timeoutMinutes 不能被静默丢弃');
    assert.equal(m.netgetPath, manager.session.netgetPath, '热加成员必须立刻拿到 netgetPath');
    assert.equal(m.sharedDir, manager.session.room.sharedDir, '热加成员必须立刻拿到 sharedDir');
    assert.ok(m.forbiddenRoots?.length > 0, '热加成员必须带上 forbiddenRoots');

    // 直接构建适配器：不能因缺 netgetPath 抛错，且必须带 --add-dir 和绝对路径 netget
    const adapter = new ClaudeAdapter(m);
    const args = adapter.buildArgs();
    assert.ok(args.includes(`Bash(${m.netgetPath}:*)`), `适配器必须放行绝对路径 netget：${args.join(' ')}`);
    assert.ok(args.includes('--add-dir') && args.includes(m.sharedDir), '适配器必须挂上共享目录');
  } finally {
    closeServer(server);
  }
});

test('★ 头头通过 member.create 造人也要补齐 sharedDir / netgetPath / forbiddenRoots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fix-create-'));
  await mkdir(join(dir, 'rooms', 'r-a', 'agents', 'lead'), { recursive: true });
  await writeFile(join(dir, 'rooms', 'r-a', 'room.json'), JSON.stringify({
    name: '造人测试', goal: '', registry: [], aiCabTier: 'write-exec',
    members: [{ id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly' }],
  }));
  await writeFile(join(dir, 'rooms.json'), JSON.stringify({
    version: 1, activeRoomId: 'r-a',
    rooms: [{ id: 'r-a', name: '造人测试', createdAt: new Date().toISOString() }],
  }));

  const mgr = await new RoomManager({ dataDir: dir, onEvent: () => {} }).init();
  mgr.session.room.resolveAdapter = () => ({
    async run() {
      return {
        text: '加个助手\n```action\n{"action":"member.create","name":"helper","backend":"claude","tier":"write-exec","reason":"需要一个查资料的成员"}\n```',
        reason: 'completed',
      };
    },
  });

  await mgr.session.room.humanSay('@lead 加个人');
  await mgr.session.room.drain();

  const helper = mgr.session.room.members.find((m) => m.name === 'helper');
  assert.ok(helper, '应成功造出 helper');
  assert.equal(helper.sharedDir, mgr.session.room.sharedDir);
  assert.equal(helper.netgetPath, mgr.session.netgetPath);
  assert.ok(helper.forbiddenRoots?.length > 0);
});

/* ---------- 4. opencode 路径白名单沙箱 + opencode/codex 工具事件对齐 ---------- */

test('★ opencode 带 sharedDir 时绝不写 external_directory:"allow"，只精确放行共享目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fix-oc-'));
  const sharedDir = join(dir, 'shared');
  const cwd = join(dir, 'agent');

  for (const tier of ['read', 'write', 'write-exec']) {
    const adapter = new OpencodeAdapter({ backend: 'opencode', tier, sharedDir });
    const cfg = await adapter.prepare(cwd);
    assert.notEqual(cfg.permission.external_directory, 'allow', `${tier} 档绝不能把 external_directory 整片放开`);
    assert.equal(typeof cfg.permission.external_directory, 'object');
    assert.equal(cfg.permission.external_directory['*'], 'deny', '默认必须拒绝全部外部目录');
    assert.equal(cfg.permission.external_directory[sharedDir], 'allow');
    assert.equal(cfg.permission.external_directory[`${sharedDir}/**`], 'allow');
  }

  // readonly 档不放行任何外部目录
  const ro = new OpencodeAdapter({ backend: 'opencode', tier: 'readonly', sharedDir });
  const roCfg = await ro.prepare(cwd);
  assert.equal(roCfg.permission.external_directory, 'deny');
});

test('★ opencode 与 codex 工具事件标准化：tool/path/command/tool.result 完整进入 Room.toolLog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fix-cli-tools-'));

  // 1) 假 opencode CLI：输出真实格式的 tool_use + step_finish
  const fakeOc = join(dir, 'fake-opencode.sh');
  await writeFile(fakeOc, `#!/bin/bash
cat >/dev/null
echo '{"type":"step_start","sessionID":"ses-oc-1"}'
echo '{"type":"tool_use","sessionID":"ses-oc-1","part":{"type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"${dir}/out.txt"}}}}'
echo '{"type":"text","sessionID":"ses-oc-1","part":{"text":"写好了"}}'
echo '{"type":"step_finish","sessionID":"ses-oc-1","part":{"tokens":{"input":10,"output":5}}}'
`, { mode: 0o755 });
  await chmod(fakeOc, 0o755);

  const ocEvents = [];
  const oc = new OpencodeAdapter({ backend: 'opencode', tier: 'write', bin: fakeOc });
  await oc.run({ prompt: 'hi', cwd: dir, sessionId: null, onEvent: (e) => ocEvents.push(e) });
  const ocTool = ocEvents.find((e) => e.type === 'tool');
  assert.ok(ocTool, 'opencode 必须发出 tool 事件');
  assert.equal(ocTool.tool, 'write', 'tool 字段名必须与 room.js 对齐（不能是 undefined → unknown）');
  assert.equal(ocTool.path, `${dir}/out.txt`);
  assert.ok(ocEvents.some((e) => e.type === 'tool.result'), '工具完成后要发 tool.result 清 _toolFlight');

  // 2) 假 codex CLI：输出 item.started + item.completed（command_execution & file_change）
  const fakeCx = join(dir, 'fake-codex.sh');
  await writeFile(fakeCx, `#!/bin/bash
cat >/dev/null
echo '{"type":"thread.started","thread_id":"th-1"}'
echo '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls -la"}}'
echo '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls -la","exit_code":0}}'
echo '{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"app.js","kind":"update"}]}}'
echo '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"搞定"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
`, { mode: 0o755 });
  await chmod(fakeCx, 0o755);

  const cxEvents = [];
  const cx = new CodexAdapter({ backend: 'codex', tier: 'write-exec', bin: fakeCx });
  await cx.run({ prompt: 'hi', cwd: dir, sessionId: null, onEvent: (e) => cxEvents.push(e) });
  const cxTools = cxEvents.filter((e) => e.type === 'tool');
  assert.equal(cxTools.length, 2, '同一 item.id 的 started + completed 不能重复计数');
  assert.equal(cxTools[0].tool, 'Bash');
  assert.equal(cxTools[0].command, 'ls -la');
  assert.equal(cxTools[1].tool, 'Edit');
  assert.equal(cxTools[1].path, 'app.js');
  assert.ok(cxEvents.some((e) => e.type === 'tool.result'));
});

/* ---------- 5. Worktree 验收闭环：未跟踪新文件 + 合并重试 + 回退分支名 ---------- */

test('★ diffAgainstBase 必须包含未跟踪的新建文件（否则只新建文件的任务看不到改动与合并按钮）', async () => {
  const { base, repo } = await makeGitRepo();
  const c = await createTaskWorktree({
    repoPath: repo, baseBranch: 'main', taskId: 'T-NEW',
    worktreesRoot: join(base, 'wt'), registry: [{ path: repo }],
  });
  assert.equal(c.ok, true);

  // 只新建文件，不修改任何已跟踪文件
  await writeFile(join(c.worktree, 'brand-new.txt'), 'hello brand new file\n');
  const d = await diffAgainstBase(c.worktree, 'main');
  assert.ok(d.files.some((f) => f.includes('brand-new.txt')), `应列出未跟踪新文件，实际：${JSON.stringify(d.files)}`);
  assert.match(d.patch, /hello brand new file/, 'patch 应包含新文件内容');
});

test('★ 合并冲突/失败后，修完主仓库再次点合并必须成功（不能卡死在 400 没有可合并的改动）', async () => {
  const { base, repo } = await makeGitRepo();
  const { server, url, manager } = await makeHttpServer({
    name: '合并重试', goal: '', registry: [{ path: repo }],
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'write' }],
  });
  try {
    const wt = await createTaskWorktree({
      repoPath: repo, baseBranch: 'main', taskId: 'T-RETRY',
      worktreesRoot: join(base, 'wt'), registry: [{ path: repo }],
    });
    assert.equal(wt.ok, true);
    await writeFile(join(wt.worktree, 'feature.txt'), 'new feature\n');
    await manager.session.store.createTask({
      id: 'T-RETRY', title: '新功能', assignee: 'a', status: '进行中',
      createdBy: 'human', repo, baseBranch: 'main', branch: wt.branch, worktree: wt.worktree,
    });

    // 在主仓库制造一个冲突性的未提交覆盖（同名未跟踪文件，让 merge 失败返回 409）
    await writeFile(join(repo, 'feature.txt'), 'dirty conflict\n');
    const first = await fetch(`${url}/api/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'T-RETRY', action: 'merge' }),
    });
    assert.equal(first.status, 409, '主仓库有冲突时首次合并应返回 409');

    // 人清理完主仓库的阻塞文件，再次点合并
    const { rm } = await import('node:fs/promises');
    await rm(join(repo, 'feature.txt'), { force: true });

    const second = await fetch(`${url}/api/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'T-RETRY', action: 'merge' }),
    });
    assert.equal(second.status, 200, `清理完主仓库后重试合并必须 200（不能报 400 无改动）`);
    assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'new feature\n');
  } finally {
    closeServer(server);
  }
});

test('★ 任务分支名冲突回退（task/T-001-xxxx）后，task.branch 落盘且验收合并用真实分支名', async () => {
  const { base, repo } = await makeGitRepo();
  // 先在主仓库预占 task/T-001，迫使 createTaskWorktree 走回退分支名
  await git(repo, ['branch', 'task/T-001']);

  const { server, url, manager } = await makeHttpServer({
    name: '分支回退', goal: '', registry: [{ path: repo }],
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'write' }],
  });
  try {
    manager.session.room.resolveAdapter = () => ({
      async run() {
        return {
          text: '开活\n```action\n{"action":"task.create","title":"测分支回退","repo":'
            + JSON.stringify(repo) + '}\n```',
          reason: 'completed',
        };
      },
    });
    await manager.session.room.humanSay('@a 开任务');
    await manager.session.room.drain();

    const t = manager.session.store.tasks.get('T-001');
    assert.ok(t?.branch && t.branch !== 'task/T-001' && t.branch.startsWith('task/T-001-'),
      `应保存回退后的真实分支名，实际：${t?.branch}`);

    await writeFile(join(t.worktree, 'fallback-ok.txt'), 'ok from fallback branch\n');
    const res = await fetch(`${url}/api/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'T-001', action: 'merge' }),
    });
    assert.equal(res.status, 200, '用回退分支名验收合并必须成功');
    assert.equal(await readFile(join(repo, 'fallback-ok.txt'), 'utf8'), 'ok from fallback branch\n');
  } finally {
    closeServer(server);
  }
});

/* ---------- 6. netget SSRF 防护 + /api/cabtier read + stop() resumeTarget 一致性 ---------- */

test('★ netget 拦截本机回环 / 云元数据 / 内网 / Tailscale 地址（防 SSRF）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fix-ssrf-'));
  const blocked = [
    'http://127.0.0.1:4321/api/export',
    'http://localhost:4340/api/health',
    'http://[::1]:4321/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://172.16.9.120:4340/',
    'http://192.168.1.1/',
    'http://100.64.0.10:4340/',
    'http://2130706433/',
    'http://0x7f000001/',
  ];
  for (const u of blocked) {
    let code = 0;
    let stderr = '';
    try {
      await exec(NETGET, [u], { cwd: dir, timeout: 10_000 });
    } catch (err) {
      code = err.code ?? -1;
      stderr = err.stderr ?? '';
    }
    assert.equal(code, 2, `${u} 必须被拒（exit 2），实际 ${code}`);
    assert.match(stderr, /禁止访问本机与内网地址/);
  }
});

test('★ /api/cabtier 支持 read 档', async () => {
  const { server, url, manager } = await makeHttpServer();
  try {
    const res = await fetch(`${url}/api/cabtier`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'read' }),
    });
    assert.equal(res.status, 200);
    assert.equal(manager.session.room.aiCabTier, 'read');
  } finally {
    closeServer(server);
  }
});

test('★ 发言中途点 stop() → pauseReason=stopped 且 resumeTarget 必须为 null（不变量守恒）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fix-stop-inv-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  let release;
  const gate = new Promise((r) => { release = r; });

  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: 'a', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['a'] }],
    store,
    resolveAdapter: () => ({
      async run({ onEvent, signal }) {
        onEvent?.({ type: 'text', text: '半截', done: false });
        await Promise.race([gate, new Promise((res) => signal?.addEventListener('abort', res, { once: true }))]);
        return { text: '半截', reason: 'interrupted' };
      },
    }),
  });

  await room.humanSay('@a 说点什么');
  const draining = room.drain();
  await new Promise((r) => setTimeout(r, 30));
  room.stop();
  release();
  await draining;

  assert.equal(room.pauseReason?.reason, 'stopped');
  assert.equal(room.resumeTarget, null, 'stop() 之后 resumeTarget 必须为 null');
  assert.equal(Boolean(room.resumeTarget), String(room.pauseReason?.detail ?? '').includes('接着做完'));
});

/* ---------- 7. CLI JSON 报错透传 + Codex 自定义 provider env_key ---------- */

test('★ codex / claude 的 JSON 报错（如缺 env_key / 400 模型不支持）必须透传到 error 与 pauseReason', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fix-err-'));

  // codex: stdout JSON 报错、stderr 为空
  const fakeCx = join(dir, 'fake-codex-err.sh');
  await writeFile(fakeCx, `#!/bin/bash
cat >/dev/null
echo '{"type":"thread.started","thread_id":"th-err"}'
echo '{"type":"error","message":"Missing environment variable: SUPERAI_API_KEY."}'
echo '{"type":"turn.failed","error":{"message":"Missing environment variable: SUPERAI_API_KEY."}}'
exit 1
`, { mode: 0o755 });
  await chmod(fakeCx, 0o755);

  const cx = new CodexAdapter({ backend: 'codex', tier: 'read', bin: fakeCx });
  const cxRes = await cx.run({ prompt: 'hi', cwd: dir, sessionId: null });
  assert.equal(cxRes.reason, 'failed');
  assert.match(cxRes.error ?? '', /SUPERAI_API_KEY/, 'codex JSON 错误必须透传到 error 字段');

  // claude: result is_error=true
  const fakeCl = join(dir, 'fake-claude-err.sh');
  await writeFile(fakeCl, `#!/bin/bash
cat >/dev/null
echo '{"type":"system","subtype":"init","session_id":"cl-err"}'
echo '{"type":"result","subtype":"success","is_error":true,"result":"API Error: 400 unknown provider for model bad-model"}'
exit 1
`, { mode: 0o755 });
  await chmod(fakeCl, 0o755);

  const cl = new ClaudeAdapter({ backend: 'claude', tier: 'readonly', bin: fakeCl });
  const clRes = await cl.run({ prompt: 'hi', cwd: dir, sessionId: null });
  assert.equal(clRes.reason, 'failed');
  assert.equal(clRes.text, '', 'API 错误不能混进正常正文 text');
  assert.match(clRes.error ?? '', /unknown provider for model bad-model/);

  // 挂进 Room：停因文案必须带上真实报错，不能让用户盲猜
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const room = new Room({
    id: 'r', name: 't',
    members: [{ id: 'a', name: '小李子', role: 'leader', backend: 'codex', tier: 'read', cwd: dir, aliases: ['小李子'] }],
    store,
    resolveAdapter: () => cx,
  });
  room.maxRetries = 0;
  await room.humanSay('@小李子 你好');
  await room.drain();
  assert.equal(room.pauseReason?.reason, 'error');
  assert.match(room.pauseReason?.detail ?? '', /SUPERAI_API_KEY/, '状态栏暂停原因必须显示具体错误');
});

test('★ childEnv 为 codex 放行 config.toml 里声明的自定义 env_key，且不漏给其他后端', async () => {
  const { childEnv } = await import('../src/core/runner.js');
  const dir = await mkdtemp(join(tmpdir(), 'fix-cx-env-'));
  await writeFile(join(dir, 'config.toml'), '[model_providers.superai]\nenv_key = "SUPERAI_API_KEY"\n');

  const saved = { CODEX_HOME: process.env.CODEX_HOME, SUPERAI_API_KEY: process.env.SUPERAI_API_KEY };
  try {
    process.env.CODEX_HOME = dir;
    process.env.SUPERAI_API_KEY = 'sk-test-123';
    assert.equal(childEnv({}, { backend: 'codex' }).SUPERAI_API_KEY, 'sk-test-123');
    assert.equal('SUPERAI_API_KEY' in childEnv({}, { backend: 'claude' }), false, '绝不漏给 claude');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
