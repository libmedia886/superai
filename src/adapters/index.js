import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { OpencodeAdapter } from './opencode.js';

export const ADAPTERS = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  opencode: OpencodeAdapter,
};

export function createAdapter(config) {
  const Ctor = ADAPTERS[config.backend];
  if (!Ctor) throw new Error(`未知后端：${config.backend}`);
  return new Ctor(config);
}

/**
 * 适配器缓存键。
 *
 * ★ 一条容易漏掉的规则：只改 `room.members` 里的档位而不重建适配器，
 * 下一轮仍然用旧参数——界面显示可写、实际写不了。这正是本项目一路在抓的
 * 「界面撒谎」类缺陷。所以缓存按**配置签名**判定，不要靠调用方记得清缓存。
 *
 * 参与签名的：后端、档位、模型、思考等级、启动参数、可执行文件。
 */
export function adapterSignature(config = {}) {
  return JSON.stringify([
    config.backend ?? null,
    config.tier ?? null,
    config.model ?? null,
    config.effort ?? null,
    config.extraArgs ?? [],
    config.bin ?? null,
  ]);
}

/**
 * 按签名缓存的适配器工厂。签名变了就重建。
 *
 * @param {Map<string, {sig:string, adapter:object}>} cache
 */
export function getCachedAdapter(cache, agent) {
  const sig = adapterSignature(agent);
  const hit = cache.get(agent.id);
  if (hit && hit.sig === sig) return hit.adapter;
  const adapter = createAdapter({
    id: agent.id,
    backend: agent.backend,
    model: agent.model,
    effort: agent.effort,
    persona: agent.persona,
    tier: agent.tier,
    bin: agent.bin,
    extraArgs: agent.extraArgs ?? [],
  });
  cache.set(agent.id, { sig, adapter });
  return adapter;
}

export { ClaudeAdapter, CodexAdapter, OpencodeAdapter };
