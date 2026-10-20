import { PAGE_TEMPLATES, PAGE_TEMPLATE_MIN_CANVAS_WIDTH } from './panel-page-geometry.mjs';
import { PAGE_LIMITS } from './panel-page-prompts.mjs';

// Allocation-time constraints for dense pages. Each beat's generated
// references come from the approved reference plan (targets list the exact
// beats they serve); its named people and location come from the beat plan.
// These checks advise the allocation author before any prompt or image work;
// the official allocation validator still checks structure only.
export const DENSE_ALLOCATION_TARGET = Object.freeze({ beats_per_generation: 5, canvas: Object.freeze({ width: 3840, height: 2160 }) });

const named = value => String(value?.name ?? value ?? '').trim();
const anonymous = name => /^(anonymous|unnamed|gala guests|attending|local news|crowd|guests|attendees)/i.test(name);

/** Per-beat references (generated targets only), named people, location and scene. */
export function beatAllocationConstraints({ beats, referencePlan }) {
  const refsByBeat = new Map(), groupsByBeat = new Map();
  for (const target of referencePlan?.reference_targets ?? []) {
    if (target.generation_mode !== 'standalone_ref') continue;
    // One reference per person (any of their states) and one per location is
    // the minimum a page needs; other states and props are optional choices.
    const kind = String(target.kind ?? '');
    const group = kind.startsWith('character') ? `person:${target.canonical_subject_id ?? target.ref_id}` : kind === 'location' ? `location:${target.ref_id}` : null;
    for (const beatId of target.planned_beat_ids ?? []) {
      if (!refsByBeat.has(beatId)) { refsByBeat.set(beatId, new Set()); groupsByBeat.set(beatId, new Set()); }
      refsByBeat.get(beatId).add(target.ref_id);
      if (group) groupsByBeat.get(beatId).add(group);
    }
  }
  return new Map(beats.map(beat => [beat.visual_beat_id, {
    beat_id: beat.visual_beat_id,
    scene_id: beat.scene_id ?? beat.parent_scene_id ?? null,
    location_id: beat.location_id ?? null,
    refs: [...(refsByBeat.get(beat.visual_beat_id) ?? [])].sort(),
    required_ref_groups: [...(groupsByBeat.get(beat.visual_beat_id) ?? [])].sort(),
    people: [...new Set((beat.visible_characters ?? []).map(named).filter(name => name && !anonymous(name)))].sort(),
    duration_sec: Number(beat.duration_sec ?? (beat.end_sec - beat.start_sec)) || 0,
  }]));
}

/** Advisory/blocking findings for page orders against the dense caps. */
export function denseAllocationFindings(plan, constraints, { maxReferences = PAGE_LIMITS.max_references, maxPeople = PAGE_LIMITS.max_visible_people } = {}) {
  const findings = [];
  for (const order of plan.asset_orders ?? []) {
    if (order.kind !== 'page') continue;
    const rows = order.beat_ids.map(id => constraints.get(id)).filter(Boolean);
    const refs = new Set(rows.flatMap(row => row.refs)), required = new Set(rows.flatMap(row => row.required_ref_groups ?? [])), people = new Set(rows.flatMap(row => row.people));
    const locations = new Set(rows.map(row => row.location_id).filter(Boolean));
    if (required.size > maxReferences) findings.push({ code: 'page_required_references_over_cap', severity: 'blocker', asset_id: order.asset_id, detail: [...required].sort(), message: `${order.asset_id} needs ${required.size} people/location references; the cap is ${maxReferences}.` });
    else if (refs.size > maxReferences) findings.push({ code: 'page_reference_selection_needed', severity: 'warning', asset_id: order.asset_id, detail: [...refs].sort(), message: `${order.asset_id} has ${refs.size} candidate references; prompt planning must choose at most ${maxReferences}.` });
    if (people.size > maxPeople) findings.push({ code: 'page_people_over_cap', severity: 'blocker', asset_id: order.asset_id, detail: [...people].sort(), message: `${order.asset_id} shows ${people.size} named people; the cap is ${maxPeople}.` });
    if (locations.size > 1) findings.push({ code: 'page_mixed_locations', severity: 'warning', asset_id: order.asset_id, detail: [...locations].sort(), message: `${order.asset_id} spans locations ${[...locations].join(', ')}; keep it only for deliberate memory or insert panels.` });
    const canvasWidth = order.canvas?.width ?? 1920;
    if (PAGE_TEMPLATES[order.page_template] && canvasWidth < PAGE_TEMPLATE_MIN_CANVAS_WIDTH[order.page_template]) findings.push({ code: 'page_canvas_too_small', severity: 'blocker', asset_id: order.asset_id, message: `${order.page_template} needs a canvas at least ${PAGE_TEMPLATE_MIN_CANVAS_WIDTH[order.page_template]} wide.` });
  }
  return findings;
}

/** Density summary used to judge an allocation against the ~5 beats per image target. */
export function allocationDensity(plan, beatCount) {
  const generations = (plan.asset_orders ?? []).length;
  const pages = (plan.asset_orders ?? []).filter(order => order.kind === 'page');
  return {
    generations, pages: pages.length, singles: generations - pages.length,
    zones: pages.reduce((n, order) => n + order.zones.length, 0),
    beats: beatCount, beats_per_generation: generations ? Math.round(beatCount / generations * 100) / 100 : null,
    templates: Object.fromEntries([...new Set(pages.map(order => order.page_template))].map(id => [id, pages.filter(order => order.page_template === id).length])),
  };
}
