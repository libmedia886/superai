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

/* ---------------- PATH 提权面（管理方 22:55） ---------------- */

test('★ 数据目录下的条目必须从子进程 PATH 里剔除', async () => {
  /**
   * 成员的 cwd 在数据目录内，且它可写。如果 PATH 里有数据目录下的条目，
   * 成员放一个同名可执行文件（`curl`、`git`…），子进程就会执行它 ——
   * 而本项目的全部约束（档位、命令白名单、netget）都建立在"执行的是真命令"上。
   *
   * 这是覆盖**所有后端**的唯一一层：适配器各自重设 PATH 做不到，因为
   * 成员直接跑自定义命令时根本没有包装器。
   */
  const { childEnv } = await import('../src/core/runner.js');
  const saved = process.env.PATH;
  try {
    process.env.PATH = '/tmp/room/agents/a:/usr/bin:/tmp/room/bin:/bin';
    const env = childEnv({}, { backend: 'claude', forbiddenRoots: ['/tmp/room'] });
    assert.equal(env.PATH, '/usr/bin:/bin', '数据目录下的条目全部剔除，系统目录保留');
  } finally {
    process.env.PATH = saved;
  }
});

test('★ 相对路径 / . / .. / 空段一律剔除（白名单：只接受绝对路径）', async () => {
  /**
   * 管理方 23:10 的纠正：我第一版是"剔除数据目录下的条目"（黑名单），
   * 而 `.:/usr/bin` 里根本没有数据目录字符串——`.` 就是当前目录，
   * 而当前目录正是成员可写的 cwd。等价写法还有 `./`、`bin`、`../x`。
   *
   * 所以判据必须是**白名单：只接受 `/` 开头**。
   * 这与 netget 里 CURL_BIN 的前缀白名单是同一个标准。
   */
  const { childEnv } = await import('../src/core/runner.js');
  const saved = process.env.PATH;
  try {
    for (const [input, expected] of [
      [':/usr/bin', '/usr/bin'],
      ['.:/usr/bin', '/usr/bin'],
      ['./:/usr/bin', '/usr/bin'],
      ['bin:/usr/bin', '/usr/bin'],
      ['../x:/usr/bin', '/usr/bin'],
      ['/usr/bin::', '/usr/bin'],
      ['/usr/bin:', '/usr/bin'],
      ['/opt/tools:/usr/bin', '/opt/tools:/usr/bin'],
    ]) {
      process.env.PATH = input;
      const env = childEnv({}, { backend: 'claude', forbiddenRoots: ['/home/hope/.multiagent-chat'] });
      assert.equal(env.PATH, expected, `PATH=${JSON.stringify(input)} 应变成 ${expected}`);
    }
  } finally {
    process.env.PATH = saved;
  }
});

test('绝对路径保留，前缀相同但不同的目录不误杀', async () => {
  const { childEnv } = await import('../src/core/runner.js');
  const saved = process.env.PATH;
  try {
    process.env.PATH = '/home/hope/.multiagent-chat-evil:/usr/bin';
    const env = childEnv({}, { backend: 'claude', forbiddenRoots: ['/home/hope/.multiagent-chat'] });
    assert.equal(env.PATH, '/home/hope/.multiagent-chat-evil:/usr/bin',
      '前缀相同但不是同一个目录，不能误删');
  } finally {
    process.env.PATH = saved;
  }
});

test('★ 我们依赖 childEnv 白名单挡住 BASH_ENV / LD_PRELOAD', async () => {
  /**
   * 管理方 22:55 实测：`BASH_ENV=/tmp/evil.sh` 在手工调用时能执行，
   * 但 `runner.js` 的白名单不放行它，所以在真实 spawn 路径下不可达。
   *
   * ⚠️ 这条测试锁的是一个**依赖**：如果哪天为了兼容性放开 BASH_ENV / LD_PRELOAD，
   * netget 与所有命令约束都会被绕过。放开之前必须先处理这条。
   */
  const { childEnv } = await import('../src/core/runner.js');
  const saved = { BASH_ENV: process.env.BASH_ENV, LD_PRELOAD: process.env.LD_PRELOAD };
  try {
    process.env.BASH_ENV = '/tmp/evil.sh';
    process.env.LD_PRELOAD = '/tmp/evil.so';
    const env = childEnv({}, { backend: 'claude' });
    assert.equal('BASH_ENV' in env, false, 'BASH_ENV 不能透传（否则 netget 约束被绕过）');
    assert.equal('LD_PRELOAD' in env, false, 'LD_PRELOAD 不能透传');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('★ 净化必须作用在最终结果上：经 extra 传入的 PATH 也要过滤（旁路）', async () => {
  /**
   * 管理方 2026-11-17 实测：原来先净化 base.PATH、再 `...extra`，
   * 任何调用方传 `extra.PATH` 就把净化结果覆盖回去 ——
   * **净化和旁路同时存在，而注释还写着"结构性消除"**。
   */
  const { childEnv } = await import('../src/core/runner.js');
  const dataRoot = '/home/hope/.multiagent-chat';

  // extra 传数据目录下的路径
  assert.equal(
    childEnv({ PATH: `${dataRoot}/rooms/x:/usr/bin` }, { backend: 'claude', forbiddenRoots: [dataRoot] }).PATH,
    '/usr/bin',
    'extra 传进来的数据目录条目也必须被剔除',
  );

  // extra 传相对路径（没有数据目录字符串的等价写法）
  assert.equal(childEnv({ PATH: '.:/usr/bin' }, { backend: 'claude' }).PATH, '/usr/bin');
  assert.equal(childEnv({ PATH: 'bin:/usr/bin' }, { backend: 'claude' }).PATH, '/usr/bin');
  assert.equal(childEnv({ PATH: '../x:/usr/bin' }, { backend: 'claude' }).PATH, '/usr/bin');
  assert.equal(childEnv({ PATH: ':/usr/bin' }, { backend: 'claude' }).PATH, '/usr/bin');

  // 正常绝对路径要原样保留
  assert.equal(childEnv({ PATH: '/opt/tools:/usr/bin' }, { backend: 'claude' }).PATH, '/opt/tools:/usr/bin');
});
