// No-network tests for `analytics export-evidence`: the markdown follows the premise-evidence
// shape (measured header, hits-vs-flops, setting table, upload table, external outliers,
// measure-every-upload), comes only from the upload ledger + analytics snapshots + injected
// outliers, and leaves a hash receipt; invalid outliers are refused.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { EXTERNAL_OUTLIERS_SCHEMA, SETTING_TAGS_SCHEMA, exportPremiseEvidence, validateExternalOutliers } from "../lib/analytics-evidence-export.mjs";

const execFileAsync = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");

function metrics(overrides) {
  return { impressions: 1000, browse_ctr_percent: 6, suggested_ctr_percent: 5, first_30_sec_retention_percent: 54, first_60_sec_retention_percent: 40, average_view_duration_sec: 600, average_percentage_viewed: 30, traffic_sources: {}, new_viewers_percent: 10, returning_viewers_percent: 90, native_ab_watch_time: {}, ...overrides };
}

async function channelFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goldflow-evidence-export-"));
  const channelDir = path.join(root, "channels", "chan");
  const uploads = [
    { episode: "ep_01", week: "w1", title: "Hit one | Manhwa Recap", video_id: "v1", visibility: "public", recorded_at: "2026-06-12T00:00:00.000Z", day: metrics({ impressions: 40000, browse_ctr_percent: 7 }), late: metrics({ views: 151709, new_viewers_percent: 83, returning_viewers_percent: 17, first_30_sec_retention_percent: 55 }) },
    { episode: "ep_01", week: "w2", title: "Flop one | Manhwa Recap", video_id: "v2", visibility: "public", recorded_at: "2026-07-01T00:00:00.000Z", day: metrics({ impressions: 1200, browse_ctr_percent: 8 }), late: metrics({ views: 747, new_viewers_percent: 1.5, returning_viewers_percent: 98.5, first_30_sec_retention_percent: 53 }) },
    { episode: "ep_01", week: "w3", title: "No snapshot yet | Manhwa Recap", video_id: "v3", visibility: "public", recorded_at: "2026-10-14T00:00:00.000Z" },
    { episode: "ep_01", week: "w4", title: "Still private", video_id: "v4", visibility: "private", recorded_at: "2026-10-15T00:00:00.000Z" },
  ];
  const entries = [];
  for (const upload of uploads) {
    const episodeDir = path.join(channelDir, "weekly_runs", upload.week, "episodes", upload.episode);
    await fs.mkdir(episodeDir, { recursive: true });
    if (upload.day) await fs.writeFile(path.join(episodeDir, `youtube_analytics_snapshot_${upload.episode}_24h.json`), JSON.stringify({ schema: "goldflow_youtube_analytics_snapshot_v1", status: "passed", window: "24h", captured_at: "2026-06-13T00:00:00.000Z", metrics: upload.day }));
    if (upload.late) await fs.writeFile(path.join(episodeDir, `youtube_analytics_snapshot_${upload.episode}_7d.json`), JSON.stringify({ schema: "goldflow_youtube_analytics_snapshot_v1", status: "passed", window: "7d", captured_at: "2026-06-19T00:00:00.000Z", metrics: upload.late }));
    entries.push({ channel: "chan", episode: upload.episode, week: upload.week, episode_dir: episodeDir, video_id: upload.video_id, watch_url: `https://www.youtube.com/watch?v=${upload.video_id}`, title: upload.title, visibility: upload.visibility, recorded_at: upload.recorded_at });
  }
  await fs.writeFile(path.join(channelDir, "youtube_upload_ledger.json"), JSON.stringify({ schema: "goldflow_youtube_upload_ledger_v1", status: "passed", channel: "chan", entries }));
  await fs.writeFile(path.join(channelDir, "channel.json"), JSON.stringify({ channel_name: "Manhwa Joey" }));
  const outliersPath = path.join(root, "vidiq_outliers.json");
  await fs.writeFile(outliersPath, JSON.stringify({ schema: EXTERNAL_OUTLIERS_SCHEMA, source: "vidIQ outlier search", captured_at: "2026-10-18T00:00:00.000Z", query: "last 3 months, channels under 50K subscribers, 30K+ views", rows: [
    { title: "He Returned to Find His Wife Remarried", views: 791435, channel_subscribers: 6900, url: "https://www.youtube.com/watch?v=o1" },
    { title: "A 10,000x Spending System Woke Up", views: 312150, channel_subscribers: 3300, url: "https://www.youtube.com/watch?v=o2" },
  ] }));
  const settingsPath = path.join(root, "setting_tags.json");
  await fs.writeFile(settingsPath, JSON.stringify({ schema: SETTING_TAGS_SCHEMA, tags: { v1: "Modern real world", v2: "Fantasy / hunter / guild" } }));
  return { root, channelDir, outliersPath, settingsPath };
}

test("the export follows the premise-evidence shape from measured inputs only", async () => {
  const { root, outliersPath, settingsPath } = await channelFixture();
  const result = await exportPremiseEvidence({ dataRoot: root, channel: "chan", outliersPath, settingsPath, measuredOn: "2026-10-20", now: () => "2026-10-20T12:00:00.000Z" });
  const md = result.markdown;
  assert.match(md, /^# Manhwa Joey premise evidence, 2026-10-20\n/);
  assert.match(md, /Use as `--evidence` for `goldflow source manufacture ideate`/);
  for (const heading of ["## How this was measured", "## What separates own-channel hits from flops", "## Own-channel uploads (measured)", "## External outliers (measured)", "## Measure every upload"]) assert.ok(md.includes(`\n${heading}\n`), heading);
  assert.match(md, /3 public long-form uploads in the upload ledger, 2026-06-12 to 2026-10-14; 2 with hash-bound analytics snapshots/);
  assert.match(md, /"Hit" = 10,000\+ views\. Base hit rate 50% \(1\/2\)/);
  assert.match(md, /Hits: 83-83% of viewers were new to the channel; flops: 2-2%\. Day-one impressions: hits 40000-40000, flops 1200-1200/);
  assert.match(md, /\| Modern real world \| 1 \| 1 \| 100% \| 151,709 \|/);
  assert.match(md, /\| Fantasy \/ hunter \/ guild \| 1 \| 0 \| 0% \| 747 \|/);
  assert.match(md, /\| Hit one \\\| Manhwa Recap \| 151,709 \| 7d \| 83% \| 40,000 \| 7\.0% \| 55% \|/);
  assert.match(md, /\| No snapshot yet \\\| Manhwa Recap \| n\/a \| no snapshot \|/);
  assert.doesNotMatch(md, /Still private/);
  assert.match(md, /- "He Returned to Find His Wife Remarried" 791,435 \(6,900 subs\) https:\/\/www\.youtube\.com\/watch\?v=o1\n- "A 10,000x Spending System Woke Up" 312,150/);
  assert.doesNotMatch(md, /HYPOTHESIS:/);
  assert.equal(result.outputPath, path.join(root, "channels", "chan", "source_development", "2026-10-20-premise-evidence-export-v1.md"));
  assert.equal(await fs.readFile(result.outputPath, "utf8"), md);
  const receipt = JSON.parse(await fs.readFile(result.receiptPath, "utf8"));
  assert.equal(receipt.schema, "goldflow_premise_evidence_export_v1");
  assert.equal(receipt.output_sha256, sha(md));
  assert.equal(receipt.upload_ledger_sha256, sha(await fs.readFile(path.join(root, "channels", "chan", "youtube_upload_ledger.json"))));
  assert.equal(receipt.external_outliers.sha256, sha(await fs.readFile(outliersPath)));
  assert.equal(receipt.external_outliers.rows, 2);
  assert.equal(receipt.uploads, 3);
  assert.equal(receipt.uploads_with_snapshots, 2);
  // append-only: the same export path is never overwritten
  await assert.rejects(exportPremiseEvidence({ dataRoot: root, channel: "chan", measuredOn: "2026-10-20" }), /EEXIST/);
  // the in-process (injected MCP) outlier document works without a file
  const injected = await exportPremiseEvidence({ dataRoot: root, channel: "chan", outliers: { schema: EXTERNAL_OUTLIERS_SCHEMA, source: "vidiq_mcp", rows: [{ title: "X", views: 50000, url: "https://youtube.com/watch?v=x" }] }, outputPath: path.join(root, "injected.md") });
  assert.match(injected.markdown, /- "X" 50,000 https:\/\/youtube\.com\/watch\?v=x/);
  assert.equal(injected.receipt.external_outliers.path, null);
  await fs.rm(root, { recursive: true, force: true });
});

test("the CLI runs through goldflow and refuses invalid outliers or a missing channel", async () => {
  const { root, outliersPath } = await channelFixture();
  const env = { ...process.env, ANIFACTORY_DATA_ROOT: root };
  const { stdout } = await execFileAsync(process.execPath, ["bin/goldflow.mjs", "analytics", "export-evidence", "--channel", "chan", "--outliers", outliersPath, "--measured-on", "2026-10-21"], { cwd: process.cwd(), env });
  const out = JSON.parse(stdout);
  assert.equal(out.status, "passed");
  assert.match(out.next_action, /source manufacture run --development-slug <slug> --evidence /);
  assert.equal(out.external_outliers, 2);
  await fs.writeFile(outliersPath, JSON.stringify({ schema: EXTERNAL_OUTLIERS_SCHEMA, source: "x", rows: [{ title: "", views: "many", url: "nope" }] }));
  assert.deepEqual(validateExternalOutliers(JSON.parse(await fs.readFile(outliersPath, "utf8"))).blockers, ["external_outlier_title_missing:0", "external_outlier_views_invalid:0", "external_outlier_url_invalid:0"]);
  await assert.rejects(execFileAsync(process.execPath, ["scripts/analytics-export-evidence.mjs", "--channel", "chan", "--outliers", outliersPath, "--measured-on", "2026-10-22"], { cwd: process.cwd(), env }), /External outliers are invalid/);
  await assert.rejects(execFileAsync(process.execPath, ["scripts/analytics-export-evidence.mjs"], { cwd: process.cwd(), env }), /requires --channel/);
  await fs.rm(root, { recursive: true, force: true });
});
