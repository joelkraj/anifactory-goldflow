#!/usr/bin/env python3

"""Generate an isolated Qwen narration-quality bakeoff with raw unit outputs."""

from __future__ import annotations

import argparse
import hashlib
import json
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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def collect(generated: list[Any]) -> tuple[np.ndarray, int, int]:
    if not generated:
        raise RuntimeError("Qwen returned no audio")
    arrays = [item.audio for item in generated]
    audio = arrays[0] if len(arrays) == 1 else mx.concatenate(arrays, axis=0)
    mx.eval(audio)
    return (
        np.asarray(audio, dtype=np.float32).reshape(-1),
        int(generated[0].sample_rate),
        sum(int(item.token_count) for item in generated),
    )


def safe_name(value: str) -> str:
    return "".join(character if character.isalnum() else "_" for character in value).strip("_")


def main() -> None:
    args = parse_args()
    manifest_path = Path(args.manifest).resolve()
    report_path = Path(args.report).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "goldflow_narration_v2_bakeoff_manifest_v1":
        raise ValueError("Invalid narration V2 bakeoff manifest")
    output_dir = Path(manifest["output_dir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    load_started = time.perf_counter()
    model = load_model(
        manifest["model"]["id"],
        revision=manifest["model"]["revision"],
        local_files_only=True,
    )
    mx.eval(model.parameters())
    load_sec = time.perf_counter() - load_started

    references: dict[str, tuple[np.ndarray, str, dict[str, Any]]] = {}
    for ref_id, ref in manifest["references"].items():
        audio_path = Path(ref["audio_path"]).resolve()
        if sha256_file(audio_path) != ref["audio_sha256"]:
            raise ValueError(f"Reference hash mismatch: {ref_id}")
        audio = load_audio(str(audio_path), sample_rate=int(model.sample_rate))
        mx.eval(audio)
        references[ref_id] = (audio, ref["text"], ref)

    variant_rows: list[dict[str, Any]] = []
    for variant in manifest["variants"]:
        variant_dir = output_dir / safe_name(variant["id"])
        variant_dir.mkdir(parents=True, exist_ok=True)
        parameters = variant["generation_parameters"]
        units = variant["units"]
        started = time.perf_counter()
        generated_by_index: dict[int, list[Any]] = {}
        cohort_rows = []

        if variant["mode"] == "serial":
            for index, unit in enumerate(units):
                ref_audio, ref_text, _ = references[unit["reference_id"]]
                seed = int(variant["seed"]) + index
                mx.random.seed(seed)
                generated_by_index[index] = list(model.generate(
                    text=unit["text"],
                    ref_audio=ref_audio,
                    ref_text=ref_text,
                    temperature=float(parameters["temperature"]),
                    top_p=float(parameters["top_p"]),
                    top_k=int(parameters["top_k"]),
                    repetition_penalty=float(parameters["repetition_penalty"]),
                    max_tokens=int(parameters["max_tokens"]),
                    verbose=False,
                    stream=False,
                ))
                cohort_rows.append({
                    "cohort_index": index,
                    "mode": "serial",
                    "reference_id": unit["reference_id"],
                    "unit_indexes": [index],
                    "seed": seed,
                })
        elif variant["mode"] == "batch4":
            cohort_index = 0
            reference_ids = sorted({unit["reference_id"] for unit in units})
            planned_cohorts = []
            for reference_id in reference_ids:
                ordered_indexes = sorted(
                    [
                        index for index, unit in enumerate(units)
                        if unit["reference_id"] == reference_id
                    ],
                    key=lambda index: (
                        len(units[index]["text"].split()),
                        units[index]["id"],
                    ),
                )
                planned_cohorts.extend([
                    (reference_id, ordered_indexes[start:start + 4])
                    for start in range(0, len(ordered_indexes), 4)
                ])
            for reference_id, cohort_indexes in planned_cohorts:
                ref_audio, ref_text, _ = references[reference_id]
                seed = int(variant["seed"]) + cohort_index
                mx.random.seed(seed)
                generated = list(model.batch_generate(
                    texts=[units[index]["text"] for index in cohort_indexes],
                    voices=[None] * len(cohort_indexes),
                    instructs=[None] * len(cohort_indexes),
                    ref_audio=ref_audio,
                    ref_text=ref_text,
                    temperature=float(parameters["temperature"]),
                    top_p=float(parameters["top_p"]),
                    top_k=int(parameters["top_k"]),
                    repetition_penalty=float(parameters["repetition_penalty"]),
                    max_tokens=int(parameters["max_tokens"]),
                    verbose=False,
                    stream=False,
                ))
                by_sequence = {int(item.sequence_idx): item for item in generated}
                if sorted(by_sequence) != list(range(len(cohort_indexes))):
                    raise RuntimeError(
                        f"Batch sequence mismatch for {variant['id']} cohort {cohort_index}"
                    )
                for position, unit_index in enumerate(cohort_indexes):
                    generated_by_index[unit_index] = [by_sequence[position]]
                cohort_rows.append({
                    "cohort_index": cohort_index,
                    "mode": "batch4",
                    "reference_id": reference_id,
                    "unit_indexes": cohort_indexes,
                    "seed": seed,
                    "length_matched": True,
                })
                cohort_index += 1
        else:
            raise ValueError(f"Unsupported mode: {variant['mode']}")

        result_rows = []
        total_audio_sec = 0.0
        for index, unit in enumerate(units):
            audio, sample_rate, token_count = collect(generated_by_index[index])
            output_path = variant_dir / f"{index + 1:03d}_{safe_name(unit['id'])}.wav"
            audio_write(str(output_path), audio, sample_rate, format="wav")
            duration_sec = len(audio) / sample_rate
            total_audio_sec += duration_sec
            result_rows.append({
                "unit_id": unit["id"],
                "text": unit["text"],
                "reference_id": unit["reference_id"],
                "output_path": str(output_path),
                "output_sha256": sha256_file(output_path),
                "sample_rate_hz": sample_rate,
                "sample_count": len(audio),
                "duration_sec": round(duration_sec, 6),
                "token_count": token_count,
                "effective_token_limit": int(parameters["max_tokens"]),
                "token_limit_reached": token_count >= int(parameters["max_tokens"]),
            })
        wall_sec = time.perf_counter() - started
        variant_rows.append({
            "id": variant["id"],
            "mode": variant["mode"],
            "seed": variant["seed"],
            "generation_parameters": parameters,
            "unit_count": len(result_rows),
            "generation_wall_sec": round(wall_sec, 6),
            "generated_audio_sec": round(total_audio_sec, 6),
            "real_time_factor": round(wall_sec / max(total_audio_sec, 1e-9), 6),
            "cohorts": cohort_rows,
            "results": result_rows,
        })

    write_json(report_path, {
        "schema": "goldflow_narration_v2_bakeoff_generation_report_v1",
        "status": "passed",
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "model_load_sec": round(load_sec, 6),
        "variants": variant_rows,
    })


if __name__ == "__main__":
    main()
