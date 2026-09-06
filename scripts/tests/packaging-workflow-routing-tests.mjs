import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { mediaWorkflowForPreflight } from "../lib/media-workflows.mjs";
import {
  LEGACY_YOUTUBE_PACKAGING_ADAPTER_WARNING,
  LEGACY_YOUTUBE_PACKAGING_SPEC_SCHEMA,
  YOUTUBE_PACKAGING_SPEC_SCHEMA,
  packagingWorkflowSupport,
  validateYoutubePackagingSpec,
  youtubeUploadPackagingComplete,
} from "../lib/youtube-publish-contract.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tests = [];
const test = (name, work) => tests.push([name, work]);
const identity = (profile = "manhwa_recap_v1") => ({
  ...mediaWorkflowForPreflight({ contentProfile: profile, mediaWorkflow: "generated_visuals_v1" }),
  episode: "ep_01",
  content_profile: profile,
  content_profile_config: { id: profile },
});
const now = new Date("2026-09-06T12:00:00Z");

function specFixture() {
  const titles = [
    "They Stole His Crown, So He Took It Back With Every Lost Power | Manhwa Recap",
    "They Stole His Crown, So He Took It Back Before the False King's Coronation",
    "They Stole His Crown, So He Took It Back and Ended the False Heir's Rule",
  ];
  return {
    schema: YOUTUBE_PACKAGING_SPEC_SCHEMA,
    status: "approved", episode: "ep_01", approved_by: "fixture-reviewer", approved_at: now.toISOString(),
    research_evidence: ["own_channel", "niche_outlier", "niche_outlier"].map((source_type, index) => ({
      id: `evidence_${index}`, source_type, source_ref: `fixture-evidence-${index}`, title: "Synthetic measured package",
      observed_at: now.toISOString(), metrics: { views: 1000 }, lesson: "Specific causal wording remained readable.",
    })),
    selected_title: titles[0],
    title_candidates: titles.map((title) => ({
      title, betrayal_phrase: "Stole His Crown", revenge_phrase: "Took It Back", explains_full_video: true,
      research_evidence_ids: ["evidence_0"], selection_reason: "Specific title promise.",
    })),
    selected_thumbnail_candidate_id: "candidate_0", thumbnail_final_path: "thumbnail.png",
    thumbnail_candidates: [0, 1].map((index) => ({
      id: `candidate_${index}`, subjects: [{ role: "heir", emotion: "resolve" }], main_text: "CROWN RETURNED",
      labels: [], arrows: [], betrayal_signal: "The crown was stolen.", revenge_signal: "The heir reclaims the crown.",
      single_scene: true, no_collage: true, simple_read_order: true, mobile_reviewed: true,
      research_evidence_ids: ["evidence_0"], selection_reason: "Readable synthetic fixture.", provider: "google_flow_imagen",
      generation_mode: "full_raster_from_scratch", reference_count: 0, text_rendered_by_model: true,
      locally_composited_text: false, locally_composited_arrows: false,
    })),
    description: "A stolen crown sparks the heir's takeback in this synthetic manhwa recap.",
    description_contract: { primary_keywords: ["stolen crown"], opening_explains_betrayal_and_revenge: true },
    tags: ["synthetic fixture"],
    pinned_comment: { text: "Would you take back the crown or reveal the theft first?", betrayal_choice: "take back or reveal" },
    youtube_channel: { expected_name: "Synthetic fixture channel" },
    publish_settings: { initial_visibility: "private", desired_visibility: "operator_decides", monetization: "off",
      made_for_kids: false, age_restricted: false, altered_content: true, comments: "on" },
  };
}

function markdownFor(spec) {
  return `# Synthetic package\n\n## Recommended Title\n${spec.selected_title}\n\n## Full Description\n${spec.description}\n\n## Pinned Comment\n${spec.pinned_comment.text}\n`;
}

async function withScratch(work) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-packaging-workflow-test-"));
  try { await work(scratch); } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

async function snapshot(directory) {
  const result = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(directory, entry.name);
    assert.equal(entry.isFile(), true, "Fixture has only files; a new output directory is a mutation.");
    result.push([entry.name, createHash("sha256").update(await fs.readFile(target)).digest("hex")]);
  }
  return result;
}

async function runPublishing(scratch, action, { rootCli = false } = {}) {
  try {
    const entry = rootCli ? ["bin/goldflow.mjs", "youtube", action] : ["scripts/youtube-publish.mjs", action];
    const result = await execFileAsync(process.execPath, [...entry,
      "--episode-dir", scratch, "--approve", "true", "--approved-by", "fixture-reviewer", "--workflow-bypass", "true"], {
      cwd: repoRoot, timeout: 15000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, TMPDIR: scratch, ANIFACTORY_DATA_ROOT: scratch, GOLDFLOW_WORKFLOW_BYPASS: "true" },
    });
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== "number" || error.killed) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("historical identities retain packaging support and embedded profile precedence", () => {
  for (const legacy of [{}, { content_profile: "asset_afterlife_v1" },
    { content_profile: "manhwa_recap_v1", content_profile_config: { id: "asset_afterlife_v1" } }]) {
    const before = JSON.stringify(legacy);
    const support = packagingWorkflowSupport(legacy);
    assert.equal(support.available, true);
    assert.equal(support.reason, null);
    assert.equal(support.media_workflow.legacy, true);
    assert.equal(JSON.stringify(legacy), before);
  }
  assert.equal(packagingWorkflowSupport({ content_profile: "manhwa_recap_v1", content_profile_config: { id: "asset_afterlife_v1" } }).content_profile, "asset_afterlife_v1");
});

test("new manhwa retains every current packaging requirement", () => {
  const spec = specFixture();
  const baseline = validateYoutubePackagingSpec(spec, { now });
  assert.equal(baseline.status, "passed");
  assert.deepEqual(validateYoutubePackagingSpec(spec, { now, runIdentity: identity() }), baseline);
  const incomplete = specFixture();
  for (const title of incomplete.title_candidates) { delete title.betrayal_phrase; delete title.revenge_phrase; }
  for (const thumbnail of incomplete.thumbnail_candidates) { delete thumbnail.betrayal_signal; delete thumbnail.revenge_signal; }
  delete incomplete.description_contract.opening_explains_betrayal_and_revenge;
  delete incomplete.pinned_comment.betrayal_choice;
  const validation = validateYoutubePackagingSpec(incomplete, { now, runIdentity: identity() });
  assert.equal(validation.status, "blocked");
  for (const code of ["title_candidate_0_betrayal_clause_not_in_title", "title_candidate_0_revenge_clause_not_in_title",
    "thumbnail_candidate_0_betrayal_signal_missing", "thumbnail_candidate_0_revenge_signal_missing",
    "description_opening_does_not_assert_betrayal_and_revenge", "pinned_comment_betrayal_choice_missing"]) {
    assert.ok(validation.blockers.includes(code), code);
  }
});

test("new documentary/custom packaging stops before manhwa validation and cannot use forged spec identity", () => {
  for (const profile of ["asset_afterlife_v1", "custom_documentary_v1"]) {
    const locked = identity(profile);
    const before = JSON.stringify(locked);
    const support = packagingWorkflowSupport(locked);
    assert.equal(support.available, false);
    assert.equal(support.media_workflow.legacy, false);
    for (const spec of [{}, { ...specFixture(), content_profile: "manhwa_recap_v1", media_workflow: "generated_visuals_v1" }]) {
      const validation = validateYoutubePackagingSpec(spec, { now, runIdentity: locked, allowLegacyAdapter: true, requireApproval: false });
      assert.equal(validation.status, "blocked");
      assert.deepEqual(validation.blockers, [support.reason]);
      assert.match(validation.blockers[0], /Packaging workflow unsupported/);
      assert.equal(validation.legacy_adapter_applied, false);
    }
    assert.equal(JSON.stringify(locked), before);
  }
});

test("new workflow lock without editorial identity cannot silently default to manhwa packaging", () => {
  const lockOnly = mediaWorkflowForPreflight({ contentProfile: "manhwa_recap_v1", mediaWorkflow: "generated_visuals_v1" });
  assert.equal(packagingWorkflowSupport(lockOnly).available, false);
  assert.match(packagingWorkflowSupport(lockOnly).reason, /unselected/);
});

test("invalid, conflicting, and reserved workflow locks fail closed", () => {
  const stale = identity();
  stale.workflow_contract.sha256 = "0".repeat(64);
  const conflicting = identity();
  conflicting.content_profile_config.id = "asset_afterlife_v1";
  for (const invalid of [stale, conflicting, { ...identity(), media_workflow: "source_footage_v1" },
    { media_workflow: "generated_visuals_v1" }]) {
    assert.throws(() => packagingWorkflowSupport(invalid), /workflow|content_profile|reserved/i);
    assert.throws(() => validateYoutubePackagingSpec(specFixture(), { runIdentity: invalid }), /workflow|content_profile|reserved/i);
  }
});

test("approved legacy packaging adapter and new manhwa behavior are unchanged", () => {
  const spec = specFixture();
  spec.schema = LEGACY_YOUTUBE_PACKAGING_SPEC_SCHEMA;
  for (const thumbnail of spec.thumbnail_candidates) {
    for (const key of ["provider", "generation_mode", "reference_count", "text_rendered_by_model", "locally_composited_text", "locally_composited_arrows"]) delete thumbnail[key];
  }
  const baseline = validateYoutubePackagingSpec(spec, { now, allowLegacyAdapter: true });
  assert.equal(baseline.status, "passed");
  assert.equal(baseline.legacy_adapter_applied, true);
  assert.deepEqual(baseline.warnings, [LEGACY_YOUTUBE_PACKAGING_ADAPTER_WARNING]);
  for (const runIdentity of [{}, { content_profile: "asset_afterlife_v1" }, identity()]) {
    assert.deepEqual(validateYoutubePackagingSpec(spec, { now, allowLegacyAdapter: true, runIdentity }), baseline);
  }
  assert.equal(validateYoutubePackagingSpec(spec, { now, allowLegacyAdapter: true, runIdentity: identity("asset_afterlife_v1") }).status, "blocked");
});

test("completion loads real identity by default and blocks unsupported route before asking for artifacts", () => withScratch(async (scratch) => {
  const identityPath = path.join(scratch, "run_identity.json");
  await fs.writeFile(identityPath, JSON.stringify(identity("asset_afterlife_v1")));
  const before = await snapshot(scratch);
  for (const result of [await youtubeUploadPackagingComplete(scratch, "ep_01"),
    await youtubeUploadPackagingComplete(scratch, "ep_01", identity("asset_afterlife_v1"))]) {
    assert.equal(result.done, false);
    assert.equal(result.state, "blocked");
    assert.match(result.evidence, /Packaging workflow unsupported/);
    assert.doesNotMatch(result.evidence, /upload_packaging_ep_01.*required/);
  }
  assert.deepEqual(await snapshot(scratch), before);
}));

test("completion rejects malformed or stale persisted identity instead of legacy fallback", () => withScratch(async (scratch) => {
  const identityPath = path.join(scratch, "run_identity.json");
  const stale = identity();
  stale.workflow_contract.version = "old-version";
  for (const document of ["not-json", "null", "[]", JSON.stringify(stale)]) {
    await fs.writeFile(identityPath, document);
    const result = await youtubeUploadPackagingComplete(scratch, "ep_01");
    assert.equal(result.done, false);
    assert.equal(result.state, "blocked");
    assert.match(result.evidence, /Packaging workflow routing blocked/);
  }
}));

test("missing historical identity and legacy documentary approvals retain exact completion behavior", () => withScratch(async (scratch) => {
  const spec = specFixture();
  await fs.writeFile(path.join(scratch, "upload_packaging_ep_01.md"), markdownFor(spec));
  await fs.writeFile(path.join(scratch, "youtube_packaging_spec_ep_01.json"), JSON.stringify(spec));
  await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#777777" } }).png().toFile(path.join(scratch, "thumbnail.png"));
  const baseline = await youtubeUploadPackagingComplete(scratch, "ep_01");
  assert.equal(baseline.done, true);
  await fs.writeFile(path.join(scratch, "run_identity.json"), JSON.stringify({ content_profile: "asset_afterlife_v1", episode: "ep_01" }));
  assert.deepEqual(await youtubeUploadPackagingComplete(scratch, "ep_01"), baseline);
  await fs.writeFile(path.join(scratch, "run_identity.json"), JSON.stringify(identity()));
  assert.deepEqual(await youtubeUploadPackagingComplete(scratch, "ep_01"), baseline);
}));

test("every direct publishing CLI action refuses new documentary route without writes or bypass", () => withScratch(async (scratch) => {
  await fs.writeFile(path.join(scratch, "run_identity.json"), JSON.stringify(identity("asset_afterlife_v1")));
  await fs.writeFile(path.join(scratch, "existing-approval.json"), JSON.stringify({ status: "approved", preserve: true }));
  const before = await snapshot(scratch);
  for (const action of ["approve-packaging", "approve-ab-test", "prepare", "record-upload", "record-ab-test", "record-thumbnail-update", "record-comment"]) {
    const result = await runPublishing(scratch, action);
    assert.notEqual(result.code, 0, action);
    assert.match(`${result.stdout}\n${result.stderr}`, /Packaging workflow unsupported/, action);
    assert.deepEqual(await snapshot(scratch), before, action);
  }
}));

test("root CLI blocks documentary publishing before provenance even with workflow bypass", () => withScratch(async (scratch) => {
  await fs.writeFile(path.join(scratch, "run_identity.json"), JSON.stringify(identity("asset_afterlife_v1")));
  const before = await snapshot(scratch);
  for (const action of ["approve-packaging", "approve-ab-test", "prepare", "record-upload", "record-ab-test", "record-thumbnail-update", "record-comment"]) {
    const result = await runPublishing(scratch, action, { rootCli: true });
    assert.notEqual(result.code, 0, action);
    assert.match(`${result.stdout}\n${result.stderr}`, /Packaging workflow unsupported/, action);
    assert.deepEqual(await snapshot(scratch), before, action);
  }
}));

test("legacy documentary receipt paths are not newly blocked by packaging workflow support", () => withScratch(async (scratch) => {
  await fs.writeFile(path.join(scratch, "run_identity.json"), JSON.stringify({ content_profile: "asset_afterlife_v1", episode: "ep_01" }));
  const before = await snapshot(scratch);
  const result = await runPublishing(scratch, "record-upload");
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Passed YouTube publish manifest required/);
  assert.doesNotMatch(result.stderr, /Packaging workflow unsupported/);
  assert.deepEqual(await snapshot(scratch), before);
}));

export async function runPackagingWorkflowRoutingTests() {
  for (const [name, work] of tests) {
    try { await work(); } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    }
  }
  return { passed: tests.length };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = await runPackagingWorkflowRoutingTests();
  console.log(`Packaging workflow routing tests passed (${result.passed}).`);
}
