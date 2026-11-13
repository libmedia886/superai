from __future__ import annotations

from collections.abc import Sequence

import click

from ... import __version__
from ...core.paths import resolve_data_dir
from ...i18n import Translator, create_translator
from ._options import node_options, remember
from .agent import build_agent_group
from .node import build_node_commands
from .server import build_server_group
from .service import build_service_group


def build_cli(translator: Translator) -> click.Group:
    """Build the command tree in the language this invocation speaks."""

    @click.group(
        "superai",
        help=translator.text(
            "cli.superai.description",
            {"data_dir": resolve_data_dir()},
        ),
        context_settings={"help_option_names": ["-h", "--help"]},
    )
    @click.version_option(
        __version__, "--version", prog_name="superai", message="%(prog)s %(version)s"
    )
    @node_options(translator)
    @click.pass_context
    def superai(context: click.Context, **values: object) -> None:
        # a setting may be given at any level, so each group remembers what it
        # saw and each command falls back to the nearest one above it
        remember(context, **values)

    for command in build_node_commands(translator):
        superai.add_command(command)
    superai.add_command(build_agent_group(translator))
    superai.add_command(build_server_group(translator))
    superai.add_command(build_service_group(translator))
    return superai


def main(argv: Sequence[str] | None = None) -> int:
    cli = build_cli(create_translator(None))
    try:
        cli.main(
            args=list(argv) if argv is not None else None,
            prog_name="superai",
            standalone_mode=False,
        )
    except SystemExit as exit_error:
        return int(exit_error.code or 0)
    except click.exceptions.NoArgsIsHelpError as error:
        # asking for nothing is a question, not a mistake, so the help it
        # answers with belongs on stdout -- and it is the help of whichever
        # group was asked, not always the root's
        context = error.ctx or click.Context(cli, info_name="superai")
        click.echo(context.get_help())
        return 0
    except click.ClickException as error:
        # a misuse ends the process the way argparse always has
        error.show()
        raise SystemExit(error.exit_code) from None
    except click.Abort:
        return 1
    return 0


__all__ = ["build_cli", "main"]
