import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { replayBeatLocationRepair } from "./reference-plan-exact-repair.mjs";

const REPAIR_ROOT = path.join("reports", "stages", "reference_plan_approval", "exact_repairs");
const SNAPSHOT_FILES = Object.freeze([
  "visual_beat_plan.json", "visual_beat_approval.json", "visual_reference_plan.json",
  "reference_inventory_ledger.json", "character_state_refs.json",
]);
const EXPECTED_KEYS = Object.freeze({
  "visual_beat_plan.json": "visual_beat_plan_sha256",
  "visual_beat_approval.json": "visual_beat_approval_sha256",
  "visual_reference_plan.json": "visual_reference_plan_sha256",
  "reference_inventory_ledger.json": "reference_inventory_ledger_sha256",
  "character_state_refs.json": "character_state_refs_sha256",
});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function need(value, message) { if (!value) throw new Error(`Fal carried beat repair: ${message}`); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function regularBytes(file) {
  const stat = await fs.lstat(file);
  need(stat.isFile() && !stat.isSymbolicLink(), `non-regular file ${file}`);
  return fs.readFile(file);
}
function receiptLocation(episodeDir, receiptPath) {
  need(typeof receiptPath === "string" && path.isAbsolute(receiptPath), "receipt path is missing");
  const root = path.join(episodeDir, REPAIR_ROOT);
  const parts = path.relative(root, receiptPath).split(path.sep);
  need(parts.length === 2 && parts[0] && parts[0] !== ".." && parts[1] === "receipt.json"
    && path.join(root, parts[0], "receipt.json") === receiptPath, "receipt is outside the exact-repair journal");
  return { receiptPath, receiptDir: path.dirname(receiptPath), repairId: parts[0] };
}

export async function verifyFalBeatCarryforwardRepair({ episodeDir, originalPlanSha256, originalApprovalSha256 }) {
  const currentPlanBytes = await regularBytes(path.join(episodeDir, "visual_beat_plan.json"));
  const currentApprovalBytes = await regularBytes(path.join(episodeDir, "visual_beat_approval.json"));
  let planSha256 = hash(currentPlanBytes);
  let approvalSha256 = hash(currentApprovalBytes);
  let approval = JSON.parse(currentApprovalBytes);
  need(planSha256 !== originalPlanSha256 && approvalSha256 !== originalApprovalSha256,
    "plan and approval must both change through the guarded repair");

  const events = (await regularBytes(path.join(episodeDir, "execution_events.jsonl"))).toString("utf8")
    .split("\n").filter(Boolean).map(line => JSON.parse(line));
  const seen = new Set();
  while (planSha256 !== originalPlanSha256 || approvalSha256 !== originalApprovalSha256) {
    need(seen.size < 16, "repair chain is too long");
    const { receiptPath, receiptDir, repairId } = receiptLocation(episodeDir, approval.exact_repair_receipt_path);
    need(!seen.has(receiptPath), "repair chain contains a cycle");
    seen.add(receiptPath);
    const receiptBytes = await regularBytes(receiptPath);
    need(hash(receiptBytes) === approval.exact_repair_receipt_sha256, "approval receipt hash differs");
    const receipt = JSON.parse(receiptBytes);
    need(receipt.schema === "goldflow_reference_plan_exact_repair_receipt_v1"
      && receipt.status === "passed" && receipt.episode === path.basename(episodeDir)
      && receipt.repair_id === repairId && receipt.provider_calls === 0 && receipt.estimated_cost_usd === 0,
    "receipt is not a passed zero-spend exact repair for this episode");
    need(!await fs.stat(path.join(receiptDir, "failed.json")).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    }), "repair has a failure marker");
    const specBytes = await regularBytes(path.join(receiptDir, "repair_spec.json"));
    need(hash(specBytes) === receipt.spec_sha256, "sealed repair spec hash differs");
    const spec = JSON.parse(specBytes);
    need(spec.schema === "goldflow_reference_plan_exact_repair_v1"
      && spec.episode === receipt.episode && spec.reviewer === receipt.reviewer
      && spec.note === receipt.note, "sealed repair spec differs from receipt");
    const before = {};
    for (const name of SNAPSHOT_FILES) {
      const snapshotPath = path.join(receiptDir, "before", name);
      need(receipt.before_snapshots?.[name] === snapshotPath, `before snapshot path differs for ${name}`);
      const bytes = await regularBytes(snapshotPath);
      need(hash(bytes) === receipt.source_hashes?.[name]
        && receipt.source_hashes[name] === spec.expected?.[EXPECTED_KEYS[name]],
      `before snapshot hash differs for ${name}`);
      before[name] = { bytes, value: JSON.parse(bytes) };
    }
    need(receipt.output_hashes?.["visual_beat_plan.json"] === planSha256,
      "receipt does not bind the current beat plan");
    const replay = replayBeatLocationRepair(before["visual_beat_plan.json"].value,
      spec.beat_location_patches, receipt.updated_at);
    need(replay.groupingLockSha256 === receipt.grouping_lock_sha256
      && before["visual_beat_approval.json"].value.grouping_lock_sha256 === replay.groupingLockSha256
      && before["visual_beat_approval.json"].value.visual_beat_plan_sha256 === receipt.source_hashes["visual_beat_plan.json"]
      && hash(jsonBytes(replay.plan)) === planSha256 && same(replay.beatChanges, receipt.beat_changes),
    "beat changes do not replay from the approved locked grouping");

    const expectedApproval = structuredClone(before["visual_beat_approval.json"].value);
    expectedApproval.visual_beat_plan_path = path.join(episodeDir, "visual_beat_plan.json");
    expectedApproval.visual_beat_plan_sha256 = planSha256;
    expectedApproval.grouping_lock_sha256 = replay.groupingLockSha256;
    expectedApproval.approved_by = spec.reviewer;
    expectedApproval.approval_note = spec.note;
    expectedApproval.previous_visual_beat_plan_sha256 = receipt.source_hashes["visual_beat_plan.json"];
    expectedApproval.previous_visual_beat_approval_sha256 = receipt.source_hashes["visual_beat_approval.json"];
    expectedApproval.exact_repair_receipt_path = receiptPath;
    expectedApproval.exact_repair_receipt_sha256 = hash(receiptBytes);
    expectedApproval.updated_at = receipt.updated_at;
    need(hash(jsonBytes(expectedApproval)) === approvalSha256 && same(expectedApproval, approval),
      "beat approval is not the deterministic guarded update");

    const event = events.find(row => row.event_type === "stage_completed"
      && row.stage === "reference_plan_approval" && row.command === "visual repair-ref-plan"
      && row.exit_code === 0 && row.output_hashes?.["visual_beat_plan.json"] === planSha256
      && row.output_hashes?.["visual_beat_approval.json"] === approvalSha256
      && row.stdout_tail?.includes(`"receipt_path": "${receiptPath}"`));
    need(event, "completed exact-repair execution event is missing");

    planSha256 = receipt.source_hashes["visual_beat_plan.json"];
    approvalSha256 = receipt.source_hashes["visual_beat_approval.json"];
    approval = before["visual_beat_approval.json"].value;
  }
  need(seen.size > 0, "no exact repair receipt was found");
  return { repairCount: seen.size };
}
