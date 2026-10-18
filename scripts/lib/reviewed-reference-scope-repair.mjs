import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { referencePlanApprovalContractSha256, referencePlanApprovalMatches } from "./reference-plan-contract.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const isHash = (value) => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const text = (value) => typeof value === "string" && value.trim() === value && value.length > 0;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => keys.includes(key));
const unique = (items) => new Set(items).size === items.length;
const dependencies = {
  run_identity: "run_identity.json",
  script: "script_clean.md",
  beat_plan: "visual_beat_plan.json",
  beat_approval: "visual_beat_approval.json",
  inventory: "reference_inventory_ledger.json",
  reference_plan: "visual_reference_plan.json",
  character_refs: "character_state_refs.json",
  reference_plan_approval: "reference_plan_approval.json",
  reference_image_approval: "visual_reference_approval_ep_01.json",
  base_prompt_plan: "section_image_prompts.json",
  reviewed_prompt_plan: "section_image_prompts_reviewed.json",
  harden_report: "visual_prompt_hardening_ep_01.json",
  manual_review: "visual_manual_agent_review_ep_01.json",
};
const mutable = ["inventory", "reference_plan", "character_refs", "reference_plan_approval",
  "reference_image_approval", "base_prompt_plan", "reviewed_prompt_plan"];

export function reviewedReferenceScopeRepairAdmission(status, flags) {
  const deny = (reason) => ({ allowed: false, reason });
  if (!exact(flags, ["episode-dir", "repair-spec"]) || !text(flags?.["episode-dir"]) || !text(flags?.["repair-spec"])) {
    return deny("episode_dir_and_reviewed_spec_required");
  }
  if (path.resolve(flags["episode-dir"]) !== path.resolve(String(status?.episode_dir ?? ""))) return deny("episode_status_mismatch");
  if (status?.identity?.schema !== "goldflow_run_identity_v2" || status?.media_workflow?.id !== "generated_visuals_v1") {
    return deny("unsupported_identity_or_workflow");
  }
  if (status.current_stage !== "visual_prompt_harden" || status.current_stage_state !== "blocked"
    || !/manual agent review required/i.test(status.next_command_shape ?? "")) return deny("manual_harden_blocker_required");
  for (const stage of ["transition_edit_plan", "image_generation", "image_output_qa"]) {
    if (["running", "passed", "failed"].includes(status.stage_ledger?.find((row) => row.stage === stage)?.state)) {
      return deny("transition_or_image_stage_started");
    }
  }
  return { allowed: true, reason: "exact_approved_reference_scope_extension" };
}

function one(items, predicate, label) {
  const matches = items?.filter(predicate) ?? [];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${label}.`);
  return matches[0];
}

function extend(existing, additions) {
  return [...existing, ...additions.filter((item) => !existing.includes(item))];
}

function assertCurrentSource(owner, sourcePath, expectedHash) {
  if (owner?.source_hashes?.[sourcePath] !== expectedHash) throw new Error(`${path.basename(sourcePath)} lineage is stale.`);
}

export async function repairReviewedReferenceScope({ episodeDir, specPath, spec, status, now = new Date(), dryRun = false }) {
  episodeDir = path.resolve(episodeDir);
  const admitted = reviewedReferenceScopeRepairAdmission(status, { "episode-dir": episodeDir, "repair-spec": specPath });
  if (!admitted.allowed) throw new Error(`Reviewed reference scope repair refused: ${admitted.reason}.`);
  if (!exact(spec, ["schema", "episode", "expected", "scope", "reviewer", "note"])
    || spec.schema !== "goldflow_reviewed_reference_scope_repair_v1" || spec.episode !== path.basename(episodeDir)
    || !text(spec.reviewer) || !text(spec.note) || !exact(spec.expected, Object.keys(dependencies))
    || Object.keys(dependencies).some((key) => !isHash(spec.expected[key]))) {
    throw new Error("Complete current-hash reviewed reference scope spec required.");
  }
  const scope = spec.scope;
  if (!exact(scope, ["ref_id", "asset_id", "canonical_subject_id", "visible_character", "old_scene_ids",
    "add_scene_ids", "cuts", "approved_reference_sha256"])
    || !text(scope?.ref_id) || !text(scope.asset_id) || !text(scope.canonical_subject_id)
    || !text(scope.visible_character) || !isHash(scope.approved_reference_sha256)
    || !Array.isArray(scope.old_scene_ids) || !scope.old_scene_ids.length || !unique(scope.old_scene_ids)
    || !Array.isArray(scope.add_scene_ids) || !scope.add_scene_ids.length || !unique(scope.add_scene_ids)
    || !Array.isArray(scope.cuts) || !scope.cuts.length || !unique(scope.cuts.map((cut) => cut.image_id))
    || scope.add_scene_ids.some((scene) => !/^scene_\d+$/.test(scene) || scope.old_scene_ids.includes(scene))) {
    throw new Error("Exact approved creature scope, new scenes, and cut list required.");
  }
  const files = {};
  for (const [key, name] of Object.entries(dependencies)) {
    const file = path.join(episodeDir, name);
    const bytes = await fs.readFile(file);
    files[key] = { path: file, bytes, sha256: sha(bytes), value: name.endsWith(".json") ? JSON.parse(bytes) : bytes.toString("utf8") };
    if (files[key].sha256 !== spec.expected[key]) throw new Error(`${name} changed since review.`);
  }
  const values = Object.fromEntries(Object.entries(files).map(([key, item]) => [key, item.value]));
  const { script, beat_plan: beats, beat_approval: beatApproval, inventory, reference_plan: plan,
    character_refs: refs, reference_plan_approval: planApproval, reference_image_approval: imageApproval,
    base_prompt_plan: base, reviewed_prompt_plan: reviewed, harden_report: harden, manual_review: manual } = values;
  if (beats.status !== "passed" || beatApproval.status !== "approved" || inventory.status !== "passed"
    || plan.status !== "passed" || refs.status !== "approved" || planApproval.status !== "approved"
    || imageApproval.status !== "approved" || base.status !== "passed"
    || reviewed.status !== "needs_manual_agent_review" || harden.status !== "blocked"
    || manual.status !== "needs_manual_agent_review" || !referencePlanApprovalMatches({
      approval: planApproval, plan, fileSha256: files.reference_plan.sha256,
    }) || imageApproval.visual_reference_plan_hash !== files.reference_plan.sha256) {
    throw new Error("Current approved reference and blocked prompt lineage required.");
  }
  assertCurrentSource(plan, files.inventory.path, files.inventory.sha256);
  assertCurrentSource(refs, files.reference_plan.path, files.reference_plan.sha256);
  for (const promptPlan of [base, reviewed]) {
    for (const key of ["reference_plan", "character_refs", "reference_plan_approval"]) {
      assertCurrentSource(promptPlan, files[key].path, files[key].sha256);
    }
  }
  const rasterDecision = one(imageApproval.reference_decisions, (item) => item.ref_id === scope.ref_id, "approved raster decision");
  if (rasterDecision.status !== "approved_clean" || rasterDecision.reference_image_sha256 !== scope.approved_reference_sha256
    || imageApproval.reference_hash_by_ref_id?.[scope.ref_id] !== scope.approved_reference_sha256
    || sha(await fs.readFile(rasterDecision.reference_image_path)) !== scope.approved_reference_sha256) {
    throw new Error("Approved reference raster changed or was not cleanly accepted.");
  }
  const rasterHashes = {};
  for (const decision of imageApproval.reference_decisions) {
    if (!isHash(decision.reference_image_sha256) || !text(decision.reference_image_path)
      || sha(await fs.readFile(decision.reference_image_path)) !== decision.reference_image_sha256) {
      throw new Error(`Accepted raster changed: ${decision.ref_id}.`);
    }
    rasterHashes[decision.ref_id] = decision.reference_image_sha256;
  }
  if (Object.keys(rasterHashes).length !== imageApproval.materialized_reference_count
    || !unique(Object.keys(rasterHashes))) throw new Error("Materialized reference inventory is incomplete.");
  const target = one(plan.reference_targets, (item) => item.ref_id === scope.ref_id, "reference target");
  const inventoryAsset = one(inventory.assets, (item) => item.asset_id === scope.asset_id && item.ref_id === scope.ref_id, "inventory asset");
  const plannedState = one(plan.character_state_refs, (item) => item.state_ref_id === scope.ref_id, "planned character state");
  const materializedState = one(refs.character_state_refs, (item) => item.state_ref_id === scope.ref_id, "approved character state");
  const approvedTarget = one(planApproval.selected_targets, (item) => item.ref_id === scope.ref_id, "approved target");
  for (const row of [target, inventoryAsset, plannedState, materializedState, approvedTarget]) {
    if (JSON.stringify(row.scene_ids) !== JSON.stringify(scope.old_scene_ids)) throw new Error("Old scene scope does not match every projection.");
  }
  if (target.kind !== "character_state" || target.conditioning_asset_role !== "creature_identity"
    || plannedState.identity_subtype !== "creature" || materializedState.identity_subtype !== "creature"
    || JSON.stringify(target.planned_beat_ids) !== JSON.stringify(inventoryAsset.planned_beat_ids)
    || target.canonical_subject_id !== scope.canonical_subject_id
    || inventoryAsset.ref_id !== scope.ref_id || inventoryAsset.canonical_subject_id !== scope.canonical_subject_id
    || materializedState.character !== scope.visible_character || plannedState.character !== scope.visible_character
    || materializedState.reference_image_path !== rasterDecision.reference_image_path
    || target.reference_image_path !== rasterDecision.reference_image_path
    || approvedTarget.kind !== "character_state") throw new Error("Scope does not identify one existing approved creature identity.");
  const unresolved = harden.findings.filter((item) => item.severity === "blocker" && item.resolved !== true);
  const unresolvedIds = manual.unresolved_blockers?.map((item) => item.image_id) ?? [];
  const cutIds = scope.cuts.map((cut) => cut.image_id);
  if (!unique(unresolvedIds) || JSON.stringify([...unresolvedIds].sort()) !== JSON.stringify([...cutIds].sort())
    || JSON.stringify([...(manual.image_ids ?? [])].sort()) !== JSON.stringify([...cutIds].sort())
    || unresolved.some((item) => item.code !== "visible_character_ref_scope_missing"
      || item.character !== scope.visible_character || !item.out_of_scope_ref_ids?.includes(scope.ref_id))
    || unresolvedIds.some((id) => !unresolved.some((item) => item.image_id === id))) {
    throw new Error("Only the exact manual out-of-scope identity blockers may be repaired.");
  }
  const sceneIds = new Set();
  const beatIds = [];
  for (const cut of scope.cuts) {
    if (!exact(cut, ["image_id", "visual_beat_id", "scene_id", "source_quote", "old_reviewed_row_sha256"])
      || !text(cut.image_id) || !text(cut.visual_beat_id) || !text(cut.scene_id)
      || !text(cut.source_quote) || !isHash(cut.old_reviewed_row_sha256)) throw new Error("Each cut needs exact source and row evidence.");
    const beat = one(beats.beats, (item) => item.image_id_hint === cut.image_id, "approved visual beat");
    const row = one(reviewed.prompts, (item) => item.image_id === cut.image_id, "reviewed prompt cut");
    const baseRow = one(base.prompts, (item) => item.image_id === cut.image_id, "base prompt cut");
    const blocker = one(manual.unresolved_blockers, (item) => item.image_id === cut.image_id, "manual blocker");
    if (beat.visual_beat_id !== cut.visual_beat_id || beat.scene_id !== cut.scene_id
      || row.scene_id !== cut.scene_id || baseRow.scene_id !== cut.scene_id
      || row.visual_beat_id !== cut.visual_beat_id || blocker.code !== "visible_character_ref_scope_missing"
      || !beat.physically_visible_entity_ids?.includes(scope.canonical_subject_id)
      || !row.shot_manifest?.visible_characters?.includes(scope.visible_character)
      || !beat.visual_beat_script_excerpt?.includes(cut.source_quote) || !script.includes(cut.source_quote)
      || sha(json(row)) !== cut.old_reviewed_row_sha256 || !scope.add_scene_ids.includes(cut.scene_id)) {
      throw new Error(`Approved visible creature and source do not match ${cut.image_id}.`);
    }
    sceneIds.add(cut.scene_id);
    beatIds.push(cut.visual_beat_id);
  }
  if (sceneIds.size !== scope.add_scene_ids.length || scope.add_scene_ids.some((id) => !sceneIds.has(id))) {
    throw new Error("New scenes must derive exactly from the reviewed cuts.");
  }
  const events = await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8")
    .catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  if (events.split("\n").filter(Boolean).some((line) => ["transition_edit_plan", "image_generation", "image_output_qa"].includes(JSON.parse(line).stage))) {
    throw new Error("Image or transition processing already started.");
  }
  const output = Object.fromEntries(mutable.map((key) => [key, structuredClone(values[key])]));
  const outTarget = one(output.reference_plan.reference_targets, (item) => item.ref_id === scope.ref_id, "output target");
  const outAsset = one(output.inventory.assets, (item) => item.asset_id === scope.asset_id && item.ref_id === scope.ref_id, "output asset");
  for (const item of [outTarget, outAsset]) {
    item.scene_ids = extend(item.scene_ids, scope.add_scene_ids);
    item.planned_beat_ids = extend(item.planned_beat_ids, beatIds);
  }
  for (const item of [one(output.reference_plan.character_state_refs, (row) => row.state_ref_id === scope.ref_id, "output plan state"),
    one(output.character_refs.character_state_refs, (row) => row.state_ref_id === scope.ref_id, "output approved state"),
    one(output.reference_plan_approval.selected_targets, (row) => row.ref_id === scope.ref_id, "output approved target")]) {
    item.scene_ids = extend(item.scene_ids, scope.add_scene_ids);
  }
  const nowIso = now.toISOString();
  const specBytes = await fs.readFile(specPath);
  const scopeRecord = { schema: "goldflow_reviewed_reference_scope_extension_v1", ref_id: scope.ref_id,
    scene_ids: scope.add_scene_ids, image_ids: cutIds, beat_ids: beatIds,
    approved_reference_sha256: scope.approved_reference_sha256, reviewer: spec.reviewer,
    note: spec.note, spec_sha256: sha(specBytes), updated_at: nowIso };
  output.reference_plan_approval.reviewed_scope_extensions = [...(output.reference_plan_approval.reviewed_scope_extensions ?? []), scopeRecord];
  output.reference_image_approval.reviewed_scope_extensions = [...(output.reference_image_approval.reviewed_scope_extensions ?? []), scopeRecord];
  output.reviewed_prompt_plan.status = "passed";
  delete output.reviewed_prompt_plan.visual_manual_agent_review_path;
  output.reviewed_prompt_plan.reviewed_reference_scope_extensions = [...(output.reviewed_prompt_plan.reviewed_reference_scope_extensions ?? []), scopeRecord];
  const bytes = {};
  const set = (key) => { bytes[key] = json(output[key]); return sha(bytes[key]); };
  const inventoryHash = set("inventory");
  output.reference_plan.source_hashes[files.inventory.path] = inventoryHash;
  const planHash = set("reference_plan");
  output.character_refs.source_hashes[files.reference_plan.path] = planHash;
  const refsHash = set("character_refs");
  output.reference_plan_approval.visual_reference_plan_sha256 = planHash;
  output.reference_plan_approval.reference_plan_contract_sha256 = referencePlanApprovalContractSha256(output.reference_plan);
  const approvalHash = set("reference_plan_approval");
  output.reference_image_approval.visual_reference_plan_hash = planHash;
  set("reference_image_approval");
  for (const key of ["base_prompt_plan", "reviewed_prompt_plan"]) {
    output[key].source_hashes[files.reference_plan.path] = planHash;
    output[key].source_hashes[files.character_refs.path] = refsHash;
    output[key].source_hashes[files.reference_plan_approval.path] = approvalHash;
    set(key);
  }
  if (!referencePlanApprovalMatches({ approval: output.reference_plan_approval, plan: output.reference_plan,
    fileSha256: planHash }) || output.base_prompt_plan.prompts.length !== base.prompts.length
    || output.reviewed_prompt_plan.prompts.length !== reviewed.prompts.length
    || JSON.stringify(output.base_prompt_plan.prompts) !== JSON.stringify(base.prompts)
    || JSON.stringify(output.reviewed_prompt_plan.prompts) !== JSON.stringify(reviewed.prompts)
    || Object.keys(rasterHashes).length !== output.reference_image_approval.reference_decisions.length
    || JSON.stringify(output.reference_image_approval.reference_hash_by_ref_id) !== JSON.stringify(imageApproval.reference_hash_by_ref_id)) {
    throw new Error("Repair changed prompt rows or accepted raster inventory.");
  }
  if (dryRun) return { status: "validated", extended_ref_id: scope.ref_id,
    scene_ids: scope.add_scene_ids, cut_ids: cutIds, prompt_row_count: reviewed.prompts.length,
    materialized_reference_count: Object.keys(rasterHashes).length,
    prompt_rows_changed: 0, materialized_refs_changed: 0, provider_calls: 0 };
  const id = `${nowIso.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const receiptDir = path.join(episodeDir, "reports", "stages", "visual_prompt_blocker_repair", "reviewed_reference_scope", id);
  const beforeDir = path.join(receiptDir, "before");
  await fs.mkdir(beforeDir, { recursive: true });
  for (const key of mutable) await fs.writeFile(path.join(beforeDir, path.basename(files[key].path)), files[key].bytes, { flag: "wx" });
  await fs.writeFile(path.join(receiptDir, "repair_spec.json"), specBytes, { flag: "wx" });
  const changed = [];
  try {
    for (const key of mutable) {
      const temp = path.join(episodeDir, `.${path.basename(files[key].path)}.${id}.tmp`);
      await fs.writeFile(temp, bytes[key], { flag: "wx" });
      await fs.rename(temp, files[key].path);
      changed.push(key);
    }
    const receipt = { schema: "goldflow_reviewed_reference_scope_repair_receipt_v1", status: "passed",
      episode: spec.episode, scope: scopeRecord,
      before_hashes: Object.fromEntries(Object.entries(files).map(([key, item]) => [key, item.sha256])),
      after_hashes: Object.fromEntries(mutable.map((key) => [key, sha(bytes[key])])),
      before_snapshot_dir: beforeDir, accepted_raster_hashes: rasterHashes,
      prompt_row_count: reviewed.prompts.length, prompt_rows_changed: 0, materialized_refs_changed: 0,
      provider_calls: 0, image_submissions: 0, estimated_cost_usd: 0, updated_at: nowIso };
    await fs.writeFile(path.join(receiptDir, "receipt.json"), json(receipt), { flag: "wx" });
    return { status: "passed", receipt_path: path.join(receiptDir, "receipt.json"),
      extended_ref_id: scope.ref_id, scene_ids: scope.add_scene_ids, cut_ids: cutIds,
      prompt_rows_changed: 0, materialized_refs_changed: 0, provider_calls: 0 };
  } catch (error) {
    for (const key of changed.reverse()) await fs.writeFile(files[key].path, files[key].bytes);
    throw error;
  }
}
