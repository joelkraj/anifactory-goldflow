#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  allowedRefIdsForScene,
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
import { sanitizePositiveVisualPrompt } from "./lib/positive-prompt-sanitize.mjs";
import { localBeatFidelityFindingsForTests } from "./visual-plan.mjs";
import { qwenGenerationPlanForTests, voiceDirectionTransformForTests } from "./voice-direction-gate.mjs";
import { longLocationSpanFindings, repeatedLocationShotJobFindings } from "./lib/visual-plan-quality-utils.mjs";
import {
  compatibleHardenFeedbackBlockers,
  hasHardenFeedbackFindings,
  resolvedDeadletterPayload,
} from "./lib/visual-resolution-utils.mjs";

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  assert.match(files["scripts/visual-reference-plan.mjs"], /Semantic scene ref_requirements with kind "location" are binding target IDs/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /Preserve exact semantic location ref_ids during merge/i);
  assert.match(files["scripts/visual-reference-plan.mjs"], /style refs dropped for this run; use style bible\/text guidance only/i);

  for (const file of ["scripts/visual-plan.mjs", "scripts/visual-prompt-review.mjs"]) {
    assert.match(files[file], /polished 2D anime\/manhwa illustration style/i);
    assert.match(files[file], /clean line art, cel-shaded characters, cinematic webtoon\/manhwa lighting/i);
    assert.match(files[file], /Do not impose a universal wide\/full-frame\/medium-wide default/i);
    assert.match(files[file], /Resolve role\/title aliases to canonical named characters/i);
  }

  assert.match(files["scripts/imagegen.mjs"], /Preserve the shot scale and composition requested by the prompt/i);
  assert.equal(/Wide 16:9 landscape YouTube frame/i.test(files["scripts/imagegen.mjs"]), false);
  assert.equal(/full-frame composition, keep complete heads/i.test(files["scripts/imagegen.mjs"]), false);
  assert.match(files["scripts/codex-image-manual-import.mjs"], /promptTextForImageProvider\(prompt, "codex_imagegen"\)/);
  assert.match(files["bin/goldflow.mjs"], /imagegen import-staged-codex"\) return isTrue\(parsedFlags\["references-only"\]\) \? "reference_generation" : "image_generation"/);

  for (const file of ["AGENTS.md", "docs/workflows/video_production_workflow.md"]) {
    assert.match(files[file], /Real named public creators, streamers, celebrities, or influencers/i);
    assert.match(files[file], /source-face anchors/i);
    assert.match(files[file], /face-only identity/i);
    assert.match(files[file], /inventing a generic lookalike/i);
    assert.match(files[file], /--codex-opening-sec <seconds>/);
  }
}

function testPositivePromptSanitizerDoesNotInvertNegation() {
  const textless = sanitizePositiveVisualPrompt("clean UI panel, no readable text, no text");
  assert.equal(/clean readable text/i.test(textless), false);
  assert.match(textless, /unreadable/i);
  assert.match(textless, /textless/i);

  const alone = sanitizePositiveVisualPrompt("one man alone without a crowd");
  assert.equal(/with a crowd/i.test(alone), false);
  assert.match(alone, /without a crowd/i);

  assert.equal(sanitizePositiveVisualPrompt("no second character"), "single subject only");
  assert.match(sanitizePositiveVisualPrompt("no duplicate hero, no clone"), /one instance only/i);
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
  assert.equal(scriptReport.target_wpm_min, 210);
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

async function testScriptPaceBlocksLateHookMilestones() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-fixture-"));
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const filler = Array.from({ length: 130 }, (_, index) => `filler${index + 1}`).join(" ");
  const scriptText = `${filler} system activated. first quest complete. report to analytics hall.`;
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), scriptText, "utf8");
  let blocked = null;
  try {
    await execFileAsync(process.execPath, [
      "scripts/narration-pace-check.mjs",
      "--mode", "script",
      "--episode-dir", episodeDir,
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  } catch (error) {
    blocked = error;
  }
  assert.equal(blocked?.code, 1);
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "script_pace_report.json"), "utf8"));
  assert.equal(report.status, "blocked");
  assert.equal(report.hook_milestone_report.warnings.some((warning) => warning.code === "late_hidden_power_spark"), true);
  assert.match(report.blocker, /Script hook timing/);
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
  assert.equal(report.hook_visual_beat_count >= 8, true);
  assert.equal(report.retention_ramp_visual_beat_count >= 24, true);
  assert.equal(report.beats.every((beat) => String(beat.visual_beat_script_excerpt ?? "").trim()), true);
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
  assert.equal(report.visual_beat_quality_findings.some((finding) => finding.code === "named_character_not_visible_subject"), true);
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
    const location = index % 2 === 0
      ? "comedy_pressure_studio_table_area"
      : "streamer academy comedy pressure studio table area";
    return {
      scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
      parent_scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
      visual_beat_id: `scene_${String(index + 1).padStart(3, "0")}_beat_01`,
      start_sec: start,
      end_sec: start + 15,
      duration_sec: 15,
      location,
      visual_beat_script_excerpt: `Fixture beat ${index + 1} remains in the same comedy pressure studio table area.`,
      visual_job: "humiliation_image",
      suggested_shot_job: "emotional_reaction",
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
    source_script_hash: hash,
    beats,
  });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: hash, scenes: [] });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [{
      ref_id: "comedy_pressure_studio_table_area_ref",
      kind: "location",
      subject: "comedy pressure studio table area",
      scene_ids: beats.map((beat) => beat.scene_id),
      prompt_anchor: "comedy pressure studio table area with cameras and table props",
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
    source_script_hash: hash,
    beats: [
      { scene_id: "scene_001", parent_scene_id: "scene_001", visual_beat_id: "scene_001_beat_01", start_sec: 0, duration_sec: 5, location: "apartment" },
      { scene_id: "scene_002", parent_scene_id: "scene_002", visual_beat_id: "scene_002_beat_01", start_sec: 5, duration_sec: 5, location: "boardroom" },
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

async function runVisualHardenFixture({ dataRoot, promptText, codexPromptText = null, shotManifest = {}, referenceRequirements = [], referenceUsage = [], extraReferenceTargets = [], extraCharacterStateRefs = [] }) {
  const episodeDir = path.join(dataRoot, "channels", "test", "weekly_runs", "run", "episodes", "ep_01");
  const hash = "fixture_hash";
  await writeJson(path.join(episodeDir, "timed_scene_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    scenes: [{ scene_id: "scene_001", start_sec: 0, duration_sec: 5, location: "apartment kitchen" }],
  });
  await writeJson(path.join(episodeDir, "visual_reference_plan.json"), {
    status: "passed",
    source_script_hash: hash,
    reference_targets: [
      { ref_id: "loc_apartment", kind: "location", subject: "apartment kitchen", scene_ids: ["scene_001"], reference_image_path: "/tmp/loc_apartment.png" },
      { ref_id: "char_joey_ref", kind: "character_state", subject: "Joey", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_joey_ref.png" },
      ...extraReferenceTargets,
    ],
  });
  await writeJson(path.join(episodeDir, "character_state_refs.json"), {
    status: "approved",
    source_script_hash: hash,
    character_state_refs: [
      { state_ref_id: "char_joey_state", source_ref_id: "char_joey_ref", character: "Joey", scene_ids: ["scene_001"], reference_image_path: "/tmp/char_joey_ref.png" },
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
        location_ref_id: "loc_apartment",
        forbidden_ref_ids: [],
        ...shotManifest,
      },
    }],
  });
  let error = null;
  try {
    await execFileAsync(process.execPath, [
      "scripts/visual-prompt-harden.mjs",
      "--channel", "test",
      "--series", "series",
      "--week", "run",
      "--episode", "ep_01",
    ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  } catch (caught) {
    error = caught;
  }
  const plan = JSON.parse(await fs.readFile(path.join(episodeDir, "section_image_prompts_hardened.json"), "utf8"));
  const report = JSON.parse(await fs.readFile(path.join(episodeDir, "visual_prompt_hardening_ep_01.json"), "utf8"));
  return { plan, report, error };
}

async function testVisualHardenFlagsNegativePromptWithoutRewrite() {
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
  assert.equal(report.findings.some((finding) => finding.code === "negative_prompt" && finding.severity === "warning"), true);
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
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["loc_apartment", "char_joey_ref"]);
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.slot_order), [1, 2]);
  assert.equal(report.findings.some((finding) => finding.code === "negative_prompt"), false);
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
  assert.deepEqual(plan.prompts[0].reference_requirements.map((requirement) => requirement.ref_id), ["char_joey_ref"]);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_not_attached_report_only"), true);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_missing_after_sanitize" && finding.severity === "blocker"), true);
  assert.equal(report.findings.some((finding) => finding.code === "manifest_location_ref_added"), false);
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
    "char_joey_ref",
    "char_pookie_ref",
    "char_kai_ref",
    "char_jinx_ref",
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
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 210, target_wpm_max: 220 });
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
    target_wpm_min: 210,
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

  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "blocked", source_script_hash: scriptHash, target_wpm_min: 210, target_wpm_max: 220, actual_wpm: 167.54 });
  const blockedStatusResult = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const blockedStatus = JSON.parse(blockedStatusResult.stdout);
  assert.equal(blockedStatus.current_stage, "audio_pace_check");
  assert.match(blockedStatus.next_command_shape, /audio tempo-normalize/);
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 210, target_wpm_max: 220, actual_wpm: 214.286 });

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
    target_wpm_min: 210,
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
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 210, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash, replacements: [] });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: scriptHash });
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
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 210, target_wpm_max: 220 });
  await writeJson(path.join(episodeDir, "script_speakability_report.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "tts_spoken_overrides.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "semantic_scene_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), { status: "passed", source_script_hash: scriptHash });
  await writeJson(path.join(episodeDir, "modelslab_qwen_tts_report_ep_01.json"), { status: "passed" });
  const narrationPath = path.join(episodeDir, "narration.wav");
  await fs.writeFile(narrationPath, "fixture audio bytes");
  const narrationHash = sha256(await fs.readFile(narrationPath));
  await writeJson(path.join(episodeDir, "audio_stitch_report_ep_01-modelslab-qwen.json"), { status: "passed", output_path: narrationPath });
  await writeJson(path.join(episodeDir, "narration_word_timing_ep_01.json"), { status: "passed", source_script_hash: scriptHash, narration_audio_hash: narrationHash });
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 210, target_wpm_max: 220, actual_wpm: 214.286 });
  const mixPath = path.join(episodeDir, "longform_mix.m4a");
  await fs.writeFile(mixPath, "fixture mix bytes");
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), { status: "completed", mix: { m4a_path: mixPath } });
  const timedPath = path.join(episodeDir, "timed_scene_plan.json");
  await writeJson(timedPath, { status: "passed", source_script_hash: scriptHash, scenes: [] });
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
  await writeJson(timedPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001" }] });
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-status.mjs",
    "--episode-dir", episodeDir,
  ], { cwd: process.cwd(), env: { ...process.env, ANIFACTORY_DATA_ROOT: dataRoot } });
  const status = JSON.parse(stdout);
  const visualBeatStage = status.stage_ledger.find((row) => row.stage === "visual_beat_plan");
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
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 210, target_wpm_max: 220 });
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
  await writeJson(path.join(episodeDir, "narration_pace_report_ep_01.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 210, target_wpm_max: 220, actual_wpm: 214.286 });
  const timedPath = path.join(episodeDir, "timed_scene_plan.json");
  await writeJson(timedPath, { status: "passed", source_script_hash: scriptHash, scenes: [{ scene_id: "scene_001" }] });
  const mixPath = path.join(episodeDir, "longform_mix.m4a");
  await fs.writeFile(mixPath, "fixture mix bytes");
  await writeJson(path.join(episodeDir, "longform_audio_bed_report_ep_01.json"), { status: "completed", mix: { m4a_path: mixPath } });
  const scriptPath = path.join(episodeDir, "script_clean.md");
  await writeJson(path.join(episodeDir, "visual_beat_plan.json"), {
    status: "passed",
    source_script_hash: scriptHash,
    source_hashes: {
      [timedPath]: sha256(await fs.readFile(timedPath)),
      [scriptPath]: sha256(await fs.readFile(scriptPath)),
    },
    beats: [{ visual_beat_id: "scene_001_beat_01", scene_id: "scene_001" }],
  });
  const visualRefPath = path.join(episodeDir, "visual_reference_plan.json");
  await writeJson(visualRefPath, {
    status: "passed",
    source_script_hash: scriptHash,
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
  await writeJson(path.join(episodeDir, "script_pace_report.json"), { status: "passed", source_script_hash: scriptHash, target_wpm_min: 210, target_wpm_max: 220 });
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

async function run() {
  testLocationSceneIdsDerivation();
  testLocationCandidateExclusion();
  testStarvationGate();
  testBroadLocationTargetDoesNotSatisfySemanticLocationRequirement();
  testOutOfScopeRefDropping();
  testReferenceLimitOmissionIsNotForbidden();
  testOutOfScopeLocationMentionAssertion();
  testProviderAwarePromptSelection();
  testLocalBeatFidelityEditorialCases();
  testHybridImageProviderRouting();
  await testHybridOpeningWindowPersistsInRunIdentity();
  await testVisualPlannerDriftContracts();
  testPositivePromptSanitizerDoesNotInvertNegation();
  testVoiceDirectionCharacterization();
  testQwenPlanAuditsAppliedTtsOverrides();
  testCharacterStagingSanitizerAndReviewBlockers();
  await testNarrationPaceChecks();
  await testScriptPaceBlocksLateHookMilestones();
  await testTargetedSpeakabilityLiveContentHomograph();
  await testVisualBeatDensityDefaults();
  await testVisualBeatQualityFindings();
  await testCrossGenreVisualBeatFixtures();
  testLongLocationSpanCrossingRetentionBoundary();
  testRepeatedRetentionShotJobRunFindings();
  await testVisualPlanBlocksOverbroadLocationRefCoverageBeforeLlm();
  await testVisualPlanAllowsSameLocationLabelAliases();
  await testOnlyScenesDryRun();
  testHardenFeedbackBlockersMapToReviewResolveInput();
  testPassedReviewClearsDeadletterPayload();
  await testVisualHardenFlagsNegativePromptWithoutRewrite();
  await testVisualHardenLeavesCleanPromptByteIdenticalAndNormalizesRefs();
  await testVisualHardenBlocksMissingManifestLocationWithoutAddingIt();
  await testVisualHardenPreservesCrowdedCharacterRefsOverOmittedLocation();
  await testImagegenDeadletterRefusal();
  await testNarratorOnlyStatusAndMixer();
  await testRunStatusBlocksLegacyScriptPaceHookWarnings();
  await testRunStatusBlocksMissingQwenStitchedAudio();
  await testRunStatusBlocksStaleVisualBeatSourceHashes();
  await testRunStatusBlocksStaleVisualReferenceSourceHashes();
  await testRunStatusBlocksQwenPlanMissingOverrideAudit();
  await testRunStatusIgnoresProofImageReportWithoutCurrentHardenedPlan();
  await testSilentTransitionsWithoutSfxBank();
  console.log("goldflow fixture tests passed");
}

await run();
