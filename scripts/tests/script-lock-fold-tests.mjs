// No-network tests for the folded script lock (registry ≥ 2026-10-20.1): script approve
// writes one goldflow_script_lock_v2 carrying the pace and targeted-speakability validators,
// still emits tts_spoken_overrides.json and the historical report files for legacy readers,
// run status then shows voice_plan ready; historical identities keep the three-file lock and
// their separate stage commands, which now share the library (no story-specific phrases).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { materializePowerSystemComprehensionAudit } from "../lib/power-system-comprehension-contract.mjs";
import { targetedFindings, buildTargetedSpeakabilityArtifacts } from "../lib/script-speakability-targeted.mjs";
import { buildScriptPaceReport, spokenWordCount } from "../lib/script-pace-diagnostics.mjs";
import { mediaWorkflowForPreflight } from "../lib/media-workflows.mjs";
import { contentProfileDefinition } from "../lib/content-profiles.mjs";

const execFileAsync = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const run = (script, args, env = {}) => execFileAsync(process.execPath, [script, ...args], { cwd: process.cwd(), env: { ...process.env, ...env } });

const SCRIPT = [
  "Joey went live from the junkyard, and the stream content was his cracked phone.",
  "The narrator will tell you what the shaman could not have known: nothing was broken.",
  "Joey repaired the family restaurant through ordinary work.",
].join("\n");

function identityFor(kind) {
  const base = { schema: "goldflow_run_identity_v2", channel: "chan", series_slug: "s", week: "w", episode: "ep_01", content_profile: "manhwa_recap_v1", content_profile_config: contentProfileDefinition("manhwa_recap_v1").config, target_wpm_min: 180, target_wpm_max: 195, pace_policy: "diagnostic" };
  if (kind === "current") return { ...base, ...mediaWorkflowForPreflight({ contentProfile: "manhwa_recap_v1", mediaWorkflow: "generated_visuals_v1" }) };
  const payload = { schema: "goldflow_media_workflow_v1", id: "generated_visuals_v1", version: "2026-09-06.1", stage_registry_version: "2026-08-22.1" };
  return { ...base, media_workflow: "generated_visuals_v1", stage_registry_version: "2026-08-22.1", workflow_contract: { ...payload, sha256: sha(JSON.stringify(payload)) } };
}

async function episode(kind) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `goldflow-lock-fold-${kind}-`));
  await fs.writeFile(path.join(dir, "run_identity.json"), JSON.stringify(identityFor(kind)));
  await fs.writeFile(path.join(dir, "script_clean.md"), SCRIPT);
  await fs.writeFile(path.join(dir, "source_story_ingest_report.json"), JSON.stringify({ status: "passed" }));
  const audit = materializePowerSystemComprehensionAudit({ power_system_present: false, no_power_system_rationale: "Ordinary work; no supernatural mechanics.", abilities: [] }, SCRIPT, { reviewedBy: "fixture" });
  await fs.writeFile(path.join(dir, "power_system_comprehension_audit.json"), JSON.stringify(audit));
  return dir;
}

test("the story-specific phrase list is gone; only shared-lane homograph rules remain", () => {
  const findings = targetedFindings(SCRIPT);
  // same line: findings sort by source text
  assert.deepEqual(findings.map((row) => row.code), ["tts_homograph_stream_content", "tts_homograph_live_stream"]);
  assert.equal(findings.some((row) => row.code === "meta_narrator_self_reference"), false);
  assert.equal(findings[1].suggested_spoken_text, "started livestreaming");
  const { overrides } = buildTargetedSpeakabilityArtifacts({ script: SCRIPT, scriptPath: "/x/script_clean.md", scriptHash: sha(SCRIPT), channel: "c", series: "s", week: "w", episode: "ep_01" });
  assert.equal(overrides.schema, "goldflow_tts_spoken_overrides_v1");
  assert.deepEqual(overrides.replacements.map((row) => [row.from, row.to, row.scope]), [["stream content", "stream videos", "tts_spoken_text"], ["went live", "started livestreaming", "tts_spoken_text"]]);
});

test("a new identity gets one v2 lock with folded validators plus the legacy-readable files", async () => {
  const dir = await episode("current");
  const { stdout } = await run("scripts/script-approve.mjs", ["--episode-dir", dir, "--approved-by", "automated:deterministic_script_checks"]);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "approved");
  assert.equal(result.lock_schema, "goldflow_script_lock_v2");
  assert.deepEqual(result.files_written, ["script_meta_contamination_report.json", "script_lock.json", "script_pace_report.json", "script_speakability_report.json", "tts_spoken_overrides.json", "script_speakability_problem_areas_report.json", "operator_script_approval.json", "manual_agent_script_review.json"]);
  const read = async (name) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
  const lock = await read("script_lock.json");
  assert.equal(lock.schema, "goldflow_script_lock_v2");
  assert.equal(lock.status, "script_locked");
  assert.equal(lock.script_clean_hash, sha(SCRIPT));
  assert.equal(lock.approved_by, "automated:deterministic_script_checks");
  assert.equal(lock.folded_validators.script_pace_check.status, "passed");
  assert.equal(lock.folded_validators.script_pace_check.pace_gate_enforced, false);
  assert.equal(lock.folded_validators.script_pace_check.script_word_count, spokenWordCount(SCRIPT));
  assert.equal(lock.folded_validators.targeted_speakability.finding_count, 2);
  assert.equal(lock.folded_validators.targeted_speakability.ruleset, "shared_lane_homographs_v2");
  // derived files are hash-bound to the lock and to the script
  for (const [name, key] of [["script_pace_report.json", "report_sha256"], ["script_speakability_report.json", "report_sha256"], ["tts_spoken_overrides.json", "overrides_sha256"]]) {
    const owner = name === "script_pace_report.json" ? lock.folded_validators.script_pace_check : lock.folded_validators.targeted_speakability;
    assert.equal(sha(await fs.readFile(path.join(dir, name))), owner[key], name);
    assert.equal((await read(name)).source_script_hash, sha(SCRIPT), name);
  }
  const pace = await read("script_pace_report.json");
  assert.equal(pace.schema, "goldflow_narration_pace_report_v1");
  assert.equal(pace.mode, "script");
  assert.equal(pace.target_wpm_min, 180);
  const overrides = await read("tts_spoken_overrides.json");
  assert.equal(overrides.replacements.length, 2);
  // legacy readers: the two approval files are derived views of the lock
  const approval = await read("operator_script_approval.json");
  assert.equal(approval.schema, "goldflow_operator_script_approval_v1");
  assert.equal(approval.operator_approved, true);
  assert.equal(approval.derived_from, "script_lock.json");
  assert.equal((await read("manual_agent_script_review.json")).manual_agent_script_review, true);
  // run status: approval passed, the folded stages are absent, voice_plan and semantic are ready
  const status = JSON.parse((await run("scripts/run-status.mjs", ["--episode-dir", dir], { ANIFACTORY_DATA_ROOT: path.join(dir, "data") })).stdout);
  const states = Object.fromEntries(status.stage_ledger.map((row) => [row.stage, row.state]));
  assert.equal(states.script_comprehension_audit, "passed");
  assert.equal(states.script_approval, "passed");
  assert.equal(states.script_pace_check, undefined);
  assert.equal(states.targeted_speakability, undefined);
  assert.ok(status.allowed_command_stages.includes("voice_plan"), JSON.stringify(status.allowed_command_stages));
  assert.ok(status.allowed_command_stages.includes("semantic_scene_plan"));
  // a changed script is re-approved into a new lock; the previous lock is archived, not overwritten
  await fs.writeFile(path.join(dir, "script_clean.md"), `${SCRIPT}\nA new ending.\n`);
  const changedAudit = materializePowerSystemComprehensionAudit({ power_system_present: false, no_power_system_rationale: "Ordinary work; no supernatural mechanics.", abilities: [] }, `${SCRIPT}\nA new ending.\n`, { reviewedBy: "fixture" });
  await fs.writeFile(path.join(dir, "power_system_comprehension_audit.json"), JSON.stringify(changedAudit));
  await run("scripts/script-approve.mjs", ["--episode-dir", dir]);
  const archived = await fs.readdir(path.join(dir, "_archived_script_locks"));
  assert.equal(archived.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "_archived_script_locks", archived[0]), "utf8")).script_clean_hash, sha(SCRIPT));
  assert.equal((await read("script_lock.json")).script_clean_hash, sha(`${SCRIPT}\nA new ending.\n`));
  await fs.rm(dir, { recursive: true, force: true });
});

test("a historical identity keeps the three-file v1 lock and its separate stage commands", async () => {
  const dir = await episode("historical");
  const result = JSON.parse((await run("scripts/script-approve.mjs", ["--episode-dir", dir])).stdout);
  assert.equal(result.lock_schema, undefined);
  assert.deepEqual(result.files_written, ["script_meta_contamination_report.json", "manual_agent_script_review.json", "operator_script_approval.json", "script_lock.json"]);
  const lock = JSON.parse(await fs.readFile(path.join(dir, "script_lock.json"), "utf8"));
  assert.equal(lock.schema, "goldflow_script_lock_v1");
  assert.equal(lock.folded_validators, undefined);
  await assert.rejects(fs.access(path.join(dir, "tts_spoken_overrides.json")));
  // the historical stage commands still run, through the same library
  const env = { ANIFACTORY_DATA_ROOT: path.join(dir, "data") };
  await run("scripts/narration-pace-check.mjs", ["--mode", "script", "--episode-dir", dir, "--target-wpm-min", "180", "--target-wpm-max", "195", "--pace-policy", "diagnostic", "--allow-hook-warnings", "true"], env);
  const pace = JSON.parse(await fs.readFile(path.join(dir, "script_pace_report.json"), "utf8"));
  const expected = await buildScriptPaceReport({ script: SCRIPT, scriptPath: path.join(dir, "script_clean.md"), sourceScriptHash: sha(SCRIPT), channel: "53rebirth", series: "series", week: "current", episode: "ep_01", allowHookWarnings: true, sourceHashes: pace.source_hashes, updatedAt: pace.updated_at });
  assert.deepEqual(pace, expected);
  // `script targeted` resolves the episode from channel/week/episode under the data root
  const tupleDir = path.join(dir, "data", "channels", "53rebirth", "weekly_runs", "current", "episodes", "ep_01");
  await fs.mkdir(tupleDir, { recursive: true });
  for (const name of ["script_clean.md", "run_identity.json", "manual_agent_script_review.json", "operator_script_approval.json", "script_lock.json"]) await fs.copyFile(path.join(dir, name), path.join(tupleDir, name));
  await run("scripts/script-targeted-speakability.mjs", ["--channel", "53rebirth", "--week", "current", "--episode", "ep_01"], env);
  const overrides = JSON.parse(await fs.readFile(path.join(tupleDir, "tts_spoken_overrides.json"), "utf8"));
  assert.deepEqual(overrides.replacements.map((row) => row.from), ["stream content", "went live"]);
  const report = JSON.parse(await fs.readFile(path.join(tupleDir, "script_speakability_report.json"), "utf8"));
  assert.equal(report.deterministic_risk_count, 2);
  assert.equal(report.deterministic_risks.some((row) => row.code === "meta_narrator_self_reference"), false);
  const status = JSON.parse((await run("scripts/run-status.mjs", ["--episode-dir", tupleDir], env)).stdout);
  const states = Object.fromEntries(status.stage_ledger.map((row) => [row.stage, row.state]));
  assert.equal(states.script_approval, "passed");
  assert.equal(states.targeted_speakability, "passed");
  assert.equal(states.script_comprehension_audit, undefined);
  await fs.rm(dir, { recursive: true, force: true });
});
