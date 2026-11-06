"""Provide the node's default configuration, health and host upgrades."""

from __future__ import annotations

from contextlib import asynccontextmanager
lazy import asyncio
lazy import logging
lazy import platform
lazy import sys
lazy import tomllib
lazy from importlib.metadata import version
lazy from importlib.resources import files
lazy from typing import Any

from bazaar_contrib_audit import AUDIT, AuditContext
from bazaar_contrib_invoke import RUN, contribs
from bazaar_contrib_manager import CONTRIB_MANAGER
from bazaar_contrib_sidecar import RemoteEntry
from bazaar_contrib_timer import TIMER
from bazaar_core import Contrib
lazy from bazaar_contrib_manager import ManagementError
lazy from bazaar_core import Context

from .node import NODE, Node, UnsupportedUpgrade

__all__ = [
    "NODE",
    "Node",
    "UnsupportedUpgrade",
    "defaults",
    "node_health",
    "node_upgrade",
    "remote",
]


def defaults() -> dict[str, Any]:
    """The configuration a new node starts with."""
    return tomllib.loads(files(__package__).joinpath("defaults.toml").read_text())


@asynccontextmanager
async def health(ctx: Context):
    """Publish the node's health once ready and then every startup budget, as 0.2 did.

    Two beats missed tell a consumer the node is gone."""
    audit = ctx.accept(AUDIT)
    timer = ctx.accept(TIMER)
    running = await asyncio.to_thread(version, "bazaar-compute")

    async def beat() -> None:
        while True:
            await audit.publish(
                "node.health",
                context=AuditContext(agent_id=""),
                payload={
                    "contribs": [
                        dict(zip(("name", "state", "error"), row, strict=True))
                        for row in contribs(ctx.snapshots)
                    ],
                    "version": running,
                    "python": sys.version.split()[0],
                    "system": platform.system(),
                    "gil_enabled": sys._is_gil_enabled(),
                    "interval_ms": 60_000,
                },
            )
            await timer.create(60_000).wait()

    async with asyncio.TaskGroup() as tasks:
        task = tasks.create_task(beat())
        try:
            yield
        finally:
            task.cancel()


@asynccontextmanager
async def upgrade(ctx: Context):
    timer = ctx.accept(TIMER)
    node = Node(
        ctx.accept(CONTRIB_MANAGER),
        ctx.accept(AUDIT),
        ctx.accept(RUN),
        await asyncio.to_thread(version, "bazaar-compute"),
    )

    async def watch() -> None:
        """Look for a newer host release hourly, as 0.2's version watcher did."""
        while True:
            try:
                await node.check()
            except ManagementError:
                logging.getLogger(__name__).warning(
                    "node.upgrade.check_failed", exc_info=True
                )
            await timer.create(3_600_000).wait()

    ctx.offer(NODE, node)
    async with asyncio.TaskGroup() as tasks:
        task = tasks.create_task(watch())
        try:
            yield
        finally:
            task.cancel()


node_health = Contrib(accepts=[AUDIT, TIMER], lifespan=health)
node_upgrade = Contrib(
    offers=[NODE], accepts=[RUN, CONTRIB_MANAGER, TIMER, AUDIT], lifespan=upgrade
)
remote = RemoteEntry(NODE, ("version", "available", "info", "install", "restart"))
