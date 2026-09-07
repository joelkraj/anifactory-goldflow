import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validatePilotScript, validatePilotAssetPlan, validatePilotMedia, validatePilotNarrationBundle, validatePilotNarrationSourceCoverage, pilotArtifactContainsPrivateData, PILOT_NARRATION_IMPORT_ADAPTER_STATUS, PILOT_NARRATION_IMPORT_BLOCKER } from "../lib/avatar-pilot-artifacts.mjs";
import { QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK as JOEL } from "../lib/narration-tts-policy.mjs";
import { buildNarrationSubjectiveReviewManifest, buildNarrationSubjectiveReviewDecision, NARRATION_SUBJECTIVE_REVIEW_ATTESTATION } from "../lib/narration-subjective-review.mjs";
import { createFootageSource, footageClipIdentity, footageHash } from "../lib/footage-library.mjs";
const execute = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const script = "Could control change the outcome? We are considering only the film, not the comics.";
const scriptHash = hash(script);
assert.equal(PILOT_NARRATION_IMPORT_ADAPTER_STATUS, "unproven");
assert.equal(validatePilotNarrationSourceCoverage(script, [{ source_text: script, caption_text: script }], "full").status, "passed");
assert.equal(validatePilotNarrationSourceCoverage(script, [{ source_text: "Completely unrelated speech.", caption_text: "Completely unrelated speech." }], "full").status, "blocked");
assert.equal(validatePilotNarrationSourceCoverage(script, [{ source_text: "Could control change the outcome?", caption_text: "Could control change the outcome?" }], "sample").status, "passed");
assert.equal(validatePilotNarrationSourceCoverage(script, [{ source_text: "We are considering only the film, not the comics.", caption_text: "We are considering only the film, not the comics." }], "sample").status, "blocked");
const identity = {
  media_workflow: "avatar_footage_pilot_v1", content_profile: "mcu_what_if_pilot_v1", run_intent: "proof", production_eligible: false,
  pilot_providers: {
    stills: [{ provider: "google_gemini_imagen", model: "fixture-still" }],
    video: { provider: "google_flow", model: "fixture-video", enabled: false },
    narration: { provider: "qwen_local", model: JOEL.model_id, model_revision: JOEL.model_revision, voice_id: JOEL.voice_id, voice_sha256: JOEL.voice_sha256, reference_audio_sha256: JOEL.reference_audio_sha256, reference_text_sha256: JOEL.reference_text_sha256 },
  },
};
const evidence = {
  schema: "goldflow_avatar_pilot_evidence_v1", source_script_sha256: scriptHash,
  claims: [
    { id: "film_action", kind: "film_fact", text: "Synthetic test fact, not a claim about a real film.", source: { title: "Synthetic", edition: "Fixture v1", source_in_sec: 2, source_out_sec: 6, locator: "Manual test locator", reviewed: true, rights_basis: "Locally authored test signal" } },
    { id: "control", kind: "assumption", text: "The changed condition." },
    { id: "outcome", kind: "speculation", text: "A hypothetical consequence." },
    { id: "limits", kind: "limitation", text: "Unestablished limits remain unknown." },
  ],
  review: { reviewer: "fixture", note: "Structural fixture only", all_factual_abilities_reviewed: true, mcu_only: true },
};
assert.equal(validatePilotScript(script, evidence).status, "passed");
assert.equal(validatePilotScript(`${script} Changed.`, evidence).status, "blocked");
assert.equal(validatePilotScript("word ".repeat(301), evidence).status, "blocked");
const unreviewed = structuredClone(evidence); unreviewed.claims[0].source.reviewed = false;
assert.equal(validatePilotScript(script, unreviewed).status, "blocked");
const noRights = structuredClone(evidence); noRights.claims[0].source.rights_basis = "";
assert.equal(validatePilotScript(script, noRights).status, "blocked");
assert.equal(pilotArtifactContainsPrivateData({ source: "https://example.invalid/video?token=secret" }), true);
assert.equal(pilotArtifactContainsPrivateData({ api_key: "test-only" }), true);

const plan = { schema: "goldflow_avatar_pilot_asset_plan_v1", source_script_sha256: scriptHash, assets: [
  { id: "clip", kind: "movie_clip", purpose: "Synthetic evidence", provider: "local", model: "source_native", truth_mode: "film_evidence" },
  { id: "host", kind: "host_pose", purpose: "Question", provider: "google_gemini_imagen", model: "fixture-still", truth_mode: "original_host" },
  { id: "voice", kind: "narration", purpose: "Original commentary", provider: "qwen_local", model: JOEL.model_id, truth_mode: "original_commentary" },
] };
assert.equal(validatePilotAssetPlan(plan, identity).status, "passed");
assert.equal(validatePilotAssetPlan(plan, { ...identity, run_intent: "production" }).status, "blocked");
const unknownProvider = structuredClone(plan); unknownProvider.assets[1].provider = "codex_imagegen";
assert.equal(validatePilotAssetPlan(unknownProvider, identity).status, "blocked");
const optionalVideo = structuredClone(plan); optionalVideo.assets.push({ id: "motion", kind: "concept_video", purpose: "Hypothesis", provider: "google_flow", model: "fixture-video", truth_mode: "hypothetical_concept", first_frame_asset_id: "host" });
assert.equal(validatePilotAssetPlan(optionalVideo, identity).status, "blocked");
assert.equal((await validatePilotMedia({ schema: "goldflow_avatar_pilot_media_v1", source_script_sha256: scriptHash, assets: [] }, { episodeDir: "/tmp", identity, assetPlan: plan })).status, "blocked");

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-avatar-artifact-test-"));
try {
  const fileRef = async (filePath) => ({ path: filePath, sha256: hash(await fs.readFile(filePath)) });
  const write = async (name, value) => {
    const target = path.join(scratch, name);
    await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
    return fileRef(target);
  };
  const wave = path.join(scratch, "synthetic-not-joel.wav");
  await execute("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=280:sample_rate=24000:duration=18", "-c:a", "pcm_s16le", wave]);
  const audio = await fileRef(wave);
  const planDoc = { source_script_hash: scriptHash, units: [{ unit_id: "unit_01", spoken_text: script }] };
  const generation_plan = await write("plan.json", planDoc);
  const unitResult = { unit_id: "unit_01", spoken_text_sha256: scriptHash, token_limit_reached: false, voice_id: JOEL.voice_id, voice_sha256: JOEL.voice_sha256, model_id: JOEL.model_id, model_revision: JOEL.model_revision, audio_path: wave, audio_sha256: audio.sha256 };
  const voice_continuity = await write("continuity.json", { schema: "goldflow_narration_voice_continuity_qa_v2", status: "passed", voice_id: JOEL.voice_id, voice_sha256: JOEL.voice_sha256, blockers: [] });
  const subjective = buildNarrationSubjectiveReviewManifest({ plan: planDoc, stitch: { prepared_inputs: [{ unit_id: "unit_01", sample_count: 432000 }] }, audioPath: wave, audioSha256: audio.sha256, generationPlanSha256: generation_plan.sha256, generationPlanFileSha256: generation_plan.sha256, qualityContractSha256: "c".repeat(64) });
  const subjective_manifest = await write("subjective.json", subjective);
  const subjective_decision = await write("listened.json", buildNarrationSubjectiveReviewDecision({ manifest: subjective, reviewer: "synthetic-structural-fixture-not-listening-proof", attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION, decisions: subjective.samples.map((row) => ({ sample_id: row.sample_id, decision: "accept" })) }));
  const lineage = { source_script_hash: scriptHash, narration_generation_plan_file_sha256: generation_plan.sha256 };
  const tts_report = await write("tts.json", { ...lineage, schema: "goldflow_provider_neutral_narration_tts_report_v2", status: "passed", primary_provider: "qwen_local", primary_model_id: JOEL.model_id, primary_model_revision: JOEL.model_revision, voice_id: JOEL.voice_id, voice_sha256: JOEL.voice_sha256, primary: JOEL, post_tempo_normalized: false, voice_continuity_report_sha256: voice_continuity.sha256, results: [unitResult] });
  const stitch_report = await write("stitch.json", { ...lineage, schema: "goldflow_provider_neutral_narration_stitch_v2", status: "passed", final_wav_sha256: audio.sha256, output_sha256: audio.sha256, final_duration_sec: 18, sample_accounting: { exact_sample_accounting: true, expected_sample_count: 432000, actual_sample_count: 432000 }, subjective_review_manifest_sha256: subjective.manifest_sha256 });
  const full_stream_qa = await write("delivery.json", { ...lineage, schema: "goldflow_narration_full_stream_qa_v2", status: "passed", audio_sha256: audio.sha256, blockers: [] });
  const whisper_timing = await write("whisper.json", { schema: "goldflow_local_whisper_word_timing_v2", status: "passed", source_script_hash: scriptHash, narration_audio_hash: audio.sha256, narration_report_sha256: tts_report.sha256, alignment_model: "small.en", alignment_device: "cpu", alignment_compute_type: "int8_float32", alignment_omp_num_threads: 12, alignment_cpu_threads: 0, words: [{ word: "Synthetic", start: 0, end: 18 }] });
  const bundle = { schema: "goldflow_avatar_pilot_narration_bundle_v1", phase: "sample", source_script_sha256: scriptHash, audio, generation_plan, tts_report, stitch_report, full_stream_qa, voice_continuity, subjective_manifest, subjective_decision, whisper_timing };
  const options = { episodeDir: scratch, identity, phase: "sample", sourceScriptSha256: scriptHash };
  const rejectedStub = await validatePilotNarrationBundle(bundle, options);
  assert.equal(rejectedStub.status, "blocked");
  assert.ok(rejectedStub.findings.some((row) => row.code === "pilot_narration_canonical_lineage_receipts_required"));
  assert.ok(rejectedStub.findings.some((row) => row.code === PILOT_NARRATION_IMPORT_BLOCKER));
  // A tone plus self-authored passed QA fields is NOT audited narration.
  // Even supplied stub lineage filenames cannot activate the unreleased adapter.
  const approvedPath = path.join(scratch, "approved-script.md");
  await fs.writeFile(approvedPath, script);
  const stubLineage = await write("empty-lineage.json", {});
  const withStubLineage = { ...bundle, pre_synthesis_gate: stubLineage, spoken_text_ir: stubLineage, spoken_text_audit: stubLineage, provider_output_manifest: stubLineage };
  const rejectedLineage = await validatePilotNarrationBundle(withStubLineage, { ...options, identity: { ...identity, source_script: await fileRef(approvedPath) } });
  assert.equal(rejectedLineage.status, "blocked");
  assert.ok(rejectedLineage.findings.some((row) => row.code === PILOT_NARRATION_IMPORT_BLOCKER));
  assert.equal((await validatePilotNarrationBundle({ ...bundle, subjective_decision: null }, options)).status, "blocked");
  assert.equal((await validatePilotNarrationBundle(bundle, { ...options, sourceScriptSha256: "d".repeat(64) })).status, "blocked");
  assert.equal((await validatePilotNarrationBundle({ ...bundle, phase: "full" }, { ...options, phase: "full" })).status, "blocked");

  const clipDir = path.join(scratch, "library-clip"); await fs.mkdir(clipDir);
  const clipPath = path.join(clipDir, "clip.mp4");
  await execute("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=30:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", clipPath]);
  const clipRef = await fileRef(clipPath);
  const source = createFootageSource({ identity: { provider: "local", source_id: "fixture", file_id: "fixture", filename: "clip.mp4", bytes: (await fs.stat(clipPath)).size, local_path: clipPath, local_sha256: clipRef.sha256 }, title: "Synthetic", edition: "Fixture v1", rightsNote: "Locally authored fixture" });
  const sourceRef = await write("source.json", source);
  const request = footageClipIdentity(source, 0, 4);
  const clipReceipt = { schema: "goldflow_footage_clip_v1", id: `clip_${footageHash(request)}`, request, source_manifest_sha256: source.manifest_sha256, source_title: source.title, source_edition: source.edition, clip_sha256: clipRef.sha256, actual_duration_sec: 4, width: 64, height: 64, audio_policy: "removed", production_eligible: false };
  clipReceipt.receipt_sha256 = footageHash(clipReceipt);
  const receiptRef = await write("library-clip/receipt.json", clipReceipt);
  const approvalRef = await write("library-clip/approval.json", { schema: "goldflow_footage_clip_approval_v1", decision: "approved", production_eligible: false, clip_sha256: clipRef.sha256, receipt_sha256: clipReceipt.receipt_sha256, reviewer: "fixture", note: "Synthetic fixture" });
  const clip = { ...plan.assets[0], ...clipRef, duration_sec: 4, receipt_path: receiptRef.path, receipt_sha256: receiptRef.sha256, source_manifest_path: sourceRef.path, source_manifest_sha256: sourceRef.sha256, library_approval_path: approvalRef.path, library_approval_sha256: approvalRef.sha256, title: source.title, edition: source.edition, source_in_sec: 0, source_out_sec: 4, rights_basis: "Locally authored fixture", review: { approved: true, reviewer: "fixture", note: "Pilot use of fixture reviewed" } };
  const media = { schema: "goldflow_avatar_pilot_media_v1", source_script_sha256: scriptHash, assets: [clip, { ...plan.assets[1], path: "missing.png", sha256: "f".repeat(64) }, { ...plan.assets[2], ...audio, receipt_path: "missing-full-bundle.json", receipt_sha256: "f".repeat(64) }] };
  const mediaOptions = { episodeDir: scratch, identity, assetPlan: plan };
  const checked = await validatePilotMedia(media, mediaOptions);
  assert.equal(checked.status, "blocked");
  assert.equal(checked.findings.filter((row) => row.id === "clip").length, 0, JSON.stringify(checked.findings));
  const changedEdition = structuredClone(media); changedEdition.assets[0].edition = "Wrong edition";
  assert.ok((await validatePilotMedia(changedEdition, mediaOptions)).findings.some((row) => row.code === "pilot_movie_source_lineage_invalid"));
  const permissionMissing = structuredClone(media); permissionMissing.assets[0].rights_basis = "";
  assert.ok((await validatePilotMedia(permissionMissing, mediaOptions)).findings.some((row) => row.code === "pilot_movie_source_lineage_invalid"));
  const wrongDuration = structuredClone(media); wrongDuration.assets[0].duration_sec = 3;
  assert.ok((await validatePilotMedia(wrongDuration, mediaOptions)).findings.some((row) => row.code === "pilot_media_declared_duration_must_match_probe" && row.id === "clip"));
  await fs.appendFile(clipPath, "changed");
  assert.ok((await validatePilotMedia(media, mediaOptions)).findings.some((row) => row.id === "clip"));
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
console.log("Avatar pilot artifact tests passed (synthetic files; no providers or real media).");
