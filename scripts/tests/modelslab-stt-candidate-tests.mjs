import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveAudioResponse,
} from "../modelslab-qwen-episode-audio.mjs";
import {
  mergeModelslabSttChunksForTests,
  modelslabSttProviderProfileForTests,
  modelslabSttResponseHasFinalTranscriptionForTests,
  normalizeModelslabSttPayloadForTests,
  planModelslabSttChunksForTests,
  redactModelslabErrorTextForStorageForTests,
  redactModelslabPayloadForStorageForTests,
  validateLocalWhisperBaselineContractForTests,
  validateModelslabSttCandidateForTests,
  validateModelslabSttInvocationForTests,
  validateModelslabSttUploadSizeForTests,
  validateModelslabTranscriptBindingForTests,
} from "../lib/modelslab-stt-candidate.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function testProviderProfilesAndSpendGuards() {
  const v6 = modelslabSttProviderProfileForTests();
  assert.equal(v6.id, "v6_standard");
  assert.equal(v6.endpoint, "/api/v6/voice/speech_to_text");
  assert.equal(v6.model_id, "speech-to-text");
  assert.equal(v6.timestamp_level, "word");
  assert.equal(v6.premium, false);

  const v7 = modelslabSttProviderProfileForTests("v7_scribe");
  assert.equal(v7.endpoint, "/api/v7/voice/speech-to-text");
  assert.equal(v7.model_id, "scribe_v1");
  assert.equal(v7.price_usd_per_sec, 0.001);
  assert.equal(v7.premium, true);

  assert.throws(() => validateModelslabSttInvocationForTests({
    diagnostic: false,
    confirmSpend: true,
  }), /--diagnostic true/i);
  assert.throws(() => validateModelslabSttInvocationForTests({
    diagnostic: true,
    confirmSpend: false,
  }), /--confirm-spend true/i);
  assert.throws(() => validateModelslabSttInvocationForTests({
    diagnostic: true,
    confirmSpend: true,
    provider: "v7_scribe",
  }), /--confirm-premium-cost true/i);
  assert.equal(validateModelslabSttInvocationForTests({
    diagnostic: true,
    confirmSpend: true,
    confirmPremiumCost: true,
    provider: "v7_scribe",
  }).status, "passed");
}

function testProviderPayloadRedaction() {
  assert.deepEqual(redactModelslabPayloadForStorageForTests({
    status: "success",
    key: "top-secret",
    meta: {
      api_key: "nested-secret",
      Authorization: "Bearer secret",
      model_id: "speech-to-text",
    },
  }), {
    status: "success",
    key: "[REDACTED]",
    meta: {
      api_key: "[REDACTED]",
      Authorization: "[REDACTED]",
      model_id: "speech-to-text",
    },
  });
  assert.equal(
    redactModelslabPayloadForStorageForTests(
      "https://example.test/result?key=secret&id=12",
    ),
    "https://example.test/result?key=%5BREDACTED%5D&id=12",
  );
  assert.equal(
    redactModelslabErrorTextForStorageForTests(
      'failed: {"key":"top-secret","message":"no"} Bearer abc.def',
    ),
    'failed: {"key":[REDACTED],"message":"no"} Bearer [REDACTED]',
  );
}

function testTranscriptBinding() {
  assert.equal(validateModelslabTranscriptBindingForTests({
    sourceAudioSha256: "audio-sha",
    narrationReportAudioSha256: "audio-sha",
  }).transcript_source, "hash_bound_narration_report");
  assert.equal(validateModelslabTranscriptBindingForTests({
    sourceAudioSha256: "override-sha",
    narrationReportAudioSha256: null,
    explicitExpectedTranscript: true,
  }).transcript_source, "explicit_expected_transcript");
  assert.throws(() => validateModelslabTranscriptBindingForTests({
    sourceAudioSha256: "override-sha",
    narrationReportAudioSha256: null,
  }), /--expected-transcript/iu);
  assert.throws(() => validateModelslabTranscriptBindingForTests({
    sourceAudioSha256: "audio-sha",
    narrationReportAudioSha256: "stale-sha",
    explicitExpectedTranscript: true,
  }), /does not match the narration report/iu);
}

async function testDocumentedResponseNormalization() {
  const fixturePath = path.join(
    repoRoot,
    "scripts/fixtures/audio/modelslab_stt_responses.json",
  );
  const fixtures = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  const v6 = normalizeModelslabSttPayloadForTests(
    fixtures.v6_output_object,
  );
  assert.equal(v6.text, "The deedholder crossed the gate.");
  assert.equal(v6.words.length, 5);
  assert.equal(v6.words[1].word, "deedholder");
  assert.equal(v6.words[1].start_sec, 0.29);
  assert.equal(v6.words[1].probability, 0.98);

  const v7 = normalizeModelslabSttPayloadForTests(
    fixtures.v7_nested_transcription,
  );
  assert.equal(v7.text, "System warning confirmed.");
  assert.equal(v7.words.length, 3);
  assert.equal(v7.words[2].end_sec, 1.31);
  assert.equal(modelslabSttResponseHasFinalTranscriptionForTests({
    ...fixtures.v7_nested_transcription,
    status: "processing",
  }), false);
  assert.equal(modelslabSttResponseHasFinalTranscriptionForTests(
    fixtures.v7_nested_transcription,
  ), true);
  let fetchCount = 0;
  const resolvedInline = await resolveAudioResponse({
    status: "processing",
    id: 72001,
  }, {
    fetchEndpoint: "/api/v7/voice/fetch",
    operationLabel: "ModelsLab STT test",
    completionPredicate:
      modelslabSttResponseHasFinalTranscriptionForTests,
    pollIntervalMs: 0,
    requestFetcher: async () => {
      fetchCount += 1;
      return fixtures.v7_nested_transcription;
    },
  });
  assert.equal(fetchCount, 1);
  assert.equal(resolvedInline.id, 72001);

  const scribe = normalizeModelslabSttPayloadForTests(
    fixtures.v7_scribe_spacing_tokens,
  );
  assert.equal(scribe.text, "The gate opened.");
  assert.deepEqual(
    scribe.words.map((row) => row.word),
    ["The", "gate", "opened."],
  );

  const sentenceOnly = normalizeModelslabSttPayloadForTests({
    text: "The gate opened.",
    chunks: [{
      text: "The gate opened.",
      start: 0.1,
      end: 0.83,
    }],
  });
  assert.equal(sentenceOnly.words.length, 0);

  const nestedSegments = normalizeModelslabSttPayloadForTests({
    segments: [{
      text: "The gate opened.",
      words: [
        { word: "The", start: 0.1, end: 0.24 },
        { word: "gate", start: 0.26, end: 0.48 },
        { word: "opened.", start: 0.5, end: 0.83 },
      ],
    }],
  });
  assert.equal(nestedSegments.words.length, 3);

  const plainText = normalizeModelslabSttPayloadForTests(
    fixtures.downloaded_plain_text,
  );
  assert.equal(plainText.text, "The final gate opened.");
  assert.equal(plainText.words.length, 0);
}

function testChunkPlanningHonorsProviderLimits() {
  assert.deepEqual(planModelslabSttChunksForTests(399), [{
    chunk_id: "chunk_0001",
    index: 0,
    start_sec: 0,
    end_sec: 399,
    duration_sec: 399,
    overlap_with_previous_sec: 0,
  }]);
  const long = planModelslabSttChunksForTests(6602);
  assert.ok(long.length >= 17);
  assert.equal(long[0].duration_sec <= 400, true);
  assert.equal(long.every((row) => row.duration_sec >= 5), true);
  assert.equal(long.every((row) => row.duration_sec <= 420), true);
  assert.equal(long.at(-1).end_sec, 6602);
  assert.throws(
    () => planModelslabSttChunksForTests(4.99),
    /at least 5 seconds/i,
  );
  assert.throws(
    () => planModelslabSttChunksForTests(100, { maxChunkSec: 421 }),
    /between 5 and 420 seconds/i,
  );
  assert.equal(
    validateModelslabSttUploadSizeForTests(3_000_000).status,
    "passed",
  );
  assert.throws(
    () => validateModelslabSttUploadSizeForTests(3_600_000),
    /base64 gateway limit/iu,
  );
}

function testChunkMergeOffsetsAndDropsOverlap() {
  const merged = mergeModelslabSttChunksForTests([{
    chunk_id: "chunk_0001",
    start_sec: 0,
    end_sec: 10,
    duration_sec: 10,
    words: [
      { word: "first", start_sec: 0.1, end_sec: 0.3 },
      { word: "boundary", start_sec: 9.7, end_sec: 9.95 },
    ],
  }, {
    chunk_id: "chunk_0002",
    start_sec: 8,
    end_sec: 18,
    duration_sec: 10,
    words: [
      { word: "boundary", start_sec: 1.7, end_sec: 1.95 },
      { word: "continues", start_sec: 2.05, end_sec: 2.4 },
    ],
  }]);
  assert.deepEqual(merged.words.map((row) => row.word), [
    "first",
    "boundary",
    "continues",
  ]);
  assert.equal(merged.words[2].start_sec, 10.05);
  assert.equal(merged.chunks[1].overlap_word_count_discarded, 1);
}

function testTranscriptTimingAndPromotionValidation() {
  const words = [
    { word: "The", start_sec: 0.1, end_sec: 0.25 },
    { word: "gate", start_sec: 0.27, end_sec: 0.55 },
    { word: "opened", start_sec: 0.57, end_sec: 0.92 },
  ];
  const baseline = words.map((row) => ({ ...row }));
  const baselineContract = validateLocalWhisperBaselineContractForTests({
    status: "passed",
    narration_audio_hash: "audio-sha",
    alignment_engine: "faster_whisper",
    alignment_model: "medium",
    full_stream_transcript_qa: { status: "passed" },
    words: baseline,
  }, "audio-sha");
  assert.equal(baselineContract.status, "passed");
  const passed = validateModelslabSttCandidateForTests({
    words,
    recognizedText: "The gate opened.",
    expectedText: "The gate opened.",
    audioDurationSec: 5,
    baselineWords: baseline,
    baselineContract,
  });
  assert.equal(passed.status, "passed");
  assert.equal(
    passed.production_timing_promotion.status,
    "eligible",
  );
  assert.equal(
    passed.production_timing_promotion.promotion_applied,
    false,
  );
  assert.equal(
    passed.production_timing_promotion.canonical_timing_untouched,
    true,
  );

  const noBaseline = validateModelslabSttCandidateForTests({
    words,
    recognizedText: "The gate opened.",
    expectedText: "The gate opened.",
    audioDurationSec: 5,
  });
  assert.equal(noBaseline.status, "passed");
  assert.equal(
    noBaseline.production_timing_promotion.status,
    "ineligible",
  );
  assert.equal(
    noBaseline.local_whisper_timing_comparison.status,
    "not_run",
  );

  const noncanonicalBaseline = validateLocalWhisperBaselineContractForTests({
    status: "passed",
    narration_audio_hash: "audio-sha",
    alignment_engine: "faster_whisper",
    alignment_model: "small",
    full_stream_transcript_qa: { status: "passed" },
    words: baseline,
  }, "audio-sha");
  const ineligibleBaseline = validateModelslabSttCandidateForTests({
    words,
    recognizedText: "The gate opened.",
    expectedText: "The gate opened.",
    audioDurationSec: 5,
    baselineWords: baseline,
    baselineContract: noncanonicalBaseline,
  });
  assert.equal(ineligibleBaseline.status, "passed");
  assert.equal(
    ineligibleBaseline.production_timing_promotion.status,
    "ineligible",
  );
  assert.equal(
    ineligibleBaseline.production_timing_promotion.blockers.some(
      (row) => row.code === "modelslab_stt_baseline_model_not_medium",
    ),
    true,
  );

  const blocked = validateModelslabSttCandidateForTests({
    words: [
      { word: "wrong", start_sec: 0.4, end_sec: 0.6 },
      { word: "order", start_sec: 0.2, end_sec: 0.3 },
    ],
    recognizedText: "wrong order",
    expectedText: "the gate opened",
    audioDurationSec: 5,
    baselineWords: baseline,
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(
    blocked.timing_validation.blockers.some(
      (row) => row.code === "modelslab_stt_timestamp_not_monotonic",
    ),
    true,
  );
  assert.equal(
    blocked.transcript_validation.blockers.some(
      (row) => row.code === "modelslab_stt_transcript_wer_exceeds_limit",
    ),
    true,
  );
  assert.equal(
    blocked.production_timing_promotion.status,
    "ineligible",
  );
}

function testTenThousandWordAlignmentIsBounded() {
  const words = Array.from({ length: 10_000 }, (_, index) => ({
    word: `word${index}`,
    start_sec: index * 0.25,
    end_sec: index * 0.25 + 0.2,
  }));
  const text = words.map((row) => row.word).join(" ");
  const baselineContract = validateLocalWhisperBaselineContractForTests({
    status: "passed",
    narration_audio_hash: "long-audio-sha",
    alignment_engine: "faster_whisper",
    alignment_model: "medium",
    full_stream_transcript_qa: { status: "passed" },
    words,
  }, "long-audio-sha");
  const result = validateModelslabSttCandidateForTests({
    words,
    recognizedText: text,
    expectedText: text,
    audioDurationSec: 2501,
    baselineWords: words,
    baselineContract,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.transcript_validation.edit_distance, 0);
  assert.equal(result.transcript_validation.matched_word_count, 10_000);
  assert.equal(
    result.transcript_validation.alignment_algorithm,
    "banded_levenshtein_v1",
  );
  assert.equal(
    result.production_timing_promotion.status,
    "eligible",
  );
}

await testProviderProfilesAndSpendGuards();
testProviderPayloadRedaction();
testTranscriptBinding();
await testDocumentedResponseNormalization();
testChunkPlanningHonorsProviderLimits();
testChunkMergeOffsetsAndDropsOverlap();
testTranscriptTimingAndPromotionValidation();
testTenThousandWordAlignmentIsBounded();
