#!/usr/bin/env python3

"""Score Goldflow TTS bake-off outputs with transcript and waveform checks."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import shutil
import subprocess
import wave
from pathlib import Path
from statistics import mean, pstdev
from typing import Any

import numpy as np
from faster_whisper import WhisperModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--bakeoff-root", required=True)
    parser.add_argument("--whisper-model", default="medium")
    parser.add_argument("--seed", type=int, default=20260726)
    return parser.parse_args()


def write_json(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


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
        return [tens[value // 10], *integer_words(value % 10)] if value % 10 else [tens[value // 10]]
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


def edit_counts(expected: list[str], actual: list[str]) -> dict[str, int]:
    rows: list[list[tuple[int, int, int, int]]] = [
        [(index, 0, 0, index) for index in range(len(actual) + 1)]
    ]
    for exp_index, exp_word in enumerate(expected, start=1):
        row: list[tuple[int, int, int, int]] = [(exp_index, 0, exp_index, 0)]
        for act_index, act_word in enumerate(actual, start=1):
            if exp_word == act_word:
                prior = rows[exp_index - 1][act_index - 1]
                row.append(prior)
                continue
            deletion = rows[exp_index - 1][act_index]
            insertion = row[act_index - 1]
            substitution = rows[exp_index - 1][act_index - 1]
            choices = [
                (deletion[0] + 1, deletion[1], deletion[2] + 1, deletion[3]),
                (insertion[0] + 1, insertion[1], insertion[2], insertion[3] + 1),
                (
                    substitution[0] + 1,
                    substitution[1] + 1,
                    substitution[2],
                    substitution[3],
                ),
            ]
            row.append(min(choices, key=lambda item: item[0]))
        rows.append(row)
    distance, substitutions, deletions, insertions = rows[-1][-1]
    return {
        "distance": distance,
        "substitutions": substitutions,
        "deletions": deletions,
        "insertions": insertions,
    }


def read_pcm_wav(file_path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(file_path), "rb") as handle:
        sample_rate = handle.getframerate()
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())
    if sample_width == 2:
        audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif sample_width == 4:
        audio = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported WAV width {sample_width}: {file_path}")
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, sample_rate


def frame_rms(audio: np.ndarray, sample_rate: int, frame_ms: int = 10) -> np.ndarray:
    frame_size = max(1, round(sample_rate * frame_ms / 1000))
    usable = len(audio) // frame_size * frame_size
    if not usable:
        return np.array([], dtype=np.float32)
    frames = audio[:usable].reshape(-1, frame_size)
    return np.sqrt(np.mean(np.square(frames), axis=1))


def waveform_metrics(
    audio: np.ndarray, sample_rate: int, asr_words: list[dict[str, Any]]
) -> dict[str, Any]:
    duration_sec = len(audio) / sample_rate if sample_rate else 0
    peak = float(np.max(np.abs(audio))) if len(audio) else 0
    rms = float(np.sqrt(np.mean(np.square(audio)))) if len(audio) else 0
    frames = frame_rms(audio, sample_rate)
    active_threshold = max(0.001, peak * 0.02)
    active_indices = np.flatnonzero(frames >= active_threshold)
    if len(active_indices):
        leading_quiet_ms = int(active_indices[0] * 10)
        trailing_quiet_ms = int(max(0, (len(frames) - active_indices[-1] - 1) * 10))
    else:
        leading_quiet_ms = round(duration_sec * 1000)
        trailing_quiet_ms = round(duration_sec * 1000)
    endpoint_size = max(1, round(sample_rate * 0.01))
    endpoint = audio[-endpoint_size:] if len(audio) else np.array([0], dtype=np.float32)
    endpoint_peak = float(np.max(np.abs(endpoint)))
    endpoint_rms = float(np.sqrt(np.mean(np.square(endpoint))))
    last_sample = float(audio[-1]) if len(audio) else 0
    clipping_fraction = (
        float(np.mean(np.abs(audio) >= 0.999)) if len(audio) else 0
    )
    sample_steps = np.abs(np.diff(audio)) if len(audio) > 1 else np.array([])
    maximum_sample_step = (
        float(np.max(sample_steps)) if len(sample_steps) else 0
    )
    large_sample_step_count = (
        int(np.sum(sample_steps >= 0.3)) if len(sample_steps) else 0
    )

    word_mask = np.zeros(len(frames), dtype=bool)
    for word in asr_words:
        start = max(0, int((float(word["start_sec"]) - 0.04) * 100))
        end = min(len(word_mask), math.ceil((float(word["end_sec"]) + 0.04) * 100))
        word_mask[start:end] = True
    nonword_active = (~word_mask) & (frames >= max(active_threshold, rms * 0.55))
    burst_runs = 0
    cursor = 0
    while cursor < len(nonword_active):
        if not nonword_active[cursor]:
            cursor += 1
            continue
        end = cursor
        while end < len(nonword_active) and nonword_active[end]:
            end += 1
        run_ms = (end - cursor) * 10
        if 40 <= run_ms <= 250:
            burst_runs += 1
        cursor = end

    return {
        "duration_sec": round(duration_sec, 6),
        "peak_dbfs": round(20 * math.log10(max(peak, 1e-9)), 3),
        "rms_dbfs": round(20 * math.log10(max(rms, 1e-9)), 3),
        "dc_offset": round(float(np.mean(audio)) if len(audio) else 0, 8),
        "clipping_fraction": round(clipping_fraction, 8),
        "maximum_sample_step_dbfs": round(
            20 * math.log10(max(maximum_sample_step, 1e-9)),
            3,
        ),
        "large_sample_step_count": large_sample_step_count,
        "impulsive_discontinuity": maximum_sample_step > 10 ** (-8 / 20),
        "leading_quiet_ms": leading_quiet_ms,
        "trailing_quiet_ms": trailing_quiet_ms,
        "last_sample": round(last_sample, 8),
        "endpoint_10ms_peak_dbfs": round(
            20 * math.log10(max(endpoint_peak, 1e-9)), 3
        ),
        "endpoint_10ms_rms_dbfs": round(
            20 * math.log10(max(endpoint_rms, 1e-9)), 3
        ),
        "active_at_eof": trailing_quiet_ms < 30
        or endpoint_peak > 0.01
        or abs(last_sample) > 0.005,
        "nonword_energy_burst_count": burst_runs,
        "near_silent": peak < 0.01 or rms < 0.001,
    }


def join_pair_metrics(
    model_rows: list[dict[str, Any]],
    passage_map: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    rows_by_id = {row["passage_id"]: row for row in model_rows}
    pairs: dict[str, dict[str, str]] = {}
    for passage_id, passage in passage_map.items():
        if passage.get("category") != "join_pair":
            continue
        pair_id = passage.get("pair_id")
        side = passage.get("side")
        if pair_id and side:
            pairs.setdefault(pair_id, {})[side] = passage_id

    reports = []
    for pair_id, sides in sorted(pairs.items()):
        if "left" not in sides or "right" not in sides:
            continue
        left_row = rows_by_id[sides["left"]]
        right_row = rows_by_id[sides["right"]]
        left, left_rate = read_pcm_wav(Path(left_row["audio_path"]))
        right, right_rate = read_pcm_wav(Path(right_row["audio_path"]))
        if left_rate != right_rate:
            reports.append(
                {
                    "pair_id": pair_id,
                    "status": "not_comparable_sample_rate_mismatch",
                    "left_sample_rate_hz": left_rate,
                    "right_sample_rate_hz": right_rate,
                }
            )
            continue
        fade_samples = min(
            round(left_rate * 0.008),
            max(1, len(left) // 4),
            max(1, len(right) // 4),
        )
        faded_left = left.copy()
        faded_right = right.copy()
        if fade_samples > 0:
            faded_left[-fade_samples:] *= np.linspace(
                1.0, 0.0, fade_samples, dtype=np.float32
            )
            faded_right[:fade_samples] *= np.linspace(
                0.0, 1.0, fade_samples, dtype=np.float32
            )
        gap = np.zeros(round(left_rate * 0.16), dtype=np.float32)
        boundary_window = np.concatenate(
            [
                faded_left[-max(fade_samples, 1) :],
                gap,
                faded_right[: max(fade_samples, 1)],
            ]
        )
        maximum_faded_step = (
            float(np.max(np.abs(np.diff(boundary_window))))
            if len(boundary_window) > 1
            else 0
        )
        raw_zero_entry = abs(float(left[-1])) if len(left) else 0
        raw_zero_exit = abs(float(right[0])) if len(right) else 0
        reports.append(
            {
                "pair_id": pair_id,
                "status": "passed"
                if maximum_faded_step <= 10 ** (-8 / 20)
                else "blocked_impulsive_join",
                "left_passage_id": sides["left"],
                "right_passage_id": sides["right"],
                "combined_passage_id": sides.get("combined"),
                "sample_rate_hz": left_rate,
                "simulated_segment_gap_ms": 160,
                "simulated_fade_ms": 8,
                "raw_zero_gap_entry_jump_dbfs": round(
                    20 * math.log10(max(raw_zero_entry, 1e-9)),
                    3,
                ),
                "raw_zero_gap_exit_jump_dbfs": round(
                    20 * math.log10(max(raw_zero_exit, 1e-9)),
                    3,
                ),
                "raw_zero_gap_click_risk": max(
                    raw_zero_entry, raw_zero_exit
                )
                > 0.015,
                "simulated_faded_maximum_step_dbfs": round(
                    20 * math.log10(max(maximum_faded_step, 1e-9)),
                    3,
                ),
                "left_last_token_ok": left_row["asr"]["last_token_ok"],
                "right_first_token_ok": right_row["asr"]["first_token_ok"],
            }
        )
    return reports


def normalize_for_listening(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-i",
            str(source),
            "-af",
            "loudnorm=I=-16:LRA=11:TP=-1.5",
            "-ar",
            "24000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(target),
        ],
        check=True,
    )


def model_score(rows: list[dict[str, Any]], run: dict[str, Any]) -> dict[str, Any]:
    count = max(1, len(rows))
    mean_wer = mean(row["asr"]["wer"] for row in rows)
    exact_rate = sum(row["asr"]["distance"] == 0 for row in rows) / count
    edge_failure_rate = sum(
        row["waveform"]["active_at_eof"] for row in rows
    ) / count
    silence_failure_rate = sum(row["waveform"]["near_silent"] for row in rows) / count
    clipping_rate = sum(
        row["waveform"]["clipping_fraction"] > 0.0001 for row in rows
    ) / count
    click_failure_rate = sum(
        row["waveform"]["impulsive_discontinuity"] for row in rows
    ) / count
    average_nonword_bursts = mean(
        row["waveform"]["nonword_energy_burst_count"] for row in rows
    )
    wpms = [row["asr"]["wpm"] for row in rows if row["asr"]["wpm"] is not None]
    avg_wpm = mean(wpms) if wpms else 0
    wpm_std = pstdev(wpms) if len(wpms) > 1 else 0
    average_rtf = (
        float(run.get("total_generation_time_sec", 0))
        / max(float(run.get("total_audio_duration_sec", 0)), 0.001)
    )

    fidelity = 45 * max(0, 1 - mean_wer / 0.15)
    edges = 20 * max(0, 1 - edge_failure_rate)
    pace = 15 * max(0, 1 - abs(avg_wpm - 207.5) / 80)
    stability = 10 * max(
        0,
        1
        - silence_failure_rate
        - clipping_rate
        - click_failure_rate
        - min(wpm_std / 200, 0.5),
    )
    speed = 10 * max(0, 1 - min(average_rtf / 2.0, 1))
    score = fidelity + edges + pace + stability + speed
    return {
        "score": round(score, 3),
        "mean_wer": round(mean_wer, 5),
        "exact_transcript_rate": round(exact_rate, 5),
        "edge_failure_rate": round(edge_failure_rate, 5),
        "silence_failure_rate": round(silence_failure_rate, 5),
        "clipping_failure_rate": round(clipping_rate, 5),
        "impulsive_discontinuity_rate": round(click_failure_rate, 5),
        "average_nonword_energy_bursts": round(average_nonword_bursts, 3),
        "average_wpm": round(avg_wpm, 3),
        "wpm_stddev": round(wpm_std, 3),
        "average_generation_rtf": round(average_rtf, 4),
        "component_scores": {
            "transcript_fidelity_45": round(fidelity, 3),
            "edge_integrity_20": round(edges, 3),
            "pace_15": round(pace, 3),
            "stability_10": round(stability, 3),
            "throughput_10": round(speed, 3),
        },
    }


def write_markdown_report(root: Path, result: dict[str, Any]) -> None:
    speaker_path = root / "speaker_similarity.json"
    speaker_report = (
        json.loads(speaker_path.read_text(encoding="utf-8"))
        if speaker_path.exists()
        else {}
    )
    speaker_by_model = {
        row["model_id"]: row["mean_cosine_similarity"]
        for row in speaker_report.get("ranking", [])
    }
    has_speaker_similarity = bool(speaker_by_model)
    scoring_description = (
        " Speaker similarity is reported separately and does not affect rank."
        if has_speaker_similarity
        else " Voice identity is intentionally not scored."
    )
    lines = [
        "# Goldflow TTS reliability bake-off",
        "",
        "This is an objective reliability report, not a perceptual MOS test. "
        "Scores combine transcript fidelity, endpoint integrity, measured pace, "
        f"stability, and warm-generation throughput.{scoring_description}",
        "",
    ]
    if has_speaker_similarity:
        lines.extend(
            [
                "| Rank | Model | Score | Passage pass | WER | WPM | RTF | Voice similarity |",
                "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
    else:
        lines.extend(
            [
                "| Rank | Model | Score | Passage pass | WER | WPM | RTF |",
                "| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
    for row in result["ranking"]:
        voice_similarity = speaker_by_model.get(row["model_id"])
        base_row = (
            f"| {row['rank']} | `{row['model_id']}` | {row['score']:.3f} | "
            f"{row['passage_pass_rate'] * 100:.1f}% | "
            f"{row['mean_wer'] * 100:.2f}% | {row['average_wpm']:.1f} | "
            f"{row['average_generation_rtf']:.3f} |"
        )
        lines.append(
            f"{base_row[:-1]} {voice_similarity:.3f} |"
            if voice_similarity is not None
            else base_row
        )
    detail_lines = [
        f"- Full machine-readable results: `{root / 'bakeoff_results.json'}`",
        f"- Blinded listening pack: `{root / 'blind'}`",
    ]
    if has_speaker_similarity:
        detail_lines.insert(
            1,
            f"- Speaker-similarity detail: `{speaker_path}`",
        )
    lines.extend(
        [
            "",
            "All ranked runs were checked for clipping, silence collapse, "
            "impulsive sample discontinuities, first/final-token loss, and "
            "three production-style left/right join simulations using 8 ms "
            "fades with a 160 ms segment gap.",
            "",
            *detail_lines,
            "",
        ]
    )
    (root / "bakeoff_report.md").write_text(
        "\n".join(lines),
        encoding="utf-8",
    )


def main() -> None:
    args = parse_args()
    root = Path(args.bakeoff_root).resolve()
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    passage_map = {row["id"]: row for row in manifest["passages"]}
    run_paths = sorted((root / "raw").glob("*/run.json"))
    if not run_paths:
        raise ValueError(f"No model run.json files beneath {root / 'raw'}")

    whisper = WhisperModel(
        args.whisper_model, device="auto", compute_type="auto"
    )
    models: list[dict[str, Any]] = []
    for run_path in run_paths:
        run = json.loads(run_path.read_text(encoding="utf-8"))
        model_id = run["model_id"]
        model_rows: list[dict[str, Any]] = []
        for generated in run["results"]:
            passage_id = generated["passage_id"]
            expected_text = passage_map[passage_id]["text"]
            audio_path = Path(generated["output_path"])
            audio_sha256 = sha256_file(audio_path)
            analysis_path = root / "analysis" / model_id / f"{passage_id}.json"
            cached = (
                json.loads(analysis_path.read_text(encoding="utf-8"))
                if analysis_path.exists()
                else None
            )
            cache_matches = (
                cached
                and cached.get("audio_sha256") == audio_sha256
                and cached.get("asr", {}).get("engine") == "faster_whisper"
                and cached.get("asr", {}).get("model") == args.whisper_model
            )
            if cache_matches:
                transcript = cached["asr"]["transcript"]
                asr_words = cached["asr"]["words"]
            else:
                segments, _info = whisper.transcribe(
                    str(audio_path),
                    language="en",
                    word_timestamps=True,
                    vad_filter=False,
                    beam_size=5,
                )
                asr_segments = list(segments)
                transcript = " ".join(
                    segment.text.strip() for segment in asr_segments
                ).strip()
                asr_words = [
                    {
                        "word": word.word.strip(),
                        "start_sec": round(float(word.start), 3),
                        "end_sec": round(float(word.end), 3),
                        "probability": round(
                            float(getattr(word, "probability", 0) or 0), 4
                        ),
                    }
                    for segment in asr_segments
                    for word in (segment.words or [])
                ]
            expected_tokens = normalized_tokens(expected_text)
            actual_tokens = normalized_tokens(transcript)
            counts = edit_counts(expected_tokens, actual_tokens)
            first_word_start = (
                asr_words[0]["start_sec"] if asr_words else None
            )
            last_word_end = asr_words[-1]["end_sec"] if asr_words else None
            speech_span = (
                last_word_end - first_word_start
                if first_word_start is not None
                and last_word_end is not None
                and last_word_end > first_word_start
                else None
            )
            wpm = (
                len(expected_tokens) / speech_span * 60
                if speech_span and expected_tokens
                else None
            )
            audio, sample_rate = read_pcm_wav(audio_path)
            waveform = waveform_metrics(audio, sample_rate, asr_words)
            asr_report = {
                "engine": "faster_whisper",
                "model": args.whisper_model,
                "transcript": transcript,
                "expected_tokens": len(expected_tokens),
                "actual_tokens": len(actual_tokens),
                **counts,
                "wer": round(
                    counts["distance"] / max(1, len(expected_tokens)), 6
                ),
                "first_token_ok": bool(
                    expected_tokens
                    and actual_tokens
                    and expected_tokens[0] == actual_tokens[0]
                ),
                "last_token_ok": bool(
                    expected_tokens
                    and actual_tokens
                    and expected_tokens[-1] == actual_tokens[-1]
                ),
                "speech_span_sec": round(speech_span, 3)
                if speech_span is not None
                else None,
                "wpm": round(wpm, 3) if wpm is not None else None,
                "words": asr_words,
            }
            normalized_path = (
                root / "normalized" / model_id / f"{passage_id}.wav"
            )
            normalize_for_listening(audio_path, normalized_path)
            row = {
                "model_id": model_id,
                "passage_id": passage_id,
                "category": passage_map[passage_id].get("category"),
                "audio_path": str(audio_path),
                "audio_sha256": audio_sha256,
                "normalized_audio_path": str(normalized_path),
                "generation": generated,
                "asr": asr_report,
                "waveform": waveform,
                "passed": counts["distance"] / max(1, len(expected_tokens))
                <= 0.05
                and asr_report["first_token_ok"]
                and asr_report["last_token_ok"]
                and not waveform["active_at_eof"]
                and not waveform["near_silent"]
                and not waveform["impulsive_discontinuity"]
                and waveform["clipping_fraction"] <= 0.0001,
            }
            model_rows.append(row)
            write_json(analysis_path, row)
        aggregate = model_score(model_rows, run)
        joins = join_pair_metrics(model_rows, passage_map)
        aggregate["join_pair_count"] = len(joins)
        aggregate["raw_zero_gap_click_risk_rate"] = round(
            sum(row.get("raw_zero_gap_click_risk", False) for row in joins)
            / max(1, len(joins)),
            5,
        )
        aggregate["simulated_faded_join_failure_rate"] = round(
            sum(row.get("status") != "passed" for row in joins)
            / max(1, len(joins)),
            5,
        )
        models.append(
            {
                "model_id": model_id,
                "model_kind": run["model_kind"],
                "run_path": str(run_path),
                "aggregate": aggregate,
                "passage_pass_rate": round(
                    sum(row["passed"] for row in model_rows)
                    / max(1, len(model_rows)),
                    5,
                ),
                "join_pairs": joins,
                "rows": model_rows,
            }
        )

    models.sort(key=lambda row: row["aggregate"]["score"], reverse=True)
    randomizer = random.Random(args.seed)
    listening_order: dict[str, list[dict[str, Any]]] = {}
    blind_dir = root / "blind"
    for passage_id in passage_map:
        candidates = [
            {
                "model_id": model["model_id"],
                "source": next(
                    row["normalized_audio_path"]
                    for row in model["rows"]
                    if row["passage_id"] == passage_id
                ),
            }
            for model in models
        ]
        randomizer.shuffle(candidates)
        listening_order[passage_id] = []
        for index, candidate in enumerate(candidates):
            label = chr(ord("A") + index)
            target = blind_dir / passage_id / f"{label}.wav"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(candidate["source"], target)
            listening_order[passage_id].append(
                {
                    "label": label,
                    "audio_path": str(target),
                    "model_id": candidate["model_id"],
                }
            )

    result = {
        "schema": "goldflow_tts_bakeoff_results_v1",
        "status": "passed",
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "whisper_model": args.whisper_model,
        "ranking": [
            {
                "rank": index + 1,
                "model_id": model["model_id"],
                "score": model["aggregate"]["score"],
                "passage_pass_rate": model["passage_pass_rate"],
                **{
                    key: value
                    for key, value in model["aggregate"].items()
                    if key != "score"
                },
            }
            for index, model in enumerate(models)
        ],
        "models": models,
    }
    write_json(root / "bakeoff_results.json", result)
    write_json(
        root / "blind" / "listening_order_private.json", listening_order
    )
    write_markdown_report(root, result)
    print(json.dumps(result["ranking"], indent=2))


if __name__ == "__main__":
    main()
