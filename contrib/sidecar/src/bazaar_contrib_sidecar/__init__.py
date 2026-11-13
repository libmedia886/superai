"""Sidecar contracts and an ordinary Contrib serving installed remote entries."""

from __future__ import annotations

from contextlib import asynccontextmanager
lazy import asyncio

from bazaar_core import CONTRIB_CHANGED, Context, Contrib, ContribChange

from .contracts import CLIENT, REMOTES, SERVER, Handler, Server, Sessions
from .handlers import RemoteEntry
lazy from .handlers import Remotes, Session, remotes
lazy from .remote import Client, RemoteError

__all__ = [
    "CLIENT",
    "SERVER",
    "Client",
    "Handler",
    "RemoteEntry",
    "RemoteError",
    "Server",
    "Sessions",
    "sidecar",
]


@asynccontextmanager
async def lifespan(ctx: Context):
    served = Remotes(await asyncio.to_thread(remotes))
    ctx.offer(REMOTES, served)
    async with ctx.accept(SERVER).serve(lambda: Session(ctx, served)):
        yield


async def changed(ctx: Context, change: ContribChange) -> None:
    # the entries the sidecar starts for its own calls install nothing
    if any(status.parent != ctx.id for status in change.snapshots):
        await ctx.accept(REMOTES).refresh()


sidecar = Contrib(
    accepts=[SERVER],
    offers=[REMOTES],
    lifespan=lifespan,
    listen={CONTRIB_CHANGED: changed},
)
