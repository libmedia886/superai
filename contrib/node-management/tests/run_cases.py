"""Exercise configured run commands and graceful exit in real node processes."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TypedDict
lazy import asyncio
lazy import json
lazy import os
lazy import signal
lazy import sys
lazy import threading
lazy import time
lazy from functools import partial
lazy from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
lazy from importlib.metadata import version
lazy from pathlib import Path

import pytest
import tomli_w
lazy from bazaar_compute_node.boot import build, defaults, node
lazy from bazaar_contrib_audit import AUDIT_EVENT, AuditEvent, AuditFailure
lazy from bazaar_contrib_config import ConfigDocument
lazy from bazaar_contrib_manager import CONTRIB_CATALOG, ContribCatalog
lazy from bazaar_contrib_sidecar import CLIENT, Client, RemoteError
lazy from bazaar_core import Composition, Context, Contrib, ContribEntry
lazy from packaging.version import Version
lazy from pydantic import TypeAdapter


class Usage(TypedDict):
    total: int
    used: int


class Disk(Usage):
    mount: str


class Processor(TypedDict):
    cores: int
    percent: float


class Host(TypedDict):
    version: str
    name: str
    machine: str
    started_ms: int
    cpu: Processor
    memory: Usage
    disks: list[Disk]


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX process signals")
@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGTERM])
async def test_run_uses_selected_configuration_and_exits(tmp_path: Path, sig: int):
    log = tmp_path / "selected-logs" / "node.jsonl"
    configured = tmp_path / (
        "selected.toml" if sig == signal.SIGTERM else "options with spaces.toml"
    )
    payload = await asyncio.to_thread(defaults)
    for package in payload["contribs"]:
        for entry in package["enabled"]:
            if entry["entry"] == "logging":
                entry["config"] = {"path": str(log)}
    await asyncio.to_thread(configured.write_text, tomli_w.dumps(payload))
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "bazaar_compute_node",
        "--configer-options",
        str(tmp_path / ("ignored.toml" if sig == signal.SIGTERM else configured.name)),
        "run",
        # 0.2's supervisor names the configuration after the command.
        *(["--config", str(configured)] if sig == signal.SIGTERM else []),
        cwd=tmp_path,
        env=dict(os.environ) | {"BCN_HOME": str(tmp_path / "node")},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        assert process.stdout is not None
        report = b""
        while b"bcn ready" not in report:
            line = await process.stdout.readline()
            if not line:
                _, errors = await process.communicate()
                raise AssertionError(errors.decode())
            report += line
        assert b"node-health" in report and b"running" in report
        process.send_signal(sig)
        _, errors = await process.communicate()
        if sig == signal.SIGINT:
            assert process.returncode != 0, errors.decode()
        else:
            assert process.returncode == 0, errors.decode()
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert await asyncio.to_thread(log.parent.is_dir)


async def test_node_service_reports_the_node_and_its_machine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("BCN_HOME", str(tmp_path / "node"))
    configured = tmp_path / "node.toml"
    await asyncio.to_thread(
        configured.write_text, tomli_w.dumps(await asyncio.to_thread(defaults))
    )
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "bazaar_compute_node",
        "--config",
        str(configured),
        "run",
        cwd=tmp_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        assert process.stdout is not None
        while b"bcn ready" not in (line := await process.stdout.readline()):
            if not line:
                _, errors = await process.communicate()
                raise AssertionError(errors.decode())
        clients: list[Client] = []

        @asynccontextmanager
        async def consumer(ctx: Context):
            clients.append(ctx.accept(CLIENT))
            yield

        def select(document: ConfigDocument) -> Composition:
            composition = build(document)
            entry = ContribEntry(
                name="node-control",
                definition=Contrib(accepts=[CLIENT], lifespan=consumer),
            )
            return composition.model_copy(
                update={
                    "entries": (*composition.entries, entry),
                    "roots": (entry.name,),
                }
            )

        async with node(configer_options=(str(configured),), start=select):
            current = await asyncio.to_thread(version, "bazaar-compute")
            assert await clients[0].call("node", "version") == current
            available = await clients[0].call("node", "available")
            assert available is None or Version(str(available)) > Version(current)
            info = TypeAdapter(Host).validate_python(
                await clients[0].call("node", "info")
            )
            assert info["version"] == current
            assert info["name"] and info["machine"]
            assert info["started_ms"] <= time.time() * 1000
            assert info["cpu"]["cores"] >= 1
            assert 0 <= info["cpu"]["percent"] <= 100
            assert 0 < info["memory"]["used"] <= info["memory"]["total"]
            assert info["disks"]
            assert all(0 <= disk["used"] <= disk["total"] for disk in info["disks"])
            with pytest.raises(RemoteError, match="uv tool installation"):
                await clients[0].call("node", "install", current, timeout=None)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_node_audits_an_index_each_time_it_starts_failing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("BCN_HOME", str(tmp_path / "node"))
    published = tmp_path / "published"

    def serve() -> tuple[ThreadingHTTPServer, threading.Thread]:
        published.mkdir()
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            partial(SimpleHTTPRequestHandler, directory=str(published)),
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread

    server, thread = await asyncio.to_thread(serve)
    location = f"http://127.0.0.1:{server.server_port}/index.json"
    configured = tmp_path / "node.toml"
    payload = await asyncio.to_thread(defaults)
    payload["contrib_indexes"] = [location]
    await asyncio.to_thread(configured.write_text, tomli_w.dumps(payload))
    catalogs: list[ContribCatalog] = []
    failures: asyncio.Queue[AuditFailure] = asyncio.Queue()

    @asynccontextmanager
    async def observe(ctx: Context):
        catalogs.append(ctx.accept(CONTRIB_CATALOG))
        yield

    def audited(ctx: Context, event: AuditEvent) -> None:
        if (
            isinstance(event, AuditFailure)
            and event.event_name == "contrib.index.refresh_failed"
        ):
            failures.put_nowait(event)

    def select(document: ConfigDocument) -> Composition:
        composition = build(document)
        entry = ContribEntry(
            name="index-observer",
            definition=Contrib(
                accepts=[CONTRIB_CATALOG],
                lifespan=observe,
                listen={AUDIT_EVENT: audited},
            ),
        )
        return composition.model_copy(
            update={
                "entries": (*composition.entries, entry),
                "roots": (entry.name, "node-health"),
            }
        )

    index = published / "index.json"
    try:
        async with node(configer_options=(str(configured),), start=select):
            (missing,) = await catalogs[0].refresh()
            # It keeps failing, now for another reason, then reads again.
            await asyncio.to_thread(index.write_text, "{")
            await catalogs[0].refresh()
            await asyncio.to_thread(index.write_text, json.dumps({"contribs": []}))
            await catalogs[0].refresh()
            await asyncio.to_thread(index.unlink)
            (removed,) = await catalogs[0].refresh()
            async with asyncio.timeout(60):
                first = await failures.get()
                second = await failures.get()
    finally:
        await asyncio.to_thread(server.shutdown)
        await asyncio.to_thread(server.server_close)
        await asyncio.to_thread(thread.join)
    for event, status in ((first, missing), (second, removed)):
        assert isinstance(event.payload, dict)
        assert event.payload.get("location") == location
        assert event.error.message == status.error
