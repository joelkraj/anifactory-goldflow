import test from "node:test";
import assert from "node:assert/strict";
import { extractNarrationPerformanceJsonForTests, narrationUnitHasTerminalPunctuationForTests } from "../lib/narration-performance-author.mjs";

test("scripted Unicode ellipsis ends an authored spoken unit", () => {
  assert.equal(narrationUnitHasTerminalPunctuationForTests("Then I look in there and…"), true);
  assert.equal(narrationUnitHasTerminalPunctuationForTests("“The business was gone. Dylan…”"), true);
  assert.equal(narrationUnitHasTerminalPunctuationForTests("an unfinished fragment"), false);
});

test("only a missing final unit brace receives bounded syntax repair", () => {
  const complete = '{"chapters":[],"units":[{"spoken_text":"Yes.","performance_intent":{"style_tags":[]}}]}';
  const missing = complete.replace('}}]}', '}]}');
  const parsed = extractNarrationPerformanceJsonForTests(missing);
  assert.equal(parsed.syntax_repair, "missing_final_unit_object_brace");
  assert.equal(parsed.value.units[0].spoken_text, "Yes.");
  assert.throws(() => extractNarrationPerformanceJsonForTests('{"chapters":[],"units":[{"spoken_text":"Yes."'), /valid JSON/);
});
