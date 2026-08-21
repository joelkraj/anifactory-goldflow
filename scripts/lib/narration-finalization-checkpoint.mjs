import { createHash } from "node:crypto";

export const NARRATION_FINALIZATION_CHECKPOINT_SCHEMA =
  "goldflow_narration_finalization_checkpoint_v1";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function narrationFinalizationContentSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function narrationFinalizationUnitKey({
  unit,
  qualityContractSha256,
  provider,
  modelId,
  modelRevision,
  voiceId,
  voiceSha256,
  voiceContinuityContract,
} = {}) {
  return narrationFinalizationContentSha256({
    checkpoint_contract: NARRATION_FINALIZATION_CHECKPOINT_SCHEMA,
    unit_id: String(unit?.unit_id ?? ""),
    spoken_text_sha256: unit?.spoken_text_sha256 ?? null,
    audio_sha256: unit?.audio_sha256 ?? null,
    synthesis_identity_sha256: unit?.synthesis_identity_sha256 ?? null,
    quality_contract_sha256: qualityContractSha256 ?? null,
    provider: provider ?? unit?.provider ?? null,
    model_id: modelId ?? unit?.model_id ?? null,
    model_revision: modelRevision ?? unit?.model_revision ?? null,
    voice_id: voiceId ?? unit?.voice_id ?? null,
    voice_sha256: voiceSha256 ?? unit?.voice_sha256 ?? null,
    voice_continuity_contract:
      voiceContinuityContract ?? unit?.voice_continuity_contract ?? null,
  });
}

export function narrationFinalizationStageKey(stage, value) {
  return narrationFinalizationContentSha256({ stage, inputs: value });
}

export function reusableNarrationFinalizationUnit(checkpoint, unitId, unitKey) {
  if (checkpoint?.schema !== NARRATION_FINALIZATION_CHECKPOINT_SCHEMA) return null;
  const row = checkpoint?.units?.[String(unitId)] ?? null;
  return row?.unit_key === unitKey ? structuredClone(row) : null;
}

export function reusableNarrationFinalizationStage(checkpoint, stage, inputKey) {
  if (checkpoint?.schema !== NARRATION_FINALIZATION_CHECKPOINT_SCHEMA) return null;
  const row = checkpoint?.stages?.[String(stage)] ?? null;
  return row?.input_key === inputKey && row?.status === "passed"
    ? structuredClone(row)
    : null;
}

export function emptyNarrationFinalizationCheckpoint(context = {}) {
  return {
    schema: NARRATION_FINALIZATION_CHECKPOINT_SCHEMA,
    status: "in_progress",
    context,
    units: {},
    stages: {},
  };
}
