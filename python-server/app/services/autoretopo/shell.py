"""Stage 1 - watertight silhouette shell.

The user's goal: "follow the silhouette of the mesh and generate a new layer of
faces that is watertight." We do this with a robust occupancy field rather than a
signed-distance field, because the input is typically a non-manifold triangle soup
(the BabyRaptor test mesh has 810 disconnected components) for which the *sign* of
an SDF is undefined and MeshLab-style resampling fragments.

Method:
  1. Surface-voxelize the mesh at pitch = diag / resolution (memory-bounded, below).
  2. Morphologically close (dilate) to bridge unwelded cracks between patches.
  3. Flood-fill the interior (binary_fill_holes) -> a solid occupancy volume.
     Enclosed cavities are filled; genuine openings (e.g. an open mouth wider than
     the voxel pitch) stay open.
  4. Erode back to undo the dilation bias, then union the original surface voxels.
  5. Blur the occupancy field slightly and extract the 0.5 iso-surface with
     marching cubes -> a single, guaranteed-watertight, 2-manifold triangle mesh
     that tightly tracks the outer silhouette.

The result is dense (it is an intermediate); the remesh stage decimates it to the
face budget with clean topology.

Memory note
-----------
We do NOT use trimesh's `mesh.voxelized()`: it subdivides every triangle until its
edges are below the voxel pitch, so its peak memory scales with surface_area/pitch^2
AND with triangle size (a single large face quadruples per subdivision level). That
makes RAM explode unpredictably on coarse or uneven meshes. `bounded_surface_voxelize`
instead streams an area-proportional barycentric lattice straight into the grid in
chunks, so peak memory depends only on the grid size and a fixed chunk - never on the
input triangle count or size.
"""
from __future__ import annotations
import numpy as np
import trimesh
from scipy import ndimage
from skimage import measure


def _lattice_bary(k: int) -> np.ndarray:
    """Barycentric lattice for subdivision level k: (i/k, j/k, 1-i/k-j/k), i+j<=k."""
    ij = np.array([(i, j) for i in range(k + 1) for j in range(k + 1 - i)], float)
    a = ij[:, 0] / k
    b = ij[:, 1] / k
    return np.stack([a, b, 1.0 - a - b], axis=1)            # (P, 3)


def bounded_surface_voxelize(mesh, pitch, samples_per_pitch=2.0, kmax=128, chunk=200_000):
    """Memory-bounded surface voxelization.

    Returns (occupancy_grid: bool[X,Y,Z], origin: float[3]). The occupancy is the set
    of voxels touched by the surface, sampled densely enough (lattice spacing <=
    pitch/samples_per_pitch) that flood-fill cannot leak through. Peak memory is
    O(grid + chunk), independent of triangle size distribution.
    """
    lo = mesh.bounds[0].astype(np.float64)
    hi = mesh.bounds[1].astype(np.float64)
    pad = 3
    dims = (np.ceil((hi - lo) / pitch).astype(int) + 1 + 2 * pad)
    origin = lo - pad * pitch
    grid = np.zeros(tuple(int(d) for d in dims), dtype=bool)
    dmax = np.array(dims, np.int32) - 1

    tris = np.asarray(mesh.triangles, np.float64)           # (F, 3, 3)
    if len(tris) == 0:
        return grid, origin
    edges = np.stack([
        np.linalg.norm(tris[:, 1] - tris[:, 0], axis=1),
        np.linalg.norm(tris[:, 2] - tris[:, 1], axis=1),
        np.linalg.norm(tris[:, 0] - tris[:, 2], axis=1)], axis=1)
    spacing = pitch / float(samples_per_pitch)
    k = np.clip(np.ceil(edges.max(1) / spacing).astype(int), 1, int(kmax))

    for kk in np.unique(k):
        sel = np.where(k == kk)[0]
        bary = _lattice_bary(int(kk))                       # (P, 3)
        P = len(bary)
        step = max(1, chunk // max(P, 1))                   # rows per chunk so rows*P<=chunk
        for s in range(0, len(sel), step):
            T = tris[sel[s:s + step]]                       # (m, 3, 3)
            pts = np.einsum("pj,mjc->mpc", bary, T).reshape(-1, 3)
            vi = np.floor((pts - origin) / pitch).astype(np.int32)
            np.clip(vi, 0, dmax, out=vi)
            grid[vi[:, 0], vi[:, 1], vi[:, 2]] = True
    return grid, origin


def voxel_shell(mesh: trimesh.Trimesh, resolution: int = 256,
                close_iter: int = 1, smooth_sigma: float = 0.6,
                samples_per_pitch: float = 2.0):
    diag = float(np.linalg.norm(mesh.extents))
    pitch = diag / max(32, int(resolution))

    dense, origin = bounded_surface_voxelize(mesh, pitch, samples_per_pitch)
    if not dense.any():
        raise RuntimeError("Voxelization produced an empty volume; lower shell_resolution.")

    solid = ndimage.binary_dilation(dense, iterations=close_iter) if close_iter else dense.copy()
    solid = ndimage.binary_fill_holes(solid)
    if close_iter:
        solid = ndimage.binary_erosion(solid, iterations=close_iter)
    solid |= dense
    del dense

    # blur in place-ish, then free the bool volume before marching cubes allocates
    field = ndimage.gaussian_filter(solid.astype(np.float32), float(smooth_sigma))
    del solid
    verts, faces, _, _ = measure.marching_cubes(field, level=0.5)
    del field

    V = verts * pitch + origin
    return np.ascontiguousarray(V), np.ascontiguousarray(faces.astype(np.int64))


def estimate_grid_voxels(mesh, resolution):
    """Predict the occupancy grid size (voxels) for a memory guard, without building it."""
    diag = float(np.linalg.norm(mesh.extents))
    pitch = diag / max(32, int(resolution))
    dims = np.ceil(mesh.extents / pitch).astype(int) + 7
    return int(np.prod(dims)), pitch


# The shell stage's peak memory is dominated by a handful of full-grid arrays
# (bool occupancy + dilations + fill + a float32 field + marching-cubes output).
# Empirically that is ~12 bytes per voxel of peak working set.
_BYTES_PER_VOXEL = 12.0
_SHELL_RESERVE_MB = 260.0           # base interpreter + later pymeshlab working set


def fit_resolution_to_budget(mesh, resolution, max_memory_gb):
    """Lower `resolution` until the predicted shell grid fits the memory budget.
    Returns (resolution, predicted_peak_mb). A no-op when it already fits."""
    if not max_memory_gb:
        return int(resolution), None
    budget_mb = float(max_memory_gb) * 1024.0
    res = int(resolution)
    while res > 64:
        nvox, _ = estimate_grid_voxels(mesh, res)
        peak_mb = _SHELL_RESERVE_MB + nvox * _BYTES_PER_VOXEL / 1e6
        if peak_mb <= budget_mb:
            return res, peak_mb
        res -= 16
    nvox, _ = estimate_grid_voxels(mesh, res)
    return res, _SHELL_RESERVE_MB + nvox * _BYTES_PER_VOXEL / 1e6


def largest_component(V, F):
    from .meshutil import largest_component as _lc
    return _lc(V, F)
