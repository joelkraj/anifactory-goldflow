import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { sha256File } from "./file-hash.mjs";
import {
  validateYoutubeNativeAbPlan,
  validateYoutubeNativeAbReceipt,
} from "./youtube-ab-test-contract.mjs";

export const YOUTUBE_PUBLISH_CONTRACT_VERSION = "2026-07-29.3";
export const YOUTUBE_PACKAGING_SPEC_SCHEMA = "goldflow_youtube_packaging_spec_v2";
export const LEGACY_YOUTUBE_PACKAGING_SPEC_SCHEMA = "goldflow_youtube_packaging_spec_v1";
export const YOUTUBE_PUBLISH_MANIFEST_SCHEMA = "goldflow_youtube_publish_manifest_v1";
export const YOUTUBE_UPLOAD_RECEIPT_SCHEMA = "goldflow_youtube_upload_receipt_v1";
export const YOUTUBE_PINNED_COMMENT_RECEIPT_SCHEMA = "goldflow_youtube_pinned_comment_receipt_v1";

export const YOUTUBE_THUMBNAIL_GENERATION_CONTRACT = Object.freeze({
  provider: "google_flow_imagen",
  allowed_providers: Object.freeze([
    "google_flow_imagen",
    "google_gemini_imagen",
    "chatgpt_web_gpt_image",
    "codex_imagegen",
  ]),
  fallback_provider: "chatgpt_web_gpt_image",
  generation_mode: "full_raster_from_scratch",
  reference_count: 0,
  text_rendered_by_model: true,
  locally_composited_text: false,
  locally_composited_arrows: false,
});

export const LEGACY_YOUTUBE_PACKAGING_ADAPTER_WARNING =
  "legacy_packaging_spec_v1_thumbnail_generation_provenance_unverified";
export const YOUTUBE_THUMBNAIL_UPDATE_RECEIPT_SCHEMA = "goldflow_youtube_thumbnail_update_receipt_v1";

const TITLE_MAX_CHARS = 100;
const DESCRIPTION_MAX_CHARS = 5000;
const TAGS_MAX_CHARS = 500;
const THUMBNAIL_MAX_BYTES = 50 * 1024 * 1024;
const THUMBNAIL_MIN_WIDTH = 1280;
const THUMBNAIL_ASPECT = 16 / 9;
const THUMBNAIL_ASPECT_TOLERANCE = 0.03;
const THUMBNAIL_MAX_SUBJECTS = 3;
const THUMBNAIL_MAX_ARROWS = 2;
const THUMBNAIL_MAX_LABELS = 2;
const THUMBNAIL_MAX_MAIN_TEXT_WORDS = 4;
const THUMBNAIL_MAX_LABEL_WORDS = 3;
const THUMBNAIL_MAX_TOTAL_OVERLAY_WORDS = 8;
const PINNED_COMMENT_MAX_CHARS = 500;
const RECENT_RESEARCH_MAX_AGE_DAYS = 120;
const REQUIRED_UPLOAD_FIELD_VERIFICATIONS = Object.freeze([
  "active_channel",
  "initial_private",
  "title",
  "description",
  "thumbnail",
  "audience",
  "monetization",
  "comments",
  "checks_complete",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function truthy(value) {
  return value === true || /^(true|1|yes)$/i.test(clean(value));
}

function words(value) {
  return clean(value).match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) ?? [];
}

function hashText(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function youtubeTextSha256(value) {
  return hashText(value);
}

export function youtubeFinalQaDurationSeconds(finalQa) {
  const values = [finalQa?.media_probe?.duration_sec, finalQa?.media_probe?.format?.duration, finalQa?.final_duration_sec];
  return values.map(Number).find(value => Number.isFinite(value) && value > 0) ?? NaN;
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map(clean).filter(Boolean))];
}

function push(blockers, condition, code) {
  if (condition) blockers.push(code);
}

function daysBetween(later, earlier) {
  return (later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000);
}

function resolveEpisodeArtifact(episodeDir, artifactPath) {
  const value = clean(artifactPath);
  return value ? path.resolve(episodeDir, value) : null;
}

export function youtubePublishingRequired(identity = {}) {
  const actual = clean(identity.stage_registry_version).match(/^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/);
  const required = YOUTUBE_PUBLISH_CONTRACT_VERSION.match(/^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/);
  if (!actual || !required) return false;
  for (let index = 1; index <= 4; index += 1) {
    const difference = Number(actual[index]) - Number(required[index]);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function extractMarkdownSection(markdown, heading) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const expected = `## ${clean(heading)}`.toLowerCase();
  const start = lines.findIndex((line) => clean(line).toLowerCase() === expected);
  if (start < 0) return "";
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break;
    body.push(lines[index]);
  }
  return clean(body.join("\n"));
}

export function selectedTitleCandidate(spec) {
  const selected = clean(spec?.selected_title);
  return (spec?.title_candidates ?? []).find((candidate) => clean(candidate?.title) === selected) ?? null;
}

export function selectedThumbnailCandidate(spec) {
  const selectedId = clean(spec?.selected_thumbnail_candidate_id);
  return (spec?.thumbnail_candidates ?? []).find((candidate) => clean(candidate?.id) === selectedId) ?? null;
}

export function adaptLegacyYoutubePackagingSpec(spec) {
  const eligible = spec?.schema === LEGACY_YOUTUBE_PACKAGING_SPEC_SCHEMA
    && clean(spec?.status) === "approved"
    && Boolean(clean(spec?.approved_by))
    && Boolean(clean(spec?.approved_at));
  if (!eligible) return null;
  return {
    spec,
    mode: "legacy_adapter_v1",
    warnings: [LEGACY_YOUTUBE_PACKAGING_ADAPTER_WARNING],
  };
}

function validateResearchEvidence(spec, blockers, options = {}) {
  const evidence = Array.isArray(spec?.research_evidence) ? spec.research_evidence : [];
  const evidenceIds = evidence.map((row) => clean(row?.id)).filter(Boolean);
  const referenceTime = options.now ?? spec?.approved_at ?? Date.now();
  const now = referenceTime instanceof Date ? referenceTime : new Date(referenceTime);
  push(blockers, evidence.length < 3, "packaging_research_needs_at_least_three_examples");
  push(blockers, evidenceIds.length !== new Set(evidenceIds).size, "packaging_research_ids_not_unique");
  push(blockers, !evidence.some((row) => clean(row?.source_type) === "own_channel"), "packaging_research_missing_own_channel_outlier");
  push(blockers, !evidence.some((row) => clean(row?.source_type) === "niche_outlier"), "packaging_research_missing_recent_niche_outlier");
  for (const [index, row] of evidence.entries()) {
    const sourceType = clean(row?.source_type);
    const observedAt = new Date(row?.observed_at);
    push(blockers, !clean(row?.id), `packaging_research_${index}_id_missing`);
    push(blockers, !["own_channel", "niche_outlier"].includes(sourceType), `packaging_research_${index}_source_type_invalid`);
    push(blockers, !clean(row?.title), `packaging_research_${index}_title_missing`);
    push(blockers, !clean(row?.source_ref), `packaging_research_${index}_source_ref_missing`);
    push(blockers, Number.isNaN(observedAt.getTime()), `packaging_research_${index}_observed_at_invalid`);
    push(blockers, !clean(row?.lesson), `packaging_research_${index}_lesson_missing`);
    if (sourceType === "niche_outlier" && !Number.isNaN(observedAt.getTime())) {
      const ageDays = daysBetween(now, observedAt);
      push(blockers, ageDays < -1 || ageDays > RECENT_RESEARCH_MAX_AGE_DAYS, `packaging_research_${index}_niche_evidence_not_recent`);
    }
    const metrics = row?.metrics ?? {};
    const hasMetric = ["views", "vph", "ctr_percent", "average_view_duration_sec", "breakout_score"]
      .some((key) => Number.isFinite(Number(metrics[key])) && Number(metrics[key]) >= 0);
    push(blockers, !hasMetric, `packaging_research_${index}_performance_metric_missing`);
  }
}

function validateEvidenceLinks(rows, validEvidenceIds, prefix, blockers) {
  for (const [index, row] of rows.entries()) {
    const ids = uniqueStrings(row?.research_evidence_ids);
    push(blockers, ids.length < 1, `${prefix}_${index}_research_link_missing`);
    push(blockers, ids.some((id) => !validEvidenceIds.has(id)), `${prefix}_${index}_research_link_unknown`);
  }
}

function validateTitle(spec, blockers, validEvidenceIds) {
  const title = clean(spec?.selected_title);
  const candidates = Array.isArray(spec?.title_candidates) ? spec.title_candidates : [];
  const candidateTitles = candidates.map((candidate) => clean(candidate?.title));
  push(blockers, candidates.length < 3 || candidates.length > 5, "title_candidates_must_number_three_to_five");
  push(blockers, candidateTitles.filter(Boolean).length !== new Set(candidateTitles.filter(Boolean)).size, "title_candidates_not_unique");
  push(blockers, !title, "selected_title_missing");
  push(blockers, title.length > TITLE_MAX_CHARS, "selected_title_exceeds_youtube_limit");
  push(blockers, title.length < 35, "selected_title_too_vague");
  const selected = selectedTitleCandidate(spec);
  push(blockers, !selected, "selected_title_not_found_in_candidates");
  for (const [index, candidate] of candidates.entries()) {
    const candidateTitle = clean(candidate?.title);
    const betrayalPhrase = clean(candidate?.betrayal_phrase);
    const revengePhrase = clean(candidate?.revenge_phrase);
    push(blockers, !candidateTitle, `title_candidate_${index}_missing`);
    push(blockers, candidateTitle.length > TITLE_MAX_CHARS, `title_candidate_${index}_exceeds_youtube_limit`);
    push(blockers, !betrayalPhrase || !lower(candidateTitle).includes(lower(betrayalPhrase)), `title_candidate_${index}_betrayal_clause_not_in_title`);
    push(blockers, !revengePhrase || !lower(candidateTitle).includes(lower(revengePhrase)), `title_candidate_${index}_revenge_clause_not_in_title`);
    push(blockers, !truthy(candidate?.explains_full_video), `title_candidate_${index}_does_not_assert_full_video`);
  }
  validateEvidenceLinks(candidates, validEvidenceIds, "title_candidate", blockers);
  if (selected) {
    push(blockers, !truthy(selected?.explains_full_video), "selected_title_does_not_explain_full_video");
    push(blockers, !clean(selected?.selection_reason), "selected_title_reason_missing");
  }
}

function validateThumbnail(spec, blockers, validEvidenceIds, options = {}) {
  const candidates = Array.isArray(spec?.thumbnail_candidates) ? spec.thumbnail_candidates : [];
  const candidateIds = candidates.map((candidate) => clean(candidate?.id)).filter(Boolean);
  push(blockers, candidates.length < 2 || candidates.length > 3, "thumbnail_candidates_must_number_two_or_three");
  push(blockers, candidateIds.length !== new Set(candidateIds).size, "thumbnail_candidate_ids_not_unique");
  const selected = selectedThumbnailCandidate(spec);
  push(blockers, !selected, "selected_thumbnail_candidate_missing");
  push(blockers, !clean(spec?.thumbnail_final_path), "thumbnail_final_path_missing");
  for (const [index, candidate] of candidates.entries()) {
    const subjects = Array.isArray(candidate?.subjects) ? candidate.subjects : [];
    const labels = Array.isArray(candidate?.labels) ? candidate.labels : [];
    const arrows = Array.isArray(candidate?.arrows) ? candidate.arrows : [];
    const mainTextWords = words(candidate?.main_text).length;
    const labelWordCounts = labels.map((label) => words(label?.text).length);
    const overlayWords = mainTextWords + labelWordCounts.reduce((sum, count) => sum + count, 0);
    push(blockers, !clean(candidate?.id), `thumbnail_candidate_${index}_id_missing`);
    push(blockers, subjects.length < 1 || subjects.length > THUMBNAIL_MAX_SUBJECTS, `thumbnail_candidate_${index}_subject_count_out_of_range`);
    push(blockers, !subjects.every((subject) => clean(subject?.role) && clean(subject?.emotion)), `thumbnail_candidate_${index}_subject_definition_incomplete`);
    push(blockers, mainTextWords < 1 || mainTextWords > THUMBNAIL_MAX_MAIN_TEXT_WORDS, `thumbnail_candidate_${index}_main_text_word_count`);
    push(blockers, labels.length > THUMBNAIL_MAX_LABELS, `thumbnail_candidate_${index}_too_many_labels`);
    push(blockers, labelWordCounts.some((count) => count < 1 || count > THUMBNAIL_MAX_LABEL_WORDS), `thumbnail_candidate_${index}_label_too_long`);
    push(blockers, arrows.length > THUMBNAIL_MAX_ARROWS, `thumbnail_candidate_${index}_too_many_arrows`);
    push(blockers, arrows.some((arrow) => !clean(arrow?.purpose)), `thumbnail_candidate_${index}_arrow_without_purpose`);
    push(blockers, overlayWords > THUMBNAIL_MAX_TOTAL_OVERLAY_WORDS, `thumbnail_candidate_${index}_overlay_too_wordy`);
    push(blockers, !clean(candidate?.betrayal_signal), `thumbnail_candidate_${index}_betrayal_signal_missing`);
    push(blockers, !clean(candidate?.revenge_signal), `thumbnail_candidate_${index}_revenge_signal_missing`);
    push(blockers, !truthy(candidate?.single_scene), `thumbnail_candidate_${index}_must_use_one_scene`);
    push(blockers, !truthy(candidate?.no_collage), `thumbnail_candidate_${index}_must_reject_collage`);
    push(blockers, !truthy(candidate?.simple_read_order), `thumbnail_candidate_${index}_simple_read_order_missing`);
  }
  validateEvidenceLinks(candidates, validEvidenceIds, "thumbnail_candidate", blockers);
  if (selected) {
    push(blockers, !truthy(selected?.mobile_reviewed), "selected_thumbnail_not_mobile_reviewed");
    push(blockers, !clean(selected?.selection_reason), "selected_thumbnail_reason_missing");
    if (options.enforceGenerationContract !== false) {
      push(
        blockers,
        !YOUTUBE_THUMBNAIL_GENERATION_CONTRACT.allowed_providers.includes(clean(selected?.provider)),
        "selected_thumbnail_provider_must_be_approved_imagen_route",
      );
      push(
        blockers,
        clean(selected?.generation_mode) !== YOUTUBE_THUMBNAIL_GENERATION_CONTRACT.generation_mode,
        "selected_thumbnail_generation_mode_must_be_full_raster_from_scratch",
      );
      push(
        blockers,
        selected?.reference_count !== YOUTUBE_THUMBNAIL_GENERATION_CONTRACT.reference_count,
        "selected_thumbnail_reference_count_must_be_zero",
      );
      push(
        blockers,
        selected?.text_rendered_by_model !== YOUTUBE_THUMBNAIL_GENERATION_CONTRACT.text_rendered_by_model,
        "selected_thumbnail_text_must_be_rendered_by_model",
      );
      push(
        blockers,
        selected?.locally_composited_text !== YOUTUBE_THUMBNAIL_GENERATION_CONTRACT.locally_composited_text,
        "selected_thumbnail_local_text_compositing_forbidden",
      );
      push(
        blockers,
        selected?.locally_composited_arrows !== YOUTUBE_THUMBNAIL_GENERATION_CONTRACT.locally_composited_arrows,
        "selected_thumbnail_local_arrow_compositing_forbidden",
      );
    }
  }
}

function validateDescriptionAndComment(spec, blockers) {
  const description = clean(spec?.description);
  const firstLines = description.slice(0, 350).toLowerCase();
  const keywords = uniqueStrings(spec?.description_contract?.primary_keywords);
  push(blockers, !description, "description_missing");
  push(blockers, description.length > DESCRIPTION_MAX_CHARS, "description_exceeds_youtube_limit");
  push(blockers, keywords.length < 1 || keywords.length > 2, "description_primary_keywords_must_number_one_or_two");
  push(blockers, keywords.some((keyword) => !firstLines.includes(keyword.toLowerCase())), "description_keyword_missing_from_opening");
  push(blockers, !truthy(spec?.description_contract?.opening_explains_betrayal_and_revenge), "description_opening_does_not_assert_betrayal_and_revenge");
  const tags = uniqueStrings(spec?.tags);
  push(blockers, tags.join(", ").length > TAGS_MAX_CHARS, "tags_exceed_youtube_limit");

  const comment = clean(spec?.pinned_comment?.text);
  const questionMarks = (comment.match(/\?/g) ?? []).length;
  push(blockers, !comment, "pinned_comment_missing");
  push(blockers, comment.length > PINNED_COMMENT_MAX_CHARS, "pinned_comment_too_long");
  push(blockers, questionMarks < 1, "pinned_comment_needs_one_clear_dilemma");
  push(blockers, !clean(spec?.pinned_comment?.betrayal_choice), "pinned_comment_betrayal_choice_missing");
}

function validatePublishSettings(spec, blockers) {
  const channel = spec?.youtube_channel ?? {};
  const settings = spec?.publish_settings ?? {};
  const midRollMode = clean(settings.mid_roll_mode);
  const manualMidRollCount = Number(settings.manual_mid_roll_count);
  const manualMidRollPositions = Array.isArray(settings.manual_mid_roll_positions_sec)
    ? settings.manual_mid_roll_positions_sec.map(Number)
    : [];
  push(blockers, !clean(channel.expected_name) && !clean(channel.expected_handle), "youtube_expected_channel_missing");
  push(blockers, clean(settings.initial_visibility) !== "private", "youtube_upload_must_start_private");
  push(blockers, !["operator_decides", "public", "unlisted", "private", "scheduled"].includes(clean(settings.desired_visibility)), "youtube_desired_visibility_invalid");
  push(blockers, clean(settings.desired_visibility) === "scheduled" && !clean(settings.schedule_at), "youtube_schedule_time_missing");
  push(blockers, !["on", "off"].includes(clean(settings.monetization)), "youtube_monetization_setting_missing");
  push(blockers, clean(settings.monetization) === "on" && !["automatic", "manual", "off"].includes(midRollMode), "youtube_mid_roll_mode_missing");
  if (clean(settings.monetization) === "on" && midRollMode === "manual") {
    push(blockers, settings.automatic_mid_rolls !== false, "youtube_manual_mid_rolls_require_automatic_off");
    push(blockers, !Number.isInteger(manualMidRollCount) || manualMidRollCount < 1, "youtube_manual_mid_roll_count_invalid");
    push(blockers, manualMidRollPositions.length !== manualMidRollCount, "youtube_manual_mid_roll_positions_count_mismatch");
    push(blockers, manualMidRollPositions.some((value) => !Number.isFinite(value) || value <= 0), "youtube_manual_mid_roll_position_invalid");
    push(
      blockers,
      manualMidRollPositions.some((value, index) => index > 0 && value <= manualMidRollPositions[index - 1]),
      "youtube_manual_mid_roll_positions_not_strictly_ascending",
    );
  }
  if (clean(settings.experiment_id) === "manhwa_joey_75min_manual_midroll_v1") {
    push(blockers, midRollMode !== "manual", "youtube_manhwa_joey_ad_test_requires_manual_mid_rolls");
    push(blockers, settings.automatic_mid_rolls !== false, "youtube_manhwa_joey_ad_test_requires_automatic_mid_rolls_off");
    push(blockers, manualMidRollCount !== 3, "youtube_manhwa_joey_ad_test_requires_three_mid_rolls");
    push(blockers, manualMidRollPositions.length !== 3, "youtube_manhwa_joey_ad_test_requires_three_positions");
  }
  push(blockers, typeof settings.made_for_kids !== "boolean", "youtube_audience_setting_missing");
  push(blockers, typeof settings.age_restricted !== "boolean", "youtube_age_restriction_setting_missing");
  push(blockers, typeof settings.altered_content !== "boolean", "youtube_altered_content_setting_missing");
  push(blockers, !["on", "off"].includes(clean(settings.comments)), "youtube_comment_setting_missing");
}

export function validateYoutubePackagingSpec(spec, options = {}) {
  const blockers = [];
  const warnings = [];
  const requireApproval = options.requireApproval !== false;
  let schemaMode = null;
  if (spec?.schema === YOUTUBE_PACKAGING_SPEC_SCHEMA) {
    schemaMode = "current";
  } else if (spec?.schema === LEGACY_YOUTUBE_PACKAGING_SPEC_SCHEMA) {
    const adapter = options.allowLegacyAdapter === true ? adaptLegacyYoutubePackagingSpec(spec) : null;
    if (adapter) {
      schemaMode = adapter.mode;
      warnings.push(...adapter.warnings);
    } else {
      push(blockers, true, "packaging_spec_legacy_schema_requires_explicit_adapter");
    }
  } else {
    push(blockers, true, "packaging_spec_schema_invalid");
  }
  if (requireApproval) {
    push(blockers, clean(spec?.status) !== "approved", "packaging_spec_not_approved");
    push(blockers, !clean(spec?.approved_by), "packaging_spec_approver_missing");
    push(blockers, !clean(spec?.approved_at), "packaging_spec_approval_time_missing");
  }
  push(blockers, !clean(spec?.episode), "packaging_spec_episode_missing");
  validateResearchEvidence(spec, blockers, options);
  const validEvidenceIds = new Set((spec?.research_evidence ?? []).map((row) => clean(row?.id)).filter(Boolean));
  validateTitle(spec, blockers, validEvidenceIds);
  validateThumbnail(spec, blockers, validEvidenceIds, {
    enforceGenerationContract: schemaMode !== "legacy_adapter_v1",
  });
  validateDescriptionAndComment(spec, blockers);
  validatePublishSettings(spec, blockers);

  if (options.markdown != null) {
    const markdownTitle = extractMarkdownSection(options.markdown, "Recommended Title").split("\n")[0]?.trim();
    const markdownDescription = extractMarkdownSection(options.markdown, "Full Description");
    const markdownComment = extractMarkdownSection(options.markdown, "Pinned Comment");
    push(blockers, markdownTitle !== clean(spec?.selected_title), "markdown_title_does_not_match_spec");
    push(blockers, markdownDescription !== clean(spec?.description), "markdown_description_does_not_match_spec");
    push(blockers, markdownComment !== clean(spec?.pinned_comment?.text), "markdown_pinned_comment_does_not_match_spec");
  }

  const metadata = options.thumbnailMetadata;
  if (metadata) {
    const width = Number(metadata.width ?? 0);
    const height = Number(metadata.height ?? 0);
    const format = lower(metadata.format);
    const bytes = Number(options.thumbnailBytes ?? 0);
    push(blockers, !["png", "jpeg", "jpg"].includes(format), "thumbnail_format_not_supported");
    push(blockers, width < THUMBNAIL_MIN_WIDTH, "thumbnail_width_below_minimum");
    push(blockers, !(height > 0) || Math.abs(width / height - THUMBNAIL_ASPECT) > THUMBNAIL_ASPECT_TOLERANCE, "thumbnail_not_sixteen_by_nine");
    push(blockers, !(bytes > 0) || bytes > THUMBNAIL_MAX_BYTES, "thumbnail_file_size_invalid");
  }

  return {
    status: blockers.length ? "blocked" : "passed",
    blockers: uniqueStrings(blockers),
    warnings: uniqueStrings(warnings),
    schema_mode: schemaMode,
    legacy_adapter_applied: schemaMode === "legacy_adapter_v1",
    selected_title_candidate: selectedTitleCandidate(spec),
    selected_thumbnail_candidate: selectedThumbnailCandidate(spec),
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false);
}

async function thumbnailEvidence(filePath) {
  const [metadata, stat] = await Promise.all([
    sharp(filePath).metadata(),
    fs.stat(filePath),
  ]);
  return {
    metadata: {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    },
    bytes: stat.size,
  };
}

async function sourceHashesCurrent(sourceHashes) {
  const stale = [];
  const checked = [];
  for (const [sourcePath, expected] of Object.entries(sourceHashes ?? {})) {
    const current = await sha256File(sourcePath).catch(() => null);
    checked.push({ path: sourcePath, expected_sha256: expected, current_sha256: current });
    if (!current || current !== expected) stale.push(sourcePath);
  }
  return { checked, stale };
}

export async function youtubeUploadPackagingComplete(episodeDir, episode) {
  const packagePath = path.join(episodeDir, `upload_packaging_${episode}.md`);
  const specPath = path.join(episodeDir, `youtube_packaging_spec_${episode}.json`);
  if (!(await exists(packagePath)) || !(await exists(specPath))) {
    return { done: false, evidence: `upload_packaging_${episode}.md + youtube_packaging_spec_${episode}.json required` };
  }
  const [markdown, spec] = await Promise.all([
    fs.readFile(packagePath, "utf8"),
    readJson(specPath),
  ]);
  if (!spec) return { done: false, state: "blocked", evidence: `youtube_packaging_spec_${episode}.json invalid` };
  const thumbnailPath = resolveEpisodeArtifact(episodeDir, spec.thumbnail_final_path);
  if (!(await exists(thumbnailPath))) {
    return { done: false, evidence: `final thumbnail missing: ${thumbnailPath}` };
  }
  let evidence;
  try {
    evidence = await thumbnailEvidence(thumbnailPath);
  } catch {
    return { done: false, state: "blocked", evidence: `final thumbnail unreadable: ${thumbnailPath}` };
  }
  const validation = validateYoutubePackagingSpec(spec, {
    markdown,
    thumbnailMetadata: evidence.metadata,
    thumbnailBytes: evidence.bytes,
    allowLegacyAdapter: true,
  });
  if (validation.status === "passed") {
    const warningEvidence = validation.warnings.length
      ? `; warnings: ${validation.warnings.join(", ")}`
      : "";
    return {
      done: true,
      evidence: `upload package + approved CTR spec + ${path.basename(thumbnailPath)}${warningEvidence}`,
      warnings: validation.warnings,
      legacy_adapter_applied: validation.legacy_adapter_applied,
    };
  }
  const approvalBlockers = new Set([
    "packaging_spec_not_approved",
    "packaging_spec_approver_missing",
    "packaging_spec_approval_time_missing",
  ]);
  const onlyApprovalMissing = validation.blockers.every((blocker) => approvalBlockers.has(blocker));
  return {
    done: false,
    ...(onlyApprovalMissing ? {} : { state: "blocked" }),
    evidence: validation.blockers.join(", "),
  };
}

export async function youtubePublishManifestComplete(episodeDir, episode) {
  const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
  const manifest = await readJson(manifestPath);
  if (!manifest) return { done: false, evidence: `youtube_publish_manifest_${episode}.json missing` };
  if (manifest.schema !== YOUTUBE_PUBLISH_MANIFEST_SCHEMA || clean(manifest.status) !== "passed") {
    return { done: false, state: "blocked", evidence: `youtube publish manifest status=${clean(manifest.status) || "invalid"}` };
  }
  const sourceValidation = await sourceHashesCurrent(manifest.source_hashes);
  if (!sourceValidation.checked.length || sourceValidation.stale.length) {
    return { done: false, state: "stale", evidence: `youtube publish manifest stale: ${sourceValidation.stale.join(", ") || "source hashes missing"}` };
  }
  return { done: true, evidence: `youtube_publish_manifest_${episode}.json source hashes current` };
}

export function validateYoutubeUploadReceipt(receipt, options = {}) {
  const blockers = [];
  const manifest = options.manifest ?? null;
  const manifestHash = options.manifestHash ?? null;
  const visibility = clean(receipt?.visibility);
  const watchUrl = clean(receipt?.watch_url);
  const videoId = clean(receipt?.video_id);
  const verification = receipt?.field_verification ?? {};
  const requiredVerifications = [...REQUIRED_UPLOAD_FIELD_VERIFICATIONS];
  if (clean(manifest?.publish_settings?.mid_roll_mode) === "manual") requiredVerifications.push("mid_rolls");
  push(blockers, receipt?.schema !== YOUTUBE_UPLOAD_RECEIPT_SCHEMA, "youtube_upload_receipt_schema_invalid");
  push(blockers, clean(receipt?.status) !== "passed", "youtube_upload_receipt_not_passed");
  push(blockers, !manifest || receipt?.manifest_sha256 !== manifestHash, "youtube_upload_receipt_manifest_hash_stale");
  push(blockers, !videoId, "youtube_upload_receipt_video_id_missing");
  push(blockers, !/^https:\/\/(www\.)?youtube\.com\/watch\?v=/.test(watchUrl) && !/^https:\/\/youtu\.be\//.test(watchUrl), "youtube_upload_receipt_watch_url_invalid");
  push(blockers, videoId && !watchUrl.includes(videoId), "youtube_upload_receipt_url_video_id_mismatch");
  push(blockers, clean(receipt?.initial_visibility) !== "private", "youtube_upload_receipt_did_not_start_private");
  push(blockers, !["private", "unlisted", "public", "scheduled"].includes(visibility), "youtube_upload_receipt_visibility_invalid");
  push(blockers, visibility === "scheduled" && !clean(receipt?.schedule_at), "youtube_upload_receipt_schedule_time_missing");
  push(blockers, visibility !== "private" && receipt?.publish_approval?.approved !== true, "youtube_upload_receipt_publish_approval_missing");
  push(blockers, visibility !== "private" && !clean(receipt?.publish_approval?.approved_by), "youtube_upload_receipt_publish_approver_missing");
  push(blockers, !clean(receipt?.recorded_by), "youtube_upload_receipt_recorder_missing");
  push(blockers, !clean(receipt?.recorded_at), "youtube_upload_receipt_time_missing");
  if (manifest?.channel_experiment) {
    push(
      blockers,
      clean(receipt?.channel_experiment?.experiment_id) !== clean(manifest.channel_experiment.experiment_id),
      "youtube_upload_receipt_channel_experiment_id_mismatch",
    );
    push(
      blockers,
      clean(receipt?.channel_experiment?.config_sha256) !== clean(manifest.channel_experiment.config_sha256),
      "youtube_upload_receipt_channel_experiment_config_mismatch",
    );
    push(
      blockers,
      Number(receipt?.channel_experiment?.ordinal) !== Number(manifest.channel_experiment.ordinal),
      "youtube_upload_receipt_channel_experiment_ordinal_mismatch",
    );
  }
  push(
    blockers,
    requiredVerifications.some((field) => verification[field] !== true),
    "youtube_upload_receipt_fields_not_all_verified",
  );
  return { status: blockers.length ? "blocked" : "passed", blockers: uniqueStrings(blockers) };
}

export async function youtubeUploadReceiptComplete(episodeDir, episode) {
  const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
  const receiptPath = path.join(episodeDir, `youtube_upload_receipt_${episode}.json`);
  const [manifest, receipt, manifestHash] = await Promise.all([
    readJson(manifestPath),
    readJson(receiptPath),
    sha256File(manifestPath).catch(() => null),
  ]);
  if (!receipt) return { done: false, evidence: `youtube_upload_receipt_${episode}.json missing` };
  const validation = validateYoutubeUploadReceipt(receipt, { manifest, manifestHash });
  if (validation.status !== "passed") {
    return { done: false, state: "blocked", evidence: validation.blockers.join(", ") };
  }
  let nativeAbEvidence = "";
  if (manifest?.native_ab_test?.required === true) {
    const planPath = manifest.native_ab_test.plan_path
      ?? path.join(episodeDir, `youtube_native_ab_plan_${episode}.json`);
    const abReceiptPath = path.join(episodeDir, `youtube_native_ab_receipt_${episode}.json`);
    const [plan, abReceipt, planFileSha256, uploadReceiptSha256] = await Promise.all([
      readJson(planPath),
      readJson(abReceiptPath),
      sha256File(planPath).catch(() => null),
      sha256File(receiptPath).catch(() => null),
    ]);
    const planValidation = validateYoutubeNativeAbPlan(plan, {
      packagingSpecSha256: manifest.packaging_spec_sha256,
      baselineTitle: manifest.title,
      baselineThumbnailSha256: manifest.thumbnail?.sha256,
    });
    if (planValidation.status !== "passed") {
      return { done: false, state: "blocked", evidence: `native A/B plan invalid: ${planValidation.blockers.join(", ")}` };
    }
    const abValidation = validateYoutubeNativeAbReceipt(abReceipt, {
      plan,
      planSha256: planFileSha256,
      uploadReceipt: receipt,
      uploadReceiptSha256,
    });
    if (abValidation.status !== "passed") {
      const onlyMissing = !abReceipt;
      return {
        done: false,
        ...(onlyMissing ? {} : { state: "blocked" }),
        evidence: onlyMissing
          ? `approved native A/B test still needs Studio verification: ${abReceiptPath}`
          : `native A/B receipt invalid: ${abValidation.blockers.join(", ")}`,
        ...(onlyMissing ? {
          next_command_shape: `Use the youtube-studio-publish browser skill to configure the approved native test, then run node bin/goldflow.mjs youtube record-ab-test --episode-dir ${episodeDir} --studio-url <url> --configured-variant-ids <ids> --channel-verified true --test-verified true --recorded-by <name>`,
        } : {}),
      };
    }
    nativeAbEvidence = `; native ${plan.test_type} test ${abReceipt.experiment_state}`;
  }
  const effectiveThumbnail = await youtubeEffectiveThumbnailState(episodeDir, episode, {
    manifest,
    uploadReceipt: receipt,
    uploadReceiptHash: await sha256File(receiptPath).catch(() => null),
  });
  const thumbnailEvidence = effectiveThumbnail.update_count > 0
    ? `; effective thumbnail ${path.basename(effectiveThumbnail.path)} from update receipt #${effectiveThumbnail.update_count}`
    : "";
  const warning = effectiveThumbnail.status === "blocked"
    ? `; thumbnail update receipt warning: ${effectiveThumbnail.blockers.join(", ")}`
    : "";
  return {
    done: true,
    evidence: `YouTube video ${receipt.video_id} recorded as ${receipt.visibility}${nativeAbEvidence}${thumbnailEvidence}${warning}`,
  };
}

function thumbnailUpdateReceiptSequence(fileName, episode) {
  const escaped = String(episode).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(fileName).match(new RegExp(`^youtube_thumbnail_update_receipt_${escaped}_(\\d+)\\.json$`));
  return match ? Number(match[1]) : null;
}

export async function listYoutubeThumbnailUpdateReceipts(episodeDir, episode) {
  const names = await fs.readdir(episodeDir).catch(() => []);
  return names
    .map((name) => ({ name, sequence: thumbnailUpdateReceiptSequence(name, episode) }))
    .filter((row) => Number.isInteger(row.sequence) && row.sequence > 0)
    .sort((left, right) => left.sequence - right.sequence)
    .map((row) => ({ ...row, path: path.join(episodeDir, row.name) }));
}

export function validateYoutubeThumbnailUpdateReceipt(receipt, options = {}) {
  const blockers = [];
  const uploadReceipt = options.uploadReceipt ?? null;
  const currentThumbnail = options.currentThumbnail ?? null;
  const expectedChannels = new Set([
    clean(options.manifest?.youtube_channel?.expected_name),
    clean(options.manifest?.youtube_channel?.expected_handle),
  ].filter(Boolean));
  const videoId = clean(receipt?.video_id);
  const studioUrl = clean(receipt?.studio_url);
  const verifiedAt = new Date(receipt?.verified_at);
  push(blockers, receipt?.schema !== YOUTUBE_THUMBNAIL_UPDATE_RECEIPT_SCHEMA, "youtube_thumbnail_update_receipt_schema_invalid");
  push(blockers, clean(receipt?.status) !== "passed", "youtube_thumbnail_update_receipt_not_passed");
  push(blockers, !uploadReceipt || receipt?.upload_receipt_sha256 !== options.uploadReceiptHash, "youtube_thumbnail_update_upload_receipt_hash_stale");
  push(blockers, videoId !== clean(uploadReceipt?.video_id), "youtube_thumbnail_update_video_id_mismatch");
  push(blockers, !/^https:\/\/studio\.youtube\.com\/video\//.test(studioUrl), "youtube_thumbnail_update_studio_url_invalid");
  push(blockers, videoId && !studioUrl.includes(videoId), "youtube_thumbnail_update_studio_url_video_id_mismatch");
  push(blockers, !clean(receipt?.expected_channel), "youtube_thumbnail_update_expected_channel_missing");
  push(
    blockers,
    expectedChannels.size > 0 && !expectedChannels.has(clean(receipt?.expected_channel)),
    "youtube_thumbnail_update_expected_channel_mismatch",
  );
  push(blockers, receipt?.field_verification?.active_channel !== true, "youtube_thumbnail_update_channel_not_verified");
  push(blockers, receipt?.field_verification?.thumbnail !== true, "youtube_thumbnail_update_thumbnail_not_verified");
  push(blockers, receipt?.schedule_preserved !== true, "youtube_thumbnail_update_schedule_not_preserved");
  push(
    blockers,
    clean(uploadReceipt?.visibility) === "scheduled"
      && clean(receipt?.schedule_at) !== clean(uploadReceipt?.schedule_at),
    "youtube_thumbnail_update_schedule_time_mismatch",
  );
  push(blockers, !Number.isInteger(Number(receipt?.sequence)) || Number(receipt?.sequence) < 1, "youtube_thumbnail_update_sequence_invalid");
  push(blockers, !clean(receipt?.old_thumbnail?.path), "youtube_thumbnail_update_old_path_missing");
  push(blockers, !clean(receipt?.old_thumbnail?.sha256), "youtube_thumbnail_update_old_hash_missing");
  push(blockers, !clean(receipt?.new_thumbnail?.path), "youtube_thumbnail_update_new_path_missing");
  push(blockers, !clean(receipt?.new_thumbnail?.sha256), "youtube_thumbnail_update_new_hash_missing");
  push(
    blockers,
    currentThumbnail && (
      path.resolve(clean(receipt?.old_thumbnail?.path)) !== path.resolve(clean(currentThumbnail.path))
      || clean(receipt?.old_thumbnail?.sha256) !== clean(currentThumbnail.sha256)
    ),
    "youtube_thumbnail_update_old_thumbnail_not_current",
  );
  push(
    blockers,
    clean(receipt?.new_thumbnail?.sha256) === clean(receipt?.old_thumbnail?.sha256),
    "youtube_thumbnail_update_hash_unchanged",
  );
  push(
    blockers,
    Object.hasOwn(options, "newThumbnailSha256")
      && (
        !clean(options.newThumbnailSha256)
        || clean(receipt?.new_thumbnail?.sha256) !== clean(options.newThumbnailSha256)
      ),
    "youtube_thumbnail_update_new_hash_stale",
  );
  push(
    blockers,
    Number(receipt?.sequence) > 1
      && receipt?.prior_update_receipt_sha256 !== options.priorReceiptHash,
    "youtube_thumbnail_update_prior_receipt_hash_stale",
  );
  push(blockers, !clean(receipt?.verified_at) || Number.isNaN(verifiedAt.getTime()), "youtube_thumbnail_update_verified_at_invalid");
  push(blockers, !clean(receipt?.operator), "youtube_thumbnail_update_operator_missing");
  return { status: blockers.length ? "blocked" : "passed", blockers: uniqueStrings(blockers) };
}

export async function youtubeEffectiveThumbnailState(episodeDir, episode, options = {}) {
  const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
  const uploadReceiptPath = path.join(episodeDir, `youtube_upload_receipt_${episode}.json`);
  const manifest = options.manifest ?? await readJson(manifestPath);
  const uploadReceipt = options.uploadReceipt ?? await readJson(uploadReceiptPath);
  const uploadReceiptHash = options.uploadReceiptHash ?? await sha256File(uploadReceiptPath).catch(() => null);
  const current = {
    path: clean(manifest?.thumbnail?.path),
    sha256: clean(manifest?.thumbnail?.sha256),
  };
  const receiptFiles = await listYoutubeThumbnailUpdateReceipts(episodeDir, episode);
  if (!current.path || !current.sha256) {
    return { status: "blocked", blockers: ["youtube_manifest_thumbnail_missing"], ...current, update_count: 0 };
  }
  let effective = current;
  let priorReceiptHash = null;
  for (let index = 0; index < receiptFiles.length; index += 1) {
    const receiptFile = receiptFiles[index];
    const receipt = await readJson(receiptFile.path);
    const newThumbnailSha256 = await sha256File(receipt?.new_thumbnail?.path ?? "").catch(() => null);
    const validation = validateYoutubeThumbnailUpdateReceipt(receipt, {
      manifest,
      uploadReceipt,
      uploadReceiptHash,
      currentThumbnail: effective,
      priorReceiptHash,
      newThumbnailSha256,
    });
    if (receiptFile.sequence !== index + 1) validation.blockers.push("youtube_thumbnail_update_sequence_gap");
    if (Number(receipt?.sequence) !== receiptFile.sequence) validation.blockers.push("youtube_thumbnail_update_sequence_filename_mismatch");
    if (validation.blockers.length) {
      return {
        status: "blocked",
        blockers: uniqueStrings(validation.blockers),
        ...effective,
        update_count: index,
      };
    }
    effective = {
      path: clean(receipt.new_thumbnail.path),
      sha256: clean(receipt.new_thumbnail.sha256),
      receipt_path: receiptFile.path,
    };
    priorReceiptHash = await sha256File(receiptFile.path);
  }
  return { status: "passed", blockers: [], ...effective, update_count: receiptFiles.length };
}

export function validateYoutubePinnedCommentReceipt(receipt, options = {}) {
  const blockers = [];
  const expectedComment = clean(options.manifest?.pinned_comment?.text);
  const uploadReceipt = options.uploadReceipt ?? null;
  push(blockers, receipt?.schema !== YOUTUBE_PINNED_COMMENT_RECEIPT_SCHEMA, "youtube_comment_receipt_schema_invalid");
  push(blockers, clean(receipt?.status) !== "passed", "youtube_comment_receipt_not_passed");
  push(blockers, !uploadReceipt || receipt?.upload_receipt_sha256 !== options.uploadReceiptHash, "youtube_comment_receipt_upload_hash_stale");
  push(blockers, clean(receipt?.video_id) !== clean(uploadReceipt?.video_id), "youtube_comment_receipt_video_id_mismatch");
  push(blockers, receipt?.comment_text_sha256 !== hashText(expectedComment), "youtube_comment_receipt_text_hash_mismatch");
  push(blockers, receipt?.post_approval?.approved !== true, "youtube_comment_post_approval_missing");
  push(blockers, !clean(receipt?.post_approval?.approved_by), "youtube_comment_post_approver_missing");
  push(blockers, receipt?.pinned !== true, "youtube_comment_not_verified_pinned");
  push(blockers, !clean(receipt?.comment_id) && !clean(receipt?.comment_url), "youtube_comment_identity_missing");
  push(blockers, !clean(receipt?.recorded_by), "youtube_comment_recorder_missing");
  push(blockers, !clean(receipt?.recorded_at), "youtube_comment_time_missing");
  return { status: blockers.length ? "blocked" : "passed", blockers: uniqueStrings(blockers) };
}

export async function youtubePinnedCommentReceiptComplete(episodeDir, episode) {
  const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
  const uploadReceiptPath = path.join(episodeDir, `youtube_upload_receipt_${episode}.json`);
  const commentReceiptPath = path.join(episodeDir, `youtube_pinned_comment_receipt_${episode}.json`);
  const [manifest, uploadReceipt, receipt, uploadReceiptHash] = await Promise.all([
    readJson(manifestPath),
    readJson(uploadReceiptPath),
    readJson(commentReceiptPath),
    sha256File(uploadReceiptPath).catch(() => null),
  ]);
  if (!receipt) return { done: false, evidence: `youtube_pinned_comment_receipt_${episode}.json missing` };
  const validation = validateYoutubePinnedCommentReceipt(receipt, {
    manifest,
    uploadReceipt,
    uploadReceiptHash,
  });
  return validation.status === "passed"
    ? { done: true, evidence: `pinned comment verified for YouTube video ${receipt.video_id}` }
    : { done: false, state: "blocked", evidence: validation.blockers.join(", ") };
}

export const youtubePublishContractInternalsForTests = {
  DESCRIPTION_MAX_CHARS,
  PINNED_COMMENT_MAX_CHARS,
  RECENT_RESEARCH_MAX_AGE_DAYS,
  REQUIRED_UPLOAD_FIELD_VERIFICATIONS,
  THUMBNAIL_MAX_TOTAL_OVERLAY_WORDS,
  TITLE_MAX_CHARS,
  hashText,
  resolveEpisodeArtifact,
  sourceHashesCurrent,
  thumbnailEvidence,
  truthy,
  words,
};
