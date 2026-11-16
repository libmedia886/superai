import test from 'node:test';
import assert from 'node:assert/strict';
import { exportMarkdown } from '../src/core/export.js';

const room = { name: '测试房间', goal: '把登录页做完' };
const members = [
  { id: 'lead', name: 'lead', role: 'leader', backend: 'claude' },
  { id: 'bob', name: 'bob', role: 'member', backend: 'codex' },
];

function base(over = {}) {
  return exportMarkdown({
    room, members,
    messages: [
      { id: 'M1', senderId: 'human', body: '@lead 开工', at: '2026-11-16T06:00:00Z' },
      { id: 'M2', senderId: 'lead', body: '我来拆。\n```action\n{"action":"task.create","title":"x"}\n```',
        at: '2026-11-16T06:00:10Z', durationMs: 3200, usageTokens: 1200 },
      { id: 'M3', senderId: 'bob', body: '做完了。', at: '2026-11-16T06:01:00Z', durationMs: 5000,
        usageTokens: 800, isSummary: false },
    ],
    ...over,
  });
}

test('包含房间名与目标', () => {
  const md = base();
  assert.match(md, /^# 测试房间/);
  assert.match(md, /目标.*把登录页做完/);
});

test('★ 每条发言都有说话人和时间', () => {
  const md = base();
  assert.match(md, /### 👤 老板/);
  assert.match(md, /### lead/);
  assert.match(md, /### bob/);
  assert.match(md, /2026-11-16/);
});

test('★ 显示耗时和 token', () => {
  const md = base();
  assert.match(md, /3\.2s/);
  assert.match(md, /1\.2k tok/);
});

test('★ 总结和普通发言能一眼分开', () => {
  const md = exportMarkdown({
    room, members,
    messages: [
      { id: 'M1', senderId: 'lead', body: '普通发言', at: '2026-11-16T06:00:00Z' },
      { id: 'M2', senderId: 'lead', body: '这是结论', at: '2026-11-16T06:01:00Z', isSummary: true },
    ],
  });
  assert.match(md, /### 📌 lead（总结）/);
  assert.match(md, /### lead\n/);   // 普通那条没有 📌
  assert.doesNotMatch(md, /### 📌 lead（总结）[\s\S]*### 📌 lead（总结）/);
});

test('★ 动作块不进正文（技术细节不该出现在给人看的记录里）', () => {
  const md = base();
  assert.doesNotMatch(md, /action.*task\.create/);
  assert.match(md, /我来拆。/);
});

test('任务看板单独一节，含状态', () => {
  const md = exportMarkdown({
    room, members,
    messages: [],
    tasks: [
      { id: 'T-001', title: '写登录页', status: '完成', assignee: 'bob', createdBy: 'lead', repo: '/tmp/p', baseBranch: 'main' },
      { id: 'T-002', title: '写测试', status: '进行中', assignee: 'bob' },
    ],
  });
  assert.match(md, /## 任务/);
  assert.match(md, /### 完成（1）/);
  assert.match(md, /### 进行中（1）/);
  assert.match(md, /\*\*T-001\*\* 写登录页 — @bob/);
});

test('任务里能看到改了哪些文件', () => {
  const md = exportMarkdown({
    room, members, messages: [],
    tasks: [{ id: 'T-001', title: 'x', status: '完成', assignee: 'bob' }],
    toolLog: [
      { agentId: 'bob', taskId: 'T-001', action: 'write', path: '/repo/app.js', at: '2026-11-16T06:00:00Z' },
      { agentId: 'bob', taskId: 'T-001', action: 'edit', path: '/repo/style.css', at: '2026-11-16T06:01:00Z' },
    ],
  });
  assert.match(md, /改动：2 个文件/);
  assert.match(md, /app\.js/);
  assert.match(md, /style\.css/);
});

test('失败的动作要留痕（事后能查为什么没成）', () => {
  const md = exportMarkdown({
    room, members, messages: [],
    tasks: [{ id: 'T-001', title: 'x', status: '阻塞', assignee: 'bob' }],
    actionLog: [{ agentId: 'bob', taskId: 'T-001', label: 'task.update', ok: false, reason: '任务不存在' }],
  });
  assert.match(md, /失败的动作/);
  assert.match(md, /任务不存在/);
});

test('写操作明细附录', () => {
  const md = exportMarkdown({
    room, members, messages: [],
    toolLog: [
      { agentId: 'bob', action: 'write', path: '/repo/a.js', at: '2026-11-16T06:00:00Z' },
      { agentId: 'bob', action: 'bash', command: 'npm test', at: '2026-11-16T06:01:00Z' },
    ],
  });
  assert.match(md, /附录：写操作明细/);
  assert.match(md, /npm test/);
});

test('空房间也能导出（不报错、有说明）', () => {
  const md = exportMarkdown({ room, members: [], messages: [], tasks: [] });
  assert.match(md, /还没有任何对话/);
  assert.match(md, /# 测试房间/);
});

test('管道符会被转义（否则表格会断）', () => {
  const md = exportMarkdown({
    room, members, messages: [],
    tasks: [{ id: 'T-1', title: 'a|b', status: '完成' }],
  });
  assert.ok(md.includes('a|b'), '标题里的管道符不该破坏结构');
});

test('头部统计准确', () => {
  const md = base();
  assert.match(md, /对话条数 \| 3（其中 AI 发言 2）/);
  assert.match(md, /累计用量 \| 2\.0k token/);
});

test('★ seq 有重复时，导出件顶部必须有警告（别人会拿它对账）', async () => {
  const { exportMarkdown } = await import('../src/core/export.js');
  const warn = '本房间有 159 条事件的 seq 与更早事件重复。回溯请以消息顺序与时间戳为准。';
  const md = exportMarkdown({
    room: { name: 'R', goal: '' }, messages: [], tasks: [], roster: [],
    toolLog: [], actionLog: [], members: [], nameOf: (x) => x,
    seqWarning: warn,
  });
  assert.match(md, /⚠️/);
  assert.match(md, /seq 与更早事件重复/);

  const clean = exportMarkdown({
    room: { name: 'R', goal: '' }, messages: [], tasks: [], roster: [],
    toolLog: [], actionLog: [], members: [], nameOf: (x) => x,
  });
  assert.doesNotMatch(clean, /seq/, '没问题的房间不该出现这条噪音');
});
