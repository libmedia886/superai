"""Hand the declared environment to uv as one project and let it install what is missing."""

from __future__ import annotations

lazy import asyncio
lazy import re
lazy import shutil
lazy import sys
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
        try:
            output, errors = await process.communicate()
        except BaseException:
            if process.returncode is None:
                process.terminate()
            await process.wait()
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
            package
            for package in installed.packages
            if package.package == "bazaar-compute-node"
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
        pending.append(Requirement(plan.host.package + plan.host.version))
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
            ContribPackage(
                package=plan.host.package + plan.host.version, source=plan.host.source
            ),
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

    async def install(self, plan: EnvironmentPlan, *, upgrade: bool = False) -> None:
        temporary = await asyncio.to_thread(TemporaryDirectory)
        try:
            project = Path(temporary.name) / "pyproject.toml"
            await asyncio.to_thread(
                project.write_text, tomli_w.dumps(self.project(plan)), "utf-8"
            )
            await self.command(
                str(self.uv),
                "pip",
                "install",
                "--python",
                str(self.python),
                "-r",
                str(project),
                *(("--upgrade",) if upgrade else ()),
                cwd=project.parent,
            )
        finally:
            await asyncio.to_thread(temporary.cleanup)

    async def uninstall(self, package: str) -> None:
        await self.command(
            str(self.uv), "pip", "uninstall", "--python", str(self.python), package
        )
