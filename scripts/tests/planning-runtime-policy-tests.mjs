#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  CHATGPT_WEB_PLANNER_MAX_CONCURRENCY,
  CHATGPT_WEB_PLANNING_MODEL,
  CHATGPT_WEB_WAVEFRONT_PLANNER_CONCURRENCY,
  DEFAULT_PLANNING_ROOM_EFFORT_POLICY,
  DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY,
  DEFAULT_WEB_PLANNING_EFFORT_POLICY,
  plannerConcurrencyForIdentity,
  planningEffortForStage,
  planningProviderForIdentity,
  planningRuntimeFromProcessContext,
  webPlannerEffortForStage,
} from "../lib/planning-runtime-policy.mjs";
import {
  PLANNING_ROOM_PROVIDER,
  PREMIUM_WEB_ADVISORY_MAX_TIMEOUT_MS,
  plannerStageClass,
  plannerStageExecutionPolicy,
  planningProvidersForStage,
} from "../lib/planner-provider-registry.mjs";
import {
  chatGptWebConversationScope,
  normalizeChatGptWebProjectUrl,
} from "../lib/chatgpt-web-project.mjs";
import {
  ANTIGRAVITY_CLI_MAX_CONCURRENCY,
  antigravityContentFromStdoutForTests,
  antigravityNativeArgsForTests,
  isCodexCacheCompatible,
  withAntigravitySlotForTests,
} from "../lib/codex-cli-runner.mjs";
import { normalizedDoctorProbeResponse } from "../codex-runtime-doctor.mjs";
import {
  chatGptWebPlannerStartWindowOptionsForTests,
  normalizeChatGptWebPlannerText,
} from "../chatgpt-web-planner-helper.mjs";
import {
  escapeUnescapedJsonStringQuotes,
  removeInvalidMarkdownJsonEscapes,
  removeStrayNumericValueQuotes,
  parseJsonObjectFromPlannerOutput,
} from "../lib/json-output-repair.mjs";
import {
  CHATGPT_WEB_BROWSER_WORKER_LIMIT,
  CHATGPT_WEB_DEEP_TEXT_WORKER_LIMIT,
  CHATGPT_WEB_GLOBAL_START_INTERVAL_MS,
  CHATGPT_WEB_IMAGE_WORKER_LIMIT,
  CHATGPT_WEB_IMAGE_START_INTERVAL_MS,
  CHATGPT_WEB_MEDIUM_REASONING_START_INTERVAL_MS,
  CHATGPT_WEB_MEDIUM_REASONING_STARTS_PER_WINDOW,
  CHATGPT_WEB_MEDIUM_REASONING_WINDOW_MS,
  CHATGPT_WEB_REASONING_STARTS_PER_WINDOW,
  CHATGPT_WEB_REASONING_WINDOW_MS,
  CHATGPT_WEB_SOURCE_ROOM_STARTS_PER_WINDOW,
  CHATGPT_WEB_SOURCE_ROOM_WINDOW_MS,
  CHATGPT_WEB_STAGGERED_AUDIENCE_STARTS_PER_WINDOW,
  CHATGPT_WEB_STAGGERED_AUDIENCE_WINDOW_MS,
  CHATGPT_WEB_TEXT_WORKER_LIMIT,
  CHATGPT_WEB_TEXT_START_INTERVAL_MS,
  chatGptWebWorkerPoolForKind,
} from "../lib/chatgpt-web-worker-pool.mjs";
import {
  chatGptWebCooldownRemainingMs,
  isChatGptWebRateLimitError,
} from "../lib/chatgpt-web-throttle-state.mjs";
import { runIdentityPlanningCompleteForTests } from "../run-status.mjs";
import { productionProfileById } from "../lib/production-profiles.mjs";
import {
  SOURCE_MODEL_MODEL,
  SOURCE_MODEL_PROVIDER,
  SOURCE_MODEL_REASONING_EFFORT,
  SOURCE_MODEL_VISIBLE_EFFORT,
  sourceModelContract,
  validateSourceModelReceipt,
} from "../lib/source-model-policy.mjs";

const webIdentity = {
  planning_provider: "chatgpt_web",
  planning_effort_policy: DEFAULT_WEB_PLANNING_EFFORT_POLICY,
  image_provider: "chatgpt_web_gpt_image",
  provider_locks: {
    planning_provider: "chatgpt_web",
    planning_model: CHATGPT_WEB_PLANNING_MODEL,
    planning_effort_policy: DEFAULT_WEB_PLANNING_EFFORT_POLICY,
    planning_default_reasoning_effort: "high",
  },
  model_versions: {
    planning_model: CHATGPT_WEB_PLANNING_MODEL,
    planning_reasoning_effort: "high",
  },
};

const standaloneRuntime = planningRuntimeFromProcessContext({ argv: [], env: {} });
const gpt55SourceDraftRuntime = planningRuntimeFromProcessContext({
  explicitProvider: "chatgpt_web",
  explicitModel: "gpt-5.5",
  overrideStage: "winner_source_script_v3_draft_55_velocity",
  argv: [],
  env: {},
});
assert.equal(gpt55SourceDraftRuntime.model, "gpt-5.5");
assert.throws(() => planningRuntimeFromProcessContext({
  explicitProvider: "chatgpt_web",
  explicitModel: "gpt-5.5",
  overrideStage: "winner_source_story_architecture_creative",
  argv: [],
  env: {},
}), /except declared GPT-5\.5 or GPT-6 source-draft candidates/);
const gpt6SourceDraftRuntime = planningRuntimeFromProcessContext({
  explicitProvider: "chatgpt_web", explicitModel: "gpt-6-astra",
  overrideStage: "winner_source_script_v3_draft_6_1", argv: [], env: {},
});
assert.equal(gpt6SourceDraftRuntime.model, "gpt-6-astra");
for (const kind of ["edit", "review"]) {
  const runtime = planningRuntimeFromProcessContext({
    explicitProvider: "chatgpt_web", explicitModel: "gpt-6-astra",
    overrideStage: `winner_source_script_v3_directed_${kind}_gpt6_fixture_01`, argv: [], env: {},
  });
  assert.equal(runtime.model, "gpt-6-astra");
  assert.equal(runtime.identity, null);
}
assert.throws(() => planningRuntimeFromProcessContext({
  explicitProvider: "chatgpt_web", explicitModel: "gpt-5.5",
  overrideStage: "winner_source_script_v3_directed_edit_gpt6_fixture_01", argv: [], env: {},
}), /except declared/);
assert.throws(() => planningRuntimeFromProcessContext({
  explicitProvider: "chatgpt_web", explicitModel: "gpt-6-astra",
  overrideStage: "winner_source_script_v3_directed_planning_gpt6_fixture_01", argv: [], env: {},
}), /except declared/);
assert.throws(() => planningRuntimeFromProcessContext({
  explicitProvider: "chatgpt_web", explicitModel: "gpt-6-astra",
  overrideStage: "winner_source_story_architecture_creative", argv: [], env: {},
}), /except declared/);
assert.equal(ANTIGRAVITY_CLI_MAX_CONCURRENCY, 3);
let activeAntigravityFixtureCalls = 0;
let maximumAntigravityFixtureCalls = 0;
await Promise.all(Array.from({ length: 8 }, () => withAntigravitySlotForTests(async () => {
  activeAntigravityFixtureCalls += 1;
  maximumAntigravityFixtureCalls = Math.max(maximumAntigravityFixtureCalls, activeAntigravityFixtureCalls);
  await new Promise((resolve) => setTimeout(resolve, 5));
  activeAntigravityFixtureCalls -= 1;
})));
assert.equal(maximumAntigravityFixtureCalls, ANTIGRAVITY_CLI_MAX_CONCURRENCY);
assert.equal(standaloneRuntime.provider, "codex_cli");
assert.equal(standaloneRuntime.model, CHATGPT_WEB_PLANNING_MODEL);
assert.equal(standaloneRuntime.effortPolicy, DEFAULT_UNIFORM_PLANNING_EFFORT_POLICY);
assert.equal(normalizedDoctorProbeResponse("MODEL\\_OK"), "MODEL_OK");
assert.equal(normalizedDoctorProbeResponse("```text\nMODEL_OK\n```"), "MODEL_OK");
assert.deepEqual(
  antigravityNativeArgsForTests({
    prompt: "Return the requested JSON only.",
    model: "gemini-3.6-flash-medium",
    effort: "xhigh",
    timeoutMs: 90_000,
  }),
  [
    "--print", "Return the requested JSON only.",
    "--mode", "plan",
    "--sandbox",
    "--output-format", "json",
    "--effort", "medium",
    "--print-timeout", "90s",
    "--model", "gemini-3.6-flash-medium",
  ],
);
assert.deepEqual(
  antigravityContentFromStdoutForTests(JSON.stringify({
    status: "SUCCESS",
    response: "ignored",
    structured_output: { status: "passed", ids: ["cut_001"] },
    duration_seconds: 2.5,
  })).content,
  '{\n  "status": "passed",\n  "ids": [\n    "cut_001"\n  ]\n}\n',
);
assert.equal(
  JSON.parse(normalizeChatGptWebPlannerText('{"visual\\_job":"establish\\_context"}')).visual_job,
  "establish_context",
);
assert.deepEqual(
  JSON.parse(normalizeChatGptWebPlannerText('{"items": \\[1, 2\\], "state": "case\\_specific"}')),
  { items: [1, 2], state: "case_specific" },
);
assert.equal(normalizeChatGptWebPlannerText('C:\\\\frames\\\\cut_001.png'), 'C:\\\\frames\\\\cut_001.png');
const brokenDialogueJson = '{"script_excerpt_start":""Family only," the receptionist called.","script_excerpt_end":""I said out.""}';
const repairedDialogue = parseJsonObjectFromPlannerOutput(brokenDialogueJson);
assert.deepEqual(repairedDialogue.value, {
  script_excerpt_start: '"Family only," the receptionist called.',
  script_excerpt_end: '"I said out."',
});
assert.deepEqual(repairedDialogue.syntax_repair, {
  schema: "goldflow_json_syntax_repair_v1",
  kind: "escape_unescaped_string_quotes",
  repair_count: 4,
});
assert.deepEqual(
  parseJsonObjectFromPlannerOutput('{"already":"valid \\"dialogue\\""}'),
  { value: { already: 'valid "dialogue"' }, syntax_repair: null },
);
assert.equal(escapeUnescapedJsonStringQuotes('{"value":"plain"}').repair_count, 0);
assert.deepEqual(
  parseJsonObjectFromPlannerOutput('{"at":0.7", "scale":1}'),
  {
    value: { at: 0.7, scale: 1 },
    syntax_repair: {
      schema: "goldflow_json_syntax_repair_v1",
      kind: "remove_stray_numeric_value_quotes",
      repair_count: 1,
    },
  },
);
assert.equal(removeStrayNumericValueQuotes('{"value":"version 2"}').repair_count, 0);
assert.deepEqual(
  parseJsonObjectFromPlannerOutput('{"schema":"goldflow\\_viewer","items":\\["one"\\]}'),
  {
    value: { schema: "goldflow_viewer", items: ["one"] },
    syntax_repair: {
      schema: "goldflow_json_syntax_repair_v1",
      kind: "remove_invalid_markdown_json_escapes",
      repair_count: 3,
    },
  },
);
assert.equal(removeInvalidMarkdownJsonEscapes('{"path":"C:\\\\frames"}').repair_count, 0);
assert.deepEqual(
  chatGptWebPlannerStartWindowOptionsForTests({ prompt: "short", effort: "medium", timeoutMs: 300_000 }),
  { kind: "planner", rateClass: "ordinary", timeoutMs: 300_000 },
);
assert.deepEqual(
  chatGptWebPlannerStartWindowOptionsForTests({ prompt: "x".repeat(1_500), effort: "medium", timeoutMs: 1_200_000 }),
  { kind: "planner", rateClass: "medium_reasoning", minimumIntervalMs: 45_000, timeoutMs: 1_200_000 },
);
assert.deepEqual(
  chatGptWebPlannerStartWindowOptionsForTests({ prompt: "short", effort: "high", timeoutMs: 60_000 }),
  { kind: "planner", rateClass: "reasoning", timeoutMs: 120_000 },
);
assert.deepEqual(
  chatGptWebPlannerStartWindowOptionsForTests({
    prompt: "x".repeat(1_500),
    effort: "low",
    timeoutMs: 300_000,
    rateClass: "ordinary",
  }),
  { kind: "planner", rateClass: "ordinary", timeoutMs: 300_000 },
);
assert.deepEqual(
  chatGptWebPlannerStartWindowOptionsForTests({
    prompt: "x".repeat(1_500),
    effort: "low",
    timeoutMs: 300_000,
    rateClass: "audience_staggered",
    minimumStartIntervalMs: 15_000,
  }),
  { kind: "planner", rateClass: "audience_staggered", minimumIntervalMs: 15_000, timeoutMs: 300_000 },
);

const webAdaptiveRuntime = {
  ...standaloneRuntime,
  provider: "chatgpt_web",
  effortPolicy: DEFAULT_WEB_PLANNING_EFFORT_POLICY,
  defaultEffort: "high",
};
assert.equal(planningEffortForStage("ep_01_semantic_scene_plan_chunk_001", { runtime: webAdaptiveRuntime }), "xhigh");
assert.equal(planningEffortForStage("ep_01_semantic_scene_plan_global_reconciliation", { runtime: webAdaptiveRuntime }), "max");
assert.equal(planningEffortForStage("ep_01_visual_reference_plan_merge", { runtime: webAdaptiveRuntime }), "max");
assert.equal(planningEffortForStage("winner_script_generation", { runtime: webAdaptiveRuntime }), "max");
assert.equal(planningEffortForStage("ep_01_visual_plan_chunk_001", { runtime: webAdaptiveRuntime }), "high");
assert.equal(planningEffortForStage("ep_01_score_drop_plan", { runtime: webAdaptiveRuntime }), "medium");

const newPlanningRoomIdentity = { planning_provider: PLANNING_ROOM_PROVIDER };
const planningRoomCodexRuntime = {
  ...standaloneRuntime,
  provider: "codex_cli",
  effortPolicy: DEFAULT_PLANNING_ROOM_EFFORT_POLICY,
  defaultEffort: "medium",
};
for (const criticalStage of [
  "ep_01_semantic_scene_plan_chunk_001",
  "ep_01_semantic_scene_plan_global_reconciliation",
  "narration_performance",
  "ep_01_visual_beat_chunk_001",
  "ep_01_visual_reference_plan_chunk_001",
  "ep_01_visual_reference_plan_merge",
  "ep_01_visual_plan_chunk_001",
  "ep_01_visual_prompt_validation",
  "transition_edit_plan",
]) {
  assert.deepEqual(
    planningProvidersForStage(newPlanningRoomIdentity, criticalStage, { availableOnly: false }),
    ["codex_cli"],
    `${criticalStage} must stay Codex-only on the critical path`,
  );
  assert.equal(planningEffortForStage(criticalStage, { runtime: planningRoomCodexRuntime }), "medium");
}
const legacyGlobalRouteIdentity = {
  planning_provider: PLANNING_ROOM_PROVIDER,
  planning_room: { stage_routes: { global_reasoning: ["gemini_web", "chatgpt_web", "codex_cli"] } },
};
assert.deepEqual(
  planningProvidersForStage(legacyGlobalRouteIdentity, "ep_01_semantic_scene_plan_global_reconciliation", { availableOnly: false }),
  ["gemini_web", "chatgpt_web", "codex_cli"],
);
for (const optionalWebStage of [
  "global_creative_direction",
  "opening_animation_direction",
  "difficult_hero_scene",
  "visual_prompt_audit",
  "youtube_upload_packaging",
]) {
  assert.equal(plannerStageClass(optionalWebStage), "premium_creative");
  assert.deepEqual(
    planningProvidersForStage(newPlanningRoomIdentity, optionalWebStage, { availableOnly: false }),
    ["chatgpt_web", "codex_cli"],
  );
  assert.equal(webPlannerEffortForStage(optionalWebStage, { policy: DEFAULT_PLANNING_ROOM_EFFORT_POLICY }), "medium");
  assert.deepEqual(plannerStageExecutionPolicy(optionalWebStage), {
    blocking: false,
    advisory: true,
    provider: "chatgpt_web",
    reasoning_effort: "medium",
    max_timeout_ms: PREMIUM_WEB_ADVISORY_MAX_TIMEOUT_MS,
    timeout_disposition: "omit_advisory_and_continue",
  });
}

const sourceContract = sourceModelContract({});
assert.equal(sourceContract.provider, SOURCE_MODEL_PROVIDER);
assert.equal(sourceContract.model, SOURCE_MODEL_MODEL);
assert.equal(sourceContract.reasoning_effort, SOURCE_MODEL_REASONING_EFFORT);
assert.equal(sourceContract.visible_effort, SOURCE_MODEL_VISIBLE_EFFORT);
const premiseMediumContract = sourceModelContract(
  { provider: "chatgpt_web", "reasoning-effort": "medium" },
  { stageName: "winner_source_ideate_v3_gpt_web_medium_independent_author" },
);
assert.equal(premiseMediumContract.provider, "chatgpt_web");
assert.equal(premiseMediumContract.reasoning_effort, "medium");
assert.equal(premiseMediumContract.visible_effort, "Medium");
const treatmentMediumContract = sourceModelContract(
  { provider: "chatgpt_web", "reasoning-effort": "medium" },
  { stageName: "winner_source_creative_treatment_boundary_drama" },
);
assert.equal(treatmentMediumContract.reasoning_effort, "medium");
assert.equal(treatmentMediumContract.visible_effort, "Medium");
const architectureMediumContract = sourceModelContract(
  { provider: "chatgpt_web", "reasoning-effort": "medium" },
  { stageName: "winner_source_story_architecture_creative" },
);
assert.equal(architectureMediumContract.reasoning_effort, "medium");
assert.equal(architectureMediumContract.visible_effort, "Medium");
const priorGeminiUrl = process.env.ANIFACTORY_GEMINI_WEB_URL;
const priorGeminiToken = process.env.ANIFACTORY_GEMINI_WEB_TOKEN;
process.env.ANIFACTORY_GEMINI_WEB_URL = "http://127.0.0.1:19999";
process.env.ANIFACTORY_GEMINI_WEB_TOKEN = "fixture-token";
const sourceResearchContract = sourceModelContract({}, { stageName: "winner_source_deep_research" });
const sourceAuditContract = sourceModelContract({}, { stageName: "winner_blueprint_audience_audit" });
const storyTruthContract = sourceModelContract({}, { stageName: "winner_source_story_truth_ir_v2" });
const storyTruthMediumContract = sourceModelContract(
  { provider: "codex_cli", "reasoning-effort": "medium" },
  { stageName: "winner_source_story_truth_ir_v2" },
);
assert.equal(sourceResearchContract.provider, "gemini_web");
assert.equal(sourceResearchContract.stage_class, "source_research");
assert.equal(sourceAuditContract.provider, "codex_cli");
assert.equal(sourceAuditContract.stage_class, "global_reasoning");
assert.equal(storyTruthContract.provider, "codex_cli");
assert.equal(storyTruthContract.stage_class, "local_reconciliation");
assert.equal(storyTruthMediumContract.provider, "codex_cli");
assert.equal(storyTruthMediumContract.reasoning_effort, "medium");
if (priorGeminiUrl == null) delete process.env.ANIFACTORY_GEMINI_WEB_URL;
else process.env.ANIFACTORY_GEMINI_WEB_URL = priorGeminiUrl;
if (priorGeminiToken == null) delete process.env.ANIFACTORY_GEMINI_WEB_TOKEN;
else process.env.ANIFACTORY_GEMINI_WEB_TOKEN = priorGeminiToken;
const sourceCodexContract = sourceModelContract({ provider: "codex_cli" });
assert.equal(sourceCodexContract.provider, "codex_cli");
assert.equal(sourceCodexContract.stage_class, "premium_creative");
assert.throws(() => sourceModelContract({ "reasoning-effort": "high" }), /requires --reasoning-effort medium/);
assert.deepEqual(validateSourceModelReceipt({
  provider: "chatgpt_web",
  model: CHATGPT_WEB_PLANNING_MODEL,
  reasoning_effort: "medium",
  transport: "goldflow_studio_local_api",
}), { done: true, blockers: [] });
assert.equal(validateSourceModelReceipt({
  provider: "codex_cli",
  model: CHATGPT_WEB_PLANNING_MODEL,
  reasoning_effort: "high",
  transport: "codex_cli",
}).done, false);
assert.equal(validateSourceModelReceipt({
  provider: "chatgpt_web",
  model: CHATGPT_WEB_PLANNING_MODEL,
  reasoning_effort: "medium",
  transport: "codex_cli",
}).done, false);

assert.equal(planningProviderForIdentity(webIdentity), "chatgpt_web");
assert.equal(CHATGPT_WEB_TEXT_WORKER_LIMIT, 10);
assert.equal(CHATGPT_WEB_IMAGE_WORKER_LIMIT, 3);
assert.equal(CHATGPT_WEB_DEEP_TEXT_WORKER_LIMIT, 3);
assert.equal(CHATGPT_WEB_BROWSER_WORKER_LIMIT, 10);
assert.equal(CHATGPT_WEB_GLOBAL_START_INTERVAL_MS, 1_250);
assert.equal(CHATGPT_WEB_TEXT_START_INTERVAL_MS, 1_250);
assert.equal(CHATGPT_WEB_IMAGE_START_INTERVAL_MS, 45_000);
assert.equal(CHATGPT_WEB_REASONING_STARTS_PER_WINDOW, 2);
assert.equal(CHATGPT_WEB_REASONING_WINDOW_MS, 900_000);
assert.equal(CHATGPT_WEB_STAGGERED_AUDIENCE_STARTS_PER_WINDOW, 3);
assert.equal(CHATGPT_WEB_STAGGERED_AUDIENCE_WINDOW_MS, 900_000);
assert.equal(CHATGPT_WEB_SOURCE_ROOM_STARTS_PER_WINDOW, 3);
assert.equal(CHATGPT_WEB_SOURCE_ROOM_WINDOW_MS, 900_000);
assert.equal(CHATGPT_WEB_MEDIUM_REASONING_START_INTERVAL_MS, 45_000);
assert.equal(CHATGPT_WEB_MEDIUM_REASONING_STARTS_PER_WINDOW, 1);
assert.equal(CHATGPT_WEB_MEDIUM_REASONING_WINDOW_MS, 360_000);
assert.deepEqual(chatGptWebWorkerPoolForKind("planner"), { id: "text", limit: 10 });
assert.deepEqual(chatGptWebWorkerPoolForKind("image"), { id: "image", limit: 3 });
assert.deepEqual(chatGptWebWorkerPoolForKind("reference"), { id: "image", limit: 3 });
assert.deepEqual(chatGptWebWorkerPoolForKind("deep_text"), { id: "deep-text", limit: 3 });
assert.deepEqual(chatGptWebWorkerPoolForKind("browser"), { id: "browser", limit: 10 });
const fastPremiumProfile = productionProfileById("fast_premium_v1");
assert.equal(fastPremiumProfile.target_wall_clock_minutes, 420);
assert.deepEqual(fastPremiumProfile.target_wall_clock_band_minutes, { minimum: 300, maximum: 420 });
assert.equal(fastPremiumProfile.stretch_target_wall_clock_minutes, 300);
assert.equal(fastPremiumProfile.planner.semantic_concurrency, 12);
assert.equal(fastPremiumProfile.planner.editorial_concurrency, 12);
assert.equal(fastPremiumProfile.planner.visual_ref_chunk_concurrency, 12);
assert.equal(fastPremiumProfile.planner.visual_chunk_concurrency, 12);
assert.equal(fastPremiumProfile.planner.codex_cli_structured_concurrency, 12);
assert.equal(fastPremiumProfile.planner.codex_cli_structured_initial_concurrency, 8);
assert.equal(fastPremiumProfile.planner.antigravity_cli_structured_concurrency, 0);
assert.equal(fastPremiumProfile.planner.chatgpt_web_deep_text_concurrency, 1);
assert.equal(fastPremiumProfile.planner.chatgpt_web_reasoning_starts_per_window, 2);
assert.equal(fastPremiumProfile.planner.chatgpt_web_reasoning_window_ms, 900_000);
assert.equal(fastPremiumProfile.media.chatgpt_web_image_concurrency, 0);
assert.equal(fastPremiumProfile.media.chatgpt_web_image_fallback_concurrency, 3);
assert.equal(fastPremiumProfile.orchestration.chatgpt_web_browser_host_concurrency, 10);
const fastStillProfile = productionProfileById("fast_premium_v2");
assert.equal(fastStillProfile.target_wall_clock_minutes, 360);
assert.equal(fastStillProfile.defaults.generated_motion_policy, "disabled");
assert.equal(fastStillProfile.defaults.visual_beat_timing_contract.enforcement, "hard_max");
assert.equal(fastStillProfile.defaults.visual_beat_timing_contract.target_beat_sec, 7.5);
assert.equal(fastStillProfile.defaults.visual_beat_timing_contract.max_beat_sec, 8);
assert.equal(fastStillProfile.defaults.visual_beat_timing_contract.retention_ramp_sec, 1200);
assert.equal(fastStillProfile.media.generated_motion_concurrency, 0);
assert.equal(fastStillProfile.orchestration.incremental_generated_motion_prefetch, false);
assert.equal(fastStillProfile.orchestration.provider_readiness_gate.flow_minimum_accepted_images_per_hour, 180);
assert.equal(fastStillProfile.orchestration.provider_readiness_gate.worker_runtime_freshness_max_ms, 60_000);
assert.equal(fastStillProfile.orchestration.image_qa_policy.ordinary_semantic_sample_rate, 0.01);
assert.equal(fastStillProfile.orchestration.image_qa_policy.integration_sample_rate, 0.02);
assert.equal(fastStillProfile.audio.narration_delivery_qa.policy, "material_delivery_risk_only_v1");
assert.equal(fastStillProfile.orchestration.wall_clock_contract.hard_ceiling_minutes, 420);

const projectHome = "https://chatgpt.com/g/g-p-697e4bb9fad48191be862e32e1789064/project";
assert.equal(normalizeChatGptWebProjectUrl(`${projectHome}?ignored=true#fragment`), projectHome);
assert.throws(() => normalizeChatGptWebProjectUrl("https://example.com/project"), /must use https:\/\/chatgpt\.com/);
assert.equal(
  chatGptWebConversationScope("https://chatgpt.com/g/g-p-697e4bb9fad48191be862e32e1789064-goldflow/c/6a778e7f-2a24-83ea-b319-e505679c3b6f"),
  "project",
);
assert.equal(chatGptWebConversationScope("https://chatgpt.com/c/6a778e7f-2a24-83ea-b319-e505679c3b6f"), "regular");
assert.equal(chatGptWebConversationScope("https://chatgpt.com/?temporary-chat=true"), "temporary");
assert.equal(isChatGptWebRateLimitError("ChatGPT rate limit: too many requests are being made too quickly."), true);
assert.equal(isChatGptWebRateLimitError("composer did not preserve the prompt"), false);
assert.equal(chatGptWebCooldownRemainingMs({ cooldown_until: "2026-08-08T20:15:00.000Z" }, Date.parse("2026-08-08T20:10:00.000Z")), 300_000);
assert.equal(runIdentityPlanningCompleteForTests(webIdentity).done, true);
assert.equal(plannerConcurrencyForIdentity(webIdentity, 15), CHATGPT_WEB_PLANNER_MAX_CONCURRENCY);
assert.equal(
  plannerConcurrencyForIdentity(webIdentity, 15, { visualPromptWavefront: true }),
  CHATGPT_WEB_WAVEFRONT_PLANNER_CONCURRENCY,
);

const incompleteWebIdentity = structuredClone(webIdentity);
delete incompleteWebIdentity.provider_locks.planning_default_reasoning_effort;
assert.equal(runIdentityPlanningCompleteForTests(incompleteWebIdentity).done, false);

const legacyIdentity = structuredClone(webIdentity);
delete legacyIdentity.planning_provider;
delete legacyIdentity.planning_effort_policy;
delete legacyIdentity.provider_locks.planning_provider;
delete legacyIdentity.provider_locks.planning_model;
delete legacyIdentity.provider_locks.planning_effort_policy;
delete legacyIdentity.provider_locks.planning_default_reasoning_effort;
assert.equal(planningProviderForIdentity(legacyIdentity), "codex_cli");
assert.equal(runIdentityPlanningCompleteForTests(legacyIdentity).done, true);
assert.equal(plannerConcurrencyForIdentity(legacyIdentity, 8), 8);

const promptHash = "fixture-prompt-hash";
assert.equal(isCodexCacheCompatible({
  status: "passed",
  provider: "chatgpt_web",
  model: CHATGPT_WEB_PLANNING_MODEL,
  reasoning_effort: "max",
  planning_effort_policy: DEFAULT_WEB_PLANNING_EFFORT_POLICY,
  prompt_sha256: promptHash,
}, {
  provider: "chatgpt_web",
  stageName: "winner_script_generation",
  promptHash,
}), true);
assert.equal(isCodexCacheCompatible({
  status: "passed",
  provider: "codex_cli",
  model: CHATGPT_WEB_PLANNING_MODEL,
  reasoning_effort: "max",
  planning_effort_policy: DEFAULT_WEB_PLANNING_EFFORT_POLICY,
  prompt_sha256: promptHash,
}, {
  provider: "chatgpt_web",
  stageName: "winner_script_generation",
  promptHash,
}), false);

console.log("planning runtime policy tests passed");
