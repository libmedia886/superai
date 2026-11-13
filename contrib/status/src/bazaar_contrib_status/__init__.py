"""Expose hub-owned lifecycle status through an ordinary contrib service."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Protocol
lazy from collections.abc import AsyncIterator
lazy from uuid import UUID

from bazaar_contrib_sidecar import RemoteEntry
from bazaar_core import Contrib, ServiceKey, Stopping
from pydantic import BaseModel
lazy from bazaar_core import Context, ContribStatus

__all__ = ["CONTRIB_STATUS", "ContribStatusQuery", "Status", "status"]


class Status(BaseModel):
    id: UUID
    name: str
    location: str
    state: str
    error: str | None = None
    parent: UUID | None = None


class ContribStatusQuery(Protocol):
    def snapshot(self) -> tuple[ContribStatus, ...]: ...

    def states(self) -> tuple[Status, ...]: ...


CONTRIB_STATUS = ServiceKey[ContribStatusQuery]("contrib.status")


class _ContribStatus:
    def __init__(self, ctx: Context) -> None:
        self._ctx = ctx

    def snapshot(self) -> tuple[ContribStatus, ...]:
        return self._ctx.snapshots

    def states(self) -> tuple[Status, ...]:
        return tuple(
            Status(
                id=row.id,
                name=row.name,
                location=row.location,
                state=type(row.state).__name__.lower(),
                error=row.state.error if isinstance(row.state, Stopping) else None,
                parent=row.parent,
            )
            for row in self.snapshot()
        )


@asynccontextmanager
async def _status(ctx: Context) -> AsyncIterator[None]:
    ctx.offer(CONTRIB_STATUS, _ContribStatus(ctx))
    yield


status = Contrib(offers=[CONTRIB_STATUS], lifespan=_status)
remote = RemoteEntry(CONTRIB_STATUS, ("states",))
