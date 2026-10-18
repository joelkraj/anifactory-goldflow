import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  consumedContractionFullStreamStatusForTests,
  qwenReviewedBoundaryOrAutomatedPronunciationStatusForTests,
} from "../run-status.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(),
  "goldflow-consumed-contraction-status-"));

try {
  const episode = "ep_01";
  const currentScriptHash = sha("locked source");
  const providerOutputPath = path.join(episodeDir, "selected-manifest.json");
  const ttsReport = {
    status: "blocked", unit_qa_status: "passed_with_warnings",
    full_stream_qa_status: "blocked", blockers: [],
    automated_contraction_expansion: { schema: "goldflow_tts_reviewed_contraction_expansion_v1" },
  };
  const unitDelivery = { status: "passed_with_warnings", blocked_unit_count: 0,
    blockers: [] };
  const fullQa = { status: "blocked", blockers: [{
    code: "narration_confirmed_tts_transcript_protected_value_mismatch",
    operations: [{ type: "substitution", intended: "num:1", recognized: "what" }],
    unit_ids: ["narr_voice_seg_07_u003-004_71d180ef1e11",
      "narr_voice_seg_08_u001-003_168f265ecf0e"],
  }] };
  const common = { episodeDir, episode, currentScriptHash, ttsReport,
    unitDelivery, fullQa, providerOutput: {}, providerOutputPath };
  let validationCalls = 0;
  const consumed = await consumedContractionFullStreamStatusForTests({
    ...common, validateApplied: async ({ blockedFullStreamQa }) => {
      validationCalls += 1;
      assert.equal(blockedFullStreamQa, fullQa);
      return true;
    },
  });
  assert.equal(consumed.kind, "consumed");
  assert.equal(validationCalls, 1);

  const reportPath = path.join(episodeDir, `narration_tts_report_${episode}.json`);
  const reportText = `${JSON.stringify(ttsReport)}\n`;
  await fs.writeFile(reportPath, reportText);
  const specPath = path.join(episodeDir, "reviewed-boundary-spec.json");
  await fs.writeFile(specPath, "exact seg08 scope\n");
  await fs.writeFile(path.join(episodeDir,
    `manual_blocker_triage_qwen_tts_stitch_${episode}.json`), JSON.stringify({
    status: "operator_hold_pending_exact_boundary_recovery",
    source_script_sha256: currentScriptHash,
    blocked_report_sha256: sha(reportText),
    repair_spec_path: specPath,
    repair_spec_sha256: sha("exact seg08 scope\n"),
  }));
  const boundary = await qwenReviewedBoundaryOrAutomatedPronunciationStatusForTests({
    episodeDir, episode, ttsReportPath: reportPath,
    ttsReport, currentScriptHash,
    loadAutomated: async () => { throw new Error("stale historical candidate"); },
  });
  assert.equal(boundary.next_command_shape,
    `node bin/goldflow.mjs tts repair-boundary --episode-dir ${episodeDir} --spec ${specPath}`);

  const staleSnapshot = await consumedContractionFullStreamStatusForTests({
    ...common, validateApplied: async () => false,
  });
  assert.equal(staleSnapshot.kind, "hold");
  assert.match(staleSnapshot.next_command_shape, /^Operator hold:/);

  for (const changed of [
    { unitDelivery: { ...unitDelivery, blocked_unit_count: 1 } },
    { unitDelivery: { ...unitDelivery, blockers: [{ unit_id: "another" }] } },
    { ttsReport: { ...ttsReport, unit_qa_status: "blocked" } },
    { fullQa: { ...fullQa, blockers: [...fullQa.blockers, fullQa.blockers[0]] } },
    { fullQa: { ...fullQa, blockers: [{ ...fullQa.blockers[0],
      operations: [{ type: "substitution", intended: "num:1", recognized: "two" }] }] } },
  ]) {
    let called = false;
    const result = await consumedContractionFullStreamStatusForTests({
      ...common, ...changed, validateApplied: async () => { called = true; return true; },
    });
    assert.equal(result.kind, "hold");
    assert.equal(called, false, "unrelated or unit blockers cannot reach candidate validation");
  }
  console.log("PASS consumed contraction lineage routes only one full-stream blocker to exact triage");
} finally {
  await fs.rm(episodeDir, { recursive: true, force: true });
}
