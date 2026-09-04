#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { sha256File } from "./lib/file-hash.mjs";
import {
  LEGACY_YOUTUBE_PACKAGING_SPEC_SCHEMA,
  YOUTUBE_PACKAGING_SPEC_SCHEMA,
  YOUTUBE_PINNED_COMMENT_RECEIPT_SCHEMA,
  YOUTUBE_PUBLISH_MANIFEST_SCHEMA,
  YOUTUBE_THUMBNAIL_UPDATE_RECEIPT_SCHEMA,
  YOUTUBE_THUMBNAIL_GENERATION_CONTRACT,
  YOUTUBE_UPLOAD_RECEIPT_SCHEMA,
  listYoutubeThumbnailUpdateReceipts,
  validateYoutubeThumbnailUpdateReceipt,
  validateYoutubePackagingSpec,
  validateYoutubePinnedCommentReceipt,
  validateYoutubeUploadReceipt,
  youtubeEffectiveThumbnailState,
  youtubeFinalQaDurationSeconds,
  youtubeTextSha256,
} from "./lib/youtube-publish-contract.mjs";
import {
  YOUTUBE_NATIVE_AB_PLAN_SCHEMA,
  YOUTUBE_NATIVE_AB_RECEIPT_SCHEMA,
  validateYoutubeAbCandidates,
  validateYoutubeNativeAbPlan,
  validateYoutubeNativeAbReceipt,
  youtubeAbPlanSha256,
} from "./lib/youtube-ab-test-contract.mjs";
import { createAnalyticsFollowupPlanForUpload } from "./youtube-analytics-followup.mjs";
import {
  activeChannelUploadExperiment,
  channelUploadExperimentUsage,
  validateChannelUploadExperimentSpec,
  verifyChannelUploadExperimentIdentity,
} from "./lib/channel-upload-experiment.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const action = process.argv[2] ?? "";
const flags = parseFlags(process.argv.slice(3));

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const equalsIndex = part.indexOf("=", 2);
    if (equalsIndex !== -1) {
      parsed[part.slice(2, equalsIndex)] = part.slice(equalsIndex + 1);
      continue;
    }
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function isTrue(value) {
  return /^(true|1|yes)$/i.test(String(value ?? ""));
}

function clean(value) {
  return String(value ?? "").trim();
}

function requiredFlag(name, value) {
  if (!clean(value)) throw new Error(`Missing required --${name}.`);
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
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

function episodeDirectory() {
  if (flags["episode-dir"]) return path.resolve(flags["episode-dir"]);
  requiredFlag("channel", flags.channel);
  requiredFlag("week", flags.week);
  requiredFlag("episode", flags.episode);
  return path.join(
    dataRoot,
    "channels",
    flags.channel,
    "weekly_runs",
    flags.week,
    "episodes",
    flags.episode,
  );
}

async function episodeContext() {
  const episodeDir = episodeDirectory();
  const identityPath = path.join(episodeDir, "run_identity.json");
  const identity = await readJson(identityPath);
  if (!identity) throw new Error(`Missing or invalid run identity: ${identityPath}`);
  const episode = flags.episode ?? identity.episode ?? path.basename(episodeDir);
  return { episodeDir, identity, identityPath, episode };
}

async function packagingInputs(episodeDir, episode) {
  const packagePath = path.join(episodeDir, `upload_packaging_${episode}.md`);
  const specPath = path.join(episodeDir, `youtube_packaging_spec_${episode}.json`);
  if (!(await exists(packagePath))) throw new Error(`Missing upload package: ${packagePath}`);
  const [markdown, spec] = await Promise.all([
    fs.readFile(packagePath, "utf8"),
    readJson(specPath),
  ]);
  if (!spec) throw new Error(`Missing or invalid packaging spec: ${specPath}`);
  if (![YOUTUBE_PACKAGING_SPEC_SCHEMA, LEGACY_YOUTUBE_PACKAGING_SPEC_SCHEMA].includes(spec.schema)) {
    throw new Error(`Unsupported packaging spec schema: ${spec.schema ?? "missing"}`);
  }
  const thumbnailPath = path.resolve(episodeDir, clean(spec.thumbnail_final_path));
  if (!(await exists(thumbnailPath))) throw new Error(`Missing final thumbnail: ${thumbnailPath}`);
  const [metadata, stat] = await Promise.all([
    sharp(thumbnailPath).metadata(),
    fs.stat(thumbnailPath),
  ]);
  return {
    packagePath,
    specPath,
    markdown,
    spec,
    thumbnailPath,
    thumbnailMetadata: {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    },
    thumbnailBytes: stat.size,
  };
}

async function channelExperimentContext({ episodeDir, identity, episode, spec }) {
  const channelRoot = path.join(path.resolve(dataRoot), "channels", clean(identity.channel));
  const relativeEpisodePath = path.relative(channelRoot, path.resolve(episodeDir));
  if (relativeEpisodePath.startsWith("..") || path.isAbsolute(relativeEpisodePath)) return null;
  const active = await activeChannelUploadExperiment({ repoRoot, channel: identity.channel });
  if (!active) return null;
  const identityVerification = await verifyChannelUploadExperimentIdentity({
    dataRoot,
    channel: identity.channel,
    experiment: active.document,
  });
  if (identityVerification.status === "blocked") {
    throw new Error(`Channel upload experiment identity mismatch: ${identityVerification.blockers.join(", ")}`);
  }
  const usage = await channelUploadExperimentUsage({
    dataRoot,
    channel: identity.channel,
    experimentId: active.document.experiment_id,
  });
  const finalQa = await readJson(path.join(episodeDir, `final_qa_${episode}.json`));
  const durationSec = youtubeFinalQaDurationSeconds(finalQa);
  const validation = validateChannelUploadExperimentSpec({
    experiment: active.document,
    spec,
    durationSec,
    finalVideoSha256: finalQa?.final_video_sha256,
    usedCount: usage.count,
  });
  return { ...active, identityVerification, usage, durationSec, validation };
}

function packagingValidation(inputs, options = {}) {
  return validateYoutubePackagingSpec(inputs.spec, {
    markdown: inputs.markdown,
    thumbnailMetadata: inputs.thumbnailMetadata,
    thumbnailBytes: inputs.thumbnailBytes,
    ...options,
  });
}

async function approvePackaging() {
  const { episodeDir, identity, episode } = await episodeContext();
  if (!isTrue(flags.approve)) throw new Error("Packaging approval requires --approve true.");
  requiredFlag("approved-by", flags["approved-by"]);
  const inputs = await packagingInputs(episodeDir, episode);
  const approvedSpec = {
    ...inputs.spec,
    status: "approved",
    approved_by: clean(flags["approved-by"]),
    approved_at: new Date().toISOString(),
    approval_note: clean(flags.note) || "Title, thumbnail, description, and pinned-comment package reviewed.",
  };
  const validation = validateYoutubePackagingSpec(approvedSpec, {
    markdown: inputs.markdown,
    thumbnailMetadata: inputs.thumbnailMetadata,
    thumbnailBytes: inputs.thumbnailBytes,
  });
  const experiment = await channelExperimentContext({ episodeDir, identity, episode, spec: approvedSpec });
  if (experiment?.validation.applies && experiment.validation.blockers.length) {
    validation.blockers.push(...experiment.validation.blockers);
    validation.status = "blocked";
  }
  if (validation.status !== "passed") {
    console.log(JSON.stringify({ status: "blocked", blockers: validation.blockers }, null, 2));
    process.exitCode = 2;
    return;
  }
  await writeJson(inputs.specPath, approvedSpec);
  console.log(JSON.stringify({
    status: "passed",
    packaging_spec_path: inputs.specPath,
    selected_title: approvedSpec.selected_title,
    selected_thumbnail_candidate_id: approvedSpec.selected_thumbnail_candidate_id,
    channel_experiment: experiment?.validation.applies ? {
      experiment_id: experiment.document.experiment_id,
      ordinal: experiment.validation.ordinal,
      eligible_upload_count: experiment.document.eligible_upload_count,
    } : null,
  }, null, 2));
}

async function approveNativeAbTest() {
  const { episodeDir, episode } = await episodeContext();
  if (!isTrue(flags.approve)) throw new Error("Native A/B approval requires --approve true.");
  requiredFlag("candidate-file", flags["candidate-file"]);
  requiredFlag("approved-by", flags["approved-by"]);
  const inputs = await packagingInputs(episodeDir, episode);
  const packageValidation = packagingValidation(inputs, { allowLegacyAdapter: true });
  if (packageValidation.status !== "passed") {
    throw new Error(`Approved packaging required before A/B approval: ${packageValidation.blockers.join(", ")}`);
  }
  const candidatePath = path.resolve(episodeDir, clean(flags["candidate-file"]));
  const candidates = await readJson(candidatePath);
  const candidateValidation = validateYoutubeAbCandidates(candidates);
  if (candidateValidation.status !== "passed") {
    console.log(JSON.stringify({ status: "blocked", blockers: candidateValidation.blockers }, null, 2));
    process.exitCode = 2;
    return;
  }
  const variants = [];
  for (const row of candidates.candidates) {
    const thumbnailPath = path.resolve(episodeDir, clean(row.thumbnail_path));
    if (!(await exists(thumbnailPath))) throw new Error(`A/B thumbnail missing: ${thumbnailPath}`);
    const thumbnail = await thumbnailFileEvidence(thumbnailPath);
    const provider = clean(row.provider) || YOUTUBE_THUMBNAIL_GENERATION_CONTRACT.provider;
    if (!YOUTUBE_THUMBNAIL_GENERATION_CONTRACT.allowed_providers.includes(provider)) {
      throw new Error(`A/B variant ${row.id} uses unapproved thumbnail provider: ${provider}`);
    }
    variants.push({
      id: clean(row.id),
      title: clean(row.title),
      title_sha256: youtubeTextSha256(row.title),
      thumbnail_path: thumbnail.path,
      thumbnail_sha256: thumbnail.sha256,
      thumbnail_bytes: thumbnail.bytes,
      thumbnail_width: thumbnail.width,
      thumbnail_height: thumbnail.height,
      thumbnail_format: thumbnail.format,
      thumbnail_candidate_id: clean(row.thumbnail_candidate_id) || null,
      provider,
      hypothesis: clean(row.hypothesis),
    });
  }
  const planPath = path.join(episodeDir, `youtube_native_ab_plan_${episode}.json`);
  const packagingSpecSha256 = await sha256File(inputs.specPath);
  const plan = {
    schema: YOUTUBE_NATIVE_AB_PLAN_SCHEMA,
    status: "approved",
    episode,
    test_type: clean(candidates.test_type),
    baseline_variant_id: clean(candidates.baseline_variant_id),
    variants,
    candidate_source_path: candidatePath,
    candidate_source_sha256: await sha256File(candidatePath),
    packaging_spec_path: inputs.specPath,
    packaging_spec_sha256: packagingSpecSha256,
    approved_by: clean(flags["approved-by"]),
    approved_at: new Date().toISOString(),
    approval_note: clean(flags.note) || "Native YouTube package test variants approved.",
  };
  plan.plan_sha256 = youtubeAbPlanSha256(plan);
  const validation = validateYoutubeNativeAbPlan(plan, {
    packagingSpecSha256,
    baselineTitle: inputs.spec.selected_title,
    baselineThumbnailSha256: await sha256File(inputs.thumbnailPath),
  });
  if (validation.status !== "passed") {
    console.log(JSON.stringify({ status: "blocked", blockers: validation.blockers }, null, 2));
    process.exitCode = 2;
    return;
  }
  await writeJson(planPath, plan);
  console.log(JSON.stringify({
    status: "passed",
    plan_path: planPath,
    test_type: plan.test_type,
    variant_ids: variants.map((row) => row.id),
  }, null, 2));
}

async function prepareManifest() {
  const { episodeDir, identity, identityPath, episode } = await episodeContext();
  const inputs = await packagingInputs(episodeDir, episode);
  const validation = packagingValidation(inputs, { allowLegacyAdapter: true });
  if (validation.status !== "passed") {
    console.log(JSON.stringify({ status: "blocked", blockers: validation.blockers }, null, 2));
    process.exitCode = 2;
    return;
  }

  const finalQaPath = path.join(episodeDir, `final_qa_${episode}.json`);
  const finalQa = await readJson(finalQaPath);
  if (!finalQa || clean(finalQa.status) !== "passed") {
    throw new Error(`Passed final QA required: ${finalQaPath}`);
  }
  const experiment = await channelExperimentContext({ episodeDir, identity, episode, spec: inputs.spec });
  if (experiment?.validation.applies && experiment.validation.blockers.length) {
    throw new Error(`Active channel upload experiment blocked packaging: ${experiment.validation.blockers.join(", ")}`);
  }
  const videoPath = path.resolve(finalQa.final_video_path ?? "");
  if (!(await exists(videoPath))) throw new Error(`Final upload video missing: ${videoPath}`);
  const [videoStat, videoSha256] = await Promise.all([
    fs.stat(videoPath),
    sha256File(videoPath),
  ]);
  if (videoSha256 !== clean(finalQa.final_video_sha256)) {
    throw new Error("Final video hash no longer matches final QA.");
  }

  const selectedThumbnail = validation.selected_thumbnail_candidate;
  const abPlanPath = path.join(episodeDir, `youtube_native_ab_plan_${episode}.json`);
  const abPlan = await readJson(abPlanPath);
  if (abPlan) {
    const abValidation = validateYoutubeNativeAbPlan(abPlan, {
      packagingSpecSha256: await sha256File(inputs.specPath),
      baselineTitle: inputs.spec.selected_title,
      baselineThumbnailSha256: await sha256File(inputs.thumbnailPath),
    });
    if (abValidation.status !== "passed") {
      throw new Error(`Native A/B plan is stale or invalid: ${abValidation.blockers.join(", ")}`);
    }
    for (const row of abPlan.variants ?? []) {
      const current = await sha256File(row.thumbnail_path).catch(() => null);
      if (!current || current !== row.thumbnail_sha256) {
        throw new Error(`Native A/B thumbnail is stale: ${row.thumbnail_path}`);
      }
    }
  }
  const sourcePaths = [
    identityPath,
    finalQaPath,
    inputs.packagePath,
    inputs.specPath,
    inputs.thumbnailPath,
    ...(experiment?.validation.applies ? [experiment.path] : []),
    ...(abPlan ? [abPlanPath, ...abPlan.variants.map((row) => row.thumbnail_path)] : []),
  ];
  const sourceHashes = Object.fromEntries(await Promise.all(
    sourcePaths.map(async (sourcePath) => [sourcePath, await sha256File(sourcePath)]),
  ));
  const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
  const manifest = {
    schema: YOUTUBE_PUBLISH_MANIFEST_SCHEMA,
    status: "passed",
    episode,
    channel: identity.channel ?? null,
    youtube_channel: inputs.spec.youtube_channel,
    prepared_at: new Date().toISOString(),
    prepared_by: clean(flags["prepared-by"]) || "goldflow",
    source_hashes: sourceHashes,
    packaging_spec_path: inputs.specPath,
    packaging_spec_sha256: sourceHashes[inputs.specPath],
    packaging_schema_mode: validation.schema_mode,
    packaging_validation_warnings: validation.warnings,
    upload_package_path: inputs.packagePath,
    video: {
      path: videoPath,
      sha256: videoSha256,
      bytes: videoStat.size,
    },
    title: clean(inputs.spec.selected_title),
    description: clean(inputs.spec.description),
    tags: [...new Set((inputs.spec.tags ?? []).map(clean).filter(Boolean))],
    thumbnail: {
      path: inputs.thumbnailPath,
      sha256: sourceHashes[inputs.thumbnailPath],
      bytes: inputs.thumbnailBytes,
      width: inputs.thumbnailMetadata.width,
      height: inputs.thumbnailMetadata.height,
      format: inputs.thumbnailMetadata.format,
      candidate_id: selectedThumbnail.id,
      main_text: clean(selectedThumbnail.main_text),
      subjects: selectedThumbnail.subjects,
      labels: selectedThumbnail.labels ?? [],
      arrows: selectedThumbnail.arrows ?? [],
      provider: selectedThumbnail.provider ?? null,
      generation_mode: selectedThumbnail.generation_mode ?? null,
      reference_count: selectedThumbnail.reference_count ?? null,
      text_rendered_by_model: selectedThumbnail.text_rendered_by_model ?? null,
      locally_composited_text: selectedThumbnail.locally_composited_text ?? null,
      locally_composited_arrows: selectedThumbnail.locally_composited_arrows ?? null,
      legacy_adapter_applied: validation.legacy_adapter_applied,
      validation_warnings: validation.warnings,
    },
    pinned_comment: {
      text: clean(inputs.spec.pinned_comment?.text),
      text_sha256: youtubeTextSha256(inputs.spec.pinned_comment?.text),
      betrayal_choice: clean(inputs.spec.pinned_comment?.betrayal_choice),
    },
    publish_settings: inputs.spec.publish_settings,
    channel_experiment: experiment?.validation.applies ? {
      experiment_id: experiment.document.experiment_id,
      channel_identity: experiment.document.channel_identity ?? null,
      channel_identity_verification: experiment.identityVerification ?? null,
      config_path: experiment.path,
      config_sha256: experiment.sha256,
      ordinal: experiment.validation.ordinal,
      eligible_upload_count: experiment.document.eligible_upload_count,
      final_duration_sec: experiment.durationSec,
      runtime: experiment.document.runtime,
      runtime_exception: inputs.spec.channel_experiment_runtime_exception ?? null,
      advertising: experiment.document.advertising,
      measurement: experiment.document.measurement,
    } : null,
    native_ab_test: abPlan ? {
      required: true,
      plan_path: abPlanPath,
      plan_sha256: sourceHashes[abPlanPath],
      test_type: abPlan.test_type,
      baseline_variant_id: abPlan.baseline_variant_id,
      variants: abPlan.variants,
    } : {
      required: false,
      reason: "No approved native A/B plan existed when the publish manifest was prepared.",
    },
    studio_handoff: {
      url: "https://studio.youtube.com/",
      upload_private_first: true,
      verify_active_channel_before_upload: true,
      public_or_scheduled_release_requires_operator_confirmation: true,
      pinned_comment_requires_separate_operator_confirmation: true,
      browser_skill: "youtube-studio-publish",
    },
  };
  await writeJson(manifestPath, manifest);
  console.log(JSON.stringify({
    status: "passed",
    manifest_path: manifestPath,
    video_path: videoPath,
    thumbnail_path: inputs.thumbnailPath,
    title: manifest.title,
    packaging_validation_warnings: validation.warnings,
    next_action: "Use the youtube-studio-publish skill to upload privately and record the verified result.",
  }, null, 2));
}

async function recordNativeAbTest() {
  const { episodeDir, episode } = await episodeContext();
  const planPath = path.join(episodeDir, `youtube_native_ab_plan_${episode}.json`);
  const uploadReceiptPath = path.join(episodeDir, `youtube_upload_receipt_${episode}.json`);
  const [plan, uploadReceipt, planSha256, uploadReceiptSha256] = await Promise.all([
    readJson(planPath),
    readJson(uploadReceiptPath),
    sha256File(planPath).catch(() => null),
    sha256File(uploadReceiptPath).catch(() => null),
  ]);
  if (!plan || plan.schema !== YOUTUBE_NATIVE_AB_PLAN_SCHEMA) throw new Error(`Approved native A/B plan required: ${planPath}`);
  if (!uploadReceipt || uploadReceipt.schema !== YOUTUBE_UPLOAD_RECEIPT_SCHEMA) throw new Error(`Passed upload receipt required: ${uploadReceiptPath}`);
  for (const name of ["studio-url", "configured-variant-ids", "recorded-by"]) requiredFlag(name, flags[name]);
  const receiptPath = path.join(episodeDir, `youtube_native_ab_receipt_${episode}.json`);
  const receipt = {
    schema: YOUTUBE_NATIVE_AB_RECEIPT_SCHEMA,
    status: "passed",
    episode,
    plan_path: planPath,
    plan_sha256: planSha256,
    upload_receipt_path: uploadReceiptPath,
    upload_receipt_sha256: uploadReceiptSha256,
    video_id: uploadReceipt.video_id,
    studio_url: clean(flags["studio-url"]),
    native_experiment_id: clean(flags["experiment-id"]) || null,
    experiment_state: clean(flags.state || "active").toLowerCase(),
    configured_variant_ids: clean(flags["configured-variant-ids"]).split(",").map(clean).filter(Boolean),
    field_verification: {
      active_channel: isTrue(flags["channel-verified"]),
      native_test: isTrue(flags["test-verified"]),
    },
    recorded_by: clean(flags["recorded-by"]),
    recorded_at: new Date().toISOString(),
    note: clean(flags.note) || null,
  };
  const validation = validateYoutubeNativeAbReceipt(receipt, {
    plan,
    planSha256,
    uploadReceipt,
    uploadReceiptSha256,
  });
  if (validation.status !== "passed") {
    console.log(JSON.stringify({ status: "blocked", blockers: validation.blockers }, null, 2));
    process.exitCode = 2;
    return;
  }
  await writeJsonExclusive(receiptPath, receipt);
  console.log(JSON.stringify({ status: "passed", receipt_path: receiptPath, video_id: receipt.video_id }, null, 2));
}

async function recordUpload() {
  const { episodeDir, episode } = await episodeContext();
  const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
  const manifest = await readJson(manifestPath);
  if (!manifest || manifest.schema !== YOUTUBE_PUBLISH_MANIFEST_SCHEMA || manifest.status !== "passed") {
    throw new Error(`Passed YouTube publish manifest required: ${manifestPath}`);
  }
  requiredFlag("video-id", flags["video-id"]);
  requiredFlag("watch-url", flags["watch-url"]);
  requiredFlag("visibility", flags.visibility);
  requiredFlag("recorded-by", flags["recorded-by"]);
  const visibility = clean(flags.visibility).toLowerCase();
  const nonPrivate = visibility !== "private";
  const receiptPath = path.join(episodeDir, `youtube_upload_receipt_${episode}.json`);
  const receipt = {
    schema: YOUTUBE_UPLOAD_RECEIPT_SCHEMA,
    status: "passed",
    episode,
    manifest_path: manifestPath,
    manifest_sha256: await sha256File(manifestPath),
    video_id: clean(flags["video-id"]),
    watch_url: clean(flags["watch-url"]),
    studio_url: clean(flags["studio-url"]) || null,
    initial_visibility: "private",
    visibility,
    schedule_at: clean(flags["schedule-at"]) || null,
    field_verification: {
      active_channel: isTrue(flags["channel-verified"]),
      initial_private: isTrue(flags["initial-private-verified"]),
      title: isTrue(flags["title-verified"]),
      description: isTrue(flags["description-verified"]),
      thumbnail: isTrue(flags["thumbnail-verified"]),
      audience: isTrue(flags["audience-verified"]),
      monetization: isTrue(flags["monetization-verified"]),
      mid_rolls: isTrue(flags["mid-rolls-verified"]),
      comments: isTrue(flags["comments-verified"]),
      checks_complete: isTrue(flags["checks-complete"]),
    },
    publish_approval: {
      required: nonPrivate,
      approved: nonPrivate ? isTrue(flags["publish-approved"]) : false,
      approved_by: nonPrivate ? clean(flags["publish-approved-by"]) || null : null,
      approved_at: nonPrivate && isTrue(flags["publish-approved"]) ? new Date().toISOString() : null,
    },
    channel_experiment: manifest.channel_experiment ? {
      experiment_id: manifest.channel_experiment.experiment_id,
      config_sha256: manifest.channel_experiment.config_sha256,
      ordinal: manifest.channel_experiment.ordinal,
      eligible_upload_count: manifest.channel_experiment.eligible_upload_count,
      runtime_exception: manifest.channel_experiment.runtime_exception ?? null,
    } : null,
    recorded_by: clean(flags["recorded-by"]),
    recorded_at: new Date().toISOString(),
    note: clean(flags.note) || null,
  };
  const validation = validateYoutubeUploadReceipt(receipt, {
    manifest,
    manifestHash: receipt.manifest_sha256,
  });
  if (validation.status !== "passed") {
    console.log(JSON.stringify({
      status: "blocked",
      receipt_path: null,
      video_id: receipt.video_id,
      visibility: receipt.visibility,
      blockers: validation.blockers,
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  receipt.blockers = [];
  await writeJson(receiptPath, receipt);
  const analyticsFollowup = await createAnalyticsFollowupPlanForUpload({
    episodeDir,
    episode,
    anchorAt: clean(flags["analytics-anchor-at"]) || null,
  });
  console.log(JSON.stringify({
    status: receipt.status,
    receipt_path: receiptPath,
    video_id: receipt.video_id,
    visibility: receipt.visibility,
    blockers: receipt.blockers,
    analytics_followup_plan_path: analyticsFollowup.planPath,
    analytics_followup_status: analyticsFollowup.plan.status,
  }, null, 2));
}

async function recordComment() {
  const { episodeDir, episode } = await episodeContext();
  const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
  const uploadReceiptPath = path.join(episodeDir, `youtube_upload_receipt_${episode}.json`);
  const [manifest, uploadReceipt] = await Promise.all([
    readJson(manifestPath),
    readJson(uploadReceiptPath),
  ]);
  if (!manifest || manifest.schema !== YOUTUBE_PUBLISH_MANIFEST_SCHEMA || manifest.status !== "passed") {
    throw new Error(`Passed YouTube publish manifest required: ${manifestPath}`);
  }
  if (!uploadReceipt || uploadReceipt.schema !== YOUTUBE_UPLOAD_RECEIPT_SCHEMA || uploadReceipt.status !== "passed") {
    throw new Error(`Passed YouTube upload receipt required: ${uploadReceiptPath}`);
  }
  requiredFlag("recorded-by", flags["recorded-by"]);
  if (!clean(flags["comment-id"]) && !clean(flags["comment-url"])) {
    throw new Error("Comment receipt requires --comment-id or --comment-url.");
  }
  const uploadReceiptHash = await sha256File(uploadReceiptPath);
  const receiptPath = path.join(episodeDir, `youtube_pinned_comment_receipt_${episode}.json`);
  const receipt = {
    schema: YOUTUBE_PINNED_COMMENT_RECEIPT_SCHEMA,
    status: "passed",
    episode,
    upload_receipt_path: uploadReceiptPath,
    upload_receipt_sha256: uploadReceiptHash,
    video_id: uploadReceipt.video_id,
    comment_id: clean(flags["comment-id"]) || null,
    comment_url: clean(flags["comment-url"]) || null,
    comment_text_sha256: isTrue(flags["text-verified"])
      ? youtubeTextSha256(manifest.pinned_comment?.text)
      : null,
    post_approval: {
      approved: isTrue(flags["post-approved"]),
      approved_by: clean(flags["post-approved-by"]) || null,
      approved_at: isTrue(flags["post-approved"]) ? new Date().toISOString() : null,
    },
    pinned: isTrue(flags["pinned-verified"]),
    recorded_by: clean(flags["recorded-by"]),
    recorded_at: new Date().toISOString(),
    note: clean(flags.note) || null,
  };
  const validation = validateYoutubePinnedCommentReceipt(receipt, {
    manifest,
    uploadReceipt,
    uploadReceiptHash,
  });
  if (validation.status !== "passed") {
    console.log(JSON.stringify({
      status: "blocked",
      receipt_path: null,
      video_id: receipt.video_id,
      pinned: receipt.pinned,
      blockers: validation.blockers,
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  receipt.blockers = [];
  await writeJson(receiptPath, receipt);
  console.log(JSON.stringify({
    status: receipt.status,
    receipt_path: receiptPath,
    video_id: receipt.video_id,
    pinned: receipt.pinned,
    blockers: receipt.blockers,
  }, null, 2));
}

async function thumbnailFileEvidence(filePath) {
  const [metadata, stat, sha256] = await Promise.all([
    sharp(filePath).metadata(),
    fs.stat(filePath),
    sha256File(filePath),
  ]);
  const format = clean(metadata.format).toLowerCase();
  const width = Number(metadata.width ?? 0);
  const height = Number(metadata.height ?? 0);
  if (!["png", "jpeg", "jpg"].includes(format)) {
    throw new Error(`Thumbnail must be PNG or JPEG: ${filePath}`);
  }
  if (width < 1280 || !(height > 0) || Math.abs(width / height - 16 / 9) > 0.03) {
    throw new Error(`Thumbnail must be at least 1280 px wide and 16:9: ${filePath}`);
  }
  if (!(stat.size > 0) || stat.size > 50 * 1024 * 1024) {
    throw new Error(`Thumbnail file size is invalid: ${filePath}`);
  }
  return { path: filePath, sha256, bytes: stat.size, width, height, format };
}

async function recordThumbnailUpdate() {
  const { episodeDir, episode } = await episodeContext();
  const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
  const uploadReceiptPath = path.join(episodeDir, `youtube_upload_receipt_${episode}.json`);
  const [manifest, uploadReceipt, manifestHash, uploadReceiptHash] = await Promise.all([
    readJson(manifestPath),
    readJson(uploadReceiptPath),
    sha256File(manifestPath).catch(() => null),
    sha256File(uploadReceiptPath).catch(() => null),
  ]);
  if (!manifest || manifest.schema !== YOUTUBE_PUBLISH_MANIFEST_SCHEMA || manifest.status !== "passed") {
    throw new Error(`Passed YouTube publish manifest required: ${manifestPath}`);
  }
  const uploadValidation = validateYoutubeUploadReceipt(uploadReceipt, { manifest, manifestHash });
  if (uploadValidation.status !== "passed") {
    throw new Error(`Passed YouTube upload receipt required: ${uploadValidation.blockers.join(", ")}`);
  }
  for (const name of [
    "video-id",
    "studio-url",
    "old-thumbnail",
    "new-thumbnail",
    "expected-channel",
    "verified-at",
    "operator",
  ]) requiredFlag(name, flags[name]);
  if (!isTrue(flags["channel-verified"])) throw new Error("Thumbnail update requires --channel-verified true.");
  if (!isTrue(flags["thumbnail-verified"])) throw new Error("Thumbnail update requires --thumbnail-verified true.");
  if (!isTrue(flags["schedule-preserved"])) throw new Error("Thumbnail update requires --schedule-preserved true.");

  const oldThumbnailPath = path.resolve(episodeDir, clean(flags["old-thumbnail"]));
  const newThumbnailPath = path.resolve(episodeDir, clean(flags["new-thumbnail"]));
  if (!(await exists(oldThumbnailPath))) throw new Error(`Old thumbnail missing: ${oldThumbnailPath}`);
  if (!(await exists(newThumbnailPath))) throw new Error(`New thumbnail missing: ${newThumbnailPath}`);
  const [oldThumbnail, newThumbnail, effective, receiptFiles] = await Promise.all([
    thumbnailFileEvidence(oldThumbnailPath),
    thumbnailFileEvidence(newThumbnailPath),
    youtubeEffectiveThumbnailState(episodeDir, episode, { manifest, uploadReceipt, uploadReceiptHash }),
    listYoutubeThumbnailUpdateReceipts(episodeDir, episode),
  ]);
  if (effective.status !== "passed") {
    throw new Error(`Existing thumbnail update chain is invalid: ${effective.blockers.join(", ")}`);
  }
  if (path.resolve(effective.path) !== oldThumbnail.path || effective.sha256 !== oldThumbnail.sha256) {
    throw new Error("--old-thumbnail does not match the current effective uploaded thumbnail.");
  }
  const sequence = receiptFiles.length + 1;
  const priorReceiptPath = sequence > 1 ? receiptFiles.at(-1)?.path ?? null : null;
  const receiptPath = path.join(
    episodeDir,
    `youtube_thumbnail_update_receipt_${episode}_${String(sequence).padStart(2, "0")}.json`,
  );
  if (await exists(receiptPath)) throw new Error(`Thumbnail update receipt already exists: ${receiptPath}`);
  const receipt = {
    schema: YOUTUBE_THUMBNAIL_UPDATE_RECEIPT_SCHEMA,
    status: "passed",
    episode,
    sequence,
    upload_receipt_path: uploadReceiptPath,
    upload_receipt_sha256: uploadReceiptHash,
    prior_update_receipt_path: priorReceiptPath,
    prior_update_receipt_sha256: priorReceiptPath ? await sha256File(priorReceiptPath) : null,
    video_id: clean(flags["video-id"]),
    studio_url: clean(flags["studio-url"]),
    expected_channel: clean(flags["expected-channel"]),
    schedule_preserved: true,
    schedule_at: clean(uploadReceipt.schedule_at) || null,
    field_verification: {
      active_channel: true,
      thumbnail: true,
    },
    old_thumbnail: oldThumbnail,
    new_thumbnail: newThumbnail,
    verified_at: clean(flags["verified-at"]),
    operator: clean(flags.operator),
    recorded_at: new Date().toISOString(),
    note: clean(flags.note) || null,
  };
  const validation = validateYoutubeThumbnailUpdateReceipt(receipt, {
    manifest,
    uploadReceipt,
    uploadReceiptHash,
    currentThumbnail: effective,
    priorReceiptHash: receipt.prior_update_receipt_sha256,
    newThumbnailSha256: newThumbnail.sha256,
  });
  if (validation.status !== "passed") {
    console.log(JSON.stringify({ status: "blocked", receipt_path: null, blockers: validation.blockers }, null, 2));
    process.exitCode = 2;
    return;
  }
  receipt.blockers = [];
  await writeJsonExclusive(receiptPath, receipt);
  console.log(JSON.stringify({
    status: "passed",
    receipt_path: receiptPath,
    sequence,
    video_id: receipt.video_id,
    old_thumbnail_sha256: oldThumbnail.sha256,
    new_thumbnail_sha256: newThumbnail.sha256,
  }, null, 2));
}

async function main() {
  if (action === "approve-packaging") return approvePackaging();
  if (action === "approve-ab-test") return approveNativeAbTest();
  if (action === "prepare") return prepareManifest();
  if (action === "record-upload") return recordUpload();
  if (action === "record-ab-test") return recordNativeAbTest();
  if (action === "record-thumbnail-update") return recordThumbnailUpdate();
  if (action === "record-comment") return recordComment();
  throw new Error(`Unknown YouTube publishing action: ${action || "missing"}.`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  approvePackaging as approveYoutubePackagingForTests,
  prepareManifest as prepareYoutubeManifestForTests,
};
