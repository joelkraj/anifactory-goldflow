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
  assembleWinnerScriptWithApprovedOpening,
} from "../lib/winner-source-room-contract.mjs";
import {
  scriptWithWordCount,
  validBlueprintAudienceAudit,
  validBlueprintV2,
  validDiagnostic,
  validFormula,
  validIdeation,
  validRetentionMap,
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
  const researchResponsePath = path.join(scratchRoot, "research_response.md");
  const ideationResponsePath = path.join(scratchRoot, "ideation_response.json");
  const blueprintResponsePath = path.join(scratchRoot, "blueprint_response.json");
  const blueprintAuditResponsePath = path.join(scratchRoot, "blueprint_audit_response.json");
  const retentionMapResponsePath = path.join(scratchRoot, "retention_map_response.json");
  const openingResponsePath = path.join(scratchRoot, "opening_response.md");
  const scriptResponsePath = path.join(scratchRoot, "script_response.md");
  const causalResponsePath = path.join(scratchRoot, "causal_response.json");
  const emotionalResponsePath = path.join(scratchRoot, "emotional_response.json");
  const retentionResponsePath = path.join(scratchRoot, "retention_response.json");
  const revisionResponsePath = path.join(scratchRoot, "revision_response.md");
  const polishResponsePath = path.join(scratchRoot, "polish_response.md");
  const openingText = normalizeWinnerNarration(scriptWithWordCount(500));
  const continuation = (prefix) => normalizeWinnerNarration(`${Array.from(
    { length: 500 },
    (_, index) => `${prefix}${index}`,
  ).join(" ")}.`);
  const draftContinuation = continuation("draft");
  const revisedContinuation = continuation("revised");
  const polishedContinuation = continuation("polished");
  const expectedDraftScript = assembleWinnerScriptWithApprovedOpening(openingText, draftContinuation);
  const expectedRevisedScript = assembleWinnerScriptWithApprovedOpening(openingText, revisedContinuation);
  const expectedScript = assembleWinnerScriptWithApprovedOpening(openingText, polishedContinuation);

  try {
    await writeJson(formulaPath, formula);
    await fs.writeFile(researchResponsePath, `${"Evidence-grounded research finding. ".repeat(40)}\n\n# Sources\n${[
      "https://example.com/source-one",
      "https://example.com/source-two",
      "https://example.com/source-three",
      "https://example.com/source-four",
      "https://example.com/source-five",
    ].join("\n")}\n`, "utf8");
    await writeJson(ideationResponsePath, ideation);
    const blueprintFixture = validBlueprintV2();
    await writeJson(blueprintResponsePath, blueprintFixture);
    await writeJson(retentionMapResponsePath, validRetentionMap({ blueprint: blueprintFixture }));
    await fs.writeFile(openingResponsePath, openingText, "utf8");
    await fs.writeFile(scriptResponsePath, draftContinuation, "utf8");
    await writeJson(causalResponsePath, validDiagnostic("causal_flow", expectedDraftScript));
    await writeJson(emotionalResponsePath, validDiagnostic("emotional_drama", expectedDraftScript));
    await writeJson(retentionResponsePath, validDiagnostic("retention_repetition", expectedDraftScript));
    await fs.writeFile(revisionResponsePath, revisedContinuation, "utf8");
    await fs.writeFile(polishResponsePath, polishedContinuation, "utf8");

    await runGoldflow([
      "source", "research",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--creative-brief", "Identify current package and retention evidence.",
      "--planning-provider", "chatgpt_web",
      "--response-path", researchResponsePath,
    ], { dataRoot });

    const researchReceipt = await readJson(path.join(developmentDir, "source_web_research_receipt.json"));
    assert.equal(researchReceipt.status, "passed");
    assert.equal(researchReceipt.research_mode, "chatgpt_web_planning_room_research");
    assert.equal(researchReceipt.source_model_contract.provider, "chatgpt_web");
    assert.equal(researchReceipt.source_model_contract.reasoning_effort, "medium");
    assert.equal(researchReceipt.source_model_contract.visible_effort, "Medium");
    assert.equal(researchReceipt.exported_source_url_count, 5);

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
    assert.equal(ideationReport.source_web_research_report_sha256, researchReceipt.report_sha256);

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
      "source", "blueprint",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--response-path", blueprintResponsePath,
    ], { dataRoot });

    const blueprintPath = path.join(developmentDir, "winner_story_blueprint.json");
    const blueprintDocument = await readJson(blueprintPath);
    const blueprintReport = await readJson(path.join(developmentDir, "winner_story_blueprint_report.json"));
    assert.equal(blueprintDocument.status, "planned");
    assert.equal(blueprintDocument.development_slug, developmentSlug);
    assert.equal(blueprintDocument.winner_package_sha256, packageApproval.winner_package_sha256);
    assert.equal(blueprintReport.status, "passed");

    await assert.rejects(
      () => runGoldflow([
        "source", "approve-blueprint",
        "--channel", channel,
        "--development-slug", developmentSlug,
        "--formula", formulaPath,
        "--approve", "true",
        "--approved-by", "cli-test-agent",
      ], { dataRoot }),
      (error) => `${error?.message ?? ""}\n${error?.stderr ?? ""}`.includes("winner_blueprint_audience_audit.json"),
    );

    const blueprintAuditPath = path.join(developmentDir, "winner_blueprint_audience_audit.json");
    await writeJson(blueprintAuditResponsePath, validBlueprintAudienceAudit({
      blueprint: blueprintDocument,
      packageSha256: packageApproval.winner_package_sha256,
      decision: "revise",
    }));
    await runGoldflow([
      "source", "blueprint-audit",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--response-path", blueprintAuditResponsePath,
    ], { dataRoot });
    assert.equal((await readJson(blueprintAuditPath)).decision, "revise");
    await assert.rejects(
      () => runGoldflow([
        "source", "approve-blueprint",
        "--channel", channel,
        "--development-slug", developmentSlug,
        "--formula", formulaPath,
        "--approve", "true",
        "--approved-by", "cli-test-agent",
      ], { dataRoot }),
      (error) => `${error?.message ?? ""}\n${error?.stderr ?? ""}`.includes("requires revision"),
    );
    await runGoldflow([
      "source", "approve-blueprint",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--approve", "true",
      "--approved-by", "cli-test-operator",
      "--approve-risk", "true",
      "--risk-reason", "CLI fixture deliberately exercises an explicit architecture-risk override.",
    ], { dataRoot });
    const overriddenApproval = await readJson(path.join(developmentDir, "winner_story_blueprint_approval.json"));
    assert.equal(overriddenApproval.audience_audit_risk_override.approved, true);
    assert.equal(overriddenApproval.audience_audit_risk_override.original_decision, "revise");

    await writeJson(blueprintAuditResponsePath, validBlueprintAudienceAudit({
      blueprint: blueprintDocument,
      packageSha256: packageApproval.winner_package_sha256,
    }));
    await runGoldflow([
      "source", "blueprint-audit",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--response-path", blueprintAuditResponsePath,
    ], { dataRoot });
    const blueprintAudit = await readJson(blueprintAuditPath);
    const blueprintAuditReport = await readJson(path.join(developmentDir, "winner_blueprint_audience_audit_report.json"));
    assert.equal(blueprintAudit.decision, "pass");
    assert.equal(blueprintAudit.winner_story_blueprint_sha256, blueprintReport.winner_story_blueprint_sha256);
    assert.equal(blueprintAuditReport.status, "passed");

    await runGoldflow([
      "source", "approve-blueprint",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--approve", "true",
      "--approved-by", "cli-test-agent",
    ], { dataRoot });
    const blueprintApproval = await readJson(path.join(developmentDir, "winner_story_blueprint_approval.json"));
    assert.equal(blueprintApproval.status, "approved");
    assert.equal(blueprintApproval.winner_story_blueprint_path, blueprintPath);
    assert.equal(blueprintApproval.winner_blueprint_audience_audit_path, blueprintAuditPath);
    assert.equal(blueprintApproval.winner_blueprint_audience_audit_decision, "pass");

    await runGoldflow([
      "source", "retention-map",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--response-path", retentionMapResponsePath,
    ], { dataRoot });
    const retentionMapPath = path.join(developmentDir, "winner_retention_map.json");
    const retentionMapDocument = await readJson(retentionMapPath);
    const retentionMapReport = await readJson(path.join(developmentDir, "winner_retention_map_report.json"));
    assert.equal(retentionMapDocument.status, "planned");
    assert.equal(retentionMapReport.status, "passed");
    assert.equal(retentionMapDocument.winner_story_blueprint_sha256, blueprintApproval.winner_story_blueprint_sha256);

    await runGoldflow([
      "source", "opening",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--response-path", openingResponsePath,
    ], { dataRoot });
    const openingPath = path.join(developmentDir, "winner_opening.md");
    const openingReport = await readJson(path.join(developmentDir, "winner_opening_report.json"));
    assert.equal(await fs.readFile(openingPath, "utf8"), openingText);
    assert.equal(openingReport.status, "passed");
    assert.equal(openingReport.opening_word_count, 500);

    await runGoldflow([
      "source", "approve-opening",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--approve", "true",
      "--approved-by", "cli-test-agent",
    ], { dataRoot });
    const openingApproval = await readJson(path.join(developmentDir, "winner_opening_approval.json"));
    assert.equal(openingApproval.status, "approved");
    assert.equal(openingApproval.opening_path, openingPath);

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
    assert.equal(scriptCandidate, expectedDraftScript);
    assert.match(scriptPrompt, /TARGET CONTINUATION WORD RANGE/);
    assert.match(scriptPrompt, /EXACT APPROVED FIVE-MINUTE OPENING/);
    assert.match(scriptPrompt, /BINDING APPROVED STORY BLUEPRINT JSON/);
    assert.match(scriptPrompt, /"pov": "third_person"/);
    assert.equal(generationReport.status, "passed");
    assert.equal(generationReport.source_word_count, 1000);
    assert.equal(generationReport.source_script_sha256, sha256Text(expectedDraftScript));
    assert.equal(generationReport.winner_story_blueprint_sha256, blueprintApproval.winner_story_blueprint_sha256);
    assert.equal(generationReport.winner_retention_map_sha256, retentionMapReport.winner_retention_map_sha256);
    assert.equal(generationReport.winner_opening_sha256, openingApproval.opening_sha256);
    assert.deepEqual(generationReport.deterministic_review.blockers, []);

    await runGoldflow([
      "source", "diagnose",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--causal-flow-response-path", causalResponsePath,
      "--emotional-drama-response-path", emotionalResponsePath,
      "--retention-repetition-response-path", retentionResponsePath,
    ], { dataRoot });
    const diagnosticsManifest = await readJson(path.join(developmentDir, "winner_development_diagnostics_manifest.json"));
    assert.equal(diagnosticsManifest.status, "passed");
    assert.equal(diagnosticsManifest.source_script_sha256, sha256Text(expectedDraftScript));
    assert.equal(diagnosticsManifest.reports.length, 3);

    await runGoldflow([
      "source", "revise",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--response-path", revisionResponsePath,
    ], { dataRoot });
    const revisedScriptPath = path.join(developmentDir, "script_revised.md");
    const revisionReport = await readJson(path.join(developmentDir, "winner_integrated_revision_report.json"));
    assert.equal(await fs.readFile(revisedScriptPath, "utf8"), expectedRevisedScript);
    assert.equal(revisionReport.status, "passed");
    assert.equal(revisionReport.source_script_sha256, sha256Text(expectedDraftScript));
    assert.equal(revisionReport.output_script_sha256, sha256Text(expectedRevisedScript));

    await runGoldflow([
      "source", "polish",
      "--channel", channel,
      "--development-slug", developmentSlug,
      "--formula", formulaPath,
      "--response-path", polishResponsePath,
    ], { dataRoot });
    const finalScriptPath = path.join(developmentDir, "script_final.md");
    const polishReport = await readJson(path.join(developmentDir, "winner_line_flow_polish_report.json"));
    assert.equal(await fs.readFile(finalScriptPath, "utf8"), expectedScript);
    assert.equal(polishReport.status, "passed");
    assert.equal(polishReport.source_script_sha256, sha256Text(expectedRevisedScript));
    assert.equal(polishReport.output_script_sha256, sha256Text(expectedScript));

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
    assert.equal(release.winner_story_blueprint_sha256, blueprintApproval.winner_story_blueprint_sha256);
    assert.equal(release.winner_blueprint_audience_audit_sha256, blueprintApproval.winner_blueprint_audience_audit_sha256);
    assert.equal(release.winner_blueprint_audience_audit_decision, "pass");

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
      "--content-profile", "manhwa_recap_v1",
      "--media-workflow", "generated_visuals_v1",
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
    assert.equal(runIdentity.winner_source_release.winner_story_blueprint_sha256, release.winner_story_blueprint_sha256);
    assert.equal(runIdentity.winner_source_release.winner_blueprint_audience_audit_sha256, release.winner_blueprint_audience_audit_sha256);
    assert.equal(runIdentity.winner_source_release.winner_blueprint_audience_audit_decision, "pass");
    assert.equal(runIdentity.winner_source_release.winner_retention_map_sha256, release.winner_retention_map_sha256);
    assert.equal(runIdentity.winner_source_release.winner_opening_sha256, release.winner_opening_sha256);
    assert.equal(
      runIdentity.winner_source_release.winner_development_diagnostics_manifest_sha256,
      release.winner_development_diagnostics_manifest_sha256,
    );
    assert.equal(
      runIdentity.winner_source_release.winner_line_flow_polish_report_sha256,
      release.winner_line_flow_polish_report_sha256,
    );

    await runGoldflow([
      "ingest", "source",
      ...identityArgs,
    ], { dataRoot });

    const ingestReport = await readJson(path.join(episodeDir, "source_story_ingest_report.json"));
    assert.equal(ingestReport.winner_source_release.binding_source, "run_identity");
    assert.equal(ingestReport.winner_source_release.release_path, releasePath);
    assert.equal(ingestReport.winner_source_release.source_script_sha256, release.source_script_sha256);
    assert.equal(ingestReport.winner_source_release.winner_story_blueprint_sha256, release.winner_story_blueprint_sha256);
    assert.equal(ingestReport.winner_source_release.winner_blueprint_audience_audit_sha256, release.winner_blueprint_audience_audit_sha256);
    assert.equal(ingestReport.winner_source_release.winner_blueprint_audience_audit_decision, "pass");
    assert.equal(ingestReport.winner_source_release.winner_retention_map_sha256, release.winner_retention_map_sha256);
    assert.equal(ingestReport.winner_source_release.winner_opening_sha256, release.winner_opening_sha256);
    assert.equal(ingestReport.script_clean_hash, release.source_script_sha256);
    assert.equal(await fs.readFile(path.join(episodeDir, "script_clean.md"), "utf8"), expectedScript);

    const tamperedSourcePath = path.join(scratchRoot, "tampered_source.md");
    await fs.writeFile(tamperedSourcePath, `${expectedScript.trim()} changed\n`, "utf8");
    await assert.rejects(
      () => runGoldflow([
        "run", "preflight",
        "--content-profile", "manhwa_recap_v1",
        "--media-workflow", "generated_visuals_v1",
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
