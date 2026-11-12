"""Read every configured index, the online ones from the cache their refresh writes."""

from __future__ import annotations

from contextlib import asynccontextmanager
lazy import asyncio
lazy from datetime import UTC, datetime
lazy from hashlib import sha256
lazy from http.client import HTTPException
lazy from importlib.resources import files
lazy from pathlib import Path
lazy from urllib.parse import urlsplit
lazy from urllib.request import urlopen

from bazaar_contrib_sidecar import RemoteEntry
from bazaar_contrib_timer import TIMER
from bazaar_core import Contrib, EventKey, ServiceKey
lazy from bazaar_contrib_config import ConfigDocument, Configuration
lazy from bazaar_core import Context
lazy from packaging.utils import canonicalize_name

from .contracts import CatalogEntry, IndexDocument, IndexStatus
lazy from .contracts import ManagementError, Package
lazy from .files import write


class ContribCatalog:
    def __init__(self, configuration: Configuration, path: Path, ctx: Context) -> None:
        self.configuration = configuration
        self.path = path
        self.ctx = ctx
        self._failing: set[str] = set()
        self._lock = asyncio.Lock()

    async def indexes(self) -> tuple[IndexStatus, ...]:
        candidate, _ = await self.configuration.read()
        document = ConfigDocument.model_validate(candidate.payload)
        async with self._lock:
            return tuple(
                await asyncio.gather(
                    *(
                        asyncio.to_thread(self._read, location)
                        for location in document.contrib_indexes
                    )
                )
            )

    async def refresh(self) -> tuple[IndexStatus, ...]:
        """Read every online index again, announcing each one that starts failing."""
        candidate, _ = await self.configuration.read()
        document = ConfigDocument.model_validate(candidate.payload)
        indexes = await asyncio.gather(
            *(
                asyncio.to_thread(self._read, location, refresh=True)
                for location in document.contrib_indexes
                if location.startswith(("http://", "https://"))
            )
        )
        for index in indexes:
            if index.error is None:
                self._failing.discard(index.location)
            elif index.location not in self._failing:
                self._failing.add(index.location)
                await self.ctx.announce(CONTRIB_INDEX_FAILED, index)
        return tuple(indexes)

    def _read(self, location: str, *, refresh: bool = False) -> IndexStatus:
        path = self.path / f"{sha256(location.encode()).hexdigest()}.json"
        online = location.startswith(("http://", "https://"))
        if online and not refresh:
            try:
                return IndexStatus.model_validate_json(path.read_bytes())
            except OSError, ValueError:
                return IndexStatus(location=location)
        try:
            if online:
                with urlopen(location, timeout=20) as response:
                    raw = response.read()
            elif location.startswith("resource://"):
                resource = urlsplit(location)
                raw = (
                    files(resource.netloc)
                    .joinpath(resource.path.lstrip("/"))
                    .read_bytes()
                )
            else:
                raw = Path(location).expanduser().read_bytes()
            document = IndexDocument.model_validate_json(raw)
            status = IndexStatus(
                location=location,
                entries=document.contribs,
                read_at=datetime.now(UTC).isoformat(),
            )
            write(path, status.model_dump(mode="json"))
            return status
        except (HTTPException, ImportError, OSError, ValueError) as error:
            try:
                status = IndexStatus.model_validate_json(path.read_bytes())
            except OSError, ValueError:
                status = IndexStatus(location=location)
            status = status.model_copy(
                update={"cached": bool(status.read_at), "error": str(error)}
            )
            if online:
                write(path, status.model_dump(mode="json"))
            return status

    async def entries(self) -> tuple[CatalogEntry, ...]:
        merged: dict[tuple[str, str], CatalogEntry] = {}
        for index in await self.indexes():
            for package in index.entries:
                key = package.package, package.source
                previous = merged.get(key)
                merged[key] = CatalogEntry(
                    **package.model_dump(),
                    indexes=(*previous.indexes, index.location)
                    if previous is not None
                    else (index.location,),
                )
        return tuple(
            sorted(merged.values(), key=lambda entry: (entry.package, entry.source))
        )

    async def select(
        self, name: str, *, source: str | None = None, version: str = ""
    ) -> Package:
        name = str(canonicalize_name(name))
        entries = await self.entries()
        names = {name, f"bazaar-contrib-{name}"}
        selected = [
            entry
            for entry in entries
            if entry.package in names and (source is None or entry.source == source)
        ]
        if len(selected) != 1:
            if not selected and source is not None:
                return Package(package=name, source=source, version=version)
            raise ManagementError(
                f"select one package/source for {name!r}; found {len(selected)} indexed choices"
            )
        return Package(
            package=selected[0].package,
            source=selected[0].source,
            version=version,
        )


CONTRIB_CATALOG = ServiceKey[ContribCatalog]("contrib.catalog")
CONTRIB_INDEX_FAILED = EventKey[IndexStatus]("contrib.index.failed")
remote = RemoteEntry(CONTRIB_CATALOG, ("indexes", "entries", "refresh"))


@asynccontextmanager
async def refresh(ctx: Context):
    catalog = ctx.accept(CONTRIB_CATALOG)
    timer = ctx.accept(TIMER)

    async def watch() -> None:
        """Read the online indexes once the node runs, and again every hour."""
        while True:
            await catalog.refresh()
            await timer.create(3_600_000).wait()

    async with asyncio.TaskGroup() as tasks:
        task = tasks.create_task(watch())
        try:
            yield
        finally:
            task.cancel()


indexes = Contrib(accepts=[CONTRIB_CATALOG, TIMER], lifespan=refresh)
