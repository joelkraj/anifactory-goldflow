#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  GoldflowBridge,
  validateGoogleFlowReferenceBinding,
} from "../apps/goldflow-studio/lib/goldflow-bridge.mjs";
import {
  appendCodexWorkManifestStream,
  codexWorkSourceRowSha256,
  createCodexWorkManifest,
  getCodexWorkStatus,
  leaseNextWorkItem,
  loadWorkManifest,
  openCodexWorkManifestStream,
  parseIdScope,
  sealCodexWorkManifestStream,
  sha256File,
  validateCodexWorkManifest,
} from "./lib/codex-image-work-contract.mjs";
import { generateChatGptWebImage } from "./chatgpt-web-image-helper.mjs";
import {
  CHATGPT_WEB_THROTTLE_COOLDOWN_MS,
  isChatGptWebRateLimitError,
} from "./lib/chatgpt-web-throttle-state.mjs";
import {
  CHATGPT_WEB_IMAGE_PROVIDER,
  FEDERATED_WEB_IMAGE_ROUTING_POLICY,
  FEDERATED_WEB_IMAGE_PROVIDER,
  federatedWebImageAutomaticChatGptEnabled,
  FRESH_BROWSER_SESSION_PER_JOB_POLICY,
  FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY,
  GOOGLE_FLOW_BROWSER_PROVIDER,
  GOOGLE_GEMINI_BROWSER_PROVIDER,
  GOOGLE_GEMINI_IMAGE_CONCURRENCY,
  HYBRID_CHATGPT_IMAGE_CONCURRENCY,
  HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
  HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
  HYBRID_WEB_FLOW_PROVIDER,
  GOOGLE_FLOW_IMAGE_PROVIDER,
  PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY,
  PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY,
  federatedWebImageIdentityStatus,
  googleFlowPrimaryIdentityStatus,
  hybridWebFlowIdentityStatus,
  isBrowserPoolImageProvider,
  isFederatedWebImageProvider,
  isGoogleFlowPrimaryProvider,
  isHybridWebFlowProvider,
  isStyleReferenceTarget,
} from "./lib/image-provider-policy.mjs";
import { effectiveImageIdentityForEpisode } from "./lib/operator-image-route-override.mjs";
import { buildImageSemanticAudit } from "./lib/image-semantic-audit.mjs";
import {
  buildHeroCandidatePromptPlan,
  heroCandidateGroups,
  selectHeroCandidate,
  writeCanonicalHeroSelectionReceipt,
} from "./lib/hero-image-candidate-contract.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[++index] : "true";
    flags[key] = value;
  }
  return flags;
}

function boolFlag(value) {
  return /^(true|1|yes)$/i.test(String(value ?? ""));
}

export function validateFlowRuntimeConcurrency(value = HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY) {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY) {
    throw new Error(`--flow-runtime-concurrency must be an integer from 1 to ${HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY}.`);
  }
  return concurrency;
}

export function validateRepairSharedReferenceScope({ ids = [], repairReason = "", referencesOnly = false } = {}) {
  if (ids.length && (!String(repairReason).trim() || !referencesOnly)) {
    throw new Error("--shared-reference-ids is available only for exact reference repairs with --repair-reason.");
  }
  return ids;
}

async function manifestAttemptExistsForAsset({ episodeDir, assetId }) {
  const stagingRoot = path.join(episodeDir, "assets", "images", "codex_worker_staging");
  const manifests = (await fs.readdir(stagingRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory());
  for (const entry of manifests) {
    const attemptRoot = path.join(stagingRoot, entry.name, "attempts", assetId);
    const attempts = await fs.readdir(attemptRoot, { withFileTypes: true }).catch(() => []);
    if (attempts.some((attempt) => attempt.isDirectory())) return true;
  }
  return false;
}

function parseBlockedPoolReport(stageReport) {
  const stdout = String(stageReport?.stdout_tail ?? "").trim();
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export async function resolveManualProviderAuthRecoveryEvidence({
  episodeDir,
  mode,
  currentRows,
  requestedIds,
  evidencePath,
  targetProvider,
}) {
  if (!evidencePath) return null;
  if (targetProvider !== "chatgpt") {
    throw new Error("Manual provider-auth recovery is restricted to the operator-approved ChatGPT fallback route.");
  }
  const triagePath = path.resolve(evidencePath);
  const triage = await readJson(triagePath, null);
  if (triage?.schema !== "goldflow_manual_image_provider_auth_recovery_v1" || triage?.status !== "approved") {
    throw new Error("Manual provider-auth recovery requires an approved goldflow_manual_image_provider_auth_recovery_v1 artifact.");
  }
  if (path.resolve(triage.episode_dir ?? "") !== path.resolve(episodeDir) || triage.mode !== mode) {
    throw new Error("Manual provider-auth recovery does not match the current episode and image mode.");
  }
  if (triage.target_provider !== "chatgpt"
    || triage.preserve_existing_assets !== true
    || triage.automatic_cross_provider_failover !== false
    || triage.creative_submission_count_per_authorized_asset !== 0
    || !String(triage.operator_authorization ?? "").trim()) {
    throw new Error("Manual provider-auth recovery is missing its exact operator and one-submission safeguards.");
  }
  const authorizedIds = parseIdScope(triage.authorized_asset_ids);
  const requested = [...requestedIds].map(String);
  if (authorizedIds.length !== requested.length || requested.some((assetId) => !authorizedIds.includes(assetId))) {
    throw new Error("Manual provider-auth recovery must authorize exactly the requested asset IDs.");
  }
  const rowById = new Map(currentRows.map((row) => [assetIdForMode(row, mode), row]));
  const unknown = requested.filter((assetId) => !rowById.has(assetId));
  if (unknown.length) throw new Error(`Manual provider-auth recovery contains unknown current assets: ${unknown.join(", ")}.`);

  const identityPath = path.join(episodeDir, "run_identity.json");
  const sourcePath = mode === "reference"
    ? path.join(episodeDir, "visual_reference_plan.json")
    : path.join(episodeDir, "section_image_prompts_hardened.json");
  const exactRecords = [
    ["run_identity", identityPath, triage.run_identity_sha256],
    ["source_artifact", sourcePath, triage.source_artifact_sha256],
    ["blocked_stage_report", path.resolve(triage.blocked_stage_report_path ?? ""), triage.blocked_stage_report_sha256],
  ];
  const records = [{ path: triagePath, sha256: await sha256File(triagePath) }];
  let stageReport = null;
  for (const [label, recordPath, expectedSha256] of exactRecords) {
    if (!recordPath || !/^[a-f0-9]{64}$/.test(String(expectedSha256 ?? "")) || !await exists(recordPath)) {
      throw new Error(`Manual provider-auth recovery has invalid ${label} evidence.`);
    }
    const actualSha256 = await sha256File(recordPath);
    if (actualSha256 !== expectedSha256) throw new Error(`Manual provider-auth recovery ${label} hash mismatch.`);
    records.push({ path: recordPath, sha256: actualSha256 });
    if (label === "blocked_stage_report") stageReport = await readJson(recordPath, null);
  }
  const blockedPool = parseBlockedPoolReport(stageReport);
  const unsubmittedIds = new Set((blockedPool?.unsubmitted_asset_ids ?? []).map(String));
  if (stageReport?.status !== "failed"
    || stageReport?.command !== "imagegen browser-pool"
    || blockedPool?.status !== "blocked"
    || blockedPool?.mode !== mode) {
    throw new Error("Manual provider-auth recovery stage evidence is not a failed blocked browser-pool report for this mode.");
  }
  const notProvenUnsubmitted = requested.filter((assetId) => !unsubmittedIds.has(assetId));
  if (notProvenUnsubmitted.length) {
    throw new Error(`Manual provider-auth recovery lacks immutable unsubmitted evidence for: ${notProvenUnsubmitted.join(", ")}.`);
  }
  for (const assetId of requested) {
    if (await manifestAttemptExistsForAsset({ episodeDir, assetId })) {
      throw new Error(`Manual provider-auth recovery refuses ${assetId}: a prior creative attempt directory exists.`);
    }
    if (mode === "reference" && await materializedReferenceState(rowById.get(assetId), { episodeDir })) {
      throw new Error(`Manual provider-auth recovery refuses ${assetId}: an accepted reference already exists.`);
    }
  }
  for (const [index, row] of (triage.supporting_evidence ?? []).entries()) {
    const recordPath = path.resolve(row?.path ?? "");
    const expectedSha256 = String(row?.sha256 ?? "");
    if (!recordPath || !/^[a-f0-9]{64}$/.test(expectedSha256) || !await exists(recordPath)) {
      throw new Error(`Manual provider-auth recovery supporting evidence ${index + 1} is invalid.`);
    }
    const actualSha256 = await sha256File(recordPath);
    if (actualSha256 !== expectedSha256) throw new Error(`Manual provider-auth recovery supporting evidence hash mismatch: ${recordPath}.`);
    records.push({ path: recordPath, sha256: actualSha256 });
  }
  return {
    schema: "goldflow_hybrid_image_repair_evidence_v1",
    kind: "manual_provider_auth_unsubmitted_assets",
    authorized_asset_ids: requested,
    records,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function compactError(error) {
  const code = String(error?.code ?? "electron_chatgpt_image_failed");
  const message = String(error?.message ?? error ?? "Electron ChatGPT image generation failed.").slice(0, 2_000);
  return `${code}: ${message}`;
}

export function chatGptImageFailureDisposition(error) {
  const message = compactError(error);
  const cooldownMatch = message.match(/ChatGPT Web cooldown active for (\d+) more seconds before image/i);
  if (cooldownMatch || isChatGptWebRateLimitError(message)) {
    return {
      action: "defer",
      message,
      cooldownMs: cooldownMatch
        ? (Number(cooldownMatch[1]) + 1) * 1_000
        : CHATGPT_WEB_THROTTLE_COOLDOWN_MS,
    };
  }
  return { action: "fail", message, cooldownMs: 0 };
}

async function runElectronChatGptManifest({
  bridge,
  manifestPath,
  downloadsRoot,
  projectUrl,
  concurrency = HYBRID_CHATGPT_IMAGE_CONCURRENCY,
}) {
  const manifestId = (await loadWorkManifest(manifestPath)).manifest.manifest_id;
  const workerPrefix = `electron-chatgpt-${process.pid}-${Date.now()}`;
  const runWorker = async (slot) => {
    const workerId = `${workerPrefix}-${slot}`;
    while (true) {
      const lease = await leaseNextWorkItem({
        manifestPath,
        workerId,
        leaseSeconds: 1800,
        browserProvider: "chatgpt",
      });
      if (lease.status !== "leased") {
        const status = await getCodexWorkStatus({ manifestPath });
        if (status.counts.pending === 0) return;
        await delay(1_000);
        continue;
      }
      const { assignment } = lease;
      const outputPath = path.join(
        downloadsRoot,
        "electron-chatgpt",
        manifestId,
        `${assignment.asset_id}-${Date.now()}-${slot}.png`,
      );
      try {
        const generated = await generateChatGptWebImage({
          prompt: assignment.item.prompt,
          outputPath,
          referenceImagePaths: (assignment.item.ordered_references ?? []).map((reference) => reference.path),
          workId: `${manifestId}-${assignment.asset_id}`,
          projectUrl,
        });
        await bridge.completeImage({
          manifestId: assignment.manifest_id,
          assetId: assignment.asset_id,
          leaseToken: assignment.lease_token,
          workerId,
          downloadPath: outputPath,
          sourceUrl: generated.source_path ?? null,
          conversationUrl: generated.conversation_url ?? null,
          browserProvider: "chatgpt",
          uiContract: {
            provider: "chatgpt",
            transport: "electron_chatgpt_web",
            model_label: "GPT Image",
            effort_label: "Medium",
            bridge_run_report_path: generated.bridge_run_report_path ?? null,
          },
        });
      } catch (error) {
        const disposition = chatGptImageFailureDisposition(error);
        if (disposition.action === "defer") {
          await bridge.deferImage({
            manifestId: assignment.manifest_id,
            assetId: assignment.asset_id,
            leaseToken: assignment.lease_token,
            workerId,
            reason: disposition.message,
          }).catch(() => null);
          await delay(disposition.cooldownMs);
        } else {
          await bridge.failImage({
            manifestId: assignment.manifest_id,
            assetId: assignment.asset_id,
            leaseToken: assignment.lease_token,
            workerId,
            error: disposition.message,
          }).catch(() => null);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, index) => runWorker(index + 1)));
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function providerReceiptMatchesAsset({ assetId, row, imageSha256 }) {
  const receiptPath = row?.provider_receipt_path;
  const receiptSha256 = row?.provider_receipt_sha256;
  if (!receiptPath || !receiptSha256 || !await exists(receiptPath)) return false;
  if (await sha256File(receiptPath) !== receiptSha256) return false;
  const receipt = await readJson(receiptPath, null);
  if (!receipt || String(receipt.asset_id ?? "") !== String(assetId)) return false;
  if (receipt.accepted_png_sha256 !== imageSha256) return false;
  if (row?.browser_provider && receipt.browser_provider !== row.browser_provider) return false;
  return true;
}

async function discoverMaterializedReferencePath(assetId, episodeDir) {
  if (!assetId || !episodeDir) return null;
  const referencesDir = path.join(episodeDir, "assets", "images", "references");
  const entries = await fs.readdir(referencesDir, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".metadata.json"))
    .map((entry) => path.join(referencesDir, entry.name));
  for (const metadataPath of candidates) {
    const metadata = await readJson(metadataPath, null);
    if (String(metadata?.ref_id ?? "") !== assetId) continue;
    const imagePath = metadataPath.slice(0, -".metadata.json".length);
    if (await exists(imagePath)) return imagePath;
  }
  return null;
}

export async function materializedReferenceState(target, { episodeDir = null } = {}) {
  const assetId = String(target?.ref_id ?? "");
  const imagePath = referencePath(target) ?? await discoverMaterializedReferencePath(assetId, episodeDir);
  if (!assetId || !imagePath || !await exists(imagePath)) return null;
  const imageSha256 = await sha256File(imagePath);
  const metadata = await readJson(`${imagePath}.metadata.json`, null);
  if (await providerReceiptMatchesAsset({ assetId, row: target, imageSha256 })) {
    if (!(metadata?.ref_id === assetId
      && metadata?.generated?.output_sha256 === imageSha256
      && metadata?.provider_receipt_path === target.provider_receipt_path
      && metadata?.provider_receipt_sha256 === target.provider_receipt_sha256)) return null;
  } else {
    // References generated before the browser-receipt contract are still immutable
    // accepted assets when their original sidecar binds the exact raster and path.
    const legacyHash = metadata?.generated?.output_sha256 ?? metadata?.generated?.source_sha256;
    const legacyPath = metadata?.generated?.downloaded_path ?? metadata?.conditioning_image_path;
    if (!(metadata?.ref_id === assetId
      && legacyHash === imageSha256
      && legacyPath
      && path.resolve(legacyPath) === path.resolve(imagePath))) return null;
  }
  return { assetId, imagePath, imageSha256, materializedAt: metadata.updated_at ?? null };
}

async function materializedReferenceAccepted(target, options = {}) {
  return Boolean(await materializedReferenceState(target, options));
}

async function materializedSceneState({ row, report, ledgerById, currentPromptPlanSha256 }) {
  const assetId = String(row?.image_id ?? "");
  const imagePath = row?.image_path;
  if (!assetId || !imagePath || !await exists(imagePath)) return null;
  if (report?.prompt_plan_hash !== currentPromptPlanSha256) return null;
  const imageSha256 = await sha256File(imagePath);
  if (row?.generated?.output_sha256 !== imageSha256) return null;
  if (!await providerReceiptMatchesAsset({ assetId, row, imageSha256 })) return null;
  const metadata = await readJson(`${imagePath}.metadata.json`, null);
  if (metadata?.image_id !== assetId
    || metadata?.generated?.output_sha256 !== imageSha256
    || metadata?.provider_receipt_path !== row.provider_receipt_path
    || metadata?.provider_receipt_sha256 !== row.provider_receipt_sha256) return null;
  const ledgerRow = ledgerById.get(assetId);
  if (!(ledgerRow?.image_sha256 === imageSha256
    && path.resolve(ledgerRow?.image_path ?? "") === path.resolve(imagePath)
    && ledgerRow?.provider_receipt_path === row.provider_receipt_path
    && ledgerRow?.provider_receipt_sha256 === row.provider_receipt_sha256)) return null;
  return { assetId, imagePath, imageSha256, materializedAt: metadata.updated_at ?? null };
}

async function materializedSceneAccepted(options) {
  return Boolean(await materializedSceneState(options));
}

function referenceRequiresGeneration(target = {}) {
  const mode = String(target.generation_mode ?? "").toLowerCase();
  if (["no_ref_needed", "source_only", "derive_from_first_clean_cut", "derive_from_best_cut", "derive_from_first_clean_wide_cut"].includes(mode)) return false;
  if (target.image_generation_required === false) return false;
  return mode === "standalone_ref" || target.required_before_imagegen === true;
}

function referencePath(target = {}) {
  return target.reference_image_path ?? target.conditioning_image_path ?? null;
}

async function targetsMissingMaterializedImages(targets = [], options = {}) {
  const missing = [];
  for (const target of targets) {
    if (!await materializedReferenceAccepted(target, options)) missing.push(target);
  }
  return missing;
}

function assetIdForMode(row, mode) {
  return String(mode === "scene" ? row?.image_id ?? "" : row?.ref_id ?? "");
}

async function currentOrderedReferenceRecords(manifestDir, item) {
  const recordsByPath = new Map();
  const referenceRows = [...(item?.ordered_references ?? [])];
  const attemptRoot = path.join(manifestDir, "attempts", item.asset_id);
  const attemptEntries = await fs.readdir(attemptRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of attemptEntries
    .filter((candidate) => candidate.isDirectory() && /^attempt-\d+-/.test(candidate.name))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const assignmentPath = path.join(attemptRoot, entry.name, "assignment.json");
    const assignment = await readJson(assignmentPath, null);
    if (!assignment?.item
      || assignment.item.asset_id !== item.asset_id
      || assignment.item.source_row_sha256 !== item.source_row_sha256) return null;
    referenceRows.push(...(assignment.item.ordered_references ?? []));
    recordsByPath.set(assignmentPath, {
      path: assignmentPath,
      sha256: await sha256File(assignmentPath),
    });
  }
  for (const reference of referenceRows) {
    if (!reference?.path || !reference.sha256 || !await exists(reference.path)) return null;
    const currentSha256 = await sha256File(reference.path);
    if (currentSha256 !== reference.sha256) return null;
    recordsByPath.set(reference.path, { path: reference.path, sha256: currentSha256 });
  }
  return [...recordsByPath.values()];
}

export async function findSourceCompatibleHybridDeadletters({
  episodeDir,
  mode,
  currentRows = [],
  requestedIds = null,
}) {
  if (!new Set(["scene", "reference"]).has(mode)) throw new Error(`Unsupported hybrid deadletter mode: ${mode}.`);
  const currentById = new Map(currentRows
    .map((row) => [assetIdForMode(row, mode), row])
    .filter(([assetId]) => assetId));
  const scope = requestedIds === null
    ? new Set(currentById.keys())
    : new Set([...requestedIds].map(String).filter(Boolean));
  const compatibleById = new Map();
  const stagingRoot = path.join(episodeDir, "assets", "images", "codex_worker_staging");
  const entries = (await fs.readdir(stagingRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const manifestPath = path.join(stagingRoot, entry.name, "work_manifest.json");
    const loaded = await loadWorkManifest(manifestPath).catch(() => null);
    if (!loaded
      || loaded.manifest.mode !== mode
      || !isBrowserPoolWorkProvider(loaded.manifest.provider)
      || path.resolve(loaded.manifest.episode_dir ?? "") !== path.resolve(episodeDir)) continue;
    const itemById = new Map(loaded.manifest.items.map((item) => [String(item.asset_id), item]));
    for (const assetId of scope) {
      if (compatibleById.has(assetId)) continue;
      const currentRow = currentById.get(assetId);
      const item = itemById.get(assetId);
      if (!currentRow || !item || codexWorkSourceRowSha256(currentRow) !== item.source_row_sha256) continue;
      const deadletterPath = path.join(loaded.manifestDir, "deadletters", `${assetId}.json`);
      if (!await exists(deadletterPath)) continue;
      const deadletter = await readJson(deadletterPath, null);
      if (deadletter?.asset_id !== assetId || deadletter.manifest_id !== loaded.manifest.manifest_id) continue;
      const referenceRecords = await currentOrderedReferenceRecords(loaded.manifestDir, item);
      if (!referenceRecords) continue;
      compatibleById.set(assetId, {
        asset_id: assetId,
        manifest_path: manifestPath,
        deadletter_path: deadletterPath,
        records: [
          { path: manifestPath, sha256: await sha256File(manifestPath) },
          { path: deadletterPath, sha256: await sha256File(deadletterPath) },
          ...referenceRecords,
        ],
      });
    }
  }
  return compatibleById;
}

function orderedReferenceHashes(rows = []) {
  return rows.map((row) => ({ ref_id: row?.ref_id ?? null, sha256: row?.sha256 ?? null }));
}

function isBrowserPoolWorkProvider(value) {
  return [HYBRID_WEB_FLOW_PROVIDER, FEDERATED_WEB_IMAGE_PROVIDER].includes(String(value ?? ""));
}

async function receiptValidHybridCompletion({ loaded, item, completion, downloadsRoot }) {
  if (loaded.manifest.policy?.browser_provider_receipt_required !== true) return false;
  if (completion?.manifest_id !== loaded.manifest.manifest_id || completion.asset_id !== item.asset_id) return false;
  if (!completion.source_path || !completion.sha256 || !await exists(completion.source_path)) return false;
  if (await sha256File(completion.source_path) !== completion.sha256) return false;
  const allowedProviders = loaded.manifest.policy?.allowed_browser_providers ?? [];
  if (!allowedProviders.includes(completion.browser_provider)) return false;
  const attemptDir = path.resolve(completion.attempt_dir ?? "");
  const relativeAttemptDir = path.relative(path.join(loaded.manifestDir, "attempts"), attemptDir);
  if (!relativeAttemptDir || relativeAttemptDir.startsWith("..") || path.isAbsolute(relativeAttemptDir)) return false;
  const assignment = await readJson(path.join(attemptDir, "assignment.json"), null);
  if (!assignment?.item
    || assignment.manifest_id !== loaded.manifest.manifest_id
    || assignment.item.asset_id !== item.asset_id
    || assignment.item.source_row_sha256 !== item.source_row_sha256
    || assignment.browser_provider !== completion.browser_provider) return false;
  if (item.prompt_compiler_policy === "lease_time_provider_compiler_v1"
    && (!assignment.item.prompt_compiler_receipt
      || assignment.item.prompt_compiler_receipt.neutral_prompt_sha256 !== (item.neutral_prompt_sha256 ?? item.prompt_sha256))) return false;
  if (completion.prompt_sha256 !== assignment.item.prompt_sha256) return false;
  if (JSON.stringify(completion.prompt_compiler_receipt ?? null) !== JSON.stringify(assignment.item.prompt_compiler_receipt ?? null)) return false;
  const expectedReferenceHashes = orderedReferenceHashes(assignment.item.ordered_references ?? []);
  if (JSON.stringify(completion.ordered_reference_hashes ?? []) !== JSON.stringify(expectedReferenceHashes)) return false;
  for (const reference of assignment.item.ordered_references ?? []) {
    if (!reference?.path || !reference.sha256 || !await exists(reference.path)) return false;
    if (await sha256File(reference.path) !== reference.sha256) return false;
  }
  const receiptName = completion.browser_provider === GOOGLE_FLOW_BROWSER_PROVIDER
    ? "google_flow_receipt.json"
    : completion.browser_provider === GOOGLE_GEMINI_BROWSER_PROVIDER
      ? "google_gemini_receipt.json"
      : "chatgpt_web_receipt.json";
  const receipt = await readJson(path.join(attemptDir, receiptName), null);
  const validTopLevelReceipt = Boolean(receipt
    && receipt.manifest_id === loaded.manifest.manifest_id
    && receipt.asset_id === item.asset_id
    && receipt.browser_provider === completion.browser_provider
    && receipt.prompt_sha256 === assignment.item.prompt_sha256
    && receipt.accepted_png_sha256 === completion.sha256
    && JSON.stringify(receipt.ordered_reference_hashes ?? []) === JSON.stringify(expectedReferenceHashes));
  if (!validTopLevelReceipt) return false;
  if (completion.browser_provider === GOOGLE_FLOW_BROWSER_PROVIDER) {
    if (!downloadsRoot) return false;
    try {
      await validateGoogleFlowReferenceBinding({
        uiContract: receipt.ui_contract,
        orderedReferences: assignment.item.ordered_references ?? [],
        downloadsRoot,
      });
    } catch {
      return false;
    }
  }
  return true;
}

export async function findSourceCompatibleHybridCompletions({
  episodeDir,
  mode,
  currentRows = [],
  requestedIds = null,
  currentAcceptedHashesById = new Map(),
  currentAcceptedAtById = new Map(),
  downloadsRoot = null,
}) {
  if (!new Set(["scene", "reference"]).has(mode)) throw new Error(`Unsupported hybrid completion mode: ${mode}.`);
  const currentById = new Map(currentRows
    .map((row) => [assetIdForMode(row, mode), row])
    .filter(([assetId]) => assetId));
  const scope = requestedIds === null
    ? new Set(currentById.keys())
    : new Set([...requestedIds].map(String).filter(Boolean));
  const selectedById = new Map();
  const stagingRoot = path.join(episodeDir, "assets", "images", "codex_worker_staging");
  const entries = (await fs.readdir(stagingRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const manifestPath = path.join(stagingRoot, entry.name, "work_manifest.json");
    const loaded = await loadWorkManifest(manifestPath).catch(() => null);
    if (!loaded
      || loaded.manifest.mode !== mode
      || !isBrowserPoolWorkProvider(loaded.manifest.provider)
      || path.resolve(loaded.manifest.episode_dir ?? "") !== path.resolve(episodeDir)) continue;
    const itemById = new Map(loaded.manifest.items.map((item) => [String(item.asset_id), item]));
    for (const assetId of scope) {
      const currentRow = currentById.get(assetId);
      const item = itemById.get(assetId);
      if (!currentRow || !item || codexWorkSourceRowSha256(currentRow) !== item.source_row_sha256) continue;
      const completionPath = path.join(loaded.manifestDir, "completions", `${assetId}.json`);
      const completion = await readJson(completionPath, null);
      if (!completion || !await receiptValidHybridCompletion({ loaded, item, completion, downloadsRoot })) continue;
      const currentAcceptedHash = currentAcceptedHashesById.get(assetId) ?? null;
      if (currentAcceptedHash && completion.sha256 === currentAcceptedHash) continue;
      const currentAcceptedAt = Date.parse(currentAcceptedAtById.get(assetId) ?? "");
      const completedAt = Date.parse(completion.completed_at ?? "");
      if (!Number.isFinite(completedAt)) continue;
      if (Number.isFinite(currentAcceptedAt) && Number.isFinite(completedAt) && completedAt <= currentAcceptedAt) continue;
      const prior = selectedById.get(assetId);
      if (!prior
        || completedAt > Date.parse(prior.completion.completed_at)
        || (completedAt === Date.parse(prior.completion.completed_at)
          && manifestPath.localeCompare(prior.manifestPath) > 0)) {
        selectedById.set(assetId, { manifestPath, completionPath, completion });
      }
    }
  }
  return selectedById;
}

async function resolveRepairEvidence({
  episodeDir,
  episode,
  mode,
  currentRows,
  requestedIds,
  qaRecovery,
  providerMigration,
  manualProviderAuthEvidencePath,
  targetProvider,
}) {
  const manualRecovery = await resolveManualProviderAuthRecoveryEvidence({
    episodeDir,
    mode,
    currentRows,
    requestedIds,
    evidencePath: manualProviderAuthEvidencePath,
    targetProvider,
  });
  if (manualRecovery) return manualRecovery;
  if (providerMigration) {
    if (mode !== "scene") throw new Error("Provider migration is valid only for scene cuts.");
    const ledgerPath = path.join(episodeDir, "cut_execution_ledger.json");
    const ledger = await readJson(ledgerPath, null);
    const cutsById = new Map((ledger?.cuts ?? []).map((cut) => [String(cut?.image_id ?? ""), cut]));
    const records = [{ path: ledgerPath, sha256: await sha256File(ledgerPath) }];
    const unauthorized = [];
    for (const assetId of requestedIds) {
      const cut = cutsById.get(assetId);
      if (String(cut?.image_provider ?? "").toLowerCase() !== "modelslab"
        || !cut?.image_path
        || !await exists(cut.image_path)) {
        unauthorized.push(assetId);
        continue;
      }
      records.push({ path: cut.image_path, sha256: await sha256File(cut.image_path) });
    }
    if (unauthorized.length) {
      throw new Error(`Provider migration scope is not backed by active ModelsLab cut artifacts: ${unauthorized.join(", ")}.`);
    }
    return {
      schema: "goldflow_hybrid_image_repair_evidence_v1",
      kind: "operator_provider_migration_from_modelslab",
      authorized_asset_ids: [...requestedIds],
      records,
    };
  }
  if (qaRecovery) {
    const reportPath = mode === "reference"
      ? path.join(episodeDir, `reference_image_qa_${episode}.json`)
      : path.join(episodeDir, `image_output_qa_${episode}.json`);
    const report = await readJson(reportPath, null);
    const authorizedIds = [...new Set((report?.findings ?? [])
      .filter((finding) => finding?.severity === "blocker" && (finding?.image_id || finding?.ref_id))
      .map((finding) => String(finding.image_id ?? finding.ref_id)))];
    const unauthorized = [...requestedIds].filter((assetId) => !authorizedIds.includes(assetId));
    if (report?.status !== "blocked" || unauthorized.length) {
      throw new Error(`${mode === "reference" ? "Reference" : "Image"}-QA repair scope is not authorized by the current blocked QA report: ${unauthorized.join(", ") || "report is not blocked"}.`);
    }
    return {
      schema: "goldflow_hybrid_image_repair_evidence_v1",
      kind: mode === "reference" ? "reference_image_qa_blockers" : "image_output_qa_blockers",
      authorized_asset_ids: authorizedIds,
      records: [{
        path: reportPath,
        sha256: await sha256File(reportPath),
      }],
    };
  }

  const evidenceById = await findSourceCompatibleHybridDeadletters({
    episodeDir,
    mode,
    currentRows,
    requestedIds,
  });
  const duplicateEvidenceById = new Map();
  const duplicateRecords = [];
  const sourcePath = mode === "scene"
    ? path.join(episodeDir, `imagegen_report_${episode}.json`)
    : path.join(episodeDir, "visual_reference_plan.json");
  const source = await readJson(sourcePath, null);
  const rows = mode === "scene" ? source?.results ?? [] : source?.reference_targets ?? [];
  const idFor = (row) => String(mode === "scene" ? row?.image_id ?? "" : row?.ref_id ?? "");
  const pathFor = (row) => mode === "scene"
    ? row?.image_path
    : row?.reference_image_path ?? row?.conditioning_image_path;
  const byHash = new Map();
  for (const row of rows) {
    const assetId = idFor(row);
    const imagePath = pathFor(row);
    if (!assetId || !imagePath || !await exists(imagePath)) continue;
    const imageSha256 = await sha256File(imagePath);
    const group = byHash.get(imageSha256) ?? [];
    group.push({ assetId, imagePath, imageSha256 });
    byHash.set(imageSha256, group);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    for (const duplicate of group.slice(1)) {
      duplicateEvidenceById.set(duplicate.assetId, duplicate);
    }
    for (const row of group) duplicateRecords.push({ path: row.imagePath, sha256: row.imageSha256 });
  }
  const authorizedIds = new Set([...evidenceById.keys(), ...duplicateEvidenceById.keys()]);
  const unauthorized = [...requestedIds].filter((assetId) => !authorizedIds.has(assetId));
  if (unauthorized.length) {
    throw new Error(`Repair scope lacks a prior provider deadletter or deterministic duplicate-loser finding for: ${unauthorized.join(", ")}.`);
  }
  const records = [...evidenceById.values()].flatMap((evidence) => evidence.records);
  if (duplicateEvidenceById.size) {
    if (!await exists(sourcePath)) throw new Error(`Duplicate repair evidence source is missing: ${sourcePath}.`);
    records.push({ path: sourcePath, sha256: await sha256File(sourcePath) }, ...duplicateRecords);
  }
  const uniqueRecords = [...new Map(records.map((record) => [record.path, record])).values()];
  const kind = evidenceById.size && duplicateEvidenceById.size
    ? "provider_deadletters_and_duplicate_output_hashes"
    : duplicateEvidenceById.size ? "duplicate_output_hashes" : "provider_deadletters";
  return {
    schema: "goldflow_hybrid_image_repair_evidence_v1",
    kind,
    authorized_asset_ids: [...requestedIds],
    records: uniqueRecords,
  };
}

function episodeDirectory(flags, dataRoot) {
  if (flags["episode-dir"]) return path.resolve(flags["episode-dir"]);
  return path.join(
    dataRoot,
    "channels",
    flags.channel ?? "53rebirth",
    "weekly_runs",
    flags.week ?? "current",
    "episodes",
    flags.episode ?? "ep_01",
  );
}

function identityCliArgs(identity) {
  return [
    "--channel", identity.channel,
    "--series", identity.series_slug,
    "--week", identity.week,
    "--episode", identity.episode,
  ];
}

function processIsLive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export async function assertHostRuntime(runtimePath, expectedProvider, {
  expectedPlanLabel = null,
  expectedModelLabel = null,
  requirePreparedWorkerPool = false,
} = {}) {
  const providerLabel = expectedProvider === GOOGLE_FLOW_BROWSER_PROVIDER
    ? "Google Flow"
    : expectedProvider === GOOGLE_GEMINI_BROWSER_PROVIDER ? "Google Gemini" : expectedProvider;
  const runtime = await readJson(runtimePath, null);
  if (runtime?.status !== "running" || runtime.browser_provider !== expectedProvider || !processIsLive(runtime.pid)) {
    throw new Error(`The ${providerLabel} Goldflow Studio image host is not running. Start \"npm run studio:hybrid\" before this stage.`);
  }
  if ([GOOGLE_FLOW_BROWSER_PROVIDER, GOOGLE_GEMINI_BROWSER_PROVIDER].includes(expectedProvider)) {
    const planLabel = String(expectedPlanLabel ?? "").trim();
    const modelLabel = String(expectedModelLabel ?? "").trim();
    if (!planLabel || !modelLabel) {
      throw new Error(`${providerLabel} host verification requires exact identity-locked plan and model labels.`);
    }
    const runtimePlanLabel = String(runtime.ui_contract?.account_plan ?? "").trim();
    const runtimeModelLabel = String(runtime.ui_contract?.model_label ?? "").trim();
    if (runtimePlanLabel !== planLabel || runtimeModelLabel !== modelLabel) {
      throw new Error(`${providerLabel} host identity mismatch: expected plan=${planLabel}, model=${modelLabel}; runtime plan=${runtimePlanLabel || "missing"}, model=${runtimeModelLabel || "missing"}.`);
    }
    if (requirePreparedWorkerPool) {
      const endpoint = `http://${runtime.host ?? "127.0.0.1"}:${runtime.port}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      let health;
      try {
        const response = await fetch(`${endpoint}/v1/health`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        health = await response.json();
      } catch (error) {
        throw new Error(`${providerLabel} health endpoint is unavailable at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
      }
      if (health?.browser_provider !== expectedProvider
        || String(health?.ui_contract?.account_plan ?? "") !== planLabel
        || String(health?.ui_contract?.model_label ?? "") !== modelLabel) {
        throw new Error(`${providerLabel} live health does not match its identity-locked provider, plan, and model.`);
      }
      const stateRoot = path.resolve(path.dirname(runtimePath), "..", "..");
      const workerRuntimePath = path.join(stateRoot, `${expectedProvider}-desktop-worker-runtime.json`);
      const workerRuntime = await readJson(workerRuntimePath, null);
      const expectedConcurrency = expectedProvider === GOOGLE_FLOW_BROWSER_PROVIDER
        ? HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY
        : GOOGLE_GEMINI_IMAGE_CONCURRENCY;
      const expectedPolicy = expectedProvider === GOOGLE_FLOW_BROWSER_PROVIDER
        ? PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY
        : PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY;
      const readySlots = workerRuntime?.worker_pool?.ready_slots ?? [];
      if (workerRuntime?.status !== "running"
        || workerRuntime?.browser_provider !== expectedProvider
        || !processIsLive(workerRuntime?.pid)
        || Number(workerRuntime?.concurrency) !== expectedConcurrency
        || workerRuntime?.worker_pool?.policy !== expectedPolicy
        || !(workerRuntime?.worker_pool?.prepared_session_policies ?? []).includes(expectedPolicy)
        || readySlots.length !== expectedConcurrency
        || workerRuntime?.dispatch_policy?.provider_circuit) {
        throw new Error(`${providerLabel} persistent worker pool is not production-ready (${readySlots.length}/${expectedConcurrency} slots). Run goldflow run media-ready before dispatch.`);
      }
    }
  }
  return runtime;
}

export function hybridManifestDispatchOptions({
  styleOnly = false,
  flowOnly = false,
  chatgptOnly = false,
  geminiOnly = false,
  federated = false,
  federatedChatGptEnabled = false,
  mode = "scene",
  flowConcurrency = HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
  persistentWorkerPool = false,
} = {}) {
  const effectiveFlowConcurrency = validateFlowRuntimeConcurrency(flowConcurrency);
  const hybridTotalConcurrency = effectiveFlowConcurrency + HYBRID_CHATGPT_IMAGE_CONCURRENCY;
  const federatedTotalConcurrency = effectiveFlowConcurrency + GOOGLE_GEMINI_IMAGE_CONCURRENCY
    + (federatedChatGptEnabled ? HYBRID_CHATGPT_IMAGE_CONCURRENCY : 0);
  if (flowOnly && chatgptOnly) throw new Error("A phase cannot be both Flow-only and ChatGPT-only.");
  if (geminiOnly && (flowOnly || chatgptOnly)) throw new Error("A Gemini-only phase cannot select another browser provider.");
  if (styleOnly && geminiOnly) throw new Error("A style-only phase cannot also be Gemini-only.");
  if (flowOnly) {
    return {
      workProvider: HYBRID_WEB_FLOW_PROVIDER,
      dispatchPolicy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
      allowedBrowserProviders: [GOOGLE_FLOW_BROWSER_PROVIDER],
      browserProviderConcurrency: { [GOOGLE_FLOW_BROWSER_PROVIDER]: effectiveFlowConcurrency },
      browserProviderMaxOrderedReferences: { [GOOGLE_FLOW_BROWSER_PROVIDER]: 4 },
      browserProviderWorkerSessionPolicy: {
        [GOOGLE_FLOW_BROWSER_PROVIDER]: persistentWorkerPool
          ? PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY
          : FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY,
      },
      browserProviderReceiptRequired: true,
      recommendedConcurrency: effectiveFlowConcurrency,
      maxConcurrency: effectiveFlowConcurrency,
    };
  }
  if (geminiOnly) {
    return {
      workProvider: HYBRID_WEB_FLOW_PROVIDER,
      dispatchPolicy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
      allowedBrowserProviders: [GOOGLE_GEMINI_BROWSER_PROVIDER],
      browserProviderConcurrency: { [GOOGLE_GEMINI_BROWSER_PROVIDER]: GOOGLE_GEMINI_IMAGE_CONCURRENCY },
      browserProviderMaxOrderedReferences: { [GOOGLE_GEMINI_BROWSER_PROVIDER]: 4 },
      browserProviderWorkerSessionPolicy: {
        [GOOGLE_GEMINI_BROWSER_PROVIDER]: persistentWorkerPool
          ? PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY
          : FRESH_BROWSER_SESSION_PER_JOB_POLICY,
      },
      browserProviderReceiptRequired: true,
      recommendedConcurrency: GOOGLE_GEMINI_IMAGE_CONCURRENCY,
      maxConcurrency: GOOGLE_GEMINI_IMAGE_CONCURRENCY,
    };
  }
  if (chatgptOnly) {
    return {
      workProvider: federated ? FEDERATED_WEB_IMAGE_PROVIDER : HYBRID_WEB_FLOW_PROVIDER,
      dispatchPolicy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
      allowedBrowserProviders: ["chatgpt"],
      browserProviderConcurrency: { chatgpt: HYBRID_CHATGPT_IMAGE_CONCURRENCY },
      browserProviderMaxOrderedReferences: { chatgpt: 4 },
      browserProviderWorkerSessionPolicy: { chatgpt: FRESH_BROWSER_SESSION_PER_JOB_POLICY },
      browserProviderReceiptRequired: true,
      recommendedConcurrency: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
      maxConcurrency: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
    };
  }
  if (federated) {
    if (styleOnly) {
      return {
        workProvider: FEDERATED_WEB_IMAGE_PROVIDER,
        dispatchPolicy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
        allowedBrowserProviders: [GOOGLE_GEMINI_BROWSER_PROVIDER],
        browserProviderConcurrency: { [GOOGLE_GEMINI_BROWSER_PROVIDER]: GOOGLE_GEMINI_IMAGE_CONCURRENCY },
        browserProviderMaxOrderedReferences: { [GOOGLE_GEMINI_BROWSER_PROVIDER]: 4 },
        browserProviderWorkerSessionPolicy: {
          [GOOGLE_GEMINI_BROWSER_PROVIDER]: persistentWorkerPool
            ? PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY
            : FRESH_BROWSER_SESSION_PER_JOB_POLICY,
        },
        browserProviderReceiptRequired: true,
        recommendedConcurrency: GOOGLE_GEMINI_IMAGE_CONCURRENCY,
        maxConcurrency: GOOGLE_GEMINI_IMAGE_CONCURRENCY,
      };
    }
    return {
      workProvider: FEDERATED_WEB_IMAGE_PROVIDER,
      dispatchPolicy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
      allowedBrowserProviders: [
        GOOGLE_FLOW_BROWSER_PROVIDER,
        GOOGLE_GEMINI_BROWSER_PROVIDER,
        ...(federatedChatGptEnabled ? ["chatgpt"] : []),
      ],
      browserProviderConcurrency: {
        [GOOGLE_FLOW_BROWSER_PROVIDER]: effectiveFlowConcurrency,
        [GOOGLE_GEMINI_BROWSER_PROVIDER]: GOOGLE_GEMINI_IMAGE_CONCURRENCY,
        ...(federatedChatGptEnabled ? { chatgpt: HYBRID_CHATGPT_IMAGE_CONCURRENCY } : {}),
      },
      browserProviderMaxOrderedReferences: {
        [GOOGLE_FLOW_BROWSER_PROVIDER]: 4,
        [GOOGLE_GEMINI_BROWSER_PROVIDER]: 4,
        ...(federatedChatGptEnabled ? { chatgpt: 4 } : {}),
      },
      browserProviderWorkerSessionPolicy: {
        [GOOGLE_FLOW_BROWSER_PROVIDER]: persistentWorkerPool
          ? PERSISTENT_GOOGLE_FLOW_PROJECT_PER_SLOT_POLICY
          : FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY,
        [GOOGLE_GEMINI_BROWSER_PROVIDER]: persistentWorkerPool
          ? PERSISTENT_BROWSER_TAB_PER_SLOT_POLICY
          : FRESH_BROWSER_SESSION_PER_JOB_POLICY,
        ...(federatedChatGptEnabled ? { chatgpt: FRESH_BROWSER_SESSION_PER_JOB_POLICY } : {}),
      },
      browserProviderReceiptRequired: true,
      recommendedConcurrency: federatedTotalConcurrency,
      maxConcurrency: federatedTotalConcurrency,
    };
  }
  return styleOnly
    ? {
        workProvider: HYBRID_WEB_FLOW_PROVIDER,
        dispatchPolicy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
        allowedBrowserProviders: ["chatgpt"],
        browserProviderConcurrency: { chatgpt: HYBRID_CHATGPT_IMAGE_CONCURRENCY },
        browserProviderMaxOrderedReferences: { chatgpt: 4 },
        browserProviderWorkerSessionPolicy: { chatgpt: FRESH_BROWSER_SESSION_PER_JOB_POLICY },
        browserProviderReceiptRequired: true,
        recommendedConcurrency: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
        maxConcurrency: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
      }
    : {
        workProvider: HYBRID_WEB_FLOW_PROVIDER,
        dispatchPolicy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
        allowedBrowserProviders: ["chatgpt", GOOGLE_FLOW_BROWSER_PROVIDER],
        browserProviderConcurrency: {
          chatgpt: HYBRID_CHATGPT_IMAGE_CONCURRENCY,
          [GOOGLE_FLOW_BROWSER_PROVIDER]: effectiveFlowConcurrency,
        },
        browserProviderMaxOrderedReferences: {
          chatgpt: 4,
          [GOOGLE_FLOW_BROWSER_PROVIDER]: 4,
        },
        browserProviderWorkerSessionPolicy: {
          chatgpt: FRESH_BROWSER_SESSION_PER_JOB_POLICY,
          [GOOGLE_FLOW_BROWSER_PROVIDER]: FRESH_GOOGLE_FLOW_PROJECT_PER_JOB_POLICY,
        },
        browserProviderReceiptRequired: true,
        recommendedConcurrency: hybridTotalConcurrency,
        maxConcurrency: hybridTotalConcurrency,
      };
}

async function waitForManifest({ manifestPath, timeoutMs, providerRuntimes }) {
  const started = Date.now();
  let lastProgress = "";
  let lastRuntimeCheck = 0;
  let blockedIdleSince = null;
  while (true) {
    const status = await getCodexWorkStatus({ manifestPath });
    const progress = JSON.stringify(status.counts);
    if (progress !== lastProgress) {
      process.stderr.write(`[browser-pool] ${path.basename(path.dirname(manifestPath))} ${progress}\n`);
      lastProgress = progress;
    }
    if (status.status === "completed") return status;
    if (status.status === "blocked_deadletter") {
      if (status.counts.pending === 0 && status.counts.leased === 0) return status;
      if (status.counts.leased === 0) {
        blockedIdleSince ??= Date.now();
        if (Date.now() - blockedIdleSince >= 15_000) return status;
      } else {
        blockedIdleSince = null;
      }
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for hybrid browser manifest ${manifestPath}.`);
    if (Date.now() - lastRuntimeCheck > 15_000) {
      for (const runtime of providerRuntimes) {
        await assertHostRuntime(runtime.path, runtime.provider, {
          expectedPlanLabel: runtime.planLabel,
          expectedModelLabel: runtime.modelLabel,
          requirePreparedWorkerPool: true,
        });
      }
      lastRuntimeCheck = Date.now();
    }
    await delay(2_000);
  }
}

async function waitForManifestAssetIds({ manifestPath, assetIds, timeoutMs, providerRuntimes }) {
  const wanted = new Set(parseIdScope(assetIds));
  if (!wanted.size) throw new Error("Streaming image wait requires exact asset IDs.");
  const started = Date.now();
  let lastProgress = "";
  let lastRuntimeCheck = 0;
  while (true) {
    const status = await getCodexWorkStatus({ manifestPath });
    const rows = status.items.filter((row) => wanted.has(row.asset_id));
    const unknown = [...wanted].filter((assetId) => !rows.some((row) => row.asset_id === assetId));
    if (unknown.length) throw new Error(`Streaming manifest does not contain: ${unknown.join(", ")}.`);
    const counts = Object.fromEntries(["pending", "leased", "completed", "deadlettered"].map((state) => [
      state,
      rows.filter((row) => row.status === state).length,
    ]));
    const progress = JSON.stringify(counts);
    if (progress !== lastProgress) {
      process.stderr.write(`[browser-pool-stream] ${path.basename(path.dirname(manifestPath))} ${progress}\n`);
      lastProgress = progress;
    }
    if (counts.pending === 0 && counts.leased === 0) {
      return {
        ...status,
        status: counts.deadlettered ? "blocked_deadletter" : "completed",
        item_count: rows.length,
        counts,
        items: rows,
      };
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for streaming browser assets in ${manifestPath}.`);
    if (Date.now() - lastRuntimeCheck > 15_000) {
      for (const runtime of providerRuntimes) {
        await assertHostRuntime(runtime.path, runtime.provider, {
          expectedPlanLabel: runtime.planLabel,
          expectedModelLabel: runtime.modelLabel,
          requirePreparedWorkerPool: true,
        });
      }
      lastRuntimeCheck = Date.now();
    }
    await delay(2_000);
  }
}

async function providerPhaseSummary(manifestPath, status) {
  const completedAssetIds = status.items.filter((row) => row.status === "completed").map((row) => row.asset_id);
  const failedAssetIds = status.items.filter((row) => row.status === "deadlettered").map((row) => row.asset_id);
  const pendingAssetIds = status.items.filter((row) => row.status === "pending").map((row) => row.asset_id);
  let validation = null;
  if (completedAssetIds.length) {
    const partial = completedAssetIds.length !== status.item_count;
    validation = await validateCodexWorkManifest({
      manifestPath,
      assetIds: partial ? completedAssetIds : [],
      allowIncomplete: partial,
    });
    if (validation.status !== "passed") {
      throw new Error(`Hybrid browser manifest validation failed with ${validation.finding_count} finding(s): ${manifestPath}`);
    }
  }
  return {
    manifest_id: status.manifest_id,
    manifest_path: manifestPath,
    manifest_sha256: await sha256File(manifestPath),
    status: status.status,
    item_count: status.item_count,
    counts: status.counts,
    completed_asset_ids: completedAssetIds,
    failed_asset_ids: failedAssetIds,
    pending_asset_ids: pendingAssetIds,
    completed_by_browser_provider: status.completed_by_browser_provider,
    allowed_browser_providers: status.allowed_browser_providers,
    browser_provider_concurrency: status.browser_provider_concurrency,
    browser_provider_worker_session_policy: status.browser_provider_worker_session_policy,
    validation_status: validation?.status ?? "not_applicable_no_completions",
  };
}

async function providerStreamingScopeSummary(manifestPath, status) {
  const completedAssetIds = status.items.filter((row) => row.status === "completed").map((row) => row.asset_id);
  const failedAssetIds = status.items.filter((row) => row.status === "deadlettered").map((row) => row.asset_id);
  let validation = null;
  if (completedAssetIds.length) {
    validation = await validateCodexWorkManifest({
      manifestPath,
      assetIds: completedAssetIds,
      allowIncomplete: true,
    });
    if (validation.status !== "passed") {
      throw new Error(`Streaming browser manifest validation failed with ${validation.finding_count} finding(s): ${manifestPath}`);
    }
  }
  return {
    manifest_id: status.manifest_id,
    manifest_path: manifestPath,
    manifest_sha256: await sha256File(manifestPath),
    status: status.status,
    item_count: status.item_count,
    counts: status.counts,
    completed_asset_ids: completedAssetIds,
    failed_asset_ids: failedAssetIds,
    pending_asset_ids: status.items.filter((row) => row.status === "pending").map((row) => row.asset_id),
    completed_by_browser_provider: Object.fromEntries(
      (status.allowed_browser_providers ?? []).map((provider) => [
        provider,
        status.items.filter((row) => row.status === "completed" && row.browser_provider === provider).length,
      ]),
    ),
    allowed_browser_providers: status.allowed_browser_providers,
    browser_provider_concurrency: status.browser_provider_concurrency,
    browser_provider_worker_session_policy: status.browser_provider_worker_session_policy,
    validation_status: validation?.status ?? "not_applicable_no_completions",
    streaming_queue: status.streaming_queue ?? null,
  };
}

async function importManifest({
  identity,
  manifestPath,
  referencesOnly,
  assetIds,
  repairReason,
  qaRecovery,
  allowPartial,
  allowSourceArtifactDrift = false,
  wavefrontPrefetch = false,
  promptsPath,
  referencePlanPath,
  characterStateRefsPath,
  imagegenReportPath,
  cutExecutionLedgerPath,
  dataRoot,
}) {
  const args = [
    path.join(repoRoot, "scripts", "codex-image-import-staged.mjs"),
    ...identityCliArgs(identity),
    "--manifest", manifestPath,
    "--prompts", promptsPath,
    "--reference-plan", referencePlanPath,
    "--character-state-refs", characterStateRefsPath,
    "--output", imagegenReportPath,
    "--cut-execution-ledger", cutExecutionLedgerPath,
    referencesOnly ? "--references-only" : "--image-ids",
    referencesOnly ? "true" : assetIds.join(","),
  ];
  if (referencesOnly) args.push("--reference-ids", assetIds.join(","));
  else args.push("--provider-batch-import", "true");
  if (repairReason || allowSourceArtifactDrift) args.push("--force-import", "true");
  if (qaRecovery) args.push("--qa-recovery", "true");
  if (allowPartial) args.push("--allow-partial-manifest", "true");
  if (allowSourceArtifactDrift) args.push("--allow-source-artifact-drift", "true");
  if (wavefrontPrefetch) args.push("--wavefront-prefetch", "true");
  const result = await execFile(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30 * 60_000,
  });
  return result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "import completed";
}

async function reconcileCompatibleManifestCompletions({
  mode,
  episodeDir,
  currentRows,
  acceptedAssetIds,
  currentAcceptedHashesById = new Map(),
  currentAcceptedAtById = new Map(),
  requestedIds,
  repairReason = null,
  qaRecovery = false,
  identity,
  promptsPath,
  referencePlanPath,
  characterStateRefsPath,
  imagegenReportPath,
  cutExecutionLedgerPath,
  dataRoot,
  downloadsRoot,
  wavefrontPrefetch = false,
}) {
  const selectedCompletionById = await findSourceCompatibleHybridCompletions({
    episodeDir,
    mode,
    currentRows,
    requestedIds,
    currentAcceptedHashesById,
    currentAcceptedAtById,
    downloadsRoot,
  });
  for (const assetId of acceptedAssetIds) selectedCompletionById.delete(assetId);
  const byManifest = new Map();
  for (const [assetId, selected] of selectedCompletionById.entries()) {
    const ids = byManifest.get(selected.manifestPath) ?? [];
    ids.push(assetId);
    byManifest.set(selected.manifestPath, ids);
  }
  const reconciled = [];
  for (const [manifestPath, assetIds] of byManifest.entries()) {
    await importManifest({
      identity,
      manifestPath,
      referencesOnly: mode === "reference",
      assetIds,
      repairReason,
      qaRecovery,
      allowPartial: true,
      allowSourceArtifactDrift: true,
      promptsPath,
      referencePlanPath,
      characterStateRefsPath,
      imagegenReportPath,
      cutExecutionLedgerPath,
      dataRoot,
      wavefrontPrefetch,
    });
    reconciled.push(...assetIds);
  }
  return reconciled;
}

async function createAndRunPhase({
  mode,
  episodeDir,
  promptsPath,
  referencePlanPath,
  characterStateRefsPath,
  assetIds,
  sharedReferenceIds = [],
  styleOnly,
  flowOnly = false,
  chatgptOnly = false,
  geminiOnly = false,
  federated = false,
  chatgptElectron = false,
  chatgptElectronConcurrency = HYBRID_CHATGPT_IMAGE_CONCURRENCY,
  flowRuntimeConcurrency = HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
  repairReason,
  healthProof,
  bridges,
  runtimes,
  timeoutMs,
  identity,
  dataRoot,
  checkHostRuntimes = true,
  qaRecovery = false,
  repairEvidence = null,
  imagegenReportPath,
  cutExecutionLedgerPath,
  wavefrontPrefetch = false,
  downloadsRoot,
}) {
  if (!assetIds.length) return null;
  if ([flowOnly, chatgptOnly, geminiOnly].filter(Boolean).length > 1) throw new Error("A phase can select only one browser provider.");
  const federatedChatGptEnabled = federatedWebImageAutomaticChatGptEnabled(identity);
  const activeRuntimes = flowOnly
    ? [runtimes.flow]
    : geminiOnly ? [runtimes.gemini]
      : federated && styleOnly ? [runtimes.gemini]
        : styleOnly || chatgptOnly ? [runtimes.chatgpt]
          : federated ? [runtimes.flow, runtimes.gemini, ...(federatedChatGptEnabled ? [runtimes.chatgpt] : [])]
            : [runtimes.chatgpt, runtimes.flow];
  const checkedRuntimes = chatgptElectron
    ? activeRuntimes.filter((runtime) => runtime.provider !== "chatgpt")
    : activeRuntimes;
  if (checkHostRuntimes) {
    await Promise.all(checkedRuntimes
      .map((runtime) => assertHostRuntime(runtime.path, runtime.provider, {
        expectedPlanLabel: runtime.planLabel,
        expectedModelLabel: runtime.modelLabel,
        requirePreparedWorkerPool: true,
      })));
  }
  const dispatch = hybridManifestDispatchOptions({
    styleOnly,
    flowOnly,
    chatgptOnly,
    geminiOnly,
    federated,
    federatedChatGptEnabled,
    mode,
    flowConcurrency: flowRuntimeConcurrency,
    persistentWorkerPool: federated
      && identity.image_provider_options?.routing_policy === FEDERATED_WEB_IMAGE_ROUTING_POLICY,
  });
  const created = await createCodexWorkManifest({
    mode,
    episodeDir,
    promptsPath,
    referencePlanPath,
    characterStateRefsPath,
    imageIds: mode === "scene" ? assetIds : [],
    referenceIds: mode === "reference" ? assetIds : [],
    sharedReferenceIds,
    maxAttempts: 1,
    leaseSeconds: 1800,
    repairReason,
    repairEvidence,
    verificationGateBypass: styleOnly || assetIds.length <= 4 ? null : {
      kind: "prior_health_proof",
      path: healthProof.path,
      sha256: healthProof.sha256,
    },
    ...dispatch,
  });
  const activeBridges = flowOnly
    ? [bridges.flow]
    : geminiOnly ? [bridges.gemini]
      : federated && styleOnly ? [bridges.gemini]
        : styleOnly || chatgptOnly ? [bridges.chatgpt]
          : federated ? [bridges.flow, bridges.gemini, ...(federatedChatGptEnabled ? [bridges.chatgpt] : [])]
            : [bridges.chatgpt, bridges.flow];
  const inactiveBridges = flowOnly
    ? [bridges.chatgpt, bridges.gemini]
    : geminiOnly ? [bridges.chatgpt, bridges.flow]
      : federated && styleOnly ? [bridges.chatgpt, bridges.flow]
        : styleOnly || chatgptOnly ? [bridges.flow, bridges.gemini]
          : federated ? (federatedChatGptEnabled ? [] : [bridges.chatgpt]) : [bridges.gemini];
  for (const bridge of inactiveBridges) await bridge.deactivateManifest(created.manifest.manifest_path);
  for (const bridge of activeBridges) await bridge.activateManifest(created.manifest.manifest_path);
  const electronDispatch = chatgptElectron && activeBridges.includes(bridges.chatgpt)
    ? runElectronChatGptManifest({
        bridge: bridges.chatgpt,
        manifestPath: created.manifest.manifest_path,
        downloadsRoot,
        projectUrl: identity?.image_provider_options?.chatgpt_project_url ?? null,
        concurrency: chatgptElectronConcurrency,
      })
    : null;
  try {
    const terminalStatus = await waitForManifest({
      manifestPath: created.manifest.manifest_path,
      timeoutMs,
      providerRuntimes: checkHostRuntimes ? checkedRuntimes : [],
    });
    await electronDispatch;
    const phase = await providerPhaseSummary(created.manifest.manifest_path, terminalStatus);
    if (phase.completed_asset_ids.length) {
      await importManifest({
        identity,
        manifestPath: created.manifest.manifest_path,
        referencesOnly: mode === "reference",
        assetIds: phase.completed_asset_ids,
        repairReason,
        qaRecovery,
        allowPartial: phase.completed_asset_ids.length !== phase.item_count,
        promptsPath,
        referencePlanPath,
        characterStateRefsPath,
        imagegenReportPath,
        cutExecutionLedgerPath,
        dataRoot,
        wavefrontPrefetch,
      });
    }
    return phase;
  } finally {
    await electronDispatch?.catch(() => null);
    for (const bridge of activeBridges) await bridge.deactivateManifest(created.manifest.manifest_path).catch(() => null);
  }
}

async function runHeroCandidateLane({
  promptPlan,
  canonicalPromptsPath,
  candidateCanonicalIds,
  episodeDir,
  referencePlanPath,
  characterStateRefsPath,
  healthProof,
  bridges,
  runtimes,
  timeoutMs,
  identity,
  dataRoot,
  downloadsRoot,
  checkHostRuntimes,
  flowOnly,
  chatgptOnly,
  geminiOnly,
  federated,
  chatgptElectron,
  chatgptElectronConcurrency,
  flowRuntimeConcurrency,
}) {
  if (!candidateCanonicalIds.length) return null;
  const sourcePromptPlanSha256 = await sha256File(canonicalPromptsPath);
  const completeCandidatePlan = buildHeroCandidatePromptPlan(promptPlan, {
    sourcePath: canonicalPromptsPath,
    sourceSha256: sourcePromptPlanSha256,
  });
  const wantedCanonicalIds = new Set(candidateCanonicalIds);
  const candidatePlan = {
    ...completeCandidatePlan,
    canonical_hero_image_ids: completeCandidatePlan.canonical_hero_image_ids.filter((id) => wantedCanonicalIds.has(id)),
    prompts: completeCandidatePlan.prompts.filter((row) => wantedCanonicalIds.has(row.hero_candidate?.canonical_image_id)),
  };
  candidatePlan.candidate_count = candidatePlan.prompts.length;
  if (!candidatePlan.prompts.length) return null;
  const root = path.join(episodeDir, "reports", "hero-image-candidates");
  await fs.mkdir(root, { recursive: true });
  const candidatePlanPath = path.join(root, `hero_candidate_prompt_plan_${identity.episode}.json`);
  const candidateImagegenReportPath = path.join(root, `hero_candidate_imagegen_report_${identity.episode}.json`);
  const candidateCutLedgerPath = path.join(root, `hero_candidate_cut_execution_ledger_${identity.episode}.json`);
  await writeJson(candidatePlanPath, candidatePlan);
  const candidateIds = candidatePlan.prompts.map((row) => row.image_id);
  const phase = await createAndRunPhase({
    mode: "scene",
    episodeDir,
    promptsPath: candidatePlanPath,
    referencePlanPath,
    characterStateRefsPath,
    assetIds: candidateIds,
    styleOnly: false,
    flowOnly,
    chatgptOnly,
    geminiOnly,
    federated,
    chatgptElectron,
    chatgptElectronConcurrency,
    flowRuntimeConcurrency,
    repairReason: null,
    healthProof,
    bridges,
    runtimes,
    timeoutMs,
    identity,
    dataRoot,
    downloadsRoot,
    checkHostRuntimes,
    qaRecovery: false,
    repairEvidence: null,
    imagegenReportPath: candidateImagegenReportPath,
    cutExecutionLedgerPath: candidateCutLedgerPath,
    wavefrontPrefetch: false,
  });
  const candidateImagegenReport = await readJson(candidateImagegenReportPath, null);
  if (!Array.isArray(candidateImagegenReport?.results)) {
    return {
      status: "blocked",
      phase,
      candidate_plan_path: candidatePlanPath,
      failed_canonical_image_ids: candidateCanonicalIds,
      selected_canonical_image_ids: [],
      reason: "candidate_imagegen_report_missing",
    };
  }
  const semanticAuditPath = path.join(root, `hero_candidate_semantic_audit_${identity.episode}.json`);
  const semanticAudit = await buildImageSemanticAudit({
    promptPlan: candidatePlan,
    imagegenReport: candidateImagegenReport,
    promptPlanPath: candidatePlanPath,
    imagegenReportPath: candidateImagegenReportPath,
    outputPath: semanticAuditPath,
    callsDir: path.join(root, "semantic-calls"),
    repoRoot,
    concurrency: 8,
    openingSec: Number.POSITIVE_INFINITY,
    ordinarySampleRate: 1,
    reasoningEffort: "medium",
  });
  const resultById = new Map(candidateImagegenReport.results.map((row) => [String(row?.image_id ?? ""), row]));
  const canonicalPromptById = new Map(promptPlan.prompts.map((row) => [String(row?.image_id ?? ""), row]));
  const selectedCanonicalImageIds = [];
  const failedCanonicalImageIds = [];
  const selectionPaths = [];
  for (const group of heroCandidateGroups(candidatePlan)) {
    const canonicalPrompt = canonicalPromptById.get(group.canonical_image_id);
    const candidateRows = group.prompts.map((candidatePrompt) => {
      const result = resultById.get(candidatePrompt.image_id);
      return {
        image_id: candidatePrompt.image_id,
        candidate_label: candidatePrompt.hero_candidate?.candidate_label,
        image_path: result?.image_path ?? null,
        image_sha256: result?.generated?.output_sha256 ?? null,
        browser_provider: result?.browser_provider ?? null,
        provider_receipt_path: result?.provider_receipt_path ?? null,
        provider_receipt_sha256: result?.provider_receipt_sha256 ?? null,
      };
    }).filter((row) => row.image_path && row.image_sha256);
    if (!canonicalPrompt || !candidateRows.length) {
      failedCanonicalImageIds.push(group.canonical_image_id);
      continue;
    }
    const selectionDir = path.join(root, group.canonical_image_id);
    await fs.mkdir(selectionDir, { recursive: true });
    const selectorOutputPath = path.join(selectionDir, "blind_selector_response.json");
    const selection = await selectHeroCandidate({
      canonicalPrompt,
      candidates: candidateRows,
      semanticAuditRows: semanticAudit.rows,
      outputPath: selectorOutputPath,
      repoRoot,
      reasoningEffort: "medium",
    });
    const selectionPath = path.join(selectionDir, "selection.json");
    await writeJson(selectionPath, selection);
    const receiptPath = path.join(selectionDir, "canonical_selection_receipt.json");
    const receipt = await writeCanonicalHeroSelectionReceipt({
      selection,
      outputPath: receiptPath,
      canonicalPromptPlanPath: canonicalPromptsPath,
      canonicalPromptPlanSha256: sourcePromptPlanSha256,
    });
    const selected = selection.selected_candidate;
    const importArgs = [
      path.join(repoRoot, "scripts", "codex-image-manual-import.mjs"),
      ...identityCliArgs(identity),
      "--prompts", canonicalPromptsPath,
      "--image-id", group.canonical_image_id,
      "--source", selected.image_path,
      "--output", path.join(episodeDir, `imagegen_report_${identity.episode}.json`),
      "--cut-execution-ledger", path.join(episodeDir, "cut_execution_ledger.json"),
      "--import-route", "hero_candidate_selection",
      "--work-manifest", phase.manifest_path,
      "--browser-provider", selected.browser_provider,
      "--provider-receipt", receiptPath,
      "--provider-receipt-sha256", receipt.sha256,
      "--model", "blind_selected_federated_hero_candidate",
    ];
    await execFile(process.execPath, importArgs, {
      cwd: repoRoot,
      env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30 * 60_000,
    });
    selectedCanonicalImageIds.push(group.canonical_image_id);
    selectionPaths.push({
      canonical_image_id: group.canonical_image_id,
      selection_path: selectionPath,
      selection_sha256: await sha256File(selectionPath),
      receipt_path: receiptPath,
      receipt_sha256: receipt.sha256,
    });
  }
  return {
    status: failedCanonicalImageIds.length ? "partial" : "passed",
    phase,
    candidate_plan_path: candidatePlanPath,
    candidate_plan_sha256: await sha256File(candidatePlanPath),
    candidate_imagegen_report_path: candidateImagegenReportPath,
    candidate_imagegen_report_sha256: await sha256File(candidateImagegenReportPath),
    semantic_audit_path: semanticAuditPath,
    semantic_audit_sha256: await sha256File(semanticAuditPath),
    selected_canonical_image_ids: selectedCanonicalImageIds,
    failed_canonical_image_ids: failedCanonicalImageIds,
    selections: selectionPaths,
  };
}

export async function openWavefrontBrowserImageStream({
  episodeDir,
  identity,
  streamId,
  dataRoot = defaultDataRoot,
  stateRoot = process.env.GOLDFLOW_STUDIO_STATE_DIR ?? path.join(os.homedir(), ".goldflow-studio"),
  downloadsRoot = path.join(os.homedir(), "Downloads", "GoldflowStudio"),
  flowRuntimeConcurrency = HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
  timeoutMs = 6 * 60 * 60_000,
  checkHostRuntimes = true,
} = {}) {
  const resolvedEpisodeDir = path.resolve(episodeDir);
  const resolvedDataRoot = path.resolve(dataRoot);
  const resolvedStateRoot = path.resolve(stateRoot);
  const resolvedDownloadsRoot = path.resolve(downloadsRoot);
  if (!isFederatedWebImageProvider(identity?.image_provider)) {
    throw new Error("Appendable wavefront streaming is restricted to the identity-locked federated Flow + Gemini image pool.");
  }
  const identityStatus = await federatedWebImageIdentityStatus(identity);
  if (!identityStatus.done) throw new Error(identityStatus.evidence);
  const federatedChatGptEnabled = federatedWebImageAutomaticChatGptEnabled(identity);
  const dispatch = hybridManifestDispatchOptions({
    mode: "scene",
    federated: true,
    federatedChatGptEnabled,
    flowConcurrency: flowRuntimeConcurrency,
    persistentWorkerPool: true,
  });
  const runtimes = {
    chatgpt: { provider: "chatgpt", path: path.join(resolvedStateRoot, "studio-runtime.json") },
    flow: {
      provider: GOOGLE_FLOW_BROWSER_PROVIDER,
      path: path.join(resolvedStateRoot, "providers", GOOGLE_FLOW_BROWSER_PROVIDER, "studio-runtime.json"),
      planLabel: identity.image_provider_options.google_flow.plan_label,
      modelLabel: identity.image_provider_options.google_flow.model_label,
    },
    gemini: {
      provider: GOOGLE_GEMINI_BROWSER_PROVIDER,
      path: path.join(resolvedStateRoot, "providers", GOOGLE_GEMINI_BROWSER_PROVIDER, "studio-runtime.json"),
      planLabel: identity.image_provider_options.google_gemini?.plan_label ?? "Ultra",
      modelLabel: identity.image_provider_options.google_gemini?.model_label ?? "Nano Banana 2",
    },
  };
  const runtimeByProvider = new Map([
    ["chatgpt", runtimes.chatgpt],
    [GOOGLE_FLOW_BROWSER_PROVIDER, runtimes.flow],
    [GOOGLE_GEMINI_BROWSER_PROVIDER, runtimes.gemini],
  ]);
  const activeRuntimes = (dispatch.allowedBrowserProviders ?? []).map((provider) => runtimeByProvider.get(provider)).filter(Boolean);
  if (checkHostRuntimes) {
    await Promise.all(activeRuntimes.map((runtime) => assertHostRuntime(runtime.path, runtime.provider, {
      expectedPlanLabel: runtime.planLabel,
      expectedModelLabel: runtime.modelLabel,
      requirePreparedWorkerPool: true,
    })));
  }
  const bridgeByProvider = new Map([
    ["chatgpt", await new GoldflowBridge({
      repoRoot,
      dataRoot: resolvedDataRoot,
      stateDir: resolvedStateRoot,
      downloadsRoot: resolvedDownloadsRoot,
      browserProvider: "chatgpt",
    }).init()],
    [GOOGLE_FLOW_BROWSER_PROVIDER, await new GoldflowBridge({
      repoRoot,
      dataRoot: resolvedDataRoot,
      stateDir: path.join(resolvedStateRoot, "providers", GOOGLE_FLOW_BROWSER_PROVIDER),
      downloadsRoot: resolvedDownloadsRoot,
      browserProvider: GOOGLE_FLOW_BROWSER_PROVIDER,
    }).init()],
    [GOOGLE_GEMINI_BROWSER_PROVIDER, await new GoldflowBridge({
      repoRoot,
      dataRoot: resolvedDataRoot,
      stateDir: path.join(resolvedStateRoot, "providers", GOOGLE_GEMINI_BROWSER_PROVIDER),
      downloadsRoot: resolvedDownloadsRoot,
      browserProvider: GOOGLE_GEMINI_BROWSER_PROVIDER,
    }).init()],
  ]);
  const activeBridges = (dispatch.allowedBrowserProviders ?? []).map((provider) => bridgeByProvider.get(provider)).filter(Boolean);
  const healthProof = {
    kind: "prior_health_proof",
    path: identity.image_provider_options.google_flow.health_proof_path,
    sha256: identity.image_provider_options.google_flow.health_proof_sha256,
  };
  const referencePlanPath = path.join(resolvedEpisodeDir, "visual_reference_plan.json");
  const characterStateRefsPath = path.join(resolvedEpisodeDir, "character_state_refs.json");
  let manifestPath = null;
  let appendChain = Promise.resolve();
  let sealed = false;
  let activated = false;

  const activateOnce = async () => {
    if (activated) return;
    await Promise.all(activeBridges.map((bridge) => bridge.activateManifest(manifestPath)));
    activated = true;
  };
  const deactivate = async () => {
    if (!activated || !manifestPath) return;
    await Promise.all(activeBridges.map((bridge) => bridge.deactivateManifest(manifestPath).catch(() => null)));
    activated = false;
  };
  const scheduleAppend = (input) => {
    if (sealed) throw new Error("Wavefront browser image stream is already sealed.");
    const exactAssetIds = parseIdScope(input.assetIds);
    if (!exactAssetIds.length) throw new Error("Wavefront browser image stream append requires exact asset IDs.");
    const appendReady = appendChain.then(async () => {
      const currentPlan = await readJson(input.promptsPath, null);
      const currentRows = (currentPlan?.prompts ?? []).filter((row) => exactAssetIds.includes(String(row?.image_id ?? "")));
      const reconciledAssetIds = await reconcileCompatibleManifestCompletions({
        mode: "scene",
        episodeDir: resolvedEpisodeDir,
        currentRows,
        acceptedAssetIds: new Set(),
        requestedIds: new Set(exactAssetIds),
        identity,
        promptsPath: input.promptsPath,
        referencePlanPath,
        characterStateRefsPath,
        imagegenReportPath: input.imagegenReportPath,
        cutExecutionLedgerPath: input.cutExecutionLedgerPath,
        dataRoot: resolvedDataRoot,
        downloadsRoot: resolvedDownloadsRoot,
        wavefrontPrefetch: true,
      });
      const reconciledSet = new Set(reconciledAssetIds);
      const pendingAssetIds = exactAssetIds.filter((assetId) => !reconciledSet.has(assetId));
      const compatibleDeadletters = await findSourceCompatibleHybridDeadletters({
        episodeDir: resolvedEpisodeDir,
        mode: "scene",
        currentRows,
        requestedIds: new Set(pendingAssetIds),
      });
      if (compatibleDeadletters.size) {
        throw new Error(`Streaming wavefront will not resubmit prior deadletters: ${[...compatibleDeadletters.keys()].join(", ")}. Use an evidence-bound exact-ID repair command.`);
      }
      if (!pendingAssetIds.length) {
        return { manifest: null, pending_asset_ids: [], reconciled_asset_ids: reconciledAssetIds };
      }
      const manifestOptions = {
        streamId,
        mode: "scene",
        episodeDir: resolvedEpisodeDir,
        promptsPath: input.promptsPath,
        imageIds: pendingAssetIds,
        maxAttempts: 1,
        leaseSeconds: 1800,
        verificationGateBypass: healthProof,
        ...dispatch,
      };
      if (!manifestPath) {
        const opened = await openCodexWorkManifestStream(manifestOptions);
        manifestPath = opened.manifest.manifest_path;
        await activateOnce();
        if (opened.resumed === true) {
          const appended = await appendCodexWorkManifestStream({ manifestPath, ...manifestOptions });
          return { ...appended, pending_asset_ids: pendingAssetIds, reconciled_asset_ids: reconciledAssetIds };
        }
        return {
          manifest: opened.manifest,
          appended_asset_ids: pendingAssetIds,
          appended_count: pendingAssetIds.length,
          pending_asset_ids: pendingAssetIds,
          reconciled_asset_ids: reconciledAssetIds,
        };
      }
      const appended = await appendCodexWorkManifestStream({ manifestPath, ...manifestOptions });
      return { ...appended, pending_asset_ids: pendingAssetIds, reconciled_asset_ids: reconciledAssetIds };
    });
    appendChain = appendReady;
    return appendReady.then(async (appendResult) => {
      const pendingAssetIds = appendResult.pending_asset_ids ?? exactAssetIds;
      if (!pendingAssetIds.length) {
        const batchReport = {
          schema: "goldflow_wavefront_stream_batch_v1",
          status: "passed",
          stream_id: streamId,
          manifest_id: null,
          manifest_path: null,
          exact_asset_ids: exactAssetIds,
          reconciled_asset_ids: appendResult.reconciled_asset_ids ?? [],
          one_creative_submission_per_item: true,
          automatic_retry_policy: "none",
          phase: { status: "reused_compatible_completions", completed_asset_ids: exactAssetIds, failed_asset_ids: [] },
          updated_at: new Date().toISOString(),
        };
        if (input.poolReportPath) await writeJson(input.poolReportPath, batchReport);
        return { code: 0, phase: batchReport.phase, batch_report: batchReport };
      }
      const terminalStatus = await waitForManifestAssetIds({
        manifestPath,
        assetIds: pendingAssetIds,
        timeoutMs,
        providerRuntimes: checkHostRuntimes ? activeRuntimes : [],
      });
      const phase = await providerStreamingScopeSummary(manifestPath, terminalStatus);
      phase.reconciled_asset_ids = appendResult.reconciled_asset_ids ?? [];
      if (phase.completed_asset_ids.length) {
        await importManifest({
          identity,
          manifestPath,
          referencesOnly: false,
          assetIds: phase.completed_asset_ids,
          repairReason: null,
          qaRecovery: false,
          allowPartial: true,
          promptsPath: input.promptsPath,
          referencePlanPath,
          characterStateRefsPath,
          imagegenReportPath: input.imagegenReportPath,
          cutExecutionLedgerPath: input.cutExecutionLedgerPath,
          dataRoot: resolvedDataRoot,
          wavefrontPrefetch: true,
        });
      }
      const batchReport = {
        schema: "goldflow_wavefront_stream_batch_v1",
        status: phase.failed_asset_ids.length ? "blocked" : "passed",
        stream_id: streamId,
        manifest_id: phase.manifest_id,
        manifest_path: phase.manifest_path,
        exact_asset_ids: exactAssetIds,
        one_creative_submission_per_item: true,
        automatic_retry_policy: "none",
        phase,
        updated_at: new Date().toISOString(),
      };
      if (input.poolReportPath) await writeJson(input.poolReportPath, batchReport);
      return { code: phase.failed_asset_ids.length ? 1 : 0, phase, batch_report: batchReport };
    });
  };

  return {
    stream_id: streamId,
    append(input) {
      return scheduleAppend(input);
    },
    async seal() {
      if (sealed) return { status: "already_sealed", manifest_path: manifestPath };
      sealed = true;
      try {
        await appendChain;
        if (!manifestPath) return { status: "empty", manifest_path: null };
        await sealCodexWorkManifestStream({ manifestPath, streamId });
        const terminal = await waitForManifest({
          manifestPath,
          timeoutMs,
          providerRuntimes: checkHostRuntimes ? activeRuntimes : [],
        });
        return providerPhaseSummary(manifestPath, terminal);
      } finally {
        await deactivate();
      }
    },
    async abort() {
      sealed = true;
      await deactivate();
      return { status: "aborted", manifest_path: manifestPath };
    },
    get manifest_path() {
      return manifestPath;
    },
  };
}

export async function runHybridBrowserImagePool(flags) {
  const dataRoot = path.resolve(flags["data-root"] ?? defaultDataRoot);
  const episodeDir = episodeDirectory(flags, dataRoot);
  const identityPath = path.join(episodeDir, "run_identity.json");
  const lockedIdentity = await readJson(identityPath, null);
  if (!lockedIdentity) throw new Error(`Missing run identity: ${identityPath}`);
  const effectiveImageRoute = await effectiveImageIdentityForEpisode(episodeDir, identityPath, lockedIdentity);
  const identity = effectiveImageRoute.identity;
  if (!isBrowserPoolImageProvider(identity.image_provider)) {
    throw new Error(`Browser image pool requires image_provider=${FEDERATED_WEB_IMAGE_PROVIDER}, ${HYBRID_WEB_FLOW_PROVIDER}, or ${GOOGLE_FLOW_IMAGE_PROVIDER}; identity locks ${identity.image_provider ?? "missing"}.`);
  }
  const flowPrimary = isGoogleFlowPrimaryProvider(identity.image_provider);
  const federated = isFederatedWebImageProvider(identity.image_provider);
  const identityStatus = federated
    ? await federatedWebImageIdentityStatus(identity)
    : flowPrimary
      ? await googleFlowPrimaryIdentityStatus(identity)
      : await hybridWebFlowIdentityStatus(identity);
  if (!identityStatus.done) throw new Error(identityStatus.evidence);

  const referencesOnly = boolFlag(flags["references-only"]) || flags.mode === "reference";
  const qaRecovery = boolFlag(flags["qa-recovery"]);
  const providerMigration = boolFlag(flags["provider-migration"]);
  const manualProviderAuthEvidencePath = String(flags["manual-provider-auth-evidence"] ?? "").trim();
  const wavefrontPrefetch = boolFlag(flags["wavefront-prefetch"]);
  const reconcileOnly = boolFlag(flags["reconcile-only"]);
  const flowOnly = flowPrimary || boolFlag(flags["flow-only"]);
  const chatgptOnly = boolFlag(flags["chatgpt-only"]);
  const geminiOnly = boolFlag(flags["gemini-only"]);
  const chatgptElectron = boolFlag(flags["chatgpt-electron"]);
  const chatgptElectronConcurrency = Math.max(1, Math.min(
    HYBRID_CHATGPT_IMAGE_CONCURRENCY,
    Number(flags["chatgpt-electron-concurrency"] ?? HYBRID_CHATGPT_IMAGE_CONCURRENCY),
  ));
  const flowRuntimeConcurrency = validateFlowRuntimeConcurrency(flags["flow-runtime-concurrency"]);
  if ([flowOnly, chatgptOnly, geminiOnly].filter(Boolean).length > 1) throw new Error("--flow-only, --chatgpt-only, and --gemini-only are mutually exclusive.");
  const repairReason = String(flags["repair-reason"] ?? "").trim();
  const repairSharedReferenceIds = validateRepairSharedReferenceScope({
    ids: parseIdScope(flags["shared-reference-ids"], flags["shared-reference-id"]),
    repairReason,
    referencesOnly,
  });
  const requestedIds = new Set(parseIdScope(
    referencesOnly ? flags["reference-ids"] : flags["image-ids"],
    referencesOnly ? flags["reference-id"] : flags["image-id"],
    referencesOnly ? null : flags["cut-ids"],
    referencesOnly ? null : flags["cut-id"],
  ));
  if (repairReason && !requestedIds.size) throw new Error("--repair-reason requires exact --image-ids/--reference-ids scope.");
  if (federated && chatgptOnly && !federatedWebImageAutomaticChatGptEnabled(identity)
    && (!repairReason || !requestedIds.size)) {
    throw new Error("This federated identity permits ChatGPT Image only for an explicit exact-ID repair with --repair-reason.");
  }
  if (qaRecovery && !repairReason) throw new Error("--qa-recovery true requires an exact repair reason and evidence-bound image IDs.");
  if (providerMigration && (!repairReason || !requestedIds.size || referencesOnly)) {
    throw new Error("--provider-migration true requires an exact scene --image-ids scope and --repair-reason.");
  }
  if (providerMigration && qaRecovery) throw new Error("--provider-migration and --qa-recovery are mutually exclusive.");
  if (manualProviderAuthEvidencePath && (!repairReason || !requestedIds.size || !chatgptOnly || qaRecovery || providerMigration)) {
    throw new Error("--manual-provider-auth-evidence requires an exact ChatGPT-only repair and cannot be combined with QA recovery or provider migration.");
  }
  if (reconcileOnly && (repairReason || qaRecovery || wavefrontPrefetch)) {
    throw new Error("--reconcile-only true cannot be combined with repair, QA-recovery, or wavefront-prefetch flags.");
  }
  if (wavefrontPrefetch && (referencesOnly || qaRecovery || repairReason || !requestedIds.size)) {
    throw new Error("--wavefront-prefetch true requires exact non-repair scene-image scope.");
  }

  const stateRoot = path.resolve(flags["state-dir"] ?? process.env.GOLDFLOW_STUDIO_STATE_DIR ?? path.join(os.homedir(), ".goldflow-studio"));
  const downloadsRoot = path.resolve(flags["downloads-root"] ?? process.env.GOLDFLOW_STUDIO_DOWNLOADS_ROOT ?? path.join(os.homedir(), "Downloads", "GoldflowStudio"));
  const runtimes = {
    chatgpt: { provider: "chatgpt", path: path.join(stateRoot, "studio-runtime.json") },
    flow: {
      provider: GOOGLE_FLOW_BROWSER_PROVIDER,
      path: path.join(stateRoot, "providers", GOOGLE_FLOW_BROWSER_PROVIDER, "studio-runtime.json"),
      planLabel: identity.image_provider_options.google_flow.plan_label,
      modelLabel: identity.image_provider_options.google_flow.model_label,
    },
    gemini: {
      provider: GOOGLE_GEMINI_BROWSER_PROVIDER,
      path: path.join(stateRoot, "providers", GOOGLE_GEMINI_BROWSER_PROVIDER, "studio-runtime.json"),
      planLabel: identity.image_provider_options.google_gemini?.plan_label ?? "Ultra",
      modelLabel: identity.image_provider_options.google_gemini?.model_label ?? "Nano Banana 2",
    },
  };
  const checkHostRuntimes = !boolFlag(flags["skip-host-health-check"]);
  const bridges = {
    chatgpt: await new GoldflowBridge({
      repoRoot,
      dataRoot,
      stateDir: chatgptElectron ? path.join(stateRoot, "electron-chatgpt-direct") : stateRoot,
      downloadsRoot,
      browserProvider: "chatgpt",
    }).init(),
    flow: await new GoldflowBridge({ repoRoot, dataRoot, stateDir: path.join(stateRoot, "providers", GOOGLE_FLOW_BROWSER_PROVIDER), downloadsRoot, browserProvider: GOOGLE_FLOW_BROWSER_PROVIDER }).init(),
    gemini: await new GoldflowBridge({ repoRoot, dataRoot, stateDir: path.join(stateRoot, "providers", GOOGLE_GEMINI_BROWSER_PROVIDER), downloadsRoot, browserProvider: GOOGLE_GEMINI_BROWSER_PROVIDER }).init(),
  };
  const healthProof = {
    path: identity.image_provider_options.google_flow.health_proof_path,
    sha256: identity.image_provider_options.google_flow.health_proof_sha256,
  };
  const timeoutMs = Math.max(60_000, Number(flags["timeout-ms"] ?? 6 * 60 * 60_000));
  const promptsPath = path.resolve(flags.prompts ?? path.join(episodeDir, "section_image_prompts_hardened.json"));
  const referencePlanPath = path.resolve(flags["reference-plan"] ?? path.join(episodeDir, "visual_reference_plan.json"));
  const characterStateRefsPath = path.resolve(flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json"));
  const imagegenReportPath = path.resolve(flags.output ?? flags.report ?? flags["imagegen-report"] ?? path.join(
    episodeDir,
    referencesOnly ? `imagegen_report_${identity.episode}_codex_references.json` : `imagegen_report_${identity.episode}.json`,
  ));
  const cutExecutionLedgerPath = path.resolve(flags["cut-execution-ledger"] ?? path.join(episodeDir, "cut_execution_ledger.json"));
  const phases = [];
  const failedAssetIds = new Set();
  const pendingAssetIds = new Set();
  const recordPhase = (phaseName, phase) => {
    if (!phase) return;
    phases.push({ phase: phaseName, ...phase });
    for (const assetId of phase.failed_asset_ids ?? []) failedAssetIds.add(assetId);
    for (const assetId of phase.pending_asset_ids ?? []) pendingAssetIds.add(assetId);
  };
  const finalizePoolReport = async () => {
    const report = {
      schema: "goldflow_hybrid_browser_pool_report_v1",
      status: failedAssetIds.size || pendingAssetIds.size ? "blocked" : "passed",
      channel: identity.channel,
      series_slug: identity.series_slug,
      week: identity.week,
      episode: identity.episode,
      mode: referencesOnly ? "reference" : "scene",
      image_provider: identity.image_provider,
      routing_policy: identity.image_provider_options.routing_policy,
      style_reference_provider: identity.image_provider_options.style_reference_provider,
      shared_pool: {
        assignment_policy: HYBRID_WEB_FLOW_ASSIGNMENT_POLICY,
        chatgpt_concurrency: flowOnly || geminiOnly || (federated && !federatedWebImageAutomaticChatGptEnabled(identity) && !chatgptOnly)
          ? 0
          : chatgptElectron ? chatgptElectronConcurrency : HYBRID_CHATGPT_IMAGE_CONCURRENCY,
        google_flow_concurrency: chatgptOnly || geminiOnly ? 0 : flowRuntimeConcurrency,
        google_flow_profile_max_concurrency: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
        google_gemini_concurrency: federated || geminiOnly ? GOOGLE_GEMINI_IMAGE_CONCURRENCY : 0,
        total_concurrency: flowOnly
          ? flowRuntimeConcurrency
          : chatgptOnly
            ? (chatgptElectron ? chatgptElectronConcurrency : HYBRID_CHATGPT_IMAGE_CONCURRENCY)
            : geminiOnly
              ? GOOGLE_GEMINI_IMAGE_CONCURRENCY
              : federated
                ? flowRuntimeConcurrency + GOOGLE_GEMINI_IMAGE_CONCURRENCY
                  + (federatedWebImageAutomaticChatGptEnabled(identity)
                    ? (chatgptElectron ? chatgptElectronConcurrency : HYBRID_CHATGPT_IMAGE_CONCURRENCY)
                    : 0)
              : flowRuntimeConcurrency + (chatgptElectron ? chatgptElectronConcurrency : HYBRID_CHATGPT_IMAGE_CONCURRENCY),
      },
      flow_runtime_concurrency: flowRuntimeConcurrency,
      flow_only: flowOnly,
      chatgpt_only: chatgptOnly,
      gemini_only: geminiOnly,
      federated_pool: federated,
      reconcile_only: reconcileOnly,
      creative_submission_attempts: reconcileOnly ? 0 : 1,
      automatic_retry_policy: "none",
      exact_repair_reason: repairReason || null,
      repair_shared_reference_ids: repairSharedReferenceIds,
      repair_evidence: repairEvidence,
      qa_recovery: qaRecovery,
      blocked_asset_ids: [...failedAssetIds],
      unsubmitted_asset_ids: [...pendingAssetIds],
      phases,
      updated_at: new Date().toISOString(),
    };
    const reportPath = path.resolve(flags["pool-report-output"] ?? path.join(episodeDir, `hybrid_browser_pool_report_${identity.episode}_${referencesOnly ? "references" : "scenes"}.json`));
    await writeJson(reportPath, report);
    return { ...report, report_path: reportPath };
  };
  const blockSourceCompatibleDeadletters = async (mode, currentRows, assetIds, phaseName) => {
    if (repairReason || !assetIds.length) return assetIds;
    const compatible = await findSourceCompatibleHybridDeadletters({
      episodeDir,
      mode,
      currentRows,
      requestedIds: new Set(assetIds),
    });
    const blockedIds = assetIds.filter((assetId) => compatible.has(assetId));
    if (!blockedIds.length) return assetIds;
    for (const assetId of blockedIds) failedAssetIds.add(assetId);
    phases.push({
      phase: phaseName,
      status: "blocked_prior_source_compatible_deadletters",
      completed_asset_ids: [],
      failed_asset_ids: blockedIds,
      pending_asset_ids: [],
      deadletter_evidence: blockedIds.map((assetId) => {
        const evidence = compatible.get(assetId);
        return {
          asset_id: assetId,
          manifest_path: evidence.manifest_path,
          deadletter_path: evidence.deadletter_path,
        };
      }),
    });
    return assetIds.filter((assetId) => !compatible.has(assetId));
  };
  const repairPlan = repairReason
    ? await readJson(referencesOnly ? referencePlanPath : promptsPath, null)
    : null;
  const repairCurrentRows = referencesOnly
    ? repairPlan?.reference_targets ?? []
    : repairPlan?.prompts ?? [];
  const repairEvidence = repairReason
    ? await resolveRepairEvidence({
        episodeDir,
        episode: identity.episode,
        mode: referencesOnly ? "reference" : "scene",
        currentRows: repairCurrentRows,
        requestedIds,
        qaRecovery,
        providerMigration,
        manualProviderAuthEvidencePath,
        targetProvider: chatgptOnly ? "chatgpt" : null,
      })
    : null;
  const reconciledRepairAssetIds = new Set();

  if (!repairReason) {
    if (referencesOnly) {
      const currentPlan = await readJson(referencePlanPath, null);
      const currentRows = (currentPlan?.reference_targets ?? []).filter(referenceRequiresGeneration);
      const acceptedAssetIds = new Set();
      for (const target of currentRows) {
        if (await materializedReferenceAccepted(target, { episodeDir })) acceptedAssetIds.add(target.ref_id);
      }
      const reconciled = await reconcileCompatibleManifestCompletions({
        mode: "reference", episodeDir, currentRows, acceptedAssetIds,
        requestedIds: requestedIds.size ? requestedIds : null,
        identity, promptsPath, referencePlanPath, characterStateRefsPath, imagegenReportPath, cutExecutionLedgerPath, dataRoot, downloadsRoot,
        wavefrontPrefetch,
      });
      if (reconciled.length) phases.push({ phase: "reconciled_completed_reference_materialization", completed_asset_ids: reconciled });
    } else {
      const currentPlan = await readJson(promptsPath, null);
      const currentRows = (currentPlan?.prompts ?? []).filter((prompt) => prompt.image_generation_required !== false);
      const priorReport = await readJson(imagegenReportPath, null);
      const currentPromptPlanSha256 = await sha256File(promptsPath);
      const cutLedger = await readJson(cutExecutionLedgerPath, null);
      const ledgerById = new Map((cutLedger?.cuts ?? []).map((row) => [String(row?.image_id ?? ""), row]));
      const acceptedAssetIds = new Set();
      for (const row of priorReport?.results ?? []) {
        if (await materializedSceneAccepted({ row, report: priorReport, ledgerById, currentPromptPlanSha256 })) {
          acceptedAssetIds.add(row.image_id);
        }
      }
      const reconciled = await reconcileCompatibleManifestCompletions({
        mode: "scene", episodeDir, currentRows, acceptedAssetIds,
        requestedIds: requestedIds.size ? requestedIds : null,
        identity, promptsPath, referencePlanPath, characterStateRefsPath, imagegenReportPath, cutExecutionLedgerPath, dataRoot, downloadsRoot,
        wavefrontPrefetch,
      });
      if (reconciled.length) phases.push({ phase: "reconciled_completed_scene_materialization", completed_asset_ids: reconciled });
    }
  }
  if (repairReason) {
    if (referencesOnly) {
      const currentRows = (repairPlan?.reference_targets ?? []).filter(referenceRequiresGeneration);
      const currentAcceptedHashesById = new Map();
      const currentAcceptedAtById = new Map();
      for (const target of currentRows.filter((row) => requestedIds.has(String(row.ref_id)))) {
        const state = await materializedReferenceState(target, { episodeDir });
        if (!state) continue;
        currentAcceptedHashesById.set(state.assetId, state.imageSha256);
        if (state.materializedAt) currentAcceptedAtById.set(state.assetId, state.materializedAt);
      }
      const reconciled = await reconcileCompatibleManifestCompletions({
        mode: "reference",
        episodeDir,
        currentRows,
        acceptedAssetIds: new Set(),
        currentAcceptedHashesById,
        currentAcceptedAtById,
        requestedIds,
        repairReason,
        qaRecovery,
        identity,
        promptsPath,
        referencePlanPath,
        characterStateRefsPath,
        imagegenReportPath,
        cutExecutionLedgerPath,
        dataRoot,
        downloadsRoot,
        wavefrontPrefetch,
      });
      for (const assetId of reconciled) reconciledRepairAssetIds.add(assetId);
      if (reconciled.length) phases.push({ phase: "reconciled_completed_reference_repair_materialization", completed_asset_ids: reconciled });
    } else {
      const currentRows = (repairPlan?.prompts ?? []).filter((prompt) => prompt.image_generation_required !== false);
      const priorReport = await readJson(imagegenReportPath, null);
      const currentPromptPlanSha256 = await sha256File(promptsPath);
      const cutLedger = await readJson(cutExecutionLedgerPath, null);
      const ledgerById = new Map((cutLedger?.cuts ?? []).map((row) => [String(row?.image_id ?? ""), row]));
      const currentAcceptedHashesById = new Map();
      const currentAcceptedAtById = new Map();
      for (const row of (priorReport?.results ?? []).filter((candidate) => requestedIds.has(String(candidate?.image_id ?? "")))) {
        const state = await materializedSceneState({ row, report: priorReport, ledgerById, currentPromptPlanSha256 });
        if (!state) continue;
        currentAcceptedHashesById.set(state.assetId, state.imageSha256);
        if (state.materializedAt) currentAcceptedAtById.set(state.assetId, state.materializedAt);
      }
      const reconciled = await reconcileCompatibleManifestCompletions({
        mode: "scene",
        episodeDir,
        currentRows,
        acceptedAssetIds: new Set(),
        currentAcceptedHashesById,
        currentAcceptedAtById,
        requestedIds,
        repairReason,
        qaRecovery,
        identity,
        promptsPath,
        referencePlanPath,
        characterStateRefsPath,
        imagegenReportPath,
        cutExecutionLedgerPath,
        dataRoot,
        downloadsRoot,
        wavefrontPrefetch,
      });
      for (const assetId of reconciled) reconciledRepairAssetIds.add(assetId);
      if (reconciled.length) phases.push({ phase: "reconciled_completed_scene_repair_materialization", completed_asset_ids: reconciled });
    }
  }

  if (reconcileOnly) return finalizePoolReport();

  if (referencesOnly) {
    const referencePlan = await readJson(referencePlanPath, null);
    if (!referencePlan || !Array.isArray(referencePlan.reference_targets)) throw new Error(`Missing reference plan: ${referencePlanPath}`);
    const targets = referencePlan.reference_targets.filter(referenceRequiresGeneration);
    const unknownIds = [...requestedIds].filter((id) => !targets.some((target) => target.ref_id === id));
    if (unknownIds.length) throw new Error(`Unknown generated reference IDs: ${unknownIds.join(", ")}`);
    const styleTargets = targets.filter(isStyleReferenceTarget);
    let missingStyleIds = (await targetsMissingMaterializedImages(styleTargets, { episodeDir })).map((target) => target.ref_id);
    missingStyleIds = await blockSourceCompatibleDeadletters(
      "reference",
      targets,
      missingStyleIds,
      "style_references_blocked_by_prior_deadletters",
    );
    const styleRepairIds = repairReason
      ? styleTargets
          .filter((target) => requestedIds.has(target.ref_id) && !reconciledRepairAssetIds.has(target.ref_id))
          .map((target) => target.ref_id)
      : [];
    if (styleRepairIds.length) {
      if (flowOnly) throw new Error(`Flow-only mode cannot repair missing style references: ${styleRepairIds.join(", ")}.`);
      const phase = await createAndRunPhase({
        mode: "reference", episodeDir, promptsPath, referencePlanPath, characterStateRefsPath,
        assetIds: styleRepairIds, sharedReferenceIds: [], styleOnly: true,
        federated,
        repairReason, healthProof, bridges, runtimes, timeoutMs, identity, dataRoot,
        chatgptElectron,
        chatgptElectronConcurrency,
        flowRuntimeConcurrency,
        downloadsRoot,
        checkHostRuntimes,
        qaRecovery,
        repairEvidence,
        imagegenReportPath,
        cutExecutionLedgerPath,
        wavefrontPrefetch,
      });
      recordPhase(federated ? "style_repair_gemini_only" : "style_repair_chatgpt_only", phase);
    } else if (!repairReason && missingStyleIds.length) {
      if (flowOnly) throw new Error(`Flow-only mode cannot generate missing style references: ${missingStyleIds.join(", ")}.`);
      const phase = await createAndRunPhase({
        mode: "reference", episodeDir, promptsPath, referencePlanPath, characterStateRefsPath,
        assetIds: missingStyleIds, sharedReferenceIds: [], styleOnly: true,
        federated,
        repairReason: null, healthProof, bridges, runtimes, timeoutMs, identity, dataRoot,
        chatgptElectron,
        chatgptElectronConcurrency,
        flowRuntimeConcurrency,
        downloadsRoot,
        checkHostRuntimes,
        qaRecovery,
        repairEvidence,
        imagegenReportPath,
        cutExecutionLedgerPath,
        wavefrontPrefetch,
      });
      recordPhase(federated ? "style_gemini_only" : "style_chatgpt_only", phase);
    }

    if (!failedAssetIds.size && !pendingAssetIds.size) {
      const refreshedPlan = await readJson(referencePlanPath, null);
      const refreshedTargets = refreshedPlan.reference_targets.filter(referenceRequiresGeneration);
      const styleIds = [...new Set([
        ...refreshedTargets.filter(isStyleReferenceTarget).map((target) => target.ref_id),
        ...repairSharedReferenceIds,
      ])];
      const unmaterializedStyle = await targetsMissingMaterializedImages(refreshedTargets.filter(isStyleReferenceTarget), { episodeDir });
      if (unmaterializedStyle.length) throw new Error(`Style-reference barrier is incomplete: ${unmaterializedStyle.map((target) => target.ref_id).join(", ")}`);
      const eligibleRemainingTargets = refreshedTargets
        .filter((target) => !isStyleReferenceTarget(target))
        .filter((target) => !requestedIds.size || requestedIds.has(target.ref_id));
      const remainingTargets = repairReason
        ? eligibleRemainingTargets
        : await targetsMissingMaterializedImages(eligibleRemainingTargets, { episodeDir });
      let remainingIds = remainingTargets.map((target) => target.ref_id);
      if (repairReason) remainingIds = remainingIds.filter((assetId) => !reconciledRepairAssetIds.has(assetId));
      remainingIds = await blockSourceCompatibleDeadletters(
        "reference",
        refreshedTargets,
        remainingIds,
        "remaining_references_blocked_by_prior_deadletters",
      );
      if (remainingIds.length) {
        const phase = await createAndRunPhase({
          mode: "reference", episodeDir, promptsPath, referencePlanPath, characterStateRefsPath,
          assetIds: remainingIds, sharedReferenceIds: styleIds, styleOnly: false,
          flowOnly,
          chatgptOnly,
          geminiOnly,
          federated,
          chatgptElectron,
          chatgptElectronConcurrency,
          flowRuntimeConcurrency,
          repairReason, healthProof, bridges, runtimes, timeoutMs, identity, dataRoot,
          downloadsRoot,
          checkHostRuntimes,
          qaRecovery,
          repairEvidence,
          imagegenReportPath,
          cutExecutionLedgerPath,
          wavefrontPrefetch,
        });
        recordPhase("remaining_references_shared_pool", phase);
      }
    }
  } else {
    const promptPlan = await readJson(promptsPath, null);
    if (promptPlan?.status !== "passed" || !Array.isArray(promptPlan.prompts)) throw new Error(`Missing passed prompt plan: ${promptsPath}`);
    const candidates = promptPlan.prompts.filter((prompt) => prompt.image_generation_required !== false);
    const unknownIds = [...requestedIds].filter((id) => !candidates.some((prompt) => prompt.image_id === id));
    if (unknownIds.length) throw new Error(`Unknown image IDs: ${unknownIds.join(", ")}`);
    const priorReport = await readJson(imagegenReportPath, null);
    const currentPromptPlanSha256 = await sha256File(promptsPath);
    const cutLedger = await readJson(cutExecutionLedgerPath, null);
    const ledgerById = new Map((cutLedger?.cuts ?? []).map((row) => [String(row?.image_id ?? ""), row]));
    const accepted = new Set();
    for (const row of priorReport?.results ?? []) {
      if (await materializedSceneAccepted({ row, report: priorReport, ledgerById, currentPromptPlanSha256 })) {
        accepted.add(row.image_id);
      }
    }
    if (!repairReason && !wavefrontPrefetch) {
      const heroCanonicalIds = candidates
        .filter((prompt) => !requestedIds.size || requestedIds.has(prompt.image_id))
        .filter((prompt) => !accepted.has(prompt.image_id))
        .filter((prompt) => {
          const tier = String(prompt?.quality_budget?.tier ?? prompt?.beat_value?.tier ?? "").toLowerCase();
          return tier === "hero" || Number(prompt?.quality_budget?.image_candidate_count ?? 1) === 2;
        })
        .map((prompt) => prompt.image_id);
      const heroLane = await runHeroCandidateLane({
        promptPlan,
        canonicalPromptsPath: promptsPath,
        candidateCanonicalIds: heroCanonicalIds,
        episodeDir,
        referencePlanPath,
        characterStateRefsPath,
        healthProof,
        bridges,
        runtimes,
        timeoutMs,
        identity,
        dataRoot,
        downloadsRoot,
        checkHostRuntimes,
        flowOnly,
        chatgptOnly,
        geminiOnly,
        federated,
        chatgptElectron,
        chatgptElectronConcurrency,
        flowRuntimeConcurrency,
      });
      if (heroLane) {
        phases.push({ phase: "hero_image_candidate_lane", ...heroLane });
        for (const imageId of heroLane.selected_canonical_image_ids ?? []) accepted.add(imageId);
        for (const imageId of heroLane.failed_canonical_image_ids ?? []) failedAssetIds.add(imageId);
      }
    }
    let sceneIds = candidates
      .filter((prompt) => !requestedIds.size || requestedIds.has(prompt.image_id))
      .filter((prompt) => repairReason || !accepted.has(prompt.image_id))
      .filter((prompt) => !reconciledRepairAssetIds.has(prompt.image_id))
      .map((prompt) => prompt.image_id);
    sceneIds = await blockSourceCompatibleDeadletters(
      "scene",
      candidates,
      sceneIds,
      "scene_images_blocked_by_prior_deadletters",
    );
    if (sceneIds.length) {
      const phase = await createAndRunPhase({
        mode: "scene", episodeDir, promptsPath, referencePlanPath, characterStateRefsPath,
        assetIds: sceneIds, styleOnly: false, repairReason, healthProof, bridges, runtimes,
        flowOnly,
        chatgptOnly,
        geminiOnly,
        federated,
        chatgptElectron,
        chatgptElectronConcurrency,
        flowRuntimeConcurrency,
        timeoutMs, identity, dataRoot,
        downloadsRoot,
        checkHostRuntimes,
        qaRecovery,
        repairEvidence,
        imagegenReportPath,
        cutExecutionLedgerPath,
        wavefrontPrefetch,
      });
      recordPhase("scene_images_shared_pool", phase);
    }
  }

  return finalizePoolReport();
}

async function main() {
  try {
    const result = await runHybridBrowserImagePool(parseFlags(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "passed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
