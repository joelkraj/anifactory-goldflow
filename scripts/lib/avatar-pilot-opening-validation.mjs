import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "./narration-tts-policy.mjs";
import { validatePilotNarrationPlanPolicy } from "./avatar-pilot-narration-plan.mjs";
import { validatePilotOpeningExecutionResults } from "./avatar-pilot-opening-execution.mjs";
import { validateNarrationProviderOutputManifest } from "./narration-provider-adapter.mjs";
import { validateNarrationSubjectiveReviewManifest } from "./narration-subjective-review.mjs";
import { validateLocalWhisperTimingCandidate } from "./local-whisper-timing-candidate.mjs";
import { localWhisperContractForIdentity } from "./local-whisper-policy.mjs";

const execute = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const need = (ok, message) => { if (!ok) throw new Error(message); };
const passed = (result, label) => need(result?.status === "passed", `${label}: ${JSON.stringify(result?.findings ?? [])}`);
const accepted = (row) => ["passed", "passed_with_warnings"].includes(row?.status) && Array.isArray(row.blockers) && row.blockers.length === 0;
async function read(ref, json = true) {
  need(path.isAbsolute(ref?.path ?? "") && /^[a-f0-9]{64}$/u.test(ref?.sha256 ?? ""), "Exact local binding required.");
  const stat = await fs.lstat(ref.path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= (json ? 32 * 1024 * 1024 : 512 * 1024 * 1024), "Bound artifact is not a bounded regular file.");
  const data = await fs.readFile(ref.path);
  need(hash(data) === ref.sha256, "Opening artifact hash mismatch.");
  return json ? JSON.parse(data.toString("utf8")) : data;
}

/** Complete technical acceptance for a produced opening. Listening remains a
 * separate operator stage; this does not promote a full-narration import. */
export async function validatePilotOpeningSampleResult(result, { episodeDir, identity } = {}) {
  const findings = [];
  try {
    need(result?.schema === "goldflow_avatar_pilot_opening_producer_result_v1" && result.phase === "opening"
      && result.production_eligible === false && result.publish_allowed === false && result.subjective_approval === null,
    "Opening must be a private produced sample pending genuine listening.");
    const identityPath = path.join(episodeDir, "run_identity.json");
    const identityHash = hash(await fs.readFile(identityPath));
    need(result.identity_sha256 === identityHash && result.source_script_sha256 === identity.source_script.sha256, "Opening identity/source is stale.");
    const sourceBytes = await read(identity.source_script, false);
    const plan = await read(result.generation_plan), ir = await read(result.spoken_text_ir), audit = await read(result.spoken_text_audit);
    const gate = await read(result.pre_synthesis_gate), manifest = await read(result.provider_output_manifest), report = await read(result.runner_report);
    const policy = { ...validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true }), status: "passed", findings: [] };
    const planPolicy = validatePilotNarrationPlanPolicy(plan, policy, { sourceBytes, identityFileSha256: identityHash, textIr: ir, spokenTextAudit: audit });
    passed(planPolicy, "Full source/request plan invalid");
    const ids = plan.pilot_opening_unit_ids;
    need(same(result.unit_ids, ids) && ids.length === 2, "Opening selection drifted.");
    const units = plan.units.slice(0, ids.length);
    const args = { plan, units, policy, planPolicy, batchPlan: plan.pilot_phase_batch_plans.opening,
      preSynthesisGate: gate, preSynthesisGatePath: result.pre_synthesis_gate.path, preSynthesisGateFileSha256: result.pre_synthesis_gate.sha256,
      planPath: result.generation_plan.path, planFileSha256: result.generation_plan.sha256,
      identityPath, identityFileSha256: identityHash, scriptPath: identity.source_script.path, scriptSha256: result.source_script_sha256,
      acceptedUnitIds: [], execution: { report, results: report.results, reportPath: result.runner_report.path,
        reportSha256: result.runner_report.sha256, cohortEventsPath: result.cohort_events.path, cohortEventsSha256: result.cohort_events.sha256 } };
    passed(await validatePilotOpeningExecutionResults(args), "Actual opening execution invalid");
    passed(validateNarrationProviderOutputManifest(manifest, units, {
      generationPlanSha256: plan.plan_sha256, generationPlanFileSha256: result.generation_plan.sha256,
      qualityContractSha256: policy.narration_quality_contract.contract_sha256, provider: policy.primary.provider,
      voiceId: policy.primary.voice_id, voiceSha256: policy.primary.voice_sha256,
    }), "Opening manifest invalid");
    const refs = result.finalization_artifacts;
    const namespace = path.join(episodeDir, "pilot_narration_work", "opening_finalization");
    const realNamespace = await fs.realpath(namespace);
    for (const name of ["audio", "tts_report", "stitch_report", "full_stream_qa", "voice_continuity", "unit_delivery_qa", "unit_qa", "subjective_manifest", "timing_candidate"]) {
      const file = refs?.[name]?.path;
      need(typeof file === "string" && path.resolve(file) === file && file.startsWith(`${namespace}${path.sep}`)
        && (await fs.realpath(file)).startsWith(`${realNamespace}${path.sep}`), `Missing phase-isolated ${name}.`);
      await read(refs[name], name !== "audio");
    }
    const tts = await read(refs.tts_report), stitch = await read(refs.stitch_report), delivery = await read(refs.full_stream_qa);
    const continuity = await read(refs.voice_continuity), subjective = await read(refs.subjective_manifest), timing = await read(refs.timing_candidate);
    const unitDelivery = await read(refs.unit_delivery_qa), unitQa = await read(refs.unit_qa);
    const audioHash = refs.audio.sha256;
    const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type,sample_rate,channels:format=duration", "-of", "json", refs.audio.path], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const probe = JSON.parse(stdout), duration = Number(probe.format?.duration), audio = probe.streams?.[0];
    need(probe.streams?.length === 1 && audio.codec_type === "audio" && audio.codec_name === "pcm_s16le"
      && Number(audio.sample_rate) === 24000 && audio.channels === 1 && duration >= 14.85 && duration <= 20.15, "Opening must be an uncut 15–20-second canonical mono WAV.");
    for (const row of [tts, stitch, delivery]) {
      need(["passed", "passed_with_warnings"].includes(row.status) && row.source_script_hash === result.source_script_sha256
        && row.narration_generation_plan_file_sha256 === result.generation_plan.sha256, "Opening technical report/source binding invalid.");
      const scope = row.finalization_scope;
      need(scope?.phase === "opening" && scope.complete_episode === false && scope.production_eligible === false
        && same(scope.unit_ids, ids) && scope.run_identity_sha256 === identityHash
        && scope.generation_plan_file_sha256 === result.generation_plan.sha256
        && scope.provider_manifest_file_sha256 === result.provider_output_manifest.sha256
        && scope.pre_synthesis_gate_file_sha256 === result.pre_synthesis_gate.sha256, "Report lost its exact opening scope.");
    }
    need(tts.schema === "goldflow_provider_neutral_narration_tts_report_v2" && tts.primary_provider === policy.primary.provider
      && tts.primary_model_id === policy.primary.model_id && tts.primary_model_revision === policy.primary.model_revision
      && tts.voice_id === policy.primary.voice_id && tts.voice_sha256 === policy.primary.voice_sha256
      && tts.post_tempo_normalized === false && !tts.operator_narration_qa_waiver && !tts.fallback_unit_ids?.length
      && tts.provider_output_manifest_sha256 === result.provider_output_manifest.sha256
      && tts.voice_continuity_report_sha256 === refs.voice_continuity.sha256, "Opening TTS identity/QA contract invalid.");
    need(same(tts.results?.map((row) => row.unit_id), ids) && tts.results.every((row, i) => row.audio_sha256 === report.results[i].output_sha256
      && row.spoken_text_sha256 === units[i].spoken_text_sha256 && row.synthesis_identity_sha256 === report.results[i].synthesis_identity_sha256
      && row.token_limit_reached === false), "Finalized opening changed original unit audio or execution identity.");
    need(stitch.schema === "goldflow_provider_neutral_narration_stitch_v2" && stitch.final_wav_sha256 === audioHash
      && stitch.output_sha256 === audioHash && Math.abs(stitch.final_duration_sec - duration) <= 0.02
      && stitch.sample_accounting?.exact_sample_accounting === true
      && Number.isInteger(stitch.sample_accounting.actual_sample_count) && stitch.sample_accounting.actual_sample_count > 0
      && stitch.sample_accounting.expected_sample_count === stitch.sample_accounting.actual_sample_count
      && stitch.mastering?.status === "passed" && stitch.mastering.policy?.tempo_processing === false
      && stitch.mastering.policy.target_lufs === -16 && stitch.mastering.policy.true_peak_dbtp_max === -1.5
      && stitch.mastering.output_sha256 === audioHash && !stitch.subjective_review_waiver, "Opening stitch/mastering contract invalid.");
    need(delivery.schema === "goldflow_narration_full_stream_qa_v2" && delivery.audio_sha256 === audioHash
      && accepted(delivery) && accepted(delivery.decision) && accepted(delivery.order_qa) && accepted(delivery.join_qa)
      && delivery.intended_text_sha256 === hash(units.map((unit) => unit.spoken_text).join(" "))
      && !delivery.operator_narration_qa_waiver, "Opening stream delivery blocked.");
    need(continuity.schema === "goldflow_narration_voice_continuity_qa_v2" && ["passed", "passed_with_warnings"].includes(continuity.status)
      && continuity.voice_id === policy.primary.voice_id && continuity.voice_sha256 === policy.primary.voice_sha256
      && !continuity.blockers?.length && continuity.candidate_count === ids.length
      && same(continuity.units?.map((row) => row.unit_id), ids)
      && continuity.units.every((row, index) => row.status === "passed" && row.audio_sha256 === report.results[index].output_sha256), "Opening voice continuity blocked.");
    for (const row of [unitDelivery, unitQa]) {
      need(["passed", "passed_with_warnings"].includes(row.status) && row.source_script_hash === result.source_script_sha256
        && row.narration_generation_plan_file_sha256 === result.generation_plan.sha256
        && !row.operator_narration_qa_waiver && !row.manual_review_evidence_path && !row.waived_blockers?.length,
      "Opening unit QA source/plan or no-waiver binding invalid.");
    }
    need(unitDelivery.schema === "goldflow_narration_unit_delivery_qa_v2" && unitDelivery.unit_count === ids.length
      && unitDelivery.blocked_unit_count === 0 && accepted(unitDelivery)
      && unitDelivery.voice_continuity_report_sha256 === refs.voice_continuity.sha256
      && same(unitDelivery.units?.map((row) => row.unit_id), ids)
      && unitDelivery.units.every((row, index) => row.audio_sha256 === report.results[index].output_sha256
        && row.intended_text === units[index].spoken_text && row.intended_text_sha256 === units[index].spoken_text_sha256
        && accepted(row.decision)), "Opening unit delivery blocked.");
    need(unitQa.schema === "goldflow_narration_tts_unit_qa_v2" && unitQa.expected_unit_count === ids.length
      && unitQa.selected_unit_count === ids.length && unitQa.selected_blocker_count === 0 && unitQa.selected_blockers?.length === 0
      && same(unitQa.selected_units?.map((row) => row.unit_id), ids)
      && unitQa.selected_units.every((row, index) => row.audio_sha256 === report.results[index].output_sha256
        && row.spoken_text === units[index].spoken_text && row.spoken_text_sha256 === units[index].spoken_text_sha256
        && row.synthesis_identity_sha256 === report.results[index].synthesis_identity_sha256
        && ["passed", "passed_with_warnings"].includes(row.qa_status) && accepted(row.qa?.delivery)), "Opening selected unit QA invalid.");
    passed(validateNarrationSubjectiveReviewManifest(subjective), "Opening listening manifest invalid");
    need(subjective.status === "review_required" && subjective.audio_path === refs.audio.path && subjective.audio_sha256 === audioHash
      && subjective.total_sample_count === stitch.sample_accounting.actual_sample_count
      && Math.abs(subjective.duration_sec - duration) <= 0.02
      && subjective.samples.every((row) => row.unit_ids.every((id) => ids.includes(id)))
      && subjective.narration_generation_plan_file_sha256 === result.generation_plan.sha256
      && subjective.samples.some((row) => row.coverage_class === "complete_opening" && row.start_sample === 0
        && row.end_sample_exclusive === subjective.total_sample_count), "Listening review must cover the entire exact opening.");
    passed(validateLocalWhisperTimingCandidate(timing, { contract: localWhisperContractForIdentity(identity), sourceScriptSha256: result.source_script_sha256,
      narrationAudioSha256: audioHash, narrationReportSha256: refs.stitch_report.sha256, runIdentitySha256: identityHash,
      narrationQualityContractSha256: policy.narration_quality_contract.contract_sha256 }), "Opening Whisper candidate invalid");
    need(timing.narration_audio_path === refs.audio.path && timing.narration_report_path === refs.stitch_report.path
      && timing.source_script_path === identity.source_script.path && timing.run_identity_path === identityPath
      && Math.abs(timing.audio_duration_sec - duration) <= 0.02
      && timing.recognized_text === delivery.primary_recognized_text
      && same(timing.words, delivery.primary_recognized_words), "Whisper observation diverges from canonical stream QA.");
    return { status: "passed", findings, duration_sec: duration, audio_path: refs.audio.path, audio_sha256: audioHash,
      unit_ids: ids, subjective_review_status: "pending", official_full_narration_timing: false };
  } catch (error) { findings.push({ code: error.message }); }
  return { status: "blocked", findings, subjective_review_status: "pending" };
}
