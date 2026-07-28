#!/usr/bin/env python3

"""Run pinned Kokoro v1.0 BF16 across a Goldflow TTS proof manifest.

The exact MLX checkpoint is loaded once, then every manifest passage is
synthesized to an untouched 24 kHz mono WAV. This runner does not normalize,
trim, fade, resample, de-click, crossfade, or apply post-TTS tempo processing.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import re
import time
from pathlib import Path
from typing import Any

import mlx.core as mx
import numpy as np
from huggingface_hub import snapshot_download
from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model


MODEL_NAME = "Kokoro v1.0 82M BF16"
MODEL_KIND = "kokoro_v1_0"
MODEL_SOURCE = "mlx-community/Kokoro-82M-bf16"
MODEL_REVISION = "a71e4d38b236d968966a2002c4c895dbd12b1c3c"
MODEL_LICENSE = "Apache-2.0"
MODEL_WEIGHTS_FILENAME = "kokoro-v1_0.safetensors"
MODEL_WEIGHTS_SHA256 = (
    "4e9ecdf03b8b6cf906070390237feda473dc13327cb8d56a43deaa374c02acd8"
)
MODEL_CONFIG_SHA256 = (
    "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f"
)
UPSTREAM_MODEL_SOURCE = "hexgrad/Kokoro-82M"
UPSTREAM_MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
UPSTREAM_MODEL_VERSION = "v1.0"
UPSTREAM_MODEL_WEIGHTS_SHA256 = (
    "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4"
)
RUNTIME_SOURCE = "Blaizzy/mlx-audio"
RUNTIME_REVISION = "d28d68c6ac4e28f7d2d66007f640b06cf3fd8ceb"
RUNTIME_VERSION = "0.4.6"
RUNTIME_LICENSE = "MIT"
RUNTIME_WHEEL_SHA256 = (
    "cd9c3958d50bf3f30fc78d64fc1b638f84961a6aadb0731582a5c16efe7bb7e5"
)
DEFAULT_VOICE = "af_heart"
VOICE_METADATA = {
    "af_heart": {
        "gender": "female",
        "grade": "A",
        "sha256": (
            "2c1c733b0e6576c810e268d3e440c21dea4e0f0131a3ba4cfc98d7fe6136d094"
        ),
    },
    "am_michael": {
        "gender": "male",
        "grade": "C+",
        "sha256": (
            "3940147ded35deba0bb52e8132f89b719298e0520258c34584358aa5a24da2ea"
        ),
    },
    "am_adam": {
        "gender": "male",
        "grade": "F+",
        "sha256": (
            "a4f60a3b9c20353c2604a17485ba53260502a758681a84d41e8af53cc559d929"
        ),
    },
    "am_echo": {
        "gender": "male",
        "grade": "D",
        "sha256": (
            "031fc608a900332c4e1a29bd0884f5d0e84bd0348261fa79981e5cbd138c950d"
        ),
    },
    "am_eric": {
        "gender": "male",
        "grade": "D",
        "sha256": (
            "1fb4a61dcee1f114f90886ecf29bc2feed05e29eed9caa6ddb109f1934d73274"
        ),
    },
    "am_fenrir": {
        "gender": "male",
        "grade": "C+",
        "sha256": (
            "9abed964b906c4cae6f404d9849e76260689aea862bc6ca85fc3f5207ba96538"
        ),
    },
    "am_liam": {
        "gender": "male",
        "grade": "D",
        "sha256": (
            "66b65a96e16c3d91035a6e9019d9986ed524d27ce35b487270cdf61c99e3ebad"
        ),
    },
    "am_onyx": {
        "gender": "male",
        "grade": "D",
        "sha256": (
            "b5d6132a5747648d98c82c9c4aaa9cf52d7230e63e403c1cb9c12858446ca5f5"
        ),
    },
    "am_puck": {
        "gender": "male",
        "grade": "C+",
        "sha256": (
            "9a8c2e56413bd2063f814cb4c3885fc425876157369117c3f8258d03c8a9ad89"
        ),
    },
    "am_santa": {
        "gender": "male",
        "grade": "D-",
        "sha256": (
            "d1f433b57ffccf105ea9e434ea19af6c2a8a7916ba6d1a73c34f0046bd226084"
        ),
    },
}
PASSAGE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run pinned Kokoro v1.0 BF16 across a proof manifest without "
            "shared audio post-processing."
        )
    )
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--model-id",
        default="kokoro_v1_0_bf16_af_heart_speed_1_2",
    )
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--lang-code", default="a")
    parser.add_argument("--native-speed", type=float, default=1.2)
    parser.add_argument("--seed", type=int, default=20260726)
    parser.add_argument(
        "--local-files-only",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Require the exact pinned snapshot to already be cached "
            "(default: true)."
        ),
    )
    parser.add_argument(
        "--resume",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Reuse exact-hash passage WAVs and sidecars (default: true).",
    )
    return parser.parse_args()


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def json_write(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def package_version(distribution: str) -> str | None:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None


def load_passages(manifest_path: Path) -> list[dict[str, str]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    raw_passages = manifest.get("passages") or []
    if not raw_passages:
        raise ValueError(f"No passages in {manifest_path}")
    seen_ids: set[str] = set()
    passages: list[dict[str, str]] = []
    for index, passage in enumerate(raw_passages):
        if not isinstance(passage, dict):
            raise ValueError(f"Passage {index} must be an object")
        passage_id = passage.get("id")
        text = passage.get("text")
        if (
            not isinstance(passage_id, str)
            or not PASSAGE_ID_PATTERN.fullmatch(passage_id)
        ):
            raise ValueError(
                f"Passage {index} has an unsafe or empty id: {passage_id!r}"
            )
        if passage_id in seen_ids:
            raise ValueError(f"Duplicate passage id: {passage_id}")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"Passage {passage_id} has empty text")
        seen_ids.add(passage_id)
        passages.append({"id": passage_id, "text": text})
    return passages


def validate_snapshot(snapshot_path: Path, voice: str) -> dict[str, Any]:
    if voice not in VOICE_METADATA:
        raise ValueError(
            "This pinned proof runner allows only the audited voices "
            f"{sorted(VOICE_METADATA)}; got {voice!r}"
        )
    voice_metadata = VOICE_METADATA[voice]
    config_path = snapshot_path / "config.json"
    weights_path = snapshot_path / MODEL_WEIGHTS_FILENAME
    voice_path = snapshot_path / "voices" / f"{voice}.safetensors"
    expected = (
        (config_path, MODEL_CONFIG_SHA256),
        (weights_path, MODEL_WEIGHTS_SHA256),
        (voice_path, voice_metadata["sha256"]),
    )
    for file_path, expected_sha256 in expected:
        if not file_path.is_file():
            raise FileNotFoundError(f"Missing pinned Kokoro asset: {file_path}")
        actual_sha256 = sha256_file(file_path)
        if actual_sha256 != expected_sha256:
            raise ValueError(
                f"Pinned Kokoro asset hash mismatch for {file_path}: "
                f"expected {expected_sha256}, got {actual_sha256}"
            )
    return {
        "snapshot_path": str(snapshot_path.resolve()),
        "config_path": str(config_path.resolve()),
        "config_sha256": MODEL_CONFIG_SHA256,
        "weights_path": str(weights_path.resolve()),
        "weights_sha256": MODEL_WEIGHTS_SHA256,
        "voice_path": str(voice_path.resolve()),
        "voice_sha256": voice_metadata["sha256"],
    }


def main() -> None:
    args = parse_args()
    if args.lang_code != "a":
        raise ValueError("This proof is pinned to American English lang code 'a'")
    if args.native_speed != 1.2:
        raise ValueError("This proof is pinned to Kokoro native speed 1.2")
    if package_version("mlx-audio") != RUNTIME_VERSION:
        raise RuntimeError(
            f"Expected mlx-audio {RUNTIME_VERSION}; "
            f"found {package_version('mlx-audio')!r}"
        )

    manifest_path = Path(args.manifest).resolve()
    output_dir = Path(args.output_dir).resolve()
    passages = load_passages(manifest_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    voice_metadata = VOICE_METADATA[args.voice]

    snapshot_path = Path(
        snapshot_download(
            repo_id=MODEL_SOURCE,
            revision=MODEL_REVISION,
            local_files_only=args.local_files_only,
            allow_patterns=[
                "config.json",
                MODEL_WEIGHTS_FILENAME,
                f"voices/{args.voice}.safetensors",
            ],
        )
    )
    snapshot = validate_snapshot(snapshot_path, args.voice)

    mx.random.seed(args.seed)
    load_started = time.perf_counter()
    model = load_model(MODEL_SOURCE, revision=MODEL_REVISION)
    load_seconds = time.perf_counter() - load_started

    rows: list[dict[str, Any]] = []
    for passage_index, passage in enumerate(passages):
        passage_id = passage["id"]
        text = passage["text"]
        passage_seed = args.seed + passage_index
        output_path = output_dir / f"{passage_id}.wav"
        sidecar_path = output_dir / f"{passage_id}.result.json"
        synthesis_identity = {
            "model_name": MODEL_NAME,
            "model_source": MODEL_SOURCE,
            "model_revision": MODEL_REVISION,
            "model_weights_sha256": MODEL_WEIGHTS_SHA256,
            "upstream_model_source": UPSTREAM_MODEL_SOURCE,
            "upstream_model_revision": UPSTREAM_MODEL_REVISION,
            "upstream_model_version": UPSTREAM_MODEL_VERSION,
            "voice": args.voice,
            "voice_sha256": voice_metadata["sha256"],
            "language_code": args.lang_code,
            "native_speed": args.native_speed,
            "text": text,
            "seed": passage_seed,
        }
        synthesis_identity_sha256 = sha256_text(
            json.dumps(
                synthesis_identity,
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        if args.resume and output_path.is_file() and sidecar_path.is_file():
            previous = json.loads(sidecar_path.read_text(encoding="utf-8"))
            if (
                previous.get("synthesis_identity_sha256")
                == synthesis_identity_sha256
                and previous.get("output_sha256") == sha256_file(output_path)
            ):
                rows.append({**previous, "status": "reused_exact_hash"})
                continue

        mx.random.seed(passage_seed)
        started = time.perf_counter()
        results = list(
            model.generate(
                text=text,
                voice=args.voice,
                speed=args.native_speed,
                lang_code=args.lang_code,
            )
        )
        elapsed = time.perf_counter() - started
        if not results:
            raise RuntimeError(f"{args.model_id}/{passage_id} returned no audio")
        sample_rates = {int(result.sample_rate) for result in results}
        if len(sample_rates) != 1:
            raise RuntimeError(
                f"{args.model_id}/{passage_id} returned mixed sample rates: "
                f"{sorted(sample_rates)}"
            )
        chunks = [result.audio for result in results]
        audio = chunks[0] if len(chunks) == 1 else mx.concatenate(chunks, axis=0)
        mx.eval(audio)
        audio_np = np.asarray(audio, dtype=np.float32).reshape(-1)
        if audio_np.size == 0 or not np.isfinite(audio_np).all():
            raise RuntimeError(f"{args.model_id}/{passage_id} returned invalid audio")

        sample_rate = sample_rates.pop()
        audio_write(output_path, audio_np, sample_rate, format="wav")
        duration_sec = audio_np.size / sample_rate
        row = {
            "passage_id": passage_id,
            "text": text,
            "status": "generated",
            "attempt": 1,
            "output_path": str(output_path),
            "output_sha256": sha256_file(output_path),
            "sample_rate_hz": sample_rate,
            "sample_count": int(audio_np.size),
            "duration_sec": round(duration_sec, 6),
            "generation_time_sec": round(elapsed, 6),
            "generation_rtf": (
                round(elapsed / duration_sec, 6) if duration_sec > 0 else None
            ),
            "result_chunk_count": len(results),
            "result_chunks": [
                {
                    "segment_idx": getattr(result, "segment_idx", None),
                    "token_count": getattr(result, "token_count", None),
                    "prompt": getattr(result, "prompt", None),
                }
                for result in results
            ],
            "peak_absolute_sample": round(
                float(np.max(np.abs(audio_np))),
                9,
            ),
            "seed": passage_seed,
            "synthesis_identity": synthesis_identity,
            "synthesis_identity_sha256": synthesis_identity_sha256,
            "result_sidecar_path": str(sidecar_path),
        }
        json_write(sidecar_path, row)
        rows.append(row)

    report = {
        "schema": "goldflow_local_tts_bakeoff_run_v1",
        "status": "passed",
        "diagnostic_only": True,
        "production_artifacts_mutated": False,
        "first_pass_only": True,
        "model_id": args.model_id,
        "model_kind": MODEL_KIND,
        "model_name": MODEL_NAME,
        "model_source": MODEL_SOURCE,
        "model_revision": MODEL_REVISION,
        "model_path": snapshot["snapshot_path"],
        "model_license": MODEL_LICENSE,
        "model_assets": snapshot,
        "upstream_model": {
            "source": UPSTREAM_MODEL_SOURCE,
            "revision": UPSTREAM_MODEL_REVISION,
            "version": UPSTREAM_MODEL_VERSION,
            "weights_sha256": UPSTREAM_MODEL_WEIGHTS_SHA256,
            "license": MODEL_LICENSE,
        },
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "voice_mode": "preset",
        "preset_voice": args.voice,
        "preset_voice_gender": voice_metadata["gender"],
        "preset_voice_upstream_grade": voice_metadata["grade"],
        "preset_voice_sha256": voice_metadata["sha256"],
        "voice_selection_rationale": (
            "Audited official Kokoro preset selected for a same-manifest voice "
            "comparison. Every installed American male preset is allowlisted "
            "for diagnostic bakeoffs; production voice policy is unchanged."
        ),
        "voice_instruction": None,
        "language_code": args.lang_code,
        "reference_audio_path": None,
        "reference_audio_sha256": None,
        "reference_text": None,
        "model_load_time_sec": round(load_seconds, 6),
        "runtime": {
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            "mlx_audio_version": package_version("mlx-audio"),
            "mlx_audio_source": RUNTIME_SOURCE,
            "mlx_audio_revision": RUNTIME_REVISION,
            "mlx_audio_license": RUNTIME_LICENSE,
            "mlx_audio_wheel_sha256": RUNTIME_WHEEL_SHA256,
            "mlx_version": package_version("mlx"),
            "huggingface_hub_version": package_version("huggingface-hub"),
            "misaki_version": package_version("misaki"),
            "espeakng_loader_version": package_version("espeakng-loader"),
        },
        "model_native_generation_parameters": {
            "voice": args.voice,
            "voice_gender": voice_metadata["gender"],
            "speed": args.native_speed,
            "language_code": args.lang_code,
        },
        "output_conditioning": {
            "shared_loudness_normalization": False,
            "shared_tempo_processing": False,
            "shared_silence_trimming": False,
            "shared_crossfade": False,
            "shared_declicking": False,
            "shared_resampling": False,
            "model_native_speed_requested": args.native_speed,
            "model_native_speed_supported": True,
            "model_native_speed_applied": args.native_speed,
            "model_native_text_normalization": True,
            "model_native_text_splitting": True,
        },
        "seed": args.seed,
        "passage_count": len(rows),
        "total_audio_duration_sec": round(
            sum(float(row["duration_sec"]) for row in rows),
            6,
        ),
        "total_generation_time_sec": round(
            sum(float(row["generation_time_sec"]) for row in rows),
            6,
        ),
        "results": rows,
    }
    json_write(output_dir / "run.json", report)
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
