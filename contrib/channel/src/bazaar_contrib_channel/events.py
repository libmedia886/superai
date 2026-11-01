"""Turn progress delivered to one connected channel."""

from __future__ import annotations

from dataclasses import dataclass

from bazaar_contrib_harness import HarnessOutput
from bazaar_core import EventKey

from .models import ChannelTarget


@dataclass(frozen=True, slots=True)
class ChannelTurn:
    target: ChannelTarget
    event: HarnessOutput


CHANNEL_TURN = EventKey[ChannelTurn]("channel.turn")
