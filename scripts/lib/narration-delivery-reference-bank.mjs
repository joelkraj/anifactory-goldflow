import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NARRATION_DELIVERY_REFERENCE_BANK_SCHEMA =
  "goldflow_narration_delivery_reference_bank_v1";
export const NARRATION_DELIVERY_PROMOTION_SCHEMA =
  "goldflow_narration_delivery_reference_promotion_v1";
export const REQUIRED_NARRATION_DELIVERY_IDS = Object.freeze([
  "neutral_forward",
  "urgent",
  "intimate",
  "cold_reveal",
  "restrained_grief",
]);
export const DEFAULT_NARRATION_DELIVERY_BANK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../config/narration_delivery_reference_bank.json",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value) {
  return String(value ?? "").trim();
}

export function narrationDeliveryPromotionSha256(document) {
  const copy = structuredClone(document ?? {});
  delete copy.promotion_sha256;
  return sha256(JSON.stringify(copy));
}

export function validateNarrationDeliveryReferenceBank(document) {
  const findings = [];
  if (document?.schema !== NARRATION_DELIVERY_REFERENCE_BANK_SCHEMA) findings.push({ code: "narration_delivery_bank_schema_invalid" });
  if (!clean(document?.voice_id) || !/^[a-f0-9]{64}$/iu.test(clean(document?.voice_sha256))) findings.push({ code: "narration_delivery_bank_voice_identity_invalid" });
  const requiredIds = Array.isArray(document?.required_delivery_ids) ? document.required_delivery_ids : [];
  if (JSON.stringify([...requiredIds].sort()) !== JSON.stringify([...REQUIRED_NARRATION_DELIVERY_IDS].sort())) findings.push({ code: "narration_delivery_bank_required_ids_invalid" });
  const rows = Array.isArray(document?.references) ? document.references : [];
  if (rows.length !== REQUIRED_NARRATION_DELIVERY_IDS.length || new Set(rows.map((row) => row?.delivery_id)).size !== rows.length) findings.push({ code: "narration_delivery_bank_reference_scope_invalid" });
  for (const deliveryId of REQUIRED_NARRATION_DELIVERY_IDS) {
    const row = rows.find((entry) => entry?.delivery_id === deliveryId);
    if (!row) {
      findings.push({ code: "narration_delivery_bank_reference_missing", delivery_id: deliveryId });
      continue;
    }
    if (!path.isAbsolute(clean(row.audio_path)) || !/^[a-f0-9]{64}$/iu.test(clean(row.audio_sha256))) findings.push({ code: "narration_delivery_bank_audio_binding_invalid", delivery_id: deliveryId });
    if (!clean(row.reference_text) || sha256(row.reference_text) !== row.reference_text_sha256) findings.push({ code: "narration_delivery_bank_text_binding_invalid", delivery_id: deliveryId });
  }
  const activeIds = Array.isArray(document?.production_active_delivery_ids) ? document.production_active_delivery_ids : [];
  const approvedIds = Array.isArray(document?.blind_approved_delivery_ids) ? document.blind_approved_delivery_ids : [];
  if (document?.production_activation_contract !== "single_active_reference_v1") findings.push({ code: "narration_delivery_bank_activation_contract_invalid" });
  if (activeIds.length !== 1) findings.push({ code: "narration_delivery_bank_multiple_runtime_references_not_approved" });
  if (!activeIds.includes(document?.default_delivery_id)) findings.push({ code: "narration_delivery_bank_default_not_active" });
  for (const deliveryId of activeIds) {
    const row = rows.find((entry) => entry?.delivery_id === deliveryId);
    if (!row) findings.push({ code: "narration_delivery_bank_active_reference_missing", delivery_id: deliveryId });
    else if (!new Set(["production_approved_baseline", "production_approved"]).has(row.status)) findings.push({ code: "narration_delivery_bank_unapproved_reference_active", delivery_id: deliveryId });
    if (!approvedIds.includes(deliveryId)) findings.push({ code: "narration_delivery_bank_active_reference_not_blind_approved", delivery_id: deliveryId });
  }
  return { status: findings.length ? "blocked" : "passed", findings };
}

export async function loadNarrationDeliveryReferenceBank(bankPath = DEFAULT_NARRATION_DELIVERY_BANK_PATH, {
  verifyAssets = true,
} = {}) {
  const resolvedPath = path.resolve(bankPath);
  const bytes = await fs.readFile(resolvedPath);
  const document = JSON.parse(bytes.toString("utf8"));
  const validation = validateNarrationDeliveryReferenceBank(document);
  if (verifyAssets) {
    for (const row of document.references ?? []) {
      const audioBytes = await fs.readFile(path.resolve(row.audio_path)).catch(() => null);
      if (!audioBytes || sha256(audioBytes) !== row.audio_sha256) {
        validation.findings.push({ code: "narration_delivery_bank_audio_missing_or_stale", delivery_id: row.delivery_id });
      }
    }
    if (validation.findings.length) validation.status = "blocked";
  }
  return {
    path: resolvedPath,
    sha256: sha256(bytes),
    document,
    validation,
  };
}

export function desiredNarrationDeliveryForUnit(unit = {}) {
  const intent = unit.performance_intent ?? unit.actionable_direction?.performance_intent ?? {};
  const tags = [
    intent.energy,
    intent.tension,
    intent.intimacy,
    intent.emphasis,
    ...(intent.style_tags ?? []),
    unit.delivery_class,
  ].map((value) => clean(value).toLowerCase()).join(" ");
  if (/grief|mourning|bereav|devastat|restrained sorrow/u.test(tags)) return "restrained_grief";
  if (/intimate|tender|private|vulnerable|soft confession/u.test(tags)) return "intimate";
  if (/cold reveal|ominous reveal|whisper|dread|chilling/u.test(tags)) return "cold_reveal";
  if (/urgent|panic|fast|chase|attack|high energy|maximum tension/u.test(tags)) return "urgent";
  return "neutral_forward";
}

export function selectNarrationDeliveryReference(bank, unit = {}) {
  const requestedDeliveryId = desiredNarrationDeliveryForUnit(unit);
  const active = new Set(bank?.production_active_delivery_ids ?? []);
  const selectedDeliveryId = active.has(requestedDeliveryId)
    ? requestedDeliveryId
    : bank?.default_delivery_id;
  const reference = (bank?.references ?? []).find((row) => row.delivery_id === selectedDeliveryId) ?? null;
  return {
    requested_delivery_id: requestedDeliveryId,
    selected_delivery_id: selectedDeliveryId,
    fell_back_to_default: requestedDeliveryId !== selectedDeliveryId,
    reference,
  };
}

export function validateNarrationDeliveryPromotion(document, bank) {
  const findings = [];
  if (document?.schema !== NARRATION_DELIVERY_PROMOTION_SCHEMA) findings.push({ code: "narration_delivery_promotion_schema_invalid" });
  if (document?.status !== "approved") findings.push({ code: "narration_delivery_promotion_status_invalid" });
  if (!REQUIRED_NARRATION_DELIVERY_IDS.includes(document?.delivery_id)) findings.push({ code: "narration_delivery_promotion_id_invalid" });
  if (!clean(document?.approved_by) || !clean(document?.approved_at)) findings.push({ code: "narration_delivery_promotion_operator_missing" });
  if (document?.same_voice_identity_passed !== true || document?.voice_drift_veto_clear !== true) findings.push({ code: "narration_delivery_promotion_voice_veto_failed" });
  if (Number(document?.blind_test_minutes ?? 0) < Number(bank?.promotion_policy?.blind_representative_test_minutes_min ?? 8)) findings.push({ code: "narration_delivery_promotion_blind_test_too_short" });
  const fatigueMinutes = Number(document?.fatigue_soak_minutes ?? 0);
  if (fatigueMinutes < Number(bank?.promotion_policy?.fatigue_soak_minutes_min ?? 20) || fatigueMinutes > Number(bank?.promotion_policy?.fatigue_soak_minutes_max ?? 30)) findings.push({ code: "narration_delivery_promotion_fatigue_soak_invalid" });
  if (document?.blind_preference_winner !== document?.delivery_id) findings.push({ code: "narration_delivery_promotion_not_blind_winner" });
  if (document?.promotion_sha256 !== narrationDeliveryPromotionSha256(document)) findings.push({ code: "narration_delivery_promotion_hash_invalid" });
  return { status: findings.length ? "blocked" : "passed", findings };
}

export function validateNarrationDeliveryBankPrimaryBinding(bank, primary = {}) {
  const findings = [];
  const row = (bank?.references ?? []).find(
    (entry) => entry.delivery_id === bank?.default_delivery_id,
  );
  if (!row
    || row.audio_path !== primary.reference_audio_path
    || row.audio_sha256 !== primary.reference_audio_sha256
    || row.reference_text !== primary.reference_text
    || row.reference_text_sha256 !== primary.reference_text_sha256) {
    findings.push({
      code: "narration_delivery_bank_default_differs_from_primary_voice_lock",
      default_delivery_id: bank?.default_delivery_id ?? null,
    });
  }
  return { status: findings.length ? "blocked" : "passed", findings };
}
