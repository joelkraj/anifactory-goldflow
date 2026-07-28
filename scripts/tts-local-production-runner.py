#!/usr/bin/env python3

"""Pinned, content-addressed MLX narration synthesis worker.

The model is loaded once per invocation. Every unit is written atomically as
untouched 24 kHz mono WAV audio. No trimming, fading, de-clicking, loudness
normalization, resampling, or post-TTS tempo processing occurs here.
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
from huggingface_hub import snapshot_download
from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model


KOKORO = {
    "provider": "kokoro_local",
    "model_id": "mlx-community/Kokoro-82M-bf16",
    "source": "mlx-community/Kokoro-82M-bf16",
    "revision": "a71e4d38b236d968966a2002c4c895dbd12b1c3c",
    "weights": "kokoro-v1_0.safetensors",
    "weights_sha256": "4e9ecdf03b8b6cf906070390237feda473dc13327cb8d56a43deaa374c02acd8",
    "config_sha256": "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f",
    "language_code": "a",
    "native_speed": 1.2,
}
KOKORO_VOICES = {
    "am_puck": "9a8c2e56413bd2063f814cb4c3885fc425876157369117c3f8258d03c8a9ad89",
}
PUCK_VOICE_ID = "am_puck"
PUCK_VOICE_SHA256 = KOKORO_VOICES[PUCK_VOICE_ID]
QWEN = {
    "provider": "qwen_local",
    "model_id": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
    "source": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
    "revision": "e7dd0585652209fa0d7783659aad4e8a324de11c",
    "weights": "model.safetensors",
    "weights_sha256": "b965c581ccf6aa852a4124feeb7a8a111542ee7b213139368b4cc7ba7fd4728b",
    "config_sha256": "b14fba6bfd391968876248b843b095696b0188187a3d774a3bddc32544d15627",
    "generation_config_sha256": "f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa",
    "speech_tokenizer_weights_sha256": "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
    "speech_tokenizer_config_sha256": "ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167",
}
QWEN_PUCK_REFERENCE = {
    "audio_path": (
        "/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/"
        "am_puck/am_puck_qwen_fallback_reference_v1.wav"
    ),
    "audio_sha256": (
        "934de29bed0d3da6b8c8fb2a6c611202a967498422702f8c30f85b4bb10019d0"
    ),
    "text": (
        "Because a deed is not a toy. A deed is the only word in any language "
        "that means this is mine and the world has to agree. The breathing got "
        "closer. Out of the black came a shape too big to be a man and too "
        "graceful to be a beast. A broken crown curved between its horns."
    ),
    "text_sha256": (
        "2630f1d234dd38762cf538ee7b817026711f2c9642a26dd3678242647e5a720c"
    ),
    "metadata_path": (
        "/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/"
        "am_puck/am_puck_qwen_fallback_reference_v1.json"
    ),
    "metadata_sha256": (
        "e51394242bdac5e604e629ac1a575673fb4f857a15dd32317aeeee59bddb9955"
    ),
    "source_provider": KOKORO["provider"],
    "source_model_id": KOKORO["model_id"],
    "source_model_revision": KOKORO["revision"],
    "source_unit_id": "stp_voice_seg_10_5_2630f1d234dd",
}
MLX_AUDIO_VERSION = "0.4.6"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--route", choices=("kokoro", "qwen"), required=True)
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--qwen-reference-audio")
    parser.add_argument("--qwen-reference-text")
    parser.add_argument(
        "--local-files-only",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--resume", action=argparse.BooleanOptionalAction, default=True)
    return parser.parse_args()


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def canonical_sha256(value: Any) -> str:
    return sha256_text(
        json.dumps(
            value,
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )


def atomic_json(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_name(f".{file_path.name}.tmp-{os.getpid()}")
    temporary.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, file_path)


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def validate_file(file_path: Path, expected_sha256: str) -> None:
    if not file_path.is_file():
        raise FileNotFoundError(f"Missing pinned TTS asset: {file_path}")
    actual = sha256_file(file_path)
    if actual != expected_sha256:
        raise ValueError(
            f"Pinned TTS asset hash mismatch for {file_path}: "
            f"expected {expected_sha256}, got {actual}"
        )


def resolve_snapshot(
    route: str,
    local_files_only: bool,
    kokoro_voice_id: str | None,
) -> tuple[dict[str, Any], Path]:
    pin = KOKORO if route == "kokoro" else QWEN
    snapshot = Path(
        snapshot_download(
            repo_id=pin["source"],
            revision=pin["revision"],
            local_files_only=local_files_only,
        )
    )
    validate_file(snapshot / pin["weights"], pin["weights_sha256"])
    validate_file(snapshot / "config.json", pin["config_sha256"])
    if route == "kokoro":
        if kokoro_voice_id not in KOKORO_VOICES:
            raise ValueError(
                f"Unapproved Kokoro voice: {kokoro_voice_id!r}; "
                f"expected one of {sorted(KOKORO_VOICES)}"
            )
        validate_file(
            snapshot / "voices" / f"{kokoro_voice_id}.safetensors",
            KOKORO_VOICES[kokoro_voice_id],
        )
    else:
        validate_file(
            snapshot / "generation_config.json",
            pin["generation_config_sha256"],
        )
        validate_file(
            snapshot / "speech_tokenizer" / "model.safetensors",
            pin["speech_tokenizer_weights_sha256"],
        )
        validate_file(
            snapshot / "speech_tokenizer" / "config.json",
            pin["speech_tokenizer_config_sha256"],
        )
    return pin, snapshot


def validate_jobs(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, dict) or value.get("schema") != "goldflow_narration_tts_jobs_v1":
        raise ValueError("Invalid narration TTS jobs schema")
    rows = value.get("jobs")
    if not isinstance(rows, list) or not rows:
        raise ValueError("Narration TTS jobs are empty")
    seen: set[str] = set()
    output: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"Job {index} is not an object")
        unit_id = str(row.get("unit_id") or "").strip()
        text = str(row.get("spoken_text") or "")
        if not unit_id or unit_id in seen:
            raise ValueError(f"Missing or duplicate unit_id at job {index}: {unit_id!r}")
        if not text.strip():
            raise ValueError(f"Empty spoken text for {unit_id}")
        if row.get("spoken_text_sha256") != sha256_text(text):
            raise ValueError(f"Spoken-text hash mismatch for {unit_id}")
        seed = int(row.get("seed"))
        attempt = int(row.get("attempt"))
        if seed < 0 or attempt < 1:
            raise ValueError(f"Invalid seed/attempt for {unit_id}")
        seen.add(unit_id)
        output.append(row)
    return output


def synthesis_identity(
    route: str,
    pin: dict[str, Any],
    job: dict[str, Any],
    reference_audio: Path | None,
    reference_text: str | None,
    kokoro_voice_id: str | None,
) -> dict[str, Any]:
    value = {
        "schema": "goldflow_local_tts_synthesis_identity_v1",
        "provider": pin["provider"],
        "model_id": pin["model_id"],
        "model_source": pin["source"],
        "model_revision": pin["revision"],
        "model_weights_sha256": pin["weights_sha256"],
        "model_config_sha256": pin["config_sha256"],
        "mlx_audio_version": MLX_AUDIO_VERSION,
        "unit_id": job["unit_id"],
        "spoken_text": job["spoken_text"],
        "spoken_text_sha256": job["spoken_text_sha256"],
        "seed": int(job["seed"]),
        "attempt": int(job["attempt"]),
    }
    if route == "kokoro":
        if kokoro_voice_id not in KOKORO_VOICES:
            raise ValueError(f"Unapproved Kokoro voice: {kokoro_voice_id!r}")
        value.update(
            {
                "voice": kokoro_voice_id,
                "voice_sha256": KOKORO_VOICES[kokoro_voice_id],
                "language_code": pin["language_code"],
                "native_speed": pin["native_speed"],
            }
        )
    else:
        if reference_audio is None or reference_text is None:
            raise ValueError("Qwen fallback requires reference audio and exact text")
        value.update(
            {
                "voice": PUCK_VOICE_ID,
                "voice_sha256": PUCK_VOICE_SHA256,
                "voice_clone_contract": "qwen_icl_clone_of_selected_puck_reference",
                "generation_config_sha256": pin["generation_config_sha256"],
                "speech_tokenizer_weights_sha256": pin[
                    "speech_tokenizer_weights_sha256"
                ],
                "speech_tokenizer_config_sha256": pin[
                    "speech_tokenizer_config_sha256"
                ],
                "reference_audio_path": str(reference_audio),
                "reference_audio_sha256": sha256_file(reference_audio),
                "reference_text": reference_text,
                "reference_text_sha256": sha256_text(reference_text),
                "reference_voice_id": PUCK_VOICE_ID,
                "reference_voice_sha256": PUCK_VOICE_SHA256,
                "reference_source_provider": QWEN_PUCK_REFERENCE[
                    "source_provider"
                ],
                "reference_source_model_id": QWEN_PUCK_REFERENCE[
                    "source_model_id"
                ],
                "reference_source_model_revision": QWEN_PUCK_REFERENCE[
                    "source_model_revision"
                ],
                "reference_source_unit_id": QWEN_PUCK_REFERENCE[
                    "source_unit_id"
                ],
                "reference_metadata_path": QWEN_PUCK_REFERENCE[
                    "metadata_path"
                ],
                "reference_metadata_sha256": QWEN_PUCK_REFERENCE[
                    "metadata_sha256"
                ],
                "delivery_control": "base_icl_reference_audio_only",
                "temperature": 0.6,
                "top_p": 0.8,
                "top_k": 50,
                "repetition_penalty": 1.5,
                "max_tokens": 1200,
            }
        )
    return value


def generate_audio(
    model: Any,
    route: str,
    job: dict[str, Any],
    reference_audio: Path | None,
    reference_text: str | None,
    kokoro_voice_id: str | None,
) -> tuple[np.ndarray, int, list[Any]]:
    mx.random.seed(int(job["seed"]))
    if route == "kokoro":
        if kokoro_voice_id not in KOKORO_VOICES:
            raise ValueError(f"Unapproved Kokoro voice: {kokoro_voice_id!r}")
        generated = list(
            model.generate(
                text=job["spoken_text"],
                voice=kokoro_voice_id,
                speed=KOKORO["native_speed"],
                lang_code=KOKORO["language_code"],
            )
        )
    else:
        generate_kwargs = {
            "text": job["spoken_text"],
            "ref_audio": str(reference_audio),
            "ref_text": reference_text,
            "temperature": 0.6,
            "top_p": 0.8,
            "top_k": 50,
            "repetition_penalty": 1.5,
            "max_tokens": 1200,
            "verbose": False,
        }
        generated = list(
            model.generate(**generate_kwargs)
        )
    if not generated:
        raise RuntimeError(f"{route}/{job['unit_id']} returned no audio")
    sample_rates = {int(result.sample_rate) for result in generated}
    if len(sample_rates) != 1:
        raise RuntimeError(
            f"{route}/{job['unit_id']} returned mixed sample rates: "
            f"{sorted(sample_rates)}"
        )
    chunks = [result.audio for result in generated]
    audio = chunks[0] if len(chunks) == 1 else mx.concatenate(chunks, axis=0)
    mx.eval(audio)
    output = np.asarray(audio, dtype=np.float32).reshape(-1)
    if output.size == 0 or not np.isfinite(output).all():
        raise RuntimeError(f"{route}/{job['unit_id']} returned invalid audio")
    return output, sample_rates.pop(), generated


def main() -> None:
    args = parse_args()
    if package_version("mlx-audio") != MLX_AUDIO_VERSION:
        raise RuntimeError(
            f"Expected mlx-audio {MLX_AUDIO_VERSION}; "
            f"found {package_version('mlx-audio')!r}"
        )
    jobs_path = Path(args.jobs).resolve()
    output_dir = Path(args.output_dir).resolve()
    report_path = Path(args.report).resolve()
    jobs_manifest = json.loads(jobs_path.read_text(encoding="utf-8"))
    jobs = validate_jobs(jobs_manifest)
    kokoro_voice_id = (
        str(jobs_manifest.get("kokoro_voice_id") or "").strip()
        if args.route == "kokoro"
        else None
    )
    if args.route == "kokoro":
        if kokoro_voice_id not in KOKORO_VOICES:
            raise ValueError(f"Unapproved Kokoro voice: {kokoro_voice_id!r}")
        if (
            jobs_manifest.get("kokoro_voice_sha256")
            != KOKORO_VOICES[kokoro_voice_id]
        ):
            raise ValueError("Kokoro voice hash lock mismatch in jobs manifest")
    pin, snapshot = resolve_snapshot(
        args.route,
        args.local_files_only,
        kokoro_voice_id,
    )
    reference_audio = (
        Path(args.qwen_reference_audio).resolve()
        if args.qwen_reference_audio
        else None
    )
    reference_text = args.qwen_reference_text
    if args.route == "qwen":
        if reference_audio is None or not reference_audio.is_file():
            raise FileNotFoundError("Missing pinned Qwen fallback reference audio")
        expected_reference_sha256 = jobs_manifest.get("qwen_reference_audio_sha256")
        if (
            not expected_reference_sha256
            or sha256_file(reference_audio) != expected_reference_sha256
        ):
            raise ValueError("Qwen fallback reference audio hash mismatch")
        if not reference_text or reference_text != jobs_manifest.get("qwen_reference_text"):
            raise ValueError("Qwen fallback reference text mismatch")
        if (
            str(reference_audio) != QWEN_PUCK_REFERENCE["audio_path"]
            or sha256_file(reference_audio) != QWEN_PUCK_REFERENCE["audio_sha256"]
            or reference_text != QWEN_PUCK_REFERENCE["text"]
            or sha256_text(reference_text) != QWEN_PUCK_REFERENCE["text_sha256"]
        ):
            raise ValueError("Qwen fallback reference is not the pinned Puck asset")
        reference_metadata = Path(QWEN_PUCK_REFERENCE["metadata_path"])
        validate_file(
            reference_metadata,
            QWEN_PUCK_REFERENCE["metadata_sha256"],
        )
        if (
            jobs_manifest.get("qwen_reference_voice_id") != PUCK_VOICE_ID
            or jobs_manifest.get("qwen_reference_voice_sha256")
            != PUCK_VOICE_SHA256
            or jobs_manifest.get("qwen_voice_continuity_contract")
            != "clone_primary_puck_identity"
        ):
            raise ValueError("Qwen fallback must clone the selected Puck voice")

    output_dir.mkdir(parents=True, exist_ok=True)
    load_started = time.perf_counter()
    # MLX Audio derives the model family from the repo name when passed a
    # string. A Hugging Face commit-directory Path has an opaque basename and
    # can therefore be misclassified even though its config and weights are
    # valid. Validate the resolved snapshot above, then load the exact pinned
    # repo/revision using the same proven route as the audited bakeoff runner.
    model = load_model(
        pin["source"],
        revision=pin["revision"],
        local_files_only=args.local_files_only,
    )
    load_seconds = time.perf_counter() - load_started
    results: list[dict[str, Any]] = []
    for job in jobs:
        started = time.perf_counter()
        identity: dict[str, Any] | None = None
        identity_sha256: str | None = None
        try:
            identity = synthesis_identity(
                args.route,
                pin,
                job,
                reference_audio,
                reference_text,
                kokoro_voice_id,
            )
            identity_sha256 = canonical_sha256(identity)
            safe_unit_id = re.sub(
                r"[^A-Za-z0-9._-]+",
                "-",
                job["unit_id"],
            ).strip("-")
            if not safe_unit_id:
                safe_unit_id = f"unit-{sha256_text(job['unit_id'])[:12]}"
            stem = f"{safe_unit_id[:96]}-{identity_sha256}"
            output_path = output_dir / f"{stem}.wav"
            sidecar_path = output_dir / f"{stem}.json"
            if args.resume and output_path.is_file() and sidecar_path.is_file():
                try:
                    previous = json.loads(
                        sidecar_path.read_text(encoding="utf-8")
                    )
                except (json.JSONDecodeError, OSError):
                    previous = None
                if (
                    previous
                    and previous.get("synthesis_identity_sha256")
                    == identity_sha256
                    and previous.get("output_sha256")
                    == sha256_file(output_path)
                ):
                    results.append(
                        {**previous, "status": "reused_exact_hash"}
                    )
                    continue

            audio, sample_rate, chunks = generate_audio(
                model,
                args.route,
                job,
                reference_audio,
                reference_text,
                kokoro_voice_id,
            )
            if sample_rate != 24000:
                raise RuntimeError(
                    f"Refusing {job['unit_id']}: "
                    f"expected native 24000 Hz, got {sample_rate}"
                )
            temporary_wav = output_path.with_name(
                f".{output_path.stem}.tmp-{os.getpid()}.wav"
            )
            audio_write(str(temporary_wav), audio, sample_rate, format="wav")
            os.replace(temporary_wav, output_path)
            elapsed = time.perf_counter() - started
            duration_sec = audio.size / sample_rate
            row = {
                "unit_id": job["unit_id"],
                "provider": pin["provider"],
                "model_id": pin["model_id"],
                "voice_id": (
                    kokoro_voice_id if args.route == "kokoro" else PUCK_VOICE_ID
                ),
                "status": "generated",
                "attempt": int(job["attempt"]),
                "seed": int(job["seed"]),
                "spoken_text": job["spoken_text"],
                "spoken_text_sha256": job["spoken_text_sha256"],
                "output_path": str(output_path),
                "output_sha256": sha256_file(output_path),
                "sample_rate_hz": sample_rate,
                "sample_count": int(audio.size),
                "duration_sec": round(duration_sec, 6),
                "generation_time_sec": round(elapsed, 6),
                "generation_rtf": round(elapsed / duration_sec, 6),
                "result_chunk_count": len(chunks),
                "synthesis_identity": identity,
                "synthesis_identity_sha256": identity_sha256,
                "sidecar_path": str(sidecar_path),
            }
            atomic_json(sidecar_path, row)
            results.append(row)
        except Exception as error:  # Unit-scoped synthesis failures are retryable.
            results.append(
                {
                    "unit_id": job["unit_id"],
                    "provider": pin["provider"],
                    "model_id": pin["model_id"],
                    "voice_id": (
                        kokoro_voice_id if args.route == "kokoro" else PUCK_VOICE_ID
                    ),
                    "status": "failed",
                    "attempt": int(job["attempt"]),
                    "seed": int(job["seed"]),
                    "spoken_text_sha256": job["spoken_text_sha256"],
                    "synthesis_identity": identity,
                    "synthesis_identity_sha256": identity_sha256,
                    "generation_time_sec": round(
                        time.perf_counter() - started,
                        6,
                    ),
                    "error_type": type(error).__name__,
                    "error": str(error),
                }
            )

    failure_count = sum(row["status"] == "failed" for row in results)
    report_status = "passed" if failure_count == 0 else "completed_with_job_failures"
    report = {
        "schema": "goldflow_local_tts_production_run_v1",
        "status": report_status,
        "route": args.route,
        "provider": pin["provider"],
        "model_id": pin["model_id"],
        "model_source": pin["source"],
        "model_revision": pin["revision"],
        "voice_id": (
            kokoro_voice_id if args.route == "kokoro" else PUCK_VOICE_ID
        ),
        "voice_sha256": (
            KOKORO_VOICES[kokoro_voice_id]
            if args.route == "kokoro"
            else PUCK_VOICE_SHA256
        ),
        "voice_clone_contract": (
            None
            if args.route == "kokoro"
            else "qwen_icl_clone_of_selected_puck_reference"
        ),
        "reference_audio_path": (
            str(reference_audio) if args.route == "qwen" else None
        ),
        "reference_audio_sha256": (
            sha256_file(reference_audio)
            if args.route == "qwen" and reference_audio is not None
            else None
        ),
        "reference_text_sha256": (
            sha256_text(reference_text)
            if args.route == "qwen" and reference_text is not None
            else None
        ),
        "reference_voice_id": (
            PUCK_VOICE_ID if args.route == "qwen" else None
        ),
        "reference_voice_sha256": (
            PUCK_VOICE_SHA256 if args.route == "qwen" else None
        ),
        "reference_metadata_sha256": (
            QWEN_PUCK_REFERENCE["metadata_sha256"]
            if args.route == "qwen"
            else None
        ),
        "model_path": str(snapshot),
        "model_weights_sha256": pin["weights_sha256"],
        "model_config_sha256": pin["config_sha256"],
        "generation_config_sha256": (
            pin.get("generation_config_sha256")
            if args.route == "qwen"
            else None
        ),
        "speech_tokenizer_weights_sha256": (
            pin.get("speech_tokenizer_weights_sha256")
            if args.route == "qwen"
            else None
        ),
        "speech_tokenizer_config_sha256": (
            pin.get("speech_tokenizer_config_sha256")
            if args.route == "qwen"
            else None
        ),
        "jobs_path": str(jobs_path),
        "jobs_sha256": sha256_file(jobs_path),
        "model_load_time_sec": round(load_seconds, 6),
        "effective_concurrency": 1,
        "model_load_count": 1,
        "model_load_policy": "once_per_serial_invocation",
        "delivery_control": (
            "kokoro_voice_speed_and_authored_prosody"
            if args.route == "kokoro"
            else "base_icl_reference_audio_only"
        ),
        "ignored_qwen_instruct_job_count": (
            sum(bool(str(job.get("qwen_instruct") or "").strip()) for job in jobs)
            if args.route == "qwen"
            else 0
        ),
        "runtime": {
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            "mlx_audio_version": package_version("mlx-audio"),
            "mlx_version": package_version("mlx"),
            "huggingface_hub_version": package_version("huggingface-hub"),
        },
        "job_count": len(jobs),
        "result_count": len(results),
        "successful_result_count": len(results) - failure_count,
        "failed_result_count": failure_count,
        "results": results,
    }
    atomic_json(report_path, report)
    print(
        json.dumps(
            {
                "status": report_status,
                "route": args.route,
                "result_count": len(results),
                "failed_result_count": failure_count,
                "report": str(report_path),
            }
        )
    )


if __name__ == "__main__":
    main()
