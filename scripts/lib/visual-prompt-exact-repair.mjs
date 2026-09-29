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
  if (!only(replacement, ["provider_prompt", "image_prompt"]) || !nonempty(replacement.provider_prompt)
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
  const corrected = applyExactPromptText(original, spec.replacement);
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
