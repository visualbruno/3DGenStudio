"""GPU closest-point-on-surface queries via NVIDIA Warp.

This module is imported *lazily* — only after `gpu.warp_cuda_available()` has
confirmed a working Warp+CUDA install — so the top-level `import warp` (and the
`@wp.kernel` compilation below) never runs on CPU-only machines.

`WarpSurfaceQuery` mirrors the slice of `trimesh.proximity.ProximityQuery` that
the projection stage uses: build once from the target mesh, then answer batched
closest-point queries, returning `(closest_points, face_ids)` exactly like
`ProximityQuery.on_surface` (minus the distance, which the caller discards).
"""
from __future__ import annotations
import numpy as np
import warp as wp


@wp.kernel
def _closest_point_kernel(mesh: wp.uint64,
                          points: wp.array(dtype=wp.vec3),
                          max_dist: wp.float32,
                          out_pts: wp.array(dtype=wp.vec3),
                          out_face: wp.array(dtype=wp.int32)):
    i = wp.tid()
    p = points[i]
    query = wp.mesh_query_point_no_sign(mesh, p, max_dist)
    if query.result:
        out_pts[i] = wp.mesh_eval_position(mesh, query.face, query.u, query.v)
        out_face[i] = query.face
    else:
        # No hit within max_dist (shouldn't happen given the generous cap):
        # leave the point where it is and point at face 0 so the caller's
        # normal-agreement guard simply rejects the (zero) move.
        out_pts[i] = p
        out_face[i] = wp.int32(0)


class WarpSurfaceQuery:
    """One-time BVH build over `target_mesh`, then GPU closest-point queries."""

    def __init__(self, target_mesh, device: str = "cuda"):
        self.device = device
        V = np.ascontiguousarray(target_mesh.vertices, dtype=np.float32)
        F = np.ascontiguousarray(np.asarray(target_mesh.faces).reshape(-1), dtype=np.int32)
        with wp.ScopedDevice(device):
            self._points = wp.array(V, dtype=wp.vec3)
            self._indices = wp.array(F, dtype=wp.int32)
            self.mesh = wp.Mesh(points=self._points, indices=self._indices)
        # Generous search cap so the BVH query always reaches the surface; the
        # remesh already rides close to the original, so this only bounds the
        # (rare) worst case.
        diag = float(np.linalg.norm(target_mesh.extents))
        self._max_dist = float(max(diag * 4.0, 1e-6))

    def on_surface(self, pts):
        pts = np.ascontiguousarray(pts, dtype=np.float32)
        n = len(pts)
        with wp.ScopedDevice(self.device):
            q = wp.array(pts, dtype=wp.vec3)
            out_pts = wp.zeros(n, dtype=wp.vec3)
            out_face = wp.zeros(n, dtype=wp.int32)
            wp.launch(_closest_point_kernel, dim=n,
                      inputs=[self.mesh.id, q, self._max_dist, out_pts, out_face])
            wp.synchronize()
            closest = out_pts.numpy().astype(np.float64)
            tid = out_face.numpy().astype(np.int64)
        return closest, tid

    def free(self):
        """Drop the device-side BVH and buffers. CPython refcounting runs each
        Warp array's finalizer immediately, returning the memory to Warp's pool;
        gpu.free_gpu_memory() then releases the pool to the driver."""
        self.mesh = None
        self._points = None
        self._indices = None
