"""Register node activation, signal handling and host upgrades for the running node."""

from __future__ import annotations

from contextlib import asynccontextmanager
lazy import asyncio
lazy import logging
lazy import platform
lazy import re
lazy import signal
lazy import sys
lazy from importlib.metadata import version

import click
from bazaar_contrib_audit import AUDIT, AuditContext
from bazaar_contrib_config import CONFIGURATION
from bazaar_contrib_invoke import COMMANDS, CommandEntry, table
from bazaar_contrib_manager import CONTRIB_MANAGER
from bazaar_contrib_sidecar import RemoteEntry
from bazaar_contrib_timer import TIMER
from bazaar_core import Contrib
lazy from bazaar_contrib_config import Configuration
lazy from bazaar_contrib_manager import ManagementError
lazy from bazaar_core import Context, ContribStatus, Stopping

from .node import NODE, RUN, Node, Run, UnsupportedUpgrade

__all__ = [
    "NODE",
    "Node",
    "UnsupportedUpgrade",
    "command_entry",
    "management",
    "node_health",
    "node_upgrade",
    "remote",
]


def _contribs(snapshots: tuple[ContribStatus, ...]) -> list[tuple[str, str, str]]:
    """Each configured contrib's state and what it ended with."""
    rows = []
    for record in snapshots:
        if re.fullmatch(r"contribs\[\d+\]\.enabled\[\d+\]", record.location) is None:
            continue
        error = record.state.error if isinstance(record.state, Stopping) else None
        rows.append(
            (
                record.name,
                type(record.state).__name__.lower(),
                "" if error is None else str(error).splitlines()[0],
            )
        )
    return rows


@asynccontextmanager
async def health(ctx: Context):
    """Publish the node's health once ready and then every startup budget, as 0.2 did.

    Two beats missed tell a consumer the node is gone."""
    audit = ctx.accept(AUDIT)
    timer = ctx.accept(TIMER)
    running = await asyncio.to_thread(version, "bazaar-compute-node")

    async def beat() -> None:
        while True:
            await audit.publish(
                "node.health",
                context=AuditContext(agent_id=""),
                payload={
                    "contribs": [
                        dict(zip(("name", "state", "error"), row, strict=True))
                        for row in _contribs(ctx.snapshots)
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


async def _run(ctx: Context, configuration: Configuration, run: Run) -> None:
    loop = asyncio.get_running_loop()
    if sys.platform != "win32":
        loop.add_signal_handler(signal.SIGTERM, run.stopped.set)
    try:
        await configuration.activate()
        await asyncio.to_thread(
            click.echo,
            table(
                _contribs(ctx.snapshots),
                ("Contrib", "State", "Result"),
            ),
        )
        await asyncio.to_thread(click.echo, "bcn ready")
        await run.stopped.wait()
    finally:
        if sys.platform != "win32":
            loop.remove_signal_handler(signal.SIGTERM)


@asynccontextmanager
async def lifespan(ctx: Context):
    commands = ctx.accept(COMMANDS)
    configuration = ctx.accept(CONFIGURATION)
    serving = Run()

    @click.command("run", help=command_entry.help, short_help=command_entry.help)
    def run():
        return _run(ctx, configuration, serving)

    ctx.offer(RUN, serving)
    with commands.register(run):
        yield


@asynccontextmanager
async def upgrade(ctx: Context):
    timer = ctx.accept(TIMER)
    node = Node(
        ctx.accept(CONTRIB_MANAGER),
        ctx.accept(AUDIT),
        ctx.accept(RUN),
        await asyncio.to_thread(version, "bazaar-compute-node"),
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


command_entry = CommandEntry(
    contrib="node-management",
    help="Run the node, serving until it is stopped.",
)
management = Contrib(offers=[RUN], accepts=[COMMANDS, CONFIGURATION], lifespan=lifespan)
node_health = Contrib(accepts=[AUDIT, TIMER], lifespan=health)
node_upgrade = Contrib(
    offers=[NODE], accepts=[RUN, CONTRIB_MANAGER, TIMER, AUDIT], lifespan=upgrade
)
remote = RemoteEntry(NODE, ("version", "available", "install", "restart"))
