import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { falFileSha256, falObjectSha256 } from "./fal-provider.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const requireValue = (value, message) => { if (!value) throw new Error(message); };
async function read(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function exists(file) { return fs.access(file).then(() => true, () => false); }
async function writeNew(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, json(value), { flag: "wx" }); }

async function verifyTransportRecoveredReference({ episodeDir, original, recovery, receipt }) {
  const id = original.image_id;
  const root = path.join(episodeDir, "fal", "reference");
  const submissionPath = path.join(root, "transport-recovery-submission-receipts", `${id}.json`);
  const resultPath = path.join(root, "transport-recovery-result-receipts", `${id}.json`);
  const holdPath = path.join(root, "transport-holds", `${id}.json`);
  const observationPath = path.join(root, "hold-observation-receipts", `${id}.json`);
  const expectedOutput = path.join(episodeDir, "assets", "images", "reference-repairs", `${id}-transport.png`);
  requireValue(recovery.image_id === id && recovery.ref_id === original.ref_id
    && recovery.output_path === expectedOutput
    && recovery.submission_receipt_path === submissionPath
    && recovery.result_receipt_path === resultPath
    && !await exists(original.result_receipt_path),
  `Fal reference transport recovery path changed: ${id}`);
  const core = { ...recovery };
  for (const key of ["assignment_sha256", "assignment_path", "submission_receipt_path", "result_receipt_path", "output_path", "upload_receipt_path"]) delete core[key];
  requireValue(recovery.assignment_sha256 === falObjectSha256(JSON.stringify(core))
    && recovery.previous_assignment_sha256 === original.assignment_sha256
    && recovery.prompt === original.prompt
    && recovery.prompt_sha256 === original.prompt_sha256
    && recovery.endpoint === original.endpoint
    && recovery.run_identity_sha256 === original.run_identity_sha256
    && recovery.reference_mode === original.reference_mode
    && JSON.stringify(recovery.reference_asset_ids) === JSON.stringify(original.reference_asset_ids)
    && JSON.stringify(recovery.reference_hashes) === JSON.stringify(original.reference_hashes)
    && recovery.board_path === original.board_path
    && recovery.board_sha256 === original.board_sha256,
  `Fal reference transport recovery assignment changed: ${id}`);
  const [originalSubmission, hold, observation, submission] = await Promise.all([
    read(original.submission_receipt_path), read(holdPath), read(observationPath), read(submissionPath),
  ]);
  requireValue(originalSubmission.schema === "goldflow_fal_submission_receipt_v1"
    && originalSubmission.image_id === id
    && originalSubmission.assignment_sha256 === original.assignment_sha256
    && originalSubmission.prompt_sha256 === original.prompt_sha256
    && originalSubmission.endpoint === original.endpoint
    && hold.schema === "goldflow_fal_transport_hold_v1"
    && hold.image_id === id
    && hold.assignment_sha256 === original.assignment_sha256
    && hold.request_id === originalSubmission.request_id
    && observation.schema === "goldflow_fal_reference_hold_observation_v1"
    && observation.image_id === id
    && ["provider_failed", "transport_pending"].includes(observation.outcome)
    && observation.original_assignment_sha256 === original.assignment_sha256
    && observation.original_request_id === hold.request_id
    && observation.original_submission_receipt_sha256 === await falFileSha256(original.submission_receipt_path)
    && observation.original_transport_hold_sha256 === await falFileSha256(holdPath)
    && recovery.previous_request_id === hold.request_id
    && recovery.original_transport_hold_sha256 === await falFileSha256(holdPath)
    && recovery.hold_observation_receipt_sha256 === await falFileSha256(observationPath),
  `Fal reference transport recovery hold lineage changed: ${id}`);
  requireValue(submission.schema === "goldflow_fal_submission_receipt_v1"
    && submission.image_id === id
    && submission.assignment_sha256 === recovery.assignment_sha256
    && submission.prompt_sha256 === recovery.prompt_sha256
    && submission.endpoint === recovery.endpoint
    && typeof submission.request_id === "string" && submission.request_id.length > 0
    && submission.request_id !== recovery.previous_request_id
    && receipt.schema === "goldflow_fal_result_receipt_v1"
    && receipt.request_id === submission.request_id
    && receipt.endpoint === recovery.endpoint
    && receipt.output_path === recovery.output_path,
  `Fal reference transport recovery result lineage changed: ${id}`);
}

export function falPortableAssetId(seriesSlug, target) {
  requireValue(/^[a-z0-9-]+$/.test(seriesSlug) && /^[a-z0-9][a-z0-9_-]+$/.test(target?.ref_id ?? ""), "Unsafe portable Fal asset identity");
  return `gf.${seriesSlug.replaceAll("-", "_")}.${String(target.kind ?? "asset").replace(/[^a-z0-9_]/g, "_")}.${target.ref_id}`;
}

export async function promoteApprovedFalReferences({ episodeDir, identity, contract, approval } = {}) {
  requireValue(identity?.image_provider === "fal_ai" && identity.visual_restart?.fork_at === "visual_reference_plan", "Portable Fal bank promotion requires the early Fal attempt");
  requireValue(approval?.status === "approved" && approval.reference_hash_by_ref_id, "Portable Fal bank promotion requires hash-approved references");
  const plan = await read(path.join(episodeDir, "visual_reference_plan.json"));
  const referencePlan = await read(path.join(episodeDir, "fal", "reference-plan.json"));
  const sourceBank = await read(contract.reference_bank_manifest);
  requireValue(Array.isArray(sourceBank.assets), "Portable source bank has no assets");
  const dataRoot = process.env.ANIFACTORY_DATA_ROOT ?? "/Users/joel/AniFactoryData";
  const bankRoot = path.join(dataRoot, "global_reference_bank", "portable");
  const manifestPath = path.join(bankRoot, "manifest.json");
  const prior = await exists(manifestPath) ? await read(manifestPath) : {
    schema: "goldflow_portable_reference_bank_v1", revision: 0,
    source_bank_manifest: contract.reference_bank_manifest,
    source_bank_manifest_sha256: contract.reference_bank_manifest_sha256,
    assets: sourceBank.assets.map(row => ({ ...row, schema: "goldflow_portable_asset_record_v1" })),
  };
  requireValue(prior.schema === "goldflow_portable_reference_bank_v1" && Array.isArray(prior.assets), "Portable bank manifest is incompatible");
  const additions = [];
  for (const target of plan.reference_targets ?? []) {
    const assignment = referencePlan.assignments.find(row => row.ref_id === target.ref_id);
    if (!assignment) continue;
    const reviewedAssignmentPath = path.join(episodeDir, "fal", "reference", "review-repair-assignments", `${assignment.image_id}.json`);
    const reviewedReceiptPath = path.join(episodeDir, "fal", "reference", "review-repair-result-receipts", `${assignment.image_id}.json`);
    const reviewedV3AssignmentPath = path.join(episodeDir, "fal", "reference", "review-repair-v3-assignments", `${assignment.image_id}.json`);
    const reviewedV3ReceiptPath = path.join(episodeDir, "fal", "reference", "review-repair-v3-result-receipts", `${assignment.image_id}.json`);
    const repairedAssignmentPath = path.join(episodeDir, "fal", "reference", "repair-assignments", `${assignment.image_id}.json`);
    const repairedReceiptPath = path.join(episodeDir, "fal", "reference", "repair-result-receipts", `${assignment.image_id}.json`);
    const transportAssignmentPath = path.join(episodeDir, "fal", "reference", "transport-recovery-assignments", `${assignment.image_id}.json`);
    const transportReceiptPath = path.join(episodeDir, "fal", "reference", "transport-recovery-result-receipts", `${assignment.image_id}.json`);
    const transportRecovered = await exists(transportReceiptPath);
    const activeAssignment = await exists(reviewedV3ReceiptPath) ? await read(reviewedV3AssignmentPath)
      : await exists(reviewedReceiptPath) ? await read(reviewedAssignmentPath)
      : await exists(repairedReceiptPath) ? await read(repairedAssignmentPath)
      : transportRecovered ? await read(transportAssignmentPath) : assignment;
    const receipt = await read(activeAssignment.result_receipt_path);
    if (transportRecovered && activeAssignment.result_receipt_path === transportReceiptPath)
      await verifyTransportRecoveredReference({ episodeDir, original: assignment, recovery: activeAssignment, receipt });
    const approvedHash = approval.reference_hash_by_ref_id[target.ref_id];
    requireValue(target.reference_image_path === activeAssignment.output_path
      && target.conditioning_image_path === activeAssignment.output_path
      && receipt.output_path === activeAssignment.output_path
      && approvedHash === receipt.output_sha256
      && await falFileSha256(receipt.output_path) === approvedHash,
      `Approved Fal reference changed before global promotion: ${target.ref_id}`);
    if (receipt.schema === "goldflow_fal_approved_bank_reuse_v1") {
      requireValue(sourceBank.assets.some(row => row.asset_id === receipt.source_asset_id
        && row.approval_state === "approved" && row.sha256 === approvedHash),
      `Imported global reference is absent from the locked bank: ${target.ref_id}`);
      continue;
    }
    const assetId = falPortableAssetId(identity.series_slug, target);
    const existing = prior.assets.filter(row => row.asset_id === assetId).sort((a, b) => Number(b.version) - Number(a.version))[0];
    if (existing?.sha256 === approvedHash) continue;
    const version = Number(existing?.version ?? 0) + 1;
    const dest = path.join(bankRoot, "assets", assetId, `v${String(version).padStart(4, "0")}.png`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (!await exists(dest)) await fs.copyFile(receipt.output_path, dest, constants.COPYFILE_EXCL);
    requireValue(await falFileSha256(dest) === approvedHash, `Portable Fal copy changed: ${assetId}`);
    const metadata = await sharp(dest).metadata();
    const parent = target.canonical_subject_id === "joey_manhwa" ? "gf.global.character.joey_manhwa"
      : target.base_asset_id ?? null;
    const prompt = String(target.prompt_anchor ?? assignment.prompt ?? "");
    const role = String(target.canonical_subject_id ?? target.subject ?? target.ref_id);
    const aliases = [...new Set([target.ref_id, target.subject, target.canonical_subject_id, target.inventory_asset_id].filter(Boolean))];
    additions.push({
      schema: "goldflow_portable_asset_record_v1", asset_id: assetId,
      asset_class: target.kind === "character_state" ? (parent ? "wardrobe" : "character") : target.kind === "prop" ? "object" : target.kind,
      canonical_name: target.subject ?? target.ref_id, aliases, semantic_role: role,
      story_universe: identity.series_slug, series_scope: [identity.series_slug],
      version, approval_state: "approved", local_absolute_path: dest, sha256: approvedHash,
      portable_file: { path: dest, sha256: approvedHash, mime_type: "image/png" },
      width: metadata.width, height: metadata.height, aspect_ratio: `${metadata.width}:${metadata.height}`, color_mode: metadata.channels === 4 ? "rgba" : "rgb",
      canonical_prompt: prompt, negative_constraints: target.negative_constraints ?? [],
      model: activeAssignment.endpoint, provider: "fal_ai", mode: activeAssignment.board_path ? "image_edit" : "text2image",
      quality: "low", resolution: "1920x1080", seed: null, creation_timestamp: receipt.completed_at,
      cost_usd: receipt.provider_metadata?.usage?.cost ?? null,
      cost_status: receipt.provider_metadata?.usage?.cost == null ? "awaiting_provider_billing" : "reported_by_provider",
      tags: [...new Set(["manhwa", "canonical", identity.series_slug, target.kind, role, ...aliases])],
      parent_asset_id: parent, state_id: target.state_delta ?? target.ref_id,
      relationships: { parent_asset_id: parent, canonical_subject_id: target.canonical_subject_id ?? null, state_delta: target.state_delta ?? null,
        ordered_reference_assets: activeAssignment.reference_asset_ids },
      reference_ids: activeAssignment.reference_asset_ids, reference_hashes: activeAssignment.reference_hashes,
      providers: { fal: { request_id: receipt.request_id, endpoint: receipt.endpoint, result_receipt_path: activeAssignment.result_receipt_path,
        result_receipt_sha256: await falFileSha256(activeAssignment.result_receipt_path),
        original_assignment_sha256: assignment.assignment_sha256,
        active_assignment_sha256: activeAssignment.assignment_sha256 } },
      replacement_history: existing ? [...(existing.replacement_history ?? []), { supersedes_version: existing.version, supersedes_sha256: existing.sha256 }] : [],
      supersedes_version: existing?.version ?? null, supersedes_sha256: existing?.sha256 ?? null,
      searchable_role_tags: [...new Set([role, ...aliases])],
    });
  }
  if (!additions.length) return { manifest_path: manifestPath, promoted: 0, revision: prior.revision };
  const next = { ...prior, revision: Number(prior.revision) + 1, assets: [...prior.assets, ...additions], updated_at: new Date().toISOString() };
  const snapshotPath = path.join(bankRoot, "snapshots", `${String(next.revision).padStart(4, "0")}-${sha(json(next)).slice(0, 16)}.json`);
  await writeNew(snapshotPath, next);
  const tempPath = `${manifestPath}.${process.pid}.tmp`;
  await writeNew(tempPath, next);
  await fs.rename(tempPath, manifestPath);
  return { manifest_path: manifestPath, snapshot_path: snapshotPath, revision: next.revision, promoted: additions.length,
    asset_ids: additions.map(row => row.asset_id) };
}
