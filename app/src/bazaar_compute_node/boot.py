"""Node bootstrap inputs, packaged combinations, and concrete input graphs."""

from __future__ import annotations

from contextlib import asynccontextmanager
lazy import asyncio
lazy import importlib
lazy from collections.abc import AsyncIterator, Callable, Mapping, Sequence
lazy from importlib.metadata import entry_points
lazy from typing import Any

lazy from bazaar_contrib_config import (
    CONFIG_PREPARE,
    CONFIG_PREPARED,
    CONFIG_STORE,
    CONFIGURATION,
    ConfigDocument,
    ConfigFormatError,
    Configuration,
    ConfigurationEnvironment,
    ContribPackage,
    EnabledContrib,
    configuration,
)
lazy from bazaar_contrib_config_versions import VERSIONS
lazy from bazaar_contrib_manager import CONTRIB_MANAGER, ContribManager
lazy from bazaar_core import (
    Composition,
    Context,
    Contrib,
    ContribEntry,
    ContribHub,
    ContribSpec,
    discover,
    load,
)

lazy from . import run

DEFAULTS = "bazaar_compute_node.defaults"


def defaults() -> dict[str, Any]:
    """Merge the default configurations of installed packages in entry name order.

    A package several of them declare is declared once, enabling each entry once."""
    merged: dict[str, Any] = {}
    declared: dict[str, dict[str, Any]] = {}
    enabled: set[str] = set()
    for point in sorted(entry_points(group=DEFAULTS), key=lambda point: point.name):
        document = point.load()()
        merged.setdefault("version", document["version"])
        indexes = merged.setdefault("contrib_indexes", [])
        for index in document.get("contrib_indexes", ()):
            if index not in indexes:
                indexes.append(index)
        for package in document.get("contribs", ()):
            entries = [
                entry
                for entry in package.get("enabled", ())
                if entry["entry"] not in enabled
            ]
            enabled.update(entry["entry"] for entry in entries)
            name = ContribPackage.model_validate(package).distribution
            if name in declared:
                declared[name]["enabled"].extend(entries)
            else:
                declared[name] = package | {"enabled": entries}
                merged.setdefault("contribs", []).append(declared[name])
    return merged


def build(document: ConfigDocument) -> Composition:
    """Load enabled contrib declarations without interpreting their business input."""
    return load(
        [
            ContribSpec(
                contrib=entry.entry,
                config=entry.config,
                location=f"contribs[{index}].enabled[{position}]",
            )
            for index, package in enumerate(document.contribs)
            if package.applies
            for position, entry in enumerate(package.enabled)
        ]
    )


def bootstrap(
    *,
    configer: str = "config-filesystem",
    configer_options: Sequence[str] = (),
    start: Callable[[ConfigDocument], Composition] | None = None,
    document: Mapping[str, object] | None = None,
) -> tuple[Composition, ContribEntry]:
    definitions = load(
        [
            ContribSpec(
                contrib=configer,
                config={"options": configer_options} if configer_options else {},
                location="--configer/--configer-options/--config",
                required_offers=[CONFIG_STORE],
            ),
            *VERSIONS,
        ]
    )
    if definitions.diagnostics:
        raise ConfigFormatError(
            "; ".join(
                f"{record.name}: {record.state}" for record in definitions.diagnostics
            )
        )
    entries = []
    for entry in definitions.entries:
        config = entry.definition.validate_config(entry.config, context=definitions)
        entries.append(
            EnabledContrib(
                entry=entry.name,
                config=config.model_dump(mode="json") if config is not None else {},
            )
        )
    if document is None:
        document = defaults()
    return (
        definitions,
        ContribEntry(
            name="node-configuration",
            definition=configuration(
                document,
                build,
                environment=ConfigurationEnvironment(
                    hub="bazaar_core:ContribHub",
                    entries=tuple(entries),
                ),
                start=start,
            ),
            location=DEFAULTS,
        ),
    )


@asynccontextmanager
async def node(
    *,
    configer: str = "config-filesystem",
    configer_options: Sequence[str] = (),
    start: Callable[[ConfigDocument], Composition] | None = None,
) -> AsyncIterator[ContribHub]:
    """Prepare configured dependencies before selecting business definitions."""

    packages: list[ContribPackage] = []
    if configer == "config-filesystem" and not any(
        source.name == configer for source in await asyncio.to_thread(discover)
    ):
        packages.append(
            ContribPackage(package="bazaar-contrib-config-filesystem~=0.3.0rc1")
        )
    # The host installed alone runs as a node.
    if not await asyncio.to_thread(entry_points, group=DEFAULTS):
        packages.append(
            ContribPackage(package="bazaar-contrib-node-management~=0.3.0rc1")
        )
    if packages:
        managers: list[ContribManager] = []

        @asynccontextmanager
        async def observe_manager(ctx: Context):
            managers.append(ctx.accept(CONTRIB_MANAGER))
            yield

        document = ConfigDocument(
            contribs=(
                *packages,
                ContribPackage(
                    enabled=(
                        EnabledContrib(entry="commands"),
                        EnabledContrib(entry="contrib-manager"),
                    )
                ),
            )
        )
        entries, loader = await asyncio.to_thread(
            bootstrap,
            configer="config-memory",
            document=document.model_dump(mode="json"),
        )
        async with (
            run(entries, loader) as hub,
            hub.enable(
                Composition(
                    entries=[
                        ContribEntry(
                            name="bootstrap-manager",
                            definition=Contrib(
                                accepts=[CONTRIB_MANAGER], lifespan=observe_manager
                            ),
                        )
                    ]
                )
            ),
        ):
            Configuration.check(hub)
            result = await managers[0].bootstrap()
            if result.error:
                raise ConfigFormatError(result.error)
        await asyncio.to_thread(importlib.invalidate_caches)

    configurations: list[Configuration] = []
    preparers: list[str] = []
    prepared = asyncio.Semaphore(0)

    @asynccontextmanager
    async def dependencies(ctx: Context):
        configurations.append(ctx.accept(CONFIGURATION))
        yield

    def initial(document: ConfigDocument) -> Composition:
        composition = build(document)
        preparers.extend(
            entry.name
            for entry in composition.entries
            if CONFIG_PREPARE in entry.definition.listen
        )
        entry = ContribEntry(
            name="node-dependencies",
            definition=Contrib(
                accepts=[CONFIGURATION],
                lifespan=dependencies,
                listen={CONFIG_PREPARED: lambda ctx, _: prepared.release()},
            ),
        )
        return composition.model_copy(
            update={
                "entries": (*composition.entries, entry),
                "roots": (entry.name, *preparers),
            }
        )

    entries, loader = await asyncio.to_thread(
        bootstrap,
        configer=configer,
        configer_options=configer_options,
        start=initial,
    )

    async def prepare(hub: ContribHub) -> None:
        Configuration.check(hub)
        await hub.announce(CONFIG_PREPARE, None)
        for _ in preparers:
            await prepared.acquire()
        await configurations[0].select(start)

    async with run(entries, loader, prepare=prepare) as hub:
        yield hub
