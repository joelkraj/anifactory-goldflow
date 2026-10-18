import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runCodexCli, readCodexCallMetadata } from './codex-cli-runner.mjs';
import { sha256File } from './file-hash.mjs';
import { readPanelProductionInputs, validateEditorialBindings } from './panel-production-plan.mjs';
import { compilePanelComposition } from './panel-composition-authoring.mjs';

const need = (value, message) => { if (!value) throw new Error(`Panel author: ${message}`); };
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.stat(file).then(() => true, () => false);
const full = { x: 0, y: 0, width: 1, height: 1 };
const layouts = new Set(['full_frame', 'inset', 'reveal', 'reaction_pair', 'page_pan']);

// These are bounded request envelopes, not editing decisions. Actual parent
// scenes, beat order and shared rasters remain intact; no timer chooses layouts.
export function panelAuthorChunks(packet, { maxImages = 8, maxBeats = 24 } = {}) {
  need(Number.isInteger(maxImages) && maxImages > 0 && Number.isInteger(maxBeats) && maxBeats > 0, 'invalid request bounds');
  const beats = new Map(packet.beats.map(row => [row.visual_beat_id, row]));
  const panels = new Map(packet.baseline.panels.map(row => [row.id, row]));
  const assets = new Map(packet.baseline.assets.map(row => [row.id, row]));
  const chunks = []; let current;
  for (const scene of packet.baseline.scenes) {
    const beat = beats.get(scene.id), panel = panels.get(scene.layers[0].panel_id);
    need(beat && panel && assets.has(panel.asset_id), `missing explicit beat artwork ${scene.id}`);
    const asset = assets.get(panel.asset_id), parent = beat.parent_scene_id ?? beat.scene_id ?? beat.visual_beat_id;
    if (!current || current.parent !== parent || current.scenes.length >= maxBeats
      || !current.hashes.has(asset.sha256) && current.hashes.size >= maxImages) {
      current = { id: `chunk_${String(chunks.length + 1).padStart(3, '0')}`, parent, scenes: [], hashes: new Set() };
      chunks.push(current);
    }
    current.scenes.push(scene); current.hashes.add(asset.sha256);
  }
  return chunks.map(({ hashes, ...chunk }) => chunk);
}

export function validatePanelAuthorResponse(response, chunk, baseline) {
  need(Array.isArray(response?.decisions) && response.decisions.length === chunk.scenes.length, `exact decision coverage required for ${chunk.id}`);
  const expected = new Map(chunk.scenes.map(scene => [scene.id, scene])); const seen = new Set();
  for (const row of response.decisions) {
    const scene = expected.get(row.scene_id);
    need(scene && !seen.has(row.scene_id), `unknown or duplicate decision ${row.scene_id}`); seen.add(row.scene_id);
    need(layouts.has(row.layout) && row.editorial_reason?.trim().length > 20, `authored layout and substantive reason required for ${row.scene_id}`);
    need(row.panel_id === scene.layers[0].panel_id, `substituted main artwork ${row.scene_id}`);
    need(row.rect && row.source_rect && row.camera_from && row.camera_to, `explicit crop, placement and camera required for ${row.scene_id}`);
    for (const box of [row.rect, row.source_rect]) {
      need(['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) && box.x >= 0 && box.y >= 0
        && box.width > 0 && box.height > 0 && box.x + box.width <= 1 && box.y + box.height <= 1,
      `out-of-bounds crop or placement ${row.scene_id}`);
    }
    for (const camera of [row.camera_from, row.camera_to]) need(Number.isFinite(camera.x) && Number.isFinite(camera.y)
      && camera.x >= 0 && camera.x <= 1 && camera.y >= 0 && camera.y <= 1 && camera.zoom >= 1 && camera.zoom <= 4,
    `invalid authored camera ${row.scene_id}`);
    need(row.region_evidence?.trim().length > 20, `actual visible-region evidence required for ${row.scene_id}`);
    need(['contain', 'cover'].includes(row.fit), `explicit fit required for ${row.scene_id}`);
  }
  validateEditorialBindings(baseline, { decisions: response.decisions });
  return response.decisions;
}

export function panelAuthorPrompt(packet, chunk, attachedAssets, contextScene) {
  const ids = new Set(chunk.scenes.map(scene => scene.id));
  const beats = packet.beats.filter(beat => ids.has(beat.visual_beat_id));
  const wordStart = Math.min(...beats.map(beat => beat.source_word_start_index));
  const wordEnd = Math.max(...beats.map(beat => beat.source_word_end_index));
  return `You are the image-aware editor of a narrated original manhwa video. Inspect EVERY attached actual accepted raster. Return JSON only: {"decisions":[...]}. Do not use shell, browser or network tools or modify files; all needed source text, times and actual rasters are supplied here.
Author all supplied beats explicitly from their narration and artwork. No fixed transition timer, repeating layout cycle, quota or random zoom. A beat does not require a new image. Shared images should reveal different useful regions when the story calls for it. Use a quiet hold for reading/dialogue and clear wide framing where an action's geography needs it. Use crops, panel entries, reaction overlaps and restrained camera paths when motivated. Do not make an automated full-frame slideshow.
Source/caption/spoken text, beat IDs, start/end times and main-panel identity are immutable. All artwork is already accepted; this task generates NO images or story changes. Read image_review_decisions: cropping and disclosure conditions are real requirements. Do not show later information early, including within a shared raster, a thought bubble, UI, context or blurred background. Use an earlier safe background if current art would reveal a later event. Keep faces, hands/contact geometry, relevant bubbles and UI readable and together when needed. Exclude irrelevant or inaccurate details when the supplied review explicitly requires it. Do not try to expose every detail.
Output one decision per supplied scene with EXACT keys:
scene_id, layout (full_frame|inset|reveal|reaction_pair|page_pan), panel_id, background_panel_id, editorial_reason (explain this narration's editorial purpose), region_evidence (describe actual visible features and why the proposed crop protects them), source_rect {x,y,width,height}, rect {x,y,width,height}, fit (contain|cover), camera_from {x,y,zoom}, camera_to {x,y,zoom}, entry (null or object), context (null or object).
Coordinates are normalized. source_rect crops the source artwork; rect places the cropped panel on the 1920x1080 canvas. Both rectangles must remain fully inside [0,1]. Full source is ${JSON.stringify(full)}. Camera x,y are within [0,1] and zoom is 1..4, normally restrained; identical endpoints intentionally hold. Camera zoom may cut content, so choose it from the actual raster. Optional move_start_sec/move_end_sec add holds using ABSOLUTE supplied beat times. Optional blur_px (0..80), background_brightness (0..1), border_px may be explicit.
For inset or page_pan, place a large sharp panel over a blurred/color-matched safe background. full_frame is appropriate for a necessary wide action or payoff, not a default every time. For reveal/reaction_pair: entry={direction:left|right|up|down,start_sec:ABSOLUTE,duration_sec:positive}; entry must finish strictly before beat end. context={panel_id:current_or_earlier_ID,rect:{x,y,width,height},fit:contain|cover,end_sec:ABSOLUTE}; context must last through entry completion, at most beat end. Optional context.camera={x,y,zoom} can frame an earlier face. Use actual word times for reveal cues. Other layouts require entry:null,context:null. Context/background can reference only supplied current or earlier panels, never later ones. Background does not inherit the main crop. Maintain main panel identity exactly.
Only allowed image/panel IDs are in this packet. Attached assets are listed in attachment order; identical hashes may serve several beat-specific aliases. Do not confuse their identities or invent panel sub-IDs.
${JSON.stringify({ canvas: { width: 1920, height: 1080 }, instructions: packet.instructions,
    attached_assets: attachedAssets, previous_context_scene: contextScene, scenes: chunk.scenes.map(scene => ({ id: scene.id, start_sec: scene.start_sec, end_sec: scene.end_sec, panel_id: scene.layers[0].panel_id })),
    panels: packet.baseline.panels.filter(panel => chunk.scenes.some(scene => scene.layers[0].panel_id === panel.id) || contextScene?.layers[0].panel_id === panel.id),
    beats: beats.map(beat => ({ id: beat.visual_beat_id, narration: beat.visual_beat_script_excerpt, action: beat.visual_beat_action, visual_focus: beat.visual_beat_focus, information_delta: beat.visual_information_delta, word_start: beat.source_word_start_index, word_end: beat.source_word_end_index })),
    words: packet.words.filter(word => word.index >= wordStart && word.index <= wordEnd),
    image_review_decisions: packet.image_review_decisions?.filter(row => attachedAssets.some(asset => asset.alias_ids.includes(row.image_id))) ?? [] })}`;
}

async function nativeAuthor({ prompt, images, outputPath, repoRoot }) {
  const result = await runCodexCli({ prompt, stageName: 'motion_edit_plan', repoRoot, outputPath,
    verbosity: 'low', timeoutMs: 600_000, extraArgs: ['--sandbox', 'read-only', ...images.flatMap(file => ['--image', file])] });
  let text = result.content.trim(); const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fenced) text = fenced[1];
  return JSON.parse(text);
}

export async function authorPanelProduction({ episodeDir, repoRoot, limit = 1000, concurrency = 8, executor = nativeAuthor, onProgress = () => {} }) {
  need(Number.isInteger(limit) && limit > 0 && Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 8, 'invalid dispatch bounds');
  const started = Date.now(), loaded = await readPanelProductionInputs({ episodeDir });
  need(await exists(loaded.paths.packetPath), 'prepare the official packet first');
  const packet = await read(loaded.paths.packetPath), packetHash = await sha256File(loaded.paths.packetPath);
  need(packet.schema === 'goldflow_panel_production_packet_v1' && JSON.stringify(packet.source_hashes) === JSON.stringify(loaded.inputHashes), 'prepared packet is stale');
  need(!await exists(loaded.paths.planPath), 'an official composition is already compiled; preserve it');
  const chunks = panelAuthorChunks(packet), job = path.join(loaded.episodeDir, 'reports', 'panel-authoring', packetHash);
  const codeHashes = { author: await sha256File(fileURLToPath(import.meta.url)),
    compiler: await sha256File(fileURLToPath(new URL('./panel-composition-authoring.mjs', import.meta.url))) };
  await fs.mkdir(path.join(job, 'chunks'), { recursive: true }); await fs.mkdir(path.join(job, 'native'), { recursive: true });
  const assets = new Map(packet.baseline.assets.map(asset => [asset.id, asset]));
  const panels = new Map(packet.baseline.panels.map(panel => [panel.id, panel]));
  const rows = new Map(); const pending = [];
  for (const chunk of chunks) {
    const contextIndex = packet.baseline.scenes.findIndex(scene => scene.id === chunk.scenes[0].id) - 1;
    const context = contextIndex >= 0 ? packet.baseline.scenes[contextIndex] : null;
    const wanted = [...chunk.scenes, ...(context ? [context] : [])].map(scene => assets.get(panels.get(scene.layers[0].panel_id).asset_id));
    const attached = []; for (const asset of wanted) {
      const same = attached.find(row => row.sha256 === asset.sha256);
      if (same) { if (!same.alias_ids.includes(asset.id)) same.alias_ids.push(asset.id); }
      else attached.push({ ...asset, alias_ids: [asset.id] });
    }
    const prompt = panelAuthorPrompt(packet, chunk, attached, context), key = hash({ version: 1, packetHash, codeHashes, chunk: chunk.id, prompt });
    const output = path.join(job, 'chunks', `${chunk.id}-${key}.json`), raw = path.join(job, 'native', `${chunk.id}-${key}.json`);
    const request = { chunk, prompt, attached, key, output, raw };
    if (await exists(output)) {
      const prior = await read(output);
      need(prior.request_key === key && prior.source_packet_sha256 === packetHash, `stale cached chunk ${chunk.id}`);
      need(prior.status === 'authored', `failed chunk retained for exact manual repair: ${chunk.id}; ${prior.error}`);
      validatePanelAuthorResponse(prior.response, chunk, packet.baseline); rows.set(chunk.id, prior);
    } else { need(!await exists(raw), `unreconciled native output retained: ${chunk.id}`); pending.push(request); }
  }
  let next = 0; const selected = pending.slice(0, limit), failures = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (next < selected.length) {
      const request = selected[next++], begin = Date.now(); let row;
      try {
        const response = await executor({ prompt: request.prompt, images: request.attached.map(asset => asset.path), outputPath: request.raw, repoRoot });
        validatePanelAuthorResponse(response, request.chunk, packet.baseline);
        row = { status: 'authored', response };
      } catch (error) { row = { status: 'failed', error: error.message }; failures.push(request.chunk.id); }
      row = { schema: 'goldflow_panel_author_chunk_v1', ...row, chunk_id: request.chunk.id, request_key: request.key,
        source_packet_sha256: packetHash, input_images: request.attached, raw_output_path: request.raw,
        raw_output_sha256: await exists(request.raw) ? await sha256File(request.raw) : null,
        planner_metadata: await readCodexCallMetadata(request.raw), elapsed_ms: Date.now() - begin, created_at: new Date().toISOString() };
      await fs.writeFile(request.output, json(row), { flag: 'wx' }); rows.set(request.chunk.id, row);
      onProgress({ phase: 'panel_chunk_authored', chunk_id: request.chunk.id, status: row.status, completed: rows.size, total: chunks.length });
    }
  }));
  for (const [file, expected] of Object.entries(loaded.inputHashes)) need(await sha256File(file) === expected, `input changed during authoring: ${file}`);
  const report = { schema: 'goldflow_panel_author_report_v1', status: failures.length ? 'needs_exact_repair' : rows.size === chunks.length ? 'candidate_ready' : 'partial',
    source_packet: { path: loaded.paths.packetPath, sha256: packetHash }, run_identity: packet.run_identity,
    source_hashes: loaded.inputHashes, code_hashes: codeHashes, chunk_count: chunks.length, authored_count: [...rows.values()].filter(row => row.status === 'authored').length,
    failed_chunk_ids: failures, new_planner_calls: selected.length, cached_chunks: rows.size - selected.length,
    elapsed_ms: Date.now() - started, media_provider_calls: 0, planner_cost_usd: null,
    note: 'Candidate authoring only; no image generation, script/audio edits, compilation, playback or final-QA approval.', created_at: new Date().toISOString() };
  if (report.status === 'candidate_ready') {
    const recipe = { schema: 'goldflow_panel_composition_recipe_v1', author: 'Native image-aware composition planner', source_packet: report.source_packet,
      decisions: chunks.flatMap(chunk => rows.get(chunk.id).response.decisions), authoring_job: job };
    try {
      validateEditorialBindings(packet.baseline, recipe);
      compilePanelComposition(packet.baseline, recipe, { mode: 'production_panel_composition' });
      report.recipe_path = path.join(job, `recipe-${hash(recipe)}.json`);
      if (!await exists(report.recipe_path)) await fs.writeFile(report.recipe_path, json(recipe), { flag: 'wx' });
      report.recipe_sha256 = await sha256File(report.recipe_path);
    } catch (error) { report.status = 'needs_exact_repair'; report.error = error.message; }
  }
  report.report_path = path.join(job, `report-${randomUUID()}.json`);
  await fs.writeFile(report.report_path, json(report), { flag: 'wx' });
  const pointer = path.join(loaded.episodeDir, `panel_authoring_report_${loaded.identity.episode}.json`);
  const temporary = `${pointer}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, json({ schema: 'goldflow_panel_author_pointer_v1', status: report.status,
    source_packet_sha256: packetHash, report_path: report.report_path, report_sha256: await sha256File(report.report_path),
    recipe_path: report.recipe_path ?? null, recipe_sha256: report.recipe_sha256 ?? null }));
  await fs.rename(temporary, pointer);
  return report;
}
