/**
 * 房间配置与装配（bin 与 server 共用）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Store } from './store.js';
import { Room } from './room.js';
import { createAdapter } from '../adapters/index.js';
import { availableTiers, TIER } from './probe.js';

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
export async function buildRoom({ cfg, dataDir = DEFAULT_DATA_DIR, onEvent }) {
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

    members.push({ ...m, tier, cwd, aliases: [m.name.toLowerCase()] });
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
    resolveAdapter: (agent) => {
      if (!adapters.has(agent.id)) {
        adapters.set(agent.id, createAdapter({
          id: agent.id,
          backend: agent.backend,
          model: agent.model,
          persona: agent.persona,
          tier: agent.tier,
          bin: agent.bin,
        }));
      }
      return adapters.get(agent.id);
    },
    onEvent,
  });

  return { room, store, members, warnings };
}
