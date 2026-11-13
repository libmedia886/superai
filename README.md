# SuperAI

Bring Your Own Agents to the bazaar, and build with your teams in the open.

不必独自建造——带上你的智能体，来集市。

> **This is a derivative project / 本项目为派生项目**
>
> This repository (`libmedia886/superai`) is derived from
> [yuchanns/bazaar-compute-node](https://github.com/yuchanns/bazaar-compute-node).
> It is **not** the upstream project, and issues or pull requests filed here do
> not affect upstream. Upstream maintains the original, authoritative source.
>
> 本仓库（`libmedia886/superai`）派生自
> [yuchanns/bazaar-compute-node](https://github.com/yuchanns/bazaar-compute-node)，
> 并非上游项目本身。此处的 issue 与 PR 与上游无关，上游仍是原始权威来源。

<p align="left">
  <a href="https://github.com/libmedia886/superai/actions/workflows/pull-request.yml"><img
    src="https://github.com/libmedia886/superai/actions/workflows/pull-request.yml/badge.svg?branch=main"
    alt="CI"
  /></a>
</p>

**Documentation is coming soon...**

## Quick Start / 快速开始

Python 3.14+ is required.

需要 Python 3.14 或更高版本。

> **Note / 注意**: the commands below install
> [`superai`](https://pypi.org/project/superai) from PyPI,
> which is **upstream** code, not this fork. To run the code in this repository,
> install it from a checkout instead.
>
> 下方命令从 PyPI 安装的 `superai` 是**上游**代码，不是本仓库的代码。
> 要运行本仓库的代码，请从本地检出的副本安装。

```sh
# Install / 安装
uv tool install superai
superai --version

# Upgrade / 升级
uv tool upgrade superai

# Add an Agent / 添加智能体
# allowed_chats lists the chats let in by name: Telegram chat ids (a private
# chat's id is the other side's user id). Others wait to be reviewed on the
# server; with no server and no list, everyone is let in
# allowed_chats 是按名放行的会话：Telegram 的 chat id（私聊的 chat id 就是对方
# 的 user id）。其余的等服务端审核；没接服务端也没写名单时，谁来都放行
superai agent add \
  --name Tifa \
  --channel telegram \
  --runtime codex \
  --set channel.token_env=SUPERAI_TELEGRAM_TIFA_TOKEN \
  --set channel.allowed_chats=["123456789"]

# Configure the runtime environment / 配置运行时环境
# Example file content / 示例文件内容:
# SUPERAI_TELEGRAM_TIFA_TOKEN=replace-with-your-token

# Register the user-level system service / 注册用户级宿主机服务
superai system-service install --env-file ~/.config/superai/runtime.env

# Start the registered service / 启动已注册的服务
superai system-service start

# Inspect registration and superai health / 查看注册状态和 superai 运行状态
superai system-service status

# Restart or stop the registered service / 重启或停止已注册的服务
superai system-service restart
superai system-service stop
```

## Service logs / 服务日志

```text
Linux:   journalctl --user -u superai.service -f
macOS:   tail -f ~/.superai/system-service.log
Windows: Get-Content "$env:USERPROFILE\.superai\system-service.log" -Wait
```

## Features / 功能

- ✅ Done / 已完成
- 🚧 Working in progress / 开发中

### Facilities / 通用能力

| Status / 状态 | Ability / 能力 |
| --- | --- |
| ✅ | Reminders / 定时器 |
| ✅ | Attachments / 附件 |
| ✅ | Multi-Agents / 多智能体 |
| ✅ | Teams / 团队协作 |

### Channels / 渠道

| Status / 状态 | Channel / 渠道 |
| --- | --- |
| ✅ | WeCom / 企业微信 |
| ✅ | Telegram |
| ✅ | Lark / 飞书 |
| 🚧 | GitHub |
| 🚧 | GitLab |

### Harnesses

| Status / 状态 | Runtime / 运行时 |
| --- | --- |
| ✅ | Codex |
| ✅ | Claude Code |
| 🚧 | Pi |
| 🚧 | Hermes Agent |
| 🚧 | DeepSeek Harness |

### Platforms / 平台

| Status / 状态 | Platform / 平台 |
| --- | --- |
| ✅ | Windows |
| ✅ | macOS |
| ✅ | Linux |

## License / 许可证

This project is licensed under the [AGPLv3](./LICENSE).
本项目采用 [AGPLv3](./LICENSE) 许可证。

As a derivative work, this repository is distributed under the same AGPLv3 terms
as upstream; the upstream copyright notices are retained in full. Modifications
made in this repository are documented in the commit history and, where they
touch individual files, noted in those files.

本仓库作为派生作品，沿用上游的 AGPLv3 条款分发，上游的版权声明完整保留。本仓库
的改动见提交历史；涉及具体文件的改动，会在相应文件中注明。

| | Source / 来源 |
| --- | --- |
| Upstream / 上游 | [yuchanns/bazaar-compute-node](https://github.com/yuchanns/bazaar-compute-node) |
| This fork / 本仓库 | [libmedia886/superai](https://github.com/libmedia886/superai) |

## Credits / 致谢

This project is inspired by [raft.build](https://raft.build).
本项目的灵感来自 [raft.build](https://raft.build)。

Thanks to the upstream authors and contributors of
[yuchanns/bazaar-compute-node](https://github.com/yuchanns/bazaar-compute-node),
whose work this repository builds upon.
感谢 [yuchanns/bazaar-compute-node](https://github.com/yuchanns/bazaar-compute-node)
的上游作者与贡献者，本仓库建立在其工作之上。
