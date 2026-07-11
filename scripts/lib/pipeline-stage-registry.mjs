export const PIPELINE_STAGE_REGISTRY_VERSION = "2026-07-11.1";

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
    commands: ["run preflight"],
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
    commands: ["semantic plan"],
  },
  {
    id: "voice_plan",
    title: "Narrator voice plan",
    required_input: "speakability report + overrides",
    output_artifact: "qwen_generation_plan.json",
    approval: "automatic",
    validator: "voice_plan_hashes",
    commands: ["voice plan"],
  },
  {
    id: "qwen_tts_stitch",
    title: "Qwen TTS and stitch",
    required_input: "voice plan + approved spoken text",
    output_artifact: "modelslab_qwen_tts_report_<episode>.json + stitched narration",
    approval: "automatic",
    validator: "qwen_report_audio_hashes",
    commands: ["tts qwen"],
  },
  {
    id: "local_whisper_word_timing",
    title: "Whisper word timing",
    required_input: "final stitched narration",
    output_artifact: "narration_word_timing_<episode>.json",
    approval: "automatic",
    validator: "whisper_audio_hash",
    commands: ["audio whisper-timing"],
  },
  {
    id: "audio_pace_check",
    title: "Actual narration pace",
    required_input: "local Whisper word timing",
    output_artifact: "narration_pace_report_<episode>.json",
    approval: "automatic",
    validator: "audio_pace_hash_and_policy",
    commands: ["audio pace-check", "audio tempo-normalize"],
  },
  {
    id: "timing_bind",
    title: "Semantic timing bind",
    required_input: "semantic plan + local Whisper timing",
    output_artifact: "timed_scene_plan.json",
    approval: "automatic",
    validator: "timed_scene_source_hashes",
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
    commands: ["visual beats"],
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
    commands: ["imagegen start:references", "imagegen import-staged-codex:references"],
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
    commands: ["visual plan"],
  },
  {
    id: "visual_prompt_harden",
    title: "Prompt structural hardening",
    required_input: "section_image_prompts.json",
    output_artifact: "section_image_prompts_hardened.json + visual_prompt_hardening_<episode>.json",
    approval: "automatic",
    validator: "hardened_prompt_contract",
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
    commands: ["visual transitions", "visual engagement"],
  },
  {
    id: "image_generation",
    title: "Scene image generation",
    required_input: "hardened prompt plan + approved refs",
    output_artifact: "immutable image batches + cut_execution_ledger.json",
    approval: "automatic",
    validator: "episode_image_manifest",
    commands: ["imagegen start", "imagegen import-codex", "imagegen import-staged-codex"],
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
    id: "motion_edit_plan",
    title: "Directed motion plan",
    required_input: "accepted image hashes + authored staging",
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
    output_artifact: "upload_packaging_<episode>.md",
    approval: "operator",
    validator: "upload_packaging_source_hash",
    commands: [],
  },
];

export const PIPELINE_STAGE_REGISTRY = Object.freeze(stages.map((entry, index) => Object.freeze({
  ...entry,
  order: index,
  dependencies: Object.freeze(index === 0 ? [] : [stages[index - 1].id]),
  artifact_contract: Object.freeze({
    output: entry.output_artifact,
    validator: entry.validator,
  }),
})));

const stagesById = new Map(PIPELINE_STAGE_REGISTRY.map((entry) => [entry.id, entry]));

export function stageDefinition(stageId) {
  return stagesById.get(stageId) ?? null;
}

export function assertStageState(value) {
  if (!STAGE_STATES.includes(value)) throw new Error(`Unknown Goldflow stage state: ${value}`);
  return value;
}

export function stageIsSatisfied(state) {
  return state === "passed" || state === "skipped_with_waiver";
}

export function commandStageFor(commandName, subcommandName, flags = {}) {
  const key = `${commandName} ${subcommandName}`.trim();
  if (key === "imagegen start" || key === "imagegen import-staged-codex") {
    if (/^(true|1|yes)$/i.test(String(flags["references-only"] ?? ""))) return "reference_generation";
    if (/^(true|1|yes)$/i.test(String(flags["qa-recovery"] ?? ""))) return "image_output_qa";
  }
  if (key === "imagegen promote-derived-refs") return "image_generation";
  for (const entry of PIPELINE_STAGE_REGISTRY) {
    if (entry.commands.includes(key)) return entry.id;
    if (entry.commands.includes(`${key}:references`)) return entry.id;
  }
  return null;
}

export function stageChecklistFor(identity = {}) {
  const narratorOnly = String(identity.audio_target ?? "narrator_only") === "narrator_only";
  return PIPELINE_STAGE_REGISTRY.map((entry) => ({
    stage: entry.id,
    status: entry.id === "sfx_score_plan" && narratorOnly ? "skipped_with_waiver" : "missing",
    approval_policy: entry.approval,
    validator: entry.validator,
  }));
}

export function workflowStageIds() {
  return PIPELINE_STAGE_REGISTRY.map((entry) => entry.id);
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
      if (entry.id === "upload_packaging") return "upload packaging";
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

function codexOpeningFlag(identity = {}) {
  const seconds = Number(identity.image_provider_options?.codex_opening_sec ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? ` --codex-opening-sec ${seconds}` : "";
}

function codexReferences(identity = {}) {
  return new Set([
    "codex",
    "hybrid_codex_refs_multichar",
    "hybrid_codex_opening_modelslab_rest",
    "hybrid_codex_refs_opening_risky_modelslab_rest",
  ]).has(String(identity.image_provider ?? ""));
}

function codexSceneCuts(identity = {}) {
  return new Set([
    "codex",
    "hybrid_codex_refs_multichar",
    "hybrid_codex_opening_modelslab_rest",
    "hybrid_codex_refs_opening_risky_modelslab_rest",
    "hybrid_modelslab_refs_codex_opening_modelslab_rest",
  ]).has(String(identity.image_provider ?? ""));
}

export function buildStageCommand(stageId, identity = {}, options = {}) {
  const base = identityBase(identity);
  const episode = identity.episode ?? "<episode>";
  const provider = identity.image_provider ?? "modelslab";
  const minWpm = Number(identity.target_wpm_min ?? 195);
  const maxWpm = Number(identity.target_wpm_max ?? 220);
  const nativeSpeed = Number(identity.qwen_native_speed ?? identity.voice_provider_options?.qwen_native_speed ?? 1.25);
  const pacePolicy = String(identity.pace_policy ?? "enforced");
  const paceFlag = pacePolicy === "diagnostic" ? " --pace-policy diagnostic" : "";
  const commands = {
    run_identity: `node bin/goldflow.mjs run preflight ${base} --title "<episode-title>" --source <source.md> --audio-target narrator_only`,
    source_ingest: `node bin/goldflow.mjs ingest source ${base} --source <source.md>`,
    script_approval: `node bin/goldflow.mjs script approve ${base} --hash <script_clean_hash>`,
    script_pace_check: `node bin/goldflow.mjs script pace-check ${base} --target-wpm-min ${minWpm} --target-wpm-max ${maxWpm}${paceFlag}${pacePolicy === "diagnostic" ? " --allow-hook-warnings true" : ""}`,
    targeted_speakability: `node bin/goldflow.mjs script targeted ${base}`,
    semantic_scene_plan: `node bin/goldflow.mjs semantic plan ${base} --concurrency 4`,
    voice_plan: `node bin/goldflow.mjs voice plan ${base}`,
    qwen_tts_stitch: `node bin/goldflow.mjs tts qwen ${base} --native-speed ${nativeSpeed}`,
    local_whisper_word_timing: `node bin/goldflow.mjs audio whisper-timing ${base}`,
    audio_pace_check: `node bin/goldflow.mjs audio pace-check ${base} --target-wpm-min ${minWpm} --target-wpm-max ${maxWpm}${paceFlag}`,
    timing_bind: `node bin/goldflow.mjs timing bind ${base}`,
    sfx_score_plan: narratorOnly(identity)
      ? "skipped with waiver because run_identity.audio_target is narrator_only"
      : `node bin/goldflow.mjs audio enrich-sfx-score ${base} --score-mode drops_only`,
    longform_audio_mix: narratorOnly(identity)
      ? `node bin/goldflow.mjs audio longform-bed ${base} --narration-only true --narration-volume-db 3 --target-lufs -13 --true-peak-db -1`
      : `node bin/goldflow.mjs audio longform-bed ${base} --narration-volume-db 3 --target-lufs -13 --true-peak-db -1`,
    visual_beat_plan: `node bin/goldflow.mjs visual beats ${base}`,
    visual_reference_plan: `node bin/goldflow.mjs visual refs ${base}`,
    reference_plan_approval: `node bin/goldflow.mjs visual approve-ref-plan ${base} --note "<reference plan review notes>"`,
    reference_generation: codexReferences(identity)
      ? `Stage isolated built-in Codex reference rasters, then run: node bin/goldflow.mjs imagegen import-staged-codex ${base} --references-only true --staging-dir <staging-dir> --reference-ids <ref_ids>`
      : `node bin/goldflow.mjs imagegen start ${base} --image-provider ${provider} --references-only true --reference-concurrency 15`,
    reference_image_approval: `node bin/goldflow.mjs visual approve-refs ${base} --note "<generated reference review notes>"`,
    visual_prompt_plan: `node bin/goldflow.mjs visual plan ${base}`,
    visual_prompt_harden: `node bin/goldflow.mjs visual harden ${base} --prompts <episode-dir>/section_image_prompts.json`,
    visual_prompt_blocker_repair: `node bin/goldflow.mjs visual review ${base} --blockers-only true --auto-resolve true --max-resolve-iterations 2`,
    transition_edit_plan: `node bin/goldflow.mjs visual transitions ${base} --prompts <episode-dir>/section_image_prompts_hardened.json${narratorOnly(identity) ? " --transition-sfx false" : ""}`,
    image_generation: codexSceneCuts(identity)
      ? `Import staged Codex-routed cuts: node bin/goldflow.mjs imagegen import-staged-codex ${base} --staging-dir <staging-dir> --image-ids <codex_cut_ids> --output <episode-dir>/imagegen_report_${episode}.json; then run ModelsLab remainder: node bin/goldflow.mjs imagegen start ${base}${codexOpeningFlag(identity)} --image-provider ${provider} --provider-filter modelslab --concurrency 15 --output <episode-dir>/imagegen_report_${episode}.json`
      : `node bin/goldflow.mjs imagegen start ${base} --image-provider ${provider} --prompts <episode-dir>/section_image_prompts_hardened.json --concurrency 15 --reference-concurrency 15`,
    image_output_qa: `node bin/goldflow.mjs imagegen qa ${base}`,
    motion_edit_plan: `node bin/goldflow.mjs visual motion-plan ${base}`,
    premium_render: `node bin/goldflow.mjs render start ${base} --motion-plan <episode-dir>/motion_edit_plan_${episode}.json --motion smooth_fast_ken_burns --render-concurrency 4 --clip-preset veryfast --final-preset veryfast`,
    final_qa: `node bin/goldflow.mjs final qa ${base}`,
    upload_packaging: "Generate upload packaging only after final QA passes.",
  };
  return options.override ?? commands[stageId] ?? null;
}
