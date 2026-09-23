import { promises as fs } from "node:fs";
import path from "node:path";
import { stageChecklistFor } from "./pipeline-stage-registry.mjs";
import {
  RESTART_SCHEMA, assertRestartBaselineIdentity, baselineFileAllowlist, fileSha256,
  nonvisualIdentityBinding, objectHash, readJson, requiredBaselineFiles, validateBaselineStages,
} from "./openart-visual-restart.mjs";
import { FAL_ENDPOINTS, FAL_EPISODE_BUDGET, FAL_PRIMARY_PARAMS } from "./fal-provider.mjs";

export const FAL_VISUAL_FILES = Object.freeze([
  "visual_reference_plan.json", "section_image_prompts.json", "section_image_prompts_hardened.json",
  "transition_edit_plan_ep_01.json",
]);
function need(value, message) { if (!value) throw new Error(message); }
const providerLock = key => /^(image_|explicit_image_|style_reference_|reference_provider_pool$|scene_provider_pool$|reference_model$|reference_image_provider$|google_flow_|google_gemini_|chatgpt_web_(image_|fallback_)|federated_|chatgpt_image_|creative_submission_attempts$)/.test(key);
const mediaVisual = key => /image|reference_concurrency/.test(key) || /^(google_flow_|google_gemini_|federated_google_|hybrid_web_flow_)/.test(key);

export async function validateFalContract(contract) {
  need(contract?.schema === "goldflow_fal_image_contract_v1", "Fal image contract schema is required.");
  need(JSON.stringify(contract.endpoints) === JSON.stringify(FAL_ENDPOINTS), "Fal endpoints differ from the implemented exact IDs.");
  need(JSON.stringify(contract.primary_params) === JSON.stringify(FAL_PRIMARY_PARAMS), "Fal primary parameters must be low, 1920x1080 and PNG.");
  need(contract.normal_reference_mode === "one_positional_collage" && contract.maximum_references === 16, "Fal collage/reference limits are not locked.");
  need(contract.automatic_creative_retry === false && contract.automatic_failover === false, "Automatic creative retry/failover is forbidden.");
  need(contract.validation_concurrency === 8 && Number.isInteger(contract.production_concurrency) && contract.production_concurrency > 0 && contract.production_concurrency <= 10, "Fal concurrency exceeds the current purchase tier.");
  need(contract.warning_budget_usd === FAL_EPISODE_BUDGET.warning_usd && contract.hard_budget_usd === FAL_EPISODE_BUDGET.hard_usd, "Fal budget ceilings differ from policy.");
  need(path.isAbsolute(contract.reference_bank_manifest ?? "") && path.isAbsolute(contract.discovery_receipt ?? ""), "Fal contract needs absolute bank/discovery paths.");
  need(await fileSha256(contract.reference_bank_manifest) === contract.reference_bank_manifest_sha256, "Fal reference-bank binding is stale.");
  need(await fileSha256(contract.discovery_receipt) === contract.discovery_receipt_sha256, "Fal discovery binding is stale.");
  return contract;
}

export function createFalRestartIdentity({ baseline, targetDir, week, contract, git, receiptSha256, baselineIdentitySha256, createdAt, forkAt = null }) {
  // Fal may use the first OpenArt restart as its approved visual-plan baseline,
  // but it never changes or consumes that run's generated frame receipts.
  need(baseline?.schema === "goldflow_run_identity_v2" && baseline.run_intent === "production", "Fal restart requires a production identity.");
  need(baseline.content_profile === "manhwa_recap_v1" && baseline.media_workflow === "generated_visuals_v1", "Fal restart supports manhwa generated visuals only.");
  const next = structuredClone(baseline);
  Object.assign(next, { week, episode_dir: targetDir, status: "fal_visual_restart_imported", created_at: createdAt, updated_at: createdAt, git, image_provider: "fal_ai", image_provider_options: { fal: structuredClone(contract) } });
  for (const key of Object.keys(next.provider_locks ?? {})) if (providerLock(key)) delete next.provider_locks[key];
  next.provider_locks = { ...next.provider_locks, image_provider: "fal_ai", reference_image_provider: "fal_ai", image_model: contract.endpoints.primary_edit, reference_model: contract.endpoints.primary_edit, creative_submission_attempts: 1, image_automatic_retry_policy: "transport_only_no_billable_output", image_automatic_provider_failover_policy: "none" };
  next.model_versions = { ...next.model_versions, image_model: contract.endpoints.primary_edit, reference_model: contract.endpoints.primary_edit, image_provider_models: { fal_ai: { image_model: contract.endpoints.primary_edit, reference_model: contract.endpoints.primary_edit } } };
  if (next.production_profile_config?.media) {
    for (const key of Object.keys(next.production_profile_config.media)) if (mediaVisual(key)) delete next.production_profile_config.media[key];
    Object.assign(next.production_profile_config.media, { default_image_provider: "fal_ai", image_concurrency: contract.production_concurrency, reference_concurrency: contract.validation_concurrency });
  }
  next.visual_restart = { schema: RESTART_SCHEMA, provider: "fal_ai", receipt_path: path.join(targetDir, "visual_restart_receipt.json"), receipt_sha256: receiptSha256, baseline_episode_dir: baseline.episode_dir, baseline_identity_sha256: baselineIdentitySha256, historical_visuals_policy: "immutable_excluded_from_fal_production", approved_visual_plan_carryforward: forkAt !== "visual_reference_plan", ...(forkAt ? { fork_at: forkAt } : {}) };
  next.stage_checklist = stageChecklistFor(next);
  need(objectHash(nonvisualIdentityBinding(next)) === objectHash(nonvisualIdentityBinding(baseline)), "Fal restart altered a nonvisual contract.");
  return next;
}

export async function falRestartBaselineState({ episodeDir, identity }) {
  if (identity?.image_provider !== "fal_ai") return null;
  try {
    const contract = await validateFalContract(identity.image_provider_options?.fal);
    const binding = identity.visual_restart; const receipt = await readJson(binding?.receipt_path);
    need(binding?.provider === "fal_ai" && receipt?.target_episode_dir === episodeDir, "Fal restart receipt/identity mismatch.");
    need(await fileSha256(binding.receipt_path) === binding.receipt_sha256, "Fal restart receipt changed.");
    need(await fileSha256(path.join(binding.baseline_episode_dir, "run_identity.json")) === binding.baseline_identity_sha256, "Fal baseline identity changed.");
    const snapshot = await readJson(path.join(episodeDir, "baseline_status_snapshot.json"));
    const statuses = validateBaselineStages(snapshot);
    for (const row of receipt.files ?? []) {
      need(await fileSha256(row.source_path) === row.sha256 && await fileSha256(path.join(episodeDir, row.relative_path)) === row.sha256, `Fal carryforward changed: ${row.relative_path}`);
    }
    const earlyReferenceFork = binding.fork_at === "visual_reference_plan";
    for (const name of [...requiredBaselineFiles(identity.episode), ...(earlyReferenceFork ? [] : [...FAL_VISUAL_FILES, "fal/catalog.json"])]) need((receipt.files ?? []).some(row => row.relative_path === name), `Fal carryforward missing ${name}.`);
    const stageStates = Object.fromEntries(statuses.filter(row => row.stage !== "run_identity").map(row => [row.stage, { done: true, ...(row.state === "skipped_with_waiver" ? { state: row.state } : {}), evidence: "Exact approved baseline carryforward" }]));
    if (!earlyReferenceFork) Object.assign(stageStates, {
      visual_reference_plan: { done: true, evidence: "Approved provider-neutral visual reference plan carried by hash" },
      reference_plan_approval: { done: true, evidence: "Operator-authorized Fal reuse of the approved provider-neutral reference plan" },
      reference_generation: { done: true, evidence: `Approved local canonical bank reused (${contract.reference_bank_manifest_sha256.slice(0, 12)})` },
      visual_prompt_plan: { done: true, evidence: "Approved visual prompt plan carried by hash" },
      visual_prompt_harden: { done: true, evidence: "Approved hardened visual prompt plan carried by hash" },
      visual_prompt_blocker_repair: { state: "skipped_with_waiver", evidence: "Approved hardened prompt plan has no unresolved blocker" },
      transition_edit_plan: { done: true, evidence: "Approved transition plan carried by hash" },
    });
    return { done: true, evidence: "Fal identity, provider-neutral bank and approved visual plan carryforward are current", stageStates };
  } catch (error) { return { done: false, evidence: error.message, stageStates: {} }; }
}

export { baselineFileAllowlist };
