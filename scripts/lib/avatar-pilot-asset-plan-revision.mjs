import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalQwenBatchSha256 } from "./qwen-liam-batch-contract.mjs";
import { AVATAR_PILOT_STAGES } from "./avatar-pilot-stage-registry.mjs";
import { validatePilotAssetPlan, pilotArtifactContainsPrivateData } from "./avatar-pilot-artifacts.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => a === undefined || b === undefined ? a === b : canonicalQwenBatchSha256(a) === canonicalQwenBatchSha256(b);
const need = (ok, message) => { if (!ok) throw new Error(`Asset-plan revision blocked: ${message}`); };
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[a-z][a-z0-9_-]{0,79}$/u;
const METADATA = new Set(["intent", "art_direction", "generation_order", "edit_intent", "revision"]);

export function pilotAssetPlanRevisionPaths(episodeDir) {
  const directory = path.join(episodeDir, "pilot_asset_plan_revision");
  return { directory, original: path.join(episodeDir, "pilot_asset_plan.json"),
    receipt: path.join(directory, "revision.json"), stage: path.join(directory, "pilot_asset_plan.json"),
    activation: path.join(directory, "activation.json") };
}
async function json(file, expectedHash = null) {
  need(path.isAbsolute(file), "absolute local artifact required");
  const stat = await fs.lstat(file);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024
    && await fs.realpath(file) === file, "bounded regular artifact without symlink aliases required");
  const bytes = await fs.readFile(file), digest = hash(bytes);
  need(expectedHash == null || (HASH.test(expectedHash) && digest === expectedHash), "artifact binding is stale");
  const value = JSON.parse(bytes.toString("utf8"));
  need(value && typeof value === "object" && !Array.isArray(value) && !pilotArtifactContainsPrivateData(value), "invalid/private revision artifact");
  return { value, ref: { path: file, sha256: digest } };
}
async function bound(ref) {
  need(ref && Object.keys(ref).every((key) => ["path", "sha256", "role"].includes(key)) && HASH.test(ref.sha256 ?? ""), "exact artifact reference required");
  return json(ref.path, ref.sha256);
}
async function executionEvents(episodeDir) {
  const file = path.join(episodeDir, "execution_events.jsonl");
  const stat = await fs.lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return [];
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024
    && await fs.realpath(file) === file, "invalid execution-event history");
  return (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** A revision can change named rows (including an explicit remove/add rename)
 * and reviewed presentation metadata, never immutable narration/identity scope. */
export function validatePilotAssetPlanRevision({ priorPlan, nextPlan, identity, affectedAssetIds }) {
  for (const plan of [priorPlan, nextPlan]) {
    const valid = validatePilotAssetPlan(plan, identity);
    need(valid.status === "passed" && plan.source_script_sha256 === identity.source_script.sha256,
      `plan schema, source or provider validation failed: ${JSON.stringify(valid.findings ?? [])}`);
  }
  need(Array.isArray(affectedAssetIds) && affectedAssetIds.length > 0 && affectedAssetIds.length <= 80
    && affectedAssetIds.every((id) => ID.test(id)) && new Set(affectedAssetIds).size === affectedAssetIds.length,
  "explicit unique affected asset IDs required");
  const prior = new Map(priorPlan.assets.map((row) => [row.id, row]));
  const next = new Map(nextPlan.assets.map((row) => [row.id, row]));
  const changed = [...new Set([...prior.keys(), ...next.keys()])].filter((id) => !same(prior.get(id), next.get(id))).sort();
  need(same(changed, [...affectedAssetIds].sort()), "affected IDs must exactly name every changed, added or removed asset row");
  need(same(priorPlan.assets.filter((row) => !changed.includes(row.id)), nextPlan.assets.filter((row) => !changed.includes(row.id))),
    "unaffected asset rows and their relative order are immutable");
  const metadata = [];
  for (const key of new Set([...Object.keys(priorPlan), ...Object.keys(nextPlan)])) {
    if (key === "assets" || same(priorPlan[key], nextPlan[key])) continue;
    need(METADATA.has(key), `non-presentation plan field is immutable: ${key}`);
    metadata.push(key);
  }
  return { affectedAssetIds: changed, changedMetadataKeys: metadata.sort() };
}

async function originalPlan(episodeDir, identity) {
  const paths = pilotAssetPlanRevisionPaths(episodeDir);
  const original = await json(paths.original);
  const identityFile = await json(path.join(episodeDir, "run_identity.json"));
  need(!identity || same(identity, identityFile.value), "current identity mismatch");
  const row = original.value;
  need(row.schema === "goldflow_avatar_pilot_stage_v1" && row.stage === "pilot_asset_plan"
    && row.identity_sha256 === identityFile.ref.sha256 && Array.isArray(row.inputs), "original stage identity is stale");
  const upstream = row.inputs.filter((ref) => ref.role === "upstream"), imports = row.inputs.filter((ref) => ref.role === "import");
  need(upstream.length === 1 && imports.length === 1
    && upstream[0].path === path.join(episodeDir, "pilot_narration.json"), "original stage dependencies are invalid");
  for (const ref of row.inputs) await bound(ref);
  need(same(row.payload, (await bound(imports[0])).value), "original stage differs from its immutable imported plan");
  need(validatePilotAssetPlan(row.payload, identityFile.value).status === "passed"
    && row.payload.source_script_sha256 === identityFile.value.source_script.sha256, "original plan validation failed");
  return { paths, row, originalRef: original.ref, identity: identityFile.value, identityRef: identityFile.ref,
    upstream: { path: upstream[0].path, sha256: upstream[0].sha256 } };
}

export async function preparePilotAssetPlanRevision({ episodeDir, identity, inputPath, priorStageSha256,
  affectedAssetIds, reviewer, note }) {
  const context = await originalPlan(episodeDir, identity);
  need(HASH.test(priorStageSha256 ?? "") && priorStageSha256 === context.originalRef.sha256,
    "explicit prior-stage SHA-256 differs from the current original plan");
  need(typeof reviewer === "string" && reviewer.trim() && typeof note === "string" && note.trim(), "reviewer and operator revision reason required");
  need(!await fs.lstat(context.paths.directory).catch((error) => { if (error.code === "ENOENT") return null; throw error; }),
    "one revision already exists or is incomplete; inspect exact recovery, never replay");
  for (const stage of AVATAR_PILOT_STAGES.slice(8)) {
    need(!await fs.lstat(path.join(episodeDir, stage.output)).catch((error) => { if (error.code === "ENOENT") return null; throw error; }),
      `approval/downstream artifact already exists: ${stage.id}`);
  }
  // Non-stage render outputs also prove downstream work has started.
  for (const name of ["pilot_media_work", "pilot_render_work", "pilot_proof_90s.mp4"]) need(!await fs.lstat(path.join(episodeDir, name)).catch((error) => {
    if (error.code === "ENOENT") return null; throw error;
  }), "downstream render work already exists");
  const next = await json(inputPath);
  need(!context.row.inputs.some((ref) => ref.path === inputPath) && inputPath !== context.paths.original
    && !inputPath.startsWith(`${context.paths.directory}${path.sep}`), "revision requires a separate new candidate file");
  const delta = validatePilotAssetPlanRevision({ priorPlan: context.row.payload, nextPlan: next.value,
    identity: context.identity, affectedAssetIds });
  return { ...context, nextPlan: next.value, nextRef: next.ref, delta,
    receipt: { schema: "goldflow_avatar_pilot_asset_plan_revision_v1", revision_number: 1,
      status: "revised_pending_asset_plan_approval", created_at: new Date().toISOString(),
      identity_sha256: context.identityRef.sha256, source_script_sha256: context.identity.source_script.sha256,
      prior_stage: context.originalRef, new_input: next.ref,
      affected_asset_ids: delta.affectedAssetIds, changed_metadata_keys: delta.changedMetadataKeys,
      review: { reviewer: reviewer.trim(), note: note.trim(), kind: "operator_requested_plan_revision_only" },
      asset_plan_approved: false, synthesis_invoked: false, generation_authorized: false,
      creative_submissions: 0, provider_cost: 0, production_eligible: false, publish_allowed: false } };
}

/** One effective-plan resolver is used by status, approval and media import.
 * A claimed but incomplete namespace never falls back to the original plan. */
export async function resolvePilotAssetPlanStage({ episodeDir, identity } = {}) {
  const paths = pilotAssetPlanRevisionPaths(episodeDir);
  const directory = await fs.lstat(paths.directory).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!directory) {
    need(!(await executionEvents(episodeDir)).some((row) => row.action === "revise-asset-plan" && row.status === "passed"),
      "recorded revision namespace is missing; manual triage required");
    const original = await json(paths.original).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    return { row: original?.value ?? null, path: paths.original, revision: null };
  }
  need(directory.isDirectory() && !directory.isSymbolicLink(), "invalid revision namespace; manual triage required");
  need(same((await fs.readdir(paths.directory)).sort(), ["activation.json", "pilot_asset_plan.json", "revision.json"]),
    "revision is incomplete or contains unexpected files; manual triage required");
  const context = await originalPlan(episodeDir, identity);
  const activation = (await json(paths.activation)).value;
  need(activation.schema === "goldflow_avatar_pilot_asset_plan_revision_activation_v1"
    && activation.identity_sha256 === context.identityRef.sha256
    && activation.stage?.path === paths.stage && activation.receipt?.path === paths.receipt,
  "invalid revision activation");
  const receipt = (await bound(activation.receipt)).value, row = (await bound(activation.stage)).value;
  need(receipt.schema === "goldflow_avatar_pilot_asset_plan_revision_v1" && receipt.revision_number === 1
    && receipt.status === "revised_pending_asset_plan_approval" && same(receipt.prior_stage, context.originalRef)
    && receipt.identity_sha256 === context.identityRef.sha256 && receipt.source_script_sha256 === context.identity.source_script.sha256,
  "revision prior-stage/source identity changed");
  const next = await bound(receipt.new_input);
  need(!context.row.inputs.some((ref) => ref.path === next.ref.path)
    && next.ref.path !== paths.original && !next.ref.path.startsWith(`${paths.directory}${path.sep}`), "revision candidate scope changed");
  const delta = validatePilotAssetPlanRevision({ priorPlan: context.row.payload, nextPlan: next.value,
    identity: context.identity, affectedAssetIds: receipt.affected_asset_ids });
  need(same(delta.changedMetadataKeys, receipt.changed_metadata_keys)
    && typeof receipt.review?.reviewer === "string" && receipt.review.reviewer.trim()
    && typeof receipt.review?.note === "string" && receipt.review.note.trim()
    && receipt.review.kind === "operator_requested_plan_revision_only", "revision scope/reason changed");
  for (const key of ["asset_plan_approved", "synthesis_invoked", "generation_authorized", "production_eligible", "publish_allowed"])
    need(receipt[key] === false, "revision cannot authorize generation or approval");
  need(receipt.creative_submissions === 0 && receipt.provider_cost === 0, "revision must incur zero generation/spend");
  const expectedInputs = [{ role: "upstream", ...context.upstream }, { role: "prior_stage", ...context.originalRef },
    { role: "import", ...next.ref }, { role: "revision_receipt", ...activation.receipt }];
  need(row.schema === "goldflow_avatar_pilot_stage_v1" && row.stage === "pilot_asset_plan"
    && row.identity_sha256 === context.identityRef.sha256 && same(row.inputs, expectedInputs)
    && same(row.payload, next.value) && row.created_at === receipt.created_at, "effective stage differs from its exact revision chain");
  const audit = (await bound(activation.execution_report)).value;
  need(path.dirname(activation.execution_report.path) === path.join(episodeDir, "reports", "stages")
    && path.basename(activation.execution_report.path) === `${audit.id}.json`
    && audit.schema === "goldflow_avatar_pilot_execution_v1" && audit.action === "revise-asset-plan" && audit.status === "passed"
    && audit.identity_sha256 === context.identityRef.sha256 && same(audit.output, activation.stage)
    && same(audit.inputs, expectedInputs) && audit.creative_submissions === 0 && audit.provider_cost === 0
    && audit.synthesis_invoked === false && audit.asset_plan_approved === false && audit.production_eligible === false
    && same(audit.scope, { duration_sec: 90, phase: "asset_plan_revision_only", affected_asset_ids: delta.affectedAssetIds }),
  "revision execution audit is missing or stale");
  const revisionEvents = (await executionEvents(episodeDir)).filter((row) => row.action === "revise-asset-plan" && row.status === "passed");
  need(revisionEvents.length === 1 && same(revisionEvents[0], audit), "revision audit is absent, duplicated or differs from append-only execution events");
  return { row, path: paths.stage, revision: { receipt: activation.receipt, prior_stage: context.originalRef,
    affected_asset_ids: delta.affectedAssetIds, execution_report: activation.execution_report } };
}
