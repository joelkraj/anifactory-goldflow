import assert from "node:assert/strict";
import {
  assertDiagnosticOutputPathForTests,
  groupSimilarLengthUnitsForTests,
  summarizeBakeoffForTests,
  validateSourceRunReportForTests,
} from "../tts-qwen-throughput-bakeoff.mjs";
import { QWEN_LIAM_PRIMARY_LOCK } from "../lib/narration-tts-policy.mjs";

function sourceResult(unitId, index, wordCount) {
  const spokenText = `${Array.from(
    { length: wordCount - 1 },
    (_value, wordIndex) => `word${wordIndex + 1}`,
  ).join(" ")} finished.`;
  return {
    unit_id: unitId,
    status: "generated",
    seed: 1000 + index,
    spoken_text: spokenText,
    spoken_text_sha256: `text-${unitId}`,
    output_path: `/tmp/${unitId}.wav`,
    output_sha256: `audio-${unitId}`,
    duration_sec: wordCount / 3.5,
    generation_time_sec: wordCount / 10,
    synthesis_identity_sha256: `identity-${unitId}`,
    synthesis_identity: {
      provider: QWEN_LIAM_PRIMARY_LOCK.provider,
      model_revision: QWEN_LIAM_PRIMARY_LOCK.model_revision,
      reference_audio_sha256:
        QWEN_LIAM_PRIMARY_LOCK.reference_audio_sha256,
      reference_text_sha256:
        QWEN_LIAM_PRIMARY_LOCK.reference_text_sha256,
      voice: QWEN_LIAM_PRIMARY_LOCK.voice_id,
      post_tts_tempo_processing: false,
    },
  };
}

function sourceRun(results) {
  return {
    schema: "goldflow_local_tts_production_run_v1",
    status: "passed",
    provider: QWEN_LIAM_PRIMARY_LOCK.provider,
    model_id: QWEN_LIAM_PRIMARY_LOCK.model_id,
    model_revision: QWEN_LIAM_PRIMARY_LOCK.model_revision,
    model_weights_sha256: QWEN_LIAM_PRIMARY_LOCK.model_weights_sha256,
    model_config_sha256: QWEN_LIAM_PRIMARY_LOCK.model_config_sha256,
    voice_id: QWEN_LIAM_PRIMARY_LOCK.voice_id,
    voice_sha256: QWEN_LIAM_PRIMARY_LOCK.voice_sha256,
    voice_continuity_contract:
      QWEN_LIAM_PRIMARY_LOCK.voice_continuity_contract,
    reference_audio_sha256:
      QWEN_LIAM_PRIMARY_LOCK.reference_audio_sha256,
    reference_text_sha256:
      QWEN_LIAM_PRIMARY_LOCK.reference_text_sha256,
    runtime: {
      mlx_audio_version: QWEN_LIAM_PRIMARY_LOCK.runtime_version,
    },
    effective_concurrency: 1,
    model_load_count: 1,
    results,
  };
}

function testExactUnitScopeAndProductionIdentity() {
  const results = [
    sourceResult("u1", 0, 45),
    sourceResult("u2", 1, 46),
    sourceResult("u3", 2, 50),
    sourceResult("u4", 3, 51),
  ];
  const selected = validateSourceRunReportForTests(
    sourceRun(results),
    ["u4", "u1", "u3", "u2"],
  );
  assert.deepEqual(selected.map((unit) => unit.unit_id), ["u4", "u1", "u3", "u2"]);
  assert.deepEqual(selected.map((unit) => unit.word_count), [51, 45, 50, 46]);
  assert.throws(
    () => validateSourceRunReportForTests(sourceRun(results), ["u1"]),
    /2-8 unique exact unit IDs/u,
  );
  assert.throws(
    () => validateSourceRunReportForTests(
      { ...sourceRun(results), effective_concurrency: 2 },
      ["u1", "u2"],
    ),
    /production serial/u,
  );
  assert.throws(
    () => validateSourceRunReportForTests(
      { ...sourceRun(results), voice_id: "am_puck" },
      ["u1", "u2"],
    ),
    /not pinned Qwen\/Liam/u,
  );
}

function testSimilarLengthGroupingIsDeterministic() {
  const counts = [45, 60, 46, 59, 50, 51, 55, 54];
  const units = counts.map((wordCount, inputIndex) => ({
    unit_id: `u${inputIndex + 1}`,
    input_index: inputIndex,
    word_count: wordCount,
  }));
  const pairs = groupSimilarLengthUnitsForTests(units, 2);
  assert.deepEqual(
    pairs.map((group) => group.word_counts),
    [[45, 46], [50, 51], [54, 55], [59, 60]],
  );
  assert.deepEqual(
    pairs.map((group) => group.word_count_spread),
    [1, 1, 1, 1],
  );
  const fours = groupSimilarLengthUnitsForTests(units, 4);
  assert.deepEqual(
    fours.map((group) => group.word_counts),
    [[45, 46, 50, 51], [54, 55, 59, 60]],
  );
  assert.deepEqual(fours.map((group) => group.word_count_spread), [6, 6]);
}

function testOutputCannotEscapeReviewSamples() {
  const episodeDir = "/tmp/episode";
  assert.equal(
    assertDiagnosticOutputPathForTests(
      "/tmp/episode/review_samples/tts-throughput-bakeoff/run-a",
      episodeDir,
    ),
    "/tmp/episode/review_samples/tts-throughput-bakeoff",
  );
  assert.throws(
    () => assertDiagnosticOutputPathForTests("/tmp/episode/assets/audio", episodeDir),
    /review_samples/u,
  );
  assert.throws(
    () => assertDiagnosticOutputPathForTests(
      "/tmp/episode/review_samples/tts-throughput-bakeoff",
      episodeDir,
    ),
    /labeled child/u,
  );
}

function testSummaryUsesMeasuredWallTimes() {
  const unit = (mode, index, matches) => ({
    unit_id: `u${index}`,
    output_path: `/tmp/${mode}-u${index}.wav`,
    matches_source_serial_wav_sha256: matches,
    token_limit_reached: false,
    waveform_metrics: {
      clipping_sample_count: 0,
      large_sample_step_count: 0,
      isolated_impulse_count: 0,
    },
  });
  const runner = {
    modes: [
      {
        mode_id: "serial",
        requested_batch_size: 1,
        unit_count: 2,
        audio_duration_sum_sec: 20,
        model_call_wall_sec: 8,
        end_to_end_wall_sec: 9,
        peak_memory_bytes: 4 * (1024 ** 3),
        units: [unit("serial", 1, true), unit("serial", 2, true)],
      },
      {
        mode_id: "batch_2",
        requested_batch_size: 2,
        unit_count: 2,
        audio_duration_sum_sec: 20,
        model_call_wall_sec: 5,
        end_to_end_wall_sec: 6,
        peak_memory_bytes: 6 * (1024 ** 3),
        units: [unit("batch_2", 1, false), unit("batch_2", 2, false)],
      },
    ],
  };
  const similarity = {
    candidates: [
      {
        audio_path: "/tmp/batch_2-u1.wav",
        cosine_similarity: 0.91,
        status: "passed",
        warnings: [],
      },
      {
        audio_path: "/tmp/batch_2-u2.wav",
        cosine_similarity: 0.89,
        status: "passed",
        warnings: [{}],
      },
    ],
  };
  const summary = summarizeBakeoffForTests(runner, similarity);
  assert.equal(summary[0].model_call_speedup_vs_serial, 1);
  assert.equal(summary[1].model_call_speedup_vs_serial, 1.6);
  assert.equal(summary[1].end_to_end_speedup_vs_serial, 1.5);
  assert.equal(summary[1].audio_throughput_x, 4);
  assert.equal(summary[1].audio_throughput_speedup_vs_serial, 1.6);
  assert.equal(summary[1].peak_memory_gib, 6);
  assert.equal(summary[1].exact_source_hash_match_count, 0);
  assert.equal(summary[1].acoustic_metrics.clipping_sample_count, 0);
  assert.equal(summary[1].acoustic_metrics.units_reaching_token_limit, 0);
  assert.equal(summary[1].speaker_similarity.minimum, 0.89);
  assert.equal(summary[1].speaker_similarity.warning_below_count, 1);
}

testExactUnitScopeAndProductionIdentity();
testSimilarLengthGroupingIsDeterministic();
testOutputCannotEscapeReviewSamples();
testSummaryUsesMeasuredWallTimes();

console.log("tts qwen throughput bakeoff tests passed");
