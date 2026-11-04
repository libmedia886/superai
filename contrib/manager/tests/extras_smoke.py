"""Install the node through its extra or the earlier name, then let it upgrade itself."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tomllib
from contextlib import asynccontextmanager
from hashlib import sha256
from importlib.metadata import distribution
from importlib.resources import files
from pathlib import Path

import tomli_w
from bazaar_compute_node.boot import build, node
from bazaar_contrib_config import ConfigDocument
from bazaar_contrib_sidecar import CLIENT, Client
from bazaar_core import Composition, Context, Contrib, ContribEntry
from blockbuster import blockbuster_ctx
from packaging.requirements import Requirement

from bazaar_contrib_manager import Operation


def requested() -> dict[str, object]:
    """The requirement this uv tool was installed for, as its receipt records it."""
    prefix = Path(sys.prefix)
    document = tomllib.loads((prefix / "uv-receipt.toml").read_text("utf-8"))
    return next(
        item for item in document["tool"]["requirements"] if item["name"] == prefix.name
    )


def installed(payload: dict) -> None:
    """Every package the configuration declares for this platform is installed."""
    for package in payload["contribs"]:
        requirement = Requirement(package["package"])
        if requirement.marker is None or requirement.marker.evaluate():
            distribution(requirement.name)


async def exercise(path: Path, source: str, releases: Path) -> None:
    before = await asyncio.to_thread(requested)
    # The extra brings the node hub; the manager installs the rest from its defaults.
    await asyncio.to_thread(distribution, "bazaar-contrib-node-management")

    config = path / "config.toml"
    payload = tomllib.loads(
        await asyncio.to_thread(
            files("bazaar_compute_node").joinpath("defaults.toml").read_text
        )
    )
    official = json.loads(
        await asyncio.to_thread(
            files("bazaar_contrib_manager").joinpath("catalog.json").read_text
        )
    )
    catalog = {entry["package"] for entry in official["contribs"]}
    for package in payload["contribs"]:
        package["source"] = (
            source
            if Requirement(package["package"]).name in catalog
            else "https://pypi.org/simple"
        )
        for entry in package["enabled"]:
            if entry["entry"] == "contrib-manager":
                entry["config"] = {"host_source": source}
    await asyncio.to_thread(config.write_text, tomli_w.dumps(payload))

    versions = json.loads(
        await asyncio.to_thread((releases / "versions.json").read_text)
    )
    for name in ("bazaar-compute", "bazaar-compute-node"):
        wheel = next(
            (path / "registry" / "one" / "files").glob(
                f"{name.replace('-', '_')}-{versions['target']}-*.whl"
            )
        )
        index = path / "registry" / "one" / "simple" / name / "index.html"
        digest = sha256(await asyncio.to_thread(wheel.read_bytes)).hexdigest()
        await asyncio.to_thread(
            index.write_text,
            await asyncio.to_thread(index.read_text)
            + f'\n<a href="../../files/{wheel.name}#sha256={digest}">{wheel.name}</a>',
        )

    bcn = Path(os.environ["UV_TOOL_BIN_DIR"]) / (
        "bcn.exe" if os.name == "nt" else "bcn"
    )
    # The system service runs a copy, leaving the entry point free for uv to replace.
    running = path / ("bcn.running.exe" if os.name == "nt" else "bcn.running")
    await asyncio.to_thread(shutil.copyfile, bcn, running)
    await asyncio.to_thread(running.chmod, 0o700)
    clients: list[Client] = []

    @asynccontextmanager
    async def control(ctx: Context):
        clients.append(ctx.accept(CLIENT))
        yield

    def select(document: ConfigDocument) -> Composition:
        composition = build(document)
        entry = ContribEntry(
            name="node-control", definition=Contrib(accepts=[CLIENT], lifespan=control)
        )
        return composition.model_copy(
            update={"entries": (*composition.entries, entry), "roots": (entry.name,)}
        )

    process = await asyncio.create_subprocess_exec(
        str(running),
        "--config",
        str(config),
        "run",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        assert process.stdout is not None
        while b"bcn ready" not in (line := await process.stdout.readline()):
            assert line, "bcn run ended before it was ready"
        await asyncio.to_thread(installed, payload)
        async with node(configer_options=(str(config),), start=select):
            operation = Operation.model_validate(
                await clients[0].call(
                    "node", "install", versions["target"], timeout=None
                )
            )
            assert operation.installed, operation.model_dump_json(indent=2)
            await clients[0].call("node", "restart")
            output, _ = await process.communicate()
        assert process.returncode == 0, output.decode()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()

    after = await asyncio.to_thread(requested)
    assert (after["name"], after.get("extras")) == (
        before["name"],
        before.get("extras"),
    ), (before, after)
    version = await asyncio.create_subprocess_exec(
        str(bcn), "--version", stdout=asyncio.subprocess.PIPE
    )
    output, _ = await version.communicate()
    assert versions["target"] in output.decode(), output.decode()
    await asyncio.to_thread(installed, payload)


if __name__ == "__main__":
    with blockbuster_ctx():
        asyncio.run(exercise(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[4])))
    print("Installed node extra workflow passed")
