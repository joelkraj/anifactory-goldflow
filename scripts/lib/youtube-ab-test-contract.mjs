import { createHash } from "node:crypto";

export const YOUTUBE_AB_CANDIDATES_SCHEMA = "goldflow_youtube_ab_candidates_v1";
export const YOUTUBE_NATIVE_AB_PLAN_SCHEMA = "goldflow_youtube_native_ab_plan_v1";
export const YOUTUBE_NATIVE_AB_RECEIPT_SCHEMA = "goldflow_youtube_native_ab_receipt_v1";

const VALID_TEST_TYPES = new Set(["thumbnail_only", "title_only", "title_and_thumbnail"]);
const VALID_RECEIPT_STATES = new Set(["active", "completed", "stopped"]);

function clean(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["approved_at", "created_at", "plan_sha256"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function youtubeAbPlanSha256(plan) {
  return sha256(JSON.stringify(canonicalize(plan)));
}

export function validateYoutubeAbCandidates(candidates) {
  const blockers = [];
  const rows = Array.isArray(candidates?.candidates) ? candidates.candidates : [];
  const testType = clean(candidates?.test_type);
  const ids = rows.map((row) => clean(row?.id));
  if (candidates?.schema !== YOUTUBE_AB_CANDIDATES_SCHEMA) blockers.push("youtube_ab_candidates_schema_invalid");
  if (!VALID_TEST_TYPES.has(testType)) blockers.push("youtube_ab_test_type_invalid");
  if (rows.length < 2 || rows.length > 3) blockers.push("youtube_ab_requires_two_or_three_variants");
  if (ids.some((id) => !id) || unique(ids).length !== rows.length) blockers.push("youtube_ab_variant_ids_missing_or_duplicate");
  if (!ids.includes(clean(candidates?.baseline_variant_id))) blockers.push("youtube_ab_baseline_variant_missing");
  for (const [index, row] of rows.entries()) {
    if (!clean(row?.title) || clean(row.title).length > 100) blockers.push(`youtube_ab_variant_${index}_title_invalid`);
    if (!clean(row?.thumbnail_path)) blockers.push(`youtube_ab_variant_${index}_thumbnail_path_missing`);
    if (!clean(row?.hypothesis)) blockers.push(`youtube_ab_variant_${index}_hypothesis_missing`);
  }
  const titles = rows.map((row) => clean(row.title));
  const thumbnails = rows.map((row) => clean(row.thumbnail_path));
  if (testType === "thumbnail_only" && unique(titles).length !== 1) blockers.push("youtube_ab_thumbnail_only_titles_must_match");
  if (testType === "title_only" && unique(thumbnails).length !== 1) blockers.push("youtube_ab_title_only_thumbnails_must_match");
  if (testType !== "thumbnail_only" && unique(titles).length < 2) blockers.push("youtube_ab_titles_do_not_vary");
  if (testType !== "title_only" && unique(thumbnails).length < 2) blockers.push("youtube_ab_thumbnails_do_not_vary");
  return { status: blockers.length ? "blocked" : "passed", blockers: unique(blockers) };
}

export function validateYoutubeNativeAbPlan(plan, options = {}) {
  const blockers = [];
  const candidateValidation = validateYoutubeAbCandidates({
    schema: YOUTUBE_AB_CANDIDATES_SCHEMA,
    test_type: plan?.test_type,
    baseline_variant_id: plan?.baseline_variant_id,
    candidates: plan?.variants,
  });
  blockers.push(...candidateValidation.blockers);
  if (plan?.schema !== YOUTUBE_NATIVE_AB_PLAN_SCHEMA) blockers.push("youtube_ab_plan_schema_invalid");
  if (clean(plan?.status) !== "approved") blockers.push("youtube_ab_plan_not_approved");
  if (!clean(plan?.episode)) blockers.push("youtube_ab_plan_episode_missing");
  if (!clean(plan?.approved_by) || !clean(plan?.approved_at)) blockers.push("youtube_ab_plan_operator_approval_missing");
  if (!clean(plan?.packaging_spec_path) || !clean(plan?.packaging_spec_sha256)) blockers.push("youtube_ab_plan_packaging_binding_missing");
  if (Object.hasOwn(options, "packagingSpecSha256")
    && clean(plan?.packaging_spec_sha256) !== clean(options.packagingSpecSha256)) {
    blockers.push("youtube_ab_plan_packaging_hash_stale");
  }
  for (const [index, row] of (plan?.variants ?? []).entries()) {
    if (clean(row?.title_sha256) !== sha256(clean(row?.title))) blockers.push(`youtube_ab_variant_${index}_title_hash_stale`);
    if (!clean(row?.thumbnail_sha256)) blockers.push(`youtube_ab_variant_${index}_thumbnail_hash_missing`);
  }
  const baseline = (plan?.variants ?? []).find((row) => clean(row?.id) === clean(plan?.baseline_variant_id));
  if (options.baselineTitle && clean(baseline?.title) !== clean(options.baselineTitle)) blockers.push("youtube_ab_baseline_title_not_selected_package");
  if (options.baselineThumbnailSha256
    && clean(baseline?.thumbnail_sha256) !== clean(options.baselineThumbnailSha256)) {
    blockers.push("youtube_ab_baseline_thumbnail_not_selected_package");
  }
  if (clean(plan?.plan_sha256) !== youtubeAbPlanSha256(plan)) blockers.push("youtube_ab_plan_hash_stale");
  return { status: blockers.length ? "blocked" : "passed", blockers: unique(blockers) };
}

export function validateYoutubeNativeAbReceipt(receipt, options = {}) {
  const blockers = [];
  const plan = options.plan ?? null;
  const uploadReceipt = options.uploadReceipt ?? null;
  const configured = unique(receipt?.configured_variant_ids ?? []);
  const expected = unique(plan?.variants?.map((row) => row.id) ?? []);
  const studioUrl = clean(receipt?.studio_url);
  const videoId = clean(receipt?.video_id);
  if (receipt?.schema !== YOUTUBE_NATIVE_AB_RECEIPT_SCHEMA) blockers.push("youtube_ab_receipt_schema_invalid");
  if (clean(receipt?.status) !== "passed") blockers.push("youtube_ab_receipt_not_passed");
  if (!plan || clean(receipt?.plan_sha256) !== clean(options.planSha256)) blockers.push("youtube_ab_receipt_plan_hash_stale");
  if (!uploadReceipt || clean(receipt?.upload_receipt_sha256) !== clean(options.uploadReceiptSha256)) blockers.push("youtube_ab_receipt_upload_hash_stale");
  if (videoId !== clean(uploadReceipt?.video_id)) blockers.push("youtube_ab_receipt_video_id_mismatch");
  if (!VALID_RECEIPT_STATES.has(clean(receipt?.experiment_state))) blockers.push("youtube_ab_receipt_state_invalid");
  if (!studioUrl.startsWith("https://studio.youtube.com/video/") || (videoId && !studioUrl.includes(videoId))) blockers.push("youtube_ab_receipt_studio_url_invalid");
  if (JSON.stringify(configured.sort()) !== JSON.stringify(expected.sort())) blockers.push("youtube_ab_receipt_variants_not_all_verified");
  if (receipt?.field_verification?.active_channel !== true) blockers.push("youtube_ab_receipt_channel_not_verified");
  if (receipt?.field_verification?.native_test !== true) blockers.push("youtube_ab_receipt_native_test_not_verified");
  if (!clean(receipt?.recorded_by) || !clean(receipt?.recorded_at)) blockers.push("youtube_ab_receipt_recorder_missing");
  return { status: blockers.length ? "blocked" : "passed", blockers: unique(blockers) };
}
