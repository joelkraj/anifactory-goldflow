import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256File } from "./file-hash.mjs";
import { canonicalNarrationPlanSha256 } from "./narration-pre-synthesis-gate.mjs";
import { validateNarrationProviderOutputManifest } from "./narration-provider-adapter.mjs";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "./narration-tts-policy.mjs";
import { narrationQualityContractForIdentity } from "./narration-quality-contract.mjs";

export const LOW_MARGIN_DISPOSITION_SCHEMA = "goldflow_narration_low_margin_disposition_v1";
export const LOW_MARGIN_CODE = "narration_voice_similarity_low_margin";
const HASH = /^[a-f0-9]{64}$/;
const BINDINGS = ["source_script_sha256", "run_identity_sha256", "narration_generation_plan_file_sha256",
  "provider_output_manifest_file_sha256", "speaker_similarity_file_sha256",
  "narration_generation_plan_sha256", "narration_quality_contract_sha256"];
const RENEWABLE_BINDINGS = ["provider_output_manifest_file_sha256", "speaker_similarity_file_sha256"];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function lowMarginDispositionSha256(receipt) {
  const { disposition_sha256: _hash, ...payload } = receipt ?? {};
  return digest(JSON.stringify(payload));
}

export function assertLowMarginEvidence(context) {
  const { bindings, report, manifest, profile, qualityContract } = context;
  if (!bindings || BINDINGS.some((key) => !HASH.test(String(bindings[key] ?? "")))) {
    throw new Error("Low-margin disposition requires complete current hash bindings.");
  }
  if (report?.schema !== "goldflow_tts_voice_continuity_qa_v1"
    || report.threshold_mode !== "reference_leave_one_out"
    || report.method !== profile.speaker_similarity_method
    || report.model_sha256 !== profile.speaker_similarity_model_sha256
    || report.reference_voice_id !== profile.reference_voice_id
    || report.reference_voice_sha256 !== profile.reference_voice_sha256
    || manifest.voice_id !== profile.voice_id || manifest.voice_sha256 !== profile.voice_sha256
    || manifest.voice_continuity_contract !== profile.voice_continuity_contract
    || manifest.provider !== profile.provider
    || manifest.model_id !== profile.model_id || manifest.model_revision !== profile.model_revision
    || report.aggregate_status !== "passed") {
    throw new Error("Low-margin disposition requires valid voice identity and a passed aggregate.");
  }
  const { minimum_cosine_similarity: minimum, warning_below_cosine_similarity: warning,
    aggregate_minimum_cosine_similarity: aggregateMinimum } = report;
  const floor = report.calibration?.reference_leave_one_out_floor;
  const round = (n) => Number(n.toFixed(6));
  if (![minimum, warning, aggregateMinimum, floor, report.candidate_aggregate?.mean_cosine_similarity].every(finite)
    || minimum <= 0 || warning > 1 || minimum >= warning
    || report.calibration.hard_margin !== 0.05 || report.calibration.warning_margin !== 0
    || report.calibration.aggregate_margin !== 0.03
    || minimum !== round(Math.max(0.01, floor - 0.05))
    || warning !== round(Math.max(minimum, floor))
    || aggregateMinimum !== round(Math.max(minimum, floor - 0.03))
    || report.candidate_aggregate.mean_cosine_similarity < aggregateMinimum) {
    throw new Error("Low-margin disposition cannot change calibrated thresholds or accept aggregate drift.");
  }
  if ((report.references?.length ?? 0) < (qualityContract.voice_identity_qa?.minimum_reference_count ?? 3)
    || report.reference_count !== report.references.length
    || report.candidate_count !== manifest.units?.length
    || report.candidates?.length !== manifest.units?.length
    || report.candidate_aggregate.count !== manifest.units.length) {
    throw new Error("Low-margin disposition requires complete reference and candidate coverage.");
  }
  if (report.reference_calibration?.length !== report.references.length
    || report.reference_calibration.some((row, index) => !finite(row.leave_one_out_cosine_similarity)
      || row.audio_sha256 !== report.references[index].audio_sha256
      || path.resolve(row.audio_path ?? "") !== path.resolve(report.references[index].audio_path ?? ""))
    || Math.min(...report.reference_calibration.map((row) => row.leave_one_out_cosine_similarity)) !== floor) {
    throw new Error("Low-margin leave-one-out reference calibration is incomplete or inconsistent.");
  }
  const ids = new Set();
  for (const [index, unit] of manifest.units.entries()) {
    const candidate = report.candidates[index];
    if (!unit.unit_id || ids.has(unit.unit_id) || unit.status !== "accepted"
      || candidate.audio_sha256 !== unit.audio_sha256
      || path.resolve(candidate.audio_path ?? "") !== path.resolve(unit.audio_path ?? "")
      || !finite(candidate.cosine_similarity)
      || candidate.minimum_cosine_similarity !== minimum
      || candidate.warning_below_cosine_similarity !== warning
      || candidate.status !== (candidate.cosine_similarity >= minimum ? "passed" : "blocked")) {
      throw new Error("Low-margin disposition candidate identity, order, or calibrated decision is invalid.");
    }
    ids.add(unit.unit_id);
  }
  return context;
}

function exactEligibleRows(unitIds, context) {
  assertLowMarginEvidence(context);
  if (!Array.isArray(unitIds) || !unitIds.length || unitIds.some((id) => typeof id !== "string" || !id.trim())
    || new Set(unitIds).size !== unitIds.length) throw new Error("Exact, unique low-margin unit IDs are required.");
  const byId = new Map(context.manifest.units.map((unit, index) => [unit.unit_id, { unit, candidate: context.report.candidates[index] }]));
  return unitIds.map((unitId) => {
    const entry = byId.get(unitId);
    const score = entry?.candidate.cosine_similarity;
    if (!entry || !finite(score) || score < context.report.minimum_cosine_similarity
      || score >= context.report.warning_below_cosine_similarity || entry.candidate.status !== "passed") {
      throw new Error(`Unit ${unitId} is not an exact passing low-margin candidate.`);
    }
    return { unit_id: unitId, audio_sha256: entry.unit.audio_sha256,
      cosine_similarity: score, minimum_cosine_similarity: context.report.minimum_cosine_similarity,
      warning_below_cosine_similarity: context.report.warning_below_cosine_similarity };
  });
}

export function buildLowMarginDisposition({ context, unitIds, reviewer, reason, previous = null,
  supersedeDisposition = null, archivePath = null, reviewedAt = new Date().toISOString() }) {
  const receipt = { schema: LOW_MARGIN_DISPOSITION_SCHEMA, status: "approved_policy_disposition",
    reviewed_at: reviewedAt, reviewer: String(reviewer ?? "").trim(), reason: String(reason ?? "").trim(),
    bindings: context.bindings, finding_code: LOW_MARGIN_CODE,
    units: exactEligibleRows(unitIds, context),
    policy: "Only the exact passing low-margin measurement is advisory. Below-minimum scores, other warnings, delivery and join checks, and hash-bound subjective listening remain required.",
    human_listening_performed: false, synthesis_authorized: false, thresholds_changed: false };
  if (previous || supersedeDisposition) {
    if (!previous || supersedeDisposition !== previous.receipt?.disposition_sha256
      || !HASH.test(String(supersedeDisposition)) || !HASH.test(String(previous.file_sha256))
      || !archivePath) throw new Error("Renewal requires the exact active disposition SHA and retained predecessor.");
    assertLowMarginRenewalScope(previous.receipt, receipt);
    receipt.supersedes = { disposition_sha256: supersedeDisposition,
      file_sha256: previous.file_sha256, path: archivePath };
  }
  receipt.disposition_sha256 = lowMarginDispositionSha256(receipt);
  return assertLowMarginDisposition(receipt, context);
}

function assertLowMarginReceiptIntegrity(receipt) {
  if (receipt?.schema !== LOW_MARGIN_DISPOSITION_SCHEMA || receipt.status !== "approved_policy_disposition"
    || receipt.disposition_sha256 !== lowMarginDispositionSha256(receipt)
    || BINDINGS.some((key) => !HASH.test(String(receipt.bindings?.[key] ?? "")))
    || receipt.finding_code !== LOW_MARGIN_CODE
    || !receipt.reviewer?.trim() || String(receipt.reason ?? "").trim().length < 40
    || !Number.isFinite(Date.parse(receipt.reviewed_at))
    || receipt.human_listening_performed !== false || receipt.synthesis_authorized !== false
    || receipt.thresholds_changed !== false) {
    throw new Error("Low-margin disposition is missing, stale, or lacks an explicit substantive policy decision.");
  }
  if (!Array.isArray(receipt.units) || !receipt.units.length
    || new Set(receipt.units.map((row) => row.unit_id)).size !== receipt.units.length
    || receipt.units.some((row) => !row.unit_id || !HASH.test(String(row.audio_sha256))
      || ![row.cosine_similarity, row.minimum_cosine_similarity, row.warning_below_cosine_similarity].every(finite)
      || row.cosine_similarity < row.minimum_cosine_similarity
      || row.cosine_similarity >= row.warning_below_cosine_similarity)) {
    throw new Error("Low-margin receipt exact measurements are invalid.");
  }
  if (receipt.supersedes && (!HASH.test(String(receipt.supersedes.disposition_sha256))
    || !HASH.test(String(receipt.supersedes.file_sha256)) || !receipt.supersedes.path)) {
    throw new Error("Low-margin renewal predecessor binding is invalid.");
  }
  return receipt;
}

function assertLowMarginRenewalScope(previous, current) {
  assertLowMarginReceiptIntegrity(previous);
  if (BINDINGS.filter((key) => !RENEWABLE_BINDINGS.includes(key))
    .some((key) => previous.bindings[key] !== current.bindings[key])) {
    throw new Error("Low-margin renewal cannot change source, identity, plan, or quality contract.");
  }
  if (!RENEWABLE_BINDINGS.some((key) => previous.bindings[key] !== current.bindings[key])) {
    throw new Error("Low-margin renewal requires stale provider or speaker evidence.");
  }
  if (!equal(previous.units, current.units)) {
    throw new Error("Low-margin renewal requires the same exact unit scope, WAV hashes, scores, and thresholds.");
  }
}

export function assertLowMarginDisposition(receipt, context) {
  assertLowMarginReceiptIntegrity(receipt);
  if (!equal(receipt.bindings, context.bindings)) throw new Error("Low-margin disposition evidence is stale.");
  if (!equal(receipt.units, exactEligibleRows((receipt.units ?? []).map((row) => row.unit_id), context))) {
    throw new Error("Low-margin disposition exact unit measurements or audio bindings changed.");
  }
  return receipt;
}

export function lowMarginDispositionArchivePath(episodeDir, episode, dispositionSha256) {
  if (!HASH.test(String(dispositionSha256))) throw new Error("An exact disposition SHA is required.");
  return path.join(episodeDir, "reports", `narration_low_margin_disposition_${episode}`, `${dispositionSha256}.json`);
}

export async function verifyLowMarginAudioEvidence(context, unitIds, { renewal = false } = {}) {
  const byId = new Map(context.manifest.units.map((unit) => [unit.unit_id, unit]));
  const units = renewal ? context.manifest.units : unitIds.map((id) => byId.get(id));
  for (const unit of units) {
    if (!unit || await sha256File(unit.audio_path) !== unit.audio_sha256) {
      throw new Error(`Exact audio hash is stale: ${unit?.unit_id ?? "unknown"}`);
    }
  }
}

export async function readLowMarginDispositionRecord({ episodeDir, episode }) {
  const receiptPath = path.join(episodeDir, `narration_low_margin_disposition_${episode}.json`);
  let bytes;
  try { bytes = await fs.readFile(receiptPath); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const receipt = assertLowMarginReceiptIntegrity(JSON.parse(bytes.toString("utf8")));
  let current = receipt;
  const visited = new Set([current.disposition_sha256]);
  while (current.supersedes) {
    const predecessor = current.supersedes;
    const archivePath = lowMarginDispositionArchivePath(episodeDir, episode, predecessor.disposition_sha256);
    if (predecessor.path !== archivePath || visited.has(predecessor.disposition_sha256)) {
      throw new Error("Low-margin renewal history path or chain is invalid.");
    }
    const archivedBytes = await fs.readFile(archivePath);
    const archived = assertLowMarginReceiptIntegrity(JSON.parse(archivedBytes.toString("utf8")));
    if (digest(archivedBytes) !== predecessor.file_sha256
      || archived.disposition_sha256 !== predecessor.disposition_sha256) {
      throw new Error("Low-margin retained predecessor is hash-stale.");
    }
    assertLowMarginRenewalScope(archived, current);
    visited.add(archived.disposition_sha256);
    current = archived;
  }
  return { path: receiptPath, file_sha256: digest(bytes), receipt, bytes };
}

export async function persistLowMarginDisposition({ episodeDir, episode, receipt, previous = null }) {
  assertLowMarginReceiptIntegrity(receipt);
  const outputPath = path.join(episodeDir, `narration_low_margin_disposition_${episode}.json`);
  const lockPath = `${outputPath}.lock`;
  const lock = await fs.open(lockPath, "wx");
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    const active = await readLowMarginDispositionRecord({ episodeDir, episode });
    if (!previous) {
      if (active || receipt.supersedes) throw new Error("Existing low-margin disposition is immutable; explicit renewal is required.");
      await fs.writeFile(outputPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    } else {
      if (!active || active.file_sha256 !== previous.file_sha256
        || active.receipt.disposition_sha256 !== previous.receipt.disposition_sha256
        || receipt.supersedes?.file_sha256 !== active.file_sha256
        || receipt.supersedes?.disposition_sha256 !== active.receipt.disposition_sha256) {
        throw new Error("Active low-margin predecessor changed before renewal.");
      }
      assertLowMarginRenewalScope(active.receipt, receipt);
      const archivePath = lowMarginDispositionArchivePath(episodeDir, episode, active.receipt.disposition_sha256);
      if (receipt.supersedes.path !== archivePath) throw new Error("Low-margin renewal archive path is invalid.");
      await fs.mkdir(path.dirname(archivePath), { recursive: true });
      try { await fs.writeFile(archivePath, active.bytes, { flag: "wx" }); } catch (error) {
        if (error.code !== "EEXIST" || digest(await fs.readFile(archivePath)) !== active.file_sha256) throw error;
      }
      await fs.writeFile(temporaryPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
      await fs.rename(temporaryPath, outputPath);
    }
    return outputPath;
  } finally {
    await fs.rm(temporaryPath, { force: true });
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}

export function assertLowMarginActiveBindings(binding, activeBindings) {
  if (!binding) return;
  if (BINDINGS.some((key) => !HASH.test(String(activeBindings?.[key] ?? ""))
    || binding.receipt.bindings[key] !== activeBindings[key])) {
    throw new Error("Low-margin disposition does not match the effective finalizer inputs.");
  }
}

export function applyLowMarginDisposition(decision, unitId, binding) {
  if (!binding) return decision;
  const receipt = binding.receipt;
  const row = receipt.units.find((unit) => unit.unit_id === unitId);
  if (!row) return decision;
  let applied = false;
  const warnings = (decision.warnings ?? []).map((finding) => {
    if (finding.code !== LOW_MARGIN_CODE) return finding;
    if (finding.cosine_similarity !== row.cosine_similarity
      || finding.warning_floor !== row.warning_below_cosine_similarity) {
      throw new Error(`Low-margin warning changed for approved unit ${unitId}.`);
    }
    applied = true;
    return { ...finding, review_required: false, automatic_retry_allowed: false,
      disposition: "explicit_low_margin_sampling_policy", disposition_sha256: receipt.disposition_sha256 };
  });
  if (!applied) return decision;
  return { ...decision, warnings, review_required: warnings.some((finding) => finding.review_required === true),
    low_margin_disposition_sha256: receipt.disposition_sha256 };
}

export async function readLowMarginContext({ episodeDir, episode }) {
  const paths = { source_script_sha256: path.join(episodeDir, "script_clean.md"),
    run_identity_sha256: path.join(episodeDir, "run_identity.json"),
    narration_generation_plan_file_sha256: path.join(episodeDir, "narration_generation_plan.json"),
    provider_output_manifest_file_sha256: path.join(episodeDir, `narration_provider_output_manifest_${episode}.json`),
    speaker_similarity_file_sha256: path.join(episodeDir, `narration_speaker_similarity_${episode}.json`) };
  const buffers = await Promise.all(Object.values(paths).map((file) => fs.readFile(file)));
  const bindings = Object.fromEntries(Object.keys(paths).map((key, index) => [key, digest(buffers[index])]));
  const [, identity, plan, manifest, report] = buffers.map((bytes, index) => index ? JSON.parse(bytes.toString("utf8")) : null);
  if (identity.media_workflow !== "generated_visuals_v1" || identity.episode !== episode) {
    throw new Error("Low-margin disposition requires the exact generated-visuals episode identity.");
  }
  const policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true });
  const qualityContract = narrationQualityContractForIdentity(identity);
  if (!qualityContract || plan.status !== "passed"
    || plan.source_script_hash !== bindings.source_script_sha256
    || plan.plan_sha256 !== canonicalNarrationPlanSha256(plan)) {
    throw new Error("Low-margin disposition source, plan, or voice policy is invalid.");
  }
  bindings.narration_generation_plan_sha256 = plan.plan_sha256;
  bindings.narration_quality_contract_sha256 = qualityContract.contract_sha256;
  if (validateNarrationProviderOutputManifest(manifest, plan.units, {
    generationPlanSha256: plan.plan_sha256, generationPlanFileSha256: bindings.narration_generation_plan_file_sha256,
    qualityContractSha256: qualityContract.contract_sha256, provider: policy.primary.provider,
    voiceId: policy.primary.voice_id, voiceSha256: policy.primary.voice_sha256,
  }).status !== "passed") throw new Error("Low-margin disposition provider manifest is invalid.");
  const profile = policy.primary;
  for (const [file, expected] of [[profile.reference_manifest_path, profile.reference_manifest_sha256],
    [profile.speaker_similarity_model_path, profile.speaker_similarity_model_sha256],
    [profile.speaker_similarity_calibration_path, profile.speaker_similarity_calibration_sha256]]) {
    if (await sha256File(file) !== expected) throw new Error("Low-margin reference/model/calibration evidence is stale.");
  }
  const referenceManifest = JSON.parse(await fs.readFile(profile.reference_manifest_path, "utf8"));
  const references = (referenceManifest.references ?? referenceManifest.reference_variants ?? referenceManifest.samples ?? [])
    .filter((row) => row.status === "ready" && (row.wav_path ?? row.audio_path ?? row.path))
    .map((row) => path.resolve(row.wav_path ?? row.audio_path ?? row.path));
  if (!equal(references, (report.references ?? []).map((row) => path.resolve(row.audio_path)))) {
    throw new Error("Low-margin owned reference set is stale.");
  }
  for (const row of report.references) {
    if (await sha256File(row.audio_path) !== row.audio_sha256) throw new Error("Low-margin reference audio hash is stale.");
  }
  return assertLowMarginEvidence({ bindings, report, manifest, profile, qualityContract });
}

export async function loadLowMarginDisposition(options) {
  const record = await readLowMarginDispositionRecord(options);
  if (!record) {
    if (options.expectedBinding) throw new Error("Bound low-margin disposition receipt is missing.");
    return null;
  }
  const context = options.context ?? await readLowMarginContext(options);
  const receipt = assertLowMarginDisposition(record.receipt, context);
  const binding = { path: record.path, file_sha256: record.file_sha256, receipt };
  if (Object.hasOwn(options, "expectedBinding") && !equal(binding, options.expectedBinding)) {
    throw new Error("Low-margin disposition changed; refresh exact delivery review from retained audio and checkpoints.");
  }
  return binding;
}
