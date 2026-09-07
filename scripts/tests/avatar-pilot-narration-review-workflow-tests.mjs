import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { buildPilotNarrationWorkflowFixture } from "./avatar-pilot-narration-workflow-tests.mjs";
import { buildPilotNarrationPendingReviewFixture, buildPilotNarrationReviewedValidationFixture } from "./avatar-pilot-narration-review-validation-tests.mjs";
import { buildPilotNarrationReviewFixture } from "./avatar-pilot-narration-review-tests.mjs";
import { pilotWorkflowFixtureHarness } from "../lib/avatar-pilot-workflow.mjs";
import { validatePilotOpeningSampleResult } from "../lib/avatar-pilot-opening-validation.mjs";
import { validatePilotNarrationResult, validatePilotNarrationPendingReviewResult } from "../lib/avatar-pilot-narration-validation.mjs";
import { validatePilotNarrationAcceptance, PILOT_NARRATION_LISTEN_ATTESTATION } from "../lib/avatar-pilot-narration-acceptance.mjs";
import { PILOT_RAW_NARRATION_REVIEW_ATTESTATION } from "../lib/avatar-pilot-narration-review.mjs";

const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const absent = async (file) => assert.equal(await fs.lstat(file).then(() => false, (error) => error.code === "ENOENT"), true);
const full = await buildPilotNarrationWorkflowFixture();
const pending = await buildPilotNarrationPendingReviewFixture({ fullFixture: full });
const review = await buildPilotNarrationReviewFixture({ pendingFixture: pending });
const fixture = await buildPilotNarrationReviewedValidationFixture({ reviewFixture: review });
const { root, identity, result } = fixture;
try {
  const workRoot = path.join(root, "pilot_narration_work"), reviewDir = path.join(workRoot, "narration_review");
  const reviewedDir = path.join(workRoot, "full_finalization_reviewed");
  const resultPath = path.join(workRoot, "narration_reviewed_result.json");
  const candidatePath = path.join(workRoot, "narration_producer_result.json");
  const candidateBytes = await fs.readFile(candidatePath);
  const files = [review.priorResultRef.path, review.checkpointRef.path, review.rawAudioRef.path,
    review.priorResult.accepted_opening.sample.path, review.priorResult.accepted_opening.approval.path];
  const originals = new Map(await Promise.all(files.map(async (file) => [file, await fs.readFile(file)])));
  const stagedReview = path.join(root, "fixture-staged-review"), stagedMaster = path.join(root, "fixture-staged-master");
  await fs.rename(reviewDir, stagedReview); await fs.rename(reviewedDir, stagedMaster);
  if (await fs.lstat(resultPath).catch(() => null)) await fs.rename(resultPath, path.join(root, "fixture-staged-reviewed-result.json"));
  let reviews = 0;
  const harness = pilotWorkflowFixtureHarness({ status: "proven", validate: validatePilotOpeningSampleResult,
    async produce() { throw new Error("Opening synthesis forbidden in review fixture"); },
    full: { status: "proven", validate: validatePilotNarrationResult, validatePending: validatePilotNarrationPendingReviewResult,
      validateAcceptance: validatePilotNarrationAcceptance,
      async produce() { throw new Error("Remaining synthesis forbidden in review fixture"); },
      async review(args) {
        reviews++; assert.equal(args.episodeDir, root); assert.equal(args.attestation, PILOT_RAW_NARRATION_REVIEW_ATTESTATION);
        assert(await fs.stat(path.join(root, ".pilot-stage.lock")));
        await fs.rename(stagedReview, reviewDir); await fs.rename(stagedMaster, reviewedDir);
        await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
        return result;
      },
    } });
  const run = (action, flags = {}) => harness.executePilotCommand(action, { "episode-dir": root, ...flags });
  const before = await harness.pilotStatus(root);
  assert.equal(before.current_stage, "pilot_narration");
  assert.match(before.next_command_shape, /pilot review-narration /);
  assert.deepEqual(before.allowed_command_stages, ["pilot_narration"]);
  await assert.rejects(() => run("create-narration"), /current narration action/);
  await assert.rejects(() => run("approve-narration", { accept: "true", reviewer: "fixture", note: "Synthetic", attestation: PILOT_NARRATION_LISTEN_ATTESTATION }), /current narration action/);
  for (const flags of [{}, { accept: "true", reviewer: "fixture", note: "Synthetic", attestation: PILOT_NARRATION_LISTEN_ATTESTATION }]) {
    await assert.rejects(() => run("review-narration", flags), /raw narration listening/);
    assert.equal(reviews, 0); await absent(reviewDir); await absent(path.join(root, "pilot_narration.json"));
  }
  await fs.mkdir(reviewDir);
  const incomplete = await harness.pilotStatus(root);
  assert.deepEqual(incomplete.allowed_command_stages, []);
  await assert.rejects(() => run("review-narration"), /stopped at/);
  await fs.rmdir(reviewDir);
  const mastered = await run("review-narration", { accept: "true", reviewer: "fixture", note: "Synthetic raw listening only", attestation: PILOT_RAW_NARRATION_REVIEW_ATTESTATION });
  assert.equal(reviews, 1); assert.equal(mastered.current_stage, "pilot_narration");
  assert.match(mastered.next_command_shape, /pilot approve-narration /);
  await absent(path.join(root, "pilot_narration.json"));
  await absent(path.join(reviewedDir, "narration_subjective_review_decision_ep_01.json"));
  assert.equal((await read(review.reviewContinuation.reviewReceipt.path)).mastered_audio_listened, false);
  await assert.rejects(() => run("review-narration"), /current narration action/);
  await assert.rejects(() => run("create-narration"), /current narration action/);
  const approved = await run("approve-narration", { accept: "true", reviewer: "fixture master listener", note: "Synthetic distinct mastered listening approval", attestation: PILOT_NARRATION_LISTEN_ATTESTATION });
  assert.equal(approved.current_stage, "pilot_asset_plan", JSON.stringify(approved.stages));
  const stage = await read(path.join(root, "pilot_narration.json"));
  assert.equal(stage.payload.narration_result.path, resultPath);
  assert.equal(stage.payload.subjective_decision.path, path.join(reviewedDir, "narration_subjective_review_decision_ep_01.json"));
  assert.equal(stage.payload.whisper_timing.path, path.join(reviewedDir, "pilot_word_timing.json"));
  assert.equal((await validatePilotNarrationAcceptance(stage.payload, { episodeDir: root, identity })).status, "passed");
  assert.deepEqual(await fs.readFile(candidatePath), candidateBytes);
  for (const [file, bytes] of originals) assert.deepEqual(await fs.readFile(file), bytes, file);
  const events = (await fs.readFile(path.join(root, "execution_events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const event = events.find((row) => row.action === "review-narration" && row.status === "awaiting_review");
  assert.equal(event.creative_submissions, 0); assert.equal(event.synthesis_invoked, false);
  assert.equal(events.some((row) => row.action === "review-narration" && row.status === "passed"), false);
  await absent(path.join(root, ".pilot-stage.lock"));
  console.log("Pilot raw-review workflow tests passed (real validators, separate mastered approval, immutable prior audio; synthetic fixture only).");
} finally { await fixture.cleanup(); }
