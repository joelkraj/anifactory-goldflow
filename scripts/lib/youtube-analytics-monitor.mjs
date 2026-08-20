import { promises as fs } from "node:fs";
import path from "node:path";
import {
  YOUTUBE_ANALYTICS_FOLLOWUP_PLAN_SCHEMA,
  YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA,
} from "./youtube-analytics-followup-contract.mjs";
import { classifyUploadedEpisodeScriptOrigin } from "./youtube-script-origin.mjs";

export const YOUTUBE_ANALYTICS_MONITOR_SCHEMA = "goldflow_youtube_analytics_monitor_scan_v1";

function clean(value) {
  return String(value ?? "").trim();
}

function quoteShell(value) {
  return `'${String(value ?? "").replaceAll("'", `'\\''`)}'`;
}

async function readJson(filePath) {
  try {
    return { value: JSON.parse(await fs.readFile(filePath, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectPlanPaths(rootDir) {
  const paths = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && /^youtube_analytics_followup_plan_.+\.json$/.test(entry.name)) {
        paths.push(entryPath);
      }
    }));
  }
  await visit(rootDir);
  return paths.sort((left, right) => left.localeCompare(right));
}

function checkpointCommand({ episode_dir: episodeDir, window }) {
  return [
    "node bin/goldflow.mjs analytics record-followup",
    `--episode-dir ${quoteShell(episodeDir)}`,
    `--window ${quoteShell(window)}`,
    "--metrics <metrics.json>",
    "--captured-by goldflow-analytics-monitor",
  ].join(" ");
}

function anchorCommand({ episode_dir: episodeDir }) {
  return [
    "node bin/goldflow.mjs analytics plan-followups",
    `--episode-dir ${quoteShell(episodeDir)}`,
    "--anchor-at <verified-public-release-iso>",
  ].join(" ");
}

function snapshotPathFor({ episode_dir: episodeDir, episode, checkpoint }) {
  if (clean(checkpoint?.snapshot_path)) {
    return path.isAbsolute(checkpoint.snapshot_path)
      ? checkpoint.snapshot_path
      : path.resolve(episodeDir, checkpoint.snapshot_path);
  }
  return path.join(episodeDir, `youtube_analytics_snapshot_${episode}_${checkpoint.id}.json`);
}

function planIdentity(planPath, plan) {
  const episodeDir = path.dirname(planPath);
  const fileEpisode = path.basename(planPath).match(/^youtube_analytics_followup_plan_(.+)\.json$/)?.[1] ?? null;
  return {
    episode_dir: episodeDir,
    episode: clean(plan?.episode) || fileEpisode,
    video_id: clean(plan?.video_id) || null,
    plan_path: planPath,
  };
}

export async function discoverYoutubeAnalyticsCheckpoints({
  dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData",
  channel = null,
  now = new Date(),
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new Error("Analytics monitor requires a valid --now timestamp.");
  const channelsRoot = path.join(path.resolve(dataRoot), "channels");
  const scanRoot = clean(channel) ? path.join(channelsRoot, clean(channel)) : channelsRoot;
  const planPaths = await collectPlanPaths(scanRoot);
  const due = [];
  const pending = [];
  const captured = [];
  const awaitingReleaseAnchor = [];
  const blockers = [];

  for (const planPath of planPaths) {
    const parsed = await readJson(planPath);
    if (!parsed.value) {
      blockers.push({ code: "analytics_followup_plan_unreadable", plan_path: planPath, detail: parsed.error });
      continue;
    }
    const plan = parsed.value;
    const baseIdentity = planIdentity(planPath, plan);
    const origin = await classifyUploadedEpisodeScriptOrigin({
      episodeDir: baseIdentity.episode_dir,
      uploadReceiptPath: plan.upload_receipt_path ?? null,
    });
    const identity = {
      ...baseIdentity,
      production_lineage: origin.production_lineage,
      script_origin: origin.script_origin,
      source_room_lineage: origin.source_room_lineage,
    };
    if (plan.schema !== YOUTUBE_ANALYTICS_FOLLOWUP_PLAN_SCHEMA) {
      blockers.push({ code: "analytics_followup_plan_schema_invalid", ...identity, observed_schema: plan.schema ?? null });
      continue;
    }
    if (!Array.isArray(plan.checkpoints) || !plan.checkpoints.length) {
      blockers.push({ code: "analytics_followup_plan_checkpoints_missing", ...identity });
      continue;
    }
    if (plan.status === "awaiting_release_anchor") {
      awaitingReleaseAnchor.push({
        ...identity,
        analytics_anchor_at: null,
        next_command: anchorCommand(identity),
      });
      continue;
    }
    if (plan.status !== "scheduled") {
      blockers.push({ code: "analytics_followup_plan_status_invalid", ...identity, observed_status: plan.status ?? null });
      continue;
    }

    for (const checkpoint of plan.checkpoints) {
      const window = clean(checkpoint?.id);
      if (!window) {
        blockers.push({ code: "analytics_checkpoint_id_missing", ...identity });
        continue;
      }
      const snapshotPath = snapshotPathFor({ ...identity, checkpoint });
      if (await pathExists(snapshotPath)) {
        const snapshot = await readJson(snapshotPath);
        if (!snapshot.value) {
          blockers.push({
            code: "analytics_snapshot_unreadable",
            ...identity,
            window,
            snapshot_path: snapshotPath,
            detail: snapshot.error,
          });
        } else if (snapshot.value.schema !== YOUTUBE_ANALYTICS_SNAPSHOT_SCHEMA || snapshot.value.status !== "passed") {
          blockers.push({
            code: "analytics_snapshot_invalid",
            ...identity,
            window,
            snapshot_path: snapshotPath,
            observed_schema: snapshot.value.schema ?? null,
            observed_status: snapshot.value.status ?? null,
          });
        } else {
          captured.push({
            ...identity,
            window,
            due_at: checkpoint.due_at ?? null,
            captured_at: snapshot.value.captured_at ?? null,
            timing_delta_hours: snapshot.value.timing_delta_hours ?? null,
            snapshot_path: snapshotPath,
          });
        }
        continue;
      }

      const dueAt = new Date(checkpoint?.due_at);
      if (!checkpoint?.due_at || Number.isNaN(dueAt.getTime())) {
        blockers.push({ code: "analytics_checkpoint_due_at_invalid", ...identity, window, due_at: checkpoint?.due_at ?? null });
        continue;
      }
      const row = {
        ...identity,
        window,
        due_at: dueAt.toISOString(),
        snapshot_path: snapshotPath,
      };
      if (dueAt.getTime() <= nowDate.getTime()) {
        due.push({
          ...row,
          lateness_hours: Number(((nowDate.getTime() - dueAt.getTime()) / 3_600_000).toFixed(3)),
          next_command: checkpointCommand({ ...identity, window }),
        });
      } else {
        pending.push({
          ...row,
          due_in_hours: Number(((dueAt.getTime() - nowDate.getTime()) / 3_600_000).toFixed(3)),
        });
      }
    }
  }

  due.sort((left, right) => left.due_at.localeCompare(right.due_at));
  pending.sort((left, right) => left.due_at.localeCompare(right.due_at));
  captured.sort((left, right) => `${left.plan_path}:${left.window}`.localeCompare(`${right.plan_path}:${right.window}`));
  awaitingReleaseAnchor.sort((left, right) => left.plan_path.localeCompare(right.plan_path));
  return {
    schema: YOUTUBE_ANALYTICS_MONITOR_SCHEMA,
    status: blockers.length ? "partial" : "passed",
    non_blocking: true,
    scanned_at: nowDate.toISOString(),
    data_root: path.resolve(dataRoot),
    channel_filter: clean(channel) || null,
    plan_count: planPaths.length,
    due_count: due.length,
    pending_count: pending.length,
    captured_count: captured.length,
    awaiting_release_anchor_count: awaitingReleaseAnchor.length,
    blocker_count: blockers.length,
    due,
    pending,
    captured,
    awaiting_release_anchor: awaitingReleaseAnchor,
    blockers,
    policy: "Collect every overdue uncaptured checkpoint. Preserve the original 24h/72h/7d label and record capture lateness; never fabricate metrics or change production defaults automatically.",
  };
}
