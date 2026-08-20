#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./lib/file-hash.mjs";
import {
  buildAnalyticsLearningApproval,
  buildAnalyticsLearningProposal,
} from "./lib/analytics-learning-proposal.mjs";

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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function main() {
  const [action = "propose", ...parts] = process.argv.slice(2);
  const flags = parseFlags(parts);
  if (action === "propose") {
    const aggregatePath = path.resolve(flags.aggregate ?? "");
    const changesPath = path.resolve(flags.changes ?? "");
    if (!flags.aggregate || !flags.changes) throw new Error("propose requires --aggregate and --changes.");
    const [aggregate, changesDocument, aggregateSha256] = await Promise.all([
      readJson(aggregatePath),
      readJson(changesPath),
      sha256File(aggregatePath),
    ]);
    const proposal = buildAnalyticsLearningProposal({
      aggregate,
      aggregatePath,
      aggregateSha256,
      changes: changesDocument.changes ?? changesDocument,
    });
    const outputPath = path.resolve(flags.output ?? "youtube_analytics_learning_proposal.json");
    await writeJsonAtomic(outputPath, proposal);
    console.log(JSON.stringify({ status: proposal.status, output_path: outputPath, proposal_sha256: proposal.proposal_sha256 }, null, 2));
    return;
  }
  if (action === "approve") {
    const proposalPath = path.resolve(flags.proposal ?? "");
    if (!flags.proposal) throw new Error("approve requires --proposal.");
    const proposal = await readJson(proposalPath);
    const requested = String(flags["approved-change-ids"] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const approvedChangeIds = requested.includes("all") ? proposal.changes.map((change) => change.id) : requested;
    const approval = buildAnalyticsLearningApproval({
      proposal,
      approvedChangeIds,
      approvedBy: flags["approved-by"],
      note: flags.note,
    });
    const outputPath = path.resolve(flags.output ?? "youtube_analytics_learning_approval.json");
    await writeJsonAtomic(outputPath, approval);
    console.log(JSON.stringify({ status: approval.status, output_path: outputPath, approval_sha256: approval.approval_sha256 }, null, 2));
    return;
  }
  throw new Error(`Unknown analytics learning action: ${action}.`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
