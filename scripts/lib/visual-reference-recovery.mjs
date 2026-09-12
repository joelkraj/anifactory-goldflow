const REPAIR_FLAGS = ["repair-global", "repair-chunk-ids", "repair-scene-ids"];
const isHash = value => /^[a-f0-9]{64}$/.test(String(value ?? ""));

// Status emits this deliberately simple tuple command. Parse its literal scalar
// flags, never execute it or infer a replacement for an unsupported shape.
function emittedFlags(command) {
  if (typeof command !== "string"
    || !/^node bin\/goldflow\.mjs visual refs(?: --[a-z][a-z0-9-]* [A-Za-z0-9_.,:/+-]+)+$/.test(command)) return null;
  const parts = command.split(" ").slice(4);
  const flags = Object.create(null);
  for (let index = 0; index < parts.length; index += 2) {
    const key = parts[index].slice(2);
    if (Object.hasOwn(flags, key)) return null;
    flags[key] = parts[index + 1];
  }
  if (["channel", "series", "week", "episode"].some(key => !flags[key])) return null;
  return flags;
}

export function visualReferenceRecoveryAdmission(status = {}, flags = {}) {
  const requestedRepair = REPAIR_FLAGS.some(key => Object.hasOwn(flags, key));
  if (status.current_stage !== "visual_reference_plan" || status.current_stage_state !== "blocked") {
    return { applicable: requestedRepair, allowed: false, reason: "not_a_current_blocked_visual_reference_recovery" };
  }
  const deny = reason => ({ applicable: true, allowed: false, reason });
  const scope = status.visual_reference_recovery_scope;
  if (scope?.source_hash_current !== true || !isHash(scope.source_script_hash) || !isHash(scope.partial_sha256)) {
    return deny("visual_reference_recovery_source_missing_or_stale");
  }
  const expected = emittedFlags(status.next_command_shape);
  const repairKeys = expected ? REPAIR_FLAGS.filter(key => Object.hasOwn(expected, key)) : [];
  if (!expected || repairKeys.length !== 1) return deny("visual_reference_recovery_command_not_supported");
  const repairKey = repairKeys[0];
  const repairValue = expected[repairKey];
  if (repairKey === "repair-global" ? repairValue !== "true"
    : !/^[A-Za-z0-9_.:-]+(?:,[A-Za-z0-9_.:-]+)*$/.test(repairValue)
      || new Set(repairValue.split(",")).size !== repairValue.split(",").length) {
    return deny("visual_reference_recovery_command_not_supported");
  }
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(flags).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
    || expectedKeys.some(key => flags[key] !== expected[key])) {
    return deny("visual_reference_recovery_flags_must_match_current_command");
  }
  return { applicable: true, allowed: true, reason: "exact_current_visual_reference_recovery_command",
    repair_flag: repairKey, repair_value: repairValue,
    source_script_hash: scope.source_script_hash, partial_sha256: scope.partial_sha256 };
}
