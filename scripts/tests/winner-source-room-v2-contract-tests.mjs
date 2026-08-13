import assert from "node:assert/strict";
import {
  ARCHITECTURE_REDTEAM_SCHEMA,
  LONGFORM_DRAFT_SELECTION_SCHEMA,
  PACKAGE_OUTLIER_LEDGER_SCHEMA,
  PACKAGE_ADJUDICATION_SCHEMA,
  PACKAGE_TOURNAMENT_CONSENSUS_SCHEMA,
  PACKAGE_TOURNAMENT_SCHEMA,
  PREMISE_SELECTION_V2_SCHEMA,
  PREMISE_SLOT_IDS,
  REFERENCE_DENSITY_DIMENSION_IDS,
  REFERENCE_DENSITY_DOMINANCE_SCHEMA,
  REFERENCE_DENSITY_NORMALIZATION_POLICY,
  REFERENCE_MERIT_FRONTIER_SCHEMA,
  bindReferenceDensityAnchors,
  bindReferenceMeritFrontierAnchors,
  bindSourceSemanticAcceptanceAnchors,
  COLD_LISTENER_ACCEPTANCE_REQUIREMENT_IDS,
  SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS,
  SOURCE_DIAGNOSTIC_V2_SCHEMA,
  SOURCE_EVIDENCE_REGISTRY_SCHEMA,
  SOURCE_ROOM_RELEASE_V2_SCHEMA,
  SOURCE_SEMANTIC_ACCEPTANCE_SCHEMA,
  SOURCE_STAGE_APPROVAL_SCHEMA,
  STORY_ARCHITECTURE_SCHEMA,
  TREATMENT_BAKEOFF_SCHEMA,
  TREATMENT_SELECTION_SCHEMA,
  validateArchitectureRedteam,
  validateLongformDraftSelection,
  validatePackageTournament,
  validatePackageTournamentConsensus,
  validatePackageAdjudication,
  validatePremiseSelectionV2,
  validatePremiseSlateV2,
  validateReferenceDensityDominance,
  validateReferenceMeritFrontier,
  validatePackageOutlierLedger,
  validateSourceRoomReleaseV2,
  validateSourceDiagnosticV2,
  validateSourceEvidenceRegistry,
  validateSourceSemanticAcceptance,
  validateSourceStageApproval,
  validateStoryArchitecture,
  validateTreatmentBakeoff,
  validateTreatmentSelection,
} from "../lib/winner-source-room-v2-contract.mjs";

const HASHES = Object.fromEntries(
  "abcdefghijklmnop".split("").map((key, index) => [key, String(index + 1).padStart(64, "0")]),
);

function words(count) {
  return Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
}

function exactAnchor(text, exactText) {
  const startOffset = text.indexOf(exactText);
  assert.ok(startOffset >= 0, `Missing fixture anchor: ${exactText}`);
  return {
    start_offset: startOffset,
    end_offset: startOffset + exactText.length,
    exact_text: exactText,
  };
}

function referenceFrontier(referenceText) {
  return {
    schema: REFERENCE_MERIT_FRONTIER_SCHEMA,
    status: "charted",
    package_sha256: HASHES.a,
    selected_package_title: "Candidate title",
    source_outlier_id: "outlier_1",
    reference_title: "Measured reference",
    reference_path: "/tmp/reference.txt",
    reference_sha256: HASHES.b,
    reference_word_count: referenceText.trim().split(/\s+/).length,
    normalization_policy: REFERENCE_DENSITY_NORMALIZATION_POLICY,
    dimensions: REFERENCE_DENSITY_DIMENSION_IDS.map((id) => ({
      id,
      reference_anchor: exactAnchor(referenceText, "The reference delivers a visible reversal."),
      viewer_appetite: `${id} appetite`,
      reference_strength: `${id} strength`,
      reference_weakness: `${id} weakness`,
      candidate_dominance_obligation: `${id} candidate obligation`,
      non_copying_boundary: `${id} non-copying boundary`,
    })),
    material_reference_edges: REFERENCE_DENSITY_DIMENSION_IDS.map((id) => ({
      edge_id: `${id}_edge`,
      dimension_id: id,
      reference_anchor: exactAnchor(referenceText, "The reference delivers a visible reversal."),
      viewer_appetite: `${id} edge appetite`,
      reference_advantage: `${id} distinct edge`,
      candidate_dominance_obligation: `${id} edge obligation`,
      non_copying_boundary: `${id} edge non-copying boundary`,
    })),
    cross_dimension_priorities: ["Earlier proof", "Stronger emotion", "Cleaner payoff"],
  };
}

function densityDominance(candidateText, referenceText, decision = "candidate_win") {
  return {
    schema: REFERENCE_DENSITY_DOMINANCE_SCHEMA,
    status: decision === "candidate_win" ? "passed" : "findings",
    script_sha256: HASHES.c,
    reference_sha256: HASHES.b,
    frontier_sha256: HASHES.d,
    normalization_policy: REFERENCE_DENSITY_NORMALIZATION_POLICY,
    dimensions: REFERENCE_DENSITY_DIMENSION_IDS.map((id, index) => ({
      id,
      decision: index === 0 ? decision : "candidate_win",
      candidate_anchor: exactAnchor(candidateText, "Joey makes the stronger choice."),
      reference_anchor: exactAnchor(referenceText, "The reference delivers a visible reversal."),
      density_judgment: `${id} normalized judgment`,
      candidate_advantage_or_gap: `${id} advantage or gap`,
    })),
    edge_verdicts: REFERENCE_DENSITY_DIMENSION_IDS.map((id, index) => ({
      edge_id: `${id}_edge`,
      decision: index === 0 ? decision : "candidate_win",
      candidate_anchor: exactAnchor(candidateText, "Joey makes the stronger choice."),
      reference_anchor: exactAnchor(referenceText, "The reference delivers a visible reversal."),
      density_judgment: `${id} edge judgment`,
      candidate_advantage_or_gap: `${id} edge advantage or gap`,
    })),
    findings: decision === "candidate_win" ? [] : [{
      id: "density_opening_hook_gap",
      dimension_id: "opening_hook",
      edge_id: "opening_hook_edge",
      severity: "material",
      ...exactAnchor(candidateText, "Joey makes the stronger choice."),
      defect: "The opening ties the reference.",
      audience_effect: "No density win.",
      smallest_repair_intent: "Make the opening reversal more immediate.",
    }],
  };
}

function evidenceRegistry() {
  return {
    schema: SOURCE_EVIDENCE_REGISTRY_SCHEMA,
    status: "compiled",
    channel: "53rebirth",
    as_of_date: "2026-08-11",
    claims: [
      {
        claim_id: "claim_positive",
        claim_type: "observation",
        claim: "Matched winner retained a stateful title engine.",
        sample_scope: "one same-channel age-matched pair",
        sources: [{ source_id: "video_1", reference: "https://example.test/video_1" }],
        counterevidence: ["One control had stronger relationships."],
        limitation: "Public VPD does not isolate retention.",
        confidence_language: "directional",
        production_use: "package hypothesis only",
      },
      {
        claim_id: "claim_failure",
        claim_type: "interpretation",
        claim: "Repeated local antagonists can weaken accumulation.",
        sample_scope: "two full-runtime scripts",
        sources: [{ source_id: "audit_1", reference: "/tmp/audit.md" }],
        counterevidence: [],
        limitation: "Qualitative close read.",
        confidence_language: "plausible",
        production_use: "falsification risk",
      },
    ],
  };
}

function premiseSlate() {
  return {
    schema: "goldflow_premise_slate_v2",
    status: "planned",
    channel: "53rebirth",
    development_slug: "fixture",
    evidence_registry_sha256: "registry_hash",
    candidates: PREMISE_SLOT_IDS.map((slot, index) => ({
      id: `candidate_${index + 1}`,
      slot,
      title: `Candidate ${index + 1}`,
      thumbnail_receipt: "One legible visual receipt.",
      contradiction: "The desired life conflicts with the current role.",
      human_desire: "Belong without self-erasure.",
      first_owned_choice: "Refuse the assigned sacrifice.",
      durable_engine: "Each success makes belonging harder.",
      continuation_cost: "Opposition changes tactics.",
      positive_analogue: { claim_id: "claim_positive", transferable_mechanism: "stateful accumulation" },
      failure_analogue: { claim_id: "claim_failure", failure_to_avoid: "reset loops" },
      click_judgment: { decision: "plausible", rationale: "Clear contradiction and receipt." },
      runway_judgment: { decision: "strong", rationale: "Relationships and opposition can accumulate." },
      primary_falsification_risk: "Procedure replaces drama.",
      anti_reskin: {
        abstraction: `Abstract conflict ${index + 1}`,
        nearest_candidate_or_recent_script: "None materially identical.",
        material_difference: "Different cost, relationship, and closure.",
        decision: "pass",
      },
    })),
  };
}

function packageOutlierLedger() {
  return {
    schema: PACKAGE_OUTLIER_LEDGER_SCHEMA,
    status: "compiled",
    channel: "53rebirth",
    as_of_date: "2026-08-12",
    entries: Array.from({ length: 10 }, (_, index) => ({
      entry_id: `outlier_${index + 1}`,
      title: `Proven outlier title ${index + 1}`,
      source_type: index < 5 ? "public_niche_outlier" : "own_channel",
      performance_signal: `Measured signal ${index + 1}`,
      source_reference: `https://example.test/outlier_${index + 1}`,
    })),
  };
}

function treatmentBatch() {
  return {
    schema: TREATMENT_BAKEOFF_SCHEMA,
    status: "planned",
    package_sha256: "package_hash",
    treatments: [
      ["treatment_a", "boundary_drama"],
      ["treatment_b", "adaptive_contest"],
      ["treatment_c", "reclassification_drama"],
    ].map(([id, engine]) => ({
      id,
      engine,
      treatment: `${id} exact anchor ${words(801)}`,
      central_relationship: "One accumulating relationship.",
      opposition_learning_pattern: "Opposition changes tactics.",
      midpoint_reclassification: "Responsibility changes.",
      climax_causality: "Earlier choices combine.",
      closure_contract: "External, relational, internal, and ordinary closure.",
      primary_failure_risk: "Procedure replaces drama.",
    })),
  };
}

function architecture() {
  return {
    schema: STORY_ARCHITECTURE_SCHEMA,
    status: "planned",
    package_sha256: "package_hash",
    selected_treatment_sha256: "treatment_hash",
    target_word_range: { minimum: 9_000, maximum: 11_000 },
    opening_semantic_contract: {},
    protagonist_contract: {},
    mechanic_and_world_constraints: {},
    relationship_ladder: {},
    opposition_ladder: {},
    learning_ledger: {},
    continuity_ledger: {},
    climax_proof_obligations: {},
    closure_contract: {},
    movements: Array.from({ length: 12 }, (_, index) => ({
      id: `movement_${String(index + 1).padStart(2, "0")}`,
      entering_state: "A current state.",
      protagonist_choice: "An owned choice.",
      consequence_and_changed_state: "The story state changes.",
      relationship_opposition_or_learning_change: "History accumulates.",
      promise_or_viewer_question_movement: "One question closes and another opens.",
      continuity_constraints: [],
      listener_orientation: {
        current_goal: "Joey must answer the current threat.",
        immediate_obstacle: "The opponent blocks his next move.",
        what_changed_from_previous_movement: index === 0 ? "The story begins under pressure." : "The previous choice changed the conflict.",
        active_concepts: [],
      },
    })),
  };
}

function dramaticArchitecture() {
  const value = architecture();
  value.opening_semantic_contract = {
    version: "dramatic_cold_open_v2",
    first_sentence_event: { visible_event: "Joey is struck during the public inheritance challenge." },
    cold_open_loop: {
      visible_wound: "His brother takes the inheritance and targets his sister.",
      active_pressure: "Joey must enter the challenge immediately.",
      owned_choice: "He takes his sister's place.",
      counteraction: "He touches his brother and steals the SSS talent.",
      observable_result: "His brother loses the crest and Joey turns the duel.",
      next_question: "Can Joey control the stolen power?",
    },
    by_approximately_30_seconds: { required_state: "The theft and threat are visible." },
    by_approximately_60_seconds: { required_state: "Joey chooses and the talent theft sparks." },
    by_approximately_90_seconds: { required_state: "The duel changes state." },
    by_approximately_3_minutes: { required_state: "The stolen talent produces visible proof." },
    by_approximately_5_minutes: { required_state: "The first larger conflict closes." },
    exposition_release_point: { after_result: "After the stolen crest visibly changes hands." },
  };
  return value;
}

function comprehensionArchitecture() {
  const value = dramaticArchitecture();
  value.mechanic_comprehension_contract = {
    current_objective_plain_language: "Joey must rescue Sera before the bell.",
    concepts: [{
      spoken_name: "Hundredfold Assimilation",
      category: "learning multiplier",
      input_or_trigger: "Joey observes a skill or receives experience through Theft.",
      observable_output: "He learns the demonstrated skill at extreme speed.",
      limit_or_cost: "It cannot supply missing facts and overloads his senses.",
      why_it_matters_now: "It lets him master the stolen combat talent quickly enough to rescue Sera.",
      first_clear_movement_id: "movement_01",
      distinct_from: ["Theft", "sensory blackout"],
    }],
  };
  return value;
}

export async function runWinnerSourceRoomV2ContractTests() {
  const referenceText = "The reference delivers a visible reversal. It then continues with a complete story.";
  const candidateText = "Joey makes the stronger choice. The consequence changes his life.";
  const frontier = referenceFrontier(referenceText);
  assert.equal(validateReferenceMeritFrontier(frontier, {
    packageSha256: HASHES.a,
    referenceText,
    referenceSha256: HASHES.b,
    referencePath: "/tmp/reference.txt",
    referenceTitle: "Measured reference",
    requireMaterialEdges: true,
  }).done, true);
  const legacyFrontier = structuredClone(frontier);
  delete legacyFrontier.material_reference_edges;
  assert.equal(validateReferenceMeritFrontier(legacyFrontier, {
    packageSha256: HASHES.a,
    referenceText,
    referenceSha256: HASHES.b,
    referencePath: "/tmp/reference.txt",
    referenceTitle: "Measured reference",
  }).done, true);
  assert.equal(validateReferenceMeritFrontier(legacyFrontier, {
    packageSha256: HASHES.a,
    referenceText,
    referenceSha256: HASHES.b,
    referencePath: "/tmp/reference.txt",
    referenceTitle: "Measured reference",
    requireMaterialEdges: true,
  }).done, false);
  const inventedFrontierAnchor = structuredClone(frontier);
  inventedFrontierAnchor.dimensions[0].reference_anchor.exact_text = "Invented reference claim.";
  assert.equal(validateReferenceMeritFrontier(inventedFrontierAnchor, {
    packageSha256: HASHES.a,
    referenceText,
    referenceSha256: HASHES.b,
    referencePath: "/tmp/reference.txt",
    referenceTitle: "Measured reference",
  }).done, false);
  const repairableFrontierOffsets = structuredClone(frontier);
  repairableFrontierOffsets.dimensions[0].reference_anchor.start_offset = 999;
  repairableFrontierOffsets.dimensions[0].reference_anchor.end_offset = 1000;
  const boundFrontier = bindReferenceMeritFrontierAnchors(repairableFrontierOffsets, { referenceText });
  assert.equal(validateReferenceMeritFrontier(boundFrontier, {
    packageSha256: HASHES.a,
    referenceText,
    referenceSha256: HASHES.b,
    referencePath: "/tmp/reference.txt",
    referenceTitle: "Measured reference",
  }).done, true);
  const ambiguousReferenceText = `${referenceText} The reference delivers a visible reversal.`;
  const ambiguousFrontier = bindReferenceMeritFrontierAnchors(repairableFrontierOffsets, { referenceText: ambiguousReferenceText });
  assert.equal(ambiguousFrontier.dimensions[0].reference_anchor.start_offset, 999);
  const passedDensity = densityDominance(candidateText, referenceText);
  assert.equal(validateReferenceDensityDominance(passedDensity, {
    scriptText: candidateText,
    scriptSha256: HASHES.c,
    referenceText,
    referenceSha256: HASHES.b,
    frontierSha256: HASHES.d,
    referenceMeritFrontier: frontier,
  }).done, true);
  const tiedDensity = densityDominance(candidateText, referenceText, "tie");
  assert.equal(validateReferenceDensityDominance(tiedDensity, {
    scriptText: candidateText,
    scriptSha256: HASHES.c,
    referenceText,
    referenceSha256: HASHES.b,
    frontierSha256: HASHES.d,
    referenceMeritFrontier: frontier,
  }).done, true);
  const repairableDensityOffsets = structuredClone(passedDensity);
  repairableDensityOffsets.dimensions[0].candidate_anchor.start_offset = -1;
  repairableDensityOffsets.dimensions[0].candidate_anchor.end_offset = -1;
  const boundDensity = bindReferenceDensityAnchors(repairableDensityOffsets, { scriptText: candidateText, referenceText });
  assert.equal(validateReferenceDensityDominance(boundDensity, {
    scriptText: candidateText,
    scriptSha256: HASHES.c,
    referenceText,
    referenceSha256: HASHES.b,
    frontierSha256: HASHES.d,
    referenceMeritFrontier: frontier,
  }).done, true);
  const falseDensityPass = structuredClone(tiedDensity);
  falseDensityPass.status = "passed";
  assert.equal(validateReferenceDensityDominance(falseDensityPass, {
    scriptText: candidateText,
    scriptSha256: HASHES.c,
    referenceText,
    referenceSha256: HASHES.b,
    frontierSha256: HASHES.d,
    referenceMeritFrontier: frontier,
  }).done, false);

  const evidence = evidenceRegistry();
  assert.equal(validateSourceEvidenceRegistry(evidence).done, true);

  const slate = premiseSlate();
  assert.equal(validatePremiseSlateV2(slate, {
    evidenceRegistry: evidence,
    evidenceRegistrySha256: "registry_hash",
  }).done, true);
  const outliers = packageOutlierLedger();
  assert.equal(validatePackageOutlierLedger(outliers).done, true);
  const outlierBoundSlate = structuredClone(slate);
  for (const [index, candidate] of outlierBoundSlate.candidates.entries()) {
    candidate.outlier_mirror = {
      source_id: `outlier_${index + 1}`,
      source_title: `Proven outlier title ${index + 1}`,
      proven_package_movie: "A plain injury becomes a plainly desirable reversal.",
      retained_dna: "The same immediate emotional wound and fantasy reward.",
      single_twist: "One more visual proof.",
      why_twist_beats_or_strengthens_source: "The proof is clearer without adding lore.",
      first_read_movie: "His family rejects him, then his hidden system makes him the owner.",
      desirable_reversal: "He becomes the owner with overwhelming leverage.",
    };
  }
  assert.equal(validatePremiseSlateV2(outlierBoundSlate, {
    evidenceRegistry: evidence,
    evidenceRegistrySha256: "registry_hash",
    packageOutlierLedger: outliers,
  }).done, true);
  const unknownOutlier = structuredClone(outlierBoundSlate);
  unknownOutlier.candidates[0].outlier_mirror.source_id = "missing_outlier";
  assert.equal(validatePremiseSlateV2(unknownOutlier, {
    evidenceRegistry: evidence,
    evidenceRegistrySha256: "registry_hash",
    packageOutlierLedger: outliers,
  }).done, false);
  const missingChallenger = structuredClone(slate);
  missingChallenger.candidates[5].slot = "core_1";
  assert.equal(validatePremiseSlateV2(missingChallenger, {
    evidenceRegistry: evidence,
    evidenceRegistrySha256: "registry_hash",
  }).done, false);

  const tournamentSlate = structuredClone(outlierBoundSlate);
  tournamentSlate.candidates[0].click_judgment.decision = "strong";
  tournamentSlate.candidates[1].click_judgment.decision = "strong";
  const tournament = {
    schema: PACKAGE_TOURNAMENT_SCHEMA,
    provider_role: "gpt_web_pro",
    premise_slate_sha256: HASHES.a,
    eligible_candidate_ids: ["candidate_1", "candidate_2"],
    selected_candidate_id: "candidate_1",
    selection_rationale: "Candidate one has the clearest complete click movie and durable human escalation.",
    click_confidence: "strong",
    runway_screen: "strong",
    comparative_findings: ["candidate_1", "candidate_2"].map((candidateId) => ({
      candidate_id: candidateId,
      click_movie: "A legible wound becomes a desirable reversal.",
      thumbnail_receipt: "One visible object proves the reversal.",
      proven_demand_transfer: "The measured emotional and fantasy movie transfers directly.",
      twist_value: "The twist sharpens visual proof without adding lore.",
      reskin_risk: "The setting may overlap, but the human contest and proof differ.",
      runway_veto: "pass",
      decisive_reason: candidateId === "candidate_1" ? "Strongest first-read movie." : "Slightly weaker proof.",
    })),
    rejection_reason: null,
  };
  const tournamentOptions = { premiseSlate: tournamentSlate, premiseSlateSha256: HASHES.a };
  assert.equal(validatePackageTournament(tournament, tournamentOptions).done, true);
  const missingTournamentCandidate = structuredClone(tournament);
  missingTournamentCandidate.comparative_findings.pop();
  assert.equal(validatePackageTournament(missingTournamentCandidate, tournamentOptions).done, false);
  const ineligibleTournamentWinner = structuredClone(tournament);
  ineligibleTournamentWinner.selected_candidate_id = "candidate_3";
  assert.equal(validatePackageTournament(ineligibleTournamentWinner, tournamentOptions).done, false);

  const geminiTournament = structuredClone(tournament);
  geminiTournament.provider_role = "gemini_web_3_6_flash";
  const consensus = {
    schema: PACKAGE_TOURNAMENT_CONSENSUS_SCHEMA,
    status: "consensus",
    premise_slate_sha256: HASHES.a,
    gpt_tournament_sha256: HASHES.b,
    gemini_tournament_sha256: HASHES.c,
    selected_candidate_id: "candidate_1",
    consensus_click_confidence: "strong",
    consensus_runway_screen: "strong",
    created_at: "2026-08-12T00:00:00.000Z",
  };
  const consensusOptions = {
    premiseSlateSha256: HASHES.a,
    gptTournament: tournament,
    gptTournamentSha256: HASHES.b,
    geminiTournament,
    geminiTournamentSha256: HASHES.c,
  };
  assert.equal(validatePackageTournamentConsensus(consensus, consensusOptions).done, true);
  const falseConsensus = structuredClone(consensus);
  const disagreeingGemini = structuredClone(geminiTournament);
  disagreeingGemini.selected_candidate_id = "candidate_2";
  assert.equal(validatePackageTournamentConsensus(falseConsensus, {
    ...consensusOptions,
    geminiTournament: disagreeingGemini,
  }).done, false);

  const disagreement = {
    ...consensus,
    status: "disagreement",
    selected_candidate_id: null,
    consensus_click_confidence: null,
    consensus_runway_screen: null,
  };
  const adjudication = {
    schema: PACKAGE_ADJUDICATION_SCHEMA,
    status: "adjudicated",
    premise_slate_sha256: HASHES.a,
    tournament_consensus_sha256: HASHES.d,
    gpt_tournament_sha256: HASHES.b,
    gemini_tournament_sha256: HASHES.c,
    selected_candidate_id: "candidate_1",
    adjudicated_by: "operator",
    rationale: "The operator prefers the clearer complete click movie.",
    adjudicated_at: "2026-08-12T00:00:00.000Z",
  };
  const adjudicationOptions = {
    premiseSlate: tournamentSlate,
    premiseSlateSha256: HASHES.a,
    tournamentConsensus: disagreement,
    tournamentConsensusSha256: HASHES.d,
    gptTournamentSha256: HASHES.b,
    geminiTournamentSha256: HASHES.c,
  };
  assert.equal(validatePackageAdjudication(adjudication, adjudicationOptions).done, true);
  const ineligibleAdjudication = structuredClone(adjudication);
  ineligibleAdjudication.selected_candidate_id = "candidate_3";
  assert.equal(validatePackageAdjudication(ineligibleAdjudication, adjudicationOptions).done, false);
  assert.equal(validatePackageAdjudication(adjudication, {
    ...adjudicationOptions,
    tournamentConsensus: consensus,
  }).done, false);

  const treatments = treatmentBatch();
  assert.equal(validateTreatmentBakeoff(treatments, { packageSha256: "package_hash" }).done, true);
  const selection = {
    schema: TREATMENT_SELECTION_SCHEMA,
    status: "selected",
    package_sha256: "package_hash",
    treatment_batch_sha256: "batch_hash",
    selected_treatment_id: "treatment_b",
    decision_rationale: "The adaptive engine changes human obligations.",
    comparative_findings: [{
      dimension: "opposition",
      treatment_id: "treatment_b",
      exact_anchor: "treatment_b exact anchor",
      judgment: "Strongest adaptive pressure.",
    }],
    approved_transplant: null,
    rejection_reason: null,
  };
  assert.equal(validateTreatmentSelection(selection, {
    packageSha256: "package_hash",
    treatmentBatch: treatments,
    treatmentBatchSha256: "batch_hash",
  }).done, true);
  const inventedAnchor = structuredClone(selection);
  inventedAnchor.comparative_findings[0].exact_anchor = "not present";
  assert.equal(validateTreatmentSelection(inventedAnchor, {
    packageSha256: "package_hash",
    treatmentBatch: treatments,
    treatmentBatchSha256: "batch_hash",
  }).done, false);

  assert.equal(validateStoryArchitecture(architecture(), {
    packageSha256: "package_hash",
    selectedTreatmentSha256: "treatment_hash",
  }).done, true);
  assert.equal(validateStoryArchitecture(architecture(), {
    packageSha256: "package_hash",
    selectedTreatmentSha256: "treatment_hash",
    requireDramaticOpeningContract: true,
  }).done, false);
  assert.equal(validateStoryArchitecture(dramaticArchitecture(), {
    packageSha256: "package_hash",
    selectedTreatmentSha256: "treatment_hash",
    requireDramaticOpeningContract: true,
  }).done, true);
  assert.equal(validateStoryArchitecture(dramaticArchitecture(), {
    packageSha256: "package_hash",
    selectedTreatmentSha256: "treatment_hash",
    requireMechanicComprehensionContract: true,
  }).done, false);
  assert.equal(validateStoryArchitecture(comprehensionArchitecture(), {
    packageSha256: "package_hash",
    selectedTreatmentSha256: "treatment_hash",
    requireMechanicComprehensionContract: true,
  }).done, true);
  const frontierArchitecture = dramaticArchitecture();
  frontierArchitecture.reference_merit_frontier_sha256 = HASHES.d;
  frontierArchitecture.merit_dominance_contract = {
    normalization_policy: REFERENCE_DENSITY_NORMALIZATION_POLICY,
    dimension_obligations: REFERENCE_DENSITY_DIMENSION_IDS.map((id) => ({
      id,
      candidate_strategy: `${id} strategy`,
      proof_shape: `${id} visible proof`,
      movement_ids: ["movement_01"],
    })),
    edge_obligations: frontier.material_reference_edges.map((edge) => ({
      edge_id: edge.edge_id,
      candidate_strategy: `${edge.edge_id} strategy`,
      proof_shape: `${edge.edge_id} visible proof`,
      movement_ids: ["movement_01"],
    })),
  };
  assert.equal(validateStoryArchitecture(frontierArchitecture, {
    packageSha256: "package_hash",
    selectedTreatmentSha256: "treatment_hash",
    requireDramaticOpeningContract: true,
    requireMeritDominanceContract: true,
    referenceMeritFrontierSha256: HASHES.d,
    referenceMeritFrontier: frontier,
  }).done, true);
  const missingEdgeMerit = structuredClone(frontierArchitecture);
  missingEdgeMerit.merit_dominance_contract.edge_obligations.pop();
  assert.equal(validateStoryArchitecture(missingEdgeMerit, {
    requireMeritDominanceContract: true,
    referenceMeritFrontierSha256: HASHES.d,
    referenceMeritFrontier: frontier,
  }).done, false);
  const missingMerit = structuredClone(frontierArchitecture);
  missingMerit.merit_dominance_contract.dimension_obligations.pop();
  assert.equal(validateStoryArchitecture(missingMerit, {
    requireMeritDominanceContract: true,
    referenceMeritFrontierSha256: HASHES.d,
  }).done, false);
  const namedArchitecture = dramaticArchitecture();
  namedArchitecture.character_name_plan = [{
    name: "Marcus",
    role: "older brother and primary rival",
    voice_or_behavior_distinction: "He hides panic behind clipped legal certainty.",
    reuse_disposition: "new",
    selection_rationale: "The name is easy to distinguish at narration speed.",
  }];
  namedArchitecture.name_familiarity_ledger_sha256 = HASHES.n;
  assert.equal(validateStoryArchitecture(namedArchitecture, {
    packageSha256: "package_hash",
    selectedTreatmentSha256: "treatment_hash",
    requireDramaticOpeningContract: true,
    requireCharacterNamePlan: true,
    nameFamiliarityLedgerSha256: HASHES.n,
  }).done, true);
  assert.equal(validateStoryArchitecture(dramaticArchitecture(), {
    requireCharacterNamePlan: true,
  }).done, false);
  const boundArchitecture = architecture();
  boundArchitecture.selected_treatment_contract = {
    treatment_source_sha256: "batch_hash",
    selection_source_sha256: "selection_hash",
  };
  assert.equal(validateStoryArchitecture(boundArchitecture, {
    packageSha256: "package_hash",
    selectedTreatmentSha256: "treatment_hash",
    treatmentBatchSha256: "batch_hash",
    treatmentSelectionSha256: "selection_hash",
  }).done, true);
  assert.equal(validateStoryArchitecture(boundArchitecture, {
    packageSha256: "package_hash",
    selectedTreatmentSha256: "treatment_hash",
    treatmentBatchSha256: "batch_hash",
    treatmentSelectionSha256: "stale_selection_hash",
  }).done, false);

  const scriptText = "Joey refused the throne. The city changed.";
  const exactText = "Joey refused the throne.";
  const validDiagnostic = {
    schema: SOURCE_DIAGNOSTIC_V2_SCHEMA,
    diagnostic_id: "causality_learning",
    status: "findings",
    script_sha256: "script_hash",
    findings: [{
      id: "finding_1",
      start_offset: 0,
      end_offset: exactText.length,
      exact_text: exactText,
    }],
  };
  assert.equal(validateSourceDiagnosticV2(validDiagnostic, { scriptText, scriptSha256: "script_hash" }).done, true);
  const staleDiagnostic = structuredClone(validDiagnostic);
  staleDiagnostic.findings[0].exact_text = "Joey accepted the throne.";
  assert.equal(validateSourceDiagnosticV2(staleDiagnostic, { scriptText, scriptSha256: "script_hash" }).done, false);

  const acceptance = {
    schema: SOURCE_SEMANTIC_ACCEPTANCE_SCHEMA,
    status: "accepted",
    script_sha256: "script_hash",
    requirements: SEMANTIC_ACCEPTANCE_REQUIREMENT_IDS.map((id) => ({ id, decision: "pass" })),
    anchored_failures: [],
  };
  assert.equal(validateSourceSemanticAcceptance(acceptance, { scriptText, scriptSha256: "script_hash" }).done, true);
  assert.equal(validateSourceSemanticAcceptance(acceptance, {
    scriptText,
    scriptSha256: "script_hash",
    requireDramaticOpeningAcceptance: true,
  }).done, false);
  const dramaticAcceptance = structuredClone(acceptance);
  dramaticAcceptance.requirements.push(
    { id: "opening_event_before_exposition", decision: "pass" },
    { id: "opening_dramatic_loop_complete", decision: "pass" },
    { id: "opening_engine_deadline_met", decision: "pass" },
  );
  assert.equal(validateSourceSemanticAcceptance(dramaticAcceptance, {
    scriptText,
    scriptSha256: "script_hash",
    requireDramaticOpeningAcceptance: true,
  }).done, true);
  assert.equal(validateSourceSemanticAcceptance(dramaticAcceptance, {
    scriptText,
    scriptSha256: "script_hash",
    requireColdListenerComprehension: true,
  }).done, false);
  const comprehensionAcceptance = structuredClone(dramaticAcceptance);
  comprehensionAcceptance.requirements.push(...COLD_LISTENER_ACCEPTANCE_REQUIREMENT_IDS.map((id) => ({ id, decision: "pass" })));
  comprehensionAcceptance.cold_listener_comprehension = {
    decision: "pass",
    current_objective_plain_language: "Joey must refuse the throne and free the city.",
    central_concepts: [{
      spoken_name: "Refusal",
      input_or_trigger: "Joey is offered the throne.",
      observable_output: "He rejects centralized worship.",
      limit_or_cost: "He gives up direct power.",
      why_it_matters_now: "The city can choose for itself.",
      first_clear_anchor: exactAnchor(scriptText, exactText),
      distinct_from: ["cold rejection"],
    }],
    orientation_checkpoints: ["opening", "early_story", "middle", "ending"].map((section_label) => ({
      section_label,
      current_goal: "Joey must refuse the throne.",
      immediate_obstacle: "The city wants to worship him.",
      current_location_or_context: "He stands before the throne.",
      what_changed: "The offer made his private rule public.",
      anchor: exactAnchor(scriptText, exactText),
    })),
    confusion_points: [],
  };
  assert.equal(validateSourceSemanticAcceptance(comprehensionAcceptance, {
    scriptText,
    scriptSha256: "script_hash",
    requireColdListenerComprehension: true,
  }).done, true);
  const frontierAcceptance = structuredClone(dramaticAcceptance);
  frontierAcceptance.reference_sha256 = HASHES.b;
  frontierAcceptance.reference_merit_frontier_sha256 = HASHES.d;
  frontierAcceptance.reference_density_diagnostic_sha256 = HASHES.e;
  frontierAcceptance.requirements.push(
    { id: "opening_promises_resolved", decision: "pass" },
    { id: "power_provenance_clear", decision: "pass" },
    { id: "possession_and_history_continuity", decision: "pass" },
    { id: "auditory_name_distinction", decision: "pass" },
    { id: "reference_density_dominance", decision: "pass" },
    ...REFERENCE_DENSITY_DIMENSION_IDS.map((id) => ({ id: `reference_density_${id}`, decision: "pass" })),
  );
  frontierAcceptance.reference_density_verdicts = passedDensity.dimensions;
  frontierAcceptance.reference_edge_verdicts = passedDensity.edge_verdicts;
  frontierAcceptance.requirements.push(...frontier.material_reference_edges.map((edge) => ({
    id: `reference_edge_${edge.edge_id}`,
    decision: "pass",
  })));
  assert.equal(validateSourceSemanticAcceptance(frontierAcceptance, {
    scriptText: candidateText,
    scriptSha256: "script_hash",
    requireDramaticOpeningAcceptance: true,
    requireReferenceDensityDominance: true,
    referenceText,
    referenceSha256: HASHES.b,
    referenceMeritFrontierSha256: HASHES.d,
    referenceDensityDiagnosticSha256: HASHES.e,
    referenceMeritFrontier: frontier,
  }).done, true);
  const tiedAcceptance = structuredClone(frontierAcceptance);
  tiedAcceptance.reference_density_verdicts[0].decision = "tie";
  assert.equal(validateSourceSemanticAcceptance(tiedAcceptance, {
    scriptText: candidateText,
    scriptSha256: "script_hash",
    requireDramaticOpeningAcceptance: true,
    requireReferenceDensityDominance: true,
    referenceText,
    referenceSha256: HASHES.b,
    referenceMeritFrontierSha256: HASHES.d,
    referenceDensityDiagnosticSha256: HASHES.e,
    referenceMeritFrontier: frontier,
  }).done, false);
  const coherentRepairAcceptance = structuredClone(frontierAcceptance);
  coherentRepairAcceptance.status = "repair";
  coherentRepairAcceptance.reference_density_verdicts[0].decision = "tie";
  coherentRepairAcceptance.reference_edge_verdicts[0].decision = "tie";
  coherentRepairAcceptance.requirements.find((row) => row.id === "reference_density_opening_hook").decision = "fail";
  coherentRepairAcceptance.requirements.find((row) => row.id === "reference_density_dominance").decision = "fail";
  coherentRepairAcceptance.requirements.find((row) => row.id === "reference_edge_opening_hook_edge").decision = "fail";
  coherentRepairAcceptance.anchored_failures = [{
    id: "density_opening_hook_gap",
    ...exactAnchor(candidateText, "Joey makes the stronger choice."),
    defect: "The opening does not clearly win.",
  }];
  const boundRepairAcceptance = bindSourceSemanticAcceptanceAnchors(coherentRepairAcceptance, {
    scriptText: candidateText,
    referenceText,
  });
  assert.equal(validateSourceSemanticAcceptance(boundRepairAcceptance, {
    scriptText: candidateText,
    scriptSha256: "script_hash",
    requireDramaticOpeningAcceptance: true,
    requireReferenceDensityDominance: true,
    referenceText,
    referenceSha256: HASHES.b,
    referenceMeritFrontierSha256: HASHES.d,
    referenceDensityDiagnosticSha256: HASHES.e,
    referenceMeritFrontier: frontier,
  }).done, true);
  const edgeOnlyRepairAcceptance = structuredClone(frontierAcceptance);
  edgeOnlyRepairAcceptance.status = "repair";
  edgeOnlyRepairAcceptance.reference_edge_verdicts[0].decision = "tie";
  edgeOnlyRepairAcceptance.requirements.find((row) => row.id === "reference_density_dominance").decision = "fail";
  edgeOnlyRepairAcceptance.requirements.find((row) => row.id === "reference_edge_opening_hook_edge").decision = "fail";
  edgeOnlyRepairAcceptance.anchored_failures = [{
    id: "reference_edge_opening_hook_gap",
    ...exactAnchor(candidateText, "Joey makes the stronger choice."),
    defect: "The candidate wins the broad dimension but ties one material reference edge.",
  }];
  assert.equal(validateSourceSemanticAcceptance(edgeOnlyRepairAcceptance, {
    scriptText: candidateText,
    scriptSha256: "script_hash",
    requireDramaticOpeningAcceptance: true,
    requireReferenceDensityDominance: true,
    referenceText,
    referenceSha256: HASHES.b,
    referenceMeritFrontierSha256: HASHES.d,
    referenceDensityDiagnosticSha256: HASHES.e,
    referenceMeritFrontier: frontier,
  }).done, true);
  const falseGreen = structuredClone(acceptance);
  falseGreen.requirements[0].decision = "fail";
  assert.equal(validateSourceSemanticAcceptance(falseGreen, { scriptText, scriptSha256: "script_hash" }).done, false);

  const premiseSelection = {
    schema: PREMISE_SELECTION_V2_SCHEMA,
    status: "selected",
    premise_slate_sha256: HASHES.a,
    evidence_registry_sha256: HASHES.b,
    selected_candidate_id: "candidate_2",
    selection_rationale: "Candidate two has the strongest durable human engine.",
    comparative_findings: [
      {
        candidate_id: "candidate_2",
        claim_ids: ["claim_positive"],
        click_judgment: "The title has a legible contradiction.",
        runway_judgment: "The relationship and opposition can accumulate.",
        decisive_reason: "Its first choice changes later obligations.",
      },
      {
        candidate_id: "candidate_5",
        claim_ids: ["claim_failure"],
        click_judgment: "The receipt is clear but less novel.",
        runway_judgment: "Its escalation risks resetting.",
        decisive_reason: "The failure analogue applies directly.",
      },
    ],
    rejection_reason: null,
  };
  const premiseSelectionOptions = {
    premiseSlate: slate,
    premiseSlateSha256: HASHES.a,
    evidenceRegistry: evidence,
    evidenceRegistrySha256: HASHES.b,
  };
  assert.equal(validatePremiseSelectionV2(premiseSelection, premiseSelectionOptions).done, true);
  assert.equal(validatePremiseSelectionV2(premiseSelection, {
    premiseSlate: slate,
    evidenceRegistry: evidence,
  }).done, false);
  for (const mutate of [
    (value) => { value.premise_slate_sha256 = HASHES.c; },
    (value) => { value.evidence_registry_sha256 = HASHES.c; },
    (value) => { value.selected_candidate_id = "invented_candidate"; },
    (value) => { value.comparative_findings[0].candidate_id = "invented_candidate"; },
    (value) => { value.comparative_findings[0].claim_ids = ["invented_claim"]; },
    (value) => { value.comparative_findings[0].claim_ids = []; },
  ]) {
    const invalid = structuredClone(premiseSelection);
    mutate(invalid);
    assert.equal(validatePremiseSelectionV2(invalid, premiseSelectionOptions).done, false);
  }
  const rejectedPremises = structuredClone(premiseSelection);
  rejectedPremises.status = "rejected";
  rejectedPremises.selected_candidate_id = null;
  rejectedPremises.rejection_reason = "Every candidate fails either click clarity or durable runway.";
  assert.equal(validatePremiseSelectionV2(rejectedPremises, premiseSelectionOptions).done, true);
  const rejectedWithSelection = structuredClone(rejectedPremises);
  rejectedWithSelection.selected_candidate_id = "candidate_2";
  assert.equal(validatePremiseSelectionV2(rejectedWithSelection, premiseSelectionOptions).done, false);

  const stageApproval = {
    schema: SOURCE_STAGE_APPROVAL_SCHEMA,
    stage_id: "package_selection",
    source_sha256: HASHES.c,
    approved: true,
    approved_by: "operator_joel",
    approved_at: "2026-08-11T20:00:00.000Z",
    selected_id: "candidate_2",
  };
  assert.equal(validateSourceStageApproval(stageApproval, {
    stageId: "package_selection",
    sourceSha256: HASHES.c,
    selectedId: "candidate_2",
  }).done, true);
  for (const mutate of [
    (value) => { value.stage_id = "unknown_stage"; },
    (value) => { value.source_sha256 = HASHES.d; },
    (value) => { value.approved = false; },
    (value) => { value.approved_by = ""; },
    (value) => { value.approved_at = "not-a-date"; },
    (value) => { value.selected_id = "candidate_3"; },
  ]) {
    const invalid = structuredClone(stageApproval);
    mutate(invalid);
    assert.equal(validateSourceStageApproval(invalid, {
      stageId: "package_selection",
      sourceSha256: HASHES.c,
      selectedId: "candidate_2",
    }).done, false);
  }
  for (const stageId of [
    "package_selection",
    "treatment_selection",
    "story_architecture",
    "longform_draft_selection",
    "final_script",
  ]) {
    const approval = { ...stageApproval, stage_id: stageId, selected_id: undefined };
    assert.equal(validateSourceStageApproval(approval, { stageId, sourceSha256: HASHES.c }).done, true);
  }

  const expectedDrafts = {
    codex: {
      sha256: HASHES.d,
      text: "Joey refused the sacrifice and the dungeon closed the gate behind him.",
    },
    gpt_web: {
      sha256: HASHES.e,
      text: "The dungeon waited while Joey studied the broken threshold.",
    },
    gemini_web: {
      sha256: HASHES.f,
      text: "Sera chose the dangerous bridge and carried the proof herself.",
    },
  };
  const longformSelection = {
    schema: LONGFORM_DRAFT_SELECTION_SCHEMA,
    status: "selected",
    package_sha256: HASHES.g,
    architecture_sha256: HASHES.h,
    drafts: Object.entries(expectedDrafts).map(([id, draft]) => ({ id, sha256: draft.sha256 })),
    selected_draft_id: "codex",
    decision_rationale: "The Codex draft has the clearest causal state changes and planted climax.",
    comparative_findings: [
      {
        dimension: "protagonist agency",
        draft_id: "codex",
        exact_anchor: "Joey refused the sacrifice",
        judgment: "The protagonist owns the first irreversible choice.",
      },
      {
        dimension: "supporting-character agency",
        draft_id: "gemini_web",
        exact_anchor: "Sera chose the dangerous bridge",
        judgment: "The supporting character acts independently.",
      },
    ],
    approved_transplants: [{
      from_draft_id: "gemini_web",
      component: "Sera independently carries the proof during the bridge reversal.",
      reason: "It strengthens relationship agency without merging plot architectures.",
    }],
    rejection_reason: null,
  };
  const longformOptions = {
    packageSha256: HASHES.g,
    architectureSha256: HASHES.h,
    expectedDrafts,
  };
  assert.equal(validateLongformDraftSelection(longformSelection, longformOptions).done, true);
  assert.equal(validateLongformDraftSelection(longformSelection, {
    ...longformOptions,
    requireOpeningVerdicts: true,
  }).done, false);
  const openingBoundSelection = structuredClone(longformSelection);
  openingBoundSelection.opening_verdicts = Object.entries(expectedDrafts).map(([id, draft]) => ({
    draft_id: id,
    decision: "pass",
    opening_mode: "dramatized",
    first_event_anchor: draft.text.split(" ").slice(0, 3).join(" "),
    dramatic_turn_anchor: draft.text.split(" ").slice(3, 6).join(" "),
    exposition_before_turn_anchor: null,
    new_proper_names_first_220: ["Joey"],
    unexplained_story_terms_first_220: [],
    judgment: "The opening depicts a developing event and reaches a counter or consequence.",
  }));
  assert.equal(validateLongformDraftSelection(openingBoundSelection, {
    ...longformOptions,
    requireOpeningVerdicts: true,
  }).done, true);
  const failedSelectedOpening = structuredClone(openingBoundSelection);
  failedSelectedOpening.opening_verdicts.find((row) => row.draft_id === failedSelectedOpening.selected_draft_id).decision = "fail";
  assert.equal(validateLongformDraftSelection(failedSelectedOpening, {
    ...longformOptions,
    requireOpeningVerdicts: true,
  }).done, false);
  const expositionFirstOpening = structuredClone(openingBoundSelection);
  const selectedOpening = expositionFirstOpening.opening_verdicts.find((row) => row.draft_id === expositionFirstOpening.selected_draft_id);
  selectedOpening.opening_mode = "exposition_first";
  selectedOpening.exposition_before_turn_anchor = selectedOpening.first_event_anchor;
  selectedOpening.new_proper_names_first_220 = ["Joey", "Marcus"];
  assert.equal(validateLongformDraftSelection(expositionFirstOpening, {
    ...longformOptions,
    requireOpeningVerdicts: true,
  }).done, false);
  assert.equal(validateLongformDraftSelection(longformSelection, { expectedDrafts }).done, false);
  for (const mutate of [
    (value) => { value.package_sha256 = HASHES.i; },
    (value) => { value.architecture_sha256 = HASHES.i; },
    (value) => { value.drafts[0].sha256 = HASHES.i; },
    (value) => { value.drafts.pop(); },
    (value) => { value.selected_draft_id = "unknown"; },
    (value) => { value.comparative_findings[0].draft_id = "unknown"; },
    (value) => { value.comparative_findings[0].exact_anchor = "invented excerpt"; },
    (value) => { value.approved_transplants = [
      ...value.approved_transplants,
      { from_draft_id: "gpt_web", component: "One", reason: "Narrow." },
      { from_draft_id: "gpt_web", component: "Two", reason: "Narrow." },
    ]; },
    (value) => { value.approved_transplants[0].from_draft_id = "codex"; },
  ]) {
    const invalid = structuredClone(longformSelection);
    mutate(invalid);
    assert.equal(validateLongformDraftSelection(invalid, longformOptions).done, false);
  }
  const rejectedDrafts = structuredClone(longformSelection);
  rejectedDrafts.status = "rejected";
  rejectedDrafts.selected_draft_id = null;
  rejectedDrafts.approved_transplants = [];
  rejectedDrafts.rejection_reason = "No draft satisfies the architecture without material repair.";
  assert.equal(validateLongformDraftSelection(rejectedDrafts, longformOptions).done, true);

  const architectureText = JSON.stringify(architecture(), null, 2);
  const architectureAnchor = '"protagonist_choice": "An owned choice."';
  const architectureStart = architectureText.indexOf(architectureAnchor);
  const architectureRedteam = {
    schema: ARCHITECTURE_REDTEAM_SCHEMA,
    status: "findings",
    architecture_sha256: HASHES.i,
    findings: [{
      id: "causal_gap_1",
      severity: "material",
      start_offset: architectureStart,
      end_offset: architectureStart + architectureAnchor.length,
      exact_text: architectureAnchor,
      defect: "The choice is named but its enabling evidence is not planted.",
      downstream_risk: "The climax could depend on an unearned mechanism.",
      smallest_repair_intent: "Add the enabling evidence to the earlier movement only.",
    }],
  };
  assert.equal(validateArchitectureRedteam(architectureRedteam, {
    architectureText,
    architectureSha256: HASHES.i,
  }).done, true);
  assert.equal(validateArchitectureRedteam(architectureRedteam, { architectureText }).done, false);
  for (const mutate of [
    (value) => { value.architecture_sha256 = HASHES.j; },
    (value) => { value.findings[0].start_offset += 1; },
    (value) => { value.findings[0].exact_text = "invented anchor"; },
    (value) => { value.findings[0].severity = "advisory"; },
    (value) => { value.findings[0].downstream_risk = ""; },
    (value) => { value.status = "passed"; },
  ]) {
    const invalid = structuredClone(architectureRedteam);
    mutate(invalid);
    assert.equal(validateArchitectureRedteam(invalid, {
      architectureText,
      architectureSha256: HASHES.i,
    }).done, false);
  }
  const passedRedteam = {
    schema: ARCHITECTURE_REDTEAM_SCHEMA,
    status: "passed",
    architecture_sha256: HASHES.i,
    findings: [],
  };
  assert.equal(validateArchitectureRedteam(passedRedteam, {
    architectureText,
    architectureSha256: HASHES.i,
  }).done, true);

  const releaseOptions = {
    finalScriptSha256: HASHES.a,
    packageSelectionSha256: HASHES.b,
    packageSelectionApprovalSha256: HASHES.c,
    treatmentSelectionSha256: HASHES.d,
    treatmentSelectionApprovalSha256: HASHES.e,
    architectureSha256: HASHES.f,
    architectureApprovalSha256: HASHES.g,
    longformDraftSelectionSha256: HASHES.h,
    diagnosticSha256s: { causality_learning: HASHES.i, promise_continuity: HASHES.j, narrative_authenticity: HASHES.n },
    revisionLedgerSha256: HASHES.k,
    semanticAcceptanceSha256: HASHES.l,
    finalScriptApprovalSha256: HASHES.m,
    referenceMeritFrontierSha256: HASHES.o,
    referenceSha256: HASHES.p,
    viewerTournamentAcceptanceSha256: HASHES.f,
    viewerTournamentManifestSha256: HASHES.g,
    viewerTournamentReportSha256s: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`viewer_${index}`, HASHES.h])),
    requireViewerTournamentAcceptance: true,
    sourceRoomContractSha256: HASHES.i,
    sourceRoomProfile: "reference_density_frontier_tournament_v3",
    requireSourceRoomContract: true,
  };
  const sourceRoomRelease = {
    schema: SOURCE_ROOM_RELEASE_V2_SCHEMA,
    status: "released",
    final_script_sha256: HASHES.a,
    package_selection_sha256: HASHES.b,
    package_selection_approval_sha256: HASHES.c,
    treatment_selection_sha256: HASHES.d,
    treatment_selection_approval_sha256: HASHES.e,
    architecture_sha256: HASHES.f,
    architecture_approval_sha256: HASHES.g,
    longform_draft_selection_sha256: HASHES.h,
    diagnostic_sha256s: { causality_learning: HASHES.i, promise_continuity: HASHES.j, narrative_authenticity: HASHES.n },
    revision_ledger_sha256: HASHES.k,
    semantic_acceptance_sha256: HASHES.l,
    final_script_approval_sha256: HASHES.m,
    reference_merit_frontier_sha256: HASHES.o,
    reference_sha256: HASHES.p,
    viewer_tournament_acceptance_sha256: HASHES.f,
    viewer_tournament_manifest_sha256: HASHES.g,
    viewer_tournament_report_sha256s: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`viewer_${index}`, HASHES.h])),
    source_room_profile: "reference_density_frontier_tournament_v3",
    source_room_contract_path: "/tmp/source_room_contract.json",
    source_room_contract_sha256: HASHES.i,
  };
  assert.equal(validateSourceRoomReleaseV2(sourceRoomRelease, releaseOptions).done, true);
  assert.equal(validateSourceRoomReleaseV2(sourceRoomRelease).done, false);
  for (const field of [
    "final_script_sha256",
    "package_selection_sha256",
    "package_selection_approval_sha256",
    "treatment_selection_sha256",
    "treatment_selection_approval_sha256",
    "architecture_sha256",
    "architecture_approval_sha256",
    "longform_draft_selection_sha256",
    "revision_ledger_sha256",
    "semantic_acceptance_sha256",
    "final_script_approval_sha256",
    "reference_merit_frontier_sha256",
    "reference_sha256",
    "viewer_tournament_acceptance_sha256",
    "viewer_tournament_manifest_sha256",
    "source_room_contract_sha256",
  ]) {
    const invalid = structuredClone(sourceRoomRelease);
    invalid[field] = HASHES.n;
    assert.equal(validateSourceRoomReleaseV2(invalid, releaseOptions).done, false, `${field} must bind exactly`);
  }
  const staleDiagnostics = structuredClone(sourceRoomRelease);
  staleDiagnostics.diagnostic_sha256s.promise_continuity = HASHES.n;
  assert.equal(validateSourceRoomReleaseV2(staleDiagnostics, releaseOptions).done, false);
  const extraDiagnostic = structuredClone(sourceRoomRelease);
  extraDiagnostic.diagnostic_sha256s.unbound_extra = HASHES.o;
  assert.equal(validateSourceRoomReleaseV2(extraDiagnostic, releaseOptions).done, false);
  const staleViewerReport = structuredClone(sourceRoomRelease);
  staleViewerReport.viewer_tournament_report_sha256s.viewer_0 = HASHES.n;
  assert.equal(validateSourceRoomReleaseV2(staleViewerReport, releaseOptions).done, false);
  const missingViewerGate = structuredClone(sourceRoomRelease);
  delete missingViewerGate.viewer_tournament_acceptance_sha256;
  assert.equal(validateSourceRoomReleaseV2(missingViewerGate, releaseOptions).done, false);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runWinnerSourceRoomV2ContractTests();
  console.log("winner source room v2 contract tests passed");
}
