import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { sha256File } from './file-hash.mjs';
import { validatePanelTimeline } from './panel-layout-validation.mjs';

const requireValue = (condition, message) => { if (!condition) throw new Error(`Panel experiment: ${message}`); };
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requiredText = value => typeof value === 'string' && value.trim().length > 0;

export function validatePanelExperimentTimeline(timeline) {
  validatePanelTimeline(timeline, 'editing_experiment');
  requireValue(timeline.schema === 'goldflow_panel_experiment_timeline_v1' && timeline.intent === 'editing_experiment', 'separate editing_experiment timeline required');
  requireValue(requiredText(timeline.experiment_identity?.path) && validHash(timeline.experiment_identity?.sha256), 'hash-bound experiment_identity required');
  return timeline;
}

/** Validate/hash sources without expanding all artwork into memory. */
export async function loadPanelExperimentTimeline(timelinePath, { includeDataUrls = false } = {}) {
  const manifestPath = await fs.realpath(path.resolve(timelinePath));
  const timeline = validatePanelExperimentTimeline(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  const source_hashes = { [manifestPath]: await sha256File(manifestPath) };
  const boundFile = async (ref, base, label) => {
    requireValue(requiredText(ref?.path) && validHash(ref?.sha256), `${label} requires path and SHA-256`);
    requireValue(!/^[a-z][a-z0-9+.-]*:/i.test(ref.path), `${label} requires a local file`);
    const file = await fs.realpath(path.resolve(base, ref.path));
    requireValue((await fs.stat(file)).isFile(), `${label} is not a file`);
    requireValue(await sha256File(file) === ref.sha256, `${label} has a stale source hash`);
    source_hashes[file] = ref.sha256;
    return file;
  };
  const identityPath = await boundFile(timeline.experiment_identity, path.dirname(manifestPath), 'experiment identity');
  const identity = JSON.parse(await fs.readFile(identityPath, 'utf8'));
  requireValue(identity.schema === 'goldflow_panel_experiment_identity_v1', 'unsupported experiment identity');
  for (const field of ['id', 'channel', 'series', 'episode', 'title']) requireValue(requiredText(identity[field]), `identity.${field} is required`);
  requireValue(identity.id === timeline.id, 'timeline ID differs from experiment identity');
  requireValue(identity.content_profile === 'manhwa_recap_v1', 'identity content profile must be manhwa_recap_v1');
  requireValue(['original_story', 'comic_adaptation', 'prose_adaptation'].includes(identity.source_mode), 'identity.source_mode required');
  requireValue(identity.visibility === 'private_review' && identity.provider_policy === 'local_artifacts_only', 'private_review and local_artifacts_only are required');
  const scope = identity.scope;
  requireValue(Number.isFinite(scope?.max_duration_sec) && scope.max_duration_sec > 0 && scope.max_duration_sec <= 1800, 'identity duration limit must be within 0..1800 seconds');
  requireValue(timeline.duration_sec <= scope.max_duration_sec, 'timeline exceeds identity duration scope');
  requireValue(timeline.audio_target !== 'silent_fixture' || identity.channel === 'fixture', 'silent_fixture requires identity.channel fixture');
  const sourcePath = await boundFile(identity.source, path.dirname(identityPath), 'identity source');
  // Original-story packets bind the approvals/timing they imported. An intact
  // packet must not conceal a changed upstream approval, script or source file.
  const sourcePacket = await fs.readFile(sourcePath, 'utf8').then(value => { try { return JSON.parse(value); } catch { return null; } });
  if (sourcePacket?.schema === 'goldflow_original_panel_source_packet_v1') {
    requireValue(sourcePacket.source_hashes && Object.keys(sourcePacket.source_hashes).length > 0, 'original source packet has no provenance');
    for (const [file, sha256] of Object.entries(sourcePacket.source_hashes)) await boundFile({ path: file, sha256 }, path.dirname(sourcePath), 'original source dependency');
  }
  const audio = timeline.audio ? { ...timeline.audio, path: await boundFile(timeline.audio, path.dirname(manifestPath), 'narration') } : null;
  if (scope.source_start_sec !== undefined || scope.source_end_sec !== undefined) {
    requireValue(Number.isFinite(scope.source_start_sec) && scope.source_start_sec >= 0 && Number.isFinite(scope.source_end_sec) && scope.source_end_sec > scope.source_start_sec, 'identity source window requires valid start and end');
    requireValue(audio && Math.abs(audio.offset_sec - scope.source_start_sec) < 1e-7 && Math.abs(timeline.duration_sec - (scope.source_end_sec - scope.source_start_sec)) < 1e-7, 'audio window differs from identity scope');
  }
  const assets = [];
  for (const asset of timeline.assets) {
    const file = await boundFile(asset, path.dirname(manifestPath), `asset ${asset.id}`);
    const metadata = await sharp(file, { limitInputPixels: 100_000_000 }).metadata();
    requireValue(['png', 'jpeg', 'webp'].includes(metadata.format) && (!metadata.pages || metadata.pages === 1), `asset ${asset.id} must be one PNG/JPEG/WebP raster`);
    const row = { ...asset, path: file, width: metadata.width, height: metadata.height };
    if (includeDataUrls) {
      const bytes = await sharp(file, { limitInputPixels: 100_000_000 }).rotate().png().toBuffer();
      row.data_url = `data:image/png;base64,${bytes.toString('base64')}`;
    }
    assets.push(row);
  }
  return { timeline, assets, audio, source_hashes, identity, identity_path: identityPath, source_path: sourcePath, timeline_path: manifestPath };
}
