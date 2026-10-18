import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  COHERENT_SUBMISSION_POLICY,
  buildNarrationSubmissionRiskLedger,
  narrationSubmissionPayloadBlockers,
  narrationSubmissionRisks,
} from "../lib/narration-submission-audit.mjs";
import { buildTtsSpokenTextAudit, ttsSpokenTextAuditMatches } from "../lib/tts-spoken-text-audit.mjs";
import { compileProviderSafeSpokenText } from "../lib/narration-spoken-text.mjs";
import { qwenGenerationPlanForTests } from "../voice-direction-gate.mjs";
import { buildNarrationTextIr, validateNarrationTextIr } from "../lib/narration-text-ir.mjs";

const sha = (x) => createHash("sha256").update(x).digest("hex");
const source = '“I’d paid $53.25—no, no… 4.5%.”\nThe SSS-rank CEO checked 4/5 with Kael.';
const unit = { unit_id: "u1", source_text: source, caption_text: source, spoken_text: source, protected_terms: ["Kael"] };
const risks = narrationSubmissionRisks(unit);
for (const category of ["currency", "decimal", "percentage", "rank", "initialism_or_capitalized_word", "ambiguous_contraction", "quotation", "ellipsis", "dash", "line_break", "repetition", "protected_term", "ratio_date_or_time"]) {
  assert.ok(risks.some((row) => row.category === category), category);
}
for (const row of risks) {
  assert.equal(source.slice(row.source_start, row.source_end), row.source_text);
  assert.equal(row.source_text_sha256, sha(source));
  assert.equal(row.spoken_text_sha256, sha(source));
}
assert.equal(unit.source_text, source);
assert.equal(unit.spoken_text, source);
assert.match(risks.find((row) => row.category === "ambiguous_contraction").disposition, /no_blanket_expansion/);
assert.equal(buildNarrationSubmissionRiskLedger([unit]).ledger_sha256, buildNarrationSubmissionRiskLedger([unit]).ledger_sha256);
assert.notEqual(buildNarrationSubmissionRiskLedger([unit]).ledger_sha256, buildNarrationSubmissionRiskLedger([{ ...unit, spoken_text: "I had paid." }]).ledger_sha256);

for (const text of ["[pause] Wait.", '<break time="100ms"/> Wait.', "<speak>Wait.</speak>", "Narrator: Wait.", "<|speaker:1|> Wait."]) {
  assert.ok(narrationSubmissionPayloadBlockers(text).includes("submission_instruction_or_markup_leak"), text);
}
assert.deepEqual(narrationSubmissionPayloadBlockers('“Wait,” I said. I’d waited before—no, no… never again.'), []);
assert.ok(narrationSubmissionPayloadBlockers("I paid $fifty-three.").includes("unresolved_currency_or_percent_symbol_in_spoken_text"));

const ordinary = "I crossed the quiet hall and opened the wooden door. Behind it, the others were waiting for the answer I had promised.";
const plan = { units: [{ unit_id: "plain", kind: "narration", source_text: ordinary, caption_text: ordinary, spoken_text: ordinary }] };
const legacy = buildTtsSpokenTextAudit({ plan, sourceScriptSha256: "s" });
assert.ok(legacy.warnings.some((row) => row.code === "narration_unit_below_45_word_target"));
assert.equal(legacy.submission_risk_ledger, undefined);
const currentPlan = { ...plan, submission_policy: COHERENT_SUBMISSION_POLICY };
const current = buildTtsSpokenTextAudit({ plan: currentPlan, sourceScriptSha256: "s" });
assert.ok(!current.warnings.some((row) => /below_45|short_narration/.test(row.code)));
assert.equal(ttsSpokenTextAuditMatches({ audit: current, plan: currentPlan, sourceScriptSha256: "s" }), true);
assert.equal(ttsSpokenTextAuditMatches({ audit: legacy, plan: currentPlan, sourceScriptSha256: "s" }), false);
assert.equal(ttsSpokenTextAuditMatches({ audit: current, plan, sourceScriptSha256: "s" }), false);

// Exact contextual overrides close through the existing source-component IR.
// The same contraction means different things in the two adjacent phrases.
const exactSource = "I'd paid $53.25. I'd pay again. My odds were 4.5%, and the CEO carried an SSS-rank badge.";
const exactPlan = qwenGenerationPlanForTests([{
  segment_id: "voice_seg_01", delivery_mode: "narration", performance_units: [{ kind: "narration", speaker: "NARRATOR", text: exactSource, caption_text: exactSource }],
}], { ttsOverrides: { replacements: [
  { from: "I'd paid $53.25", to: "I had paid fifty-three dollars and twenty-five cents", scope: "tts_spoken_text", reason: "Past perfect in this exact phrase; dollars and cents." },
  { from: "I'd pay again", to: "I would pay again", scope: "tts_spoken_text", reason: "Conditional in this exact phrase." },
] } });
const exact = exactPlan.units[0];
assert.match(exact.spoken_text, /^I had paid fifty-three dollars and twenty-five cents\. I would pay again\./);
assert.match(exact.spoken_text, /four point five percent/);
assert.match(exact.spoken_text, /C E O.*S S S rank/);
assert.equal(exact.source_text, exactSource);
assert.equal(exact.caption_text, exactSource);
assert.equal(exact.provider_request.request.text, exact.spoken_text);
assert.equal(validateNarrationTextIr(buildNarrationTextIr({ units: exactPlan.units }), exactPlan.units).status, "passed");
assert.equal(compileProviderSafeSpokenText("I'd paid. I'd pay."), "I'd paid. I'd pay.");
assert.equal(compileProviderSafeSpokenText("IT was over. The IT department knew."), "It was over. The I T department knew.");
console.log("Narration submission audit: contextual inventory, exact overrides/IR/payload, instruction leaks and legacy audit compatibility passed.");
