/**
 * 审计日志只追加、不改写。
 *
 * 这不是洁癖：审计日志一旦可被重写，事后追责就没有意义了。
 * 所以这里断言的是**文件内容层面**的行为，不是内存状态。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'audit-'));
  const path = join(dir, 'room.jsonl');
  const store = new Store(path);
  await store.load();
  return { store, path };
}

function parseLines(raw) {
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test('★ 修改任务时，旧事件行一个字节都不变', async () => {
  const { store, path } = await makeStore();

  await store.createTask({ id: 'T-001', title: '原始标题', status: '待办', assignee: 'bob' });
  const afterCreate = await readFile(path, 'utf8');

  await store.updateTask('T-001', { status: '进行中' });
  await store.updateTask('T-001', { status: '完成' });
  const afterUpdates = await readFile(path, 'utf8');

  assert.ok(
    afterUpdates.startsWith(afterCreate),
    '追加式日志必须以原有内容为前缀——旧行被改写就说明不是真追加',
  );

  // 内存态反映最新值
  assert.equal(store.tasks.get('T-001').status, '完成');
  // 但事件流里三条都在
  assert.equal(parseLines(afterUpdates).length, 3);
});

test('旧事件里的原始值仍然可追溯（未被后续更新覆盖）', async () => {
  const { store, path } = await makeStore();

  await store.createTask({ id: 'T-001', title: '原始标题', status: '待办' });
  await store.updateTask('T-001', { status: '完成' });

  const lines = parseLines(await readFile(path, 'utf8'));
  const createEvent = lines.find((l) => l.kind === 'task.create');
  assert.equal(createEvent.task.status, '待办', '存档里必须保留当时的真实状态');
  assert.equal(createEvent.task.title, '原始标题');
});

test('事件序号单调递增，可用于排序与断点续读', async () => {
  const { store, path } = await makeStore();
  await store.addMessage({ senderId: 'human', body: '一' });
  await store.addMessage({ senderId: 'bob', body: '二' });
  await store.addMessage({ senderId: 'lead', body: '三' });

  const lines = parseLines(await readFile(path, 'utf8'));
  const seqs = lines.map((l) => l.seq);
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] > seqs[i - 1], `序号必须递增：${seqs.join(',')}`);
  }
});

test('重放（重新 load）得到与内存一致的状态', async () => {
  const { store, path } = await makeStore();
  await store.createTask({ id: 'T-001', title: 'A', status: '待办', assignee: 'bob' });
  await store.updateTask('T-001', { status: '进行中' });
  await store.updateRoster('bob', { selfDuties: '负责审查' });
  await store.addMessage({ senderId: 'human', body: '开始' });

  const reloaded = new Store(path);
  await reloaded.load();

  assert.equal(reloaded.tasks.get('T-001').status, '进行中');
  assert.equal(reloaded.roster.get('bob').selfDuties, '负责审查');
  assert.equal(reloaded.messages.length, 1);
});

test('每次写入都是一整行（不会出现半行）', async () => {
  const { store, path } = await makeStore();
  for (let i = 0; i < 10; i += 1) {
    await store.addMessage({ senderId: 'bob', body: `第 ${i} 条`.repeat(50) });
  }
  const raw = await readFile(path, 'utf8');
  assert.ok(raw.endsWith('\n'), '每条记录都以换行结尾');
  const lines = parseLines(raw);
  assert.equal(lines.length, 10);
  for (const l of lines) assert.equal(typeof l.kind, 'string');
});

test('并发追加不会互相踩（写入串行化）', async () => {
  const { store, path } = await makeStore();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.addMessage({ senderId: 'bob', body: `并发 ${i}` })),
  );
  const lines = parseLines(await readFile(path, 'utf8'));
  assert.equal(lines.length, 20, '20 条并发写入应完整落盘，不能有覆盖丢失');
});
