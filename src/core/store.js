/**
 * 追加式 JSONL 存储（需求 §6.5）。
 *
 * 事件种类：message / task / roster / session / room
 *  - 原子写：整行一次写入 + fsync 可选
 *  - 带 schema 版本，可重放重建内存状态
 *  - 单实例锁由 Electron 层负责（requestSingleInstanceLock）
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    this.messages = [];
    this.tasks = new Map();     // id -> task
    this.roster = new Map();    // agentId -> {duties, accepts, editedByHuman}
    this.sessions = new Map();  // agentId -> {sessionId, cwd, backend}
    this.summaries = new Map(); // agentId -> 最新摘要（轮换后仍可读）
    this.toolLog = [];          // 写操作日志（只追加）
    this._seq = 0;
    this._writeChain = Promise.resolve();
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      for (const line of raw.split('\n')) {
        const l = line.trim();
        if (!l) continue;
        try { this.apply(JSON.parse(l)); } catch { /* 跳过损坏行，不阻塞启动 */ }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await mkdir(dirname(this.filePath), { recursive: true });
    }
    return this;
  }

  /** 纯函数式应用一个事件到内存状态（重放也走这里） */
  apply(ev) {
    this.events.push(ev);
    switch (ev.kind) {
      case 'message':
        this.messages.push(ev.message);
        break;
      case 'task.create':
        this.tasks.set(ev.task.id, { ...ev.task });
        break;
      case 'task.update': {
        const t = this.tasks.get(ev.id);
        if (t) Object.assign(t, ev.patch, { updatedAt: ev.at });
        break;
      }
      case 'roster.update': {
        const cur = this.roster.get(ev.agentId) ?? { accepted: {} };
        this.roster.set(ev.agentId, {
          ...cur,
          ...(ev.patch.selfDuties != null ? { selfDuties: ev.patch.selfDuties } : {}),
          ...(ev.patch.humanDuties != null ? { humanDuties: ev.patch.humanDuties } : {}),
          ...(ev.patch.accepts != null ? { accepts: ev.patch.accepts } : {}),
          updatedAt: ev.at,
        });
        break;
      }
      case 'session':
        this.sessions.set(ev.agentId, { sessionId: ev.sessionId, cwd: ev.cwd, backend: ev.backend });
        break;
      case 'tool':
        // 写操作日志：只追加，不改写（和其他事件一致）
        this.toolLog.push({
          agentId: ev.agentId, taskId: ev.taskId, tool: ev.tool, action: ev.action,
          path: ev.path, command: ev.command, detail: ev.detail, at: ev.at,
        });
        break;
      case 'compact':
        this.summaries.set(ev.agentId, ev.summary);
        // 轮换后旧会话不再使用；新会话 id 在下一轮 init 时写入
        this.sessions.set(ev.agentId, {
          sessionId: null,
          cwd: this.sessions.get(ev.agentId)?.cwd ?? null,
          backend: this.sessions.get(ev.agentId)?.backend ?? null,
          rotatedFrom: ev.oldSessionId,
        });
        break;
      default:
        break;
    }
  }

  async append(ev) {
    const record = { v: SCHEMA_VERSION, seq: ++this._seq, at: new Date().toISOString(), ...ev };
    this.apply(record);
    // 串行化写入，避免并发写坏行
    this._writeChain = this._writeChain.then(() =>
      appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf8'),
    );
    await this._writeChain;
    return record;
  }

  addMessage(msg) {
    const id = msg.id ?? `M-${String(this.messages.length + 1).padStart(4, '0')}`;
    return this.append({ kind: 'message', message: { at: new Date().toISOString(), ...msg, id } });
  }

  createTask(task) {
    return this.append({ kind: 'task.create', task });
  }

  updateTask(id, patch) {
    return this.append({ kind: 'task.update', id, patch });
  }

  updateRoster(agentId, patch) {
    return this.append({ kind: 'roster.update', agentId, patch });
  }

  saveSession(agentId, { sessionId, cwd, backend }) {
    return this.append({ kind: 'session', agentId, sessionId, cwd, backend });
  }

  /** 生成短 id：T-001 / A-3（agent 要在动作块里引用，UUID 太长模型会写错） */
  nextId(prefix) {
    const n = [...this.tasks.keys()].filter((k) => k.startsWith(`${prefix}-`)).length + 1;
    return `${prefix}-${String(n).padStart(3, '0')}`;
  }

  /** 给模型看的上下文：某 agent 上次发言之后的新消息（不含它自己说的） */
  messagesSince(agentId, { limit = 40 } = {}) {
    let lastIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i].senderId === agentId) { lastIdx = i; break; }
    }
    const slice = this.messages.slice(lastIdx + 1);
    const filtered = slice.filter((m) => m.senderId !== agentId);
    return filtered.slice(-limit);
  }
}
