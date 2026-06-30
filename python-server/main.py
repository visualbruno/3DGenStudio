"""Entry point for the 3D Gen Studio mesh-processing service.

Run directly:
    python main.py
or via uvicorn (auto-reload during development):
    uvicorn main:app --reload --host 0.0.0.0 --port 8200

The Node backend (server.js) proxies browser requests here; see
buildMeshToolsBaseUrl() in server.js and Settings > Mesh Tools (Python) server.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import config
from app.routes import health, meshes

app = FastAPI(
    title="3D Gen Studio — Mesh Tools",
    description="Python mesh-processing service (Auto UV, Auto Retopo, ...).",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Vertex-Count", "X-Face-Count", "X-Has-Uv", "X-Stats"],
)

app.include_router(health.router)
app.include_router(meshes.router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=config.HOST, port=config.PORT, reload=False)
