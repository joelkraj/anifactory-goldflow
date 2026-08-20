import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const EPISODE_QUALITY_OUTCOME_SCHEMA =
  "goldflow_episode_quality_outcome_v1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["outcome_sha256", "created_at"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function episodeQualityOutcomeSha256(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function jsonBinding(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const bytes = await fs.readFile(resolved).catch(() => null);
  if (!bytes) return null;
  try {
    return {
      path: resolved,
      sha256: sha256(bytes),
      document: JSON.parse(bytes.toString("utf8")),
    };
  } catch {
    return { path: resolved, sha256: sha256(bytes), document: null };
  }
}

async function matchingJsonFiles(root, fileName) {
  const found = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name === fileName) found.push(target);
    }));
  }
  await walk(root);
  return found.sort();
}

function semanticSummary(document) {
  if (!document) return null;
  const rows = Array.isArray(document.rows) ? document.rows : [];
  const passed = finite(document.passed_count)
    ?? rows.filter((row) => row.overall_verdict === "pass").length;
  const reviewed = finite(document.needs_review_count)
    ?? rows.filter((row) => ["needs_review", "fail"].includes(row.overall_verdict)).length;
  const audited = finite(document.audited_count) ?? rows.length;
  return {
    audited_count: audited,
    passed_count: passed,
    needs_review_count: reviewed,
    pass_rate: rate(passed, audited),
  };
}

function promptRasterSummary({ prompts, imagegen, imageQa, semantic }) {
  const promptRows = Array.isArray(prompts?.prompts) ? prompts.prompts : [];
  const resultRows = Array.isArray(imagegen?.results) ? imagegen.results : [];
  const acceptedResults = resultRows.filter((row) => (
    row?.generated?.output_sha256
      || row?.accepted_png_sha256
      || row?.output_sha256
      || ["passed", "accepted", "completed"].includes(String(row?.status ?? "").toLowerCase())
  ));
  const explicitFirstPassRows = resultRows.filter((row) => (
    row?.first_pass === true
      || Number(row?.creative_submission_number ?? row?.attempt_number) === 1
  ));
  const explicitFirstPassAccepted = explicitFirstPassRows.filter((row) => (
    row?.accepted === true
      || row?.generated?.output_sha256
      || ["passed", "accepted", "completed"].includes(String(row?.status ?? "").toLowerCase())
  ));
  const semanticResult = semanticSummary(semantic);
  const imageCount = finite(imageQa?.image_count) ?? resultRows.length;
  const structurallyValid = finite(imageQa?.structurally_valid_count)
    ?? acceptedResults.length;
  return {
    prompt_count: promptRows.length,
    materialized_result_count: resultRows.length,
    accepted_raster_count: structurallyValid,
    raster_acceptance_rate: rate(structurallyValid, imageCount),
    explicit_first_pass_sample_count: explicitFirstPassRows.length,
    explicit_first_pass_accepted_count: explicitFirstPassAccepted.length,
    explicit_first_pass_acceptance_rate: rate(
      explicitFirstPassAccepted.length,
      explicitFirstPassRows.length,
    ),
    first_pass_measurement_status: explicitFirstPassRows.length
      ? "measured"
      : "unavailable_not_inferred_from_final_state",
    semantic_raster: semanticResult,
    structural_blocker_count: Array.isArray(imageQa?.structural_blockers)
      ? imageQa.structural_blockers.length
      : Math.max(0, imageCount - structurallyValid),
    advisory_risk_cut_count: finite(imageQa?.advisory_risk_cut_count),
  };
}

function heroSummary(bindings) {
  const rows = bindings
    .map((binding) => binding.document)
    .filter((document) => document?.schema === "goldflow_hero_image_candidate_selection_v1");
  const deltas = rows.map((row) => {
    const selected = finite(row?.selected_candidate?.semantic_score?.score);
    const rejected = finite(row?.rejected_candidate?.semantic_score?.score);
    return selected != null && rejected != null ? selected - rejected : null;
  }).filter((value) => value != null);
  return {
    selected_hero_count: rows.length,
    degraded_selection_count: rows.filter((row) => row.status === "selected_degraded").length,
    blind_selector_count: rows.filter((row) => row.selection_method === "blind_visual_selector").length,
    semantic_dominance_count: rows.filter((row) => row.selection_method === "semantic_contract_dominance").length,
    mean_selected_semantic_advantage: deltas.length
      ? Number((deltas.reduce((sum, value) => sum + value, 0) / deltas.length).toFixed(4))
      : null,
    selections: rows.map((row) => ({
      canonical_image_id: row.canonical_image_id,
      selection_method: row.selection_method,
      selected_label: row.selected_candidate?.label ?? null,
      selected_semantic_score: finite(row.selected_candidate?.semantic_score?.score),
      rejected_semantic_score: finite(row.rejected_candidate?.semantic_score?.score),
    })),
  };
}

function motionSummary(document) {
  const summary = document?.summary ?? {};
  const count = finite(summary.clip_count) ?? 0;
  const pass = finite(summary.pass_count) ?? 0;
  return {
    clip_count: count,
    pass_count: pass,
    needs_review_count: finite(summary.needs_review_count) ?? 0,
    reject_recommended_count: finite(summary.reject_recommended_count) ?? 0,
    unavailable_count: finite(summary.unavailable_count) ?? 0,
    coherence_pass_rate: rate(pass, count),
  };
}

function narrationSummary(manifest, decision) {
  const rows = Array.isArray(decision?.decisions) ? decision.decisions : [];
  const repairUnits = [...new Set(rows.flatMap((row) => row.repair_unit_ids ?? []).map(String))];
  return {
    manifest_status: manifest?.status ?? "missing",
    decision_status: decision?.status ?? "missing",
    sample_count: finite(manifest?.sample_count) ?? 0,
    approved_sample_count: rows.filter((row) => row.decision === "accepted").length,
    repair_sample_count: rows.filter((row) => row.decision === "repair_required").length,
    repair_unit_count: repairUnits.length,
    repair_unit_ids: repairUnits,
    clean_subjective_pass: decision?.status === "approved" && repairUnits.length === 0,
  };
}

function packageSummary(spec, mixedViewer) {
  const tallies = mixedViewer?.package_preference_tallies ?? {};
  const candidateVotes = finite(tallies.candidate) ?? 0;
  const referenceVotes = finite(tallies.reference) ?? 0;
  const denominator = candidateVotes + referenceVotes + (finite(tallies.tie) ?? 0);
  return {
    selected_title: spec?.selected_title ?? null,
    selected_thumbnail_candidate_id: spec?.selected_thumbnail_candidate_id ?? null,
    title_candidate_count: Array.isArray(spec?.title_candidates) ? spec.title_candidates.length : 0,
    thumbnail_candidate_count: Array.isArray(spec?.thumbnail_candidates) ? spec.thumbnail_candidates.length : 0,
    mixed_viewer_status: mixedViewer?.status ?? "missing",
    mixed_viewer_candidate_votes: candidateVotes,
    mixed_viewer_reference_votes: referenceVotes,
    mixed_viewer_tie_votes: finite(tallies.tie) ?? 0,
    mixed_viewer_candidate_margin: denominator
      ? Number(((candidateVotes - referenceVotes) / denominator).toFixed(4))
      : null,
  };
}

export async function buildEpisodeQualityOutcomeRecord({
  episodeDir,
  episode,
  analytics,
  analyticsInputPath = null,
  paths = {},
  createdAt = new Date(),
} = {}) {
  const root = path.resolve(episodeDir);
  const providedPaths = Object.fromEntries(
    Object.entries(paths).filter(([, value]) => value != null),
  );
  const defaults = {
    prompts: path.join(root, "section_image_prompts_hardened.json"),
    imagegen: path.join(root, `imagegen_report_${episode}.json`),
    imageQa: path.join(root, `image_output_qa_${episode}.json`),
    semantic: path.join(root, `image_semantic_audit_${episode}.json`),
    motion: path.join(root, "assets", "motion", "generated", `generated_motion_coherence_audit_${episode}.json`),
    narrationManifest: path.join(root, `narration_subjective_review_manifest_${episode}.json`),
    narrationDecision: path.join(root, `narration_subjective_review_decision_${episode}.json`),
    packaging: path.join(root, `youtube_packaging_spec_${episode}.json`),
    mixedViewer: null,
    ...providedPaths,
  };
  const heroPaths = paths.heroSelections ?? await matchingJsonFiles(
    path.join(root, "reports", "hero-image-candidates"),
    "selection.json",
  );
  const [prompts, imagegen, imageQa, semantic, motion, narrationManifest, narrationDecision, packaging, mixedViewer, analyticsInput, ...heroBindings] = await Promise.all([
    jsonBinding(defaults.prompts),
    jsonBinding(defaults.imagegen),
    jsonBinding(defaults.imageQa),
    jsonBinding(defaults.semantic),
    jsonBinding(defaults.motion),
    jsonBinding(defaults.narrationManifest),
    jsonBinding(defaults.narrationDecision),
    jsonBinding(defaults.packaging),
    jsonBinding(defaults.mixedViewer),
    analyticsInputPath ? jsonBinding(analyticsInputPath) : null,
    ...heroPaths.map(jsonBinding),
  ]);
  const presentHeroBindings = heroBindings.filter(Boolean);
  const bindings = [
    prompts, imagegen, imageQa, semantic, motion, narrationManifest,
    narrationDecision, packaging, mixedViewer, analyticsInput,
    ...presentHeroBindings,
  ].filter(Boolean).map(({ path: filePath, sha256: fileSha, document }) => ({
    path: filePath,
    sha256: fileSha,
    schema: document?.schema ?? null,
    status: document?.status ?? null,
  }));
  const artifact = {
    schema: EPISODE_QUALITY_OUTCOME_SCHEMA,
    status: "observational",
    episode,
    final_video_sha256: analytics?.final_video_sha256 ?? null,
    policy: "This record calibrates quality checks against real outcomes. It never changes a default from one episode and never treats a final accepted artifact as proof of first-pass quality.",
    quality_signals: {
      prompt_and_raster: promptRasterSummary({
        prompts: prompts?.document,
        imagegen: imagegen?.document,
        imageQa: imageQa?.document,
        semantic: semantic?.document,
      }),
      hero_alternatives: heroSummary(presentHeroBindings),
      generated_motion: motionSummary(motion?.document),
      narration: narrationSummary(
        narrationManifest?.document,
        narrationDecision?.document,
      ),
      package: packageSummary(packaging?.document, mixedViewer?.document),
    },
    observed_outcomes: {
      snapshot_label: analytics?.snapshot_label ?? null,
      ctr_percent: finite(analytics?.summary_metrics?.ctr_percent),
      impressions: finite(analytics?.summary_metrics?.impressions),
      average_view_duration_sec: finite(analytics?.summary_metrics?.average_view_duration_sec),
      average_percentage_viewed: finite(analytics?.summary_metrics?.average_percentage_viewed),
      first_30_sec_retention_percent: finite(analytics?.mixed_viewer_shadow_calibration?.actuals?.first_30_sec_retention_percent),
      first_60_sec_retention_percent: finite(analytics?.mixed_viewer_shadow_calibration?.actuals?.first_60_sec_retention_percent),
      significant_drop_count: Array.isArray(analytics?.significant_drops) ? analytics.significant_drops.length : 0,
      significant_rise_count: Array.isArray(analytics?.significant_rises) ? analytics.significant_rises.length : 0,
    },
    artifact_bindings: bindings,
    completeness: {
      required_signal_groups: 6,
      available_signal_groups: [
        prompts, semantic, presentHeroBindings.length ? true : null,
        motion, narrationDecision, packaging,
      ].filter(Boolean).length,
      missing_signal_groups: [
        !prompts ? "prompt_plan" : null,
        !semantic ? "raster_semantic_audit" : null,
        !presentHeroBindings.length ? "hero_alternative_selections" : null,
        !motion ? "generated_motion_coherence" : null,
        !narrationDecision ? "narration_subjective_decision" : null,
        !packaging ? "approved_packaging" : null,
      ].filter(Boolean),
    },
    created_at: createdAt.toISOString(),
  };
  return { ...artifact, outcome_sha256: episodeQualityOutcomeSha256(artifact) };
}

export function validateEpisodeQualityOutcomeRecord(record) {
  const findings = [];
  if (record?.schema !== EPISODE_QUALITY_OUTCOME_SCHEMA) findings.push({ code: "episode_quality_outcome_schema_invalid" });
  if (record?.outcome_sha256 !== episodeQualityOutcomeSha256(record)) findings.push({ code: "episode_quality_outcome_hash_invalid" });
  if (!record?.episode || !record?.final_video_sha256) findings.push({ code: "episode_quality_outcome_identity_incomplete" });
  if (!record?.quality_signals || !record?.observed_outcomes) findings.push({ code: "episode_quality_outcome_sections_missing" });
  const paths = (record?.artifact_bindings ?? []).map((row) => row.path);
  if (paths.length !== new Set(paths).size || (record?.artifact_bindings ?? []).some((row) => !row.path || !/^[a-f0-9]{64}$/u.test(String(row.sha256 ?? "")))) findings.push({ code: "episode_quality_outcome_binding_invalid" });
  return { status: findings.length ? "blocked" : "passed", findings };
}
