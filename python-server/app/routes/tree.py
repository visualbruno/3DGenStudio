"""Procedural tree endpoints.

    GET  /tree/presets    the species catalog (id, label, full spec) for the picker
    POST /tree/preview    spec -> skeleton polylines only, fast enough to scrub
    POST /tree/generate   spec -> GLB, streamed as SSE like the other mesh tools

These take a JSON body rather than a multipart upload, because a tree has no
input mesh -- the spec IS the input. That is also why they cannot reuse
routes/meshes.py's `_stream_tool`, which assumes a `meshFile`; they share the
SSE transport (routes/streaming.py) and nothing else.

The response envelope matches the mesh tools exactly ({format, mesh_b64, stats})
so the browser client can decode a tree with the same helper it uses for Auto UV.
"""
from __future__ import annotations

import base64

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from ..services.treegen import generate_tree, preview_skeleton, resolve_spec
from ..services.treegen.presets import preset_catalog
from .streaming import stream_payload

router = APIRouter(prefix="/tree", tags=["tree"])


class TreeRequest(BaseModel):
    """The three accepted ways to say which tree to build.

    `preset` names a shipped species; `spec` is a stored TreeSpec asset; both
    accept a `seed` re-roll and a sparse `overrides` patch from the slider panel.
    Precedence is resolved in one place -- services/treegen.resolve_spec.
    """

    spec: dict | None = Field(default=None, description="A full TreeSpec object (the stored asset).")
    preset: str | None = Field(default=None, description="Species preset id, e.g. 'oak'.")
    seed: int | None = Field(default=None, ge=0, le=2147483647, description="Re-roll seed.")
    overrides: dict | None = Field(default=None, description="Sparse patch applied over the base spec.")


class TreePreviewRequest(TreeRequest):
    quality: float = Field(default=0.2, gt=0.0, le=1.0,
                           description="Skeleton resolution for the preview. The default answers in ~100ms; "
                                       "1.0 matches the final mesh exactly but costs the full skeleton time.")


class TreeGenerateRequest(TreeRequest):
    format: str = Field(default="glb", description="Output format. Only 'glb' is supported today.")
    bark_texture_b64: str | None = Field(default=None,
                                         description="Base64 (or data: URL) image for the trunk bark, tiled along "
                                                     "the branch. Also used for the branches unless "
                                                     "branch_texture_b64 is given.")
    branch_texture_b64: str | None = Field(default=None,
                                           description="Separate base64 image for the thin wood. Supplying it splits "
                                                       "the bark into two materials (one extra draw call); omit it "
                                                       "and the whole tree wears the trunk texture.")
    leaf_images_b64: list[str] | None = Field(default=None, max_length=64,
                                              description="A LIST of leaf cut-outs (base64 PNGs with alpha). They are "
                                                          "composed into an atlas here and each card picks a tile at "
                                                          "random, so this is the field to use -- nobody has an atlas "
                                                          "lying around, they have leaf images.")
    leaf_atlas_b64: str | None = Field(default=None,
                                       description="A ready-made leaf atlas, for callers that already built one. "
                                                   "Ignored when leaf_images_b64 is supplied.")


def _resolve(request: TreeRequest):
    try:
        return resolve_spec(spec=request.spec, preset=request.preset,
                            seed=request.seed, overrides=request.overrides)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/presets")
async def presets() -> dict:
    return {"presets": preset_catalog()}


@router.post("/preview")
async def preview(request: TreePreviewRequest) -> dict:
    """Skeleton polylines only. Answers fast enough to redraw during a drag."""
    spec = _resolve(request)
    try:
        payload = await run_in_threadpool(preview_skeleton, spec, request.quality)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    payload["spec"] = spec.model_dump(mode="json")
    return payload


@router.post("/generate")
async def generate(request: TreeGenerateRequest) -> StreamingResponse:
    spec = _resolve(request)
    fmt = (request.format or "glb").lstrip(".").lower()
    if fmt != "glb":
        raise HTTPException(status_code=400, detail="Only 'glb' output is supported.")

    def run(emit):
        result = generate_tree(
            spec,
            bark_texture=request.bark_texture_b64,
            branch_texture=request.branch_texture_b64,
            leaf_images=request.leaf_images_b64,
            leaf_atlas=request.leaf_atlas_b64,
            on_progress=emit,
        )
        stats = result["stats"]
        return {
            "format": "glb",
            "mesh_b64": base64.b64encode(result["glb"]).decode("ascii"),
            "stats": {
                "vertex_count": stats["totals"]["vertices"],
                "face_count": stats["totals"]["faces"],
                "has_uv": True,
                "tool": stats,
            },
            # The spec rides back with the mesh so the client can store the
            # asset that regenerates it -- including the seed it actually used
            # when the request only asked for a preset.
            "spec": spec.model_dump(mode="json"),
            "preview_b64": None,
        }

    return stream_payload(run, "Tree generation")
