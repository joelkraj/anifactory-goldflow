#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLowMarginDisposition, lowMarginDispositionArchivePath, persistLowMarginDisposition,
  readLowMarginContext, readLowMarginDispositionRecord, verifyLowMarginAudioEvidence } from "./lib/narration-low-margin-disposition.mjs";

async function main() {
  const flags = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
  }
  if (!flags["episode-dir"]) throw new Error("--episode-dir is required.");
  if (Boolean(flags["unit-ids"]) === Boolean(flags["unit-ids-file"])) {
    throw new Error("Provide exact --unit-ids or a JSON array through --unit-ids-file.");
  }
  const episodeDir = path.resolve(flags["episode-dir"]);
  const identity = JSON.parse(await fs.readFile(path.join(episodeDir, "run_identity.json"), "utf8"));
  const episode = identity.episode;
  const previous = await readLowMarginDispositionRecord({ episodeDir, episode });
  const supersedeDisposition = flags["supersede-disposition"] ?? null;
  if (previous && !supersedeDisposition) {
    throw new Error("Existing low-margin disposition is immutable; retain it and inspect exact recovery scope.");
  }
  if (supersedeDisposition && supersedeDisposition !== previous?.receipt.disposition_sha256) {
    throw new Error("--supersede-disposition must name the exact active disposition SHA.");
  }
  const context = await readLowMarginContext({ episodeDir, episode });
  const unitIds = flags["unit-ids-file"]
    ? JSON.parse(await fs.readFile(path.resolve(flags["unit-ids-file"]), "utf8"))
    : flags["unit-ids"].split(",").map((id) => id.trim());
  const receipt = buildLowMarginDisposition({ context, unitIds, reviewer: flags.reviewer, reason: flags.reason,
    previous, supersedeDisposition, archivePath: previous
      ? lowMarginDispositionArchivePath(episodeDir, episode, supersedeDisposition) : null });
  // Renewal relies on the new complete aggregate, including the repaired take
  // outside the selected advisory scope. Verify every current candidate WAV.
  await verifyLowMarginAudioEvidence(context, unitIds, { renewal: Boolean(previous) });
  // Recheck inputs after file verification so this command cannot bind a concurrent replacement.
  const current = await readLowMarginContext({ episodeDir, episode });
  if (JSON.stringify(current.bindings) !== JSON.stringify(context.bindings)) throw new Error("Narration inputs changed while recording disposition.");
  const outputPath = await persistLowMarginDisposition({ episodeDir, episode, receipt, previous });
  console.log(JSON.stringify({ status: receipt.status, output_path: outputPath,
    disposition_sha256: receipt.disposition_sha256, exact_unit_count: receipt.units.length,
    ...(receipt.supersedes ? { supersedes: receipt.supersedes } : {}),
    human_listening_performed: false, media_modified: false,
    next: "Run status; refresh finalization from retained audio/checkpoints after any active finalizer exits." }, null, 2));
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
