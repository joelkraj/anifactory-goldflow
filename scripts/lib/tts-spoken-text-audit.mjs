import { createHash } from "node:crypto";

export const TTS_SPOKEN_TEXT_AUDIT_SCHEMA = "goldflow_tts_spoken_text_audit_v1";

const APPROVED_INITIALISMS = new Set([
  "AI", "AOE", "API", "CEO", "CFO", "CIO", "CMO", "COO", "CTO",
  "DPS", "FBI", "HP", "HR", "IRS", "LLC", "MP", "NDA", "NYPD",
  "PR", "SEC", "UI", "UX", "XP",
]);

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["generated_at", "audit_sha256"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function ttsSpokenTextAuditSha256(audit) {
  return sha256(JSON.stringify(canonicalize(audit)));
}

function words(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean);
}

function unitsFromPlan(plan = {}) {
  if (Array.isArray(plan.units) && plan.units.length) return plan.units;
  return (plan.segments ?? []).flatMap((segment) => (
    segment?.generation_units
      ?? segment?.narration_generation_units
      ?? segment?.narration_units
      ?? segment?.qwen_generation_units
      ?? []
  ));
}

function isAtomicUnit(unit = {}) {
  return /^(?:dialogue|system|interface)$/i.test(String(unit.kind ?? ""))
    || /^SYSTEM$/i.test(String(unit.source_speaker ?? unit.speaker ?? ""))
    || unit.merge_barrier === true
    || unit.risk_flags?.includes?.("system_ui_atomic")
    || unit.risk_flags?.includes?.("speaker_or_performance_turn");
}

function hasTerminalPunctuation(value) {
  return /[.!?…][\"'”’)}\]]*$/.test(String(value ?? "").trim());
}

function ordinaryItPronounAppears(sourceText) {
  const source = String(sourceText ?? "");
  const technical = /\bIT\s+(?:department|team|support|system|systems|staff|manager|worker|workers|specialist|specialists|infrastructure|security|network|networks|operations|services?|industry|career|job|jobs)\b/i;
  return /\bIT\b/.test(source) && !technical.test(source);
}

function expandedInitialisms(value) {
  const matches = String(value ?? "").matchAll(/\b(?:[A-Z]\s+){1,7}[A-Z]\b/g);
  return [...matches].map((match) => ({
    rendered: match[0],
    compact: match[0].replace(/\s+/g, ""),
  }));
}

export function buildTtsSpokenTextAudit({
  plan,
  sourceScriptSha256,
  sourceScriptPath = null,
  overridesSha256 = null,
  planPath = null,
  provider = null,
  voiceId = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const units = unitsFromPlan(plan);
  const blockers = [];
  const warnings = [];
  const seenIds = new Set();
  const unitContracts = [];

  for (const unit of units) {
    const unitId = String(unit?.unit_id ?? "").trim();
    const sourceText = String(unit?.source_text ?? "").trim();
    const captionText = String(unit?.caption_text ?? "").trim();
    const spokenText = String(
      unit?.spoken_text ?? unit?.tts_spoken_text ?? unit?.qwen_spoken_text ?? "",
    ).trim();
    const spokenWordCount = words(spokenText).length;
    const atomic = isAtomicUnit(unit);
    const unitBlockers = [];
    const unitWarnings = [];

    if (!unitId) unitBlockers.push("missing_unit_id");
    else if (seenIds.has(unitId)) unitBlockers.push("duplicate_unit_id");
    else seenIds.add(unitId);
    if (!sourceText) unitBlockers.push("missing_source_text");
    if (!captionText) unitBlockers.push("missing_caption_text");
    if (!spokenText) unitBlockers.push("missing_spoken_text");
    if (/[<]?[|]speaker:\d+[|]?>/i.test(spokenText) || /\[[^\]\n]+\]/.test(spokenText)) {
      unitBlockers.push("production_or_stage_tag_leaked_into_spoken_text");
    }
    if (/\d/.test(spokenText)) unitBlockers.push("unresolved_numeric_digit_in_spoken_text");
    if (spokenText && !hasTerminalPunctuation(spokenText)) {
      unitBlockers.push("spoken_text_missing_terminal_punctuation");
    }
    if (spokenWordCount > 60) unitBlockers.push("spoken_text_exceeds_60_word_hard_maximum");
    if (!atomic && spokenWordCount > 0 && spokenWordCount < 45) {
      unitWarnings.push("narration_unit_below_45_word_target");
    }
    if (ordinaryItPronounAppears(sourceText) && /\bI\s+T\b/.test(spokenText)) {
      unitBlockers.push("ordinary_it_pronoun_expanded_as_initialism");
    }
    for (const initialism of expandedInitialisms(spokenText)) {
      if (initialism.compact === "IT" && !ordinaryItPronounAppears(sourceText)) continue;
      if (APPROVED_INITIALISMS.has(initialism.compact)) continue;
      if (/^[A-SS-Z]{1,3}$/.test(initialism.compact) && /\brank\b/i.test(spokenText)) continue;
      unitWarnings.push(`unregistered_spoken_initialism:${initialism.compact}`);
    }

    const contract = {
      unit_id: unitId || null,
      kind: unit?.kind ?? null,
      source_text_sha256: sourceText ? sha256(sourceText) : null,
      caption_text_sha256: captionText ? sha256(captionText) : null,
      spoken_text_sha256: spokenText ? sha256(spokenText) : null,
      spoken_word_count: spokenWordCount,
      atomic_unit: atomic,
      blockers: unitBlockers,
      warnings: [...new Set(unitWarnings)],
    };
    unitContracts.push(contract);
    blockers.push(...unitBlockers.map((code) => ({ code, unit_id: unitId || null })));
    warnings.push(...contract.warnings.map((code) => ({ code, unit_id: unitId || null })));
  }

  if (!units.length) blockers.push({ code: "narration_plan_contains_no_units", unit_id: null });
  const unitContractSha256 = sha256(JSON.stringify(unitContracts));
  const audit = {
    schema: TTS_SPOKEN_TEXT_AUDIT_SCHEMA,
    status: blockers.length ? "blocked" : "passed",
    generated_at: generatedAt,
    provider,
    voice_id: voiceId,
    source_script_path: sourceScriptPath,
    source_script_sha256: sourceScriptSha256 ?? null,
    tts_spoken_overrides_sha256: overridesSha256 ?? null,
    narration_generation_plan_path: planPath,
    unit_count: units.length,
    unit_contract_sha256: unitContractSha256,
    policy: {
      captions_and_spoken_text_are_separate: true,
      target_spoken_words: "45-60 for ordinary narration; shorter atomic system/dialogue and hard-boundary units are valid",
      hard_spoken_words_max: 60,
      unresolved_digits_allowed: false,
      context_aware_initialisms_required: true,
      provider_mixing_allowed: false,
    },
    blocker_count: blockers.length,
    warning_count: warnings.length,
    blockers,
    warnings,
    units: unitContracts,
  };
  audit.audit_sha256 = ttsSpokenTextAuditSha256(audit);
  return audit;
}

export function ttsSpokenTextAuditMatches({ audit, plan, sourceScriptSha256, overridesSha256 = null } = {}) {
  if (audit?.schema !== TTS_SPOKEN_TEXT_AUDIT_SCHEMA || audit?.status !== "passed") return false;
  if (audit.audit_sha256 !== ttsSpokenTextAuditSha256(audit)) return false;
  if (audit.source_script_sha256 !== sourceScriptSha256) return false;
  if ((audit.tts_spoken_overrides_sha256 ?? null) !== (overridesSha256 ?? null)) return false;
  const expected = buildTtsSpokenTextAudit({
    plan,
    sourceScriptSha256,
    overridesSha256,
    sourceScriptPath: audit.source_script_path ?? null,
    planPath: audit.narration_generation_plan_path ?? null,
    provider: audit.provider ?? null,
    voiceId: audit.voice_id ?? null,
    generatedAt: audit.generated_at,
  });
  return audit.unit_contract_sha256 === expected.unit_contract_sha256
    && audit.unit_count === expected.unit_count;
}
