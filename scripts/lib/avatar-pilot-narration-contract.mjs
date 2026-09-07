import { createHash } from "node:crypto";
import path from "node:path";
import {
  QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK as JOEL,
  defaultNarrationVoiceProviderOptions,
  narrationTtsPolicyForIdentity,
  validateNarrationTtsPolicy,
} from "./narration-tts-policy.mjs";
import {
  buildNarrationQualityContract,
  validateNarrationQualityContract,
} from "./narration-quality-contract.mjs";
import {
  validateNarrationDeliveryReferenceBank,
  validateNarrationDeliveryBankPrimaryBinding,
} from "./narration-delivery-reference-bank.mjs";
import {
  productionLocalWhisperContract,
  validateLocalWhisperIdentityContract,
} from "./local-whisper-policy.mjs";

export const PILOT_NARRATION_IDENTITY_CONTRACT_SCHEMA =
  "goldflow_avatar_pilot_narration_identity_contract_v1";
export const PILOT_NARRATION_IDENTITY_CONTRACT_VERSION = "2026-09-07.1";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => [key, canonical(child)]));
};
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

// These fields mirror the existing pilot config. All richer model/runtime,
// calibration, unit, stitch and retry locks come from the canonical builder.
const expectedPilotLock = () => ({
  provider: JOEL.provider,
  model: JOEL.model_id,
  model_revision: JOEL.model_revision,
  voice_id: JOEL.voice_id,
  voice_sha256: JOEL.voice_sha256,
  reference_audio_sha256: JOEL.reference_audio_sha256,
  reference_text_sha256: JOEL.reference_text_sha256,
});

function readBankBytes(deliveryBank) {
  if (!path.isAbsolute(deliveryBank?.path ?? "")
    || deliveryBank.path.includes("\0")
    || !(typeof deliveryBank?.bytes === "string" || Buffer.isBuffer(deliveryBank?.bytes))) {
    throw new Error("pilot_narration_delivery_bank_exact_bytes_and_absolute_path_required");
  }
  const bytes = Buffer.isBuffer(deliveryBank.bytes)
    ? deliveryBank.bytes : Buffer.from(deliveryBank.bytes, "utf8");
  if (!bytes.length || bytes.length > 1024 * 1024) {
    throw new Error("pilot_narration_delivery_bank_size_invalid");
  }
  let document;
  try { document = JSON.parse(bytes.toString("utf8")); } catch {
    throw new Error("pilot_narration_delivery_bank_json_invalid");
  }
  const validation = validateNarrationDeliveryReferenceBank(document);
  const binding = validateNarrationDeliveryBankPrimaryBinding(document, JOEL);
  if (validation.status !== "passed" || binding.status !== "passed"
    || document.voice_id !== JOEL.voice_id || document.voice_sha256 !== JOEL.voice_sha256
    || document.default_delivery_id !== "neutral_forward"
    || !same(document.production_active_delivery_ids, ["neutral_forward"])) {
    throw new Error("pilot_narration_delivery_bank_owned_baseline_mismatch");
  }
  const fileHash = sha256(bytes);
  if (deliveryBank.sha256 != null && deliveryBank.sha256 !== fileHash) {
    throw new Error("pilot_narration_delivery_bank_file_hash_mismatch");
  }
  return { document, sha256: fileHash, path: deliveryBank.path };
}

/** Pure new-identity builder. Does not read assets, authorize spend or migrate a run. */
export function buildPilotNarrationIdentityFields({ narrationLock, deliveryBank } = {}) {
  if (!same(narrationLock, expectedPilotLock())) {
    throw new Error("pilot_narration_provider_lock_mismatch");
  }
  const bank = readBankBytes(deliveryBank);
  const quality = buildNarrationQualityContract({
    provider: JOEL.provider, modelId: JOEL.model_id, modelRevision: JOEL.model_revision,
  });
  const voiceOptions = defaultNarrationVoiceProviderOptions({
    provider: JOEL.provider, fallbackProvider: null, voiceId: JOEL.voice_id,
    nativeSpeed: null, referenceVariantId: JOEL.reference_variant_id,
    narrationQualityContract: quality,
  });
  const whisper = productionLocalWhisperContract();
  const fields = {
    tts_provider: JOEL.provider,
    tts_fallback_provider: null,
    narrator_voice_id: JOEL.voice_id,
    tts_voice_id: JOEL.voice_id,
    tts_native_speed: null,
    voice_provider_options: voiceOptions,
    narration_quality_contract: quality,
    narration_delivery_reference_bank: {
      path: bank.path, sha256: bank.sha256, schema: bank.document.schema,
      default_delivery_id: bank.document.default_delivery_id,
      production_active_delivery_ids: [...bank.document.production_active_delivery_ids],
    },
    provider_locks: { local_whisper_timing: whisper },
    production_profile_config: { audio: { local_whisper_timing: structuredClone(whisper) } },
    production_gates: { local_whisper_contract_required: true },
    model_versions: {
      tts_model: JOEL.model_id, tts_model_revision: JOEL.model_revision,
      local_whisper_model: whisper.model,
    },
  };
  // The canonical validators are the authority; no handcrafted weaker policy.
  validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(fields), { production: true });
  if (validateNarrationQualityContract(quality).status !== "passed"
    || !validateLocalWhisperIdentityContract(fields).done) {
    throw new Error("pilot_narration_canonical_identity_contract_invalid");
  }
  return {
    ...fields,
    pilot_narration_contract: {
      schema: PILOT_NARRATION_IDENTITY_CONTRACT_SCHEMA,
      version: PILOT_NARRATION_IDENTITY_CONTRACT_VERSION,
      fields_sha256: sha256(JSON.stringify(canonical(fields))),
      runtime_asset_verification: "required_before_pre_synthesis_authorization",
      synthesis_authorized: false,
    },
  };
}

/** Recompute from current bank bytes; never fill absent historical identity fields. */
export function validatePilotNarrationIdentity(identity, { deliveryBank } = {}) {
  const findings = [];
  if (identity?.media_workflow !== "avatar_footage_pilot_v1"
    || identity?.content_profile !== "mcu_what_if_pilot_v1"
    || identity?.run_intent !== "proof" || identity?.production_eligible !== false
    || identity?.publish_allowed !== false) {
    findings.push({ code: "pilot_narration_identity_route_or_proof_invalid" });
  }
  let expected;
  try {
    expected = buildPilotNarrationIdentityFields({
      narrationLock: identity?.pilot_providers?.narration, deliveryBank,
    });
  } catch (error) {
    findings.push({ code: error.message });
    return { status: "blocked", findings };
  }
  for (const key of Object.keys(expected)) {
    if (["provider_locks", "production_profile_config", "production_gates", "model_versions"].includes(key)) continue;
    if (!same(identity?.[key], expected[key])) findings.push({ code: "pilot_narration_identity_field_mismatch", field: key });
  }
  // Shared nested objects may carry unrelated image/workflow locks. Compare only
  // the exact narration-owned leaves, preserving those sibling fields.
  for (const [field, actual, wanted] of [
    ["provider_locks.local_whisper_timing", identity?.provider_locks?.local_whisper_timing, expected.provider_locks.local_whisper_timing],
    ["production_profile_config.audio.local_whisper_timing", identity?.production_profile_config?.audio?.local_whisper_timing, expected.production_profile_config.audio.local_whisper_timing],
    ["production_gates.local_whisper_contract_required", identity?.production_gates?.local_whisper_contract_required, true],
    ...Object.entries(expected.model_versions).map(([key, wanted]) => [`model_versions.${key}`, identity?.model_versions?.[key], wanted]),
  ]) {
    if (!same(actual, wanted)) findings.push({ code: "pilot_narration_identity_field_mismatch", field });
  }
  return {
    status: findings.length ? "blocked" : "passed", findings,
    verification_scope: "immutable_configuration_only_not_asset_verification_or_synthesis_authorization",
  };
}
