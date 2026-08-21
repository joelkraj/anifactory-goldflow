import { createHash } from "node:crypto";

export const NARRATION_PROVIDER_UNIT_ASR_CONTRACT_SCHEMA =
  "goldflow_narration_provider_unit_asr_contract_v1";
export const NARRATION_PROVIDER_UNIT_ASR_REUSE_BINDING_SCHEMA =
  "goldflow_narration_provider_unit_asr_reuse_binding_v1";
export const NARRATION_PROVIDER_UNIT_ASR_REUSE_POLICY =
  "exact_audio_quality_policy_and_asr_contract_v1";

function canonicalize(value, omittedKeys = new Set()) {
  if (Array.isArray(value)) {
    return value.map((child) => canonicalize(child, omittedKeys));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !omittedKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child, omittedKeys)]),
  );
}

function contentSha256(value, omittedKeys = []) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value, new Set(omittedKeys))))
    .digest("hex");
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/u.test(String(value ?? ""));
}

function validRecognitionWords(words) {
  if (!Array.isArray(words) || !words.length) return false;
  let priorStartSec = -1;
  return words.every((word) => {
    const text = String(word?.word ?? "").trim();
    const startSec = Number(word?.start_sec);
    const endSec = Number(word?.end_sec);
    const valid = Boolean(text)
      && Number.isFinite(startSec)
      && Number.isFinite(endSec)
      && startSec >= 0
      && endSec >= startSec
      && startSec >= priorStartSec;
    priorStartSec = startSec;
    return valid;
  });
}

export function buildNarrationProviderUnitAsrContract({
  model,
  device = "cpu",
  computeType = "int8_float32",
} = {}) {
  const contract = {
    schema: NARRATION_PROVIDER_UNIT_ASR_CONTRACT_SCHEMA,
    engine: "faster_whisper",
    task: "transcribe",
    model: String(model ?? ""),
    device: String(device ?? ""),
    compute_type: String(computeType ?? ""),
    language: "en",
    word_timestamps: true,
    vad_filter: false,
    beam_size: 5,
    condition_on_previous_text: false,
  };
  return {
    ...contract,
    contract_sha256: contentSha256(contract),
  };
}

function validAsrContract(contract) {
  return contract?.schema === NARRATION_PROVIDER_UNIT_ASR_CONTRACT_SCHEMA
    && contract?.engine === "faster_whisper"
    && contract?.task === "transcribe"
    && Boolean(String(contract?.model ?? "").trim())
    && Boolean(String(contract?.device ?? "").trim())
    && Boolean(String(contract?.compute_type ?? "").trim())
    && contract?.language === "en"
    && contract?.word_timestamps === true
    && contract?.vad_filter === false
    && contract?.beam_size === 5
    && contract?.condition_on_previous_text === false
    && contract?.contract_sha256 === contentSha256(contract, ["contract_sha256"]);
}

function transcriptMatchesContract(transcript, contract) {
  return transcript?.engine === contract?.engine
    && transcript?.model === contract?.model
    && transcript?.device === contract?.device
    && transcript?.compute_type === contract?.compute_type
    && transcript?.asr_contract_sha256 === contract?.contract_sha256
    && transcript?.asr_contract?.contract_sha256 === contract?.contract_sha256
    && validAsrContract(transcript?.asr_contract)
    && String(transcript?.recognized_text ?? "").trim().length > 0
    && validRecognitionWords(transcript?.recognized_words);
}

export function bindNarrationProviderUnitAsrReuse({
  providerUnitQa,
  unitId,
  audioSha256,
  narrationQualityContractSha256,
} = {}) {
  if (!providerUnitQa || typeof providerUnitQa !== "object") return null;
  const qa = structuredClone(providerUnitQa);
  const transcript = qa.transcript;
  const asrContract = transcript?.asr_contract;
  if (!validSha256(audioSha256)
    || qa.audio_sha256 !== audioSha256
    || !validSha256(narrationQualityContractSha256)
    || !String(qa.policy_version ?? "").trim()
    || !transcriptMatchesContract(transcript, asrContract)) {
    delete qa.primary_asr_reuse_binding;
    return qa;
  }
  const binding = {
    schema: NARRATION_PROVIDER_UNIT_ASR_REUSE_BINDING_SCHEMA,
    reuse_policy: NARRATION_PROVIDER_UNIT_ASR_REUSE_POLICY,
    unit_id: String(unitId ?? ""),
    audio_sha256: audioSha256,
    narration_quality_contract_sha256: narrationQualityContractSha256,
    provider_unit_qa_policy_version: qa.policy_version,
    asr_contract_sha256: asrContract.contract_sha256,
    recognized_text_sha256: contentSha256(String(transcript.recognized_text)),
    recognized_words_sha256: contentSha256(transcript.recognized_words),
  };
  qa.primary_asr_reuse_binding = {
    ...binding,
    binding_sha256: contentSha256(binding),
  };
  return qa;
}

export function validateNarrationProviderUnitAsrReuse({
  unitId,
  audioSha256,
  audioHashVerified = false,
  providerUnitQa,
  providerUnitQaSha256,
  narrationQualityContractSha256,
  expectedAsrContract,
  providerUnitQaContentSha256 = contentSha256,
} = {}) {
  const findings = [];
  const qa = providerUnitQa;
  const transcript = qa?.transcript;
  const binding = qa?.primary_asr_reuse_binding;
  const expectedContract = expectedAsrContract;
  if (audioHashVerified !== true
    || !validSha256(audioSha256)
    || qa?.audio_sha256 !== audioSha256
    || binding?.audio_sha256 !== audioSha256) {
    findings.push({ code: "provider_unit_asr_audio_binding_invalid" });
  }
  if (!validSha256(providerUnitQaSha256)
    || providerUnitQaSha256 !== providerUnitQaContentSha256(qa)) {
    findings.push({ code: "provider_unit_asr_qa_payload_hash_invalid" });
  }
  if (!validSha256(narrationQualityContractSha256)
    || binding?.narration_quality_contract_sha256
      !== narrationQualityContractSha256) {
    findings.push({ code: "provider_unit_asr_quality_contract_binding_invalid" });
  }
  if (!String(qa?.policy_version ?? "").trim()
    || binding?.provider_unit_qa_policy_version !== qa?.policy_version
    || binding?.reuse_policy !== NARRATION_PROVIDER_UNIT_ASR_REUSE_POLICY) {
    findings.push({ code: "provider_unit_asr_policy_binding_invalid" });
  }
  if (binding?.schema !== NARRATION_PROVIDER_UNIT_ASR_REUSE_BINDING_SCHEMA
    || binding?.unit_id !== String(unitId ?? "")
    || binding?.binding_sha256 !== contentSha256(binding, ["binding_sha256"])) {
    findings.push({ code: "provider_unit_asr_reuse_binding_invalid" });
  }
  if (!validAsrContract(expectedContract)
    || !validAsrContract(transcript?.asr_contract)
    || transcript?.asr_contract_sha256 !== expectedContract?.contract_sha256
    || binding?.asr_contract_sha256 !== expectedContract?.contract_sha256
    || transcript?.asr_contract?.contract_sha256
      !== expectedContract?.contract_sha256
    || !transcriptMatchesContract(transcript, expectedContract)) {
    findings.push({ code: "provider_unit_asr_contract_mismatch" });
  }
  if (binding?.recognized_text_sha256
      !== contentSha256(String(transcript?.recognized_text ?? ""))
    || binding?.recognized_words_sha256
      !== contentSha256(transcript?.recognized_words)
    || !String(transcript?.recognized_text ?? "").trim()
    || !validRecognitionWords(transcript?.recognized_words)) {
    findings.push({ code: "provider_unit_asr_recognition_incomplete_or_stale" });
  }
  return {
    status: findings.length ? "fresh_asr_required" : "reused",
    findings,
    recognition: findings.length ? null : {
      text: transcript.recognized_text,
      words: structuredClone(transcript.recognized_words),
      language: transcript.language ?? "en",
      language_probability: transcript.language_probability ?? null,
      reused: true,
      reuse_source: "provider_unit_qa_exact_bound_small_asr",
      asr_contract_sha256: expectedContract.contract_sha256,
      provider_unit_qa_sha256: providerUnitQaSha256,
    },
  };
}
