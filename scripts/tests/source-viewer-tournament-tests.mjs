import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  evaluateViewerTournament,
  exactViewerExcerptExistsForTests,
  mapViewerPreference,
  validateViewerTournamentAcceptance,
} from "../lib/source-viewer-tournament-contract.mjs";
import { applyExactViewerPatches } from "../source-viewer-tournament-patch.mjs";
import { sourceViewerPanel } from "../lib/source-viewer-profile-bank.mjs";

assert.equal(exactViewerExcerptExistsForTests('"Keep the inheritance."', '“Keep the inheritance.”'), true);
assert.equal(exactViewerExcerptExistsForTests('one - two', 'one — two'), true);
assert.equal(exactViewerExcerptExistsForTests('"same quote"', '“same quote” and “same quote” again'), false);
assert.equal(exactViewerExcerptExistsForTests('invented paraphrase', 'different exact prose'), false);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function report(personaId, candidateLabel, preferences, overall = candidateLabel) {
  const referenceLabel = candidateLabel === "SCRIPT A" ? "SCRIPT B" : "SCRIPT A";
  return {
    schema: "goldflow_simulated_manhwa_viewer_v2",
    persona_id: personaId,
    script_label_map: { candidate: candidateLabel, reference: referenceLabel },
    checkpoint_preferences: Object.entries(preferences).map(([checkpoint, preference]) => ({ checkpoint, preference })),
    dimension_preferences: [
      "opening_quality",
      "average_percentage_viewed_potential",
      "emotional_satisfaction",
      "power_fantasy_satisfaction",
      "clarity",
      "freshness",
      "ending_payoff",
    ].map((dimension) => ({ dimension, preference: candidateLabel })),
    overall_preference: overall,
    apv_preference: candidateLabel,
    estimated_percentage_viewed: candidateLabel === "SCRIPT A"
      ? { A: 60, B: 40, rationale: "fixture" }
      : { A: 40, B: 60, rationale: "fixture" },
  };
}

const checkpoints = Object.fromEntries(["30_seconds", "60_seconds", "3_minutes", "5_minutes", "middle", "ending", "overall"].map((id) => [id, "SCRIPT A"]));
const passing = Array.from({ length: 10 }, (_, index) => report(`viewer_${index}`, "SCRIPT A", checkpoints));
assert.equal(evaluateViewerTournament(passing).status, "accepted");
assert.equal(mapViewerPreference(report("x", "SCRIPT B", {}), "B"), "candidate");

const panelSeed = "stable-panel-seed";
const panel = sourceViewerPanel(panelSeed);
const panelReports = panel.map((profile, index) => report(profile.id, index % 2 === 0 ? "SCRIPT A" : "SCRIPT B", Object.fromEntries(
  Object.keys(checkpoints).map((checkpoint) => [checkpoint, index % 2 === 0 ? "SCRIPT A" : "SCRIPT B"]),
), index % 2 === 0 ? "SCRIPT A" : "SCRIPT B"));
const reportSha256s = Object.fromEntries(panelReports.map((row) => [row.persona_id, sha256(JSON.stringify(row))]));
const manifest = {
  schema: "goldflow_simulated_manhwa_viewer_tournament_v2",
  candidate_sha256: "a".repeat(64),
  reference_sha256: "b".repeat(64),
  panel_seed: panelSeed,
  panel_profile_ids: panel.map((profile) => profile.id),
  control_viewer_count: 5,
  rotating_viewer_count: 5,
  viewer_count: 10,
  receipts: panelReports.map((row) => ({ persona_id: row.persona_id, output_sha256: reportSha256s[row.persona_id] })),
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
const panelEvaluation = evaluateViewerTournament(panelReports);
const acceptance = {
  schema: "goldflow_simulated_manhwa_viewer_acceptance_v2",
  ...panelEvaluation,
  candidate_sha256: manifest.candidate_sha256,
  reference_sha256: manifest.reference_sha256,
  viewer_manifest_sha256: sha256(JSON.stringify(manifest)),
  viewer_manifest_file_sha256: sha256(manifestBytes),
  viewer_report_sha256s: reportSha256s,
};
assert.equal(validateViewerTournamentAcceptance(acceptance, {
  candidateSha256: manifest.candidate_sha256,
  referenceSha256: manifest.reference_sha256,
  manifest,
  manifestFileSha256: sha256(manifestBytes),
  reports: panelReports,
  reportSha256s,
  requireAccepted: true,
}).done, true);
const staleAcceptance = structuredClone(acceptance);
staleAcceptance.viewer_report_sha256s[panel[0].id] = "c".repeat(64);
assert.equal(validateViewerTournamentAcceptance(staleAcceptance, {
  candidateSha256: manifest.candidate_sha256,
  referenceSha256: manifest.reference_sha256,
  manifest,
  manifestFileSha256: sha256(manifestBytes),
  reports: panelReports,
  reportSha256s,
  requireAccepted: true,
}).done, false);

const anchoredCandidateText = "Candidate opening exact anchor. Candidate ending exact anchor.";
const anchoredReferenceText = "Reference opening exact anchor. Reference ending exact anchor.";
const anchoredReports = panel.map((profile, index) => {
  const candidateLabel = index % 2 === 0 ? "SCRIPT A" : "SCRIPT B";
  const row = report(profile.id, candidateLabel, Object.fromEntries(
    Object.keys(checkpoints).map((checkpoint) => [checkpoint, candidateLabel]),
  ), candidateLabel);
  const aAnchor = candidateLabel === "SCRIPT A" ? "Candidate opening exact anchor." : "Reference opening exact anchor.";
  const bAnchor = candidateLabel === "SCRIPT B" ? "Candidate opening exact anchor." : "Reference opening exact anchor.";
  row.checkpoint_preferences = row.checkpoint_preferences.map((checkpoint) => ({ ...checkpoint, a_anchor: aAnchor, b_anchor: bAnchor }));
  row.dimension_preferences = row.dimension_preferences.map((dimension) => ({ ...dimension, a_anchor: aAnchor, b_anchor: bAnchor }));
  row.earliest_leave_risk = {
    A: { exact_anchor: aAnchor, reason: "fixture" },
    B: { exact_anchor: bAnchor, reason: "fixture" },
  };
  row.weaker_script = candidateLabel === "SCRIPT A" ? "B" : "A";
  row.revision_notes = [];
  return row;
});
assert.equal(evaluateViewerTournament(anchoredReports, {
  candidateText: anchoredCandidateText,
  referenceText: anchoredReferenceText,
  requireExactAnchors: true,
}).status, "accepted");
const inventedAnchorReports = structuredClone(anchoredReports);
inventedAnchorReports[0].dimension_preferences[0].a_anchor = "Invented evidence.";
assert.ok(evaluateViewerTournament(inventedAnchorReports, {
  candidateText: anchoredCandidateText,
  referenceText: anchoredReferenceText,
  requireExactAnchors: true,
}).blockers.includes(`viewer_${panel[0].id}_dimension_opening_quality_a_anchor_invalid`));

const failing = structuredClone(passing);
for (let index = 0; index < 3; index += 1) failing[index].checkpoint_preferences[0].preference = "SCRIPT B";
const failed = evaluateViewerTournament(failing);
assert.equal(failed.status, "repair");
assert.ok(failed.blockers.includes("candidate_lacks_unanimous_dominance_30_seconds"));

const hyphenated = structuredClone(passing);
hyphenated[0].dimension_preferences[3].dimension = "power-fantasy satisfaction";
hyphenated[1].dimension_preferences[3].dimension = "power_fantasy_satisfaction";
assert.equal(evaluateViewerTournament(hyphenated).dimension_tallies.power_fantasy_satisfaction.candidate, 10);

const duplicated = structuredClone(passing);
duplicated[0].checkpoint_preferences.push(structuredClone(duplicated[0].checkpoint_preferences[0]));
assert.ok(evaluateViewerTournament(duplicated).blockers.includes("viewer_viewer_0_checkpoint_30_seconds_duplicate"));

const exactPatchResult = applyExactViewerPatches(
  "Alpha opening sentence. Beta middle sentence. Gamma ending sentence.",
  {
    schema: "goldflow_viewer_tournament_patch_v1",
    patches: [{
      checkpoint: "middle",
      rationale: "Add a visible reversal.",
      find: "Alpha opening sentence. Beta middle sentence. Gamma ending sentence.",
      replace: "Alpha opening sentence. Beta delivers a visible reversal. Gamma ending sentence.",
    }],
  },
);
assert.equal(exactPatchResult.revised, "Alpha opening sentence. Beta delivers a visible reversal. Gamma ending sentence.");
assert.equal(exactPatchResult.applied.length, 1);
const escapedLineBreakPatch = applyExactViewerPatches("Alpha opening sentence has enough words.\n\nBeta middle sentence has enough words.", {
  schema: "goldflow_viewer_tournament_patch_v1",
  patches: [{
    checkpoint: "middle",
    rationale: "Decode planner line breaks.",
    find: "Alpha opening sentence has enough words.\\n\\nBeta middle sentence has enough words.",
    replace: "Alpha opening sentence has enough words.\\n\\nBeta improved middle sentence has enough words.",
  }],
});
assert.equal(escapedLineBreakPatch.revised, "Alpha opening sentence has enough words.\n\nBeta improved middle sentence has enough words.");
assert.throws(
  () => applyExactViewerPatches("Repeat this unique enough phrase twice. Repeat this unique enough phrase twice.", {
    schema: "goldflow_viewer_tournament_patch_v1",
    patches: [{
      checkpoint: "middle",
      rationale: "Ambiguous patch.",
      find: "Repeat this unique enough phrase twice.",
      replace: "Replace the ambiguous phrase with this one.",
    }],
  }),
  /not unique/,
);

console.log("source viewer tournament tests passed");
