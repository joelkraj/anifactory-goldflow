import test from "node:test";
import assert from "node:assert/strict";
import { buildFalImageInput, FAL_ENDPOINTS, FAL_PRIMARY_PARAMS } from "../lib/fal-provider.mjs";
import { falBlockedStageRecoveryAdmission } from "../lib/fal-production-state.mjs";
import { falProductionStageStates } from "../lib/fal-production-state.mjs";
import { falPortableAssetId } from "../lib/fal-portable-bank.mjs";
import { normalizeImageProvider } from "../lib/image-provider-routing.mjs";
import { buildStageCommand, commandStageFor } from "../lib/pipeline-stage-registry.mjs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("Fal text request locks low quality 1920x1080 PNG", () => {
  const request = buildFalImageInput({ prompt: "one frame" });
  assert.equal(request.endpoint, FAL_ENDPOINTS.primary_text);
  assert.deepEqual(request.input.image_size, { width: 1920, height: 1080 });
  assert.equal(request.input.quality, "low");
  assert.equal(request.input.output_format, "png");
  assert.deepEqual(request.input, { prompt: "one frame", ...structuredClone(FAL_PRIMARY_PARAMS) });
});

test("Fal edit request uses one positional board without persisting a URL", () => {
  const request = buildFalImageInput({ prompt: "one coherent shot", referenceUrls: ["https://v3.fal.media/files/board.png"] });
  assert.equal(request.endpoint, FAL_ENDPOINTS.primary_edit);
  assert.equal(request.reference_mode, "one_positional_collage");
  assert.deepEqual(request.input.image_urls, ["https://v3.fal.media/files/board.png"]);
  assert.equal(request.input.partial_images, 0);
});

test("Fal request rejects more than sixteen ordered references", () => {
  assert.throws(() => buildFalImageInput({ prompt: "x", referenceUrls: Array(17).fill("https://v3.fal.media/a.png") }), /sixteen/);
});

test("Fal blocked-stage recovery admits only the exact status action", () => {
  const status = {
    current_stage: "image_generation",
    current_stage_state: "blocked",
    next_command_shape: "node bin/goldflow.mjs imagegen fal --episode-dir /tmp/ep --action observe-holds",
  };
  assert.equal(falBlockedStageRecoveryAdmission(status, { action: "observe-holds" }).allowed, true);
  assert.equal(falBlockedStageRecoveryAdmission(status, { action: "repair-failures" }).allowed, false);
  const transportStatus = { ...status, next_command_shape: "node bin/goldflow.mjs imagegen fal --episode-dir /tmp/ep --action recover-holds --directives <file> --confirm-spend exact_fal_transport_recovery" };
  assert.equal(falBlockedStageRecoveryAdmission(transportStatus, { action: "recover-holds" }).allowed, true);
  assert.equal(falBlockedStageRecoveryAdmission({ ...status, current_stage_state: "missing" }, { action: "observe-holds" }).applicable, false);
  const referenceStatus = { ...status, current_stage: "reference_generation",
    next_command_shape: "node bin/goldflow.mjs imagegen fal --episode-dir /tmp/ep --action repair-reference-failures --directives <file> --confirm-spend exact_fal_reference_repair" };
  assert.equal(falBlockedStageRecoveryAdmission(referenceStatus, { action: "repair-reference-failures" }).allowed, true);
  assert.equal(falBlockedStageRecoveryAdmission(referenceStatus, { action: "observe-reference-repairs" }).allowed, false);
  const reviewedStatus = { ...status, current_stage: "reference_image_approval",
    next_command_shape: "node bin/goldflow.mjs imagegen fal --episode-dir /tmp/ep --action repair-reviewed-references --confirm-spend exact_fal_reviewed_reference_repair" };
  assert.equal(falBlockedStageRecoveryAdmission(reviewedStatus, { action: "repair-reviewed-references" }).allowed, true);
  assert.equal(falBlockedStageRecoveryAdmission(reviewedStatus, { action: "finalize-reviewed-references" }).allowed, false);
});

test("early Fal visual fork routes reference and scene generations through guarded Fal actions", () => {
  const identity = {
    channel: "53rebirth", series_slug: "years-taken", week: "test-fal", episode: "ep_01",
    episode_dir: "/tmp/test-fal/episodes/ep_01", image_provider: "fal_ai",
    visual_restart: { fork_at: "visual_reference_plan" },
    model_versions: { image_model: FAL_ENDPOINTS.primary_edit, reference_model: FAL_ENDPOINTS.primary_text },
    production_profile_config: { media: { image_concurrency: 10, reference_concurrency: 8 } },
  };
  assert.equal(normalizeImageProvider("fal_ai"), "fal_ai");
  assert.match(buildStageCommand("reference_generation", identity), /imagegen fal .*--action prepare-references/);
  assert.match(buildStageCommand("image_generation", identity), /imagegen fal .*--action prepare-validation/);
  assert.equal(commandStageFor("imagegen", "fal", { action: "billing-submit-reference" }, identity), "reference_generation");
  assert.equal(commandStageFor("imagegen", "fal", { action: "finalize-references" }, identity), "reference_generation");
  assert.equal(commandStageFor("imagegen", "fal", { action: "repair-reference-failures" }, identity), "reference_generation");
  assert.equal(commandStageFor("imagegen", "fal", { action: "repair-reviewed-references" }, identity), "reference_image_approval");
  assert.equal(commandStageFor("imagegen", "fal", { action: "review-validation" }, identity), "image_generation");
});

test("early Fal visual fork begins with reference preparation before validation", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-early-"));
  try {
    const state = await falProductionStageStates({ episodeDir, identity: { visual_restart: { fork_at: "visual_reference_plan" } } });
    assert.match(state.stageStates.reference_generation.next_command_shape, /--action prepare-references/);
    assert.match(state.stageStates.image_generation.next_command_shape, /--action prepare-validation/);
    assert.equal("reference_image_approval" in state.stageStates, false);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal bulk status observes work when bounded queue is full", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-queue-"));
  try {
    const root = path.join(episodeDir, "fal");
    await mkdir(root, { recursive: true });
    const assignments = Array.from({ length: 11 }, (_, index) => String(index)).map(id => ({ image_id: id,
      submission_receipt_path: path.join(root, `${id}-submission.json`),
      result_receipt_path: path.join(root, `${id}-result.json`) }));
    await writeFile(path.join(root, "bulk-plan.json"), JSON.stringify({ assignments, concurrency: 1 }));
    await writeFile(path.join(root, "validation-review.json"), JSON.stringify({ status: "passed", approved_ids: [] }));
    for (const assignment of assignments.slice(0, 10)) await writeFile(assignment.submission_receipt_path, "{}");
    const state = await falProductionStageStates({ episodeDir, identity: {} });
    assert.match(state.stageStates.image_generation.next_command_shape, /--action observe-bulk --limit 100/);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal bulk status nominates exact failure repair before more dispatch", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-failure-"));
  try {
    const root = path.join(episodeDir, "fal");
    const failureDir = path.join(root, "bulk", "failure-receipts");
    await mkdir(failureDir, { recursive: true });
    const assignments = ["one", "two"].map(id => ({ image_id: id,
      submission_receipt_path: path.join(root, `${id}-submission.json`),
      result_receipt_path: path.join(root, `${id}-result.json`) }));
    await writeFile(path.join(root, "bulk-plan.json"), JSON.stringify({ assignments, concurrency: 10 }));
    await writeFile(path.join(root, "validation-review.json"), JSON.stringify({ status: "passed", approved_ids: [] }));
    await writeFile(assignments[0].submission_receipt_path, "{}");
    await writeFile(path.join(failureDir, "one.json"), "{}");
    const state = await falProductionStageStates({ episodeDir, identity: {} });
    assert.equal(state.stageStates.image_generation.state, "blocked");
    assert.match(state.stageStates.image_generation.next_command_shape, /--action repair-failures/);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal transport hold gets a no-spend original-request recheck first", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-hold-"));
  try {
    const root = path.join(episodeDir, "fal");
    const holdDir = path.join(root, "bulk", "transport-holds");
    await mkdir(holdDir, { recursive: true });
    const assignment = { image_id: "one", submission_receipt_path: path.join(root, "one-submission.json"),
      result_receipt_path: path.join(root, "one-result.json") };
    await writeFile(path.join(root, "bulk-plan.json"), JSON.stringify({ assignments: [assignment], concurrency: 10 }));
    await writeFile(path.join(root, "validation-review.json"), JSON.stringify({ status: "passed", approved_ids: [] }));
    await writeFile(assignment.submission_receipt_path, "{}");
    await writeFile(path.join(holdDir, "one.json"), "{}");
    let state = await falProductionStageStates({ episodeDir, identity: {} });
    assert.match(state.stageStates.image_generation.next_command_shape, /--action observe-holds/);
    const recheckDir = path.join(root, "bulk", "hold-observation-receipts");
    await mkdir(recheckDir, { recursive: true });
    await writeFile(path.join(recheckDir, "one.json"), "{}");
    state = await falProductionStageStates({ episodeDir, identity: {} });
    assert.match(state.stageStates.image_generation.next_command_shape, /--action recover-holds/);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal canonical assets retain stable provider-neutral Goldflow IDs", () => {
  assert.equal(falPortableAssetId("years-taken", { ref_id: "joey_manhwa_clinic_state", kind: "character_state" }),
    "gf.years_taken.character_state.joey_manhwa_clinic_state");
  assert.throws(() => falPortableAssetId("../escape", { ref_id: "x", kind: "location" }), /Unsafe/);
});
