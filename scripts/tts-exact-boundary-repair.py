#!/usr/bin/env python3
"""Synthesize only reviewed sentence fragments for a blocked Qwen unit.

This is a derived exact-boundary repair, not a third full-unit take. The
request is prepared and hash-bound by the guarded JS entry point. Every raw
fragment and composite is retained; accepted audio is never rewritten.
"""

import argparse
import hashlib
import importlib.util
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


def digest(value):
    return hashlib.sha256(value).hexdigest()


def file_digest(path):
    return digest(Path(path).read_bytes())


def write_new(path, payload):
    path = Path(path)
    if path.exists():
        if path.read_bytes() != payload:
            raise ValueError(f"Immutable repair artifact differs: {path}")
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
            raise ValueError(f"Unexpected repair WAV format: {path}")
        return handle.readframes(handle.getnframes())


def write_pcm16_wav(path, samples):
    import io
    stream = io.BytesIO()
    with wave.open(stream, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(24000)
        handle.writeframes(samples)
    write_new(path, stream.getvalue())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    request_path = Path(args.request).resolve()
    output_dir = Path(args.output_dir).resolve()
    request = json.loads(request_path.read_text())
    if request.get("schema") != "goldflow_tts_exact_boundary_repair_request_v1":
        raise ValueError("Invalid exact-boundary repair request")
    if request.get("request_sha256") != digest(json.dumps(
        {k: v for k, v in request.items() if k != "request_sha256"},
        sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    ).encode()):
        raise ValueError("Repair request hash mismatch")
    if request.get("model_id") != runner.QWEN["model_id"] or request.get(
        "model_revision"
    ) != runner.QWEN["revision"]:
        raise ValueError("Repair model differs from pinned Qwen")
    contract = runner.QWEN_REFERENCE_CONTRACTS.get(
        request.get("voice_continuity_contract")
    )
    if not contract or request.get("voice_id") != contract["voice_id"] or request.get(
        "voice_sha256"
    ) != contract["voice_sha256"]:
        raise ValueError("Repair voice differs from pinned reference")
    reference_path = Path(contract["audio_path"])
    runner.validate_file(reference_path, contract["audio_sha256"])
    if digest(contract["text"].encode()) != contract["text_sha256"]:
        raise ValueError("Reference transcript hash mismatch")
    if runner.package_version("mlx-audio") != runner.MLX_AUDIO_VERSION:
        raise ValueError("Repair runtime differs from pinned mlx-audio")
    runner.load_synthesis_dependencies()
    runner.resolve_snapshot("qwen", True, None)
    model = runner.load_model(
        runner.QWEN["source"], revision=runner.QWEN["revision"],
        local_files_only=True,
    )
    rows = []
    for unit in request["units"]:
        unit_id = unit["unit_id"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", unit_id):
            raise ValueError("Unsafe unit ID")
        fragments = unit["fragments"]
        if not fragments or " ".join(fragments) != unit["spoken_text"]:
            raise ValueError(f"Repair fragments do not reproduce {unit_id}")
        fragment_rows = []
        sample_parts = []
        for index, fragment in enumerate(fragments):
            fragment_hash = digest(fragment.encode())
            seed = int(digest(f"{request['request_sha256']}:{unit_id}:{index}".encode())[:8], 16)
            stem = f"{unit_id}-part{index + 1:02d}-{fragment_hash[:16]}"
            wav_path = output_dir / "fragments" / f"{stem}.wav"
            sidecar_path = output_dir / "fragments" / f"{stem}.json"
            if wav_path.exists() != sidecar_path.exists():
                raise ValueError(f"Incomplete retained repair fragment: {stem}")
            if wav_path.exists():
                sidecar = json.loads(sidecar_path.read_text())
                if (sidecar.get("request_sha256") != request["request_sha256"]
                    or sidecar.get("text_sha256") != fragment_hash
                    or sidecar.get("seed") != seed
                    or sidecar.get("audio_sha256") != file_digest(wav_path)):
                    raise ValueError(f"Stale retained repair fragment: {stem}")
            else:
                started = time.monotonic()
                runner.mx.random.seed(seed)
                generated = list(model.generate(
                    text=fragment, ref_audio=str(reference_path),
                    ref_text=contract["text"],
                    **contract["generation_parameters"], verbose=False,
                ))
                if not generated or any(int(part.sample_rate) != 24000 for part in generated):
                    raise ValueError(f"Repair generation missing/invalid for {stem}")
                if sum(int(getattr(part, "token_count", 0) or 0) for part in generated) >= contract[
                    "generation_parameters"
                ]["max_tokens"]:
                    raise ValueError(f"Repair token limit reached for {stem}")
                audio = runner.mx.concatenate([part.audio for part in generated], axis=0)
                runner.mx.eval(audio)
                values = runner.np.asarray(audio, dtype=runner.np.float32).reshape(-1)
                if not values.size or not runner.np.isfinite(values).all():
                    raise ValueError(f"Invalid repair audio for {stem}")
                pcm = (runner.np.clip(values, -1, 1) * 32767).astype("<i2").tobytes()
                write_pcm16_wav(wav_path, pcm)
                sidecar = {
                    "schema": "goldflow_tts_exact_boundary_fragment_v1",
                    "request_sha256": request["request_sha256"],
                    "unit_id": unit_id, "fragment_index": index,
                    "text": fragment, "text_sha256": fragment_hash,
                    "model_id": request["model_id"],
                    "model_revision": request["model_revision"],
                    "voice_id": request["voice_id"],
                    "voice_sha256": request["voice_sha256"],
                    "reference_audio_sha256": contract["audio_sha256"],
                    "seed": seed, "audio_path": str(wav_path),
                    "audio_sha256": file_digest(wav_path),
                    "sample_count": len(pcm) // 2,
                    "generated_token_count": sum(int(getattr(part, "token_count", 0) or 0) for part in generated),
                    "elapsed_sec": round(time.monotonic() - started, 6),
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                write_new(sidecar_path, (json.dumps(sidecar, indent=2, ensure_ascii=False) + "\n").encode())
            samples = wav_samples(wav_path)
            fragment_rows.append({**sidecar, "sidecar_path": str(sidecar_path),
                                  "sidecar_sha256": file_digest(sidecar_path)})
            sample_parts.append(samples)
        gap = bytes(1920 * 2)  # 80 ms of exact digital silence at 24 kHz.
        composite_samples = gap.join(sample_parts)
        composite_hash = digest(composite_samples)
        composite_path = output_dir / "composites" / f"{unit_id}-{composite_hash[:24]}.wav"
        write_pcm16_wav(composite_path, composite_samples)
        rows.append({
            "unit_id": unit_id, "spoken_text_sha256": unit["spoken_text_sha256"],
            "audio_path": str(composite_path), "audio_sha256": file_digest(composite_path),
            "duration_sec": len(composite_samples) / 48000,
            "gap_sample_count": 1920, "fragments": fragment_rows,
        })
    report = {
        "schema": "goldflow_tts_exact_boundary_repair_result_v1",
        "request_path": str(request_path), "request_file_sha256": file_digest(request_path),
        "request_sha256": request["request_sha256"],
        "model_id": request["model_id"], "model_revision": request["model_revision"],
        "voice_id": request["voice_id"], "voice_sha256": request["voice_sha256"],
        "units": rows, "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    report_path = output_dir / "repair-result.json"
    if report_path.exists():
        retained = json.loads(report_path.read_text())
        for field in ["request_sha256", "request_file_sha256", "model_id", "model_revision", "voice_id", "voice_sha256", "units"]:
            if retained.get(field) != report.get(field):
                raise ValueError(f"Immutable repair result differs: {field}")
    else:
        write_new(report_path, (json.dumps(report, indent=2, ensure_ascii=False) + "\n").encode())
    print(json.dumps({"status": "passed", "report_path": str(report_path),
                      "report_sha256": file_digest(report_path), "unit_count": len(rows)}))


if __name__ == "__main__":
    main()
