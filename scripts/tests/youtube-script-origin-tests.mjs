#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildYoutubeScriptOriginRegistry,
  classifyUploadedEpisodeScriptOrigin,
} from "../lib/youtube-script-origin.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function episodeFixture(root, { week, videoId, native }) {
  const episodeDir = path.join(root, "channels", "53rebirth", "weekly_runs", week, "episodes", "ep_01");
  await fs.mkdir(episodeDir, { recursive: true });
  await fs.writeFile(path.join(episodeDir, "script_clean.md"), "Joey chose the shield.\n", "utf8");
  await writeJson(path.join(episodeDir, "youtube_upload_receipt_ep_01.json"), {
    status: "passed",
    channel: "53rebirth",
    video_id: videoId,
    title: `Fixture ${week}`,
  });
  const winnerSourceRelease = native ? {
    schema: "goldflow_ingest_winner_source_lineage_v1",
    release_sha256: "a".repeat(64),
    source_script_sha256: "b".repeat(64),
    winner_package_sha256: "c".repeat(64),
  } : null;
  await writeJson(path.join(episodeDir, "run_identity.json"), {
    channel: "53rebirth",
    week,
    episode: "ep_01",
    title: `Fixture ${week}`,
    ...(winnerSourceRelease ? { winner_source_release: winnerSourceRelease } : {}),
  });
  await writeJson(path.join(episodeDir, "source_story_ingest_report.json"), {
    schema: "goldflow_source_ingest_v1",
    channel: "53rebirth",
    week,
    episode: "ep_01",
    source_path: `/tmp/${week}.md`,
    script_clean_hash: "b".repeat(64),
    winner_source_release: winnerSourceRelease,
  });
  await writeJson(path.join(episodeDir, "operator_story_lock.json"), { status: "source_locked_ingest" });
  await writeJson(path.join(episodeDir, "operator_script_approval.json"), { status: "approved" });
  await writeJson(path.join(episodeDir, "final_qa_ep_01.json"), { status: "passed" });
  return episodeDir;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-script-origin-"));
try {
  const externalDir = await episodeFixture(tempDir, { week: "external-run", videoId: "external-video", native: false });
  const nativeDir = await episodeFixture(tempDir, { week: "native-run", videoId: "native-video", native: true });
  const external = await classifyUploadedEpisodeScriptOrigin({ episodeDir: externalDir });
  const native = await classifyUploadedEpisodeScriptOrigin({ episodeDir: nativeDir });

  assert.equal(external.production_lineage, "pipeline_native");
  assert.equal(external.script_origin, "external_ingest");
  assert.equal(external.source_room_lineage, "unavailable");
  assert.match(external.analytics_policy, /excluded from claims/i);
  assert.equal(native.production_lineage, "pipeline_native");
  assert.equal(native.script_origin, "goldflow_native");
  assert.equal(native.source_room_lineage, "hash_bound_winner_source_release");
  assert.equal(native.winner_source_release_complete, true);
  assert.equal(native.evidence.upload_receipt.sha256.length, 64);

  const registry = await buildYoutubeScriptOriginRegistry({
    dataRoot: tempDir,
    now: "2026-08-18T16:00:00.000Z",
  });
  assert.equal(registry.status, "classified");
  assert.deepEqual(registry.counts, {
    upload_count: 2,
    pipeline_native_count: 2,
    external_ingest_count: 1,
    goldflow_native_count: 1,
    unknown_count: 0,
  });
  assert.equal(registry.uploads.find((row) => row.video_id === "external-video").script_origin, "external_ingest");
  assert.equal(registry.uploads.find((row) => row.video_id === "native-video").script_origin, "goldflow_native");

  console.log("youtube script origin tests passed");
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
