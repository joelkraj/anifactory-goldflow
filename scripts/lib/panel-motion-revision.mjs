import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sha256File } from './file-hash.mjs';
import { runCodexCli, readCodexCallMetadata } from './codex-cli-runner.mjs';
import { readPanelProductionInputs } from './panel-production-plan.mjs';
import { panelAuthorChunks, validatePanelAuthorResponse } from './panel-production-author.mjs';
import { compilePanelComposition } from './panel-composition-authoring.mjs';

const need = (v, message) => { if (!v) throw Error(`Panel motion revision: ${message}`); };
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const exists = p => fs.stat(p).then(() => true, () => false);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const write = (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });
const fields = new Set(['rect_to', 'camera_from', 'camera_to', 'move_start_sec', 'move_end_sec', 'entry']);

/** A new, explicitly requested motion treatment, never a retry of artwork/crop authoring. */
export function applyPanelMotionRevision({ response, chunk, baseline, priorDecisions }) {
  need(Array.isArray(response?.revisions) && response.revisions.length === chunk.scenes.length,
    `exact beat coverage required for ${chunk.id}`);
  const by = new Map(priorDecisions.map(d => [d.scene_id, d])), seen = new Set();
  const rows = response.revisions.map(r => {
    const original = by.get(r.scene_id);
    need(original && chunk.scenes.some(s => s.id === r.scene_id) && !seen.has(r.scene_id), 'unknown or duplicate beat');
    seen.add(r.scene_id);
    need(r.motion_reason?.trim().length > 25 && r.protected_regions?.trim().length > 20,
      `specific motion and protected-region evidence required for ${r.scene_id}`);
    need(r.motion_patch && typeof r.motion_patch === 'object' && !Array.isArray(r.motion_patch), 'motion_patch object required');
    need(Object.keys(r.motion_patch).every(k => fields.has(k)), 'revision cannot change crops, layout, placement, context, source IDs or text');
    const row = { ...structuredClone(original), ...structuredClone(r.motion_patch) };
    if (Object.hasOwn(r.motion_patch, 'entry')) {
      need(original.entry && row.entry && row.entry.start_sec === original.entry.start_sec
        && row.entry.direction === original.entry.direction,
      'entry revision must preserve the existing reveal cue and direction');
    }
    const moving = JSON.stringify(row.camera_from) !== JSON.stringify(row.camera_to)
      || row.rect_to && JSON.stringify(row.rect_to) !== JSON.stringify(row.rect) || row.entry;
    need(moving || r.hold_reason?.trim().length > 25, `specific story reason required for a static hold ${r.scene_id}`);
    row.editorial_reason += ` Motion revision: ${r.motion_reason}`;
    row.region_evidence += ` Motion protection: ${r.protected_regions}`;
    if (!moving) row.editorial_reason += ` Reading/action hold: ${r.hold_reason}`;
    return row;
  });
  const result = chunk.scenes.map(s => rows.find(r => r.scene_id === s.id));
  validatePanelAuthorResponse({ decisions: result }, chunk, baseline);
  validatePanelAuthorResponse({ decisions: result.map(r => ({ ...r, rect: r.rect_to ?? r.rect })) }, chunk, baseline);
  // Validate interval ordering, drift endpoints and crop fill with the real compiler.
  compilePanelComposition(baseline, { schema: 'goldflow_panel_composition_recipe_v1', author: 'Motion revision validation',
    decisions: priorDecisions.map(d => result.find(r => r.scene_id === d.scene_id) ?? d) },
  { mode: 'production_panel_composition' });
  return result;
}

export function panelMotionRevisionPrompt(packet, chunk, priorDecisions, assets, direction) {
  const ids = new Set(chunk.scenes.map(s => s.id)), beats = packet.beats.filter(b => ids.has(b.visual_beat_id));
  const start = Math.min(...beats.map(b => b.source_word_start_index));
  const end = Math.max(...beats.map(b => b.source_word_end_index));
  return `You are directing movement for an existing narrated manhwa composition. Inspect every attached accepted artwork raster. This is the user's new motion treatment of an existing candidate, not new illustration, story, crop or voice authoring. Use no tools. Return JSON only: {"revisions":[{"scene_id":"...","motion_patch":{},"motion_reason":"...","protected_regions":"...","hold_reason":"only for a fully static result"}]}.
The user found static full shots too slow, then approved an opening with moving panels, internal pans/zooms and reveals. Carry that energetic but readable treatment through this story. Direct the eye toward each spoken turn. There is no motion quota or repeating transition/zoom cycle. Do not preserve a static shot by default. A necessary dialogue/UI reading or impact hold must have a specific story reason. Do not make the sequence a continuously drifting slideshow either: start/stop moves on the supplied narration, use holds around important words, and retain clear action geography.
Immutable: exact beats/times, ALL source crops, main rectangles, fit, layout, context, backgrounds, images and story text. Preserve the inspected framing. motion_patch may contain ONLY rect_to, camera_from, camera_to, move_start_sec, move_end_sec, entry. Do not supply other fields. rect_to may translate/resize the panel inside the canvas; preserve its aspect to avoid padding. Cameras x/y traverse available image OVERFLOW (0=left/top,1=right/bottom), not focal coordinates. Zoom 1 preserves the existing crop for an aspect-matched viewport; zoom can cut heads, hands and lettering. Prefer panel drift at zoom one when these lie near a crop edge. Actual source art controls these choices. Explain precisely what must remain visible at BOTH endpoints.
Moves use absolute seconds inside each fixed beat. A main-panel entrance completes before its move begins. entry can ONLY refine an EXISTING entry, retaining its original start_sec and direction. Use a smooth short distance such as 0.08–0.14 and duration around .55–.65 seconds when the beat allows, optionally opacity_from:0, to avoid rapid full-screen travel. Preserve context through entry completion and never alter context to make an invalid entry fit. Do not add/remove entries or reveal information early. rect_to must remain inside [0,1]. Keep full heads/hair and all source-review crop/disclosure conditions. Background and context do not inherit the main source crop. Return one explicit revision per supplied beat, including empty motion_patch plus a substantive hold_reason where a deliberate hold is necessary.
${JSON.stringify({ direction, canvas: { width: 1920, height: 1080 }, attached_assets: assets,
    scenes: chunk.scenes.map(s => ({ id: s.id, start_sec: s.start_sec, end_sec: s.end_sec })),
    current_decisions: priorDecisions.filter(d => ids.has(d.scene_id)),
    panels: packet.baseline.panels.filter(p => priorDecisions.some(d => ids.has(d.scene_id)
      && [d.panel_id, d.background_panel_id, d.context?.panel_id].includes(p.id))),
    beats: beats.map(b => ({ id: b.visual_beat_id, narration: b.visual_beat_script_excerpt, action: b.visual_beat_action, focus: b.visual_beat_focus })),
    words: packet.words.filter(w => w.index >= start && w.index <= end),
    image_review_decisions: packet.image_review_decisions?.filter(r => assets.some(a => a.alias_ids.includes(r.image_id))) ?? [] })}`;
}

async function nativeRevision({ prompt, images, outputPath, repoRoot }) {
  const r = await runCodexCli({ prompt, stageName: 'motion_edit_plan', repoRoot, outputPath, verbosity: 'low',
    timeoutMs: 600000, extraArgs: ['--sandbox', 'read-only', ...images.flatMap(p => ['--image', p])] });
  const text = r.content.trim(), fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : text);
}

export async function revisePanelProductionMotion({ episodeDir, repoRoot, requestPath, limit = 1000,
  concurrency = 8, executor = nativeRevision, onProgress = () => {} }) {
  const started = Date.now();
  need(Number.isInteger(limit) && limit > 0 && Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 8, 'invalid dispatch bounds');
  const loaded = await readPanelProductionInputs({ episodeDir }), packet = await read(loaded.paths.packetPath);
  const packetHash = await sha256File(loaded.paths.packetPath), request = await read(requestPath), requestHash = await sha256File(requestPath);
  need(!await exists(loaded.paths.planPath), 'preserve an existing official composition; revision is candidate-only before compile');
  need(packet.schema === 'goldflow_panel_production_packet_v1'
    && JSON.stringify(packet.source_hashes) === JSON.stringify(loaded.inputHashes), 'stale packet');
  need(request.schema === 'goldflow_panel_motion_revision_request_v1' && request.source_packet_sha256 === packetHash
    && request.reviewer?.trim() && request.operator_direction?.trim().length > 40 && request.operator_quote?.trim(),
  'exact packet, reviewer and explicit new editorial direction required');
  const recipePath = path.resolve(request.recipe.path), recipeHash = await sha256File(recipePath), recipe = await read(recipePath);
  need(recipeHash === request.recipe.sha256 && recipe.source_packet?.sha256 === packetHash
    && path.resolve(recipe.source_packet.path) === loaded.paths.packetPath, 'stale base recipe');
  const sceneIds = new Set(packet.baseline.scenes.map(s => s.id));
  need(recipe.decisions.length === sceneIds.size && new Set(recipe.decisions.map(d => d.scene_id)).size === sceneIds.size
    && recipe.decisions.every(d => sceneIds.has(d.scene_id)), 'base recipe coverage invalid');
  compilePanelComposition(packet.baseline, recipe, { mode: 'production_panel_composition' });
  need(Array.isArray(request.frozen_scene_ids) && new Set(request.frozen_scene_ids).size === request.frozen_scene_ids.length
    && request.frozen_scene_ids.every(id => sceneIds.has(id)), 'invalid frozen beat scope');
  const frozen = new Set(request.frozen_scene_ids), chunks = panelAuthorChunks(packet)
    .map(c => ({ ...c, scenes: c.scenes.filter(s => !frozen.has(s.id)) })).filter(c => c.scenes.length);
  const job = path.join(loaded.episodeDir, 'reports', 'panel-motion-revisions', packetHash, recipeHash);
  const codeHashes = { revision: await sha256File(fileURLToPath(import.meta.url)),
    author_validator: await sha256File(fileURLToPath(new URL('./panel-production-author.mjs', import.meta.url))),
    compiler: await sha256File(fileURLToPath(new URL('./panel-composition-authoring.mjs', import.meta.url))) };
  const binding = { schema: 'goldflow_panel_motion_revision_binding_v1', request_path: path.resolve(requestPath),
    request_sha256: requestHash, recipe_path: recipePath, recipe_sha256: recipeHash, source_packet_sha256: packetHash, code_hashes: codeHashes };
  await fs.mkdir(path.join(job, 'chunks'), { recursive: true }); await fs.mkdir(path.join(job, 'native'), { recursive: true });
  const bindingPath = path.join(job, 'binding.json');
  if (await exists(bindingPath)) need(JSON.stringify(await read(bindingPath)) === JSON.stringify(binding), 'retained revision has changed request/code; reconcile it, never redispatch');
  else await write(bindingPath, binding);
  const panelBy = new Map(packet.baseline.panels.map(p => [p.id, p])), assetBy = new Map(packet.baseline.assets.map(a => [a.id, a]));
  const rows = new Map(), pending = [];
  for (const chunk of chunks) {
    const decisions = recipe.decisions.filter(d => chunk.scenes.some(s => s.id === d.scene_id)), attached = [];
    for (const id of new Set(decisions.flatMap(d => [d.panel_id, d.background_panel_id, d.context?.panel_id].filter(Boolean)))) {
      const a = assetBy.get(panelBy.get(id).asset_id), same = attached.find(v => v.sha256 === a.sha256);
      if (same) { if (!same.alias_ids.includes(a.id)) same.alias_ids.push(a.id); }
      else attached.push({ ...a, alias_ids: [a.id] });
    }
    const output = path.join(job, 'chunks', `${chunk.id}.json`), raw = path.join(job, 'native', `${chunk.id}.json`);
    if (await exists(output)) {
      const row = await read(output);
      need(row.request_sha256 === requestHash && row.recipe_sha256 === recipeHash, 'cached revision binding changed');
      need(row.status === 'authored', `failed revision retained for manual reconciliation: ${chunk.id}`);
      need(await sha256File(row.raw_output_path) === row.raw_output_sha256, 'retained native response changed');
      applyPanelMotionRevision({ response: row.response, chunk, baseline: packet.baseline, priorDecisions: recipe.decisions });
      rows.set(chunk.id, row);
    } else {
      need(!await exists(raw), `interrupted native revision retained: ${chunk.id}`);
      need(!await exists(path.join(job, 'chunks', `${chunk.id}.claim.json`)), `interrupted or live revision claim retained: ${chunk.id}`);
      pending.push({ chunk, attached, output, raw, prompt: panelMotionRevisionPrompt(packet, chunk, recipe.decisions, attached, request.operator_direction) });
    }
  }
  let next = 0; const selected = pending.slice(0, limit), failures = [];
  // Exclusive append-only admission before any provider call. A crash retains
  // the claim, so an absent response never becomes permission to resubmit.
  for (const q of selected) await write(path.join(job, 'chunks', `${q.chunk.id}.claim.json`),
    { request_sha256: requestHash, recipe_sha256: recipeHash, chunk_id: q.chunk.id, admitted_at: new Date().toISOString() });
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (next < selected.length) {
      const q = selected[next++], begin = Date.now(); let row;
      try {
        const response = await executor({ prompt: q.prompt, images: q.attached.map(a => a.path), outputPath: q.raw, repoRoot });
        const decisions = applyPanelMotionRevision({ response, chunk: q.chunk, baseline: packet.baseline, priorDecisions: recipe.decisions });
        row = { status: 'authored', response, decisions };
      } catch (e) { row = { status: 'failed', error: e.message }; failures.push(q.chunk.id); }
      row = { schema: 'goldflow_panel_motion_revision_chunk_v1', ...row, chunk_id: q.chunk.id,
        request_sha256: requestHash, recipe_sha256: recipeHash, source_packet_sha256: packetHash,
        input_images: q.attached, raw_output_path: q.raw, raw_output_sha256: await exists(q.raw) ? await sha256File(q.raw) : null,
        planner_metadata: await readCodexCallMetadata(q.raw), code_hashes: codeHashes, elapsed_ms: Date.now() - begin, created_at: new Date().toISOString() };
      await write(q.output, row); rows.set(q.chunk.id, row);
      onProgress({ phase: 'panel_motion_revision_authored', chunk_id: q.chunk.id, status: row.status, completed: rows.size, total: chunks.length });
    }
  }));
  for (const [p, expected] of Object.entries({ ...loaded.inputHashes, [recipePath]: recipeHash, [path.resolve(requestPath)]: requestHash,
    [fileURLToPath(import.meta.url)]: codeHashes.revision,
    [fileURLToPath(new URL('./panel-production-author.mjs', import.meta.url))]: codeHashes.author_validator,
    [fileURLToPath(new URL('./panel-composition-authoring.mjs', import.meta.url))]: codeHashes.compiler }))
    need(await sha256File(p) === expected, `source changed during revision ${p}`);
  const report = { schema: 'goldflow_panel_motion_revision_report_v1', status: failures.length ? 'needs_exact_repair' : rows.size === chunks.length ? 'candidate_ready' : 'partial',
    ...binding, chunk_count: chunks.length, completed_chunk_count: rows.size, failed_chunk_ids: failures, new_planner_calls: selected.length,
    elapsed_ms: Date.now() - started, planner_cost_usd: null,
    frozen_scene_ids: request.frozen_scene_ids, media_provider_calls: 0, source_hashes: loaded.inputHashes, created_at: new Date().toISOString(),
    note: 'New requested motion treatment only. No crop/story/audio change or official compile/playback approval.' };
  if (report.status === 'candidate_ready') {
    const revised = new Map([...rows.values()].flatMap(r => r.decisions).map(d => [d.scene_id, d]));
    const candidate = { ...recipe, author: 'Image-aware motion revision; actual frame and playback review pending',
      decisions: recipe.decisions.map(d => revised.get(d.scene_id) ?? d), motion_revision: binding };
    compilePanelComposition(packet.baseline, candidate, { mode: 'production_panel_composition' });
    report.recipe_path = path.join(job, `recipe-${hash(candidate)}.json`);
    if (!await exists(report.recipe_path)) await write(report.recipe_path, candidate);
    report.recipe_sha256 = await sha256File(report.recipe_path);
  }
  report.report_path = path.join(job, `report-${randomUUID()}.json`); await write(report.report_path, report);
  return report;
}
