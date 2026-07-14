"""Clean, headless rigging entry point for 3D Gen Studio.

Distilled from ``demo.py`` with all Gradio / web-UI code removed. It exposes a
reusable :class:`RigPipeline` (load the model once, rig many meshes) plus a
small CLI so a mesh can be rigged in a single command:

    python rig.py --input model.glb --output rigged.glb

The heavy Blender I/O (load / export / transfer) runs in a separate
``bpy_server.py`` process, exactly like the original demo, because ``bpy`` must
own its own process. The CLI starts that server automatically and tears it down
on exit. A long-running service can instead manage :class:`BpyServer` itself and
keep a single :class:`RigPipeline` warm across requests.

Prerequisite (run once): ``python download.py --model`` to fetch the checkpoints.
Requires an NVIDIA GPU with >= 14 GB of memory.
"""

import argparse
import atexit
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import List, Optional

os.environ["XFORMERS_IGNORE_FLASH_VERSION_CHECK"] = "1"

import requests
from torch import Tensor
from tqdm import tqdm

from src.data.dataset import DatasetConfig, RigDatasetModule
from src.data.transform import Transform
from src.data.vertex_group import voxel_skin
from src.model.tokenrig import TokenRigResult
from src.rig_package.skeleton_template import (
    SKELETON_TEMPLATE_KEYS,
    apply_asset_joint_name_template,
    normalize_skeleton_template,
)
from src.server.spec import (
    BPY_SERVER,
    bytes_to_object,
    get_model,
    object_to_bytes,
)
from src.tokenizer.parse import get_tokenizer

# Recommended TokenRig checkpoint (ArticulationXL 2.0 + VRoid + ModelsResource, GRPO refined).
DEFAULT_MODEL_CKPT = "experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt"

# Bone-naming templates supported by the underlying skeleton_template module.
#   "original" -> keep the model's own bone names
#   "mixamo"   -> Mixamo humanoid naming (mixamorig:Hips, ...)
#   "ue5"      -> Unreal Engine 5 humanoid naming (pelvis, spine_01, ...)
RENAME_BONES_CHOICES = list(SKELETON_TEMPLATE_KEYS)  # ["original", "mixamo", "ue5"]

SUPPORTED_EXT = {".obj", ".fbx", ".glb"}


class BpyServer:
    """Manages the lifecycle of the ``bpy_server.py`` Blender worker process.

    Usable as a context manager::

        with BpyServer():
            pipeline.rig(...)
    """

    def __init__(self, timeout: float = 60.0):
        self._timeout = timeout
        self._proc: Optional[subprocess.Popen] = None

    def start(self) -> "BpyServer":
        if self._proc is not None:
            return self

        # Launch bpy_server.py by ABSOLUTE path with cwd pinned to this code dir.
        # The main process may run with a different cwd (e.g. the packaged app
        # points it at a writable model-data dir), so relying on a relative
        # "bpy_server.py" / the inherited cwd would break. Its `from src...`
        # imports resolve via sys.path (the script's own dir), and it only writes
        # to explicit temp paths, so a read-only code dir as cwd is fine.
        here = Path(__file__).resolve().parent
        popen_kwargs = dict(
            args=[sys.executable, str(here / "bpy_server.py")],
            cwd=str(here),
            stdout=None,
            stderr=None,
        )
        if os.name == "nt":
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_kwargs["preexec_fn"] = os.setsid

        self._proc = subprocess.Popen(**popen_kwargs)
        print(f"[rig] bpy_server.py started (pid={self._proc.pid})")
        atexit.register(self.stop)
        self._wait_ready()
        return self

    def _wait_ready(self) -> None:
        t0 = time.time()
        while True:
            try:
                requests.get(f"{BPY_SERVER}/ping", timeout=1)
                print("[rig] bpy_server is ready")
                return
            except Exception:
                if self._proc is not None and self._proc.poll() is not None:
                    raise RuntimeError("bpy_server exited before becoming ready")
                if time.time() - t0 > self._timeout:
                    raise RuntimeError("bpy_server failed to start")
                time.sleep(0.5)

    def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None or proc.poll() is not None:
            return
        print(f"[rig] terminating bpy_server.py (pid={proc.pid})")
        try:
            if os.name == "nt":
                proc.terminate()
            else:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass

    def __enter__(self) -> "BpyServer":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()


def _post_bpy_payload(endpoint: str, payload) -> object:
    """POST a torch-serialized payload to the bpy_server and return the result."""
    payload_path = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f"skintokens_{endpoint}_", suffix=".pt", delete=False
        ) as f:
            f.write(object_to_bytes(payload))
            payload_path = f.name
        response = requests.post(
            f"{BPY_SERVER}/{endpoint}",
            data=object_to_bytes({"payload_path": payload_path}),
        )
        response.raise_for_status()
        result = bytes_to_object(response.content)
        if isinstance(result, dict) and result.get("error") is not None:
            raise RuntimeError(result.get("traceback") or result["error"])
        return result
    finally:
        if payload_path is not None:
            try:
                os.remove(payload_path)
            except OSError:
                pass


class RigPipeline:
    """Loads the TokenRig model once and rigs meshes.

    A ``bpy_server`` must be running (see :class:`BpyServer`) for export/transfer.
    """

    def __init__(
        self,
        model_ckpt: str = DEFAULT_MODEL_CKPT,
        hf_path: Optional[str] = None,
        device: str = "cuda",
    ):
        self.model_ckpt = model_ckpt
        self.hf_path = hf_path
        self.device = device
        self.model = None
        self.tokenizer = None
        self.transform = None

    def load(self) -> "RigPipeline":
        """Load model + tokenizer + transform onto the device (idempotent)."""
        if self.model is not None:
            return self
        print(f"[rig] loading model: {self.model_ckpt} (hf_path={self.hf_path})")
        self.model = get_model(self.model_ckpt, hf_path=self.hf_path, device=self.device)
        assert self.model.tokenizer_config is not None
        self.tokenizer = get_tokenizer(**self.model.tokenizer_config)
        self.transform = Transform.parse(
            **self.model.transform_config["predict_transform"]
        )
        print("[rig] model loaded")
        return self

    def unload(self) -> None:
        """Free the model from (GPU) memory. A subsequent rig() reloads it.

        Note: this returns the model's allocations to CUDA's caching allocator and
        empties that cache, but the process's CUDA context + library workspaces
        (cuDNN/cuBLAS/flash-attn) stay resident for the process lifetime — so some
        GPU memory (typically ~1 GB) remains in use until the service exits.
        """
        import gc

        # Drop every reference to the model / its submodules first.
        self.model = None
        self.tokenizer = None
        self.transform = None

        # Collect BEFORE emptying the cache — torch module graphs contain
        # reference cycles that only gc breaks; freeing them first lets
        # empty_cache actually reclaim their blocks. A second pass mops up
        # anything the first pass resurrected via finalizers.
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
                gc.collect()
                torch.cuda.empty_cache()
        except Exception:
            pass
        print("[rig] model unloaded")

    def rig(
        self,
        input_path,
        output_path,
        *,
        use_transfer: bool = True,
        use_postprocess: bool = False,
        rename_bones: str = "mixamo",
        use_skeleton: bool = False,
        top_k: int = 5,
        top_p: float = 0.95,
        temperature: float = 1.0,
        repetition_penalty: float = 2.0,
        num_beams: int = 10,
        progress=None,
    ) -> Path:
        """Rig a single mesh and write the result to ``output_path`` (.glb).

        Args:
            use_transfer: Transfer the rig onto the original mesh, preserving its
                texture and scale (recommended). If False, exports the internally
                normalized/processed mesh instead.
            use_postprocess: Apply voxel-based skin cleanup to reduce weight bleed.
            rename_bones: One of ``"original"``, ``"mixamo"``, ``"ue5"``.
            use_skeleton: Reuse an existing skeleton in the input (skin-only).
            progress: Optional ``callable(stage: str, frac: float, message: str)``
                invoked as the pipeline advances (0.0 -> 1.0). Used by the rig
                service to stream live progress to 3D Gen Studio.
        """
        outputs = self._run(
            [Path(input_path)],
            [Path(output_path)],
            use_transfer=use_transfer,
            use_postprocess=use_postprocess,
            rename_bones=rename_bones,
            use_skeleton=use_skeleton,
            top_k=top_k,
            top_p=top_p,
            temperature=temperature,
            repetition_penalty=repetition_penalty,
            num_beams=num_beams,
            progress=progress,
        )
        return outputs[0]

    def _run(
        self,
        filepaths: List[Path],
        output_paths: List[Path],
        *,
        use_transfer: bool,
        use_postprocess: bool,
        rename_bones: str,
        use_skeleton: bool,
        top_k: int,
        top_p: float,
        temperature: float,
        repetition_penalty: float,
        num_beams: int,
        progress=None,
    ) -> List[Path]:
        assert len(filepaths) == len(output_paths)

        def report(stage: str, frac: float, message: str) -> None:
            if progress is not None:
                progress(stage, frac, message)

        if self.model is None:
            report("model", 0.02, "Loading rig model…")
            self.load()

        template = normalize_skeleton_template(rename_bones)

        datapath = {
            "data_name": None,
            "loader": "bpy_server",
            "filepaths": {"articulation": [str(p) for p in filepaths]},
        }
        dataset_config = DatasetConfig.parse(
            shuffle=False,
            batch_size=1,
            num_workers=1,
            pin_memory=True,
            persistent_workers=False,
            datapath=datapath,
        ).split_by_cls()

        module = RigDatasetModule(
            predict_dataset_config=dataset_config,
            predict_transform=self.transform,
            tokenizer=self.tokenizer,
            process_fn=self.model._process_fn,
        )
        dataloader = module.predict_dataloader()["articulation"]

        results_out: List[Path] = []
        n = len(dataloader)
        for i, batch in tqdm(enumerate(dataloader), total=n):
            # Fraction covered by earlier meshes in a batch run, so multi-mesh
            # progress advances smoothly rather than resetting each iteration.
            base = 0.05 + (i / max(n, 1)) * 0.9
            span = 0.9 / max(n, 1)
            report("load", base, f"Loading mesh {i + 1}/{n}…")

            batch = {
                k: v.to(self.device) if isinstance(v, Tensor) else v
                for k, v in batch.items()
            }

            if not use_skeleton:
                batch.pop("skeleton_tokens", None)
                batch.pop("skeleton_mask", None)

            batch["generate_kwargs"] = dict(
                max_length=2048,
                top_k=int(top_k),
                top_p=float(top_p),
                temperature=float(temperature),
                repetition_penalty=float(repetition_penalty),
                num_return_sequences=1,
                num_beams=int(num_beams),
                do_sample=True,
            )

            if "skeleton_tokens" in batch and "skeleton_mask" in batch:
                mask = batch["skeleton_mask"][0] == 1
                skeleton_tokens = batch["skeleton_tokens"][0][mask].cpu().numpy()
            else:
                skeleton_tokens = None

            report("generate", base + span * 0.15, "Generating skeleton & skin…")
            preds: List[TokenRigResult] = self.model.predict_step(
                batch,
                skeleton_tokens=[skeleton_tokens] if skeleton_tokens is not None else None,
                make_asset=True,
            )["results"]

            asset = preds[0].asset
            assert asset is not None

            report("rename", base + span * 0.75, f"Renaming bones → {template}…")
            print(f"[rig] renaming bones -> {template}")
            asset.joint_names = apply_asset_joint_name_template(
                joint_names=asset.joint_names,
                joints=asset.joints,
                parents=asset.parents,
                template=template,
            )

            if use_postprocess:
                report("postprocess", base + span * 0.8, "Voxel-skin postprocess…")
                print("[rig] applying voxel-skin postprocess")
                voxel = asset.voxel(resolution=196)
                asset.skin *= voxel_skin(
                    grid=0,
                    grid_coords=voxel.coords,
                    joints=asset.joints,
                    vertices=asset.vertices,
                    faces=asset.faces,
                    mode="square",
                    voxel_size=voxel.voxel_size,
                )
                asset.normalize_skin()

            out_path = output_paths[i]
            out_path.parent.mkdir(parents=True, exist_ok=True)

            report("export", base + span * 0.9,
                   "Transferring rig onto mesh…" if use_transfer else "Exporting rigged GLB…")
            if use_transfer:
                res = _post_bpy_payload(
                    "transfer",
                    dict(
                        source_asset=asset,
                        target_path=asset.path,
                        export_path=str(out_path),
                        group_per_vertex=4,
                    ),
                )
            else:
                res = _post_bpy_payload(
                    "export",
                    dict(
                        asset=asset,
                        filepath=str(out_path),
                        group_per_vertex=4,
                    ),
                )

            if res != "ok":
                raise RuntimeError(f"bpy_server returned: {res}")
            print(f"[rig] exported: {out_path}")
            results_out.append(out_path)

            # Drop this iteration's GPU tensors so they don't pile up across a
            # multi-mesh run (preds/batch hold the generated tensors + inputs).
            del preds, asset, batch

        # Release everything that references the model before returning, so a
        # subsequent unload() can actually free it. The DataLoader + dataset
        # module hold the model via process_fn (and a num_workers loader keeps a
        # worker alive), so tear them down explicitly rather than waiting on GC.
        try:
            if hasattr(dataloader, "_iterator") and dataloader._iterator is not None:
                dataloader._iterator._shutdown_workers()
        except Exception:
            pass
        del dataloader, module, dataset_config

        report("done", 1.0, "Rigging complete.")
        return results_out


def _collect_files(input_path: Path) -> List[Path]:
    if input_path.is_file():
        return [input_path]
    return [
        p for p in input_path.rglob("*") if p.suffix.lower() in SUPPORTED_EXT
    ]


def _map_output_path(in_path: Path, input_root: Path, output_root: Path) -> Path:
    rel = in_path.relative_to(input_root)
    return (output_root / rel).with_suffix(".glb")


def _resolve_outputs(files: List[Path], input_path: Path, output_path: Path) -> List[Path]:
    if len(files) == 1 and output_path.suffix:
        return [output_path]
    return [_map_output_path(f, input_path, output_path) for f in files]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Rig a 3D mesh with SkinTokens/TokenRig (headless)."
    )
    parser.add_argument("--input", required=True, help="Input file or directory (.obj/.fbx/.glb)")
    parser.add_argument("--output", required=True, help="Output file or directory (.glb)")

    # Core rigging options requested by 3D Gen Studio.
    transfer = parser.add_mutually_exclusive_group()
    transfer.add_argument(
        "--use_transfer",
        dest="use_transfer",
        action="store_true",
        help="Transfer rig onto the original mesh, preserving texture and scale (default).",
    )
    transfer.add_argument(
        "--no_transfer",
        dest="use_transfer",
        action="store_false",
        help="Export the internally processed mesh instead of transferring.",
    )
    parser.set_defaults(use_transfer=True)

    parser.add_argument(
        "--use_postprocess",
        action="store_true",
        help="Apply voxel-based skin postprocessing.",
    )
    parser.add_argument(
        "--rename_bones",
        choices=RENAME_BONES_CHOICES,
        default="mixamo",
        help="Bone naming template (default: mixamo).",
    )
    parser.add_argument(
        "--use_skeleton",
        action="store_true",
        help="Reuse an existing skeleton in the input (skin-only).",
    )

    # Generation parameters (sensible defaults from the reference demo).
    parser.add_argument("--top_k", type=int, default=5)
    parser.add_argument("--top_p", type=float, default=0.95)
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--repetition_penalty", type=float, default=2.0)
    parser.add_argument("--num_beams", type=int, default=10)

    parser.add_argument("--model_ckpt", default=DEFAULT_MODEL_CKPT)
    parser.add_argument("--hf_path", default=None)

    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()

    files = _collect_files(input_path)
    if not files:
        raise RuntimeError(f"No valid 3D files found under: {input_path}")
    outputs = _resolve_outputs(files, input_path, output_path)

    # When driven as a subprocess (e.g. the rig service's "cold" path), stream
    # progress as JSON lines on stdout so the parent can forward them; otherwise
    # progress is just the tqdm bar. Enabled via RIG_PROGRESS_JSON=1.
    progress = None
    if os.environ.get("RIG_PROGRESS_JSON"):
        import json as _json

        def progress(stage, frac, message=""):  # noqa: E306
            print(f"@@RP@@{_json.dumps({'stage': stage, 'frac': frac, 'message': message})}", flush=True)

    pipeline = RigPipeline(model_ckpt=args.model_ckpt, hf_path=args.hf_path)
    if progress:
        progress("init", 0.01, "Starting Blender worker…")
    with BpyServer():
        if progress:
            progress("model", 0.03, "Loading rig model…")
        pipeline.load()
        pipeline._run(
            files,
            outputs,
            use_transfer=args.use_transfer,
            use_postprocess=args.use_postprocess,
            rename_bones=args.rename_bones,
            use_skeleton=args.use_skeleton,
            top_k=args.top_k,
            top_p=args.top_p,
            temperature=args.temperature,
            repetition_penalty=args.repetition_penalty,
            num_beams=args.num_beams,
            progress=progress,
        )

    print(f"[rig] done. {len(outputs)} mesh(es) rigged.")


if __name__ == "__main__":
    main()
