import { productionProfileForIdentity } from "./production-profiles.mjs";
import { AVATAR_PILOT_STAGES } from "./avatar-pilot-stage-registry.mjs";
import { assertAvailableMediaWorkflow, GENERATED_VISUALS_STAGE_REGISTRY_VERSION } from "./media-workflows.mjs";
import {
  isLegacyQwenIdentity,
  narrationTtsPolicyForIdentity,
} from "./narration-tts-policy.mjs";
import {
  localWhisperCommandFlags,
  localWhisperContractForIdentity,
} from "./local-whisper-policy.mjs";
import { generatedMotionEnabled } from "./generated-motion-contract.mjs";
import { isBrowserPoolImageProvider } from "./image-provider-policy.mjs";
import {
  plannerConcurrencyForIdentity,
  planningProviderForIdentity,
} from "./planning-runtime-policy.mjs";

export const PIPELINE_STAGE_REGISTRY_VERSION = GENERATED_VISUALS_STAGE_REGISTRY_VERSION;

export const STAGE_STATES = Object.freeze([
  "passed",
  "blocked",
  "failed",
  "missing",
  "stale",
  "skipped_with_waiver",
]);

const stages = [
  {
    id: "run_identity",
    title: "Run identity",
    required_input: "operator/run intent + source identity",
    output_artifact: "run_identity.json",
    approval: "automatic",
    validator: "run_identity_v2_or_legacy_adapter",
    commands: ["run preflight", "run relock-tts"],
  },
  {
    id: "source_ingest",
    title: "Source ingest",
    required_input: "run_identity.json + source story",
    output_artifact: "script_clean.md + source_story_ingest_report.json",
    approval: "automatic",
    validator: "source_ingest_hashes",
    commands: ["ingest source"],
  },
  {
    id: "script_approval",
    title: "Script approval",
    required_input: "script_clean.md",
    output_artifact: "operator_script_approval.json + script_lock.json",
    approval: "operator",
    validator: "script_hash_approval",
    commands: ["script approve"],
  },
  {
    id: "script_pace_check",
    title: "Script pace diagnostics",
    required_input: "approved script hash",
    output_artifact: "script_pace_report.json",
    approval: "automatic",
    validator: "script_pace_hash_and_policy",
    commands: ["script pace-check"],
  },
  {
    id: "targeted_speakability",
    title: "Targeted speakability",
    required_input: "approved script hash",
    output_artifact: "script_speakability_report.json + tts_spoken_overrides.json",
    approval: "automatic",
    validator: "speakability_hashes",
    commands: ["script targeted"],
  },
  {
    id: "semantic_scene_plan",
    title: "Semantic continuity",
    required_input: "approved script + bibles",
    output_artifact: "semantic_scene_plan.json + story_fact_ledger.json",
    approval: "automatic",
    validator: "semantic_plan_and_fact_ledger",
    output_patterns: [
      /^semantic_scene_plan\.json$/,
      /^story_fact_ledger\.json$/,
      /^semantic_.*\.json$/,
    ],
    commands: ["semantic plan"],
  },
  {
    id: "voice_plan",
    title: "Narrator voice plan",
    required_input: "speakability report + overrides",
    output_artifact: "narration_generation_plan.json",
    approval: "automatic",
    validator: "voice_plan_hashes",
    depends_on: ["targeted_speakability"],
    output_patterns: [
      /^narration_generation_plan\.json$/,
      /^qwen_generation_plan\.json$/,
      /^audio_performance_plan\.json$/,
      /^voice_direction_strategy_.*\.json$/,
      /^voice_reference_completeness_report\.json$/,
    ],
    commands: ["voice plan", "run import-proof-baseline"],
  },
  {
    id: "qwen_tts_stitch",
    title: "Narration TTS and stitch",
    required_input: "voice plan + approved spoken text",
    output_artifact: "narration_tts_report_<episode>.json + stitched narration",
    approval: "automatic",
    validator: "narration_report_audio_qa_hashes",
    depends_on: ["voice_plan"],
    output_patterns: [
      /^narration_tts_pre_synthesis_gate_.*\.json$/,
      /^narration_tts_report_.*\.json$/,
      /^narration_tts_unit_qa_.*\.json$/,
      /^narration_full_stream_qa_.*\.json$/,
      /^modelslab_qwen_tts_report_.*\.json$/,
      /^qwen_tts_unit_qa_.*\.json$/,
      /^audio_stitch_report_.*\.json$/,
      /^narration_source_structure_.*\.json$/,
      /^narration_low_margin_disposition_.*\.json$/,
    ],
    commands: [
      "tts narrate",
      "tts import-provider",
      "tts finalize-provider",
      "tts repair-boundary",
      "tts approve-listen",
      "tts source-structure",
      "tts low-margin-disposition",
      "tts qwen",
    ],
  },
  {
    id: "local_whisper_word_timing",
    title: "Whisper word timing",
    required_input: "final stitched narration",
    output_artifact: "narration_word_timing_<episode>.json",
    approval: "automatic",
    validator: "whisper_contract_script_audio_hashes",
    depends_on: ["qwen_tts_stitch"],
    output_patterns: [
      /^narration_word_timing_.*\.json$/,
    ],
    commands: ["audio whisper-timing"],
  },
  {
    id: "audio_pace_check",
    title: "Actual narration pace",
    required_input: "local Whisper word timing",
    output_artifact: "narration_pace_report_<episode>.json",
    approval: "automatic",
    validator: "audio_pace_hash_and_policy",
    depends_on: ["local_whisper_word_timing"],
    output_patterns: [
      /^narration_pace_report_.*\.json$/,
    ],
    commands: ["audio pace-check", "audio tempo-normalize"],
  },
  {
    id: "timing_bind",
    title: "Semantic timing bind",
    required_input: "semantic plan + local Whisper timing",
    output_artifact: "timed_scene_plan.json",
    approval: "automatic",
    validator: "timed_scene_source_hashes",
    depends_on: ["semantic_scene_plan", "audio_pace_check"],
    commands: ["timing bind"],
  },
  {
    id: "sfx_score_plan",
    title: "Optional audio design",
    required_input: "local Whisper timing + timed scenes",
    output_artifact: "sfx_event_plan_<episode>.json + score_drop_plan_<episode>.json",
    approval: "automatic",
    validator: "audio_design_plan",
    skip: "audio_target_narrator_only",
    commands: ["audio enrich-sfx-score", "audio score-drops-chunked", "audio repair-ambience"],
  },
  {
    id: "longform_audio_mix",
    title: "Continuous longform audio",
    required_input: "stitched narration and selected audio design policy",
    output_artifact: "longform_audio_bed_report_*.json + final mix",
    approval: "automatic",
    validator: "longform_mix_hashes_and_loudness",
    commands: ["audio longform-bed"],
  },
  {
    id: "visual_beat_plan",
    title: "Editorial beat direction",
    required_input: "script + Whisper timing + story facts",
    output_artifact: "visual_beat_plan.json + visual_beat_approval.json",
    approval: "operator_or_agent",
    validator: "beat_coverage_state_and_lock",
    commands: ["visual beats", "visual repair-beats"],
  },
  {
    id: "visual_reference_plan",
    title: "Reference Director plan",
    required_input: "approved editorial beats + story facts",
    output_artifact: "reference_inventory_ledger.json + visual_reference_plan.json",
    approval: "automatic",
    validator: "reference_plan_hashes",
    commands: ["visual refs"],
  },
  {
    id: "reference_plan_approval",
    title: "Reference plan approval",
    required_input: "visual_reference_plan.json",
    output_artifact: "reference_plan_approval.json",
    approval: "operator_or_agent",
    validator: "reference_plan_approval_hash",
    commands: ["visual approve-ref-plan"],
  },
  {
    id: "reference_generation",
    title: "Reference generation",
    required_input: "approved reference plan",
    output_artifact: "immutable reference batch reports + assets/images/references/*",
    approval: "automatic",
    validator: "reference_batch_completeness",
    commands: ["imagegen browser-pool:references", "imagegen start:references", "imagegen codex-work:references", "imagegen import-staged-codex:references"],
  },
  {
    id: "reference_image_approval",
    title: "Generated reference approval",
    required_input: "generated reference images",
    output_artifact: "visual_reference_approval.json + approved reference state",
    approval: "operator_or_agent",
    validator: "reference_image_approval_hashes",
    commands: ["visual approve-refs"],
  },
  {
    id: "visual_prompt_plan",
    title: "Provider-aware prompt authoring",
    required_input: "approved beats + approved refs",
    output_artifact: "section_image_prompts.json",
    approval: "automatic",
    validator: "prompt_plan_source_hashes",
    output_patterns: [
      /^section_image_prompts\.json$/,
      /^planner_chunk_ledger\.json$/,
    ],
    commands: ["visual plan"],
  },
  {
    id: "visual_prompt_harden",
    title: "Prompt structural hardening",
    required_input: "section_image_prompts.json",
    output_artifact: "section_image_prompts_hardened.json + visual_prompt_hardening_<episode>.json",
    approval: "automatic",
    validator: "hardened_prompt_contract",
    output_patterns: [
      /^section_image_prompts_hardened\.json$/,
      /^visual_prompt_hardening_.*\.json$/,
      /^visual_prompt_hardening_sample_.*\.md$/,
    ],
    commands: ["visual harden"],
  },
  {
    id: "visual_prompt_blocker_repair",
    title: "Conditional blocker repair",
    required_input: "blocked hardening report",
    output_artifact: "scoped reviewed prompts or deadletter",
    approval: "automatic",
    validator: "prompt_blocker_resolution",
    skip: "harden_has_no_blockers",
    commands: ["visual review"],
  },
  {
    id: "transition_edit_plan",
    title: "Transition edit plan",
    required_input: "hardened prompt plan",
    output_artifact: "transition_edit_plan_<episode>.json",
    approval: "automatic",
    validator: "transition_plan_hashes",
    output_patterns: [
      /^transition_edit_plan_.*\.json$/,
    ],
    commands: ["visual transitions", "visual engagement"],
  },
  {
    id: "image_generation",
    title: "Scene image generation",
    required_input: "hardened prompt plan + approved refs",
    output_artifact: "immutable image batches + cut_execution_ledger.json",
    approval: "automatic",
    validator: "episode_image_manifest",
    commands: ["imagegen browser-pool", "imagegen start", "imagegen codex-work", "imagegen import-codex", "imagegen import-staged-codex"],
  },
  {
    id: "image_focal_analysis",
    title: "Image focal and composition analysis",
    required_input: "generated images + hardened prompts",
    output_artifact: "image_focal_analysis_<episode>.json",
    approval: "automatic",
    validator: "image_hash_bound_focal_analysis",
    commands: ["imagegen analyze"],
  },
  {
    id: "image_output_qa",
    title: "Per-cut image QA",
    required_input: "generated images + immutable cut hashes",
    output_artifact: "image_output_qa_<episode>.json + image_output_review_decisions_<episode>.json",
    approval: "risk_cut_decisions",
    validator: "per_cut_image_decisions",
    commands: ["imagegen qa"],
  },
  {
    id: "animation_direction_plan",
    title: "Image-aware animation direction",
    required_input: "beat-authored animation intent + accepted image hashes + hardened prompts",
    output_artifact: "animation_direction_plan_<episode>.json",
    approval: "automatic",
    validator: "animation_direction_hashes_timing_and_scene_continuity",
    skip: "animation_policy_disabled",
    commands: ["visual animation-plan"],
  },
  {
    id: "generated_video_motion",
    title: "Hash-bound generated motion",
    required_input: "accepted image hashes + hardened prompts",
    output_artifact: "assets/motion/generated/generated_motion_report_<episode>.json + normalized clips (legacy LTX adapter accepted)",
    approval: "automatic",
    validator: "generated_motion_clip_hashes_provider_receipts_and_source_images",
    skip: "generated_motion_policy_disabled",
    commands: ["visual generated-motion", "visual ltx-video"],
  },
  {
    id: "generated_video_motion_approval",
    title: "Generated motion approval",
    required_input: "hash-bound generated clips + contact sheet",
    output_artifact: "assets/motion/generated/generated_motion_approval_<episode>.json (legacy LTX adapter accepted)",
    approval: "operator_or_agent",
    validator: "generated_motion_per_clip_decisions",
    skip: "generated_motion_policy_disabled",
    commands: ["visual approve-generated-motion", "visual approve-ltx-video"],
  },
  {
    id: "parallax_asset_generation",
    title: "Selective parallax assets",
    required_input: "accepted image hashes + LLM-authored depth candidates",
    output_artifact: "parallax_asset_report_<episode>.json + assets/motion/parallax/*",
    approval: "automatic",
    validator: "parallax_assets_hashes_and_candidate_scope",
    skip: "parallax_policy_disabled_or_legacy",
    commands: ["visual parallax-assets"],
  },
  {
    id: "parallax_asset_approval",
    title: "Parallax asset approval",
    required_input: "hash-bound parallax layers + review sheet",
    output_artifact: "parallax_asset_approval_<episode>.json when candidates exist; otherwise automatic still fallback",
    approval: "operator_or_agent",
    validator: "parallax_asset_decisions_and_hashes",
    skip: "parallax_policy_disabled_or_legacy",
    commands: ["visual approve-parallax"],
  },
  {
    id: "motion_edit_plan",
    title: "Directed motion plan",
    required_input: "accepted image hashes + authored staging + parallax decisions",
    output_artifact: "motion_edit_plan_<episode>.json",
    approval: "automatic",
    validator: "motion_plan_hashes_and_geometry",
    commands: ["visual motion-plan"],
  },
  {
    id: "premium_render",
    title: "Premium smooth render",
    required_input: "accepted images + motion/transition plans + continuous audio",
    output_artifact: "render_report_<episode>*.json + final MP4",
    approval: "automatic",
    validator: "render_hashes_and_timeline",
    commands: ["render start"],
  },
  {
    id: "final_qa",
    title: "Final QA",
    required_input: "render report + final MP4",
    output_artifact: "final_qa_<episode>.json",
    approval: "operator_or_agent",
    validator: "final_qa_status_and_hashes",
    commands: ["final qa"],
  },
  {
    id: "upload_packaging",
    title: "Upload packaging",
    required_input: "passed final QA + story truth",
    output_artifact: "upload_packaging_<episode>.md + youtube_packaging_spec_<episode>.json + final thumbnail",
    approval: "operator",
    validator: "approved_ctr_packaging_and_thumbnail_contract",
    commands: ["youtube approve-packaging"],
  },
  {
    id: "youtube_publish_readiness",
    title: "YouTube publish readiness",
    required_input: "approved upload package + final QA + final video",
    output_artifact: "youtube_publish_manifest_<episode>.json",
    approval: "automatic",
    validator: "youtube_publish_manifest_source_hashes",
    commands: ["youtube prepare"],
  },
  {
    id: "youtube_studio_upload",
    title: "YouTube Studio upload",
    required_input: "current YouTube publish manifest + authenticated Studio session",
    output_artifact: "youtube_upload_receipt_<episode>.json + optional required youtube_native_ab_receipt_<episode>.json",
    approval: "operator",
    validator: "youtube_upload_receipt_and_field_verification",
    commands: ["youtube record-upload", "youtube record-ab-test"],
  },
  {
    id: "youtube_pinned_comment",
    title: "YouTube pinned comment",
    required_input: "passed upload receipt + explicit comment approval",
    output_artifact: "youtube_pinned_comment_receipt_<episode>.json",
    approval: "operator",
    validator: "youtube_pinned_comment_receipt_hash",
    commands: ["youtube record-schedule", "youtube record-comment"],
  },
];

export const PIPELINE_STAGE_REGISTRY = Object.freeze(stages.map((entry, index) => Object.freeze({
  ...entry,
  order: index,
  dependencies: Object.freeze(entry.depends_on ?? (index === 0 ? [] : [stages[index - 1].id])),
  output_patterns: Object.freeze(entry.output_patterns ?? []),
  artifact_contract: Object.freeze({
    output: entry.output_artifact,
    validator: entry.validator,
  }),
})));

const stagesById = new Map(PIPELINE_STAGE_REGISTRY.map((entry) => [entry.id, entry]));

// The legacy export remains byte-for-byte the generated-visual stage chain.
// Other workflows must supply a real registry and validators before dispatch.
export function stageRegistryFor(identity = {}) {
  const workflow = assertAvailableMediaWorkflow(identity);
  if (workflow.id === "avatar_footage_pilot_v1") return AVATAR_PILOT_STAGES;
  return PIPELINE_STAGE_REGISTRY;
}

export function stageDefinition(stageId, identity = {}) {
  const registry = stageRegistryFor(identity);
  return registry === PIPELINE_STAGE_REGISTRY ? stagesById.get(stageId) ?? null : registry.find((entry) => entry.id === stageId) ?? null;
}

export function assertStageState(value) {
  if (!STAGE_STATES.includes(value)) throw new Error(`Unknown Goldflow stage state: ${value}`);
  return value;
}

export function stageIsSatisfied(state) {
  return state === "passed" || state === "skipped_with_waiver";
}

export function commandStageFor(commandName, subcommandName, flags = {}, identity = {}) {
  const registry = stageRegistryFor(identity);
  const key = `${commandName} ${subcommandName}`.trim();
  if (registry === PIPELINE_STAGE_REGISTRY && key === "visual openart-bank") {
    return ({ plan: "visual_reference_plan", "revise-plan": "reference_generation", "approve-plan": "reference_plan_approval", "approve-refs": "reference_image_approval", "bind-shots": "visual_prompt_plan", harden: "visual_prompt_harden" })[String(flags.action ?? "")] ?? null;
  }
  if (registry === PIPELINE_STAGE_REGISTRY && key === "imagegen openart") {
    if (!["generate", "review", "prepare", "mark-submitted", "import", "sync-library", "triage", "fail"].includes(String(flags.action ?? ""))) return null;
    return /^(true|1|yes)$/i.test(String(flags["references-only"] ?? "")) ? "reference_generation" : "image_generation";
  }
  if (registry === PIPELINE_STAGE_REGISTRY && key === "imagegen fal") {
    if (["repair-reviewed-bulk", "observe-reviewed-bulk", "finalize-reviewed-bulk"].includes(String(flags.action ?? ""))) return "image_output_qa";
    if (identity.visual_restart?.fork_at === "visual_reference_plan") {
      if (["repair-reviewed-references", "observe-reviewed-references", "finalize-reviewed-references"].includes(String(flags.action ?? ""))) return "reference_image_approval";
      return ["prepare-references", "billing-submit-reference", "billing-observe-reference", "dispatch-references", "observe-references", "repair-reference-failures", "observe-reference-repairs", "finalize-references"].includes(String(flags.action ?? ""))
        ? "reference_generation" : "image_generation";
    }
    return ["prepare-validation", "billing-submit", "billing-observe", "dispatch-validation", "observe-validation", "review-validation"].includes(String(flags.action ?? ""))
      ? "reference_image_approval" : "image_generation";
  }
  if (registry === PIPELINE_STAGE_REGISTRY && (key === "imagegen start" || key === "imagegen codex-work" || key === "imagegen browser-pool" || key === "imagegen import-codex" || key === "imagegen import-staged-codex")) {
    if (/^(true|1|yes)$/i.test(String(flags["references-only"] ?? ""))) return "reference_generation";
    if (/^(true|1|yes)$/i.test(String(flags["qa-recovery"] ?? ""))) return "image_output_qa";
  }
  if (registry === PIPELINE_STAGE_REGISTRY && key === "imagegen promote-derived-refs") return "image_generation";
  for (const entry of registry) {
    if (entry.commands.includes(key)) return entry.id;
  }
  return null;
}

export function stageChecklistFor(identity = {}) {
  const registry = stageRegistryFor(identity);
  const narratorOnly = String(identity.audio_target ?? "narrator_only") === "narrator_only";
  const parallaxDisabled = String(identity.parallax_policy ?? "selective_inspected") !== "selective_inspected";
  const ltxDisabled = !generatedMotionEnabled(identity);
  return registry.map((entry) => ({
    stage: entry.id,
    status: entry.id === "sfx_score_plan" && narratorOnly
      ? "skipped_with_waiver"
      : ["animation_direction_plan", "generated_video_motion", "generated_video_motion_approval"].includes(entry.id) && ltxDisabled
        ? "skipped_with_waiver"
      : ["parallax_asset_generation", "parallax_asset_approval"].includes(entry.id) && parallaxDisabled
        ? "skipped_with_waiver"
        : "missing",
    approval_policy: entry.approval,
    validator: entry.validator,
  }));
}

export function workflowStageIds(identity = {}) {
  return stageRegistryFor(identity).map((entry) => entry.id);
}

export function stageOutputPathMatches(stageId, relativePath) {
  const definition = stageDefinition(stageId);
  if (!definition?.output_patterns?.length) return true;
  return definition.output_patterns.some((pattern) => pattern.test(String(relativePath ?? "")));
}

export function readyStageIds(stageRows = [], identity = {}) {
  const byId = new Map(stageRows.map((row) => [row.stage, row]));
  return stageRegistryFor(identity)
    .filter((definition) => {
      const row = byId.get(definition.id);
      if (!row || stageIsSatisfied(row.state)) return false;
      if (!["missing", "stale"].includes(String(row.state ?? ""))) return false;
      return definition.dependencies.every((dependencyId) => {
        const dependency = byId.get(dependencyId);
        return dependency && stageIsSatisfied(dependency.state);
      });
    })
    .map((definition) => definition.id);
}

export function workflowCommandSummary() {
  return PIPELINE_STAGE_REGISTRY
    .filter((entry) => entry.commands.length)
    .map((entry) => `${entry.id}: ${entry.commands.join(" | ")}`)
    .join("\n");
}

export function helpCommandLines() {
  return PIPELINE_STAGE_REGISTRY.flatMap((entry) => entry.commands
    .filter((command) => !command.includes(":"))
    .map((command) => `  goldflow ${command.padEnd(30)} ${entry.title}`));
}

export function productionOrderSummary() {
  return PIPELINE_STAGE_REGISTRY
    .map((entry) => {
      const command = entry.commands.find((value) => !value.includes(":"));
      if (command) return command;
      return `[${entry.id}]`;
    })
    .join(" -> ");
}

function identityBase(identity = {}) {
  return `--channel ${identity.channel ?? "<channel>"} --series ${identity.series_slug ?? "<series>"} --week ${identity.week ?? "<week>"} --episode ${identity.episode ?? "<episode>"}`;
}

function narratorOnly(identity = {}) {
  return String(identity.audio_target ?? "narrator_only") === "narrator_only";
}

function narrationDuckingFlags(identity = {}) {
  if (identity.content_profile !== "asset_afterlife_v1") return "";
  return " --score-bed-trim-db -3.5 --score-bed-level-mode fixed_ducked --score-bed-fixed-duck-db -16.23";
}

function codexOpeningFlag(identity = {}) {
  const seconds = Number(identity.image_provider_options?.codex_opening_sec ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? ` --codex-opening-sec ${seconds}` : "";
}

function boundedProofScopeFlag(identity = {}) {
  const scope = identity?.proof_scope;
  if (scope?.mode !== "bounded" || !Number.isFinite(Number(scope.start_sec)) || !Number.isFinite(Number(scope.end_sec))) return "";
  return ` --scope-start-sec ${Number(scope.start_sec)} --scope-end-sec ${Number(scope.end_sec)}`;
}

function visualBeatTimingFlags(identity = {}) {
  const contract = identity.visual_beat_timing_contract
    ?? identity.provider_locks?.visual_beat_timing_contract
    ?? null;
  if (!contract) return "";
  const enforcement = String(contract.enforcement ?? "").trim();
  const fields = [
    ["target-beat-sec", contract.target_beat_sec],
    ["max-beat-sec", contract.max_beat_sec],
    ["min-beat-sec", contract.min_beat_sec],
    ["hook-duration-sec", contract.hook_duration_sec],
    ["hook-target-beat-sec", contract.hook_target_beat_sec],
    ["hook-max-beat-sec", contract.hook_max_beat_sec],
    ["hook-min-beat-sec", contract.hook_min_beat_sec],
    ["retention-ramp-sec", contract.retention_ramp_sec],
    ["ramp-target-beat-sec", contract.ramp_target_beat_sec],
    ["ramp-max-beat-sec", contract.ramp_max_beat_sec],
    ["ramp-min-beat-sec", contract.ramp_min_beat_sec],
  ];
  const numericFlags = fields
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([flag, value]) => ` --${flag} ${Number(value)}`)
    .join("");
  return `${enforcement ? ` --beat-timing-enforcement ${enforcement}` : ""}${numericFlags}`;
}

function codexReferences(identity = {}) {
  return new Set([
    "codex",
    "codex_imagegen",
    "hybrid_codex_refs_multichar",
    "hybrid_codex_opening_modelslab_rest",
    "hybrid_codex_refs_opening_risky_modelslab_rest",
  ]).has(String(identity.image_provider ?? ""));
}

function codexSceneCuts(identity = {}) {
  return new Set([
    "codex",
    "codex_imagegen",
    "hybrid_codex_refs_multichar",
    "hybrid_codex_opening_modelslab_rest",
    "hybrid_codex_refs_opening_risky_modelslab_rest",
    "hybrid_modelslab_refs_codex_opening_modelslab_rest",
  ]).has(String(identity.image_provider ?? ""));
}

export function buildStageCommand(stageId, identity = {}, options = {}) {
  stageRegistryFor(identity);
  const base = identityBase(identity);
  const episode = identity.episode ?? "<episode>";
  const provider = identity.image_provider ?? "modelslab";
  const hybridBrowserPool = isBrowserPoolImageProvider(provider);
  const imageModel = identity?.model_versions?.image_model ?? identity?.provider_locks?.image_model ?? "flux-klein";
  const referenceModel = identity?.model_versions?.reference_model ?? identity?.provider_locks?.reference_model ?? imageModel;
  const renderProfile = identity.render_profile ?? "smooth_subpixel_ken_burns";
  const minWpm = Number(identity.target_wpm_min ?? 195);
  const maxWpm = Number(identity.target_wpm_max ?? 220);
  const ttsPolicy = narrationTtsPolicyForIdentity(identity);
  const nativeSpeed = Number(ttsPolicy.primary.native_speed);
  const pacePolicy = "diagnostic";
  const paceFlag = " --pace-policy diagnostic";
  const productionProfile = productionProfileForIdentity(identity);
  const planner = productionProfile.planner;
  const webPlanning = planningProviderForIdentity(identity, { missingIsLegacy: true }) === "chatgpt_web";
  const semanticConcurrency = plannerConcurrencyForIdentity(
    identity,
    webPlanning ? planner.chatgpt_web_semantic_concurrency ?? planner.semantic_concurrency : planner.semantic_concurrency,
  );
  const editorialConcurrency = plannerConcurrencyForIdentity(
    identity,
    webPlanning ? planner.chatgpt_web_editorial_concurrency ?? planner.editorial_concurrency : planner.editorial_concurrency,
  );
  const referenceConcurrency = plannerConcurrencyForIdentity(
    identity,
    webPlanning ? planner.chatgpt_web_visual_ref_chunk_concurrency ?? planner.visual_ref_chunk_concurrency : planner.visual_ref_chunk_concurrency,
  );
  const visualPromptConcurrency = plannerConcurrencyForIdentity(
    identity,
    webPlanning ? planner.chatgpt_web_visual_chunk_concurrency ?? planner.visual_chunk_concurrency : planner.visual_chunk_concurrency,
    { visualPromptWavefront: true },
  );
  const media = productionProfile.media;
  const orchestration = productionProfile.orchestration ?? {};
  const chatGptWebImages = provider === "chatgpt_web_gpt_image";
  const explicitChatGptImageConcurrency = Number(media.chatgpt_web_image_concurrency) > 0
    ? media.chatgpt_web_image_concurrency
    : media.chatgpt_web_image_fallback_concurrency ?? media.image_concurrency;
  const explicitChatGptReferenceConcurrency = Number(media.chatgpt_web_reference_concurrency) > 0
    ? media.chatgpt_web_reference_concurrency
    : media.chatgpt_web_image_fallback_concurrency ?? media.reference_concurrency;
  const imageConcurrency = chatGptWebImages
    ? explicitChatGptImageConcurrency
    : media.image_concurrency;
  const referenceMediaConcurrency = chatGptWebImages
    ? explicitChatGptReferenceConcurrency
    : media.reference_concurrency;
  const render = productionProfile.render;
  const narrationConcurrency = ttsPolicy.primary?.provider === "qwen_local"
    ? media.local_qwen_tts_concurrency
      ?? media.qwen_tts_concurrency
      ?? media.tts_concurrency
      ?? 1
    : media.kokoro_tts_concurrency ?? media.tts_concurrency ?? 1;
  const localWhisperFlags = localWhisperCommandFlags(
    localWhisperContractForIdentity(identity),
  );
  const commands = {
    run_identity: `node bin/goldflow.mjs run preflight ${base} --content-profile ${identity.content_profile ?? "<content-profile>"} --media-workflow generated_visuals_v1 --title "<episode-title>" --source <source.md> --planning-provider planning_room --planning-effort-policy planning_room_stage_routed_v1 --image-provider federated_google_web_image_pool --audio-target narrator_only`,
    source_ingest: `node bin/goldflow.mjs ingest source ${base} --source <source.md>`,
    script_approval: `node bin/goldflow.mjs script approve ${base} --hash <script_clean_hash>`,
    script_pace_check: `node bin/goldflow.mjs script pace-check ${base} --target-wpm-min ${minWpm} --target-wpm-max ${maxWpm}${paceFlag}${pacePolicy === "diagnostic" ? " --allow-hook-warnings true" : ""}`,
    targeted_speakability: `node bin/goldflow.mjs script targeted ${base}`,
    semantic_scene_plan: identity?.proof_scope?.mode === "bounded"
      && identity?.proof_source_mode !== "standalone_bounded_source"
      ? `node bin/goldflow.mjs semantic plan ${base} --concurrency ${semanticConcurrency} --semantic-json-attempts 1 --semantic-chunk-validation-attempts 1 --semantic-reconciliation-attempts 1 --proof-baseline-word-timing <audited-baseline-word-timing.json>${boundedProofScopeFlag(identity)}`
      : `node bin/goldflow.mjs semantic plan ${base} --concurrency ${semanticConcurrency} --semantic-json-attempts 1 --semantic-chunk-validation-attempts 1 --semantic-reconciliation-attempts 1`,
    voice_plan: `node bin/goldflow.mjs voice plan ${base}`,
    // The stage id is retained for historical manifests; the stage itself is
    // provider-neutral for every quality-V2 run.
    qwen_tts_stitch: isLegacyQwenIdentity(identity)
      ? `node bin/goldflow.mjs tts qwen ${base} --native-speed ${nativeSpeed} --concurrency ${media.qwen_tts_concurrency}`
      : ["fish_audio", "elevenlabs", "generic_tts"].includes(
        ttsPolicy.primary?.provider,
      )
        ? `node bin/goldflow.mjs tts import-provider ${base} --results <provider-results.json>`
        : `node bin/goldflow.mjs tts narrate ${base} --concurrency ${narrationConcurrency} --batch-size ${ttsPolicy.synthesis_contract?.nominal_batch_size ?? 1}`,
    local_whisper_word_timing:
      `node bin/goldflow.mjs audio whisper-timing ${base} `
      + localWhisperFlags,
    audio_pace_check: `node bin/goldflow.mjs audio pace-check ${base} --target-wpm-min ${minWpm} --target-wpm-max ${maxWpm}${paceFlag}`,
    timing_bind: `node bin/goldflow.mjs timing bind ${base}`,
    sfx_score_plan: narratorOnly(identity)
      ? "skipped with waiver because run_identity.audio_target is narrator_only"
      : `node bin/goldflow.mjs audio enrich-sfx-score ${base} --score-mode drops_only`,
    longform_audio_mix: narratorOnly(identity)
      ? `node bin/goldflow.mjs audio longform-bed ${base} --narration-only true --narration-volume-db 0 --target-lufs -16 --true-peak-db -1.5`
      : `node bin/goldflow.mjs audio longform-bed ${base} --narration-volume-db 3 --target-lufs -13 --true-peak-db -1${narrationDuckingFlags(identity)}`,
    visual_beat_plan: `node bin/goldflow.mjs visual beats ${base} --editorial-concurrency ${editorialConcurrency} --editorial-attempts 1${visualBeatTimingFlags(identity)}${boundedProofScopeFlag(identity)}`,
    visual_reference_plan: `node bin/goldflow.mjs visual refs ${base} --visual-ref-chunk-concurrency ${referenceConcurrency} --visual-ref-json-attempts 1 --visual-ref-merge-validation-attempts 1`,
    reference_plan_approval: `node bin/goldflow.mjs visual approve-ref-plan ${base} --note "<reference plan review notes>"`,
    reference_generation: hybridBrowserPool
      ? `node bin/goldflow.mjs imagegen browser-pool ${base} --references-only true`
      : codexReferences(identity)
      ? `node bin/goldflow.mjs imagegen codex-work ${base} --action create --references-only true --reference-ids <ref_ids> --max-attempts 1 --lease-sec 900`
      : `node bin/goldflow.mjs imagegen start ${base} --image-provider ${provider} --reference-image-model ${referenceModel} --references-only true --reference-concurrency ${referenceMediaConcurrency}`,
    reference_image_approval: `node bin/goldflow.mjs visual approve-refs ${base} --cleanliness-reviewed true --note "<generated reference review notes>"`,
    visual_prompt_plan: `node bin/goldflow.mjs visual plan ${base} --visual-chunk-concurrency ${visualPromptConcurrency} --visual-json-attempts 1 --codex-call-attempts 1 --visual-chunk-validation-attempts ${planner.chunk_validation_attempts}`,
    visual_prompt_harden: `node bin/goldflow.mjs visual harden ${base} --prompts <episode-dir>/section_image_prompts.json`,
    visual_prompt_blocker_repair: `node bin/goldflow.mjs visual review ${base} --blockers-only true --auto-resolve true --max-resolve-iterations 1 --visual-review-chunk-attempts 1 --visual-chunk-concurrency ${visualPromptConcurrency}`,
    transition_edit_plan: `node bin/goldflow.mjs visual transitions ${base} --prompts <episode-dir>/section_image_prompts_hardened.json${narratorOnly(identity) ? " --transition-sfx false" : ""}`,
    image_generation: hybridBrowserPool
      ? `node bin/goldflow.mjs imagegen browser-pool ${base}`
      : codexSceneCuts(identity)
      ? `node bin/goldflow.mjs imagegen codex-work ${base} --action create --prompts <episode-dir>/section_image_prompts_hardened.json --image-ids <codex_cut_ids> --max-attempts 1 --lease-sec 900; after the validated Codex manifest is imported, run the ModelsLab remainder when this is a hybrid lane: node bin/goldflow.mjs imagegen start ${base}${codexOpeningFlag(identity)} --image-provider ${provider} --image-model ${imageModel} --provider-filter modelslab --skip-reference-generation true --concurrency ${media.image_concurrency} --output <episode-dir>/imagegen_report_${episode}.json`
      : `node bin/goldflow.mjs imagegen start ${base} --image-provider ${provider} --image-model ${imageModel} --prompts <episode-dir>/section_image_prompts_hardened.json --skip-reference-generation true --concurrency ${imageConcurrency} --reference-concurrency ${referenceMediaConcurrency}`,
    image_focal_analysis: `node bin/goldflow.mjs imagegen analyze ${base} --concurrency ${media.focal_analysis_concurrency}`,
    image_output_qa: `node bin/goldflow.mjs imagegen qa ${base} --semantic-audit true --semantic-audit-concurrency 8 --semantic-audit-model gpt-6-sol --semantic-audit-effort medium`,
    animation_direction_plan: `node bin/goldflow.mjs visual animation-plan ${base}`,
    generated_video_motion: `node bin/goldflow.mjs visual generated-motion ${base} --concurrency ${media.generated_motion_concurrency ?? 3}${(orchestration.generated_motion_coherence_prefetch ?? orchestration.incremental_generated_motion_prefetch) === true ? " --prefetch-coherence-cache true" : ""}`,
    generated_video_motion_approval: `node bin/goldflow.mjs visual approve-generated-motion ${base} --reviewer <name> --note "<clip review notes>" --approve-ids <ids> --reject-ids <ids>`,
    parallax_asset_generation: `node bin/goldflow.mjs visual parallax-assets ${base}`,
    parallax_asset_approval: `node bin/goldflow.mjs visual approve-parallax ${base} --reviewer <name> --note "<mask and layer review notes>" --approve-ids <ids> --decline-ids <ids>`,
    motion_edit_plan: `node bin/goldflow.mjs visual motion-plan ${base}`,
    premium_render: `node bin/goldflow.mjs render start ${base} --motion-plan <episode-dir>/motion_edit_plan_${episode}.json --motion ${renderProfile} --render-concurrency ${render.render_concurrency} --clip-preset ${render.clip_preset} --final-preset ${render.final_preset}${identity?.proof_scope?.mode === "bounded" ? ` --diagnostic-proof true --proof-scope-end-sec ${Number(identity.proof_scope.end_sec)}` : ""}`,
    final_qa: `node bin/goldflow.mjs final qa ${base} --master-scan true --approve true --reviewed-finding-codes <comma_separated_codes_if_any> --note "<QA review notes>"`,
    upload_packaging: `node bin/goldflow.mjs youtube approve-packaging ${base} --approve true --approved-by <name> --note "<packaging review notes>"`,
    youtube_publish_readiness: `node bin/goldflow.mjs youtube prepare ${base}`,
    youtube_studio_upload: `Use the youtube-studio-publish browser skill, upload privately first, verify every field, then run node bin/goldflow.mjs youtube record-upload ${base} --video-id <id> --watch-url <url> --visibility <private|unlisted|public|scheduled> --channel-verified true --initial-private-verified true --title-verified true --description-verified true --thumbnail-verified true --audience-verified true --monetization-verified true --mid-rolls-verified true --comments-verified true --checks-complete true --recorded-by <name>`,
    youtube_pinned_comment: `For an explicitly approved scheduled release, verify Studio and run node bin/goldflow.mjs youtube record-schedule ${base} --video-id <id> --schedule-at <ISO-timestamp> --time-zone <zone> --publish-approved true --publish-approved-by <name> --channel-verified true --schedule-verified true --existing-fields-verified true --checks-complete true --recorded-by <name>; after explicit comment approval, pin the exact manifest comment and run node bin/goldflow.mjs youtube record-comment ${base} --comment-id <id> --text-verified true --post-approved true --post-approved-by <name> --pinned-verified true --recorded-by <name>`,
  };
  if (identity.image_provider === "openart_cli") {
    const lockedOpenArtConcurrency = Number(identity.image_provider_options?.openart?.concurrency ?? identity.openart_contract?.concurrency ?? 1);
    const referenceWorkers = Number.isInteger(lockedOpenArtConcurrency) && lockedOpenArtConcurrency > 0 ? Math.min(4, lockedOpenArtConcurrency) : 1;
    Object.assign(commands, {
      visual_reference_plan: `node bin/goldflow.mjs visual openart-bank ${base} --action plan --catalog <canonical-catalog.json>`,
      reference_plan_approval: `node bin/goldflow.mjs visual openart-bank ${base} --action approve-plan --reviewer <name> --note "<reference plan review>"`,
      reference_generation: `node bin/goldflow.mjs imagegen openart ${base} --references-only true --action prepare-ready --max-workers ${referenceWorkers}`,
      reference_image_approval: `node bin/goldflow.mjs visual openart-bank ${base} --action approve-refs --reviewer <name> --note "<completed visual review>"`,
      visual_prompt_plan: `node bin/goldflow.mjs visual openart-bank ${base} --action bind-shots --shot-plan <shot-plan.json>`,
      visual_prompt_harden: `node bin/goldflow.mjs visual openart-bank ${base} --action harden`,
      image_generation: `node bin/goldflow.mjs imagegen openart ${base} --action prepare --image-ids <next_exact_image_ids>`,
    });
  }
  if (identity.image_provider === "fal_ai") {
    Object.assign(commands, {
      ...(identity.visual_restart?.fork_at === "visual_reference_plan" ? {
        reference_generation: `node bin/goldflow.mjs imagegen fal ${base} --action prepare-references`,
        image_generation: `node bin/goldflow.mjs imagegen fal ${base} --action prepare-validation`,
      } : {
        reference_image_approval: `node bin/goldflow.mjs imagegen fal ${base} --action prepare-validation`,
        image_generation: `node bin/goldflow.mjs imagegen fal ${base} --action prepare-bulk --image-ids all`,
      }),
    });
  }
  return options.override ?? commands[stageId] ?? null;
}
