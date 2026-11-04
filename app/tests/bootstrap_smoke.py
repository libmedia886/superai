"""Exercise carrier and defaults bootstrap in a minimal, independently installed app."""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import tomllib
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import tomli_w
from bazaar_contrib_config import CONFIGURATION, Configuration
from bazaar_core import Composition, Context, Contrib, ContribEntry, discover
from blockbuster import blockbuster_ctx
from packaging.requirements import Requirement

from bazaar_compute_node.boot import build, node


async def read(options: dict[str, Any]) -> dict[str, Any]:
    configurations: list[Configuration] = []

    @asynccontextmanager
    async def observe(ctx: Context):
        configurations.append(ctx.accept(CONFIGURATION))
        yield

    async with (
        node(**options) as hub,
        hub.enable(
            Composition(
                entries=[
                    ContribEntry(
                        name="bootstrap-observer",
                        definition=Contrib(accepts=[CONFIGURATION], lifespan=observe),
                    )
                ]
            )
        ),
    ):
        Configuration.check(hub)
        candidate, _ = await configurations[0].read()
        return candidate.payload


async def exercise(path: Path, mode: str) -> None:
    installed = await asyncio.to_thread(discover)
    assert not any(source.name == "config-filesystem" for source in installed)
    index = str(path / "private-catalog.json")
    payload = {"version": "5", "contrib_indexes": [index], "contribs": []}
    if mode == "custom":
        module = await asyncio.to_thread(
            importlib.import_module, "bcn_example_contribs"
        )
        centers = await asyncio.to_thread(
            importlib.import_module, "bcn_example_contribs.center"
        )
        center = centers.ConfigCenter(path / "center.sqlite3")
        port = await center.start()
        store = module.RemoteStore(module.RemoteConfig(port=port, key="bootstrap"))
        await store.write(payload, expected_revision=None)
        try:
            candidate = await read(
                {
                    "configer": "example-config",
                    "configer_options": (f"port={port}", "key=bootstrap"),
                }
            )
            assert index in candidate["contrib_indexes"]
            snapshot = await store.read()
            assert snapshot is not None
            assert index in snapshot.payload["contrib_indexes"]
        finally:
            await center.close()
        assert not any(
            source.name == "config-filesystem"
            for source in await asyncio.to_thread(discover)
        )
    else:
        config = path / "config.toml"
        await asyncio.to_thread(
            config.write_text,
            tomli_w.dumps(payload),
        )
        options: dict[str, Any] = {"configer_options": (str(config),)}
        if mode == "explicit":
            options["configer"] = "config-filesystem"
        candidate = await read(options)
        assert index in candidate["contrib_indexes"]
        saved = tomllib.loads(await asyncio.to_thread(config.read_text))
        assert index in saved["contrib_indexes"]
        installed = await asyncio.to_thread(discover)
        assert any(source.name == "config-filesystem" for source in installed)
        assert not any(source.name == "sqlite" for source in installed)

        original = os.environ["PATH"]
        os.environ["PATH"] = str(Path(sys.executable).parent)
        try:
            candidate = await read(options)
            assert index in candidate["contrib_indexes"]
        finally:
            os.environ["PATH"] = original
        if mode == "default":
            fresh = path / "fresh.toml"
            async with node(
                configer_options=(str(fresh),),
                start=lambda document: build(document).model_copy(update={"roots": ()}),
            ):
                pass
            created = tomllib.loads(await asyncio.to_thread(fresh.read_text))
            assert any(
                Requirement(package["package"]).name == "bazaar-contrib-node-management"
                for package in created["contribs"]
            )
            installed = await asyncio.to_thread(discover)
            assert any(source.name == "node-health" for source in installed)
    await asyncio.to_thread(
        print, f"Minimal app carrier bootstrap passed: {mode}", flush=True
    )


if __name__ == "__main__":
    with blockbuster_ctx():
        asyncio.run(exercise(Path(sys.argv[1]), sys.argv[2]))
