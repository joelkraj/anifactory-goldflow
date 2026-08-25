import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  configuredCodexModel,
  configuredCodexReasoningEffort,
  runCodexCli,
} from "./codex-cli-runner.mjs";

export const IMAGE_SEMANTIC_AUDIT_SCHEMA = "goldflow_image_semantic_audit_v1";
export const IMAGE_SEMANTIC_AUDIT_ROW_SCHEMA = "goldflow_image_semantic_audit_row_v1";
export const IMAGE_SEMANTIC_AUDIT_VERSION = "2026-08-21.2";

const VALID_VERDICTS = new Set(["pass", "fail", "uncertain", "not_applicable"]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileHash(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function parseModelJson(value) {
  const text = cleanText(value);
  try {
    return JSON.parse(text);
  } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error("Image semantic auditor did not return a JSON object.");
}

function deterministicSampleSelected(imageId, rate) {
  if (rate <= 0) return false;
  return Number.parseInt(sha256(String(imageId)).slice(0, 8), 16) / 0xffffffff < rate;
}

function visibleCount(prompt) {
  return new Set([
    ...(prompt?.shot_manifest?.visible_characters ?? []),
    ...(prompt?.visible_characters ?? []),
  ].map(cleanText).filter(Boolean)).size;
}

function qualityTier(prompt) {
  return cleanText(prompt?.quality_budget?.tier ?? prompt?.beat_value?.tier ?? prompt?.beat_value?.value_tier).toLowerCase();
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function identityCritical(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  const visibleCharacters = rows(manifest.visible_characters ?? prompt?.visible_characters).map(cleanText).filter(Boolean);
  const referenceSlots = rows(manifest.reference_slots ?? prompt?.reference_requirements);
  const identitySlots = referenceSlots.filter((slot) => {
    const kind = cleanText(slot?.kind ?? slot?.conditioning_asset_role ?? slot?.identity_subtype).toLowerCase();
    const priority = cleanText(slot?.reference_priority).toLowerCase();
    return /character|identity|creature|construct|faction/.test(kind)
      || /decisive_subject|contact_counterpart|readable_identity/.test(priority);
  });
  const explicitCritical = manifest.identity_critical === true
    || prompt?.identity_critical === true
    || prompt?.quality_budget?.identity_critical === true;
  const denseNamedCast = visibleCharacters.length >= 3;
  const deltaKind = cleanText(prompt?.visual_information_delta?.kind).toLowerCase();
  const sequenceRole = cleanText(prompt?.sequence_grammar?.sequence_role).toLowerCase();
  const decisiveRelationshipReveal = visibleCharacters.length >= 2
    && identitySlots.length >= 2
    && new Set(["new_character_state", "new_relationship_evidence"]).has(deltaKind)
    && /reveal|prove|resolve/.test(sequenceRole);
  const anatomyText = rows(manifest.anatomy_contracts).map((entry) => (
    typeof entry === "string" ? entry : JSON.stringify(entry)
  )).join(" ");
  const materialIdentityState = deltaKind === "new_character_state"
    && /amput|missing limb|prosthe|injur|wound|scar|transform|disguis|mask|helmet|uniform|age|form/i.test(anatomyText);
  return explicitCritical || denseNamedCast || decisiveRelationshipReveal || materialIdentityState;
}

function semanticRiskReasons(prompt, { openingSec = 120, ordinarySampleRate = 0.05 } = {}) {
  const manifest = prompt?.shot_manifest ?? {};
  const reasons = [];
  const tier = qualityTier(prompt);
  const startSec = Number(prompt?.start_sec ?? Number.POSITIVE_INFINITY);
  if (Number.isFinite(startSec) && startSec >= 0 && startSec < openingSec) reasons.push("opening_retention");
  if (tier === "hero" || Number(prompt?.quality_budget?.image_candidate_count ?? 1) > 1) reasons.push("hero_beat");
  const shotClass = cleanText(manifest.shot_job);
  const foregroundAction = cleanText(manifest.foreground_action);
  if (/physical_contact|contact_action/i.test(shotClass)
    || /contact\b|handoff|catch|block|strike|stab|lift|carry|grab|pin|restrain|collid|clash|impact|grapple|shove|push|pull/i.test(foregroundAction)) {
    reasons.push("action_contact_geometry");
  }
  if (identityCritical(prompt)) reasons.push("identity_critical");
  const reversalText = [
    prompt?.visual_job,
    prompt?.visual_information_delta?.kind,
    prompt?.visual_information_delta?.description,
    prompt?.sequence_grammar?.sequence_role,
    manifest?.foreground_action,
  ].map(cleanText).join(" ");
  if (/\b(?:reversal|revenge|payoff|grovel|humiliat|betrayal reveal|status reveal|power reveal|public defeat|public victory|shocked reaction)\b/i.test(reversalText)) {
    reasons.push("major_reversal_or_payoff");
  }
  if (!reasons.length && deterministicSampleSelected(prompt?.image_id, ordinarySampleRate)) reasons.push("deterministic_ordinary_sample");
  return [...new Set(reasons)];
}

function requiredDimensions(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  const dimensions = ["scene_event", "composition"];
  if ((manifest.visible_characters ?? []).length) dimensions.push("identity_and_subject_count");
  if (manifest.foreground_action) dimensions.push("action_and_contact_geometry");
  if ((manifest.anatomy_contracts ?? []).length) dimensions.push("body_state_and_anatomy");
  if ((manifest.equipment_contracts ?? []).length || (manifest.visible_props ?? []).length) dimensions.push("equipment_and_prop_count");
  if (manifest.location_contract_id || manifest.location_ref_id || prompt?.location) dimensions.push("location_continuity");
  if (manifest.spatial_continuity || manifest.continuity_notes) dimensions.push("screen_direction_and_geography");
  if ((manifest.ui_elements ?? []).length) dimensions.push("ui_hierarchy");
  if ((manifest.mentioned_only_characters ?? []).length || (manifest.forbidden_ref_ids ?? []).length) dimensions.push("forbidden_or_mentioned_only_elements");
  return [...new Set(dimensions)];
}

function compactContract(prompt) {
  const manifest = prompt?.shot_manifest ?? {};
  return {
    image_id: prompt?.image_id,
    neutral_scene_description: prompt?.provider_prompt ?? prompt?.image_prompt ?? prompt?.codex_image_prompt ?? null,
    visual_job: prompt?.visual_job ?? null,
    visual_information_delta: prompt?.visual_information_delta ?? null,
    required_dimensions: requiredDimensions(prompt),
    shot_manifest: {
      shot_job: manifest.shot_job ?? null,
      visible_characters: manifest.visible_characters ?? [],
      mentioned_only_characters: manifest.mentioned_only_characters ?? [],
      foreground_action: manifest.foreground_action ?? null,
      character_staging: manifest.character_staging ?? [],
      anatomy_contracts: manifest.anatomy_contracts ?? [],
      equipment_contracts: manifest.equipment_contracts ?? [],
      background_population: manifest.background_population ?? null,
      visible_props: manifest.visible_props ?? [],
      ui_elements: manifest.ui_elements ?? [],
      location_contract_id: manifest.location_contract_id ?? null,
      location_ref_id: manifest.location_ref_id ?? null,
      spatial_continuity: prompt?.spatial_continuity ?? manifest.spatial_continuity ?? null,
      continuity_notes: manifest.continuity_notes ?? null,
      forbidden_ref_ids: manifest.forbidden_ref_ids ?? [],
    },
  };
}

function safeFileSegment(value) {
  const normalized = cleanText(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "image";
}

function auditCacheIdentity({ provider, model, reasoningEffort }) {
  return {
    audit_version: IMAGE_SEMANTIC_AUDIT_VERSION,
    provider,
    model,
    reasoning_effort: reasoningEffort,
  };
}

function auditRowCacheKey({ imageSha256, contractSha256, cacheIdentity }) {
  return sha256(JSON.stringify({
    image_sha256: imageSha256,
    compact_contract_sha256: contractSha256,
    ...cacheIdentity,
  }));
}

function reusableCachedRow(row, { imageSha256, contractSha256, cacheIdentity, cacheKey }) {
  return row?.schema === IMAGE_SEMANTIC_AUDIT_ROW_SCHEMA
    && row?.status === "audited"
    && row?.image_sha256 === imageSha256
    && row?.contract_sha256 === contractSha256
    && row?.audit_cache_key === cacheKey
    && JSON.stringify(row?.audit_cache_identity ?? null) === JSON.stringify(cacheIdentity);
}

function auditPrompt(prompt) {
  const contract = compactContract(prompt);
  return `You are a strict visual continuity QA reviewer. Inspect the attached generated raster and compare only what is visibly present against the supplied shot contract. Do not reward beauty when the event is wrong. Do not infer hidden limbs, off-screen people, unreadable objects, or contact that is not visually proven. Generated UI wording need not be letter-perfect; judge the requested hierarchy, counts, and dominant visual idea instead.

For every required dimension, return pass, fail, or uncertain and cite concise visible evidence. Use uncertain rather than guessing. A failure means a materially wrong identity, subject count, action/contact relationship, body state, object count/ownership, location, screen geography, or forbidden visible element. Minor taste, exact prose wording, incidental background text, and harmless anatomy that the contract does not require are not failures.

SHOT CONTRACT:
${JSON.stringify(contract, null, 2)}

Return JSON only:
{
  "schema": "${IMAGE_SEMANTIC_AUDIT_ROW_SCHEMA}",
  "image_id": ${JSON.stringify(prompt?.image_id ?? null)},
  "checks": [{"dimension":"one required dimension","verdict":"pass|fail|uncertain","visible_evidence":"specific visible evidence","discrepancy":null}],
  "overall_verdict": "pass|needs_review",
  "critical_discrepancies": [],
  "confidence": "low|medium|high",
  "one_sentence_verdict": "literal visual verdict"
}`;
}

function normalizeAuditResponse(prompt, response) {
  const required = requiredDimensions(prompt);
  const byDimension = new Map((Array.isArray(response?.checks) ? response.checks : []).map((row) => [cleanText(row?.dimension), row]));
  const checks = required.map((dimension) => {
    const source = byDimension.get(dimension) ?? {};
    const verdict = VALID_VERDICTS.has(cleanText(source.verdict).toLowerCase())
      ? cleanText(source.verdict).toLowerCase()
      : "uncertain";
    return {
      dimension,
      verdict: verdict === "not_applicable" ? "uncertain" : verdict,
      visible_evidence: cleanText(source.visible_evidence) || "No grounded visible evidence supplied.",
      discrepancy: cleanText(source.discrepancy) || null,
    };
  });
  const nonPass = checks.filter((row) => row.verdict !== "pass");
  return {
    schema: IMAGE_SEMANTIC_AUDIT_ROW_SCHEMA,
    image_id: cleanText(prompt?.image_id),
    checks,
    overall_verdict: nonPass.length ? "needs_review" : "pass",
    critical_discrepancies: Array.isArray(response?.critical_discrepancies)
      ? response.critical_discrepancies.map(cleanText).filter(Boolean)
      : [],
    confidence: new Set(["low", "medium", "high"]).has(cleanText(response?.confidence).toLowerCase())
      ? cleanText(response.confidence).toLowerCase()
      : "low",
    one_sentence_verdict: cleanText(response?.one_sentence_verdict) || (nonPass.length ? "The raster needs targeted review." : "The raster visibly satisfies the audited shot contract."),
  };
}

async function defaultAuditExecutor({ prompt, imagePath, outputPath, repoRoot, provider, model, reasoningEffort, timeoutMs }) {
  const result = await runCodexCli({
    prompt: auditPrompt(prompt),
    stageName: "image_semantic_audit",
    repoRoot,
    outputPath,
    model,
    reasoningEffort,
    verbosity: "low",
    timeoutMs,
    provider,
    extraArgs: ["--sandbox", "read-only", "--image", imagePath],
  });
  return parseModelJson(result.content);
}

async function runPool(rows, concurrency, worker) {
  const output = new Array(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), rows.length || 1) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= rows.length) return;
      output[index] = await worker(rows[index], index);
    }
  }));
  return output;
}

export function semanticAuditSelectionForTests(prompt, options = {}) {
  const reasons = semanticRiskReasons(prompt, options);
  return { selected: reasons.length > 0, reasons, required_dimensions: requiredDimensions(prompt) };
}

export async function buildImageSemanticAudit({
  promptPlan,
  imagegenReport,
  promptPlanPath,
  imagegenReportPath,
  outputPath,
  callsDir,
  repoRoot,
  concurrency = 8,
  openingSec = 120,
  ordinarySampleRate = 0.05,
  model = null,
  reasoningEffort = "medium",
  auditProvider = "codex_cli",
  timeoutMs = 600_000,
  auditExecutor = defaultAuditExecutor,
  generatedAt = new Date(),
} = {}) {
  if (!Array.isArray(promptPlan?.prompts) || !Array.isArray(imagegenReport?.results)) {
    throw new Error("Image semantic audit requires a prompt plan and image-generation results.");
  }
  const promptPlanSha256 = promptPlanPath ? await fileHash(promptPlanPath) : sha256(JSON.stringify(promptPlan));
  const imagegenReportSha256 = imagegenReportPath ? await fileHash(imagegenReportPath) : sha256(JSON.stringify(imagegenReport));
  const resolvedProvider = cleanText(auditProvider) || "codex_cli";
  const resolvedModel = configuredCodexModel(model);
  const resolvedReasoningEffort = configuredCodexReasoningEffort(
    reasoningEffort,
    "image_semantic_audit",
    resolvedProvider,
  );
  const cacheIdentity = auditCacheIdentity({
    provider: resolvedProvider,
    model: resolvedModel,
    reasoningEffort: resolvedReasoningEffort,
  });
  const selectionIdentity = {
    audit_version: IMAGE_SEMANTIC_AUDIT_VERSION,
    opening_sec: openingSec,
    ordinary_sample_rate: ordinarySampleRate,
  };
  const prior = outputPath ? await readJson(outputPath, null) : null;
  if (prior?.status === "passed"
    && prior.prompt_plan_sha256 === promptPlanSha256
    && prior.imagegen_report_sha256 === imagegenReportSha256
    && JSON.stringify(prior.audit_cache_identity ?? null) === JSON.stringify(cacheIdentity)
    && JSON.stringify(prior.selection_identity ?? null) === JSON.stringify(selectionIdentity)) return { ...prior, reused: true };
  const resultById = new Map(imagegenReport.results.map((row) => [cleanText(row?.image_id), row]));
  const targets = promptPlan.prompts.filter((prompt) => {
    if (prompt?.image_generation_required === false) return false;
    return semanticRiskReasons(prompt, { openingSec, ordinarySampleRate }).length > 0;
  }).map((prompt) => {
    const image = resultById.get(cleanText(prompt?.image_id));
    return {
      prompt,
      image_path: image?.image_path ? path.resolve(image.image_path) : null,
      selection_reasons: semanticRiskReasons(prompt, { openingSec, ordinarySampleRate }),
    };
  });
  const resolvedCallsDir = path.resolve(callsDir ?? path.join(path.dirname(outputPath), "reports", "image_semantic_audit_calls"));
  const rowCacheDir = path.join(resolvedCallsDir, "row-cache");
  const rawCallsDir = path.join(resolvedCallsDir, "raw");
  await Promise.all([
    fs.mkdir(rowCacheDir, { recursive: true }),
    fs.mkdir(rawCallsDir, { recursive: true }),
  ]);
  const rows = await runPool(targets, concurrency, async (target) => {
    const imageId = cleanText(target.prompt.image_id);
    if (!target.image_path || !await fs.stat(target.image_path).then((stat) => stat.isFile()).catch(() => false)) {
      return {
        schema: IMAGE_SEMANTIC_AUDIT_ROW_SCHEMA,
        image_id: imageId,
        status: "unavailable",
        selection_reasons: target.selection_reasons,
        overall_verdict: "needs_review",
        checks: requiredDimensions(target.prompt).map((dimension) => ({ dimension, verdict: "uncertain", visible_evidence: "Image file unavailable.", discrepancy: "image_missing" })),
        critical_discrepancies: ["image_missing"],
        confidence: "high",
        one_sentence_verdict: "The selected raster could not be audited because its file is missing.",
      };
    }
    const imageSha256 = await fileHash(target.image_path);
    const contractSha256 = sha256(JSON.stringify(compactContract(target.prompt)));
    const cacheKey = auditRowCacheKey({ imageSha256, contractSha256, cacheIdentity });
    const rowCachePath = path.join(rowCacheDir, `${safeFileSegment(imageId)}-${cacheKey}.json`);
    const cachedRow = await readJson(rowCachePath, null);
    if (reusableCachedRow(cachedRow, { imageSha256, contractSha256, cacheIdentity, cacheKey })) {
      return { ...cachedRow, selection_reasons: target.selection_reasons, reused: true, row_cache_path: rowCachePath };
    }
    const priorRow = prior?.rows?.find((row) => row.image_id === imageId
      && reusableCachedRow(row, { imageSha256, contractSha256, cacheIdentity, cacheKey }));
    if (priorRow) {
      const reusable = { ...priorRow, selection_reasons: target.selection_reasons, reused: true, row_cache_path: rowCachePath };
      await writeJsonAtomic(rowCachePath, reusable);
      return reusable;
    }
    const callOutputPath = path.join(rawCallsDir, `${safeFileSegment(imageId)}-${cacheKey}.json`);
    try {
      const response = await auditExecutor({
        prompt: target.prompt,
        imagePath: target.image_path,
        outputPath: callOutputPath,
        repoRoot,
        provider: resolvedProvider,
        model: resolvedModel,
        reasoningEffort: resolvedReasoningEffort,
        timeoutMs,
      });
      const normalized = normalizeAuditResponse(target.prompt, response);
      const auditedRow = {
        ...normalized,
        status: "audited",
        selection_reasons: target.selection_reasons,
        image_path: target.image_path,
        image_sha256: imageSha256,
        contract_sha256: contractSha256,
        audit_cache_identity: cacheIdentity,
        audit_cache_key: cacheKey,
        call_output_path: callOutputPath,
        call_output_sha256: await fs.stat(callOutputPath).then(() => fileHash(callOutputPath)).catch(() => null),
        row_cache_path: rowCachePath,
        reused: false,
      };
      await writeJsonAtomic(rowCachePath, auditedRow);
      return auditedRow;
    } catch (error) {
      return {
        schema: IMAGE_SEMANTIC_AUDIT_ROW_SCHEMA,
        image_id: imageId,
        status: "unavailable",
        selection_reasons: target.selection_reasons,
        image_path: target.image_path,
        image_sha256: imageSha256,
        contract_sha256: contractSha256,
        overall_verdict: "needs_review",
        checks: requiredDimensions(target.prompt).map((dimension) => ({
          dimension,
          verdict: "uncertain",
          visible_evidence: "Automated visual audit unavailable.",
          discrepancy: "audit_transport_unavailable",
        })),
        critical_discrepancies: [],
        confidence: "low",
        one_sentence_verdict: "Automated semantic QA was unavailable; retain the raster and review only if its quality tier requires it.",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const report = {
    schema: IMAGE_SEMANTIC_AUDIT_SCHEMA,
    status: "passed",
    generated_at: generatedAt.toISOString(),
    prompt_plan_path: promptPlanPath ?? null,
    prompt_plan_sha256: promptPlanSha256,
    imagegen_report_path: imagegenReportPath ?? null,
    imagegen_report_sha256: imagegenReportSha256,
    audit_cache_identity: cacheIdentity,
    selection_identity: selectionIdentity,
    policy: {
      selection: "opening_hero_contact_reversal_identity_critical_plus_deterministic_ordinary_sample",
      opening_sec: openingSec,
      ordinary_sample_rate: ordinarySampleRate,
      concurrency,
      provider: resolvedProvider,
      model: resolvedModel,
      reasoning_effort: resolvedReasoningEffort,
      location_and_ui_policy: "audit_dimensions_only_not_selection_reasons",
      result_policy: "model_findings_are_advisory; hero_or_audited_nonpass_requires_narrow_manual_review; no_automatic_regeneration",
    },
    selected_count: rows.length,
    audited_count: rows.filter((row) => row.status === "audited").length,
    unavailable_count: rows.filter((row) => row.status === "unavailable").length,
    passed_count: rows.filter((row) => row.overall_verdict === "pass").length,
    needs_review_count: rows.filter((row) => row.overall_verdict !== "pass").length,
    row_cache_hit_count: rows.filter((row) => row.reused === true).length,
    row_cache_miss_count: rows.filter((row) => row.status === "audited" && row.reused !== true).length,
    rows,
  };
  if (outputPath) await writeJsonAtomic(outputPath, report);
  return report;
}
