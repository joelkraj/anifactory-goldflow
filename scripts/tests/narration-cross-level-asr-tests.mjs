import assert from "node:assert/strict";
import {
  crossLevelArticleFusionCandidate,
  corroborateCrossLevelArticleFusion,
} from "../lib/narration-cross-level-asr.mjs";

const sha = (letter) => letter.repeat(64);
const exact = (tokens) => ({
  deletions: 0, insertions: 0, substitutions: 0,
  first_token_ok: true, last_token_ok: true,
  operations: tokens.map((token) => ({ type: "match", intended: token, recognized: token })),
});
const tokens = ["was", "that", "a", "morrow", "joey"];
const fullQa = () => ({
  deletions: 1, insertions: 0, substitutions: 1,
  first_token_ok: true, last_token_ok: true,
  operations: [
    { type: "match", intended: "was", recognized: "was" },
    { type: "match", intended: "that", recognized: "that" },
    { type: "deletion", intended: "a", recognized: null },
    { type: "substitution", intended: "morrow", recognized: "amaro" },
    { type: "match", intended: "joey", recognized: "joey" },
  ],
});
const window = () => ({
  window_id: "window-1", unit_ids: ["unit-1"], boundary_ids: [],
  audio_sha256: sha("d"), source_audio_sha256: sha("c"),
  primary_transcript_qa: fullQa(), confirmation_transcript_qa: fullQa(),
  decision: { status: "blocked", blockers: [{
    code: "narration_confirmed_word_omission", intended_tokens: ["a"],
  }], warnings: [] },
});
const recognition = () => ({
  canonical_token_count: tokens.length,
  words: tokens.map((token, index) => ({
    word: token, start_sec: index * 0.2, end_sec: (index + 1) * 0.2,
    probability: 0.9,
  })),
});
const evidence = () => ({
  unit_id: "unit-1", source_audio_sha256: sha("a"),
  prepared_audio_sha256: sha("b"), master_audio_sha256: sha("c"),
  window_audio_sha256: sha("d"), sample_accounting_exact: true,
  join_qa_passed: true, prepared_speech_preserved: true,
  pcm_integrity: { status: "passed", prepared_pcm_sha256: sha("e"),
    raw_stitch_span_pcm_sha256: sha("e"),
    article_master_raw_correlation: 0.9998 },
  unit_small_qa: exact(tokens), unit_medium_raw_qa: exact(tokens),
  unit_medium_prepared_qa: exact(tokens),
  unit_medium_raw: recognition(), unit_medium_prepared: recognition(),
});

assert.deepEqual(crossLevelArticleFusionCandidate(window()), {
  intended_index: 2, article: "a", following_intended_token: "morrow",
  fused_recognized_token: "amaro", unit_id: "unit-1",
});
const resolved = corroborateCrossLevelArticleFusion(window(), evidence());
assert.equal(resolved.corroborated, true);
assert.equal(resolved.window.decision.status, "passed_with_warnings");
assert.deepEqual(resolved.window.decision.blockers, []);
assert.equal(resolved.window.decision.warnings.at(-1).code,
  "narration_cross_level_article_fusion_corroborated");

const trueDeletion = window();
trueDeletion.primary_transcript_qa.operations[3] = {
  type: "match", intended: "morrow", recognized: "morrow",
};
trueDeletion.confirmation_transcript_qa.operations[3] = {
  type: "match", intended: "morrow", recognized: "morrow",
};
assert.equal(crossLevelArticleFusionCandidate(trueDeletion), null);
assert.equal(corroborateCrossLevelArticleFusion(trueDeletion, evidence()).corroborated, false);

const localDeletion = evidence();
localDeletion.unit_medium_raw_qa = { ...exact(tokens), deletions: 1 };
assert.equal(corroborateCrossLevelArticleFusion(window(), localDeletion).corroborated, false);
const staleAudio = evidence();
staleAudio.master_audio_sha256 = sha("e");
assert.equal(corroborateCrossLevelArticleFusion(window(), staleAudio).corroborated, false);
const alteredPreparedSpan = evidence();
alteredPreparedSpan.pcm_integrity.raw_stitch_span_pcm_sha256 = sha("f");
assert.equal(corroborateCrossLevelArticleFusion(window(), alteredPreparedSpan).corroborated, false);
const droppedMasterArticle = evidence();
droppedMasterArticle.pcm_integrity.article_master_raw_correlation = 0.5;
assert.equal(corroborateCrossLevelArticleFusion(window(), droppedMasterArticle).corroborated, false);
for (const key of ["sample_accounting_exact", "join_qa_passed", "prepared_speech_preserved"]) {
  const bad = evidence(); bad[key] = false;
  assert.equal(corroborateCrossLevelArticleFusion(window(), bad).corroborated, false);
}
const lowConfidence = evidence();
lowConfidence.unit_medium_prepared.words[2].probability = 0.1;
assert.equal(corroborateCrossLevelArticleFusion(window(), lowConfidence).corroborated, false);
const otherBlocker = window();
otherBlocker.decision.blockers.push({ code: "narration_confirmed_final_token_mismatch" });
assert.equal(corroborateCrossLevelArticleFusion(otherBlocker, evidence()).corroborated, false);
const joinDefect = window(); joinDefect.boundary_ids = ["left__right"];
assert.equal(corroborateCrossLevelArticleFusion(joinDefect, evidence()).corroborated, false);
console.log("narration-cross-level-asr-tests: passed");
