"""Dedicated rigging micro-service for 3D Gen Studio.

A tiny FastAPI app that wraps the headless :class:`RigPipeline` (see ``rig.py``)
so the Node backend can rig a mesh over HTTP. It deliberately mirrors the
request/response contract of the main mesh-tools service
(``python-server/app/routes/meshes.py``) so the browser client and the Node
proxy treat it identically:

  Request  : multipart/form-data
               - meshFile : the mesh to rig (GLB/OBJ/FBX)
               - options  : JSON string of rig options (optional)
               - format   : ignored (rig output is always GLB)
  Response : text/event-stream (SSE)
               {"type":"progress","stage":"generate","frac":0.4,"message":"…"}
               {"type":"done","format":"glb","mesh_b64":"…","stats":{…}}
               {"type":"error","detail":"…"}

Why a separate service (not part of python-server): rigging needs a completely
different, heavy environment — torch + flash-attn + bpy + a ~14 GB CUDA model +
the bpy_server subprocess — which must not be mixed into the CPU/trimesh venv of
the mesh-tools service. Keeping it standalone means the model stays warm across
requests and the two dependency sets never collide.

Run it from THIS directory (the bpy_server.py launch + checkpoint paths are
relative), inside the SkinTokens venv:

    python rig_server.py            # binds RIGTOOLS_HOST:RIGTOOLS_PORT (default 0.0.0.0:8300)

Prerequisite (run once): ``python download.py --model``.
"""
from __future__ import annotations

import base64
import json
import os
import queue
import shutil
import struct
import tempfile
import threading
from pathlib import Path

os.environ.setdefault("XFORMERS_IGNORE_FLASH_VERSION_CHECK", "1")

# The rig resolves several resources by paths RELATIVE TO THE WORKING DIRECTORY:
# downloaded weights (experiments/…, models/…) AND static configs the model
# checkpoint references (configs/skeleton/*.yaml). By default the working dir is
# this code dir (matches the CLI). In the packaged desktop app the code dir is
# READ-ONLY, so the app sets RIGTOOLS_DATA_DIR to a writable per-user folder and
# we chdir there — but that folder must be a COMPLETE run-root. The weights are
# downloaded into it; here we also mirror the code dir's configs/ into it so the
# checkpoint's relative config lookups (e.g. configs/skeleton/vroid.yaml) resolve.
# The bpy_server.py subprocess is launched by absolute path (see BpyServer in
# rig.py) and `from src…` imports resolve via sys.path, so both are unaffected.
_HERE = Path(__file__).resolve().parent
_DATA_DIR = Path(os.environ.get("RIGTOOLS_DATA_DIR") or _HERE).resolve()
_DATA_DIR.mkdir(parents=True, exist_ok=True)
if _DATA_DIR != _HERE:
    _src_configs = _HERE / "configs"
    if _src_configs.is_dir():
        shutil.copytree(_src_configs, _DATA_DIR / "configs", dirs_exist_ok=True)
os.chdir(_DATA_DIR)

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from rig import DEFAULT_MODEL_CKPT, RENAME_BONES_CHOICES, BpyServer, RigPipeline

HOST = os.environ.get("RIGTOOLS_HOST", "0.0.0.0")
PORT = int(os.environ.get("RIGTOOLS_PORT", "8300") or "8300")
MODEL_CKPT = os.environ.get("RIGTOOLS_MODEL_CKPT", DEFAULT_MODEL_CKPT)
HF_PATH = os.environ.get("RIGTOOLS_HF_PATH") or None
MAX_UPLOAD_BYTES = int(os.environ.get("RIGTOOLS_MAX_UPLOAD_BYTES", str(512 * 1024 * 1024)))
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "RIGTOOLS_ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3001"
    ).split(",")
    if o.strip()
]

SUPPORTED_EXT = {".glb", ".obj", ".fbx"}

app = FastAPI(title="3D Gen Studio — Rigging", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}

# Rigging is GPU-bound and single-threaded in practice; serialize requests and
# share one warm pipeline + bpy_server across them.
_lock = threading.Lock()
_bpy: BpyServer | None = None
_pipeline: RigPipeline | None = None


def _ensure_ready(report) -> RigPipeline:
    """Start the bpy_server and load the model once (idempotent, warm afterwards)."""
    global _bpy, _pipeline
    if _bpy is None:
        report("init", 0.01, "Starting Blender worker…")
        _bpy = BpyServer().start()
    if _pipeline is None:
        report("model", 0.03, "Loading rig model (first run may take a minute)…")
        _pipeline = RigPipeline(model_ckpt=MODEL_CKPT, hf_path=HF_PATH).load()
    return _pipeline


def _glb_bone_count(path: Path) -> int | None:
    """Best-effort count of skeleton joints in a GLB (parses the JSON chunk only)."""
    try:
        with open(path, "rb") as f:
            data = f.read()
        if data[:4] != b"glTF":
            return None
        # 12-byte header, then chunks: [uint32 length][uint32 type][data].
        length = struct.unpack_from("<I", data, 12)[0]
        chunk = data[20:20 + length]
        doc = json.loads(chunk.decode("utf-8"))
        skins = doc.get("skins") or []
        if not skins:
            return None
        return sum(len(s.get("joints", [])) for s in skins)
    except Exception:
        return None


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


def _parse_options(raw: str | None) -> dict:
    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid options JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="options must be a JSON object.")

    rename = data.get("rename_bones", "mixamo")
    if rename not in RENAME_BONES_CHOICES:
        raise HTTPException(
            status_code=422,
            detail=f"rename_bones must be one of {RENAME_BONES_CHOICES}, got {rename!r}.",
        )

    def _num(key, default, cast):
        try:
            return cast(data[key]) if key in data and data[key] is not None else default
        except (TypeError, ValueError):
            return default

    return dict(
        use_transfer=bool(data.get("use_transfer", True)),
        use_postprocess=bool(data.get("use_postprocess", False)),
        rename_bones=rename,
        use_skeleton=bool(data.get("use_skeleton", False)),
        top_k=_num("top_k", 5, int),
        top_p=_num("top_p", 0.95, float),
        temperature=_num("temperature", 1.0, float),
        repetition_penalty=_num("repetition_penalty", 2.0, float),
        num_beams=_num("num_beams", 10, int),
        # Not a rig() argument — popped off before the call. When False, the model
        # is freed from memory after the rig (next request reloads it).
        keep_loaded=bool(data.get("keep_loaded", True)),
    )


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model_loaded": _pipeline is not None,
        "bpy_ready": _bpy is not None,
    }


@app.post("/meshes/rig")
async def rig(
    meshFile: UploadFile = File(...),
    options: str | None = Form(None),
    format: str = Form("glb"),
) -> StreamingResponse:
    opts = _parse_options(options)
    keep_loaded = opts.pop("keep_loaded", True)
    data = await meshFile.read()
    if not data:
        raise HTTPException(status_code=400, detail="meshFile is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="meshFile exceeds the maximum allowed size.")

    src_name = meshFile.filename or "mesh.glb"
    ext = Path(src_name).suffix.lower()
    if ext not in SUPPORTED_EXT:
        ext = ".glb"

    events: "queue.Queue" = queue.Queue()
    holder: dict = {}

    def emit(stage, frac, message=""):
        events.put({"type": "progress", "stage": stage, "frac": round(float(frac), 4), "message": message})

    def worker():
        tmpdir = Path(tempfile.mkdtemp(prefix="rig_"))
        in_path = tmpdir / f"input{ext}"
        out_path = tmpdir / "rigged.glb"
        try:
            in_path.write_bytes(data)
            # Only one rig at a time — the model + bpy_server are shared singletons.
            with _lock:
                pipeline = _ensure_ready(emit)
                pipeline.rig(
                    in_path,
                    out_path,
                    progress=emit,
                    **opts,
                )
                # Free the model unless the user asked to keep it warm. Done under
                # the lock so no other request sees a half-unloaded pipeline; the
                # next rig reloads it via _ensure_ready.
                if not keep_loaded:
                    global _pipeline
                    emit("unload", 0.99, "Unloading model from memory…")
                    pipeline.unload()
                    _pipeline = None
            payload = out_path.read_bytes()
            holder["payload"] = {
                "format": "glb",
                "mesh_b64": base64.b64encode(payload).decode("ascii"),
                "stats": {
                    "tool": {
                        "bones": _glb_bone_count(out_path),
                        "rename_bones": opts["rename_bones"],
                        "transfer": opts["use_transfer"],
                        "postprocess": opts["use_postprocess"],
                    },
                },
                "preview_b64": None,
            }
        except Exception as exc:  # noqa: BLE001 — surfaced to the client as an error event
            holder["error"] = f"Rigging failed: {exc}"
        finally:
            for p in (in_path, out_path):
                try:
                    p.unlink()
                except OSError:
                    pass
            try:
                tmpdir.rmdir()
            except OSError:
                pass
            events.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def generate():
        yield _sse({"type": "progress", "stage": "start", "frac": 0.0, "message": "Rigging starting…"})
        while True:
            try:
                item = events.get(timeout=15)
            except queue.Empty:
                # Long silent stages (model load, autoregressive generation) emit
                # nothing for a while; keep bytes flowing so the Node proxy's fetch
                # body timeout doesn't abort the stream.
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


if __name__ == "__main__":
    print(f"[rig-server] listening on http://{HOST}:{PORT}  (model={MODEL_CKPT})")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
