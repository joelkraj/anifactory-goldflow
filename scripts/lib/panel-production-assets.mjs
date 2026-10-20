import { retainedBaselineSource } from './retained-baseline-source.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertPanelProductionIdentity, isPanelProductionIdentity } from './panel-production-policy.mjs';
import { PAGE_TEMPLATES, PAGE_TEMPLATE_MIN_CANVAS_WIDTH } from './panel-page-geometry.mjs';
import { FAL_PAGE_CANVAS_SIZES } from './fal-provider.mjs';
import { pageFrameText, pagePanelHeadings, PAGE_LIMITS } from './panel-page-prompts.mjs';

const need = (value, message) => { if (!value) throw new Error(`Panel asset plan: ${message}`); };
const sha = value => createHash('sha256').update(value).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const fileHash = async file => sha(await fs.readFile(file));
const text = value => typeof value === 'string' && value.trim().length > 0;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const stable = value => JSON.stringify(value, Object.keys(value ?? {}).sort());

export function panelAssetPlanPaths(episodeDir, episode) {
  need(safeId(episode), 'safe episode ID required');
  return {
    planPath: path.join(episodeDir, `panel_asset_plan_${episode}.json`),
    packetPath: path.join(episodeDir, `panel_asset_packet_${episode}.json`),
    candidatePath: path.join(episodeDir, `panel_asset_candidate_${episode}.json`),
  };
}

export async function loadPanelAssetInputs(episodeDir) { return inputs(episodeDir); }

async function inputs(episodeDir) {
  need(text(episodeDir), 'explicit episodeDir required');
  const dir = await fs.realpath(episodeDir), sourceHashes = {};
  const retainedIdentity = await read(path.join(dir, "run_identity.json"));
  const bind = async (file, expected) => {
    const absolute = await fs.realpath(path.resolve(dir, file));
    const resolved = expected === undefined ? absolute : await retainedBaselineSource(retainedIdentity, absolute, expected);
    const hash = await fileHash(resolved);
    sourceHashes[absolute] = hash;
    return { path: resolved, hash };
  };
  const json = async file => { const ref = await bind(file); return { ...ref, value: await read(ref.path) }; };
  const run = await json('run_identity.json');
  const identity = run.value;
  assertPanelProductionIdentity(identity);
  const script = await bind('script_clean.md');
  const approval = await json('operator_script_approval.json');
  const lock = await json('script_lock.json');
  need(approval.value.operator_approved === true && (approval.value.script_clean_hash ?? approval.value.script_hash) === script.hash, 'exact approved script required');
  need((lock.value.script_clean_hash ?? lock.value.script_hash) === script.hash, 'script lock is stale');
  const artifact = await json('visual_beat_plan.json');
  const beats = artifact.value.beats;
  need(artifact.value.status === 'passed' && artifact.value.source_script_hash === script.hash && Array.isArray(beats) && beats.length, 'passed visual beats for approved script required');
  const grouping = await json('visual_beat_approval.json');
  need(grouping.value.status === 'approved' && grouping.value.visual_beat_plan_sha256 === artifact.hash && grouping.value.grouping_lock_sha256 === artifact.value.editorial_director?.grouping_lock_sha256, 'current visual beat grouping approval required');
  const verified = new Set();
  const verifyLineage = async value => {
    for (const [file, hash] of Object.entries(value.source_hashes ?? {})) {
      const ref = await bind(file, hash);
      if (verified.has(ref.path)) continue;
      verified.add(ref.path);
      if (ref.path.endsWith('.json')) await verifyLineage(await read(ref.path));
    }
  };
  await verifyLineage(artifact.value);
  const beatIds = new Set(), imageIds = new Set();
  for (const beat of beats) {
    need(safeId(beat.visual_beat_id) && !beatIds.has(beat.visual_beat_id), 'unique safe visual beat IDs required');
    need(safeId(beat.image_id_hint) && !imageIds.has(beat.image_id_hint), 'unique safe beat image IDs required');
    beatIds.add(beat.visual_beat_id); imageIds.add(beat.image_id_hint);
  }
  return { episodeDir: dir, identity, beats, sourceHashes, ...panelAssetPlanPaths(dir, identity.episode) };
}

/**
 * A page order is one generation holding 2-6 separately croppable zones from
 * one scene. Each zone serves a contiguous run of beats; the page owner is the
 * earliest of them. Zone rectangles are measured after generation; this
 * validator checks the authored structure only.
 */
function validatePageOrder(order, byBeat, zoneIds, beatZones) {
  const template = PAGE_TEMPLATES[order.page_template];
  need(template, `page ${order.asset_id} needs a supported page_template`);
  need(Array.isArray(order.zones) && order.zones.length === template.length, `page ${order.asset_id} needs exactly ${template?.length} zones`);
  // The page canvas is part of the order: dense templates need 2560/3840 so zones keep detail.
  const canvas = order.canvas ?? { width: 1920, height: 1080 };
  need(FAL_PAGE_CANVAS_SIZES.some(row => row.width === canvas.width && row.height === canvas.height), `page ${order.asset_id} has an unsupported canvas`);
  need(canvas.width >= PAGE_TEMPLATE_MIN_CANVAS_WIDTH[order.page_template], `page ${order.asset_id} ${order.page_template} needs a canvas at least ${PAGE_TEMPLATE_MIN_CANVAS_WIDTH[order.page_template]} wide`);
  const slots = new Set(template.map(zone => zone.slot)), covered = [];
  for (const zone of order.zones) {
    need(safeId(zone.zone_id) && !zoneIds.has(zone.zone_id), `page ${order.asset_id} needs unique safe zone IDs`);
    zoneIds.add(zone.zone_id);
    need(slots.delete(zone.slot), `page ${order.asset_id} zone ${zone.zone_id} has a missing or repeated ${order.page_template} slot`);
    need(text(zone.visual_brief) && text(zone.editorial_reason), `zone ${zone.zone_id} needs an authored visual brief and editorial reason`);
    need(Array.isArray(zone.beat_ids) && zone.beat_ids.length > 0 && zone.beat_ids.every(id => byBeat.has(id)), `zone ${zone.zone_id} needs known beats`);
    const indices = zone.beat_ids.map(id => byBeat.get(id).i);
    need(indices.every((index, i) => i === 0 || index === indices[i - 1] + 1), `zone ${zone.zone_id} beats must be contiguous in source order`);
    for (const id of zone.beat_ids) { need(!beatZones.has(id), `beat ${id} is in more than one zone`); beatZones.set(id, zone.zone_id); covered.push(id); }
  }
  covered.sort((a, b) => byBeat.get(a).i - byBeat.get(b).i);
  need(JSON.stringify(covered) === JSON.stringify(order.beat_ids), `page ${order.asset_id} beat_ids must equal its zones' beats`);
  const scenes = new Set(order.beat_ids.map(id => byBeat.get(id).beat.scene_id));
  need(scenes.size === 1 && [...scenes][0], `page ${order.asset_id} zones must come from one scene`);
}

/** Structural validation only. Editorial decisions must be authored, never inferred. */
export function validatePanelAssetPlan(plan, { beats, identity, sourceHashes }) {
  assertPanelProductionIdentity(identity);
  need(['goldflow_panel_asset_plan_v1', 'goldflow_panel_asset_plan_v2'].includes(plan?.schema), 'unsupported schema');
  const pagesAllowed = plan.schema === 'goldflow_panel_asset_plan_v2';
  need(plan.episode === identity.episode, 'episode does not match identity');
  need(text(plan.author), 'author is required');
  need(stable(plan.source_hashes) === stable(sourceHashes), 'source hashes are missing or stale');
  need(Array.isArray(plan.asset_orders) && plan.asset_orders.length > 0, 'authored asset orders required');
  need(Array.isArray(plan.beat_bindings) && plan.beat_bindings.length === beats.length, 'exactly one binding for every beat required');
  const byBeat = new Map(beats.map((beat, i) => [beat.visual_beat_id, { beat, i }]));
  const orders = new Map(), zoneIds = new Set(), beatZones = new Map();
  for (const order of plan.asset_orders) {
    need(safeId(order.asset_id) && !orders.has(order.asset_id), 'unique safe asset IDs required');
    need(text(order.visual_brief) && text(order.editorial_reason), `asset ${order.asset_id} needs an authored visual brief and editorial reason`);
    need(Array.isArray(order.beat_ids) && order.beat_ids.length > 0 && new Set(order.beat_ids).size === order.beat_ids.length, `asset ${order.asset_id} needs distinct beat IDs`);
    need(order.beat_ids.every(id => byBeat.has(id)), `asset ${order.asset_id} references an unknown beat`);
    const sorted = [...order.beat_ids].sort((a, b) => byBeat.get(a).i - byBeat.get(b).i);
    need(JSON.stringify(sorted) === JSON.stringify(order.beat_ids) && order.owner_beat_id === sorted[0], `asset ${order.asset_id} owner must be its first bound beat in source order`);
    need([undefined, 'single', 'page'].includes(order.kind) && (order.kind !== 'page' || pagesAllowed), `asset ${order.asset_id} has an unsupported kind`);
    if (order.kind === 'page') validatePageOrder(order, byBeat, zoneIds, beatZones);
    else need(order.zones === undefined && order.page_template === undefined, `asset ${order.asset_id} declares zones without kind page`);
    orders.set(order.asset_id, order);
  }
  const bound = new Map();
  for (let i = 0; i < plan.beat_bindings.length; i++) {
    const binding = plan.beat_bindings[i];
    need(binding.beat_id === beats[i].visual_beat_id && !bound.has(binding.beat_id), 'bindings must cover every beat exactly once in source order');
    need(orders.has(binding.asset_id) && text(binding.editorial_reason), `binding ${binding.beat_id} needs an existing asset and editorial reason`);
    need(orders.get(binding.asset_id).beat_ids.includes(binding.beat_id), `binding/order disagree for ${binding.beat_id}`);
    const zone = beatZones.get(binding.beat_id);
    need(zone ? binding.zone_id === zone : binding.zone_id === undefined, `binding ${binding.beat_id} must name ${zone ? `its page zone ${zone}` : 'no zone'}`);
    bound.set(binding.beat_id, binding);
  }
  for (const order of orders.values()) for (const id of order.beat_ids) need(bound.get(id)?.asset_id === order.asset_id, `asset ${order.asset_id} lists a conflicting beat`);
  return plan;
}

async function writeNew(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

export async function preparePanelAssetPlan({ episodeDir }) {
  const loaded = await inputs(episodeDir);
  const { identity, beats, sourceHashes, packetPath, candidatePath } = loaded;
  const candidate = { schema: 'goldflow_panel_asset_plan_v1', status: 'needs_authored_allocation', episode: identity.episode, author: '', source_hashes: sourceHashes, asset_orders: [], beat_bindings: [] };
  const packet = {
    schema: 'goldflow_panel_asset_packet_v1', status: 'needs_authored_allocation', episode: identity.episode, source_hashes: sourceHashes, beats,
    instructions: [
      'Read the full approved script and beat sequence. Author unique artwork orders BEFORE provider prompt authoring. No quota, fixed cycle, keyword rule, or automatic reuse decision is permitted.',
      'Each order needs asset_id, owner_beat_id, beat_ids in source order, visual_brief and editorial_reason. The owner must be the first beat using the artwork. Each beat binding needs beat_id, asset_id and editorial_reason, in exact source order.',
      'Describe one coherent drawable composition that supports all bound beats. Reuse only when the same visible facts, characters, state and image-native text remain accurate; choose fresh artwork when the story needs it. Explain useful crop or reaction opportunities in the brief.',
      'Do not change narration or beat timing. Native artwork remains 16:9; the later panel composer authors crops, holds and overlays. The planner will author one prompt per unique order and aliases will retain exact source provenance.',
      'This packet/template is not a passed plan. Fill the candidate and import it using visual panel-assets --plan <candidate>.',
      `Optional page orders (set schema goldflow_panel_asset_plan_v2): one generation holding 2-6 separately croppable zones from ONE scene, using a template from page_templates with a canvas at least its page_template_min_canvas_width (dense pages use 3840x2160). Each zone gets its own drawable subject, a contiguous run of beats, a visual_brief and editorial_reason; every bound beat names its zone_id. Group only beats whose cast, wardrobe, location and state are simultaneously true: at most ${PAGE_LIMITS.max_visible_people} named people and ${PAGE_LIMITS.max_references} references per page. Put establishing shots, payoffs and reveals in a hero or left zone. Pages are a generation efficiency only: each zone is later cropped into the ordinary panel layouts, and no viewer sees the page itself. visual panel-assets --action author-dense drafts such a candidate.`
    ],
    page_templates: Object.fromEntries(Object.entries(PAGE_TEMPLATES).map(([id, zones]) => [id, zones.map(zone => zone.slot)])),
    page_template_min_canvas_width: { ...PAGE_TEMPLATE_MIN_CANVAS_WIDTH },
    candidate_shape: { asset_orders: [{ asset_id: 'asset_001', owner_beat_id: '<first beat ID>', beat_ids: ['<beat IDs>'], visual_brief: '<authored composition>', editorial_reason: '<why this image serves these beats>' }], beat_bindings: [{ beat_id: '<beat ID>', asset_id: 'asset_001', editorial_reason: '<how narration uses this art>' }] },
    page_candidate_shape: { schema: 'goldflow_panel_asset_plan_v2', asset_orders: [{ asset_id: 'page_001', kind: 'page', page_template: 'P3L', owner_beat_id: '<earliest beat ID>', beat_ids: ['<all zone beats in source order>'], visual_brief: '<shared location, time, lighting, cast>', editorial_reason: '<why these beats share one generation>', zones: [{ zone_id: 'page_001_z1', slot: 'left', beat_ids: ['<contiguous beat IDs>'], visual_brief: '<this panel>', editorial_reason: '<why>' }] }], beat_bindings: [{ beat_id: '<beat ID>', asset_id: 'page_001', zone_id: 'page_001_z1', editorial_reason: '<how narration uses this zone>' }] },
    created_at: new Date().toISOString(),
  };
  await writeNew(packetPath, packet);
  await writeNew(candidatePath, candidate);
  return { ...loaded, packet, candidate, status: packet.status };
}

export async function writePanelAssetPlan({ episodeDir, planPath }) {
  const loaded = await inputs(episodeDir);
  need(text(planPath), 'explicit authored planPath required');
  const sourcePath = await fs.realpath(path.resolve(planPath));
  need(sourcePath !== loaded.planPath, 'candidate must be separate from official plan');
  const candidate = await read(sourcePath);
  validatePanelAssetPlan(candidate, loaded);
  const report = { ...candidate, status: 'passed', authored_plan: { path: sourcePath, sha256: await fileHash(sourcePath) }, unique_asset_count: candidate.asset_orders.length, beat_count: loaded.beats.length, reused_beat_count: loaded.beats.length - candidate.asset_orders.length, provider_calls: 0, cost_usd: 0, created_at: new Date().toISOString() };
  // Retain exact content independently of an editable authoring candidate.
  const reportsDir = path.join(loaded.episodeDir, 'reports', 'panel_assets');
  await fs.mkdir(reportsDir, { recursive: true });
  const retained = path.join(reportsDir, `${Date.now()}-${randomUUID()}.json`);
  await writeNew(retained, report);
  await writeNew(loaded.planPath, report);
  return { ...loaded, plan: report, retainedPath: retained, planSha256: await fileHash(loaded.planPath) };
}

export async function loadPanelAssetPlan({ episodeDir }) {
  const loaded = await inputs(episodeDir);
  const plan = await read(loaded.planPath);
  need(plan.status === 'passed', 'official plan must be passed');
  validatePanelAssetPlan(plan, loaded);
  return { ...loaded, plan, planSha256: await fileHash(loaded.planPath) };
}

export function panelAssetOwnerRows(beats, plan) {
  const byBeat = new Map(beats.map(beat => [beat.visual_beat_id, beat]));
  return plan.asset_orders.map(order => ({
    ...byBeat.get(order.owner_beat_id),
    panel_asset_order: { ...order, bound_beats: order.beat_ids.map(id => ({ ...byBeat.get(id) })) },
  })).sort((a, b) => beats.indexOf(byBeat.get(a.visual_beat_id)) - beats.indexOf(byBeat.get(b.visual_beat_id)));
}

// Provider packets need the evidence for every covered beat, but not repeated
// parent-scene reports, timing diagnostics or artifact provenance. The official
// allocation and full beat plan remain unchanged and hash-bound on disk.
export function panelAssetOrderForPrompt(order) {
  if (!order) return null;
  const fields = [
    'visual_beat_id', 'scene_id', 'source_atom_ids',
    'source_word_start_index', 'source_word_end_index',
    'start_sec', 'end_sec', 'visual_beat_script_excerpt',
    'visual_beat_action', 'visual_beat_action_evidence', 'depiction_mode',
    'physically_visible_entity_ids', 'screen_visible_entity_ids',
    'preview_visible_entity_ids', 'mentioned_only_entity_ids',
    'active_state_constraints', 'location_id', 'location',
    'local_props', 'local_ui_elements', 'narrative_overlays',
    'background_population', 'continuity_notes',
  ];
  return {
    asset_id: order.asset_id, owner_beat_id: order.owner_beat_id,
    beat_ids: order.beat_ids, visual_brief: order.visual_brief,
    editorial_reason: order.editorial_reason,
    ...(order.kind === 'page' ? { kind: 'page', page_template: order.page_template, page_frame: pageFrameText(order.page_template), panel_headings: pagePanelHeadings(order), zones: order.zones.map(({ zone_id, slot, beat_ids, visual_brief, editorial_reason }) => ({ zone_id, slot, beat_ids, visual_brief, editorial_reason })) } : {}),
    bound_beats: (order.bound_beats ?? []).map(beat => Object.fromEntries(
      fields.filter(field => beat[field] !== undefined).map(field => [field, beat[field]]),
    )),
  };
}

/** Expand identity/timing aliases only; creative prompt text is preserved verbatim. */
export function expandPanelAssetPrompts(ownerPrompts, { plan, beats, planSha256 }) {
  const byOwner = new Map(ownerPrompts.map(row => [row.visual_beat_id, row]));
  const orderMap = new Map(plan.asset_orders.map(order => [order.asset_id, order]));
  const beatMap = new Map(beats.map(beat => [beat.visual_beat_id, beat]));
  return plan.beat_bindings.map(binding => {
    const order = orderMap.get(binding.asset_id), beat = beatMap.get(binding.beat_id);
    const owner = byOwner.get(order.owner_beat_id);
    need(owner, `missing owner prompt ${order.owner_beat_id}`);
    const ownerImageId = beatMap.get(order.owner_beat_id).image_id_hint;
    need(owner.image_id === ownerImageId, `owner prompt image ID mismatch for ${order.asset_id}`);
    const alias = binding.beat_id !== order.owner_beat_id;
    return {
      ...owner,
      image_id: beat.image_id_hint, scene_id: beat.scene_id, visual_beat_id: beat.visual_beat_id,
      start_sec: beat.start_sec, end_sec: beat.end_sec, duration_sec: beat.duration_sec ?? beat.end_sec - beat.start_sec,
      source_word_start_index: beat.source_word_start_index, source_word_end_index: beat.source_word_end_index,
      visual_beat_script_excerpt: beat.visual_beat_script_excerpt, visual_beat_action: beat.visual_beat_action,
      active_state_constraints: beat.active_state_constraints ?? null,
      visual_job: beat.visual_job ?? null, editorial_cues: beat.editorial_cues ?? [],
      suggested_shot_job: beat.suggested_shot_job ?? null, visual_information_delta: beat.visual_information_delta ?? null,
      visual_novelty_directive: beat.visual_novelty_directive ?? null, quality_budget: beat.quality_budget ?? null,
      beat_value: beat.beat_value ?? null, retention_reset: beat.retention_reset ?? null,
      audiovisual_intent: beat.audiovisual_intent ?? null,
      depiction_mode: beat.depiction_mode ?? 'current_reality',
      physically_visible_entity_ids: beat.physically_visible_entity_ids ?? [],
      screen_visible_entity_ids: beat.screen_visible_entity_ids ?? [],
      preview_visible_entity_ids: beat.preview_visible_entity_ids ?? [],
      mentioned_only_entity_ids: beat.mentioned_only_entity_ids ?? [],
      panel_asset_id: order.asset_id, panel_asset_plan_sha256: planSha256,
      panel_asset_owner_image_id: ownerImageId, panel_asset_binding_reason: binding.editorial_reason,
      panel_page_template: order.kind === 'page' ? order.page_template : null, panel_zone_id: binding.zone_id ?? null,
      ...(order.kind === 'page' && order.canvas ? { panel_page_canvas: { width: order.canvas.width, height: order.canvas.height } } : {}),
      panel_zone_slot: binding.zone_id ? order.zones.find(zone => zone.zone_id === binding.zone_id).slot : null,
      image_generation_required: true, provider_submission_required: !alias,
      image_strategy: alias ? 'reuse_prior_approved' : 'fresh',
      editorial_reuse_approved: alias, reuse_source_image_id: alias ? ownerImageId : null,
      editorial_reuse_candidate_image_ids: [],
    };
  });
}

export async function assertPanelPromptAllocation({ episodeDir, prompts, allowSubset = false }) {
  const identity = await read(path.join(episodeDir, 'run_identity.json')).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
  if (!isPanelProductionIdentity(identity)) {
    need(!prompts.some(row => row.panel_asset_id || row.provider_submission_required === false), 'panel allocations require the explicitly locked panel identity');
    return null;
  }
  const loaded = await loadPanelAssetPlan({ episodeDir });
  const expected = new Map(loaded.plan.beat_bindings.map(binding => {
    const order = loaded.plan.asset_orders.find(order => order.asset_id === binding.asset_id);
    const beat = loaded.beats.find(row => row.visual_beat_id === binding.beat_id);
    const owner = loaded.beats.find(row => row.visual_beat_id === order.owner_beat_id);
    return [beat.image_id_hint, { binding, beat, owner, alias: beat.visual_beat_id !== order.owner_beat_id }];
  }));
  need(allowSubset || prompts.length === expected.size, 'prompt allocation must cover every beat');
  const seen = new Set();
  for (const row of prompts) {
    const item = expected.get(row.image_id);
    need(item && !seen.has(row.image_id), `unexpected or duplicate prompt ${row.image_id}`); seen.add(row.image_id);
    need(row.visual_beat_id === item.binding.beat_id && row.panel_asset_id === item.binding.asset_id && row.panel_asset_plan_sha256 === loaded.planSha256, `stale prompt allocation ${row.image_id}`);
    need(row.image_generation_required === true, `every allocated beat requires a materialized image ${row.image_id}`);
    const order = loaded.plan.asset_orders.find(value => value.asset_id === item.binding.asset_id);
    need((row.panel_page_template ?? null) === (order.kind === 'page' ? order.page_template : null) && (row.panel_zone_id ?? null) === (item.binding.zone_id ?? null)
      && (row.panel_zone_slot ?? null) === (order.zones?.find(zone => zone.zone_id === item.binding.zone_id)?.slot ?? null)
      && JSON.stringify(row.panel_page_canvas ?? null) === JSON.stringify(order.kind === 'page' && order.canvas ? { width: order.canvas.width, height: order.canvas.height } : null), `page/zone allocation mismatch ${row.image_id}`);
    need(row.start_sec === item.beat.start_sec && row.duration_sec === (item.beat.duration_sec ?? item.beat.end_sec - item.beat.start_sec), `beat timing changed ${row.image_id}`);
    need(item.alias || row.image_strategy === 'fresh' && row.editorial_reuse_approved === false && !row.reuse_source_image_id, `owner must remain a unique provider order ${row.image_id}`);
    need(row.panel_asset_owner_image_id === item.owner.image_id_hint && row.provider_submission_required === !item.alias, `provider allocation mismatch ${row.image_id}`);
    need(!item.alias || row.editorial_reuse_approved === true && row.image_strategy === 'reuse_prior_approved' && row.reuse_source_image_id === item.owner.image_id_hint, `invalid donor binding ${row.image_id}`);
  }
  return loaded;
}

/** Alias source must already have an accepted, current provider result. No providers called. */
export async function materializePanelAssetAliases({ episodeDir, prompts, results, allowSubset = false, ownerImageIds = null }) {
  const loaded = await assertPanelPromptAllocation({ episodeDir, prompts, allowSubset });
  if (!loaded) return results;
  const byId = new Map(results.map(row => [row.image_id, row]));
  const selectedOwners = ownerImageIds == null ? null : new Set(ownerImageIds);
  for (const prompt of prompts.filter(row => row.provider_submission_required === false && (!selectedOwners || selectedOwners.has(row.reuse_source_image_id)))) {
    const donor = byId.get(prompt.reuse_source_image_id);
    if (!donor?.image_path || !['generated', 'cached', 'passed', 'imported', 'accepted', 'completed', 'reused', 'staged_import', 'manual_imported', 'reused_fresh', 'reused_imported_codex', 'existing_file'].includes(donor.status)) continue;
    const donorMetadata = await read(`${donor.image_path}.metadata.json`);
    need(donorMetadata.panel_asset_plan_sha256 === loaded.planSha256 && donorMetadata.panel_asset_id === prompt.panel_asset_id, `donor provenance changed ${donor.image_id}`);
    const sourceHash = await fileHash(donor.image_path);
    const expectedHash = donor.image_sha256 ?? donor.generated?.output_sha256 ?? donorMetadata.generated?.output_sha256 ?? donor.generated?.manual_source_sha256 ?? donorMetadata.source_staged_image_sha256;
    need(typeof expectedHash === 'string' && /^[a-f0-9]{64}$/.test(expectedHash) && sourceHash === expectedHash, `donor image changed or lacks its accepted hash ${donor.image_id}`);
    const imageDir = path.dirname(donor.image_path);
    const target = path.join(imageDir, `${prompt.image_id}${path.extname(donor.image_path) || '.png'}`);
    need(target !== donor.image_path, 'alias must not replace owner');
    const old = await fs.readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (old) need(sha(old) === sourceHash, `existing alias ${prompt.image_id} differs; use scoped recovery`);
    else await fs.copyFile(donor.image_path, target, 1);
    const reuseHash = sha(JSON.stringify({ source_image_id: donor.image_id, source_image_sha256: sourceHash, target_image_id: prompt.image_id, prompt_hash: prompt.prompt_hash, panel_asset_plan_sha256: loaded.planSha256 }));
    const metadata = { image_id: prompt.image_id, image_provider: 'editorial_reuse', editorial_reuse_approved: true, reuse_source_image_id: donor.image_id, source_image_path: donor.image_path, source_image_sha256: sourceHash, panel_asset_id: prompt.panel_asset_id, panel_asset_plan_sha256: loaded.planSha256, provider_submission_required: false, prompt_hash: reuseHash, source_prompt_hash: prompt.prompt_hash, updated_at: new Date().toISOString() };
    await fs.writeFile(`${target}.metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`);
    await fs.writeFile(`${target}.prompt.sha256`, `${reuseHash}\n`);
    byId.set(prompt.image_id, { image_id: prompt.image_id, status: 'editorial_reuse', image_path: target, image_sha256: sourceHash, prompt_hash: reuseHash, image_provider: 'editorial_reuse', panel_asset_id: prompt.panel_asset_id, panel_asset_plan_sha256: loaded.planSha256, generated: { ...metadata, estimated_cost_usd: 0 }, updated_at: new Date().toISOString() });
  }
  return prompts.map(row => byId.get(row.image_id)).filter(Boolean);
}

/** Rebuild only derivative aliases after an interrupted import, without provider work. */
export async function reconcilePanelAssetReport({ episodeDir, promptsPath, imagegenReportPath, cutExecutionLedgerPath }) {
  const promptPlan = await read(promptsPath);
  const allocation = await assertPanelPromptAllocation({ episodeDir, prompts: promptPlan.prompts ?? [] });
  if (!allocation) return { status: 'not_applicable', missing_owner_image_ids: [] };
  const ownerIds = (promptPlan.prompts ?? []).filter(row => row.provider_submission_required !== false).map(row => row.image_id);
  const report = await read(imagegenReportPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!report) return { status: 'partial', missing_owner_image_ids: ownerIds, materialized_alias_count: 0 };
  const promptPlanHash = await fileHash(promptsPath);
  need(report.prompt_plan_hash === promptPlanHash, 'alias reconciliation requires a current image report prompt-plan hash');
  const acceptedStatuses = new Set(['generated', 'reused_fresh', 'reused_imported_codex', 'existing_file', 'manual_imported', 'editorial_reuse', 'cached', 'passed', 'imported', 'accepted', 'completed', 'reused', 'staged_import']);
  const ledger = await read(cutExecutionLedgerPath);
  need(Array.isArray(ledger.cuts), 'existing cut execution ledger required for alias reconciliation');
  // Rebuilding aliases from page owners would silently revert reviewed zone repairs.
  need(!ledger.cuts.some(row => row.zone_repair), 'zone repairs are applied; alias reconciliation would revert them, so use scoped recovery');
  const promptById = new Map(promptPlan.prompts.map(row => [row.image_id, row]));
  const ledgerById = new Map(ledger.cuts.map(row => [row.image_id, row]));
  const accepted = [];
  for (const row of report.results ?? []) {
    if (!ownerIds.includes(row.image_id) || !acceptedStatuses.has(row.status) || !row.image_path) continue;
    const metadata = await read(`${row.image_path}.metadata.json`);
    const expected = row.image_sha256 ?? row.generated?.output_sha256 ?? metadata.generated?.output_sha256 ?? metadata.generated?.manual_source_sha256;
    need(expected && await fileHash(row.image_path) === expected, `owner output changed ${row.image_id}`);
    need(metadata.panel_asset_plan_sha256 === allocation.planSha256, `owner allocation changed ${row.image_id}`);
    const prompt = promptById.get(row.image_id), cut = ledgerById.get(row.image_id);
    const authoredHash = sha(JSON.stringify({ image_prompt: prompt.image_prompt ?? null, modelslab_image_prompt: prompt.modelslab_image_prompt ?? null, codex_image_prompt: prompt.codex_image_prompt ?? null, shot_manifest: prompt.shot_manifest ?? null, reference_requirements: prompt.reference_requirements ?? [] }));
    need(cut?.image_sha256 === expected && cut.authored_prompt_hash === authoredHash, `owner ledger or authored prompt is stale ${row.image_id}`);
    accepted.push(row);
  }
  const acceptedIds = new Set(accepted.map(row => row.image_id));
  const missingOwnerIds = ownerIds.filter(id => !acceptedIds.has(id));
  if (!accepted.length) return { status: 'partial', missing_owner_image_ids: missingOwnerIds, materialized_alias_count: 0 };
  const previousReportHash = await fileHash(imagegenReportPath);
  const results = await materializePanelAssetAliases({ episodeDir, prompts: promptPlan.prompts, results: accepted });
  for (const result of results.filter(row => row.status === 'editorial_reuse')) {
    const prompt = promptById.get(result.image_id);
    const prior = ledgerById.get(result.image_id);
    const owner = ledgerById.get(prompt.reuse_source_image_id);
    need(owner?.image_sha256 === result.image_sha256, `owner ledger is stale ${prompt.reuse_source_image_id}`);
    ledgerById.set(result.image_id, {
      ...owner, ...prior,
      image_id: prompt.image_id, scene_id: prompt.scene_id, visual_beat_id: prompt.visual_beat_id,
      start_sec: prompt.start_sec, duration_sec: prompt.duration_sec,
      beat_hash: sha(JSON.stringify({ scene_id: prompt.scene_id ?? null, visual_beat_id: prompt.visual_beat_id ?? null, start_sec: prompt.start_sec ?? null, duration_sec: prompt.duration_sec ?? null, visual_beat_script_excerpt: prompt.visual_beat_script_excerpt ?? null, visual_beat_action: prompt.visual_beat_action ?? null, visual_job: prompt.visual_job ?? null })),
      authored_prompt_hash: sha(JSON.stringify({ image_prompt: prompt.image_prompt ?? null, modelslab_image_prompt: prompt.modelslab_image_prompt ?? null, codex_image_prompt: prompt.codex_image_prompt ?? null, shot_manifest: prompt.shot_manifest ?? null, reference_requirements: prompt.reference_requirements ?? [] })),
      submitted_prompt_hash: result.prompt_hash, image_provider: 'editorial_reuse',
      editorial_reuse_approved: true, reuse_source_image_id: prompt.reuse_source_image_id,
      panel_asset_id: prompt.panel_asset_id, panel_asset_plan_sha256: allocation.planSha256,
      image_path: result.image_path, image_sha256: result.image_sha256, generation_status: 'editorial_reuse',
      image_qa_status: prior?.image_sha256 === result.image_sha256 ? prior.image_qa_status : 'pending',
      image_qa_note: prior?.image_sha256 === result.image_sha256 ? prior.image_qa_note : null,
    });
  }
  const missingCount = promptPlan.prompts.length - results.length;
  const status = missingCount === 0 ? 'passed' : 'partial';
  const reconciledAt = new Date().toISOString();
  const newReport = { ...report, status, episode_status: status, results, image_count: results.length, expected_image_count: promptPlan.prompts.length, missing_image_count: missingCount, panel_alias_reconciliation: { previous_report_sha256: previousReportHash, panel_asset_plan_sha256: allocation.planSha256, provider_calls: 0, cost_usd: 0, reconciled_at: reconciledAt }, updated_at: reconciledAt };
  const cuts = promptPlan.prompts.map(row => ledgerById.get(row.image_id)).filter(Boolean);
  const newLedger = { ...ledger, cuts, status, prompt_plan_hash: promptPlanHash, completed_image_count: results.length, pending_image_qa_count: cuts.filter(row => !String(row.image_qa_status ?? '').startsWith('passed')).length, updated_at: reconciledAt };
  const receiptDir = path.join(episodeDir, 'reports', 'panel_assets');
  await fs.mkdir(receiptDir, { recursive: true });
  await writeNew(path.join(receiptDir, `alias-reconcile-${randomUUID()}.json`), { schema: 'goldflow_panel_alias_reconciliation_v1', status, source_hashes: { [promptsPath]: promptPlanHash, [allocation.planPath]: allocation.planSha256, [imagegenReportPath]: previousReportHash }, previous_report: report, report: newReport, ledger: newLedger, provider_calls: 0, cost_usd: 0, created_at: reconciledAt });
  for (const [file, value] of [[cutExecutionLedgerPath, newLedger], [imagegenReportPath, newReport]]) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await fs.rename(temporary, file);
  }
  return { status, missing_owner_image_ids: missingOwnerIds, materialized_alias_count: results.filter(row => row.status === 'editorial_reuse').length };
}

export async function reconcilePanelAssetAliases({ episodeDir }) {
  const dir = await fs.realpath(episodeDir);
  const identity = await read(path.join(dir, 'run_identity.json'));
  assertPanelProductionIdentity(identity);
  return reconcilePanelAssetReport({
    episodeDir: dir,
    promptsPath: path.join(dir, 'section_image_prompts_hardened.json'),
    imagegenReportPath: path.join(dir, `imagegen_report_${identity.episode}.json`),
    cutExecutionLedgerPath: path.join(dir, 'cut_execution_ledger.json'),
  });
}
