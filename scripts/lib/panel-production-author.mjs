import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runCodexCli, readCodexCallMetadata } from './codex-cli-runner.mjs';
import { sha256File } from './file-hash.mjs';
import { readPanelProductionInputs, validateEditorialBindings } from './panel-production-plan.mjs';
import { compilePanelComposition } from './panel-composition-authoring.mjs';
import { panelImagePlacement } from './panel-layout-runtime.mjs';

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
    if (row.impact != null) need(['inset', 'full_frame', 'page_pan'].includes(row.layout) && Number.isFinite(row.impact.at_sec) && Number.isFinite(row.impact.duration_sec)
      && row.impact.at_sec >= scene.start_sec && row.impact.at_sec + row.impact.duration_sec <= scene.end_sec, `impact needs an inset/full_frame/page_pan layout and a window inside the beat: ${row.scene_id}`);
    for (const cut of row.cuts ?? []) {
      need(cut && cut.source_rect && cut.camera_from && cut.camera_to && cut.region_evidence?.trim().length > 20, `each cut needs a crop, camera and region evidence: ${row.scene_id}`);
      for (const box of [cut.source_rect, cut.rect].filter(Boolean)) need(['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) && box.x >= 0 && box.y >= 0
        && box.width > 0 && box.height > 0 && box.x + box.width <= 1 && box.y + box.height <= 1, `out-of-bounds cut crop or placement ${row.scene_id}`);
      for (const camera of [cut.camera_from, cut.camera_to]) need(Number.isFinite(camera.x) && Number.isFinite(camera.y)
        && camera.x >= 0 && camera.x <= 1 && camera.y >= 0 && camera.y <= 1 && camera.zoom >= 1 && camera.zoom <= 4, `invalid cut camera ${row.scene_id}`);
    }
  }
  validateEditorialBindings(baseline, { decisions: response.decisions });
  const panels = new Map(baseline.panels.map(panel => [panel.id, panel]));
  const assets = new Map(baseline.assets.map(asset => [asset.id, asset]));
  const checkFill = (panelId, crop, rect, fit, cameras, sceneId) => {
    const panel = panels.get(panelId), asset = assets.get(panel.asset_id);
    const sourceWidth = asset.width * panel.source_rect.width * crop.width;
    const sourceHeight = asset.height * panel.source_rect.height * crop.height;
    const viewport = { x: 0, y: 0, width: rect.width * baseline.width, height: rect.height * baseline.height };
    for (const camera of cameras) {
      const placed = panelImagePlacement(sourceWidth, sourceHeight, viewport, camera, fit);
      need(placed.width >= viewport.width - 2 && placed.height >= viewport.height - 2,
        `unfilled panel viewport ${sceneId}; match rect to crop aspect or choose a reviewed safe cover crop`);
    }
  };
  for (const row of response.decisions) {
    checkFill(row.panel_id, row.source_rect, row.rect, row.fit, [row.camera_from, row.camera_to], row.scene_id);
    for (const cut of row.cuts ?? []) checkFill(row.panel_id, cut.source_rect, cut.rect ?? row.rect, cut.fit ?? row.fit, [cut.camera_from, cut.camera_to], `${row.scene_id} cut`);
    if (row.context) checkFill(row.context.panel_id, full, row.context.rect, row.context.fit ?? 'contain',
      [row.context.camera ?? { x: .5, y: .5, zoom: 1 }], `${row.scene_id} context`);
  }
  return response.decisions;
}

/**
 * Deterministic geometry repair only: a contain panel whose authored rect does
 * not match its crop's aspect would letterbox. Resize that rect to the exact
 * crop aspect, keeping its centre and height (width-fit if it would overflow),
 * clamped inside the canvas. Crops, layouts, cameras and timing are untouched.
 * Returns the list of snaps so they are recorded with the authored chunk.
 */
export function snapPanelAuthorRects(response, baseline) {
  const panels = new Map(baseline.panels.map(panel => [panel.id, panel]));
  const assets = new Map(baseline.assets.map(asset => [asset.id, asset]));
  const round = value => Math.round(value * 1e6) / 1e6, snaps = [];
  const snap = (panelId, crop, rect) => {
    const panel = panels.get(panelId), asset = assets.get(panel?.asset_id);
    if (!asset?.width || !asset?.height || !rect || !crop) return null;
    const aspect = (asset.width * panel.source_rect.width * crop.width) / (asset.height * panel.source_rect.height * crop.height);
    const current = (rect.width * baseline.width) / (rect.height * baseline.height);
    if (Math.abs(current - aspect) / aspect < 0.002) return null;
    let height = rect.height, width = height * baseline.height * aspect / baseline.width;
    if (width > 1) { width = 1; height = width * baseline.width / (aspect * baseline.height); }
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
    return { x: round(Math.min(Math.max(cx - width / 2, 0), 1 - width)), y: round(Math.min(Math.max(cy - height / 2, 0), 1 - height)), width: round(width), height: round(height) };
  };
  for (const row of response?.decisions ?? []) {
    if (row.fit === 'contain' && row.layout !== 'page_pan') {
      for (const key of ['rect', 'rect_to']) {
        const fixed = row[key] && snap(row.panel_id, row.source_rect, row[key]);
        if (fixed) { snaps.push({ scene_id: row.scene_id, field: key, before: row[key], after: fixed }); row[key] = fixed; }
      }
    }
    for (const [i, cut] of (row.cuts ?? []).entries()) {
      if ((cut.fit ?? row.fit) !== 'contain' || row.layout === 'page_pan') continue;
      if (!cut.rect) cut.rect = { ...row.rect };
      const fixed = snap(row.panel_id, cut.source_rect, cut.rect);
      if (fixed) { snaps.push({ scene_id: row.scene_id, field: `cuts[${i}].rect`, before: cut.rect, after: fixed }); cut.rect = fixed; }
    }
    if (row.context && (row.context.fit ?? 'contain') === 'contain') {
      const fixed = snap(row.context.panel_id, full, row.context.rect);
      if (fixed) { snaps.push({ scene_id: row.scene_id, field: 'context.rect', before: row.context.rect, after: fixed }); row.context.rect = fixed; }
    }
  }
  return snaps;
}

/** Chunk panels, the previous context panel, and earlier-shown sibling zones of the chunk's pages. */
export function authorPromptPanels(baseline, chunk, contextScene) {
  const own = new Set(chunk.scenes.map(scene => scene.layers[0].panel_id));
  if (contextScene) own.add(contextScene.layers[0].panel_id);
  const pages = new Set(baseline.panels.filter(panel => own.has(panel.id)).map(panel => panel.metadata?.page_asset_id).filter(Boolean));
  const firstUse = new Map(baseline.scenes.map(scene => [scene.layers[0].panel_id, scene.start_sec]));
  const lastStart = Math.max(...chunk.scenes.map(scene => scene.start_sec));
  return baseline.panels.filter(panel => own.has(panel.id) || (pages.has(panel.metadata?.page_asset_id) && firstUse.has(panel.id) && firstUse.get(panel.id) <= lastStart));
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
Coordinates are normalized. source_rect crops the source artwork; rect places the cropped panel on the 1920x1080 canvas. Both rectangles must remain fully inside [0,1]. Full source is ${JSON.stringify(full)}. Camera x,y traverse AVAILABLE OVERFLOW, not focal-point coordinates: y=0 aligns the top, y=1 aligns the bottom when the image is taller than its viewport; x=0/1 align left/right when wider. When there is no overflow that axis is centered. Zoom is 1..4, normally restrained; identical endpoints intentionally hold. Camera zoom may cut content, so choose it from the actual raster. Optional move_start_sec/move_end_sec add holds using ABSOLUTE supplied beat times. Optional blur_px (0..80), background_brightness (0..1), border_px may be explicit.
Fill every foreground/context panel edge to edge, with no internal black padding. For contain, size rect to the actual cropped source aspect: (rect.width*1920)/(rect.height*1080) = (asset.width*panel.source_rect.width*source_rect.width)/(asset.height*panel.source_rect.height*source_rect.height). A wide detail belongs in a wide panel; a portrait belongs in a portrait panel. cover may instead fill a viewport only after checking the actual crop and camera preserve the required faces, complete hair/head silhouettes, hands/contact and lettering. Do not remove an unwanted bubble by slicing through a face; select a different region or panel shape. The renderer preserves aspect and does not stretch artwork. For inset or page_pan, place a large sharp panel over a blurred/color-matched safe background. full_frame is appropriate for a necessary wide action or payoff, not a default every time. For reveal/reaction_pair: entry={direction:left|right|up|down,start_sec:ABSOLUTE,duration_sec:positive}; entry must finish strictly before beat end. context={panel_id:current_or_earlier_ID,rect:{x,y,width,height},fit:contain|cover,end_sec:ABSOLUTE}; context must last through entry completion, at most beat end. Optional context.camera={x,y,zoom} can frame an earlier face. Use actual word times for reveal cues. Other layouts require entry:null,context:null. Context/background can reference only supplied current or earlier panels, never later ones. Background does not inherit the main crop. Maintain main panel identity exactly.
Optional cuts (several shots per beat): on inset, full_frame or page_pan only, a long beat may hard-cut to 1-2 further crops of the SAME main artwork: cuts=[{start_sec:ABSOLUTE,source_rect,rect(optional, defaults to the main rect),fit(optional),camera_from,camera_to,region_evidence}]. Cut where the narration's focus moves (a name, a reaction, a detail), on a word time; every shot lasts at least 1.2s; at most 2 cuts. Do not set rect_to or move times on a decision with cuts. Use cuts only when the artwork holds distinct readable regions; a quiet hold is still right for reading or dialogue.
Optional impact (a hit, crash, slam, collapse or shock landing on a word): impact={at_sec:ABSOLUTE word time,duration_sec:0.15-0.6,amplitude:0.004-0.03 (default 0.012)} adds a short decaying screen shake to the main panel. It needs a held panel during the shake (identical camera_from/camera_to, no rect_to, or move times outside it). For 1.5s after impact.at_sec, cuts may be as short as 0.35s for a quick cut burst (e.g. impact, hand, face), but the final shot must still last at least 1.2s. Use impact rarely, only for real physical or emotional blows, never as decoration.
Sibling zones: panels whose metadata shares a page_asset_id are separate zones of one generated page, drawn in one consistent style and lighting. When a beat is a reaction, an answer or a consequence of a sibling zone ALREADY shown, prefer reaction_pair or reveal with that sibling as context (its own panel_id), or a quick cut between them, rather than another isolated hold. Never use a sibling zone before its own beat has played.
Only allowed image/panel IDs are in this packet. Attached assets are listed in attachment order; identical hashes may serve several beat-specific aliases. Do not confuse their identities or invent panel sub-IDs.
${JSON.stringify({ canvas: { width: 1920, height: 1080 }, instructions: packet.instructions,
    attached_assets: attachedAssets, previous_context_scene: contextScene, scenes: chunk.scenes.map(scene => ({ id: scene.id, start_sec: scene.start_sec, end_sec: scene.end_sec, panel_id: scene.layers[0].panel_id })),
    panels: authorPromptPanels(packet.baseline, chunk, contextScene),
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

export async function authorPanelProduction({ episodeDir, repoRoot, limit = 1000, concurrency = 8, reviewedOverridesPath, executor = nativeAuthor, onProgress = () => {} }) {
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
  const retainedChunks = await fs.readdir(path.join(job, 'chunks'));
  const assets = new Map(packet.baseline.assets.map(asset => [asset.id, asset]));
  const panels = new Map(packet.baseline.panels.map(panel => [panel.id, panel]));
  const overrides = new Map(); let overrideReceipt;
  if (reviewedOverridesPath) {
    const absolute = path.resolve(reviewedOverridesPath), spec = await read(absolute);
    need(spec.schema === 'goldflow_panel_author_reviewed_overrides_v1' && spec.source_packet_sha256 === packetHash,
      'reviewed overrides require the current packet binding');
    need(spec.actual_composed_frames_reviewed === true && spec.reviewer?.trim() && spec.note?.trim().length > 20,
      'actual composed-frame review, reviewer and substantive note required');
    need(spec.frame_review?.path && await sha256File(spec.frame_review.path) === spec.frame_review.sha256,
      'composed-frame review evidence changed');
    need(Array.isArray(spec.overrides) && spec.overrides.length > 0, 'exact override scope required');
    for (const item of spec.overrides) {
      need(chunks.some(chunk => chunk.id === item.chunk_id) && !overrides.has(item.chunk_id), 'unknown or duplicate override chunk');
      need(item.reason?.trim().length > 20, 'substantive exact repair reason required');
      need(path.dirname(path.resolve(item.previous_chunk_path)) === path.join(job, 'chunks')
        && await sha256File(item.previous_chunk_path) === item.previous_chunk_sha256, 'previous chunk binding changed');
      const previous = await read(item.previous_chunk_path);
      need(previous.chunk_id === item.chunk_id && previous.source_packet_sha256 === packetHash,
        'previous chunk belongs to another scope');
      if (previous.raw_output_sha256) need(await sha256File(previous.raw_output_path) === previous.raw_output_sha256,
        'retained native output changed');
      validatePanelAuthorResponse(item.response, chunks.find(chunk => chunk.id === item.chunk_id), packet.baseline);
      overrides.set(item.chunk_id, { ...item, previous });
    }
    overrideReceipt = { path: absolute, sha256: await sha256File(absolute), reviewer: spec.reviewer,
      note: spec.note, frame_review: spec.frame_review };
  }
  const rows = new Map(); const pending = []; const reconciliations = [];
  for (const chunk of chunks) {
    const contextIndex = packet.baseline.scenes.findIndex(scene => scene.id === chunk.scenes[0].id) - 1;
    const context = contextIndex >= 0 ? packet.baseline.scenes[contextIndex] : null;
    // Earlier sibling zones share their page raster, so they add aliases, not images.
    const wanted = authorPromptPanels(packet.baseline, chunk, context).map(panel => assets.get(panel.asset_id));
    const attached = []; for (const asset of wanted) {
      const same = attached.find(row => row.sha256 === asset.sha256);
      if (same) { if (!same.alias_ids.includes(asset.id)) same.alias_ids.push(asset.id); }
      else attached.push({ ...asset, alias_ids: [asset.id] });
    }
    const prompt = panelAuthorPrompt(packet, chunk, attached, context), key = hash({ version: 1, packetHash, codeHashes, chunk: chunk.id, prompt });
    const output = path.join(job, 'chunks', `${chunk.id}-${key}.json`), raw = path.join(job, 'native', `${chunk.id}-${key}.json`);
    const request = { chunk, prompt, attached, key, output, raw };
    const override = overrides.get(chunk.id);
    if (override) need(JSON.stringify(override.previous.input_images) === JSON.stringify(attached),
      `reviewed override input images changed: ${chunk.id}`);
    if (await exists(output)) {
      const prior = await read(output);
      need(prior.request_key === key && prior.source_packet_sha256 === packetHash, `stale cached chunk ${chunk.id}`);
      need(prior.status === 'authored', `failed chunk retained for exact manual repair: ${chunk.id}; ${prior.error}`);
      validatePanelAuthorResponse(prior.response, chunk, packet.baseline);
      if (override) need(prior.reviewed_override?.sha256 === overrideReceipt.sha256,
        `cached chunk has different reviewed override: ${chunk.id}`);
      rows.set(chunk.id, prior);
    } else if (override) {
      if (await exists(raw)) need(raw === override.previous.raw_output_path
        && await sha256File(raw) === override.previous.raw_output_sha256, `unreconciled native output retained: ${chunk.id}`);
      reconciliations.push({ output, row: { schema: 'goldflow_panel_author_chunk_v1', status: 'authored',
        chunk_id: chunk.id, request_key: key, source_packet_sha256: packetHash, code_hashes: codeHashes,
        input_images: attached, response: override.response, authoring_method: 'reviewed_manual_reconciliation',
        reviewed_override: overrideReceipt, previous_chunk: { path: override.previous_chunk_path, sha256: override.previous_chunk_sha256 },
        repair_reason: override.reason, raw_output_path: override.previous.raw_output_path,
        raw_output_sha256: override.previous.raw_output_sha256, planner_metadata: override.previous.planner_metadata,
        new_planner_calls: 0, elapsed_ms: 0, created_at: new Date().toISOString() } });
    } else {
      need(!retainedChunks.some(name => name.startsWith(`${chunk.id}-`)), `changed author contract requires reviewed reconciliation, not redispatch: ${chunk.id}`);
      need(!await exists(raw), `unreconciled native output retained: ${chunk.id}`); pending.push(request);
    }
  }
  // Validate every exact adoption before writing receipts or admitting new requests.
  for (const { output, row } of reconciliations) {
    await fs.writeFile(output, json(row), { flag: 'wx' }); rows.set(row.chunk_id, row);
  }
  let next = 0; const selected = pending.slice(0, limit), failures = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (next < selected.length) {
      const request = selected[next++], begin = Date.now(); let row;
      try {
        const response = await executor({ prompt: request.prompt, images: request.attached.map(asset => asset.path), outputPath: request.raw, repoRoot });
        const rectSnaps = snapPanelAuthorRects(response, packet.baseline);
        validatePanelAuthorResponse(response, request.chunk, packet.baseline);
        row = { status: 'authored', response, ...(rectSnaps.length ? { rect_snaps: rectSnaps } : {}) };
      } catch (error) { row = { status: 'failed', error: error.message }; failures.push(request.chunk.id); }
      row = { schema: 'goldflow_panel_author_chunk_v1', ...row, chunk_id: request.chunk.id, request_key: request.key,
        source_packet_sha256: packetHash, code_hashes: codeHashes, input_images: request.attached, raw_output_path: request.raw,
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
    reviewed_reconciliations: reconciliations.map(item => item.row.chunk_id), reviewed_override: overrideReceipt ?? null,
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
