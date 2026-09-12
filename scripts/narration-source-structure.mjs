#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/file-hash.mjs";
import { canonicalNarrationPlanSha256 } from "./lib/narration-pre-synthesis-gate.mjs";
import {
  buildNarrationSourceStructure,
  loadNarrationSourceStructure,
  NARRATION_SOURCE_STRUCTURE_ATTESTATION,
} from "./lib/narration-source-structure.mjs";

async function main() {
  const flags = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    flags[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
  }
  if (!flags["episode-dir"]) throw new Error("--episode-dir is required.");
  if (flags.attestation !== NARRATION_SOURCE_STRUCTURE_ATTESTATION) {
    throw new Error(`--attestation ${NARRATION_SOURCE_STRUCTURE_ATTESTATION} is required after reviewing source structure.`);
  }
  const episodeDir = path.resolve(flags["episode-dir"]);
  const identity = JSON.parse(await fs.readFile(path.join(episodeDir, "run_identity.json"), "utf8"));
  if (identity.media_workflow && identity.media_workflow !== "generated_visuals_v1") {
    throw new Error("Source-structure sidecars are supported only for generated-visuals narration.");
  }
  const episode = identity.episode;
  if (!episode) throw new Error("Run identity lacks an episode.");
  const planPath = path.join(episodeDir, "narration_generation_plan.json");
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  if (plan.status !== "passed") throw new Error("A passed narration generation plan is required.");
  if (plan.plan_sha256 && plan.plan_sha256 !== canonicalNarrationPlanSha256(plan)) {
    throw new Error("Narration generation plan canonical hash is invalid.");
  }
  const sourceScriptSha256 = await sha256File(path.join(episodeDir, "script_clean.md"));
  if ((plan.source_script_hash ?? plan.source_hashes?.script_clean_sha256) !== sourceScriptSha256) {
    throw new Error("Narration plan does not match the exact source script.");
  }
  const generationPlanFileSha256 = await sha256File(planPath);
  const context = { episodeDir, episode, plan, sourceScriptSha256, generationPlanFileSha256,
    generationPlanSha256: plan.plan_sha256 ?? generationPlanFileSha256 };
  const chapters = flags.chapters ? JSON.parse(await fs.readFile(path.resolve(flags.chapters), "utf8")) : [];
  const map = buildNarrationSourceStructure({ ...context, structureKind: flags.kind,
    chapters, reviewer: flags.reviewer, note: flags.note });
  const existing = await loadNarrationSourceStructure(context);
  if (existing && existing.map.structure_sha256 !== map.structure_sha256) {
    throw new Error("An existing source-structure map is immutable; inspect its exact scope before any replacement.");
  }
  const outputPath = path.join(episodeDir, `narration_source_structure_${episode}.json`);
  if (!existing) await fs.writeFile(outputPath, `${JSON.stringify(map, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ status: "passed", output_path: outputPath,
    structure_kind: map.structure_kind, declared_chapter_count: map.chapters.length,
    structure_sha256: map.structure_sha256, media_modified: false }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
