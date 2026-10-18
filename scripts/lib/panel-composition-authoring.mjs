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
      if (entry.direction === 'left') from.x = -rect.width - 0.03;
      if (entry.direction === 'right') from.x = 1.03;
      if (entry.direction === 'up') from.y = -rect.height - 0.03;
      if (entry.direction === 'down') from.y = 1.03;
      main.start_sec = entry.start_sec;
      main.keyframes = [key(entry.start_sec, from, view), ...cameraKeys(entryEnd, end, rect, { ...row, move_start_sec: row.move_start_sec ?? entryEnd })];
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
