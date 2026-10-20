import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './file-hash.mjs';
import { loadPanelExperimentTimeline, validatePanelExperimentTimeline } from './panel-experiment-contract.mjs';
import { validatePanelTimeline } from './panel-layout-validation.mjs';

const fail = message => { throw new Error(`Panel composition: ${message}`); };
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const full = { x: 0, y: 0, width: 1, height: 1 };
const inset = { x: 0.04, y: 0.05, width: 0.92, height: 0.9 };
const camera = { x: 0.5, y: 0.5, zoom: 1 };

async function assertNewOutput(outputDir) {
  const output = path.resolve(outputDir);
  if (output.split(path.sep).includes('episodes')) fail('composition outputs must stay outside episode folders');
  for (let current = output; ; current = path.dirname(current)) {
    if (await fs.stat(path.join(current, 'run_identity.json')).then(() => true, () => false)) fail('cannot write inside an existing episode');
    if (path.dirname(current) === current) break;
  }
  if (await fs.lstat(output).then(() => true, () => false)) fail('output exists; use a new candidate directory');
  let ancestor = path.dirname(output);
  while (!await fs.stat(ancestor).then(() => true, () => false)) ancestor = path.dirname(ancestor);
  const real = await fs.realpath(ancestor);
  if (real !== ancestor) return assertNewOutput(path.join(real, path.relative(ancestor, output)));
  return output;
}

export async function createPanelCompositionTemplate({ timelinePath, outputDir }) {
  const loaded = await loadPanelExperimentTimeline(timelinePath);
  const output = await assertNewOutput(outputDir);
  const recipe = {
    schema: 'goldflow_panel_composition_recipe_v1',
    source_timeline: { path: path.resolve(timelinePath), sha256: await sha256File(timelinePath) },
    experiment_identity: loaded.timeline.experiment_identity,
    author: null,
    decisions: loaded.timeline.scenes.map(scene => ({
      scene_id: scene.id, layout: null, panel_id: scene.layers[0].panel_id,
      background_panel_id: scene.background.panel_id, editorial_reason: null,
      source_rect: null, rect: null, fit: 'contain',
      camera_from: { ...camera }, camera_to: { ...camera },
      entry: null, context: null,
    })),
  };
  const packet = {
    schema: 'goldflow_panel_composition_authoring_packet_v1', id: loaded.timeline.id,
    source_timeline: recipe.source_timeline,
    instructions: [
      'Author each composition from its actual narration and inspected artwork. Choose every layout explicitly; do not run a repeating transition cycle.',
      'Keep exact scene boundaries. An explicit context panel may hold an earlier view during a reveal. Review source order and spoilers editorially: the compiler checks panel references but cannot judge when an event should be disclosed.',
      'Use full_frame, inset, reveal, reaction_pair or page_pan. Prefer static holds where they serve reading or dialogue. Camera moves, crops and entry durations are authored decisions.',
      'source_rect crops within the indexed panel, rect places it on screen. Preserve faces and image-native lettering; inspect the real frame.',
      'reveal and reaction_pair require entry {direction,start_sec,duration_sec} and context {panel_id,rect,fit,end_sec}. Absolute times refer to this experiment timeline.',
      'page_pan requires explicit camera_from/camera_to. Optional move_start_sec and move_end_sec add authored holds around a move.',
      'Every decision requires editorial_reason. No missing decisions are automatically filled. This is a private experiment, not a publishing approval.',
    ],
    panels: loaded.timeline.panels,
    assets: loaded.assets.map(({ data_url, ...row }) => row),
    scenes: loaded.timeline.scenes.map(scene => ({
      id: scene.id, start_sec: scene.start_sec, end_sec: scene.end_sec,
      original_panels: scene.layers.map(layer => layer.panel_id),
      narration: loaded.timeline.panels.find(panel => panel.id === scene.layers[0].panel_id)?.metadata?.narration_excerpt ?? null,
    })),
  };
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output);
  await fs.writeFile(path.join(output, 'recipe.json'), json(recipe), { flag: 'wx' });
  await fs.writeFile(path.join(output, 'authoring_packet.json'), json(packet), { flag: 'wx' });
  return { status: 'needs_authoring', recipe_path: path.join(output, 'recipe.json'), packet_path: path.join(output, 'authoring_packet.json'), decision_count: recipe.decisions.length };
}

function key(at_sec, rect, view = camera, easing = 'smooth') { return { at_sec, rect: { ...rect }, camera: { ...view }, opacity: 1, easing }; }

function cameraKeys(start, end, rect, row) {
  const from = row.camera_from ?? camera, to = row.camera_to ?? from;
  const toRect = row.rect_to ?? rect;
  if (row.rect_to && (!['x', 'y', 'width', 'height'].every(k => Number.isFinite(toRect[k]))
    || toRect.x < 0 || toRect.y < 0 || toRect.width <= 0 || toRect.height <= 0
    || toRect.x + toRect.width > 1 + 1e-9 || toRect.y + toRect.height > 1 + 1e-9)) fail(`invalid panel motion destination for ${row.scene_id}`);
  const a = row.move_start_sec ?? start, b = row.move_end_sec ?? end;
  if (![a, b].every(Number.isFinite) || a < start || b > end || b <= a) fail(`invalid camera interval for ${row.scene_id}`);
  const keys = [key(start, rect, from)];
  if (a > start) keys.push(key(a, rect, from));
  keys.push(key(b, toRect, to));
  if (b < end) keys.push(key(end, toRect, to, 'hold'));
  return keys;
}

const pageLayouts = ['full_frame', 'inset', 'reveal', 'reaction_pair', 'page_pan', 'page_build'];
const finiteRect = r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) && r.width > 0 && r.height > 0;
const isFull = r => r == null || (r.x === 0 && r.y === 0 && r.width === 1 && r.height === 1);
const zoneOnPage = (page, zone) => ({ x: page.x + zone.x * page.width, y: page.y + zone.y * page.height, width: zone.width * page.width, height: zone.height * page.height });
const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const pageColor = (value, fallback, name) => { if (value == null) return fallback; if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) fail(`${name} must be #rrggbb`); return value; };

/**
 * page_build shows one generated multi-zone page as a comic page being read.
 * Zones are ordinary panels whose source_rect is a region of the same page
 * raster. Undisclosed zones render as empty frames (never artwork); the main
 * zone may enter on its beat; one shared page rectangle carries the camera,
 * and every zone layer follows it through identical key times.
 */
function pageBuildLayers(scene, row, panel, timeline) {
  const start = scene.start_sec, end = scene.end_sec, page = row.page;
  if (!page || !Array.isArray(page.zones)) fail(`page_build requires page.zones: ${scene.id}`);
  if (row.context) fail(`page_build has no context panel: ${scene.id}`);
  if (!isFull(row.source_rect)) fail(`page_build selects zones, not a source crop: ${scene.id}`);
  for (const view of [row.camera_from, row.camera_to].filter(Boolean)) if (view.zoom !== 1 || view.x !== 0.5 || view.y !== 0.5) fail(`page_build moves the page rectangle, not a panel camera: ${scene.id}`);
  const zones = [{ panel_id: row.panel_id, state: 'main' }, ...page.zones];
  // Generation templates use at most four zones; five admits reviewed precedents such as a half page plus a 2x2 grid.
  if (zones.length > 5) fail(`page_build supports at most five zones: ${scene.id}`);
  const ids = new Set(), assets = new Map((timeline.assets ?? []).map(asset => [asset.id, asset]));
  let pageHash = null, pageAsset = null;
  for (const zone of zones) {
    if (ids.has(zone.panel_id)) fail(`duplicate page zone ${zone.panel_id}: ${scene.id}`); ids.add(zone.panel_id);
    if (!['main', 'visible', 'empty'].includes(zone.state) || (zone.state === 'main') !== (zone.panel_id === row.panel_id)) fail(`page zone state must be visible or empty: ${scene.id}`);
    zone.panel = panel(zone.panel_id); zone.rect = zone.panel.source_rect;
    const asset = assets.get(zone.panel.asset_id);
    if (!asset?.sha256) fail(`page zone asset missing: ${zone.panel_id}`);
    if (pageHash && asset.sha256 !== pageHash) fail(`page_build zones must come from one page raster: ${scene.id}`);
    pageHash = asset.sha256; pageAsset = asset;
    if (isFull(zone.rect)) fail(`page zone ${zone.panel_id} is the whole page, not a zone: ${scene.id}`);
  }
  for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) {
    if (overlapArea(zones[i].rect, zones[j].rect) > 1e-6) fail(`page zones overlap: ${zones[i].panel_id}/${zones[j].panel_id}`);
  }
  const rect = row.rect, rectTo = row.rect_to ?? row.rect;
  for (const box of [rect, rectTo]) {
    if (!finiteRect(box) || box.width > 3 || box.height > 3 || box.x < -2 || box.y < -2 || box.x > 1 || box.y > 1) fail(`invalid page rectangle for ${scene.id}`);
    if (pageAsset?.width && pageAsset?.height) {
      const shown = (box.width * timeline.width) / (box.height * timeline.height), native = pageAsset.width / pageAsset.height;
      if (Math.abs(shown - native) / native > 0.02) fail(`page rectangle must keep the page aspect: ${scene.id}`);
    }
  }
  const moving = Boolean(row.rect_to);
  const a = row.move_start_sec ?? start, b = row.move_end_sec ?? end;
  if (moving && (![a, b].every(Number.isFinite) || a < start || b > end || b <= a)) fail(`invalid page move interval for ${scene.id}`);
  const entry = row.entry ?? null;
  let entryEnd = null;
  if (entry) {
    entryEnd = entry.start_sec + entry.duration_sec;
    if (!['left', 'right', 'up', 'down'].includes(entry.direction) || !Number.isFinite(entry.start_sec) || !Number.isFinite(entry.duration_sec)
      || entry.start_sec < start || entry.duration_sec <= 0 || entryEnd >= end) fail(`entry must fit inside ${scene.id}`);
    if (!Number.isFinite(entry.distance) || entry.distance <= 0 || entry.distance > 0.5) fail(`page_build entry needs an explicit distance within 0..0.5: ${scene.id}`);
    if (entry.opacity_from != null && (!Number.isFinite(entry.opacity_from) || entry.opacity_from < 0 || entry.opacity_from > 1)) fail(`invalid entry opacity for ${scene.id}`);
    if (moving && a < entryEnd && b > entry.start_sec) fail(`page move and zone entry must not overlap: ${scene.id}`);
  }
  const pageAt = t => moving && t >= b ? rectTo : rect;
  const follow = (zone, from, to) => {
    const times = [...new Set([from, ...(moving ? [a, b] : []), to])].filter(t => t >= from && t <= to).sort((x, y) => x - y);
    return times.map(t => ({ at_sec: t, rect: zoneOnPage(pageAt(t), zone), camera: { ...camera }, opacity: 1, easing: moving && t === a ? 'smooth' : 'hold' }));
  };
  const paper = pageColor(page.paper_fill, '#f1ede4', 'page.paper_fill');
  const empty = pageColor(page.empty_fill, '#c9c4b8', 'page.empty_fill');
  const layers = [{ id: `${scene.id}__page_sheet`, panel_id: row.panel_id, placeholder: true, placeholder_fill: paper, start_sec: start, end_sec: end, z: 0, fit: 'contain', border_px: 0, keyframes: follow(full, start, end) }];
  let z = 1;
  for (const zone of zones) {
    const base = { panel_id: zone.panel_id, fit: 'cover', border_px: 0, shadow: false };
    if (zone.state === 'visible') { layers.push({ id: `${scene.id}__zone_${z}`, ...base, start_sec: start, end_sec: end, z: z++, keyframes: follow(zone.rect, start, end) }); continue; }
    // Empty frame: the main zone keeps it underneath its entrance.
    layers.push({ id: `${scene.id}__zone_${z}_frame`, ...base, placeholder: true, placeholder_fill: empty, start_sec: start, end_sec: end, z: z++, keyframes: follow(zone.rect, start, end) });
    if (zone.state !== 'main') continue;
    let keys = follow(zone.rect, entry ? entryEnd : start, end);
    if (entry) {
      const settled = zoneOnPage(pageAt(entry.start_sec), zone.rect), from = { ...settled };
      if (entry.direction === 'left') from.x -= entry.distance;
      if (entry.direction === 'right') from.x += entry.distance;
      if (entry.direction === 'up') from.y -= entry.distance;
      if (entry.direction === 'down') from.y += entry.distance;
      keys = [{ at_sec: entry.start_sec, rect: from, camera: { ...camera }, opacity: entry.opacity_from ?? 1, easing: 'smooth' }, ...keys];
    }
    layers.push({ id: `${scene.id}__main`, ...base, start_sec: entry ? entry.start_sec : start, end_sec: end, z: z++, keyframes: keys });
  }
  return { layers, editorial: { page: { raster_sha256: pageHash, zones: zones.map(({ panel_id, state, rect: zoneRect }) => ({ panel_id, state, source_rect: zoneRect })) } } };
}

export function compilePanelComposition(timeline, recipe, { mode = 'editing_experiment' } = {}) {
  if (!['editing_experiment', 'production_panel_composition'].includes(mode)) fail('unsupported compilation mode');
  if (recipe?.schema !== 'goldflow_panel_composition_recipe_v1' || !recipe.author?.trim()) fail('recipe schema and author are required');
  if (!Array.isArray(recipe.decisions) || recipe.decisions.length !== timeline.scenes.length) fail('one explicit decision is required for every scene');
  const decisions = new Map();
  for (const row of recipe.decisions) {
    if (decisions.has(row.scene_id)) fail(`duplicate scene decision ${row.scene_id}`);
    decisions.set(row.scene_id, row);
  }
  const result = structuredClone(timeline);
  result.provenance = { ...result.provenance, label: 'Authored panel composition treatment', composition_role: 'treatment', composition_author: recipe.author, source_order_review: 'editorial_review_required' };
  const panels = new Map(result.panels.map(panel => [panel.id, panel]));
  const panel = id => { if (!panels.has(id)) fail(`unknown panel ${id}`); return panels.get(id); };
  result.scenes = timeline.scenes.map(scene => {
    const row = decisions.get(scene.id);
    if (!row || !pageLayouts.includes(row.layout)) fail(`explicit layout required for ${scene.id}`);
    if (!row.editorial_reason?.trim()) fail(`editorial reason required for ${scene.id}`);
    if (row.layout === 'page_build') {
      panel(row.panel_id); panel(row.background_panel_id);
      const built = pageBuildLayers(scene, row, panel, result);
      return { id: scene.id, start_sec: scene.start_sec, end_sec: scene.end_sec, background: { panel_id: row.background_panel_id, blur_px: row.blur_px ?? 32, brightness: row.background_brightness ?? 0.32 }, layers: built.layers, editorial: { layout: row.layout, reason: row.editorial_reason, author: recipe.author, ...built.editorial } };
    }
    if (row.page) fail(`page is only valid for page_build: ${scene.id}`);
    let source = panel(row.panel_id); panel(row.background_panel_id);
    if (row.source_rect) {
      const c = row.source_rect, base = source.source_rect;
      if (!['x', 'y', 'width', 'height'].every(k => Number.isFinite(c[k])) || c.x < 0 || c.y < 0 || c.width <= 0 || c.height <= 0 || c.x + c.width > 1 || c.y + c.height > 1) fail(`invalid relative source crop ${scene.id}`);
      const derived = `${scene.id}__authored_crop`;
      if (panels.has(derived)) fail(`derived panel id already exists: ${derived}`);
      source = { ...structuredClone(source), id: derived, source_rect: { x: base.x + c.x * base.width, y: base.y + c.y * base.height, width: c.width * base.width, height: c.height * base.height }, metadata: { ...source.metadata, derived_from_panel_id: source.id, crop_author: recipe.author } };
      panels.set(derived, source); result.panels.push(source);
    }
    const rect = row.rect ?? (row.layout === 'full_frame' ? full : inset);
    const start = scene.start_sec, end = scene.end_sec;
    const main = { id: `${scene.id}__main`, panel_id: source.id, start_sec: start, end_sec: end, z: 1, fit: row.fit ?? 'contain', border_px: row.border_px ?? (row.layout === 'full_frame' ? 0 : 4), keyframes: cameraKeys(start, end, rect, row) };
    const layers = [];
    if (row.layout === 'page_pan' && (!row.camera_from || !row.camera_to)) fail(`page_pan requires an explicit camera path: ${scene.id}`);
    if (['reveal', 'reaction_pair'].includes(row.layout)) {
      const entry = row.entry, context = row.context;
      if (!entry || !context || !['left', 'right', 'up', 'down'].includes(entry.direction)) fail(`entry and context required for ${scene.id}`);
      panel(context.panel_id);
      const entryEnd = entry.start_sec + entry.duration_sec;
      if (!Number.isFinite(entry.start_sec) || !Number.isFinite(entry.duration_sec) || entry.start_sec < start || entry.duration_sec <= 0 || entryEnd >= end) fail(`entry must fit inside ${scene.id}`);
      if (!Number.isFinite(context.end_sec) || context.end_sec + 1e-9 < entryEnd || context.end_sec > end || !context.rect) fail(`context must cover the reveal: ${scene.id}`);
      const view = row.camera_from ?? camera;
      const from = { ...rect };
      if (entry.distance != null) {
        if (!Number.isFinite(entry.distance) || entry.distance <= 0 || entry.distance > 2) fail(`invalid entry distance for ${scene.id}`);
        if (entry.direction === 'left') from.x -= entry.distance;
        if (entry.direction === 'right') from.x += entry.distance;
        if (entry.direction === 'up') from.y -= entry.distance;
        if (entry.direction === 'down') from.y += entry.distance;
      } else {
        if (entry.direction === 'left') from.x = -rect.width - 0.03;
        if (entry.direction === 'right') from.x = 1.03;
        if (entry.direction === 'up') from.y = -rect.height - 0.03;
        if (entry.direction === 'down') from.y = 1.03;
      }
      const onset = key(entry.start_sec, from, view);
      if (entry.opacity_from != null) {
        if (!Number.isFinite(entry.opacity_from) || entry.opacity_from < 0 || entry.opacity_from > 1) fail(`invalid entry opacity for ${scene.id}`);
        onset.opacity = entry.opacity_from;
      }
      main.start_sec = entry.start_sec;
      main.keyframes = [onset, ...cameraKeys(entryEnd, end, rect, { ...row, move_start_sec: row.move_start_sec ?? entryEnd })];
      layers.push({ id: `${scene.id}__context`, panel_id: context.panel_id, start_sec: start, end_sec: context.end_sec, z: 0, fit: context.fit ?? 'contain', border_px: context.border_px ?? 4, keyframes: [key(start, context.rect, context.camera ?? camera, 'hold'), key(context.end_sec, context.rect, context.camera ?? camera, 'hold')] });
    } else if (row.entry || row.context) fail(`unused entry/context on ${row.layout}: ${scene.id}`);
    layers.push(main);
    return { id: scene.id, start_sec: start, end_sec: end, background: { panel_id: row.background_panel_id, blur_px: row.blur_px ?? 32, brightness: row.background_brightness ?? 0.32 }, layers, editorial: { layout: row.layout, reason: row.editorial_reason, author: recipe.author } };
  });
  return mode === 'production_panel_composition' ? validatePanelTimeline(result, mode) : validatePanelExperimentTimeline(result);
}

export async function writePanelComposition({ recipePath, outputDir }) {
  const absolute = path.resolve(recipePath), recipe = JSON.parse(await fs.readFile(absolute, 'utf8'));
  const source = recipe.source_timeline;
  if (!source?.path || !source.sha256) fail('source timeline binding required');
  const timelinePath = path.resolve(path.dirname(absolute), source.path);
  if (await sha256File(timelinePath) !== source.sha256) fail('source timeline changed');
  const loaded = await loadPanelExperimentTimeline(timelinePath);
  if (recipe.experiment_identity?.sha256 !== loaded.timeline.experiment_identity.sha256) fail('recipe identity does not match source experiment');
  const timeline = compilePanelComposition(loaded.timeline, recipe);
  timeline.assets = loaded.assets.map(({ data_url, ...row }) => row);
  if (loaded.audio) timeline.audio = loaded.audio;
  timeline.experiment_identity.path = path.resolve(path.dirname(timelinePath), timeline.experiment_identity.path);
  const output = await assertNewOutput(outputDir);
  const receipt = { schema: 'goldflow_panel_composition_report_v1', status: 'passed', id: timeline.id, production_eligible: false, author: recipe.author, source_hashes: { ...loaded.source_hashes, [absolute]: await sha256File(absolute) }, code_sha256: await sha256File(fileURLToPath(import.meta.url)), scene_count: timeline.scenes.length, layouts: Object.fromEntries([...new Set(recipe.decisions.map(r => r.layout))].map(name => [name, recipe.decisions.filter(r => r.layout === name).length])), cost_usd: 0, created_at: new Date().toISOString() };
  for (const [file, hash] of Object.entries(receipt.source_hashes)) if (await sha256File(file) !== hash) fail('source changed during compilation');
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output);
  const resultPath = path.join(output, 'timeline.json'); await fs.writeFile(resultPath, json(timeline), { flag: 'wx' });
  receipt.timeline = { path: resultPath, sha256: await sha256File(resultPath) };
  await fs.writeFile(path.join(output, 'composition_report.json'), json(receipt), { flag: 'wx' });
  return receipt;
}
