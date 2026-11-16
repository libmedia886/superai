/**
 * 成员设置：改名 / 换后端 / 档位 / 模型 / 思考等级 / 启动参数 / 删除。
 *
 * 三条容易做错的地方，全在这个文件里处理：
 *
 *  1. **换后端必须重置会话 id。** 会话 id 是每个 CLI 自己的东西，
 *     把 claude 的 session 交给 codex 会得到一个空轮或者挂住。改名/改档位不重置。
 *  2. **档位覆盖标记每次从参数重新判定**，不存布尔值——参数删掉后标记要自己消失。
 *  3. **协议参数直接拒绝、档位参数要 confirmOverride**。理由见 extraargs.js。
 *
 * 这里只做"算出新成员配置"，不碰磁盘；落盘与热更新由调用方负责，
 * 这样单测可以直接跑，不需要准备 Http 服务。
 */

import { availableTiers, TIER, TIER_RANK, normalizeTier } from './probe.js';
import { classifyExtraArgs, detectTierOverride, tokenizeArgs } from './extraargs.js';

const MAX_NAME = 32;
const MAX_PERSONA = 2000;

/** 字段级校验 + 归一化。返回新成员对象（不改入参）。 */
export function planMemberUpdate({ member, patch = {}, members = [], confirmOverride = false }) {
  const next = { ...member };
  const changed = [];

  // ---- 名字 ----
  if (patch.name !== undefined) {
    const name = String(patch.name ?? '').trim().slice(0, MAX_NAME);
    if (!name) return { ok: false, reason: '名字不能为空' };
    const lower = name.toLowerCase();
    if (members.some((m) => m.id !== member.id && m.name.toLowerCase() === lower)) {
      return { ok: false, reason: `名字「${name}」已被其他成员使用` };
    }
    if (name !== member.name) {
      next.name = name;
      // 名字参与 @ 解析，别名必须跟着换，否则旧名字还能叫到它、新名字叫不到
      next.aliases = [lower];
      changed.push('name');
    }
  }

  // ---- 后端 ----
  if (patch.backend !== undefined && patch.backend !== member.backend) {
    const backend = String(patch.backend ?? '').trim();
    const tiers = availableTiers(backend);
    if (!tiers.length) return { ok: false, reason: `不支持的后端：${backend}` };

    next.backend = backend;
    changed.push('backend');

    /**
     * 换后端必须重置会话：旧 session 属于旧 CLI，交错了就是空轮或挂死。
     * 同时在返回里带上重置标记，界面要在确认框里写明"上下文会重置"。
     */
    next.sessionId = null;
    next.sessionReset = true;

    // 档位要重新校验：codex 没有 write-ask，claude 没有"无工具"以外的差别
    const wanted = normalizeTier(backend, next.tier ?? TIER.READONLY);
    if (!tiers.includes(wanted)) {
      next.tier = backend === 'codex' ? TIER.READ : TIER.READONLY;
      changed.push('tier');
    } else {
      next.tier = wanted;
    }

    // 启动参数也是按后端分类的：换后端后旧参数可能变成协议参数
    if (next.extraArgs?.length) {
      const c = classifyExtraArgs(backend, next.extraArgs);
      if (!c.ok || c.rejected.length) {
        return {
          ok: false,
          reason: `换到 ${backend} 后，原有启动参数里有不被允许的项：`
            + `${(c.rejected ?? []).map((r) => r.arg).join('、') || c.reason}。请先清空它们。`,
        };
      }
    }
  }

  // ---- 档位 ----
  if (patch.tier !== undefined) {
    const tiers = availableTiers(next.backend);
    const tier = String(patch.tier ?? '');
    if (!tiers.includes(tier)) {
      return {
        ok: false,
        reason: `${next.backend} 不支持档位「${tier}」，可选：${tiers.join(' / ')}`,
        availableTiers: tiers,
      };
    }
    if (tier !== next.tier) {
      next.tier = tier;
      changed.push('tier');
    }
  }

  // ---- 模型 / 思考等级：留空 = 一个参数都不传 ----
  if (patch.model !== undefined) {
    const model = String(patch.model ?? '').trim();
    if (model !== (member.model ?? '')) {
      next.model = model || null;
      changed.push('model');
    }
  }
  if (patch.effort !== undefined) {
    const effort = String(patch.effort ?? '').trim();
    if (effort !== (member.effort ?? '')) {
      next.effort = effort || null;
      changed.push('effort');
    }
  }

  // ---- 启动参数：三类判定 ----
  if (patch.extraArgs !== undefined) {
    const raw = Array.isArray(patch.extraArgs)
      ? patch.extraArgs
      : tokenizeArgs(patch.extraArgs);
    if (!raw.ok) return { ok: false, reason: raw.reason };
    const tokens = Array.isArray(patch.extraArgs) ? patch.extraArgs : raw.tokens;

    const c = classifyExtraArgs(next.backend, tokens);
    if (!c.ok) return { ok: false, reason: c.reason };

    if (c.rejected.length) {
      return {
        ok: false,
        code: 'PROTOCOL_ARG',
        reason: `这些参数会让应用读不懂 CLI 的输出，已拒绝：`
          + c.rejected.map((r) => `${r.arg}（${r.reason}）`).join('；'),
        rejected: c.rejected,
      };
    }
    if (c.overridesTier && !confirmOverride) {
      return {
        ok: false,
        code: 'NEEDS_CONFIRM',
        reason: `这些参数会覆盖权限档位：${c.needingConfirm.map((x) => x.arg).join('、')}。`
          + '确认要绕过档位设置请带上 confirmOverride。',
        needingConfirm: c.needingConfirm,
      };
    }

    const asText = tokens.join(' ');
    if (asText !== (member.extraArgsText ?? '')) {
      next.extraArgs = c.accepted;
      next.extraArgsText = asText;
      changed.push('extraArgs');
    }
  }

  // ---- 角色 / persona ----
  if (patch.role !== undefined) {
    const role = patch.role === 'leader' ? 'leader' : 'member';
    if (role !== next.role) { next.role = role; changed.push('role'); }
  }
  if (patch.persona !== undefined) {
    const persona = String(patch.persona ?? '').slice(0, MAX_PERSONA);
    if (persona !== (next.persona ?? '')) { next.persona = persona; changed.push('persona'); }
  }

  /**
   * 档位覆盖标记：**每次重新算**，不继承旧值。
   * 参数删掉之后这里自然变成 false，界面上的常驻标注就会消失。
   */
  next.overridesTier = detectTierOverride(next.backend, next.extraArgs ?? []);

  return { ok: true, member: next, changed };
}

/** 新成员的档位提示：界面上每档配一句话，不要只给档位名 */
export function tierChoices(backend) {
  return availableTiers(backend).map((tier) => ({
    value: tier,
    rank: TIER_RANK[tier] ?? 0,
  }));
}

/** 比较两个档位谁更强（删除头头前提示"需另设头头"之类的判断会用到） */
export function tierAtLeast(tier, other) {
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[other] ?? 0);
}
