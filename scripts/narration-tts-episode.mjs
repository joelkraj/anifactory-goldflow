#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NARRATION_TTS_SELECTION_POLICY_VERSION,
  PRIMARY_TTS_PROVIDER,
  QWEN_LIAM_MINIMUM_COSINE_SIMILARITY,
  QWEN_LIAM_WARNING_BELOW_COSINE_SIMILARITY,
  candidateDisposition,
  confirmableDeliveryFindingCodes,
  deterministicTtsSeed,
  fullStreamDecision,
  softenPrimaryQa,
  validateSelectedUnitOrder,
  voiceContinuityDecision,
} from "./lib/tts-selection-policy.mjs";
import {
  NARRATION_TTS_QA_POLICY_VERSION,
  QWEN_LIAM_PRIMARY_LOCK,
  narrationPlanVoiceIdentityFindings,
  narrationTtsPolicyForIdentity,
  validateNarrationTtsPolicy,
} from "./lib/narration-tts-policy.mjs";

const DATA_ROOT = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const DEFAULT_PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-kokoro-mlx-audio-0.4.6/bin/python";
const DEFAULT_SIMILARITY_PYTHON = "/Users/joel/AniFactoryData/voice_bank/bakeoff/.venv-speaker-similarity/bin/python";
const QWEN_REFERENCE_TEXT = QWEN_LIAM_PRIMARY_LOCK.reference_text;
const QWEN_PIN = Object.freeze({
  ...QWEN_LIAM_PRIMARY_LOCK,
  model_source: QWEN_LIAM_PRIMARY_LOCK.model_id,
  model_weights_sha256: "b965c581ccf6aa852a4124feeb7a8a111542ee7b213139368b4cc7ba7fd4728b",
  speech_tokenizer_weights_sha256: "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
  runtime: "mlx-audio",
  runtime_version: "0.4.6",
});
const QA_POLICY_VERSION = NARRATION_TTS_QA_POLICY_VERSION;
const STITCH_POLICY_VERSION = "narration_tts_stitch_v1";
const SAMPLE_RATE = 24000;
const UNIT_GAP_SEC = 0.08;
const SEGMENT_GAP_SEC = 0.08;
const FADE_SEC = 0.008;
const EDGE_PAD_SEC = 0.05;
const EFFECTIVE_CONCURRENCY = 1;

function parseFlags(parts) {
  const output = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[index + 1]
      : "true";
    output[key] = value;
    if (value !== "true") index += 1;
  }
  return output;
}

function boolFlag(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value ?? ""));
}

export function recoveryScopeForTests(rawUnitIds, units) {
  if (rawUnitIds == null || String(rawUnitIds).trim() === "") return null;
  const requestedUnitIds = String(rawUnitIds)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!requestedUnitIds.length) {
    throw new Error("--confirmed-retry-unit-ids requires at least one unit ID");
  }
  const duplicateUnitIds = requestedUnitIds.filter(
    (unitId, index) => requestedUnitIds.indexOf(unitId) !== index,
  );
  if (duplicateUnitIds.length) {
    throw new Error(
      `--confirmed-retry-unit-ids contains duplicate unit IDs: ${[...new Set(duplicateUnitIds)].join(", ")}`,
    );
  }
  const availableUnitIds = new Set(units.map((unit) => String(unit.unit_id)));
  const unknownUnitIds = requestedUnitIds.filter((unitId) => !availableUnitIds.has(unitId));
  if (unknownUnitIds.length) {
    throw new Error(
      `--confirmed-retry-unit-ids contains IDs absent from the current narration plan: ${unknownUnitIds.join(", ")}`,
    );
  }
  const requestedSet = new Set(requestedUnitIds);
  return {
    mode: "confirmed_exact_unit_retry",
    requested_unit_ids: units
      .map((unit) => String(unit.unit_id))
      .filter((unitId) => requestedSet.has(unitId)),
    requested_unit_count: requestedUnitIds.length,
  };
}

export function validateConfirmedRetryEvidenceForTests({
  evidence,
  requestedUnitIds,
  planSha256,
  priorReport,
  priorReportSha256,
  currentCandidates,
} = {}) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("Confirmed retry evidence must be a JSON object.");
  }
  if (evidence.narration_generation_plan_sha256 !== planSha256) {
    throw new Error(
      "Confirmed retry evidence is not bound to the current narration generation plan hash.",
    );
  }
  if (!priorReport || typeof priorReport !== "object" || !priorReportSha256) {
    throw new Error(
      "Confirmed retry requires an exact pre-retry narration report and selected audio artifact.",
    );
  }
  if (evidence.pre_retry_narration_report_sha256 !== priorReportSha256) {
    throw new Error(
      "Confirmed retry evidence is not bound to the exact pre-retry narration report hash.",
    );
  }
  const allowedDefects = new Set(["skip", "truncation", "stutter"]);
  const evidenceRows = Array.isArray(evidence.confirmed_units)
    ? evidence.confirmed_units
    : [];
  const requested = [...new Set((requestedUnitIds ?? []).map(String))];
  const evidenceById = new Map(
    evidenceRows.map((row) => [String(row?.unit_id ?? ""), row]),
  );
  const priorById = new Map(
    (priorReport.results ?? []).map((row) => [String(row?.unit_id ?? ""), row]),
  );
  const currentById = new Map(
    (currentCandidates ?? [])
      .filter((row) => Number(row?.attempt) === 1 && row?.audio_sha256)
      .map((row) => [String(row.unit_id), row]),
  );
  const validated = [];
  for (const unitId of requested) {
    const row = evidenceById.get(unitId);
    if (!row) {
      throw new Error(`Confirmed retry evidence does not cover requested unit: ${unitId}`);
    }
    if (!allowedDefects.has(String(row.defect_type ?? "").toLowerCase())
      || !String(row.listen_note ?? "").trim()) {
      throw new Error(
        `Confirmed retry evidence for ${unitId} must record defect_type `
        + "(skip, truncation, or stutter) and a non-empty listen_note.",
      );
    }
    const prior = priorById.get(unitId);
    if (!prior?.audio_sha256 || !prior?.synthesis_identity_sha256) {
      throw new Error(
        `Pre-retry narration report lacks an exact selected audio/synthesis identity for ${unitId}.`,
      );
    }
    const current = currentById.get(unitId);
    const expectedAttempt = Number(prior.attempt);
    if (!Number.isInteger(expectedAttempt)
      || Number(row.selected_attempt) !== expectedAttempt
      || row.audio_sha256 !== prior.audio_sha256
      || row.synthesis_identity_sha256 !== prior.synthesis_identity_sha256) {
      throw new Error(
        `Confirmed retry evidence is stale for the selected pre-retry artifact of ${unitId}.`,
      );
    }
    if (!current
      || current.audio_sha256 !== prior.audio_sha256
      || current.synthesis_identity_sha256 !== prior.synthesis_identity_sha256) {
      throw new Error(
        `Current cached attempt-one artifact does not match the listened pre-retry artifact for ${unitId}.`,
      );
    }
    validated.push({
      unit_id: unitId,
      defect_type: String(row.defect_type).toLowerCase(),
      selected_attempt: expectedAttempt,
      audio_sha256: prior.audio_sha256,
      synthesis_identity_sha256: prior.synthesis_identity_sha256,
    });
  }
  return validated;
}

function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`,
  );
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

function run(command, commandArgs, { cwd = process.cwd(), timeoutMs = 7_200_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(
        `${command} exited ${code ?? "null"} signal ${signal ?? "null"}\n${stdout.slice(-2000)}\n${stderr.slice(-4000)}`,
      ));
    });
  });
}

function runBinary(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let stderr = "";
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} exited ${code}\n${stderr.slice(-4000)}`));
    });
  });
}

function requiredExact(actual, expected, label, findings) {
  const normalizedActual = actual ?? null;
  const normalizedExpected = expected ?? null;
  if (!Object.is(normalizedActual, normalizedExpected)) {
    findings.push({
      code: "narration_tts_lock_mismatch",
      field: label,
      expected,
      actual: actual ?? null,
    });
  }
}

export function validateNarrationTtsPolicyForTests(identity) {
  const findings = [];
  let policy;
  try {
    policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), {
      production: true,
    });
  } catch (error) {
    return {
      status: "blocked",
      findings: [{
        code: "narration_tts_identity_policy_invalid",
        message: error instanceof Error ? error.message : String(error),
      }],
      primary: null,
      fallback: null,
    };
  }
  const primary = policy.primary ?? {};
  const fallback = policy.fallback ?? null;
  if (primary.provider !== "qwen_local") {
    findings.push({
      code: "narration_tts_primary_provider_not_qwen_liam",
      expected: "qwen_local",
      actual: primary.provider ?? null,
    });
  }
  for (const [key, expected] of Object.entries({
    provider: QWEN_PIN.provider,
    model_id: QWEN_PIN.model_id,
    model_revision: QWEN_PIN.model_revision,
    model_weights_sha256: QWEN_PIN.model_weights_sha256,
    model_config_sha256: QWEN_PIN.model_config_sha256,
    generation_config_sha256: QWEN_PIN.generation_config_sha256,
    speech_tokenizer_weights_sha256: QWEN_PIN.speech_tokenizer_weights_sha256,
    speech_tokenizer_config_sha256: QWEN_PIN.speech_tokenizer_config_sha256,
    runtime: QWEN_PIN.runtime,
    runtime_version: QWEN_PIN.runtime_version,
    sample_rate_hz: QWEN_PIN.sample_rate_hz,
    voice_id: QWEN_PIN.voice_id,
    voice_sha256: QWEN_PIN.voice_sha256,
    reference_audio_path: QWEN_PIN.reference_audio_path,
    reference_audio_sha256: QWEN_PIN.reference_audio_sha256,
    reference_text: QWEN_REFERENCE_TEXT,
    reference_text_sha256: QWEN_PIN.reference_text_sha256,
    reference_manifest_path: QWEN_PIN.reference_manifest_path,
    reference_manifest_sha256: QWEN_PIN.reference_manifest_sha256,
    reference_metadata_path: QWEN_PIN.reference_metadata_path,
    reference_metadata_sha256: QWEN_PIN.reference_metadata_sha256,
    reference_voice_id: QWEN_PIN.reference_voice_id,
    reference_voice_sha256: QWEN_PIN.reference_voice_sha256,
    voice_continuity_contract: QWEN_PIN.voice_continuity_contract,
    delivery_control: "base_icl_reference_audio_only",
    instruct_supported: false,
    speed_control_supported: false,
    native_speed: null,
    temperature: QWEN_PIN.temperature,
    top_p: QWEN_PIN.top_p,
    top_k: QWEN_PIN.top_k,
    repetition_penalty: QWEN_PIN.repetition_penalty,
    max_tokens: QWEN_PIN.max_tokens,
  })) requiredExact(primary[key], expected, `primary.${key}`, findings);
  if (fallback !== null) {
    findings.push({
      code: "narration_tts_fallback_must_be_null",
      expected: null,
      actual: fallback?.provider ?? fallback,
    });
  }
  return {
    status: findings.length ? "blocked" : "passed",
    findings,
    primary: {
      ...primary,
      ...QWEN_PIN,
      reference_text: primary.reference_text ?? QWEN_REFERENCE_TEXT,
    },
    fallback: null,
    unit_contract: policy.unit_contract,
    stitch_contract: policy.stitch_contract,
    qa_policy: policy.qa_policy,
  };
}

function wordCount(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export function normalizeNarrationUnitsForTests(plan, {
  voiceId = null,
} = {}) {
  const topLevel = Array.isArray(plan?.units) ? plan.units : null;
  const raw = topLevel ?? (plan?.segments ?? []).flatMap((segment) => {
    const rows = segment?.narration_units
      ?? segment?.narration_generation_units
      ?? segment?.tts_generation_units
      ?? segment?.qwen_generation_units
      ?? [];
    return rows.map((row) => ({
      ...row,
      source_segment_ids: row.source_segment_ids?.length
        ? row.source_segment_ids
        : [segment.segment_id].filter(Boolean),
      inherited_segment_id: segment.segment_id ?? null,
    }));
  });
  if (!raw.length) throw new Error("narration_generation_plan contains no units");
  const seen = new Set();
  const units = raw.map((row, index) => {
    const unitId = String(row?.unit_id ?? "").trim();
    if (!unitId || seen.has(unitId)) {
      throw new Error(`Missing or duplicate provider-neutral unit_id at index ${index}: ${unitId || "<missing>"}`);
    }
    seen.add(unitId);
    const aliases = [
      row.spoken_text,
      row.tts_spoken_text,
      row.qwen_spoken_text,
    ].filter((value) => value != null).map(String);
    if (!aliases.length || !aliases[0].trim()) throw new Error(`Unit ${unitId} has no spoken text`);
    if (aliases.some((value) => value !== aliases[0])) {
      throw new Error(`Unit ${unitId} spoken-text aliases are not byte-equal`);
    }
    const spokenText = aliases[0];
    const spokenTextSha256 = sha256Text(spokenText);
    if (row.spoken_text_sha256 && row.spoken_text_sha256 !== spokenTextSha256) {
      throw new Error(`Unit ${unitId} spoken_text_sha256 is stale`);
    }
    if (!Array.isArray(row.source_unit_refs) || !row.source_unit_refs.length) {
      throw new Error(`Unit ${unitId} lacks stable source_unit_refs`);
    }
    const sourceSegmentIds = [...new Set([
      ...(row.source_segment_ids ?? []),
      ...row.source_unit_refs.map((ref) => ref?.segment_id),
      row.inherited_segment_id,
    ].map((value) => String(value ?? "").trim()).filter(Boolean))];
    if (sourceSegmentIds.length > 1) {
      throw new Error(
        `Unit ${unitId} crosses a hard voice-segment boundary: ${sourceSegmentIds.join(", ")}`,
      );
    }
    const controls = row.provider_controls ?? {};
    const qwen = controls.qwen3 ?? controls.qwen_local ?? {};
    const unitVoiceId = String(
      qwen.reference_voice_id
        ?? qwen.target_voice_id
        ?? row.reference_id
        ?? "",
    );
    if ((voiceId && unitVoiceId !== voiceId)
      || unitVoiceId !== QWEN_LIAM_PRIMARY_LOCK.voice_id
      || qwen.provider !== "qwen_local"
      || qwen.model_id !== QWEN_LIAM_PRIMARY_LOCK.model_id
      || qwen.model_revision !== QWEN_LIAM_PRIMARY_LOCK.model_revision
      || qwen.reference_audio_sha256
        !== QWEN_LIAM_PRIMARY_LOCK.reference_audio_sha256
      || qwen.reference_manifest_sha256
        !== QWEN_LIAM_PRIMARY_LOCK.reference_manifest_sha256
      || qwen.voice_continuity_contract
        !== QWEN_LIAM_PRIMARY_LOCK.voice_continuity_contract
      || qwen.instruct_supported !== false
      || qwen.instruct_submitted !== false
      || qwen.speed_control_supported !== false
      || qwen.native_speed != null) {
      throw new Error(`Unit ${unitId} Qwen controls drift from the locked Liam Base reference-clone policy`);
    }
    const unitWords = Number(row.word_count ?? wordCount(spokenText));
    if (unitWords > 60) {
      throw new Error(`Unit ${unitId} exceeds the hard 60-word Qwen request maximum`);
    }
    if (!/[.!?…]["”’\])]*$/u.test(spokenText.trim())) {
      throw new Error(`Unit ${unitId} does not end on a complete sentence boundary`);
    }
    const expectedOrder = Number(row.order_index ?? index);
    if (!Number.isInteger(expectedOrder)) throw new Error(`Unit ${unitId} has invalid order_index`);
    return {
      ...row,
      unit_id: unitId,
      order_index: expectedOrder,
      spoken_text: spokenText,
      tts_spoken_text: spokenText,
      qwen_spoken_text: spokenText,
      spoken_text_sha256: spokenTextSha256,
      word_count: unitWords,
      source_segment_ids: sourceSegmentIds,
      qwen_instruct: String(
        controls.qwen3?.instruct
          ?? controls.qwen_local?.instruct
          ?? row.qwen_instruct
          ?? "",
      ),
    };
  });
  const orderValues = units.map((unit) => unit.order_index);
  const base = orderValues[0];
  if (!orderValues.every((value, index) => value === base + index)) {
    throw new Error("narration_generation_plan unit order_index values are reordered or non-contiguous");
  }
  return units;
}

export function validateNarrationPlanPolicyForTests(plan, policy) {
  const controls = plan?.provider_controls?.qwen3
    ?? plan?.provider_controls?.qwen_local
    ?? {};
  const actual = {
    primary_provider: plan?.primary_provider ?? plan?.provider ?? plan?.tts_provider,
    fallback_provider: plan?.fallback_provider
      ?? plan?.provider_policy?.fallback_provider,
    narrator_voice_id: plan?.narrator_voice_id
      ?? controls.reference_voice_id
      ?? controls.target_voice_id,
    native_speed: plan?.tts_native_speed
      ?? controls.native_speed
      ?? null,
  };
  const findings = [];
  requiredExact(
    actual.primary_provider,
    policy.primary.provider,
    "plan.primary_provider",
    findings,
  );
  requiredExact(
    actual.fallback_provider ?? null,
    null,
    "plan.fallback_provider",
    findings,
  );
  requiredExact(
    actual.narrator_voice_id,
    policy.primary.voice_id,
    "plan.narrator_voice_id",
    findings,
  );
  if (actual.native_speed != null) {
    findings.push({
      code: "narration_tts_plan_lock_mismatch",
      field: "plan.native_speed",
      expected: null,
      actual: actual.native_speed,
    });
  }
  requiredExact(
    plan?.qwen_liam_unit_grouping?.target_spoken_words_min,
    45,
    "plan.qwen_liam_unit_grouping.target_spoken_words_min",
    findings,
  );
  requiredExact(
    plan?.qwen_liam_unit_grouping?.target_spoken_words_max,
    60,
    "plan.qwen_liam_unit_grouping.target_spoken_words_max",
    findings,
  );
  requiredExact(
    plan?.qwen_liam_unit_grouping?.hard_spoken_words_max,
    60,
    "plan.qwen_liam_unit_grouping.hard_spoken_words_max",
    findings,
  );
  requiredExact(
    plan?.qwen_liam_unit_grouping?.continuous_requests_allowed,
    false,
    "plan.qwen_liam_unit_grouping.continuous_requests_allowed",
    findings,
  );
  findings.push(...narrationPlanVoiceIdentityFindings(plan, policy));
  return {
    status: findings.length ? "blocked" : "passed",
    findings,
    actual,
  };
}

function normalizedWords(value) {
  return String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function includesSequence(haystack, needle) {
  if (!needle.length) return true;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((token, index) => haystack[start + index] === token)) return true;
  }
  return false;
}

export function protectedTermFindingsForTests(unit, recognizedText) {
  const recognized = normalizedWords(recognizedText);
  const intended = normalizedWords(unit.spoken_text);
  const findings = [];
  for (const raw of unit.protected_terms ?? []) {
    const term = typeof raw === "string"
      ? raw
      : raw.spoken_form ?? raw.term ?? raw.text ?? "";
    const accepted = [
      term,
      ...(typeof raw === "object" && Array.isArray(raw.accepted_forms) ? raw.accepted_forms : []),
    ].filter(Boolean);
    const intendedTerm = normalizedWords(term);
    if (!intendedTerm.length || !includesSequence(intended, intendedTerm)) continue;
    if (!accepted.some((value) => includesSequence(recognized, normalizedWords(value)))) {
      findings.push({
        severity: "blocker",
        code: "tts_transcript_protected_term_missing",
        protected_term: term,
        accepted_forms: accepted,
      });
    }
  }
  return findings;
}

export function equivalentPhrasesForTests(unit) {
  return [
    ...(Array.isArray(unit.tts_override_replacements_applied)
      ? unit.tts_override_replacements_applied.filter(
        (row) => row?.asr_equivalence_allowed === true,
      )
      : []),
    ...(unit.asr_equivalent_phrases ?? []),
  ];
}

function selectedResultsForReport(units, selectedRows, candidates) {
  const selectedById = new Map(selectedRows.map((row) => [String(row.unit_id), row]));
  return units.flatMap((unit) => {
    const selected = selectedById.get(String(unit.unit_id));
    if (!selected) return [];
    const unitCandidates = candidates.filter(
      (candidate) => String(candidate.unit_id) === String(unit.unit_id),
    );
    return [{
      unit_id: unit.unit_id,
      selected_provider: selected.provider,
      provider: selected.provider,
      model_id: selected.model_id,
      voice_id: selected.voice_id,
      attempt: selected.attempt,
      spoken_text_sha256: unit.spoken_text_sha256,
      primary_spoken_text_sha256: unit.spoken_text_sha256,
      selected_spoken_text_sha256: unit.spoken_text_sha256,
      fallback_spoken_text_sha256: null,
      voice_continuity_contract:
        QWEN_LIAM_PRIMARY_LOCK.voice_continuity_contract,
      voice_continuity: selected.unit_qa?.voice_continuity ?? null,
      audio_path: selected.wav,
      audio_sha256: selected.unit_qa?.audio_sha256 ?? null,
      synthesis_identity_sha256: selected.synthesis_identity_sha256 ?? null,
      selected_qa: selected.unit_qa,
      qa_status: selected.unit_qa?.status ?? null,
      candidate_attempts: unitCandidates.map((candidate) => ({
        provider: candidate.provider,
        attempt: candidate.attempt,
        seed: candidate.seed,
        audio_sha256: candidate.audio_sha256,
        synthesis_identity_sha256: candidate.synthesis_identity_sha256,
        disposition: candidate.disposition,
      })),
    }];
  });
}

export function selectedQaDecisionForTests(selectedRows, {
  unresolvedUnitIds = [],
  orderQa = { status: "passed", blockers: [] },
} = {}) {
  const selectedBlockers = selectedRows.flatMap((row) => (
    [
      ...(row.unit_qa?.findings ?? [])
      .filter((finding) => finding.severity === "blocker")
      .map((finding) => ({ unit_id: row.unit_id, provider: row.provider, ...finding })),
      ...(!["passed", "passed_with_warnings"].includes(
        String(row.unit_qa?.status ?? "").toLowerCase(),
      ) && !(row.unit_qa?.findings ?? []).some((finding) => finding.severity === "blocker")
        ? [{
            unit_id: row.unit_id,
            provider: row.provider,
            severity: "blocker",
            code: row.unit_qa
              ? "tts_selected_unit_qa_status_not_passed"
              : "tts_selected_unit_qa_missing",
          }]
        : []),
    ]
  ));
  return {
    status: unresolvedUnitIds.length || orderQa.status !== "passed" || selectedBlockers.length
      ? "blocked"
      : "passed",
    selected_blockers: selectedBlockers,
    blockers: [
      ...(orderQa.blockers ?? []),
      ...(unresolvedUnitIds.length ? [{
        code: "narration_tts_units_exhausted_qwen_liam_attempts",
        unit_ids: unresolvedUnitIds,
      }] : []),
      ...selectedBlockers,
    ],
  };
}

function ttsStatusContract({
  policy,
  units,
  selectedRows,
  candidates,
  unitQaStatus,
  fullStreamQaStatus,
}) {
  const results = selectedResultsForReport(units, selectedRows, candidates);
  return {
    primary_provider: policy.primary.provider,
    primary_model_id: policy.primary.model_id,
    primary_model_revision: policy.primary.model_revision,
    narrator_voice_id: policy.primary.voice_id,
    tts_native_speed: null,
    primary: {
      provider: policy.primary.provider,
      model_id: policy.primary.model_id,
      model_revision: policy.primary.model_revision,
      voice_id: policy.primary.voice_id,
      voice_sha256: policy.primary.voice_sha256,
      native_speed: null,
      reference_audio_sha256: policy.primary.reference_audio_sha256,
      reference_manifest_sha256: policy.primary.reference_manifest_sha256,
      voice_continuity_contract: policy.primary.voice_continuity_contract,
    },
    post_tempo_normalized: false,
    effective_concurrency: EFFECTIVE_CONCURRENCY,
    model_load_policy: "once_per_serial_qwen_attempt_invocation",
    qa_policy: QA_POLICY_VERSION,
    unit_qa_policy_version: QA_POLICY_VERSION,
    unit_qa_status: unitQaStatus,
    full_stream_qa_status: fullStreamQaStatus,
    expected_unit_count: units.length,
    selected_unit_count: selectedRows.length,
    fallback_unit_ids: [],
    fallback_selected_unit_ids: [],
    fallback_usage: null,
    retry_policy: {
      provider: policy.primary.provider,
      same_voice_reference_required: true,
      exact_unit_only: true,
      maximum_attempts_per_unit: 2,
      retry_only_confirmed_skip_truncation_or_stutter: true,
      automatic_retry_limited_to_failed_empty_or_objectively_truncated_audio: true,
      other_acoustic_or_voice_identity_blockers_require_review: true,
      uncertain_asr_findings_are_warning_only: true,
    },
    results,
  };
}

function rebuildQaAggregate(rows, candidates) {
  const historicalCandidateBlockers = rows.flatMap((row) => (row.unit_qa?.findings ?? [])
    .filter((finding) => finding.severity === "blocker")
    .map((finding) => ({
      unit_id: row.unit_id,
      provider: row.provider,
      attempt: row.attempt,
      ...finding,
    })));
  const warnings = rows.flatMap((row) => (row.unit_qa?.findings ?? [])
    .filter((finding) => finding.severity === "warning")
    .map((finding) => ({
      unit_id: row.unit_id,
      provider: row.provider,
      attempt: row.attempt,
      ...finding,
    })));
  return {
    schema: "goldflow_narration_tts_unit_qa_v1",
    status: "pending_selection_adjudication",
    policy_version: QA_POLICY_VERSION,
    candidate_count: candidates.length,
    blocked_candidate_count: rows.filter((row) => row.unit_qa?.status === "blocked").length,
    historical_candidate_blocker_count: historicalCandidateBlockers.length,
    warning_count: warnings.length,
    historical_candidate_blockers: historicalCandidateBlockers,
    warnings,
    candidates,
  };
}

function applyProtectedTermQa(rows) {
  for (const row of rows) {
    const recognizedText = row.unit_qa?.transcript_cross_validation?.recognized_text
      ?? row.unit_qa?.transcript?.recognized_text;
    if (!recognizedText) continue;
    const protectedFindings = protectedTermFindingsForTests(row, recognizedText);
    if (!protectedFindings.length) continue;
    row.unit_qa.findings = [...(row.unit_qa.findings ?? []), ...protectedFindings];
    row.unit_qa.status = "blocked";
  }
}

async function wavSampleCount(filePath) {
  const buffer = await fs.readFile(filePath);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") return Math.floor(size / 2);
    offset += 8 + size + (size % 2);
  }
  throw new Error(`Could not find WAV data chunk: ${filePath}`);
}

function dbfs(value) {
  return value > 0 ? Number((20 * Math.log10(value)).toFixed(3)) : null;
}

export function joinQaFromPcmForTests(samples, sampleRate, preparedInputs, boundaries) {
  const values = samples instanceof Int16Array ? samples : Int16Array.from(samples);
  const boundaryMap = new Map(boundaries.map((row) => [String(row.after_unit_id), row]));
  const requiredEffectiveGapSamples = Math.round(
    QWEN_LIAM_PRIMARY_LOCK.stitch_contract.join_silence_ms * sampleRate / 1000,
  );
  const rows = [];
  const blockers = [];
  const warnings = [];
  let cursor = 0;
  for (let index = 0; index < preparedInputs.length; index += 1) {
    const prepared = preparedInputs[index];
    const preparedSamples = Number(prepared.sample_count);
    if (!Number.isInteger(preparedSamples) || preparedSamples <= 0) {
      blockers.push({ code: "tts_join_prepared_sample_count_missing", unit_id: prepared.unit_id });
      continue;
    }
    cursor += preparedSamples;
    if (index >= preparedInputs.length - 1) continue;
    const boundary = boundaryMap.get(String(prepared.unit_id));
    if (!boundary) {
      blockers.push({ code: "tts_join_boundary_missing", after_unit_id: prepared.unit_id });
      continue;
    }
    const gapSamples = Number(boundary.gap_sample_count ?? 0);
    const nextPrepared = preparedInputs[index + 1];
    const actualRetainedLeft = Number(
      prepared?.prepared_qa?.metrics?.trailing_silence_sample_count
      ?? prepared?.retained_trailing_silence_sample_count,
    );
    const actualRetainedRight = Number(
      nextPrepared?.prepared_qa?.metrics?.leading_silence_sample_count
      ?? nextPrepared?.retained_leading_silence_sample_count,
    );
    const actualEffectiveGapSamples =
      actualRetainedLeft + gapSamples + actualRetainedRight;
    const boundaryContractFindings = [];
    const addBoundaryContractBlocker = (code, expected, actual) => {
      const finding = {
        code,
        after_unit_id: prepared.unit_id,
        before_unit_id: nextPrepared?.unit_id ?? null,
        expected_sample_count: expected,
        actual_sample_count: actual,
      };
      boundaryContractFindings.push(finding);
      blockers.push(finding);
    };
    if (!Number.isInteger(actualRetainedLeft) || actualRetainedLeft < 0) {
      addBoundaryContractBlocker(
        "tts_join_actual_left_retained_silence_samples_missing",
        "nonnegative integer",
        Number.isFinite(actualRetainedLeft) ? actualRetainedLeft : null,
      );
    }
    if (!Number.isInteger(actualRetainedRight) || actualRetainedRight < 0) {
      addBoundaryContractBlocker(
        "tts_join_actual_right_retained_silence_samples_missing",
        "nonnegative integer",
        Number.isFinite(actualRetainedRight) ? actualRetainedRight : null,
      );
    }
    if (Number.isInteger(actualRetainedLeft)
      && actualRetainedLeft > preparedSamples) {
      addBoundaryContractBlocker(
        "tts_join_actual_left_retained_silence_exceeds_prepared_audio",
        preparedSamples,
        actualRetainedLeft,
      );
    }
    const nextPreparedSamples = Number(nextPrepared?.sample_count);
    if (Number.isInteger(actualRetainedRight)
      && Number.isInteger(nextPreparedSamples)
      && actualRetainedRight > nextPreparedSamples) {
      addBoundaryContractBlocker(
        "tts_join_actual_right_retained_silence_exceeds_prepared_audio",
        nextPreparedSamples,
        actualRetainedRight,
      );
    }
    if (Number(boundary.target_gap_sample_count) !== requiredEffectiveGapSamples) {
      addBoundaryContractBlocker(
        "tts_join_target_gap_sample_count_mismatch",
        requiredEffectiveGapSamples,
        Number(boundary.target_gap_sample_count),
      );
    }
    if (Number(boundary.retained_left_trailing_silence_sample_count)
      !== actualRetainedLeft) {
      addBoundaryContractBlocker(
        "tts_join_declared_left_retained_silence_samples_mismatch",
        actualRetainedLeft,
        Number(boundary.retained_left_trailing_silence_sample_count),
      );
    }
    if (Number(boundary.retained_right_leading_silence_sample_count)
      !== actualRetainedRight) {
      addBoundaryContractBlocker(
        "tts_join_declared_right_retained_silence_samples_mismatch",
        actualRetainedRight,
        Number(boundary.retained_right_leading_silence_sample_count),
      );
    }
    if (Number(boundary.inserted_silence_sample_count) !== gapSamples) {
      addBoundaryContractBlocker(
        "tts_join_declared_inserted_silence_samples_mismatch",
        gapSamples,
        Number(boundary.inserted_silence_sample_count),
      );
    }
    if (Number(boundary.effective_gap_sample_count)
      !== actualEffectiveGapSamples) {
      addBoundaryContractBlocker(
        "tts_join_declared_effective_gap_sample_count_mismatch",
        actualEffectiveGapSamples,
        Number(boundary.effective_gap_sample_count),
      );
    }
    if (actualEffectiveGapSamples !== requiredEffectiveGapSamples) {
      addBoundaryContractBlocker(
        "tts_join_effective_gap_sample_count_mismatch",
        requiredEffectiveGapSamples,
        actualEffectiveGapSamples,
      );
    }
    const leftStep = cursor > 0 && cursor < values.length
      ? Math.abs(values[cursor] - values[cursor - 1]) / 32768
      : 0;
    let silencePeak = 0;
    for (let sample = cursor; sample < Math.min(values.length, cursor + gapSamples); sample += 1) {
      silencePeak = Math.max(silencePeak, Math.abs(values[sample]) / 32768);
    }
    const gapEnd = cursor + gapSamples;
    const rightStep = gapEnd > 0 && gapEnd < values.length
      ? Math.abs(values[gapEnd] - values[gapEnd - 1]) / 32768
      : 0;
    const maximumStep = Math.max(leftStep, rightStep);
    const blockerThreshold = 10 ** (-8 / 20);
    const warningThreshold = 10 ** (-12 / 20);
    const row = {
      after_unit_id: prepared.unit_id,
      before_unit_id: preparedInputs[index + 1].unit_id,
      boundary_sample_index: cursor,
      target_gap_sample_count: requiredEffectiveGapSamples,
      retained_left_trailing_silence_sample_count: actualRetainedLeft,
      retained_right_leading_silence_sample_count: actualRetainedRight,
      inserted_silence_sample_count: gapSamples,
      effective_gap_sample_count: actualEffectiveGapSamples,
      gap_sample_count: gapSamples,
      maximum_edge_step_dbfs: dbfs(maximumStep),
      inserted_gap_peak_dbfs: dbfs(silencePeak),
      status: boundaryContractFindings.length
        || maximumStep > blockerThreshold
        || silencePeak > 10 ** (-54 / 20)
        ? "blocked"
        : maximumStep > warningThreshold
          ? "passed_with_warning"
        : "passed",
    };
    rows.push(row);
    if (maximumStep > blockerThreshold) blockers.push({
      code: "tts_join_impulsive_discontinuity",
      ...row,
    });
    else if (maximumStep > warningThreshold) warnings.push({
      severity: "warning",
      code: "tts_join_possible_impulsive_discontinuity",
      ...row,
    });
    if (silencePeak > 10 ** (-54 / 20)) blockers.push({
      code: "tts_join_inserted_gap_not_silent",
      ...row,
    });
    cursor = gapEnd;
  }
  if (cursor !== values.length) blockers.push({
    code: "tts_join_total_sample_count_mismatch",
    expected_sample_count: cursor,
    actual_sample_count: values.length,
  });
  return {
    status: blockers.length
      ? "blocked"
      : warnings.length ? "passed_with_warnings" : "passed",
    policy_version: STITCH_POLICY_VERSION,
    sample_rate_hz: sampleRate,
    required_effective_gap_ms: QWEN_LIAM_PRIMARY_LOCK.stitch_contract.join_silence_ms,
    required_effective_gap_sample_count: requiredEffectiveGapSamples,
    exact_effective_gap_sample_count_required: true,
    join_count: rows.length,
    joins: rows,
    blockers,
    warnings,
  };
}

async function runSynthesis({
  route,
  attempt,
  units,
  policy,
  outputDir,
  python,
  runnerPath,
  invocationId,
}) {
  if (route !== "qwen") {
    throw new Error(`Qwen Liam production forbids alternate synthesis route ${route}`);
  }
  const provider = PRIMARY_TTS_PROVIDER;
  const jobs = {
    schema: "goldflow_narration_tts_jobs_v1",
    route,
    provider,
    attempt,
    qwen_reference_audio_sha256: policy.primary.reference_audio_sha256,
    qwen_reference_text: policy.primary.reference_text,
    qwen_reference_manifest_sha256: policy.primary.reference_manifest_sha256,
    qwen_reference_voice_id: policy.primary.reference_voice_id,
    qwen_reference_voice_sha256: policy.primary.reference_voice_sha256,
    qwen_voice_continuity_contract:
      policy.primary.voice_continuity_contract,
    qwen_native_speed: null,
    qwen_post_tts_tempo_processing: false,
    continuous_longform_request: false,
    jobs: units.map((unit) => ({
      unit_id: unit.unit_id,
      spoken_text: unit.spoken_text,
      spoken_text_sha256: unit.spoken_text_sha256,
      attempt,
      seed: deterministicTtsSeed(unit.unit_id, provider, attempt),
      qwen_instruct: unit.qwen_instruct,
    })),
  };
  const jobsPath = path.join(outputDir, "jobs", `${invocationId}-${route}-attempt-${attempt}.json`);
  const reportPath = path.join(outputDir, "runs", `${invocationId}-${route}-attempt-${attempt}.json`);
  await atomicWriteJson(jobsPath, jobs);
  const args = [
    runnerPath,
    "--route", route,
    "--jobs", jobsPath,
    "--output-dir", path.join(outputDir, "units", provider),
    "--report", reportPath,
  ];
  args.push(
    "--qwen-reference-audio", policy.primary.reference_audio_path,
    "--qwen-reference-text", policy.primary.reference_text,
  );
  await run(python, args);
  const report = await readJson(reportPath, null);
  if (!["passed", "completed_with_job_failures"].includes(report?.status)
    || report.job_count !== units.length
    || report.result_count !== units.length) {
    throw new Error(`Invalid ${route} production runner report: ${reportPath}`);
  }
  const expectedModel = policy.primary;
  if (report.provider !== provider
    || report.model_id !== expectedModel.model_id
    || report.model_revision !== expectedModel.model_revision
    || report.effective_concurrency !== EFFECTIVE_CONCURRENCY
    || report.model_load_count !== 1
    || report.voice_id !== policy.primary.voice_id
    || report.voice_sha256 !== policy.primary.voice_sha256
    || report.voice_clone_contract
      !== "qwen_icl_clone_of_selected_liam_reference") {
    throw new Error(`Pinned ${route} worker identity mismatch: ${reportPath}`);
  }
  const resultMap = new Map(report.results.map((row) => [String(row.unit_id), row]));
  for (const unit of units) {
    const result = resultMap.get(unit.unit_id);
    if (!result || result.spoken_text_sha256 !== unit.spoken_text_sha256) {
      throw new Error(`${route} result failed exact spoken-text identity for ${unit.unit_id}`);
    }
    if (result.status === "failed") continue;
    const synthesisIdentity = result.synthesis_identity ?? {};
    if (synthesisIdentity.provider !== provider
      || synthesisIdentity.model_id !== expectedModel.model_id
      || synthesisIdentity.model_revision !== expectedModel.model_revision
      || synthesisIdentity.reference_audio_sha256
        !== policy.primary.reference_audio_sha256
      || synthesisIdentity.reference_text !== policy.primary.reference_text
      || synthesisIdentity.reference_manifest_sha256
        !== policy.primary.reference_manifest_sha256
      || synthesisIdentity.voice !== policy.primary.voice_id
      || synthesisIdentity.voice_sha256 !== policy.primary.voice_sha256
      || synthesisIdentity.voice_continuity_contract
        !== policy.primary.voice_continuity_contract
      || synthesisIdentity.voice_clone_contract
        !== "qwen_icl_clone_of_selected_liam_reference"
      || synthesisIdentity.native_speed_applied != null
      || synthesisIdentity.post_tts_tempo_processing !== false) {
      throw new Error(`${route} result pin identity mismatch for ${unit.unit_id}`);
    }
    if (result.output_sha256 !== await sha256File(result.output_path)) {
      throw new Error(`${route} result audio hash mismatch for ${unit.unit_id}`);
    }
  }
  return { report, reportPath, results: units.map((unit) => resultMap.get(unit.unit_id)) };
}

async function applyQwenVoiceContinuityQa({
  rows,
  policy,
  outputDir,
  invocationId,
  attempt,
  similarityPython,
  similarityRunnerPath,
}) {
  if (!rows.length) return null;
  const reportPath = path.join(
    outputDir,
    "runs",
    `${invocationId}-qwen-voice-continuity-attempt-${attempt}.json`,
  );
  let report = null;
  let executionError = null;
  try {
    await run(similarityPython, [
      similarityRunnerPath,
      "--model", policy.primary.speaker_similarity_model_path,
      "--reference", policy.primary.reference_audio_path,
      ...rows.flatMap((row) => ["--candidate", row.wav]),
      "--output", reportPath,
      "--minimum-similarity", String(policy.primary.minimum_cosine_similarity),
      "--warning-below-similarity", String(
        policy.primary.warning_below_cosine_similarity,
      ),
      "--reference-voice-id", policy.primary.reference_voice_id,
      "--reference-voice-sha256", policy.primary.reference_voice_sha256,
    ]);
    report = await readJson(reportPath, null);
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
  }

  const reportReferences = report?.references ?? [];
  const reportCandidates = report?.candidates ?? [];
  const candidateByHash = new Map(
    reportCandidates
      .filter((candidate) => candidate?.audio_sha256)
      .map((candidate) => [String(candidate.audio_sha256), candidate]),
  );
  const reportIdentityValid = Boolean(
    report
    && report.schema === "goldflow_tts_voice_continuity_qa_v1"
    && report.method === policy.primary.speaker_similarity_method
    && report.model_sha256 === policy.primary.speaker_similarity_model_sha256
    && Number(report.minimum_cosine_similarity)
      === Number(policy.primary.minimum_cosine_similarity)
    && Number(report.warning_below_cosine_similarity)
      === Number(policy.primary.warning_below_cosine_similarity)
    && report.reference_voice_id === policy.primary.reference_voice_id
    && report.reference_voice_sha256 === policy.primary.reference_voice_sha256
    && reportReferences.length === 1
    && reportReferences[0]?.audio_sha256 === policy.primary.reference_audio_sha256
    && reportCandidates.length === rows.length
  );
  for (const row of rows) {
    const audioSha256 = row.unit_qa?.audio_sha256 ?? null;
    const candidate = candidateByHash.get(String(audioSha256)) ?? null;
    const continuityQa = candidate
      ? {
          ...candidate,
          schema: "goldflow_tts_voice_continuity_unit_qa_v1",
          reference_voice_id: report.reference_voice_id,
          reference_voice_sha256: report.reference_voice_sha256,
          reference_audio_sha256: reportReferences[0]?.audio_sha256 ?? null,
          similarity_method: report.method,
          similarity_model_sha256: report.model_sha256,
          similarity_calibration_sha256:
            policy.primary.speaker_similarity_calibration_sha256,
          warning_below_cosine_similarity:
            report.warning_below_cosine_similarity,
          voice_continuity_contract: policy.primary.voice_continuity_contract,
          report_path: reportPath,
          report_sha256: await sha256File(reportPath),
        }
      : null;
    const decision = voiceContinuityDecision(
      reportIdentityValid ? continuityQa : null,
      {
        audioSha256,
        referenceVoiceId: policy.primary.voice_id,
        referenceVoiceSha256: policy.primary.voice_sha256,
        similarityModelSha256: policy.primary.speaker_similarity_model_sha256,
        minimumCosineSimilarity: policy.primary.minimum_cosine_similarity,
        warningBelowCosineSimilarity:
          policy.primary.warning_below_cosine_similarity,
      },
    );
    if (!reportIdentityValid) {
      decision.findings.push({
        severity: "blocker",
        code: "tts_primary_voice_continuity_report_identity_invalid",
        report_path: reportPath,
        execution_error: executionError,
      });
      decision.status = "blocked";
    }
    row.unit_qa.voice_continuity = continuityQa;
    row.unit_qa.findings = [
      ...(row.unit_qa.findings ?? []),
      ...decision.findings,
    ];
    if (decision.status !== "passed") {
      row.unit_qa.status = "blocked";
    } else if (decision.findings.some(
      (finding) => finding.severity === "warning",
    ) && row.unit_qa.status === "passed") {
      row.unit_qa.status = "passed_with_warnings";
    }
  }
  return {
    report,
    reportPath,
    reportIdentityValid,
    executionError,
  };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const channel = flags.channel ?? "53rebirth";
  const week = flags.week ?? "current";
  const episode = flags.episode ?? "ep_01";
  const episodeDir = path.resolve(
    flags["episode-dir"]
      ?? flags.episodeDir
      ?? path.join(DATA_ROOT, "channels", channel, "weekly_runs", week, "episodes", episode),
  );
  const planPath = path.resolve(
    flags.plan ?? path.join(episodeDir, "narration_generation_plan.json"),
  );
  const identityPath = path.resolve(
    flags.identity ?? path.join(episodeDir, "run_identity.json"),
  );
  const scriptPath = path.resolve(
    flags.script ?? path.join(episodeDir, "script_clean.md"),
  );
  const outputDir = path.resolve(
    flags["output-dir"] ?? path.join(episodeDir, "assets/audio/narration_tts"),
  );
  const python = path.resolve(flags.python ?? process.env.ANIFACTORY_LOCAL_TTS_PYTHON ?? DEFAULT_PYTHON);
  const runnerPath = path.resolve(
    flags.runner ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "tts-local-production-runner.py"),
  );
  const similarityPython = path.resolve(
    flags["similarity-python"]
      ?? process.env.ANIFACTORY_TTS_SIMILARITY_PYTHON
      ?? DEFAULT_SIMILARITY_PYTHON,
  );
  const similarityRunnerPath = path.resolve(
    flags["similarity-runner"]
      ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "tts-speaker-similarity.py"),
  );
  const dryRun = boolFlag(flags["dry-run"]);
  const planOnly = boolFlag(flags["plan-only"]);
  const requestedConcurrency = Number(flags.concurrency ?? EFFECTIVE_CONCURRENCY);
  if (!Number.isInteger(requestedConcurrency)
    || requestedConcurrency !== EFFECTIVE_CONCURRENCY) {
    throw new Error(
      `Local narration TTS is production-locked to --concurrency ${EFFECTIVE_CONCURRENCY}; `
      + `got ${flags.concurrency ?? "<invalid>"}. Parallel model copies are forbidden.`,
    );
  }
  const invocationId = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${process.pid}`;
  const reportPath = path.join(episodeDir, `narration_tts_report_${episode}.json`);
  const unitQaPath = path.join(episodeDir, `narration_tts_unit_qa_${episode}.json`);
  const fullQaPath = path.join(episodeDir, `narration_full_stream_qa_${episode}.json`);
  const stitchReportPath = path.join(episodeDir, `audio_stitch_report_${episode}-narration.json`);
  const eventsPath = path.join(episodeDir, "narration_tts_attempt_events.jsonl");

  const [identity, plan, scriptBuffer] = await Promise.all([
    readJson(identityPath, null),
    readJson(planPath, null),
    fs.readFile(scriptPath),
  ]);
  if (!identity || !plan) throw new Error("Missing locked run_identity.json or narration_generation_plan.json");
  const scriptHash = createHash("sha256").update(scriptBuffer).digest("hex");
  if (plan.source_script_hash !== scriptHash) {
    throw new Error(`Narration plan script hash ${plan.source_script_hash ?? "missing"} does not match ${scriptHash}`);
  }
  if (plan.status !== "passed") throw new Error(`Narration plan status is ${plan.status ?? "missing"}`);
  if (plan.text_integrity_coverage?.status !== "passed") {
    throw new Error("Narration plan text_integrity_coverage is missing or blocked");
  }
  if (plan.system_ui_speech_coverage?.status !== "passed") {
    throw new Error("Narration plan system_ui_speech_coverage is missing or blocked");
  }
  const policy = validateNarrationTtsPolicyForTests(identity);
  if (policy.status !== "passed") {
    throw new Error(`Locked narration TTS policy failed: ${JSON.stringify(policy.findings)}`);
  }
  const planPolicy = validateNarrationPlanPolicyForTests(plan, policy);
  if (planPolicy.status !== "passed") {
    throw new Error(`Narration plan provider policy failed: ${JSON.stringify(planPolicy.findings)}`);
  }
  if (await sha256File(policy.primary.reference_audio_path) !== policy.primary.reference_audio_sha256) {
    throw new Error("Locked local Qwen Liam reference audio hash does not match");
  }
  if (sha256Text(policy.primary.reference_text) !== policy.primary.reference_text_sha256) {
    throw new Error("Locked local Qwen Liam reference text hash does not match");
  }
  for (const [assetPath, expectedSha256, label] of [
    [
      policy.primary.reference_manifest_path,
      policy.primary.reference_manifest_sha256,
      "reference manifest",
    ],
    [
      policy.primary.reference_metadata_path,
      policy.primary.reference_metadata_sha256,
      "reference metadata",
    ],
    [
      policy.primary.speaker_similarity_model_path,
      policy.primary.speaker_similarity_model_sha256,
      "speaker-similarity model",
    ],
    [
      policy.primary.speaker_similarity_calibration_path,
      policy.primary.speaker_similarity_calibration_sha256,
      "speaker-similarity calibration",
    ],
  ]) {
    if (await sha256File(assetPath) !== expectedSha256) {
      throw new Error(`Locked local Qwen Liam ${label} hash does not match`);
    }
  }
  if (policy.primary.reference_voice_id !== policy.primary.voice_id
    || policy.primary.reference_voice_sha256 !== policy.primary.voice_sha256
    || policy.primary.voice_continuity_contract
      !== "qwen_icl_clone_of_liam_reference"
    || Number(policy.primary.minimum_cosine_similarity)
      !== QWEN_LIAM_MINIMUM_COSINE_SIMILARITY
    || Number(policy.primary.warning_below_cosine_similarity)
      !== QWEN_LIAM_WARNING_BELOW_COSINE_SIMILARITY
    || Number(policy.primary.warning_floor_cosine_similarity)
      !== QWEN_LIAM_WARNING_BELOW_COSINE_SIMILARITY) {
    throw new Error("Qwen production is not locked to the selected Liam voice-continuity contract");
  }
  const units = normalizeNarrationUnitsForTests(plan, {
    voiceId: policy.primary.voice_id,
  });
  const requestedRecoveryScope = recoveryScopeForTests(
    flags["confirmed-retry-unit-ids"] ?? flags["regenerate-unit-ids"],
    units,
  );
  if (requestedRecoveryScope && !String(
    flags["confirmed-retry-evidence"] ?? "",
  ).trim()) {
    throw new Error(
      "--confirmed-retry-unit-ids requires --confirmed-retry-evidence <json> "
      + "recording the audible skip, truncation, or stutter that was confirmed.",
    );
  }
  const planSha256 = await sha256File(planPath);
  const priorNarrationReportBuffer = requestedRecoveryScope
    ? await fs.readFile(reportPath).catch(() => null)
    : null;
  const priorNarrationReport = priorNarrationReportBuffer
    ? JSON.parse(priorNarrationReportBuffer.toString("utf8"))
    : null;
  const priorNarrationReportSha256 = priorNarrationReportBuffer
    ? createHash("sha256").update(priorNarrationReportBuffer).digest("hex")
    : null;
  const [pythonStat, runnerStat, similarityPythonStat, similarityRunnerStat] = await Promise.all([
    fs.stat(python).catch(() => null),
    fs.stat(runnerPath).catch(() => null),
    fs.stat(similarityPython).catch(() => null),
    fs.stat(similarityRunnerPath).catch(() => null),
  ]);
  if (!pythonStat?.isFile()) throw new Error(`Pinned local TTS Python is missing: ${python}`);
  if (!runnerStat?.isFile()) throw new Error(`Local TTS production runner is missing: ${runnerPath}`);
  if (!similarityPythonStat?.isFile()) {
    throw new Error(`Pinned speaker-similarity Python is missing: ${similarityPython}`);
  }
  if (!similarityRunnerStat?.isFile()) {
    throw new Error(`Speaker-similarity runner is missing: ${similarityRunnerPath}`);
  }
  const validation = {
    schema: "goldflow_narration_tts_plan_validation_v1",
    status: "validated_plan_only_not_synthesized",
    production_stage_passed: false,
    source_script_hash: scriptHash,
    run_identity_path: identityPath,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: planSha256,
    unit_count: units.length,
    unit_ids: units.map((unit) => unit.unit_id),
    effective_concurrency: EFFECTIVE_CONCURRENCY,
    model_load_policy: "once_per_serial_qwen_attempt_invocation",
    recovery_scope: requestedRecoveryScope,
    runtime_preflight: {
      status: "launcher_paths_validated_models_not_loaded",
      python_path: python,
      runner_path: runnerPath,
      similarity_python_path: similarityPython,
      similarity_runner_path: similarityRunnerPath,
      model_pins_checked_during_plan_only: false,
    },
    policy,
    plan_policy: planPolicy,
  };
  if (dryRun || planOnly) {
    const validationPath = path.join(
      episodeDir,
      `narration_tts_plan_validation_${episode}.json`,
    );
    await atomicWriteJson(validationPath, validation);
    console.log(JSON.stringify({
      status: validation.status,
      production_stage_passed: false,
      unit_count: units.length,
      validation_path: validationPath,
    }, null, 2));
    return;
  }

  await fs.mkdir(outputDir, { recursive: true });

  // The shared QA/stitch module reads these exact settings from process.argv at
  // import time. Insert defaults only when the operator did not supply them.
  const ensureArg = (name, value) => {
    if (!process.argv.includes(name)) process.argv.push(name, String(value));
  };
  const ensureExactNumericArg = (name, key, value) => {
    if (flags[key] != null && Math.abs(Number(flags[key]) - value) > 0.000001) {
      throw new Error(`${name} is production-locked to ${value}; got ${flags[key]}`);
    }
    ensureArg(name, value);
  };
  ensureArg("--episode-dir", episodeDir);
  ensureArg("--outDir", "narration_tts");
  ensureExactNumericArg("--unit-gap-sec", "unit-gap-sec", UNIT_GAP_SEC);
  ensureExactNumericArg("--segment-gap-sec", "segment-gap-sec", SEGMENT_GAP_SEC);
  ensureExactNumericArg("--stitch-sample-rate", "stitch-sample-rate", SAMPLE_RATE);
  ensureExactNumericArg("--stitch-edge-pad-sec", "stitch-edge-pad-sec", EDGE_PAD_SEC);
  ensureExactNumericArg("--stitch-fade-sec", "stitch-fade-sec", FADE_SEC);
  if (flags["unit-qa-whisper-model"] != null
    && String(flags["unit-qa-whisper-model"]) !== "small") {
    throw new Error("--unit-qa-whisper-model is production-locked to small");
  }
  ensureArg("--unit-qa-whisper-model", "small");
  const helpers = await import("./modelslab-qwen-episode-audio.mjs");

  const previousQa = await readJson(unitQaPath, null);
  const previousQaByAudioHash = new Map(
    (previousQa?.candidates ?? []).flatMap((candidate) => (
      candidate?.qa?.audio_sha256 ? [[candidate.qa.audio_sha256, candidate.qa]] : []
    )),
  );
  const candidates = [];
  const attemptEvents = [];
  const selected = new Map();

  const qaSynthesis = async (route, attempt, targetUnits) => {
    const provider = PRIMARY_TTS_PROVIDER;
    let synthesis;
    try {
      synthesis = await runSynthesis({
        route,
        attempt,
        units: targetUnits,
        policy,
        outputDir,
        python,
        runnerPath,
        invocationId,
      });
    } catch (error) {
      for (const unit of targetUnits) {
        const event = {
          schema: "goldflow_narration_tts_attempt_event_v1",
          invocation_id: invocationId,
          recorded_at: new Date().toISOString(),
          unit_id: unit.unit_id,
          provider,
          attempt,
          seed: deterministicTtsSeed(unit.unit_id, provider, attempt),
          spoken_text_sha256: unit.spoken_text_sha256,
          status: "synthesis_failed",
          error: error instanceof Error ? error.message : String(error),
        };
        attemptEvents.push(event);
        await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      }
      throw error;
    }
    const failedResults = synthesis.results.filter((result) => result.status === "failed");
    for (const result of failedResults) {
      const unit = targetUnits.find((row) => row.unit_id === result.unit_id);
      const qa = {
        status: "blocked",
        policy_version: QA_POLICY_VERSION,
        findings: [{
          severity: "blocker",
          code: "tts_synthesis_job_failed",
          error_type: result.error_type ?? null,
          error: result.error ?? "unknown per-unit synthesis failure",
        }],
      };
      const disposition = candidateDisposition(qa, provider);
      const candidate = {
        unit_id: result.unit_id,
        provider,
        model_id: result.model_id,
        voice_id: result.voice_id
          ?? policy.primary.voice_id,
        attempt,
        seed: result.seed,
        spoken_text_sha256: unit?.spoken_text_sha256 ?? result.spoken_text_sha256,
        synthesis_identity_sha256: result.synthesis_identity_sha256 ?? null,
        audio_path: null,
        audio_sha256: null,
        duration_sec: null,
        qa,
        disposition,
      };
      candidates.push(candidate);
      const { qa: candidateQa, ...eventCandidate } = candidate;
      const event = {
        schema: "goldflow_narration_tts_attempt_event_v1",
        invocation_id: invocationId,
        recorded_at: new Date().toISOString(),
        status: "synthesis_failed",
        ...eventCandidate,
        qa_status: candidateQa.status,
        qa_blocker_codes: candidateDisposition(candidateQa, provider).blocker_codes,
      };
      attemptEvents.push(event);
      await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    }
    const successfulResultById = new Map(
      synthesis.results
        .filter((result) => result.status !== "failed")
        .map((result) => [String(result.unit_id), result]),
    );
    const rows = targetUnits.flatMap((unit) => {
      const result = successfulResultById.get(unit.unit_id);
      if (!result) return [];
      return {
        ...unit,
        text: unit.spoken_text,
        segment_id: unit.segment_id
          ?? unit.source_segment_ids?.[0]
          ?? unit.inherited_segment_id
          ?? unit.unit_id,
        speaker: unit.speaker ?? "NARRATOR",
        voice_id: policy.primary.voice_id,
        provider,
        model_id: result.model_id,
        attempt,
        wav: result.output_path,
        duration_sec: result.duration_sec,
        synthesis_identity: result.synthesis_identity,
        synthesis_identity_sha256: result.synthesis_identity_sha256,
        unit_qa: previousQaByAudioHash.get(result.output_sha256) ?? null,
      };
    });
    await helpers.runUnitOutputQaForDiagnostics(rows);
    applyProtectedTermQa(rows);
    if (route === "qwen") {
      await applyQwenVoiceContinuityQa({
        rows,
        policy,
        outputDir,
        invocationId,
        attempt,
        similarityPython,
        similarityRunnerPath,
      });
    }
    for (const row of rows) row.unit_qa = softenPrimaryQa(row.unit_qa);
    for (const row of rows) {
      const result = synthesis.results.find((candidate) => candidate.unit_id === row.unit_id);
      const disposition = candidateDisposition(row.unit_qa, provider);
      const candidate = {
        unit_id: row.unit_id,
        provider,
        model_id: row.model_id,
        voice_id: row.voice_id,
        attempt,
        seed: result.seed,
        spoken_text_sha256: row.spoken_text_sha256,
        synthesis_identity_sha256: row.synthesis_identity_sha256,
        audio_path: row.wav,
        audio_sha256: result.output_sha256,
        duration_sec: row.duration_sec,
        voice_continuity: row.unit_qa?.voice_continuity ?? null,
        qa: row.unit_qa,
        disposition,
      };
      candidates.push(candidate);
      const { qa: candidateQa, ...eventCandidate } = candidate;
      const event = {
        schema: "goldflow_narration_tts_attempt_event_v1",
        invocation_id: invocationId,
        recorded_at: new Date().toISOString(),
        ...eventCandidate,
        status: disposition.status,
        qa_status: candidateQa?.status ?? null,
        qa_audio_sha256: candidateQa?.audio_sha256 ?? null,
        qa_blocker_codes: disposition.blocker_codes,
        qa_warning_codes: (candidateQa?.findings ?? [])
          .filter((finding) => finding.severity === "warning")
          .map((finding) => finding.code),
        confirmable_delivery_finding_codes:
          confirmableDeliveryFindingCodes(candidateQa),
        retry_requires_confirmed_listen:
          confirmableDeliveryFindingCodes(candidateQa).length > 0
          && disposition.accepted,
      };
      attemptEvents.push(event);
      await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      if (disposition.accepted && !selected.has(row.unit_id)) selected.set(row.unit_id, row);
    }
    return rows;
  };

  await qaSynthesis("qwen", 1, units);
  let unresolved = units.filter((unit) => !selected.has(unit.unit_id));
  const automaticRetryIds = new Set(
    candidates
      .filter((candidate) => (
        candidate.attempt === 1
        && candidate.disposition?.status === "confirmed_retry_required"
      ))
      .map((candidate) => String(candidate.unit_id)),
  );
  let recoveryScope = requestedRecoveryScope;
  if (requestedRecoveryScope) {
    const requestedIds = requestedRecoveryScope.requested_unit_ids;
    const evidencePath = path.resolve(flags["confirmed-retry-evidence"]);
    const evidence = await readJson(evidencePath, null);
    const validatedEvidence = validateConfirmedRetryEvidenceForTests({
      evidence,
      requestedUnitIds: requestedIds,
      planSha256,
      priorReport: priorNarrationReport,
      priorReportSha256: priorNarrationReportSha256,
      currentCandidates: candidates,
    });
    for (const unitId of requestedIds) selected.delete(unitId);
    for (const unitId of requestedIds) automaticRetryIds.add(unitId);
    unresolved = units.filter((unit) => !selected.has(unit.unit_id));
    recoveryScope = {
      ...requestedRecoveryScope,
      status: "validated_against_confirmed_listen_evidence",
      evidence_path: evidencePath,
      evidence_sha256: await sha256File(evidencePath),
      pre_retry_narration_report_sha256: priorNarrationReportSha256,
      confirmed_artifacts: validatedEvidence,
      primary_unresolved_unit_ids: unresolved.map((unit) => unit.unit_id),
    };
  }
  // Keep first takes unless synthesis objectively failed/returned empty or
  // too-short audio, or a hash-bound human listen confirms a skip,
  // truncation, or stutter. Other acoustic/identity blockers stop for review;
  // they never trigger an automatic regeneration.
  const automaticRetryUnits = units.filter(
    (unit) => automaticRetryIds.has(String(unit.unit_id)),
  );
  if (automaticRetryUnits.length) {
    await qaSynthesis("qwen", 2, automaticRetryUnits);
    unresolved = unresolved.filter((unit) => !selected.has(unit.unit_id));
  }

  const selectedRows = units.flatMap((unit) => {
    const row = selected.get(unit.unit_id);
    return row ? [row] : [];
  });
  const orderQa = validateSelectedUnitOrder(units, selectedRows);
  const unitQaReport = rebuildQaAggregate(
    candidates.map((candidate) => ({
      unit_id: candidate.unit_id,
      provider: candidate.provider,
      attempt: candidate.attempt,
      unit_qa: candidate.qa,
    })),
    candidates,
  );
  unitQaReport.source_script_hash = scriptHash;
  unitQaReport.narration_generation_plan_path = planPath;
  unitQaReport.narration_generation_plan_sha256 = planSha256;
  unitQaReport.selection_policy_version = NARRATION_TTS_SELECTION_POLICY_VERSION;
  unitQaReport.recovery_scope = recoveryScope;
  unitQaReport.selected_units = selectedRows.map((row) => ({
    unit_id: row.unit_id,
    provider: row.provider,
    voice_id: row.voice_id,
    voice_sha256: policy.primary.voice_sha256,
    voice_continuity_contract: policy.primary.voice_continuity_contract,
    attempt: row.attempt,
    spoken_text_sha256: row.spoken_text_sha256,
    synthesis_identity_sha256: row.synthesis_identity_sha256,
    audio_path: row.wav,
    audio_sha256: row.unit_qa.audio_sha256,
    qa: row.unit_qa,
  }));
  const selectedQaDecision = selectedQaDecisionForTests(selectedRows, {
    unresolvedUnitIds: unresolved.map((unit) => unit.unit_id),
    orderQa,
  });
  unitQaReport.selected_blocker_count = selectedQaDecision.selected_blockers.length;
  unitQaReport.selected_blockers = selectedQaDecision.selected_blockers;
  unitQaReport.status = selectedQaDecision.status;
  await atomicWriteJson(unitQaPath, unitQaReport);

  if (unresolved.length || orderQa.status !== "passed") {
    const blockers = selectedQaDecision.blockers;
    const statusContract = ttsStatusContract({
      policy,
      units,
      selectedRows,
      candidates,
      unitQaStatus: unitQaReport.status,
      fullStreamQaStatus: "not_run_due_to_unit_blockers",
    });
    await atomicWriteJson(fullQaPath, {
      schema: "goldflow_narration_full_stream_qa_v1",
      status: "not_run_due_to_unit_blockers",
      source_script_hash: scriptHash,
      narration_generation_plan_sha256: planSha256,
      recovery_scope: recoveryScope,
      blockers,
    });
    await atomicWriteJson(stitchReportPath, {
      schema: "goldflow_narration_stitch_report_v1",
      status: "blocked",
      source_script_hash: scriptHash,
      narration_generation_plan_path: planPath,
      narration_generation_plan_sha256: planSha256,
      recovery_scope: recoveryScope,
      primary_provider: policy.primary.provider,
      narrator_voice_id: policy.primary.voice_id,
      voice_sha256: policy.primary.voice_sha256,
      primary: {
        provider: policy.primary.provider,
        model_id: policy.primary.model_id,
        model_revision: policy.primary.model_revision,
        voice_id: policy.primary.voice_id,
        voice_sha256: policy.primary.voice_sha256,
        voice_continuity_contract: policy.primary.voice_continuity_contract,
      },
      native_speed: policy.primary.native_speed,
      post_tempo_normalized: false,
      stitch_qa_status: "not_run_due_to_unit_blockers",
      full_stream_qa_status: "not_run_due_to_unit_blockers",
      output_path: null,
      blockers,
    });
    await atomicWriteJson(reportPath, {
      schema: "goldflow_narration_tts_report_v1",
      status: "blocked",
      source_script_hash: scriptHash,
      narration_generation_plan_path: planPath,
      narration_generation_plan_sha256: planSha256,
      recovery_scope: recoveryScope,
      policy,
      ...statusContract,
      unit_qa_path: unitQaPath,
      full_stream_qa_path: fullQaPath,
      stitch_report_path: stitchReportPath,
      attempt_events_path: eventsPath,
      attempt_count: attemptEvents.length,
      selected_unit_count: selectedRows.length,
      fallback_selected_unit_ids: [],
      blockers,
    });
    process.exitCode = 1;
    return;
  }

  const finalWav = path.join(
    outputDir,
    `${episode}-narration-${policy.primary.voice_id}-primary.wav`,
  );
  const finalM4a = finalWav.replace(/\.wav$/, ".m4a");
  const stitchWorkingWav = path.join(
    outputDir,
    `.${path.basename(finalWav, ".wav")}.stitch-${invocationId}.wav`,
  );
  const stitch = await helpers.stitchWavsForDiagnostics(selectedRows, stitchWorkingWav);
  if (stitch?.status !== "passed") {
    const blockers = [
      ...(stitch?.prepared_qa?.blockers ?? []),
      ...(stitch?.boundary_qa?.blockers ?? []),
      ...(stitch?.final_qa?.blockers ?? []),
      ...(!stitch ? [{ code: "narration_tts_stitch_report_missing" }] : []),
    ];
    const fullStreamQaStatus = "not_run_due_to_stitch_blockers";
    const statusContract = ttsStatusContract({
      policy,
      units,
      selectedRows,
      candidates,
      unitQaStatus: unitQaReport.status,
      fullStreamQaStatus,
    });
    await atomicWriteJson(fullQaPath, {
      schema: "goldflow_narration_full_stream_qa_v1",
      status: fullStreamQaStatus,
      policy_version: QA_POLICY_VERSION,
      source_script_hash: scriptHash,
      narration_generation_plan_sha256: planSha256,
      recovery_scope: recoveryScope,
      blockers,
    });
    await atomicWriteJson(stitchReportPath, {
      schema: "goldflow_narration_stitch_report_v1",
      status: "blocked",
      source_script_hash: scriptHash,
      narration_generation_plan_path: planPath,
      narration_generation_plan_sha256: planSha256,
      recovery_scope: recoveryScope,
      primary_provider: policy.primary.provider,
      narrator_voice_id: policy.primary.voice_id,
      voice_sha256: policy.primary.voice_sha256,
      primary: {
        provider: policy.primary.provider,
        model_id: policy.primary.model_id,
        model_revision: policy.primary.model_revision,
        voice_id: policy.primary.voice_id,
        voice_sha256: policy.primary.voice_sha256,
        voice_continuity_contract: policy.primary.voice_continuity_contract,
      },
      native_speed: policy.primary.native_speed,
      post_tempo_normalized: false,
      stitch_qa_status: "blocked",
      full_stream_qa_status: fullStreamQaStatus,
      output_path: null,
      stitch_policy: stitch?.policy ?? null,
      boundary_qa: stitch?.boundary_qa ?? null,
      boundaries: stitch?.boundaries ?? [],
      blockers,
    });
    await atomicWriteJson(reportPath, {
      schema: "goldflow_narration_tts_report_v1",
      status: "blocked",
      source_script_hash: scriptHash,
      narration_generation_plan_path: planPath,
      narration_generation_plan_sha256: planSha256,
      recovery_scope: recoveryScope,
      policy,
      ...statusContract,
      unit_qa_path: unitQaPath,
      full_stream_qa_path: fullQaPath,
      stitch_report_path: stitchReportPath,
      attempt_events_path: eventsPath,
      attempt_count: attemptEvents.length,
      blockers,
    });
    console.error(`Narration stitch QA blocked: ${JSON.stringify(blockers)}`);
    process.exitCode = 1;
    return;
  }
  await fs.rename(stitchWorkingWav, finalWav);
  if (stitch.final_qa) stitch.final_qa.audio_path = finalWav;
  for (const prepared of stitch.prepared_inputs ?? []) {
    prepared.sample_count = await wavSampleCount(prepared.prepared_wav);
  }
  for (const boundary of stitch.boundaries ?? []) {
    boundary.gap_sample_count = boundary.gap_wav
      ? await wavSampleCount(boundary.gap_wav)
      : 0;
  }
  const finalPcm = await runBinary("ffmpeg", [
    "-nostdin", "-v", "error",
    "-i", finalWav,
    "-map", "0:a:0",
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-f", "s16le",
    "pipe:1",
  ]);
  const samples = new Int16Array(Math.floor(finalPcm.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = finalPcm.readInt16LE(index * 2);
  }
  const joinQa = joinQaFromPcmForTests(
    samples,
    SAMPLE_RATE,
    stitch.prepared_inputs,
    stitch.boundaries,
  );
  // Transcript fidelity is verified once by the mandatory
  // local_whisper_word_timing stage on this exact stitched audio. Repeating a
  // medium-Whisper pass here adds latency without producing the timing
  // artifact consumed downstream.
  const fullRecognized = null;
  const intendedText = selectedRows.map((row) => row.text).join(" ");
  const allEquivalences = selectedRows.flatMap(equivalentPhrasesForTests);
  const fullTranscriptQa = fullRecognized
    ? helpers.transcriptQaForTests(intendedText, fullRecognized.text, {
      maxWer: 0.05,
      equivalentPhrases: allEquivalences,
      blockAnySubstitution: false,
    })
    : null;
  if (fullTranscriptQa && fullRecognized) {
    const protectedFindings = selectedRows.flatMap((row) => (
      protectedTermFindingsForTests(row, fullRecognized.text)
    ));
    fullTranscriptQa.findings.push(...protectedFindings);
  }
  const streamDecision = fullStreamDecision(fullTranscriptQa, {
    orderQa,
    joinQa,
    maximumWer: 0.05,
    transcriptDeferred: true,
  });
  const fullQaReport = {
    schema: "goldflow_narration_full_stream_qa_v1",
    status: streamDecision.status,
    policy_version: QA_POLICY_VERSION,
    source_script_hash: scriptHash,
    narration_generation_plan_sha256: planSha256,
    recovery_scope: recoveryScope,
    audio_path: finalWav,
    audio_sha256: await sha256File(finalWav),
    intended_text_sha256: sha256Text(intendedText),
    whisper_model: null,
    transcript_verification_stage: "local_whisper_word_timing",
    recognized_text: fullRecognized?.text ?? null,
    recognized_words: fullRecognized?.words ?? [],
    transcript_qa: fullTranscriptQa,
    order_qa: orderQa,
    join_qa: joinQa,
    blockers: streamDecision.blockers,
    warnings: streamDecision.warnings,
  };
  await atomicWriteJson(fullQaPath, fullQaReport);
  if (fullQaReport.status === "passed") {
    const m4aWorkingPath = path.join(
      outputDir,
      `.${path.basename(finalM4a, ".m4a")}.encode-${invocationId}.m4a`,
    );
    await run("ffmpeg", [
      "-y", "-nostdin", "-v", "error",
      "-i", finalWav,
      "-c:a", "aac",
      "-b:a", "160k",
      "-ar", String(SAMPLE_RATE),
      "-ac", "1",
      m4aWorkingPath,
    ]);
    await fs.rename(m4aWorkingPath, finalM4a);
  }
  const finalWavSha256 = await sha256File(finalWav);
  const finalM4aSha256 = fullQaReport.status === "passed"
    ? await sha256File(finalM4a)
    : null;
  const preparedById = new Map(stitch.prepared_inputs.map((row) => [String(row.unit_id), row]));
  const boundaryById = new Map(stitch.boundaries.map((row) => [String(row.after_unit_id), row]));
  const segments = selectedRows.map((row, index) => {
    const prepared = preparedById.get(row.unit_id);
    const boundary = boundaryById.get(row.unit_id);
    return {
      unit_id: row.unit_id,
      segment_id: row.segment_id,
      text: row.text,
      caption_text: row.caption_text,
      source_segment_ids: row.source_segment_ids,
      source_unit_refs: row.source_unit_refs,
      tts_provider: row.provider,
      model_id: row.model_id,
      voice_id: row.voice_id,
      voice_sha256: policy.primary.voice_sha256,
      voice_continuity_contract: policy.primary.voice_continuity_contract,
      voice_continuity: row.unit_qa?.voice_continuity ?? null,
      native_speed: null,
      fallback_used: false,
      post_tempo_processed: false,
      raw_audio_path: row.wav,
      raw_audio_sha256: row.unit_qa.audio_sha256,
      prepared_audio_path: prepared?.prepared_wav ?? null,
      prepared_audio_sha256: prepared?.prepared_audio_sha256 ?? null,
      prepared_sample_count: prepared?.sample_count ?? null,
      prepared_leading_silence_sample_count:
        prepared?.prepared_qa?.metrics?.leading_silence_sample_count ?? null,
      prepared_trailing_silence_sample_count:
        prepared?.prepared_qa?.metrics?.trailing_silence_sample_count ?? null,
      boundary_after_effective_gap_sample_count:
        boundary?.effective_gap_sample_count ?? null,
      duration_sec: Number((
        Number(prepared?.prepared_duration_sec ?? row.duration_sec)
        + (index < selectedRows.length - 1 ? Number(boundary?.inserted_silence_sec ?? 0) : 0)
      ).toFixed(6)),
      unit_qa: row.unit_qa,
    };
  });
  const status = fullQaReport.status === "passed" ? "passed" : "blocked";
  const statusContract = ttsStatusContract({
    policy,
    units,
    selectedRows,
    candidates,
    unitQaStatus: unitQaReport.status,
    fullStreamQaStatus: fullQaReport.status,
  });
  await atomicWriteJson(stitchReportPath, {
    schema: "goldflow_narration_stitch_report_v1",
    status,
    provider: "qwen3_tts_1_7b_base_liam_unit_stitch",
    primary_provider: policy.primary.provider,
    narrator_voice_id: policy.primary.voice_id,
    voice_sha256: policy.primary.voice_sha256,
    primary: {
      provider: policy.primary.provider,
      model_id: policy.primary.model_id,
      model_revision: policy.primary.model_revision,
      voice_id: policy.primary.voice_id,
      voice_sha256: policy.primary.voice_sha256,
      voice_continuity_contract: policy.primary.voice_continuity_contract,
    },
    native_speed: policy.primary.native_speed,
    post_tempo_normalized: false,
    source_script_hash: scriptHash,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: planSha256,
    recovery_scope: recoveryScope,
    output_path: status === "passed" ? finalWav : null,
    output_sha256: status === "passed" ? finalWavSha256 : null,
    blocked_output_path: status === "blocked" ? finalWav : null,
    blocked_output_sha256: status === "blocked" ? finalWavSha256 : null,
    final_m4a_path: status === "passed" ? finalM4a : null,
    final_m4a_sha256: finalM4aSha256,
    final_duration_sec: Number(stitch.final_qa?.metrics?.duration_sec ?? 0),
    unit_gap_sec: UNIT_GAP_SEC,
    segment_gap_sec: SEGMENT_GAP_SEC,
    stitch_sample_rate: SAMPLE_RATE,
    stitch_edge_pad_sec: EDGE_PAD_SEC,
    stitch_fade_sec: FADE_SEC,
    unit_qa_policy_version: QA_POLICY_VERSION,
    stitch_policy_version: STITCH_POLICY_VERSION,
    stitch_policy: stitch.policy,
    boundary_qa: stitch.boundary_qa,
    boundaries: stitch.boundaries,
    stitch_qa_status: joinQa.status,
    full_stream_qa_status: fullQaReport.status,
    join_qa: joinQa,
    warnings: joinQa.warnings ?? [],
    full_stream_qa_path: fullQaPath,
    segments,
  });
  await atomicWriteJson(reportPath, {
    schema: "goldflow_narration_tts_report_v1",
    status,
    generated_at: new Date().toISOString(),
    source_script_hash: scriptHash,
    run_identity_path: identityPath,
    narration_generation_plan_path: planPath,
    narration_generation_plan_sha256: planSha256,
    recovery_scope: recoveryScope,
    policy,
    ...statusContract,
    selection_policy_version: NARRATION_TTS_SELECTION_POLICY_VERSION,
    qa_policy: QA_POLICY_VERSION,
    qa_policy_version: QA_POLICY_VERSION,
    stitch_policy_version: STITCH_POLICY_VERSION,
    unit_count: units.length,
    selected_primary_unit_count: selectedRows.filter((row) => row.provider === PRIMARY_TTS_PROVIDER).length,
    selected_fallback_unit_count: 0,
    fallback_selected_unit_ids: [],
    fallback_scope_policy: "no_alternate_provider_or_voice",
    retry_scope_policy: "same_qwen_liam_exact_unit_only_after_confirmed_delivery_defect",
    attempt_events_path: eventsPath,
    attempt_count: attemptEvents.length,
    unit_qa_path: unitQaPath,
    unit_qa_status: unitQaReport.status,
    full_stream_qa_path: fullQaPath,
    full_stream_qa_status: fullQaReport.status,
    stitch_report_path: stitchReportPath,
    final_wav: status === "passed" ? finalWav : null,
    final_wav_sha256: status === "passed" ? finalWavSha256 : null,
    final_m4a: status === "passed" ? finalM4a : null,
    final_m4a_sha256: finalM4aSha256,
    blockers: fullQaReport.blockers,
    warnings: fullQaReport.warnings,
    warning_count: fullQaReport.warnings.length,
  });
  console.log(JSON.stringify({
    status,
    unit_count: units.length,
    fallback_unit_count: 0,
    final_m4a: status === "passed" ? finalM4a : null,
    report_path: reportPath,
  }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
