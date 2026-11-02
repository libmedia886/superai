from __future__ import annotations

from collections.abc import Mapping
from types import SimpleNamespace
from typing import cast

import click
from bazaar_contrib_sidecar import RemoteError

from ..reminder._client import BccCommandError, ReminderClient, run
from ..rendering import TextTemplate

_UPGRADE = TextTemplate.from_resource("bcc/node/upgrade.tpl")
_VERSION = TextTemplate.from_resource("bcc/node/version.tpl")


@click.group(help="Operations on the node this session runs on")
def node() -> None: ...


@node.command(
    short_help="Install the newer bcn release and restart this node",
    help=(
        "Install the newer bcn release announced in the inbox notice, schedule a "
        "reminder so you can report the outcome once the node is back, and "
        "restart the node. Run it only after the user agrees to upgrade."
    ),
)
@click.option(
    "--message-id",
    required=True,
    metavar="<id>",
    help="Full uuid of the local inbound message the follow-up reminder anchors to.",
)
@click.pass_obj
@run
async def upgrade(obj: SimpleNamespace, message_id: str) -> None:
    installed = await obj.call("node", "version")
    version = await obj.call("node", "available")
    if version is None:
        raise BccCommandError(
            "No newer release has been announced for this node.",
            code="UPGRADE_NOT_AVAILABLE",
            next_action="Wait for the inbox notice to name one.",
        )
    try:
        await obj.call("node", "install", version)
    except RemoteError as error:
        if error.type == "UnsupportedUpgrade":
            raise BccCommandError(
                error.message,
                code="UPGRADE_UNSUPPORTED",
                next_action=(
                    "Tell the user to stop the node and run `uv tool install "
                    f"bazaar-compute-node=={version}`, or to run it as a system service."
                ),
            ) from error
        raise BccCommandError(
            error.message,
            code="UPGRADE_INSTALL_FAILED",
            next_action="Tell the user the node keeps running on the installed version.",
        ) from error
    # The release is installed, so a missing follow-up is no reason to keep running the old one.
    try:
        scheduled = await ReminderClient(obj.request).request(
            "reminder",
            "schedule",
            {
                "title": f"Report the outcome of upgrading to {version}",
                "delay_seconds": 60,
                "message_id": message_id,
            },
        )
    except BccCommandError:
        reminder_id = None
    else:
        reminder_id = cast(Mapping[str, object], scheduled["reminder"])["reminder_id"]
    await obj.call("node", "restart")
    click.echo(
        _UPGRADE.render(
            {
                "distribution": "bazaar-compute-node",
                "installed_version": installed,
                "upgrade_version": version,
                "reminder_id": reminder_id,
            }
        )
    )


@node.command(
    short_help="Report the version this node is running",
    help=(
        "Report the bcn version of the running node process, which is what "
        "an upgrade has to change to have taken effect."
    ),
)
@click.pass_obj
@run
async def version(obj: SimpleNamespace) -> None:
    click.echo(
        _VERSION.render(
            {
                "distribution": "bazaar-compute-node",
                "version": await obj.call("node", "version"),
            }
        )
    )


__all__ = ["node"]
