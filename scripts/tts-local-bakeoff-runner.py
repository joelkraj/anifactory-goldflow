#!/usr/bin/env python3

"""Run one clone-conditioned or preset-voice MLX TTS bake-off contestant.

The model is loaded once so reported throughput reflects warm production use,
not repeated CLI cold starts. No shared loudness normalization or post-TTS
tempo processing is applied; any model-native output conditioning is recorded.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import time
from pathlib import Path
from typing import Any

import mlx.core as mx
import numpy as np

from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--codec")
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--model-kind", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--ref-audio",
        help="Reference audio for clone-conditioned models.",
    )
    parser.add_argument(
        "--ref-text",
        help="Exact transcript of --ref-audio for clone-conditioned models.",
    )
    parser.add_argument(
        "--voice",
        help=(
            "Provider/model-native preset voice, for example Aiden for Qwen "
            "CustomVoice or am_fenrir for Kokoro."
        ),
    )
    parser.add_argument(
        "--instruct",
        help="Optional model-native delivery instruction for a preset voice.",
    )
    parser.add_argument(
        "--lang-code",
        help=(
            "Model-native language code. Defaults to the model default "
            "(auto for Qwen and a for Kokoro)."
        ),
    )
    parser.add_argument(
        "--native-speed",
        type=float,
        default=1.0,
        help=(
            "Model-native speed control. Post-TTS tempo processing is never "
            "applied. Qwen3-TTS currently accepts but does not implement this "
            "control, so non-1.0 Qwen values are rejected."
        ),
    )
    parser.add_argument("--seed", type=int, default=20260726)
    return parser.parse_args()


REFERENCE_ONLY_MODEL_KINDS = {
    "chatterbox_turbo",
    "voxcpm2",
    "longcat",
    "fish_s2",
    "higgs_v2",
}

NATIVE_SPEED_UNSUPPORTED_MODEL_KINDS = {
    "qwen3",
    "chatterbox_turbo",
    "voxcpm2",
    "longcat",
    "higgs_v2",
}


def validate_conditioning_args(args: argparse.Namespace) -> None:
    has_ref_audio = bool(args.ref_audio)
    has_ref_text = bool(args.ref_text)
    if has_ref_audio != has_ref_text:
        raise ValueError("--ref-audio and --ref-text must be supplied together")
    if args.voice and has_ref_audio:
        raise ValueError(
            "Choose one conditioning mode: --voice or "
            "--ref-audio/--ref-text, not both"
        )
    if not args.voice and not has_ref_audio:
        raise ValueError(
            "Supply either --voice for preset mode or "
            "--ref-audio/--ref-text for clone mode"
        )
    if args.instruct and not args.voice:
        raise ValueError("--instruct requires preset --voice mode")
    if args.instruct and args.model_kind == "kokoro":
        raise ValueError("Kokoro does not support --instruct in this runner")
    if args.voice and args.model_kind in REFERENCE_ONLY_MODEL_KINDS:
        raise ValueError(
            f"{args.model_kind} is reference-conditioned in this runner; "
            "use --ref-audio/--ref-text"
        )
    if args.model_kind == "kokoro" and not args.voice:
        raise ValueError("Kokoro requires preset --voice mode in this runner")
    if args.native_speed <= 0:
        raise ValueError("--native-speed must be greater than zero")
    if (
        args.native_speed != 1.0
        and args.model_kind in NATIVE_SPEED_UNSUPPORTED_MODEL_KINDS
    ):
        raise ValueError(
            f"{args.model_kind} does not expose a working native speed control "
            "in this runner; use --native-speed 1.0"
        )


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def json_write(file_path: Path, value: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def generation_kwargs(
    model: Any,
    model_kind: str,
    text: str,
    ref_audio: str | None,
    ref_text: str | None,
    voice: str | None,
    instruct: str | None,
    lang_code: str | None,
    native_speed: float,
    seed: int,
) -> dict[str, Any]:
    common: dict[str, Any] = {"text": text}
    if ref_audio is not None:
        common["ref_audio"] = ref_audio
        common["ref_text"] = ref_text
    if model_kind == "qwen3":
        qwen_kwargs = {
            **common,
            "voice": voice,
            "temperature": 0.6,
            "top_p": 0.8,
            "top_k": 50,
            "repetition_penalty": 1.2,
            "max_tokens": 1200,
            "verbose": False,
        }
        if instruct is not None:
            qwen_kwargs["instruct"] = instruct
        if lang_code is not None:
            qwen_kwargs["lang_code"] = lang_code
        return qwen_kwargs
    if model_kind == "kokoro":
        kokoro_kwargs = {
            "text": text,
            "voice": voice,
            "speed": native_speed,
        }
        if lang_code is not None:
            kokoro_kwargs["lang_code"] = lang_code
        return kokoro_kwargs
    if model_kind == "chatterbox_turbo":
        return {
            **common,
            "temperature": 0.8,
            "top_p": 0.95,
            "top_k": 1000,
            "repetition_penalty": 1.2,
            "max_tokens": 1000,
            "split_pattern": None,
            "norm_loudness": True,
        }
    if model_kind == "voxcpm2":
        return {
            **common,
            "max_tokens": 2000,
            "inference_timesteps": 10,
            "cfg_value": 2.0,
            "warmup_patches": 1,
            "seed": seed,
        }
    if model_kind == "longcat":
        return {
            **common,
            "guidance_method": "apg",
            "cfg_strength": 4.0,
            "steps": 16,
            "seed": seed,
        }
    if model_kind == "fish_s2":
        return {
            **common,
            "temperature": 0.7,
            "top_p": 0.7,
            "top_k": 30,
            "repetition_penalty": 1.2,
            "max_tokens": 1200,
            "speed": native_speed,
            "verbose": False,
        }
    if model_kind == "higgs_v2":
        return {
            **common,
            "temperature": 0.7,
            "top_p": 0.95,
            "max_new_frames": 1200,
        }

    signature = inspect.signature(model.generate)
    parameters = signature.parameters
    accepts_extra_kwargs = any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in parameters.values()
    )
    optional = {
        "voice": voice,
        "instruct": instruct,
        "lang_code": lang_code,
    }
    if "speed" in parameters:
        optional["speed"] = native_speed
    candidates = {
        **common,
        **{key: value for key, value in optional.items() if value is not None},
    }
    if accepts_extra_kwargs:
        return candidates
    return {
        key: value for key, value in candidates.items() if key in parameters
    }


def supports_native_speed(model: Any, model_kind: str) -> bool:
    if model_kind in NATIVE_SPEED_UNSUPPORTED_MODEL_KINDS:
        return False
    if model_kind in {"kokoro", "fish_s2"}:
        return True
    signature = inspect.signature(model.generate)
    return "speed" in signature.parameters


def main() -> None:
    args = parse_args()
    validate_conditioning_args(args)
    manifest_path = Path(args.manifest).resolve()
    output_dir = Path(args.output_dir).resolve()
    ref_audio_path = (
        Path(args.ref_audio).resolve() if args.ref_audio is not None else None
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    passages = manifest.get("passages") or []
    if not passages:
        raise ValueError(f"No passages in {manifest_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    mx.random.seed(args.seed)
    load_started = time.perf_counter()
    if args.model_kind == "higgs_v2":
        if not args.codec:
            raise ValueError("--codec is required for Higgs Audio v2")
        if ref_audio_path is None:
            raise ValueError(
                "--ref-audio/--ref-text are required for Higgs Audio v2"
            )
        from mlx_audio.tts.models.higgs_audio import HiggsAudioServer

        model = HiggsAudioServer.from_pretrained(
            model_path=args.model,
            codec_path=args.codec,
        )
        model.prepare_reference(str(ref_audio_path), args.ref_text)
    else:
        model = load_model(args.model)
    load_seconds = time.perf_counter() - load_started
    native_speed_supported = supports_native_speed(model, args.model_kind)
    if args.native_speed != 1.0 and not native_speed_supported:
        raise ValueError(
            f"{args.model_kind} does not expose a working native speed control; "
            "use --native-speed 1.0"
        )

    rows: list[dict[str, Any]] = []
    for passage_index, passage in enumerate(passages):
        passage_id = passage["id"]
        text = passage["text"]
        passage_seed = args.seed + passage_index
        mx.random.seed(passage_seed)
        started = time.perf_counter()
        if args.model_kind == "higgs_v2":
            higgs_result = model.generate(
                target_text=text,
                max_new_frames=1200,
                temperature=0.7,
                top_p=0.95,
                fade_in_ms=30.0,
                fade_out_ms=15.0,
            )
            results = [higgs_result]
        else:
            kwargs = generation_kwargs(
                model,
                args.model_kind,
                text,
                str(ref_audio_path) if ref_audio_path is not None else None,
                args.ref_text,
                args.voice,
                args.instruct,
                args.lang_code,
                args.native_speed,
                passage_seed,
            )
            results = list(model.generate(**kwargs))
        elapsed = time.perf_counter() - started
        if not results:
            raise RuntimeError(f"{args.model_id}/{passage_id} returned no audio")

        sample_rate = int(
            results[0].sampling_rate
            if args.model_kind == "higgs_v2"
            else results[0].sample_rate
        )
        chunks = [
            result.pcm if args.model_kind == "higgs_v2" else result.audio
            for result in results
        ]
        audio = chunks[0] if len(chunks) == 1 else mx.concatenate(chunks, axis=0)
        mx.eval(audio)
        output_path = output_dir / f"{passage_id}.wav"
        audio_write(str(output_path), np.array(audio), sample_rate, format="wav")
        duration_sec = float(audio.shape[0]) / sample_rate
        rows.append(
            {
                "passage_id": passage_id,
                "text": text,
                "output_path": str(output_path),
                "output_sha256": sha256_file(output_path),
                "sample_rate_hz": sample_rate,
                "duration_sec": round(duration_sec, 6),
                "generation_time_sec": round(elapsed, 6),
                "generation_rtf": round(elapsed / duration_sec, 6)
                if duration_sec > 0
                else None,
                "result_chunk_count": len(results),
                "seed": passage_seed,
            }
        )

    report = {
        "schema": "goldflow_local_tts_bakeoff_run_v1",
        "status": "passed",
        "model_id": args.model_id,
        "model_kind": args.model_kind,
        "model_path": args.model,
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "voice_mode": "preset" if args.voice else "reference_clone",
        "preset_voice": args.voice,
        "voice_instruction": args.instruct,
        "language_code": args.lang_code
        or (
            "auto"
            if args.model_kind == "qwen3"
            else "a"
            if args.model_kind == "kokoro"
            else None
        ),
        "reference_audio_path": (
            str(ref_audio_path) if ref_audio_path is not None else None
        ),
        "reference_audio_sha256": (
            sha256_file(ref_audio_path) if ref_audio_path is not None else None
        ),
        "reference_text": args.ref_text,
        "model_load_time_sec": round(load_seconds, 6),
        "output_conditioning": {
            "shared_loudness_normalization": False,
            "shared_tempo_processing": False,
            "model_native_loudness_normalization": (
                args.model_kind == "chatterbox_turbo"
            ),
            "model_native_speed_requested": args.native_speed,
            "model_native_speed_supported": native_speed_supported,
            "model_native_speed_applied": (
                args.native_speed if native_speed_supported else None
            ),
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
    main()
