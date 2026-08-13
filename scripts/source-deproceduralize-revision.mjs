#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChatGptWebPlanner } from "./chatgpt-web-planner-helper.mjs";

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function wordCount(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  for (const key of ["script", "reference", "output", "marker"]) {
    if (!flags[key]) throw new Error(`Missing --${key}`);
  }
  const scriptPath = path.resolve(flags.script);
  const referencePath = path.resolve(flags.reference);
  const outputPath = path.resolve(flags.output);
  const [script, reference, template] = await Promise.all([
    fs.readFile(scriptPath, "utf8"),
    fs.readFile(referencePath, "utf8"),
    fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "prompts", "manhwa_recap_deproceduralization_revision_v1.md"), "utf8"),
  ]);
  const marker = String(flags.marker);
  const markerIndex = script.indexOf(marker);
  if (markerIndex < 0 || script.indexOf(marker, markerIndex + marker.length) >= 0) {
    throw new Error("The immutable-opening marker must occur exactly once.");
  }
  const immutableOpening = script.slice(0, markerIndex).trimEnd();
  const currentContinuation = script.slice(markerIndex);
  const openingWords = wordCount(immutableOpening);
  const minimumTotal = Number.parseInt(flags["minimum-words"] ?? "9500", 10);
  const maximumTotal = Number.parseInt(flags["maximum-words"] ?? "10500", 10);
  const minimumContinuation = minimumTotal - openingWords;
  const maximumContinuation = maximumTotal - openingWords;
  const repairContract = {
    title: String(flags.title ?? "My Brother Took My Inheritance for Being Weak—Then I Stole His SSS Talent and Grew 100X Faster"),
    immutable_opening_word_count: openingWords,
    replacement_continuation_word_range: { minimum: minimumContinuation, maximum: maximumContinuation },
    required_events: [
      "Marcus adapts after the convoy rescue and remains a direct active threat",
      "Mara and Joey uncover Marcus's sabotage through a dangerous physical or supernatural sequence",
      "Captain Rell attacks, Joey deliberately steals Echo Trace to stop an immediate killing, and the theft has lasting human cost",
      "Joey uses Echo Trace and 100X at Mara's father's chapel without her permission, discovers both fathers were implicated, and Mara leaves him",
      "Joey changes his behavior and earns Mara's return through action rather than policy promises",
      "Marcus triggers or exploits a six-sector Northwall catastrophe in public",
      "Joey refuses to steal Mara's Resonance Mapping despite maximum temptation",
      "Joey combines Sovereign Combat Instinct, Echo Trace, 100X, Mara's mapping, Sera's agency, and allies' choices to save all six towns",
      "Marcus loses command and inheritance without a sentimental reconciliation",
      "Sera chooses an independent life, Mara remains able to contradict Joey, Joey keeps permanent nerve damage, and the ordinary future closes the story",
    ],
    prohibited_dominant_modes: [
      "repeated hearings",
      "repeated councils",
      "ledger or audit investigation as entertainment",
      "contract negotiation",
      "permission gathering",
      "testimony or authentication as climax mechanics",
      "policy dialogue shared by multiple characters",
    ],
  };
  const referenceExcerpt = reference.trim().split(/\s+/).slice(0, 14_000).join(" ");
  const prompt = `${template}\n\nREPAIR CONTRACT JSON:\n${JSON.stringify(repairContract, null, 2)}\n\nIMMUTABLE OPENING END STATE AND LAST 700 WORDS (do not repeat):\n${immutableOpening.split(/\s+/).slice(-700).join(" ")}\n\nCURRENT CONTINUATION TO REBUILD:\n${currentContinuation}\n\nMEASURED OUTLIER REFERENCE EXCERPT FOR POWER-FANTASY EXPERIENCE COMPARISON ONLY:\n${referenceExcerpt}`;
  const responsePath = `${outputPath}.continuation-response.txt`;
  const existingResponse = await fs.readFile(responsePath, "utf8").catch(() => "");
  const result = existingResponse.trim()
    ? {
        provider: "chatgpt_web_reused_response",
        model: "gpt-5.6-sol",
        reasoning_effort: "max",
        bridge_receipt_path: null,
      }
    : await runChatGptWebPlanner({
        prompt,
        outputPath: responsePath,
        workId: `source_deproceduralize_${sha256(script).slice(0, 12)}`,
        effort: "max",
        timeoutMs: 3_600_000,
        rateClass: "source_revision",
      });
  const replacement = (await fs.readFile(responsePath, "utf8")).trim();
  if (!replacement.startsWith(marker)) throw new Error("Replacement continuation does not begin at the exact marker.");
  const revised = `${immutableOpening}\n\n${replacement}\n`;
  const totalWords = wordCount(revised);
  if (totalWords < minimumTotal || totalWords > maximumTotal) {
    throw new Error(`Revised script has ${totalWords} words; expected ${minimumTotal}-${maximumTotal}.`);
  }
  for (const required of ["Marcus", "Mara", "Sera", "Rell", "Echo Trace", "100X", "Sovereign Combat Instinct"]) {
    if (!revised.includes(required)) throw new Error(`Revised script omitted required story element: ${required}`);
  }
  if (!revised.trim().endsWith("That was the first inheritance I ever truly accepted.")) {
    throw new Error("Revised script did not preserve the exact completed final line.");
  }
  await fs.writeFile(outputPath, revised, "utf8");
  const proceduralMatches = revised.match(/\b(ledger|hearing|audit|contract|council|testimony|authenticate\w*|permission|notar\w*|charter|restitution|verification)\b/gi) ?? [];
  const report = {
    schema: "goldflow_source_deproceduralization_revision_v1",
    source_script_path: scriptPath,
    source_script_sha256: sha256(script),
    output_path: outputPath,
    output_sha256: sha256(revised),
    immutable_opening_sha256: sha256(immutableOpening),
    immutable_opening_word_count: openingWords,
    source_word_count: wordCount(script),
    output_word_count: totalWords,
    diagnostic_procedural_term_occurrences: proceduralMatches.length,
    provider: result.provider,
    model: result.model,
    reasoning_effort: result.reasoning_effort,
    receipt_path: result.bridge_receipt_path,
    completed_at: new Date().toISOString(),
  };
  await fs.writeFile(`${outputPath}.report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

await main();
