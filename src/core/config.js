/**
 * 房间配置与装配（bin 与 server 共用）。
 */

import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Store } from './store.js';
import { Room } from './room.js';
import { getCachedAdapter } from '../adapters/index.js';
import { availableTiers, TIER, normalizeTier } from './probe.js';
import { classifyExtraArgs } from './extraargs.js';

export const DEFAULT_DATA_DIR = process.env.MAROOM_DATA || join(homedir(), '.multiagent-chat');

export const PRESETS = {
  lead: {
    role: 'leader', backend: 'claude',
    persona: '你是任务拆解者。话少、直接，负责把任务拆成子任务并分派人。派活时用 @名字。',
  },
  bob: {
    role: 'member', backend: 'codex',
    persona: '你是执行者。按分配做事，回答简短、不客套。',
  },
};

const DEFAULT_CONFIG = {
  name: '默认房间',
  /**
   * 房间目标。**没有它，agent 会互相推诿"你先定目标"** —— 实测两个 agent
   * 能就"等老板定目标"来回问三轮。填了目标，它们才知道该往哪儿使劲。
   */
  goal: '',
  registry: [],
  members: [
    { id: 'lead', name: 'lead', backend: 'claude', tier: TIER.READONLY, ...PRESETS.lead },
    { id: 'bob', name: 'bob', backend: 'codex', tier: TIER.READONLY, ...PRESETS.bob },
  ],
};

export async function loadConfig(dataDir = DEFAULT_DATA_DIR) {
  const path = join(dataDir, 'room.json');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return structuredClone(DEFAULT_CONFIG);
  }
}

export async function saveConfig(cfg, dataDir = DEFAULT_DATA_DIR) {
  await writeFile(join(dataDir, 'room.json'), JSON.stringify(cfg, null, 2));
}

/**
 * 装配房间。返回 room / store / members / warnings。
 * warnings 要在界面上显示——档位不被支持这种事不能静默。
 */
/**
 * 两个路径是否指向同一个真实目录。
 * 任何一边不存在/解析失败都返回 false——宁可不接，也不要拿错 cwd 去 resume。
 */
async function sameRealPath(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

export async function buildRoom({ cfg, dataDir = DEFAULT_DATA_DIR, onEvent, sharedDir = null }) {
  const store = new Store(join(dataDir, 'room.jsonl'));
  await store.load();

  const warnings = [];
  const members = [];

  for (const m of cfg.members) {
    const cwd = join(dataDir, 'agents', m.id);
    await mkdir(cwd, { recursive: true });

    const tiers = availableTiers(m.backend);
    let tier = m.tier ?? TIER.READONLY;
    if (!tiers.length) {
      warnings.push(`不支持的后端：${m.backend}（成员 ${m.name} 不可用）`);
      continue;
    }
    if (!tiers.includes(tier)) {
      warnings.push(`${m.backend} 不支持档位 ${tier}，成员 ${m.name} 已回退到只读`);
      tier = TIER.READONLY;
    }

    /**
     * ★ 恢复上次的会话 id。
     *
     * `store.saveSession()` 一直在往 room.jsonl 写 `session` 事件，但以前从来没人读回来：
     * 重启或切换房间后每个 agent 都拿不到 sessionId，于是**从头开始**——
     * 界面上看不出任何异常，只是它忘了之前所有事。切房间会新建 Room，同样中招。
     *
     * cwd 必须一致。claude/codex 用错误的 cwd resume 会**挂住不报错**
     * （实测 60 秒超时才被杀），所以宁可开新会话也不要冒险接。
     */
    const savedSession = store.sessions.get(m.id);
    let sessionId = null;
    let sessionResetReason = null;

    if (savedSession?.sessionId) {
      /**
       * 路径比较用 **realpath**，不是字符串相等。
       *
       * 字符串相等会把"同一个目录的两个名字"判成不同：`<data>/agents/<id>`
       * vs `<data>/rooms/r-legacy/agents/<id>`——多房间迁移之后正是这种情况。
       * 结果是所有成员的会话都被判"接不上"，上下文归零，而界面毫无提示。
       *
       * 也不能改成"放宽校验直接接"：claude/codex 用错 cwd resume 会挂住不报错。
       * 所以判据是"**真实路径**是否相同"。
       */
      const same = await sameRealPath(savedSession.cwd, cwd);
      if (same) {
        sessionId = savedSession.sessionId;
      } else if (savedSession.cwd) {
        sessionResetReason = `工作目录已变（${savedSession.cwd} → ${cwd}）`;
      }
    }

    /**
     * 手写的 `timeoutMs` 不是界面写的。它优先于房间设置生效，
     * 所以必须显式标出来——否则界面显示 20 分钟、实际 30 分钟，
     * 这正是老板这次踩的那类"界面撒谎"。
     */
    if (m.timeoutMs && !m.timeoutMinutes) {
      warnings.push(
        `${m.name} 的单轮上限来自 room.json 里手写的 timeoutMs（${Math.round(m.timeoutMs / 60_000)} 分钟），`
        + '界面上的设置对它不生效。建议在成员设置里改用「单轮上限」重新填一次。',
      );
    }

    members.push({
      ...m, tier, cwd, sessionId, sessionResetReason, aliases: [m.name.toLowerCase()],
    });
  }

  const adapters = new Map();
  const room = new Room({
    id: 'r1',
    name: cfg.name,
    goal: cfg.goal ?? '',
    members,
    store,
    registry: cfg.registry ?? [],
    worktreesRoot: join(dataDir, 'worktrees'),
    /** 房间级权限天花板：AI 能创建的成员最高档位（人设定，默认只读） */
    aiCabTier: cfg.aiCabTier ?? TIER.READONLY,
    /** 房间共享目录：成员能读，头头能写。协作不用再把整张表贴进群 */
    sharedDir,
    /** 成员不 @ 发言时是否叫醒头头（房间级开关，默认开） */
    headPassiveWake: cfg.headPassiveWake !== false,
    /**
     * 房间级单轮上限（分钟）。改完经 /api/room-settings 直接改 Room 实例，
     * 下一轮就生效——不能在磁盘上改了却要重启（CR-027 同一条教训）。
     */
    turnTimeoutMs: cfg.turnTimeoutMinutes ? cfg.turnTimeoutMinutes * 60_000 : undefined,
    // agent 造人时的落地钩子：建目录 + 写配置，返回带 cwd 的成员
    onMemberCreate: async (member, { createdBy = null, reason = '' } = {}) => {
      const cwd = join(dataDir, 'agents', member.id);
      await mkdir(cwd, { recursive: true });
      cfg.members = cfg.members ?? [];
      cfg.members.push({
        id: member.id, name: member.name, backend: member.backend,
        tier: member.tier, role: member.role, persona: member.persona,
        // ★ 审计：谁加的、为什么加。不记的话老板回头看名册里莫名多了个人，
        // 只能查到"lead 加的"，查不到它当时说的理由——那 reason 强制填写就白填了。
        createdBy,
        createdReason: reason || null,
        createdAt: new Date().toISOString(),
      });
      await saveConfig(cfg, dataDir);
      return { ...member, cwd, aliases: [member.name.toLowerCase()] };
    },
    /**
     * 按**配置签名**缓存：改了档位/模型/参数立刻生效，不需要重启。
     * 只按 agent.id 缓存会让"界面显示可写、实际写不了"——见 adapters/index.js。
     */
    resolveAdapter: (agent) => getCachedAdapter(adapters, agent),
    onEvent,
  });

  return { room, store, members, warnings };
}
