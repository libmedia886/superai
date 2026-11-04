from __future__ import annotations

from contextlib import asynccontextmanager
lazy import asyncio
lazy import signal
lazy import sys
lazy from collections.abc import Sequence

import click
from bazaar_contrib_config import CONFIGURATION, ConfigDocument, Configuration
from bazaar_contrib_invoke import (
    COMMANDS,
    RUN,
    CommandCatalog,
    CommandEntry,
    Commands,
    Run,
    contribs,
    table,
)
from bazaar_core import Composition, Context, Contrib, ContribEntry

lazy from .boot import build, node


async def serve(ctx: Context, configuration: Configuration, run: Run) -> None:
    loop = asyncio.get_running_loop()
    if sys.platform != "win32":
        loop.add_signal_handler(signal.SIGTERM, run.stopped.set)
    try:
        await configuration.activate()
        await asyncio.to_thread(
            click.echo,
            table(contribs(ctx.snapshots), ("Contrib", "State", "Result")),
        )
        await asyncio.to_thread(click.echo, "bcn ready")
        await run.stopped.wait()
    finally:
        if sys.platform != "win32":
            loop.remove_signal_handler(signal.SIGTERM)


@asynccontextmanager
async def lifespan(ctx: Context):
    commands = ctx.accept(COMMANDS)
    configuration = ctx.accept(CONFIGURATION)
    serving = ctx.accept(RUN)

    @click.command("run", help=command_entry.help, short_help=command_entry.help)
    def run():
        return serve(ctx, configuration, serving)

    with commands.register(run):
        yield


command_entry = CommandEntry(
    contrib="run", help="Run the node, serving until it is stopped."
)
running = ContribEntry(
    name=command_entry.contrib,
    definition=Contrib(accepts=[COMMANDS, CONFIGURATION, RUN], lifespan=lifespan),
)


async def dispatch(
    args: Sequence[str],
    *,
    prog_name: str | None,
    configer: str,
    configer_options: tuple[str, ...],
) -> None:
    failures: list[click.ClickException | click.exceptions.Exit | click.Abort] = []
    roots: list[str] = []
    selected: list[Commands] = []

    def start(document: ConfigDocument) -> Composition:
        catalog = CommandCatalog(
            contribs=(
                *(
                    entry.entry
                    for package in document.contribs
                    if package.applies
                    for entry in package.enabled
                ),
            ),
            entries={"run": command_entry},
            help=main.help,
            params=main.params,
        )
        composition = build(document)
        try:
            entry = catalog.select(args, prog_name=prog_name)
            if entry is command_entry:
                composition = composition.model_copy(
                    update={"entries": (*composition.entries, running)}
                )
            if entry is not None:
                roots.append(entry.contrib)
        except (click.ClickException, click.exceptions.Exit, click.Abort) as error:
            failures.append(error)
        return composition.model_copy(update={"roots": tuple(roots)})

    @asynccontextmanager
    async def observe(ctx: Context):
        commands = ctx.accept(COMMANDS)
        commands.help = main.help
        commands.params.extend(main.params)
        selected.append(commands)
        yield

    async with node(
        start=start, configer=configer, configer_options=configer_options
    ) as hub:
        Configuration.check(hub.validate(Composition()))
        if roots:
            async with hub.enable(
                Composition(
                    entries=[
                        ContribEntry(
                            name="command-dispatch",
                            definition=Contrib(accepts=[COMMANDS], lifespan=observe),
                        )
                    ]
                )
            ):
                try:
                    await selected[0].dispatch(args, prog_name=prog_name)
                except (
                    click.ClickException,
                    click.exceptions.Exit,
                    click.Abort,
                ) as error:
                    failures.append(error)
    if failures:
        raise failures[0]


NODE_OPTIONS = {
    "--configer": "configer",
    "--configer-options": "configer_options",
    "--config": "configer_options",
}


@click.command(
    add_help_option=False,
    context_settings={
        "allow_extra_args": True,
        "ignore_unknown_options": True,
        "allow_interspersed_args": False,
    },
)
@click.version_option(package_name="bazaar-compute")
@click.option(
    "--configer",
    default="config-filesystem",
    show_default=True,
    help="Configuration contrib to use.",
)
@click.option(
    "--configer-options",
    multiple=True,
    metavar="OPTION",
    help="Option passed to the configuration contrib; may be repeated.",
)
@click.option(
    "--config",
    "configer_options",
    multiple=True,
    metavar="OPTION",
    help="Legacy alias for --configer-options.",
)
@click.pass_context
def main(ctx: click.Context, configer: str, configer_options: tuple[str, ...]) -> None:
    """Run Bazaar Compute Node."""
    # 0.2 also took node options after the command; those replace earlier ones.
    args: list[str] = []
    after: dict[str, list[str]] = {}
    remaining = iter(ctx.args)
    for arg in remaining:
        name, equals, value = arg.partition("=")
        if name not in NODE_OPTIONS:
            args.append(arg)
            continue
        if not equals:
            value = next(remaining, None)
            if value is None:
                raise click.BadParameter("requires a value", param_hint=name)
        after.setdefault(NODE_OPTIONS[name], []).append(value)
    if "configer" in after:
        configer = after["configer"][-1]
    if "configer_options" in after:
        configer_options = tuple(after["configer_options"])
    try:
        asyncio.run(
            dispatch(
                args,
                prog_name=ctx.info_name,
                configer=configer,
                configer_options=configer_options,
            )
        )
    except click.exceptions.Exit as error:
        ctx.exit(error.exit_code)
    except click.ClickException, click.Abort:
        raise
    except Exception as error:
        pending: list[BaseException] = [error]
        errors: list[str] = []
        while pending:
            error = pending.pop()
            if isinstance(error, BaseExceptionGroup):
                pending.extend(error.exceptions)
            else:
                errors.append(str(error))
        raise click.ClickException("; ".join(errors)) from error
