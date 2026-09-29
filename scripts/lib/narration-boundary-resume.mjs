// Read-only recovery admission for a completed exact-boundary repair whose
// derived provider manifest was not promoted by a blocked finalization.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256File } from "./file-hash.mjs";
import {
  narrationProviderOutputManifestSha256,
  narrationSynthesisIdentitySha256,
  validateNarrationProviderOutputManifest,
} from "./narration-provider-adapter.mjs";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";

const hex = (value) => /^[0-9a-f]{64}$/.test(String(value ?? ""));
const sameIds = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length
  && new Set(left).size === left.length
  && new Set(right).size === right.length
  && [...left].sort().join("\n") === [...right].sort().join("\n");
const within = (root, target) => typeof target === "string"
  && path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`);
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const hash = async (file) => sha256File(file).catch(() => null);
const textHash = (text) => createHash("sha256").update(text).digest("hex");

export async function exactBoundaryRepairResumeCandidate({
  episodeDir, episode, repairDir, identity, plan, planUnits, planFileSha256,
  qualityContractSha256, policy, ttsReport, unitDelivery,
  currentScriptHash, currentComparisonVersion,
  validateProvider = validateNarrationProviderOutputManifest,
  fileHash = hash,
}) {
  try {
    const canonicalPath = path.join(episodeDir,
      `narration_provider_output_manifest_${episode}.json`);
    const requestPath = path.join(repairDir, "request.json");
    const resultPath = path.join(repairDir, "repair-result.json");
    const priorPath = path.join(repairDir, "prior_manifest.json");
    const derivedPath = path.join(repairDir, "provider-output-manifest.json");
    const [request, result, prior, derived] = await Promise.all(
      [requestPath, resultPath, priorPath, derivedPath].map(read));
    const requestIds = request.units?.map((row) => row.unit_id);
    const resultIds = result.units?.map((row) => row.unit_id);
    const repairedIds = derived.provider_execution?.exact_boundary_repair?.repaired_unit_ids;
    const reportBlockers = ttsReport?.blockers ?? [];
    const deliveryBlockers = unitDelivery?.blockers ?? [];
    const blockKeys = (rows) => rows.map((row) => `${row.unit_id}|${row.code}`).sort();
    const reportPath = path.resolve(ttsReport?.provider_output_manifest_path ?? "");
    const reportUsesPrior = reportPath === canonicalPath;
    const reportUsesDerived = reportPath === derivedPath;
    if (!hex(path.basename(repairDir))
      || !within(episodeDir, repairDir)
      || request.schema !== "goldflow_tts_exact_boundary_repair_request_v1"
      || result.schema !== "goldflow_tts_exact_boundary_repair_result_v1"
      || request.request_sha256 !== path.basename(repairDir)
      || canonicalQwenBatchSha256(Object.fromEntries(
        Object.entries(request).filter(([key]) => key !== "request_sha256"))) !== request.request_sha256
      || result.request_sha256 !== request.request_sha256
      || result.request_path !== requestPath
      || result.request_file_sha256 !== await fileHash(requestPath)
      || !sameIds(requestIds, resultIds)
      || !sameIds(requestIds, repairedIds)
      || request.episode_dir !== episodeDir
      || request.identity_sha256 !== await fileHash(path.join(episodeDir, "run_identity.json"))
      || request.plan_sha256 !== plan?.plan_sha256
      || request.plan_file_sha256 !== planFileSha256
      || request.prior_manifest_file_sha256 !== await fileHash(priorPath)
      || request.prior_manifest_file_sha256 !== await fileHash(canonicalPath)
      || request.prior_manifest_sha256 !== prior.manifest_sha256
      || request.prior_report_file_sha256 !== await fileHash(path.join(repairDir, "prior_report.json"))
      || request.prior_delivery_file_sha256 !== await fileHash(path.join(repairDir, "prior_delivery.json"))
      || (request.prior_full_stream_file_sha256
        && request.prior_full_stream_file_sha256 !== await fileHash(path.join(repairDir, "prior_full_stream.json")))
      || request.spec_file_sha256 !== await fileHash(path.join(episodeDir,
        `narration_exact_boundary_repair_spec_${episode}.json`))
      || request.model_id !== policy.primary.model_id
      || request.model_revision !== policy.primary.model_revision
      || request.voice_id !== policy.primary.voice_id
      || request.voice_sha256 !== policy.primary.voice_sha256
      || derived.provider_execution.exact_boundary_repair.request_sha256 !== request.request_sha256
      || derived.provider_execution.exact_boundary_repair.result_sha256 !== await fileHash(resultPath)
      || derived.provider_execution.exact_boundary_repair.preserved_unit_count
        !== derived.units?.length - requestIds.length
      || !derived.repair_history?.some((entry) =>
        entry.mode === "exact_sentence_boundary_composite_v1"
        && entry.prior_manifest_sha256 === prior.manifest_sha256
        && entry.request_sha256 === request.request_sha256)
      || prior.manifest_sha256 !== narrationProviderOutputManifestSha256(prior)
      || derived.manifest_sha256 !== narrationProviderOutputManifestSha256(derived)
      || ttsReport?.status !== "blocked"
      || ttsReport.unit_qa_status !== "blocked"
      || ttsReport.full_stream_qa_status !== "not_run_due_to_unit_blockers"
      || unitDelivery?.status !== "blocked"
      || reportBlockers.length === 0
      || JSON.stringify(blockKeys(reportBlockers)) !== JSON.stringify(blockKeys(deliveryBlockers))
      || !reportBlockers.every((row) => row.unit_id
        && (requestIds.includes(row.unit_id)
          || request.orthographic_equivalence_unit_ids?.includes(row.unit_id)))
      || !reportUsesPrior && !reportUsesDerived
      || reportUsesDerived && unitDelivery.transcript_comparison_version === currentComparisonVersion
      || ttsReport.provider_output_manifest_sha256 !== await fileHash(reportPath)
      || ttsReport.source_script_hash !== currentScriptHash
      || unitDelivery.source_script_hash !== currentScriptHash
      || plan.source_script_hash !== currentScriptHash
      || ttsReport.narration_generation_plan_sha256 !== plan.plan_sha256
      || unitDelivery.narration_generation_plan_sha256 !== plan.plan_sha256
      || ttsReport.narration_generation_plan_file_sha256 !== planFileSha256
      || unitDelivery.narration_generation_plan_file_sha256 !== planFileSha256
      || ttsReport.narration_quality_contract_sha256 !== qualityContractSha256
      || unitDelivery.quality_contract_sha256 !== qualityContractSha256) return null;

    const expected = {
      generationPlanSha256: plan.plan_sha256,
      generationPlanFileSha256: planFileSha256,
      qualityContractSha256,
      provider: policy.primary.provider,
      voiceId: policy.primary.voice_id,
      voiceSha256: policy.primary.voice_sha256,
    };
    if (validateProvider(prior, planUnits, expected).status !== "passed"
      || validateProvider(derived, planUnits, expected).status !== "passed") return null;
    const priorById = new Map(prior.units.map((row) => [row.unit_id, row]));
    const resultById = new Map(result.units.map((row) => [row.unit_id, row]));
    const requestById = new Map(request.units.map((row) => [row.unit_id, row]));
    if (priorById.size !== prior.units.length || derived.units.length !== prior.units.length) return null;
    for (const row of derived.units) {
      const old = priorById.get(row.unit_id);
      if (!old || !within(episodeDir, row.audio_path)
        || await fileHash(row.audio_path) !== row.audio_sha256) return null;
      const requested = requestById.get(row.unit_id);
      if (!requested) {
        if (JSON.stringify(row) !== JSON.stringify(old)) return null;
        continue;
      }
      const repaired = resultById.get(row.unit_id);
      const provenance = row.recovery_provenance;
      const synthesis = row.synthesis_identity;
      if (!repaired || !within(repairDir, row.audio_path)
        || requested.spoken_text_sha256 !== row.spoken_text_sha256
        || requested.prior_audio_sha256 !== old.audio_sha256
        || requested.prior_synthesis_identity_sha256 !== old.synthesis_identity_sha256
        || requested.fragments?.join(" ") !== planUnits.find((unit) => unit.unit_id === row.unit_id)?.spoken_text
        || repaired.spoken_text_sha256 !== row.spoken_text_sha256
        || repaired.audio_path !== row.audio_path
        || repaired.audio_sha256 !== row.audio_sha256
        || row.synthesis_mode !== "exact_sentence_boundary_composite_v1"
        || provenance?.schema !== "goldflow_tts_exact_boundary_repair_provenance_v1"
        || provenance.request_path !== requestPath
        || provenance.request_sha256 !== request.request_sha256
        || provenance.result_path !== resultPath
        || provenance.result_sha256 !== await fileHash(resultPath)
        || provenance.prior_audio_sha256 !== old.audio_sha256
        || provenance.prior_synthesis_identity_sha256 !== old.synthesis_identity_sha256
        || synthesis?.schema !== "goldflow_tts_exact_boundary_composite_identity_v1"
        || synthesis.request_sha256 !== request.request_sha256
        || synthesis.prior_audio_sha256 !== old.audio_sha256
        || synthesis.prior_synthesis_identity_sha256 !== old.synthesis_identity_sha256
        || synthesis.composite_audio_sha256 !== row.audio_sha256
        || row.synthesis_identity_sha256 !== narrationSynthesisIdentitySha256(synthesis)
        || JSON.stringify(repaired.fragments?.map((part) => part.text_sha256))
          !== JSON.stringify(requested.fragments?.map(textHash))) return null;
      for (const fragment of repaired.fragments) {
        if (!within(repairDir, fragment.audio_path)
          || !within(repairDir, fragment.sidecar_path)
          || await fileHash(fragment.audio_path) !== fragment.audio_sha256
          || await fileHash(fragment.sidecar_path) !== fragment.sidecar_sha256) return null;
      }
    }
    for (const blocker of reportBlockers) {
      const selected = (reportUsesPrior ? prior : derived).units.find(
        (row) => row.unit_id === blocker.unit_id);
      const reportRow = ttsReport.results?.find((row) => row.unit_id === blocker.unit_id);
      if (!selected || reportRow?.audio_sha256 !== selected.audio_sha256
        || reportRow.audio_path !== selected.audio_path) return null;
    }
    return { manifestPath: derivedPath, repairedUnitIds: requestIds };
  } catch {
    return null;
  }
}

export async function findExactBoundaryRepairResumeManifest(options) {
  const base = path.join(options.episodeDir,
    "assets/audio/narration_tts/exact_boundary_repairs");
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  const valid = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !hex(entry.name)) continue;
    const candidate = await exactBoundaryRepairResumeCandidate({
      ...options, repairDir: path.join(base, entry.name),
    });
    if (candidate) valid.push(candidate);
  }
  return valid.length === 1 ? valid[0] : null;
}
