export const STORY_WRITER_PACKET_SCHEMA = "goldflow_story_writer_packet_v1";

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value) {
  return Boolean(String(value ?? "").trim());
}

function pushIf(blockers, condition, code) {
  if (condition) blockers.push(code);
}

function unique(values) {
  return new Set(values).size === values.length;
}

function wordCount(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export function validateStoryWriterPacket(document, {
  packageSha256 = null,
  selectedTreatmentSha256 = null,
  architectureSha256 = null,
  architecture = null,
} = {}) {
  const blockers = [];
  pushIf(blockers, document?.schema !== STORY_WRITER_PACKET_SCHEMA, "writer_packet_schema_invalid");
  pushIf(blockers, document?.status !== "authored", "writer_packet_status_invalid");
  if (packageSha256) pushIf(blockers, document?.package_sha256 !== packageSha256, "writer_packet_package_hash_mismatch");
  if (selectedTreatmentSha256) pushIf(blockers, document?.selected_treatment_sha256 !== selectedTreatmentSha256, "writer_packet_treatment_hash_mismatch");
  if (architectureSha256) pushIf(blockers, document?.architecture_sha256 !== architectureSha256, "writer_packet_architecture_hash_mismatch");
  for (const field of ["title", "thumbnail_receipt", "core_story_promise", "opening_plan", "ending_contract"]) {
    pushIf(blockers, !nonEmpty(document?.[field]), `writer_packet_${field}_missing`);
  }
  pushIf(blockers, document?.target_word_range?.minimum !== 9_500, "writer_packet_word_minimum_invalid");
  pushIf(blockers, document?.target_word_range?.maximum !== 10_500, "writer_packet_word_maximum_invalid");

  const architectureNames = rows(architecture?.character_name_plan).map((row) => row?.name).filter(nonEmpty);
  const cast = rows(document?.cast);
  pushIf(blockers, cast.length < 2, "writer_packet_cast_too_small");
  pushIf(blockers, !unique(cast.map((row) => row?.name)), "writer_packet_cast_names_duplicate");
  for (const name of architectureNames) pushIf(blockers, !cast.some((row) => row?.name === name), `writer_packet_cast_${name}_missing`);
  for (const [index, row] of cast.entries()) {
    for (const field of ["name", "role", "desire", "voice", "story_job"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `writer_packet_cast_${index}_${field}_missing`);
    }
  }

  const mechanics = rows(document?.mechanic_rules);
  pushIf(blockers, mechanics.length < 4, "writer_packet_mechanics_below_4");
  for (const [index, row] of mechanics.entries()) {
    for (const field of ["name", "plain_rule", "limit_or_cost", "first_proof"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `writer_packet_mechanic_${index}_${field}_missing`);
    }
  }

  const architectureMovementIds = rows(architecture?.movements).map((row) => row?.id).filter(nonEmpty);
  const movements = rows(document?.movement_outline);
  const packetMovementIds = movements.map((row) => row?.movement_id);
  pushIf(blockers, movements.length !== architectureMovementIds.length, "writer_packet_movement_count_mismatch");
  pushIf(blockers, !unique(packetMovementIds), "writer_packet_movement_ids_duplicate");
  for (const movementId of architectureMovementIds) pushIf(blockers, !packetMovementIds.includes(movementId), `writer_packet_movement_${movementId}_missing`);
  for (const [index, row] of movements.entries()) {
    for (const field of ["movement_id", "story_change", "must_show", "payoff", "next_pressure"]) {
      pushIf(blockers, !nonEmpty(row?.[field]), `writer_packet_movement_${index}_${field}_missing`);
    }
  }

  pushIf(blockers, rows(document?.required_payoffs).length < 4, "writer_packet_required_payoffs_below_4");
  pushIf(blockers, rows(document?.voice_and_style).length < 3, "writer_packet_voice_rules_below_3");
  pushIf(blockers, rows(document?.forbidden_drift).length < 3, "writer_packet_forbidden_drift_below_3");
  const serialized = JSON.stringify(document);
  const words = wordCount(serialized);
  pushIf(blockers, serialized.length < 8_000, "writer_packet_too_short");
  pushIf(blockers, serialized.length > 32_000, "writer_packet_above_32000_chars");
  pushIf(blockers, words < 1_200, "writer_packet_below_1200_words");
  pushIf(blockers, words > 4_000, "writer_packet_above_4000_words");
  return { done: blockers.length === 0, blockers, characters: serialized.length, words };
}
