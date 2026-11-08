"""Agent-owned conversations, messages and resource-scoped commands."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from bazaar_contrib_audit import AUDIT, Audit
from bazaar_contrib_legacy_node_migrations import LEGACY_NODE_MIGRATIONS
from bazaar_contrib_messages import (
    MESSAGES,
    Actors,
    Agent,
    MessageSession,
    SessionBindingValidator,
    Thread,
    ThreadConcurrency,
)
from bazaar_contrib_messages.models import ChannelSession, Message
from bazaar_contrib_messages.operations import UnreadMessageOwner
from bazaar_contrib_messages.results import MessageSearchRequest
from bazaar_contrib_messages.states import MessageDirection, Review
from bazaar_contrib_schema import SCHEMA
from bazaar_contrib_sidecar import RemoteEntry
from bazaar_contrib_storage import DB, Database, Session
from bazaar_contrib_timer import TIMER, Timer
from bazaar_core import Context, Contrib
from pydantic import BaseModel, ConfigDict, Field, StrictStr, ValidationError
lazy from bazaar_contrib_channel import Channel

from .attachments import AttachmentMaterializer
from .concurrency import ThreadLockRegistry
from .conversations import (
    Conversations,
    Detail,
    History,
    Hit,
    Member,
    Search,
    Segment,
    conversation,
    entry,
    name,
    segment,
)
from .dispatch import CommandDispatcher
from .operations import _HISTORY_DELIVERY_STATES
from .repository import Repository
from .repository.unread import list_unread_message_owners
from .schema import MODULE
from .serialize import highlight
from .service import NodeMessageService
from .store import MessageStore

__all__ = [
    "MESSAGES",
    "AttachmentMaterializer",
    "CommandDispatcher",
    "MessageStore",
    "NodeMessageService",
    "NodeMessages",
    "ThreadLockRegistry",
    "messages",
    "remote",
]


class _AgentRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    agent_id: StrictStr = Field(min_length=1)


class NodeMessages:
    """Keep command bindings within their owning agent's lifespan."""

    def __init__(self, database: Database, audit: Audit, timer: Timer):
        self.database = database
        self.audit = audit
        self.timer = timer
        self._bindings: dict[Agent, tuple[CommandDispatcher, NodeMessageService]] = {}

    def storage(self, owner: Agent) -> MessageStore:
        return MessageStore(self.database, owner, owner.id)

    def in_session(self, session: Session, owner: Agent) -> MessageSession:
        return Repository(session, owner, owner.id)

    async def list_unread_message_owners(self) -> tuple[UnreadMessageOwner, ...]:
        return await self.database.read(list_unread_message_owners)

    @asynccontextmanager
    async def bind(
        self,
        *,
        actors: Actors,
        name: str,
        channel: Channel,
        workspace: Path,
        concurrency: ThreadConcurrency,
        provider_timeout: float,
        shutdown_timeout: float,
        session_binding_validator: SessionBindingValidator | None = None,
    ) -> AsyncIterator[NodeMessageService]:
        owner = Agent(actors.agent_id)
        if owner in self._bindings:
            raise ValueError(
                f"message commands are already bound for agent: {owner.id}"
            )
        service = NodeMessageService(
            storage=MessageStore(self.database, owner, name),
            audit=self.audit,
            concurrency=concurrency,
            channel=channel,
            workspace=workspace,
            provider_timeout=provider_timeout,
            timer=self.timer,
        )
        await service._attachments.reconcile()
        dispatcher = CommandDispatcher(
            service,
            actors=actors,
            timer=self.timer,
            session_binding_validator=session_binding_validator,
        )
        dispatcher.start_accepting()
        self._bindings[owner] = dispatcher, service
        try:
            yield service
        finally:
            dispatcher.stop_accepting()
            del self._bindings[owner]
            await dispatcher.drain(timeout=shutdown_timeout)

    async def drain(self, owner: Agent, *, timeout: float) -> None:  # noqa: ASYNC109
        dispatcher, _ = self._bindings[owner]
        await dispatcher.drain(timeout=timeout)

    async def request(self, request: Mapping[str, object]) -> Mapping[str, object]:
        try:
            owner = Agent(_AgentRequest.model_validate(request).agent_id)
        except ValidationError:
            return {
                "ok": False,
                "code": "AGENT_REQUIRED",
                "error": "agent_id must be a non-empty string",
            }
        binding = self._bindings.get(owner)
        if binding is None:
            return {
                "ok": False,
                "code": "AGENT_NOT_AVAILABLE",
                "error": "Agent is not available",
            }
        return await binding[0](request)

    def _service(self, agent_id: str) -> NodeMessageService:
        binding = self._bindings.get(Agent(agent_id))
        if binding is None:
            raise ValueError("Agent is not available")
        return binding[1]

    @staticmethod
    async def _session(storage: MessageStore, thread_id: str) -> ChannelSession:
        sessions = await storage.get_channel_sessions((Thread(thread_id),))
        if thread_id not in sessions:
            raise ValueError(f"conversation not found: {thread_id}")
        return sessions[thread_id]

    async def conversations(
        self,
        agent_id: str,
        review: Literal["approved", "pending"],
        offset: int = 0,
        limit: int = 50,
    ) -> Conversations:
        storage = self._service(agent_id).storage
        page = await storage.list_inbox_targets(
            limit=limit, offset=offset, review=Review(review)
        )
        threads = tuple(Thread(summary.thread_id) for summary in page.targets)
        sessions = await storage.get_channel_sessions(threads)
        spoken: dict[str, list[Message]] = {}
        for message in await storage.list_latest_by_sender(threads):
            spoken.setdefault(message.thread_id, []).append(message)
        first = {
            message.thread_id: message
            for message in await storage.list_first_messages(threads)
        }
        return Conversations(
            conversations=tuple(
                conversation(
                    summary,
                    sessions[summary.thread_id],
                    spoken.get(summary.thread_id, ()),
                    first.get(summary.thread_id),
                )
                for summary in page.targets
            ),
            total=page.total,
            pending_review=page.pending_review,
            has_more=page.has_more,
        )

    async def conversation(self, agent_id: str, thread_id: str) -> Detail:
        storage = self._service(agent_id).storage
        session = await self._session(storage, thread_id)
        thread = Thread(thread_id)
        page = await storage.list_inbox_targets(limit=1, review=None, thread_id=thread)
        spoken = await storage.list_latest_by_sender((thread,))
        first = await storage.list_first_messages((thread,))
        return Detail(
            conversation=conversation(
                page.targets[0], session, spoken, first[0] if first else None
            ),
            created_at_ms=session.created_at_ms,
            message_count=await storage.count_messages(
                thread,
                target=session.canonical_target,
                delivery_states=_HISTORY_DELIVERY_STATES,
            ),
            members=tuple(
                Member(
                    sender=message.sender,
                    sender_kind=message.sender_kind,
                    is_self=message.direction is MessageDirection.OUTBOUND,
                )
                for message in spoken
            ),
        )

    async def history(
        self,
        agent_id: str,
        thread_id: str,
        around: str | None = None,
        limit: int = 50,
    ) -> History:
        storage = self._service(agent_id).storage
        session = await self._session(storage, thread_id)
        read = await storage.read_message_history(
            raw_target=session.canonical_target,
            around_message_id=around,
            limit=limit,
            review=None,
        )
        return History(
            messages=tuple(entry(message) for message in read.history.messages),
            has_before=read.history.has_before,
            has_after=read.history.has_after,
        )

    async def search(
        self,
        agent_id: str,
        query: str,
        sort: Literal["relevance", "time"],
        thread_id: str | None = None,
        sender: str | None = None,
        after_ms: int | None = None,
        before_ms: int | None = None,
        offset: int = 0,
        limit: int = 20,
    ) -> Search:
        storage = self._service(agent_id).storage
        result = await storage.search_messages(
            MessageSearchRequest(
                query=query,
                raw_target=None
                if thread_id is None
                else (await self._session(storage, thread_id)).canonical_target,
                sender=sender,
                after_ms=after_ms,
                before_ms=before_ms,
                sort=sort,
                limit=limit,
                offset=offset,
            ),
            review=None,
        )
        threads = tuple(dict.fromkeys(Thread(hit.thread_id) for hit in result.messages))
        sessions = await storage.get_channel_sessions(threads)
        spoken: dict[str, list[Message]] = {}
        for message in await storage.list_latest_by_sender(threads):
            spoken.setdefault(message.thread_id, []).append(message)
        return Search(
            query=result.query,
            sort=result.sort,
            messages=tuple(
                Hit(
                    message_id=hit.message_id,
                    thread_id=hit.thread_id,
                    conversation=name(
                        sessions[hit.thread_id], spoken.get(hit.thread_id, ())
                    ),
                    kind=hit.target_kind,
                    channel=hit.channel,
                    direction=hit.direction,
                    sender=hit.sender,
                    sender_kind=hit.sender_kind,
                    at_ms=hit.at_ms,
                    snippet=hit.snippet,
                    parts=tuple(highlight(result.query, hit.snippet)),
                    score=hit.score,
                )
                for hit in result.messages
            ),
            total=result.total,
            offset=result.offset,
            has_more=result.has_more,
            next_offset=result.next_offset,
        )

    async def attachment(
        self, agent_id: str, attachment_id: str, offset: int = 0
    ) -> Segment:
        service = self._service(agent_id)
        attachment = await service.storage.get_inbound_attachment(attachment_id)
        if attachment is None or attachment.relative_path is None:
            raise ValueError(f"attachment is not ready: {attachment_id}")
        data, size = await asyncio.to_thread(
            segment, service.workspace / attachment.relative_path, offset
        )
        return Segment(
            media_type=attachment.media_type,
            size_bytes=size,
            data=base64.b64encode(data).decode(),
        )


@asynccontextmanager
async def lifespan(ctx: Context):
    async with ctx.accept(SCHEMA).register(MODULE):
        ctx.offer(
            MESSAGES, NodeMessages(ctx.accept(DB), ctx.accept(AUDIT), ctx.accept(TIMER))
        )
        yield


messages = Contrib(
    accepts=[SCHEMA, LEGACY_NODE_MIGRATIONS, DB, AUDIT, TIMER],
    offers=[MESSAGES],
    lifespan=lifespan,
)

remote = RemoteEntry(
    MESSAGES,
    ("request", "conversations", "conversation", "history", "search", "attachment"),
)
