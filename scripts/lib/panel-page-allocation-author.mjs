import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runCodexCli } from './codex-cli-runner.mjs';
import { loadPanelAssetInputs, validatePanelAssetPlan } from './panel-production-assets.mjs';
import { PAGE_TEMPLATES, PAGE_TEMPLATE_MIN_CANVAS_WIDTH } from './panel-page-geometry.mjs';
import { PAGE_LIMITS } from './panel-page-prompts.mjs';
import { beatAllocationConstraints, denseAllocationFindings, allocationDensity, DENSE_ALLOCATION_TARGET } from './panel-page-allocation.mjs';

// Native dense page allocation author. It drafts a v2 candidate (pages of
// zones at 3840, singles only where needed) chunk by whole scenes, validates
// every chunk structurally and against the dense caps, and writes a merged
// candidate for the operator to import with `visual panel-assets --plan`.
// It never imports, approves, generates images or retries a failed chunk.
const need = (value, message) => { if (!value) throw new Error(`Dense allocation author: ${message}`); };
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = file => fs.access(file).then(() => true, () => false);

/** Whole scenes, in order, packed into requests of about maxBeats beats. */
export function denseAllocationChunks(beats, { maxBeats = 40 } = {}) {
  const scenes = [];
  for (const beat of beats) {
    const scene = beat.scene_id ?? beat.parent_scene_id;
    if (!scenes.length || scenes.at(-1).scene !== scene) scenes.push({ scene, beats: [] });
    scenes.at(-1).beats.push(beat);
  }
  const chunks = [];
  for (const scene of scenes) {
    if (!chunks.length || chunks.at(-1).beats.length + scene.beats.length > maxBeats) chunks.push({ id: `alloc_${String(chunks.length + 1).padStart(3, '0')}`, beats: [] });
    chunks.at(-1).beats.push(...scene.beats);
  }
  return chunks;
}

/** Per-scene generation budget: pages never span scenes, so each scene gets max(1, round(beats / target)); rounding up would cap the episode near 4.2. */
export function denseSceneBudgets(beats, target = DENSE_ALLOCATION_TARGET.beats_per_generation) {
  const scenes = new Map();
  for (const beat of beats) { const id = beat.scene_id ?? beat.parent_scene_id; scenes.set(id, (scenes.get(id) ?? 0) + 1); }
  return [...scenes].map(([scene, count]) => ({ scene, beats: count, max_generations: Math.max(1, Math.round(count / target)) }));
}

export function denseAllocationPrompt(chunk, constraints) {
  const templates = Object.entries(PAGE_TEMPLATES).map(([id, zones]) => ({ id, slots: zones.map(zone => zone.slot), min_canvas_width: PAGE_TEMPLATE_MIN_CANVAS_WIDTH[id] }));
  const beats = chunk.beats.map(beat => {
    const c = constraints.get(beat.visual_beat_id);
    return { id: beat.visual_beat_id, scene: c.scene_id, location: c.location_id, seconds: Math.round(c.duration_sec * 10) / 10, narration: beat.visual_beat_script_excerpt, action: beat.visual_beat_action, job: beat.visual_job, depiction: beat.depiction_mode, people: c.people, required_refs: c.required_ref_groups };
  });
  return `You are the allocation editor for a narrated manhwa recap. Allocate artwork for EVERY beat below. Return JSON only: {"asset_orders":[...],"beat_bindings":[...]}. Do not use tools or modify files.
Goal: about ${DENSE_ALLOCATION_TARGET.beats_per_generation} beats per generated image overall. Each generation is either one page (several separately croppable zones) or, rarely, a single image.
Budget: scene_budgets gives each scene's max_generations (its beats / ${DENSE_ALLOCATION_TARGET.beats_per_generation}, rounded, at least 1). Stay within it. Exceed a scene's budget only when the per-page people/reference caps make it impossible, and say so in that page's editorial_reason.
How to fit the budget: prefer the 5- and 6-zone templates (P5L, P6G) and P4H for dialogue, reaction and investigation runs; reserve 2-3-zone templates for scenes that need a big hero moment. Let a zone serve 2-3 consecutive beats whenever the narration stays on the same moment, speaker or object (the editor makes a wide, a close-up and a detail crop from one drawing, so design that zone with several readable regions). Singles should be almost never needed.
Rules:
- A page holds beats from ONE scene. Pick a template from templates; zones are its slots (use every slot exactly once). Canvas is always {"width":${DENSE_ALLOCATION_TARGET.canvas.width},"height":${DENSE_ALLOCATION_TARGET.canvas.height}}.
- A zone is one drawable artwork serving a CONTIGUOUS run of beats in source order. Let a zone serve several consecutive beats when one drawing honestly serves them (the editor will crop it differently per beat); give a new zone when the visible facts, cast, state or action change.
- Per page: at most ${PAGE_LIMITS.max_visible_people} distinct named people (the union of zone beats' people) and at most ${PAGE_LIMITS.max_references} distinct required_refs.
- Put establishing shots, payoffs, big action and reveals in a hero or left zone (P3H/P4H hero, P2V/P3L/P5L left). Use a single image only when no page can honestly hold the beat.
- Lettering-heavy cards (several lines of text) belong in a hero or left zone.
- Never invent beats, change narration or reorder beats.
Shapes (ids must be unique; prefix every asset_id and zone_id with "${chunk.id}_"):
page: {"asset_id","kind":"page","page_template","canvas","owner_beat_id":"<earliest beat>","beat_ids":["<all zone beats in source order>"],"visual_brief":"<shared location, time, lighting, cast>","editorial_reason","zones":[{"zone_id","slot","beat_ids":["<contiguous beats>"],"visual_brief":"<this panel's drawing>","editorial_reason"}]}
single: {"asset_id","kind":"single","owner_beat_id","beat_ids":["<contiguous beats>"],"visual_brief","editorial_reason"}
binding: {"beat_id","asset_id","zone_id"(pages only),"editorial_reason"} — exactly one per beat, in source order.
${JSON.stringify({ templates, scene_budgets: denseSceneBudgets(chunk.beats), beats })}`;
}

export async function nativeAllocation({ prompt, outputPath, repoRoot }) {
  const result = await runCodexCli({ prompt, stageName: 'visual_prompt_plan', repoRoot, outputPath, verbosity: 'low', timeoutMs: 900_000, extraArgs: ['--sandbox', 'read-only'] });
  let text = result.content.trim(); const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fenced) text = fenced[1];
  return JSON.parse(text);
}

export const DENSE_AUTHOR_JOB_ROOT = ['reports', 'panel_assets', 'dense-author'];
export const DENSE_ALLOCATION_REPORT_SCHEMA = 'goldflow_dense_allocation_report_v1';

export async function authorDensePageAllocation({ episodeDir, outputDir, repoRoot, executor = nativeAllocation, concurrency = 6, limit = 1000, maxBeats = 40, repairChunkIds = [], onProgress = () => {} }) {
  const loaded = await loadPanelAssetInputs(episodeDir);
  const referencePlan = await read(path.join(loaded.episodeDir, 'visual_reference_plan.json'));
  need(['passed', 'approved'].includes(referencePlan.status), 'a passed reference plan is required');
  return authorDenseAllocationChunks({ ...loaded, referencePlan, jobRoot: outputDir ?? path.join(loaded.episodeDir, ...DENSE_AUTHOR_JOB_ROOT), validate: plan => validatePanelAssetPlan(plan, loaded), repoRoot, executor, concurrency, limit, maxBeats, repairChunkIds, onProgress });
}

/** Every planner call the job has made: current chunk answers plus superseded ones. No call is ever deleted. */
export async function denseJobProviderCalls(job) {
  const current = (await fs.readdir(path.join(job, 'chunks')).catch(() => [])).filter(name => /^alloc_\d+\.json$/.test(name)).length;
  const superseded = (await fs.readdir(path.join(job, 'chunks', 'superseded')).catch(() => [])).filter(name => name.endsWith('.json') && !name.includes('.raw.')).length;
  return current + superseded;
}

/**
 * Chunked authoring core. Inputs must already be verified by the caller (`validate` checks a merged candidate).
 * `repairChunkIds` names failed chunks to re-request exactly once each; the failed answer is moved to
 * `chunks/superseded/` (never deleted) and nothing else is re-requested. Authored chunks are never repaired.
 */
export async function authorDenseAllocationChunks({ identity, beats, sourceHashes, referencePlan, jobRoot, validate, repoRoot, executor = nativeAllocation, concurrency = 6, limit = 1000, maxBeats = 40, repairChunkIds = [], onProgress = () => {} }) {
  const constraints = beatAllocationConstraints({ beats, referencePlan });
  const chunks = denseAllocationChunks(beats, { maxBeats });
  // The job is keyed by inputs AND exact prompts, so a prompt change never reuses old answers.
  const prompts = new Map(chunks.map(chunk => [chunk.id, denseAllocationPrompt(chunk, constraints)]));
  const inputsKey = sha(JSON.stringify({ source_hashes: sourceHashes, chunks: chunks.map(chunk => chunk.beats.map(beat => beat.visual_beat_id)), prompts: [...prompts.values()].map(sha) }));
  const job = path.resolve(jobRoot, inputsKey.slice(0, 16));
  await fs.mkdir(path.join(job, 'chunks'), { recursive: true });
  const base = { schema: 'goldflow_panel_asset_plan_v2', episode: identity.episode, author: 'Native dense page allocation author', source_hashes: sourceHashes };
  const repairs = new Set(repairChunkIds.map(String).filter(Boolean));
  for (const id of repairs) need(chunks.some(chunk => chunk.id === id), `unknown repair chunk ${id}`);
  const rows = new Map(), pending = [], superseded = [];
  for (const chunk of chunks) {
    const out = path.join(job, 'chunks', `${chunk.id}.json`);
    if (await exists(out)) {
      const row = await read(out);
      if (!repairs.has(chunk.id)) { rows.set(chunk.id, row); continue; }
      need(row.status === 'failed', `chunk ${chunk.id} is ${row.status}; only a failed chunk may be repaired`);
      const stamp = Date.now();
      await fs.mkdir(path.join(job, 'chunks', 'superseded'), { recursive: true });
      for (const suffix of ['.json', '.raw.json', '.raw.json.meta.json']) {
        const from = path.join(job, 'chunks', `${chunk.id}${suffix}`);
        if (await exists(from)) await fs.rename(from, path.join(job, 'chunks', 'superseded', `${chunk.id}.${stamp}${suffix}`));
      }
      superseded.push({ chunk_id: chunk.id, superseded_at: new Date(stamp).toISOString(), previous_error: row.error ?? null });
    } else need(!repairs.has(chunk.id), `chunk ${chunk.id} has no failed answer to repair`);
    pending.push({ chunk, out, raw: path.join(job, 'chunks', `${chunk.id}.raw.json`), prompt: prompts.get(chunk.id) });
  }
  let next = 0; const selected = pending.slice(0, limit);
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (next < selected.length) {
      const request = selected[next++], begin = Date.now(); let row;
      try {
        const response = await executor({ prompt: request.prompt, outputPath: request.raw, repoRoot });
        const plan = { ...base, asset_orders: response.asset_orders, beat_bindings: response.beat_bindings };
        validatePanelAssetPlan(plan, { beats: request.chunk.beats, identity, sourceHashes });
        const findings = denseAllocationFindings(plan, constraints);
        const blockers = findings.filter(row => row.severity === 'blocker');
        row = blockers.length ? { status: 'failed', error: blockers.map(row => row.message).join(' '), findings } : { status: 'authored', response, findings };
      } catch (error) { row = { status: 'failed', error: error.message }; }
      row = { schema: 'goldflow_dense_allocation_chunk_v1', chunk_id: request.chunk.id, beat_ids: request.chunk.beats.map(beat => beat.visual_beat_id), prompt_sha256: sha(request.prompt), elapsed_ms: Date.now() - begin, ...row };
      await fs.writeFile(request.out, json(row), { flag: 'wx' }); rows.set(request.chunk.id, row);
      onProgress({ chunk_id: request.chunk.id, status: row.status, completed: rows.size, total: chunks.length });
    }
  }));
  const failed = chunks.filter(chunk => rows.get(chunk.id)?.status === 'failed').map(chunk => chunk.id);
  const report = { schema: DENSE_ALLOCATION_REPORT_SCHEMA, episode: identity.episode, job_dir: job, chunk_count: chunks.length, authored: [...rows.values()].filter(row => row.status === 'authored').length, failed_chunk_ids: failed, provider_calls: selected.length, job_provider_calls: await denseJobProviderCalls(job), repaired_chunk_ids: superseded.map(row => row.chunk_id), superseded_chunks: superseded, image_provider_calls: 0, created_at: new Date().toISOString() };
  if (rows.size === chunks.length && !failed.length) {
    const candidate = { ...base, status: 'candidate', asset_orders: chunks.flatMap(chunk => rows.get(chunk.id).response.asset_orders), beat_bindings: chunks.flatMap(chunk => rows.get(chunk.id).response.beat_bindings) };
    validate(candidate);
    report.findings = denseAllocationFindings(candidate, constraints);
    report.density = allocationDensity(candidate, beats.length);
    const budgets = denseSceneBudgets(beats), sceneOf = new Map(beats.map(beat => [beat.visual_beat_id, beat.scene_id ?? beat.parent_scene_id]));
    const used = new Map(); for (const order of candidate.asset_orders) { const scene = sceneOf.get(order.beat_ids[0]); used.set(scene, (used.get(scene) ?? 0) + 1); }
    report.scene_budget = { budget_generations: budgets.reduce((n, row) => n + row.max_generations, 0), over_budget_scenes: budgets.filter(row => (used.get(row.scene) ?? 0) > row.max_generations).map(row => ({ ...row, used: used.get(row.scene) })) };
    report.candidate_path = path.join(job, `candidate-${sha(JSON.stringify(candidate)).slice(0, 12)}.json`);
    if (!await exists(report.candidate_path)) await fs.writeFile(report.candidate_path, json(candidate), { flag: 'wx' });
    report.status = 'candidate_ready';
    report.next = `Review the candidate, then import it: visual panel-assets --episode-dir <dir> --plan ${report.candidate_path}`;
  } else report.status = failed.length ? 'needs_exact_repair' : 'partial';
  await fs.writeFile(path.join(job, `report-${Date.now()}.json`), json(report), { flag: 'wx' });
  return report;
}
