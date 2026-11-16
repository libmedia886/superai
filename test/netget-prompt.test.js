/**
 * 权限说明必须说准「怎么调」——尤其是 netget 的绝对路径。
 *
 * 真实事故（2026-11-17 01:30，管理方真机复现）：
 * `prompt.js` 只写「只能执行这些命令：netget」，不给绝对路径。
 * 审批器是**字面前缀匹配**，于是模型执行裸 `netget` 一律被拒：
 *   只告诉它「netget」      → tool_use 的 permission_decision = reject
 *   给出绝对路径            → accept，文件真的落盘 577 字节
 * 即：功能做完了、界面勾了、成员配了，实际一条也跑不了。
 *
 * 同一段话还把 netget 和裸命令混为一谈（「这些命令不受工作目录限制」）——
 * 对 curl 成立，对 netget 恰恰相反。模型照这句话去试 `file://` / `-o /tmp`，
 * 每次吃 exit 2/3，白烧轮次。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { permissionSentence } from '../src/core/prompt.js';

const NETGET = '/home/u/.multiagent-chat/rooms/r-1/bin/netget';

test('★ netget 必须给出绝对路径（否则模型写裸命令一定被拒）', () => {
  const s = permissionSentence({
    tier: 'write-exec', backend: 'claude', allowedCommands: ['netget'], netgetPath: NETGET,
  });
  assert.ok(s.includes(NETGET), `提示词里必须出现绝对路径，实际：${s}`);
  assert.match(s, /写全路径|必须写全/, '要明确要求写全路径');
});

test('★ netget 的描述不能说成"不受目录限制"', () => {
  const s = permissionSentence({
    tier: 'write-exec', backend: 'claude', allowedCommands: ['netget'], netgetPath: NETGET,
  });
  assert.match(s, /http\/https/, '要说清只支持 http/https');
  assert.match(s, /读不到本机文件|file:\/\//, '要说清读不到本机文件');
  assert.match(s, /写不出工作目录/, '要说清写不出工作目录');
  assert.match(s, /不能上传/, '要说清不能上传');
  // 对 netget 单独一句时，不得把它描述成"不受限制"
  const netgetLine = s.split('\n').find((l) => l.includes(NETGET)) ?? '';
  assert.doesNotMatch(netgetLine, /不受工作目录限制/);
});

test('netget 与裸命令混用时，两段话必须分开', () => {
  const s = permissionSentence({
    tier: 'write-exec', backend: 'claude', allowedCommands: ['netget', 'curl'], netgetPath: NETGET,
  });
  assert.ok(s.includes(NETGET));
  assert.match(s, /这些命令\*\*不受工作目录限制\*\*/, '裸命令仍要有"没有目录墙"的警告');
  assert.ok(s.indexOf(NETGET) < s.indexOf('不受工作目录限制'),
    'netget 的限制说明必须与裸命令警告分开，不能共用一个结论');
});

test('没生成包装器时不许假装可用', () => {
  const s = permissionSentence({
    tier: 'write-exec', backend: 'claude', allowedCommands: ['netget'], netgetPath: null,
  });
  assert.match(s, /不可用/, '要如实说联网查询不可用');
  assert.doesNotMatch(s, /除上述联网查询命令外/, '不可用时不能暗示它还能用');
});

test('只有裸命令时行为不变（回归保护）', () => {
  const s = permissionSentence({
    tier: 'write-exec', backend: 'claude', allowedCommands: ['curl'],
  });
  assert.match(s, /只能执行这些命令：curl/);
  assert.match(s, /不受工作目录限制/);
});

test('空清单：明确说一条命令都不能跑', () => {
  const s = permissionSentence({ tier: 'write-exec', backend: 'claude', allowedCommands: [] });
  assert.match(s, /不能执行任何命令/);
});
