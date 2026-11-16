import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, TIER, supportsTier, availableTiers } from '../src/core/probe.js';

const all = (v) => ({ list: v, read: v, write: v, writeOutside: v, readOutside: v, exec: v });

test('只读档：全拦住 = 生效', () => {
  assert.equal(judge({ ...all('BLOCKED') }, TIER.READONLY), 'VERIFIED');
});

test('只读档：能列目录也算漏（关键：不是看有没有拿到内容）', () => {
  assert.equal(judge({ ...all('BLOCKED'), list: 'LEAKED' }, TIER.READONLY), 'LEAKY');
});

test('只读档：泄漏内容 = 未生效', () => {
  assert.equal(judge({ ...all('BLOCKED'), read: 'LEAKED' }, TIER.READONLY), 'LEAKY');
});

test('只读档：模型答非 DENIED 的乱码，只要没泄露就算拦住', () => {
  // 实测有些模型会把工具调用语法当正文吐出来，而不是干净地答 DENIED。
  // 判据应该是"有没有拿到东西"，不是"有没有说 DENIED"。
  assert.equal(judge({ list: 'UNCLEAR', read: 'UNCLEAR' }, TIER.READONLY), 'VERIFIED');
});

test('只读档：能列出文件名就是漏了（哪怕没拿到内容）', () => {
  assert.equal(judge({ list: 'LEAKED', read: 'BLOCKED' }, TIER.READONLY), 'LEAKY');
  assert.equal(judge({ list: 'BLOCKED', read: 'LEAKED' }, TIER.READONLY), 'LEAKY');
});

test('可写档：写不进去必须是 BROKEN（静默失败最危险）', () => {
  // 和只读档不同：可写档"写不进去"用户会以为 AI 在干活、实际什么都没发生
  assert.equal(judge({
    write: 'UNCLEAR', writeOutside: 'BLOCKED', readOutside: 'BLOCKED',
  }, TIER.WRITE), 'BROKEN');
});

test('可写档：目录内写成功 + 外部读写被拦 = 生效', () => {
  assert.equal(judge({
    list: 'LEAKED', read: 'LEAKED', write: 'OK', writeOutside: 'BLOCKED', readOutside: 'BLOCKED', exec: null,
  }, TIER.WRITE), 'VERIFIED');
});

test('可写档：写不了 = BROKEN（静默失败最危险）', () => {
  assert.equal(judge({
    write: 'BLOCKED', writeOutside: 'BLOCKED', readOutside: 'BLOCKED',
  }, TIER.WRITE), 'BROKEN');
  assert.equal(judge({
    write: 'UNCLEAR', writeOutside: 'BLOCKED', readOutside: 'BLOCKED',
  }, TIER.WRITE), 'BROKEN');
});

test('可写档：能写到目录外 = 未生效', () => {
  assert.equal(judge({
    write: 'OK', writeOutside: 'LEAKED', readOutside: 'BLOCKED',
  }, TIER.WRITE), 'LEAKY');
});

test('可写档：能读目录外 = 未生效', () => {
  assert.equal(judge({
    write: 'OK', writeOutside: 'BLOCKED', readOutside: 'LEAKED',
  }, TIER.WRITE), 'LEAKY');
});

test('★ 可写+执行档：命令跑不了分两种情况', () => {
  // 默认（没给命令白名单）：claude 根本不提供 Bash 工具，
  // 所以"跑不了命令"是设计，不是沙箱异常
  assert.equal(judge({
    write: 'OK', writeOutside: 'BLOCKED', readOutside: 'BLOCKED', exec: 'BLOCKED',
  }, TIER.WRITE_EXEC, { expectNoCommands: true }), 'VERIFIED');

  // 没给 Bash 却跑出了命令 = 限制没生效，这比跑不了危险
  assert.equal(judge({
    write: 'OK', writeOutside: 'BLOCKED', readOutside: 'BLOCKED', exec: 'OK',
  }, TIER.WRITE_EXEC, { expectNoCommands: true }), 'LEAKY');

  // 期望能跑命令的场合（codex / 有白名单的 claude）：跑不了 = 静默失败
  assert.equal(judge({
    write: 'OK', writeOutside: 'BLOCKED', readOutside: 'BLOCKED', exec: 'BLOCKED',
  }, TIER.WRITE_EXEC), 'BROKEN');
  assert.equal(judge({
    write: 'OK', writeOutside: 'BLOCKED', readOutside: 'BLOCKED', exec: 'OK',
  }, TIER.WRITE_EXEC), 'VERIFIED');
});

test('★ 命令白名单双向验：清单内的能跑、清单外的被拒', () => {
  const base = { write: 'OK', writeOutside: 'BLOCKED', readOutside: 'BLOCKED', exec: 'OK' };
  assert.equal(judge({
    ...base, commands: { allowed: 'OK', denied: 'BLOCKED' },
  }, TIER.WRITE_EXEC), 'VERIFIED');

  assert.equal(judge({
    ...base, commands: { allowed: 'BROKEN', denied: 'BLOCKED' },
  }, TIER.WRITE_EXEC), 'BROKEN', '清单里的命令跑不了');

  assert.equal(judge({
    ...base, commands: { allowed: 'OK', denied: 'LEAKED' },
  }, TIER.WRITE_EXEC), 'LEAKY', '清单外的命令也能跑 = 整片放开');
});

test('Codex 没有中间档，界面不能给出选了不生效的选项', () => {
  // `-s read-only` 允许读，所以 codex 的"只读"实际是 read 档；
  // `readonly`（完全不给工具）它表达不了，硬给一个选了不生效的选项才是错。
  assert.equal(supportsTier('codex', TIER.READ), true);
  assert.equal(supportsTier('codex', TIER.READONLY), false);
  assert.equal(supportsTier('codex', TIER.READ), true);
  assert.equal(supportsTier('codex', TIER.WRITE), false);
  assert.equal(supportsTier('codex', TIER.WRITE_ASK), false);
  assert.equal(supportsTier('codex', TIER.WRITE_EXEC), true);
  assert.deepEqual(availableTiers('codex'), [TIER.READ, TIER.WRITE_EXEC]);
});

test('★ read 档存在且 claude/opencode 都支持（老板要的"可读"）', () => {
  assert.ok(availableTiers('claude').includes(TIER.READ));
  assert.ok(availableTiers('opencode').includes(TIER.READ));
  assert.ok(!availableTiers('opencode').includes(TIER.WRITE_ASK), 'opencode 没有宿主审批通道');
});

test('旧配置 codex+readonly 归一化为 read（行为不变，只改标签）', async () => {
  const { normalizeTier } = await import('../src/core/probe.js');
  assert.equal(normalizeTier('codex', TIER.READONLY), TIER.READ);
  assert.equal(normalizeTier('claude', TIER.READONLY), TIER.READONLY);
});

test('"每次询问"档只有 Claude 能表达（--permission-prompts host）', () => {
  assert.ok(availableTiers('claude').includes(TIER.WRITE_ASK));
  assert.ok(!availableTiers('codex').includes(TIER.WRITE_ASK));
  assert.ok(!availableTiers('opencode').includes(TIER.WRITE_ASK));
});
