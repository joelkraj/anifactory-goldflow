#!/usr/bin/env python3

"""Synthesize an isolated proof narration from an arbitrary audited Qwen reference."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import time
from pathlib import Path
from typing import Any

import mlx.core as mx
import numpy as np
from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model
from mlx_audio.utils import load_audio


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--report", required=True)
    return parser.parse_args()


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def atomic_json(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_name(f".{file_path.name}.tmp-{os.getpid()}")
    temporary.write_text(
        f"{json.dumps(value, indent=2, ensure_ascii=False)}\n",
        encoding="utf-8",
    )
    os.replace(temporary, file_path)


def atomic_audio(file_path: Path, audio: np.ndarray, sample_rate: int) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_name(f".{file_path.stem}.tmp-{os.getpid()}.wav")
    audio_write(str(temporary), audio, sample_rate, format="wav")
    os.replace(temporary, file_path)


def waveform_metrics(audio: np.ndarray, sample_rate: int) -> dict[str, Any]:
    values = np.asarray(audio, dtype=np.float32).reshape(-1)
    absolute = np.abs(values)
    peak = float(np.max(absolute)) if values.size else 0.0
    rms = (
        float(np.sqrt(np.mean(np.square(values, dtype=np.float64))))
        if values.size
        else 0.0
    )
    active = np.flatnonzero(absolute > 10 ** (-50 / 20))
    leading = int(active[0]) if active.size else int(values.size)
    trailing = int(values.size - active[-1] - 1) if active.size else int(values.size)

    def dbfs(value: float) -> float | None:
        return round(20 * np.log10(value), 6) if value > 0 else None

    return {
        "sample_count": int(values.size),
        "sample_rate_hz": sample_rate,
        "duration_sec": round(values.size / sample_rate, 6),
        "peak_dbfs": dbfs(peak),
        "rms_dbfs": dbfs(rms),
        "clipping_sample_count": int(np.count_nonzero(absolute >= 0.999)),
        "leading_silence_sec": round(leading / sample_rate, 6),
        "trailing_silence_sec": round(trailing / sample_rate, 6),
    }


def collect_results(generated: list[Any]) -> tuple[np.ndarray, int, int, int]:
    if not generated:
        raise RuntimeError("Qwen returned no audio")
    sample_rates = {int(result.sample_rate) for result in generated}
    if len(sample_rates) != 1:
        raise RuntimeError(f"Qwen returned mixed sample rates: {sample_rates}")
    chunks = [result.audio for result in generated]
    audio = chunks[0] if len(chunks) == 1 else mx.concatenate(chunks, axis=0)
    mx.eval(audio)
    output = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not output.size or not np.isfinite(output).all():
        raise RuntimeError("Qwen returned invalid audio")
    return (
        output,
        sample_rates.pop(),
        len(generated),
        sum(int(getattr(result, "token_count", 0) or 0) for result in generated),
    )


def main() -> None:
    args = parse_args()
    if importlib.metadata.version("mlx-audio") != "0.4.6":
        raise RuntimeError("This proof requires the pinned mlx-audio 0.4.6 runtime")

    manifest_path = Path(args.manifest).resolve()
    output_dir = Path(args.output_dir).resolve()
    report_path = Path(args.report).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("status") != "approved_for_synthesis":
        raise ValueError("Narration manifest is not approved for synthesis")

    script_path = Path(manifest["script_path"]).resolve()
    reference_audio_path = Path(manifest["reference_audio_path"]).resolve()
    reference_text_path = Path(manifest["reference_text_path"]).resolve()
    if sha256_file(script_path) != manifest["script_sha256"]:
        raise ValueError("Approved script hash mismatch")
    if sha256_file(reference_audio_path) != manifest["reference_audio_sha256"]:
        raise ValueError("Adam reference audio hash mismatch")
    reference_text = reference_text_path.read_text(encoding="utf-8").strip()
    if (
        sha256_file(reference_text_path) != manifest["reference_text_file_sha256"]
        or sha256_text(reference_text) != manifest["reference_text_sha256"]
        or reference_text != manifest["reference_text"]
    ):
        raise ValueError("Adam reference transcript mismatch")

    model_lock = manifest["model"]
    generation = manifest["generation"]
    units = manifest["units"]
    output_dir.mkdir(parents=True, exist_ok=True)

    total_started = time.perf_counter()
    load_started = time.perf_counter()
    model = load_model(
        model_lock["model_id"],
        revision=model_lock["revision"],
        local_files_only=True,
    )
    model_load_sec = time.perf_counter() - load_started
    if int(model.sample_rate) != int(model_lock["sample_rate_hz"]):
        raise RuntimeError(
            f"Expected {model_lock['sample_rate_hz']} Hz, got {model.sample_rate}"
        )

    reference_started = time.perf_counter()
    reference_audio = load_audio(
        str(reference_audio_path),
        sample_rate=int(model.sample_rate),
    )
    mx.eval(reference_audio)
    reference_load_sec = time.perf_counter() - reference_started

    unit_reports: list[dict[str, Any]] = []
    unit_audio: list[np.ndarray] = []
    model_call_sec = 0.0
    for unit in units:
        mx.random.seed(int(unit["seed"]))
        call_started = time.perf_counter()
        generated = list(
            model.generate(
                text=unit["spoken_text"],
                ref_audio=reference_audio,
                ref_text=reference_text,
                temperature=float(generation["temperature"]),
                top_p=float(generation["top_p"]),
                top_k=int(generation["top_k"]),
                repetition_penalty=float(generation["repetition_penalty"]),
                max_tokens=int(generation["max_tokens"]),
                verbose=False,
                stream=False,
            )
        )
        current_call_sec = time.perf_counter() - call_started
        model_call_sec += current_call_sec
        audio, sample_rate, chunk_count, token_count = collect_results(generated)
        if token_count >= int(generation["max_tokens"]):
            raise RuntimeError(f"Token limit reached for {unit['unit_id']}")

        output_path = output_dir / f"{unit['input_index'] + 1:03d}-{unit['unit_id']}.wav"
        atomic_audio(output_path, audio, sample_rate)
        metrics = waveform_metrics(audio, sample_rate)
        identity = {
            "schema": "goldflow_private_proof_qwen_unit_identity_v1",
            "unit_id": unit["unit_id"],
            "seed": int(unit["seed"]),
            "spoken_text_sha256": unit["spoken_text_sha256"],
            "model_id": model_lock["model_id"],
            "model_revision": model_lock["revision"],
            "reference_audio_sha256": manifest["reference_audio_sha256"],
            "reference_text_sha256": manifest["reference_text_sha256"],
            "generation": generation,
        }
        unit_reports.append(
            {
                "unit_id": unit["unit_id"],
                "input_index": int(unit["input_index"]),
                "source_text": unit["source_text"],
                "spoken_text": unit["spoken_text"],
                "source_word_count": int(unit["source_word_count"]),
                "spoken_word_count": int(unit["spoken_word_count"]),
                "seed": int(unit["seed"]),
                "output_path": str(output_path),
                "output_sha256": sha256_file(output_path),
                "duration_sec": metrics["duration_sec"],
                "generation_wall_sec": round(current_call_sec, 6),
                "generation_rtf": round(
                    current_call_sec / max(metrics["duration_sec"], 1e-9), 6
                ),
                "result_chunk_count": chunk_count,
                "generated_token_count": token_count,
                "effective_token_limit": int(generation["max_tokens"]),
                "token_limit_reached": False,
                "waveform_metrics": metrics,
                "synthesis_identity": identity,
                "synthesis_identity_sha256": canonical_sha256(identity),
            }
        )
        unit_audio.append(audio)

    gap_samples = int(
        round(int(model.sample_rate) * manifest["stitch_contract"]["join_silence_ms"] / 1000)
    )
    gap = np.zeros((gap_samples,), dtype=np.float32)
    stitched_parts: list[np.ndarray] = []
    for index, audio in enumerate(unit_audio):
        if index:
            stitched_parts.append(gap)
        stitched_parts.append(audio)
    stitched = np.concatenate(stitched_parts)
    narration_path = output_dir.parent / "narration_qwen_adam_full.wav"
    atomic_audio(narration_path, stitched, int(model.sample_rate))
    stitched_metrics = waveform_metrics(stitched, int(model.sample_rate))

    report = {
        "schema": "goldflow_private_proof_qwen_narration_run_v1",
        "status": "passed",
        "proof_only": True,
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "script_path": str(script_path),
        "script_sha256": manifest["script_sha256"],
        "reference_audio_path": str(reference_audio_path),
        "reference_audio_sha256": manifest["reference_audio_sha256"],
        "reference_text_sha256": manifest["reference_text_sha256"],
        "model": model_lock,
        "generation": generation,
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "mlx": importlib.metadata.version("mlx"),
            "mlx_audio": importlib.metadata.version("mlx-audio"),
        },
        "model_load_count": 1,
        "model_load_wall_sec": round(model_load_sec, 6),
        "reference_preloaded_once": True,
        "reference_load_wall_sec": round(reference_load_sec, 6),
        "unit_count": len(unit_reports),
        "units": unit_reports,
        "stitch_contract": manifest["stitch_contract"],
        "narration_path": str(narration_path),
        "narration_sha256": sha256_file(narration_path),
        "narration_metrics": stitched_metrics,
        "model_call_wall_sec": round(model_call_sec, 6),
        "end_to_end_wall_sec": round(time.perf_counter() - total_started, 6),
        "post_tts_tempo_processing": False,
        "normalization_applied": False,
    }
    atomic_json(report_path, report)
    print(
        json.dumps(
            {
                "status": "passed",
                "report": str(report_path),
                "narration": str(narration_path),
                "unit_count": len(unit_reports),
                "duration_sec": stitched_metrics["duration_sec"],
            }
        )
    )


if __name__ == "__main__":
    main()
