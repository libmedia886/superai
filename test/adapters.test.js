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

test('Claude 可写+执行档：加 Bash', () => {
  for (const tier of ['write-exec', 'writeExec']) {
    const a = tierArgs(tier);
    assert.ok(a[a.indexOf('--tools') + 1].includes('Bash'));
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
  }
});

test('Codex 中间档直接拒绝，不静默降级成 workspace-write', () => {
  assert.throws(() => new CodexAdapter({ backend: 'codex', tier: 'write' }), /不支持/);
});

test('Codex 合法档位可构造', () => {
  assert.doesNotThrow(() => new CodexAdapter({ backend: 'codex', tier: 'readonly' }));
  assert.doesNotThrow(() => new CodexAdapter({ backend: 'codex', tier: 'write-exec' }));
});
