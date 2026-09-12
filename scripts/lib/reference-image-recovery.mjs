import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { referencePlanApprovalContractSha256 } from "./reference-plan-contract.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const referencePath = (row, episodeDir) => {
  const value = row?.conditioning_image_path ?? row?.reference_image_path;
  return text(value) ? path.resolve(episodeDir, value) : null;
};

// Old findings describe old rasters, not their replacements. Only matching
// source/creative contracts and still-current rejected bytes enter repair scope.
export async function readReferenceImageQaRecoveryScope({ episodeDir, episode, plan, currentScriptHash }) {
  try {
    if (plan?.status !== "passed" || !isHash(currentScriptHash) || plan.source_script_hash !== currentScriptHash) return null;
    const reportPath = path.join(episodeDir, `reference_image_qa_${episode}.json`);
    const bytes = await fs.readFile(reportPath);
    const report = JSON.parse(bytes);
    const contractHash = referencePlanApprovalContractSha256(plan);
    if (report.schema !== "goldflow_reference_image_qa_v1" || report.status !== "blocked"
      || report.source_script_hash !== currentScriptHash || report.reference_plan_contract_sha256 !== contractHash
      || !text(report.reviewed_by) || !text(report.reviewed_at) || !Number.isFinite(Date.parse(report.reviewed_at))) return null;
    const ids = report.reviewed_blocker_ids;
    const findings = (Array.isArray(report.findings) ? report.findings : []).filter(row => row?.severity === "blocker");
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !text(id)) || new Set(ids).size !== ids.length
      || !findings.length || findings.some(row => !ids.includes(row.ref_id))
      || ids.some(id => !findings.some(row => row.ref_id === id))) return null;
    const targets = new Map((plan.reference_targets ?? []).map(row => [row.ref_id, row]));
    const rejected = [];
    for (const id of ids) {
      const target = targets.get(id);
      if (!target || target.generation_mode !== "standalone_ref") return null;
      const rows = findings.filter(row => row.ref_id === id);
      if (rows.some(row => !text(row.code) || !text(row.review_note) || !text(row.image_path)
        || !path.isAbsolute(row.image_path) || !isHash(row.image_sha256))) return null;
      const currentPath = referencePath(target, episodeDir);
      if (!currentPath || rows.some(row => path.resolve(row.image_path) !== currentPath)) continue;
      const currentHash = await fs.readFile(currentPath).then(hash).catch(() => null);
      if (!currentHash || rows.some(row => row.image_sha256 !== currentHash)) continue;
      rejected.push({ ref_id: id, image_path: currentPath, image_sha256: currentHash, codes: rows.map(row => row.code) });
    }
    if (!rejected.length || hash(await fs.readFile(reportPath)) !== hash(bytes)) return null;
    return { source_script_hash: currentScriptHash, reference_plan_contract_sha256: contractHash,
      qa_report_path: reportPath, qa_report_sha256: hash(bytes), source_hash_current: true,
      rejected_ref_ids: rejected.map(row => row.ref_id), rejected_references: rejected };
  } catch { return null; }
}

const ALLOWED_FLAGS = new Set(["channel", "series", "week", "episode", "episode-dir",
  "references-only", "reference-ids", "qa-recovery", "repair-reason"]);

export function referenceImageQaRecoveryAdmission(status = {}, flags = {}) {
  const scope = status.reference_image_qa_recovery_scope;
  const requested = Object.hasOwn(flags, "qa-recovery")
    && (/^(true|1|yes)$/i.test(String(flags["references-only"] ?? "")) || flags.mode === "reference"
      || ["reference-ids", "reference-id"].some(key => Object.hasOwn(flags, key)));
  const current = status.current_stage === "reference_generation" && status.current_stage_state === "blocked";
  if (!(requested || (current && scope))) return { applicable: false, allowed: false };
  const deny = reason => ({ applicable: true, allowed: false, reason });
  if (!current) return deny("reference_qa_recovery_is_not_the_current_blocked_stage");
  if (!scope || scope.source_hash_current !== true || !isHash(scope.source_script_hash)
    || !isHash(scope.reference_plan_contract_sha256) || !isHash(scope.qa_report_sha256)
    || !text(scope.qa_report_path) || !Array.isArray(scope.rejected_ref_ids) || !scope.rejected_ref_ids.length
    || !Array.isArray(scope.rejected_references)
    || scope.rejected_ref_ids.length !== scope.rejected_references.length
    || new Set(scope.rejected_ref_ids).size !== scope.rejected_ref_ids.length
    || scope.rejected_references.some((row, index) => row.ref_id !== scope.rejected_ref_ids[index]
      || !text(row.image_path) || !isHash(row.image_sha256))) return deny("reference_qa_recovery_scope_missing_or_stale");
  if (flags["references-only"] !== "true" || flags["qa-recovery"] !== "true"
    || !text(flags["repair-reason"]) || Object.keys(flags).some(key => !ALLOWED_FLAGS.has(key))) {
    return deny("reference_qa_recovery_requires_exact_reference_flags");
  }
  const rawIds = flags["reference-ids"];
  if (typeof rawIds !== "string" || !/^[A-Za-z0-9_.:-]+(?:,[A-Za-z0-9_.:-]+)*$/.test(rawIds)) return deny("reference_qa_recovery_requires_nonempty_exact_ids");
  const ids = rawIds.split(",");
  if (new Set(ids).size !== ids.length || ids.some(id => !scope.rejected_ref_ids.includes(id))) return deny("reference_qa_recovery_ids_outside_current_blockers");
  if (flags["episode-dir"] && path.resolve(flags["episode-dir"]) !== path.resolve(status.episode_dir ?? "")) return deny("reference_qa_recovery_target_changed");
  for (const key of ["channel", "series", "week", "episode"]) {
    const expected = key === "series" ? status.identity?.series_slug ?? status.identity?.series : status.identity?.[key];
    if (Object.hasOwn(flags, key) && flags[key] !== expected) return deny("reference_qa_recovery_target_changed");
  }
  return { applicable: true, allowed: true, reason: "exact_current_reference_image_qa_blockers",
    requested_ref_ids: ids, qa_report_sha256: scope.qa_report_sha256 };
}
