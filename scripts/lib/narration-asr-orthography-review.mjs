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
    || !/^[\p{L}]+(?: [\p{L}]+){0,2}$/u.test(phrase)) return null;
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

export function applyAsrOrthographyReviewForTests(decision, row, evidenceSha256) {
  if (!row) return decision;
  const expectedCode = row.edge === "opening"
    ? "narration_confirmed_opening_token_mismatch"
    : "narration_confirmed_final_token_mismatch";
  if (!hex(evidenceSha256) || !exactCodes((decision?.blockers ?? []).map((finding) => finding.code), [expectedCode])) {
    throw new Error(`ASR orthography review cannot clear non-matching current blockers: ${row.unit_id}.`);
  }
  return {
    ...decision,
    status: "passed_with_warnings",
    blockers: [],
    warnings: [
      ...(decision.warnings ?? []),
      { severity: "warning", code: "narration_reviewed_asr_orthography_equivalence",
        original_blocker_code: expectedCode, relation: row.relation,
        expected_phrase: row.expected_phrase, observed_phrase: row.observed_phrase,
        ...(row.joins ? { reviewed_spacing_joins: row.joins } : {}),
        evidence_sha256: evidenceSha256, review_required: false,
        human_listening_performed: false },
    ],
    asr_orthography_review: { evidence_sha256: evidenceSha256, unit_id: row.unit_id,
      original_blocker_code: expectedCode },
  };
}

export async function loadAsrOrthographyReview({ episodeDir, episode, plan,
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

export function asrOrthographyGuardAdmission(status, command, subcommand, flags = {}) {
  const requested = command === "tts" && subcommand === "finalize-provider"
    && Boolean(flags["asr-orthography-evidence"]);
  if (!requested) return { applicable: false, allowed: false };
  const expected = `node bin/goldflow.mjs tts finalize-provider --episode-dir ${status?.episode_dir} --asr-orthography-evidence ${flags["asr-orthography-evidence"]}`;
  const exactKeys = Object.keys(flags).sort().join(",");
  const allowed = status?.current_stage === "qwen_tts_stitch"
    && status?.current_stage_state === "blocked"
    && status?.next_command_shape === expected
    && exactKeys === "asr-orthography-evidence,episode-dir";
  return { applicable: true, allowed,
    reason: allowed ? null : "Only the exact status-directed orthography re-adjudication is allowed." };
}
