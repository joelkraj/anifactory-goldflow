import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  deriveContractionCandidateManifestForTests,
} from "../tts-contraction-candidate.mjs";
import {
  CONTRACTION_ALIAS, CONTRACTION_MODE,
} from "../lib/narration-contraction-repair.mjs";
import {
  narrationSynthesisIdentitySha256,
} from "../lib/narration-provider-adapter.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const h = (value) => sha(`fixture:${value}`);
const targetIndex = 84;
const targetId = "narr_voice_seg_84_u001-002_3193dd7890af";
const rows = Array.from({ length: 909 }, (_, index) => ({
  unit_id: index === targetIndex ? targetId : `unit-${String(index).padStart(3, "0")}`,
  audio_path: `/tmp/previous-${index}.wav`, audio_sha256: h(`audio-${index}`),
  synthesis_identity_sha256: h(`identity-${index}`),
  recovery_provenance: { schema: "goldflow_tts_exact_boundary_repair_provenance_v1",
    request_path: `/tmp/boundary-${index}.json`, result_path: `/tmp/result-${index}.json` },
}));
const manifest = {
  provider: "qwen_local", model_id: "pinned-qwen", model_revision: "pinned-revision",
  voice_id: "joel_owned_narrator_clone", voice_sha256: h("voice"),
  voice_continuity_contract: "qwen_icl_clone_of_joel_owned_dry_deadpan_reference",
  manifest_sha256: h("manifest"),
  provider_execution: { preexisting: "kept" },
  repair_history: [{ mode: "prior_boundary_repair" }],
  units: rows,
};
const request = {
  unit_id: targetId, spoken_text_sha256: h("locked-text"),
  request_sha256: h("request"), defect_evidence_sha256: h("reviewed-evidence"),
  prior_audio_sha256: rows[targetIndex].audio_sha256,
  prior_synthesis_identity_sha256: rows[targetIndex].synthesis_identity_sha256,
  prior_boundary_request_path: "/tmp/prior-boundary-request.json",
  prior_boundary_request_file_sha256: h("prior-boundary-request"),
  prior_boundary_result_path: "/tmp/prior-boundary-result.json",
  prior_boundary_result_file_sha256: h("prior-boundary-result"),
  expected_first_fragment: CONTRACTION_ALIAS.from,
  tts_only_first_fragment: CONTRACTION_ALIAS.to,
  retained_remainder: { audio_sha256: h("remainder") },
};
const result = { unit: {
  unit_id: targetId, spoken_text_sha256: request.spoken_text_sha256,
  audio_path: "/tmp/new-candidate.wav", audio_sha256: h("candidate"),
  duration_sec: 4.5, gap_sample_count: 1920,
  generated_token_count: 12, effective_token_limit: 1200,
  expanded_fragment: { text: CONTRACTION_ALIAS.to,
    audio_sha256: h("expanded-fragment") },
  retained_remainder: { audio_sha256: h("remainder") },
} };
const requestPath = "/tmp/candidate/request.json";
const resultPath = "/tmp/candidate/repair-result.json";
const resultFileSha256 = h("result-file");
const evidencePath = "/tmp/reviewed-evidence.json";
const next = deriveContractionCandidateManifestForTests({ manifest, request, result,
  requestPath, resultPath, resultFileSha256, evidencePath });

assert.equal(manifest.units[targetIndex].audio_path, rows[targetIndex].audio_path);
assert.equal(next.units.length, 909);
assert.equal(next.provider_execution.contraction_candidate.preserved_unit_count, 908);
assert.equal(next.provider_execution.preexisting, "kept");
assert.equal(next.repair_history.length, 2);
assert.equal(next.repair_history[1].mode, CONTRACTION_MODE);
assert.equal(next.manifest_sha256, undefined);
for (const [index, row] of manifest.units.entries()) {
  if (index !== targetIndex) assert.deepEqual(next.units[index], row);
}
const selected = next.units[targetIndex];
assert.equal(selected.audio_path, result.unit.audio_path);
assert.equal(selected.audio_sha256, result.unit.audio_sha256);
assert.equal(selected.synthesis_mode, CONTRACTION_MODE);
assert.equal(selected.provider_receipt, null);
assert.equal(selected.provider_unit_qa, null);
assert.equal(selected.recovery_provenance.schema,
  "goldflow_tts_exact_contraction_candidate_provenance_v1");
assert.deepEqual(selected.recovery_provenance.prior_selected, rows[targetIndex]);
assert.equal(selected.recovery_provenance.prior_boundary_result_file_sha256,
  request.prior_boundary_result_file_sha256);
assert.equal(selected.recovery_provenance.human_listening_performed, false);
assert.equal(selected.synthesis_identity.schema,
  "goldflow_tts_exact_contraction_composite_identity_v1");
assert.equal(selected.synthesis_identity.source_first_fragment_sha256,
  sha(CONTRACTION_ALIAS.from));
assert.equal(selected.synthesis_identity.tts_only_first_fragment_sha256,
  sha(CONTRACTION_ALIAS.to));
assert.equal(selected.synthesis_identity.retained_remainder_audio_sha256,
  request.retained_remainder.audio_sha256);
assert.equal(selected.synthesis_identity_sha256,
  narrationSynthesisIdentitySha256(selected.synthesis_identity));

for (const changed of [
  { manifest: { ...manifest, units: manifest.units.slice(1) } },
  { request: { ...request, prior_audio_sha256: h("stale") } },
  { result: { unit: { ...result.unit, gap_sample_count: 1 } } },
  { result: { unit: { ...result.unit, expanded_fragment: { text: "She looked" } } } },
]) {
  assert.throws(() => deriveContractionCandidateManifestForTests({
    manifest, request, result, requestPath, resultPath, resultFileSha256,
    evidencePath, ...changed,
  }), /Contraction candidate/);
}

console.log("narration-contraction-candidate-tests: passed");
