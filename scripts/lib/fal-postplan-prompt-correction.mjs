import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { falObjectSha256 } from "./fal-provider.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const fileSha = async file => sha(await fs.readFile(file));
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const exists = async file => fs.access(file).then(() => true, () => false);
const need = (value, message) => { if (!value) throw new Error(message); };
const hash = value => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const keysOnly = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const bytes = value => `${JSON.stringify(value, null, 2)}\n`;

async function writeExact(file, value) {
  const content = bytes(value);
  const prior = await fs.readFile(file, "utf8").catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  if (prior !== null) { need(prior === content, `Existing Fal post-plan correction differs: ${file}`); return; }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { flag: "wx" });
}

export const falPostplanPromptCorrectionPaths = episodeDir => ({
  request: path.join(episodeDir, "fal", "postplan-prompt-correction-request.json"),
  receipt: path.join(episodeDir, "fal", "postplan-prompt-correction-receipt.json"),
  alternate: imageId => path.join(episodeDir, "fal", "bulk", "postplan-assignments", `${imageId}.json`),
});

// A reviewed correction may replace one unsubmitted bulk assignment in memory.
// The locked plan and all prior provider request/result receipts stay byte-identical.
export async function inspectFalPostplanPromptCorrection({ episodeDir, bulkPlan }) {
  const paths = falPostplanPromptCorrectionPaths(episodeDir);
  if (!await exists(paths.request)) return { state: "absent", assignments: bulkPlan.assignments };
  const expectedPaths = {
    run_identity_sha256: path.join(episodeDir, "run_identity.json"),
    source_script_sha256: path.join(episodeDir, "script_clean.md"),
    visual_beat_plan_sha256: path.join(episodeDir, "visual_beat_plan.json"),
    visual_beat_approval_sha256: path.join(episodeDir, "visual_beat_approval.json"),
    hardened_prompt_plan_sha256: path.join(episodeDir, "section_image_prompts_hardened.json"),
    bulk_plan_sha256: path.join(episodeDir, "fal", "bulk-plan.json"),
  };
  const request = await read(paths.request);
  need(keysOnly(request, ["schema", "expected", "reviewer", "note", "corrections"])
    && request.schema === "goldflow_fal_postplan_prompt_correction_request_v1"
    && keysOnly(request.expected, Object.keys(expectedPaths))
    && Object.keys(request.expected).length === Object.keys(expectedPaths).length
    && typeof request.reviewer === "string" && request.reviewer.trim()
    && typeof request.note === "string" && request.note.trim().length > 30
    && Array.isArray(request.corrections) && request.corrections.length >= 1 && request.corrections.length <= 8
    && new Set(request.corrections.map(row => row.image_id)).size === request.corrections.length,
  "Fal post-plan correction requires one to eight distinct, reviewed, exactly bound cuts.");
  for (const [key, file] of Object.entries(expectedPaths))
    need(hash(request.expected[key]) && request.expected[key] === await fileSha(file),
      `Fal post-plan correction source changed: ${key}`);
  need(bulkPlan.schema === "goldflow_fal_bulk_plan_v1"
    && bulkPlan.assignments.length === bulkPlan.assignment_count,
  "Fal post-plan correction requires the locked complete bulk plan.");
  const [hardened, script, beats, approval] = await Promise.all([
    read(expectedPaths.hardened_prompt_plan_sha256),
    fs.readFile(expectedPaths.source_script_sha256, "utf8"),
    read(expectedPaths.visual_beat_plan_sha256),
    read(expectedPaths.visual_beat_approval_sha256),
  ]);
  need(hardened.status === "passed" && beats.status === "passed" && approval.status === "approved",
    "Fal post-plan correction needs the passed hardened prompt and approved beats.");
  const requestSha = await fileSha(paths.request);
  const changed = new Map();
  for (const directive of request.corrections) {
    need(keysOnly(directive, ["image_id", "visual_beat_id", "operation", "source_quote",
      "earlier_source_quote", "overlay_kind", "overlay_text", "replacement_text",
      "old_overlay_sha256", "old_prompt_sha256", "old_assignment_sha256", "before_span",
      "replacement_span", "replacement_prompt_sha256", "reason"])
      && ["remove_overlay", "replace_overlay_text"].includes(directive.operation)
      && typeof directive.image_id === "string" && typeof directive.visual_beat_id === "string"
      && typeof directive.source_quote === "string" && directive.source_quote.length >= 12
      && typeof directive.overlay_kind === "string" && typeof directive.overlay_text === "string"
      && typeof directive.before_span === "string" && directive.before_span.length > 20
      && typeof directive.replacement_span === "string" && directive.replacement_span.length > 12
      && typeof directive.reason === "string" && directive.reason.trim().length > 25
      && [directive.old_overlay_sha256, directive.old_prompt_sha256,
        directive.old_assignment_sha256, directive.replacement_prompt_sha256].every(hash),
    `Fal post-plan correction directive is incomplete: ${directive.image_id}`);
    const original = bulkPlan.assignments.find(row => row.image_id === directive.image_id);
    const promptRow = hardened.prompts?.find(row => row.image_id === directive.image_id);
    need(original && !original.reused_validation_shot && promptRow
      && promptRow.visual_beat_id === directive.visual_beat_id
      && promptRow.visual_beat_script_excerpt?.includes(directive.source_quote)
      && script.includes(directive.source_quote)
      && promptRow.narrative_overlays?.length === 1
      && promptRow.narrative_overlays[0].kind === directive.overlay_kind
      && promptRow.narrative_overlays[0].text === directive.overlay_text
      && sha(JSON.stringify(promptRow.narrative_overlays)) === directive.old_overlay_sha256
      && sha(promptRow.provider_prompt) === directive.old_prompt_sha256
      && original.assignment_sha256 === directive.old_assignment_sha256
      && original.prompt.startsWith(promptRow.provider_prompt),
    `Fal post-plan correction is not bound to one source-backed unsubmitted cut: ${directive.image_id}`);
    const first = original.prompt.indexOf(directive.before_span);
    need(first >= 0 && original.prompt.indexOf(directive.before_span, first + 1) < 0
      && directive.before_span.includes(directive.overlay_text)
      && !directive.replacement_span.includes(directive.overlay_text),
    `Fal post-plan correction must replace only the cited authored overlay: ${directive.image_id}`);
    if (directive.operation === "remove_overlay") {
      need(typeof directive.earlier_source_quote === "string"
        && script.indexOf(directive.earlier_source_quote) >= 0
        && script.indexOf(directive.earlier_source_quote) < script.indexOf(directive.source_quote)
        && !directive.replacement_text
        && /\b(?:no lettering|free of lettering)\b/i.test(directive.replacement_span)
        && !/\b(?:thought|speech) bubble|rpg receipt\b/i.test(directive.replacement_span),
      `Fal post-plan overlay removal lacks earlier contradiction evidence: ${directive.image_id}`);
    } else {
      need(!directive.earlier_source_quote
        && typeof directive.replacement_text === "string"
        && directive.replacement_text.length >= 4
        && promptRow.visual_beat_script_excerpt.includes(directive.replacement_text)
        && script.includes(directive.replacement_text)
        && directive.replacement_span.includes(directive.replacement_text),
      `Fal post-plan replacement is not exact source text: ${directive.image_id}`);
    }
    const replacementPrompt = original.prompt.replace(directive.before_span, directive.replacement_span);
    need(replacementPrompt !== original.prompt && !replacementPrompt.includes(directive.overlay_text)
      && sha(replacementPrompt) === directive.replacement_prompt_sha256,
    `Fal post-plan replacement prompt differs from exact review: ${directive.image_id}`);
    const core = { ...original, prompt: replacementPrompt, prompt_sha256: sha(replacementPrompt),
      source_bulk_assignment_sha256: original.assignment_sha256,
      postplan_prompt_correction_request_sha256: requestSha };
    for (const key of ["assignment_sha256", "assignment_path", "submission_receipt_path",
      "result_receipt_path", "output_path", "upload_receipt_path"]) delete core[key];
    const alternate = { ...core, assignment_sha256: falObjectSha256(JSON.stringify(core)),
      submission_receipt_path: original.submission_receipt_path,
      result_receipt_path: original.result_receipt_path,
      output_path: original.output_path, upload_receipt_path: original.upload_receipt_path,
      assignment_path: paths.alternate(original.image_id) };
    changed.set(original.image_id, { original, alternate });
  }
  const baseReceipt = {
    schema: "goldflow_fal_postplan_prompt_correction_receipt_v1", status: "approved",
    request_sha256: requestSha, ...request.expected,
    reviewer: request.reviewer, note: request.note,
    corrected_image_ids: request.corrections.map(row => row.image_id),
    alternate_assignment_sha256_by_id: Object.fromEntries([...changed].map(([id, row]) => [id, row.alternate.assignment_sha256])),
  };
  const recorded = await exists(paths.receipt);
  let receipt;
  if (recorded) {
    receipt = await read(paths.receipt);
    for (const [key, value] of Object.entries(baseReceipt))
      need(JSON.stringify(receipt[key]) === JSON.stringify(value),
        `Fal post-plan correction receipt changed: ${key}`);
    for (const item of receipt.preexisting_submission_receipts ?? [])
      need(!changed.has(item.image_id)
        && item.sha256 === await fileSha(bulkPlan.assignments.find(row => row.image_id === item.image_id)?.submission_receipt_path ?? ""),
      `Prior Fal submission changed: ${item.image_id}`);
    for (const item of receipt.preexisting_result_receipts ?? [])
      need(!changed.has(item.image_id)
        && item.sha256 === await fileSha(bulkPlan.assignments.find(row => row.image_id === item.image_id)?.result_receipt_path ?? ""),
      `Prior Fal result changed: ${item.image_id}`);
    for (const [id, row] of changed) {
      need(bytes(await read(paths.alternate(id))) === bytes(row.alternate),
        `Fal post-plan alternate assignment changed: ${id}`);
      if (await exists(row.original.submission_receipt_path)) {
        const submission = await read(row.original.submission_receipt_path);
        need(submission.assignment_sha256 === row.alternate.assignment_sha256
          && submission.prompt_sha256 === row.alternate.prompt_sha256,
        `Fal post-plan submission did not use its reviewed alternate: ${id}`);
        if (await exists(row.original.result_receipt_path)) {
          const result = await read(row.original.result_receipt_path);
          need(result.request_id === submission.request_id
            && result.output_path === row.alternate.output_path,
          `Fal post-plan result is not bound to its reviewed request: ${id}`);
        }
      }
    }
  } else {
    need(!await exists(path.join(episodeDir, "cut_execution_ledger.json")),
      "Fal post-plan correction cannot be added after image finalization.");
    const preexisting_submission_receipts = [];
    const preexisting_result_receipts = [];
    for (const row of bulkPlan.assignments) {
      if (await exists(row.submission_receipt_path)) {
        const submission = await read(row.submission_receipt_path);
        need(submission.image_id === row.image_id
          && submission.assignment_sha256 === row.assignment_sha256
          && submission.prompt_sha256 === row.prompt_sha256,
        `Prior Fal submission is not bound to its locked assignment: ${row.image_id}`);
        preexisting_submission_receipts.push({ image_id: row.image_id, sha256: await fileSha(row.submission_receipt_path) });
      }
      if (await exists(row.result_receipt_path)) {
        const result = await read(row.result_receipt_path);
        need(typeof result.request_id === "string" && result.request_id,
          `Prior Fal result lacks a provider request: ${row.image_id}`);
        preexisting_result_receipts.push({ image_id: row.image_id, sha256: await fileSha(row.result_receipt_path) });
      }
    }
    for (const [id, row] of changed)
      need(!await exists(row.original.submission_receipt_path)
        && !await exists(row.original.result_receipt_path)
        && !await exists(row.original.output_path)
        && !await exists(path.join(episodeDir, "fal", "bulk", "failure-receipts", `${id}.json`))
        && !await exists(path.join(episodeDir, "fal", "bulk", "transport-holds", `${id}.json`)),
      `Fal post-plan correction cannot modify an already attempted cut: ${id}`);
    receipt = { ...baseReceipt, preexisting_submission_receipts, preexisting_result_receipts };
  }
  return { state: recorded ? "applied" : "pending", paths, request, receipt,
    assignments: bulkPlan.assignments.map(row => changed.get(row.image_id)?.alternate ?? row), changed };
}

export async function applyFalPostplanPromptCorrection({ episodeDir, bulkPlan, requestPath }) {
  const inspected = await inspectFalPostplanPromptCorrection({ episodeDir, bulkPlan });
  need(inspected.state !== "absent" && requestPath === inspected.paths.request,
    "Fal post-plan correction requires its exact episode-local request.");
  for (const [id, row] of inspected.changed)
    await writeExact(inspected.paths.alternate(id), row.alternate);
  await writeExact(inspected.paths.receipt, inspected.receipt);
  return { status: "approved", corrected_image_ids: inspected.receipt.corrected_image_ids,
    receipt_path: inspected.paths.receipt, receipt_sha256: await fileSha(inspected.paths.receipt) };
}
