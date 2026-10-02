import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { exactVisualPromptRepairAdmission } from "./visual-prompt-exact-repair.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hashPattern = /^[a-f0-9]{64}$/;
const multiplierPattern = /^×(?:2|4|8|16|32|64|128|256)$/;
const fieldPattern = /^(?:provider_prompt|image_prompt|modelslab_image_prompt|codex_image_prompt|narrative_overlays\[\d+\]\.(?:text|information_delta)|shot_manifest\.ui_elements\[\d+\])$/;
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

function stringLeaves(value, prefix = "", result = []) {
  if (typeof value === "string") result.push({ path: prefix, value });
  else if (Array.isArray(value)) value.forEach((item, index) => stringLeaves(item, `${prefix}[${index}]`, result));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) =>
    stringLeaves(item, prefix ? `${prefix}.${key}` : key, result));
  return result;
}

function fieldAt(row, name) {
  const parts = name.replaceAll(/\[(\d+)\]/g, ".$1").split(".");
  let owner = row;
  for (const part of parts.slice(0, -1)) {
    if (owner === null || owner === undefined || !Object.hasOwn(owner, part)) return null;
    owner = owner[part];
  }
  const key = parts.at(-1);
  return owner !== null && owner !== undefined && Object.hasOwn(owner, key) ? { owner, key } : null;
}

export function applyExactMultiplierRow(row, repair) {
  if (!only(repair, ["image_id", "visual_beat_id", "old_row_sha256", "source_quote", "reason", "incorrect_token", "corrected_token", "field_assertions"])
    || !nonempty(repair.image_id) || !nonempty(repair.visual_beat_id) || !nonempty(repair.source_quote)
    || !nonempty(repair.reason) || !hashPattern.test(repair.old_row_sha256 ?? "")
    || !multiplierPattern.test(repair.incorrect_token ?? "") || !multiplierPattern.test(repair.corrected_token ?? "")
    || Number(repair.corrected_token.slice(1)) >= Number(repair.incorrect_token.slice(1))
    || !Array.isArray(repair.field_assertions) || repair.field_assertions.length < 1 || repair.field_assertions.length > 12) {
    throw new Error("Multiplier repair row requires exact identity, source evidence, earlier corrected multiplier, and bounded field assertions.");
  }
  if (row.image_id !== repair.image_id || row.visual_beat_id !== repair.visual_beat_id
    || sha256(jsonBytes(row)) !== repair.old_row_sha256) throw new Error("Reviewed multiplier row identity/hash changed.");
  const observed = stringLeaves(row).filter((entry) => entry.value.includes(repair.incorrect_token)).map((entry) => entry.path).sort();
  const asserted = repair.field_assertions.map((entry) => entry?.path).sort();
  if (observed.length !== asserted.length || observed.some((name, index) => name !== asserted[index])) {
    throw new Error("Multiplier repair field assertions must cover every occurrence and no other field.");
  }
  const next = structuredClone(row);
  const seen = new Set();
  for (const assertion of repair.field_assertions) {
    if (!only(assertion, ["path", "before"]) || !fieldPattern.test(assertion.path ?? "")
      || !nonempty(assertion.before) || !assertion.before.includes(repair.incorrect_token)
      || seen.has(assertion.path)) throw new Error("Multiplier field assertion path/value is invalid or repeated.");
    seen.add(assertion.path);
    const field = fieldAt(next, assertion.path);
    if (!field || field.owner[field.key] !== assertion.before) throw new Error(`Reviewed multiplier field changed: ${assertion.path}.`);
    field.owner[field.key] = assertion.before.split(repair.incorrect_token).join(repair.corrected_token);
  }
  if (stringLeaves(next).some((entry) => entry.value.includes(repair.incorrect_token))) throw new Error("Incorrect multiplier remains in corrected row.");
  if (typeof next.provider_prompt === "string" && typeof next.image_prompt === "string"
    && next.provider_prompt !== next.image_prompt) throw new Error("Corrected canonical image prompts diverge.");
  if (typeof next.prompt_hash === "string" && next.prompt_hash.length) next.prompt_hash = sha256(next.provider_prompt);
  return next;
}

export async function repairVisualPromptMultiplierExact({ episodeDir, spec, specPath, status, now = new Date() }) {
  episodeDir = path.resolve(episodeDir);
  const admission = exactVisualPromptRepairAdmission(status, { "episode-dir": episodeDir, "repair-spec": specPath });
  if (!admission.allowed) throw new Error(`Exact multiplier repair refused: ${admission.reason}.`);
  if (!only(spec, ["schema", "episode", "expected", "rows", "reviewer", "note", "scope_reviewed"])
    || spec.schema !== "goldflow_visual_prompt_multiplier_exact_repair_v1" || spec.episode !== path.basename(episodeDir)
    || !nonempty(spec.reviewer) || !nonempty(spec.note) || spec.scope_reviewed !== true
    || !Array.isArray(spec.rows) || spec.rows.length < 1 || spec.rows.length > 12) {
    throw new Error("Reviewed multiplier repair spec must identify one to twelve exact pre-harden rows.");
  }
  const expectedKeys = Object.keys(fileNames);
  if (!only(spec.expected, expectedKeys) || expectedKeys.some((key) => !hashPattern.test(spec.expected[key] ?? ""))) {
    throw new Error("Multiplier repair requires current hashes for identity, script, beats, refs, approvals, and prompt plan.");
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
    || files.reference_image_approval_sha256.value.status !== "approved"
    || plan.source_script_hash !== files.source_script_sha256.sha256) {
    throw new Error("Current passed source-bound prompt, beat, reference and approval artifacts are required.");
  }
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
    if (!path.isAbsolute(sourcePath) || sha256(await fs.readFile(sourcePath)) !== boundHash) {
      throw new Error(`Prompt plan source binding is stale: ${sourcePath}.`);
    }
  }
  const changedPlan = structuredClone(plan);
  const seenRows = new Set();
  const rowReceipts = [];
  for (const repair of spec.rows) {
    if (seenRows.has(repair.image_id)) throw new Error("Duplicate image ID in reviewed multiplier repair.");
    seenRows.add(repair.image_id);
    const index = changedPlan.prompts.findIndex((row) => row.image_id === repair.image_id);
    if (index < 0 || changedPlan.prompts.some((row, other) => other !== index && row.image_id === repair.image_id)) {
      throw new Error("Reviewed image ID is absent or duplicated in prompt plan.");
    }
    const beatRows = beats.beats.filter((beat) => beat.visual_beat_id === repair.visual_beat_id);
    if (beatRows.length !== 1 || beatRows[0].image_id_hint !== repair.image_id
      || !beatRows[0].visual_beat_script_excerpt?.includes(repair.source_quote)
      || !files.source_script_sha256.value.includes(repair.source_quote)) {
      throw new Error("Reviewed multiplier source quote or approved beat identity does not match.");
    }
    const oldRow = changedPlan.prompts[index];
    const corrected = applyExactMultiplierRow(oldRow, repair);
    changedPlan.prompts[index] = corrected;
    rowReceipts.push({ image_id: repair.image_id, visual_beat_id: repair.visual_beat_id,
      old_row_sha256: repair.old_row_sha256, new_row_sha256: sha256(jsonBytes(corrected)),
      incorrect_token: repair.incorrect_token, corrected_token: repair.corrected_token,
      source_quote: repair.source_quote, reason: repair.reason,
      corrected_fields: repair.field_assertions.map((entry) => entry.path) });
  }
  const at = now.toISOString();
  changedPlan.updated_at = at;
  changedPlan.planner = { ...changedPlan.planner, exact_manual_multiplier_repairs: [
    ...(changedPlan.planner?.exact_manual_multiplier_repairs ?? []),
    ...rowReceipts.map((item) => ({ image_id: item.image_id, visual_beat_id: item.visual_beat_id,
      old_row_sha256: item.old_row_sha256, new_row_sha256: item.new_row_sha256, reviewed_by: spec.reviewer, reviewed_at: at })),
  ] };
  const output = jsonBytes(changedPlan);
  const repairId = `${at.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const receiptDir = path.join(episodeDir, "reports", "stages", "visual_prompt_plan", "exact_multiplier_repairs", repairId);
  const receipt = { schema: "goldflow_visual_prompt_multiplier_exact_repair_receipt_v1", status: "passed", repair_id: repairId,
    episode: spec.episode, reviewer: spec.reviewer, note: spec.note,
    spec_sha256: sha256(await fs.readFile(specPath)), source_hashes: Object.fromEntries(Object.entries(files).map(([key, item]) => [key, item.sha256])),
    repaired_rows: rowReceipts, before_plan_sha256: files.prompt_plan_sha256.sha256, after_plan_sha256: sha256(output),
    before_snapshot_path: path.join(receiptDir, "before", "section_image_prompts.json"),
    provider_calls: 0, estimated_cost_usd: 0, updated_at: at };
  await fs.mkdir(path.join(receiptDir, "before"), { recursive: true });
  await fs.writeFile(receipt.before_snapshot_path, files.prompt_plan_sha256.bytes, { flag: "wx" });
  await fs.writeFile(path.join(receiptDir, "repair_spec.json"), await fs.readFile(specPath), { flag: "wx" });
  const temp = path.join(episodeDir, `.section_image_prompts.${repairId}.tmp`);
  await fs.writeFile(temp, output, { flag: "wx" });
  try {
    if (sha256(await fs.readFile(files.prompt_plan_sha256.path)) !== files.prompt_plan_sha256.sha256) {
      throw new Error("Prompt plan changed during reviewed repair; no replacement applied.");
    }
    await fs.rename(temp, files.prompt_plan_sha256.path);
  } catch (error) { await fs.rm(temp, { force: true }); throw error; }
  await fs.writeFile(path.join(receiptDir, "receipt.json"), jsonBytes(receipt), { flag: "wx" });
  return { status: "passed", receipt_path: path.join(receiptDir, "receipt.json"),
    image_ids: rowReceipts.map((row) => row.image_id), prompt_plan_sha256: sha256(output), provider_calls: 0 };
}
