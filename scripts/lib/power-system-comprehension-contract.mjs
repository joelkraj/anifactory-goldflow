import { createHash } from "node:crypto";

export const POWER_SYSTEM_COMPREHENSION_SCHEMA = "goldflow_power_system_comprehension_audit_v1";
export const POWER_SYSTEM_COMPREHENSION_MAX_ABILITIES = 64;

const COVERAGE_DECLARATION = "all_power_abilities_and_evolutions_in_script";
const REVIEW_SCOPE = "complete_script";
const LIMIT_CLASSIFICATIONS = new Set([
  "explicit_limit",
  "explicit_cost",
  "explicit_limit_and_cost",
  "explicitly_unbounded",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(clean(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function push(blockers, condition, code, abilityId = null, field = null, detail = null) {
  if (!condition) return;
  blockers.push({ code, ...(abilityId ? { ability_id: abilityId } : {}), ...(field ? { field } : {}), ...(detail ? { detail } : {}) });
}

function validateSummary(value, blockers, abilityId, field) {
  const text = clean(value);
  push(blockers, !text, "power_audit_summary_missing", abilityId, field);
  push(blockers, text.length > 600, "power_audit_summary_too_long", abilityId, field);
}

function validateAnchor(anchor, script, blockers, abilityId, field) {
  const exactExcerpt = clean(anchor?.exact_excerpt);
  const start = Number(anchor?.start_offset);
  const end = Number(anchor?.end_offset);
  push(blockers, !exactExcerpt, "power_audit_exact_excerpt_missing", abilityId, field);
  push(blockers, exactExcerpt.length > 600, "power_audit_exact_excerpt_too_long", abilityId, field);
  push(blockers, !Number.isInteger(start) || start < 0, "power_audit_start_offset_invalid", abilityId, field);
  push(blockers, !Number.isInteger(end) || end <= start, "power_audit_end_offset_invalid", abilityId, field);
  if (exactExcerpt && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start) {
    push(blockers, script.slice(start, end) !== exactExcerpt, "power_audit_exact_excerpt_mismatch", abilityId, field);
  }
  return { start, end, exactExcerpt };
}

function validateEvidenceClaim(claim, script, blockers, abilityId, field, payoffStart) {
  validateSummary(claim?.summary, blockers, abilityId, `${field}.summary`);
  const evidence = Array.isArray(claim?.evidence) ? claim.evidence : [];
  push(blockers, evidence.length < 1, "power_audit_claim_evidence_missing", abilityId, `${field}.evidence`);
  push(blockers, evidence.length > 4, "power_audit_claim_evidence_exceeds_limit", abilityId, `${field}.evidence`);
  for (let index = 0; index < Math.min(evidence.length, 4); index += 1) {
    const anchor = validateAnchor(evidence[index], script, blockers, abilityId, `${field}.evidence[${index}]`);
    if (Number.isInteger(anchor.end) && Number.isInteger(payoffStart)) {
      push(blockers, anchor.end > payoffStart, "power_audit_mechanic_explained_after_payoff", abilityId, `${field}.evidence[${index}]`);
    }
  }
}

function detectLineageCycles(abilities, blockers) {
  const parents = new Map(abilities.map((ability) => [clean(ability?.ability_id), clean(ability?.lineage?.parent_ability_id)]));
  for (const abilityId of parents.keys()) {
    const seen = new Set();
    let cursor = abilityId;
    while (cursor) {
      if (seen.has(cursor)) {
        push(blockers, true, "power_audit_evolution_lineage_cycle", abilityId, "lineage.parent_ability_id");
        break;
      }
      seen.add(cursor);
      cursor = parents.get(cursor) ?? "";
    }
  }
}

export function validatePowerSystemComprehensionAudit(document, script) {
  const blockers = [];
  const warnings = [];
  const scriptHash = sha256(script);
  const abilities = Array.isArray(document?.abilities) ? document.abilities : [];

  push(blockers, document?.schema !== POWER_SYSTEM_COMPREHENSION_SCHEMA, "power_audit_schema_invalid");
  push(blockers, document?.review_scope !== REVIEW_SCOPE, "power_audit_review_scope_invalid");
  push(blockers, document?.coverage_declaration !== COVERAGE_DECLARATION, "power_audit_coverage_declaration_missing");
  push(blockers, document?.source_script_hash !== scriptHash, "power_audit_source_script_hash_mismatch");
  push(blockers, !clean(document?.reviewed_by), "power_audit_reviewer_missing");
  push(blockers, typeof document?.power_system_present !== "boolean", "power_audit_presence_declaration_invalid");
  push(blockers, abilities.length > POWER_SYSTEM_COMPREHENSION_MAX_ABILITIES, "power_audit_ability_count_exceeds_limit");

  if (document?.power_system_present === false) {
    push(blockers, abilities.length !== 0, "power_audit_non_power_story_has_abilities");
    push(blockers, !clean(document?.no_power_system_rationale), "power_audit_non_power_rationale_missing");
  } else if (document?.power_system_present === true) {
    push(blockers, abilities.length < 1, "power_audit_power_story_has_no_abilities");
  }

  const ids = new Set();
  const names = new Set();
  const firstMentionById = new Map();
  for (let index = 0; index < Math.min(abilities.length, POWER_SYSTEM_COMPREHENSION_MAX_ABILITIES); index += 1) {
    const ability = abilities[index];
    const abilityId = clean(ability?.ability_id);
    const name = clean(ability?.name);
    push(blockers, !/^[a-z0-9][a-z0-9_-]{1,79}$/.test(abilityId), "power_audit_ability_id_invalid", abilityId || `index_${index}`);
    push(blockers, ids.has(abilityId), "power_audit_duplicate_ability_id", abilityId);
    push(blockers, !name, "power_audit_ability_name_missing", abilityId);
    push(blockers, name.length > 160, "power_audit_ability_name_too_long", abilityId);
    push(blockers, names.has(name.toLowerCase()), "power_audit_duplicate_ability_name", abilityId);
    ids.add(abilityId);
    names.add(name.toLowerCase());

    const firstMention = validateAnchor(ability?.first_mention, script, blockers, abilityId, "first_mention");
    const firstUse = validateAnchor(ability?.first_use, script, blockers, abilityId, "first_use");
    const firstPayoff = validateAnchor(ability?.first_payoff, script, blockers, abilityId, "first_payoff");
    firstMentionById.set(abilityId, firstMention.start);
    if (firstMention.exactExcerpt && Number.isInteger(firstMention.start)) {
      push(blockers, script.indexOf(firstMention.exactExcerpt) !== firstMention.start, "power_audit_first_mention_not_earliest_exact_excerpt", abilityId, "first_mention");
    }
    if (Number.isInteger(firstMention.start) && Number.isInteger(firstUse.start)) {
      push(blockers, firstMention.start > firstUse.start, "power_audit_first_use_precedes_first_mention", abilityId);
    }
    if (Number.isInteger(firstUse.start) && Number.isInteger(firstPayoff.start)) {
      push(blockers, firstUse.start > firstPayoff.start, "power_audit_payoff_precedes_first_use", abilityId);
    }

    validateEvidenceClaim(ability?.trigger, script, blockers, abilityId, "trigger", firstPayoff.start);
    validateEvidenceClaim(ability?.capability, script, blockers, abilityId, "capability", firstPayoff.start);
    validateEvidenceClaim(ability?.limitation_or_cost, script, blockers, abilityId, "limitation_or_cost", firstPayoff.start);
    push(blockers, !LIMIT_CLASSIFICATIONS.has(clean(ability?.limitation_or_cost?.classification)), "power_audit_limit_classification_invalid", abilityId, "limitation_or_cost.classification");
    push(blockers, ability?.viewer_understands_before_payoff !== true, "power_audit_viewer_understanding_not_confirmed", abilityId, "viewer_understands_before_payoff");
    validateSummary(ability?.viewer_comprehension_summary, blockers, abilityId, "viewer_comprehension_summary");

    const lineageKind = clean(ability?.lineage?.kind);
    const parentId = clean(ability?.lineage?.parent_ability_id);
    push(blockers, !["base", "evolution"].includes(lineageKind), "power_audit_lineage_kind_invalid", abilityId, "lineage.kind");
    if (lineageKind === "base") {
      push(blockers, Boolean(parentId), "power_audit_base_ability_has_parent", abilityId, "lineage.parent_ability_id");
      push(blockers, ability?.lineage?.evolution_trigger != null, "power_audit_base_ability_has_evolution_trigger", abilityId, "lineage.evolution_trigger");
    } else if (lineageKind === "evolution") {
      push(blockers, !parentId, "power_audit_evolution_parent_missing", abilityId, "lineage.parent_ability_id");
      push(blockers, parentId === abilityId, "power_audit_evolution_self_parent", abilityId, "lineage.parent_ability_id");
      validateEvidenceClaim(ability?.lineage?.evolution_trigger, script, blockers, abilityId, "lineage.evolution_trigger", firstPayoff.start);
    }
  }

  for (const ability of abilities.slice(0, POWER_SYSTEM_COMPREHENSION_MAX_ABILITIES)) {
    const abilityId = clean(ability?.ability_id);
    const parentId = clean(ability?.lineage?.parent_ability_id);
    if (clean(ability?.lineage?.kind) !== "evolution" || !parentId) continue;
    push(blockers, !ids.has(parentId), "power_audit_evolution_parent_unknown", abilityId, "lineage.parent_ability_id");
    const parentStart = firstMentionById.get(parentId);
    const childStart = firstMentionById.get(abilityId);
    if (Number.isInteger(parentStart) && Number.isInteger(childStart)) {
      push(blockers, parentStart >= childStart, "power_audit_evolution_precedes_parent", abilityId, "lineage.parent_ability_id");
    }
  }
  detectLineageCycles(abilities, blockers);

  return {
    schema: "goldflow_power_system_comprehension_validation_v1",
    status: blockers.length ? "blocked" : "passed",
    source_script_hash: scriptHash,
    checked_ability_count: abilities.length,
    blockers,
    warnings,
  };
}

export function materializePowerSystemComprehensionAudit(candidate, script, { sourceScriptPath, reviewedBy, reviewedAt = new Date().toISOString() } = {}) {
  const document = {
    schema: POWER_SYSTEM_COMPREHENSION_SCHEMA,
    status: "pending_validation",
    source_script_path: sourceScriptPath ?? null,
    source_script_hash: sha256(script),
    review_scope: REVIEW_SCOPE,
    coverage_declaration: COVERAGE_DECLARATION,
    power_system_present: candidate?.power_system_present,
    no_power_system_rationale: candidate?.no_power_system_rationale ?? null,
    reviewed_by: reviewedBy ?? candidate?.reviewed_by ?? null,
    reviewed_at: reviewedAt,
    abilities: Array.isArray(candidate?.abilities) ? candidate.abilities : [],
  };
  const validation = validatePowerSystemComprehensionAudit(document, script);
  return {
    ...document,
    status: validation.status,
    ability_count: document.abilities.length,
    validation,
  };
}
