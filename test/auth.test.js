/**
 * 访问令牌。
 *
 * 为什么必须有：agent 一旦有写权限，这个 URL 就是一台能改你代码的遥控器。
 * 绑到局域网却不认证，等于把它开放给整个网段。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized } from '../src/server.js';

const token = 'abc123';
const fakeReq = (cookie) => ({ headers: cookie ? { cookie } : {} });
const fakeUrl = (qs = '') => new URL(`http://x/${qs}`);

test('未设置令牌时一律放行（本机模式）', () => {
  assert.equal(isAuthorized(fakeReq(), fakeUrl(), null), true);
  assert.equal(isAuthorized(fakeReq(), fakeUrl(), ''), true);
});

test('★ 设了令牌且请求不带令牌 → 拒绝', () => {
  assert.equal(isAuthorized(fakeReq(), fakeUrl(), token), false);
});

test('query 参数带对令牌 → 放行', () => {
  assert.equal(isAuthorized(fakeReq(), fakeUrl('?t=abc123'), token), true);
});

test('query 参数令牌错误 → 拒绝', () => {
  assert.equal(isAuthorized(fakeReq(), fakeUrl('?t=wrong'), token), false);
  assert.equal(isAuthorized(fakeReq(), fakeUrl('?t=abc12'), token), false, '前缀不能通过');
  assert.equal(isAuthorized(fakeReq(), fakeUrl('?t=abc1234'), token), false, '超集不能通过');
});

test('Cookie 带对令牌 → 放行（刷新后不必反复带参数）', () => {
  assert.equal(isAuthorized(fakeReq(`maroom_token=${token}`), fakeUrl(), token), true);
});

test('Cookie 令牌错误 → 拒绝', () => {
  assert.equal(isAuthorized(fakeReq('maroom_token=wrong'), fakeUrl(), token), false);
});

test('多个 Cookie 时仍能正确匹配', () => {
  const cookie = `theme=dark; maroom_token=${token}; lang=zh`;
  assert.equal(isAuthorized(fakeReq(cookie), fakeUrl(), token), true);
});

test('空令牌不构成通过（防止启动参数写空串）', () => {
  assert.equal(isAuthorized(fakeReq('maroom_token='), fakeUrl('?t='), null), true, '未启用时放行');
  assert.equal(isAuthorized(fakeReq('maroom_token='), fakeUrl('?t='), token), false, '启用时空串不能过');
});
