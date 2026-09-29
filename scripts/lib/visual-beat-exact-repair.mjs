import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { groupingLockHash } from "./editorial-beat-director.mjs";
import { CURRENT_VISUAL_BEAT_CONTRACT_VERSION } from "./visual-beat-contract.mjs";
import { locationDependentQualityFindings } from "./visual-beat-location-quality.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isHash = (value) => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keysOnly = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const unique = (values) => new Set(values).size === values.length;
const beatIds = (value) => String(value ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const text = (value, max = 700) => typeof value === "string" && value.trim() === value
  && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000e-\u001f]/u.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const timestamp = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
};

export function visualBeatExactRepairAdmission(status = {}, flags = {}) {
  const deny = (reason) => ({ allowed: false, reason });
  if (!keysOnly(flags, ["episode-dir", "repair-spec", "beat-ids"])) return deny("unsupported_repair_flag");
  if (!text(flags["episode-dir"], 4096) || !text(flags["repair-spec"], 4096)) return deny("episode_dir_and_repair_spec_required");
  if (path.resolve(flags["episode-dir"]) !== path.resolve(String(status.episode_dir ?? ""))) return deny("episode_dir_status_mismatch");
  const ids = beatIds(flags["beat-ids"]);
  if (!ids.length || ids.length > 32 || !unique(ids) || ids.some((id) => !/^beat_w\d{6}_w\d{6}$/.test(id))) {
    return deny("exact_unique_beat_ids_required");
  }
  if (status.identity?.schema !== "goldflow_run_identity_v2"
    || status.media_workflow?.id !== "generated_visuals_v1") return deny("unsupported_run_identity_or_workflow");
  if (status.current_stage !== "visual_reference_plan" || status.current_stage_state !== "missing") {
    return deny("repair_only_before_reference_planning");
  }
  const rows = status.stage_ledger;
  const beatIndex = rows?.findIndex((row) => row.stage === "visual_beat_plan") ?? -1;
  if (beatIndex < 0 || rows[beatIndex]?.state !== "passed"
    || rows[beatIndex + 1]?.stage !== "visual_reference_plan"
    || rows[beatIndex + 1]?.state !== "missing") return deny("approved_beat_plan_and_missing_reference_stage_required");
  // Later rows can be derived stale/blocked before any work begins. The
  // execution-event and artifact guards below decide whether a downstream
  // stage actually started; status alone does not prove it did.
  if (rows.slice(beatIndex + 2).some((row) => ["passed", "running", "failed"].includes(row.state))) {
    return deny("downstream_stage_already_started");
  }
  return { allowed: true, reason: "exact_approved_beat_repair_before_references", beat_ids: ids };
}

function assertSpec(spec, ids) {
  if (!keysOnly(spec, ["schema", "status", "episode_dir", "run_identity_sha256",
    "source_script_sha256", "base_visual_beat_plan_sha256", "base_visual_beat_approval_sha256",
    "grouping_lock_sha256", "approved_by", "review_note", "repairs"])
    || spec.schema !== "goldflow_visual_beat_exact_repair_v1" || spec.status !== "approved"
    || !text(spec.episode_dir, 4096) || !text(spec.approved_by, 120) || !text(spec.review_note, 1500)
    || !["run_identity_sha256", "source_script_sha256", "base_visual_beat_plan_sha256",
      "base_visual_beat_approval_sha256", "grouping_lock_sha256"].every((key) => isHash(spec[key]))
    || !Array.isArray(spec.repairs) || spec.repairs.length !== ids.length) {
    throw new Error("Exact beat repair spec is incomplete or contains unsupported fields.");
  }
  const specIds = spec.repairs.map((repair) => repair?.visual_beat_id);
  if (!same(specIds, ids)) throw new Error("Repair spec beat IDs must exactly match ordered --beat-ids.");
  for (const repair of spec.repairs) {
    if (!keysOnly(repair, ["visual_beat_id", "source_atom_ids", "evidence_note", "location", "focus", "continuity_note", "visibility"])
      || !Array.isArray(repair.source_atom_ids) || !repair.source_atom_ids.length
      || !unique(repair.source_atom_ids) || repair.source_atom_ids.some((id) => !/^atom_w\d{6}_w\d{6}$/.test(id))
      || !text(repair.evidence_note, 1500)
      || !["location", "focus", "continuity_note", "visibility"].some((key) => own(repair, key))) {
      throw new Error(`Invalid exact beat repair: ${repair?.visual_beat_id ?? "missing ID"}.`);
    }
    if (own(repair, "location") && (!keysOnly(repair.location, ["before_location_id", "before_location", "to_location_id", "to_location"])
      || !own(repair.location, "before_location_id") || !own(repair.location, "before_location")
      || !own(repair.location, "to_location_id") || !text(repair.location.to_location, 300)
      || !(repair.location.to_location_id === null || /^[a-z][a-z0-9_]*$/.test(repair.location.to_location_id)))) {
      throw new Error(`Invalid location correction: ${repair.visual_beat_id}.`);
    }
    for (const field of ["focus", "continuity_note"]) {
      if (own(repair, field) && (!keysOnly(repair[field], ["before", "to"])
        || !own(repair[field], "before") || !text(repair[field].to, 700))) {
        throw new Error(`Invalid ${field} correction: ${repair.visual_beat_id}.`);
      }
    }
    if (own(repair, "visibility") && (!keysOnly(repair.visibility, ["entity_id", "from", "to"])
      || !/^[a-z][a-z0-9_]*$/.test(repair.visibility.entity_id)
      || repair.visibility.from !== "preview" || repair.visibility.to !== "physical")) {
      throw new Error(`Invalid visibility correction: ${repair.visual_beat_id}.`);
    }
  }
}

function validateSources(plan, episodeDir, scriptHash) {
  const sources = plan.source_hashes;
  if (!object(sources)) throw new Error("Beat plan source hash map missing.");
  const expected = ["script_clean.md", "story_fact_ledger.json", "timed_scene_plan.json",
    `narration_word_timing_${plan.episode}.json`];
  for (const name of expected) {
    if (!isHash(sources[path.join(episodeDir, name)])) throw new Error(`Beat plan source binding missing: ${name}.`);
  }
  if (sources[path.join(episodeDir, "script_clean.md")] !== scriptHash || plan.source_script_hash !== scriptHash) {
    throw new Error("Beat plan source script hash changed.");
  }
  return sources;
}

function locationTimeline(beats) {
  return beats.filter((beat, index) => beat.location && (index === 0 || beat.location !== beats[index - 1]?.location))
    .map((beat) => ({
      start_sec: beat.start_sec,
      timestamp: timestamp(beat.start_sec),
      location: beat.location,
      scene_id: beat.parent_scene_id ?? beat.scene_id,
      visual_beat_id: beat.visual_beat_id,
      excerpt: beat.visual_beat_script_excerpt,
    }));
}

export function repairVisualBeatPlan(plan, spec, factLedger) {
  const output = structuredClone(plan);
  const byId = new Map(output.beats.map((beat) => [beat.visual_beat_id, beat]));
  if (byId.size !== output.beats.length) throw new Error("Beat plan contains duplicate visual beat IDs.");
  const canonicalLocations = new Set((factLedger.canonical_locations ?? factLedger.locations ?? [])
    .map((row) => row.location_id).filter(Boolean));
  const changes = [];
  for (const repair of spec.repairs) {
    const beat = byId.get(repair.visual_beat_id);
    if (!beat || !same(beat.source_atom_ids, repair.source_atom_ids)) {
      throw new Error(`Exact beat ID or source atoms changed: ${repair.visual_beat_id}.`);
    }
    if (own(repair, "location")) {
      const item = repair.location;
      const beforeTimelineLabel = `${timestamp(beat.start_sec)} ${item.before_location}`;
      if (beat.location_id !== item.before_location_id || beat.location !== item.before_location
        || beat.local_location !== item.before_location
        || beat.location_timeline_label !== beforeTimelineLabel
        || (own(beat, "active_state_constraints") && beat.active_state_constraints?.location_id !== item.before_location_id)) {
        throw new Error(`Location before-value changed: ${repair.visual_beat_id}.`);
      }
      if (item.to_location_id !== null && !canonicalLocations.has(item.to_location_id)) {
        throw new Error(`Location ID is absent from current story facts: ${item.to_location_id}.`);
      }
      if (item.to_location_id === item.before_location_id && item.to_location === item.before_location) {
        throw new Error(`Location correction is a no-op: ${repair.visual_beat_id}.`);
      }
      const before = { location_id: beat.location_id, location: beat.location,
        local_location: beat.local_location, active_state_location_id: beat.active_state_constraints?.location_id ?? null,
        location_timeline_label: beat.location_timeline_label,
        ref_needs: structuredClone(beat.ref_needs ?? null),
        beat_ref_requirements: structuredClone(beat.beat_ref_requirements ?? null),
        location_provenance: beat.location_provenance ?? null };
      if (!Array.isArray(beat.ref_needs) || !Array.isArray(beat.beat_ref_requirements)
        || !same(beat.ref_needs, beat.beat_ref_requirements)) {
        throw new Error(`Location ref-needs mirrors are inconsistent: ${repair.visual_beat_id}.`);
      }
      const staleLocationNeed = (need) => need?.kind === "location"
        && (need.subject === item.before_location || need.ref_id === item.before_location_id);
      beat.location_id = item.to_location_id;
      beat.location = item.to_location;
      beat.local_location = item.to_location;
      beat.location_timeline_label = `${timestamp(beat.start_sec)} ${item.to_location}`;
      beat.ref_needs = beat.ref_needs.filter((need) => !staleLocationNeed(need));
      beat.beat_ref_requirements = beat.beat_ref_requirements.filter((need) => !staleLocationNeed(need));
      if (own(beat, "active_state_constraints")) beat.active_state_constraints.location_id = item.to_location_id;
      // A source-scene inference from the old location must not survive a reviewed correction.
      delete beat.location_provenance;
      changes.push({ visual_beat_id: repair.visual_beat_id, field: "location", before,
        after: { location_id: beat.location_id, location: beat.location,
          local_location: beat.local_location, active_state_location_id: beat.active_state_constraints?.location_id ?? null,
          location_timeline_label: beat.location_timeline_label,
          ref_needs: structuredClone(beat.ref_needs),
          beat_ref_requirements: structuredClone(beat.beat_ref_requirements),
          location_provenance: null } });
    }
    if (own(repair, "focus")) {
      if (beat.visual_beat_focus !== repair.focus.before || beat.visual_novelty_directive !== repair.focus.before) {
        throw new Error(`Focus before-value changed: ${repair.visual_beat_id}.`);
      }
      if (repair.focus.before === repair.focus.to) throw new Error(`Focus correction is a no-op: ${repair.visual_beat_id}.`);
      beat.visual_beat_focus = repair.focus.to;
      beat.visual_novelty_directive = repair.focus.to;
      changes.push({ visual_beat_id: repair.visual_beat_id, field: "focus", before: repair.focus.before, after: repair.focus.to });
    }
    if (own(repair, "continuity_note")) {
      if (beat.local_continuity_note !== repair.continuity_note.before) {
        throw new Error(`Continuity before-value changed: ${repair.visual_beat_id}.`);
      }
      if (repair.continuity_note.before === repair.continuity_note.to) {
        throw new Error(`Continuity correction is a no-op: ${repair.visual_beat_id}.`);
      }
      beat.local_continuity_note = repair.continuity_note.to;
      changes.push({ visual_beat_id: repair.visual_beat_id, field: "continuity_note",
        before: repair.continuity_note.before, after: repair.continuity_note.to });
    }
    if (own(repair, "visibility")) {
      const id = repair.visibility.entity_id;
      const entity = (beat.visible_entities ?? []).find((row) => row.entity_id === id);
      const name = entity?.display_name;
      if (!name || !Array.isArray(beat.preview_visible_entity_ids)
        || !beat.preview_visible_entity_ids.includes(id)
        || !Array.isArray(beat.preview_visible_characters)
        || !beat.preview_visible_characters.includes(name)
        || !Array.isArray(beat.physically_visible_entity_ids)
        || beat.physically_visible_entity_ids.includes(id)
        || beat.screen_visible_entity_ids?.includes(id)) {
        throw new Error(`Visibility before-value changed: ${repair.visual_beat_id}.`);
      }
      beat.preview_visible_entity_ids = beat.preview_visible_entity_ids.filter((value) => value !== id);
      beat.preview_visible_characters = beat.preview_visible_characters.filter((value) => value !== name);
      beat.physically_visible_entity_ids.push(id);
      changes.push({ visual_beat_id: repair.visual_beat_id, field: "visibility",
        entity_id: id, display_name: name, before: "preview", after: "physical" });
    }
  }
  output.location_timeline = locationTimeline(output.beats);
  if (spec.repairs.some((repair) => own(repair, "location"))) {
    const locationCodes = new Set(["location_mention_not_in_beat_location",
      "repeated_location_visual_job_run", "long_same_location_beat_span"]);
    const beforeQuality = output.visual_beat_quality_findings ?? [];
    const nonLocationQuality = beforeQuality.filter((finding) => !locationCodes.has(finding.code));
    const retentionRampSec = Number(output.beat_settings?.retention_ramp_sec);
    if (!Number.isFinite(retentionRampSec) || retentionRampSec <= 0) {
      throw new Error("Beat plan lacks current retention ramp for location quality recomputation.");
    }
    const recomputed = locationDependentQualityFindings(output.beats, retentionRampSec);
    output.visual_beat_quality_findings = [...nonLocationQuality, ...recomputed];
    output.visual_beat_quality_summary = {
      finding_count: output.visual_beat_quality_findings.length,
      warning_count: output.visual_beat_quality_findings.filter((finding) => finding.severity === "warning").length,
      blocker_count: output.visual_beat_quality_findings.filter((finding) => finding.severity === "blocker").length,
      codes: Object.fromEntries([...new Set(output.visual_beat_quality_findings.map((finding) => finding.code))]
        .map((code) => [code, output.visual_beat_quality_findings.filter((finding) => finding.code === code).length])),
    };
    const byBeat = new Map();
    for (const finding of output.visual_beat_quality_findings) {
      const id = finding.visual_beat_id ?? finding.first_visual_beat_id ?? null;
      if (!id) continue;
      const rows = byBeat.get(id) ?? [];
      rows.push(finding);
      byBeat.set(id, rows);
    }
    for (const beat of output.beats) beat.visual_beat_quality_findings = byBeat.get(beat.visual_beat_id) ?? [];
    changes.push({ field: "location_quality_findings", scope: "derived_plan_diagnostics",
      before: beforeQuality, after: output.visual_beat_quality_findings });
  }
  output.updated_at = new Date().toISOString();
  const lock = groupingLockHash(output.beats);
  if (lock !== spec.grouping_lock_sha256 || lock !== plan.editorial_director?.grouping_lock_sha256) {
    throw new Error("Exact beat repair changed locked grouping.");
  }
  return { plan: output, changes };
}

export async function applyVisualBeatExactRepair({ episodeDir, specPath, beatIds: requestedIds, status }) {
  episodeDir = path.resolve(episodeDir);
  const flags = { "episode-dir": episodeDir, "repair-spec": specPath, "beat-ids": requestedIds.join(",") };
  const admission = visualBeatExactRepairAdmission(status, flags);
  if (!admission.allowed) throw new Error(`Workflow guard blocked exact beat repair: ${admission.reason}.`);
  const lockPath = path.join(episodeDir, ".visual_beat_exact_repair.lock");
  const lock = await fs.open(lockPath, "wx").catch((error) => {
    if (error.code === "EEXIST") throw new Error("Another exact visual beat repair is in progress or needs triage.");
    throw error;
  });
  try {
    const planPath = path.join(episodeDir, "visual_beat_plan.json");
    const approvalPath = path.join(episodeDir, "visual_beat_approval.json");
    const identityPath = path.join(episodeDir, "run_identity.json");
    const scriptPath = path.join(episodeDir, "script_clean.md");
    const factPath = path.join(episodeDir, "story_fact_ledger.json");
    const [specBytes, planBytes, approvalBytes, identityBytes, scriptBytes, factBytes, eventsBytes] = await Promise.all([
      fs.readFile(specPath), fs.readFile(planPath), fs.readFile(approvalPath), fs.readFile(identityPath),
      fs.readFile(scriptPath), fs.readFile(factPath),
      fs.readFile(path.join(episodeDir, "execution_events.jsonl")).catch((error) => error.code === "ENOENT" ? Buffer.alloc(0) : Promise.reject(error)),
    ]);
    const spec = JSON.parse(specBytes);
    const plan = JSON.parse(planBytes);
    const approval = JSON.parse(approvalBytes);
    const identity = JSON.parse(identityBytes);
    const factLedger = JSON.parse(factBytes);
    assertSpec(spec, requestedIds);
    if (path.resolve(spec.episode_dir) !== episodeDir || sha256(identityBytes) !== spec.run_identity_sha256
      || sha256(scriptBytes) !== spec.source_script_sha256
      || sha256(planBytes) !== spec.base_visual_beat_plan_sha256
      || sha256(approvalBytes) !== spec.base_visual_beat_approval_sha256) {
      throw new Error("Repair spec is stale against episode, identity, script, beat plan, or approval.");
    }
    if (identity.schema !== "goldflow_run_identity_v2"
      || ["channel", "week", "episode"].some((key) => identity[key] !== plan[key])
      || plan.series_slug !== (identity.series_slug ?? identity.series)
      || plan.schema !== "goldflow_visual_beat_plan_v2" || plan.status !== "passed"
      || (plan.visual_beat_contract_version ?? plan.planner_contract_version) !== CURRENT_VISUAL_BEAT_CONTRACT_VERSION
      || !Array.isArray(plan.beats) || !plan.beats.length
      || plan.editorial_director?.grouping_lock_sha256 !== spec.grouping_lock_sha256
      || groupingLockHash(plan.beats) !== spec.grouping_lock_sha256
      || approval.schema !== "goldflow_visual_beat_approval_v1" || approval.status !== "approved"
      || approval.approval_kind !== "grouping_lock"
      || approval.visual_beat_plan_sha256 !== sha256(planBytes)
      || approval.grouping_lock_sha256 !== spec.grouping_lock_sha256
      || path.resolve(approval.visual_beat_plan_path ?? "") !== planPath) {
      throw new Error("Approved visual beat plan, identity, or grouping lock is inconsistent.");
    }
    const sources = validateSources(plan, episodeDir, sha256(scriptBytes));
    for (const [file, expected] of Object.entries(sources)) {
      if (!isHash(expected) || sha256(await fs.readFile(file)) !== expected) {
        throw new Error(`Beat plan source artifact changed: ${file}.`);
      }
    }
    if (sha256(factBytes) !== sources[factPath]) throw new Error("Story fact ledger changed.");
    const afterBeatStage = status.stage_ledger.slice(status.stage_ledger.findIndex((row) => row.stage === "visual_reference_plan"));
    const downstream = new Set(afterBeatStage.map((row) => row.stage));
    for (const line of eventsBytes.toString("utf8").split("\n").filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.event_type === "stage_started" && downstream.has(event.stage)) {
        throw new Error(`Downstream stage already started: ${event.stage}.`);
      }
    }
    for (const name of ["reference_inventory_ledger.json", "visual_reference_plan.json", "reference_plan_approval.json"] ) {
      if (await fs.stat(path.join(episodeDir, name)).catch(() => null)) throw new Error(`Downstream artifact already exists: ${name}.`);
    }
    const { plan: repairedPlan, changes } = repairVisualBeatPlan(plan, spec, factLedger);
    const repairedPlanBytes = jsonBytes(repairedPlan);
    const now = new Date().toISOString();
    const repairId = `${now.replace(/[:.]/g, "-")}-${randomUUID()}`;
    const historyRoot = path.join(episodeDir, "reports", "stages", "visual_beat_plan", "exact_repairs");
    const historyDir = path.join(historyRoot, repairId);
    await fs.mkdir(historyRoot, { recursive: true });
    await fs.mkdir(historyDir, { recursive: false });
    const receipt = {
      schema: "goldflow_visual_beat_exact_repair_receipt_v1",
      status: "approved",
      repair_id: repairId,
      episode_dir: episodeDir,
      run_identity_sha256: sha256(identityBytes),
      source_script_sha256: sha256(scriptBytes),
      repair_spec_sha256: sha256(specBytes),
      previous_visual_beat_plan_sha256: sha256(planBytes),
      previous_visual_beat_approval_sha256: sha256(approvalBytes),
      repaired_visual_beat_plan_sha256: sha256(repairedPlanBytes),
      grouping_lock_sha256: spec.grouping_lock_sha256,
      visual_beat_ids: requestedIds,
      changes,
      approved_by: spec.approved_by,
      review_note: spec.review_note,
      provider_cost_usd: 0,
      created_at: now,
    };
    const receiptBytes = jsonBytes(receipt);
    const receiptPath = path.join(historyDir, "receipt.json");
    const repairedApproval = { ...approval,
      visual_beat_plan_sha256: sha256(repairedPlanBytes),
      approved_by: spec.approved_by,
      approval_note: spec.review_note,
      exact_repair_receipt_path: receiptPath,
      exact_repair_receipt_sha256: sha256(receiptBytes),
      previous_visual_beat_plan_sha256: sha256(planBytes),
      previous_visual_beat_approval_sha256: sha256(approvalBytes),
      updated_at: now,
    };
    const repairedApprovalBytes = jsonBytes(repairedApproval);
    await Promise.all([
      fs.writeFile(path.join(historyDir, "before_plan.json"), planBytes, { flag: "wx" }),
      fs.writeFile(path.join(historyDir, "before_approval.json"), approvalBytes, { flag: "wx" }),
      fs.writeFile(path.join(historyDir, "repair_spec.json"), specBytes, { flag: "wx" }),
      fs.writeFile(receiptPath, receiptBytes, { flag: "wx" }),
      fs.writeFile(path.join(historyDir, "after_plan.json"), repairedPlanBytes, { flag: "wx" }),
      fs.writeFile(path.join(historyDir, "after_approval.json"), repairedApprovalBytes, { flag: "wx" }),
    ]);
    const planTemp = `${planPath}.${repairId}.tmp`;
    const approvalTemp = `${approvalPath}.${repairId}.tmp`;
    await fs.writeFile(planTemp, repairedPlanBytes, { flag: "wx" });
    await fs.writeFile(approvalTemp, repairedApprovalBytes, { flag: "wx" });
    // Recheck current files immediately before replacement. The lock protects this
    // command; these hashes also reject a different writer outside the command.
    if (sha256(await fs.readFile(planPath)) !== sha256(planBytes)
      || sha256(await fs.readFile(approvalPath)) !== sha256(approvalBytes)) {
      throw new Error("Approved beat files changed during repair; immutable history was retained for triage.");
    }
    await fs.rename(planTemp, planPath);
    try {
      await fs.rename(approvalTemp, approvalPath);
    } catch (error) {
      await fs.writeFile(planPath, planBytes);
      throw error;
    }
    return { status: "passed", repair_id: repairId, repaired_beat_ids: requestedIds,
      visual_beat_plan_sha256: sha256(repairedPlanBytes), visual_beat_approval_sha256: sha256(repairedApprovalBytes),
      grouping_lock_sha256: spec.grouping_lock_sha256, receipt_path: receiptPath, provider_cost_usd: 0 };
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}
