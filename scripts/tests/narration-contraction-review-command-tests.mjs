import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildContractionReviewEvidenceForTests,
  contractionReviewStatusAdmissionForTests,
} from "../tts-contraction-review.mjs";
import {
  CONTRACTION_ALIAS, CONTRACTION_EVIDENCE_SCHEMA,
} from "../lib/narration-contraction-repair.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const h = (value) => sha(`fixture:${value}`);
const episodeDir = "/tmp/exact-contraction-episode/ep_01";
const command = `node bin/goldflow.mjs tts review-contraction --episode-dir ${episodeDir}`;
const status = { episode_dir: episodeDir, current_stage: "qwen_tts_stitch",
  current_stage_state: "blocked", next_command_shape: command };
assert.equal(contractionReviewStatusAdmissionForTests(status, episodeDir), true);
for (const changed of [
  { current_stage_state: "ready" },
  { current_stage: "whisper_timing" },
  { next_command_shape: command.replace("review-contraction", "repair-contraction") },
  { episode_dir: "/tmp/other-episode/ep_01" },
]) assert.equal(contractionReviewStatusAdmissionForTests({ ...status, ...changed }, episodeDir), false);

const unitId = "narr_voice_seg_84_u001-002_3193dd7890af";
const spoken = "She’d looked at me in the mirror. She knew where she was going.";
const selected = { unit_id: unitId, audio_sha256: h("selected-audio"),
  synthesis_identity_sha256: h("selected-identity") };
const args = {
  unitId, sourceScriptSha256: h("script"), identityFileSha256: h("identity"),
  plan: { plan_sha256: h("plan"), units: [{ unit_id: unitId, spoken_text: spoken }] },
  planFileSha256: h("plan-file"),
  report: { blockers: [{ unit_id: unitId,
    code: "narration_confirmed_opening_token_mismatch" }] },
  reportFileSha256: h("report-file"), deliveryFileSha256: h("delivery-file"),
  manifestFileSha256: h("manifest-file"), selected,
  boundaryRequestFileSha256: h("boundary-request"),
  boundaryResultFileSha256: h("boundary-result"),
  reviewedAt: "2026-10-02T20:00:00.000Z",
};
const receipt = buildContractionReviewEvidenceForTests(args);
assert.equal(receipt.schema, CONTRACTION_EVIDENCE_SCHEMA);
assert.equal(receipt.status, "reviewed");
assert.equal(receipt.evidence_basis, "reviewed_automated_delivery_qa");
assert.equal(receipt.authorization_origin, "user_authorized_autonomous_production");
assert.equal(receipt.human_listening_performed, false);
assert.equal(receipt.user_listening_claimed, false);
assert.match(receipt.reviewed_by, /automated QA/);
assert.equal(receipt.expected_first_fragment, CONTRACTION_ALIAS.from);
assert.equal(receipt.tts_only_first_fragment, CONTRACTION_ALIAS.to);
assert.equal(receipt.remainder_text, "in the mirror. She knew where she was going.");
assert.equal(receipt.prior_audio_sha256, selected.audio_sha256);
assert.equal(receipt.prior_synthesis_identity_sha256, selected.synthesis_identity_sha256);
assert.equal(receipt.prior_boundary_result_sha256, args.boundaryResultFileSha256);
assert.equal(receipt.prior_provider_manifest_file_sha256, args.manifestFileSha256);

for (const changed of [
  { report: { blockers: [] } },
  { report: { blockers: [...args.report.blockers, ...args.report.blockers] } },
  { report: { blockers: [{ unit_id: unitId, code: "unrelated_blocker" }] } },
  { plan: { ...args.plan, units: [{ unit_id: unitId, spoken_text: "She looked at me." }] } },
]) assert.throws(() => buildContractionReviewEvidenceForTests({ ...args, ...changed }),
  /Contraction review/);

console.log("narration-contraction-review-command-tests: passed");
