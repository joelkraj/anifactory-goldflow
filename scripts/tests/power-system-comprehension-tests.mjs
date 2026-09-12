import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  materializePowerSystemComprehensionAudit,
  validatePowerSystemComprehensionAudit,
} from "../lib/power-system-comprehension-contract.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT = [
  "Joey had always carried the dormant Mirror skill.",
  "Bare contact with an active talent let Mirror copy one technique.",
  "It copied technique and practice, never raw strength, and stopped after thirty heartbeats.",
  "Joey touched Marcus while the sword talent was active.",
  "Mirror copied the sword talent, and Joey predicted the next strike.",
  "After mastering the copied pattern, Mirror evolved into Echo Mirror.",
  "Echo Mirror could preserve two learned patterns, but each one faded after one hour.",
  "Joey used Echo Mirror to counter two fighters at once.",
].join("\n");

function anchor(exactExcerpt) {
  const startOffset = SCRIPT.indexOf(exactExcerpt);
  assert.ok(startOffset >= 0, `Missing fixture excerpt: ${exactExcerpt}`);
  return { exact_excerpt: exactExcerpt, start_offset: startOffset, end_offset: startOffset + exactExcerpt.length };
}

function claim(summary, exactExcerpt, classification = undefined) {
  return { summary, ...(classification ? { classification } : {}), evidence: [anchor(exactExcerpt)] };
}

function candidate() {
  return {
    power_system_present: true,
    abilities: [
      {
        ability_id: "mirror",
        name: "Mirror",
        first_mention: anchor("Joey had always carried the dormant Mirror skill."),
        first_use: anchor("Joey touched Marcus while the sword talent was active."),
        first_payoff: anchor("Mirror copied the sword talent, and Joey predicted the next strike."),
        trigger: claim("Bare contact with an active talent.", "Bare contact with an active talent let Mirror copy one technique."),
        capability: claim("Copies one technique and its practice.", "It copied technique and practice, never raw strength, and stopped after thirty heartbeats."),
        limitation_or_cost: claim("Never copies raw strength and stops after thirty heartbeats.", "It copied technique and practice, never raw strength, and stopped after thirty heartbeats.", "explicit_limit"),
        viewer_understands_before_payoff: true,
        viewer_comprehension_summary: "The trigger, copied domain, and ceiling are stated before Joey predicts the strike.",
        lineage: { kind: "base", parent_ability_id: null, evolution_trigger: null },
      },
      {
        ability_id: "echo_mirror",
        name: "Echo Mirror",
        first_mention: anchor("After mastering the copied pattern, Mirror evolved into Echo Mirror."),
        first_use: anchor("Echo Mirror could preserve two learned patterns, but each one faded after one hour."),
        first_payoff: anchor("Joey used Echo Mirror to counter two fighters at once."),
        trigger: claim("Mastery of a copied pattern causes the evolution.", "After mastering the copied pattern, Mirror evolved into Echo Mirror."),
        capability: claim("Preserves two learned patterns.", "Echo Mirror could preserve two learned patterns, but each one faded after one hour."),
        limitation_or_cost: claim("Each stored pattern fades after one hour.", "Echo Mirror could preserve two learned patterns, but each one faded after one hour.", "explicit_limit"),
        viewer_understands_before_payoff: true,
        viewer_comprehension_summary: "Storage count and expiry are stated before the two-fighter counter.",
        lineage: {
          kind: "evolution",
          parent_ability_id: "mirror",
          evolution_trigger: claim("Mirror evolves after copied-pattern mastery.", "After mastering the copied pattern, Mirror evolved into Echo Mirror."),
        },
      },
    ],
  };
}

async function rejects(promise, pattern) {
  await assert.rejects(promise, pattern);
}

async function main() {
  const valid = materializePowerSystemComprehensionAudit(candidate(), SCRIPT, {
    sourceScriptPath: "/tmp/script_clean.md",
    reviewedBy: "fixture-agent",
    reviewedAt: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(valid.status, "passed");
  assert.deepEqual(valid.validation.blockers, []);

  const stale = structuredClone(valid);
  stale.source_script_hash = "0".repeat(64);
  assert.ok(validatePowerSystemComprehensionAudit(stale, SCRIPT).blockers.some((row) => row.code === "power_audit_source_script_hash_mismatch"));

  const badExcerpt = structuredClone(valid);
  badExcerpt.abilities[0].first_use.exact_excerpt = "Joey touched nobody.";
  assert.ok(validatePowerSystemComprehensionAudit(badExcerpt, SCRIPT).blockers.some((row) => row.code === "power_audit_exact_excerpt_mismatch"));

  const missingCapability = structuredClone(valid);
  missingCapability.abilities[0].capability.evidence = [];
  assert.ok(validatePowerSystemComprehensionAudit(missingCapability, SCRIPT).blockers.some((row) => row.code === "power_audit_claim_evidence_missing" && row.field === "capability.evidence"));

  const unconfirmedUnderstanding = structuredClone(valid);
  unconfirmedUnderstanding.abilities[0].viewer_understands_before_payoff = false;
  assert.ok(validatePowerSystemComprehensionAudit(unconfirmedUnderstanding, SCRIPT).blockers.some((row) => row.code === "power_audit_viewer_understanding_not_confirmed"));

  const lateExplanationCandidate = candidate();
  lateExplanationCandidate.abilities[0].trigger = claim("The payoff is incorrectly used as trigger evidence.", "Mirror copied the sword talent, and Joey predicted the next strike.");
  const late = materializePowerSystemComprehensionAudit(lateExplanationCandidate, SCRIPT, { reviewedBy: "fixture-agent" });
  assert.ok(late.validation.blockers.some((row) => row.code === "power_audit_mechanic_explained_after_payoff"));

  const brokenLineageCandidate = candidate();
  brokenLineageCandidate.abilities[1].lineage.parent_ability_id = "unknown_parent";
  const brokenLineage = materializePowerSystemComprehensionAudit(brokenLineageCandidate, SCRIPT, { reviewedBy: "fixture-agent" });
  assert.ok(brokenLineage.validation.blockers.some((row) => row.code === "power_audit_evolution_parent_unknown"));

  const noPower = materializePowerSystemComprehensionAudit({
    power_system_present: false,
    no_power_system_rationale: "Complete review found no supernatural, system, or evolving ability mechanics.",
    abilities: [],
  }, "Joey repaired the family restaurant through ordinary work.", { reviewedBy: "fixture-agent" });
  assert.equal(noPower.status, "passed");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-power-approval-"));
  const episodeDir = path.join(root, "episode");
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), SCRIPT, "utf8");
  await rejects(execFileAsync(process.execPath, ["scripts/script-approve.mjs", "--episode-dir", episodeDir], { cwd: process.cwd() }), /required power-system comprehension audit is missing/i);
  await fs.writeFile(path.join(episodeDir, "power_system_comprehension_audit.json"), `${JSON.stringify(valid, null, 2)}\n`, "utf8");
  const { stdout } = await execFileAsync(process.execPath, ["scripts/script-approve.mjs", "--episode-dir", episodeDir], { cwd: process.cwd() });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "approved");
  const approval = JSON.parse(await fs.readFile(path.join(episodeDir, "operator_script_approval.json"), "utf8"));
  assert.match(approval.power_system_comprehension_audit_hash, /^[a-f0-9]{64}$/);
  assert.equal(approval.power_system_editorial_exception, undefined);

  await fs.writeFile(path.join(episodeDir, "script_clean.md"), `${SCRIPT}\nA changed line.\n`, "utf8");
  await rejects(execFileAsync(process.execPath, ["scripts/script-approve.mjs", "--episode-dir", episodeDir], { cwd: process.cwd() }), /power-system comprehension audit is missing, stale, or blocked/i);

  const releasedDir = path.join(root, "operator-released");
  await fs.mkdir(releasedDir, { recursive: true });
  await fs.writeFile(path.join(releasedDir, "script_clean.md"), SCRIPT, "utf8");
  const scriptHash = createHash("sha256").update(SCRIPT).digest("hex");
  const reason = "The operator reviewed and released this exact draft; the agent accepts its demonstrated-power opening before the later rules explanation without rewriting it.";
  const exceptionArgs = ["--accept-power-system-editorial-risk", "true"];
  const reasonArgs = ["--power-system-editorial-reason", reason];
  const approveReleased = (extra = []) => execFileAsync(process.execPath, [
    "scripts/script-approve.mjs", "--episode-dir", releasedDir, ...extra,
  ], { cwd: process.cwd() });

  await rejects(approveReleased([...exceptionArgs, ...reasonArgs]), /requires --hash/i);
  await rejects(approveReleased([...exceptionArgs, "--hash", scriptHash]), /at least 40 characters/i);
  await rejects(approveReleased([...exceptionArgs, "--hash", scriptHash, "--power-system-editorial-reason", "ok"]), /at least 40 characters/i);
  await rejects(approveReleased(["--hash", scriptHash, ...reasonArgs]), /requires --accept-power-system-editorial-risk true/i);
  await rejects(approveReleased([...exceptionArgs, ...reasonArgs, "--hash", "0".repeat(64)]), /expected hash.*current script hash/i);
  await rejects(fs.readFile(path.join(releasedDir, "operator_script_approval.json")), /ENOENT/);

  const releasedOutput = JSON.parse((await approveReleased([
    ...exceptionArgs, ...reasonArgs, "--hash", scriptHash,
  ])).stdout);
  assert.equal(releasedOutput.status, "approved");
  assert.equal(releasedOutput.power_system_comprehension_audit_hash, null);
  for (const filename of ["manual_agent_script_review.json", "operator_script_approval.json", "script_lock.json"]) {
    const receipt = JSON.parse(await fs.readFile(path.join(releasedDir, filename), "utf8"));
    assert.equal(receipt.script_clean_hash, scriptHash);
    assert.equal(receipt.power_system_comprehension_audit_path, null);
    assert.equal(receipt.power_system_comprehension_audit_hash, null);
    assert.deepEqual(receipt.power_system_editorial_exception, releasedOutput.power_system_editorial_exception);
    assert.equal(receipt.power_system_editorial_exception.status, "not_performed_operator_editorial_exception");
    assert.equal(receipt.power_system_editorial_exception.source_script_hash, scriptHash);
    assert.equal(receipt.power_system_editorial_exception.approval_scope, "exact_script_hash");
    assert.equal(receipt.power_system_editorial_exception.operator_release_basis_and_editorial_risk, reason);
    assert.equal(receipt.power_system_editorial_exception.comprehension_audit_pass_claimed, false);
  }
  assert.equal(await fs.readFile(path.join(releasedDir, "script_clean.md"), "utf8"), SCRIPT);
  await rejects(fs.readFile(path.join(releasedDir, "power_system_comprehension_audit.json")), /ENOENT/);
  // An earlier exception never silently becomes the default for another call.
  await rejects(approveReleased(["--hash", scriptHash]), /required power-system comprehension audit is missing/i);

  const preservedAuditPath = path.join(releasedDir, "power_system_comprehension_audit.json");
  const preservedAuditBytes = `${JSON.stringify(late, null, 2)}\n`;
  await fs.writeFile(preservedAuditPath, preservedAuditBytes, "utf8");
  await rejects(approveReleased(["--hash", scriptHash]), /power-system comprehension audit is missing, stale, or blocked/i);
  const retainedOutput = JSON.parse((await approveReleased([
    ...exceptionArgs, ...reasonArgs, "--hash", scriptHash,
  ])).stdout);
  assert.equal(retainedOutput.power_system_editorial_exception.status, "existing_audit_preserved_editorial_risk_accepted");
  assert.equal(retainedOutput.power_system_editorial_exception.existing_audit_status, "blocked");
  assert.equal(retainedOutput.power_system_editorial_exception.existing_audit_validation.status, "blocked");
  assert.equal(retainedOutput.power_system_comprehension_audit_hash, createHash("sha256").update(preservedAuditBytes).digest("hex"));
  assert.equal(await fs.readFile(preservedAuditPath, "utf8"), preservedAuditBytes);

  const existingApproval = await fs.readFile(path.join(releasedDir, "operator_script_approval.json"), "utf8");
  const metaScript = `${SCRIPT}\nThat was the hook.\n`;
  await fs.writeFile(path.join(releasedDir, "script_clean.md"), metaScript, "utf8");
  await rejects(approveReleased([
    ...exceptionArgs, ...reasonArgs, "--hash", createHash("sha256").update(metaScript).digest("hex"),
  ]), /production\/meta narration contamination/i);
  assert.equal(await fs.readFile(path.join(releasedDir, "operator_script_approval.json"), "utf8"), existingApproval);
  assert.equal(await fs.readFile(path.join(releasedDir, "script_clean.md"), "utf8"), metaScript);

  console.log("power-system comprehension tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
