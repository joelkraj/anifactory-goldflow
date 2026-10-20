// Self-contained validator shared by the local review editor and render loader.
export function validatePanelTimeline(timeline, mode = 'engine_proof') {
const fail = (message) => { throw new Error(`Panel timeline: ${message}`); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const number = (v, min, max, name) => ensure(Number.isFinite(v) && v >= min && v <= max, `${name} must be within ${min}..${max}`);
const text = (v, name) => ensure(typeof v === 'string' && v.trim().length > 0, `${name} is required`);
const hash = (v, name) => ensure(typeof v === 'string' && /^[a-f0-9]{64}$/.test(v), `${name} must be a SHA-256`);
const unique = (rows, name) => {
  ensure(Array.isArray(rows) && rows.length > 0, `${name} must be nonempty`);
  const ids = new Set();
  for (const row of rows) {
    ensure(row && typeof row === 'object', `${name} row must be an object`);
    text(row.id, `${name}.id`);
    ensure(!ids.has(row.id), `duplicate ${name} id ${row.id}`);
    ids.add(row.id);
  }
  return ids;
};


  ensure(['engine_proof', 'editing_experiment', 'production_panel_composition'].includes(mode), 'unsupported validation mode');
  const experiment = mode === 'editing_experiment';
  const production = mode === 'production_panel_composition';
  ensure(timeline?.schema === (production ? 'goldflow_panel_production_timeline_v1' : experiment ? 'goldflow_panel_experiment_timeline_v1' : 'goldflow_panel_timeline_v1'), 'unsupported schema');
  ensure(timeline.intent === mode, `only ${mode} is supported`);
  if (experiment) {
    text(timeline.experiment_identity?.path, 'experiment_identity.path');
    hash(timeline.experiment_identity?.sha256, 'experiment_identity.sha256');
  }
  if (production) {
    text(timeline.run_identity?.path, 'run_identity.path');
    hash(timeline.run_identity?.sha256, 'run_identity.sha256');
    ensure(timeline.audio_target === 'narrator_only' && timeline.audio?.offset_sec === 0, 'production requires the complete continuous narrator-only master');
  }
  ensure(timeline.content_profile === 'manhwa_recap_v1', 'explicit manhwa_recap_v1 profile required');
  text(timeline.id, 'id');
  number(timeline.duration_sec, 0.1, production ? 86400 : experiment ? 1800 : 150, 'duration_sec');
  number(timeline.width, 160, 1920, 'width');
  number(timeline.height, 90, 1080, 'height');
  ensure(Number.isInteger(timeline.width / 2) && Number.isInteger(timeline.height / 2), 'canvas must have even dimensions');
  ensure(timeline.width * 9 === timeline.height * 16, 'canvas must be 16:9');
  ensure([24, 25, 30, 60].includes(timeline.fps), 'fps must be 24, 25, 30, or 60');
  ensure(['narrator_only', 'silent_fixture'].includes(timeline.audio_target), 'audio_target required');
  if (timeline.audio_target === 'narrator_only') {
    text(timeline.audio?.path, 'audio.path');
    hash(timeline.audio?.sha256, 'audio.sha256');
    number(timeline.audio?.offset_sec, 0, 86400, 'audio.offset_sec');
  } else ensure(timeline.audio == null, 'silent_fixture must not include audio');
  const assets = unique(timeline.assets, 'assets');
  ensure(timeline.assets.length <= (production ? 40000 : experiment ? 2000 : 100), 'too many assets for the selected scope');
  for (const asset of timeline.assets) {
    text(asset.path, 'asset.path'); hash(asset.sha256, 'asset.sha256');
    ensure(['original_generated', 'existing_artwork', 'continuity_generated', 'test_fixture'].includes(asset.origin), `unknown origin for ${asset.id}`);
    text(asset.provenance, `asset ${asset.id} provenance`);
  }
  const panels = unique(timeline.panels, 'panels');
  for (const panel of timeline.panels) {
    ensure(assets.has(panel.asset_id), `unknown asset for panel ${panel.id}`);
    const crop = panel.source_rect;
    ensure(crop && typeof crop === 'object', `source_rect required for ${panel.id}`);
    for (const key of ['x', 'y']) number(crop[key], 0, 1, `panel ${panel.id} crop ${key}`);
    for (const key of ['width', 'height']) number(crop[key], 0.001, 1, `panel ${panel.id} crop ${key}`);
    ensure(crop.x + crop.width <= 1 + 1e-9 && crop.y + crop.height <= 1 + 1e-9, `crop outside source for ${panel.id}`);
  }
  unique(timeline.scenes, 'scenes');
  let end = 0;
  const layerIds = new Set();
  for (const scene of timeline.scenes) {
    number(scene.start_sec, 0, timeline.duration_sec, 'scene.start_sec');
    number(scene.end_sec, 0, timeline.duration_sec, 'scene.end_sec');
    ensure(Math.abs(scene.start_sec - end) < 1e-7 && scene.end_sec > scene.start_sec, `scene ${scene.id} has a gap, overlap, or invalid duration`);
    end = scene.end_sec;
    ensure(panels.has(scene.background?.panel_id), `scene ${scene.id} background panel missing`);
    number(scene.background.blur_px, 0, 80, 'background.blur_px');
    number(scene.background.brightness, 0, 1, 'background.brightness');
    unique(scene.layers, `scene ${scene.id} layers`);
    ensure(scene.layers.length <= 12, 'at most 12 simultaneous scene layers supported');
    const zValues = new Set();
    for (const layer of scene.layers) {
      ensure(!layerIds.has(layer.id), `duplicate global layer id ${layer.id}`); layerIds.add(layer.id);
      ensure(panels.has(layer.panel_id), `layer ${layer.id} panel missing`);
      ensure(['cover', 'contain'].includes(layer.fit), `layer ${layer.id} fit required`);
      number(layer.start_sec, scene.start_sec, scene.end_sec, 'layer.start_sec');
      number(layer.end_sec, layer.start_sec, scene.end_sec, 'layer.end_sec');
      ensure(layer.end_sec > layer.start_sec, `layer ${layer.id} has zero duration`);
      ensure(Number.isInteger(layer.z) && !zValues.has(layer.z), `layer ${layer.id} z must be a unique integer within the scene`); zValues.add(layer.z);
      number(layer.border_px, 0, 20, 'border_px');
      const keys = layer.keyframes;
      ensure(Array.isArray(keys) && keys.length >= 2 && keys.length <= 32, `layer ${layer.id} needs 2..32 keys`);
      ensure(keys[0].at_sec === layer.start_sec && keys.at(-1).at_sec === layer.end_sec, `layer ${layer.id} keys must span its exact lifetime`);
      let prior = -Infinity;
      for (const key of keys) {
        number(key.at_sec, layer.start_sec, layer.end_sec, 'key.at_sec');
        ensure(key.at_sec > prior, `layer ${layer.id} key times must increase`); prior = key.at_sec;
        ensure(['smooth', 'linear', 'hold'].includes(key.easing), 'key easing required');
        ensure(key.rect && key.camera, 'key rect and camera required');
        for (const axis of ['x', 'y']) number(key.rect[axis], -3, 3, `rect.${axis}`);
        for (const axis of ['width', 'height']) number(key.rect[axis], 0.01, 4, `rect.${axis}`);
        for (const axis of ['x', 'y']) number(key.camera[axis], 0, 1, `camera.${axis}`);
        number(key.camera.zoom, 1, 4, 'camera.zoom'); number(key.opacity, 0, 1, 'opacity');
      }
    }
  }
  ensure(Math.abs(end - timeline.duration_sec) < 1e-7, 'scenes must cover the complete duration');
  return timeline;
}
