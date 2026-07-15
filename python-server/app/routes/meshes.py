"""Mesh-processing endpoints: Auto UV, Auto Retopo, Repair and FBX Convert.

Contract (shared by all routes):
  Request  : multipart/form-data
               - meshFile : the mesh to process (GLB/OBJ/PLY/STL)
               - options  : JSON string of the operation options (optional)
               - format   : desired output format, default "glb" (optional)
  Response : text/event-stream (Server-Sent Events). Each event is a `data:` line
             with a JSON object:
               {"type":"progress","stage":"remesh","frac":0.58,"message":"…"}
               {"type":"done","format":"glb","mesh_b64":"…","stats":{…},"preview_b64":…}
               {"type":"error","detail":"…"}

The heavy work runs in a worker thread; its progress callback pushes events onto
a queue that the streaming generator drains. The final mesh is delivered base64
in the terminal `done` event (these meshes are low-poly, so the overhead is
negligible) along with stats and an optional preview image.
"""
from __future__ import annotations

import base64
import json
import queue
import threading

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from ..config import MAX_UPLOAD_BYTES
from ..meshio import export_mesh, load_mesh, mesh_stats
from ..schemas import AutoRetopoOptions, AutoUvOptions, ConvertOptions, RepairOptions
from ..services.auto_retopo import run_auto_retopo
from ..services.auto_uv import run_auto_uv
from ..services.convert_fbx import run_convert_fbx
from ..services.repair import run_repair

router = APIRouter(prefix="/meshes", tags=["meshes"])

_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",  # disable proxy buffering (nginx etc.)
    "Connection": "keep-alive",
}


def _parse_options(raw: str | None, model):
    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid options JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="options must be a JSON object.")
    try:
        return model(**data)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc


async def _read_upload(mesh_file: UploadFile) -> bytes:
    data = await mesh_file.read()
    if not data:
        raise HTTPException(status_code=400, detail="meshFile is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="meshFile exceeds the maximum allowed size.")
    return data


def _envelope(mesh, fmt: str, tool_stats: dict | None, preview_png: bytes | None) -> dict:
    fmt = (fmt or "glb").lstrip(".").lower()
    payload = export_mesh(mesh, fmt)
    stats = mesh_stats(mesh)
    return {
        "format": fmt,
        "mesh_b64": base64.b64encode(payload).decode("ascii"),
        "stats": {
            "vertex_count": stats.vertex_count,
            "face_count": stats.face_count,
            "has_uv": stats.has_uv,
            "tool": tool_stats,
        },
        "preview_b64": base64.b64encode(preview_png).decode("ascii") if preview_png else None,
    }


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


def _stream_payload(run_callable, label: str) -> StreamingResponse:
    """Run `run_callable(emit)` in a worker thread and stream SSE progress events.

    `run_callable(emit)` must return the terminal `done` payload dict and may
    call emit(stage, frac, message) to report progress. Use this directly for
    tools that build their own envelope (e.g. FBX conversion, which must never
    round-trip through trimesh); use `_stream_tool` for trimesh-based tools.
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
        yield _sse({"type": "progress", "stage": "start", "frac": 0.0, "message": f"{label} starting…"})
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
            yield _sse(item)
        if "error" in holder:
            yield _sse({"type": "error", "detail": holder["error"]})
        else:
            yield _sse({"type": "done", **holder["payload"]})

    return StreamingResponse(generate(), media_type="text/event-stream", headers=_SSE_HEADERS)


def _stream_tool(run_callable, fmt: str, label: str) -> StreamingResponse:
    """`_stream_payload` for trimesh-based tools: `run_callable(emit)` returns
    (mesh, tool_stats, preview_png) and the envelope is built here.
    """
    def run(emit):
        mesh, tool_stats, preview = run_callable(emit)
        return _envelope(mesh, fmt, tool_stats, preview)

    return _stream_payload(run, label)


@router.post("/auto-uv")
async def auto_uv(
    meshFile: UploadFile = File(...),
    options: str | None = Form(None),
    format: str = Form("glb"),
) -> StreamingResponse:
    opts = _parse_options(options, AutoUvOptions)
    data = await _read_upload(meshFile)
    mesh = load_mesh(data, meshFile.filename or "mesh.glb")
    return _stream_tool(lambda emit: run_auto_uv(mesh, opts, progress=emit), format, "Auto UV")


@router.post("/auto-retopo")
async def auto_retopo(
    meshFile: UploadFile = File(...),
    options: str | None = Form(None),
    format: str = Form("glb"),
) -> StreamingResponse:
    opts = _parse_options(options, AutoRetopoOptions)
    data = await _read_upload(meshFile)
    mesh = load_mesh(data, meshFile.filename or "mesh.glb")
    return _stream_tool(lambda emit: run_auto_retopo(mesh, opts, progress=emit), format, "Auto Retopo")


@router.post("/repair")
async def repair(
    meshFile: UploadFile = File(...),
    options: str | None = Form(None),
    format: str = Form("glb"),
) -> StreamingResponse:
    opts = _parse_options(options, RepairOptions)
    data = await _read_upload(meshFile)
    mesh = load_mesh(data, meshFile.filename or "mesh.glb")
    return _stream_tool(lambda emit: run_repair(mesh, opts, progress=emit), format, "Repair")


@router.post("/convert")
async def convert(
    meshFile: UploadFile = File(...),
    options: str | None = Form(None),
    format: str = Form("fbx"),
) -> StreamingResponse:
    """GLB -> FBX engine export (headless Blender subprocess).

    Deliberately bypasses trimesh (`load_mesh`/`_envelope`): trimesh cannot
    write FBX and flattens skinned meshes, and this endpoint's whole point is
    preserving the skeleton + animation takes. The GLB bytes go to the worker
    untouched.
    """
    opts = _parse_options(options, ConvertOptions)
    data = await _read_upload(meshFile)
    if (format or "fbx").lstrip(".").lower() != "fbx":
        raise HTTPException(status_code=400, detail="Only 'fbx' output is supported by /meshes/convert.")

    def run(emit):
        fbx_bytes, tool_stats = run_convert_fbx(data, opts, progress=emit)
        return {
            "format": "fbx",
            "mesh_b64": base64.b64encode(fbx_bytes).decode("ascii"),
            "stats": {
                "vertex_count": tool_stats.get("vertices"),
                "face_count": None,
                "has_uv": bool(tool_stats.get("has_uv")),
                "tool": tool_stats,
            },
            "preview_b64": None,
        }

    return _stream_payload(run, "Convert to FBX")
