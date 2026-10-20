import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA, YOUTUBE_ANALYTICS_WINDOWS } from "./youtube-analytics-followup-contract.mjs";

// `analytics export-evidence --channel <id>`: a deterministic export of the measured
// own-channel evidence (upload ledger + hash-bound analytics snapshots) plus an optional,
// injected external-outlier set (vidIQ MCP export) into the `--evidence` markdown shape that
// `source manufacture ideate` consumes. Measured numbers only; nothing here is a hypothesis.
export const PREMISE_EVIDENCE_EXPORT_SCHEMA = "goldflow_premise_evidence_export_v1";
export const EXTERNAL_OUTLIERS_SCHEMA = "goldflow_external_outliers_v1";
export const SETTING_TAGS_SCHEMA = "goldflow_upload_setting_tags_v1";
export const DEFAULT_HIT_VIEWS = 10_000;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const finite = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null);
const fmt = (value) => (value == null ? "n/a" : Number(value).toLocaleString("en-US"));
const pct = (value, digits = 0) => (value == null ? "n/a" : `${Number(value).toFixed(digits)}%`);

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function median(values) {
  const rows = values.filter((value) => value != null).sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function range(values) {
  const rows = values.filter((value) => value != null);
  return rows.length ? [Math.min(...rows), Math.max(...rows)] : null;
}

/** Reads the newest snapshot per window for one upload; returns null when none exist. */
async function uploadSnapshots(entry) {
  const windows = {};
  for (const window of YOUTUBE_ANALYTICS_WINDOWS) {
    const snapshot = await readJson(path.join(entry.episode_dir, `youtube_analytics_snapshot_${entry.episode}_${window.id}.json`));
    if (snapshot?.schema === YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA && snapshot.status === "passed" && snapshot.metrics) {
      windows[window.id] = { captured_at: snapshot.captured_at ?? null, metrics: snapshot.metrics };
    }
  }
  return Object.keys(windows).length ? windows : null;
}

export async function collectChannelEvidence({ dataRoot, channel }) {
  const channelDir = path.join(dataRoot, "channels", channel);
  const ledgerPath = path.join(channelDir, "youtube_upload_ledger.json");
  const ledger = await readJson(ledgerPath);
  if (!ledger || !Array.isArray(ledger.entries)) throw new Error(`Missing or invalid upload ledger: ${ledgerPath}`);
  const channelConfig = await readJson(path.join(channelDir, "channel.json"));
  const uploads = [];
  for (const entry of ledger.entries) {
    if (!["public", "scheduled", "unlisted"].includes(String(entry.visibility ?? ""))) continue;
    const snapshots = entry.episode_dir ? await uploadSnapshots(entry) : null;
    const latestWindow = snapshots ? YOUTUBE_ANALYTICS_WINDOWS.map((row) => row.id).filter((id) => snapshots[id]).at(-1) : null;
    const latest = latestWindow ? snapshots[latestWindow].metrics : null;
    const dayOne = snapshots?.["24h"]?.metrics ?? null;
    uploads.push({
      video_id: entry.video_id,
      title: entry.title,
      watch_url: entry.watch_url ?? null,
      episode_dir: entry.episode_dir ?? null,
      recorded_at: entry.recorded_at ?? null,
      measured_window: latestWindow,
      views: finite(latest?.views),
      new_viewers_percent: finite(latest?.new_viewers_percent),
      subscriber_watch_time_percent: finite(latest?.subscriber_watch_time_percent),
      day_one_impressions: finite(dayOne?.impressions),
      day_one_ctr_percent: finite(dayOne?.browse_ctr_percent),
      first_30_sec_retention_percent: finite(latest?.first_30_sec_retention_percent),
      average_percentage_viewed: finite(latest?.average_percentage_viewed),
    });
  }
  uploads.sort((a, b) => String(a.recorded_at ?? "").localeCompare(String(b.recorded_at ?? "")));
  return {
    channel,
    channel_name: channelConfig?.channel_name ?? channelConfig?.name ?? channel,
    ledger_path: ledgerPath,
    ledger_sha256: sha256(await fs.readFile(ledgerPath)),
    uploads,
  };
}

export function validateExternalOutliers(document) {
  const blockers = [];
  if (document?.schema !== EXTERNAL_OUTLIERS_SCHEMA) blockers.push("external_outliers_schema_invalid");
  if (!String(document?.source ?? "").trim()) blockers.push("external_outliers_source_missing");
  if (!Array.isArray(document?.rows)) blockers.push("external_outliers_rows_invalid");
  for (const [index, row] of (Array.isArray(document?.rows) ? document.rows : []).entries()) {
    if (!String(row?.title ?? "").trim()) blockers.push(`external_outlier_title_missing:${index}`);
    if (finite(row?.views) == null) blockers.push(`external_outlier_views_invalid:${index}`);
    if (!/^https?:\/\//.test(String(row?.url ?? ""))) blockers.push(`external_outlier_url_invalid:${index}`);
  }
  return { done: blockers.length === 0, blockers };
}

function settingTable(uploads, tags, hitViews) {
  if (!tags) return null;
  const bySetting = new Map();
  for (const upload of uploads) {
    const setting = tags.tags?.[upload.video_id];
    if (!setting) continue;
    const row = bySetting.get(setting) ?? { setting, uploads: 0, hits: 0, views: [] };
    row.uploads += 1;
    if (upload.views != null && upload.views >= hitViews) row.hits += 1;
    if (upload.views != null) row.views.push(upload.views);
    bySetting.set(setting, row);
  }
  return [...bySetting.values()]
    .map((row) => ({ ...row, hit_rate: row.uploads ? row.hits / row.uploads : 0, median_views: median(row.views) }))
    .sort((a, b) => b.hit_rate - a.hit_rate || (b.median_views ?? 0) - (a.median_views ?? 0));
}

export function buildPremiseEvidenceMarkdown({ evidence, outliers = null, settings = null, hitViews = DEFAULT_HIT_VIEWS, measuredOn }) {
  const measured = evidence.uploads.filter((row) => row.views != null);
  const hits = measured.filter((row) => row.views >= hitViews);
  const flops = measured.filter((row) => row.views < hitViews);
  const dates = evidence.uploads.map((row) => String(row.recorded_at ?? "").slice(0, 10)).filter(Boolean).sort();
  const lines = [];
  lines.push(`# ${evidence.channel_name} premise evidence, ${measuredOn}`, "");
  lines.push("Use as `--evidence` for `goldflow source manufacture ideate`. Measured numbers are evidence; this export contains no HYPOTHESIS lines (add them by hand, labelled, if needed).", "");
  lines.push("## How this was measured");
  lines.push(`- Own channel: ${evidence.uploads.length} public long-form uploads in the upload ledger${dates.length ? `, ${dates[0]} to ${dates.at(-1)}` : ""}; ${measured.length} with hash-bound analytics snapshots (newest window per upload) exported on ${measuredOn}. "Hit" = ${fmt(hitViews)}+ views. Base hit rate ${measured.length ? pct((hits.length / measured.length) * 100) : "n/a"} (${hits.length}/${measured.length}).`);
  lines.push(`- Setting tags: ${settings ? `hand-assigned in ${path.basename(settings.path)} (${Object.keys(settings.tags ?? {}).length} tagged); small samples, treat as directional` : "none supplied; pass --settings <json> to add the setting table"}.`);
  lines.push(`- External outliers: ${outliers ? `${outliers.source}${outliers.captured_at ? `, captured ${String(outliers.captured_at).slice(0, 10)}` : ""}${outliers.query ? ` (${outliers.query})` : ""}; survivors of a much larger pool, not typical results` : "none supplied; pass --outliers <json> exported from the vidIQ MCP"}.`);
  lines.push("");
  lines.push("## What separates own-channel hits from flops");
  if (hits.length && flops.length) {
    const stat = (rows, key) => range(rows.map((row) => row[key]));
    const show = (value, suffix = "") => (value ? `${Number(value[0]).toFixed(0)}-${Number(value[1]).toFixed(0)}${suffix}` : "n/a");
    lines.push(`- Hits: ${show(stat(hits, "new_viewers_percent"), "%")} of viewers were new to the channel; flops: ${show(stat(flops, "new_viewers_percent"), "%")}. Day-one impressions: hits ${show(stat(hits, "day_one_impressions"))}, flops ${show(stat(flops, "day_one_impressions"))}.`);
    lines.push(`- Day-one CTR: hits ${show(stat(hits, "day_one_ctr_percent"), "%")}, flops ${show(stat(flops, "day_one_ctr_percent"), "%")}. 0:30 retention: hits ${show(stat(hits, "first_30_sec_retention_percent"), "%")}, flops ${show(stat(flops, "first_30_sec_retention_percent"), "%")}.`);
  } else {
    lines.push(`- Not enough measured uploads on both sides of the ${fmt(hitViews)}-view line to separate hits from flops (${hits.length} hits, ${flops.length} flops with snapshots).`);
  }
  const table = settingTable(evidence.uploads, settings, hitViews);
  if (table?.length) {
    lines.push("- Story setting (hand-assigned tags):", "", "| Setting | Uploads | Hits | Hit rate | Median views |", "|---|---:|---:|---:|---:|");
    for (const row of table) lines.push(`| ${row.setting} | ${row.uploads} | ${row.hits} | ${pct(row.hit_rate * 100)} | ${fmt(row.median_views)} |`);
  }
  lines.push("");
  lines.push("## Own-channel uploads (measured)");
  if (evidence.uploads.length) {
    lines.push("", "| Title | Views | Window | New viewers | Day-one impressions | Day-one CTR | 0:30 retention |", "|---|---:|---|---:|---:|---:|---:|");
    for (const row of [...evidence.uploads].sort((a, b) => (b.views ?? -1) - (a.views ?? -1))) {
      lines.push(`| ${String(row.title).replace(/\|/g, "\\|")} | ${fmt(row.views)} | ${row.measured_window ?? "no snapshot"} | ${pct(row.new_viewers_percent)} | ${fmt(row.day_one_impressions)} | ${pct(row.day_one_ctr_percent, 1)} | ${pct(row.first_30_sec_retention_percent)} |`);
    }
  } else {
    lines.push("- No public uploads in the ledger.");
  }
  lines.push("");
  lines.push("## External outliers (measured)");
  if (outliers?.rows?.length) {
    for (const row of [...outliers.rows].sort((a, b) => Number(b.views) - Number(a.views))) {
      lines.push(`- "${row.title}" ${fmt(row.views)}${row.channel_subscribers != null ? ` (${fmt(row.channel_subscribers)} subs)` : ""} ${row.url}`);
    }
  } else {
    lines.push("- None supplied.");
  }
  lines.push("");
  lines.push("## Measure every upload");
  lines.push("New-viewer share at 24h and 72h from the analytics snapshots (`analytics record-followup`). Under 5% at 72h means the video stayed inside the existing audience.");
  return `${lines.join("\n")}\n`;
}

/**
 * exportPremiseEvidence({ dataRoot, channel, outputPath?, outliersPath?, outliers?, settingsPath?, hitViews?, measuredOn?, now? })
 * `outliers` may be an already loaded document (the injected vidIQ MCP result); `outliersPath` a file.
 */
export async function exportPremiseEvidence({
  dataRoot,
  channel,
  outputPath = null,
  outliersPath = null,
  outliers = null,
  settingsPath = null,
  hitViews = DEFAULT_HIT_VIEWS,
  measuredOn = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!String(channel ?? "").trim()) throw new Error("analytics export-evidence requires --channel <id>.");
  const stamp = now();
  const day = measuredOn ?? stamp.slice(0, 10);
  const evidence = await collectChannelEvidence({ dataRoot, channel });
  let outlierDocument = outliers;
  let outliersSha256 = null;
  if (outliersPath) {
    const bytes = await fs.readFile(path.resolve(outliersPath));
    outlierDocument = JSON.parse(bytes.toString("utf8"));
    outliersSha256 = sha256(bytes);
  } else if (outlierDocument) {
    outliersSha256 = sha256(JSON.stringify(outlierDocument));
  }
  if (outlierDocument) {
    const validation = validateExternalOutliers(outlierDocument);
    if (!validation.done) throw new Error(`External outliers are invalid: ${validation.blockers.join(", ")}.`);
  }
  let settings = null;
  if (settingsPath) {
    const bytes = await fs.readFile(path.resolve(settingsPath));
    const document = JSON.parse(bytes.toString("utf8"));
    if (document?.schema !== SETTING_TAGS_SCHEMA || !document.tags || typeof document.tags !== "object") throw new Error(`Setting tags must be ${SETTING_TAGS_SCHEMA} with a tags object keyed by video id.`);
    settings = { path: path.resolve(settingsPath), sha256: sha256(bytes), tags: document.tags };
  }
  const markdown = buildPremiseEvidenceMarkdown({ evidence, outliers: outlierDocument, settings, hitViews, measuredOn: day });
  const resolvedOutput = path.resolve(outputPath ?? path.join(dataRoot, "channels", channel, "source_development", `${day}-premise-evidence-export-v1.md`));
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.writeFile(resolvedOutput, markdown, { flag: "wx" });
  const receipt = {
    schema: PREMISE_EVIDENCE_EXPORT_SCHEMA,
    status: "passed",
    channel,
    measured_on: day,
    hit_views: hitViews,
    output_path: resolvedOutput,
    output_sha256: sha256(markdown),
    upload_ledger_path: evidence.ledger_path,
    upload_ledger_sha256: evidence.ledger_sha256,
    uploads: evidence.uploads.length,
    uploads_with_snapshots: evidence.uploads.filter((row) => row.views != null).length,
    external_outliers: outlierDocument ? { source: outlierDocument.source, rows: outlierDocument.rows.length, sha256: outliersSha256, path: outliersPath ? path.resolve(outliersPath) : null } : null,
    setting_tags: settings ? { path: settings.path, sha256: settings.sha256 } : null,
    policy: "Deterministic export of measured evidence. External views measure public demand, not retention; own-channel analytics measure viewing after the click. Nothing here is a hypothesis or an automatic premise decision.",
    exported_at: stamp,
  };
  const receiptPath = `${resolvedOutput.replace(/\.md$/, "")}.receipt.json`;
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return { markdown, receipt, outputPath: resolvedOutput, receiptPath };
}
