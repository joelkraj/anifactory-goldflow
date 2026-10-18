import path from "node:path";

// A blocked TTS stage is not generally executable. Admit only the recovery
// command that status has named for the exact episode and artifact paths.
export function interruptedQwenGuardAdmission(status, command, subcommand, flags = {}) {
  const adopting = command === "tts" && subcommand === "adopt-interrupted";
  const finalizing = command === "tts" && subcommand === "finalize-interrupted";
  const resuming = command === "tts" && subcommand === "narrate"
    && flags["interrupted-adoption-receipt"] != null;
  if (!adopting && !resuming && !finalizing) return { applicable: false, allowed: false };
  const episodeDir = String(status?.episode_dir ?? "");
  if (status?.current_stage !== "qwen_tts_stitch"
    || status?.current_stage_state !== "blocked"
    || !episodeDir || path.resolve(flags["episode-dir"] ?? "") !== path.resolve(episodeDir)) {
    return { applicable: true, allowed: false, reason: "interrupted Qwen recovery requires its blocked episode" };
  }
  const episode = path.basename(episodeDir);
  if (adopting) {
    const inventory = path.join(episodeDir,
      `narration_interrupted_qwen_triage_inventory_${episode}.json`);
    const expected = `node bin/goldflow.mjs tts adopt-interrupted --episode-dir ${episodeDir} --inventory ${inventory}`;
    const exactFlags = Object.keys(flags).sort().join(",")
      === "adopt-interrupted,episode-dir,inventory"
      && String(flags["adopt-interrupted"]) === "true";
    return { applicable: true,
      allowed: exactFlags
        && path.resolve(flags.inventory ?? "") === inventory
        && status.next_command_shape === expected,
      reason: "status must name the exact episode-local interrupted-Qwen inventory adoption command" };
  }
  const receipt = path.join(episodeDir,
    `narration_interrupted_qwen_adoption_${episode}.json`);
  if (finalizing) {
    const report = path.resolve(flags["completed-runner-report"] ?? "");
    const exactFlags = Object.keys(flags).sort().join(",")
      === "completed-runner-report,episode-dir,finalize-interrupted,interrupted-adoption-receipt"
      && String(flags["finalize-interrupted"]) === "true";
    const expected = `node bin/goldflow.mjs tts finalize-interrupted --episode-dir ${episodeDir} --interrupted-adoption-receipt ${receipt} --completed-runner-report ${report}`;
    return { applicable: true,
      allowed: exactFlags
        && path.resolve(flags["interrupted-adoption-receipt"] ?? "") === receipt
        && status.next_command_shape === expected,
      reason: "status must name the exact no-model completed-runner finalization command" };
  }
  const exactFlags = Object.keys(flags).sort().join(",")
    === "batch-size,concurrency,episode-dir,interrupted-adoption-receipt";
  const expected = `node bin/goldflow.mjs tts narrate --episode-dir ${episodeDir} --concurrency ${flags.concurrency} --batch-size ${flags["batch-size"]} --interrupted-adoption-receipt ${receipt}`;
  return { applicable: true,
    allowed: exactFlags
      && String(flags.concurrency) === "1"
      && Number.isInteger(Number(flags["batch-size"]))
      && Number(flags["batch-size"]) > 0
      && path.resolve(flags["interrupted-adoption-receipt"] ?? "") === receipt
      && status.next_command_shape === expected,
    reason: "status must name the exact receipt-bound interrupted-Qwen serial resume command" };
}
