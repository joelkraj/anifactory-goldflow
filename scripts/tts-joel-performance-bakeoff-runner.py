#!/usr/bin/env python3

"""Run an isolated Qwen/Joel performance bakeoff without production writes."""

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


def main() -> None:
    args = parse_args()
    manifest_path = Path(args.manifest).resolve()
    report_path = Path(args.report).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "goldflow_joel_performance_bakeoff_manifest_v1":
        raise ValueError("Invalid performance bakeoff manifest")
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

    references: dict[str, tuple[np.ndarray, str]] = {}
    for ref_id, ref in manifest["references"].items():
        path = Path(ref["audio_path"]).resolve()
        if sha256_file(path) != ref["audio_sha256"]:
            raise ValueError(f"Reference hash mismatch: {ref_id}")
        audio = load_audio(str(path), sample_rate=int(model.sample_rate))
        mx.eval(audio)
        references[ref_id] = (audio, ref["text"])

    parameters = manifest["generation_parameters"]
    rows: list[dict[str, Any]] = []
    for variant in manifest["variants"]:
        ref_audio, ref_text = references[variant["reference_id"]]
        mode = variant["mode"]
        texts = variant["units"]
        mx.random.seed(int(variant["seed"]))
        started = time.perf_counter()
        if mode == "batch4":
            generated = list(model.batch_generate(
                texts=texts,
                voices=[None] * len(texts),
                instructs=[None] * len(texts),
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
            by_index = {int(item.sequence_idx): item for item in generated}
            generated_units = [[by_index[index]] for index in range(len(texts))]
        elif mode == "serial":
            generated_units = []
            for index, text in enumerate(texts):
                mx.random.seed(int(variant["seed"]) + index)
                generated_units.append(list(model.generate(
                    text=text,
                    ref_audio=ref_audio,
                    ref_text=ref_text,
                    temperature=float(parameters["temperature"]),
                    top_p=float(parameters["top_p"]),
                    top_k=int(parameters["top_k"]),
                    repetition_penalty=float(parameters["repetition_penalty"]),
                    max_tokens=int(parameters["max_tokens"]),
                    verbose=False,
                    stream=False,
                )))
        else:
            raise ValueError(f"Unsupported mode: {mode}")

        pieces = []
        unit_rows = []
        sample_rate = None
        for index, items in enumerate(generated_units):
            audio, current_rate, token_count = collect(items)
            sample_rate = current_rate if sample_rate is None else sample_rate
            if current_rate != sample_rate:
                raise RuntimeError("Mixed sample rates")
            pieces.append(audio)
            unit_rows.append({
                "index": index,
                "text": texts[index],
                "duration_sec": round(len(audio) / sample_rate, 6),
                "token_count": token_count,
            })
        gap = np.zeros(round(sample_rate * 0.08), dtype=np.float32)
        joined = pieces[0]
        for piece in pieces[1:]:
            joined = np.concatenate([joined, gap, piece])
        output_path = output_dir / f"{variant['id']}.wav"
        audio_write(str(output_path), joined, sample_rate, format="wav")
        rows.append({
            "id": variant["id"],
            "mode": mode,
            "reference_id": variant["reference_id"],
            "output_path": str(output_path),
            "output_sha256": sha256_file(output_path),
            "duration_sec": round(len(joined) / sample_rate, 6),
            "generation_wall_sec": round(time.perf_counter() - started, 6),
            "units": unit_rows,
            "post_tts_tempo_processing": False,
            "loudness_normalization": False,
        })

    write_json(report_path, {
        "schema": "goldflow_joel_performance_bakeoff_report_v1",
        "status": "completed_requires_human_listening",
        "diagnostic_only": True,
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "model_load_sec": round(load_sec, 6),
        "variants": rows,
    })


if __name__ == "__main__":
    main()
