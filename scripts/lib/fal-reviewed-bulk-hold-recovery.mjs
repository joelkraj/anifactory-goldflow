import { URL } from "node:url";

const sha256 = value => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const imageId = value => /^[a-z0-9][a-z0-9_-]{1,100}$/.test(String(value ?? ""));

function need(value, message) { if (!value) throw new Error(message); }

// A terminal provider observation permits one new, exact reviewed-repair
// attempt. The only creative change this route permits is deleting one exact
// span from the already reviewed prompt; the original assignment is immutable.
export function reviewedBulkHoldRecoveryPrompt({ directive, qaReportSha256, round,
  assignment, submission, hold, holdSha256, scriptText }) {
  need(directive?.schema === "goldflow_fal_reviewed_bulk_hold_recovery_v1",
    "Reviewed Fal hold recovery directive schema changed.");
  need(imageId(directive.image_id) && directive.image_id === assignment.image_id
    && directive.image_id === hold.image_id,
  "Reviewed Fal hold recovery image ID changed.");
  need(sha256(qaReportSha256) && directive.qa_report_sha256 === qaReportSha256
    && assignment.qa_report_sha256 === qaReportSha256,
  "Reviewed Fal hold recovery QA binding changed.");
  need(directive.round_stem === round.stem && directive.rejected_image_sha256 === assignment.rejected_image_sha256,
    "Reviewed Fal hold recovery round or rejected raster changed.");
  need(sha256(holdSha256) && directive.hold_sha256 === holdSha256
    && directive.failed_assignment_sha256 === assignment.assignment_sha256
    && hold.assignment_sha256 === assignment.assignment_sha256
    && submission.assignment_sha256 === assignment.assignment_sha256,
  "Reviewed Fal hold recovery assignment or hold binding changed.");
  need(directive.failed_request_id === hold.request_id
    && directive.failed_request_id === submission.request_id
    && submission.schema === "goldflow_fal_submission_receipt_v1"
    && submission.prompt_sha256 === assignment.prompt_sha256
    && submission.endpoint === assignment.endpoint
    && submission.run_identity_sha256 === assignment.run_identity_sha256
    && hold.reason === "provider_5xx_during_observation"
    && !hold.billable_request_resubmitted,
  "Reviewed Fal hold recovery request or provider failure changed.");
  const evidence = directive.terminal_provider_evidence;
  need(evidence?.request_id === hold.request_id && evidence.http_status === 504
    && evidence.result === "failed" && evidence.cost_display === "-",
  "Reviewed Fal hold recovery needs a terminal 504/no-cost provider observation.");
  let url;
  try { url = new URL(evidence.url); } catch { /* invalid URL */ }
  need(url?.protocol === "https:" && url.hostname === "fal.ai"
    && url.searchParams.get("s_requestId") === hold.request_id,
  "Reviewed Fal hold recovery provider evidence URL does not identify this request.");
  need(typeof directive.reviewer === "string" && directive.reviewer.trim().length > 1
    && typeof directive.note === "string" && directive.note.trim().length > 20,
  "Reviewed Fal hold recovery requires a reviewer and a substantive note.");
  need(typeof directive.source_quote === "string" && directive.source_quote.length > 12
    && scriptText.includes(directive.source_quote),
  "Reviewed Fal hold recovery source quote is absent from the locked script.");
  const from = directive.prompt_patch?.from;
  need(typeof from === "string" && from.length > 20
    && directive.prompt_patch.to === "" && assignment.prompt.split(from).length === 2,
  "Reviewed Fal hold recovery permits deleting exactly one existing prompt span.");
  const prompt = assignment.prompt.replace(from, "");
  need(prompt.length > 100 && prompt !== assignment.prompt,
    "Reviewed Fal hold recovery prompt did not change as reviewed.");
  return prompt;
}
