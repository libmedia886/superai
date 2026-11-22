/**
 * SuperAI v2 协作引擎、安全文件浏览与 HTTP/SSE 契约测试。
 *
 * 覆盖：
 *  1. 成员自由互 @（allowPeerMentions）单测与 Room 端到端接力
 *  2. permissionSentence（full / read）与 buildPrompt 协作规则、member.create 提示
 *  3. classifyTool 识别 agy 工具名
 *  4. planMemberCreation 支持 agy 与后端档位归一化收敛
 *  5. 新房间默认开放配置（aiCabTier=full, allowPeerMentions=true）
 *  6. HTTP API：/api/room-settings、/api/cabtier、/api/registry/remove、
 *     /api/backends、/api/files、/api/file（含目录穿越与符号链接逃逸 403 防护）、/api/member
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyMentionPolicy } from '../src/core/mentions.js';
import { planMemberCreation } from '../src/core/members.js';
import { buildPrompt, permissionSentence } from '../src/core/prompt.js';
import { classifyTool, Room } from '../src/core/room.js';
import { Store } from '../src/core/store.js';
import { listRoomFiles, readRoomFile } from '../src/core/files.js';
import { createRoom } from '../src/core/rooms.js';
import { buildRoom } from '../src/core/config.js';
import { TIER } from '../src/core/probe.js';
import { startServer } from '../src/server.js';

function closeServer(server) {
  server.closeAllConnections?.();
  server.close();
}

async function fetchInit(url) {
  const ac = new AbortController();
  let text = '';
  try {
    const res = await fetch(`${url}/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    while (!text.includes('data: ')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
  } finally {
    ac.abort();
  }
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  assert.ok(line, `应收到 SSE room.init，实际：${text.slice(0, 120)}`);
  return JSON.parse(line.slice(6));
}

async function makeHttpServer(roomCfg = null) {
  const dir = await mkdtemp(join(tmpdir(), 'v2-api-'));
  await mkdir(join(dir, 'rooms', 'r-a', 'agents', 'lead'), { recursive: true });
  await writeFile(join(dir, 'rooms', 'r-a', 'room.json'), JSON.stringify(roomCfg ?? {
    name: 'v2 协作房间',
    goal: '初始目标',
    registry: [],
    aiCabTier: 'full',
    allowPeerMentions: true,
    headPassiveWake: true,
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'full' },
    ],
  }, null, 2));
  await writeFile(join(dir, 'rooms.json'), JSON.stringify({
    version: 1,
    activeRoomId: 'r-a',
    rooms: [{ id: 'r-a', name: 'v2 协作房间', createdAt: new Date().toISOString() }],
  }, null, 2));
  const srv = await startServer({ port: 0, dataDir: dir });
  return { ...srv, dir };
}

/* ---------- 1. allowPeerMentions：单测 + Room 端到端 ---------- */

test('allowPeerMentions=true 时成员互 @ 不报越权；false 时仍拦截并回报越权', () => {
  const open = applyMentionPolicy({
    targets: ['carol', 'lead', 'human'],
    actorRole: 'member',
    leaderIds: ['lead'],
    humanId: 'human',
    allowPeerMentions: true,
  });
  assert.deepEqual(open.allowed, ['carol', 'lead', 'human']);
  assert.deepEqual(open.overreach, []);

  const strict = applyMentionPolicy({
    targets: ['carol', 'lead', 'human'],
    actorRole: 'member',
    leaderIds: ['lead'],
    humanId: 'human',
    allowPeerMentions: false,
  });
  assert.deepEqual(strict.allowed, ['lead', 'human']);
  assert.deepEqual(strict.overreach, ['carol']);
});

test('Room 端到端：allowPeerMentions 决定成员能否直接 @ 其他成员接力', async () => {
  const makePeerRoom = async (allowPeerMentions) => {
    const dir = await mkdtemp(join(tmpdir(), 'v2-peer-'));
    const store = new Store(join(dir, 'room.jsonl'));
    await store.load();
    const events = [];
    const spoke = [];
    const room = new Room({
      id: 'r',
      name: '协作房',
      goal: '测试互 @',
      allowPeerMentions,
      headPassiveWake: false,
      members: [
        { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'full', cwd: dir, aliases: ['lead'] },
        { id: 'bob', name: 'bob', role: 'member', backend: 'agy', tier: 'full', cwd: dir, aliases: ['bob'] },
        { id: 'carol', name: 'carol', role: 'member', backend: 'codex', tier: 'full', cwd: dir, aliases: ['carol'] },
      ],
      store,
      resolveAdapter: (agent) => ({
        async run() {
          spoke.push(agent.id);
          return {
            text: agent.id === 'bob' ? '@carol 请帮我验证这个接口' : '收到，验证完成。',
            reason: 'completed',
          };
        },
      }),
      onEvent: (ev) => events.push(ev),
    });
    return { room, events, spoke, dir };
  };

  // 开放模式：bob 可以直接 @carol，carol 真的发言且没有越权警告
  const open = await makePeerRoom(true);
  try {
    await open.room.humanSay('@bob 开始吧');
    await open.room.drain();
    assert.deepEqual(open.spoke, ['bob', 'carol']);
    assert.equal(open.events.some((e) => e.type === 'notice' && /越权/.test(e.text ?? '')), false);
  } finally {
    await rm(open.dir, { recursive: true, force: true });
  }

  // 严格模式：bob @carol 被拦截并回报越权，carol 不会发言
  const strict = await makePeerRoom(false);
  try {
    await strict.room.humanSay('@bob 开始吧');
    await strict.room.drain();
    assert.deepEqual(strict.spoke, ['bob']);
    assert.equal(strict.events.some((e) => e.type === 'notice' && /越权/.test(e.text ?? '')), true);
  } finally {
    await rm(strict.dir, { recursive: true, force: true });
  }
});

/* ---------- 2. prompt.js：permissionSentence & buildPrompt ---------- */

test('permissionSentence 为 full 和 read 档生成准确权限说明', () => {
  const full = permissionSentence({ tier: 'full', backend: 'agy' });
  assert.match(full, /完全开放模式/);
  assert.match(full, /无目录限制/);
  assert.match(full, /房间共享目录/);

  const read = permissionSentence({ tier: 'read', backend: 'codex' });
  assert.match(read, /可读模式/);
  assert.match(read, /读取和搜索文件/);
  assert.match(read, /不能修改文件/);
  assert.match(read, /不能执行命令/);
});

test('buildPrompt 按 allowPeerMentions 生成成员协作规则，并向头头展示 4 后端与 full tier', () => {
  const fakeStore = { roster: new Map(), tasks: new Map(), messages: [], messagesSince: () => [] };
  const lead = { id: 'lead', name: 'lead', role: 'leader', tier: 'full', backend: 'agy' };
  const bob = { id: 'bob', name: 'bob', role: 'member', tier: 'full', backend: 'claude' };

  const memberOpen = buildPrompt({
    agent: bob,
    room: { name: '房', goal: '完成 v2', members: [lead, bob], allowPeerMentions: true },
    store: fakeStore,
    trigger: { senderId: 'human', body: 'hi' },
  });
  assert.match(memberOpen, /房间已开放自由协作：你可以直接 @ 任何团队成员、头头或老板来协同推进。/);

  const memberStrict = buildPrompt({
    agent: bob,
    room: { name: '房', goal: '完成 v2', members: [lead, bob], allowPeerMentions: false },
    store: fakeStore,
    trigger: { senderId: 'human', body: 'hi' },
  });
  assert.match(memberStrict, /作为成员，你只能 @ 头头和老板，@ 其他成员不会生效。/);

  const leaderPrompt = buildPrompt({
    agent: lead,
    room: { name: '房', goal: '完成 v2', members: [lead, bob], aiCabTier: 'full', allowPeerMentions: true },
    store: fakeStore,
    trigger: { senderId: 'human', body: 'hi' },
  });
  assert.match(leaderPrompt, /agy \/ claude \/ codex \/ opencode/);
  assert.match(leaderPrompt, /"tier":"full"/);
});

/* ---------- 3. classifyTool 识别 agy 工具名 ---------- */

test('classifyTool 正确归类 agy 与既有后端工具名', () => {
  assert.equal(classifyTool('write_to_file'), 'write');
  assert.equal(classifyTool('Write'), 'write');
  assert.equal(classifyTool('replace_file_content'), 'edit');
  assert.equal(classifyTool('multi_replace_file_content'), 'edit');
  assert.equal(classifyTool('apply_patch'), 'edit');
  assert.equal(classifyTool('run_command'), 'bash');
  assert.equal(classifyTool('shell'), 'bash');
  assert.equal(classifyTool('view_file'), 'read');
  assert.equal(classifyTool('list_dir'), 'read');
  assert.equal(classifyTool('grep_search'), 'read');
  assert.equal(classifyTool('find_by_name'), 'read');
  assert.equal(classifyTool('search_web'), 'read');
  assert.equal(classifyTool('read_url_content'), 'read');
  assert.equal(classifyTool('custom_unknown_tool'), 'other');
});

/* ---------- 4. members.js：agy 后端 + 档位收敛 ---------- */

test('planMemberCreation 支持 agy，且不产出无效 backend+tier 组合', () => {
  const existing = [{ id: 'lead', name: 'lead', backend: 'claude' }];

  const bad = planMemberCreation({
    action: { name: 'x', backend: 'unknown-cli', reason: '测试非法后端提示' },
    members: existing,
    ceiling: TIER.FULL,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /agy/);

  // 省略 tier + readonly 天花板 + agy/codex → 经 normalizeTier 收敛为 read（合法档位）
  const agyNorm = planMemberCreation({
    action: { name: 'a1', backend: 'agy', reason: '需要 agy 查资料' },
    members: existing,
    ceiling: TIER.READONLY,
  });
  assert.equal(agyNorm.ok, true);
  assert.equal(agyNorm.member.tier, TIER.READ);

  const codexNorm = planMemberCreation({
    action: { name: 'c1', backend: 'codex', reason: '需要 codex 查资料' },
    members: existing,
    ceiling: TIER.READONLY,
  });
  assert.equal(codexNorm.ok, true);
  assert.equal(codexNorm.member.tier, TIER.READ);

  // 显式指定 codex 不支持的 write 档 → 明确拒绝
  const codexBad = planMemberCreation({
    action: { name: 'c2', backend: 'codex', tier: TIER.WRITE, reason: '测试无效档位' },
    members: existing,
    ceiling: TIER.FULL,
  });
  assert.equal(codexBad.ok, false);
  assert.match(codexBad.reason, /不支持档位/);

  // full 天花板下创建 agy 成员默认得到 full
  const agyFull = planMemberCreation({
    action: { name: 'a2', backend: 'agy', reason: '需要全能开发者' },
    members: existing,
    ceiling: TIER.FULL,
  });
  assert.equal(agyFull.ok, true);
  assert.equal(agyFull.member.tier, TIER.FULL);
});

/* ---------- 5. rooms.js & config.js：开放默认值 ---------- */

test('createRoom 初始化开放默认值，buildRoom 正确装配 aiCabTier 与 allowPeerMentions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'v2-create-room-'));
  try {
    const meta = { version: 1, rooms: [], activeRoomId: null };
    const r = await createRoom(dir, meta, '开放协作室');
    assert.equal(r.ok, true);

    const cfgPath = join(dir, 'rooms', r.room.id, 'room.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.equal(cfg.aiCabTier, 'full');
    assert.equal(cfg.allowPeerMentions, true);
    assert.equal(cfg.headPassiveWake, true);

    const built = await buildRoom({ cfg, dataDir: join(dir, 'rooms', r.room.id) });
    assert.equal(built.room.aiCabTier, 'full');
    assert.equal(built.room.allowPeerMentions, true);

    // 显式关闭 allowPeerMentions 应生效
    const builtClosed = await buildRoom({
      cfg: { ...cfg, allowPeerMentions: false },
      dataDir: join(dir, 'rooms', r.room.id),
    });
    assert.equal(builtClosed.room.allowPeerMentions, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------- 6. files.js 单测：遍历、二进制检测、截断、路径安全 ---------- */

test('listRoomFiles 与 readRoomFile：排序、过滤、二进制识别、截断与越界防护', async () => {
  const base = await mkdtemp(join(tmpdir(), 'v2-files-'));
  try {
    const sharedDir = join(base, 'shared');
    const agentDir = join(base, 'agent-1');
    const secretFile = join(base, 'outside-secret.txt');
    const outsideDir = join(base, 'outside-dir');

    await mkdir(join(sharedDir, 'nested'), { recursive: true });
    await mkdir(join(sharedDir, '.git'), { recursive: true });
    await mkdir(join(sharedDir, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    await writeFile(secretFile, 'TOP-SECRET-OUTSIDE');
    await writeFile(join(outsideDir, 'leak.txt'), 'OUTSIDE-DIR-LEAK');

    const older = join(sharedDir, 'old.md');
    const newer = join(sharedDir, 'nested', 'new.md');
    await writeFile(older, 'old content');
    await writeFile(newer, 'new content');
    await utimes(older, new Date(1700000000000), new Date(1700000000000));
    await utimes(newer, new Date(1700000100000), new Date(1700000100000));

    // 应被跳过的项
    await writeFile(join(sharedDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    await writeFile(join(sharedDir, 'node_modules', 'pkg', 'index.js'), 'x');
    await writeFile(join(sharedDir, 'opencode.json'), '{}');

    // 成员目录文件与应跳过的隐藏文件/opencode.json
    await writeFile(join(agentDir, 'result.txt'), 'agent output');
    await writeFile(join(agentDir, '.hidden'), 'skip me');
    await writeFile(join(agentDir, 'opencode.json'), '{}');

    // 二进制文件与超大文本
    await writeFile(join(sharedDir, 'img.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await writeFile(join(sharedDir, 'long.txt'), 'A'.repeat(200));

    // 制造指向外部文件与外部目录的符号链接
    await symlink(secretFile, join(sharedDir, 'sym-file.txt'));
    await symlink(outsideDir, join(sharedDir, 'sym-dir'));

    const members = [{ id: 'a1', name: 'alice', cwd: agentDir }];
    const listing = await listRoomFiles({ sharedDir, members });

    assert.equal(listing.ok, true);
    const sharedPaths = listing.shared.map((f) => f.relPath);
    assert.ok(sharedPaths.includes('nested/new.md'));
    assert.ok(sharedPaths.includes('old.md'));
    assert.ok(sharedPaths.indexOf('nested/new.md') < sharedPaths.indexOf('old.md'), '应按 mtime 倒序排列');
    assert.equal(sharedPaths.some((p) => p.includes('.git') || p.includes('node_modules') || p === 'opencode.json'), false);
    assert.equal(sharedPaths.includes('sym-file.txt'), false, '列表阶段不暴露符号链接');

    assert.equal(listing.agents.length, 1);
    assert.equal(listing.agents[0].agentId, 'a1');
    assert.deepEqual(listing.agents[0].files.map((f) => f.relPath), ['result.txt']);

    // 正常读取文本
    const rText = await readRoomFile({ scope: 'shared', relPath: 'nested/new.md', sharedDir, members });
    assert.equal(rText.ok, true);
    assert.equal(rText.binary, false);
    assert.equal(rText.content, 'new content');
    assert.equal(rText.truncated, false);

    // 成员工作区读取
    const rAgent = await readRoomFile({ scope: 'agent', agentId: 'a1', relPath: 'result.txt', sharedDir, members });
    assert.equal(rAgent.ok, true);
    assert.equal(rAgent.content, 'agent output');

    // 二进制文件识别
    const rBin = await readRoomFile({ scope: 'shared', relPath: 'img.bin', sharedDir, members });
    assert.equal(rBin.ok, true);
    assert.equal(rBin.binary, true);
    assert.equal(rBin.content, '');

    // 截断读取
    const rTrunc = await readRoomFile({ scope: 'shared', relPath: 'long.txt', sharedDir, members, maxBytes: 50 });
    assert.equal(rTrunc.ok, true);
    assert.equal(rTrunc.truncated, true);
    assert.equal(rTrunc.content.length, 50);
    assert.equal(rTrunc.size, 200);

    // 安全拦截：目录穿越 / 绝对路径 / NUL 字节 / 符号链接文件与目录逃逸
    for (const badPath of ['../outside-secret.txt', 'nested/../../outside-secret.txt', '/etc/passwd', 'old.md\0.txt', 'sym-file.txt', 'sym-dir/leak.txt']) {
      const blocked = await readRoomFile({ scope: 'shared', relPath: badPath, sharedDir, members });
      assert.equal(blocked.ok, false, `必须拦截越界路径：${badPath}`);
      assert.equal(blocked.status, 403, `${badPath} 必须返回 403`);
      assert.equal(blocked.error, '路径越界');
    }

    // 不存在返回 404
    const missing = await readRoomFile({ scope: 'shared', relPath: 'no-such-file.txt', sharedDir, members });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/* ---------- 7. HTTP + SSE 集成测试 ---------- */

test('HTTP：/api/room-settings 实时更新 goal 与 allowPeerMentions，落盘并出现在 room.init', async () => {
  const { server, url, dir } = await makeHttpServer();
  try {
    const res = await fetch(`${url}/api/room-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: '  本周交付 v2 协作工作台  ',
        allowPeerMentions: false,
        headPassiveWake: false,
        turnTimeoutMinutes: 30,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.goal, '本周交付 v2 协作工作台');
    assert.equal(body.allowPeerMentions, false);
    assert.equal(body.headPassiveWake, false);
    assert.equal(body.turnTimeoutMinutes, 30);

    // 校验已落盘 room.json
    const saved = JSON.parse(await readFile(join(dir, 'rooms', 'r-a', 'room.json'), 'utf8'));
    assert.equal(saved.goal, '本周交付 v2 协作工作台');
    assert.equal(saved.allowPeerMentions, false);
    assert.equal(saved.headPassiveWake, false);
    assert.equal(saved.turnTimeoutMinutes, 30);

    // 校验 SSE room.init 反映最新设置与 sharedDir
    const init = await fetchInit(url);
    assert.equal(init.room.goal, '本周交付 v2 协作工作台');
    assert.ok(init.room.sharedDir && init.room.sharedDir.endsWith(join('r-a', 'shared')));
    assert.equal(init.allowPeerMentions, false);
    assert.equal(init.headPassiveWake, false);
    assert.equal(init.turnTimeoutMinutes, 30);

    // 非法 timeout 应返回 400 且不覆盖已有 goal
    const bad = await fetch(`${url}/api/room-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: '不应生效', turnTimeoutMinutes: 999 }),
    });
    assert.equal(bad.status, 400);
    const afterBad = JSON.parse(await readFile(join(dir, 'rooms', 'r-a', 'room.json'), 'utf8'));
    assert.equal(afterBad.goal, '本周交付 v2 协作工作台');
  } finally {
    closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP：/api/cabtier 支持 full，并拒绝未知档位', async () => {
  const { server, url, manager, dir } = await makeHttpServer({
    name: 'cabtier 测试',
    goal: '',
    registry: [],
    aiCabTier: 'readonly',
    members: [{ id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly' }],
  });
  try {
    const res = await fetch(`${url}/api/cabtier`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'full' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tier, 'full');
    assert.equal(manager.session.room.aiCabTier, 'full');

    const bad = await fetch(`${url}/api/cabtier`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'godmode' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP：/api/registry 与 /api/registry/remove 增删仓库并落盘', async () => {
  const { server, url, manager, dir } = await makeHttpServer();
  try {
    const add1 = await fetch(`${url}/api/registry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/repo-alpha' }),
    });
    assert.equal(add1.status, 200);
    assert.deepEqual((await add1.json()).registry, [{ path: '/tmp/repo-alpha' }]);

    const add2 = await fetch(`${url}/api/registry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/repo-beta' }),
    });
    assert.equal(add2.status, 200);
    assert.equal(manager.session.room.registry.length, 2);

    const rem = await fetch(`${url}/api/registry/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/repo-alpha' }),
    });
    assert.equal(rem.status, 200);
    const remBody = await rem.json();
    assert.equal(remBody.ok, true);
    assert.deepEqual(remBody.registry, [{ path: '/tmp/repo-beta' }]);
    assert.deepEqual(manager.session.room.registry, [{ path: '/tmp/repo-beta' }]);

    const saved = JSON.parse(await readFile(join(dir, 'rooms', 'r-a', 'room.json'), 'utf8'));
    assert.deepEqual(saved.registry, [{ path: '/tmp/repo-beta' }]);
  } finally {
    closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP：GET /api/backends 返回全部 4 个后端诊断信息，POST /api/backends/probe 拒绝未知后端', async () => {
  const { server, url, dir } = await makeHttpServer();
  try {
    const res = await fetch(`${url}/api/backends`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body.checkedAt === 'string');
    assert.ok(Array.isArray(body.backends));
    assert.deepEqual(body.backends.map((b) => b.id), ['agy', 'claude', 'codex', 'opencode']);

    const badProbe = await fetch(`${url}/api/backends/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'nonexistent-cli' }),
    });
    assert.equal(badProbe.status, 400);
  } finally {
    closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP：GET /api/files 与 GET /api/file 列出、读取产出文件并严格拦截目录穿越与符号链接逃逸', async () => {
  const { server, url, manager, dir } = await makeHttpServer();
  try {
    const sharedDir = manager.session.room.sharedDir;
    const leadCwd = manager.session.room.members[0].cwd;
    const outsideSecret = join(dir, 'outside-secret.txt');

    await writeFile(outsideSecret, 'SECRET_DATA');
    await writeFile(join(sharedDir, 'deliverable.md'), '# 交付物\n完成');
    await writeFile(join(leadCwd, 'notes.txt'), 'lead private note');
    await symlink(outsideSecret, join(sharedDir, 'escape-link.txt'));

    const listRes = await fetch(`${url}/api/files`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.ok, true);
    assert.ok(listBody.shared.some((f) => f.relPath === 'deliverable.md'));
    assert.equal(listBody.shared.some((f) => f.relPath === 'escape-link.txt'), false);
    const leadEntry = listBody.agents.find((a) => a.agentId === 'lead');
    assert.ok(leadEntry);
    assert.ok(leadEntry.files.some((f) => f.relPath === 'notes.txt'));

    // 读取 shared 文件
    const sharedRead = await fetch(`${url}/api/file?scope=shared&path=deliverable.md`);
    assert.equal(sharedRead.status, 200);
    const sharedJson = await sharedRead.json();
    assert.equal(sharedJson.ok, true);
    assert.equal(sharedJson.binary, false);
    assert.equal(sharedJson.content, '# 交付物\n完成');

    // 读取 agent 文件
    const agentRead = await fetch(`${url}/api/file?scope=agent&agentId=lead&path=notes.txt`);
    assert.equal(agentRead.status, 200);
    assert.equal((await agentRead.json()).content, 'lead private note');

    // 拦截 ../ 穿越
    const travRes = await fetch(`${url}/api/file?scope=shared&path=${encodeURIComponent('../room.json')}`);
    assert.equal(travRes.status, 403);
    assert.equal((await travRes.json()).error, '路径越界');

    // 拦截符号链接逃逸
    const symRes = await fetch(`${url}/api/file?scope=shared&path=escape-link.txt`);
    assert.equal(symRes.status, 403);
    assert.equal((await symRes.json()).error, '路径越界');

    // 不存在返回 404
    const notFound = await fetch(`${url}/api/file?scope=shared&path=nope.txt`);
    assert.equal(notFound.status, 404);
  } finally {
    closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP：POST /api/member 创建 agy 成员默认得到 full 档并落盘', async () => {
  const { server, url, manager, dir } = await makeHttpServer();
  try {
    const res = await fetch(`${url}/api/member`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '小安',
        backend: 'agy',
        persona: '全栈开发工程师',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.member.backend, 'agy');
    assert.equal(body.member.tier, 'full');

    const inRoom = manager.session.room.members.find((m) => m.name === '小安');
    assert.ok(inRoom);
    assert.equal(inRoom.tier, 'full');

    const saved = JSON.parse(await readFile(join(dir, 'rooms', 'r-a', 'room.json'), 'utf8'));
    const savedMember = saved.members.find((m) => m.name === '小安');
    assert.equal(savedMember.backend, 'agy');
    assert.equal(savedMember.tier, 'full');

    const init = await fetchInit(url);
    const pub = init.members.find((m) => m.name === '小安');
    assert.equal(pub.backend, 'agy');
    assert.equal(pub.tier, 'full');
    assert.ok(pub.tiers.includes('full'));
  } finally {
    closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});
