#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runChatGptWebPlanner } from "./chatgpt-web-planner-helper.mjs";
import { parseJsonObjectFromPlannerOutput } from "./lib/json-output-repair.mjs";
import { applyExactViewerPatches } from "./source-viewer-tournament-patch.mjs";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (!token.startsWith("--")) continue;
    const next = parts[index + 1];
    flags[token.slice(2)] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) index += 1;
  }
  return flags;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const wordCount = (value) => String(value ?? "").trim().split(/\s+/).filter(Boolean).length;

const flags = parseFlags(process.argv.slice(2));
for (const key of ["script", "output"]) if (!flags[key]) throw new Error(`Missing --${key}`);
const scriptPath = path.resolve(flags.script);
const outputPath = path.resolve(flags.output);
const script = await fs.readFile(scriptPath, "utf8");
const prompt = `Return JSON only. Make exactly three surgical find-and-replace patches to this complete manhwa-recap narration. This is the final merit repair after a blinded comparison against a measured niche outlier.

Do not rewrite unaffected prose. Every find value must be a unique exact contiguous span copied from the supplied script. Keep all names, POV, chronology, power rules, injuries, causal outcomes, the six-town climax, and the exact final line. Do not add a new character, faction, subplot, tournament, hidden organization, or unplanted power.

PATCH 1 — EARLY REVENGE VELOCITY
Replace one unique span beginning at or after “That was when the stolen crown turned the entire room into an ambush.” and ending before “The ride east took less than an hour.” Compress the overload, neutral-witness mistake, Marcus's intelligent counter, frozen inheritance, Mara's entrance, and Sera's ribbon into a much faster continuous sequence. Preserve all those facts. Remove legal/procedural interpretation and repeated official reaction. Mara's pylon challenge must feel like the next attack, not a new administrative arc. Make the replacement materially shorter than the source span so the live pylon and first impossible noncombat 100X application arrive earlier in spoken runtime.

PATCH 2 — EARNED POWER EVOLUTION
Replace one unique local span in the collapsing bell tower or Echo Trace vault. Preserve the existing action and outcome, but make 100X visibly fuse Joey's already-owned Sovereign Combat Instinct with the newly learned environment/trace logic into one memorable named derived mastery. This is not a new stolen talent and has no new unexplained capability; it is an earned synthesis of existing powers and training. Give it one concise system-style label and immediate visual proof. Avoid stat dumps.

PATCH 3 — UNMISTAKABLE EMOTIONAL PAYOFF
Replace one unique span from “Mara became Northwall’s chief engineer” through the kitchen ending, while preserving Sera's independent bookbinder future, Rell's unresolved resentment, Joey's permanent nerve/left-hand damage, the crooked compass, the six ordinary towns, and the exact final three inheritance lines. Mara must make a concrete personal choice to stay with Joey that cannot be reduced to a job, duty, supervision, policy, or witty professional proximity. Keep her boundaries and her refusal to erase the chapel violation. Pay the slow-burn relationship through vulnerable action and imperfect dialogue rather than an abstract declaration. A kiss is allowed only if earned naturally by the supplied relationship; physical closeness, choosing a shared home, or placing her hand over the Theft mark without fear may be stronger. End shortly after the emotional action.

Global style: natural spoken K-drama/manhwa recap, emotionally legible, visually concrete, title-native, minimal abstract ethics language, minimal procedure, no AI-writing commentary, no narrator explanation after the action already proves the point. Across all patches, add no more than 250 net words. Patch 1 must save at least 120 words.

Schema:
{
  "schema": "goldflow_viewer_tournament_patch_v1",
  "diagnosis": "brief",
  "patches": [
    {"checkpoint":"3_to_5_minutes","rationale":"...","find":"exact source span","replace":"..."},
    {"checkpoint":"power_fantasy_satisfaction","rationale":"...","find":"exact source span","replace":"..."},
    {"checkpoint":"emotional_satisfaction_and_ending","rationale":"...","find":"exact source span","replace":"..."}
  ]
}

EXACT SCRIPT:\n${script}`;
const responsePath = `${outputPath}.merit-patch-response.txt`;
const existing = await fs.readFile(responsePath, "utf8").catch(() => "");
const result = existing.trim()
  ? { provider: "chatgpt_web_reused_response", model: "gpt-6-sol", reasoning_effort: "max", bridge_receipt_path: null }
  : await runChatGptWebPlanner({
      prompt,
      outputPath: responsePath,
      workId: `source_manhwa_merit_repair_${sha256(script).slice(0, 12)}`,
      effort: "max",
      timeoutMs: 3_600_000,
      rateClass: "source_revision",
    });
const document = parseJsonObjectFromPlannerOutput(await fs.readFile(responsePath, "utf8")).value;
const { revised, applied } = applyExactViewerPatches(script, document, {
  maxFindWords: 800,
  maxTotalWordDelta: 700,
});
const early = applied.find((row) => row.checkpoint === "3_to_5_minutes");
if (!early || early.find_word_count - early.replacement_word_count < 120) throw new Error("Early patch did not save at least 120 words.");
if (applied.length !== 3) throw new Error("Merit repair must apply exactly three patches.");
const powerPatch = applied.find((row) => row.checkpoint === "power_fantasy_satisfaction");
const powerPatchDocument = document.patches.find((row) => row.checkpoint === "power_fantasy_satisfaction");
if (!powerPatch || !powerPatchDocument || !/(?:^|\\n|\n)[A-Z][A-Z0-9 ]{2,}: [A-Z0-9 ]+[.!]?(?:\\n|\n|$)/.test(String(powerPatchDocument.replace ?? ""))) {
  throw new Error("Merit repair omitted a concise system-style earned synthesis label.");
}
if (!revised.trim().endsWith("That was the first inheritance I ever truly accepted.")) throw new Error("Merit repair changed the exact final line.");
await fs.writeFile(outputPath, revised, "utf8");
const report = {
  schema: "goldflow_manhwa_merit_repair_v1",
  source_script_path: scriptPath,
  source_script_sha256: sha256(script),
  output_path: outputPath,
  output_sha256: sha256(revised),
  source_word_count: wordCount(script),
  output_word_count: wordCount(revised),
  patches: applied,
  diagnosis: String(document.diagnosis ?? ""),
  provider: result.provider,
  model: result.model,
  reasoning_effort: result.reasoning_effort,
  receipt_path: result.bridge_receipt_path,
  completed_at: new Date().toISOString(),
};
await fs.writeFile(`${outputPath}.report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
