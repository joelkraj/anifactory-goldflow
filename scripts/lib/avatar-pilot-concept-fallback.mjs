import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";
import { validatePilotAssetPlan, pilotArtifactContainsPrivateData } from "./avatar-pilot-artifacts.mjs";
import { resolvePilotHostDesignRevision } from "./avatar-pilot-host-design-revision.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/u;
const same = (a, b) => a === undefined || b === undefined ? a === b : canonicalQwenBatchSha256(a) === canonicalQwenBatchSha256(b);
const need = (ok, message) => { if (!ok) throw new Error(`Concept fallback blocked: ${message}`); };
const CONCEPT_IDS = Object.freeze(["concept_intercept", "concept_rescue", "concept_void_doorway"]);

export function pilotConceptFallbackPaths(episodeDir) {
  const directory = path.join(episodeDir, "pilot_concept_fallback");
  return { directory, receipt: path.join(directory, "revision.json"), plan: path.join(directory, "pilot_asset_plan.json"),
    approval: path.join(directory, "pilot_asset_plan_approval.json"), authorization: path.join(directory, "authorization.json"),
    activation: path.join(directory, "activation.json") };
}

async function binding(file) { return { path: file, sha256: hash(await fs.readFile(file)) }; }
async function readBound(ref, { json = false } = {}) {
  need(ref && path.isAbsolute(ref.path) && HASH.test(ref.sha256 ?? ""), "exact absolute file binding required");
  const stat = await fs.lstat(ref.path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024, "bounded regular file required");
  const bytes = await fs.readFile(ref.path); need(hash(bytes) === ref.sha256, "bound file hash is stale");
  if (!json) return { bytes, ref };
  const value = JSON.parse(bytes.toString("utf8"));
  need(value && typeof value === "object" && !Array.isArray(value) && !pilotArtifactContainsPrivateData(value), "JSON evidence is malformed or private");
  return { value, ref };
}
async function events(episodeDir) {
  const file = path.join(episodeDir, "execution_events.jsonl");
  const stat = await fs.lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return [];
  return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function validatePilotConceptFallbackDelta({ priorPlan, nextPlan, identity }) {
  need(validatePilotAssetPlan(priorPlan, identity).status === "passed", "prior plan validation failed");
  need(validatePilotAssetPlan(nextPlan, identity).status === "passed", "replacement plan validation failed");
  need(priorPlan.assets.length === nextPlan.assets.length
    && priorPlan.assets.every((row, index) => row.id === nextPlan.assets[index].id), "asset IDs, order and count are immutable");
  const changed = [];
  for (let index = 0; index < priorPlan.assets.length; index += 1) {
    const before = priorPlan.assets[index], after = nextPlan.assets[index];
    if (!CONCEPT_IDS.includes(before.id)) { need(same(before, after), `non-concept asset changed: ${before.id}`); continue; }
    need(before.kind === "concept_still" && after.kind === "editorial_composite"
      && after.provider === "local_compositor" && after.model === "source_cutout_composite_v1"
      && after.truth_mode === "hypothetical_concept" && typeof after.purpose === "string" && after.purpose.trim()
      && Array.isArray(after.reference_asset_ids) && after.reference_asset_ids.length > 0
      && after.reference_asset_ids.every((id) => priorPlan.assets.some((row) => row.id === id && row.kind === "movie_clip")),
    `invalid local editorial replacement: ${before.id}`);
    changed.push(before.id);
  }
  need(same(changed, CONCEPT_IDS), "all three planned concept stills must move together to the local fallback");
  const a = structuredClone(priorPlan), b = structuredClone(nextPlan); delete a.assets; delete b.assets;
  for (const key of ["intent", "scope", "art_direction", "generation_order", "edit_intent", "revision"]) { delete a[key]; delete b[key]; }
  need(same(a, b), "identity, source, approvals and proof scope outside presentation metadata are immutable");
  need(nextPlan.scope?.local_editorial_composite_count === 3 && nextPlan.scope?.generated_concept_still_count === 0,
    "replacement scope must declare three local composites and zero generated concept stills");
  return { affected_asset_ids: [...CONCEPT_IDS] };
}

export async function preparePilotConceptFallback({ episodeDir, identity, inputPath, reviewer, note }) {
  const paths = pilotConceptFallbackPaths(episodeDir);
  need(!await fs.lstat(paths.directory).catch((error) => { if (error.code === "ENOENT") return null; throw error; }),
    "one concept fallback already exists or is incomplete; inspect it, never replay");
  for (const name of ["pilot_media.json", "pilot_timeline.json", "pilot_timeline_approval.json", "pilot_render.json", "pilot_final_qa.json", "pilot_render_work", "pilot_proof_90s.mp4"])
    need(!await fs.lstat(path.join(episodeDir, name)).catch((error) => { if (error.code === "ENOENT") return null; throw error; }), `downstream artifact already exists: ${name}`);
  const requestRef = await binding(inputPath), request = (await readBound(requestRef, { json: true })).value;
  need(request.schema === "goldflow_avatar_pilot_concept_fallback_request_v1", "request schema is invalid");
  const identityRef = await binding(path.join(episodeDir, "run_identity.json"));
  need(request.identity_sha256 === identityRef.sha256 && same(identity, (await readBound(identityRef, { json: true })).value), "identity is stale");
  const host = await resolvePilotHostDesignRevision({ episodeDir, identity }); need(host, "accepted host-design revision is required");
  const priorPlanRef = await binding(host.plan.path), priorApprovalRef = await binding(host.approval.path);
  need(same(request.prior_plan, priorPlanRef) && same(request.prior_approval, priorApprovalRef), "prior effective plan or approval is stale");
  const failures = Array.isArray(request.provider_failures) ? request.provider_failures : [];
  need(failures.length === 2, "both retained provider failures are required");
  const statuses = [];
  for (const ref of failures) {
    const result = (await readBound(ref, { json: true })).value;
    need(result.schema === "goldflow_avatar_pilot_manual_generation_result_v1" && result.asset_id === "concept_intercept"
      && result.output === null && ["provider_failed_preserved_for_triage", "provider_refused_preserved_for_triage"].includes(result.status),
    "provider failure evidence is invalid");
    await readBound(result.generation_request, { json: true }); await readBound(result.provider_evidence, { json: true }); statuses.push(result.status);
  }
  need(new Set(statuses).size === 2, "one technical failure and one provider refusal are required");
  const nextPlan = (await readBound(request.new_plan, { json: true })).value;
  const priorPlan = (await readBound(priorPlanRef, { json: true })).value.payload;
  const delta = validatePilotConceptFallbackDelta({ priorPlan, nextPlan, identity });
  need(typeof reviewer === "string" && reviewer.trim() && typeof note === "string" && note.trim(), "reviewer and note required");
  return { paths, request, requestRef, identityRef, priorPlanRef, priorApprovalRef, nextPlan, delta,
    reviewer: reviewer.trim(), note: note.trim() };
}

export async function resolvePilotConceptFallback({ episodeDir, identity } = {}) {
  const paths = pilotConceptFallbackPaths(episodeDir);
  const dir = await fs.lstat(paths.directory).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  const recorded = (await events(episodeDir)).filter((row) => row.action === "use-local-concept-fallback" && row.status === "passed");
  if (!dir) { need(recorded.length === 0, "recorded fallback namespace is missing"); return null; }
  need(dir.isDirectory() && !dir.isSymbolicLink(), "fallback namespace is invalid");
  const activation = (await readBound(await binding(paths.activation), { json: true })).value;
  need(activation.schema === "goldflow_avatar_pilot_concept_fallback_activation_v1", "activation schema invalid");
  for (const [key, file] of [["receipt", paths.receipt], ["plan", paths.plan], ["approval", paths.approval], ["authority", paths.authorization]])
    need(same(activation[key], await binding(file)), `activation ${key} binding is stale`);
  const receipt = (await readBound(activation.receipt, { json: true })).value;
  const request = (await readBound(receipt.request, { json: true })).value;
  const identityRef = await binding(path.join(episodeDir, "run_identity.json"));
  need(receipt.schema === "goldflow_avatar_pilot_concept_fallback_v1" && receipt.identity_sha256 === identityRef.sha256
    && request.identity_sha256 === identityRef.sha256 && (!identity || same(identity, (await readBound(identityRef, { json: true })).value)), "fallback identity is stale");
  const priorPlan = (await readBound(request.prior_plan, { json: true })).value.payload;
  const nextPlan = (await readBound(request.new_plan, { json: true })).value;
  const delta = validatePilotConceptFallbackDelta({ priorPlan, nextPlan, identity: (await readBound(identityRef, { json: true })).value });
  need(same(delta.affected_asset_ids, receipt.affected_asset_ids), "fallback scope changed");
  const plan = (await readBound(activation.plan, { json: true })).value;
  const approval = (await readBound(activation.approval, { json: true })).value;
  need(plan.schema === "goldflow_avatar_pilot_stage_v1" && plan.stage === "pilot_asset_plan" && same(plan.payload, nextPlan)
    && approval.schema === "goldflow_avatar_pilot_stage_v1" && approval.stage === "pilot_asset_plan_approval"
    && approval.payload?.review?.approved === true, "effective plan or approval is stale");
  const authority = (await readBound(activation.authority, { json: true })).value;
  need(authority.schema === "goldflow_avatar_pilot_concept_fallback_authorization_v1" && authority.status === "authorized"
    && same(authority.plan, activation.plan) && same(authority.approval, activation.approval)
    && same(authority.affected_asset_ids, CONCEPT_IDS) && authority.creative_submissions_authorized === 0, "fallback authorization is stale");
  need(recorded.length === 1 && same(recorded[0], (await readBound(activation.execution_report, { json: true })).value), "fallback audit is missing or duplicated");
  return { plan: { row: plan, path: paths.plan }, approval: { row: approval, path: paths.approval }, authorization: activation.authority,
    request, receipt: activation.receipt, execution_report: activation.execution_report };
}
