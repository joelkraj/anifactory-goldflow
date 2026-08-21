#!/usr/bin/env python3

"""Dependency-free tests for the runner's pre-model narration gate."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNNER_PATH = ROOT / "scripts" / "tts-local-production-runner.py"
SPEC = importlib.util.spec_from_file_location("tts_local_production_runner", RUNNER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load runner module from {RUNNER_PATH}")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def test_preserved_unit_never_enters_resume_jobs() -> None:
    assert RUNNER.mx is None
    assert RUNNER.load_model is None
    with tempfile.TemporaryDirectory(prefix="goldflow-tts-gate-") as raw_dir:
        directory = Path(raw_dir)
        audio_path = directory / "u1.wav"
        sidecar_path = directory / "u1.json"
        gate_path = directory / "narration_tts_pre_synthesis_gate_ep_01.json"
        audio_path.write_bytes(b"immutable accepted narration unit")
        audio_sha256 = file_sha256(audio_path)
        spoken_sha256 = "1" * 64
        synthesis_identity_sha256 = "2" * 64
        write_json(
            sidecar_path,
            {
                "unit_id": "u1",
                "output_sha256": audio_sha256,
                "spoken_text_sha256": spoken_sha256,
                "synthesis_identity_sha256": synthesis_identity_sha256,
            },
        )
        preserved_artifact = {
            "unit_id": "u1",
            "spoken_text_sha256": spoken_sha256,
            "audio_path": str(audio_path),
            "audio_sha256": audio_sha256,
            "synthesis_sidecar_path": str(sidecar_path),
            "synthesis_sidecar_sha256": file_sha256(sidecar_path),
            "synthesis_identity_sha256": synthesis_identity_sha256,
            "attempt": 1,
            "seed": 17,
            "cohort_sha256": "3" * 64,
        }
        gate = {
            "schema": "goldflow_narration_pre_synthesis_gate_v2",
            "status": "passed",
            "phase": "synthesis_authorized_immediately_before_helper_import",
            "production_stage_passed": False,
            "model_load_performed": True,
            "synthesis_invoked": True,
            "historical_synthesis_authorized": False,
            "bindings": {
                "narration_generation_plan_sha256": "4" * 64,
                "narration_generation_plan_file_sha256": "5" * 64,
                "run_identity_file_sha256": "6" * 64,
                "script_sha256": "7" * 64,
            },
            "contract": {
                "provider": "qwen_local",
                "model_id": "fixture-model",
                "model_revision": "fixture-revision",
                "voice_id": "fixture-voice",
                "voice_sha256": "8" * 64,
                "voice_continuity_contract": "fixture-continuity",
            },
            "scope": {
                "mode": "interrupted_full_synthesis_resume_preserving_accepted_units",
                "authorized_synthesis_unit_ids": ["u2"],
                "preserved_unit_ids": ["u1"],
                "preserved_artifacts": [preserved_artifact],
            },
            "unit_count": 2,
            "authorization": {
                "schema": "goldflow_narration_synthesis_authorization_v1",
                "validation_gate_sha256": "9" * 64,
            },
            "findings": [],
        }
        gate["gate_sha256"] = RUNNER.narration_gate_sha256(gate)
        write_json(gate_path, gate)
        manifest = {
            "synthesis_mode": RUNNER.INCOMPLETE_UNIT_RESUME_MODE,
            "narration_generation_plan_sha256": "4" * 64,
            "narration_generation_plan_file_sha256": "5" * 64,
            "run_identity_file_sha256": "6" * 64,
            "source_script_sha256": "7" * 64,
            "provider": "qwen_local",
            "model_id": "fixture-model",
            "model_revision": "fixture-revision",
            "voice_id": "fixture-voice",
            "voice_sha256": "8" * 64,
            "voice_continuity_contract": "fixture-continuity",
            "pre_synthesis_gate": {
                "path": str(gate_path),
                "file_sha256": file_sha256(gate_path),
                "gate_sha256": gate["gate_sha256"],
            },
        }
        resume_jobs = [{"unit_id": "u2"}]
        preserved = RUNNER.validate_pre_synthesis_gate(manifest, resume_jobs)
        assert [row["unit_id"] for row in preserved] == ["u1"]
        RUNNER.verify_preserved_artifacts_unchanged(preserved)

        try:
            RUNNER.validate_pre_synthesis_gate(
                manifest,
                [{"unit_id": "u1"}, {"unit_id": "u2"}],
            )
        except ValueError as error:
            assert "authorized scope" in str(error)
        else:
            raise AssertionError("Preserved u1 was accepted in the runner job list")

        audio_path.write_bytes(b"overwritten accepted narration unit")
        try:
            RUNNER.verify_preserved_artifacts_unchanged(preserved)
        except RuntimeError as error:
            assert "changed during synthesis" in str(error)
        else:
            raise AssertionError("Preserved WAV mutation was not detected")


test_preserved_unit_never_enters_resume_jobs()
print("TTS pre-synthesis runner tests passed")
