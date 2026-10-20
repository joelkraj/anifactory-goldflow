import { PAGE_TEMPLATES } from './panel-page-geometry.mjs';

// Fixed, never-paraphrased page frames. The planner authors only the shared
// context and the per-panel content; these sentences carry the geometry the
// gutter detector later measures against.
const GEOMETRY = Object.freeze({
  P2V: 'Two side-by-side panels of equal width: a left panel and a right panel.',
  P2H: 'Two full-width panels of equal height stacked vertically: a top panel and a bottom panel.',
  P3L: 'Three panels: a full-height left panel filling the left half, and on the right half a top panel above a bottom panel of equal height.',
  P4G: 'Four panels of equal size in a two-by-two grid: top-left, top-right, bottom-left and bottom-right.',
});
export const PAGE_LIMITS = Object.freeze({ max_references: 4, max_visible_people: 3 });

const need = (value, message) => { if (!value) throw new Error(`Page prompt: ${message}`); };
export const pageSlotLabel = slot => String(slot).replaceAll('_', '-');

export function pageFrameText(template) {
  need(PAGE_TEMPLATES[template] && GEOMETRY[template], `unknown template ${template}`);
  const count = PAGE_TEMPLATES[template].length;
  return `One 16:9 landscape anime/manhwa page divided into ${count} fully separate rectangular panels by straight solid white gutters of equal width that run edge to edge. ${GEOMETRY[template]} Nothing (no limb, hair, prop, light streak, effect or lettering) crosses a gutter. Keep the gutters and page edges free of any text; add a caption or thought bubble only where a panel section explicitly asks for it, entirely inside that panel.`;
}

/** The required "Panel k (slot):" headings, in the template's reading order. */
export function pagePanelHeadings(order) {
  const slots = PAGE_TEMPLATES[order.page_template].map(zone => zone.slot);
  return slots.map((slot, i) => `Panel ${i + 1} (${pageSlotLabel(slot)}):`);
}

/** Planner guidance for page owners; the order supplies its page_frame and zones. */
export const PAGE_PLANNER_GUIDANCE = '- If panel_asset_order.kind is page, author ONE provider_prompt for the whole page: begin with its page_frame verbatim; then one shared-context paragraph (location, time, lighting, palette and who is present with identity and wardrobe anchors); then exactly one section per zone in the listed order, headed exactly as in panel_headings, drawn from that zone\'s visual_brief and bound beats. Each section names who is in that panel and who is not, and gives the panel its own drawable subject. Attach references for the whole page (at most four) and show at most three distinct people on the page. Add text or bubbles only inside the panel whose section asks for them, never in gutters; add no extra panels.';

function visiblePeople(prompt) {
  const names = (prompt.shot_manifest?.visible_characters ?? []).map(row => String(row?.name ?? row ?? '').trim().toLowerCase()).filter(Boolean);
  return new Set(names);
}

/** Structural page checks run during hardening; every finding blocks dispatch. */
export function pagePromptFindings(prompt, order) {
  if (order?.kind !== 'page') return [];
  const finding = (code, message) => ({ image_id: prompt.image_id, scene_id: prompt.scene_id, severity: 'blocker', production_blocking: true, code, message, resolved: false });
  const findings = [], text = String(prompt.provider_prompt ?? prompt.image_prompt ?? '').trim();
  const frame = pageFrameText(order.page_template), headings = pagePanelHeadings(order);
  if (!text.startsWith(frame)) findings.push(finding('page_frame_missing', `Page ${order.asset_id} must begin with its exact ${order.page_template} page frame.`));
  const positions = headings.map(heading => text.indexOf(heading));
  const extra = (text.match(/\bPanel \d+ \(/g) ?? []).length !== headings.length;
  if (positions.some(index => index < 0) || positions.some((index, i) => i > 0 && index <= positions[i - 1]) || extra) {
    findings.push(finding('page_panel_sections_invalid', `Page ${order.asset_id} needs exactly these panel sections in order: ${headings.join(' ')}`));
  }
  const refs = new Set((prompt.reference_requirements ?? prompt.reference_slots ?? []).map(row => row.ref_id));
  if (refs.size > PAGE_LIMITS.max_references) findings.push(finding('page_reference_cap', `Page ${order.asset_id} attaches ${refs.size} references; at most ${PAGE_LIMITS.max_references} are allowed.`));
  const people = visiblePeople(prompt);
  if (people.size > PAGE_LIMITS.max_visible_people) findings.push(finding('page_visible_people_cap', `Page ${order.asset_id} shows ${people.size} distinct people; at most ${PAGE_LIMITS.max_visible_people} are allowed on one page.`));
  return findings;
}
