#!/usr/bin/env python3

"""Run the official Inflect-Micro-v2 ONNX package as a TTS bake-off entry.

This is an isolated diagnostic runner. It writes one provider-native WAV per
manifest passage plus the bake-off ``run.json`` report. It does not normalize,
resample, trim, concatenate, crossfade, or tempo-process the generated audio.
The official Inflect long-text wrapper remains part of model inference.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
import time
from pathlib import Path
from types import ModuleType
from typing import Any


MODEL_KIND = "inflect_micro_v2_onnx"
OFFICIAL_REPOSITORY = "owensong/Inflect-Micro-v2-ONNX"
EXPECTED_SAMPLE_RATE_HZ = 24_000
SAFE_PASSAGE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
REQUIRED_MODEL_FILES = (
    "config.json",
    "inflect_vits_frontend.py",
    "onnx/decode.onnx",
    "onnx/duration.onnx",
    "onnx/inference_onnx.py",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate an isolated Goldflow bake-off run with the official "
            "Inflect-Micro-v2 ONNX Runtime package."
        )
    )
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument(
        "--model-id",
        default="inflect_micro_v2_onnx",
        help="Stable contestant ID used by the bake-off evaluator.",
    )
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--provider",
        default="cpu",
        help=(
            "Official runner provider alias: cpu, cuda, directml, or an "
            "ONNX Runtime provider name."
        ),
    )
    parser.add_argument(
        "--speed",
        "--native-speed",
        dest="speed",
        type=float,
        default=1.0,
        help="Inflect-native speed in the official 0.5-2.0 range.",
    )
    parser.add_argument(
        "--variation",
        type=float,
        default=0.667,
        help="Inflect-native latent variation in the official 0.0-1.0 range.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=20260726,
        help=(
            "Base seed. Passage index is added so each row has a stable, "
            "distinct seed."
        ),
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Allow replacement of this runner's existing WAVs and run.json.",
    )
    return parser.parse_args()


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def json_write(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = file_path.with_name(f".{file_path.name}.tmp")
    temporary_path.write_text(
        json.dumps(value, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(file_path)


def validate_controls(speed: float, variation: float) -> None:
    if not 0.5 <= speed <= 2.0:
        raise ValueError("--speed must be between 0.5 and 2.0")
    if not 0.0 <= variation <= 1.0:
        raise ValueError("--variation must be between 0.0 and 1.0")


def validate_output_dir(output_dir: Path) -> None:
    if "episodes" in {part.lower() for part in output_dir.parts}:
        raise ValueError(
            "Refusing an output directory beneath an episodes tree. "
            "This runner is diagnostic-only; use a voice_bank/bakeoff path."
        )
    if output_dir.exists() and not output_dir.is_dir():
        raise ValueError(f"--output-dir is not a directory: {output_dir}")


def load_manifest(manifest_path: Path) -> tuple[dict[str, Any], list[dict[str, str]]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    passages = manifest.get("passages")
    if not isinstance(passages, list) or not passages:
        raise ValueError(f"No passages in {manifest_path}")

    normalized: list[dict[str, str]] = []
    seen_ids: set[str] = set()
    for index, passage in enumerate(passages):
        if not isinstance(passage, dict):
            raise ValueError(f"Passage {index} must be an object")
        passage_id = str(passage.get("id") or "").strip()
        text = str(passage.get("text") or "").strip()
        if not SAFE_PASSAGE_ID.fullmatch(passage_id):
            raise ValueError(
                f"Passage {index} has an unsafe id {passage_id!r}; use only "
                "letters, digits, dot, underscore, and hyphen"
            )
        if passage_id in seen_ids:
            raise ValueError(f"Duplicate passage id: {passage_id}")
        if not text:
            raise ValueError(f"Passage {passage_id} has no text")
        seen_ids.add(passage_id)
        normalized.append({"id": passage_id, "text": text})
    return manifest, normalized


def validate_model_dir(model_dir: Path) -> None:
    missing = [
        relative_path
        for relative_path in REQUIRED_MODEL_FILES
        if not (model_dir / relative_path).is_file()
    ]
    if missing:
        formatted = ", ".join(missing)
        raise ValueError(
            f"--model-dir is not a complete {OFFICIAL_REPOSITORY} snapshot; "
            f"missing: {formatted}"
        )


def load_official_runner(model_dir: Path) -> ModuleType:
    runner_path = model_dir / "onnx" / "inference_onnx.py"
    module_name = "goldflow_inflect_micro_v2_official_onnx"
    spec = importlib.util.spec_from_file_location(module_name, runner_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load the official runner: {runner_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    if not hasattr(module, "InflectONNX"):
        raise RuntimeError(
            f"Official runner does not expose InflectONNX: {runner_path}"
        )
    return module


def refuse_existing_outputs(
    output_dir: Path,
    passages: list[dict[str, str]],
    overwrite: bool,
) -> None:
    if overwrite:
        return
    candidates = [output_dir / "run.json"]
    candidates.extend(output_dir / f"{passage['id']}.wav" for passage in passages)
    existing = [path for path in candidates if path.exists()]
    if existing:
        preview = ", ".join(str(path) for path in existing[:3])
        remainder = len(existing) - min(3, len(existing))
        suffix = f" (+{remainder} more)" if remainder else ""
        raise FileExistsError(
            f"Refusing to overwrite existing bake-off outputs: "
            f"{preview}{suffix}. Pass --overwrite or use a new --output-dir."
        )


def load_source_metadata(model_dir: Path) -> dict[str, Any] | None:
    source_path = model_dir / "onnx" / "SOURCE.json"
    if not source_path.is_file():
        return None
    value = json.loads(source_path.read_text(encoding="utf-8"))
    return {
        "path": str(source_path),
        "sha256": sha256_file(source_path),
        "value": value,
    }


def session_providers(engine: Any) -> dict[str, list[str]]:
    return {
        "duration": list(engine.duration.get_providers()),
        "decode": list(engine.decode.get_providers()),
    }


def main() -> None:
    args = parse_args()
    validate_controls(args.speed, args.variation)

    manifest_path = Path(args.manifest).resolve()
    model_dir = Path(args.model_dir).resolve()
    output_dir = Path(args.output_dir).resolve()

    validate_output_dir(output_dir)
    validate_model_dir(model_dir)
    _manifest, passages = load_manifest(manifest_path)
    refuse_existing_outputs(output_dir, passages, args.overwrite)
    output_dir.mkdir(parents=True, exist_ok=True)

    official_runner = load_official_runner(model_dir)
    load_started = time.perf_counter()
    engine = official_runner.InflectONNX(
        model_dir,
        provider=args.provider,
    )
    load_seconds = time.perf_counter() - load_started

    rows: list[dict[str, Any]] = []
    for passage_index, passage in enumerate(passages):
        passage_id = passage["id"]
        text = passage["text"]
        passage_seed = args.seed + passage_index
        output_path = output_dir / f"{passage_id}.wav"

        started = time.perf_counter()
        engine.save(
            text,
            output_path,
            speed=args.speed,
            variation=args.variation,
            seed=passage_seed,
        )
        elapsed = time.perf_counter() - started

        audio_info = official_runner.sf.info(str(output_path))
        if audio_info.format != "WAV":
            raise RuntimeError(
                f"{passage_id} is not a WAV: {audio_info.format!r}"
            )
        if audio_info.samplerate != EXPECTED_SAMPLE_RATE_HZ:
            raise RuntimeError(
                f"{passage_id} sample rate is {audio_info.samplerate}, "
                f"expected {EXPECTED_SAMPLE_RATE_HZ}"
            )
        if audio_info.channels != 1:
            raise RuntimeError(
                f"{passage_id} has {audio_info.channels} channels, expected mono"
            )
        duration_sec = float(audio_info.duration)
        if duration_sec <= 0:
            raise RuntimeError(f"{passage_id} produced an empty WAV")

        rows.append(
            {
                "passage_id": passage_id,
                "text": text,
                "output_path": str(output_path),
                "output_sha256": sha256_file(output_path),
                "output_format": audio_info.format,
                "output_subtype": audio_info.subtype,
                "sample_rate_hz": int(audio_info.samplerate),
                "channel_count": int(audio_info.channels),
                "duration_sec": round(duration_sec, 6),
                "generation_time_sec": round(elapsed, 6),
                "generation_rtf": round(elapsed / duration_sec, 6),
                "result_chunk_count": len(official_runner.split_text(text)),
                "speed": args.speed,
                "native_speed": args.speed,
                "variation": args.variation,
                "seed": passage_seed,
            }
        )
        print(
            f"[{passage_index + 1}/{len(passages)}] {passage_id}",
            file=sys.stderr,
        )

    runner_path = model_dir / "onnx" / "inference_onnx.py"
    report = {
        "schema": "goldflow_local_tts_bakeoff_run_v1",
        "status": "passed",
        "model_id": args.model_id,
        "model_kind": MODEL_KIND,
        "model_path": str(model_dir),
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "voice_mode": "fixed_voice",
        "preset_voice": None,
        "voice_instruction": None,
        "language_code": "en",
        "reference_audio_path": None,
        "reference_audio_sha256": None,
        "reference_text": None,
        "official_repository": OFFICIAL_REPOSITORY,
        "official_runner_path": str(runner_path),
        "official_runner_sha256": sha256_file(runner_path),
        "onnx_source": load_source_metadata(model_dir),
        "provider_requested": args.provider,
        "providers_resolved": session_providers(engine),
        "model_load_time_sec": round(load_seconds, 6),
        "speed": args.speed,
        "native_speed": args.speed,
        "variation": args.variation,
        "output_conditioning": {
            "shared_loudness_normalization": False,
            "shared_tempo_processing": False,
            "shared_audio_post_processing": False,
            "model_native_loudness_normalization": False,
            "model_native_speed_requested": args.speed,
            "model_native_speed_supported": True,
            "model_native_speed_applied": args.speed,
            "model_native_variation_requested": args.variation,
            "model_native_variation_applied": args.variation,
            "model_native_long_text_wrapper": True,
            "raw_wav_only": True,
        },
        "seed": args.seed,
        "passage_count": len(rows),
        "total_audio_duration_sec": round(
            sum(row["duration_sec"] for row in rows),
            6,
        ),
        "total_generation_time_sec": round(
            sum(row["generation_time_sec"] for row in rows),
            6,
        ),
        "results": rows,
    }
    json_write(output_dir / "run.json", report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
