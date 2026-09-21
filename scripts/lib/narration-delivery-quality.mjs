import { createHash } from "node:crypto";

export const NARRATION_DELIVERY_QA_SCHEMA = "goldflow_narration_delivery_qa_v2";
export const NARRATION_DELIVERY_CONSENSUS_VERSION = "protected_operations_same_intended_slot_v1";
export const NARRATION_EXACT_LISTEN_REVIEW_PACKET_SCHEMA =
  "goldflow_narration_exact_listen_review_packet_v2";
export const NARRATION_EXACT_LISTEN_REVIEW_DECISION_SCHEMA =
  "goldflow_narration_exact_listen_review_decision_v1";
export const NARRATION_EXACT_LISTEN_ATTESTATION =
  "exact_audio_listened_end_to_end";

const LISTEN_ACCEPT_CONFIRMATIONS = Object.freeze([
  "opening_word_complete",
  "final_word_complete",
  "no_audible_skip",
  "no_audible_truncation",
  "no_audible_stutter",
  "pronunciation_acceptable",
  "endpoint_acceptable",
]);

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function hashWithoutField(value, field) {
  const copy = structuredClone(value ?? {});
  delete copy[field];
  return sha256(JSON.stringify(copy));
}

export function narrationExactListenReviewPacketSha256(packet) {
  return hashWithoutField(packet, "packet_sha256");
}

export function narrationExactListenReviewDecisionSha256(decision) {
  const canonicalDecision = structuredClone(decision ?? {});
  delete canonicalDecision.decision_sha256;
  delete canonicalDecision.validation;
  return sha256(JSON.stringify(canonicalDecision));
}

function blocker(code, details = {}) {
  return { ...details, code, severity: "blocker" };
}

function warning(code, details = {}) {
  return { ...details, code, severity: "warning", review_required: true };
}

function advisory(code, details = {}) {
  return { ...details, code, severity: "warning", review_required: false };
}

const FINDING_FAMILY_ALIASES = new Map([
  ["narration_word_error_rate_exceeded", "word_error_rate_exceeded"],
  ["tts_transcript_wer_exceeded", "word_error_rate_exceeded"],
  ["narration_opening_word_missing", "opening_word_missing"],
  ["tts_transcript_opening_word_missing", "opening_word_missing"],
  ["narration_final_word_missing", "final_word_missing"],
  ["tts_transcript_final_word_missing", "final_word_missing"],
  ["narration_contiguous_words_missing", "contiguous_words_missing"],
  ["tts_transcript_contiguous_words_missing", "contiguous_words_missing"],
  ["narration_repetition_or_insertion_burst", "insertion_burst"],
  ["tts_transcript_unexpected_word_burst", "insertion_burst"],
  ["narration_final_stream_transcript_qa_missing", "transcript_missing"],
  ["tts_transcript_empty", "transcript_missing"],
]);

export function narrationDeliveryFindingFamily(code) {
  const value = String(code ?? "narration_unknown_finding");
  return FINDING_FAMILY_ALIASES.get(value) ?? value;
}

function uniqueFindings(rows = []) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = [
      narrationDeliveryFindingFamily(row?.code),
      row?.unit_id ?? "",
      row?.boundary_id ?? "",
      row?.left_unit_id ?? "",
      row?.right_unit_id ?? "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function transcriptDifferenceCount(transcriptQa) {
  return Number(transcriptQa?.deletions ?? 0)
    + Number(transcriptQa?.insertions ?? 0)
    + Number(transcriptQa?.substitutions ?? 0);
}

function operationKeys(transcriptQa, type, field) {
  return new Set((transcriptQa?.operations ?? [])
    .filter((row) => row?.type === type && row?.[field] != null)
    .map((row) => String(row[field])));
}

function intersection(left, right) {
  return [...left].filter((value) => right.has(value));
}

const PROTECTED_OPERATION_FAMILIES = new Map([
  ["tts_transcript_protected_value_mismatch", "substitution"],
  ["tts_transcript_protected_value_missing", "deletion"],
  ["tts_transcript_unexpected_protected_value", "insertion"],
]);
const isProtectedToken = (value) => /^(?:abbr|num|pct|ratio|times|alias):/.test(String(value ?? ""));

function sharedIntendedSlots(primaryQa, confirmationQa) {
  const intendedTokens = (qa) => (qa?.operations ?? [])
    .filter((row) => row.intended != null).map((row) => row.intended);
  const primary = intendedTokens(primaryQa);
  const confirmation = intendedTokens(confirmationQa);
  const maps = [Array(primary.length).fill(null), Array(confirmation.length).fill(null)];
  // Pair-aware notation can restore a consumed "a" before an amount, or a
  // symbol's spoken dollar unit after it. Those additions are not stable
  // source coordinates. Match both intended sequences while allowing only
  // these known numeric-notation additions to remain unmatched.
  const notationAddition = (tokens, index) => (
    (tokens[index] === "a" && /^num:/.test(tokens[index + 1] ?? ""))
    || (/^dollars?$/.test(tokens[index] ?? "") && /^num:/.test(tokens[index - 1] ?? ""))
  );
  let left = 0;
  let right = 0;
  let slot = 0;
  while (left < primary.length || right < confirmation.length) {
    if (left < primary.length && right < confirmation.length && primary[left] === confirmation[right]) {
      maps[0][left++] = slot;
      maps[1][right++] = slot++;
    } else if (left < primary.length && notationAddition(primary, left)) {
      left += 1;
    } else if (right < confirmation.length && notationAddition(confirmation, right)) {
      right += 1;
    } else {
      // Do not invent source alignment if the intended sequences differ for
      // any reason beyond the comparator's documented notation augmentation.
      return [null, null];
    }
  }
  return maps;
}

function protectedOperations(transcriptQa, type, slots) {
  let intendedIndex = 0;
  const operations = [];
  for (const operation of transcriptQa?.operations ?? []) {
    // Insertions are anchored at the gap before this intended-token cursor.
    // Repeated amounts at different source positions are different evidence.
    if (operation.type === type
      && (isProtectedToken(operation.intended) || isProtectedToken(operation.recognized))) {
      let intendedSlot = slots?.[intendedIndex] ?? null;
      if (type === "insertion" && slots) {
        const before = slots.slice(0, intendedIndex).findLast((value) => value != null) ?? "start";
        const after = slots.slice(intendedIndex).find((value) => value != null) ?? "end";
        intendedSlot = `gap:${before}:${after}`;
      }
      operations.push({ ...operation, intended_token_index: intendedIndex, intended_slot: intendedSlot });
    }
    if (operation.intended != null) intendedIndex += 1;
  }
  return operations;
}

function protectedOperationKey(operation) {
  return JSON.stringify([
    operation.type, operation.intended ?? null, operation.recognized ?? null,
    operation.intended_slot,
  ]);
}

function editDistance(leftValue, rightValue) {
  const left = String(leftValue ?? "");
  const right = String(rightValue ?? "");
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1]
          + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous.at(-1);
}

function likelyCompoundFusion(transcriptQa, deletedToken) {
  const operations = transcriptQa?.operations ?? [];
  return operations.some((operation, index) => {
    if (operation?.type !== "deletion" || operation.intended !== deletedToken) return false;
    for (const neighbor of [operations[index - 1], operations[index + 1]]) {
      if (neighbor?.type !== "substitution") continue;
      const candidates = [
        `${operation.intended}${neighbor.intended}`,
        `${neighbor.intended}${operation.intended}`,
      ];
      const recognized = String(neighbor.recognized ?? "");
      if (recognized.length < 5) continue;
      if (candidates.some((candidate) => candidate === recognized)) return true;
      if (candidates.some((candidate) => (
        editDistance(candidate, recognized) / Math.max(candidate.length, recognized.length)
          <= 0.25
      ))) return true;
    }
    return false;
  });
}

function likelyTokenResegmentation(transcriptQa, insertedToken) {
  const operations = transcriptQa?.operations ?? [];
  return operations.some((operation, index) => {
    if (operation?.type !== "insertion" || operation.recognized !== insertedToken) return false;
    return [operations[index - 1], operations[index + 1]].some(
      (neighbor) => neighbor?.type === "substitution",
    );
  });
}

export function strictNarrationDeliveryDecision(transcriptQa, {
  orderQa = null,
  joinQa = null,
  contract,
} = {}) {
  const policy = contract?.delivery_qa ?? {};
  const blockers = [
    ...(orderQa?.blockers ?? []),
    ...(joinQa?.blockers ?? []),
  ];
  const warnings = [...(joinQa?.warnings ?? [])];
  if (!transcriptQa) {
    blockers.push(blocker("narration_final_stream_transcript_qa_missing"));
  } else {
    if (Number(transcriptQa.leading_deletion_run ?? 0) >= Number(policy.hard_block_opening_deletion_run ?? 1)) {
      blockers.push(blocker("narration_opening_word_missing", { missing_count: transcriptQa.leading_deletion_run }));
    }
    if (Number(transcriptQa.trailing_deletion_run ?? 0) >= Number(policy.hard_block_trailing_deletion_run ?? 1)) {
      blockers.push(blocker("narration_final_word_missing", { missing_count: transcriptQa.trailing_deletion_run }));
    }
    if (Number(transcriptQa.longest_deletion_run ?? 0) >= Number(policy.hard_block_contiguous_deletion_run ?? 2)) {
      blockers.push(blocker("narration_contiguous_words_missing", { longest_deletion_run: transcriptQa.longest_deletion_run }));
    } else if (Number(transcriptQa.deletions ?? 0) > 0) {
      warnings.push(warning("narration_isolated_asr_deletion", { deletions: transcriptQa.deletions }));
    }
    if (Number(transcriptQa.longest_insertion_run ?? 0) >= Number(policy.hard_block_contiguous_insertion_run ?? 2)) {
      blockers.push(blocker("narration_repetition_or_insertion_burst", { longest_insertion_run: transcriptQa.longest_insertion_run }));
    } else if (Number(transcriptQa.insertions ?? 0) > 0) {
      warnings.push(warning("narration_isolated_asr_insertion", { insertions: transcriptQa.insertions }));
    }
    if (Number(transcriptQa.word_error_rate ?? 1) > Number(policy.maximum_word_error_rate ?? 0.05)) {
      blockers.push(blocker("narration_word_error_rate_exceeded", {
        word_error_rate: transcriptQa.word_error_rate,
        maximum: policy.maximum_word_error_rate ?? 0.05,
      }));
    }
    for (const finding of transcriptQa.findings ?? []) {
      if (finding?.severity !== "blocker") continue;
      if (blockers.some((row) => (
        narrationDeliveryFindingFamily(row.code)
          === narrationDeliveryFindingFamily(finding.code)
      ))) continue;
      blockers.push(blocker(
        String(finding.code ?? "narration_transcript_integrity_blocker"),
        finding,
      ));
    }
  }
  return {
    schema: NARRATION_DELIVERY_QA_SCHEMA,
    status: blockers.length ? "blocked" : warnings.length ? "passed_with_warnings" : "passed",
    blockers: uniqueFindings(blockers),
    warnings: uniqueFindings(warnings),
  };
}

export function narrationDeliveryNeedsConfirmation(transcriptQa, decision = null) {
  return !transcriptQa
    || transcriptDifferenceCount(transcriptQa) > 0
    || (decision?.blockers?.length ?? 0) > 0;
}

// A second ASR model adjudicates delivery defects; it does not rewrite audio.
// Only defects independently observed by both models become automatic blockers.
// Substitution-only disagreement is kept as a precise listen-review item because
// fantasy names and initialisms are often spoken correctly but spelled differently.
export function adjudicateNarrationDeliveryConsensus({
  primaryTranscriptQa,
  confirmationTranscriptQa,
  orderQa = null,
  joinQa = null,
  contract,
  primaryModel = "small.en",
  confirmationModel = "medium",
} = {}) {
  const deliveryPolicy = contract?.delivery_qa ?? {};
  const primary = strictNarrationDeliveryDecision(primaryTranscriptQa, {
    orderQa,
    joinQa,
    contract,
  });
  if (!narrationDeliveryNeedsConfirmation(primaryTranscriptQa, primary)) {
    return {
      ...primary,
      schema: "goldflow_narration_delivery_consensus_v2",
      adjudication_version: NARRATION_DELIVERY_CONSENSUS_VERSION,
      primary_model: primaryModel,
      confirmation_model: null,
      confirmation_required: false,
      review_required: primary.warnings.length > 0,
    };
  }
  if (!confirmationTranscriptQa) {
    return {
      ...primary,
      schema: "goldflow_narration_delivery_consensus_v2",
      adjudication_version: NARRATION_DELIVERY_CONSENSUS_VERSION,
      status: "blocked",
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
      confirmation_required: true,
      review_required: true,
      blockers: uniqueFindings([
        ...primary.blockers,
        blocker("narration_required_confirmation_missing", {
          primary_model: primaryModel,
          confirmation_model: confirmationModel,
        }),
      ]),
    };
  }

  const confirmation = strictNarrationDeliveryDecision(confirmationTranscriptQa, {
    orderQa: { blockers: [] },
    joinQa: { blockers: [], warnings: [] },
    contract,
  });
  const blockers = [
    ...(orderQa?.blockers ?? []),
    ...(joinQa?.blockers ?? []),
  ];
  const warnings = [...(joinQa?.warnings ?? [])];
  const primaryFamilies = new Set(primary.blockers.map((row) => narrationDeliveryFindingFamily(row.code)));
  const confirmationFamilies = new Set(confirmation.blockers.map((row) => narrationDeliveryFindingFamily(row.code)));
  const confirmedHardFamilies = new Set([
    "opening_word_missing",
    "final_word_missing",
    "contiguous_words_missing",
    "insertion_burst",
    "transcript_missing",
  ]);
  for (const family of intersection(primaryFamilies, confirmationFamilies)) {
    if (!confirmedHardFamilies.has(family)) continue;
    const source = primary.blockers.find((row) => narrationDeliveryFindingFamily(row.code) === family)
      ?? confirmation.blockers.find((row) => narrationDeliveryFindingFamily(row.code) === family)
      ?? {};
    blockers.push(blocker(`narration_confirmed_${family}`, {
      ...source,
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
    }));
  }

  const sharedProtectedByType = new Map();
  const unconfirmedProtected = { primary_operations: [], confirmation_operations: [] };
  const [primarySlots, confirmationSlots] = sharedIntendedSlots(primaryTranscriptQa, confirmationTranscriptQa);
  for (const [family, type] of PROTECTED_OPERATION_FAMILIES) {
    const primaryOperations = protectedOperations(primaryTranscriptQa, type, primarySlots);
    const confirmationOperations = protectedOperations(confirmationTranscriptQa, type, confirmationSlots);
    const primaryKeys = new Set(primaryOperations.filter((row) => row.intended_slot != null).map(protectedOperationKey));
    const confirmationKeys = new Set(confirmationOperations.filter((row) => row.intended_slot != null).map(protectedOperationKey));
    const shared = primaryOperations.filter((row) => confirmationKeys.has(protectedOperationKey(row)));
    sharedProtectedByType.set(type, shared);
    if (shared.length) {
      blockers.push(blocker(`narration_confirmed_${family}`, {
        operations: shared,
        primary_model: primaryModel,
        confirmation_model: confirmationModel,
      }));
    }
    unconfirmedProtected.primary_operations.push(...primaryOperations.filter(
      (row) => !confirmationKeys.has(protectedOperationKey(row)),
    ));
    unconfirmedProtected.confirmation_operations.push(...confirmationOperations.filter(
      (row) => !primaryKeys.has(protectedOperationKey(row)),
    ));
  }
  if (unconfirmedProtected.primary_operations.length || unconfirmedProtected.confirmation_operations.length) {
    const finding = {
      ...unconfirmedProtected,
      disposition: deliveryPolicy.unconfirmed_primary_asr_requires_exact_listen === false
        ? "independent_protected_operations_disagree_advisory_no_retry"
        : "exact_unit_listen_review_no_automatic_regeneration",
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
    };
    warnings.push(deliveryPolicy.unconfirmed_primary_asr_requires_exact_listen === false
      ? advisory("narration_protected_value_difference_not_confirmed", finding)
      : warning("narration_protected_value_difference_not_confirmed", finding));
  }

  const rawConfirmedDeletedTokens = intersection(
    operationKeys(primaryTranscriptQa, "deletion", "intended"),
    operationKeys(confirmationTranscriptQa, "deletion", "intended"),
  ).filter((token) => !isProtectedToken(token)
    || sharedProtectedByType.get("deletion").some((row) => row.intended === token));
  const fusedCompoundTokens = rawConfirmedDeletedTokens.filter((token) => (
    likelyCompoundFusion(primaryTranscriptQa, token)
      && likelyCompoundFusion(confirmationTranscriptQa, token)
  ));
  const confirmedDeletedTokens = rawConfirmedDeletedTokens.filter(
    (token) => !fusedCompoundTokens.includes(token),
  );
  if (confirmedDeletedTokens.length) {
    blockers.push(blocker("narration_confirmed_word_omission", {
      intended_tokens: confirmedDeletedTokens,
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
    }));
  }
  if (fusedCompoundTokens.length) {
    warnings.push(warning("narration_possible_compound_fusion_not_omission", {
      intended_tokens: fusedCompoundTokens,
      disposition: "exact_unit_listen_review_no_automatic_regeneration",
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
    }));
  }
  const rawConfirmedInsertedTokens = intersection(
    operationKeys(primaryTranscriptQa, "insertion", "recognized"),
    operationKeys(confirmationTranscriptQa, "insertion", "recognized"),
  ).filter((token) => !isProtectedToken(token)
    || sharedProtectedByType.get("insertion").some((row) => row.recognized === token));
  const resegmentedTokens = rawConfirmedInsertedTokens.filter((token) => (
    likelyTokenResegmentation(primaryTranscriptQa, token)
      && likelyTokenResegmentation(confirmationTranscriptQa, token)
  ));
  const confirmedInsertedTokens = rawConfirmedInsertedTokens.filter(
    (token) => !resegmentedTokens.includes(token),
  );
  if (confirmedInsertedTokens.length) {
    blockers.push(blocker("narration_confirmed_unexpected_word", {
      recognized_tokens: confirmedInsertedTokens,
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
    }));
  }
  if (resegmentedTokens.length) {
    warnings.push(warning("narration_possible_asr_token_resegmentation", {
      recognized_tokens: resegmentedTokens,
      disposition: "exact_unit_listen_review_no_automatic_regeneration",
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
    }));
  }

  const primarySubstitutions = new Set((primaryTranscriptQa?.operations ?? [])
    .filter((row) => row?.type === "substitution")
    .map((row) => `${row.intended}->${row.recognized}`));
  const confirmationSubstitutions = new Set((confirmationTranscriptQa?.operations ?? [])
    .filter((row) => row?.type === "substitution")
    .map((row) => `${row.intended}->${row.recognized}`));
  const confirmedSubstitutions = intersection(primarySubstitutions, confirmationSubstitutions);
  if (confirmedSubstitutions.length) {
    const finding = {
      operations: confirmedSubstitutions,
      disposition: deliveryPolicy.substitution_only_asr_disagreement_requires_exact_listen === false
        ? "advisory_no_retry"
        : "exact_unit_listen_review_no_automatic_regeneration",
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
    };
    warnings.push(deliveryPolicy.substitution_only_asr_disagreement_requires_exact_listen === false
      ? advisory("narration_confirmed_lexical_or_pronunciation_difference", finding)
      : warning("narration_confirmed_lexical_or_pronunciation_difference", finding));
  }

  // A corrupted edge token can align as a substitution rather than a deletion
  // (for example, a clipped final word recognized as a stray syllable). Require
  // exact-unit repair/triage when both independent ASR passes reject that edge.
  if (primaryTranscriptQa?.first_token_ok === false
    && confirmationTranscriptQa?.first_token_ok === false) {
    blockers.push(blocker("narration_confirmed_opening_token_mismatch", {
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
    }));
  }
  if (primaryTranscriptQa?.last_token_ok === false
    && confirmationTranscriptQa?.last_token_ok === false) {
    blockers.push(blocker("narration_confirmed_final_token_mismatch", {
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
    }));
  }

  const primaryWerExceeded = primaryFamilies.has("word_error_rate_exceeded");
  const confirmationWerExceeded = confirmationFamilies.has("word_error_rate_exceeded");
  if (primaryWerExceeded && confirmationWerExceeded
    && !confirmedDeletedTokens.length && !confirmedInsertedTokens.length) {
    const finding = {
      primary_word_error_rate: primaryTranscriptQa.word_error_rate,
      confirmation_word_error_rate: confirmationTranscriptQa.word_error_rate,
      disposition: deliveryPolicy.substitution_only_high_wer_requires_exact_listen === false
        ? "sequence_intact_advisory_no_retry"
        : "sequence_intact_exact_unit_listen_review",
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
    };
    warnings.push(deliveryPolicy.substitution_only_high_wer_requires_exact_listen === false
      ? advisory("narration_asr_lexical_uncertainty_above_wer_threshold", finding)
      : warning("narration_asr_lexical_uncertainty_above_wer_threshold", finding));
  }
  if (primary.blockers.length && !confirmation.blockers.length) {
    const finding = {
      primary_blocker_codes: primary.blockers.map((row) => row.code),
      primary_model: primaryModel,
      confirmation_model: confirmationModel,
      disposition: deliveryPolicy.unconfirmed_primary_asr_requires_exact_listen === false
        ? "independent_confirmation_passed_advisory_no_retry"
        : "exact_unit_listen_review_no_automatic_regeneration",
    };
    warnings.push(deliveryPolicy.unconfirmed_primary_asr_requires_exact_listen === false
      ? advisory("narration_primary_asr_finding_not_confirmed", finding)
      : warning("narration_primary_asr_finding_not_confirmed", finding));
  }
  return {
    schema: "goldflow_narration_delivery_consensus_v2",
    adjudication_version: NARRATION_DELIVERY_CONSENSUS_VERSION,
    status: blockers.length ? "blocked" : warnings.length ? "passed_with_warnings" : "passed",
    primary_model: primaryModel,
    confirmation_model: confirmationModel,
    confirmation_required: true,
    review_required: warnings.some((row) => row.review_required === true),
    primary_decision: primary,
    confirmation_decision: confirmation,
    blockers: uniqueFindings(blockers),
    warnings: uniqueFindings(warnings),
  };
}

export function exactNarrationRepairPacket({ decision, units = [], boundaries = [] } = {}) {
  const unitIds = new Set();
  const boundaryIds = new Set();
  for (const finding of decision?.blockers ?? []) {
    if (finding.unit_id) unitIds.add(String(finding.unit_id));
    if (finding.left_unit_id && finding.right_unit_id) {
      boundaryIds.add(`${finding.left_unit_id}__${finding.right_unit_id}`);
    }
  }
  return {
    schema: "goldflow_narration_exact_repair_packet_v2",
    status: decision?.status === "blocked" ? "repair_required" : "not_required",
    unit_ids: [...unitIds],
    boundary_ids: [...boundaryIds],
    available_unit_ids: units.map((row) => String(row.unit_id)),
    available_boundary_ids: boundaries.map((row) => String(row.boundary_id ?? "")),
    policy: "Repair only the named unit or boundary. Passed audio remains immutable.",
  };
}

export function exactNarrationListenReviewPacket({
  rows = [],
  generationPlanSha256 = null,
  generationPlanFileSha256 = null,
  qualityContractSha256 = null,
} = {}) {
  const items = rows.flatMap((row) => {
    const warnings = row?.decision?.warnings?.filter(
      (finding) => finding?.review_required === true,
    ) ?? [];
    if (!warnings.length) return [];
    return [{
      unit_id: String(row.unit_id),
      audio_path: row.audio_path ?? null,
      audio_sha256: row.audio_sha256 ?? null,
      intended_text: row.intended_text ?? null,
      primary_recognized_text: row.primary_recognized_text
        ?? row.recognized_text
        ?? null,
      confirmation_recognized_text: row.confirmation_recognized_text ?? null,
      warning_codes: warnings.map((finding) => finding.code),
      warnings,
      requested_action: "Listen only to this immutable unit and confirm pronunciation/delivery. Do not regenerate unless an audible defect is confirmed.",
    }];
  });
  const packet = {
    schema: NARRATION_EXACT_LISTEN_REVIEW_PACKET_SCHEMA,
    status: items.length ? "review_items_present" : "not_required",
    narration_generation_plan_sha256: generationPlanSha256,
    narration_generation_plan_file_sha256: generationPlanFileSha256,
    narration_quality_contract_sha256: qualityContractSha256,
    item_count: items.length,
    unit_ids: items.map((row) => row.unit_id),
    items,
  };
  return {
    ...packet,
    packet_sha256: narrationExactListenReviewPacketSha256(packet),
  };
}

export function buildNarrationExactListenReviewDecision({
  packet,
  reviewer,
  decisions = [],
  reviewedAt = new Date().toISOString(),
  attestation = null,
} = {}) {
  const packetItems = new Map(
    (packet?.items ?? []).map((item) => [String(item.unit_id), item]),
  );
  const rows = decisions.map((decision) => {
    const item = packetItems.get(String(decision.unit_id)) ?? {};
    const disposition = String(decision.decision ?? "");
    const accepted = disposition === "accept";
    return {
      unit_id: String(decision.unit_id),
      audio_path: item.audio_path ?? decision.audio_path ?? null,
      audio_sha256: item.audio_sha256 ?? decision.audio_sha256 ?? null,
      decision: disposition,
      confirmations: accepted
        ? Object.fromEntries(LISTEN_ACCEPT_CONFIRMATIONS.map((key) => [key, true]))
        : {},
      defect_type: accepted ? null : decision.defect_type ?? null,
      note: decision.note ?? null,
    };
  });
  const repairRequired = rows.some((row) => row.decision === "repair_required");
  const artifact = {
    schema: NARRATION_EXACT_LISTEN_REVIEW_DECISION_SCHEMA,
    status: repairRequired ? "repair_required" : "approved",
    packet_sha256: packet?.packet_sha256 ?? null,
    narration_generation_plan_sha256:
      packet?.narration_generation_plan_sha256 ?? null,
    narration_generation_plan_file_sha256:
      packet?.narration_generation_plan_file_sha256 ?? null,
    narration_quality_contract_sha256:
      packet?.narration_quality_contract_sha256 ?? null,
    reviewer: String(reviewer ?? "").trim() || null,
    reviewed_at: reviewedAt,
    attestation,
    decision_count: rows.length,
    decisions: rows,
  };
  return {
    ...artifact,
    decision_sha256: narrationExactListenReviewDecisionSha256(artifact),
  };
}

export function validateNarrationExactListenReviewDecision(packet, decision) {
  const findings = [];
  if (packet?.schema !== NARRATION_EXACT_LISTEN_REVIEW_PACKET_SCHEMA
    || packet?.packet_sha256 !== narrationExactListenReviewPacketSha256(packet)) {
    findings.push({ code: "narration_exact_listen_packet_invalid" });
  }
  if (decision?.schema !== NARRATION_EXACT_LISTEN_REVIEW_DECISION_SCHEMA) {
    findings.push({ code: "narration_exact_listen_decision_schema_invalid" });
  }
  if (!decision?.decision_sha256
    || decision.decision_sha256 !== narrationExactListenReviewDecisionSha256(decision)) {
    findings.push({ code: "narration_exact_listen_decision_hash_invalid" });
  }
  if (decision?.packet_sha256 !== packet?.packet_sha256) {
    findings.push({ code: "narration_exact_listen_packet_hash_mismatch" });
  }
  if (decision?.narration_generation_plan_sha256
      !== packet?.narration_generation_plan_sha256
    || decision?.narration_generation_plan_file_sha256
      !== packet?.narration_generation_plan_file_sha256
    || decision?.narration_quality_contract_sha256
      !== packet?.narration_quality_contract_sha256) {
    findings.push({ code: "narration_exact_listen_lineage_mismatch" });
  }
  if (!String(decision?.reviewer ?? "").trim()) {
    findings.push({ code: "narration_exact_listen_reviewer_missing" });
  }
  const packetItems = Array.isArray(packet?.items) ? packet.items : [];
  const packetIds = packetItems.map((item) => String(item.unit_id));
  const decisionRows = Array.isArray(decision?.decisions) ? decision.decisions : [];
  const decisionIds = decisionRows.map((row) => String(row.unit_id));
  if (new Set(packetIds).size !== packetIds.length
    || new Set(decisionIds).size !== decisionIds.length
    || packetIds.length !== decisionIds.length
    || packetIds.some((unitId) => !decisionIds.includes(unitId))) {
    findings.push({ code: "narration_exact_listen_decision_scope_mismatch" });
  }
  const packetById = new Map(packetItems.map((item) => [String(item.unit_id), item]));
  for (const row of decisionRows) {
    const item = packetById.get(String(row.unit_id));
    if (!item
      || row.audio_path !== item.audio_path
      || row.audio_sha256 !== item.audio_sha256
      || !/^[a-f0-9]{64}$/u.test(String(row.audio_sha256 ?? ""))) {
      findings.push({
        code: "narration_exact_listen_audio_binding_invalid",
        unit_id: row.unit_id ?? null,
      });
    }
    if (row.decision === "accept") {
      if (decision?.attestation !== NARRATION_EXACT_LISTEN_ATTESTATION
        || LISTEN_ACCEPT_CONFIRMATIONS.some(
          (key) => row?.confirmations?.[key] !== true,
        )) {
        findings.push({
          code: "narration_exact_listen_acceptance_incomplete",
          unit_id: row.unit_id ?? null,
        });
      }
    } else if (row.decision === "repair_required") {
      if (!String(row.defect_type ?? "").trim()) {
        findings.push({
          code: "narration_exact_listen_repair_defect_missing",
          unit_id: row.unit_id ?? null,
        });
      }
    } else {
      findings.push({
        code: "narration_exact_listen_disposition_invalid",
        unit_id: row.unit_id ?? null,
      });
    }
  }
  const repairRequired = decisionRows.some(
    (row) => row.decision === "repair_required",
  );
  const expectedStatus = repairRequired ? "repair_required" : "approved";
  if (decision?.status !== expectedStatus
    || Number(decision?.decision_count ?? -1) !== decisionRows.length) {
    findings.push({ code: "narration_exact_listen_decision_status_invalid" });
  }
  return {
    status: findings.length
      ? "blocked"
      : repairRequired
        ? "repair_required"
        : "approved",
    findings,
    repair_unit_ids: decisionRows
      .filter((row) => row.decision === "repair_required")
      .map((row) => String(row.unit_id)),
  };
}
