import assert from 'node:assert/strict';
import { compilePanelComposition } from '../lib/panel-composition-authoring.mjs';
import { validateEditorialBindings } from '../lib/panel-production-plan.mjs';
import { validatePanelTimeline } from '../lib/panel-layout-validation.mjs';
import { panelFrameState } from '../lib/panel-layout-runtime.mjs';

let count = 0;
function test(name, run) { run(); count++; process.stdout.write(`ok - page build: ${name}\n`); }
const full = { x: 0, y: 0, width: 1, height: 1 };
const view = { x: 0.5, y: 0.5, zoom: 1 };
const pageSha = 'a'.repeat(64), otherSha = 'b'.repeat(64);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} differs from ${expected}`);
// P3L page: left half plus two stacked right zones, separated by gutters.
const zones = [{ x: 0, y: 0, width: 0.495, height: 1 }, { x: 0.505, y: 0, width: 0.495, height: 0.49 }, { x: 0.505, y: 0.51, width: 0.495, height: 0.49 }];
const pageRect = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };

function fixture() {
  const key = at_sec => ({ at_sec, rect: { ...full }, camera: { ...view }, opacity: 1, easing: 'hold' });
  // Each beat has its own materialized alias of the same page bytes, as panel finalization produces.
  const assets = [0, 1, 2, 3].map(i => ({ id: `art${i}`, path: `page-${i}.png`, sha256: i === 3 ? otherSha : pageSha, width: 1920, height: 1080, origin: 'test_fixture', provenance: 'Synthetic page alias.' }));
  const panels = [0, 1, 2].map(i => ({ id: `p${i}`, asset_id: `art${i}`, source_rect: { ...zones[i] }, metadata: { narration_excerpt: `Beat ${i}.` } }));
  panels.push({ id: 'p3', asset_id: 'art3', source_rect: { ...zones[2] }, metadata: {} });
  const scenes = [0, 1, 2].map(i => ({ id: `s${i}`, start_sec: i * 2, end_sec: i * 2 + 2, background: { panel_id: `p${i}`, blur_px: 0, brightness: 0 }, layers: [{ id: `control${i}`, panel_id: `p${i}`, start_sec: i * 2, end_sec: i * 2 + 2, z: 0, fit: 'contain', border_px: 0, keyframes: [key(i * 2), key(i * 2 + 2)] }] }));
  const timeline = { schema: 'goldflow_panel_experiment_timeline_v1', id: 'page-build', intent: 'editing_experiment', content_profile: 'manhwa_recap_v1', experiment_identity: { path: 'identity.json', sha256: 'c'.repeat(64) }, width: 1920, height: 1080, fps: 30, duration_sec: 6, audio_target: 'silent_fixture', audio: null, assets, panels, scenes, provenance: {} };
  const decision = (i, page, extra = {}) => ({ scene_id: `s${i}`, layout: 'page_build', panel_id: `p${i}`, background_panel_id: 'p0', editorial_reason: 'Read the page panel by panel as the narration moves through it.', source_rect: { ...full }, rect: { ...pageRect }, fit: 'cover', camera_from: { ...view }, camera_to: { ...view }, entry: null, context: null, page, ...extra });
  const recipe = { schema: 'goldflow_panel_composition_recipe_v1', author: 'Fixture editor', decisions: [
    decision(0, { zones: [{ panel_id: 'p1', state: 'empty' }, { panel_id: 'p2', state: 'empty' }] }),
    decision(1, { zones: [{ panel_id: 'p0', state: 'visible' }, { panel_id: 'p2', state: 'empty' }] }, { entry: { direction: 'up', start_sec: 2.2, duration_sec: 0.4, distance: 0.05, opacity_from: 0 } }),
    decision(2, { zones: [{ panel_id: 'p0', state: 'visible' }, { panel_id: 'p1', state: 'visible' }] }, { rect_to: { x: -0.4, y: -0.6, width: 1.8, height: 1.8 }, move_start_sec: 4.5, move_end_sec: 5.5 }),
  ] };
  return { timeline, recipe };
}
const mutate = (f, index, change) => { const recipe = structuredClone(f.recipe); change(recipe.decisions[index]); return recipe; };
const onPage = (page, zone) => ({ x: page.x + zone.x * page.width, y: page.y + zone.y * page.height, width: zone.width * page.width, height: zone.height * page.height });
const nearRect = (actual, expected) => { for (const k of ['x', 'y', 'width', 'height']) near(actual[k], expected[k]); };

test('compiles a page sheet, disclosed zones and empty frames for later zones', () => {
  const f = fixture(), result = compilePanelComposition(f.timeline, f.recipe);
  const s1 = result.scenes[1];
  assert.equal(s1.layers[0].placeholder, true);
  assert.equal(s1.layers[0].id, 's1__page_sheet');
  const byPanel = s1.layers.filter(layer => !layer.placeholder).map(layer => layer.panel_id).sort();
  assert.deepEqual(byPanel, ['p0', 'p1'], 'only disclosed zones and the current zone draw artwork');
  const frame = s1.layers.find(layer => layer.panel_id === 'p2');
  assert.equal(frame.placeholder, true, 'a later zone is an empty frame, never artwork');
  assert.equal(result.scenes[0].layers.filter(layer => !layer.placeholder).length, 1);
  nearRect(s1.layers.find(layer => layer.panel_id === 'p0' && !layer.placeholder).keyframes[0].rect, onPage(pageRect, zones[0]));
  assert.equal(s1.editorial.page.raster_sha256, pageSha);
  validatePanelTimeline(result, 'editing_experiment');
});

test('the current zone enters on its beat over its own empty frame', () => {
  const f = fixture(), result = compilePanelComposition(f.timeline, f.recipe);
  const before = panelFrameState(result, 2.1).layers;
  assert.ok(before.every(layer => layer.panel_id !== 'p1' || layer.placeholder), 'before the entry only the frame is drawn');
  assert.ok(before.some(layer => layer.id === 's1__zone_1_frame'));
  const onset = panelFrameState(result, 2.2).layers.find(layer => layer.id === 's1__main').state;
  near(onset.opacity, 0);
  near(onset.rect.y, onPage(pageRect, zones[1]).y - 0.05);
  const settled = panelFrameState(result, 2.7).layers.find(layer => layer.id === 's1__main').state;
  near(settled.opacity, 1);
  nearRect(settled.rect, onPage(pageRect, zones[1]));
});

test('a page push-in moves every zone with one shared page rectangle', () => {
  const f = fixture(), result = compilePanelComposition(f.timeline, f.recipe);
  const to = f.recipe.decisions[2].rect_to;
  for (const t of [4.2, 5.0, 5.9]) {
    const frame = panelFrameState(result, t), sheet = frame.layers.find(layer => layer.id === 's2__page_sheet').state.rect;
    for (const [panelId, zone] of [['p0', zones[0]], ['p1', zones[1]], ['p2', zones[2]]]) {
      const layer = frame.layers.find(row => row.panel_id === panelId && !row.placeholder);
      nearRect(layer.state.rect, onPage(sheet, zone));
    }
  }
  nearRect(panelFrameState(result, 5.9).layers[0].state.rect, to);
});

test('rejects zones from another raster, overlapping zones and whole pages', () => {
  const f = fixture();
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 2, d => { d.page.zones[1].panel_id = 'p3'; })), /one page raster/);
  const overlap = structuredClone(f.timeline); overlap.panels[1].source_rect = { x: 0.4, y: 0, width: 0.5, height: 0.49 };
  assert.throws(() => compilePanelComposition(overlap, f.recipe), /zones overlap/);
  const whole = structuredClone(f.timeline); whole.panels[0].source_rect = { ...full };
  assert.throws(() => compilePanelComposition(whole, f.recipe), /whole page/);
});

test('rejects distorted pages, crops, cameras, contexts and oversized pages', () => {
  const f = fixture();
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 0, d => { d.rect = { x: 0, y: 0, width: 1, height: 0.5 }; })), /page aspect/);
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 0, d => { d.source_rect = { x: 0, y: 0, width: 0.5, height: 1 }; })), /not a source crop/);
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 0, d => { d.camera_to = { x: 0.5, y: 0.5, zoom: 2 }; })), /page rectangle/);
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 0, d => { d.context = { panel_id: 'p0' }; })), /no context/);
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 0, d => { d.rect = { x: 0, y: 0, width: 3.2, height: 3.2 }; })), /invalid page rectangle/);
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 0, d => { d.page.paper_fill = 'white'; })), /paper_fill/);
});

test('rejects invalid zone lists and states', () => {
  const f = fixture();
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 0, d => { d.page.zones.push({ panel_id: 'p0', state: 'visible' }); })), /duplicate page zone/);
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 0, d => { d.page.zones[0].state = 'main'; })), /visible or empty/);
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 0, d => { d.page.zones = [1, 2, 3, 4, 5].map(i => ({ panel_id: `x${i}`, state: 'empty' })); })), /at most five/);
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 0, d => { delete d.page; })), /page.zones/);
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 0, d => { d.layout = 'inset'; })), /only valid for page_build/);
});

test('rejects entries without explicit in-page distance and overlapping page moves', () => {
  const f = fixture();
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 1, d => { delete d.entry.distance; })), /explicit distance/);
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 1, d => { d.entry.duration_sec = 2; })), /entry must fit/);
  assert.throws(() => compilePanelComposition(f.timeline, mutate(f, 1, d => { d.rect_to = { x: 0, y: 0, width: 1, height: 1 }; d.move_start_sec = 2.3; d.move_end_sec = 3; })), /must not overlap/);
});

test('editorial binding refuses a later zone shown as artwork before its beat', () => {
  const f = fixture();
  const baseline = { scenes: f.timeline.scenes };
  validateEditorialBindings(baseline, f.recipe);
  assert.throws(() => validateEditorialBindings(baseline, mutate(f, 1, d => { d.page.zones[1].state = 'visible'; })), /future page zone p2/);
  assert.throws(() => validateEditorialBindings(baseline, mutate(f, 1, d => { d.page.zones[1].panel_id = 'nope'; })), /unknown page zone/);
});

test('timeline validation keeps placeholders explicit and shadows opt-out only', () => {
  const f = fixture(), result = compilePanelComposition(f.timeline, f.recipe);
  const bad = (change, pattern) => { const t = structuredClone(result); change(t.scenes[1].layers); assert.throws(() => validatePanelTimeline(t, 'editing_experiment'), pattern); };
  bad(layers => { layers[0].placeholder = false; }, /placeholder must be true/);
  bad(layers => { delete layers[0].placeholder; }, /placeholder_fill/);
  bad(layers => { layers[0].placeholder_fill = 'red'; }, /placeholder_fill/);
  bad(layers => { layers[1].shadow = true; }, /shadow may only be disabled/);
});

process.stdout.write(`Panel page build: ${count} test groups passed.\n`);
