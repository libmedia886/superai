/**
 * agy（Antigravity CLI）适配器、full（完全开放）权限档位与统一后端诊断模块测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgyAdapter, agyTierArgs, MAX_INLINE_PROMPT_BYTES } from '../src/adapters/agy.js';
import { ClaudeAdapter, tierArgs as claudeTierArgs, approvalLabel } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { OpencodeAdapter, permissionConfig } from '../src/adapters/opencode.js';
import { ADAPTERS, createAdapter } from '../src/adapters/index.js';
import {
  TIER, TIER_RANK, TIER_DESC, CWD_IS_BOUNDARY, availableTiers, normalizeTier, judge,
} from '../src/core/probe.js';
import {
  classifyExtraArgs, modelArgs, effortArgs, EFFORT_HINTS,
} from '../src/core/extraargs.js';
import { planMemberUpdate } from '../src/core/memberSettings.js';
import { childEnv, AUTH_VARS_BY_BACKEND } from '../src/core/runner.js';
import {
  ALL_BACKENDS,
  inspectBackends,
  clearBackendsCache,
  parseAgyModelsOutput,
  parseCodexConfigToml,
  parseOpencodeConfigJson,
} from '../src/core/backends.js';

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ---------------- 1. AgyAdapter 参数拼装 ---------------- */

test('AgyAdapter.buildArgs：各档位映射与 --disable-slash-commands 规则', () => {
  assert.deepEqual(agyTierArgs('read'), ['--mode', 'plan']);
  assert.deepEqual(agyTierArgs('readonly'), ['--mode', 'plan']);
  assert.deepEqual(agyTierArgs('write'), ['--mode', 'accept-edits']);
  assert.deepEqual(agyTierArgs('write-exec'), ['--mode', 'auto']);
  assert.deepEqual(agyTierArgs('writeExec'), ['--mode', 'auto']);
  assert.deepEqual(agyTierArgs('full'), ['--dangerously-skip-permissions']);

  // read / readonly 绝不能带 --disable-slash-commands（实测与 --mode plan 冲突告警）
  for (const tier of ['read', 'readonly']) {
    const a = new AgyAdapter({ id: 'a', backend: 'agy', tier });
    const args = a.buildArgs();
    assert.deepEqual(args, ['--output-format', 'stream-json', '--mode', 'plan']);
    assert.ok(!args.includes('--disable-slash-commands'), `${tier} 档不能加 --disable-slash-commands`);
  }

  // write / write-exec / full 带 --disable-slash-commands
  for (const [tier, expectedFlag] of [
    ['write', 'accept-edits'],
    ['write-exec', 'auto'],
    ['full', '--dangerously-skip-permissions'],
  ]) {
    const a = new AgyAdapter({ id: 'a', backend: 'agy', tier });
    const args = a.buildArgs();
    assert.ok(args.includes(expectedFlag), `${tier} 档应包含 ${expectedFlag}`);
    assert.ok(args.includes('--disable-slash-commands'), `${tier} 档应加 --disable-slash-commands`);
  }

  // 完整参数顺序：输出格式 → 档位 → 禁斜杠 → 模型 → 思考等级 → 会话 → 共享目录 → 附加参数 → -p prompt
  const full = new AgyAdapter({
    id: 'a',
    backend: 'agy',
    tier: 'full',
    model: 'gemini-4-neon-high',
    effort: 'xhigh',
    sharedDir: '/tmp/room-shared',
    extraArgs: ['--agent', 'custom'],
  });
  assert.deepEqual(
    full.buildArgs({ sessionId: 'conv-42', prompt: 'hello' }),
    [
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--model', 'gemini-4-neon-high',
      '--effort', 'xhigh',
      '--conversation', 'conv-42',
      '--add-dir', '/tmp/room-shared',
      '--agent', 'custom',
      '-p', 'hello',
    ],
  );
  assert.equal(full.supportsStreaming, true);
  assert.equal(ADAPTERS.agy, AgyAdapter);
  assert.ok(createAdapter({ id: 'x', backend: 'agy', tier: 'full' }) instanceof AgyAdapter);
});

/* ---------------- 2. AgyAdapter.run() 流式事件、去重、报错与超长 prompt ---------------- */

test('AgyAdapter.run：流式 text/thinking、tool ACTIVE+DONE 不重复计数、usage 与 conversation_id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-run-'));
  try {
    const fakeAgy = join(dir, 'fake-agy.sh');
    await writeFile(fakeAgy, `#!/bin/bash
echo '{"event":"init","conversation_id":"conv-100","init":{"cwd":"'"$PWD"'"}}'
echo '{"event":"step_update","step_update":{"conversation_id":"conv-100","step_index":1,"state":"ACTIVE","step_type":"agent_response","thinking_delta":"先分析一下"}}'
echo '{"event":"step_update","step_update":{"conversation_id":"conv-100","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/demo.js"}}}}'
echo '{"event":"step_update","step_update":{"conversation_id":"conv-100","step_index":2,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/demo.js"}}}}'
echo '{"event":"step_update","step_update":{"conversation_id":"conv-100","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"}}}}'
echo '{"event":"step_update","step_update":{"conversation_id":"conv-100","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"}}}}'
echo '{"event":"step_update","step_update":{"conversation_id":"conv-100","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"你好，"}}'
echo '{"event":"step_update","step_update":{"conversation_id":"conv-100","step_index":4,"state":"DONE","step_type":"agent_response","text_delta":"世界！"}}'
echo '{"event":"result","result":{"conversation_id":"conv-100","status":"SUCCESS","response":"你好，世界！","usage":{"input_tokens":120,"output_tokens":45,"cache_read_tokens":30,"thinking_tokens":18}}}'
`, { mode: 0o755 });
    await chmod(fakeAgy, 0o755);

    const events = [];
    const adapter = new AgyAdapter({ id: 'a1', backend: 'agy', tier: 'full', bin: fakeAgy });
    const res = await adapter.run({
      prompt: 'hi',
      cwd: dir,
      sessionId: null,
      onEvent: (e) => events.push(e),
    });

    assert.equal(res.reason, 'completed');
    assert.equal(res.error, null);
    assert.equal(res.sessionId, 'conv-100');
    assert.equal(res.text, '你好，世界！');
    assert.deepEqual(res.usage, {
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      reasoningTokens: 18,
      costUsd: null,
      contextWindow: null,
    });

    const thinking = events.filter((e) => e.type === 'thinking');
    assert.equal(thinking.length, 1);
    assert.equal(thinking[0].text, '先分析一下');

    const textDeltas = events.filter((e) => e.type === 'text' && !e.done).map((e) => e.text);
    assert.deepEqual(textDeltas, ['你好，', '世界！']);
    assert.ok(events.some((e) => e.type === 'text' && e.done === true));

    // ACTIVE + DONE 必须只产生 1 次 tool 事件（不重复计数）
    const tools = events.filter((e) => e.type === 'tool');
    assert.equal(tools.length, 2, '每个 step_index 只能记一次 tool 事件');
    assert.equal(tools[0].tool, 'view_file');
    assert.equal(tools[0].path, '/tmp/demo.js');
    assert.equal(tools[1].tool, 'run_command');
    assert.equal(tools[1].command, 'ls -la');

    const toolResults = events.filter((e) => e.type === 'tool.result');
    assert.ok(toolResults.length >= 2, '每个工具 DONE 和 result 都应发 tool.result');
    assert.ok(events.some((e) => e.type === 'meta' && e.sessionId === 'conv-100'));
    assert.ok(events.some((e) => e.type === 'done' && e.ok === true));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AgyAdapter.run：result status=ERROR 时正确透传错误且不伪装成功', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-err-'));
  try {
    const fakeAgy = join(dir, 'fake-agy-err.sh');
    await writeFile(fakeAgy, `#!/bin/bash
echo '{"event":"init","conversation_id":"conv-err"}'
echo '{"event":"result","result":{"conversation_id":"conv-err","status":"ERROR","error":"quota exceeded for model"}}'
exit 1
`, { mode: 0o755 });
    await chmod(fakeAgy, 0o755);

    const events = [];
    const adapter = new AgyAdapter({ id: 'a-err', backend: 'agy', tier: 'full', bin: fakeAgy });
    const res = await adapter.run({
      prompt: 'hi',
      cwd: dir,
      sessionId: null,
      onEvent: (e) => events.push(e),
    });

    assert.equal(res.reason, 'failed');
    assert.match(res.error ?? '', /quota exceeded for model/);
    assert.ok(events.some((e) => e.type === 'error' && /quota exceeded/.test(e.message)));
    assert.ok(events.some((e) => e.type === 'done' && e.ok === false));

    // probe 遇到 ERROR 也要诚实返回 ok:false 与原因
    const pr = await adapter.probe(dir, 10_000);
    assert.equal(pr.ok, false);
    assert.match(pr.reason ?? '', /quota exceeded for model/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AgyAdapter.run：超长 prompt (>96KB) 自动写临时文件投递并在 finally 中清理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-huge-'));
  try {
    const capturedArg = join(dir, 'captured-p.txt');
    const capturedLen = join(dir, 'captured-file-len.txt');
    const fakeAgy = join(dir, 'fake-agy-huge.sh');
    await writeFile(fakeAgy, `#!/bin/bash
p_val=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-p" ]; then p_val="$2"; shift 2; continue; fi
  shift
done
printf '%s' "$p_val" > "${capturedArg}"
# 提取路径并验证临时文件在执行期间确实存在且完整
fpath="\${p_val##*：}"
if [ -f "$fpath" ]; then
  wc -c < "$fpath" | tr -d ' ' > "${capturedLen}"
fi
echo '{"event":"result","result":{"conversation_id":"conv-huge","status":"SUCCESS","response":"DONE"}}'
`, { mode: 0o755 });
    await chmod(fakeAgy, 0o755);

    const hugePrompt = 'X'.repeat(MAX_INLINE_PROMPT_BYTES + 2048);
    const adapter = new AgyAdapter({ id: 'a-huge', backend: 'agy', tier: 'full', bin: fakeAgy });
    const res = await adapter.run({ prompt: hugePrompt, cwd: dir, sessionId: null });

    assert.equal(res.reason, 'completed');
    assert.equal(res.text, 'DONE');
    const pText = await readFile(capturedArg, 'utf8');
    assert.match(pText, /请读取并严格按此文件中的完整指令执行：/);
    const fileBytes = Number(await readFile(capturedLen, 'utf8'));
    assert.equal(fileBytes, Buffer.byteLength(hugePrompt, 'utf8'));

    // 运行结束后临时 prompt 文件必须被清理干净
    const remaining = (await readdir(dir)).filter((f) => f.startsWith('.agy-prompt-'));
    assert.deepEqual(remaining, [], '临时 prompt 文件必须在 finally 中删除');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------- 3. 全 4 后端 full 权限档位 ---------------- */

test('★ full 档位：4 个后端的参数与权限配置全部正确落地', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'full-tier-'));
  try {
    const sharedDir = join(dir, 'shared');
    const cwd = join(dir, 'agent');

    // 1) Claude: --dangerously-skip-permissions 且不限制 --tools
    assert.deepEqual(claudeTierArgs('full'), ['--dangerously-skip-permissions']);
    assert.equal(approvalLabel('full'), '完全开放');
    const cl = new ClaudeAdapter({ id: 'c1', backend: 'claude', tier: 'full', sharedDir });
    const clArgs = cl.buildArgs();
    assert.ok(clArgs.includes('--dangerously-skip-permissions'));
    assert.ok(!clArgs.includes('--tools'), 'full 档不能用 --tools 限制内置工具');
    assert.ok(clArgs.includes('--add-dir') && clArgs.includes(sharedDir));

    // 2) Codex: 首轮与 resume 两条路径都用 --dangerously-bypass-approvals-and-sandbox，不含 -s / sandbox_mode
    const cx = new CodexAdapter({ id: 'x1', backend: 'codex', tier: 'full', sharedDir, model: 'gpt-x' });
    const cxBase = cx.buildArgs({ cwd });
    assert.ok(cxBase.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!cxBase.includes('-s'), 'full 档首轮不传 -s');
    assert.ok(cxBase.includes('--add-dir') && cxBase.includes(sharedDir));

    const cxResume = cx.buildArgs({ cwd, sessionId: 'th-9' });
    assert.ok(cxResume.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!cxResume.some((a) => a.startsWith('sandbox_mode=')), 'full 档 resume 不传 sandbox_mode');

    // 3) OpenCode: 全部权限 allow + prepare 保留 external_directory='allow' + CLI 传 --auto
    const ocPerm = permissionConfig('full');
    for (const k of [
      'read', 'edit', 'glob', 'grep', 'list', 'bash', 'task',
      'external_directory', 'webfetch', 'skill', 'todowrite', 'websearch', 'lsp',
    ]) {
      assert.equal(ocPerm[k], 'allow', `opencode full 档 ${k} 必须为 allow`);
    }
    const oc = new OpencodeAdapter({ id: 'o1', backend: 'opencode', tier: 'full', sharedDir });
    const ocCfg = await oc.prepare(cwd);
    assert.equal(ocCfg.permission.external_directory, 'allow', 'full 档即使配了 sharedDir 也保持 external_directory=allow');
    const ocArgs = oc.buildArgs({ cwd });
    assert.ok(ocArgs.includes('--auto'), 'opencode full 档必须传 --auto');

    // 4) Agy: --dangerously-skip-permissions + --disable-slash-commands
    const ag = new AgyAdapter({ id: 'g1', backend: 'agy', tier: 'full', sharedDir });
    const agArgs = ag.buildArgs();
    assert.ok(agArgs.includes('--dangerously-skip-permissions'));
    assert.ok(!agArgs.includes('--mode'));
    assert.ok(agArgs.includes('--disable-slash-commands'));
    assert.ok(agArgs.includes('--add-dir') && agArgs.includes(sharedDir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------- 4. probe / extraargs / memberSettings / runner ---------------- */

test('probe.js：TIER.FULL、TIER_RANK、TIER_DESC、CWD_IS_BOUNDARY 与 judge', () => {
  assert.equal(TIER.FULL, 'full');
  assert.equal(TIER_RANK[TIER.FULL], 5);
  assert.ok(TIER_RANK[TIER.FULL] > TIER_RANK[TIER.WRITE_EXEC]);
  assert.match(TIER_DESC[TIER.FULL], /完全开放/);
  assert.equal(CWD_IS_BOUNDARY.agy, false);
  assert.equal(normalizeTier('agy', TIER.READONLY), TIER.READ);

  for (const b of ALL_BACKENDS) {
    assert.ok(availableTiers(b).includes(TIER.FULL), `${b} 必须支持 full 档`);
  }
  assert.deepEqual(availableTiers('agy'), [TIER.READ, TIER.WRITE, TIER.WRITE_EXEC, TIER.FULL]);
  assert.equal(judge({ write: 'OK', exec: 'OK' }, TIER.FULL), 'VERIFIED');
  assert.equal(judge({ write: 'BLOCKED', exec: 'OK' }, TIER.FULL), 'BROKEN');
});

test('extraargs.js：agy 协议参数拒绝、档位参数需确认、模型/思考等级参数与提示', () => {
  const proto = classifyExtraArgs('agy', '-p hi --output-format json --conversation c1 -c');
  assert.equal(proto.ok, true);
  assert.deepEqual(proto.rejected.map((x) => x.arg), ['-p', '--output-format', '--conversation', '-c']);

  const tier = classifyExtraArgs('agy', '--mode auto --dangerously-skip-permissions --sandbox');
  assert.equal(tier.ok, true);
  assert.equal(tier.overridesTier, true);
  assert.deepEqual(tier.needingConfirm.map((x) => x.arg), ['--mode', '--dangerously-skip-permissions', '--sandbox']);

  assert.deepEqual(modelArgs('agy', 'gemini-4-neon-high'), ['--model', 'gemini-4-neon-high']);
  assert.deepEqual(effortArgs('agy', 'max'), ['--effort', 'max']);
  assert.deepEqual(EFFORT_HINTS.agy, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('memberSettings.js：支持 full 档、allowedCommands 兼容 full、切后端到 agy 收敛档位', () => {
  const base = {
    id: 'm1', name: 'alice', backend: 'claude', tier: TIER.READONLY,
    role: 'member', persona: '', extraArgs: [], extraArgsText: '',
  };

  // claude(readonly) → agy：自动归一化为 read 并重置 session
  const toAgy = planMemberUpdate({ member: base, patch: { backend: 'agy' } });
  assert.equal(toAgy.ok, true);
  assert.equal(toAgy.member.backend, 'agy');
  assert.equal(toAgy.member.tier, TIER.READ);
  assert.equal(toAgy.member.sessionReset, true);

  // claude(write-ask) → agy：agy 不支持 write-ask，回落到 read
  const fromAsk = planMemberUpdate({
    member: { ...base, tier: TIER.WRITE_ASK },
    patch: { backend: 'agy' },
  });
  assert.equal(fromAsk.ok, true);
  assert.equal(fromAsk.member.tier, TIER.READ);

  // claude(full) → codex / agy：保持 full 不降级
  for (const target of ['codex', 'agy', 'opencode']) {
    const keepFull = planMemberUpdate({
      member: { ...base, tier: TIER.FULL },
      patch: { backend: target },
    });
    assert.equal(keepFull.ok, true);
    assert.equal(keepFull.member.tier, TIER.FULL);
  }

  // allowedCommands 在 full 档允许保留，在 write/read/readonly 仍拒绝
  const fullWithCmds = planMemberUpdate({
    member: { ...base, tier: TIER.FULL },
    patch: { allowedCommands: 'curl wget' },
  });
  assert.equal(fullWithCmds.ok, true);
  assert.deepEqual(fullWithCmds.member.allowedCommands, ['curl', 'wget']);

  const writeWithCmds = planMemberUpdate({
    member: { ...base, tier: TIER.WRITE },
    patch: { allowedCommands: 'curl' },
  });
  assert.equal(writeWithCmds.ok, false);
});

test('runner.js：agy 认证环境变量隔离且不放行 BASH_ENV / LD_PRELOAD', () => {
  assert.deepEqual(
    AUTH_VARS_BY_BACKEND.agy,
    ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTIGRAVITY_API_KEY', 'AGY_API_KEY'],
  );

  withEnv({
    GEMINI_API_KEY: 'gem-secret',
    GOOGLE_API_KEY: 'goo-secret',
    ANTIGRAVITY_API_KEY: 'anti-secret',
    AGY_API_KEY: 'agy-secret',
    ANTHROPIC_AUTH_TOKEN: 'cl-secret',
    OPENAI_API_KEY: 'oa-secret',
    BASH_ENV: '/tmp/evil.sh',
    LD_PRELOAD: '/tmp/evil.so',
  }, () => {
    const agyEnv = childEnv({}, { backend: 'agy' });
    assert.equal(agyEnv.GEMINI_API_KEY, 'gem-secret');
    assert.equal(agyEnv.GOOGLE_API_KEY, 'goo-secret');
    assert.equal(agyEnv.ANTIGRAVITY_API_KEY, 'anti-secret');
    assert.equal(agyEnv.AGY_API_KEY, 'agy-secret');
    assert.equal('ANTHROPIC_AUTH_TOKEN' in agyEnv, false, 'agy 不能看到 Anthropic 凭据');
    assert.equal('OPENAI_API_KEY' in agyEnv, false, 'agy 不能看到 OpenAI 凭据');
    assert.equal('BASH_ENV' in agyEnv, false);
    assert.equal('LD_PRELOAD' in agyEnv, false);

    const claudeEnv = childEnv({}, { backend: 'claude' });
    assert.equal('GEMINI_API_KEY' in claudeEnv, false, 'claude 不能看到 Gemini 凭据');
    assert.equal('GOOGLE_API_KEY' in claudeEnv, false, 'claude 不能看到 Google 凭据');
    assert.equal('AGY_API_KEY' in claudeEnv, false, 'claude 不能看到 agy 凭据');
    assert.equal('ANTIGRAVITY_API_KEY' in claudeEnv, false);
  });
});

/* ---------------- 5. src/core/backends.js 诊断与模型发现 ---------------- */

test('backends.js：纯解析器处理 agy models / codex config.toml / opencode debug config', () => {
  const agyParsed = parseAgyModelsOutput(
    '\r⠋ Fetching...\rgemini-4-neon-high\tGemini 4 Neon (High)\nclaude-opus-5-5-high\tClaude Opus 5.5\ngemini-4-neon-high\tDup\n',
  );
  assert.deepEqual(agyParsed, ['gemini-4-neon-high', 'claude-opus-5-5-high']);

  const cxParsed = parseCodexConfigToml(`
# 注释
model_provider = "superai"
model = "deepseek-flash"
model_catalog_json = "/tmp/cat.json"

[model_providers.superai]
env_key = "SUPERAI_API_KEY"

[profiles.openai]
model = "gpt-6.1-sol"
`);
  assert.equal(cxParsed.modelProvider, 'superai');
  assert.equal(cxParsed.model, 'deepseek-flash');
  assert.equal(cxParsed.activeEnvKey, 'SUPERAI_API_KEY');
  assert.equal(cxParsed.modelCatalogJson, '/tmp/cat.json');
  assert.deepEqual(cxParsed.profileModels, ['gpt-6.1-sol']);

  const ocParsed = parseOpencodeConfigJson(
    'INFO loading config\n{"model":"cpa/deepseek-flash","provider":{"cpa":{"models":{"deepseek-flash":{},"GLM-5.3":{}}},"claude":{"models":{"claude-opus-5-5":{}}}}}',
  );
  assert.equal(ocParsed.configuredModel, 'cpa/deepseek-flash');
  assert.deepEqual(ocParsed.models, ['cpa/deepseek-flash', 'cpa/GLM-5.3', 'claude/claude-opus-5-5']);
});

test('backends.js：inspectBackends 返回全部 4 个后端结构化信息、快速完成且不泄露密钥', async () => {
  clearBackendsCache();
  const t0 = Date.now();
  const list = await inspectBackends({ force: true });
  const elapsed = Date.now() - t0;

  assert.equal(list.length, 4);
  assert.deepEqual(list.map((b) => b.id), ALL_BACKENDS);
  assert.ok(elapsed < 6000, `inspectBackends 应快速返回，实际耗时 ${elapsed}ms`);

  for (const b of list) {
    assert.equal(typeof b.label, 'string');
    assert.equal(typeof b.installed, 'boolean');
    assert.equal(typeof b.bin, 'string');
    assert.ok(Array.isArray(b.tiers) && b.tiers.includes(TIER.FULL));
    assert.equal(b.defaultTier, TIER.FULL);
    assert.ok(Array.isArray(b.effortHints));
    assert.equal(typeof b.supportsStreaming, 'boolean');
    assert.ok(Array.isArray(b.models));
    assert.ok(['ready', 'warn', 'missing'].includes(b.status));
    assert.ok(Array.isArray(b.issues));
    assert.equal(b.probe, null);
  }

  // 确认不会意外暴露任何认证 token
  const serialized = JSON.stringify(list);
  assert.doesNotMatch(serialized, /ANTHROPIC_AUTH_TOKEN|sk-[A-Za-z0-9]{10,}/);

  // 30 秒内再次调用命中缓存（几乎瞬间返回）
  const t1 = Date.now();
  const cached = await inspectBackends();
  assert.ok((Date.now() - t1) < 200, '30 秒内应命中缓存');
  assert.deepEqual(cached.map((b) => b.id), ALL_BACKENDS);
});
