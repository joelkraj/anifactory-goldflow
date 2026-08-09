#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  CHATGPT_WEB_PLANNER_MAX_CONCURRENCY,
  CHATGPT_WEB_PLANNING_MODEL,
  CHATGPT_WEB_WAVEFRONT_PLANNER_CONCURRENCY,
  DEFAULT_WEB_PLANNING_EFFORT_POLICY,
  plannerConcurrencyForIdentity,
  planningEffortForStage,
  planningProviderForIdentity,
  planningRuntimeFromProcessContext,
} from "../lib/planning-runtime-policy.mjs";
import {
  chatGptWebConversationScope,
  normalizeChatGptWebProjectUrl,
} from "../lib/chatgpt-web-project.mjs";
import { isCodexCacheCompatible } from "../lib/codex-cli-runner.mjs";
import { normalizedDoctorProbeResponse } from "../codex-runtime-doctor.mjs";
import {
  chatGptWebPlannerStartWindowOptionsForTests,
  normalizeChatGptWebPlannerText,
} from "../chatgpt-web-planner-helper.mjs";
import {
  escapeUnescapedJsonStringQuotes,
  parseJsonObjectFromPlannerOutput,
} from "../lib/json-output-repair.mjs";
import {
  CHATGPT_WEB_BROWSER_WORKER_LIMIT,
  CHATGPT_WEB_DEEP_TEXT_WORKER_LIMIT,
  CHATGPT_WEB_GLOBAL_START_INTERVAL_MS,
  CHATGPT_WEB_IMAGE_WORKER_LIMIT,
  CHATGPT_WEB_IMAGE_START_INTERVAL_MS,
  CHATGPT_WEB_REASONING_STARTS_PER_WINDOW,
  CHATGPT_WEB_REASONING_WINDOW_MS,
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
assert.equal(standaloneRuntime.provider, "chatgpt_web");
assert.equal(standaloneRuntime.model, CHATGPT_WEB_PLANNING_MODEL);
assert.equal(standaloneRuntime.effortPolicy, DEFAULT_WEB_PLANNING_EFFORT_POLICY);
assert.equal(normalizedDoctorProbeResponse("MODEL\\_OK"), "MODEL_OK");
assert.equal(normalizedDoctorProbeResponse("```text\nMODEL_OK\n```"), "MODEL_OK");
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
  chatGptWebPlannerStartWindowOptionsForTests({ prompt: "short", effort: "medium", timeoutMs: 300_000 }),
  { kind: "planner", rateClass: "ordinary", timeoutMs: 300_000 },
);
assert.deepEqual(
  chatGptWebPlannerStartWindowOptionsForTests({ prompt: "x".repeat(1_500), effort: "medium", timeoutMs: 1_200_000 }),
  { kind: "planner", rateClass: "reasoning", timeoutMs: 1_200_000 },
);
assert.deepEqual(
  chatGptWebPlannerStartWindowOptionsForTests({ prompt: "short", effort: "high", timeoutMs: 60_000 }),
  { kind: "planner", rateClass: "reasoning", timeoutMs: 120_000 },
);

assert.equal(planningEffortForStage("ep_01_semantic_scene_plan_chunk_001", { runtime: standaloneRuntime }), "xhigh");
assert.equal(planningEffortForStage("ep_01_semantic_scene_plan_global_reconciliation", { runtime: standaloneRuntime }), "max");
assert.equal(planningEffortForStage("ep_01_visual_reference_plan_merge", { runtime: standaloneRuntime }), "max");
assert.equal(planningEffortForStage("winner_script_generation", { runtime: standaloneRuntime }), "max");
assert.equal(planningEffortForStage("ep_01_visual_plan_chunk_001", { runtime: standaloneRuntime }), "high");
assert.equal(planningEffortForStage("ep_01_score_drop_plan", { runtime: standaloneRuntime }), "medium");

assert.equal(planningProviderForIdentity(webIdentity), "chatgpt_web");
assert.equal(CHATGPT_WEB_TEXT_WORKER_LIMIT, 10);
assert.equal(CHATGPT_WEB_IMAGE_WORKER_LIMIT, 3);
assert.equal(CHATGPT_WEB_DEEP_TEXT_WORKER_LIMIT, 1);
assert.equal(CHATGPT_WEB_BROWSER_WORKER_LIMIT, 10);
assert.equal(CHATGPT_WEB_GLOBAL_START_INTERVAL_MS, 1_250);
assert.equal(CHATGPT_WEB_TEXT_START_INTERVAL_MS, 1_250);
assert.equal(CHATGPT_WEB_IMAGE_START_INTERVAL_MS, 1_250);
assert.equal(CHATGPT_WEB_REASONING_STARTS_PER_WINDOW, 2);
assert.equal(CHATGPT_WEB_REASONING_WINDOW_MS, 900_000);
assert.deepEqual(chatGptWebWorkerPoolForKind("planner"), { id: "text", limit: 10 });
assert.deepEqual(chatGptWebWorkerPoolForKind("image"), { id: "image", limit: 3 });
assert.deepEqual(chatGptWebWorkerPoolForKind("reference"), { id: "image", limit: 3 });
assert.deepEqual(chatGptWebWorkerPoolForKind("deep_text"), { id: "deep-text", limit: 1 });
assert.deepEqual(chatGptWebWorkerPoolForKind("browser"), { id: "browser", limit: 10 });
const fastPremiumProfile = productionProfileById("fast_premium_v1");
assert.equal(fastPremiumProfile.planner.chatgpt_web_deep_text_concurrency, 1);
assert.equal(fastPremiumProfile.planner.chatgpt_web_reasoning_starts_per_window, 2);
assert.equal(fastPremiumProfile.planner.chatgpt_web_reasoning_window_ms, 900_000);
assert.equal(fastPremiumProfile.media.chatgpt_web_image_concurrency, 3);
assert.equal(fastPremiumProfile.orchestration.chatgpt_web_browser_host_concurrency, 10);

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
