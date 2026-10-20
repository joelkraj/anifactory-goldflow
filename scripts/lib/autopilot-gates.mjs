import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { autopilotEnabled, automatedReviewer } from "./autopilot-policy.mjs";
import { episodeBudgetFor } from "./episode-budget.mjs";
import {
  fillMechanicalPlaceholders, flagValue, goldflowArgv, placeholdersIn, removeFlag, setFlag, useEpisodeBudgetToken,
} from "./autopilot-command-shape.mjs";
import { REVIEW_RULES } from "./autopilot-reviewer.mjs";

// Each automatic gate decision returns the exact goldflow argv that writes the
// gate's normal approval artifact, plus a receipt describing why. A gate that
// cannot be decided honestly returns { kind: "triage" } — never a guess.

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const MAX_PLAN_CHARS = 60_000;

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function writeNew(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return filePath;
}
const triage = (stage, reason, findings = []) => ({ kind: "triage", stage, reason, findings });
const run = (stage, argv, receipt) => ({ kind: "run", stage, argv, receipt });
const stripPlaceholderFlags = (argv) => {
  let out = [...argv];
  for (let index = out.length - 1; index > 0; index -= 1) {
    if (/<[^<>]+>/.test(out[index]) && out[index - 1].startsWith("--")) out = removeFlag(out, out[index - 1].slice(2));
  }
  return out;
};
const episodeOf = (status, episodeDir) => status.identity?.episode ?? path.basename(episodeDir);
const truncate = (text, max = MAX_PLAN_CHARS) => (text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text);

function validVerdict(verdict) {
  const problems = [];
  if (!["approve", "reject"].includes(verdict?.verdict)) problems.push("verdict must be approve or reject");
  if (typeof verdict?.note !== "string" || verdict.note.trim().length < 20) problems.push("note must be at least 20 characters");
  if (verdict?.findings != null && !Array.isArray(verdict.findings)) problems.push("findings must be an array");
  return problems;
}

/* ---------- script approval ---------- */

// On registry ≥ 2026-10-20.1 identities the audit is its own registered stage
// (`script power-audit --author planner`, scripts/lib/script-comprehension-audit.mjs)
// and runs before this gate is reached; the candidate authoring below is the
// historical-registry fallback and shares that stage's prompt and offset filling.
async function scriptApproval({ status, episodeDir, argv, deps }) {
  const stage = "script_approval";
  const ingest = status.stage_ledger?.find((row) => row.stage === "source_ingest");
  if (ingest?.state !== "passed") return triage(stage, "source ingest has not passed");
  const scriptPath = path.join(episodeDir, "script_clean.md");
  const script = await fs.readFile(scriptPath, "utf8");
  const scriptHash = sha256(script);
  const { scanScriptMetaContamination } = await import("./script-meta-contamination-scan.mjs");
  const { validatePowerSystemComprehensionAudit } = await import("./power-system-comprehension-contract.mjs");
  const scan = scanScriptMetaContamination(script);
  if (scan.status !== "passed") return triage(stage, "script meta-contamination scan failed; the approved script is never edited automatically", scan.blockers ?? []);
  const auditPath = path.join(episodeDir, "power_system_comprehension_audit.json");
  const audit = await readJson(auditPath);
  const auditValidation = audit ? validatePowerSystemComprehensionAudit(audit, script) : null;
  if (!audit || audit.source_script_hash !== scriptHash) {
    if (status.stage_ledger?.some((row) => row.stage === "script_comprehension_audit")) {
      return triage(stage, "script_comprehension_audit is a registered stage on this identity and has not passed for the current script; it is not re-authored here");
    }
    // The audit is authored by the model reviewer and verified deterministically (exact excerpts and offsets).
    const { comprehensionAuditPrompt, comprehensionContractSource, fillAnchorOffsets } = await import("./script-comprehension-audit.mjs");
    const candidate = await deps.reviewer({
      task: "power_system_audit",
      prompt: comprehensionAuditPrompt({ script, contractSource: await comprehensionContractSource(), rules: REVIEW_RULES }),
      validate: (value) => (typeof value?.power_system_present === "boolean" ? [] : ["power_system_present must be boolean"]),
    });
    const inputPath = await writeNew(path.join(episodeDir, "autopilot", "requests", `power_audit_candidate_${scriptHash.slice(0, 16)}.json`), fillAnchorOffsets(candidate, script));
    return run(stage, ["script", "power-audit", "--episode-dir", episodeDir, "--input", inputPath, "--reviewed-by", automatedReviewer("model_reviewer")], {
      method: "model_reviewer", decision: "execute", note: "Authored the power-system comprehension audit candidate for deterministic validation.",
      evidence: [{ role: "script", path: scriptPath }, { role: "candidate", path: inputPath }], repairKey: `power_audit:${scriptHash}`,
    });
  }
  if (audit.status !== "passed" || auditValidation?.status !== "passed") {
    return triage(stage, "power-system comprehension audit is blocked for this script", auditValidation?.blockers ?? []);
  }
  let out = setFlag(argv, "hash", scriptHash);
  out = setFlag(out, "approved-by", automatedReviewer("deterministic_script_checks"));
  out = setFlag(out, "summary", "Automated approval: source ingest passed, meta-contamination scan passed, power-system comprehension audit passed for this exact script hash.");
  return run(stage, out, {
    method: "deterministic_script_checks", decision: "approve",
    note: `Approved exact script hash ${scriptHash}.`,
    evidence: [{ role: "script", path: scriptPath }, { role: "power_system_audit", path: auditPath }],
  });
}

/* ---------- planning and reference gates ---------- */

async function referencePlanApproval({ status, episodeDir, argv, deps }) {
  const stage = "reference_plan_approval";
  const planPath = path.join(episodeDir, "visual_reference_plan.json");
  const planText = await fs.readFile(planPath, "utf8");
  const verdict = await deps.reviewer({
    task: "reference_plan",
    prompt: `${REVIEW_RULES}\nReview this Reference Director plan for a ${status.identity?.content_profile ?? "manhwa_recap_v1"} episode. Approve if every recurring character, location and prop that the beats need has a coherent, non-duplicated reference with a clear identity description, and nothing contradicts the story facts. Return {"verdict":"approve"|"reject","note":"…","findings":["…"]}.\n\nPLAN:\n${truncate(planText)}`,
    validate: validVerdict,
  });
  if (verdict.verdict !== "approve") return triage(stage, "model reviewer rejected the reference plan; an exact repair recipe is creative work", verdict.findings ?? [verdict.note]);
  let out = stripPlaceholderFlags(argv);
  const reviewerFlag = argv[0] === "visual" && argv[1] === "openart-bank" ? "reviewer" : "approved-by";
  out = setFlag(out, reviewerFlag, automatedReviewer("model_reviewer"));
  out = setFlag(out, "note", `Automated reference plan review: ${verdict.note}`);
  return run(stage, out, { method: "model_reviewer", decision: "approve", note: verdict.note, findings: verdict.findings ?? [], evidence: [{ role: "reference_plan", path: planPath }] });
}

async function referenceImages(episodeDir) {
  const dir = path.join(episodeDir, "assets", "images", "references");
  const names = await fs.readdir(dir).catch(() => []);
  return names.filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort().map((name) => path.join(dir, name));
}

async function referenceImageApproval({ status, episodeDir, argv, deps }) {
  const stage = "reference_image_approval";
  const action = flagValue(argv, "action");
  if (argv[0] === "imagegen" && argv[1] === "fal" && action === "review-validation") {
    const planPath = await readJson(path.join(episodeDir, "fal", "validation-plan-v2.json"))
      ? path.join(episodeDir, "fal", "validation-plan-v2.json") : path.join(episodeDir, "fal", "validation-plan.json");
    const plan = await readJson(planPath);
    const candidates = [];
    for (const row of plan?.assignments ?? []) {
      const receipt = await readJson(row.result_receipt_path);
      if (!receipt?.output_path) return triage(stage, `validation result missing for ${row.image_id}`);
      candidates.push({ image_id: row.image_id, image: receipt.output_path, prompt: String(row.prompt ?? "").slice(0, 1500) });
    }
    const ids = candidates.map((row) => row.image_id);
    const verdict = await deps.reviewer({
      task: "fal_validation_review",
      images: candidates.map((row) => row.image),
      prompt: `${REVIEW_RULES}\nThese images are the Fal validation set, in this order:\n${candidates.map((row, index) => `${index + 1}. ${row.image_id}: ${row.prompt}`).join("\n")}\nApprove an image when it is production grade for its prompt (identity, composition, no garbled anatomy or text). Return {"approve_ids":[…],"reject_ids":[…],"note":"…","findings":["image_id: defect"]} covering every id exactly once.`,
      validate: (value) => {
        const all = [...(value?.approve_ids ?? []), ...(value?.reject_ids ?? [])];
        return all.length === ids.length && new Set(all).size === ids.length && all.every((id) => ids.includes(id)) && String(value?.note ?? "").length >= 20
          ? [] : ["approve_ids and reject_ids must partition the validation ids, with a note"];
      },
    });
    let out = stripPlaceholderFlags(argv);
    out = setFlag(out, "reviewer", automatedReviewer("model_reviewer"));
    out = setFlag(out, "note", `Automated validation review: ${verdict.note}`);
    out = setFlag(out, "approve-ids", verdict.approve_ids.join(","));
    out = setFlag(out, "reject-ids", verdict.reject_ids.join(","));
    return run(stage, out, { method: "model_reviewer", decision: verdict.reject_ids.length ? "reject" : "approve", note: verdict.note, findings: verdict.findings ?? [], evidence: [{ role: "validation_plan", path: planPath }] });
  }
  if (argv[0] === "visual" && argv[1] === "approve-refs") {
    const images = (await referenceImages(episodeDir)).slice(0, 24);
    const verdict = await deps.reviewer({
      task: "reference_images",
      images,
      prompt: `${REVIEW_RULES}\nThese are the generated canonical reference images (file names identify them). Approve when each is a clean reference: one subject (or one clean location plate), no stray text, no extra people, no broken anatomy. Return {"verdict":"approve"|"reject","note":"…","findings":["file: defect"]}.`,
      validate: validVerdict,
    });
    if (verdict.verdict !== "approve") return triage(stage, "model reviewer rejected generated references; reference QA recovery needs exact ids", verdict.findings ?? [verdict.note]);
    let out = removeFlag(stripPlaceholderFlags(argv), "cleanliness-reviewed");
    out = setFlag(out, "agent-review", "true");
    out = setFlag(out, "approved-by", automatedReviewer("model_reviewer"));
    out = setFlag(out, "note", `Automated reference review (decoded raster + model): ${verdict.note}`);
    return run(stage, out, { method: "model_reviewer", decision: "approve", note: verdict.note, findings: verdict.findings ?? [], evidence: images.map((image) => ({ role: "reference_image", path: image })) });
  }
  if (argv[0] === "visual" && argv[1] === "openart-bank" && action === "approve-refs") return triage(stage, "OpenArt reference approval is outside the autopilot route");
  return null;
}

/* ---------- image QA and repair routing ---------- */

const AUTOMATED_FLAGS = new Set(["semantic_audit_needs_review", "zone_lettering_garbled"]);

/** Accept when the automated checks ran and passed; only flagged cuts go to the model. */
export function classifyRiskCut(row) {
  const reasons = row?.risk_reasons ?? [];
  const flagged = reasons.filter((reason) => AUTOMATED_FLAGS.has(reason));
  const semanticChecked = reasons.some((reason) => String(reason).startsWith("semantic:"));
  if (flagged.length) return { automated: false, why: flagged };
  if (!semanticChecked) return { automated: false, why: ["no_semantic_audit_for_risk_cut"] };
  return { automated: true, why: ["semantic_audit_passed", "geometry_and_lettering_clear"] };
}

async function promptRows(episodeDir) {
  const plan = await readJson(path.join(episodeDir, "section_image_prompts_hardened.json"));
  return new Map((Array.isArray(plan) ? plan : plan?.prompts ?? []).map((row) => [row.image_id, row]));
}

const verdictPath = (episodeDir, imageId, imageSha) => path.join(episodeDir, "autopilot", "image_qa_verdicts", `${imageId}_${String(imageSha).slice(0, 16)}.json`);

async function imageQaDecisions({ status, episodeDir, argv, deps }) {
  const stage = "image_output_qa";
  const episode = episodeOf(status, episodeDir);
  const decisionsPath = path.join(episodeDir, `image_output_review_decisions_${episode}.json`);
  const decisions = await readJson(decisionsPath);
  const pending = (decisions?.decisions ?? []).filter((row) => row.decision === "not_inspected");
  if (!pending.length) return null;
  const prompts = await promptRows(episodeDir);
  const accept = [];
  const critical = [];
  const findings = [];
  for (const row of pending) {
    const kind = classifyRiskCut(row);
    if (kind.automated) { accept.push(row.image_id); continue; }
    const prompt = prompts.get(row.image_id);
    const verdict = await deps.reviewer({
      task: "image_qa_cut",
      images: [row.review_image_path ?? row.image_path],
      prompt: `${REVIEW_RULES}\nCut ${row.image_id} was flagged by automated checks: ${kind.why.join(", ")} (risks: ${(row.risk_reasons ?? []).join(", ")}).\nShot prompt:\n${truncate(String(prompt?.prompt ?? prompt?.image_prompt ?? ""), 4000)}\nReject only for a material story, identity, anatomy or garbled-lettering defect. When rejecting, author a complete single-artwork replacement prompt (at least 120 characters) that fixes only that defect. Return {"verdict":"approve"|"reject","note":"…","defect":"…","replacement_prompt":"…"}.`,
      validate: (value) => [...validVerdict(value), ...(value?.verdict === "reject" && String(value?.replacement_prompt ?? "").length < 120 ? ["a rejection needs a replacement_prompt of at least 120 characters"] : [])],
    });
    await writeNew(verdictPath(episodeDir, row.image_id, row.image_sha256), { image_id: row.image_id, image_sha256: row.image_sha256, risk_reasons: row.risk_reasons, ...verdict });
    findings.push(`${row.image_id}: ${verdict.verdict} — ${verdict.note}`);
    (verdict.verdict === "approve" ? accept : critical).push(row.image_id);
  }
  let out = stripPlaceholderFlags(argv);
  if (accept.length) out = setFlag(out, "accept-cut-ids", accept.join(","));
  if (critical.length) out = setFlag(out, "critical-reject-cut-ids", critical.join(","));
  out = setFlag(out, "reviewer", automatedReviewer("image_qa_v1"));
  out = setFlag(out, "note", `Automated image QA: ${accept.length} accepted (${pending.length - findings.length} on passed automated checks), ${critical.length} rejected for exact repair.`);
  return run(stage, out, { method: "image_qa_v1", decision: critical.length ? "reject" : "approve", findings,
    note: `accepted=${accept.join(",") || "none"}; critical_rejected=${critical.join(",") || "none"}`, evidence: [{ role: "review_decisions", path: decisionsPath }] });
}

async function zoneRepairRequest({ status, episodeDir, argv, deps }) {
  const stage = "image_output_qa";
  const episode = episodeOf(status, episodeDir);
  const evidence = status.stage_ledger?.find((row) => row.stage === stage)?.evidence ?? "";
  const zones = (evidence.match(/zones=([^;]+)/)?.[1] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const prompts = await promptRows(episodeDir);
  const ledger = await readJson(path.join(episodeDir, "cut_execution_ledger.json"));
  const cuts = new Map((ledger?.cuts ?? []).map((row) => [row.image_id, row]));
  for (const zoneId of zones) {
    if (deps.repairLedger.has(`zone:${zoneId}`)) continue;
    const rows = [...prompts.values()].filter((row) => row.panel_zone_id === zoneId);
    const pageAssetId = rows[0]?.panel_asset_id;
    const pageSha = cuts.get(rows[0]?.image_id)?.image_sha256;
    let verdict = null;
    for (const row of rows) verdict ??= await readJson(verdictPath(episodeDir, row.image_id, pageSha));
    if (!pageAssetId || !pageSha || verdict?.verdict !== "reject") {
      return triage(stage, `zone ${zoneId} is blocked without an automated rejection to repair from (geometry or manual finding)`);
    }
    const request = {
      schema: "goldflow_panel_zone_repair_request_v1", episode, zone_id: zoneId, page_asset_id: pageAssetId,
      rejected_page_sha256: pageSha, actual_review: true, reviewer: automatedReviewer("model_reviewer"),
      note: `Automated image QA rejected ${verdict.image_id}: ${verdict.note}`, reason: verdict.defect && verdict.defect.length >= 20 ? verdict.defect : `Material defect found by automated review: ${verdict.note}`,
      replacement_prompt: verdict.replacement_prompt, evidence: "review_rejected",
    };
    const requestPath = await writeNew(path.join(episodeDir, "autopilot", "requests", `zone_repair_${zoneId}_${pageSha.slice(0, 12)}.json`), request);
    return run(stage, setFlag(stripPlaceholderFlags(argv), "request", requestPath), {
      method: "model_reviewer", decision: "repair", note: `One exact zone repair for ${zoneId}.`, findings: [verdict.note],
      evidence: [{ role: "zone_repair_request", path: requestPath }], repairKey: `zone:${zoneId}`,
    });
  }
  return triage(stage, `every blocked zone (${zones.join(", ") || "unknown"}) already had its one automatic repair`);
}

async function reviewedBulkDirectives({ status, episodeDir, argv, deps }) {
  const stage = "image_output_qa";
  const episode = episodeOf(status, episodeDir);
  const qaPath = path.join(episodeDir, `image_output_qa_${episode}.json`);
  const qa = await readJson(qaPath);
  const bulk = await readJson(path.join(episodeDir, "fal", "bulk-plan.json"));
  const ledger = await readJson(path.join(episodeDir, "cut_execution_ledger.json"));
  const cuts = new Map((ledger?.cuts ?? []).map((row) => [row.image_id, row]));
  const repairs = [];
  for (const imageId of qa?.critical_rejected_image_ids ?? []) {
    if (deps.repairLedger.has(`owner:${imageId}`)) return triage(stage, `${imageId} already had its one automatic owner repair`);
    const cut = cuts.get(imageId);
    const verdict = cut ? await readJson(verdictPath(episodeDir, imageId, cut.image_sha256)) : null;
    const original = bulk?.assignments?.find((row) => row.image_id === imageId);
    if (!cut || !original || verdict?.verdict !== "reject") return triage(stage, `${imageId} has no automated rejection with a replacement prompt`);
    repairs.push({ image_id: imageId, rejected_image_sha256: cut.image_sha256, original_assignment_sha256: original.assignment_sha256,
      finding: `Automated review: ${verdict.note}`, replacement_prompt: verdict.replacement_prompt });
  }
  if (!repairs.length) return triage(stage, "no critical rejections to repair");
  const directives = { schema: "goldflow_fal_reviewed_bulk_repair_directives_v1", qa_report_sha256: sha256(await fs.readFile(qaPath)), reviewer: automatedReviewer("model_reviewer"), repairs };
  const directivesPath = await writeNew(path.join(episodeDir, "autopilot", "requests", `reviewed_bulk_repair_${directives.qa_report_sha256.slice(0, 12)}.json`), directives);
  return run(stage, setFlag(stripPlaceholderFlags(argv), "directives", directivesPath), {
    method: "model_reviewer", decision: "repair", note: `One exact owner repair for ${repairs.map((row) => row.image_id).join(", ")}.`,
    evidence: [{ role: "directives", path: directivesPath }, { role: "image_qa", path: qaPath }], repairKey: repairs.map((row) => `owner:${row.image_id}`),
  });
}

/* ---------- agent-review gates that already exist ---------- */

function agentReviewGate(stage, method, reviewerFlag, note) {
  return ({ argv }) => {
    let out = stripPlaceholderFlags(argv);
    out = removeFlag(out, "approve");
    out = setFlag(out, "agent-review", "true");
    out = setFlag(out, reviewerFlag, automatedReviewer(method));
    out = setFlag(out, "note", note);
    return run(stage, out, { method, decision: "approve", note });
  };
}

async function panelAllocationImport({ episodeDir, argv }) {
  const stage = "visual_prompt_plan";
  const root = path.join(episodeDir, "reports", "panel_assets", "dense-author");
  const reports = [];
  for (const job of await fs.readdir(root).catch(() => [])) {
    for (const name of await fs.readdir(path.join(root, job)).catch(() => [])) {
      if (/^report-\d+\.json$/.test(name)) reports.push(path.join(root, job, name));
    }
  }
  reports.sort((a, b) => Number(path.basename(b).match(/\d+/)[0]) - Number(path.basename(a).match(/\d+/)[0]));
  const latest = reports.length ? await readJson(reports[0]) : null;
  if (!latest || latest.status !== "candidate_ready") {
    return run(stage, ["visual", "panel-assets", "--episode-dir", episodeDir, "--action", "author-dense"], {
      method: "allocation_validator", decision: "execute", note: "No ready dense allocation candidate; author one with the locked planner.",
      repairKey: latest ? `dense_author:${path.basename(path.dirname(reports[0]))}` : null,
    });
  }
  const blockers = (latest.findings ?? []).filter((row) => row.severity === "blocker");
  if (blockers.length) return triage(stage, "dense allocation candidate has blocker findings", blockers.map((row) => row.message ?? row.code));
  return run(stage, setFlag(stripPlaceholderFlags(argv), "plan", latest.candidate_path), {
    method: "allocation_validator", decision: "approve", note: `Import validated dense candidate (${latest.density?.beats_per_image ?? "?"} beats/image).`,
    findings: (latest.findings ?? []).map((row) => row.message ?? row.code), evidence: [{ role: "author_report", path: reports[0] }, { role: "candidate", path: latest.candidate_path }],
  });
}

/* ---------- dispatcher ---------- */

const HANDLERS = [
  { stage: "script_approval", match: (argv) => argv[0] === "script" && argv[1] === "approve", handle: scriptApproval },
  { stage: "visual_beat_plan", match: (argv) => argv[0] === "visual" && argv[1] === "beats",
    handle: ({ argv }) => run("visual_beat_plan", flagValue(argv, "approved-by") ? argv : setFlag(argv, "approved-by", automatedReviewer("beat_plan_validator")),
      { method: "beat_plan_validator", decision: "execute", note: "The beat planner's coverage/state/lock validator writes the approval." }) },
  { stage: "reference_plan_approval", match: (argv) => argv[1] === "approve-ref-plan" || flagValue(argv, "action") === "approve-plan", handle: referencePlanApproval },
  { stage: "reference_image_approval", match: () => true, handle: referenceImageApproval },
  { stage: "image_output_qa", match: (argv) => argv[0] === "imagegen" && argv[1] === "qa", handle: imageQaDecisions },
  { stage: "image_output_qa", match: (argv) => flagValue(argv, "action") === "prepare-zone-repair", handle: zoneRepairRequest },
  { stage: "image_output_qa", match: (argv) => flagValue(argv, "action") === "repair-reviewed-bulk", handle: reviewedBulkDirectives },
  { stage: "generated_video_motion_approval", match: (argv) => argv[1] === "approve-generated-motion",
    handle: agentReviewGate("generated_video_motion_approval", "motion_coherence_audit", "reviewer", "Automated: coherence-audit passes approved; others fall back to accepted stills.") },
  { stage: "parallax_asset_approval", match: (argv) => argv[1] === "approve-parallax",
    handle: agentReviewGate("parallax_asset_approval", "parallax_separation_policy", "reviewer", "Automated: local separation policy decisions; declined candidates fall back to stills.") },
  { stage: "final_qa", match: (argv) => argv[0] === "final" && argv[1] === "qa",
    handle: agentReviewGate("final_qa", "final_master_integrity", "approved-by", "Automated: approve only with no material master blockers; advisory diagnostics recorded.") },
  { stage: "visual_prompt_plan", match: (argv) => argv[1] === "panel-assets" && placeholdersIn(argv).length > 0, handle: panelAllocationImport },
];

/**
 * Decides the next step for the current status. Returns one of:
 *  { kind: "stop", reason, detail }  – final watch, publish approval, complete
 *  { kind: "run", stage, argv, receipt } – exact goldflow argv to execute
 *  { kind: "triage", stage, reason, findings } – nothing honest to do automatically
 */
export async function decideNext({ status, episodeDir, deps }) {
  const stage = status.current_stage;
  const identity = status.identity ?? {};
  if (stage === "complete") return { kind: "stop", reason: "complete", detail: "All stages passed." };
  if (stage === "final_watch") return { kind: "stop", reason: "final_watch", detail: status.final_watch_video_path ?? status.next_command_shape };
  if (stage === "youtube_pinned_comment" && autopilotEnabled(identity)) return { kind: "stop", reason: "publish_approval", detail: status.next_command_shape };
  const shape = status.next_command_shape;
  const rawArgv = goldflowArgv(shape);
  if (!rawArgv) return triage(stage, `status gives no executable command (${status.current_stage_state}): ${shape ?? "none"}`);
  if (/\btts approve-(listen|subjective)\b/.test(shape)) return triage(stage, "listening attestation requested; autopilot never claims to have listened (legacy narration contract)");
  const scriptPath = path.join(episodeDir, "script_clean.md");
  const scriptHash = await fs.readFile(scriptPath).then(sha256, () => null);
  let argv = fillMechanicalPlaceholders(rawArgv, { episodeDir, values: scriptHash ? { script_clean_hash: scriptHash } : {} });
  argv = useEpisodeBudgetToken(argv, { budgetLocked: Boolean(episodeBudgetFor(identity)) });
  for (const handler of HANDLERS) {
    if (handler.stage !== stage || !handler.match(argv)) continue;
    const decision = await handler.handle({ status, episodeDir, argv, deps });
    if (decision) return decision;
  }
  const left = placeholdersIn(argv);
  if (left.length) return triage(stage, `command needs authored input that autopilot cannot supply: ${left.join(", ")}`);
  return run(stage, argv, { method: "status_command", decision: "execute", note: "Concrete status command shape." });
}
