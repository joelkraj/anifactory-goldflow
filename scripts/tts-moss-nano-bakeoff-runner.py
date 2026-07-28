#!/usr/bin/env python3

"""Generate a manifest-bound MOSS-TTS-Nano ONNX voice-clone proof.

The official OpenMOSS ONNX Runtime is loaded once, and the owned reference is
encoded once. Each manifest passage is then synthesized independently to one
native 48 kHz stereo WAV. This is a diagnostic bake-off runner only; it does
not read from or write to Goldflow production episode artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np


DEFAULT_RUNTIME_REPO = Path(
    "/Users/joel/AniFactoryData/voice_bank/bakeoff/MOSS-TTS-Nano"
)
DEFAULT_MODEL_DIR = DEFAULT_RUNTIME_REPO / "models"
DEFAULT_REFERENCE_AUDIO = Path(
    "/Users/joel/AniFactoryData/voice_bank/qwen/reference_samples/"
    "joel_narrator/joel_ref_06_manhwa_220wpm.wav"
)
DEFAULT_REFERENCE_TRANSCRIPT = (
    "The register turned blue before the window cracked. Outside, something "
    "tall moved between the parked cars, stopped under the dead sign, and "
    "waited like it had already learned his name."
)
TTS_MODEL_REPO_ID = "OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX"
CODEC_MODEL_REPO_ID = "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the bounded MOSS-TTS-Nano ONNX bake-off proof."
    )
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--runtime-repo",
        default=str(DEFAULT_RUNTIME_REPO),
        help="Official OpenMOSS/MOSS-TTS-Nano checkout.",
    )
    parser.add_argument(
        "--model-dir",
        default=str(DEFAULT_MODEL_DIR),
        help="Directory containing, or receiving, official ONNX assets.",
    )
    parser.add_argument(
        "--ref-audio",
        default=str(DEFAULT_REFERENCE_AUDIO),
        help="Owned narrator reference WAV.",
    )
    parser.add_argument(
        "--ref-transcript",
        default=DEFAULT_REFERENCE_TRANSCRIPT,
        help=(
            "Exact owned-reference transcript for provenance. The official "
            "ONNX voice-clone API conditions on reference audio codes only."
        ),
    )
    parser.add_argument("--cpu-threads", type=int, default=8)
    parser.add_argument(
        "--sample-mode",
        choices=("greedy", "fixed", "full"),
        default="fixed",
    )
    parser.add_argument("--seed", type=int, default=20260726)
    parser.add_argument("--max-new-frames", type=int, default=375)
    parser.add_argument("--voice-clone-max-text-tokens", type=int, default=75)
    parser.add_argument("--text-temperature", type=float, default=1.0)
    parser.add_argument("--text-top-p", type=float, default=1.0)
    parser.add_argument("--text-top-k", type=int, default=50)
    parser.add_argument("--audio-temperature", type=float, default=0.8)
    parser.add_argument("--audio-top-p", type=float, default=0.95)
    parser.add_argument("--audio-top-k", type=int, default=25)
    parser.add_argument("--audio-repetition-penalty", type=float, default=1.2)
    return parser.parse_args()


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def atomic_json_write(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = file_path.with_name(f".{file_path.name}.tmp")
    temporary_path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary_path, file_path)


def command_output(command: list[str], cwd: Path | None = None) -> str | None:
    try:
        return subprocess.run(
            command,
            cwd=str(cwd) if cwd is not None else None,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def official_repo_provenance(runtime_repo: Path) -> dict[str, Any]:
    remote = command_output(
        ["git", "config", "--get", "remote.origin.url"],
        cwd=runtime_repo,
    )
    commit = command_output(["git", "rev-parse", "HEAD"], cwd=runtime_repo)
    commit_date = command_output(
        ["git", "show", "-s", "--format=%cI", "HEAD"],
        cwd=runtime_repo,
    )
    if remote not in {
        "https://github.com/OpenMOSS/MOSS-TTS-Nano.git",
        "git@github.com:OpenMOSS/MOSS-TTS-Nano.git",
    }:
        raise ValueError(
            f"Runtime checkout is not the official OpenMOSS repository: {remote}"
        )
    return {
        "repository": "https://github.com/OpenMOSS/MOSS-TTS-Nano",
        "remote": remote,
        "commit": commit,
        "commit_date": commit_date,
    }


def model_revision(repo_id: str) -> str | None:
    try:
        from huggingface_hub import model_info

        return str(model_info(repo_id).sha)
    except Exception:
        return None


def validate_manifest(manifest_path: Path, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    if manifest.get("status") != "passed":
        raise ValueError(
            f"Manifest must have status=passed: {manifest_path}"
        )
    passages = manifest.get("passages")
    if not isinstance(passages, list) or not passages:
        raise ValueError(f"No passages in {manifest_path}")

    ids: set[str] = set()
    orders: list[int] = []
    for passage in passages:
        passage_id = str(passage.get("id") or "")
        text = str(passage.get("text") or "")
        order = int(passage.get("order") or 0)
        if not passage_id or not text or order <= 0:
            raise ValueError(f"Invalid passage row: {passage!r}")
        if passage_id in ids:
            raise ValueError(f"Duplicate passage id: {passage_id}")
        ids.add(passage_id)
        orders.append(order)
        expected_hash = str(passage.get("text_sha256") or "")
        actual_hash = sha256_text(text)
        if expected_hash and expected_hash != actual_hash:
            raise ValueError(
                f"Text hash mismatch for {passage_id}: "
                f"expected {expected_hash}, got {actual_hash}"
            )
    if orders != sorted(orders) or len(set(orders)) != len(orders):
        raise ValueError("Passage order values must be unique and ascending")
    return passages


def probe_wav(file_path: Path) -> dict[str, Any]:
    probe_text = command_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,sample_rate,channels:format=duration",
            "-of",
            "json",
            str(file_path),
        ]
    )
    if not probe_text:
        raise RuntimeError(f"ffprobe failed for {file_path}")
    probe = json.loads(probe_text)
    streams = probe.get("streams") or []
    if len(streams) != 1:
        raise RuntimeError(f"Expected one audio stream in {file_path}")
    stream = streams[0]
    duration_sec = float((probe.get("format") or {}).get("duration") or 0)
    if duration_sec <= 0:
        raise RuntimeError(f"Generated WAV has no duration: {file_path}")
    return {
        "codec_name": stream.get("codec_name"),
        "sample_rate_hz": int(stream.get("sample_rate") or 0),
        "channels": int(stream.get("channels") or 0),
        "duration_sec": round(duration_sec, 6),
    }


def configure_generation(runtime: Any, args: argparse.Namespace) -> None:
    defaults = runtime.manifest["generation_defaults"]
    defaults["max_new_frames"] = int(args.max_new_frames)
    defaults["do_sample"] = args.sample_mode != "greedy"
    defaults["sample_mode"] = args.sample_mode
    defaults["text_temperature"] = float(args.text_temperature)
    defaults["text_top_p"] = float(args.text_top_p)
    defaults["text_top_k"] = int(args.text_top_k)
    defaults["audio_temperature"] = float(args.audio_temperature)
    defaults["audio_top_p"] = float(args.audio_top_p)
    defaults["audio_top_k"] = int(args.audio_top_k)
    defaults["audio_repetition_penalty"] = float(
        args.audio_repetition_penalty
    )


def synthesize_passage(
    *,
    runtime: Any,
    passage: dict[str, Any],
    prompt_audio_codes: list[list[int]],
    output_path: Path,
    seed: int,
    voice_clone_max_text_tokens: int,
    concat_waveforms: Any,
    write_waveform_to_wav: Any,
) -> dict[str, Any]:
    passage_id = str(passage["id"])
    text = str(passage["text"])
    prepared = runtime.prepare_synthesis_text(
        text=text,
        voice="",
        enable_wetext=False,
        enable_normalize_tts_text=False,
    )
    prepared_text = str(prepared["text"])
    if prepared_text != text:
        raise RuntimeError(
            f"Official runtime changed manifest text for {passage_id}"
        )

    runtime.rng = np.random.default_rng(seed)
    text_chunks = runtime.split_voice_clone_text(
        prepared_text,
        max_tokens=int(voice_clone_max_text_tokens),
    )
    if not text_chunks:
        raise RuntimeError(f"No synthesis chunks for {passage_id}")

    sample_rate = int(runtime.codec_meta["codec_config"]["sample_rate"])
    channels = int(runtime.codec_meta["codec_config"]["channels"])
    waveforms: list[np.ndarray] = []
    generated_frames: list[list[int]] = []
    chunk_rows: list[dict[str, Any]] = []
    for chunk_index, chunk_text in enumerate(text_chunks):
        chunk_started = time.perf_counter()
        chunk_result = runtime.synthesize_single_chunk(
            text=chunk_text,
            prompt_audio_codes=prompt_audio_codes,
            streaming=True,
        )
        chunk_elapsed = time.perf_counter() - chunk_started
        chunk_waveform = np.asarray(chunk_result["waveform"], dtype=np.float32)
        chunk_frames = list(chunk_result["generated_frames"])
        if chunk_waveform.size == 0 or not chunk_frames:
            raise RuntimeError(
                f"Empty audio returned for {passage_id} chunk {chunk_index + 1}"
            )
        waveforms.append(chunk_waveform)
        generated_frames.extend(chunk_frames)
        chunk_rows.append(
            {
                "chunk_index": chunk_index + 1,
                "text": chunk_text,
                "text_sha256": sha256_text(chunk_text),
                "generated_frame_count": len(chunk_frames),
                "generation_time_sec": round(chunk_elapsed, 6),
                "reached_max_new_frames": (
                    len(chunk_frames) >= int(
                        runtime.manifest["generation_defaults"][
                            "max_new_frames"
                        ]
                    )
                ),
            }
        )
        if chunk_index < len(text_chunks) - 1:
            pause_seconds = runtime.estimate_voice_clone_inter_chunk_pause_seconds(
                chunk_text
            )
            pause_samples = max(0, int(round(sample_rate * pause_seconds)))
            if pause_samples:
                waveforms.append(
                    np.zeros((pause_samples, channels), dtype=np.float32)
                )

    waveform = concat_waveforms(waveforms)
    temporary_path = output_path.with_name(f".{output_path.name}.tmp.wav")
    write_waveform_to_wav(temporary_path, waveform, sample_rate)
    os.replace(temporary_path, output_path)
    wav = probe_wav(output_path)
    if wav["sample_rate_hz"] != sample_rate or wav["channels"] != channels:
        raise RuntimeError(
            f"Unexpected native format for {passage_id}: {wav}"
        )
    duration_sec = float(wav["duration_sec"])
    generation_time_sec = sum(
        float(row["generation_time_sec"]) for row in chunk_rows
    )
    word_count = int(passage.get("word_count") or len(text.split()))
    return {
        "passage_id": passage_id,
        "order": int(passage["order"]),
        "text": text,
        "text_sha256": sha256_text(text),
        "word_count": word_count,
        "output_path": str(output_path),
        "output_sha256": sha256_file(output_path),
        **wav,
        "generation_time_sec": round(generation_time_sec, 6),
        "generation_rtf": (
            round(generation_time_sec / duration_sec, 6)
            if duration_sec > 0
            else None
        ),
        "measured_wpm": (
            round(word_count * 60.0 / duration_sec, 3)
            if duration_sec > 0
            else None
        ),
        "seed": seed,
        "text_chunk_count": len(text_chunks),
        "generated_frame_count": len(generated_frames),
        "chunks": chunk_rows,
    }


def main() -> None:
    args = parse_args()
    manifest_path = Path(args.manifest).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    runtime_repo = Path(args.runtime_repo).expanduser().resolve()
    model_dir = Path(args.model_dir).expanduser().resolve()
    ref_audio_path = Path(args.ref_audio).expanduser().resolve()
    run_path = output_dir / "run.json"

    if args.cpu_threads <= 0:
        raise ValueError("--cpu-threads must be greater than zero")
    if args.max_new_frames <= 0:
        raise ValueError("--max-new-frames must be greater than zero")
    if args.voice_clone_max_text_tokens <= 0:
        raise ValueError("--voice-clone-max-text-tokens must be greater than zero")
    for required_path in (manifest_path, ref_audio_path):
        if not required_path.is_file():
            raise FileNotFoundError(required_path)
    if not runtime_repo.is_dir():
        raise FileNotFoundError(runtime_repo)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    passages = validate_manifest(manifest_path, manifest)
    repo = official_repo_provenance(runtime_repo)
    output_dir.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(runtime_repo))

    from onnx_tts_runtime import (
        OnnxTtsRuntime,
        _concat_waveforms,
        _write_waveform_to_wav,
    )
    import onnxruntime
    import torch
    import torchaudio

    started_at = datetime.now(timezone.utc)
    wall_started = time.perf_counter()
    report: dict[str, Any] = {
        "schema": "goldflow_moss_tts_nano_bakeoff_run_v1",
        "status": "running",
        "diagnostic_only": True,
        "production_artifacts_mutated": False,
        "started_at": started_at.isoformat(),
        "model_id": "moss_tts_nano_100m_onnx",
        "model_kind": "moss_tts_nano",
        "runtime_backend": "official_onnxruntime_cpu",
        "official_runtime": repo,
        "model_sources": {
            "tts_repo_id": TTS_MODEL_REPO_ID,
            "tts_revision": model_revision(TTS_MODEL_REPO_ID),
            "codec_repo_id": CODEC_MODEL_REPO_ID,
            "codec_revision": model_revision(CODEC_MODEL_REPO_ID),
            "local_model_dir": str(model_dir),
        },
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "reference_audio_path": str(ref_audio_path),
        "reference_audio_sha256": sha256_file(ref_audio_path),
        "reference_transcript": args.ref_transcript,
        "reference_transcript_sha256": sha256_text(args.ref_transcript),
        "reference_policy": "joel_owned_narrator_clone_220wpm",
        "voice_mode": "reference_clone",
        "reference_transcript_submitted_to_model": False,
        "input_text_policy": {
            "manifest_text_byte_exact": True,
            "wetext_processing_enabled": False,
            "robust_text_normalization_enabled": False,
        },
        "output_conditioning": {
            "native_speed_control_supported": False,
            "native_speed": 1.0,
            "post_tts_tempo_processing": False,
            "shared_loudness_normalization": False,
            "native_sample_rate_hz": 48000,
            "native_channels": 2,
        },
        "generation_settings": {
            "cpu_threads": args.cpu_threads,
            "execution_provider": "cpu",
            "sample_mode": args.sample_mode,
            "seed": args.seed,
            "max_new_frames": args.max_new_frames,
            "voice_clone_max_text_tokens": (
                args.voice_clone_max_text_tokens
            ),
            "realtime_streaming_decode": True,
            "text_temperature": args.text_temperature,
            "text_top_p": args.text_top_p,
            "text_top_k": args.text_top_k,
            "audio_temperature": args.audio_temperature,
            "audio_top_p": args.audio_top_p,
            "audio_top_k": args.audio_top_k,
            "audio_repetition_penalty": args.audio_repetition_penalty,
        },
        "environment": {
            "python": sys.version,
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "onnxruntime_version": onnxruntime.__version__,
            "onnxruntime_available_providers": (
                onnxruntime.get_available_providers()
            ),
            "numpy_version": np.__version__,
            "torch_version": torch.__version__,
            "torchaudio_version": torchaudio.__version__,
        },
        "passage_count_expected": len(passages),
        "results": [],
    }
    atomic_json_write(run_path, report)

    try:
        load_started = time.perf_counter()
        runtime = OnnxTtsRuntime(
            model_dir=model_dir,
            thread_count=args.cpu_threads,
            max_new_frames=args.max_new_frames,
            do_sample=args.sample_mode != "greedy",
            sample_mode=args.sample_mode,
            execution_provider="cpu",
            output_dir=output_dir,
        )
        configure_generation(runtime, args)
        report["model_load_time_sec"] = round(
            time.perf_counter() - load_started,
            6,
        )
        report["resolved_model_manifest_path"] = str(runtime.manifest_path)
        report["resolved_model_manifest_sha256"] = sha256_file(
            runtime.manifest_path
        )

        reference_started = time.perf_counter()
        prompt_audio_codes = runtime.resolve_prompt_audio_codes(
            voice=None,
            prompt_audio_path=ref_audio_path,
        )
        report["reference_encode_time_sec"] = round(
            time.perf_counter() - reference_started,
            6,
        )
        report["reference_audio_code_frame_count"] = len(prompt_audio_codes)
        atomic_json_write(run_path, report)

        for passage_index, passage in enumerate(passages):
            passage_seed = args.seed + passage_index
            output_path = output_dir / f"{passage['id']}.wav"
            passage_started = time.perf_counter()
            row = synthesize_passage(
                runtime=runtime,
                passage=passage,
                prompt_audio_codes=prompt_audio_codes,
                output_path=output_path,
                seed=passage_seed,
                voice_clone_max_text_tokens=(
                    args.voice_clone_max_text_tokens
                ),
                concat_waveforms=_concat_waveforms,
                write_waveform_to_wav=_write_waveform_to_wav,
            )
            row["wall_time_sec"] = round(
                time.perf_counter() - passage_started,
                6,
            )
            report["results"].append(row)
            atomic_json_write(run_path, report)
            print(
                f"[{passage_index + 1}/{len(passages)}] "
                f"{passage['id']} duration={row['duration_sec']:.3f}s "
                f"rtf={row['generation_rtf']:.3f}",
                file=sys.stderr,
                flush=True,
            )

        total_duration = sum(
            float(row["duration_sec"]) for row in report["results"]
        )
        total_generation = sum(
            float(row["generation_time_sec"]) for row in report["results"]
        )
        total_words = sum(
            int(row["word_count"]) for row in report["results"]
        )
        report.update(
            {
                "status": "passed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "passage_count": len(report["results"]),
                "total_word_count": total_words,
                "total_audio_duration_sec": round(total_duration, 6),
                "total_generation_time_sec": round(total_generation, 6),
                "total_wall_time_sec": round(
                    time.perf_counter() - wall_started,
                    6,
                ),
                "aggregate_generation_rtf": (
                    round(total_generation / total_duration, 6)
                    if total_duration > 0
                    else None
                ),
                "aggregate_measured_wpm": (
                    round(total_words * 60.0 / total_duration, 3)
                    if total_duration > 0
                    else None
                ),
            }
        )
        atomic_json_write(run_path, report)
        print(json.dumps(report, indent=2, ensure_ascii=False))
    except Exception as exc:
        report.update(
            {
                "status": "failed",
                "failed_at": datetime.now(timezone.utc).isoformat(),
                "error": {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "traceback": traceback.format_exc(),
                },
                "passage_count": len(report["results"]),
                "total_wall_time_sec": round(
                    time.perf_counter() - wall_started,
                    6,
                ),
            }
        )
        atomic_json_write(run_path, report)
        raise


if __name__ == "__main__":
    main()
