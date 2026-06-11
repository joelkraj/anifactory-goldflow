#!/usr/bin/env python3
"""Generate one instrumental score bed with local ACE-Step 1.5."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate an ACE-Step score bed.")
    parser.add_argument("--ace-root", default=os.environ.get("ANIFACTORY_ACE_STEP_ROOT", "/Users/joel/AniFactoryTools/ACE-Step-1.5"))
    parser.add_argument("--output", required=True)
    parser.add_argument("--caption", required=True)
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--lyrics", default="")
    parser.add_argument("--language", default="en")
    parser.add_argument("--config-path", default=os.environ.get("ANIFACTORY_ACE_STEP_CONFIG_PATH", "acestep-v15-turbo"))
    parser.add_argument("--lm-model-path", default=os.environ.get("ANIFACTORY_ACE_STEP_LM_MODEL", "acestep-5Hz-lm-1.7B"))
    parser.add_argument("--backend", default=os.environ.get("ANIFACTORY_ACE_STEP_LM_BACKEND", "mlx"))
    parser.add_argument("--device", default=os.environ.get("ANIFACTORY_ACE_STEP_DEVICE", "auto"))
    parser.add_argument("--inference-steps", type=int, default=int(os.environ.get("ANIFACTORY_ACE_STEP_INFERENCE_STEPS", "8")))
    parser.add_argument("--guidance-scale", type=float, default=float(os.environ.get("ANIFACTORY_ACE_STEP_GUIDANCE_SCALE", "1.0")))
    parser.add_argument("--seed", type=int, default=int(os.environ.get("ANIFACTORY_ACE_STEP_SEED", "-1")))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    ace_root = Path(args.ace_root).resolve()
    sys.path.insert(0, str(ace_root))

    # ACE-Step may inherit proxy env from shells; local model loading is more reliable without it.
    for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        os.environ.pop(key, None)

    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationConfig, GenerationParams, generate_music
    from acestep.llm_inference import LLMHandler

    output = Path(args.output).resolve()
    save_dir = output.parent / "_ace_step_tmp" / output.stem
    save_dir.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)

    started = time.time()

    dit_handler = AceStepHandler()
    status_msg, success = dit_handler.initialize_service(
        project_root=str(ace_root),
        config_path=args.config_path,
        device=args.device,
        offload_to_cpu=False,
    )
    if not success:
        raise RuntimeError(f"ACE-Step DiT initialization failed: {status_msg}")

    llm_handler = LLMHandler()
    status_msg, success = llm_handler.initialize(
        checkpoint_dir=str(ace_root / "checkpoints"),
        lm_model_path=args.lm_model_path,
        backend=args.backend,
        device=args.device,
        offload_to_cpu=False,
        dtype=None,
    )
    if not success:
        raise RuntimeError(f"ACE-Step LM initialization failed: {status_msg}")

    params = GenerationParams(
        task_type="text2music",
        thinking=True,
        caption=args.caption,
        lyrics=args.lyrics,
        vocal_language=args.language,
        duration=args.duration,
        inference_steps=args.inference_steps,
        guidance_scale=args.guidance_scale,
        seed=args.seed,
    )
    config = GenerationConfig(batch_size=1, audio_format="wav")
    result = generate_music(dit_handler, llm_handler, params=params, config=config, save_dir=str(save_dir))
    if not result.success:
        raise RuntimeError(f"ACE-Step generation failed: {result.status_message}")

    generated = next((audio.get("path") for audio in result.audios if audio.get("path")), None)
    if not generated:
        raise RuntimeError("ACE-Step generation succeeded but returned no audio path.")
    shutil.copyfile(generated, output)

    print(json.dumps({
        "status": "generated",
        "provider": "local_ace_step",
        "model_id": args.config_path,
        "lm_model_id": args.lm_model_path,
        "backend": args.backend,
        "device": args.device,
        "output": str(output),
        "source_output": generated,
        "duration_sec_requested": args.duration,
        "elapsed_sec": round(time.time() - started, 3),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
