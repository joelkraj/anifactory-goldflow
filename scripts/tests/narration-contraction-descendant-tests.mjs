import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  narrationProviderOutputManifestSha256,
} from "../lib/narration-provider-adapter.mjs";
import {
  CONTRACTION_FOLLOWON_UNIT_ID, CONTRACTION_MODE,
  CONTRACTION_TARGET_UNIT_ID,
  validateContractionDescendantManifestForTests,
} from "../lib/narration-contraction-repair.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const root = { status: "passed", units: [
  { unit_id: CONTRACTION_FOLLOWON_UNIT_ID, audio_path: "/episode/seg08-old.wav",
    audio_sha256: sha("seg08-old"), spoken_text_sha256: sha("seg08 text"),
    synthesis_identity_sha256: sha("seg08 identity") },
  { unit_id: CONTRACTION_TARGET_UNIT_ID, audio_path: "/episode/seg84.wav",
    audio_sha256: sha("seg84"), synthesis_mode: CONTRACTION_MODE,
    spoken_text_sha256: sha("seg84 text") },
  { unit_id: "preserved", audio_path: "/episode/preserved.wav",
    audio_sha256: sha("preserved") },
] };
root.manifest_sha256 = narrationProviderOutputManifestSha256(root);
const request = { schema: "goldflow_tts_exact_boundary_repair_request_v1",
  request_sha256: sha("request"), prior_manifest_sha256: root.manifest_sha256,
  full_stream_targets: [{ unit_id: CONTRACTION_FOLLOWON_UNIT_ID }],
  units: [{ unit_id: CONTRACTION_FOLLOWON_UNIT_ID,
    prior_audio_sha256: root.units[0].audio_sha256,
    prior_synthesis_identity_sha256: root.units[0].synthesis_identity_sha256,
    spoken_text_sha256: root.units[0].spoken_text_sha256,
    spoken_text: "There was probably an answer. I could not imagine one.",
    fragments: ["There was probably an answer.", "I could not imagine one."],
    prior_blocker_codes: ["narration_confirmed_tts_transcript_protected_value_mismatch"],
  }] };
const result = { schema: "goldflow_tts_exact_boundary_repair_result_v1",
  request_sha256: request.request_sha256,
  units: [{ unit_id: CONTRACTION_FOLLOWON_UNIT_ID,
    audio_path: "/episode/seg08-new.wav", audio_sha256: sha("seg08-new") }] };
const derived = structuredClone(root);
Object.assign(derived.units[0], {
  audio_path: result.units[0].audio_path,
  audio_sha256: result.units[0].audio_sha256,
  synthesis_identity_sha256: sha("seg08-new identity"),
  synthesis_mode: "exact_sentence_boundary_composite_v1",
  recovery_provenance: {
    schema: "goldflow_tts_exact_boundary_repair_provenance_v1",
    prior_audio_sha256: root.units[0].audio_sha256,
    prior_synthesis_identity_sha256: root.units[0].synthesis_identity_sha256,
  },
});
derived.provider_execution = { exact_boundary_repair: {
  request_sha256: request.request_sha256,
  repaired_unit_ids: [CONTRACTION_FOLLOWON_UNIT_ID], preserved_unit_count: 2,
} };
derived.repair_history = [{ mode: "exact_sentence_boundary_composite_v1",
  prior_manifest_sha256: root.manifest_sha256,
  request_sha256: request.request_sha256 }];
derived.manifest_sha256 = narrationProviderOutputManifestSha256(derived);
const args = { rootManifest: root, derivedManifest: derived, request, result,
  proof: { unit_id: CONTRACTION_TARGET_UNIT_ID } };
assert.equal(validateContractionDescendantManifestForTests(args), true);
const secondRequest = structuredClone(request);
secondRequest.request_sha256 = sha("second request");
secondRequest.prior_manifest_sha256 = derived.manifest_sha256;
secondRequest.units[0].prior_audio_sha256 = derived.units[0].audio_sha256;
secondRequest.units[0].prior_synthesis_identity_sha256
  = derived.units[0].synthesis_identity_sha256;
const secondResult = structuredClone(result);
secondResult.request_sha256 = secondRequest.request_sha256;
secondResult.units[0].audio_path = "/episode/seg08-third.wav";
secondResult.units[0].audio_sha256 = sha("seg08-third");
const secondDerived = structuredClone(derived);
secondDerived.units[0].audio_path = secondResult.units[0].audio_path;
secondDerived.units[0].audio_sha256 = secondResult.units[0].audio_sha256;
secondDerived.units[0].recovery_provenance.prior_audio_sha256
  = derived.units[0].audio_sha256;
secondDerived.units[0].recovery_provenance.prior_synthesis_identity_sha256
  = derived.units[0].synthesis_identity_sha256;
secondDerived.provider_execution.exact_boundary_repair.request_sha256
  = secondRequest.request_sha256;
secondDerived.repair_history.push({ mode: "exact_sentence_boundary_composite_v1",
  prior_manifest_sha256: derived.manifest_sha256,
  request_sha256: secondRequest.request_sha256 });
secondDerived.manifest_sha256 = narrationProviderOutputManifestSha256(secondDerived);
assert.equal(validateContractionDescendantManifestForTests({
  rootManifest: derived, derivedManifest: secondDerived,
  request: secondRequest, result: secondResult,
  proof: { unit_id: CONTRACTION_TARGET_UNIT_ID },
}), true, "a second seg08-only follow-on may preserve the same contraction root");
for (const changed of [
  { derivedManifest: (() => { const copy = structuredClone(derived);
    copy.units[1].audio_sha256 = sha("seg84 changed");
    copy.manifest_sha256 = narrationProviderOutputManifestSha256(copy);
    return copy; })() },
  { request: null },
  { derivedManifest: (() => { const copy = structuredClone(derived);
    copy.units[2].audio_sha256 = sha("unrelated changed");
    copy.manifest_sha256 = narrationProviderOutputManifestSha256(copy);
    return copy; })() },
  { derivedManifest: (() => { const copy = structuredClone(derived);
    copy.repair_history[0].prior_manifest_sha256 = sha("stale ancestor");
    copy.manifest_sha256 = narrationProviderOutputManifestSha256(copy);
    return copy; })() },
  { request: { ...request, prior_manifest_sha256: sha("wrong root") } },
]) assert.throws(() => validateContractionDescendantManifestForTests({
  ...args, ...changed,
}), /Contraction expansion:/);
console.log("PASS exact contraction candidate is preserved across only the reviewed seg08 boundary descendant");
