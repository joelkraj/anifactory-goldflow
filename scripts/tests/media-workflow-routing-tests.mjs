import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { contentProfileDefinition } from "../lib/content-profiles.mjs";
import { mediaWorkflowForPreflight, resolveMediaWorkflow } from "../lib/media-workflows.mjs";
import { PIPELINE_STAGE_REGISTRY } from "../lib/pipeline-stage-registry.mjs";
import { assertCommandWorkflowRoute } from "../lib/episode-workflow-routing.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-workflow-routing-test-"));
// Do not inherit account keys, provider overrides, or a live episode context.
const env = { PATH: process.env.PATH, TMPDIR: scratch, ANIFACTORY_DATA_ROOT: scratch };
const sourcePath = path.join(scratch, "routing-source.md");
await fs.writeFile(sourcePath, "A synthetic local source used only to test routing guards.\n");
let tests = 0;

async function test(name, work) {
  await work();
  tests += 1;
  console.log(`ok - ${name}`);
}

async function run(args, { commandEnv = env, cwd = repoRoot } = {}) {
  try {
    const result = await execFileAsync(process.execPath, args, { cwd, env: commandEnv, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, ...result };
  } catch (error) {
    if (error.killed || typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function treeSnapshot(root) {
  const entries = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (entry.isDirectory()) { entries.push([relative, "directory"]); await walk(file); }
      else if (entry.isSymbolicLink()) entries.push([relative, "symlink", await fs.readlink(file)]);
      else entries.push([relative, "file", createHash("sha256").update(await fs.readFile(file)).digest("hex")]);
    }
  }
  await walk(root);
  return entries;
}

async function unchangedFailure(args, options, match = /workflow|content.profile|run identity/i) {
  const before = await treeSnapshot(scratch);
  const result = await run(args, options);
  assert.notEqual(result.code, 0, `Command unexpectedly passed: ${args.join(" ")}`);
  assert.match(`${result.stdout}\n${result.stderr}`, match);
  assert.deepEqual(await treeSnapshot(scratch), before, "Blocked routing must not write stage events, manifests, episode directories, or other artifacts.");
  return result;
}

function legacyIdentity(profile) {
  const identity = {
    schema: "goldflow_run_identity_v1", channel: "routing_fixture", series_slug: "routing-fixture",
    week: "routing-fixture", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab",
    run_intent: "proof", proof_scope: { mode: "bounded", start_sec: 0, end_sec: 4 },
  };
  if (profile) {
    const definition = contentProfileDefinition(profile);
    Object.assign(identity, { content_profile: definition.config.id, content_profile_version: definition.config.version,
      content_profile_sha256: definition.sha256, content_profile_config: definition.config,
      stage_registry_version: generatedBinding(profile).workflow_contract.stage_registry_version });
  }
  return identity;
}

function generatedBinding(profile = "manhwa_recap_v1") {
  return mediaWorkflowForPreflight({ contentProfile: profile, mediaWorkflow: "generated_visuals_v1" });
}

async function writeIdentity(label, identity, raw = false) {
  const directory = path.join(scratch, "cases", label, "episodes", "ep_01");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "run_identity.json"), raw ? identity : `${JSON.stringify(identity, null, 2)}\n`);
  return directory;
}

function stageShape(status) {
  return status.stage_ledger.map((stage) => ({
    stage: stage.stage, state: stage.state, required_input: stage.required_input,
    output_artifact: stage.output_artifact, operator_approval_required: stage.operator_approval_required,
    next_command_shape: stage.next_command_shape,
  }));
}

try {
  for (const profile of [undefined, "manhwa_recap_v1", "asset_afterlife_v1"]) {
    await test(`${profile ?? "implicit historical manhwa"}: legacy and locked generated status preserve stage order/defaults without mutation`, async () => {
      const old = legacyIdentity(profile);
      const episodeDir = await writeIdentity(profile ?? "implicit-manhwa", old);
      const identityPath = path.join(episodeDir, "run_identity.json");
      const before = await treeSnapshot(scratch);
      const legacyResult = await run(["bin/goldflow.mjs", "run", "status", "--episode-dir", episodeDir]);
      assert.equal(legacyResult.code, 0, legacyResult.stderr);
      const legacy = JSON.parse(legacyResult.stdout);
      assert.equal(legacy.media_workflow.id, "generated_visuals_v1");
      assert.equal(legacy.media_workflow.legacy, true);
      assert.deepEqual(await treeSnapshot(scratch), before, "Status must not persist a migration into a historical run.");
      assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(identityPath, "utf8")), "media_workflow"), false);
      // A new explicit run also records its editorial profile; the genuinely
      // historical fixture above intentionally omits it to exercise old defaults.
      const locked = { ...legacyIdentity(profile ?? "manhwa_recap_v1"), ...generatedBinding(profile) };
      assert.equal(resolveMediaWorkflow(locked).legacy, false);
      await fs.writeFile(identityPath, `${JSON.stringify(locked, null, 2)}\n`);
      const lockedBefore = await treeSnapshot(scratch);
      const lockedResult = await run(["scripts/run-status.mjs", "--episode-dir", episodeDir]);
      assert.equal(lockedResult.code, 0, lockedResult.stderr);
      const status = JSON.parse(lockedResult.stdout);
      assert.equal(status.media_workflow.legacy, false);
      assert.equal(status.media_workflow.sha256, locked.workflow_contract.sha256);
      assert.deepEqual(status.stage_ledger.map((row) => row.stage), PIPELINE_STAGE_REGISTRY.map((row) => row.id));
      if (profile === "asset_afterlife_v1") {
        assert.equal(legacy.stage_ledger.find((row) => row.stage === "upload_packaging").state, "missing");
        const packaging = status.stage_ledger.find((row) => row.stage === "upload_packaging");
        assert.equal(packaging.state, "blocked");
        assert.match(packaging.evidence, /adapter|not.*available|unsupported|not.*implemented/i);
        assert.deepEqual(stageShape(status).filter((row) => row.stage !== "upload_packaging"),
          stageShape(legacy).filter((row) => row.stage !== "upload_packaging"));
      }
      else if (profile) assert.deepEqual(stageShape(status), stageShape(legacy));
      else {
        // Very old runs without a registry marker keep their existing waivers;
        // an explicit current contract intentionally binds the current registry.
        const newerRegistryGates = new Set(["image_focal_analysis", "youtube_publish_readiness", "youtube_studio_upload", "youtube_pinned_comment"]);
        for (const stage of newerRegistryGates) {
          assert.equal(legacy.stage_ledger.find((row) => row.stage === stage).state, "skipped_with_waiver");
          assert.equal(status.stage_ledger.find((row) => row.stage === stage).state, "missing");
        }
        assert.deepEqual(stageShape(status).filter((row) => !newerRegistryGates.has(row.stage)),
          stageShape(legacy).filter((row) => !newerRegistryGates.has(row.stage)));
      }
      for (const key of ["current_stage", "current_stage_state", "allowed_command_stages", "next_command_shape"]) assert.deepEqual(status[key], legacy[key]);
      for (const key of ["audio_target", "image_provider", "render_profile", "target_wpm_min", "target_wpm_max"]) assert.deepEqual(status.identity[key], legacy.identity[key]);
      assert.equal(status.identity.content_profile, legacy.identity.content_profile ?? "manhwa_recap_v1");
      assert.deepEqual(await treeSnapshot(scratch), lockedBefore);
    });
  }

  const base = { ...legacyIdentity("manhwa_recap_v1"), ...generatedBinding() };
  const invalidIdentities = [
    ["reserved-source-footage", { ...base, media_workflow: "source_footage_v1" }],
    ["reserved-movie-profile", { ...base, content_profile: "movie_tv_commentary_v1" }],
    ["reserved-profile-without-workflow-fields", { ...legacyIdentity(), content_profile: "movie_tv_commentary_v1" }],
    ["unknown-workflow", { ...base, media_workflow: "future_unimplemented_v1" }],
    ["missing-contract", { ...legacyIdentity(), media_workflow: "generated_visuals_v1" }],
    ["missing-workflow", { ...legacyIdentity(), workflow_contract: base.workflow_contract }],
    ["null-explicit-contract", { ...base, workflow_contract: null }],
    ["wrong-contract-type", { ...base, workflow_contract: "generated_visuals_v1" }],
    ["tampered-contract-hash", { ...base, workflow_contract: { ...base.workflow_contract, sha256: "0".repeat(64) } }],
    ["stale-contract-registry", { ...base, workflow_contract: { ...base.workflow_contract, stage_registry_version: "stale-fixture" } }],
    ["conflicting-content-profile", { ...base, content_profile: "asset_afterlife_v1" }],
  ];
  for (const [label, identity] of invalidIdentities) {
    await test(`${label}: status and global CLI fail closed before ledger writes, including both bypass mechanisms`, async () => {
      const episodeDir = await writeIdentity(label, identity);
      await unchangedFailure(["scripts/run-status.mjs", "--episode-dir", episodeDir]);
      await unchangedFailure(["bin/goldflow.mjs", "run", "status", "--episode-dir", episodeDir]);
      // Ingest is local-only even if a future regression defeats the route gate.
      const command = ["bin/goldflow.mjs", "ingest", "source", "--episode-dir", episodeDir, "--source", sourcePath];
      await unchangedFailure([...command, "--workflow-bypass", "true"]);
      await unchangedFailure(command, { commandEnv: { ...env, GOLDFLOW_WORKFLOW_BYPASS: "true" } });
    });
  }
  for (const [label, raw] of [["corrupt-json", "{ broken JSON"], ["null-json", "null"], ["array-json", "[]"]]) {
    await test(`${label}: malformed run identities cannot become legacy adapters`, async () => {
      const episodeDir = await writeIdentity(label, raw, true);
      await unchangedFailure(["scripts/run-status.mjs", "--episode-dir", episodeDir]);
      await unchangedFailure(["bin/goldflow.mjs", "ingest", "source", "--episode-dir", episodeDir,
        "--source", sourcePath, "--workflow-bypass", "true"], { commandEnv: { ...env, GOLDFLOW_WORKFLOW_BYPASS: "true" } });
    });
  }

  await test("omitted or partial episode context cannot dispatch into child defaults even with bypass", async () => {
    const episodeDir = path.join(scratch, "channels", "53rebirth", "weekly_runs", "current", "episodes", "ep_01");
    await fs.mkdir(episodeDir, { recursive: true });
    await fs.writeFile(path.join(episodeDir, "run_identity.json"), JSON.stringify({ ...base, media_workflow: "source_footage_v1" }));
    await fs.writeFile(path.join(episodeDir, "script_clean.md"), "The synthetic item moved across the room.\n");
    // A missing audit prevents approval even if a regression dispatches the child;
    // its earlier contamination report would still expose the forbidden mutation.
    for (const partial of [[], ["--channel", "53rebirth"], ["--week", "current"], ["--episode", "ep_01"],
      ["--channel", "53rebirth", "--week", "current"]]) {
      const command = ["bin/goldflow.mjs", "script", "approve", ...partial];
      await unchangedFailure([...command, "--workflow-bypass", "true"], {}, /requires explicit --episode-dir|implicit default episode/i);
      await unchangedFailure(command, { commandEnv: { ...env, GOLDFLOW_WORKFLOW_BYPASS: "true" } },
        /requires explicit --episode-dir|implicit default episode/i);
    }
  });

  await test("registered stages and episode run operations require context but standalone development and maintenance do not", async () => {
    for (const entry of PIPELINE_STAGE_REGISTRY) {
      for (const commandShape of entry.commands.filter((value) => value !== "run preflight" && !value.includes(":"))) {
        const [command, subcommand] = commandShape.split(" ");
        assert.throws(() => assertCommandWorkflowRoute({ command, subcommand, script: "fixture.mjs" }), /requires explicit --episode-dir/);
      }
    }
    for (const subcommand of ["status", "performance-audit", "reference-roi", "media-ready", "advance", "director",
      "audio-semantic-fork", "visual-wavefront", "cleanup"]) {
      assert.throws(() => assertCommandWorkflowRoute({ command: "run", subcommand, script: "fixture.mjs" }), /requires explicit --episode-dir/);
    }
    for (const [command, subcommand, script] of [["source", "manufacture", "source-script-manufacturer.mjs"],
      ["run", "codex-doctor", "codex-runtime-doctor.mjs"], ["run", "web-archive-cleanup", "chatgpt-web-archive-cleanup.mjs"],
      ["benchmark", "planner", "planner-benchmark.mjs"], ["sfx-bank", "audit", "sfx-bank-maintain.mjs"]]) {
      assert.equal(assertCommandWorkflowRoute({ command, subcommand, script }), null);
    }
  });

  await test("tuple-only children cannot route through an unrelated explicit episode directory", async () => {
    const safeDir = await writeIdentity("tuple-safe", base);
    const forbiddenDir = path.join(scratch, "channels", "routing_fixture", "weekly_runs", "tuple-forbidden", "episodes", "ep_01");
    await fs.mkdir(forbiddenDir, { recursive: true });
    await fs.writeFile(path.join(forbiddenDir, "run_identity.json"), JSON.stringify({ ...base, media_workflow: "source_footage_v1" }));
    const tuple = ["--channel", "routing_fixture", "--week", "tuple-forbidden", "--episode", "ep_01"];
    for (const flags of [["--episode-dir", safeDir], ["--episode-dir", safeDir, ...tuple]]) {
      await unchangedFailure(["bin/goldflow.mjs", "ingest", "source", ...flags, "--source", sourcePath,
        "--workflow-bypass", "true"], { commandEnv: { ...env, GOLDFLOW_WORKFLOW_BYPASS: "true" } }, /does not support --episode-dir/);
    }
    await unchangedFailure(["bin/goldflow.mjs", "run", "preflight", "--episode-dir", path.join(scratch, "preflight-unrelated"),
      "--channel", "routing_fixture", "--series", "routing-fixture", "--week", "must-not-preflight", "--episode", "ep_01",
      "--content-profile", "manhwa_recap_v1", "--media-workflow", "generated_visuals_v1", "--source", sourcePath,
      "--title", "Must not create episode", "--run-intent", "proof", "--proof-scope", "0-4",
      "--allow-dirty-worktree", "true", "--dirty-reason", "routing regression", "--workflow-bypass", "true"], {}, /does not support --episode-dir/);
    await unchangedFailure(["bin/goldflow.mjs", "run", "cleanup", "--episode-dir", safeDir,
      "--episodeDir", forbiddenDir, "--workflow-bypass", "true"], {}, /ambiguous --episodeDir alias/);
  });

  await test("mixed repeated equals-form arguments use identical last-value precedence in guard and child", async () => {
    const safeDir = await writeIdentity("mixed-flags-safe", base);
    const forbiddenDir = await writeIdentity("mixed-flags-forbidden", { ...base, media_workflow: "source_footage_v1" });
    const before = await treeSnapshot(scratch);
    const status = await run(["bin/goldflow.mjs", "run", "status", "--episode-dir", forbiddenDir, `--episode-dir=${safeDir}`]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).episode_dir, safeDir);
    assert.deepEqual(await treeSnapshot(scratch), before);
    await unchangedFailure(["bin/goldflow.mjs", "script", "approve", `--episode-dir=${safeDir}`,
      "--episode-dir", forbiddenDir, "--workflow-bypass", "true"], {}, /reserved|unavailable/);
  });

  await test("explicit flags cannot switch a historical or locked existing run's workflow/content profile", async () => {
    for (const identity of [legacyIdentity("manhwa_recap_v1"), base]) {
      const episodeDir = await writeIdentity("flag-switch", identity);
      for (const overrides of [["--content-profile", "asset_afterlife_v1"], ["--media-workflow", "source_footage_v1"]]) {
        await unchangedFailure(["bin/goldflow.mjs", "ingest", "source", "--episode-dir", episodeDir,
          "--source", sourcePath, "--workflow-bypass", "true", ...overrides], {}, /identity.locked|cannot switch|unavailable/i);
        await unchangedFailure(["scripts/run-status.mjs", "--episode-dir", episodeDir, ...overrides], {}, /identity.locked|cannot switch|unavailable/i);
      }
      const result = await run(["bin/goldflow.mjs", "run", "status", "--episode-dir", episodeDir,
        "--content-profile", "manhwa_recap_v1", "--media-workflow", "generated_visuals_v1"]);
      assert.equal(result.code, 0, result.stderr);
    }
  });

  await test("custom profile raw IDs bind through preflight and matching existing-run flags", async () => {
    const customPath = path.join(scratch, "custom-documentary-profile.json");
    const customProfile = { ...contentProfileDefinition("manhwa_recap_v1").config, id: "Custom Documentary V1" };
    await fs.writeFile(customPath, `${JSON.stringify(customProfile, null, 2)}\n`);
    const definition = contentProfileDefinition(customPath);
    assert.equal(definition.config.id, "Custom Documentary V1");
    assert.notEqual(definition.id, definition.config.id, "Exercise the raw ID versus normalized lookup-ID boundary.");
    const binding = generatedBinding(customPath);
    assert.equal(resolveMediaWorkflow({ ...legacyIdentity(customPath), ...binding }).legacy, false);
    const preflight = await run(["bin/goldflow.mjs", "run", "preflight", "--channel", "routing_fixture",
      "--series", "custom-documentary", "--week", "custom-documentary", "--episode", "ep_01",
      "--content-profile", customPath, "--media-workflow", "generated_visuals_v1", "--source", sourcePath,
      "--title", "Custom profile local fixture", "--image-provider", "modelslab", "--run-intent", "proof",
      "--proof-scope", "0-4", "--allow-dirty-worktree", "true", "--dirty-reason", "provider-free routing fixture"]);
    assert.equal(preflight.code, 0, preflight.stderr);
    const episodeDir = path.join(scratch, "channels", "routing_fixture", "weekly_runs", "custom-documentary", "episodes", "ep_01");
    const identity = JSON.parse(await fs.readFile(path.join(episodeDir, "run_identity.json"), "utf8"));
    assert.equal(identity.content_profile, customProfile.id);
    assert.equal(identity.content_profile_config.id, customProfile.id);
    assert.deepEqual(identity.workflow_contract, binding.workflow_contract);
    const before = await treeSnapshot(scratch);
    for (const command of [["bin/goldflow.mjs", "run", "status"], ["scripts/run-status.mjs"]]) {
      const result = await run([...command, "--episode-dir", episodeDir, "--content-profile", customPath,
        "--media-workflow", "generated_visuals_v1"]);
      assert.equal(result.code, 0, result.stderr);
      const status = JSON.parse(result.stdout);
      assert.equal(status.identity.content_profile, customProfile.id);
      assert.equal(status.workflow_selection_state, "locked");
    }
    assert.deepEqual(await treeSnapshot(scratch), before);
  });

  await test("caller-relative episode and custom-profile paths retain the same read-only status identity", async () => {
    const callerDir = path.join(scratch, "operator working directory");
    await fs.mkdir(callerDir);
    const customPath = path.join(scratch, "caller custom profile.json");
    await fs.writeFile(customPath, JSON.stringify({ ...contentProfileDefinition("manhwa_recap_v1").config,
      id: "Caller Custom Documentary V1" }));
    const customIdentity = { ...legacyIdentity(customPath), ...generatedBinding(customPath) };
    const cases = [
      { label: "cwd-custom", identity: customIdentity, absoluteProfile: customPath, callerProfile: path.relative(callerDir, customPath) },
      { label: "cwd-manhwa-alias", identity: base, absoluteProfile: "manhwa", callerProfile: "manhwa" },
      { label: "cwd-documentary-alias", identity: { ...legacyIdentity("asset_afterlife_v1"), ...generatedBinding("asset_afterlife_v1") },
        absoluteProfile: "asset-afterlife", callerProfile: "asset-afterlife" },
    ];
    for (const fixture of cases) {
      const episodeDir = await writeIdentity(fixture.label, fixture.identity);
      const before = await treeSnapshot(scratch);
      const baseline = await run(["bin/goldflow.mjs", "run", "status", "--episode-dir", episodeDir,
        "--content-profile", fixture.absoluteProfile]);
      assert.equal(baseline.code, 0, baseline.stderr);
      const expected = JSON.parse(baseline.stdout);
      const relative = await run([path.join(repoRoot, "bin", "goldflow.mjs"), "run", "status",
        "--episode-dir", path.relative(callerDir, episodeDir), "--content-profile", fixture.callerProfile,
        "--media-workflow", "generated_visuals_v1"], { cwd: callerDir });
      assert.equal(relative.code, 0, relative.stderr);
      const actual = JSON.parse(relative.stdout);
      assert.equal(await fs.realpath(actual.episode_dir), await fs.realpath(episodeDir));
      assert.deepEqual(actual.identity, expected.identity);
      assert.deepEqual(actual.media_workflow, expected.media_workflow);
      assert.equal(actual.workflow_selection_state, "locked");
      assert.deepEqual(await treeSnapshot(scratch), before, "Changing caller cwd must not mutate either identity or create episode artifacts.");
    }
  });

  await test("legacy embedded profiles retain precedence for matching flags and source-authoring restrictions", async () => {
    const historical = { ...legacyIdentity("asset_afterlife_v1"), content_profile: "manhwa_recap_v1" };
    assert.equal(resolveMediaWorkflow(historical).legacy, true);
    assert.throws(() => resolveMediaWorkflow({ ...historical, ...generatedBinding() }), /content.profile|disagree|match/i);
    const episodeDir = await writeIdentity("legacy-embedded-precedence", historical);
    const before = await treeSnapshot(scratch);
    for (const command of [["bin/goldflow.mjs", "run", "status"], ["scripts/run-status.mjs"]]) {
      const result = await run([...command, "--episode-dir", episodeDir, "--content-profile", "asset_afterlife_v1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).workflow_selection_state, "legacy_adapter");
    }
    assert.deepEqual(await treeSnapshot(scratch), before);
    await unchangedFailure(["bin/goldflow.mjs", "run", "status", "--episode-dir", episodeDir,
      "--content-profile", "manhwa_recap_v1"], {}, /identity.locked|cannot switch/i);
    for (const profileFlags of [[], ["--content-profile", "asset_afterlife_v1"]]) {
      await unchangedFailure(["bin/goldflow.mjs", "source", "manufacture", "prepare", "--episode-dir", episodeDir,
        ...profileFlags, "--development-dir", path.join(scratch, "must-not-author-legacy"),
        "--brief", path.join(scratch, "deliberately-missing-brief.json"), "--workflow-bypass", "true"],
      { commandEnv: { ...env, GOLDFLOW_WORKFLOW_BYPASS: "true" } }, /manhwa_recap_v1 only|own source.development guidance/i);
    }
  });

  await test("prospective status accepts explicit selections without inventing a persisted identity", async () => {
    const episodeDir = path.join(scratch, "nonexistent-run", "episodes", "ep_01");
    const before = await treeSnapshot(scratch);
    for (const command of [["bin/goldflow.mjs", "run", "status"], ["scripts/run-status.mjs"]]) {
      const result = await run([...command, "--episode-dir", episodeDir, "--content-profile", "asset_afterlife_v1",
        "--media-workflow", "generated_visuals_v1"]);
      assert.equal(result.code, 0, result.stderr);
      const status = JSON.parse(result.stdout);
      assert.equal(status.workflow_selection_state, "missing");
      assert.equal(status.media_workflow.id, "generated_visuals_v1");
      assert.equal(status.stage_ledger.find((stage) => stage.stage === "run_identity").state, "missing");
    }
    assert.deepEqual(await treeSnapshot(scratch), before, "Prospective status must not create episode directories or identity files.");
  });

  await test("new preflights require both explicit selections and reject reserved routes before creating episodes", async () => {
    const common = ["--channel", "routing_fixture", "--series", "routing_fixture", "--week", "must-not-create", "--episode", "ep_01",
      "--source", sourcePath, "--title", "Local routing fixture", "--image-provider", "modelslab",
      "--run-intent", "proof", "--proof-scope", "0-4", "--allow-dirty-worktree", "true", "--dirty-reason", "routing fixture"];
    for (const selection of [[], ["--content-profile", "manhwa_recap_v1"], ["--media-workflow", "generated_visuals_v1"],
      ["--content-profile", "manhwa_recap_v1", "--media-workflow", "source_footage_v1"],
      ["--content-profile", "movie_tv_commentary_v1", "--media-workflow", "generated_visuals_v1"],
      ["--content-profile", "nonexistent_fixture_profile_v1", "--media-workflow", "generated_visuals_v1"],
      ["--content-profile", "manhwa_recap_v1", "--media-workflow", "unknown_fixture_v1"]]) {
      await unchangedFailure(["scripts/run-preflight.mjs", ...common, ...selection]);
      await unchangedFailure(["bin/goldflow.mjs", "run", "preflight", ...common, ...selection, "--workflow-bypass", "true"]);
    }
  });

  await test("preflight cannot overwrite an existing identity even with identical explicit selections or bypass", async () => {
    const episodeDir = path.join(scratch, "channels", "routing_fixture", "weekly_runs", "existing-identity", "episodes", "ep_01");
    await fs.mkdir(episodeDir, { recursive: true });
    await fs.writeFile(path.join(episodeDir, "run_identity.json"), `${JSON.stringify({ ...base, week: "existing-identity" }, null, 2)}\n`);
    const common = ["--channel", "routing_fixture", "--series", "routing-fixture", "--week", "existing-identity", "--episode", "ep_01",
      "--content-profile", "manhwa_recap_v1", "--media-workflow", "generated_visuals_v1", "--source", sourcePath,
      "--title", "Must not replace the existing fixture", "--image-provider", "modelslab", "--run-intent", "proof", "--proof-scope", "0-4",
      "--allow-dirty-worktree", "true", "--dirty-reason", "routing fixture"];
    await unchangedFailure(["scripts/run-preflight.mjs", ...common], {}, /already exists|cannot overwrite|immutable/i);
    await unchangedFailure(["bin/goldflow.mjs", "run", "preflight", ...common, "--workflow-bypass", "true"],
      { commandEnv: { ...env, GOLDFLOW_WORKFLOW_BYPASS: "true" } }, /already exists|cannot overwrite|immutable/i);
  });

  await test("Asset Afterlife cannot enter manhwa source manufacture, including workflow bypass", async () => {
    const command = ["bin/goldflow.mjs", "source", "manufacture", "prepare", "--content-profile", "asset_afterlife_v1",
      "--media-workflow", "generated_visuals_v1", "--development-dir", path.join(scratch, "must-not-author"),
      "--brief", path.join(scratch, "deliberately-missing-brief.json")];
    // The missing brief is a second safety barrier: no provider call is possible
    // even if the intended routing refusal regresses.
    await unchangedFailure(command, {}, /manhwa_recap_v1 only|own source.development guidance/i);
    await unchangedFailure([...command, "--workflow-bypass", "true"],
      { commandEnv: { ...env, GOLDFLOW_WORKFLOW_BYPASS: "true" } }, /manhwa_recap_v1 only|own source.development guidance/i);
  });

  await test("standalone footage help/config remain outside production routing without reading real keys", async () => {
    const isolatedRepo = path.join(scratch, "isolated-footage-cli");
    await fs.mkdir(path.join(isolatedRepo, "bin"), { recursive: true });
    await fs.mkdir(path.join(isolatedRepo, "scripts"), { recursive: true });
    // Copy only two entrypoints. The shared library symlink is read-only; config
    // resolves against this isolated checkout where no account key file exists.
    await fs.copyFile(path.join(repoRoot, "bin", "goldflow.mjs"), path.join(isolatedRepo, "bin", "goldflow.mjs"));
    await fs.copyFile(path.join(repoRoot, "scripts", "footage.mjs"), path.join(isolatedRepo, "scripts", "footage.mjs"));
    await fs.symlink(path.join(repoRoot, "scripts", "lib"), path.join(isolatedRepo, "scripts", "lib"), "dir");
    const before = await treeSnapshot(scratch);
    const help = await run([path.join(isolatedRepo, "bin", "goldflow.mjs"), "footage", "--help"], { cwd: isolatedRepo });
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /private|footage/i);
    const configResult = await run([path.join(isolatedRepo, "bin", "goldflow.mjs"), "footage", "config"], { cwd: isolatedRepo });
    assert.equal(configResult.code, 0, configResult.stderr);
    const config = JSON.parse(configResult.stdout);
    assert.equal(config.providers.torbox.configured, false);
    assert.equal(config.providers.real_debrid.configured, false);
    assert.equal(config.config_path, path.join(await fs.realpath(isolatedRepo), ".env.footage.local"));
    assert.deepEqual(await treeSnapshot(scratch), before);
  });

  console.log(`media workflow routing suite passed (${tests} provider-free tests)`);
} finally {
  // Remove only this uniquely created synthetic test workspace, never real runs.
  await fs.rm(scratch, { recursive: true, force: true });
}
