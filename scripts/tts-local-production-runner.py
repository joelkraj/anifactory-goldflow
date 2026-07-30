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
from mlx_audio.utils import load_audio


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
LIAM_VOICE_ID = "am_liam"
LIAM_VOICE_SHA256 = (
    "66b65a96e16c3d91035a6e9019d9986ed524d27ce35b487270cdf61c99e3ebad"
)
JOEL_VOICE_ID = "joel_owned_narrator_clone"
JOEL_VOICE_SHA256 = (
    "48a7ec7ab4aa2170ae368e3ba1e25964138e4958e7120f8e51f411848def5ecf"
)
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
QWEN_LIAM_REFERENCE = {
    "contract_id": "qwen_liam_primary_v1",
    "voice_continuity_contract": "qwen_icl_clone_of_liam_reference",
    "voice_clone_contract": "qwen_icl_clone_of_selected_liam_reference",
    "voice_id": LIAM_VOICE_ID,
    "voice_sha256": LIAM_VOICE_SHA256,
    "audio_path": (
        "/Users/joel/AniFactoryData/voice_bank/proofs/"
        "2026-07-27-qwen-liam-clone-delivery-v1/liam_reference/"
        "liam_clone_reference.wav"
    ),
    "audio_sha256": (
        "6200eb0dcc2d5f9c9d0ab52a2532d033a3db126e9d1570e78d4463cc282ee0af"
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
    "manifest_path": (
        "/Users/joel/AniFactoryData/voice_bank/proofs/"
        "2026-07-27-qwen-liam-clone-delivery-v1/"
        "liam_reference_manifest.json"
    ),
    "manifest_sha256": (
        "6da7f9797caba9e872862fec31097cfe0b6e171b343096b9644d1846d635ad7c"
    ),
    "metadata_path": (
        "/Users/joel/AniFactoryData/voice_bank/proofs/"
        "2026-07-27-qwen-liam-clone-delivery-v1/"
        "liam_reference/run.json"
    ),
    "metadata_sha256": (
        "4357626dda4f07e0cb22ac304e593611d9ecce080aad895b7f2a10ad0737a811"
    ),
    "source_provider": KOKORO["provider"],
    "source_model_id": KOKORO["model_id"],
    "source_model_revision": KOKORO["revision"],
    "source_unit_id": "liam_clone_reference",
    "legacy_compatibility": False,
    "generation_parameters": {
        "temperature": 0.6,
        "top_p": 0.8,
        "top_k": 50,
        "repetition_penalty": 1.2,
        "max_tokens": 1200,
    },
}
QWEN_JOEL_REFERENCE = {
    "contract_id": "qwen_joel_primary_v1",
    "voice_continuity_contract": "qwen_icl_clone_of_joel_owned_reference",
    "voice_clone_contract": "qwen_icl_clone_of_selected_joel_owned_reference",
    "voice_id": JOEL_VOICE_ID,
    "voice_sha256": JOEL_VOICE_SHA256,
    "audio_path": (
        "/Users/joel/AniFactoryData/voice_bank/qwen/reference_samples/"
        "joel_narrator/joel_ref_02_tense_narration.wav"
    ),
    "audio_sha256": (
        "4cb13c2fb887874b77125b70c020f3cfb103954246fb391a51ce99f0341d8a17"
    ),
    "text": (
        "The register turned blue before the window cracked. Outside, something "
        "tall moved between the parked cars, stopped under the dead sign, and "
        "waited like it had already learned his name."
    ),
    "text_sha256": (
        "0d51ab6db4afea9f0e9341b009b5b100e280279d17752a154b6b248353df2d8d"
    ),
    "manifest_path": (
        "/Users/joel/AniFactoryData/voice_bank/qwen/reference_samples/"
        "joel_narrator/manifest.json"
    ),
    "manifest_sha256": (
        "ac7a784998f614d75abd9e6c2788692094ba80825edb4bea4508f899c60ea9f7"
    ),
    "metadata_path": (
        "/Users/joel/AniFactoryData/voice_bank/qwen/voices/"
        "joel_owned_narrator_clone/voice.json"
    ),
    "metadata_sha256": (
        "48a7ec7ab4aa2170ae368e3ba1e25964138e4958e7120f8e51f411848def5ecf"
    ),
    "source_provider": "operator_owned_audio",
    "source_model_id": "joel_owned_voice_recording",
    "source_model_revision": "joel_ref_02_tense_narration_v1",
    "source_unit_id": "joel_ref_02_tense_narration",
    "legacy_compatibility": False,
    "generation_parameters": {
        "temperature": 0.6,
        "top_p": 0.8,
        "top_k": 50,
        "repetition_penalty": 1.2,
        "max_tokens": 1200,
    },
}
QWEN_PUCK_REFERENCE = {
    "contract_id": "qwen_puck_legacy_fallback_v1",
    "voice_continuity_contract": "clone_primary_puck_identity",
    "voice_clone_contract": "qwen_icl_clone_of_selected_puck_reference",
    "voice_id": PUCK_VOICE_ID,
    "voice_sha256": PUCK_VOICE_SHA256,
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
    "legacy_compatibility": True,
    "generation_parameters": {
        "temperature": 0.6,
        "top_p": 0.8,
        "top_k": 50,
        "repetition_penalty": 1.5,
        "max_tokens": 1200,
    },
}
QWEN_REFERENCE_CONTRACTS = {
    QWEN_JOEL_REFERENCE["voice_continuity_contract"]: QWEN_JOEL_REFERENCE,
    QWEN_LIAM_REFERENCE["voice_continuity_contract"]: QWEN_LIAM_REFERENCE,
    QWEN_PUCK_REFERENCE["voice_continuity_contract"]: QWEN_PUCK_REFERENCE,
}
MLX_AUDIO_VERSION = "0.4.6"
SERIAL_SYNTHESIS_MODE = "serial_unit_v1"
BATCH4_SYNTHESIS_MODE = "fixed_batch4_length_matched_v1"
EXACT_UNIT_RECOVERY_MODE = "serial_exact_unit_recovery_v1"
SERIAL_SYNTHESIS_CONTRACT = {
    "schema": "goldflow_qwen_liam_synthesis_contract_v1",
    "contract_id": "qwen_liam_serial_unit_v1",
    "mode": SERIAL_SYNTHESIS_MODE,
    "api": "Model.generate",
    "scheduler_version": "source_order_serial_v1",
    "resident_model_count": 1,
    "model_concurrency": 1,
    "nominal_batch_size": 1,
    "final_partial_cohort_allowed": False,
    "continuous_batching": False,
    "token_limit_acceptance_allowed": False,
    "objective_recovery_mode": SERIAL_SYNTHESIS_MODE,
}
BATCH4_SYNTHESIS_CONTRACT = {
    "schema": "goldflow_qwen_liam_synthesis_contract_v1",
    "contract_id": "qwen_liam_fixed_batch4_length_matched_v1",
    "mode": BATCH4_SYNTHESIS_MODE,
    "api": "Model.batch_generate",
    "scheduler_version": "stable_length_word_byte_source_id_v1",
    "resident_model_count": 1,
    "model_concurrency": 1,
    "nominal_batch_size": 4,
    "final_partial_cohort_allowed": True,
    "continuous_batching": False,
    "token_limit_acceptance_allowed": False,
    "objective_recovery_mode": EXACT_UNIT_RECOVERY_MODE,
}


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
    if (
        not isinstance(value, dict)
        or value.get("schema")
        not in {
            "goldflow_narration_tts_jobs_v1",
            "goldflow_narration_tts_jobs_v2",
        }
    ):
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
        if value.get("schema") == "goldflow_narration_tts_jobs_v2":
            original_order_index = int(row.get("original_order_index"))
            spoken_word_count = int(row.get("spoken_word_count"))
            spoken_text_utf8_bytes = int(
                row.get("spoken_text_utf8_bytes")
            )
            if (
                original_order_index < 0
                or spoken_word_count != len(text.strip().split())
                or spoken_text_utf8_bytes != len(text.encode("utf-8"))
            ):
                raise ValueError(
                    f"Batch-bound length/order metadata is stale for {unit_id}"
                )
        seen.add(unit_id)
        output.append(row)
    return output


def validate_qwen_synthesis_manifest(
    value: dict[str, Any],
    jobs: list[dict[str, Any]],
) -> tuple[str, dict[str, Any], dict[str, Any] | None]:
    if value.get("schema") == "goldflow_narration_tts_jobs_v1":
        return SERIAL_SYNTHESIS_MODE, SERIAL_SYNTHESIS_CONTRACT, None
    mode = str(value.get("synthesis_mode") or "").strip()
    contract = value.get("synthesis_contract")
    if mode == SERIAL_SYNTHESIS_MODE:
        expected_contract = SERIAL_SYNTHESIS_CONTRACT
    elif mode in {BATCH4_SYNTHESIS_MODE, EXACT_UNIT_RECOVERY_MODE}:
        expected_contract = BATCH4_SYNTHESIS_CONTRACT
    else:
        raise ValueError(f"Unsupported Qwen synthesis mode: {mode!r}")
    if contract != expected_contract:
        raise ValueError(
            f"Qwen synthesis contract mismatch for mode {mode!r}"
        )
    if (
        int(contract["resident_model_count"]) != 1
        or int(contract["model_concurrency"]) != 1
        or contract["continuous_batching"] is not False
        or contract["token_limit_acceptance_allowed"] is not False
    ):
        raise ValueError("Qwen synthesis contract violates production locks")

    batch_plan = value.get("batch_plan")
    batch_plan_sha256 = str(value.get("batch_plan_sha256") or "")
    if not batch_plan_sha256:
        raise ValueError("Qwen synthesis manifest lacks batch_plan_sha256")
    if mode in {BATCH4_SYNTHESIS_MODE, EXACT_UNIT_RECOVERY_MODE}:
        if not isinstance(batch_plan, dict):
            raise ValueError("Batch-four synthesis requires its exact batch plan")
        unsigned_plan = {
            key: child
            for key, child in batch_plan.items()
            if key != "batch_plan_sha256"
        }
        if (
            batch_plan.get("batch_plan_sha256")
            != canonical_sha256(unsigned_plan)
            or batch_plan_sha256 != batch_plan.get("batch_plan_sha256")
            or batch_plan.get("synthesis_contract") != contract
            or batch_plan.get("schema")
            != "goldflow_qwen_liam_batch_plan_v1"
        ):
            raise ValueError("Batch-four plan hash or contract is stale")
        original_ids = [
            str(unit_id)
            for unit_id in batch_plan.get("original_order_unit_ids") or []
        ]
        requested_ids = [str(job["unit_id"]) for job in jobs]
        if (
            mode == BATCH4_SYNTHESIS_MODE
            and original_ids != requested_ids
        ):
            raise ValueError(
                "Batch-four jobs are not in the exact original narration order"
            )
        if (
            mode == EXACT_UNIT_RECOVERY_MODE
            and (
                len(set(requested_ids)) != len(requested_ids)
                or any(unit_id not in original_ids for unit_id in requested_ids)
                or requested_ids
                != sorted(requested_ids, key=original_ids.index)
            )
        ):
            raise ValueError(
                "Exact-unit recovery jobs are not a unique source-ordered "
                "subset of the original batch plan"
            )
        cohorts = batch_plan.get("cohorts")
        if not isinstance(cohorts, list) or not cohorts:
            raise ValueError("Batch-four plan has no cohorts")
        if (
            int(batch_plan.get("unit_count", -1)) != len(original_ids)
            or int(batch_plan.get("cohort_count", -1)) != len(cohorts)
        ):
            raise ValueError("Batch-four plan counts are stale")
        synthesized_ids: list[str] = []
        synthesized_members: list[dict[str, Any]] = []
        jobs_by_id = {str(job["unit_id"]): job for job in jobs}
        for cohort_index, cohort in enumerate(cohorts):
            members = cohort.get("members")
            if not isinstance(members, list) or not members:
                raise ValueError(f"Batch cohort {cohort_index} has no members")
            effective_size = len(members)
            if (
                int(cohort.get("cohort_index", -1)) != cohort_index
                or int(cohort.get("nominal_batch_size", 0)) != 4
                or int(cohort.get("effective_batch_size", 0))
                != effective_size
                or (cohort_index < len(cohorts) - 1 and effective_size != 4)
                or effective_size > 4
                or cohort.get("schema")
                != "goldflow_qwen_liam_synthesis_cohort_v1"
                or cohort.get("synthesis_contract_id")
                != contract["contract_id"]
                or cohort.get("synthesis_mode") != BATCH4_SYNTHESIS_MODE
                or cohort.get("scheduler_version")
                != contract["scheduler_version"]
            ):
                raise ValueError(
                    f"Batch cohort {cohort_index} size/order contract is stale"
                )
            cohort_identity = {
                key: cohort.get(key)
                for key in (
                    "schema",
                    "synthesis_contract_id",
                    "synthesis_mode",
                    "scheduler_version",
                    "nominal_batch_size",
                    "effective_batch_size",
                    "cohort_index",
                    "members",
                )
            }
            expected_cohort_sha256 = canonical_sha256(cohort_identity)
            if (
                cohort.get("cohort_sha256") != expected_cohort_sha256
                or cohort.get("cohort_id")
                != (
                    f"qwen-cohort-{cohort_index + 1:04d}-"
                    f"{expected_cohort_sha256[:12]}"
                )
                or int(cohort.get("batch_seed", -1))
                != int(expected_cohort_sha256[:8], 16)
            ):
                raise ValueError(
                    f"Batch cohort {cohort_index} hash/seed is stale"
                )
            for position, member in enumerate(members):
                if int(member.get("cohort_position", -1)) != position:
                    raise ValueError(
                        f"Batch cohort {cohort_index} member order is stale"
                    )
                member_id = str(member.get("unit_id") or "")
                job = jobs_by_id.get(member_id)
                if job is None and mode == BATCH4_SYNTHESIS_MODE:
                    raise ValueError(
                        f"Batch cohort {cohort_index} member identity is "
                        f"stale for {member_id!r}"
                    )
                if job is not None and (
                    member.get("spoken_text_sha256")
                    != job.get("spoken_text_sha256")
                    or int(member.get("original_order_index", -1))
                    != int(job.get("original_order_index", -2))
                    or int(member.get("spoken_word_count", -1))
                    != int(job.get("spoken_word_count", -2))
                    or int(member.get("spoken_text_utf8_bytes", -1))
                    != int(job.get("spoken_text_utf8_bytes", -2))
                ):
                    raise ValueError(
                        f"Batch cohort {cohort_index} member identity is "
                        f"stale for {member_id!r}"
                    )
                if job is not None:
                    expected_binding = {
                        "synthesis_contract_id": contract["contract_id"],
                        "synthesis_mode": BATCH4_SYNTHESIS_MODE,
                        "batch_plan_sha256": batch_plan_sha256,
                        "cohort_id": cohort["cohort_id"],
                        "cohort_index": cohort_index,
                        "cohort_sha256": cohort["cohort_sha256"],
                        "cohort_position": position,
                        "nominal_batch_size": 4,
                        "effective_batch_size": effective_size,
                        "batch_seed": cohort["batch_seed"],
                    }
                    if job.get("synthesis_cohort") != expected_binding:
                        raise ValueError(
                            f"Batch cohort binding is stale for {member_id!r}"
                        )
                synthesized_ids.append(member_id)
                synthesized_members.append(member)
        original_order_indexes = [
            int(member["original_order_index"])
            for member in synthesized_members
        ]
        if (
            any(not unit_id for unit_id in synthesized_ids)
            or len(set(synthesized_ids)) != len(synthesized_ids)
            or len(set(original_order_indexes))
            != len(original_order_indexes)
        ):
            raise ValueError(
                "Batch-four plan contains missing/duplicate unit order identity"
            )
        expected_original_members = sorted(
            synthesized_members,
            key=lambda member: (
                int(member["original_order_index"]),
                str(member["unit_id"]),
            ),
        )
        expected_original_ids = [
            str(member["unit_id"]) for member in expected_original_members
        ]
        original_order_binding = [
            {
                "unit_id": str(member["unit_id"]),
                "original_order_index": int(
                    member["original_order_index"]
                ),
                "spoken_text_sha256": member["spoken_text_sha256"],
            }
            for member in expected_original_members
        ]
        expected_synthesis_ids = [
            str(member["unit_id"])
            for member in sorted(
                synthesized_members,
                key=lambda member: (
                    int(member["spoken_word_count"]),
                    int(member["spoken_text_utf8_bytes"]),
                    int(member["original_order_index"]),
                    str(member["unit_id"]),
                ),
            )
        ]
        if (
            original_ids != expected_original_ids
            or batch_plan.get("original_order_sha256")
            != canonical_sha256(original_order_binding)
            or synthesized_ids != expected_synthesis_ids
            or synthesized_ids
            != [
                str(unit_id)
                for unit_id
                in batch_plan.get("synthesis_order_unit_ids") or []
            ]
            or sorted(synthesized_ids) != sorted(original_ids)
        ):
            raise ValueError("Batch-four plan unit coverage is stale")
    elif batch_plan is not None:
        raise ValueError(
            f"Synthesis mode {mode!r} must not carry a batch execution plan"
        )

    if mode == EXACT_UNIT_RECOVERY_MODE:
        for job in jobs:
            provenance = job.get("recovery_provenance")
            cohort = job.get("synthesis_cohort")
            planned_cohort = next(
                (
                    row
                    for row in (batch_plan or {}).get("cohorts") or []
                    if row.get("cohort_sha256")
                    == (cohort or {}).get("cohort_sha256")
                ),
                None,
            )
            planned_member = next(
                (
                    row
                    for row in (planned_cohort or {}).get("members") or []
                    if str(row.get("unit_id") or "")
                    == str(job["unit_id"])
                ),
                None,
            )
            if (
                not isinstance(provenance, dict)
                or not isinstance(cohort, dict)
                or planned_cohort is None
                or planned_member is None
                or int(planned_member.get("cohort_position", -1))
                != int(cohort.get("cohort_position", -2))
                or provenance.get("batch_plan_sha256") != batch_plan_sha256
                or provenance.get("schema")
                != "goldflow_qwen_exact_unit_recovery_provenance_v1"
                or provenance.get("recovery_mode")
                != EXACT_UNIT_RECOVERY_MODE
                or provenance.get("unit_id") != str(job["unit_id"])
                or provenance.get("spoken_text_sha256")
                != job.get("spoken_text_sha256")
                or provenance.get("origin_cohort_id")
                != planned_cohort.get("cohort_id")
                or provenance.get("origin_cohort_sha256")
                != cohort.get("cohort_sha256")
                or not provenance.get("origin_synthesis_identity_sha256")
                or not provenance.get("origin_runner_report_sha256")
                or not provenance.get("trigger_evidence_sha256")
                or not provenance.get("trigger_codes")
            ):
                raise ValueError(
                    f"Exact-unit recovery provenance is incomplete for "
                    f"{job['unit_id']}"
                )
    return mode, contract, batch_plan


def resolve_qwen_reference_contract(
    jobs_manifest: dict[str, Any],
) -> dict[str, Any]:
    contract_name = str(
        jobs_manifest.get("qwen_voice_continuity_contract") or ""
    ).strip()
    contract = QWEN_REFERENCE_CONTRACTS.get(contract_name)
    if contract is None:
        raise ValueError(
            "Unapproved Qwen voice continuity contract: "
            f"{contract_name!r}; expected one of "
            f"{sorted(QWEN_REFERENCE_CONTRACTS)}"
        )
    if (
        jobs_manifest.get("qwen_reference_voice_id") != contract["voice_id"]
        or jobs_manifest.get("qwen_reference_voice_sha256")
        != contract["voice_sha256"]
    ):
        raise ValueError(
            "Qwen reference voice identity does not match the selected "
            f"{contract['contract_id']} contract"
        )
    if (
        contract is QWEN_LIAM_REFERENCE
        and jobs_manifest.get("qwen_reference_manifest_sha256")
        != contract["manifest_sha256"]
    ):
        raise ValueError(
            "Qwen Liam primary jobs must carry the pinned reference "
            "manifest hash"
        )
    return contract


def validate_qwen_output_conditioning(jobs_manifest: dict[str, Any]) -> None:
    if jobs_manifest.get("qwen_post_tts_tempo_processing") not in (None, False):
        raise ValueError(
            "Qwen production synthesis forbids post-TTS tempo processing"
        )
    if jobs_manifest.get("post_tts_tempo_processing") not in (None, False):
        raise ValueError(
            "Qwen production synthesis forbids post-TTS tempo processing"
        )
    requested_speed = jobs_manifest.get("qwen_native_speed")
    if requested_speed is not None and float(requested_speed) != 1.0:
        raise ValueError(
            "Qwen Base does not expose a supported native speed control"
        )


def synthesis_identity(
    route: str,
    pin: dict[str, Any],
    job: dict[str, Any],
    reference_audio: Path | None,
    reference_text: str | None,
    kokoro_voice_id: str | None,
    qwen_reference_contract: dict[str, Any] | None,
    jobs_manifest: dict[str, Any] | None = None,
    synthesis_mode: str = SERIAL_SYNTHESIS_MODE,
    synthesis_contract: dict[str, Any] | None = None,
    batch_plan: dict[str, Any] | None = None,
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
            raise ValueError("Qwen production requires reference audio and exact text")
        if qwen_reference_contract is None:
            raise ValueError("Qwen production requires a pinned voice contract")
        generation_parameters = qwen_reference_contract[
            "generation_parameters"
        ]
        value.update(
            {
                "voice": qwen_reference_contract["voice_id"],
                "voice_sha256": qwen_reference_contract["voice_sha256"],
                "voice_clone_contract": qwen_reference_contract[
                    "voice_clone_contract"
                ],
                "voice_contract_id": qwen_reference_contract["contract_id"],
                "voice_continuity_contract": qwen_reference_contract[
                    "voice_continuity_contract"
                ],
                "legacy_voice_contract": qwen_reference_contract[
                    "legacy_compatibility"
                ],
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
                "reference_voice_id": qwen_reference_contract["voice_id"],
                "reference_voice_sha256": qwen_reference_contract[
                    "voice_sha256"
                ],
                "reference_source_provider": qwen_reference_contract[
                    "source_provider"
                ],
                "reference_source_model_id": qwen_reference_contract[
                    "source_model_id"
                ],
                "reference_source_model_revision": qwen_reference_contract[
                    "source_model_revision"
                ],
                "reference_source_unit_id": qwen_reference_contract[
                    "source_unit_id"
                ],
                "reference_manifest_path": qwen_reference_contract.get(
                    "manifest_path"
                ),
                "reference_manifest_sha256": qwen_reference_contract.get(
                    "manifest_sha256"
                ),
                "reference_metadata_path": qwen_reference_contract.get(
                    "metadata_path"
                ),
                "reference_metadata_sha256": qwen_reference_contract.get(
                    "metadata_sha256"
                ),
                "delivery_control": "base_icl_reference_audio_only",
                "native_speed_supported": False,
                "native_speed_applied": None,
                "post_tts_tempo_processing": False,
                **generation_parameters,
            }
        )
        if (
            jobs_manifest
            and jobs_manifest.get("schema") == "goldflow_narration_tts_jobs_v2"
        ):
            contract = synthesis_contract or SERIAL_SYNTHESIS_CONTRACT
            value["schema"] = "goldflow_local_tts_synthesis_identity_v2"
            value.update(
                {
                    "synthesis_contract_id": contract["contract_id"],
                    "synthesis_mode": synthesis_mode,
                    "synthesis_api": (
                        "Model.batch_generate"
                        if synthesis_mode == BATCH4_SYNTHESIS_MODE
                        else "Model.generate"
                    ),
                    "batch_plan_sha256": jobs_manifest[
                        "batch_plan_sha256"
                    ],
                    "model_instance_count": 1,
                    "model_concurrency": 1,
                    "continuous_batching": False,
                    "token_limit_acceptance_allowed": False,
                }
            )
            cohort_binding = job.get("synthesis_cohort")
            if not isinstance(cohort_binding, dict):
                raise ValueError(
                    f"Missing synthesis cohort binding for {job['unit_id']}"
                )
            if synthesis_mode == BATCH4_SYNTHESIS_MODE:
                cohort = next(
                    (
                        row
                        for row in (batch_plan or {}).get("cohorts") or []
                        if row.get("cohort_sha256")
                        == cohort_binding.get("cohort_sha256")
                    ),
                    None,
                )
                if cohort is None:
                    raise ValueError(
                        f"Unknown batch cohort for {job['unit_id']}"
                    )
                value.update(
                    {
                        **cohort_binding,
                        "cohort_members": cohort["members"],
                        "per_unit_serial_seed": int(job["seed"]),
                        "seed": int(cohort["batch_seed"]),
                        "per_unit_seed_preserved": False,
                    }
                )
            elif synthesis_mode == EXACT_UNIT_RECOVERY_MODE:
                origin_cohort = next(
                    (
                        row
                        for row in (batch_plan or {}).get("cohorts") or []
                        if row.get("cohort_sha256")
                        == cohort_binding.get("cohort_sha256")
                    ),
                    None,
                )
                if origin_cohort is None:
                    raise ValueError(
                        f"Unknown recovery origin cohort for {job['unit_id']}"
                    )
                value.update(
                    {
                        "recovery_provenance":
                            job.get("recovery_provenance"),
                        "origin_cohort_members":
                            origin_cohort["members"],
                        "per_unit_serial_seed": int(job["seed"]),
                        "per_unit_seed_preserved": True,
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
    qwen_reference_contract: dict[str, Any] | None,
) -> tuple[np.ndarray, int, list[Any], int]:
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
        if qwen_reference_contract is None:
            raise ValueError("Qwen production requires a pinned voice contract")
        generate_kwargs = {
            "text": job["spoken_text"],
            "ref_audio": str(reference_audio),
            "ref_text": reference_text,
            **qwen_reference_contract["generation_parameters"],
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
    generated_token_count = sum(
        int(getattr(result, "token_count", 0) or 0)
        for result in generated
    )
    return output, sample_rates.pop(), generated, generated_token_count


def collect_batch_audio(
    generated: list[Any],
    expected_count: int,
) -> dict[int, tuple[np.ndarray, int, int]]:
    output: dict[int, tuple[np.ndarray, int, int]] = {}
    for result in generated:
        sequence_index = int(result.sequence_idx)
        if sequence_index in output:
            raise RuntimeError(
                f"Duplicate Qwen batch sequence index {sequence_index}"
            )
        mx.eval(result.audio)
        audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
        if not audio.size or not np.isfinite(audio).all():
            raise RuntimeError(
                f"Qwen batch sequence {sequence_index} returned invalid audio"
            )
        output[sequence_index] = (
            audio,
            int(result.sample_rate),
            int(result.token_count),
        )
    if sorted(output) != list(range(expected_count)):
        raise RuntimeError(
            "Qwen batch output indexes do not match request: "
            f"{sorted(output)} vs {list(range(expected_count))}"
        )
    return output


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
    synthesis_mode = SERIAL_SYNTHESIS_MODE
    synthesis_contract = SERIAL_SYNTHESIS_CONTRACT
    batch_plan: dict[str, Any] | None = None
    if args.route == "qwen":
        (
            synthesis_mode,
            synthesis_contract,
            batch_plan,
        ) = validate_qwen_synthesis_manifest(jobs_manifest, jobs)
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
    qwen_reference_contract: dict[str, Any] | None = None
    if args.route == "qwen":
        validate_qwen_output_conditioning(jobs_manifest)
        qwen_reference_contract = resolve_qwen_reference_contract(
            jobs_manifest
        )
        if reference_audio is None or not reference_audio.is_file():
            raise FileNotFoundError("Missing pinned Qwen production reference audio")
        expected_reference_sha256 = jobs_manifest.get("qwen_reference_audio_sha256")
        if (
            not expected_reference_sha256
            or sha256_file(reference_audio) != expected_reference_sha256
        ):
            raise ValueError("Qwen production reference audio hash mismatch")
        if (
            not reference_text
            or reference_text != jobs_manifest.get("qwen_reference_text")
        ):
            raise ValueError("Qwen production reference text mismatch")
        if (
            str(reference_audio) != qwen_reference_contract["audio_path"]
            or sha256_file(reference_audio)
            != qwen_reference_contract["audio_sha256"]
            or reference_text != qwen_reference_contract["text"]
            or sha256_text(reference_text)
            != qwen_reference_contract["text_sha256"]
        ):
            raise ValueError(
                "Qwen reference does not match the selected pinned voice "
                f"contract: {qwen_reference_contract['contract_id']}"
            )
        if qwen_reference_contract.get("manifest_path"):
            validate_file(
                Path(qwen_reference_contract["manifest_path"]),
                qwen_reference_contract["manifest_sha256"],
            )
        if qwen_reference_contract.get("metadata_path"):
            validate_file(
                Path(qwen_reference_contract["metadata_path"]),
                qwen_reference_contract["metadata_sha256"],
            )

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
    results_by_id: dict[str, dict[str, Any]] = {}
    cohort_executions: list[dict[str, Any]] = []

    def output_spec(
        job: dict[str, Any],
        identity: dict[str, Any],
    ) -> tuple[str, Path, Path]:
        identity_sha256 = canonical_sha256(identity)
        safe_unit_id = re.sub(
            r"[^A-Za-z0-9._-]+",
            "-",
            job["unit_id"],
        ).strip("-")
        if not safe_unit_id:
            safe_unit_id = f"unit-{sha256_text(job['unit_id'])[:12]}"
        stem = f"{safe_unit_id[:96]}-{identity_sha256}"
        return (
            identity_sha256,
            output_dir / f"{stem}.wav",
            output_dir / f"{stem}.json",
        )

    def exact_cached_row(
        output_path: Path,
        sidecar_path: Path,
        identity_sha256: str,
        *,
        require_token_evidence: bool,
    ) -> dict[str, Any] | None:
        if not args.resume or not output_path.is_file() or not sidecar_path.is_file():
            return None
        try:
            previous = json.loads(sidecar_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        generated_tokens = int(previous.get("generated_token_count") or 0)
        token_limit = int(previous.get("effective_token_limit") or 0)
        if (
            previous.get("synthesis_identity_sha256") != identity_sha256
            or previous.get("output_sha256") != sha256_file(output_path)
            or (
                require_token_evidence
                and (
                    previous.get("token_limit_reached") is not False
                    or token_limit <= 0
                    or generated_tokens >= token_limit
                )
            )
        ):
            return None
        return {**previous, "status": "reused_exact_hash"}

    def failed_row(
        job: dict[str, Any],
        identity: dict[str, Any] | None,
        identity_sha256: str | None,
        started: float,
        error: Exception,
        **extra: Any,
    ) -> dict[str, Any]:
        return {
            "unit_id": job["unit_id"],
            "provider": pin["provider"],
            "model_id": pin["model_id"],
            "voice_id": (
                kokoro_voice_id
                if args.route == "kokoro"
                else qwen_reference_contract["voice_id"]
            ),
            "status": "failed",
            "attempt": int(job["attempt"]),
            "seed": int(
                identity.get("seed", job["seed"])
                if identity
                else job["seed"]
            ),
            "per_unit_serial_seed": int(job["seed"]),
            "spoken_text_sha256": job["spoken_text_sha256"],
            "synthesis_identity": identity,
            "synthesis_identity_sha256": identity_sha256,
            "generation_time_sec": round(
                time.perf_counter() - started,
                6,
            ),
            "error_type": type(error).__name__,
            "error": str(error),
            **extra,
        }

    if args.route == "qwen" and synthesis_mode == BATCH4_SYNTHESIS_MODE:
        if not hasattr(model, "batch_generate"):
            raise RuntimeError("Pinned Qwen runtime has no batch_generate API")
        if not model.supports_tts_batch(
            ref_audio=str(reference_audio),
            ref_text=reference_text,
            speed=1.0,
            pitch=1.0,
            stream=False,
        ):
            raise RuntimeError("Pinned Qwen runtime rejects fixed-batch Liam ICL")
        if model.supports_tts_continuous_batch(
            ref_audio=str(reference_audio),
            ref_text=reference_text,
        ):
            raise RuntimeError(
                "Production contract requires continuous ICL batching to remain disabled"
            )
        reference_array = load_audio(
            str(reference_audio),
            sample_rate=int(model.sample_rate),
        )
        mx.eval(reference_array)
        jobs_by_id = {str(job["unit_id"]): job for job in jobs}
        for cohort in batch_plan["cohorts"]:
            cohort_started = time.perf_counter()
            cohort_jobs = [
                jobs_by_id[str(member["unit_id"])]
                for member in cohort["members"]
            ]
            specs: list[
                tuple[
                    dict[str, Any],
                    dict[str, Any],
                    str,
                    Path,
                    Path,
                    dict[str, Any] | None,
                ]
            ] = []
            for job in cohort_jobs:
                identity = synthesis_identity(
                    args.route,
                    pin,
                    job,
                    reference_audio,
                    reference_text,
                    kokoro_voice_id,
                    qwen_reference_contract,
                    jobs_manifest,
                    synthesis_mode,
                    synthesis_contract,
                    batch_plan,
                )
                identity_sha256, output_path, sidecar_path = output_spec(
                    job,
                    identity,
                )
                cached = exact_cached_row(
                    output_path,
                    sidecar_path,
                    identity_sha256,
                    require_token_evidence=True,
                )
                specs.append(
                    (
                        job,
                        identity,
                        identity_sha256,
                        output_path,
                        sidecar_path,
                        cached,
                    )
                )
            if all(spec[-1] is not None for spec in specs):
                for job, _identity, _identity_hash, _output, _sidecar, cached in specs:
                    results_by_id[str(job["unit_id"])] = cached
                cohort_executions.append(
                    {
                        "cohort_id": cohort["cohort_id"],
                        "cohort_sha256": cohort["cohort_sha256"],
                        "cohort_index": cohort["cohort_index"],
                        "nominal_batch_size": 4,
                        "effective_batch_size": len(cohort_jobs),
                        "batch_seed": cohort["batch_seed"],
                        "unit_ids": [
                            str(job["unit_id"]) for job in cohort_jobs
                        ],
                        "status": "reused_exact_cohort_hashes",
                        "model_call_performed": False,
                        "wall_sec": round(
                            time.perf_counter() - cohort_started,
                            6,
                        ),
                    }
                )
                continue
            try:
                mx.random.seed(int(cohort["batch_seed"]))
                generated = list(
                    model.batch_generate(
                        texts=[job["spoken_text"] for job in cohort_jobs],
                        voices=[None] * len(cohort_jobs),
                        instructs=[None] * len(cohort_jobs),
                        ref_audio=reference_array,
                        ref_text=reference_text,
                        temperature=float(
                            qwen_reference_contract[
                                "generation_parameters"
                            ]["temperature"]
                        ),
                        top_p=float(
                            qwen_reference_contract[
                                "generation_parameters"
                            ]["top_p"]
                        ),
                        top_k=int(
                            qwen_reference_contract[
                                "generation_parameters"
                            ]["top_k"]
                        ),
                        repetition_penalty=float(
                            qwen_reference_contract[
                                "generation_parameters"
                            ]["repetition_penalty"]
                        ),
                        max_tokens=int(
                            qwen_reference_contract[
                                "generation_parameters"
                            ]["max_tokens"]
                        ),
                        verbose=False,
                        stream=False,
                    )
                )
                collected = collect_batch_audio(
                    generated,
                    len(cohort_jobs),
                )
                staged: list[
                    tuple[
                        dict[str, Any],
                        dict[str, Any],
                        str,
                        Path,
                        Path,
                        dict[str, Any] | None,
                        np.ndarray,
                        int,
                        int,
                        int,
                        bool,
                        Path | None,
                        str | None,
                    ]
                ] = []
                nondeterministic = False
                for position, spec in enumerate(specs):
                    (
                        job,
                        identity,
                        identity_sha256,
                        output_path,
                        sidecar_path,
                        cached,
                    ) = spec
                    audio, sample_rate, generated_tokens = collected[position]
                    if sample_rate != 24000:
                        raise RuntimeError(
                            f"Refusing {job['unit_id']}: "
                            f"expected native 24000 Hz, got {sample_rate}"
                        )
                    tokenizer_tokens = len(
                        model.tokenizer.encode(job["spoken_text"])
                    )
                    effective_token_limit = min(
                        int(
                            qwen_reference_contract[
                                "generation_parameters"
                            ]["max_tokens"]
                        ),
                        max(75, tokenizer_tokens * 6),
                    )
                    token_limit_reached = (
                        generated_tokens >= effective_token_limit
                    )
                    temporary_wav: Path | None = None
                    temporary_sha256: str | None = None
                    if not token_limit_reached:
                        temporary_wav = output_path.with_name(
                            f".{output_path.stem}.tmp-{os.getpid()}-"
                            f"{cohort['cohort_index']}-{position}.wav"
                        )
                        audio_write(
                            str(temporary_wav),
                            audio,
                            sample_rate,
                            format="wav",
                        )
                        temporary_sha256 = sha256_file(temporary_wav)
                        if (
                            cached
                            and temporary_sha256
                            != cached.get("output_sha256")
                        ):
                            nondeterministic = True
                    staged.append(
                        (
                            job,
                            identity,
                            identity_sha256,
                            output_path,
                            sidecar_path,
                            cached,
                            audio,
                            sample_rate,
                            generated_tokens,
                            effective_token_limit,
                            token_limit_reached,
                            temporary_wav,
                            temporary_sha256,
                        )
                    )
                if nondeterministic:
                    for staged_row in staged:
                        temporary_wav = staged_row[-2]
                        if temporary_wav and temporary_wav.exists():
                            temporary_wav.unlink()
                    raise RuntimeError(
                        "Qwen batch rerun differed from an exact cohort-bound "
                        "cached waveform; refusing to overwrite accepted cache"
                    )
                for staged_row in staged:
                    (
                        job,
                        identity,
                        identity_sha256,
                        output_path,
                        sidecar_path,
                        cached,
                        audio,
                        sample_rate,
                        generated_tokens,
                        effective_token_limit,
                        token_limit_reached,
                        temporary_wav,
                        temporary_sha256,
                    ) = staged_row
                    if token_limit_reached:
                        results_by_id[str(job["unit_id"])] = failed_row(
                            job,
                            identity,
                            identity_sha256,
                            cohort_started,
                            RuntimeError(
                                "Qwen batch sequence reached its effective "
                                "generation token limit"
                            ),
                            error_code="tts_batch_token_limit_reached",
                            generated_token_count=generated_tokens,
                            effective_token_limit=effective_token_limit,
                            token_limit_reached=True,
                        )
                        continue
                    if cached:
                        if temporary_wav and temporary_wav.exists():
                            temporary_wav.unlink()
                        results_by_id[str(job["unit_id"])] = cached
                        continue
                    os.replace(temporary_wav, output_path)
                    duration_sec = audio.size / sample_rate
                    elapsed = time.perf_counter() - cohort_started
                    row = {
                        "unit_id": job["unit_id"],
                        "provider": pin["provider"],
                        "model_id": pin["model_id"],
                        "voice_id": qwen_reference_contract["voice_id"],
                        "status": "generated",
                        "attempt": int(job["attempt"]),
                        "seed": int(cohort["batch_seed"]),
                        "per_unit_serial_seed": int(job["seed"]),
                        "spoken_text": job["spoken_text"],
                        "spoken_text_sha256": job["spoken_text_sha256"],
                        "output_path": str(output_path),
                        "output_sha256": temporary_sha256,
                        "sample_rate_hz": sample_rate,
                        "sample_count": int(audio.size),
                        "duration_sec": round(duration_sec, 6),
                        "generation_time_sec": round(elapsed, 6),
                        "generation_rtf": round(
                            elapsed / duration_sec,
                            6,
                        ),
                        "result_chunk_count": 1,
                        "generated_token_count": generated_tokens,
                        "effective_token_limit": effective_token_limit,
                        "token_limit_reached": False,
                        "synthesis_mode": synthesis_mode,
                        "batch_plan_sha256":
                            jobs_manifest["batch_plan_sha256"],
                        "cohort_id": cohort["cohort_id"],
                        "cohort_sha256": cohort["cohort_sha256"],
                        "synthesis_identity": identity,
                        "synthesis_identity_sha256": identity_sha256,
                        "sidecar_path": str(sidecar_path),
                    }
                    atomic_json(sidecar_path, row)
                    results_by_id[str(job["unit_id"])] = row
                cohort_executions.append(
                    {
                        "cohort_id": cohort["cohort_id"],
                        "cohort_sha256": cohort["cohort_sha256"],
                        "cohort_index": cohort["cohort_index"],
                        "nominal_batch_size": 4,
                        "effective_batch_size": len(cohort_jobs),
                        "batch_seed": cohort["batch_seed"],
                        "unit_ids": [
                            str(job["unit_id"]) for job in cohort_jobs
                        ],
                        "status": (
                            "completed_with_token_limit_failure"
                            if any(row[10] for row in staged)
                            else "generated"
                        ),
                        "model_call_performed": True,
                        "wall_sec": round(
                            time.perf_counter() - cohort_started,
                            6,
                        ),
                    }
                )
            except Exception as error:
                for spec in specs:
                    (
                        job,
                        identity,
                        identity_sha256,
                        _output_path,
                        _sidecar_path,
                        _cached,
                    ) = spec
                    if str(job["unit_id"]) not in results_by_id:
                        results_by_id[str(job["unit_id"])] = failed_row(
                            job,
                            identity,
                            identity_sha256,
                            cohort_started,
                            error,
                            error_code=(
                                "tts_batch_cache_nondeterminism"
                                if "differed from an exact" in str(error)
                                else "tts_batch_synthesis_failed"
                            ),
                        )
                cohort_executions.append(
                    {
                        "cohort_id": cohort["cohort_id"],
                        "cohort_sha256": cohort["cohort_sha256"],
                        "cohort_index": cohort["cohort_index"],
                        "nominal_batch_size": 4,
                        "effective_batch_size": len(cohort_jobs),
                        "batch_seed": cohort["batch_seed"],
                        "unit_ids": [
                            str(job["unit_id"]) for job in cohort_jobs
                        ],
                        "status": "failed",
                        "model_call_performed": True,
                        "error_type": type(error).__name__,
                        "error": str(error),
                        "wall_sec": round(
                            time.perf_counter() - cohort_started,
                            6,
                        ),
                    }
                )
    else:
        for job in jobs:
            started = time.perf_counter()
            identity: dict[str, Any] | None = None
            identity_sha256: str | None = None
            generated_token_count: int | None = None
            effective_token_limit: int | None = None
            try:
                identity = synthesis_identity(
                    args.route,
                    pin,
                    job,
                    reference_audio,
                    reference_text,
                    kokoro_voice_id,
                    qwen_reference_contract,
                    jobs_manifest,
                    synthesis_mode,
                    synthesis_contract,
                    batch_plan,
                )
                (
                    identity_sha256,
                    output_path,
                    sidecar_path,
                ) = output_spec(job, identity)
                require_token_evidence = (
                    synthesis_mode == EXACT_UNIT_RECOVERY_MODE
                )
                cached = exact_cached_row(
                    output_path,
                    sidecar_path,
                    identity_sha256,
                    require_token_evidence=require_token_evidence,
                )
                if cached:
                    results_by_id[str(job["unit_id"])] = cached
                    continue

                (
                    audio,
                    sample_rate,
                    chunks,
                    generated_token_count,
                ) = generate_audio(
                    model,
                    args.route,
                    job,
                    reference_audio,
                    reference_text,
                    kokoro_voice_id,
                    qwen_reference_contract,
                )
                if sample_rate != 24000:
                    raise RuntimeError(
                        f"Refusing {job['unit_id']}: "
                        f"expected native 24000 Hz, got {sample_rate}"
                    )
                effective_token_limit = (
                    int(
                        qwen_reference_contract[
                            "generation_parameters"
                        ]["max_tokens"]
                    )
                    if args.route == "qwen"
                    else 0
                )
                token_limit_reached = bool(
                    args.route == "qwen"
                    and generated_token_count >= effective_token_limit
                )
                if token_limit_reached:
                    raise RuntimeError(
                        "Qwen serial sequence reached its generation token limit"
                    )
                temporary_wav = output_path.with_name(
                    f".{output_path.stem}.tmp-{os.getpid()}.wav"
                )
                audio_write(
                    str(temporary_wav),
                    audio,
                    sample_rate,
                    format="wav",
                )
                os.replace(temporary_wav, output_path)
                elapsed = time.perf_counter() - started
                duration_sec = audio.size / sample_rate
                row = {
                    "unit_id": job["unit_id"],
                    "provider": pin["provider"],
                    "model_id": pin["model_id"],
                    "voice_id": (
                        kokoro_voice_id
                        if args.route == "kokoro"
                        else qwen_reference_contract["voice_id"]
                    ),
                    "status": "generated",
                    "attempt": int(job["attempt"]),
                    "seed": int(job["seed"]),
                    "per_unit_serial_seed": int(job["seed"]),
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
                    "generated_token_count": generated_token_count,
                    "effective_token_limit": effective_token_limit,
                    "token_limit_reached": False,
                    "synthesis_mode": synthesis_mode,
                    "batch_plan_sha256":
                        jobs_manifest.get("batch_plan_sha256"),
                    "recovery_provenance":
                        job.get("recovery_provenance"),
                    "synthesis_identity": identity,
                    "synthesis_identity_sha256": identity_sha256,
                    "sidecar_path": str(sidecar_path),
                }
                atomic_json(sidecar_path, row)
                results_by_id[str(job["unit_id"])] = row
            except Exception as error:
                results_by_id[str(job["unit_id"])] = failed_row(
                    job,
                    identity,
                    identity_sha256,
                    started,
                    error,
                    error_code=(
                        "tts_serial_token_limit_reached"
                        if "token limit" in str(error)
                        else "tts_serial_synthesis_failed"
                    ),
                    generated_token_count=(
                        generated_token_count
                    ),
                    effective_token_limit=(
                        effective_token_limit
                    ),
                    token_limit_reached="token limit" in str(error),
                )

    results = [
        results_by_id[str(job["unit_id"])]
        for job in jobs
    ]

    failure_count = sum(row["status"] == "failed" for row in results)
    report_status = "passed" if failure_count == 0 else "completed_with_job_failures"
    report = {
        "schema": (
            "goldflow_local_tts_production_run_v2"
            if jobs_manifest.get("schema")
            == "goldflow_narration_tts_jobs_v2"
            else "goldflow_local_tts_production_run_v1"
        ),
        "status": report_status,
        "route": args.route,
        "synthesis_contract": (
            synthesis_contract if args.route == "qwen" else None
        ),
        "synthesis_mode": (
            synthesis_mode if args.route == "qwen" else SERIAL_SYNTHESIS_MODE
        ),
        "batch_plan_sha256": jobs_manifest.get("batch_plan_sha256"),
        "cohort_executions": cohort_executions,
        "results_restored_to_original_order": True,
        "original_order_unit_ids": [
            str(job["unit_id"]) for job in jobs
        ],
        "provider": pin["provider"],
        "model_id": pin["model_id"],
        "model_source": pin["source"],
        "model_revision": pin["revision"],
        "voice_id": (
            kokoro_voice_id
            if args.route == "kokoro"
            else qwen_reference_contract["voice_id"]
        ),
        "voice_sha256": (
            KOKORO_VOICES[kokoro_voice_id]
            if args.route == "kokoro"
            else qwen_reference_contract["voice_sha256"]
        ),
        "voice_clone_contract": (
            None
            if args.route == "kokoro"
            else qwen_reference_contract["voice_clone_contract"]
        ),
        "voice_contract_id": (
            None
            if args.route == "kokoro"
            else qwen_reference_contract["contract_id"]
        ),
        "voice_continuity_contract": (
            None
            if args.route == "kokoro"
            else qwen_reference_contract["voice_continuity_contract"]
        ),
        "legacy_voice_contract": (
            False
            if args.route == "kokoro"
            else qwen_reference_contract["legacy_compatibility"]
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
            qwen_reference_contract["voice_id"]
            if args.route == "qwen"
            else None
        ),
        "reference_voice_sha256": (
            qwen_reference_contract["voice_sha256"]
            if args.route == "qwen"
            else None
        ),
        "reference_manifest_path": (
            qwen_reference_contract.get("manifest_path")
            if args.route == "qwen"
            else None
        ),
        "reference_manifest_sha256": (
            qwen_reference_contract.get("manifest_sha256")
            if args.route == "qwen"
            else None
        ),
        "reference_metadata_path": (
            qwen_reference_contract.get("metadata_path")
            if args.route == "qwen"
            else None
        ),
        "reference_metadata_sha256": (
            qwen_reference_contract.get("metadata_sha256")
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
        "model_load_policy": (
            "once_per_resident_fixed_batch_invocation"
            if synthesis_mode == BATCH4_SYNTHESIS_MODE
            else "once_per_serial_invocation"
        ),
        "resident_model_count": 1,
        "model_instance_concurrency": 1,
        "continuous_batching": False,
        "reference_audio_preloaded_once": (
            synthesis_mode == BATCH4_SYNTHESIS_MODE
        ),
        "token_limit_acceptance_allowed": False,
        "accepted_token_limit_result_count": sum(
            row.get("status") != "failed"
            and row.get("token_limit_reached") is True
            for row in results
        ),
        "delivery_control": (
            "kokoro_voice_speed_and_authored_prosody"
            if args.route == "kokoro"
            else "base_icl_reference_audio_only"
        ),
        "generation_parameters": (
            qwen_reference_contract["generation_parameters"]
            if args.route == "qwen"
            else None
        ),
        "output_conditioning": {
            "native_speed_supported": args.route == "kokoro",
            "native_speed_applied": (
                KOKORO["native_speed"] if args.route == "kokoro" else None
            ),
            "post_tts_tempo_processing": False,
            "loudness_normalization": False,
            "trimming": False,
            "fading": False,
            "declicking": False,
            "resampling": False,
        },
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
