import { createHash } from "node:crypto";
import {
  compileProviderSafeSpokenText,
  PROVIDER_SAFE_SPOKEN_COMPILER_ID,
  removeKnownProductionTags,
  stripBalancedOuterDialogueQuotes,
} from "./narration-spoken-text.mjs";

export const NARRATION_TEXT_IR_SCHEMA = "goldflow_narration_text_ir_v2";

const APPROVED_TRANSFORMATION_STAGES = new Set([
  "remove_machine_speaker_tags",
  "remove_known_production_tags",
  "normalize_whitespace",
  "strip_balanced_outer_dialogue_quotes",
  "apply_approved_spoken_overrides",
  "apply_pronunciation_map",
  "normalize_post_map_whitespace",
  "compile_provider_safe_spoken_text",
  "normalize_atomic_spoken_terminal",
  "llm_authored_punctuation_only_direction",
]);

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function spokenTextLineageSha256(value) {
  const copy = structuredClone(value ?? {});
  delete copy.lineage_sha256;
  return sha256(JSON.stringify(copy));
}

function exactTokens(value) {
  return narrationTokensWithSpans(value).map((token) => token.normalized);
}

function applyReplacementReceipt(beforeText, rows = [], kind = "override") {
  let next = String(beforeText ?? "");
  for (const row of rows) {
    const from = kind === "pronunciation" ? row?.term : row?.from;
    const to = kind === "pronunciation" ? row?.spoken : row?.to;
    if (!from || typeof to !== "string") return null;
    try {
      const pattern = kind === "pronunciation" || row?.regex !== true
        ? new RegExp(String(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), kind === "pronunciation" ? "g" : String(row?.flags ?? "g"))
        : new RegExp(String(from), String(row?.flags ?? "g"));
      next = next.replace(pattern, to);
    } catch {
      return null;
    }
  }
  return next;
}

function expectedReceiptAfterText(receipt) {
  const before = String(receipt?.before_text ?? "");
  switch (receipt?.stage) {
    case "remove_machine_speaker_tags":
      return before.replace(/<\|speaker:\d+\|>/g, " ");
    case "remove_known_production_tags":
      return removeKnownProductionTags(before).text;
    case "normalize_whitespace":
    case "normalize_post_map_whitespace":
      return before.replace(/\s+/g, " ").trim();
    case "strip_balanced_outer_dialogue_quotes":
      return stripBalancedOuterDialogueQuotes(before);
    case "apply_approved_spoken_overrides":
      return applyReplacementReceipt(before, receipt.applied_replacements, "override");
    case "apply_pronunciation_map":
      return applyReplacementReceipt(before, receipt.applied_pronunciations, "pronunciation");
    case "compile_provider_safe_spoken_text":
      return receipt.compiler_id === PROVIDER_SAFE_SPOKEN_COMPILER_ID
        ? compileProviderSafeSpokenText(before)
        : null;
    case "normalize_atomic_spoken_terminal":
    case "llm_authored_punctuation_only_direction":
      return exactTokens(before).join("\u0000") === exactTokens(receipt?.after_text).join("\u0000")
        ? String(receipt?.after_text ?? "")
        : null;
    default:
      return null;
  }
}

function fallbackSpokenTextLineage(unit, sourceText, spokenText, receipts) {
  const lineage = {
    schema: "goldflow_spoken_text_lineage_v1",
    policy: "Compatibility lineage synthesized from one source component.",
    components: [{
      source_unit_id: unit.unit_id ?? null,
      source_text: sourceText,
      source_text_sha256: sha256(sourceText),
      compiled_spoken_text: spokenText,
      compiled_spoken_text_sha256: sha256(spokenText),
      transformation_receipts: structuredClone(receipts),
    }],
    pre_direction_spoken_text: spokenText,
    pre_direction_spoken_text_sha256: sha256(spokenText),
    final_transformations: [],
    final_spoken_text: spokenText,
    final_spoken_text_sha256: sha256(spokenText),
  };
  return { ...lineage, lineage_sha256: spokenTextLineageSha256(lineage) };
}

export function narrationTextIrSha256(value) {
  const copy = structuredClone(value ?? {});
  delete copy.ir_sha256;
  return sha256(JSON.stringify(copy));
}

export function narrationTokensWithSpans(value) {
  const text = String(value ?? "").normalize("NFKC");
  const matcher = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
  const rows = [];
  for (const match of text.matchAll(matcher)) {
    rows.push({
      text: match[0],
      normalized: match[0].toLocaleLowerCase("en-US").replaceAll("’", "'"),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return rows;
}

function tokenAlignment(sourceTokens, spokenTokens) {
  const rows = sourceTokens.length + 1;
  const columns = spokenTokens.length + 1;
  const cost = Array.from({ length: rows }, () => Array(columns).fill(0));
  const move = Array.from({ length: rows }, () => Array(columns).fill(null));
  for (let left = 1; left < rows; left += 1) {
    cost[left][0] = left;
    move[left][0] = "delete";
  }
  for (let right = 1; right < columns; right += 1) {
    cost[0][right] = right;
    move[0][right] = "insert";
  }
  for (let left = 1; left < rows; left += 1) {
    for (let right = 1; right < columns; right += 1) {
      const equal = sourceTokens[left - 1].normalized === spokenTokens[right - 1].normalized;
      const options = [
        { value: cost[left - 1][right - 1] + (equal ? 0 : 1), move: equal ? "equal" : "replace" },
        { value: cost[left - 1][right] + 1, move: "delete" },
        { value: cost[left][right - 1] + 1, move: "insert" },
      ].sort((a, b) => a.value - b.value || ["equal", "replace", "delete", "insert"].indexOf(a.move) - ["equal", "replace", "delete", "insert"].indexOf(b.move));
      cost[left][right] = options[0].value;
      move[left][right] = options[0].move;
    }
  }
  const operations = [];
  let left = sourceTokens.length;
  let right = spokenTokens.length;
  while (left > 0 || right > 0) {
    const operation = move[left][right];
    if (operation === "equal" || operation === "replace") {
      operations.push({
        operation,
        source_token: sourceTokens[left - 1],
        spoken_token: spokenTokens[right - 1],
      });
      left -= 1;
      right -= 1;
    } else if (operation === "delete") {
      operations.push({ operation, source_token: sourceTokens[left - 1], spoken_token: null });
      left -= 1;
    } else {
      operations.push({ operation: "insert", source_token: null, spoken_token: spokenTokens[right - 1] });
      right -= 1;
    }
  }
  return { distance: cost.at(-1).at(-1), operations: operations.reverse() };
}

function punctuationSignature(value) {
  return [...String(value ?? "")]
    .filter((character) => /[^\p{L}\p{N}\s]/u.test(character))
    .join("");
}

export function buildNarrationTextIr({
  sourceScriptSha256 = null,
  generationPlanSha256 = null,
  units = [],
} = {}) {
  const rows = units.map((unit, index) => {
    const sourceText = String(unit.source_text ?? unit.caption_text ?? "");
    const captionText = String(unit.caption_text ?? sourceText);
    const spokenText = String(unit.spoken_text ?? unit.tts_spoken_text ?? "");
    const sourceTokens = narrationTokensWithSpans(sourceText);
    const spokenTokens = narrationTokensWithSpans(spokenText);
    const alignment = tokenAlignment(sourceTokens, spokenTokens);
    const transformationReceipts = Array.isArray(unit.spoken_text_transformations)
      ? unit.spoken_text_transformations.map((receipt) => structuredClone(receipt))
      : [];
    const hasStrictLineage = unit.spoken_text_lineage?.schema
      === "goldflow_spoken_text_lineage_v1";
    const spokenTextLineage = hasStrictLineage
      ? structuredClone(unit.spoken_text_lineage)
      : fallbackSpokenTextLineage(unit, sourceText, spokenText, transformationReceipts);
    const approvedStages = [...new Set(transformationReceipts
      .map((receipt) => String(receipt?.stage ?? ""))
      .filter((stage) => APPROVED_TRANSFORMATION_STAGES.has(stage)))];
    const transformations = alignment.operations
      .filter((operation) => operation.operation !== "equal")
      .map((operation, operationIndex) => ({
        transformation_id: `${unit.unit_id ?? `unit_${index + 1}`}:t${String(operationIndex + 1).padStart(3, "0")}`,
        kind: operation.operation,
        source_token: operation.source_token,
        spoken_token: operation.spoken_token,
        reason: "deterministic_spoken_text_compilation",
        approved_by_rule: hasStrictLineage && approvedStages.length
          ? ["exact_spoken_text_lineage_v1", ...approvedStages]
          : null,
      }));
    return {
      unit_id: String(unit.unit_id ?? `unit_${index + 1}`),
      order_index: Number.isInteger(unit.order_index) ? unit.order_index : index,
      source_unit_refs: unit.source_unit_refs ?? [],
      source_text: sourceText,
      source_text_sha256: sha256(sourceText),
      caption_text: captionText,
      caption_text_sha256: sha256(captionText),
      spoken_text: spokenText,
      spoken_text_sha256: sha256(spokenText),
      source_token_count: sourceTokens.length,
      spoken_token_count: spokenTokens.length,
      token_edit_distance: alignment.distance,
      transformation_count: transformations.length,
      transformations,
      transformation_receipt_count: transformationReceipts.length,
      transformation_receipts_sha256: sha256(JSON.stringify(transformationReceipts)),
      transformation_receipts: transformationReceipts,
      spoken_text_lineage_required: true,
      spoken_text_lineage_source: hasStrictLineage
        ? "provider_plan"
        : "compatibility_synthesized",
      spoken_text_lineage_sha256: spokenTextLineage.lineage_sha256,
      spoken_text_lineage: spokenTextLineage,
      unapproved_transformation_count: transformations.filter(
        (row) => !row.approved_by_rule,
      ).length,
      punctuation_change: punctuationSignature(sourceText) === punctuationSignature(spokenText)
        ? null
        : {
            source_signature: punctuationSignature(sourceText),
            spoken_signature: punctuationSignature(spokenText),
          },
      explicit_override_receipts: unit.spoken_text_transformations
        ?? unit.applied_replacements
        ?? [],
    };
  });
  const ir = {
    schema: NARRATION_TEXT_IR_SCHEMA,
    status: "passed",
    source_script_sha256: sourceScriptSha256,
    narration_generation_plan_sha256: generationPlanSha256,
    unit_count: rows.length,
    transformed_unit_count: rows.filter((row) => row.transformation_count > 0 || row.punctuation_change).length,
    policy: "Source, caption, and spoken text remain distinct. Every token-level deterministic spoken-text change is enumerated and must close through exact text-bearing receipts; no text mutation is implicit.",
    units: rows,
  };
  return { ...ir, ir_sha256: narrationTextIrSha256(ir) };
}

function validateExactReceipt(receipt, expectedBeforeText, unitId, scope) {
  const findings = [];
  const stage = String(receipt?.stage ?? "");
  const beforeText = typeof receipt?.before_text === "string"
    ? receipt.before_text
    : null;
  const afterText = typeof receipt?.after_text === "string"
    ? receipt.after_text
    : null;
  if (!APPROVED_TRANSFORMATION_STAGES.has(stage)) {
    findings.push({
      code: "narration_text_ir_unknown_transformation_stage",
      unit_id: unitId,
      scope,
      stages: [stage],
    });
  }
  if (beforeText === null || afterText === null) {
    findings.push({
      code: "narration_text_ir_receipt_text_evidence_missing",
      unit_id: unitId,
      scope,
      stage,
    });
    return { findings, nextText: afterText ?? expectedBeforeText };
  }
  if (beforeText !== expectedBeforeText) {
    findings.push({
      code: "narration_text_ir_receipt_chain_gap",
      unit_id: unitId,
      scope,
      stage,
      expected_before_sha256: sha256(expectedBeforeText),
      actual_before_sha256: sha256(beforeText),
    });
  }
  if (receipt.before_sha256 !== sha256(beforeText)
    || receipt.after_sha256 !== sha256(afterText)
    || receipt.before_sha256 === receipt.after_sha256) {
    findings.push({
      code: "narration_text_ir_invalid_transformation_receipt",
      unit_id: unitId,
      scope,
      stage,
    });
  }
  const expectedAfterText = expectedReceiptAfterText(receipt);
  if (expectedAfterText === null || expectedAfterText !== afterText) {
    findings.push({
      code: "narration_text_ir_transformation_semantics_mismatch",
      unit_id: unitId,
      scope,
      stage,
      expected_after_sha256: expectedAfterText === null ? null : sha256(expectedAfterText),
      actual_after_sha256: sha256(afterText),
    });
  }
  if (stage === "apply_approved_spoken_overrides"
    && !(receipt.applied_replacements?.length > 0)) {
    findings.push({
      code: "narration_text_ir_override_receipt_missing_rule",
      unit_id: unitId,
      scope,
    });
  }
  if (stage === "apply_pronunciation_map"
    && !(receipt.applied_pronunciations?.length > 0)) {
    findings.push({
      code: "narration_text_ir_pronunciation_receipt_missing_rule",
      unit_id: unitId,
      scope,
    });
  }
  return { findings, nextText: afterText };
}

function validateSpokenTextLineage(row) {
  const findings = [];
  const unitId = row.unit_id;
  const lineage = row.spoken_text_lineage;
  if (row.spoken_text_lineage_source !== "provider_plan") {
    findings.push({
      code: "narration_text_ir_provider_lineage_missing",
      unit_id: unitId,
      actual: row.spoken_text_lineage_source ?? null,
    });
  }
  if (lineage?.schema !== "goldflow_spoken_text_lineage_v1") {
    findings.push({ code: "narration_text_ir_lineage_schema_invalid", unit_id: unitId });
    return findings;
  }
  if (lineage.lineage_sha256 !== spokenTextLineageSha256(lineage)
    || row.spoken_text_lineage_sha256 !== lineage.lineage_sha256) {
    findings.push({ code: "narration_text_ir_lineage_hash_invalid", unit_id: unitId });
  }
  const components = Array.isArray(lineage.components) ? lineage.components : [];
  if (!components.length) {
    findings.push({ code: "narration_text_ir_lineage_components_missing", unit_id: unitId });
    return findings;
  }
  const compiledTexts = [];
  const allReceipts = [];
  for (const [componentIndex, component] of components.entries()) {
    const scope = `component:${component.source_unit_id ?? componentIndex}`;
    const sourceText = String(component.source_text ?? "");
    if (component.source_text_sha256 !== sha256(sourceText)) {
      findings.push({
        code: "narration_text_ir_lineage_source_hash_mismatch",
        unit_id: unitId,
        scope,
      });
    }
    let currentText = sourceText;
    const receipts = Array.isArray(component.transformation_receipts)
      ? component.transformation_receipts
      : [];
    for (const receipt of receipts) {
      if (receipt.source_unit_id
        && component.source_unit_id
        && receipt.source_unit_id !== component.source_unit_id) {
        findings.push({
          code: "narration_text_ir_receipt_source_unit_mismatch",
          unit_id: unitId,
          scope,
          actual: receipt.source_unit_id,
        });
      }
      const validation = validateExactReceipt(receipt, currentText, unitId, scope);
      findings.push(...validation.findings);
      currentText = validation.nextText;
      allReceipts.push(receipt);
    }
    const compiledText = String(component.compiled_spoken_text ?? "");
    if (component.compiled_spoken_text_sha256 !== sha256(compiledText)
      || currentText !== compiledText) {
      findings.push({
        code: "narration_text_ir_component_chain_not_closed",
        unit_id: unitId,
        scope,
        expected_sha256: sha256(compiledText),
        actual_sha256: sha256(currentText),
      });
    }
    compiledTexts.push(compiledText);
  }
  const sourceText = components.map((component) => String(component.source_text ?? ""))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (sourceText !== row.source_text) {
    findings.push({
      code: "narration_text_ir_lineage_source_join_mismatch",
      unit_id: unitId,
      expected_sha256: row.source_text_sha256,
      actual_sha256: sha256(sourceText),
    });
  }
  const preDirectionText = compiledTexts.filter(Boolean).join(" ").trim();
  if (lineage.pre_direction_spoken_text !== preDirectionText
    || lineage.pre_direction_spoken_text_sha256 !== sha256(preDirectionText)) {
    findings.push({
      code: "narration_text_ir_pre_direction_join_mismatch",
      unit_id: unitId,
    });
  }
  let finalText = preDirectionText;
  const finalTransformations = Array.isArray(lineage.final_transformations)
    ? lineage.final_transformations
    : [];
  for (const receipt of finalTransformations) {
    if (receipt.stage !== "llm_authored_punctuation_only_direction") {
      findings.push({
        code: "narration_text_ir_final_transform_not_punctuation_only",
        unit_id: unitId,
        stage: receipt.stage ?? null,
      });
    }
    const validation = validateExactReceipt(receipt, finalText, unitId, "final");
    findings.push(...validation.findings);
    finalText = validation.nextText;
    allReceipts.push(receipt);
  }
  if (lineage.final_spoken_text !== finalText
    || lineage.final_spoken_text_sha256 !== sha256(finalText)
    || finalText !== row.spoken_text) {
    findings.push({
      code: "narration_text_ir_final_chain_not_closed",
      unit_id: unitId,
      expected_sha256: row.spoken_text_sha256,
      actual_sha256: sha256(finalText),
    });
  }
  if (sha256(JSON.stringify(allReceipts)) !== row.transformation_receipts_sha256) {
    findings.push({
      code: "narration_text_ir_flattened_receipt_lineage_mismatch",
      unit_id: unitId,
    });
  }
  return findings;
}

export function validateNarrationTextIr(ir, expectedUnits = [], {
  sourceScriptSha256 = null,
  generationPlanSha256 = null,
} = {}) {
  const findings = [];
  if (ir?.schema !== NARRATION_TEXT_IR_SCHEMA) {
    findings.push({ code: "narration_text_ir_schema_invalid" });
  }
  if (!Array.isArray(ir?.units)) {
    findings.push({ code: "narration_text_ir_units_missing" });
  }
  if (ir?.status && !["passed", "pending_validation"].includes(ir.status)) {
    findings.push({ code: "narration_text_ir_status_not_passed", actual: ir.status });
  }
  if (!ir?.ir_sha256 || ir.ir_sha256 !== narrationTextIrSha256(ir)) {
    findings.push({ code: "narration_text_ir_hash_invalid" });
  }
  if (sourceScriptSha256 && ir?.source_script_sha256 !== sourceScriptSha256) {
    findings.push({
      code: "narration_text_ir_source_script_hash_mismatch",
      expected: sourceScriptSha256,
      actual: ir?.source_script_sha256 ?? null,
    });
  }
  if (generationPlanSha256
    && ir?.narration_generation_plan_sha256 !== generationPlanSha256) {
    findings.push({
      code: "narration_text_ir_generation_plan_hash_mismatch",
      expected: generationPlanSha256,
      actual: ir?.narration_generation_plan_sha256 ?? null,
    });
  }
  const rows = Array.isArray(ir?.units) ? ir.units : [];
  if (rows.length !== expectedUnits.length) {
    findings.push({ code: "narration_text_ir_unit_count_mismatch", expected: expectedUnits.length, actual: rows.length });
  }
  for (const [index, expected] of expectedUnits.entries()) {
    const row = rows[index];
    if (!row) continue;
    if (String(row.unit_id) !== String(expected.unit_id)) {
      findings.push({ code: "narration_text_ir_unit_order_mismatch", index, expected: expected.unit_id, actual: row.unit_id });
    }
    if (row.spoken_text_sha256 !== sha256(expected.spoken_text ?? expected.tts_spoken_text ?? "")) {
      findings.push({ code: "narration_text_ir_spoken_hash_mismatch", unit_id: row.unit_id });
    }
    if (row.source_text_sha256 !== sha256(expected.source_text ?? expected.caption_text ?? "")) {
      findings.push({ code: "narration_text_ir_source_hash_mismatch", unit_id: row.unit_id });
    }
    if (row.caption_text_sha256 !== sha256(expected.caption_text ?? expected.source_text ?? "")) {
      findings.push({ code: "narration_text_ir_caption_hash_mismatch", unit_id: row.unit_id });
    }
    if (row.transformation_count !== row.transformations?.length) {
      findings.push({ code: "narration_text_ir_transformation_count_mismatch", unit_id: row.unit_id });
    }
    const receipts = Array.isArray(row.transformation_receipts)
      ? row.transformation_receipts
      : [];
    if (row.transformation_receipt_count !== receipts.length
      || row.transformation_receipts_sha256 !== sha256(JSON.stringify(receipts))) {
      findings.push({ code: "narration_text_ir_receipt_integrity_mismatch", unit_id: row.unit_id });
    }
    if (row.spoken_text_lineage_required === true) {
      findings.push(...validateSpokenTextLineage(row));
    }
    const unknownStages = receipts
      .map((receipt) => String(receipt?.stage ?? ""))
      .filter((stage) => !APPROVED_TRANSFORMATION_STAGES.has(stage));
    if (unknownStages.length) {
      findings.push({
        code: "narration_text_ir_unknown_transformation_stage",
        unit_id: row.unit_id,
        stages: [...new Set(unknownStages)],
      });
    }
    for (const receipt of receipts) {
      if (!/^[a-f0-9]{64}$/u.test(String(receipt?.before_sha256 ?? ""))
        || !/^[a-f0-9]{64}$/u.test(String(receipt?.after_sha256 ?? ""))
        || receipt.before_sha256 === receipt.after_sha256) {
        findings.push({
          code: "narration_text_ir_invalid_transformation_receipt",
          unit_id: row.unit_id,
          stage: receipt?.stage ?? null,
        });
      }
      if (receipt?.stage === "apply_approved_spoken_overrides"
        && !(receipt.applied_replacements?.length > 0)) {
        findings.push({
          code: "narration_text_ir_override_receipt_missing_rule",
          unit_id: row.unit_id,
        });
      }
      if (receipt?.stage === "apply_pronunciation_map"
        && !(receipt.applied_pronunciations?.length > 0)) {
        findings.push({
          code: "narration_text_ir_pronunciation_receipt_missing_rule",
          unit_id: row.unit_id,
        });
      }
    }
    if ((row.transformation_count > 0 || row.punctuation_change)
      && receipts.length === 0) {
      findings.push({
        code: "narration_text_ir_unreceipted_text_change",
        unit_id: row.unit_id,
      });
    }
    if (row.unapproved_transformation_count !== 0
      || row.transformations?.some((transformation) => !transformation.approved_by_rule)) {
      findings.push({
        code: "narration_text_ir_unapproved_token_transformation",
        unit_id: row.unit_id,
      });
    }
  }
  return { status: findings.length ? "blocked" : "passed", findings };
}
