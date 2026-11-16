import test from 'node:test';
import assert from 'node:assert/strict';
import { tierArgs } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';

test('Claude 只读档：清空工具，无读文件能力', () => {
  const a = tierArgs('readonly');
  assert.deepEqual(a.slice(0, 2), ['--tools', '']);
  assert.ok(!a.includes('--permission-mode'));
});

test('Claude 可写档：必须有 acceptEdits，否则写会被自动拒（实测）', () => {
  const a = tierArgs('write');
  assert.ok(a.includes('--tools'));
  assert.equal(a[a.indexOf('--tools') + 1], 'Read,Write,Edit');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(a[a.indexOf('--permission-prompts') + 1], 'none');
  // 不能带 Bash，否则就不是"可写但不跑命令"了
  assert.ok(!a[a.indexOf('--tools') + 1].includes('Bash'));
});

test('★ Claude 可写+执行档：只有给了命令白名单才加 Bash', () => {
  // 起因（实测）：acceptEdits 只自动批准文件编辑，Bash 每条仍要审批，
  // 而 --permission-prompts none 没有审批通道 → 一律被自动拒绝。
  // 所以"可写+执行"名不副实：给了 Bash 也用不上，只会让它反复重试。
  for (const tier of ['write-exec', 'writeExec']) {
    const without = tierArgs(tier);
    assert.ok(!without[without.indexOf('--tools') + 1].includes('Bash'), '没白名单就不给 Bash');
    assert.equal(without[without.indexOf('--permission-mode') + 1], 'acceptEdits');

    const withCmds = tierArgs(tier, { allowedCommands: ['curl'] });
    assert.ok(withCmds[withCmds.indexOf('--tools') + 1].includes('Bash'));
    assert.ok(withCmds.includes('Bash(curl:*)'), '白名单要拼成 Bash(curl:*)');
  }
});

test('命令白名单默认空 → 命令行里没有任何 Bash 授权', () => {
  const a = tierArgs('write-exec', { allowedCommands: [] });
  assert.ok(!a.join(' ').includes('--allowedTools'));
});

test('Codex 中间档直接拒绝，不静默降级成 workspace-write', () => {
  assert.throws(() => new CodexAdapter({ backend: 'codex', tier: 'write' }), /不支持/);
});

test('Codex 合法档位可构造', () => {
  assert.doesNotThrow(() => new CodexAdapter({ backend: 'codex', tier: 'readonly' }));
  assert.doesNotThrow(() => new CodexAdapter({ backend: 'codex', tier: 'write-exec' }));
});

test('★ 不支持的后端档位必须明确拒绝，不能静默降级', async () => {
  // 起因：给 codex 选 write，接口返回 200 但静默存成 readonly，
  // 用户以为设成可写了，实际跑了半天什么都没改。
  const { availableTiers, TIER } = await import('../src/core/probe.js');

  // codex 的 read-only 沙箱本来就能读，所以它没有"无工具"那一档；
  // claude/opencode 都能表达真正的"完全不给工具"
  for (const backend of ['claude', 'opencode']) {
    assert.ok(availableTiers(backend).includes(TIER.READONLY), `${backend} 必须支持只读`);
  }
  assert.ok(availableTiers('codex').includes(TIER.READ), 'codex 的只读语义就是 read');
  // codex 没有中间档，这条语义要一直成立
  assert.ok(!availableTiers('codex').includes(TIER.WRITE));
  // 只有 claude 能表达"每次询问"
  assert.deepEqual(
    [availableTiers('claude').includes(TIER.WRITE_ASK), availableTiers('codex').includes(TIER.WRITE_ASK)],
    [true, false],
  );
});
