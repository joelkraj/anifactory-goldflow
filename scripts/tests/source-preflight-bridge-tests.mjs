// No-network tests for the source → preflight bridge: `source_handoff.json` + an operator
// channel preset expand to the operational flags the 2026-W43 baseline identity recorded, the
// preset may never carry the content profile / media workflow / run intent, and real preflight
// records both files by hash and refuses a script that does not match the hand-off.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CHANNEL_PRESET_SCHEMA, expandPreflightFlags, validateChannelPreset } from "../lib/channel-preset.mjs";
import { buildSourceHandoff } from "../lib/source-manufacturer-contract.mjs";

const execFileAsync = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/base_run_identity_fields_2026w43.json", import.meta.url), "utf8")).fields;

// The documented channels/53rebirth/channel_preset.json shape (docs/workflows/channel_preset.md).
function basePreset(extra = {}) {
  return {
    schema: CHANNEL_PRESET_SCHEMA,
    channel: "53rebirth",
    version: "2026-10-20.1",
    authored_by: "joel",
    flags: {
      "planning-provider": "planning_room",
      "planning-effort-policy": "planning_room_stage_routed_v1",
      "image-provider": "codex_imagegen",
      "audio-target": "narrator_only",
      "tts-provider": "qwen_local",
      "production-profile": "fast_premium_v2",
      "pace-policy": "diagnostic",
      "target-wpm-min": 180,
      "target-wpm-max": 195,
      "render-profile": "panel_composition_v1",
      "motion-policy": "selective_editorial_v1",
      "generated-motion-policy": "disabled",
      "parallax-policy": "disabled",
      "beat-timing-enforcement": "hard_max",
      "target-beat-sec": 7.5,
      "max-beat-sec": 8,
      "min-beat-sec": 3,
      "hook-duration-sec": 30,
      "hook-target-beat-sec": 3.2,
      "hook-max-beat-sec": 4.2,
      "hook-min-beat-sec": 2.2,
      "retention-ramp-sec": 1200,
      "ramp-target-beat-sec": 6,
      "ramp-max-beat-sec": 7,
      "ramp-min-beat-sec": 3.2,
      ...extra,
    },
  };
}

const SCRIPT = "Joey woke from the coma and the monitor beeped twice.\n";

async function scratch() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-source-bridge-"));
  const scriptPath = path.join(root, "revision_loop", "final_script.txt");
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, SCRIPT);
  const handoff = buildSourceHandoff({
    title: fixture.title, finalScriptPath: scriptPath, sha256: sha(SCRIPT),
    briefSha256: "1".repeat(64), modelLockSha256: "2".repeat(64), evidenceSha256: "3".repeat(64), channel: "53rebirth",
  });
  const handoffPath = path.join(root, "revision_loop", "source_handoff.json");
  await fs.writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`);
  const presetPath = path.join(root, "channel_preset.json");
  return { root, scriptPath, handoffPath, presetPath, handoff };
}

const explicit = { "content-profile": "manhwa_recap_v1", "media-workflow": "generated_visuals_v1", "run-intent": "production", channel: "53rebirth", series: "coma-healer", week: fixture.week, episode: "ep_01" };

test("hand-off + preset expand to the baseline identity's recorded flags", async () => {
  const { handoffPath, presetPath, scriptPath } = await scratch();
  await fs.writeFile(presetPath, JSON.stringify(basePreset()));
  const expanded = expandPreflightFlags({ ...explicit, "channel-preset": presetPath, "source-handoff": handoffPath });
  const flags = expanded.flags;
  // identity + editorial choices come only from the command line
  for (const key of ["content-profile", "media-workflow", "run-intent", "channel", "series", "week", "episode"]) assert.equal(flags[key], explicit[key]);
  // the hand-off supplies title and source
  assert.equal(flags.title, fixture.title);
  assert.equal(flags.source, scriptPath);
  // the preset supplies every recorded operational field
  const expect = {
    "planning-provider": fixture.planning_provider, "planning-effort-policy": fixture.planning_effort_policy,
    "image-provider": fixture.image_provider, "tts-provider": fixture.tts_provider, "audio-target": fixture.audio_target,
    "production-profile": fixture.production_profile, "pace-policy": fixture.pace_policy,
    "target-wpm-min": String(fixture.target_wpm_min), "target-wpm-max": String(fixture.target_wpm_max),
    "render-profile": fixture.render_profile, "motion-policy": fixture.motion_policy,
    "generated-motion-policy": fixture.generated_motion_policy, "parallax-policy": fixture.parallax_policy,
    "beat-timing-enforcement": fixture.visual_beat_timing_contract.enforcement,
    "target-beat-sec": String(fixture.visual_beat_timing_contract.target_beat_sec), "max-beat-sec": String(fixture.visual_beat_timing_contract.max_beat_sec),
    "min-beat-sec": String(fixture.visual_beat_timing_contract.min_beat_sec), "hook-duration-sec": String(fixture.visual_beat_timing_contract.hook_duration_sec),
    "hook-target-beat-sec": String(fixture.visual_beat_timing_contract.hook_target_beat_sec), "hook-max-beat-sec": String(fixture.visual_beat_timing_contract.hook_max_beat_sec),
    "hook-min-beat-sec": String(fixture.visual_beat_timing_contract.hook_min_beat_sec), "retention-ramp-sec": String(fixture.visual_beat_timing_contract.retention_ramp_sec),
    "ramp-target-beat-sec": String(fixture.visual_beat_timing_contract.ramp_target_beat_sec), "ramp-max-beat-sec": String(fixture.visual_beat_timing_contract.ramp_max_beat_sec),
    "ramp-min-beat-sec": String(fixture.visual_beat_timing_contract.ramp_min_beat_sec),
  };
  for (const [key, value] of Object.entries(expect)) assert.equal(flags[key], value, key);
  assert.deepEqual(expanded.channel_preset.applied_flags, Object.fromEntries(Object.entries(basePreset().flags).map(([k, v]) => [k, String(v)])));
  assert.deepEqual(expanded.channel_preset.overridden_by_cli, {});
  assert.match(expanded.channel_preset.sha256, /^[a-f0-9]{64}$/);
  assert.equal(expanded.source_handoff.script_sha256, sha(SCRIPT));
  assert.equal(expanded.source_handoff.brief_sha256, "1".repeat(64));
  assert.equal(expanded.source_handoff.evidence_sha256, "3".repeat(64));
  // the autopilot lock is an allowed operational flag
  await fs.writeFile(presetPath, JSON.stringify(basePreset({ autopilot: true, "episode-budget-usd": 25 })));
  const auto = expandPreflightFlags({ ...explicit, "channel-preset": presetPath });
  assert.equal(auto.flags.autopilot, "true");
  assert.equal(auto.flags["episode-budget-usd"], "25");
  // an explicit CLI flag wins and is recorded as an override
  const overridden = expandPreflightFlags({ ...explicit, "channel-preset": presetPath, "image-provider": "modelslab" });
  assert.equal(overridden.flags["image-provider"], "modelslab");
  assert.deepEqual(overridden.channel_preset.overridden_by_cli, { "image-provider": { preset: "codex_imagegen", cli: "modelslab" } });
});

test("a preset may not decide the content profile, media workflow or run intent", async () => {
  const { presetPath, handoffPath } = await scratch();
  for (const key of ["content-profile", "media-workflow", "run-intent"]) {
    await fs.writeFile(presetPath, JSON.stringify(basePreset({ [key]: "anything" })));
    assert.throws(() => expandPreflightFlags({ ...explicit, "channel-preset": presetPath }), new RegExp(`may not supply --${key}`));
    assert.ok(validateChannelPreset(basePreset({ [key]: "x" })).blockers.includes(`channel_preset_forbidden_flag:${key}`));
  }
  // nor per-run identity, attestations or unknown flags; nor a channel other than --channel
  await fs.writeFile(presetPath, JSON.stringify(basePreset({ title: "x" })));
  assert.throws(() => expandPreflightFlags({ ...explicit, "channel-preset": presetPath }), /may not supply --title/);
  await fs.writeFile(presetPath, JSON.stringify(basePreset({ "allow-dirty-worktree": "true" })));
  assert.throws(() => expandPreflightFlags({ ...explicit, "channel-preset": presetPath }), /may not supply --allow-dirty-worktree/);
  await fs.writeFile(presetPath, JSON.stringify(basePreset({ "made-up-flag": "x" })));
  assert.throws(() => expandPreflightFlags({ ...explicit, "channel-preset": presetPath }), /channel_preset_unknown_flag:made-up-flag/);
  await fs.writeFile(presetPath, JSON.stringify(basePreset()));
  assert.throws(() => expandPreflightFlags({ ...explicit, channel: "other", "channel-preset": presetPath }), /channel_preset_channel_mismatch/);
  // the three explicit flags are required whenever either bridge file is used
  for (const key of ["content-profile", "media-workflow", "run-intent"]) {
    const flags = { ...explicit, "channel-preset": presetPath };
    delete flags[key];
    assert.throws(() => expandPreflightFlags(flags), new RegExp(`require explicit --${key}`));
    const handoffFlags = { ...explicit, "source-handoff": handoffPath };
    delete handoffFlags[key];
    assert.throws(() => expandPreflightFlags(handoffFlags), new RegExp(`require explicit --${key}`));
  }
  // a hand-off that names a profile/workflow/intent is rejected; an explicit --source must match
  const carried = JSON.parse(await fs.readFile(handoffPath, "utf8"));
  const carriedPath = `${handoffPath}.bad.json`;
  await fs.writeFile(carriedPath, JSON.stringify({ ...carried, content_profile: "manhwa_recap_v1" }));
  assert.throws(() => expandPreflightFlags({ ...explicit, "source-handoff": carriedPath }), /source_handoff_carries_content_profile/);
  assert.throws(() => expandPreflightFlags({ ...explicit, "source-handoff": handoffPath, source: "/elsewhere/script.txt" }), /does not match the hand-off/);
  // a brought script without a brief has no title: --title is required
  await fs.writeFile(carriedPath, JSON.stringify({ ...carried, title: null }));
  assert.throws(() => expandPreflightFlags({ ...explicit, "source-handoff": carriedPath }), /pass --title explicitly/);
  assert.equal(expandPreflightFlags({ ...explicit, "source-handoff": carriedPath, title: "Operator title" }).flags.title, "Operator title");
});

async function preflight(args, dataRoot) {
  return execFileAsync(process.execPath, ["scripts/run-preflight.mjs", ...args], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
}

test("real preflight records the preset and hand-off by hash and verifies the script sha", async () => {
  const { root, handoffPath, presetPath, scriptPath } = await scratch();
  // panel_composition_v1 needs production intent, which needs a clean worktree; the diagnostic
  // fixture run keeps every other baseline flag and the dirty-worktree waiver.
  const preset = basePreset();
  delete preset.flags["render-profile"];
  await fs.writeFile(presetPath, JSON.stringify(preset));
  const dataRoot = path.join(root, "data");
  const args = [
    "--content-profile", "manhwa_recap_v1", "--media-workflow", "generated_visuals_v1", "--run-intent", "diagnostic",
    "--channel", "53rebirth", "--series", "coma-healer", "--week", "run", "--episode", "ep_01",
    "--source-handoff", handoffPath, "--channel-preset", presetPath,
    "--allow-dirty-worktree", "true", "--dirty-reason", "fixture test",
  ];
  await preflight(args, dataRoot);
  const identity = JSON.parse(await fs.readFile(path.join(dataRoot, "channels", "53rebirth", "weekly_runs", "run", "episodes", "ep_01", "run_identity.json"), "utf8"));
  assert.equal(identity.title, fixture.title);
  assert.equal(identity.source_path, scriptPath);
  assert.equal(identity.source_sha256, sha(SCRIPT));
  assert.equal(identity.content_profile, fixture.content_profile);
  assert.equal(identity.media_workflow, fixture.media_workflow);
  for (const key of ["planning_provider", "planning_effort_policy", "image_provider", "tts_provider", "audio_target", "production_profile", "pace_policy", "target_wpm_min", "target_wpm_max", "motion_policy", "generated_motion_policy", "parallax_policy"]) {
    assert.equal(identity[key], fixture[key], key);
  }
  assert.deepEqual(identity.visual_beat_timing_contract, fixture.visual_beat_timing_contract);
  assert.equal(identity.channel_preset.sha256, sha(await fs.readFile(presetPath)));
  assert.equal(identity.channel_preset.path, presetPath);
  assert.deepEqual(identity.channel_preset.explicit_flags_required, ["content-profile", "media-workflow", "run-intent"]);
  assert.equal(identity.source_handoff.sha256, sha(await fs.readFile(handoffPath)));
  assert.equal(identity.source_handoff.script_sha256, sha(SCRIPT));
  assert.equal(identity.source_handoff.title, fixture.title);
  assert.equal(identity.source_handoff.model_lock_sha256, "2".repeat(64));
  // a script that no longer matches the hand-off never becomes an identity
  await fs.writeFile(scriptPath, `${SCRIPT}An edit after the hand-off.\n`);
  await assert.rejects(preflight(args.map((value) => (value === "ep_01" ? "ep_02" : value)), dataRoot), /does not match .*re-run source manufacture revise/s);
  await assert.rejects(fs.access(path.join(dataRoot, "channels", "53rebirth", "weekly_runs", "run", "episodes", "ep_02", "run_identity.json")));
  // a preset carrying the run intent is refused before any identity is written
  await fs.writeFile(presetPath, JSON.stringify(basePreset({ "run-intent": "production" })));
  await fs.writeFile(scriptPath, SCRIPT);
  await assert.rejects(preflight(args.map((value) => (value === "ep_01" ? "ep_03" : value)), dataRoot), /may not supply --run-intent/);
  await fs.rm(root, { recursive: true, force: true });
});
