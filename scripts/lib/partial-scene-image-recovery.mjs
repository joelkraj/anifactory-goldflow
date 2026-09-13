import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { codexWorkSourceRowSha256 } from "./codex-image-work-contract.mjs";
import { PIPELINE_STAGE_REGISTRY, stageIsSatisfied } from "./pipeline-stage-registry.mjs";

export const PARTIAL_SCENE_QA_SCHEMA = "goldflow_partial_scene_image_qa_v1";
const hash = value => createHash("sha256").update(value).digest("hex");
const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const meaningful = value => typeof value === "string" && value.trim().length >= 20;
const tuple = ["channel", "series_slug", "week", "episode"];
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };
const ALLOWED_FLAGS = new Set(["episode-dir", "channel", "series", "week", "episode", "image-ids",
  "qa-recovery", "repair-reason", "gemini-only", "flow-only"]);

// Read-only admission: corrected current prompts and rejected old raster bytes
// are independent bindings. Replacing one raster retires only that finding.
export function readPartialSceneImageQaRecoveryScope({ episodeDir, episode }) {
  requireCondition(path.isAbsolute(episodeDir), "partial_scene_qa_requires_absolute_episode");
  const records = [];
  const read = (file, expected) => {
    const bytes = readFileSync(file);
    const sha256 = hash(bytes);
    requireCondition(expected === undefined || (isHash(expected) && sha256 === expected), `partial_scene_qa_stale_file:${path.basename(file)}`);
    records.push({ path: file, sha256 });
    return JSON.parse(bytes);
  };
  const readBound = (file, expected) => {
    requireCondition(isHash(expected), `partial_scene_qa_missing_hash:${path.basename(file)}`);
    return read(file, expected);
  };
  const reportPath = path.join(episodeDir, `image_output_qa_${episode}.json`);
  const report = read(reportPath);
  requireCondition(report.schema === PARTIAL_SCENE_QA_SCHEMA && report.status === "blocked" && report.scope === "partial"
    && text(report.reviewed_by) && text(report.reviewed_at) && Number.isFinite(Date.parse(report.reviewed_at)),
  "partial_scene_qa_requires_reviewed_blocked_partial_report");
  const identity = readBound(path.join(episodeDir, "run_identity.json"), report.run_identity_sha256);
  const approval = readBound(path.join(episodeDir, "operator_script_approval.json"), report.operator_script_approval_sha256);
  const lock = readBound(path.join(episodeDir, "script_lock.json"), report.script_lock_sha256);
  const sourcePath = path.join(episodeDir, "script_clean.md");
  requireCondition(isHash(report.source_script_hash) && hash(readFileSync(sourcePath)) === report.source_script_hash
    && identity.source_sha256 === report.source_script_hash && identity.episode === episode
    && tuple.every(key => text(identity[key])), "partial_scene_qa_stale_approved_source");
  records.push({ path: sourcePath, sha256: report.source_script_hash });
  for (const document of [approval, lock]) {
    requireCondition(document.operator_approved === true && document.script_clean_hash === report.source_script_hash
      && tuple.every(key => document[key] === identity[key]), "partial_scene_qa_requires_current_script_approval");
  }
  const plan = readBound(path.join(episodeDir, "section_image_prompts_hardened.json"), report.prompts_sha256);
  requireCondition(plan.status === "passed" && plan.source_script_hash === report.source_script_hash
    && tuple.every(key => plan[key] === identity[key]) && Array.isArray(plan.prompts), "partial_scene_qa_requires_current_hardened_plan");
  const prompts = new Map(plan.prompts.map(row => [row.image_id, row]));
  requireCondition(prompts.size === plan.prompts.length, "partial_scene_qa_duplicate_prompt_ids");
  const current = read(path.join(episodeDir, `imagegen_report_${episode}.json`));
  const images = new Map((current.results ?? []).map(row => [row.image_id, row]));
  requireCondition(Array.isArray(current.results) && images.size === current.results.length, "partial_scene_qa_ambiguous_current_images");
  const ids = report.reviewed_blocker_ids;
  const findings = (Array.isArray(report.findings) ? report.findings : []).filter(row => row?.severity === "blocker");
  requireCondition(Array.isArray(ids) && ids.length && ids.every(text) && new Set(ids).size === ids.length
    && findings.length && findings.every(row => ids.includes(row.image_id))
    && ids.every(id => findings.some(row => row.image_id === id)), "partial_scene_qa_incomplete_review_scope");
  const rejected = [];
  for (const id of ids) {
    const prompt = prompts.get(id);
    const rows = findings.filter(row => row.image_id === id);
    requireCondition(prompt && prompt.image_generation_required !== false && rows.every(row => text(row.code)
      && meaningful(row.review_note) && text(row.image_path) && path.isAbsolute(row.image_path)
      && isHash(row.image_sha256) && isHash(row.source_row_sha256)), "partial_scene_qa_incomplete_finding");
    const imagePath = images.get(id)?.image_path;
    // Old/missing raster findings are history, never authority to retry a new take.
    if (!text(imagePath) || !path.isAbsolute(imagePath) || rows.some(row => path.resolve(row.image_path) !== path.resolve(imagePath))) continue;
    let imageSha256;
    try { imageSha256 = hash(readFileSync(imagePath)); } catch { continue; }
    if (rows.some(row => row.image_sha256 !== imageSha256)) continue;
    requireCondition(rows.every(row => row.source_row_sha256 === codexWorkSourceRowSha256(prompt)), "partial_scene_qa_stale_corrected_prompt_row");
    rejected.push({ image_id: id, image_path: imagePath, image_sha256: imageSha256,
      source_row_sha256: rows[0].source_row_sha256 });
  }
  requireCondition(rejected.length, "partial_scene_qa_has_no_current_rejected_rasters");
  records.push(...rejected.map(row => ({ path: row.image_path, sha256: row.image_sha256 })));
  // Recheck every read binding before allowing the exact command to proceed.
  requireCondition(records.every(row => hash(readFileSync(row.path)) === row.sha256), "partial_scene_qa_evidence_changed_during_read");
  return { identity, rejected_images: rejected, rejected_image_ids: rejected.map(row => row.image_id),
    qa_report_path: reportPath, qa_report_sha256: records[0].sha256, records };
}

export function partialSceneImageQaRecoveryAdmission(status = {}, flags = {}) {
  const requested = Object.hasOwn(flags, "qa-recovery") && status.current_stage === "image_generation"
    && !["references-only", "reference-ids", "reference-id", "mode"].some(key => Object.hasOwn(flags, key));
  if (!requested) return { applicable: false, allowed: false };
  const deny = reason => ({ applicable: true, allowed: false, reason });
  try {
    requireCondition(["missing", "blocked", "failed", "partial", "in_progress"].includes(status.current_stage_state),
      "partial_scene_qa_requires_unfinished_image_generation");
    const earlier = PIPELINE_STAGE_REGISTRY.slice(0, PIPELINE_STAGE_REGISTRY.findIndex(row => row.id === "image_generation"));
    requireCondition(Array.isArray(status.stage_ledger) && earlier.every(stage => {
      const rows = status.stage_ledger.filter(row => row.stage === stage.id);
      return rows.length === 1 && stageIsSatisfied(rows[0].state);
    }), "partial_scene_qa_requires_all_current_earlier_gates");
    requireCondition(flags["qa-recovery"] === "true" && meaningful(flags["repair-reason"])
      && Object.keys(flags).every(key => ALLOWED_FLAGS.has(key))
      && ["gemini-only", "flow-only"].every(key => !Object.hasOwn(flags, key) || flags[key] === "true")
      && !(flags["gemini-only"] && flags["flow-only"]), "partial_scene_qa_requires_exact_recovery_flags");
    const rawIds = flags["image-ids"];
    requireCondition(typeof rawIds === "string" && /^[A-Za-z0-9_.:-]+(?:,[A-Za-z0-9_.:-]+)*$/.test(rawIds), "partial_scene_qa_requires_exact_image_ids");
    const ids = rawIds.split(",");
    requireCondition(new Set(ids).size === ids.length, "partial_scene_qa_duplicate_requested_ids");
    requireCondition((flags["episode-dir"] && path.resolve(flags["episode-dir"]) === status.episode_dir)
      || (!flags["episode-dir"] && ["channel", "week", "episode"].every(key => text(flags[key]))), "partial_scene_qa_requires_exact_target");
    const scope = readPartialSceneImageQaRecoveryScope({ episodeDir: status.episode_dir, episode: status.identity?.episode });
    for (const key of tuple) {
      const flag = key === "series_slug" ? "series" : key;
      requireCondition(scope.identity[key] === status.identity?.[key]
        && (!Object.hasOwn(flags, flag) || flags[flag] === scope.identity[key]), "partial_scene_qa_target_changed");
    }
    requireCondition(!flags["gemini-only"] || (scope.identity.image_provider === "federated_google_web_image_pool"
      && text(scope.identity.image_provider_options?.google_gemini?.model_label)), "partial_scene_qa_gemini_not_identity_locked");
    requireCondition(!flags["flow-only"] || (scope.identity.image_provider === "federated_google_web_image_pool"
      && text(scope.identity.image_provider_options?.google_flow?.model_label)), "partial_scene_qa_flow_not_identity_locked");
    requireCondition(ids.every(id => scope.rejected_image_ids.includes(id)), "partial_scene_qa_ids_outside_current_blockers");
    return { applicable: true, allowed: true, reason: "exact_current_partial_scene_qa_blockers",
      requested_image_ids: ids, qa_report_sha256: scope.qa_report_sha256 };
  } catch (error) { return deny(error.message); }
}
