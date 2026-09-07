import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildPilotNarrationWorkflowFixture } from "./avatar-pilot-narration-workflow-tests.mjs";
import { pilotWorkflowFixtureHarness } from "../lib/avatar-pilot-workflow.mjs";
import { validatePilotOpeningSampleResult } from "../lib/avatar-pilot-opening-validation.mjs";
import { validatePilotNarrationResult } from "../lib/avatar-pilot-narration-validation.mjs";
import { validatePilotNarrationAcceptance, PILOT_NARRATION_LISTEN_ATTESTATION } from "../lib/avatar-pilot-narration-acceptance.mjs";
import { resolvePilotAssetPlanStage } from "../lib/avatar-pilot-asset-plan-revision.mjs";
import { AVATAR_PILOT_STAGES } from "../lib/avatar-pilot-stage-registry.mjs";
import { validatePilotGeneratedAttempt } from "../lib/avatar-pilot-artifacts.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const ref = async (file) => ({ path: file, sha256: hash(await fs.readFile(file)) });
const absent = async (file) => assert.equal(await fs.lstat(file).then(() => false, (error) => error.code === "ENOENT"), true);
const HOST_IDS = ["host_neutral", "host_open_palm", "host_presenting", "host_thinking", "host_skeptical", "host_confident"];

/** All assets, permissions and listening observations below are synthetic test
 * inputs. No external provider, model, real media or production run is used. */
async function approvedFixture() {
  const fixture = await buildPilotNarrationWorkflowFixture();
  try {
    const { root, identity, result, writeJson } = fixture;
    let submissions = 0;
    const forbidProducer = async () => { submissions++; throw new Error("Provider/model execution forbidden in host revision fixture"); };
    const harness = pilotWorkflowFixtureHarness({ status: "proven", produce: forbidProducer, validate: validatePilotOpeningSampleResult,
      full: { status: "proven", produce: forbidProducer, review: forbidProducer,
        validate: validatePilotNarrationResult, validateAcceptance: validatePilotNarrationAcceptance } });
    const run = (action, flags = {}) => harness.executePilotCommand(action, { "episode-dir": root, ...flags });
    await writeJson(path.join(root, "pilot_narration_work", "narration_producer_result.json"), result);
    await run("approve-narration", { accept: "true", reviewer: "fixture", note: "Synthetic complete-listening fixture only",
      attestation: PILOT_NARRATION_LISTEN_ATTESTATION });
    const still = identity.pilot_providers.stills[0], narrator = identity.pilot_providers.narration;
    const clipPaths = [path.join(root, "synthetic_film_sentry.dat"), path.join(root, "synthetic_film_void.dat")];
    await fs.writeFile(clipPaths[0], "Synthetic preservation sentinel, not playable film footage");
    await fs.writeFile(clipPaths[1], "Second synthetic preservation sentinel, not playable film footage");
    const plan = { schema: "goldflow_avatar_pilot_asset_plan_v1", source_script_sha256: result.source_script_sha256,
      art_direction: { host: "Original uncovered synthetic host identity", host_delivery: "Synthetic eyebrows and mouth expressions",
        background_style: "Original desk and PC room plus native plain cards" },
      generation_order: ["host_neutral", ...HOST_IDS.slice(1), "host_room", "concept_intercept", "concept_rescue", "concept_void_doorway"],
      assets: [
        { id: "narration_joel", kind: "narration", purpose: "Preserve complete accepted synthetic narration", provider: narrator.provider,
          model: narrator.model, truth_mode: "original_commentary" },
        ...await Promise.all(["film_sentry_window", "film_void_shadow"].map(async (id, index) => ({ id, kind: "movie_clip",
          purpose: "Synthetic existing five-second evidence preservation sentinel", provider: "local", model: "source_native",
          truth_mode: "film_evidence", source: await ref(clipPaths[index]), duration_sec: 5 }))),
        ...HOST_IDS.map((id) => ({ id, kind: "host_pose", purpose: `Uncovered original synthetic ${id} expression`,
          provider: still.provider, model: still.model, truth_mode: "original_host",
          reference_asset_ids: id === "host_neutral" ? [] : ["host_neutral"] })),
        { id: "analysis_room", kind: "background", purpose: "Original synthetic desk and PC room", provider: still.provider,
          model: still.model, truth_mode: "original_background" },
        ...["concept_intercept", "concept_rescue", "concept_void_doorway"].map((id) => ({ id, kind: "concept_still",
          purpose: `Synthetic hypothetical ${id}`, provider: still.provider, model: still.model, truth_mode: "hypothetical_concept" })),
      ] };
    const inputPath = path.join(root, "fixture_asset_plan_v1.json"); await writeJson(inputPath, plan);
    await run("plan-assets", { input: inputPath });
    // Exercise a post-approval revision on top of the already-used, independent
    // pre-approval revision, matching the two immutable revision namespaces.
    const v2 = structuredClone(plan); v2.assets.find((asset) => asset.id === "analysis_room").id = "host_room";
    const v2Path = path.join(root, "fixture_asset_plan_v2.json"); await writeJson(v2Path, v2);
    await run("revise-asset-plan", { input: v2Path, "prior-stage-sha256": (await ref(path.join(root, "pilot_asset_plan.json"))).sha256,
      "affected-asset-ids": "analysis_room,host_room", reviewer: "fixture", note: "Synthetic original room plan revision only" });
    await run("approve-asset-plan", { accept: "true", reviewer: "fixture", note: "Synthetic exact thirteen-asset approval only" });
    assert.equal((await harness.pilotStatus(root)).current_stage, "pilot_media");
    const effective = await resolvePilotAssetPlanStage({ episodeDir: root, identity });
    const priorPlan = await ref(effective.path), priorApproval = await ref(path.join(root, "pilot_asset_plan_approval.json"));
    const inspirationPath = path.join(root, "fixture_external_inspiration.png");
    // A real PNG codec fixture is unnecessary here: this layer tests exact
    // local reference bindings, not visual quality or provider authenticity.
    await fs.writeFile(inspirationPath, Buffer.from("89504e470d0a1a0a", "hex"));
    const inspiration = { id: "mask_inspiration", ...await ref(inspirationPath), role: "external_inspiration" };
    const nextPlan = structuredClone(v2);
    nextPlan.art_direction.host = "Original fully masked synthetic host; no visible skin at face, ears, neck, hands or wrists";
    nextPlan.art_direction.host_delivery = "Animated white eye shapes and graphic grin on the opaque mask, with expressive pose changes";
    nextPlan.art_direction.host_external_inspiration_bindings = [inspiration];
    for (const row of nextPlan.assets.filter((asset) => asset.kind === "host_pose")) row.purpose = `Original fully masked ${row.id} expression`;
    const nextPath = path.join(root, "fixture_masked_asset_plan.json"); await writeJson(nextPath, nextPlan);
    const promptPath = path.join(root, "fixture_masked_host_prompt.txt");
    await fs.writeFile(promptPath, "Synthetic prompt: one original fully masked host with no skin visible; mask expressions, neutral first.\n");
    const protectedPaths = [path.join(root, "run_identity.json"), path.join(root, "pilot_narration.json"),
      path.join(root, "pilot_evidence.json"), path.join(root, "pilot_asset_plan.json"), inputPath, v2Path,
      effective.path, priorApproval.path, ...clipPaths,
      ...Object.values(result.finalization_artifacts).map((item) => item?.path).filter(Boolean)];
    return { ...fixture, harness, run, plan: v2, nextPlan, nextPath, promptPath, inspiration, inspirationPath,
      priorPlan, priorApproval, protectedPaths, submissions: () => submissions };
  } catch (error) { await fixture.cleanup(); throw error; }
}

async function main() {
  const fixture = await approvedFixture();
  try {
    const writeRef = async (file, value) => { await fixture.writeJson(file, value); return ref(file); };
    const attemptDir = path.join(fixture.root, "pilot_media_work", "host_neutral"); await fs.mkdir(attemptDir, { recursive: true });
    const outputPath = path.join(attemptDir, "first-candidate.jpeg"); await fs.writeFile(outputPath, "synthetic rejected host candidate");
    const output = await ref(outputPath);
    const request = await writeRef(path.join(attemptDir, "generation_request.json"), {
      asset_id: "host_neutral", creative_submission_limit: 1 });
    const submission = await writeRef(path.join(attemptDir, "submission_observation.json"), {
      asset_id: "host_neutral", creative_submission_count: 1 });
    const result = await writeRef(path.join(attemptDir, "generation_result.json"), {
      asset_id: "host_neutral", creative_submission_count: 1, native_output: { sha256: output.sha256 } });
    const operatorReview = await writeRef(path.join(attemptDir, "operator_review.json"), {
      asset_id: "host_neutral", prior_candidate_accepted: false, reviewed_output: { sha256: output.sha256 } });
    const revisionRequest = { schema: "goldflow_avatar_pilot_host_design_revision_request_v1",
      identity_sha256: (await ref(path.join(fixture.root, "run_identity.json"))).sha256,
      prior_plan: fixture.priorPlan, prior_approval: fixture.priorApproval,
      prior_attempt: { request, submission, result, operator_review: operatorReview, output },
      new_plan: await ref(fixture.nextPath), replacement_prompt: await ref(fixture.promptPath),
      external_inspiration_bindings: [fixture.inspiration] };
    const revisionPath = path.join(fixture.root, "fixture_host_design_revision.json");
    await fixture.writeJson(revisionPath, revisionRequest);
    const protectedBefore = new Map();
    for (const file of [...fixture.protectedPaths, outputPath, request.path, submission.path, result.path, operatorReview.path])
      protectedBefore.set(file, (await ref(file)).sha256);

    const status = await fixture.run("revise-host-design", { input: revisionPath, accept: "true", reviewer: "fixture",
      note: "Synthetic operator-approved masked host replacement only" });
    assert.equal(status.current_stage, "pilot_media", JSON.stringify(status.stages));
    assert.equal(fixture.submissions(), 0);
    const resolved = await import("../lib/avatar-pilot-host-design-revision.mjs").then(({ resolvePilotHostDesignRevision }) =>
      resolvePilotHostDesignRevision({ episodeDir: fixture.root, identity: fixture.identity }));
    assert.equal(resolved.plan.row.payload.art_direction.host, fixture.nextPlan.art_direction.host);
    assert.equal(resolved.approval.row.payload.review.approved, true);
    const authorization = await read(resolved.authorization.path);
    assert.equal(authorization.replacement_attempt_number, 2);
    assert.equal(authorization.creative_submissions_authorized, 1);
    assert.equal(authorization.lifetime_creative_submission_limit, 2);
    assert.equal(authorization.dependent_pose_generation_authorized, false);
    const plannedNeutral = resolved.plan.row.payload.assets.find((row) => row.id === "host_neutral");
    const neutralRow = { ...plannedNeutral, sha256: "a".repeat(64) };
    const neutralProof = { creative_submission_count: 2, attempt_number: 2, creative_submissions_this_attempt: 1,
      replacement_authority: resolved.authorization, prompt_sha256: resolved.request.replacement_prompt.sha256,
      external_inspiration_bindings: resolved.request.external_inspiration_bindings, reference_bindings: [] };
    assert.equal(validatePilotGeneratedAttempt(neutralProof, { row: neutralRow, planned: plannedNeutral, hostRevision: resolved }).status, "passed");
    for (const mutate of [
      (p) => { p.creative_submission_count = 1; },
      (p) => { p.attempt_number = 3; },
      (p) => { p.prompt_sha256 = "b".repeat(64); },
      (p) => { p.external_inspiration_bindings = []; },
      (p) => { p.replacement_authority = { ...p.replacement_authority, sha256: "b".repeat(64) }; },
    ]) {
      const invalid = structuredClone(neutralProof); mutate(invalid);
      assert.equal(validatePilotGeneratedAttempt(invalid, { row: neutralRow, planned: plannedNeutral, hostRevision: resolved }).status, "blocked");
    }
    const plannedPose = resolved.plan.row.payload.assets.find((row) => row.id === "host_open_palm");
    const poseProof = { creative_submission_count: 1, attempt_number: 1, creative_submissions_this_attempt: 1,
      host_design_authority: resolved.authorization, prompt_sha256: "c".repeat(64),
      reference_bindings: [{ id: "host_neutral", path: "/synthetic", sha256: neutralRow.sha256 }] };
    assert.equal(validatePilotGeneratedAttempt(poseProof, { row: { ...plannedPose, sha256: "d".repeat(64) },
      planned: plannedPose, hostRevision: resolved }).status, "passed");
    const selfAuthorized = { ...poseProof, replacement_authority: resolved.authorization };
    assert.equal(validatePilotGeneratedAttempt(selfAuthorized, { row: { ...plannedPose, sha256: "d".repeat(64) },
      planned: plannedPose, hostRevision: resolved }).status, "blocked");
    for (const [file, sha] of protectedBefore) assert.equal((await ref(file)).sha256, sha, `mutated protected input: ${file}`);
    await assert.rejects(() => fixture.run("revise-host-design", { input: revisionPath, accept: "true", reviewer: "fixture", note: "repeat" }),
      /stopped at pilot_media|revision/i);

    // The pure delta guard prevents provider/model, non-host, reference and
    // broad metadata drift without invoking a provider.
    const { validatePilotHostDesignDelta } = await import("../lib/avatar-pilot-host-design-revision.mjs");
    for (const mutate of [
      (p) => { p.assets.find((row) => row.id === "host_neutral").provider = "other"; },
      (p) => { p.assets.find((row) => row.id === "film_sentry_window").purpose = "changed"; },
      (p) => { p.assets.find((row) => row.id === "host_open_palm").reference_asset_ids = ["other"]; },
      (p) => { p.generation_order = ["changed"]; },
    ]) {
      const invalid = structuredClone(fixture.nextPlan); mutate(invalid);
      assert.throws(() => validatePilotHostDesignDelta({ priorPlan: fixture.plan, nextPlan: invalid,
        identity: fixture.identity, externalInspirationBindings: [fixture.inspiration] }), /Host-design revision blocked/);
    }

    // An audited namespace can never disappear into fallback behavior.
    const activationPath = path.join(fixture.root, "pilot_host_design_revision", "activation.json");
    const activationBytes = await fs.readFile(activationPath); await fs.rename(activationPath, `${activationPath}.held`);
    const broken = await fixture.harness.pilotStatus(fixture.root);
    assert.equal(broken.current_stage, "pilot_asset_plan");
    assert.equal(broken.stages.find((row) => row.stage === "pilot_asset_plan").state, "blocked");
    await fs.rename(`${activationPath}.held`, activationPath); assert.equal((await fs.readFile(activationPath)).compare(activationBytes), 0);
  } finally { await fixture.cleanup(); }
  console.log("Avatar pilot host-design revision tests passed (synthetic files; zero providers or real media)." );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
