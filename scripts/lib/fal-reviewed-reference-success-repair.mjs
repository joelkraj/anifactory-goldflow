import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fileHash = async file => sha256(await fs.readFile(file));
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const exists = async file => fs.access(file).then(() => true, () => false);
function need(value, message) { if (!value) throw new Error(message); }

// This is a second, visual-review repair of successful v2 outputs. It must not
// reuse the provider-failure v3 path or silently broaden the first rejection set.
export async function validateFalReviewedReferenceSuccessRepair({ episodeDir, directivesPath, allowExistingAttempts = false }) {
  const root = path.join(episodeDir, "fal", "reference");
  const [directive, sourceScript, plan, referencePlan, firstReview] = await Promise.all([
    read(directivesPath), fs.readFile(path.join(episodeDir, "script_clean.md"), "utf8"),
    read(path.join(episodeDir, "visual_reference_plan.json")),
    read(path.join(episodeDir, "fal", "reference-plan.json")),
    read(path.join(root, "review-rejections.json")),
  ]);
  need(directive.schema === "goldflow_fal_reviewed_reference_success_repair_v1"
    && directive.status === "approved" && typeof directive.reviewer === "string" && directive.reviewer.trim()
    && typeof directive.note === "string" && directive.note.trim(), "Reviewed success repair lacks approval evidence.");
  need(directive.visual_reference_plan_sha256 === await fileHash(path.join(episodeDir, "visual_reference_plan.json"))
    && directive.reference_plan_sha256 === await fileHash(path.join(episodeDir, "fal", "reference-plan.json"))
    && directive.first_review_sha256 === await fileHash(path.join(root, "review-rejections.json")),
  "Reviewed success repair is stale against current reference inputs.");
  need(!await exists(path.join(episodeDir, `visual_reference_approval_${(await read(path.join(episodeDir, "run_identity.json"))).episode}.json`)),
    "Approved reference images cannot receive a second visual repair.");
  need(Array.isArray(directive.repairs) && directive.repairs.length > 0 && directive.repairs.length <= 2,
    "Reviewed success repair is limited to one or two exact reference IDs.");
  const ids = directive.repairs.map(row => row.image_id);
  need(new Set(ids).size === ids.length, "Reviewed success repair IDs must be unique.");
  const firstRejected = new Set(firstReview.rejections?.map(row => row.image_id));
  const checked = [];
  for (const row of directive.repairs) {
    const id = String(row.image_id ?? "");
    need(/^[a-z0-9][a-z0-9_-]{1,100}$/.test(id) && firstRejected.has(id),
      `Reviewed success repair ID is not in the original rejection set: ${id}`);
    const original = referencePlan.assignments.find(item => item.image_id === id);
    const selected = plan.reference_targets?.find(item => item.ref_id === id);
    const v2Assignment = await read(path.join(root, "review-repair-assignments", `${id}.json`));
    const v2Result = await read(path.join(root, "review-repair-result-receipts", `${id}.json`));
    need(original && selected && v2Assignment.previous_assignment_sha256 === original.assignment_sha256
      && v2Assignment.assignment_sha256 === row.v2_assignment_sha256
      && v2Result.output_sha256 === row.v2_result_sha256
      && v2Result.output_path === v2Assignment.output_path
      && selected.reference_image_path === v2Result.output_path
      && selected.conditioning_image_path === v2Result.output_path
      && await fileHash(v2Result.output_path) === v2Result.output_sha256,
      `Reviewed success repair source changed for ${id}`);
    need(allowExistingAttempts || (!await exists(path.join(root, "review-repair-v3-assignments", `${id}.json`))
      && !await exists(path.join(root, "review-repair-v3-submission-receipts", `${id}.json`))),
      `Reviewed success repair already attempted for ${id}`);
    need(typeof row.finding === "string" && row.finding.length > 20
      && typeof row.source_quote === "string" && row.source_quote.length > 10
      && sourceScript.includes(row.source_quote)
      && typeof row.replacement_prompt === "string" && row.replacement_prompt.length > 80
      && sha256(row.replacement_prompt) !== v2Assignment.prompt_sha256,
      `Reviewed success repair is missing source-backed changed instructions for ${id}`);
    const sourceId = String(row.reference_image_id ?? "");
    const source = plan.reference_targets?.find(item => item.ref_id === sourceId);
    need(source && sourceId !== id && path.isAbsolute(source.reference_image_path ?? "")
      && row.reference_sha256 === await fileHash(source.reference_image_path),
      `Reviewed success repair conditioning source changed for ${id}`);
    checked.push({ row, original, v2Assignment, v2Result, source });
  }
  return { directive, checked, ids };
}
