import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import sharp from "sharp";

import {
  completeWorkItem,
  createCodexWorkManifest,
  deferWorkItem,
  failWorkItem,
  getCodexWorkStatus,
  heartbeatWorkItem,
  leaseNextWorkItem,
  loadWorkManifest,
  parseIdScope,
  sha256File,
} from "../../../scripts/lib/codex-image-work-contract.mjs";
import {
  compactError,
  ensureInside,
  nowIso,
  pathExists,
  readJson,
  safeSegment,
  writeJsonAtomic,
} from "./util.mjs";
import { findReferenceEcho } from "./image-pixel-contract.mjs";

function runProcess(command, args, { cwd, env = {}, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(stderr || stdout || `${command} exited ${code}.`));
    });
  });
}

const GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA = "goldflow_google_flow_reference_binding_v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PERSISTENT_BROWSER_WORKER_SESSION_POLICIES = new Set([
  "persistent_project_per_worker_slot_v1",
  "persistent_tab_per_worker_slot_v1",
]);
const GENERATED_RESULT_SCHEMA = "goldflow_browser_generated_result_v1";
const GOOGLE_BROWSER_PROVIDERS = new Set(["google-flow", "google-gemini"]);

export function manifestHasRunnableWork(status = {}) {
  return status?.streaming_queue?.sealed === false
    || Number(status?.counts?.pending ?? 0) + Number(status?.counts?.leased ?? 0) > 0;
}

export function googleManifestActivationConflict({ incomingManifestPath, activeManifestEntries = [] } = {}) {
  const incoming = path.resolve(String(incomingManifestPath ?? ""));
  const conflicts = activeManifestEntries.filter((entry) => (
    entry?.runnable !== false
    && path.resolve(String(entry?.manifest_path ?? "")) !== incoming
  ));
  if (!conflicts.length) return null;
  const details = conflicts.map((entry) => (
    `${entry.browser_provider ?? "google"}:${entry.manifest_path}`
  )).join(", ");
  return `Google image providers already have a different runnable manifest active (${details}). `
    + "Flow-only and Gemini-only queues cannot run from separate manifests. Drain or deactivate the existing queue, "
    + "or activate both providers on one federated manifest.";
}

function hasVerifiedGeneratedResult(uiContract, browserProvider, sourceUrl) {
  const result = uiContract?.generated_result;
  return result?.schema === GENERATED_RESULT_SCHEMA
    && result.status === "verified"
    && result.browser_provider === browserProvider
    && typeof result.source_url === "string"
    && result.source_url === sourceUrl;
}

function assertPersistentWorkerSessionReceipt(assignment, uiContract) {
  const expectedPolicy = String(assignment?.worker_session_policy ?? "");
  if (!PERSISTENT_BROWSER_WORKER_SESSION_POLICIES.has(expectedPolicy)) return;
  if (uiContract?.worker_session_policy !== expectedPolicy) {
    const error = new Error(`Persistent browser completion requires worker_session_policy ${expectedPolicy}.`);
    error.code = "ui_contract_mismatch";
    error.statusCode = 422;
    throw error;
  }
  if (!Number.isInteger(uiContract?.worker_slot) || uiContract.worker_slot < 0) {
    const error = new Error("Persistent browser completion requires its non-negative integer worker_slot receipt.");
    error.code = "ui_contract_mismatch";
    error.statusCode = 422;
    throw error;
  }
}

function googleFlowReferenceBindingError(message) {
  return Object.assign(new Error(`Google Flow reference-binding receipt is invalid: ${message}`), {
    code: "ui_contract_mismatch",
    statusCode: 422,
  });
}

function requireExactSha256(value, label) {
  const sha256 = String(value ?? "");
  if (!SHA256_PATTERN.test(sha256)) throw googleFlowReferenceBindingError(`${label} must be a lowercase SHA-256.`);
  return sha256;
}

async function validateGoogleFlowEvidenceFile({ filePath, reportedSha256, downloadsRoot, label, kind }) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw googleFlowReferenceBindingError(`${label} must be an absolute path under the worker downloads root.`);
  }
  let resolved;
  try {
    resolved = ensureInside(filePath, downloadsRoot, label);
  } catch (error) {
    throw googleFlowReferenceBindingError(error.message);
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw googleFlowReferenceBindingError(`${label} does not identify an existing file.`);
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(downloadsRoot), fs.realpath(resolved)]);
    ensureInside(realFile, realRoot, label);
  } catch (error) {
    throw googleFlowReferenceBindingError(`${label} does not resolve to a file under the worker downloads root: ${error.message}`);
  }
  const expectedSha256 = requireExactSha256(reportedSha256, `${label} SHA-256`);
  const currentSha256 = await sha256File(resolved);
  if (currentSha256 !== expectedSha256) {
    throw googleFlowReferenceBindingError(`${label} SHA-256 does not match the evidence file.`);
  }
  if (kind === "json") {
    try {
      JSON.parse(await fs.readFile(resolved, "utf8"));
    } catch {
      throw googleFlowReferenceBindingError(`${label} must contain valid JSON.`);
    }
  } else if (kind === "image") {
    try {
      const metadata = await sharp(resolved, { failOn: "error" }).metadata();
      if (!metadata.width || !metadata.height) throw new Error("missing dimensions");
    } catch {
      throw googleFlowReferenceBindingError(`${label} must contain a readable screenshot image.`);
    }
  }
  return { path: resolved, sha256: currentSha256 };
}

export async function validateGoogleFlowReferenceBinding({ uiContract, orderedReferences = [], downloadsRoot }) {
  const binding = uiContract?.reference_binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw googleFlowReferenceBindingError("uiContract.reference_binding is required.");
  }
  if (binding.schema !== GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA) {
    throw googleFlowReferenceBindingError(`schema must be ${GOOGLE_FLOW_REFERENCE_BINDING_SCHEMA}.`);
  }
  if (binding.status !== "verified") throw googleFlowReferenceBindingError('status must be "verified".');
  if (binding.add_to_prompt_clicked !== true) throw googleFlowReferenceBindingError("add_to_prompt_clicked must be true.");
  if (binding.no_pending_uploads !== true) throw googleFlowReferenceBindingError("no_pending_uploads must be true.");
  if (binding.prompt_text_verified !== true) throw googleFlowReferenceBindingError("prompt_text_verified must be true.");
  if (typeof binding.verified_at !== "string" || !Number.isFinite(Date.parse(binding.verified_at))) {
    throw googleFlowReferenceBindingError("verified_at must be an ISO-compatible timestamp.");
  }

  const expected = Array.isArray(orderedReferences) ? orderedReferences : [];
  if (!Number.isInteger(binding.expected_count) || binding.expected_count !== expected.length) {
    throw googleFlowReferenceBindingError(`expected_count must equal assignment count ${expected.length}.`);
  }
  if (!Number.isInteger(binding.observed_count) || binding.observed_count !== expected.length) {
    throw googleFlowReferenceBindingError(`observed_count must equal assignment count ${expected.length}.`);
  }
  if (!Array.isArray(binding.ordered_references) || binding.ordered_references.length !== expected.length) {
    throw googleFlowReferenceBindingError(`ordered_references must contain exactly ${expected.length} row(s).`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const assigned = expected[index];
    const observed = binding.ordered_references[index];
    if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
      throw googleFlowReferenceBindingError(`ordered_references[${index}] must be an object.`);
    }
    const expectedSlot = Number(assigned.slot ?? index + 1);
    if (observed.slot !== expectedSlot) {
      throw googleFlowReferenceBindingError(`ordered_references[${index}].slot must equal assignment slot ${expectedSlot}.`);
    }
    if (observed.ref_id !== assigned.ref_id) {
      throw googleFlowReferenceBindingError(`ordered_references[${index}].ref_id does not match assignment order.`);
    }
    const sourceSha256 = requireExactSha256(observed.source_sha256, `ordered_references[${index}].source_sha256`);
    if (sourceSha256 !== assigned.sha256) {
      throw googleFlowReferenceBindingError(`ordered_references[${index}].source_sha256 does not match the assigned reference.`);
    }
    if (typeof observed.upload_filename !== "string" || !observed.upload_filename.trim()) {
      throw googleFlowReferenceBindingError(`ordered_references[${index}].upload_filename is required.`);
    }
    if (typeof observed.media_id !== "string" || !observed.media_id.trim()) {
      throw googleFlowReferenceBindingError(`ordered_references[${index}].media_id is required.`);
    }
    if (typeof observed.media_url !== "string" || !observed.media_url.trim()) {
      throw googleFlowReferenceBindingError(`ordered_references[${index}].media_url is required.`);
    }
  }

  const evidence = binding.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw googleFlowReferenceBindingError("evidence is required.");
  }
  const files = await Promise.all([
    validateGoogleFlowEvidenceFile({
      filePath: evidence.receipt_path,
      reportedSha256: evidence.receipt_sha256,
      downloadsRoot,
      label: "evidence.receipt_path",
      kind: "json",
    }),
    validateGoogleFlowEvidenceFile({
      filePath: evidence.full_screenshot_path,
      reportedSha256: evidence.full_screenshot_sha256,
      downloadsRoot,
      label: "evidence.full_screenshot_path",
      kind: "image",
    }),
    validateGoogleFlowEvidenceFile({
      filePath: evidence.composer_screenshot_path,
      reportedSha256: evidence.composer_screenshot_sha256,
      downloadsRoot,
      label: "evidence.composer_screenshot_path",
      kind: "image",
    }),
  ]);
  if (new Set(files.map((row) => row.path)).size !== files.length) {
    throw googleFlowReferenceBindingError("receipt, full screenshot, and composer screenshot evidence must be distinct files.");
  }
  return binding;
}

export class GoldflowBridge {
  constructor({ repoRoot, dataRoot, stateDir, downloadsRoot, browserProvider = "chatgpt" } = {}) {
    this.repoRoot = path.resolve(repoRoot);
    this.dataRoot = path.resolve(dataRoot);
    this.stateDir = path.resolve(stateDir);
    this.downloadsRoot = path.resolve(downloadsRoot);
    this.browserProvider = String(browserProvider);
    this.manifestsPath = path.join(this.stateDir, "active-image-manifests.json");
    this.queueLock = Promise.resolve();
  }

  async init() {
    await Promise.all([
      fs.mkdir(this.stateDir, { recursive: true }),
      fs.mkdir(this.downloadsRoot, { recursive: true }),
    ]);
    if (!(await pathExists(this.manifestsPath))) {
      await writeJsonAtomic(this.manifestsPath, { schema: "goldflow_studio_active_manifests_v2", manifests: [] });
    }
    return this;
  }

  async withQueueLock(callback) {
    const previous = this.queueLock;
    let release;
    this.queueLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async withActiveManifestLock(callback) {
    const lockPath = `${this.manifestsPath}.lock`;
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await fs.mkdir(lockPath);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const stat = await fs.stat(lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 30_000) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the active-manifest registry lock.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await callback();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  async withGoogleManifestActivationLock(callback) {
    if (!GOOGLE_BROWSER_PROVIDERS.has(this.browserProvider)) return callback();
    const stateRoot = path.dirname(path.dirname(this.stateDir));
    const lockPath = path.join(stateRoot, "google-account-submit-gate", ".manifest-activation.lock");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await fs.mkdir(lockPath);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const stat = await fs.stat(lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 30_000) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the Google image-manifest activation lock.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await callback();
    } finally {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  async activeGoogleManifestEntries() {
    if (!GOOGLE_BROWSER_PROVIDERS.has(this.browserProvider)) return [];
    const stateRoot = path.dirname(path.dirname(this.stateDir));
    const entries = [];
    for (const browserProvider of GOOGLE_BROWSER_PROVIDERS) {
      const manifestsPath = path.join(stateRoot, "providers", browserProvider, "active-image-manifests.json");
      const state = await readJson(manifestsPath, { manifests: [] });
      for (const value of state?.manifests ?? []) {
        const entry = typeof value === "string"
          ? { manifest_path: value, browser_provider: browserProvider }
          : value;
        if (!entry?.manifest_path || String(entry.browser_provider ?? browserProvider) !== browserProvider) continue;
        const manifestPath = this.manifestPath(entry.manifest_path);
        if (!(await pathExists(manifestPath))) continue;
        try {
          const status = await getCodexWorkStatus({ manifestPath, reconcile: false });
          if (!manifestHasRunnableWork(status)) continue;
          entries.push({ browser_provider: browserProvider, manifest_path: manifestPath, runnable: true });
        } catch (error) {
          entries.push({
            browser_provider: browserProvider,
            manifest_path: manifestPath,
            runnable: true,
            unreadable: true,
            error: error?.message ?? String(error),
          });
        }
      }
    }
    return entries;
  }

  episodePath(value) {
    if (!value) throw new Error("episodeDir is required.");
    return ensureInside(value, this.dataRoot, "episodeDir");
  }

  manifestPath(value) {
    if (!value) throw new Error("manifestPath is required.");
    return ensureInside(value, this.dataRoot, "manifestPath");
  }

  async allActiveManifestEntries() {
    const state = await readJson(this.manifestsPath, { manifests: [] });
    const entries = (state?.manifests ?? []).map((value) => typeof value === "string"
      ? { manifest_path: value, browser_provider: "chatgpt" }
      : value);
    const unique = new Map();
    for (const entry of entries) {
      if (!entry?.manifest_path) continue;
      const browserProvider = String(entry.browser_provider ?? "chatgpt");
      const resolved = this.manifestPath(entry.manifest_path);
      unique.set(`${browserProvider}:${resolved}`, { manifest_path: resolved, browser_provider: browserProvider });
    }
    return [...unique.values()];
  }

  async activeManifestEntries() {
    const active = [];
    for (const entry of (await this.allActiveManifestEntries())
      .filter((candidate) => candidate.browser_provider === this.browserProvider)) {
      try {
        const status = await getCodexWorkStatus({ manifestPath: entry.manifest_path, reconcile: false });
        if (!manifestHasRunnableWork(status)) continue;
      } catch {
        // Preserve unreadable registrations so their normal error path remains
        // visible instead of silently hiding a potentially recoverable queue.
      }
      active.push(entry);
    }
    return active;
  }

  async activeManifestPaths() {
    return (await this.activeManifestEntries()).map((entry) => entry.manifest_path);
  }

  async activeWorkerSessionPolicies() {
    const policies = new Set();
    for (const manifestPath of await this.activeManifestPaths()) {
      try {
        const summary = await getCodexWorkStatus({ manifestPath, reconcile: false });
        if (!manifestHasRunnableWork(summary)) continue;
        const loaded = await loadWorkManifest(manifestPath);
        const policy = String(
          loaded.manifest.policy?.browser_provider_worker_session_policy?.[this.browserProvider]
            ?? "",
        ).trim();
        if (policy) policies.add(policy);
      } catch {
        // Invalid manifests are reported through the normal dashboard/status
        // path and must not cause an unrelated desktop host to prewarm pages.
      }
    }
    return [...policies].sort();
  }

  async activateManifest(manifestPath) {
    const resolved = this.manifestPath(manifestPath);
    await loadWorkManifest(resolved);
    await this.withGoogleManifestActivationLock(async () => {
      const conflict = googleManifestActivationConflict({
        incomingManifestPath: resolved,
        activeManifestEntries: await this.activeGoogleManifestEntries(),
      });
      if (conflict) throw new Error(conflict);
      await this.withActiveManifestLock(async () => {
        const manifests = await this.allActiveManifestEntries();
        if (!manifests.some((entry) => entry.manifest_path === resolved && entry.browser_provider === this.browserProvider)) {
          manifests.push({ manifest_path: resolved, browser_provider: this.browserProvider });
        }
        await writeJsonAtomic(this.manifestsPath, {
          schema: "goldflow_studio_active_manifests_v2",
          manifests,
          updated_at: nowIso(),
        });
      });
    });
    return this.imageManifestSummary(resolved);
  }

  async deactivateManifest(manifestPath) {
    const resolved = this.manifestPath(manifestPath);
    await this.withActiveManifestLock(async () => {
      const manifests = (await this.allActiveManifestEntries()).filter((entry) => !(
        entry.manifest_path === resolved && entry.browser_provider === this.browserProvider
      ));
      await writeJsonAtomic(this.manifestsPath, {
        schema: "goldflow_studio_active_manifests_v2",
        manifests,
        updated_at: nowIso(),
      });
    });
    return { status: "deactivated", manifest_path: resolved };
  }

  async createManifest(input) {
    const episodeDir = this.episodePath(input.episodeDir);
    const mode = String(input.mode ?? "scene") === "reference" ? "reference" : "scene";
    const promptsPath = ensureInside(input.promptsPath ?? path.join(episodeDir, "section_image_prompts_hardened.json"), episodeDir, "promptsPath");
    const referencePlanPath = ensureInside(input.referencePlanPath ?? path.join(episodeDir, "visual_reference_plan.json"), episodeDir, "referencePlanPath");
    const characterStateRefsPath = ensureInside(input.characterStateRefsPath ?? path.join(episodeDir, "character_state_refs.json"), episodeDir, "characterStateRefsPath");
    const concurrencyCeiling = this.browserProvider === "google-flow" ? 20 : 5;
    const maxConcurrency = Math.min(concurrencyCeiling, Math.max(1, Number(input.maxConcurrency ?? input.concurrency ?? 5)));
    if (input.concurrencyProof === true && this.browserProvider !== "google-flow") {
      throw new Error("The verification-wave bypass is restricted to explicit Google Flow concurrency proofs.");
    }
    const verificationGateBypass = input.concurrencyProof === true
      ? {
          kind: "prior_health_proof",
          evidencePath: ensureInside(input.priorHealthProofPath, this.dataRoot, "priorHealthProofPath"),
          evidenceSha256: String(input.priorHealthProofSha256 ?? ""),
        }
      : null;
    const result = await createCodexWorkManifest({
      mode,
      episodeDir,
      promptsPath,
      referencePlanPath,
      characterStateRefsPath,
      imageIds: parseIdScope(input.imageIds),
      referenceIds: parseIdScope(input.referenceIds),
      maxAttempts: 1,
      leaseSeconds: Number(input.leaseSeconds ?? 1800),
      recommendedConcurrency: Math.min(maxConcurrency, Math.max(1, Number(input.concurrency ?? 3))),
      maxConcurrency,
      verificationGateBypass,
    });
    await this.activateManifest(result.manifest.manifest_path);
    return {
      status: "ready",
      created: result.created,
      manifest_id: result.manifest.manifest_id,
      manifest_path: result.manifest.manifest_path,
      mode: result.manifest.mode,
      item_count: result.manifest.item_count,
      asset_ids: result.manifest.items.map((item) => item.asset_id),
    };
  }

  async imageManifestSummary(manifestPath) {
    return getCodexWorkStatus({ manifestPath: this.manifestPath(manifestPath), reconcile: false });
  }

  async allImageManifestSummaries() {
    const summaries = [];
    for (const manifestPath of await this.activeManifestPaths()) {
      try {
        summaries.push(await this.imageManifestSummary(manifestPath));
      } catch (error) {
        summaries.push({ status: "invalid", manifest_path: manifestPath, error: compactError(error) });
      }
    }
    return summaries;
  }

  async manifestById(manifestId) {
    const safeId = safeSegment(manifestId, "manifest id");
    for (const manifestPath of await this.activeManifestPaths()) {
      const loaded = await loadWorkManifest(manifestPath);
      if (loaded.manifest.manifest_id === safeId) return loaded;
    }
    throw new Error(`Manifest ${safeId} is not active in Goldflow Studio.`);
  }

  async leaseImage(workerId) {
    return this.withQueueLock(async () => {
      for (const manifestPath of await this.activeManifestPaths()) {
        const result = await leaseNextWorkItem({
          manifestPath,
          workerId,
          leaseSeconds: 1800,
          browserProvider: this.browserProvider,
        });
        if (result.status !== "leased") continue;
        const assignment = result.assignment;
        return {
          status: "leased",
          job: {
            type: "image",
            job_id: `image:${assignment.manifest_id}:${assignment.asset_id}`,
            manifest_id: assignment.manifest_id,
            manifest_path: manifestPath,
            asset_id: assignment.asset_id,
            asset_kind: assignment.asset_kind,
            lease_token: assignment.lease_token,
            expires_at: assignment.expires_at,
            worker_session_policy: assignment.worker_session_policy ?? null,
            prompt: assignment.item.prompt,
            prompt_sha256: assignment.item.prompt_sha256,
            expected_output: assignment.item.expected_output,
            references: (assignment.item.ordered_references ?? []).map((reference, index) => ({
              slot: index + 1,
              ref_id: reference.ref_id,
              sha256: reference.sha256,
              url: `/v1/worker/image-reference/${encodeURIComponent(assignment.manifest_id)}/${encodeURIComponent(assignment.asset_id)}/${index + 1}?lease_token=${encodeURIComponent(assignment.lease_token)}`,
            })),
          },
          reused_existing_lease: result.reused_existing_lease === true,
        };
      }
      return { status: "no_work" };
    });
  }

  async assignmentFor({ manifestId, assetId, leaseToken, workerId = null }) {
    const { manifestDir } = await this.manifestById(manifestId);
    const safeAssetId = safeSegment(assetId, "asset id");
    const lease = await readJson(path.join(manifestDir, "leases", `${safeAssetId}.lock`, "lease.json"));
    if (!lease || lease.lease_token !== leaseToken) throw new Error("Image lease token does not own this asset.");
    if (workerId && lease.worker_id !== workerId) throw new Error("Worker does not own this image asset.");
    if (Date.parse(lease.expires_at) <= Date.now()) throw new Error("Image lease has expired.");
    const assignment = await readJson(path.join(lease.attempt_dir, "assignment.json"));
    if (!assignment) throw new Error("Image assignment is missing.");
    return { assignment, lease };
  }

  async imageReference({ manifestId, assetId, slot, leaseToken, workerId }) {
    const { assignment } = await this.assignmentFor({ manifestId, assetId, leaseToken, workerId });
    const reference = assignment.item.ordered_references?.[Number(slot) - 1];
    if (!reference) throw new Error(`Reference slot ${slot} does not exist.`);
    const currentSha = await sha256File(reference.path);
    if (currentSha !== reference.sha256) throw new Error(`Reference ${reference.ref_id} changed after assignment.`);
    const extension = path.extname(reference.path).toLowerCase();
    const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
    return { bytes: await fs.readFile(reference.path), mimeType, filename: path.basename(reference.path) };
  }

  async heartbeatImage({ manifestId, assetId, leaseToken, workerId }) {
    const { manifestPath } = await this.manifestById(manifestId);
    return heartbeatWorkItem({ manifestPath, assetId, leaseToken, workerId, leaseSeconds: 1800 });
  }

  async completeImage({ manifestId, assetId, leaseToken, workerId, downloadPath, sourceUrl = null, conversationUrl = null, uiContract = null, browserProvider = null }) {
    if (browserProvider && browserProvider !== this.browserProvider) {
      throw new Error(`Worker reported ${browserProvider}, but this manifest queue is bound to ${this.browserProvider}.`);
    }
    const receiptProvider = this.browserProvider;
    const { manifestPath } = await this.manifestById(manifestId);
    const { assignment } = await this.assignmentFor({ manifestId, assetId, leaseToken, workerId });
    assertPersistentWorkerSessionReceipt(assignment, uiContract);
    if (receiptProvider === "google-flow") {
      await validateGoogleFlowReferenceBinding({
        uiContract,
        orderedReferences: assignment.item.ordered_references ?? [],
        downloadsRoot: this.downloadsRoot,
      });
    }
    const sourcePath = ensureInside(downloadPath, this.downloadsRoot, "downloadPath");
    if (!(await pathExists(sourcePath))) throw new Error(`Downloaded image does not exist: ${sourcePath}.`);
    const referenceEcho = await findReferenceEcho(sourcePath, (assignment.item.ordered_references ?? []).map((reference) => ({
      slot: reference.slot,
      ref_id: reference.ref_id,
      path: reference.path,
    })));
    const generatedResultVerified = hasVerifiedGeneratedResult(uiContract, receiptProvider, sourceUrl);
    if (referenceEcho && !generatedResultVerified) {
      const rejection = {
        schema: "goldflow_provider_reference_echo_rejection_v1",
        status: "rejected",
        code: "provider_reference_echo",
        browser_provider: receiptProvider,
        manifest_id: manifestId,
        asset_id: assetId,
        prompt_sha256: assignment.item.prompt_sha256,
        downloaded_source_path: sourcePath,
        downloaded_source_sha256: await sha256File(sourcePath),
        matched_reference: referenceEcho,
        rejected_at: nowIso(),
      };
      await writeJsonAtomic(path.join(assignment.attempt_dir, "provider_reference_echo_rejection.json"), rejection);
      const error = new Error(`Provider output for ${assetId} matches ordered reference ${referenceEcho.ref_id ?? referenceEcho.slot} (pixel MAE ${referenceEcho.mean_absolute_difference.toFixed(4)}).`);
      error.code = "provider_reference_echo";
      error.statusCode = 422;
      throw error;
    }
    if (referenceEcho) {
      await writeJsonAtomic(path.join(assignment.attempt_dir, "provider_reference_similarity_acceptance.json"), {
        schema: "goldflow_provider_reference_similarity_acceptance_v1",
        status: "accepted_generated_result",
        browser_provider: receiptProvider,
        manifest_id: manifestId,
        asset_id: assetId,
        prompt_sha256: assignment.item.prompt_sha256,
        matched_reference: referenceEcho,
        generated_result: uiContract.generated_result,
        accepted_at: nowIso(),
      });
    }
    await sharp(sourcePath, { failOn: "error" }).png().toFile(assignment.expected_output_path);
    const outputSha = await sha256File(assignment.expected_output_path);
    const receiptSlug = receiptProvider === "google-flow"
      ? "google_flow"
      : receiptProvider === "google-gemini" ? "google_gemini" : "chatgpt_web";
    const receiptSchema = receiptProvider === "google-flow"
      ? "goldflow_google_flow_image_receipt_v1"
      : receiptProvider === "google-gemini" ? "goldflow_google_gemini_image_receipt_v1" : "goldflow_chatgpt_web_image_receipt_v1";
    await writeJsonAtomic(path.join(assignment.attempt_dir, `${receiptSlug}_receipt.json`), {
      schema: receiptSchema,
      browser_provider: receiptProvider,
      status: "downloaded",
      manifest_id: manifestId,
      asset_id: assetId,
      prompt_sha256: assignment.item.prompt_sha256,
      ordered_reference_hashes: assignment.item.ordered_references.map((reference) => ({ ref_id: reference.ref_id, sha256: reference.sha256 })),
      source_url: sourceUrl,
      conversation_url: conversationUrl,
      ui_contract: uiContract,
      downloaded_source_path: sourcePath,
      accepted_png_path: assignment.expected_output_path,
      accepted_png_sha256: outputSha,
      completed_at: nowIso(),
    });
    return completeWorkItem({
      manifestPath,
      assetId,
      leaseToken,
      workerId,
      browserProvider: receiptProvider,
      sourcePath: assignment.expected_output_path,
      reportedSha256: outputSha,
    });
  }

  async failImage({ manifestId, assetId, leaseToken, workerId, error }) {
    const { manifestPath } = await this.manifestById(manifestId);
    return failWorkItem({ manifestPath, assetId, leaseToken, workerId, browserProvider: this.browserProvider, error });
  }

  async deferImage({ manifestId, assetId, leaseToken, workerId, reason }) {
    const { manifestPath } = await this.manifestById(manifestId);
    return deferWorkItem({
      manifestPath,
      assetId,
      leaseToken,
      workerId,
      browserProvider: this.browserProvider,
      reason,
    });
  }

  async runStatus(episodeDir) {
    const resolvedEpisodeDir = this.episodePath(episodeDir);
    const result = await runProcess(process.execPath, [
      path.join(this.repoRoot, "bin", "goldflow.mjs"),
      "run",
      "status",
      "--episode-dir",
      resolvedEpisodeDir,
      "--format",
      "json",
    ], { cwd: this.repoRoot, timeoutMs: 60_000 });
    return JSON.parse(result.stdout);
  }

  async runAdvance({ episodeDir, dryRun = true, maxSteps = 1, routeEnvironment = {} }) {
    const resolvedEpisodeDir = this.episodePath(episodeDir);
    const args = [
      path.join(this.repoRoot, "bin", "goldflow.mjs"),
      "run",
      "advance",
      "--episode-dir",
      resolvedEpisodeDir,
      "--max-steps",
      String(Math.min(50, Math.max(1, Number(maxSteps) || 1))),
    ];
    if (dryRun) args.push("--dry-run", "true");
    const result = await runProcess(process.execPath, args, {
      cwd: this.repoRoot,
      env: routeEnvironment,
      timeoutMs: dryRun ? 60_000 : 3_600_000,
    });
    return JSON.parse(result.stdout);
  }
}
