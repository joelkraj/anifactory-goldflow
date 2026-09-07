import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildPilotNarrationIdentityFields,
  validatePilotNarrationIdentity,
} from "../lib/avatar-pilot-narration-contract.mjs";
import {
  QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK as JOEL,
  narrationTtsPolicyForIdentity,
  validateNarrationTtsPolicy,
} from "../lib/narration-tts-policy.mjs";
import { validateLocalWhisperIdentityContract } from "../lib/local-whisper-policy.mjs";

const bankPath = fileURLToPath(new URL("../../config/narration_delivery_reference_bank.json", import.meta.url));
const bankBytes = await readFile(bankPath);
const deliveryBank = { path: bankPath, bytes: bankBytes };
const narrationLock = {
  provider: JOEL.provider, model: JOEL.model_id, model_revision: JOEL.model_revision,
  voice_id: JOEL.voice_id, voice_sha256: JOEL.voice_sha256,
  reference_audio_sha256: JOEL.reference_audio_sha256,
  reference_text_sha256: JOEL.reference_text_sha256,
};
const fields = buildPilotNarrationIdentityFields({ narrationLock, deliveryBank });
const identity = {
  media_workflow: "avatar_footage_pilot_v1", content_profile: "mcu_what_if_pilot_v1",
  run_intent: "proof", production_eligible: false, publish_allowed: false,
  pilot_providers: { narration: narrationLock }, ...fields,
};
assert.equal(validatePilotNarrationIdentity(identity, { deliveryBank }).status, "passed");
assert.equal(validateLocalWhisperIdentityContract(identity).mode, "locked");
assert.equal(validateLocalWhisperIdentityContract(identity).done, true);
const policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true });
assert.equal(policy.primary.reference_audio_sha256, JOEL.reference_audio_sha256);
assert.equal(policy.primary.reference_variant_id, JOEL.reference_variant_id);
assert.equal(policy.primary.native_speed, null);
assert.equal(policy.fallback, null);
assert.equal(policy.synthesis_contract.nominal_batch_size, 4);
assert.equal(policy.synthesis_contract.final_partial_cohort_allowed, true);
assert.equal(policy.narration_quality_contract.delivery_qa.maximum_word_error_rate, 0.05);
assert.equal(fields.pilot_narration_contract.synthesis_authorized, false);
assert.deepEqual(buildPilotNarrationIdentityFields({ narrationLock, deliveryBank }), fields);
assert.deepEqual(buildPilotNarrationIdentityFields({ narrationLock, deliveryBank: { path: bankPath, bytes: bankBytes.toString("utf8") } }), fields);

// Deep merge preserves unrelated profile/image fields, without loosening any
// canonical narration-owned leaf. No actual voice/reference audio is opened.
const siblings = structuredClone(identity);
siblings.provider_locks.still_model = "a separately locked image model";
siblings.production_profile_config.audio.unrelated_flag = true;
siblings.production_gates.unrelated_gate = true;
siblings.model_versions.image_model = "fixture-image-model";
assert.equal(validatePilotNarrationIdentity(siblings, { deliveryBank }).status, "passed");

const mutations = [
  (copy) => { copy.pilot_providers.narration.model = "different-model"; },
  (copy) => { copy.pilot_providers.narration.extra_unlocked_control = true; },
  (copy) => { copy.voice_provider_options.primary.reference_audio_sha256 = "0".repeat(64); },
  (copy) => { copy.voice_provider_options.primary.reference_variant_id = "different-reference"; },
  (copy) => { copy.voice_provider_options.primary.runtime_version = "different-runtime"; },
  (copy) => { copy.voice_provider_options.primary.speaker_similarity_calibration_sha256 = "0".repeat(64); },
  (copy) => { copy.voice_provider_options.synthesis_contract.nominal_batch_size = 1; },
  (copy) => { copy.voice_provider_options.fallback = { provider: "fish_audio" }; },
  (copy) => { copy.tts_native_speed = 1.1; },
  (copy) => { copy.narration_quality_contract.delivery_qa.maximum_word_error_rate = 1; },
  (copy) => { copy.provider_locks.local_whisper_timing.model = "tiny"; },
  (copy) => { delete copy.production_profile_config.audio.local_whisper_timing; },
  (copy) => { copy.model_versions.local_whisper_model = "small"; },
  (copy) => { copy.production_gates.local_whisper_contract_required = false; },
  (copy) => { copy.narration_delivery_reference_bank.sha256 = "0".repeat(64); },
  (copy) => { copy.pilot_narration_contract.fields_sha256 = "0".repeat(64); },
  (copy) => { copy.pilot_narration_contract.synthesis_authorized = true; },
  (copy) => { copy.media_workflow = "generated_visuals_v1"; },
  (copy) => { copy.publish_allowed = true; },
  (copy) => { delete copy.voice_provider_options; },
];
for (const mutate of mutations) {
  const copy = structuredClone(identity); mutate(copy);
  assert.equal(validatePilotNarrationIdentity(copy, { deliveryBank }).status, "blocked");
}
assert.equal(validatePilotNarrationIdentity(identity, {
  deliveryBank: { path: bankPath, bytes: Buffer.concat([bankBytes, Buffer.from("\n")]) },
}).status, "blocked", "even semantic-equivalent changed bank bytes invalidate the identity");
assert.throws(() => buildPilotNarrationIdentityFields({ narrationLock, deliveryBank: { ...deliveryBank, sha256: "0".repeat(64) } }), /file_hash_mismatch/u);
assert.throws(() => buildPilotNarrationIdentityFields({ narrationLock, deliveryBank: { ...deliveryBank, bytes: "{invalid" } }), /json_invalid/u);
assert.throws(() => buildPilotNarrationIdentityFields({ narrationLock, deliveryBank: { ...deliveryBank, path: "relative.json" } }), /absolute_path_required/u);
const wrongBank = JSON.parse(bankBytes.toString("utf8"));
wrongBank.voice_sha256 = "0".repeat(64);
assert.throws(() => buildPilotNarrationIdentityFields({ narrationLock, deliveryBank: { path: bankPath, bytes: JSON.stringify(wrongBank) } }), /owned_baseline_mismatch/u);
const historical = { media_workflow: "generated_visuals_v1", narrator_voice_id: "historical" };
const before = structuredClone(historical);
assert.equal(validatePilotNarrationIdentity(historical, { deliveryBank }).status, "blocked");
assert.deepEqual(historical, before, "validation cannot migrate or fill historical identity fields");
assert.equal(identity.pilot_providers.narration, narrationLock, "builder does not mutate its input lock");
console.log("avatar pilot narration identity contract tests passed (no model/assets/synthesis)");
