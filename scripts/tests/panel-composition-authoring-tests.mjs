import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { compilePanelComposition, createPanelCompositionTemplate, writePanelComposition } from '../lib/panel-composition-authoring.mjs';
import { loadPanelExperimentTimeline } from '../lib/panel-experiment-contract.mjs';
import { panelFrameState, panelImagePlacement } from '../lib/panel-layout-runtime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, value) => { const bytes = `${JSON.stringify(value, null, 2)}\n`; await fs.writeFile(file, bytes); return hash(bytes); };
const full = { x: 0, y: 0, width: 1, height: 1 };
const view = { x: 0.5, y: 0.5, zoom: 1 };
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-composition-tests-'));
let count = 0;
async function test(name, run) { await run(); count++; process.stdout.write(`ok - composition authoring: ${name}\n`); }
const key = (at_sec, camera = view) => ({ at_sec, rect: { ...full }, camera: { ...camera }, opacity: 1, easing: 'hold' });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} differs from ${expected}`);

async function fixture(name) {
  const source = path.join(root, name, 'source'); await fs.mkdir(source, { recursive: true });
  const p = name => path.join(source, name);
  await fs.writeFile(p('approved-script.md'), 'The room falls quiet. A familiar face appears. He looks away.\n');
  const upstreamHash = hash(await fs.readFile(p('approved-script.md')));
  const sourceHash = await write(p('source.json'), { schema: 'goldflow_original_panel_source_packet_v1', source_hashes: { [p('approved-script.md')]: upstreamHash } });
  // A tiny real PCM source is sufficient: these tests author a timeline, not an export.
  const sampleRate = 8000, samples = 20 * sampleRate, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  await fs.writeFile(p('narration.wav'), wav);
  const identity = { schema: 'goldflow_panel_experiment_identity_v1', id: `composition-${name}`, channel: 'fixture', series: 'fixture-series', episode: 'ep_01', title: 'Authored composition test', content_profile: 'manhwa_recap_v1', source_mode: 'original_story', visibility: 'private_review', provider_policy: 'local_artifacts_only', scope: { max_duration_sec: 1800, source_start_sec: 5, source_end_sec: 15 }, source: { path: 'source.json', sha256: sourceHash } };
  const identityHash = await write(p('identity.json'), identity);
  const assets = [];
  for (let index = 0; index < 5; index++) {
    const assetPath = p(`image-${index}.png`);
    await sharp({ create: { width: 160, height: index === 4 ? 480 : 90, channels: 3, background: ['#fe0000', '#00fe00', '#0000fe', '#eeee00', '#ee00ee'][index] } }).png().toFile(assetPath);
    assets.push({ id: `art${index}`, path: `image-${index}.png`, sha256: hash(await fs.readFile(assetPath)), origin: 'test_fixture', provenance: 'Locally generated deterministic test raster.' });
  }
  const panels = assets.map((asset, index) => ({ id: `p${index}`, asset_id: asset.id, source_rect: index === 1 ? { x: 0.1, y: 0.2, width: 0.8, height: 0.6 } : { ...full }, metadata: { narration_excerpt: `Exact approved beat ${index}.`, source_beat_id: `s${index}` } }));
  const scenes = panels.map((panel, index) => ({ id: `s${index}`, start_sec: index * 2, end_sec: index * 2 + 2, background: { panel_id: panel.id, blur_px: 0, brightness: 0 }, layers: [{ id: `control${index}`, panel_id: panel.id, start_sec: index * 2, end_sec: index * 2 + 2, z: 0, fit: 'contain', border_px: 0, keyframes: [key(index * 2), key(index * 2 + 2)] }] }));
  const timeline = { schema: 'goldflow_panel_experiment_timeline_v1', id: identity.id, intent: 'editing_experiment', content_profile: 'manhwa_recap_v1', experiment_identity: { path: 'identity.json', sha256: identityHash }, width: 320, height: 180, fps: 30, duration_sec: 10, audio_target: 'narrator_only', audio: { path: 'narration.wav', sha256: hash(wav), offset_sec: 5 }, assets, panels, scenes, provenance: { composition_role: 'control', label: 'Static full-source control edit; no authored panel treatments added' } };
  const timelinePath = p('baseline.json'); const timelineHash = await write(timelinePath, timeline);
  const decisions = scenes.map((scene, index) => ({ scene_id: scene.id, layout: ['full_frame', 'inset', 'reveal', 'reaction_pair', 'page_pan'][index], panel_id: `p${index}`, background_panel_id: `p${Math.max(0, index - 1)}`, editorial_reason: ['Hold the whole establishing image while the place is named.', 'Isolate the selected detail for the stated observation.', 'Let the prior face hold until the narrated reveal.', 'Keep the previous speaker visible through the reaction.', 'Read down the continuous page only after the opening hold.'][index], fit: 'contain', camera_from: { ...view }, camera_to: { ...view } }));
  decisions[1].source_rect = { x: 0.25, y: 0.5, width: 0.5, height: 0.5 };
  decisions[1].rect = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };
  decisions[2].entry = { direction: 'right', start_sec: 4.4, duration_sec: 0.4 };
  decisions[2].context = { panel_id: 'p1', rect: { x: 0.04, y: 0.05, width: 0.5, height: 0.9 }, fit: 'contain', end_sec: 5.3 };
  decisions[3].entry = { direction: 'up', start_sec: 6.2, duration_sec: 0.3 };
  decisions[3].rect = { x: 0.56, y: 0.1, width: 0.4, height: 0.8 };
  decisions[3].context = { panel_id: 'p2', rect: { x: 0.04, y: 0.1, width: 0.48, height: 0.8 }, fit: 'contain', end_sec: 7.2 };
  Object.assign(decisions[4], { fit: 'cover', rect: { ...full }, camera_from: { x: 0.5, y: 0, zoom: 1 }, camera_to: { x: 0.5, y: 1, zoom: 1 }, move_start_sec: 8.5, move_end_sec: 9.5 });
  const recipe = { schema: 'goldflow_panel_composition_recipe_v1', author: 'Fixture editor', source_timeline: { path: timelinePath, sha256: timelineHash }, experiment_identity: timeline.experiment_identity, decisions };
  const recipePath = path.join(root, name, 'recipe.json'); await write(recipePath, recipe);
  return { source, p, timeline, timelinePath, recipe, recipePath, outputDir: path.join(root, name, 'candidate') };
}

async function snapshot(directory) { return Object.fromEntries(await Promise.all((await fs.readdir(directory)).sort().map(async name => [name, hash(await fs.readFile(path.join(directory, name)))]))); }
async function rejectWrite(f, pattern) { await assert.rejects(writePanelComposition(f), pattern); await assert.rejects(fs.access(f.outputDir), { code: 'ENOENT' }); }

try {
  await test('template makes every editorial decision explicit and preserves original source excerpts', async () => {
    const f = await fixture('template'); const before = await snapshot(f.source);
    const result = await createPanelCompositionTemplate({ timelinePath: f.timelinePath, outputDir: f.outputDir });
    assert.equal(result.status, 'needs_authoring'); assert.equal(result.decision_count, 5);
    const recipe = await read(result.recipe_path), packet = await read(result.packet_path);
    assert.equal(recipe.author, null); assert.ok(recipe.decisions.every(row => row.layout === null && row.editorial_reason === null));
    assert.throws(() => compilePanelComposition(f.timeline, recipe), /author/);
    assert.deepEqual(packet.scenes.map(row => row.narration), f.timeline.panels.map(panel => panel.metadata.narration_excerpt));
    assert.deepEqual(packet.scenes.map(row => [row.id, row.start_sec, row.end_sec]), f.timeline.scenes.map(row => [row.id, row.start_sec, row.end_sec]));
    assert.deepEqual(await snapshot(f.source), before);
    await assert.rejects(createPanelCompositionTemplate({ timelinePath: f.timelinePath, outputDir: f.outputDir }), /output exists/);
  });
  await test('compilation preserves exact scene order, narration, scope and both inputs', async () => {
    const f = await fixture('preservation'), source = structuredClone(f.timeline), recipe = structuredClone(f.recipe);
    // Recipe timing is not an authority: the baseline owns these bounds.
    f.recipe.decisions[0].start_sec = 100; f.recipe.decisions[0].end_sec = 101;
    const recipeBefore = structuredClone(f.recipe), result = compilePanelComposition(f.timeline, f.recipe);
    assert.deepEqual(f.timeline, source); assert.deepEqual(f.recipe, recipeBefore);
    for (const field of ['id', 'duration_sec', 'width', 'height', 'fps', 'audio', 'audio_target', 'experiment_identity', 'assets']) assert.deepEqual(result[field], source[field], field);
    assert.deepEqual(result.scenes.map(s => [s.id, s.start_sec, s.end_sec]), source.scenes.map(s => [s.id, s.start_sec, s.end_sec]));
    assert.deepEqual(result.scenes.map(s => s.editorial.layout), recipe.decisions.map(d => d.layout));
    assert.deepEqual(result.scenes.map(s => s.editorial.reason), recipe.decisions.map(d => d.editorial_reason));
    assert.ok(result.scenes.every(s => s.editorial.author === recipe.author));
    assert.deepEqual(result.panels.slice(0, source.panels.length), source.panels);
    assert.equal(result.provenance.composition_role, 'treatment');
    assert.notEqual(result.provenance.label, source.provenance.label);
  });
  await test('relative crop uses the indexed panel geometry and leaves the full source intact', async () => {
    const f = await fixture('crop'), result = compilePanelComposition(f.timeline, f.recipe);
    const derived = result.panels.find(p => p.id === result.scenes[1].layers[0].panel_id);
    for (const [field, value] of Object.entries({ x: 0.3, y: 0.5, width: 0.4, height: 0.3 })) near(derived.source_rect[field], value);
    assert.equal(derived.asset_id, 'art1'); assert.equal(derived.metadata.derived_from_panel_id, 'p1'); assert.equal(derived.metadata.crop_author, f.recipe.author);
    assert.deepEqual(result.panels.find(p => p.id === 'p1').source_rect, f.timeline.panels[1].source_rect);
    assert.deepEqual(result.scenes[1].layers[0].keyframes[0].rect, f.recipe.decisions[1].rect);
  });
  await test('reveal and reaction use authored onset and overlap without revealing a layer early', async () => {
    const f = await fixture('reveal'), result = compilePanelComposition(f.timeline, f.recipe);
    for (const index of [2, 3]) {
      const decision = f.recipe.decisions[index], scene = result.scenes[index], entryEnd = decision.entry.start_sec + decision.entry.duration_sec;
      assert.deepEqual(panelFrameState(result, decision.entry.start_sec - 0.0001).layers.map(l => l.id), [`s${index}__context`]);
      const onset = panelFrameState(result, decision.entry.start_sec); assert.equal(onset.layers.length, 2);
      const incoming = onset.layers.at(-1); assert.equal(incoming.panel_id, `p${index}`);
      if (decision.entry.direction === 'right') assert.ok(incoming.state.rect.x > 1);
      if (decision.entry.direction === 'up') assert.ok(incoming.state.rect.y + incoming.state.rect.height < 0);
      const settled = panelFrameState(result, entryEnd); assert.equal(settled.layers.length, 2);
      assert.deepEqual(settled.layers.at(-1).state.rect, scene.layers.at(-1).keyframes.at(-1).rect);
      assert.equal(panelFrameState(result, decision.context.end_sec - 0.0001).layers.length, 2);
      assert.deepEqual(panelFrameState(result, decision.context.end_sec).layers.map(l => l.id), [`s${index}__main`]);
    }
    assert.equal(panelFrameState(result, 4).scene.id, 's2'); assert.equal(panelFrameState(result, 6).scene.id, 's3'); assert.equal(panelFrameState(result, 10).scene, null);
  });
  await test('page movement honors reading holds and moves through actual tall-source overflow', async () => {
    const f = await fixture('page'), result = compilePanelComposition(f.timeline, f.recipe);
    const state = at => panelFrameState(result, at).layers[0].state;
    assert.equal(state(8.25).camera.y, 0); assert.equal(state(8.5).camera.y, 0);
    near(state(9).camera.y, 0.5); assert.equal(state(9.5).camera.y, 1); assert.equal(state(9.9).camera.y, 1);
    const viewport = { x: 0, y: 0, width: 320, height: 180 };
    const top = panelImagePlacement(160, 480, viewport, state(8.25).camera, 'cover');
    const bottom = panelImagePlacement(160, 480, viewport, state(9.9).camera, 'cover');
    assert.equal(top.y, 0); assert.equal(bottom.y + bottom.height, viewport.height); assert.ok(bottom.y < top.y);
    const held = result.scenes[0].layers[0]; assert.deepEqual(held.keyframes[0].camera, held.keyframes[1].camera);
  });
  await test('incomplete and contradictory editorial recipes fail without mutating source', async () => {
    const f = await fixture('invalid'); const original = structuredClone(f.timeline);
    const invalid = [
      [r => { r.author = ' '; }, /author/],
      [r => r.decisions.pop(), /every scene/],
      [r => { r.decisions[1].scene_id = 's0'; }, /duplicate/],
      [r => { r.decisions[0].layout = 'automatic'; }, /explicit layout/],
      [r => { r.decisions[0].editorial_reason = ''; }, /editorial reason/],
      [r => { r.decisions[0].panel_id = 'missing'; }, /unknown panel/],
      [r => { r.decisions[0].background_panel_id = 'missing'; }, /unknown panel/],
      [r => { r.decisions[1].source_rect.width = 0.9; }, /relative source crop/],
      [r => { r.decisions[1].source_rect.x = NaN; }, /relative source crop/],
      [r => { r.decisions[1].rect.width = 0; }, /rect.width/],
      [r => { r.decisions[4].camera_to = null; }, /explicit camera path/],
      [r => { r.decisions[4].move_end_sec = 8.4; }, /camera interval/],
      [r => { r.decisions[4].camera_to.zoom = 5; }, /camera.zoom/],
      [r => { r.decisions[2].entry.direction = 'diagonal'; }, /entry and context/],
      [r => { r.decisions[2].entry.start_sec = 3.9; }, /entry must fit/],
      [r => { r.decisions[2].entry.duration_sec = 1.6; }, /entry must fit/],
      [r => { r.decisions[2].context.end_sec = 4.5; }, /context must cover/],
      [r => { r.decisions[2].context.panel_id = 'missing'; }, /unknown panel/],
      [r => { r.decisions[0].entry = { direction: 'up' }; }, /unused entry/],
    ];
    for (const [mutate, pattern] of invalid) { const recipe = structuredClone(f.recipe); mutate(recipe); assert.throws(() => compilePanelComposition(f.timeline, recipe), pattern); assert.deepEqual(f.timeline, original); }
  });
  await test('write emits a portable hash-bound candidate and cannot overwrite retained outputs', async () => {
    const f = await fixture('write'), before = await snapshot(f.source), recipeBefore = await fs.readFile(f.recipePath);
    const receipt = await writePanelComposition(f), loaded = await loadPanelExperimentTimeline(receipt.timeline.path);
    assert.equal(receipt.status, 'passed'); assert.equal(receipt.production_eligible, false); assert.equal(receipt.cost_usd, 0); assert.equal(receipt.scene_count, 5);
    assert.deepEqual(receipt.layouts, { full_frame: 1, inset: 1, reveal: 1, reaction_pair: 1, page_pan: 1 });
    assert.equal(receipt.timeline.sha256, hash(await fs.readFile(receipt.timeline.path)));
    assert.ok(loaded.assets.every(a => path.isAbsolute(a.path))); assert.ok(path.isAbsolute(loaded.audio.path)); assert.equal(loaded.audio.offset_sec, 5);
    assert.equal(receipt.source_hashes[f.recipePath], hash(recipeBefore)); assert.equal(receipt.source_hashes[await fs.realpath(f.p('approved-script.md'))], before['approved-script.md']);
    assert.deepEqual(await snapshot(f.source), before); assert.deepEqual(await fs.readFile(f.recipePath), recipeBefore);
    const candidateBefore = await snapshot(f.outputDir); await assert.rejects(writePanelComposition(f), /output exists/); assert.deepEqual(await snapshot(f.outputDir), candidateBefore);
  });
  await test('stale timeline, identity and upstream approval source fail before output creation', async () => {
    const timeline = await fixture('stale-timeline'); await fs.appendFile(timeline.timelinePath, '\n'); await rejectWrite(timeline, /source timeline changed/);
    const identity = await fixture('stale-identity'); identity.recipe.experiment_identity.sha256 = 'a'.repeat(64); await write(identity.recipePath, identity.recipe); await rejectWrite(identity, /identity does not match/);
    const upstream = await fixture('stale-upstream'); await fs.appendFile(upstream.p('approved-script.md'), 'Edited after import.'); await rejectWrite(upstream, /original source dependency.*stale/);
    const image = await fixture('stale-image'); await fs.appendFile(image.p('image-0.png'), 'changed'); await rejectWrite(image, /asset art0.*stale/);
  });
  await test('episode destinations and symlinked episode destinations stay immutable', async () => {
    const f = await fixture('episode-output'); await write(f.p('run_identity.json'), { schema: 'fixture' });
    await rejectWrite({ ...f, outputDir: path.join(f.source, 'candidate') }, /existing episode/);
    const link = path.join(root, 'source-link'); await fs.symlink(f.source, link);
    await rejectWrite({ ...f, outputDir: path.join(link, 'candidate') }, /existing episode/);
    await rejectWrite({ ...f, outputDir: path.join(root, 'episodes', 'new') }, /episode folders/);
  });
} finally { await fs.rm(root, { recursive: true, force: true }); }
process.stdout.write(`Panel composition authoring: ${count} test groups passed.\n`);
