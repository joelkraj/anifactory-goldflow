import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { plannerInvocationScope } from "./planner-rerun-policy.mjs";
import { stageIsSatisfied, workflowStageIds } from "./pipeline-stage-registry.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const isHash = value => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const validIds = values => Array.isArray(values) && new Set(values).size === values.length
  && values.every(id => typeof id === "string" && /^[A-Za-z0-9_.:-]+$/.test(id));
const promptText = row => String(row?.provider_prompt ?? row?.image_prompt ?? row?.modelslab_image_prompt ?? row?.codex_image_prompt ?? "").trim();
const unresolved = row => row?.planner_recovery_required === true || !promptText(row);

// Derive bookkeeping from the complete merged base, not only the latest subset.
// This does not edit or normalize any authored prompt.
export function visualPromptPartialFailure(prompts, metadata = {}) {
  const failed = prompts.filter(unresolved);
  return { ...metadata, failed_cut_ids: failed.map(row => row.image_id),
    failed_beat_ids: failed.map(row => row.visual_beat_id),
    preserved_passed_cut_ids: prompts.filter(row => !unresolved(row)).map(row => row.image_id),
    recovery_policy: "exact_failed_cut_scope" };
}

export function visualPromptFailedRecoveryScope(artifact, beatPlan, sourceScriptHash) {
  if (artifact?.schema !== "goldflow_section_image_prompts_v1" || artifact.status !== "blocked"
    || !isHash(sourceScriptHash) || artifact.source_script_hash !== sourceScriptHash
    || beatPlan?.status !== "passed" || beatPlan.source_script_hash !== sourceScriptHash
    || !Array.isArray(beatPlan.beats) || !beatPlan.beats.length
    || !Array.isArray(artifact.prompts) || artifact.prompts.length !== beatPlan.beats.length) return null;
  const rows = artifact.prompts, beats = beatPlan.beats, partial = artifact.planner?.partial_failure;
  if (!partial || partial.recovery_policy !== "exact_failed_cut_scope"
    || artifact.visual_plan_scope?.total_visual_unit_count !== beats.length
    || !validIds(rows.map(row => row?.image_id)) || !validIds(rows.map(row => row?.visual_beat_id))) return null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index], beat = beats[index];
    const expectedId = beat?.image_id_hint ?? `${artifact.episode}-cut-${String(index + 1).padStart(3, "0")}`;
    if (row.image_id !== expectedId || row.visual_beat_id !== beat?.visual_beat_id
      || row.scene_id !== beat.scene_id || row.start_sec !== beat.start_sec || row.duration_sec !== beat.duration_sec
      || row.visual_beat_script_excerpt !== beat.visual_beat_script_excerpt
      || (unresolved(row) && (row.planner_recovery_required !== true || promptText(row)))) return null;
  }
  const derived = visualPromptPartialFailure(rows);
  if (!derived.failed_cut_ids.length || !validIds(derived.failed_beat_ids)
    || !same(partial.failed_cut_ids, derived.failed_cut_ids)
    || !same(partial.failed_beat_ids, derived.failed_beat_ids)
    || !same(partial.preserved_passed_cut_ids, derived.preserved_passed_cut_ids)) return null;
  return { ...derived, source_script_hash: sourceScriptHash, total_prompt_count: rows.length,
    preserved_prompts_sha256: hash(JSON.stringify(rows.filter(row => !unresolved(row)))) };
}

function scopeHash(scope) {
  const { scope_sha256: _ignored, ...binding } = scope;
  return hash(JSON.stringify(binding));
}

export async function readVisualPromptRecoveryScope({ episodeDir, sourceScriptHash, identity }) {
  try {
    const planPath = path.join(episodeDir, "section_image_prompts.json");
    const bytes = await fs.readFile(planPath), artifact = JSON.parse(bytes);
    const beatPath = path.join(episodeDir, "visual_beat_plan.json");
    const beatBytes = await fs.readFile(beatPath), beats = JSON.parse(beatBytes);
    const scope = visualPromptFailedRecoveryScope(artifact, beats, sourceScriptHash);
    if (!scope || ["channel", "week", "episode"].some(key => artifact[key] !== identity?.[key])
      || artifact.series_slug !== (identity?.series_slug ?? identity?.series)) return null;
    const sources = artifact.source_hashes;
    if (!sources || typeof sources !== "object" || Array.isArray(sources)) return null;
    for (const name of ["timed_scene_plan.json", "semantic_scene_plan.json", "visual_reference_plan.json",
      "character_state_refs.json", "reference_plan_approval.json", "story_fact_ledger.json", "visual_beat_plan.json"]) {
      if (!isHash(sources[path.join(episodeDir, name)])) return null;
    }
    if (sources[beatPath] !== hash(beatBytes)
      || hash(await fs.readFile(path.join(episodeDir, "script_clean.md"))) !== sourceScriptHash) return null;
    for (const [file, expected] of Object.entries(sources)) {
      if (!isHash(expected) || hash(await fs.readFile(file)) !== expected) return null;
    }
    if (hash(await fs.readFile(planPath)) !== hash(bytes)) return null;
    const binding = { ...scope, prompt_plan_path: planPath, prompt_plan_sha256: hash(bytes),
      visual_beat_plan_sha256: hash(beatBytes), source_hashes_sha256: hash(JSON.stringify(sources)), source_hashes_current: true };
    return { ...binding, scope_sha256: scopeHash(binding) };
  } catch { return null; }
}

const FORBIDDEN_FLAGS = [
  "cutIds", "beatIds", "onlyScenes", "visual-unit-offset", "visual-unit-limit", "offset", "limit",
  "timed", "semantic", "beats", "visual-beats", "story-fact-ledger", "visualRefs", "visual-refs",
  "reference-plan-approval", "locationContractLedger", "location-contract-ledger", "characterStateRefs",
  "character-state-refs", "output", "base-prompts", "base-prompt-plan", "script", "allow-draft-refs",
  "revalidate-existing", "dry-run-prompt", "manual-recovery-output-files", "correction-findings", "correctionFindings",
  "allow-full-stage-rerun", "rerun-reason", "planning-provider", "planning-model", "codex-model", "model",
  "provider", "image-provider", "reasoning-effort",
];

export function visualPromptRecoveryAdmission(status = {}, flags = {}) {
  if (status.current_stage !== "visual_prompt_plan" || status.current_stage_state !== "blocked") {
    return { applicable: false, allowed: false, reason: "not_a_current_blocked_visual_prompt_recovery" };
  }
  const deny = reason => ({ applicable: true, allowed: false, reason });
  const scope = status.visual_prompt_recovery_scope;
  if (!scope || scope.source_hashes_current !== true || scope.scope_sha256 !== scopeHash(scope)
    || ![scope.source_script_hash, scope.prompt_plan_sha256, scope.visual_beat_plan_sha256,
      scope.preserved_prompts_sha256, scope.source_hashes_sha256].every(isHash)
    || !validIds(scope.failed_cut_ids) || !scope.failed_cut_ids.length
    || !validIds(scope.failed_beat_ids) || scope.failed_beat_ids.length !== scope.failed_cut_ids.length
    || !validIds(scope.preserved_passed_cut_ids)
    || scope.total_prompt_count !== scope.failed_cut_ids.length + scope.preserved_passed_cut_ids.length) {
    return deny("visual_prompt_failed_scope_missing_stale_or_changed");
  }
  for (const [flag, expected] of Object.entries({ channel: status.identity?.channel, week: status.identity?.week,
    episode: status.identity?.episode, series: status.identity?.series_slug ?? status.identity?.series,
    seriesSlug: status.identity?.series_slug ?? status.identity?.series })) {
    if (Object.hasOwn(flags, flag) && flags[flag] !== expected) return deny("visual_prompt_recovery_identity_override_forbidden");
  }
  if (Object.hasOwn(flags, "episode-dir")
    && path.resolve(String(flags["episode-dir"])) !== path.dirname(scope.prompt_plan_path)) {
    return deny("visual_prompt_recovery_identity_override_forbidden");
  }
  const order = workflowStageIds(status.identity ?? {}), current = order.indexOf("visual_prompt_plan");
  const ledger = new Map((status.stage_ledger ?? []).map(row => [row.stage, row]));
  if (current < 1 || order.slice(0, current).some(id => !stageIsSatisfied(ledger.get(id)?.state))) {
    return deny("visual_prompt_recovery_prerequisites_not_current");
  }
  const scopeFlags = plannerInvocationScope(flags);
  const selectors = ["cut-ids", "beat-ids"].filter(key => Object.hasOwn(flags, key));
  if (selectors.length !== 1 || scopeFlags.scope_flags.some(key => !selectors.includes(key))
    || scopeFlags.resumes_incomplete_chunks || FORBIDDEN_FLAGS.some(key => Object.hasOwn(flags, key))) {
    return deny("visual_prompt_recovery_requires_only_exact_cut_or_beat_ids");
  }
  for (const key of ["reuse-codex-calls", "codex-reuse-cache", "codex-reuse-latest"]) {
    if (!/^(?:true|1|yes)$/i.test(String(flags[key] ?? "true"))) return deny("visual_prompt_recovery_cache_must_remain_enabled");
  }
  if (Object.hasOwn(flags, "wavefront-output-dir")) {
    const root = path.join(path.dirname(scope.prompt_plan_path), "reports", "visual-wavefront");
    const relative = path.relative(root, path.resolve(String(flags["wavefront-output-dir"])));
    if (!/^[^./][^/]*\/planner-waves$/.test(relative)) {
      return deny("visual_prompt_recovery_wavefront_output_must_be_episode_report_directory");
    }
  }
  const key = selectors[0], ids = String(flags[key] ?? "").split(",").map(value => value.trim());
  const failed = key === "cut-ids" ? scope.failed_cut_ids : scope.failed_beat_ids;
  if (!validIds(ids) || !ids.length || ids.some(id => !failed.includes(id))) {
    return deny("visual_prompt_recovery_requested_ids_not_exact_unresolved_subset");
  }
  return { applicable: true, allowed: true, reason: "exact_current_failed_visual_prompt_scope",
    selected_cut_ids: ids.map(id => scope.failed_cut_ids[failed.indexOf(id)]),
    selected_beat_ids: ids.map(id => scope.failed_beat_ids[failed.indexOf(id)]),
    prompt_plan_sha256: scope.prompt_plan_sha256 };
}
