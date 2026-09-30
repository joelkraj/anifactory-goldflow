import { publicModelslabAccount } from "./modelslab-account-pool.mjs";

function escapedRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactLtxAccountProfileNames(value, profiles = []) {
  if (value == null) return null;
  let redacted = String(value);
  const candidates = [...new Set(profiles.map((profile) => String(profile ?? "").trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const profile of candidates) {
    redacted = redacted.replace(
      new RegExp(`(?<![A-Za-z0-9._-])${escapedRegExp(profile)}(?![A-Za-z0-9._-])`, "gu"),
      "[redacted-account-profile]",
    );
  }
  return redacted;
}

export function publicLtxModelslabAccountPool(accounts = []) {
  return accounts.map((account) => publicModelslabAccount(account));
}

export function publicLtxClipResult(row = {}, { accountProfiles = [] } = {}) {
  const account = publicModelslabAccount(row.modelslab_account);
  return {
    image_id: row.image_id,
    candidate_id: row.candidate_id,
    candidate_index: row.candidate_index,
    creative_generation_attempt: row.creative_generation_attempt ?? 1,
    provider_request_attempt: row.provider_request_attempt ?? null,
    automatic_generation_retry_allowed: row.automatic_generation_retry_allowed === true,
    operator_authorized_retry: row.operator_authorized_retry === true,
    resumed_existing_request: row.resumed_existing_request === true,
    prior_request_id: row.prior_request_id ?? null,
    confirmed_terminal_prior_request: row.confirmed_terminal_prior_request === true,
    retry_of_error: redactLtxAccountProfileNames(row.retry_of_error, accountProfiles),
    scene_id: row.scene_id,
    visual_beat_id: row.visual_beat_id,
    start_sec: row.start_sec,
    cut_duration_sec: row.cut_duration_sec,
    requested_duration_sec: row.duration_sec,
    animation_sequence_id: row.animation_sequence_id ?? null,
    sequence_mode: row.sequence_mode ?? "standalone_shot",
    sequence_timeline_duration_sec: row.sequence_timeline_duration_sec ?? row.cut_duration_sec,
    coverage: row.coverage ?? null,
    start_frame_contract: row.start_frame_contract ?? null,
    end_frame_contract: row.end_frame_contract ?? null,
    source_image_path: row.source_image_path,
    source_image_sha256: row.source_image_sha256,
    source_prompt_sha256: row.source_prompt_sha256,
    motion_prompt_sha256: row.motion_prompt_sha256,
    modelslab_account_fingerprint: account.fingerprint,
    modelslab_account_credential_source: account.credential_source,
    request_id: row.request_id ?? null,
    initial_eta_sec: row.initial_eta_sec ?? null,
    submit_latency_ms: row.submit_latency_ms ?? null,
    wall_time_sec: row.wall_time_sec ?? null,
    provider_generation_time_sec: row.provider_generation_time_sec ?? null,
    raw_video_path: row.raw_video_path ?? null,
    raw_video_sha256: row.raw_video_sha256 ?? null,
    raw_probe: row.raw_probe ?? null,
    normalized_video_path: row.normalized_video_path ?? null,
    normalized_video_sha256: row.normalized_video_sha256 ?? null,
    normalized_probe: row.normalized_probe ?? null,
    status: row.status,
    disposition: row.disposition ?? null,
    omission_stage: row.omission_stage ?? null,
    retryable_transient: row.retryable_transient === true,
    retry_after_ms: row.retry_after_ms ?? null,
    cooldown_until: row.cooldown_until ?? null,
    omitted_at: row.omitted_at ?? null,
    error: redactLtxAccountProfileNames(row.error, accountProfiles),
  };
}
