#!/usr/bin/env python3

"""Run a fixed Pocket TTS preset across a Goldflow bake-off manifest.

This diagnostic runner keeps Pocket TTS model-native behavior intact. It
loads one official language model and one official preset voice embedding,
then writes one untouched WAV per passage. It does not normalize, trim,
resample, crossfade, de-click, or apply post-TTS tempo processing.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import re
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import scipy.io.wavfile
import torch


MODEL_NAME = "Pocket TTS"
MODEL_SOURCE = "kyutai/pocket-tts"
MODEL_KIND = "pocket_tts"
PACKAGE_SOURCE = "https://github.com/kyutai-labs/pocket-tts"
PACKAGE_LICENSE = "MIT"
MODEL_LICENSE = "CC-BY-4.0"
VOICE_REPOSITORY = "kyutai/tts-voices"
VOICE_ZERO_LICENSE = "CC0-1.0"
VOICE_ZERO_PRESETS = {
    "bill_boerst",
    "caro_davy",
    "peter_yearsley",
    "stuart_bell",
}
PASSAGE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run an official Pocket TTS preset across a TTS bake-off manifest "
            "without shared audio post-processing."
        )
    )
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--voice",
        required=True,
        help="Official Pocket TTS preset voice, for example stuart_bell.",
    )
    parser.add_argument(
        "--language",
        default="english_2026-04",
        help=(
            "Official Pocket TTS language/model config "
            "(default: english_2026-04)."
        ),
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.5,
        help=(
            "Model-native sampling temperature (default: 0.5, the official "
            "higher-quality example setting)."
        ),
    )
    parser.add_argument(
        "--lsd-decode-steps",
        type=int,
        default=5,
        help=(
            "Model-native Lagrangian Self Distillation decode steps "
            "(default: 5, the official higher-quality example setting)."
        ),
    )
    parser.add_argument(
        "--noise-clamp",
        type=float,
        default=None,
        help="Optional model-native noise clamp (default: unset).",
    )
    parser.add_argument(
        "--eos-threshold",
        type=float,
        default=-4.0,
        help="Model-native end-of-sequence threshold (default: -4.0).",
    )
    parser.add_argument(
        "--frames-after-eos",
        type=int,
        default=None,
        help=(
            "Optional number of 80 ms model frames after EOS. The default "
            "uses Pocket TTS automatic passage-length handling."
        ),
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=50,
        help=(
            "Official sentence-aware internal text chunk limit "
            "(default: 50, the Pocket TTS 2.1.0 production default)."
        ),
    )
    parser.add_argument("--seed", type=int, default=20260726)
    parser.add_argument(
        "--resume",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Reuse exact-hash completed passage WAVs and sidecars (default: true).",
    )
    parser.add_argument(
        "--force-passage-ids",
        default="",
        help="Comma-separated passage IDs to regenerate.",
    )
    parser.add_argument(
        "--force-seed-offset",
        type=int,
        default=100_000,
        help="Seed offset applied only to forced passage retries.",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.temperature <= 0:
        raise ValueError("--temperature must be greater than zero")
    if args.lsd_decode_steps <= 0:
        raise ValueError("--lsd-decode-steps must be greater than zero")
    if args.max_tokens <= 0:
        raise ValueError("--max-tokens must be greater than zero")
    if args.frames_after_eos is not None and args.frames_after_eos < 0:
        raise ValueError("--frames-after-eos must be non-negative")


def load_passages(
    manifest_path: Path,
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    raw_passages = manifest.get("passages") or []
    if not raw_passages:
        raise ValueError(f"No passages in {manifest_path}")

    seen_ids: set[str] = set()
    passages: list[dict[str, str]] = []
    for index, passage in enumerate(raw_passages):
        if not isinstance(passage, dict):
            raise ValueError(f"Passage {index} must be an object")
        passage_id = passage.get("id")
        text = passage.get("text")
        if not isinstance(passage_id, str) or not PASSAGE_ID_PATTERN.fullmatch(
            passage_id
        ):
            raise ValueError(
                f"Passage {index} has an unsafe or empty id: {passage_id!r}"
            )
        if passage_id in seen_ids:
            raise ValueError(f"Duplicate passage id: {passage_id}")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"Passage {passage_id} has empty text")
        seen_ids.add(passage_id)
        passages.append({"id": passage_id, "text": text})
    return manifest, passages


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


def identity_without_seed(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {key: item for key, item in value.items() if key != "seed"}


def resolve_model_file(tts_model: Any) -> tuple[str, Path]:
    from pocket_tts.utils.utils import download_if_necessary

    config = tts_model.config
    if tts_model.has_voice_cloning:
        source = config.weights_path
    else:
        source = config.weights_path_without_voice_cloning
    if not source:
        raise RuntimeError("Loaded Pocket TTS config did not identify model weights")
    return source, download_if_necessary(source).resolve()


def resolve_tokenizer_file(tts_model: Any) -> tuple[str, Path]:
    from pocket_tts.utils.utils import download_if_necessary

    source = tts_model.config.flow_lm.lookup_table.tokenizer_path
    return source, download_if_necessary(source).resolve()


def resolve_voice_files(
    tts_model: Any, language: str, voice: str
) -> tuple[str, Path, str | None]:
    from pocket_tts.utils.utils import (
        _ORIGINS_OF_PREDEFINED_VOICES,
        download_if_necessary,
        get_predefined_voice,
    )

    if voice not in _ORIGINS_OF_PREDEFINED_VOICES:
        raise ValueError(
            f"{voice!r} is not an official Pocket TTS preset voice"
        )
    embedding_source = get_predefined_voice(language=language, name=voice)
    embedding_path = download_if_necessary(embedding_source).resolve()
    return embedding_source, embedding_path, _ORIGINS_OF_PREDEFINED_VOICES[voice]


def internal_chunks(tts_model: Any, text: str, max_tokens: int) -> list[str]:
    from pocket_tts.models.tts_model import split_into_best_sentences

    return split_into_best_sentences(
        tts_model.flow_lm.conditioner.tokenizer,
        text,
        max_tokens,
        tts_model.pad_with_spaces_for_short_inputs,
        remove_semicolons=tts_model.remove_semicolons,
    )


def main() -> None:
    args = parse_args()
    validate_args(args)
    manifest_path = Path(args.manifest).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    _manifest, passages = load_passages(manifest_path)

    from pocket_tts import TTSModel

    output_dir.mkdir(parents=True, exist_ok=True)
    load_started = time.perf_counter()
    tts_model = TTSModel.load_model(
        language=args.language,
        temp=args.temperature,
        lsd_decode_steps=args.lsd_decode_steps,
        noise_clamp=args.noise_clamp,
        eos_threshold=args.eos_threshold,
        quantize=False,
    )
    tts_model.to("cpu")
    load_seconds = time.perf_counter() - load_started

    model_source, model_path = resolve_model_file(tts_model)
    tokenizer_source, tokenizer_path = resolve_tokenizer_file(tts_model)
    (
        voice_embedding_source,
        voice_embedding_path,
        voice_prompt_source,
    ) = resolve_voice_files(tts_model, args.language, args.voice)
    voice_state = tts_model.get_state_for_audio_prompt(args.voice)

    forced_passage_ids = {
        value.strip()
        for value in args.force_passage_ids.split(",")
        if value.strip()
    }
    unknown_forced_ids = forced_passage_ids.difference(
        passage["id"] for passage in passages
    )
    if unknown_forced_ids:
        raise ValueError(
            "Unknown --force-passage-ids: "
            + ", ".join(sorted(unknown_forced_ids))
        )

    rows: list[dict[str, Any]] = []
    for passage_index, passage in enumerate(passages):
        passage_id = passage["id"]
        text = passage["text"]
        passage_seed = args.seed + passage_index + (
            args.force_seed_offset if passage_id in forced_passage_ids else 0
        )
        chunks = internal_chunks(tts_model, text, args.max_tokens)
        output_path = output_dir / f"{passage_id}.wav"
        result_sidecar_path = output_dir / f"{passage_id}.result.json"
        synthesis_identity = {
            "model_name": MODEL_NAME,
            "model_source": MODEL_SOURCE,
            "model_weights_sha256": sha256_file(model_path),
            "voice": args.voice,
            "voice_embedding_sha256": sha256_file(voice_embedding_path),
            "text": text,
            "language": args.language,
            "temperature": args.temperature,
            "lsd_decode_steps": args.lsd_decode_steps,
            "noise_clamp": args.noise_clamp,
            "eos_threshold": args.eos_threshold,
            "frames_after_eos": args.frames_after_eos,
            "max_tokens": args.max_tokens,
            "wav_encoding": "PCM_S16LE",
            "seed": passage_seed,
        }
        synthesis_identity_sha256 = sha256_text(
            json.dumps(
                synthesis_identity,
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        if (
            args.resume
            and passage_id not in forced_passage_ids
            and output_path.is_file()
            and result_sidecar_path.is_file()
        ):
            previous = json.loads(
                result_sidecar_path.read_text(encoding="utf-8")
            )
            if (
                identity_without_seed(previous.get("synthesis_identity"))
                == identity_without_seed(synthesis_identity)
                and previous.get("output_sha256") == sha256_file(output_path)
            ):
                rows.append(
                    {
                        **previous,
                        "status": "reused_exact_hash",
                        "result_sidecar_path": str(result_sidecar_path),
                    }
                )
                continue

        torch.manual_seed(passage_seed)
        np.random.seed(passage_seed)
        started = time.perf_counter()
        audio_tensor = tts_model.generate_audio(
            voice_state,
            text,
            max_tokens=args.max_tokens,
            frames_after_eos=args.frames_after_eos,
            copy_state=True,
        )
        elapsed = time.perf_counter() - started
        audio = audio_tensor.detach().cpu().numpy()
        if audio.ndim != 1 or audio.size == 0:
            raise RuntimeError(
                f"{args.model_id}/{passage_id} returned invalid audio shape "
                f"{audio.shape}"
            )
        if not np.isfinite(audio).all():
            raise RuntimeError(
                f"{args.model_id}/{passage_id} returned non-finite audio"
            )

        sample_rate = int(tts_model.sample_rate)
        duration_sec = len(audio) / sample_rate
        pcm16 = np.round(
            np.clip(audio, -1.0, 1.0) * np.iinfo(np.int16).max
        ).astype(np.int16)
        scipy.io.wavfile.write(output_path, sample_rate, pcm16)
        row = {
            "passage_id": passage_id,
            "text": text,
            "status": "generated",
            "output_path": str(output_path),
            "output_sha256": sha256_file(output_path),
            "sample_rate_hz": sample_rate,
            "sample_count": len(audio),
            "duration_sec": round(duration_sec, 6),
            "generation_time_sec": round(elapsed, 6),
            "generation_rtf": round(elapsed / duration_sec, 6)
            if duration_sec > 0
            else None,
            "result_chunk_count": len(chunks),
            "result_chunks": chunks,
            "peak_absolute_sample": round(float(np.max(np.abs(audio))), 9),
            "seed": passage_seed,
            "synthesis_identity": synthesis_identity,
            "synthesis_identity_sha256": synthesis_identity_sha256,
            "result_sidecar_path": str(result_sidecar_path),
        }
        json_write(result_sidecar_path, row)
        rows.append(row)

    model_sha256 = sha256_file(model_path)
    voice_embedding_sha256 = sha256_file(voice_embedding_path)
    report = {
        "schema": "goldflow_local_tts_bakeoff_run_v1",
        "status": "passed",
        "model_id": args.model_id,
        "model_kind": MODEL_KIND,
        "model_path": str(model_path),
        "model_name": MODEL_NAME,
        "model_source": MODEL_SOURCE,
        "model_license": MODEL_LICENSE,
        "model_weights_source": model_source,
        "model_weights_sha256": model_sha256,
        "tokenizer_source": tokenizer_source,
        "tokenizer_path": str(tokenizer_path),
        "tokenizer_sha256": sha256_file(tokenizer_path),
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "voice_mode": "preset",
        "preset_voice": args.voice,
        "preset_voice_style_path": str(voice_embedding_path),
        "preset_voice_style_sha256": voice_embedding_sha256,
        "preset_voice_embedding_source": voice_embedding_source,
        "preset_voice_prompt_source": voice_prompt_source,
        "preset_voice_repository": VOICE_REPOSITORY,
        "preset_voice_license": (
            VOICE_ZERO_LICENSE
            if args.voice in VOICE_ZERO_PRESETS
            else "See kyutai/tts-voices model card"
        ),
        "voice_instruction": None,
        "language_code": "en",
        "reference_audio_path": None,
        "reference_audio_sha256": None,
        "reference_text": None,
        "model_load_time_sec": round(load_seconds, 6),
        "runtime": {
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            "pocket_tts_version": package_version("pocket-tts"),
            "torch_version": package_version("torch"),
            "scipy_version": package_version("scipy"),
            "package_source": PACKAGE_SOURCE,
            "package_license": PACKAGE_LICENSE,
        },
        "model_native_generation_parameters": {
            "voice": args.voice,
            "language": args.language,
            "temperature": args.temperature,
            "lsd_decode_steps": args.lsd_decode_steps,
            "noise_clamp": args.noise_clamp,
            "eos_threshold": args.eos_threshold,
            "frames_after_eos": args.frames_after_eos,
            "max_tokens_per_internal_chunk": args.max_tokens,
            "quantized": False,
            "device": "cpu",
        },
        "output_conditioning": {
            "shared_loudness_normalization": False,
            "shared_tempo_processing": False,
            "shared_silence_trimming": False,
            "shared_crossfade": False,
            "shared_declicking": False,
            "shared_resampling": False,
            "model_native_loudness_normalization": True,
            "model_native_speed_requested": None,
            "model_native_speed_supported": False,
            "model_native_speed_applied": None,
            "model_native_total_steps": args.lsd_decode_steps,
            "model_native_text_chunking": True,
            "model_native_chunk_silence_sec": None,
            "wav_encoding": "PCM_S16LE",
        },
        "seed": args.seed,
        "passage_count": len(rows),
        "total_audio_duration_sec": round(
            sum(row["duration_sec"] for row in rows), 6
        ),
        "total_generation_time_sec": round(
            sum(row["generation_time_sec"] for row in rows), 6
        ),
        "results": rows,
    }
    json_write(output_dir / "run.json", report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
