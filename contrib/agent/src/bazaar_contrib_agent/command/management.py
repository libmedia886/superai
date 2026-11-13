"""Manage Agent configuration through its public model and selected carrier."""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from uuid import uuid7

from bazaar_contrib_channel import ChannelBuilderConfig
from bazaar_contrib_config import (
    ConfigCandidate,
    ConfigConflict,
    ConfigDocument,
    ConfigSnapshot,
    Configuration,
    ConfigurationApplication,
)
from bazaar_contrib_harness import HarnessBuilderConfig, HarnessInspection
from bazaar_contrib_sidecar import Client
from pydantic import BaseModel, JsonValue, TypeAdapter

from bazaar_contrib_agent import AgentConfig, Config, ProviderConfig
from bazaar_contrib_agent.models import SessionMode

# a workspace directory goes over a page at a time, as many as a page of a
# list holds
PAGE = 50
# the largest answer a call can carry back is the server's request limit
READ_LIMIT = 1024 * 1024
# how long 0.2 let one command run
INSPECT_TIMEOUT = 10


@dataclass(frozen=True, slots=True)
class AgentConfiguration:
    agents: tuple[AgentConfig, ...]
    revision: str | None


class Provider(BaseModel):
    """A channel or runtime of an agent, its credentials named but not given."""

    kind: str
    connection: str
    values: dict[str, JsonValue]
    secrets: tuple[str, ...]


class AgentView(BaseModel):
    id: str
    name: str
    mode: Literal["session", "dangerous_individual"]
    session: SessionMode | None
    idle_timeout: float
    channel: tuple[Provider, ...]
    harness: tuple[Provider, ...]


class Listing(BaseModel):
    revision: str | None
    agents: tuple[AgentView, ...]


class Schema(BaseModel):
    kind: str
    json_schema: dict[str, JsonValue]


class Providers(BaseModel):
    channel: tuple[Schema, ...]
    harness: tuple[Schema, ...]


class Entry(BaseModel):
    name: str
    directory: bool
    size: int
    modified_at_ms: int


class Directory(BaseModel):
    root: str
    path: str
    total: int
    entries: tuple[Entry, ...]


class File(BaseModel):
    path: str
    size: int
    modified_at_ms: int
    # nothing when the file is not UTF-8 text or is too large to carry back
    content: str | None


def _keyed(providers: Sequence[ProviderConfig]) -> list[tuple[str, ProviderConfig]]:
    """Each provider with its connection name, its kind and its place among
    those of the kind."""
    positions: dict[str, int] = {}
    keyed = []
    for provider in providers:
        position = positions.get(provider.kind, 0)
        positions[provider.kind] = position + 1
        keyed.append((f"{provider.kind}:{position}", provider))
    return keyed


def _inside(root: Path, path: str) -> Path:
    target = (root / path).resolve()
    if not target.is_relative_to(root):
        raise ValueError(f"path is outside the workspace: {path}")
    return target


def _directory(root: Path, path: str, offset: int) -> Directory:
    directory = _inside(root, path)
    entries: list[Entry] = []
    with os.scandir(directory) as scan:
        for item in scan:
            # a link is not listed: it may lead out of the workspace, or nowhere
            if item.is_symlink():
                continue
            stat = item.stat()
            entries.append(
                Entry(
                    name=item.name,
                    directory=item.is_dir(),
                    size=stat.st_size,
                    modified_at_ms=int(stat.st_mtime * 1000),
                )
            )
    entries.sort(key=lambda entry: (not entry.directory, entry.name))
    return Directory(
        root=str(root),
        path=directory.relative_to(root).as_posix() if directory != root else "",
        total=len(entries),
        entries=tuple(entries[offset : offset + PAGE]),
    )


def _file(root: Path, path: str) -> File:
    file = _inside(root, path)
    stat = file.stat()
    content = None
    if stat.st_size <= READ_LIMIT:
        try:
            content = file.read_bytes().decode()
        except UnicodeDecodeError:
            pass
    return File(
        path=file.relative_to(root).as_posix(),
        size=stat.st_size,
        modified_at_ms=int(stat.st_mtime * 1000),
        content=content,
    )


class AgentManagement:
    """Edit saved Agent entities without acquiring their running instances."""

    def __init__(
        self,
        configuration: Configuration,
        client: Client,
        channels: Sequence[type[ChannelBuilderConfig]],
        harnesses: Sequence[type[HarnessBuilderConfig]],
    ):
        self.configuration = configuration
        self.client = client
        self.channels = tuple(definition.kind for definition in channels)
        self.harnesses = tuple(definition.kind for definition in harnesses)
        self.models = {
            "channel": {
                definition.kind: definition.entity_model for definition in channels
            },
            "harness": {
                definition.kind: definition.entity_model for definition in harnesses
            },
        }
        self.inspections = {definition.kind: definition for definition in harnesses}

    def secrets(self, label: str, kind: str) -> tuple[str, ...]:
        model = self.models[label].get(kind)
        if model is None:
            return ()
        properties = model.model_json_schema().get("properties", {})
        return tuple(
            name for name, field in properties.items() if field.get("writeOnly")
        )

    def masked(
        self, label: str, providers: Sequence[ProviderConfig]
    ) -> tuple[Provider, ...]:
        masked = []
        for connection, provider in _keyed(providers):
            secrets = self.secrets(label, provider.kind)
            values = provider.model_dump(mode="json", exclude={"kind"})
            masked.append(
                Provider(
                    kind=provider.kind,
                    connection=connection,
                    values={
                        name: value
                        for name, value in values.items()
                        if name not in secrets
                    },
                    secrets=tuple(
                        name for name in secrets if values.get(name) is not None
                    ),
                )
            )
        return tuple(masked)

    def view(self, agent: AgentConfig) -> AgentView:
        return AgentView(
            id=agent.id,
            name=agent.name,
            mode=agent.mode,
            session=agent.session,
            idle_timeout=agent.idle_timeout,
            channel=self.masked("channel", agent.channel),
            harness=self.masked("harness", agent.harness),
        )

    def restore(
        self, current: AgentConfig | None, values: Mapping[str, object]
    ) -> dict[str, object]:
        """Fill the credentials an edit did not send from the connection each
        provider names; a credential sent as null is cleared."""
        values = dict(values)
        for label in ("channel", "harness"):
            if label not in values:
                continue
            existing = dict(() if current is None else _keyed(getattr(current, label)))
            providers = []
            for item in TypeAdapter(list[dict[str, Any]]).validate_python(
                values[label]
            ):
                source = existing.get(item.pop("connection", None) or "")
                secrets = self.secrets(label, item.get("kind", ""))
                if source is not None and source.kind == item.get("kind"):
                    kept = source.model_dump(mode="python", exclude={"kind"})
                    for name in secrets:
                        if name not in item and kept.get(name) is not None:
                            item[name] = kept[name]
                providers.append(
                    {
                        name: value
                        for name, value in item.items()
                        if not (name in secrets and value is None)
                    }
                )
            values[label] = providers
        return values

    async def _read(self) -> tuple[dict[str, Any], Config, str | None]:
        candidate, snapshot = await self.configuration.read()
        document = ConfigDocument.model_validate(candidate.payload)
        entry = next(
            (
                entry
                for package in document.contribs
                if package.applies
                for entry in package.enabled
                if entry.entry == "agent"
            ),
            None,
        )
        if entry is None:
            raise ValueError("The agent contrib is not enabled")
        return (
            deepcopy(candidate.payload),
            Config.model_validate(entry.config),
            snapshot.revision if snapshot is not None else None,
        )

    async def _save(
        self, payload: dict[str, Any], config: Config, revision: str | None
    ) -> None:
        document = ConfigDocument.model_validate(payload)
        for index, package in enumerate(document.contribs):
            if not package.applies:
                continue
            for position, entry in enumerate(package.enabled):
                if entry.entry == "agent":
                    payload["contribs"][index]["enabled"][position]["config"] = (
                        config.model_dump(mode="json", exclude_none=True)
                    )
        if self.configuration.start is not None:
            try:
                environment = await self.client.call("configuration", "environment")
            except FileNotFoundError, ConnectionRefusedError:
                await self.configuration.commit(payload, expected_revision=revision)
                return
            if environment != (
                self.configuration.environment.model_dump(mode="json")
                if self.configuration.environment is not None
                else None
            ):
                raise ValueError(
                    "the sidecar belongs to another configuration; "
                    "select its configuration or endpoint"
                )
            _, snapshot = TypeAdapter(
                tuple[ConfigCandidate, ConfigSnapshot | None]
            ).validate_python(await self.client.call("configuration", "read"))
            if (snapshot.revision if snapshot is not None else None) != revision:
                raise ConfigConflict(
                    "the sidecar configuration differs from the selected source"
                )
            snapshot = await self.client.call(
                "configuration", "commit", payload, expected_revision=revision
            )
            result = ConfigurationApplication.model_validate(
                await self.client.call("configuration", "apply", snapshot)
            )
        else:
            snapshot = await self.configuration.commit(
                payload, expected_revision=revision
            )
            result = await self.configuration.apply(snapshot)
        if result.error is not None or not result.applied:
            raise ValueError(
                f"configuration saved but not applied: {result.error}"
                if result.error
                else "configuration saved but not applied"
            )

    async def snapshot(self) -> AgentConfiguration:
        _, config, revision = await self._read()
        return AgentConfiguration(config.agents, revision)

    async def list(self) -> Listing:
        _, config, revision = await self._read()
        return Listing(
            revision=revision, agents=tuple(self.view(agent) for agent in config.agents)
        )

    def providers(self) -> Providers:
        return Providers(
            **{
                label: tuple(
                    Schema(kind=kind, json_schema=model.model_json_schema())
                    for kind, model in models.items()
                )
                for label, models in self.models.items()
            }
        )

    async def inspect(
        self, kind: str, agent_id: str | None = None
    ) -> HarnessInspection:
        """What the runtime reports for the agent's workspace, or for an empty
        one while the agent is still being created."""
        definition = self.inspections[kind]
        if agent_id is not None:
            _, config, _ = await self._read()
            workspace = await asyncio.to_thread(
                self.select(config.agents, agent_id).directory
            )
            await asyncio.to_thread(
                workspace.mkdir, parents=True, exist_ok=True, mode=0o700
            )
            return await definition.inspect(workspace, timeout=INSPECT_TIMEOUT)
        workspace = Path(await asyncio.to_thread(tempfile.mkdtemp))
        try:
            return await definition.inspect(workspace, timeout=INSPECT_TIMEOUT)
        finally:
            await asyncio.to_thread(shutil.rmtree, workspace)

    async def workspace(
        self, agent_id: str, path: str = "", offset: int = 0
    ) -> Directory:
        _, config, _ = await self._read()
        root = await asyncio.to_thread(self.select(config.agents, agent_id).directory)
        return await asyncio.to_thread(_directory, root, path, offset)

    async def read(self, agent_id: str, path: str) -> File:
        _, config, _ = await self._read()
        root = await asyncio.to_thread(self.select(config.agents, agent_id).directory)
        return await asyncio.to_thread(_file, root, path)

    @staticmethod
    def select(agents: tuple[AgentConfig, ...], selector: str) -> AgentConfig:
        matches = [agent for agent in agents if selector in (agent.id, agent.name)]
        if not matches:
            raise ValueError(f"Agent not found: {selector}")
        if len(matches) > 1:
            raise ValueError(f"Agent selector is ambiguous: {selector}")
        return matches[0]

    async def add(self, values: Mapping[str, object]) -> AgentView:
        payload, config, revision = await self._read()
        agent = AgentConfig.model_validate(
            {**self.restore(None, values), "id": str(uuid7())}
        )
        await self._save(payload, Config(agents=(*config.agents, agent)), revision)
        return self.view(agent)

    async def edit(
        self,
        selector: str,
        values: Mapping[str, object],
        *,
        expected_revision: str | None,
    ) -> AgentView:
        payload, config, _ = await self._read()
        current = self.select(config.agents, selector)
        agent = AgentConfig.model_validate(
            {
                **current.model_dump(mode="python"),
                **self.restore(current, values),
                "id": current.id,
            }
        )
        config = Config(
            agents=tuple(
                agent if item.id == current.id else item for item in config.agents
            )
        )
        await self._save(payload, config, expected_revision)
        return self.view(agent)

    async def remove(self, selector: str) -> AgentView:
        payload, config, revision = await self._read()
        agent = self.select(config.agents, selector)
        await self._save(
            payload,
            Config(agents=tuple(item for item in config.agents if item.id != agent.id)),
            revision,
        )
        return self.view(agent)
