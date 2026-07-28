#!/usr/bin/env python3

"""Run Soprano 1.1 across a Goldflow TTS proof manifest.

The model is loaded once, then every manifest passage is synthesized to an
untouched 32 kHz WAV. This runner does not normalize, trim, resample, fade,
de-click, or time-stretch model output.
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

import numpy as np
import torch
from scipy.io import wavfile
from soprano import SopranoTTS


MODEL_NAME = "Soprano-1.1-80M"
MODEL_SOURCE = "ekwek/Soprano-1.1-80M"
MODEL_KIND = "soprano_1_1"
SAMPLE_RATE_HZ = 32_000
PASSAGE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model-id", default="soprano_1_1_80m")
    parser.add_argument("--device", choices=("auto", "mps", "cpu"), default="mps")
    parser.add_argument("--backend", choices=("auto", "transformers"), default="transformers")
    parser.add_argument("--model-path")
    parser.add_argument("--top-p", type=float, default=0.95)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--repetition-penalty", type=float, default=1.2)
    parser.add_argument("--hallucination-retries", type=int, default=2)
    parser.add_argument("--seed", type=int, default=20260726)
    parser.add_argument(
        "--resume",
        action=argparse.BooleanOptionalAction,
        default=True,
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
    file_path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def package_version(distribution: str) -> str | None:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None


def load_passages(manifest_path: Path) -> list[dict[str, str]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    passages = manifest.get("passages") or []
    if not passages:
        raise ValueError(f"No passages in {manifest_path}")
    seen: set[str] = set()
    output: list[dict[str, str]] = []
    for index, passage in enumerate(passages):
        passage_id = passage.get("id")
        text = passage.get("text")
        if not isinstance(passage_id, str) or not PASSAGE_ID_PATTERN.fullmatch(passage_id):
            raise ValueError(f"Passage {index} has unsafe id: {passage_id!r}")
        if passage_id in seen:
            raise ValueError(f"Duplicate passage id: {passage_id}")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"Passage {passage_id} has empty text")
        seen.add(passage_id)
        output.append({"id": passage_id, "text": text.strip()})
    return output


def main() -> None:
    args = parse_args()
    if not 0 < args.top_p <= 1:
        raise ValueError("--top-p must be in (0, 1]")
    if args.temperature < 0:
        raise ValueError("--temperature must be non-negative")
    if args.repetition_penalty <= 0:
        raise ValueError("--repetition-penalty must be positive")
    if args.hallucination_retries < 0:
        raise ValueError("--hallucination-retries must be non-negative")

    manifest_path = Path(args.manifest).resolve()
    output_dir = Path(args.output_dir).resolve()
    passages = load_passages(manifest_path)
    output_dir.mkdir(parents=True, exist_ok=True)

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    load_started = time.perf_counter()
    model = SopranoTTS(
        backend=args.backend,
        device=args.device,
        model_path=args.model_path,
    )
    load_seconds = time.perf_counter() - load_started

    rows: list[dict[str, Any]] = []
    for passage_index, passage in enumerate(passages):
        passage_id = passage["id"]
        text = passage["text"]
        passage_seed = args.seed + passage_index
        output_path = output_dir / f"{passage_id}.wav"
        sidecar_path = output_dir / f"{passage_id}.result.json"
        identity = {
            "model_name": MODEL_NAME,
            "model_source": MODEL_SOURCE,
            "model_path": args.model_path,
            "device": args.device,
            "backend": args.backend,
            "text": text,
            "top_p": args.top_p,
            "temperature": args.temperature,
            "repetition_penalty": args.repetition_penalty,
            "hallucination_retries": args.hallucination_retries,
            "seed": passage_seed,
        }
        identity_sha256 = sha256_text(
            json.dumps(identity, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        )
        if args.resume and output_path.is_file() and sidecar_path.is_file():
            previous = json.loads(sidecar_path.read_text(encoding="utf-8"))
            if (
                previous.get("synthesis_identity_sha256") == identity_sha256
                and previous.get("output_sha256") == sha256_file(output_path)
            ):
                rows.append({**previous, "status": "reused_exact_hash"})
                continue

        torch.manual_seed(passage_seed)
        np.random.seed(passage_seed)
        started = time.perf_counter()
        audio_tensor = model.infer(
            text,
            top_p=args.top_p,
            temperature=args.temperature,
            repetition_penalty=args.repetition_penalty,
            retries=args.hallucination_retries,
        )
        elapsed = time.perf_counter() - started
        audio = np.asarray(audio_tensor.detach().cpu().numpy(), dtype=np.float32).reshape(-1)
        if audio.size == 0 or not np.isfinite(audio).all():
            raise RuntimeError(f"{passage_id} returned invalid audio")
        wavfile.write(output_path, SAMPLE_RATE_HZ, audio)
        duration_sec = audio.size / SAMPLE_RATE_HZ
        row = {
            "passage_id": passage_id,
            "text": text,
            "status": "generated",
            "output_path": str(output_path),
            "output_sha256": sha256_file(output_path),
            "sample_rate_hz": SAMPLE_RATE_HZ,
            "duration_sec": round(duration_sec, 6),
            "generation_time_sec": round(elapsed, 6),
            "generation_rtf": round(elapsed / duration_sec, 6),
            "result_chunk_count": 1,
            "seed": passage_seed,
            "synthesis_identity": identity,
            "synthesis_identity_sha256": identity_sha256,
            "result_sidecar_path": str(sidecar_path),
        }
        json_write(sidecar_path, row)
        rows.append(row)

    report = {
        "schema": "goldflow_local_tts_bakeoff_run_v1",
        "status": "passed",
        "model_id": args.model_id,
        "model_kind": MODEL_KIND,
        "model_name": MODEL_NAME,
        "model_source": MODEL_SOURCE,
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "voice_mode": "model_fixed_voice",
        "preset_voice": None,
        "reference_audio_path": None,
        "reference_text": None,
        "model_load_time_sec": round(load_seconds, 6),
        "runtime": {
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            "soprano_tts_version": package_version("soprano-tts"),
            "torch_version": torch.__version__,
            "device": args.device,
            "backend": args.backend,
        },
        "model_native_generation_parameters": {
            "top_p": args.top_p,
            "temperature": args.temperature,
            "repetition_penalty": args.repetition_penalty,
            "hallucination_retries": args.hallucination_retries,
        },
        "output_conditioning": {
            "shared_loudness_normalization": False,
            "shared_tempo_processing": False,
            "shared_silence_trimming": False,
            "shared_crossfade": False,
            "shared_declicking": False,
            "shared_resampling": False,
            "model_native_text_normalization": True,
            "model_native_text_splitting": True,
        },
        "seed": args.seed,
        "passage_count": len(rows),
        "total_audio_duration_sec": round(sum(row["duration_sec"] for row in rows), 6),
        "total_generation_time_sec": round(
            sum(row["generation_time_sec"] for row in rows), 6
        ),
        "results": rows,
    }
    json_write(output_dir / "run.json", report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
