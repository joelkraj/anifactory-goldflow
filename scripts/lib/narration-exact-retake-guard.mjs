// Blocked narration may only synthesize the exact IDs admitted by current
// status. The runner revalidates the receipt and all preserved selections.
export function exactBlockedNarrationRetakeAdmission(status, command, subcommand, flags = {}) {
  if (command !== "tts" || subcommand !== "narrate"
    || status?.current_stage !== "qwen_tts_stitch"
    || status?.current_stage_state !== "blocked") {
    return { applicable: false, allowed: false };
  }
  const keys = Object.keys(flags).sort().join(",");
  const ids = String(flags["confirmed-retry-unit-ids"] ?? "");
  const evidence = String(flags["confirmed-retry-evidence"] ?? "");
  const expected = `node bin/goldflow.mjs tts narrate --episode-dir ${status.episode_dir} --confirmed-retry-unit-ids ${ids} --confirmed-retry-evidence ${evidence}`;
  const allowed = keys === "confirmed-retry-evidence,confirmed-retry-unit-ids,episode-dir"
    && ids.length > 0 && evidence.length > 0
    && flags["episode-dir"] === status.episode_dir
    && status.next_command_shape === expected;
  return { applicable: true, allowed,
    reason: allowed ? null : "Blocked narration permits only the exact current status-directed retake receipt and unit IDs." };
}
