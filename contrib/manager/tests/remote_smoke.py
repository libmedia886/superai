"""Add a contrib to a running node through its sidecar, as a server does."""

from __future__ import annotations

import asyncio
import os
import signal
import sys
import tomllib
from contextlib import asynccontextmanager
from pathlib import Path

from bazaar_compute_node.boot import build, node
from bazaar_contrib_config import ConfigDocument
from bazaar_contrib_sidecar import CLIENT, Client
from bazaar_core import Composition, Context, Contrib, ContribEntry
from live_smoke import configure

from bazaar_contrib_manager import Operation

FINISHED = ("complete", "failed", "cancelled")


async def exercise(path: Path, source: str):
    config = path / "remote.toml"
    journal = path / "remote.txt"
    await configure(config, source)
    clients: list[Client] = []

    @asynccontextmanager
    async def consumer(ctx: Context):
        clients.append(ctx.accept(CLIENT))
        yield

    def select(document: ConfigDocument) -> Composition:
        composition = build(document)
        entry = ContribEntry(
            name="remote-caller",
            definition=Contrib(accepts=[CLIENT], lifespan=consumer),
        )
        return composition.model_copy(
            update={"entries": (*composition.entries, entry), "roots": (entry.name,)}
        )

    async def add() -> list[Operation]:
        """Add the example with its file entry, then read the operation until it
        finishes."""
        added = Operation.model_validate(
            await clients[0].call(
                "contrib-manager",
                "add",
                "example",
                enable="example-file",
                config={"path": str(journal), "label": "remote"},
            )
        )
        reports: list[Operation] = []
        while True:
            reports.append(
                Operation.model_validate(
                    await clients[0].call("contrib-manager", "operation", added.id)
                )
            )
            if reports[-1].phase in FINISHED:
                return reports
            await asyncio.sleep(0.1)

    bcn = Path(os.environ["UV_TOOL_BIN_DIR"]) / (
        "bcn.exe" if os.name == "nt" else "bcn"
    )
    # Not live_smoke's node, which waits on its standard input: on Windows the
    # uv it starts inherits that input and stalls while the read is pending.
    process = await asyncio.create_subprocess_exec(
        str(bcn),
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
        async with node(configer_options=(str(config),), start=select):
            reports = await add()
            assert reports[0].phase not in FINISHED, reports[0].model_dump_json(
                indent=2
            )
            assert reports[-1].phase == "complete", reports[-1].model_dump_json(
                indent=2
            )
            assert "started:remote" in await asyncio.to_thread(journal.read_text)
            # The package's remote is served as soon as it is added.
            assert await clients[0].call("example", "name") == journal.name
            # Adding the package again completes with its entry enabled once.
            again = await add()
            assert again[-1].phase == "complete", again[-1].model_dump_json(indent=2)
            document = ConfigDocument.model_validate(
                tomllib.loads(await asyncio.to_thread(config.read_text))
            )
            assert [
                entry.entry
                for package in document.contribs
                for entry in package.enabled
            ].count("example-file") == 1
        # SIGTERM ends the node as Ctrl+C would; Windows has no such
        # signal, so there the process is ended.
        if os.name == "nt":
            process.terminate()
        else:
            process.send_signal(signal.SIGTERM)
        output, _ = await process.communicate()
        if os.name != "nt":
            assert process.returncode == 0, output.decode()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


if __name__ == "__main__":
    asyncio.run(exercise(Path(sys.argv[1]), sys.argv[2]))
    print("Remote manager workflow passed")
