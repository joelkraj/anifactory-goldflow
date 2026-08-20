export const ANALYTICS_LEARNING_READINESS_SCHEMA = "goldflow_analytics_learning_readiness_v1";

const WINDOW_RANK = new Map([
  ["24h", 1],
  ["72h", 2],
  ["7d", 3],
]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function episodeId(report) {
  return String(report?.video_id ?? report?.episode ?? "").trim() || null;
}

function snapshotWindow(report) {
  const label = String(report?.snapshot_label ?? "").trim().toLowerCase();
  if (["7d", "7_day", "seven_day"].includes(label)) return "7d";
  if (["72h", "72_hour", "three_day"].includes(label)) return "72h";
  if (["24h", "24_hour", "one_day"].includes(label)) return "24h";
  return label || "unknown";
}

function reportPreference(report) {
  const window = snapshotWindow(report);
  return [
    WINDOW_RANK.get(window) ?? 0,
    finite(report?.summary_metrics?.impressions) ?? 0,
    String(report?.updated_at ?? ""),
  ];
}

function preferenceIsGreater(left, right) {
  const leftPreference = reportPreference(left);
  const rightPreference = reportPreference(right);
  for (let index = 0; index < leftPreference.length; index += 1) {
    if (leftPreference[index] === rightPreference[index]) continue;
    return leftPreference[index] > rightPreference[index];
  }
  return false;
}

export function latestDistinctEpisodeReports(reports = []) {
  const selected = new Map();
  for (const report of reports) {
    const id = episodeId(report);
    if (!id) continue;
    const prior = selected.get(id);
    if (!prior || preferenceIsGreater(report, prior)) selected.set(id, report);
  }
  return [...selected.values()];
}

function hasCtr(report) {
  return finite(report?.summary_metrics?.ctr_percent) != null
    && finite(report?.summary_metrics?.impressions) != null;
}

function hasRetention(report) {
  return finite(report?.summary_metrics?.average_percentage_viewed) != null
    || finite(report?.summary_metrics?.average_view_duration_sec) != null
    || Number(report?.retention_point_count ?? 0) > 0;
}

function isMature(report) {
  return ["72h", "7d"].includes(snapshotWindow(report));
}

function isPipelineNative(report) {
  return String(report?.production_lineage ?? "").startsWith("pipeline_native");
}

function isGoldflowNative(report) {
  return report?.script_origin === "goldflow_native"
    && report?.source_room_lineage === "hash_bound_winner_source_release";
}

function domainReadiness({ id, reports, minimumEpisodes, requirements }) {
  const ids = reports.map(episodeId).filter(Boolean);
  const missing = [];
  if (ids.length < minimumEpisodes) missing.push(`need_${minimumEpisodes - ids.length}_more_distinct_episodes`);
  return {
    domain: id,
    status: missing.length ? "hold" : "operator_review_allowed",
    distinct_episode_count: ids.length,
    minimum_distinct_episode_count: minimumEpisodes,
    episode_ids: ids,
    requirements,
    unmet_requirements: missing,
    automatic_default_changes_allowed: false,
    operator_approval_required: true,
  };
}

export function buildAnalyticsLearningReadiness(reports = [], { minimumEpisodes = 3 } = {}) {
  const latest = latestDistinctEpisodeReports(reports);
  const packaging = latest.filter(hasCtr);
  const production = latest.filter((report) => isPipelineNative(report) && hasRetention(report));
  const sourceRoom = latest.filter((report) => (
    isGoldflowNative(report)
    && isMature(report)
    && hasCtr(report)
    && hasRetention(report)
  ));
  return {
    schema: ANALYTICS_LEARNING_READINESS_SCHEMA,
    status: "observational",
    policy: "Analytics may create hash-bound review proposals. It never edits prompts, policies, defaults, or production profiles automatically.",
    snapshot_count: reports.length,
    distinct_episode_count: latest.length,
    selected_snapshot_by_episode: Object.fromEntries(latest.map((report) => [episodeId(report), snapshotWindow(report)])),
    domains: {
      packaging: domainReadiness({
        id: "packaging",
        reports: packaging,
        minimumEpisodes,
        requirements: ["distinct episodes", "CTR", "impressions"],
      }),
      production: domainReadiness({
        id: "production",
        reports: production,
        minimumEpisodes,
        requirements: ["pipeline-native production", "retention or watch-time outcome"],
      }),
      source_room: domainReadiness({
        id: "source_room",
        reports: sourceRoom,
        minimumEpisodes,
        requirements: [
          "goldflow_native script origin",
          "complete hash-bound winner-source release",
          "72h or 7d snapshot",
          "CTR and impressions",
          "retention or watch-time outcome",
        ],
      }),
    },
    automatic_default_changes_allowed: false,
    operator_approval_required: true,
  };
}
