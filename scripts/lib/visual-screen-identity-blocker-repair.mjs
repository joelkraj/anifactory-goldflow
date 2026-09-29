import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hex = (value) => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));
const nonempty = (value) => typeof value === "string" && value.trim() === value && value.length > 0;
const read = async (file) => { const bytes = await fs.readFile(file); return { bytes, sha256: hash(bytes),
  value: path.extname(file) === ".json" ? JSON.parse(bytes) : bytes.toString("utf8") }; };
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

export function screenIdentityBlockerRepairAdmission(status, flags) {
  const deny = (reason) => ({ allowed: false, reason });
  if (!exactKeys(flags, ["episode-dir", "repair-spec"]) || !nonempty(flags["episode-dir"]) || !nonempty(flags["repair-spec"])) {
    return deny("episode_dir_and_reviewed_spec_required");
  }
  if (path.resolve(flags["episode-dir"]) !== path.resolve(String(status?.episode_dir ?? ""))) return deny("episode_status_mismatch");
  if (status?.identity?.schema !== "goldflow_run_identity_v2" || status?.media_workflow?.id !== "generated_visuals_v1") {
    return deny("unsupported_run_identity_or_workflow");
  }
  if (status.current_stage !== "visual_prompt_harden" || status.current_stage_state !== "blocked"
    || !/visual repair-screen-identity|manual agent review required/i.test(status.next_command_shape ?? "")) return deny("manual_harden_blocker_required");
  for (const stage of ["transition_edit_plan", "image_generation", "image_output_qa"]) {
    if (["running", "passed", "failed"].includes(status.stage_ledger?.find((row) => row.stage === stage)?.state)) {
      return deny("image_or_transition_stage_started");
    }
  }
  return { allowed: true, reason: "one_source_supported_screen_identity_correction" };
}

function replaceName(value, from, to) {
  if (typeof value !== "string") throw new Error("Expected an exact character text field.");
  const expression = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  return value.replace(expression, to);
}

export function correctGenericScreenSubject(row, { false_entity_id: falseId, false_name: falseName,
  generic_subject: generic, replacement_prompt: prompt }) {
  if (!nonempty(generic) || !/\brobot\b/i.test(generic) || !nonempty(prompt) || prompt.length > 12000
    || !Array.isArray(row.screen_visible_entity_ids) || row.screen_visible_entity_ids.length !== 1
    || row.screen_visible_entity_ids[0] !== falseId || row.shot_manifest?.visible_characters?.length !== 1
    || row.shot_manifest.visible_characters[0] !== falseName || row.shot_manifest.primary_character !== falseName
    || row.visible_subjects?.length !== 1 || row.visible_subjects[0] !== falseName
    || row.primary_subject !== falseName || row.image_prompt !== row.provider_prompt
    || row.narrative_overlays?.length !== 1 || row.narrative_overlays[0].kind !== "speech_bubble"
    || row.narrative_overlays[0].speaker !== falseName
    || (row.reference_requirements ?? []).some((ref) => /character/i.test(String(ref.kind ?? "")))) {
    throw new Error("Screen identity correction requires one false named subject and no character reference attachment.");
  }
  if (!/\b(?:screen|display|advertisement|promotional)\b/i.test(row.visual_beat_script_excerpt ?? "")
    || !/\brobot\b/i.test(row.visual_beat_script_excerpt ?? "")
    || new RegExp(`\\b${falseName}\\b`, "i").test(row.visual_beat_script_excerpt ?? "")) {
    throw new Error("Source excerpt does not support a generic screen robot correction.");
  }
  if (new RegExp(`\\b${falseName}\\b`, "i").test(prompt)
    || !/\brobot\b/i.test(prompt) || !/\b(?:screen|display|advertisement|promotional)\b/i.test(prompt)
    || /right on time|speech bubble|dialogue bubble/i.test(prompt)) {
    throw new Error("Replacement prompt must depict an unnamed robot inside the screen without the false name or invented speech.");
  }
  const next = structuredClone(row);
  next.screen_visible_entity_ids = [];
  next.shot_manifest.visible_characters = [generic];
  next.shot_manifest.primary_character = generic;
  next.visible_subjects = [generic];
  next.primary_subject = generic;
  next.provider_prompt = prompt;
  next.image_prompt = prompt;
  next.prompt_hash = hash(prompt);
  next.shot_manifest.foreground_action = replaceName(next.shot_manifest.foreground_action, falseName, generic);
  for (const anatomy of next.shot_manifest.anatomy_contracts ?? []) {
    if (anatomy.entity === falseName) anatomy.entity = generic;
  }
  for (const equipment of next.shot_manifest.equipment_contracts ?? []) {
    if (equipment.owner === falseName) equipment.owner = generic;
  }
  for (const staging of next.shot_manifest.character_staging ?? []) {
    if (staging.name === falseName) staging.name = generic;
  }
  next.narrative_overlays = [];
  next.narrative_overlay_findings = [];
  if (new RegExp(`\\b${falseName}\\b|\\b${falseId}\\b`, "i").test(JSON.stringify(next))) {
    throw new Error("False identity remains in corrected cut.");
  }
  if (JSON.stringify(next.reference_requirements) !== JSON.stringify(row.reference_requirements)
    || JSON.stringify(next.shot_manifest.reference_slots) !== JSON.stringify(row.shot_manifest.reference_slots)) {
    throw new Error("Identity correction cannot change reference attachments.");
  }
  return next;
}

export async function repairScreenIdentityBlocker({ episodeDir, specPath, spec, status, now = new Date() }) {
  episodeDir = path.resolve(episodeDir);
  const admission = screenIdentityBlockerRepairAdmission(status, { "episode-dir": episodeDir, "repair-spec": specPath });
  if (!admission.allowed) throw new Error(`Screen identity repair refused: ${admission.reason}.`);
  if (!exactKeys(spec, ["schema", "episode", "expected", "image_id", "visual_beat_id", "old_row_sha256",
    "false_entity_id", "false_name", "generic_subject", "replacement_prompt", "reviewer", "note", "source_erratum_reviewed"])
    || spec.schema !== "goldflow_visual_screen_identity_blocker_repair_v1" || spec.episode !== path.basename(episodeDir)
    || !nonempty(spec.image_id) || !nonempty(spec.visual_beat_id) || !nonempty(spec.false_entity_id)
    || !/^[a-z][a-z0-9_]*$/.test(spec.false_entity_id)
    || !nonempty(spec.false_name) || !/^[A-Za-z][A-Za-z' -]{0,59}$/.test(spec.false_name)
    || !nonempty(spec.generic_subject) || !nonempty(spec.reviewer)
    || !nonempty(spec.note) || spec.source_erratum_reviewed !== true || !hex(spec.old_row_sha256)) {
    throw new Error("Screen identity repair requires a complete reviewed exact-cut spec.");
  }
  if (!exactKeys(spec.expected, Object.keys(dependencies))
    || Object.keys(dependencies).some((key) => !hex(spec.expected[key]))) throw new Error("Every current source and blocker hash is required.");
  const files = {};
  for (const [key, name] of Object.entries(dependencies)) {
    files[key] = { path: path.join(episodeDir, name), ...await read(path.join(episodeDir, name)) };
    if (files[key].sha256 !== spec.expected[key]) throw new Error(`${name} changed since review.`);
  }
  const { beat_plan: beats, base_prompt_plan: base, reviewed_prompt_plan: reviewed, harden_report: harden,
    manual_review: manual } = Object.fromEntries(Object.entries(files).map(([key, entry]) => [key, entry.value]));
  if (beats.status !== "passed" || base.status !== "passed" || reviewed.status !== "needs_manual_agent_review"
    || harden.status !== "blocked" || manual.status !== "needs_manual_agent_review"
    || manual.image_ids?.length !== 1 || manual.image_ids[0] !== spec.image_id
    || manual.unresolved_blockers?.length !== 1
    || harden.unresolved_blocker_count !== 1
    || manual.unresolved_blockers[0].code !== "visible_character_ref_scope_missing"
    || manual.unresolved_blockers[0].character !== spec.false_name
    || files.beat_approval.value.status !== "approved"
    || files.reference_plan_approval.value.status !== "approved"
    || files.reference_image_approval.value.status !== "approved") {
    throw new Error("One current manual visible-character scope blocker and approved sources are required.");
  }
  const beat = beats.beats?.find((item) => item.visual_beat_id === spec.visual_beat_id);
  const rows = reviewed.prompts?.filter((item) => item.image_id === spec.image_id);
  const baseRows = base.prompts?.filter((item) => item.image_id === spec.image_id);
  if (!beat || rows?.length !== 1 || baseRows?.length !== 1 || rows[0].visual_beat_id !== spec.visual_beat_id
    || beat.image_id_hint !== spec.image_id || beat.screen_visible_entity_ids?.length !== 1
    || beat.screen_visible_entity_ids[0] !== spec.false_entity_id
    || !/\b(?:generic|promotional)\b/i.test(beat.local_continuity_note ?? "")
    || !/\brobot\b/i.test(beat.local_continuity_note ?? "")
    || new RegExp(`\\b${spec.false_name}\\b`, "i").test(beat.visual_beat_script_excerpt ?? "")) {
    throw new Error("Approved beat does not prove the generic screen subject and exact false tag.");
  }
  if (hash(json(rows[0])) !== spec.old_row_sha256) throw new Error("Reviewed row changed since exact inspection.");
  const events = await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  for (const line of events.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (["transition_edit_plan", "image_generation", "image_output_qa"].includes(event.stage)) {
      throw new Error("Image or transition processing already started.");
    }
  }
  const corrected = correctGenericScreenSubject(rows[0], spec);
  const changed = structuredClone(reviewed);
  changed.prompts[reviewed.prompts.indexOf(rows[0])] = corrected;
  changed.status = "passed";
  delete changed.visual_manual_agent_review_path;
  changed.updated_at = now.toISOString();
  changed.planner = { ...changed.planner, exact_screen_identity_repairs: [
    ...(changed.planner?.exact_screen_identity_repairs ?? []),
    { image_id: spec.image_id, visual_beat_id: spec.visual_beat_id, before_row_sha256: spec.old_row_sha256,
      after_row_sha256: hash(json(corrected)), reviewed_by: spec.reviewer, reviewed_at: changed.updated_at },
  ] };
  const output = json(changed);
  const repairId = `${changed.updated_at.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const receiptDir = path.join(episodeDir, "reports", "stages", "visual_prompt_blocker_repair", "exact_screen_identity", repairId);
  const receipt = { schema: "goldflow_visual_screen_identity_blocker_repair_receipt_v1", status: "passed",
    episode: spec.episode, image_id: spec.image_id, visual_beat_id: spec.visual_beat_id,
    reviewer: spec.reviewer, note: spec.note, false_entity_id: spec.false_entity_id,
    generic_subject: spec.generic_subject, spec_sha256: hash(await fs.readFile(specPath)),
    source_hashes: Object.fromEntries(Object.entries(files).map(([key, entry]) => [key, entry.sha256])),
    before_row_sha256: spec.old_row_sha256, after_row_sha256: hash(json(corrected)),
    before_plan_sha256: files.reviewed_prompt_plan.sha256, after_plan_sha256: hash(output),
    before_snapshot_path: path.join(receiptDir, "before", "section_image_prompts_reviewed.json"),
    prior_manual_review_path: files.manual_review.path, prior_harden_report_path: files.harden_report.path,
    provider_calls: 0, image_submissions: 0, estimated_cost_usd: 0, updated_at: changed.updated_at };
  await fs.mkdir(path.join(receiptDir, "before"), { recursive: true });
  await fs.writeFile(receipt.before_snapshot_path, files.reviewed_prompt_plan.bytes, { flag: "wx" });
  await fs.writeFile(path.join(receiptDir, "repair_spec.json"), await fs.readFile(specPath), { flag: "wx" });
  await fs.writeFile(path.join(receiptDir, "receipt.json"), json(receipt), { flag: "wx" });
  const temp = path.join(episodeDir, `.section_image_prompts_reviewed.${repairId}.tmp`);
  await fs.writeFile(temp, output, { flag: "wx" });
  try { await fs.rename(temp, files.reviewed_prompt_plan.path); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
  return { status: "passed", receipt_path: path.join(receiptDir, "receipt.json"),
    image_id: spec.image_id, reviewed_prompt_plan_sha256: hash(output), provider_calls: 0 };
}
