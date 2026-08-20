#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverYoutubeAnalyticsCheckpoints } from "./lib/youtube-analytics-monitor.mjs";

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

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const report = await discoverYoutubeAnalyticsCheckpoints({
    dataRoot: flags["data-root"] ?? process.env.ANIFACTORY_DATA_ROOT,
    channel: flags.channel ?? null,
    now: flags.now ?? new Date(),
  });
  if (flags.output) await writeJsonAtomic(path.resolve(flags.output), report);
  console.log(JSON.stringify({
    ...report,
    output_path: flags.output ? path.resolve(flags.output) : null,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
