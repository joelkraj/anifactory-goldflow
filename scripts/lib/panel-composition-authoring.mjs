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

// Several shots per beat: at most two cuts (three shots), each shot readable.
export const MAX_BEAT_CUTS = 2, MIN_SHOT_SEC = 1.2;
// Impact beats: a short decaying screen shake on a held main panel, and a
// burst window after it in which cuts may be as short as MIN_BURST_SHOT_SEC.
export const IMPACT_LIMITS = Object.freeze({ min_duration_sec: 0.15, max_duration_sec: 0.6, min_amplitude: 0.004, max_amplitude: 0.03, default_amplitude: 0.012 });
export const BURST_WINDOW_SEC = 1.5, MIN_BURST_SHOT_SEC = 0.35;
const SHAKE_STEP_SEC = 1 / 24, SHAKE_PATTERN = [[1, -0.6], [-0.8, 0.7], [0.6, 1], [-1, -0.5]];

function impactKeys(layer, impact, sceneId) {
  const at = impact?.at_sec, duration = impact?.duration_sec, amplitude = impact?.amplitude ?? IMPACT_LIMITS.default_amplitude;
  if (![at, duration, amplitude].every(Number.isFinite) || duration < IMPACT_LIMITS.min_duration_sec || duration > IMPACT_LIMITS.max_duration_sec
    || amplitude < IMPACT_LIMITS.min_amplitude || amplitude > IMPACT_LIMITS.max_amplitude) fail(`invalid impact for ${sceneId}`);
  const end = at + duration, keys = layer.keyframes;
  if (at < layer.start_sec || end > layer.end_sec) fail(`impact must fall inside the main shot: ${sceneId}`);
  // Shake only a held stretch so inserted keys cannot distort an eased move.
  const before = keys.filter(k => k.at_sec <= at).at(-1), after = keys.find(k => k.at_sec >= end);
  const same = (a, b) => JSON.stringify([a.rect, a.camera]) === JSON.stringify([b.rect, b.camera]);
  if (!before || !after || !keys.filter(k => k.at_sec >= before.at_sec && k.at_sec <= after.at_sec).every(k => same(k, before))) fail(`impact needs a held panel (no camera or rect move during it): ${sceneId}`);
  const steps = Math.max(2, Math.round(duration / SHAKE_STEP_SEC)), shake = [];
  for (let i = 0; i <= steps; i++) {
    const t = at + duration * i / steps, decay = 1 - i / steps, [dx, dy] = i === 0 || i === steps ? [0, 0] : SHAKE_PATTERN[(i - 1) % SHAKE_PATTERN.length];
    shake.push({ ...key(t, { ...before.rect, x: before.rect.x + dx * amplitude * decay, y: before.rect.y + dy * amplitude * decay }, before.camera, i < steps ? 'linear' : Math.abs(after.at_sec - end) < 1e-9 ? after.easing : before.easing), opacity: before.opacity });
  }
  const merged = [...keys.filter(k => k.at_sec < at - 1e-9), ...shake, ...keys.filter(k => k.at_sec > end + 1e-9)];
  if (merged.length > 32) fail(`impact adds too many keys: ${sceneId}`);
  return merged;
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
    if (!row || !['full_frame', 'inset', 'reveal', 'reaction_pair', 'page_pan'].includes(row.layout)) fail(`explicit layout required for ${scene.id}`);
    if (!row.editorial_reason?.trim()) fail(`editorial reason required for ${scene.id}`);
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
    if (row.cuts != null) {
      // Authored hard cuts to other crops of the SAME main artwork within one
      // long beat: shot 1 is the decision itself, each cut starts a new shot.
      if (!['inset', 'full_frame', 'page_pan'].includes(row.layout)) fail(`cuts are only supported on inset, full_frame or page_pan: ${scene.id}`);
      if (!Array.isArray(row.cuts) || row.cuts.length < 1 || row.cuts.length > MAX_BEAT_CUTS) fail(`1..${MAX_BEAT_CUTS} cuts allowed: ${scene.id}`);
      if (row.rect_to || row.move_start_sec != null || row.move_end_sec != null) fail(`cuts replace rect_to and move times: ${scene.id}`);
      const original = panel(row.panel_id), bounds = [start, ...row.cuts.map(cut => cut.start_sec), end];
      // A shot overlapping an authored impact's burst window may be short;
      // every other shot, and always the final one, must stay readable.
      const burst = (from, to) => row.impact && to > row.impact.at_sec && from < row.impact.at_sec + BURST_WINDOW_SEC;
      for (let i = 1; i < bounds.length; i++) {
        const minimum = i < bounds.length - 1 && burst(bounds[i - 1], bounds[i]) ? MIN_BURST_SHOT_SEC : MIN_SHOT_SEC;
        if (!Number.isFinite(bounds[i]) || bounds[i] - bounds[i - 1] < minimum - 1e-9) fail(`every shot must last at least ${MIN_SHOT_SEC}s (${MIN_BURST_SHOT_SEC}s inside an impact burst, never the last): ${scene.id}`);
      }
      main.end_sec = bounds[1]; main.keyframes = cameraKeys(start, bounds[1], rect, row);
      row.cuts.forEach((cut, i) => {
        const c = cut.source_rect, base = original.source_rect;
        if (!c || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(c[k])) || c.x < 0 || c.y < 0 || c.width <= 0 || c.height <= 0 || c.x + c.width > 1 || c.y + c.height > 1) fail(`invalid cut crop ${scene.id}`);
        const id = `${scene.id}__cut_${i + 1}`;
        if (panels.has(id)) fail(`derived panel id already exists: ${id}`);
        const derived = { ...structuredClone(original), id, source_rect: { x: base.x + c.x * base.width, y: base.y + c.y * base.height, width: c.width * base.width, height: c.height * base.height }, metadata: { ...original.metadata, derived_from_panel_id: original.id, crop_author: recipe.author } };
        panels.set(id, derived); result.panels.push(derived);
        const cutRect = cut.rect ?? rect;
        layers.push({ id, panel_id: id, start_sec: bounds[i + 1], end_sec: bounds[i + 2], z: 2 + i, fit: cut.fit ?? main.fit, border_px: main.border_px, keyframes: cameraKeys(bounds[i + 1], bounds[i + 2], cutRect, { scene_id: scene.id, camera_from: cut.camera_from, camera_to: cut.camera_to }) });
      });
    }
    if (row.impact != null) {
      if (!['inset', 'full_frame', 'page_pan'].includes(row.layout)) fail(`impact is only supported on inset, full_frame or page_pan: ${scene.id}`);
      main.keyframes = impactKeys(main, row.impact, scene.id);
    }
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
