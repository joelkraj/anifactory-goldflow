import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { plannerInvocationScope } from "./planner-rerun-policy.mjs";
import { CURRENT_VISUAL_BEAT_CONTRACT_VERSION } from "./visual-beat-contract.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const isHash = (value) => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const unique = (values) => new Set(values).size === values.length;
const atomRange = (id) => String(id).match(/^atom_w(\d{6})_w(\d{6})$/)?.slice(1).map(Number);

export function visualBeatFailedRecoveryScope(artifact, sourceScriptHash) {
  if (artifact?.schema !== "goldflow_visual_beat_plan_v2" || artifact.status !== "blocked"
    || (artifact.visual_beat_contract_version ?? artifact.planner_contract_version) !== CURRENT_VISUAL_BEAT_CONTRACT_VERSION
    || !isHash(sourceScriptHash) || artifact.source_script_hash !== sourceScriptHash
    || !Array.isArray(artifact.beats)) return null;
  const director = artifact.editorial_director, partial = director?.partial_failure;
  const failed = partial?.failed_chunks;
  if (!Array.isArray(failed) || !failed.length || !Array.isArray(partial.passed_chunks)
    || !Number.isInteger(director.chunk_count) || director.chunk_count < failed.length
    || !Number.isInteger(director.atom_count) || director.atom_count < 1
    || partial.failed_chunk_count !== failed.length) return null;
  const chunkIds = failed.map((row) => row?.chunk_id);
  const atomIds = failed.flatMap((row) => Array.isArray(row?.atom_ids) ? row.atom_ids : []);
  const preservedAtoms = artifact.beats.flatMap((beat) => beat.source_atom_ids ?? []);
  const preservedIds = artifact.beats.map((beat) => beat.visual_beat_id);
  if (!unique(chunkIds) || !unique(atomIds) || !unique(preservedIds)
    || preservedIds.some((id) => typeof id !== "string" || !id)
    || !same(chunkIds, partial.failed_chunk_ids) || !same(atomIds, partial.failed_atom_ids)
    || !same(preservedIds, partial.preserved_passed_beat_ids)
    || partial.passed_chunks.some((row) => chunkIds.includes(row.chunk_id))) return null;
  for (const row of failed) {
    if (!Number.isInteger(row.ordinal) || row.ordinal < 1 || row.ordinal > director.chunk_count
      || row.chunk_id !== `editorial_${String(row.ordinal).padStart(3, "0")}`
      || !Number.isInteger(row.recovery_generation) || row.recovery_generation < 0
      || !isHash(row.input_sha256) || !Array.isArray(row.atom_ids) || !row.atom_ids.length) return null;
    const ranges = row.atom_ids.map(atomRange);
    if (ranges.some((range, index) => !range || range[1] < range[0]
      || (index > 0 && range[0] !== ranges[index - 1][1] + 1))
      || row.source_word_start_index !== ranges[0][0]
      || row.source_word_end_index !== ranges.at(-1)[1]) return null;
  }
  const allAtoms = [...preservedAtoms, ...atomIds];
  if (!unique(allAtoms) || allAtoms.length !== director.atom_count) return null;
  const ranges = allAtoms.map(atomRange);
  if (ranges.some((range) => !range || range[1] < range[0])) return null;
  ranges.sort((left, right) => left[0] - right[0]);
  if (ranges[0][0] !== 0 || ranges.some((range, index) => index > 0 && range[0] !== ranges[index - 1][1] + 1)) return null;
  return { failed_chunk_ids: chunkIds, failed_atom_ids: atomIds,
    failed_descriptors_sha256: hash(JSON.stringify(failed)),
    preserved_beats_sha256: hash(JSON.stringify(artifact.beats)), source_script_hash: sourceScriptHash };
}

function scopeHash(scope) {
  const { scope_sha256: _ignored, ...binding } = scope;
  return hash(JSON.stringify(binding));
}

export async function readVisualBeatRecoveryScope({ episodeDir, sourceScriptHash, identity }) {
  try {
    const planPath = path.join(episodeDir, "visual_beat_plan.json");
    const bytes = await fs.readFile(planPath);
    const artifact = JSON.parse(bytes);
    const scope = visualBeatFailedRecoveryScope(artifact, sourceScriptHash);
    if (!scope || ["channel", "week", "episode"].some((key) => artifact[key] !== identity?.[key])
      || artifact.series_slug !== (identity?.series_slug ?? identity?.series)) return null;
    const sources = artifact.source_hashes;
    if (!sources || typeof sources !== "object" || Array.isArray(sources)) return null;
    for (const name of ["script_clean.md", "story_fact_ledger.json", "timed_scene_plan.json", `narration_word_timing_${identity.episode}.json`]) {
      if (!isHash(sources[path.join(episodeDir, name)])) return null;
    }
    if (sources[path.join(episodeDir, "script_clean.md")] !== sourceScriptHash) return null;
    for (const [file, expected] of Object.entries(sources)) {
      if (!isHash(expected) || hash(await fs.readFile(file)) !== expected) return null;
    }
    if (hash(await fs.readFile(planPath)) !== hash(bytes)) return null;
    const binding = { ...scope, visual_beat_plan_sha256: hash(bytes),
      source_hashes_sha256: hash(JSON.stringify(sources)), source_hashes_current: true,
      timing_contract: identity.visual_beat_timing_contract ?? identity.provider_locks?.visual_beat_timing_contract ?? null };
    return { ...binding, scope_sha256: scopeHash(binding) };
  } catch { return null; }
}

const FORBIDDEN_FLAGS = [
  "legacy-deterministic-beats", "approve-regrouping", "regroup-locked-tail-from-sec",
  "retime-locked-grouping", "reproject-active-state-only", "editorial-chunk-id", "editorial-chunk-ids",
  "script", "timed", "wordTiming", "word-timing", "story-fact-ledger", "output", "approval-output",
  "retention-reset-evidence", "audiovisual-emphasis-spine",
];

export function visualBeatRecoveryAdmission(status = {}, flags = {}) {
  if (status.current_stage !== "visual_beat_plan" || status.current_stage_state !== "blocked") {
    return { applicable: false, allowed: false, reason: "not_a_blocked_visual_beat_recovery" };
  }
  const deny = (reason) => ({ applicable: true, allowed: false, reason });
  const scope = status.visual_beat_recovery_scope;
  if (!scope || scope.source_hashes_current !== true || !isHash(scope.source_script_hash)
    || !isHash(scope.visual_beat_plan_sha256) || !isHash(scope.failed_descriptors_sha256)
    || !isHash(scope.preserved_beats_sha256) || !isHash(scope.source_hashes_sha256)
    || scope.scope_sha256 !== scopeHash(scope)
    || !Array.isArray(scope.failed_chunk_ids) || !scope.failed_chunk_ids.length
    || !unique(scope.failed_chunk_ids) || scope.failed_chunk_ids.some((id) => !/^editorial_\d{3,}$/.test(id))
    || !Array.isArray(scope.failed_atom_ids) || !scope.failed_atom_ids.length || !unique(scope.failed_atom_ids)) {
    return deny("visual_beat_failed_scope_missing_stale_or_changed");
  }
  // The underlying stage accepts this exact spelling and always resumes ALL
  // recorded failed descriptors. It has no arbitrary subset selector.
  if (flags["resume-incomplete-chunks"] !== "true") return deny("visual_beat_recovery_requires_resume_incomplete_chunks_true");
  if (plannerInvocationScope(flags).scoped || FORBIDDEN_FLAGS.some((name) => Object.hasOwn(flags, name))) {
    return deny("visual_beat_recovery_input_or_scope_override_forbidden");
  }
  for (const flag of ["reuse-codex-calls", "codex-reuse-cache", "codex-reuse-latest"]) {
    if (String(flags[flag] ?? "true") === "false") return deny("visual_beat_recovery_cache_must_remain_enabled");
  }
  for (const [key, expected] of Object.entries(scope.timing_contract ?? {})) {
    const flag = key === "enforcement" ? "beat-timing-enforcement" : key.replaceAll("_", "-");
    if (!Object.hasOwn(flags, flag)) continue;
    if (key === "enforcement" ? String(flags[flag]) !== String(expected) : Number(flags[flag]) !== Number(expected)) {
      return deny("visual_beat_recovery_timing_contract_changed");
    }
  }
  return { applicable: true, allowed: true, reason: "exact_current_failed_visual_beat_scope",
    failed_chunk_ids: scope.failed_chunk_ids, failed_atom_ids: scope.failed_atom_ids };
}
