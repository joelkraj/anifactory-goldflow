import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";
import { pilotArtifactContainsPrivateData } from "./avatar-pilot-artifacts.mjs";
import { resolvePilotHostDesignRevision } from "./avatar-pilot-host-design-revision.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/u;
const POSE_IDS = Object.freeze(["host_open_palm", "host_presenting", "host_thinking", "host_skeptical", "host_confident"]);
const REQUEST_KEYS = new Set(["schema", "identity_sha256", "host_design_authority", "asset_plan", "asset_plan_approval",
  "generation_request", "submission_observation", "provider_observation", "generation_result", "operator_review",
  "native_output", "alpha_output", "alpha_receipt"]);
const same = (a, b) => a === undefined || b === undefined ? a === b : canonicalQwenBatchSha256(a) === canonicalQwenBatchSha256(b);
const need = (ok, message) => { if (!ok) throw new Error(`Host-identity approval blocked: ${message}`); };

export function pilotHostIdentityApprovalPaths(episodeDir) {
  const directory = path.join(episodeDir, "pilot_host_identity_approval");
  return { directory, approval: path.join(directory, "approval.json"), activation: path.join(directory, "activation.json") };
}

async function binding(file) { return { path: file, sha256: hash(await fs.readFile(file)) }; }
async function readBound(ref, { json = false } = {}) {
  need(ref && Object.keys(ref).every((key) => ["path", "sha256"].includes(key))
    && path.isAbsolute(ref.path) && HASH.test(ref.sha256 ?? ""), "exact absolute file binding required");
  const stat = await fs.lstat(ref.path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024
    && await fs.realpath(ref.path) === ref.path, "bounded regular file without symlink aliases required");
  const bytes = await fs.readFile(ref.path);
  need(hash(bytes) === ref.sha256, "bound file hash is stale");
  if (!json) return { bytes, ref: { ...ref } };
  const value = JSON.parse(bytes.toString("utf8"));
  need(value && typeof value === "object" && !Array.isArray(value) && !pilotArtifactContainsPrivateData(value),
    "JSON evidence is malformed or private");
  return { value, ref: { ...ref } };
}
async function events(episodeDir) {
  const file = path.join(episodeDir, "execution_events.jsonl");
  const stat = await fs.lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return [];
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024, "invalid execution history");
  return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function pngHasAlpha(bytes) {
  return bytes.length >= 26 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    && bytes.toString("ascii", 12, 16) === "IHDR" && [4, 6].includes(bytes[25]);
}

export async function preparePilotHostIdentityApproval({ episodeDir, identity, inputPath, reviewer, note }) {
  const paths = pilotHostIdentityApprovalPaths(episodeDir);
  need(!await fs.lstat(paths.directory).catch((error) => { if (error.code === "ENOENT") return null; throw error; }),
    "one approval already exists or is incomplete; inspect it, never replay");
  for (const name of ["pilot_media.json", "pilot_timeline.json", "pilot_timeline_approval.json", "pilot_render.json", "pilot_final_qa.json"])
    need(!await fs.lstat(path.join(episodeDir, name)).catch((error) => { if (error.code === "ENOENT") return null; throw error; }),
      `downstream artifact already exists: ${name}`);
  need(path.isAbsolute(inputPath) && !inputPath.startsWith(`${paths.directory}${path.sep}`), "separate absolute approval request required");
  const requestRef = await binding(inputPath), request = (await readBound(requestRef, { json: true })).value;
  need(Object.keys(request).every((key) => REQUEST_KEYS.has(key)) && Object.keys(request).length === REQUEST_KEYS.size
    && request.schema === "goldflow_avatar_pilot_host_identity_approval_request_v1", "request schema or fields are invalid");
  const identityRef = await binding(path.join(episodeDir, "run_identity.json"));
  need(request.identity_sha256 === identityRef.sha256 && same(identity, (await readBound(identityRef, { json: true })).value), "identity is stale");
  const revision = await resolvePilotHostDesignRevision({ episodeDir, identity });
  need(revision && same(request.host_design_authority, revision.authorization)
    && same(request.asset_plan, { path: revision.plan.path, sha256: revision.authorization ? (await binding(revision.plan.path)).sha256 : "" })
    && same(request.asset_plan_approval, { path: revision.approval.path, sha256: (await binding(revision.approval.path)).sha256 }),
  "current revised plan, approval and host-design authority are required");
  const designAuthority = (await readBound(revision.authorization, { json: true })).value;
  need(designAuthority.dependent_pose_generation_authorized === false, "replacement authority must leave dependent poses blocked");
  const generationRequest = (await readBound(request.generation_request, { json: true })).value;
  const submission = (await readBound(request.submission_observation, { json: true })).value;
  const provider = (await readBound(request.provider_observation, { json: true })).value;
  const result = (await readBound(request.generation_result, { json: true })).value;
  const review = (await readBound(request.operator_review, { json: true })).value;
  const native = await readBound(request.native_output);
  const alpha = await readBound(request.alpha_output);
  const alphaReceipt = (await readBound(request.alpha_receipt, { json: true })).value;
  need(generationRequest.asset_id === "host_neutral" && generationRequest.attempt_number === 2
    && same(generationRequest.replacement_authority, revision.authorization)
    && submission.asset_id === "host_neutral" && submission.attempt_number === 2 && submission.creative_submission_count === 2
    && provider.asset_id === "host_neutral" && provider.attempt_number === 2 && provider.creative_submission_count === 2
    && result.asset_id === "host_neutral" && result.attempt_number === 2 && result.creative_submission_count === 2
    && result.native_output?.sha256 === request.native_output.sha256,
  "replacement generation lineage is invalid");
  need(review.schema === "goldflow_avatar_pilot_host_identity_operator_review_v1" && review.asset_id === "host_neutral"
    && review.approved === true && review.decision === "accepted" && review.reviewer === reviewer
    && review.reviewed_candidate?.sha256 === request.native_output.sha256,
  "exact operator identity acceptance is required");
  need(alphaReceipt.schema === "goldflow_avatar_pilot_technical_alpha_extraction_v1" && alphaReceipt.asset_id === "host_neutral"
    && alphaReceipt.creative_submission === false && alphaReceipt.input?.sha256 === request.native_output.sha256
    && alphaReceipt.output?.sha256 === request.alpha_output.sha256 && alphaReceipt.output?.has_alpha === true
    && alphaReceipt.inspection_preview?.result === "pass" && pngHasAlpha(alpha.bytes),
  "reviewed real-alpha cutout lineage is invalid");
  const plan = revision.plan.row.payload;
  need(same(plan.assets.filter((row) => row.kind === "host_pose" && row.id !== "host_neutral").map((row) => row.id), POSE_IDS)
    && plan.assets.filter((row) => POSE_IDS.includes(row.id)).every((row) => same(row.reference_asset_ids, ["host_neutral"])),
  "exact five dependent poses and neutral reference are required");
  need(typeof reviewer === "string" && reviewer.trim() && typeof note === "string" && note.trim(), "reviewer and note required");
  return { paths, request, requestRef, identityRef, revision, native: native.ref, alpha: alpha.ref,
    reviewer: reviewer.trim(), note: note.trim(), dependentPoseIds: [...POSE_IDS] };
}

export async function resolvePilotHostIdentityApproval({ episodeDir, identity } = {}) {
  const paths = pilotHostIdentityApprovalPaths(episodeDir);
  const dir = await fs.lstat(paths.directory).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  const recorded = (await events(episodeDir)).filter((row) => row.action === "approve-host-identity" && row.status === "passed");
  if (!dir) { need(recorded.length === 0, "recorded approval namespace is missing"); return null; }
  need(dir.isDirectory() && !dir.isSymbolicLink() && same((await fs.readdir(paths.directory)).sort(), ["activation.json", "approval.json"]),
    "approval namespace is partial or has unexpected files");
  const activation = (await readBound(await binding(paths.activation), { json: true })).value;
  need(activation.schema === "goldflow_avatar_pilot_host_identity_approval_activation_v1"
    && same(activation.approval, await binding(paths.approval)), "activation binding is stale");
  const approval = (await readBound(activation.approval, { json: true })).value;
  const request = (await readBound(approval.request, { json: true })).value;
  const identityRef = await binding(path.join(episodeDir, "run_identity.json"));
  const revision = await resolvePilotHostDesignRevision({ episodeDir, identity });
  need(approval.schema === "goldflow_avatar_pilot_host_identity_approval_v1" && approval.status === "authorized"
    && approval.identity_sha256 === identityRef.sha256 && request.identity_sha256 === identityRef.sha256
    && same(approval.host_design_authority, revision.authorization) && same(approval.asset_plan, { path: revision.plan.path, sha256: (await binding(revision.plan.path)).sha256 })
    && same(approval.asset_plan_approval, { path: revision.approval.path, sha256: (await binding(revision.approval.path)).sha256 })
    && approval.accepted_neutral_asset_id === "host_neutral" && same(approval.accepted_native_output, request.native_output)
    && same(approval.accepted_alpha_output, request.alpha_output) && same(approval.operator_review, request.operator_review)
    && same(approval.alpha_receipt, request.alpha_receipt) && same(approval.dependent_pose_asset_ids, POSE_IDS)
    && approval.creative_submissions_per_pose === 1 && approval.attempt_number_per_pose === 1
    && approval.external_inspiration_for_dependent_poses === false && approval.automatic_retry === false
    && approval.automatic_failover === false && approval.production_eligible === false && approval.publish_allowed === false,
  "approval authority is stale");
  need(recorded.length === 1 && same(recorded[0], (await readBound(activation.execution_report, { json: true })).value),
    "append-only approval audit is missing or duplicated");
  const audit = recorded[0];
  need(audit.schema === "goldflow_avatar_pilot_execution_v1" && audit.action === "approve-host-identity"
    && audit.identity_sha256 === identityRef.sha256 && same(audit.output, activation.approval)
    && audit.creative_submissions === 0 && audit.provider_cost === 0 && audit.synthesis_invoked === false
    && audit.generation_authorized === true && audit.production_eligible === false && audit.publish_allowed === false,
  "approval execution audit is stale");
  return { approval: activation.approval, row: approval, request, revision, execution_report: activation.execution_report };
}
