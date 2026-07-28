#!/usr/bin/env python3

"""Run one end-to-end medium-Whisper audit across the five-model TTS proof."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel


@dataclass(frozen=True)
class ProofSpec:
    key: str
    label: str
    directory: str
    blocked: bool = False
    listening_override: str | None = None
    generation_retry_count: int = 0
    first_pass_blocked_unit_count: int = 0
    intervention: str = "none"


SPECS = [
    ProofSpec(
        "qwen3_tts_1_7b",
        "Qwen3-TTS 1.7B",
        "qwen3_tts_1_7b",
    ),
    ProofSpec(
        "supertonic3_m3",
        "Supertonic 3 M3",
        "supertonic3_m3",
        generation_retry_count=1,
        first_pass_blocked_unit_count=1,
        intervention="one exact unit regenerated after its opening word was omitted",
    ),
    ProofSpec(
        "soprano_1_1",
        "Soprano 1.1 80M",
        "soprano_1_1",
        first_pass_blocked_unit_count=2,
        intervention="two active-tail units received an 8 ms fade plus 60 ms zero pad",
    ),
    ProofSpec(
        "pocket_tts",
        "Pocket TTS 2.1",
        "pocket_tts",
        listening_override="pocket_tts_3min_listening_proof.m4a",
    ),
    ProofSpec(
        "moss_tts_nano",
        "MOSS-TTS-Nano",
        "moss_tts_nano",
        blocked=True,
        first_pass_blocked_unit_count=4,
        intervention="failures preserved; no failed speech regenerated",
    ),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--proof-root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--whisper-model", default="medium")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--cpu-threads", type=int, default=0)
    parser.add_argument("--only")
    parser.add_argument("--cache-only", action="store_true")
    parser.add_argument("--include-kokoro", action="store_true")
    parser.add_argument(
        "--kokoro-directory",
        default="kokoro_bf16_af_heart",
    )
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / handle.getframerate()


def integer_words(value: int) -> list[str]:
    ones = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ]
    tens = [
        "",
        "",
        "twenty",
        "thirty",
        "forty",
        "fifty",
        "sixty",
        "seventy",
        "eighty",
        "ninety",
    ]
    if value < 20:
        return [ones[value]]
    if value < 100:
        return (
            [tens[value // 10], *integer_words(value % 10)]
            if value % 10
            else [tens[value // 10]]
        )
    if value < 1000:
        tail = integer_words(value % 100) if value % 100 else []
        return [ones[value // 100], "hundred", *tail]
    if value < 1_000_000:
        tail = integer_words(value % 1000) if value % 1000 else []
        return [*integer_words(value // 1000), "thousand", *tail]
    return [str(value)]


def normalized_tokens(value: str) -> list[str]:
    raw = re.findall(
        r"[A-Za-z0-9]+(?:['’][A-Za-z]+)?",
        value.replace("%", " percent"),
    )
    rows: list[str] = []
    for token in raw:
        clean = token.lower().replace("’", "'").replace("'", "")
        if clean.isdigit():
            rows.extend(integer_words(int(clean)))
        elif clean == "st":
            rows.append("saint")
        elif clean.isalpha() and 2 <= len(clean) <= 5 and token.isupper():
            rows.extend(list(clean))
        else:
            rows.append(clean)
    return rows


def alignment(expected: list[str], actual: list[str]) -> dict[str, Any]:
    distances = [[0] * (len(actual) + 1) for _ in range(len(expected) + 1)]
    back: list[list[str | None]] = [
        [None] * (len(actual) + 1) for _ in range(len(expected) + 1)
    ]
    for index in range(1, len(expected) + 1):
        distances[index][0] = index
        back[index][0] = "deletion"
    for index in range(1, len(actual) + 1):
        distances[0][index] = index
        back[0][index] = "insertion"
    for exp_index, exp_token in enumerate(expected, start=1):
        for act_index, act_token in enumerate(actual, start=1):
            if exp_token == act_token:
                distances[exp_index][act_index] = distances[exp_index - 1][act_index - 1]
                back[exp_index][act_index] = "match"
                continue
            choices = [
                (distances[exp_index - 1][act_index - 1] + 1, "substitution"),
                (distances[exp_index - 1][act_index] + 1, "deletion"),
                (distances[exp_index][act_index - 1] + 1, "insertion"),
            ]
            distances[exp_index][act_index], back[exp_index][act_index] = min(
                choices, key=lambda item: item[0]
            )
    operations: list[dict[str, str | None]] = []
    exp_index = len(expected)
    act_index = len(actual)
    while exp_index or act_index:
        operation = back[exp_index][act_index]
        if operation == "match":
            operations.append(
                {
                    "type": "match",
                    "intended": expected[exp_index - 1],
                    "recognized": actual[act_index - 1],
                }
            )
            exp_index -= 1
            act_index -= 1
        elif operation == "substitution":
            operations.append(
                {
                    "type": "substitution",
                    "intended": expected[exp_index - 1],
                    "recognized": actual[act_index - 1],
                }
            )
            exp_index -= 1
            act_index -= 1
        elif operation == "deletion":
            operations.append(
                {
                    "type": "deletion",
                    "intended": expected[exp_index - 1],
                    "recognized": None,
                }
            )
            exp_index -= 1
        elif operation == "insertion":
            operations.append(
                {
                    "type": "insertion",
                    "intended": None,
                    "recognized": actual[act_index - 1],
                }
            )
            act_index -= 1
        else:
            raise RuntimeError("Alignment backtrace failed.")
    operations.reverse()
    counts = {
        kind: sum(row["type"] == kind for row in operations)
        for kind in ("substitution", "deletion", "insertion")
    }

    def longest_run(kind: str) -> int:
        longest = 0
        current = 0
        for row in operations:
            if row["type"] == kind:
                current += 1
                longest = max(longest, current)
            else:
                current = 0
        return longest

    leading_deletions = 0
    for row in operations:
        if row["type"] == "deletion":
            leading_deletions += 1
        elif row["type"] != "insertion":
            break
    trailing_deletions = 0
    for row in reversed(operations):
        if row["type"] == "deletion":
            trailing_deletions += 1
        elif row["type"] != "insertion":
            break
    nonmatches = [
        {
            "operation_index": index,
            **row,
            "left_context": operations[max(0, index - 2) : index],
            "right_context": operations[index + 1 : index + 3],
        }
        for index, row in enumerate(operations)
        if row["type"] != "match"
    ]
    distance = counts["substitution"] + counts["deletion"] + counts["insertion"]
    return {
        "distance": distance,
        "substitutions": counts["substitution"],
        "deletions": counts["deletion"],
        "insertions": counts["insertion"],
        "word_error_rate": round(distance / max(1, len(expected)), 6),
        "longest_deletion_run": longest_run("deletion"),
        "longest_insertion_run": longest_run("insertion"),
        "leading_deletion_run": leading_deletions,
        "trailing_deletion_run": trailing_deletions,
        "first_token_ok": bool(expected and actual and expected[0] == actual[0]),
        "last_token_ok": bool(expected and actual and expected[-1] == actual[-1]),
        "nonmatches": nonmatches[:80],
    }


def contains_sequence(haystack: list[str], needle: list[str]) -> bool:
    if not needle or len(needle) > len(haystack):
        return False
    return any(
        haystack[index : index + len(needle)] == needle
        for index in range(len(haystack) - len(needle) + 1)
    )


def adjudicate_long_medium_deletions(
    medium: dict[str, Any],
    unit_qa: dict[str, Any],
    passages: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    deletion_rows = [
        row for row in medium.get("nonmatches", []) if row.get("type") == "deletion"
    ]
    runs: list[list[dict[str, Any]]] = []
    for row in deletion_rows:
        if (
            runs
            and int(row["operation_index"])
            == int(runs[-1][-1]["operation_index"]) + 1
        ):
            runs[-1].append(row)
        else:
            runs.append([row])
    qa_by_id = {
        str(row["unit_id"]): row.get("qa") or {}
        for row in unit_qa.get("units", [])
    }
    reports = []
    for run in [row for row in runs if len(row) > 1]:
        deleted_tokens = [str(row["intended"]) for row in run]
        candidate_ids = [
            passage_id
            for passage_id, passage in passages.items()
            if contains_sequence(normalized_tokens(passage["text"]), deleted_tokens)
        ]
        resolved_ids = []
        for passage_id in candidate_ids:
            qa = qa_by_id.get(passage_id, {})
            recognized = normalized_tokens(
                qa.get("transcript", {}).get("recognized_text", "")
            )
            if (
                qa.get("status") != "blocked"
                and contains_sequence(recognized, deleted_tokens)
            ):
                resolved_ids.append(passage_id)
        reports.append(
            {
                "deleted_tokens": deleted_tokens,
                "run_length": len(run),
                "full_stream_operation_start": run[0]["operation_index"],
                "candidate_unit_ids": candidate_ids,
                "resolved_by_exact_unit_qa": bool(resolved_ids),
                "resolving_unit_ids": resolved_ids,
                "interpretation": (
                    "full-stream medium-ASR miss; exact unit QA heard the words"
                    if resolved_ids
                    else "unresolved possible TTS deletion"
                ),
            }
        )
    unresolved = [
        row["run_length"]
        for row in reports
        if not row["resolved_by_exact_unit_qa"]
    ]
    return {
        "status": "resolved" if reports and not unresolved else (
            "unresolved" if unresolved else "not_needed"
        ),
        "runs": reports,
        "unresolved_longest_deletion_run": max(unresolved, default=0),
    }


def observed_first_pass_blocked_unit_count(unit_qa: dict[str, Any]) -> int:
    blocked_ids = {
        str(row["unit_id"])
        for row in unit_qa.get("blockers", [])
        if row.get("unit_id") is not None
    }
    for row in unit_qa.get("units", []):
        qa = row.get("qa") or {}
        findings = qa.get("findings") or []
        if qa.get("status") == "blocked" or any(
            finding.get("severity") == "blocker"
            or finding.get("original_severity") == "blocker"
            for finding in findings
        ):
            blocked_ids.add(str(row["unit_id"]))
    return len(blocked_ids)


def transcribe(
    model: WhisperModel,
    audio_path: Path,
    expected_text: str,
    model_name: str,
    cache_path: Path,
) -> dict[str, Any]:
    audio_sha = sha256_file(audio_path)
    expected_sha = sha256_text(expected_text)
    if cache_path.exists():
        cached = read_json(cache_path)
        if (
            cached.get("audio_sha256") == audio_sha
            and cached.get("expected_text_sha256") == expected_sha
            and cached.get("whisper_model") == model_name
        ):
            return cached
    segments, info = model.transcribe(
        str(audio_path),
        language="en",
        word_timestamps=True,
        vad_filter=False,
        beam_size=5,
    )
    materialized = list(segments)
    transcript = " ".join(row.text.strip() for row in materialized).strip()
    words = [
        {
            "word": word.word.strip(),
            "start_sec": round(float(word.start), 3),
            "end_sec": round(float(word.end), 3),
            "probability": round(float(getattr(word, "probability", 0) or 0), 4),
        }
        for segment in materialized
        for word in (segment.words or [])
    ]
    expected = normalized_tokens(expected_text)
    actual = normalized_tokens(transcript)
    edit_report = alignment(expected, actual)
    duration_sec = wav_duration(audio_path)
    speech_span_sec = (
        float(words[-1]["end_sec"]) - float(words[0]["start_sec"])
        if len(words) >= 2
        else None
    )
    result = {
        "status": "passed",
        "engine": "faster_whisper",
        "whisper_model": model_name,
        "language": info.language,
        "language_probability": info.language_probability,
        "audio_path": str(audio_path),
        "audio_sha256": audio_sha,
        "expected_text_sha256": expected_sha,
        "expected_token_count": len(expected),
        "recognized_token_count": len(actual),
        "recognized_text": transcript,
        "recognized_words": words,
        "duration_sec": round(duration_sec, 6),
        "delivered_wpm": round(len(expected) / max(duration_sec, 0.001) * 60, 3),
        "speech_span_sec": round(speech_span_sec, 3) if speech_span_sec else None,
        "speech_span_wpm": (
            round(len(expected) / speech_span_sec * 60, 3)
            if speech_span_sec and speech_span_sec > 0
            else None
        ),
        **edit_report,
    }
    write_json(cache_path, result)
    return result


def main() -> None:
    args = parse_args()
    root = Path(args.proof_root).resolve()
    manifest_path = Path(args.manifest).resolve()
    manifest = read_json(manifest_path)
    passages = {row["id"]: row for row in manifest["passages"]}
    all_ids = [row["id"] for row in manifest["passages"]]
    specs = list(SPECS)
    if args.include_kokoro:
        specs.append(
            ProofSpec(
                "kokoro_bf16_af_heart",
                "Kokoro 82M BF16 af_heart",
                args.kokoro_directory,
            )
        )
    model = WhisperModel(
        args.whisper_model,
        device=args.device,
        compute_type=args.compute_type,
        cpu_threads=args.cpu_threads,
    )
    results: list[dict[str, Any]] = []
    selected_specs = [
        spec for spec in specs if not args.only or spec.key == args.only
    ]
    if not selected_specs:
        raise ValueError(f"Unknown --only proof key: {args.only}")
    for spec in selected_specs:
        proof_dir = root / spec.directory
        unit_qa = read_json(proof_dir / "unit_qa.json")
        run_path = (
            proof_dir / "run.json"
            if (proof_dir / "run.json").exists()
            else proof_dir / "raw" / "run.json"
        )
        run = read_json(run_path)
        proof_path = proof_dir / "proof_report.json"
        build_path = proof_dir / "proof_build_report.json"
        proof = read_json(proof_path) if proof_path.exists() else None
        build = read_json(build_path) if build_path.exists() else None
        proof_matches_current_run = bool(
            proof
            and proof.get("status") == "passed"
            and proof.get("manifest_sha256") == sha256_file(manifest_path)
            and proof.get("synthesis_run_sha256") == sha256_file(run_path)
        )
        blocked = spec.blocked
        if spec.key == "kokoro_bf16_af_heart":
            blocked = (
                unit_qa.get("status") != "passed"
                or (build or {}).get("status") == "blocked"
                or not proof_matches_current_run
            )
        if blocked:
            listen = (build or {}).get("blocked_listening_copy")
            if not isinstance(listen, dict):
                raise RuntimeError(
                    f"Blocked proof {spec.key} has no blocked listening copy; "
                    "rerun the proof finalizer with "
                    "--emit-blocked-listening-copy true."
                )
            unit_ids = listen["selected_unit_ids"]
            audio_path = Path(listen["final_wav"])
            listening_path = Path(listen["final_m4a"])
            proof_status = "blocked"
            stitch_status = "not_run_due_to_unit_blockers"
            repair_count = 0
            final_acoustic = None
        else:
            unit_ids = all_ids
            audio_path = Path(proof["final_wav"])
            listening_path = (
                proof_dir / spec.listening_override
                if spec.listening_override
                else Path(proof["final_m4a"])
            )
            proof_status = proof["status"]
            stitch_status = proof["stitch"]["status"]
            repair_count = len(proof.get("raw_edge_repairs") or [])
            final_acoustic = proof["stitch"].get("final_qa", {}).get("metrics")
        expected_text = " ".join(passages[unit_id]["text"] for unit_id in unit_ids)
        medium = transcribe(
            model,
            audio_path,
            expected_text,
            args.whisper_model,
            proof_dir / "full_stream_medium_qa.json",
        )
        unit_blockers = unit_qa.get("blockers") or []
        unit_warnings = unit_qa.get("warnings") or []
        unit_acoustic_warning_count = sum(
            str(row.get("code") or "").startswith("tts_audio_")
            for row in unit_warnings
        )
        medium_deletion_adjudication = adjudicate_long_medium_deletions(
            medium,
            unit_qa,
            passages,
        )
        generation_sec = float(run.get("total_generation_time_sec") or 0)
        generated_audio_sec = float(run.get("total_audio_duration_sec") or 0)
        first_pass_blocked_unit_count = spec.first_pass_blocked_unit_count
        intervention = spec.intervention
        if spec.key == "kokoro_bf16_af_heart":
            first_pass_blocked_unit_count = (
                observed_first_pass_blocked_unit_count(unit_qa)
            )
            intervention = (
                "failures preserved; no failed speech regenerated"
                if blocked
                else (
                    f"{repair_count} active-edge unit(s) received recorded "
                    "stitch-preparation repair"
                    if repair_count
                    else "none"
                )
            )
        medium_gate = (
            medium["word_error_rate"] <= 0.05
            and medium["leading_deletion_run"] == 0
            and medium["trailing_deletion_run"] == 0
            and (
                medium["longest_deletion_run"] <= 1
                or medium_deletion_adjudication[
                    "unresolved_longest_deletion_run"
                ]
                <= 1
            )
            and medium["longest_insertion_run"] <= 2
            and medium["first_token_ok"]
            and medium["last_token_ok"]
        )
        results.append(
            {
                "key": spec.key,
                "label": spec.label,
                "status": proof_status,
                "eligible_for_production": (
                    proof_status == "passed"
                    and stitch_status == "passed"
                    and not unit_blockers
                    and medium_gate
                ),
                "scope_unit_count": len(unit_ids),
                "scope_intended_word_count": sum(
                    int(passages[unit_id]["word_count"]) for unit_id in unit_ids
                ),
                "same_full_722_word_scope": len(unit_ids) == len(all_ids),
                "duration_sec": medium["duration_sec"],
                "delivered_wpm": medium["delivered_wpm"],
                "speech_span_wpm": medium["speech_span_wpm"],
                "medium_whisper_wer": medium["word_error_rate"],
                "medium_whisper_substitutions": medium["substitutions"],
                "medium_whisper_deletions": medium["deletions"],
                "medium_whisper_insertions": medium["insertions"],
                "medium_whisper_longest_deletion_run": medium[
                    "longest_deletion_run"
                ],
                "medium_whisper_longest_insertion_run": medium[
                    "longest_insertion_run"
                ],
                "medium_whisper_deletion_adjudication": (
                    medium_deletion_adjudication
                ),
                "medium_whisper_first_token_ok": medium["first_token_ok"],
                "medium_whisper_last_token_ok": medium["last_token_ok"],
                "unit_qa_blocker_count": len(unit_blockers),
                "unit_qa_blocked_unit_count": unit_qa.get(
                    "blocked_unit_count",
                    len({row["unit_id"] for row in unit_blockers}),
                ),
                "unit_qa_warning_count": unit_qa.get(
                    "warning_count",
                    len(unit_warnings),
                ),
                "unit_qa_acoustic_warning_count": unit_acoustic_warning_count,
                "first_pass_blocked_unit_count": first_pass_blocked_unit_count,
                "generation_retry_count": spec.generation_retry_count,
                "repair_count": repair_count,
                "intervention": intervention,
                "stitch_status": stitch_status,
                "final_clipping_sample_count": (
                    final_acoustic.get("clipping_sample_count")
                    if final_acoustic
                    else None
                ),
                "final_large_sample_step_count": (
                    final_acoustic.get("large_sample_step_count")
                    if final_acoustic
                    else None
                ),
                "generation_realtime_multiple": (
                    round(generated_audio_sec / generation_sec, 3)
                    if generation_sec > 0
                    else None
                ),
                "model_id": run.get("model_id"),
                "model_kind": run.get("model_kind"),
                "run_path": str(
                    proof_dir / "run.json"
                    if (proof_dir / "run.json").exists()
                    else proof_dir / "raw" / "run.json"
                ),
                "audio_path": str(audio_path),
                "listening_path": str(listening_path),
                "full_stream_medium_qa_path": str(
                    proof_dir / "full_stream_medium_qa.json"
                ),
                "proof_report_path": (
                    str(proof_dir / "proof_report.json")
                    if not blocked
                    else None
                ),
                "proof_build_report_path": str(
                    proof_dir / "proof_build_report.json"
                ),
            }
        )
    if args.cache_only:
        print(
            json.dumps(
                {
                    "status": "passed",
                    "cached_proofs": [row["key"] for row in results],
                    "whisper_model": args.whisper_model,
                },
                indent=2,
            )
        )
        return
    eligible = [row for row in results if row["eligible_for_production"]]
    eligible.sort(
        key=lambda row: (
            row["first_pass_blocked_unit_count"] > 0,
            row["repair_count"] > 0,
            row["medium_whisper_wer"],
            abs(row["delivered_wpm"] - 207.5),
            -(row["generation_realtime_multiple"] or 0),
        )
    )
    report_stem = (
        "six_model_bakeoff_report"
        if args.include_kokoro
        else "five_model_bakeoff_report"
    )
    report = {
        "schema": (
            "goldflow_six_local_tts_three_minute_bakeoff_v1"
            if args.include_kokoro
            else "goldflow_five_local_tts_three_minute_bakeoff_v1"
        ),
        "status": "passed",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "diagnostic_only": True,
        "production_artifacts_mutated": False,
        "source_episode_dir": manifest["source_episode_dir"],
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "whisper_model": args.whisper_model,
        "proofs_total": len(results),
        "proofs_production_eligible": len(eligible),
        "objective_reliability_order": [row["key"] for row in eligible],
        "results": results,
        "interpretation": [
            "The medium-Whisper score is an error detector, not a perceptual voice-quality score.",
            "A model is not production-eligible when any unit or stitch blocker remains.",
            "Generation retries and model-specific tail repairs remain visible even when the final file passes.",
            "Human listening decides timbre, prosody, and whether the measured cadence feels right.",
        ],
    }
    json_path = root / f"{report_stem}.json"
    markdown_path = root / f"{report_stem}.md"
    write_json(json_path, report)
    lines = [
        f"# {len(results)}-model local TTS bake-off",
        "",
        "| Model | Status | Duration | WPM | Medium WER | D/I | First-pass blocked units | Acoustic warnings | Repairs/retries | Generation |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in results:
        status = "eligible" if row["eligible_for_production"] else "blocked"
        interventions = row["repair_count"] + row["generation_retry_count"]
        lines.append(
            f"| {row['label']} | {status} | {row['duration_sec']:.1f}s | "
            f"{row['delivered_wpm']:.1f} | {row['medium_whisper_wer'] * 100:.2f}% | "
            f"{row['medium_whisper_deletions']}/{row['medium_whisper_insertions']} | "
            f"{row['first_pass_blocked_unit_count']} | "
            f"{row['unit_qa_acoustic_warning_count']} | {interventions} | "
            f"{row['generation_realtime_multiple']:.2f}× |"
        )
    lines.extend(
        [
            "",
            "WER is an automated error detector, not a perceptual MOS score. "
            "The operator listening pass remains decisive for voice and prosody.",
            "",
        ]
    )
    markdown_path.write_text("\n".join(lines), encoding="utf-8")
    print(
        json.dumps(
            {
                "status": report["status"],
                "report_json": str(json_path),
                "report_markdown": str(markdown_path),
                "objective_reliability_order": report[
                    "objective_reliability_order"
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
