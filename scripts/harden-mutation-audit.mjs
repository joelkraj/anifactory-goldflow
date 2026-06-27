#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = "/Users/joel/anifactory-goldflow";
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const outputDir = path.resolve(flags.output ?? path.join(repoRoot, "scratch", "harden-mutation-audit"));
const modes = String(flags.modes ?? "sanitize,repair").split(",").map((value) => value.trim()).filter(Boolean);
const episodeDirs = resolveEpisodeDirs(flags);

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

async function exists(filePath) {
  return Boolean(filePath) && fs.stat(filePath).then(() => true).catch(() => false);
}

function normalizeLabel(value) {
  return String(value ?? "").trim().replace(/[^a-z0-9._-]+/gi, "_");
}

function resolveEpisodeDirs(inputFlags) {
  if (inputFlags["episode-dirs"]) {
    return String(inputFlags["episode-dirs"]).split(",").map((value) => path.resolve(value.trim())).filter(Boolean);
  }
  const defaults = [
    path.join(dataRoot, "channels/53rebirth/weekly_runs/current/episodes/ep_01"),
    path.join(dataRoot, "channels/53rebirth/weekly_runs/2026-W26-poisoned-wife-regression-v1/episodes/ep_01"),
    path.join(dataRoot, "channels/53rebirth/weekly_runs/2026-W25-reincarnated-simp-world-part-2-v1/episodes/ep_02"),
    path.join(dataRoot, "channels/53rebirth/weekly_runs/2026-W25-law-school-regression-ledger-v1/episodes/ep_01"),
  ];
  return defaults;
}

async function runNodeScript(scriptPath, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function mergeFunctionStats(target, source, runLabel) {
  if (!target[source.function_name]) {
    target[source.function_name] = {
      function_name: source.function_name,
      call_count: 0,
      matched_count: 0,
      changed_count: 0,
      examples: [],
      runs: [],
    };
  }
  const row = target[source.function_name];
  row.call_count += Number(source.call_count ?? 0);
  row.matched_count += Number(source.matched_count ?? 0);
  row.changed_count += Number(source.changed_count ?? 0);
  row.runs.push({
    run: runLabel,
    call_count: Number(source.call_count ?? 0),
    matched_count: Number(source.matched_count ?? 0),
    changed_count: Number(source.changed_count ?? 0),
  });
  for (const example of source.examples ?? []) {
    if (row.examples.length >= 4) break;
    row.examples.push({ run: runLabel, ...example });
  }
}

function summarizeFunctions(functions) {
  return Object.values(functions)
    .sort((a, b) => b.changed_count - a.changed_count || b.matched_count - a.matched_count || a.function_name.localeCompare(b.function_name))
    .map((row) => ({
      ...row,
      classification: row.changed_count > 0 ? "live" : "dead",
    }));
}

function markdownReport({ runs, functions }) {
  const lines = [
    "# Harden Mutation Audit",
    "",
    `Runs: ${runs.length}`,
    "",
    "| Function | Class | Changed | Matched | Calls |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  for (const row of functions) {
    lines.push(`| ${row.function_name} | ${row.classification} | ${row.changed_count} | ${row.matched_count} | ${row.call_count} |`);
  }
  for (const row of functions.filter((entry) => entry.changed_count > 0)) {
    lines.push("");
    lines.push(`## ${row.function_name}`);
    for (const example of row.examples) {
      lines.push("");
      lines.push(`- Run: ${example.run} (${example.image_id ?? "no image_id"})`);
      lines.push("");
      lines.push("```text");
      lines.push(`BEFORE: ${example.before}`);
      lines.push(`AFTER: ${example.after}`);
      lines.push("```");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const runs = [];
  const functions = {};
  for (const episodeDir of episodeDirs) {
    const prompts = path.join(episodeDir, "section_image_prompts_reviewed.json");
    const timed = path.join(episodeDir, "timed_scene_plan.json");
    const visualRefs = path.join(episodeDir, "visual_reference_plan.json");
    const characterStateRefs = path.join(episodeDir, "character_state_refs.json");
    const required = [prompts, timed, visualRefs, characterStateRefs];
    const missing = [];
    for (const filePath of required) {
      if (!await exists(filePath)) missing.push(filePath);
    }
    if (missing.length) {
      throw new Error(`Missing required episode artifacts for ${episodeDir}: ${missing.join(", ")}`);
    }
    for (const mode of modes) {
      const runLabel = `${path.basename(path.dirname(episodeDir))}/${path.basename(episodeDir)}:${mode}`;
      const slug = normalizeLabel(path.relative(dataRoot, episodeDir));
      const runDir = path.join(outputDir, slug, mode);
      await fs.mkdir(runDir, { recursive: true });
      const hitsPath = path.join(runDir, "harden_mutation_hits.json");
      const result = await runNodeScript(path.join(repoRoot, "scripts/visual-prompt-harden.mjs"), [
        "--prompts", prompts,
        "--timed", timed,
        "--visual-refs", visualRefs,
        "--character-state-refs", characterStateRefs,
        "--output", path.join(runDir, "section_image_prompts_hardened.json"),
        "--report-output", path.join(runDir, "visual_prompt_hardening_report.json"),
        "--sample-output", path.join(runDir, "visual_prompt_hardening_sample.md"),
        "--mutation-hits-output", hitsPath,
        "--mode", mode,
      ]);
      if (!await exists(hitsPath)) {
        throw new Error(`visual-prompt-harden did not write mutation hits for ${runLabel} (exit ${result.code})\n${result.stdout}\n${result.stderr}`);
      }
      const hits = JSON.parse(await fs.readFile(hitsPath, "utf8"));
      runs.push({
        run: runLabel,
        episode_dir: episodeDir,
        mode,
        prompt_count: hits.prompt_count,
        harden_status: hits.status,
        exit_code: result.code,
      });
      for (const fn of hits.functions ?? []) {
        mergeFunctionStats(functions, fn, runLabel);
      }
    }
  }
  const summary = {
    schema: "goldflow_harden_mutation_audit_v1",
    output_dir: outputDir,
    run_count: runs.length,
    runs,
    functions: summarizeFunctions(functions),
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "summary.md"), markdownReport(summary), "utf8");
  console.log(JSON.stringify({ status: "passed", output_dir: outputDir, run_count: runs.length, live_function_count: summary.functions.filter((row) => row.classification === "live").length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
