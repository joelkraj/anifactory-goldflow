// Append-only identity revision records, written next to run_identity.json by
// the operator-only `run relock-tts`. The in-place identity rewrite keeps its
// internal hashes; this ledger is the durable, append-only account of
// {previous sha, new sha, reason code} that the guard and rerun policies read.
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";

export const RUN_IDENTITY_REVISION_SCHEMA = "goldflow_run_identity_revision_v1";
export const RUN_IDENTITY_REVISIONS_FILE = "run_identity_revisions.jsonl";
export const IDENTITY_REVISION_REASON_CODES = Object.freeze([
  "narrator_identity_migration",
  "tts_planner_fix_relock",
  "synthesis_contract_promotion",
]);

export function revisionsPath(episodeDir) {
  return path.join(episodeDir, RUN_IDENTITY_REVISIONS_FILE);
}

export function identityRevisionReasonCodeFor(recoveryScope) {
  if (recoveryScope === "operator_approved_narrator_identity_migration") return "narrator_identity_migration";
  if (recoveryScope === "same_voice_batch4_synthesis_contract_promotion") return "synthesis_contract_promotion";
  return "tts_planner_fix_relock";
}

export async function appendIdentityRevision(episodeDir, {
  previousSha256, newSha256, reasonCode, approvedBy, command, invalidationBoundary, archiveDir = null, gitCommit = null, recordedAt = new Date().toISOString(),
}) {
  if (!IDENTITY_REVISION_REASON_CODES.includes(reasonCode)) throw new Error(`Unknown identity revision reason code: ${reasonCode}`);
  if (!/^[0-9a-f]{64}$/.test(String(previousSha256 ?? "")) || !/^[0-9a-f]{64}$/.test(String(newSha256 ?? ""))) throw new Error("Identity revision needs both sha256 values.");
  if (!String(approvedBy ?? "").trim() || /^automated:/.test(String(approvedBy))) throw new Error("Identity revision requires a human --approved-by; automated reviewers never relock an identity.");
  const row = {
    schema: RUN_IDENTITY_REVISION_SCHEMA,
    recorded_at: recordedAt,
    command,
    previous_run_identity_sha256: previousSha256,
    run_identity_sha256: newSha256,
    reason_code: reasonCode,
    approved_by: String(approvedBy).trim(),
    invalidation_boundary: invalidationBoundary,
    archive_dir: archiveDir,
    git_commit: gitCommit,
  };
  await fs.appendFile(revisionsPath(episodeDir), `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

export function readIdentityRevisionsSync(episodeDir) {
  if (!episodeDir) return [];
  try {
    return readFileSync(revisionsPath(episodeDir), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((row) => row?.schema === RUN_IDENTITY_REVISION_SCHEMA);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function readIdentityRevisions(episodeDir) {
  return readIdentityRevisionsSync(episodeDir);
}

/**
 * The latest revision whose recorded new sha matches the current run_identity.json.
 * A revision that no longer matches the identity on disk is not current and
 * admits nothing.
 */
export function currentIdentityRevisionSync(episodeDir) {
  const rows = readIdentityRevisionsSync(episodeDir);
  if (!rows.length) return null;
  let identitySha;
  try {
    identitySha = createHash("sha256").update(readFileSync(path.join(episodeDir, "run_identity.json"))).digest("hex");
  } catch {
    return null;
  }
  const latest = rows.at(-1);
  return latest.run_identity_sha256 === identitySha ? latest : null;
}

/**
 * Prior execution events that still count against a stage after the current
 * identity revision: events before the revision are history for every stage at
 * or after its invalidation boundary, so a post-relock `voice plan` or
 * `tts narrate` is a first attempt, not a full-stage rerun needing a bypass.
 */
export function eventsSinceIdentityRevision(events = [], revision, { stage, stageOrder = [] } = {}) {
  if (!revision?.recorded_at || !stage) return events;
  const boundaryIndex = stageOrder.indexOf(revision.invalidation_boundary);
  const stageIndex = stageOrder.indexOf(stage);
  if (boundaryIndex < 0 || stageIndex < 0 || stageIndex < boundaryIndex) return events;
  return events.filter((event) => String(event?.started_at ?? event?.completed_at ?? event?.recorded_at ?? "") >= revision.recorded_at);
}
