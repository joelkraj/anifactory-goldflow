#!/usr/bin/env node
// Autopilot YouTube steps: author-packaging (automatic), auto-upload (automatic,
// private only) and publish (the human publish approval).
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { episodeDirForFlags } from "./lib/execution-provenance.mjs";
import { autopilotEnabled, automatedReviewer } from "./lib/autopilot-policy.mjs";
import { autoPrivateUpload, defaultYoutubePublisher, defaultYoutubeUploader, publishApproval } from "./lib/autopilot-publish.mjs";
import { loadChannelUploadDefaults, loadYoutubeApiCompliance } from "./lib/youtube-publish-contract.mjs";
import { authorAutomatedPackaging, loadPackagingConfig, packagingConfigPath } from "./lib/autopilot-packaging.mjs";
import { createModelReviewer } from "./lib/autopilot-reviewer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const action = process.argv[2] ?? "";
const flags = {};
for (let index = 3; index < process.argv.length; index += 1) {
  const part = process.argv[index];
  if (!part.startsWith("--")) continue;
  const next = process.argv[index + 1];
  flags[part.slice(2)] = next && !next.startsWith("--") ? (index += 1, next) : "true";
}

async function main() {
  const episodeDir = episodeDirForFlags(flags, process.env);
  const identity = JSON.parse(await fs.readFile(path.join(episodeDir, "run_identity.json"), "utf8"));
  const episode = identity.episode ?? path.basename(episodeDir);
  if (action !== "publish" && !autopilotEnabled(identity)) throw new Error(`youtube ${action} is limited to autopilot identities; manual runs use the browser upload and record-upload.`);
  if (action === "author-packaging") {
    const specPath = path.join(episodeDir, `youtube_packaging_spec_${episode}.json`);
    const existing = await fs.readFile(specPath, "utf8").then(JSON.parse, () => null);
    if (!existing) {
      const { generateGoogleGeminiThumbnails } = await import("./google-gemini-thumbnail-helper.mjs");
      const result = await authorAutomatedPackaging({
        episodeDir, episode, identity,
        config: await loadPackagingConfig(packagingConfigPath(dataRoot, identity.channel)),
        reviewer: createModelReviewer({ episodeDir, repoRoot }),
        thumbnailGenerator: ({ jobs }) => generateGoogleGeminiThumbnails({ jobs, concurrency: 3 }),
      });
      if (result.status !== "draft_ready") {
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = 2;
        return;
      }
    } else if (existing.status === "approved") {
      console.log(JSON.stringify({ status: "already_approved", spec_path: specPath }, null, 2));
      return;
    }
    // Approval goes through the normal command and validator (including channel experiments).
    const approval = spawnSync(process.execPath, [path.join(repoRoot, "bin", "goldflow.mjs"), "youtube", "approve-packaging", "--episode-dir", episodeDir,
      "--approve", "true", "--approved-by", automatedReviewer("packaging_validator"), "--note", "Automated: packaging authored per content profile and passed the YouTube packaging contract."],
    { cwd: repoRoot, stdio: "inherit", env: process.env });
    process.exitCode = approval.status ?? 1;
    return;
  }
  // Q54 compliance status is read from the repo config on every upload and publish; it is never inferred.
  const compliance = await loadYoutubeApiCompliance(path.join(repoRoot, "config", "youtube_api_compliance.json"));
  if (action === "auto-upload") {
    const result = await autoPrivateUpload({ episodeDir, episode, compliance, privateReviewOnly: flags["private-review-only"] === "true",
      uploader: ({ manifestPath }) => defaultYoutubeUploader({ manifestPath, repoRoot }) });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "passed") process.exitCode = 2;
    return;
  }
  if (action === "publish") {
    if (!autopilotEnabled(identity)) throw new Error("youtube publish is the autopilot publish approval; manual runs use record-schedule/record-comment.");
    const result = await publishApproval({
      episodeDir, episode, visibility: flags.visibility, scheduleAt: flags["schedule-at"] ?? null, timeZone: flags["time-zone"] ?? null,
      approvedBy: flags["approved-by"], studioSettingsVerified: flags["studio-settings-verified"] === "true",
      publisher: defaultYoutubePublisher({ repoRoot }), compliance,
      channelDefaults: await loadChannelUploadDefaults(path.join(dataRoot, "channels", identity.channel, "channel_upload_defaults.json")),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "published") process.exitCode = 2;
    return;
  }
  throw new Error(`Unknown youtube autopilot action: ${action}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
