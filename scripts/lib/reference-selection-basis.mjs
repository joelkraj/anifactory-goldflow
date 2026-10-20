// Reference selection basis for panel-composition runs (follow-up 9,
// conservative rule; docs/designs/reference_trimming_dense_measurement_v1.md).
// Dense pages carry several beats per generation, so a reference used on only
// one or two beats is usually held by the page prompt text. The director still
// selects every target; code only checks the basis it records and never
// prunes, downgrades or restores a target.
export const REFERENCE_SELECTION_RULE = Object.freeze({ id: 'panel_reference_selection_v1', min_uses: 3, identity_base_min_scenes: 2, min_exception_reason_chars: 20 });
export const REFERENCE_SELECTION_BASES = Object.freeze(['cross_use', 'identity_base', 'director_exception']);

export const PANEL_REFERENCE_SELECTION_GUIDANCE = `- PANEL SELECTION BASIS (this run composes dense multi-beat pages; it overrides the two-beat/two-scene recurrence guidance above): every standalone_ref must record a selection_basis.
  - cross_use: planned_beat_ids reach at least ${REFERENCE_SELECTION_RULE.min_uses} beats.
  - identity_base: the clean base identity plate of a named character whose selected states together appear in at least ${REFERENCE_SELECTION_RULE.identity_base_min_scenes} scenes (no base_asset_id of its own). Keep one per recurring named person so wardrobe and condition states re-anchor on it.
  - director_exception: a target under ${REFERENCE_SELECTION_RULE.min_uses} uses that you still judge necessary (body contact with a recurring protagonist, an identity shown in the first 30 seconds, a story-critical prop or UI). Give selection_exception_reason in one concrete sentence.
  Otherwise omit the target: a reference used on one or two beats is carried by the page prompt's description.`;

const kindOf = target => String(target?.kind ?? '').toLowerCase();
const beatsOf = target => [...new Set((target?.planned_beat_ids ?? []).map(String))];

/** Recompute the facts a basis claims, from the targets and the beat plan only. */
export function referenceSelectionFacts(targets, beats) {
  const sceneOf = new Map((beats ?? []).map(beat => [String(beat.visual_beat_id), String(beat.scene_id ?? beat.parent_scene_id ?? '')]));
  const scenesOf = target => new Set(beatsOf(target).map(id => sceneOf.get(id)).filter(Boolean));
  const subjectScenes = new Map();
  for (const target of targets ?? []) {
    if (!kindOf(target).startsWith('character') || String(target.generation_mode) !== 'standalone_ref') continue;
    const key = String(target.canonical_subject_id ?? target.ref_id);
    const set = subjectScenes.get(key) ?? new Set();
    for (const scene of scenesOf(target)) set.add(scene);
    subjectScenes.set(key, set);
  }
  return new Map((targets ?? []).map(target => {
    const subject = String(target.canonical_subject_id ?? target.ref_id);
    const identityBase = kindOf(target).startsWith('character') && !target.base_asset_id && (subjectScenes.get(subject)?.size ?? 0) >= REFERENCE_SELECTION_RULE.identity_base_min_scenes;
    return [target.ref_id, { uses: beatsOf(target).length, scenes: scenesOf(target).size, subject_scenes: subjectScenes.get(subject)?.size ?? 0, identity_base: identityBase }];
  }));
}

/** Blocks a missing or false basis (the director re-authors); exceptions stay visible for review. */
export function referenceSelectionBasisFindings(targets, beats) {
  const facts = referenceSelectionFacts(targets, beats), findings = [];
  const finding = (target, code, severity, message, extra = {}) => findings.push({ code, severity, production_blocking: severity === 'blocker', review_required: true, review_disposition: 'director_must_reauthor_selection_basis', ref_id: target.ref_id, rule: REFERENCE_SELECTION_RULE.id, facts: facts.get(target.ref_id), message, ...extra });
  for (const target of targets ?? []) {
    if (String(target.generation_mode) !== 'standalone_ref') continue;
    const fact = facts.get(target.ref_id), basis = target.selection_basis;
    if (!REFERENCE_SELECTION_BASES.includes(basis)) { finding(target, 'reference_selection_basis_missing', 'blocker', `${target.ref_id} needs selection_basis (${REFERENCE_SELECTION_BASES.join(' | ')}).`); continue; }
    if (basis === 'cross_use' && fact.uses < REFERENCE_SELECTION_RULE.min_uses) finding(target, 'reference_selection_basis_false', 'blocker', `${target.ref_id} claims cross_use but plans ${fact.uses} beat(s); at least ${REFERENCE_SELECTION_RULE.min_uses} are required.`);
    if (basis === 'identity_base' && !fact.identity_base) finding(target, 'reference_selection_basis_false', 'blocker', `${target.ref_id} claims identity_base but is not a base character plate whose subject spans ${REFERENCE_SELECTION_RULE.identity_base_min_scenes}+ scenes.`);
    if (basis === 'director_exception') {
      const reason = String(target.selection_exception_reason ?? '').trim();
      if (reason.length < REFERENCE_SELECTION_RULE.min_exception_reason_chars) finding(target, 'reference_selection_basis_false', 'blocker', `${target.ref_id} is a director_exception without a concrete selection_exception_reason.`);
      else finding(target, 'reference_selection_exception', 'warning', `${target.ref_id} is kept under ${REFERENCE_SELECTION_RULE.min_uses} uses by director exception: ${reason}`, { reason });
    }
  }
  return findings;
}

/** Counts for the plan report. */
export function referenceSelectionSummary(targets, beats) {
  const facts = referenceSelectionFacts(targets, beats), standalone = (targets ?? []).filter(target => String(target.generation_mode) === 'standalone_ref');
  const by = basis => standalone.filter(target => target.selection_basis === basis).length;
  return { rule: REFERENCE_SELECTION_RULE.id, standalone_count: standalone.length, cross_use: by('cross_use'), identity_base: by('identity_base'), director_exception: by('director_exception'), under_min_uses: standalone.filter(target => facts.get(target.ref_id).uses < REFERENCE_SELECTION_RULE.min_uses).length };
}
