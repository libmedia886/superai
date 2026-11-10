"""Run an installed application until the controlling process closes its pipe."""

import asyncio
import sys

from bazaar_compute_node.boot import node
from bazaar_contrib_config import Configuration
from bcn_agent_workbench import started


async def main():
    async with node(configer_options=(sys.argv[1],)) as hub:
        Configuration.check(hub)
        await started(hub, sys.argv[2:])
        await asyncio.to_thread(print, "ready", flush=True)
        await asyncio.to_thread(sys.stdin.readline)


if __name__ == "__main__":
    asyncio.run(main())
