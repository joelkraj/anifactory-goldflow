#!/usr/bin/env python3

"""Measure TTS voice-clone similarity with a WeSpeaker embedding centroid."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from statistics import mean, median, pstdev
from typing import Any

import numpy as np
import sherpa_onnx
import soundfile as sf


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bakeoff-root")
    parser.add_argument("--model", required=True)
    parser.add_argument("--reference", action="append", required=True)
    parser.add_argument(
        "--candidate",
        action="append",
        help="Production continuity candidate WAV; repeat for each exact-unit fallback.",
    )
    parser.add_argument("--output")
    parser.add_argument("--minimum-similarity", type=float, default=0.88)
    parser.add_argument("--warning-below-similarity", type=float, default=0.90)
    parser.add_argument(
        "--threshold-mode",
        choices=["fixed", "reference_leave_one_out"],
        default="fixed",
    )
    parser.add_argument("--calibration-hard-margin", type=float, default=0.05)
    parser.add_argument("--calibration-warning-margin", type=float, default=0.0)
    parser.add_argument("--calibration-aggregate-margin", type=float, default=0.03)
    parser.add_argument("--reference-voice-id")
    parser.add_argument("--reference-voice-sha256")
    parser.add_argument("--num-threads", type=int, default=4)
    return parser.parse_args()


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_name(f".{file_path.name}.tmp-{os.getpid()}")
    temporary.write_text(
        json.dumps(value, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, file_path)


def unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    return vector / max(norm, 1e-12)


def embed(
    extractor: sherpa_onnx.SpeakerEmbeddingExtractor,
    audio_path: Path,
) -> np.ndarray:
    audio, sample_rate = sf.read(
        str(audio_path),
        always_2d=True,
        dtype="float32",
    )
    stream = extractor.create_stream()
    stream.accept_waveform(
        sample_rate=sample_rate,
        waveform=np.ascontiguousarray(audio[:, 0]),
    )
    stream.input_finished()
    if not extractor.is_ready(stream):
        raise RuntimeError(f"Speaker embedding is not ready: {audio_path}")
    return unit(np.asarray(extractor.compute(stream), dtype=np.float32))


def summarize(values: list[float]) -> dict[str, Any]:
    return {
        "count": len(values),
        "mean_cosine_similarity": round(mean(values), 6),
        "median_cosine_similarity": round(median(values), 6),
        "minimum_cosine_similarity": round(min(values), 6),
        "maximum_cosine_similarity": round(max(values), 6),
        "stddev": round(pstdev(values), 6) if len(values) > 1 else 0,
    }


def main() -> None:
    args = parse_args()
    model_path = Path(args.model).resolve()
    reference_paths = [Path(value).resolve() for value in args.reference]
    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=str(model_path),
        num_threads=max(1, args.num_threads),
        provider="cpu",
    )
    if not config.validate():
        raise ValueError(f"Invalid speaker embedding config: {config}")
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)

    reference_embeddings = [embed(extractor, path) for path in reference_paths]
    centroid = unit(np.mean(reference_embeddings, axis=0))
    reference_calibration = []
    if len(reference_embeddings) > 1:
        for index, (audio_path, embedding) in enumerate(
            zip(reference_paths, reference_embeddings, strict=True)
        ):
            other_centroid = unit(np.mean([
                other
                for other_index, other in enumerate(reference_embeddings)
                if other_index != index
            ], axis=0))
            reference_calibration.append({
                "audio_path": str(audio_path),
                "audio_sha256": sha256_file(audio_path),
                "leave_one_out_cosine_similarity": round(
                    float(np.dot(embedding, other_centroid)),
                    6,
                ),
            })
    reference_floor = (
        min(row["leave_one_out_cosine_similarity"]
            for row in reference_calibration)
        if reference_calibration else None
    )
    if args.threshold_mode == "reference_leave_one_out":
        if reference_floor is None:
            raise ValueError(
                "reference_leave_one_out threshold mode requires at least "
                "two references"
            )
        effective_minimum = max(
            0.01,
            reference_floor - max(0.0, args.calibration_hard_margin),
        )
        effective_warning = max(
            effective_minimum,
            reference_floor - max(0.0, args.calibration_warning_margin),
        )
        aggregate_minimum = max(
            effective_minimum,
            reference_floor - max(0.0, args.calibration_aggregate_margin),
        )
    else:
        effective_minimum = args.minimum_similarity
        effective_warning = args.warning_below_similarity
        aggregate_minimum = args.minimum_similarity
    if args.candidate:
        if args.bakeoff_root:
            raise ValueError("--candidate and --bakeoff-root are mutually exclusive")
        if not 0 < effective_minimum <= 1:
            raise ValueError("--minimum-similarity must be in (0, 1]")
        if not effective_minimum <= effective_warning <= 1:
            raise ValueError(
                "--warning-below-similarity must be between the hard minimum "
                "and 1"
            )
        if not args.output:
            raise ValueError("--output is required with --candidate")
        candidate_rows = []
        for raw_path in args.candidate:
            audio_path = Path(raw_path).resolve()
            similarity = float(np.dot(embed(extractor, audio_path), centroid))
            candidate_rows.append(
                {
                    "audio_path": str(audio_path),
                    "audio_sha256": sha256_file(audio_path),
                    "cosine_similarity": round(similarity, 6),
                    "minimum_cosine_similarity": round(effective_minimum, 6),
                    "warning_below_cosine_similarity":
                        round(effective_warning, 6),
                    "status": (
                        "passed"
                        if similarity >= effective_minimum
                        else "blocked"
                    ),
                    "warnings": (
                        [{
                            "severity": "warning",
                            "code":
                                "tts_fallback_voice_similarity_low_margin",
                            "review_required": True,
                        }]
                        if effective_minimum <= similarity
                        < effective_warning
                        else []
                    ),
                }
            )
        blocked = [
            row for row in candidate_rows if row["status"] == "blocked"
        ]
        candidate_aggregate = summarize([
            row["cosine_similarity"] for row in candidate_rows
        ])
        aggregate_status = (
            "passed"
            if candidate_aggregate["mean_cosine_similarity"]
            >= aggregate_minimum else "blocked"
        )
        report = {
            "schema": "goldflow_tts_voice_continuity_qa_v1",
            "status": "blocked" if blocked or aggregate_status == "blocked"
                else "passed",
            "method": "WeSpeaker VoxCeleb ResNet34 LM cosine similarity",
            "model_path": str(model_path),
            "model_sha256": sha256_file(model_path),
            "threshold_mode": args.threshold_mode,
            "minimum_cosine_similarity": round(effective_minimum, 6),
            "warning_below_cosine_similarity":
                round(effective_warning, 6),
            "aggregate_minimum_cosine_similarity": round(
                aggregate_minimum,
                6,
            ),
            "aggregate_status": aggregate_status,
            "calibration": {
                "reference_leave_one_out_floor": reference_floor,
                "hard_margin": args.calibration_hard_margin,
                "warning_margin": args.calibration_warning_margin,
                "aggregate_margin": args.calibration_aggregate_margin,
            },
            "reference_voice_id": args.reference_voice_id,
            "reference_voice_sha256": args.reference_voice_sha256,
            "reference_count": len(reference_paths),
            "references": [
                {
                    "audio_path": str(audio_path),
                    "audio_sha256": sha256_file(audio_path),
                }
                for audio_path in reference_paths
            ],
            "candidate_count": len(candidate_rows),
            "blocked_candidate_count": len(blocked),
            "candidate_aggregate": candidate_aggregate,
            "reference_calibration": reference_calibration,
            "candidates": candidate_rows,
        }
        output_path = Path(args.output).resolve()
        atomic_json(output_path, report)
        print(json.dumps({
            "status": report["status"],
            "candidate_count": len(candidate_rows),
            "blocked_candidate_count": len(blocked),
            "output": str(output_path),
        }))
        return

    if not args.bakeoff_root:
        raise ValueError("--bakeoff-root is required without --candidate")
    root = Path(args.bakeoff_root).resolve()
    if len(reference_embeddings) < 2:
        raise ValueError("Bakeoff similarity requires at least two references")
    reference_rows = []
    for index, (audio_path, embedding) in enumerate(
        zip(reference_paths, reference_embeddings, strict=True)
    ):
        other_embeddings = [
            candidate
            for other_index, candidate in enumerate(reference_embeddings)
            if other_index != index
        ]
        comparison_centroid = unit(np.mean(other_embeddings, axis=0))
        reference_rows.append(
            {
                "audio_path": str(audio_path),
                "audio_sha256": sha256_file(audio_path),
                "leave_one_out_cosine_similarity": round(
                    float(np.dot(embedding, comparison_centroid)),
                    6,
                ),
            }
        )

    models = []
    for run_path in sorted((root / "raw").glob("*/run.json")):
        run = json.loads(run_path.read_text(encoding="utf-8"))
        rows = []
        for generated in run["results"]:
            audio_path = Path(generated["output_path"])
            similarity = float(np.dot(embed(extractor, audio_path), centroid))
            rows.append(
                {
                    "passage_id": generated["passage_id"],
                    "audio_path": str(audio_path),
                    "audio_sha256": sha256_file(audio_path),
                    "cosine_similarity": round(similarity, 6),
                }
            )
        models.append(
            {
                "model_id": run["model_id"],
                "aggregate": summarize(
                    [row["cosine_similarity"] for row in rows]
                ),
                "rows": rows,
            }
        )
    models.sort(
        key=lambda row: row["aggregate"]["mean_cosine_similarity"],
        reverse=True,
    )
    report = {
        "schema": "goldflow_tts_speaker_similarity_v1",
        "status": "passed",
        "method": "WeSpeaker VoxCeleb ResNet34 LM cosine similarity",
        "model_path": str(model_path),
        "model_sha256": sha256_file(model_path),
        "reference_centroid_count": len(reference_embeddings),
        "reference_self_consistency": {
            **summarize(
                [row["leave_one_out_cosine_similarity"] for row in reference_rows]
            ),
            "rows": reference_rows,
        },
        "ranking": [
            {
                "rank": index + 1,
                "model_id": model["model_id"],
                **model["aggregate"],
            }
            for index, model in enumerate(models)
        ],
        "models": models,
    }
    output_path = root / "speaker_similarity.json"
    atomic_json(output_path, report)
    print(json.dumps(report["ranking"], indent=2))


if __name__ == "__main__":
    main()
