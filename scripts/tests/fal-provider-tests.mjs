import test from "node:test";
import assert from "node:assert/strict";
import { buildFalImageInput, FAL_ENDPOINTS, FAL_PRIMARY_PARAMS, falSubmissionAttemptPath, submitFalImage } from "../lib/fal-provider.mjs";
import { falBlockedStageRecoveryAdmission } from "../lib/fal-production-state.mjs";
import { falProductionStageStates } from "../lib/fal-production-state.mjs";
import { falPortableAssetId } from "../lib/fal-portable-bank.mjs";
import { validateFalContract } from "../lib/fal-visual-restart.mjs";
import { referenceBoardLayout, referenceBoardPromptGuidance } from "../lib/openart-reference-board.mjs";
import { normalizeImageProvider } from "../lib/image-provider-routing.mjs";
import { buildStageCommand, commandStageFor } from "../lib/pipeline-stage-registry.mjs";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

test("Fal contract accepts the upgraded 20-request tier while preserving prior 10-request identities", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-concurrency-"));
  try {
    const bank = path.join(tempDir, "bank.json");
    const discovery = path.join(tempDir, "discovery.json");
    const bytes = "{}\n";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(bank, bytes);
    await writeFile(discovery, bytes);
    const contract = {
      schema: "goldflow_fal_image_contract_v1",
      endpoints: structuredClone(FAL_ENDPOINTS),
      primary_params: structuredClone(FAL_PRIMARY_PARAMS),
      normal_reference_mode: "one_positional_collage",
      maximum_references: 16,
      automatic_creative_retry: false,
      automatic_failover: false,
      validation_concurrency: 8,
      production_concurrency: 20,
      warning_budget_usd: 30,
      hard_budget_usd: 35,
      reference_bank_manifest: bank,
      reference_bank_manifest_sha256: sha256,
      discovery_receipt: discovery,
      discovery_receipt_sha256: sha256,
    };
    assert.equal(await validateFalContract(contract), contract);
    const priorTier = await validateFalContract({ ...contract, production_concurrency: 10 });
    assert.equal(priorTier.production_concurrency, 10);
    await assert.rejects(validateFalContract({ ...contract, production_concurrency: 21 }), /between 1 and 20/);
    await assert.rejects(validateFalContract({ ...contract, production_concurrency: 0 }), /between 1 and 20/);
    await assert.rejects(validateFalContract({ ...contract, validation_concurrency: 9 }), /validation concurrency must remain 8/);
  } finally { await rm(tempDir, { recursive: true, force: true }); }
});

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

test("Fal character-state panels retain human identities in collage guidance", () => {
  const refs = ["joey", "evan", "claire"].map(asset_id => ({ asset_id, asset_class: "character_state", sha256: "a".repeat(64) }));
  const layout = referenceBoardLayout(refs);
  assert.equal(layout.panels.every(panel => panel.role.includes("character")), true);
  const guidance = referenceBoardPromptGuidance({ panels: layout.panels.map(panel => ({ ...panel, placement: panel })) });
  assert.match(guidance, /primary character's identity/);
  assert.doesNotMatch(guidance, /crucial prop/);
});

test("Fal request rejects more than sixteen ordered references", () => {
  assert.throws(() => buildFalImageInput({ prompt: "x", referenceUrls: Array(17).fill("https://v3.fal.media/a.png") }), /sixteen/);
});

test("Fal paid image submission uses exactly one queue POST and a durable attempt", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-single-post-"));
  try {
    const receiptPath = path.join(episodeDir, "fal", "bulk", "submission-receipts", "shot.json");
    const prompt = "A restrained scene with two visible characters.";
    const assignment = { image_id: "shot", assignment_sha256: "a".repeat(64),
      run_identity_sha256: "b".repeat(64), prompt, prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
      endpoint: FAL_ENDPOINTS.primary_text, reference_mode: "text_only", reference_hashes: [], max_cost_usd: 0.05 };
    let calls = 0;
    const fetchImpl = async (url, options) => {
      calls++;
      assert.equal(url, `https://queue.fal.run/${FAL_ENDPOINTS.primary_text}`);
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Key test:key");
      assert.deepEqual(JSON.parse(options.body), buildFalImageInput({ prompt }).input);
      return { ok: true, json: async () => ({ request_id: "request-1" }) };
    };
    const result = await submitFalImage({ assignment, receiptPath, fetchImpl, credentials: "test:key" });
    assert.equal(calls, 1);
    assert.equal(result.requestId, "request-1");
    assert.equal(JSON.parse(await readFile(receiptPath, "utf8")).request_id, "request-1");
    assert.equal(JSON.parse(await readFile(falSubmissionAttemptPath(receiptPath), "utf8")).possible_paid_request, true);
    await assert.rejects(submitFalImage({ assignment, receiptPath, fetchImpl, credentials: "test:key" }), /Refusing to overwrite/);
    assert.equal(calls, 1);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal ambiguous queue outcome stays held and cannot silently resubmit", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-ambiguous-post-"));
  try {
    const receiptPath = path.join(episodeDir, "fal", "bulk", "submission-receipts", "shot.json");
    const prompt = "A solitary industrial mill at dusk.";
    const assignment = { image_id: "shot", assignment_sha256: "a".repeat(64),
      run_identity_sha256: "b".repeat(64), prompt, prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
      endpoint: FAL_ENDPOINTS.primary_text, reference_mode: "text_only", reference_hashes: [], max_cost_usd: 0.05 };
    let calls = 0;
    const fetchImpl = async () => { calls++; throw new TypeError("fetch failed"); };
    await assert.rejects(submitFalImage({ assignment, receiptPath, fetchImpl, credentials: "test:key" }), /fetch failed/);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(falSubmissionAttemptPath(receiptPath), "utf8")).image_id, "shot");
    await assert.rejects(submitFalImage({ assignment, receiptPath, fetchImpl, credentials: "test:key" }), /Refusing to overwrite/);
    assert.equal(calls, 1);
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
});

test("Fal queue 503 does not trigger an SDK-style POST retry", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-no-503-retry-"));
  try {
    const receiptPath = path.join(episodeDir, "fal", "submission-receipts", "shot.json");
    const prompt = "A quiet machine room with the power cut.";
    const assignment = { image_id: "shot", assignment_sha256: "a".repeat(64),
      run_identity_sha256: "b".repeat(64), prompt, prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
      endpoint: FAL_ENDPOINTS.primary_text, reference_mode: "text_only", reference_hashes: [], max_cost_usd: 1 };
    let calls = 0;
    await assert.rejects(submitFalImage({ assignment, receiptPath, credentials: "test:key",
      fetchImpl: async () => { calls++; return { ok: false, status: 503 }; } }), /HTTP 503.*held/);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(falSubmissionAttemptPath(receiptPath), "utf8")).image_id, "shot");
  } finally { await rm(episodeDir, { recursive: true, force: true }); }
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
  const bulkQaStatus = { ...status, current_stage: "image_output_qa",
    next_command_shape: "node bin/goldflow.mjs imagegen fal --episode-dir /tmp/ep --action repair-reviewed-bulk --directives <file> --confirm-spend exact_fal_reviewed_bulk_repair" };
  assert.equal(falBlockedStageRecoveryAdmission(bulkQaStatus, { action: "repair-reviewed-bulk" }).allowed, true);
  assert.equal(falBlockedStageRecoveryAdmission(bulkQaStatus, { action: "finalize-reviewed-bulk" }).allowed, false);
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
  assert.equal(commandStageFor("imagegen", "fal", { action: "repair-reviewed-bulk" }, identity), "image_output_qa");
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

test("reviewed validation correction supersedes the original probe without overwriting it", async () => {
  const episodeDir = await mkdtemp(path.join(os.tmpdir(), "goldflow-fal-validation-revision-"));
  try {
    const root = path.join(episodeDir, "fal"); await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "validation-plan.json"), JSON.stringify({ assignments: [] }));
    await writeFile(path.join(root, "validation-revision-request.json"), "{}");
    let state = await falProductionStageStates({ episodeDir, identity: { visual_restart: { fork_at: "visual_reference_plan" } } });
    assert.match(state.stageStates.image_generation.next_command_shape, /--action prepare-validation-revision/);
    await writeFile(path.join(root, "validation-plan-v2.json"), JSON.stringify({ assignments: [{ image_id: "new-probe", submission_receipt_path: path.join(root,"new-submission.json"), result_receipt_path: path.join(root,"new-result.json") }] }));
    state = await falProductionStageStates({ episodeDir, identity: { visual_restart: { fork_at: "visual_reference_plan" } } });
    assert.match(state.stageStates.image_generation.next_command_shape, /--action billing-submit/);
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
