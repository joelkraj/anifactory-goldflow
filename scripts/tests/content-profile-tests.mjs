import assert from "node:assert/strict";
import {
  contentProfileDefinition,
  contentProfileSceneStylePhrase,
  contentProfileSceneStyleSatisfied,
} from "../lib/content-profiles.mjs";
import {
  factualEvidenceBinding,
  validateFactualEvidenceLedger,
} from "../lib/factual-evidence-contract.mjs";
import { buildStageCommand } from "../lib/pipeline-stage-registry.mjs";
import { scenePromptProductionContractFindingsForTests } from "../imagegen.mjs";
import { contentStatusIdentityFields } from "../run-status.mjs";
import { minimumPauseEventsForProfile } from "../voice-direction-gate.mjs";

export async function runContentProfileTests() {
  const manhwa = contentProfileDefinition("manhwa");
  const documentary = contentProfileDefinition("asset-afterlife");

  assert.equal(manhwa.id, "manhwa_recap_v1");
  assert.equal(documentary.id, "asset_afterlife_v1");
  assert.match(contentProfileSceneStylePhrase(documentary.config), /factual documentary/i);
  assert.equal(
    contentProfileSceneStyleSatisfied(
      "A tracked suitcase enters a sorting bay. 16:9 landscape cinematic factual documentary reconstruction.",
      documentary.config,
    ),
    true,
  );
  assert.equal(
    contentProfileSceneStyleSatisfied("A generic anime frame.", documentary.config),
    false,
  );
  assert.equal(minimumPauseEventsForProfile(documentary.config), 0);
  assert.equal(minimumPauseEventsForProfile(manhwa.config), 2);

  const ledger = {
    schema: "goldflow_factual_evidence_ledger_v1",
    content_profile: "asset_afterlife_v1",
    title: "Where Lost Luggage Goes When Nobody Claims It",
    researched_at: "2026-08-01T20:58:00Z",
    claims: [{
      claim_id: "claim_001",
      statement: "Airlines must compensate passengers for qualifying lost domestic baggage up to the applicable liability limit.",
      claim_type: "legal_rule",
      scope: "United States domestic airline baggage",
      sources: [{
        url: "https://www.transportation.gov/lost-delayed-or-damaged-baggage",
        title: "Lost, Delayed, or Damaged Baggage",
        publisher: "U.S. Department of Transportation",
        source_type: "primary_authority",
      }],
    }],
  };
  const bytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
  assert.equal(validateFactualEvidenceLedger(ledger, { expectedProfileId: documentary.id }).done, true);
  assert.equal(
    factualEvidenceBinding(ledger, bytes, "/tmp/evidence.json", { expectedProfileId: documentary.id }).claim_count,
    1,
  );
  assert.equal(
    validateFactualEvidenceLedger({ ...ledger, claims: [] }, { expectedProfileId: documentary.id }).done,
    false,
  );

  const standaloneProofIdentity = {
    channel: "assetafterlife",
    series_slug: "asset-afterlife",
    week: "proof-v1",
    episode: "ep_01",
    production_profile: "fast_premium_v1",
    proof_scope: { mode: "bounded", start_sec: 0, end_sec: 180 },
    proof_source_mode: "standalone_bounded_source",
  };
  const semanticCommand = buildStageCommand("semantic_scene_plan", standaloneProofIdentity);
  assert.doesNotMatch(semanticCommand, /proof-baseline-word-timing/);
  const statusIdentity = {
    ...standaloneProofIdentity,
    ...contentStatusIdentityFields({
      ...standaloneProofIdentity,
      source_path: "/tmp/script.md",
      content_profile: documentary.id,
      content_profile_version: documentary.config.version,
      content_profile_sha256: documentary.sha256,
      content_profile_config: documentary.config,
      factual_evidence: { sha256: "evidence-sha" },
    }),
  };
  assert.equal(statusIdentity.proof_source_mode, "standalone_bounded_source");
  assert.equal(statusIdentity.content_profile, documentary.id);
  assert.equal(statusIdentity.factual_evidence.sha256, "evidence-sha");
  assert.doesNotMatch(buildStageCommand("semantic_scene_plan", statusIdentity), /proof-baseline-word-timing/);
  const audioMixCommand = buildStageCommand("longform_audio_mix", {
    ...statusIdentity,
    audio_target: "scored_sfx",
  });
  assert.match(audioMixCommand, /--score-bed-trim-db -3\.5/);
  assert.match(audioMixCommand, /--score-bed-level-mode fixed_ducked/);
  assert.match(audioMixCommand, /--score-bed-fixed-duck-db -16\.23/);
  assert.doesNotMatch(audioMixCommand, /--score-narration-ducking true/);
  const renderCommand = buildStageCommand("premium_render", standaloneProofIdentity);
  assert.match(renderCommand, /--diagnostic-proof true/);
  assert.match(renderCommand, /--proof-scope-end-sec 180/);
  const baselineProofCommand = buildStageCommand("semantic_scene_plan", {
    ...standaloneProofIdentity,
    proof_source_mode: "audited_baseline_or_full_source",
  });
  assert.match(baselineProofCommand, /proof-baseline-word-timing/);

  const styleFindings = scenePromptProductionContractFindingsForTests([{
    image_id: "ep_01-cut-001",
    provider_prompt: "A red suitcase travels alone through a baggage sorting bay. 16:9 landscape cinematic factual documentary reconstruction.",
    shot_manifest: { shot_job: "asset_hero", foreground_action: "The suitcase crosses the scanner." },
    reference_requirements: [],
  }], { contentProfile: documentary.config });
  assert.equal(styleFindings.some((finding) => finding.code === "scene_prompt_style_contract_missing"), false);

  const wrongStyleFindings = scenePromptProductionContractFindingsForTests([{
    image_id: "ep_01-cut-002",
    provider_prompt: "A red suitcase travels alone through a baggage sorting bay.",
    shot_manifest: { shot_job: "asset_hero", foreground_action: "The suitcase crosses the scanner." },
    reference_requirements: [],
  }], { contentProfile: documentary.config });
  assert.equal(wrongStyleFindings.some((finding) => finding.code === "scene_prompt_style_contract_missing"), true);
}
