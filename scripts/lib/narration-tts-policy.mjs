import { isDeepStrictEqual } from "node:util";
import {
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT,
} from "./qwen-liam-batch-contract.mjs";

export const DEFAULT_TTS_PROVIDER = "qwen_local";
export const DEFAULT_TTS_FALLBACK_PROVIDER = null;
export const DEFAULT_NARRATOR_VOICE_ID = "joel_owned_narrator_clone";
export const DEFAULT_TTS_NATIVE_SPEED = null;
export const DEFAULT_TTS_UNIT_TARGET_WORDS_MIN = 45;
export const DEFAULT_TTS_UNIT_TARGET_WORDS_MAX = 60;
export const DEFAULT_TTS_UNIT_HARD_WORDS_MAX = 60;
export const DEFAULT_TTS_JOIN_SILENCE_MS = 80;
export const NARRATION_TTS_QA_POLICY_VERSION = "narration_tts_qa_v1";
const LEGACY_KOKORO_NATIVE_SPEED = 1.2;

export const KOKORO_MODEL_LOCK = Object.freeze({
  provider: "kokoro_local",
  model_id: "mlx-community/Kokoro-82M-bf16",
  model_name: "Kokoro v1.0 82M BF16",
  model_revision: "a71e4d38b236d968966a2002c4c895dbd12b1c3c",
  model_weights_sha256: "4e9ecdf03b8b6cf906070390237feda473dc13327cb8d56a43deaa374c02acd8",
  model_config_sha256: "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f",
  runtime: "mlx-audio",
  runtime_version: "0.4.6",
  runtime_revision: "d28d68c6ac4e28f7d2d66007f640b06cf3fd8ceb",
  language_code: "a",
  sample_rate_hz: 24000,
});

export const KOKORO_VOICE_LOCKS = Object.freeze({
  am_puck: Object.freeze({
    voice_id: "am_puck",
    gender: "male",
    voice_sha256: "9a8c2e56413bd2063f814cb4c3885fc425876157369117c3f8258d03c8a9ad89",
    selection: "operator_locked_only_production_narrator",
  }),
});

const QWEN_LOCAL_MODEL_LOCK = Object.freeze({
  provider: "qwen_local",
  model_id: "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit",
  model_name: "Qwen3-TTS 12Hz 1.7B Base 8-bit",
  model_revision: "e7dd0585652209fa0d7783659aad4e8a324de11c",
  model_weights_sha256: "b965c581ccf6aa852a4124feeb7a8a111542ee7b213139368b4cc7ba7fd4728b",
  model_config_sha256: "b14fba6bfd391968876248b843b095696b0188187a3d774a3bddc32544d15627",
  generation_config_sha256: "f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa",
  speech_tokenizer_weights_sha256: "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
  speech_tokenizer_config_sha256: "ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167",
  runtime: "mlx-audio",
  runtime_version: "0.4.6",
  sample_rate_hz: 24000,
});

export const QWEN_LIAM_UNIT_CONTRACT = Object.freeze({
  sentence_complete: true,
  target_words_min: DEFAULT_TTS_UNIT_TARGET_WORDS_MIN,
  target_words_max: DEFAULT_TTS_UNIT_TARGET_WORDS_MAX,
  hard_words_max: DEFAULT_TTS_UNIT_HARD_WORDS_MAX,
  continuous_requests: false,
});

export const QWEN_LIAM_STITCH_CONTRACT = Object.freeze({
  join_silence_ms: DEFAULT_TTS_JOIN_SILENCE_MS,
  post_tempo_processing: false,
});

export const QWEN_LIAM_RETRY_CONTRACT = Object.freeze({
  retry_policy: "confirmed_skips_truncations_or_stutters_only",
  automatic_asr_retry: false,
  confirmed_defect_types: Object.freeze(["skip", "truncation", "stutter"]),
});

export {
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT,
};

export const QWEN_LIAM_PRIMARY_LOCK = Object.freeze({
  ...QWEN_LOCAL_MODEL_LOCK,
  voice_id: "am_liam",
  voice_sha256: "66b65a96e16c3d91035a6e9019d9986ed524d27ce35b487270cdf61c99e3ebad",
  reference_audio_path: "/Users/joel/AniFactoryData/voice_bank/proofs/2026-07-27-qwen-liam-clone-delivery-v1/liam_reference/liam_clone_reference.wav",
  reference_audio_sha256: "6200eb0dcc2d5f9c9d0ab52a2532d033a3db126e9d1570e78d4463cc282ee0af",
  reference_text: "Because a deed is not a toy. A deed is the only word in any language that means this is mine and the world has to agree. The breathing got closer. Out of the black came a shape too big to be a man and too graceful to be a beast. A broken crown curved between its horns.",
  reference_text_sha256: "2630f1d234dd38762cf538ee7b817026711f2c9642a26dd3678242647e5a720c",
  reference_manifest_path: "/Users/joel/AniFactoryData/voice_bank/proofs/2026-07-27-qwen-liam-clone-delivery-v1/liam_reference_manifest.json",
  reference_manifest_sha256: "6da7f9797caba9e872862fec31097cfe0b6e171b343096b9644d1846d635ad7c",
  reference_metadata_path: "/Users/joel/AniFactoryData/voice_bank/proofs/2026-07-27-qwen-liam-clone-delivery-v1/liam_reference/run.json",
  reference_metadata_sha256: "4357626dda4f07e0cb22ac304e593611d9ecce080aad895b7f2a10ad0737a811",
  reference_voice_id: "am_liam",
  reference_voice_sha256: "66b65a96e16c3d91035a6e9019d9986ed524d27ce35b487270cdf61c99e3ebad",
  reference_source_provider: "kokoro_local",
  reference_source_model_id: KOKORO_MODEL_LOCK.model_id,
  reference_source_model_revision: KOKORO_MODEL_LOCK.model_revision,
  reference_origin_unit_id: "liam_clone_reference",
  voice_continuity_contract: "qwen_icl_clone_of_liam_reference",
  delivery_control: "base_icl_reference_audio_only",
  instruct_supported: false,
  speed_control_supported: false,
  native_speed: null,
  temperature: 0.6,
  top_p: 0.8,
  top_k: 50,
  repetition_penalty: 1.2,
  max_tokens: 1200,
  speaker_similarity_method: "WeSpeaker VoxCeleb ResNet34 LM cosine similarity",
  speaker_similarity_model_path: "/Users/joel/AniFactoryData/voice_bank/bakeoff/model-downloads/wespeaker/wespeaker_en_voxceleb_resnet34.onnx",
  speaker_similarity_model_sha256: "5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94",
  speaker_similarity_calibration_path: "/Users/joel/AniFactoryData/voice_bank/proofs/2026-07-27-qwen-liam-clone-delivery-v1/qwen_liam_clone/speaker_similarity.json",
  speaker_similarity_calibration_sha256: "669ce9fc2903819dff7c361f4a0a4698a9576eebb1f07869d57fbd2369303a42",
  minimum_cosine_similarity: 0.88,
  warning_below_cosine_similarity: 0.90,
  warning_floor_cosine_similarity: 0.90,
  unit_contract: QWEN_LIAM_UNIT_CONTRACT,
  stitch_contract: QWEN_LIAM_STITCH_CONTRACT,
  retry_contract: QWEN_LIAM_RETRY_CONTRACT,
});

export const QWEN_JOEL_PRIMARY_LOCK = Object.freeze({
  ...QWEN_LOCAL_MODEL_LOCK,
  voice_id: "joel_owned_narrator_clone",
  voice_sha256: "48a7ec7ab4aa2170ae368e3ba1e25964138e4958e7120f8e51f411848def5ecf",
  reference_audio_path: "/Users/joel/AniFactoryData/voice_bank/qwen/reference_samples/joel_narrator/joel_ref_02_tense_narration.wav",
  reference_audio_sha256: "4cb13c2fb887874b77125b70c020f3cfb103954246fb391a51ce99f0341d8a17",
  reference_text: "The register turned blue before the window cracked. Outside, something tall moved between the parked cars, stopped under the dead sign, and waited like it had already learned his name.",
  reference_text_sha256: "0d51ab6db4afea9f0e9341b009b5b100e280279d17752a154b6b248353df2d8d",
  reference_manifest_path: "/Users/joel/AniFactoryData/voice_bank/qwen/reference_samples/joel_narrator/manifest.json",
  reference_manifest_sha256: "ac7a784998f614d75abd9e6c2788692094ba80825edb4bea4508f899c60ea9f7",
  reference_metadata_path: "/Users/joel/AniFactoryData/voice_bank/qwen/voices/joel_owned_narrator_clone/voice.json",
  reference_metadata_sha256: "48a7ec7ab4aa2170ae368e3ba1e25964138e4958e7120f8e51f411848def5ecf",
  reference_voice_id: "joel_owned_narrator_clone",
  reference_voice_sha256: "48a7ec7ab4aa2170ae368e3ba1e25964138e4958e7120f8e51f411848def5ecf",
  reference_source_provider: "operator_owned_audio",
  reference_source_model_id: "joel_owned_voice_recording",
  reference_source_model_revision: "joel_ref_02_tense_narration_v1",
  reference_origin_unit_id: "joel_ref_02_tense_narration",
  voice_continuity_contract: "qwen_icl_clone_of_joel_owned_reference",
  delivery_control: "base_icl_reference_audio_only",
  instruct_supported: false,
  speed_control_supported: false,
  native_speed: null,
  temperature: 0.6,
  top_p: 0.8,
  top_k: 50,
  repetition_penalty: 1.2,
  max_tokens: 1200,
  speaker_similarity_method: "WeSpeaker VoxCeleb ResNet34 LM cosine similarity",
  speaker_similarity_model_path: "/Users/joel/AniFactoryData/voice_bank/bakeoff/model-downloads/wespeaker/wespeaker_en_voxceleb_resnet34.onnx",
  speaker_similarity_model_sha256: "5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94",
  speaker_similarity_calibration_path: "/Users/joel/AniFactoryData/voice_bank/qwen/reference_samples/joel_narrator/manifest.json",
  speaker_similarity_calibration_sha256: "ac7a784998f614d75abd9e6c2788692094ba80825edb4bea4508f899c60ea9f7",
  minimum_cosine_similarity: 0.88,
  warning_below_cosine_similarity: 0.90,
  warning_floor_cosine_similarity: 0.90,
  unit_contract: QWEN_LIAM_UNIT_CONTRACT,
  stitch_contract: QWEN_LIAM_STITCH_CONTRACT,
  retry_contract: QWEN_LIAM_RETRY_CONTRACT,
});

function qwenPrimaryLockForVoice(voiceId) {
  return voiceId === QWEN_LIAM_PRIMARY_LOCK.voice_id
    ? QWEN_LIAM_PRIMARY_LOCK
    : QWEN_JOEL_PRIMARY_LOCK;
}

// Retained only so already-created Kokoro/Puck identities remain readable
// through their explicit compatibility contract.
export const QWEN_LOCAL_FALLBACK_LOCK = Object.freeze({
  ...QWEN_LOCAL_MODEL_LOCK,
  reference_audio_path: "/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/am_puck/am_puck_qwen_fallback_reference_v1.wav",
  reference_audio_sha256: "934de29bed0d3da6b8c8fb2a6c611202a967498422702f8c30f85b4bb10019d0",
  reference_text: "Because a deed is not a toy. A deed is the only word in any language that means this is mine and the world has to agree. The breathing got closer. Out of the black came a shape too big to be a man and too graceful to be a beast. A broken crown curved between its horns.",
  reference_text_sha256: "2630f1d234dd38762cf538ee7b817026711f2c9642a26dd3678242647e5a720c",
  reference_text_path: "/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/am_puck/am_puck_qwen_fallback_reference_v1.txt",
  reference_text_file_sha256: "b044c91dd10a8a9f5c2363650e64b95310256dcbcdf4c91d00caf5b19b09b77f",
  reference_metadata_path: "/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/am_puck/am_puck_qwen_fallback_reference_v1.json",
  reference_metadata_sha256: "e51394242bdac5e604e629ac1a575673fb4f857a15dd32317aeeee59bddb9955",
  reference_voice_id: "am_puck",
  reference_voice_sha256: "9a8c2e56413bd2063f814cb4c3885fc425876157369117c3f8258d03c8a9ad89",
  reference_source_provider: "kokoro_local",
  reference_source_model_id: KOKORO_MODEL_LOCK.model_id,
  reference_source_model_revision: KOKORO_MODEL_LOCK.model_revision,
  reference_origin_unit_id: "stp_voice_seg_10_5_2630f1d234dd",
  voice_continuity_contract: "clone_primary_puck_identity",
  speaker_similarity_method: "WeSpeaker VoxCeleb ResNet34 LM cosine similarity",
  speaker_similarity_model_path: "/Users/joel/AniFactoryData/voice_bank/bakeoff/model-downloads/wespeaker/wespeaker_en_voxceleb_resnet34.onnx",
  speaker_similarity_model_sha256: "5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94",
  speaker_similarity_calibration_path: "/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/am_puck/am_puck_qwen_fallback_similarity_calibration_v1.json",
  speaker_similarity_calibration_sha256: "f71deace6283c58cc28564e3a40772f907d8fb1040d3d6bbe3a9b1dc3f53bb55",
  minimum_cosine_similarity: 0.88,
  warning_below_cosine_similarity: 0.90,
  warning_floor_cosine_similarity: 0.90,
  fallback_scope: "failed_units_only",
});

const TTS_PROVIDER_ALIASES = new Map([
  ["kokoro", "kokoro_local"],
  ["kokoro_local", "kokoro_local"],
  ["local_kokoro", "kokoro_local"],
  ["qwen", "qwen_local"],
  ["qwen3", "qwen_local"],
  ["qwen3_tts", "qwen_local"],
  ["qwen_local", "qwen_local"],
  ["modelslab_qwen", "modelslab_qwen"],
]);

function cleanId(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function narrationPlanRunIdentityBindingFinding(
  plan = {},
  identity = {},
  currentRunIdentitySha256 = null,
) {
  const bindingRequired = identity?.schema === "goldflow_run_identity_v2"
    && plan?.schema === "goldflow_tts_generation_plan_v2";
  if (!bindingRequired) return null;
  const expected = cleanId(currentRunIdentitySha256);
  const actual = cleanId(plan?.source_hashes?.run_identity_sha256);
  if (!expected || actual !== expected) {
    return {
      code: actual
        ? "narration_plan_run_identity_hash_stale"
        : "narration_plan_run_identity_hash_missing",
      path: "source_hashes.run_identity_sha256",
      expected,
      actual,
      message: actual
        ? "Narration plan is bound to a superseded run_identity.json hash."
        : "Narration plan is not bound to the current run_identity.json hash.",
    };
  }
  return null;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function explicitValue(...values) {
  return values.find((value) => value !== undefined);
}

export function normalizeTtsProvider(value, fallback = DEFAULT_TTS_PROVIDER) {
  const normalized = String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const provider = TTS_PROVIDER_ALIASES.get(normalized);
  if (!provider) {
    throw new Error(`Unknown TTS provider: ${value}. Expected kokoro_local, qwen_local, or modelslab_qwen.`);
  }
  return provider;
}

export function hasGenericTtsIdentity(identity = {}) {
  return Boolean(
    cleanId(identity.tts_provider)
    || cleanId(identity.voice_provider_options?.primary?.provider),
  );
}

export function hasExplicitLegacyQwenIdentity(identity = {}) {
  const voiceId = cleanId(
    identity.qwen_narrator_voice_id
    ?? identity.voice_provider_options?.qwen_narrator_voice_id,
  );
  const voicePolicy = cleanId(
    identity.qwen_narrator_voice_policy
    ?? identity.voice_provider_options?.qwen_narrator_voice_policy,
  );
  const nativeSpeed = Number(
    identity.qwen_native_speed
    ?? identity.voice_provider_options?.qwen_native_speed,
  );
  const lockedVoiceId = cleanId(identity.provider_locks?.qwen_narrator_voice_id);
  const ttsModel = cleanId(identity.model_versions?.tts_model);
  return Boolean(
    voiceId
    && voicePolicy
    && Number.isFinite(nativeSpeed)
    && nativeSpeed > 0
    && lockedVoiceId === voiceId
    && ttsModel,
  );
}

export function isLegacyQwenIdentity(identity = {}) {
  if (hasGenericTtsIdentity(identity)) return false;
  const schema = cleanId(identity.schema ?? identity.run_identity_schema);
  if (schema === "goldflow_run_identity_v2") {
    return hasExplicitLegacyQwenIdentity(identity);
  }
  return true;
}

export function narrationTtsPolicyForIdentity(identity = {}) {
  if (isLegacyQwenIdentity(identity)) {
    const nativeSpeed = positiveNumber(
      identity.voice_provider_options?.qwen_native_speed ?? identity.qwen_native_speed,
      1.25,
    );
    const voiceId = cleanId(
      identity.voice_provider_options?.qwen_narrator_voice_id
      ?? identity.qwen_narrator_voice_id
      ?? identity.narrator_voice_id,
    ) ?? "joel_owned_narrator_clone";
    return {
      contract: "legacy_qwen",
      primary: {
        provider: "modelslab_qwen",
        model_id: identity.model_versions?.tts_model ?? "qwen-tts",
        voice_id: voiceId,
        native_speed: nativeSpeed,
      },
      fallback: null,
      qa_policy: identity.voice_provider_options?.qa_policy ?? null,
      canonical_plan_filename: "qwen_generation_plan.json",
      canonical_tts_report_filename: null,
      canonical_stitch_report_filename: null,
    };
  }

  const primaryProvider = normalizeTtsProvider(
    identity.tts_provider ?? identity.voice_provider_options?.primary?.provider,
  );
  const fallbackValue = explicitValue(
    identity.tts_fallback_provider,
    identity.voice_provider_options?.fallback?.provider,
    DEFAULT_TTS_FALLBACK_PROVIDER,
  );
  const fallbackProvider = fallbackValue ? normalizeTtsProvider(fallbackValue) : null;
  const voiceId = cleanId(
    identity.narrator_voice_id
    ?? identity.tts_voice_id
    ?? identity.voice_provider_options?.primary?.voice_id,
  ) ?? DEFAULT_NARRATOR_VOICE_ID;
  const rawNativeSpeed = explicitValue(
    identity.tts_native_speed,
    identity.voice_provider_options?.primary?.native_speed,
    primaryProvider === "kokoro_local" ? LEGACY_KOKORO_NATIVE_SPEED : DEFAULT_TTS_NATIVE_SPEED,
  );
  const nativeSpeed = rawNativeSpeed == null
    ? null
    : positiveNumber(rawNativeSpeed, null);
  const contract = primaryProvider === "qwen_local"
    ? voiceId === QWEN_LIAM_PRIMARY_LOCK.voice_id
      ? "qwen_liam_primary_v1"
      : "qwen_joel_primary_v1"
    : primaryProvider === "kokoro_local"
      ? "legacy_kokoro_puck"
      : "generic_narration_v1";
  const qwenSynthesisContract = primaryProvider === "qwen_local"
    ? identity.voice_provider_options?.synthesis_contract
      ?? QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT
    : null;

  return {
    contract,
    primary: {
      ...(primaryProvider === "kokoro_local" ? KOKORO_MODEL_LOCK : {}),
      ...(primaryProvider === "qwen_local" ? qwenPrimaryLockForVoice(voiceId) : {}),
      ...(identity.voice_provider_options?.primary ?? {}),
      provider: primaryProvider,
      voice_id: voiceId,
      native_speed: nativeSpeed,
      ...(primaryProvider === "kokoro_local" ? KOKORO_VOICE_LOCKS[voiceId] ?? {} : {}),
    },
    fallback: fallbackProvider
      ? {
          ...(fallbackProvider === "qwen_local" && primaryProvider === "kokoro_local"
            ? QWEN_LOCAL_FALLBACK_LOCK
            : {}),
          ...(identity.voice_provider_options?.fallback ?? {}),
          provider: fallbackProvider,
        }
      : null,
    unit_contract: identity.voice_provider_options?.unit_contract
      ?? (primaryProvider === "qwen_local" ? QWEN_LIAM_UNIT_CONTRACT : null),
    stitch_contract: identity.voice_provider_options?.stitch_contract
      ?? (primaryProvider === "qwen_local" ? QWEN_LIAM_STITCH_CONTRACT : null),
    retry_policy: identity.voice_provider_options?.retry_policy
      ?? (primaryProvider === "qwen_local" ? QWEN_LIAM_RETRY_CONTRACT.retry_policy : null),
    retry_contract: identity.voice_provider_options?.retry_contract
      ?? (primaryProvider === "qwen_local" ? QWEN_LIAM_RETRY_CONTRACT : null),
    synthesis_contract: qwenSynthesisContract,
    qa_policy: identity.voice_provider_options?.qa_policy
      ?? identity.tts_qa_policy
      ?? NARRATION_TTS_QA_POLICY_VERSION,
    canonical_plan_filename: "narration_generation_plan.json",
    canonical_tts_report_filename: `narration_tts_report_${identity.episode ?? "ep_01"}.json`,
    canonical_stitch_report_filename: `audio_stitch_report_${identity.episode ?? "ep_01"}-narration.json`,
  };
}

function presentIdentityValues(values = []) {
  return values.filter((value) => value !== undefined && value !== null && value !== "");
}

function identityAliasFindings(values, expected, pathLabel, { required = false } = {}) {
  const present = presentIdentityValues(values);
  if (required && !present.length) {
    return [{
      code: "narration_voice_identity_missing",
      path: pathLabel,
      expected,
      actual: null,
    }];
  }
  return present
    .filter((value) => String(value) !== String(expected))
    .map((value) => ({
      code: "narration_voice_identity_mismatch",
      path: pathLabel,
      expected,
      actual: value,
    }));
}

function exactControlFindings(control, expected, pathLabel) {
  if (!control || typeof control !== "object") {
    return [{
      code: "narration_voice_identity_controls_missing",
      path: pathLabel,
      expected: "locked narration voice controls",
      actual: null,
    }];
  }
  return Object.entries(expected).flatMap(([field, value]) => (
    isDeepStrictEqual(control[field], value)
      ? []
      : [{
          code: "narration_voice_identity_control_mismatch",
          path: `${pathLabel}.${field}`,
          expected: value,
          actual: control[field] ?? null,
        }]
  ));
}

function narrationPlanUnits(plan = {}) {
  if (Array.isArray(plan.units) && plan.units.length) return plan.units;
  return (plan.segments ?? []).flatMap((segment) => (
    segment?.narration_units
    ?? segment?.tts_generation_units
    ?? segment?.qwen_generation_units
    ?? segment?.generation_units
    ?? []
  ));
}

export function narrationPlanVoiceIdentityFindings(plan = {}, policy = {}) {
  const findings = [];
  const primary = policy.primary ?? {};
  const fallback = policy.fallback ?? {};
  const topPrimary = primary.provider === "qwen_local"
    ? plan.provider_controls?.qwen3 ?? plan.provider_controls?.qwen_local
    : plan.provider_controls?.kokoro ?? plan.provider_controls?.kokoro_local
    ?? null;
  findings.push(...identityAliasFindings([
    plan.narrator_voice_id,
    topPrimary?.voice_id,
    topPrimary?.voice,
    topPrimary?.reference_voice_id,
    topPrimary?.target_voice_id,
  ], primary.voice_id, "plan narrator voice", { required: true }));
  findings.push(...identityAliasFindings([
    plan.narrator_voice_sha256,
    topPrimary?.voice_sha256,
    topPrimary?.reference_voice_sha256,
    topPrimary?.target_voice_sha256,
  ], primary.voice_sha256, "plan narrator voice hash"));

  const expectedPrimaryControls = primary.provider === "qwen_local"
    ? {
        provider: primary.provider,
        model_id: primary.model_id,
        model_revision: primary.model_revision,
        target_voice_id: primary.voice_id,
        target_voice_sha256: primary.voice_sha256,
        reference_audio_path: primary.reference_audio_path,
        reference_audio_sha256: primary.reference_audio_sha256,
        reference_transcript: primary.reference_text,
        reference_transcript_sha256: primary.reference_text_sha256,
        reference_manifest_path: primary.reference_manifest_path,
        reference_manifest_sha256: primary.reference_manifest_sha256,
        reference_metadata_path: primary.reference_metadata_path,
        reference_metadata_sha256: primary.reference_metadata_sha256,
        voice_continuity_contract: primary.voice_continuity_contract,
        delivery_control: primary.delivery_control,
        instruct_supported: false,
        instruct_submitted: false,
        instruct: null,
        speed_control_supported: false,
        native_speed: null,
        continuous_requests: false,
        ...(policy.synthesis_contract?.mode
          === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode
          ? { synthesis_contract: QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT }
          : {}),
      }
    : null;
  if (expectedPrimaryControls) {
    findings.push(...exactControlFindings(
      topPrimary,
      expectedPrimaryControls,
      "plan.provider_controls.qwen3",
    ));
  }

  const expectedFallbackControls = fallback?.provider === "qwen_local"
    ? {
        target_voice_id: primary.voice_id,
        target_voice_sha256: primary.voice_sha256,
        reference_audio_path: fallback.reference_audio_path,
        reference_audio_sha256: fallback.reference_audio_sha256,
        reference_transcript_path: fallback.reference_text_path,
        reference_transcript_sha256: fallback.reference_text_sha256,
        reference_transcript_file_sha256: fallback.reference_text_file_sha256,
        reference_metadata_path: fallback.reference_metadata_path,
        reference_metadata_sha256: fallback.reference_metadata_sha256,
        voice_continuity_contract: fallback.voice_continuity_contract,
        speaker_similarity_method: fallback.speaker_similarity_method,
        speaker_similarity_model_path: fallback.speaker_similarity_model_path,
        speaker_similarity_model_sha256: fallback.speaker_similarity_model_sha256,
        hard_minimum_cosine_similarity: fallback.minimum_cosine_similarity,
        warning_floor_cosine_similarity: fallback.warning_floor_cosine_similarity,
        fallback_scope: "exact_failed_unit_only",
        exact_unit_only: true,
        whole_episode_fallback_allowed: false,
      }
    : null;
  if (expectedFallbackControls) {
    findings.push(...exactControlFindings(
      plan.provider_controls?.qwen3 ?? plan.provider_controls?.qwen_local,
      expectedFallbackControls,
      "plan.provider_controls.qwen3",
    ));
  }

  for (const [index, unit] of narrationPlanUnits(plan).entries()) {
    const unitPath = `plan unit ${unit?.unit_id ?? index}`;
    const unitPrimary = primary.provider === "qwen_local"
      ? unit?.provider_controls?.qwen3 ?? unit?.provider_controls?.qwen_local
      : unit?.provider_controls?.kokoro ?? unit?.provider_controls?.kokoro_local
      ?? null;
    findings.push(...identityAliasFindings([
      unit?.reference_id,
      unit?.voice_id,
      unitPrimary?.voice_id,
      unitPrimary?.voice,
      unitPrimary?.reference_voice_id,
      unitPrimary?.target_voice_id,
    ], primary.voice_id, `${unitPath} voice`, { required: true }));
    findings.push(...identityAliasFindings([
      unit?.voice_sha256,
      unitPrimary?.voice_sha256,
      unitPrimary?.reference_voice_sha256,
      unitPrimary?.target_voice_sha256,
    ], primary.voice_sha256, `${unitPath} voice hash`));
    if (expectedPrimaryControls) {
      findings.push(...exactControlFindings(
        unitPrimary,
        expectedPrimaryControls,
        `${unitPath}.provider_controls.qwen3`,
      ));
    }
    if (expectedFallbackControls) {
      findings.push(...exactControlFindings(
        unit?.provider_controls?.qwen3 ?? unit?.provider_controls?.qwen_local,
        expectedFallbackControls,
        `${unitPath}.provider_controls.qwen3`,
      ));
    }
  }
  return findings;
}

export function narrationArtifactVoiceIdentityFindings({
  ttsReport = {},
  stitchReport = {},
  unitQa = {},
  policy = {},
} = {}) {
  const findings = [];
  const primary = policy.primary ?? {};
  const fallback = policy.fallback ?? {};
  findings.push(...identityAliasFindings([
    ttsReport.narrator_voice_id,
    ttsReport.primary?.voice_id,
    ttsReport.model?.voice_id,
    ttsReport.voice_id,
    stitchReport.narrator_voice_id,
    stitchReport.primary?.voice_id,
    stitchReport.voice_id,
  ], primary.voice_id, "narration report voice", { required: true }));
  findings.push(...identityAliasFindings([
    ttsReport.primary?.voice_sha256,
    ttsReport.model?.voice_sha256,
    ttsReport.voice_sha256,
    stitchReport.primary?.voice_sha256,
    stitchReport.voice_sha256,
  ], primary.voice_sha256, "narration report voice hash", { required: true }));
  if (primary.provider === "qwen_local") {
    findings.push(...exactControlFindings(ttsReport.primary, {
      provider: primary.provider,
      model_id: primary.model_id,
      model_revision: primary.model_revision,
      voice_id: primary.voice_id,
      voice_sha256: primary.voice_sha256,
      native_speed: null,
      reference_audio_sha256: primary.reference_audio_sha256,
      reference_manifest_sha256: primary.reference_manifest_sha256,
      voice_continuity_contract: primary.voice_continuity_contract,
    }, "ttsReport.primary"));
    findings.push(...exactControlFindings(stitchReport.primary, {
      provider: primary.provider,
      model_id: primary.model_id,
      model_revision: primary.model_revision,
      voice_id: primary.voice_id,
      voice_sha256: primary.voice_sha256,
      voice_continuity_contract: primary.voice_continuity_contract,
    }, "stitchReport.primary"));
  }

  const results = Array.isArray(ttsReport.results) ? ttsReport.results : [];
  const selectedUnits = Array.isArray(unitQa.selected_units) ? unitQa.selected_units : [];
  const stitchSegments = Array.isArray(stitchReport.segments) ? stitchReport.segments : [];
  for (const [label, rows] of [
    ["TTS result", results],
    ["unit QA selection", selectedUnits],
    ["stitch segment", stitchSegments],
  ]) {
    for (const [index, row] of rows.entries()) {
      const provider = row?.selected_provider ?? row?.tts_provider ?? row?.provider;
      const expectedContract = provider === fallback?.provider
        ? fallback?.voice_continuity_contract
        : primary.voice_continuity_contract ?? "native_puck_preset";
      const rowPath = `${label} ${row?.unit_id ?? index}`;
      findings.push(...identityAliasFindings(
        [row?.voice_id],
        primary.voice_id,
        `${rowPath}.voice_id`,
        { required: true },
      ));
      findings.push(...identityAliasFindings(
        [row?.voice_sha256],
        primary.voice_sha256,
        `${rowPath}.voice_sha256`,
      ));
      findings.push(...identityAliasFindings(
        [row?.voice_continuity_contract],
        expectedContract,
        `${rowPath}.voice_continuity_contract`,
        { required: true },
      ));
    }
  }

  if (fallback?.provider === "qwen_local") {
    findings.push(...exactControlFindings(ttsReport.fallback_usage, {
      provider: fallback.provider,
      target_voice_id: primary.voice_id,
      target_voice_sha256: primary.voice_sha256,
      voice_continuity_contract: fallback.voice_continuity_contract,
      reference_audio_sha256: fallback.reference_audio_sha256,
      speaker_similarity_model_sha256: fallback.speaker_similarity_model_sha256,
      speaker_similarity_calibration_sha256: fallback.speaker_similarity_calibration_sha256,
      minimum_cosine_similarity: fallback.minimum_cosine_similarity,
      warning_below_cosine_similarity: fallback.warning_below_cosine_similarity,
      exact_unit_only: true,
    }, "ttsReport.fallback_usage"));
  }
  return findings;
}

export function validateNarrationTtsPolicy(policy, { production = true } = {}) {
  if (!policy || typeof policy !== "object") throw new Error("Missing narration TTS policy.");
  if (policy.contract === "legacy_qwen") return policy;
  if (policy.contract === "legacy_kokoro_puck") {
    if (policy.primary?.provider !== "kokoro_local"
      || policy.primary.voice_id !== "am_puck") {
      throw new Error("Legacy Kokoro compatibility requires kokoro_local/am_puck.");
    }
    const exactPrimaryLock = {
      ...KOKORO_MODEL_LOCK,
      ...KOKORO_VOICE_LOCKS.am_puck,
    };
    const primaryLockFields = [
      "provider",
      "model_id",
      "model_revision",
      "model_weights_sha256",
      "model_config_sha256",
      "runtime",
      "runtime_version",
      "runtime_revision",
      "language_code",
      "sample_rate_hz",
      "voice_id",
      "voice_sha256",
    ];
    const primaryMismatches = primaryLockFields.filter(
      (field) => policy.primary?.[field] !== exactPrimaryLock[field],
    );
    if (primaryMismatches.length) {
      throw new Error(`Legacy Kokoro lock differs from its audited assets: ${primaryMismatches.join(", ")}.`);
    }
    if (Math.abs(Number(policy.primary.native_speed) - LEGACY_KOKORO_NATIVE_SPEED) > 0.0001) {
      throw new Error(`Legacy Kokoro speed must be ${LEGACY_KOKORO_NATIVE_SPEED}; got ${policy.primary.native_speed}.`);
    }
    if (production && policy.fallback?.provider !== "qwen_local") {
      throw new Error("Legacy production Kokoro narration requires its locked qwen_local fallback.");
    }
    const fallbackLockFields = [
      "provider",
      "model_id",
      "model_revision",
      "model_weights_sha256",
      "model_config_sha256",
      "generation_config_sha256",
      "speech_tokenizer_weights_sha256",
      "speech_tokenizer_config_sha256",
      "runtime",
      "runtime_version",
      "sample_rate_hz",
      "reference_audio_path",
      "reference_audio_sha256",
      "reference_text",
      "reference_text_sha256",
      "reference_text_path",
      "reference_text_file_sha256",
      "reference_metadata_path",
      "reference_metadata_sha256",
      "reference_voice_id",
      "reference_voice_sha256",
      "reference_source_provider",
      "reference_source_model_id",
      "reference_source_model_revision",
      "reference_origin_unit_id",
      "voice_continuity_contract",
      "speaker_similarity_method",
      "speaker_similarity_model_path",
      "speaker_similarity_model_sha256",
      "speaker_similarity_calibration_path",
      "speaker_similarity_calibration_sha256",
      "minimum_cosine_similarity",
      "warning_below_cosine_similarity",
      "warning_floor_cosine_similarity",
      "fallback_scope",
    ];
    const fallbackMismatches = fallbackLockFields.filter(
      (field) => policy.fallback?.[field] !== QWEN_LOCAL_FALLBACK_LOCK[field],
    );
    if (fallbackMismatches.length) {
      throw new Error(`Qwen fallback lock differs from the audited model/reference assets: ${fallbackMismatches.join(", ")}.`);
    }
  } else {
    if (!["qwen_joel_primary_v1", "qwen_liam_primary_v1"].includes(policy.contract)
      || policy.primary?.provider !== "qwen_local") {
      throw new Error(`The production narration lane requires a locked qwen_local narrator; got ${policy.primary?.provider ?? "missing"}.`);
    }
    if (![DEFAULT_NARRATOR_VOICE_ID, QWEN_LIAM_PRIMARY_LOCK.voice_id].includes(policy.primary.voice_id)) {
      throw new Error(`Narration identities require an approved locked narrator voice; got ${policy.primary.voice_id ?? "missing"}.`);
    }
    const expectedPrimaryLock = qwenPrimaryLockForVoice(policy.primary.voice_id);
    const primaryLockFields = [
      "provider",
      "model_id",
      "model_revision",
      "model_weights_sha256",
      "model_config_sha256",
      "generation_config_sha256",
      "speech_tokenizer_weights_sha256",
      "speech_tokenizer_config_sha256",
      "runtime",
      "runtime_version",
      "sample_rate_hz",
      "voice_id",
      "voice_sha256",
      "reference_audio_path",
      "reference_audio_sha256",
      "reference_text",
      "reference_text_sha256",
      "reference_manifest_path",
      "reference_manifest_sha256",
      "reference_metadata_path",
      "reference_metadata_sha256",
      "reference_voice_id",
      "reference_voice_sha256",
      "reference_source_provider",
      "reference_source_model_id",
      "reference_source_model_revision",
      "reference_origin_unit_id",
      "voice_continuity_contract",
      "delivery_control",
      "instruct_supported",
      "speed_control_supported",
      "native_speed",
      "temperature",
      "top_p",
      "top_k",
      "repetition_penalty",
      "max_tokens",
      "speaker_similarity_method",
      "speaker_similarity_model_path",
      "speaker_similarity_model_sha256",
      "speaker_similarity_calibration_path",
      "speaker_similarity_calibration_sha256",
      "minimum_cosine_similarity",
      "warning_below_cosine_similarity",
      "warning_floor_cosine_similarity",
    ];
    const primaryMismatches = primaryLockFields.filter(
      (field) => policy.primary?.[field] !== expectedPrimaryLock[field],
    );
    if (primaryMismatches.length) {
      throw new Error(`Qwen narrator production lock differs from the audited model/reference assets: ${primaryMismatches.join(", ")}.`);
    }
    if (policy.fallback != null) {
      throw new Error("Qwen Liam is the sole production voice; fallback must be null.");
    }
    if (policy.primary.native_speed != null
      || policy.primary.speed_control_supported !== false) {
      throw new Error("Qwen Liam production does not support a native-speed control.");
    }
    if (JSON.stringify(policy.unit_contract) !== JSON.stringify(QWEN_LIAM_UNIT_CONTRACT)
      || JSON.stringify(policy.primary.unit_contract) !== JSON.stringify(QWEN_LIAM_UNIT_CONTRACT)) {
      throw new Error("Qwen Liam unit contract must be sentence-complete, target 45-60 words, hard maximum 60, and non-continuous.");
    }
    if (JSON.stringify(policy.stitch_contract) !== JSON.stringify(QWEN_LIAM_STITCH_CONTRACT)
      || JSON.stringify(policy.primary.stitch_contract) !== JSON.stringify(QWEN_LIAM_STITCH_CONTRACT)) {
      throw new Error("Qwen Liam stitch contract must use 80 ms joins and no post-tempo processing.");
    }
    if (policy.retry_policy !== QWEN_LIAM_RETRY_CONTRACT.retry_policy
      || JSON.stringify(policy.retry_contract) !== JSON.stringify(QWEN_LIAM_RETRY_CONTRACT)
      || JSON.stringify(policy.primary.retry_contract) !== JSON.stringify(QWEN_LIAM_RETRY_CONTRACT)) {
      throw new Error("Qwen Liam retry contract permits retries only for confirmed skips, truncations, or stutters; uncertain ASR findings are non-blocking.");
    }
    const supportedSynthesisContracts = [
      QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT,
      QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
    ];
    if (!supportedSynthesisContracts.some(
      (contract) => JSON.stringify(policy.synthesis_contract) === JSON.stringify(contract),
    )) {
      throw new Error(
        "Qwen Liam synthesis must use either the legacy serial-unit contract "
        + "or the locked deterministic length-matched batch-four contract.",
      );
    }
  }
  if (policy.qa_policy !== NARRATION_TTS_QA_POLICY_VERSION) {
    throw new Error(`Narration QA policy must be ${NARRATION_TTS_QA_POLICY_VERSION}; got ${policy.qa_policy ?? "missing"}.`);
  }
  return policy;
}

export function defaultNarrationVoiceProviderOptions({
  provider = DEFAULT_TTS_PROVIDER,
  fallbackProvider = DEFAULT_TTS_FALLBACK_PROVIDER,
  voiceId = DEFAULT_NARRATOR_VOICE_ID,
  nativeSpeed = DEFAULT_TTS_NATIVE_SPEED,
} = {}) {
  const primaryProvider = normalizeTtsProvider(provider);
  const fallback = fallbackProvider ? normalizeTtsProvider(fallbackProvider) : null;
  if (primaryProvider === "kokoro_local") {
    if (voiceId !== "am_puck") {
      throw new Error(`Legacy Kokoro compatibility requires am_puck; ${voiceId ?? "missing"} is not valid.`);
    }
    if (fallback !== "qwen_local") {
      throw new Error("Legacy Kokoro compatibility requires qwen_local fallback.");
    }
    if (Math.abs(Number(nativeSpeed) - LEGACY_KOKORO_NATIVE_SPEED) > 0.0001) {
      throw new Error(`Legacy Kokoro compatibility requires speed ${LEGACY_KOKORO_NATIVE_SPEED}.`);
    }
    return {
      primary: {
        ...KOKORO_MODEL_LOCK,
        ...KOKORO_VOICE_LOCKS.am_puck,
        native_speed: LEGACY_KOKORO_NATIVE_SPEED,
      },
      fallback: QWEN_LOCAL_FALLBACK_LOCK,
      qa_policy: NARRATION_TTS_QA_POLICY_VERSION,
      pace_strategy: "provider_native_speed_no_post_tempo",
      narrator_identity_policy: "legacy_single_voice_puck_with_puck_cloned_qwen_repair",
      allowed_production_voice_ids: ["am_puck"],
    };
  }
  if (primaryProvider !== DEFAULT_TTS_PROVIDER) {
    throw new Error(`New generic run identities require ${DEFAULT_TTS_PROVIDER}.`);
  }
  if (voiceId !== DEFAULT_NARRATOR_VOICE_ID) {
    throw new Error(`New narration identities require ${DEFAULT_NARRATOR_VOICE_ID}; ${voiceId ?? "missing"} is not selectable for production.`);
  }
  if (fallback !== null) {
    throw new Error("Qwen Liam is the sole production voice; fallback must be null.");
  }
  if (nativeSpeed != null) {
    throw new Error("Qwen Liam has no native-speed control; omit nativeSpeed.");
  }
  return {
    primary: QWEN_JOEL_PRIMARY_LOCK,
    fallback: null,
    qa_policy: NARRATION_TTS_QA_POLICY_VERSION,
    pace_strategy: "qwen_reference_native_cadence_no_speed_no_post_tempo",
    narrator_identity_policy: "single_voice_qwen_joel_owned_icl",
    allowed_production_voice_ids: [DEFAULT_NARRATOR_VOICE_ID],
    unit_contract: QWEN_LIAM_UNIT_CONTRACT,
    stitch_contract: QWEN_LIAM_STITCH_CONTRACT,
    retry_policy: QWEN_LIAM_RETRY_CONTRACT.retry_policy,
    retry_contract: QWEN_LIAM_RETRY_CONTRACT,
    synthesis_contract: QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  };
}
