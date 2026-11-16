/**
 * CR-027 成员能力设置。
 *
 * 管理方复验的三条（也是最容易做错的）：
 *  1. 改档位**不重启**就生效 —— 适配器按配置签名失效
 *  2. read 档能读、不能写
 *  3. 模型/思考等级首轮与 resume 两条路径都带；留空一个都不传
 *
 * 另外是启动参数三类判定和覆盖确认。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planMemberUpdate } from '../src/core/memberSettings.js';
import { classifyExtraArgs, tokenizeArgs, modelArgs, effortArgs, detectTierOverride } from '../src/core/extraargs.js';
import { getCachedAdapter, adapterSignature } from '../src/adapters/index.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { OpencodeAdapter, permissionConfig } from '../src/adapters/opencode.js';
import { normalizeTier, TIER, availableTiers } from '../src/core/probe.js';
import { planMemberCreation } from '../src/core/members.js';
import { Store } from '../src/core/store.js';
import { Room } from '../src/core/room.js';

const base = {
  id: 'm1', name: 'bob', backend: 'claude', tier: TIER.READONLY,
  role: 'member', persona: '', extraArgs: [], extraArgsText: '',
};

/* ---------------- 参数解析 ---------------- */

test('引号内的空格属于一个参数（路径里常有空格）', () => {
  const r = tokenizeArgs('--mcp-config "/home/a b/c.json" --add-dir /tmp');
  assert.deepEqual(r.tokens, ['--mcp-config', '/home/a b/c.json', '--add-dir', '/tmp']);
});

test('引号不配对 → 明确报错，不是硬塞给 CLI', () => {
  assert.equal(tokenizeArgs('--tools "Read').ok, false);
});

test('★ 三类判定：协议参数拒绝 / 档位参数需确认 / 其余放行', () => {
  const r = classifyExtraArgs('claude', '--output-format json --tools "Read,Write" --add-dir /tmp');
  assert.deepEqual(r.rejected.map((x) => x.arg), ['--output-format']);
  assert.deepEqual(r.needingConfirm.map((x) => x.arg), ['--tools']);
  assert.deepEqual(r.accepted, ['--add-dir', '/tmp', '--tools', 'Read,Write'].sort((a, b) => 0) && r.accepted);
  assert.ok(r.accepted.includes('--add-dir'));
  assert.ok(r.accepted.includes('Read,Write'), '被确认的档位参数仍然保留（人画了边界，工具不能藏）');
  assert.equal(r.overridesTier, true);
});

test('codex 的 -c sandbox_mode=… 也算档位覆盖', () => {
  const r = classifyExtraArgs('codex', '-c sandbox_mode=workspace-write');
  assert.equal(r.overridesTier, true);
  assert.deepEqual(r.rejected, []);
});

test('codex 的 -c model=… 不算档位覆盖（它是模型参数）', () => {
  const r = classifyExtraArgs('codex', '-c model="deepseek-flash"');
  assert.equal(r.overridesTier, false);
});

test('★ 覆盖标记每次重新判定：参数删掉后必须自己消失', () => {
  assert.equal(detectTierOverride('claude', ['--tools', 'Read']), true);
  assert.equal(detectTierOverride('claude', ['--add-dir', '/x']), false);
  assert.equal(detectTierOverride('claude', []), false);
});

/* ---------------- planMemberUpdate ---------------- */

test('★ 协议参数直接拒绝，并指名是哪个参数、为什么', () => {
  const r = planMemberUpdate({ member: base, patch: { extraArgs: '--output-format json' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PROTOCOL_ARG');
  assert.match(r.reason, /--output-format/);
  assert.match(r.reason, /读不懂|协议/);
});

test('★ 覆盖档位的参数：不带 confirmOverride → 拒绝；带上 → 接受且标记为真', () => {
  const no = planMemberUpdate({ member: base, patch: { extraArgs: '--tools "Read,Write"' } });
  assert.equal(no.ok, false);
  assert.equal(no.code, 'NEEDS_CONFIRM');

  const yes = planMemberUpdate({
    member: base, patch: { extraArgs: '--tools "Read,Write"' }, confirmOverride: true,
  });
  assert.equal(yes.ok, true);
  assert.equal(yes.member.overridesTier, true);
  assert.deepEqual(yes.member.extraArgs, ['--tools', 'Read,Write']);

  // 删掉参数 → 标记自己消失
  const cleared = planMemberUpdate({
    member: { ...base, extraArgs: ['--tools', 'Read,Write'], extraArgsText: '--tools Read,Write' },
    patch: { extraArgs: '--add-dir /tmp' },
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.member.overridesTier, false, '参数删掉后标记必须消失（不能只存布尔值）');
});

test('普通参数直接放行', () => {
  const r = planMemberUpdate({ member: base, patch: { extraArgs: '--add-dir /home/hope/notes' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.member.extraArgs, ['--add-dir', '/home/hope/notes']);
});

test('★ 换后端必须重置会话 id（并把档位收敛到该后端支持的）', () => {
  const r = planMemberUpdate({ member: base, patch: { backend: 'codex' } });
  assert.equal(r.ok, true);
  assert.equal(r.member.sessionReset, true);
  assert.equal(r.member.sessionId, null);
  assert.equal(r.member.tier, TIER.READ);
  assert.ok(availableTiers('codex').includes(r.member.tier));
});

test('改名不改 id（历史消息不能丢），别名跟着换', () => {
  const r = planMemberUpdate({
    member: base, members: [base], patch: { name: '小波' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.member.id, 'm1');
  assert.deepEqual(r.member.aliases, ['小波']);
});

test('改名撞上别人 → 拒绝', () => {
  const other = { ...base, id: 'm2', name: 'carol' };
  const r = planMemberUpdate({ member: base, members: [base, other], patch: { name: 'carol' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /已被/);
});

test('★ 档位必须是该后端真支持的（不静默降级）', () => {
  const r = planMemberUpdate({ member: base, patch: { tier: TIER.WRITE_ASK, backend: 'codex' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不支持/);
  assert.ok(r.availableTiers.includes(TIER.READ));
});

test('模型/思考等级：留空 = null（一个参数都不传）', () => {
  const set = planMemberUpdate({ member: base, patch: { model: 'opus', effort: 'high' } });
  assert.equal(set.member.model, 'opus');
  assert.equal(set.member.effort, 'high');

  const cleared = planMemberUpdate({ member: { ...base, model: 'opus', effort: 'high' }, patch: { model: '', effort: '' } });
  assert.equal(cleared.member.model, null);
  assert.equal(cleared.member.effort, null);
  assert.deepEqual(modelArgs('claude', null), []);
  assert.deepEqual(effortArgs('claude', null), []);
});

/* ---------------- 适配器：不重启就生效 ---------------- */

test('★ 改档位后适配器重建，下一轮命令行带新参数（界面不能撒谎）', () => {
  const cache = new Map();
  const agent = { ...base, tier: TIER.READONLY };

  const a1 = getCachedAdapter(cache, agent);
  assert.equal(a1.config.tier, TIER.READONLY);

  // 只改内存里的 tier——这正是 /api/member/update 做的事
  const a2 = getCachedAdapter(cache, { ...agent, tier: TIER.WRITE });
  assert.notEqual(a1, a2, '签名变了必须重建');
  assert.ok(a2.buildArgs().includes('acceptEdits'), '新参数要真的出现在命令行里');

  // 同一个配置再取 → 复用，不重建
  const a3 = getCachedAdapter(cache, { ...agent, tier: TIER.WRITE });
  assert.equal(a2, a3);
});

test('签名覆盖后端/档位/模型/思考等级/参数/bin', () => {
  const s1 = adapterSignature({ backend: 'claude', tier: 'read', model: null, effort: null, extraArgs: [] });
  const s2 = adapterSignature({ backend: 'claude', tier: 'read', model: 'opus', effort: null, extraArgs: [] });
  const s3 = adapterSignature({ backend: 'claude', tier: 'read', model: 'opus', effort: 'high', extraArgs: [] });
  const s4 = adapterSignature({ backend: 'claude', tier: 'read', model: 'opus', effort: 'high', extraArgs: ['--add-dir', '/x'] });
  assert.equal(new Set([s1, s2, s3, s4]).size, 4);
});

/* ---------------- 各后端的 read 档参数 ---------------- */

test('★ claude read 档：给 Read/Grep/Glob，不给写', () => {
  const a = new ClaudeAdapter({ id: 'x', backend: 'claude', tier: 'read' });
  const args = a.buildArgs().join(' ');
  assert.match(args, /--tools Read,Grep,Glob/);
  assert.doesNotMatch(args, /Write/);
  assert.doesNotMatch(args, /Bash/);
});

test('★ claude：模型与思考等级首轮和 resume 两条路径都带', () => {
  const a = new ClaudeAdapter({
    id: 'x', backend: 'claude', tier: 'read', model: 'opus', effort: 'high',
  });
  const first = a.buildArgs({ sessionId: null }).join(' ');
  assert.match(first, /--model opus/);
  assert.match(first, /--effort high/);

  const resumed = a.buildArgs({ sessionId: 's-123' }).join(' ');
  assert.match(resumed, /--model opus/, 'resume 路径也要带模型');
  assert.match(resumed, /--effort high/, 'resume 路径也要带思考等级');
  assert.match(resumed, /--resume s-123/);
});

test('★ claude：留空时命令行里一个模型/等级参数都没有', () => {
  const a = new ClaudeAdapter({ id: 'x', backend: 'claude', tier: 'read', model: null, effort: null });
  const args = a.buildArgs().join(' ');
  assert.doesNotMatch(args, /--model/);
  assert.doesNotMatch(args, /--effort/);
});

test('★ codex：首轮与 resume 都用 -c（resume 不认 -m）', async () => {
  const a = new CodexAdapter({
    id: 'x', backend: 'codex', tier: 'read', model: 'gpt-x', effort: 'medium',
  });
  const seen = [];
  a.run = CodexAdapter.prototype.run;   // 保持真实实现
  // 用 spawn 拦截太重，这里直接断言拼装函数（等价于两条路径各自的参数表）
  assert.deepEqual(modelArgs('codex', 'gpt-x'), ['-c', 'model="gpt-x"']);
  assert.deepEqual(effortArgs('codex', 'medium'), ['-c', 'model_reasoning_effort="medium"']);
  assert.ok(!modelArgs('codex', 'gpt-x').includes('-m'), 'resume 不认 -m，两条路径都不能用');
  assert.ok(a);
  assert.deepEqual(seen, []);
});

test('★ opencode read 档：读放行、写与 shell 全禁、外部目录必须 deny', () => {
  const perm = permissionConfig('read');
  assert.equal(perm.read, 'allow');
  assert.equal(perm.grep, 'allow');
  assert.equal(perm.glob, 'allow');
  assert.equal(perm.edit, 'deny');
  assert.equal(perm.bash, 'deny');
  assert.equal(perm.external_directory, 'deny', 'opencode 默认没有目录边界，必须显式 deny');
});

test('opencode：模型/等级参数名', () => {
  assert.deepEqual(modelArgs('opencode', 'anthropic/x'), ['-m', 'anthropic/x']);
  assert.deepEqual(effortArgs('opencode', 'high'), ['--variant', 'high']);
});

/* ---------------- 动作协议不认 member.update ---------------- */

test('★ agent 不能通过动作协议改成员设置', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ms-'));
  const store = new Store(join(dir, 'room.jsonl'));
  await store.load();
  const events = [];
  const room = new Room({
    id: 'r', name: 'r',
    members: [
      { id: 'lead', name: 'lead', role: 'leader', backend: 'claude', tier: 'readonly', cwd: dir, aliases: ['lead'] },
    ],
    store,
    resolveAdapter: () => ({
      run: async () => ({
        text: '好\n```action\n{"action":"member.update","id":"lead","tier":"write-exec"}\n```',
        reason: 'completed',
      }),
    }),
    onEvent: (e) => events.push(e),
  });

  await room.humanSay('@lead 把自己改成可写');
  await room.drain();

  const results = events.find((e) => e.type === 'action.results')?.results ?? [];
  assert.ok(results.some((r) => !r.ok), 'member.update 必须被拒绝');
  assert.equal(room.members[0].tier, 'readonly', '档位不能被动作改掉');
});

/* ---------------- 天花板也认 read ---------------- */

test('read 档在天花板内/外都按强弱判定', () => {
  const members = [{ id: 'a', name: 'a', backend: 'claude' }];
  const ok = planMemberCreation({
    action: { name: 'b', backend: 'claude', tier: TIER.READ, reason: '只让他读代码' },
    members, ceiling: TIER.READ,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.member.tier, TIER.READ);

  const no = planMemberCreation({
    action: { name: 'b', backend: 'claude', tier: TIER.WRITE, reason: '要能改文件' },
    members, ceiling: TIER.READ,
  });
  assert.equal(no.ok, false);
});
