import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  normalizeWinnerNarration,
  sha256Text,
  validateWinnerSourceRelease,
} from "../lib/winner-source-contract.mjs";
import {
  scriptWithWordCount,
  validFormula,
  validIdeation,
} from "./winner-source-contract-tests.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const goldflowPath = path.join(repoRoot, "bin", "goldflow.mjs");

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function runGoldflow(args, { dataRoot }) {
  return execFileAsync(process.execPath, [goldflowPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ANIFACTORY_DATA_ROOT: dataRoot,
    },
    maxBuffer: 1024 * 1024 * 16,
  });
}

export async function runWinnerSourceCliTests() {
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-winner-source-cli-"));
  const dataRoot = path.join(scratchRoot, "data");
  const channel = "53rebirth";
  const developmentSlug = "cli-winner-integration";
  const developmentDir = path.join(
    dataRoot,
    "channels",
    channel,
    "source_development",
    developmentSlug,
  );
  const formula = validFormula();
  const ideation = validIdeation();
  const formulaPath = path.join(scratchRoot, "winner_formula.json");
  const ideationResponsePath = path.join(scratchRoot, "ideation_response.json");
  const scriptResponsePath = path.join(scratchRoot, "script_response.md");
  const expectedScript = normalizeWinnerNarration(scriptWithWordCount(1000));

  try {
    await writeJson(formulaPath, formula);
    await writeJson(ideationResponsePath, ideation);
    await fs.writeFile(scriptResponsePath, expectedScript, "utf8");

    await runGoldflow([
      "source", "ideate",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--response-path", ideationResponsePath,
    ], { dataRoot });

    const ideationPath = path.join(developmentDir, "winner_ideation_candidates.json");
    const ideationReport = await readJson(path.join(developmentDir, "winner_ideation_report.json"));
    assert.equal((await readJson(ideationPath)).status, "passed");
    assert.equal(ideationReport.status, "passed");
    assert.equal(ideationReport.scoring_authority, "imported_prejudged_response");
    assert.equal(ideationReport.eligible_candidate_count, 6);

    await runGoldflow([
      "source", "approve-package",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--candidate-id", "wife_sold_home",
      "--approve", "true",
      "--approved-by", "cli-test-operator",
    ], { dataRoot });

    const packagePath = path.join(developmentDir, "winner_package_contract.json");
    const packageContract = await readJson(packagePath);
    const packageApproval = await readJson(path.join(developmentDir, "winner_package_approval.json"));
    assert.equal(packageContract.selected_candidate_id, "wife_sold_home");
    assert.equal(packageApproval.status, "approved");
    assert.equal(packageApproval.winner_package_path, packagePath);

    await runGoldflow([
      "source", "script",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--response-path", scriptResponsePath,
    ], { dataRoot });

    const scriptCandidatePath = path.join(developmentDir, "script_candidate.md");
    const scriptCandidate = await fs.readFile(scriptCandidatePath, "utf8");
    const scriptPrompt = await fs.readFile(path.join(developmentDir, "winner_script_prompt.md"), "utf8");
    const generationReport = await readJson(path.join(developmentDir, "winner_script_generation_report.json"));
    assert.equal(scriptCandidate, expectedScript);
    assert.match(scriptPrompt, /Execution bridge:/);
    assert.match(scriptPrompt, /Decisive application examples:/);
    assert.match(scriptPrompt, /"role":"first_proof"/);
    assert.match(scriptPrompt, /"role":"climax_or_late_scale_proof"/);
    assert.doesNotMatch(scriptPrompt, /\[INSERT THE NON-NEGOTIABLE ACQUISITION/);
    assert.equal(generationReport.status, "passed");
    assert.equal(generationReport.source_word_count, 1000);
    assert.equal(generationReport.source_script_sha256, sha256Text(expectedScript));
    assert.deepEqual(generationReport.deterministic_review.blockers, []);

    const gatePath = path.join(developmentDir, "winner_script_gate.json");
    await assert.rejects(fs.access(gatePath));

    await runGoldflow([
      "source", "release",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--approve", "true",
      "--approved-by", "cli-test-operator",
    ], { dataRoot });

    const releasePath = path.join(developmentDir, "winner_source_release.json");
    const release = await readJson(releasePath);
    const releasedSource = await fs.readFile(release.source_path, "utf8");
    const releaseValidation = validateWinnerSourceRelease(release, {
      sourceText: releasedSource,
      packageContract,
    });
    assert.deepEqual(releaseValidation, { done: true, blockers: [] });
    assert.equal(release.source_script_sha256, sha256Text(expectedScript));
    assert.equal(releasedSource, expectedScript);
    assert.equal(release.source_review_log_path, null);
    assert.equal(release.source_review_log_sha256, null);
    assert.equal(release.source_review_log_decision, null);
    assert.equal(release.retention_weighted_score, null);

    const series = "winner-cli-series";
    const week = "winner-cli-run";
    const episode = "ep_01";
    const identityArgs = [
      "--channel", channel,
      "--series", series,
      "--week", week,
      "--episode", episode,
      "--title", release.selected_title,
      "--source", release.source_path,
      "--winner-release", releasePath,
    ];
    await runGoldflow([
      "run", "preflight",
      ...identityArgs,
      "--intent", "diagnostic",
      "--allow-dirty-worktree", "true",
      "--dirty-reason", "winner-source CLI hash-binding integration test",
    ], { dataRoot });

    const episodeDir = path.join(
      dataRoot,
      "channels",
      channel,
      "weekly_runs",
      week,
      "episodes",
      episode,
    );
    const runIdentity = await readJson(path.join(episodeDir, "run_identity.json"));
    assert.equal(runIdentity.winner_source_release.release_path, releasePath);
    assert.equal(runIdentity.winner_source_release.source_script_sha256, release.source_script_sha256);
    assert.equal(runIdentity.winner_source_release.winner_package_sha256, release.winner_package_sha256);

    await runGoldflow([
      "ingest", "source",
      ...identityArgs,
    ], { dataRoot });

    const ingestReport = await readJson(path.join(episodeDir, "source_story_ingest_report.json"));
    assert.equal(ingestReport.winner_source_release.binding_source, "run_identity");
    assert.equal(ingestReport.winner_source_release.release_path, releasePath);
    assert.equal(ingestReport.winner_source_release.source_script_sha256, release.source_script_sha256);
    assert.equal(ingestReport.script_clean_hash, release.source_script_sha256);
    assert.equal(await fs.readFile(path.join(episodeDir, "script_clean.md"), "utf8"), expectedScript);

    const tamperedSourcePath = path.join(scratchRoot, "tampered_source.md");
    await fs.writeFile(tamperedSourcePath, `${expectedScript.trim()} changed\n`, "utf8");
    await assert.rejects(
      () => runGoldflow([
        "run", "preflight",
        "--channel", channel,
        "--series", series,
        "--week", "winner-cli-tamper-check",
        "--episode", episode,
        "--title", release.selected_title,
        "--source", tamperedSourcePath,
        "--winner-release", releasePath,
        "--intent", "diagnostic",
        "--allow-dirty-worktree", "true",
        "--dirty-reason", "winner-source CLI tamper rejection test",
      ], { dataRoot }),
      (error) => `${error?.message ?? ""}\n${error?.stderr ?? ""}`.includes("does not match the released narration"),
    );
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runWinnerSourceCliTests();
  console.log("winner source CLI tests passed");
}
