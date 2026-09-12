import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNarrationSourceStructure,
  buildNarrationSourceStructure,
  loadNarrationSourceStructure,
} from "../lib/narration-source-structure.mjs";
import {
  buildNarrationSubjectiveReviewManifest,
  narrationSubjectiveReviewManifestSha256,
  narrationUnitTimeline,
  validateNarrationSubjectiveReviewManifest,
} from "../lib/narration-subjective-review.mjs";
import { canonicalNarrationPlanSha256 } from "../lib/narration-pre-synthesis-gate.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceScriptSha256 = hash("Continuous synthetic narration with no chapter headings.");
const generationPlanSha256 = hash("Synthetic generation plan identity.");
const plan = {
  schema: "goldflow_tts_generation_plan_v2",
  source_script_hash: sourceScriptSha256,
  plan_sha256: generationPlanSha256,
  units: Array.from({ length: 352 }, (_, index) => {
    const segmentId = `voice_seg_${String(index + 1).padStart(3, "0")}`;
    const text = `Narration unit ${index + 1}.`;
    return {
      unit_id: `unit_${index + 1}`,
      order_index: index,
      segment_id: segmentId,
      source_segment_ids: [segmentId],
      source_unit_refs: [{ segment_id: segmentId, unit_index: 1, source_text: text, source_text_sha256: hash(text) }],
      spoken_text: text,
      spoken_text_sha256: hash(text),
      risk_flags: index === 100 ? ["system_ui_atomic"] : [],
    };
  }),
};
// A chapter cannot begin halfway through one already synthesized unit.
plan.units[20].source_unit_refs.push({ segment_id: plan.units[20].segment_id, unit_index: 2, source_text: "A second complete sentence.", source_text_sha256: hash("A second complete sentence.") });
const generationPlanFileSha256 = hash(JSON.stringify(plan));
const context = { plan, sourceScriptSha256, generationPlanSha256, generationPlanFileSha256 };
const originalPlanBytes = JSON.stringify(plan);
const stitch = {
  prepared_inputs: plan.units.map((unit) => ({ unit_id: unit.unit_id, sample_count: 240_000 })),
  boundaries: plan.units.slice(0, -1).map((unit, index) => ({
    boundary_id: `boundary_${index + 1}`,
    after_unit_id: unit.unit_id,
    before_unit_id: plan.units[index + 1].unit_id,
    gap_sample_count: 2400,
  })),
};
const originalStitchBytes = JSON.stringify(stitch);
const originalTimeline = narrationUnitTimeline({ plan, stitch });
const manifestOptions = {
  plan,
  stitch,
  audioPath: "/fixture/canonical-narration.wav",
  audioSha256: hash("Synthetic audio binding, no audio generated."),
  generationPlanSha256,
  generationPlanFileSha256,
  qualityContractSha256: hash("Synthetic quality contract."),
};
const structureOptions = { ...context, reviewer: "fixture-reviewer", note: "Read the exact hash-bound synthetic source and confirmed its narrative structure." };
const continuous = buildNarrationSourceStructure({ ...structureOptions, structureKind: "continuous_narrative", chapters: [] });
assert.match(continuous.structure_sha256, /^[a-f0-9]{64}$/);
assert.doesNotThrow(() => assertNarrationSourceStructure(continuous, context));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-narration-source-structure-"));
const episode = "ep_01";
const file = path.join(root, `narration_source_structure_${episode}.json`);
const loaderOptions = { episodeDir: root, episode, ...context };
const writeMap = async (map) => {
  const bytes = JSON.stringify(map, null, 2) + "\n";
  await fs.writeFile(file, bytes);
  return { path: file, file_sha256: hash(bytes), map };
};
try {
  assert.equal(await loadNarrationSourceStructure(loaderOptions), null);
  assert.equal(await loadNarrationSourceStructure({ ...loaderOptions, expectedBinding: null }), null);
  const sourceStructure = await writeMap(continuous);
  const loaded = await loadNarrationSourceStructure(loaderOptions);
  assert.deepEqual(loaded, sourceStructure);
  const legacyManifest = buildNarrationSubjectiveReviewManifest(manifestOptions);
  const continuousManifest = buildNarrationSubjectiveReviewManifest({ ...manifestOptions, sourceStructure });
  assert.equal(legacyManifest.expected_chapter_boundary_count, 351, "unmapped historical plans keep their existing chapter-sampling behavior");
  assert.equal(continuousManifest.expected_chapter_boundary_count, 0, "technical chunks are not source chapters");
  assert.equal(continuousManifest.coverage.every_chapter_boundary, 0);
  assert.equal(continuousManifest.observed_voice_segment_transition_count, 351, "technical joins remain recorded independently of chapters");
  assert.equal(continuousManifest.samples.filter((sample) => sample.coverage_class === "every_chapter_boundary").length, 0);
  assert.equal(validateNarrationSubjectiveReviewManifest(continuousManifest).status, "passed");
  const nonChapterSamples = (manifest) => manifest.samples.filter((sample) => sample.coverage_class !== "every_chapter_boundary");
  assert.deepEqual(nonChapterSamples(continuousManifest), nonChapterSamples(legacyManifest), "opening, risk, midpoint, climax, and final coverage stay exact");
  assert.deepEqual(await loadNarrationSourceStructure({ ...loaderOptions, expectedBinding: continuousManifest.source_structure }), sourceStructure);
  await assert.rejects(() => loadNarrationSourceStructure({ ...loaderOptions, expectedBinding: null }), undefined, "an absent-map snapshot cannot silently adopt a new map");

  const firstKey = `${plan.units[0].segment_id}:u001`;
  const secondKey = `${plan.units[176].segment_id}:u001`;
  const chapters = [{ chapter_id: "chapter_1", first_source_ref_key: firstKey }, { chapter_id: "chapter_2", first_source_ref_key: secondKey }];
  const explicit = buildNarrationSourceStructure({ ...structureOptions, structureKind: "explicit_chapters", chapters });
  const explicitStructure = await writeMap(explicit);
  const explicitManifest = buildNarrationSubjectiveReviewManifest({ ...manifestOptions, sourceStructure: explicitStructure });
  assert.equal(explicitManifest.expected_chapter_boundary_count, 1);
  assert.equal(explicitManifest.coverage.every_chapter_boundary, 1);
  assert.equal(explicitManifest.observed_voice_segment_transition_count, 351);
  assert.deepEqual(nonChapterSamples(explicitManifest), nonChapterSamples(legacyManifest));
  assert.equal(validateNarrationSubjectiveReviewManifest(explicitManifest).status, "passed");
  const concealedChapterManifest = structuredClone(explicitManifest);
  concealedChapterManifest.samples = nonChapterSamples(concealedChapterManifest);
  concealedChapterManifest.sample_count = concealedChapterManifest.samples.length;
  concealedChapterManifest.coverage.every_chapter_boundary = 0;
  concealedChapterManifest.expected_chapter_boundary_count = 0;
  concealedChapterManifest.manifest_sha256 = narrationSubjectiveReviewManifestSha256(concealedChapterManifest);
  assert.equal(validateNarrationSubjectiveReviewManifest(concealedChapterManifest).status, "blocked",
    "rehashing a manifest with a deleted chapter sample cannot override its declared source chapters");
  assert.throws(() => buildNarrationSubjectiveReviewManifest({
    ...manifestOptions,
    stitch: { ...stitch, prepared_inputs: stitch.prepared_inputs.filter((row) => row.unit_id !== plan.units[176].unit_id) },
    sourceStructure: explicitStructure,
  }), /chapter starts are missing/, "a declared chapter missing from stitched audio cannot silently disappear from review coverage");
  for (const invalidChapters of [
    [],
    [chapters[1]],
    [...chapters].reverse(),
    [chapters[0], { chapter_id: "chapter_2", first_source_ref_key: "missing:u001" }],
    [chapters[0], { chapter_id: "chapter_2", first_source_ref_key: `${plan.units[20].segment_id}:u002` }],
    [chapters[0], { chapter_id: "chapter_2", first_source_ref_key: firstKey }],
    [chapters[0], { chapter_id: "chapter_1", first_source_ref_key: secondKey }],
  ]) {
    assert.throws(() => buildNarrationSourceStructure({ ...structureOptions, structureKind: "explicit_chapters", chapters: invalidChapters }), undefined, "chapter anchors must be complete, unique, ordered synthesis-unit starts");
  }
  assert.throws(() => buildNarrationSourceStructure({ ...structureOptions, structureKind: "continuous_narrative", chapters }));
  for (const key of ["sourceScriptSha256", "generationPlanSha256", "generationPlanFileSha256"]) {
    assert.throws(() => buildNarrationSourceStructure({ ...structureOptions, [key]: null, structureKind: "continuous_narrative", chapters: [] }), undefined, `${key} is required`);
    assert.throws(() => assertNarrationSourceStructure(continuous, { ...context, [key]: hash(`stale ${key}`) }), undefined, `${key} must match current narration`);
    await assert.rejects(() => loadNarrationSourceStructure({ ...loaderOptions, [key]: hash(`stale ${key}`) }));
  }
  const tampered = { ...continuous, note: "Changed after review." };
  assert.throws(() => assertNarrationSourceStructure(tampered, context));
  const missingMapHash = { ...continuous };
  delete missingMapHash.structure_sha256;
  assert.throws(() => assertNarrationSourceStructure(missingMapHash, context));
  const missingFileHash = { ...sourceStructure, file_sha256: null };
  assert.throws(() => buildNarrationSubjectiveReviewManifest({ ...manifestOptions, sourceStructure: missingFileHash }));
  assert.throws(() => buildNarrationSubjectiveReviewManifest({ ...manifestOptions, sourceStructure: { ...sourceStructure, map: tampered } }));
  await assert.rejects(() => loadNarrationSourceStructure({ ...loaderOptions, expectedBinding: continuousManifest.source_structure }), undefined, "an existing snapshot cannot silently adopt a replacement map");
  await writeMap(tampered);
  await assert.rejects(() => loadNarrationSourceStructure(loaderOptions));
  await fs.rm(file);
  await assert.rejects(() => loadNarrationSourceStructure({ ...loaderOptions, expectedBinding: continuousManifest.source_structure }), undefined, "deleting a previously bound map cannot revert to legacy behavior");
  assert.equal(JSON.stringify(plan), originalPlanBytes, "source-structure review never rewrites the generation plan");
  assert.equal(JSON.stringify(stitch), originalStitchBytes, "source-structure review never rewrites stitch joins");
  assert.deepEqual(narrationUnitTimeline({ plan, stitch }), originalTimeline);

  const cliScript = "A first complete sentence.\nA second complete sentence.\n";
  const cliPlan = {
    schema: "goldflow_tts_generation_plan_v2",
    status: "passed",
    source_script_hash: hash(cliScript),
    units: cliScript.trim().split("\n").map((text, index) => ({
      unit_id: `cli_unit_${index + 1}`,
      segment_id: `voice_seg_${index + 1}`,
      source_unit_refs: [{ segment_id: `voice_seg_${index + 1}`, unit_index: 1 }],
      spoken_text: text,
      spoken_text_sha256: hash(text),
    })),
  };
  cliPlan.plan_sha256 = canonicalNarrationPlanSha256(cliPlan);
  const cliPath = fileURLToPath(new URL("../narration-source-structure.mjs", import.meta.url));
  const cliArguments = (episodeDir) => [cliPath, "--episode-dir", episodeDir,
    "--kind", "continuous_narrative", "--reviewer", "fixture-reviewer",
    "--note", "Verified both source sentences form continuous narration.",
    "--attestation", "source_narrative_structure_reviewed"];
  const cliRoot = path.join(root, "cli-valid");
  await fs.mkdir(cliRoot);
  const cliPlanPath = path.join(cliRoot, "narration_generation_plan.json");
  const cliPlanBytes = JSON.stringify(cliPlan, null, 2) + "\n";
  const sentinel = Buffer.from("Synthetic audio sentinel; not a media file.");
  const sentinelPath = path.join(cliRoot, "canonical-narration.wav");
  await fs.writeFile(path.join(cliRoot, "run_identity.json"), JSON.stringify({ episode, media_workflow: "generated_visuals_v1" }));
  await fs.writeFile(path.join(cliRoot, "script_clean.md"), cliScript);
  await fs.writeFile(cliPlanPath, cliPlanBytes);
  await fs.writeFile(sentinelPath, sentinel);
  const firstCli = spawnSync(process.execPath, cliArguments(cliRoot), { encoding: "utf8" });
  assert.equal(firstCli.status, 0, firstCli.stderr);
  assert.equal(JSON.parse(firstCli.stdout).media_modified, false);
  const cliMapPath = path.join(cliRoot, `narration_source_structure_${episode}.json`);
  const firstMapBytes = await fs.readFile(cliMapPath);
  const secondCli = spawnSync(process.execPath, cliArguments(cliRoot), { encoding: "utf8" });
  assert.equal(secondCli.status, 0, secondCli.stderr);
  assert.deepEqual(await fs.readFile(cliMapPath), firstMapBytes, "repeating an identical source-structure review is idempotent");
  assert.equal(await fs.readFile(cliPlanPath, "utf8"), cliPlanBytes, "metadata CLI preserves exact generation-plan bytes");
  assert.equal(await fs.readFile(path.join(cliRoot, "script_clean.md"), "utf8"), cliScript);
  assert.deepEqual(await fs.readFile(sentinelPath), sentinel, "metadata CLI never alters audio");
  const staleRoot = path.join(root, "cli-stale-plan");
  await fs.mkdir(staleRoot);
  const stalePlan = structuredClone(cliPlan);
  stalePlan.units[0].spoken_text = "Changed without updating the canonical plan hash.";
  await fs.writeFile(path.join(staleRoot, "run_identity.json"), JSON.stringify({ episode, media_workflow: "generated_visuals_v1" }));
  await fs.writeFile(path.join(staleRoot, "script_clean.md"), cliScript);
  await fs.writeFile(path.join(staleRoot, "narration_generation_plan.json"), JSON.stringify(stalePlan));
  const staleCli = spawnSync(process.execPath, cliArguments(staleRoot), { encoding: "utf8" });
  assert.notEqual(staleCli.status, 0, "a stale claimed plan hash must prevent source-structure approval");
  assert.match(staleCli.stderr, /canonical.*hash|hash.*canonical/i);
  await assert.rejects(() => fs.access(path.join(staleRoot, `narration_source_structure_${episode}.json`)), { code: "ENOENT" });
  console.log("Narration source-structure tests passed (continuous/legacy/chapter coverage, exact anchors, provenance, snapshot integrity).");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
