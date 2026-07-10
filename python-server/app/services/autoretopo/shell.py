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
from skimage import measure

from .gpu import resolve_backend


def _lattice_bary(k: int) -> np.ndarray:
    """Barycentric lattice for subdivision level k: (i/k, j/k, 1-i/k-j/k), i+j<=k."""
    ij = np.array([(i, j) for i in range(k + 1) for j in range(k + 1 - i)], float)
    a = ij[:, 0] / k
    b = ij[:, 1] / k
    return np.stack([a, b, 1.0 - a - b], axis=1)            # (P, 3)


def bounded_surface_voxelize(mesh, pitch, samples_per_pitch=2.0, kmax=128,
                             chunk=200_000, backend=None):
    """Memory-bounded surface voxelization.

    Returns (occupancy_grid: bool[X,Y,Z], origin: float[3]). The occupancy is the set
    of voxels touched by the surface, sampled densely enough (lattice spacing <=
    pitch/samples_per_pitch) that flood-fill cannot leak through. Peak memory is
    O(grid + chunk), independent of triangle size distribution.

    The grid lives on `backend`'s array module (CuPy on GPU, NumPy on CPU); the
    barycentric lattice, einsum scatter and clamp all run there. `origin` stays a
    NumPy array — it is consumed on the host after marching cubes.
    """
    be = backend or resolve_backend("cpu")
    xp = be.xp
    lo = mesh.bounds[0].astype(np.float64)
    hi = mesh.bounds[1].astype(np.float64)
    pad = 3
    dims = (np.ceil((hi - lo) / pitch).astype(int) + 1 + 2 * pad)
    origin = lo - pad * pitch
    grid = xp.zeros(tuple(int(d) for d in dims), dtype=bool)
    dmax = xp.asarray(np.array(dims, np.int32) - 1)
    origin_x = xp.asarray(origin)

    tris = np.asarray(mesh.triangles, np.float64)           # (F, 3, 3)
    if len(tris) == 0:
        return grid, origin
    # Edge lengths / subdivision level `k` are cheap and stay on the host so the
    # np.unique bucketing below drives the (GPU or CPU) scatter loop identically.
    edges = np.stack([
        np.linalg.norm(tris[:, 1] - tris[:, 0], axis=1),
        np.linalg.norm(tris[:, 2] - tris[:, 1], axis=1),
        np.linalg.norm(tris[:, 0] - tris[:, 2], axis=1)], axis=1)
    spacing = pitch / float(samples_per_pitch)
    k = np.clip(np.ceil(edges.max(1) / spacing).astype(int), 1, int(kmax))

    for kk in np.unique(k):
        sel = np.where(k == kk)[0]
        bary = xp.asarray(_lattice_bary(int(kk)))           # (P, 3)
        P = len(bary)
        step = max(1, chunk // max(P, 1))                   # rows per chunk so rows*P<=chunk
        for s in range(0, len(sel), step):
            T = xp.asarray(tris[sel[s:s + step]])           # (m, 3, 3)
            pts = xp.einsum("pj,mjc->mpc", bary, T).reshape(-1, 3)
            vi = xp.floor((pts - origin_x) / pitch).astype(xp.int32)
            vi = xp.clip(vi, 0, dmax)
            grid[vi[:, 0], vi[:, 1], vi[:, 2]] = True
    return grid, origin


def voxel_shell(mesh: trimesh.Trimesh, resolution: int = 256,
                close_iter: int = 1, smooth_sigma: float = 1.4,
                samples_per_pitch: float = 2.0, taubin_steps: int = 10,
                device: str = "auto"):
    """Watertight shell via an EDT signed-distance field.

    Earlier versions extracted the iso-surface from a *blurred binary* occupancy,
    which leaves voxel staircase ripple ("orange peel") that high face budgets then
    faithfully reproduce. Instead we build a signed distance field with two Euclidean
    distance transforms (outside minus inside): the zero level set is sub-voxel
    smooth, and because a distance field is locally linear, blurring it does not
    erode the shape the way blurring occupancy does - so `smooth_sigma` (in voxels)
    can be large enough (~1.5) to kill lattice ripple while belts, folds and other
    real features survive. A few Taubin passes on the dense shell remove what's
    left; the projection stage later restores exact geometry from the original.
    """
    be = resolve_backend(device)
    xp, ndi = be.xp, be.ndi
    diag = float(np.linalg.norm(mesh.extents))
    pitch = diag / max(32, int(resolution))

    # Grid ops (voxelize -> close -> EDT -> blur) run on the resolved backend;
    # marching cubes and Taubin below have no CUDA drop-in, so the field is
    # brought back to host memory before them.
    dense, origin = bounded_surface_voxelize(mesh, pitch, samples_per_pitch, backend=be)
    if not bool(dense.any()):
        raise RuntimeError("Voxelization produced an empty volume; lower shell_resolution.")

    solid = ndi.binary_dilation(dense, iterations=close_iter) if close_iter else dense.copy()
    solid = ndi.binary_fill_holes(solid)
    if close_iter:
        solid = ndi.binary_erosion(solid, iterations=close_iter)
    solid |= dense
    del dense

    # signed distance: positive outside, negative inside; zero level = surface
    sdf = ndi.distance_transform_edt(~solid).astype(xp.float32)
    sdf -= ndi.distance_transform_edt(solid).astype(xp.float32)
    del solid
    if smooth_sigma:
        sdf = ndi.gaussian_filter(sdf, float(smooth_sigma))
    sdf = be.tonumpy(sdf)
    verts, faces, _, _ = measure.marching_cubes(sdf, level=0.0)
    del sdf

    V = verts * pitch + origin
    F = np.ascontiguousarray(faces.astype(np.int64))

    if taubin_steps:
        import pymeshlab as ml
        ms = ml.MeshSet()
        ms.add_mesh(ml.Mesh(np.asarray(V, float), F))
        ms.apply_coord_taubin_smoothing(lambda_=0.5, mu=-0.53,
                                        stepsmoothnum=int(taubin_steps))
        mm = ms.current_mesh()
        V, F = mm.vertex_matrix(), mm.face_matrix().astype(np.int64)
    return np.ascontiguousarray(V), np.ascontiguousarray(F)


def estimate_grid_voxels(mesh, resolution):
    """Predict the occupancy grid size (voxels) for a memory guard, without building it."""
    diag = float(np.linalg.norm(mesh.extents))
    pitch = diag / max(32, int(resolution))
    dims = np.ceil(mesh.extents / pitch).astype(int) + 7
    return int(np.prod(dims)), pitch


# The shell stage's peak memory is dominated by a handful of full-grid arrays.
# With the EDT signed-distance path (bool solid + one float64 EDT transient + the
# float32 sdf + marching cubes output) the peak working set is ~28 bytes per voxel.
_BYTES_PER_VOXEL = 28.0
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
