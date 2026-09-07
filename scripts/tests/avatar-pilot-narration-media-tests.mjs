import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPilotNarrationValidationFixture } from "./avatar-pilot-narration-validation-tests.mjs";
import { validatePilotMedia } from "../lib/avatar-pilot-artifacts.mjs";
import {
  buildNarrationSubjectiveReviewDecision, NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
} from "../lib/narration-subjective-review.mjs";
import {
  buildPilotNarrationTiming, validatePilotNarrationAcceptance,
  PILOT_NARRATION_ACCEPTANCE_SCHEMA, PILOT_NARRATION_LISTEN_ATTESTATION,
} from "../lib/avatar-pilot-narration-acceptance.mjs";

// Actual local PCM WAVs and canonical structural validators, never models,
// providers, a real episode, or an assertion of actual human listening.
const fixture = await buildPilotNarrationValidationFixture();
const { root: episodeDir, identity, result } = fixture;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const write = async (file, value) => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await fs.writeFile(file, bytes);
  return { path: file, sha256: hash(bytes) };
};
const read = async (ref) => JSON.parse(await fs.readFile(ref.path, "utf8"));
const inventory = async (dir) => {
  const rows = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) rows.push(...await inventory(file));
    else rows.push([file, hash(await fs.readFile(file))]);
  }
  return rows.sort(([left], [right]) => left.localeCompare(right));
};

try {
  const refs = result.finalization_artifacts;
  const manifest = await read(refs.subjective_manifest);
  const candidate = await read(refs.timing_candidate);
  const delivery = await read(refs.full_stream_qa);
  const narrationRef = await write(path.join(episodeDir, "pilot_narration_work", "narration_producer_result.json"), result);
  const namespace = path.join(episodeDir, "pilot_narration_work", "full_finalization");
  const reviewer = "synthetic fixture reviewer";
  const note = "Synthetic complete-listening decision for code tests, never real audio approval.";
  const decision = buildNarrationSubjectiveReviewDecision({
    manifest, reviewer, attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
    decisions: manifest.samples.map((sample) => ({ sample_id: sample.sample_id, decision: "accept", note })),
  });
  const payload = {
    schema: PILOT_NARRATION_ACCEPTANCE_SCHEMA,
    narration_result: narrationRef, audio: refs.audio,
    subjective_decision: await write(path.join(namespace, `narration_subjective_review_decision_${identity.episode}.json`), decision),
    whisper_timing: await write(path.join(namespace, "pilot_word_timing.json"), buildPilotNarrationTiming({ result, candidate, delivery, identity })),
    production_eligible: false, publish_allowed: false,
    review: { approved: true, reviewer, note, attestation: PILOT_NARRATION_LISTEN_ATTESTATION },
    listening_attestation_mapping: {
      operator_attestation: PILOT_NARRATION_LISTEN_ATTESTATION,
      canonical_attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
      audio_sha256: refs.audio.sha256, manifest_sha256: refs.subjective_manifest.sha256,
      all_samples_contained_in_full_narration: true,
      sample_ids: manifest.samples.map((sample) => sample.sample_id),
    },
  };
  const stage = {
    schema: "goldflow_avatar_pilot_stage_v1", stage: "pilot_narration",
    identity_sha256: result.identity_sha256,
    inputs: [
      { role: "upstream", ...result.accepted_opening.approval },
      { role: "produced_narration", ...narrationRef },
      { role: "subjective_manifest", ...refs.subjective_manifest },
      { role: "subjective_decision", ...payload.subjective_decision },
      { role: "whisper_timing", ...payload.whisper_timing },
    ],
    payload, fixture_only: true, created_at: "2026-01-01T00:00:00.000Z",
  };
  const stageRef = await write(path.join(episodeDir, "pilot_narration.json"), stage);
  const planned = {
    id: "narration_main", kind: "narration", purpose: "Complete approved proof narration",
    provider: identity.pilot_providers.narration.provider,
    model: identity.pilot_providers.narration.model, truth_mode: "original_commentary",
  };
  const assetPlan = {
    schema: "goldflow_avatar_pilot_asset_plan_v1", source_script_sha256: result.source_script_sha256,
    assets: [planned],
  };
  const media = {
    schema: "goldflow_avatar_pilot_media_v1", source_script_sha256: result.source_script_sha256,
    assets: [{ ...planned, ...refs.audio, duration_sec: fixture.duration,
      receipt_path: stageRef.path, receipt_sha256: stageRef.sha256,
      review: { approved: true, reviewer, note } }],
  };
  const validate = (value = media) => validatePilotMedia(value, { episodeDir, identity, assetPlan });
  let blocked = 0;
  const reject = async (value, code) => {
    const validation = await validate(value);
    assert.equal(validation.status, "blocked", JSON.stringify(validation));
    if (code) assert.ok(validation.findings.some((finding) => finding.code === code), JSON.stringify(validation.findings));
    blocked++;
  };
  const withReceipt = (ref) => {
    const changed = structuredClone(media);
    Object.assign(changed.assets[0], { receipt_path: ref.path, receipt_sha256: ref.sha256 });
    return changed;
  };
  const before = await inventory(episodeDir);
  assert.equal((await validatePilotNarrationAcceptance(payload, { episodeDir, identity })).status, "passed");
  const good = await validate();
  assert.equal(good.status, "passed", JSON.stringify(good.findings));
  assert.equal(good.import_only, true);
  assert.deepEqual(good.assets, [{ id: planned.id, path: refs.audio.path,
    duration_sec: fixture.duration, width: null, height: null, has_audio: true }]);
  assert.deepEqual(await inventory(episodeDir), before, "Read-only validation wrote or mutated a fixture artifact");

  await reject(withReceipt(await write(path.join(episodeDir, "copied_narration_stage.json"), stage)), "pilot_narration_original_stage_required");
  const wrongIdentity = structuredClone(stage);
  wrongIdentity.identity_sha256 = "0".repeat(64);
  await reject(withReceipt(await write(stageRef.path, wrongIdentity)), "pilot_narration_original_stage_required");
  await write(stageRef.path, stage);

  const originalAudio = await fs.readFile(refs.audio.path);
  await fs.appendFile(refs.audio.path, "stale synthetic audio");
  await reject(media, "pilot_media_bound_receipt_or_local_media_invalid");
  await fs.writeFile(refs.audio.path, originalAudio);

  await fs.appendFile(payload.subjective_decision.path, "\n");
  await reject(media);
  await write(payload.subjective_decision.path, decision);
  const changedDecision = buildNarrationSubjectiveReviewDecision({
    manifest, reviewer: "different synthetic reviewer", attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
    decisions: manifest.samples.map((sample) => ({ sample_id: sample.sample_id, decision: "accept", note })),
  });
  const staleReview = structuredClone(stage);
  staleReview.payload.subjective_decision = await write(payload.subjective_decision.path, changedDecision);
  await reject(withReceipt(await write(stageRef.path, staleReview)));
  await write(payload.subjective_decision.path, decision);
  await write(stageRef.path, stage);

  const openingOnly = structuredClone(stage);
  openingOnly.payload.review.attestation = "complete_opening_listened_end_to_end";
  await reject(withReceipt(await write(stageRef.path, openingOnly)));
  await write(stageRef.path, stage);
  await reject(withReceipt(narrationRef), "pilot_narration_lineage_import_adapter_not_proven");
  await reject(withReceipt(await write(path.join(namespace, "naked_accepted_payload.json"), payload)), "pilot_narration_lineage_import_adapter_not_proven");

  const arbitraryBytes = Buffer.from(originalAudio);
  arbitraryBytes.writeInt16LE(1234, 44);
  const arbitraryPath = path.join(namespace, "unrelated_synthetic_audio.wav");
  await fs.writeFile(arbitraryPath, arbitraryBytes);
  const arbitraryMedia = structuredClone(media);
  arbitraryMedia.assets[0].path = arbitraryPath;
  arbitraryMedia.assets[0].sha256 = hash(arbitraryBytes);
  await reject(arbitraryMedia, "pilot_narration_media_hash_mismatch");
  const staleReceipt = structuredClone(media);
  staleReceipt.assets[0].receipt_sha256 = "0".repeat(64);
  await reject(staleReceipt, "pilot_media_bound_receipt_or_local_media_invalid");
  assert.equal((await validate()).status, "passed");
  console.log(`Pilot accepted-narration media tests passed (real local WAV positive; ${blocked} blocked mutations; synthetic reviews only, no models/providers).`);
} finally {
  await fixture.cleanup();
}
