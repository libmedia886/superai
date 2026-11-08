"""An agent's conversations as a server reads them: listed, one in particular
with its members, its history, searched, and an attachment's bytes."""

from __future__ import annotations

import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from bazaar_contrib_messages.models import (
    ChannelSession,
    InboundAttachment,
    InboxTargetSummary,
    Message,
    SenderIdentity,
)
from bazaar_contrib_messages.states import (
    ChannelTargetKind,
    MessageDirection,
    Review,
    SenderKind,
    SystemMessageKind,
)

# a segment encoded as base64 stays within the 1 MiB a call carries back
SEGMENT = 512 * 1024


@dataclass(frozen=True, slots=True)
class Preview:
    message_id: str
    sender: SenderIdentity | None
    sender_kind: SenderKind
    at_ms: int
    text: str


@dataclass(frozen=True, slots=True)
class Conversation:
    thread_id: str
    name: str | None
    handle: str | None
    kind: ChannelTargetKind
    channel: str
    review: Review
    last_activity_at_ms: int
    pending_count: int
    member_count: int
    first: Preview | None
    latest: Preview | None


@dataclass(frozen=True, slots=True)
class Conversations:
    conversations: tuple[Conversation, ...]
    total: int
    pending_review: int
    has_more: bool


@dataclass(frozen=True, slots=True)
class Member:
    sender: SenderIdentity | None
    sender_kind: SenderKind
    is_self: bool


@dataclass(frozen=True, slots=True)
class Detail:
    conversation: Conversation
    created_at_ms: int
    message_count: int
    members: tuple[Member, ...]


@dataclass(frozen=True, slots=True)
class Attachment:
    attachment_id: str | None
    name: str
    kind: str
    state: str
    media_type: str | None
    size_bytes: int | None


@dataclass(frozen=True, slots=True)
class Entry:
    message_id: str
    seq: int
    direction: MessageDirection
    sender: SenderIdentity | None
    sender_kind: SenderKind
    at_ms: int
    body: str
    system_message_kind: SystemMessageKind | None
    attachments: tuple[Attachment, ...]


@dataclass(frozen=True, slots=True)
class History:
    messages: tuple[Entry, ...]
    has_before: bool
    has_after: bool


@dataclass(frozen=True, slots=True)
class Hit:
    message_id: str
    thread_id: str
    conversation: str | None
    kind: ChannelTargetKind
    channel: str
    direction: MessageDirection
    sender: SenderIdentity | None
    sender_kind: SenderKind
    at_ms: int
    snippet: str
    parts: tuple[tuple[str, bool], ...]
    score: float


@dataclass(frozen=True, slots=True)
class Search:
    query: str
    sort: Literal["time", "relevance"]
    messages: tuple[Hit, ...]
    total: int
    offset: int
    has_more: bool
    next_offset: int | None


@dataclass(frozen=True, slots=True)
class Segment:
    media_type: str | None
    size_bytes: int
    data: str


def said_at(message: Message) -> int:
    """When the provider says a message was sent, or else when it arrived or
    was written."""

    return next(
        value
        for value in (
            message.provider_time_ms,
            message.received_at_ms,
            message.created_at_ms,
        )
        if value is not None
    )


def name(session: ChannelSession, spoken: Sequence[Message]) -> str | None:
    """A group by its name; a DM by its peer's latest display name, or else
    their handle. `spoken` is each sender's latest message, newest first."""

    if session.target_kind is ChannelTargetKind.GROUP:
        return session.target_display_name
    peer = next(
        (
            message.sender
            for message in spoken
            if message.direction is MessageDirection.INBOUND
        ),
        None,
    )
    return (None if peer is None else peer.display_name) or session.target_handle


def preview(message: Message) -> Preview:
    return Preview(
        message_id=message.message_id,
        sender=message.sender,
        sender_kind=message.sender_kind,
        at_ms=said_at(message),
        # as much as a search snippet shows
        text=message.body[:240],
    )


def conversation(
    summary: InboxTargetSummary,
    session: ChannelSession,
    spoken: Sequence[Message],
    first: Message | None,
) -> Conversation:
    return Conversation(
        thread_id=summary.thread_id,
        name=name(session, spoken),
        handle=session.target_handle,
        kind=session.target_kind,
        channel=session.channel,
        review=session.review,
        last_activity_at_ms=summary.last_activity_at_ms,
        pending_count=summary.pending_count,
        member_count=len(spoken),
        first=None if first is None else preview(first),
        latest=preview(spoken[0]) if spoken else None,
    )


def entry(message: Message) -> Entry:
    return Entry(
        message_id=message.message_id,
        seq=message.seq,
        direction=message.direction,
        sender=message.sender,
        sender_kind=message.sender_kind,
        at_ms=said_at(message),
        body=message.body,
        system_message_kind=message.system_message_kind,
        attachments=tuple(
            Attachment(
                attachment_id=item.attachment_id,
                name=item.name,
                kind=item.kind,
                state=item.state,
                media_type=item.media_type,
                size_bytes=item.size_bytes,
            )
            if isinstance(item, InboundAttachment)
            else Attachment(
                attachment_id=None,
                name=item.name,
                kind="file",
                state="ready",
                media_type=item.media_type,
                size_bytes=item.size_bytes,
            )
            for item in message.attachments
        ),
    )


def segment(path: Path, offset: int) -> tuple[bytes, int]:
    with path.open("rb") as file:
        file.seek(offset)
        return file.read(SEGMENT), os.fstat(file.fileno()).st_size
