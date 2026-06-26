#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  allowedRefIdsForScene,
  applyDeterministicLocationSceneIds,
  dropOutOfScopePromptRefs,
  locationCoverageFindings,
  outOfScopeLocationRefMentions,
  referenceTargetsForScene,
} from "./lib/visual-scope-utils.mjs";

const execFileAsync = promisify(execFile);

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function testLocationSceneIdsDerivation() {
  const semanticScenes = [
    { scene_id: "scene_001", location: "apartment kitchen", ref_requirements: [{ kind: "location", ref_id: "loc_apartment" }] },
    { scene_id: "scene_003", location: "boardroom", ref_requirements: [{ kind: "location", ref_id: "loc_boardroom" }] },
    { scene_id: "scene_005", location: "apartment kitchen", ref_requirements: [{ kind: "location", ref_id: "loc_apartment" }] },
  ];
  const llmTargets = [
    { ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_999"] },
    { ref_id: "loc_boardroom", kind: "location", scene_ids: [] },
    { ref_id: "style_ref", kind: "style", scene_ids: [] },
  ];
  const { targets } = applyDeterministicLocationSceneIds(llmTargets, semanticScenes);
  const apartment = targets.find((target) => target.ref_id === "loc_apartment");
  const boardroom = targets.find((target) => target.ref_id === "loc_boardroom");
  assert.deepEqual(new Set(apartment.scene_ids), new Set(["scene_999", "scene_001", "scene_005"]));
  assert.deepEqual(new Set(boardroom.scene_ids), new Set(["scene_003"]));
}

function testLocationCandidateExclusion() {
  const visualReferencePlan = {
    reference_targets: [
      { ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_001", "scene_005"] },
      { ref_id: "loc_boardroom", kind: "location", scene_ids: ["scene_003"] },
      { ref_id: "style_ref", kind: "style", scene_ids: [] },
    ],
  };
  const sceneThreeRefs = referenceTargetsForScene({ scene_id: "scene_003" }, visualReferencePlan).map((target) => target.ref_id);
  assert.deepEqual(new Set(sceneThreeRefs), new Set(["loc_boardroom", "style_ref"]));
  assert.equal(sceneThreeRefs.includes("loc_apartment"), false);
}

function testStarvationGate() {
  const findings = locationCoverageFindings(
    [{ ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_001"] }],
    [
      { scene_id: "scene_001", location: "apartment", ref_requirements: [{ kind: "location", ref_id: "loc_apartment" }] },
      { scene_id: "scene_002", location: "courthouse lobby", ref_requirements: [{ kind: "location", ref_id: "loc_courthouse" }] },
    ]
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "scene_missing_location_ref");
  assert.equal(findings[0].scene_id, "scene_002");
}

function testOutOfScopeRefDropping() {
  const scene = { scene_id: "scene_001" };
  const visualReferencePlan = {
    reference_targets: [
      { ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_001"] },
      { ref_id: "char_joey_ref", kind: "character_state", scene_ids: ["scene_001"] },
      { ref_id: "style_ref", kind: "style", scene_ids: [] },
    ],
  };
  const characterStateRefs = [
    { state_ref_id: "char_joey_state", source_ref_id: "char_joey_ref", scene_ids: ["scene_001"] },
  ];
  const allowed = allowedRefIdsForScene({ scene, visualReferencePlan, characterStateRefs });
  const prompt = {
    reference_requirements: [
      { ref_id: "loc_apartment", kind: "location" },
      { ref_id: "loc_wrong", kind: "location" },
    ],
    reference_usage: [],
    shot_manifest: {
      location_ref_id: "loc_wrong",
      character_state_ref_ids: ["char_joey_state", "char_wrong_state"],
      protagonist_state_ref_id: "char_wrong_protagonist",
    },
  };
  const sanitized = dropOutOfScopePromptRefs(prompt, allowed);
  assert.equal(sanitized.shot_manifest.location_ref_id, null);
  assert.deepEqual(sanitized.shot_manifest.character_state_ref_ids, ["char_joey_state"]);
  assert.equal(sanitized.shot_manifest.protagonist_state_ref_id, null);
  assert.deepEqual(sanitized.reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment"]);
  const droppedFields = sanitized.reference_usage
    .filter((usage) => usage.usage === "out_of_scope_ref_dropped")
    .map((usage) => usage.field);
  assert.deepEqual(new Set(droppedFields), new Set([
    "shot_manifest.location_ref_id",
    "shot_manifest.character_state_ref_ids",
    "shot_manifest.protagonist_state_ref_id",
    "reference_requirements.ref_id",
  ]));
}

function testOutOfScopeLocationMentionAssertion() {
  const mentions = outOfScopeLocationRefMentions({
    text: "A polished frame accidentally names loc_boardroom inside an apartment beat.",
    locationTargets: [
      { ref_id: "loc_apartment", kind: "location" },
      { ref_id: "loc_boardroom", kind: "location" },
    ],
    allowedLocationRefId: "loc_apartment",
  });
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].code, "out_of_scope_location_ref_mentioned");
  assert.equal(mentions[0].severity, "blocker");
}

async function testOnlyScenesDryRun() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    timing_source: "fixture",
    scenes: [
      { scene_id: "scene_001", start_sec: 0, duration_sec: 5, location: "apartment" },
      { scene_id: "scene_002", start_sec: 5, duration_sec: 5, location: "boardroom" },
    ],
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    beats: [
      { scene_id: "scene_001", parent_scene_id: "scene_001", visual_beat_id: "scene_001_beat_01", start_sec: 0, duration_sec: 5, location: "apartment" },
      { scene_id: "scene_002", parent_scene_id: "scene_002", visual_beat_id: "scene_002_beat_01", start_sec: 5, duration_sec: 5, location: "boardroom" },
    ],
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: hash, scenes: [] });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [{ ref_id: "style_ref", kind: "style", scene_ids: [] }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", source_script_hash: hash, character_state_refs: [] });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), {});
  await writeJson(path.join(weekDir, "character_bible.json"), {});
  const output = path.join(episodeDir, "dry_run_visual_plan.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--dry-run-prompt", "true",
    "--only-scenes", "scene_002",
    "--output", output,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(report.visual_plan_scope.selected_visual_unit_count, 1);
  assert.deepEqual(report.visual_plan_scope.cut_ids, ["ep_01-cut-002"]);
}

async function testImagegenDeadletterRefusal() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), { status: "passed", reference_targets: [] });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", character_state_refs: [] });
  await writeJson(path.join(episodeDir, "section_image_prompts_hardened.json"), {
    status: "passed",
    prompt_policy: "deterministic hardening fixture",
    prompts: [{ image_id: "ep_01-cut-001", scene_id: "scene_001", image_prompt: "one visible fixture frame", modelslab_image_prompt: "one visible fixture frame", image_generation_required: true }],
  });
  await writeJson(path.join(episodeDir, "visual_resolution_deadletter.json"), {
    status: "blocked_deadletter",
    scene_ids: ["scene_001"],
  });
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/imagegen.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "run",
      "--episode", "ep_01",
      "--skip-reference-generation", "true",
      "--allow-unhardened-prompts", "true",
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } }),
    /dead-lettered visual scenes/
  );
}

async function run() {
  testLocationSceneIdsDerivation();
  testLocationCandidateExclusion();
  testStarvationGate();
  testOutOfScopeRefDropping();
  testOutOfScopeLocationMentionAssertion();
  await testOnlyScenesDryRun();
  await testImagegenDeadletterRefusal();
  console.log("goldflow fixture tests passed");
}

await run();
