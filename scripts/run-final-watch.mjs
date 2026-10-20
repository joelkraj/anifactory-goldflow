#!/usr/bin/env node
// Human step 1 of an autopilot run: record the final watch of the exact master.
import { promises as fs } from "node:fs";
import path from "node:path";
import { episodeDirForFlags } from "./lib/execution-provenance.mjs";
import { autopilotEnabled } from "./lib/autopilot-policy.mjs";
import { recordFinalWatch } from "./lib/autopilot-publish.mjs";

const flags = {};
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if (!args[index].startsWith("--")) continue;
  const next = args[index + 1];
  flags[args[index].slice(2)] = next && !next.startsWith("--") ? (index += 1, next) : "true";
}

try {
  const episodeDir = episodeDirForFlags(flags, process.env);
  const identity = JSON.parse(await fs.readFile(path.join(episodeDir, "run_identity.json"), "utf8"));
  if (!autopilotEnabled(identity)) throw new Error("run final-watch applies to autopilot identities only.");
  const result = await recordFinalWatch({
    episodeDir, episode: identity.episode ?? path.basename(episodeDir),
    decision: flags.decision, reviewer: flags.reviewer, note: flags.note,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
