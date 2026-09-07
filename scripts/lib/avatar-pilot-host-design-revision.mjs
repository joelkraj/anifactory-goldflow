import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";
import { validatePilotAssetPlan, pilotArtifactContainsPrivateData } from "./avatar-pilot-artifacts.mjs";
import { resolvePilotAssetPlanStage } from "./avatar-pilot-asset-plan-revision.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/u;
const same = (a, b) => a === undefined || b === undefined ? a === b : canonicalQwenBatchSha256(a) === canonicalQwenBatchSha256(b);
const need = (ok, message) => { if (!ok) throw new Error(`Host-design revision blocked: ${message}`); };
const HOST_IDS = Object.freeze(["host_neutral", "host_open_palm", "host_presenting", "host_thinking", "host_skeptical", "host_confident"]);
const REQUEST_KEYS = new Set(["schema", "identity_sha256", "prior_plan", "prior_approval", "prior_attempt", "new_plan", "replacement_prompt", "external_inspiration_bindings"]);

export function pilotHostDesignRevisionPaths(episodeDir) {
  const directory = path.join(episodeDir, "pilot_host_design_revision");
  return { directory, receipt: path.join(directory, "revision.json"), plan: path.join(directory, "pilot_asset_plan.json"),
    approval: path.join(directory, "pilot_asset_plan_approval.json"), authorization: path.join(directory, "authorization.json"),
    activation: path.join(directory, "activation.json") };
}

async function readBound(ref, { json = false } = {}) {
  need(ref && Object.keys(ref).every((key) => ["id", "path", "sha256", "role"].includes(key))
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
async function binding(file) { return { path: file, sha256: hash(await fs.readFile(file)) }; }
async function events(episodeDir) {
  const file = path.join(episodeDir, "execution_events.jsonl");
  const stat = await fs.lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return [];
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024, "invalid execution history");
  return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function validatePilotHostDesignDelta({ priorPlan, nextPlan, identity, externalInspirationBindings }) {
  for (const plan of [priorPlan, nextPlan]) need(validatePilotAssetPlan(plan, identity).status === "passed", "asset plan validation failed");
  need(Array.isArray(externalInspirationBindings) && externalInspirationBindings.length <= 1, "at most one inspiration binding is allowed");
  for (const ref of externalInspirationBindings) need(ref.id === "mask_inspiration" && ref.role === "external_inspiration"
    && path.isAbsolute(ref.path) && HASH.test(ref.sha256 ?? ""), "invalid external inspiration binding");
  const priorRows = priorPlan.assets, nextRows = nextPlan.assets;
  need(priorRows.length === nextRows.length && priorRows.every((row, index) => row.id === nextRows[index].id),
    "asset IDs, order and count are immutable");
  const hosts = priorRows.filter((row) => row.kind === "host_pose").map((row) => row.id);
  need(same(hosts, HOST_IDS), "host-only revision requires the exact six planned host pose IDs");
  for (let index = 0; index < priorRows.length; index++) {
    const before = priorRows[index], after = nextRows[index];
    if (before.kind !== "host_pose") need(same(before, after), `non-host asset changed: ${before.id}`);
    else {
      const a = { ...before }, b = { ...after }; delete a.purpose; delete b.purpose;
      need(same(a, b) && typeof after.purpose === "string" && after.purpose.trim(), `host scope changed beyond purpose: ${before.id}`);
    }
  }
  const a = structuredClone(priorPlan), b = structuredClone(nextPlan); delete a.assets; delete b.assets;
  const priorArt = { ...(a.art_direction ?? {}) }, nextArt = { ...(b.art_direction ?? {}) };
  for (const key of ["host", "host_delivery", "host_external_inspiration_bindings"]) { delete priorArt[key]; delete nextArt[key]; }
  a.art_direction = priorArt; b.art_direction = nextArt;
  need(same(a, b), "only host art direction and host-pose purposes may change");
  need(typeof nextPlan.art_direction?.host === "string" && nextPlan.art_direction.host.trim()
    && typeof nextPlan.art_direction?.host_delivery === "string" && nextPlan.art_direction.host_delivery.trim(),
  "complete replacement host art direction required");
  need(same(nextPlan.art_direction.host_external_inspiration_bindings, externalInspirationBindings),
    "plan inspiration bindings differ from request");
  return { affected_asset_ids: [...HOST_IDS], changed_art_direction_keys: ["host", "host_delivery", "host_external_inspiration_bindings"] };
}

export async function preparePilotHostDesignRevision({ episodeDir, identity, inputPath, reviewer, note }) {
  const paths = pilotHostDesignRevisionPaths(episodeDir);
  need(!await fs.lstat(paths.directory).catch((error) => { if (error.code === "ENOENT") return null; throw error; }),
    "one host-design revision already exists or is incomplete; inspect it, never replay");
  for (const name of ["pilot_media.json", "pilot_timeline.json", "pilot_timeline_approval.json", "pilot_render.json", "pilot_final_qa.json", "pilot_render_work", "pilot_proof_90s.mp4"])
    need(!await fs.lstat(path.join(episodeDir, name)).catch((error) => { if (error.code === "ENOENT") return null; throw error; }),
      `downstream artifact already exists: ${name}`);
  const mediaWork = path.join(episodeDir, "pilot_media_work");
  const mediaWorkStat = await fs.lstat(mediaWork).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  need(mediaWorkStat?.isDirectory() && !mediaWorkStat.isSymbolicLink()
    && same((await fs.readdir(mediaWork)).sort(), ["host_neutral"]),
  "only the rejected host_neutral work may exist before this amendment");
  need(path.isAbsolute(inputPath) && !inputPath.startsWith(`${paths.directory}${path.sep}`), "separate absolute revision request required");
  const requestRef = await binding(inputPath), request = (await readBound(requestRef, { json: true })).value;
  need(Object.keys(request).every((key) => REQUEST_KEYS.has(key)) && request.schema === "goldflow_avatar_pilot_host_design_revision_request_v1",
    "request schema or fields are invalid");
  const identityRef = await binding(path.join(episodeDir, "run_identity.json"));
  need(request.identity_sha256 === identityRef.sha256 && same(identity, (await readBound(identityRef, { json: true })).value), "identity is stale");
  const effective = await resolvePilotAssetPlanStage({ episodeDir, identity });
  const priorPlanRef = await binding(effective.path);
  need(same(request.prior_plan, priorPlanRef), "prior effective plan binding is stale");
  const priorPlan = (await readBound(priorPlanRef, { json: true })).value;
  const priorApprovalPath = path.join(episodeDir, "pilot_asset_plan_approval.json"), priorApprovalRef = await binding(priorApprovalPath);
  need(same(request.prior_approval, priorApprovalRef), "prior approval binding is stale");
  const priorApproval = (await readBound(priorApprovalRef, { json: true })).value;
  need(priorApproval.schema === "goldflow_avatar_pilot_stage_v1" && priorApproval.stage === "pilot_asset_plan_approval"
    && priorApproval.identity_sha256 === identityRef.sha256 && priorApproval.payload?.review?.approved === true
    && priorApproval.inputs?.some((ref) => ref.role === "upstream" && same({ path: ref.path, sha256: ref.sha256 }, priorPlanRef)),
  "prior plan approval is invalid");
  const prior = request.prior_attempt;
  need(prior && Object.keys(prior).length === 5, "complete first-attempt evidence required");
  for (const key of ["request", "submission", "result", "operator_review"]) await readBound(prior[key], { json: true });
  await readBound(prior.output);
  const priorDirectory = path.join(mediaWork, "host_neutral");
  for (const ref of Object.values(prior)) need(ref.path === priorDirectory || ref.path.startsWith(`${priorDirectory}${path.sep}`),
    "first-attempt evidence must remain in the exact host_neutral work namespace");
  const gen = (await readBound(prior.request, { json: true })).value;
  const submitted = (await readBound(prior.submission, { json: true })).value;
  const result = (await readBound(prior.result, { json: true })).value;
  const review = (await readBound(prior.operator_review, { json: true })).value;
  need(gen.asset_id === "host_neutral" && gen.creative_submission_limit === 1
    && submitted.asset_id === "host_neutral" && submitted.creative_submission_count === 1
    && result.asset_id === "host_neutral" && result.creative_submission_count === 1
    && result.native_output?.sha256 === prior.output.sha256
    && review.asset_id === "host_neutral" && review.prior_candidate_accepted === false
    && review.reviewed_output?.sha256 === prior.output.sha256, "rejected first-attempt lineage is invalid");
  const nextPlan = (await readBound(request.new_plan, { json: true })).value;
  await readBound(request.replacement_prompt);
  for (const ref of request.external_inspiration_bindings ?? []) await readBound(ref);
  const delta = validatePilotHostDesignDelta({ priorPlan: priorPlan.payload, nextPlan, identity,
    externalInspirationBindings: request.external_inspiration_bindings });
  need(typeof reviewer === "string" && reviewer.trim() && typeof note === "string" && note.trim(), "reviewer and note required");
  return { paths, request, requestRef, identityRef, priorPlanRef, priorApprovalRef, priorPlan, nextPlan, delta,
    reviewer: reviewer.trim(), note: note.trim() };
}

export async function resolvePilotHostDesignRevision({ episodeDir, identity } = {}) {
  const paths = pilotHostDesignRevisionPaths(episodeDir);
  const dir = await fs.lstat(paths.directory).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  const recorded = (await events(episodeDir)).filter((row) => row.action === "revise-host-design" && row.status === "passed");
  if (!dir) { need(recorded.length === 0, "recorded revision namespace is missing"); return null; }
  need(dir.isDirectory() && !dir.isSymbolicLink() && same((await fs.readdir(paths.directory)).sort(),
    ["activation.json", "authorization.json", "pilot_asset_plan.json", "pilot_asset_plan_approval.json", "revision.json"]),
  "revision namespace is partial or has unexpected files");
  const activation = (await readBound(await binding(paths.activation), { json: true })).value;
  need(activation.schema === "goldflow_avatar_pilot_host_design_revision_activation_v1", "activation schema invalid");
  for (const [key, file] of [["receipt", paths.receipt], ["plan", paths.plan], ["approval", paths.approval], ["authority", paths.authorization]])
    need(same(activation[key], await binding(file)), `activation ${key} binding is stale`);
  const receipt = (await readBound(activation.receipt, { json: true })).value;
  const request = (await readBound(receipt.request, { json: true })).value;
  const identityRef = await binding(path.join(episodeDir, "run_identity.json"));
  need(receipt.schema === "goldflow_avatar_pilot_host_design_revision_v1" && receipt.identity_sha256 === identityRef.sha256
    && request.identity_sha256 === identityRef.sha256 && (!identity || same(identity, (await readBound(identityRef, { json: true })).value)),
  "revision identity is stale");
  const priorPlan = (await readBound(request.prior_plan, { json: true })).value;
  const nextPlan = (await readBound(request.new_plan, { json: true })).value;
  const delta = validatePilotHostDesignDelta({ priorPlan: priorPlan.payload, nextPlan, identity: (await readBound(identityRef, { json: true })).value,
    externalInspirationBindings: request.external_inspiration_bindings });
  need(same(delta.affected_asset_ids, receipt.affected_asset_ids), "revision scope changed");
  const plan = (await readBound(activation.plan, { json: true })).value;
  need(plan.schema === "goldflow_avatar_pilot_stage_v1" && plan.stage === "pilot_asset_plan" && plan.identity_sha256 === identityRef.sha256
    && same(plan.payload, nextPlan) && plan.inputs?.some((ref) => ref.role === "prior_plan" && same({ path: ref.path, sha256: ref.sha256 }, request.prior_plan))
    && plan.inputs?.some((ref) => ref.role === "revision_request" && same({ path: ref.path, sha256: ref.sha256 }, receipt.request)),
  "effective plan is stale");
  const approval = (await readBound(activation.approval, { json: true })).value;
  need(approval.schema === "goldflow_avatar_pilot_stage_v1" && approval.stage === "pilot_asset_plan_approval"
    && approval.identity_sha256 === identityRef.sha256 && approval.payload?.review?.approved === true
    && approval.inputs?.some((ref) => ref.role === "upstream" && same({ path: ref.path, sha256: ref.sha256 }, activation.plan))
    && approval.inputs?.some((ref) => ref.role === "prior_approval" && same({ path: ref.path, sha256: ref.sha256 }, request.prior_approval)),
  "effective approval is stale");
  const authorization = (await readBound(activation.authority, { json: true })).value;
  need(authorization.schema === "goldflow_avatar_pilot_host_design_revision_authorization_v1"
    && authorization.identity_sha256 === identityRef.sha256 && authorization.replacement_asset_id === "host_neutral"
    && authorization.replacement_attempt_number === 2 && authorization.creative_submissions_authorized === 1
    && authorization.lifetime_creative_submission_limit === 2 && same(authorization.replacement_prompt, request.replacement_prompt)
    && same(authorization.external_inspiration_bindings, request.external_inspiration_bindings)
    && same(authorization.plan, activation.plan) && same(authorization.approval, activation.approval),
  "replacement authorization is stale");
  need(recorded.length === 1 && same(recorded[0], (await readBound(activation.execution_report, { json: true })).value),
    "append-only revision audit is missing or duplicated");
  const audit = recorded[0];
  need(audit.schema === "goldflow_avatar_pilot_execution_v1" && audit.action === "revise-host-design" && audit.status === "passed"
    && audit.identity_sha256 === identityRef.sha256 && same(audit.output, activation.authority)
    && audit.creative_submissions === 0 && audit.provider_cost === 0 && audit.synthesis_invoked === false
    && audit.generation_authorized === true && audit.production_eligible === false && audit.publish_allowed === false
    && same(audit.scope, { duration_sec: 90, phase: "host_design_revision_and_single_replacement_authorization",
      affected_asset_ids: HOST_IDS, replacement_asset_id: "host_neutral", replacement_attempt_number: 2 }),
  "revision execution audit is stale");
  return { plan: { row: plan, path: paths.plan }, approval: { row: approval, path: paths.approval },
    authorization: activation.authority, request, receipt: activation.receipt, execution_report: activation.execution_report };
}
