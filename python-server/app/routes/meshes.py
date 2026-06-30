"""Mesh-processing endpoints: Auto UV and Auto Retopo.

Contract (shared by both routes):
  Request  : multipart/form-data
               - meshFile : the mesh to process (GLB/OBJ/PLY/STL)
               - options  : JSON string of the operation options (optional)
               - format   : desired output format, default "glb" (optional)
  Response : application/json
               {
                 "format": "glb",
                 "mesh_b64": "<base64 of the processed mesh bytes>",
                 "stats": { "vertex_count", "face_count", "has_uv", "tool": {...} },
                 "preview_b64": "<base64 PNG>" | null   # UV layout for Auto UV
               }

A JSON envelope (rather than a binary body + custom headers) is used because the
browser cannot read custom response headers across origins, and it gives a clean
channel for the UV-layout preview image. These meshes are low-poly, so the base64
overhead is negligible.
"""
from __future__ import annotations

import base64
import json

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from ..config import MAX_UPLOAD_BYTES
from ..meshio import export_mesh, load_mesh, mesh_stats
from ..schemas import AutoRetopoOptions, AutoUvOptions
from ..services.auto_retopo import run_auto_retopo
from ..services.auto_uv import run_auto_uv

router = APIRouter(prefix="/meshes", tags=["meshes"])


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


def _tool_response(mesh, fmt: str, tool_stats: dict | None = None, preview_png: bytes | None = None) -> JSONResponse:
    fmt = (fmt or "glb").lstrip(".").lower()
    payload = export_mesh(mesh, fmt)
    stats = mesh_stats(mesh)
    return JSONResponse({
        "format": fmt,
        "mesh_b64": base64.b64encode(payload).decode("ascii"),
        "stats": {
            "vertex_count": stats.vertex_count,
            "face_count": stats.face_count,
            "has_uv": stats.has_uv,
            "tool": tool_stats,
        },
        "preview_b64": base64.b64encode(preview_png).decode("ascii") if preview_png else None,
    })


@router.post("/auto-uv")
async def auto_uv(
    meshFile: UploadFile = File(...),
    options: str | None = Form(None),
    format: str = Form("glb"),
) -> JSONResponse:
    opts = _parse_options(options, AutoUvOptions)
    data = await _read_upload(meshFile)
    mesh = load_mesh(data, meshFile.filename or "mesh.glb")
    try:
        result, tool_stats, preview_png = run_auto_uv(mesh, opts)
    except Exception as exc:  # noqa: BLE001 — surface tool errors as 500 with detail
        raise HTTPException(status_code=500, detail=f"Auto UV failed: {exc}") from exc
    return _tool_response(result, format, tool_stats, preview_png)


@router.post("/auto-retopo")
async def auto_retopo(
    meshFile: UploadFile = File(...),
    options: str | None = Form(None),
    format: str = Form("glb"),
) -> JSONResponse:
    opts = _parse_options(options, AutoRetopoOptions)
    data = await _read_upload(meshFile)
    mesh = load_mesh(data, meshFile.filename or "mesh.glb")
    try:
        result, tool_stats, preview_png = run_auto_retopo(mesh, opts)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Auto Retopo failed: {exc}") from exc
    return _tool_response(result, format, tool_stats, preview_png)
