import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { codexWorkSourceRowSha256, sha256 } from "../lib/codex-image-work-contract.mjs";
import { reviewedOrphanPromptRepairEvidence } from "../lib/reviewed-orphan-prompt-repair.mjs";

async function fixture(t) {
  const ep = await fs.mkdtemp(path.join(os.tmpdir(), "reviewed-orphan-patch-test-"));
  t.after(() => fs.rm(ep, { recursive: true, force: true }));
  const id = "cut-1", episode = "ep_01", root = path.join(ep, "reports", "repair");
  async function put(file, value, raw = false) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const bytes = raw ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
    await fs.writeFile(file, bytes); return { path: file, sha256: sha256(bytes) };
  }
  const source = await put(path.join(ep, "script_clean.md"), "Source words stay unchanged.", true);
  const tuple = { channel: "test", series_slug: "fixture", week: "test-run", episode };
  const identity = await put(path.join(ep, "run_identity.json"), { ...tuple, source_sha256: source.sha256 });
  const approvalValue = { ...tuple, operator_approved: true, script_clean_hash: source.sha256 };
  const approval = await put(path.join(ep, "operator_script_approval.json"), approvalValue);
  const lock = await put(path.join(ep, "script_lock.json"), approvalValue);
  const reference = await put(path.join(ep, "reference.png"), "Reference bytes: hash fixture, not generated media.", true);
  const original = {
    image_id: id, image_generation_required: true, scene_id: "scene-1", start_sec: 0, duration_sec: 2,
    visual_beat_script_excerpt: "Source words stay unchanged.",
    provider_prompt: "Original reviewed hand geometry.", image_prompt: "Original reviewed hand geometry.",
    modelslab_image_prompt: "", prompt_hash: sha256("Original reviewed hand geometry."),
    reference_slots: [{ ref_id: "ref-1", path: reference.path }],
    shot_manifest: { anatomy_contracts: [{ body_invariant: "Right hand only." }],
      equipment_contracts: [{ hand_assignment: "Right hand." }],
      character_staging: [{ pose: "Raised hand.", screen_position: "center" }], motion_intent: null },
    spatial_continuity: { object_geography: "Raised upper right." }, narrative_overlays: [{ text: "UNCHANGED" }],
  };
  const other = { image_id: "accepted-2", provider_prompt: "Already reviewed other cut.", start_sec: 2, duration_sec: 2 };
  const beforeRawValue = { ...tuple, status: "passed", source_script_hash: source.sha256, prompts: [original, other] };
  const beforeHardValue = structuredClone(beforeRawValue);
  beforeHardValue.prompts[0].modelslab_image_prompt = original.provider_prompt;
  const before_raw = await put(path.join(root, "before-raw.json"), beforeRawValue);
  const before_hardened = await put(path.join(root, "before-hardened.json"), beforeHardValue);
  const currentRawValue = structuredClone(beforeRawValue), currentHardValue = structuredClone(beforeHardValue);
  const rawPath = path.join(ep, "section_image_prompts.json"), hardPath = path.join(ep, "section_image_prompts_hardened.json");
  const corrected = "Explicit reviewed right shoulder, forearm and palm geometry.";
  const changes = [["/provider_prompt", corrected], ["/image_prompt", corrected], ["/prompt_hash", sha256(corrected)],
    ["/shot_manifest/anatomy_contracts/0/body_invariant", "Right shoulder connects to right palm."],
    ["/shot_manifest/equipment_contracts/0/hand_assignment", "Right palm thumb viewer-right."],
    ["/shot_manifest/character_staging/0/pose", "Right forearm crosses chest."],
    ["/shot_manifest/character_staging/0/screen_position", "center with arm across chest"],
    ["/spatial_continuity/object_geography", "Right arm from viewer-left shoulder to upper-right glove."]];
  const patches = changes.map(([field_path, after]) => {
    const keys = field_path.slice(1).split("/"), key = keys.pop();
    const parent = keys.reduce((v, k) => v[k], currentRawValue.prompts[0]), before = parent[key];
    parent[key] = after; keys.reduce((v, k) => v[k], currentHardValue.prompts[0])[key] = after;
    return { op: "replace", artifact_path: rawPath, selector: { array: "prompts", image_id: id }, field_path,
      before, after, before_sha256: sha256(JSON.stringify(before)), after_sha256: sha256(JSON.stringify(after)) };
  });
  currentHardValue.prompts[0].modelslab_image_prompt = corrected;
  const current_raw = await put(rawPath, currentRawValue), current_hardened = await put(hardPath, currentHardValue);
  const proposal = await put(path.join(root, "proposal.json"), { exact_image_ids: [id], patches });
  const applicationValue = { schema: "goldflow_reviewed_manual_scene_prompt_repair_v1", status: "applied",
    exact_image_ids: [id], source_script_hash: source.sha256, run_identity_sha256: identity.sha256,
    input_sha256: before_raw.sha256, output_sha256: current_raw.sha256, proposal_path: proposal.path,
    proposal_sha256: proposal.sha256, snapshots: [
      { path: rawPath, snapshot_path: before_raw.path, sha256: before_raw.sha256 },
      { path: hardPath, snapshot_path: before_hardened.path, sha256: before_hardened.sha256 },
    ] };
  const application = await put(path.join(root, "application.json"), applicationValue);
  const staging = path.join(ep, "assets/images/codex_worker_staging"), manifestDir = path.join(staging, "old-manifest");
  const item = { asset_id: id, source_row_sha256: codexWorkSourceRowSha256(beforeHardValue.prompts[0]) };
  const manifestValue = { schema: "goldflow_codex_image_work_manifest_v1", manifest_id: "old-manifest", mode: "scene",
    provider: "federated_google_web_image_pool", episode_dir: ep, sources: { run_identity: identity,
      prompt_plan: { path: hardPath, sha256: before_hardened.sha256 } }, items: [item] };
  const manifest = await put(path.join(manifestDir, "work_manifest.json"), manifestValue);
  const assignment = await put(path.join(manifestDir, "attempts", id, "attempt-001-token", "assignment.json"), {
    manifest_id: "old-manifest", asset_id: id, attempt_number: 1, item: { ...item, prompt_sha256: sha256("compiled original"),
      ordered_references: [{ ref_id: "ref-1", ...reference }] },
  });
  const deadletter = await put(path.join(manifestDir, "deadletters", id + ".json"), { manifest_id: "old-manifest", asset_id: id,
    status: "deadlettered", reason: "lease_expired_max_attempts", attempt_count: 1, max_attempts: 1,
    creative_contract: { source_row_sha256: item.source_row_sha256, prompt_sha256: sha256("compiled original") } });
  const rejected_raster = await put(path.join(root, "rejected-download.img"), "Rejected raster bytes for hash-only fixture.", true);
  const preserved = await put(path.join(root, "rejected.png"), await fs.readFile(rejected_raster.path), true);
  const reviewValue = { schema: "goldflow_manual_failed_image_candidate_review_v1", status: "rejected_material_visual_defect",
    actual_raster_reviewed: true, episode_dir: ep, manifest_id: "old-manifest", image_id: id,
    source_row_sha256: item.source_row_sha256, assigned_prompt_sha256: sha256("compiled original"),
    assigned_plan_sha256: before_hardened.sha256, candidate: { accepted_into_canonical_episode: false,
      original_download_path: rejected_raster.path, preserved_png_path: preserved.path, sha256: rejected_raster.sha256 },
    blocker: { severity: "blocker", actual_observation: "Fixture reviewer rejected the wrong hand after actual review." },
    lifecycle: { creative_submission_count: 1, actual_submission: { status: "submitted", job_id: "image:old-manifest:" + id } },
    sources: [assignment, deadletter, rejected_raster] };
  const rejected_candidate_review = await put(path.join(root, "review.json"), reviewValue);
  const aggregatePath = path.join(ep, "imagegen_report_ep_01.json"); await put(aggregatePath, { results: [] });
  const receipt = { schema: "goldflow_reviewed_orphan_prompt_patch_v1", status: "approved", image_id: id, episode_dir: ep,
    reviewed_by: "fixture-reviewer", reviewed_at: "2026-09-13T00:00:00Z", reason: "Reviewed exact anatomy correction after rejected orphan output.",
    source_script_sha256: source.sha256, identity, approval, lock, current_raw, current_hardened, manifest, assignment, deadletter,
    rejected_raster, rejected_candidate_review, before_raw, before_hardened, application, proposal,
    current_source_row_sha256: codexWorkSourceRowSha256(currentHardValue.prompts[0]) };
  const receiptPath = path.join(root, "receipt.json"), indexPath = path.join(ep, "reviewed_orphan_prompt_repairs_ep_01.json");
  async function saveReceipt() {
    const record = await put(receiptPath, receipt);
    await put(indexPath, { schema: "goldflow_reviewed_orphan_prompt_repair_index_v1", status: "approved",
      entries: [{ image_id: id, receipt_path: record.path, receipt_sha256: record.sha256 }] });
  }
  await saveReceipt();
  const run = requestedIds => reviewedOrphanPromptRepairEvidence({ episodeDir: ep, episode, currentRows: currentHardValue.prompts,
    requestedIds: requestedIds ?? new Set([id]) });
  return { ep, id, root, staging, manifestDir, indexPath, receiptPath, receipt, run, put, saveReceipt,
    currentRawValue, currentHardValue, applicationValue, reviewValue, aggregatePath, reference, patches };
}

test("absent opt-in keeps ordinary evidence behavior unchanged", async t => {
  const f = await fixture(t); await fs.unlink(f.indexPath); assert.equal((await f.run()).size, 0);
});
test("exact rejected orphan plus eight reviewed leaves is read-only and accepted", async t => {
  const f = await fixture(t), before = await fs.readFile(f.receipt.current_hardened.path);
  const result = await f.run(); assert.deepEqual([...result.keys()], [f.id]);
  assert(result.get(f.id).records.some(row => row.path === f.receipt.deadletter.path));
  assert(!result.get(f.id).records.some(row => [f.indexPath, f.aggregatePath].includes(row.path)), "mutable admission surfaces are not retained provider inputs");
  assert.deepEqual(await fs.readFile(f.receipt.current_hardened.path), before);
});
test("unknown requested IDs gain no authority", async t => {
  const f = await fixture(t); assert.equal((await f.run(new Set(["unknown"]))).size, 0);
});
test("each exact source, plan, raster, reference and proposal binding rejects changed bytes", async t => {
  for (const key of ["identity", "approval", "lock", "current_raw", "current_hardened", "before_raw", "before_hardened",
    "manifest", "assignment", "deadletter", "rejected_raster", "rejected_candidate_review", "application", "proposal", "reference"]) {
    const f = await fixture(t), record = key === "reference" ? f.reference : f.receipt[key];
    await fs.appendFile(record.path, " "); await assert.rejects(f.run(), /stale_evidence/);
  }
});
test("rehashing unrelated changes cannot pass reviewed application replay", async t => {
  const f = await fixture(t); f.currentRawValue.prompts[1].provider_prompt = "Unreviewed rewrite.";
  f.receipt.current_raw = await f.put(f.receipt.current_raw.path, f.currentRawValue);
  f.applicationValue.output_sha256 = f.receipt.current_raw.sha256;
  f.receipt.application = await f.put(f.receipt.application.path, f.applicationValue); await f.saveReceipt();
  await assert.rejects(f.run(), /out_of_scope_plan_change/);
});
test("reviewed geometry receipt cannot change narration, timing or overlay fields", async t => {
  const f = await fixture(t), proposal = JSON.parse(await fs.readFile(f.receipt.proposal.path));
  const before = "Source words stay unchanged.", after = "Rewritten narration.";
  proposal.patches.push({ op: "replace", artifact_path: f.receipt.current_raw.path, selector: { array: "prompts", image_id: f.id },
    field_path: "/visual_beat_script_excerpt", before, after, before_sha256: sha256(JSON.stringify(before)), after_sha256: sha256(JSON.stringify(after)) });
  f.receipt.proposal = await f.put(f.receipt.proposal.path, proposal); f.applicationValue.proposal_sha256 = f.receipt.proposal.sha256;
  f.receipt.application = await f.put(f.receipt.application.path, f.applicationValue); await f.saveReceipt();
  await assert.rejects(f.run(), /invalid_reviewed_leaf_patch/);
});
test("actual rejection cannot be replaced by an unreviewed or accepted download", async t => {
  const f = await fixture(t); f.reviewValue.actual_raster_reviewed = false;
  f.receipt.rejected_candidate_review = await f.put(f.receipt.rejected_candidate_review.path, f.reviewValue); await f.saveReceipt();
  await assert.rejects(f.run(), /missing_actual_rejected_orphan_evidence/);
});
test("materialized output retires this nonmaterialized repair receipt", async t => {
  const f = await fixture(t); await f.put(f.aggregatePath, { results: [{ image_id: f.id, image_path: f.receipt.rejected_raster.path }] });
  await assert.rejects(f.run(), /already_materialized/);
});
test("one prior attempt under corrected row prevents another candidate from this receipt", async t => {
  const f = await fixture(t), next = path.join(f.staging, "corrected-repair");
  await f.put(path.join(next, "work_manifest.json"), { items: [{ asset_id: f.id, source_row_sha256: f.receipt.current_source_row_sha256 }] });
  await fs.mkdir(path.join(next, "attempts", f.id, "attempt-001-used"), { recursive: true });
  await assert.rejects(f.run(), /corrected_row_already_attempted/);
});
test("original live lease or successful completion cannot be reclassified as orphan failure", async t => {
  for (const kind of ["lease", "completion"]) {
    const f = await fixture(t);
    if (kind === "lease") await fs.mkdir(path.join(f.manifestDir, "leases", f.id + ".lock"), { recursive: true });
    else await f.put(path.join(f.manifestDir, "completions", f.id + ".json"), { status: "completed" });
    await assert.rejects(f.run(), /original_attempt_not_closed/);
  }
});
