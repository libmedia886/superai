"""Exercise installed configuration commands and real pending conversations."""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import signal
import sqlite3
import sys
import tomllib
from contextlib import AsyncExitStack, asynccontextmanager, closing
from importlib.resources import files
from pathlib import Path
from typing import Any, cast

import tomli_w
from bazaar_compute_node.boot import build, defaults, node
from bazaar_contrib_config import ConfigDocument
from bazaar_contrib_harness import HarnessInspection
from bazaar_contrib_sidecar import CLIENT, Client, RemoteError
from bazaar_core import (
    Composition,
    Context,
    Contrib,
    ContribEntry,
)
from blockbuster import blockbuster_ctx
from packaging.requirements import Requirement
from pydantic import JsonValue

from bazaar_contrib_agent.command.management import (
    AgentView,
    Directory,
    File,
    Listing,
    Providers,
)


async def exercise(path: Path, source: str, tests: Path):
    config = path / "config.toml"
    workspaces = path / ".bcn" / "workspaces"
    os.environ["EDITOR_SOURCE"] = "Weekend editor"

    async def cli(*arguments: str):
        await asyncio.to_thread(print, "bcn --config", config, *arguments, flush=True)
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "bazaar_compute_node",
            "--config",
            str(config),
            *arguments,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            output, errors = await process.communicate()
            await asyncio.to_thread(
                print, (output + errors).decode(), end="", flush=True
            )
            assert process.returncode == 0, (output + errors).decode()
            if "--help" not in arguments and (
                arguments[:2]
                in (
                    ("agent", "add"),
                    ("agent", "edit"),
                    ("agent", "remove"),
                )
                or arguments[:3]
                in (
                    ("agent", "review", "approve"),
                    ("agent", "review", "deny"),
                )
            ):
                assert not output, output.decode()
                assert errors.strip()
            return output.decode()
        finally:
            if process.returncode is None:
                process.terminate()
                await process.wait()

    async def document():
        return tomllib.loads(await asyncio.to_thread(config.read_text))

    async def agents():
        payload = await document()
        return next(
            entry["config"]["agents"]
            for package in payload["contribs"]
            for entry in package["enabled"]
            if entry["entry"] == "agent"
        )

    payload = await asyncio.to_thread(defaults)
    official = json.loads(
        await asyncio.to_thread(
            files("bazaar_contrib_manager").joinpath("catalog.json").read_text
        )
    )
    packages = {entry["package"] for entry in official["contribs"]}
    for package in payload["contribs"]:
        package["source"] = (
            source
            if Requirement(package["package"]).name in packages
            else "https://pypi.org/simple"
        )
        for entry in package["enabled"]:
            if entry["entry"] == "contrib-manager":
                entry["config"] = {"host_source": source}
    await asyncio.to_thread(config.write_text, tomli_w.dumps(payload))
    await cli("contrib", "configured")
    payload = await document()
    index = next(
        index
        for index, entry in enumerate(
            entry for package in payload["contribs"] for entry in package["enabled"]
        )
        if entry["entry"] == "contrib-manager"
    )
    await cli("contrib", "edit", str(index), "--option", f"host_source={source}")
    # The default composition already offers the agent commands.
    assert "No agents" in await cli("agent", "list")
    await cli(
        "contrib",
        "add",
        "bcn-agent-workbench",
        "--source",
        source,
        "--enable",
        "test-channel-builder",
    )
    await cli("contrib", "enable", "bcn-agent-workbench", "--entry", "document-builder")
    await cli(
        "contrib",
        "enable",
        "bcn-agent-workbench",
        "--entry",
        "secondary-document-builder",
    )
    await cli(
        "contrib",
        "enable",
        "bcn-agent-workbench",
        "--entry",
        "secondary-channel-builder",
    )
    await cli("contrib", "add", "bcn-agent-journal", "--source", source)
    for command in (
        ("agent",),
        ("agent", "list"),
        ("agent", "add"),
        ("agent", "edit"),
        ("agent", "remove"),
        ("agent", "review"),
        ("agent", "review", "list"),
        ("agent", "review", "approve"),
        ("agent", "review", "deny"),
    ):
        output = await cli(*command, "--help")
        await asyncio.to_thread(
            (path / f"{'-'.join(command)}-help.txt").write_text, output
        )
    await asyncio.to_thread(print, "Installed and enabled real providers", flush=True)

    for name, mode in (("Cloud", "session"), ("Tifa", "dangerous_individual")):
        providers = (
            (
                "--channel",
                "test-channel-secondary",
                "--set",
                "channel.1.endpoint_file=secondary.json",
            )
            if name == "Cloud"
            else ()
        )
        await cli(
            "agent",
            "add",
            "--name",
            name,
            "--channel",
            "test-channel",
            *providers,
            "--harness",
            "document",
            "--set",
            f"agent.mode={mode}",
            "--set",
            f"harness.title={name} editorial report",
            "--set",
            "harness.env=EDITOR_NAME=EDITOR_SOURCE",
        )
    initial = await agents()
    cloud, tifa = initial
    await cli(
        "agent",
        "edit",
        cloud["id"],
        "--name",
        "Cloud desk",
        "--channel",
        "test-channel-secondary",
        "--channel",
        "test-channel",
        "--set",
        "agent.idle_timeout=30",
        "--set",
        "agent.session.config.sandbox.policy=workspace-write",
        "--set",
        "harness.publication_delay=0.01",
    )
    updated = await agents()
    assert (
        updated[0]["id"] == cloud["id"]
        and updated[0]["harness"][0]["title"] == cloud["harness"][0]["title"]
    )
    assert updated[0]["channel"] == cloud["channel"][::-1] and updated[1] == tifa
    assert updated[0]["harness"][0]["publication_delay"] == 0.01
    assert updated[0]["harness"][0]["env"] == {"EDITOR_NAME": "EDITOR_SOURCE"}
    listing = await cli("agent", "list")
    assert "Cloud desk" in listing and "Tifa" in listing
    assert "offline" in listing
    assert not await asyncio.to_thread((workspaces / cloud["id"]).exists)
    assert not await asyncio.to_thread((workspaces / tifa["id"]).exists)
    await asyncio.to_thread(
        print,
        "Offline add/list/edit preserved identity and provider settings",
        flush=True,
    )

    from bazaar_contrib_channel import ChannelTarget, SenderIdentity

    sys.path.insert(0, str(tests))
    provider = await asyncio.to_thread(importlib.import_module, "provider_smoke")
    Peer, finish, ChannelMessage = (
        provider.Peer,
        provider.finish,
        provider.InboundMessage,
    )

    endpoint = str(path / ".bcn" / "sidecar.sock")
    if os.name == "nt":
        payload = await document()
        endpoint = rf"\\.\pipe\bcn-task17-{cloud['id']}"
        for package in payload["contribs"]:
            for entry in package["enabled"]:
                if entry["entry"] == "sidecar-windows":
                    entry["config"] = {"endpoint": endpoint}
        await asyncio.to_thread(config.write_text, tomli_w.dumps(payload))

    os.environ["BCN_ENDPOINT"] = endpoint

    @asynccontextmanager
    async def control():
        clients: list[Client] = []

        @asynccontextmanager
        async def consumer(ctx: Context):
            clients.append(ctx.accept(CLIENT))
            yield

        def select(document: ConfigDocument) -> Composition:
            composition = build(document)
            entry = ContribEntry(
                name="review-control",
                definition=Contrib(accepts=[CLIENT], lifespan=consumer),
            )
            return composition.model_copy(
                update={
                    "entries": (*composition.entries, entry),
                    "roots": (entry.name,),
                }
            )

        async with node(configer_options=(str(config),), start=select):
            yield clients[0]

    def select(query: str, *args: object) -> list[dict[str, Any]]:
        database = path / ".bcn" / "bcn.sqlite3"
        with closing(
            sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
        ) as connection:
            connection.row_factory = sqlite3.Row
            return [dict(row) for row in connection.execute(query, args)]

    async def contacts(owner: str, state: str | None = None) -> list[dict[str, Any]]:
        return await asyncio.to_thread(
            select,
            "SELECT thread.id AS thread_id, session.review AS review "
            "FROM threads AS thread JOIN channel_sessions AS session "
            "ON session.id = thread.channel_session_id "
            "WHERE session.agent_id = ? AND (? IS NULL OR session.review = ?) "
            "ORDER BY thread.created_at_ms",
            owner,
            state,
            state,
        )

    async def notifies_runtime(message_id: str) -> int | None:
        found = await asyncio.to_thread(
            select,
            "SELECT notifies_runtime FROM messages WHERE provider_message_id = ?",
            message_id,
        )
        return found[0]["notifies_runtime"] if found else None

    async def restarted(agent_id: str, before: int) -> None:
        endpoint = workspaces / agent_id / "channel.json"
        while True:
            if (await asyncio.to_thread(endpoint.stat)).st_mtime_ns != before:
                return
            await asyncio.sleep(0.01)

    async def pending(owner: str):
        while True:
            rows = await contacts(owner, "pending")
            if rows:
                return rows[-1]
            await asyncio.sleep(0.01)

    @asynccontextmanager
    async def running():
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            str(Path(__file__).with_name("management_node.py")),
            str(config),
            *(item["name"] for item in await agents()),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            assert process.stdout is not None
            if (await process.stdout.readline()).rstrip(b"\r\n") != b"ready":
                _, errors = await process.communicate()
                raise RuntimeError(errors.decode())
            yield process
        finally:
            if process.returncode is None:
                assert process.stdin is not None
                process.stdin.write(b"stop\n")
                await process.stdin.drain()
            _, errors = await process.communicate()
            assert process.returncode == 0, errors.decode()

    async def connect(agent_id: str):
        address = json.loads(
            await asyncio.to_thread((workspaces / agent_id / "channel.json").read_text)
        )
        reader, writer = await asyncio.open_connection("127.0.0.1", address["port"])
        return Peer(reader, writer)

    request = ChannelMessage(
        id="weekend-original",
        target=ChannelTarget(kind="group", thread_id="weekend-edition"),
        sender=SenderIdentity(id="editor", name="Editor", kind="human"),
        body="The weekend edition is nearly ready. Could you prepare a short word-count report for the editor?",
        mentions_agent=True,
    )
    async with running(), AsyncExitStack() as stack:
        peer = await connect(cloud["id"])
        stack.push_async_callback(peer.aclose)
        assert [item["id"] for item in await agents()] == [cloud["id"], tifa["id"]]
        assert "running" in await cli("agent", "list")
        await peer.write({"inbound": request.model_dump(mode="json")})
        row = await pending(cloud["id"])
        assert row["thread_id"] in await cli("agent", "review", "list", cloud["id"])
        assert not await contacts(tifa["id"], "pending")
    await asyncio.to_thread(
        print, "Pending request persisted before node restart", flush=True
    )

    async with running(), AsyncExitStack() as stack:
        cloud_peer = await connect(cloud["id"])
        tifa_peer = await connect(tifa["id"])
        tifa_peer.automatic = True
        stack.push_async_callback(cloud_peer.aclose)
        stack.push_async_callback(tifa_peer.aclose)
        assert row["thread_id"] in await cli("agent", "review", "list", cloud["id"])
        await cli("agent", "review", "approve", row["thread_id"])
        report = await finish(cloud_peer)
        data = json.loads(await asyncio.to_thread(report.read_text))
        assert request.body in data["inbox"] and data["words"] > 0
        assert data["editor"] == "Weekend editor"
        assert data["context"]["actor_id"] == row["thread_id"]
        assert (await contacts(cloud["id"]))[0]["review"] == "approved"
        await asyncio.to_thread(
            print, "CLI approval after restart resumes the original request", flush=True
        )

        shared = request.model_copy(
            update={
                "id": "shared-original",
                "body": "I need a short summary of this draft before the shared editorial desk closes.",
            }
        )
        await tifa_peer.write({"inbound": shared.model_dump(mode="json")})
        shared_row = await pending(tifa["id"])
        async with control() as client:
            await client.call(
                "collaboration", "review_contact", shared_row["thread_id"], "approved"
            )
        shared_report = await finish(tifa_peer)
        data = json.loads(await asyncio.to_thread(shared_report.read_text))
        assert (
            shared.body in data["inbox"] and data["context"]["actor_id"] == tifa["id"]
        )
        await asyncio.to_thread(
            print,
            "Public approval resumes the original request in shared Agent mode",
            flush=True,
        )

        denied = request.model_copy(
            update={
                "id": "denied-original",
                "target": ChannelTarget(kind="group", thread_id="guest-edition"),
                "body": "Could you review the guest edition before I hand it to the editor?",
            }
        )
        await cloud_peer.write({"inbound": denied.model_dump(mode="json")})
        denied_row = await pending(cloud["id"])
        await cli("agent", "review", "deny", denied_row["thread_id"])
        assert any(
            item["thread_id"] == denied_row["thread_id"]
            for item in await contacts(cloud["id"], "denied")
        )
        again = denied.model_copy(
            update={
                "id": "guest-followup",
                "body": "The guest edition has been revised. Could you prepare the editorial report now?",
            }
        )
        await cloud_peer.write({"inbound": again.model_dump(mode="json")})
        await pending(cloud["id"])
        quiet = again.model_copy(
            update={
                "id": "guest-quoted-context",
                "body": "The editor's earlier note is included here as background for the revised edition.",
                "notifies_runtime": False,
            }
        )
        await cloud_peer.write({"inbound": quiet.model_dump(mode="json")})
        while True:
            if await notifies_runtime(quiet.id) is not None:
                break
            await asyncio.sleep(0.01)
        await cli("agent", "review", "approve", denied_row["thread_id"])
        assert not await notifies_runtime(quiet.id)
        renewed = await finish(cloud_peer)
        assert (
            again.body
            in json.loads(await asyncio.to_thread(renewed.read_text))["inbox"]
        )
        for saved in (report, renewed):
            while True:
                if await asyncio.to_thread(saved.with_suffix(".published.json").exists):
                    break
                await asyncio.sleep(0.01)

    @asynccontextmanager
    async def serving():
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "bazaar_compute_node",
            "--config",
            str(config),
            "run",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdout is not None and process.stderr is not None
        errors = asyncio.create_task(process.stderr.read())
        try:
            while (line := await process.stdout.readline()).rstrip(
                b"\r\n"
            ) != b"bcn ready":
                assert line, (await errors).decode()
            output = asyncio.create_task(process.stdout.read())
            try:
                yield
            finally:
                if process.returncode is None:
                    if os.name == "nt":
                        process.terminate()
                    else:
                        process.send_signal(signal.SIGTERM)
                await process.wait()
                await output
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
            failure = (await errors).decode()
            if os.name != "nt":
                assert process.returncode == 0, failure

    # A server manages agents through the same service as bcn agent, over the
    # running node's sidecar; credentials go in and never come back.
    async with serving(), control() as client:

        async def call(method: str, *args: object) -> JsonValue:
            return await client.call("agent-configuration", method, *args)

        providers = Providers.model_validate(await call("providers"))
        schemas = {
            (label, item.kind): cast(
                dict[str, dict[str, JsonValue]], item.json_schema["properties"]
            )
            for label, items in (
                ("channel", providers.channel),
                ("harness", providers.harness),
            )
            for item in items
        }
        assert schemas["channel", "test-channel"]["token"]["writeOnly"]
        assert schemas["harness", "document"]["api_key"]["writeOnly"]
        assert ("harness", "document-secondary") in schemas
        added = AgentView.model_validate(
            await call(
                "add",
                {
                    "name": "Remote desk",
                    "channel": [{"kind": "test-channel", "token": "channel-secret"}],
                    "harness": [
                        {
                            "kind": "document",
                            "title": "Remote report",
                            "api_key": "key-a",
                        },
                        {
                            "kind": "document-secondary",
                            "title": "Backup report",
                            "api_key": "key-b",
                        },
                    ],
                },
            )
        )
        remote = added.id
        listed = await call("list")
        listing = Listing.model_validate(listed)
        view = next(item for item in listing.agents if item.id == remote)
        assert "token" in view.channel[0].secrets
        assert "token" not in view.channel[0].values
        assert [item.connection for item in view.harness] == [
            "document:0",
            "document-secondary:0",
        ]
        assert all(
            secret not in json.dumps(listed)
            for secret in ("channel-secret", "key-a", "key-b")
        )
        await client.call(
            "agent-configuration",
            "edit",
            remote,
            {
                "channel": [
                    {
                        "kind": "test-channel",
                        "connection": "test-channel:0",
                        "token": None,
                    }
                ],
                "harness": [
                    {
                        "kind": "document-secondary",
                        "connection": "document-secondary:0",
                        "title": "Backup report",
                    },
                    {
                        "kind": "document",
                        "connection": "document:0",
                        "title": "Remote report",
                    },
                ],
            },
            expected_revision=listing.revision,
        )
        saved = next(item for item in await agents() if item["id"] == remote)
        assert "token" not in saved["channel"][0]
        assert [(item["kind"], item["api_key"]) for item in saved["harness"]] == [
            ("document-secondary", "key-b"),
            ("document", "key-a"),
        ]
        inspected = HarnessInspection.model_validate(
            await call("inspect", "document", remote)
        )
        assert f"workspaces{os.sep}{remote}" in inspected.skills[0].description
        drafted = HarnessInspection.model_validate(await call("inspect", "document"))
        scratch = drafted.skills[0].description.split(" in ", 1)[1].rsplit(" and ", 1)
        assert not await asyncio.to_thread(Path(scratch[0]).exists)

        root = Path(Directory.model_validate(await call("workspace", remote)).root)
        assert root.is_absolute()
        await asyncio.to_thread((root / "chapters").mkdir)
        for number in range(60):
            await asyncio.to_thread(
                (root / f"note-{number:02}.md").write_text, f"Note {number}"
            )
        await asyncio.to_thread((root / "cover.bin").write_bytes, bytes(range(256)))
        if os.name != "nt":
            await asyncio.to_thread((root / "outside").symlink_to, path)
        first = Directory.model_validate(await call("workspace", remote))
        rest = Directory.model_validate(
            await call("workspace", remote, "", first.total - 12)
        )
        names = {item.name for item in (*first.entries, *rest.entries)}
        directories = [item.directory for item in first.entries]
        assert directories == sorted(directories, reverse=True)
        assert any(item.name == "chapters" and item.directory for item in first.entries)
        assert {"note-00.md", "note-59.md", "cover.bin"} <= names
        assert "outside" not in names
        assert len(first.entries) < first.total
        note = File.model_validate(await call("read", remote, "note-07.md"))
        assert note.content == "Note 7"
        cover = File.model_validate(await call("read", remote, "cover.bin"))
        assert cover.content is None and cover.size
        for method, argument in (("workspace", ".."), ("read", "../config.toml")):
            try:
                await call(method, remote, argument)
            except RemoteError:
                pass
            else:
                raise AssertionError(f"{method} reached outside the workspace")
        removed = AgentView.model_validate(await call("remove", remote))
        assert removed.id == remote
        assert all(item["id"] != remote for item in await agents())
        assert await asyncio.to_thread(root.is_dir)
    await asyncio.to_thread(
        print,
        "The agent-configuration remote masks, keeps and browses as a server needs",
        flush=True,
    )

    async with running(), AsyncExitStack() as stack:
        assert all(item["review"] == "approved" for item in await contacts(cloud["id"]))
        await cli(
            "agent",
            "add",
            "--name",
            "Live desk",
            "--channel",
            "test-channel",
            "--harness",
            "document",
        )
        live = (await agents())[-1]
        endpoint = workspaces / live["id"] / "channel.json"
        while True:
            if await asyncio.to_thread(endpoint.exists):
                break
            await asyncio.sleep(0.01)
        before = (await asyncio.to_thread(endpoint.stat)).st_mtime_ns
        await cli(
            "agent",
            "edit",
            live["id"],
            "--name",
            "Updated live desk",
            "--set",
            "harness.title=Updated live report",
            "--set",
            "agent.session.config.sandbox.policy=danger-full-access",
        )
        await restarted(live["id"], before)
        peer = await connect(live["id"])
        peer.automatic = True
        stack.push_async_callback(peer.aclose)
        message = request.model_copy(
            update={
                "id": "live-edition",
                "body": "The live desk has the revised draft. Could you prepare its editorial report?",
            }
        )
        await peer.write({"inbound": message.model_dump(mode="json")})
        live_row = await pending(live["id"])
        await cli("agent", "review", "approve", live_row["thread_id"])
        saved = await finish(peer)
        report = json.loads(await asyncio.to_thread(saved.read_text))
        assert report["title"] == "Updated live report"
        assert message.body in report["inbox"]
        await cli("agent", "remove", live["id"])
        assert all(item["id"] != live["id"] for item in await agents())
        assert await asyncio.to_thread((workspaces / live["id"]).is_dir)
        await asyncio.to_thread(
            print,
            "Live CLI add/edit/remove apply without restarting the node",
            flush=True,
        )
    await asyncio.to_thread(
        print,
        "Denied conversations follow the existing admission and persistence rules",
        flush=True,
    )

    await cli("agent", "remove", cloud["id"])
    assert await asyncio.to_thread((workspaces / cloud["id"]).is_dir)
    assert [item["id"] for item in await agents()] == [tifa["id"]]
    await cli("agent", "remove", "Tifa")
    assert not await agents()

    if os.name != "nt":
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "bazaar_compute_node",
            "--config",
            str(config),
            "run",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            assert process.stdout is not None
            while (line := await process.stdout.readline()) != b"bcn ready\n":
                assert line, "bcn run ended before it was ready"
        finally:
            if process.returncode is None:
                process.send_signal(signal.SIGTERM)
            _, errors = await process.communicate()
            assert process.returncode == 0, errors.decode()
    await asyncio.to_thread(print, "Agent management workflow passed", flush=True)


if __name__ == "__main__":
    with blockbuster_ctx():
        asyncio.run(exercise(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])))
