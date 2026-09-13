import { promises as fs } from "node:fs";
import path from "node:path";
import { codexWorkSourceRowSha256, sha256, stableStringify } from "./codex-image-work-contract.mjs";

const HASH = /^[a-f0-9]{64}$/;
const requireValue = (ok, reason) => { if (!ok) throw new Error("reviewed_orphan_prompt_repair:" + reason); };
const meaningful = value => typeof value === "string" && value.trim().length >= 20;
const same = (a, b) => stableStringify(a) === stableStringify(b);
const exists = file => fs.stat(file).then(() => true).catch(() => false);
const valueHash = value => sha256(JSON.stringify(value));
const ALLOWED_LEAF = /^(?:\/(?:provider_prompt|image_prompt|prompt_hash)|\/shot_manifest\/anatomy_contracts\/\d+\/body_invariant|\/shot_manifest\/equipment_contracts\/\d+\/hand_assignment|\/shot_manifest\/character_staging\/\d+\/(?:pose|screen_position)|\/spatial_continuity\/object_geography)$/;
const readLeaf = (row, pointer) => pointer.slice(1).split("/").reduce((value, key) => value?.[key], row);
function writeLeaf(row, pointer, value) {
  const keys = pointer.slice(1).split("/"), leaf = keys.pop();
  keys.reduce((current, key) => current[key], row)[leaf] = value;
}

// Opt-in evidence only. No import, provider call, lease or source mutation.
// The ordinary same-row deadletter and historical content-policy paths remain separate.
export async function reviewedOrphanPromptRepairEvidence({ episodeDir, episode, currentRows, requestedIds }) {
  const indexPath = path.join(episodeDir, "reviewed_orphan_prompt_repairs_" + episode + ".json");
  if (!await exists(indexPath)) return new Map();
  requireValue(path.isAbsolute(episodeDir), "absolute_episode_required");
  const records = new Map();
  async function bytes(file, expected) {
    requireValue(path.isAbsolute(file), "absolute_evidence_path_required");
    const content = await fs.readFile(file), actual = sha256(content);
    if (expected !== undefined) requireValue(HASH.test(expected) && actual === expected, "stale_evidence:" + path.basename(file));
    records.set(file, { path: file, sha256: actual });
    return content;
  }
  async function bound(record, json = true) {
    requireValue(record && HASH.test(record.sha256) && typeof record.path === "string", "missing_bound_record");
    const content = await bytes(record.path, record.sha256);
    return json ? JSON.parse(content) : content;
  }
  const index = JSON.parse(await bytes(indexPath));
  requireValue(index.schema === "goldflow_reviewed_orphan_prompt_repair_index_v1" && index.status === "approved"
    && Array.isArray(index.entries) && new Set(index.entries.map(row => row.image_id)).size === index.entries.length,
  "invalid_index");
  const selected = index.entries.filter(row => requestedIds.has(row.image_id));
  const output = new Map();
  for (const entry of selected) {
    const receipt = await bound({ path: entry.receipt_path, sha256: entry.receipt_sha256 });
    const id = entry.image_id;
    requireValue(receipt.schema === "goldflow_reviewed_orphan_prompt_patch_v1" && receipt.status === "approved"
      && receipt.image_id === id && receipt.episode_dir === episodeDir && meaningful(receipt.reason)
      && typeof receipt.reviewed_by === "string" && receipt.reviewed_by.trim()
      && Number.isFinite(Date.parse(receipt.reviewed_at)), "invalid_review_receipt");
    const canonical = name => path.join(episodeDir, name);
    for (const [key, filename] of [["identity", "run_identity.json"], ["approval", "operator_script_approval.json"],
      ["lock", "script_lock.json"], ["current_raw", "section_image_prompts.json"],
      ["current_hardened", "section_image_prompts_hardened.json"]]) {
      requireValue(receipt[key]?.path === canonical(filename), "noncanonical_current_binding:" + key);
    }
    const identity = await bound(receipt.identity), approval = await bound(receipt.approval), lock = await bound(receipt.lock);
    const sourceHash = sha256(await bytes(canonical("script_clean.md"), receipt.source_script_sha256));
    requireValue(identity.source_sha256 === sourceHash && identity.episode === episode
      && [approval, lock].every(row => row.operator_approved === true && row.script_clean_hash === sourceHash
        && ["channel", "series_slug", "week", "episode"].every(key => row[key] === identity[key])), "stale_source_approval");
    const raw = await bound(receipt.current_raw), hardened = await bound(receipt.current_hardened);
    requireValue([raw, hardened].every(plan => plan.status === "passed" && plan.source_script_hash === sourceHash
      && ["channel", "series_slug", "week", "episode"].every(key => plan[key] === identity[key])
      && Array.isArray(plan.prompts) && new Set(plan.prompts.map(row => row.image_id)).size === plan.prompts.length),
    "invalid_current_plans");
    const current = hardened.prompts.find(row => row.image_id === id);
    requireValue(current && current.image_generation_required !== false
      && same(current, currentRows.find(row => row.image_id === id))
      && codexWorkSourceRowSha256(current) === receipt.current_source_row_sha256, "current_row_mismatch");
    const manifest = await bound(receipt.manifest), assignment = await bound(receipt.assignment), deadletter = await bound(receipt.deadletter);
    const manifestDir = path.dirname(receipt.manifest.path), stagingRoot = canonical("assets/images/codex_worker_staging");
    requireValue(path.dirname(manifestDir) === stagingRoot && path.basename(receipt.manifest.path) === "work_manifest.json"
      && manifest.schema === "goldflow_codex_image_work_manifest_v1" && manifest.mode === "scene"
      && manifest.episode_dir === episodeDir && ["federated_google_web_image_pool", "hybrid_chatgpt_web_style_google_flow_pool"].includes(manifest.provider)
      && manifest.sources?.run_identity?.path === receipt.identity.path
      && manifest.sources.run_identity.sha256 === receipt.identity.sha256, "invalid_original_manifest");
    const item = manifest.items.find(row => row.asset_id === id);
    requireValue(item && receipt.deadletter.path === path.join(manifestDir, "deadletters", id + ".json")
      && path.dirname(receipt.assignment.path).startsWith(path.join(manifestDir, "attempts", id) + path.sep)
      && path.basename(receipt.assignment.path) === "assignment.json"
      && assignment.manifest_id === manifest.manifest_id && assignment.asset_id === id
      && assignment.item?.source_row_sha256 === item.source_row_sha256
      && assignment.attempt_number === 1 && deadletter.manifest_id === manifest.manifest_id
      && deadletter.asset_id === id && deadletter.status === "deadlettered"
      && deadletter.reason === "lease_expired_max_attempts" && deadletter.attempt_count === 1 && deadletter.max_attempts === 1
      && deadletter.creative_contract?.source_row_sha256 === item.source_row_sha256
      && deadletter.creative_contract.prompt_sha256 === assignment.item.prompt_sha256, "invalid_original_failure");
    requireValue(!await exists(path.join(manifestDir, "completions", id + ".json"))
      && !await exists(path.join(manifestDir, "leases", id + ".lock")), "original_attempt_not_closed");
    const review = await bound(receipt.rejected_candidate_review);
    requireValue(review.schema === "goldflow_manual_failed_image_candidate_review_v1"
      && review.status === "rejected_material_visual_defect" && review.actual_raster_reviewed === true
      && review.episode_dir === episodeDir && review.manifest_id === manifest.manifest_id && review.image_id === id
      && review.source_row_sha256 === item.source_row_sha256
      && review.assigned_prompt_sha256 === assignment.item.prompt_sha256
      && review.assigned_plan_sha256 === manifest.sources?.prompt_plan?.sha256
      && review.candidate?.accepted_into_canonical_episode === false && review.blocker?.severity === "blocker"
      && meaningful(review.blocker.actual_observation) && review.lifecycle?.creative_submission_count === 1
      && review.lifecycle.actual_submission?.status === "submitted"
      && review.lifecycle.actual_submission.job_id === "image:" + manifest.manifest_id + ":" + id,
    "missing_actual_rejected_orphan_evidence");
    requireValue(receipt.rejected_raster?.path === review.candidate.original_download_path
      && receipt.rejected_raster.sha256 === review.candidate.sha256, "rejected_download_mismatch");
    await bound(receipt.rejected_raster, false);
    await bytes(review.candidate.preserved_png_path, review.candidate.sha256);
    requireValue(Array.isArray(review.sources) && review.sources.some(row => row.path === receipt.assignment.path
      && row.sha256 === receipt.assignment.sha256), "unbound_original_assignment");
    for (const record of review.sources) await bound(record, false);
    const beforeRaw = await bound(receipt.before_raw), beforeHardened = await bound(receipt.before_hardened);
    const application = await bound(receipt.application), proposal = await bound(receipt.proposal);
    requireValue(application.schema === "goldflow_reviewed_manual_scene_prompt_repair_v1" && application.status === "applied"
      && same(application.exact_image_ids, [id]) && application.source_script_hash === sourceHash
      && application.run_identity_sha256 === receipt.identity.sha256
      && application.input_sha256 === receipt.before_raw.sha256 && application.output_sha256 === receipt.current_raw.sha256
      && application.proposal_path === receipt.proposal.path && application.proposal_sha256 === receipt.proposal.sha256
      && same(proposal.exact_image_ids, [id]) && Array.isArray(proposal.patches)
      && proposal.patches.length > 0 && proposal.patches.length <= 12,
    "unbound_reviewed_application");
    requireValue(application.snapshots?.some(row => row.path === receipt.current_raw.path && row.snapshot_path === receipt.before_raw.path
      && row.sha256 === receipt.before_raw.sha256) && application.snapshots.some(row => row.path === receipt.current_hardened.path
      && row.snapshot_path === receipt.before_hardened.path && row.sha256 === receipt.before_hardened.sha256), "unbound_before_snapshots");
    const expectedRaw = structuredClone(beforeRaw), expectedHard = structuredClone(beforeHardened);
    const rawRow = expectedRaw.prompts.find(row => row.image_id === id), hardRow = expectedHard.prompts.find(row => row.image_id === id);
    requireValue(rawRow && hardRow && codexWorkSourceRowSha256(hardRow) === item.source_row_sha256
      && beforeRaw.source_script_hash === sourceHash && beforeHardened.source_script_hash === sourceHash, "old_row_mismatch");
    const fields = proposal.patches.map(patch => patch.field_path);
    requireValue(new Set(fields).size === fields.length && ["/provider_prompt", "/image_prompt", "/prompt_hash"].every(field => fields.includes(field)),
      "incomplete_or_duplicate_patch");
    for (const patch of proposal.patches) {
      requireValue(patch.op === "replace" && patch.artifact_path === receipt.current_raw.path
        && patch.selector?.array === "prompts" && patch.selector.image_id === id && ALLOWED_LEAF.test(patch.field_path)
        && typeof patch.before === "string" && typeof patch.after === "string" && patch.before !== patch.after
        && same(readLeaf(rawRow, patch.field_path), patch.before) && same(readLeaf(hardRow, patch.field_path), patch.before)
        && valueHash(patch.before) === patch.before_sha256 && valueHash(patch.after) === patch.after_sha256,
      "invalid_reviewed_leaf_patch");
      writeLeaf(rawRow, patch.field_path, patch.after); writeLeaf(hardRow, patch.field_path, patch.after);
    }
    requireValue(rawRow.provider_prompt === rawRow.image_prompt && sha256(rawRow.provider_prompt) === rawRow.prompt_hash,
      "inconsistent_prompt_mirrors");
    hardRow.modelslab_image_prompt = hardRow.provider_prompt; // Existing hardener's derived mirror only.
    requireValue(same(expectedRaw, raw) && same(expectedHard.prompts, hardened.prompts), "out_of_scope_plan_change");
    for (const ref of assignment.item.ordered_references ?? []) await bytes(ref.path, ref.sha256);
    requireValue(same((assignment.item.ordered_references ?? []).map(ref => ({ ref_id: ref.ref_id, path: ref.path })),
      (current.reference_slots ?? []).map(ref => ({ ref_id: ref.ref_id, path: ref.path }))), "reference_scope_changed");
    const aggregatePath = canonical("imagegen_report_" + episode + ".json");
    const aggregate = JSON.parse(await bytes(aggregatePath));
    requireValue(!(aggregate.results ?? []).some(row => row.image_id === id && row.image_path), "already_materialized");
    // One use for this corrected row; later real failures use the normal same-row deadletter route.
    for (const entry of await fs.readdir(stagingRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const otherDir = path.join(stagingRoot, entry.name), otherPath = path.join(otherDir, "work_manifest.json");
      const other = await fs.readFile(otherPath, "utf8").then(JSON.parse).catch(() => null);
      if (!other?.items?.some(row => row.asset_id === id && row.source_row_sha256 === receipt.current_source_row_sha256)) continue;
      const attempts = await fs.readdir(path.join(otherDir, "attempts", id)).catch(() => []);
      requireValue(!attempts.some(name => name.startsWith("attempt-"))
        && !await exists(path.join(otherDir, "completions", id + ".json"))
        && !await exists(path.join(otherDir, "deadletters", id + ".json")), "corrected_row_already_attempted");
    }
    // The mutable pointer and aggregate are admission checks, not immutable
    // provider-evidence dependencies: later imports and index additions must
    // not invalidate this retained repair manifest. The approved receipt stays bound.
    output.set(id, { asset_id: id, records: [...records.values()]
      .filter(record => ![indexPath, aggregatePath].includes(record.path)) });
  }
  for (const record of records.values()) requireValue(sha256(await fs.readFile(record.path)) === record.sha256,
    "evidence_changed_during_read");
  return output;
}
