"""Read indexes without waiting on their hosts, and refresh the online ones."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import tomllib
from pathlib import Path
from typing import Any

import tomli_w
from blockbuster import blockbuster_ctx
from installed_smoke import invoke
from live_smoke import configure


async def exercise(path: Path, source: str, other: str) -> None:
    config = path / "indexes.toml"
    await configure(config, source)
    options: dict[str, Any] = {"configer_options": (str(config),)}

    async def cli(*arguments: str) -> str:
        await asyncio.to_thread(
            print, "bcn --config", config, "contrib", *arguments, flush=True
        )
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "bazaar_compute_node",
            "--config",
            str(config),
            "contrib",
            *arguments,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        output, errors = await process.communicate()
        await asyncio.to_thread(print, (output + errors).decode(), end="", flush=True)
        assert process.returncode == 0, (output + errors).decode()
        return output.decode()

    async def subscribe(*locations: str) -> None:
        """Keep the built-in index beside the given ones, as an operator edits the file."""
        payload = tomllib.loads(await asyncio.to_thread(config.read_text))
        payload["contrib_indexes"] = [
            "resource://bazaar_contrib_manager/catalog.json",
            *locations,
        ]
        await asyncio.to_thread(config.write_text, tomli_w.dumps(payload))

    async def publish(name: str, package: str, package_source: str) -> str:
        """Serve an index from the local registry, returning where it is read."""
        await asyncio.to_thread(
            (path / "registry" / name).write_text,
            json.dumps({"contribs": [{"package": package, "source": package_source}]}),
        )
        return source.replace("one/simple/", name)

    connections: list[asyncio.StreamWriter] = []

    async def hold(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        connections.append(writer)
        await reader.read()

    closed = await asyncio.start_server(hold, "127.0.0.1", 0)
    unreachable = f"http://127.0.0.1:{closed.sockets[0].getsockname()[1]}/index.json"
    closed.close()
    await closed.wait_closed()
    async with await asyncio.start_server(hold, "127.0.0.1", 0) as silent:
        unanswered = f"http://127.0.0.1:{silent.sockets[0].getsockname()[1]}/index.json"
        await subscribe(unreachable, unanswered)
        indexes = await invoke(options, lambda manager: manager.catalog.indexes())
        assert any(index.entries for index in indexes)
        assert not any(
            index.entries or index.error
            for index in indexes
            if index.location in (unreachable, unanswered)
        )
        selected = await invoke(
            options, lambda manager: manager.catalog.select("node-management")
        )
        assert selected.package == "bazaar-contrib-node-management"
        listed = await cli("index", "list")
        assert unreachable in listed and unanswered in listed
        assert "bazaar-contrib-node-management" in await cli("entries")
        assert not connections

    online = await publish("one/online.json", "bazaar-contrib-example", source)
    await subscribe(unreachable, online)
    refreshed = await invoke(options, lambda manager: manager.catalog.refresh())
    assert any(
        index.location == online and index.entries and not index.error
        for index in refreshed
    )
    entries = await invoke(options, lambda manager: manager.catalog.entries())
    assert any(
        entry.package == "bazaar-contrib-example" and online in entry.indexes
        for entry in entries
    )
    selected = await invoke(options, lambda manager: manager.catalog.select("example"))
    assert selected.source == source

    async def truncate(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        await reader.readuntil(b"\r\n\r\n")
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n{"contribs"')
        await writer.drain()
        writer.close()

    # A host that cuts its response short fails only its own index.
    async with await asyncio.start_server(truncate, "127.0.0.1", 0) as cut:
        truncated = f"http://127.0.0.1:{cut.sockets[0].getsockname()[1]}/index.json"
        await subscribe(online, truncated)
        refreshed = await invoke(options, lambda manager: manager.catalog.refresh())
        assert any(index.location == truncated and index.error for index in refreshed)
        assert any(index.location == online and index.entries for index in refreshed)
    await subscribe(unreachable, online)

    # The index host stops serving the file; what it served before stays usable.
    await asyncio.to_thread((path / "registry" / "one" / "online.json").unlink)
    failed = await invoke(options, lambda manager: manager.catalog.refresh())
    assert any(index.location == online and index.entries for index in failed)
    listed = await cli("index", "list")
    assert all(index.error and index.error in listed for index in failed)
    selected = await invoke(options, lambda manager: manager.catalog.select("example"))
    assert selected.source == source

    added = await publish("two/added.json", "bazaar-contrib-example", other)
    await cli("index", "add", added)
    assert other in await cli("entries")
    refreshed = await cli("index", "refresh")
    assert added in refreshed and online in refreshed

    # A node reads an index it has not read before as soon as it starts.
    startup = await publish(
        "one/startup.json", "bazaar-contrib-example-support", source
    )
    payload = tomllib.loads(await asyncio.to_thread(config.read_text))
    payload["contrib_indexes"].append(startup)
    await asyncio.to_thread(config.write_text, tomli_w.dumps(payload))

    async def read() -> bool:
        indexes = await invoke(options, lambda manager: manager.catalog.indexes())
        return any(index.location == startup and index.entries for index in indexes)

    assert not await read()
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "bazaar_compute_node",
        "--config",
        str(config),
        "run",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        assert process.stdout is not None
        report = b""
        while b"bcn ready" not in report:
            line = await process.stdout.readline()
            assert line, report.decode()
            report += line
        assert any(
            b"contrib-indexes" in line and b"running" in line
            for line in report.splitlines()
        )
        async with asyncio.timeout(60):
            while True:
                if await read():
                    break
                await asyncio.sleep(1)
        # SIGTERM ends the node as Ctrl+C would; Windows has no such
        # signal, so there the process is ended.
        if os.name == "nt":
            process.terminate()
        else:
            process.send_signal(signal.SIGTERM)
        output, _ = await process.communicate()
        if os.name != "nt":
            assert process.returncode == 0, (report + output).decode()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


if __name__ == "__main__":
    with blockbuster_ctx():
        asyncio.run(exercise(Path(sys.argv[1]), sys.argv[2], sys.argv[3]))
    print("Index workflow passed")
