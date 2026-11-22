/**
 * 统一的后端实时诊断、模型发现与可用性探测模块。
 *
 * 设计目标：
 *  1. 快速体检（inspectBackends）：4 个后端并行检查，30 秒缓存，总耗时严格控制在 4 秒内，
 *     不阻塞页面加载；只读配置与模型列表，绝不向返回值或日志暴露任何 API Key / Token。
 *  2. 诚实诊断（issues + status）：提前暴露会导致运行时 400 / 缺环境变量的真实配置问题
 *     （如 claude settings.json 里 ANTHROPIC_MODEL 不在网关可用列表、codex config.toml
 *     默认 provider 的 env_key 未设置），避免成员发消息才莫名失败。
 *  3. 真实探测（probeBackend / probeAllBackends）：真跑一轮极短对话并缓存结果，
 *     以真实调用为准，不迷信版本号或 login status。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createAdapter } from '../adapters/index.js';
import { EFFORT_HINTS } from './extraargs.js';
import { availableTiers, TIER } from './probe.js';

const execFileAsync = promisify(execFile);

export const ALL_BACKENDS = ['agy', 'claude', 'codex', 'opencode'];

const CACHE_TTL_MS = 30_000;

const BACKEND_META = {
  agy:      { label: 'Antigravity (agy)', bin: 'agy',      supportsStreaming: true },
  claude:   { label: 'Claude Code',       bin: 'claude',   supportsStreaming: true },
  codex:    { label: 'Codex CLI',         bin: 'codex',    supportsStreaming: false },
  opencode: { label: 'OpenCode',          bin: 'opencode', supportsStreaming: false },
};

/** 30 秒体检缓存：{ at: number, list: BackendInfo[] } */
let inspectCache = null;

/** 真实探测结果缓存：Map<backendId, { ok, at, reason, sessionId, model }> */
const probeCache = new Map();

/** 清空内存缓存（供测试与手动强制刷新使用） */
export function clearBackendsCache() {
  inspectCache = null;
  probeCache.clear();
}

function stripAnsi(s) {
  return String(s ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const s = typeof item === 'string' ? item.trim() : '';
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** 先快速查二进制是否在 PATH 中，避免对未安装的 CLI 浪费子进程与超时 */
async function checkBinaryInstalled(bin) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(finder, [bin], {
      timeout: 1500,
      maxBuffer: 64 * 1024,
    });
    const resolved = String(stdout ?? '').trim().split(/\r?\n/)[0]?.trim() || null;
    if (resolved) return { installed: true, resolved };
  } catch (err) {
    // finder 本身不存在（极少数极简容器）时退回直接探测 --version
    if (err?.code !== 'ENOENT') return { installed: false, resolved: null };
  }
  try {
    await execFileAsync(bin, ['--version'], { timeout: 2500, maxBuffer: 64 * 1024 });
    return { installed: true, resolved: bin };
  } catch (err) {
    return { installed: err?.code !== 'ENOENT', resolved: null };
  }
}

async function readVersion(bin) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['--version'], {
      timeout: 2500,
      maxBuffer: 256 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    const raw = stripAnsi(stdout || stderr).trim();
    const first = raw.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/** 解析 `agy models` 的制表符分隔输出（忽略 ANSI 与旋转进度行） */
export function parseAgyModelsOutput(stdout) {
  const cleaned = stripAnsi(stdout);
  const models = [];
  for (const rawLine of cleaned.split(/\r?\n/)) {
    // spinner 可能用 \r 覆盖同一行，只取最后一段
    const segment = rawLine.includes('\r') ? rawLine.slice(rawLine.lastIndexOf('\r') + 1) : rawLine;
    const line = segment.trim();
    if (!line) continue;
    const col0 = (line.includes('\t') ? line.split('\t')[0] : line.split(/\s{2,}/)[0]).trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,100}$/.test(col0)) {
      models.push(col0);
    }
  }
  return uniqueStrings(models);
}

/** 轻量级 TOML 段落解析（仅提取 codex 的默认 provider、model、catalog 与 provider env_key） */
export function parseCodexConfigToml(raw) {
  let section = '';
  let modelProvider = null;
  let model = null;
  let modelCatalogJson = null;
  const providerEnvKeys = new Map();
  const profileModels = [];

  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    // 去掉行尾注释（跳过引号里的 #）
    let line = '';
    let inQuote = null;
    for (let i = 0; i < rawLine.length; i += 1) {
      const ch = rawLine[i];
      if (inQuote) {
        line += ch;
        if (ch === '\\' && i + 1 < rawLine.length) { line += rawLine[i + 1]; i += 1; continue; }
        if (ch === inQuote) inQuote = null;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
        line += ch;
      } else if (ch === '#') {
        break;
      } else {
        line += ch;
      }
    }
    line = line.trim();
    if (!line) continue;

    const secMatch = /^\[([^\]]+)\]$/.exec(line);
    if (secMatch) {
      section = secMatch[1].trim();
      continue;
    }

    const kvMatch = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const valRaw = kvMatch[2].trim();
    const strMatch = /^["'](.*)["']$/.exec(valRaw);
    const val = strMatch ? strMatch[1] : valRaw;

    if (section === '') {
      if (key === 'model_provider') modelProvider = val;
      else if (key === 'model') model = val;
      else if (key === 'model_catalog_json') modelCatalogJson = val;
    } else if (section.startsWith('model_providers.')) {
      const provName = section.slice('model_providers.'.length).replace(/^["']|["']$/g, '');
      if (key === 'env_key' && val) {
        providerEnvKeys.set(provName, val);
      }
    } else if (section.startsWith('profiles.')) {
      if (key === 'model' && val) profileModels.push(val);
    }
  }

  return {
    modelProvider,
    model,
    modelCatalogJson,
    activeEnvKey: modelProvider ? (providerEnvKeys.get(modelProvider) ?? null) : null,
    profileModels: uniqueStrings(profileModels),
  };
}

/** 解析 `opencode debug config` 的 JSON 输出，提取默认模型与 provider.*.models */
export function parseOpencodeConfigJson(raw) {
  const text = String(raw ?? '');
  const idx = text.indexOf('{');
  if (idx < 0) return { configuredModel: null, models: [] };
  const cfg = JSON.parse(text.slice(idx));
  const configuredModel = typeof cfg?.model === 'string' && cfg.model.trim() ? cfg.model.trim() : null;
  const models = [];
  if (configuredModel) models.push(configuredModel);
  if (cfg?.provider && typeof cfg.provider === 'object') {
    for (const [pid, pcfg] of Object.entries(cfg.provider)) {
      if (!pcfg?.models || typeof pcfg.models !== 'object') continue;
      for (const mid of Object.keys(pcfg.models)) {
        models.push(`${pid}/${mid}`);
      }
    }
  }
  return { configuredModel, models: uniqueStrings(models) };
}

async function discoverAgy(bin) {
  const issues = [];
  let models = [];
  let configuredModel = null;
  const displayToId = new Map();

  try {
    const { stdout } = await execFileAsync(bin, ['models'], {
      timeout: 3500,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    models = parseAgyModelsOutput(stdout);
    // 记录展示名 → CLI 模型 ID 映射，便于把 settings.json 里的展示名归一化成可直接传给 --model 的 ID
    for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
      const segment = rawLine.includes('\r') ? rawLine.slice(rawLine.lastIndexOf('\r') + 1) : rawLine;
      const parts = segment.trim().split('\t');
      if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
        displayToId.set(parts[1].trim(), parts[0].trim());
      }
    }
  } catch {
    // 列表拉取超时或网络抖动时不阻断整体体检
  }

  // 尝试读取本机默认模型配置（如有），绝不暴露任何密钥字段
  for (const p of [
    join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
    join(homedir(), '.agy', 'settings.json'),
  ]) {
    try {
      const s = JSON.parse(await readFile(p, 'utf8'));
      if (typeof s?.model === 'string' && s.model.trim()) {
        const raw = s.model.trim();
        configuredModel = displayToId.get(raw) ?? raw;
        break;
      }
    } catch { /* 无配置文件则忽略 */ }
  }

  return { models, configuredModel, issues };
}

async function discoverClaude() {
  const issues = [];
  let settings = null;
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch { /* 无 settings.json */ }

  const envObj = settings?.env && typeof settings.env === 'object' ? settings.env : {};
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || envObj.ANTHROPIC_BASE_URL || '').trim();
  const envModel = (process.env.ANTHROPIC_MODEL || envObj.ANTHROPIC_MODEL || '').trim() || null;
  const settingsModel = typeof settings?.model === 'string' && settings.model.trim()
    ? settings.model.trim()
    : null;
  // Claude CLI 中 ANTHROPIC_MODEL 环境变量优先级高于 settings.model
  const configuredModel = envModel || settingsModel || null;

  const localCandidates = uniqueStrings([
    settingsModel,
    envModel,
    envObj.ANTHROPIC_CUSTOM_MODEL_OPTION,
    ...(Array.isArray(settings?.modelPicker?.options)
      ? settings.modelPicker.options.map((o) => o?.model)
      : []),
  ]);

  let gatewayModels = [];
  if (baseUrl) {
    // 仅用于发往本地配置网关的 Authorization 头，绝不写入日志或返回值
    const token = process.env.ANTHROPIC_AUTH_TOKEN
      || process.env.ANTHROPIC_API_KEY
      || envObj.ANTHROPIC_AUTH_TOKEN
      || envObj.ANTHROPIC_API_KEY
      || '';
    const trimmed = baseUrl.replace(/\/+$/, '');
    const url = trimmed.endsWith('/v1') ? `${trimmed}/models` : `${trimmed}/v1/models`;
    try {
      const headers = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
        headers['x-api-key'] = token;
      }
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const data = await res.json();
        const rawList = Array.isArray(data?.data)
          ? data.data
          : (Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []));
        gatewayModels = uniqueStrings(
          rawList.map((item) => (typeof item === 'string' ? item : (item?.id || item?.name || ''))),
        );
      }
    } catch {
      // 网关超时/不可达时降级使用本地候选列表
    }
  }

  if (gatewayModels.length > 0) {
    if (envModel && !gatewayModels.includes(envModel)) {
      issues.push(
        `settings.json 中 ANTHROPIC_MODEL=${envModel} 不在网关可用列表（${gatewayModels.join(', ')}）内，`
        + `建议在成员设置里明确填写可用模型（如 ${gatewayModels[0]}）`,
      );
    } else if (!envModel && settingsModel && !gatewayModels.includes(settingsModel)) {
      issues.push(
        `settings.json 中默认模型 ${settingsModel} 不在网关可用列表（${gatewayModels.join(', ')}）内，`
        + `建议在成员设置里明确填写可用模型（如 ${gatewayModels[0]}）`,
      );
    }
  }

  const models = gatewayModels.length > 0 ? gatewayModels : localCandidates;
  return { models, configuredModel, issues };
}

async function discoverCodex() {
  const issues = [];
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const configPath = join(codexHome, 'config.toml');
  let parsed = {
    modelProvider: null,
    model: null,
    modelCatalogJson: null,
    activeEnvKey: null,
    profileModels: [],
  };

  try {
    const raw = await readFile(configPath, 'utf8');
    parsed = parseCodexConfigToml(raw);
  } catch { /* 无 config.toml */ }

  if (parsed.activeEnvKey && !process.env[parsed.activeEnvKey]) {
    issues.push(`config.toml 的默认 provider 需要环境变量 ${parsed.activeEnvKey}（当前未设置）`);
  }

  const catalogModels = [];
  if (parsed.modelCatalogJson) {
    try {
      const cat = JSON.parse(await readFile(parsed.modelCatalogJson, 'utf8'));
      const arr = Array.isArray(cat?.models) ? cat.models : (Array.isArray(cat) ? cat : []);
      for (const item of arr) {
        const name = typeof item === 'string' ? item : (item?.slug || item?.id || item?.name || '');
        if (name) catalogModels.push(name);
      }
    } catch { /* catalog 文件不存在或无法解析时忽略 */ }
  }

  const models = uniqueStrings([
    parsed.model,
    ...parsed.profileModels,
    ...catalogModels,
  ]);
  return { models, configuredModel: parsed.model || null, issues };
}

async function discoverOpencode(bin) {
  const issues = [];
  try {
    const { stdout } = await execFileAsync(bin, ['debug', 'config'], {
      timeout: 3500,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    const { configuredModel, models } = parseOpencodeConfigJson(stdout);
    return { models, configuredModel, issues };
  } catch {
    return { models: [], configuredModel: null, issues };
  }
}

function computeStatus({ installed, issues, probe }) {
  if (!installed) return 'missing';
  if (issues.length > 0) return 'warn';
  if (probe && !probe.ok) return 'warn';
  return 'ready';
}

/** 体检单个后端 */
export async function inspectBackend(id) {
  const meta = BACKEND_META[id];
  if (!meta) throw new Error(`未知后端：${id}`);

  const cachedProbe = probeCache.get(id) ?? null;
  const binCheck = await checkBinaryInstalled(meta.bin);

  if (!binCheck.installed) {
    return {
      id,
      label: meta.label,
      installed: false,
      version: null,
      bin: meta.bin,
      tiers: availableTiers(id),
      defaultTier: TIER.FULL,
      effortHints: EFFORT_HINTS[id] ?? [],
      supportsStreaming: meta.supportsStreaming,
      models: [],
      configuredModel: null,
      status: 'missing',
      issues: [`未找到可执行文件「${meta.bin}」`],
      probe: cachedProbe,
    };
  }

  // 版本读取与配置/模型发现并行执行，把单后端最坏耗时压在 3.5 秒内
  const discover = id === 'agy' ? discoverAgy(meta.bin)
    : id === 'claude' ? discoverClaude()
      : id === 'codex' ? discoverCodex()
        : discoverOpencode(meta.bin);

  const [version, info] = await Promise.all([readVersion(meta.bin), discover]);
  const issues = info.issues ?? [];
  const status = computeStatus({ installed: true, issues, probe: cachedProbe });

  return {
    id,
    label: meta.label,
    installed: true,
    version,
    bin: meta.bin,
    tiers: availableTiers(id),
    defaultTier: TIER.FULL,
    effortHints: EFFORT_HINTS[id] ?? [],
    supportsStreaming: meta.supportsStreaming,
    models: info.models ?? [],
    configuredModel: info.configuredModel ?? null,
    status,
    issues,
    probe: cachedProbe,
  };
}

/**
 * 并行体检全部 4 个后端（默认缓存 30 秒，传 force: true 跳过缓存）。
 * 返回与 ALL_BACKENDS 同序的后端诊断信息数组。
 */
export async function inspectBackends({ force = false } = {}) {
  const now = Date.now();
  if (!force && inspectCache && (now - inspectCache.at) < CACHE_TTL_MS) {
    // 合并最新的 probe 缓存状态（即便 inspectCache 命中，也要反映刚跑完的 probe）
    return inspectCache.list.map((item) => {
      const probe = probeCache.get(item.id) ?? null;
      return {
        ...item,
        probe,
        status: computeStatus({ installed: item.installed, issues: item.issues, probe }),
      };
    });
  }

  const list = await Promise.all(ALL_BACKENDS.map((id) => inspectBackend(id)));
  inspectCache = { at: Date.now(), list };
  return list;
}

/**
 * 对指定后端执行一次真实的最小对话探测（创建独立临时工作目录并在结束后清理），
 * 缓存结果并返回更新后的后端诊断对象。
 */
export async function probeBackend(id, { timeoutMs = 45_000, model = null } = {}) {
  if (!BACKEND_META[id]) throw new Error(`未知后端：${id}`);

  const tmpDir = await mkdtemp(join(tmpdir(), `probe-${id}-`));
  let probeResult;
  try {
    const adapter = createAdapter({
      id: `probe-${id}`,
      backend: id,
      tier: TIER.FULL,
      model: model || null,
    });
    const res = await adapter.probe(tmpDir, timeoutMs);
    probeResult = {
      ok: Boolean(res?.ok),
      at: new Date().toISOString(),
      reason: res?.ok ? null : (res?.reason || '探测失败'),
      sessionId: res?.sessionId ?? null,
      model: model || null,
    };
  } catch (err) {
    probeResult = {
      ok: false,
      at: new Date().toISOString(),
      reason: String(err?.message ?? err).slice(0, 500),
      sessionId: null,
      model: model || null,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  probeCache.set(id, probeResult);

  const updated = await inspectBackend(id);
  if (inspectCache) {
    inspectCache = {
      at: inspectCache.at,
      list: inspectCache.list.map((item) => (item.id === id ? updated : item)),
    };
  }
  return updated;
}

/** 并行探测全部已安装后端，返回完整 4 后端最新状态数组 */
export async function probeAllBackends({ timeoutMs = 45_000 } = {}) {
  const list = await inspectBackends({ force: true });
  const updated = await Promise.all(
    list.map((item) => (item.installed ? probeBackend(item.id, { timeoutMs }) : Promise.resolve(item))),
  );
  inspectCache = { at: Date.now(), list: updated };
  return updated;
}
