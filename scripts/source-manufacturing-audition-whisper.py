#!/usr/bin/env python3

"""Audit blind source-manufacturing TTS samples without exposing authorship."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import wave
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

os.environ.setdefault("OMP_NUM_THREADS", "12")

from faster_whisper import WhisperModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audition-dir", required=True)
    parser.add_argument("--model", default="small.en")
    parser.add_argument("--output")
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / handle.getframerate()


def tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower().replace("’", "'"))


def alignment(expected_text: str, actual_text: str) -> dict[str, Any]:
    expected = tokens(expected_text)
    actual = tokens(actual_text)
    matcher = SequenceMatcher(a=expected, b=actual, autojunk=False)
    findings = []
    substitutions = deletions = insertions = 0
    for tag, a0, a1, b0, b1 in matcher.get_opcodes():
        if tag == "equal":
            continue
        substitutions += min(a1 - a0, b1 - b0) if tag == "replace" else 0
        deletions += max(0, (a1 - a0) - (b1 - b0)) if tag == "replace" else (a1 - a0 if tag == "delete" else 0)
        insertions += max(0, (b1 - b0) - (a1 - a0)) if tag == "replace" else (b1 - b0 if tag == "insert" else 0)
        findings.append({
            "type": tag,
            "expected": expected[a0:a1],
            "recognized": actual[b0:b1],
            "expected_token_span": [a0, a1],
            "recognized_token_span": [b0, b1],
            "left_context": expected[max(0, a0 - 4):a0],
            "right_context": expected[a1:a1 + 4],
        })
    distance = substitutions + deletions + insertions
    return {
        "expected_token_count": len(expected),
        "recognized_token_count": len(actual),
        "edit_distance": distance,
        "word_error_rate": round(distance / max(1, len(expected)), 6),
        "substitutions": substitutions,
        "deletions": deletions,
        "insertions": insertions,
        "first_token_ok": bool(expected and actual and expected[0] == actual[0]),
        "last_token_ok": bool(expected and actual and expected[-1] == actual[-1]),
        "findings": findings,
    }


def transcribe(model: WhisperModel, audio_path: Path, expected_text: str) -> dict[str, Any]:
    segments, info = model.transcribe(
        str(audio_path),
        language="en",
        word_timestamps=True,
        vad_filter=False,
        beam_size=5,
    )
    materialized = list(segments)
    transcript = " ".join(segment.text.strip() for segment in materialized).strip()
    recognized_words = [
        {
            "word": word.word.strip(),
            "start_sec": round(float(word.start), 3),
            "end_sec": round(float(word.end), 3),
            "probability": round(float(getattr(word, "probability", 0.0) or 0.0), 4),
        }
        for segment in materialized
        for word in (segment.words or [])
    ]
    return {
        "audio_path": str(audio_path),
        "audio_sha256": sha256_file(audio_path),
        "duration_sec": round(wav_duration(audio_path), 6),
        "language": info.language,
        "language_probability": round(float(info.language_probability), 6),
        "expected_text": expected_text,
        "recognized_text": transcript,
        "recognized_words": recognized_words,
        "alignment": alignment(expected_text, transcript),
    }


def main() -> None:
    args = parse_args()
    audition_dir = Path(args.audition_dir).resolve()
    output_path = Path(args.output).resolve() if args.output else audition_dir / "blind_audio_whisper_diagnostic.json"
    manifest = read_json(audition_dir / "manufacturing_audio_audition_manifest.json")
    generation = read_json(audition_dir / "qwen_generation_report.json")
    candidate_by_label = {row["audition_label"]: row for row in manifest["candidates"]}
    variant_by_label = {row["id"].removeprefix("blind_"): row for row in generation["variants"]}

    model = WhisperModel(args.model, device="cpu", compute_type="int8_float32", cpu_threads=0)
    rows = []
    for label in sorted(candidate_by_label):
        candidate = candidate_by_label[label]
        variant = variant_by_label[label]
        raw_units = []
        for unit in variant["results"]:
            result = transcribe(model, Path(unit["output_path"]), unit["text"])
            result["unit_id"] = unit["unit_id"]
            result["token_limit_reached"] = bool(unit.get("token_limit_reached"))
            raw_units.append(result)
        stitched = transcribe(model, audition_dir / f"blind_{label}.wav", candidate["excerpt_text"])
        suspect_units = [
            row["unit_id"]
            for row in raw_units
            if not row["alignment"]["first_token_ok"]
            or not row["alignment"]["last_token_ok"]
            or row["alignment"]["deletions"] > 0
            or row["alignment"]["word_error_rate"] > 0.08
        ]
        rows.append({
            "blind_label": label,
            "stitched": stitched,
            "raw_units": raw_units,
            "suspect_unit_ids": suspect_units,
            "diagnostic_summary": {
                "stitched_word_error_rate": stitched["alignment"]["word_error_rate"],
                "stitched_first_token_ok": stitched["alignment"]["first_token_ok"],
                "stitched_last_token_ok": stitched["alignment"]["last_token_ok"],
                "raw_edge_or_deletion_suspect_count": len(suspect_units),
            },
        })

    document = {
        "schema": "goldflow_manhwa_manufacturing_audio_whisper_diagnostic_v1",
        "status": "completed",
        "blind_only": True,
        "whisper_contract": {
            "engine": "faster_whisper",
            "model": args.model,
            "device": "cpu",
            "compute_type": "int8_float32",
            "omp_num_threads": 12,
            "cpu_threads": 0,
            "beam_size": 5,
            "word_timestamps": True,
            "vad_filter": False,
        },
        "rows": rows,
    }
    output_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": "completed",
        "output_path": str(output_path),
        "summaries": [
            {"blind_label": row["blind_label"], **row["diagnostic_summary"], "suspect_unit_ids": row["suspect_unit_ids"]}
            for row in rows
        ],
    }, indent=2))


if __name__ == "__main__":
    main()
