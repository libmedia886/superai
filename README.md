# Bazaar Compute

Bring Your Own Agents to the bazaar, and build with your teams in the open.

不必独自建造——带上你的智能体，来集市。

<p align="left">
  <a href="https://github.com/yuchanns/bazaar-compute-node/actions"><img
    src="https://github.com/yuchanns/bazaar-compute-node/actions/workflows/release.yml/badge.svg"
    alt="Release"
  /></a>
  <a href="https://pypi.org/project/bazaar-compute"><img
    src="https://img.shields.io/pypi/v/bazaar-compute.svg"
    alt="Python Package Index"
  /></a>
</p>

Bazaar Compute runs your AI agents on your own computer and brings them into the chat tools your team already uses, where they work with people in group chats and direct messages.

Bazaar Compute 在你自己的电脑上运行 AI 智能体，并将它们接入团队已在使用的聊天工具，在群聊和私聊中与成员协作。

**Documentation is coming soon...**

## Why Bazaar Compute / 为什么选择 Bazaar Compute

- **Bring your own agents.** Agents run on your computer with the subscriptions you already have.
  **带上你的智能体。** 智能体运行在你的电脑上，使用你已有的订阅。
- **Work with your team.** Agents take part in group chats and direct messages, and several agents can work together.
  **与团队协作。** 智能体参与群聊和私聊，多个智能体也可以协同工作。
- **Add what you need.** Every channel and runtime is a contrib, installed with one command.
  **按需扩展。** 每个渠道和运行时都是一个 contrib，一条命令即可安装。

## Quick Start / 快速开始

Runs on Windows, macOS and Linux; Python 3.15+ is required.

支持 Windows、macOS 和 Linux，需要 Python 3.15 或更高版本：

```sh
uv tool install "bazaar-compute[node]"
bcn contrib add codex --enable
bcn contrib add telegram --enable
bcn agent add \
  --name Tifa \
  --channel telegram \
  --harness codex \
  --set channel.token_env=BCN_TELEGRAM_TIFA_TOKEN

# Set BCN_TELEGRAM_TIFA_TOKEN in the shell, then start the node.
bcn run
```

New conversations wait for approval; see [agent commands](contrib/agent/README.md).

新会话需经批准后才会处理，见 [agent 命令](contrib/agent/README.md)。

## Contribs

Channels, runtimes and other features are provided as contribs. The contrib marketplace is coming soon; until then, `bcn contrib entries` lists the contribs you can add.

渠道、运行时等功能均以 contrib 的形式提供。contrib 市场即将上线，在此之前，可以用 `bcn contrib entries` 查看可添加的 contrib。

## License / 许可证

This project is licensed under the [Apache License 2.0](./LICENSE).
本项目采用 [Apache License 2.0](./LICENSE) 许可证。

## Credits / 致谢

This project is inspired by [raft.build](https://raft.build).
本项目的灵感来自 [raft.build](https://raft.build)。
