#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  allowedRefIdsForScene,
  applyBeatLocationSceneIds,
  applyDeterministicLocationSceneIds,
  dropOutOfScopePromptRefs,
  locationCoverageFindings,
  outOfScopeLocationRefMentions,
  referenceTargetsForScene,
} from "./lib/visual-scope-utils.mjs";
import { multiCharacterBleedFindings, sanitizeCharacterStaging } from "./lib/character-staging-utils.mjs";
import { promptTextForImageProvider } from "./lib/image-prompt-utils.mjs";
import {
  normalizeImageProvider,
  routedProviderForPrompt,
  routedProviderForReference,
} from "./lib/image-provider-routing.mjs";
import { stripEmbeddedProviderExclusionPayloadSyntax } from "./lib/prompt-payload-sanitize.mjs";
import { namedCharacterDuplicationFindings } from "./lib/prompt-prose-findings.mjs";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  codexVersionSupportsModel,
  compareCodexVersions,
  isCodexCacheCompatible,
  parseCodexVersion,
} from "./lib/codex-cli-runner.mjs";
import {
  attachReferencePathsToPromptsForTests,
  assertNoVisualResolutionDeadletterForTests,
  candidateImageIdsForDerivedTargetForTests,
  cumulativeImagegenHistoryForTests,
  episodeImageStatusForTests,
  referencePromptForTests,
  referenceSlotInstructionForTests,
  runPoolWithCircuitBreakerForTests,
  scenePromptProductionContractFindingsForTests,
} from "./imagegen.mjs";
import {
  beginStageExecution,
  finishStageExecution,
  materializeProductionManifest,
} from "./lib/execution-provenance.mjs";
import {
  applyImageQaDecisionsToLedger,
  donorRecoveryFinding,
  imageQaNeedsRecovery,
  imageRiskReasons,
  mergeRiskReviewDecisions,
  scopedQaRecoveryCommand,
} from "./image-output-qa.mjs";
import { ttsSafeTextForTests } from "./modelslab-qwen-episode-audio.mjs";
import { validateAmbienceSpecForTests } from "./audio-ambience-repair.mjs";
import { parseProofScopeForTests, validateDirtyWorktreePolicy } from "./run-preflight.mjs";
import { validateFinalQaSourceHashesForTests } from "./final-qa.mjs";
import {
  referencePlanApprovalContractSha256,
  referencePlanApprovalMatches,
} from "./lib/reference-plan-contract.mjs";
import { assertRenderImageIntegrityForTests, mergeShortSubtitleEvents, xfadeTimelineGroupsForTests } from "./render.mjs";
import {
  motionIntentFindings,
  motionIntentForPrompt,
  motionTraceFindings,
  motionTraceForIntent,
  positionAnchorFromStaging,
} from "./lib/motion-plan-utils.mjs";
import {
  gptImage2OutputSizeForTests,
  prepareGptImage2PromptForTests,
} from "./modelslab-image-helper.mjs";
import {
  activeStateConstraintFindingsForTests,
  adaptivePromptChunksForTests,
  localBeatFidelityFindingsForTests,
  normalizePromptPacketForTests,
} from "./visual-plan.mjs";
import {
  referenceCharacterStateFindingsForTests,
  referenceDirectorSelectionFindingsForTests,
  referenceEvidenceLedgerForTests,
  referenceLocationContractLedgerForTests,
  referenceLocationScopeForTests,
  referenceOpeningIdentityFindingsForTests,
  selectedReferenceInventoryForTests,
} from "./visual-reference-plan.mjs";
import { qwenGenerationPlanForTests, voiceDirectionTransformForTests } from "./voice-direction-gate.mjs";
import { longLocationSpanFindings, repeatedLocationShotJobFindings } from "./lib/visual-plan-quality-utils.mjs";
import { alignExcerptRowsToWhisper } from "./lib/transcript-excerpt-alignment.mjs";
import {
  PIPELINE_STAGE_REGISTRY,
  buildStageCommand,
  commandStageFor,
  stageChecklistFor,
} from "./lib/pipeline-stage-registry.mjs";
import {
  buildEditorialDirectorPrompt,
  buildTranscriptAtoms,
  editorialBeatCoverageFindings,
  editorialRetentionRailFindings,
  normalizeEditorialGrouping,
  projectActiveStateConstraints,
  retentionRailForTime,
} from "./lib/editorial-beat-director.mjs";
import {
  compatibleHardenFeedbackBlockers,
  hasHardenFeedbackFindings,
  hardenFeedbackBlockersNeedManualAgentReview,
  mergeScopedPromptReplacements,
  resolvedDeadletterPayload,
  visualResolveScopeForBlockers,
} from "./lib/visual-resolution-utils.mjs";
import {
  semanticBuildPromptForTests,
  semanticReconciliationPromptForTests,
  sanitizeCanonicalIdForTests,
  semanticProofScopeForTests,
  semanticSceneAnchorFindingsForTests,
  semanticSceneQualityFindingsForTests,
  semanticScriptChunksForTests,
  semanticSnapSceneAnchorsForTests,
  storyFactEvidenceFindingsForTests,
} from "./semantic-scene-plan.mjs";
import { scopedBaselineWordsForTests } from "./proof-baseline-import.mjs";
import {
  closeVisualBeatTimelineForTests,
  factLedgerMatchesScriptForTests,
  scriptPrefixForTimedWordsForTests,
  visualBeatInternalsForTests,
} from "./visual-beat-plan.mjs";

const execFileAsync = promisify(execFile);
const VISUAL_BEAT_CONTRACT_VERSION = "visual_beat_ref_strategy_v2";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function testAuthoritativeStageRegistry() {
  const ids = PIPELINE_STAGE_REGISTRY.map((stage) => stage.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(-7), [
    "transition_edit_plan",
    "image_generation",
    "image_output_qa",
    "motion_edit_plan",
    "premium_render",
    "final_qa",
    "upload_packaging",
  ]);
  assert.equal(ids.includes("visual_prompt_plan_review_harden"), false);
  assert.equal(ids.includes("reference_plan_approval"), true);
  const narratorOnly = stageChecklistFor({ audio_target: "narrator_only" });
  assert.equal(narratorOnly.find((row) => row.stage === "sfx_score_plan")?.status, "skipped_with_waiver");
  assert.equal(narratorOnly.every((row) => row.validator), true);
}

function testRunIdentityV2Policies() {
  assert.throws(
    () => validateDirtyWorktreePolicy({ dirty: true, intent: "production", allowDirty: true, reason: "not allowed" }),
    /clean Git worktree/i,
  );
  assert.throws(
    () => validateDirtyWorktreePolicy({ dirty: true, intent: "proof", allowDirty: true, reason: "" }),
    /dirty-reason/i,
  );
  assert.equal(validateDirtyWorktreePolicy({ dirty: true, intent: "proof", allowDirty: true, reason: "bounded fixture" }).waiver, "bounded fixture");
  assert.deepEqual(parseProofScopeForTests({ "proof-scope": "0-300" }, "proof"), {
    mode: "bounded",
    start_sec: 0,
    end_sec: 300,
    label: "proof_0_300",
  });
  assert.throws(() => parseProofScopeForTests({}, "proof"), /requires --proof-scope/i);
}

async function testFinalQaSourceHashFreshness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-final-qa-"));
  const sourcePath = path.join(dir, "source.json");
  await fs.writeFile(sourcePath, "first", "utf8");
  const expected = sha256(await fs.readFile(sourcePath));
  let result = await validateFinalQaSourceHashesForTests({ [sourcePath]: expected });
  assert.deepEqual(result.stale, []);
  await fs.writeFile(sourcePath, "changed", "utf8");
  result = await validateFinalQaSourceHashesForTests({ [sourcePath]: expected });
  assert.deepEqual(result.stale, [sourcePath]);
}

async function testRunStatusRejectsFalseGreenFinalQa() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-final-status-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    schema: "goldflow_run_identity_v2",
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    audio_target: "narrator_only",
    image_provider: "modelslab",
  });
  await writeJson(path.join(episodeDir, "qa_report_looks_finished.json"), { status: "passed" });
  let result = await execFileAsync(process.execPath, ["scripts/run-status.mjs", "--episode-dir", episodeDir], {
    cwd: process.cwd(),
    env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
  });
  let status = JSON.parse(result.stdout);
  let finalStage = status.stage_ledger.find((row) => row.stage === "final_qa");
  assert.equal(finalStage.state, "missing");
  await writeJson(path.join(episodeDir, "final_qa_ep_01.json"), { status: "failed" });
  result = await execFileAsync(process.execPath, ["scripts/run-status.mjs", "--episode-dir", episodeDir], {
    cwd: process.cwd(),
    env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot },
  });
  status = JSON.parse(result.stdout);
  finalStage = status.stage_ledger.find((row) => row.stage === "final_qa");
  assert.equal(finalStage.state, "failed");
}

async function testAppendOnlyExecutionProvenance() {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-events-"));
  await writeJson(path.join(episodeDir, "input.json"), { status: "passed", value: 1 });
  const flags = { "episode-dir": episodeDir, "cut-ids": "cut_001" };
  const first = await beginStageExecution({ stage: "image_generation", command: "imagegen start", flags });
  await writeJson(path.join(episodeDir, "imagegen_report_ep_01.json"), {
    status: "partial",
    estimated_cost: { current_batch: { estimated_cost_usd: 0.08 } },
  });
  await finishStageExecution(first, { exitCode: 0 });
  const second = await beginStageExecution({ stage: "image_generation", command: "imagegen start", flags });
  await writeJson(path.join(episodeDir, "imagegen_report_ep_01.json"), {
    status: "passed",
    estimated_cost: { current_batch: { estimated_cost_usd: 0.04 } },
  });
  await finishStageExecution(second, { exitCode: 0 });
  const events = (await fs.readFile(path.join(episodeDir, "execution_events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter((row) => row.event_type === "stage_started").length, 2);
  assert.equal(events.filter((row) => row.event_type === "stage_completed").length, 2);
  assert.equal(second.attempt, 2);
  const manifest = await materializeProductionManifest(episodeDir);
  assert.equal(manifest.telemetry.total_stage_calls, 2);
  assert.equal(manifest.telemetry.retry_calls, 1);
  assert.equal(manifest.telemetry.cumulative_cost_usd, 0.12);
  const reportFiles = await fs.readdir(path.join(episodeDir, "reports", "stages", "image_generation"));
  assert.equal(reportFiles.length, 2);
}

async function testCumulativeImagegenHistoryAndEpisodeTruth() {
  const cumulative = await cumulativeImagegenHistoryForTests([
    { current_batch_cost: { estimated_cost_usd: 0.08 }, wall_time_sec: 4 },
    { current_batch_cost: { estimated_cost_usd: 0.04 }, wall_time_sec: 2 },
  ]);
  assert.equal(cumulative.batch_count, 2);
  assert.equal(cumulative.estimated_cost_usd, 0.12);
  assert.equal(cumulative.wall_time_sec, 6);
  assert.equal(episodeImageStatusForTests("passed", "partial"), "partial");
  assert.equal(episodeImageStatusForTests("passed", "passed"), "passed");
  assert.equal(episodeImageStatusForTests("failed", "passed"), "failed");
}

function testPinnedCodexRuntimeContracts() {
  assert.equal(DEFAULT_CODEX_MODEL, "gpt-5.6-sol");
  assert.equal(DEFAULT_CODEX_REASONING_EFFORT, "medium");
  const oldCli = parseCodexVersion("codex-cli 0.141.0");
  const qualifyingBundledCli = parseCodexVersion("codex-cli 0.144.0-alpha.4");
  assert.equal(codexVersionSupportsModel(oldCli, DEFAULT_CODEX_MODEL), false);
  assert.equal(codexVersionSupportsModel(qualifyingBundledCli, DEFAULT_CODEX_MODEL), true);
  assert.equal(compareCodexVersions(qualifyingBundledCli, oldCli) > 0, true);

  const promptHash = sha256("fixture prompt");
  const matchingMetadata = {
    status: "passed",
    model: DEFAULT_CODEX_MODEL,
    reasoning_effort: DEFAULT_CODEX_REASONING_EFFORT,
    prompt_sha256: promptHash,
  };
  assert.equal(isCodexCacheCompatible(matchingMetadata, {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    promptHash,
  }), true);
  assert.equal(isCodexCacheCompatible({ ...matchingMetadata, model: "gpt-5.5" }, {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    promptHash,
  }), false);
  assert.equal(isCodexCacheCompatible({ ...matchingMetadata, reasoning_effort: "high" }, {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    promptHash,
  }), false);
  assert.equal(isCodexCacheCompatible({ ...matchingMetadata, prompt_sha256: "stale" }, {
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    promptHash,
  }), false);
}

async function testNestedCodexCallsUseSharedRunner() {
  const scriptsDir = path.join(process.cwd(), "scripts");
  const scriptFiles = (await fs.readdir(scriptsDir)).filter((name) => name.endsWith(".mjs"));
  for (const scriptFile of scriptFiles) {
    const source = await fs.readFile(path.join(scriptsDir, scriptFile), "utf8");
    assert.doesNotMatch(source, /spawn\s*\(\s*["']codex["']/, `${scriptFile} must use lib/codex-cli-runner.mjs`);
    assert.equal(source.includes(["codex", "cli", "default"].join("_")), false, `${scriptFile} must report the actual pinned Codex model`);
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeFixtureReferenceInventory(episodeDir, sourceScriptHash = "fixture_hash", assets = []) {
  const ledgerPath = path.join(episodeDir, "reference_inventory_ledger.json");
  await writeJson(ledgerPath, {
    schema: "goldflow_reference_inventory_ledger_v1",
    status: "passed",
    source_script_hash: sourceScriptHash,
    policy: "fixture director inventory",
    summary: {
      asset_count: assets.length,
      by_kind: {},
      by_recommended_generation_mode: {},
      by_director_role: {},
    },
    assets,
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  return ledgerPath;
}

function testSemanticSceneAnchorValidation() {
  const script = [
    "Joey entered the boardroom with the signed receipt.",
    "The screen changed and Victor stopped smiling.",
    "He did not need to speak.",
  ].join(" ");
  const validFindings = semanticSceneAnchorFindingsForTests([
    {
      scene_id: "scene_001",
      title: "Receipt Enters Boardroom",
      script_excerpt_start: "Joey entered the boardroom with the signed receipt.",
      script_excerpt_end: "The screen changed and Victor stopped smiling.",
    },
    {
      scene_id: "scene_002",
      title: "Silence Wins",
      script_excerpt_start: "He did not need to speak.",
      script_excerpt_end: "He did not need to speak.",
    },
  ], script);
  assert.deepEqual(validFindings, []);

  const brokenFindings = semanticSceneAnchorFindingsForTests([
    {
      scene_id: "scene_001",
      title: "Broken End",
      script_excerpt_start: "The screen changed and Victor stopped smiling.",
      script_excerpt_end: "Joey did not need to speak.",
    },
  ], script);
  assert.equal(brokenFindings.some((finding) => finding.code === "semantic_end_anchor_not_found"), true);
}

function testSemanticSceneQualityFindings() {
  const findings = semanticSceneQualityFindingsForTests([
    {
      scene_id: "scene_001",
      title: "Mixed Semantic Fixture",
      location: "Joey's office and phone-message view with system dashboard overlay",
      visible_subjects: ["Joey Manhwa", "online public through comments"],
      character_states: [{ character: "Joey", state: "watching the phone", wardrobe: "dark suit" }],
      props: ["conference room screen", "signed receipt"],
      ui_text_on_screen: ["This is a very long multi-line legal-system notice that should become a concise panel motif instead of baked image text."],
      visual_intent: "Show the hook payoff for the viewer.",
    },
  ]);
  const codes = new Set(findings.map((finding) => finding.code));
  assert.equal(codes.has("semantic_mixed_location_contract"), true);
  assert.equal(codes.has("semantic_generic_visible_subject"), true);
  assert.equal(codes.has("semantic_prop_location_or_ui_bleed"), true);
  assert.equal(codes.has("semantic_dense_ui_text"), true);
  assert.equal(codes.has("semantic_character_alias_churn"), true);
  assert.equal(codes.has("semantic_editorial_meta_language"), true);
  const missingLocationFindings = semanticSceneQualityFindingsForTests([
    {
      scene_id: "scene_002",
      title: "Location Missing Ref",
      location: "tribunal witness floor",
      visible_subjects: ["Joey Manhwa"],
      ref_requirements: [{ kind: "character", ref_id: "char_joey_manhwa" }],
    },
  ]);
  assert.equal(
    missingLocationFindings.some((finding) => finding.code === "semantic_physical_scene_missing_location_ref_requirement" && finding.severity === "blocker"),
    true
  );
}

function testSemanticPlannerPromptContracts() {
  const prompt = semanticBuildPromptForTests("Joey entered the office.", {}, {
    words: 4,
    target: 1,
    minimum: 1,
    maximum: 2,
  });
  assert.match(prompt, /one visible physical environment/i);
  assert.match(prompt, /not a mixture of UI, overlays, phone views, document views, remote call locations, or montage destinations/i);
  assert.match(prompt, /Do not alternate between a first name and a full name/i);
  assert.match(prompt, /props means tangible foreground objects/i);
  assert.match(prompt, /Do not put rooms, doors, windows, desks, walls, stages, screens, dashboards, webpages, feeds, architecture/i);
  assert.match(prompt, /ui_text_on_screen should be concise/i);
  assert.match(prompt, /not automatic standalone image-generation orders/i);
  assert.match(prompt, /Keep character state layers separate/i);
  assert.match(prompt, /visible_state is for physical facts the camera can see/i);
  assert.match(prompt, /financially, or emotionally ruined/i);
  assert.match(prompt, /do not convert abstract phrases like broke, ruined, betrayed, humiliated, indebted, or emotionally collapsed/i);
  assert.match(prompt, /do not summarize, paraphrase, remove clauses, or change quotation marks/i);
}

function testSemanticChunkingSplitsLongSingleParagraph() {
  const sentence = "Joey entered the office and the screen changed before anyone spoke.";
  const script = Array.from({ length: 80 }, (_item, index) => `${sentence} Scene ${index + 1} ended with a receipt.`).join(" ");
  const chunks = semanticScriptChunksForTests(script, 120);
  const totalWords = script.trim().split(/\s+/).length;
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks[0].word_start_index, 0);
  assert.equal(chunks.at(-1).word_end_index_exclusive, totalWords);
  assert.equal(chunks.every((chunk) => chunk.words <= 120), true);
  assert.equal(chunks.slice(1).every((chunk, index) => chunk.word_start_index < chunks[index].word_end_index_exclusive), true);
  assert.equal(chunks.slice(1).every((chunk) => chunk.overlap_words > 0), true);
}

function testBoundedProofBaselineScoping() {
  const script = Array.from({ length: 20 }, (_, index) => `word${index}`).join(" ");
  const timing = {
    words: Array.from({ length: 10 }, (_, index) => ({ word: `word${index}`, start_sec: index, end_sec: index + 0.8 })),
  };
  const scope = semanticProofScopeForTests(script, timing, 0, 5, 2);
  assert.equal(scope.scoped, true);
  assert.equal(scope.baseline_timing_word_count, 5);
  assert.equal(scope.source_word_end_exclusive, 7);
  assert.equal(scope.script.trim().split(/\s+/).length, 7);
  const words = scopedBaselineWordsForTests(timing.words, 2, 5);
  assert.equal(words.length, 3);
  assert.equal(words[0].start_sec, 0);
  assert.equal(words.at(-1).end_sec, 2.8);
  assert.equal(commandStageFor("run", "import-proof-baseline", {}), "voice_plan");
  assert.equal(factLedgerMatchesScriptForTests({ status: "passed", source_script_hash: "scoped-hash", source_hashes: { "/script.md": "locked-hash" } }, "/script.md", "locked-hash"), true);
  const identity = { channel: "c", series_slug: "s", week: "w", episode: "ep_01", proof_scope: { mode: "bounded", start_sec: 0, end_sec: 300 } };
  assert.match(buildStageCommand("semantic_scene_plan", identity), /--proof-baseline-word-timing .* --scope-start-sec 0 --scope-end-sec 300/);
  assert.match(buildStageCommand("visual_beat_plan", identity), /--scope-start-sec 0 --scope-end-sec 300/);
  const prefix = scriptPrefixForTimedWordsForTests(
    "One two three. [Opening death avoided.] Later unrelated story continues for hours.",
    ["one", "two", "three", "opening", "death", "avoided"].map((word) => ({ word })),
  );
  assert.equal(prefix.script.trim(), "One two three. [Opening death avoided.]");
  assert.equal(prefix.fallback, false);
  const multilineScope = semanticProofScopeForTests(
    "First line.\n\n[Exact UI line.]\nFinal line.",
    { words: [
      { word: "First", start_sec: 0 },
      { word: "line", start_sec: 0.3 },
      { word: "Exact", start_sec: 0.6 },
      { word: "UI", start_sec: 0.9 },
    ] },
    0,
    1,
    0,
  );
  assert.equal(multilineScope.script, "First line.\n\n[Exact UI");
}

function testSemanticReconciliationEvidenceContract() {
  const script = "Joey entered Analytics Hall. He carried the silver key. Joey left for the roof.";
  const prompt = semanticReconciliationPromptForTests(script, {}, [{
    chunk: { chunk_index: 1, word_start_index: 0, word_end_index_exclusive: 13, overlap_words: 0 },
    llm: { parsed: { scenes: [] } },
  }], { target: 2, minimum: 1, maximum: 3 });
  assert.match(prompt, /evidence reconciliation, not story invention/i);
  assert.match(prompt, /exact_excerpt copied verbatim/i);
  assert.match(prompt, /Overlapping chunks intentionally repeat evidence/i);
  assert.equal(sanitizeCanonicalIdForTests("academy_evacu\u200bation_fork"), "academy_evacuation_fork");
  const valid = {
    canonical_entities: [{ entity_id: "joey", evidence: [{ exact_excerpt: "Joey entered Analytics Hall.", confidence: 0.99 }] }],
    canonical_locations: [{ location_id: "analytics_hall", evidence: [{ exact_excerpt: "Analytics Hall", confidence: 0.95 }] }],
    canonical_props: [{ prop_id: "silver_key", evidence: [{ exact_excerpt: "silver key", confidence: 0.9 }] }],
    canonical_ui_motifs: [],
    state_transitions: [{
      entity_id: "joey",
      transition_evidence_excerpt: "Joey left for the roof.",
      evidence: [{ exact_excerpt: "Joey left for the roof.", confidence: 0.9 }],
    }],
  };
  assert.deepEqual(storyFactEvidenceFindingsForTests(valid, script), []);
  const invalid = structuredClone(valid);
  invalid.canonical_props[0].evidence[0] = { exact_excerpt: "gold key", confidence: 2 };
  const findings = storyFactEvidenceFindingsForTests(invalid, script);
  assert.equal(findings.some((finding) => finding.code === "fact_evidence_not_exact"), true);
  assert.equal(findings.some((finding) => finding.code === "fact_confidence_invalid"), true);
  const missingBoundary = structuredClone(valid);
  delete missingBoundary.state_transitions[0].transition_evidence_excerpt;
  assert.equal(storyFactEvidenceFindingsForTests(missingBoundary, script).some((finding) => finding.code === "state_transition_evidence_not_exact"), true);
}

function testEditorialBeatDirectorContracts() {
  const script = [
    "Joey enters the hall with calm eyes.",
    "Joey opens the blue system panel slowly.",
    "Joey changes into a black academy coat.",
    "Joey faces Victor beside the exam platform.",
  ].join(" ");
  const spoken = [...script.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)].map((match, index) => ({
    index,
    word: match[0],
    normalized: match[0].toLowerCase(),
    start_sec: Number((index * 0.4).toFixed(3)),
    end_sec: Number(((index + 1) * 0.4).toFixed(3)),
  }));
  const timedScenes = [{
    scene_id: "scene_001",
    start_sec: 0,
    end_sec: spoken.at(-1).end_sec,
    location: "Academy Exam Hall",
    visible_subjects: ["Joey", "Victor"],
    character_states: [
      { character: "Joey", wardrobe: "plain gray student shirt", visible_state: "calm eyes" },
      { character: "Victor", wardrobe: "Not specified." },
    ],
  }];
  const ledger = {
    canonical_entities: [
      { entity_id: "joey", display_name: "Joey", aliases: [] },
      { entity_id: "victor", display_name: "Victor", aliases: [] },
    ],
    canonical_locations: [{ location_id: "academy_exam\u200b_hall", display_name: "Academy Exam Hall", aliases: [] }],
    state_transitions: [
      {
        entity_id: "joey",
        state_kind: "wardrobe",
        from_state: "plain gray student shirt",
        to_state: "black academy coat",
        transition_evidence_excerpt: "Joey opens the blue system panel slowly. Joey changes into a black academy coat.",
        evidence: [{ exact_excerpt: "Joey opens the blue system panel slowly. Joey changes into a black academy coat.", confidence: 1 }],
      },
      {
        entity_id: "joey",
        state_kind: "status",
        from_state: "waiting for the exam challenge",
        to_state: "facing Victor at the exam platform",
        transition_evidence_excerpt: "Joey faces Victor beside the exam platform.",
        evidence: [
          { exact_excerpt: "Joey enters the hall with calm eyes.", confidence: 1 },
          { exact_excerpt: "Joey faces Victor beside the exam platform.", confidence: 1 },
        ],
      },
      {
        entity_id: "joey",
        state_kind: "possession",
        from_state: "Not holding the silver key",
        to_state: "Temporarily holding the silver key",
        transition_evidence_excerpt: "Joey opens the blue system panel slowly.",
        evidence: [{ exact_excerpt: "Joey opens the blue system panel slowly.", confidence: 1 }],
      },
    ],
  };
  const atoms = buildTranscriptAtoms(script, spoken, timedScenes, ledger);
  assert.equal(atoms.length, 4);
  assert.equal(atoms[0].source_word_start_index, 0);
  assert.equal(atoms.at(-1).source_word_end_index, spoken.length - 1);
  assert.equal(atoms[1].transition_barrier_before, true);
  assert.equal(atoms[3].transition_barrier_before, true);
  const raw = {
    beats: atoms.map((atom, index) => ({
      source_atom_ids: [atom.atom_id],
      visual_job: index === 1 ? "system_reveal" : "story_progression",
      shot_job: index === 1 ? "ui_reveal" : "interaction",
      depiction_mode: "current_reality",
      location_id: "academy_exam\u200b_hall",
      physically_visible_entity_ids: index === 3 ? ["joey", "victor"] : ["joey"],
      screen_visible_entity_ids: [],
      preview_visible_entity_ids: [],
      mentioned_only_entity_ids: [],
      primary_entity_id: "joey",
      entity_evidence: index === 3 ? { joey: "JOEY", victor: "VICTOR" } : { joey: "JOEY" },
      props: index === 0 ? [{ type: "personal_item", name: "silver key" }] : [],
      ui_elements: index === 1 ? [{ type: "system_window", text: "blue system panel" }] : [],
      foreground_action: atom.text,
      foreground_action_evidence: atom.text,
      composition_intent: "Keep the named action and spatial relationship readable.",
      continuity_note: "",
      editorial_cues: [],
      rail_exception: null,
    })),
  };
  const normalized = normalizeEditorialGrouping(raw, atoms, ledger, "ep_01");
  assert.equal(normalized.beats[0].visual_beat_id.startsWith("beat_w"), true);
  assert.equal(normalized.beats[0].location_id, "academy_exam_hall");
  assert.equal(normalized.beats[0].image_id_hint.startsWith("ep_01-w"), true);
  assert.deepEqual(normalized.beats[0].local_props, ["silver key"]);
  assert.deepEqual(normalized.beats[1].local_ui_elements, ["blue system panel"]);
  assert.deepEqual(editorialBeatCoverageFindings(normalized.beats, spoken.length), []);
  assert.deepEqual(editorialRetentionRailFindings(closeVisualBeatTimelineForTests(normalized.beats, spoken.at(-1).end_sec)), []);
  const projected = projectActiveStateConstraints(normalized.beats, atoms, ledger, timedScenes);
  assert.equal(projected[0].active_state_constraints.entities.joey.wardrobe, "plain gray student shirt");
  assert.equal(projected[0].active_state_constraints.entities.joey.visible_state, undefined);
  assert.equal(projected[0].active_state_constraints.entities.joey.status, undefined);
  assert.equal(projected[0].active_state_constraints.entities.joey.possession, undefined);
  assert.equal(projected[1].active_state_constraints.entities.joey.wardrobe, "plain gray student shirt");
  assert.equal(projected[1].active_state_constraints.entities.joey.possession, "Temporarily holding the silver key");
  assert.equal(projected[2].active_state_constraints.entities.joey.wardrobe, "black academy coat");
  assert.equal(projected[2].active_state_constraints.entities.joey.possession, undefined);
  assert.equal(projected[3].active_state_constraints.entities.joey.status, "facing Victor at the exam platform");
  assert.equal(projected[3].active_state_constraints.entities.victor.wardrobe, undefined);
  assert.equal(projected[0].active_state_constraints.entities.joey.state_evidence, undefined);
  assert.equal(projected[3].active_state_constraints.entities.joey.state_evidence.status, "Joey faces Victor beside the exam platform.");
  const invalid = structuredClone(raw);
  invalid.beats = [{ ...raw.beats[0], source_atom_ids: [atoms[0].atom_id, atoms[1].atom_id], rail_exception: "mandatory transition" }, raw.beats[2], raw.beats[3]];
  assert.throws(() => normalizeEditorialGrouping(invalid, atoms, ledger, "ep_01"), /editorial beat contract failed/i);
  const missingActionEvidence = structuredClone(raw);
  delete missingActionEvidence.beats[0].foreground_action_evidence;
  assert.throws(() => normalizeEditorialGrouping(missingActionEvidence, atoms, ledger, "ep_01"), /editorial_foreground_action_evidence_missing/i);
  const pauseInflated = structuredClone(atoms);
  pauseInflated[1].start_sec = 5;
  pauseInflated[1].end_sec = Math.max(5.4, pauseInflated[1].end_sec + 2);
  assert.throws(() => normalizeEditorialGrouping(raw, pauseInflated, ledger, "ep_01"), /editorial_retention_rail_violation/i);
  const prompt = buildEditorialDirectorPrompt(atoms, ledger, timedScenes);
  assert.match(prompt, /You own visual job, depiction mode/i);
  assert.match(prompt, /Never merge across an atom with transition_barrier_before=true/i);
  assert.deepEqual(retentionRailForTime(0), { band: "0_30", min_sec: 2.2, max_sec: 4.5 });
  assert.deepEqual(retentionRailForTime(1300), { band: "1200_plus", min_sec: 7, max_sec: 15 });
}

function testEditorialBeatTimelineClosure() {
  const closed = closeVisualBeatTimelineForTests([
    { visual_beat_id: "beat_a", start_sec: 0, end_sec: 2.7, duration_sec: 2.7 },
    { visual_beat_id: "beat_b", start_sec: 3, end_sec: 6.5, duration_sec: 3.5 },
    { visual_beat_id: "beat_c", start_sec: 7, end_sec: 9.4, duration_sec: 2.4 },
  ], 10);
  assert.deepEqual(closed.map((beat) => [beat.start_sec, beat.end_sec, beat.duration_sec]), [
    [0, 3, 3],
    [3, 7, 4],
    [7, 10, 3],
  ]);
  assert.throws(() => closeVisualBeatTimelineForTests([
    { visual_beat_id: "beat_a", start_sec: 0 },
    { visual_beat_id: "beat_b", start_sec: 0 },
  ], 3), /non-increasing starts/i);
}

function testSemanticAnchorSnapsToExactScriptTokens() {
  const script = [
    "On Monday morning, Joey arrived with a U.S.B. drive in one hand.",
    "\"I cared.\"",
    "\"Systems outlast anger.\"",
  ].join(" ");
  const { scenes, snaps } = semanticSnapSceneAnchorsForTests([
    {
      scene_id: "scene_001",
      script_excerpt_start: "On Monday morning, Joey arrived with a U. S. B. drive in one hand.",
      script_excerpt_end: "He cared.",
    },
    {
      scene_id: "scene_002",
      script_excerpt_start: "Systems outlast anger.",
      script_excerpt_end: "Systems outlast anger.",
    },
  ], script);
  assert.equal(scenes[0].script_excerpt_start, "On Monday morning, Joey arrived with a U.S.B. drive in one hand");
  assert.equal(scenes[0].script_excerpt_end, "cared");
  assert.equal(scenes[1].script_excerpt_start, "Systems outlast anger");
  assert.equal(snaps.some((snap) => snap.snap_type === "token_suffix"), true);
}

function testFirstPersonBeatKeepsProtagonistVisible() {
  const scene = {
    scene_id: "scene_015",
    primary_subject: "Dorian Vale",
    visible_subjects: ["Dorian Vale"],
    ref_requirements: [
      { kind: "character", ref_id: "joey_manhwa", reason: "recurring protagonist visible during punishment" },
      { kind: "character", ref_id: "dorian_vale", reason: "named antagonist undergoes punishment" },
    ],
  };
  const beatText = "Dorian looked at it, then at me. This is childish. I walked around the desk.";
  const visible = visualBeatInternalsForTests.localVisibleCharacters(scene, beatText);
  assert.deepEqual(visible, ["Joey Manhwa", "Dorian Vale"]);
  const refNeeds = visualBeatInternalsForTests.localBeatReferenceNeeds(scene, {
    scene_id: "scene_015",
    parent_scene_id: "scene_015",
    visual_beat_id: "scene_015_beat_02",
    start_sec: 758.66,
    visual_beat_script_excerpt: beatText,
    visual_job: "interaction",
    suggested_shot_job: "interaction",
  }, { visibleCharacters: visible });
  const characterRefIds = refNeeds.filter((need) => need.kind === "character").map((need) => need.ref_id);
  assert.deepEqual(new Set(characterRefIds), new Set(["joey_manhwa", "dorian_vale"]));
}

function testWhisperExcerptAlignmentInterpolatesUnspokenUi() {
  const result = alignExcerptRowsToWhisper([
    { visual_beat_id: "beat_1", start_sec: 0, end_sec: 2, duration_sec: 2, visual_beat_script_excerpt: "Joey entered the academy gate in the rain." },
    { visual_beat_id: "beat_2", start_sec: 2, end_sec: 4, duration_sec: 2, visual_beat_script_excerpt: "Role assigned Extra 418. Importance disposable." },
    { visual_beat_id: "beat_3", start_sec: 4, end_sec: 6, duration_sec: 2, visual_beat_script_excerpt: "A knight screamed for every candidate to run left." },
  ], [
    { word: "Joey", start_sec: 0 }, { word: "entered", start_sec: 0.2 }, { word: "the", start_sec: 0.4 }, { word: "academy", start_sec: 0.6 }, { word: "gate", start_sec: 0.8 }, { word: "in", start_sec: 1 }, { word: "the", start_sec: 1.2 }, { word: "rain", start_sec: 1.4 },
    { word: "A", start_sec: 3 }, { word: "knight", start_sec: 3.2 }, { word: "screamed", start_sec: 3.4 }, { word: "for", start_sec: 3.6 }, { word: "every", start_sec: 3.8 }, { word: "candidate", start_sec: 4 }, { word: "to", start_sec: 4.2 }, { word: "run", start_sec: 4.4 }, { word: "left", start_sec: 4.6 },
  ], { minimumScore: 0.75 });
  assert.equal(result.summary.matched_count, 2);
  assert.equal(result.summary.interpolated_count, 1);
  assert.equal(result.rows[0].start_sec, 0);
  assert.equal(result.rows[1].start_sec > 0 && result.rows[1].start_sec < 3, true);
  assert.equal(result.rows[2].start_sec, 3.2);
  assert.equal(result.rows[1].whisper_excerpt_alignment.status, "interpolated_unspoken_or_low_confidence");
}

function testPhraseAwareSubtitleGrouping() {
  const merged = mergeShortSubtitleEvents([
    { start_sec: 0, end_sec: 0.45, text: "The" },
    { start_sec: 0.46, end_sec: 1.75, text: "system opened" },
    { start_sec: 1.9, end_sec: 2.2, text: "No!" },
    { start_sec: 2.45, end_sec: 2.78, text: "And" },
    { start_sec: 2.79, end_sec: 4.0, text: "then I ran" },
  ]);
  assert.deepEqual(merged.map((row) => row.text), ["The system opened", "No!", "And then I ran"]);
  assert.equal(merged.filter((row) => row.text.split(/\s+/).length === 1).length, 1);
}

function testQwenKeepsBracketedUiDialogueSpeakable() {
  const spoken = ttsSafeTextForTests("[CHAPTER ZERO ACTIVATED. SURVIVE THE CARRIAGE.]");
  assert.match(spoken, /chapter zero activated/i);
  assert.match(spoken, /survive the carriage/i);
  assert.doesNotMatch(spoken, /[\[\]]/);
}

async function testEpisodeLocalAmbienceSpecContract() {
  const valid = {
    status: "approved",
    source_script_hash: "script-hash",
    ambience_specs: [{
      cue_id: "guild_hall_air",
      scene_ids: ["scene_001"],
      sound_description: "large stone guild hall room tone with distant boots and banner cloth",
      beat_reason: "grounds the current scene",
    }],
  };
  assert.deepEqual(validateAmbienceSpecForTests(valid, "script-hash", ["scene_001"]), []);
  assert.equal(validateAmbienceSpecForTests(valid, "different-hash", ["scene_001"]).includes("ambience_spec_source_hash_mismatch"), true);
  const runtime = await fs.readFile("scripts/audio-ambience-repair.mjs", "utf8");
  assert.doesNotMatch(runtime, /Northbridge|Sarah|Damien|Vivienne/);
  const historicalFixture = await fs.readFile("scripts/fixtures/audio/northbridge_ambience_spec.example.json", "utf8");
  assert.match(historicalFixture, /Northbridge/);
}

function testImageOutputQaRiskAndDonorPolicies() {
  const reasons = imageRiskReasons({
    start_sec: 420,
    visual_beat_action: "Joey lifts the carriage and rescues Arielle",
    shot_manifest: { visible_characters: ["Joey", "Arielle", "Guard"], shot_job: "physical_action" },
    reference_requirements: [{}, {}, {}, {}],
  });
  assert.equal(reasons.includes("physical_action_geometry"), true);
  assert.equal(reasons.includes("dense_cast"), true);
  assert.equal(reasons.includes("four_reference_integration"), true);
  assert.equal(donorRecoveryFinding({ donor_image_id: "cut_001", hash_perturbation: true }, "cut_002")?.code, "scene_image_donor_recovery_forbidden");

  const riskRows = [{
    image_id: "cut_001",
    image_sha256: "hash-a",
    image_path: "/tmp/cut_001.png",
    start_sec: 1,
    risk_reasons: ["opening_retention"],
    requires_manual_risk_review: true,
  }];
  const accepted = mergeRiskReviewDecisions(riskRows, {}, {
    reviewer: "fixture",
    note: "inspected exact image hash",
    acceptedIds: ["cut_001"],
  });
  assert.equal(accepted.status, "complete");
  assert.equal(accepted.decisions[0].decision, "accepted");
  const resumed = mergeRiskReviewDecisions(riskRows, accepted, { reviewer: "", note: "" });
  assert.equal(resumed.reviewer, "fixture");
  assert.equal(resumed.note, "inspected exact image hash");
  assert.equal(resumed.decisions[0].decision, "accepted");
  const stale = mergeRiskReviewDecisions([{ ...riskRows[0], image_sha256: "hash-b" }], accepted);
  assert.equal(stale.status, "pending_review");
  assert.equal(stale.decisions[0].decision, "not_inspected");

  const ledgerResult = applyImageQaDecisionsToLedger({
    cuts: [
      { image_id: "cut_001", image_sha256: "hash-a", motion_profile_hash: "motion-a", motion_clip_path: "/tmp/a.mp4", motion_clip_sha256: "clip-a" },
      { image_id: "cut_002", image_sha256: "hash-c", motion_profile_hash: "motion-b", motion_clip_path: "/tmp/b.mp4", motion_clip_sha256: "clip-b" },
    ],
  }, [
    riskRows[0],
    { ...riskRows[0], image_id: "cut_002", image_sha256: "hash-c", requires_manual_risk_review: false },
  ], {
    decisions: [{ image_id: "cut_001", image_sha256: "hash-a", decision: "rejected" }],
  }, new Set(), "fixture", "2026-01-01T00:00:00.000Z");
  assert.deepEqual(ledgerResult.invalidated_motion_image_ids, ["cut_001"]);
  assert.equal(ledgerResult.ledger.cuts[0].motion_clip_path, null);
  assert.equal(ledgerResult.ledger.cuts[1].motion_clip_path, "/tmp/b.mp4");
  assert.equal(ledgerResult.ledger.cuts[1].image_qa_status, "passed_structural");

  const recoveryCommand = scopedQaRecoveryCommand(
    ["cut_001"],
    { prompts: [{ image_id: "cut_001", image_provider_route: "modelslab" }] },
    { image_provider: "modelslab", results: [{ image_id: "cut_001", image_provider: "modelslab" }] },
    { image_provider: "modelslab" },
  );
  assert.match(recoveryCommand, /--skip-reference-generation true/);
  assert.match(recoveryCommand, /--cut-ids cut_001/);
  assert.equal(imageQaNeedsRecovery([], ["cut_001"]), true);
  assert.equal(imageQaNeedsRecovery([], []), false);
}

async function testProviderCircuitBreakerStopsUnclaimedWork() {
  const items = Array.from({ length: 8 }, (_, index) => ({ image_id: `cut_${index + 1}` }));
  const result = await runPoolWithCircuitBreakerForTests(items, async () => {
    throw new Error("503 gateway unavailable");
  }, 1);
  assert.equal(result.circuit_open, true);
  assert.equal(result.results.filter((row) => row.status === "failed").length, 3);
  assert.equal(result.results.filter((row) => row.status === "skipped_provider_circuit_open").length, 5);
}

async function testProviderConcurrencyBacksOffAndRecovers() {
  const items = Array.from({ length: 16 }, (_, index) => ({ image_id: `cut_${index + 1}` }));
  let failedOnce = false;
  const result = await runPoolWithCircuitBreakerForTests(items, async (item) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (!failedOnce) {
      failedOnce = true;
      throw new Error("429 provider queue rate limit");
    }
    return { image_id: item.image_id, status: "generated" };
  }, 8);
  assert.equal(result.circuit_open, false);
  assert.equal(result.adaptive_concurrency.configured, 8);
  assert.equal(result.adaptive_concurrency.minimum < 8, true);
  assert.equal(result.adaptive_concurrency.events.some((row) => row.type === "provider_backoff"), true);
}

function testDirectedMotionAndFullTimelineTransitions() {
  assert.deepEqual(positionAnchorFromStaging("small lower-left foreground"), { x: 0.3, y: 0.65 });
  assert.deepEqual(positionAnchorFromStaging("frame-right deep background"), { x: 0.7, y: 0.42 });
  assert.deepEqual(positionAnchorFromStaging("lower-center beneath the system display"), { x: 0.5, y: 0.65 });
  const prompt = {
    image_id: "cut_004",
    scene_id: "scene_002",
    visual_beat_id: "beat_004",
    start_sec: 240,
    duration_sec: 8,
    shot_manifest: {
      shot_job: "physical_action",
      primary_character: "Joey",
      character_staging: [{ name: "Joey", screen_position: "frame-left", pose: "lunges forward" }],
    },
  };
  const intent = motionIntentForPrompt(prompt, "hash-4");
  assert.equal(intent.behavior, "lateral_follow");
  assert.equal(intent.end_anchor.x, 0.3);
  assert.deepEqual(motionIntentFindings([intent], { cut_004: "hash-4" }), []);
  const trace = motionTraceForIntent(intent, 60);
  assert.equal(trace.length, 480);
  assert.deepEqual(motionTraceFindings(trace), []);

  const focusShift = motionIntentForPrompt({
    image_id: "cut_focus",
    duration_sec: 6,
    shot_manifest: {
      shot_job: "interaction",
      primary_character: "Joey",
      character_staging: [
        { name: "Joey", screen_position: "frame-left foreground" },
        { name: "Arielle", screen_position: "frame-right midground" },
      ],
    },
  }, "hash-focus");
  assert.equal(focusShift.behavior, "focus_shift");
  assert.deepEqual(focusShift.start_anchor, { x: 0.7, y: 0.5 });
  assert.deepEqual(focusShift.end_anchor, { x: 0.3, y: 0.58 });
  assert.deepEqual(motionTraceFindings(motionTraceForIntent(focusShift, 60)), []);

  const terminalIntent = motionIntentForPrompt({
    image_id: "cut_terminal",
    start_sec: 297.48,
    duration_sec: 2.52,
    shot_manifest: { shot_job: "ui_reveal", primary_character: "Joey" },
  }, "hash-terminal", null, { timelineEndSec: 299.901995 });
  assert.equal(Number(terminalIntent.duration_sec.toFixed(6)), 2.421995);

  const staticIntent = motionIntentForPrompt({ image_id: "cut_005", duration_sec: 10, shot_manifest: {} }, "hash-5");
  assert.equal(staticIntent.behavior, "static_hold");
  assert.equal(staticIntent.start_scale, staticIntent.end_scale);

  const groups = xfadeTimelineGroupsForTests(
    ["cut_001", "cut_002", "cut_003", "cut_004", "cut_005", "cut_006"],
    ["cut_002", "cut_005"],
  );
  assert.deepEqual(groups, [["cut_001", "cut_002"], ["cut_003"], ["cut_004", "cut_005"], ["cut_006"]]);
}

async function testRenderRequiresHashMatchedImageQa() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-render-qa-"));
  const imagePath = path.join(tempDir, "cut_001.png");
  await fs.writeFile(imagePath, Buffer.from("fixture image bytes"));
  const imageHash = sha256(await fs.readFile(imagePath));
  const promptPlan = { prompts: [{ image_id: "cut_001", image_generation_required: true }] };
  const imagegenReport = { results: [{ image_id: "cut_001", image_path: imagePath }] };
  const promptPlanPath = path.join(tempDir, "prompts.json");
  const imagegenReportPath = path.join(tempDir, "imagegen.json");
  await writeJson(promptPlanPath, promptPlan);
  await writeJson(imagegenReportPath, imagegenReport);
  const identity = { image_output_qa_required: true };
  const imageOutputQa = {
    status: "passed",
    prompt_plan_sha256: sha256(await fs.readFile(promptPlanPath)),
    imagegen_report_sha256: sha256(await fs.readFile(imagegenReportPath)),
    accepted_image_hashes: { cut_001: imageHash },
  };
  const ledger = { cuts: [{ image_id: "cut_001", image_sha256: imageHash, image_qa_status: "passed_manual_risk" }] };
  const options = { promptPlanPath, imagegenReportPath };
  const result = await assertRenderImageIntegrityForTests(promptPlan, imagegenReport, identity, imageOutputQa, ledger, options);
  assert.equal(result.checked_image_count, 1);
  await fs.writeFile(imagePath, Buffer.from("changed after review"));
  await assert.rejects(
    () => assertRenderImageIntegrityForTests(promptPlan, imagegenReport, identity, imageOutputQa, ledger, options),
    /changed after output QA/i,
  );
}

async function testPreflightLocksNativeTtsSpeedAndSmoothRender() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  await execFileAsync(process.execPath, [
    "scripts/run-preflight.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--title", "Fixture",
    "--image-provider", "modelslab",
    "--run-intent", "diagnostic",
    "--allow-dirty-worktree", "true",
    "--dirty-reason", "fixture test",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const identity = await readJson(path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01", "run_identity.json"));
  assert.equal(identity.qwen_native_speed, 1.25);
  assert.equal(identity.voice_provider_options.pace_strategy, "provider_native_speed_no_post_tempo");
  assert.equal(identity.production_gates.post_tempo_normalization_default, false);
  assert.equal(identity.render_profile, "smooth_fast_ken_burns");
  assert.equal(identity.image_output_qa_required, true);
  assert.equal(identity.schema, "goldflow_run_identity_v2");
  assert.equal(typeof identity.git.commit, "string");
  assert.equal(identity.git.commit.length, 40);
  assert.equal(identity.stage_registry_version.length > 0, true);
  assert.equal(identity.model_versions.planning_model, "gpt-5.6-sol");
}

async function testPostTempoRequiresEmergencyApproval() {
  let error = null;
  try {
    await execFileAsync(process.execPath, ["scripts/narration-tempo-normalize.mjs"], { cwd: process.cwd() });
  } catch (caught) {
    error = caught;
  }
  assert.notEqual(error, null);
  assert.match(String(error.stderr ?? error.message), /emergency-only/i);
}

function testLocationSceneIdsDerivation() {
  const semanticScenes = [
    { scene_id: "scene_001", location: "apartment kitchen", ref_requirements: [{ kind: "location", ref_id: "loc_apartment" }] },
    { scene_id: "scene_003", location: "boardroom", ref_requirements: [{ kind: "location", ref_id: "loc_boardroom" }] },
    { scene_id: "scene_005", location: "apartment kitchen", ref_requirements: [{ kind: "location", ref_id: "loc_apartment" }] },
  ];
  const llmTargets = [
    { ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_999"] },
    { ref_id: "loc_boardroom", kind: "location", scene_ids: [] },
    { ref_id: "style_ref", kind: "style", scene_ids: [] },
  ];
  const { targets } = applyDeterministicLocationSceneIds(llmTargets, semanticScenes);
  const apartment = targets.find((target) => target.ref_id === "loc_apartment");
  const boardroom = targets.find((target) => target.ref_id === "loc_boardroom");
  assert.deepEqual(new Set(apartment.scene_ids), new Set(["scene_999", "scene_001", "scene_005"]));
  assert.deepEqual(new Set(boardroom.scene_ids), new Set(["scene_003"]));
  const beatScoped = applyBeatLocationSceneIds([{ ref_id: "loc_gate", kind: "location", scene_ids: ["scene_012"] }], [
    { scene_id: "scene_001", location_id: "loc_gate" },
    { parent_scene_id: "scene_011", location_id: "loc_gate" },
  ]);
  assert.deepEqual(new Set(beatScoped.targets[0].scene_ids), new Set(["scene_012", "scene_001", "scene_011"]));
}

function testReferenceDirectorV2EvidenceAndLocationContracts() {
  const semanticPlan = {
    status: "passed",
    source_script_hash: "fixture_hash",
    scenes: [{
      scene_id: "scene_010",
      location: "marble tribunal hall",
      ref_requirements: [{
        ref_id: "tribunal_hall_contract",
        kind: "location",
        reason: "mandatory scoped location coverage derived from semantic requirements",
      }],
      visual_beats: [{
        visual_beat_id: "beat_w000010_w000020",
        parent_scene_id: "scene_002",
        location_id: "tribunal_hall_contract",
        local_location: "marble tribunal hall",
        ref_needs: [{ kind: "location", ref_id: "tribunal_hall_contract" }],
      }],
    }],
  };
  const evidence = referenceEvidenceLedgerForTests(semanticPlan);
  const locationAsset = evidence.assets.find((asset) => asset.kind === "location" && asset.semantic_ref_ids.includes("tribunal_hall_contract"));
  assert.equal(locationAsset.subject, "marble tribunal hall");
  assert.equal(Object.hasOwn(locationAsset, "generation_mode"), false);

  const contracts = referenceLocationContractLedgerForTests(semanticPlan);
  assert.equal(contracts.status, "passed");
  assert.equal(contracts.contracts.length, 1);
  assert.equal(contracts.contracts[0].description, "marble tribunal hall");
  assert.deepEqual(new Set(contracts.contracts[0].scene_ids), new Set(["scene_010", "scene_002"]));
  assert.equal(Object.hasOwn(contracts.contracts[0], "generation_mode"), false);

  const scoped = referenceLocationScopeForTests([{
    ref_id: "tribunal_clean_plate",
    kind: "location",
    scene_ids: [],
    location_contract_ids: ["tribunal_hall_contract"],
  }], contracts);
  assert.deepEqual(new Set(scoped.targets[0].scene_ids), new Set(["scene_010", "scene_002"]));
  assert.equal(scoped.findings.length, 0);
  const openingFindings = referenceOpeningIdentityFindingsForTests([{
    ref_id: "hero_base",
    kind: "character_state",
    canonical_subject_id: "hero",
    generation_mode: "manual_review",
    required_before_imagegen: false,
  }], {
    status: "passed",
    beats: [{ scene_id: "scene_001", start_sec: 15, preview_visible_entity_ids: ["hero"] }],
  });
  assert.equal(openingFindings.some((finding) => finding.code === "opening_visible_identity_not_generatable"), true);
}

function testReferenceDirectorV2RejectsDeterministicExpansionAndDerivedCuts() {
  const baseOptions = {
    llmTargetIds: new Set(["joey_identity_ref", "hall_ref"]),
    knownSceneIds: new Set(["scene_001"]),
  };
  const findings = referenceDirectorSelectionFindingsForTests([
    {
      ref_id: "joey_identity_ref",
      kind: "character_state",
      scene_ids: ["scene_001"],
      generation_mode: "standalone_ref",
      canonical_subject_id: "joey",
      evidence_asset_ids: ["character_state_joey"],
      clean_plate_contract: "single-character plain-background identity card",
    },
    {
      ref_id: "hall_ref",
      kind: "location",
      scene_ids: ["scene_001"],
      generation_mode: "derive_from_best_cut",
      canonical_subject_id: "hall",
      evidence_asset_ids: ["location_hall"],
      clean_plate_contract: "environment-only plate",
    },
    {
      ref_id: "deterministically_restored_prop",
      kind: "prop",
      scene_ids: ["scene_001"],
      generation_mode: "standalone_ref",
      canonical_subject_id: "restored_prop",
      evidence_asset_ids: ["prop_restored"],
      clean_plate_contract: "clean prop plate",
    },
    {
      ref_id: "operator_source_face",
      kind: "character_state",
      scene_ids: ["scene_001"],
      generation_mode: "source_only",
    },
  ], baseOptions);
  assert.equal(findings.some((finding) => finding.code === "director_selected_non_clean_reference_mode" && finding.ref_id === "hall_ref"), true);
  assert.equal(findings.some((finding) => finding.code === "post_llm_reference_target_expansion" && finding.ref_id === "deterministically_restored_prop"), true);
  assert.equal(findings.some((finding) => finding.code === "post_llm_reference_target_expansion" && finding.ref_id === "operator_source_face"), false);
  assert.equal(findings.some((finding) => finding.code === "reference_target_not_single_conditioning_concept" && finding.ref_id === "joey_identity_ref"), true);
}

async function testReferencePlanHashApproval() {
  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-ref-approval-"));
  const planPath = path.join(episodeDir, "visual_reference_plan.json");
  await writeJson(planPath, {
    status: "passed",
    reference_director_contract_version: "reference_director_v2",
    findings: [],
    reference_targets: [{
      ref_id: "joey_identity_ref",
      kind: "character_state",
      generation_mode: "standalone_ref",
      scene_ids: ["scene_001"],
      conditioning_subject_count: 1,
      conditioning_asset_role: "identity_state",
    }],
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-reference-plan-approve.mjs",
    "--episode-dir", episodeDir,
    "--note", "fixture review",
  ], { cwd: process.cwd() });
  const approval = await readJson(path.join(episodeDir, "reference_plan_approval.json"));
  assert.equal(approval.status, "approved");
  assert.equal(approval.visual_reference_plan_sha256, sha256(await fs.readFile(planPath)));
  const approvedPlan = await readJson(planPath);
  assert.equal(approval.reference_plan_contract_sha256, referencePlanApprovalContractSha256(approvedPlan));
  assert.equal(approval.selected_targets[0].conditioning_asset_role, "identity_state");
  const generatedPlan = {
    ...approvedPlan,
    reference_generation_updated_at: "2026-07-11T12:00:00.000Z",
    reference_targets: approvedPlan.reference_targets.map((target) => ({
      ...target,
      reference_image_path: "/tmp/generated.png",
      conditioning_image_path: "/tmp/generated.png",
    })),
  };
  assert.equal(referencePlanApprovalMatches({ approval, plan: generatedPlan }), true);
  generatedPlan.reference_targets[0].prompt_anchor = "creatively changed identity";
  assert.equal(referencePlanApprovalMatches({ approval, plan: generatedPlan }), false);
}

function testActiveStateValidationSkipsTextOnlyUiMentions() {
  const source = [{
    active_state_constraints: {
      entities: {
        joey_manhwa: { wardrobe: "archive robe" },
      },
    },
  }];
  const uiOnly = [{
    image_id: "cut_ui",
    image_prompt: "A blue system panel names Joey Manhwa as Extra #418.",
    shot_manifest: {
      visible_characters: [],
      mentioned_only_characters: ["Joey Manhwa"],
      character_staging: [],
    },
  }];
  assert.deepEqual(activeStateConstraintFindingsForTests(uiOnly, source), []);
  const visibleJoey = structuredClone(uiOnly);
  visibleJoey[0].shot_manifest.visible_characters = ["Joey Manhwa"];
  const findings = activeStateConstraintFindingsForTests(visibleJoey, source);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, "wardrobe");
}

function testAdaptiveProviderPromptPackets() {
  const highRows = Array.from({ length: 5 }, (_value, index) => ({
    visual_beat_id: `high_${index}`,
    scene_id: "scene_001",
    start_sec: index * 4,
    visible_characters: ["Joey"],
    visual_job: "story_progression",
  }));
  const mediumRows = Array.from({ length: 7 }, (_value, index) => ({
    visual_beat_id: `medium_${index}`,
    scene_id: "scene_002",
    start_sec: 300 + index * 7,
    visible_characters: ["Joey", "Victor"],
    visual_job: "interaction",
  }));
  const simpleRows = Array.from({ length: 12 }, (_value, index) => ({
    visual_beat_id: `simple_${index}`,
    scene_id: "scene_003",
    start_sec: 600 + index * 10,
    visible_characters: ["Joey"],
    visual_job: "story_progression",
  }));
  const chunks = adaptivePromptChunksForTests([...highRows, ...mediumRows, ...simpleRows]);
  assert.deepEqual(chunks.slice(0, 2).map((chunk) => [chunk.risk_class, chunk.ids.length]), [["high", 4], ["high", 1]]);
  assert.equal(chunks.some((chunk) => chunk.risk_class === "medium" && chunk.ids.length === 6), true);
  assert.equal(chunks.some((chunk) => chunk.risk_class === "simple" && chunk.ids.length === 10), true);

  const source = {
    image_id_hint: "ep_01-w000000-w000010",
    visual_beat_id: "beat_w000000_w000010",
    scene_id: "scene_001",
    parent_scene_id: "scene_001",
    start_sec: 0,
    duration_sec: 3.2,
    local_location: "Academy Hall",
    visible_characters: ["Joey"],
  };
  const authored = {
    image_id: source.image_id_hint,
    scene_id: "scene_001",
    visual_beat_id: source.visual_beat_id,
    provider_prompt: "Joey raises a blue system panel in Academy Hall. 16:9 landscape anime/manhwa frame.",
    image_provider_route: "modelslab",
    visible_subjects: ["Wrong Duplicate Field"],
    shot_manifest: {
      shot_job: "ui_reveal",
      visible_characters: ["Joey"],
      mentioned_only_characters: [],
      primary_character: "Joey",
      character_state_ref_ids: ["joey_ref"],
      protagonist_state_ref_id: "joey_ref",
      location_contract_id: "hall_contract",
      location_ref_id: null,
      foreground_action: "Joey raises the system panel",
      visible_props: [],
      ui_elements: ["blue system panel"],
      forbidden_ref_ids: [],
      reference_slots: [{ ref_id: "joey_ref", kind: "character_state", slot_order: 1, slot_purpose: "Joey identity" }],
      continuity_notes: "current beat",
      character_staging: [{ name: "Joey", ref_id: "joey_ref", screen_position: "frame-center", wardrobe_from: "character_state_ref:joey_ref", pose: "raising panel" }],
    },
  };
  const visualReferencePlan = { reference_targets: [{ ref_id: "joey_ref", kind: "character_state", scene_ids: ["scene_001"], generation_mode: "standalone_ref" }] };
  const normalized = normalizePromptPacketForTests(authored, source, { activeImageProvider: "modelslab", visualReferencePlan });
  assert.equal(normalized.image_id, source.image_id_hint);
  assert.equal(normalized.modelslab_image_prompt, authored.provider_prompt);
  assert.equal(normalized.codex_image_prompt, null);
  assert.deepEqual(normalized.visible_subjects, ["Joey"]);
  assert.deepEqual(normalized.reference_requirements.map((row) => row.ref_id), ["joey_ref"]);
}

function testSelectedReferenceInventoryContainsOnlyDirectorSelections() {
  const inventory = selectedReferenceInventoryForTests([
    { ref_id: "joey_ref", kind: "character_state", generation_mode: "standalone_ref", scene_ids: ["scene_001"] },
    { ref_id: "source_face", kind: "character_state", generation_mode: "source_only", scene_ids: ["scene_001"] },
  ]);
  assert.equal(inventory.schema, "goldflow_reference_inventory_ledger_v2");
  assert.deepEqual(inventory.assets.map((asset) => asset.ref_id), ["joey_ref", "source_face"]);
}

function testReferenceDirectorV2BlocksDanglingAndGroupCharacterStates() {
  const findings = referenceCharacterStateFindingsForTests([
    { state_ref_id: "joey_state", character: "Joey", source_ref_id: "joey_ref" },
    { state_ref_id: "dangling_state", character: "Mira", source_ref_id: "missing_mira_ref" },
    { state_ref_id: "guild_masters_state", character: "guild masters", source_ref_id: "guild_uniform_ref" },
  ], [
    { ref_id: "joey_ref", kind: "character_state" },
    { ref_id: "guild_uniform_ref", kind: "prop" },
  ]);
  assert.equal(findings.some((finding) => finding.code === "character_state_ref_missing_selected_source" && finding.state_ref_id === "dangling_state"), true);
  assert.equal(findings.some((finding) => finding.code === "generic_group_character_state_ref" && finding.state_ref_id === "guild_masters_state"), true);
  assert.equal(findings.some((finding) => finding.state_ref_id === "joey_state"), false);
}

function testLocationCandidateExclusion() {
  const visualReferencePlan = {
    reference_targets: [
      { ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_001", "scene_005"] },
      { ref_id: "loc_boardroom", kind: "location", scene_ids: ["scene_003"] },
      { ref_id: "style_ref", kind: "style", scene_ids: [] },
    ],
  };
  const sceneThreeRefs = referenceTargetsForScene({ scene_id: "scene_003" }, visualReferencePlan).map((target) => target.ref_id);
  assert.deepEqual(new Set(sceneThreeRefs), new Set(["loc_boardroom", "style_ref"]));
  assert.equal(sceneThreeRefs.includes("loc_apartment"), false);
}

function testStarvationGate() {
  const findings = locationCoverageFindings(
    [{ ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_001"] }],
    [
      { scene_id: "scene_001", location: "apartment", ref_requirements: [{ kind: "location", ref_id: "loc_apartment" }] },
      { scene_id: "scene_002", location: "courthouse lobby", ref_requirements: [{ kind: "location", ref_id: "loc_courthouse" }] },
    ]
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "scene_missing_location_ref");
  assert.equal(findings[0].scene_id, "scene_002");
}

function testBroadLocationTargetDoesNotSatisfySemanticLocationRequirement() {
  const findings = locationCoverageFindings(
    [{ ref_id: "creator_classroom_training_refs", kind: "location", scene_ids: ["scene_021"] }],
    [
      {
        scene_id: "scene_021",
        location: "analytics hall replay wall",
        ref_requirements: [{ kind: "location", ref_id: "analytics_hall_replay_wall_ref" }],
      },
    ]
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "scene_missing_location_ref");
  assert.deepEqual(findings[0].required_ref_ids, ["analytics_hall_replay_wall_ref"]);
}

async function testCandidateReferenceBudgetDowngradesScopedOneOffRefs() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  const semanticScenes = [
    {
      scene_id: "scene_001",
      start_sec: 12,
      location: "opening system bedroom",
      ref_requirements: [{ kind: "location", ref_id: "opening_room_ref" }],
    },
    {
      scene_id: "scene_002",
      start_sec: 420,
      location: "late one-off hallway",
      ref_requirements: [{ kind: "location", ref_id: "late_room_ref" }],
    },
    {
      scene_id: "scene_003",
      start_sec: 520,
      location: "minor recurring lobby",
      ref_requirements: [{ kind: "location", ref_id: "minor_lobby_ref" }],
    },
    {
      scene_id: "scene_004",
      start_sec: 620,
      location: "minor recurring lobby",
      ref_requirements: [{ kind: "location", ref_id: "minor_lobby_ref" }],
    },
    {
      scene_id: "scene_005",
      start_sec: 720,
      location: "key recurring throne hall",
      ref_requirements: [{ kind: "location", ref_id: "key_hall_ref" }],
    },
    {
      scene_id: "scene_006",
      start_sec: 820,
      location: "key recurring throne hall",
      ref_requirements: [{ kind: "location", ref_id: "key_hall_ref" }],
    },
    {
      scene_id: "scene_007",
      start_sec: 920,
      location: "key recurring throne hall",
      ref_requirements: [{ kind: "location", ref_id: "key_hall_ref" }],
    },
    {
      scene_id: "scene_008",
      start_sec: 1020,
      location: "late director-selected battle bridge",
      ref_requirements: [{ kind: "location", ref_id: "late_key_anchor_ref" }],
    },
    {
      scene_id: "scene_009",
      start_sec: 1120,
      location: "late director-selected battle bridge",
      ref_requirements: [{ kind: "location", ref_id: "late_key_anchor_ref" }],
    },
  ];
  for (const scene of semanticScenes) {
    scene.visible_subjects = ["Joey Manhwa"];
    if (scene.scene_id === "scene_001" || scene.scene_id === "scene_004") scene.visible_subjects.push("Victor");
    if (scene.scene_id === "scene_004") scene.visible_subjects.push("restrained authority figure");
    scene.props = ["critical recurring poison ring", "one-scene signed receipt"];
    scene.ui_text_on_screen = ["signature system quest UI"];
    if (scene.scene_id === "scene_002") scene.ui_text_on_screen.push("Unauthorized data leak");
  }
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "manhwa_candidate_validation",
    week: "run",
    episode: "ep_01",
    pace_policy: "diagnostic",
    image_provider: "hybrid_modelslab_refs_codex_opening_modelslab_rest",
    image_provider_options: { codex_opening_sec: 300 },
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    scenes: semanticScenes,
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats: semanticScenes.flatMap((scene) => {
      const repeatCount = scene.scene_id === "scene_008" || scene.scene_id === "scene_009" ? 4 : 1;
      return Array.from({ length: repeatCount }, (_, beatIndex) => ({
        scene_id: scene.scene_id,
        parent_scene_id: scene.scene_id,
        visual_beat_id: `${scene.scene_id}_beat_${String(beatIndex + 1).padStart(2, "0")}`,
        start_sec: scene.start_sec + beatIndex * 8,
        duration_sec: 6,
        visual_beat_script_excerpt: `Joey Manhwa and ${scene.visible_subjects.includes("Victor") ? "Victor" : "the system"} appear in ${scene.location} with the critical poison ring.`,
        visible_characters: scene.visible_subjects,
        local_location: scene.location,
        local_props: scene.scene_id === "scene_002" ? ["one-scene signed receipt", "critical recurring poison ring"] : ["critical recurring poison ring"],
        local_ui_elements: scene.scene_id === "scene_002"
          ? ["signature system quest UI", "Unauthorized data leak"]
          : ["signature system quest UI"],
        ref_needs: [],
      }));
    }),
  });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), { style_summary: "text style bible is sufficient" });
  await writeJson(path.join(weekDir, "character_bible.json"), {});
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [
      { ref_id: "style_ref", kind: "style", subject: "generated style card", scene_ids: [], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "joey_manhwa_base_identity_ref", kind: "character_state", subject: "Joey Manhwa base identity", scene_ids: ["scene_001"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "char_joey", kind: "character_state", subject: "Joey", scene_ids: ["scene_002"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "victor_base_identity_ref", kind: "character_state", subject: "Victor base identity", scene_ids: ["scene_001"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "char_victor", kind: "character_state", subject: "Victor", scene_ids: ["scene_004"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "restrained_authority_ref", kind: "character_state", subject: "one-scene restrained authority figure", scene_ids: ["scene_004"], prompt_anchor: "16:9 landscape anime/manhwa character card, single restrained authority figure on plain background, restrained styling and composed posture", generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "opening_room_ref", kind: "location", subject: "opening system bedroom", scene_ids: ["scene_001"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "late_room_ref", kind: "location", subject: "late one-off hallway", scene_ids: ["scene_002"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "minor_lobby_ref", kind: "location", subject: "minor recurring lobby", scene_ids: ["scene_003", "scene_004"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "key_hall_ref", kind: "location", subject: "key recurring throne hall", scene_ids: ["scene_005", "scene_006", "scene_007"], priority: "high", generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "late_key_anchor_ref", kind: "location", subject: "late director-selected battle bridge", scene_ids: ["scene_008", "scene_009"], director_role: "key_location_anchor", generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "opening_system_ui_ref", kind: "ui", subject: "signature system quest UI", scene_ids: ["scene_001", "scene_002", "scene_003", "scene_004"], appearance_count: 4, generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "unauthorized_data_leak_ref", kind: "ui", subject: "Unauthorized data leak", scene_ids: ["scene_002"], generation_mode: "no_ref_needed", required_before_imagegen: false },
      { ref_id: "late_ui_ref", kind: "ui", subject: "one-scene hallway notice UI", scene_ids: ["scene_002"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "late_prop_ref", kind: "prop", subject: "one-scene signed receipt", scene_ids: ["scene_002"], generation_mode: "standalone_ref", required_before_imagegen: true },
      { ref_id: "critical_prop_ref", kind: "prop", subject: "critical recurring poison ring", scene_ids: ["scene_002", "scene_003", "scene_004", "scene_005"], priority: "high", generation_mode: "standalone_ref", required_before_imagegen: true },
    ],
    character_state_refs: [
      { state_ref_id: "joey_state", character: "Joey Manhwa", source_ref_id: "char_joey", scene_ids: ["scene_002"] },
      { state_ref_id: "victor_state", character: "Victor", source_ref_id: "char_victor", scene_ids: ["scene_004"] },
    ],
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-reference-plan.mjs",
    "--channel", "test",
    "--series", "manhwa_candidate_validation",
    "--week", "run",
    "--episode", "ep_01",
    "--revalidate-existing", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_reference_plan.json"), "utf8"));
  const byId = new Map(report.reference_targets.map((target) => [target.ref_id, target]));
  assert.equal(report.reference_budget.applied, true);
  assert.equal(byId.has("style_ref"), false);
  assert.equal(byId.get("joey_manhwa_base_identity_ref").required_before_imagegen, true);
  assert.equal(byId.has("char_joey"), false);
  assert.equal(byId.has("char_victor"), false);
  assert.equal(byId.has("restrained_authority_ref"), false);
  assert.equal(byId.get("opening_room_ref").required_before_imagegen, false);
  assert.equal(byId.get("opening_room_ref").generation_mode, "derive_from_first_clean_wide_cut");
  assert.equal(byId.has("late_room_ref"), false);
  assert.equal(byId.has("late_ui_ref"), false);
  assert.equal(byId.has("late_prop_ref"), false);
  assert.equal(byId.get("minor_lobby_ref").generation_mode, "derive_from_first_clean_wide_cut");
  assert.equal(byId.get("key_hall_ref").required_before_imagegen, true);
  assert.equal(byId.get("late_key_anchor_ref").required_before_imagegen, false);
  assert.match(byId.get("late_key_anchor_ref").generation_mode, /^derive_from_/);
  assert.equal(byId.get("late_key_anchor_ref").reference_budget.decision, "text_only");
  assert.equal(byId.get("opening_system_ui_ref").required_before_imagegen, true);
  assert.equal(byId.get("unauthorized_data_leak_ref").required_before_imagegen, true);
  assert.equal(byId.get("critical_prop_ref").required_before_imagegen, true);
  assert.equal(report.reference_targets.some((target) => target.generation_mode === "no_ref_needed"), false);
  const stateRefs = JSON.parse(await fs.readFile(path.join(episodeDir, "character_state_refs.json"), "utf8"));
  const joeyState = stateRefs.character_state_refs.find((ref) => ref.state_ref_id === "joey_state");
  assert.equal(joeyState.source_ref_id, "joey_manhwa_base_identity_ref");

  await execFileAsync(process.execPath, [
    "scripts/visual-reference-plan.mjs",
    "--channel", "test",
    "--series", "manhwa_candidate_validation",
    "--week", "run",
    "--episode", "ep_01",
    "--revalidate-existing", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const revalidated = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_reference_plan.json"), "utf8"));
  assert.equal(revalidated.status, "passed");
  assert.equal(revalidated.reference_targets.some((target) => target.generation_mode === "no_ref_needed"), false);
}

async function testReferenceDirectorInventoryPreventsCollectorBloat() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  const semanticScenes = Array.from({ length: 8 }, (_, index) => ({
    scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
    start_sec: index * 90,
    location: index < 2 ? "opening guild gate" : `one-off chamber ${index + 1}`,
    visible_subjects: index % 2 === 0 ? ["Joey Manhwa", "guild masters"] : ["Joey Manhwa"],
    props: [`one-off relic ${index + 1}`, index < 4 ? "poison ring" : `document ${index + 1}`],
    ref_requirements: [
      { kind: "location", ref_id: index < 2 ? "opening_guild_gate_ref" : `one_off_chamber_${index + 1}_ref`, reason: "semantic scoped location target" },
      { kind: "prop", ref_id: `one_off_relic_${index + 1}_ref`, reason: "semantic prop candidate, not automatic standalone" },
    ],
  }));
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "manhwa_candidate_validation",
    week: "run",
    episode: "ep_01",
    pace_policy: "diagnostic",
    image_provider: "modelslab",
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    scenes: semanticScenes,
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats: semanticScenes.flatMap((scene, sceneIndex) => [0, 1].map((beatIndex) => ({
      scene_id: scene.scene_id,
      parent_scene_id: scene.scene_id,
      visual_beat_id: `${scene.scene_id}_beat_${String(beatIndex + 1).padStart(2, "0")}`,
      start_sec: scene.start_sec + beatIndex * 8,
      duration_sec: 8,
      location: scene.location,
      local_location: scene.location,
      visual_beat_script_excerpt: beatIndex === 0
        ? `Joey Manhwa faces the guild masters in ${scene.location}.`
        : `The poison ring matters while one-off relic ${sceneIndex + 1} sits nearby.`,
      visible_characters: beatIndex === 0 ? ["Joey Manhwa", "guild masters"] : ["Joey Manhwa"],
      local_props: beatIndex === 1 ? ["poison ring", `one-off relic ${sceneIndex + 1}`] : [],
      local_ui_elements: sceneIndex < 3 && beatIndex === 1 ? ["system ledger UI"] : [],
      ref_needs: [
        {
          ref_id: sceneIndex < 2 ? "opening_guild_gate_ref" : `one_off_chamber_${sceneIndex + 1}_ref`,
          kind: "location",
          subject: scene.location,
          generation_mode: sceneIndex < 2 ? "standalone_ref" : "standalone_ref",
          reason: "fixture advisory location need",
        },
        {
          ref_id: `one_off_relic_${sceneIndex + 1}_ref`,
          kind: "prop",
          subject: `one-off relic ${sceneIndex + 1}`,
          generation_mode: "standalone_ref",
          reason: "fixture advisory prop need that should not force standalone generation",
        },
      ],
    }))),
  });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), { style_summary: "text style bible is sufficient" });
  await writeJson(path.join(weekDir, "character_bible.json"), {});
  const bloatedTargets = [
    { ref_id: "joey_manhwa_base_identity_ref", kind: "character_state", subject: "Joey Manhwa base identity", scene_ids: semanticScenes.map((scene) => scene.scene_id), generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "joey_manhwa_ref", kind: "character_state", subject: "Joey Manhwa", scene_ids: semanticScenes.slice(2, 5).map((scene) => scene.scene_id), generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "joey_manhwa_bloodied_chamber_state_ref", kind: "character_state", subject: "Joey Manhwa bloodied one chamber state", scene_ids: ["scene_006"], generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "char_harlan_voss_ref", kind: "character_state", subject: "Harlan Voss raid captain identity", scene_ids: ["scene_002", "scene_003"], generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "harlan_voss_ref", kind: "character_state", subject: "Harlan Voss", scene_ids: ["scene_004"], generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "captain_harlan_voss_court_restrained_state", kind: "character_state", subject: "Captain Harlan Voss court restrained state", scene_ids: ["scene_005"], generation_mode: "derive_from_best_cut", required_before_imagegen: false },
    { ref_id: "guild_masters_group_faces_ref", kind: "character_state", subject: "guild masters group uniform system", scene_ids: ["scene_001", "scene_003", "scene_005"], generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "opening_guild_gate_ref", kind: "location", subject: "opening guild gate", scene_ids: ["scene_001", "scene_002"], generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "system_ledger_ui_ref", kind: "ui", subject: "signature system ledger UI", scene_ids: ["scene_001", "scene_002", "scene_003"], appearance_count: 3, generation_mode: "standalone_ref", required_before_imagegen: true },
    { ref_id: "poison_ring_ref", kind: "prop", subject: "critical recurring poison ring", scene_ids: ["scene_001", "scene_002", "scene_003", "scene_004"], priority: "high", generation_mode: "standalone_ref", required_before_imagegen: true },
    ...semanticScenes.map((scene, index) => ({
      ref_id: `one_off_relic_${index + 1}_ref`,
      kind: "prop",
      subject: `one-off relic ${index + 1}`,
      scene_ids: [scene.scene_id],
      generation_mode: "standalone_ref",
      required_before_imagegen: true,
    })),
    ...semanticScenes.slice(2).map((scene, index) => ({
      ref_id: `one_off_chamber_${index + 3}_ref`,
      kind: "location",
      subject: scene.location,
      scene_ids: [scene.scene_id],
      generation_mode: "standalone_ref",
      required_before_imagegen: true,
    })),
  ];
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: bloatedTargets,
    character_state_refs: [
      { state_ref_id: "joey_base_state", character: "Joey Manhwa", source_ref_id: "joey_manhwa_base_identity_ref", scene_ids: semanticScenes.map((scene) => scene.scene_id) },
      { state_ref_id: "joey_plain_duplicate_state", character: "Joey Manhwa", source_ref_id: "joey_manhwa_ref", scene_ids: ["scene_003"] },
      { state_ref_id: "joey_bloodied_chamber_state", character: "Joey Manhwa", source_ref_id: "joey_manhwa_bloodied_chamber_state_ref", scene_ids: ["scene_006"] },
      { state_ref_id: "captain_harlan_voss_court_restrained_state", character: "Captain Harlan Voss", source_ref_id: "captain_harlan_voss_court_restrained_state", base_identity_ref_id: "char_captain_harlan_voss_ref", scene_ids: ["scene_005"] },
      { state_ref_id: "guild_masters_group_state", character: "guild masters", source_ref_id: "guild_masters_group_faces_ref", scene_ids: ["scene_001", "scene_003", "scene_005"] },
    ],
  });

  await execFileAsync(process.execPath, [
    "scripts/visual-reference-plan.mjs",
    "--channel", "test",
    "--series", "manhwa_candidate_validation",
    "--week", "run",
    "--episode", "ep_01",
    "--revalidate-existing", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });

  const report = await readJson(path.join(episodeDir, "visual_reference_plan.json"));
  const ledger = await readJson(path.join(episodeDir, "reference_inventory_ledger.json"));
  const stateRefs = await readJson(path.join(episodeDir, "character_state_refs.json"));
  const byId = new Map(report.reference_targets.map((target) => [target.ref_id, target]));
  assert.equal(ledger.schema, "goldflow_reference_inventory_ledger_v1");
  assert.equal(report.reference_inventory_ledger_path.endsWith("reference_inventory_ledger.json"), true);
  assert.equal(ledger.summary.asset_count > report.reference_targets.length, true);
  assert.equal(byId.get("joey_manhwa_base_identity_ref").required_before_imagegen, true);
  assert.equal(byId.has("joey_manhwa_ref"), false);
  assert.equal(byId.has("joey_manhwa_bloodied_chamber_state_ref"), false);
  assert.equal(byId.has("char_harlan_voss_ref"), true);
  assert.equal(byId.has("harlan_voss_ref"), false);
  assert.equal(byId.has("captain_harlan_voss_court_restrained_state"), false);
  assert.equal(byId.has("guild_masters_group_faces_ref"), false);
  assert.equal(byId.has("one_off_chamber_3_ref"), false);
  assert.equal(byId.has("one_off_relic_1_ref"), false);
  assert.equal(byId.get("poison_ring_ref").required_before_imagegen, true);
  assert.equal(byId.get("system_ledger_ui_ref").required_before_imagegen, true);
  assert.equal(report.reference_targets.some((target) => target.generation_mode === "no_ref_needed"), false);
  assert.deepEqual(stateRefs.character_state_refs.map((ref) => ref.state_ref_id), ["joey_base_state", "joey_plain_duplicate_state", "captain_harlan_voss_court_restrained_state"]);
  assert.equal(stateRefs.character_state_refs.find((ref) => ref.state_ref_id === "joey_plain_duplicate_state").source_ref_id, "joey_manhwa_base_identity_ref");
  assert.equal(stateRefs.character_state_refs.find((ref) => ref.state_ref_id === "captain_harlan_voss_court_restrained_state").source_ref_id, "char_harlan_voss_ref");
  assert.equal(stateRefs.character_state_refs.find((ref) => ref.state_ref_id === "captain_harlan_voss_court_restrained_state").base_identity_ref_id, "char_harlan_voss_ref");
  assert.equal(report.warnings.some((warning) => warning.code === "director_pruned_text_only_reference_target"), true);
  assert.equal(report.warnings.some((warning) => warning.code === "director_pruned_text_only_character_state_ref"), true);
}

function testOutOfScopeRefDropping() {
  const scene = { scene_id: "scene_001" };
  const visualReferencePlan = {
    reference_targets: [
      { ref_id: "loc_apartment", kind: "location", scene_ids: ["scene_001"] },
      { ref_id: "char_joey_ref", kind: "character_state", scene_ids: ["scene_001"] },
      { ref_id: "style_ref", kind: "style", scene_ids: [] },
    ],
  };
  const characterStateRefs = [
    { state_ref_id: "char_joey_state", source_ref_id: "char_joey_ref", scene_ids: ["scene_001"] },
  ];
  const allowed = allowedRefIdsForScene({ scene, visualReferencePlan, characterStateRefs });
  const prompt = {
    reference_requirements: [
      { ref_id: "loc_apartment", kind: "location" },
      { ref_id: "loc_wrong", kind: "location" },
    ],
    reference_usage: [],
    shot_manifest: {
      location_ref_id: "loc_wrong",
      character_state_ref_ids: ["char_joey_state", "char_wrong_state"],
      protagonist_state_ref_id: "char_wrong_protagonist",
    },
  };
  const sanitized = dropOutOfScopePromptRefs(prompt, allowed);
  assert.equal(sanitized.shot_manifest.location_ref_id, null);
  assert.deepEqual(sanitized.shot_manifest.character_state_ref_ids, ["char_joey_state"]);
  assert.equal(sanitized.shot_manifest.protagonist_state_ref_id, null);
  assert.deepEqual(sanitized.reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment"]);
  const droppedFields = sanitized.reference_usage
    .filter((usage) => usage.usage === "out_of_scope_ref_dropped")
    .map((usage) => usage.field);
  assert.deepEqual(new Set(droppedFields), new Set([
    "shot_manifest.location_ref_id",
    "shot_manifest.character_state_ref_ids",
    "shot_manifest.protagonist_state_ref_id",
    "reference_requirements.ref_id",
  ]));
}

function testReferenceLimitOmissionIsNotForbidden() {
  const allowed = new Set(["loc_stage", "char_joey_ref", "char_pookie_ref", "char_kai_ref", "char_jinx_ref"]);
  const prompt = {
    reference_requirements: [
      { ref_id: "char_joey_ref", kind: "character_state" },
      { ref_id: "char_pookie_ref", kind: "character_state" },
      { ref_id: "char_kai_ref", kind: "character_state" },
      { ref_id: "char_jinx_ref", kind: "character_state" },
    ],
    reference_usage: [
      {
        ref_id: "loc_stage",
        usage: "available_not_attached_reference_limit",
        reason: "Four visible character refs fill the available reference slots.",
      },
    ],
    shot_manifest: {
      forbidden_ref_ids: ["loc_stage", "wrong_location_ref"],
    },
  };
  const sanitized = dropOutOfScopePromptRefs(prompt, allowed);
  assert.deepEqual(sanitized.shot_manifest.forbidden_ref_ids, ["wrong_location_ref"]);
  assert.equal(sanitized.reference_usage.some((usage) => (
    usage.ref_id === "loc_stage"
    && usage.usage === "non_forbidden_ref_removed_from_forbidden_ref_ids"
    && usage.field === "shot_manifest.forbidden_ref_ids"
  )), true);
}

function testOutOfScopeLocationMentionAssertion() {
  const mentions = outOfScopeLocationRefMentions({
    text: "A polished frame accidentally names loc_boardroom inside an apartment beat.",
    locationTargets: [
      { ref_id: "loc_apartment", kind: "location" },
      { ref_id: "loc_boardroom", kind: "location" },
    ],
    allowedLocationRefId: "loc_apartment",
  });
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].code, "out_of_scope_location_ref_mentioned");
  assert.equal(mentions[0].severity, "blocker");
}

function testProviderAwarePromptSelection() {
  const prompt = {
    image_prompt: "generic production prompt",
    modelslab_image_prompt: "modelslab flux prompt",
    codex_image_prompt: "codex openai prompt",
  };
  assert.equal(promptTextForImageProvider(prompt, "modelslab"), "modelslab flux prompt");
  assert.equal(promptTextForImageProvider(prompt, "codex_imagegen"), "codex openai prompt");
  assert.equal(promptTextForImageProvider({ ...prompt, codex_image_prompt: "" }, "codex_imagegen"), "generic production prompt");
}

function testGptImage2PreservesFullPromptAndUsesLandscapeDefault() {
  const prompt = [
    "Anime/manhwa fantasy frame.",
    "Joey Manhwa strains beneath a shattered carriage wheel while Arielle Seorin, an adult silver-haired noble student, remains pinned under the axle.",
    "Preserve Joey's dark academy uniform, Arielle's moon earrings, and the exact physical rescue staging.",
  ].join(" ").repeat(8);
  const prepared = prepareGptImage2PromptForTests(prompt);
  assert.equal(prepared.prompt, prompt);
  assert.equal(prepared.compacted, false);
  assert.equal(prepared.original_length, prompt.length);
  assert.equal(prepared.submitted_length, prompt.length);
  const [width, height] = gptImage2OutputSizeForTests().split("x").map(Number);
  assert.equal(width > height, true, "GPT Image 2 production request must default to native landscape");
}

function testSceneImageProductionContractBlocksDroppedRefsAndStyle() {
  const broken = scenePromptProductionContractFindingsForTests([{
    image_id: "ep_01-cut-044",
    modelslab_image_prompt: "Joey runs toward the carriage.",
    reference_requirements: [{
      ref_id: "char_arielle_ref",
      kind: "character_state",
      required: true,
      reference_image_path: "/tmp/arielle.png",
    }],
    reference_slots: [],
    shot_manifest: { shot_job: "physical_action", foreground_action: "" },
  }], { maxSceneReferences: 0 });
  assert.equal(broken.some((finding) => finding.code === "required_scene_references_disabled"), true);
  assert.equal(broken.some((finding) => finding.code === "required_reference_slot_missing"), true);
  assert.equal(broken.some((finding) => finding.code === "scene_prompt_style_contract_missing"), true);
  assert.equal(broken.some((finding) => finding.code === "physical_action_contract_missing"), true);

  const passed = scenePromptProductionContractFindingsForTests([{
    image_id: "ep_01-cut-044",
    modelslab_image_prompt: "Anime/manhwa frame. Joey runs toward the carriage while silver-haired Arielle remains pinned under the axle.",
    reference_requirements: [{
      ref_id: "char_arielle_ref",
      kind: "character_state",
      required: true,
      reference_image_path: "/tmp/arielle.png",
    }],
    reference_slots: [{ slot: 1, ref_id: "char_arielle_ref", kind: "character_state", path: "/tmp/arielle.png" }],
    shot_manifest: { shot_job: "physical_action", foreground_action: "Joey runs toward pinned Arielle" },
  }], { maxSceneReferences: 4 });
  assert.deepEqual(passed, []);

  const stateAliasPlan = attachReferencePathsToPromptsForTests({
    prompt_policy: "deterministic hardening fixture",
    prompts: [{
      image_id: "ep_01-cut-state-alias",
      modelslab_image_prompt: "Anime/manhwa frame of Arielle studying a curse on her wrist.",
      reference_requirements: [{
        ref_id: "arielle_curse_state",
        base_identity_ref_id: "arielle_base",
        kind: "character_state",
        required: true,
      }],
      shot_manifest: {
        shot_job: "body_state_proof",
        protagonist_state_ref_id: "arielle_curse_state",
        character_state_ref_ids: ["arielle_curse_state"],
      },
    }],
  }, new Map([["arielle_base", "/tmp/arielle-base.png"]]), [{
    state_ref_id: "arielle_curse_state",
    source_ref_id: "arielle_base",
    base_identity_ref_id: "arielle_base",
  }]);
  assert.deepEqual(stateAliasPlan.prompts[0].reference_slots, [{
    slot: 1,
    ref_id: "arielle_curse_state",
    kind: "character_state",
    path: "/tmp/arielle-base.png",
    purpose: "character identity and wardrobe for arielle_curse_state",
    reason: null,
  }]);
  assert.equal(stateAliasPlan.prompts[0].reference_requirements.length, 1);
  assert.deepEqual(scenePromptProductionContractFindingsForTests(stateAliasPlan.prompts, { maxSceneReferences: 4 }), []);
}

function testGroupReferencePromptDoesNotDemandOnePerson() {
  const prompt = referencePromptForTests({
    ref_id: "senior_squad_ref",
    kind: "character_state",
    subject: "senior squad faction group",
    prompt_anchor: "four distinct academy seniors in one shared armor design",
  });
  assert.match(prompt, /three to five clearly distinct visible people/i);
  assert.doesNotMatch(prompt, /exactly one visible person/i);
}

function testConciseReferenceRoleContract() {
  const instruction = referenceSlotInstructionForTests([
    { slot: 1, ref_id: "char_joey_ref", kind: "character_state", purpose: "Joey identity" },
    { slot: 2, ref_id: "char_arielle_ref", kind: "character_state", purpose: "Arielle identity" },
  ], {}, { concise: true });
  assert.match(instruction, /Reference mapping/i);
  assert.match(instruction, /Image 1/i);
  assert.match(instruction, /Image 2/i);
  assert.doesNotMatch(instruction, /reference sheet/i);
}

function testLocalBeatFidelityEditorialCases() {
  const allowedFindings = localBeatFidelityFindingsForTests([
    {
      image_id: "ep_01-cut-collective",
      image_prompt: "Joey Manhwa stands beside a glowing livestream ledger while Lana Vale watches from a campus livestream exam montage, audience seats and creator-screen spaces visible as environmental context.",
      shot_manifest: {
        visible_characters: ["Joey Manhwa", "Lana Vale"],
        location_ref_id: "streamer_university_livestream_exam_spaces_ref",
      },
    },
    {
      image_id: "ep_01-cut-location-list",
      image_prompt: "Joey and ExtraEmily stand before Improv Court doors in a streamer university hallway, panels of livestream challenge rooms glowing behind each door.",
      shot_manifest: {
        visible_characters: ["Joey", "ExtraEmily"],
        location_ref_id: "streamer_university_improv_court_door_hall_ref",
      },
    },
  ], [
    {
      primary_subject: "Joey Manhwa",
      visible_subjects: [
        "Joey Manhwa",
        "Lana Vale watching remotely",
        "Streamer University creators and audience spaces",
      ],
      location: "streamer_university_livestream_exam_spaces",
      location_timeline_label: "Joey's livestream ledger screen transitioning into Streamer University livestream-exam montage",
      visual_beat_script_excerpt: "And somewhere across campus, Lana Vale watched the whole world realize what I had been doing for her in silence. Streamer University did not have normal classes.",
    },
    {
      primary_subject: "Joey",
      visible_subjects: ["Joey", "ExtraEmily", "fake talk show host", "improv room audience"],
      location: "streamer_university_improv_court_door_hall",
      location_timeline_label: "streamer_university_improv_court_door_hall",
      visual_beat_script_excerpt: "Analytics Hall had graphs. Aura class had mirrors. Tax class had jokes. Improv Court had doors. Behind each door was a livestream situation you could not prepare for.",
    },
  ]);
  assert.deepEqual(allowedFindings, []);

  const hyphenatedNameFindings = localBeatFidelityFindingsForTests([
    {
      image_id: "ep_01-cut-hyphenated",
      image_prompt: "Joey Manhwa works beside Do-yun in a document-filled office while Mira watches from the doorway.",
      shot_manifest: {
        visible_characters: ["Joey Manhwa", "Do-yun", "Mira"],
      },
    },
  ], [
    {
      primary_subject: "Joey Manhwa",
      visible_subjects: ["Joey Manhwa", "Do-yun", "Mira"],
      visual_beat_script_excerpt: "Do-yun placed the folder beside Joey while Mira watched from the doorway.",
    },
  ]);
  assert.deepEqual(hyphenatedNameFindings, []);

  const blockedFindings = localBeatFidelityFindingsForTests([
    {
      image_id: "ep_01-cut-missing",
      image_prompt: "Joey stands alone in a dorm room with a blue screen glow.",
      shot_manifest: {
        visible_characters: ["Joey"],
        location_ref_id: "dorm_room_ref",
      },
    },
  ], [
    {
      primary_subject: "Joey",
      visible_subjects: ["Joey", "Agent00"],
      location: "analytics_hall_replay_wall",
      location_timeline_label: "Analytics Hall replay wall",
      visual_beat_script_excerpt: "Joey crossed into Analytics Hall. Agent00 waited beside the replay wall.",
    },
  ]);
  assert.equal(blockedFindings.some((finding) => finding.includes("Agent00")), true);
  assert.equal(blockedFindings.some((finding) => finding.includes("Analytics Hall")), true);
}

function testHybridImageProviderRouting() {
  assert.equal(normalizeImageProvider("codex refs multichar modelslab simple"), "hybrid_codex_refs_multichar");
  assert.equal(routedProviderForReference("hybrid_codex_refs_multichar"), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    shot_manifest: {
      visible_characters: ["Joey", "Mira"],
      character_state_ref_ids: ["joey_ref", "mira_ref"],
    },
    reference_requirements: [
      { kind: "character_state", ref_id: "joey_ref" },
      { kind: "character_state", ref_id: "mira_ref" },
    ],
  }, "hybrid_codex_refs_multichar"), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    shot_manifest: {
      visible_characters: ["Joey"],
      character_state_ref_ids: ["joey_ref"],
    },
    reference_requirements: [
      { kind: "character_state", ref_id: "joey_ref" },
      { kind: "location", ref_id: "loc_hall" },
    ],
  }, "hybrid_codex_refs_multichar"), "modelslab");
  assert.equal(routedProviderForReference("hybrid_codex_opening_modelslab_rest", { kind: "character_state", ref_id: "joey_ref" }), "codex_imagegen");
  assert.equal(routedProviderForReference("hybrid_codex_opening_modelslab_rest", { kind: "location", ref_id: "loc_stage" }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 119,
    shot_manifest: { visible_characters: ["Joey"], character_state_ref_ids: ["joey_ref"] },
  }, "hybrid_codex_opening_modelslab_rest", { codexOpeningSec: 120 }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 121,
    shot_manifest: { visible_characters: ["Joey"], character_state_ref_ids: ["joey_ref"] },
  }, "hybrid_codex_opening_modelslab_rest", { codexOpeningSec: 120 }), "modelslab");
  assert.equal(routedProviderForPrompt({
    start_sec: 121,
    shot_manifest: { visible_characters: ["Joey", "Mira"], character_state_ref_ids: ["joey_ref", "mira_ref"] },
  }, "hybrid_codex_opening_modelslab_rest", { codexOpeningSec: 120 }), "modelslab");
  assert.equal(normalizeImageProvider("codex refs first10 risky modelslab rest"), "hybrid_codex_refs_opening_risky_modelslab_rest");
  assert.equal(routedProviderForReference("hybrid_codex_refs_opening_risky_modelslab_rest", { kind: "character_state", ref_id: "joey_ref" }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 599.9,
    shot_manifest: { visible_characters: ["Joey"], character_state_ref_ids: ["joey_ref"] },
  }, "hybrid_codex_refs_opening_risky_modelslab_rest", { codexOpeningSec: 600 }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 601,
    shot_manifest: { visible_characters: ["Joey", "Mira"], character_state_ref_ids: ["joey_ref", "mira_ref"] },
  }, "hybrid_codex_refs_opening_risky_modelslab_rest", { codexOpeningSec: 600 }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 601,
    shot_manifest: { visible_characters: ["Joey"], character_state_ref_ids: ["joey_ref"] },
  }, "hybrid_codex_refs_opening_risky_modelslab_rest", { codexOpeningSec: 600 }), "modelslab");
  assert.equal(normalizeImageProvider("modelslab refs codex first 5 modelslab rest"), "hybrid_modelslab_refs_codex_opening_modelslab_rest");
  assert.equal(routedProviderForReference("hybrid_modelslab_refs_codex_opening_modelslab_rest", { kind: "character_state", ref_id: "joey_ref" }), "modelslab");
  assert.equal(routedProviderForReference("hybrid_modelslab_refs_codex_opening_modelslab_rest", { kind: "location", ref_id: "loc_stage" }), "modelslab");
  assert.equal(routedProviderForPrompt({
    start_sec: 299.9,
    shot_manifest: { visible_characters: ["Joey"], character_state_ref_ids: ["joey_ref"] },
  }, "hybrid_modelslab_refs_codex_opening_modelslab_rest", { codexOpeningSec: 300 }), "codex_imagegen");
  assert.equal(routedProviderForPrompt({
    start_sec: 300,
    shot_manifest: { visible_characters: ["Joey", "Mira"], character_state_ref_ids: ["joey_ref", "mira_ref"] },
  }, "hybrid_modelslab_refs_codex_opening_modelslab_rest", { codexOpeningSec: 300 }), "modelslab");
}

async function testHybridOpeningWindowPersistsInRunIdentity() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await execFileAsync(process.execPath, [
    "scripts/run-preflight.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--image-provider", "hybrid_codex_opening_modelslab_rest",
    "--codex-opening-sec", "600",
    "--run-intent", "diagnostic",
    "--allow-dirty-worktree", "true",
    "--dirty-reason", "fixture test",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const identity = JSON.parse(await fs.readFile(path.join(episodeDir, "run_identity.json"), "utf8"));
  assert.equal(identity.image_provider, "hybrid_codex_opening_modelslab_rest");
  assert.equal(identity.image_provider_options.codex_opening_sec, 600);

  const imagegenReportPath = path.join(episodeDir, "imagegen_report_ep_01.json");
  await execFileAsync(process.execPath, [
    "scripts/imagegen.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--image-provider", "hybrid_codex_opening_modelslab_rest",
    "--references-only", "true",
    "--skip-reference-generation", "true",
    "--output", imagegenReportPath,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot, ANIFACTORY_CODEX_OPENING_SEC: "" } });
  const imagegenReport = JSON.parse(await fs.readFile(imagegenReportPath, "utf8"));
  assert.equal(imagegenReport.codex_opening_sec, 600);

  let mismatch = null;
  try {
    await execFileAsync(process.execPath, [
      "scripts/imagegen.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "run",
      "--episode", "ep_01",
      "--image-provider", "hybrid_codex_opening_modelslab_rest",
      "--references-only", "true",
      "--skip-reference-generation", "true",
      "--codex-opening-sec", "120",
      "--output", path.join(episodeDir, "imagegen_report_mismatch.json"),
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  } catch (error) {
    mismatch = error;
  }
  assert.equal(mismatch?.code, 1);
  assert.match(mismatch?.stderr ?? "", /Codex opening window mismatch/);

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const referenceStage = status.stage_ledger.find((row) => row.stage === "reference_generation");
  const imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.match(referenceStage.next_command_shape, /imagegen import-staged-codex/);
  assert.match(referenceStage.next_command_shape, /--references-only true/);
  assert.match(imageStage.next_command_shape, /imagegen import-staged-codex/);
  assert.match(imageStage.next_command_shape, /--codex-opening-sec 600/);

  const combinedDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const combinedEpisodeDir = path.join(combinedDataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await execFileAsync(process.execPath, [
    "scripts/run-preflight.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--image-provider", "hybrid_codex_refs_opening_risky_modelslab_rest",
    "--codex-opening-sec", "600",
    "--run-intent", "diagnostic",
    "--allow-dirty-worktree", "true",
    "--dirty-reason", "fixture test",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: combinedDataRoot } });
  const combinedIdentity = JSON.parse(await fs.readFile(path.join(combinedEpisodeDir, "run_identity.json"), "utf8"));
  assert.equal(combinedIdentity.image_provider, "hybrid_codex_refs_opening_risky_modelslab_rest");
  assert.equal(combinedIdentity.image_provider_options.codex_opening_sec, 600);
  const combinedStatusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", combinedEpisodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: combinedDataRoot } });
  const combinedStatus = JSON.parse(combinedStatusResult.stdout);
  const combinedReferenceStage = combinedStatus.stage_ledger.find((row) => row.stage === "reference_generation");
  const combinedImageStage = combinedStatus.stage_ledger.find((row) => row.stage === "image_generation");
  assert.match(combinedReferenceStage.next_command_shape, /imagegen import-staged-codex/);
  assert.match(combinedReferenceStage.next_command_shape, /--references-only true/);
  assert.match(combinedImageStage.next_command_shape, /imagegen import-staged-codex/);
  assert.match(combinedImageStage.next_command_shape, /--codex-opening-sec 600/);
  assert.match(combinedImageStage.next_command_shape, /--provider-filter modelslab/);

  const mixedRefsDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const mixedRefsEpisodeDir = path.join(mixedRefsDataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await execFileAsync(process.execPath, [
    "scripts/run-preflight.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--image-provider", "hybrid_modelslab_refs_codex_opening_modelslab_rest",
    "--codex-opening-sec", "300",
    "--pace-policy", "diagnostic",
    "--render-profile", "smooth_fast_ken_burns",
    "--run-intent", "diagnostic",
    "--allow-dirty-worktree", "true",
    "--dirty-reason", "fixture test",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: mixedRefsDataRoot } });
  const mixedIdentity = JSON.parse(await fs.readFile(path.join(mixedRefsEpisodeDir, "run_identity.json"), "utf8"));
  assert.equal(mixedIdentity.image_provider, "hybrid_modelslab_refs_codex_opening_modelslab_rest");
  assert.equal(mixedIdentity.image_provider_options.codex_opening_sec, 300);
  assert.equal(mixedIdentity.pace_policy, "diagnostic");
  assert.equal(mixedIdentity.render_profile, "smooth_fast_ken_burns");
  const mixedStatusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", mixedRefsEpisodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: mixedRefsDataRoot } });
  const mixedStatus = JSON.parse(mixedStatusResult.stdout);
  const mixedScriptPaceStage = mixedStatus.stage_ledger.find((row) => row.stage === "script_pace_check");
  const mixedReferenceStage = mixedStatus.stage_ledger.find((row) => row.stage === "reference_generation");
  const mixedImageStage = mixedStatus.stage_ledger.find((row) => row.stage === "image_generation");
  const mixedAudioPaceStage = mixedStatus.stage_ledger.find((row) => row.stage === "audio_pace_check");
  const mixedRenderStage = mixedStatus.stage_ledger.find((row) => row.stage === "premium_render");
  assert.match(mixedScriptPaceStage.next_command_shape, /--pace-policy diagnostic/);
  assert.match(mixedScriptPaceStage.next_command_shape, /--allow-hook-warnings true/);
  assert.match(mixedReferenceStage.next_command_shape, /imagegen start/);
  assert.match(mixedReferenceStage.next_command_shape, /--image-provider hybrid_modelslab_refs_codex_opening_modelslab_rest/);
  assert.match(mixedReferenceStage.next_command_shape, /--references-only true/);
  assert.doesNotMatch(mixedReferenceStage.next_command_shape, /import-staged-codex/);
  assert.match(mixedImageStage.next_command_shape, /imagegen import-staged-codex/);
  assert.match(mixedImageStage.next_command_shape, /--output <episode-dir>\/imagegen_report_ep_01\.json/);
  assert.match(mixedImageStage.next_command_shape, /--provider-filter modelslab/);
  assert.match(mixedImageStage.next_command_shape, /--codex-opening-sec 300/);
  assert.match(mixedAudioPaceStage.next_command_shape, /--pace-policy diagnostic/);
  assert.match(mixedRenderStage.next_command_shape, /--motion smooth_fast_ken_burns/);
  assert.doesNotMatch(mixedRenderStage.next_command_shape, /fill_ken_burns/);
}

async function testVisualPlannerDriftContracts() {
  const files = Object.fromEntries(await Promise.all([
    "AGENTS.md",
    "docs/workflows/video_production_workflow.md",
    "bin/goldflow.mjs",
    "scripts/codex-image-manual-import.mjs",
    "scripts/semantic-scene-plan.mjs",
    "scripts/visual-reference-plan.mjs",
    "scripts/visual-plan.mjs",
    "scripts/visual-prompt-review.mjs",
    "scripts/imagegen.mjs",
  ].map(async (file) => [file, await fs.readFile(file, "utf8")])));

  assert.match(files["scripts/semantic-scene-plan.mjs"], /acting as dean and final judge/i);
  assert.match(files["scripts/semantic-scene-plan.mjs"], /instead of creating a new generic character/i);

  assert.match(files["scripts/visual-reference-plan.mjs"], /face-only source identity anchor/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /base_identity_ref_id/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /source_only/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /applySourceFaceAnchors/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /Do not rely on text-only "inspired by" likeness prompts/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /A location contract is not an image reference/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /sole episode-level reference director/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /never restores an asset you omit/i);
  assert.doesNotMatch(files["scripts/visual-reference-plan.mjs"], /function applyReferenceBudgetProfile\b/);
  assert.doesNotMatch(files["scripts/visual-reference-plan.mjs"], /function ensureRequiredDirectorAssets\b/);
  assert.doesNotMatch(files["scripts/visual-reference-plan.mjs"], /termination papers|unauthorized data leak|proposal owner changed/i);
  assert.match(files["scripts/visual-plan.mjs"], /location_contract_id/i);
  assert.match(files["scripts/visual-prompt-review.mjs"], /location_contract_id/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /style refs dropped for this run; use style bible\/text guidance only/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /Keep narrative state separate from visible state/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /abstract_status_as_physical_anchor_risk/i);
  assert.match(files["AGENTS.md"], /Narrative states such as financially ruined, betrayed, humiliated, indebted, rejected, or emotionally broken are not physical costume\/body damage by default/i);
  assert.match(files["docs/workflows/video_production_workflow.md"], /Separate narrative\/status state from visible character state/i);
  assert.match(files["AGENTS.md"], /ANIFACTORY_IMAGE_MODEL=gpt-image-2-t2i/i);
  assert.match(files["docs/workflows/video_production_workflow.md"], /GPT Image 2 through ModelsLab is an explicit premium\/spend-forward variant/i);
  const modelslabImageHelper = await fs.readFile("scripts/modelslab-image-helper.mjs", "utf8");
  assert.match(modelslabImageHelper, /gpt-image-2-i2i/i);
  assert.equal(modelslabImageHelper.includes("/api/v7/images/image-to-image"), true);
  assert.match(modelslabImageHelper, /ANIFACTORY_MODELSLAB_GPT_IMAGE2_SIZE/i);

  for (const file of ["scripts/visual-plan.mjs", "scripts/visual-prompt-review.mjs"]) {
    assert.match(files[file], /16:9 landscape anime\/manhwa frame/i);
    assert.match(files[file], /without (?:adding )?boilerplate/i);
    assert.match(files[file], /Do not impose a universal wide\/full-frame\/medium-wide default/i);
    assert.match(files[file], /Resolve role\/title aliases to canonical named characters/i);
  }

  assert.match(files["scripts/imagegen.mjs"], /Reference usage:/i);
  assert.equal(/Reference image role contract for FLUX multi-image generation/i.test(files["scripts/imagegen.mjs"]), false);
  assert.equal(/Preserve the shot scale, subject count, background population, and composition requested by the prompt/i.test(files["scripts/imagegen.mjs"]), false);
  assert.equal(/Wide 16:9 landscape YouTube frame/i.test(files["scripts/imagegen.mjs"]), false);
  assert.equal(/full-frame composition, keep complete heads/i.test(files["scripts/imagegen.mjs"]), false);
  assert.match(files["scripts/codex-image-manual-import.mjs"], /promptTextForImageProvider\(prompt, "codex_imagegen"\)/);
  assert.equal(commandStageFor("visual", "approve-refs", {}), "reference_image_approval");
  assert.equal(commandStageFor("imagegen", "start", {}), "image_generation");
  assert.equal(commandStageFor("imagegen", "start", { "references-only": "true" }), "reference_generation");
  assert.equal(commandStageFor("imagegen", "import-staged-codex", { "references-only": "true" }), "reference_generation");
  assert.equal(commandStageFor("imagegen", "import-staged-codex", { "qa-recovery": "true" }), "image_output_qa");
  assert.equal(commandStageFor("visual", "plan", {}), "visual_prompt_plan");
  assert.equal(commandStageFor("visual", "harden", {}), "visual_prompt_harden");

  for (const file of ["AGENTS.md", "docs/workflows/video_production_workflow.md"]) {
    assert.match(files[file], /Real named public creators, streamers, celebrities, or influencers/i);
    assert.match(files[file], /source-face anchors/i);
    assert.match(files[file], /face-only identity/i);
    assert.match(files[file], /inventing a generic lookalike/i);
    assert.match(files[file], /--codex-opening-sec <seconds>/);
  }
}

function testPromptPayloadMarkerSanitizerPreservesNormalNegation() {
  const textless = stripEmbeddedProviderExclusionPayloadSyntax("clean UI panel, no readable text, no text");
  assert.equal(/clean readable text/i.test(textless), false);
  assert.match(textless, /no readable text/i);
  assert.match(textless, /no text/i);

  const alone = stripEmbeddedProviderExclusionPayloadSyntax("one man alone without a crowd");
  assert.equal(/with a crowd/i.test(alone), false);
  assert.match(alone, /without a crowd/i);

  assert.equal(stripEmbeddedProviderExclusionPayloadSyntax("no second character"), "no second character");
  assert.match(stripEmbeddedProviderExclusionPayloadSyntax("no duplicate hero, no clone"), /no duplicate hero, no clone/i);
  assert.equal(stripEmbeddedProviderExclusionPayloadSyntax("Negative prompt: photorealistic --no text"), "photorealistic text");
}

function testNamedCharacterDuplicationAllowsReflections() {
  const reflectionPrompt = {
    image_id: "cut_reflection",
    scene_id: "scene_reflection",
    shot_manifest: { visible_characters: ["Joey Manhwa"] },
    image_prompt: "Older Joey Manhwa watches the cold reflection of old wealth symbols in the overlook glass. Joey Manhwa stands alone in the foreground.",
  };
  assert.deepEqual(namedCharacterDuplicationFindings([reflectionPrompt]), []);

  const clonePrompt = {
    image_id: "cut_clone",
    scene_id: "scene_clone",
    shot_manifest: { visible_characters: ["Joey Manhwa"] },
    image_prompt: "Joey Manhwa faces a clone of Joey Manhwa in the same hallway.",
  };
  const findings = namedCharacterDuplicationFindings([clonePrompt]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "named_character_duplication_risk");

  const proofCopiesPrompt = {
    image_id: "cut_proof_copies",
    scene_id: "scene_proof_copies",
    shot_manifest: { visible_characters: ["Commander Asha", "Senn", "artificers"] },
    image_prompt: "Commander Asha assigns observers while Senn records proof and artificers etch duplicate ledgers into mana glass. Commander Asha points to papers, Senn watches the crystals, and artificers work at a separate table.",
  };
  assert.deepEqual(namedCharacterDuplicationFindings([proofCopiesPrompt]), []);
}

function testVoiceDirectionCharacterization() {
  const pronounced = voiceDirectionTransformForTests("Manhwa Capital showed an SSS-rank warning.", {
    ttsOverrides: {
      pronunciation_map: [{ term: "Manhwa", spoken: "Mahn-wah" }],
    },
  });
  assert.equal(pronounced.qwen_spoken_text, "Mahn-wah Capital showed an S S S rank warning.");

  const trailingAttribution = voiceDirectionTransformForTests("\"Run,\" he said.");
  assert.deepEqual(trailingAttribution.paragraph_units.map((unit) => unit.text), ["Run."]);

  const leadingAttribution = voiceDirectionTransformForTests("The clerk said, \"Door is locked.\"");
  assert.equal(leadingAttribution.clean_narration_attribution, "\"Door is locked.\"");
  assert.equal(leadingAttribution.qwen_spoken_text, "Door is locked.");

  const clean = voiceDirectionTransformForTests("The elevator doors opened with a soft chime.");
  assert.equal(clean.clean_narration_attribution, "The elevator doors opened with a soft chime.");
  assert.equal(clean.qwen_spoken_text, "The elevator doors opened with a soft chime.");

  const systemStack = voiceDirectionTransformForTests([
    "[Hidden skill awakened.]",
    "",
    "[Skill name: Chapter Zero.]",
    "",
    "[Rank: Sealed.]",
    "",
    "[Effect: Allows user to review a survived scene and identify one hidden cause-and-effect link.]",
  ].join("\n\n"));
  assert.deepEqual(systemStack.paragraph_units.map((unit) => ({
    kind: unit.kind,
    speaker: unit.speaker,
    text: unit.text,
    caption_text: unit.caption_text,
  })), [
    { kind: "system_ui", speaker: "SYSTEM", text: "Hidden skill awakened.", caption_text: "[Hidden skill awakened.]" },
    { kind: "system_ui", speaker: "SYSTEM", text: "Skill name: Chapter Zero.", caption_text: "[Skill name: Chapter Zero.]" },
    { kind: "system_ui", speaker: "SYSTEM", text: "Rank: Sealed.", caption_text: "[Rank: Sealed.]" },
    { kind: "system_ui", speaker: "SYSTEM", text: "Effect: Allows user to review a survived scene and identify one hidden cause-and-effect link.", caption_text: "[Effect: Allows user to review a survived scene and identify one hidden cause-and-effect link.]" },
  ]);

  const nonSpokenDirection = voiceDirectionTransformForTests("[SFX: cold system ping]");
  assert.deepEqual(nonSpokenDirection.paragraph_units.map((unit) => unit.kind), ["sound_design"]);
}

function testQwenPlanAuditsAppliedTtsOverrides() {
  const plan = qwenGenerationPlanForTests([{
    segment_id: "seg_001",
    performance_units: [{
      kind: "narration",
      speaker: "NARRATOR",
      text: "The clip became live content.",
      performed_text: "The clip became live content.",
      caption_text: "The clip became live content.",
    }],
  }], {
    ttsOverrides: {
      replacements: [{ from: "live content", to: "livestream video content", scope: "qwen_spoken_text" }],
      pronunciation_map: [],
    },
  });
  assert.equal(plan.tts_override_application_audit.loaded_count, 1);
  assert.equal(plan.tts_override_application_audit.applied_rule_count, 1);
  assert.equal(plan.tts_override_application_audit.unmatched_rule_count, 0);
  assert.equal(plan.segments[0].qwen_generation_units[0].qwen_spoken_text, "The clip became livestream video content.");
  assert.deepEqual(plan.segments[0].qwen_generation_units[0].tts_override_replacements_applied.map((row) => row.from), ["live content"]);
}

function testQwenPlanSpeaksStandaloneSystemUiWithoutBrackets() {
  const plan = qwenGenerationPlanForTests([{
    segment_id: "seg_system",
    performance_units: voiceDirectionTransformForTests([
      "[Hidden skill awakened.]",
      "",
      "[Skill name: Chapter Zero.]",
    ].join("\n\n")).paragraph_units,
  }]);
  const units = plan.segments[0].qwen_generation_units;
  assert.equal(plan.system_ui_unit_count, 2);
  assert.deepEqual(units.map((unit) => unit.qwen_spoken_text), [
    "Hidden skill awakened.",
    "Skill name: Chapter Zero.",
  ]);
  assert.deepEqual(units.map((unit) => unit.caption_text), [
    "[Hidden skill awakened.]",
    "[Skill name: Chapter Zero.]",
  ]);
  assert.ok(units.every((unit) => unit.source_speaker === "SYSTEM"));
  assert.ok(units.every((unit) => /precise interface cadence/i.test(unit.qwen_instruct)));
}

async function testNarrationPaceChecks() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "One two three four five six seven.";
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");

  await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "script",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const scriptReport = JSON.parse(await fs.readFile(path.join(episodeDir, "script_pace_report.json"), "utf8"));
  assert.equal(scriptReport.status, "passed");
  assert.equal(scriptReport.target_wpm_min, 195);
  assert.equal(scriptReport.target_wpm_max, 220);
  assert.equal(scriptReport.script_word_count, 7);
  assert.equal(scriptReport.source_hashes[path.join(episodeDir, "script_clean.md")], scriptReport.source_script_hash);

  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptReport.source_script_hash,
    audio_duration_sec: 2,
    word_count: 7,
    words: Array.from({ length: 7 }, (_, index) => ({ word: String(index + 1), start: index * 0.25, end: index * 0.25 + 0.2 })),
  });
  await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "audio",
    "--episode-dir", episodeDir,
    "--episode", "ep_01",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const audioReport = JSON.parse(await fs.readFile(path.join(episodeDir, "narration_pace_report_ep_01.json"), "utf8"));
  assert.equal(audioReport.status, "passed");
  assert.equal(audioReport.actual_wpm, 210);
  assert.equal(audioReport.source_hashes[path.join(episodeDir, "script_clean.md")], scriptReport.source_script_hash);
  assert.ok(audioReport.source_hashes[path.join(episodeDir, "narration_word_timing_ep_01.json")]);

  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptReport.source_script_hash,
    audio_duration_sec: 3,
    word_count: 7,
    words: [],
  });
  await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "audio",
    "--episode-dir", episodeDir,
    "--episode", "ep_01",
    "--pace-policy", "diagnostic",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const diagnosticAudioReport = JSON.parse(await fs.readFile(path.join(episodeDir, "narration_pace_report_ep_01.json"), "utf8"));
  assert.equal(diagnosticAudioReport.status, "passed");
  assert.equal(diagnosticAudioReport.pace_policy, "diagnostic");
  assert.equal(diagnosticAudioReport.pace_gate_enforced, false);
  assert.equal(diagnosticAudioReport.diagnostic_pace_status, "blocked");
  assert.equal(diagnosticAudioReport.blocker, null);

  let blocked = null;
  try {
    await execFileAsync(process.execPath, [
      "scripts/narration-pace-check.mjs",
      "--mode", "audio",
      "--episode-dir", episodeDir,
      "--episode", "ep_01",
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  } catch (error) {
    blocked = error;
  }
  assert.equal(blocked?.code, 1);
  assert.match(blocked?.stdout ?? "", /"status": "blocked"/);
}

async function testScriptPaceDoesNotUseBuiltInEpisodeHookPhrases() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const filler = Array.from({ length: 130 }, (_, index) => `filler${index + 1}`).join(" ");
  const scriptText = `${filler} system activated. first quest complete. report to analytics hall.`;
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "script",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "script_pace_report.json"), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.hook_gate_enforced, false);
  assert.equal(report.diagnostic_hook_status, "not_configured");
  assert.equal(report.hook_milestone_report.configured, false);
  assert.deepEqual(report.hook_milestone_report.warnings, []);

  const hookMilestonesPath = path.join(episodeDir, "hook_milestones.json");
  await writeJson(hookMilestonesPath, {
    milestones: [{
      code: "configured_promise",
      label: "configured promise",
      patterns: ["configured promise"],
      target_sec: 30,
      reason: "Fixture-only configured hook promise is late.",
    }],
  });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), `${filler} configured promise.`, "utf8");
  let blocked = null;
  try {
    await execFileAsync(process.execPath, [
      "scripts/narration-pace-check.mjs",
      "--mode", "script",
      "--episode-dir", episodeDir,
      "--hook-milestones", hookMilestonesPath,
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  } catch (error) {
    blocked = error;
  }
  assert.equal(blocked?.code, 1);
  const configuredReport = JSON.parse(await fs.readFile(path.join(episodeDir, "script_pace_report.json"), "utf8"));
  assert.equal(configuredReport.status, "blocked");
  assert.equal(configuredReport.hook_gate_enforced, true);
  assert.equal(configuredReport.diagnostic_hook_status, "blocked");
  assert.equal(configuredReport.hook_milestone_report.configured, true);
  assert.equal(configuredReport.hook_milestone_report.warnings.some((warning) => warning.code === "late_configured_promise"), true);

  await execFileAsync(process.execPath, [
    "scripts/narration-pace-check.mjs",
    "--mode", "script",
    "--episode-dir", episodeDir,
    "--hook-milestones", hookMilestonesPath,
    "--pace-policy", "diagnostic",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const diagnosticReport = JSON.parse(await fs.readFile(path.join(episodeDir, "script_pace_report.json"), "utf8"));
  assert.equal(diagnosticReport.status, "passed");
  assert.equal(diagnosticReport.pace_policy, "diagnostic");
  assert.equal(diagnosticReport.hook_gate_enforced, false);
  assert.equal(diagnosticReport.diagnostic_hook_status, "blocked");
  assert.equal(diagnosticReport.blocker, null);
}

async function testTargetedSpeakabilityLiveContentHomograph() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), "The clip became live content before I could breathe. Crown Night was streaming live. Walk there on a live stream. My face became best-performing stream content. I had to go live before the timer hit zero.", "utf8");
  await execFileAsync(process.execPath, [
    "scripts/script-targeted-speakability.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--allow-unlocked-script", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "script_speakability_report.json"), "utf8"));
  const overrides = JSON.parse(await fs.readFile(path.join(episodeDir, "tts_spoken_overrides.json"), "utf8"));
  assert.equal(report.deterministic_risks.some((finding) => finding.code === "tts_homograph_live_content"), true);
  assert.equal(overrides.replacements.some((replacement) => (
    replacement.from === "live content"
    && replacement.to === "livestream video content"
    && replacement.scope === "qwen_spoken_text"
  )), true);
  assert.equal(overrides.replacements.some((replacement) => replacement.from === "streaming live" && replacement.to === "livestreaming"), true);
  assert.equal(overrides.replacements.some((replacement) => replacement.from === "live stream" && replacement.to === "livestream"), true);
  assert.equal(overrides.replacements.some((replacement) => replacement.from === "stream content" && replacement.to === "stream videos"), true);
  assert.equal(overrides.replacements.some((replacement) => replacement.from === "go live" && replacement.to === "start a livestream"), true);
}

async function testVisualBeatDensityDefaults() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const sentences = Array.from({ length: 80 }, (_, index) => {
    if (index === 0) return "Joey was humiliated on the stage.";
    if (index === 4) return "The system quest activated in front of him.";
    if (index === 8) return "The viewer count changed on the chat panel.";
    if (index === 16) return "He crossed into the analytics hall.";
    return `Sentence ${index + 1} moves the story forward.`;
  }).join(" ");
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), sentences, "utf8");
  const scriptHash = sha256(sentences);
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    timing_source: "fixture",
    audio_duration_sec: 180,
    scenes: [{
      scene_id: "scene_001",
      start_sec: 0,
      end_sec: 180,
      duration_sec: 180,
      location: "test arena",
      script_excerpt_start: "Joey was humiliated on the stage.",
      script_excerpt_end: "Sentence 80 moves the story forward.",
      visible_subjects: ["Joey", "Pookie"],
      visual_intent: "opening humiliation escalates into system proof",
    }],
  });
  const words = sentences.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    audio_duration_sec: 180,
    word_count: words.length,
    words: words.map((word, index) => ({
      index,
      word,
      start_sec: Number((index * 180 / words.length).toFixed(3)),
      end_sec: Number(((index + 0.82) * 180 / words.length).toFixed(3)),
    })),
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-beat-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_beat_plan.json"), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.visual_beat_contract_version, VISUAL_BEAT_CONTRACT_VERSION);
  assert.equal(report.hook_visual_beat_count >= 8, true);
  assert.equal(report.retention_ramp_visual_beat_count >= 24, true);
  assert.equal(report.beats.every((beat) => String(beat.visual_beat_script_excerpt ?? "").trim()), true);
  assert.equal(report.beats.every((beat) => Array.isArray(beat.ref_needs)), true);
  assert.equal(report.beats.some((beat) => beat.ref_needs.some((need) => need.generation_mode === "standalone_ref")), true);
  assert.equal(report.beats.some((beat) => Array.isArray(beat.visible_characters)), true);
  assert.equal(report.beats.some((beat) => Array.isArray(beat.local_props)), true);
  assert.equal(report.beats[0].visual_job, "premise_image");
  assert.equal(report.editorial_cue_counts.public_humiliation_or_reversal >= 1, true);
  assert.equal(report.beats.some((beat) => beat.visual_job === "system_reveal"), true);
  assert.equal(report.beats.some((beat) => beat.visual_job === "chat_ui_insert"), true);
  assert.equal(report.beats.some((beat) => beat.visual_job === "location_transition"), true);
  assert.equal(report.location_timeline.some((row) => row.location === "test arena"), true);
  assert.equal(typeof report.visual_beat_quality_summary?.finding_count, "number");
  assert.equal(report.beats.every((beat) => Array.isArray(beat.visual_beat_quality_findings)), true);
}

async function testVisualBeatQualityFindings() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const script = "Joey crossed into Analytics Hall. Agent00 waited beside the replay wall.";
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), script, "utf8");
  const scriptHash = sha256(script);
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    timing_source: "fixture",
    audio_duration_sec: 8,
    scenes: [{
      scene_id: "scene_001",
      start_sec: 0,
      end_sec: 8,
      duration_sec: 8,
      location: "dorm room",
      script_excerpt_start: "Joey crossed into Analytics Hall.",
      script_excerpt_end: "Agent00 waited beside the replay wall.",
      visible_subjects: ["Joey"],
      primary_subject: "Joey",
      character_states: [{ character: "Agent00", state: "waiting beside the replay wall" }],
      visual_intent: "fixture quality warning",
    }],
  });
  const words = script.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    audio_duration_sec: 8,
    word_count: words.length,
    words: words.map((word, index) => ({
      index,
      word,
      start_sec: Number((index * 8 / words.length).toFixed(3)),
      end_sec: Number(((index + 0.82) * 8 / words.length).toFixed(3)),
    })),
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-beat-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--allow-under-target-retention-beats", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_beat_plan.json"), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.visual_beat_quality_findings.some((finding) => finding.code === "location_mention_not_in_beat_location"), true);
  assert.equal(report.visual_beat_quality_findings.some((finding) => finding.code === "named_character_not_visible_subject"), false);
  assert.equal(report.beats.some((beat) => (beat.visible_characters ?? []).includes("Agent00")), true);
  assert.equal(report.beats.some((beat) => beat.visual_beat_quality_findings?.length), true);
}

async function runVisualBeatGenreFixture({ caseName, cueSentences, scenes, expectedJobs = [], expectedCueCodes = [] }) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", caseName, "episodes", "ep_01");
  const sentences = Array.from({ length: 80 }, (_, index) => (
    cueSentences[index] ?? `${caseName} story beat ${index + 1} keeps the current conflict moving with a clear present-tense action.`
  ));
  const script = sentences.join(" ");
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), script, "utf8");
  const scriptHash = sha256(script);
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    timing_source: "fixture",
    audio_duration_sec: 180,
    scenes: scenes.map((scene) => ({
      scene_id: scene.scene_id,
      start_sec: scene.start_sec,
      end_sec: scene.end_sec,
      duration_sec: Number((scene.end_sec - scene.start_sec).toFixed(3)),
      location: scene.location,
      script_excerpt_start: sentences[scene.start_sentence],
      script_excerpt_end: sentences[scene.end_sentence],
      visible_subjects: scene.visible_subjects,
      primary_subject: scene.primary_subject,
      character_states: scene.character_states ?? [],
      visual_intent: scene.visual_intent,
      action_staging: scene.action_staging ?? "",
    })),
  });
  const words = script.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    audio_duration_sec: 180,
    word_count: words.length,
    words: words.map((word, index) => ({
      index,
      word,
      start_sec: Number((index * 180 / words.length).toFixed(3)),
      end_sec: Number(((index + 0.82) * 180 / words.length).toFixed(3)),
    })),
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-beat-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", caseName,
    "--episode", "ep_01",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_beat_plan.json"), "utf8"));
  assert.equal(report.status, "passed", caseName);
  assert.equal(report.hook_visual_beat_count >= 8, true, `${caseName} hook density`);
  assert.equal(report.retention_ramp_visual_beat_count >= 24, true, `${caseName} ramp density`);
  assert.equal(report.beats.every((beat) => String(beat.visual_beat_script_excerpt ?? "").trim()), true, `${caseName} excerpts`);
  assert.equal(report.beats.every((beat) => String(beat.visual_job ?? "").trim()), true, `${caseName} visual jobs`);
  assert.equal(report.beats.every((beat) => String(beat.suggested_shot_job ?? "").trim()), true, `${caseName} shot jobs`);
  assert.equal(report.location_timeline.length >= scenes.length, true, `${caseName} location timeline`);
  for (const job of expectedJobs) {
    assert.equal(report.beats.some((beat) => beat.visual_job === job), true, `${caseName} expected visual job ${job}`);
  }
  for (const code of expectedCueCodes) {
    assert.equal((report.editorial_cue_counts?.[code] ?? 0) > 0, true, `${caseName} expected cue ${code}`);
  }
  return report;
}

async function testCrossGenreVisualBeatFixtures() {
  const sharedScenes = (locations, subjects) => [
    {
      scene_id: "scene_001",
      start_sec: 0,
      end_sec: 68,
      location: locations[0],
      start_sentence: 0,
      end_sentence: 29,
      visible_subjects: subjects.slice(0, 3),
      primary_subject: subjects[0],
      visual_intent: "opening premise, public pressure, and first rule reveal",
    },
    {
      scene_id: "scene_002",
      start_sec: 68,
      end_sec: 124,
      location: locations[1],
      start_sentence: 30,
      end_sentence: 54,
      visible_subjects: subjects.slice(0, 4),
      primary_subject: subjects[0],
      visual_intent: "new location and first external test",
    },
    {
      scene_id: "scene_003",
      start_sec: 124,
      end_sec: 180,
      location: locations[2],
      start_sentence: 55,
      end_sentence: 79,
      visible_subjects: subjects.slice(0, 3),
      primary_subject: subjects[0],
      visual_intent: "consequence, evidence, and next objective",
    },
  ];

  const cases = [
    {
      caseName: "corporate_evidence",
      cueSentences: {
        0: "Mara Stone exposed Daniel Reed in the boardroom, and every director watched his access badge turn red.",
        3: "A risk ledger opened above the wire transfer.",
        5: "Objective, freeze the shell account before the timer reaches zero.",
        8: "The public investor score dropped on the wall display.",
        12: "The chairman threatened to erase Daniel before the vote finished.",
        20: "Daniel showed the signed receipt and the room stopped laughing.",
        30: "Daniel crossed into the courthouse lobby with the sealed evidence bag.",
        37: "Judge Mora entered beside the witness camera.",
        44: "The audit panel marked the transfer complete.",
        55: "Daniel entered the archive server room and found the deleted contract.",
        70: "The final proof result exposed the betrayal.",
      },
      scenes: sharedScenes(["executive boardroom", "courthouse lobby", "archive server room"], ["Daniel Reed", "Mara Stone", "Chairman Vale", "Judge Mora"]),
      expectedJobs: ["humiliation_image", "system_reveal", "chat_ui_insert", "location_transition", "consequence"],
      expectedCueCodes: ["public_humiliation_or_reversal", "objective_or_reward", "chat_or_viewer_count_change", "location_signal"],
    },
    {
      caseName: "fantasy_gate",
      cueSentences: {
        0: "Ari was exiled in the temple courtyard while the clan elders laughed at his broken rank.",
        2: "A blue ability panel activated over his empty palm.",
        5: "Quest, survive the gate trial before sunset.",
        9: "The crowd's ranking stones changed color.",
        14: "A monster warning flashed beside the cracked gate.",
        18: "The elders mocked Ari again when his broken rank mark started to burn.",
        22: "Ari stepped forward and the courtyard fell silent.",
        30: "Ari crossed into the shadow gate corridor with Lysa behind him.",
        36: "Captain Ren arrived with the rescue lantern.",
        45: "The trial score reached one hundred percent.",
        55: "Ari entered the moon palace roof and saw the enemy banner.",
        72: "The consequence appeared as the clan seal shattered.",
      },
      scenes: sharedScenes(["temple courtyard", "shadow gate corridor", "moon palace roof"], ["Ari", "Lysa", "Elder Sol", "Captain Ren"]),
      expectedJobs: ["humiliation_image", "system_reveal", "chat_ui_insert", "location_transition", "threat_reveal"],
      expectedCueCodes: ["system_message", "objective_or_reward", "threat_reveal", "location_signal"],
    },
    {
      caseName: "romance_betrayal",
      cueSentences: {
        0: "Elena rejected Rowan in the wedding hall, and every guest heard her call him a charity case.",
        4: "His phone messages appeared on the banquet screen.",
        7: "The reputation counter beside her name dropped.",
        11: "Rowan noticed the best man smiling with the stolen ring.",
        15: "The guests mocked Rowan again when the apology card appeared on the banquet screen.",
        18: "Instead of begging, Rowan placed the invitation on the floor.",
        30: "Rowan walked into the airport terminal with one suitcase and no speech.",
        39: "Mira arrived at the gate holding the missing receipt.",
        48: "The message thread proved who planned the humiliation.",
        55: "Rowan entered the hospital corridor after the accident call.",
        68: "The consequence landed when Elena saw the visitor log.",
      },
      scenes: sharedScenes(["wedding hall", "airport terminal", "hospital corridor"], ["Rowan", "Elena", "Mira", "Best Man"]),
      expectedJobs: ["humiliation_image", "chat_ui_insert", "location_transition", "reaction_shot", "consequence"],
      expectedCueCodes: ["public_humiliation_or_reversal", "chat_or_viewer_count_change", "emotional_pivot", "location_signal"],
    },
    {
      caseName: "quiet_investigation",
      cueSentences: {
        0: "Nolan found the missing ledger in the city library while the mayor's aide watched from the stairs.",
        5: "Objective, match the receipt numbers before the archive closes.",
        9: "The trust score on the civic dashboard changed by one point.",
        13: "The aide warned him that the basement cameras were still recording.",
        22: "Nolan turned the page and saw the forged signature.",
        30: "Nolan entered the street market with the ledger hidden under his coat.",
        38: "A witness arrived near the fruit stall and handed him a key.",
        47: "The message on the old phone confirmed the payment route.",
        55: "Nolan crossed into the courthouse archive below the public floor.",
        73: "The proof result appeared when the sealed drawer opened.",
      },
      scenes: sharedScenes(["city library", "street market", "courthouse archive"], ["Nolan", "Mayor's Aide", "Witness", "Archivist"]),
      expectedJobs: ["chat_ui_insert", "location_transition", "reaction_shot", "consequence"],
      expectedCueCodes: ["objective_or_reward", "chat_or_viewer_count_change", "threat_reveal", "location_signal"],
    },
  ];

  for (const item of cases) await runVisualBeatGenreFixture(item);
}

function testLongLocationSpanCrossingRetentionBoundary() {
  const prompts = Array.from({ length: 28 }, (_, index) => ({
    image_id: `cut-${String(index + 1).padStart(3, "0")}`,
    start_sec: 140 + index * 7.2,
    duration_sec: 7.2,
    shot_manifest: { location_ref_id: "analytics_hall_ref" },
  }));
  const findings = longLocationSpanFindings(prompts, {
    maxSameLocationSpanSec: 150,
    retentionStartSec: 180,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].locationId, "analytics_hall_ref");
  assert.equal(findings[0].measured_after_retention_start_sec > 150, true);
}

function testRepeatedRetentionShotJobRunFindings() {
  const prompts = Array.from({ length: 4 }, (_, index) => ({
    image_id: `cut-${String(index + 1).padStart(3, "0")}`,
    start_sec: 42 + index * 4,
    duration_sec: 4,
    shot_manifest: {
      location_ref_id: "analytics_hall_ref",
      shot_job: "ui_reveal",
    },
  }));
  const findings = repeatedLocationShotJobFindings(prompts, {
    maxConsecutiveSameLocationShotJob: 3,
    retentionEndSec: 180,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].locationId, "analytics_hall_ref");
  assert.equal(findings[0].shotJob, "ui_reveal");
  assert.equal(findings[0].count, 4);
}

async function testVisualPlanBlocksOverbroadLocationRefCoverageBeforeLlm() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  const beats = Array.from({ length: 9 }, (_, index) => {
    const start = 181 + index * 15;
    return {
      scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
      parent_scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
      visual_beat_id: `scene_${String(index + 1).padStart(3, "0")}_beat_01`,
      start_sec: start,
      end_sec: start + 15,
      duration_sec: 15,
      location: index % 3 === 0 ? "analytics replay wall" : index % 3 === 1 ? "sponsor table floor" : "public campus screen plaza",
      visual_beat_script_excerpt: `Fixture beat ${index + 1} moves the proof through a distinct visible area.`,
      visual_job: index % 2 === 0 ? "consequence" : "reaction_shot",
      suggested_shot_job: index % 2 === 0 ? "consequence" : "emotional_reaction",
      ref_needs: [],
    };
  });
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    timing_source: "fixture",
    scenes: beats.map((beat) => ({
      scene_id: beat.scene_id,
      start_sec: beat.start_sec,
      end_sec: beat.end_sec,
      duration_sec: beat.duration_sec,
      location: beat.location,
    })),
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats,
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: hash, scenes: [] });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [{
      ref_id: "analytics_hall_ref",
      kind: "location",
      subject: "single broad analytics environment",
      scene_ids: beats.map((beat) => beat.scene_id),
      prompt_anchor: "large analytics media environment with screens, tables, and public display surfaces",
    }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", source_script_hash: hash, character_state_refs: [] });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), {});
  await writeJson(path.join(weekDir, "character_bible.json"), {});

  const dryRunOutput = path.join(episodeDir, "dry_run_visual_plan.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--dry-run-prompt", "true",
    "--output", dryRunOutput,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const dryRun = JSON.parse(await fs.readFile(dryRunOutput, "utf8"));
  assert.equal(dryRun.context_audit.scoped_location_coverage_findings.length, 1);
  assert.equal(dryRun.context_audit.scoped_location_coverage_findings[0].locationRefId, "analytics_hall_ref");

  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/visual-plan.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "run",
      "--episode", "ep_01",
      "--output", path.join(episodeDir, "section_image_prompts.json"),
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } }),
    /insufficient location-ref coverage/
  );
}

async function testVisualPlanAllowsSameLocationLabelAliases() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  const beats = Array.from({ length: 9 }, (_, index) => {
    const start = 181 + index * 15;
    const location = [
      "blood-smeared dungeon council chamber around a cracked fountain and scattered chests",
      "same dungeon council chamber beside the fountain and defensive chests",
      "dungeon council chamber fountain area with opened chests",
    ][index % 3];
    return {
      scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
      parent_scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
      visual_beat_id: `scene_${String(index + 1).padStart(3, "0")}_beat_01`,
      start_sec: start,
      end_sec: start + 15,
      duration_sec: 15,
      location,
      visual_beat_script_excerpt: `Fixture beat ${index + 1} remains in the same dungeon council chamber fountain area.`,
      visual_job: "humiliation_image",
      suggested_shot_job: "emotional_reaction",
      ref_needs: [],
    };
  });
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    timing_source: "fixture",
    scenes: beats.map((beat) => ({
      scene_id: beat.scene_id,
      start_sec: beat.start_sec,
      end_sec: beat.end_sec,
      duration_sec: beat.duration_sec,
      location: beat.location,
    })),
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats,
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: hash, scenes: [] });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [{
      ref_id: "dungeon_council_chamber_fountain_area_ref",
      kind: "location",
      subject: "dungeon council chamber fountain area",
      scene_ids: beats.map((beat) => beat.scene_id),
      prompt_anchor: "blood-smeared dungeon council chamber around a cracked fountain and scattered chests",
    }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", source_script_hash: hash, character_state_refs: [] });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), {});
  await writeJson(path.join(weekDir, "character_bible.json"), {});

  const dryRunOutput = path.join(episodeDir, "dry_run_visual_plan.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--dry-run-prompt", "true",
    "--output", dryRunOutput,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const dryRun = JSON.parse(await fs.readFile(dryRunOutput, "utf8"));
  assert.equal(dryRun.context_audit.scoped_location_coverage_findings.length, 0);
}

function testCharacterStagingSanitizerAndReviewBlockers() {
  const characterStateRefs = [
    {
      state_ref_id: "joey_state_ref",
      source_ref_id: "joey_ref",
      character: "Joey",
      scene_prompt_anchor: "dark varsity jacket over a white T-shirt, black jeans, scuffed sneakers",
    },
    {
      state_ref_id: "mira_state_ref",
      source_ref_id: "mira_ref",
      character: "Mira",
      scene_prompt_anchor: "cream fitted coat over a black dress, gold phone in hand, sharp heels",
    },
  ];
  const sanitized = sanitizeCharacterStaging([
    { name: "Joey", ref_id: "joey_state_ref", screen_position: "frame-left", wardrobe_from: "character_state_ref:joey_state_ref", pose: "half-turned toward Mira" },
  ]);
  assert.deepEqual(sanitized, [
    { name: "Joey", ref_id: "joey_state_ref", screen_position: "frame-left", wardrobe_from: "character_state_ref:joey_state_ref", pose: "half-turned toward Mira" },
  ]);

  const stagedManifest = {
    visible_characters: ["Joey", "Mira"],
    character_staging: [
      { name: "Joey", ref_id: "joey_state_ref", screen_position: "frame-left", wardrobe_from: "character_state_ref:joey_state_ref", pose: "half-turned toward Mira with one shoulder forward" },
      { name: "Mira", ref_id: "mira_state_ref", screen_position: "frame-right", wardrobe_from: "character_state_ref:mira_state_ref", pose: "chin lifted with her weight on the back foot" },
    ],
  };

  const matchingCoatsPrompt = {
    image_id: "ep_01-cut-010",
    scene_id: "scene_010",
    modelslab_image_prompt: "Joey and Mira stand together in matching coats near the lobby doors.",
    shot_manifest: stagedManifest,
  };
  const matchingCoatsFindings = multiCharacterBleedFindings(matchingCoatsPrompt, characterStateRefs);
  const matchingCoatsBlockers = matchingCoatsFindings.filter((finding) => finding.severity === "blocker" && finding.code === "character_attribute_bleed_risk");
  assert.equal(matchingCoatsBlockers.length, 1);

  const identicalHoodiesPrompt = {
    image_id: "ep_01-cut-011",
    scene_id: "scene_011",
    modelslab_image_prompt: "In the hallway, both Joey and Mira wear identical hoodies while staring each other down.",
    shot_manifest: stagedManifest,
  };
  const identicalHoodiesFindings = multiCharacterBleedFindings(identicalHoodiesPrompt, characterStateRefs);
  const identicalHoodiesBlockers = identicalHoodiesFindings.filter((finding) => finding.severity === "blocker" && finding.code === "character_attribute_bleed_risk");
  assert.equal(identicalHoodiesBlockers.length, 1);

  const naturalPositionPrompt = {
    image_id: "ep_01-cut-012",
    scene_id: "scene_012",
    modelslab_image_prompt: "On the left, Joey wears a dark varsity jacket over a white T-shirt and black jeans. On the right, Mira wears a cream fitted coat over a black dress and sharp heels.",
    shot_manifest: stagedManifest,
  };
  assert.equal(multiCharacterBleedFindings(naturalPositionPrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const eyelineWithWardrobePrompt = {
    image_id: "ep_01-cut-012b",
    scene_id: "scene_012",
    modelslab_image_prompt: "Center, Mira wears a cream fitted coat over a black dress, tense public composure, eyes caught between Joey and the judge. Frame-left, Joey wears a dark varsity jacket over a white T-shirt and black jeans.",
    shot_manifest: stagedManifest,
  };
  assert.equal(multiCharacterBleedFindings(eyelineWithWardrobePrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const separateWardrobeSharedTorsoPrompt = {
    image_id: "ep_01-cut-012c",
    scene_id: "scene_012",
    modelslab_image_prompt: "Frame-left, Joey wears a dark varsity jacket over a white T-shirt and black jeans while Mira wears a cream fitted coat over a black dress on frame-right; both full torsos stay clear above the table edge.",
    shot_manifest: stagedManifest,
  };
  assert.equal(multiCharacterBleedFindings(separateWardrobeSharedTorsoPrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const splitSentenceWardrobePrompt = {
    image_id: "ep_01-cut-013",
    scene_id: "scene_013",
    modelslab_image_prompt: "Frame-left stands Joey. He wears a dark varsity jacket over a white T-shirt and black jeans. Frame-right stands Mira. She wears a cream fitted coat over a black dress and sharp heels.",
    shot_manifest: stagedManifest,
  };
  assert.equal(multiCharacterBleedFindings(splitSentenceWardrobePrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const ownWardrobePrompt = {
    image_id: "ep_01-cut-014",
    scene_id: "scene_014",
    modelslab_image_prompt: "Joey faces Mira across the lobby in a dark varsity jacket. Mira squares up in a cream fitted coat with her phone in hand.",
    shot_manifest: stagedManifest,
  };
  assert.equal(multiCharacterBleedFindings(ownWardrobePrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const paraphrasedWardrobePrompt = {
    image_id: "ep_01-cut-015",
    scene_id: "scene_015",
    modelslab_image_prompt: "On the left, Joey stands in his usual casual layers. On the right, Mira answers him in a polished upscale outfit.",
    shot_manifest: stagedManifest,
  };
  const paraphrasedWardrobeFindings = multiCharacterBleedFindings(paraphrasedWardrobePrompt, characterStateRefs);
  assert.equal(paraphrasedWardrobeFindings.filter((finding) => finding.severity === "blocker").length, 0);
  assert.equal(paraphrasedWardrobeFindings.filter((finding) => finding.severity === "warning").length >= 1, true);

  const contextualStateLabelPrompt = {
    image_id: "ep_01-cut-015b",
    scene_id: "scene_015",
    modelslab_image_prompt: "Center foreground, Joey watches the giant screen. On the giant screen, old Joey appears in the Crown Night clip holding flowers while Lana laughs in the replay panel. Background rows of students watch quietly.",
    shot_manifest: {
      visible_characters: ["Joey", "Joey in Crown Night clip", "Lana in Crown Night clip", "five hundred students"],
      character_staging: [
        { name: "Joey", ref_id: "joey_state_ref", screen_position: "foreground", wardrobe_from: "character_state_ref:joey_state_ref", pose: "watching the replay screen" },
        { name: "Joey in Crown Night clip", ref_id: "joey_state_ref", screen_position: "center", wardrobe_from: "character_state_ref:joey_state_ref", pose: "holding flowers on the giant screen" },
        { name: "Lana in Crown Night clip", ref_id: "mira_state_ref", screen_position: "background-right", wardrobe_from: "character_state_ref:mira_state_ref", pose: "laughing in the replay panel" },
        { name: "five hundred students", screen_position: "background-left", pose: "watching from audience rows" },
      ],
    },
  };
  assert.equal(multiCharacterBleedFindings(contextualStateLabelPrompt, characterStateRefs).filter((finding) => finding.severity === "blocker").length, 0);

  const missingCoveragePrompt = {
    image_id: "ep_01-cut-016",
    scene_id: "scene_016",
    modelslab_image_prompt: "On the left, Joey wears a dark varsity jacket over a white T-shirt and black jeans.",
    shot_manifest: {
      visible_characters: ["Joey", "Mira"],
      character_staging: [
        { name: "Joey", ref_id: "joey_state_ref", screen_position: "frame-left", wardrobe_from: "character_state_ref:joey_state_ref", pose: "half-turned toward Mira with one shoulder forward" },
      ],
    },
  };
  assert.equal(multiCharacterBleedFindings(missingCoveragePrompt, characterStateRefs).some((finding) => finding.severity === "blocker" && /character_staging must cover every visible character/i.test(finding.message)), true);

  const singleCharacterPrompt = {
    image_id: "ep_01-cut-017",
    scene_id: "scene_017",
    modelslab_image_prompt: "Joey pauses alone in the lobby, dark varsity jacket over a white T-shirt, black jeans, scuffed sneakers, one hand tight on the bag strap.",
    shot_manifest: {
      visible_characters: ["Joey"],
    },
  };
  assert.equal(multiCharacterBleedFindings(singleCharacterPrompt, characterStateRefs).length, 0);
}

async function testOnlyScenesDryRun() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    timing_source: "fixture",
    scenes: [
      { scene_id: "scene_001", start_sec: 0, duration_sec: 5, location: "apartment" },
      { scene_id: "scene_002", start_sec: 5, duration_sec: 5, location: "boardroom" },
    ],
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats: [
      { scene_id: "scene_001", parent_scene_id: "scene_001", visual_beat_id: "scene_001_beat_01", start_sec: 0, duration_sec: 5, location: "apartment", ref_needs: [] },
      { scene_id: "scene_002", parent_scene_id: "scene_002", visual_beat_id: "scene_002_beat_01", start_sec: 5, duration_sec: 5, location: "boardroom", ref_needs: [] },
    ],
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: hash, scenes: [] });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [{ ref_id: "style_ref", kind: "style", scene_ids: [] }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", source_script_hash: hash, character_state_refs: [] });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), {});
  await writeJson(path.join(weekDir, "character_bible.json"), {});
  const output = path.join(episodeDir, "dry_run_visual_plan.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--dry-run-prompt", "true",
    "--only-scenes", "scene_002",
    "--output", output,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(report.visual_plan_scope.selected_visual_unit_count, 1);
  assert.deepEqual(report.visual_plan_scope.cut_ids, ["ep_01-cut-002"]);

  const existingOutput = path.join(episodeDir, "section_image_prompts.json");
  await writeJson(existingOutput, {
    schema: "goldflow_section_image_prompts_v1",
    status: "passed",
    prompts: [
      {
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        visual_beat_id: "scene_001_beat_01",
        provider_prompt: "16:9 landscape anime/manhwa view of the empty apartment.",
        image_prompt: "16:9 landscape anime/manhwa view of the empty apartment.",
        shot_manifest: { visible_characters: [], mentioned_only_characters: [], character_staging: [] },
      },
      {
        image_id: "ep_01-cut-002",
        scene_id: "scene_002",
        visual_beat_id: "scene_002_beat_01",
        provider_prompt: "16:9 landscape anime/manhwa view of the empty boardroom.",
        image_prompt: "16:9 landscape anime/manhwa view of the empty boardroom.",
        shot_manifest: { visible_characters: [], mentioned_only_characters: [], character_staging: [] },
      },
    ],
  });
  await execFileAsync(process.execPath, [
    "scripts/visual-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--revalidate-existing", "true",
    "--output", existingOutput,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const revalidated = JSON.parse(await fs.readFile(existingOutput, "utf8"));
  assert.equal(revalidated.status, "passed");
  assert.equal(revalidated.prompts.length, 2);
  assert.equal(revalidated.planner.revalidated_without_llm, true);
}

async function testOnlyCutIdsDryRun() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const weekDir = path.dirname(path.dirname(episodeDir));
  const hash = "fixture_hash";
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    timing_source: "fixture",
    scenes: [{ scene_id: "scene_001", start_sec: 0, duration_sec: 15, location: "event hall" }],
  });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: hash,
    beats: [
      { scene_id: "scene_001", parent_scene_id: "scene_001", visual_beat_id: "beat_001", start_sec: 0, duration_sec: 5, location: "event hall", ref_needs: [] },
      { scene_id: "scene_001", parent_scene_id: "scene_001", visual_beat_id: "beat_002", start_sec: 5, duration_sec: 5, location: "event hall", ref_needs: [] },
      { scene_id: "scene_001", parent_scene_id: "scene_001", visual_beat_id: "beat_003", start_sec: 10, duration_sec: 5, location: "event hall", ref_needs: [] },
    ],
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: hash, scenes: [] });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [{ ref_id: "style_ref", kind: "style", scene_ids: [] }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", source_script_hash: hash, character_state_refs: [] });
  await writeJson(path.join(weekDir, "visual_style_bible.json"), {});
  await writeJson(path.join(weekDir, "character_bible.json"), {});
  const output = path.join(episodeDir, "dry_run_visual_plan_cut_ids.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--dry-run-prompt", "true",
    "--cut-ids", "ep_01-cut-002",
    "--output", output,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(report.visual_plan_scope.selected_visual_unit_count, 1);
  assert.equal(report.visual_plan_scope.total_visual_unit_count, 3);
  assert.deepEqual(report.visual_plan_scope.cut_ids, ["ep_01-cut-002"]);
}

function testVisualResolveScopePrefersCutIds() {
  const blockers = [
    { severity: "blocker", resolved: false, scene_id: "scene_001", image_id: "ep_01-cut-002", code: "fixture_a" },
    { severity: "blocker", resolved: false, scene_id: "scene_001", image_id: "ep_01-cut-003", code: "fixture_b" },
  ];
  const scope = visualResolveScopeForBlockers(blockers);
  assert.equal(scope.mode, "cut_ids");
  assert.deepEqual(scope.args, ["--cut-ids", "ep_01-cut-002,ep_01-cut-003"]);
  const merged = mergeScopedPromptReplacements(
    [
      { image_id: "ep_01-cut-001", scene_id: "scene_001", prompt: "keep" },
      { image_id: "ep_01-cut-002", scene_id: "scene_001", prompt: "old two" },
      { image_id: "ep_01-cut-003", scene_id: "scene_001", prompt: "old three" },
    ],
    [{ image_id: "ep_01-cut-002", scene_id: "scene_001", prompt: "new two" }],
    scope
  );
  assert.deepEqual(merged.map((prompt) => prompt.prompt), ["keep", "new two", "old three"]);
  const sceneScope = visualResolveScopeForBlockers([{ severity: "blocker", resolved: false, scene_id: "scene_002", code: "scene_level" }]);
  assert.equal(sceneScope.mode, "scene_ids");
  assert.deepEqual(sceneScope.args, ["--only-scenes", "scene_002"]);
}

async function testImagegenDeadletterRefusal() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), { status: "passed", reference_targets: [] });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", character_state_refs: [] });
  await writeJson(path.join(episodeDir, "section_image_prompts_hardened.json"), {
    status: "passed",
    prompt_policy: "deterministic hardening fixture",
    prompts: [{ image_id: "ep_01-cut-001", scene_id: "scene_001", image_prompt: "one visible fixture frame", modelslab_image_prompt: "one visible fixture frame", image_generation_required: true }],
  });
  await writeJson(path.join(episodeDir, "visual_resolution_deadletter.json"), {
    status: "blocked_deadletter",
    scene_ids: ["scene_001"],
  });
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/imagegen.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "run",
      "--episode", "ep_01",
      "--skip-reference-generation", "true",
      "--allow-unhardened-prompts", "true",
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } }),
    /dead-lettered visual scenes/
  );

  const deadletterPath = path.join(episodeDir, "visual_resolution_deadletter.json");
  await writeJson(deadletterPath, {
    status: "resolved",
    previous_status: "blocked_deadletter",
    scene_ids: [],
    image_ids: [],
    unresolved_blockers: [],
  });
  await assert.doesNotReject(() => assertNoVisualResolutionDeadletterForTests(
    { status: "passed", visual_resolution_deadletter_path: deadletterPath },
    [{ image_id: "ep_01-cut-001", scene_id: "scene_001" }],
    { deadletterPath }
  ));

  await writeJson(deadletterPath, {
    status: "blocked_deadletter",
    scene_ids: ["scene_999"],
    image_ids: ["ep_01-cut-999"],
  });
  await assert.doesNotReject(() => assertNoVisualResolutionDeadletterForTests(
    { status: "passed", visual_resolution_deadletter_path: deadletterPath },
    [{ image_id: "ep_01-cut-001", scene_id: "scene_001" }],
    { deadletterPath }
  ));

  await writeJson(deadletterPath, {
    status: "blocked_deadletter",
    scene_ids: [],
    image_ids: ["ep_01-cut-001"],
  });
  await assert.rejects(
    () => assertNoVisualResolutionDeadletterForTests(
      { status: "passed", visual_resolution_deadletter_path: deadletterPath },
      [{ image_id: "ep_01-cut-001", scene_id: "scene_001" }],
      { deadletterPath }
    ),
    /dead-lettered visual cuts/
  );
}

function testHardenFeedbackBlockersMapToReviewResolveInput() {
  const promptPlan = {
    source_script_hash: "script_hash",
    prompts: [
      { image_id: "ep_01-cut-001", scene_id: "scene_001" },
      { image_id: "ep_01-cut-002", scene_id: "scene_002" },
    ],
  };
  const hardenReport = {
    status: "blocked",
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    source_script_hash: "script_hash",
    input_prompt_count: 2,
    findings: [
      {
        image_id: "ep_01-cut-002",
        scene_id: "scene_002",
        severity: "blocker",
        code: "physical_location_ref_missing",
        message: "fixture location blocker",
        resolved: false,
      },
      {
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        severity: "warning",
        code: "fixture_warning",
        resolved: true,
      },
    ],
  };
  const blockers = compatibleHardenFeedbackBlockers({
    hardenReport,
    promptPlan,
    channel: "test",
    series: "series",
    week: "run",
    episode: "ep_01",
    hardenReportPath: "/tmp/harden.json",
  });
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].source_stage, "visual_harden");
  assert.equal(blockers[0].source_report_path, "/tmp/harden.json");
  assert.equal(blockers[0].image_id, "ep_01-cut-002");
  assert.equal(blockers[0].code, "physical_location_ref_missing");
  assert.equal(hasHardenFeedbackFindings(blockers), true);
  assert.equal(hardenFeedbackBlockersNeedManualAgentReview(blockers), true);
  assert.equal(
    hardenFeedbackBlockersNeedManualAgentReview([
      ...blockers,
      { image_id: "ep_01-cut-003", scene_id: "scene_003", severity: "blocker", code: "regular_review_blocker", resolved: false },
    ]),
    false
  );
  assert.deepEqual(
    compatibleHardenFeedbackBlockers({
      hardenReport,
      promptPlan: { ...promptPlan, source_script_hash: "other_hash" },
      channel: "test",
      series: "series",
      week: "run",
      episode: "ep_01",
    }),
    []
  );
}

async function testRunStatusResumesBlockedVisualReviewWithoutFullReplan() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture narration for scoped visual review resume.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(path.join(episodeDir, "assets", "audio"), { recursive: true });
  await fs.mkdir(path.join(episodeDir, "assets", "images", "references"), { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash, replacements: [] });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash });
  const narrationPath = path.join(episodeDir, "assets", "audio", "fixture_narration.wav");
  await fs.writeFile(narrationPath, Buffer.from("fixture audio"));
  const narrationHash = sha256(await fs.readFile(narrationPath));
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    output_path: narrationPath,
    final_duration_sec: 1,
  });
  const wordTimingPath = path.join(episodeDir, "narration_word_timing_ep_01.json");
  await writeJson(wordTimingPath, { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash, word_count: 4, audio_duration_sec: 1 });
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    target_wpm_min: 195,
    target_wpm_max: 220,
    actual_wpm: 215,
  });
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    scenes: [
      { scene_id: "scene_001", start_sec: 0, end_sec: 1, duration_sec: 1 },
      { scene_id: "scene_002", start_sec: 1, end_sec: 2, duration_sec: 1 },
    ],
  });
  const finalAudioPath = path.join(episodeDir, "assets", "audio", "final_mix.m4a");
  await fs.writeFile(finalAudioPath, Buffer.from("fixture final audio"));
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), { status: "passed", final_audio_path: finalAudioPath });
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: scriptHash,
    beats: [],
  });
  const refPath = path.join(episodeDir, "assets", "images", "references", "style_ref.png");
  await fs.writeFile(refPath, Buffer.from("fixture ref"));
  const referenceInventoryPath = await writeFixtureReferenceInventory(episodeDir, scriptHash, [
    { asset_id: "style_ref", ref_id: "style_ref", kind: "style", subject: "fixture style", scene_ids: [], beat_ids: [] },
  ]);
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    reference_inventory_ledger_path: referenceInventoryPath,
    reference_targets: [{ ref_id: "style_ref", kind: "style", generation_mode: "standalone_ref", reference_image_path: refPath }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), { status: "approved", source_script_hash: scriptHash, character_state_refs: [] });
  const prompts = [
    { image_id: "ep_01-cut-001", scene_id: "scene_001", visual_beat_id: "beat_001", modelslab_image_prompt: "fixture prompt one", image_prompt: "fixture prompt one" },
    { image_id: "ep_01-cut-002", scene_id: "scene_002", visual_beat_id: "beat_002", modelslab_image_prompt: "fixture prompt two", image_prompt: "fixture prompt two" },
  ];
  await writeJson(path.join(episodeDir, "section_image_prompts.json"), { status: "passed", source_script_hash: scriptHash, prompts });

  const { stdout: initialStdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const initialStatus = JSON.parse(initialStdout);
  assert.equal(initialStatus.current_stage, "visual_prompt_harden");
  assert.match(initialStatus.next_command_shape, /visual harden/);
  assert.match(initialStatus.next_command_shape, /section_image_prompts\.json/);
  assert.doesNotMatch(initialStatus.next_command_shape, /visual review/);

  await writeJson(path.join(episodeDir, "section_image_prompts_reviewed.json"), { status: "blocked", source_script_hash: scriptHash, prompts });
  await writeJson(path.join(episodeDir, "visual_prompt_review_ep_01.json"), {
    status: "blocked",
    findings: [{ severity: "blocker", resolved: false, code: "fixture_visual_blocker", scene_id: "scene_002", image_id: "ep_01-cut-002" }],
    unresolved_blocker_count: 1,
  });

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  assert.equal(status.current_stage, "visual_prompt_harden");
  assert.match(status.next_command_shape, /visual review/);
  assert.match(status.next_command_shape, /--resume-blocked true/);
  assert.doesNotMatch(status.next_command_shape, /visual plan/);
  assert.doesNotMatch(status.next_command_shape, /visual harden/);

  const oldHardenTime = new Date("2026-01-01T00:00:00.000Z");
  const newReviewTime = new Date("2026-01-01T00:01:00.000Z");
  const hardenReportPath = path.join(episodeDir, "visual_prompt_hardening_ep_01.json");
  const hardenedPlanPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  const reviewedPlanPath = path.join(episodeDir, "section_image_prompts_reviewed.json");
  await writeJson(hardenedPlanPath, { status: "blocked", source_script_hash: scriptHash, prompts });
  await writeJson(hardenReportPath, {
    status: "blocked",
    source_script_hash: scriptHash,
    findings: [{ severity: "blocker", resolved: false, code: "fixture_harden_blocker", scene_id: "scene_002", image_id: "ep_01-cut-002" }],
    unresolved_blocker_count: 1,
  });
  await fs.utimes(hardenedPlanPath, oldHardenTime, oldHardenTime);
  await fs.utimes(hardenReportPath, oldHardenTime, oldHardenTime);
  await writeJson(reviewedPlanPath, { status: "passed", source_script_hash: scriptHash, prompts });
  await fs.utimes(reviewedPlanPath, newReviewTime, newReviewTime);

  const { stdout: repairedStdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const repairedStatus = JSON.parse(repairedStdout);
  assert.equal(repairedStatus.current_stage, "visual_prompt_harden");
  assert.match(repairedStatus.next_command_shape, /visual harden/);
  assert.doesNotMatch(repairedStatus.next_command_shape, /--resume-blocked true/);

  const manualReviewPath = path.join(episodeDir, "visual_manual_agent_review_ep_01.json");
  await writeJson(manualReviewPath, {
    status: "needs_manual_agent_review",
    image_ids: ["ep_01-cut-002"],
    unresolved_blockers: [{ severity: "blocker", resolved: false, source_stage: "visual_harden", code: "fixture_harden_blocker" }],
  });
  await writeJson(reviewedPlanPath, {
    status: "needs_manual_agent_review",
    source_script_hash: scriptHash,
    prompts,
    visual_manual_agent_review_path: manualReviewPath,
  });
  const { stdout: manualStdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const manualStatus = JSON.parse(manualStdout);
  const manualStage = manualStatus.stage_ledger.find((row) => row.stage === "visual_prompt_harden");
  assert.equal(manualStatus.current_stage, "visual_prompt_harden");
  assert.equal(manualStage.exists, false);
  assert.match(manualStatus.next_command_shape, /Manual agent review required/);
  assert.match(manualStatus.next_command_shape, /visual_manual_agent_review_ep_01\.json/);
}

function testPassedReviewClearsDeadletterPayload() {
  const resolved = resolvedDeadletterPayload(
    {
      status: "blocked_deadletter",
      channel: "test",
      series_slug: "series",
      week: "run",
      episode: "ep_01",
      scene_ids: ["scene_002"],
      unresolved_blockers: [{ scene_id: "scene_002", code: "missing_ref" }],
    },
    {
      channel: "test",
      series: "series",
      week: "run",
      episode: "ep_01",
      reviewReportPath: "/tmp/review.json",
      reviewedPromptPlanPath: "/tmp/reviewed.json",
      now: "2026-06-30T00:00:00.000Z",
    }
  );
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.previous_status, "blocked_deadletter");
  assert.deepEqual(resolved.scene_ids, []);
  assert.deepEqual(resolved.unresolved_blockers, []);
  assert.equal(resolved.resolved_by_review_report_path, "/tmp/review.json");
  assert.equal(
    resolvedDeadletterPayload({ status: "blocked_deadletter", episode: "ep_02" }, { episode: "ep_01" }),
    null
  );
}

async function runVisualHardenFixture({ dataRoot, promptText, codexPromptText = null, shotManifest = {}, referenceRequirements = [], referenceUsage = [], extraReferenceTargets = [], extraInventoryAssets = [], extraCharacterStateRefs = [], manualTriage = null, includeDefaultLocationRef = true, includeDefaultCharacterRef = true, locationContracts = null, referenceDirectorContractVersion = null }) {
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const hash = "fixture_hash";
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    scenes: [{ scene_id: "scene_001", start_sec: 0, duration_sec: 5, location: "apartment kitchen" }],
  });
  const referenceTargets = [
    ...(includeDefaultLocationRef ? [{ ref_id: "loc_apartment", kind: "location", subject: "apartment kitchen", scene_ids: ["scene_001"], reference_image_path: "/tmp/loc_apartment.png" }] : []),
    ...(includeDefaultCharacterRef ? [{ ref_id: "char_joey_ref", kind: "character_state", subject: "Joey", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_joey_ref.png" }] : []),
    ...extraReferenceTargets,
  ];
  const referenceInventoryPath = await writeFixtureReferenceInventory(episodeDir, hash, [
    ...referenceTargets.map((target) => ({
      asset_id: target.ref_id,
      ...target,
      recommended_generation_mode: target.generation_mode ?? (target.reference_image_path ? "standalone_ref" : "no_ref_needed"),
      recommended_required_before_imagegen: target.required_before_imagegen ?? Boolean(target.reference_image_path),
    })),
    ...extraInventoryAssets,
  ]);
  const locationContractPath = path.join(episodeDir, "location_contract_ledger.json");
  if (locationContracts) {
    await writeJson(locationContractPath, {
      schema: "goldflow_location_contract_ledger_v1",
      status: "passed",
      source_script_hash: hash,
      contracts: locationContracts,
    });
  }
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_director_contract_version: referenceDirectorContractVersion,
    location_contract_ledger_path: locationContracts ? locationContractPath : null,
    reference_inventory_ledger_path: referenceInventoryPath,
    reference_targets: referenceTargets,
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    status: "approved",
    source_script_hash: hash,
    character_state_refs: [
      ...(includeDefaultCharacterRef ? [{ state_ref_id: "char_joey_state", source_ref_id: "char_joey_ref", character: "Joey", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_joey_ref.png" }] : []),
      ...extraCharacterStateRefs,
    ],
  });
  await writeJson(path.join(episodeDir, "section_image_prompts_reviewed.json"), {
    status: "passed",
    source_script_hash: hash,
    prompts: [{
      image_id: "ep_01-cut-001",
      scene_id: "scene_001",
      image_prompt: promptText,
      modelslab_image_prompt: promptText,
      codex_image_prompt: codexPromptText,
      location: "apartment kitchen",
      reference_requirements: referenceRequirements,
      reference_usage: referenceUsage,
      shot_manifest: {
        visible_characters: ["Joey"],
        character_state_ref_ids: ["char_joey_state"],
        location_contract_id: null,
        location_ref_id: "loc_apartment",
        forbidden_ref_ids: [],
        ...shotManifest,
      },
    }],
  });
  if (manualTriage) {
    await writeJson(path.join(episodeDir, "visual_manual_blocker_triage_ep_01.json"), manualTriage);
  }
  let error = null;
  try {
    await execFileAsync(process.execPath, [
      "scripts/visual-prompt-harden.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "run",
      "--episode", "ep_01",
      "--prompts", path.join(episodeDir, "section_image_prompts_reviewed.json"),
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  } catch (caught) {
    error = caught;
  }
  const plan = JSON.parse(await fs.readFile(path.join(episodeDir, "section_image_prompts_hardened.json"), "utf8"));
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_prompt_hardening_ep_01.json"), "utf8"));
  return { plan, report, error };
}

async function testVisualHardenAllowsStoryFaithfulNegativeWordsWithoutRewrite() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk, no second character, no readable text.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 5 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(plan.prompts[0].modelslab_image_prompt, promptText);
  assert.equal(plan.prompts[0].image_prompt, promptText);
  assert.equal(report.findings.some((finding) => finding.code === "provider_exclusion_payload"), false);
}

async function testVisualHardenStripsNonAttachableScopedRefs() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk with a small holographic one-scene notice on his phone.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    extraReferenceTargets: [{
      ref_id: "late_ui_ref",
      kind: "ui",
      subject: "one-scene phone notice",
      scene_ids: ["scene_001"],
      generation_mode: "no_ref_needed",
      required_before_imagegen: false,
      prompt_anchor: "scoped text-only UI target for a simple phone notice",
    }],
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "late_ui_ref", kind: "ui", slot_order: 2 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 3 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment", "char_joey_state"]);
  assert.equal(report.findings.some((finding) => finding.code === "non_attachable_reference_stripped" && finding.ref_id === "late_ui_ref"), true);
}

async function testVisualHardenRetainsPendingDerivedRequirementWithoutSlot() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Anime/manhwa frame. Joey studies the massive black mirror in the academy courtyard.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    extraReferenceTargets: [{
      ref_id: "obsidian_mirror_ref",
      kind: "prop",
      subject: "Obsidian Mirror",
      scene_ids: ["scene_001"],
      generation_mode: "derive_from_best_cut",
      required_before_imagegen: false,
      prompt_anchor: "massive vertical black mirror with an oil-like surface",
    }],
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 2 },
      { ref_id: "obsidian_mirror_ref", kind: "prop", slot_order: 3 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  const pending = plan.prompts[0].reference_requirements.find((requirement) => requirement.ref_id === "obsidian_mirror_ref");
  assert.equal(pending.pending_derived_reference, true);
  assert.equal(pending.reference_image_path, null);
  assert.equal(plan.prompts[0].reference_slots.some((slot) => slot.ref_id === "obsidian_mirror_ref"), false);
  assert.equal(report.findings.some((finding) => finding.code === "pending_derived_reference_retained"), true);
}

async function testVisualHardenAcceptsInventoryOnlyLocationContract() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText: "Anime/manhwa frame. Joey stands at a rain-dark academy evacuation fork divided between a forest path and a smoke-covered wall.",
    includeDefaultLocationRef: false,
    extraInventoryAssets: [{
      asset_id: "academy_evacuation_fork",
      ref_id: "academy_evacuation_fork",
      kind: "location",
      subject: "rain-dark academy evacuation fork",
      scene_ids: ["scene_001"],
      recommended_generation_mode: "no_ref_needed",
      recommended_required_before_imagegen: false,
    }],
    shotManifest: {
      visible_characters: [],
      location_ref_id: "academy_evacuation_fork",
      foreground_action: "empty fork under rain",
    },
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => finding.code === "unknown_manifest_location_ref"), false);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_text_only"), true);
}

async function testVisualHardenLeavesCleanPromptByteIdenticalAndNormalizesRefs() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk with bills spread across the table in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 9 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(plan.prompts[0].modelslab_image_prompt, promptText);
  assert.equal(plan.prompts[0].image_prompt, promptText);
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment", "char_joey_state"]);
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.slot_order), [1, 2]);
  assert.deepEqual(plan.prompts[0].reference_slots.map((slot) => slot.ref_id), ["loc_apartment", "char_joey_state"]);
  assert.deepEqual(plan.prompts[0].required_reference_paths, plan.prompts[0].reference_slots.map((slot) => slot.path));
  assert.equal(report.findings.some((finding) => finding.code === "provider_exclusion_payload"), false);
}

async function testVisualHardenCanonicalizesStateRefRequirements() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk with bills spread across the table in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_state", kind: "character_state", slot_order: 2 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment", "char_joey_state"]);
  assert.equal(plan.prompts[0].shot_manifest.character_state_ref_ids[0], "char_joey_state");
  assert.equal(report.findings.some((finding) => finding.code === "unknown_reference_id"), false);
}

async function testVisualHardenBlocksVisibleCharacterWhenScopedRefOmitted() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey stands at the apartment desk holding a red ledger stamp while the room watches.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceRequirements: [{ ref_id: "loc_apartment", kind: "location", slot_order: 1 }],
    shotManifest: {
      visible_characters: ["Joey"],
      character_state_ref_ids: [],
      protagonist_state_ref_id: null,
    },
  });
  assert.notEqual(error, null);
  assert.equal(plan.status, "blocked");
  assert.equal(report.findings.some((finding) => (
    finding.code === "visible_character_ref_not_attached"
    && finding.character === "Joey"
    && finding.available_ref_ids.includes("char_joey_ref")
  )), true);
}

async function testVisualHardenBlocksVisibleCharacterWhenOnlyOutOfScopeRefExists() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey swings the red paddle across a mahogany desk in the contract-sky office chamber.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    includeDefaultCharacterRef: false,
    extraReferenceTargets: [{
      ref_id: "char_joey_ref",
      kind: "character_state",
      subject: "Joey",
      scene_ids: ["scene_002"],
      reference_image_path: "/tmp/char_joey_ref.png",
    }],
    extraCharacterStateRefs: [{
      state_ref_id: "char_joey_state",
      source_ref_id: "char_joey_ref",
      character: "Joey",
      scene_ids: ["scene_002"],
      reference_image_path: "/tmp/char_joey_ref.png",
      scene_prompt_anchor: "Joey, adult male protagonist in dark practical confrontation clothing",
    }],
    referenceRequirements: [{ ref_id: "loc_apartment", kind: "location", slot_order: 1 }],
    shotManifest: {
      visible_characters: ["Joey"],
      character_state_ref_ids: [],
      protagonist_state_ref_id: null,
      foreground_action: "Joey swings the red paddle in the contract-sky office chamber",
    },
  });
  assert.notEqual(error, null);
  assert.equal(plan.status, "blocked");
  assert.equal(report.findings.some((finding) => (
    finding.code === "visible_character_ref_scope_missing"
    && finding.character === "Joey"
    && finding.out_of_scope_ref_ids.includes("char_joey_ref")
  )), true);
}

async function testVisualHardenBlocksAttachedCharacterRefWhenAnchorIgnored() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const vaguePromptText = "Frame-left, Joey in clean academy clothes watches the stage with a controlled expression.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText: vaguePromptText,
    codexPromptText: vaguePromptText,
    extraCharacterStateRefs: [{
      state_ref_id: "char_joey_state",
      source_ref_id: "char_joey_ref",
      character: "Joey",
      scene_ids: ["scene_001"],
      reference_image_path: "/tmp/char_joey_ref.png",
      scene_prompt_anchor: "Joey, dark practical confrontation clothing, controlled survivor-auditor presence, restrained but ready",
    }],
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 2 },
    ],
  });
  assert.notEqual(error, null);
  assert.equal(plan.status, "blocked");
  assert.equal(report.findings.some((finding) => (
    finding.code === "character_ref_anchor_not_reaffirmed"
    && finding.ref_id === "char_joey_state"
    && finding.prompt_field === "modelslab_image_prompt"
  )), true);
  assert.equal(report.findings.some((finding) => (
    finding.code === "character_ref_anchor_not_reaffirmed"
    && finding.ref_id === "char_joey_state"
    && finding.prompt_field === "codex_image_prompt"
  )), false);
}

async function testVisualHardenAllowsAttachedCharacterRefWhenAnchorReaffirmed() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Frame-left, Joey in dark practical confrontation clothing stands with controlled survivor-auditor presence, restrained but ready, watching the stage.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    codexPromptText: promptText,
    extraCharacterStateRefs: [{
      state_ref_id: "char_joey_state",
      source_ref_id: "char_joey_ref",
      character: "Joey",
      scene_ids: ["scene_001"],
      reference_image_path: "/tmp/char_joey_ref.png",
      scene_prompt_anchor: "Joey, dark practical confrontation clothing, controlled survivor-auditor presence, restrained but ready",
    }],
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 2 },
    ],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.findings.some((finding) => finding.code === "character_ref_anchor_not_reaffirmed"), false);
}

async function testVisualHardenPreservesAttachableFaceOnlyStateRef() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey sits at the office workstation in open-collar work clothes, wrist mark visible, exhausted but steady.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    extraReferenceTargets: [
      {
        ref_id: "joey_office_worker_ref",
        kind: "character_state",
        subject: "Joey",
        scene_ids: ["scene_001"],
        identity_usage: "face_only",
        base_identity_ref_id: "char_joey_ref",
        reference_image_path: "/tmp/joey_office_worker_ref.png",
        scene_prompt_anchor: "Joey in open-collar work clothes with wrist mark visible",
      },
    ],
    extraCharacterStateRefs: [
      {
        state_ref_id: "joey_office_worker_ref",
        source_ref_id: "char_joey_ref",
        character: "Joey",
        scene_ids: ["scene_001"],
        identity_usage: "face_only",
        base_identity_ref_id: "char_joey_ref",
        reference_image_path: "/tmp/joey_office_worker_ref.png",
        scene_prompt_anchor: "Joey in open-collar work clothes with wrist mark visible",
      },
    ],
    referenceRequirements: [
      { ref_id: "loc_apartment", kind: "location", slot_order: 1 },
      { ref_id: "joey_office_worker_ref", kind: "character_state", slot_order: 2 },
    ],
    shotManifest: {
      character_state_ref_ids: ["joey_office_worker_ref"],
      protagonist_state_ref_id: "joey_office_worker_ref",
    },
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment", "joey_office_worker_ref"]);
  assert.equal(plan.prompts[0].reference_requirements[1].reference_image_path, "/tmp/joey_office_worker_ref.png");
  assert.equal(plan.prompts[0].reference_requirements[1].base_identity_ref_id, "char_joey_ref");
  assert.equal(plan.prompts[0].shot_manifest.character_state_ref_ids[0], "joey_office_worker_ref");
  assert.equal(plan.prompts[0].shot_manifest.protagonist_state_ref_id, "joey_office_worker_ref");
  assert.equal(report.findings.some((finding) => finding.code === "unknown_reference_id"), false);
}

async function testVisualHardenBlocksMissingManifestLocationWithoutAddingIt() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk with bills spread across the table in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceRequirements: [{ ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 }],
  });
  assert.notEqual(error, null);
  assert.equal(plan.status, "blocked");
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["char_joey_state"]);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_not_attached_report_only"), true);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_missing_after_sanitize" && finding.severity === "blocker"), true);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_added"), false);
}

async function testVisualHardenBlocksMissingPendingDerivedLocationContract() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey stands in the academy courtyard under the punishment pillar while students watch from the gate.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    includeDefaultLocationRef: false,
    shotManifest: { location_ref_id: null },
    extraReferenceTargets: [{
      ref_id: "academy_courtyard_ref",
      kind: "location",
      subject: "academy courtyard",
      scene_ids: ["scene_001"],
      generation_mode: "derive_from_first_clean_wide_cut",
      prompt_anchor: "academy courtyard punishment pillar and main gate",
    }],
    referenceRequirements: [{ ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 }],
  });
  assert.notEqual(error, null);
  assert.equal(plan.status, "blocked");
  assert.equal(report.findings.some((finding) => finding.code === "physical_location_ref_missing" && finding.severity === "blocker"), true);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_added"), false);
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["char_joey_state"]);
}

async function testVisualHardenV2AcceptsTextLocationContractWithoutImageRef() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey stands alone in the apartment kitchen beside the window in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceDirectorContractVersion: "reference_director_v2",
    locationContracts: [{
      location_contract_id: "apartment_kitchen_contract",
      scene_ids: ["scene_001"],
      description: "apartment kitchen",
      prompt_anchor: "compact apartment kitchen with one window and dark counters",
    }],
    includeDefaultLocationRef: false,
    shotManifest: {
      location_contract_id: "apartment_kitchen_contract",
      location_ref_id: null,
    },
    referenceRequirements: [{ ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 }],
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(plan.prompts[0].shot_manifest.location_contract_id, "apartment_kitchen_contract");
  assert.equal(plan.prompts[0].shot_manifest.location_ref_id, null);
  assert.equal(report.findings.some((finding) => finding.code === "physical_location_contract_missing"), false);
}

async function testVisualHardenV2BlocksUnknownLocationContract() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey stands alone in the apartment kitchen beside the window in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    referenceDirectorContractVersion: "reference_director_v2",
    locationContracts: [{
      location_contract_id: "apartment_kitchen_contract",
      scene_ids: ["scene_001"],
      description: "apartment kitchen",
      prompt_anchor: "compact apartment kitchen with one window and dark counters",
    }],
    includeDefaultLocationRef: false,
    shotManifest: {
      location_contract_id: "invented_location_contract",
      location_ref_id: null,
    },
    referenceRequirements: [{ ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 }],
  });
  assert.notEqual(error, null);
  assert.equal(plan.status, "blocked");
  assert.equal(report.findings.some((finding) => finding.code === "unknown_location_contract_id" && finding.severity === "blocker"), true);
}

async function testVisualHardenManualTriageCanDisregardSpecificBlocker() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Joey at the apartment desk with bills spread across the table in quiet morning light.";
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    shotManifest: { location_ref_id: null },
    referenceRequirements: [{ ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 }],
    manualTriage: {
      schema: "goldflow_visual_manual_blocker_triage_v1",
      status: "approved",
      dispositions: [{
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        code: "physical_location_ref_missing",
        disposition: "manual_disregard",
        rationale: "Fixture agent verified the available location ref is intentionally not applicable.",
      }],
    },
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.equal(report.manual_triage_applied_count, 1);
  assert.equal(report.findings.some((finding) => finding.code === "physical_location_ref_missing" && finding.manual_disposition === "manual_disregard"), true);
  assert.equal(report.unresolved_blocker_count, 0);
}

async function testVisualHardenPreservesCrowdedCharacterRefsOverOmittedLocation() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const promptText = "Four named characters stand on the apartment kitchen floor with clear separate bodies and a visible table edge.";
  const extraReferenceTargets = [
    { ref_id: "char_pookie_ref", kind: "character_state", subject: "Pookie", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_pookie_ref.png" },
    { ref_id: "char_kai_ref", kind: "character_state", subject: "Kai", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_kai_ref.png" },
    { ref_id: "char_jinx_ref", kind: "character_state", subject: "Jinx", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_jinx_ref.png" },
  ];
  const extraCharacterStateRefs = [
    { state_ref_id: "char_pookie_state", source_ref_id: "char_pookie_ref", character: "Pookie", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_pookie_ref.png" },
    { state_ref_id: "char_kai_state", source_ref_id: "char_kai_ref", character: "Kai", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_kai_ref.png" },
    { state_ref_id: "char_jinx_state", source_ref_id: "char_jinx_ref", character: "Jinx", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_jinx_ref.png" },
  ];
  const { plan, report, error } = await runVisualHardenFixture({
    dataRoot,
    promptText,
    extraReferenceTargets,
    extraCharacterStateRefs,
    referenceRequirements: [
      { ref_id: "char_joey_ref", kind: "character_state", slot_order: 1 },
      { ref_id: "char_pookie_ref", kind: "character_state", slot_order: 2 },
      { ref_id: "char_kai_ref", kind: "character_state", slot_order: 3 },
      { ref_id: "char_jinx_ref", kind: "character_state", slot_order: 4 },
    ],
    referenceUsage: [{
      ref_id: "loc_apartment",
      usage: "available_not_attached_reference_limit",
      reason: "Four visible character refs fill the available reference slots.",
    }],
    shotManifest: {
      visible_characters: ["Joey", "Pookie", "Kai", "Jinx"],
      character_state_ref_ids: ["char_joey_state", "char_pookie_state", "char_kai_state", "char_jinx_state"],
      location_ref_id: "loc_apartment",
    },
  });
  assert.equal(error, null);
  assert.equal(plan.status, "passed");
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), [
    "char_joey_state",
    "char_pookie_state",
    "char_kai_state",
    "char_jinx_state",
  ]);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_omitted_for_reference_limit"), true);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_character_ref_dropped_for_location_ref_limit"), false);
}

async function testNarratorOnlyStatusAndMixer() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture narration.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(path.join(episodeDir, "assets", "audio"), { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed" });
  const narrationPath = path.join(episodeDir, "assets", "audio", "fixture_narration.wav");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "0.8",
    "-acodec", "pcm_s16le",
    narrationPath,
  ]);
  const narrationHash = sha256(await fs.readFile(narrationPath));
  const wordTimingPath = path.join(episodeDir, "narration_word_timing_ep_01.json");
  await writeJson(wordTimingPath, { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash, word_count: 3, audio_duration_sec: 0.84 });
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    target_wpm_min: 195,
    target_wpm_max: 220,
    actual_wpm: 214.286,
    source_hashes: {
      [path.join(episodeDir, "script_clean.md")]: scriptHash,
      [wordTimingPath]: sha256(await fs.readFile(wordTimingPath)),
    },
  });
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), {
    status: "passed",
    output_path: narrationPath,
    segments: [{ segment_id: "seg_001", duration_sec: 0.8 }],
  });

  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  assert.equal(status.current_stage, "longform_audio_mix");
  assert.match(status.next_command_shape, /--narration-only true/);
  assert.equal(status.stage_ledger.find((row) => row.stage === "script_pace_check").exists, true);
  assert.equal(status.stage_ledger.find((row) => row.stage === "audio_pace_check").exists, true);
  assert.equal(status.stage_ledger.find((row) => row.stage === "sfx_score_plan").exists, true);

  await writeJson(wordTimingPath, { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash, word_count: 4, audio_duration_sec: 0.84 });
  const staleStatusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const staleStatus = JSON.parse(staleStatusResult.stdout);
  const staleAudioPace = staleStatus.stage_ledger.find((row) => row.stage === "audio_pace_check");
  assert.equal(staleStatus.current_stage, "audio_pace_check");
  assert.equal(staleAudioPace.exists, false);
  assert.match(staleAudioPace.evidence, /narration_word_timing_ep_01\.json stale/);
  await writeJson(wordTimingPath, { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash, word_count: 3, audio_duration_sec: 0.84 });

  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "blocked", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220, actual_wpm: 167.54 });
  const blockedStatusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const blockedStatus = JSON.parse(blockedStatusResult.stdout);
  assert.equal(blockedStatus.current_stage, "audio_pace_check");
  assert.match(blockedStatus.next_command_shape, /tts qwen/);
  assert.match(blockedStatus.next_command_shape, /--native-speed/);
  assert.doesNotMatch(blockedStatus.next_command_shape, /audio tempo-normalize/);
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220, actual_wpm: 214.286 });

  await execFileAsync(process.execPath, [
    "scripts/modelslab-longform-audio-bed.mjs",
    "start",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--episodeDir", episodeDir,
    "--qwenReport", path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"),
    "--outputBase", "fixture-narrator-only",
    "--reportSuffix", "-fixture",
    "--narration-only", "true",
    "--narration-volume-db", "1",
    "--target-lufs", "-16",
    "--true-peak-db", "-1",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "longform_audio_bed_report_ep_01-fixture.json"), "utf8"));
  assert.equal(report.status, "completed");
  assert.equal(report.audio_design_enabled, false);
  assert.equal(report.skip_sfx, true);
  assert.equal(report.transition_sfx_enabled, false);
  assert.equal(await fs.stat(report.mix.m4a_path).then((stat) => stat.isFile()), true);
  assert.equal(report.mix.wav_path, null);
  assert.equal(report.mix.intermediate_wav_deleted, true);
  assert.equal(await fs.stat(report.mix.intermediate_wav_path).then(() => true).catch(() => false), false);
}

async function testRunCleanupPrunesNarratorOnlyLongformWav() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const mixDir = path.join(episodeDir, "assets", "audio", "longform_mix");
  await fs.mkdir(mixDir, { recursive: true });
  const wavPath = path.join(mixDir, "fixture-narrator-only.wav");
  const m4aPath = path.join(mixDir, "fixture-narrator-only.m4a");
  await fs.writeFile(wavPath, Buffer.alloc(2048));
  await fs.writeFile(m4aPath, Buffer.alloc(1024));
  const legacyFishPath = path.join(episodeDir, "narration_fish_performance_ep_01.txt");
  const legacyFishReportPath = path.join(episodeDir, "fish_reference_requirements_report.json");
  await fs.writeFile(legacyFishPath, "legacy fish narration text", "utf8");
  await writeJson(legacyFishReportPath, { status: "passed", tts_provider: "qwen3-tts" });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", provider: "qwen3-tts", segments: [{ segment_id: "seg_001" }] });
  await writeJson(path.join(episodeDir, "voice_reference_completeness_report.json"), { status: "passed", tts_provider: "qwen3-tts" });
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), {
    status: "completed",
    audio_design_enabled: false,
    narration_only: true,
    mix: {
      audio_design_enabled: false,
      narration_only: true,
      wav_path: wavPath,
      m4a_path: m4aPath,
    },
  });
  const dryRun = await execFileAsync(process.execPath, [
    "scripts/run-cleanup.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const dryPayload = JSON.parse(dryRun.stdout);
  assert.equal(dryPayload.candidate_count, 3);
  assert.equal(await fs.stat(wavPath).then((stat) => stat.isFile()), true);
  assert.equal(await fs.stat(legacyFishPath).then((stat) => stat.isFile()), true);
  await execFileAsync(process.execPath, [
    "scripts/run-cleanup.mjs",
    "--episode-dir", episodeDir,
    "--apply", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), "utf8"));
  assert.equal(report.mix.wav_path, null);
  assert.equal(report.mix.intermediate_wav_deleted, true);
  assert.equal(await fs.stat(wavPath).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(m4aPath).then((stat) => stat.isFile()), true);
  assert.equal(await fs.stat(legacyFishPath).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(legacyFishReportPath).then(() => true).catch(() => false), false);
}

async function testRunStatusBlocksLegacyScriptPaceHookWarnings() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture script with a slow hook marker.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    target_wpm_min: 195,
    target_wpm_max: 220,
    hook_milestone_report: {
      warnings: [{ code: "late_hidden_power_spark", severity: "warning" }],
    },
  });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const stage = status.stage_ledger.find((row) => row.stage === "script_pace_check");
  assert.equal(status.current_stage, "script_pace_check");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /hook_warnings=1/);
}

async function testRunStatusBlocksMissingQwenStitchedAudio() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture script for missing stitched audio.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash, replacements: [] });
  const semanticPath = path.join(episodeDir, "semantic_scene_plan.json");
  const semanticArtifact = { status: "passed", source_script_hash: scriptHash };
  await writeJson(semanticPath, semanticArtifact);
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash });
  const missingAudioPath = path.join(episodeDir, "assets", "audio", "missing.wav");
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), { status: "passed", source_script_hash: scriptHash, output_path: missingAudioPath });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const stage = status.stage_ledger.find((row) => row.stage === "qwen_tts_stitch");
  assert.equal(status.current_stage, "qwen_tts_stitch");
  assert.equal(stage.exists, false);
  assert.match(stage.evidence, /stitched narration missing/);
}

async function testTimingBindMatchesPossessiveAnchorsAfterCursor() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = [
    "Earlier, he thought of his mother's piano and kept walking.",
    "",
    "But emotional payoff still waited in one place.",
    "",
    "His mother's piano.",
    "",
    "Joey almost laughed.",
    "",
    "He bought the lounge contract.",
  ].join("\n");
  const scriptHash = sha256(scriptText);
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    scenes: [
      {
        scene_id: "scene_001",
        title: "Earlier Memory",
        script_excerpt_start: "Earlier, he thought of his mother's piano and kept walking.",
        script_excerpt_end: "But emotional payoff still waited in one place.",
      },
      {
        scene_id: "scene_002",
        title: "Later Possessive Anchor",
        script_excerpt_start: "His mother's piano.",
        script_excerpt_end: "Joey almost laughed.",
      },
      {
        scene_id: "scene_003",
        title: "Next Scene",
        script_excerpt_start: "He bought the lounge contract.",
        script_excerpt_end: "He bought the lounge contract.",
      },
    ],
  });
  const narrationPath = path.join(episodeDir, "narration.m4a");
  await fs.writeFile(narrationPath, "fixture audio bytes");
  const narrationHash = sha256(await fs.readFile(narrationPath));
  const word = (text, start, end) => ({ word: text, start_sec: start, end_sec: end });
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    narration_audio_hash: narrationHash,
    audio_duration_sec: 27,
    words: [
      word("Earlier", 0, 0.2), word("he", 0.2, 0.4), word("thought", 0.4, 0.6), word("of", 0.6, 0.8),
      word("his", 0.8, 1), word("mother's", 1, 1.2), word("piano", 1.2, 1.4), word("and", 1.4, 1.6),
      word("kept", 1.6, 1.8), word("walking", 1.8, 2),
      word("But", 4, 4.2), word("emotional", 4.2, 4.4), word("payoff", 4.4, 4.6),
      word("still", 4.6, 4.8), word("waited", 4.8, 5), word("in", 5, 5.2),
      word("one", 5.2, 5.4), word("place", 5.4, 5.6),
      word("His", 12, 12.2), word("mother's", 12.2, 12.4), word("piano", 12.4, 12.6),
      word("Joey", 14, 14.2), word("almost", 14.2, 14.4), word("laughed", 14.4, 14.6),
      word("He", 15, 15.2), word("bought", 15.2, 15.4), word("the", 15.4, 15.6),
      word("lounge", 15.6, 15.8), word("contract", 15.8, 16),
    ],
  });
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), {
    status: "passed",
    output_path: narrationPath,
  });
  await execFileAsync(process.execPath, [
    "scripts/timing-bind.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--max-scene-duration-sec", "10",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const timed = JSON.parse(await fs.readFile(path.join(episodeDir, "timed_scene_plan.json"), "utf8"));
  const scene = timed.scenes.find((item) => item.scene_id === "scene_002");
  assert.equal(scene.start_resolution, "whisper_phrase_match");
  assert.equal(scene.matched_start_words, "His mother's piano");
  assert.equal(scene.start_sec, 12);
  assert.equal(scene.duration_sec < 10, true);
}

async function testRunStatusBlocksStaleVisualBeatSourceHashes() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture narration for stale visual beats.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash });
  const semanticPath = path.join(episodeDir, "semantic_scene_plan.json");
  const semanticArtifact = { status: "passed", source_script_hash: scriptHash };
  await writeJson(semanticPath, semanticArtifact);
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed" });
  const narrationPath = path.join(episodeDir, "narration.wav");
  await fs.writeFile(narrationPath, "fixture audio bytes");
  const narrationHash = sha256(await fs.readFile(narrationPath));
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), { status: "passed", output_path: narrationPath });
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash });
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220, actual_wpm: 214.286 });
  const mixPath = path.join(episodeDir, "longform_mix.m4a");
  await fs.writeFile(mixPath, "fixture mix bytes");
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), { status: "completed", mix: { m4a_path: mixPath } });
  const timedPath = path.join(episodeDir, "timed_scene_plan.json");
  await writeJson(timedPath, {
    status: "passed",
    source_script_hash: scriptHash,
    source_hashes: { [semanticPath]: sha256(await fs.readFile(semanticPath)) },
    scenes: [],
  });
  const scriptPath = path.join(episodeDir, "script_clean.md");
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    source_hashes: {
      [timedPath]: sha256(await fs.readFile(timedPath)),
      [scriptPath]: sha256(await fs.readFile(scriptPath)),
    },
    beats: [],
  });
  let statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  let status = JSON.parse(statusResult.stdout);
  let visualBeatStage = status.stage_ledger.find((row) => row.stage === "visual_beat_plan");
  assert.equal(status.current_stage, "visual_beat_plan");
  assert.equal(visualBeatStage.exists, false);
  assert.match(visualBeatStage.evidence, /stale planner_contract_version=missing/);

  await writeJson(semanticPath, { ...semanticArtifact, scenes: [{ scene_id: "scene_changed" }] });
  statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  status = JSON.parse(statusResult.stdout);
  const timingStage = status.stage_ledger.find((row) => row.stage === "timing_bind");
  assert.equal(status.current_stage, "timing_bind");
  assert.equal(timingStage.state, "stale");
  assert.match(timingStage.evidence, /semantic_scene_plan\.json stale/);
  await writeJson(semanticPath, semanticArtifact);

  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: scriptHash,
    source_hashes: {
      [timedPath]: sha256(await fs.readFile(timedPath)),
      [scriptPath]: sha256(await fs.readFile(scriptPath)),
    },
    beats: [],
  });
  await writeJson(timedPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001" }] });
  statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  status = JSON.parse(statusResult.stdout);
  visualBeatStage = status.stage_ledger.find((row) => row.stage === "visual_beat_plan");
  assert.equal(status.current_stage, "visual_beat_plan");
  assert.equal(visualBeatStage.exists, false);
  assert.match(visualBeatStage.evidence, /timed_scene_plan\.json stale/);
}

async function testRunStatusBlocksStaleVisualReferenceSourceHashes() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture narration for stale visual references.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash });
  const semanticPath = path.join(episodeDir, "semantic_scene_plan.json");
  await writeJson(semanticPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001", location: "hall" }] });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed" });
  const narrationPath = path.join(episodeDir, "narration.wav");
  await fs.writeFile(narrationPath, "fixture audio bytes");
  const narrationHash = sha256(await fs.readFile(narrationPath));
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), { status: "passed", output_path: narrationPath });
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash });
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220, actual_wpm: 214.286 });
  const timedPath = path.join(episodeDir, "timed_scene_plan.json");
  await writeJson(timedPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001" }] });
  const mixPath = path.join(episodeDir, "longform_mix.m4a");
  await fs.writeFile(mixPath, "fixture mix bytes");
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), { status: "completed", mix: { m4a_path: mixPath } });
  const scriptPath = path.join(episodeDir, "script_clean.md");
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: scriptHash,
    source_hashes: {
      [timedPath]: sha256(await fs.readFile(timedPath)),
      [scriptPath]: sha256(await fs.readFile(scriptPath)),
    },
    beats: [{ visual_beat_id: "scene_001_beat_01", scene_id: "scene_001", ref_needs: [] }],
  });
  const visualRefPath = path.join(episodeDir, "visual_reference_plan.json");
  const referenceInventoryPath = await writeFixtureReferenceInventory(episodeDir, scriptHash, [
    { asset_id: "style_ref", ref_id: "style_ref", kind: "style", subject: "fixture style", scene_ids: [], beat_ids: [] },
  ]);
  await writeJson(visualRefPath, {
    status: "passed",
    source_script_hash: scriptHash,
    reference_inventory_ledger_path: referenceInventoryPath,
    source_hashes: {
      [semanticPath]: sha256(await fs.readFile(semanticPath)),
    },
    reference_targets: [{ ref_id: "style_ref", kind: "style", generation_mode: "standalone_ref", required_before_imagegen: true }],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    status: "draft_needs_manual_review",
    source_script_hash: scriptHash,
    source_visual_reference_plan_path: visualRefPath,
    source_hashes: {
      [visualRefPath]: sha256(await fs.readFile(visualRefPath)),
    },
    character_state_refs: [],
  });
  await writeJson(semanticPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001", location: "changed hall" }] });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const refStage = status.stage_ledger.find((row) => row.stage === "visual_reference_plan");
  assert.equal(status.current_stage, "visual_reference_plan");
  assert.equal(refStage.exists, false);
  assert.match(refStage.evidence, /semantic_scene_plan\.json stale/);
}

async function testRunStatusSurfacesDraftReferenceApprovalCommand() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "Fixture narration for draft visual reference approval.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash });
  const semanticPath = path.join(episodeDir, "semantic_scene_plan.json");
  await writeJson(semanticPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001", location: "hall" }] });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed" });
  const narrationPath = path.join(episodeDir, "narration.wav");
  await fs.writeFile(narrationPath, "fixture audio bytes");
  const narrationHash = sha256(await fs.readFile(narrationPath));
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), { status: "passed", output_path: narrationPath });
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash });
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220, actual_wpm: 214.286 });
  const timedPath = path.join(episodeDir, "timed_scene_plan.json");
  await writeJson(timedPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001" }] });
  const mixPath = path.join(episodeDir, "longform_mix.m4a");
  await fs.writeFile(mixPath, "fixture mix bytes");
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), { status: "completed", mix: { m4a_path: mixPath } });
  const scriptPath = path.join(episodeDir, "script_clean.md");
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    planner_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
    source_script_hash: scriptHash,
    source_hashes: {
      [timedPath]: sha256(await fs.readFile(timedPath)),
      [scriptPath]: sha256(await fs.readFile(scriptPath)),
    },
    beats: [{ visual_beat_id: "scene_001_beat_01", scene_id: "scene_001", ref_needs: [] }],
  });
  const visualRefPath = path.join(episodeDir, "visual_reference_plan.json");
  const referenceInventoryPath = await writeFixtureReferenceInventory(episodeDir, scriptHash, [
    { asset_id: "style_ref", ref_id: "style_ref", kind: "style", subject: "fixture style", scene_ids: [], beat_ids: [] },
  ]);
  await writeJson(visualRefPath, {
    status: "passed",
    source_script_hash: scriptHash,
    reference_inventory_ledger_path: referenceInventoryPath,
    source_hashes: {
      [semanticPath]: sha256(await fs.readFile(semanticPath)),
    },
    reference_targets: [
      { ref_id: "style_ref", kind: "style", generation_mode: "no_ref_needed", required_before_imagegen: false },
      { ref_id: "optional_action_review", kind: "action", generation_mode: "manual_review", required_before_imagegen: false },
    ],
    character_state_refs: [],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    status: "draft_needs_manual_review",
    source_script_hash: scriptHash,
    source_visual_reference_plan_path: visualRefPath,
    source_hashes: {
      [visualRefPath]: sha256(await fs.readFile(visualRefPath)),
    },
    character_state_refs: [],
  });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const refStage = status.stage_ledger.find((row) => row.stage === "visual_reference_plan");
  const referenceGenerationStage = status.stage_ledger.find((row) => row.stage === "reference_generation");
  const referenceApprovalStage = status.stage_ledger.find((row) => row.stage === "reference_image_approval");
  assert.equal(status.current_stage, "reference_image_approval");
  assert.equal(refStage.exists, true);
  assert.equal(referenceGenerationStage.exists, true);
  assert.equal(referenceApprovalStage.exists, false);
  assert.match(referenceApprovalStage.evidence, /generated reference approval missing/);
  assert.match(status.next_command_shape, /visual approve-refs/);
  assert.match(referenceApprovalStage.next_command_shape, /visual approve-refs/);
}

async function testRunStatusBlocksQwenPlanMissingOverrideAudit() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const scriptText = "The clip became live content.";
  const scriptHash = sha256(Buffer.from(scriptText));
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  await writeJson(path.join(episodeDir, "run_identity.json"), { channel: "test", series_slug: "series", week: "run", episode: "ep_01", audio_target: "narrator_only", image_provider: "modelslab" });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), { status: "passed" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { operator_approved: true, script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_lock.json"), { script_clean_hash: scriptHash });
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 195, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    replacements: [{ from: "live content", to: "livestream video content", scope: "qwen_spoken_text" }],
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    segments: [{ segment_id: "seg_001", qwen_generation_units: [{ qwen_spoken_text: "The clip became live content." }] }],
  });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const voiceStage = status.stage_ledger.find((row) => row.stage === "voice_plan");
  assert.equal(status.current_stage, "voice_plan");
  assert.equal(voiceStage.exists, false);
  assert.match(voiceStage.evidence, /missing tts_override_application_audit/);
}

async function testRunStatusIgnoresProofImageReportWithoutCurrentHardenedPlan() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    audio_target: "narrator_only",
    image_provider: "modelslab",
  });
  await writeJson(path.join(episodeDir, "imagegen_report_first5_current_modelslab.json"), {
    schema: "goldflow_imagegen_report_v1",
    status: "passed",
    reference_only: false,
    missing_image_count: 0,
    image_count: 5,
    prompt_plan_hash: "old-proof-hash",
    results: [],
  });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.equal(imageStage.exists, false);
  assert.match(imageStage.evidence, /section_image_prompts_hardened\.json missing or empty/);
}

async function testRunStatusIncludesManualBlockerTriagePolicy() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    audio_target: "narrator_only",
    image_provider: "modelslab",
  });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  assert.equal(status.manual_blocker_triage_policy.mode, "agent_review_first");
  assert.match(status.manual_blocker_triage_policy.summary, /narrowest valid recovery/);
  assert.match(status.manual_blocker_triage_policy.artifact_pattern, /manual_blocker_triage/);

  const { stdout: markdown } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
    "--format", "markdown",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  assert.match(markdown, /Manual blocker triage:/);
  assert.match(markdown, /narrowest valid recovery/);
}

function testDerivedReferenceCandidateSelectionAndManifestAttach() {
  const promptPlan = {
    prompt_policy: "deterministic hardening",
    prompts: [
      {
        image_id: "ep_01-cut-000",
        scene_id: "scene_001",
        start_sec: 10,
        visual_job: "location_transition",
        suggested_shot_job: "environment_establishing",
        image_prompt: "empty anime manhwa audit hall environment establishing frame with no characters",
        modelslab_image_prompt: "empty anime manhwa audit hall environment establishing frame with no characters",
        shot_manifest: {
          shot_job: "environment_establishing",
          location_ref_id: "loc_audit_hall",
        },
        reference_requirements: [],
      },
      {
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        start_sec: 12,
        visual_job: "humiliation_image",
        suggested_shot_job: "character_interaction",
        image_prompt: "Joey and Selena arguing inside the audit hall",
        modelslab_image_prompt: "Joey and Selena arguing inside the audit hall",
        shot_manifest: {
          location_ref_id: "loc_audit_hall",
          protagonist_state_ref_id: "joey_floor_state",
          character_state_ref_ids: ["selena_phone_state"],
          visible_characters: ["Joey Manhwa", "Selena"],
          visible_props: ["phone"],
        },
        reference_requirements: [],
      },
      {
        image_id: "ep_01-cut-002",
        scene_id: "scene_002",
        start_sec: 18,
        shot_manifest: { location_ref_id: "loc_dorm" },
        reference_requirements: [],
      },
    ],
  };
  const target = { ref_id: "loc_audit_hall", kind: "location", generation_mode: "derive_from_first_clean_cut", scene_ids: ["scene_001"] };
  assert.deepEqual(candidateImageIdsForDerivedTargetForTests(target, promptPlan), ["ep_01-cut-000"]);
  assert.deepEqual(
    candidateImageIdsForDerivedTargetForTests(target, { ...promptPlan, prompts: promptPlan.prompts.filter((prompt) => prompt.image_id !== "ep_01-cut-000") }),
    [],
    "derived location refs must not promote contaminated character/prop cuts as location anchors"
  );

  const attached = attachReferencePathsToPromptsForTests(
    promptPlan,
    new Map([
      ["loc_audit_hall", "/tmp/loc_audit_hall.png"],
      ["joey_base_ref", "/tmp/joey.png"],
      ["selena_base_ref", "/tmp/selena.png"],
    ]),
    [
      { state_ref_id: "joey_floor_state", source_ref_id: "joey_base_ref", character: "Joey Manhwa" },
      { state_ref_id: "selena_phone_state", source_ref_id: "selena_base_ref", character: "Selena" },
    ],
    [target]
  );
  const firstPrompt = attached.prompts.find((prompt) => prompt.image_id === "ep_01-cut-001");
  assert.deepEqual(new Set(firstPrompt.required_reference_paths), new Set(["/tmp/loc_audit_hall.png", "/tmp/joey.png", "/tmp/selena.png"]));
  assert.equal(firstPrompt.reference_requirements.every((requirement) => requirement.inferred_from_shot_manifest === true), true);
  assert.deepEqual(new Set(firstPrompt.reference_requirements.map((requirement) => requirement.ref_id)), new Set(["loc_audit_hall", "joey_base_ref", "selena_base_ref"]));
}

async function testDerivedReferencePromotionFromSeedCut() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const imageDir = path.join(episodeDir, "assets", "images");
  const imagePath = path.join(imageDir, "ep_01-cut-001-modelslab-image.png");
  await fs.mkdir(imageDir, { recursive: true });
  await fs.writeFile(imagePath, Buffer.from("fixture image bytes"));
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    image_provider: "modelslab",
  });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    reference_targets: [
      {
        ref_id: "loc_audit_hall",
        kind: "location",
        generation_mode: "derive_from_first_clean_cut",
        scene_ids: ["scene_001"],
      },
    ],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    status: "approved",
    character_state_refs: [],
  });
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await writeJson(promptPath, {
    status: "passed",
    prompt_policy: "deterministic hardening",
    prompts: [
      {
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        start_sec: 3,
        image_prompt: "anime manhwa audit hall",
        modelslab_image_prompt: "anime manhwa audit hall",
        shot_manifest: { location_ref_id: "loc_audit_hall" },
        reference_requirements: [],
      },
    ],
  });
  await writeJson(path.join(episodeDir, "imagegen_report_ep_01.json"), {
    schema: "goldflow_imagegen_report_v1",
    status: "passed",
    prompt_plan_hash: sha256(await fs.readFile(promptPath)),
    image_count: 1,
    expected_image_count: 1,
    missing_image_count: 0,
    results: [
      { image_id: "ep_01-cut-001", status: "generated", image_path: imagePath },
    ],
  });

  await execFileAsync(process.execPath, [
    "scripts/imagegen.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--prompts", promptPath,
    "--promote-derived-refs", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });

  const referencePlan = await readJson(path.join(episodeDir, "visual_reference_plan.json"));
  const updatedTarget = referencePlan.reference_targets[0];
  assert.equal(updatedTarget.derived_reference_status, "promoted");
  assert.equal(updatedTarget.derived_from_image_id, "ep_01-cut-001");
  assert.equal(await fs.stat(updatedTarget.reference_image_path).then((stat) => stat.isFile()), true);
  const promotionReport = await readJson(path.join(episodeDir, "derived_reference_promotion_report_ep_01.json"));
  assert.equal(promotionReport.promoted_count, 1);
  assert.equal(promotionReport.unresolved_count, 0);
}

async function testImagegenReusesImportedCodexOpeningCut() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const imageDir = path.join(episodeDir, "assets", "images");
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    image_provider: "hybrid_modelslab_refs_codex_opening_modelslab_rest",
    image_provider_options: { codex_opening_sec: 300 },
    audio_target: "narrator_only",
    run_intent: "production",
  });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    reference_targets: [],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    status: "approved",
    character_state_refs: [],
  });
  await writeJson(promptPath, {
    status: "passed",
    prompt_policy: "deterministic hardening fixture",
    prompts: [
      {
        image_id: "ep_01-cut-001",
        scene_id: "scene_001",
        start_sec: 0,
        image_prompt: "Joey stands under a blue system window.",
        codex_image_prompt: "anime manhwa frame of Joey under a blue system window",
        image_generation_required: true,
      },
    ],
  });
  const imagePath = path.join(imageDir, "ep_01-cut-001-codex-imagegen-image.png");
  await fs.mkdir(imageDir, { recursive: true });
  await fs.writeFile(imagePath, Buffer.from("fixture imported codex image"));
  await writeJson(`${imagePath}.metadata.json`, {
    image_id: "ep_01-cut-001",
    image_provider: "codex_imagegen_manual_import",
    source_prompt_path: promptPath,
    generated: {
      output_sha256: sha256("fixture imported codex image"),
      manual_source_sha256: sha256("fixture imported codex image"),
    },
  });

  const result = await execFileAsync(process.execPath, [
    "scripts/imagegen.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--image-provider", "hybrid_modelslab_refs_codex_opening_modelslab_rest",
    "--codex-opening-sec", "300",
    "--prompts", promptPath,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const stdout = JSON.parse(result.stdout);
  assert.equal(stdout.status, "passed");
  const report = await readJson(path.join(episodeDir, "imagegen_report_ep_01.json"));
  assert.equal(report.status, "passed");
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].status, "reused_imported_codex");
  assert.equal(report.results[0].image_path, imagePath);
}

async function testRunStatusDerivedReferenceSeedPromoteAndScopedRetry() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await fs.mkdir(path.join(episodeDir, "assets", "images"), { recursive: true });
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "test",
    series_slug: "series",
    week: "run",
    episode: "ep_01",
    audio_target: "narrator_only",
    image_provider: "modelslab",
  });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    reference_targets: [
      { ref_id: "loc_audit_hall", kind: "location", generation_mode: "derive_from_first_clean_cut", scene_ids: ["scene_001"] },
    ],
  });
  await writeJson(promptPath, {
    status: "passed",
    prompt_policy: "deterministic hardening",
    prompts: [
      { image_id: "ep_01-cut-001", scene_id: "scene_001", start_sec: 1, image_prompt: "anime manhwa audit hall", shot_manifest: { location_ref_id: "loc_audit_hall" }, reference_requirements: [] },
      { image_id: "ep_01-cut-002", scene_id: "scene_002", start_sec: 7, image_prompt: "anime manhwa dorm room", shot_manifest: { location_ref_id: "loc_dorm" }, reference_requirements: [] },
    ],
  });
  const promptPlanHash = sha256(await fs.readFile(promptPath));
  let statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  let status = JSON.parse(statusResult.stdout);
  let referenceStage = status.stage_ledger.find((row) => row.stage === "reference_generation");
  let imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.equal(referenceStage.exists, true);
  assert.match(referenceStage.evidence, /no standalone reference images required/);
  assert.match(imageStage.next_command_shape, /--skip-reference-generation true/);
  assert.match(imageStage.next_command_shape, /--seed-derived-refs true/);
  assert.match(imageStage.next_command_shape, /--cut-ids ep_01-cut-001/);

  const generatedPath = path.join(episodeDir, "assets", "images", "ep_01-cut-001-modelslab-image.png");
  await fs.writeFile(generatedPath, Buffer.from("seed cut bytes"));
  await writeJson(path.join(episodeDir, "imagegen_report_ep_01.json"), {
    schema: "goldflow_imagegen_report_v1",
    status: "passed",
    prompt_plan_hash: promptPlanHash,
    image_count: 1,
    expected_image_count: 2,
    missing_image_count: 1,
    results: [
      { image_id: "ep_01-cut-001", status: "generated", image_path: generatedPath },
    ],
  });
  statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  status = JSON.parse(statusResult.stdout);
  imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.match(imageStage.next_command_shape, /imagegen promote-derived-refs/);

  const promotedReferencePath = path.join(episodeDir, "assets", "images", "references", "loc_audit_hall-derived-reference.png");
  await fs.mkdir(path.dirname(promotedReferencePath), { recursive: true });
  await fs.writeFile(promotedReferencePath, Buffer.from("promoted ref bytes"));
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    reference_targets: [
      {
        ref_id: "loc_audit_hall",
        kind: "location",
        generation_mode: "derive_from_first_clean_cut",
        scene_ids: ["scene_001"],
        reference_image_path: promotedReferencePath,
      },
    ],
  });
  await writeJson(path.join(episodeDir, "imagegen_report_ep_01.json"), {
    schema: "goldflow_imagegen_report_v1",
    status: "failed",
    prompt_plan_hash: promptPlanHash,
    image_count: 1,
    expected_image_count: 2,
    missing_image_count: 1,
    results: [
      { image_id: "ep_01-cut-001", status: "generated", image_path: generatedPath },
      { image_id: "ep_01-cut-002", status: "failed", error: "fixture failure" },
    ],
  });
  statusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  status = JSON.parse(statusResult.stdout);
  imageStage = status.stage_ledger.find((row) => row.stage === "image_generation");
  assert.match(imageStage.next_command_shape, /--skip-reference-generation true/);
  assert.match(imageStage.next_command_shape, /--cut-ids ep_01-cut-002/);
  assert.doesNotMatch(imageStage.next_command_shape, /visual plan/);
}

async function testSilentTransitionsWithoutSfxBank() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const promptPath = path.join(episodeDir, "section_image_prompts_hardened.json");
  await writeJson(promptPath, {
    status: "passed",
    prompts: [
      { image_id: "ep_01-cut-001", scene_id: "scene_001", start_sec: 0, visual_beat_action: "cold open begins" },
      { image_id: "ep_01-cut-002", scene_id: "scene_001", start_sec: 2, visual_beat_action: "system reveal lands" },
    ],
  });
  const output = path.join(episodeDir, "transition_edit_plan_ep_01.json");
  await execFileAsync(process.execPath, [
    "scripts/visual-transition-plan.mjs",
    "--channel", "test",
    "--series", "series",
    "--week", "run",
    "--episode", "ep_01",
    "--prompts", promptPath,
    "--output", output,
    "--transition-sfx", "false",
    "--dry-run", "true",
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const report = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.transition_sfx_enabled, false);
  assert.equal(report.sfx_manifest_path, null);
  assert.equal(report.transition_events.every((event) => event.transition_sfx === false), true);
}

async function testGlobalStylePromptDoesNotInjectCrowdExtras() {
  const files = [
    "scripts/imagegen.mjs",
    "scripts/visual-plan.mjs",
    "scripts/visual-prompt-review.mjs",
    "AGENTS.md",
    "docs/workflows/video_production_workflow.md",
  ];
  for (const filePath of files) {
    const text = await fs.readFile(path.join(process.cwd(), filePath), "utf8");
    assert.equal(/crowd extras/i.test(text), false, `${filePath} must not globally request crowd extras`);
  }
}

const FIXTURE_SUITES = {
  "stage-contract": [
    testAuthoritativeStageRegistry,
    testRunIdentityV2Policies,
    testFinalQaSourceHashFreshness,
    testRunStatusRejectsFalseGreenFinalQa,
    testAppendOnlyExecutionProvenance,
    testCumulativeImagegenHistoryAndEpisodeTruth,
    testPinnedCodexRuntimeContracts,
    testNestedCodexCallsUseSharedRunner,
    testPreflightLocksNativeTtsSpeedAndSmoothRender,
    testPostTempoRequiresEmergencyApproval,
    testHybridImageProviderRouting,
    testHybridOpeningWindowPersistsInRunIdentity,
    testRunStatusResumesBlockedVisualReviewWithoutFullReplan,
    testRunStatusBlocksLegacyScriptPaceHookWarnings,
    testRunStatusBlocksMissingQwenStitchedAudio,
    testRunStatusBlocksStaleVisualBeatSourceHashes,
    testRunStatusBlocksStaleVisualReferenceSourceHashes,
    testRunStatusSurfacesDraftReferenceApprovalCommand,
    testRunStatusBlocksQwenPlanMissingOverrideAudit,
    testRunStatusIgnoresProofImageReportWithoutCurrentHardenedPlan,
    testRunStatusIncludesManualBlockerTriagePolicy,
    testRunStatusDerivedReferenceSeedPromoteAndScopedRetry,
  ],
  planner: [
    testSemanticSceneAnchorValidation,
    testSemanticSceneQualityFindings,
    testSemanticPlannerPromptContracts,
    testSemanticChunkingSplitsLongSingleParagraph,
    testBoundedProofBaselineScoping,
    testSemanticReconciliationEvidenceContract,
    testEditorialBeatDirectorContracts,
    testEditorialBeatTimelineClosure,
    testSemanticAnchorSnapsToExactScriptTokens,
    testFirstPersonBeatKeepsProtagonistVisible,
    testWhisperExcerptAlignmentInterpolatesUnspokenUi,
    testLocationSceneIdsDerivation,
    testReferenceDirectorV2EvidenceAndLocationContracts,
    testReferenceDirectorV2RejectsDeterministicExpansionAndDerivedCuts,
    testReferencePlanHashApproval,
    testActiveStateValidationSkipsTextOnlyUiMentions,
    testAdaptiveProviderPromptPackets,
    testSelectedReferenceInventoryContainsOnlyDirectorSelections,
    testReferenceDirectorV2BlocksDanglingAndGroupCharacterStates,
    testLocationCandidateExclusion,
    testStarvationGate,
    testBroadLocationTargetDoesNotSatisfySemanticLocationRequirement,
    testOutOfScopeRefDropping,
    testReferenceLimitOmissionIsNotForbidden,
    testOutOfScopeLocationMentionAssertion,
    testProviderAwarePromptSelection,
    testSceneImageProductionContractBlocksDroppedRefsAndStyle,
    testGroupReferencePromptDoesNotDemandOnePerson,
    testConciseReferenceRoleContract,
    testLocalBeatFidelityEditorialCases,
    testVisualPlannerDriftContracts,
    testPromptPayloadMarkerSanitizerPreservesNormalNegation,
    testCharacterStagingSanitizerAndReviewBlockers,
    testVisualBeatDensityDefaults,
    testVisualBeatQualityFindings,
    testCrossGenreVisualBeatFixtures,
    testLongLocationSpanCrossingRetentionBoundary,
    testRepeatedRetentionShotJobRunFindings,
    testVisualPlanBlocksOverbroadLocationRefCoverageBeforeLlm,
    testVisualPlanAllowsSameLocationLabelAliases,
    testOnlyScenesDryRun,
    testOnlyCutIdsDryRun,
    testNamedCharacterDuplicationAllowsReflections,
    testVisualResolveScopePrefersCutIds,
    testHardenFeedbackBlockersMapToReviewResolveInput,
    testPassedReviewClearsDeadletterPayload,
    testVisualHardenAllowsStoryFaithfulNegativeWordsWithoutRewrite,
    testVisualHardenStripsNonAttachableScopedRefs,
    testVisualHardenRetainsPendingDerivedRequirementWithoutSlot,
    testVisualHardenAcceptsInventoryOnlyLocationContract,
    testVisualHardenLeavesCleanPromptByteIdenticalAndNormalizesRefs,
    testVisualHardenCanonicalizesStateRefRequirements,
    testVisualHardenBlocksVisibleCharacterWhenScopedRefOmitted,
    testVisualHardenBlocksVisibleCharacterWhenOnlyOutOfScopeRefExists,
    testVisualHardenBlocksAttachedCharacterRefWhenAnchorIgnored,
    testVisualHardenAllowsAttachedCharacterRefWhenAnchorReaffirmed,
    testVisualHardenPreservesAttachableFaceOnlyStateRef,
    testVisualHardenBlocksMissingManifestLocationWithoutAddingIt,
    testVisualHardenBlocksMissingPendingDerivedLocationContract,
    testVisualHardenV2AcceptsTextLocationContractWithoutImageRef,
    testVisualHardenV2BlocksUnknownLocationContract,
    testVisualHardenManualTriageCanDisregardSpecificBlocker,
    testVisualHardenPreservesCrowdedCharacterRefsOverOmittedLocation,
    testGlobalStylePromptDoesNotInjectCrowdExtras,
  ],
  media: [
    testPhraseAwareSubtitleGrouping,
    testQwenKeepsBracketedUiDialogueSpeakable,
    testEpisodeLocalAmbienceSpecContract,
    testImageOutputQaRiskAndDonorPolicies,
    testProviderCircuitBreakerStopsUnclaimedWork,
    testProviderConcurrencyBacksOffAndRecovers,
    testDirectedMotionAndFullTimelineTransitions,
    testRenderRequiresHashMatchedImageQa,
    testGptImage2PreservesFullPromptAndUsesLandscapeDefault,
    testVoiceDirectionCharacterization,
    testQwenPlanAuditsAppliedTtsOverrides,
    testQwenPlanSpeaksStandaloneSystemUiWithoutBrackets,
    testNarrationPaceChecks,
    testScriptPaceDoesNotUseBuiltInEpisodeHookPhrases,
    testTargetedSpeakabilityLiveContentHomograph,
    testImagegenDeadletterRefusal,
    testNarratorOnlyStatusAndMixer,
    testRunCleanupPrunesNarratorOnlyLongformWav,
    testTimingBindMatchesPossessiveAnchorsAfterCursor,
    testDerivedReferenceCandidateSelectionAndManifestAttach,
    testDerivedReferencePromotionFromSeedCut,
    testImagegenReusesImportedCodexOpeningCut,
    testSilentTransitionsWithoutSfxBank,
  ],
  integration: [],
};

export async function runFixtureSuite(name = "all") {
  const selected = name === "all" ? Object.entries(FIXTURE_SUITES) : [[name, FIXTURE_SUITES[name]]];
  if (selected.some(([, tests]) => !tests)) throw new Error(`Unknown fixture suite ${name}. Expected: ${Object.keys(FIXTURE_SUITES).join(", ")}, all.`);
  for (const [suiteName, tests] of selected) {
    for (const test of tests) await test();
    console.log(`goldflow ${suiteName} fixture suite passed (${tests.length} tests)`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const suiteIndex = process.argv.indexOf("--suite");
  await runFixtureSuite(suiteIndex >= 0 ? process.argv[suiteIndex + 1] : "all");
}
