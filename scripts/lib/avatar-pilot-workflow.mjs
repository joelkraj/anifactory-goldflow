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
async function rowAt(episodeDir, stage) { return jsonAt(path.join(episodeDir, stage.output)); }
async function sourceText(episodeDir) { return (await rowAt(episodeDir, AVATAR_PILOT_STAGES[1])).payload.text; }
async function narrationPayload(episodeDir) { return (await rowAt(episodeDir, AVATAR_PILOT_STAGES[6])).payload; }

async function validatePayload(stage, payload, episodeDir, identity) {
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
    accepted(await validatePilotNarrationBundle(payload, { episodeDir, identity, phase, sourceScriptSha256: identity.source_script.sha256 }));
    if (phase === "full") {
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
      if (shot.layers.some((layer) => ["concept_still", "concept_video"].includes(assets[layer.asset_id]?.kind))) need(shot.truth_mode === "hypothesis" && hasText(shot.truth_label), "Every generated scenario must carry a visible what-if label, not masquerade as film evidence.");
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
    // Captions are authored from the approved script and bound Whisper timing, not movie dialogue.
    const normalizeWords = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.join(" ").replaceAll("’", "'") ?? "";
    need(normalizeWords(payload.captions.map((caption) => caption.text).join(" ")) === normalizeWords(await sourceText(episodeDir)), "Pilot captions must reproduce the complete approved narration text in order.");
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
    need(nextWord === words.length, "Captions must account for every narration word.");
  }
  if (stage.action === "render") {
    need(payload.duration_frames === 2700 && Math.abs(payload.duration_sec - 90) <= 1 / 30, "Pilot render must be exactly 90 seconds / 2700 frames.");
    await checkBinding({ path: payload.output_path, sha256: payload.sha256 }, episodeDir);
  }
  if (stage.approval === "operator") {
    need(payload.review?.approved === true && hasText(payload.review.reviewer) && hasText(payload.review.note), "Explicit reviewer and review note required.");
    if (stage.action === "approve-voice-sample") need(payload.review.attestation === "complete_opening_listened_end_to_end", "Opening approval requires listening to the entire bound sample.");
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

export async function pilotStatus(episodeDir) {
  episodeDir = path.resolve(episodeDir);
  const identityPath = path.join(episodeDir, "run_identity.json");
  const identity = identityCheck(await jsonAt(identityPath));
  const identityHash = hash(await bytesAt(identityPath));
  const stages = [];
  for (const stage of AVATAR_PILOT_STAGES) {
    let state = "passed", reason = null, exists = false;
    try {
      const output = path.join(episodeDir, stage.output);
      exists = Boolean(await fs.stat(output).catch(() => null));
      if (!exists) { state = "missing"; }
      else if (stage.action === "preflight") await validateLockedNarrationIdentity(identity, episodeDir);
      else if (stage.action !== "preflight") {
        const row = await rowAt(episodeDir, stage);
        need(row.schema === "goldflow_avatar_pilot_stage_v1" && row.stage === stage.id && row.identity_sha256 === identityHash, "Stage identity binding is stale.");
        const dependency = AVATAR_PILOT_STAGES[AVATAR_PILOT_STAGES.indexOf(stage) - 1];
        const expected = await binding(path.join(episodeDir, dependency.output));
        need(row.inputs.some((ref) => ref.role === "upstream" && ref.sha256 === expected.sha256 && path.resolve(episodeDir, ref.path) === expected.path), "Stage upstream binding missing or stale.");
        for (const ref of row.inputs) await checkBinding(ref, episodeDir);
        await validatePayload(stage, row.payload, episodeDir, identity);
      }
    } catch (error) { state = "blocked"; reason = error.message; }
    if (stage.action !== "preflight" && stages.at(-1)?.state !== "passed" && state === "passed") { state = "blocked"; reason = "Upstream artifact is unresolved."; }
    if (PILOT_NARRATION_IMPORT_ADAPTER_STATUS !== "proven" && ["import-voice-sample", "import-narration"].includes(stage.action)) {
      state = "blocked";
      reason = "Canonical narration lineage import is not yet proven; new pilot synthesis is also not implemented. No arbitrary WAV or stub QA imports.";
    }
    stages.push({ stage: stage.id, state, artifact: path.join(episodeDir, stage.output), exists, approval_policy: stage.approval, reason, next_command_shape: PILOT_NARRATION_IMPORT_ADAPTER_STATUS !== "proven" && ["import-voice-sample", "import-narration"].includes(stage.action) ? "Implement and fixture-prove the canonical narration lineage adapter before speech import/synthesis." : pilotCommandShape(stage, episodeDir) });
  }
  const current = stages.find((row) => row.state !== "passed");
  return { schema: "goldflow_run_status_v2", episode_dir: episodeDir, media_workflow: identity.media_workflow, identity, production_eligible: false, publish_allowed: false, current_stage: current?.stage ?? "complete", next_command_shape: current?.next_command_shape ?? null, allowed_command_stages: current?.state === "missing" ? [current.stage] : [], stages,
    capabilities: { narration: "blocked_pending_proven_canonical_lineage_import_and_scoped_synthesis_adapter", images_video: "reviewed_local_import_only_no_automatic_provider_dispatch", render: "local_typed_90_second_compositor" } };
}
export function formatPilotStatus(report) {
  return `# Private 90-second avatar pilot\n\nCurrent stage: ${report.current_stage}. Publishing disabled.\n\n| Stage | State | Approval | Artifact exists |\n| --- | --- | --- | --- |\n${report.stages.map((row) => `| ${row.stage} | ${row.state} | ${row.approval_policy} | ${row.exists ? "yes" : "no"} |`).join("\n")}\n\nNext: ${report.next_command_shape ?? "Proof complete; no publishing command."}\n\n${report.stages.filter((row) => row.reason).map((row) => `${row.stage}: ${row.reason}`).join("\n")}\nNarration import remains blocked pending a proven canonical text/audio lineage adapter; new pilot synthesis is also not implemented. Gemini/Flow assets are reviewed local imports, not automatic dispatch.`;
}

async function exclusiveJson(file, value) { await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
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
    total_creative_submissions_by_controller: events.reduce((sum, row) => sum + row.creative_submissions, 0),
    total_provider_cost_by_controller: events.reduce((sum, row) => sum + row.provider_cost, 0),
    imported_media_provider_cost: "Retained in original provider evidence when available; not incurred by this import controller.",
    accepted_stage_receipts: events.filter((row) => row.status === "passed").map((row) => ({ action: row.action, report_id: row.id, identity_sha256: row.identity_sha256, output: row.output ?? null })),
    complete_episode_status: "Use current run status validators; current-batch success is not proof completion.",
  };
  const temporary = path.join(episodeDir, `.pilot-manifest-${id}.json`);
  await exclusiveJson(temporary, manifest);
  await fs.rename(temporary, path.join(episodeDir, "production_manifest.json"));
}
async function preflight(flags, episodeDir, repoRoot) {
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
  return pilotStatus(episodeDir);
}

export async function executePilotCommand(action, flags = {}, { repoRoot = ROOT } = {}) {
  need(hasText(flags["episode-dir"]) && !Object.hasOwn(flags, "episodeDir"), "Pilot commands require explicit --episode-dir; no implicit production folder.");
  need(!Object.hasOwn(flags, "workflow-bypass"), "The dedicated pilot approval/scope gates cannot be bypassed.");
  const episodeDir = path.resolve(flags["episode-dir"]);
  need(!Object.hasOwn(flags, "media-workflow") || flags["media-workflow"] === "avatar_footage_pilot_v1", "Pilot commands cannot switch media workflow.");
  need(!Object.hasOwn(flags, "content-profile") || flags["content-profile"] === "mcu_what_if_pilot_v1", "Pilot commands cannot switch content profile.");
  if (action === "preflight") return preflight(flags, episodeDir, repoRoot);
  const stage = AVATAR_PILOT_STAGES.find((row) => row.action === action);
  need(stage || action === "status", "Unknown pilot action. Use pilot status; no publish or automatic synthesis action exists.");
  const report = await pilotStatus(episodeDir);
  for (const [flag, key] of [["channel", "channel"], ["series", "series_slug"], ["week", "week"], ["episode", "episode"]]) need(!Object.hasOwn(flags, flag) || flags[flag] === report.identity[key], `Pilot ${flag} flag conflicts with its immutable identity.`);
  if (action === "status") return flags.format === "markdown" ? formatPilotStatus(report) : report;
  need(report.current_stage === stage.id && report.allowed_command_stages.includes(stage.id), `Pilot stopped at ${report.current_stage}; run status and inspect its next artifact. Passed/stale stages cannot be rerun unscoped.`);
  const lockPath = path.join(episodeDir, ".pilot-stage.lock");
  const lock = await fs.open(lockPath, "wx", 0o600);
  const started = Date.now();
  try {
    const current = await pilotStatus(episodeDir);
    need(current.current_stage === stage.id && current.allowed_command_stages.includes(stage.id), "Pilot stage changed before lease; inspect status.");
    const identity = current.identity;
    const identityRef = await binding(path.join(episodeDir, "run_identity.json"));
    const previous = AVATAR_PILOT_STAGES[AVATAR_PILOT_STAGES.indexOf(stage) - 1];
    const inputs = [{ role: "upstream", ...await binding(path.join(episodeDir, previous.output)) }];
    let payload;
    if (action === "ingest") {
      need(hasText(flags.script), "ingest requires --script <spoken-text.md>.");
      const source = path.resolve(flags.script);
      const text = (await bytesAt(source)).toString("utf8");
      inputs.push({ role: "import", ...await binding(source) });
      payload = { text, source_script_sha256: hash(text) };
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
    await validatePayload(stage, payload, episodeDir, identity);
    // Recheck imported/upstream bytes immediately before accepting the stage.
    for (const ref of inputs) await checkBinding(ref, episodeDir);
    await checkBinding(identityRef, episodeDir);
    const output = path.join(episodeDir, stage.output);
    await exclusiveJson(output, { schema: "goldflow_avatar_pilot_stage_v1", stage: stage.id, identity_sha256: identityRef.sha256, inputs, payload, created_at: new Date().toISOString() });
    await audit(episodeDir, { action, status: "passed", elapsed_ms: Date.now() - started, identity_sha256: identityRef.sha256, inputs, output: await binding(output) });
  } catch (error) {
    await audit(episodeDir, { action, status: "blocked", elapsed_ms: Date.now() - started, reason: "Stage failed; inspect exact inputs and retained artifacts before scoped recovery." });
    throw error;
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
  const next = await pilotStatus(episodeDir);
  return flags.format === "markdown" ? formatPilotStatus(next) : next;
}
