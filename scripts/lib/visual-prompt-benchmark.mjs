import { createHash } from "node:crypto";

import {
  compileVisualPrompt,
  validateVisualPromptCompilerReceipt,
} from "./visual-prompt-compiler.mjs";

export const VISUAL_PROMPT_BENCHMARK_SCHEMA = "goldflow_visual_prompt_hard_cut_benchmark_v1";
export const VISUAL_PROMPT_BENCHMARK_PROVIDERS = Object.freeze(["google-flow", "google-gemini", "chatgpt"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function referenceRows(count) {
  return Array.from({ length: Number(count ?? 0) }, (_value, index) => ({
    slot: index + 1,
    ref_id: `benchmark_ref_${index + 1}`,
    purpose: `locked benchmark continuity role ${index + 1}`,
    sha256: sha256(`benchmark-reference-${index + 1}`),
  }));
}

function tokenPresent(prompt, token) {
  return prompt.toLowerCase().includes(cleanText(token).toLowerCase());
}

function evaluateOne(testCase, provider) {
  const references = referenceRows(testCase.reference_count);
  const input = {
    provider,
    neutralPrompt: testCase.neutral_prompt,
    shotManifest: testCase.shot_manifest,
    orderedReferences: references,
    assetId: testCase.case_id,
  };
  const first = compileVisualPrompt(input);
  const second = compileVisualPrompt(input);
  const blockers = [];
  const warnings = [];
  if (first.prompt !== second.prompt || first.prompt_sha256 !== second.prompt_sha256) blockers.push("compiler_output_not_deterministic");
  blockers.push(...validateVisualPromptCompilerReceipt({
    prompt: first.prompt,
    receipt: first.receipt,
    neutralPrompt: testCase.neutral_prompt,
    provider,
    orderedReferences: references,
  }));
  for (const token of testCase.required_tokens ?? []) {
    if (!tokenPresent(first.prompt, token)) blockers.push(`required_token_missing:${token}`);
  }
  if (!first.prompt.includes("SCENE DESCRIPTION:")) blockers.push("neutral_scene_section_missing");
  const actionIndex = first.prompt.indexOf("DECISIVE ACTION:");
  const sceneIndex = first.prompt.indexOf("SCENE DESCRIPTION:");
  if (testCase.shot_manifest?.foreground_action && !(actionIndex >= 0 && actionIndex < sceneIndex)) blockers.push("decisive_action_not_prioritized");
  for (let index = 0; index < references.length; index += 1) {
    const binding = `Attachment ${index + 1} = ${references[index].ref_id}`;
    if (!first.prompt.includes(binding)) blockers.push(`reference_order_missing:${index + 1}`);
  }
  if (/\bnegative_prompt\b/i.test(first.prompt)) blockers.push("provider_negative_payload_present");
  if (first.receipt.soft_budget_exceeded) warnings.push("soft_prompt_budget_exceeded");
  const overheadChars = first.receipt.compiled_char_count - first.receipt.neutral_char_count;
  if (overheadChars > 2_600) warnings.push("compiler_overhead_high");
  return {
    case_id: testCase.case_id,
    category: testCase.category,
    provider,
    status: blockers.length ? "failed" : "passed",
    blockers,
    warnings,
    reference_count: references.length,
    neutral_prompt_sha256: first.receipt.neutral_prompt_sha256,
    compiled_prompt_sha256: first.prompt_sha256,
    compiler_id: first.receipt.compiler_id,
    neutral_char_count: first.receipt.neutral_char_count,
    compiled_char_count: first.receipt.compiled_char_count,
    compiler_overhead_chars: overheadChars,
    compiled_word_count: first.receipt.compiled_word_count,
    soft_char_budget: first.receipt.soft_char_budget,
  };
}

export function runVisualPromptHardCutBenchmark(fixture, { generatedAt = new Date() } = {}) {
  if (fixture?.schema !== VISUAL_PROMPT_BENCHMARK_SCHEMA || !Array.isArray(fixture.cases)) {
    throw new Error(`Visual prompt benchmark fixture must use ${VISUAL_PROMPT_BENCHMARK_SCHEMA}.`);
  }
  if (fixture.cases.length !== 25) throw new Error(`Visual prompt benchmark requires exactly 25 locked hard-cut cases; received ${fixture.cases.length}.`);
  const caseIds = fixture.cases.map((row) => cleanText(row?.case_id));
  if (caseIds.some((id) => !id) || new Set(caseIds).size !== caseIds.length) throw new Error("Visual prompt benchmark case IDs must be nonempty and unique.");
  const results = fixture.cases.flatMap((testCase) => VISUAL_PROMPT_BENCHMARK_PROVIDERS.map((provider) => evaluateOne(testCase, provider)));
  const failed = results.filter((row) => row.status !== "passed");
  const providerSummary = Object.fromEntries(VISUAL_PROMPT_BENCHMARK_PROVIDERS.map((provider) => {
    const rows = results.filter((row) => row.provider === provider);
    return [provider, {
      cases: rows.length,
      passed: rows.filter((row) => row.status === "passed").length,
      failed: rows.filter((row) => row.status !== "passed").length,
      warning_count: rows.reduce((sum, row) => sum + row.warnings.length, 0),
      mean_compiler_overhead_chars: Number((rows.reduce((sum, row) => sum + row.compiler_overhead_chars, 0) / Math.max(1, rows.length)).toFixed(1)),
      max_compiled_char_count: Math.max(...rows.map((row) => row.compiled_char_count)),
    }];
  }));
  return {
    schema: "goldflow_visual_prompt_hard_cut_benchmark_report_v1",
    status: failed.length ? "failed" : "passed",
    generated_at: generatedAt.toISOString(),
    fixture_schema: fixture.schema,
    fixture_version: fixture.version ?? 1,
    fixture_sha256: sha256(JSON.stringify(fixture)),
    scope: {
      locked_case_count: fixture.cases.length,
      provider_count: VISUAL_PROMPT_BENCHMARK_PROVIDERS.length,
      compiled_prompt_count: results.length,
    },
    promotion_boundary: "This benchmark proves deterministic structural fidelity and prompt-budget visibility. Provider quality promotion still requires blinded generated-raster comparison on this same locked corpus.",
    provider_summary: providerSummary,
    failed_count: failed.length,
    results,
  };
}
