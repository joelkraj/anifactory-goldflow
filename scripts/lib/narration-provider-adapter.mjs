import { createHash } from "node:crypto";
import {
  bindNarrationProviderUnitAsrReuse,
} from "./narration-provider-unit-asr-reuse.mjs";

export const NARRATION_PROVIDER_OUTPUT_SCHEMA =
  "goldflow_narration_provider_output_manifest_v1";
export const NARRATION_SYNTHESIS_IDENTITY_SCHEMA =
  "goldflow_narration_synthesis_identity_v1";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

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

function canonicalSha256(value, omittedKeys = []) {
  return sha256(JSON.stringify(canonicalize(value, new Set(omittedKeys))));
}

export function narrationProviderUnitQaSha256(value) {
  return canonicalSha256(value);
}

const ADAPTERS = {
  qwen_local: {
    adapter_id: "qwen_local_base_icl_v2",
    supports: {
      exact_text: true,
      punctuation: true,
      reference_audio: true,
      reference_text: true,
      natural_language_instruction: false,
      style_tags: false,
      native_speed: false,
      seed: true,
      batch: true,
    },
  },
  fish_audio: {
    adapter_id: "fish_audio_capability_adapter_v1",
    supports: {
      exact_text: true,
      punctuation: true,
      reference_audio: true,
      reference_text: false,
      natural_language_instruction: true,
      style_tags: true,
      native_speed: true,
      seed: false,
      batch: false,
    },
  },
  elevenlabs: {
    adapter_id: "elevenlabs_capability_adapter_v1",
    supports: {
      exact_text: true,
      punctuation: true,
      reference_audio: false,
      reference_text: false,
      natural_language_instruction: true,
      style_tags: true,
      native_speed: true,
      seed: true,
      batch: false,
    },
  },
  generic_tts: {
    adapter_id: "generic_tts_minimum_capability_v1",
    supports: {
      exact_text: true,
      punctuation: true,
      reference_audio: false,
      reference_text: false,
      natural_language_instruction: false,
      style_tags: false,
      native_speed: false,
      seed: false,
      batch: false,
    },
  },
};

const PROVIDER_ALIASES = new Map([
  ["qwen", "qwen_local"],
  ["qwen3", "qwen_local"],
  ["qwen_local", "qwen_local"],
  ["fish", "fish_audio"],
  ["fish_api", "fish_audio"],
  ["fish_audio", "fish_audio"],
  ["eleven", "elevenlabs"],
  ["eleven_labs", "elevenlabs"],
  ["elevenlabs", "elevenlabs"],
  ["generic", "generic_tts"],
  ["generic_tts", "generic_tts"],
  ["provider_neutral", "generic_tts"],
]);

export function narrationProviderAdapter(provider) {
  const key = PROVIDER_ALIASES.get(String(provider ?? "").trim().toLowerCase())
    ?? "generic_tts";
  return { provider: key, ...ADAPTERS[key] };
}

function normalizedPerformanceIntent(intent = {}) {
  return {
    energy: intent.energy ?? "controlled",
    tension: intent.tension ?? "neutral",
    intimacy: intent.intimacy ?? "standard",
    pace: intent.pace ?? "steady",
    emphasis: Array.isArray(intent.emphasis) ? intent.emphasis : [],
    pause_strategy: intent.pause_strategy ?? "punctuation_led",
  };
}

function performanceInstruction(intent) {
  const emphasis = intent.emphasis.length
    ? ` Emphasize: ${intent.emphasis.join(", ")}.`
    : "";
  return `Narrate with ${intent.energy} energy, ${intent.tension} tension, ${intent.intimacy} intimacy, and a ${intent.pace} pace. Use ${intent.pause_strategy} pauses.${emphasis}`;
}

export function compileNarrationProviderRequest(unit, {
  provider,
  modelId = null,
  modelRevision = null,
  voiceId = null,
  voiceSha256 = null,
  voiceContinuityContract = null,
  referenceAudioPath = null,
  referenceText = null,
  seed = null,
  nativeSpeed = null,
} = {}) {
  const adapter = narrationProviderAdapter(provider);
  const intent = normalizedPerformanceIntent(unit.performance_intent);
  const losses = [];
  const request = {
    adapter_id: adapter.adapter_id,
    provider: adapter.provider,
    unit_id: unit.unit_id,
    text: unit.spoken_text ?? unit.tts_spoken_text,
    model_id: modelId,
    model_revision: modelRevision,
    voice_id: voiceId,
    voice_sha256: voiceSha256,
    voice_continuity_contract: voiceContinuityContract,
  };
  if (adapter.supports.reference_audio && referenceAudioPath) {
    request.reference_audio_path = referenceAudioPath;
  } else if (referenceAudioPath) {
    losses.push({ control: "reference_audio", reason: "provider_capability_unsupported" });
  }
  if (adapter.supports.reference_text && referenceText) {
    request.reference_text = referenceText;
  } else if (referenceText) {
    losses.push({ control: "reference_text", reason: "provider_capability_unsupported" });
  }
  if (adapter.supports.natural_language_instruction) {
    request.instruction = performanceInstruction(intent);
  } else {
    losses.push({
      control: "performance_intent",
      reason: "provider_has_no_instruction_channel",
      retained_controls: ["punctuation", "unit_boundaries", "reference_style_if_available"],
    });
  }
  if (adapter.supports.style_tags && Array.isArray(unit?.performance_intent?.style_tags)) {
    request.style_tags = [...new Set(
      unit.performance_intent.style_tags.map(String).map((value) => value.trim()).filter(Boolean),
    )];
  }
  if (adapter.supports.seed && Number.isInteger(seed)) request.seed = seed;
  if (adapter.supports.native_speed && Number.isFinite(nativeSpeed)) {
    request.native_speed = nativeSpeed;
  } else if (nativeSpeed != null) {
    losses.push({ control: "native_speed", reason: "provider_capability_unsupported" });
  }
  const requestSha256 = canonicalSha256(request);
  const synthesisIdentity = buildNarrationSynthesisIdentity({
    provider: adapter.provider,
    adapterId: adapter.adapter_id,
    modelId,
    modelRevision,
    voiceId,
    voiceSha256,
    voiceContinuityContract,
    unitId: unit.unit_id,
    spokenTextSha256: sha256(request.text),
    providerRequestSha256: requestSha256,
  });
  return {
    status: "compiled",
    adapter,
    performance_intent: intent,
    request,
    request_sha256: requestSha256,
    synthesis_identity: synthesisIdentity,
    synthesis_identity_sha256: narrationSynthesisIdentitySha256(synthesisIdentity),
    capability_losses: losses,
  };
}

export function buildNarrationSynthesisIdentity({
  provider,
  adapterId = null,
  modelId = null,
  modelRevision = null,
  voiceId = null,
  voiceSha256 = null,
  voiceContinuityContract = null,
  unitId,
  spokenTextSha256,
  providerRequestSha256,
} = {}) {
  const adapter = narrationProviderAdapter(provider);
  return {
    schema: NARRATION_SYNTHESIS_IDENTITY_SCHEMA,
    adapter_id: adapterId ?? adapter.adapter_id,
    provider: adapter.provider,
    model_id: modelId,
    model_revision: modelRevision,
    voice_id: voiceId,
    voice_sha256: voiceSha256,
    voice_continuity_contract: voiceContinuityContract,
    unit_id: unitId,
    spoken_text_sha256: spokenTextSha256,
    provider_request_sha256: providerRequestSha256,
  };
}

export function narrationSynthesisIdentitySha256(value) {
  return canonicalSha256(value, ["synthesis_identity_sha256"]);
}

export function narrationProviderRequestSha256(value) {
  return canonicalSha256(value);
}

export function buildNarrationProviderOutputManifest({
  provider,
  modelId = null,
  modelRevision = null,
  voiceId = null,
  voiceSha256 = null,
  voiceContinuityContract = null,
  generationPlanSha256 = null,
  generationPlanFileSha256 = null,
  qualityContractSha256 = null,
  providerExecution = null,
  units = [],
  results = [],
} = {}) {
  const adapter = narrationProviderAdapter(provider);
  const resultById = new Map(
    results.map((row) => [String(row?.unit_id ?? ""), row]),
  );
  const rows = units.map((unit, orderIndex) => {
    const unitId = String(unit?.unit_id ?? "");
    const result = resultById.get(unitId) ?? null;
    const spokenText = String(unit?.spoken_text ?? unit?.tts_spoken_text ?? "");
    const providerUnitQa = result?.unit_qa
      ? bindNarrationProviderUnitAsrReuse({
          providerUnitQa: result.unit_qa,
          unitId,
          audioSha256: result?.audio_sha256
            ?? result?.unit_qa?.audio_sha256
            ?? null,
          narrationQualityContractSha256: qualityContractSha256,
        })
      : null;
    return {
      unit_id: unitId,
      order_index: orderIndex,
      provider: adapter.provider,
      adapter_id: adapter.adapter_id,
      model_id: result?.model_id ?? modelId,
      model_revision: result?.model_revision ?? modelRevision,
      voice_id: result?.voice_id ?? voiceId,
      voice_sha256: result?.voice_sha256 ?? voiceSha256,
      voice_continuity_contract:
        result?.voice_continuity_contract ?? voiceContinuityContract,
      spoken_text_sha256: sha256(spokenText),
      provider_request_sha256: unit?.provider_request
        ? canonicalSha256(unit.provider_request)
        : null,
      provider_request_synthesis_identity_sha256:
        unit?.provider_request?.synthesis_identity_sha256 ?? null,
      status: result?.status === "failed" || !result ? "failed" : "accepted",
      audio_path: result?.audio_path ?? result?.wav ?? null,
      audio_sha256: result?.audio_sha256
        ?? result?.unit_qa?.audio_sha256
        ?? null,
      duration_sec: Number.isFinite(Number(result?.duration_sec))
        ? Number(result.duration_sec)
        : null,
      token_limit_reached: result?.token_limit_reached === true,
      attempt: Number.isInteger(Number(result?.attempt))
        ? Number(result.attempt)
        : 1,
      synthesis_mode: result?.synthesis_mode ?? null,
      batch_plan_sha256: result?.batch_plan_sha256 ?? null,
      cohort_id: result?.cohort_id ?? null,
      cohort_sha256: result?.cohort_sha256 ?? null,
      generated_token_count: Number.isFinite(Number(result?.generated_token_count))
        ? Number(result.generated_token_count)
        : null,
      effective_token_limit: Number.isFinite(Number(result?.effective_token_limit))
        ? Number(result.effective_token_limit)
        : null,
      recovery_provenance: result?.recovery_provenance ?? null,
      synthesis_identity: result?.synthesis_identity
        ?? unit?.provider_request?.synthesis_identity
        ?? null,
      synthesis_identity_sha256: result?.synthesis_identity_sha256
        ?? unit?.provider_request?.synthesis_identity_sha256
        ?? null,
      runner_report_path: result?.runner_report_path ?? null,
      runner_report_sha256: result?.runner_report_sha256 ?? null,
      provider_receipt: result?.provider_receipt ?? null,
      provider_unit_qa: providerUnitQa
        ? structuredClone(providerUnitQa)
        : null,
      provider_unit_qa_sha256: providerUnitQa
        ? narrationProviderUnitQaSha256(providerUnitQa)
        : null,
    };
  });
  const manifest = {
    schema: NARRATION_PROVIDER_OUTPUT_SCHEMA,
    status: "pending_validation",
    provider: adapter.provider,
    adapter_id: adapter.adapter_id,
    model_id: modelId,
    model_revision: modelRevision,
    voice_id: voiceId,
    voice_sha256: voiceSha256,
    voice_continuity_contract: voiceContinuityContract,
    narration_generation_plan_sha256: generationPlanSha256,
    narration_generation_plan_file_sha256: generationPlanFileSha256,
    narration_quality_contract_sha256: qualityContractSha256,
    provider_execution: providerExecution,
    unit_count: rows.length,
    units: rows,
  };
  const validation = validateNarrationProviderOutputManifest(manifest, units, {
    generationPlanSha256,
    generationPlanFileSha256,
    qualityContractSha256,
  });
  manifest.status = validation.status;
  manifest.validation = validation;
  manifest.manifest_sha256 = narrationProviderOutputManifestSha256(manifest);
  return manifest;
}

export function narrationProviderOutputManifestSha256(value) {
  return canonicalSha256(value ?? {}, ["manifest_sha256"]);
}

export function validateNarrationProviderOutputManifest(
  manifest,
  expectedUnits = [],
  {
    generationPlanSha256 = null,
    generationPlanFileSha256 = null,
    qualityContractSha256 = null,
    provider = null,
    voiceId = null,
    voiceSha256 = null,
  } = {},
) {
  const findings = [];
  const adapter = narrationProviderAdapter(manifest?.provider);
  if (manifest?.schema !== NARRATION_PROVIDER_OUTPUT_SCHEMA) {
    findings.push({ code: "narration_provider_output_schema_invalid" });
  }
  if (manifest?.provider !== adapter.provider
    || manifest?.adapter_id !== adapter.adapter_id) {
    findings.push({ code: "narration_provider_output_adapter_identity_mismatch" });
  }
  for (const [field, value] of [
    ["model_id", manifest?.model_id],
    ["model_revision", manifest?.model_revision],
    ["voice_id", manifest?.voice_id],
    ["voice_sha256", manifest?.voice_sha256],
    ["voice_continuity_contract", manifest?.voice_continuity_contract],
  ]) {
    if (!String(value ?? "").trim()) {
      findings.push({ code: "narration_provider_output_identity_field_missing", field });
    }
  }
  const rows = Array.isArray(manifest?.units) ? manifest.units : [];
  const rowIds = rows.map((row) => String(row?.unit_id ?? ""));
  const duplicateIds = rowIds.filter((unitId, index) => (
    !unitId || rowIds.indexOf(unitId) !== index
  ));
  if (duplicateIds.length) {
    findings.push({
      code: "narration_provider_output_unit_ids_missing_or_duplicated",
      unit_ids: [...new Set(duplicateIds)],
    });
  }
  if (rows.length !== expectedUnits.length) {
    findings.push({
      code: "narration_provider_output_unit_count_mismatch",
      expected: expectedUnits.length,
      actual: rows.length,
    });
  }
  if (generationPlanSha256
    && manifest?.narration_generation_plan_sha256 !== generationPlanSha256) {
    findings.push({ code: "narration_provider_output_plan_hash_mismatch" });
  }
  if (generationPlanFileSha256
    && manifest?.narration_generation_plan_file_sha256
      !== generationPlanFileSha256) {
    findings.push({ code: "narration_provider_output_plan_file_hash_mismatch" });
  }
  if (qualityContractSha256
    && manifest?.narration_quality_contract_sha256 !== qualityContractSha256) {
    findings.push({ code: "narration_provider_output_quality_contract_hash_mismatch" });
  }
  if (provider && manifest?.provider !== narrationProviderAdapter(provider).provider) {
    findings.push({ code: "narration_provider_output_provider_mismatch" });
  }
  if (voiceId && manifest?.voice_id !== voiceId) {
    findings.push({ code: "narration_provider_output_voice_id_mismatch" });
  }
  if (voiceSha256 && manifest?.voice_sha256 !== voiceSha256) {
    findings.push({ code: "narration_provider_output_voice_hash_mismatch" });
  }
  for (const [index, expected] of expectedUnits.entries()) {
    const row = rows[index];
    if (!row) continue;
    const expectedId = String(expected?.unit_id ?? "");
    const expectedText = String(
      expected?.spoken_text ?? expected?.tts_spoken_text ?? "",
    );
    if (row.unit_id !== expectedId || row.order_index !== index) {
      findings.push({
        code: "narration_provider_output_order_mismatch",
        index,
        expected_unit_id: expectedId,
        actual_unit_id: row.unit_id,
      });
    }
    if (row.spoken_text_sha256 !== sha256(expectedText)) {
      findings.push({
        code: "narration_provider_output_spoken_text_hash_mismatch",
        unit_id: expectedId,
      });
    }
    const expectedRequestSha256 = expected?.provider_request
      ? canonicalSha256(expected.provider_request)
      : null;
    if (row.provider_request_sha256 !== expectedRequestSha256) {
      findings.push({
        code: "narration_provider_output_request_hash_mismatch",
        unit_id: expectedId,
      });
    }
    if (row.status !== "accepted" || !row.audio_path || !row.audio_sha256) {
      findings.push({
        code: "narration_provider_output_audio_missing",
        unit_id: expectedId,
      });
    }
    if (row.provider !== manifest.provider
      || row.adapter_id !== manifest.adapter_id
      || row.model_id !== manifest.model_id
      || row.model_revision !== manifest.model_revision
      || row.voice_id !== manifest.voice_id
      || row.voice_sha256 !== manifest.voice_sha256
      || row.voice_continuity_contract !== manifest.voice_continuity_contract) {
      findings.push({
        code: "narration_provider_output_unit_identity_mismatch",
        unit_id: expectedId,
      });
    }
    if (!Number.isFinite(Number(row.duration_sec)) || Number(row.duration_sec) <= 0) {
      findings.push({
        code: "narration_provider_output_duration_invalid",
        unit_id: expectedId,
      });
    }
    if (!/^[a-f0-9]{64}$/iu.test(String(row.synthesis_identity_sha256 ?? ""))) {
      findings.push({
        code: "narration_provider_output_synthesis_identity_missing",
        unit_id: expectedId,
      });
    } else {
      const expectedRequestIdentitySha256 = expected?.provider_request
        ?.synthesis_identity_sha256 ?? null;
      if (row.provider_request_synthesis_identity_sha256
          !== expectedRequestIdentitySha256) {
        findings.push({
          code: "narration_provider_output_request_synthesis_identity_mismatch",
          unit_id: expectedId,
        });
      }
      if (row.synthesis_identity
        && row.synthesis_identity_sha256
          !== narrationSynthesisIdentitySha256(row.synthesis_identity)) {
        findings.push({
          code: "narration_provider_output_synthesis_identity_mismatch",
          unit_id: expectedId,
        });
      }
      const synthesisIdentity = row.synthesis_identity ?? {};
      const identityVoiceId = synthesisIdentity.voice_id
        ?? synthesisIdentity.voice
        ?? null;
      for (const [field, actual, expectedValue] of [
        ["provider", synthesisIdentity.provider, manifest.provider],
        ["model_id", synthesisIdentity.model_id, manifest.model_id],
        ["model_revision", synthesisIdentity.model_revision, manifest.model_revision],
        ["voice_id", identityVoiceId, manifest.voice_id],
        ["voice_sha256", synthesisIdentity.voice_sha256, manifest.voice_sha256],
        ["unit_id", synthesisIdentity.unit_id, expectedId],
        ["spoken_text_sha256", synthesisIdentity.spoken_text_sha256, sha256(expectedText)],
      ]) {
        if (actual != null && actual !== expectedValue) {
          findings.push({
            code: "narration_provider_output_synthesis_identity_field_mismatch",
            unit_id: expectedId,
            field,
          });
        }
      }
    }
    if (row.token_limit_reached === true) {
      findings.push({
        code: "narration_provider_output_token_limit_reached",
        unit_id: expectedId,
      });
    }
    if (row.provider_unit_qa != null) {
      if (row.provider_unit_qa_sha256
          !== narrationProviderUnitQaSha256(row.provider_unit_qa)
        || row.provider_unit_qa.audio_sha256 !== row.audio_sha256
        || !String(row.provider_unit_qa.policy_version ?? "").trim()
        || !Array.isArray(row.provider_unit_qa.findings)
        || !Number.isFinite(Number(row.provider_unit_qa.metrics?.sample_count))
        || Number(row.provider_unit_qa.metrics.sample_count) <= 0) {
        findings.push({
          code: "narration_provider_output_unit_qa_invalid",
          unit_id: expectedId,
        });
      }
    } else if (row.provider_unit_qa_sha256 != null) {
      findings.push({
        code: "narration_provider_output_unit_qa_hash_without_payload",
        unit_id: expectedId,
      });
    }
  }
  if (manifest?.manifest_sha256
    && manifest.manifest_sha256 !== narrationProviderOutputManifestSha256(manifest)) {
    findings.push({ code: "narration_provider_output_manifest_hash_invalid" });
  }
  return { status: findings.length ? "blocked" : "passed", findings };
}
