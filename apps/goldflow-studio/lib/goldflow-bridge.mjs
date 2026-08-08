import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import sharp from "sharp";

import {
  completeWorkItem,
  createCodexWorkManifest,
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

export class GoldflowBridge {
  constructor({ repoRoot, dataRoot, stateDir, downloadsRoot } = {}) {
    this.repoRoot = path.resolve(repoRoot);
    this.dataRoot = path.resolve(dataRoot);
    this.stateDir = path.resolve(stateDir);
    this.downloadsRoot = path.resolve(downloadsRoot);
    this.manifestsPath = path.join(this.stateDir, "active-image-manifests.json");
    this.queueLock = Promise.resolve();
  }

  async init() {
    await Promise.all([
      fs.mkdir(this.stateDir, { recursive: true }),
      fs.mkdir(this.downloadsRoot, { recursive: true }),
    ]);
    if (!(await pathExists(this.manifestsPath))) {
      await writeJsonAtomic(this.manifestsPath, { schema: "goldflow_studio_active_manifests_v1", manifests: [] });
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

  episodePath(value) {
    if (!value) throw new Error("episodeDir is required.");
    return ensureInside(value, this.dataRoot, "episodeDir");
  }

  manifestPath(value) {
    if (!value) throw new Error("manifestPath is required.");
    return ensureInside(value, this.dataRoot, "manifestPath");
  }

  async activeManifestPaths() {
    const state = await readJson(this.manifestsPath, { manifests: [] });
    return [...new Set((state?.manifests ?? []).map((value) => this.manifestPath(value)))];
  }

  async activateManifest(manifestPath) {
    const resolved = this.manifestPath(manifestPath);
    await loadWorkManifest(resolved);
    const manifests = await this.activeManifestPaths();
    if (!manifests.includes(resolved)) manifests.push(resolved);
    await writeJsonAtomic(this.manifestsPath, {
      schema: "goldflow_studio_active_manifests_v1",
      manifests,
      updated_at: nowIso(),
    });
    return this.imageManifestSummary(resolved);
  }

  async deactivateManifest(manifestPath) {
    const resolved = this.manifestPath(manifestPath);
    const manifests = (await this.activeManifestPaths()).filter((value) => value !== resolved);
    await writeJsonAtomic(this.manifestsPath, {
      schema: "goldflow_studio_active_manifests_v1",
      manifests,
      updated_at: nowIso(),
    });
    return { status: "deactivated", manifest_path: resolved };
  }

  async createManifest(input) {
    const episodeDir = this.episodePath(input.episodeDir);
    const mode = String(input.mode ?? "scene") === "reference" ? "reference" : "scene";
    const promptsPath = ensureInside(input.promptsPath ?? path.join(episodeDir, "section_image_prompts_hardened.json"), episodeDir, "promptsPath");
    const referencePlanPath = ensureInside(input.referencePlanPath ?? path.join(episodeDir, "visual_reference_plan.json"), episodeDir, "referencePlanPath");
    const characterStateRefsPath = ensureInside(input.characterStateRefsPath ?? path.join(episodeDir, "character_state_refs.json"), episodeDir, "characterStateRefsPath");
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
      recommendedConcurrency: Math.min(5, Math.max(1, Number(input.concurrency ?? 3))),
      maxConcurrency: 5,
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
        const result = await leaseNextWorkItem({ manifestPath, workerId, leaseSeconds: 1800 });
        if (result.status !== "leased") continue;
        const assignment = result.assignment;
        return {
          status: "leased",
          job: {
            type: "image",
            job_id: `image:${assignment.manifest_id}:${assignment.asset_id}`,
            manifest_id: assignment.manifest_id,
            asset_id: assignment.asset_id,
            asset_kind: assignment.asset_kind,
            lease_token: assignment.lease_token,
            expires_at: assignment.expires_at,
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

  async completeImage({ manifestId, assetId, leaseToken, workerId, downloadPath, sourceUrl = null, conversationUrl = null, uiContract = null }) {
    const { manifestPath } = await this.manifestById(manifestId);
    const { assignment } = await this.assignmentFor({ manifestId, assetId, leaseToken, workerId });
    const sourcePath = ensureInside(downloadPath, this.downloadsRoot, "downloadPath");
    if (!(await pathExists(sourcePath))) throw new Error(`Downloaded image does not exist: ${sourcePath}.`);
    await sharp(sourcePath, { failOn: "error" }).png().toFile(assignment.expected_output_path);
    const outputSha = await sha256File(assignment.expected_output_path);
    await writeJsonAtomic(path.join(assignment.attempt_dir, "chatgpt_web_receipt.json"), {
      schema: "goldflow_chatgpt_web_image_receipt_v1",
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
      sourcePath: assignment.expected_output_path,
      reportedSha256: outputSha,
    });
  }

  async failImage({ manifestId, assetId, leaseToken, workerId, error }) {
    const { manifestPath } = await this.manifestById(manifestId);
    return failWorkItem({ manifestPath, assetId, leaseToken, workerId, error });
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
