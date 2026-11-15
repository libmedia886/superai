/**
 * @ 提及解析。
 *
 * 规则（对应需求 P0 #3 / #4）：
 *  - 全角 ＠ 与半角 @ 等价
 *  - 按成员名或别名匹配，长的优先（避免 "bob" 抢先匹配 "bob2"）
 *  - 去重，保留出现顺序
 *  - 忽略对自己的 @
 *  - 未匹配到的 @xxx 记为 unknown，不触发发言
 */

const LATIN_WORD = /[A-Za-z0-9_]/;
const UNKNOWN_TOKEN = /^[A-Za-z0-9_\-一-鿿]{1,32}/;

function normalize(text) {
  return String(text ?? '').replace(/＠/g, '@');
}

/** 人类在群里的称呼。agent 想叫人时不会写 @human，会写 @老板 或 @用户 */
export const HUMAN_ALIASES = ['老板', '用户', '人类', 'human', 'user', 'boss'];

/**
 * @param {string} [humanId] 传入则把人类也算作可 @ 对象；传 null 时不匹配人类
 */
function buildCandidates(members, humanId = 'human') {
  const list = [];
  for (const m of members) {
    const names = [m.name, ...(m.aliases ?? [])].filter(Boolean);
    for (const n of names) list.push({ token: n.toLowerCase(), agentId: m.id });
  }
  if (humanId) {
    for (const n of HUMAN_ALIASES) list.push({ token: n.toLowerCase(), agentId: humanId });
  }
  // 长的在前，保证最长匹配
  return list.sort((a, b) => b.token.length - a.token.length);
}

/**
 * @param {string} text
 * @param {{members: Array<{id:string,name:string,aliases?:string[]}>, humanId?:string|null}} opts
 * @param {string|null} selfId
 */
export function parseMentions(text, { members, humanId = 'human' }, selfId = null) {
  const src = normalize(text);
  const candidates = buildCandidates(members, humanId);
  const targets = [];
  const unknown = [];
  const selfTargets = [];   // @ 到了自己，不算目标，但要记下"确实写了 @"
  const seen = new Set();

  let i = 0;
  while (i < src.length) {
    if (src[i] !== '@') {
      i += 1;
      continue;
    }
    const rest = src.slice(i + 1).toLowerCase();
    const hit = candidates.find((c) => {
      if (!rest.startsWith(c.token)) return false;
      // 边界：名字后面紧跟拉丁字母/数字时不算命中（@bob 不应匹配 @bobby）
      const next = rest[c.token.length];
      const last = c.token[c.token.length - 1];
      if (next && LATIN_WORD.test(last) && LATIN_WORD.test(next)) return false;
      return true;
    });

    if (hit) {
      if (!seen.has(hit.agentId)) {
        seen.add(hit.agentId);
        if (hit.agentId !== selfId) targets.push(hit.agentId);
        else selfTargets.push(hit.agentId);
      }
      i += 1 + hit.token.length;
      continue;
    }

    const m = UNKNOWN_TOKEN.exec(rest);
    if (m) {
      const word = m[0];
      if (!unknown.includes(word)) unknown.push(word);
      i += 1 + word.length;
    } else {
      i += 1;
    }
  }

  return { targets, unknown, selfTargets };
}

/**
 * 权限过滤：成员只能 @ 自己的头头（或任一头头，当 reportsTo 未指定时）与人类。
 * 越权 @ 不触发发言，但要回报（不能静默吞掉）。
 *
 * @param {object} o
 * @param {string[]} o.targets         解析出的 @ 目标
 * @param {'leader'|'member'|'human'} o.actorRole
 * @param {string[]} [o.leaderIds]     全部头头（支持多头部组织，§4.1）
 * @param {string[]} [o.reportsTo]     该成员归属的头头；为空表示不限（兼容旧配置）
 * @param {string} [o.humanId]
 */
export function applyMentionPolicy({
  targets, actorRole, leaderIds = [], leaderId = null, reportsTo = null, humanId = 'human',
}) {
  if (actorRole !== 'member') return { allowed: targets, overreach: [] };

  // 兼容单头头调用：leaderId 会被合并进 leaderIds
  const allLeaders = new Set([...(leaderIds ?? []), ...(leaderId ? [leaderId] : [])]);
  const ownLeaders = reportsTo?.length ? new Set(reportsTo) : allLeaders;

  const allowed = [];
  const overreach = [];
  for (const t of targets) {
    if (t === humanId) allowed.push(t);
    else if (ownLeaders.has(t)) allowed.push(t);
    else overreach.push(t);
  }
  return { allowed, overreach };
}

export function formatMention(member) {
  return `@${member.name}`;
}
