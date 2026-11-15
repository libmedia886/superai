/**
 * 环境变量白名单（安全修正）。
 *
 * 原实现是"全部继承 + 覆盖几个"，这会让 agent 子进程拿到与它无关的所有密钥
 * ——数据库密码、云凭据、CI token 全在里面。agent 一旦被内容带偏或误用工具，
 * 这些就会出现在它的上下文里。
 *
 * 现在改成白名单：只放行运行必需 + 终端地区 + 该后端自己的认证变量。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { childEnv, sensitiveVarNames, AUTH_VARS_BY_BACKEND } from '../src/core/runner.js';

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('运行必需的变量保留', () => {
  const env = childEnv();
  assert.ok('PATH' in env, 'PATH 必须保留，否则找不到 CLI');
  assert.ok('HOME' in env || 'USERPROFILE' in env);
});

test('终端控制变量被固定，保证输出可解析', () => {
  const env = childEnv();
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.TERM, 'dumb');
  assert.ok(env.LANG);
});

test('★ 无关密钥被过滤掉', () => {
  withEnv({
    DATABASE_PASSWORD: 'super-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GITHUB_TOKEN: 'gh-secret',
    MY_APP_SECRET: 'app-secret',
  }, () => {
    const env = childEnv();
    assert.ok(!('DATABASE_PASSWORD' in env), '数据库密码不能进 agent 进程');
    assert.ok(!('AWS_SECRET_ACCESS_KEY' in env), '云凭据不能进 agent 进程');
    assert.ok(!('GITHUB_TOKEN' in env), 'CI token 不能进 agent 进程');
    assert.ok(!('MY_APP_SECRET' in env));
  });
});

test('★ 指定后端时，只放行该后端自己的认证变量', () => {
  withEnv({
    ANTHROPIC_AUTH_TOKEN: 'claude-token',
    OPENAI_API_KEY: 'openai-key',
  }, () => {
    const claudeEnv = childEnv({}, { backend: 'claude' });
    assert.equal(claudeEnv.ANTHROPIC_AUTH_TOKEN, 'claude-token', 'Claude 必须能拿到自己的 token');
    assert.ok(!('OPENAI_API_KEY' in claudeEnv), 'Claude 进程不该看到 OpenAI 的 key');

    const codexEnv = childEnv({}, { backend: 'codex' });
    assert.equal(codexEnv.OPENAI_API_KEY, 'openai-key');
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in codexEnv), 'Codex 进程不该看到 Anthropic 的 token');
  });
});

test('未指定后端时放行全部已知认证前缀（兼容旧调用）', () => {
  withEnv({ ANTHROPIC_AUTH_TOKEN: 'x', OPENAI_API_KEY: 'y' }, () => {
    const env = childEnv();
    assert.ok('ANTHROPIC_AUTH_TOKEN' in env);
    assert.ok('OPENAI_API_KEY' in env);
  });
});

test('地区与 XDG 变量放行（CLI 靠它找配置和会话）', () => {
  withEnv({ LC_ALL: 'zh_CN.UTF-8', XDG_CONFIG_HOME: '/tmp/xdg' }, () => {
    const env = childEnv();
    assert.equal(env.LC_ALL, 'zh_CN.UTF-8');
    assert.equal(env.XDG_CONFIG_HOME, '/tmp/xdg');
  });
});

test('代理变量放行（企业网络下没它连不出去）', () => {
  withEnv({ HTTPS_PROXY: 'http://proxy:8080' }, () => {
    assert.equal(childEnv().HTTPS_PROXY, 'http://proxy:8080');
  });
});

test('extra 可以强制覆盖（调用方显式指定优先）', () => {
  const env = childEnv({ TERM: 'xterm-256color', MAROOM_TASK: 'T-001' });
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.MAROOM_TASK, 'T-001');
});

test('sensitiveVarNames 只列名字不列值（供诊断）', () => {
  const names = sensitiveVarNames({
    ANTHROPIC_AUTH_TOKEN: 'secret-value',
    PATH: '/usr/bin',
    DB_PASSWORD: 'pw',
  });
  assert.deepEqual(names.sort(), ['ANTHROPIC_AUTH_TOKEN', 'DB_PASSWORD']);
  assert.ok(!names.join(',').includes('secret-value'));
});

test('每个后端都有明确的认证变量清单（新增后端时必须补）', () => {
  for (const backend of ['claude', 'codex', 'opencode']) {
    assert.ok(Array.isArray(AUTH_VARS_BY_BACKEND[backend]), `${backend} 缺少认证变量清单`);
    assert.ok(AUTH_VARS_BY_BACKEND[backend].length > 0);
  }
});
