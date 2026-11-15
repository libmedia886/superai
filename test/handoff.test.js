/**
 * CR-006 压缩两阶段握手：ASK → checkpoint → FIRE。
 *
 * 核心不变量：**没拿到交接就绝不轮换**。压缩时机不对会丢工作，
 * 而 agent 自己不知道丢了——它只会基于残缺上下文继续说，越说越偏。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractHandoff, HandoffState, PHASE, ASK_INSTRUCTION, buildHandoffRebootstrap,
} from '../src/core/handoff.js';

/* ---------- 解析 ---------- */

test('提取交接块，并从正文里移除', () => {
  const reply = [
    '这个问题我建议用指数退避重试。',
    '',
    '```handoff',
    '正在做：给登录页加失败重试',
    '已定：重试 3 次，指数退避',
    '待办：bob 还没回测试结果',
    '我的立场：重试不应该弹窗打扰用户',
    '```',
  ].join('\n');

  const r = extractHandoff(reply);
  assert.ok(r.handoff.includes('重试 3 次'));
  assert.ok(r.handoff.includes('我的立场'));
  assert.ok(!r.text.includes('handoff'), '正文里不该留下交接块');
  assert.ok(r.text.includes('指数退避重试'), '正常内容要保留');
});

test('空壳交接块判为不合格（不是"有块就算数"）', () => {
  const r = extractHandoff('回答如下。\n```handoff\n\n```');
  assert.equal(r.handoff, null);
  assert.equal(r.malformed, true);
});

test('太短的交接块判为不合格', () => {
  const r = extractHandoff('回答。\n```handoff\n好的\n```');
  assert.equal(r.handoff, null);
  assert.equal(r.malformed, true);
});

test('没有交接块时正文原样返回', () => {
  const r = extractHandoff('就是一段普通回复。');
  assert.equal(r.handoff, null);
  assert.equal(r.malformed, false);
  assert.equal(r.text, '就是一段普通回复。');
});

test('大小写与 fence 变体都能识别', () => {
  const upper = extractHandoff('x\n```HANDOFF\n正在做：测试内容够长了吧\n```');
  assert.ok(upper.handoff);
  assert.ok(upper.handoff.includes('测试内容够长了吧'));
});

/* ---------- 状态机 ---------- */

test('★ 没拿到交接就不许轮换（核心不变量）', () => {
  const s = new HandoffState();
  s.ask('lead');
  assert.equal(s.canFire('lead'), false, '只是问了，还没答，不能压');

  // 它这轮没给交接块
  const r = s.observe('lead', '我继续干活。');
  assert.equal(r.gotHandoff, false);
  assert.equal(s.canFire('lead'), false, '没交接仍然不能压');
  assert.equal(s.snapshot('lead').phase, PHASE.AWAITING, '保持等待，下一轮再要');
});

test('拿到交接后进入 READY，才允许轮换', () => {
  const s = new HandoffState();
  s.ask('lead');
  const r = s.observe('lead', '正常回答。\n```handoff\n正在做：X\n已定：Y\n待办：Z\n我的立场：W\n```');
  assert.equal(r.gotHandoff, true);
  assert.equal(s.canFire('lead'), true);
  assert.equal(s.snapshot('lead').phase, PHASE.READY);
});

test('重复 ask 不会覆盖已拿到的交接', () => {
  const s = new HandoffState();
  s.ask('lead');
  s.observe('lead', '```handoff\n正在做：X\n已定：Y\n待办：Z\n立场：W\n```');
  const before = s.snapshot('lead').handoff;

  s.ask('lead');   // 又来一次
  assert.equal(s.canFire('lead'), true, '已有交接仍然可直接压');
  assert.equal(s.snapshot('lead').handoff, before);
});

test('轮换后重置，下一轮不会复用旧交接', () => {
  const s = new HandoffState();
  s.ask('lead');
  s.observe('lead', '```handoff\n正在做：X\n已定：Y\n待办：Z\n立场：W\n```');
  s.reset('lead');

  assert.equal(s.canFire('lead'), false);
  assert.equal(s.snapshot('lead').handoff, null);
  assert.equal(s.snapshot('lead').phase, PHASE.IDLE);
});

test('每个 agent 的握手状态互相独立', () => {
  const s = new HandoffState();
  s.ask('lead');
  s.observe('lead', '```handoff\n正在做：X\n已定：Y\n待办：Z\n立场：W\n```');
  s.ask('bob');

  assert.equal(s.canFire('lead'), true);
  assert.equal(s.canFire('bob'), false, 'bob 还没交，不能跟着 lead 一起压');
});

test('needsAsk：等交接和已有交接时都要带 ASK 段', () => {
  const s = new HandoffState();
  assert.equal(s.needsAsk('lead'), false, '还没开始，不需要问');

  s.ask('lead');
  assert.equal(s.needsAsk('lead'), true);

  s.observe('lead', '```handoff\n正在做：X\n已定：Y\n待办：Z\n立场：W\n```');
  assert.equal(s.needsAsk('lead'), true, 'READY 状态也要带，防止它这轮又忘了给');
});

/* ---------- 重建 ---------- */

test('轮换后用 agent 自己的交接，而不是我们的摘要', () => {
  const p = buildHandoffRebootstrap({
    agentName: 'lead',
    handoff: '正在做：加登录页\n已定：指数退避 3 次\n待办：等 bob 测试\n我的立场：不弹窗',
    recent: [{ senderName: 'bob', body: '测试还没跑完' }],
  });
  assert.match(p, /加登录页/);
  assert.match(p, /不弹窗/);
  assert.match(p, /压缩前你自己写的交接/);
  assert.match(p, /请与之保持一致/);
});

test('ASK 指令要求写"自己的立场"（否则压缩后自相矛盾）', () => {
  assert.match(ASK_INSTRUCTION, /你自己表达过的立场/);
  assert.match(ASK_INSTRUCTION, /交接块不影响你正常回答问题/);
});
