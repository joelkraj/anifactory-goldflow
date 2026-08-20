import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256File } from "./file-hash.mjs";

export const YOUTUBE_SCRIPT_ORIGIN_REGISTRY_SCHEMA = "goldflow_youtube_script_origin_registry_v1";
export const YOUTUBE_SCRIPT_ORIGIN_RECORD_SCHEMA = "goldflow_youtube_script_origin_record_v1";

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function fileEvidence(filePath) {
  try {
    return { path: filePath, sha256: await sha256File(filePath), exists: true };
  } catch {
    return { path: filePath, sha256: null, exists: false };
  }
}

async function collectUploadReceiptPaths(rootDir) {
  const results = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["_archives", "_snapshots"].includes(entry.name)) await visit(entryPath);
      } else if (entry.isFile() && /^youtube_upload_receipt_.+\.json$/.test(entry.name)) {
        results.push(entryPath);
      }
    }));
  }
  await visit(rootDir);
  return results.sort((left, right) => left.localeCompare(right));
}

function winnerSourceBinding({ ingest, identity, storyLock }) {
  return ingest?.winner_source_release
    ?? identity?.winner_source_release
    ?? storyLock?.winner_source_release
    ?? null;
}

function nativeBindingComplete(binding) {
  return Boolean(
    binding
    && binding.release_sha256
    && binding.source_script_sha256
    && binding.winner_package_sha256,
  );
}

export async function classifyUploadedEpisodeScriptOrigin({ episodeDir, uploadReceiptPath = null } = {}) {
  const resolvedEpisodeDir = path.resolve(episodeDir);
  const episode = path.basename(resolvedEpisodeDir);
  const resolvedReceiptPath = uploadReceiptPath
    ? path.resolve(uploadReceiptPath)
    : path.join(resolvedEpisodeDir, `youtube_upload_receipt_${episode}.json`);
  const paths = {
    upload_receipt: resolvedReceiptPath,
    run_identity: path.join(resolvedEpisodeDir, "run_identity.json"),
    source_ingest_report: path.join(resolvedEpisodeDir, "source_story_ingest_report.json"),
    operator_story_lock: path.join(resolvedEpisodeDir, "operator_story_lock.json"),
    operator_script_approval: path.join(resolvedEpisodeDir, "operator_script_approval.json"),
    script_clean: path.join(resolvedEpisodeDir, "script_clean.md"),
    final_qa: path.join(resolvedEpisodeDir, `final_qa_${episode}.json`),
  };
  const [receipt, identity, ingest, storyLock, scriptApproval, finalQa] = await Promise.all([
    readJson(paths.upload_receipt),
    readJson(paths.run_identity),
    readJson(paths.source_ingest_report),
    readJson(paths.operator_story_lock),
    readJson(paths.operator_script_approval),
    readJson(paths.final_qa),
  ]);
  const binding = winnerSourceBinding({ ingest, identity, storyLock });
  const hasNativeBinding = nativeBindingComplete(binding);
  const scriptOrigin = hasNativeBinding
    ? "goldflow_native"
    : ingest?.schema === "goldflow_source_ingest_v1"
      ? "external_ingest"
      : "unknown";
  const productionLineage = receipt && identity && ingest && scriptApproval && finalQa?.status === "passed"
    ? "pipeline_native"
    : "pipeline_native_incomplete_evidence";
  const evidence = Object.fromEntries(await Promise.all(
    Object.entries(paths).map(async ([key, filePath]) => [key, await fileEvidence(filePath)]),
  ));
  return {
    schema: YOUTUBE_SCRIPT_ORIGIN_RECORD_SCHEMA,
    status: scriptOrigin === "unknown" ? "needs_review" : "classified",
    channel: receipt?.channel ?? ingest?.channel ?? identity?.channel ?? null,
    week: ingest?.week ?? identity?.week ?? null,
    episode: ingest?.episode ?? identity?.episode ?? episode,
    episode_dir: resolvedEpisodeDir,
    video_id: receipt?.video_id ?? null,
    title: receipt?.title ?? identity?.title ?? null,
    production_lineage: productionLineage,
    script_origin: scriptOrigin,
    source_room_lineage: hasNativeBinding ? "hash_bound_winner_source_release" : "unavailable",
    source_path: ingest?.source_path ?? identity?.source_path ?? null,
    source_script_sha256: ingest?.script_clean_hash ?? identity?.source_sha256 ?? null,
    winner_source_release_present: Boolean(binding),
    winner_source_release_complete: hasNativeBinding,
    winner_source_release_schema: binding?.schema ?? null,
    classification_basis: hasNativeBinding
      ? "A complete hash-bound winner-source release is attached to ingest/run identity."
      : ingest?.schema === "goldflow_source_ingest_v1"
        ? "The episode was ingested and produced by Goldflow, but no complete winner-source release binds native premise/draft development."
        : "The episode lacks enough ingest lineage to determine script origin.",
    analytics_policy: hasNativeBinding
      ? "Eligible for source-room and downstream production learning."
      : "Eligible for downstream production, packaging, and timestamp retention learning; excluded from claims about Goldflow-native premise, drafting, selection, or revision performance.",
    evidence,
  };
}

export async function buildYoutubeScriptOriginRegistry({
  dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData",
  channel = null,
  now = new Date(),
} = {}) {
  const channelsRoot = path.join(path.resolve(dataRoot), "channels");
  const scanRoot = channel ? path.join(channelsRoot, channel) : channelsRoot;
  const receiptPaths = await collectUploadReceiptPaths(scanRoot);
  const uploads = await Promise.all(receiptPaths.map((uploadReceiptPath) => (
    classifyUploadedEpisodeScriptOrigin({ episodeDir: path.dirname(uploadReceiptPath), uploadReceiptPath })
  )));
  uploads.sort((left, right) => `${left.channel}:${left.week}:${left.episode}`.localeCompare(`${right.channel}:${right.week}:${right.episode}`));
  const counts = {
    upload_count: uploads.length,
    pipeline_native_count: uploads.filter((row) => row.production_lineage === "pipeline_native").length,
    external_ingest_count: uploads.filter((row) => row.script_origin === "external_ingest").length,
    goldflow_native_count: uploads.filter((row) => row.script_origin === "goldflow_native").length,
    unknown_count: uploads.filter((row) => row.script_origin === "unknown").length,
  };
  return {
    schema: YOUTUBE_SCRIPT_ORIGIN_REGISTRY_SCHEMA,
    status: counts.unknown_count ? "needs_review" : "classified",
    generated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    data_root: path.resolve(dataRoot),
    channel_filter: channel ?? null,
    counts,
    policy: "Script origin and production lineage are independent. External-ingest scripts remain eligible for downstream production analytics but cannot validate Goldflow-native source-room quality.",
    uploads,
  };
}
