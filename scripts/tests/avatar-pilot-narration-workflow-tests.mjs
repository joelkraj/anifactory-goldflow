import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPilotRemainingExecutionFixture } from "./avatar-pilot-remaining-execution-tests.mjs";
import { buildPilotNarrationValidationFixture } from "./avatar-pilot-narration-validation-tests.mjs";
import { pilotWorkflowFixtureHarness, executePilotCommand, PILOT_REMAINING_SYNTHESIS_ADAPTER_STATUS } from "../lib/avatar-pilot-workflow.mjs";
import { validatePilotOpeningSampleResult } from "../lib/avatar-pilot-opening-validation.mjs";
import { validatePilotNarrationResult } from "../lib/avatar-pilot-narration-validation.mjs";
import { validatePilotNarrationAcceptance, buildPilotNarrationTiming, PILOT_NARRATION_LISTEN_ATTESTATION } from "../lib/avatar-pilot-narration-acceptance.mjs";
import { validateNarrationSubjectiveReviewDecision, NARRATION_SUBJECTIVE_REVIEW_ATTESTATION } from "../lib/narration-subjective-review.mjs";
import { contentProfileDefinition } from "../lib/content-profiles.mjs";
import { mediaWorkflowForPreflight } from "../lib/media-workflows.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const absent = async (file) => assert.equal(await fs.stat(file).then(() => false, (error) => error.code === "ENOENT"), true);

// Synthetic initial stages only. These files are constructed before the plan,
// gate, opening sample and approval are hashed, preserving the real validators'
// full immutable lineage. No production status, model or real media is used.
async function initialStages({ root, identityPath, identityFileSha256, sourceBytes, scriptPath, scriptSha256, writeJson }) {
  const common = { schema: "goldflow_avatar_pilot_stage_v1", fixture_only: true,
    identity_sha256: identityFileSha256, created_at: "2026-01-01T00:00:00.000Z" };
  const saveStage = async (name, payload, inputs) => {
    const file = path.join(root, `${name}.json`);
    return { path: file, sha256: await writeJson(file, { ...common, stage: name, payload, inputs }) };
  };
  const script = await saveStage("pilot_script", { text: sourceBytes.toString("utf8"), source_script_sha256: scriptSha256 }, [
    { role: "upstream", path: identityPath, sha256: identityFileSha256 },
    { role: "import", path: scriptPath, sha256: scriptSha256 },
  ]);
  const review = { approved: true, reviewer: "fixture", note: "Synthetic fixture approval only", attestation: null };
  const approval = await saveStage("pilot_script_approval", { review }, [{ role: "upstream", ...script }]);
  const evidence = { schema: "goldflow_avatar_pilot_evidence_v1", source_script_sha256: scriptSha256,
    claims: [
      { id: "fact", kind: "film_fact", text: "Synthetic fixture fact, not a film claim", source: { title: "Synthetic",
        edition: "Fixture only", locator: "Synthetic", source_in_sec: 0, source_out_sec: 4, reviewed: true, rights_basis: "Synthetic only" } },
      { id: "assumption", kind: "assumption", text: "Synthetic assumption" },
      { id: "speculation", kind: "speculation", text: "Synthetic speculation" },
      { id: "limitation", kind: "limitation", text: "Synthetic limitation" },
    ], review: { reviewer: "fixture", note: "Synthetic only", mcu_only: true, all_factual_abilities_reviewed: true } };
  const evidencePath = path.join(root, "evidence-source.json"), evidenceHash = await writeJson(evidencePath, evidence);
  return saveStage("pilot_evidence", { evidence, review }, [
    { role: "upstream", ...approval }, { role: "import", path: evidencePath, sha256: evidenceHash },
  ]);
}

const definition = contentProfileDefinition("mcu_what_if_pilot_v1");
const remaining = await buildPilotRemainingExecutionFixture({
  identityFields: { schema: "goldflow_avatar_pilot_identity_v1", channel: "fixture", series_slug: "fixture",
    week: "fixture", episode: "ep_01", title: "Synthetic workflow proof", audio_target: "commentary_with_optional_source_audio",
    content_profile_config: definition.config, content_profile_sha256: definition.sha256,
    ...mediaWorkflowForPreflight({ contentProfile: definition.id, mediaWorkflow: "avatar_footage_pilot_v1" }),
    git: { commit: "a".repeat(40), branch: "codex/synthetic-fixture", dirty_diff_sha256: hash("fixture only") },
    pilot_providers: { stills: [{ provider: "google_gemini_imagen", model: "Synthetic still model" }],
      video: { provider: "google_flow", model: "Synthetic video model", enabled: false } },
  }, evidenceFixture: initialStages,
  remainingParagraphs: [
    "Her companion waits outside until a small lamp appears in the distant window.",
    "A messenger crosses the courtyard carrying a sealed letter from the northern village.",
    "The guards study his expression while the old bell rings above the square.",
    "No one speaks until a quiet voice explains what happened beyond the mountains.",
    "The traveler considers the warning before turning back toward the open stone doorway.",
  ],
});
const fixture = await buildPilotNarrationValidationFixture({ remainingFixture: remaining });
const { root, identity, result, writeJson, acceptedOpening } = fixture;
let produced = 0, forceInvalid = false;
try {
  const candidatePath = path.join(root, "pilot_narration_work", "narration_producer_result.json");
  const attemptPath = path.join(root, "pilot_narration_work", "remaining");
  const stagingPath = path.join(root, "fixture-staged-remaining");
  const narrationStagePath = path.join(root, "pilot_narration.json");
  const decisionPath = path.join(fixture.namespace, "narration_subjective_review_decision_ep_01.json");
  const timingPath = path.join(fixture.namespace, "pilot_word_timing.json");
  const protectedPaths = new Set([acceptedOpening.sample.path, acceptedOpening.approval.path,
    ...fixture.accepted.preservedArtifacts.flatMap((row) => [row.audio_path, row.synthesis_sidecar_path]),
    ...Object.values(fixture.openingFixture.result.finalization_artifacts).map((ref) => ref.path),
    fixture.accepted.approval.subjective_decision.path,
  ]);
  const protectedBytes = new Map(await Promise.all([...protectedPaths].map(async (file) => [file, await fs.readFile(file)])));
  await fs.rename(attemptPath, stagingPath);
  const harness = pilotWorkflowFixtureHarness({ status: "proven",
    async produce() { throw new Error("Opening must never regenerate"); }, validate: validatePilotOpeningSampleResult,
    full: { status: "proven", validateAcceptance: validatePilotNarrationAcceptance,
      async validate(payload, context) {
        return forceInvalid ? { status: "blocked", findings: [{ code: "Synthetic blocked candidate" }] }
          : validatePilotNarrationResult(payload, context);
      },
      async produce({ episodeDir }) {
        assert.equal(episodeDir, root); produced++;
        assert(await fs.stat(path.join(root, ".pilot-stage.lock")), "normal lease covers remaining production");
        await fs.rename(stagingPath, attemptPath);
        await writeJson(candidatePath, result);
        return result;
      },
    } });
  const run = (action, flags = {}) => harness.executePilotCommand(action, { "episode-dir": root, ...flags });
  const status = await harness.pilotStatus(root);
  assert.equal(status.current_stage, "pilot_narration", JSON.stringify(status.stages));
  assert.deepEqual(status.allowed_command_stages, ["pilot_narration"]);
  assert.match(status.next_command_shape, /create-narration/u);
  assert.equal(status.capabilities.narration_import, "unproven", "the full generic import is not released by this separate adapter");
  await assert.rejects(() => run("import-narration", { input: candidatePath }), /imports remain blocked/u);
  await assert.rejects(() => run("approve-narration", { accept: "true", reviewer: "fixture", note: "Synthetic" }), /current narration action/u);
  if (PILOT_REMAINING_SYNTHESIS_ADAPTER_STATUS !== "proven") {
    await assert.rejects(() => executePilotCommand("create-narration", { "episode-dir": root, "remaining-capability": "proven" }), /stopped at/u);
    assert.equal(produced, 0, "CLI flags cannot release the public remaining adapter");
  }
  // An incomplete retained attempt is triage, not permission to rerun.
  await fs.mkdir(attemptPath);
  const interrupted = await harness.pilotStatus(root);
  assert.equal(interrupted.current_stage, "pilot_narration"); assert.deepEqual(interrupted.allowed_command_stages, []);
  await assert.rejects(() => run("create-narration"), /stopped at/u);
  await fs.rmdir(attemptPath);
  const created = await run("create-narration");
  assert.equal(produced, 1); assert.equal(created.current_stage, "pilot_narration");
  assert.match(created.next_command_shape, /approve-narration/u);
  await absent(narrationStagePath); await absent(decisionPath); await absent(timingPath);
  await absent(path.join(root, ".pilot-stage.lock"));
  const candidateBytes = await fs.readFile(candidatePath);
  await assert.rejects(() => run("create-narration"), /current narration action/u);
  assert.equal(produced, 1);
  for (const flags of [
    { accept: "true", reviewer: "fixture", note: "Synthetic review" },
    { accept: "true", reviewer: "fixture", note: "Synthetic review", attestation: "complete_opening_listened_end_to_end" },
    { accept: "true", reviewer: "", note: "Synthetic review", attestation: PILOT_NARRATION_LISTEN_ATTESTATION },
  ]) {
    await assert.rejects(() => run("approve-narration", flags), /complete listening/u);
    await absent(narrationStagePath); await absent(decisionPath); await absent(timingPath);
  }
  forceInvalid = true;
  assert.deepEqual((await harness.pilotStatus(root)).allowed_command_stages, []);
  await assert.rejects(() => run("approve-narration", { accept: "true", reviewer: "fixture", note: "Synthetic", attestation: PILOT_NARRATION_LISTEN_ATTESTATION }), /stopped at/u);
  forceInvalid = false;
  await fs.appendFile(acceptedOpening.approval.path, "changed");
  assert.equal((await harness.pilotStatus(root)).current_stage, "pilot_voice_sample_approval");
  await assert.rejects(() => run("approve-narration", { accept: "true", reviewer: "fixture", note: "Synthetic", attestation: PILOT_NARRATION_LISTEN_ATTESTATION }), /stopped at/u);
  await fs.writeFile(acceptedOpening.approval.path, protectedBytes.get(acceptedOpening.approval.path));
  const approved = await run("approve-narration", { accept: "true", reviewer: " fixture ",
    note: " Synthetic complete listening fixture only ", attestation: PILOT_NARRATION_LISTEN_ATTESTATION });
  assert.equal(approved.current_stage, "pilot_asset_plan", JSON.stringify(approved.stages));
  assert.equal(produced, 1);
  const stageBytes = await fs.readFile(narrationStagePath), stage = JSON.parse(stageBytes);
  assert.equal(stage.stage, "pilot_narration");
  const decisionBytes = await fs.readFile(decisionPath), decision = JSON.parse(decisionBytes);
  const subjective = JSON.parse(await fs.readFile(result.finalization_artifacts.subjective_manifest.path));
  assert.equal(validateNarrationSubjectiveReviewDecision(subjective, decision).status, "approved");
  assert.equal(decision.attestation, NARRATION_SUBJECTIVE_REVIEW_ATTESTATION);
  assert.equal(stage.payload.review.reviewer, "fixture");
  assert.equal(stage.payload.review.note, "Synthetic complete listening fixture only");
  assert.equal(stage.payload.listening_attestation_mapping.canonical_attestation, NARRATION_SUBJECTIVE_REVIEW_ATTESTATION);
  assert.equal((await validatePilotNarrationAcceptance(stage.payload, { episodeDir: root, identity })).status, "passed");
  const timing = JSON.parse(await fs.readFile(timingPath));
  assert.deepEqual(timing, buildPilotNarrationTiming({ result,
    candidate: JSON.parse(await fs.readFile(result.finalization_artifacts.timing_candidate.path)),
    delivery: JSON.parse(await fs.readFile(result.finalization_artifacts.full_stream_qa.path)), identity }));
  assert(timing.words.every((word) => word.start === word.start_sec && word.end === word.end_sec));
  await assert.rejects(() => run("approve-narration", { accept: "true", reviewer: "fixture", note: "Repeat", attestation: PILOT_NARRATION_LISTEN_ATTESTATION }), /cannot be rerun/u);
  await assert.rejects(() => run("create-narration"), /cannot be rerun/u);
  await fs.appendFile(decisionPath, "changed");
  assert.equal((await harness.pilotStatus(root)).current_stage, "pilot_narration");
  assert.deepEqual((await harness.pilotStatus(root)).allowed_command_stages, []);
  await fs.writeFile(decisionPath, decisionBytes);
  assert.equal((await harness.pilotStatus(root)).current_stage, "pilot_asset_plan");
  assert.deepEqual(await fs.readFile(candidatePath), candidateBytes);
  assert.deepEqual(await fs.readFile(narrationStagePath), stageBytes);
  for (const [file, bytes] of protectedBytes) assert.deepEqual(await fs.readFile(file), bytes, `accepted opening changed: ${file}`);
  const events = (await fs.readFile(path.join(root, "execution_events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert(events.some((event) => event.action === "create-narration" && event.status === "awaiting_review"));
  assert(!events.some((event) => event.action === "create-narration" && event.status === "passed"));
  assert.equal(events.filter((event) => event.action === "approve-narration" && event.status === "passed").length, 1);
  await absent(path.join(root, ".pilot-stage.lock"));
  console.log("Avatar pilot full narration workflow tests passed (real canonical validators and exact listening/timing mapping; synthetic files only, no models or production writes).");
} finally { await fixture.cleanup(); }
