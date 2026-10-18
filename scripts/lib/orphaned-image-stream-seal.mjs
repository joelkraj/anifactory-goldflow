import path from "node:path";
import {
  assertOrphanStreamProducerEnded, loadWorkManifest, readJson,
  sealCodexWorkManifestStream, sha256File,
} from "./codex-image-work-contract.mjs";

const FLAG_KEYS = ["action", "episode-dir", "manifest", "recovery-receipt", "recovery-reason"];
const isHash = value => /^[a-f0-9]{64}$/.test(String(value ?? ""));
const meaningful = value => typeof value === "string" && value.trim().length >= 20;
const samePath = (a, b) => typeof a === "string" && path.resolve(a) === path.resolve(b);
const inside = (file, parent) => typeof file === "string" && path.relative(parent, path.resolve(file)) !== ""
  && !path.relative(parent, path.resolve(file)).startsWith("..") && !path.isAbsolute(path.relative(parent, path.resolve(file)));
function requireCondition(condition, message) { if (!condition) throw new Error(message); }

export function assertOrphanStreamSealFlags(flags) {
  requireCondition(Object.keys(flags).sort().join() === [...FLAG_KEYS].sort().join()
    && flags.action === "seal-orphaned"
    && FLAG_KEYS.every(key => typeof flags[key] === "string" && flags[key].trim())
    && meaningful(flags["recovery-reason"]), "orphan_seal_requires_only_exact_reviewed_flags");
}

export function orphanedImageStreamSealAdmission(status = {}, flags = {}) {
  if (flags.action !== "seal-orphaned") return { applicable: false, allowed: false };
  const deny = reason => ({ applicable: true, allowed: false, reason });
  try { assertOrphanStreamSealFlags(flags); } catch (error) { return deny(error.message); }
  if (status.current_stage !== "image_generation"
    || !["missing", "blocked", "failed", "partial", "in_progress"].includes(status.current_stage_state)) {
    return deny("orphan_seal_requires_current_unfinished_image_generation_stage");
  }
  return { applicable: true, allowed: true, reason: "nongenerating_exact_orphan_stream_seal" };
}

export async function sealReviewedOrphanedImageStream({ episodeDir, manifestPath, recoveryReceiptPath, recoveryReason }) {
  requireCondition([episodeDir, manifestPath, recoveryReceiptPath].every(value => typeof value === "string" && path.isAbsolute(value)),
    "Orphan seal requires explicit absolute episode, manifest and receipt paths.");
  episodeDir = path.resolve(episodeDir);
  manifestPath = path.resolve(manifestPath);
  recoveryReceiptPath = path.resolve(recoveryReceiptPath);
  const receipt = await readJson(recoveryReceiptPath);
  requireCondition(inside(recoveryReceiptPath, path.join(episodeDir, "reports", "manual_repairs")), "Orphan seal receipt must be retained under episode manual repairs.");
  requireCondition(receipt.schema === "goldflow_orphaned_image_stream_seal_review_v1" && receipt.status === "reviewed"
    && meaningful(receipt.reason) && receipt.reason === recoveryReason && typeof receipt.reviewed_by === "string" && receipt.reviewed_by.trim()
    && Number.isFinite(Date.parse(receipt.reviewed_at)), "Orphan seal requires an exact substantive reviewed reason and reviewer provenance.");
  requireCondition(samePath(receipt.episode_dir, episodeDir) && samePath(receipt.manifest_path, manifestPath), "Orphan seal episode/manifest receipt binding mismatch.");
  const { manifest } = await loadWorkManifest(manifestPath);
  requireCondition(manifest.mode === "scene" && samePath(manifest.episode_dir, episodeDir)
    && samePath(manifestPath, path.join(episodeDir, "assets", "images", "codex_worker_staging", manifest.manifest_id, "work_manifest.json")),
  "Orphan seal requires the exact episode scene manifest.");
  requireCondition(manifest.streaming_queue?.appendable === true && manifest.streaming_queue.sealed === false,
    "Orphan seal requires an unsealed appendable stream.");
  requireCondition(receipt.manifest_id === manifest.manifest_id && receipt.stream_id === manifest.streaming_queue.stream_id
    && receipt.manifest_revision === manifest.streaming_queue.revision
    && isHash(receipt.manifest_content_sha256) && receipt.manifest_content_sha256 === manifest.content_sha256,
  "Orphan seal stream/revision/content binding mismatch.");
  const bindings = [];
  const bind = async (file, expected) => {
    requireCondition(isHash(expected) && await sha256File(file) === expected, `Orphan seal current file hash mismatch: ${file}.`);
    bindings.push({ path: path.resolve(file), sha256: expected });
  };
  await bind(manifestPath, receipt.manifest_sha256);
  await bind(recoveryReceiptPath, await sha256File(recoveryReceiptPath));
  const identityPath = path.join(episodeDir, "run_identity.json");
  const approvalPath = path.join(episodeDir, "operator_script_approval.json");
  const lockPath = path.join(episodeDir, "script_lock.json");
  await bind(identityPath, receipt.run_identity_sha256);
  requireCondition(samePath(manifest.sources?.run_identity?.path, identityPath)
    && manifest.sources.run_identity.sha256 === receipt.run_identity_sha256, "Orphan seal manifest identity provenance mismatch.");
  await bind(approvalPath, receipt.operator_script_approval_sha256);
  await bind(lockPath, receipt.script_lock_sha256);
  await bind(path.join(episodeDir, "script_clean.md"), receipt.source_script_hash);
  const identity = await readJson(identityPath);
  const approval = await readJson(approvalPath);
  const lock = await readJson(lockPath);
  const tuple = ["channel", "series_slug", "week", "episode"];
  requireCondition(identity.source_sha256 === receipt.source_script_hash && tuple.every(key => typeof identity[key] === "string" && identity[key]),
    "Orphan seal current identity/source binding mismatch.");
  for (const document of [approval, lock]) {
    requireCondition(document.operator_approved === true && document.script_clean_hash === receipt.source_script_hash
      && tuple.every(key => document[key] === identity[key]), "Orphan seal requires exact current operator-approved source and tuple.");
  }
  const producer = receipt.producer;
  requireCondition(producer?.role === "wavefront_append_owner" && Number.isSafeInteger(producer.pid) && producer.pid > 0
    && typeof producer.attempt_dir === "string" && path.isAbsolute(producer.attempt_dir)
    && path.dirname(producer.attempt_dir) === path.join(episodeDir, "reports", "visual-wavefront")
    && new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-${producer.pid}$`).test(path.basename(producer.attempt_dir)),
  "Orphan seal requires the append-owner PID bound to its original wavefront attempt directory.");
  assertOrphanStreamProducerEnded(producer.pid);
  requireCondition(inside(producer.hybrid_report_path, producer.attempt_dir), "Orphan seal producer report is outside its attempt.");
  await bind(producer.hybrid_report_path, producer.hybrid_report_sha256);
  const hybrid = await readJson(producer.hybrid_report_path);
  requireCondition(hybrid.schema === "goldflow_wavefront_stream_batch_v1" && hybrid.stream_id === receipt.stream_id
    && hybrid.manifest_id === manifest.manifest_id && samePath(hybrid.manifest_path, manifestPath)
    && Array.isArray(hybrid.exact_asset_ids) && hybrid.exact_asset_ids.length > 0
    && hybrid.exact_asset_ids.every(id => manifest.items.some(item => item.asset_id === id)),
  "Orphan seal retained batch report does not bind this stream and scope.");
  // Every queued creative row keeps its original passed batch source. The dead
  // append owner is distinct from any planner child; no child completion is claimed.
  const sources = new Map();
  for (const item of manifest.items) {
    requireCondition(inside(item.source_plan_path, producer.attempt_dir) && isHash(item.source_plan_sha256),
      `Orphan seal item ${item.asset_id} has no exact original producer source.`);
    requireCondition(!sources.has(item.source_plan_path) || sources.get(item.source_plan_path) === item.source_plan_sha256,
      "Orphan seal has conflicting source bindings.");
    sources.set(item.source_plan_path, item.source_plan_sha256);
  }
  requireCondition(sources.size > 0 && manifest.item_count === manifest.items.length, "Orphan seal requires a nonempty complete manifest scope.");
  requireCondition([...sources.keys()].some(file => path.dirname(file) === path.dirname(producer.hybrid_report_path)),
    "Orphan seal producer report has no retained batch source.");
  for (const [file, hash] of sources) {
    await bind(file, hash);
    const plan = await readJson(file);
    requireCondition(plan.schema === "goldflow_section_image_prompts_wavefront_batch_v1" && plan.status === "passed"
      && plan.source_script_hash === receipt.source_script_hash && tuple.every(key => plan[key] === identity[key]),
    `Orphan seal source plan is not current approved-source lineage: ${file}.`);
  }
  const result = await sealCodexWorkManifestStream({ manifestPath, streamId: receipt.stream_id, orphanRecovery: {
    review_receipt_path: recoveryReceiptPath,
    review_receipt_sha256: await sha256File(recoveryReceiptPath),
    reviewed_by: receipt.reviewed_by, reviewed_at: receipt.reviewed_at, reason: recoveryReason,
    source_script_hash: receipt.source_script_hash, run_identity_sha256: receipt.run_identity_sha256,
    manifest_sha256: receipt.manifest_sha256, producer_pid: producer.pid, producer_attempt_dir: producer.attempt_dir,
    planner_child_completion_asserted: false, file_bindings: bindings,
  } });
  return { status: "sealed", manifest_path: manifestPath, manifest_id: manifest.manifest_id,
    stream_id: receipt.stream_id, item_count: manifest.items.length, receipt_path: result.event_path,
    receipt_sha256: await sha256File(result.event_path), provider_calls: 0, new_work_items: 0 };
}
