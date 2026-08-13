import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WINNER_BLUEPRINT_OPENING_CHECKPOINT_IDS,
  WINNER_EVIDENCE_SNAPSHOT_SCHEMA,
  WINNER_FORMULA_SCHEMA,
  WINNER_GATE_IDS,
  WINNER_IDEATION_SCHEMA,
  WINNER_PACKAGE_APPROVAL_SCHEMA,
  WINNER_PACKAGE_CONTRACT_SCHEMA,
  WINNER_RETENTION_CHECKPOINT_IDS,
  WINNER_SCRIPT_GATE_SCHEMA,
  WINNER_STORY_BLUEPRINT_APPROVAL_SCHEMA,
  WINNER_STORY_BLUEPRINT_SCHEMA,
  WINNER_SOURCE_RELEASE_SCHEMA,
  WINNER_SOURCE_ROOM_PROFILE,
  buildWinnerPackageContract,
  countWords,
  deterministicWinnerScriptReview,
  evaluateWinnerIdeation,
  extractJsonObject,
  normalizeWinnerNarration,
  sha256Text,
  validateSourceEvidenceSnapshot,
  validateWinnerFormula,
  validateWinnerPackageContract,
  validateWinnerScriptGate,
  validateWinnerStoryBlueprint,
  validateWinnerStoryBlueprintApproval,
  validateWinnerSourceRelease,
} from "../lib/winner-source-contract.mjs";
import {
  WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION,
  WINNER_BLUEPRINT_AUDIENCE_AUDIT_DIMENSION_IDS,
  WINNER_BLUEPRINT_AUDIENCE_AUDIT_SCHEMA,
  WINNER_DEVELOPMENT_DIAGNOSTIC_SCHEMA,
  WINNER_DIAGNOSTIC_PASS_IDS,
  WINNER_OPENING_APPROVAL_SCHEMA,
  WINNER_OPENING_DELIVERY_CONTRACT_VERSION,
  WINNER_RETENTION_MAP_SCHEMA,
  WINNER_REVISION_REPORT_SCHEMA,
  WINNER_STORY_BLUEPRINT_V2_SCHEMA,
  assembleWinnerScriptWithApprovedOpening,
  reviewWinnerOpening,
  validateWinnerBlueprintAudienceAudit,
  validateWinnerDevelopmentDiagnostic,
  validateWinnerOpeningApproval,
  validateWinnerRetentionMap,
  validateWinnerRevisionReport,
  validateWinnerStoryBlueprintV2,
} from "../lib/winner-source-room-contract.mjs";

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
    dramatic_contract: {
      emotional_promise: "Joey learns that being useful is not the same as being loved or respected.",
      central_relationship_question: "Will Joey trust the workers who value him after the person closest to him weaponized that trust?",
      joey_wound_or_misbelief: "Joey believes he must keep solving everyone else's problems to deserve a place beside them.",
      antagonist_human_logic: "The betrayer believes control is security and treats Joey's competence as a resource that cannot leave.",
      supporting_character_agency: "A veteran line supervisor risks her job, supplies operational evidence, and forces Joey to replace a reckless promise with a safe plan.",
      midpoint_human_transformation: "Joey stops building only to prove his value and accepts responsibility for people who chose him freely.",
      warmth_or_relief_source: "Quiet late-night meals with the rebuilt crew reveal trust growing through useful gestures.",
      recurring_emotional_object: "A dented factory key moves from a symbol of exclusion to a freely offered sign of belonging.",
      procedural_risk: "Contracts and production mechanics could dominate, so the story compresses them around loyalty tests and public choices.",
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
    source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
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

export function validEvidenceSnapshot() {
  return {
    schema: WINNER_EVIDENCE_SNAPSHOT_SCHEMA,
    status: "active",
    channel: "53rebirth",
    channel_name: "Manhwa Joey",
    version: "test-evidence-v1",
    observed_through: "2026-08-03",
    source_paths: ["/tmp/market.json", "/tmp/own.json"],
    research_scope: { primary_english_timed_transcripts: 33 },
    market_opening_modes: [
      { id: "visible_proof_or_payoff" },
      { id: "wound_or_identity_contradiction" },
      { id: "direct_premise_or_mechanic" },
    ],
    own_channel_evidence: [{ id: "one" }, { id: "two" }, { id: "three" }],
    own_channel_negative_evidence: [{ id: "miss" }],
    decision_policy: { selection_rule: "Keep click and watch hypotheses separate." },
  };
}

export function validBlueprint() {
  const movements = Array.from({ length: 8 }, (_, index) => ({
    id: `movement_${String(index + 1).padStart(2, "0")}`,
    target_words: 125,
    start_state: `State entering movement ${index + 1}.`,
    objective: `Objective ${index + 1}.`,
    obstacle: `Obstacle ${index + 1}.`,
    joey_choice: `Joey chooses tactic ${index + 1}.`,
    concrete_execution: `Joey executes tactic ${index + 1} with established capability.`,
    opposition_response: `The opposition makes response ${index + 1}.`,
    result: `Movement ${index + 1} creates a concrete result.`,
    state_changes: [`Status changes in movement ${index + 1}.`, `The next objective changes in movement ${index + 1}.`],
    cause_into_next: index === 7 ? "This result causes the final boundary." : `This result creates movement ${index + 2}.`,
    unique_function: `Unique causal function ${index + 1}.`,
    location_or_arena: `Arena ${index + 1}.`,
    package_payoff_role: index === 0 ? "opening proof" : index === 7 ? "resolution" : "expansion",
  }));
  return {
    schema: WINNER_STORY_BLUEPRINT_SCHEMA,
    status: "planned",
    channel: "53rebirth",
    development_slug: "winner-contract-test",
    selected_candidate_id: "wife_sold_home",
    selected_title: "My Wife Sold My Home, Then I Bought Her Company | Manhwa Recap",
    winner_package_sha256: "package-hash",
    planned_at: "2026-08-09T12:00:00.000Z",
    narration_contract: {
      pov: "third_person",
      tense: "present",
      voice: "Fast, causal spoken recap narration.",
      dialogue_policy: "Keep decisive lines direct and compress routine exchanges.",
      choice_reason: "Third-person present matches the market default and keeps the long story stable.",
    },
    opening_contract: {
      mode: "wound_or_identity_contradiction",
      rewind_policy: "linear",
      checkpoints: WINNER_BLUEPRINT_OPENING_CHECKPOINT_IDS.map((id, index) => ({
        id,
        target_word_end: [50, 100, 150, 300, 500][index],
        visible_event: `Visible opening event ${index + 1}.`,
        consequence_or_state_change: `Opening state change ${index + 1}.`,
        viewer_question: `Opening question ${index + 1}?`,
      })),
    },
    canon: {
      protagonist: {
        name: "Joey Manhwa",
        initial_condition: "Joey has lost his home.",
        core_desire: "He wants control of his future.",
        final_condition: "He owns the company and controls access to his life.",
      },
      recurring_characters: [],
      advantage_rules: ["The approved engine creates one-dollar property purchases."],
      execution_bridges: ["Joey uses established legal ownership and operating allies."],
      recurring_locations: [],
      critical_props_or_ui: [],
      immutable_facts: ["Joey's wife sells the home.", "Joey buys her company.", "Joey refuses reconciliation."],
    },
    movements,
    climax_contract: {
      setup_paid_off: ["Joey's ownership proof.", "The workers' operating support."],
      joey_decisive_action: "Joey actively takes control of the company.",
      antagonist_response: "His wife tries to preserve her authority.",
      visible_result: "The staff and building answer to Joey.",
      antagonist_concrete_loss: "She loses the company and access to Joey's home.",
    },
    ending_contract: {
      final_boundary: "Joey refuses to restore the marriage.",
      changed_equilibrium: "Joey controls his company and home.",
      stop_point: "The door closes after his final refusal.",
    },
    continuity_watchlist: ["POV stays third person.", "The home sale remains literal.", "The one-dollar rule never changes."],
    repetition_watchlist: ["Do not repeat the eviction.", "Do not repeat the same company proof."],
    section_plan: [
      { id: "section_01", movement_ids: ["movement_01", "movement_02"], entry_state: "Joey is betrayed.", exit_state: "The engine is proven." },
      { id: "section_02", movement_ids: ["movement_03", "movement_04"], entry_state: "Joey has leverage.", exit_state: "The antagonist adapts." },
      { id: "section_03", movement_ids: ["movement_05", "movement_06"], entry_state: "The conflict expands.", exit_state: "The climax is ready." },
      { id: "section_04", movement_ids: ["movement_07", "movement_08"], entry_state: "Joey enters the climax.", exit_state: "The title promise is complete." },
    ],
  };
}

export function validBlueprintV2({ packageSha256 = "package-hash", audienceFeedback = true } = {}) {
  const movements = Array.from({ length: 4 }, (_, index) => ({
    id: `movement_${String(index + 1).padStart(2, "0")}`,
    ...(audienceFeedback ? { movement_kind: "dramatic" } : {}),
    target_words: 250,
    start_state: `State entering dramatic movement ${index + 1}.`,
    entry_question: `What choice will change movement ${index + 1}?`,
    external_objective: `Joey pursues concrete objective ${index + 1}.`,
    emotional_objective: `Joey wants a changed answer from relationship ${index + 1}.`,
    obstacle: `A person with understandable motives resists objective ${index + 1}.`,
    joey_choice: `Joey makes consequential choice ${index + 1}.`,
    visible_execution: `Joey and an established ally visibly execute choice ${index + 1}.`,
    opposition_response: `The opposition responds from known evidence in movement ${index + 1}.`,
    relationship_turn: `Trust, loyalty, or obligation changes in movement ${index + 1}.`,
    reveal_or_reversal: `Movement ${index + 1} reveals a new truth or reverses leverage.`,
    result: `Movement ${index + 1} creates a concrete result.`,
    irreversible_state_changes: [
      `External state changes in movement ${index + 1}.`,
      `Relationship state changes in movement ${index + 1}.`,
    ],
    ...(audienceFeedback ? {
      evidence_or_information_received: [`Joey receives decisive evidence ${index + 1}.`],
      behavior_or_strategy_updates: [`Joey visibly updates strategy ${index + 1}.`],
      stakes_relevance: `Movement ${index + 1} changes the established conflict and available choices.`,
    } : {}),
    answer_delivered: `The entering question for movement ${index + 1} receives an answer.`,
    next_question: index === 3 ? "Will Joey preserve his final boundary?" : `What will movement ${index + 2} cost emotionally?`,
    cause_into_next: index === 3 ? "The result creates the final changed equilibrium." : `The result makes movement ${index + 2} necessary.`,
    conflict_mode: ["public humiliation", "intimate alliance", "mystery and temptation", "public proof and refusal"][index],
    emotional_mode: ["shame", "cautious hope", "dread and trust", "triumph and grief"][index],
    location_or_arena: `Distinct arena ${index + 1}.`,
    unique_function: `Only movement ${index + 1} performs this causal and emotional function.`,
    setup_or_payoff_ids: [`setup_payoff_${String(index + 1).padStart(2, "0")}`],
  }));
  return {
    schema: WINNER_STORY_BLUEPRINT_V2_SCHEMA,
    status: "planned",
    source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
    ...(audienceFeedback ? {
      audience_feedback_contract_version: WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION,
    } : {}),
    channel: "53rebirth",
    development_slug: "winner-contract-test",
    selected_candidate_id: "wife_sold_home",
    selected_title: "My Wife Sold My Home, Then I Bought Her Company | Manhwa Recap",
    winner_package_sha256: packageSha256,
    planned_at: "2026-08-09T12:00:00.000Z",
    retention_north_star: {
      metric: "average_percentage_viewed",
      target_percent: 50,
      contract: "upload_measurement_target_not_model_prediction",
    },
    narration_contract: {
      pov: "third_person",
      tense: "present",
      voice: "Natural connected recap narration with emotional perception.",
      dialogue_policy: "Keep relationship-changing lines direct and compress routine exchanges.",
      choice_reason: "Third-person present keeps the long causal story stable and visually immediate.",
      cadence_contract: "Connected causal sentences carry action and response; short lines are reserved for earned impact.",
    },
    opening_delivery_contract_version: WINNER_OPENING_DELIVERY_CONTRACT_VERSION,
    opening_delivery_contract: {
      mode: "outcome_choice_rewind",
      package_fit_reason: "The later ownership reversal is simpler than explaining the legal engine before the betrayal lands.",
      cold_open_outcome_image: "Diana is locked outside the factory while Joey holds the ownership key.",
      cold_open_decisive_choice: "Joey closes the factory door instead of rescuing Diana.",
      rewind_entry: "Six months earlier, Joey still believed solving Diana's problems would save their marriage.",
      rewind_non_repetition_contract: "The rewind reveals the home sale and Joey's old behavior without replaying the factory refusal.",
      first_30_second_language_budget: {
        new_proper_names_maximum: 1,
        unexplained_story_terms_maximum: 2,
        rule: "Use ordinary physical nouns and one human choice before explaining the engine.",
      },
      title_truth_by_30_seconds: "Diana's betrayal and Joey's future control are both concrete.",
      forward_pressure_by_60_seconds: "The rewind enters the signed home sale and Joey begins preserving proof.",
      choice_or_power_proof_by_90_seconds: "Joey refuses reconciliation and verifies the first one-dollar purchase.",
      first_loop_by_180_seconds: "Joey uses the purchase, Diana responds, and ownership visibly changes.",
    },
    dramatic_engine: {
      emotional_promise: "Joey learns that usefulness is not love and finds belonging without submission.",
      joey_outer_goal: "Rebuild the operation and take control from the person who exploited him.",
      joey_inner_need: "Accept that he can set a boundary without proving his worth through endless rescue.",
      central_relationship_question: "Can Joey trust the crew that chose him after his wife weaponized his loyalty?",
      antagonist_human_logic: "His wife treats control as safety and believes Joey's competence belongs to the life she designed.",
      private_public_contrast: "Publicly Joey looks disposable while privately everyone relies on his hidden work.",
      premise_native_expansion: "The home betrayal expands into rebuilding a workplace and choosing what kind of leader Joey will become.",
      midpoint_transformation: "Joey stops building for revenge alone and accepts responsibility for a team that trusts him.",
      warmth_or_relief_source: "Late meals and quiet repairs with the crew build trust through useful gestures.",
      recurring_emotional_object: "A dented factory key changes from exclusion to freely offered belonging.",
    },
    ...(audienceFeedback ? {
      audience_trust_contract: {
        initial_wound_behavior: "Joey tries to rescue the marriage by solving Diana's crisis before he has proof of the sale.",
        decisive_evidence: "The signed sale notice proves Diana deliberately sold his home and erased his ownership.",
        evidence_movement_id: "movement_01",
        required_behavior_update: "Joey stops bargaining for affection, preserves evidence, and negotiates only for control and safety.",
        behavior_update_movement_id: "movement_01",
        irreversible_boundary: "Joey refuses to restore the marriage or resume unpaid rescue work.",
        boundary_movement_id: "movement_04",
        forbidden_casual_relapse: "Joey cannot return to serving Diana for approval after reading the signed sale notice.",
        strategic_contact_rule: "Joey speaks with Diana only to secure evidence, protect the crew, or answer a new counterattack.",
        system_leverage: "The engine identifies legally available one-dollar property purchases and confirms eligibility.",
        joey_owned_decision: "Joey chooses to use that leverage to protect the crew and purchase Diana's company rather than chase reconciliation.",
        supporting_character_ceiling: "Mira can supply evidence and mobilize workers, but Joey sets the goal, boundary, and final acquisition tactic.",
      },
    } : {}),
    canon: {
      protagonist: {
        name: "Joey Manhwa",
        initial_condition: "Joey has lost his home and mistakes usefulness for belonging.",
        core_desire: "He wants control of his future and proof that his work mattered.",
        misbelief_or_wound: "He believes he must solve other people's crises to deserve loyalty.",
        final_condition: "He controls the company, trusts chosen allies, and refuses coerced belonging.",
      },
      recurring_characters: [
        {
          id: "wife_antagonist",
          name: "Diana",
          role: "wife and primary antagonist",
          desire: "Preserve the life and authority she built around Joey's labor.",
          fear: "Being exposed as dependent and losing public control.",
          contradiction: "She wants Joey close but treats closeness as ownership.",
          relationship_to_joey: "She assumes his loyalty is permanent.",
          relationship_arc: "Her attempts to reclaim control force Joey to make his final boundary public.",
          practical_story_function: "She controls the old company and can credibly counter Joey's expansion.",
        },
        {
          id: "line_supervisor",
          name: "Mira",
          role: "veteran line supervisor and active ally",
          desire: "Keep the workers safe without surrendering their future.",
          fear: "Trusting another leader who treats the crew as tools.",
          contradiction: "She doubts Joey while repeatedly giving him the truth he needs.",
          relationship_to_joey: "She respects his skill but distrusts his need to rescue everyone.",
          relationship_arc: "Mutual tests become chosen trust and shared responsibility.",
          practical_story_function: "She supplies operational evidence and can mobilize the crew.",
        },
      ],
      advantage_rules: ["The approved engine creates one-dollar property purchases after Joey verifies legal availability."],
      execution_bridges: ["Joey combines legal ownership, operating knowledge, worker testimony, and recruited specialists."],
      recurring_locations: [{ id: "old_factory", name: "the old factory", story_function: "The public status arena changes owners and meaning." }],
      critical_props_or_ui: [{ id: "dented_key", name: "dented factory key", story_function: "It proves exclusion, access, and chosen trust." }],
      immutable_facts: [
        "Diana sells Joey's home.",
        "Joey's one-dollar engine follows the approved rule.",
        "Mira materially changes Joey's plan.",
        "Joey buys Diana's company.",
        "Joey refuses reconciliation.",
      ],
    },
    movements,
    ...(audienceFeedback ? {
      title_payment_ledger: [
        {
          id: "title_payment_home_sale",
          promise: "Diana literally sells Joey's home.",
          first_progress_movement_id: "movement_01",
          literal_payment_movement_id: "movement_01",
          visible_proof: "Joey reads and preserves the signed sale notice.",
          failure_if_missing: "The title's betrayal would become metaphorical rather than literal.",
        },
        {
          id: "title_payment_company_purchase",
          promise: "Joey literally buys Diana's company.",
          first_progress_movement_id: "movement_02",
          literal_payment_movement_id: "movement_04",
          visible_proof: "The ownership record, factory access, and staff answer to Joey's chosen team.",
          failure_if_missing: "The title's reversal would be delayed or replaced by a smaller victory.",
        },
      ],
      continuity_state_ledger: [
        {
          id: "state_dented_key",
          entity: "dented factory key",
          category: "prop",
          initial_state: "Diana takes the key from Joey.",
          changes: [{ movement_id: "movement_04", new_state: "Mira returns the key to Joey freely.", cause: "The crew chooses Joey after the public proof." }],
        },
        {
          id: "state_home_sale_knowledge",
          entity: "Joey's knowledge of the home sale",
          category: "knowledge",
          initial_state: "Joey suspects a betrayal but lacks proof.",
          changes: [{ movement_id: "movement_01", new_state: "Joey knows Diana deliberately sold the home.", cause: "He reads the signed sale notice." }],
        },
        {
          id: "state_joey_diana_relationship",
          entity: "Joey and Diana's marriage",
          category: "relationship",
          initial_state: "Joey still mistakes rescue work for loyalty.",
          changes: [
            { movement_id: "movement_01", new_state: "Joey stops seeking reconciliation.", cause: "The sale notice makes the betrayal undeniable." },
            { movement_id: "movement_04", new_state: "Joey publicly refuses to restore the marriage.", cause: "He chooses the crew and his final boundary." },
          ],
        },
      ],
    } : {}),
    setup_payoff_ledger: [
      { id: "setup_payoff_01", setup_movement_id: "movement_01", payoff_movement_id: "movement_04", setup: "Diana takes Joey's factory key.", payoff: "Mira returns the key freely after the crew chooses Joey." },
      { id: "setup_payoff_02", setup_movement_id: "movement_01", payoff_movement_id: "movement_03", setup: "Joey preserves the sale notice.", payoff: "The notice proves the ownership chain during Diana's counterattack." },
      { id: "setup_payoff_03", setup_movement_id: "movement_02", payoff_movement_id: "movement_04", setup: "Mira forces Joey to document a safe restart.", payoff: "That discipline wins the public acceptance test." },
      { id: "setup_payoff_04", setup_movement_id: "movement_02", payoff_movement_id: "movement_03", setup: "Joey promises not to gamble with the crew's jobs.", payoff: "He rejects a tempting shortcut that would break that promise." },
    ],
    climax_contract: {
      setup_paid_off: ["The dented key.", "The sale notice.", "The documented safe restart."],
      joey_decisive_action: "Joey uses the seeded evidence and team plan to take control in public.",
      antagonist_response: "Diana uses her remaining authority and their private history to pressure him.",
      visible_result: "The factory, staff, and ownership record answer to Joey's chosen team.",
      antagonist_concrete_loss: "Diana loses the company, access to Joey's home, and control of the public story.",
      relationship_payoff: "Joey accepts Mira's returned key because it is offered without a debt.",
    },
    ending_contract: {
      final_boundary: "Joey refuses to restore the marriage or his old unpaid role.",
      changed_equilibrium: "Joey and the crew operate the company under shared, documented responsibility.",
      emotional_afterimage: "Mira places the dented key in Joey's open palm and closes no fingers around it.",
      stop_point: "The factory starts while Joey chooses to keep the key.",
    },
    continuity_watchlist: ["Third-person present remains stable.", "The home sale stays literal.", "The engine rule never changes.", "Mira retains her own agency.", "The dented key follows its setup-payoff path."],
    repetition_watchlist: ["Do not repeat the eviction.", "Do not repeat a restart proof.", "Do not repeat crowd shock.", "Do not repeat Diana asking for loyalty."],
    procedural_compression_watchlist: ["Compress property filings into one causal bridge.", "Compress routine financing and meetings around human decisions."],
    section_plan: [
      { id: "section_01", movement_ids: ["movement_01", "movement_02"], entry_state: "Joey is publicly discarded.", exit_state: "Joey and Mira have tested a first alliance.", emotional_progress: "Shame becomes cautious trust.", retention_function: "The title wound becomes an active new objective and first proof." },
      { id: "section_02", movement_ids: ["movement_03"], entry_state: "Joey has a team and leverage.", exit_state: "He chooses responsibility over a shortcut.", emotional_progress: "Revenge becomes responsibility.", retention_function: "The midpoint transforms Joey's reason for winning." },
      { id: "section_03", movement_ids: ["movement_04"], entry_state: "All seeded conflicts converge publicly.", exit_state: "The title and relationship promises are paid.", emotional_progress: "Chosen trust replaces coerced loyalty.", retention_function: "The climax uses earlier choices and stops on one emotional image." },
    ],
  };
}

export function validRetentionMap({ blueprint = validBlueprintV2(), packageSha256 = "package-hash" } = {}) {
  const openingEnds = [50, 100, 150, 300, 500];
  const openingIds = ["0_30_seconds", "30_60_seconds", "60_90_seconds", "90_180_seconds", "180_300_seconds"];
  return {
    schema: WINNER_RETENTION_MAP_SCHEMA,
    status: "planned",
    source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
    ...(blueprint.audience_feedback_contract_version ? {
      audience_feedback_contract_version: blueprint.audience_feedback_contract_version,
    } : {}),
    channel: blueprint.channel,
    development_slug: blueprint.development_slug,
    selected_candidate_id: blueprint.selected_candidate_id,
    winner_package_sha256: packageSha256,
    winner_story_blueprint_sha256: sha256Text(`${JSON.stringify(blueprint, null, 2)}\n`),
    planned_at: "2026-08-09T12:10:00.000Z",
    retention_north_star: {
      metric: "average_percentage_viewed",
      target_percent: 50,
      contract: "upload_measurement_target_not_model_prediction",
    },
    opening_windows: openingIds.map((id, index) => ({
      id,
      target_word_end: openingEnds[index],
      visible_event: `Opening event ${index + 1} changes the live situation.`,
      promise_progress: `Title promise progress ${index + 1}.`,
      proof_or_change: `A concrete fact becomes true in window ${index + 1}.`,
      emotional_turn: `The relationship changes emotionally in window ${index + 1}.`,
      viewer_question_out: `What choice follows opening window ${index + 1}?`,
      ...(blueprint.audience_feedback_contract_version ? {
        viewer_question_id_out: ["question_01", "question_01", "question_02", "question_02", "question_03"][index],
      } : {}),
    })),
    longform_checkpoints: [
      ["ten_percent", "movement_01"],
      ["twenty_five_percent", "movement_02"],
      ["midpoint", "movement_03"],
      ["seventy_five_percent", "movement_03"],
      ["climax_entry", "movement_04"],
      ["ending_payoff", "movement_04"],
    ].map(([id, movementId]) => ({
      id,
      movement_id: movementId,
      payoff_or_change: `${id} delivers a concrete answer or transformation.`,
      relationship_change: `${id} changes trust, loyalty, or obligation.`,
      freshness_source: `${id} changes arena, objective, or emotional mode.`,
      viewer_question_out: `${id} creates the next natural question or closes it at the ending.`,
      ...(blueprint.audience_feedback_contract_version ? {
        viewer_question_id_out: {
          movement_01: "question_01",
          movement_02: "question_02",
          movement_03: "question_03",
          movement_04: "question_04",
        }[movementId],
      } : {}),
    })),
    movement_directives: blueprint.movements.map((movement, movementIndex) => ({
      movement_id: movement.id,
      ...(blueprint.audience_feedback_contract_version ? {
        entry_question_id: `question_${String(movementIndex + 1).padStart(2, "0")}`,
      } : {}),
      entry_hook: movement.entry_question,
      promise_progress: movement.answer_delivered,
      contrast_from_previous: `The conflict and emotion of ${movement.id} differ from the prior movement.`,
      compression_target: `Compress routine logistics inside ${movement.id}.`,
      turns: [1, 2].map((number) => ({
        id: `${movement.id}_turn_${String(number).padStart(2, "0")}`,
        target_words: 125,
        trigger: `Trigger ${number} for ${movement.id}.`,
        visible_event: `Visible event ${number} for ${movement.id}.`,
        character_choice: `Character choice ${number} for ${movement.id}.`,
        emotional_turn: `Emotional turn ${number} for ${movement.id}.`,
        information_or_state_change: `State change ${number} for ${movement.id}.`,
        viewer_question_after: `Question after turn ${number} of ${movement.id}?`,
        ...(blueprint.audience_feedback_contract_version ? {
          viewer_question_id_after: `question_${String(Math.min(4, movementIndex + (number === 1 ? 1 : 2))).padStart(2, "0")}`,
        } : {}),
      })),
      rehook_out: movement.next_question,
      ...(blueprint.audience_feedback_contract_version ? {
        rehook_out_question_id: `question_${String(Math.min(4, movementIndex + 2)).padStart(2, "0")}`,
      } : {}),
    })),
    ...(blueprint.audience_feedback_contract_version ? {
      question_payment_ledger: blueprint.movements.map((movement, index) => ({
        id: `question_${String(index + 1).padStart(2, "0")}`,
        question: movement.entry_question,
        opened_in_movement_id: movement.id,
        paid_in_movement_id: movement.id,
        answer: movement.answer_delivered,
        replacement_question_id: index < blueprint.movements.length - 1
          ? `question_${String(index + 2).padStart(2, "0")}`
          : null,
      })),
    } : {}),
    retention_risk_register: [{ movement_ids: ["movement_03"], risk: "The midpoint could become procedural.", direction: "Center the promise Joey might break and Mira's consequential response." }],
    procedural_compression_targets: ["Property filings", "Routine financing calls"],
    repetition_budgets: [{ element: "public crowd reaction", budget: "Use once for betrayal and once with a different function at climax." }],
  };
}

export function validBlueprintAudienceAudit({
  blueprint = validBlueprintV2(),
  packageSha256 = blueprint.winner_package_sha256,
  decision = "pass",
} = {}) {
  const revise = decision === "revise";
  return {
    schema: WINNER_BLUEPRINT_AUDIENCE_AUDIT_SCHEMA,
    status: "completed",
    audience_feedback_contract_version: WINNER_AUDIENCE_FEEDBACK_CONTRACT_VERSION,
    channel: blueprint.channel,
    development_slug: blueprint.development_slug,
    selected_candidate_id: blueprint.selected_candidate_id,
    winner_package_sha256: packageSha256,
    winner_story_blueprint_sha256: sha256Text(`${JSON.stringify(blueprint, null, 2)}\n`),
    decision,
    dimensions: WINNER_BLUEPRINT_AUDIENCE_AUDIT_DIMENSION_IDS.map((id, index) => ({
      id,
      decision: revise && index === 0 ? "revise" : "pass",
      blueprint_evidence: [blueprint.movements[Math.min(index, blueprint.movements.length - 1)].joey_choice],
      reasoning: revise && index === 0
        ? "The decisive evidence needs a clearer behavior update."
        : "The architecture supplies a concrete, package-bound control.",
    })),
    strengths: ["The title promises have literal payment movements."],
    findings: revise ? [{
      id: "blueprint_audience_finding_01",
      priority: "high",
      dimension: "protagonist_evidence_update",
      movement_ids: ["movement_01"],
      blueprint_evidence: [blueprint.movements[0].joey_choice],
      audience_risk: "Joey could learn the betrayal without visibly changing behavior.",
      repair_goal: "Bind the evidence to an observable strategy update in movement one.",
      protected_facts: ["Diana sells Joey's home.", "Joey preserves the signed notice."],
    }] : [],
    summary: revise ? "One audience-trust repair is required." : "The blueprint is ready for hash approval.",
    audited_at: "2026-08-09T12:05:00.000Z",
  };
}

export function validDiagnostic(passId, scriptText) {
  const normalized = normalizeWinnerNarration(scriptText);
  return {
    schema: WINNER_DEVELOPMENT_DIAGNOSTIC_SCHEMA,
    status: "completed",
    pass_id: passId,
    source_script_sha256: sha256Text(normalized),
    decision: "revise",
    strengths: ["The opening makes Joey's wound and first choice visible."],
    findings: [{
      id: `${passId}_finding_01`,
      priority: "high",
      evidence_anchor: normalized.slice(0, 60).trim(),
      affected_movement_ids: ["movement_02"],
      problem: `The ${passId} pass found one specific development issue.`,
      viewer_effect: "The middle could feel flatter or less inevitable than the opening.",
      revision_goal: "Strengthen one choice, consequence, and relationship turn without changing canon.",
      protected_facts: ["The approved opening remains exact.", "The title payoff remains literal."],
    }],
    summary: `One grounded ${passId} improvement should be integrated without broad rewriting.`,
  };
}

function validRelease(script, packageContract) {
  const release = {
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
  if (packageContract.source_workflow_profile === WINNER_SOURCE_ROOM_PROFILE) {
    Object.assign(release, {
      source_workflow_profile: WINNER_SOURCE_ROOM_PROFILE,
      winner_retention_map_path: "/tmp/winner_retention_map.json",
      winner_retention_map_sha256: "retention-map-hash",
      winner_opening_path: "/tmp/winner_opening.md",
      winner_opening_sha256: "opening-hash",
      winner_opening_approval_path: "/tmp/winner_opening_approval.json",
      script_development_report_path: "/tmp/winner_line_flow_polish_report.json",
      script_development_report_sha256: "polish-report-hash",
      winner_development_diagnostics_manifest_path: "/tmp/winner_development_diagnostics_manifest.json",
      winner_development_diagnostics_manifest_sha256: "diagnostics-manifest-hash",
      winner_integrated_revision_report_path: "/tmp/winner_integrated_revision_report.json",
      winner_integrated_revision_report_sha256: "revision-report-hash",
      winner_line_flow_polish_report_path: "/tmp/winner_line_flow_polish_report.json",
      winner_line_flow_polish_report_sha256: "polish-report-hash",
    });
  }
  return release;
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
  const validJsonResponse = '{"label":"PAID FUNERAL","count":2}';
  assert.deepEqual(extractJsonObject(validJsonResponse), { label: "PAID FUNERAL", count: 2 });
  assert.deepEqual(
    extractJsonObject('{"image_prompt":"Render the exact text "PAID FUNERAL" beside "LIVE • $84K".","rank":1}'),
    { image_prompt: 'Render the exact text "PAID FUNERAL" beside "LIVE • $84K".', rank: 1 },
  );
  assert.deepEqual(
    extractJsonObject('{"fresh_elements":["Changed from "Used as a Meat Shield": the exploiter is family.","The reversal remains visible."],"status":"passed"}'),
    {
      fresh_elements: [
        'Changed from "Used as a Meat Shield": the exploiter is family.',
        "The reversal remains visible.",
      ],
      status: "passed",
    },
  );

  const evidenceSnapshot = validEvidenceSnapshot();
  assert.deepEqual(validateSourceEvidenceSnapshot(evidenceSnapshot), { done: true, blockers: [] });
  const invalidEvidenceSnapshot = structuredClone(evidenceSnapshot);
  invalidEvidenceSnapshot.market_opening_modes = [];
  const invalidEvidenceResult = validateSourceEvidenceSnapshot(invalidEvidenceSnapshot);
  assert.equal(invalidEvidenceResult.done, false);
  assert.ok(invalidEvidenceResult.blockers.includes("source_evidence_snapshot_opening_mode_visible_proof_or_payoff_missing"));

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

  const pairedFormula = validFormula();
  pairedFormula.package_contract = { pairing: ["Require additive title-thumbnail package fields."] };
  const pairedIdeation = validIdeation();
  for (const candidate of pairedIdeation.candidates) {
    Object.assign(candidate.thumbnail, {
      title_supplies: "The title explains the betrayal and resulting takeover.",
      thumbnail_adds: "The signed ownership screen proves the antagonist lost control.",
      package_open_loop: "How did Joey turn the betrayal into legal ownership?",
      proof_device: "A one-dollar acquisition screen.",
      literal_payment_scene: "The public acquisition closes while the antagonist watches.",
    });
  }
  pairedIdeation.candidates[0].thumbnail.proof_device = "";
  pairedIdeation.candidates[1].thumbnail.thumbnail_adds = pairedIdeation.candidates[1].thumbnail.title_supplies;
  const pairedResult = evaluateWinnerIdeation(pairedIdeation, pairedFormula);
  assert.ok(candidateById(pairedResult, "wife_sold_home").computed.blockers.includes("thumbnail_proof_device_missing"));
  assert.ok(candidateById(pairedResult, "brother_fired_hotel").computed.blockers.includes("title_thumbnail_pair_not_additive"));

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

  const blueprint = validBlueprint();
  blueprint.winner_package_sha256 = sha256Text(JSON.stringify(contract));
  const blueprintValidation = validateWinnerStoryBlueprint(blueprint, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.equal(blueprintValidation.done, true);
  assert.deepEqual(blueprintValidation.blockers, []);
  assert.equal(blueprintValidation.target_word_total, 1000);
  const blueprintApproval = {
    schema: WINNER_STORY_BLUEPRINT_APPROVAL_SCHEMA,
    status: "approved",
    channel: contract.channel,
    development_slug: contract.development_slug,
    selected_candidate_id: contract.selected_candidate_id,
    winner_story_blueprint_path: "/tmp/winner_story_blueprint.json",
    winner_story_blueprint_sha256: sha256Text(JSON.stringify(blueprint)),
    winner_package_sha256: blueprint.winner_package_sha256,
    approved_by: "operator",
    approved_at: "2026-08-09T12:00:00.000Z",
  };
  assert.deepEqual(
    validateWinnerStoryBlueprintApproval(blueprintApproval, {
      blueprintSha256: blueprintApproval.winner_story_blueprint_sha256,
    }),
    { done: true, blockers: [] },
  );
  const invalidBlueprint = structuredClone(blueprint);
  invalidBlueprint.section_plan[1].movement_ids = ["movement_04"];
  const invalidBlueprintResult = validateWinnerStoryBlueprint(invalidBlueprint, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.equal(invalidBlueprintResult.done, false);
  assert.ok(invalidBlueprintResult.blockers.includes("winner_blueprint_section_plan_movement_coverage_invalid"));

  const blueprintV2 = validBlueprintV2({ packageSha256: blueprint.winner_package_sha256 });
  const blueprintV2Validation = validateWinnerStoryBlueprintV2(blueprintV2, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.equal(blueprintV2Validation.done, true, JSON.stringify(blueprintV2Validation.blockers));
  assert.equal(blueprintV2Validation.target_word_total, 1000);
  assert.deepEqual(blueprintV2Validation.movement_count_range, { minimum: 4, maximum: 4 });

  const hybridOpeningBlueprint = structuredClone(blueprintV2);
  hybridOpeningBlueprint.narration_contract.pov = "hybrid_first_person_cold_open_then_third_person";
  const hybridOpeningValidation = validateWinnerStoryBlueprintV2(hybridOpeningBlueprint, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.equal(hybridOpeningValidation.done, true, JSON.stringify(hybridOpeningValidation.blockers));

  const invalidOpeningLanguageBudget = structuredClone(blueprintV2);
  invalidOpeningLanguageBudget.opening_delivery_contract.first_30_second_language_budget.unexplained_story_terms_maximum = 6;
  const invalidOpeningLanguageBudgetValidation = validateWinnerStoryBlueprintV2(invalidOpeningLanguageBudget, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.equal(invalidOpeningLanguageBudgetValidation.done, false);
  assert.ok(invalidOpeningLanguageBudgetValidation.blockers.includes(
    "winner_blueprint_v2_opening_delivery_story_term_budget_invalid",
  ));

  const legacyBlueprintV2 = validBlueprintV2({
    packageSha256: blueprint.winner_package_sha256,
    audienceFeedback: false,
  });
  delete legacyBlueprintV2.opening_delivery_contract_version;
  delete legacyBlueprintV2.opening_delivery_contract;
  const legacyBlueprintV2Validation = validateWinnerStoryBlueprintV2(legacyBlueprintV2, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.equal(legacyBlueprintV2Validation.done, true, JSON.stringify(legacyBlueprintV2Validation.blockers));

  const bridgeBlueprint = structuredClone(blueprintV2);
  bridgeBlueprint.movements[1].movement_kind = "bridge";
  bridgeBlueprint.movements[1].emotional_objective = null;
  bridgeBlueprint.movements[1].relationship_turn = null;
  const bridgeBlueprintValidation = validateWinnerStoryBlueprintV2(bridgeBlueprint, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.equal(bridgeBlueprintValidation.done, true, JSON.stringify(bridgeBlueprintValidation.blockers));

  const invalidDramaBlueprint = structuredClone(blueprintV2);
  invalidDramaBlueprint.movements[1].relationship_turn = "";
  const invalidDramaBlueprintResult = validateWinnerStoryBlueprintV2(invalidDramaBlueprint, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.equal(invalidDramaBlueprintResult.done, false);
  assert.ok(invalidDramaBlueprintResult.blockers.includes("winner_blueprint_v2_movement_1_relationship_turn_missing"));

  const missingAudienceTrustBlueprint = structuredClone(blueprintV2);
  delete missingAudienceTrustBlueprint.audience_trust_contract;
  const missingAudienceTrustResult = validateWinnerStoryBlueprintV2(missingAudienceTrustBlueprint, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.equal(missingAudienceTrustResult.done, false);
  assert.ok(missingAudienceTrustResult.blockers.includes("winner_blueprint_v2_audience_trust_decisive_evidence_missing"));

  const blueprintAudienceAudit = validBlueprintAudienceAudit({
    blueprint: blueprintV2,
    packageSha256: blueprint.winner_package_sha256,
  });
  const blueprintAudienceAuditValidation = validateWinnerBlueprintAudienceAudit(blueprintAudienceAudit, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
    blueprint: blueprintV2,
    blueprintSha256: blueprintAudienceAudit.winner_story_blueprint_sha256,
  });
  assert.deepEqual(blueprintAudienceAuditValidation, { done: true, blockers: [], expected_decision: "pass" });
  const staleBlueprintAudienceAudit = structuredClone(blueprintAudienceAudit);
  staleBlueprintAudienceAudit.winner_story_blueprint_sha256 = "stale-blueprint";
  const staleBlueprintAudienceAuditValidation = validateWinnerBlueprintAudienceAudit(staleBlueprintAudienceAudit, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
    blueprint: blueprintV2,
    blueprintSha256: blueprintAudienceAudit.winner_story_blueprint_sha256,
  });
  assert.equal(staleBlueprintAudienceAuditValidation.done, false);
  assert.ok(staleBlueprintAudienceAuditValidation.blockers.includes("winner_blueprint_audience_audit_blueprint_hash_mismatch"));
  const revisionBlueprintAudienceAudit = validBlueprintAudienceAudit({
    blueprint: blueprintV2,
    packageSha256: blueprint.winner_package_sha256,
    decision: "revise",
  });
  assert.deepEqual(validateWinnerBlueprintAudienceAudit(revisionBlueprintAudienceAudit, {
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
    blueprint: blueprintV2,
    blueprintSha256: revisionBlueprintAudienceAudit.winner_story_blueprint_sha256,
  }), { done: true, blockers: [], expected_decision: "revise" });

  const blueprintV2Sha256 = sha256Text(`${JSON.stringify(blueprintV2, null, 2)}\n`);
  const retentionMapDocument = validRetentionMap({
    blueprint: blueprintV2,
    packageSha256: blueprint.winner_package_sha256,
  });
  retentionMapDocument.winner_story_blueprint_sha256 = blueprintV2Sha256;
  const retentionMapValidation = validateWinnerRetentionMap(retentionMapDocument, {
    blueprint: blueprintV2,
    blueprintSha256: blueprintV2Sha256,
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.deepEqual(retentionMapValidation, { done: true, blockers: [] });

  const unpaidQuestionMap = structuredClone(retentionMapDocument);
  unpaidQuestionMap.question_payment_ledger[3].paid_in_movement_id = "movement_03";
  const unpaidQuestionValidation = validateWinnerRetentionMap(unpaidQuestionMap, {
    blueprint: blueprintV2,
    blueprintSha256: blueprintV2Sha256,
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.equal(unpaidQuestionValidation.done, false);
  assert.ok(unpaidQuestionValidation.blockers.includes("winner_retention_map_question_3_paid_before_opened"));

  const unknownQuestionMap = structuredClone(retentionMapDocument);
  unknownQuestionMap.movement_directives[0].rehook_out_question_id = "question_missing";
  const unknownQuestionValidation = validateWinnerRetentionMap(unknownQuestionMap, {
    blueprint: blueprintV2,
    blueprintSha256: blueprintV2Sha256,
    packageContract: contract,
    packageSha256: blueprint.winner_package_sha256,
  });
  assert.equal(unknownQuestionValidation.done, false);
  assert.ok(unknownQuestionValidation.blockers.includes("winner_retention_map_question_reference_question_missing_unknown"));

  const openingText = scriptWithWordCount(500);
  const openingReview = reviewWinnerOpening(openingText, contract, {
    retentionMapSha256: "retention-map-hash",
    blueprintSha256: blueprintV2Sha256,
  });
  assert.equal(openingReview.status, "passed");
  assert.equal(openingReview.opening_word_count, 500);
  const openingApproval = {
    schema: WINNER_OPENING_APPROVAL_SCHEMA,
    status: "approved",
    channel: contract.channel,
    development_slug: contract.development_slug,
    selected_candidate_id: contract.selected_candidate_id,
    opening_path: "/tmp/winner_opening.md",
    opening_sha256: openingReview.opening_sha256,
    winner_retention_map_sha256: "retention-map-hash",
    winner_story_blueprint_sha256: blueprintV2Sha256,
    approved_by: "operator",
    approved_at: "2026-08-09T12:20:00.000Z",
  };
  assert.deepEqual(validateWinnerOpeningApproval(openingApproval, {
    openingSha256: openingReview.opening_sha256,
    retentionMapSha256: "retention-map-hash",
    blueprintSha256: blueprintV2Sha256,
  }), { done: true, blockers: [] });

  const continuationText = `${Array.from({ length: 500 }, (_, index) => `continuation${index}`).join(" ")}.`;
  const assembledScript = assembleWinnerScriptWithApprovedOpening(openingText, continuationText);
  assert.equal(countWords(assembledScript), 1000);
  assert.ok(assembledScript.startsWith(normalizeWinnerNarration(openingText).trim()));
  assert.throws(
    () => assembleWinnerScriptWithApprovedOpening(openingText, openingText),
    /repeated the approved opening/,
  );

  for (const passId of WINNER_DIAGNOSTIC_PASS_IDS) {
    const diagnostic = validDiagnostic(passId, assembledScript);
    const diagnosticValidation = validateWinnerDevelopmentDiagnostic(diagnostic, {
      passId,
      sourceScriptSha256: sha256Text(assembledScript),
      scriptText: assembledScript,
    });
    assert.equal(diagnosticValidation.done, true, JSON.stringify(diagnosticValidation.blockers));
    assert.deepEqual(diagnosticValidation.warnings, []);
  }

  const revisionReport = {
    schema: WINNER_REVISION_REPORT_SCHEMA,
    status: "passed",
    stage: "integrated_revision",
    source_script_path: "/tmp/script_candidate.md",
    source_script_sha256: sha256Text(assembledScript),
    output_script_path: "/tmp/script_revised.md",
    output_script_sha256: sha256Text(assembledScript),
    approved_opening_sha256: openingReview.opening_sha256,
    winner_story_blueprint_sha256: blueprintV2Sha256,
    winner_retention_map_sha256: "retention-map-hash",
    completed_at: "2026-08-09T12:30:00.000Z",
  };
  assert.deepEqual(validateWinnerRevisionReport(revisionReport, {
    expectedStage: "integrated_revision",
    sourceScriptSha256: sha256Text(assembledScript),
    outputScriptSha256: sha256Text(assembledScript),
    openingSha256: openingReview.opening_sha256,
  }), { done: true, blockers: [] });

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

  const povSwitchScript = `${[
    "I locked the door because my wife had sold my home. I refused to beg. I kept the proof and walked away.",
    Array.from({ length: 980 }, (_, index) => index % 8 === 0 ? "Joey" : index % 8 === 1 ? "he" : `progress${index}`).join(" "),
  ].join(" ")}.`;
  const povSwitchReview = deterministicWinnerScriptReview(povSwitchScript, contract, { blueprint });
  assert.equal(povSwitchReview.status, "passed");
  assert.ok(povSwitchReview.warnings.includes("script_pov_switch_first_to_third_near_opening"));

  const truncatedScript = scriptWithWordCount(600);
  const truncatedReview = deterministicWinnerScriptReview(truncatedScript, contract);
  const probableTruncationFloor = Math.max(500, Math.round(expectedMinimumWords * 0.7));
  assert.equal(truncatedReview.status, "blocked");
  assert.ok(truncatedReview.blockers.includes(
    `script_probably_truncated_${countWords(truncatedScript)}_below_${probableTruncationFloor}`,
  ));

  const incompleteTerminalScript = scriptWithWordCount(1000).trim().replace(/[.!?]$/, "");
  const incompleteTerminalReview = deterministicWinnerScriptReview(incompleteTerminalScript, contract);
  assert.equal(incompleteTerminalReview.status, "blocked");
  assert.ok(incompleteTerminalReview.blockers.includes("script_terminal_sentence_incomplete"));

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
