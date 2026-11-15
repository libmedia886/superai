/**
 * 结构化动作协议（P0 #21）。
 *
 * agent 在消息里写 fenced 代码块：
 *   ```action
 *   {"action":"task.create","id":"local-1","title":"调研方案A","assignee":"bob","parent":"T-001"}
 *   {"action":"task.update","id":"T-002","status":"进行中","localId":"local-2"}
 *   {"action":"roster.update","duties":"负责代码审查","accepts":["review"]}
 *   ```
 *
 * 四条硬规则：
 *  1. 解析失败不静默 —— 进 errors，调用方必须回注给 agent
 *  2. 执行结果必须回注
 *  3. 权限在协议层强制执行（authorize）
 *  4. 消息带 task_id
 *
 * 三条加固：
 *  A. 只认发言者本人直接输出 —— 引用块 / 嵌套代码块内的一律不执行
 *  B. 幂等 —— 按 (actor, session, turn, action.localId?) 或内容哈希去重
 *  C. 流式期间不执行半截动作 —— 由调用方在轮结束后才调用本模块
 */

import { createHash } from 'node:crypto';

const ACTION_LANGS = new Set(['action', 'actions']);

/**
 * 找出 fenced action 块，且跳过被其它代码块包裹的内容（防止引用/嵌套伪造）。
 * 返回 { body, start, end, nested:boolean }
 */
export function findActionBlocks(text) {
  const src = String(text ?? '');
  const blocks = [];
  const fence = /^[ \t]*(`{3,}|~{3,})[ \t]*([A-Za-z0-9_-]*)[ \t]*$/gm;

  let open = null; // { mark, lang, start, bodyStart }
  let depthGuard = 0;

  for (let m; (m = fence.exec(src)) !== null; depthGuard += 1) {
    if (depthGuard > 500) break;
    const [, mark, langRaw] = m;
    const lang = (langRaw || '').toLowerCase();

    if (!open) {
      open = { mark, lang, start: m.index, bodyStart: fence.lastIndex };
      continue;
    }

    // 在非 action 块内又出现 action 围栏 → 引用/伪造，记录但不执行
    if (!ACTION_LANGS.has(open.lang) && ACTION_LANGS.has(lang) && mark.length < open.mark.length) {
      blocks.push({
        body: '',
        start: m.index,
        end: fence.lastIndex,
        nested: true,
        nestedLang: lang,
      });
      continue;
    }

    // 闭合：marker 类型与长度需一致
    if (mark[0] !== open.mark[0] || mark.length < open.mark.length) continue;

    const body = src.slice(open.bodyStart, m.index);
    if (ACTION_LANGS.has(open.lang)) {
      blocks.push({
        body,
        start: open.start,
        end: fence.lastIndex,
        // 只要块内出现代码围栏标记，视为可疑嵌套
        nested: /`{3,}|~{3,}/.test(body),
      });
    }
    open = null;
  }
  return blocks.sort((a, b) => a.start - b.start);
}

/**
 * 从消息正文里移除 action 块（聊天正文里不显示原始 JSON）。
 * 只移除真正会被执行的顶层块；被引用的嵌套块原样保留，因为它属于引用内容。
 */
export function stripActionBlocks(text) {
  const src = String(text ?? '');
  const blocks = findActionBlocks(src).filter((b) => !b.nested);
  if (blocks.length === 0) return src;
  let out = '';
  let cursor = 0;
  for (const b of blocks) {
    out += src.slice(cursor, b.start);
    cursor = b.end;
  }
  return (out + src.slice(cursor)).replace(/\n{3,}/g, '\n\n').trim();
}

function parseBody(body) {
  const trimmed = body.trim();
  if (!trimmed) return { items: [], errors: [] };
  const items = [];
  const errors = [];

  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return { items: arr, errors };
      errors.push({ raw: trimmed.slice(0, 200), reason: '顶层不是数组' });
      return { items, errors };
    } catch (e) {
      errors.push({ raw: trimmed.slice(0, 200), reason: `JSON 解析失败: ${e.message}` });
      return { items, errors };
    }
  }

  // JSONL：一行一个
  let lineNo = 0;
  for (const line of trimmed.split('\n')) {
    lineNo += 1;
    const l = line.trim();
    if (!l || l.startsWith('//')) continue;
    try {
      items.push(JSON.parse(l));
    } catch (e) {
      errors.push({ raw: l.slice(0, 200), reason: `第 ${lineNo} 行解析失败: ${e.message}` });
    }
  }
  return { items, errors };
}

const TASK_STATUSES = new Set(['待办', '进行中', '待确认', '完成', '阻塞']);

/** 校验单个动作的字段，返回 null 表示合法 */
export function validateAction(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return '动作必须是对象';
  const type = a.action;
  if (typeof type !== 'string') return '缺少 action 字段';

  if (type === 'task.create') {
    if (!a.title || typeof a.title !== 'string') return 'task.create 缺少 title';
    if (a.assignee != null && typeof a.assignee !== 'string') return 'assignee 必须是成员标识';
    if (a.parent != null && typeof a.parent !== 'string') return 'parent 必须是任务 id';
    if (a.repo != null && typeof a.repo !== 'string') return 'repo 必须是仓库路径';
    // base_branch / baseBranch / branch 三种写法都认——模型直觉会写 branch
    for (const key of ['base_branch', 'baseBranch', 'branch']) {
      if (a[key] != null && typeof a[key] !== 'string') return `${key} 必须是分支名`;
    }
    return null;
  }
  if (type === 'task.update') {
    if (!a.id || typeof a.id !== 'string') return 'task.update 缺少任务 id';
    if (a.status != null && !TASK_STATUSES.has(a.status)) {
      return `非法状态「${a.status}」，允许：${[...TASK_STATUSES].join('/')}`;
    }
    if (a.assignee != null && typeof a.assignee !== 'string') return 'assignee 必须是成员标识';
    if (a.status == null && a.assignee == null && a.note == null) return 'task.update 没有任何要改的字段';
    return null;
  }
  if (type === 'roster.update') {
    if (a.duties != null && typeof a.duties !== 'string') return 'duties 必须是字符串';
    if (a.accepts != null && !Array.isArray(a.accepts)) return 'accepts 必须是数组';
    if (a.duties == null && a.accepts == null) return 'roster.update 没有任何要改的字段';
    return null;
  }
  return `未知动作类型「${type}」`;
}

export function contentHash(action) {
  const { localId, ...rest } = action;
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

/**
 * 提取并校验动作。actor 由调用方提供（发言者），绝不从正文推断。
 *
 * @returns {{actions:Array, errors:Array}}
 */
export function extractActions(text, { actor, turn = 0, sessionId = '' } = {}) {
  const actions = [];
  const errors = [];

  for (const block of findActionBlocks(text)) {
    if (block.nested) {
      // 必须回注：否则发言人以为自己派了活
      errors.push({
        raw: block.body.slice(0, 200) || '（嵌套 action 块）',
        reason: '疑似引用/嵌套内容，已忽略（只执行本人直接输出的动作块）',
      });
      continue;
    }
    const { items, errors: parseErrors } = parseBody(block.body);
    errors.push(...parseErrors);
    for (const item of items) {
      const reason = validateAction(item);
      if (reason) {
        errors.push({ raw: JSON.stringify(item).slice(0, 200), reason });
        continue;
      }
      actions.push({
        ...item,
        actor,
        turn,
        sessionId,
        // 幂等键：优先 agent 自报 localId，否则内容哈希
        idemKey: `${actor}|${sessionId}|${turn}|${item.localId ?? contentHash(item)}`,
      });
    }
  }
  return { actions, errors };
}

/** 幂等：过滤掉本次重试里已执行过的动作 */
export function dedupeActions(actions, seenKeys) {
  const fresh = [];
  const skipped = [];
  for (const a of actions) {
    if (seenKeys.has(a.idemKey)) skipped.push(a);
    else fresh.push(a);
  }
  return { fresh, skipped };
}

/**
 * 权限矩阵（需求 §4）。返回 null = 允许，否则返回拒绝原因。
 * 注意：越权是「拒绝 + 回注原因」，不是抛异常。
 */
export function authorize(action, { role, actorId, workerOf, task }) {
  if (role === 'human') return null;

  if (action.action === 'task.create') {
    if (role === 'leader') return null;
    return '成员不能创建任务';
  }

  if (action.action === 'task.update') {
    if (role === 'leader') {
      if (task && task.createdBy != null && task.createdBy !== actorId) {
        return '头头只能修改自己派出的任务';
      }
      return null;
    }
    // member
    if (task && task.assignee === actorId) return null;
    return '成员只能修改派给自己的任务';
  }

  if (action.action === 'roster.update') {
    if (role === 'leader') {
      if (workerOf && workerOf !== actorId) return '头头只能修改下属的职责';
      return null;
    }
    return null; // 成员只能改自己的，由调用方把 target 固定为 actor
  }

  return `无权执行「${action.action}」`;
}
