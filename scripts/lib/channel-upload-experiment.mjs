import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const CHANNEL_UPLOAD_EXPERIMENT_SCHEMA = "goldflow_channel_upload_experiment_v1";

function clean(value) {
  return String(value ?? "").trim();
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function collectUploadReceiptPaths(rootDir) {
  const output = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && /^youtube_upload_receipt_.+\.json$/.test(entry.name)) output.push(entryPath);
    }));
  }
  await visit(rootDir);
  return output;
}

export async function activeChannelUploadExperiment({ repoRoot, channel }) {
  const directory = path.join(path.resolve(repoRoot), "docs", "channel_experiments");
  const names = await fs.readdir(directory).catch(() => []);
  const candidates = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const filePath = path.join(directory, name);
    const document = await readJson(filePath);
    if (
      document?.schema === CHANNEL_UPLOAD_EXPERIMENT_SCHEMA
      && clean(document.status) === "active"
      && clean(document.channel) === clean(channel)
    ) {
      candidates.push({ document, path: filePath, sha256: await sha256File(filePath) });
    }
  }
  if (candidates.length > 1) throw new Error(`Multiple active upload experiments found for channel ${channel}.`);
  return candidates[0] ?? null;
}

export async function verifyChannelUploadExperimentIdentity({ dataRoot, channel, experiment } = {}) {
  const expected = experiment?.channel_identity ?? null;
  if (!expected) return { status: "not_declared", blockers: [] };
  const channelRoot = path.join(path.resolve(dataRoot), "channels", clean(channel));
  const [channelConfig, brandContract] = await Promise.all([
    readJson(path.join(channelRoot, "channel.json")),
    readJson(path.join(channelRoot, "channel_brand", "channel_brand_contract.json")),
  ]);
  const blockers = [];
  if (clean(expected.internal_slug) !== clean(channel)) blockers.push("channel_experiment_internal_slug_mismatch");
  if (clean(channelConfig?.slug) !== clean(expected.internal_slug)) blockers.push("channel_experiment_channel_config_slug_mismatch");
  if (clean(channelConfig?.name) !== clean(expected.display_name)) blockers.push("channel_experiment_channel_config_name_mismatch");
  if (clean(brandContract?.channel_slug) !== clean(expected.internal_slug)) blockers.push("channel_experiment_brand_slug_mismatch");
  if (clean(brandContract?.display_name) !== clean(expected.display_name)) blockers.push("channel_experiment_brand_name_mismatch");
  if (clean(brandContract?.youtube_channel_id) !== clean(expected.youtube_channel_id)) blockers.push("channel_experiment_youtube_channel_id_mismatch");
  if (clean(brandContract?.handle) !== clean(expected.handle)) blockers.push("channel_experiment_youtube_handle_mismatch");
  return {
    status: blockers.length ? "blocked" : "passed",
    blockers: [...new Set(blockers)],
    channel_root: channelRoot,
    internal_slug: clean(expected.internal_slug),
    display_name: clean(expected.display_name),
    youtube_channel_id: clean(expected.youtube_channel_id),
    handle: clean(expected.handle),
  };
}

export async function channelUploadExperimentUsage({ dataRoot, channel, experimentId }) {
  const channelRoot = path.join(path.resolve(dataRoot), "channels", clean(channel), "weekly_runs");
  const receiptPaths = await collectUploadReceiptPaths(channelRoot);
  const receipts = [];
  for (const receiptPath of receiptPaths) {
    const receipt = await readJson(receiptPath);
    if (
      clean(receipt?.status) === "passed"
      && clean(receipt?.channel_experiment?.experiment_id) === clean(experimentId)
    ) {
      receipts.push({
        path: receiptPath,
        video_id: clean(receipt.video_id),
        recorded_at: clean(receipt.recorded_at),
        ordinal: Number(receipt.channel_experiment?.ordinal),
      });
    }
  }
  receipts.sort((left, right) => left.recorded_at.localeCompare(right.recorded_at));
  return { count: receipts.length, receipts };
}

export function validateChannelUploadExperimentSpec({ experiment, spec, durationSec, usedCount = 0 }) {
  if (!experiment || clean(experiment.status) !== "active") {
    return { applies: false, complete: false, ordinal: null, blockers: [] };
  }
  const eligibleUploadCount = Number(experiment.eligible_upload_count);
  if (Number(usedCount) >= eligibleUploadCount) {
    return { applies: false, complete: true, ordinal: null, blockers: [] };
  }
  const blockers = [];
  const runtime = experiment.runtime ?? {};
  const advertising = experiment.advertising ?? {};
  const settings = spec?.publish_settings ?? {};
  const positions = Array.isArray(settings.manual_mid_roll_positions_sec)
    ? settings.manual_mid_roll_positions_sec.map(Number)
    : [];
  const targets = Array.isArray(advertising.target_fractions)
    ? advertising.target_fractions.map(Number)
    : [];
  const duration = Number(durationSec);
  if (clean(settings.experiment_id) !== clean(experiment.experiment_id)) blockers.push("channel_experiment_id_missing_or_mismatch");
  if (clean(settings.monetization) !== clean(advertising.monetization)) blockers.push("channel_experiment_monetization_mismatch");
  if (clean(settings.mid_roll_mode) !== clean(advertising.mid_roll_mode)) blockers.push("channel_experiment_mid_roll_mode_mismatch");
  if (settings.automatic_mid_rolls !== advertising.automatic_mid_rolls) blockers.push("channel_experiment_automatic_mid_roll_setting_mismatch");
  if (Number(settings.manual_mid_roll_count) !== Number(advertising.manual_mid_roll_count)) blockers.push("channel_experiment_manual_mid_roll_count_mismatch");
  if (positions.length !== Number(advertising.manual_mid_roll_count)) blockers.push("channel_experiment_manual_mid_roll_positions_missing");
  if (!Number.isFinite(duration)) blockers.push("channel_experiment_final_duration_missing");
  if (Number.isFinite(duration) && duration < Number(runtime.acceptable_min_minutes) * 60) blockers.push("channel_experiment_runtime_below_range");
  if (Number.isFinite(duration) && duration > Number(runtime.acceptable_max_minutes) * 60) blockers.push("channel_experiment_runtime_above_range");
  if (Number.isFinite(duration) && positions.length === targets.length) {
    const toleranceSec = 90;
    if (positions.some((position, index) => Math.abs(position - duration * targets[index]) > toleranceSec)) {
      blockers.push("channel_experiment_mid_roll_position_outside_boundary_tolerance");
    }
  }
  return {
    applies: true,
    complete: false,
    ordinal: Number(usedCount) + 1,
    blockers: [...new Set(blockers)],
  };
}
