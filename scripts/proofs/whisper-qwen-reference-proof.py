#!/usr/bin/env python3

"""Transcribe and audit an isolated Qwen proof narration."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_words(value: str) -> list[str]:
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", value.lower())


def edit_distance(expected: list[str], observed: list[str]) -> int:
    previous = list(range(len(observed) + 1))
    for expected_index, expected_word in enumerate(expected, start=1):
        current = [expected_index]
        for observed_index, observed_word in enumerate(observed, start=1):
            substitution = previous[observed_index - 1] + (
                0 if expected_word == observed_word else 1
            )
            current.append(
                min(
                    previous[observed_index] + 1,
                    current[observed_index - 1] + 1,
                    substitution,
                )
            )
        previous = current
    return previous[-1]


def alignment_findings(
    expected: list[str], observed: list[str], limit: int = 30
) -> list[dict[str, Any]]:
    matcher = difflib.SequenceMatcher(a=expected, b=observed, autojunk=False)
    findings: list[dict[str, Any]] = []
    for tag, first_start, first_end, second_start, second_end in matcher.get_opcodes():
        if tag == "equal":
            continue
        findings.append(
            {
                "operation": tag,
                "expected_start_index": first_start,
                "expected_end_index": first_end,
                "observed_start_index": second_start,
                "observed_end_index": second_end,
                "expected": " ".join(expected[first_start:first_end]),
                "observed": " ".join(observed[second_start:second_end]),
            }
        )
        if len(findings) >= limit:
            break
    return findings


def atomic_json(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_name(f".{file_path.name}.tmp-{os.getpid()}")
    temporary.write_text(
        f"{json.dumps(value, indent=2, ensure_ascii=False)}\n",
        encoding="utf-8",
    )
    os.replace(temporary, file_path)


def main() -> None:
    args = parse_args()
    os.environ["OMP_NUM_THREADS"] = "12"
    audio_path = Path(args.audio).resolve()
    manifest_path = Path(args.manifest).resolve()
    output_path = Path(args.output).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    expected_text = " ".join(unit["spoken_text"] for unit in manifest["units"])
    expected_words = normalize_words(expected_text)
    model = WhisperModel(
        "small.en",
        device="cpu",
        compute_type="int8_float32",
        cpu_threads=0,
    )
    segments, info = model.transcribe(
        str(audio_path),
        language="en",
        word_timestamps=True,
        vad_filter=False,
        beam_size=5,
    )

    words: list[dict[str, Any]] = []
    transcript_parts: list[str] = []
    for segment in segments:
        transcript_parts.append(segment.text.strip())
        for word in segment.words or []:
            words.append(
                {
                    "word": word.word.strip(),
                    "start_sec": round(float(word.start), 3),
                    "end_sec": round(float(word.end), 3),
                    "probability": round(
                        float(getattr(word, "probability", 0.0) or 0.0), 4
                    ),
                }
            )

    transcript = " ".join(part for part in transcript_parts if part)
    observed_words = normalize_words(transcript)
    distance = edit_distance(expected_words, observed_words)
    zero_duration = [
        index
        for index, word in enumerate(words)
        if float(word["end_sec"]) <= float(word["start_sec"])
    ]
    low_probability = [
        {
            "index": index,
            **word,
        }
        for index, word in enumerate(words)
        if float(word["probability"]) < 0.35
    ]
    word_error_rate = distance / max(len(expected_words), 1)
    report = {
        "schema": "goldflow_private_proof_qwen_whisper_audit_v1",
        "status": "passed",
        "proof_only": True,
        "audio_path": str(audio_path),
        "audio_sha256": sha256_file(audio_path),
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "contract": {
            "engine": "faster_whisper",
            "model": "small.en",
            "device": "cpu",
            "compute_type": "int8_float32",
            "omp_num_threads": 12,
            "cpu_threads": 0,
            "beam_size": 5,
            "word_timestamps": True,
            "vad_filter": False,
        },
        "language": info.language,
        "language_probability": round(float(info.language_probability), 6),
        "duration_sec": round(float(info.duration), 6),
        "expected_normalized_word_count": len(expected_words),
        "observed_normalized_word_count": len(observed_words),
        "edit_distance": distance,
        "word_error_rate": round(word_error_rate, 6),
        "diagnostic_transcript_status": (
            "clean" if word_error_rate <= 0.03 else "review_required"
        ),
        "zero_duration_word_count": len(zero_duration),
        "zero_duration_word_indices": zero_duration,
        "low_probability_word_count": len(low_probability),
        "low_probability_words": low_probability[:100],
        "alignment_findings": alignment_findings(expected_words, observed_words),
        "transcript": transcript,
        "words": words,
    }
    atomic_json(output_path, report)
    print(
        json.dumps(
            {
                "status": report["status"],
                "output": str(output_path),
                "duration_sec": report["duration_sec"],
                "word_error_rate": report["word_error_rate"],
                "diagnostic_transcript_status": report[
                    "diagnostic_transcript_status"
                ],
            }
        )
    )


if __name__ == "__main__":
    main()
