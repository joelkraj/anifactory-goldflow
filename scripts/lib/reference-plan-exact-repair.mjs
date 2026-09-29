import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { groupingLockHash } from "./editorial-beat-director.mjs";
import { assertReferenceDirectorSelectionFidelity } from "./reference-selection-fidelity.mjs";

const SCHEMA = "goldflow_reference_plan_exact_repair_v1";
const EXPECTED_HASH_KEYS = [
  "visual_beat_plan_sha256", "visual_beat_approval_sha256",
  "visual_reference_plan_sha256", "reference_inventory_ledger_sha256",
  "character_state_refs_sha256",
];
const REF_SET_FIELDS = new Set(["prompt_anchor", "state_delta"]);
const STATE_SET_FIELDS = new Set(["prompt_anchor", "scene_prompt_anchor"]);

function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value;
}
function keys(value, allowed, name) {
  for (const key of Object.keys(object(value, name))) {
    if (!allowed.includes(key)) throw new Error(`${name} has forbidden field ${key}.`);
  }
}
function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be nonempty text.`);
  return value;
}
function ids(value, name) {
  if (!Array.isArray(value) || !value.length || value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error(`${name} must be a nonempty array of IDs.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${name} contains duplicate IDs.`);
  return value;
}
function uniqueRow(rows, field, id, name) {
  const matches = rows.filter((row) => row?.[field] === id);
  if (matches.length !== 1) throw new Error(`${name} ${id} must exist exactly once; found ${matches.length}.`);
  return matches[0];
}
function removeExact(current, removals, name) {
  if (!Array.isArray(current)) throw new Error(`${name} is not an array.`);
  const selected = ids(removals, name);
  for (const id of selected) if (!current.includes(id)) throw new Error(`${name} does not contain ${id}.`);
  return current.filter((id) => !selected.includes(id));
}
function applySet(row, changes, allowed, name) {
  keys(changes, [...allowed], `${name}.set`);
  if (!Object.keys(changes).length) throw new Error(`${name}.set is empty.`);
  for (const [field, value] of Object.entries(changes)) {
    nonempty(value, `${name}.set.${field}`);
    if (row[field] === value) throw new Error(`${name}.set.${field} is unchanged.`);
    row[field] = value;
  }
}
async function readRequired(filePath) {
  const bytes = await fs.readFile(filePath);
  return { bytes, value: object(JSON.parse(bytes.toString("utf8")), path.basename(filePath)), sha256: hash(bytes) };
}
async function assertSourceHashesCurrent(artifact, name) {
  for (const [sourcePath, expected] of Object.entries(artifact.source_hashes ?? {})) {
    if (!path.isAbsolute(sourcePath)) throw new Error(`${name} source path must be absolute: ${sourcePath}`);
    const actual = hash(await fs.readFile(sourcePath));
    if (actual !== expected) throw new Error(`${name} has stale source hash for ${sourcePath}.`);
  }
}
async function assertNoReferenceSpend(episodeDir, plan) {
  const generated = plan.reference_targets.filter((row) => row.generation_mode === "standalone_ref");
  if (generated.some((row) => row.reference_image_path || row.conditioning_image_path)) {
    throw new Error("Generated reference paths already exist in the plan; exact pre-spend repair is closed.");
  }
  const referenceDir = path.join(episodeDir, "assets", "images", "references");
  if ((await fs.readdir(referenceDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error))).length) {
    throw new Error("Reference image directory is not empty; exact pre-spend repair is closed.");
  }
  const events = await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  for (const line of events.split("\n").filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error("Execution event ledger contains invalid JSON."); }
    if (event.stage === "reference_generation") throw new Error("Reference generation was attempted; exact pre-spend repair is closed.");
  }
}

function patchBeatLocations(beats, patches) {
  if (patches === undefined) return [];
  if (!Array.isArray(patches)) throw new Error("beat_location_patches must be an array.");
  const touched = new Set();
  const result = [];
  for (const [index, patch] of patches.entries()) {
    const name = `beat_location_patches[${index}]`;
    keys(patch, ["beat_ids", "from_location_id", "from_location", "to_location_id", "to_location", "remove_advisory_location_ref_id"], name);
    const beatIds = ids(patch.beat_ids, `${name}.beat_ids`);
    nonempty(patch.from_location_id, `${name}.from_location_id`);
    nonempty(patch.from_location, `${name}.from_location`);
    nonempty(patch.to_location, `${name}.to_location`);
    if (patch.to_location_id !== null && (typeof patch.to_location_id !== "string" || !patch.to_location_id.trim())) {
      throw new Error(`${name}.to_location_id must be null or a nonempty ID.`);
    }
    nonempty(patch.remove_advisory_location_ref_id, `${name}.remove_advisory_location_ref_id`);
    if (patch.from_location_id === patch.to_location_id && patch.from_location === patch.to_location) throw new Error(`${name} does not change location.`);
    for (const beatId of beatIds) {
      if (touched.has(beatId)) throw new Error(`Beat ${beatId} is patched twice.`);
      touched.add(beatId);
      const beat = uniqueRow(beats, "visual_beat_id", beatId, "Beat");
      if (beat.location_id !== patch.from_location_id || beat.location !== patch.from_location || beat.local_location !== patch.from_location) {
        throw new Error(`Beat ${beatId} old location does not match the repair spec.`);
      }
      if (beat.active_state_constraints?.location_id !== patch.from_location_id) {
        throw new Error(`Beat ${beatId} active state location does not match the repair spec.`);
      }
      for (const field of ["ref_needs", "beat_ref_requirements"]) {
        if (!Array.isArray(beat[field])) throw new Error(`Beat ${beatId}.${field} is missing.`);
        const matches = beat[field].filter((row) => row?.ref_id === patch.remove_advisory_location_ref_id && row?.kind === "location");
        if (matches.length !== 1) throw new Error(`Beat ${beatId}.${field} must contain exactly one scoped advisory location ref.`);
        beat[field] = beat[field].filter((row) => row !== matches[0]);
      }
      beat.location = patch.to_location;
      beat.local_location = patch.to_location;
      beat.location_id = patch.to_location_id;
      beat.active_state_constraints.location_id = patch.to_location_id;
      beat.location_timeline_label = `${String(beat.location_timeline_label ?? "").match(/^\d+:\d+/)?.[0] ?? ""} ${patch.to_location}`.trim();
      result.push({ beat_id: beatId, from_location_id: patch.from_location_id, to_location_id: patch.to_location_id, to_location: patch.to_location });
    }
  }
  return result;
}

function patchReferences(plan, inventory, patches) {
  if (patches === undefined) return [];
  if (!Array.isArray(patches)) throw new Error("reference_patches must be an array.");
  const touched = new Set();
  const result = [];
  for (const [index, patch] of patches.entries()) {
    const name = `reference_patches[${index}]`;
    keys(patch, ["ref_id", "remove_scene_ids", "remove_planned_beat_ids", "set"], name);
    const refId = nonempty(patch.ref_id, `${name}.ref_id`);
    if (touched.has(refId)) throw new Error(`Reference ${refId} is patched twice.`);
    touched.add(refId);
    const target = uniqueRow(plan.reference_targets, "ref_id", refId, "Reference target");
    const asset = uniqueRow(inventory.assets, "ref_id", refId, "Selected inventory asset");
    if (patch.remove_scene_ids === undefined && patch.remove_planned_beat_ids === undefined && patch.set === undefined) throw new Error(`${name} is empty.`);
    for (const field of ["scene_ids", "planned_beat_ids"]) {
      if (JSON.stringify(target[field]) !== JSON.stringify(asset[field])) throw new Error(`Reference ${refId} and inventory disagree on ${field}.`);
    }
    if (patch.remove_scene_ids !== undefined) {
      target.scene_ids = removeExact(target.scene_ids, patch.remove_scene_ids, `${name}.remove_scene_ids`);
      asset.scene_ids = [...target.scene_ids];
      const stateRows = (plan.character_state_refs ?? []).filter((row) => row?.state_ref_id === refId);
      if (stateRows.length > 1) throw new Error(`Duplicate character state projection for ${refId}.`);
      if (stateRows.length === 1) {
        stateRows[0].scene_ids = removeExact(stateRows[0].scene_ids, patch.remove_scene_ids, `${name}.state_scene_ids`);
      }
    }
    if (patch.remove_planned_beat_ids !== undefined) {
      target.planned_beat_ids = removeExact(target.planned_beat_ids, patch.remove_planned_beat_ids, `${name}.remove_planned_beat_ids`);
      asset.planned_beat_ids = [...target.planned_beat_ids];
    }
    if (patch.set !== undefined) {
      for (const field of Object.keys(patch.set)) {
        if (asset[field] !== target[field]) throw new Error(`Reference ${refId} and inventory disagree on ${field}.`);
      }
      applySet(target, patch.set, REF_SET_FIELDS, name);
      for (const field of Object.keys(patch.set)) asset[field] = target[field];
    }
    result.push({ ref_id: refId, removed_scene_ids: patch.remove_scene_ids ?? [], removed_planned_beat_ids: patch.remove_planned_beat_ids ?? [], set_fields: Object.keys(patch.set ?? {}) });
  }
  return result;
}

function patchStates(plan, patches) {
  if (patches === undefined) return [];
  if (!Array.isArray(patches)) throw new Error("state_ref_patches must be an array.");
  const touched = new Set();
  const result = [];
  for (const [index, patch] of patches.entries()) {
    const name = `state_ref_patches[${index}]`;
    keys(patch, ["state_ref_id", "set"], name);
    const stateId = nonempty(patch.state_ref_id, `${name}.state_ref_id`);
    if (touched.has(stateId)) throw new Error(`State ref ${stateId} is patched twice.`);
    touched.add(stateId);
    const state = uniqueRow(plan.character_state_refs, "state_ref_id", stateId, "Character state ref");
    applySet(state, patch.set, STATE_SET_FIELDS, name);
    result.push({ state_ref_id: stateId, set_fields: Object.keys(patch.set) });
  }
  return result;
}

function timeline(beats) {
  return beats.filter((beat, index) => beat.location && (index === 0 || beat.location !== beats[index - 1]?.location))
    .map((beat) => ({
      start_sec: beat.start_sec,
      timestamp: `${Math.floor(beat.start_sec / 60)}:${String(Math.floor(beat.start_sec % 60)).padStart(2, "0")}`,
      location: beat.location,
      scene_id: beat.parent_scene_id ?? beat.scene_id,
      visual_beat_id: beat.visual_beat_id,
      excerpt: beat.visual_beat_script_excerpt,
    }));
}

export async function repairReferencePlanExact({ episodeDir, spec, specPath, currentStage, now = new Date() }) {
  episodeDir = path.resolve(episodeDir);
  if (currentStage !== "reference_plan_approval") throw new Error(`Exact repair is allowed only at reference_plan_approval; current stage is ${currentStage}.`);
  keys(spec, ["schema", "episode", "expected", "reviewer", "note", "beat_location_patches", "reference_patches", "state_ref_patches"], "repair spec");
  if (spec.schema !== SCHEMA) throw new Error(`Repair spec requires ${SCHEMA}.`);
  if (spec.episode !== path.basename(episodeDir)) throw new Error("Repair spec episode does not match episode directory.");
  nonempty(spec.reviewer, "reviewer");
  nonempty(spec.note, "note");
  keys(spec.expected, EXPECTED_HASH_KEYS, "expected");
  for (const key of EXPECTED_HASH_KEYS) {
    if (!/^[a-f0-9]{64}$/.test(String(spec.expected[key] ?? ""))) throw new Error(`expected.${key} must be a SHA-256 hash.`);
  }
  if (![spec.beat_location_patches, spec.reference_patches, spec.state_ref_patches].some((rows) => Array.isArray(rows) && rows.length)) {
    throw new Error("Repair spec has no exact patches.");
  }
  const names = {
    visual_beat_plan_sha256: "visual_beat_plan.json",
    visual_beat_approval_sha256: "visual_beat_approval.json",
    visual_reference_plan_sha256: "visual_reference_plan.json",
    reference_inventory_ledger_sha256: "reference_inventory_ledger.json",
    character_state_refs_sha256: "character_state_refs.json",
  };
  const files = {};
  for (const [key, name] of Object.entries(names)) {
    const filePath = path.join(episodeDir, name);
    files[key] = { path: filePath, ...await readRequired(filePath) };
    if (files[key].sha256 !== spec.expected[key]) throw new Error(`${name} SHA-256 does not match repair spec; no files changed.`);
  }
  const beatPlan = structuredClone(files.visual_beat_plan_sha256.value);
  const beatApproval = structuredClone(files.visual_beat_approval_sha256.value);
  const plan = structuredClone(files.visual_reference_plan_sha256.value);
  const inventory = structuredClone(files.reference_inventory_ledger_sha256.value);
  const states = structuredClone(files.character_state_refs_sha256.value);
  if (beatPlan.status !== "passed" || beatApproval.status !== "approved" || plan.status !== "passed" || inventory.status !== "passed" || states.status !== "draft_needs_manual_review") {
    throw new Error("Beat plan, beat approval, reference plan, inventory, and character state projection must be in the pre-spend passed/draft states.");
  }
  if (beatApproval.visual_beat_plan_sha256 !== files.visual_beat_plan_sha256.sha256) throw new Error("Beat approval is stale.");
  if (beatApproval.grouping_lock_sha256 !== groupingLockHash(beatPlan.beats)) throw new Error("Beat grouping lock is stale.");
  if (plan.source_hashes?.[files.visual_beat_plan_sha256.path] !== files.visual_beat_plan_sha256.sha256
    || plan.source_hashes?.[files.reference_inventory_ledger_sha256.path] !== files.reference_inventory_ledger_sha256.sha256) {
    throw new Error("Reference plan is not bound to the current beat plan and selected inventory.");
  }
  if (states.source_hashes?.[files.visual_reference_plan_sha256.path] !== files.visual_reference_plan_sha256.sha256) throw new Error("Character-state projection is stale.");
  if (JSON.stringify(states.character_state_refs) !== JSON.stringify(plan.character_state_refs)) throw new Error("Character-state projection disagrees with reference plan.");
  await assertSourceHashesCurrent(beatPlan, "Beat plan");
  await assertSourceHashesCurrent(plan, "Reference plan");
  await assertNoReferenceSpend(episodeDir, plan);
  const priorGrouping = groupingLockHash(beatPlan.beats);
  const beatChanges = patchBeatLocations(beatPlan.beats, spec.beat_location_patches);
  const refChanges = patchReferences(plan, inventory, spec.reference_patches);
  const stateChanges = patchStates(plan, spec.state_ref_patches);
  if (groupingLockHash(beatPlan.beats) !== priorGrouping) throw new Error("Repair changed locked beat grouping.");
  if (beatChanges.length) beatPlan.location_timeline = timeline(beatPlan.beats);
  assertReferenceDirectorSelectionFidelity(plan);
  const updatedAt = now.toISOString();
  if (beatChanges.length) beatPlan.updated_at = updatedAt;
  if (refChanges.length) inventory.updated_at = updatedAt;
  const newBeatHash = beatChanges.length ? hash(jsonBytes(beatPlan)) : files.visual_beat_plan_sha256.sha256;
  if (beatChanges.length) plan.source_hashes[files.visual_beat_plan_sha256.path] = newBeatHash;
  if (refChanges.length) plan.source_hashes[files.reference_inventory_ledger_sha256.path] = hash(jsonBytes(inventory));
  plan.updated_at = updatedAt;
  const newPlanHash = hash(jsonBytes(plan));
  states.character_state_refs = structuredClone(plan.character_state_refs);
  states.source_hashes[files.visual_reference_plan_sha256.path] = newPlanHash;
  states.updated_at = updatedAt;
  const repairId = `${updatedAt.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const receiptDir = path.join(episodeDir, "reports", "stages", "reference_plan_approval", "exact_repairs", repairId);
  const specBytes = specPath ? await fs.readFile(specPath) : jsonBytes(spec);
  const output = {
    "visual_beat_plan.json": beatChanges.length ? jsonBytes(beatPlan) : files.visual_beat_plan_sha256.bytes,
    "reference_inventory_ledger.json": refChanges.length ? jsonBytes(inventory) : files.reference_inventory_ledger_sha256.bytes,
    "visual_reference_plan.json": jsonBytes(plan),
    "character_state_refs.json": jsonBytes(states),
  };
  const receipt = {
    schema: "goldflow_reference_plan_exact_repair_receipt_v1",
    status: "passed",
    episode: spec.episode,
    repair_id: repairId,
    reviewer: spec.reviewer,
    note: spec.note,
    spec_path: specPath ? path.resolve(specPath) : null,
    spec_sha256: hash(specBytes),
    source_hashes: Object.fromEntries(Object.entries(files).map(([key, entry]) => [path.basename(entry.path), entry.sha256])),
    output_hashes: Object.fromEntries(Object.entries(output).map(([name, bytes]) => [name, hash(bytes)])),
    before_snapshots: Object.fromEntries(Object.values(files).map((entry) => [path.basename(entry.path), path.join(receiptDir, "before", path.basename(entry.path))])),
    beat_changes: beatChanges,
    reference_changes: refChanges,
    state_ref_changes: stateChanges,
    grouping_lock_sha256: priorGrouping,
    provider_calls: 0,
    estimated_cost_usd: 0,
    updated_at: updatedAt,
  };
  const receiptPath = path.join(receiptDir, "receipt.json");
  const receiptBytes = jsonBytes(receipt);
  if (beatChanges.length) {
    beatApproval.visual_beat_plan_path = files.visual_beat_plan_sha256.path;
    beatApproval.visual_beat_plan_sha256 = newBeatHash;
    beatApproval.grouping_lock_sha256 = priorGrouping;
    beatApproval.approved_by = spec.reviewer;
    beatApproval.approval_note = spec.note;
    beatApproval.previous_visual_beat_plan_sha256 = files.visual_beat_plan_sha256.sha256;
    beatApproval.previous_visual_beat_approval_sha256 = files.visual_beat_approval_sha256.sha256;
    beatApproval.exact_repair_receipt_path = receiptPath;
    beatApproval.exact_repair_receipt_sha256 = hash(receiptBytes);
    beatApproval.updated_at = updatedAt;
    output["visual_beat_approval.json"] = jsonBytes(beatApproval);
  }
  await fs.mkdir(path.join(receiptDir, "before"), { recursive: true });
  for (const entry of Object.values(files)) {
    await fs.writeFile(path.join(receiptDir, "before", path.basename(entry.path)), entry.bytes, { flag: "wx" });
  }
  await fs.writeFile(path.join(receiptDir, "repair_spec.json"), specBytes, { flag: "wx" });
  await fs.writeFile(receiptPath, receiptBytes, { flag: "wx" });
  const writes = Object.entries(output).filter(([name, bytes]) => !bytes.equals(files[Object.keys(names).find((key) => names[key] === name)]?.bytes ?? Buffer.alloc(0)));
  const replaced = [];
  try {
    for (const [name, bytes] of writes) {
      const temp = path.join(episodeDir, `.${name}.${repairId}.tmp`);
      await fs.writeFile(temp, bytes, { flag: "wx" });
      await fs.rename(temp, path.join(episodeDir, name));
      replaced.push(name);
    }
  } catch (error) {
    for (const name of replaced.reverse()) {
      const before = Object.values(files).find((entry) => path.basename(entry.path) === name);
      if (before) await fs.writeFile(before.path, before.bytes);
    }
    await fs.writeFile(path.join(receiptDir, "failed.json"), jsonBytes({
      schema: "goldflow_reference_plan_exact_repair_failure_v1",
      receipt_path: receiptPath,
      restored_files: replaced,
      error: error instanceof Error ? error.message : String(error),
      failed_at: new Date().toISOString(),
    }), { flag: "wx" });
    throw error;
  }
  return { status: "passed", receipt_path: receiptPath, beat_count: beatChanges.length, reference_count: refChanges.length, state_ref_count: stateChanges.length, visual_reference_plan_sha256: newPlanHash };
}
