import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { binding, readBound, writeNew, inspectOpeningRuntime } from "./avatar-pilot-opening-producer.mjs";
import { narrationTtsPolicyForIdentity, validateNarrationTtsPolicy } from "./narration-tts-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const json = async (ref) => JSON.parse((await readBound(ref)).toString("utf8"));

/** No synthesis dependency exists in this continuation. Every prior take,
 * producer receipt and QA report remains immutable in its original namespace. */
export function createPilotNarrationReviewProducer({
  getStatus = async (ep) => (await import("./avatar-pilot-workflow.mjs")).pilotStatus(ep),
  inspectRuntime = inspectOpeningRuntime,
  finalize = async (...args) => (await import("../narration-provider-output-finalize.mjs")).finalizeNarrationProviderOutput(...args),
} = {}) {
  return async function reviewNarration({ episodeDir, reviewer, note, attestation }) {
    episodeDir = path.resolve(episodeDir);
    const current = await getStatus(episodeDir);
    need(current.current_stage === "pilot_narration" && current.allowed_command_stages.includes("pilot_narration")
      && current.next_command_shape.includes("pilot review-narration "), "Only the current exact delivery-review continuation is allowed.");
    const identity = current.identity;
    const { validatePilotNarrationPendingReviewResult } = await import("./avatar-pilot-narration-validation.mjs");
    const review = await import("./avatar-pilot-narration-review.mjs");
    need(attestation === review.PILOT_RAW_NARRATION_REVIEW_ATTESTATION && reviewer?.trim() && note?.trim(), "Complete raw-narration listening approval required.");
    const workRoot = path.join(episodeDir, "pilot_narration_work");
    const priorResultRef = await binding(path.join(workRoot, "narration_producer_result.json"));
    const priorResult = await json(priorResultRef);
    const validation = await validatePilotNarrationPendingReviewResult(priorResult, { episodeDir, identity });
    need(validation.status === "pending_delivery_review", `Pending raw narration invalid: ${JSON.stringify(validation.findings)}`);
    const checkpointRef = await binding(priorResult.finalized.checkpoint_path);
    const packetRef = await binding(priorResult.finalized.listen_review_packet_path);
    const rawAudioRef = priorResult.finalization_artifacts.audio;
    const inputs = { priorResultRef, priorResult, packetRef, packet: await json(packetRef),
      checkpointRef, checkpoint: await json(checkpointRef), rawAudioRef,
      reviewer: reviewer.trim(), note: note.trim(), attestation };
    const built = await review.buildPilotRawNarrationReview(inputs);
    const policy = validateNarrationTtsPolicy(narrationTtsPolicyForIdentity(identity), { production: true });
    const runtime = await inspectRuntime({ runnerPath: path.join(ROOT, "scripts/tts-local-production-runner.py"),
      policy, bank: identity.narration_delivery_reference_bank });
    // Recheck actual source evidence after runtime inspection and before writes.
    await readBound(priorResultRef); await readBound(checkpointRef); await readBound(packetRef); await readBound(rawAudioRef);
    const reviewRoot = path.join(workRoot, "narration_review");
    await fs.mkdir(reviewRoot);
    const reviewReceipt = await writeNew(path.join(reviewRoot, "raw_listening_approval.json"), built.reviewReceipt);
    const listenDecision = await writeNew(path.join(reviewRoot, "exact_listen_decision.json"), built.listenDecision);
    const reviewContinuation = { priorResult: priorResultRef, reviewReceipt, listenDecision, checkpoint: checkpointRef, rawAudio: rawAudioRef };
    await review.validatePilotNarrationReviewAuthorization({ reviewContinuation, episodeDir, identity });
    const outputNamespace = path.join(workRoot, "full_finalization_reviewed");
    const finalized = await finalize(["--episode-dir", episodeDir, "--script", identity.source_script.path,
      "--plan", priorResult.generation_plan.path, "--manifest", priorResult.provider_output_manifest.path], {
      phaseContext: { ...priorResult.finalized.phase_context, outputNamespace, reviewContinuation },
    });
    const refs = {};
    for (const [name, file] of Object.entries({ audio: finalized.final_wav, tts_report: finalized.tts_report_path,
      stitch_report: finalized.stitch_report_path, full_stream_qa: finalized.full_stream_qa_path,
      voice_continuity: finalized.voice_continuity_qa_path, unit_delivery_qa: finalized.unit_delivery_qa_path,
      unit_qa: finalized.unit_qa_path, subjective_manifest: finalized.subjective_review_manifest_path,
      timing_candidate: finalized.timing_candidate_path })) {
      if (file == null) continue;
      need(path.resolve(file) === file && file.startsWith(`${outputNamespace}${path.sep}`), "Reviewed finalizer output escaped its fresh namespace.");
      refs[name] = await binding(file);
    }
    const result = { ...priorResult, finalization_artifacts: refs, finalized,
      review_continuation: reviewContinuation, runtime_provenance: runtime.provenance,
      status: "reviewed_delivery_master_pending_canonical_listening", subjective_approval: null,
      creative_submissions: 0, synthesis_invoked: false };
    await review.validatePilotNarrationReviewAuthorization({ reviewContinuation, episodeDir, identity });
    await writeNew(path.join(workRoot, "narration_reviewed_result.json"), result);
    return result;
  };
}
export const reviewPilotNarration = createPilotNarrationReviewProducer();
