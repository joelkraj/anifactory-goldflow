import { createHash } from "node:crypto";

export const NARRATION_PROVIDER_BAKEOFF_MANIFEST_SCHEMA =
  "goldflow_narration_provider_bakeoff_manifest_v1";
export const NARRATION_PROVIDER_PROMOTION_SCHEMA =
  "goldflow_narration_provider_promotion_v1";

function canonicalize(value, omitted = new Set()) {
  if (Array.isArray(value)) return value.map((child) => canonicalize(child, omitted));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !omitted.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child, omitted)]),
  );
}

function canonicalSha256(value, omitted = []) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value, new Set(omitted))))
    .digest("hex");
}

export function narrationProviderBakeoffManifestSha256(value) {
  return canonicalSha256(value, ["manifest_sha256", "created_at"]);
}

export function narrationProviderPromotionSha256(value) {
  return canonicalSha256(value, ["promotion_sha256"]);
}

function hash(value) {
  return /^[a-f0-9]{64}$/u.test(String(value ?? ""));
}

function treatmentValid(treatment) {
  const representativeMinutes = Number(treatment?.representative?.duration_sec) / 60;
  const fatigueMinutes = Number(treatment?.fatigue?.duration_sec) / 60;
  return Boolean(
    treatment?.provider
      && treatment?.model_id
      && treatment?.voice_id
      && hash(treatment?.voice_sha256)
      && hash(treatment?.representative?.audio_sha256)
      && representativeMinutes >= 8
      && representativeMinutes <= 10
      && hash(treatment?.fatigue?.audio_sha256)
      && fatigueMinutes >= 20
      && fatigueMinutes <= 30
      && hash(treatment?.repeatability?.first_audio_sha256)
      && hash(treatment?.repeatability?.second_audio_sha256)
      && Number.isFinite(Number(treatment?.economics?.latency_sec))
      && Number.isFinite(Number(treatment?.economics?.estimated_cost_usd)),
  );
}

export function buildNarrationProviderBakeoffManifest({
  representativeTextSha256,
  fatigueTextSha256,
  voiceIdentitySha256,
  baseline,
  challenger,
  voiceSimilarityEvidence,
  repeatabilityEvidence,
  createdAt = new Date().toISOString(),
} = {}) {
  const blindSeed = canonicalSha256({
    representativeTextSha256,
    fatigueTextSha256,
    baseline: baseline?.representative?.audio_sha256,
    challenger: challenger?.representative?.audio_sha256,
  });
  const swap = Number.parseInt(blindSeed.slice(0, 2), 16) % 2 === 1;
  const labels = swap
    ? { A: "challenger", B: "baseline" }
    : { A: "baseline", B: "challenger" };
  const artifact = {
    schema: NARRATION_PROVIDER_BAKEOFF_MANIFEST_SCHEMA,
    status: "ready_for_blind_review",
    created_at: createdAt,
    policy_version: "narration_provider_longform_bakeoff_v1",
    incumbent_provider: "qwen_local",
    representative_text_sha256: representativeTextSha256,
    fatigue_text_sha256: fatigueTextSha256,
    voice_identity_sha256: voiceIdentitySha256,
    duration_contract: {
      representative_minutes_min: 8,
      representative_minutes_max: 10,
      fatigue_minutes_min: 20,
      fatigue_minutes_max: 30,
    },
    treatments: { baseline, challenger },
    blind: {
      seed_sha256: blindSeed,
      labels,
      reviewer_packet: Object.fromEntries(Object.entries(labels).map(
        ([label, key]) => [label, {
          representative_audio_path: key === "baseline"
            ? baseline?.representative?.audio_path
            : challenger?.representative?.audio_path,
          fatigue_audio_path: key === "baseline"
            ? baseline?.fatigue?.audio_path
            : challenger?.fatigue?.audio_path,
        }],
      )),
    },
    voice_similarity_evidence: voiceSimilarityEvidence,
    repeatability_evidence: repeatabilityEvidence,
    decision_rule: {
      blind_preference_required: true,
      repeatability_pass_required: true,
      fatigue_soak_pass_required: true,
      voice_identity_drift_is_veto: true,
      cost_and_latency_justification_required: true,
      explicit_operator_promotion_required: true,
      incumbent_retained_on_tie_or_incomplete_evidence: true,
    },
  };
  return { ...artifact, manifest_sha256: narrationProviderBakeoffManifestSha256(artifact) };
}

export function validateNarrationProviderBakeoffManifest(manifest) {
  const findings = [];
  if (manifest?.schema !== NARRATION_PROVIDER_BAKEOFF_MANIFEST_SCHEMA) findings.push({ code: "narration_provider_bakeoff_schema_invalid" });
  if (manifest?.manifest_sha256 !== narrationProviderBakeoffManifestSha256(manifest)) findings.push({ code: "narration_provider_bakeoff_hash_invalid" });
  if (manifest?.incumbent_provider !== "qwen_local") findings.push({ code: "narration_provider_bakeoff_incumbent_invalid" });
  if (!hash(manifest?.representative_text_sha256) || !hash(manifest?.fatigue_text_sha256) || !hash(manifest?.voice_identity_sha256)) findings.push({ code: "narration_provider_bakeoff_text_or_voice_lineage_invalid" });
  if (!treatmentValid(manifest?.treatments?.baseline) || manifest?.treatments?.baseline?.provider !== "qwen_local") findings.push({ code: "narration_provider_bakeoff_baseline_invalid" });
  if (!treatmentValid(manifest?.treatments?.challenger) || !["fish_audio", "elevenlabs"].includes(manifest?.treatments?.challenger?.provider)) findings.push({ code: "narration_provider_bakeoff_challenger_invalid" });
  const labels = manifest?.blind?.labels ?? {};
  if (new Set(Object.values(labels)).size !== 2 || !["baseline", "challenger"].every((key) => Object.values(labels).includes(key))) findings.push({ code: "narration_provider_bakeoff_blind_labels_invalid" });
  for (const evidence of [manifest?.voice_similarity_evidence, manifest?.repeatability_evidence]) {
    if (!evidence?.path || !hash(evidence?.sha256)) findings.push({ code: "narration_provider_bakeoff_evidence_binding_invalid" });
  }
  return { status: findings.length ? "blocked" : "passed", findings };
}

export function buildNarrationProviderPromotion({
  manifest,
  winnerLabel,
  reviewer,
  blindPreference,
  representativePass,
  fatiguePass,
  repeatabilityPass,
  voiceIdentityPass,
  voiceDriftVetoClear,
  costLatencyJustified,
  rationale,
  reviewedAt = new Date().toISOString(),
} = {}) {
  const winnerKey = manifest?.blind?.labels?.[winnerLabel] ?? null;
  const winner = winnerKey ? manifest?.treatments?.[winnerKey] : null;
  const promoted = winnerKey === "challenger";
  const artifact = {
    schema: NARRATION_PROVIDER_PROMOTION_SCHEMA,
    status: promoted ? "approved" : "incumbent_retained",
    bakeoff_manifest_sha256: manifest?.manifest_sha256 ?? null,
    winner_label: winnerLabel,
    blind_preference: blindPreference,
    winner_treatment: winnerKey,
    promoted_provider: promoted ? winner?.provider ?? null : "qwen_local",
    promoted_model_id: promoted ? winner?.model_id ?? null : manifest?.treatments?.baseline?.model_id ?? null,
    promoted_model_revision: promoted ? winner?.model_revision ?? null : manifest?.treatments?.baseline?.model_revision ?? null,
    promoted_voice_id: promoted ? winner?.voice_id ?? null : manifest?.treatments?.baseline?.voice_id ?? null,
    promoted_voice_sha256: promoted ? winner?.voice_sha256 ?? null : manifest?.treatments?.baseline?.voice_sha256 ?? null,
    representative_passed: representativePass === true,
    fatigue_soak_passed: fatiguePass === true,
    repeatability_passed: repeatabilityPass === true,
    same_voice_identity_passed: voiceIdentityPass === true,
    voice_drift_veto_clear: voiceDriftVetoClear === true,
    cost_latency_justified: costLatencyJustified === true,
    reviewer: String(reviewer ?? "").trim() || null,
    reviewed_at: reviewedAt,
    rationale: String(rationale ?? "").trim() || null,
  };
  return { ...artifact, promotion_sha256: narrationProviderPromotionSha256(artifact) };
}

export function validateNarrationProviderPromotion(promotion, manifest, {
  requiredProvider = null,
} = {}) {
  const findings = [];
  const manifestValidation = validateNarrationProviderBakeoffManifest(manifest);
  findings.push(...manifestValidation.findings);
  if (promotion?.schema !== NARRATION_PROVIDER_PROMOTION_SCHEMA) findings.push({ code: "narration_provider_promotion_schema_invalid" });
  if (promotion?.promotion_sha256 !== narrationProviderPromotionSha256(promotion)) findings.push({ code: "narration_provider_promotion_hash_invalid" });
  if (promotion?.bakeoff_manifest_sha256 !== manifest?.manifest_sha256) findings.push({ code: "narration_provider_promotion_manifest_stale" });
  if (!String(promotion?.reviewer ?? "").trim() || !String(promotion?.rationale ?? "").trim()) findings.push({ code: "narration_provider_promotion_operator_receipt_incomplete" });
  const winnerKey = manifest?.blind?.labels?.[promotion?.winner_label] ?? null;
  if (!winnerKey || promotion?.winner_treatment !== winnerKey) findings.push({ code: "narration_provider_promotion_blind_winner_invalid" });
  if (promotion?.blind_preference !== promotion?.winner_label) findings.push({ code: "narration_provider_promotion_blind_preference_invalid" });
  const challengerPromotion = winnerKey === "challenger";
  if (challengerPromotion) {
    if (promotion?.status !== "approved") findings.push({ code: "narration_provider_promotion_not_approved" });
    for (const field of ["representative_passed", "fatigue_soak_passed", "repeatability_passed", "same_voice_identity_passed", "voice_drift_veto_clear", "cost_latency_justified"]) {
      if (promotion?.[field] !== true) findings.push({ code: "narration_provider_promotion_criterion_failed", field });
    }
    const challenger = manifest.treatments.challenger;
    if (promotion?.promoted_provider !== challenger.provider || promotion?.promoted_model_id !== challenger.model_id || promotion?.promoted_voice_id !== challenger.voice_id || promotion?.promoted_voice_sha256 !== challenger.voice_sha256) findings.push({ code: "narration_provider_promotion_challenger_binding_invalid" });
  } else if (promotion?.status !== "incumbent_retained" || promotion?.promoted_provider !== "qwen_local") findings.push({ code: "narration_provider_promotion_incumbent_disposition_invalid" });
  if (requiredProvider && promotion?.promoted_provider !== requiredProvider) findings.push({ code: "narration_provider_promotion_wrong_provider", required_provider: requiredProvider });
  return { status: findings.length ? "blocked" : "passed", findings };
}
