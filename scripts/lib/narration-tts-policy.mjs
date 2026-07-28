export const DEFAULT_TTS_PROVIDER = "kokoro_local";
export const DEFAULT_TTS_FALLBACK_PROVIDER = "qwen_local";
export const DEFAULT_NARRATOR_VOICE_ID = "am_puck";
export const DEFAULT_TTS_NATIVE_SPEED = 1.2;
export const NARRATION_TTS_QA_POLICY_VERSION = "narration_tts_qa_v1";

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

export const QWEN_LOCAL_FALLBACK_LOCK = Object.freeze({
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
  reference_audio_path: "/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/am_puck/am_puck_qwen_fallback_reference_v1.wav",
  reference_audio_sha256: "934de29bed0d3da6b8c8fb2a6c611202a967498422702f8c30f85b4bb10019d0",
  reference_text: "Because a deed is not a toy. A deed is the only word in any language that means this is mine and the world has to agree. The breathing got closer. Out of the black came a shape too big to be a man and too graceful to be a beast. A broken crown curved between its horns.",
  reference_text_sha256: "2630f1d234dd38762cf538ee7b817026711f2c9642a26dd3678242647e5a720c",
  reference_text_path: "/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/am_puck/am_puck_qwen_fallback_reference_v1.txt",
  reference_text_file_sha256: "b044c91dd10a8a9f5c2363650e64b95310256dcbcdf4c91d00caf5b19b09b77f",
  reference_metadata_path: "/Users/joel/AniFactoryData/voice_bank/kokoro/reference_samples/am_puck/am_puck_qwen_fallback_reference_v1.json",
  reference_metadata_sha256: "e51394242bdac5e604e629ac1a575673fb4f857a15dd32317aeeee59bddb9955",
  reference_voice_id: DEFAULT_NARRATOR_VOICE_ID,
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

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
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
  const fallbackValue = identity.tts_fallback_provider
    ?? identity.voice_provider_options?.fallback?.provider
    ?? DEFAULT_TTS_FALLBACK_PROVIDER;
  const fallbackProvider = fallbackValue ? normalizeTtsProvider(fallbackValue) : null;
  const voiceId = cleanId(
    identity.narrator_voice_id
    ?? identity.tts_voice_id
    ?? identity.voice_provider_options?.primary?.voice_id,
  ) ?? DEFAULT_NARRATOR_VOICE_ID;
  const nativeSpeed = positiveNumber(
    identity.tts_native_speed ?? identity.voice_provider_options?.primary?.native_speed,
    DEFAULT_TTS_NATIVE_SPEED,
  );

  return {
    contract: "generic_narration_v1",
    primary: {
      ...(primaryProvider === "kokoro_local" ? KOKORO_MODEL_LOCK : {}),
      ...(identity.voice_provider_options?.primary ?? {}),
      provider: primaryProvider,
      voice_id: voiceId,
      native_speed: nativeSpeed,
      ...(KOKORO_VOICE_LOCKS[voiceId] ?? {}),
    },
    fallback: fallbackProvider
      ? {
          ...(fallbackProvider === "qwen_local" ? QWEN_LOCAL_FALLBACK_LOCK : {}),
          ...(identity.voice_provider_options?.fallback ?? {}),
          provider: fallbackProvider,
        }
      : null,
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
      code: "narration_fallback_identity_controls_missing",
      path: pathLabel,
      expected: "locked Puck fallback controls",
      actual: null,
    }];
  }
  return Object.entries(expected).flatMap(([field, value]) => (
    control[field] === value
      ? []
      : [{
          code: "narration_fallback_identity_control_mismatch",
          path: `${pathLabel}.${field}`,
          expected: value,
          actual: control[field] ?? null,
        }]
  ));
}

function narrationPlanUnits(plan = {}) {
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
  const topKokoro = plan.provider_controls?.kokoro
    ?? plan.provider_controls?.kokoro_local
    ?? null;
  findings.push(...identityAliasFindings([
    plan.narrator_voice_id,
    topKokoro?.voice_id,
    topKokoro?.voice,
  ], primary.voice_id, "plan narrator voice", { required: true }));
  findings.push(...identityAliasFindings([
    plan.narrator_voice_sha256,
    topKokoro?.voice_sha256,
  ], primary.voice_sha256, "plan narrator voice hash"));

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
    const kokoro = unit?.provider_controls?.kokoro
      ?? unit?.provider_controls?.kokoro_local
      ?? null;
    findings.push(...identityAliasFindings([
      unit?.reference_id,
      unit?.voice_id,
      kokoro?.voice_id,
      kokoro?.voice,
    ], primary.voice_id, `${unitPath} voice`, { required: true }));
    findings.push(...identityAliasFindings([
      unit?.voice_sha256,
      kokoro?.voice_sha256,
    ], primary.voice_sha256, `${unitPath} voice hash`));
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
      const expectedContract = provider === fallback.provider
        ? fallback.voice_continuity_contract
        : "native_puck_preset";
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

  if (fallback.provider === "qwen_local") {
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
  if (policy.primary?.provider !== "kokoro_local") {
    throw new Error(`The production narration lane currently requires kokoro_local primary; got ${policy.primary?.provider ?? "missing"}.`);
  }
  if (policy.primary.voice_id !== DEFAULT_NARRATOR_VOICE_ID) {
    throw new Error(`New narration identities require the single locked narrator voice ${DEFAULT_NARRATOR_VOICE_ID}; got ${policy.primary.voice_id ?? "missing"}. Other Kokoro presets are bakeoff-only.`);
  }
  const exactPrimaryLock = {
    ...KOKORO_MODEL_LOCK,
    ...KOKORO_VOICE_LOCKS[policy.primary.voice_id],
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
    throw new Error(`Kokoro production lock differs from the audited model/voice assets: ${primaryMismatches.join(", ")}.`);
  }
  if (production && policy.fallback?.provider !== "qwen_local") {
    throw new Error("Production Kokoro narration requires qwen_local as the locked fallback provider.");
  }
  if (Math.abs(Number(policy.primary.native_speed) - DEFAULT_TTS_NATIVE_SPEED) > 0.0001) {
    throw new Error(`Kokoro production speed must be ${DEFAULT_TTS_NATIVE_SPEED}; got ${policy.primary.native_speed}.`);
  }
  if (policy.fallback?.provider === "qwen_local") {
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
  if (primaryProvider !== "kokoro_local") {
    throw new Error("New generic run identities currently support Kokoro as the primary production provider.");
  }
  if (voiceId !== DEFAULT_NARRATOR_VOICE_ID) {
    throw new Error(`New narration identities require ${DEFAULT_NARRATOR_VOICE_ID}; ${voiceId ?? "missing"} is not selectable for production.`);
  }
  if (fallback !== DEFAULT_TTS_FALLBACK_PROVIDER) {
    throw new Error(`New narration identities require ${DEFAULT_TTS_FALLBACK_PROVIDER} as the exact-unit voice-continuity fallback.`);
  }
  const voice = KOKORO_VOICE_LOCKS[voiceId];
  if (!voice) throw new Error(`Unapproved Kokoro voice: ${voiceId}`);
  return {
    primary: {
      ...KOKORO_MODEL_LOCK,
      ...voice,
      provider: primaryProvider,
      voice_id: voiceId,
      native_speed: nativeSpeed,
    },
    fallback: fallback
      ? {
          ...(fallback === "qwen_local" ? QWEN_LOCAL_FALLBACK_LOCK : {}),
          provider: fallback,
        }
      : null,
    qa_policy: NARRATION_TTS_QA_POLICY_VERSION,
    pace_strategy: "provider_native_speed_no_post_tempo",
    narrator_identity_policy: "single_voice_puck_with_puck_cloned_qwen_repair",
    allowed_production_voice_ids: [DEFAULT_NARRATOR_VOICE_ID],
  };
}
