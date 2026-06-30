# 3D Gen Studio — Mesh Tools (Python service)

A small FastAPI service for CPU/GPU-heavy mesh operations implemented in Python.
The Node backend (`server.js`) proxies browser requests here, exactly like it
proxies to ComfyUI — so this service can run on the same machine or a different
host/port, configured under **Settings → Mesh Tools (Python) server**.

```
Browser ──POST /api/meshes/auto-uv──▶ Node (server.js) ──POST /meshes/auto-uv──▶ Python (this service)
                                          ◀── processed GLB ──────────────────────┘
```

## Endpoints

| Method | Path                 | Purpose                              |
| ------ | -------------------- | ------------------------------------ |
| GET    | `/health`            | Readiness probe                      |
| POST   | `/meshes/auto-uv`    | Auto UV unwrap                       |
| POST   | `/meshes/auto-retopo`| Auto retopology                      |

Both mesh endpoints take `multipart/form-data`:

- `meshFile` — the mesh (GLB/OBJ/PLY/STL)
- `options` — JSON string of operation options (optional)
- `format` — output format, default `glb` (optional)

They respond with the processed mesh as a binary body and stats in headers:
`X-Vertex-Count`, `X-Face-Count`, `X-Has-Uv`.

Interactive API docs at `http://<host>:<port>/docs`.

## Run

```bat
run.bat
```

First run creates `.venv`, installs `requirements.txt`, and serves on
`0.0.0.0:8200`. Override with env vars:

| Variable                   | Default                  |
| -------------------------- | ------------------------ |
| `MESHTOOLS_HOST`           | `0.0.0.0`                |
| `MESHTOOLS_PORT`           | `8200`                   |
| `MESHTOOLS_ALLOWED_ORIGINS`| dev origins              |
| `MESHTOOLS_MAX_UPLOAD_BYTES`| `536870912` (512 MB)    |
| `MESHTOOLS_WORK_DIR`       | OS temp / scratch folder |

## Pipelines

The two operations are backed by the bundled packages:

- `app/services/autouv/`     — the AutoUV unwrapper (`autouv.unwrap`)
- `app/services/autoretopo/` — the Auto-Retopo pipeline (`autoretopo.AutoRetopo`)

The thin bridges that the routes call:

- `app/services/auto_uv.py` → `run_auto_uv(mesh, options)` → `(trimesh, stats)`
- `app/services/auto_retopo.py` → `run_auto_retopo(mesh, options)` → `(trimesh, stats)`

Each receives a loaded `trimesh.Trimesh` and parsed options, and returns the
processed mesh plus a stats dict. Serialization, uploads, and error handling are
done in `app/routes/meshes.py`; the stats dict is returned to the browser in the
`X-Stats` response header. Every pipeline parameter is exposed in `app/schemas.py`
(`AutoUvOptions` / `AutoRetopoOptions`), which mirror `autouv.unwrap()` and
`autoretopo.RetopoConfig` 1:1.

## Layout

```
python-server/
├── main.py                  # FastAPI app + CORS + router wiring
├── requirements.txt
├── run.bat
└── app/
    ├── config.py            # host/port/limits from env vars
    ├── schemas.py           # option + stats models
    ├── meshio.py            # trimesh load/export/stats
    ├── routes/
    │   ├── health.py
    │   └── meshes.py        # /meshes/auto-uv, /meshes/auto-retopo
    └── services/
        ├── auto_uv.py       # bridge -> autouv.unwrap
        ├── auto_retopo.py   # bridge -> autoretopo.AutoRetopo
        ├── autouv/          # bundled AutoUV package
        └── autoretopo/      # bundled Auto-Retopo package
```
