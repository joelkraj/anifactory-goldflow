import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPilotNarrationValidationFixture } from "./avatar-pilot-narration-validation-tests.mjs";
import { buildPilotNarrationReviewFixture } from "./avatar-pilot-narration-review-tests.mjs";
import { validatePilotReviewCachedStitch, validateFullPilotFinalizationExecutionEvidence } from "../lib/narration-full-pilot-finalization.mjs";
import { narrationFinalizationStageKey, narrationFinalizationUnitKey,
  emptyNarrationFinalizationCheckpoint } from "../lib/narration-finalization-checkpoint.mjs";
import { finalizeNarrationProviderOutput } from "../narration-provider-output-finalize.mjs";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "../lib/narration-tts-policy.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function inventory(directory) {
  const rows = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push([file, "directory"], ...await inventory(file));
    else if (entry.isSymbolicLink()) rows.push([file, await fs.readlink(file)]);
    else rows.push([file, hash(await fs.readFile(file))]);
  }
  return rows.sort(([left], [right]) => left.localeCompare(right));
}

// Real synthetic local PCM WAV files and real cache keys/validators. These
// structural records never represent a real voice take or human listening.
const fixture = await buildPilotNarrationValidationFixture();
const { root: episodeDir, identity, result, manifest, plan, originals } = fixture;
const qualityContractSha256 = identity.narration_quality_contract.contract_sha256;
const keys = plan.units.map((unit, index) => narrationFinalizationUnitKey({
  unit: { ...manifest.units[index], spoken_text_sha256: unit.spoken_text_sha256 },
  qualityContractSha256, provider: manifest.provider, modelId: manifest.model_id,
  modelRevision: manifest.model_revision, voiceId: manifest.voice_id,
  voiceSha256: manifest.voice_sha256, voiceContinuityContract: manifest.voice_continuity_contract,
}));
const inputKey = narrationFinalizationStageKey("semantic_stitch", {
  ordered_unit_keys: keys, quality_contract_sha256: qualityContractSha256,
  stitch_sample_rate_hz: 24000, alignment_policy: "narration_alignment_safe_semantic_stitch_v2",
});
const checkpoint = emptyNarrationFinalizationCheckpoint({ fixture_only: true });
const rawAudio = result.finalization_artifacts.audio;
checkpoint.stages.semantic_stitch = { input_key: inputKey, status: "passed", payload: {
  raw_wav_path: rawAudio.path, raw_wav_sha256: rawAudio.sha256,
  stitch: { status: "passed", sample_accounting: { exact_sample_accounting: true },
    prepared_inputs: originals.map((row) => ({ unit_id: row.unit_id,
      prepared_wav: row.output_path, prepared_audio_sha256: row.output_sha256 })) },
} };
const options = { checkpoint, rawAudio, units: plan.units, manifest, qualityContractSha256 };
const tests = [];
const test = (name, body) => tests.push([name, body]);
const reject = async (value, pattern = /review continuation/) => {
  const before = await inventory(episodeDir);
  await assert.rejects(() => validatePilotReviewCachedStitch(value), pattern);
  assert.deepEqual(await inventory(episodeDir), before, "Cache rejection must not write or repair an artifact");
};

test("exact original raw and prepared WAVs reuse a content-bound stitch without mutation", async () => {
  const before = await inventory(episodeDir);
  const checked = await validatePilotReviewCachedStitch(options);
  assert.equal(checked.inputKey, inputKey);
  assert.deepEqual(checked.rawAudio, rawAudio);
  assert.deepEqual(checked.stitch, checkpoint.stages.semantic_stitch.payload.stitch);
  checked.stitch.prepared_inputs.reverse();
  assert.deepEqual(checkpoint.stages.semantic_stitch.payload.stitch.prepared_inputs.map((row) => row.unit_id), plan.units.map((unit) => unit.unit_id));
  assert.deepEqual(await inventory(episodeDir), before);
});
test("missing, failed, wrong-version and differently keyed stitches never fall back to restitch", async () => {
  for (const mutate of [
    (row) => { delete row.stages.semantic_stitch; },
    (row) => { row.schema = "untrusted_cache"; },
    (row) => { row.stages.semantic_stitch.status = "blocked"; },
    (row) => { row.stages.semantic_stitch.input_key = "0".repeat(64); },
    (row) => { row.stages.semantic_stitch.payload.stitch.status = "blocked"; },
    (row) => { row.stages.semantic_stitch.payload.stitch.sample_accounting.exact_sample_accounting = false; },
  ]) {
    const changed = structuredClone(checkpoint); mutate(changed);
    await reject({ ...options, checkpoint: changed }, /restitching is forbidden/);
  }
});
test("new source order, changed voice, changed raw-unit identity or quality contract cannot reuse", async () => {
  await reject({ ...options, units: [...plan.units].reverse() });
  await reject({ ...options, qualityContractSha256: "0".repeat(64) });
  for (const mutate of [
    (row) => { row.voice_id = "another-voice"; },
    (row) => { row.units[0].audio_sha256 = "0".repeat(64); },
    (row) => { row.units[0].synthesis_identity_sha256 = "0".repeat(64); },
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    await reject({ ...options, manifest: changed });
  }
});
test("same-byte copied raw audio is not the exact originally heard raw path", async () => {
  const file = path.join(fixture.namespace, "copied-raw-fixture.wav");
  await fs.copyFile(rawAudio.path, file);
  await reject({ ...options, rawAudio: { ...rawAudio, path: file } });
});
test("missing or reordered prepared input mappings fail before processing", async () => {
  for (const mutate of [
    (rows) => rows.pop(), (rows) => rows.reverse(),
    (rows) => { delete rows[0].prepared_wav; },
    (rows) => { rows[0].prepared_audio_sha256 = "0".repeat(64); },
  ]) {
    const changed = structuredClone(checkpoint);
    mutate(changed.stages.semantic_stitch.payload.stitch.prepared_inputs);
    await reject({ ...options, checkpoint: changed });
  }
});
test("stale raw or prepared WAVs cannot be repaired, restitched or accepted", async () => {
  for (const file of [rawAudio.path, originals[0].output_path]) {
    const original = await fs.readFile(file);
    await fs.appendFile(file, "stale fixture");
    try { await reject(options, /stale; restitching is forbidden/); }
    finally { await fs.writeFile(file, original); }
  }
});
test("prepared symlinks are rejected even when their content hash matches", async () => {
  const symlink = path.join(fixture.namespace, "linked-prepared-fixture.wav");
  await fs.symlink(originals[0].output_path, symlink);
  const changed = structuredClone(checkpoint);
  changed.stages.semantic_stitch.payload.stitch.prepared_inputs[0].prepared_wav = symlink;
  await reject({ ...options, checkpoint: changed }, /restitching is forbidden/);
});
test("actual finalizer refuses review CLI overrides and disabled mastering before any write", async () => {
  const phaseContext = { phase: "full_pilot", reviewContinuation: {},
    outputNamespace: path.join(episodeDir, "pilot_narration_work", "full_finalization_reviewed") };
  const argv = ["--episode-dir", episodeDir, "--script", identity.source_script.path,
    "--plan", result.generation_plan.path, "--manifest", result.provider_output_manifest.path];
  const before = await inventory(episodeDir);
  const mkdir = fs.mkdir; let writes = 0;
  fs.mkdir = async () => { writes++; throw new Error("Unexpected output write"); };
  try {
    for (const flag of ["checkpoint", "listen-decision", "workflow-bypass", "accept-review-warnings", "skip-subjective-review"]) {
      await assert.rejects(() => finalizeNarrationProviderOutput([...argv, `--${flag}`, "false"], { phaseContext }), /unavailable/);
    }
    await assert.rejects(() => finalizeNarrationProviderOutput([...argv, "--master", "false"], { phaseContext }), /cannot disable canonical mastering/);
  } finally { fs.mkdir = mkdir; }
  assert.equal(writes, 0);
  assert.deepEqual(await inventory(episodeDir), before);
});
test("genuine raw review authorizes only the unchanged full plan in a fresh reviewed namespace", async () => {
  const reviewed = await buildPilotNarrationReviewFixture();
  try {
    const prior = reviewed.priorResult;
    const context = { ...prior.finalized.phase_context, reviewContinuation: reviewed.reviewContinuation,
      outputNamespace: path.join(reviewed.root, "pilot_narration_work", "full_finalization_reviewed") };
    const reviewedOptions = { phaseContext: context, episodeDir: reviewed.root, identity: reviewed.identity,
      identityPath: path.join(reviewed.root, "run_identity.json"), scriptPath: reviewed.identity.source_script.path,
      planPath: prior.generation_plan.path, plan: reviewed.plan,
      manifestPath: prior.provider_output_manifest.path,
      manifest: JSON.parse(await fs.readFile(prior.provider_output_manifest.path, "utf8")),
      policy: validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(reviewed.identity), { production: true }) };
    const before = await inventory(reviewed.root);
    const checked = await validateFullPilotFinalizationExecutionEvidence(reviewedOptions);
    assert.deepEqual(checked.scope.review_continuation, reviewed.reviewContinuation);
    assert.deepEqual(checked.reviewContinuation.rawAudio, reviewed.rawAudioRef);
    assert.deepEqual(checked.reviewContinuation.checkpoint, reviewed.checkpoint);
    assert.deepEqual(checked.synthesisRuns, reviewedOptions.manifest.provider_execution.synthesis_runs);
    assert.equal(checked.scope.subjective_review_status, "pending");
    assert.deepEqual(await inventory(reviewed.root), before);
    const argv = ["--episode-dir", reviewed.root, "--script", reviewedOptions.scriptPath,
      "--plan", reviewedOptions.planPath, "--manifest", reviewedOptions.manifestPath];
    const mkdir = fs.mkdir; let writes = 0;
    fs.mkdir = async () => { writes++; throw new Error("Unexpected reviewed finalization output creation"); };
    try {
      for (const key of Object.keys(reviewed.reviewContinuation)) {
        const changed = structuredClone(context);
        changed.reviewContinuation[key].sha256 = "0".repeat(64);
        await assert.rejects(() => finalizeNarrationProviderOutput(argv, { phaseContext: changed }),
          key === "rawAudio" ? /reviewed raw audio differs from the original pending take/ : /stale artifact/);
      }
      await assert.rejects(() => finalizeNarrationProviderOutput(argv, {
        phaseContext: { ...context, phase: "opening" },
      }), /review continuation is unavailable/);
      await assert.rejects(() => finalizeNarrationProviderOutput(argv, {
        phaseContext: { ...context, reviewContinuation: undefined },
      }), /separate full_finalization namespace/);
    } finally { fs.mkdir = mkdir; }
    assert.equal(writes, 0, "Authorization errors must precede output or model setup");
    assert.deepEqual(await inventory(reviewed.root), before);
    await fs.mkdir(context.outputNamespace);
    await assert.rejects(() => finalizeNarrationProviderOutput(argv, { phaseContext: context }), /must be new/);
  } finally { await reviewed.cleanup(); }
});

try {
  for (const [name, body] of tests) { await body(); console.log(`PASS ${name}`); }
  console.log(`Pilot reviewed-finalization tests passed (${tests.length} groups; actual local WAVs, no models/providers).`);
} finally { await fixture.cleanup(); }
