# SuperAI（multiagent-chat · 多 AI 协作工作台）

让多个 **`agy` (Antigravity)** / **`claude`** / **`codex`** / **`opencode`** 实例在同一个协作房间里，通过 **@ 点名 + 结构化动作协议 + 共享目录 + 任务看板 + Git Worktree** 协同完成真实工程任务。

**零外部 npm 依赖，开箱即用。** 直接驱动本机已安装的 CLI：

```bash
node bin/doctor.mjs         # 四后端环境检查与沙箱自检
node bin/serve.mjs          # 启动多房间 Web 工作台（默认 http://127.0.0.1:4321）
node bin/room.mjs --demo    # 终端一键演示：头头拆任务 → 派给成员 → 成员产出 → 看板更新
node bin/room.mjs           # 终端交互模式
```

详细操作说明见 [使用说明.md](./使用说明.md)，部署与基线核对见 [docs/DEPLOY.md](./docs/DEPLOY.md)。

## 核心特性（v2）

- **四后端一等支持**：原生适配 **`agy`**（Antigravity CLI，逐字流式）、**`claude`**（Claude Code，逐字流式）、**`codex`**（Codex CLI）、**`opencode`**（OpenCode）。
- **完全开放权限模式（`full`）**：全部 4 家后端均支持 `full` 档（无目录限制、全工具/命令/联网免审批），新建房间默认开放 `aiCabTier: 'full'` 与新建成员默认 `full` 档，同时完整保留 `readonly` / `read` / `write-ask` / `write` / `write-exec` 受控档位按需切换。
- **开放自由协作（`allowPeerMentions`）**：新房间默认允许普通成员之间直接互 `@` 接力推进，也可在左侧「房间设置」一键切回仅头头调度模式。
- **后端实时诊断与模型自动发现**：顶部健康胶囊实时展示 4 后端状态，点击打开诊断面板可自动列出本机/网关可用模型、提前预警配置冲突（如模型不在网关列表、缺少 `env_key`）并支持一键实测连通性。
- **现代化协作工作台 UI**：
  - 暗色开发者工作台，房间目标行内编辑（即时写入 prompt）；
  - 右栏三标签页：**看板**（任务卡与 Git Worktree Diff 验收合并/丢弃）、**文件**（实时浏览房间共享目录与各成员工作区，支持 Markdown/代码预览）、**动态**（实时工具调用与写操作审计流）；
  - XSS-safe 富文本 Markdown 渲染（标题、表格、列表、引用、带一键复制的代码块、`@` 高亮）与可操作的失败诊断横幅。

## 四后端能力对照

| 后端 | 流式输出 | 支持档位 | `full` 档底层参数 | 模型/思考等级发现 |
|---|---|---|---|---|
| `agy` | 逐字流式 | `read` / `write` / `write-exec` / `full` | `--dangerously-skip-permissions` | `agy models` 自动发现 |
| `claude` | 逐字流式 | `readonly` / `read` / `write-ask` / `write` / `write-exec` / `full` | `--dangerously-skip-permissions` | 读取网关 `/v1/models` 与配置校验 |
| `codex` | 整段输出 | `read` / `write-exec` / `full` | `--dangerously-bypass-approvals-and-sandbox`（含 resume） | 解析 `~/.codex/config.toml` 与 `env_key` 检查 |
| `opencode` | 整段输出 | `readonly` / `read` / `write` / `write-exec` / `full` | `opencode.json` 全 `allow` + `--auto` | `opencode debug config` 自动发现 |

## 验证方式

```bash
npm test                                  # 静态契约检查 + 600+ 项单元与集成测试
node scripts/accept-e2e.mjs               # Git Worktree Diff 验收端到端
node scripts/netget-e2e.mjs --skip-llm    # 受限网络下载器 SSRF 与路径边界验证
node scripts/smoke.mjs                    # 真实 CLI 端到端冒烟
```

## 目录结构

```
bin/serve.mjs          多房间 Web 工作台服务
bin/room.mjs           终端交互外壳（演示 + 交互）
bin/doctor.mjs         四后端环境与沙箱自检
bin/netget             受限 HTTP/HTTPS GET 包装器（带 SSRF 与目录边界拦截）
src/adapters/          agy / claude / codex / opencode 适配器
src/core/backends.js   四后端实时体检、模型发现与真实探测
src/core/files.js      房间共享目录与成员工作区安全只读文件浏览器
src/core/room.js       房间调度：串行队列、接力、互 @、打断、看门狗、循环检测、压缩
src/core/mentions.js   @ 解析（长名优先、全角、未知 @、同级互 @ 策略）
src/core/actions.js    结构化动作协议（task / roster / member / continue）
src/core/prompt.js     增量/摘要投递策略、共享目录与权限约束注入
src/core/probe.js      权限档位矩阵与双向沙箱自检
src/core/worktree.js   仓库白名单与 Git Worktree 生命周期
src/core/store.js      追加式 JSONL 事件存储，可重放重建
src/core/runner.js     子进程 NDJSON 行缓冲、PATH 净化、硬超时、进程组清理
public/                零依赖原生前端（index.html / style.css / app.js）
```

## 设计原则

- **动作在轮结束后才解析**：流式输出期间绝不执行半截 JSON，且仅认本人直接输出的动作块并回注执行结果。
- **诚实报错、绝不掩盖**：每个后端的 JSON API 错误、缺失环境变量或模型不匹配都会直接浮现在聊天流失败横幅和诊断面板中。
- **幂等与可审计**：追加式 `room.jsonl` 保留全部消息、动作、工具调用与人工控制日志；`PATH` 净化自动屏蔽数据目录防命令劫持；文件预览双重校验 `resolve` + `realpath` 防止路径穿越。
