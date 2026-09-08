import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentProfileDefinition } from "./content-profiles.mjs";
import { mediaWorkflowForPreflight, resolveMediaWorkflow } from "./media-workflows.mjs";
import { AVATAR_PILOT_STAGES, pilotCommandShape } from "./avatar-pilot-stage-registry.mjs";
import { QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK as JOEL } from "./narration-tts-policy.mjs";
import { DEFAULT_NARRATION_DELIVERY_BANK_PATH } from "./narration-delivery-reference-bank.mjs";
import { buildPilotNarrationIdentityFields, validatePilotNarrationIdentity } from "./avatar-pilot-narration-contract.mjs";
import { validatePilotScript, validatePilotAssetPlan, validatePilotMedia, validatePilotNarrationBundle, pilotArtifactContainsPrivateData, PILOT_NARRATION_IMPORT_ADAPTER_STATUS } from "./avatar-pilot-artifacts.mjs";
import { buildNarrationSubjectiveReviewDecision, validateNarrationSubjectiveReviewManifest,
  validateNarrationSubjectiveReviewDecision, NARRATION_SUBJECTIVE_REVIEW_ATTESTATION } from "./narration-subjective-review.mjs";
import { PILOT_NARRATION_ACCEPTANCE_SCHEMA, PILOT_NARRATION_LISTEN_ATTESTATION,
  buildPilotNarrationTiming, validatePilotNarrationAcceptance } from "./avatar-pilot-narration-acceptance.mjs";
import { pilotAssetPlanRevisionPaths, preparePilotAssetPlanRevision,
  resolvePilotAssetPlanStage } from "./avatar-pilot-asset-plan-revision.mjs";
import { pilotHostDesignRevisionPaths, preparePilotHostDesignRevision,
  resolvePilotHostDesignRevision } from "./avatar-pilot-host-design-revision.mjs";
import { preparePilotHostIdentityApproval,
  resolvePilotHostIdentityApproval } from "./avatar-pilot-host-identity-approval.mjs";
import { pilotConceptFallbackPaths, preparePilotConceptFallback,
  resolvePilotConceptFallback } from "./avatar-pilot-concept-fallback.mjs";

// This capability is separate from the still-unproven generic/full import route.
// Release only after the opening producer, finalizer and workflow fixtures pass.
export const PILOT_OPENING_SYNTHESIS_ADAPTER_STATUS = "proven";
export const PILOT_REMAINING_SYNTHESIS_ADAPTER_STATUS = "proven";
const OPENING_SCHEMA = "goldflow_avatar_pilot_opening_producer_result_v1";
const NARRATION_SCHEMA = "goldflow_avatar_pilot_narration_producer_result_v1";
const RAW_REVIEW_ATTESTATION = "entire_raw_proof_narration_listened_end_to_end";
const OPENING_ATTESTATION = "complete_opening_listened_end_to_end";
const FULL_ADAPTER = Object.freeze({
  status: PILOT_REMAINING_SYNTHESIS_ADAPTER_STATUS,
  async produce(options) { return (await import("./avatar-pilot-narration-producer.mjs")).producePilotNarration(options); },
  async validate(payload, options) { return (await import("./avatar-pilot-narration-validation.mjs")).validatePilotNarrationResult(payload, options); },
  async validatePending(payload, options) { return (await import("./avatar-pilot-narration-validation.mjs")).validatePilotNarrationPendingReviewResult(payload, options); },
  async review(options) { return (await import("./avatar-pilot-narration-review-producer.mjs")).reviewPilotNarration(options); },
  validateAcceptance: validatePilotNarrationAcceptance,
});
const OPENING_ADAPTER = Object.freeze({
  status: PILOT_OPENING_SYNTHESIS_ADAPTER_STATUS,
  full: FULL_ADAPTER,
  async produce(options) {
    const { producePilotOpeningSample } = await import("./avatar-pilot-opening-producer.mjs");
    return producePilotOpeningSample(options);
  },
  async validate(payload, options) {
    const { validatePilotOpeningSampleResult } = await import("./avatar-pilot-opening-validation.mjs");
    return validatePilotOpeningSampleResult(payload, options);
  },
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const need = (condition, message) => { if (!condition) throw new Error(message); };
const hasText = (value) => typeof value === "string" && value.trim().length > 0;
const HASH = /^[a-f0-9]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;

async function bytesAt(file) {
  need(!/^[a-z][a-z0-9+.-]*:/i.test(file), "Pilot inputs must be local files, never media URLs.");
  const stat = await fs.stat(file);
  need(stat.isFile(), "Pilot input must be a regular file.");
  return fs.readFile(file);
}
async function jsonAt(file) {
  const bytes = await bytesAt(file);
  need(bytes.length <= 32 * 1024 * 1024, "Pilot JSON exceeds the bounded input limit.");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Pilot JSON is malformed; inspect the local input privately."); }
  need(value && typeof value === "object" && !Array.isArray(value), "Pilot JSON must be an object.");
  need(!pilotArtifactContainsPrivateData(value), "Pilot artifact contains private credentials or signed URLs; import refused.");
  return value;
}
async function binding(file) { return { path: path.resolve(file), sha256: hash(await bytesAt(file)) }; }
async function checkBinding(ref, base) {
  need(hasText(ref?.path) && HASH.test(ref?.sha256 ?? ""), "Invalid pilot file binding.");
  const resolved = path.resolve(base, ref.path);
  need(hash(await bytesAt(resolved)) === ref.sha256, "Pilot input hash changed; inspect the exact affected artifact before recovery.");
  return resolved;
}
function accepted(result) {
  need(["passed", "approved"].includes(result?.status), `Pilot validation blocked: ${(result?.findings ?? []).map((row) => typeof row === "string" ? row : row.code ?? "invalid_artifact").join(", ")}`);
}
function declaredContractMatches(declared, expected, prefix = "narration") {
  for (const [key, value] of Object.entries(expected)) {
    if (!Object.hasOwn(declared, key)) continue;
    const actual = declared[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      need(actual && typeof actual === "object" && !Array.isArray(actual), `Conflicting declared ${prefix}.${key}.`);
      declaredContractMatches(actual, value, `${prefix}.${key}`);
    } else need(JSON.stringify(actual) === JSON.stringify(value), `Conflicting declared ${prefix}.${key}.`);
  }
}
function withNarrationIdentityFields(config, fields) {
  declaredContractMatches(config, fields);
  return {
    ...config, ...fields,
    provider_locks: { ...config.provider_locks, ...fields.provider_locks },
    production_profile_config: { ...config.production_profile_config, ...fields.production_profile_config,
      audio: { ...config.production_profile_config?.audio, ...fields.production_profile_config.audio } },
    production_gates: { ...config.production_gates, ...fields.production_gates },
    model_versions: { ...config.model_versions, ...fields.model_versions },
  };
}
async function validateLockedNarrationIdentity(identity, episodeDir) {
  // Old pilot identities retain their original config and remain synthesis-blocked.
  // Presence of canonical fields requires the full marker and exact bank binding.
  const canonicalFields = [
    "pilot_narration_contract", "voice_provider_options", "tts_provider",
    "tts_fallback_provider", "narrator_voice_id", "tts_voice_id", "tts_native_speed",
    "narration_quality_contract", "narration_delivery_reference_bank",
  ];
  const sharedLeaves = [
    [identity.provider_locks, "local_whisper_timing"],
    [identity.production_profile_config?.audio, "local_whisper_timing"],
    [identity.production_gates, "local_whisper_contract_required"],
    [identity.model_versions, "tts_model"],
    [identity.model_versions, "tts_model_revision"],
    [identity.model_versions, "local_whisper_model"],
  ];
  if (!canonicalFields.some((key) => Object.hasOwn(identity, key))
    && !sharedLeaves.some(([parent, key]) => parent != null && Object.hasOwn(parent, key))) return;
  const bank = identity.narration_delivery_reference_bank;
  const bankPath = await checkBinding(bank, episodeDir);
  accepted(validatePilotNarrationIdentity(identity, { deliveryBank: { path: bankPath, bytes: await bytesAt(bankPath) } }));
}
function identityCheck(identity) {
  need(resolveMediaWorkflow(identity).id === "avatar_footage_pilot_v1", "This command requires the dedicated avatar pilot workflow.");
  need(identity.schema === "goldflow_avatar_pilot_identity_v1" && identity.run_intent === "proof" && identity.production_eligible === false && identity.publish_allowed === false, "Pilot identity must be private proof-only, never production or publishing.");
  need(identity.proof_scope?.start_sec === 0 && identity.proof_scope?.end_sec === 90 && identity.proof_scope?.duration_frames === 2700 && identity.proof_scope?.fps === 30 && identity.proof_scope?.width === 1920 && identity.proof_scope?.height === 1080, "Pilot scope is exactly 90 seconds, 2700 frames, 1920x1080 at 30 fps.");
  for (const key of ["channel", "series_slug", "week", "episode"]) need(SLUG.test(identity[key] ?? ""), `Invalid pilot identity ${key}.`);
  need(/^ep_\d+$/.test(identity.episode) && hasText(identity.title), "Pilot needs an exact episode ID and title.");
  need(identity.content_profile === "mcu_what_if_pilot_v1" && identity.content_profile_config?.id === identity.content_profile, "Pilot editorial profile is locked.");
  need(identity.audio_target === "commentary_with_optional_source_audio", "Pilot audio target is commentary with explicitly planned source audio.");
  const providers = identity.pilot_providers;
  need(Array.isArray(providers?.stills) && providers.stills.length > 0 && providers.stills.length <= 2 && new Set(providers.stills.map((row) => row.provider)).size === providers.stills.length, "Pilot requires explicit still-provider locks.");
  for (const row of providers.stills) need(["google_gemini_imagen", "google_flow"].includes(row.provider) && hasText(row.model), "This proof uses Google Gemini/Flow for every generated still; other providers are not authorized.");
  need(providers.video?.provider === "google_flow" && typeof providers.video.enabled === "boolean" && hasText(providers.video.model), "Optional video requires an explicit Flow model and enabled flag.");
  need(providers.narration?.provider === "qwen_local" && providers.narration.voice_id === "joel_owned_narrator_clone" && hasText(providers.narration.model) && hasText(providers.narration.model_revision), "Pilot requires the locked owned Joel Qwen clone.");
  for (const key of ["voice_sha256", "reference_audio_sha256", "reference_text_sha256"]) need(HASH.test(providers.narration[key] ?? ""), `Narration lock missing ${key}.`);
  for (const [key, value] of Object.entries({ model: JOEL.model_id, model_revision: JOEL.model_revision, voice_id: JOEL.voice_id, voice_sha256: JOEL.voice_sha256, reference_audio_sha256: JOEL.reference_audio_sha256, reference_text_sha256: JOEL.reference_text_sha256 })) need(providers.narration[key] === value, `Pilot owned Joel lock mismatch: ${key}.`);
  need(identity.source_script && HASH.test(identity.source_script.sha256 ?? ""), "Pilot source script must be identity-bound before ingest.");
  need(hasText(identity.git?.commit) && hasText(identity.git?.branch) && HASH.test(identity.git?.dirty_diff_sha256 ?? ""), "Pilot code provenance is missing.");
  return identity;
}
async function stageOutputPath(episodeDir, stage) {
  if (["pilot_asset_plan", "pilot_asset_plan_approval"].includes(stage.id)) {
    const fallback = await resolvePilotConceptFallback({ episodeDir });
    if (fallback) return stage.id === "pilot_asset_plan" ? fallback.plan.path : fallback.approval.path;
    const host = await resolvePilotHostDesignRevision({ episodeDir });
    if (host) return stage.id === "pilot_asset_plan" ? host.plan.path : host.approval.path;
    if (stage.id === "pilot_asset_plan") return (await resolvePilotAssetPlanStage({ episodeDir })).path;
  }
  return path.join(episodeDir, stage.output);
}
async function rowAt(episodeDir, stage) {
  if (["pilot_asset_plan", "pilot_asset_plan_approval"].includes(stage.id)) {
    const fallback = await resolvePilotConceptFallback({ episodeDir });
    if (fallback) return stage.id === "pilot_asset_plan" ? fallback.plan.row : fallback.approval.row;
    const host = await resolvePilotHostDesignRevision({ episodeDir });
    if (host) return stage.id === "pilot_asset_plan" ? host.plan.row : host.approval.row;
    if (stage.id === "pilot_asset_plan") return (await resolvePilotAssetPlanStage({ episodeDir })).row;
  }
  return jsonAt(path.join(episodeDir, stage.output));
}
async function sourceText(episodeDir) { return (await rowAt(episodeDir, AVATAR_PILOT_STAGES[1])).payload.text; }
async function narrationPayload(episodeDir) { return (await rowAt(episodeDir, AVATAR_PILOT_STAGES[6])).payload; }

async function openingReviewInputs(episodeDir) {
  const sample = (await rowAt(episodeDir, AVATAR_PILOT_STAGES[4])).payload;
  need(sample.schema === OPENING_SCHEMA, "Canonical opening review requires a produced sample.");
  const manifestRef = sample.finalization_artifacts?.subjective_manifest;
  const manifest = await jsonAt(await checkBinding(manifestRef, episodeDir));
  const audioRef = sample.finalization_artifacts?.audio;
  await checkBinding(audioRef, episodeDir);
  accepted(validateNarrationSubjectiveReviewManifest(manifest));
  need(path.resolve(manifest.audio_path) === audioRef.path && manifest.audio_sha256 === audioRef.sha256
    && manifest.narration_generation_plan_file_sha256 === sample.generation_plan.sha256,
  "Opening listening manifest is not bound to the exact sample audio and plan.");
  need(manifest.samples.some((row) => row.coverage_class === "complete_opening"
    && row.start_sample === 0 && row.end_sample_exclusive === manifest.total_sample_count),
  "Opening listening must cover the complete sample.");
  need(manifest.samples.every((row) => row.start_sample >= 0 && row.end_sample_exclusive <= manifest.total_sample_count
    && row.unit_ids.every((id) => sample.unit_ids.includes(id))),
  "Opening attestation cannot cover a sample outside the exact opening.");
  return { sample, manifest, manifestRef, audioRef };
}
async function validatePayload(stage, payload, episodeDir, identity, openingAdapter) {
  need(!pilotArtifactContainsPrivateData(payload), "Private data cannot enter a pilot receipt.");
  if (stage.action === "ingest") {
    need(hasText(payload.text) && hash(payload.text) === identity.source_script.sha256 && payload.source_script_sha256 === hash(payload.text), "Script must exactly match the preflight source hash.");
    need(payload.text.trim().split(/\s+/u).length >= 80 && payload.text.trim().split(/\s+/u).length <= 300, "Pilot script must fit its bounded commentary scope (80–300 words). Timing is confirmed from audio, not word count.");
    return;
  }
  if (stage.action === "approve-evidence") {
    accepted(validatePilotScript(await sourceText(episodeDir), payload.evidence));
    need(payload.evidence.review.reviewer === payload.review.reviewer, "Evidence and gate reviewer must match.");
  }
  if (["import-voice-sample", "import-narration"].includes(stage.action)) {
    const phase = stage.action === "import-voice-sample" ? "sample" : "full";
    if (phase === "sample" && payload.schema === OPENING_SCHEMA) {
      need(openingAdapter.status === "proven" && identity.pilot_narration_contract,
        "Opening synthesis requires its proven scoped adapter and canonical identity.");
      accepted(await openingAdapter.validate(payload, { episodeDir, identity }));
    } else if (phase === "full" && payload.schema === PILOT_NARRATION_ACCEPTANCE_SCHEMA) {
      need(openingAdapter.full?.status === "proven" && identity.pilot_narration_contract, "Full proof narration adapter is unavailable.");
      accepted(await openingAdapter.full.validateAcceptance(payload, { episodeDir, identity }));
    } else accepted(await validatePilotNarrationBundle(payload, { episodeDir, identity, phase, sourceScriptSha256: identity.source_script.sha256 }));
    if (phase === "full" && payload.schema !== PILOT_NARRATION_ACCEPTANCE_SCHEMA) {
      const prior = await rowAt(episodeDir, AVATAR_PILOT_STAGES[4]);
      const priorInput = prior.inputs.find((ref) => ref.role === "import");
      need(payload.opening_bundle?.sha256 === priorInput?.sha256, "Full narration must preserve this pilot's approved opening bundle.");
    }
  }
  if (stage.action === "plan-assets") {
    need(payload.source_script_sha256 === identity.source_script.sha256, "Asset plan script hash is stale.");
    accepted(validatePilotAssetPlan(payload, identity));
  }
  if (stage.action === "import-media") {
    const plan = (await rowAt(episodeDir, AVATAR_PILOT_STAGES[7])).payload;
    accepted(await validatePilotMedia(payload, { episodeDir, identity, assetPlan: plan }));
    const narration = await narrationPayload(episodeDir);
    const mediaVoice = payload.assets.find((asset) => asset.kind === "narration");
    need(mediaVoice?.sha256 === narration.audio.sha256, "Media must use this pilot's approved full narration.");
  }
  if (stage.action === "timeline") {
    const { validatePilotTimeline } = await import("./avatar-pilot-render.mjs");
    const assets = await rendererAssets(episodeDir);
    const findings = validatePilotTimeline(payload, { assets });
    if (Array.isArray(findings)) need(findings.length === 0, "Typed pilot timeline failed validation.");
    for (const shot of payload.shots) {
      if (shot.layers.some((layer) => ["concept_still", "editorial_composite", "concept_video"].includes(assets[layer.asset_id]?.kind))) need(shot.truth_mode === "hypothesis" && hasText(shot.truth_label), "Every invented scenario must carry a visible what-if label, not masquerade as film evidence.");
    }
    // Canonical narration must play completely, in order, without omitted or duplicated audio.
    const narration = await narrationPayload(episodeDir);
    const placements = [...payload.narration].sort((a, b) => a.start_frame - b.start_frame);
    let consumedFrames = 0;
    for (const placement of placements) {
      need(assets[placement.asset_id]?.sha256 === narration.audio.sha256 && Math.abs(placement.source_in_sec * 30 - consumedFrames) < 1, "Narration placement must preserve complete source order without repeats or missing words.");
      consumedFrames += placement.duration_frames;
    }
    const media = (await rowAt(episodeDir, AVATAR_PILOT_STAGES[9])).payload;
    const voice = media.assets.find((asset) => asset.kind === "narration");
    need(Number.isFinite(voice.duration_sec) && consumedFrames === Math.ceil(voice.duration_sec * 30), "Timeline must account for the complete accepted narration duration, rounded up to its final frame without dropping speech.");
    // Captions are optional separate overlays. If selected, they must cover the
    // approved narration completely and use its bound Whisper timing.
    const normalizeWords = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.join(" ").replaceAll("’", "'") ?? "";
    if (payload.captions.length > 0) {
      need(normalizeWords(payload.captions.map((caption) => caption.text).join(" ")) === normalizeWords(await sourceText(episodeDir)), "Selected pilot captions must reproduce the complete approved narration text in order.");
      const timing = await jsonAt(await checkBinding(narration.whisper_timing, episodeDir));
      const words = timing.words;
      let nextWord = 0;
      const outputTime = (time, atEnd = false) => {
        const placement = placements.find((row) => time >= row.source_in_sec - 0.001 && (atEnd ? time <= row.source_in_sec + row.duration_frames / 30 + 0.001 : time < row.source_in_sec + row.duration_frames / 30));
        need(placement, "Caption word has no narration placement.");
        return placement.start_frame / 30 + time - placement.source_in_sec;
      };
      for (const caption of payload.captions) {
        need(caption.word_start_index === nextWord && Number.isInteger(caption.word_end_index_exclusive) && caption.word_end_index_exclusive > nextWord && caption.word_end_index_exclusive <= words.length, "Captions require contiguous exact Whisper word-index coverage.");
        const first = words[nextWord], last = words[caption.word_end_index_exclusive - 1];
        need(Math.abs(caption.start_frame / 30 - outputTime(first.start)) <= 0.2 && Math.abs(caption.end_frame / 30 - outputTime(last.end, true)) <= 0.3, "Caption placement must match its bound Whisper words on the output clock.");
        nextWord = caption.word_end_index_exclusive;
      }
      need(nextWord === words.length, "Selected captions must account for every narration word.");
    }
  }
  if (stage.action === "render") {
    need(payload.duration_frames === 2700 && Math.abs(payload.duration_sec - 90) <= 1 / 30, "Pilot render must be exactly 90 seconds / 2700 frames.");
    await checkBinding({ path: payload.output_path, sha256: payload.sha256 }, episodeDir);
  }
  if (stage.approval === "operator") {
    need(payload.review?.approved === true && hasText(payload.review.reviewer) && hasText(payload.review.note), "Explicit reviewer and review note required.");
    if (stage.action === "approve-voice-sample") {
      need(payload.review.attestation === OPENING_ATTESTATION, "Opening approval requires listening to the entire bound sample.");
      const prior = (await rowAt(episodeDir, AVATAR_PILOT_STAGES[4])).payload;
      if (prior.schema === OPENING_SCHEMA) {
        const { manifest, manifestRef, audioRef } = await openingReviewInputs(episodeDir);
        const decision = await jsonAt(await checkBinding(payload.subjective_decision, episodeDir));
        accepted(validateNarrationSubjectiveReviewDecision(manifest, decision));
        need(decision.status === "approved" && decision.reviewer === payload.review.reviewer
          && decision.decisions.every((row) => row.decision === "accept" && row.note === payload.review.note),
        "Canonical subjective decision differs from the operator's exact opening approval.");
        const mapping = payload.listening_attestation_mapping;
        need(mapping?.schema === "goldflow_pilot_opening_listening_attestation_mapping_v1"
          && mapping.operator_attestation === OPENING_ATTESTATION
          && mapping.canonical_attestation === NARRATION_SUBJECTIVE_REVIEW_ATTESTATION
          && mapping.manifest_sha256 === manifestRef.sha256 && mapping.audio_sha256 === audioRef.sha256
          && mapping.all_samples_contained_in_opening === true
          && JSON.stringify(mapping.sample_ids) === JSON.stringify(manifest.samples.map((row) => row.sample_id)),
        "Opening listening attestation mapping is missing or stale.");
      }
    }
    if (stage.action === "final-qa") {
      need(payload.review.attestation === "entire_90_second_program_watched_and_listened", "Final QA requires end-to-end viewing and listening of the exact render.");
      const render = (await rowAt(episodeDir, AVATAR_PILOT_STAGES[12])).payload;
      const audio = render.audio_stats;
      need(audio?.render_sha256 === render.sha256 && HASH.test(audio?.report_sha256 ?? "") && Number.isFinite(audio.integrated_lufs) && audio.integrated_lufs >= -17 && audio.integrated_lufs <= -15 && Number.isFinite(audio.true_peak_dbfs) && audio.true_peak_dbfs <= -1.5, "Final mixed audio must have current measured -16 LUFS (+/-1) and <=-1.5 dBTP. Inspect an exact mix repair; do not regenerate narration.");
    }
  }
}
async function rendererAssets(episodeDir) {
  const manifest = (await rowAt(episodeDir, AVATAR_PILOT_STAGES[9])).payload;
  return Object.fromEntries(manifest.assets.map((row) => {
    const asset = { ...row, path: path.resolve(episodeDir, row.path) };
    if (asset.duration_sec === null) delete asset.duration_sec;
    return [row.id, asset];
  }));
}

async function pilotStatusWithAdapter(episodeDir, openingAdapter) {
  episodeDir = path.resolve(episodeDir);
  const identityPath = path.join(episodeDir, "run_identity.json");
  const identity = identityCheck(await jsonAt(identityPath));
  const identityHash = hash(await bytesAt(identityPath));
  const stages = [];
  for (const stage of AVATAR_PILOT_STAGES) {
    let state = "passed", reason = null, exists = false;
    let output = path.join(episodeDir, stage.output);
    try {
      output = await stageOutputPath(episodeDir, stage);
      exists = Boolean(await fs.stat(output).catch(() => null));
      if (!exists) { state = "missing"; }
      else if (stage.action === "preflight") await validateLockedNarrationIdentity(identity, episodeDir);
      else if (stage.action !== "preflight") {
        const row = await rowAt(episodeDir, stage);
        need(row.schema === "goldflow_avatar_pilot_stage_v1" && row.stage === stage.id && row.identity_sha256 === identityHash, "Stage identity binding is stale.");
        const dependency = AVATAR_PILOT_STAGES[AVATAR_PILOT_STAGES.indexOf(stage) - 1];
        const expected = await binding(await stageOutputPath(episodeDir, dependency));
        need(row.inputs.some((ref) => ref.role === "upstream" && ref.sha256 === expected.sha256 && path.resolve(episodeDir, ref.path) === expected.path), "Stage upstream binding missing or stale.");
        for (const ref of row.inputs) await checkBinding(ref, episodeDir);
        await validatePayload(stage, row.payload, episodeDir, identity, openingAdapter);
      }
    } catch (error) { state = "blocked"; reason = error.message; }
    if (stage.action !== "preflight" && stages.at(-1)?.state !== "passed" && state === "passed") { state = "blocked"; reason = "Upstream artifact is unresolved."; }
    const openingAvailable = openingAdapter.status === "proven" && Boolean(identity.pilot_narration_contract);
    let commandShape = pilotCommandShape(stage, episodeDir);
    if (stage.action === "import-voice-sample" && openingAvailable) {
      commandShape = `node bin/goldflow.mjs pilot create-voice-sample --episode-dir ${JSON.stringify(episodeDir)} --input <opening-editorial.json>`;
      if (!exists && await fs.lstat(path.join(episodeDir, "pilot_narration_work")).catch(() => null)) {
        state = "blocked";
        reason = "Opening work already exists without an accepted stage. Inspect its gate, execution and QA artifacts for manual triage; never synthesize the opening again.";
        commandShape = "Inspect pilot_narration_work and record exact opening blocker triage; automatic resynthesis is unavailable.";
      }
    } else if (stage.action === "import-narration" && openingAvailable && openingAdapter.full?.status === "proven") {
      commandShape = `node bin/goldflow.mjs pilot create-narration --episode-dir ${JSON.stringify(episodeDir)}`;
      if (!exists) {
        const resultPath = await currentNarrationResultPath(episodeDir);
        const hasResult = Boolean(await fs.stat(resultPath).catch(() => null));
        const hasAttempt = Boolean(await fs.lstat(path.join(episodeDir, "pilot_narration_work", "remaining")).catch(() => null));
        if (hasResult) {
          try {
            const candidate = await jsonAt(resultPath);
            need(resultPath === path.join(episodeDir, "pilot_narration_work", candidate.review_continuation ? "narration_reviewed_result.json" : "narration_producer_result.json"), "Narration candidate phase/path mismatch.");
            accepted(await openingAdapter.full.validate(candidate, { episodeDir, identity }));
            reason = "Full proof narration passed technical checks and is awaiting an actual complete listening review. Do not synthesize again.";
            commandShape = `node bin/goldflow.mjs pilot approve-narration --episode-dir ${JSON.stringify(episodeDir)} --accept true --reviewer <name> --note <review> --attestation ${PILOT_NARRATION_LISTEN_ATTESTATION}`;
          } catch (error) {
            const candidate = await jsonAt(resultPath).catch(() => null);
            const pending = openingAdapter.full.validatePending && candidate && !candidate.review_continuation
              && resultPath === path.join(episodeDir, "pilot_narration_work", "narration_producer_result.json")
              ? await openingAdapter.full.validatePending(candidate, { episodeDir, identity }) : null;
            if (pending?.status === "pending_delivery_review"
              && !await fs.lstat(path.join(episodeDir, "pilot_narration_work", "narration_review")).catch(() => null)) {
              state = "missing";
              reason = "The complete raw take requires exact delivery listening before no-synthesis mastering. All original audio and reports stay immutable.";
              commandShape = `node bin/goldflow.mjs pilot review-narration --episode-dir ${JSON.stringify(episodeDir)} --accept true --reviewer <name> --note <review> --attestation ${RAW_REVIEW_ATTESTATION}`;
            } else {
              state = "blocked"; reason = error.message;
              commandShape = "Inspect the retained full narration candidate and review-continuation evidence for exact blocker triage; resynthesis and automatic replay are unavailable.";
            }
          }
        } else if (hasAttempt) {
          state = "blocked"; reason = "Remaining narration work exists without a complete technical candidate. Preserve every first take and inspect the exact failure.";
          commandShape = "Inspect pilot_narration_work/remaining for exact blocker triage; never rerun the whole narration.";
        }
      }
    } else if (PILOT_NARRATION_IMPORT_ADAPTER_STATUS !== "proven" && ["import-voice-sample", "import-narration"].includes(stage.action)) {
      state = "blocked";
      reason = stage.action === "import-voice-sample"
        ? "Opening synthesis requires a proven scoped adapter and canonical pilot identity. Generic narration import remains blocked; no arbitrary WAV or stub QA imports."
        : "Full narration lineage import and remaining-unit synthesis are not yet proven. Opening approval does not authorize full narration import or resynthesis.";
      commandShape = "Implement and fixture-prove the required scoped narration adapter; do not import arbitrary speech.";
    }
    stages.push({ stage: stage.id, state, artifact: output, exists, approval_policy: stage.approval, reason, next_command_shape: commandShape });
  }
  const current = stages.find((row) => row.state !== "passed");
  const revisionAvailable = current?.stage === "pilot_asset_plan_approval" && current.state === "missing"
    && stages.slice(8).every((row) => !row.exists)
    && !(await Promise.all(["pilot_media_work", "pilot_render_work", "pilot_proof_90s.mp4"].map((name) => fs.lstat(path.join(episodeDir, name)).catch((error) => {
      if (error.code === "ENOENT") return null; throw error;
    })))).some(Boolean)
    && !await fs.lstat(pilotAssetPlanRevisionPaths(episodeDir).directory).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  return { schema: "goldflow_run_status_v2", episode_dir: episodeDir, media_workflow: identity.media_workflow, identity, production_eligible: false, publish_allowed: false, current_stage: current?.stage ?? "complete", next_command_shape: current?.next_command_shape ?? null, allowed_command_stages: current?.state === "missing" ? [current.stage] : [], stages,
    asset_plan_revision_command_shape: revisionAvailable ? `node bin/goldflow.mjs pilot revise-asset-plan --episode-dir ${JSON.stringify(episodeDir)} --input <revised-plan.json> --prior-stage-sha256 ${(await binding(path.join(episodeDir, "pilot_asset_plan.json"))).sha256} --affected-asset-ids <exact-comma-separated-IDs> --reviewer <name> --note <operator-revision-reason>` : null,
    capabilities: { narration: openingAdapter.status === "proven" && identity.pilot_narration_contract
      ? openingAdapter.full?.status === "proven" ? "scoped_opening_and_remaining_synthesis_with_separate_listening_gates" : "opening_only_scoped_synthesis_and_listening_full_narration_blocked"
      : "blocked_pending_proven_canonical_lineage_import_and_scoped_synthesis_adapter",
    opening_synthesis: openingAdapter.status, remaining_synthesis: openingAdapter.full?.status ?? "unproven", narration_import: PILOT_NARRATION_IMPORT_ADAPTER_STATUS,
    images_video: "reviewed_local_import_only_no_automatic_provider_dispatch", render: "local_typed_90_second_compositor" } };
}
export async function pilotStatus(episodeDir) { return pilotStatusWithAdapter(episodeDir, OPENING_ADAPTER); }
async function currentNarrationResultPath(episodeDir) {
  const reviewed = path.join(episodeDir, "pilot_narration_work", "narration_reviewed_result.json");
  return await fs.lstat(reviewed).catch(() => null) ? reviewed
    : path.join(episodeDir, "pilot_narration_work", "narration_producer_result.json");
}
export function formatPilotStatus(report) {
  return `# Private 90-second avatar pilot\n\nCurrent stage: ${report.current_stage}. Publishing disabled.\n\n| Stage | State | Approval | Artifact exists |\n| --- | --- | --- | --- |\n${report.stages.map((row) => `| ${row.stage} | ${row.state} | ${row.approval_policy} | ${row.exists ? "yes" : "no"} |`).join("\n")}\n\nNext: ${report.next_command_shape ?? "Proof complete; no publishing command."}\n${report.asset_plan_revision_command_shape ? `\nOptional pre-approval revision: ${report.asset_plan_revision_command_shape}\n` : ""}\n${report.stages.filter((row) => row.reason).map((row) => `${row.stage}: ${row.reason}`).join("\n")}\nOpening synthesis: ${report.capabilities.opening_synthesis}; remaining-only synthesis: ${report.capabilities.remaining_synthesis}; arbitrary narration import: ${report.capabilities.narration_import}. Accepted opening units remain immutable. Full narration requires separate listening approval. Gemini/Flow assets are reviewed local imports, not automatic dispatch.`;
}

async function exclusiveJson(file, value) { await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
async function openingAttemptAccounting(episodeDir, payload = null, phase = "opening") {
  const scope = { phase, target_duration_sec: phase === "opening" ? { min: 15, max: 20 } : { max: 90 },
    full_program_duration_sec: 90, unit_ids: payload?.unit_ids ?? [] };
  const gatePath = path.join(episodeDir, "pilot_narration_work", ...(phase === "remaining" ? ["remaining"] : []), "inputs", "pre_synthesis_authorized.json");
  if (!(await fs.lstat(gatePath).catch(() => null))) return { scope, creative_submissions: 0, synthesis_authorized: false };
  const gate = await jsonAt(gatePath).catch(() => null);
  if (gate?.synthesis_invoked !== true || gate?.model_load_performed !== true) return {
    scope, creative_submissions: null, synthesis_authorized: "unknown", submission_accounting: "Authorization receipt is unreadable or inconsistent; inspect retained evidence." };
  scope.unit_ids = gate.scope?.authorized_synthesis_unit_ids ?? scope.unit_ids;
  const accounting = { scope, creative_submissions: null, synthesis_authorized: true,
    authorized_unit_ids: gate.scope?.authorized_synthesis_unit_ids ?? [],
    submission_accounting: "Authorized execution may have started; inspect retained runner evidence before any recovery." };
  if (payload?.runner_report) {
    const runner = await jsonAt(await checkBinding(payload.runner_report, episodeDir));
    accounting.creative_submissions = (runner.results ?? []).filter((row) => row.status === "generated").length;
    accounting.model_call_count = (runner.cohort_executions ?? []).filter((row) => row.model_call_performed === true).length;
    accounting.submission_accounting = "Actual original runner results and cohort calls, retained by hash.";
    accounting.runner_report = payload.runner_report;
  }
  return accounting;
}
async function audit(episodeDir, event) {
  const id = `${Date.now()}-${randomUUID()}`;
  const directory = path.join(episodeDir, "reports", "stages");
  await fs.mkdir(directory, { recursive: true });
  const report = { schema: "goldflow_avatar_pilot_execution_v1", id, created_at: new Date().toISOString(), scope: { duration_sec: 90 }, production_eligible: false, creative_submissions: 0, provider_cost: 0, ...event };
  await exclusiveJson(path.join(directory, `${id}.json`), report);
  await fs.appendFile(path.join(episodeDir, "execution_events.jsonl"), `${JSON.stringify(report)}\n`, { mode: 0o600 });
  const events = (await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const manifest = {
    schema: "goldflow_avatar_pilot_production_manifest_v1", production_eligible: false, publish_allowed: false,
    episode_dir: episodeDir, event_count: events.length, current_batch_status: report.status,
    total_creative_submissions_by_controller: events.some((row) => row.creative_submissions == null)
      ? null : events.reduce((sum, row) => sum + row.creative_submissions, 0),
    creative_submission_accounting_incomplete: events.some((row) => row.creative_submissions == null),
    total_provider_cost_by_controller: events.reduce((sum, row) => sum + row.provider_cost, 0),
    imported_media_provider_cost: "Retained in original provider evidence when available; not incurred by this import controller.",
    accepted_stage_receipts: events.filter((row) => row.status === "passed").map((row) => ({ action: row.action, report_id: row.id, identity_sha256: row.identity_sha256, output: row.output ?? null })),
    complete_episode_status: "Use current run status validators; current-batch success is not proof completion.",
  };
  const temporary = path.join(episodeDir, `.pilot-manifest-${id}.json`);
  await exclusiveJson(temporary, manifest);
  await fs.rename(temporary, path.join(episodeDir, "production_manifest.json"));
  return binding(path.join(directory, `${id}.json`));
}
async function preflight(flags, episodeDir, repoRoot, openingAdapter) {
  need(hasText(flags.identity), "pilot preflight requires --identity <proof-config.json>.");
  need(!(await fs.stat(episodeDir).catch(() => null)), "Pilot preflight requires a new episode path; existing directories and identities are never overwritten.");
  const config = await jsonAt(path.resolve(flags.identity));
  need((config.media_workflow ?? "avatar_footage_pilot_v1") === "avatar_footage_pilot_v1" && (config.content_profile ?? "mcu_what_if_pilot_v1") === "mcu_what_if_pilot_v1", "Pilot preflight cannot reinterpret a different requested workflow/profile.");
  const definition = contentProfileDefinition("mcu_what_if_pilot_v1");
  need(!Object.hasOwn(config, "content_profile_config") || JSON.stringify(config.content_profile_config) === JSON.stringify(definition.config), "Pilot preflight cannot replace a conflicting embedded editorial contract.");
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
  const dirtyStatus = git("status", "--porcelain=v1", "--untracked-files=all");
  need(!dirtyStatus || (flags["allow-dirty-worktree"] === "true" && hasText(flags["dirty-reason"]) && flags["dirty-reason"].trim().length >= 12), "Pilot preflight requires clean code, or explicit --allow-dirty-worktree true with a meaningful --dirty-reason for this proof.");
  const source = path.resolve(config.source_script?.path ?? "");
  need(config.source_script?.sha256 === hash(await bytesAt(source)), "Preflight script source hash mismatch.");
  const untrackedFiles = git("ls-files", "--others", "--exclude-standard", "-z").split("\u0000").filter(Boolean);
  const untracked = [];
  for (const relative of untrackedFiles) untracked.push({ path: relative, sha256: hash(await bytesAt(path.join(repoRoot, relative))) });
  const bankPath = DEFAULT_NARRATION_DELIVERY_BANK_PATH;
  const narrationFields = buildPilotNarrationIdentityFields({ narrationLock: config.pilot_providers?.narration,
    deliveryBank: { path: bankPath, bytes: await bytesAt(bankPath) } });
  const identity = { ...withNarrationIdentityFields(config, narrationFields), schema: "goldflow_avatar_pilot_identity_v1", content_profile: definition.id, content_profile_config: definition.config, content_profile_sha256: definition.sha256,
    ...mediaWorkflowForPreflight({ contentProfile: definition.id, mediaWorkflow: "avatar_footage_pilot_v1" }),
    stage_registry_version: "2026-09-06.1", source_script: { path: source, sha256: config.source_script.sha256 },
    git: { commit: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"), dirty: Boolean(dirtyStatus), dirty_diff_sha256: hash(`${dirtyStatus}\n${git("diff", "HEAD", "--binary")}\n${JSON.stringify(untracked)}`), dirty_reason: dirtyStatus ? flags["dirty-reason"] : null }, created_at: new Date().toISOString() };
  identityCheck(identity);
  await validateLockedNarrationIdentity(identity, episodeDir);
  need(!pilotArtifactContainsPrivateData(identity), "Pilot identity must not contain credentials or signed URLs.");
  await fs.mkdir(path.dirname(episodeDir), { recursive: true });
  await fs.mkdir(episodeDir);
  await exclusiveJson(path.join(episodeDir, "run_identity.json"), identity);
  await audit(episodeDir, { action: "preflight", status: "passed", identity_sha256: (await binding(path.join(episodeDir, "run_identity.json"))).sha256 });
  return pilotStatusWithAdapter(episodeDir, openingAdapter);
}

async function executePilotCommandWithAdapter(action, flags = {}, { repoRoot = ROOT } = {}, openingAdapter) {
  need(hasText(flags["episode-dir"]) && !Object.hasOwn(flags, "episodeDir"), "Pilot commands require explicit --episode-dir; no implicit production folder.");
  need(!Object.hasOwn(flags, "workflow-bypass"), "The dedicated pilot approval/scope gates cannot be bypassed.");
  const episodeDir = path.resolve(flags["episode-dir"]);
  need(!Object.hasOwn(flags, "media-workflow") || flags["media-workflow"] === "avatar_footage_pilot_v1", "Pilot commands cannot switch media workflow.");
  need(!Object.hasOwn(flags, "content-profile") || flags["content-profile"] === "mcu_what_if_pilot_v1", "Pilot commands cannot switch content profile.");
  if (action === "preflight") return preflight(flags, episodeDir, repoRoot, openingAdapter);
  const stageAction = ["revise-host-design", "approve-host-identity", "use-local-concept-fallback"].includes(action) ? "import-media" : action === "revise-asset-plan" ? "approve-asset-plan" : action === "create-voice-sample" ? "import-voice-sample"
    : ["create-narration", "review-narration", "approve-narration"].includes(action) ? "import-narration" : action;
  const stage = AVATAR_PILOT_STAGES.find((row) => row.action === stageAction);
  need(stage || action === "status", "Unknown pilot action. Use pilot status; publishing and automatic media dispatch are unavailable.");
  const report = await pilotStatusWithAdapter(episodeDir, openingAdapter);
  for (const [flag, key] of [["channel", "channel"], ["series", "series_slug"], ["week", "week"], ["episode", "episode"]]) need(!Object.hasOwn(flags, flag) || flags[flag] === report.identity[key], `Pilot ${flag} flag conflicts with its immutable identity.`);
  if (action === "status") return flags.format === "markdown" ? formatPilotStatus(report) : report;
  need(report.current_stage === stage.id && report.allowed_command_stages.includes(stage.id), `Pilot stopped at ${report.current_stage}; run status and inspect its next artifact. Passed/stale stages cannot be rerun unscoped.`);
  if (["import-voice-sample", "import-narration"].includes(action)) need(PILOT_NARRATION_IMPORT_ADAPTER_STATUS === "proven", "Generic and full narration imports remain blocked pending their proven lineage adapter.");
  if (action === "create-voice-sample") need(openingAdapter.status === "proven" && report.identity.pilot_narration_contract, "Opening synthesis requires its proven scoped adapter and canonical identity.");
  if (["create-narration", "review-narration", "approve-narration"].includes(action)) {
    need(openingAdapter.full?.status === "proven" && report.identity.pilot_narration_contract, "Remaining synthesis requires its proven scoped adapter.");
    need(report.next_command_shape.includes(`pilot ${action} `), "Use the current narration action from run status; no repeated synthesis or premature approval.");
  }
  const lockPath = path.join(episodeDir, ".pilot-stage.lock");
  const lock = await fs.open(lockPath, "wx", 0o600);
  const started = Date.now();
  let producedPayload = null;
  let candidateOnly = false;
  try {
    const current = await pilotStatusWithAdapter(episodeDir, openingAdapter);
    need(current.current_stage === stage.id && current.allowed_command_stages.includes(stage.id), "Pilot stage changed before lease; inspect status.");
    const identity = current.identity;
    const identityRef = await binding(path.join(episodeDir, "run_identity.json"));
    const previous = AVATAR_PILOT_STAGES[AVATAR_PILOT_STAGES.indexOf(stage) - 1];
    const inputs = [{ role: "upstream", ...await binding(await stageOutputPath(episodeDir, previous)) }];
    let payload;
    if (action === "use-local-concept-fallback") {
      need(hasText(flags.input) && flags.accept === "true" && hasText(flags.reviewer) && hasText(flags.note),
        "Local concept fallback requires --input, --accept true, reviewer and note.");
      const prepared = await preparePilotConceptFallback({ episodeDir, identity, inputPath: path.resolve(flags.input),
        reviewer: flags.reviewer, note: flags.note });
      await fs.mkdir(prepared.paths.directory);
      const createdAt = new Date().toISOString();
      const receipt = { schema: "goldflow_avatar_pilot_concept_fallback_v1", status: "approved_local_editorial_fallback",
        created_at: createdAt, identity_sha256: prepared.identityRef.sha256, request: prepared.requestRef,
        prior_plan: prepared.priorPlanRef, prior_approval: prepared.priorApprovalRef,
        affected_asset_ids: prepared.delta.affected_asset_ids,
        review: { approved: true, reviewer: prepared.reviewer, note: prepared.note }, creative_submissions: 0,
        provider_cost: 0, production_eligible: false, publish_allowed: false };
      await exclusiveJson(prepared.paths.receipt, receipt);
      const receiptRef = await binding(prepared.paths.receipt);
      const planInputs = [{ role: "upstream", ...await binding(await stageOutputPath(episodeDir, AVATAR_PILOT_STAGES[6])) },
        { role: "prior_plan", ...prepared.priorPlanRef }, { role: "revision_request", ...prepared.requestRef }, { role: "revision_receipt", ...receiptRef }];
      await exclusiveJson(prepared.paths.plan, { schema: "goldflow_avatar_pilot_stage_v1", stage: "pilot_asset_plan",
        identity_sha256: prepared.identityRef.sha256, inputs: planInputs, payload: prepared.nextPlan, created_at: createdAt });
      const planRef = await binding(prepared.paths.plan);
      const approvalInputs = [{ role: "upstream", ...planRef }, { role: "prior_approval", ...prepared.priorApprovalRef }, { role: "revision_receipt", ...receiptRef }];
      await exclusiveJson(prepared.paths.approval, { schema: "goldflow_avatar_pilot_stage_v1", stage: "pilot_asset_plan_approval",
        identity_sha256: prepared.identityRef.sha256, inputs: approvalInputs,
        payload: { review: { approved: true, reviewer: prepared.reviewer, note: prepared.note, attestation: null } }, created_at: createdAt });
      const approvalRef = await binding(prepared.paths.approval);
      await exclusiveJson(prepared.paths.authorization, { schema: "goldflow_avatar_pilot_concept_fallback_authorization_v1", status: "authorized",
        created_at: createdAt, identity_sha256: prepared.identityRef.sha256, plan: planRef, approval: approvalRef,
        revision_receipt: receiptRef, affected_asset_ids: prepared.delta.affected_asset_ids,
        provider_failures: prepared.request.provider_failures, creative_submissions_authorized: 0,
        automatic_retry: false, automatic_failover: false, production_eligible: false, publish_allowed: false });
      const authorizationRef = await binding(prepared.paths.authorization);
      const executionRef = await audit(episodeDir, { action, status: "passed", elapsed_ms: Date.now() - started,
        identity_sha256: prepared.identityRef.sha256, inputs: [...planInputs, ...approvalInputs.slice(1), { role: "fallback_authorization", ...authorizationRef }],
        output: authorizationRef, scope: { duration_sec: 90, phase: "provider_refusal_to_local_editorial_composites",
          affected_asset_ids: prepared.delta.affected_asset_ids }, creative_submissions: 0, provider_cost: 0,
        synthesis_invoked: false, generation_authorized: false, production_eligible: false, publish_allowed: false });
      await exclusiveJson(prepared.paths.activation, { schema: "goldflow_avatar_pilot_concept_fallback_activation_v1",
        identity_sha256: prepared.identityRef.sha256, receipt: receiptRef, plan: planRef, approval: approvalRef,
        authority: authorizationRef, execution_report: executionRef });
      await resolvePilotConceptFallback({ episodeDir, identity });
      const fallbackStatus = await pilotStatusWithAdapter(episodeDir, openingAdapter);
      return flags.format === "markdown" ? formatPilotStatus(fallbackStatus) : fallbackStatus;
    } else if (action === "approve-host-identity") {
      need(hasText(flags.input) && flags.accept === "true" && hasText(flags.reviewer) && hasText(flags.note),
        "Host-identity approval requires --input, --accept true, reviewer and note.");
      const prepared = await preparePilotHostIdentityApproval({ episodeDir, identity, inputPath: path.resolve(flags.input),
        reviewer: flags.reviewer, note: flags.note });
      await fs.mkdir(prepared.paths.directory);
      const createdAt = new Date().toISOString();
      const approval = { schema: "goldflow_avatar_pilot_host_identity_approval_v1", status: "authorized",
        created_at: createdAt, identity_sha256: prepared.identityRef.sha256, request: prepared.requestRef,
        host_design_authority: prepared.revision.authorization,
        asset_plan: { path: prepared.revision.plan.path, sha256: (await binding(prepared.revision.plan.path)).sha256 },
        asset_plan_approval: { path: prepared.revision.approval.path, sha256: (await binding(prepared.revision.approval.path)).sha256 },
        accepted_neutral_asset_id: "host_neutral", accepted_native_output: prepared.native,
        accepted_alpha_output: prepared.alpha, operator_review: prepared.request.operator_review,
        alpha_receipt: prepared.request.alpha_receipt, dependent_pose_asset_ids: prepared.dependentPoseIds,
        creative_submissions_per_pose: 1, attempt_number_per_pose: 1,
        required_reference_binding: { id: "host_neutral", ...prepared.alpha },
        external_inspiration_for_dependent_poses: false, automatic_retry: false, automatic_failover: false,
        production_eligible: false, publish_allowed: false,
        review: { approved: true, reviewer: prepared.reviewer, note: prepared.note } };
      await exclusiveJson(prepared.paths.approval, approval);
      const approvalRef = await binding(prepared.paths.approval);
      const executionRef = await audit(episodeDir, { action, status: "passed", elapsed_ms: Date.now() - started,
        identity_sha256: prepared.identityRef.sha256,
        inputs: [{ role: "host_identity_approval_request", ...prepared.requestRef },
          { role: "host_design_authority", ...prepared.revision.authorization },
          { role: "accepted_native_output", ...prepared.native }, { role: "accepted_alpha_output", ...prepared.alpha },
          { role: "operator_review", ...prepared.request.operator_review }, { role: "alpha_receipt", ...prepared.request.alpha_receipt }],
        output: approvalRef, scope: { duration_sec: 90, phase: "accepted_host_identity_and_dependent_pose_release",
          accepted_asset_id: "host_neutral", dependent_pose_asset_ids: prepared.dependentPoseIds },
        creative_submissions: 0, provider_cost: 0, synthesis_invoked: false, generation_authorized: true,
        production_eligible: false, publish_allowed: false });
      await exclusiveJson(prepared.paths.activation, { schema: "goldflow_avatar_pilot_host_identity_approval_activation_v1",
        identity_sha256: prepared.identityRef.sha256, approval: approvalRef, execution_report: executionRef });
      await resolvePilotHostIdentityApproval({ episodeDir, identity });
      const approvedStatus = await pilotStatusWithAdapter(episodeDir, openingAdapter);
      return flags.format === "markdown" ? formatPilotStatus(approvedStatus) : approvedStatus;
    } else if (action === "revise-host-design") {
      need(hasText(flags.input) && flags.accept === "true" && hasText(flags.reviewer) && hasText(flags.note),
        "Host-design revision requires --input, --accept true, reviewer and note.");
      const prepared = await preparePilotHostDesignRevision({ episodeDir, identity, inputPath: path.resolve(flags.input),
        reviewer: flags.reviewer, note: flags.note });
      await fs.mkdir(prepared.paths.directory);
      const createdAt = new Date().toISOString();
      const receipt = { schema: "goldflow_avatar_pilot_host_design_revision_v1", status: "approved_host_design_revision",
        created_at: createdAt, identity_sha256: prepared.identityRef.sha256, request: prepared.requestRef,
        prior_plan: prepared.priorPlanRef, prior_approval: prepared.priorApprovalRef,
        affected_asset_ids: prepared.delta.affected_asset_ids,
        review: { approved: true, reviewer: prepared.reviewer, note: prepared.note },
        creative_submissions: 0, provider_cost: 0, production_eligible: false, publish_allowed: false };
      await exclusiveJson(prepared.paths.receipt, receipt);
      const receiptRef = await binding(prepared.paths.receipt);
      const planInputs = [{ role: "upstream", ...await binding(await stageOutputPath(episodeDir, AVATAR_PILOT_STAGES[6])) },
        { role: "prior_plan", ...prepared.priorPlanRef }, { role: "revision_request", ...prepared.requestRef },
        { role: "revision_receipt", ...receiptRef }];
      await exclusiveJson(prepared.paths.plan, { schema: "goldflow_avatar_pilot_stage_v1", stage: "pilot_asset_plan",
        identity_sha256: prepared.identityRef.sha256, inputs: planInputs, payload: prepared.nextPlan, created_at: createdAt });
      const planRef = await binding(prepared.paths.plan);
      const approvalInputs = [{ role: "upstream", ...planRef }, { role: "prior_approval", ...prepared.priorApprovalRef },
        { role: "revision_receipt", ...receiptRef }];
      await exclusiveJson(prepared.paths.approval, { schema: "goldflow_avatar_pilot_stage_v1", stage: "pilot_asset_plan_approval",
        identity_sha256: prepared.identityRef.sha256, inputs: approvalInputs,
        payload: { review: { approved: true, reviewer: prepared.reviewer, note: prepared.note, attestation: null } }, created_at: createdAt });
      const approvalRef = await binding(prepared.paths.approval);
      const authorization = { schema: "goldflow_avatar_pilot_host_design_revision_authorization_v1", status: "authorized",
        created_at: createdAt, identity_sha256: prepared.identityRef.sha256, replacement_asset_id: "host_neutral",
        replacement_attempt_number: 2, creative_submissions_authorized: 1, lifetime_creative_submission_limit: 2,
        plan: planRef, approval: approvalRef, revision_receipt: receiptRef,
        prior_attempt: prepared.request.prior_attempt, replacement_prompt: prepared.request.replacement_prompt,
        external_inspiration_bindings: prepared.request.external_inspiration_bindings,
        dependent_pose_generation_authorized: false, automatic_retry: false, automatic_failover: false,
        production_eligible: false, publish_allowed: false };
      await exclusiveJson(prepared.paths.authorization, authorization);
      const authorizationRef = await binding(prepared.paths.authorization);
      const executionInputs = [...planInputs, ...approvalInputs.slice(1), { role: "effective_plan", ...planRef },
        { role: "effective_approval", ...approvalRef }, { role: "replacement_authorization", ...authorizationRef }];
      const executionRef = await audit(episodeDir, { action, status: "passed", elapsed_ms: Date.now() - started,
        identity_sha256: prepared.identityRef.sha256, inputs: executionInputs, output: authorizationRef,
        scope: { duration_sec: 90, phase: "host_design_revision_and_single_replacement_authorization",
          affected_asset_ids: prepared.delta.affected_asset_ids, replacement_asset_id: "host_neutral", replacement_attempt_number: 2 },
        creative_submissions: 0, provider_cost: 0, synthesis_invoked: false, generation_authorized: true,
        production_eligible: false, publish_allowed: false });
      await exclusiveJson(prepared.paths.activation, { schema: "goldflow_avatar_pilot_host_design_revision_activation_v1",
        identity_sha256: prepared.identityRef.sha256, receipt: receiptRef, plan: planRef, approval: approvalRef,
        authority: authorizationRef, execution_report: executionRef });
      await resolvePilotHostDesignRevision({ episodeDir, identity });
      const revisedStatus = await pilotStatusWithAdapter(episodeDir, openingAdapter);
      return flags.format === "markdown" ? formatPilotStatus(revisedStatus) : revisedStatus;
    } else if (action === "revise-asset-plan") {
      need(hasText(flags.input) && hasText(flags["affected-asset-ids"]), "Revision requires --input and exact --affected-asset-ids.");
      need(!Object.hasOwn(flags, "accept"), "Plan revision does not approve the asset plan; use its separate approval action later.");
      const prepared = await preparePilotAssetPlanRevision({ episodeDir, identity, inputPath: path.resolve(flags.input),
        priorStageSha256: flags["prior-stage-sha256"], affectedAssetIds: flags["affected-asset-ids"].split(",").map((id) => id.trim()),
        reviewer: flags.reviewer, note: flags.note });
      await fs.mkdir(prepared.paths.directory);
      await exclusiveJson(prepared.paths.receipt, prepared.receipt);
      const receiptRef = await binding(prepared.paths.receipt);
      const revisionInputs = [{ role: "upstream", ...prepared.upstream }, { role: "prior_stage", ...prepared.originalRef },
        { role: "import", ...prepared.nextRef }, { role: "revision_receipt", ...receiptRef }];
      await exclusiveJson(prepared.paths.stage, { schema: "goldflow_avatar_pilot_stage_v1", stage: "pilot_asset_plan",
        identity_sha256: identityRef.sha256, inputs: revisionInputs, payload: prepared.nextPlan, created_at: prepared.receipt.created_at });
      const stageRef = await binding(prepared.paths.stage);
      const executionRef = await audit(episodeDir, { action, status: "passed", elapsed_ms: Date.now() - started,
        identity_sha256: identityRef.sha256, inputs: revisionInputs, output: stageRef,
        scope: { duration_sec: 90, phase: "asset_plan_revision_only", affected_asset_ids: prepared.delta.affectedAssetIds },
        creative_submissions: 0, provider_cost: 0, synthesis_invoked: false, asset_plan_approved: false });
      await exclusiveJson(prepared.paths.activation, { schema: "goldflow_avatar_pilot_asset_plan_revision_activation_v1",
        identity_sha256: identityRef.sha256, stage: stageRef, receipt: receiptRef, execution_report: executionRef });
      await resolvePilotAssetPlanStage({ episodeDir, identity });
      const revisedStatus = await pilotStatusWithAdapter(episodeDir, openingAdapter);
      return flags.format === "markdown" ? formatPilotStatus(revisedStatus) : revisedStatus;
    } else if (action === "ingest") {
      need(hasText(flags.script), "ingest requires --script <spoken-text.md>.");
      const source = path.resolve(flags.script);
      const text = (await bytesAt(source)).toString("utf8");
      inputs.push({ role: "import", ...await binding(source) });
      payload = { text, source_script_sha256: hash(text) };
    } else if (action === "create-voice-sample") {
      need(hasText(flags.input), "create-voice-sample requires --input <opening-editorial.json>.");
      const editorialPath = path.resolve(flags.input);
      await jsonAt(editorialPath);
      inputs.push({ role: "editorial", ...await binding(editorialPath) });
      payload = await openingAdapter.produce({ episodeDir, editorialPath });
      producedPayload = payload;
      need(payload?.schema === OPENING_SCHEMA, "Opening producer did not return its scoped result.");
      const producerResult = path.join(episodeDir, "pilot_narration_work", "opening_producer_result.json");
      need(JSON.stringify(await jsonAt(producerResult)) === JSON.stringify(payload), "Opening producer result does not match its persisted receipt.");
      inputs.push({ role: "produced_opening", ...await binding(producerResult) });
    } else if (action === "create-narration") {
      payload = await openingAdapter.full.produce({ episodeDir }); producedPayload = payload;
      need(payload?.schema === NARRATION_SCHEMA, "Remaining producer did not return its full-proof candidate.");
      const resultPath = path.join(episodeDir, "pilot_narration_work", "narration_producer_result.json");
      need(JSON.stringify(await jsonAt(resultPath)) === JSON.stringify(payload), "Narration candidate must match its persisted result.");
      accepted(await openingAdapter.full.validate(payload, { episodeDir, identity }));
      inputs.push({ role: "produced_narration", ...await binding(resultPath) }); candidateOnly = true;
    } else if (action === "review-narration") {
      need(flags.accept === "true" && hasText(flags.reviewer) && hasText(flags.note)
        && flags.attestation === RAW_REVIEW_ATTESTATION, "Exact complete raw narration listening approval required.");
      need(typeof openingAdapter.full.review === "function", "No reviewed delivery continuation is available.");
      payload = await openingAdapter.full.review({ episodeDir, reviewer: flags.reviewer, note: flags.note, attestation: flags.attestation });
      producedPayload = payload;
      const resultPath = path.join(episodeDir, "pilot_narration_work", "narration_reviewed_result.json");
      need(payload?.schema === NARRATION_SCHEMA && payload.review_continuation
        && JSON.stringify(await jsonAt(resultPath)) === JSON.stringify(payload), "Reviewed narration must match its persisted result and continuation.");
      accepted(await openingAdapter.full.validate(payload, { episodeDir, identity }));
      inputs.push({ role: "produced_narration", ...await binding(resultPath) }); candidateOnly = true;
    } else if (action === "approve-narration") {
      need(flags.accept === "true" && hasText(flags.reviewer) && hasText(flags.note)
        && flags.attestation === PILOT_NARRATION_LISTEN_ATTESTATION, "Full proof narration approval requires complete listening, reviewer, note and exact attestation.");
      const resultRef = await binding(await currentNarrationResultPath(episodeDir));
      const result = await jsonAt(resultRef.path);
      accepted(await openingAdapter.full.validate(result, { episodeDir, identity }));
      const refs = result.finalization_artifacts;
      const manifest = await jsonAt(await checkBinding(refs.subjective_manifest, episodeDir));
      need(manifest.status === "review_required" && manifest.audio_sha256 === refs.audio.sha256
        && manifest.samples.every((row) => row.start_sample >= 0 && row.end_sample_exclusive <= manifest.total_sample_count), "Full listening scope is invalid.");
      const reviewer = flags.reviewer.trim(), note = flags.note.trim();
      const decision = buildNarrationSubjectiveReviewDecision({ manifest, reviewer,
        attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
        decisions: manifest.samples.map((row) => ({ sample_id: row.sample_id, decision: "accept", note })) });
      accepted(validateNarrationSubjectiveReviewDecision(manifest, decision));
      const outputDir = path.join(episodeDir, "pilot_narration_work", result.review_continuation ? "full_finalization_reviewed" : "full_finalization");
      const decisionPath = path.join(outputDir, `narration_subjective_review_decision_${identity.episode}.json`);
      const timing = buildPilotNarrationTiming({ result, candidate: await jsonAt(await checkBinding(refs.timing_candidate, episodeDir)),
        delivery: await jsonAt(await checkBinding(refs.full_stream_qa, episodeDir)), identity });
      const timingPath = path.join(outputDir, "pilot_word_timing.json");
      await exclusiveJson(decisionPath, decision); await exclusiveJson(timingPath, timing);
      payload = { schema: PILOT_NARRATION_ACCEPTANCE_SCHEMA, narration_result: resultRef, audio: refs.audio,
        subjective_decision: await binding(decisionPath), whisper_timing: await binding(timingPath),
        production_eligible: false, publish_allowed: false, review: { approved: true, reviewer, note, attestation: flags.attestation },
        listening_attestation_mapping: { operator_attestation: PILOT_NARRATION_LISTEN_ATTESTATION,
          canonical_attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION, audio_sha256: refs.audio.sha256,
          manifest_sha256: refs.subjective_manifest.sha256, all_samples_contained_in_full_narration: true,
          sample_ids: manifest.samples.map((row) => row.sample_id) } };
      inputs.push({ role: "produced_narration", ...resultRef }, { role: "subjective_manifest", ...refs.subjective_manifest },
        { role: "subjective_decision", ...payload.subjective_decision }, { role: "whisper_timing", ...payload.whisper_timing });
    } else if (["approve-evidence", "import-voice-sample", "import-narration", "plan-assets", "import-media", "timeline"].includes(action)) {
      need(hasText(flags.input), `${action} requires --input <artifact.json>.`);
      const input = path.resolve(flags.input);
      payload = await jsonAt(input);
      inputs.push({ role: "import", ...await binding(input) });
      if (action === "approve-evidence") payload = { evidence: payload };
    } else if (action === "render") {
      const { renderAvatarPilot } = await import("./avatar-pilot-render.mjs");
      const timeline = (await rowAt(episodeDir, AVATAR_PILOT_STAGES[10])).payload;
      payload = await renderAvatarPilot({ timeline, assets: await rendererAssets(episodeDir), outputPath: path.join(episodeDir, "pilot_proof_90s.mp4"), workDir: path.join(episodeDir, "pilot_render_work") });
    } else { payload = {}; }
    if (stage.approval === "operator") {
      need(flags.accept === "true" || ["approve-evidence", "final-qa"].includes(action), "Approval requires --accept true after reviewing the exact bound input.");
      payload.review = { approved: true, reviewer: flags.reviewer, note: flags.note, attestation: flags.attestation ?? null };
    }
    if (action === "approve-voice-sample"
      && (await rowAt(episodeDir, AVATAR_PILOT_STAGES[4])).payload.schema === OPENING_SCHEMA) {
      need(payload.review.approved === true && hasText(payload.review.reviewer) && hasText(payload.review.note)
        && payload.review.attestation === OPENING_ATTESTATION,
      "Opening approval requires reviewer, note and explicit complete_opening_listened_end_to_end attestation.");
      payload.review.reviewer = payload.review.reviewer.trim();
      payload.review.note = payload.review.note.trim();
      const { manifest, manifestRef, audioRef } = await openingReviewInputs(episodeDir);
      const decision = buildNarrationSubjectiveReviewDecision({ manifest, reviewer: payload.review.reviewer,
        attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
        decisions: manifest.samples.map((row) => ({ sample_id: row.sample_id, decision: "accept", note: payload.review.note })) });
      accepted(validateNarrationSubjectiveReviewDecision(manifest, decision));
      const decisionPath = path.join(episodeDir, "pilot_narration_work", "opening_finalization", `narration_subjective_review_decision_${identity.episode}.json`);
      await exclusiveJson(decisionPath, decision);
      payload.subjective_decision = await binding(decisionPath);
      payload.listening_attestation_mapping = {
        schema: "goldflow_pilot_opening_listening_attestation_mapping_v1",
        operator_attestation: OPENING_ATTESTATION, canonical_attestation: NARRATION_SUBJECTIVE_REVIEW_ATTESTATION,
        manifest_sha256: manifestRef.sha256, audio_sha256: audioRef.sha256,
        all_samples_contained_in_opening: true, sample_ids: manifest.samples.map((row) => row.sample_id),
      };
      inputs.push({ role: "subjective_manifest", ...manifestRef }, { role: "opening_audio", ...audioRef },
        { role: "subjective_decision", ...payload.subjective_decision });
    }
    if (!candidateOnly) await validatePayload(stage, payload, episodeDir, identity, openingAdapter);
    // Recheck imported/upstream bytes immediately before accepting the stage.
    for (const ref of inputs) await checkBinding(ref, episodeDir);
    await checkBinding(identityRef, episodeDir);
    const output = path.join(episodeDir, stage.output);
    if (!candidateOnly) await exclusiveJson(output, { schema: "goldflow_avatar_pilot_stage_v1", stage: stage.id, identity_sha256: identityRef.sha256, inputs, payload, created_at: new Date().toISOString() });
    await audit(episodeDir, { action, status: candidateOnly ? "awaiting_review" : "passed", elapsed_ms: Date.now() - started, identity_sha256: identityRef.sha256, inputs,
      output: await binding(candidateOnly ? await currentNarrationResultPath(episodeDir) : output),
      ...(action === "review-narration" ? { creative_submissions: 0, synthesis_invoked: false, scope: { phase: "delivery_review_and_mastering_only" } } : {}),
      ...(["create-voice-sample", "create-narration"].includes(action) ? await openingAttemptAccounting(episodeDir, payload, action === "create-narration" ? "remaining" : "opening") : {}) });
  } catch (error) {
    await audit(episodeDir, { action, status: "blocked", elapsed_ms: Date.now() - started, reason: "Stage failed; inspect exact inputs and retained artifacts before scoped recovery.",
      ...(action === "review-narration" ? { creative_submissions: 0, synthesis_invoked: false, scope: { phase: "delivery_review_and_mastering_only" } } : {}),
      ...(["create-voice-sample", "create-narration"].includes(action) ? await openingAttemptAccounting(episodeDir, producedPayload, action === "create-narration" ? "remaining" : "opening").catch(() => ({ creative_submissions: null, synthesis_authorized: "unknown" })) : {}) });
    throw error;
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
  const next = await pilotStatusWithAdapter(episodeDir, openingAdapter);
  return flags.format === "markdown" ? formatPilotStatus(next) : next;
}

export async function executePilotCommand(action, flags = {}, options = {}) {
  return executePilotCommandWithAdapter(action, flags, options, OPENING_ADAPTER);
}

// Test-only dependency seam. Never accepted through CLI flags or production
// options; every public command/status call above uses the release constant.
export function pilotWorkflowFixtureHarness({ status, produce, validate, full = { status: "unproven" } }) {
  need(["proven", "unproven"].includes(status) && typeof produce === "function" && typeof validate === "function", "Complete fixture adapters required.");
  const adapter = Object.freeze({ status, produce, validate, full });
  return Object.freeze({
    pilotStatus: (episodeDir) => pilotStatusWithAdapter(episodeDir, adapter),
    executePilotCommand: (action, flags = {}, options = {}) => executePilotCommandWithAdapter(action, flags, options, adapter),
  });
}
