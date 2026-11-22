/**
 * 成员创建（agent 造人）。
 *
 * ★ 安全核心：**房间级权限天花板 `aiCabTier`**。
 *
 * 人建房时设定"AI 能创建的成员最高是什么档位"，默认 `readonly`。
 * agent 请求的档位**不能超过天花板**：
 *  - 没写 tier        → 用它请求的天花板档位（默认只读）
 *  - 写了 ≤ 天花板    → 允许
 *  - 写了 > 天花板    → **拒绝**，并说清天花板是多少
 *
 * 为什么是"拒绝"而不是"静默降级"：静默降级会让 agent 以为造出了一个可写成员，
 * 然后给它派活、等结果、什么也没发生。明确拒绝它才知道要来找人。
 *
 * 其他的限制：
 *  - 只有头头能造人（在 authorize 里强制）
 *  - 必须说明理由（在 validateAction 里强制）
 *  - 人数上限，且名字不能重复
 *  - backend 必须是真正可用的
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { availableTiers, normalizeTier, TIER, TIER_RANK } from './probe.js';

export const MAX_MEMBERS = 8;

/** 天花板的默认值。最安全的那一档。 */
export const DEFAULT_AI_CAB_TIER = TIER.READONLY;

/**
 * 档位强弱顺序见 probe.js 的 TIER_RANK —— **只此一份**。
 * 曾经这里复制过一份，加 read 档时就漏了，天花板判定会把 read 当成"未知档位"。
 */

/**
 * 把请求的档位收敛到天花板以内。
 * @returns {{tier:string, capped:boolean, reason?:string}}
 */
export function capTier(requested, ceiling) {
  const cap = ceiling ?? DEFAULT_AI_CAB_TIER;
  if (requested == null) return { tier: cap, capped: false };

  const want = TIER_RANK[requested];
  const max = TIER_RANK[cap];
  if (want == null) return { tier: cap, capped: true, reason: `未知档位「${requested}」` };

  if (want > max) {
    return {
      tier: cap,
      capped: true,
      reason: `这个房间允许 AI 创建的成员最高只能到「${cap}」，不能是「${requested}」。`
        + '需要更高权限请让老板手动调整。',
    };
  }
  return { tier: requested, capped: false };
}

/**
 * 校验能否造这个人（不含权限检查，那个在 authorize 里）。
 *
 * @param {object} o
 * @param {{name:string, backend?:string, reason:string}} o.action
 * @param {Array<{name:string, backend:string}>} o.members 现有成员
 * @returns {{ok:true, member:object} | {ok:false, reason:string}}
 */
export function planMemberCreation({ action, members, id, ceiling }) {
  const name = String(action.name ?? '').trim();
  if (!name) return { ok: false, reason: '缺少成员名字' };

  // 名字冲突：不覆盖已有成员（覆盖会让历史记录里同一个名字指两个人）
  const lower = name.toLowerCase();
  if (members.some((m) => m.name.toLowerCase() === lower)) {
    return { ok: false, reason: `名字「${name}」已存在，换一个` };
  }

  const backend = String(action.backend ?? 'claude').trim();
  const tiers = availableTiers(backend);
  if (!tiers.length) {
    return {
      ok: false,
      reason: `不支持的后端「${backend}」，可用：${['agy', 'claude', 'codex', 'opencode']
        .filter((b) => availableTiers(b).length).join(' / ')}`,
    };
  }

  if (members.length >= MAX_MEMBERS) {
    return { ok: false, reason: `成员已达上限 ${MAX_MEMBERS} 人，不能再加` };
  }

  // ★ 天花板检查：请求的档位超过房间允许的上限 → **拒绝**（不静默降级）
  const capped = capTier(action.tier, ceiling);
  if (capped.capped) {
    return { ok: false, reason: capped.reason, ceiling: ceiling ?? DEFAULT_AI_CAB_TIER };
  }

  // ★ 后端档位合法性校验：避免造出无效的 backend+tier 组合
  //   - 调用方未写 tier 且房间天花板不被该后端支持（如 codex/agy 遇到 readonly 天花板）→ 经 normalizeTier 收敛
  //   - 调用方显式指定了该后端不支持的 tier → 明确拒绝
  let finalTier = capped.tier;
  if (!tiers.includes(finalTier)) {
    if (action.tier == null) {
      const normalized = normalizeTier(backend, finalTier);
      if (tiers.includes(normalized)) {
        finalTier = normalized;
      } else {
        const capRank = TIER_RANK[finalTier] ?? 0;
        const underCap = tiers
          .filter((t) => (TIER_RANK[t] ?? 0) <= capRank)
          .sort((a, b) => (TIER_RANK[b] ?? 0) - (TIER_RANK[a] ?? 0));
        finalTier = underCap[0] ?? tiers[0];
      }
    } else {
      return {
        ok: false,
        reason: `${backend} 不支持档位「${finalTier}」，可选：${tiers.join(' / ')}`,
        availableTiers: tiers,
      };
    }
  }

  return {
    ok: true,
    member: {
      id: id ?? `m${Date.now().toString(36)}`,
      name,
      backend,
      tier: finalTier,
      role: 'member',
      persona: typeof action.persona === 'string' ? action.persona.slice(0, 500) : '',
      createdByAgent: true,
    },
    ceiling: ceiling ?? DEFAULT_AI_CAB_TIER,
  };
}

/**
 * 真正落地：建工作目录 + 写进配置。
 *
 * @param {object} o
 * @param {object} o.member
 * @param {string} o.dataDir
 * @param {object} o.cfg       房间配置（会被改）
 * @param {(cfg:object)=>Promise<void>} o.saveConfig
 */
export async function commitMember({ member, dataDir, cfg, saveConfig }) {
  const cwd = join(dataDir, 'agents', member.id);
  await mkdir(cwd, { recursive: true });

  cfg.members = cfg.members ?? [];
  cfg.members.push({
    id: member.id,
    name: member.name,
    backend: member.backend,
    tier: member.tier,
    role: member.role,
    persona: member.persona,
  });
  await saveConfig(cfg);

  return { ...member, cwd, aliases: [member.name.toLowerCase()] };
}
