import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionConfig, cleanText, OpencodeAdapter } from '../src/adapters/opencode.js';

test('只读档：全部 deny，包括 external_directory 和 task', () => {
  const p = permissionConfig('readonly');
  for (const key of ['read', 'edit', 'bash', 'task', 'external_directory', 'glob', 'grep', 'list']) {
    assert.equal(p[key], 'deny', `${key} 必须 deny`);
  }
});

test('★ external_directory 必须显式 deny（默认是允许的，实测能写到 cwd 外）', () => {
  for (const tier of ['readonly', 'write', 'write-exec']) {
    assert.equal(permissionConfig(tier).external_directory, 'deny', `${tier} 档必须禁外部目录`);
  }
});

test('中间档：可写但不许跑命令', () => {
  const p = permissionConfig('write');
  assert.equal(p.edit, 'allow');
  assert.equal(p.bash, 'deny');
});

test('可写+执行档：bash 放开，但外部目录与 task 仍禁', () => {
  const p = permissionConfig('write-exec');
  assert.equal(p.bash, 'allow');
  assert.equal(p.external_directory, 'deny');
  assert.equal(p.task, 'deny', 'task 会派生子代理，是潜在越权口子，必须禁');
});

test('乱码过滤：模型把工具调用语法当文本吐出来时要清掉', () => {
  const dirty = '前文\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command">ls -la</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  const cleaned = cleanText(dirty);
  assert.equal(cleaned, '前文');
  assert.ok(!cleaned.includes('DSML'));
});

test('乱码过滤不影响正常文本', () => {
  assert.equal(cleanText('正常的一句话。'), '正常的一句话。');
  assert.equal(cleanText(''), '');
});

test('opencode 不支持逐字流式（与 Codex 同类）', () => {
  assert.equal(new OpencodeAdapter({ backend: 'opencode', tier: 'readonly' }).supportsStreaming, false);
});
