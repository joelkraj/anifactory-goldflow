#!/usr/bin/env python3
"""One exact TTS-only contraction expansion; retain the source-text remainder."""

import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import time
import wave


RUNNER_PATH = Path(__file__).with_name("tts-local-production-runner.py")
spec = importlib.util.spec_from_file_location("goldflow_pinned_tts_runner", RUNNER_PATH)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

REQUEST_SCHEMA = "goldflow_tts_exact_contraction_request_v1"
RESULT_SCHEMA = "goldflow_tts_exact_contraction_result_v1"
FRAGMENT_SCHEMA = "goldflow_tts_contraction_fragment_v1"
SOURCE_FIRST = "She’d looked at me"
TTS_FIRST = "She had looked at me"
REMAINDER_TEXT = "in the mirror. She knew where she was going."
GAP_SAMPLES = 1920  # 80 ms at the pinned 24 kHz sample rate.


def digest(value):
    return hashlib.sha256(value).hexdigest()


def file_digest(path):
    return digest(Path(path).read_bytes())


def write_new(path, payload):
    path = Path(path)
    if path.exists():
        if path.read_bytes() != payload:
            raise ValueError(f"Immutable contraction artifact differs: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def wav_samples(path):
    with wave.open(str(path), "rb") as handle:
        if (handle.getnchannels(), handle.getsampwidth(), handle.getframerate(),
                handle.getcomptype()) != (1, 2, 24000, "NONE"):
            raise ValueError(f"Unexpected contraction WAV format: {path}")
        return handle.readframes(handle.getnframes())


def wav_payload(samples):
    stream = io.BytesIO()
    with wave.open(stream, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(24000)
        handle.writeframes(samples)
    return stream.getvalue()


def validate_request(request, request_path, output_dir):
    request_path = Path(request_path).resolve()
    output_dir = Path(output_dir).resolve()
    if request_path.parent != output_dir or request_path.name != "request.json":
        raise ValueError("Request and contraction output directory differ")
    if request.get("schema") != REQUEST_SCHEMA:
        raise ValueError("Invalid contraction request schema")
    canonical = json.dumps({k: v for k, v in request.items() if k != "request_sha256"},
                           sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    if request.get("request_sha256") != digest(canonical) or output_dir.name != request["request_sha256"]:
        raise ValueError("Contraction request hash mismatch")
    if request.get("expected_first_fragment") != SOURCE_FIRST \
            or request.get("tts_only_first_fragment") != TTS_FIRST:
        raise ValueError("Contraction candidate must expand only She’d looked at me")
    remainder_text = request.get("remainder_text")
    if remainder_text != REMAINDER_TEXT:
        raise ValueError("Contraction remainder differs from locked second fragment")
    if request.get("spoken_text_sha256") != digest(f"{SOURCE_FIRST} {remainder_text}".encode()):
        raise ValueError("Contraction candidate differs from locked spoken text")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", str(request.get("unit_id", ""))):
        raise ValueError("Unsafe contraction unit ID")
    authorization = request.get("recovery_authorization") or {}
    if authorization.get("authorization_origin") != "user_authorized_autonomous_production" \
            or authorization.get("human_listening_performed") is not False \
            or authorization.get("user_listening_claimed") is True:
        raise ValueError("Contraction candidate requires autonomous, non-listening authorization")
    if request.get("model_id") != runner.QWEN["model_id"] or request.get(
            "model_revision") != runner.QWEN["revision"]:
        raise ValueError("Contraction model differs from pinned Qwen")
    contract = runner.QWEN_REFERENCE_CONTRACTS.get(request.get("voice_continuity_contract"))
    if not contract or contract["voice_id"] != runner.JOEL_VOICE_ID \
            or contract["voice_sha256"] != runner.JOEL_VOICE_SHA256 \
            or request.get("voice_id") != contract["voice_id"] \
            or request.get("voice_sha256") != contract["voice_sha256"]:
        raise ValueError("Contraction voice differs from pinned Joel reference")
    raw_episode_dir = request.get("episode_dir")
    if not isinstance(raw_episode_dir, str) or not Path(raw_episode_dir).is_absolute():
        raise ValueError("Contraction episode directory must be absolute")
    episode_dir = Path(raw_episode_dir).resolve()
    if not output_dir.is_relative_to(episode_dir):
        raise ValueError("Contraction request escaped the episode")
    remainder = request.get("retained_remainder") or {}
    remainder_wav = Path(remainder.get("audio_path", ""))
    remainder_sidecar = Path(remainder.get("sidecar_path", ""))
    if not remainder_wav.is_absolute() or not remainder_sidecar.is_absolute() \
            or not remainder_wav.resolve().is_relative_to(episode_dir) \
            or not remainder_sidecar.resolve().is_relative_to(episode_dir):
        raise ValueError("Retained exact-text remainder escaped the episode")
    if file_digest(remainder_wav) != remainder.get("audio_sha256") or file_digest(
            remainder_sidecar) != remainder.get("sidecar_sha256"):
        raise ValueError("Retained exact-text remainder changed")
    sidecar = json.loads(remainder_sidecar.read_text())
    if sidecar.get("schema") != "goldflow_tts_exact_boundary_fragment_v1" \
            or sidecar.get("fragment_index") != 1 \
            or sidecar.get("text") != remainder_text \
            or sidecar.get("text_sha256") != digest(remainder_text.encode()) \
            or sidecar.get("audio_path") != str(remainder_wav) \
            or sidecar.get("audio_sha256") != remainder["audio_sha256"] \
            or sidecar.get("unit_id") != request["unit_id"] \
            or sidecar.get("model_id") != request["model_id"] \
            or sidecar.get("model_revision") != request["model_revision"] \
            or sidecar.get("voice_id") != contract["voice_id"] \
            or sidecar.get("voice_sha256") != contract["voice_sha256"] \
            or sidecar.get("reference_audio_sha256") != contract["audio_sha256"]:
        raise ValueError("Retained remainder sidecar is not the locked second fragment")
    runner.validate_file(Path(contract["audio_path"]), contract["audio_sha256"])
    if digest(contract["text"].encode()) != contract["text_sha256"]:
        raise ValueError("Reference transcript hash mismatch")
    if runner.package_version("mlx-audio") != runner.MLX_AUDIO_VERSION:
        raise ValueError("Contraction runtime differs from pinned mlx-audio")
    return contract, remainder, remainder_wav


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    request_path = Path(args.request).resolve()
    output_dir = Path(args.output_dir).resolve()
    request = json.loads(request_path.read_text())
    contract, remainder, remainder_wav = validate_request(request, request_path, output_dir)
    token_hash = digest(TTS_FIRST.encode())
    seed = int(digest(f"{request['request_sha256']}:{request['unit_id']}:contraction".encode())[:8], 16)
    stem = f"{request['unit_id']}-contraction-{token_hash[:16]}"
    fragment_path = output_dir / "fragments" / f"{stem}.wav"
    sidecar_path = output_dir / "fragments" / f"{stem}.json"
    if fragment_path.exists() != sidecar_path.exists():
        raise ValueError("Partial retained contraction fragment")
    if fragment_path.exists():
        sidecar = json.loads(sidecar_path.read_text())
        if sidecar.get("schema") != FRAGMENT_SCHEMA \
                or sidecar.get("request_sha256") != request["request_sha256"] \
                or sidecar.get("unit_id") != request["unit_id"] \
                or sidecar.get("text") != TTS_FIRST or sidecar.get("text_sha256") != token_hash \
                or sidecar.get("model_id") != request["model_id"] \
                or sidecar.get("model_revision") != request["model_revision"] \
                or sidecar.get("voice_id") != request["voice_id"] \
                or sidecar.get("voice_sha256") != request["voice_sha256"] \
                or sidecar.get("reference_audio_sha256") != contract["audio_sha256"] \
                or sidecar.get("seed") != seed \
                or sidecar.get("audio_path") != str(fragment_path) \
                or sidecar.get("audio_sha256") != file_digest(fragment_path) \
                or sidecar.get("sample_count") != len(wav_samples(fragment_path)) // 2 \
                or not isinstance(sidecar.get("generated_token_count"), int) \
                or sidecar["generated_token_count"] >= contract["generation_parameters"]["max_tokens"] \
                or sidecar.get("effective_token_limit") != contract["generation_parameters"]["max_tokens"]:
            raise ValueError("Retained contraction fragment is stale")
    else:
        runner.load_synthesis_dependencies()
        runner.resolve_snapshot("qwen", True, None)
        model = runner.load_model(runner.QWEN["source"], revision=runner.QWEN["revision"],
                                  local_files_only=True)
        started = time.monotonic()
        runner.mx.random.seed(seed)
        generated = list(model.generate(
            text=TTS_FIRST, ref_audio=contract["audio_path"], ref_text=contract["text"],
            **contract["generation_parameters"], verbose=False,
        ))
        token_count = sum(int(getattr(part, "token_count", 0) or 0) for part in generated)
        token_limit = contract["generation_parameters"]["max_tokens"]
        if not generated or any(int(part.sample_rate) != 24000 for part in generated) \
                or token_count >= token_limit:
            raise ValueError("Contraction fragment missing, malformed, or token-limited")
        audio = runner.mx.concatenate([part.audio for part in generated], axis=0)
        runner.mx.eval(audio)
        values = runner.np.asarray(audio, dtype=runner.np.float32).reshape(-1)
        if not values.size or not runner.np.isfinite(values).all():
            raise ValueError("Invalid contraction fragment audio")
        pcm = (runner.np.clip(values, -1, 1) * 32767).astype("<i2").tobytes()
        write_new(fragment_path, wav_payload(pcm))
        sidecar = {
            "schema": FRAGMENT_SCHEMA,
            "request_sha256": request["request_sha256"],
            "unit_id": request["unit_id"], "text": TTS_FIRST, "text_sha256": token_hash,
            "model_id": request["model_id"], "model_revision": request["model_revision"],
            "voice_id": request["voice_id"], "voice_sha256": request["voice_sha256"],
            "reference_audio_sha256": contract["audio_sha256"],
            "seed": seed, "audio_path": str(fragment_path),
            "audio_sha256": file_digest(fragment_path), "sample_count": len(pcm) // 2,
            "generated_token_count": token_count, "effective_token_limit": token_limit,
            "elapsed_sec": round(time.monotonic() - started, 6),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        write_new(sidecar_path, (json.dumps(sidecar, indent=2, ensure_ascii=False) + "\n").encode())
    first_pcm = wav_samples(fragment_path)
    rest_pcm = wav_samples(remainder_wav)
    composite = first_pcm + bytes(GAP_SAMPLES * 2) + rest_pcm
    composite_path = output_dir / "composites" / f"{request['unit_id']}-{digest(composite)[:24]}.wav"
    write_new(composite_path, wav_payload(composite))
    result = {
        "schema": RESULT_SCHEMA,
        "request_path": str(request_path), "request_file_sha256": file_digest(request_path),
        "request_sha256": request["request_sha256"],
        "unit": {
            "unit_id": request["unit_id"],
            "spoken_text_sha256": request["spoken_text_sha256"],
            "audio_path": str(composite_path), "audio_sha256": file_digest(composite_path),
            "duration_sec": len(composite) / 48000,
            "gap_sample_count": GAP_SAMPLES,
            "generated_token_count": sidecar["generated_token_count"],
            "effective_token_limit": sidecar["effective_token_limit"],
            "literal_expansion_fragment": {**sidecar, "sidecar_path": str(sidecar_path),
                                           "sidecar_sha256": file_digest(sidecar_path)},
            "retained_remainder": remainder,
        },
        "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    result_path = output_dir / "repair-result.json"
    if result_path.exists():
        # Resume only the same immutable candidate; never synthesize a new take.
        previous = json.loads(result_path.read_text())
        result["completed_at"] = previous.get("completed_at")
    write_new(result_path, (json.dumps(result, indent=2, ensure_ascii=False) + "\n").encode())
    print(json.dumps({"status": "candidate_pending_automated_asr", "result_path": str(result_path),
                      "result_sha256": file_digest(result_path),
                      "candidate_audio_path": str(composite_path),
                      "candidate_audio_sha256": result["unit"]["audio_sha256"],
                      "human_listening_performed": False}))


if __name__ == "__main__":
    main()
