"""Keep configured agent lifetimes independent from configuration consumers."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Collection, Mapping
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING
from uuid import UUID

from bazaar_contrib_audit import AUDIT
from bazaar_contrib_channel import ChannelBuilder
from bazaar_contrib_collaboration import COLLABORATION
from bazaar_contrib_harness import HarnessBuilder
from bazaar_contrib_legacy_node_migrations import LEGACY_NODE_MIGRATIONS
from bazaar_contrib_messages import MESSAGES
from bazaar_contrib_reminder import REMINDER
from bazaar_contrib_schema import SCHEMA
from bazaar_contrib_storage import DB
from bazaar_contrib_timer import TIMER
from bazaar_core import (
    CONTRIB_CHANGED,
    Composition,
    Context,
    Contrib,
    ContribChange,
    ContribEntry,
    Enablement,
    Running,
    ServiceKey,
    Starting,
)

from . import states
from .models import Agent, Config
from .schema import MODULE

if TYPE_CHECKING:
    from .loop import AgentLoop, Runtime

logger = logging.getLogger(__name__)


class AgentInstances:
    def __init__(self, enabled: Enablement):
        self.enabled = enabled
        self.name: str | None = None
        self.running: dict[str, Agent] = {}
        self.channel_order: dict[str, int] = {}
        self.harness_order: dict[str, int] = {}
        self.config = Config()
        self.requests: dict[
            UUID,
            tuple[Config, Mapping[str, ChannelBuilder], Mapping[str, HarnessBuilder]],
        ] = {}
        # What each agent has enabled and what its configuration asks for; an
        # entry being replaced stays enabled until the agent's work lets it go.
        self.entries: dict[str, dict[str, ContribEntry]] = {}
        self.desired: dict[str, dict[str, ContribEntry]] = {}
        self.settling: dict[str, asyncio.Task[None]] = {}
        # the channels stopped to wait for their agent, by entry name
        self.retiring: set[str] = set()
        self.lock = asyncio.Lock()

    async def configure(
        self,
        ctx: Context,
        config: Config,
        channels: Mapping[str, ChannelBuilder],
        harnesses: Mapping[str, HarnessBuilder],
    ) -> None:
        from . import AGENT, _channel, _harness, compose

        desired: dict[str, dict[str, ContribEntry]] = {}
        for item in config.agents:
            composition = compose(
                item, channel_builders=channels, harness_builders=harnesses
            )
            desired[item.id] = {
                entry.name: entry.model_copy(update={"local": (AGENT,)})
                if AGENT in entry.definition.offers
                else entry
                for entry in composition.entries
            }
        self.config = config
        self.channel_order.clear()
        self.channel_order.update(
            (entry.name, index)
            for index, entry in enumerate(
                entry for entries in desired.values() for entry in entries.values()
            )
            if entry.definition == _channel
        )
        self.harness_order.clear()
        for entries in desired.values():
            self.harness_order.update(
                (entry.name, index)
                for index, entry in enumerate(
                    entry for entry in entries.values() if entry.definition == _harness
                )
            )
        # A new order applies in place; only changed providers are replaced.
        for identity in self.running.values():
            loop = identity._loop
            if loop is None:
                continue
            for connection in loop.channels.connections.values():
                if connection.name in self.channel_order:
                    connection.priority = self.channel_order[connection.name]
            for name, runtime in loop.runtimes.items():
                if name in self.harness_order:
                    runtime.priority = self.harness_order[name]
        async with self.lock:
            # no replacement is under way while the lock is held, so what the
            # previous configuration still waited for can be dropped
            await self.cancel()
            self.desired = desired
            retiring: set[str] = set()
            for agent_id in {*self.entries, *desired}:
                current = self.entries.get(agent_id, {})
                target = desired.get(agent_id, {})
                if current == target:
                    continue
                identity = self.running.get(agent_id)
                loop = None if identity is None else identity._loop
                if loop is None:
                    self.adopt(agent_id, None)
                    continue
                if not target:
                    task = asyncio.create_task(self.retire(agent_id, loop))
                elif {
                    name: entry
                    for name, entry in current.items()
                    if entry.definition not in (_channel, _harness)
                } != {
                    name: entry
                    for name, entry in target.items()
                    if entry.definition not in (_channel, _harness)
                }:
                    task = asyncio.create_task(self.restart(agent_id, loop))
                else:
                    replaced = [
                        name
                        for name in {*current, *target}
                        if current.get(name) != target.get(name)
                    ]
                    self.adopt(
                        agent_id, [name for name in replaced if name not in current]
                    )
                    stopping = [
                        name
                        for name in replaced
                        if name in current and current[name].definition == _channel
                    ]
                    for name in stopping:
                        if name in loop.channels.connections:
                            loop.channels.connections[
                                name
                            ].state = states.ConnectionState.STOPPING
                    retiring.update(stopping)
                    task = asyncio.create_task(
                        self.settle(
                            agent_id,
                            loop,
                            stopping,
                            [
                                name
                                for name in replaced
                                if name in current
                                and current[name].definition == _harness
                            ],
                        )
                    )
                task.add_done_callback(_settled)
                self.settling[agent_id] = task
            # a channel whose change was taken back goes on receiving
            for identity in self.running.values():
                loop = identity._loop
                if loop is None:
                    continue
                for name in self.retiring - retiring:
                    connection = loop.channels.connections.get(name)
                    if (
                        connection is not None
                        and connection.state is states.ConnectionState.STOPPING
                    ):
                        connection.state = states.ConnectionState.RUNNING
            self.retiring = retiring
            await self.apply()
        self.name = ctx.name

    async def cancel(self) -> None:
        for task in self.settling.values():
            task.cancel()
        await asyncio.gather(*self.settling.values(), return_exceptions=True)
        self.settling.clear()

    def adopt(self, agent_id: str, names: Collection[str] | None) -> None:
        """Enable what the configuration asks for in place of the named
        entries, or of all the agent's entries."""
        current = self.entries.setdefault(agent_id, {})
        target = self.desired.get(agent_id, {})
        for name in {*current, *target} if names is None else names:
            if name in target:
                current[name] = target[name]
            else:
                current.pop(name, None)
        if not current:
            del self.entries[agent_id]

    async def apply(self) -> None:
        await self.enabled.update(
            Composition(
                entries=tuple(
                    entry
                    for entries in self.entries.values()
                    for entry in entries.values()
                )
            )
        )
        for identity in tuple(self.running.values()):
            loop = identity._loop
            if loop is None:
                continue
            connected = sorted(
                (
                    connection
                    for connection in loop.channels.connections.values()
                    if not connection.ready.is_set()
                ),
                key=lambda connection: connection.priority,
            )
            storage = loop.service.storage
            for connection in connected:
                channel_identity = connection.channel.get_identity().id
                for session in await storage.list_channel_sessions_without_identity(
                    connection.kind
                ):
                    await storage.backfill_channel_identity(
                        session.id,
                        channel_identity=channel_identity,
                        provider_thread_id=loop.channels.backfill_provider_thread_id(
                            session.provider_thread_id,
                            channel=connection.kind,
                            channel_identity=channel_identity,
                        ),
                    )
                connection.ready.set()
            if connected:
                await loop.recover()

    async def replace(self, agent_id: str, names: Collection[str] | None) -> None:
        async with self.lock:
            self.adopt(agent_id, names)
            await self.apply()

    async def retire(self, agent_id: str, loop: AgentLoop) -> None:
        await loop.stop()
        await self.replace(agent_id, None)

    async def restart(self, agent_id: str, loop: AgentLoop) -> None:
        """Replace the whole agent once it has no work."""
        while loop.channels.pending or await loop.busy():
            await loop.timer.create(max(100, loop.timer.tick_ms)).wait()
        await loop.stop()
        await self.replace(agent_id, None)

    async def settle(
        self,
        agent_id: str,
        loop: AgentLoop,
        channels: Collection[str],
        runtimes: Collection[str],
    ) -> None:
        """Replace changed channels once the agent has no work, and each changed
        runtime once its sessions have finished theirs."""

        async def reconnect() -> None:
            connections = [
                loop.channels.connections[name]
                for name in channels
                if name in loop.channels.connections
            ]
            while connections and (loop.channels.pending or await loop.busy()):
                await loop.timer.create(max(100, loop.timer.tick_ms)).wait()
            for connection in connections:
                connection.state = states.ConnectionState.DRAINED
            await self.replace(agent_id, channels)

        async def renew(name: str) -> None:
            runtime = loop.runtimes.get(name)
            if runtime is not None:
                await self.expire(loop, runtime)
            await self.replace(agent_id, (name,))

        async with asyncio.TaskGroup() as group:
            if channels:
                group.create_task(reconnect())
            for name in runtimes:
                group.create_task(renew(name))

    async def expire(self, loop: AgentLoop, runtime: Runtime) -> None:
        """Close the runtime's sessions as each becomes idle, its turns and
        background jobs done, then stop it taking new ones."""
        while True:
            for actor_loop in tuple(loop.actor_loops.values()):
                state = actor_loop.state
                binding = None if isinstance(state, states.Dormant) else state.binding
                if (
                    binding is not None
                    and binding.runtime is runtime
                    and actor_loop.task is None
                    and actor_loop.queue.empty()
                    and not await loop.background(actor_loop)
                ):
                    await loop.close_session(actor_loop)
            if not runtime.pending and not any(
                not isinstance(actor_loop.state, states.Dormant)
                and actor_loop.state.binding is not None
                and actor_loop.state.binding.runtime is runtime
                for actor_loop in loop.actor_loops.values()
            ):
                runtime.state = states.Lifecycle.STOPPING
                return
            await loop.timer.create(max(100, loop.timer.tick_ms)).wait()


def _settled(task: asyncio.Task[None]) -> None:
    if not task.cancelled() and task.exception() is not None:
        logger.error("Agent replacement failed", exc_info=task.exception())


AGENTS = ServiceKey[AgentInstances]("agent.instances")
SERVICES = [
    AUDIT,
    MESSAGES,
    COLLABORATION,
    REMINDER,
    TIMER,
    DB,
]


@asynccontextmanager
async def lifespan(ctx: Context):
    async with (
        ctx.accept(SCHEMA).register(MODULE),
        ctx.enable(Composition()) as enabled,
    ):
        service = AgentInstances(enabled)
        ctx.offer(AGENTS, service)
        await ctx.accept(REMINDER).start(timeout=60, shutdown_timeout=5)
        try:
            yield
        finally:
            async with service.lock:
                await service.cancel()


async def changed(ctx: Context, change: ContribChange) -> None:
    # Retained instances are notified after a composition replacement is activated.
    if not any(
        record.id == ctx.id and isinstance(record.state, Running)
        for record in change.snapshots
    ):
        return
    service = ctx.accept(AGENTS)
    if (
        service.name is not None
        and not any(record.name == service.name for record in change.snapshots)
        and not any(
            record.name == service.name
            and isinstance(record.state, (Starting, Running))
            for record in ctx.snapshots
        )
    ):
        await service.configure(ctx, Config(), {}, {})
        service.name = None


execution = Contrib(
    accepts=[*SERVICES, SCHEMA, LEGACY_NODE_MIGRATIONS],
    offers=[AGENTS],
    lifespan=lifespan,
    listen={CONTRIB_CHANGED: changed},
)


async def configured(ctx: Context, change: ContribChange) -> None:
    if not any(
        record.id == ctx.id and isinstance(record.state, Running)
        for record in change.snapshots
    ):
        return
    service = ctx.accept(AGENTS)
    request = service.requests.pop(ctx.id, None)
    if request is None:
        return
    await service.configure(ctx, *request)
