import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { stageChecklistFor, stageIsSatisfied } from "./pipeline-stage-registry.mjs";

export const RESTART_SCHEMA = "goldflow_visual_restart_v1";
export const BASELINE_STAGES = Object.freeze([
  "source_ingest", "script_approval", "script_pace_check", "targeted_speakability",
  "semantic_scene_plan", "voice_plan", "qwen_tts_stitch", "local_whisper_word_timing",
  "audio_pace_check", "timing_bind", "sfx_score_plan", "longform_audio_mix", "visual_beat_plan",
]);
const STATIC_FILES = [
  "operator_source_story.md", "script_clean.md", "source_story_ingest_report.json",
  "operator_story_lock.json", "manual_agent_script_review.json", "operator_script_approval.json",
  "script_lock.json", "script_pace_report.json", "script_speakability_report.json",
  "script_speakability_problem_areas_report.json", "tts_spoken_overrides.json",
  "semantic_scene_plan.json", "story_fact_ledger.json", "narration_text_ir.json",
  "narration_generation_plan.json", "qwen_generation_plan.json", "audio_performance_plan.json",
  "voice_reference_completeness_report.json", "narration_actionable_direction.json",
  "narration_editorial_contract.json", "narration_text_integrity_coverage_report.json",
  "qwen_text_integrity_coverage_report.json", "system_ui_speech_coverage_report.json",
  "dialogue_map.json", "voice_artifact_contamination_report.json", "script_meta_contamination_report.json",
  "timed_scene_plan.json", "visual_beat_plan.json", "visual_beat_approval.json",
];
const EPISODE_FILES = [
  "audio_stitch_report_EP-narration.json", "narration_tts_report_EP.json",
  "narration_provider_output_manifest_EP.json", "narration_tts_unit_qa_EP.json",
  "narration_unit_delivery_qa_EP.json", "narration_final_delivery_qa_EP.json",
  "narration_full_stream_qa_EP.json", "narration_voice_continuity_qa_EP.json",
  "narration_speaker_similarity_EP.json", "narration_mastering_report_EP.json",
  "narration_mastering_report_EP-provider-neutral.json", "narration_word_timing_EP.json",
  "narration_word_timing_candidate_EP.json", "narration_pace_report_EP.json",
  "narration_source_structure_EP.json", "narration_tts_pre_synthesis_gate_EP.json",
  "narration_confirmed_pronunciation_retry_evidence_EP.json", "narration_delivery_manual_review_EP.json",
  "narration_exact_listen_review_packet_EP.json", "narration_exact_repair_packet_EP.json",
  "narration_final_exact_repair_packet_EP.json", "operator_agent_minor_qa_authorization_EP.json",
  "operator_no_listening_direction_EP.json", "operator_pronunciation_retake_review_EP.json",
  "tts_spoken_text_audit_EP.json", "voice_direction_quality_report_EP.json",
  "voice_direction_strategy_EP.json", "voice_artifact_contamination_report_EP.json",
  "dialogue_performance_audit_EP.json", "longform_audio_bed_report_EP.json",
];
export function baselineFileAllowlist(episode) {
  if (!/^ep_\d+$/.test(episode)) throw new Error("A locked ep_NN identity is required.");
  return [...STATIC_FILES, ...EPISODE_FILES.map(name => name.replace("EP", episode))];
}
const REQUIRED_STATIC = ["script_clean.md", "source_story_ingest_report.json", "operator_script_approval.json", "script_lock.json", "script_pace_report.json", "script_speakability_report.json", "tts_spoken_overrides.json", "semantic_scene_plan.json", "story_fact_ledger.json", "narration_generation_plan.json", "narration_text_ir.json", "timed_scene_plan.json", "visual_beat_plan.json", "visual_beat_approval.json"];
export function requiredBaselineFiles(episode) {
  return [...REQUIRED_STATIC, `audio_stitch_report_${episode}-narration.json`, `narration_word_timing_${episode}.json`, `narration_pace_report_${episode}.json`, `longform_audio_bed_report_${episode}.json`];
}
export async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export function jsonBytes(value) { return `${JSON.stringify(value, null, 2)}\n`; }
export function objectHash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular, non-symlink file: ${file}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }

export async function validateOpenArtContract(contract) {
  assert(contract?.schema === "goldflow_openart_image_contract_v1", "OpenArt image contract schema is required.");
  assert(["openart_cli_v1", "openart_studio_browser"].includes(contract.transport), "OpenArt transport must be explicitly locked.");
  assert(contract.primary?.mode === "auto_t2i_i2i" && typeof contract.primary?.model_id === "string" && contract.primary.model_id.trim(), "Exact OpenArt primary model ID and auto_t2i_i2i mode are required.");
  assert(contract.primary.aspect_ratio === "16:9" && contract.primary.resolution === "1k" && contract.primary.quality === "low", "This OpenArt attempt requires 16:9, 1k and low quality.");
  assert(contract.automatic_retry === false && contract.automatic_failover === false, "Automatic generation retries and creative failover are forbidden.");
  assert(Number(contract.normal_reference_count) === 3 && Number.isInteger(contract.max_reference_count) && contract.max_reference_count >= 3, "OpenArt reference limits must be explicit.");
  assert(Number.isInteger(contract.concurrency) && contract.concurrency > 0, "Positive OpenArt concurrency is required.");
  assert(Number.isFinite(contract.max_credit_cost) && contract.max_credit_cost > 0 && Number.isFinite(contract.total_credit_budget) && contract.total_credit_budget > 0, "Finite positive per-request and total OpenArt credit ceilings are required.");
  assert([0, 0.1].includes(contract.discount_fraction) && (contract.transport !== "openart_studio_browser" || contract.discount_fraction === 0), "CLI discount must not be assumed for Studio browser generation.");
  assert(path.isAbsolute(contract.reference_bank_path ?? ""), "The global reference-bank path must be absolute.");
  assert(path.isAbsolute(contract.discovery?.path ?? "") && /^[a-f0-9]{64}$/.test(contract.discovery.sha256 ?? ""), "Hash-bound OpenArt discovery is required.");
  await regularFile(contract.discovery.path);
  assert(await fileSha256(contract.discovery.path) === contract.discovery.sha256, "OpenArt discovery hash is stale.");
  const discovery = await readJson(contract.discovery.path);
  const strings = new Set();
  const visit = value => { if (typeof value === "string") strings.add(value); else if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") Object.values(value).forEach(visit); };
  visit(discovery);
  assert(strings.has(contract.primary.model_id), "Primary exact model ID was not recorded in OpenArt discovery.");
  for (const id of Object.values(contract.primary.mode_ids ?? {})) assert(strings.has(id), "Primary mode ID was not recorded in discovery.");
  assert(Array.isArray(contract.repair_models), "Explicit repair-only fallback list is required (it may be empty).");
  for (const repair of contract.repair_models) {
    assert(repair.exact_id_only === true && repair.repair_only === true && strings.has(repair.model_id), "Fallbacks require discovered exact model IDs and exact-ID repair-only restrictions.");
  }
  return contract;
}

// The entire remainder of the identity stays byte-equivalent as JSON values.
// This allowlist is deliberately smaller than the complete visual pipeline.
const CHANGING_IDENTITY_FIELDS = new Set(["week", "episode_dir", "status", "created_at", "updated_at", "git", "image_provider", "image_provider_options", "provider_locks", "model_versions", "production_profile_config", "stage_checklist", "visual_restart"]);
const visualProviderLock = key => /^(image_|explicit_image_|style_reference_|reference_provider_pool$|scene_provider_pool$|reference_model$|reference_image_provider$|google_flow_|google_gemini_|chatgpt_web_(image_|fallback_)|federated_|chatgpt_image_|creative_submission_attempts$)/.test(key);
const visualMediaField = key => /image|reference_concurrency/.test(key) || /^(google_flow_|google_gemini_|federated_google_|hybrid_web_flow_)/.test(key);
export function nonvisualIdentityBinding(identity) {
  const fields = Object.fromEntries(Object.entries(identity).filter(([key]) => !CHANGING_IDENTITY_FIELDS.has(key)));
  fields.provider_locks = Object.fromEntries(Object.entries(identity.provider_locks ?? {}).filter(([key]) => !visualProviderLock(key)));
  fields.model_versions = Object.fromEntries(Object.entries(identity.model_versions ?? {}).filter(([key]) => !/image|reference_model/.test(key)));
  const profile = structuredClone(identity.production_profile_config ?? {});
  for (const key of Object.keys(profile.media ?? {})) if (visualMediaField(key)) delete profile.media[key];
  fields.production_profile_config = profile;
  return fields;
}
export function assertRestartBaselineIdentity(identity) {
  assert(identity?.schema === "goldflow_run_identity_v2" && identity.run_intent === "production", "Visual restart requires an immutable production v2 baseline.");
  assert(identity.content_profile === "manhwa_recap_v1" && identity.media_workflow === "generated_visuals_v1" && identity.workflow_contract?.id === "generated_visuals_v1", "This visual restart supports locked manhwa/generated-visuals production only.");
  assert(identity.audio_target === "narrator_only", "This carryforward adapter requires narrator_only audio.");
  assert(identity.proof_scope?.mode === "full_episode", "Bounded proofs cannot supply full production carryforward.");
  assert(!identity.visual_restart, "Chained visual restarts require an explicit adapter; reuse the original baseline.");
}
export function createOpenArtRestartIdentity({ baseline, targetDir, week, contract, git, receiptSha256, baselineIdentitySha256, createdAt }) {
  assertRestartBaselineIdentity(baseline);
  assert(/^[a-zA-Z0-9][a-zA-Z0-9_-]+$/.test(week) && week !== baseline.week, "A distinct safe new run slug is required.");
  const next = structuredClone(baseline);
  Object.assign(next, { week, episode_dir: targetDir, status: "visual_restart_baseline_imported", created_at: createdAt, updated_at: createdAt, git, image_provider: "openart_cli", image_provider_options: { openart: structuredClone(contract) } });
  for (const key of Object.keys(next.provider_locks ?? {})) if (visualProviderLock(key)) delete next.provider_locks[key];
  next.provider_locks = { ...next.provider_locks, image_provider: "openart_cli", reference_image_provider: "openart_cli", image_model: contract.primary.model_id, reference_model: contract.primary.model_id, creative_submission_attempts: 1, image_automatic_retry_policy: "none", image_automatic_provider_failover_policy: "none" };
  for (const key of Object.keys(next.model_versions ?? {})) if (/image|reference_model/.test(key)) delete next.model_versions[key];
  next.model_versions = { ...next.model_versions, image_model: contract.primary.model_id, reference_model: contract.primary.model_id, image_provider_models: { openart_cli: { image_model: contract.primary.model_id, reference_model: contract.primary.model_id } } };
  if (next.production_profile_config?.media) {
    for (const key of Object.keys(next.production_profile_config.media)) if (visualMediaField(key)) delete next.production_profile_config.media[key];
    Object.assign(next.production_profile_config.media, { default_image_provider: "openart_cli", image_concurrency: contract.concurrency, reference_concurrency: contract.concurrency });
  }
  next.visual_restart = { schema: RESTART_SCHEMA, receipt_path: path.join(targetDir, "visual_restart_receipt.json"), receipt_sha256: receiptSha256, baseline_episode_dir: baseline.episode_dir, baseline_identity_sha256: baselineIdentitySha256, historical_visuals_policy: "immutable_excluded_from_production", all_visuals_regenerated_from_frame_one: true };
  next.stage_checklist = stageChecklistFor(next);
  assert(objectHash(nonvisualIdentityBinding(next)) === objectHash(nonvisualIdentityBinding(baseline)), "Visual restart altered a nonvisual contract.");
  return next;
}

export async function collectBaselineFiles(baselineDir, identity) {
  const files = [];
  for (const name of baselineFileAllowlist(identity.episode)) {
    const source = path.join(baselineDir, name);
    try { await regularFile(source); } catch (error) { if (error.code === "ENOENT" && !requiredBaselineFiles(identity.episode).includes(name)) continue; throw error; }
    files.push({ relative_path: name, source_path: source, sha256: await fileSha256(source), kind: "approved_nonvisual_artifact" });
  }
  const timing = await readJson(path.join(baselineDir, `narration_word_timing_${identity.episode}.json`));
  const mix = await readJson(path.join(baselineDir, `longform_audio_bed_report_${identity.episode}.json`));
  const audioPaths = new Set([timing.narration_audio_path, mix.narration_path, mix.final_audio_path].filter(Boolean));
  assert(audioPaths.size > 0, "No approved audio paths found in baseline.");
  for (const source of audioPaths) {
    const relative = path.relative(baselineDir, source);
    assert(relative.startsWith(`assets${path.sep}audio${path.sep}`) && !relative.split(path.sep).includes("..") && /\.(wav|m4a|mp3)$/i.test(source), "Only baseline-local approved audio may be mirrored.");
    await regularFile(source);
    const digest = await fileSha256(source);
    for (const [audio, hash] of [[timing.narration_audio_path, timing.narration_audio_hash], [mix.narration_path, mix.narration_sha256], [mix.final_audio_path, mix.final_audio_sha256]]) if (audio === source) assert(hash === digest, "Approved narration/mix hash is stale.");
    files.push({ relative_path: relative, source_path: source, sha256: digest, kind: "approved_audio_bytes" });
  }
  return files;
}

export async function collectHistoricalVisualInventory(baselineDir, episode) {
  const reports = [
    `imagegen_report_${episode}.json`, `imagegen_report_${episode}_codex_references.json`,
    `hybrid_browser_pool_report_${episode}_references.json`, `hybrid_browser_pool_report_${episode}_scenes.json`,
    `visual_reference_approval_${episode}.json`, `reference_image_qa_${episode}.json`,
    "reference_plan_approval.json", "reference_inventory_ledger.json", "character_state_refs.json",
    "cut_execution_ledger.json",
  ];
  const files = []; const rasterPaths = new Set(); const missingPaths = [];
  function visit(value) {
    if (typeof value === "string" && /\.(png|jpe?g|webp)$/i.test(value) && !/^https?:/.test(value)) {
      const candidate = path.isAbsolute(value) ? value : path.resolve(baselineDir, value);
      if (candidate.startsWith(`${baselineDir}${path.sep}assets${path.sep}`)) rasterPaths.add(candidate);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  for (const name of reports) {
    const source = path.join(baselineDir, name);
    try { await regularFile(source); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    files.push({ path: source, sha256: await fileSha256(source), class: "historical_visual_report", accepted_into_new_run: false });
    visit(await readJson(source));
  }
  for (const file of [...rasterPaths].sort()) {
    try { await regularFile(file); } catch (error) { if (error.code === "ENOENT") { missingPaths.push(file); continue; } throw error; }
    files.push({ path: file, sha256: await fileSha256(file), class: "historical_generated_raster", accepted_into_new_run: false });
  }
  return { schema: "goldflow_historical_visual_inventory_v1", baseline_episode_dir: baselineDir, accepted_into_new_run: false, files, referenced_but_not_present_at_restart: missingPaths };
}

export function validateBaselineStages(status) {
  const rows = status.stages ?? status.stage_ledger;
  assert(Array.isArray(rows), "Baseline status must contain a stage ledger.");
  return ["run_identity", ...BASELINE_STAGES].map(stage => {
    const row = rows.find(item => (item.stage ?? item.id) === stage);
    assert(row && stageIsSatisfied(row.state ?? row.status), `Baseline ${stage} is not currently satisfied.`);
    return { stage, state: row.state ?? row.status, evidence: row.evidence };
  });
}

// Only the exact triage command nominated by current provider state may enter a
// blocked image stage. The provider then validates the named failure/rejection
// and its prior assignment before admitting another creative submission.
export function openartTriageAdmission(status, flags) {
  const stage = /^(true|1|yes)$/i.test(String(flags["references-only"] ?? "")) ? "reference_generation" : "image_generation";
  if (status?.identity?.image_provider !== "openart_cli" || status.current_stage !== stage) return { allowed: false, reason: "Triage must match the current OpenArt generation stage." };
  if (!/^node bin\/goldflow\.mjs imagegen openart\b/.test(status.next_command_shape ?? "") || !/--action triage\b/.test(status.next_command_shape)) return { allowed: false, reason: "Current status does not identify an OpenArt exact-ID triage." };
  if (flags.action !== "triage" || !path.isAbsolute(flags.repair ?? "")) return { allowed: false, reason: "An absolute reviewed exact-ID repair record is required." };
  return { allowed: true, reason: "Current provider stage nominates exact-ID repair; provider admission remains mandatory." };
}

export async function openartRestartBaselineState({ episodeDir, identity }) {
  if (identity?.image_provider !== "openart_cli") return { applicable: false, done: false, stageStates: {} };
  try {
    await validateOpenArtContract(identity.image_provider_options?.openart);
    const binding = identity.visual_restart;
    assert(binding?.schema === RESTART_SCHEMA && binding.historical_visuals_policy === "immutable_excluded_from_production" && binding.all_visuals_regenerated_from_frame_one === true, "A scoped visual-restart identity is required.");
    assert(binding.receipt_path === path.join(episodeDir, "visual_restart_receipt.json"), "Visual restart receipt path does not belong to this episode.");
    assert(await fileSha256(binding.receipt_path) === binding.receipt_sha256, "Visual restart receipt hash is stale.");
    const receipt = await readJson(binding.receipt_path);
    const baselineDir = binding.baseline_episode_dir;
    assert(path.resolve(baselineDir) !== path.resolve(episodeDir), "A restart cannot overwrite its baseline.");
    assert(await fileSha256(path.join(baselineDir, "run_identity.json")) === binding.baseline_identity_sha256, "Historical baseline identity changed.");
    const baseline = await readJson(path.join(baselineDir, "run_identity.json"));
    assertRestartBaselineIdentity(baseline);
    assert(objectHash(nonvisualIdentityBinding(identity)) === objectHash(nonvisualIdentityBinding(baseline)), "Nonvisual identity contracts changed during visual restart.");
    assert(receipt.schema === RESTART_SCHEMA && receipt.target_episode_dir === episodeDir && receipt.target_week === identity.week && receipt.baseline_identity_sha256 === binding.baseline_identity_sha256, "Receipt identity/target mismatch.");
    assert(await fileSha256(baseline.source_path) === baseline.source_sha256, "Approved source changed.");
    assert(await fileSha256(path.join(episodeDir, "script_clean.md")) === receipt.script_sha256, "Carried approved script changed.");
    const allowlist = new Set(baselineFileAllowlist(identity.episode));
    const copied = new Set();
    for (const row of receipt.files ?? []) {
      const relative = row.relative_path;
      assert(typeof relative === "string" && !path.isAbsolute(relative) && !relative.split(path.sep).includes("..") && !copied.has(relative), "Unsafe or duplicate carryforward file.");
      copied.add(relative);
      assert(allowlist.has(relative) || (row.kind === "approved_audio_bytes" && /^assets\/audio\/.+\.(wav|m4a|mp3)$/.test(relative)), "Historical visual or non-allowlisted artifact in carryforward receipt.");
      assert(row.source_path === path.join(baselineDir, relative), "Carryforward path escaped the baseline.");
      await regularFile(row.source_path);
      await regularFile(path.join(episodeDir, relative));
      assert(await fileSha256(row.source_path) === row.sha256 && await fileSha256(path.join(episodeDir, relative)) === row.sha256, `Carried artifact changed: ${relative}`);
    }
    for (const name of requiredBaselineFiles(identity.episode)) assert(copied.has(name), `Required carryforward artifact missing: ${name}`);
    assert([...copied].some(name => /^assets\/audio\/.+\.wav$/.test(name)), "Canonical narration WAV was not mirrored.");
    const snapshotPath = path.join(episodeDir, "baseline_status_snapshot.json");
    assert(await fileSha256(snapshotPath) === receipt.baseline_status_sha256, "Baseline status snapshot changed.");
    const statuses = validateBaselineStages(await readJson(snapshotPath));
    const historicalPath = path.join(episodeDir, "historical_visual_inventory.json");
    assert(await fileSha256(historicalPath) === receipt.historical_visual_inventory_sha256, "Historical visual inventory changed.");
    const history = await readJson(historicalPath);
    assert(history.schema === "goldflow_historical_visual_inventory_v1" && history.baseline_episode_dir === baselineDir && history.accepted_into_new_run === false, "Invalid historical-only visual inventory.");
    for (const row of history.files ?? []) {
      assert(row.accepted_into_new_run === false && row.path.startsWith(`${baselineDir}${path.sep}`), "Historical visual inventory escaped its historical-only scope.");
      assert(await fileSha256(row.path) === row.sha256, `Historical visual evidence changed: ${row.path}`);
    }
    const stageStates = Object.fromEntries(statuses.filter(row => row.stage !== "run_identity").map(row => [row.stage, { done: true, ...(row.state === "skipped_with_waiver" ? { state: row.state } : {}), evidence: `Exact approved baseline carryforward (${binding.baseline_identity_sha256.slice(0, 12)}); ${row.evidence ?? row.stage}` }]));
    return { applicable: true, done: true, evidence: "OpenArt contract and exact nonvisual baseline carryforward current; historical images excluded", stageStates };
  } catch (error) {
    return { applicable: true, done: false, evidence: error.message, state: "blocked", stageStates: {} };
  }
}
