#!/usr/bin/env python3

"""Isolated Qwen/Liam throughput bake-off runner.

This diagnostic never writes production TTS caches or canonical episode
artifacts. It compares the pinned serial API with fixed MLX batch sizes while
recording the stochastic-identity difference explicitly.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import re
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
    parser.add_argument("--report", required=True)
    return parser.parse_args()


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


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


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-")
    return cleaned[:120] or hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def is_within(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def waveform_metrics(audio: np.ndarray, sample_rate: int) -> dict[str, Any]:
    values = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not values.size:
        return {
            "sample_rate_hz": sample_rate,
            "sample_count": 0,
            "duration_sec": 0.0,
            "peak_dbfs": None,
            "rms_dbfs": None,
            "clipping_sample_count": 0,
            "maximum_sample_step": None,
            "large_sample_step_count": 0,
            "maximum_isolated_impulse": None,
            "isolated_impulse_count": 0,
            "leading_silence_sec": 0.0,
            "trailing_silence_sec": 0.0,
        }

    absolute = np.abs(values)
    peak = float(np.max(absolute))
    rms = float(np.sqrt(np.mean(np.square(values, dtype=np.float64))))
    steps = np.abs(np.diff(values))
    maximum_step = float(np.max(steps)) if steps.size else 0.0
    large_step_count = int(np.count_nonzero(steps >= 0.3))
    if values.size >= 3:
        impulses = np.abs(
            values[1:-1] - ((values[:-2] + values[2:]) / 2.0)
        )
        neighbor_differences = np.abs(values[:-2] - values[2:])
        maximum_impulse = float(np.max(impulses))
        isolated_impulse_count = int(
            np.count_nonzero((impulses >= 0.45) & (neighbor_differences <= 0.12))
        )
    else:
        maximum_impulse = 0.0
        isolated_impulse_count = 0

    silence_threshold = 10 ** (-50 / 20)
    active = np.flatnonzero(absolute > silence_threshold)
    if active.size:
        leading_samples = int(active[0])
        trailing_samples = int(values.size - active[-1] - 1)
    else:
        leading_samples = int(values.size)
        trailing_samples = int(values.size)

    def dbfs(value: float) -> float | None:
        if value <= 0:
            return None
        return round(20 * np.log10(value), 6)

    return {
        "sample_rate_hz": sample_rate,
        "sample_count": int(values.size),
        "duration_sec": round(values.size / sample_rate, 6),
        "peak_dbfs": dbfs(peak),
        "rms_dbfs": dbfs(rms),
        "clipping_sample_count": int(np.count_nonzero(absolute >= 0.999)),
        "maximum_sample_step": round(maximum_step, 8),
        "large_sample_step_count": large_step_count,
        "maximum_isolated_impulse": round(maximum_impulse, 8),
        "isolated_impulse_count": isolated_impulse_count,
        "leading_silence_sec": round(leading_samples / sample_rate, 6),
        "trailing_silence_sec": round(trailing_samples / sample_rate, 6),
    }


def collect_single_result(
    generated: list[Any],
) -> tuple[np.ndarray, int, int, int]:
    if not generated:
        raise RuntimeError("Qwen returned no audio")
    sample_rates = {int(result.sample_rate) for result in generated}
    if len(sample_rates) != 1:
        raise RuntimeError(f"Qwen returned mixed sample rates: {sample_rates}")
    arrays = [result.audio for result in generated]
    audio = arrays[0] if len(arrays) == 1 else mx.concatenate(arrays, axis=0)
    mx.eval(audio)
    output = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not output.size or not np.isfinite(output).all():
        raise RuntimeError("Qwen returned invalid audio")
    return (
        output,
        sample_rates.pop(),
        len(generated),
        sum(int(result.token_count) for result in generated),
    )


def collect_batch_results(
    generated: list[Any],
    expected_count: int,
) -> dict[int, tuple[np.ndarray, int, int]]:
    by_index: dict[int, tuple[np.ndarray, int, int]] = {}
    for result in generated:
        index = int(result.sequence_idx)
        if index in by_index:
            raise RuntimeError(f"Duplicate Qwen batch sequence index {index}")
        mx.eval(result.audio)
        output = np.asarray(result.audio, dtype=np.float32).reshape(-1)
        if not output.size or not np.isfinite(output).all():
            raise RuntimeError(f"Qwen batch sequence {index} returned invalid audio")
        by_index[index] = (
            output,
            int(result.sample_rate),
            int(result.token_count),
        )
    if sorted(by_index) != list(range(expected_count)):
        raise RuntimeError(
            "Qwen batch output indexes do not match request: "
            f"{sorted(by_index)} vs {list(range(expected_count))}"
        )
    return by_index


def batch_seed(mode_id: str, group_id: str, units: list[dict[str, Any]]) -> int:
    identity = {
        "mode_id": mode_id,
        "group_id": group_id,
        "unit_ids": [unit["unit_id"] for unit in units],
        "serial_seeds": [int(unit["serial_seed"]) for unit in units],
    }
    return int(canonical_sha256(identity)[:8], 16)


def main() -> None:
    args = parse_args()
    manifest_path = Path(args.manifest).resolve()
    report_path = Path(args.report).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("schema")
        != "goldflow_qwen_throughput_bakeoff_manifest_v1"
        or manifest.get("diagnostic_only") is not True
        or manifest.get("production_default_unchanged") is not True
    ):
        raise ValueError("Invalid diagnostic throughput bake-off manifest")

    output_dir = Path(manifest["output_dir"]).resolve()
    review_root = Path(manifest["review_root"]).resolve()
    if not is_within(output_dir, review_root):
        raise ValueError("Bake-off output must remain under its review_samples root")
    if not is_within(report_path, output_dir):
        raise ValueError("Bake-off report must remain under its isolated output")
    output_dir.mkdir(parents=True, exist_ok=True)

    runtime = manifest["runtime"]
    expected_mlx_audio = str(runtime["mlx_audio_version"])
    actual_mlx_audio = importlib.metadata.version("mlx-audio")
    if actual_mlx_audio != expected_mlx_audio:
        raise RuntimeError(
            f"Expected mlx-audio {expected_mlx_audio}, found {actual_mlx_audio}"
        )

    model_lock = manifest["model"]
    reference = manifest["reference"]
    generation = manifest["generation_parameters"]
    reference_path = Path(reference["audio_path"]).resolve()
    if sha256_file(reference_path) != reference["audio_sha256"]:
        raise ValueError("Liam reference audio hash mismatch")
    if hashlib.sha256(reference["text"].encode("utf-8")).hexdigest() != reference[
        "text_sha256"
    ]:
        raise ValueError("Liam reference transcript hash mismatch")

    total_started = time.perf_counter()
    load_started = time.perf_counter()
    model = load_model(
        model_lock["source"],
        revision=model_lock["revision"],
        local_files_only=True,
    )
    mx.eval(model.parameters())
    model_load_sec = time.perf_counter() - load_started

    if not hasattr(model, "batch_generate"):
        raise RuntimeError("Pinned Qwen runtime has no batch_generate API")
    if not model.supports_tts_batch(
        ref_audio=str(reference_path),
        ref_text=reference["text"],
        speed=1.0,
        pitch=1.0,
        stream=False,
    ):
        raise RuntimeError("Pinned Qwen runtime rejects fixed-batch Liam ICL")
    if model.supports_tts_continuous_batch(
        ref_audio=str(reference_path),
        ref_text=reference["text"],
    ):
        raise RuntimeError(
            "Diagnostic contract expected continuous ICL batching to remain unsupported"
        )

    reference_started = time.perf_counter()
    reference_audio = load_audio(
        str(reference_path),
        sample_rate=int(model.sample_rate),
    )
    mx.eval(reference_audio)
    reference_load_sec = time.perf_counter() - reference_started

    units_by_id = {
        str(unit["unit_id"]): unit for unit in manifest["selected_units"]
    }
    mode_reports: list[dict[str, Any]] = []
    for mode in manifest["modes"]:
        mode_id = str(mode["mode_id"])
        requested_batch_size = int(mode["batch_size"])
        mode_dir = output_dir / mode_id
        mode_dir.mkdir(parents=True, exist_ok=True)
        if hasattr(model, "_icl_cache"):
            model._icl_cache.clear()
        mx.clear_cache()
        mx.reset_peak_memory()
        mode_started = time.perf_counter()
        model_call_sec = 0.0
        write_sec = 0.0
        metrics_sec = 0.0
        group_reports: list[dict[str, Any]] = []
        unit_reports_by_id: dict[str, dict[str, Any]] = {}
        audio_by_id: dict[str, np.ndarray] = {}

        for group in mode["groups"]:
            group_units = [units_by_id[str(unit_id)] for unit_id in group["unit_ids"]]
            group_started = time.perf_counter()
            if mode_id == "serial":
                if len(group_units) != 1:
                    raise ValueError("Serial diagnostic groups must contain one unit")
                unit = group_units[0]
                seed = int(unit["serial_seed"])
                mx.random.seed(seed)
                call_started = time.perf_counter()
                generated = list(
                    model.generate(
                        text=unit["spoken_text"],
                        ref_audio=reference_audio,
                        ref_text=reference["text"],
                        temperature=float(generation["temperature"]),
                        top_p=float(generation["top_p"]),
                        top_k=int(generation["top_k"]),
                        repetition_penalty=float(
                            generation["repetition_penalty"]
                        ),
                        max_tokens=int(generation["max_tokens"]),
                        verbose=False,
                        stream=False,
                    )
                )
                (
                    audio,
                    sample_rate,
                    chunk_count,
                    generated_token_count,
                ) = collect_single_result(generated)
                call_sec = time.perf_counter() - call_started
                model_call_sec += call_sec
                group_outputs = [
                    (
                        unit,
                        audio,
                        sample_rate,
                        chunk_count,
                        generated_token_count,
                    )
                ]
                group_seed_value = seed
                per_unit_seed_preserved = True
            else:
                group_seed_value = batch_seed(
                    mode_id,
                    str(group["group_id"]),
                    group_units,
                )
                mx.random.seed(group_seed_value)
                call_started = time.perf_counter()
                generated = list(
                    model.batch_generate(
                        texts=[unit["spoken_text"] for unit in group_units],
                        voices=[None] * len(group_units),
                        instructs=[None] * len(group_units),
                        ref_audio=reference_audio,
                        ref_text=reference["text"],
                        temperature=float(generation["temperature"]),
                        top_p=float(generation["top_p"]),
                        top_k=int(generation["top_k"]),
                        repetition_penalty=float(
                            generation["repetition_penalty"]
                        ),
                        max_tokens=int(generation["max_tokens"]),
                        verbose=False,
                        stream=False,
                    )
                )
                collected = collect_batch_results(generated, len(group_units))
                call_sec = time.perf_counter() - call_started
                model_call_sec += call_sec
                group_outputs = []
                for index, unit in enumerate(group_units):
                    audio, sample_rate, generated_token_count = collected[index]
                    group_outputs.append(
                        (
                            unit,
                            audio,
                            sample_rate,
                            1,
                            generated_token_count,
                        )
                    )
                per_unit_seed_preserved = False

            group_result_ids: list[str] = []
            for (
                unit,
                audio,
                sample_rate,
                chunk_count,
                generated_token_count,
            ) in group_outputs:
                if sample_rate != int(model_lock["sample_rate_hz"]):
                    raise RuntimeError(
                        f"Expected {model_lock['sample_rate_hz']} Hz, got {sample_rate}"
                    )
                original_index = int(unit["input_index"])
                output_path = mode_dir / (
                    f"{original_index + 1:02d}-{safe_name(unit['unit_id'])}.wav"
                )
                write_started = time.perf_counter()
                audio_write(str(output_path), audio, sample_rate, format="wav")
                current_write_sec = time.perf_counter() - write_started
                write_sec += current_write_sec
                output_sha256 = sha256_file(output_path)

                metrics_started = time.perf_counter()
                metrics = waveform_metrics(audio, sample_rate)
                current_metrics_sec = time.perf_counter() - metrics_started
                metrics_sec += current_metrics_sec
                tokenizer_token_count = len(
                    model.tokenizer.encode(unit["spoken_text"])
                )
                effective_batch_max_tokens = min(
                    int(generation["max_tokens"]),
                    max(75, tokenizer_token_count * 6),
                )
                stochastic_identity = {
                    "schema":
                        "goldflow_qwen_throughput_bakeoff_synthesis_identity_v1",
                    "diagnostic_only": True,
                    "mode_id": mode_id,
                    "requested_batch_size": requested_batch_size,
                    "effective_group_size": len(group_units),
                    "group_id": group["group_id"],
                    "group_seed": group_seed_value,
                    "per_unit_serial_seed": int(unit["serial_seed"]),
                    "per_unit_seed_preserved": per_unit_seed_preserved,
                    "unit_id": unit["unit_id"],
                    "spoken_text_sha256": unit["spoken_text_sha256"],
                    "model_id": model_lock["model_id"],
                    "model_revision": model_lock["revision"],
                    "reference_audio_sha256": reference["audio_sha256"],
                    "reference_text_sha256": reference["text_sha256"],
                    "generation_parameters": generation,
                    "effective_icl_repetition_penalty": max(
                        1.5,
                        float(generation["repetition_penalty"]),
                    ),
                    "batch_text_token_count": tokenizer_token_count,
                    "batch_effective_max_tokens": (
                        effective_batch_max_tokens
                        if mode_id != "serial"
                        else int(generation["max_tokens"])
                    ),
                    "stochastic_equivalence_to_serial": (
                        "same_per_unit_rng_seed_and_serial_api"
                        if per_unit_seed_preserved
                        else "not_expected_global_batch_rng_has_no_per_sequence_seed"
                    ),
                }
                unit_report = {
                    "unit_id": unit["unit_id"],
                    "input_index": original_index,
                    "word_count": unit["word_count"],
                    "serial_seed": int(unit["serial_seed"]),
                    "group_seed": group_seed_value,
                    "per_unit_seed_preserved": per_unit_seed_preserved,
                    "output_path": str(output_path),
                    "output_sha256": output_sha256,
                    "float32_waveform_sha256": hashlib.sha256(
                        np.asarray(audio, dtype=np.float32).tobytes()
                    ).hexdigest(),
                    "sample_rate_hz": sample_rate,
                    "duration_sec": metrics["duration_sec"],
                    "result_chunk_count": chunk_count,
                    "generated_token_count": generated_token_count,
                    "effective_token_limit": (
                        effective_batch_max_tokens
                        if mode_id != "serial"
                        else int(generation["max_tokens"])
                    ),
                    "token_limit_reached": generated_token_count >= (
                        effective_batch_max_tokens
                        if mode_id != "serial"
                        else int(generation["max_tokens"])
                    ),
                    "source_serial_audio_path": unit["source_audio_path"],
                    "source_serial_audio_sha256": unit["source_audio_sha256"],
                    "matches_source_serial_wav_sha256": (
                        output_sha256 == unit["source_audio_sha256"]
                    ),
                    "stochastic_identity": stochastic_identity,
                    "stochastic_identity_sha256": canonical_sha256(
                        stochastic_identity
                    ),
                    "waveform_metrics": metrics,
                    "write_wall_sec": round(current_write_sec, 6),
                    "waveform_metrics_wall_sec": round(current_metrics_sec, 6),
                }
                unit_reports_by_id[str(unit["unit_id"])] = unit_report
                audio_by_id[str(unit["unit_id"])] = audio
                group_result_ids.append(str(unit["unit_id"]))

            group_reports.append(
                {
                    "group_id": group["group_id"],
                    "requested_batch_size": requested_batch_size,
                    "effective_batch_size": len(group_units),
                    "unit_ids": group_result_ids,
                    "word_counts": [unit["word_count"] for unit in group_units],
                    "word_count_spread": (
                        max(unit["word_count"] for unit in group_units)
                        - min(unit["word_count"] for unit in group_units)
                    ),
                    "group_seed": group_seed_value,
                    "per_unit_seed_preserved": per_unit_seed_preserved,
                    "model_call_wall_sec": round(call_sec, 6),
                    "group_end_to_end_wall_sec": round(
                        time.perf_counter() - group_started,
                        6,
                    ),
                    "peak_memory_bytes_after_group": int(mx.get_peak_memory()),
                }
            )

        ordered_units = [
            unit_reports_by_id[str(unit["unit_id"])]
            for unit in sorted(
                manifest["selected_units"],
                key=lambda candidate: int(candidate["input_index"]),
            )
        ]
        ordered_audio = [
            audio_by_id[str(unit["unit_id"])]
            for unit in sorted(
                manifest["selected_units"],
                key=lambda candidate: int(candidate["input_index"]),
            )
        ]
        sequence_started = time.perf_counter()
        gap_samples = int(
            round(
                float(manifest["listening_sequence"]["inserted_gap_sec"])
                * int(model.sample_rate)
            )
        )
        silence = np.zeros((gap_samples,), dtype=np.float32)
        listening_parts: list[np.ndarray] = []
        for index, audio in enumerate(ordered_audio):
            if index:
                listening_parts.append(silence)
            listening_parts.append(audio)
        listening_audio = np.concatenate(listening_parts)
        listening_path = mode_dir / f"{mode_id}-listening-sequence.wav"
        audio_write(
            str(listening_path),
            listening_audio,
            int(model.sample_rate),
            format="wav",
        )
        sequence_write_sec = time.perf_counter() - sequence_started
        mode_wall_sec = time.perf_counter() - mode_started
        audio_duration_sum = sum(
            float(unit["duration_sec"]) for unit in ordered_units
        )
        mode_reports.append(
            {
                "mode_id": mode_id,
                "api": (
                    "Model.generate"
                    if mode_id == "serial"
                    else "Model.batch_generate"
                ),
                "requested_batch_size": requested_batch_size,
                "fixed_group_batching": mode_id != "serial",
                "continuous_batching": False,
                "shared_liam_reference": True,
                "reference_array_reused": True,
                "per_unit_seed_preserved": mode_id == "serial",
                "stochastic_equivalence_to_serial": (
                    "expected_exact_reproduction"
                    if mode_id == "serial"
                    else "not_expected_global_batch_rng_has_no_per_sequence_seed"
                ),
                "groups": group_reports,
                "units": ordered_units,
                "unit_count": len(ordered_units),
                "audio_duration_sum_sec": round(audio_duration_sum, 6),
                "model_call_wall_sec": round(model_call_sec, 6),
                "write_wall_sec": round(write_sec, 6),
                "waveform_metrics_wall_sec": round(metrics_sec, 6),
                "listening_sequence_write_wall_sec": round(
                    sequence_write_sec,
                    6,
                ),
                "end_to_end_wall_sec": round(mode_wall_sec, 6),
                "model_call_realtime_factor": round(
                    model_call_sec / max(audio_duration_sum, 1e-9),
                    6,
                ),
                "model_call_audio_throughput_x": round(
                    audio_duration_sum / max(model_call_sec, 1e-9),
                    6,
                ),
                "end_to_end_audio_throughput_x": round(
                    audio_duration_sum / max(mode_wall_sec, 1e-9),
                    6,
                ),
                "peak_memory_bytes": int(mx.get_peak_memory()),
                "listening_sequence_path": str(listening_path),
                "listening_sequence_sha256": sha256_file(listening_path),
                "listening_sequence_duration_sec": round(
                    listening_audio.size / int(model.sample_rate),
                    6,
                ),
                "listening_sequence_contract": {
                    "inserted_gap_sec": float(
                        manifest["listening_sequence"]["inserted_gap_sec"]
                    ),
                    "trimming": False,
                    "fading": False,
                    "tempo_processing": False,
                    "production_stitch_equivalent": False,
                    "note": (
                        "Diagnostic comparison sequence inserts zero samples "
                        "between untouched unit outputs; it does not trim their "
                        "native endpoint silence to the production 80 ms contract."
                    ),
                },
            }
        )

    report = {
        "schema": "goldflow_qwen_throughput_bakeoff_run_v1",
        "status": "passed",
        "diagnostic_only": True,
        "production_eligible": False,
        "production_default_unchanged": True,
        "production_default": manifest["production_default"],
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "output_dir": str(output_dir),
        "model": model_lock,
        "reference": {
            **reference,
            "preloaded_once_as_mlx_array": True,
            "sample_count": int(reference_audio.size),
        },
        "generation_parameters": generation,
        "runtime": {
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            "mlx_audio_version": actual_mlx_audio,
            "mlx_version": importlib.metadata.version("mlx"),
        },
        "api_capability_audit": {
            "fixed_batch_icl_supported": True,
            "continuous_batch_icl_supported": False,
            "shared_reference_required": True,
            "per_sequence_rng_seed_supported": False,
            "batch_icl_text_derived_max_token_cap": True,
        },
        "model_load_count": 1,
        "model_load_wall_sec": round(model_load_sec, 6),
        "reference_load_count": 1,
        "reference_load_wall_sec": round(reference_load_sec, 6),
        "modes": mode_reports,
        "total_wall_sec": round(time.perf_counter() - total_started, 6),
        "adoption_gate": {
            "status": "diagnostic_results_require_listening_and_qa",
            "production_concurrency_remains": 1,
            "required_before_default_change": [
                "same_text_model_reference_parameter_provenance",
                "audible_skip_truncation_stutter_review",
                "pronunciation_review",
                "speaker_identity_review",
                "measured_latency_and_peak_memory",
            ],
        },
    }
    atomic_json(report_path, report)
    print(
        json.dumps(
            {
                "status": report["status"],
                "diagnostic_only": True,
                "report": str(report_path),
                "mode_count": len(mode_reports),
            }
        )
    )


if __name__ == "__main__":
    main()
