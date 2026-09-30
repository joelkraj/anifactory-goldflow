import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { sha256File } from "../lib/file-hash.mjs";
import {
  YOUTUBE_PACKAGING_SPEC_SCHEMA,
  YOUTUBE_PINNED_COMMENT_RECEIPT_SCHEMA,
  YOUTUBE_PUBLISH_MANIFEST_SCHEMA,
  YOUTUBE_UPLOAD_RECEIPT_SCHEMA,
  extractMarkdownSection,
  validateYoutubePackagingSpec,
  validateYoutubePinnedCommentReceipt,
  validateYoutubeUploadReceipt,
  youtubePinnedCommentReceiptComplete,
  youtubePublishContractInternalsForTests,
  youtubePublishManifestComplete,
  youtubePublishingRequired,
  youtubeTextSha256,
  youtubeUploadPackagingComplete,
  youtubeUploadReceiptComplete,
} from "../lib/youtube-publish-contract.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function validSpec(now = new Date()) {
  const observedAt = now.toISOString();
  return {
    schema: YOUTUBE_PACKAGING_SPEC_SCHEMA,
    status: "approved",
    episode: "ep_01",
    approved_by: "operator",
    approved_at: observedAt,
    research_evidence: [
      {
        id: "own_one",
        source_type: "own_channel",
        source_ref: "video-own-one",
        title: "My Own Betrayal Outlier",
        observed_at: observedAt,
        metrics: { ctr_percent: 8.4 },
        lesson: "Concrete betrayal plus visible takeback earned the click.",
      },
      {
        id: "niche_one",
        source_type: "niche_outlier",
        source_ref: "https://www.youtube.com/watch?v=niche-one",
        title: "Recent Fake Heir Outlier",
        observed_at: observedAt,
        metrics: { views: 840000 },
        lesson: "The title explains who betrayed the hero and what he reclaimed.",
      },
      {
        id: "niche_two",
        source_type: "niche_outlier",
        source_ref: "https://www.youtube.com/watch?v=niche-two",
        title: "Recent Family Revenge Outlier",
        observed_at: observedAt,
        metrics: { vph: 960 },
        lesson: "Two faces, one arrow, and a short takeback label remain readable.",
      },
    ],
    title_candidates: [
      {
        title: "My Family Chose a Fake Heir, So I Took Back Every SSS Skill They Stole | Manhwa Recap",
        betrayal_phrase: "Chose a Fake Heir",
        revenge_phrase: "Took Back Every SSS Skill",
        explains_full_video: true,
        research_evidence_ids: ["own_one", "niche_one"],
        selection_reason: "The entire betrayal and takeback fit in one causal sentence.",
      },
      {
        title: "They Crowned My Fake Brother, Then I Reclaimed the Five SSS Skills They Stole | Manhwa Recap",
        betrayal_phrase: "Crowned My Fake Brother",
        revenge_phrase: "Reclaimed the Five SSS Skills",
        explains_full_video: true,
        research_evidence_ids: ["niche_one"],
      },
      {
        title: "My Family Disowned Me for Their Fake Heir, So I Took Back Their SSS Powers | Manhwa Recap",
        betrayal_phrase: "Disowned Me for Their Fake Heir",
        revenge_phrase: "Took Back Their SSS Powers",
        explains_full_video: true,
        research_evidence_ids: ["niche_two"],
      },
    ],
    selected_title: "My Family Chose a Fake Heir, So I Took Back Every SSS Skill They Stole | Manhwa Recap",
    thumbnail_candidates: [
      {
        id: "takeback",
        subjects: [
          { role: "betrayed heir", emotion: "cold resolve" },
          { role: "fake heir", emotion: "panic" },
        ],
        main_text: "I TOOK IT BACK",
        labels: [{ text: "FAKE HEIR" }],
        arrows: [{ purpose: "points from the stolen crest to the betrayed heir" }],
        betrayal_signal: "The fake heir clutches a stolen crest.",
        revenge_signal: "The crest flies back to the real heir.",
        single_scene: true,
        no_collage: true,
        simple_read_order: true,
        mobile_reviewed: true,
        research_evidence_ids: ["own_one", "niche_two"],
        selection_reason: "Two faces, one object, one arrow, and four main words.",
      },
      {
        id: "wrong_heir",
        subjects: [
          { role: "real heir", emotion: "controlled anger" },
          { role: "fake heir", emotion: "shock" },
        ],
        main_text: "WRONG HEIR",
        labels: [],
        arrows: [{ purpose: "points at the collapsing fake-heir crest" }],
        betrayal_signal: "The family crown sits on the fake heir.",
        revenge_signal: "The crown cracks as power returns.",
        single_scene: true,
        no_collage: true,
        simple_read_order: true,
        research_evidence_ids: ["niche_one"],
      },
    ],
    selected_thumbnail_candidate_id: "takeback",
    thumbnail_final_path: "thumbnail_final_ep_01.png",
    description: "His family chose a fake heir and stole his power. Joey's revenge begins when he takes every skill back and builds a guild they cannot control.\n\nA complete fake heir manhwa recap.",
    description_contract: {
      primary_keywords: ["fake heir", "revenge"],
      opening_explains_betrayal_and_revenge: true,
    },
    tags: ["manhwa recap", "fake heir", "betrayal revenge"],
    pinned_comment: {
      text: "If your family crowned a fake heir using powers stolen from you, would you take everything back immediately or expose them first?",
      betrayal_choice: "take everything back or expose them first",
    },
    youtube_channel: {
      expected_name: "Joey Manhwa",
      expected_handle: "@JoeyManhwa",
    },
    publish_settings: {
      initial_visibility: "private",
      desired_visibility: "operator_decides",
      schedule_at: null,
      monetization: "on",
      mid_roll_mode: "automatic",
      made_for_kids: false,
      age_restricted: false,
      altered_content: false,
      automatic_chapters: false,
      comments: "on",
    },
  };
}

function packagingMarkdown(spec) {
  return [
    "# Upload Package",
    "",
    "## Recommended Title",
    spec.selected_title,
    "",
    "## Full Description",
    spec.description,
    "",
    "## Pinned Comment",
    spec.pinned_comment.text,
    "",
  ].join("\n");
}

function uploadReceipt(manifest, manifestHash) {
  return {
    schema: YOUTUBE_UPLOAD_RECEIPT_SCHEMA,
    status: "passed",
    manifest_sha256: manifestHash,
    video_id: "abc123xyz89",
    watch_url: "https://www.youtube.com/watch?v=abc123xyz89",
    initial_visibility: "private",
    visibility: "public",
    schedule_at: null,
    field_verification: Object.fromEntries(
      youtubePublishContractInternalsForTests.REQUIRED_UPLOAD_FIELD_VERIFICATIONS.map((field) => [field, true]),
    ),
    publish_approval: {
      required: true,
      approved: true,
      approved_by: "operator",
    },
    recorded_by: "codex-agent",
    recorded_at: new Date().toISOString(),
  };
}

export async function runYoutubePublishContractTests() {
  const now = new Date();
  const spec = validSpec(now);
  const markdown = packagingMarkdown(spec);
  assert.equal(extractMarkdownSection(markdown, "Recommended Title"), spec.selected_title);
  assert.equal(extractMarkdownSection(markdown, "Full Description"), spec.description);
  assert.equal(youtubePublishingRequired({ stage_registry_version: "2026-07-29.2" }), false);
  assert.equal(youtubePublishingRequired({ stage_registry_version: "2026-07-29.3" }), true);
  assert.equal(youtubePublishingRequired({ stage_registry_version: "old-registry" }), false);

  const valid = validateYoutubePackagingSpec(spec, {
    markdown,
    thumbnailMetadata: { width: 1280, height: 720, format: "png" },
    thumbnailBytes: 1000,
    now,
  });
  assert.deepEqual(valid.blockers, []);

  const operatorAuthoredPackage = structuredClone(spec);
  operatorAuthoredPackage.title_candidates = operatorAuthoredPackage.title_candidates.map((candidate) => ({
    ...candidate,
    title: candidate.title.replace(/\s*\|\s*Manhwa Recap$/i, ""),
  }));
  operatorAuthoredPackage.selected_title = operatorAuthoredPackage.selected_title.replace(/\s*\|\s*Manhwa Recap$/i, "");
  operatorAuthoredPackage.thumbnail_candidates[0].arrows = [];
  const operatorAuthoredValidation = validateYoutubePackagingSpec(operatorAuthoredPackage, {
    markdown: packagingMarkdown(operatorAuthoredPackage),
    thumbnailMetadata: { width: 1280, height: 720, format: "png" },
    thumbnailBytes: 1000,
    now,
  });
  assert.deepEqual(operatorAuthoredValidation.blockers, []);

  const bad = structuredClone(spec);
  bad.thumbnail_candidates[0].subjects.push(
    { role: "father", emotion: "anger" },
    { role: "mother", emotion: "disbelief" },
  );
  bad.thumbnail_candidates[0].arrows.push(
    { purpose: "second arrow" },
    { purpose: "third arrow" },
  );
  bad.thumbnail_candidates[0].no_collage = false;
  bad.thumbnail_candidates[0].main_text = "I TOOK EVERY SINGLE POWER BACK";
  bad.title_candidates[0].revenge_phrase = "A revenge clause that is absent";
  bad.research_evidence[1].observed_at = "2020-01-01T00:00:00.000Z";
  const blocked = validateYoutubePackagingSpec(bad, {
    markdown,
    thumbnailMetadata: { width: 900, height: 900, format: "webp" },
    thumbnailBytes: 1000,
    now,
  });
  for (const blocker of [
    "thumbnail_candidate_0_subject_count_out_of_range",
    "thumbnail_candidate_0_too_many_arrows",
    "thumbnail_candidate_0_must_reject_collage",
    "thumbnail_candidate_0_main_text_word_count",
    "title_candidate_0_revenge_clause_not_in_title",
    "packaging_research_1_niche_evidence_not_recent",
    "thumbnail_format_not_supported",
    "thumbnail_width_below_minimum",
    "thumbnail_not_sixteen_by_nine",
  ]) {
    assert.equal(blocked.blockers.includes(blocker), true, blocker);
  }

  const episodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-youtube-contract-"));
  try {
    const episode = "ep_01";
    const packagePath = path.join(episodeDir, `upload_packaging_${episode}.md`);
    const specPath = path.join(episodeDir, `youtube_packaging_spec_${episode}.json`);
    const thumbnailPath = path.join(episodeDir, spec.thumbnail_final_path);
    await Promise.all([
      fs.writeFile(packagePath, markdown, "utf8"),
      fs.writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8"),
      sharp({
        create: {
          width: 1280,
          height: 720,
          channels: 3,
          background: "#d9a928",
        },
      }).png().toFile(thumbnailPath),
    ]);
    assert.equal((await youtubeUploadPackagingComplete(episodeDir, episode)).done, true);
    const draftSpec = structuredClone(spec);
    draftSpec.status = "draft";
    delete draftSpec.approved_by;
    delete draftSpec.approved_at;
    await fs.writeFile(specPath, `${JSON.stringify(draftSpec, null, 2)}\n`, "utf8");
    const draftStatus = await youtubeUploadPackagingComplete(episodeDir, episode);
    assert.equal(draftStatus.done, false);
    assert.equal(draftStatus.state, undefined);
    await fs.writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

    const manifestPath = path.join(episodeDir, `youtube_publish_manifest_${episode}.json`);
    const manifest = {
      schema: YOUTUBE_PUBLISH_MANIFEST_SCHEMA,
      status: "passed",
      source_hashes: {
        [packagePath]: await sha256File(packagePath),
        [specPath]: await sha256File(specPath),
        [thumbnailPath]: await sha256File(thumbnailPath),
      },
      pinned_comment: {
        text: spec.pinned_comment.text,
      },
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    assert.equal((await youtubePublishManifestComplete(episodeDir, episode)).done, true);

    const manifestHash = await sha256File(manifestPath);
    const receipt = uploadReceipt(manifest, manifestHash);
    assert.deepEqual(validateYoutubeUploadReceipt(receipt, { manifest, manifestHash }).blockers, []);
    const unsafeReceipt = structuredClone(receipt);
    unsafeReceipt.initial_visibility = "public";
    unsafeReceipt.publish_approval.approved = false;
    const unsafeValidation = validateYoutubeUploadReceipt(unsafeReceipt, { manifest, manifestHash });
    assert.equal(unsafeValidation.blockers.includes("youtube_upload_receipt_did_not_start_private"), true);
    assert.equal(unsafeValidation.blockers.includes("youtube_upload_receipt_publish_approval_missing"), true);

    const uploadReceiptPath = path.join(episodeDir, `youtube_upload_receipt_${episode}.json`);
    await fs.writeFile(uploadReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    assert.equal((await youtubeUploadReceiptComplete(episodeDir, episode)).done, true);

    const uploadReceiptHash = await sha256File(uploadReceiptPath);
    const commentReceipt = {
      schema: YOUTUBE_PINNED_COMMENT_RECEIPT_SCHEMA,
      status: "passed",
      upload_receipt_sha256: uploadReceiptHash,
      video_id: receipt.video_id,
      comment_id: "comment-one",
      comment_text_sha256: youtubeTextSha256(spec.pinned_comment.text),
      post_approval: {
        approved: true,
        approved_by: "operator",
      },
      pinned: true,
      recorded_by: "codex-agent",
      recorded_at: new Date().toISOString(),
    };
    assert.deepEqual(validateYoutubePinnedCommentReceipt(commentReceipt, {
      manifest,
      uploadReceipt: receipt,
      uploadReceiptHash,
    }).blockers, []);
    const commentReceiptPath = path.join(episodeDir, `youtube_pinned_comment_receipt_${episode}.json`);
    await fs.writeFile(commentReceiptPath, `${JSON.stringify(commentReceipt, null, 2)}\n`, "utf8");
    assert.equal((await youtubePinnedCommentReceiptComplete(episodeDir, episode)).done, true);
  } finally {
    await fs.rm(episodeDir, { recursive: true, force: true });
  }

  const cliEpisodeDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-youtube-cli-"));
  try {
    const episode = "ep_01";
    const cliSpec = validSpec(new Date());
    cliSpec.status = "draft";
    delete cliSpec.approved_by;
    delete cliSpec.approved_at;
    const cliMarkdown = packagingMarkdown(cliSpec);
    const packagePath = path.join(cliEpisodeDir, `upload_packaging_${episode}.md`);
    const specPath = path.join(cliEpisodeDir, `youtube_packaging_spec_${episode}.json`);
    const thumbnailPath = path.join(cliEpisodeDir, cliSpec.thumbnail_final_path);
    const videoPath = path.join(cliEpisodeDir, "final-video.mp4");
    const videoBytes = Buffer.from("provider-free final video fixture");
    await Promise.all([
      fs.writeFile(path.join(cliEpisodeDir, "run_identity.json"), `${JSON.stringify({
        schema: "goldflow_run_identity_v2",
        channel: "53rebirth",
        episode,
        stage_registry_version: "2026-07-29.3",
      }, null, 2)}\n`, "utf8"),
      fs.writeFile(packagePath, cliMarkdown, "utf8"),
      fs.writeFile(specPath, `${JSON.stringify(cliSpec, null, 2)}\n`, "utf8"),
      fs.writeFile(videoPath, videoBytes),
      sharp({
        create: {
          width: 1280,
          height: 720,
          channels: 3,
          background: "#c83125",
        },
      }).png().toFile(thumbnailPath),
    ]);
    await fs.writeFile(path.join(cliEpisodeDir, `final_qa_${episode}.json`), `${JSON.stringify({
      schema: "goldflow_final_qa_v2",
      status: "passed",
      final_video_path: videoPath,
      final_video_sha256: await sha256File(videoPath),
    }, null, 2)}\n`, "utf8");

    await execFileAsync(process.execPath, [
      path.join(repoRoot, "scripts", "youtube-publish.mjs"),
      "approve-packaging",
      "--episode-dir", cliEpisodeDir,
      "--approve", "true",
      "--approved-by", "operator",
    ], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 4 });
    assert.equal((await readJsonForTest(specPath)).status, "approved");

    await execFileAsync(process.execPath, [
      path.join(repoRoot, "scripts", "youtube-publish.mjs"),
      "prepare",
      "--episode-dir", cliEpisodeDir,
    ], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 4 });
    assert.equal((await youtubePublishManifestComplete(cliEpisodeDir, episode)).done, true);

    await assert.rejects(execFileAsync(process.execPath, [
      path.join(repoRoot, "scripts", "youtube-publish.mjs"),
      "record-upload",
      "--episode-dir", cliEpisodeDir,
      "--video-id", "abc123xyz89",
      "--watch-url", "https://www.youtube.com/watch?v=abc123xyz89",
      "--visibility", "public",
      "--recorded-by", "codex-agent",
    ], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 4 }));
    assert.equal(await fs.stat(path.join(cliEpisodeDir, `youtube_upload_receipt_${episode}.json`)).catch(() => null), null);

    await execFileAsync(process.execPath, [
      path.join(repoRoot, "scripts", "youtube-publish.mjs"),
      "record-upload",
      "--episode-dir", cliEpisodeDir,
      "--video-id", "abc123xyz89",
      "--watch-url", "https://www.youtube.com/watch?v=abc123xyz89",
      "--visibility", "public",
      "--channel-verified", "true",
      "--initial-private-verified", "true",
      "--title-verified", "true",
      "--description-verified", "true",
      "--thumbnail-verified", "true",
      "--audience-verified", "true",
      "--monetization-verified", "true",
      "--comments-verified", "true",
      "--checks-complete", "true",
      "--publish-approved", "true",
      "--publish-approved-by", "operator",
      "--recorded-by", "codex-agent",
    ], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 4 });
    assert.equal((await youtubeUploadReceiptComplete(cliEpisodeDir, episode)).done, true);
    const isolatedLedger = await readJsonForTest(path.join(cliEpisodeDir, "youtube_upload_ledger.json"));
    assert.equal(isolatedLedger.schema, "goldflow_youtube_upload_ledger_v1");
    assert.equal(isolatedLedger.entry_count, 1);

    await execFileAsync(process.execPath, [
      path.join(repoRoot, "scripts", "youtube-publish.mjs"),
      "record-comment",
      "--episode-dir", cliEpisodeDir,
      "--comment-id", "comment-one",
      "--text-verified", "true",
      "--post-approved", "true",
      "--post-approved-by", "operator",
      "--pinned-verified", "true",
      "--recorded-by", "codex-agent",
    ], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 4 });
    assert.equal((await youtubePinnedCommentReceiptComplete(cliEpisodeDir, episode)).done, true);
  } finally {
    await fs.rm(cliEpisodeDir, { recursive: true, force: true });
  }
}

async function readJsonForTest(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runYoutubePublishContractTests();
  console.log("youtube publish contract tests passed");
}
