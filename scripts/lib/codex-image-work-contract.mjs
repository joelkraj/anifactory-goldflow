import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import sharp from "sharp";

export const CODEX_WORK_SCHEMA = "goldflow_codex_image_work_manifest_v1";
export const DEFAULT_LEASE_SECONDS = 900;
// One creative attempt per asset. A failed item is dead-lettered and repaired
// later by exact ID; the worker queue never silently asks for another image.
export const DEFAULT_MAX_ATTEMPTS = 1;
export const DEFAULT_ASPECT_RATIO = 16 / 9;
export const DEFAULT_ASPECT_TOLERANCE = 0.08;
export const DEFAULT_RECOMMENDED_CONCURRENCY = 8;
export const DEFAULT_MAX_CONCURRENCY = 12;
const LEASE_DISPATCH_LOCK_TIMEOUT_MS = 30_000;
const LEASE_DISPATCH_LOCK_STALE_MS = 60_000;

function nowIso() {
  return new Date().toISOString();
}

function asPositiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeBrowserProvider(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) return null;
  if (["chatgpt", "chatgpt-web", "openai"].includes(normalized)) return "chatgpt";
  if (["google-flow", "flow", "google", "nano-banana", "nano-banana-pro"].includes(normalized)) return "google-flow";
  if (["google-gemini", "gemini", "gemini-images", "nano-banana-2"].includes(normalized)) return "google-gemini";
  throw new Error(`Unsupported manifest browser provider: ${value}.`);
}

function browserProviderList(values) {
  const providers = [];
  for (const value of Array.isArray(values) ? values : String(values ?? "").split(",")) {
    const provider = normalizeBrowserProvider(value);
    if (provider && !providers.includes(provider)) providers.push(provider);
  }
  return providers;
}

function browserProviderConcurrency(value, allowedProviders) {
  if (!allowedProviders.length) return null;
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const provider of allowedProviders) {
    result[provider] = asPositiveInteger(source[provider], provider === "google-flow" ? 5 : 3, `${provider} concurrency`);
  }
  return result;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function codexWorkSourceRowSha256(row) {
  return sha256(stableStringify(row));
}

export async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

export async function pathExists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then(() => true).catch(() => false);
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJsonExclusive(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function assertAssetId(assetId) {
  const text = cleanText(assetId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
    throw new Error(`Unsafe or empty asset id: ${JSON.stringify(assetId)}.`);
  }
  return text;
}

export function parseIdScope(...values) {
  const ids = [];
  for (const value of values) {
    const rows = Array.isArray(value) ? value : String(value ?? "").split(",");
    for (const row of rows) {
      const id = cleanText(row);
      if (id && !ids.includes(id)) ids.push(assertAssetId(id));
    }
  }
  return ids;
}

function normalizeAbsolute(filePath, baseDir = process.cwd()) {
  const text = cleanText(filePath);
  if (!text) return null;
  return path.resolve(baseDir, text);
}

function promptForCodex(row) {
  for (const candidate of [
    row?.codex_image_prompt,
    row?.provider_prompt,
    row?.image_prompt,
    row?.modelslab_image_prompt,
    row?.prompt,
    row?.prompt_anchor,
  ]) {
    const text = cleanText(candidate);
    if (text) return text;
  }
  return "";
}

function routeIsCodex(row, plan) {
  const route = cleanText(
    row?.image_provider_route
    ?? row?.target_provider_route
    ?? row?.provider_route
    ?? row?.image_provider
    ?? row?.provider,
  ).toLowerCase();
  if (route) return route.includes("codex");
  const planRoute = cleanText(plan?.image_provider ?? plan?.provider).toLowerCase();
  return planRoute === "codex_imagegen";
}

function referencesDefaultToCodex(identity, plan) {
  const explicit = cleanText(plan?.reference_provider ?? plan?.reference_image_provider).toLowerCase();
  if (explicit) return explicit.includes("codex");
  const provider = cleanText(identity?.provider_locks?.image_provider ?? identity?.image_provider ?? plan?.image_provider).toLowerCase();
  return new Set([
    "codex_imagegen",
    "hybrid_codex_refs_multichar",
    "hybrid_codex_opening_modelslab_rest",
    "hybrid_codex_refs_opening_risky_modelslab_rest",
  ]).has(provider);
}

function sceneRows(plan) {
  if (Array.isArray(plan?.prompts)) return plan.prompts;
  if (Array.isArray(plan?.images)) return plan.images;
  return [];
}

function refTargetRows(plan) {
  return Array.isArray(plan?.reference_targets) ? plan.reference_targets : [];
}

function refRequiresGeneration(row) {
  const mode = cleanText(row?.generation_mode).toLowerCase();
  if (["no_ref_needed", "source_only", "derive_from_first_clean_cut", "derive_from_best_cut", "derive_from_first_clean_wide_cut"].includes(mode)) return false;
  if (row?.image_generation_required === false) return false;
  if (mode === "standalone_ref") return true;
  return row?.required_before_imagegen === true;
}

function exactScopedRows(rows, scope, idForRow, label) {
  const byId = new Map();
  for (const row of rows) {
    const id = cleanText(idForRow(row));
    if (!id) continue;
    if (byId.has(id)) throw new Error(`Duplicate ${label} id in source plan: ${id}.`);
    byId.set(id, row);
  }
  if (!scope.length) return { rows: [...byId.values()], ids: [...byId.keys()] };
  const missing = scope.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`Unknown ${label} ids: ${missing.join(", ")}.`);
  return { rows: scope.map((id) => byId.get(id)), ids: [...scope] };
}

function referenceSlotsForPrompt(prompt) {
  const candidates = [
    prompt?.reference_slots,
    prompt?.reference_requirements,
    prompt?.shot_manifest?.reference_slots,
  ];
  const rows = candidates.find((value) => Array.isArray(value) && value.length) ?? [];
  return rows
    .map((row, index) => ({
      ...row,
      ref_id: cleanText(row?.ref_id ?? row?.id),
      path: cleanText(row?.path ?? row?.reference_image_path ?? row?.conditioning_image_path),
      slot_order: Number(row?.slot_order ?? row?.slot ?? index + 1),
    }))
    .filter((row) => row.ref_id && row.path)
    .sort((left, right) => left.slot_order - right.slot_order || left.ref_id.localeCompare(right.ref_id));
}

async function bindReferenceInputs(slots, sourceDir) {
  const output = [];
  for (const [index, slot] of slots.entries()) {
    const referencePath = normalizeAbsolute(slot.path, sourceDir);
    if (!(await pathExists(referencePath))) throw new Error(`Missing reference input ${slot.ref_id}: ${referencePath}.`);
    output.push({
      slot: index + 1,
      ref_id: slot.ref_id,
      kind: cleanText(slot.kind) || null,
      purpose: cleanText(slot.purpose ?? slot.slot_purpose ?? slot.reason) || null,
      path: referencePath,
      sha256: await sha256File(referencePath),
    });
  }
  return output;
}

async function priorSceneHash(episodeDir, imageId, row) {
  const ledgerPath = path.join(episodeDir, "cut_execution_ledger.json");
  if (await pathExists(ledgerPath)) {
    const ledger = await readJson(ledgerPath).catch(() => null);
    const cut = (ledger?.cuts ?? ledger?.items ?? []).find((candidate) => cleanText(candidate?.image_id) === imageId);
    if (cleanText(cut?.image_sha256)) return cleanText(cut.image_sha256);
  }
  const imagePath = normalizeAbsolute(row?.image_path ?? row?.output_path, episodeDir);
  return imagePath && await pathExists(imagePath) ? await sha256File(imagePath) : null;
}

async function priorReferenceHash(row, episodeDir) {
  const imagePath = normalizeAbsolute(row?.reference_image_path ?? row?.conditioning_image_path, episodeDir);
  return imagePath && await pathExists(imagePath) ? await sha256File(imagePath) : null;
}

function buildReferenceLookup(referencePlan, characterStateRefs) {
  const lookup = new Map();
  for (const target of refTargetRows(referencePlan)) {
    for (const id of [target?.ref_id, target?.inventory_asset_id, target?.canonical_subject_id]) {
      const text = cleanText(id);
      if (text && !lookup.has(text)) lookup.set(text, target);
    }
  }
  for (const state of characterStateRefs?.character_state_refs ?? []) {
    for (const id of [state?.state_ref_id, state?.source_ref_id]) {
      const text = cleanText(id);
      if (text && !lookup.has(text)) lookup.set(text, state);
    }
  }
  return lookup;
}

function referenceDependencyIds(target) {
  const ids = [];
  const append = (value) => {
    const id = cleanText(value);
    if (id && id !== cleanText(target?.ref_id) && !ids.includes(id)) ids.push(id);
  };
  for (const value of [target?.base_identity_ref_id, target?.base_ref_id, target?.base_asset_id, target?.source_ref_id, target?.dependency_ref_id]) append(value);
  for (const field of [target?.dependency_ref_ids, target?.reference_ref_ids, target?.input_ref_ids]) {
    for (const value of Array.isArray(field) ? field : []) append(value);
  }
  for (const slot of [...(target?.reference_slots ?? []), ...(target?.reference_requirements ?? [])]) append(slot?.ref_id ?? slot?.id);
  return ids;
}

async function bindReferenceTargetInputs(target, lookup, sourceDir, sharedReferenceIds = []) {
  const slots = [];
  const dependencyIds = [...new Set([...referenceDependencyIds(target), ...sharedReferenceIds].map(cleanText).filter(Boolean))];
  for (const dependencyId of dependencyIds) {
    const dependency = lookup.get(dependencyId);
    if (!dependency) continue;
    if (cleanText(dependency.ref_id ?? dependency.state_ref_id) === cleanText(target.ref_id)) continue;
    const referencePath = normalizeAbsolute(dependency.reference_image_path ?? dependency.conditioning_image_path, sourceDir);
    if (!referencePath || !(await pathExists(referencePath))) continue;
    slots.push({
      slot: slots.length + 1,
      ref_id: cleanText(dependency.ref_id ?? dependency.state_ref_id ?? dependencyId),
      kind: cleanText(dependency.kind) || null,
      purpose: sharedReferenceIds.includes(dependencyId)
        ? `episode style conditioning for ${cleanText(target.ref_id)}`
        : `identity or state dependency for ${cleanText(target.ref_id)}`,
      path: referencePath,
      sha256: await sha256File(referencePath),
    });
  }
  if (slots.length > 4) {
    throw new Error(`Reference ${cleanText(target.ref_id)} requires ${slots.length} conditioning inputs after the shared style reference; provider limit is four.`);
  }
  return slots;
}

function expectedOutput(assetId) {
  return {
    filename: `${assetId}.png`,
    format: "png",
    orientation: "landscape",
    aspect_ratio: DEFAULT_ASPECT_RATIO,
    aspect_tolerance: DEFAULT_ASPECT_TOLERANCE,
  };
}

export function representativeVerificationAssetIds(items, limit = 4) {
  const rows = [...items];
  const picked = [];
  for (const desired of [0, 1, 2, 4]) {
    const candidate = rows.find((item) => {
      if (picked.includes(item.asset_id)) return false;
      if ((item.dependency_asset_ids ?? []).length) return false;
      const count = (item.ordered_references ?? []).length + (item.dependency_asset_ids ?? []).length;
      return desired === 4 ? count >= 3 : count === desired;
    });
    if (candidate) picked.push(candidate.asset_id);
  }
  for (const item of rows) {
    if (picked.length >= limit) break;
    if (!picked.includes(item.asset_id) && !(item.dependency_asset_ids ?? []).length) picked.push(item.asset_id);
  }
  for (const item of rows) {
    if (picked.length >= limit) break;
    if (picked.includes(item.asset_id)) continue;
    const missingDependencies = (item.dependency_asset_ids ?? []).filter((id) => !picked.includes(id));
    if (picked.length + missingDependencies.length + 1 > limit) continue;
    picked.push(...missingDependencies, item.asset_id);
  }
  return picked.slice(0, Math.max(1, limit));
}

function manifestContentForHash(manifest) {
  const { created_at: _createdAt, manifest_id: _manifestId, manifest_path: _manifestPath, content_sha256: _contentSha256, ...content } = manifest;
  return content;
}

async function sourceRecord(filePath) {
  const resolved = path.resolve(filePath);
  if (!(await pathExists(resolved))) throw new Error(`Missing source artifact: ${resolved}.`);
  return { path: resolved, sha256: await sha256File(resolved) };
}

async function verificationGateBypassRecord(value) {
  if (value === undefined || value === null || value === false) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Verification-gate bypass must be an evidence object; a boolean bypass is forbidden.");
  }
  const kind = cleanText(value.kind).toLowerCase();
  if (kind !== "prior_health_proof") {
    throw new Error("Verification-gate bypass kind must be prior_health_proof.");
  }
  const evidencePath = normalizeAbsolute(value.evidencePath ?? value.evidence_path ?? value.path);
  if (!evidencePath) throw new Error("Verification-gate bypass requires a prior health-proof evidence path.");
  const expectedSha256 = cleanText(value.evidenceSha256 ?? value.evidence_sha256 ?? value.sha256);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("Verification-gate bypass requires the exact lowercase SHA-256 of its prior health-proof evidence.");
  }
  const evidence = await sourceRecord(evidencePath);
  if (evidence.sha256 !== expectedSha256) {
    throw new Error(`Verification-gate bypass evidence hash mismatch for ${evidence.path}.`);
  }
  return {
    kind,
    evidence_path: evidence.path,
    evidence_sha256: evidence.sha256,
  };
}

async function repairEvidenceRecord(value, requestedAssetIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider-attributed repair requires structured hash-bound evidence.");
  }
  if (value.schema !== "goldflow_hybrid_image_repair_evidence_v1") {
    throw new Error("Unsupported hybrid image repair-evidence schema.");
  }
  const kind = cleanText(value.kind);
  if (!new Set([
    "provider_deadletters",
    "image_output_qa_blockers",
    "duplicate_output_hashes",
    "provider_deadletters_and_duplicate_output_hashes",
  ]).has(kind)) {
    throw new Error(`Unsupported hybrid image repair-evidence kind: ${kind || "missing"}.`);
  }
  const authorizedAssetIds = parseIdScope(value.authorized_asset_ids);
  const unauthorized = requestedAssetIds.filter((assetId) => !authorizedAssetIds.includes(assetId));
  if (unauthorized.length) throw new Error(`Repair evidence does not authorize: ${unauthorized.join(", ")}.`);
  const records = [];
  for (const [index, row] of (Array.isArray(value.records) ? value.records : []).entries()) {
    const evidencePath = normalizeAbsolute(row?.path);
    const expectedSha256 = cleanText(row?.sha256);
    if (!evidencePath || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error(`Repair evidence record ${index + 1} requires an absolute path and exact lowercase SHA-256.`);
    }
    const source = await sourceRecord(evidencePath);
    if (source.sha256 !== expectedSha256) throw new Error(`Repair evidence hash mismatch: ${evidencePath}.`);
    records.push(source);
  }
  if (!records.length) throw new Error("Repair evidence requires at least one hash-bound source record.");
  return {
    schema: value.schema,
    kind,
    authorized_asset_ids: authorizedAssetIds,
    requested_asset_ids: requestedAssetIds,
    records,
  };
}

export async function createCodexWorkManifest(options) {
  const mode = cleanText(options.mode || (options.referencesOnly ? "reference" : "scene")).toLowerCase();
  if (!new Set(["scene", "reference"]).has(mode)) throw new Error(`Unsupported Codex work mode: ${mode}.`);
  const maxAttempts = asPositiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, "max attempts");
  const leaseSeconds = asPositiveInteger(options.leaseSeconds, DEFAULT_LEASE_SECONDS, "lease seconds");
  const explicitScope = parseIdScope(options.assetIds, options.imageIds, options.cutIds, options.referenceIds);
  const sharedReferenceIds = parseIdScope(options.sharedReferenceIds);
  const allowedBrowserProviders = browserProviderList(options.allowedBrowserProviders);
  const providerConcurrency = browserProviderConcurrency(options.browserProviderConcurrency, allowedBrowserProviders);
  const browserProviderReceiptRequired = options.browserProviderReceiptRequired === true;
  const repairReason = cleanText(options.repairReason);
  if (repairReason && !explicitScope.length) throw new Error("A repair manifest requires an exact asset/image/reference ID scope.");
  if (browserProviderReceiptRequired && !allowedBrowserProviders.length) {
    throw new Error("A provider-attributed browser manifest requires at least one allowed browser provider.");
  }
  const repairEvidence = repairReason && browserProviderReceiptRequired
    ? await repairEvidenceRecord(options.repairEvidence, explicitScope)
    : null;
  let episodeDir;
  let sources;
  let items;

  if (mode === "scene") {
    const promptsPath = normalizeAbsolute(options.promptsPath);
    if (!promptsPath) throw new Error("Scene work creation requires --prompts.");
    const plan = await readJson(promptsPath);
    if (plan?.status !== "passed") throw new Error(`Prompt plan is not passed: ${promptsPath}.`);
    episodeDir = normalizeAbsolute(options.episodeDir) ?? path.dirname(promptsPath);
    const runIdentityPath = path.join(episodeDir, "run_identity.json");
    const runIdentity = await pathExists(runIdentityPath) ? await readJson(runIdentityPath) : null;
    const allRows = sceneRows(plan).filter((row) => row?.image_generation_required !== false);
    const routePlan = { ...plan, image_provider: plan.image_provider ?? runIdentity?.provider_locks?.image_provider ?? runIdentity?.image_provider };
    const candidateRows = explicitScope.length ? allRows : allRows.filter((row) => routeIsCodex(row, routePlan));
    const selected = exactScopedRows(candidateRows, explicitScope, (row) => row?.image_id ?? row?.target_image_id, "image");
    if (!selected.rows.length) throw new Error("Scene work creation selected zero Codex-routed images.");
    const promptSource = await sourceRecord(promptsPath);
    sources = { prompt_plan: promptSource };
    if (runIdentity) sources.run_identity = await sourceRecord(runIdentityPath);
    items = [];
    for (const row of selected.rows) {
      const assetId = assertAssetId(row.image_id ?? row.target_image_id);
      const prompt = promptForCodex(row);
      if (!prompt) throw new Error(`Missing active Codex prompt for ${assetId}.`);
      const orderedReferences = await bindReferenceInputs(referenceSlotsForPrompt(row), path.dirname(promptsPath));
      items.push({
        asset_id: assetId,
        asset_kind: "scene_cut",
        prompt,
        prompt_sha256: sha256(prompt),
        source_row_sha256: codexWorkSourceRowSha256(row),
        source_plan_path: promptsPath,
        source_plan_sha256: promptSource.sha256,
        ordered_references: orderedReferences,
        expected_output: expectedOutput(assetId),
        prior_accepted_sha256: await priorSceneHash(episodeDir, assetId, row),
      });
    }
  } else {
    const referencePlanPath = normalizeAbsolute(options.referencePlanPath);
    const characterStateRefsPath = normalizeAbsolute(options.characterStateRefsPath);
    if (!referencePlanPath || !characterStateRefsPath) {
      throw new Error("Reference work creation requires --reference-plan and --character-state-refs.");
    }
    const [referencePlan, characterStateRefs] = await Promise.all([
      readJson(referencePlanPath),
      readJson(characterStateRefsPath),
    ]);
    if (!new Set(["passed", "approved"]).has(cleanText(referencePlan?.status).toLowerCase())) {
      throw new Error(`Reference plan is not passed: ${referencePlanPath}.`);
    }
    if (!new Set(["draft_needs_manual_review", "passed", "approved"]).has(cleanText(characterStateRefs?.status).toLowerCase())) {
      throw new Error(`Character-state refs are not a valid planner output: ${characterStateRefsPath}.`);
    }
    episodeDir = normalizeAbsolute(options.episodeDir) ?? path.dirname(referencePlanPath);
    const runIdentityPath = path.join(episodeDir, "run_identity.json");
    const runIdentity = await pathExists(runIdentityPath) ? await readJson(runIdentityPath) : null;
    const allRows = refTargetRows(referencePlan).filter(refRequiresGeneration);
    const codexReferences = referencesDefaultToCodex(runIdentity, referencePlan);
    const candidateRows = explicitScope.length
      ? allRows
      : allRows.filter((row) => {
          const hasExplicitRoute = cleanText(row?.image_provider_route ?? row?.target_provider_route ?? row?.provider_route ?? row?.image_provider ?? row?.provider);
          return hasExplicitRoute ? routeIsCodex(row, referencePlan) : codexReferences;
        });
    const selected = exactScopedRows(candidateRows, explicitScope, (row) => row?.ref_id, "reference");
    if (!selected.rows.length) throw new Error("Reference work creation selected zero Codex-routed references.");
    const [referenceSource, characterSource] = await Promise.all([
      sourceRecord(referencePlanPath),
      sourceRecord(characterStateRefsPath),
    ]);
    sources = {
      reference_plan: referenceSource,
      character_state_refs: characterSource,
    };
    if (runIdentity) sources.run_identity = await sourceRecord(runIdentityPath);
    const lookup = buildReferenceLookup(referencePlan, characterStateRefs);
    for (const sharedReferenceId of sharedReferenceIds) {
      const shared = lookup.get(sharedReferenceId);
      if (!shared) throw new Error(`Shared reference ${sharedReferenceId} is not present in the approved reference artifacts.`);
      const sharedPath = normalizeAbsolute(shared.reference_image_path ?? shared.conditioning_image_path, path.dirname(referencePlanPath));
      if (!sharedPath || !(await pathExists(sharedPath))) {
        throw new Error(`Shared reference ${sharedReferenceId} has not been materialized before this manifest.`);
      }
    }
    const selectedIds = new Set(selected.ids);
    items = [];
    for (const row of selected.rows) {
      const assetId = assertAssetId(row.ref_id);
      const prompt = promptForCodex(row);
      if (!prompt) throw new Error(`Missing active Codex prompt for reference ${assetId}.`);
      items.push({
        asset_id: assetId,
        asset_kind: cleanText(row.kind) || "reference",
        prompt,
        prompt_sha256: sha256(prompt),
        source_row_sha256: codexWorkSourceRowSha256(row),
        source_plan_path: referencePlanPath,
        source_plan_sha256: referenceSource.sha256,
        character_state_refs_path: characterStateRefsPath,
        character_state_refs_sha256: characterSource.sha256,
        dependency_asset_ids: referenceDependencyIds(row).filter((id) => selectedIds.has(id)),
        ordered_references: await bindReferenceTargetInputs(row, lookup, path.dirname(referencePlanPath), sharedReferenceIds),
        expected_output: expectedOutput(assetId),
        prior_accepted_sha256: await priorReferenceHash(row, episodeDir),
      });
    }
  }

  items.sort((left, right) => left.asset_id.localeCompare(right.asset_id, undefined, { numeric: true }));
  const verificationAssetIds = representativeVerificationAssetIds(items);
  const verificationGateBypass = await verificationGateBypassRecord(options.verificationGateBypass);
  if (verificationGateBypass) {
    sources = {
      ...sources,
      verification_health_proof: {
        path: verificationGateBypass.evidence_path,
        sha256: verificationGateBypass.evidence_sha256,
      },
    };
  }
  if (repairEvidence) {
    for (const [index, record] of repairEvidence.records.entries()) {
      sources = {
        ...sources,
        [`repair_evidence_${String(index + 1).padStart(2, "0")}`]: record,
      };
    }
  }
  const skeleton = {
    schema: CODEX_WORK_SCHEMA,
    status: "ready",
    mode,
    provider: cleanText(options.workProvider) || "codex_imagegen",
    episode_dir: episodeDir,
    sources,
    scope: {
      explicit: explicitScope.length > 0,
      asset_ids: items.map((item) => item.asset_id),
    },
    policy: {
      lease_seconds: leaseSeconds,
      max_attempts: maxAttempts,
      output_format: "png",
      orientation: "landscape",
      aspect_ratio: DEFAULT_ASPECT_RATIO,
      aspect_tolerance: DEFAULT_ASPECT_TOLERANCE,
      one_png_per_attempt: true,
      explicit_source_required: true,
      duplicate_sha256_forbidden: true,
      verification_asset_ids: verificationAssetIds,
      verification_required_before_full_queue: items.length > verificationAssetIds.length && !verificationGateBypass,
      verification_gate_bypass: verificationGateBypass,
      recommended_concurrency: asPositiveInteger(options.recommendedConcurrency, DEFAULT_RECOMMENDED_CONCURRENCY, "recommended concurrency"),
      max_concurrency: asPositiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY, "max concurrency"),
      ...(allowedBrowserProviders.length ? {
        dispatch_policy: cleanText(options.dispatchPolicy) || "first_available_top_off_v1",
        allowed_browser_providers: allowedBrowserProviders,
        browser_provider_concurrency: providerConcurrency,
        browser_provider_receipt_required: browserProviderReceiptRequired,
      } : {}),
      ...(sharedReferenceIds.length ? { shared_reference_ids: sharedReferenceIds } : {}),
      ...(repairReason ? {
        repair_authorization: {
          scope: "exact_ids_only",
          reason: repairReason,
          evidence: repairEvidence,
        },
      } : {}),
    },
    item_count: items.length,
    items,
  };
  const manifestId = `codex-work-${sha256(stableStringify(skeleton)).slice(0, 24)}`;
  const stagingRoot = normalizeAbsolute(options.stagingRoot)
    ?? path.join(episodeDir, "assets", "images", "codex_worker_staging");
  const manifestDir = path.join(stagingRoot, manifestId);
  const manifestPath = path.join(manifestDir, "work_manifest.json");
  const manifest = {
    ...skeleton,
    manifest_id: manifestId,
    content_sha256: sha256(stableStringify(skeleton)),
    manifest_path: manifestPath,
    created_at: nowIso(),
  };
  await fs.mkdir(manifestDir, { recursive: true });
  if (await pathExists(manifestPath)) {
    const existing = await readJson(manifestPath);
    if (sha256(stableStringify(manifestContentForHash(existing))) !== sha256(stableStringify(skeleton))) {
      throw new Error(`Content-addressed manifest collision at ${manifestPath}.`);
    }
    await ensureRuntimeDirectories(manifestDir);
    return { manifest: existing, created: false };
  }
  try {
    await writeJsonExclusive(manifestPath, manifest);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readJson(manifestPath);
    if (sha256(stableStringify(manifestContentForHash(existing))) !== sha256(stableStringify(skeleton))) throw error;
    await ensureRuntimeDirectories(manifestDir);
    return { manifest: existing, created: false };
  }
  await ensureRuntimeDirectories(manifestDir);
  return { manifest, created: true };
}

function manifestDirectory(manifestOrPath) {
  if (typeof manifestOrPath === "string") {
    const resolved = path.resolve(manifestOrPath);
    return path.basename(resolved) === "work_manifest.json" ? path.dirname(resolved) : resolved;
  }
  return path.dirname(path.resolve(manifestOrPath.manifest_path));
}

export async function resolveManifestPath(manifestOrDirectory) {
  const resolved = path.resolve(manifestOrDirectory);
  const stat = await fs.stat(resolved).catch(() => null);
  if (stat?.isDirectory()) return path.join(resolved, "work_manifest.json");
  return resolved;
}

export async function loadWorkManifest(manifestOrDirectory) {
  const manifestPath = await resolveManifestPath(manifestOrDirectory);
  const manifest = await readJson(manifestPath);
  if (manifest?.schema !== CODEX_WORK_SCHEMA || !Array.isArray(manifest.items)) {
    throw new Error(`Invalid Codex work manifest: ${manifestPath}.`);
  }
  if (path.resolve(manifest.manifest_path ?? manifestPath) !== path.resolve(manifestPath)) {
    throw new Error(`Manifest path binding does not match ${manifestPath}.`);
  }
  return { manifest, manifestPath, manifestDir: path.dirname(manifestPath) };
}

async function ensureRuntimeDirectories(manifestDir) {
  await Promise.all([
    "leases",
    "attempts",
    "completions",
    "deadletters",
    "hash-claims",
    "closed-leases",
    "expired-leases",
  ].map((name) => fs.mkdir(path.join(manifestDir, name), { recursive: true })));
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withLeaseDispatchLock(manifestDir, callback) {
  const lockPath = path.join(manifestDir, ".lease-dispatch.lock");
  const token = randomUUID();
  const deadline = Date.now() + LEASE_DISPATCH_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      try {
        await writeJsonExclusive(path.join(lockPath, "owner.json"), {
          schema: "goldflow_codex_image_lease_dispatch_lock_v1",
          token,
          process_id: process.pid,
          acquired_at: nowIso(),
        });
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs >= LEASE_DISPATCH_LOCK_STALE_MS) {
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          await fs.rename(lockPath, stalePath);
          await fs.rm(stalePath, { recursive: true, force: true });
          continue;
        } catch (staleError) {
          if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(staleError?.code)) throw staleError;
        }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the manifest lease-dispatch lock: ${manifestDir}.`);
      await wait(10);
    }
  }
  try {
    return await callback();
  } finally {
    const owner = await readJson(path.join(lockPath, "owner.json")).catch(() => null);
    if (owner?.token === token) await fs.rm(lockPath, { recursive: true, force: true });
  }
}

function itemById(manifest, assetId) {
  const safeId = assertAssetId(assetId);
  const item = manifest.items.find((row) => row.asset_id === safeId);
  if (!item) throw new Error(`Asset ${safeId} is not in manifest ${manifest.manifest_id}.`);
  return item;
}

function leasePath(manifestDir, assetId) {
  return path.join(manifestDir, "leases", `${assertAssetId(assetId)}.lock`);
}

function completionPath(manifestDir, assetId) {
  return path.join(manifestDir, "completions", `${assertAssetId(assetId)}.json`);
}

function deadletterPath(manifestDir, assetId) {
  return path.join(manifestDir, "deadletters", `${assertAssetId(assetId)}.json`);
}

function attemptAssetDir(manifestDir, assetId) {
  return path.join(manifestDir, "attempts", assertAssetId(assetId));
}

async function attemptDirectories(manifestDir, assetId) {
  const base = attemptAssetDir(manifestDir, assetId);
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && /^attempt-\d+-[A-Za-z0-9-]+$/.test(entry.name))
    .map((entry) => path.join(base, entry.name))
    .sort();
}

async function closeLease(manifestDir, lease, reason) {
  const currentPath = leasePath(manifestDir, lease.asset_id);
  const closedPath = path.join(manifestDir, "closed-leases", `${lease.asset_id}-${lease.attempt_number}-${lease.lease_token}-${reason}`);
  await fs.rename(currentPath, closedPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return closedPath;
}

async function writeDeadletter(manifest, manifestDir, item, attempts, reason, details = null) {
  const filePath = deadletterPath(manifestDir, item.asset_id);
  if (await pathExists(filePath)) return readJson(filePath);
  const attemptDirs = await attemptDirectories(manifestDir, item.asset_id);
  const latestAssignment = attemptDirs.length
    ? await readJson(path.join(attemptDirs.at(-1), "assignment.json")).catch(() => null)
    : null;
  const boundItem = latestAssignment?.item?.asset_id === item.asset_id ? latestAssignment.item : item;
  const deadletter = {
    schema: "goldflow_codex_image_deadletter_v1",
    status: "deadlettered",
    manifest_id: manifest.manifest_id,
    asset_id: item.asset_id,
    asset_kind: item.asset_kind,
    attempt_count: attempts,
    max_attempts: manifest.policy.max_attempts,
    reason,
    details,
    creative_contract: {
      source_row_sha256: boundItem.source_row_sha256,
      prompt_sha256: boundItem.prompt_sha256,
      ordered_reference_hashes: (boundItem.ordered_references ?? []).map((reference) => ({
        ref_id: reference.ref_id,
        sha256: reference.sha256,
      })),
    },
    created_at: nowIso(),
  };
  await writeJsonExclusive(filePath, deadletter).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  return readJson(filePath);
}

async function readLiveLease(manifestDir, assetId, leaseToken) {
  const filePath = path.join(leasePath(manifestDir, assetId), "lease.json");
  const lease = await readJson(filePath).catch(() => null);
  if (!lease) throw new Error(`No live lease exists for ${assetId}.`);
  if (lease.lease_token !== cleanText(leaseToken)) throw new Error(`Lease token does not own ${assetId}.`);
  if (Date.parse(lease.expires_at) <= Date.now()) throw new Error(`Lease for ${assetId} expired at ${lease.expires_at}.`);
  return { lease, filePath };
}

async function validateCurrentItemBindings(item) {
  if (!(await pathExists(item.source_plan_path))) throw new Error(`Source plan is missing for ${item.asset_id}: ${item.source_plan_path}.`);
  const currentPlanHash = await sha256File(item.source_plan_path);
  if (currentPlanHash !== item.source_plan_sha256) throw new Error(`Source plan changed after manifest creation for ${item.asset_id}.`);
  if (item.character_state_refs_path) {
    if (!(await pathExists(item.character_state_refs_path))) throw new Error(`Character-state plan is missing for ${item.asset_id}: ${item.character_state_refs_path}.`);
    const currentStateHash = await sha256File(item.character_state_refs_path);
    if (currentStateHash !== item.character_state_refs_sha256) throw new Error(`Character-state plan changed after manifest creation for ${item.asset_id}.`);
  }
  for (const reference of item.ordered_references ?? []) {
    if (!(await pathExists(reference.path))) throw new Error(`Reference input disappeared for ${item.asset_id}: ${reference.path}.`);
    const currentHash = await sha256File(reference.path);
    if (currentHash !== reference.sha256) throw new Error(`Reference input changed for ${item.asset_id}: ${reference.ref_id}.`);
  }
}

async function resolvedDependencyReferences(manifestDir, item) {
  const references = [];
  for (const dependencyId of item.dependency_asset_ids ?? []) {
    const completion = await readJson(completionPath(manifestDir, dependencyId)).catch(() => null);
    if (!completion?.source_path || !completion?.sha256 || !(await pathExists(completion.source_path))) return null;
    if (await sha256File(completion.source_path) !== completion.sha256) return null;
    references.push({
      slot: references.length + 1,
      ref_id: dependencyId,
      kind: "generated_dependency",
      purpose: `generated dependency for ${item.asset_id}`,
      path: completion.source_path,
      sha256: completion.sha256,
    });
  }
  return references;
}

async function verificationWaveComplete(manifest, manifestDir) {
  if (manifest.policy?.verification_required_before_full_queue !== true) {
    const bypass = manifest.policy?.verification_gate_bypass;
    if (bypass) {
      const evidence = manifest.sources?.verification_health_proof;
      if (!evidence?.path || evidence.path !== bypass.evidence_path || evidence.sha256 !== bypass.evidence_sha256) {
        throw new Error("Verification-gate bypass evidence binding is missing or inconsistent in the manifest.");
      }
      if (!(await pathExists(evidence.path)) || await sha256File(evidence.path) !== evidence.sha256) {
        throw new Error(`Verification-gate bypass evidence changed or disappeared: ${evidence.path}.`);
      }
    }
    return true;
  }
  for (const assetId of manifest.policy?.verification_asset_ids ?? []) {
    if (!(await pathExists(completionPath(manifestDir, assetId)))) return false;
  }
  return true;
}

export async function reconcileExpiredLeases(manifestOrDirectory) {
  const { manifest, manifestDir } = await loadWorkManifest(manifestOrDirectory);
  await ensureRuntimeDirectories(manifestDir);
  const entries = await fs.readdir(path.join(manifestDir, "leases"), { withFileTypes: true });
  const expired = [];
  const deadlettered = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".lock")) continue;
    const currentPath = path.join(manifestDir, "leases", entry.name);
    const lease = await readJson(path.join(currentPath, "lease.json")).catch(() => null);
    const stat = await fs.stat(currentPath).catch(() => null);
    const expiresAt = lease?.expires_at ? Date.parse(lease.expires_at) : (stat?.mtimeMs ?? 0) + 30_000;
    if (expiresAt > Date.now()) continue;
    const assetId = lease?.asset_id ?? entry.name.slice(0, -".lock".length);
    const token = cleanText(lease?.lease_token) || randomUUID();
    const expiredPath = path.join(manifestDir, "expired-leases", `${assertAssetId(assetId)}-${token}`);
    try {
      await fs.rename(currentPath, expiredPath);
    } catch (error) {
      if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)) continue;
      throw error;
    }
    const attemptDir = lease?.attempt_dir;
    if (attemptDir && await pathExists(attemptDir)) {
      const marker = {
        schema: "goldflow_codex_image_attempt_expiry_v1",
        status: "expired",
        manifest_id: manifest.manifest_id,
        asset_id: assetId,
        lease_token: lease?.lease_token ?? null,
        expired_at: nowIso(),
      };
      await writeJsonExclusive(path.join(attemptDir, "expired.json"), marker).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
    }
    expired.push(assetId);
    const attempts = (await attemptDirectories(manifestDir, assetId)).length;
    if (attempts >= manifest.policy.max_attempts) {
      const item = itemById(manifest, assetId);
      await writeDeadletter(manifest, manifestDir, item, attempts, "lease_expired_max_attempts");
      deadlettered.push(assetId);
    }
  }
  return { expired, deadlettered };
}

export async function leaseNextWorkItem(options) {
  const { manifest, manifestDir, manifestPath } = await loadWorkManifest(options.manifestPath);
  const workerId = cleanText(options.workerId);
  if (!workerId) throw new Error("Lease requires --worker-id.");
  const browserProvider = normalizeBrowserProvider(options.browserProvider);
  const allowedBrowserProviders = browserProviderList(manifest.policy?.allowed_browser_providers);
  if (manifest.policy?.browser_provider_receipt_required === true && !browserProvider) {
    throw new Error("This manifest requires a browser-provider identity for every lease.");
  }
  if (allowedBrowserProviders.length && !allowedBrowserProviders.includes(browserProvider)) {
    return {
      status: "no_work",
      no_work_reason: "browser_provider_not_allowed",
      browser_provider: browserProvider,
      allowed_browser_providers: allowedBrowserProviders,
    };
  }
  return withLeaseDispatchLock(manifestDir, async () => {
    await reconcileExpiredLeases(manifestPath);
    const liveLeaseEntries = await fs.readdir(path.join(manifestDir, "leases"), { withFileTypes: true });
    const liveLeases = [];
    for (const entry of liveLeaseEntries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".lock")) continue;
      const lease = await readJson(path.join(manifestDir, "leases", entry.name, "lease.json")).catch(() => null);
      if (!lease || Date.parse(lease.expires_at) <= Date.now()) continue;
      liveLeases.push(lease);
      if (lease.worker_id !== workerId) continue;
      if (browserProvider && lease.browser_provider && lease.browser_provider !== browserProvider) {
        throw new Error(`Worker ${workerId} already owns a ${lease.browser_provider} lease and cannot resume it as ${browserProvider}.`);
      }
      const assignment = await readJson(path.join(lease.attempt_dir, "assignment.json")).catch(() => null);
      if (!assignment) throw new Error(`Worker ${workerId} has a live lease without an assignment for ${lease.asset_id}.`);
      return { status: "leased", assignment, reused_existing_lease: true };
    }

    const maxConcurrency = asPositiveInteger(manifest.policy?.max_concurrency, DEFAULT_MAX_CONCURRENCY, "max concurrency");
    if (liveLeases.length >= maxConcurrency) {
      const queue = await getCodexWorkStatus({ manifestPath, reconcile: false });
      return {
        ...queue,
        queue_status: queue.status,
        status: "no_work",
        no_work_reason: "max_concurrency_reached",
        live_lease_count: liveLeases.length,
        max_concurrency: maxConcurrency,
      };
    }
    const providerCaps = manifest.policy?.browser_provider_concurrency ?? null;
    const providerCap = browserProvider && providerCaps ? Number(providerCaps[browserProvider] ?? 0) : 0;
    const providerLiveLeaseCount = browserProvider
      ? liveLeases.filter((lease) => lease.browser_provider === browserProvider).length
      : 0;
    if (providerCap > 0 && providerLiveLeaseCount >= providerCap) {
      return {
        status: "no_work",
        no_work_reason: "browser_provider_concurrency_reached",
        browser_provider: browserProvider,
        live_lease_count: liveLeases.length,
        provider_live_lease_count: providerLiveLeaseCount,
        provider_max_concurrency: providerCap,
        max_concurrency: maxConcurrency,
      };
    }

    const leaseSeconds = asPositiveInteger(options.leaseSeconds, manifest.policy.lease_seconds ?? DEFAULT_LEASE_SECONDS, "lease seconds");
    const verificationComplete = await verificationWaveComplete(manifest, manifestDir);
    const verificationIds = new Set(manifest.policy?.verification_asset_ids ?? []);
    const eligibleItems = verificationComplete ? manifest.items : manifest.items.filter((item) => verificationIds.has(item.asset_id));
    for (const item of eligibleItems) {
      if (await pathExists(completionPath(manifestDir, item.asset_id))) continue;
      if (await pathExists(deadletterPath(manifestDir, item.asset_id))) continue;
      if (await pathExists(leasePath(manifestDir, item.asset_id))) continue;
      const attempts = await attemptDirectories(manifestDir, item.asset_id);
      if (attempts.length >= manifest.policy.max_attempts) {
        await writeDeadletter(manifest, manifestDir, item, attempts.length, "max_attempts_exhausted_before_lease");
        continue;
      }
      const dependencyReferences = await resolvedDependencyReferences(manifestDir, item);
      if (dependencyReferences === null) continue;
      const token = randomUUID();
      const attemptNumber = attempts.length + 1;
      const attemptDir = path.join(attemptAssetDir(manifestDir, item.asset_id), `attempt-${String(attemptNumber).padStart(3, "0")}-${token.slice(0, 12)}`);
      const temporaryLeaseDir = path.join(manifestDir, "leases", `.${item.asset_id}.${token}.tmp`);
      const liveLeaseDir = leasePath(manifestDir, item.asset_id);
      await fs.mkdir(temporaryLeaseDir);
      const startedAt = nowIso();
      const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      const lease = {
        schema: "goldflow_codex_image_lease_v1",
        status: "leased",
        manifest_id: manifest.manifest_id,
        manifest_path: manifestPath,
        asset_id: item.asset_id,
        asset_kind: item.asset_kind,
        attempt_number: attemptNumber,
        attempt_dir: attemptDir,
        lease_token: token,
        worker_id: workerId,
        browser_provider: browserProvider,
        leased_at: startedAt,
        expires_at: expiresAt,
        lease_seconds: leaseSeconds,
      };
      await writeJsonExclusive(path.join(temporaryLeaseDir, "lease.json"), lease);
      try {
        await fs.rename(temporaryLeaseDir, liveLeaseDir);
      } catch (error) {
        await fs.rm(temporaryLeaseDir, { recursive: true, force: true });
        if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) continue;
        throw error;
      }
      const combinedReferences = [];
      for (const reference of [...(item.ordered_references ?? []), ...dependencyReferences]) {
        if (combinedReferences.some((row) => row.ref_id === reference.ref_id)) continue;
        combinedReferences.push({ ...reference, slot: combinedReferences.length + 1 });
      }
      if (combinedReferences.length > 4) {
        await closeLease(manifestDir, lease, "assignment-reference-overflow");
        throw new Error(`Asset ${item.asset_id} requires ${combinedReferences.length} ordered references; provider limit is four.`);
      }
      const assignmentItem = {
        ...item,
        ordered_references: combinedReferences,
      };
      const assignment = {
        schema: "goldflow_codex_image_assignment_v1",
        status: "assigned",
        ...lease,
        item: assignmentItem,
        expected_output_path: path.join(attemptDir, item.expected_output.filename),
      };
      try {
        await fs.mkdir(path.dirname(attemptDir), { recursive: true });
        await fs.mkdir(attemptDir);
        await writeJsonExclusive(path.join(attemptDir, "assignment.json"), assignment);
        await writeJsonExclusive(path.join(attemptDir, "heartbeat.json"), {
          schema: "goldflow_codex_image_heartbeat_v1",
          status: "live",
          manifest_id: manifest.manifest_id,
          asset_id: item.asset_id,
          lease_token: token,
          worker_id: workerId,
          heartbeat_at: startedAt,
          expires_at: expiresAt,
        });
      } catch (error) {
        await closeLease(manifestDir, lease, "assignment-error");
        throw error;
      }
      return { status: "leased", assignment };
    }
    const queue = await getCodexWorkStatus({ manifestPath, reconcile: false });
    return { ...queue, queue_status: queue.status, status: "no_work" };
  });
}

export async function heartbeatWorkItem(options) {
  const { manifest, manifestDir } = await loadWorkManifest(options.manifestPath);
  const item = itemById(manifest, options.assetId);
  const { lease, filePath } = await readLiveLease(manifestDir, item.asset_id, options.leaseToken);
  if (options.workerId && lease.worker_id !== cleanText(options.workerId)) throw new Error(`Worker ${options.workerId} does not own ${item.asset_id}.`);
  const leaseSeconds = asPositiveInteger(options.leaseSeconds, lease.lease_seconds ?? manifest.policy.lease_seconds, "lease seconds");
  const heartbeat = {
    schema: "goldflow_codex_image_heartbeat_v1",
    status: "live",
    manifest_id: manifest.manifest_id,
    asset_id: item.asset_id,
    lease_token: lease.lease_token,
    worker_id: lease.worker_id,
    heartbeat_at: nowIso(),
    expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
  };
  await writeJsonAtomic(path.join(lease.attempt_dir, "heartbeat.json"), heartbeat);
  await writeJsonAtomic(filePath, { ...lease, expires_at: heartbeat.expires_at, last_heartbeat_at: heartbeat.heartbeat_at });
  return { status: "live", heartbeat };
}

async function pngFilesInAttempt(attemptDir) {
  const entries = await fs.readdir(attemptDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png")).map((entry) => path.join(attemptDir, entry.name));
}

export async function inspectPng(filePath, expected = {}) {
  const resolved = path.resolve(filePath);
  const metadata = await sharp(resolved, { failOn: "error" }).metadata();
  if (metadata.format !== "png") throw new Error(`Expected PNG but decoded ${metadata.format ?? "unknown"}: ${resolved}.`);
  const width = Number(metadata.width ?? 0);
  const height = Number(metadata.height ?? 0);
  if (!(width > 0 && height > 0)) throw new Error(`PNG has invalid dimensions: ${resolved}.`);
  if (width <= height) throw new Error(`PNG is not landscape (${width}x${height}): ${resolved}.`);
  const actualAspect = width / height;
  const expectedAspect = Number(expected.aspect_ratio ?? DEFAULT_ASPECT_RATIO);
  const tolerance = Number(expected.aspect_tolerance ?? DEFAULT_ASPECT_TOLERANCE);
  if (Math.abs(actualAspect - expectedAspect) > tolerance) {
    throw new Error(`PNG aspect ${actualAspect.toFixed(4)} is outside ${expectedAspect.toFixed(4)} +/- ${tolerance}: ${resolved}.`);
  }
  return { format: metadata.format, width, height, aspect_ratio: actualAspect };
}

async function validateAttemptOutput(item, lease, sourcePath, reportedSha256) {
  const source = path.resolve(sourcePath);
  const expectedPath = path.resolve(lease.attempt_dir, item.expected_output.filename);
  if (source !== expectedPath) throw new Error(`Source must be the assigned output path: ${expectedPath}.`);
  if (path.basename(source) !== item.expected_output.filename) throw new Error(`Expected exact filename ${item.expected_output.filename}.`);
  const pngFiles = await pngFilesInAttempt(lease.attempt_dir);
  if (pngFiles.length !== 1 || path.resolve(pngFiles[0]) !== source) {
    throw new Error(`Attempt must contain exactly one PNG named ${item.expected_output.filename}; found ${pngFiles.length}.`);
  }
  const actualSha256 = await sha256File(source);
  if (!/^[a-f0-9]{64}$/.test(cleanText(reportedSha256).toLowerCase())) throw new Error("Completion requires a lowercase 64-character --sha256.");
  if (actualSha256 !== cleanText(reportedSha256).toLowerCase()) throw new Error(`Reported SHA-256 does not match ${source}.`);
  const image = await inspectPng(source, item.expected_output);
  return { source, sha256: actualSha256, image };
}

async function completionRows(manifestDir) {
  const entries = await fs.readdir(path.join(manifestDir, "completions"), { withFileTypes: true }).catch(() => []);
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const row = await readJson(path.join(manifestDir, "completions", entry.name)).catch(() => null);
    if (row) rows.push(row);
  }
  return rows;
}

async function claimCompletionHash(manifestDir, manifest, item, lease, output) {
  const claimPath = path.join(manifestDir, "hash-claims", `${output.sha256}.lock`);
  const temporaryPath = path.join(manifestDir, "hash-claims", `.${output.sha256}.${lease.lease_token}.tmp`);
  const claim = {
    schema: "goldflow_codex_image_hash_claim_v1",
    manifest_id: manifest.manifest_id,
    sha256: output.sha256,
    asset_id: item.asset_id,
    lease_token: lease.lease_token,
    claimed_at: nowIso(),
  };
  await fs.mkdir(temporaryPath);
  await writeJsonExclusive(path.join(temporaryPath, "claim.json"), claim);
  try {
    await fs.rename(temporaryPath, claimPath);
    return { claim, claimPath, created: true };
  } catch (error) {
    await fs.rm(temporaryPath, { recursive: true, force: true });
    if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
    const existing = await readJson(path.join(claimPath, "claim.json")).catch(() => null);
    if (existing?.asset_id === item.asset_id && existing?.lease_token === lease.lease_token) return { claim: existing, claimPath, created: false };
    throw new Error(`Duplicate output SHA-256 for ${item.asset_id}; already claimed by ${existing?.asset_id ?? "another asset"}.`);
  }
}

export async function completeWorkItem(options) {
  const { manifest, manifestDir } = await loadWorkManifest(options.manifestPath);
  const item = itemById(manifest, options.assetId);
  const { lease } = await readLiveLease(manifestDir, item.asset_id, options.leaseToken);
  if (options.workerId && lease.worker_id !== cleanText(options.workerId)) throw new Error(`Worker ${options.workerId} does not own ${item.asset_id}.`);
  const browserProvider = normalizeBrowserProvider(options.browserProvider);
  if (manifest.policy?.browser_provider_receipt_required === true && !browserProvider) {
    throw new Error(`Completion for ${item.asset_id} requires the leased browser provider.`);
  }
  if (browserProvider && lease.browser_provider !== browserProvider) {
    throw new Error(`Completion provider ${browserProvider} does not own ${item.asset_id}; lease belongs to ${lease.browser_provider ?? "an unattributed worker"}.`);
  }
  if (!cleanText(options.sourcePath)) throw new Error("Completion requires explicit --source.");
  const assignment = await readJson(path.join(lease.attempt_dir, "assignment.json"));
  const assignedItem = assignment?.item;
  if (!assignedItem || assignedItem.asset_id !== item.asset_id || assignedItem.source_row_sha256 !== item.source_row_sha256) {
    throw new Error(`Assignment item binding is invalid for ${item.asset_id}.`);
  }
  await validateCurrentItemBindings(assignedItem);
  const output = await validateAttemptOutput(assignedItem, lease, options.sourcePath, options.reportedSha256);
  if (item.prior_accepted_sha256 && output.sha256 === item.prior_accepted_sha256) {
    throw new Error(`Replacement output for ${item.asset_id} is byte-identical to its prior accepted image.`);
  }
  for (const existing of await completionRows(manifestDir)) {
    if (existing.asset_id !== item.asset_id && existing.sha256 === output.sha256) {
      throw new Error(`Duplicate output SHA-256 for ${item.asset_id}; already accepted for ${existing.asset_id}.`);
    }
  }
  await claimCompletionHash(manifestDir, manifest, item, lease, output);
  const completion = {
    schema: "goldflow_codex_image_completion_v1",
    status: "completed",
    manifest_id: manifest.manifest_id,
    asset_id: item.asset_id,
    asset_kind: item.asset_kind,
    attempt_number: lease.attempt_number,
    attempt_dir: lease.attempt_dir,
    lease_token: lease.lease_token,
    worker_id: lease.worker_id,
    browser_provider: lease.browser_provider ?? browserProvider,
    source_path: output.source,
    sha256: output.sha256,
    image: output.image,
    prompt_sha256: item.prompt_sha256,
    ordered_reference_hashes: assignedItem.ordered_references.map((row) => ({ ref_id: row.ref_id, sha256: row.sha256 })),
    completed_at: nowIso(),
  };
  await writeJsonExclusive(path.join(lease.attempt_dir, "completion.json"), completion);
  try {
    await writeJsonExclusive(completionPath(manifestDir, item.asset_id), completion);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readJson(completionPath(manifestDir, item.asset_id));
    if (existing.sha256 !== completion.sha256 || existing.lease_token !== completion.lease_token) throw new Error(`Conflicting completion exists for ${item.asset_id}.`);
  }
  await closeLease(manifestDir, lease, "completed");
  return { status: "completed", completion };
}

function orderedReferenceHashes(item) {
  return (item?.ordered_references ?? []).map((row) => ({ ref_id: row.ref_id, sha256: row.sha256 }));
}

export async function reuseExactWorkCompletions(options) {
  const source = await loadWorkManifest(options.sourceManifestPath);
  const target = await loadWorkManifest(options.targetManifestPath);
  if (source.manifest.mode !== target.manifest.mode) throw new Error("Exact completion reuse requires matching manifest modes.");
  if (target.manifest.policy?.browser_provider_receipt_required === true) {
    throw new Error("Provider-attributed browser manifests must be materialized from their own provider receipt; generic completion reuse is disabled.");
  }
  const scope = new Set(parseIdScope(options.assetIds, options.imageIds, options.cutIds, options.referenceIds));
  const sourceItems = new Map(source.manifest.items.map((item) => [item.asset_id, item]));
  const workerId = cleanText(options.workerId) || `exact-cache-reuse-${source.manifest.manifest_id}`;
  const reused = [];
  const skipped = [];

  for (const targetItem of target.manifest.items) {
    if (scope.size && !scope.has(targetItem.asset_id)) continue;
    if (await pathExists(completionPath(target.manifestDir, targetItem.asset_id))) {
      skipped.push({ asset_id: targetItem.asset_id, reason: "target_already_completed" });
      continue;
    }
    if (await pathExists(leasePath(target.manifestDir, targetItem.asset_id))) {
      skipped.push({ asset_id: targetItem.asset_id, reason: "target_has_live_lease" });
      continue;
    }
    const sourceItem = sourceItems.get(targetItem.asset_id);
    const sourceCompletion = await readJson(completionPath(source.manifestDir, targetItem.asset_id)).catch(() => null);
    if (!sourceItem || !sourceCompletion) {
      skipped.push({ asset_id: targetItem.asset_id, reason: "source_not_completed" });
      continue;
    }
    const samePrompt = sourceItem.prompt_sha256 === targetItem.prompt_sha256;
    const sameReferences = stableStringify(orderedReferenceHashes(sourceItem)) === stableStringify(orderedReferenceHashes(targetItem));
    const sameOutput = stableStringify(sourceItem.expected_output) === stableStringify(targetItem.expected_output);
    const completionMatchesSource = sourceCompletion.prompt_sha256 === sourceItem.prompt_sha256
      && stableStringify(sourceCompletion.ordered_reference_hashes ?? []) === stableStringify(orderedReferenceHashes(sourceItem));
    const sourceAssignment = await readJson(path.join(sourceCompletion.attempt_dir ?? "", "assignment.json")).catch(() => null);
    const sourceBindingValid = sourceAssignment?.item?.asset_id === sourceItem.asset_id
      && sourceAssignment?.item?.source_row_sha256 === sourceItem.source_row_sha256;
    const sourceHash = await sha256File(sourceCompletion.source_path ?? "").catch(() => null);
    if (!samePrompt || !sameReferences || !sameOutput || !completionMatchesSource || !sourceBindingValid || sourceHash !== sourceCompletion.sha256) {
      skipped.push({ asset_id: targetItem.asset_id, reason: "content_binding_changed" });
      continue;
    }
    await inspectPng(sourceCompletion.source_path, targetItem.expected_output);

    const token = randomUUID();
    const attempts = await attemptDirectories(target.manifestDir, targetItem.asset_id);
    const attemptNumber = attempts.length + 1;
    const attemptDir = path.join(attemptAssetDir(target.manifestDir, targetItem.asset_id), `attempt-${String(attemptNumber).padStart(3, "0")}-${token.slice(0, 12)}`);
    const temporaryLeaseDir = path.join(target.manifestDir, "leases", `.${targetItem.asset_id}.${token}.tmp`);
    const liveLeaseDir = leasePath(target.manifestDir, targetItem.asset_id);
    await fs.mkdir(path.dirname(attemptDir), { recursive: true });
    await fs.mkdir(attemptDir);
    await fs.mkdir(temporaryLeaseDir);
    const startedAt = nowIso();
    const leaseSeconds = target.manifest.policy.lease_seconds ?? DEFAULT_LEASE_SECONDS;
    const lease = {
      schema: "goldflow_codex_image_lease_v1",
      status: "leased",
      manifest_id: target.manifest.manifest_id,
      manifest_path: target.manifestPath,
      asset_id: targetItem.asset_id,
      asset_kind: targetItem.asset_kind,
      attempt_number: attemptNumber,
      attempt_dir: attemptDir,
      lease_token: token,
      worker_id: workerId,
      leased_at: startedAt,
      expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
      lease_seconds: leaseSeconds,
    };
    const assignment = {
      schema: "goldflow_codex_image_assignment_v1",
      status: "assigned",
      ...lease,
      item: targetItem,
      expected_output_path: path.join(attemptDir, targetItem.expected_output.filename),
      reused_from_manifest_id: source.manifest.manifest_id,
      reused_from_completion_sha256: sourceCompletion.sha256,
    };
    await writeJsonExclusive(path.join(temporaryLeaseDir, "lease.json"), lease);
    await fs.rename(temporaryLeaseDir, liveLeaseDir);
    await writeJsonExclusive(path.join(attemptDir, "assignment.json"), assignment);
    await writeJsonExclusive(path.join(attemptDir, "heartbeat.json"), {
      schema: "goldflow_codex_image_heartbeat_v1",
      status: "live",
      manifest_id: target.manifest.manifest_id,
      asset_id: targetItem.asset_id,
      lease_token: token,
      worker_id: workerId,
      heartbeat_at: startedAt,
      expires_at: lease.expires_at,
      cache_reuse: true,
    });
    try {
      await fs.link(sourceCompletion.source_path, assignment.expected_output_path);
    } catch (error) {
      if (error?.code !== "EXDEV") throw error;
      await fs.copyFile(sourceCompletion.source_path, assignment.expected_output_path);
    }
    await completeWorkItem({
      manifestPath: target.manifestPath,
      assetId: targetItem.asset_id,
      leaseToken: token,
      workerId,
      sourcePath: assignment.expected_output_path,
      reportedSha256: sourceCompletion.sha256,
    });
    reused.push({ asset_id: targetItem.asset_id, sha256: sourceCompletion.sha256, source_manifest_id: source.manifest.manifest_id });
  }

  return {
    status: "passed",
    source_manifest_id: source.manifest.manifest_id,
    target_manifest_id: target.manifest.manifest_id,
    reused_count: reused.length,
    skipped_count: skipped.length,
    reused,
    skipped,
  };
}

export async function failWorkItem(options) {
  const { manifest, manifestDir } = await loadWorkManifest(options.manifestPath);
  const item = itemById(manifest, options.assetId);
  const { lease } = await readLiveLease(manifestDir, item.asset_id, options.leaseToken);
  if (options.workerId && lease.worker_id !== cleanText(options.workerId)) throw new Error(`Worker ${options.workerId} does not own ${item.asset_id}.`);
  const browserProvider = normalizeBrowserProvider(options.browserProvider);
  if (browserProvider && lease.browser_provider !== browserProvider) {
    throw new Error(`Failure provider ${browserProvider} does not own ${item.asset_id}; lease belongs to ${lease.browser_provider ?? "an unattributed worker"}.`);
  }
  const failure = {
    schema: "goldflow_codex_image_attempt_failure_v1",
    status: "failed",
    manifest_id: manifest.manifest_id,
    asset_id: item.asset_id,
    attempt_number: lease.attempt_number,
    lease_token: lease.lease_token,
    worker_id: lease.worker_id,
    browser_provider: lease.browser_provider ?? browserProvider,
    error: cleanText(options.error) || "worker_reported_failure",
    failed_at: nowIso(),
  };
  await writeJsonExclusive(path.join(lease.attempt_dir, "failure.json"), failure);
  await closeLease(manifestDir, lease, "failed");
  const attempts = (await attemptDirectories(manifestDir, item.asset_id)).length;
  let deadletter = null;
  if (attempts >= manifest.policy.max_attempts) {
    deadletter = await writeDeadletter(manifest, manifestDir, item, attempts, "worker_failure_max_attempts", failure.error);
  }
  return { status: deadletter ? "deadlettered" : "retryable", failure, deadletter };
}

export async function deferWorkItem(options) {
  const { manifest, manifestDir } = await loadWorkManifest(options.manifestPath);
  const item = itemById(manifest, options.assetId);
  const { lease } = await readLiveLease(manifestDir, item.asset_id, options.leaseToken);
  if (options.workerId && lease.worker_id !== cleanText(options.workerId)) throw new Error(`Worker ${options.workerId} does not own ${item.asset_id}.`);
  const browserProvider = normalizeBrowserProvider(options.browserProvider);
  if (browserProvider && lease.browser_provider !== browserProvider) {
    throw new Error(`Deferral provider ${browserProvider} does not own ${item.asset_id}; lease belongs to ${lease.browser_provider ?? "an unattributed worker"}.`);
  }
  const deferral = {
    schema: "goldflow_codex_image_presubmission_deferral_v1",
    status: "deferred_before_submission",
    manifest_id: manifest.manifest_id,
    asset_id: item.asset_id,
    attempt_number: lease.attempt_number,
    lease_token: lease.lease_token,
    worker_id: lease.worker_id,
    browser_provider: lease.browser_provider ?? browserProvider,
    reason: cleanText(options.reason) || "provider_cooldown_before_submission",
    deferred_at: nowIso(),
  };
  await writeJsonExclusive(path.join(lease.attempt_dir, "presubmission_deferral.json"), deferral);
  await closeLease(manifestDir, lease, "deferred-before-submission");
  const deferredDir = path.join(
    manifestDir,
    "deferred-attempts",
    item.asset_id,
    path.basename(lease.attempt_dir),
  );
  await fs.mkdir(path.dirname(deferredDir), { recursive: true });
  await fs.rename(lease.attempt_dir, deferredDir);
  return { status: "deferred_before_submission", deferral, deferred_attempt_dir: deferredDir };
}

export async function getCodexWorkStatus(options) {
  const { manifest, manifestDir, manifestPath } = await loadWorkManifest(options.manifestPath);
  const reconciliation = options.reconcile === false ? { expired: [], deadlettered: [] } : await reconcileExpiredLeases(manifestPath);
  const rows = [];
  for (const item of manifest.items) {
    const completion = await readJson(completionPath(manifestDir, item.asset_id)).catch(() => null);
    const deadletter = await readJson(deadletterPath(manifestDir, item.asset_id)).catch(() => null);
    const lease = await readJson(path.join(leasePath(manifestDir, item.asset_id), "lease.json")).catch(() => null);
    const attempts = await attemptDirectories(manifestDir, item.asset_id);
    rows.push({
      asset_id: item.asset_id,
      asset_kind: item.asset_kind,
      status: completion ? "completed" : deadletter ? "deadlettered" : lease ? "leased" : "pending",
      attempt_count: attempts.length,
      worker_id: lease?.worker_id ?? null,
      browser_provider: completion?.browser_provider ?? lease?.browser_provider ?? null,
      lease_expires_at: lease?.expires_at ?? null,
      completion_sha256: completion?.sha256 ?? null,
      deadletter_reason: deadletter?.reason ?? null,
    });
  }
  const counts = Object.fromEntries(["pending", "leased", "completed", "deadlettered"].map((status) => [status, rows.filter((row) => row.status === status).length]));
  const verificationIds = new Set(manifest.policy?.verification_asset_ids ?? []);
  const verificationRows = rows.filter((row) => verificationIds.has(row.asset_id));
  const verificationCompleted = verificationRows.filter((row) => row.status === "completed").length;
  const verificationBypass = manifest.policy?.verification_gate_bypass ?? null;
  return {
    manifest_id: manifest.manifest_id,
    manifest_path: manifestPath,
    mode: manifest.mode,
    status: counts.completed === rows.length ? "completed" : counts.deadlettered ? "blocked_deadletter" : "in_progress",
    item_count: rows.length,
    counts,
    recommended_concurrency: manifest.policy?.recommended_concurrency ?? DEFAULT_RECOMMENDED_CONCURRENCY,
    max_concurrency: manifest.policy?.max_concurrency ?? DEFAULT_MAX_CONCURRENCY,
    dispatch_policy: manifest.policy?.dispatch_policy ?? null,
    allowed_browser_providers: manifest.policy?.allowed_browser_providers ?? [],
    browser_provider_concurrency: manifest.policy?.browser_provider_concurrency ?? null,
    completed_by_browser_provider: Object.fromEntries(
      (manifest.policy?.allowed_browser_providers ?? []).map((provider) => [
        provider,
        rows.filter((row) => row.status === "completed" && row.browser_provider === provider).length,
      ]),
    ),
    verification_wave: {
      required: manifest.policy?.verification_required_before_full_queue === true,
      bypassed: Boolean(verificationBypass),
      bypass: verificationBypass,
      asset_ids: [...verificationIds],
      completed_count: verificationCompleted,
      item_count: verificationRows.length,
      status: verificationBypass
        ? "bypassed_with_prior_health_proof"
        : verificationCompleted === verificationRows.length ? "passed" : "in_progress",
    },
    reconciliation,
    items: rows,
  };
}

async function validateSourceHashes(manifest, findings) {
  for (const [name, source] of Object.entries(manifest.sources ?? {})) {
    if (!source?.path || !(await pathExists(source.path))) {
      findings.push({ code: "source_artifact_missing", source: name, path: source?.path ?? null });
      continue;
    }
    const current = await sha256File(source.path);
    if (current !== source.sha256) findings.push({ code: "source_artifact_stale", source: name, path: source.path, expected_sha256: source.sha256, current_sha256: current });
  }
}

export async function validateCodexWorkManifest(options) {
  const { manifest, manifestDir, manifestPath } = await loadWorkManifest(options.manifestPath);
  await reconcileExpiredLeases(manifestPath);
  const findings = [];
  const knownIds = new Set(manifest.items.map((item) => item.asset_id));
  const requestedIds = new Set(parseIdScope(options.assetIds, options.imageIds, options.cutIds, options.referenceIds));
  const allowIncomplete = options.allowIncomplete === true;
  const allowSourceArtifactDrift = options.allowSourceArtifactDrift === true;
  if (allowIncomplete && !requestedIds.size) {
    throw new Error("Partial manifest validation requires an exact completed asset/image/reference ID scope.");
  }
  if (allowSourceArtifactDrift && (!allowIncomplete || !requestedIds.size)) {
    throw new Error("Source-artifact drift may be tolerated only for exact-scope partial materialization after current-row validation.");
  }
  if (!allowSourceArtifactDrift) await validateSourceHashes(manifest, findings);
  for (const assetId of requestedIds) {
    if (!knownIds.has(assetId)) findings.push({ code: "validation_scope_asset_unknown", asset_id: assetId });
  }
  const requiredIds = requestedIds.size ? requestedIds : knownIds;
  const completionFiles = await fs.readdir(path.join(manifestDir, "completions"), { withFileTypes: true }).catch(() => []);
  const completionJsonFiles = completionFiles.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  if (!allowIncomplete && completionJsonFiles.length !== manifest.items.length) {
    findings.push({ code: "completion_file_count_mismatch", expected: manifest.items.length, actual: completionJsonFiles.length });
  }
  const completionFilesToValidate = allowIncomplete
    ? completionJsonFiles.filter((entry) => requiredIds.has(entry.name.slice(0, -".json".length)))
    : completionJsonFiles;
  const hashOwners = new Map();
  for (const entry of completionFilesToValidate) {
    const filePath = path.join(manifestDir, "completions", entry.name);
    const completion = await readJson(filePath).catch((error) => {
      findings.push({ code: "completion_json_invalid", path: filePath, error: error.message });
      return null;
    });
    if (!completion) continue;
    if (!knownIds.has(completion.asset_id)) {
      findings.push({ code: "unexpected_completion", path: filePath, asset_id: completion.asset_id ?? null });
      continue;
    }
    const item = itemById(manifest, completion.asset_id);
    if (entry.name !== `${item.asset_id}.json`) findings.push({ code: "completion_filename_mismatch", asset_id: item.asset_id, path: filePath });
    if (completion.manifest_id !== manifest.manifest_id) findings.push({ code: "completion_manifest_mismatch", asset_id: item.asset_id });
    if (completion.prompt_sha256 !== item.prompt_sha256) findings.push({ code: "completion_prompt_stale", asset_id: item.asset_id });
    const assignment = await readJson(path.join(completion.attempt_dir, "assignment.json")).catch(() => null);
    if (!assignment?.item || assignment.item.asset_id !== item.asset_id || assignment.item.source_row_sha256 !== item.source_row_sha256) {
      findings.push({ code: "completion_assignment_binding_invalid", asset_id: item.asset_id });
    }
    if (manifest.policy?.browser_provider_receipt_required === true) {
      const allowedProviders = browserProviderList(manifest.policy?.allowed_browser_providers);
      if (!allowedProviders.includes(completion.browser_provider)) {
        findings.push({ code: "completion_browser_provider_invalid", asset_id: item.asset_id, browser_provider: completion.browser_provider ?? null });
      }
      if (assignment?.browser_provider !== completion.browser_provider) {
        findings.push({ code: "completion_browser_provider_lease_mismatch", asset_id: item.asset_id });
      }
      const receiptName = completion.browser_provider === "google-flow"
        ? "google_flow_receipt.json"
        : completion.browser_provider === "google-gemini" ? "google_gemini_receipt.json" : "chatgpt_web_receipt.json";
      const receiptPath = path.join(completion.attempt_dir, receiptName);
      const receipt = await readJson(receiptPath).catch(() => null);
      if (!receipt || receipt.browser_provider !== completion.browser_provider || receipt.asset_id !== item.asset_id) {
        findings.push({ code: "completion_browser_provider_receipt_missing_or_invalid", asset_id: item.asset_id, path: receiptPath });
      }
    }
    const expectedRefRows = assignment?.item?.ordered_references ?? item.ordered_references;
    const expectedRefHashes = stableStringify(expectedRefRows.map((row) => ({ ref_id: row.ref_id, sha256: row.sha256 })));
    if (stableStringify(completion.ordered_reference_hashes ?? []) !== expectedRefHashes) findings.push({ code: "completion_reference_binding_stale", asset_id: item.asset_id });
    if (!completion.source_path || !(await pathExists(completion.source_path))) {
      findings.push({ code: "completed_png_missing", asset_id: item.asset_id, path: completion.source_path ?? null });
      continue;
    }
    const expectedPath = path.resolve(completion.attempt_dir, item.expected_output.filename);
    if (path.resolve(completion.source_path) !== expectedPath || path.basename(completion.source_path) !== item.expected_output.filename) {
      findings.push({ code: "completed_png_path_mismatch", asset_id: item.asset_id, path: completion.source_path, expected_path: expectedPath });
    }
    const pngFiles = await pngFilesInAttempt(completion.attempt_dir).catch(() => []);
    if (pngFiles.length !== 1 || path.resolve(pngFiles[0] ?? "") !== path.resolve(completion.source_path)) {
      findings.push({ code: "attempt_png_count_invalid", asset_id: item.asset_id, count: pngFiles.length });
    }
    const currentHash = await sha256File(completion.source_path).catch(() => null);
    if (currentHash !== completion.sha256) findings.push({ code: "completed_png_hash_mismatch", asset_id: item.asset_id, expected_sha256: completion.sha256, current_sha256: currentHash });
    try {
      await inspectPng(completion.source_path, item.expected_output);
    } catch (error) {
      findings.push({ code: "completed_png_invalid", asset_id: item.asset_id, error: error.message });
    }
    const priorOwner = hashOwners.get(completion.sha256);
    if (priorOwner && priorOwner !== item.asset_id) findings.push({ code: "duplicate_completion_sha256", asset_id: item.asset_id, duplicate_of: priorOwner, sha256: completion.sha256 });
    else hashOwners.set(completion.sha256, item.asset_id);
  }
  const hashClaimEntries = await fs.readdir(path.join(manifestDir, "hash-claims"), { withFileTypes: true }).catch(() => []);
  const allHashClaims = hashClaimEntries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".lock"));
  const hashClaims = [];
  for (const entry of allHashClaims) {
    const claim = await readJson(path.join(manifestDir, "hash-claims", entry.name, "claim.json")).catch(() => null);
    if (!allowIncomplete || requiredIds.has(claim?.asset_id)) hashClaims.push(entry);
  }
  for (const entry of hashClaims) {
    const claimPath = path.join(manifestDir, "hash-claims", entry.name, "claim.json");
    const claim = await readJson(claimPath).catch(() => null);
    const completion = claim?.asset_id ? await readJson(completionPath(manifestDir, claim.asset_id)).catch(() => null) : null;
    if (!claim || !completion || completion.sha256 !== claim.sha256 || `${claim.sha256}.lock` !== entry.name) {
      findings.push({ code: "orphan_or_invalid_hash_claim", path: claimPath, asset_id: claim?.asset_id ?? null });
    }
  }
  if (hashClaims.length !== completionFilesToValidate.length) {
    findings.push({ code: "hash_claim_count_mismatch", expected: completionFilesToValidate.length, actual: hashClaims.length });
  }
  for (const item of manifest.items) {
    if (requiredIds.has(item.asset_id) && !(await pathExists(completionPath(manifestDir, item.asset_id)))) {
      findings.push({ code: "item_not_completed", asset_id: item.asset_id });
    }
    if (requiredIds.has(item.asset_id) && await pathExists(deadletterPath(manifestDir, item.asset_id))) {
      const deadletter = await readJson(deadletterPath(manifestDir, item.asset_id)).catch(() => null);
      findings.push({
        code: "item_deadlettered",
        asset_id: item.asset_id,
        reason: deadletter?.reason ?? null,
        attempt_count: deadletter?.attempt_count ?? null,
      });
    }
    if (allowIncomplete && !requiredIds.has(item.asset_id)) continue;
    for (const reference of item.ordered_references) {
      if (!(await pathExists(reference.path))) {
        findings.push({ code: "reference_input_missing", asset_id: item.asset_id, ref_id: reference.ref_id, path: reference.path });
        continue;
      }
      const currentHash = await sha256File(reference.path);
      if (currentHash !== reference.sha256) findings.push({ code: "reference_input_stale", asset_id: item.asset_id, ref_id: reference.ref_id, expected_sha256: reference.sha256, current_sha256: currentHash });
    }
  }
  const status = findings.length ? "blocked" : "passed";
  return {
    schema: "goldflow_codex_image_work_validation_v1",
    status,
    manifest_id: manifest.manifest_id,
    manifest_path: manifestPath,
    validation_scope: requestedIds.size ? "exact_completed_ids" : "full_manifest",
    manifest_item_count: manifest.items.length,
    item_count: requiredIds.size,
    completed_count: requiredIds.size - findings.filter((row) => row.code === "item_not_completed").length,
    unique_sha256_count: hashOwners.size,
    finding_count: findings.length,
    findings,
    validated_at: nowIso(),
  };
}
