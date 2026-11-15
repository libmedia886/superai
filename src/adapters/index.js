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

export { ClaudeAdapter, CodexAdapter, OpencodeAdapter };
