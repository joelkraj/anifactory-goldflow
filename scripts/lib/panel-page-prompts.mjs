import { PAGE_TEMPLATES } from './panel-page-geometry.mjs';

// Fixed, never-paraphrased page frames. The planner authors only the shared
// context and the per-panel content; these sentences carry the geometry the
// gutter detector later measures against.
const GEOMETRY = Object.freeze({
  P2V: 'Two side-by-side panels of equal width: a left panel and a right panel.',
  P2H: 'Two full-width panels of equal height stacked vertically: a top panel and a bottom panel.',
  P3L: 'Three panels: a full-height left panel filling the left half, and on the right half a top panel above a bottom panel of equal height.',
  P4G: 'Four panels of equal size in a two-by-two grid: top-left, top-right, bottom-left and bottom-right.',
  P3H: 'Three panels: a large full-height hero panel filling the left two-thirds, and in the right third a top panel above a bottom panel of equal height.',
  P4H: 'Four panels: a large full-height hero panel filling the left two-thirds, and in the right third three stacked panels of equal height (top, middle, bottom).',
  P5L: 'Five panels: a full-height left panel filling the left half, and on the right half a two-by-two grid of four equal panels (top-left, top-right, bottom-left, bottom-right of that half).',
  P6G: 'Six panels of equal size in a three-by-two grid: top-left, top-center, top-right, bottom-left, bottom-center and bottom-right.',
});
export const PAGE_LIMITS = Object.freeze({ max_references: 6, max_visible_people: 4 });
// Dense-page lettering (gala dense proof: three garbles, all in small zones).
// Text stays baked into the art (narrative-overlay policy), so dense pages get
// a size directive, small zones carry at most one short text element, and
// multi-line cards belong only in a large zone. Review still reads every word.
export const PAGE_LETTERING_POLICY = Object.freeze({ dense_min_zones: 4, max_words: 6, max_chars: 32, large_slots: Object.freeze(['hero', 'left']) });
// Cast rule (dense proof: an unrequested runner resembling Joey, an
// unrequested wall sign). Named characters are exact; anonymous background
// population stays welcome so public places never feel hollow.
const CAST_RULE = 'Named characters appear only in the panels that name them, and no other figure resembles a named character. Anonymous background people may fill public places where a panel implies them; they stay passive, take no story action, and look clearly different from the named cast. Add no signs, labels or other text a panel does not request.';
const LETTERING_SIZE = 'Every requested caption or thought bubble is large, bold and mobile-readable: at least one-fifth of its panel\'s width with generous padding, and every word is spelled exactly once.';

const need = (value, message) => { if (!value) throw new Error(`Page prompt: ${message}`); };
export const pageSlotLabel = slot => String(slot).replaceAll('_', '-');

export function pageFrameText(template) {
  need(PAGE_TEMPLATES[template] && GEOMETRY[template], `unknown template ${template}`);
  const count = PAGE_TEMPLATES[template].length;
  const lettering = count >= PAGE_LETTERING_POLICY.dense_min_zones ? ` ${LETTERING_SIZE}` : '';
  return `One 16:9 landscape anime/manhwa page divided into ${count} fully separate rectangular panels by straight solid white gutters of equal width that run edge to edge. ${GEOMETRY[template]} Nothing (no limb, hair, prop, light streak, effect or lettering) crosses a gutter. Keep the gutters and page edges free of any text; add a caption or thought bubble only where a panel section explicitly asks for it, entirely inside that panel. ${CAST_RULE}${lettering}`;
}

/** The required "Panel k (slot):" headings, in the template's reading order. */
export function pagePanelHeadings(order) {
  const slots = PAGE_TEMPLATES[order.page_template].map(zone => zone.slot);
  return slots.map((slot, i) => `Panel ${i + 1} (${pageSlotLabel(slot)}):`);
}

/** Planner guidance for page owners; the order supplies its page_frame and zones. */
export const PAGE_PLANNER_GUIDANCE = '- If panel_asset_order.kind is page, author ONE provider_prompt for the whole page: begin with its page_frame verbatim; then one shared-context paragraph (location, time, lighting, palette and who is present with identity and wardrobe anchors); then exactly one section per zone in the listed order, headed exactly as in panel_headings, drawn from that zone\'s visual_brief and bound beats. Each section names who is in that panel and who is not, and gives the panel its own drawable subject. Attach references for the whole page (at most six) and show at most four distinct people on the page; give every person their identity anchor in the shared context. Add text or bubbles only inside the panel whose section asks for them, never in gutters; add no extra panels.';

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
  if (headings.length >= PAGE_LETTERING_POLICY.dense_min_zones && positions.every(index => index >= 0)) {
    const slots = PAGE_TEMPLATES[order.page_template].map(zone => zone.slot);
    positions.forEach((start, i) => {
      const section = text.slice(start, i + 1 < positions.length ? positions[i + 1] : text.length);
      const elements = [...section.matchAll(/(?:reads|reading|read) exactly\s+(["'\u201c])(.*?)\1(?=[\s.,;:]|$)((?:,?\s*(?:and\s+)?(["'\u201c])[^"'\u201d]*?\4(?=[\s.,;:]|$))*)/g)].flatMap(match => [match[2], ...(match[3] ? [...match[3].matchAll(/(["'\u201c])(.*?)\1(?=[\s.,;:]|$)/g)].map(row => row[2]) : [])]);
      const large = PAGE_LETTERING_POLICY.large_slots.includes(slots[i]);
      const long = elements.filter(value => value.split(/\s+/).filter(Boolean).length > PAGE_LETTERING_POLICY.max_words || value.length > PAGE_LETTERING_POLICY.max_chars);
      if ((!large && elements.length > 1) || (!large && long.length)) findings.push(finding('page_lettering_policy', `${headings[i]} in dense page ${order.asset_id} carries ${elements.length} text element(s)${long.length ? ` including over-long ${JSON.stringify(long)}` : ''}; small zones allow one element of at most ${PAGE_LETTERING_POLICY.max_words} words and ${PAGE_LETTERING_POLICY.max_chars} characters. Put cards in a large zone.`));
    });
  }
  const people = visiblePeople(prompt);
  // Every visible named person needs an identity anchor in the prompt text.
  const lower = text.toLowerCase();
  const unanchored = [...people].filter(name => !/^(anonymous|unnamed|gala guests|attending|local news)/.test(name) && !name.split(/\s+/).filter(word => word.length >= 4).some(word => lower.includes(word)));
  if (unanchored.length) findings.push(finding('page_cast_anchor_missing', `Page ${order.asset_id} shows ${unanchored.join(', ')} without an identity anchor in the prompt.`));
  if (people.size > PAGE_LIMITS.max_visible_people) findings.push(finding('page_visible_people_cap', `Page ${order.asset_id} shows ${people.size} distinct people; at most ${PAGE_LIMITS.max_visible_people} are allowed on one page.`));
  return findings;
}
