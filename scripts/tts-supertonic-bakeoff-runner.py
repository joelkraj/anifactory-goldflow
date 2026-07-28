#!/usr/bin/env python3

"""Run Supertonic 3 fixed voices across a Goldflow bake-off manifest.

The official Supertonic Python SDK and model are loaded once, then each
passage is synthesized to an untouched WAV. The runner does not normalize,
trim, resample, crossfade, de-click, or apply post-TTS tempo processing.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import re
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np


MODEL_NAME = "supertonic-3"
MODEL_SOURCE = "Supertone/supertonic-3"
MODEL_KIND = "supertonic3"
VOICE_NAMES = tuple(
    f"{gender}{index}"
    for gender in ("M", "F")
    for index in range(1, 6)
)
PASSAGE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run a fixed Supertonic 3 voice across a TTS bake-off manifest "
            "without shared audio post-processing."
        )
    )
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--voice",
        required=True,
        type=str.upper,
        choices=VOICE_NAMES,
        help="Built-in Supertonic 3 fixed voice (M1-M5 or F1-F5).",
    )
    parser.add_argument(
        "--model-dir",
        help=(
            "Optional existing Supertonic 3 model directory. By default the "
            "official SDK uses its Supertonic 3 cache."
        ),
    )
    parser.add_argument(
        "--auto-download",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Allow the official SDK to download missing Supertonic 3 assets "
            "(default: true)."
        ),
    )
    parser.add_argument(
        "--lang-code",
        default="en",
        help="Model-native language code (default: en).",
    )
    parser.add_argument(
        "--native-speed",
        type=float,
        default=1.05,
        help=(
            "Supertonic model-native speed control from 0.7 to 2.0 "
            "(default: 1.05). No post-TTS tempo processing is applied."
        ),
    )
    parser.add_argument(
        "--total-steps",
        type=int,
        default=12,
        help=(
            "Supertonic synthesis quality steps from 5 to 12 "
            "(default: 12, the quality-max bake-off setting)."
        ),
    )
    parser.add_argument(
        "--max-chunk-length",
        type=int,
        default=300,
        help=(
            "Official SDK text-chunk limit in characters (default: 300). "
            "The Goldflow bake-off passages are shorter than this."
        ),
    )
    parser.add_argument(
        "--silence-duration",
        type=float,
        default=0.3,
        help=(
            "Official SDK silence between its internal text chunks in seconds "
            "(default: 0.3). This does not affect single-chunk passages."
        ),
    )
    parser.add_argument("--intra-op-threads", type=int)
    parser.add_argument("--inter-op-threads", type=int)
    parser.add_argument("--seed", type=int, default=20260726)
    parser.add_argument(
        "--resume",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Reuse exact-hash completed passage WAVs and sidecars (default: true).",
    )
    parser.add_argument(
        "--force-passage-ids",
        default="",
        help="Comma-separated passage IDs to regenerate even when resumable output exists.",
    )
    parser.add_argument(
        "--force-seed-offset",
        type=int,
        default=100_000,
        help="Seed offset applied only to forced passages so a retry is a fresh deterministic attempt.",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if not 0.7 <= args.native_speed <= 2.0:
        raise ValueError("--native-speed must be between 0.7 and 2.0")
    if not 5 <= args.total_steps <= 12:
        raise ValueError("--total-steps must be between 5 and 12")
    if args.max_chunk_length < 10:
        raise ValueError("--max-chunk-length must be at least 10")
    if args.silence_duration < 0:
        raise ValueError("--silence-duration must be non-negative")
    for label, value in (
        ("--intra-op-threads", args.intra_op_threads),
        ("--inter-op-threads", args.inter_op_threads),
    ):
        if value is not None and value <= 0:
            raise ValueError(f"{label} must be greater than zero")


def load_passages(manifest_path: Path) -> tuple[dict[str, Any], list[dict[str, str]]]:
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
        if not isinstance(passage_id, str) or not PASSAGE_ID_PATTERN.fullmatch(
            passage_id
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
    return manifest, passages


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def json_write(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def synthesis_identity_without_seed(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {key: item for key, item in value.items() if key != "seed"}


def package_version(distribution: str) -> str | None:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None


def voice_style_provenance(
    model_dir: Path, voice: str
) -> tuple[str | None, str | None]:
    voice_path = model_dir / "voice_styles" / f"{voice}.json"
    if not voice_path.is_file():
        return None, None
    return str(voice_path), sha256_file(voice_path)


def main() -> None:
    args = parse_args()
    validate_args(args)
    manifest_path = Path(args.manifest).resolve()
    output_dir = Path(args.output_dir).resolve()
    requested_model_dir = (
        Path(args.model_dir).expanduser().resolve()
        if args.model_dir is not None
        else None
    )
    _manifest, passages = load_passages(manifest_path)

    try:
        from supertonic import TTS
        from supertonic.utils import chunk_text
    except ImportError as error:
        raise RuntimeError(
            "The official Supertonic SDK is required. Install it with "
            "`python -m pip install supertonic`."
        ) from error

    output_dir.mkdir(parents=True, exist_ok=True)
    load_started = time.perf_counter()
    tts = TTS(
        model=MODEL_NAME,
        model_dir=requested_model_dir,
        auto_download=args.auto_download,
        intra_op_num_threads=args.intra_op_threads,
        inter_op_num_threads=args.inter_op_threads,
    )
    available_voices = tuple(tts.voice_style_names)
    if args.voice not in available_voices:
        raise ValueError(
            f"Voice {args.voice!r} is unavailable. Loaded voices: "
            f"{', '.join(available_voices)}"
        )
    voice_style = tts.get_voice_style(voice_name=args.voice)
    load_seconds = time.perf_counter() - load_started
    model_dir = Path(tts.model_dir).expanduser().resolve()
    voice_style_path, voice_style_sha256 = voice_style_provenance(
        model_dir, args.voice
    )
    forced_passage_ids = {
        value.strip()
        for value in args.force_passage_ids.split(",")
        if value.strip()
    }
    unknown_forced_ids = forced_passage_ids.difference(
        passage["id"] for passage in passages
    )
    if unknown_forced_ids:
        raise ValueError(
            "Unknown --force-passage-ids: "
            + ", ".join(sorted(unknown_forced_ids))
        )

    rows: list[dict[str, Any]] = []
    for passage_index, passage in enumerate(passages):
        passage_id = passage["id"]
        text = passage["text"]
        passage_seed = args.seed + passage_index + (
            args.force_seed_offset if passage_id in forced_passage_ids else 0
        )
        np.random.seed(passage_seed)
        sdk_chunks = chunk_text(text, max_len=args.max_chunk_length)
        output_path = output_dir / f"{passage_id}.wav"
        result_sidecar_path = output_dir / f"{passage_id}.result.json"
        synthesis_identity = {
            "model_name": MODEL_NAME,
            "model_source": MODEL_SOURCE,
            "model_dir": str(model_dir),
            "voice": args.voice,
            "voice_style_sha256": voice_style_sha256,
            "text": text,
            "language_code": args.lang_code,
            "native_speed": args.native_speed,
            "total_steps": args.total_steps,
            "max_chunk_length": args.max_chunk_length,
            "silence_duration": args.silence_duration,
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
        if (
            args.resume
            and passage_id not in forced_passage_ids
            and output_path.is_file()
            and result_sidecar_path.is_file()
        ):
            previous = json.loads(result_sidecar_path.read_text(encoding="utf-8"))
            if (
                synthesis_identity_without_seed(previous.get("synthesis_identity"))
                == synthesis_identity_without_seed(synthesis_identity)
                and previous.get("output_sha256") == sha256_file(output_path)
            ):
                rows.append(
                    {
                        **previous,
                        "status": "reused_exact_hash",
                        "result_sidecar_path": str(result_sidecar_path),
                    }
                )
                continue

        started = time.perf_counter()
        wav, returned_duration = tts.synthesize(
            text=text,
            voice_style=voice_style,
            total_steps=args.total_steps,
            speed=args.native_speed,
            max_chunk_length=args.max_chunk_length,
            silence_duration=args.silence_duration,
            lang=args.lang_code,
            verbose=False,
        )
        elapsed = time.perf_counter() - started
        audio = np.asarray(wav)
        valid_shape = audio.ndim == 1 or (
            audio.ndim == 2 and audio.shape[0] == 1
        )
        if not valid_shape or audio.size == 0:
            raise RuntimeError(
                f"{args.model_id}/{passage_id} returned invalid audio shape "
                f"{audio.shape}"
            )
        if not np.isfinite(audio).all():
            raise RuntimeError(
                f"{args.model_id}/{passage_id} returned non-finite audio"
            )

        sample_rate = int(tts.sample_rate)
        sample_count = int(audio.shape[-1])
        duration_sec = sample_count / sample_rate
        tts.save_audio(audio, str(output_path))
        sdk_duration = float(
            np.asarray(returned_duration).reshape(-1)[0]
        )
        row = {
            "passage_id": passage_id,
            "text": text,
            "status": "generated",
            "output_path": str(output_path),
            "output_sha256": sha256_file(output_path),
            "sample_rate_hz": sample_rate,
            "duration_sec": round(duration_sec, 6),
            "model_returned_duration_sec": round(sdk_duration, 6),
            "generation_time_sec": round(elapsed, 6),
            "generation_rtf": round(elapsed / duration_sec, 6)
            if duration_sec > 0
            else None,
            "result_chunk_count": len(sdk_chunks),
            "seed": passage_seed,
            "synthesis_identity": synthesis_identity,
            "synthesis_identity_sha256": synthesis_identity_sha256,
            "result_sidecar_path": str(result_sidecar_path),
        }
        json_write(result_sidecar_path, row)
        rows.append(row)

    report = {
        "schema": "goldflow_local_tts_bakeoff_run_v1",
        "status": "passed",
        "model_id": args.model_id,
        "model_kind": MODEL_KIND,
        "model_path": str(model_dir),
        "model_name": MODEL_NAME,
        "model_source": MODEL_SOURCE,
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "voice_mode": "preset",
        "preset_voice": args.voice,
        "preset_voice_style_path": voice_style_path,
        "preset_voice_style_sha256": voice_style_sha256,
        "voice_instruction": None,
        "language_code": args.lang_code,
        "reference_audio_path": None,
        "reference_audio_sha256": None,
        "reference_text": None,
        "model_load_time_sec": round(load_seconds, 6),
        "runtime": {
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            "supertonic_sdk_version": package_version("supertonic"),
            "onnxruntime_version": package_version("onnxruntime"),
        },
        "model_native_generation_parameters": {
            "voice": args.voice,
            "speed": args.native_speed,
            "total_steps": args.total_steps,
            "language_code": args.lang_code,
            "max_chunk_length": args.max_chunk_length,
            "chunk_silence_duration_sec": args.silence_duration,
            "intra_op_threads": args.intra_op_threads,
            "inter_op_threads": args.inter_op_threads,
        },
        "output_conditioning": {
            "shared_loudness_normalization": False,
            "shared_tempo_processing": False,
            "shared_silence_trimming": False,
            "shared_crossfade": False,
            "shared_declicking": False,
            "shared_resampling": False,
            "model_native_loudness_normalization": False,
            "model_native_speed_requested": args.native_speed,
            "model_native_speed_supported": True,
            "model_native_speed_applied": args.native_speed,
            "model_native_total_steps": args.total_steps,
            "model_native_text_chunking": True,
            "model_native_chunk_silence_sec": args.silence_duration,
        },
        "seed": args.seed,
        "passage_count": len(rows),
        "total_audio_duration_sec": round(
            sum(row["duration_sec"] for row in rows), 6
        ),
        "total_generation_time_sec": round(
            sum(row["generation_time_sec"] for row in rows), 6
        ),
        "results": rows,
    }
    json_write(output_dir / "run.json", report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
