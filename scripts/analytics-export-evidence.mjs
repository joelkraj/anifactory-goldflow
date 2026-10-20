#!/usr/bin/env node
// goldflow analytics export-evidence --channel <id> [--output <md>] [--outliers <vidiq-export.json>]
//   [--settings <setting-tags.json>] [--hit-views 10000] [--measured-on YYYY-MM-DD]
import { exportPremiseEvidence } from "./lib/analytics-evidence-export.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

async function main() {
  const result = await exportPremiseEvidence({
    dataRoot,
    channel: flags.channel,
    outputPath: flags.output ?? null,
    outliersPath: flags.outliers ?? null,
    settingsPath: flags.settings ?? null,
    hitViews: flags["hit-views"] != null ? Number(flags["hit-views"]) : undefined,
    measuredOn: flags["measured-on"] ?? null,
  });
  console.log(JSON.stringify({ status: "passed", output_path: result.outputPath, receipt_path: result.receiptPath, uploads: result.receipt.uploads, uploads_with_snapshots: result.receipt.uploads_with_snapshots, external_outliers: result.receipt.external_outliers?.rows ?? 0, next_action: `goldflow source manufacture run --development-slug <slug> --evidence ${JSON.stringify(result.outputPath)}` }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
