#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStageCommand } from "./lib/pipeline-stage-registry.mjs";
import { generatedMotionEnabled } from "./lib/generated-motion-contract.mjs";
import { motionIntentForPrompt, rebalanceEditorialMotionStreaks } from "./lib/motion-plan-utils.mjs";
import { productionProfileForIdentity } from "./lib/production-profiles.mjs";
import { normalizeImageProvider } from "./lib/image-provider-routing.mjs";
import {
  federatedWebImageConcurrencyForIdentity,
  HYBRID_TOTAL_IMAGE_CONCURRENCY,
  HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
  isBrowserPoolImageProvider,
  isFederatedWebImageProvider,
  isGoogleFlowPrimaryProvider,
} from "./lib/image-provider-policy.mjs";
import { effectiveImageIdentityForEpisode } from "./lib/operator-image-route-override.mjs";
import { openWavefrontBrowserImageStream } from "./hybrid-browser-image-pool.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = parseFlags(process.argv.slice(2));

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function isTrue(value) {
  return /^(?:true|1|yes)$/i.test(String(value ?? ""));
}

function safeTimestamp(value = new Date()) {
  return value.toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteAwareTokens(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const character of String(command ?? "")) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function removeTokenFlag(tokens, flagName) {
  const index = tokens.indexOf(`--${flagName}`);
  if (index >= 0) tokens.splice(index, 2);
}

function plannerTokensWithWavefrontOverrides(tokens, inputFlags = {}) {
  const output = [...tokens];
  if (inputFlags["beat-ids"] !== undefined) removeTokenFlag(output, "cut-ids");
  if (inputFlags["cut-ids"] !== undefined) removeTokenFlag(output, "beat-ids");
  const forwarded = [
    "beat-ids",
    "cut-ids",
    "planning-provider",
    "reasoning-effort",
    "visual-chunk-concurrency",
    "visual-high-risk-chunk-size",
    "visual-medium-risk-chunk-size",
    "visual-simple-chunk-size",
    "visual-json-attempts",
    "codex-call-attempts",
    "visual-chunk-validation-attempts",
    "workflow-bypass",
  ];
  for (const name of forwarded) {
    if (inputFlags[name] === undefined) continue;
    removeTokenFlag(output, name);
    output.push(`--${name}`, String(inputFlags[name]));
  }
  return output;
}

export function plannerTokensWithWavefrontOverridesForTests(tokens, inputFlags = {}) {
  return plannerTokensWithWavefrontOverrides(tokens, inputFlags);
}

function exactPromptRecoveryAllowed(initial = {}, inputFlags = {}) {
  return initial.current_stage === "visual_prompt_plan"
    && initial.current_stage_state === "blocked"
    && isTrue(inputFlags["workflow-bypass"])
    && Boolean(String(inputFlags["beat-ids"] ?? inputFlags["cut-ids"] ?? "").trim());
}

export function exactPromptRecoveryAllowedForTests(initial = {}, inputFlags = {}) {
  return exactPromptRecoveryAllowed(initial, inputFlags);
}

function runNode(args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    }
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

function statusArgs() {
  if (flags["episode-dir"]) return ["--episode-dir", path.resolve(flags["episode-dir"])];
  const required = ["channel", "week", "episode"];
  if (required.some((key) => !flags[key])) {
    throw new Error("run visual-wavefront requires --episode-dir or --channel/--week/--episode.");
  }
  const args = ["--channel", flags.channel, "--week", flags.week, "--episode", flags.episode];
  if (flags.series) args.push("--series", flags.series);
  return args;
}

async function readStatus() {
  const result = await runNode([path.join(repoRoot, "scripts", "run-status.mjs"), ...statusArgs()], { capture: true });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "run status failed");
  return JSON.parse(result.stdout);
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
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function identityFlags(identity) {
  return [
    "--channel", identity.channel,
    "--series", identity.series_slug,
    "--week", identity.week,
    "--episode", identity.episode,
  ];
}

export function shouldFlushWavefrontBatchForTests({
  pendingCutCount,
  minCuts = 15,
  oldestPendingMs = 0,
  nowMs = Date.now(),
  maxWaitMs = 5000,
  plannerDone = false,
} = {}) {
  if (pendingCutCount <= 0) return false;
  return pendingCutCount >= minCuts
    || plannerDone
    || nowMs - oldestPendingMs >= maxWaitMs;
}

export function combineWavefrontPlansForTests(plans = [], options = {}) {
  const prompts = [];
  const seen = new Set();
  for (const plan of plans) {
    for (const prompt of plan?.prompts ?? []) {
      const imageId = String(prompt?.image_id ?? "");
      if (!imageId || seen.has(imageId)) throw new Error(`Wavefront prompt identity is missing or duplicated: ${imageId || "(missing)"}.`);
      seen.add(imageId);
      prompts.push(prompt);
    }
  }
  return {
    schema: "goldflow_section_image_prompts_wavefront_batch_v1",
    status: "passed",
    channel: options.identity?.channel ?? plans[0]?.channel ?? null,
    series_slug: options.identity?.series_slug ?? plans[0]?.series_slug ?? null,
    week: options.identity?.week ?? plans[0]?.week ?? null,
    episode: options.identity?.episode ?? plans[0]?.episode ?? null,
    source_script_hash: plans[0]?.source_script_hash ?? null,
    image_provider: options.identity?.image_provider ?? plans[0]?.image_provider ?? "modelslab",
    prompt_policy: "sanctioned wavefront prefetch batch; official full prompt plan and hardening remain authoritative",
    wavefront_source_chunks: plans.map((plan) => plan?.wavefront?.chunk_id).filter(Boolean),
    prompts,
    updated_at: new Date().toISOString(),
  };
}

export function dedupeIncrementalAcceptedImagesForTests(batches = []) {
  const acceptedById = new Map();
  const hashOwner = new Map();
  const duplicateHashes = [];
  for (const batch of batches) {
    for (const row of batch?.incremental_accepted_images ?? []) {
      const imageId = String(row?.image_id ?? "");
      const imageHash = String(row?.image_sha256 ?? "");
      if (!imageId || !imageHash || !row?.image_path) continue;
      const owner = hashOwner.get(imageHash);
      if (owner && owner !== imageId) {
        duplicateHashes.push({
          image_id: imageId,
          duplicate_of_image_id: owner,
          image_sha256: imageHash,
        });
        continue;
      }
      hashOwner.set(imageHash, imageId);
      acceptedById.set(imageId, row);
    }
  }
  return {
    accepted_images: [...acceptedById.values()].sort((left, right) => (
      Number(left.start_sec ?? 0) - Number(right.start_sec ?? 0)
      || String(left.image_id).localeCompare(String(right.image_id))
    )),
    duplicate_hashes: duplicateHashes,
  };
}

export function wavefrontCompletionPartitionForTests(prompts = [], report = {}) {
  const completedCutIds = [...new Set((report?.results ?? [])
    .filter((row) => row?.image_id && row?.image_path)
    .map((row) => String(row.image_id)))];
  const completedCutIdSet = new Set(completedCutIds);
  return {
    completed_cut_ids: completedCutIds,
    deferred_cut_ids: prompts
      .map((prompt) => String(prompt?.image_id ?? ""))
      .filter(Boolean)
      .filter((imageId) => !completedCutIdSet.has(imageId)),
  };
}

export function stableMotionPrefetchCandidatesForTests({
  prompts = [],
  acceptedImages = [],
  decisions = [],
  timelineEndSec,
  motionPolicy = "legacy",
} = {}) {
  const acceptedById = new Map(acceptedImages.map((row) => [String(row.image_id ?? ""), row]));
  const decisionById = new Map(decisions.map((row) => [String(row.image_id ?? ""), row]));
  const promptById = new Map(prompts.map((row) => [String(row.image_id ?? ""), row]));
  let intents = prompts
    .filter((prompt) => prompt?.image_generation_required !== false)
    .map((prompt) => {
      const accepted = acceptedById.get(String(prompt.image_id ?? ""));
      const decision = decisionById.get(String(prompt.image_id ?? ""));
      const hashBoundDecision = accepted && decision?.image_sha256 === accepted.image_sha256
        ? decision
        : null;
      return motionIntentForPrompt(
        prompt,
        accepted?.image_sha256 ?? `pending:${prompt.image_id}`,
        hashBoundDecision,
        { timelineEndSec },
      );
    });
  if (motionPolicy === "selective_editorial_v1") {
    intents = rebalanceEditorialMotionStreaks(intents, { maximumMovingCuts: 7 });
  }
  return intents.filter((intent) => {
    const imageId = String(intent.image_id);
    const accepted = acceptedById.get(imageId);
    const prompt = promptById.get(imageId);
    const animationEligibility = String(
      prompt?.shot_manifest?.animation_intent?.eligibility
      ?? prompt?.animation_intent?.eligibility
      ?? "",
    ).trim().toLowerCase();
    const authoredDepthCandidate = prompt?.shot_manifest?.motion_intent?.depth_candidate
      ?? prompt?.motion_intent?.depth_candidate
      ?? null;
    return Boolean(
      accepted?.image_sha256
      && intent.image_sha256 === accepted.image_sha256
      && animationEligibility !== "animate"
      && authoredDepthCandidate?.eligible !== true
      && intent.depth_candidate?.eligible !== true
      && !intent.depth_treatment
      && !intent.generated_video_treatment
    );
  });
}

async function discoverPlans(waveDir, discovered) {
  const names = await fs.readdir(waveDir).catch(() => []);
  for (const name of names.filter((value) => value.endsWith(".plan.json")).sort()) {
    const filePath = path.join(waveDir, name);
    if (discovered.has(filePath)) continue;
    const plan = await readJson(filePath, null);
    if (plan?.status !== "passed" || !Array.isArray(plan.prompts) || !plan.prompts.length) continue;
    discovered.set(filePath, {
      filePath,
      plan,
      discoveredAtMs: Date.now(),
    });
  }
}

function selectPendingBatch(pendingRows, maxCuts) {
  const selected = [];
  let cutCount = 0;
  for (const row of pendingRows.sort((a, b) => a.filePath.localeCompare(b.filePath))) {
    if (selected.length && cutCount + row.plan.prompts.length > maxCuts) break;
    selected.push(row);
    cutCount += row.plan.prompts.length;
    if (cutCount >= maxCuts) break;
  }
  return selected;
}

async function finalizePrefetchBatch({
  batchId,
  batchDir,
  rows,
  combined,
  hardenedPlanPath,
  imagegenReportPath,
  hybridPoolReportPath,
  cutLedgerPath,
  focalAnalysisPath,
  semanticAuditPath,
  incrementalQaPath,
  incrementalQaReviewDir,
  incrementalQaEnabled,
  hybridProvider,
  imagegen,
}) {
  const report = await readJson(imagegenReportPath, null);
  const completionPartition = wavefrontCompletionPartitionForTests(combined.prompts, report);
  const completedCutIds = completionPartition.completed_cut_ids;
  const completedCutIdSet = new Set(completedCutIds);
  const deferredCutIds = completionPartition.deferred_cut_ids;
  let qaPromptPath = hardenedPlanPath;
  let qaImagegenReportPath = imagegenReportPath;
  if (imagegen.code !== 0 && completedCutIds.length) {
    qaPromptPath = path.join(batchDir, `${batchId}.qa-subset.hardened.json`);
    qaImagegenReportPath = path.join(batchDir, `${batchId}.qa-subset.imagegen.json`);
    const hardened = await readJson(hardenedPlanPath, null);
    const qaPlan = {
      ...hardened,
      status: "passed",
      prompts: (hardened?.prompts ?? []).filter((prompt) => completedCutIdSet.has(String(prompt.image_id))),
      wavefront_partial_qa_source_prompt_path: hardenedPlanPath,
      wavefront_partial_qa_completed_cut_ids: completedCutIds,
      updated_at: new Date().toISOString(),
    };
    await writeJsonAtomic(qaPromptPath, qaPlan);
    const qaPromptSha256 = await sha256File(qaPromptPath);
    const qaResults = (report?.results ?? []).filter((row) => completedCutIdSet.has(String(row.image_id)));
    await writeJsonAtomic(qaImagegenReportPath, {
      ...report,
      status: "passed",
      prompt_plan_path: qaPromptPath,
      prompt_plan_hash: qaPromptSha256,
      image_count: qaResults.length,
      expected_image_count: qaResults.length,
      missing_image_count: 0,
      results: qaResults,
      wavefront_partial_qa_source_report_path: imagegenReportPath,
      wavefront_partial_qa_source_report_status: report?.status ?? null,
      updated_at: new Date().toISOString(),
    });
  }
  return {
    batch_id: batchId,
    status: imagegen.code === 0 ? "prefetched" : "prefetch_partial_or_failed",
    cut_ids: combined.prompts.map((prompt) => prompt.image_id),
    source_chunk_files: rows.map((row) => row.filePath),
    hardened_plan_path: hardenedPlanPath,
    imagegen_report_path: imagegenReportPath,
    qa_prompt_path: qaPromptPath,
    qa_imagegen_report_path: qaImagegenReportPath,
    hybrid_pool_report_path: hybridProvider ? hybridPoolReportPath : null,
    cut_ledger_path: cutLedgerPath,
    current_batch_status: report?.current_batch_status ?? null,
    generated_or_reused_count: Number(hybridProvider
      ? report?.image_count ?? 0
      : report?.current_batch_image_count ?? report?.image_count ?? 0),
    completed_cut_ids: completedCutIds,
    deferred_cut_ids: deferredCutIds,
    incremental_qa_eligible: imagegen.code === 0 || completedCutIds.length > 0,
    incremental_qa_enabled: incrementalQaEnabled,
    focal_analysis_path: focalAnalysisPath,
    semantic_audit_path: semanticAuditPath,
    incremental_qa_path: incrementalQaPath,
    incremental_qa_review_dir: incrementalQaReviewDir,
  };
}

async function processPrefetchBatch({
  rows,
  batchIndex,
  attemptDir,
  identity,
  profile,
  firstProviderProbe,
  incrementalQaEnabled,
  browserImageStream = null,
}) {
  const batchId = `batch_${String(batchIndex).padStart(4, "0")}`;
  const batchDir = path.join(attemptDir, batchId);
  await fs.mkdir(batchDir, { recursive: true });
  const rawPlanPath = path.join(batchDir, `${batchId}.plan.json`);
  const hardenedPlanPath = path.join(batchDir, `${batchId}.hardened.json`);
  const hardeningReportPath = path.join(batchDir, `${batchId}.hardening.json`);
  const hardeningSamplePath = path.join(batchDir, `${batchId}.sample.md`);
  const imagegenReportPath = path.join(batchDir, `${batchId}.imagegen.json`);
  const cutLedgerPath = path.join(batchDir, `${batchId}.cut-ledger.json`);
  const providerHealthPath = path.join(batchDir, `${batchId}.provider-health.json`);
  const focalAnalysisPath = path.join(batchDir, `${batchId}.focal.json`);
  const semanticAuditPath = path.join(batchDir, `${batchId}.semantic-audit.json`);
  const incrementalQaPath = path.join(batchDir, `${batchId}.incremental-qa.json`);
  const incrementalQaReviewDir = path.join(batchDir, "qa-review");
  const combined = combineWavefrontPlansForTests(rows.map((row) => row.plan), { identity });
  await writeJsonAtomic(rawPlanPath, combined);
  const common = identityFlags(identity);
  const harden = await runNode([
    path.join(repoRoot, "scripts", "visual-prompt-harden.mjs"),
    ...common,
    "--prompts", rawPlanPath,
    "--output", hardenedPlanPath,
    "--report-output", hardeningReportPath,
    "--sample-output", hardeningSamplePath,
  ]);
  if (harden.code !== 0) {
    return {
      batch_id: batchId,
      status: "hardening_blocked",
      cut_ids: combined.prompts.map((prompt) => prompt.image_id),
      source_chunk_files: rows.map((row) => row.filePath),
      hardening_report_path: hardeningReportPath,
    };
  }
  const imageModel = identity?.model_versions?.image_model
    ?? identity?.provider_locks?.image_model
    ?? "flux-klein";
  const hybridProvider = isBrowserPoolImageProvider(normalizeImageProvider(identity.image_provider));
  const hybridPoolReportPath = path.join(batchDir, `${batchId}.hybrid-pool.json`);
  let imagegen;
  if (hybridProvider) {
    await writeJsonAtomic(providerHealthPath, {
      schema: "goldflow_wavefront_provider_health_binding_v1",
      status: "passed_by_identity_health_proof",
      image_provider: identity.image_provider,
      google_flow_health_proof_path: identity.image_provider_options?.google_flow?.health_proof_path ?? null,
      google_flow_health_proof_sha256: identity.image_provider_options?.google_flow?.health_proof_sha256 ?? null,
      provider_concurrency: HYBRID_TOTAL_IMAGE_CONCURRENCY,
      updated_at: new Date().toISOString(),
    });
    if (browserImageStream) {
      const completion = browserImageStream.append({
        promptsPath: hardenedPlanPath,
        assetIds: combined.prompts.map((prompt) => prompt.image_id),
        imagegenReportPath,
        poolReportPath: hybridPoolReportPath,
        cutExecutionLedgerPath: cutLedgerPath,
      }).then((result) => finalizePrefetchBatch({
        batchId,
        batchDir,
        rows,
        combined,
        hardenedPlanPath,
        imagegenReportPath,
        hybridPoolReportPath,
        cutLedgerPath,
        focalAnalysisPath,
        semanticAuditPath,
        incrementalQaPath,
        incrementalQaReviewDir,
        incrementalQaEnabled,
        hybridProvider,
        imagegen: result,
      }));
      return { queued: true, batch_id: batchId, completion };
    }
    imagegen = await runNode([
      path.join(repoRoot, "scripts", "hybrid-browser-image-pool.mjs"),
      ...common,
      "--prompts", hardenedPlanPath,
      "--image-ids", combined.prompts.map((prompt) => prompt.image_id).join(","),
      "--output", imagegenReportPath,
      "--pool-report-output", hybridPoolReportPath,
      "--cut-execution-ledger", cutLedgerPath,
      "--wavefront-prefetch", "true",
    ]);
  } else {
    imagegen = await runNode([
      path.join(repoRoot, "scripts", "imagegen.mjs"),
      ...common,
      "--image-provider", "modelslab",
      "--image-model", imageModel,
      "--prompts", hardenedPlanPath,
      "--skip-reference-generation", "true",
      "--concurrency", String(profile.media.image_concurrency),
      "--reference-concurrency", String(profile.media.reference_concurrency),
      "--provider-health-probe", firstProviderProbe ? "true" : "false",
      "--provider-health-report", providerHealthPath,
      "--output", imagegenReportPath,
      "--cut-execution-ledger", cutLedgerPath,
      "--batch-kind", "wavefront_prefetch",
    ]);
  }
  return finalizePrefetchBatch({
    batchId,
    batchDir,
    rows,
    combined,
    hardenedPlanPath,
    imagegenReportPath,
    hybridPoolReportPath,
    cutLedgerPath,
    focalAnalysisPath,
    semanticAuditPath,
    incrementalQaPath,
    incrementalQaReviewDir,
    incrementalQaEnabled,
    hybridProvider,
    imagegen,
  });
}

async function processIncrementalQaForBatch({
  batch,
  identity,
  profile,
  cumulativeDecisionsPath,
}) {
  if (!batch?.incremental_qa_enabled || batch.incremental_qa_eligible !== true) {
    Object.assign(batch, {
      focal_analysis_status: "not_run",
      incremental_qa_status: "not_run",
      incremental_accepted_images: [],
      incremental_risk_sheet_paths: [],
      incremental_not_inspected_image_ids: [],
      incremental_structural_findings: [],
    });
    return batch;
  }
  const common = identityFlags(identity);
  const focal = await runNode([
    path.join(repoRoot, "scripts", "image-focal-analysis.mjs"),
    ...common,
    "--prompts", batch.qa_prompt_path ?? batch.hardened_plan_path,
    "--imagegen-report", batch.qa_imagegen_report_path ?? batch.imagegen_report_path,
    "--output", batch.focal_analysis_path,
    "--concurrency", String(profile.media.focal_analysis_concurrency),
  ]);
  if (focal.code !== 0) {
    Object.assign(batch, {
      focal_analysis_status: "failed",
      incremental_qa_status: "not_run",
      incremental_accepted_images: [],
      incremental_risk_sheet_paths: [],
      incremental_not_inspected_image_ids: [],
      incremental_structural_findings: [],
    });
    return batch;
  }
  const qa = await runNode([
    path.join(repoRoot, "scripts", "image-output-qa.mjs"),
    ...common,
    "--prompts", batch.qa_prompt_path ?? batch.hardened_plan_path,
    "--imagegen-report", batch.qa_imagegen_report_path ?? batch.imagegen_report_path,
    "--focal-analysis", batch.focal_analysis_path,
    "--semantic-audit-output", batch.semantic_audit_path,
    "--output", batch.incremental_qa_path,
    "--decisions", cumulativeDecisionsPath,
    "--review-dir", batch.incremental_qa_review_dir,
    "--ledger", batch.cut_ledger_path,
    "--incremental-packet", "true",
    "--update-ledger", "false",
  ]);
  const report = await readJson(batch.incremental_qa_path, null);
  Object.assign(batch, {
    focal_analysis_status: "passed",
    incremental_qa_status: report?.status ?? (qa.code === 0 ? "unknown" : "failed"),
    incremental_accepted_images: report?.incremental_accepted_images ?? [],
    incremental_risk_sheet_paths: report?.review_packets?.risk_sheets ?? [],
    incremental_not_inspected_image_ids: report?.not_inspected_image_ids ?? [],
    incremental_structural_findings: report?.findings ?? [],
  });
  return batch;
}

function materializedRegistryCommand(stageId, identity, episodeDir) {
  const command = buildStageCommand(stageId, identity);
  const tokens = quoteAwareTokens(command).map((token) => token.replaceAll("<episode-dir>", episodeDir));
  if (tokens[0] !== "node" || tokens[1] !== "bin/goldflow.mjs" || tokens.some((token) => /[<>;]/.test(token))) {
    throw new Error(`Cannot materialize ${stageId} command for wavefront orchestration: ${command}`);
  }
  return [path.join(repoRoot, tokens[1]), ...tokens.slice(2)];
}

async function finalizeOfficialVisualArtifacts({ identity, episodeDir }) {
  const harden = await runNode(materializedRegistryCommand("visual_prompt_harden", identity, episodeDir));
  if (harden.code !== 0) {
    return { status: "hardening_blocked", harden_exit_code: harden.code };
  }
  const transitions = await runNode(materializedRegistryCommand("transition_edit_plan", identity, episodeDir));
  if (transitions.code !== 0) {
    return {
      status: "transition_plan_failed",
      harden_exit_code: harden.code,
      transition_exit_code: transitions.code,
    };
  }
  return {
    status: "passed",
    harden_exit_code: harden.code,
    transition_exit_code: transitions.code,
  };
}

async function prebuildStableMotionClips({
  batches,
  identity,
  episodeDir,
  attemptDir,
  profile,
  alreadyPrefetchedIds,
  snapshotIndex,
}) {
  const deduped = dedupeIncrementalAcceptedImagesForTests(batches);
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const transitionPath = path.join(episodeDir, `transition_edit_plan_${identity.episode}.json`);
  const audioBedPath = path.join(episodeDir, `longform_audio_bed_report_${identity.episode}.json`);
  const decisionsPath = path.join(episodeDir, `image_output_review_decisions_${identity.episode}.json`);
  const [promptPlan, transitionPlan, audioBed, decisions] = await Promise.all([
    readJson(promptPath, null),
    readJson(transitionPath, null),
    readJson(audioBedPath, null),
    readJson(decisionsPath, { decisions: [] }),
  ]);
  const timelineEndSec = Number(audioBed?.mixed_duration_sec ?? audioBed?.mix?.duration_sec);
  if (
    promptPlan?.status !== "passed"
    || transitionPlan?.status !== "passed"
    || !Number.isFinite(timelineEndSec)
    || timelineEndSec <= 0
  ) {
    return {
      status: "deferred_missing_finalized_inputs",
      selected_image_ids: [],
      duplicate_hashes: deduped.duplicate_hashes,
    };
  }
  const stableIntents = stableMotionPrefetchCandidatesForTests({
    prompts: promptPlan.prompts,
    acceptedImages: deduped.accepted_images,
    decisions: decisions.decisions ?? [],
    timelineEndSec,
    motionPolicy: identity.motion_policy ?? "legacy",
  });
  const newIntents = stableIntents.filter((intent) => !alreadyPrefetchedIds.has(String(intent.image_id)));
  if (!newIntents.length) {
    return {
      status: "nothing_new",
      selected_image_ids: [],
      duplicate_hashes: deduped.duplicate_hashes,
    };
  }
  const acceptedById = new Map(deduped.accepted_images.map((row) => [String(row.image_id), row]));
  const prebuildDir = path.join(attemptDir, "motion-prefetch");
  await fs.mkdir(prebuildDir, { recursive: true });
  const label = `snapshot_${String(snapshotIndex).padStart(4, "0")}`;
  const partialImagegenPath = path.join(prebuildDir, `${label}.imagegen.json`);
  const partialMotionPath = path.join(prebuildDir, `${label}.motion.json`);
  const prebuildReportPath = path.join(prebuildDir, `${label}.report.json`);
  await writeJsonAtomic(partialImagegenPath, {
    schema: "goldflow_incremental_motion_image_manifest_v1",
    status: "passed",
    channel: identity.channel,
    series_slug: identity.series_slug,
    week: identity.week,
    episode: identity.episode,
    results: newIntents.map((intent) => ({
      image_id: intent.image_id,
      image_path: acceptedById.get(String(intent.image_id))?.image_path,
      image_sha256: intent.image_sha256,
      status: "accepted_incremental_qa",
    })),
    updated_at: new Date().toISOString(),
  });
  await writeJsonAtomic(partialMotionPath, {
    schema: "goldflow_incremental_motion_edit_plan_v1",
    status: "passed",
    channel: identity.channel,
    series_slug: identity.series_slug,
    week: identity.week,
    episode: identity.episode,
    timeline_end_sec: timelineEndSec,
    accepted_cut_hashes: Object.fromEntries(newIntents.map((intent) => [intent.image_id, intent.image_sha256])),
    motion_intents: newIntents,
    updated_at: new Date().toISOString(),
  });
  const result = await runNode([
    path.join(repoRoot, "scripts", "render.mjs"),
    ...identityFlags(identity),
    "--prompts", promptPath,
    "--imagegen-report", partialImagegenPath,
    "--transition-plan", transitionPath,
    "--motion-plan", partialMotionPath,
    "--audio-bed-report", audioBedPath,
    "--prebuild-motion-clips", "true",
    "--prebuild-image-ids", newIntents.map((intent) => intent.image_id).join(","),
    "--work-dir", path.join(episodeDir, "assets", "render-work"),
    "--motion", identity.render_profile ?? "smooth_subpixel_ken_burns",
    "--render-concurrency", String(profile.render.render_concurrency),
    "--clip-preset", profile.render.clip_preset,
    "--final-preset", profile.render.final_preset,
    "--report-output", prebuildReportPath,
  ]);
  const report = await readJson(prebuildReportPath, null);
  if (result.code === 0) {
    for (const intent of newIntents) alreadyPrefetchedIds.add(String(intent.image_id));
  }
  return {
    status: result.code === 0 ? "passed" : "failed",
    selected_image_ids: newIntents.map((intent) => intent.image_id),
    generated_count: Number(report?.motion_clip_cache_generated_count ?? 0),
    reused_count: Number(report?.motion_clip_cache_reused_count ?? 0),
    report_path: prebuildReportPath,
    duplicate_hashes: deduped.duplicate_hashes,
  };
}

async function prefetchGeneratedMotionForBatch({
  batch,
  identity,
  episodeDir,
  profile,
}) {
  if (!generatedMotionEnabled(identity)) return { status: "disabled", selected_image_ids: [] };
  const acceptedRows = batch?.incremental_accepted_images ?? [];
  if (!acceptedRows.length) return { status: "nothing_accepted", selected_image_ids: [] };
  const acceptedIds = new Set(acceptedRows.map((row) => String(row.image_id ?? "")).filter(Boolean));
  const [promptPlan, imagegenReport, incrementalQa] = await Promise.all([
    readJson(batch.qa_prompt_path ?? batch.hardened_plan_path, null),
    readJson(batch.qa_imagegen_report_path ?? batch.imagegen_report_path, null),
    readJson(batch.incremental_qa_path, null),
  ]);
  const acceptedHashes = incrementalQa?.accepted_image_hashes ?? Object.fromEntries(acceptedRows.map((row) => [row.image_id, row.image_sha256]));
  const prompts = (promptPlan?.prompts ?? []).filter((row) => acceptedIds.has(String(row.image_id)));
  const results = (imagegenReport?.results ?? []).filter((row) => acceptedIds.has(String(row.image_id)));
  if (!prompts.length || results.length !== prompts.length) {
    return { status: "deferred_incomplete_hash_bound_subset", selected_image_ids: [...acceptedIds] };
  }
  const prefetchDir = path.join(path.dirname(batch.incremental_qa_path), "generated-motion-prefetch");
  const promptPath = path.join(prefetchDir, "accepted-prompts.json");
  const imagegenPath = path.join(prefetchDir, "accepted-imagegen.json");
  const imageQaPath = path.join(prefetchDir, "accepted-image-qa.json");
  const directionPath = path.join(prefetchDir, "animation-direction-plan.json");
  const generatedDir = path.join(prefetchDir, "generated");
  const generatedPlanPath = path.join(generatedDir, "generated-motion-plan.json");
  const generatedReportPath = path.join(generatedDir, "generated-motion-report.json");
  await fs.mkdir(prefetchDir, { recursive: true });
  await writeJsonAtomic(promptPath, {
    ...promptPlan,
    status: "passed",
    prompts,
    wavefront_incremental_generated_motion_source: batch.hardened_plan_path,
    updated_at: new Date().toISOString(),
  });
  await writeJsonAtomic(imagegenPath, {
    ...imagegenReport,
    status: "passed",
    prompt_plan_path: promptPath,
    prompt_plan_hash: await sha256File(promptPath),
    image_count: results.length,
    expected_image_count: results.length,
    missing_image_count: 0,
    results,
    updated_at: new Date().toISOString(),
  });
  await writeJsonAtomic(imageQaPath, {
    schema: "goldflow_incremental_generated_motion_image_qa_v1",
    status: "passed",
    accepted_image_hashes: Object.fromEntries(prompts.map((row) => [row.image_id, acceptedHashes[row.image_id]])),
    source_incremental_qa_path: batch.incremental_qa_path,
    source_incremental_qa_sha256: await sha256File(batch.incremental_qa_path),
    updated_at: new Date().toISOString(),
  });
  const direction = await runNode([
    path.join(repoRoot, "scripts", "visual-animation-plan.mjs"),
    ...identityFlags(identity),
    "--episode-dir", episodeDir,
    "--prompts", promptPath,
    "--imagegen-report", imagegenPath,
    "--image-output-qa", imageQaPath,
    "--output", directionPath,
  ]);
  const directionPlan = await readJson(directionPath, null);
  if (direction.code !== 0 || directionPlan?.status !== "passed") {
    return { status: "direction_failed", selected_image_ids: [...acceptedIds], direction_plan_path: directionPath };
  }
  const selectedImageIds = (directionPlan.directions ?? []).map((row) => String(row.image_id));
  if (!selectedImageIds.length) {
    return { status: "no_animation_eligible_cuts", selected_image_ids: [], direction_plan_path: directionPath };
  }
  const coherencePrefetchEnabled = profile.orchestration?.generated_motion_coherence_prefetch
    ?? profile.orchestration?.incremental_generated_motion_prefetch
    ?? false;
  const generated = await runNode([
    path.join(repoRoot, "scripts", "generated-motion-generate.mjs"),
    ...identityFlags(identity),
    "--episode-dir", episodeDir,
    "--animation-direction-plan", directionPath,
    "--output-dir", generatedDir,
    "--plan", generatedPlanPath,
    "--output", generatedReportPath,
    "--cut-ids", selectedImageIds.join(","),
    "--concurrency", String(profile.media.generated_motion_concurrency ?? 3),
    "--prefetch-coherence-cache", String(coherencePrefetchEnabled),
  ]);
  const generatedReport = await readJson(generatedReportPath, null);
  const coherencePrefetchPath = path.join(generatedDir, `generated_motion_coherence_prefetch_${identity.episode}.json`);
  const coherencePrefetch = await readJson(coherencePrefetchPath, null);
  return {
    status: generated.code === 0 ? "passed" : "failed_or_omitted",
    selected_image_ids: selectedImageIds,
    direction_plan_path: directionPath,
    generated_plan_path: generatedPlanPath,
    generated_report_path: generatedReportPath,
    generated_count: Number(generatedReport?.generated_count ?? 0),
    omitted_count: Number(generatedReport?.omitted_count ?? 0),
    coherence_prefetch_status: coherencePrefetch?.status ?? (coherencePrefetchEnabled ? "unavailable" : "disabled"),
    coherence_prefetch_path: coherencePrefetch?.status === "passed" ? coherencePrefetchPath : null,
    coherence_prefetch_summary: coherencePrefetch?.summary ?? null,
    idempotency_policy: "official_stage_reuses_exact_per_cut_flow_request",
  };
}

async function main() {
  const initial = await readStatus();
  const identityPath = path.join(initial.episode_dir, "run_identity.json");
  // run-status exposes the effective identity after operator overrides. Validate
  // the override against the immutable source identity instead of applying it twice.
  const baseIdentity = await readJson(identityPath, null);
  if (!baseIdentity) throw new Error("run visual-wavefront requires a valid run_identity.json.");
  const effectiveImageIdentity = await effectiveImageIdentityForEpisode(
    initial.episode_dir,
    identityPath,
    baseIdentity,
  );
  if (effectiveImageIdentity.override && effectiveImageIdentity.status?.done !== true) {
    throw new Error(`Visual wavefront image route override is invalid: ${effectiveImageIdentity.status?.evidence ?? "unknown override failure"}`);
  }
  const identity = effectiveImageIdentity.status?.done === true
    ? effectiveImageIdentity.identity
    : baseIdentity;
  const imageProvider = normalizeImageProvider(identity.image_provider ?? "modelslab");
  if (imageProvider !== "modelslab" && !isBrowserPoolImageProvider(imageProvider)) {
    throw new Error(`Visual wavefront prefetch supports ModelsLab and verified browser-backed Flow lanes; run identity locks ${identity.image_provider}.`);
  }
  const exactPromptRecovery = exactPromptRecoveryAllowed(initial, flags);
  if (!(initial.allowed_command_stages ?? []).includes("visual_prompt_plan") && !exactPromptRecovery) {
    throw new Error(`Visual prompt planning is not ready. Current stage: ${initial.current_stage}; allowed: ${(initial.allowed_command_stages ?? []).join(", ")}.`);
  }
  const profile = productionProfileForIdentity(identity);
  const minCuts = Math.max(1, Number(flags["min-cuts"] ?? profile.orchestration?.wavefront_min_cuts ?? 15));
  const maxWaitMs = Math.max(250, Number(flags["max-wait-ms"] ?? profile.orchestration?.wavefront_max_wait_ms ?? 5000));
  const maxBatchCuts = Math.max(minCuts, Number(flags["max-batch-cuts"] ?? 60));
  const attemptDir = path.join(
    initial.episode_dir,
    "reports",
    "visual-wavefront",
    `${safeTimestamp()}-${process.pid}`,
  );
  const waveDir = path.join(attemptDir, "planner-waves");
  const cumulativeDecisionsPath = path.join(
    initial.episode_dir,
    `image_output_review_decisions_${identity.episode}.json`,
  );
  await fs.mkdir(waveDir, { recursive: true });
  const exactRecoveryScope = String(flags["cut-ids"] ?? flags["beat-ids"] ?? "").trim();
  const streamScopeSuffix = exactRecoveryScope
    ? `:exact-repair:${createHash("sha256").update(exactRecoveryScope).digest("hex").slice(0, 16)}`
    : "";
  const browserImageStream = isFederatedWebImageProvider(imageProvider)
    ? await openWavefrontBrowserImageStream({
        episodeDir: initial.episode_dir,
        identity,
        streamId: `visual-wavefront:${identity.channel}:${identity.series_slug}:${identity.week}:${identity.episode}:${identity.stage_registry_version ?? "registry"}${streamScopeSuffix}`,
        flowRuntimeConcurrency: HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY,
      })
    : null;

  const plannerCommand = buildStageCommand("visual_prompt_plan", identity);
  let plannerTokens = quoteAwareTokens(plannerCommand);
  if (plannerTokens[0] !== "node" || plannerTokens[1] !== "bin/goldflow.mjs") {
    throw new Error(`Cannot materialize visual prompt command: ${plannerCommand}`);
  }
  plannerTokens = plannerTokensWithWavefrontOverrides(plannerTokens, flags);
  const plannerPromise = runNode([
    path.join(repoRoot, plannerTokens[1]),
    ...plannerTokens.slice(2),
    "--wavefront-output-dir", waveDir,
  ]);
  let plannerDone = false;
  let plannerResult = null;
  plannerPromise.then((result) => {
    plannerDone = true;
    plannerResult = result;
  });
  const officialFinalizePromise = plannerPromise.then((result) => (
    result.code === 0
      ? finalizeOfficialVisualArtifacts({ identity, episodeDir: initial.episode_dir })
      : { status: "planner_failed", planner_exit_code: result.code }
  ));

  const discovered = new Map();
  const processed = new Set();
  const batches = [];
  const motionPrefetches = [];
  const generatedMotionPrefetches = [];
  const motionPrefetchedIds = new Set();
  let incrementalQaChain = Promise.resolve();
  const incrementalQaTasks = [];
  let motionPrefetchSnapshot = 0;
  let motionPrefetchChain = Promise.resolve();
  let generatedMotionPrefetchChain = Promise.resolve();
  let batchIndex = 0;
  let finalDiscoveryDone = false;
  while (!plannerDone || !finalDiscoveryDone || [...discovered.keys()].some((filePath) => !processed.has(filePath))) {
    await discoverPlans(waveDir, discovered);
    if (plannerDone) finalDiscoveryDone = true;
    const pending = [...discovered.values()].filter((row) => !processed.has(row.filePath));
    const pendingCutCount = pending.reduce((sum, row) => sum + row.plan.prompts.length, 0);
    const oldestPendingMs = pending.length ? Math.min(...pending.map((row) => row.discoveredAtMs)) : Date.now();
    if (shouldFlushWavefrontBatchForTests({
      pendingCutCount,
      minCuts,
      oldestPendingMs,
      maxWaitMs,
      plannerDone,
    })) {
      const selected = selectPendingBatch(pending, maxBatchCuts);
      batchIndex += 1;
      const scheduledBatch = await processPrefetchBatch({
        rows: selected,
        batchIndex,
        attemptDir,
        identity,
        profile,
        firstProviderProbe: batchIndex === 1,
        incrementalQaEnabled: profile.orchestration?.incremental_image_qa === true,
        browserImageStream,
      });
      motionPrefetchSnapshot += 1;
      const snapshotIndex = motionPrefetchSnapshot;
      const batchReady = scheduledBatch?.queued === true
        ? scheduledBatch.completion
        : Promise.resolve(scheduledBatch);
      const incrementalQaTask = batchReady.then((batch) => {
        const queuedQa = incrementalQaChain.then(async () => {
          batches.push(batch);
          batches.sort((left, right) => String(left.batch_id).localeCompare(String(right.batch_id)));
          await processIncrementalQaForBatch({
            batch,
            identity,
            profile,
            cumulativeDecisionsPath,
          });
          if (profile.orchestration?.incremental_generated_motion_prefetch === true) {
            generatedMotionPrefetchChain = generatedMotionPrefetchChain.then(async () => {
              const prefetch = await prefetchGeneratedMotionForBatch({
                batch,
                identity,
                episodeDir: initial.episode_dir,
                profile,
              });
              generatedMotionPrefetches.push({ snapshot_index: snapshotIndex, ...prefetch });
            });
          }
          if (profile.orchestration?.incremental_motion_clip_prefetch !== true) return;
          motionPrefetchChain = motionPrefetchChain.then(async () => {
            const finalized = await officialFinalizePromise;
            if (finalized.status !== "passed") {
              motionPrefetches.push({
                status: "deferred_official_visual_artifacts_not_ready",
                snapshot_index: snapshotIndex,
                finalized_status: finalized.status,
              });
              return;
            }
            const prefetch = await prebuildStableMotionClips({
              batches,
              identity,
              episodeDir: initial.episode_dir,
              attemptDir,
              profile,
              alreadyPrefetchedIds: motionPrefetchedIds,
              snapshotIndex,
            });
            motionPrefetches.push({ snapshot_index: snapshotIndex, ...prefetch });
          });
        });
        incrementalQaChain = queuedQa;
        return queuedQa;
      });
      incrementalQaTasks.push(incrementalQaTask);
      for (const row of selected) processed.add(row.filePath);
      continue;
    }
    await sleep(250);
  }
  const browserStreamDrainPromise = browserImageStream
    ? browserImageStream.seal().then(
        (result) => ({ result, error: null }),
        (error) => ({ result: null, error }),
      )
    : Promise.resolve({ result: null, error: null });
  if (!plannerResult) plannerResult = await plannerPromise;
  const officialFinalize = await officialFinalizePromise;
  await Promise.all(incrementalQaTasks);
  await generatedMotionPrefetchChain;
  await motionPrefetchChain;
  const browserStreamDrainOutcome = await browserStreamDrainPromise;
  if (browserStreamDrainOutcome.error) throw browserStreamDrainOutcome.error;
  const browserStreamDrain = browserStreamDrainOutcome.result;
  const acceptedSummary = dedupeIncrementalAcceptedImagesForTests(batches);
  const report = {
    schema: "goldflow_visual_wavefront_prefetch_v1",
    status: plannerResult.code === 0 ? "passed" : "planner_failed",
    episode_dir: initial.episode_dir,
    planner_exit_code: plannerResult.code,
    planner_wave_count: discovered.size,
    processed_wave_count: processed.size,
    batch_count: batches.length,
    prefetched_cut_count: [...new Set(batches.flatMap((batch) => batch.completed_cut_ids ?? []))].length,
    incremental_qa_accepted_cut_count: acceptedSummary.accepted_images.length,
    incremental_qa_duplicate_hashes: acceptedSummary.duplicate_hashes,
    incremental_qa_risk_sheet_paths: [...new Set(batches.flatMap((batch) => batch.incremental_risk_sheet_paths ?? []))],
    incremental_qa_pending_risk_ids: [...new Set(batches.flatMap((batch) => batch.incremental_not_inspected_image_ids ?? []))],
    cumulative_review_decisions_path: cumulativeDecisionsPath,
    browser_stream_drain: browserStreamDrain,
    official_visual_finalize: officialFinalize,
    motion_prefetches: motionPrefetches,
    generated_motion_prefetches: generatedMotionPrefetches,
    generated_motion_prefetched_cut_count: new Set(generatedMotionPrefetches.flatMap((row) => row.selected_image_ids ?? [])).size,
    motion_prefetched_cut_count: motionPrefetchedIds.size,
    deferred_cut_ids: [...new Set(batches.flatMap((batch) => batch.deferred_cut_ids ?? []))],
    policy: {
      min_cuts: minCuts,
      max_wait_ms: maxWaitMs,
      max_batch_cuts: maxBatchCuts,
      browser_queue_mode: browserImageStream ? "single_appendable_episode_manifest" : "legacy_batch_terminal_wait",
      provider_concurrency: isBrowserPoolImageProvider(imageProvider)
        ? isFederatedWebImageProvider(imageProvider)
          ? federatedWebImageConcurrencyForIdentity(identity)
          : isGoogleFlowPrimaryProvider(imageProvider)
          ? HYBRID_GOOGLE_FLOW_IMAGE_CONCURRENCY
          : HYBRID_TOTAL_IMAGE_CONCURRENCY
        : profile.media.image_concurrency,
      official_full_harden_and_image_materialization_still_required: true,
      incremental_image_qa_enabled: profile.orchestration?.incremental_image_qa === true,
      incremental_motion_clip_prefetch_enabled: profile.orchestration?.incremental_motion_clip_prefetch === true,
      incremental_generated_motion_prefetch_enabled: profile.orchestration?.incremental_generated_motion_prefetch === true,
      motion_prefetch_scope: "hash-bound QA-accepted single-plane still-motion intents without generated-video or parallax dependency",
      generated_motion_prefetch_scope: "hash-bound QA-accepted animation-ready cuts; official stage reuses the exact per-cut Flow request",
    },
    batches,
    completed_at: new Date().toISOString(),
  };
  const reportPath = path.join(attemptDir, "visual_wavefront_prefetch_report.json");
  await writeJsonAtomic(reportPath, report);
  console.log(JSON.stringify({
    status: report.status,
    report_path: reportPath,
    planner_wave_count: report.planner_wave_count,
    batch_count: report.batch_count,
    prefetched_cut_count: report.prefetched_cut_count,
    incremental_qa_accepted_cut_count: report.incremental_qa_accepted_cut_count,
    incremental_qa_pending_risk_count: report.incremental_qa_pending_risk_ids.length,
    motion_prefetched_cut_count: report.motion_prefetched_cut_count,
    generated_motion_prefetched_cut_count: report.generated_motion_prefetched_cut_count,
    deferred_cut_count: report.deferred_cut_ids.length,
  }, null, 2));
  if (plannerResult.code !== 0) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
