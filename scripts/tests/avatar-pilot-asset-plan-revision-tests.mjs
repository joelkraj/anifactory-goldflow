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
import { AVATAR_PILOT_STAGES } from "../lib/avatar-pilot-stage-registry.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const absent = async (file) => assert.equal(await fs.lstat(file).then(() => false, (error) => error.code === "ENOENT"), true);
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

/** Canonical narration/approval boundary with explicit synthetic observations.
 * No producer, provider, model, real episode, or real listening claim is used. */
async function plannedFixture() {
  const fixture = await buildPilotNarrationWorkflowFixture();
  try {
    const { root, identity, result, writeJson } = fixture;
    let submissions = 0;
    const forbidProducer = async () => { submissions++; throw new Error("No provider or media production is permitted in this fixture"); };
    const harness = pilotWorkflowFixtureHarness({ status: "proven", produce: forbidProducer, validate: validatePilotOpeningSampleResult,
      full: { status: "proven", produce: forbidProducer, review: forbidProducer,
        validate: validatePilotNarrationResult, validateAcceptance: validatePilotNarrationAcceptance } });
    const run = (action, flags = {}) => harness.executePilotCommand(action, { "episode-dir": root, ...flags });
    await writeJson(path.join(root, "pilot_narration_work", "narration_producer_result.json"), result);
    assert.match((await harness.pilotStatus(root)).next_command_shape, /approve-narration/u);
    await run("approve-narration", { accept: "true", reviewer: "fixture", note: "Synthetic complete-listening test only", attestation: PILOT_NARRATION_LISTEN_ATTESTATION });
    const still = identity.pilot_providers.stills[0], narrator = identity.pilot_providers.narration;
    const plan = { schema: "goldflow_avatar_pilot_asset_plan_v1", source_script_sha256: result.source_script_sha256,
      assets: [
        { id: "narration_main", kind: "narration", purpose: "Complete original fixture narration", provider: narrator.provider,
          model: narrator.model, truth_mode: "original_commentary" },
        { id: "analysis_room", kind: "background", purpose: "Ornate fixture analysis room", provider: still.provider,
          model: still.model, truth_mode: "original_background", art_direction: "Detailed synthetic analysis room with lamps" },
        { id: "host_neutral", kind: "host_pose", purpose: "Original fixture host pose", provider: still.provider,
          model: still.model, truth_mode: "original_host", art_direction: "Original fixture host, no borrowed character" },
      ] };
    const inputPath = path.join(root, "fixture_asset_plan_v1.json"), stagePath = path.join(root, "pilot_asset_plan.json");
    await writeJson(inputPath, plan);
    const planned = await run("plan-assets", { input: inputPath });
    assert.equal(planned.current_stage, "pilot_asset_plan_approval");
    const stageBytes = await fs.readFile(stagePath), inputBytes = await fs.readFile(inputPath);
    const v2 = structuredClone(plan);
    v2.assets[1].id = "host_room";
    v2.assets[1].purpose = "Simple blue fixture background that leaves room for evidence cards";
    v2.assets[1].art_direction = "Plain blue gradient with subtle texture; no room, furniture, screens or lamps";
    v2.art_direction = { background_style: "Simple blue gradient with subtle texture" };
    const v2Path = path.join(root, "fixture_asset_plan_v2.json"); await writeJson(v2Path, v2);
    const reviseFlags = { input: v2Path, "prior-stage-sha256": hash(stageBytes), "affected-asset-ids": "analysis_room,host_room",
      reviewer: "fixture", note: "Synthetic operator-scoped background revision only" };
    return { ...fixture, harness, run, plan, v2, inputPath, inputBytes, stagePath, stageBytes, v2Path, reviseFlags,
      revisionDir: path.join(root, "pilot_asset_plan_revision"), submissions: () => submissions };
  } catch (error) { await fixture.cleanup(); throw error; }
}

async function main() {
  const fixture = await plannedFixture();
  const { root, identity, harness, run, plan, v2, writeJson, inputPath, inputBytes, stagePath, stageBytes, v2Path, reviseFlags, revisionDir } = fixture;
  let checks = 0;
  try {
    const { resolvePilotAssetPlanStage, validatePilotAssetPlanRevision } = await import("../lib/avatar-pilot-asset-plan-revision.mjs");
    const original = await resolvePilotAssetPlanStage({ episodeDir: root, identity });
    assert.equal(original.path, stagePath); assert.deepEqual(original.row.payload, plan);
    await absent(revisionDir); checks++;
    const hyphenated = structuredClone(v2); hyphenated.assets[1].id = "host-room";
    assert.deepEqual(validatePilotAssetPlanRevision({ priorPlan: plan, nextPlan: hyphenated, identity,
      affectedAssetIds: ["analysis_room", "host-room"] }).affectedAssetIds, ["analysis_room", "host-room"]); checks++;
    async function rejectRevision(flags = reviseFlags) {
      await assert.rejects(() => run("revise-asset-plan", flags));
      assert.deepEqual(await fs.readFile(stagePath), stageBytes);
      assert.deepEqual(await fs.readFile(inputPath), inputBytes);
      await absent(revisionDir); checks++;
    }
    for (const mutate of [
      (row) => { row.assets[2].purpose = "Unauthorized host change"; },
      (row) => { row.assets[0].purpose = "Unauthorized narration change"; },
      (row) => { row.source_script_sha256 = "0".repeat(64); },
      (row) => { row.unapproved_top_level_direction = "New global direction"; },
      (row) => { row.assets[1].provider = "codex_imagegen"; },
      (row) => { row.assets[1].model = "unlocked fixture model"; },
      (row) => { row.assets.push({ ...row.assets[1], id: "unapproved_new_background" }); },
      (row) => { row.assets.reverse(); },
    ]) {
      const changed = structuredClone(v2); mutate(changed); await writeJson(v2Path, changed);
      await rejectRevision(); await writeJson(v2Path, v2);
    }
    for (const changes of [
      { "prior-stage-sha256": "0".repeat(64) }, { "affected-asset-ids": "host_neutral" },
      { "affected-asset-ids": "analysis_room" }, { "affected-asset-ids": "host_room" },
      { "affected-asset-ids": "analysis_room,host_room,host_neutral" }, { "affected-asset-ids": "analysis_room,analysis_room,host_room" },
      { "affected-asset-ids": "unknown" }, { "affected-asset-ids": "" },
      { reviewer: "" }, { note: "" }, { "workflow-bypass": "true" },
    ]) await rejectRevision({ ...reviseFlags, ...changes });
    await writeJson(v2Path, plan); await rejectRevision(); await writeJson(v2Path, v2);

    // A downstream artifact—even an invalid partial one—must bar revision.
    for (const stage of AVATAR_PILOT_STAGES.slice(8)) {
      const target = path.join(root, stage.output); await writeJson(target, { fixture_only: true, incomplete: true });
      await assert.rejects(() => run("revise-asset-plan", reviseFlags)); checks++;
      await fs.unlink(target); await absent(revisionDir);
    }
    for (const name of ["pilot_media_work", "pilot_render_work"]) {
      const target = path.join(root, name); await fs.mkdir(target);
      assert.equal((await harness.pilotStatus(root)).asset_plan_revision_command_shape, null);
      await assert.rejects(() => run("revise-asset-plan", reviseFlags)); checks++;
      await fs.rmdir(target); await absent(revisionDir);
    }
    const partialRender = path.join(root, "pilot_proof_90s.mp4"); await fs.writeFile(partialRender, "Synthetic incomplete render marker");
    assert.equal((await harness.pilotStatus(root)).asset_plan_revision_command_shape, null);
    await assert.rejects(() => run("revise-asset-plan", reviseFlags)); checks++;
    await fs.unlink(partialRender); await absent(revisionDir);
    // An interrupted revision directory is an explicit triage point, not replay.
    await fs.mkdir(revisionDir);
    await assert.rejects(() => run("revise-asset-plan", reviseFlags)); checks++;
    await fs.rmdir(revisionDir);
    assert.equal((await harness.pilotStatus(root)).current_stage, "pilot_asset_plan_approval");

    const revisionText = await run("revise-asset-plan", { ...reviseFlags, format: "markdown" });
    assert.equal(typeof revisionText, "string"); assert.match(revisionText, /pilot_asset_plan_approval/u); checks++;
    const revised = await harness.pilotStatus(root);
    assert.equal(revised.current_stage, "pilot_asset_plan_approval");
    const effectivePath = path.join(revisionDir, "pilot_asset_plan.json"), receiptPath = path.join(revisionDir, "revision.json");
    const effectiveBytes = await fs.readFile(effectivePath), receiptBytes = await fs.readFile(receiptPath);
    const receipt = JSON.parse(receiptBytes);
    assert.deepEqual(receipt.affected_asset_ids, ["analysis_room", "host_room"]);
    assert.deepEqual(receipt.changed_metadata_keys, ["art_direction"]);
    for (const field of ["asset_plan_approved", "synthesis_invoked", "generation_authorized", "production_eligible", "publish_allowed"]) assert.equal(receipt[field], false);
    assert.equal(receipt.creative_submissions, 0); assert.equal(receipt.provider_cost, 0);
    const effective = await resolvePilotAssetPlanStage({ episodeDir: root, identity });
    assert.equal(effective.path, effectivePath); assert.deepEqual(effective.row.payload, v2);
    assert.deepEqual(await fs.readFile(stagePath), stageBytes); assert.deepEqual(await fs.readFile(inputPath), inputBytes);
    assert.equal(revised.stages.find((row) => row.stage === "pilot_asset_plan").artifact, effectivePath); checks++;
    const parkedRevision = path.join(root, "fixture_parked_revision");
    await fs.rename(revisionDir, parkedRevision);
    const deletedRevision = await harness.pilotStatus(root);
    assert.deepEqual(deletedRevision.allowed_command_stages, []);
    assert.equal(deletedRevision.current_stage, "pilot_asset_plan");
    await assert.rejects(() => resolvePilotAssetPlanStage({ episodeDir: root, identity })); checks++;
    await fs.rename(parkedRevision, revisionDir);

    // Even a coherently rehashed audit/event pair cannot change the original
    // revision-only execution scope. All originals are restored between cases.
    const activationPath = path.join(revisionDir, "activation.json"), activationBytes = await fs.readFile(activationPath);
    const activation = JSON.parse(activationBytes), auditPath = activation.execution_report.path;
    const auditBytes = await fs.readFile(auditPath), originalAudit = JSON.parse(auditBytes);
    const eventsPath = path.join(root, "execution_events.jsonl"), eventBytes = await fs.readFile(eventsPath);
    for (const mutate of [
      (row) => { row.scope.affected_asset_ids = ["host_neutral"]; },
      (row) => { row.scope.phase = "unapproved_generation"; },
      (row) => { row.scope.duration_sec = 91; },
      (row) => { row.production_eligible = true; },
    ]) {
      const audit = structuredClone(originalAudit); mutate(audit);
      const changedActivation = structuredClone(activation);
      changedActivation.execution_report.sha256 = await writeJson(auditPath, audit);
      await writeJson(activationPath, changedActivation);
      const changedEvents = eventBytes.toString("utf8").trim().split("\n").map((line) => {
        const row = JSON.parse(line); return JSON.stringify(row.id === originalAudit.id ? audit : row);
      }).join("\n") + "\n";
      await fs.writeFile(eventsPath, changedEvents);
      await assert.rejects(() => resolvePilotAssetPlanStage({ episodeDir: root, identity }));
      assert.deepEqual((await harness.pilotStatus(root)).allowed_command_stages, []); checks++;
      await fs.writeFile(activationPath, activationBytes); await fs.writeFile(auditPath, auditBytes); await fs.writeFile(eventsPath, eventBytes);
    }
    await assert.rejects(() => run("revise-asset-plan", reviseFlags)); checks++;
    assert.deepEqual(await fs.readFile(effectivePath), effectiveBytes); assert.deepEqual(await fs.readFile(receiptPath), receiptBytes);
    await fs.appendFile(receiptPath, "stale fixture receipt");
    assert.deepEqual((await harness.pilotStatus(root)).allowed_command_stages, []); checks++;
    await fs.writeFile(receiptPath, receiptBytes);
    await fs.appendFile(v2Path, "changed proposed input");
    assert.deepEqual((await harness.pilotStatus(root)).allowed_command_stages, []); checks++;
    await writeJson(v2Path, v2);
    const approved = await run("approve-asset-plan", { accept: "true", reviewer: "fixture", note: "Synthetic exact revised plan approval" });
    assert.equal(approved.current_stage, "pilot_media");
    const approvalPath = path.join(root, "pilot_asset_plan_approval.json"), approval = await read(approvalPath);
    const upstream = approval.inputs.find((row) => row.role === "upstream");
    assert.deepEqual(upstream, { role: "upstream", path: effectivePath, sha256: hash(effectiveBytes) }); checks++;
    await assert.rejects(() => run("revise-asset-plan", reviseFlags)); checks++;
    const mediaPath = path.join(root, "fixture_incomplete_media.json");
    await writeJson(mediaPath, { schema: "goldflow_avatar_pilot_media_v1", source_script_sha256: v2.source_script_sha256, assets: plan.assets });
    await assert.rejects(() => run("import-media", { input: mediaPath }), /pilot_media_exact_complete_asset_scope_required/u); checks++;
    await writeJson(mediaPath, { schema: "goldflow_avatar_pilot_media_v1", source_script_sha256: v2.source_script_sha256, assets: v2.assets });
    await assert.rejects(() => run("import-media", { input: mediaPath }), (error) => {
      assert.doesNotMatch(error.message, /pilot_media_exact_complete_asset_scope_required/u);
      assert.match(error.message, /pilot_media_(?:bound_receipt_or_local_media_invalid|exact_pilot_review_required)/u);
      return true;
    }); checks++;
    await fs.appendFile(effectivePath, "changed effective V2 plan");
    await assert.rejects(() => run("import-media", { input: mediaPath }), /stopped at|stale|hash/u); checks++;
    await fs.writeFile(effectivePath, effectiveBytes);
    assert.equal((await harness.pilotStatus(root)).current_stage, "pilot_media");
    assert.deepEqual(await fs.readFile(stagePath), stageBytes); assert.deepEqual(await fs.readFile(inputPath), inputBytes);
    const events = (await fs.readFile(path.join(root, "execution_events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert(events.every((event) => event.creative_submissions === 0 && event.provider_cost === 0 && event.production_eligible === false));
    assert.equal(events.filter((event) => event.action === "revise-asset-plan" && event.status === "passed").length, 1);
    assert.equal(fixture.submissions(), 0); await absent(path.join(root, ".pilot-stage.lock"));
    console.log(`Pilot asset-plan revision tests passed (${checks} guarded cases; canonical synthetic narration, no providers or production files).`);
  } finally { await fixture.cleanup(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
