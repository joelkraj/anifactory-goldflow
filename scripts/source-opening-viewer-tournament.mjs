#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runChatGptWebPlanner } from "./chatgpt-web-planner-helper.mjs";
import { sourceViewerPanel } from "./lib/source-viewer-profile-bank.mjs";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = parts[index + 1];
    flags[key] = next && !next.startsWith("--") ? next : "true";
    if (flags[key] !== "true") index += 1;
  }
  return flags;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const flags = parseFlags(process.argv.slice(2));
const candidatePath = path.resolve(flags.candidate ?? "");
const referencePath = path.resolve(flags.reference ?? "");
const outputDir = path.resolve(flags["output-dir"] ?? "");
const candidateTitle = String(flags["candidate-title"] ?? "Candidate title");
const referenceTitle = String(flags["reference-title"] ?? "Reference title");
const panelSeed = String(flags["panel-seed"] ?? "").trim();
const concurrency = Math.max(1, Math.min(5, Number.parseInt(flags.concurrency ?? "3", 10) || 3));
const startIntervalMs = Math.max(5_000, Number.parseInt(flags["start-interval-ms"] ?? "15000", 10) || 15_000);
if (!flags.candidate || !flags.reference || !flags["output-dir"]) {
  throw new Error("Usage: source-opening-viewer-tournament --candidate <txt> --reference <txt> --output-dir <dir> --panel-seed <stable-development-seed> [--candidate-title <title>] [--reference-title <title>] [--concurrency 3] [--start-interval-ms 15000]");
}
if (!panelSeed) throw new Error("Missing --panel-seed; rotating viewers must be fixed before scoring.");
const personas = sourceViewerPanel(panelSeed);

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  const failures = [];
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failures.push({
          index,
          item: items[index],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return { results, failures };
}

const [candidate, reference] = await Promise.all([
  fs.readFile(candidatePath, "utf8"),
  fs.readFile(referencePath, "utf8"),
]);
await fs.mkdir(outputDir, { recursive: true });
const manifestPath = path.join(outputDir, "manifest.json");
const existingManifest = await fs.readFile(manifestPath, "utf8").then(JSON.parse).catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
if (existingManifest) {
  if (
    existingManifest.candidate_sha256 !== sha256(candidate)
    || existingManifest.reference_sha256 !== sha256(reference)
    || existingManifest.panel_seed !== panelSeed
    || existingManifest.candidate_title !== candidateTitle
    || existingManifest.reference_title !== referenceTitle
  ) throw new Error("Existing viewer-tournament directory is bound to a different candidate, reference, title, or panel seed.");
} else {
  const staleReportNames = (await fs.readdir(outputDir)).filter((name) => name.endsWith(".json") && name !== "aggregation.json");
  if (staleReportNames.length > 0) {
    throw new Error("Viewer reports exist without a matching manifest; use a new content-addressed tournament directory.");
  }
}

function packet(persona) {
  const candidateLabel = persona.order === "candidate_first" ? "SCRIPT A" : "SCRIPT B";
  const referenceLabel = persona.order === "candidate_first" ? "SCRIPT B" : "SCRIPT A";
  const first = persona.order === "candidate_first"
    ? `SCRIPT A TITLE: ${candidateTitle}\nSCRIPT A TEXT:\n${candidate}\n\nSCRIPT B TITLE: ${referenceTitle}\nSCRIPT B TEXT:\n${reference}`
    : `SCRIPT A TITLE: ${referenceTitle}\nSCRIPT A TEXT:\n${reference}\n\nSCRIPT B TITLE: ${candidateTitle}\nSCRIPT B TEXT:\n${candidate}`;
  return `You are one simulated cold YouTube manhwa-recap viewer. Stay inside this viewing psychology:\n${persona.brief}\n\nThis is a blinded comparative audience test, not a writing workshop. Read both scripts as spoken videos at about 190 words per minute. Goldflow's primary viewing objective is average percentage viewed. The scripts differ in total runtime: judge what fraction of each complete video a viewer like you would voluntarily watch. Do not reward raw length, and do not give a shorter script automatic credit; estimate the actual percentage its story would retain. Judge which script is more likely to produce the higher average percentage viewed. Do not use a checklist as a substitute for your felt viewing response.\n\nAt each checkpoint (30 seconds, 60 seconds, 3 minutes, 5 minutes, middle, ending, overall), choose A, B, or tie. Return exactly seven checkpoint rows, once each, in that order. For every choice, quote a short exact excerpt from each script and explain the viewing effect. Identify the earliest exact sentence where you would consider leaving each script. Give no charitable credit for events that happen much later. Separate opening quality, average-percentage-viewed potential, emotional satisfaction, power-fantasy satisfaction, clarity, freshness, and ending payoff. For each dimension, quote one short exact excerpt from A and one from B that support the vote.\n\nNormalize every dimension for runtime and package promise. In particular, power-fantasy satisfaction means payoff density, escalation, ingenuity, desirability, memorable superiority, and fulfillment of the clicked title across the fraction viewed. A longer script does not win merely because it contains more total powers, fights, upgrades, or enemies. A shorter script does not win merely because it is denser. Judge which complete experience uses its runtime better and leaves the viewer more satisfied with the promised fantasy.\n\nEstimate percentage viewed for A and B from zero to one hundred. Your apv_preference must choose the script with the greater estimated percentage viewed. Explain the exact story spans that would retain or lose that percentage.\n\nThen give the weaker APV script a maximum of eight prioritized revision notes. Notes must preserve its premise and strongest material. Each note must identify an exact weak excerpt, what you felt as a viewer, and the smallest story-level change that would increase percentage viewed. Do not write replacement prose.\n\nReturn JSON only using this shape:\n{\n  "schema": "goldflow_simulated_manhwa_viewer_v2",\n  "persona_id": "${persona.id}",\n  "script_label_map": { "candidate": "${candidateLabel}", "reference": "${referenceLabel}" },\n  "checkpoint_preferences": [{ "checkpoint": "30_seconds", "preference": "A|B|tie", "a_anchor": "...", "b_anchor": "...", "viewing_effect": "..." }],\n  "earliest_leave_risk": { "A": { "exact_anchor": "...", "reason": "..." }, "B": { "exact_anchor": "...", "reason": "..." } },\n  "estimated_percentage_viewed": { "A": 0, "B": 0, "rationale": "..." },\n  "apv_preference": "A|B|tie",\n  "dimension_preferences": [{ "dimension": "opening_quality", "preference": "A|B|tie", "a_anchor": "...", "b_anchor": "...", "reason": "..." }],\n  "overall_preference": "A|B|tie",\n  "confidence": "low|medium|high",\n  "weaker_script": "A|B|neither",\n  "revision_notes": [{ "priority": 1, "exact_anchor": "...", "viewer_reaction": "...", "smallest_story_change": "..." }],\n  "one_sentence_verdict": "..."\n}\n\n${first}`;
}

function reinforceExactAnchorContract(prompt) {
  const instruction = "Every anchor field must be a short contiguous verbatim copy from the matching script. Do not paraphrase, summarize, splice nonadjacent words, modernize punctuation, or add ellipses. Prefer 6-18 consecutive words. Before returning, search each anchor in its matching script and correct any anchor that is not found exactly.";
  return prompt.replace(
    "At each checkpoint (30 seconds, 60 seconds, 3 minutes, 5 minutes, middle, ending, overall),",
    `${instruction}\n\nAt each checkpoint (30 seconds, 60 seconds, 3 minutes, 5 minutes, middle, ending, overall),`,
  );
}

const tournamentRun = await mapWithConcurrency(personas, concurrency, async (persona) => {
  const outputPath = path.join(outputDir, `${persona.id}.json`);
  const existing = await fs.readFile(outputPath, "utf8").catch(() => "");
  if (existing.trim()) {
    const receipt = existingManifest?.receipts?.find((row) => row?.persona_id === persona.id);
    if (!receipt || receipt.output_path !== outputPath || receipt.output_sha256 !== sha256(existing)) {
      throw new Error(`Existing viewer report ${persona.id} is not hash-bound by the current manifest.`);
    }
    return {
      persona_id: persona.id,
      panel_role: persona.panel_role,
      order: persona.order,
      output_path: outputPath,
      provider: "chatgpt_web",
      model: "gpt-5.6-sol",
      receipt_path: null,
      duration_ms: null,
      reused: true,
      output_sha256: sha256(existing),
    };
  }
  const prompt = reinforceExactAnchorContract(packet(persona));
  const result = await runChatGptWebPlanner({
    prompt,
    outputPath,
    workId: `source_viewer_${persona.id}_${sha256(candidate).slice(0, 8)}`,
    effort: "low",
    timeoutMs: 1_800_000,
    rateClass: "audience_staggered",
    minimumStartIntervalMs: startIntervalMs,
  });
  return {
    persona_id: persona.id,
    panel_role: persona.panel_role,
    order: persona.order,
    output_path: outputPath,
    provider: result.provider,
    model: result.model,
    receipt_path: result.bridge_receipt_path,
    duration_ms: result.bridge_duration_ms,
    output_sha256: sha256(await fs.readFile(outputPath)),
  };
});
const receipts = tournamentRun.results.filter(Boolean);

const manifest = {
  schema: "goldflow_simulated_manhwa_viewer_tournament_v2",
  candidate_path: candidatePath,
  candidate_sha256: sha256(candidate),
  reference_path: referencePath,
  reference_sha256: sha256(reference),
  candidate_title: candidateTitle,
  reference_title: referenceTitle,
  panel_seed: panelSeed,
  panel_profile_ids: personas.map((persona) => persona.id),
  control_viewer_count: personas.filter((persona) => persona.panel_role === "control").length,
  rotating_viewer_count: personas.filter((persona) => persona.panel_role === "rotating_challenger").length,
  viewer_count: personas.length,
  execution_concurrency: concurrency,
  start_interval_ms: startIntervalMs,
  launch_policy: "staggered_audience_v1",
  receipts,
  failures: tournamentRun.failures.map((failure) => ({
    persona_id: failure.item?.id ?? null,
    message: failure.message,
  })),
  current_batch_status: tournamentRun.failures.length ? "incomplete" : "completed",
  completed_at: new Date().toISOString(),
};
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
if (tournamentRun.failures.length) {
  throw new Error(`Viewer tournament incomplete for: ${tournamentRun.failures.map((failure) => failure.item?.id ?? failure.index).join(", ")}`);
}
