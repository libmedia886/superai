"""Shared contrib catalog, package management, and operation services."""

from bazaar_contrib_invoke import CommandEntry

command_entry = CommandEntry(contrib="contrib-manager", help="Manage contribs")

lazy from .catalog import CONTRIB_CATALOG, CONTRIB_INDEX_FAILED, ContribCatalog, indexes
lazy from .catalog import remote as catalog_remote
lazy from .contracts import (
    CatalogEntry,
    EntryInfo,
    IndexEntry,
    IndexStatus,
    InstalledPackage,
    ManagementError,
    ManagerConfig,
    Operation,
    Package,
)
lazy from .service import CONTRIB_MANAGER, ContribManager, manager, remote

__all__ = [
    "CONTRIB_CATALOG",
    "CONTRIB_INDEX_FAILED",
    "CONTRIB_MANAGER",
    "CatalogEntry",
    "ContribCatalog",
    "ContribManager",
    "EntryInfo",
    "IndexEntry",
    "IndexStatus",
    "InstalledPackage",
    "ManagementError",
    "ManagerConfig",
    "Operation",
    "Package",
    "catalog_remote",
    "command_entry",
    "indexes",
    "manager",
    "remote",
]
