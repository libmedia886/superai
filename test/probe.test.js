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

test('可写+执行档：命令跑不了 = BROKEN', () => {
  assert.equal(judge({
    write: 'OK', writeOutside: 'BLOCKED', readOutside: 'BLOCKED', exec: 'BLOCKED',
  }, TIER.WRITE_EXEC), 'BROKEN');
  assert.equal(judge({
    write: 'OK', writeOutside: 'BLOCKED', readOutside: 'BLOCKED', exec: 'OK',
  }, TIER.WRITE_EXEC), 'VERIFIED');
});

test('Codex 没有中间档，界面不能给出选了不生效的选项', () => {
  assert.equal(supportsTier('codex', TIER.READONLY), true);
  assert.equal(supportsTier('codex', TIER.WRITE), false);
  assert.equal(supportsTier('codex', TIER.WRITE_ASK), false);
  assert.equal(supportsTier('codex', TIER.WRITE_EXEC), true);
  assert.deepEqual(availableTiers('codex'), [TIER.READONLY, TIER.WRITE_EXEC]);
});

test('"每次询问"档只有 Claude 能表达（--permission-prompts host）', () => {
  assert.ok(availableTiers('claude').includes(TIER.WRITE_ASK));
  assert.ok(!availableTiers('codex').includes(TIER.WRITE_ASK));
  assert.ok(!availableTiers('opencode').includes(TIER.WRITE_ASK));
});
