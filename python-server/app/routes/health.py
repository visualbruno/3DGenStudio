"""Health/readiness probe used by the Node backend to check connectivity."""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "3dgenstudio-meshtools"}
