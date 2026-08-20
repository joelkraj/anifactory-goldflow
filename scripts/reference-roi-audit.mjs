#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { episodeDirForFlags } from "./lib/execution-provenance.mjs";
import {
  buildReferenceRoiAudit,
  renderReferenceRoiMarkdown,
} from "./lib/reference-roi-audit.mjs";

function parseFlags(parts) {
  const flags = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--")
      ? parts[++index]
      : "true";
    flags[key] = value;
  }
  return flags;
}

export async function runReferenceRoiAudit(flags = {}) {
  const episodeDir = episodeDirForFlags(flags, process.env);
  if (!episodeDir) throw new Error("run reference-roi requires --episode-dir or channel/week/episode flags.");
  const identity = await fs.readFile(path.join(episodeDir, "run_identity.json"), "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
  const episode = identity.episode ?? flags.episode ?? "ep_01";
  const report = await buildReferenceRoiAudit({ episodeDir, episode });
  const outputDir = path.resolve(flags["output-dir"] ?? path.join(episodeDir, "reports", "performance"));
  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `reference_roi_${episode}.json`);
  const markdownPath = path.join(outputDir, `reference_roi_${episode}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, renderReferenceRoiMarkdown(report), "utf8");
  return { report, jsonPath, markdownPath };
}

async function main() {
  try {
    const result = await runReferenceRoiAudit(parseFlags(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      status: result.report.status,
      selected_asset_count: result.report.summary?.selected_asset_count ?? 0,
      generated_reference_count: result.report.summary?.generated_reference_count ?? 0,
      zero_attachment_reference_count: result.report.summary?.zero_attachment_reference_count ?? 0,
      json_path: result.jsonPath,
      markdown_path: result.markdownPath,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
