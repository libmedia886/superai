"""Hand the declared environment to uv as one project and let it install what is missing."""

from __future__ import annotations

from contextlib import asynccontextmanager
lazy import asyncio
lazy import re
lazy import shutil
lazy import sys
lazy import tomllib
lazy from collections.abc import AsyncIterator
lazy from pathlib import Path
lazy from tempfile import TemporaryDirectory
lazy from typing import Any

lazy import tomli_w
lazy from bazaar_contrib_config import (
    ConfigDocument,
    ConfigurationEnvironment,
    ContribPackage,
)
lazy from packaging.requirements import Requirement
lazy from packaging.utils import canonicalize_name

lazy from .contracts import (
    EnvironmentInfo,
    EnvironmentPlan,
    InstalledPackage,
    ManagementError,
    Package,
)
lazy from .environment import inspect

PYPI = "https://pypi.org/simple"
HOST = "bazaar-compute"
ALIAS = "bazaar-compute-node"


class Packages:
    def __init__(self, path: Path, source: str) -> None:
        self.path = path
        self.source = source
        self.python = Path(sys.executable)
        self.prefix = Path(sys.prefix)
        self.uv: str | None = None

    async def command(self, *arguments: str, cwd: Path | None = None) -> str:
        process = await asyncio.create_subprocess_exec(
            *arguments,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        communication = asyncio.create_task(process.communicate())
        try:
            output, errors = await asyncio.shield(communication)
        except BaseException:
            # uv finishes what it started, leaving neither the environment nor its directory half done.
            await communication
            raise
        if process.returncode:
            detail = (errors or output).decode("utf-8", errors="replace").strip()
            detail = re.sub(r"(https?://)[^/\s@]+@", r"\1[redacted]@", detail)
            raise ManagementError(
                f"package command failed ({process.returncode}): {detail}"
            )
        return output.decode("utf-8", errors="replace")

    async def initialize(self) -> None:
        self.uv = await asyncio.to_thread(shutil.which, "uv")
        if self.uv is None:
            raise ManagementError("uv is not on this node's PATH")
        if sys.prefix == sys.base_prefix:
            raise ManagementError(
                "package operations require a uv tool or dedicated venv"
            )

    async def inspect(
        self, python: Path | None = None, *, definitions: bool = True
    ) -> EnvironmentInfo:
        if python is None and not definitions:
            return await asyncio.to_thread(inspect, definitions=False)
        output = await self.command(
            str(python or self.python),
            "-m",
            "bazaar_contrib_manager.environment",
            *(("--metadata-only",) if not definitions else ()),
        )
        return EnvironmentInfo.model_validate_json(output)

    async def plan(
        self, document: ConfigDocument, environment: ConfigurationEnvironment | None
    ) -> EnvironmentPlan:
        installed = await self.inspect(definitions=False)
        host = next(
            package for package in installed.packages if package.package == HOST
        )
        declared = {
            entry.distribution
            for entry in document.contribs
            if entry.package and entry.applies
        }
        required = {
            str(canonicalize_name(Requirement(requirement).name))
            for requirement in host.requirements
        }
        entries = (
            {entry.entry for entry in environment.entries}
            if environment is not None
            else set()
        )
        bootstrap = tuple(
            ContribPackage(
                package=(
                    f"{package.package} @ {package.url}"
                    if package.url is not None
                    else f"{package.package}=={package.version}"
                ),
                source=self.source,
            )
            for package in installed.packages
            if package.package not in declared | required | {host.package}
            and any(entry.name in entries for entry in package.entries)
        )
        return EnvironmentPlan(
            host=Package(
                package=host.package, source=self.source, version=f"=={host.version}"
            ),
            host_url=host.url,
            packages=(
                *(entry for entry in document.contribs if entry.package),
                *bootstrap,
            ),
        )

    async def expand(
        self, plan: EnvironmentPlan
    ) -> list[tuple[Requirement, InstalledPackage | None]]:
        """Walk the plan and the extras each requirement requests through installed metadata."""
        installed = await self.inspect(definitions=False)
        packages = {package.package: package for package in installed.packages}
        pending = [
            Requirement(entry.package) for entry in plan.packages if entry.applies
        ]
        pending.append(Requirement(plan.host_requirement))
        expanded: list[tuple[Requirement, InstalledPackage | None]] = []
        checked: set[tuple[str, frozenset[str]]] = set()
        while pending:
            requirement = pending.pop()
            name = str(canonicalize_name(requirement.name))
            package = packages.get(name)
            expanded.append((requirement, package))
            key = name, frozenset(requirement.extras)
            if package is None or key in checked:
                continue
            checked.add(key)
            for raw in package.requirements:
                dependency = Requirement(raw)
                if dependency.marker is None or any(
                    dependency.marker.evaluate({"extra": extra})
                    for extra in ("", *requirement.extras)
                ):
                    pending.append(dependency)
        return expanded

    async def satisfied(self, plan: EnvironmentPlan) -> bool:
        """Check declarations and the requested extras against actual installed metadata."""
        return all(
            package is not None
            and requirement.specifier.contains(package.version, prereleases=True)
            and (not requirement.url or package.url == requirement.url.split("#", 1)[0])
            for requirement, package in await self.expand(plan)
        )

    def project(self, plan: EnvironmentPlan) -> dict[str, Any]:
        """Describe the declared graph as a project binding each package to its source.

        Private sources come first, so a package one of them publishes never resolves
        from a public index; the host source and PyPI follow, uv's own default index last.
        """
        packages = (
            ContribPackage(package=plan.host_requirement, source=plan.host.source),
            *plan.packages,
        )
        declared = dict.fromkeys(
            package.source
            for package in packages
            if package.applies and package.source not in ("", self.source)
        )
        public = [url for url in declared if url.rstrip("/") == PYPI]
        indexes = [
            *(url for url in declared if url not in public),
            self.source,
            *public,
        ]
        sources: dict[str, dict[str, str]] = {}
        for package in packages:
            if Requirement(package.package).url or not package.applies:
                continue
            source = {"index": f"source-{indexes.index(package.source or self.source)}"}
            name = package.distribution
            if name in sources and sources[name] != source:
                raise ManagementError(f"conflicting sources for {name}")
            sources[name] = source
        return {
            "project": {
                "name": "bazaar-contrib-environment",
                "version": "0",
                "requires-python": ">=3.15",
                "dependencies": [package.package for package in packages],
            },
            "tool": {
                "uv": {
                    "index": [
                        {"name": f"source-{index}", "url": url}
                        for index, url in enumerate(indexes)
                    ],
                    "sources": sources,
                }
            },
        }

    @asynccontextmanager
    async def written(self, plan: EnvironmentPlan) -> AsyncIterator[Path]:
        """Write the declared graph as a project that only exists while uv reads it."""
        temporary = await asyncio.to_thread(TemporaryDirectory)
        try:
            project = Path(temporary.name) / "pyproject.toml"
            await asyncio.to_thread(
                project.write_text, tomli_w.dumps(self.project(plan)), "utf-8"
            )
            yield project
        finally:
            await asyncio.to_thread(temporary.cleanup)

    async def install(
        self, plan: EnvironmentPlan, *, upgrade: tuple[str, ...] = ()
    ) -> None:
        async with self.written(plan) as project:
            await self.command(
                str(self.uv),
                "pip",
                "install",
                "--python",
                str(self.python),
                "-r",
                str(project),
                *(
                    argument
                    for package in upgrade
                    for argument in ("--upgrade-package", package)
                ),
                cwd=project.parent,
            )

    async def resolve(self, plan: EnvironmentPlan) -> dict[str, str]:
        """Resolve the declared graph for this interpreter without installing it."""
        async with self.written(plan) as project:
            output = await self.command(
                str(self.uv),
                "pip",
                "compile",
                str(project),
                "--python",
                str(self.python),
                "--quiet",
                "--no-header",
                "--no-annotate",
                "--refresh-package",
                HOST,
                "--refresh-package",
                ALIAS,
                cwd=project.parent,
            )
        return {
            str(canonicalize_name(match.group(1))): match.group(2)
            for match in re.finditer(
                r"^([A-Za-z0-9._-]+)==([^\s;]+)", output, re.MULTILINE
            )
        }

    async def latest(self, plan: EnvironmentPlan) -> str | None:
        """The newest host version the declared contribs can be installed with."""
        host = plan.host.model_copy(
            update={
                "package": await self.requirement(),
                "version": ">" + plan.host.version.removeprefix("=="),
            }
        )
        try:
            resolved = await self.resolve(
                plan.model_copy(update={"host": host, "host_url": None})
            )
        except ManagementError as error:
            if "No solution found" in str(error):
                return None
            raise
        return resolved.get(HOST)

    async def tool(self) -> bool:
        """Whether this environment is the uv tool the host was installed as."""
        return await asyncio.to_thread((self.prefix / "uv-receipt.toml").is_file)

    async def requirement(self) -> str:
        """The host as the uv tool was installed, with the extras chosen then."""
        receipt = self.prefix / "uv-receipt.toml"
        if not await asyncio.to_thread(receipt.is_file):
            return HOST
        document = tomllib.loads(await asyncio.to_thread(receipt.read_text, "utf-8"))
        installed = next(
            item
            for item in document["tool"]["requirements"]
            if canonicalize_name(item["name"]) == canonicalize_name(self.prefix.name)
        )
        extras = installed.get("extras", [])
        return installed["name"] + (f"[{','.join(extras)}]" if extras else "")

    async def install_host(self, version: str) -> None:
        """Install a host release the way 0.2 did, as the uv tool it was installed as."""
        await self.command(
            str(self.uv),
            "tool",
            "install",
            "--refresh-package",
            HOST,
            "--refresh-package",
            ALIAS,
            *(("--index", self.source) if self.source.rstrip("/") != PYPI else ()),
            f"{await self.requirement()}=={version}",
        )

    async def uninstall(self, package: str) -> None:
        await self.command(
            str(self.uv), "pip", "uninstall", "--python", str(self.python), package
        )
