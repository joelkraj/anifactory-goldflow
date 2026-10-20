// No-network tests for the registered script_comprehension_audit stage: one planner call
// through an injected executor, the deterministic validator, a hold on failure with no re-call,
// a $0 budget authorization receipt, and the approval path finding the audit on the ledger.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { authorScriptComprehensionAudit, comprehensionAuditPrompt, fillAnchorOffsets, SCRIPT_COMPREHENSION_AUDIT_REVIEWER } from "../lib/script-comprehension-audit.mjs";
import { validatePowerSystemComprehensionAudit } from "../lib/power-system-comprehension-contract.mjs";
import { buildEpisodeBudget } from "../lib/episode-budget.mjs";
import { PIPELINE_STAGE_REGISTRY, PIPELINE_STAGE_REGISTRY_CURRENT, buildStageCommand, commandStageFor, readyStageIds, stageRegistryFor } from "../lib/pipeline-stage-registry.mjs";
import { mediaWorkflowForPreflight } from "../lib/media-workflows.mjs";
import { contentProfileDefinition } from "../lib/content-profiles.mjs";

const execFileAsync = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const BASE = process.env.GOLDFLOW_BASE_EPISODE_DIR ?? "/Users/joel/AniFactoryData/channels/53rebirth/weekly_runs/2026-W43-coma-healer-panel-baseline-v1/episodes/ep_01";

const SCRIPT = [
  "Joey had always carried the dormant Mirror skill.",
  "Bare contact with an active talent let Mirror copy one technique.",
  "It copied technique and practice, never raw strength, and stopped after thirty heartbeats.",
  "Joey touched Marcus while the sword talent was active.",
  "Mirror copied the sword talent, and Joey predicted the next strike.",
].join("\n");

// A planner answer without offsets: the stage fills them deterministically.
const CANDIDATE = {
  power_system_present: true,
  abilities: [{
    ability_id: "mirror", name: "Mirror",
    first_mention: { exact_excerpt: "Joey had always carried the dormant Mirror skill." },
    first_use: { exact_excerpt: "Joey touched Marcus while the sword talent was active." },
    first_payoff: { exact_excerpt: "Mirror copied the sword talent, and Joey predicted the next strike." },
    trigger: { summary: "Bare contact with an active talent.", evidence: [{ exact_excerpt: "Bare contact with an active talent let Mirror copy one technique." }] },
    capability: { summary: "Copies one technique and its practice.", evidence: [{ exact_excerpt: "It copied technique and practice, never raw strength, and stopped after thirty heartbeats." }] },
    limitation_or_cost: { summary: "Never raw strength; thirty heartbeats.", classification: "explicit_limit", evidence: [{ exact_excerpt: "It copied technique and practice, never raw strength, and stopped after thirty heartbeats." }] },
    viewer_understands_before_payoff: true,
    viewer_comprehension_summary: "Trigger, domain and ceiling are stated before the predicted strike.",
    lineage: { kind: "base", parent_ability_id: null, evolution_trigger: null },
  }],
};

const newIdentity = (extra = {}) => ({
  schema: "goldflow_run_identity_v2", channel: "chan", series_slug: "s", week: "w", episode: "ep_01", content_profile: "manhwa_recap_v1",
  content_profile_config: contentProfileDefinition("manhwa_recap_v1").config,
  ...mediaWorkflowForPreflight({ contentProfile: "manhwa_recap_v1", mediaWorkflow: "generated_visuals_v1" }), ...extra,
});

async function episode(identity, script = SCRIPT) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-comprehension-"));
  await fs.writeFile(path.join(dir, "run_identity.json"), JSON.stringify(identity));
  await fs.writeFile(path.join(dir, "script_clean.md"), script);
  return dir;
}

function executorReturning(contentFor) {
  const calls = [];
  return {
    calls,
    executor: async ({ prompt, stageName, outputPath }) => {
      calls.push({ stageName, prompt });
      const content = typeof contentFor === "function" ? contentFor(prompt) : contentFor;
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, content);
      const meta = { status: "passed", provider: "codex_cli", transport: "codex_exec_cli", model: "gpt-6.1-sol", reasoning_effort: "high", prompt_sha256: sha(prompt), output_sha256: sha(content), started_at: "2026-10-20T10:00:00.000Z", completed_at: "2026-10-20T10:01:00.000Z" };
      await fs.writeFile(`${outputPath}.meta.json`, JSON.stringify(meta));
      return { content, ...meta };
    },
  };
}

test("the registry places the audit before approval on new identities only", () => {
  const current = PIPELINE_STAGE_REGISTRY_CURRENT.map((row) => row.id);
  assert.equal(current.indexOf("script_comprehension_audit") + 1, current.indexOf("script_approval"));
  assert.equal(current.includes("script_pace_check"), false);
  assert.equal(current.includes("targeted_speakability"), false);
  assert.deepEqual(PIPELINE_STAGE_REGISTRY_CURRENT.find((row) => row.id === "voice_plan").dependencies, ["script_approval"]);
  assert.deepEqual(PIPELINE_STAGE_REGISTRY_CURRENT.find((row) => row.id === "semantic_scene_plan").dependencies, ["script_approval"]);
  // the historical row set is retained byte-for-byte for identities locked to 2026-08-22.1
  const historical = PIPELINE_STAGE_REGISTRY.map((row) => row.id);
  assert.equal(historical.includes("script_comprehension_audit"), false);
  assert.deepEqual(historical.slice(2, 5), ["script_approval", "script_pace_check", "targeted_speakability"]);
  assert.deepEqual(PIPELINE_STAGE_REGISTRY.find((row) => row.id === "voice_plan").dependencies, ["targeted_speakability"]);
  const identity = newIdentity();
  assert.equal(stageRegistryFor(identity), PIPELINE_STAGE_REGISTRY_CURRENT);
  const payload = { schema: "goldflow_media_workflow_v1", id: "generated_visuals_v1", version: "2026-09-06.1", stage_registry_version: "2026-08-22.1" };
  const historicalIdentity = { ...identity, stage_registry_version: "2026-08-22.1", workflow_contract: { ...payload, sha256: sha(JSON.stringify(payload)) } };
  assert.equal(stageRegistryFor(historicalIdentity), PIPELINE_STAGE_REGISTRY);
  assert.equal(stageRegistryFor({ schema: "goldflow_run_identity_v1", stage_registry_version: "2026-07-29.1" }), PIPELINE_STAGE_REGISTRY);
  assert.equal(commandStageFor("script", "power-audit", {}, identity), "script_comprehension_audit");
  assert.equal(commandStageFor("script", "power-audit", {}, historicalIdentity), null, "historical identities keep the audit off the ledger");
  assert.match(buildStageCommand("script_comprehension_audit", identity), /script power-audit --channel chan --series s --week w --episode ep_01 --author planner$/);
  const rows = PIPELINE_STAGE_REGISTRY_CURRENT.map((row) => ({ stage: row.id, state: ["run_identity", "source_ingest"].includes(row.id) ? "passed" : "missing" }));
  assert.deepEqual(readyStageIds(rows, identity), ["script_comprehension_audit"]);
});

test("one planner call, deterministic validation, idempotent on a passed audit", async () => {
  const dir = await episode(newIdentity({ episode_budget: buildEpisodeBudget({ usd: "10", lockedAt: "2026-10-20T00:00:00.000Z" }) }));
  const { calls, executor } = executorReturning(`\`\`\`json\n${JSON.stringify(CANDIDATE)}\n\`\`\``);
  const result = await authorScriptComprehensionAudit({ episodeDir: dir, executor, now: () => "2026-10-20T10:02:00.000Z" });
  assert.equal(result.status, "passed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stageName, "script_comprehension_audit");
  assert.ok(calls[0].prompt.includes("SCRIPT:\n" + SCRIPT));
  const audit = JSON.parse(await fs.readFile(path.join(dir, "power_system_comprehension_audit.json"), "utf8"));
  assert.equal(audit.status, "passed");
  assert.equal(audit.source_script_hash, sha(SCRIPT));
  assert.equal(audit.reviewed_by, SCRIPT_COMPREHENSION_AUDIT_REVIEWER);
  assert.equal(audit.abilities[0].first_mention.start_offset, 0);
  assert.deepEqual(validatePowerSystemComprehensionAudit(audit, SCRIPT).blockers, []);
  assert.equal(audit.planner_call.model, "gpt-6.1-sol");
  assert.equal(audit.planner_call.prompt_sha256, sha(calls[0].prompt));
  assert.equal(audit.planner_call.call_count, 1);
  assert.equal(audit.episode_budget_authorization.status, "authorized");
  assert.equal(audit.episode_budget_authorization.requested_usd, 0);
  const receipts = await fs.readdir(path.join(dir, "episode_budget", "authorizations"));
  assert.equal(receipts.length, 1);
  // a second run on the same script makes no call and changes nothing
  const bytes = await fs.readFile(path.join(dir, "power_system_comprehension_audit.json"));
  const again = await authorScriptComprehensionAudit({ episodeDir: dir, executor });
  assert.equal(again.status, "already_passed");
  assert.equal(calls.length, 1);
  assert.deepEqual(await fs.readFile(path.join(dir, "power_system_comprehension_audit.json")), bytes);
  // script approve finds the audit on the ledger and approves the exact hash
  const { stdout } = await execFileAsync(process.execPath, ["scripts/script-approve.mjs", "--episode-dir", dir, "--approved-by", "automated:deterministic_script_checks"], { cwd: process.cwd() });
  assert.equal(JSON.parse(stdout).status, "approved");
  await fs.rm(dir, { recursive: true, force: true });
});

test("a blocked audit is written as triage evidence and holds without a re-call", async () => {
  const dir = await episode(newIdentity());
  const bad = structuredClone(CANDIDATE);
  bad.abilities[0].first_use.exact_excerpt = "Joey touched nobody.";
  const { calls, executor } = executorReturning(JSON.stringify(bad));
  const result = await authorScriptComprehensionAudit({ episodeDir: dir, executor });
  assert.equal(result.status, "blocked");
  assert.ok(result.audit.validation.blockers.some((row) => row.ability_id === "mirror" && row.field === "first_use" && /offset_invalid|exact_excerpt_mismatch/.test(row.code)), JSON.stringify(result.audit.validation.blockers));
  assert.equal(result.audit.episode_budget_authorization.status, "not_locked");
  const held = await authorScriptComprehensionAudit({ episodeDir: dir, executor });
  assert.equal(held.status, "held");
  assert.match(held.reason, /no automatic planner re-call/);
  assert.equal(calls.length, 1, "the planner is never re-called for the same script");
  // the CLI exits non-zero on the hold and script approve refuses
  await assert.rejects(execFileAsync(process.execPath, ["scripts/power-system-comprehension-audit.mjs", "--episode-dir", dir], { cwd: process.cwd() }), /held for triage/);
  await assert.rejects(execFileAsync(process.execPath, ["scripts/script-approve.mjs", "--episode-dir", dir], { cwd: process.cwd() }), /missing, stale, or blocked/);
  // unparseable planner output is a blocked audit too, never an approval
  const garbage = executorReturning("not json at all");
  await fs.writeFile(path.join(dir, "script_clean.md"), `${SCRIPT}\nNew line.\n`);
  const parsed = await authorScriptComprehensionAudit({ episodeDir: dir, executor: garbage.executor });
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.audit.planner_call.parse_error, /JSON|object/i);
  // run status reports the registered stage as blocked with a hold, and the next command unchanged
  const { stdout } = await execFileAsync(process.execPath, ["scripts/run-status.mjs", "--episode-dir", dir], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: path.join(dir, "data") } });
  const status = JSON.parse(stdout);
  const row = status.stage_ledger.find((entry) => entry.stage === "script_comprehension_audit");
  assert.equal(row.state, "blocked");
  assert.match(row.evidence, /held for triage/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("the `--input` path still materializes an authored candidate for the historical fallback", async () => {
  const dir = await episode(newIdentity());
  const inputPath = path.join(dir, "candidate.json");
  await fs.writeFile(inputPath, JSON.stringify(fillAnchorOffsets(CANDIDATE, SCRIPT)));
  const { stdout } = await execFileAsync(process.execPath, ["scripts/power-system-comprehension-audit.mjs", "--episode-dir", dir, "--input", inputPath, "--reviewed-by", "automated:model_reviewer"], { cwd: process.cwd() });
  assert.equal(JSON.parse(stdout).status, "passed");
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "power_system_comprehension_audit.json"), "utf8")).reviewed_by, "automated:model_reviewer");
  await assert.rejects(execFileAsync(process.execPath, ["scripts/power-system-comprehension-audit.mjs", "--episode-dir", dir, "--input", inputPath], { cwd: process.cwd() }), /--reviewed-by is required/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("BASE script_clean.md with an injected executor reproduces a passing audit through the validator", async (t) => {
  const baseScript = await fs.readFile(path.join(BASE, "script_clean.md"), "utf8").catch(() => null);
  const baseAudit = await fs.readFile(path.join(BASE, "power_system_comprehension_audit.json"), "utf8").then(JSON.parse).catch(() => null);
  if (!baseScript || !baseAudit) {
    t.skip("BASE episode not available on this machine");
    return;
  }
  assert.equal(baseAudit.source_script_hash, sha(baseScript), "BASE audit must be bound to BASE script_clean.md");
  const dir = await episode(newIdentity(), baseScript);
  // The injected planner answers with the recorded abilities, stripped of their offsets.
  const stripOffsets = (value) => (Array.isArray(value) ? value.map(stripOffsets)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !["start_offset", "end_offset"].includes(key)).map(([key, inner]) => [key, stripOffsets(inner)]))
    : value);
  const candidate = stripOffsets({ power_system_present: baseAudit.power_system_present, no_power_system_rationale: baseAudit.no_power_system_rationale, abilities: baseAudit.abilities });
  const { calls, executor } = executorReturning(JSON.stringify(candidate));
  const result = await authorScriptComprehensionAudit({ episodeDir: dir, executor });
  assert.equal(result.status, "passed", JSON.stringify(result.audit?.validation?.blockers?.slice(0, 5)));
  assert.equal(calls.length, 1);
  assert.equal(result.audit.ability_count, baseAudit.ability_count);
  assert.deepEqual(result.audit.abilities.map((row) => row.ability_id), baseAudit.abilities.map((row) => row.ability_id));
  assert.deepEqual(result.audit.abilities.map((row) => row.first_mention.start_offset), baseAudit.abilities.map((row) => row.first_mention.start_offset));
  assert.deepEqual(validatePowerSystemComprehensionAudit(result.audit, baseScript).blockers, []);
  assert.equal(calls[0].prompt, comprehensionAuditPrompt({ script: baseScript, contractSource: await fs.readFile("scripts/lib/power-system-comprehension-contract.mjs", "utf8") }));
  await fs.rm(dir, { recursive: true, force: true });
});
