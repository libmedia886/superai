"""Multiplex complete JSONL frames over an implementation's byte streams."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID, uuid7
lazy import asyncio
lazy import logging
lazy from collections.abc import Awaitable, Callable

from pydantic import Field, TypeAdapter
lazy from bazaar_contrib_timer import Timer

from .contracts import Response, Sessions
from .wire import Failure, Message, Request

_READ_CHUNK_BYTES = 64 * 1024
_CONNECT_ATTEMPTS = 3
_FIRST_RETRY_MS = 250
_LAST_RETRY_MS = 4_000
logger = logging.getLogger(__name__)


class Call(Message):
    kind: Literal["call"] = "call"
    id: UUID = Field(default_factory=uuid7)
    request: Request


class Cancel(Message):
    kind: Literal["cancel"] = "cancel"
    id: UUID


FRAME = TypeAdapter(Annotated[Call | Cancel, Field(discriminator="kind")])


class Reply(Message):
    id: UUID
    response: Response = Field(discriminator="kind")


class UnlimitedLineReader:
    """Retain trailing bytes while reading complete lines in fixed-size chunks."""

    def __init__(self, reader: asyncio.StreamReader) -> None:
        self._reader = reader
        self._buffer = bytearray()
        self._eof = False

    async def readline(self) -> bytes:
        while True:
            boundary = self._buffer.find(b"\n")
            if boundary >= 0:
                boundary += 1
                line = bytes(self._buffer[:boundary])
                del self._buffer[:boundary]
                return line
            if self._eof:
                line = bytes(self._buffer)
                self._buffer.clear()
                return line
            chunk = await self._reader.read(_READ_CHUNK_BYTES)
            if chunk:
                self._buffer.extend(chunk)
            else:
                self._eof = True


class _Link:
    """One opened connection and the calls written to it."""

    def __init__(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self.writer = writer
        self.pending: dict[UUID, asyncio.Future[Response]] = {}
        self.receiver = asyncio.create_task(self.receive(UnlimitedLineReader(reader)))

    async def receive(self, reader: UnlimitedLineReader) -> None:
        error: Exception = ConnectionError("sidecar closed before returning a result")
        try:
            while line := await reader.readline():
                reply = Reply.model_validate_json(line)
                future = self.pending.get(reply.id)
                if future is not None and not future.done():
                    future.set_result(reply.response)
        except Exception as caught:  # noqa: BLE001 - Fail all calls owned by this broken connection.
            error = caught
        finally:
            self.writer.close()
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)


class Connection:
    """Pair concurrent calls with their responses on one lazy connection.

    A call that finds the connection missing or broken connects again, trying a
    few times with backoff; calls already written to a connection fail with it."""

    def __init__(
        self,
        connect: Callable[
            [], Awaitable[tuple[asyncio.StreamReader, asyncio.StreamWriter]]
        ],
        timer: Timer | None = None,
    ) -> None:
        self.connect = connect
        self.timer = timer
        self.lock = asyncio.Lock()
        self.link: _Link | None = None
        self.closed = False
        self.retry = _FIRST_RETRY_MS

    async def send(self, request: Request) -> Response:
        call = Call(request=request)
        future: asyncio.Future[Response] = asyncio.get_running_loop().create_future()
        link: _Link | None = None
        try:
            async with self.lock:
                link = await self.open()
                link.pending[call.id] = future
                link.writer.write(call.model_dump_json().encode() + b"\n")
                await link.writer.drain()
            return await future
        except asyncio.CancelledError:
            if link is not None and call.id in link.pending:
                try:
                    if not link.writer.is_closing():
                        # Queue the complete frame without waiting on backpressure.
                        link.writer.write(
                            Cancel(id=call.id).model_dump_json().encode() + b"\n"
                        )
                except OSError:
                    logger.exception("could not cancel sidecar call %s", call.id)
            raise
        finally:
            if link is not None:
                link.pending.pop(call.id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()

    async def open(self) -> _Link:
        if self.link is not None and self.link.writer.is_closing():
            await asyncio.gather(self.link.receiver, return_exceptions=True)
            self.link = None
        for attempt in range(1, _CONNECT_ATTEMPTS + 1):
            if self.link is not None or self.closed:
                break
            try:
                self.link = _Link(*await self.connect())
            except OSError:
                if attempt == _CONNECT_ATTEMPTS:
                    raise
                delay, self.retry = self.retry, min(self.retry * 2, _LAST_RETRY_MS)
                if self.timer is None:
                    await asyncio.sleep(delay / 1000)
                else:
                    await self.timer.create(delay).wait()
            else:
                self.retry = _FIRST_RETRY_MS
        if self.closed or self.link is None:
            raise ConnectionError("the sidecar connection has closed")
        return self.link

    async def aclose(self) -> None:
        self.closed = True
        async with self.lock:
            link = self.link
            if link is not None:
                link.writer.close()
                link.receiver.cancel()
        if link is not None:
            await asyncio.gather(link.receiver, return_exceptions=True)
            try:
                await link.writer.wait_closed()
            except OSError:
                pass


async def serve(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, sessions: Sessions
) -> None:
    """Own concurrent handlers and remote resources for one connection."""
    try:
        lines = UnlimitedLineReader(reader)
        async with sessions() as dispatch, asyncio.TaskGroup() as group:
            tasks: dict[UUID, asyncio.Task[None]] = {}

            async def respond(call: Call) -> None:
                try:
                    response = await dispatch(call.request)
                except asyncio.CancelledError:
                    response = Failure(
                        type="CancelledError", message="the remote call was cancelled"
                    )
                writer.write(
                    Reply(id=call.id, response=response).model_dump_json().encode()
                    + b"\n"
                )
                await writer.drain()

            try:
                while line := await lines.readline():
                    frame = FRAME.validate_json(line)
                    match frame:
                        case Call():
                            task = group.create_task(respond(frame))
                            tasks[frame.id] = task
                            task.add_done_callback(
                                lambda _, id=frame.id: tasks.pop(id, None)
                            )
                        case Cancel():
                            if task := tasks.get(frame.id):
                                task.cancel()
            finally:
                for task in tasks.values():
                    task.cancel()
    except* OSError, ValueError:
        pass
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass
