import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WINNER_FORMULA_SCHEMA,
  WINNER_GATE_IDS,
  WINNER_IDEATION_SCHEMA,
  WINNER_PACKAGE_APPROVAL_SCHEMA,
  WINNER_PACKAGE_CONTRACT_SCHEMA,
  WINNER_RETENTION_CHECKPOINT_IDS,
  WINNER_SCRIPT_GATE_SCHEMA,
  WINNER_SOURCE_RELEASE_SCHEMA,
  buildWinnerPackageContract,
  countWords,
  deterministicWinnerScriptReview,
  evaluateWinnerIdeation,
  normalizeWinnerNarration,
  sha256Text,
  validateWinnerFormula,
  validateWinnerPackageContract,
  validateWinnerScriptGate,
  validateWinnerSourceRelease,
} from "../lib/winner-source-contract.mjs";

const DIMENSION_POLICIES = {
  click_clarity: { weight: 16, minimum: 8 },
  title_completion: { weight: 14, minimum: 8 },
  thumbnail_additivity: { weight: 10, minimum: 8 },
  opening_deliverability: { weight: 12, minimum: 8 },
  causal_story_engine: { weight: 15, minimum: 8 },
  payoff_symmetry: { weight: 13, minimum: 8 },
  fresh_from_recent_uploads: { weight: 10, minimum: 7 },
  production_visual_fit: { weight: 5, minimum: 7 },
  audience_evidence_fit: { weight: 5, minimum: 8 },
};

const PACKAGE_SEEDS = [
  {
    id: "wife_sold_home",
    engineType: "one-dollar property system",
    title: "My Wife Sold My Home, Then I Bought Her Company | Manhwa Recap",
    betrayalPhrase: "Sold My Home",
    reversalPhrase: "Bought Her Company",
    betrayer: "Joey's wife",
    betrayalAction: "She secretly sells the home Joey rebuilt.",
    reversalAction: "Joey earns enough control to purchase her failing company.",
    antagonistLoss: "She loses the company and the home she treated as leverage.",
  },
  {
    id: "brother_fired_hotel",
    engineType: "hundred-times hotel restoration skill",
    title: "My Brother Fired Me, Then I Took His Hotel | Manhwa Recap",
    betrayalPhrase: "Fired Me",
    reversalPhrase: "Took His Hotel",
    betrayer: "Joey's brother",
    betrayalAction: "He fires Joey after stealing his hotel recovery plan.",
    reversalAction: "Joey wins control of the hotel by restoring its abandoned wing.",
    antagonistLoss: "His brother loses the hotel and the staff he treated as disposable.",
  },
  {
    id: "boss_stole_patent",
    engineType: "winning patent royalty ticket",
    title: "My Boss Stole My Patent, Then I Owned His Factory | Manhwa Recap",
    betrayalPhrase: "Stole My Patent",
    reversalPhrase: "Owned His Factory",
    betrayer: "Joey's boss",
    betrayalAction: "He steals Joey's safety patent and removes his name.",
    reversalAction: "Joey earns the factory through a production turnaround.",
    antagonistLoss: "His boss loses the plant and the authority built on stolen credit.",
  },
  {
    id: "fiancee_took_savings",
    engineType: "hyper-scaling financial pattern genius",
    title: "My Fiancee Took My Savings, Then I Bought Her Bank | Manhwa Recap",
    betrayalPhrase: "Took My Savings",
    reversalPhrase: "Bought Her Bank",
    betrayer: "Joey's fiancee",
    betrayalAction: "She drains Joey's savings to protect a corrupt banker.",
    reversalAction: "Joey builds a recovery fund that acquires the bank's debt.",
    antagonistLoss: "She loses access to the bank and every account she abused.",
  },
  {
    id: "family_disowned_rival",
    engineType: "founder ghost alliance",
    title: "My Family Disowned Me, Then I Built Their Rival Empire | Manhwa Recap",
    betrayalPhrase: "Disowned Me",
    reversalPhrase: "Built Their Rival Empire",
    betrayer: "Joey's family",
    betrayalAction: "They disown Joey and hand his workshop to a favored cousin.",
    reversalAction: "Joey builds a rival company with the workers they discarded.",
    antagonistLoss: "His family loses its contracts, status, and control of the market.",
  },
  {
    id: "partner_framed_network",
    engineType: "truth genie contract",
    title: "My Partner Framed Me, Then I Exposed His Entire Network | Manhwa Recap",
    betrayalPhrase: "Framed Me",
    reversalPhrase: "Exposed His Entire Network",
    betrayer: "Joey's business partner",
    betrayalAction: "He frames Joey for a theft committed through shell vendors.",
    reversalAction: "Joey builds an evidence network that exposes the real scheme.",
    antagonistLoss: "His partner loses his allies, contracts, and protected reputation.",
  },
];

export function validFormula() {
  return {
    schema: WINNER_FORMULA_SCHEMA,
    status: "active",
    channel: "53rebirth",
    version: "test-formula-v1",
    candidate_policy: {
      raw_idea_pool_count: 12,
      requested_candidate_count: 6,
      minimum_eligible_candidates: 3,
      minimum_total_score: 80,
      required_evidence_types: ["own_channel", "niche_outlier"],
      target_runtime_minutes: 10,
      target_runtime_min_minutes: 9,
      target_runtime_max_minutes: 11,
      target_spoken_wpm: 100,
      narration_profile: "CONVERSATIONAL WINNER",
      title_suffix: "| Manhwa Recap",
      title_max_characters: 100,
      thumbnail_main_text_words_max: 4,
      thumbnail_total_overlay_words_max: 8,
      thumbnail_subjects_max: 3,
      thumbnail_arrows_max: 2,
      thumbnail_labels_max: 2,
    },
    reversal_engine_policy: {
      mandatory_betrayal_spine: "Every candidate begins with a concrete betrayal and connects it to one reversal engine.",
      sequence: "BETRAYAL -> ENGINE -> PROOF -> PAYBACK",
      discovery_rule: "Use free-form reversal engines with no fixed family enum or quota.",
      batch_diversity_rule: "Explore different engines, but use diversity only as a tiebreaker.",
      selection_rule: "Select the strongest packages and preserve operator seeds.",
    },
    score_dimensions: structuredClone(DIMENSION_POLICIES),
    retention_architecture: {
      minimum_total_score: 85,
      movement_count_min: 8,
      movement_count_max: 10,
      movement_max_script_percent: 18,
      climax_start_percent_min: 86,
      climax_start_percent_max: 92,
      resolution_script_percent_max: 8,
      score_dimensions: {
        opening_and_ten_minute_payoff_map: { weight: 15, minimum: 7 },
        clear_advantage_rule_and_scaling_path: { weight: 15, minimum: 7 },
        joey_agency_and_audience_trust: { weight: 15, minimum: 7 },
        causal_movement_runway: { weight: 20, minimum: 7 },
        conflict_variety_and_procedure_restraint: { weight: 10, minimum: 7 },
        intelligent_opposition_and_scaling_pressure: { weight: 10, minimum: 7 },
        active_title_native_climax: { weight: 10, minimum: 7 },
        concise_closure: { weight: 5, minimum: 7 },
      },
      required_checkpoint_ids: [...WINNER_RETENTION_CHECKPOINT_IDS],
    },
    hard_reject_codes: {
      setup_only_title: "The title promises only the wound.",
      thumbnail_repeats_title: "The thumbnail repeats the title.",
      passive_joey: "Joey never establishes a boundary.",
    },
    evidence: [
      {
        id: "own_death_goddess",
        source_type: "own_channel",
        source_ref: "own-video-id",
        title: "My Wife Poisoned Me, Then I Married the Goddess of Death",
        metrics: { views: 22300, average_view_duration_sec: 1473 },
        lesson: "An intimate betrayal and literal relationship reversal are immediately legible.",
      },
      {
        id: "niche_runaway_bride",
        source_type: "niche_outlier",
        source_ref: "niche-video-id",
        title: "My Bride Ran Away, So I Married Her Billionaire Aunt",
        metrics: { views: 110582, views_per_hour: 235 },
        lesson: "A simple relationship substitution produces a complete click promise.",
      },
    ],
  };
}

function premiseFor(seed) {
  return [
    `Joey Manhwa discovers that ${seed.betrayalAction.toLowerCase()} The betrayal removes something concrete he spent years building and forces him to leave before the antagonist can keep using his labor.`,
    `Joey establishes an irreversible boundary in the opening, preserves one piece of evidence, and discovers a hyper-scaling advantage. Its first proof opens a new path, and Joey keeps converting each result into knowledge, resources, allies, infrastructure, and larger goals.`,
    `The middle follows changing objectives through a customer rescue, a production breakthrough, a supplier challenge, an ally's contribution, and an antagonist counterattack. Joey's mechanic remains powerful while the scale, responsibility, and opposition keep growing around it.`,
    `${seed.reversalAction} The climax happens in front of the same people who witnessed the betrayal. ${seed.antagonistLoss} Joey refuses reconciliation, rewards the allies who materially changed the outcome, and ends in a stable life beyond revenge.`,
  ].join(" ");
}

function validCandidate(seed, index) {
  const score = index === 0 ? 10 : 9;
  return {
    id: seed.id,
    title: seed.title,
    title_contract: {
      betrayer: seed.betrayer,
      betrayal_action: seed.betrayalAction,
      reversal_action: seed.reversalAction,
      antagonist_loss: seed.antagonistLoss,
      betrayal_phrase: seed.betrayalPhrase,
      reversal_phrase: seed.reversalPhrase,
    },
    thumbnail: {
      subjects: ["Joey with controlled resolve", `${seed.betrayer} in visible panic`],
      main_text: "HE LOST EVERYTHING",
      labels: ["SIGNED PROOF"],
      arrows: ["one yellow arrow from the proof to the antagonist"],
      dominant_proof: "A signed ownership document splits the two characters.",
      betrayal_signal: "The antagonist grips the property taken from Joey.",
      reversal_signal: "Joey holds the document that transfers control.",
      additive_fact: "The signed proof shows the antagonist's loss rather than restating the title.",
      image_prompt: "One cinematic ballroom confrontation, Joey on the left, shocked antagonist on the right, one signed document between them, clean yellow arrow, exact large text HE LOST EVERYTHING.",
    },
    premise: premiseFor(seed),
    core_advantage: {
      type: seed.engineType,
      post_betrayal_connection: "After leaving the betrayer, Joey encounters the engine and chooses a new objective.",
      source_or_activation: "The engine awakens when Joey commits to building beyond his old life.",
      core_capability: "It accelerates learning, invention, and resource growth without an artificial cap.",
      growth_or_compounding_rule: "Every completed application multiplies Joey's knowledge, tools, reach, and next opportunity.",
      execution_bridge: "The engine accelerates learning and precise control, then converts successful designs into capital, equipment, specialist allies, and operating authority needed to execute at larger scales.",
      first_visible_proof: "Joey solves in one night a problem that defeated an expert team.",
      decisive_applications: [
        {
          role: "first_proof",
          obstacle_or_tell: "A production line overheats in the same three-second interval after every automatic restart.",
          mechanic_output_or_granted_capability: "The engine maps the timing pattern, identifies a stale controller command, and accelerates Joey's mastery of the control sequence.",
          execution_bridge: "Joey already has physical access to the controller, and the engine gives him the technical understanding and precise timing needed to alter the restart safely.",
          joey_tactic_and_action: "He isolates the line, delays the stale command, and restarts one motor at a time to expose the conflict without risking the workers.",
          opponent_or_environment_response: "The faulty controller repeats the old command exactly when predicted, but the staged restart quarantines it before the temperature rises.",
          result: "The line completes its first safe restart and returns to production.",
          dominance_proof: "Joey diagnoses and corrects in one night a failure that the expert team could not reproduce across three weeks.",
        },
        {
          role: "climax_or_late_scale_proof",
          obstacle_or_tell: "The antagonist's flagship system hides conflicting commands behind a polished dashboard during a public acceptance test.",
          mechanic_output_or_granted_capability: "Joey's scaled engine predicts the conflict and coordinates verified local controls across the entire facility.",
          execution_bridge: "The earlier product, recruited specialists, installed hardware, client authority, and rehearsed safety plan let Joey execute the response at factory scale.",
          joey_tactic_and_action: "Joey baits the delayed command with the disclosed failure sequence, rejects it at the local nodes, and restores each production cell in verified order.",
          opponent_or_environment_response: "The rival system accepts both commands and locks down while Joey's system degrades safely and resumes one cell at a time.",
          result: "Joey passes the live acceptance test and wins the contract that transfers control promised by the title.",
          dominance_proof: "His system clears every safety condition under the same test that stops the rival plant for eleven hours.",
        },
      ],
      causal_scale_path: "First proof leads to a product, the product attracts capital and experts, and their work builds facilities and a global company.",
      optional_constraints_or_risks: "Unknown ceiling; implementation still requires Joey to choose goals and organize real people and resources.",
    },
    story_contract: {
      opening_30_seconds: `${seed.betrayalAction} Joey loses access in the same public scene.`,
      boundary_by_minute_5: "Joey leaves, revokes access, and refuses to keep rescuing the betrayer.",
      first_advantage_proof_by_minute_8: "Joey earns narrow authority by solving one concrete safety failure.",
      new_objective_by_minute_10: "Joey commits to rebuilding the discarded operation with its workers.",
      middle_engine: [
        "A client refuses trust until Joey accepts external verification.",
        "An ally catches Joey making a rushed promise and forces a safer plan.",
        "A supplier releases limited material against transparent cash records.",
        "The antagonist adapts by recruiting workers and attacking the new contract.",
        "Joey recovers through a changed team decision, not a surprise gift.",
      ],
      escalation_pressure: "Each breakthrough attracts larger rivals, harder implementation work, and responsibility for more people.",
      antagonist_adaptation: "The antagonist recruits credible allies and uses a real contract to challenge Joey.",
      climax: "Joey's team passes a public acceptance test while the antagonist's unsafe promise fails.",
      final_boundary: "Joey refuses restoration of the old relationship and redirects recovered value to the workers.",
    },
    differentiation: {
      recent_relationship: `relationship variant ${index + 1}`,
      advantage: `earned authority variant ${index + 1}`,
      setting: `operating setting ${index + 1}`,
      payoff: `literal loss variant ${index + 1}`,
    },
    evidence_ids: ["own_death_goddess", "niche_runaway_bride"],
    score_inputs: Object.fromEntries(Object.keys(DIMENSION_POLICIES).map((id) => [id, score])),
    hard_rejects: [],
    risk_notes: ["The operating details must remain emotionally legible."],
    pairwise_rank: index + 1,
    pairwise_wins: PACKAGE_SEEDS.length - index - 1,
    selection_rationale: `Independent pairwise review placed this package at rank ${index + 1} because its click clarity and story runway held up against the other five candidates.`,
  };
}

export function validIdeation() {
  return {
    schema: WINNER_IDEATION_SCHEMA,
    channel: "53rebirth",
    formula_version: "test-formula-v1",
    development_slug: "winner-contract-test",
    candidates: PACKAGE_SEEDS.map(validCandidate),
  };
}

function candidateById(evaluation, id) {
  const candidate = evaluation.document.candidates.find((row) => row.id === id);
  assert.ok(candidate, `expected candidate ${id}`);
  return candidate;
}

export function scriptWithWordCount(target = 100) {
  const words = [
    "Joey", "Manhwa", "closed", "the", "door", "after", "his", "partner", "stole", "the",
    "contract", "and", "ordered", "the", "workers", "to", "forget", "who", "built", "everything",
  ];
  while (words.length < target) words.push(`progress${words.length}`);
  return `${words.slice(0, target).join(" ")}.`;
}

function validRelease(script, packageContract) {
  return {
    schema: WINNER_SOURCE_RELEASE_SCHEMA,
    status: "passed",
    channel: packageContract.channel,
    development_slug: packageContract.development_slug,
    selected_title: packageContract.selected_title,
    source_path: "/tmp/ingest_ready_source.md",
    source_script_sha256: sha256Text(normalizeWinnerNarration(script)),
    winner_package_sha256: sha256Text(JSON.stringify(packageContract)),
    winner_gate_sha256: "gate-hash",
    released_by: "operator",
    released_at: "2026-08-01T12:00:00.000Z",
  };
}

function validGate(scriptWordCount = 1000) {
  assert.equal(scriptWordCount, 1000, "the retention fixture positions are defined for one thousand words");
  const movementSpans = [
    [1, 125],
    [126, 250],
    [251, 375],
    [376, 500],
    [501, 625],
    [626, 750],
    [751, 875],
    [876, 1000],
  ];
  const checkpointSpans = {
    title_contradiction_30s: [1, 60],
    irreversible_boundary_minute_5: [300, 450],
    advantage_proof_minute_8: [550, 780],
    forward_objective_minute_10: [800, 900],
    scaling_pressure_and_adaptive_response: [600, 790],
    literal_title_payoff: [870, 920],
  };
  return {
    schema: WINNER_SCRIPT_GATE_SCHEMA,
    status: "PASS",
    gates: WINNER_GATE_IDS.map((id, index) => ({
      id,
      decision: "PASS",
      summary: `${id} is demonstrated through a choice and a changed result.`,
      evidence: [
        {
          word_start: 1 + index * 10,
          word_end: 10 + index * 10,
          note: `Opening evidence for ${id}.`,
        },
        {
          word_start: 700 + index * 10,
          word_end: 709 + index * 10,
          note: `Later payoff evidence for ${id}.`,
        },
      ],
      repair_actions: [],
    })),
    package_fidelity: {
      decision: "PASS",
      title_facts_literal: true,
      thumbnail_claims_literal: true,
      opening_promise_delivered: true,
      boundary_delivered: true,
      forward_engine_delivered: true,
      active_climax_delivered: true,
      antagonist_loss_delivered: true,
      concise_ending_delivered: true,
      evidence: [
        { word_start: 1, word_end: 60, note: "The opening makes the title contradiction visible." },
        { word_start: 870, word_end: 940, note: "The climax performs the literal reversal." },
      ],
    },
    retention_architecture: {
      decision: "PASS",
      weighted_score: 87,
      score_inputs: {
        opening_and_ten_minute_payoff_map: 9,
        clear_advantage_rule_and_scaling_path: 8,
        joey_agency_and_audience_trust: 9,
        causal_movement_runway: 9,
        conflict_variety_and_procedure_restraint: 8,
        intelligent_opposition_and_scaling_pressure: 9,
        active_title_native_climax: 9,
        concise_closure: 8,
      },
      checkpoints: WINNER_RETENTION_CHECKPOINT_IDS.map((id) => ({
        id,
        decision: "PASS",
        word_start: checkpointSpans[id][0],
        word_end: checkpointSpans[id][1],
        event: `${id} occurs as a literal story event.`,
        retention_function: `${id} changes the immediate question and creates forward pressure.`,
      })),
      movements: movementSpans.map(([wordStart, wordEnd], index) => ({
        id: `movement_${String(index + 1).padStart(2, "0")}`,
        word_start: wordStart,
        word_end: wordEnd,
        objective: `Joey pursues distinct objective ${index + 1}.`,
        pressure_or_question: `Pressure ${index + 1} can prevent that objective.`,
        joey_choice: `Joey makes consequential choice ${index + 1}.`,
        result: `The choice produces changed result ${index + 1}.`,
        state_changes: [
          `resource state changes in movement ${index + 1}`,
          `relationship state changes in movement ${index + 1}`,
        ],
        cause_into_next: index === movementSpans.length - 1
          ? "The result creates the final changed equilibrium."
          : `The result makes objective ${index + 2} necessary.`,
        unique_function: `Only this movement performs story function ${index + 1}.`,
        duplicate_of: null,
      })),
      scaling_pressure_word_start: 600,
      adaptive_response_word_start: 760,
      climax_word_start: 880,
      climax_start_percent: 88,
      resolution_word_start: 941,
      resolution_word_count: 60,
      resolution_script_percent: 6,
      retention_risks: [],
      summary: "Eight causal movements preserve forward pressure, pay off the title actively, and close once.",
    },
    hard_rejects: [],
    repairs: [],
    release_recommendation: "eligible_for_operator_release",
  };
}

export async function runWinnerSourceContractTests() {
  const formula = validFormula();
  assert.deepEqual(validateWinnerFormula(formula), { done: true, blockers: [] });

  const badFormula = structuredClone(formula);
  badFormula.score_dimensions.click_clarity.weight = 15;
  badFormula.evidence[1].id = badFormula.evidence[0].id;
  const badFormulaResult = validateWinnerFormula(badFormula);
  assert.equal(badFormulaResult.done, false);
  assert.ok(badFormulaResult.blockers.includes("formula_score_weights_must_total_100"));
  assert.ok(badFormulaResult.blockers.includes("formula_evidence_1_id_duplicate"));

  const baseline = evaluateWinnerIdeation(validIdeation(), formula);
  assert.equal(baseline.report.status, "passed");
  assert.equal(
    baseline.report.eligible_candidate_count,
    6,
    JSON.stringify(baseline.document.candidates.map((row) => ({ id: row.id, blockers: row.computed.blockers }))),
  );
  assert.equal(baseline.report.ranked_eligible_candidate_ids[0], "wife_sold_home");
  assert.equal(candidateById(baseline, "wife_sold_home").computed.weighted_score, 100);
  assert.equal(candidateById(baseline, "boss_stole_patent").computed.weighted_score, 90);
  assert.equal(baseline.report.reversal_engines.length, 6);
  assert.equal(baseline.report.document_warning_count, 0);
  assert.deepEqual(baseline.report.warnings, []);

  // Reversal engines are deliberately free-form. An unfamiliar but structurally
  // complete mechanic is valid without being assigned to a predefined family.
  const originalReversalEngine = validIdeation();
  originalReversalEngine.candidates[0].core_advantage.type = "sentient parking meter that trades regret for time";
  const originalReversalEngineCandidate = candidateById(
    evaluateWinnerIdeation(originalReversalEngine, formula),
    "wife_sold_home",
  );
  assert.equal(originalReversalEngineCandidate.computed.eligible, true);
  assert.deepEqual(originalReversalEngineCandidate.computed.blockers, []);

  const missingExecutionBridge = validIdeation();
  missingExecutionBridge.candidates[0].core_advantage.execution_bridge = "";
  const missingExecutionBridgeCandidate = candidateById(
    evaluateWinnerIdeation(missingExecutionBridge, formula),
    "wife_sold_home",
  );
  assert.equal(missingExecutionBridgeCandidate.computed.eligible, false);
  assert.ok(missingExecutionBridgeCandidate.computed.blockers.includes("core_advantage_execution_bridge_missing"));

  const incompleteFirstProof = validIdeation();
  incompleteFirstProof.candidates[0].core_advantage.decisive_applications[0].joey_tactic_and_action = "";
  const incompleteFirstProofCandidate = candidateById(
    evaluateWinnerIdeation(incompleteFirstProof, formula),
    "wife_sold_home",
  );
  assert.equal(incompleteFirstProofCandidate.computed.eligible, false);
  assert.ok(incompleteFirstProofCandidate.computed.blockers.includes(
    "core_advantage_decisive_application_0_joey_tactic_and_action_missing",
  ));

  const missingLateScaleProof = validIdeation();
  missingLateScaleProof.candidates[0].core_advantage.decisive_applications.pop();
  const missingLateScaleProofCandidate = candidateById(
    evaluateWinnerIdeation(missingLateScaleProof, formula),
    "wife_sold_home",
  );
  assert.equal(missingLateScaleProofCandidate.computed.eligible, false);
  assert.ok(missingLateScaleProofCandidate.computed.blockers.includes(
    "core_advantage_decisive_application_climax_or_late_scale_proof_missing",
  ));

  const missingBetrayal = validIdeation();
  missingBetrayal.candidates[4].title_contract.betrayal_action = "";
  const missingBetrayalCandidate = candidateById(
    evaluateWinnerIdeation(missingBetrayal, formula),
    "family_disowned_rival",
  );
  assert.equal(missingBetrayalCandidate.computed.eligible, false);
  assert.ok(missingBetrayalCandidate.computed.blockers.includes("title_contract_betrayal_action_missing"));

  const operatorRejected = evaluateWinnerIdeation(validIdeation(), formula, {
    rejectedCandidateIds: ["partner_framed_network"],
  });
  const operatorRejectedCandidate = candidateById(operatorRejected, "partner_framed_network");
  assert.equal(operatorRejectedCandidate.computed.eligible, false);
  assert.ok(operatorRejectedCandidate.computed.blockers.includes("candidate_operator_rejected"));

  const selectorOrdering = validIdeation();
  selectorOrdering.candidates[0].pairwise_rank = 2;
  selectorOrdering.candidates[0].pairwise_wins = 4;
  selectorOrdering.candidates[1].pairwise_rank = 1;
  selectorOrdering.candidates[1].pairwise_wins = 5;
  const selectorOrderingResult = evaluateWinnerIdeation(selectorOrdering, formula);
  assert.equal(selectorOrderingResult.report.ranked_eligible_candidate_ids[0], "brother_fired_hotel");

  const duplicatePairwiseRank = validIdeation();
  duplicatePairwiseRank.candidates[1].pairwise_rank = 1;
  const duplicatePairwiseCandidate = candidateById(
    evaluateWinnerIdeation(duplicatePairwiseRank, formula),
    "brother_fired_hotel",
  );
  assert.equal(duplicatePairwiseCandidate.computed.eligible, false);
  assert.ok(duplicatePairwiseCandidate.computed.blockers.includes("candidate_pairwise_rank_duplicate"));

  const invalidSelectorFields = validIdeation();
  invalidSelectorFields.candidates[2].pairwise_rank = 0;
  invalidSelectorFields.candidates[2].pairwise_wins = 6;
  invalidSelectorFields.candidates[2].selection_rationale = "";
  const invalidSelectorCandidate = candidateById(
    evaluateWinnerIdeation(invalidSelectorFields, formula),
    "boss_stole_patent",
  );
  assert.equal(invalidSelectorCandidate.computed.eligible, false);
  assert.ok(invalidSelectorCandidate.computed.blockers.includes("candidate_pairwise_rank_invalid"));
  assert.ok(invalidSelectorCandidate.computed.blockers.includes("candidate_pairwise_wins_invalid"));
  assert.ok(invalidSelectorCandidate.computed.blockers.includes("candidate_selection_rationale_missing"));

  // Scores inform ranking but do not overrule the operator. Low subjective
  // scores stay visible as warnings while structurally valid packages remain eligible.
  const presenceOnly = validIdeation();
  presenceOnly.candidates[5].score_inputs = Object.fromEntries(
    Object.keys(DIMENSION_POLICIES).map((id) => [id, 1]),
  );
  const presenceOnlyResult = evaluateWinnerIdeation(presenceOnly, formula);
  const presenceOnlyCandidate = candidateById(presenceOnlyResult, "partner_framed_network");
  assert.equal(presenceOnlyCandidate.computed.eligible, true);
  assert.ok(presenceOnlyCandidate.computed.warnings.includes("score_click_clarity_below_minimum"));
  assert.ok(presenceOnlyCandidate.computed.warnings.includes("candidate_total_score_below_minimum"));
  assert.deepEqual(presenceOnlyCandidate.computed.blockers, []);

  const badTitle = validIdeation();
  badTitle.candidates[0].title = "My Wife Betrayed Me | Manhwa Recap";
  const badTitleCandidate = candidateById(evaluateWinnerIdeation(badTitle, formula), "wife_sold_home");
  assert.equal(badTitleCandidate.computed.eligible, false);
  assert.ok(badTitleCandidate.computed.blockers.includes("title_betrayal_phrase_missing"));
  assert.ok(badTitleCandidate.computed.blockers.includes("title_reversal_phrase_missing"));

  const badThumbnail = validIdeation();
  badThumbnail.candidates[1].thumbnail.main_text = "MY BROTHER FIRED ME TODAY";
  badThumbnail.candidates[1].thumbnail.additive_fact = "";
  badThumbnail.candidates[1].hard_rejects = ["thumbnail_repeats_title"];
  const badThumbnailCandidate = candidateById(evaluateWinnerIdeation(badThumbnail, formula), "brother_fired_hotel");
  assert.equal(badThumbnailCandidate.computed.eligible, false);
  assert.ok(badThumbnailCandidate.computed.blockers.includes("thumbnail_main_text_word_count_invalid"));
  assert.ok(badThumbnailCandidate.computed.blockers.includes("thumbnail_additive_fact_missing"));
  assert.ok(badThumbnailCandidate.computed.blockers.includes("hard_reject_thumbnail_repeats_title"));

  const badEvidence = validIdeation();
  badEvidence.candidates[2].evidence_ids = ["own_death_goddess", "missing_evidence"];
  const badEvidenceCandidate = candidateById(evaluateWinnerIdeation(badEvidence, formula), "boss_stole_patent");
  assert.equal(badEvidenceCandidate.computed.eligible, false);
  assert.ok(badEvidenceCandidate.computed.blockers.includes("candidate_evidence_id_unknown"));
  assert.ok(badEvidenceCandidate.computed.blockers.includes("candidate_evidence_type_niche_outlier_missing"));

  const recentDuplicate = evaluateWinnerIdeation(validIdeation(), formula, {
    recentTitles: ["My Boss Stole My Patent, Then I Owned His Factory | Manhwa Recap"],
  });
  const duplicateCandidate = candidateById(recentDuplicate, "boss_stole_patent");
  assert.equal(duplicateCandidate.computed.eligible, false);
  assert.equal(duplicateCandidate.computed.nearest_recent_title_similarity, 1);
  assert.ok(duplicateCandidate.computed.blockers.includes("candidate_recent_title_near_duplicate"));

  const belowMinimum = validIdeation();
  for (let index = 0; index < 4; index += 1) {
    belowMinimum.candidates[index].score_inputs.click_clarity = 1;
  }
  const belowMinimumResult = evaluateWinnerIdeation(belowMinimum, formula);
  assert.equal(belowMinimumResult.report.status, "passed");
  assert.equal(belowMinimumResult.report.eligible_candidate_count, 6);
  assert.ok(belowMinimumResult.report.candidate_warning_count > 0);
  assert.deepEqual(belowMinimumResult.report.blockers, []);

  const selectedIdeation = baseline.document;
  const formulaSha256 = sha256Text(JSON.stringify(formula));
  const ideationSha256 = sha256Text(JSON.stringify(selectedIdeation));
  const { contract, approval } = buildWinnerPackageContract({
    ideation: selectedIdeation,
    ideationPath: "/tmp/winner_ideation_candidates.json",
    ideationSha256,
    formula,
    formulaPath: "/tmp/winner_formula.json",
    formulaSha256,
    candidateId: "wife_sold_home",
    approvedBy: "operator",
    approvedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(contract.schema, WINNER_PACKAGE_CONTRACT_SCHEMA);
  assert.equal(contract.status, "approved");
  assert.equal(contract.core_advantage.type, "one-dollar property system");
  const expectedMinimumWords = Math.round(
    formula.candidate_policy.target_runtime_min_minutes * formula.candidate_policy.target_spoken_wpm,
  );
  const expectedMaximumWords = Math.round(
    formula.candidate_policy.target_runtime_max_minutes * formula.candidate_policy.target_spoken_wpm,
  );
  assert.equal(contract.target_word_range.minimum, expectedMinimumWords);
  assert.equal(contract.target_word_range.maximum, expectedMaximumWords);
  assert.deepEqual(validateWinnerPackageContract(contract), { done: true, blockers: [] });
  assert.equal(approval.schema, WINNER_PACKAGE_APPROVAL_SCHEMA);
  assert.equal(approval.selected_candidate_id, "wife_sold_home");
  assert.throws(
    () => buildWinnerPackageContract({
      ideation: selectedIdeation,
      formula,
      candidateId: "does_not_exist",
      approvedBy: "operator",
    }),
    /Unknown winner candidate/,
  );

  const invalidPackage = structuredClone(contract);
  invalidPackage.approved_by = "";
  invalidPackage.thumbnail_contract = null;
  const invalidPackageResult = validateWinnerPackageContract(invalidPackage);
  assert.equal(invalidPackageResult.done, false);
  assert.ok(invalidPackageResult.blockers.includes("winner_package_approved_by_missing"));
  assert.ok(invalidPackageResult.blockers.includes("winner_package_thumbnail_contract_missing"));

  const script = scriptWithWordCount(1000);
  assert.equal(countWords(script), 1000);
  const scriptReview = deterministicWinnerScriptReview(script, contract);
  assert.equal(scriptReview.status, "passed");
  assert.equal(scriptReview.source_word_count, 1000);
  assert.deepEqual(scriptReview.blockers, []);
  assert.deepEqual(scriptReview.warnings, []);
  assert.equal(scriptReview.source_script_sha256, sha256Text(normalizeWinnerNarration(script)));

  const malformedScript = [
    "# Chapter One",
    "- In this script the narrator wants you to understand the plan.",
    scriptWithWordCount(820),
  ].join("\n");
  const malformedReview = deterministicWinnerScriptReview(malformedScript, contract);
  assert.equal(malformedReview.status, "passed");
  assert.deepEqual(malformedReview.blockers, []);
  assert.ok(malformedReview.warnings.some((warning) => warning.startsWith("script_word_count_below_target_")));
  assert.ok(malformedReview.warnings.includes("script_contains_markdown_heading"));
  assert.ok(malformedReview.warnings.includes("script_contains_markdown_list"));
  assert.ok(malformedReview.warnings.includes("script_contains_meta_narration"));

  const truncatedScript = scriptWithWordCount(600);
  const truncatedReview = deterministicWinnerScriptReview(truncatedScript, contract);
  const probableTruncationFloor = Math.max(500, Math.round(expectedMinimumWords * 0.7));
  assert.equal(truncatedReview.status, "blocked");
  assert.ok(truncatedReview.blockers.includes(
    `script_probably_truncated_${countWords(truncatedScript)}_below_${probableTruncationFloor}`,
  ));

  const gateOptions = {
    scriptWordCount: 1000,
    formula,
    intendedSpokenWpm: 100,
  };
  const passingGate = validGate();
  assert.deepEqual(
    validateWinnerScriptGate(passingGate, gateOptions),
    { done: true, blockers: [], expected_status: "PASS" },
  );

  const thinSixGateEvidence = validGate();
  thinSixGateEvidence.gates[0].evidence = [];
  const thinSixGateResult = validateWinnerScriptGate(thinSixGateEvidence, gateOptions);
  assert.equal(thinSixGateResult.done, false);
  assert.ok(thinSixGateResult.blockers.includes("winner_gate_joey_competence_and_learning_evidence_too_thin"));

  const mismatchedGateDecision = validGate();
  mismatchedGateDecision.gates[1].decision = "REPAIR";
  mismatchedGateDecision.gates[1].repair_actions = ["Clarify the causal bridge."];
  const mismatchedGateDecisionResult = validateWinnerScriptGate(mismatchedGateDecision, gateOptions);
  assert.equal(mismatchedGateDecisionResult.done, false);
  assert.equal(mismatchedGateDecisionResult.expected_status, "REPAIR");
  assert.ok(mismatchedGateDecisionResult.blockers.includes("winner_gate_status_must_equal_REPAIR"));

  const repeatedMovement = validGate();
  repeatedMovement.retention_architecture.movements[4].duplicate_of = "movement_03";
  const repeatedMovementResult = validateWinnerScriptGate(repeatedMovement, gateOptions);
  assert.equal(repeatedMovementResult.done, false);
  assert.ok(repeatedMovementResult.blockers.includes("winner_gate_retention_movement_4_duplicate"));

  const lateCheckpoint = validGate();
  lateCheckpoint.retention_architecture.checkpoints.find(
    (row) => row.id === "title_contradiction_30s",
  ).word_end = 66;
  const lateCheckpointResult = validateWinnerScriptGate(lateCheckpoint, gateOptions);
  assert.equal(lateCheckpointResult.done, false);
  assert.ok(lateCheckpointResult.blockers.includes("winner_gate_retention_checkpoint_title_contradiction_30s_late"));

  const lowRetentionScore = validGate();
  lowRetentionScore.retention_architecture.score_inputs = Object.fromEntries(
    Object.keys(formula.retention_architecture.score_dimensions).map((id) => [id, 6]),
  );
  lowRetentionScore.retention_architecture.weighted_score = 60;
  const lowRetentionScoreResult = validateWinnerScriptGate(lowRetentionScore, gateOptions);
  assert.equal(lowRetentionScoreResult.done, false);
  assert.ok(lowRetentionScoreResult.blockers.includes("winner_gate_retention_score_opening_and_ten_minute_payoff_map_below_minimum"));
  assert.ok(lowRetentionScoreResult.blockers.includes("winner_gate_retention_weighted_score_below_minimum"));

  const coverageGap = validGate();
  coverageGap.retention_architecture.movements[1].word_start = 127;
  const coverageGapResult = validateWinnerScriptGate(coverageGap, gateOptions);
  assert.equal(coverageGapResult.done, false);
  assert.ok(coverageGapResult.blockers.includes("winner_gate_retention_movement_1_coverage_gap_or_overlap"));

  const fatalRetentionRisk = validGate();
  fatalRetentionRisk.retention_architecture.retention_risks = [{
    severity: "fatal",
    code: "repeated_procedure",
    note: "Three movements repeat the same procedural proof without a changed objective.",
  }];
  const fatalRetentionRiskResult = validateWinnerScriptGate(fatalRetentionRisk, gateOptions);
  assert.equal(fatalRetentionRiskResult.done, false);
  assert.ok(fatalRetentionRiskResult.blockers.includes("winner_gate_retention_pass_has_fatal_risk"));

  const overlongEnding = validGate();
  overlongEnding.retention_architecture.resolution_word_start = 900;
  overlongEnding.retention_architecture.resolution_word_count = 101;
  overlongEnding.retention_architecture.resolution_script_percent = 10.1;
  const overlongEndingResult = validateWinnerScriptGate(overlongEnding, gateOptions);
  assert.equal(overlongEndingResult.done, false);
  assert.ok(overlongEndingResult.blockers.includes("winner_gate_retention_resolution_too_long"));

  const release = validRelease(script, contract);
  assert.deepEqual(
    validateWinnerSourceRelease(release, { sourceText: script, packageContract: contract }),
    { done: true, blockers: [] },
  );
  const invalidRelease = {
    ...release,
    selected_title: "A Different Unapproved Title | Manhwa Recap",
    source_script_sha256: "wrong-source-hash",
  };
  const invalidReleaseResult = validateWinnerSourceRelease(invalidRelease, {
    sourceText: script,
    packageContract: contract,
  });
  assert.equal(invalidReleaseResult.done, false);
  assert.ok(invalidReleaseResult.blockers.includes("winner_release_source_hash_mismatch"));
  assert.ok(invalidReleaseResult.blockers.includes("winner_release_title_mismatch"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runWinnerSourceContractTests();
  console.log("winner source contract tests passed");
}
