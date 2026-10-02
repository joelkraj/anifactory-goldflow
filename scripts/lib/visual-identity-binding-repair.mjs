import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hex = (value) => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const nonempty = (value) => typeof value === "string" && value.trim() === value && value.length > 0;
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => keys.includes(key));
const dependencies = {
  run_identity: "run_identity.json",
  script: "script_clean.md",
  beat_plan: "visual_beat_plan.json",
  beat_approval: "visual_beat_approval.json",
  reference_plan: "visual_reference_plan.json",
  reference_plan_approval: "reference_plan_approval.json",
  reference_image_approval: "visual_reference_approval_ep_01.json",
  base_prompt_plan: "section_image_prompts.json",
  reviewed_prompt_plan: "section_image_prompts_reviewed.json",
  harden_report: "visual_prompt_hardening_ep_01.json",
  manual_review: "visual_manual_agent_review_ep_01.json",
};
const imageStages = ["transition_edit_plan", "image_generation", "image_output_qa"];

export function identityBindingRepairAdmission(status, flags) {
  const deny = (reason) => ({ allowed: false, reason });
  if (!exactKeys(flags, ["episode-dir", "repair-spec"]) || !nonempty(flags?.["episode-dir"]) || !nonempty(flags?.["repair-spec"])) {
    return deny("episode_dir_and_reviewed_spec_required");
  }
  if (path.resolve(flags["episode-dir"]) !== path.resolve(String(status?.episode_dir ?? ""))) return deny("episode_status_mismatch");
  if (status?.identity?.schema !== "goldflow_run_identity_v2" || status?.media_workflow?.id !== "generated_visuals_v1") {
    return deny("unsupported_identity_or_workflow");
  }
  if (status.current_stage !== "visual_prompt_harden" || status.current_stage_state !== "blocked"
    || !/visual repair-identity-binding|manual agent review required/i.test(status.next_command_shape ?? "")) {
    return deny("manual_identity_harden_blocker_required");
  }
  if (imageStages.some((stage) => ["running", "passed", "failed"].includes(status.stage_ledger?.find((row) => row.stage === stage)?.state))) {
    return deny("transition_or_image_stage_started");
  }
  return { allowed: true, reason: "exact_reviewed_identity_binding" };
}

function selectedRequirement(target, binding, prior = null) {
  const faceOnly = target.identity_usage === "face_only";
  return {
    ref_id: target.ref_id,
    kind: "character_state",
    conditioning_asset_role: target.conditioning_asset_role ?? "identity_state",
    identity_subtype: "human",
    reference_priority: prior?.reference_priority ?? "readable_identity",
    required: true,
    slot_order: prior?.slot_order ?? binding.slot_order,
    slot_purpose: faceOnly ? `${binding.character} facial likeness only; current wardrobe from beat`
      : `${binding.character} identity and current wardrobe`,
    reason: binding.reason,
    identity_usage: faceOnly ? "face_only" : "full_identity",
  };
}

function reviewedTextPatch(before, patch, label) {
  if (!exactKeys(patch, ["before", "to"]) || !nonempty(patch.before) || !nonempty(patch.to)
    || before !== patch.before || patch.before === patch.to) throw new Error(`Exact ${label} correction does not match its reviewed text.`);
  return patch.to;
}

function exactPromptChanges(before, changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 3) throw new Error("One to three exact prompt spans required.");
  let after = before;
  for (const change of changes) {
    if (!exactKeys(change, ["before", "to"]) || !nonempty(change.before) || !nonempty(change.to)
      || after.split(change.before).length !== 2) throw new Error("Temporal prompt span is missing or ambiguous.");
    after = after.replace(change.before, change.to);
  }
  return after;
}

export function bindVisibleIdentity(row, binding, target) {
  if (row.image_id !== binding.image_id || row.visual_beat_id !== binding.visual_beat_id
    || !row.shot_manifest?.visible_characters?.includes(binding.character)
    || !row.shot_manifest?.character_staging?.some((item) => item.name === binding.character)
    || !Array.isArray(row.reference_requirements) || !Array.isArray(row.shot_manifest.reference_slots)
    || row.reference_requirements.length !== row.shot_manifest.reference_slots.length
    || row.reference_requirements.length >= 4 && !binding.replace_ref_id
    || (row.shot_manifest.forbidden_ref_ids?.includes(binding.ref_id) && binding.remove_forbidden_ref_id !== binding.ref_id)
    || row.provider_prompt !== row.image_prompt) {
    throw new Error(`Exact visible identity context does not match ${binding.image_id}.`);
  }
  const next = structuredClone(row);
  if (binding.remove_forbidden_ref_id) {
    if (binding.remove_forbidden_ref_id !== binding.ref_id || !binding.replace_ref_id
      || !(target.identity_usage === "face_only" || (target.identity_usage === "full_identity" && binding.temporal_correction))
      || !next.shot_manifest.forbidden_ref_ids?.includes(binding.ref_id)) {
      throw new Error("Only an exact superseded state-reference prohibition may be removed.");
    }
    next.shot_manifest.forbidden_ref_ids = next.shot_manifest.forbidden_ref_ids.filter((id) => id !== binding.ref_id);
  }
  const oldRef = binding.replace_ref_id;
  const matching = next.reference_requirements.filter((req) => req.ref_id === oldRef);
  if (oldRef ? matching.length !== 1 : next.reference_requirements.some((req) => req.ref_id === binding.ref_id)) {
    throw new Error(`Expected one old identity slot, or an unbound new identity, for ${binding.image_id}.`);
  }
  if (next.reference_requirements.some((req) => req.ref_id === binding.ref_id)) throw new Error("Selected identity is already attached.");
  const prior = oldRef ? matching[0] : null;
  const selected = selectedRequirement(target, binding, prior);
  if (!Number.isInteger(selected.slot_order) || selected.slot_order < 1 || selected.slot_order > 4) throw new Error("One valid provider slot is required.");
  if (oldRef) next.reference_requirements = next.reference_requirements.map((req) => req.ref_id === oldRef ? selected : req);
  else next.reference_requirements.push(selected);
  next.reference_requirements.sort((a, b) => a.slot_order - b.slot_order);
  if (next.reference_requirements.length > 4 || new Set(next.reference_requirements.map((req) => req.slot_order)).size !== next.reference_requirements.length) {
    throw new Error("Identity binding exceeds or duplicates the four provider reference slots.");
  }
  next.shot_manifest.reference_slots = next.reference_requirements.map((req) => ({ ...req }));
  const oldStagingRef = next.shot_manifest.character_staging.find((item) => item.name === binding.character).ref_id;
  if (oldRef && oldStagingRef !== oldRef) throw new Error("Old staging reference differs from reviewed slot.");
  if (!oldRef && oldStagingRef && oldStagingRef !== binding.stale_staging_ref_id) {
    throw new Error("Unreviewed staging reference would be replaced.");
  }
  const staging = next.shot_manifest.character_staging.find((item) => item.name === binding.character);
  staging.ref_id = binding.ref_id;
  staging.wardrobe_from = binding.wardrobe_from;
  const replaceIds = new Set([oldRef, binding.stale_staging_ref_id].filter(Boolean));
  next.shot_manifest.character_state_ref_ids = [...new Set([
    ...next.shot_manifest.character_state_ref_ids.filter((id) => !replaceIds.has(id)), binding.ref_id,
  ])];
  if (replaceIds.has(next.shot_manifest.protagonist_state_ref_id) ||
    (next.shot_manifest.protagonist_state_ref_id == null && binding.character === "Joey")) {
    next.shot_manifest.protagonist_state_ref_id = binding.ref_id;
  }
  for (const anatomy of next.shot_manifest.anatomy_contracts ?? []) {
    if (anatomy.entity === binding.character && (anatomy.identity_ref_id == null || replaceIds.has(anatomy.identity_ref_id))) {
      anatomy.identity_ref_id = binding.ref_id;
    }
  }
  next.character_state_refs_used = next.reference_requirements.filter((req) => req.kind === "character_state").map((req) => req.ref_id);
  next.reference_usage = next.reference_requirements.map((req) => ({ ref_id: req.ref_id,
    usage: "attach_existing_ref", reason: req.reason }));
  next.anchor_roles = next.reference_requirements.map((req) => ({ ref_id: req.ref_id,
    kind: req.kind, anchor_role: "source_anchor", reason: req.reason }));
  if (next.reference_requirements.some((req) => replaceIds.has(req.ref_id))
    || next.character_state_refs_used.some((id) => replaceIds.has(id))
    || next.shot_manifest.character_state_ref_ids.some((id) => replaceIds.has(id))) {
    throw new Error("Outdated identity remains in active reference attachments.");
  }
  if (binding.temporal_correction) {
    const repair = binding.temporal_correction;
    if (!exactKeys(repair, ["prompt_changes", "replacement_prompt", "continuity_notes", "body_invariant"])
      || !nonempty(repair.replacement_prompt) || repair.replacement_prompt.length > 12000
      || repair.replacement_prompt !== exactPromptChanges(row.provider_prompt, repair.prompt_changes)
      || !repair.continuity_notes) throw new Error("Temporal prompt correction must be exact and fully reviewed.");
    next.provider_prompt = repair.replacement_prompt;
    next.image_prompt = repair.replacement_prompt;
    next.prompt_hash = hash(repair.replacement_prompt);
    next.shot_manifest.continuity_notes = reviewedTextPatch(row.shot_manifest.continuity_notes,
      repair.continuity_notes, "continuity notes");
    if (repair.body_invariant) {
      const anatomy = next.shot_manifest.anatomy_contracts?.filter((item) => item.entity === binding.character);
      if (anatomy?.length !== 1) throw new Error("One exact character anatomy contract required.");
      anatomy[0].body_invariant = reviewedTextPatch(anatomy[0].body_invariant, repair.body_invariant, "anatomy invariant");
    }
    const currentText = JSON.stringify({ prompt: next.provider_prompt, notes: next.shot_manifest.continuity_notes,
      staging: next.shot_manifest.character_staging.find((item) => item.name === binding.character),
      anatomy: next.shot_manifest.anatomy_contracts?.filter((item) => item.entity === binding.character),
      requirements: next.reference_requirements });
    if (/heat.cut shoulder|small wound|bleeding side cut|wounded coat|existing wounds/i.test(currentText)) {
      throw new Error("Future wound remains in pre-event cut.");
    }
  } else if (next.provider_prompt !== row.provider_prompt || next.prompt_hash !== row.prompt_hash) {
    throw new Error("Identity binding cannot alter approved prompt text.");
  }
  if (next.visual_beat_script_excerpt !== row.visual_beat_script_excerpt) {
    throw new Error("Identity binding cannot alter approved source or image prompt text.");
  }
  return next;
}

function immutableEditorialFields(row) {
  const stable = structuredClone(row);
  for (const key of ["provider_prompt", "image_prompt", "prompt_hash", "reference_requirements",
    "reference_usage", "anchor_roles", "character_state_refs_used", "visible_subjects", "primary_subject", "location"]) {
    delete stable[key];
  }
  for (const key of ["visible_characters", "mentioned_only_characters", "primary_character", "character_state_ref_ids",
    "protagonist_state_ref_id", "location_contract_id", "location_ref_id", "foreground_action", "anatomy_contracts",
    "equipment_contracts", "background_population", "visible_props", "forbidden_ref_ids", "reference_slots",
    "continuity_notes", "character_staging"]) {
    delete stable.shot_manifest[key];
  }
  return stable;
}

export async function validateEditorialReplacement(old, repair, refs, refApproval, refPlanApproval) {
  if (!exactKeys(repair, ["image_id", "visual_beat_id", "old_row_sha256", "source_quote", "reason",
    "text_changes", "manual_full_prompt_reviewed", "replacement_row"])
    || !nonempty(repair.image_id) || !nonempty(repair.visual_beat_id) || !hex(repair.old_row_sha256)
    || !nonempty(repair.source_quote) || !nonempty(repair.reason)
    || !repair.replacement_row || typeof repair.replacement_row !== "object") {
    throw new Error("Exact editorial correction needs reviewed source, old row, and complete replacement row.");
  }
  const next = repair.replacement_row;
  if (old.image_id !== repair.image_id || old.visual_beat_id !== repair.visual_beat_id
    || next.image_id !== old.image_id || next.visual_beat_id !== old.visual_beat_id
    || hash(json(old)) !== repair.old_row_sha256 || !old.visual_beat_script_excerpt?.includes(repair.source_quote)
    || JSON.stringify(immutableEditorialFields(old)) !== JSON.stringify(immutableEditorialFields(next))
    || !nonempty(next.provider_prompt) || next.provider_prompt.length > 12000
    || next.provider_prompt !== next.image_prompt || next.prompt_hash !== hash(next.provider_prompt)
    || next.provider_prompt === old.provider_prompt) {
    throw new Error(`Reviewed editorial row altered immutable cut fields or lacked exact source: ${repair.image_id}.`);
  }
  if (repair.text_changes) {
    if (next.provider_prompt !== exactPromptChanges(old.provider_prompt, repair.text_changes)) {
      throw new Error("Editorial prompt changed beyond exact reviewed spans.");
    }
  } else if (repair.manual_full_prompt_reviewed !== true || old.depiction_mode !== "memory_or_flashback") {
    throw new Error("Full prompt replacement requires an explicitly reviewed memory cut.");
  }
  const requirements = next.reference_requirements ?? [];
  const slots = next.shot_manifest.reference_slots ?? [];
  if (!Array.isArray(requirements) || requirements.length > 4 || !Array.isArray(slots)
    || JSON.stringify(requirements.map((item) => [item.ref_id, item.slot_order]))
      !== JSON.stringify(slots.map((item) => [item.ref_id, item.slot_order]))
    || new Set(requirements.map((item) => item.ref_id)).size !== requirements.length
    || new Set(requirements.map((item) => item.slot_order)).size !== requirements.length
    || requirements.some((item) => next.shot_manifest.forbidden_ref_ids?.includes(item.ref_id))) {
    throw new Error("Editorial replacement references are over cap, duplicate, forbidden, or unsynchronized.");
  }
  for (const requirement of requirements) {
    const target = refs.reference_targets.find((item) => item.ref_id === requirement.ref_id);
    const decision = refApproval.reference_decisions.find((item) => item.ref_id === requirement.ref_id);
    if (!target || !decision || decision.status !== "approved_clean" || !target.scene_ids?.includes(old.scene_id)
      || !refPlanApproval.selected_targets?.some((item) => item.ref_id === requirement.ref_id && item.scene_ids?.includes(old.scene_id))
      || !hex(decision.reference_image_sha256) || refApproval.reference_hash_by_ref_id?.[requirement.ref_id] !== decision.reference_image_sha256
      || hash(await fs.readFile(decision.reference_image_path)) !== decision.reference_image_sha256) {
      throw new Error(`Editorial replacement uses an unapproved or out-of-scope reference: ${requirement.ref_id}.`);
    }
  }
  const selected = new Set(requirements.map((item) => item.ref_id));
  const selectedCharacters = requirements.filter((item) => item.kind === "character_state").map((item) => item.ref_id);
  if (next.shot_manifest.character_state_ref_ids?.some((id) => !selectedCharacters.includes(id))
    || (next.shot_manifest.protagonist_state_ref_id && !selectedCharacters.includes(next.shot_manifest.protagonist_state_ref_id))
    || (next.shot_manifest.location_ref_id && !selected.has(next.shot_manifest.location_ref_id))
    || next.shot_manifest.anatomy_contracts?.some((item) => item.identity_ref_id && !selected.has(item.identity_ref_id))
    || next.shot_manifest.character_staging?.some((item) => item.ref_id && !selected.has(item.ref_id))
    || next.shot_manifest.character_staging?.some((item) => !next.shot_manifest.visible_characters?.includes(item.name))
    || next.reference_usage?.some((item) => !selected.has(item.ref_id))
    || next.anchor_roles?.some((item) => !selected.has(item.ref_id))
    || next.character_state_refs_used?.some((id) => !selectedCharacters.includes(id))) {
    throw new Error("Editorial replacement leaves a dangling active identity or location reference.");
  }
  if (next.shot_manifest.visible_characters?.some((name) => !old.shot_manifest.visible_characters?.includes(name))
    || next.visible_subjects?.some((name) => !old.visible_subjects?.includes(name))) {
    throw new Error("Editorial replacement cannot invent visible characters.");
  }
  return next;
}

export async function repairIdentityBindings({ episodeDir, specPath, spec, status, now = new Date() }) {
  episodeDir = path.resolve(episodeDir);
  const admission = identityBindingRepairAdmission(status, { "episode-dir": episodeDir, "repair-spec": specPath });
  if (!admission.allowed) throw new Error(`Identity binding repair refused: ${admission.reason}.`);
  if (!exactKeys(spec, ["schema", "episode", "expected", "bindings", "continuity_scope", "temporal_scope", "editorial_repairs", "reviewer", "note"])
    || spec.schema !== "goldflow_visual_identity_binding_repair_v1" || spec.episode !== path.basename(episodeDir)
    || !nonempty(spec.reviewer) || !nonempty(spec.note) || !Array.isArray(spec.bindings) || !spec.bindings.length
    || !Array.isArray(spec.editorial_repairs) || spec.editorial_repairs.length > 50
    || !exactKeys(spec.expected, Object.keys(dependencies))
    || Object.keys(dependencies).some((key) => !hex(spec.expected[key]))) {
    throw new Error("Complete reviewed identity binding spec and current source hashes required.");
  }
  const files = {};
  for (const [key, name] of Object.entries(dependencies)) {
    const bytes = await fs.readFile(path.join(episodeDir, name));
    files[key] = { path: path.join(episodeDir, name), bytes, sha256: hash(bytes),
      value: name.endsWith(".json") ? JSON.parse(bytes) : bytes.toString("utf8") };
    if (files[key].sha256 !== spec.expected[key]) throw new Error(`${name} changed since review.`);
  }
  const values = Object.fromEntries(Object.entries(files).map(([key, item]) => [key, item.value]));
  const { beat_plan: beats, reference_plan: refs, reference_image_approval: refApproval,
    base_prompt_plan: base, reviewed_prompt_plan: reviewed, harden_report: harden, manual_review: manual } = values;
  if (beats.status !== "passed" || refs.status !== "passed" || base.status !== "passed"
    || reviewed.status !== "needs_manual_agent_review" || harden.status !== "blocked"
    || manual.status !== "needs_manual_agent_review" || values.beat_approval.status !== "approved"
    || values.reference_plan_approval.status !== "approved" || refApproval.status !== "approved"
    || refApproval.visual_reference_plan_hash !== files.reference_plan.sha256) {
    throw new Error("Current approved source and blocked reviewed-plan lineage required.");
  }
  const blockers = harden.findings.filter((item) => item.severity === "blocker" && item.resolved !== true);
  if (!blockers.length || blockers.length !== harden.unresolved_blocker_count
    || blockers.some((item) => item.code !== "required_source_identity_ambiguous")) {
    throw new Error("Only exact ambiguous visible-identity blockers may be repaired.");
  }
  const blockerIds = new Set(blockers.map((item) => item.image_id));
  const bindingIds = new Set(spec.bindings.map((item) => item.image_id));
  if (bindingIds.size !== spec.bindings.length || [...blockerIds].some((id) => !bindingIds.has(id))
    || manual.image_ids?.some((id) => !blockerIds.has(id))
    || manual.unresolved_blockers?.some((item) => item.code !== "required_source_identity_ambiguous")) {
    throw new Error("Every original ambiguous blocker and current manual blocker must be covered exactly.");
  }
  const scope = spec.continuity_scope;
  if (!exactKeys(scope, ["character", "canonical_subject_id", "old_ref_id", "new_ref_id", "active_wardrobe_phrase"])
    || !nonempty(scope.character) || !nonempty(scope.canonical_subject_id) || !nonempty(scope.old_ref_id)
    || !nonempty(scope.new_ref_id) || !nonempty(scope.active_wardrobe_phrase)) {
    throw new Error("Bounded persistent wardrobe continuity scope is required.");
  }
  const continuityRows = reviewed.prompts.filter((row) => row.shot_manifest?.visible_characters?.includes(scope.character)
    && row.reference_requirements?.some((req) => req.ref_id === scope.old_ref_id)
    && row.active_state_constraints?.entities?.[scope.canonical_subject_id]?.wardrobe === scope.active_wardrobe_phrase);
  const continuityIds = new Set(continuityRows.map((row) => row.image_id));
  const temporal = spec.temporal_scope;
  if (!exactKeys(temporal, ["character", "canonical_subject_id", "old_ref_id", "new_ref_id",
    "pre_event_wardrobe", "event_image_id", "event_source_phrase"])
    || !nonempty(temporal.character) || !nonempty(temporal.canonical_subject_id)
    || !nonempty(temporal.old_ref_id) || !nonempty(temporal.new_ref_id)
    || !nonempty(temporal.pre_event_wardrobe) || !nonempty(temporal.event_image_id)
    || !nonempty(temporal.event_source_phrase)) throw new Error("Exact source-timed injury boundary required.");
  const eventBeat = beats.beats.find((item) => item.image_id_hint === temporal.event_image_id);
  if (!eventBeat || !eventBeat.visual_beat_script_excerpt?.includes(temporal.event_source_phrase)) {
    throw new Error("Approved beat does not establish the claimed injury event.");
  }
  const temporalRows = reviewed.prompts.filter((row) => row.shot_manifest?.visible_characters?.includes(temporal.character)
    && row.reference_requirements?.some((req) => req.ref_id === temporal.old_ref_id)
    && row.active_state_constraints?.entities?.[temporal.canonical_subject_id]?.wardrobe === temporal.pre_event_wardrobe
    && row.start_sec < eventBeat.start_sec && /heat.cut shoulder|small wound|bleeding side cut/i.test(row.provider_prompt));
  const temporalIds = new Set(temporalRows.map((row) => row.image_id));
  if ([...continuityIds].some((id) => !bindingIds.has(id))
    || [...temporalIds].some((id) => !bindingIds.has(id))
    || spec.bindings.some((item) => !blockerIds.has(item.image_id)
      && !continuityIds.has(item.image_id) && !temporalIds.has(item.image_id))) {
    throw new Error("Reviewed bindings must cover exact active-state and temporal conflicts, with no other cuts.");
  }
  const events = await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8")
    .catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  if (events.split("\n").filter(Boolean).some((line) => imageStages.includes(JSON.parse(line).stage))) {
    throw new Error("Transition or image processing already started.");
  }
  const output = structuredClone(reviewed);
  const changed = [];
  for (const binding of spec.bindings) {
    if (!exactKeys(binding, ["image_id", "visual_beat_id", "character", "ref_id", "replace_ref_id",
      "stale_staging_ref_id", "remove_forbidden_ref_id", "slot_order", "old_row_sha256", "approved_reference_sha256", "wardrobe_from", "reason", "temporal_correction"])
      || !nonempty(binding.image_id) || !nonempty(binding.visual_beat_id) || !nonempty(binding.character)
      || !nonempty(binding.ref_id) || !nonempty(binding.reason) || !nonempty(binding.wardrobe_from)
      || !hex(binding.old_row_sha256) || !hex(binding.approved_reference_sha256)
      || !Number.isInteger(binding.slot_order) || binding.slot_order < 1 || binding.slot_order > 4) {
      throw new Error("Each exact identity binding needs a reviewed row, slot, and approved raster hash.");
    }
    const rowIndex = output.prompts.findIndex((row) => row.image_id === binding.image_id);
    const row = output.prompts[rowIndex];
    const baseRow = base.prompts.filter((item) => item.image_id === binding.image_id);
    const beat = beats.beats.find((item) => item.visual_beat_id === binding.visual_beat_id);
    const target = refs.reference_targets.find((item) => item.ref_id === binding.ref_id);
    const decision = refApproval.reference_decisions.find((item) => item.ref_id === binding.ref_id);
    const blocker = blockers.find((item) => item.image_id === binding.image_id);
    if (!row || baseRow.length !== 1 || !beat || !target || !decision
      || row.visual_beat_id !== binding.visual_beat_id || beat.image_id_hint !== binding.image_id
      || row.scene_id !== baseRow[0].scene_id || row.scene_id !== beat.scene_id
      || hash(json(row)) !== binding.old_row_sha256 || target.kind !== "character_state"
      || target.canonical_subject_id !== binding.character.toLowerCase()
      || !target.scene_ids?.includes(row.scene_id) || decision.status !== "approved_clean"
      || !values.reference_plan_approval.selected_targets?.some((item) => item.ref_id === binding.ref_id && item.scene_ids?.includes(row.scene_id))
      || decision.reference_image_sha256 !== binding.approved_reference_sha256
      || refApproval.reference_hash_by_ref_id?.[binding.ref_id] !== binding.approved_reference_sha256
      || blocker && (blocker.character !== binding.character || !blocker.available_ref_ids?.includes(binding.ref_id))) {
      throw new Error(`Current beat, approved scoped reference, or blocker does not match ${binding.image_id}.`);
    }
    const currentRaster = await fs.readFile(decision.reference_image_path);
    if (hash(currentRaster) !== binding.approved_reference_sha256) throw new Error(`Approved identity raster changed: ${binding.ref_id}.`);
    if (continuityIds.has(binding.image_id)) {
      const oldTarget = refs.reference_targets.find((item) => item.ref_id === scope.old_ref_id);
      if (binding.character !== scope.character || binding.ref_id !== scope.new_ref_id
        || binding.replace_ref_id !== scope.old_ref_id || target.identity_usage !== "face_only"
        || oldTarget?.identity_usage !== "full_identity"
        || oldTarget?.canonical_subject_id !== scope.canonical_subject_id
        || !/\b(?:cut|wound)\b/i.test(row.provider_prompt)
        || !/\bface.only\b/i.test(binding.wardrobe_from)) {
        throw new Error(`Visible injury and face-only replacement not proven for ${binding.image_id}.`);
      }
    } else if (temporalIds.has(binding.image_id)) {
      const oldTarget = refs.reference_targets.find((item) => item.ref_id === temporal.old_ref_id);
      if (binding.character !== temporal.character || binding.ref_id !== temporal.new_ref_id
        || binding.replace_ref_id !== temporal.old_ref_id || target.identity_usage !== "full_identity"
        || oldTarget?.canonical_subject_id !== temporal.canonical_subject_id
        || !binding.temporal_correction || !/bolt.torn sleeve/i.test(binding.wardrobe_from)) {
        throw new Error(`Pre-event state replacement not proven for ${binding.image_id}.`);
      }
    } else if (!blocker || binding.replace_ref_id || binding.temporal_correction) {
      throw new Error("Non-continuity binding must be an original unbound identity blocker.");
    }
    const corrected = bindVisibleIdentity(row, binding, target);
    output.prompts[rowIndex] = corrected;
    changed.push({ image_id: binding.image_id, visual_beat_id: binding.visual_beat_id,
      character: binding.character, ref_id: binding.ref_id, replaced_ref_id: binding.replace_ref_id,
      before_row_sha256: binding.old_row_sha256, after_row_sha256: hash(json(corrected)) });
  }
  const editorialIds = new Set(spec.editorial_repairs.map((item) => item.image_id));
  if (editorialIds.size !== spec.editorial_repairs.length || [...editorialIds].some((id) => bindingIds.has(id))) {
    throw new Error("Editorial corrections must be unique and separate from identity bindings.");
  }
  const editorialChanges = [];
  for (const repair of spec.editorial_repairs) {
    const rowIndex = output.prompts.findIndex((item) => item.image_id === repair.image_id);
    const old = output.prompts[rowIndex];
    const beat = beats.beats.find((item) => item.visual_beat_id === repair.visual_beat_id);
    if (!old || !beat || beat.image_id_hint !== repair.image_id || beat.scene_id !== old.scene_id) {
      throw new Error(`Editorial cut or approved beat missing: ${repair.image_id}.`);
    }
    const corrected = await validateEditorialReplacement(old, repair, refs, refApproval, values.reference_plan_approval);
    output.prompts[rowIndex] = corrected;
    editorialChanges.push({ image_id: repair.image_id, visual_beat_id: repair.visual_beat_id,
      before_row_sha256: repair.old_row_sha256, after_row_sha256: hash(json(corrected)),
      source_quote: repair.source_quote, reason: repair.reason });
  }
  output.status = "passed";
  delete output.visual_manual_agent_review_path;
  output.updated_at = now.toISOString();
  output.planner = { ...output.planner, exact_identity_binding_repairs: changed,
    exact_editorial_cut_repairs: editorialChanges };
  const bytes = json(output);
  const id = `${output.updated_at.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const receiptDir = path.join(episodeDir, "reports", "stages", "visual_prompt_blocker_repair", "exact_identity_binding", id);
  const receipt = { schema: "goldflow_visual_identity_binding_repair_receipt_v1", status: "passed",
    episode: spec.episode, reviewer: spec.reviewer, note: spec.note, bindings: changed,
    editorial_repairs: editorialChanges,
    source_hashes: Object.fromEntries(Object.entries(files).map(([key, item]) => [key, item.sha256])),
    spec_sha256: hash(await fs.readFile(specPath)), before_plan_sha256: files.reviewed_prompt_plan.sha256,
    after_plan_sha256: hash(bytes), before_snapshot_path: path.join(receiptDir, "before", "section_image_prompts_reviewed.json"),
    provider_calls: 0, image_submissions: 0, estimated_cost_usd: 0, updated_at: output.updated_at };
  await fs.mkdir(path.join(receiptDir, "before"), { recursive: true });
  await fs.writeFile(receipt.before_snapshot_path, files.reviewed_prompt_plan.bytes, { flag: "wx" });
  await fs.writeFile(path.join(receiptDir, "repair_spec.json"), await fs.readFile(specPath), { flag: "wx" });
  await fs.writeFile(path.join(receiptDir, "receipt.json"), json(receipt), { flag: "wx" });
  const temp = path.join(episodeDir, `.section_image_prompts_reviewed.${id}.tmp`);
  await fs.writeFile(temp, bytes, { flag: "wx" });
  try { await fs.rename(temp, files.reviewed_prompt_plan.path); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
  return { status: "passed", receipt_path: path.join(receiptDir, "receipt.json"),
    repaired_cut_count: changed.length + editorialChanges.length,
    identity_binding_count: changed.length, editorial_repair_count: editorialChanges.length,
    reviewed_prompt_plan_sha256: hash(bytes), provider_calls: 0 };
}
