// A reviewed spelling/word-boundary interpretation of two retained ASR passes.
// This never claims that anyone listened, changes raw ASR, or accepts an audio
// edge, omission, insertion, or substitution outside the one named word span.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256File } from "./file-hash.mjs";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";
import { transcriptQaForTests } from "../modelslab-qwen-episode-audio.mjs";

export const NARRATION_ASR_ORTHOGRAPHY_SCHEMA =
  "goldflow_narration_asr_orthography_review_v1";
export const NARRATION_ASR_ORTHOGRAPHY_AMENDMENT_SCHEMA =
  "goldflow_narration_asr_orthography_amendment_v1";
export const NARRATION_ASR_ORTHOGRAPHY_EXTENSION_SCHEMA =
  "goldflow_narration_asr_orthography_extension_v1";
export const NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V2_SCHEMA =
  "goldflow_narration_asr_orthography_extension_v2";
export const NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA =
  "goldflow_narration_asr_orthography_extension_v3";
export const NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V4_SCHEMA =
  "goldflow_narration_asr_orthography_extension_v4";
export const NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V5_SCHEMA =
  "goldflow_narration_asr_orthography_extension_v5";

const hex = (value) => /^[a-f0-9]{64}$/u.test(String(value ?? ""));
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const words = (value) => [...String(value).matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)]
  .map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
const lower = (value) => String(value).toLocaleLowerCase("en-US");
const exactCodes = (left, right) => {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};
const inside = (root, target) => path.isAbsolute(String(target ?? ""))
  && path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`);

// Soundex is only a conservative spelling guard, not proof that two words
// were spoken correctly. The explicit editorial decision remains necessary.
function soundex(value) {
  const letters = String(value).toUpperCase().replace(/[^A-Z]/gu, "");
  if (!letters) return null;
  const digit = (letter) => ({ B: "1", F: "1", P: "1", V: "1",
    C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2",
    D: "3", T: "3", L: "4", M: "5", N: "5", R: "6" })[letter] ?? "0";
  let result = letters[0];
  let previous = digit(letters[0]);
  for (const letter of letters.slice(1)) {
    const current = digit(letter);
    if (current !== "0" && current !== previous) result += current;
    previous = current;
  }
  return (result + "000").slice(0, 4);
}

function editDistance(left, right) {
  let prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= right.length; j += 1) {
      next[j] = Math.min(next[j - 1] + 1, prior[j] + 1,
        prior[j - 1] + Number(left[i - 1] !== right[j - 1]));
    }
    prior = next;
  }
  return prior[right.length];
}

function replaceExactEdge(text, phrase, replacement, edge) {
  const sourceWords = words(text);
  const phraseWords = words(phrase);
  if (!sourceWords.length || !phraseWords.length || phraseWords.length > 3
    || !/^[\p{L}]+(?:['’]s)?(?: [\p{L}]+(?:['’]s)?){0,2}$/u.test(phrase)) return null;
  const startIndex = edge === "opening" ? 0 : sourceWords.length - phraseWords.length;
  if (startIndex < 0) return null;
  const selected = sourceWords.slice(startIndex, startIndex + phraseWords.length);
  if (!selected.every((row, index) => lower(row.text) === lower(phraseWords[index].text))) {
    return null;
  }
  const from = selected[0].start;
  const to = selected.at(-1).end;
  if (lower(text.slice(from, to).replace(/\s+/gu, " ")) !== lower(phrase)) return null;
  return text.slice(0, from) + replacement + text.slice(to);
}

function unchangedExceptReviewedPhrase({ intended, recognized, expectedPhrase, observedPhrase, edge }) {
  if (replaceExactEdge(intended, expectedPhrase, expectedPhrase, edge) == null) return false;
  const normalized = replaceExactEdge(recognized, observedPhrase, expectedPhrase, edge);
  if (normalized == null) return false;
  const qa = transcriptQaForTests(intended, normalized, { blockAnySubstitution: false });
  return qa.deletions === 0 && qa.insertions === 0 && qa.substitutions === 0
    && qa.first_token_ok === true && qa.last_token_ok === true;
}

function replaceUniqueWholePhrase(text, observedPhrase, expectedPhrase, position) {
  const source = words(text);
  const observed = words(observedPhrase);
  if (!observed.length || observed.length > 3
    || !/^[\p{L}]+(?: [\p{L}]+){0,2}$/u.test(observedPhrase)) return null;
  const matches = [];
  for (let index = 0; index <= source.length - observed.length; index += 1) {
    if (source.slice(index, index + observed.length).every((word, offset) =>
      lower(word.text) === lower(observed[offset].text))) matches.push(index);
  }
  if (matches.length !== 1) return null;
  const index = matches[0];
  if (position === "interior" && (index === 0 || index + observed.length === source.length)) return null;
  if (position === "final" && index + observed.length !== source.length) return null;
  const first = source[index], last = source[index + observed.length - 1];
  if (lower(text.slice(first.start, last.end).replace(/\s+/gu, " "))
    !== lower(observedPhrase)) return null;
  return text.slice(0, first.start) + expectedPhrase + text.slice(last.end);
}

// The second extension permits two independently reviewed name spellings in
// one unit, or one exact homophone/word-boundary interpretation. The complete
// transcript must match after those named spans alone are replaced.
function replaceUniqueReviewedSpan(text, observedPhrase, expectedPhrase, position) {
  const source = words(text);
  const observed = words(observedPhrase);
  if (!source.length || !observed.length || observed.length > 2) return null;
  const token = (value) => lower(value).replace(/’/gu, "'");
  const matches = [];
  for (let index = 0; index <= source.length - observed.length; index += 1) {
    if (source.slice(index, index + observed.length).every((word, offset) =>
      token(word.text) === token(observed[offset].text))) matches.push(index);
  }
  if (matches.length !== 1) return null;
  const index = matches[0];
  if (position === "opening" && index !== 0) return null;
  if (position === "final" && index + observed.length !== source.length) return null;
  if (position === "interior" && (index === 0 || index + observed.length === source.length)) {
    return null;
  }
  if (!["opening", "interior", "final"].includes(position)) return null;
  const first = source[index], last = source[index + observed.length - 1];
  return text.slice(0, first.start) + expectedPhrase + text.slice(last.end);
}

function validReviewedSpan(span) {
  const expected = String(span?.expected_phrase ?? "");
  const primary = String(span?.primary_observed_phrase ?? "");
  const confirmation = String(span?.confirmation_observed_phrase ?? "");
  const relation = span?.relation;
  const expectedWords = words(expected);
  const variants = [primary, confirmation];
  if (!expectedWords.length || variants.some((value) => !value || lower(value) === lower(expected))) {
    return false;
  }
  if (relation === "reviewed_dual_asr_proper_name_spelling") {
    const expectedPossessive = /['’]s$/u.test(expected);
    const expectedName = expected.replace(/['’]s$/u, "");
    return expectedWords.length === 1 && /^[\p{Lu}][\p{L}]+(?:['’]s)?$/u.test(expected)
      && variants.every((spelling) => {
        const name = spelling.replace(/['’]s$/u, "");
        return words(spelling).length === 1
          && /^[\p{Lu}][\p{L}]+(?:['’]s)?$/u.test(spelling)
          && /['’]s$/u.test(spelling) === expectedPossessive
          && soundex(expectedName) === soundex(name)
          && editDistance(lower(expectedName), lower(name)) <= 3;
      });
  }
  if (relation === "reviewed_homophone_spelling") {
    // A closed language pair avoids interpreting arbitrary lexical differences
    // as homophones merely because an editor named them that way.
    const allowed = new Set(["know|no", "no|know"]);
    return expectedWords.length === 1 && variants.every((spelling) =>
      words(spelling).length === 1
      && allowed.has(`${lower(expected)}|${lower(spelling)}`));
  }
  if (relation === "spacing_join") {
    return expectedWords.length === 2 && variants.every((spelling) =>
      words(spelling).length === 1
      && lower(expectedWords.map((word) => word.text).join("")) === lower(spelling));
  }
  if (relation === "reviewed_fragment_context_value_expansion") {
    const smallNumberWords = { one: 1, two: 2, three: 3, four: 4,
      five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
    const number = smallNumberWords[lower(expected)];
    return expectedWords.length === 1 && number != null
      && variants.every((spelling) => spelling === `$${number},000`);
  }
  return false;
}

function fragmentContextDiagnosticMatches({ diagnostic, row, oldOutput,
  expected, nameSpan, valueSpan }) {
  const fragment = oldOutput?.synthesis_identity?.fragments?.[diagnostic?.fragment_index];
  const check = (recognized, observedName) => {
    const normalized = replaceUniqueReviewedSpan(recognized, observedName,
      nameSpan.expected_phrase, "opening");
    if (normalized == null) return false;
    const qa = transcriptQaForTests(diagnostic.source_text, normalized,
      { blockAnySubstitution: false });
    return qa.deletions === 0 && qa.insertions === 0 && qa.substitutions === 0
      && qa.first_token_ok === true && qa.last_token_ok === true;
  };
  return diagnostic?.schema === "goldflow_narration_fragment_context_asr_diagnostic_v1"
    && diagnostic.status === "observed"
    && diagnostic.human_listening_performed === false
    && diagnostic.diagnostic_origin === "read_only_local_faster_whisper_dual_asr"
    && diagnostic.unit_id === row.unit_id
    && diagnostic.source_script_sha256 === expected.sourceScriptSha256
    && diagnostic.narration_generation_plan_sha256 === expected.planSha256
    && Number.isInteger(diagnostic.fragment_index)
    && diagnostic.fragment_index >= 0
    && diagnostic.source_text_sha256 === sha256(diagnostic.source_text)
    && words(diagnostic.source_text).at(-1)?.text.toLowerCase()
      === lower(valueSpan.expected_phrase)
    && diagnostic.composite_manifest_sha256 === expected.priorManifestFileSha256
    && diagnostic.fragment_audio_sha256 === fragment?.audio_sha256
    && diagnostic.fragment_sidecar_sha256 === fragment?.sidecar_sha256
    && diagnostic.source_text_sha256 === fragment?.text_sha256
    && diagnostic.repair_request_path === oldOutput.recovery_provenance?.request_path
    && diagnostic.repair_result_path === oldOutput.recovery_provenance?.result_path
    && diagnostic.small?.contract?.model === "small.en"
    && diagnostic.medium?.contract?.model === "medium"
    && Number(diagnostic.small?.duration_sec) > 0
    && Math.abs(Number(diagnostic.small.duration_sec)
      - Number(diagnostic.medium?.duration_sec)) < 0.05
    && check(diagnostic.small.recognized_text, nameSpan.primary_observed_phrase)
    && check(diagnostic.medium.recognized_text,
      nameSpan.confirmation_observed_phrase);
}

export function validateAsrOrthographyExtensionV2ForTests({
  evidence, predecessor, priorReport, priorDelivery, priorManifest,
  currentManifest, plan, expected, actualAudioHashes = {},
  fragmentContextDiagnostics = {},
} = {}) {
  if (evidence?.schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V2_SCHEMA
    || evidence.status !== "reviewed" || evidence.reviewer_kind !== "editorial_text_review"
    || evidence.human_listening_performed !== false
    || evidence.authorization_origin !== "user_authorized_autonomous_asr_qa"
    || !String(evidence.reviewer ?? "").trim()
    || !Number.isFinite(Date.parse(evidence.reviewed_at))
    || String(evidence.note ?? "").trim().length < 40
    || evidence.predecessor_evidence_path !== predecessor?.evidence_path
    || evidence.predecessor_evidence_sha256 !== predecessor?.evidence_sha256
    || evidence.source_script_sha256 !== expected.sourceScriptSha256
    || evidence.run_identity_file_sha256 !== expected.identityFileSha256
    || evidence.narration_generation_plan_sha256 !== expected.planSha256
    || evidence.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || evidence.narration_quality_contract_sha256 !== expected.qualityContractSha256
    || evidence.pre_review_narration_report_sha256 !== expected.priorReportFileSha256
    || evidence.pre_review_unit_delivery_qa_sha256 !== expected.priorDeliveryFileSha256
    || evidence.pre_review_provider_manifest_sha256 !== expected.priorManifestFileSha256
    || priorReport?.schema !== "goldflow_narration_tts_report_v1"
    || priorReport.status !== "blocked"
    || priorDelivery?.schema !== "goldflow_narration_unit_delivery_qa_v2"
    || priorDelivery.status !== "blocked"
    || priorManifest?.status !== "passed" || currentManifest?.status !== "passed"
    || priorReport.source_script_hash !== expected.sourceScriptSha256
    || priorReport.narration_generation_plan_sha256 !== expected.planSha256
    || priorReport.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || priorReport.provider_output_manifest_sha256 !== expected.priorManifestFileSha256
    || priorReport.asr_orthography_review?.evidence_sha256 !== predecessor.evidence_sha256
    || priorDelivery.source_script_hash !== expected.sourceScriptSha256
    || priorDelivery.narration_generation_plan_sha256 !== expected.planSha256
    || priorDelivery.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || priorDelivery.quality_contract_sha256 !== expected.qualityContractSha256
    || plan?.plan_sha256 !== expected.planSha256
    || !Array.isArray(evidence.units) || evidence.units.length === 0
    || evidence.unit_count !== evidence.units.length) {
    throw new Error("ASR orthography extension v2 lacks exact predecessor, source, plan, or snapshot bindings.");
  }
  const priorResults = new Map((priorReport.results ?? []).map((row) => [row.unit_id, row]));
  const priorQa = new Map((priorDelivery.units ?? []).map((row) => [row.unit_id, row]));
  const priorOutputs = new Map((priorManifest.units ?? []).map((row) => [row.unit_id, row]));
  const currentOutputs = new Map((currentManifest.units ?? []).map((row) => [row.unit_id, row]));
  const planUnits = new Map((plan.units ?? []).map((row) => [row.unit_id, row]));
  const seen = new Set();
  for (const row of evidence.units) {
    const id = String(row?.unit_id ?? "");
    const oldResult = priorResults.get(id), oldQa = priorQa.get(id);
    const oldOutput = priorOutputs.get(id), current = currentOutputs.get(id);
    const unit = planUnits.get(id);
    const blockerCodes = (oldQa?.decision?.blockers ?? []).map((finding) => finding.code);
    const reportCodes = (priorReport.blockers ?? []).filter((finding) => finding.unit_id === id)
      .map((finding) => finding.code);
    const spans = row?.spans;
    const nameOnly = Array.isArray(spans) && spans.every((span) =>
      span.relation === "reviewed_dual_asr_proper_name_spelling");
    const homophoneOnly = Array.isArray(spans) && spans.length === 1
      && spans[0].relation === "reviewed_homophone_spelling";
    const spacingOnly = Array.isArray(spans) && spans.length === 1
      && spans[0].relation === "spacing_join";
    const fragmentContext = Array.isArray(spans) && spans.length === 2
      && spans[0].relation === "reviewed_dual_asr_proper_name_spelling"
      && spans[1].relation === "reviewed_fragment_context_value_expansion";
    const requiredCodes = nameOnly ? ["narration_confirmed_opening_token_mismatch"]
      : homophoneOnly ? ["narration_confirmed_final_token_mismatch"]
        : spacingOnly ? ["narration_confirmed_tts_transcript_protected_value_mismatch",
          "narration_confirmed_word_omission", "narration_confirmed_final_token_mismatch"]
          : fragmentContext ? ["narration_confirmed_tts_transcript_protected_value_mismatch"] : [];
    if (!id || seen.has(id) || predecessor.rows_by_id.has(id)
      || !oldResult || !oldQa || !oldOutput || !current || !unit
      || !Array.isArray(spans) || spans.length < 1 || spans.length > 2
      || ![nameOnly, homophoneOnly, spacingOnly, fragmentContext].some(Boolean)
      || !exactCodes(blockerCodes, requiredCodes)
      || !exactCodes(reportCodes, requiredCodes)
      || !exactCodes(row.reviewed_blocker_codes ?? [], requiredCodes)
      || oldQa.edge_alignment?.status !== "passed"
      || ![1, 2].includes(Number(row.selected_attempt))
      || Number(oldResult.attempt) !== row.selected_attempt
      || Number(oldOutput.attempt) !== row.selected_attempt
      || Number(current.attempt) !== row.selected_attempt
      || oldOutput.status !== "accepted" || current.status !== "accepted"
      || row.audio_path !== oldOutput.audio_path || row.audio_path !== current.audio_path
      || row.audio_sha256 !== oldOutput.audio_sha256
      || row.audio_sha256 !== current.audio_sha256
      || row.audio_sha256 !== oldResult.audio_sha256
      || row.audio_sha256 !== oldQa.audio_sha256
      || actualAudioHashes[id] !== row.audio_sha256
      || row.synthesis_identity_sha256 !== oldOutput.synthesis_identity_sha256
      || row.synthesis_identity_sha256 !== current.synthesis_identity_sha256
      || row.synthesis_identity_sha256 !== oldResult.synthesis_identity_sha256
      || row.intended_text_sha256 !== unit.spoken_text_sha256
      || row.intended_text_sha256 !== oldQa.intended_text_sha256
      || row.intended_text !== unit.spoken_text || row.intended_text !== oldQa.intended_text
      || row.primary_recognized_text !== oldQa.primary_recognized_text
      || row.confirmation_recognized_text !== oldQa.confirmation_recognized_text
      || String(row.review_note ?? "").trim().length < 25) {
      throw new Error(`ASR orthography extension v2 has stale or non-exact unit evidence: ${id || "missing"}.`);
    }
    if (!spans.every(validReviewedSpan)
      || !spans.some((span) => span.position === "opening") && nameOnly
      || homophoneOnly && spans[0].position !== "final"
      || spacingOnly && spans[0].position !== "final"
      || fragmentContext && (spans[0].position !== "interior"
        || spans[1].position !== "interior"
        || row.fragment_context_evidence_path !== fragmentContextDiagnostics[id]?.path
        || row.fragment_context_evidence_sha256 !== fragmentContextDiagnostics[id]?.sha256
        || !fragmentContextDiagnosticMatches({
          diagnostic: fragmentContextDiagnostics[id]?.diagnostic,
          row, oldOutput, expected, nameSpan: spans[0], valueSpan: spans[1] }))) {
      throw new Error(`ASR orthography extension v2 has unsupported reviewed spans: ${id}.`);
    }
    for (const span of spans) {
      if (replaceUniqueReviewedSpan(row.intended_text, span.expected_phrase,
        span.expected_phrase, span.position) == null) {
        throw new Error(`ASR orthography extension v2 does not locate exact source span: ${id}.`);
      }
    }
    for (const [recognized, key] of [[row.primary_recognized_text,
      "primary_observed_phrase"], [row.confirmation_recognized_text,
      "confirmation_observed_phrase"]]) {
      let normalized = recognized;
      for (const span of spans) {
        normalized = replaceUniqueReviewedSpan(normalized, span[key],
          span.expected_phrase, span.position);
        if (normalized == null) break;
      }
      const qa = normalized == null ? null : transcriptQaForTests(row.intended_text,
        normalized, { blockAnySubstitution: false });
      if (!qa || qa.deletions !== 0 || qa.insertions !== 0 || qa.substitutions !== 0
        || qa.first_token_ok !== true || qa.last_token_ok !== true) {
        throw new Error(`ASR orthography extension v2 masks another transcript difference: ${id}.`);
      }
    }
    if (row.selected_attempt === 2) {
      const recovery = oldOutput.recovery_provenance;
      if (recovery?.schema !== "goldflow_qwen_exact_unit_recovery_provenance_v1"
        || recovery.evidence_basis !== "reviewed_automated_delivery_qa"
        || recovery.human_listening_performed !== false
        || recovery.unit_id !== id
        || recovery.spoken_text_sha256 !== row.intended_text_sha256
        || row.selected_recovery_provenance_sha256 !== canonicalQwenBatchSha256(recovery)
        || canonicalQwenBatchSha256(current.recovery_provenance)
          !== canonicalQwenBatchSha256(recovery)) {
        throw new Error(`ASR orthography extension v2 has stale second-take provenance: ${id}.`);
      }
    }
    seen.add(id);
  }
  return { unit_ids: [...seen], rows_by_id: new Map(evidence.units.map((row) => [row.unit_id, row])) };
}

// One additional text-only review is intentionally narrower than the v2
// vocabulary: a previously accepted phonetic proper name at the opening and
// one closed compound that only Medium rendered with a hyphen. It cannot
// reinterpret a different word, plural, article, audio edge or missing token.
export function validateAsrOrthographyExtensionV3ForTests({
  evidence, predecessor, priorReport, priorDelivery, priorManifest,
  currentManifest, plan, expected, actualAudioHashes = {},
} = {}) {
  if (evidence?.schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA
    || evidence.status !== "reviewed"
    || evidence.reviewer_kind !== "editorial_text_review"
    || evidence.human_listening_performed !== false
    || evidence.authorization_origin !== "user_authorized_autonomous_asr_qa"
    || !String(evidence.reviewer ?? "").trim()
    || !Number.isFinite(Date.parse(evidence.reviewed_at))
    || String(evidence.note ?? "").trim().length < 40
    || evidence.predecessor_evidence_path !== predecessor?.evidence_path
    || evidence.predecessor_evidence_sha256 !== predecessor?.evidence_sha256
    || predecessor?.provenance?.schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V2_SCHEMA
    || evidence.source_script_sha256 !== expected?.sourceScriptSha256
    || evidence.run_identity_file_sha256 !== expected?.identityFileSha256
    || evidence.narration_generation_plan_sha256 !== expected?.planSha256
    || evidence.narration_generation_plan_file_sha256 !== expected?.planFileSha256
    || evidence.narration_quality_contract_sha256 !== expected?.qualityContractSha256
    || evidence.pre_review_narration_report_sha256 !== expected?.priorReportFileSha256
    || evidence.pre_review_unit_delivery_qa_sha256 !== expected?.priorDeliveryFileSha256
    || evidence.pre_review_provider_manifest_sha256 !== expected?.priorManifestFileSha256
    || priorReport?.status !== "blocked" || priorDelivery?.status !== "blocked"
    || priorReport.source_script_hash !== expected.sourceScriptSha256
    || priorReport.narration_generation_plan_sha256 !== expected.planSha256
    || priorReport.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || priorReport.provider_output_manifest_sha256 !== expected.priorManifestFileSha256
    || priorReport.asr_orthography_review?.evidence_sha256 !== predecessor.evidence_sha256
    || priorManifest?.status !== "passed" || currentManifest?.status !== "passed"
    || plan?.plan_sha256 !== expected.planSha256
    || !Array.isArray(evidence.units) || evidence.units.length !== 1
    || evidence.unit_count !== 1) {
    throw new Error("ASR orthography v3 lacks the exact v2 predecessor and current source, plan, or snapshot binding.");
  }
  const row = evidence.units[0], id = String(row?.unit_id ?? "");
  const oldResult = (priorReport.results ?? []).find((x) => x.unit_id === id);
  const oldQa = (priorDelivery.units ?? []).find((x) => x.unit_id === id);
  const oldOutput = (priorManifest.units ?? []).find((x) => x.unit_id === id);
  const current = (currentManifest.units ?? []).find((x) => x.unit_id === id);
  const unit = (plan.units ?? []).find((x) => x.unit_id === id);
  const [name, compound] = row?.spans ?? [];
  const required = ["narration_confirmed_opening_token_mismatch"];
  if (!id || predecessor.rows_by_id.has(id)
    || !oldResult || !oldQa || !oldOutput || !current || !unit
    || row.review_schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA
    || row.spans?.length !== 2
    || !exactCodes((oldQa.decision?.blockers ?? []).map((x) => x.code), required)
    || !exactCodes((priorReport.blockers ?? []).filter((x) => x.unit_id === id)
      .map((x) => x.code), required)
    || !exactCodes(row.reviewed_blocker_codes ?? [], required)
    || oldQa.edge_alignment?.status !== "passed"
    || row.selected_attempt !== oldResult.attempt
    || row.selected_attempt !== oldOutput.attempt
    || row.selected_attempt !== current.attempt
    || oldOutput.status !== "accepted" || current.status !== "accepted"
    || row.audio_path !== oldOutput.audio_path
    || row.audio_path !== current.audio_path
    || row.audio_sha256 !== oldOutput.audio_sha256
    || row.audio_sha256 !== current.audio_sha256
    || row.audio_sha256 !== oldResult.audio_sha256
    || row.audio_sha256 !== oldQa.audio_sha256
    || actualAudioHashes[id] !== row.audio_sha256
    || row.synthesis_identity_sha256 !== oldOutput.synthesis_identity_sha256
    || row.synthesis_identity_sha256 !== current.synthesis_identity_sha256
    || row.intended_text !== unit.spoken_text
    || row.intended_text !== oldQa.intended_text
    || row.intended_text_sha256 !== unit.spoken_text_sha256
    || row.intended_text_sha256 !== oldQa.intended_text_sha256
    || row.primary_recognized_text !== oldQa.primary_recognized_text
    || row.confirmation_recognized_text !== oldQa.confirmation_recognized_text
    || String(row.review_note ?? "").trim().length < 40
    || name?.relation !== "reviewed_dual_asr_proper_name_spelling"
    || name.position !== "opening" || !validReviewedSpan(name)
    || compound?.relation !== "closed_compound_hyphenation"
    || compound.position !== "interior"
    || !/^[\p{Ll}]{5,}$/u.test(compound.expected_phrase)
    || compound.primary_observed_phrase !== compound.expected_phrase
    || !/^[\p{Ll}]+-[\p{Ll}]+$/u.test(compound.confirmation_observed_phrase)
    || compound.confirmation_observed_phrase.replace("-", "")
      !== compound.expected_phrase) {
    throw new Error(`ASR orthography v3 has stale or unsupported exact unit evidence: ${id || "missing"}.`);
  }
  for (const span of [name, compound]) {
    if (replaceUniqueReviewedSpan(row.intended_text,
      span.expected_phrase, span.expected_phrase, span.position) == null) {
      throw new Error(`ASR orthography v3 does not locate the unique source span: ${id}.`);
    }
  }
  for (const [recognized, key] of [[row.primary_recognized_text,
    "primary_observed_phrase"], [row.confirmation_recognized_text,
    "confirmation_observed_phrase"]]) {
    let normalized = recognized;
    for (const span of [name, compound]) {
      normalized = replaceUniqueReviewedSpan(normalized, span[key],
        span.expected_phrase, span.position);
      if (normalized == null) break;
    }
    const qa = normalized == null ? null : transcriptQaForTests(row.intended_text,
      normalized, { blockAnySubstitution: false });
    if (!qa || qa.deletions !== 0 || qa.insertions !== 0
      || qa.substitutions !== 0 || !qa.first_token_ok || !qa.last_token_ok) {
      throw new Error(`ASR orthography v3 masks another transcript difference: ${id}.`);
    }
  }
  return { unit_ids: [id], rows_by_id: new Map([[id, row]]) };
}

// Two further exact-text reviews after a source-exact acoustic repair: a
// previously established proper-name spelling and one full-unit ASR spelling
// resolved by both independent ASR passes on the selected opening fragment.
// The latter remains bound to the unchanged fragment WAV and sidecar. Every
// other word in the full unit and fragment must match the approved text.
export function validateAsrOrthographyExtensionV4ForTests({
  evidence, predecessor, priorReport, priorDelivery, priorManifest,
  currentManifest, plan, expected, actualAudioHashes = {},
  fragmentDiagnostics = {},
} = {}) {
  if (evidence?.schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V4_SCHEMA
    || evidence.status !== "reviewed"
    || evidence.reviewer_kind !== "editorial_text_review"
    || evidence.human_listening_performed !== false
    || evidence.authorization_origin !== "user_authorized_autonomous_asr_qa"
    || !String(evidence.reviewer ?? "").trim()
    || !Number.isFinite(Date.parse(evidence.reviewed_at))
    || String(evidence.note ?? "").trim().length < 40
    || evidence.predecessor_evidence_path !== predecessor?.evidence_path
    || evidence.predecessor_evidence_sha256 !== predecessor?.evidence_sha256
    || predecessor?.provenance?.schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA
    || evidence.source_script_sha256 !== expected?.sourceScriptSha256
    || evidence.run_identity_file_sha256 !== expected?.identityFileSha256
    || evidence.narration_generation_plan_sha256 !== expected?.planSha256
    || evidence.narration_generation_plan_file_sha256 !== expected?.planFileSha256
    || evidence.narration_quality_contract_sha256 !== expected?.qualityContractSha256
    || evidence.pre_review_narration_report_sha256 !== expected?.priorReportFileSha256
    || evidence.pre_review_unit_delivery_qa_sha256 !== expected?.priorDeliveryFileSha256
    || evidence.pre_review_provider_manifest_sha256 !== expected?.priorManifestFileSha256
    || priorReport?.status !== "blocked" || priorDelivery?.status !== "blocked"
    || priorReport.source_script_hash !== expected.sourceScriptSha256
    || priorReport.narration_generation_plan_sha256 !== expected.planSha256
    || priorReport.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || priorReport.provider_output_manifest_sha256 !== expected.priorManifestFileSha256
    || priorReport.asr_orthography_review?.evidence_sha256 !== predecessor.evidence_sha256
    || priorManifest?.status !== "passed" || currentManifest?.status !== "passed"
    || plan?.plan_sha256 !== expected.planSha256
    || !Array.isArray(evidence.units) || evidence.units.length !== 2
    || evidence.unit_count !== 2) {
    throw new Error("ASR orthography v4 lacks the exact v3 predecessor and current source, plan, or snapshot binding.");
  }
  const selected = new Set(evidence.units.map((row) => row.unit_id));
  const blocked = [...new Set((priorReport.blockers ?? []).map((row) => row.unit_id))];
  const deliveryBlocked = [...new Set((priorDelivery.blockers ?? [])
    .map((row) => row.unit_id))];
  if (selected.size !== 2
    || !exactCodes(blocked, deliveryBlocked)
    || !exactCodes(evidence.preserved_blocked_unit_ids ?? [],
      blocked.filter((id) => !selected.has(id)))) {
    throw new Error("ASR orthography v4 does not preserve every unselected blocker.");
  }
  const acceptedSpellings = (expectedName) => {
    const spellings = new Set();
    for (const prior of predecessor.rows_by_id.values()) {
      for (const span of prior.spans ?? []) {
        if (span.relation === "reviewed_dual_asr_proper_name_spelling"
          && lower(span.expected_phrase) === lower(expectedName)) {
          spellings.add(lower(span.primary_observed_phrase));
          spellings.add(lower(span.confirmation_observed_phrase));
        }
      }
    }
    return spellings;
  };
  const methods = new Set();
  for (const row of evidence.units) {
    const id = String(row?.unit_id ?? "");
    const oldResult = (priorReport.results ?? []).find((x) => x.unit_id === id);
    const oldQa = (priorDelivery.units ?? []).find((x) => x.unit_id === id);
    const oldOutput = (priorManifest.units ?? []).find((x) => x.unit_id === id);
    const current = (currentManifest.units ?? []).find((x) => x.unit_id === id);
    const unit = (plan.units ?? []).find((x) => x.unit_id === id);
    const span = row?.spans?.[0];
    const required = ["narration_confirmed_opening_token_mismatch"];
    const known = acceptedSpellings(span?.expected_phrase);
    const reviewedName = row.review_method === "fragment_context_name_spelling"
      ? validReviewedSpan({ ...span,
        primary_observed_phrase: span?.confirmation_observed_phrase })
        && [...known].some((spelling) =>
          soundex(spelling) === soundex(span?.primary_observed_phrase)
          && editDistance(spelling, lower(span?.primary_observed_phrase)) <= 2)
      : validReviewedSpan(span);
    if (!id || predecessor.rows_by_id.has(id)
      || !oldResult || !oldQa || !oldOutput || !current || !unit
      || row.review_schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V4_SCHEMA
      || !["dual_full_unit_name_spelling", "fragment_context_name_spelling"]
        .includes(row.review_method) || methods.has(row.review_method)
      || row.spans?.length !== 1
      || span?.relation !== "reviewed_dual_asr_proper_name_spelling"
      || span.position !== "opening" || !reviewedName
      || known.size === 0
      || !known.has(lower(span.confirmation_observed_phrase))
      || row.review_method === "dual_full_unit_name_spelling"
        && !known.has(lower(span.primary_observed_phrase))
      || !exactCodes((oldQa.decision?.blockers ?? []).map((x) => x.code), required)
      || !exactCodes((priorReport.blockers ?? []).filter((x) => x.unit_id === id)
        .map((x) => x.code), required)
      || !exactCodes(row.reviewed_blocker_codes ?? [], required)
      || oldQa.edge_alignment?.status !== "passed"
      || row.selected_attempt !== oldResult.attempt
      || row.selected_attempt !== oldOutput.attempt
      || row.selected_attempt !== current.attempt
      || oldOutput.status !== "accepted" || current.status !== "accepted"
      || row.audio_path !== oldOutput.audio_path
      || row.audio_path !== current.audio_path
      || row.audio_sha256 !== oldOutput.audio_sha256
      || row.audio_sha256 !== current.audio_sha256
      || row.audio_sha256 !== oldResult.audio_sha256
      || row.audio_sha256 !== oldQa.audio_sha256
      || actualAudioHashes[id] !== row.audio_sha256
      || row.synthesis_identity_sha256 !== oldOutput.synthesis_identity_sha256
      || row.synthesis_identity_sha256 !== current.synthesis_identity_sha256
      || row.intended_text !== unit.spoken_text
      || row.intended_text !== oldQa.intended_text
      || row.intended_text_sha256 !== unit.spoken_text_sha256
      || row.intended_text_sha256 !== oldQa.intended_text_sha256
      || row.primary_recognized_text !== oldQa.primary_recognized_text
      || row.confirmation_recognized_text !== oldQa.confirmation_recognized_text
      || String(row.review_note ?? "").trim().length < 40) {
      throw new Error(`ASR orthography v4 has stale or unsupported exact unit evidence: ${id || "missing"}.`);
    }
    if (replaceUniqueReviewedSpan(row.intended_text, span.expected_phrase,
      span.expected_phrase, "opening") == null) {
      throw new Error(`ASR orthography v4 does not locate the source name: ${id}.`);
    }
    for (const [recognized, observed] of [[row.primary_recognized_text,
      span.primary_observed_phrase], [row.confirmation_recognized_text,
      span.confirmation_observed_phrase]]) {
      const normalized = replaceUniqueReviewedSpan(recognized, observed,
        span.expected_phrase, "opening");
      const qa = normalized == null ? null : transcriptQaForTests(row.intended_text,
        normalized, { blockAnySubstitution: false });
      if (!qa || qa.deletions !== 0 || qa.insertions !== 0
        || qa.substitutions !== 0 || !qa.first_token_ok || !qa.last_token_ok) {
        throw new Error(`ASR orthography v4 masks another full-unit difference: ${id}.`);
      }
    }
    if (row.review_method === "fragment_context_name_spelling") {
      const bound = fragmentDiagnostics[id];
      const diagnostic = bound?.diagnostic;
      const fragment = oldOutput.synthesis_identity?.fragments?.[0];
      const sidecar = bound?.sidecar;
      const contracts = [diagnostic?.small?.contract, diagnostic?.medium?.contract];
      const heard = [diagnostic?.small?.recognized_text,
        diagnostic?.medium?.recognized_text];
      if (row.fragment_context_evidence_path !== bound?.path
        || row.fragment_context_evidence_sha256 !== bound?.sha256
        || diagnostic?.schema !== "goldflow_narration_fragment_name_context_asr_diagnostic_v1"
        || diagnostic.status !== "observed"
        || diagnostic.human_listening_performed !== false
        || diagnostic.diagnostic_origin !== "read_only_local_faster_whisper_dual_asr"
        || diagnostic.unit_id !== id || diagnostic.fragment_index !== 0
        || diagnostic.source_script_sha256 !== expected.sourceScriptSha256
        || diagnostic.narration_generation_plan_sha256 !== expected.planSha256
        || diagnostic.composite_manifest_sha256 !== expected.priorManifestFileSha256
        || diagnostic.source_text_sha256 !== sha256(diagnostic.source_text)
        || diagnostic.source_text_sha256 !== fragment?.text_sha256
        || sidecar?.text !== diagnostic.source_text
        || diagnostic.fragment_audio_sha256 !== fragment?.audio_sha256
        || diagnostic.fragment_sidecar_sha256 !== fragment?.sidecar_sha256
        || bound?.audioHash !== diagnostic.fragment_audio_sha256
        || bound?.sidecarHash !== diagnostic.fragment_sidecar_sha256
        || diagnostic.repair_request_path !== oldOutput.recovery_provenance?.request_path
        || diagnostic.repair_result_path !== oldOutput.recovery_provenance?.result_path
        || !sameTextPrefix(diagnostic.source_text, span.expected_phrase)
        || contracts[0]?.model !== "small.en" || contracts[1]?.model !== "medium"
        || contracts.some((contract) => contract.device !== "cpu"
          || contract.compute_type !== "int8_float32"
          || contract.language !== "en" || contract.beam_size !== 5
          || contract.word_timestamps !== true || contract.vad_filter !== false)
        || Number(diagnostic.small?.duration_sec) <= 0
        || Math.abs(Number(diagnostic.small.duration_sec)
          - Number(diagnostic.medium?.duration_sec)) > 0.05
        || Math.abs(Number(diagnostic.small.duration_sec)
          - Number(sidecar?.sample_count) / 24000) > 0.05) {
        throw new Error(`ASR orthography v4 fragment evidence is stale: ${id}.`);
      }
      for (const recognized of heard) {
        const opening = words(recognized)[0]?.text;
        if (!known.has(lower(opening))) {
          throw new Error(`ASR orthography v4 fragment name lacks prior spelling precedent: ${id}.`);
        }
        const normalized = replaceUniqueReviewedSpan(recognized, opening,
          span.expected_phrase, "opening");
        const qa = normalized == null ? null : transcriptQaForTests(
          diagnostic.source_text, normalized, { blockAnySubstitution: false });
        if (!qa || qa.deletions !== 0 || qa.insertions !== 0
          || qa.substitutions !== 0 || !qa.first_token_ok || !qa.last_token_ok) {
          throw new Error(`ASR orthography v4 fragment masks another word difference: ${id}.`);
        }
      }
    } else if (row.fragment_context_evidence_path
      || row.fragment_context_evidence_sha256) {
      throw new Error(`ASR orthography v4 plain name review has extraneous fragment evidence: ${id}.`);
    }
    methods.add(row.review_method);
  }
  if (methods.size !== 2) {
    throw new Error("ASR orthography v4 requires distinct full-unit and fragment-context reviews.");
  }
  return { unit_ids: [...selected], rows_by_id: new Map(evidence.units.map((row) => [row.unit_id, row])) };
}

function sameTextPrefix(text, expectedName) {
  return lower(words(text)[0]?.text) === lower(expectedName);
}

// A prior QA decision may already classify a single interior plural/singular
// difference as advisory. This review resolves only the independently
// established opening-name spelling. It retains the lexical warning without
// claiming the plural was spoken or treating the whole transcript as exact.
export function validateAsrOrthographyExtensionV5ForTests({
  evidence, predecessor, priorReport, priorDelivery, priorManifest,
  currentManifest, plan, expected, actualAudioHashes = {},
} = {}) {
  if (evidence?.schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V5_SCHEMA
    || evidence.status !== "reviewed"
    || evidence.reviewer_kind !== "editorial_text_review"
    || evidence.human_listening_performed !== false
    || evidence.authorization_origin !== "user_authorized_autonomous_asr_qa"
    || !String(evidence.reviewer ?? "").trim()
    || !Number.isFinite(Date.parse(evidence.reviewed_at))
    || String(evidence.note ?? "").trim().length < 40
    || evidence.predecessor_evidence_path !== predecessor?.evidence_path
    || evidence.predecessor_evidence_sha256 !== predecessor?.evidence_sha256
    || predecessor?.provenance?.schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V4_SCHEMA
    || evidence.source_script_sha256 !== expected?.sourceScriptSha256
    || evidence.run_identity_file_sha256 !== expected?.identityFileSha256
    || evidence.narration_generation_plan_sha256 !== expected?.planSha256
    || evidence.narration_generation_plan_file_sha256 !== expected?.planFileSha256
    || evidence.narration_quality_contract_sha256 !== expected?.qualityContractSha256
    || evidence.pre_review_narration_report_sha256 !== expected?.priorReportFileSha256
    || evidence.pre_review_unit_delivery_qa_sha256 !== expected?.priorDeliveryFileSha256
    || evidence.pre_review_provider_manifest_sha256 !== expected?.priorManifestFileSha256
    || priorReport?.status !== "blocked" || priorDelivery?.status !== "blocked"
    || priorReport.source_script_hash !== expected.sourceScriptSha256
    || priorReport.narration_generation_plan_sha256 !== expected.planSha256
    || priorReport.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || priorReport.provider_output_manifest_sha256 !== expected.priorManifestFileSha256
    || priorReport.asr_orthography_review?.evidence_sha256 !== predecessor.evidence_sha256
    || priorManifest?.status !== "passed" || currentManifest?.status !== "passed"
    || plan?.plan_sha256 !== expected.planSha256
    || !Array.isArray(evidence.units) || evidence.units.length !== 1
    || evidence.unit_count !== 1) {
    throw new Error("ASR orthography v5 lacks its exact v4 predecessor or current source, plan, and report bindings.");
  }
  const row = evidence.units[0];
  const id = String(row?.unit_id ?? "");
  const oldResult = (priorReport.results ?? []).find((x) => x.unit_id === id);
  const oldQa = (priorDelivery.units ?? []).find((x) => x.unit_id === id);
  const oldOutput = (priorManifest.units ?? []).find((x) => x.unit_id === id);
  const current = (currentManifest.units ?? []).find((x) => x.unit_id === id);
  const unit = (plan.units ?? []).find((x) => x.unit_id === id);
  const name = row?.spans?.[0];
  const advisory = row?.retained_advisory;
  const required = ["narration_confirmed_opening_token_mismatch"];
  const priorSpellings = new Set();
  for (const prior of predecessor.rows_by_id.values()) {
    for (const span of prior.spans ?? []) {
      if (span.relation === "reviewed_dual_asr_proper_name_spelling"
        && lower(span.expected_phrase) === lower(name?.expected_phrase)) {
        priorSpellings.add(lower(span.primary_observed_phrase));
        priorSpellings.add(lower(span.confirmation_observed_phrase));
      }
    }
  }
  const lexicalWarning = (oldQa?.decision?.warnings ?? []).filter((warning) =>
    warning.code === "narration_confirmed_lexical_or_pronunciation_difference");
  const warning = lexicalWarning[0];
  const expectedWord = lower(advisory?.expected_phrase);
  const observedWord = lower(advisory?.observed_phrase);
  if (!id || predecessor.rows_by_id.has(id)
    || !oldResult || !oldQa || !oldOutput || !current || !unit
    || row.review_schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V5_SCHEMA
    || row.review_method !== "opening_name_only_retaining_lexical_advisory"
    || row.spans?.length !== 1
    || name?.relation !== "reviewed_dual_asr_proper_name_spelling"
    || name.position !== "opening" || !validReviewedSpan(name)
    || !priorSpellings.has(lower(name.primary_observed_phrase))
    || !priorSpellings.has(lower(name.confirmation_observed_phrase))
    || !exactCodes((priorReport.blockers ?? []).map((x) => x.unit_id), [id])
    || !exactCodes((priorDelivery.blockers ?? []).map((x) => x.unit_id), [id])
    || !exactCodes((oldQa.decision?.blockers ?? []).map((x) => x.code), required)
    || !exactCodes((priorReport.blockers ?? []).filter((x) => x.unit_id === id)
      .map((x) => x.code), required)
    || !exactCodes(row.reviewed_blocker_codes ?? [], required)
    || oldQa.edge_alignment?.status !== "passed"
    || row.selected_attempt !== oldResult.attempt
    || row.selected_attempt !== oldOutput.attempt
    || row.selected_attempt !== current.attempt
    || oldOutput.status !== "accepted" || current.status !== "accepted"
    || row.audio_path !== oldOutput.audio_path
    || row.audio_path !== current.audio_path
    || row.audio_sha256 !== oldOutput.audio_sha256
    || row.audio_sha256 !== current.audio_sha256
    || row.audio_sha256 !== oldResult.audio_sha256
    || row.audio_sha256 !== oldQa.audio_sha256
    || actualAudioHashes[id] !== row.audio_sha256
    || row.synthesis_identity_sha256 !== oldOutput.synthesis_identity_sha256
    || row.synthesis_identity_sha256 !== current.synthesis_identity_sha256
    || row.audio_path !== oldResult.audio_path
    || row.audio_path !== oldQa.audio_path
    || row.intended_text !== unit.spoken_text
    || row.intended_text !== oldQa.intended_text
    || row.intended_text_sha256 !== unit.spoken_text_sha256
    || row.intended_text_sha256 !== oldQa.intended_text_sha256
    || row.primary_recognized_text !== oldQa.primary_recognized_text
    || row.confirmation_recognized_text !== oldQa.confirmation_recognized_text
    || String(row.review_note ?? "").trim().length < 40
    || advisory?.disposition !== "retain_as_nonblocking_warning"
    || advisory?.warning_code !== "narration_confirmed_lexical_or_pronunciation_difference"
    || lexicalWarning.length !== 1
    || warning?.severity !== "warning" || warning?.disposition !== "advisory_no_retry"
    || warning?.review_required !== false
    || !exactCodes(warning?.operations ?? [], [`${expectedWord}->${observedWord}`])
    || advisory.warning_sha256 !== sha256(JSON.stringify(warning))
    || !/^[\p{L}]{5,}s$/u.test(expectedWord)
    || observedWord !== expectedWord.slice(0, -1)
    || lower(name.expected_phrase) === expectedWord) {
    throw new Error(`ASR orthography v5 cannot clear a non-name blocker or alter its retained advisory: ${id || "missing"}.`);
  }
  if (replaceUniqueReviewedSpan(row.intended_text,
    name.expected_phrase, name.expected_phrase, "opening") == null) {
    throw new Error(`ASR orthography v5 cannot locate the source opening name: ${id}.`);
  }
  for (const [recognized, observedName] of [
    [row.primary_recognized_text, name.primary_observed_phrase],
    [row.confirmation_recognized_text, name.confirmation_observed_phrase],
  ]) {
    const normalized = replaceUniqueReviewedSpan(recognized,
      observedName, name.expected_phrase, "opening");
    const intendedTokens = words(row.intended_text).map((word) => lower(word.text));
    const heardTokens = normalized == null ? [] : words(normalized)
      .map((word) => lower(word.text));
    const mismatches = intendedTokens.flatMap((token, index) =>
      token === heardTokens[index] ? [] : [{ index, token,
        heard: heardTokens[index] }]);
    const qa = normalized == null ? null : transcriptQaForTests(
      row.intended_text, normalized, { blockAnySubstitution: false });
    if (!qa || heardTokens.length !== intendedTokens.length
      || mismatches.length !== 1
      || mismatches[0].index === 0
      || mismatches[0].index === intendedTokens.length - 1
      || mismatches[0].token !== expectedWord
      || mismatches[0].heard !== observedWord
      || qa.deletions !== 0 || qa.insertions !== 0 || qa.substitutions !== 1
      || !qa.first_token_ok || !qa.last_token_ok) {
      throw new Error(`ASR orthography v5 masks a second lexical difference: ${id}.`);
    }
  }
  return { unit_ids: [id], rows_by_id: new Map([[id, row]]) };
}

export function validateAsrOrthographyAmendmentForTests({
  evidence, predecessor, priorReport, priorDelivery, priorManifest,
  currentManifest, plan, expected, actualAudioHashes = {}, runnerReport,
} = {}) {
  if (evidence?.schema !== NARRATION_ASR_ORTHOGRAPHY_AMENDMENT_SCHEMA
    || evidence.status !== "reviewed" || evidence.reviewer_kind !== "editorial_text_review"
    || evidence.human_listening_performed !== false
    || evidence.authorization_origin !== "user_authorized_autonomous_asr_qa"
    || !String(evidence.reviewer ?? "").trim()
    || !Number.isFinite(Date.parse(evidence.reviewed_at))
    || String(evidence.note ?? "").trim().length < 40
    || evidence.predecessor_evidence_path !== predecessor?.evidence_path
    || evidence.predecessor_evidence_sha256 !== predecessor?.evidence_sha256
    || evidence.source_script_sha256 !== expected.sourceScriptSha256
    || evidence.run_identity_file_sha256 !== expected.identityFileSha256
    || evidence.narration_generation_plan_sha256 !== expected.planSha256
    || evidence.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || evidence.narration_quality_contract_sha256 !== expected.qualityContractSha256
    || evidence.pre_review_narration_report_sha256 !== expected.priorReportFileSha256
    || evidence.pre_review_unit_delivery_qa_sha256 !== expected.priorDeliveryFileSha256
    || evidence.pre_review_provider_manifest_sha256 !== expected.priorManifestFileSha256
    || priorReport?.schema !== "goldflow_narration_tts_report_v1"
    || priorDelivery?.schema !== "goldflow_narration_unit_delivery_qa_v2"
    || priorReport.status !== "blocked" || priorDelivery.status !== "blocked"
    || priorManifest?.status !== "passed" || currentManifest?.status !== "passed"
    || priorReport.source_script_hash !== expected.sourceScriptSha256
    || priorReport.narration_generation_plan_sha256 !== expected.planSha256
    || priorReport.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || priorReport.provider_output_manifest_sha256 !== expected.priorManifestFileSha256
    || priorReport.asr_orthography_review?.evidence_sha256 !== predecessor.evidence_sha256
    || priorDelivery.source_script_hash !== expected.sourceScriptSha256
    || priorDelivery.narration_generation_plan_sha256 !== expected.planSha256
    || priorDelivery.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || priorDelivery.quality_contract_sha256 !== expected.qualityContractSha256
    || plan?.plan_sha256 !== expected.planSha256
    || evidence.unit_count !== 1 || evidence.units?.length !== 1) {
    throw new Error("ASR orthography amendment lacks exact predecessor, source, plan, or snapshot bindings.");
  }
  const row = evidence.units[0];
  const id = String(row?.unit_id ?? "");
  const oldResult = (priorReport.results ?? []).find((item) => item.unit_id === id);
  const oldQa = (priorDelivery.units ?? []).find((item) => item.unit_id === id);
  const oldOutput = (priorManifest.units ?? []).find((item) => item.unit_id === id);
  const current = (currentManifest.units ?? []).find((item) => item.unit_id === id);
  const unit = (plan.units ?? []).find((item) => item.unit_id === id);
  const code = "narration_confirmed_final_token_mismatch";
  const recovery = oldOutput?.recovery_provenance;
  const runnerRows = (runnerReport?.results ?? []).filter((item) => item.unit_id === id);
  const generated = runnerRows[0];
  if (!id || !oldResult || !oldQa || !oldOutput || !current || !unit
    || !exactCodes((oldQa.decision?.blockers ?? []).map((item) => item.code), [code])
    || !exactCodes((priorReport.blockers ?? []).filter((item) => item.unit_id === id)
      .map((item) => item.code), [code])
    || !exactCodes(row.reviewed_blocker_codes ?? [], [code])
    || row.selected_attempt !== 2 || Number(oldResult.attempt) !== 2
    || Number(oldOutput.attempt) !== 2 || Number(current.attempt) !== 2
    || oldOutput.status !== "accepted" || current.status !== "accepted"
    || row.audio_path !== oldOutput.audio_path || row.audio_path !== current.audio_path
    || row.audio_sha256 !== oldOutput.audio_sha256
    || row.audio_sha256 !== current.audio_sha256
    || row.audio_sha256 !== oldResult.audio_sha256
    || row.audio_sha256 !== oldQa.audio_sha256
    || actualAudioHashes[id] !== row.audio_sha256
    || row.synthesis_identity_sha256 !== oldOutput.synthesis_identity_sha256
    || row.synthesis_identity_sha256 !== current.synthesis_identity_sha256
    || row.synthesis_identity_sha256 !== oldResult.synthesis_identity_sha256
    || row.intended_text_sha256 !== unit.spoken_text_sha256
    || row.intended_text_sha256 !== oldQa.intended_text_sha256
    || row.intended_text !== unit.spoken_text || row.intended_text !== oldQa.intended_text
    || row.primary_recognized_text !== oldQa.primary_recognized_text
    || row.confirmation_recognized_text !== oldQa.confirmation_recognized_text
    || !String(row.review_note ?? "").trim() || row.review_note.trim().length < 25
    || recovery?.schema !== "goldflow_qwen_exact_unit_recovery_provenance_v1"
    || recovery.evidence_basis !== "reviewed_automated_delivery_qa"
    || recovery.human_listening_performed !== false
    || recovery.unit_id !== id || !hex(recovery.origin_audio_sha256)
    || !hex(recovery.origin_synthesis_identity_sha256)
    || recovery.spoken_text_sha256 !== row.intended_text_sha256
    || !exactCodes(recovery.trigger_codes ?? [], ["reviewed_automated_delivery_qa_delivery"])
    || row.selected_recovery_provenance_sha256 !== canonicalQwenBatchSha256(recovery)
    || canonicalQwenBatchSha256(current.recovery_provenance) !== canonicalQwenBatchSha256(recovery)
    || row.runner_report_path !== oldOutput.runner_report_path
    || row.runner_report_sha256 !== oldOutput.runner_report_sha256
    || runnerReport?.status !== "passed" || runnerRows.length !== 1
    || generated.status !== "generated" || Number(generated.attempt) !== 2
    || generated.output_path !== row.audio_path
    || generated.output_sha256 !== row.audio_sha256
    || generated.synthesis_identity_sha256 !== row.synthesis_identity_sha256
    || generated.spoken_text_sha256 !== row.intended_text_sha256
    || canonicalQwenBatchSha256(generated.recovery_provenance) !== canonicalQwenBatchSha256(recovery)
    || generated.token_limit_reached !== false) {
    throw new Error(`ASR orthography amendment has stale second-take or runner evidence: ${id || "missing"}.`);
  }
  const joins = row.joins;
  if (!Array.isArray(joins) || joins.length !== 2
    || !exactCodes(joins.map((join) => join.position), ["interior", "final"])
    || row.edge !== "final" || row.relation !== "spacing_join"
    || row.expected_phrase !== joins.find((join) => join.position === "final")?.expected_phrase
    || row.observed_phrase !== joins.find((join) => join.position === "final")?.observed_phrase) {
    throw new Error(`ASR orthography amendment requires one interior and one final spacing join: ${id}.`);
  }
  for (const join of joins) {
    const expectedWords = words(join.expected_phrase);
    const observedWords = words(join.observed_phrase);
    if (join.relation !== "spacing_join" || expectedWords.length !== 1
      || observedWords.length !== 2
      || lower(expectedWords.map((word) => word.text).join(""))
        !== lower(observedWords.map((word) => word.text).join(""))
      || replaceUniqueWholePhrase(row.intended_text,
        join.expected_phrase, join.expected_phrase, join.position) == null) {
      throw new Error(`ASR orthography amendment has a non-exact spacing join: ${id}.`);
    }
  }
  for (const transcript of [row.primary_recognized_text, row.confirmation_recognized_text]) {
    let normalized = transcript;
    for (const join of joins) {
      normalized = replaceUniqueWholePhrase(normalized,
        join.observed_phrase, join.expected_phrase, join.position);
      if (normalized == null) break;
    }
    if (normalized == null) {
      throw new Error(`ASR orthography amendment cannot locate both exact joins: ${id}.`);
    }
    const qa = transcriptQaForTests(row.intended_text, normalized,
      { blockAnySubstitution: false });
    if (qa.deletions !== 0 || qa.insertions !== 0 || qa.substitutions !== 0
      || qa.first_token_ok !== true || qa.last_token_ok !== true) {
      throw new Error(`ASR orthography amendment would mask another transcript difference: ${id}.`);
    }
  }
  return { unit_ids: [id], rows_by_id: new Map([[id, row]]) };
}

export function validateAsrOrthographyReviewForTests({
  evidence, priorReport, priorDelivery, priorManifest, currentManifest, plan,
  expected, actualAudioHashes = {},
} = {}) {
  if (evidence?.schema !== NARRATION_ASR_ORTHOGRAPHY_SCHEMA
    || evidence.status !== "reviewed"
    || evidence.reviewer_kind !== "editorial_text_review"
    || evidence.human_listening_performed !== false
    || evidence.authorization_origin !== "user_authorized_autonomous_asr_qa"
    || !String(evidence.reviewer ?? "").trim()
    || !Number.isFinite(Date.parse(evidence.reviewed_at))
    || String(evidence.note ?? "").trim().length < 40
    || evidence.source_script_sha256 !== expected.sourceScriptSha256
    || evidence.run_identity_file_sha256 !== expected.identityFileSha256
    || evidence.narration_generation_plan_sha256 !== expected.planSha256
    || evidence.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || evidence.narration_quality_contract_sha256 !== expected.qualityContractSha256
    || evidence.pre_review_narration_report_sha256 !== expected.priorReportFileSha256
    || evidence.pre_review_unit_delivery_qa_sha256 !== expected.priorDeliveryFileSha256
    || evidence.pre_review_provider_manifest_sha256 !== expected.priorManifestFileSha256
    || priorReport?.schema !== "goldflow_narration_tts_report_v1"
    || priorReport.status !== "blocked"
    || priorDelivery?.schema !== "goldflow_narration_unit_delivery_qa_v2"
    || priorDelivery.status !== "blocked"
    || priorManifest?.status !== "passed"
    || currentManifest?.status !== "passed"
    || priorReport.source_script_hash !== expected.sourceScriptSha256
    || priorReport.narration_generation_plan_sha256 !== expected.planSha256
    || priorReport.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || priorReport.provider_output_manifest_sha256 !== expected.priorManifestFileSha256
    || priorDelivery.source_script_hash !== expected.sourceScriptSha256
    || priorDelivery.narration_generation_plan_sha256 !== expected.planSha256
    || priorDelivery.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || priorDelivery.quality_contract_sha256 !== expected.qualityContractSha256
    || plan?.plan_sha256 !== expected.planSha256
    || !Array.isArray(evidence.units) || !evidence.units.length
    || evidence.unit_count !== evidence.units.length) {
    throw new Error("ASR orthography review has stale identity, source, plan, report, or manifest bindings.");
  }
  const priorResults = new Map((priorReport.results ?? []).map((row) => [row.unit_id, row]));
  const priorQa = new Map((priorDelivery.units ?? []).map((row) => [row.unit_id, row]));
  const priorOutputs = new Map((priorManifest.units ?? []).map((row) => [row.unit_id, row]));
  const currentOutputs = new Map((currentManifest.units ?? []).map((row) => [row.unit_id, row]));
  const planUnits = new Map((plan.units ?? []).map((row) => [row.unit_id, row]));
  const seen = new Set();
  for (const row of evidence.units) {
    const id = String(row?.unit_id ?? "");
    const oldResult = priorResults.get(id);
    const oldQa = priorQa.get(id);
    const oldOutput = priorOutputs.get(id);
    const current = currentOutputs.get(id);
    const unit = planUnits.get(id);
    const expectedCode = row.edge === "opening"
      ? "narration_confirmed_opening_token_mismatch"
      : row.edge === "final" ? "narration_confirmed_final_token_mismatch" : null;
    const codes = (oldQa?.decision?.blockers ?? []).map((finding) => finding.code);
    const reportCodes = (priorReport.blockers ?? []).filter((finding) => finding.unit_id === id)
      .map((finding) => finding.code);
    if (!id || seen.has(id) || !oldResult || !oldQa || !oldOutput || !current || !unit
      || !expectedCode || !exactCodes(codes, [expectedCode])
      || !exactCodes(reportCodes, [expectedCode])
      || !exactCodes(row.reviewed_blocker_codes ?? [], [expectedCode])
      || Number(oldResult.attempt) !== 1 || Number(oldOutput.attempt) !== 1
      || Number(current.attempt) !== 1
      || row.audio_path !== oldOutput.audio_path
      || row.audio_path !== current.audio_path
      || row.audio_sha256 !== oldOutput.audio_sha256
      || row.audio_sha256 !== current.audio_sha256
      || row.audio_sha256 !== oldResult.audio_sha256
      || row.audio_sha256 !== oldQa.audio_sha256
      || actualAudioHashes[id] !== row.audio_sha256
      || row.synthesis_identity_sha256 !== oldOutput.synthesis_identity_sha256
      || row.synthesis_identity_sha256 !== current.synthesis_identity_sha256
      || row.synthesis_identity_sha256 !== oldResult.synthesis_identity_sha256
      || row.intended_text_sha256 !== unit.spoken_text_sha256
      || row.intended_text_sha256 !== oldQa.intended_text_sha256
      || row.intended_text !== unit.spoken_text
      || row.intended_text !== oldQa.intended_text
      || row.primary_recognized_text !== oldQa.primary_recognized_text
      || row.confirmation_recognized_text !== oldQa.confirmation_recognized_text
      || !String(row.review_note ?? "").trim()
      || row.review_note.trim().length < 25) {
      throw new Error(`ASR orthography review has stale or non-exact unit evidence: ${id || "missing"}.`);
    }
    const expectedPhrase = String(row.expected_phrase ?? "");
    const observedPhrase = String(row.observed_phrase ?? "");
    const expectedWords = words(expectedPhrase);
    const observedWords = words(observedPhrase);
    const spacingJoin = row.relation === "spacing_join"
      && lower(expectedWords.map((word) => word.text).join(""))
        === lower(observedWords.map((word) => word.text).join(""))
      && expectedWords.length !== observedWords.length;
    const homophoneSpelling = row.relation === "reviewed_homophone_spelling"
      && expectedWords.length === 1 && observedWords.length === 1
      && lower(expectedPhrase) !== lower(observedPhrase)
      && soundex(expectedPhrase) === soundex(observedPhrase)
      && editDistance(lower(expectedPhrase), lower(observedPhrase)) <= 2;
    if (!spacingJoin && !homophoneSpelling) {
      throw new Error(`ASR orthography review lacks a constrained spelling relation: ${id}.`);
    }
    for (const transcript of [row.primary_recognized_text, row.confirmation_recognized_text]) {
      if (!unchangedExceptReviewedPhrase({ intended: row.intended_text,
        recognized: transcript, expectedPhrase, observedPhrase, edge: row.edge })) {
        throw new Error(`ASR orthography review would mask another transcript difference: ${id}.`);
      }
    }
    seen.add(id);
  }
  return { unit_ids: [...seen], rows_by_id: new Map(evidence.units.map((row) => [row.unit_id, row])) };
}

// Add only independently reviewed, dual-ASR spellings to an already applied
// orthography receipt. Both passes may spell the same spoken name differently;
// every other word must still match the locked text exactly. This is text
// review, not an assertion that anyone listened to the audio.
export function validateAsrOrthographyExtensionForTests({
  evidence, predecessor, priorReport, priorDelivery, priorManifest,
  currentManifest, plan, expected, actualAudioHashes = {},
} = {}) {
  if (evidence?.schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_SCHEMA
    || evidence.status !== "reviewed"
    || evidence.reviewer_kind !== "editorial_text_review"
    || evidence.human_listening_performed !== false
    || evidence.authorization_origin !== "user_authorized_autonomous_asr_qa"
    || !String(evidence.reviewer ?? "").trim()
    || !Number.isFinite(Date.parse(evidence.reviewed_at))
    || String(evidence.note ?? "").trim().length < 40
    || evidence.predecessor_evidence_path !== predecessor?.evidence_path
    || evidence.predecessor_evidence_sha256 !== predecessor?.evidence_sha256
    || evidence.source_script_sha256 !== expected.sourceScriptSha256
    || evidence.run_identity_file_sha256 !== expected.identityFileSha256
    || evidence.narration_generation_plan_sha256 !== expected.planSha256
    || evidence.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || evidence.narration_quality_contract_sha256 !== expected.qualityContractSha256
    || evidence.pre_review_narration_report_sha256 !== expected.priorReportFileSha256
    || evidence.pre_review_unit_delivery_qa_sha256 !== expected.priorDeliveryFileSha256
    || evidence.pre_review_provider_manifest_sha256 !== expected.priorManifestFileSha256
    || priorReport?.schema !== "goldflow_narration_tts_report_v1"
    || priorReport.status !== "blocked"
    || priorDelivery?.schema !== "goldflow_narration_unit_delivery_qa_v2"
    || priorDelivery.status !== "blocked"
    || priorManifest?.status !== "passed" || currentManifest?.status !== "passed"
    || priorReport.source_script_hash !== expected.sourceScriptSha256
    || priorReport.narration_generation_plan_sha256 !== expected.planSha256
    || priorReport.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || priorReport.provider_output_manifest_sha256 !== expected.priorManifestFileSha256
    || priorReport.asr_orthography_review?.evidence_sha256 !== predecessor.evidence_sha256
    || priorDelivery.source_script_hash !== expected.sourceScriptSha256
    || priorDelivery.narration_generation_plan_sha256 !== expected.planSha256
    || priorDelivery.narration_generation_plan_file_sha256 !== expected.planFileSha256
    || priorDelivery.quality_contract_sha256 !== expected.qualityContractSha256
    || plan?.plan_sha256 !== expected.planSha256
    || !Array.isArray(evidence.units) || !evidence.units.length
    || evidence.unit_count !== evidence.units.length) {
    throw new Error("ASR orthography extension lacks exact predecessor, source, plan, or snapshot bindings.");
  }
  const priorResults = new Map((priorReport.results ?? []).map((row) => [row.unit_id, row]));
  const priorQa = new Map((priorDelivery.units ?? []).map((row) => [row.unit_id, row]));
  const priorOutputs = new Map((priorManifest.units ?? []).map((row) => [row.unit_id, row]));
  const currentOutputs = new Map((currentManifest.units ?? []).map((row) => [row.unit_id, row]));
  const planUnits = new Map((plan.units ?? []).map((row) => [row.unit_id, row]));
  const code = "narration_confirmed_opening_token_mismatch";
  const seen = new Set();
  for (const row of evidence.units) {
    const id = String(row?.unit_id ?? "");
    const oldResult = priorResults.get(id);
    const oldQa = priorQa.get(id);
    const oldOutput = priorOutputs.get(id);
    const current = currentOutputs.get(id);
    const unit = planUnits.get(id);
    if (!id || seen.has(id) || predecessor.rows_by_id.has(id)
      || !oldResult || !oldQa || !oldOutput || !current || !unit
      || row.edge !== "opening"
      || row.relation !== "reviewed_dual_asr_phonetic_spelling"
      || !exactCodes(row.reviewed_blocker_codes ?? [], [code])
      || !exactCodes((oldQa.decision?.blockers ?? []).map((item) => item.code), [code])
      || !exactCodes((priorReport.blockers ?? []).filter((item) => item.unit_id === id)
        .map((item) => item.code), [code])
      || oldQa.edge_alignment?.status !== "passed"
      || ![1, 2].includes(Number(row.selected_attempt))
      || Number(oldResult.attempt) !== row.selected_attempt
      || Number(oldOutput.attempt) !== row.selected_attempt
      || Number(current.attempt) !== row.selected_attempt
      || oldOutput.status !== "accepted" || current.status !== "accepted"
      || row.audio_path !== oldOutput.audio_path || row.audio_path !== current.audio_path
      || row.audio_sha256 !== oldOutput.audio_sha256
      || row.audio_sha256 !== current.audio_sha256
      || row.audio_sha256 !== oldResult.audio_sha256
      || row.audio_sha256 !== oldQa.audio_sha256
      || actualAudioHashes[id] !== row.audio_sha256
      || row.synthesis_identity_sha256 !== oldOutput.synthesis_identity_sha256
      || row.synthesis_identity_sha256 !== current.synthesis_identity_sha256
      || row.synthesis_identity_sha256 !== oldResult.synthesis_identity_sha256
      || row.intended_text_sha256 !== unit.spoken_text_sha256
      || row.intended_text_sha256 !== oldQa.intended_text_sha256
      || row.intended_text !== unit.spoken_text || row.intended_text !== oldQa.intended_text
      || row.primary_recognized_text !== oldQa.primary_recognized_text
      || row.confirmation_recognized_text !== oldQa.confirmation_recognized_text
      || !String(row.review_note ?? "").trim()
      || row.review_note.trim().length < 25) {
      throw new Error(`ASR orthography extension has stale or non-exact unit evidence: ${id || "missing"}.`);
    }
    const expectedPhrase = String(row.expected_phrase ?? "");
    const expectedPossessive = /['’]s$/u.test(expectedPhrase);
    const expectedName = expectedPhrase.replace(/['’]s$/u, "");
    if (words(expectedPhrase).length !== 1
      || !/^[\p{L}]+(?:['’]s)?$/u.test(expectedPhrase)
      || row.observed_phrase !== row.primary_observed_phrase
      || lower(words(row.intended_text)[0]?.text) !== lower(expectedPhrase)) {
      throw new Error(`ASR orthography extension needs one exact opening name: ${id}.`);
    }
    for (const [recognized, observed] of [
      [row.primary_recognized_text, row.primary_observed_phrase],
      [row.confirmation_recognized_text, row.confirmation_observed_phrase],
    ]) {
      const spelling = String(observed ?? "");
      const spellingName = spelling.replace(/['’]s$/u, "");
      if (!/^[\p{L}]+(?:['’]s)?$/u.test(spelling)
        || /['’]s$/u.test(spelling) !== expectedPossessive
        || lower(spelling) === lower(expectedPhrase)
        || soundex(expectedName) !== soundex(spellingName)
        || editDistance(lower(expectedName), lower(spellingName)) > 3
        || !unchangedExceptReviewedPhrase({ intended: row.intended_text,
          recognized, expectedPhrase, observedPhrase: spelling, edge: "opening" })) {
        throw new Error(`ASR orthography extension masks another transcript difference: ${id}.`);
      }
    }
    if (row.selected_attempt === 2) {
      const recovery = oldOutput.recovery_provenance;
      if (recovery?.schema !== "goldflow_qwen_exact_unit_recovery_provenance_v1"
        || recovery.evidence_basis !== "reviewed_automated_delivery_qa"
        || recovery.human_listening_performed !== false
        || recovery.unit_id !== id
        || recovery.spoken_text_sha256 !== row.intended_text_sha256
        || row.selected_recovery_provenance_sha256 !== canonicalQwenBatchSha256(recovery)
        || canonicalQwenBatchSha256(current.recovery_provenance)
          !== canonicalQwenBatchSha256(recovery)) {
        throw new Error(`ASR orthography extension has stale second-take provenance: ${id}.`);
      }
    }
    seen.add(id);
  }
  return { unit_ids: [...seen], rows_by_id: new Map(evidence.units.map((row) => [row.unit_id, row])) };
}

export function applyAsrOrthographyReviewForTests(decision, row, evidenceSha256) {
  if (!row) return decision;
  const secondExtension = Array.isArray(row.spans);
  const nameOnlyWithAdvisory = row.review_schema
    === NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V5_SCHEMA;
  const expectedCode = row.edge === "opening"
    ? "narration_confirmed_opening_token_mismatch"
    : "narration_confirmed_final_token_mismatch";
  const reviewedCodes = secondExtension ? row.reviewed_blocker_codes : [expectedCode];
  if (!hex(evidenceSha256)
    || !exactCodes((decision?.blockers ?? []).map((finding) => finding.code), reviewedCodes)) {
    throw new Error(`ASR orthography review cannot clear non-matching current blockers: ${row.unit_id}.`);
  }
  return {
    ...decision,
    status: "passed_with_warnings",
    blockers: [],
    warnings: [
      ...(decision.warnings ?? []),
      { severity: "warning", code: nameOnlyWithAdvisory
        ? "narration_reviewed_opening_name_spelling_only"
        : "narration_reviewed_asr_orthography_equivalence",
        ...(secondExtension ? { original_blocker_codes: reviewedCodes,
          reviewed_spans: row.spans } : { original_blocker_code: expectedCode }),
        relation: secondExtension
          ? row.review_schema ?? NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V2_SCHEMA
          : row.relation,
        ...(nameOnlyWithAdvisory ? {
          retained_lexical_advisory: row.retained_advisory,
          full_transcript_equivalence_claimed: false } : {}),
        expected_phrase: row.expected_phrase, observed_phrase: row.observed_phrase,
        ...(row.primary_observed_phrase ? { primary_observed_phrase: row.primary_observed_phrase,
          confirmation_observed_phrase: row.confirmation_observed_phrase } : {}),
        ...(row.joins ? { reviewed_spacing_joins: row.joins } : {}),
        evidence_sha256: evidenceSha256, review_required: false,
        human_listening_performed: false },
    ],
    asr_orthography_review: { evidence_sha256: evidenceSha256, unit_id: row.unit_id,
      ...(nameOnlyWithAdvisory ? {
        review_scope: "opening_name_spelling_only",
        retained_lexical_advisory: row.retained_advisory,
        full_transcript_equivalence_claimed: false } : {}),
      ...(secondExtension ? { original_blocker_codes: reviewedCodes }
        : { original_blocker_code: expectedCode }) },
  };
}

async function loadBaseAsrOrthographyReview({ episodeDir, episode, plan,
  identityFileSha256, sourceScriptSha256, planFileSha256,
  qualityContractSha256, currentManifest,
} = {}) {
  const evidencePath = path.join(episodeDir,
    `narration_asr_orthography_review_${episode}.json`);
  const evidence = await fs.readFile(evidencePath, "utf8").then(JSON.parse)
    .catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
  if (!evidence) return null;
  const names = ["narration_report", "unit_delivery_qa", "provider_manifest"];
  const canonicalNames = {
    narration_report: `narration_tts_report_${episode}.json`,
    unit_delivery_qa: `narration_unit_delivery_qa_${episode}.json`,
    provider_manifest: `narration_provider_output_manifest_${episode}.json`,
  };
  const files = {};
  for (const name of names) {
    const key = `pre_review_${name}_path`;
    const hashKey = `pre_review_${name}_sha256`;
    const target = evidence[key];
    const metadata = inside(episodeDir, target)
      ? await fs.lstat(target).catch(() => null) : null;
    if (!inside(episodeDir, target)
      || path.resolve(target) === path.join(path.resolve(episodeDir), canonicalNames[name])
      || !metadata?.isFile() || metadata.nlink !== 1
      || !hex(evidence[hashKey])
      || await sha256File(target).catch(() => null) !== evidence[hashKey]) {
      throw new Error(`ASR orthography review snapshot is missing or hash-stale: ${name}.`);
    }
    files[name] = JSON.parse(await fs.readFile(target, "utf8"));
  }
  const actualAudioHashes = {};
  for (const row of evidence.units ?? []) {
    if (!inside(episodeDir, row.audio_path) || !hex(row.audio_sha256)) {
      throw new Error("ASR orthography review audio path/hash is invalid.");
    }
    actualAudioHashes[row.unit_id] = await sha256File(row.audio_path).catch(() => null);
  }
  const evidenceSha256 = await sha256File(evidencePath);
  const validated = validateAsrOrthographyReviewForTests({
    evidence,
    priorReport: files.narration_report,
    priorDelivery: files.unit_delivery_qa,
    priorManifest: files.provider_manifest,
    currentManifest, plan,
    expected: { sourceScriptSha256, identityFileSha256,
      planSha256: plan.plan_sha256, planFileSha256, qualityContractSha256,
      priorReportFileSha256: evidence.pre_review_narration_report_sha256,
      priorDeliveryFileSha256: evidence.pre_review_unit_delivery_qa_sha256,
      priorManifestFileSha256: evidence.pre_review_provider_manifest_sha256 },
    actualAudioHashes,
  });
  const predecessor = { ...validated, evidence_path: evidencePath,
    evidence_sha256: evidenceSha256,
    pre_review_narration_report_sha256: evidence.pre_review_narration_report_sha256,
    pre_review_unit_delivery_qa_sha256: evidence.pre_review_unit_delivery_qa_sha256,
    pre_review_provider_manifest_sha256: evidence.pre_review_provider_manifest_sha256,
    provenance: { schema: NARRATION_ASR_ORTHOGRAPHY_SCHEMA,
      evidence_path: evidencePath, evidence_sha256: evidenceSha256,
      unit_ids: validated.unit_ids, human_listening_performed: false } };
  const amendmentPath = path.join(episodeDir,
    `narration_asr_orthography_review_${episode}_v2.json`);
  const amendment = await fs.readFile(amendmentPath, "utf8").then(JSON.parse)
    .catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
  if (!amendment) return predecessor;
  const amendmentSnapshots = {};
  for (const name of names) {
    const target = amendment[`pre_review_${name}_path`];
    const expectedSha256 = amendment[`pre_review_${name}_sha256`];
    const metadata = inside(episodeDir, target)
      ? await fs.lstat(target).catch(() => null) : null;
    if (!inside(episodeDir, target)
      || path.resolve(target) === path.join(path.resolve(episodeDir), canonicalNames[name])
      || !metadata?.isFile() || metadata.nlink !== 1 || !hex(expectedSha256)
      || await sha256File(target).catch(() => null) !== expectedSha256) {
      throw new Error(`ASR orthography amendment snapshot is missing or hash-stale: ${name}.`);
    }
    amendmentSnapshots[name] = JSON.parse(await fs.readFile(target, "utf8"));
  }
  const [reviewed] = amendment.units ?? [];
  const selected = (amendmentSnapshots.provider_manifest.units ?? [])
    .find((row) => row.unit_id === reviewed?.unit_id);
  const recovery = selected?.recovery_provenance;
  const runnerPath = reviewed?.runner_report_path;
  if (!inside(episodeDir, reviewed?.audio_path)
    || !inside(episodeDir, runnerPath)
    || !inside(episodeDir, recovery?.confirmed_evidence_path)
    || !hex(reviewed?.audio_sha256) || !hex(reviewed?.runner_report_sha256)
    || await sha256File(reviewed.audio_path).catch(() => null) !== reviewed.audio_sha256
    || await sha256File(runnerPath).catch(() => null) !== reviewed.runner_report_sha256
    || await sha256File(recovery.confirmed_evidence_path).catch(() => null)
      !== recovery.confirmed_evidence_sha256) {
    throw new Error("ASR orthography amendment WAV, runner, or retake evidence is hash-stale.");
  }
  const amendmentValidated = validateAsrOrthographyAmendmentForTests({
    evidence: amendment, predecessor,
    priorReport: amendmentSnapshots.narration_report,
    priorDelivery: amendmentSnapshots.unit_delivery_qa,
    priorManifest: amendmentSnapshots.provider_manifest,
    currentManifest, plan,
    expected: { sourceScriptSha256, identityFileSha256,
      planSha256: plan.plan_sha256, planFileSha256, qualityContractSha256,
      priorReportFileSha256: amendment.pre_review_narration_report_sha256,
      priorDeliveryFileSha256: amendment.pre_review_unit_delivery_qa_sha256,
      priorManifestFileSha256: amendment.pre_review_provider_manifest_sha256 },
    actualAudioHashes: { [reviewed.unit_id]: reviewed.audio_sha256 },
    runnerReport: JSON.parse(await fs.readFile(runnerPath, "utf8")),
  });
  if (predecessor.rows_by_id.has(amendmentValidated.unit_ids[0])) {
    throw new Error("ASR orthography amendment duplicates a predecessor review unit.");
  }
  const amendmentSha256 = await sha256File(amendmentPath);
  const unitIds = [...predecessor.unit_ids, ...amendmentValidated.unit_ids];
  return { ...amendmentValidated,
    unit_ids: unitIds,
    rows_by_id: new Map([...predecessor.rows_by_id,
      ...amendmentValidated.rows_by_id]),
    evidence_path: amendmentPath, evidence_sha256: amendmentSha256,
    pre_review_narration_report_sha256: amendment.pre_review_narration_report_sha256,
    pre_review_unit_delivery_qa_sha256: amendment.pre_review_unit_delivery_qa_sha256,
    pre_review_provider_manifest_sha256: amendment.pre_review_provider_manifest_sha256,
    provenance: { schema: NARRATION_ASR_ORTHOGRAPHY_AMENDMENT_SCHEMA,
      evidence_path: amendmentPath, evidence_sha256: amendmentSha256,
      predecessor_evidence_path: evidencePath,
      predecessor_evidence_sha256: evidenceSha256,
      unit_ids: unitIds, human_listening_performed: false } };
}

async function loadAsrOrthographyExtensionV2(predecessor, args) {
  const { episodeDir, episode, plan, currentManifest,
    identityFileSha256, sourceScriptSha256, planFileSha256,
    qualityContractSha256 } = args;
  const evidencePath = path.join(episodeDir,
    `narration_asr_orthography_extension_${episode}_v2.json`);
  const evidence = await fs.readFile(evidencePath, "utf8").then(JSON.parse)
    .catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
  if (!evidence) return predecessor;
  if (!predecessor || predecessor.provenance?.schema !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_SCHEMA) {
    throw new Error("ASR orthography extension v2 requires the immutable first extension.");
  }
  const names = ["narration_report", "unit_delivery_qa", "provider_manifest"];
  const canonicalNames = {
    narration_report: `narration_tts_report_${episode}.json`,
    unit_delivery_qa: `narration_unit_delivery_qa_${episode}.json`,
    provider_manifest: `narration_provider_output_manifest_${episode}.json`,
  };
  const snapshots = {};
  for (const name of names) {
    const target = evidence[`pre_review_${name}_path`];
    const expectedSha256 = evidence[`pre_review_${name}_sha256`];
    const metadata = inside(episodeDir, target)
      ? await fs.lstat(target).catch(() => null) : null;
    if (!inside(episodeDir, target)
      || path.resolve(target) === path.join(path.resolve(episodeDir), canonicalNames[name])
      || !metadata?.isFile() || metadata.nlink !== 1 || !hex(expectedSha256)
      || await sha256File(target).catch(() => null) !== expectedSha256) {
      throw new Error(`ASR orthography extension v2 snapshot is missing or hash-stale: ${name}.`);
    }
    snapshots[name] = JSON.parse(await fs.readFile(target, "utf8"));
  }
  const actualAudioHashes = {};
  const fragmentContextDiagnostics = {};
  for (const row of evidence.units ?? []) {
    if (!inside(episodeDir, row.audio_path) || !hex(row.audio_sha256)) {
      throw new Error("ASR orthography extension v2 audio path/hash is invalid.");
    }
    actualAudioHashes[row.unit_id] = await sha256File(row.audio_path).catch(() => null);
    if (row.spans?.some((span) =>
      span.relation === "reviewed_fragment_context_value_expansion")) {
      const diagnosticPath = row.fragment_context_evidence_path;
      const metadata = inside(episodeDir, diagnosticPath)
        ? await fs.lstat(diagnosticPath).catch(() => null) : null;
      if (!metadata?.isFile() || metadata.nlink !== 1
        || !hex(row.fragment_context_evidence_sha256)
        || await sha256File(diagnosticPath).catch(() => null)
          !== row.fragment_context_evidence_sha256) {
        throw new Error(`ASR fragment-context diagnostic is missing or hash-stale: ${row.unit_id}.`);
      }
      const diagnostic = JSON.parse(await fs.readFile(diagnosticPath, "utf8"));
      const selections = [
        [diagnostic.fragment_audio_path, diagnostic.fragment_audio_sha256],
        [diagnostic.fragment_sidecar_path, diagnostic.fragment_sidecar_sha256],
        [diagnostic.repair_request_path, diagnostic.repair_request_sha256],
        [diagnostic.repair_result_path, diagnostic.repair_result_sha256],
      ];
      for (const [selectedPath, selectedSha256] of selections) {
        if (!inside(episodeDir, selectedPath) || !hex(selectedSha256)
          || await sha256File(selectedPath).catch(() => null) !== selectedSha256) {
          throw new Error(`ASR fragment-context source is missing or hash-stale: ${row.unit_id}.`);
        }
      }
      const sidecar = JSON.parse(await fs.readFile(diagnostic.fragment_sidecar_path, "utf8"));
      const selected = (currentManifest?.units ?? []).find((item) => item.unit_id === row.unit_id);
      if (sidecar?.schema !== "goldflow_tts_exact_boundary_fragment_v1"
        || sidecar.unit_id !== row.unit_id
        || sidecar.fragment_index !== diagnostic.fragment_index
        || sidecar.text !== diagnostic.source_text
        || sidecar.text_sha256 !== diagnostic.source_text_sha256
        || sidecar.audio_path !== diagnostic.fragment_audio_path
        || sidecar.audio_sha256 !== diagnostic.fragment_audio_sha256
        || sidecar.request_sha256 !== selected?.recovery_provenance?.request_sha256
        || selected?.runner_report_path !== diagnostic.repair_result_path
        || selected?.runner_report_sha256 !== diagnostic.repair_result_sha256) {
        throw new Error(`ASR fragment-context sidecar differs from selected composite: ${row.unit_id}.`);
      }
      fragmentContextDiagnostics[row.unit_id] = {
        path: diagnosticPath, sha256: row.fragment_context_evidence_sha256,
        diagnostic,
      };
    }
    if (row.selected_attempt === 2) {
      const selected = (currentManifest?.units ?? []).find((item) => item.unit_id === row.unit_id);
      const recovery = selected?.recovery_provenance;
      if (!inside(episodeDir, selected?.runner_report_path)
        || !hex(selected?.runner_report_sha256)
        || await sha256File(selected.runner_report_path).catch(() => null)
          !== selected.runner_report_sha256
        || !inside(episodeDir, recovery?.confirmed_evidence_path)
        || !hex(recovery?.confirmed_evidence_sha256)
        || await sha256File(recovery.confirmed_evidence_path).catch(() => null)
          !== recovery.confirmed_evidence_sha256) {
        throw new Error(`ASR orthography extension v2 second-take runner is stale: ${row.unit_id}.`);
      }
    }
  }
  const validated = validateAsrOrthographyExtensionV2ForTests({
    evidence, predecessor,
    priorReport: snapshots.narration_report,
    priorDelivery: snapshots.unit_delivery_qa,
    priorManifest: snapshots.provider_manifest,
    currentManifest, plan,
    expected: { sourceScriptSha256, identityFileSha256,
      planSha256: plan.plan_sha256, planFileSha256, qualityContractSha256,
      priorReportFileSha256: evidence.pre_review_narration_report_sha256,
      priorDeliveryFileSha256: evidence.pre_review_unit_delivery_qa_sha256,
      priorManifestFileSha256: evidence.pre_review_provider_manifest_sha256 },
    actualAudioHashes, fragmentContextDiagnostics,
  });
  const evidenceSha256 = await sha256File(evidencePath);
  const unitIds = [...predecessor.unit_ids, ...validated.unit_ids];
  return { ...validated,
    unit_ids: unitIds,
    rows_by_id: new Map([...predecessor.rows_by_id, ...validated.rows_by_id]),
    evidence_path: evidencePath, evidence_sha256: evidenceSha256,
    pre_review_narration_report_sha256: evidence.pre_review_narration_report_sha256,
    pre_review_unit_delivery_qa_sha256: evidence.pre_review_unit_delivery_qa_sha256,
    pre_review_provider_manifest_sha256: evidence.pre_review_provider_manifest_sha256,
    provenance: { schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V2_SCHEMA,
      evidence_path: evidencePath, evidence_sha256: evidenceSha256,
      predecessor_evidence_path: predecessor.evidence_path,
      predecessor_evidence_sha256: predecessor.evidence_sha256,
      unit_ids: unitIds, human_listening_performed: false } };
}

async function loadAsrOrthographyExtensionV3(predecessor, args) {
  const { episodeDir, episode, plan, currentManifest,
    identityFileSha256, sourceScriptSha256, planFileSha256,
    qualityContractSha256 } = args;
  const evidencePath = path.join(episodeDir,
    `narration_asr_orthography_extension_${episode}_v3.json`);
  const evidence = await fs.readFile(evidencePath, "utf8").then(JSON.parse)
    .catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
  if (!evidence) return predecessor;
  if (!predecessor || predecessor.provenance?.schema
    !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V2_SCHEMA) {
    throw new Error("ASR orthography extension v3 requires the immutable second extension.");
  }
  const snapshots = {};
  for (const [key, canonicalName] of [
    ["narration_report", `narration_tts_report_${episode}.json`],
    ["unit_delivery_qa", `narration_unit_delivery_qa_${episode}.json`],
    ["provider_manifest", `narration_provider_output_manifest_${episode}.json`],
  ]) {
    const target = evidence[`pre_review_${key}_path`];
    const expectedSha256 = evidence[`pre_review_${key}_sha256`];
    const metadata = inside(episodeDir, target)
      ? await fs.lstat(target).catch(() => null) : null;
    if (!metadata?.isFile() || metadata.nlink !== 1
      || path.resolve(target) === path.join(path.resolve(episodeDir), canonicalName)
      || !hex(expectedSha256)
      || await sha256File(target).catch(() => null) !== expectedSha256) {
      throw new Error(`ASR orthography extension v3 snapshot is missing or hash-stale: ${key}.`);
    }
    snapshots[key] = JSON.parse(await fs.readFile(target, "utf8"));
  }
  const actualAudioHashes = {};
  for (const row of evidence.units ?? []) {
    if (!inside(episodeDir, row.audio_path) || !hex(row.audio_sha256)) {
      throw new Error("ASR orthography extension v3 selected audio path/hash is invalid.");
    }
    actualAudioHashes[row.unit_id] = await sha256File(row.audio_path).catch(() => null);
  }
  const validated = validateAsrOrthographyExtensionV3ForTests({
    evidence, predecessor,
    priorReport: snapshots.narration_report,
    priorDelivery: snapshots.unit_delivery_qa,
    priorManifest: snapshots.provider_manifest,
    currentManifest, plan,
    expected: { sourceScriptSha256, identityFileSha256,
      planSha256: plan.plan_sha256, planFileSha256, qualityContractSha256,
      priorReportFileSha256: evidence.pre_review_narration_report_sha256,
      priorDeliveryFileSha256: evidence.pre_review_unit_delivery_qa_sha256,
      priorManifestFileSha256: evidence.pre_review_provider_manifest_sha256 },
    actualAudioHashes,
  });
  const evidenceSha256 = await sha256File(evidencePath);
  const unitIds = [...predecessor.unit_ids, ...validated.unit_ids];
  return { ...validated, unit_ids: unitIds,
    rows_by_id: new Map([...predecessor.rows_by_id, ...validated.rows_by_id]),
    evidence_path: evidencePath, evidence_sha256: evidenceSha256,
    pre_review_narration_report_sha256: evidence.pre_review_narration_report_sha256,
    pre_review_unit_delivery_qa_sha256: evidence.pre_review_unit_delivery_qa_sha256,
    pre_review_provider_manifest_sha256: evidence.pre_review_provider_manifest_sha256,
    provenance: { schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA,
      evidence_path: evidencePath, evidence_sha256: evidenceSha256,
      predecessor_evidence_path: predecessor.evidence_path,
      predecessor_evidence_sha256: predecessor.evidence_sha256,
      unit_ids: unitIds, human_listening_performed: false } };
}

async function loadAsrOrthographyExtensionV4(predecessor, args) {
  const { episodeDir, episode, plan, currentManifest,
    identityFileSha256, sourceScriptSha256, planFileSha256,
    qualityContractSha256 } = args;
  const evidencePath = path.join(episodeDir,
    `narration_asr_orthography_extension_${episode}_v4.json`);
  const evidence = await fs.readFile(evidencePath, "utf8").then(JSON.parse)
    .catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
  if (!evidence) return predecessor;
  if (!predecessor || predecessor.provenance?.schema
    !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V3_SCHEMA) {
    throw new Error("ASR orthography extension v4 requires the immutable third extension.");
  }
  const snapshots = {};
  for (const [key, canonicalName] of [
    ["narration_report", `narration_tts_report_${episode}.json`],
    ["unit_delivery_qa", `narration_unit_delivery_qa_${episode}.json`],
    ["provider_manifest", `narration_provider_output_manifest_${episode}.json`],
  ]) {
    const target = evidence[`pre_review_${key}_path`];
    const expectedSha256 = evidence[`pre_review_${key}_sha256`];
    const metadata = inside(episodeDir, target)
      ? await fs.lstat(target).catch(() => null) : null;
    if (!metadata?.isFile() || metadata.nlink !== 1
      || path.resolve(target) === path.join(path.resolve(episodeDir), canonicalName)
      || !hex(expectedSha256)
      || await sha256File(target).catch(() => null) !== expectedSha256) {
      throw new Error(`ASR orthography extension v4 snapshot is missing or hash-stale: ${key}.`);
    }
    snapshots[key] = JSON.parse(await fs.readFile(target, "utf8"));
  }
  const actualAudioHashes = {};
  const fragmentDiagnostics = {};
  for (const row of evidence.units ?? []) {
    if (!inside(episodeDir, row.audio_path) || !hex(row.audio_sha256)) {
      throw new Error("ASR orthography extension v4 selected audio path/hash is invalid.");
    }
    actualAudioHashes[row.unit_id] = await sha256File(row.audio_path).catch(() => null);
    if (row.review_method !== "fragment_context_name_spelling") continue;
    const target = row.fragment_context_evidence_path;
    const metadata = inside(episodeDir, target)
      ? await fs.lstat(target).catch(() => null) : null;
    if (!metadata?.isFile() || metadata.nlink !== 1
      || !hex(row.fragment_context_evidence_sha256)
      || await sha256File(target).catch(() => null)
        !== row.fragment_context_evidence_sha256) {
      throw new Error(`ASR orthography extension v4 fragment diagnostic is hash-stale: ${row.unit_id}.`);
    }
    const diagnostic = JSON.parse(await fs.readFile(target, "utf8"));
    if (!inside(episodeDir, diagnostic.fragment_audio_path)
      || !inside(episodeDir, diagnostic.fragment_sidecar_path)) {
      throw new Error(`ASR orthography extension v4 fragment escaped episode: ${row.unit_id}.`);
    }
    const [audioHash, sidecarHash, sidecar] = await Promise.all([
      sha256File(diagnostic.fragment_audio_path).catch(() => null),
      sha256File(diagnostic.fragment_sidecar_path).catch(() => null),
      fs.readFile(diagnostic.fragment_sidecar_path, "utf8").then(JSON.parse)
        .catch(() => null),
    ]);
    fragmentDiagnostics[row.unit_id] = { path: target,
      sha256: row.fragment_context_evidence_sha256,
      diagnostic, audioHash, sidecarHash, sidecar };
  }
  const validated = validateAsrOrthographyExtensionV4ForTests({
    evidence, predecessor,
    priorReport: snapshots.narration_report,
    priorDelivery: snapshots.unit_delivery_qa,
    priorManifest: snapshots.provider_manifest,
    currentManifest, plan,
    expected: { sourceScriptSha256, identityFileSha256,
      planSha256: plan.plan_sha256, planFileSha256, qualityContractSha256,
      priorReportFileSha256: evidence.pre_review_narration_report_sha256,
      priorDeliveryFileSha256: evidence.pre_review_unit_delivery_qa_sha256,
      priorManifestFileSha256: evidence.pre_review_provider_manifest_sha256 },
    actualAudioHashes, fragmentDiagnostics,
  });
  const evidenceSha256 = await sha256File(evidencePath);
  const unitIds = [...predecessor.unit_ids, ...validated.unit_ids];
  return { ...validated, unit_ids: unitIds,
    rows_by_id: new Map([...predecessor.rows_by_id, ...validated.rows_by_id]),
    evidence_path: evidencePath, evidence_sha256: evidenceSha256,
    pre_review_narration_report_sha256: evidence.pre_review_narration_report_sha256,
    pre_review_unit_delivery_qa_sha256: evidence.pre_review_unit_delivery_qa_sha256,
    pre_review_provider_manifest_sha256: evidence.pre_review_provider_manifest_sha256,
    provenance: { schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V4_SCHEMA,
      evidence_path: evidencePath, evidence_sha256: evidenceSha256,
      predecessor_evidence_path: predecessor.evidence_path,
      predecessor_evidence_sha256: predecessor.evidence_sha256,
      unit_ids: unitIds, human_listening_performed: false } };
}

async function loadAsrOrthographyExtensionV5(predecessor, args) {
  const { episodeDir, episode, plan, currentManifest,
    identityFileSha256, sourceScriptSha256, planFileSha256,
    qualityContractSha256 } = args;
  const evidencePath = path.join(episodeDir,
    `narration_asr_orthography_extension_${episode}_v5.json`);
  const evidence = await fs.readFile(evidencePath, "utf8").then(JSON.parse)
    .catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
  if (!evidence) return predecessor;
  if (!predecessor || predecessor.provenance?.schema
    !== NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V4_SCHEMA) {
    throw new Error("ASR orthography extension v5 requires the immutable fourth extension.");
  }
  const snapshots = {};
  for (const [key, canonicalName] of [
    ["narration_report", `narration_tts_report_${episode}.json`],
    ["unit_delivery_qa", `narration_unit_delivery_qa_${episode}.json`],
    ["provider_manifest", `narration_provider_output_manifest_${episode}.json`],
  ]) {
    const target = evidence[`pre_review_${key}_path`];
    const expectedSha256 = evidence[`pre_review_${key}_sha256`];
    const metadata = inside(episodeDir, target)
      ? await fs.lstat(target).catch(() => null) : null;
    if (!metadata?.isFile() || metadata.nlink !== 1
      || path.resolve(target) === path.join(path.resolve(episodeDir), canonicalName)
      || !hex(expectedSha256)
      || await sha256File(target).catch(() => null) !== expectedSha256) {
      throw new Error(`ASR orthography extension v5 snapshot is missing or hash-stale: ${key}.`);
    }
    snapshots[key] = JSON.parse(await fs.readFile(target, "utf8"));
  }
  const actualAudioHashes = {};
  for (const row of evidence.units ?? []) {
    if (!inside(episodeDir, row.audio_path) || !hex(row.audio_sha256)) {
      throw new Error("ASR orthography extension v5 selected audio path/hash is invalid.");
    }
    actualAudioHashes[row.unit_id] = await sha256File(row.audio_path).catch(() => null);
  }
  const validated = validateAsrOrthographyExtensionV5ForTests({
    evidence, predecessor,
    priorReport: snapshots.narration_report,
    priorDelivery: snapshots.unit_delivery_qa,
    priorManifest: snapshots.provider_manifest,
    currentManifest, plan,
    expected: { sourceScriptSha256, identityFileSha256,
      planSha256: plan.plan_sha256, planFileSha256, qualityContractSha256,
      priorReportFileSha256: evidence.pre_review_narration_report_sha256,
      priorDeliveryFileSha256: evidence.pre_review_unit_delivery_qa_sha256,
      priorManifestFileSha256: evidence.pre_review_provider_manifest_sha256 },
    actualAudioHashes,
  });
  const evidenceSha256 = await sha256File(evidencePath);
  const unitIds = [...predecessor.unit_ids, ...validated.unit_ids];
  return { ...validated, unit_ids: unitIds,
    rows_by_id: new Map([...predecessor.rows_by_id, ...validated.rows_by_id]),
    evidence_path: evidencePath, evidence_sha256: evidenceSha256,
    pre_review_narration_report_sha256: evidence.pre_review_narration_report_sha256,
    pre_review_unit_delivery_qa_sha256: evidence.pre_review_unit_delivery_qa_sha256,
    pre_review_provider_manifest_sha256: evidence.pre_review_provider_manifest_sha256,
    provenance: { schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_V5_SCHEMA,
      evidence_path: evidencePath, evidence_sha256: evidenceSha256,
      predecessor_evidence_path: predecessor.evidence_path,
      predecessor_evidence_sha256: predecessor.evidence_sha256,
      unit_ids: unitIds, human_listening_performed: false } };
}

export async function loadAsrOrthographyReview(args = {}) {
  const predecessor = await loadBaseAsrOrthographyReview(args);
  const { episodeDir, episode, plan, currentManifest,
    identityFileSha256, sourceScriptSha256, planFileSha256,
    qualityContractSha256 } = args;
  const extensionPath = path.join(episodeDir,
    `narration_asr_orthography_extension_${episode}.json`);
  const extension = await fs.readFile(extensionPath, "utf8").then(JSON.parse)
    .catch((error) => { if (error?.code === "ENOENT") return null; throw error; });
  if (!extension) return loadAsrOrthographyExtensionV5(
    await loadAsrOrthographyExtensionV4(
      await loadAsrOrthographyExtensionV3(
        await loadAsrOrthographyExtensionV2(predecessor, args), args), args), args);
  if (!predecessor) {
    throw new Error("ASR orthography extension has no immutable predecessor.");
  }
  const names = ["narration_report", "unit_delivery_qa", "provider_manifest"];
  const canonicalNames = {
    narration_report: `narration_tts_report_${episode}.json`,
    unit_delivery_qa: `narration_unit_delivery_qa_${episode}.json`,
    provider_manifest: `narration_provider_output_manifest_${episode}.json`,
  };
  const snapshots = {};
  for (const name of names) {
    const target = extension[`pre_review_${name}_path`];
    const expectedSha256 = extension[`pre_review_${name}_sha256`];
    const metadata = inside(episodeDir, target)
      ? await fs.lstat(target).catch(() => null) : null;
    if (!inside(episodeDir, target)
      || path.resolve(target) === path.join(path.resolve(episodeDir), canonicalNames[name])
      || !metadata?.isFile() || metadata.nlink !== 1 || !hex(expectedSha256)
      || await sha256File(target).catch(() => null) !== expectedSha256) {
      throw new Error(`ASR orthography extension snapshot is missing or hash-stale: ${name}.`);
    }
    snapshots[name] = JSON.parse(await fs.readFile(target, "utf8"));
  }
  const actualAudioHashes = {};
  for (const row of extension.units ?? []) {
    if (!inside(episodeDir, row.audio_path) || !hex(row.audio_sha256)) {
      throw new Error("ASR orthography extension audio path/hash is invalid.");
    }
    actualAudioHashes[row.unit_id] = await sha256File(row.audio_path).catch(() => null);
    if (row.selected_attempt === 2) {
      const selected = (currentManifest?.units ?? []).find((item) => item.unit_id === row.unit_id);
      const recovery = selected?.recovery_provenance;
      if (!inside(episodeDir, selected?.runner_report_path)
        || !hex(selected?.runner_report_sha256)
        || await sha256File(selected.runner_report_path).catch(() => null)
          !== selected.runner_report_sha256
        || !inside(episodeDir, recovery?.confirmed_evidence_path)
        || !hex(recovery?.confirmed_evidence_sha256)
        || await sha256File(recovery.confirmed_evidence_path).catch(() => null)
          !== recovery.confirmed_evidence_sha256) {
        throw new Error(`ASR orthography extension second-take runner is stale: ${row.unit_id}.`);
      }
    }
  }
  const validated = validateAsrOrthographyExtensionForTests({
    evidence: extension, predecessor,
    priorReport: snapshots.narration_report,
    priorDelivery: snapshots.unit_delivery_qa,
    priorManifest: snapshots.provider_manifest,
    currentManifest, plan,
    expected: { sourceScriptSha256, identityFileSha256,
      planSha256: plan.plan_sha256, planFileSha256, qualityContractSha256,
      priorReportFileSha256: extension.pre_review_narration_report_sha256,
      priorDeliveryFileSha256: extension.pre_review_unit_delivery_qa_sha256,
      priorManifestFileSha256: extension.pre_review_provider_manifest_sha256 },
    actualAudioHashes,
  });
  const extensionSha256 = await sha256File(extensionPath);
  const unitIds = [...predecessor.unit_ids, ...validated.unit_ids];
  const firstExtension = { ...validated,
    unit_ids: unitIds,
    rows_by_id: new Map([...predecessor.rows_by_id, ...validated.rows_by_id]),
    evidence_path: extensionPath, evidence_sha256: extensionSha256,
    pre_review_narration_report_sha256: extension.pre_review_narration_report_sha256,
    pre_review_unit_delivery_qa_sha256: extension.pre_review_unit_delivery_qa_sha256,
    pre_review_provider_manifest_sha256: extension.pre_review_provider_manifest_sha256,
    provenance: { schema: NARRATION_ASR_ORTHOGRAPHY_EXTENSION_SCHEMA,
      evidence_path: extensionPath, evidence_sha256: extensionSha256,
      predecessor_evidence_path: predecessor.evidence_path,
      predecessor_evidence_sha256: predecessor.evidence_sha256,
      unit_ids: unitIds, human_listening_performed: false } };
  return loadAsrOrthographyExtensionV5(
    await loadAsrOrthographyExtensionV4(
      await loadAsrOrthographyExtensionV3(
        await loadAsrOrthographyExtensionV2(firstExtension, args), args), args), args);
}

export function asrOrthographyGuardAdmission(status, command, subcommand, flags = {}) {
  const requested = command === "tts" && subcommand === "finalize-provider"
    && Boolean(flags["asr-orthography-evidence"]);
  if (!requested) return { applicable: false, allowed: false };
  const manifest = flags.manifest ? ` --manifest ${flags.manifest}` : "";
  const expected = `node bin/goldflow.mjs tts finalize-provider --episode-dir ${status?.episode_dir}${manifest} --asr-orthography-evidence ${flags["asr-orthography-evidence"]}`;
  const exactKeys = Object.keys(flags).sort().join(",");
  const allowed = status?.current_stage === "qwen_tts_stitch"
    && status?.current_stage_state === "blocked"
    && status?.next_command_shape === expected
    && (exactKeys === "asr-orthography-evidence,episode-dir"
      || exactKeys === "asr-orthography-evidence,episode-dir,manifest");
  return { applicable: true, allowed,
    reason: allowed ? null : "Only the exact status-directed orthography re-adjudication is allowed." };
}
