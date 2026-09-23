import assert from "node:assert/strict";

import {
  LONGFORM_DRAFT_PORTFOLIO_SCHEMA,
  NARRATION_REVISION_LEDGER_SCHEMA,
  PREMISE_BLIND_SELECTION_V3_SCHEMA,
  PREMISE_POOL_V3_SCHEMA,
  STORY_TRUTH_IR_SCHEMA,
  STORY_TRUTH_IR_SCHEMA_V2,
  STORY_TRUTH_SCRIPT_MAP_SCHEMA,
  STORY_TRUTH_SCRIPT_MAP_SCHEMA_V2,
  sha256CanonicalStoryJson,
  validateLongformDraftPortfolio,
  validateNarrationRevisionLedger,
  validatePremiseBlindSelectionV3,
  validatePremisePoolV3,
  validateStoryTruthIr,
  validateStoryTruthScriptMap,
} from "../lib/first-class-story-contract.mjs";
import {
  SOURCE_DRAFT_CANDIDATE_SPECS,
  sourceDraftCandidateContract,
  validateSourceModelReceipt,
} from "../lib/source-model-policy.mjs";
import { validateStoryWriterPacket } from "../lib/story-writer-packet-contract.mjs";

const hash = "a".repeat(64);
const movementIds = Array.from({ length: 10 }, (_, index) => `movement_${index + 1}`);
const architecture = { movements: movementIds.map((id) => ({ id })) };
const promise = {
  id: "promise_1",
  source: "title",
  promise: "betrayal becomes visible superiority",
  visible_receipt: "the betrayer sees the reversal",
  spark_deadline_word: 250,
  spark_movement_id: movementIds[0],
  first_proof_deadline_word: 800,
  first_proof_movement_id: movementIds[1],
  escalation_movement_ids: [movementIds[4]],
  full_payoff_deadline_word: 9_500,
  full_payoff_movement_id: movementIds[9],
};
const storyTruth = {
  schema: STORY_TRUTH_IR_SCHEMA,
  status: "locked",
  package_sha256: hash,
  selected_treatment_sha256: hash,
  architecture_sha256: hash,
  promises: [promise, { ...promise, id: "promise_2", source: "thumbnail" }],
  causal_chains: movementIds.slice(0, 6).map((movementId, index) => ({
    id: `causal_${index + 1}`,
    pressure: "pressure",
    choice: "choice",
    owned_choice: true,
    consequence: "consequence",
    counter: "counter",
    changed_situation: "changed",
    movement_ids: [movementId],
  })),
  character_agency: [1, 2].map((number) => ({
    id: `agency_${number}`,
    character: `Character ${number}`,
    desire: "desire",
    pressure: "pressure",
    decision: "decision",
    alternative_rejected: "alternative",
    consequence: "consequence",
    movement_id: movementIds[number],
  })),
  setup_payoffs: [1, 2, 3, 4].map((number) => ({
    id: `setup_${number}`,
    setup: "setup",
    setup_movement_id: movementIds[number - 1],
    payoff: "payoff",
    payoff_movement_id: movementIds[number + 4],
    payoff_deadline_word: 8_000,
    deferral: "none",
    deferral_reason: null,
  })),
  mechanic_rules: [{
    id: "mechanic_1",
    spoken_name: "Reversal",
    trigger_or_input: "choice",
    observable_output: "visible mark",
    limit_or_cost: "one use",
    provenance: "approved treatment",
    first_clear_movement_id: movementIds[1],
  }],
  state_transitions: movementIds.slice(0, 6).map((movementId, index) => ({
    id: `state_${index + 1}`,
    subject: "Joey",
    state_type: "knowledge",
    from: `before ${index}`,
    to: `after ${index}`,
    cause: "choice",
    movement_id: movementId,
  })),
  reveals: [1, 2].map((number) => ({
    id: `reveal_${number}`,
    knowledge: "truth",
    knower_before: "Joey",
    knower_after: "crew",
    movement_id: movementIds[number],
    behavior_change: "they adapt",
  })),
  narration_constraints: {
    protected_facts: ["Joey chooses"],
    spoken_clarity_rules: ["names differ"],
    pronunciation_risks: [],
  },
};

const storyTruthV2 = {
  ...storyTruth,
  schema: STORY_TRUTH_IR_SCHEMA_V2,
  retention_obligations: storyTruth.promises.map((row, index) => ({
    id: `retention_${index + 1}`,
    type: row.source === "title" ? "promise" : "fantasy_payoff",
    obligation: row.promise,
    source_truth_ids: [row.id],
    open_deadline_word: row.spark_deadline_word,
    open_movement_id: row.spark_movement_id,
    development_movement_ids: [row.first_proof_movement_id],
    closure_deadline_word: row.full_payoff_deadline_word,
    closure_movement_id: row.full_payoff_movement_id,
    visible_or_spoken_receipt: row.visible_receipt,
    replacement_obligation_id: null,
  })),
  movement_quality: movementIds.map((movementId, index) => ({
    id: `movement_quality_${index + 1}`,
    movement_id: movementId,
    changed_dimensions: [index % 2 === 0 ? "choice" : "consequence"],
    new_pressure_or_reward: "The equation changes.",
    specific_evidence_or_object: "The scarred shield.",
    irreversible_consequence: "The prior position cannot be restored.",
    redundant_explanation_risk: "none",
    procedural_reporting_risk: "none",
    antagonist_counterplay: index < 2 ? {
      applicable: true,
      observer: "Serena",
      observation: "Joey refuses the old role.",
      inference: "His loyalty can no longer be assumed.",
      changed_tactic: "She attacks his public credibility.",
      forced_choice: "He must choose evidence or safety.",
      not_applicable_reason: null,
    } : {
      applicable: false,
      not_applicable_reason: "This movement resolves crew consequence without active opposition.",
    },
  })),
  character_voice_fingerprints: [1, 2].map((number) => ({
    id: `voice_${number}`,
    character: `Character ${number}`,
    role: number === 1 ? "protector" : "commander",
    vocabulary: number === 1 ? "plain physical limits" : "controlled strategic abstractions",
    sentence_shape: number === 1 ? "short declaratives" : "balanced commands",
    emotional_avoidance: "Names fear through logistics.",
    humor: "Dry and situational.",
    values: "Choice before sacrifice.",
    decision_style: "States the limit, then acts.",
    contrast_with: number === 1 ? "Character 2 softens control" : "Character 1 names concrete limits",
    forbidden_generic_modes: ["interchangeable quips", "motivational aphorisms"],
  })),
};

assert.equal(validateStoryTruthIr(storyTruth, {
  packageSha256: hash,
  selectedTreatmentSha256: hash,
  architectureSha256: hash,
  architecture,
}).done, true);
assert.equal(validateStoryTruthIr({ ...storyTruth, causal_chains: [] }, { architecture }).done, false);
assert.equal(validateStoryTruthIr(storyTruthV2, {
  packageSha256: hash,
  selectedTreatmentSha256: hash,
  architectureSha256: hash,
  architecture,
}).done, true);
assert.equal(validateStoryTruthIr({
  ...storyTruthV2,
  movement_quality: storyTruthV2.movement_quality.slice(1),
}, { architecture }).done, false);

const packetDetail = "Concrete action, visible consequence, and a clear next pressure keep the story moving without repeating the room. ".repeat(2).trim();
const writerPacket = {
  schema: "goldflow_story_writer_packet_v1",
  status: "authored",
  package_sha256: hash,
  selected_treatment_sha256: hash,
  architecture_sha256: hash,
  title: "Approved title",
  thumbnail_receipt: "Approved thumbnail receipt",
  target_word_range: { minimum: 9_500, maximum: 10_500 },
  core_story_promise: packetDetail,
  opening_plan: packetDetail,
  cast: ["Joey Manhwa", "Sena Moru"].map((name) => ({ name, role: packetDetail, desire: packetDetail, voice: packetDetail, story_job: packetDetail })),
  mechanic_rules: Array.from({ length: 4 }, (_, index) => ({ name: `Rule ${index}`, plain_rule: packetDetail, limit_or_cost: packetDetail, first_proof: packetDetail })),
  movement_outline: movementIds.map((movement_id) => ({ movement_id, story_change: packetDetail, must_show: packetDetail, payoff: packetDetail, next_pressure: packetDetail })),
  required_payoffs: Array.from({ length: 4 }, () => packetDetail),
  ending_contract: packetDetail,
  voice_and_style: [packetDetail, packetDetail, packetDetail],
  forbidden_drift: [packetDetail, packetDetail, packetDetail],
};
assert.equal(validateStoryWriterPacket(writerPacket, {
  packageSha256: hash,
  selectedTreatmentSha256: hash,
  architectureSha256: hash,
  architecture: { movements: architecture.movements, character_name_plan: [{ name: "Joey Manhwa" }, { name: "Sena Moru" }] },
}).done, true);

const gptSlate = { candidates: Array.from({ length: 6 }, (_, index) => ({ id: `g${index}` })) };
const geminiSlate = { candidates: Array.from({ length: 6 }, (_, index) => ({ id: `m${index}` })) };
const premisePool = {
  schema: PREMISE_POOL_V3_SCHEMA,
  status: "pooled",
  evidence_registry_sha256: hash,
  author_slate_sha256s: { gpt_web: hash, gemini_web: hash },
  candidates: [
    ...gptSlate.candidates.map((candidate) => ({ author: "gpt_web", candidate })),
    ...geminiSlate.candidates.map((candidate) => ({ author: "gemini_web", candidate })),
  ].map((row, index) => ({
    source_candidate_id: `${row.author}:${row.candidate.id}`,
    author: row.author,
    blind_id: `blind_${String.fromCharCode(97 + index)}`,
    candidate_sha256: sha256CanonicalStoryJson(row.candidate),
    candidate: row.candidate,
  })),
};
assert.equal(validatePremisePoolV3(premisePool, {
  gptSlate,
  gptSlateSha256: hash,
  geminiSlate,
  geminiSlateSha256: hash,
  evidenceRegistrySha256: hash,
}).done, true);
const premiseSelection = {
  schema: PREMISE_BLIND_SELECTION_V3_SCHEMA,
  status: "selected",
  premise_pool_sha256: hash,
  evidence_registry_sha256: hash,
  finalist_blind_ids: premisePool.candidates.slice(0, 6).map((row) => row.blind_id),
  selected_blind_id: "blind_a",
  selection_rationale: "best package",
  rankings: premisePool.candidates.map((row, index) => ({ blind_id: row.blind_id, rank: index + 1, click_judgment: "strong", runway_judgment: "strong", decisive_reason: "clear" })),
  rejection_reason: null,
};
assert.equal(validatePremiseBlindSelectionV3(premiseSelection, { premisePool, premisePoolSha256: hash, evidenceRegistrySha256: hash }).done, true);

const movieBoundPool = {
  ...premisePool,
  candidates: premisePool.candidates.map((row, index) => ({
    ...row,
    candidate: {
      ...row.candidate,
      source_premise_movie: {
        blind_id: `blind_movie_${String((index % 6) + 1).padStart(2, "0")}`,
        premise_movie_sha256: hash,
      },
    },
  })),
};
const onePerMovieSelection = {
  ...premiseSelection,
  finalist_blind_ids: movieBoundPool.candidates.slice(0, 6).map((row) => row.blind_id),
};
assert.equal(validatePremiseBlindSelectionV3(onePerMovieSelection, {
  premisePool: movieBoundPool,
  premisePoolSha256: hash,
  evidenceRegistrySha256: hash,
  requireOneFinalistPerPremiseMovie: true,
}).done, true);
assert.equal(validatePremiseBlindSelectionV3({
  ...onePerMovieSelection,
  finalist_blind_ids: ["blind_a", "blind_g", "blind_b", "blind_c", "blind_d", "blind_e"],
}, {
  premisePool: movieBoundPool,
  premisePoolSha256: hash,
  evidenceRegistrySha256: hash,
  requireOneFinalistPerPremiseMovie: true,
}).done, false);

for (const spec of SOURCE_DRAFT_CANDIDATE_SPECS) {
  const contract = sourceDraftCandidateContract(spec, { stageName: `test_${spec.id}` });
  assert.equal(contract.model, spec.model);
  assert.equal(contract.reasoning_effort, spec.reasoning_effort);
  const receipt = {
    provider: spec.provider,
    model: spec.model,
    reasoning_effort: spec.reasoning_effort,
    transport: spec.provider === "chatgpt_web" ? "goldflow_studio_local_api" : "codex_cli",
  };
  assert.equal(validateSourceModelReceipt(receipt, { expectedContract: contract }).done, true);
  assert.equal(validateSourceModelReceipt({ ...receipt, transport: "wrong_transport" }, { expectedContract: contract }).done, false);
}
assert.equal(SOURCE_DRAFT_CANDIDATE_SPECS.filter((row) => row.model === "gpt-6-sol").length, 6);
assert.equal(SOURCE_DRAFT_CANDIDATE_SPECS.filter((row) => row.model === "gpt-5.5").length, 0);
assert.equal(SOURCE_DRAFT_CANDIDATE_SPECS.filter((row) => row.provider === "chatgpt_web").length, 6);
assert.equal(SOURCE_DRAFT_CANDIDATE_SPECS.filter((row) => row.reasoning_effort === "max").length, 6);
assert.equal(SOURCE_DRAFT_CANDIDATE_SPECS.filter((row) => row.visible_effort === "Pro").length, 6);
assert.equal(SOURCE_DRAFT_CANDIDATE_SPECS.filter((row) => row.transport === "authenticated_chatgpt_web").length, 6);

const portfolio = {
  schema: LONGFORM_DRAFT_PORTFOLIO_SCHEMA,
  status: "completed",
  package_sha256: hash,
  architecture_sha256: hash,
  story_truth_ir_sha256: hash,
  candidates: SOURCE_DRAFT_CANDIDATE_SPECS.map((spec) => ({
    ...spec,
    prompt_sha256: hash,
    output_path: `/tmp/${spec.id}.txt`,
    output_sha256: hash,
    receipt_path: `/tmp/${spec.id}.meta.json`,
    receipt_sha256: hash,
    word_count: 10_000,
    word_count_target: { minimum: 9_500, maximum: 10_500, enforcement: "advisory" },
    word_count_status: "within_target",
  })),
};
assert.equal(validateLongformDraftPortfolio(portfolio, { packageSha256: hash, architectureSha256: hash, storyTruthIrSha256: hash, expectedCandidates: SOURCE_DRAFT_CANDIDATE_SPECS }).done, true);

const scriptText = "Joey chose the shield. The betrayer saw the reversal. The crew changed its plan.";
const mappings = [];
const addMap = (truthCollection, truthId, phase, exactText, movementId) => {
  const start = scriptText.indexOf(exactText);
  mappings.push({
    map_id: `map_${mappings.length + 1}`,
    truth_collection: truthCollection,
    truth_id: truthId,
    phase,
    movement_id: movementId,
    start_offset: start,
    end_offset: start + exactText.length,
    exact_text: exactText,
    story_function: "proof",
  });
};
for (const row of storyTruth.promises) for (const phase of ["spark", "first_proof", "full_payoff"]) addMap("promises", row.id, phase, "The betrayer saw the reversal.", movementIds[1]);
for (const collection of ["causal_chains", "character_agency", "setup_payoffs", "mechanic_rules", "state_transitions", "reveals"]) {
  for (const row of storyTruth[collection]) addMap(collection, row.id, "primary", "Joey chose the shield.", row.movement_ids?.[0] ?? row.movement_id ?? row.first_clear_movement_id ?? movementIds[0]);
}
const storyMap = {
  schema: STORY_TRUTH_SCRIPT_MAP_SCHEMA,
  status: "mapped",
  story_truth_ir_sha256: hash,
  script_sha256: hash,
  mappings,
};
assert.equal(validateStoryTruthScriptMap(storyMap, { storyTruthIr: storyTruth, storyTruthIrSha256: hash, scriptText, scriptSha256: hash }).done, true);

const v2Mappings = [...mappings];
const addV2Map = (truthCollection, truthId, phase, movementId) => {
  const exactText = "Joey chose the shield.";
  const start = scriptText.indexOf(exactText);
  v2Mappings.push({
    map_id: `map_${v2Mappings.length + 1}`,
    truth_collection: truthCollection,
    truth_id: truthId,
    phase,
    movement_id: movementId,
    start_offset: start,
    end_offset: start + exactText.length,
    exact_text: exactText,
    story_function: "quality proof",
  });
};
for (const row of storyTruthV2.retention_obligations) {
  for (const phase of ["open", "development", "closure"]) addV2Map("retention_obligations", row.id, phase, row.open_movement_id);
}
for (const row of storyTruthV2.movement_quality) addV2Map("movement_quality", row.id, "primary", row.movement_id);
for (const row of storyTruthV2.character_voice_fingerprints) addV2Map("character_voice_fingerprints", row.id, "voice_proof", movementIds[0]);
const storyMapV2 = {
  ...storyMap,
  schema: STORY_TRUTH_SCRIPT_MAP_SCHEMA_V2,
  mappings: v2Mappings,
};
assert.equal(validateStoryTruthScriptMap(storyMapV2, {
  storyTruthIr: storyTruthV2,
  storyTruthIrSha256: hash,
  scriptText,
  scriptSha256: hash,
}).done, true);

const narrationLedger = {
  schema: NARRATION_REVISION_LEDGER_SCHEMA,
  status: "polished",
  source_script_sha256: hash,
  polished_script_sha256: hash,
  story_truth_ir_sha256: hash,
  source_word_count: 10_000,
  polished_word_count: 9_900,
  story_facts_changed: false,
  events_reordered: false,
  ending_changed: false,
  changes: [],
};
assert.equal(validateNarrationRevisionLedger(narrationLedger, { sourceScriptSha256: hash, polishedScriptSha256: hash, storyTruthIrSha256: hash }).done, true);
assert.equal(validateNarrationRevisionLedger({ ...narrationLedger, story_facts_changed: true }).done, false);

console.log("first-class story contract tests passed");
