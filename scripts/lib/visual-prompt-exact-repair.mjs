import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { allowedRefIdsForScene } from "./visual-scope-utils.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hashPattern = /^[a-f0-9]{64}$/;
const fileNames = {
  run_identity_sha256: "run_identity.json",
  source_script_sha256: "script_clean.md",
  visual_beat_plan_sha256: "visual_beat_plan.json",
  visual_reference_plan_sha256: "visual_reference_plan.json",
  reference_plan_approval_sha256: "reference_plan_approval.json",
  reference_image_approval_sha256: (episode) => `visual_reference_approval_${episode}.json`,
  prompt_plan_sha256: "section_image_prompts.json",
};
const only = (value, allowed) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => allowed.includes(key));
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const read = async (file) => { const bytes = await fs.readFile(file); return { bytes, sha256: sha256(bytes),
  value: path.extname(file) === ".json" ? JSON.parse(bytes) : bytes.toString("utf8") }; };

export function exactVisualPromptRepairAdmission(status, flags) {
  const deny = (reason) => ({ allowed: false, reason });
  if (!only(flags, ["episode-dir", "repair-spec"]) || !nonempty(flags["episode-dir"]) || !nonempty(flags["repair-spec"])) return deny("exact_episode_and_spec_required");
  if (path.resolve(flags["episode-dir"]) !== path.resolve(String(status?.episode_dir ?? ""))) return deny("episode_status_mismatch");
  if ((typeof status?.identity === "string" ? status.identity : status?.identity?.schema) !== "goldflow_run_identity_v2"
    || status?.media_workflow?.id !== "generated_visuals_v1") return deny("unsupported_identity_or_workflow");
  if (status.current_stage !== "visual_prompt_harden" || status.current_stage_state !== "missing") return deny("only_after_passed_prompt_plan_before_hardening");
  const plan = status.stage_ledger?.find((row) => row.stage === "visual_prompt_plan");
  if (plan?.state !== "passed") return deny("passed_prompt_plan_required");
  if (status.stage_ledger?.some((row) => ["visual_prompt_harden", "visual_prompt_blocker_repair", "transition_edit_plan", "image_generation"].includes(row.stage)
    && ["running", "passed", "failed"].includes(row.state))) return deny("downstream_stage_started");
  return { allowed: true, reason: "one_exact_pre_harden_prompt_repair" };
}

export function applyExactPromptText(row, replacement) {
  if (!only(replacement, ["provider_prompt", "image_prompt", "staging_patch", "staging_patches", "manifest_text_patch",
    "reference_text_patch", "anatomy_contract_patch", "anatomy_contract_patches", "equipment_contract_removal",
    "equipment_contract_text_patch", "visible_prop_removal", "visible_prop_removals", "location_reference_patch",
    "narrative_overlay_patch", "ui_element_patch", "ui_element_patches", "ui_element_source_quotes",
    "assert_absent_terms"]) || !nonempty(replacement.provider_prompt)
    || replacement.provider_prompt !== replacement.image_prompt || replacement.provider_prompt.length > 12000) {
    throw new Error("Replacement must contain the same nonempty provider_prompt and image_prompt, at most 12000 characters.");
  }
  if (replacement.provider_prompt === row.provider_prompt) throw new Error("Prompt correction is unchanged.");
  if (row.image_prompt !== row.provider_prompt || (row.modelslab_image_prompt && row.modelslab_image_prompt !== row.provider_prompt)
    || (row.codex_image_prompt && row.codex_image_prompt !== row.provider_prompt)) {
    throw new Error("This exact repair requires a single canonical prompt variant; use scoped review for diverging provider variants.");
  }
  return { ...row, provider_prompt: replacement.provider_prompt, image_prompt: replacement.image_prompt,
    prompt_hash: sha256(replacement.provider_prompt) };
}

function exactTextPatch(value, patch, label) {
  if (!only(patch, ["before", "to"]) || !nonempty(patch.to) || value !== patch.before || patch.before === patch.to) {
    throw new Error(`${label} does not match its reviewed before/to values.`);
  }
  return patch.to;
}

function patchRowStructures(row, replacement, { sourceScript, sourceBeat, referencePlan, referenceApproval } = {}) {
  const next = structuredClone(row);
  if (replacement.location_reference_patch !== undefined) {
    const patch = replacement.location_reference_patch;
    if (!only(patch, ["from_ref_id", "to_ref_id", "approved_reference_sha256", "source_quotes"])
      || !nonempty(patch.from_ref_id) || !nonempty(patch.to_ref_id)
      || patch.from_ref_id === patch.to_ref_id || !hashPattern.test(patch.approved_reference_sha256 ?? "")
      || !Array.isArray(patch.source_quotes) || !patch.source_quotes.length || patch.source_quotes.length > 3
      || new Set(patch.source_quotes).size !== patch.source_quotes.length
      || patch.source_quotes.some((quote) => !nonempty(quote) || quote.length < 16 || quote.length > 500
        || !sourceScript?.includes(quote))) {
      throw new Error("Location-reference correction requires exact old/new IDs, approved raster hash, and source quotes.");
    }
    if (next.shot_manifest?.location_ref_id !== patch.from_ref_id
      || next.shot_manifest?.location_contract_id !== sourceBeat?.location_id
      || !Array.isArray(next.required_reference_paths) || next.required_reference_paths.length) {
      throw new Error("Location-reference correction requires one matching beat contract and no untracked reference paths.");
    }
    const targets = referencePlan?.reference_targets ?? [];
    const oldTargets = targets.filter((item) => item.ref_id === patch.from_ref_id);
    const newTargets = targets.filter((item) => item.ref_id === patch.to_ref_id);
    const sharedSourceAssets = oldTargets.length === 1 && newTargets.length === 1
      ? oldTargets[0].evidence_asset_ids?.filter((id) => newTargets[0].evidence_asset_ids?.includes(id)) ?? [] : [];
    if (oldTargets.length !== 1 || newTargets.length !== 1
      || oldTargets[0].kind !== "location" || newTargets[0].kind !== "location"
      || !oldTargets[0].location_contract_ids?.includes(next.shot_manifest.location_contract_id)
      || (!newTargets[0].location_contract_ids?.includes(next.shot_manifest.location_contract_id) && !sharedSourceAssets.length)
      || !newTargets[0].planned_beat_ids?.includes(sourceBeat.visual_beat_id)
      || referenceApproval?.reference_hash_by_ref_id?.[patch.to_ref_id] !== patch.approved_reference_sha256) {
      throw new Error("Replacement location reference is not approved, beat-planned, or in the same location contract.");
    }
    if (JSON.stringify(next).includes(`\"${patch.to_ref_id}\"`)) {
      throw new Error("Replacement location reference is already attached to the cut.");
    }
    const groups = [next.reference_requirements, next.reference_usage, next.anchor_roles, next.shot_manifest.reference_slots];
    if (groups.some((items) => !Array.isArray(items) || items.filter((item) => item.ref_id === patch.from_ref_id).length !== 1)) {
      throw new Error("Old location reference must appear exactly once in every bound reference group.");
    }
    const requirement = next.reference_requirements.find((item) => item.ref_id === patch.from_ref_id);
    const slot = next.shot_manifest.reference_slots.find((item) => item.ref_id === patch.from_ref_id);
    if (requirement.kind !== "location" || slot.kind !== "location" || slot.conditioning_asset_role !== "environment") {
      throw new Error("Only the environment location slot may be replaced.");
    }
    for (const items of groups) items.find((item) => item.ref_id === patch.from_ref_id).ref_id = patch.to_ref_id;
    next.shot_manifest.location_ref_id = patch.to_ref_id;
    if (JSON.stringify(next).includes(`\"${patch.from_ref_id}\"`)) {
      throw new Error("Stale old location reference remains attached after correction.");
    }
  }
  if (replacement.narrative_overlay_patch !== undefined) {
    const patch = replacement.narrative_overlay_patch;
    if (!only(patch, ["index", "before", "old_overlay_sha256", "to", "information_delta", "source_quotes"])
      || !Number.isInteger(patch.index) || patch.index < 0
      || !Array.isArray(next.narrative_overlays) || patch.index >= next.narrative_overlays.length
      || !nonempty(patch.before) || !nonempty(patch.to) || patch.to.length > 160
      || !hashPattern.test(patch.old_overlay_sha256 ?? "")) {
      throw new Error("Narrative overlay patch requires one indexed, hash-bound current overlay and exact before/to text.");
    }
    const overlay = next.narrative_overlays[patch.index];
    if (overlay?.text !== patch.before || sha256(jsonBytes(overlay)) !== patch.old_overlay_sha256) {
      throw new Error("Reviewed narrative overlay text or hash is stale.");
    }
    if (!Array.isArray(patch.source_quotes) || !patch.source_quotes.length || patch.source_quotes.length > 4
      || patch.source_quotes.some((quote) => !nonempty(quote) || quote.length < 16 || quote.length > 500)
      || new Set(patch.source_quotes).size !== patch.source_quotes.length
      || patch.source_quotes.some((quote) => !sourceScript?.includes(quote))
      || !patch.source_quotes.some((quote) => sourceBeat?.visual_beat_script_excerpt?.includes(quote))) {
      throw new Error("Narrative overlay correction requires exact source quotes, including one in the selected beat.");
    }
    overlay.text = exactTextPatch(overlay.text, { before: patch.before, to: patch.to }, "narrative_overlays.text");
    if (patch.information_delta !== undefined) {
      overlay.information_delta = exactTextPatch(overlay.information_delta, patch.information_delta, "narrative_overlays.information_delta");
    }
    if (!replacement.provider_prompt?.includes(patch.to)) {
      throw new Error("Corrected provider prompt must include the exact new narrative overlay text.");
    }
  }
  if (replacement.ui_element_patch !== undefined && replacement.ui_element_patches !== undefined) {
    throw new Error("Use ui_element_patch or ui_element_patches, never both.");
  }
  const uiPatches = replacement.ui_element_patches ?? (replacement.ui_element_patch === undefined ? [] : [replacement.ui_element_patch]);
  if (!Array.isArray(uiPatches) || uiPatches.length > 4) {
    throw new Error("UI element patches must contain at most four exact indexed elements.");
  }
  if (uiPatches.length && replacement.narrative_overlay_patch === undefined) {
    const quotes = replacement.ui_element_source_quotes;
    if (!Array.isArray(quotes) || !quotes.length || quotes.length > 4
      || quotes.some((quote) => !nonempty(quote) || quote.length < 5 || quote.length > 500)
      || new Set(quotes).size !== quotes.length || quotes.some((quote) => !sourceScript?.includes(quote))
      || !quotes.some((quote) => sourceBeat?.visual_beat_script_excerpt?.includes(quote))) {
      throw new Error("UI-only correction requires exact source quotes, including one in the selected beat.");
    }
  } else if (replacement.ui_element_source_quotes !== undefined) {
    throw new Error("UI source quotes belong only to a UI-only correction; overlay repairs bind their own source quotes.");
  }
  const uiIndices = new Set();
  for (const patch of uiPatches) {
    if (!only(patch, ["index", "before", "to"]) || !Number.isInteger(patch.index) || patch.index < 0
      || uiIndices.has(patch.index) || !Array.isArray(next.shot_manifest?.ui_elements)
      || patch.index >= next.shot_manifest.ui_elements.length) {
      throw new Error("UI element patch requires one distinct exact indexed current element.");
    }
    uiIndices.add(patch.index);
    next.shot_manifest.ui_elements[patch.index] = exactTextPatch(
      next.shot_manifest.ui_elements[patch.index], { before: patch.before, to: patch.to }, "shot_manifest.ui_elements");
    if (Array.isArray(next.ui_text_on_screen)) {
      const mirrored = next.ui_text_on_screen
        .map((value, index) => ({ value, index })).filter(({ value }) => value === patch.before);
      if (mirrored.length > 1) throw new Error("Top-level UI text mirror is ambiguous for an exact patch.");
      if (mirrored.length === 1) next.ui_text_on_screen[mirrored[0].index] = patch.to;
    }
    if (!replacement.provider_prompt?.includes(patch.to)) {
      throw new Error("Corrected provider prompt must include the exact new UI element text.");
    }
  }
  if (replacement.visible_prop_removal !== undefined && replacement.visible_prop_removals !== undefined) {
    throw new Error("Use visible_prop_removal or visible_prop_removals, never both.");
  }
  const removedProps = replacement.visible_prop_removals ?? (replacement.visible_prop_removal === undefined ? [] : [replacement.visible_prop_removal]);
  if (!Array.isArray(removedProps) || removedProps.length > 3 || new Set(removedProps).size !== removedProps.length) {
    throw new Error("Visible prop removals require at most three distinct labels.");
  }
  for (const prop of removedProps) {
    if (!nonempty(prop) || !Array.isArray(next.shot_manifest?.visible_props)) {
      throw new Error("Visible prop removal requires one exact current prop label.");
    }
    const matches = next.shot_manifest.visible_props
      .map((value, index) => ({ value, index })).filter(({ value }) => value === prop);
    if (matches.length !== 1) throw new Error("Reviewed visible prop is missing or ambiguous.");
    next.shot_manifest.visible_props.splice(matches[0].index, 1);
  }
  if (replacement.equipment_contract_removal !== undefined) {
    const removal = replacement.equipment_contract_removal;
    if (!only(removal, ["owner", "item", "expected_contract_sha256"])
      || !nonempty(removal.owner) || !nonempty(removal.item)
      || !hashPattern.test(removal.expected_contract_sha256 ?? "")
      || !Array.isArray(next.shot_manifest?.equipment_contracts)) {
      throw new Error("Equipment removal requires an exact owner, item, and current contract hash.");
    }
    const matches = next.shot_manifest.equipment_contracts
      .map((contract, index) => ({ contract, index }))
      .filter(({ contract }) => contract.owner === removal.owner && contract.item === removal.item);
    if (matches.length !== 1 || sha256(jsonBytes(matches[0].contract)) !== removal.expected_contract_sha256) {
      throw new Error("Reviewed equipment contract is missing, ambiguous, or changed.");
    }
    next.shot_manifest.equipment_contracts.splice(matches[0].index, 1);
  }
  if (replacement.equipment_contract_text_patch !== undefined) {
    const patch = replacement.equipment_contract_text_patch;
    if (replacement.location_reference_patch === undefined) {
      throw new Error("Equipment holder-state correction is limited to a reviewed location-reference correction.");
    }
    if (!only(patch, ["owner", "item", "expected_contract_sha256", "holder_state", "contact_target"])
      || !nonempty(patch.owner) || !nonempty(patch.item)
      || !hashPattern.test(patch.expected_contract_sha256 ?? "")
      || (!patch.holder_state && !patch.contact_target)) {
      throw new Error("Equipment text correction requires an exact contract hash and holder-state/contact patch.");
    }
    const contracts = (next.shot_manifest?.equipment_contracts ?? [])
      .filter((item) => item.owner === patch.owner && item.item === patch.item);
    if (contracts.length !== 1 || sha256(jsonBytes(contracts[0])) !== patch.expected_contract_sha256) {
      throw new Error("Reviewed equipment contract is missing, ambiguous, or changed.");
    }
    for (const field of ["holder_state", "contact_target"]) {
      if (patch[field]) contracts[0][field] = exactTextPatch(contracts[0][field], patch[field], `equipment_contracts.${field}`);
    }
  }
  if (replacement.staging_patch !== undefined && replacement.staging_patches !== undefined) {
    throw new Error("Use staging_patch or staging_patches, never both.");
  }
  const stagingPatches = replacement.staging_patches ?? (replacement.staging_patch === undefined ? [] : [replacement.staging_patch]);
  if (!Array.isArray(stagingPatches) || stagingPatches.length > 8) throw new Error("staging_patches must contain at most eight exact character patches.");
  const stagedNames = new Set();
  for (const patch of stagingPatches) {
    if (!only(patch, ["name", "wardrobe_from", "pose", "screen_position"]) || !nonempty(patch.name)) {
      throw new Error("Staging patch needs one exact visible character name.");
    }
    if (stagedNames.has(patch.name)) throw new Error(`Duplicate staging patch for ${patch.name}.`);
    stagedNames.add(patch.name);
    const matches = (next.shot_manifest?.character_staging ?? []).filter((item) => item.name === patch.name);
    if (matches.length !== 1 || !["wardrobe_from", "pose", "screen_position"].some((field) => patch[field])) {
      throw new Error("Staging patch must identify exactly one character and a changed field.");
    }
    const target = matches[0];
    for (const field of ["wardrobe_from", "pose", "screen_position"]) {
      if (!patch[field]) continue;
      const corrected = exactTextPatch(target[field], patch[field], `character_staging.${field}`);
      if (field === "wardrobe_from" && corrected.startsWith("character_state_ref:")
        && corrected !== target[field]) {
        throw new Error("This exact repair cannot change the wardrobe state reference ID.");
      }
      target[field] = corrected;
    }
  }
  if (replacement.manifest_text_patch !== undefined) {
    const patch = replacement.manifest_text_patch;
    if (!only(patch, ["foreground_action", "continuity_notes", "depth_background_plane"]) || !Object.keys(patch).length) {
      throw new Error("Manifest text patch supports only reviewed action, continuity, and depth background prose.");
    }
    for (const field of Object.keys(patch)) {
      if (field === "depth_background_plane") {
        const depth = next.shot_manifest?.motion_intent?.depth_candidate;
        depth.background_plane = exactTextPatch(depth?.background_plane, patch[field], "motion_intent.depth_candidate.background_plane");
      } else next.shot_manifest[field] = exactTextPatch(next.shot_manifest?.[field], patch[field], `shot_manifest.${field}`);
    }
  }
  if (replacement.reference_text_patch !== undefined) {
    const patch = replacement.reference_text_patch;
    if (!only(patch, ["ref_id", "slot_purpose", "reason"]) || !nonempty(patch.ref_id)
      || !["slot_purpose", "reason"].some((field) => patch[field])
      || !next.reference_requirements?.some((item) => item.ref_id === patch.ref_id)
      || !next.shot_manifest?.reference_slots?.some((item) => item.ref_id === patch.ref_id)) {
      throw new Error("Reference text patch requires one attached reference with a matching manifest slot.");
    }
    for (const field of ["slot_purpose", "reason"]) {
      if (!patch[field]) continue;
      const requirement = next.reference_requirements.find((item) => item.ref_id === patch.ref_id);
      const slot = next.shot_manifest.reference_slots.find((item) => item.ref_id === patch.ref_id);
      requirement[field] = exactTextPatch(requirement[field], patch[field], `reference_requirements.${field}`);
      slot[field] = exactTextPatch(slot[field], patch[field], `reference_slots.${field}`);
      if (field === "reason") {
        for (const item of [...(next.reference_usage ?? []), ...(next.anchor_roles ?? [])]) {
          if (item.ref_id === patch.ref_id && item.reason === patch[field].before) item.reason = patch[field].to;
        }
      }
    }
  }
  if (replacement.anatomy_contract_patch !== undefined && replacement.anatomy_contract_patches !== undefined) {
    throw new Error("Use anatomy_contract_patch or anatomy_contract_patches, never both.");
  }
  const anatomyPatches = replacement.anatomy_contract_patches ?? (replacement.anatomy_contract_patch === undefined ? [] : [replacement.anatomy_contract_patch]);
  if (!Array.isArray(anatomyPatches) || anatomyPatches.length > 8) throw new Error("anatomy_contract_patches must contain at most eight exact contract patches.");
  const anatomyKeys = new Set();
  for (const patch of anatomyPatches) {
    if (!only(patch, ["entity", "identity_ref_id", "body_invariant", "reason"])
      || !nonempty(patch.entity) || !nonempty(patch.identity_ref_id)
      || !["body_invariant", "reason"].some((field) => patch[field])
      || !next.reference_requirements?.some((item) => item.ref_id === patch.identity_ref_id)) {
      throw new Error("Anatomy contract patch must identify one visible entity with an attached identity reference.");
    }
    const key = `${patch.entity}\u0000${patch.identity_ref_id}`;
    if (anatomyKeys.has(key)) throw new Error(`Duplicate anatomy contract patch for ${patch.entity}.`);
    anatomyKeys.add(key);
    const contracts = next.shot_manifest?.anatomy_contracts?.filter((item) => item.entity === patch.entity && item.identity_ref_id === patch.identity_ref_id) ?? [];
    if (contracts.length !== 1) throw new Error("Anatomy contract entity and identity reference must match exactly once.");
    for (const field of ["body_invariant", "reason"]) {
      if (patch[field]) contracts[0][field] = exactTextPatch(contracts[0][field], patch[field], `anatomy_contracts.${field}`);
    }
  }
  return next;
}

export async function repairVisualPromptExact({ episodeDir, spec, specPath, status, now = new Date() }) {
  episodeDir = path.resolve(episodeDir);
  const admission = exactVisualPromptRepairAdmission(status, { "episode-dir": episodeDir, "repair-spec": specPath });
  if (!admission.allowed) throw new Error(`Exact prompt repair refused: ${admission.reason}.`);
  if (!only(spec, ["schema", "episode", "expected", "image_id", "visual_beat_id", "old_row_sha256", "replacement", "reviewer", "note", "scope_reviewed"])
    || spec.schema !== "goldflow_visual_prompt_exact_repair_v1" || spec.episode !== path.basename(episodeDir)
    || !nonempty(spec.image_id) || !nonempty(spec.visual_beat_id) || !nonempty(spec.reviewer)
    || !nonempty(spec.note) || spec.scope_reviewed !== true || !hashPattern.test(spec.old_row_sha256 ?? "")) {
    throw new Error("Reviewed exact prompt repair spec is incomplete or contains unsupported fields.");
  }
  const expectedKeys = Object.keys(fileNames);
  if (!only(spec.expected, expectedKeys) || expectedKeys.some((key) => !hashPattern.test(spec.expected[key] ?? ""))) {
    throw new Error("Exact prompt repair requires current SHA-256 bindings for identity, script, beats, refs, approvals, and prompt plan.");
  }
  const files = {};
  for (const [key, name] of Object.entries(fileNames)) {
    const file = path.join(episodeDir, typeof name === "function" ? name(spec.episode) : name);
    files[key] = { path: file, ...await read(file) };
    if (files[key].sha256 !== spec.expected[key]) throw new Error(`${path.basename(file)} changed since review; no repair applied.`);
  }
  const plan = files.prompt_plan_sha256.value;
  const beats = files.visual_beat_plan_sha256.value;
  const refs = files.visual_reference_plan_sha256.value;
  if (plan.schema !== "goldflow_section_image_prompts_v1" || plan.status !== "passed" || !Array.isArray(plan.prompts)
    || beats.status !== "passed" || refs.status !== "passed"
    || files.reference_plan_approval_sha256.value.status !== "approved"
    || files.reference_image_approval_sha256.value.status !== "approved") {
    throw new Error("Passed prompt, beat, reference and approval artifacts are required.");
  }
  if (plan.source_script_hash !== files.source_script_sha256.sha256) throw new Error("Prompt plan script binding is stale.");
  const events = await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8")
    .catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  for (const line of events.split("\n").filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error("Execution event ledger has invalid JSON."); }
    if (["visual_prompt_harden", "visual_prompt_blocker_repair", "transition_edit_plan", "image_generation"].includes(event.stage)) {
      throw new Error("Downstream visual processing was already attempted; exact pre-harden repair is closed.");
    }
  }
  for (const [sourcePath, boundHash] of Object.entries(plan.source_hashes ?? {})) {
    if (!path.isAbsolute(sourcePath) || sha256(await fs.readFile(sourcePath)) !== boundHash) throw new Error(`Prompt plan source binding is stale: ${sourcePath}.`);
  }
  const rows = plan.prompts.filter((row) => row.image_id === spec.image_id);
  if (rows.length !== 1 || rows[0].visual_beat_id !== spec.visual_beat_id) throw new Error("Exact image/beat identity does not match one prompt row.");
  const original = rows[0];
  if (sha256(jsonBytes(original)) !== spec.old_row_sha256) throw new Error("Reviewed old row hash does not match.");
  const sourceBeats = beats.beats.filter((beat) => beat.visual_beat_id === spec.visual_beat_id);
  if (sourceBeats.length !== 1) throw new Error("Prompt beat is absent or duplicated in approved beat plan.");
  const allowed = allowedRefIdsForScene({ scene: sourceBeats[0], visualReferencePlan: refs, characterStateRefs: refs.character_state_refs ?? [] });
  const declared = [
    ...(original.reference_requirements ?? []).map((item) => item?.ref_id),
    ...(original.shot_manifest?.reference_slots ?? []).map((item) => item?.ref_id),
    ...(original.shot_manifest?.character_state_ref_ids ?? []),
    original.shot_manifest?.protagonist_state_ref_id,
    original.shot_manifest?.location_ref_id,
  ].filter(Boolean);
  if (declared.some((id) => !allowed.has(id))) throw new Error("Prompt row contains an out-of-scope reference; repair refs with the guarded review route first.");
  if (spec.replacement.location_reference_patch) {
    const selected = spec.replacement.location_reference_patch;
    const target = refs.reference_targets?.find((item) => item.ref_id === selected.to_ref_id);
    if (!target?.reference_image_path || sha256(await fs.readFile(target.reference_image_path)) !== selected.approved_reference_sha256) {
      throw new Error("Replacement approved location raster changed since review.");
    }
  }
  const corrected = applyExactPromptText(patchRowStructures(original, spec.replacement, {
    sourceScript: files.source_script_sha256.value, sourceBeat: sourceBeats[0], referencePlan: refs,
    referenceApproval: files.reference_image_approval_sha256.value,
  }), spec.replacement);
  const correctedRefs = [
    ...(corrected.reference_requirements ?? []).map((item) => item?.ref_id),
    ...(corrected.shot_manifest?.reference_slots ?? []).map((item) => item?.ref_id),
    ...(corrected.shot_manifest?.character_state_ref_ids ?? []),
    corrected.shot_manifest?.protagonist_state_ref_id,
    corrected.shot_manifest?.location_ref_id,
  ].filter(Boolean);
  if (correctedRefs.some((id) => !allowed.has(id))) throw new Error("Corrected prompt contains an out-of-scope reference.");
  if (spec.replacement.assert_absent_terms !== undefined) {
    const terms = spec.replacement.assert_absent_terms;
    if (!Array.isArray(terms) || !terms.length || terms.length > 8 || terms.some((term) => !nonempty(term) || term.length > 100)) {
      throw new Error("assert_absent_terms must contain one to eight short exact phrases.");
    }
    const body = JSON.stringify(corrected).toLowerCase();
    for (const term of terms) if (body.includes(term.toLowerCase())) throw new Error(`Corrected row still contains rejected term: ${term}.`);
  }
  const changedPlan = structuredClone(plan);
  changedPlan.prompts[plan.prompts.indexOf(original)] = corrected;
  const at = now.toISOString();
  changedPlan.updated_at = at;
  changedPlan.planner = { ...changedPlan.planner, exact_manual_prompt_repairs: [
    ...(changedPlan.planner?.exact_manual_prompt_repairs ?? []),
    { image_id: spec.image_id, visual_beat_id: spec.visual_beat_id, old_row_sha256: spec.old_row_sha256,
      new_row_sha256: sha256(jsonBytes(corrected)), reviewed_by: spec.reviewer, reviewed_at: at },
  ] };
  const output = jsonBytes(changedPlan);
  const repairId = `${at.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const receiptDir = path.join(episodeDir, "reports", "stages", "visual_prompt_plan", "exact_repairs", repairId);
  const receipt = { schema: "goldflow_visual_prompt_exact_repair_receipt_v1", status: "passed", repair_id: repairId,
    episode: spec.episode, image_id: spec.image_id, visual_beat_id: spec.visual_beat_id, reviewer: spec.reviewer, note: spec.note,
    spec_sha256: sha256(await fs.readFile(specPath)), source_hashes: Object.fromEntries(Object.entries(files).map(([key, item]) => [key, item.sha256])),
    old_row_sha256: spec.old_row_sha256, new_row_sha256: sha256(jsonBytes(corrected)),
    narrative_overlay_text_change: spec.replacement.narrative_overlay_patch ? {
      index: spec.replacement.narrative_overlay_patch.index,
      before: spec.replacement.narrative_overlay_patch.before,
      after: spec.replacement.narrative_overlay_patch.to,
      before_overlay_sha256: spec.replacement.narrative_overlay_patch.old_overlay_sha256,
      after_overlay_sha256: sha256(jsonBytes(corrected.narrative_overlays[spec.replacement.narrative_overlay_patch.index])),
      information_delta_change: spec.replacement.narrative_overlay_patch.information_delta ? {
        before: spec.replacement.narrative_overlay_patch.information_delta.before,
        after: spec.replacement.narrative_overlay_patch.information_delta.to,
      } : null,
      source_quotes: spec.replacement.narrative_overlay_patch.source_quotes,
    } : null,
    ui_element_text_change: spec.replacement.ui_element_patch ? {
      index: spec.replacement.ui_element_patch.index,
      before: spec.replacement.ui_element_patch.before,
      after: spec.replacement.ui_element_patch.to,
    } : null,
    ui_element_text_changes: (spec.replacement.ui_element_patches ?? (spec.replacement.ui_element_patch ? [spec.replacement.ui_element_patch] : []))
      .map((patch) => ({ index: patch.index, before: patch.before, after: patch.to })),
    ui_element_source_quotes: spec.replacement.ui_element_source_quotes ?? null,
    location_reference_change: spec.replacement.location_reference_patch ? {
      from_ref_id: spec.replacement.location_reference_patch.from_ref_id,
      to_ref_id: spec.replacement.location_reference_patch.to_ref_id,
      approved_reference_sha256: spec.replacement.location_reference_patch.approved_reference_sha256,
      source_quotes: spec.replacement.location_reference_patch.source_quotes,
    } : null,
    before_plan_sha256: files.prompt_plan_sha256.sha256, after_plan_sha256: sha256(output),
    before_snapshot_path: path.join(receiptDir, "before", "section_image_prompts.json"),
    provider_calls: 0, estimated_cost_usd: 0, updated_at: at };
  await fs.mkdir(path.join(receiptDir, "before"), { recursive: true });
  await fs.writeFile(receipt.before_snapshot_path, files.prompt_plan_sha256.bytes, { flag: "wx" });
  await fs.writeFile(path.join(receiptDir, "repair_spec.json"), await fs.readFile(specPath), { flag: "wx" });
  await fs.writeFile(path.join(receiptDir, "receipt.json"), jsonBytes(receipt), { flag: "wx" });
  const temp = path.join(episodeDir, `.section_image_prompts.${repairId}.tmp`);
  await fs.writeFile(temp, output, { flag: "wx" });
  try { await fs.rename(temp, files.prompt_plan_sha256.path); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
  return { status: "passed", receipt_path: path.join(receiptDir, "receipt.json"), image_id: spec.image_id,
    prompt_plan_sha256: sha256(output), provider_calls: 0 };
}
