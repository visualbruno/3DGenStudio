"""Shared Server-Sent Events plumbing for the long-running mesh routes.

Every heavy tool in this service follows the same contract: run the work in a
worker thread, push `progress` events onto a queue as it goes, and finish with a
single terminal `done` (or `error`) event. That machinery lived in
routes/meshes.py until the tree generator needed it too -- it is here so the two
cannot drift, not because the routes wanted a base class.
"""
from __future__ import annotations

import json
import queue
import threading

from fastapi.responses import StreamingResponse

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",  # disable proxy buffering (nginx etc.)
    "Connection": "keep-alive",
}


def sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


def stream_payload(run_callable, label: str) -> StreamingResponse:
    """Run `run_callable(emit)` in a worker thread and stream SSE progress events.

    `run_callable(emit)` must return the terminal `done` payload dict and may
    call emit(stage, frac, message) to report progress.
    """
    events: "queue.Queue" = queue.Queue()
    holder: dict = {}

    def emit(stage, frac, message=""):
        events.put({"type": "progress", "stage": stage, "frac": round(float(frac), 4), "message": message})

    def worker():
        try:
            holder["payload"] = run_callable(emit)
        except Exception as exc:  # noqa: BLE001 — surfaced to the client as an error event
            holder["error"] = f"{label} failed: {exc}"
        finally:
            events.put(None)  # sentinel: worker finished

    threading.Thread(target=worker, daemon=True).start()

    def generate():
        yield sse({"type": "progress", "stage": "start", "frac": 0.0, "message": f"{label} starting…"})
        while True:
            try:
                item = events.get(timeout=15)
            except queue.Empty:
                # Long blocking stages (e.g. "Building clean topology") emit no
                # progress for minutes. Send an SSE comment heartbeat so bytes keep
                # flowing; otherwise the Node proxy's fetch body timeout (~5 min of
                # silence) aborts the stream and takes the request down with it.
                yield ": keepalive\n\n"
                continue
            if item is None:
                break
            yield sse(item)
        if "error" in holder:
            yield sse({"type": "error", "detail": holder["error"]})
        else:
            yield sse({"type": "done", **holder["payload"]})

    return StreamingResponse(generate(), media_type="text/event-stream", headers=SSE_HEADERS)
