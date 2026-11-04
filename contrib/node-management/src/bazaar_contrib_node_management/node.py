"""The running node's host release and its upgrade to a newer one."""

from __future__ import annotations

lazy import asyncio
lazy import os
lazy import sys
lazy import tomllib
lazy from pathlib import Path

from bazaar_core import ServiceKey
lazy from bazaar_contrib_audit import Audit, AuditContext, AuditError
lazy from bazaar_contrib_invoke import Run
lazy from bazaar_contrib_manager import ContribManager, ManagementError, Operation
lazy from pydantic import JsonValue


class UnsupportedUpgrade(ManagementError):
    """A node that cannot replace its own installation while it runs."""


def foreground() -> bool:
    """Whether Windows runs this process from an entry point the tool install replaces."""
    receipt = Path(sys.prefix) / "uv-receipt.toml"
    if sys.platform != "win32" or not receipt.is_file() or len(sys.orig_argv) < 2:
        return False
    # uv's launcher hands Python its own path, which sys.argv[0] reports without .exe.
    running = os.path.normcase(Path(sys.orig_argv[1]).resolve())
    return any(
        os.path.normcase(Path(entry["install-path"]).resolve()) == running
        for entry in tomllib.loads(receipt.read_text("utf-8"))["tool"]["entrypoints"]
    )


class Node:
    """Report the host release, find a newer installable one and hand over to it."""

    def __init__(
        self, manager: ContribManager, audit: Audit, run: Run, running: str
    ) -> None:
        self.manager = manager
        self.audit = audit
        self.run = run
        self.running = running
        self.latest: str | None = None
        self.installing: asyncio.Task[Operation] | None = None

    async def version(self) -> str:
        """The release this process runs, which an install changes only after a restart."""
        return self.running

    async def available(self) -> str | None:
        return self.latest

    async def check(self) -> None:
        self.latest = await self.manager.latest_host()

    async def install(self, version: str | None = None) -> dict[str, JsonValue]:
        """Install a host release the configured contribs run on, by default the newest.

        The node finishes a started install and reports it, even when its caller goes away.
        """
        target = version or self.latest
        if target is None:
            raise ManagementError("no newer bcn release is available")
        if await asyncio.to_thread(foreground):
            raise UnsupportedUpgrade(
                "This node runs in the foreground and cannot upgrade automatically."
            )
        # Held here so the install outlives a caller that goes away mid-await.
        self.installing = asyncio.create_task(self.apply(target))
        operation = await asyncio.shield(self.installing)
        if operation.error is not None:
            raise ManagementError(operation.error)
        return operation.model_dump(mode="json")

    async def apply(self, version: str) -> Operation:
        await self.publish("started", version)
        operation = await self.manager.install_host(version)
        if operation.error is not None:
            await self.publish("failed", version, error=operation.error)
        else:
            await self.publish("installed", version)
        return operation

    async def restart(self) -> None:
        """Stop serving so the process exits and whatever runs it starts it again."""
        self.run.stopped.set()

    async def publish(
        self, phase: str, version: str, *, error: str | None = None
    ) -> None:
        await self.audit.publish(
            "node.upgrade",
            context=AuditContext(agent_id=""),
            payload={"phase": phase, "version": version},
            error=(
                AuditError(kind="upgrade_failed", message=error)
                if error is not None
                else None
            ),
        )


NODE = ServiceKey[Node]("node")
