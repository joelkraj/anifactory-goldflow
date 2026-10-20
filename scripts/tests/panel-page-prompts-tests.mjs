import assert from 'node:assert/strict';
import { pageFrameText, pagePanelHeadings, pagePromptFindings, PAGE_PLANNER_GUIDANCE } from '../lib/panel-page-prompts.mjs';
import { referenceBoardPromptGuidance, pageReferenceBoardPromptGuidance, PAGE_FRAME_BOARD_LINE, referenceBoardLayout } from '../lib/openart-reference-board.mjs';
import { buildCompactAuthorPromptForTests } from '../visual-plan.mjs';

let count = 0;
function test(name, run) { run(); count++; process.stdout.write(`ok - page prompts: ${name}\n`); }
const order = { asset_id: 'page_7', kind: 'page', page_template: 'P3L', zones: [] };
const authored = () => `${pageFrameText('P3L')}

A dim hospital room at night, cold window light. Joey (short black hair, pale-blue gown) and Elena (navy scrubs) are present.

Panel 1 (left): Joey sits up in bed staring at the settlement packet; Elena is not in this panel.
Panel 2 (right-top): Close-up of Elena's hand setting a pen on the tray; Joey is not in this panel.
Panel 3 (right-bottom): Joey's jaw tightens; no one else is in this panel.`;
const prompt = (overrides = {}) => ({ image_id: 'ep-cut-007', scene_id: 'scene_3', provider_prompt: authored(), reference_requirements: [{ ref_id: 'joey' }, { ref_id: 'elena' }, { ref_id: 'room' }], shot_manifest: { visible_characters: [{ name: 'Joey' }, { name: 'Elena' }] }, ...overrides });

test('page frames are fixed per template and name every panel', () => {
  for (const template of ['P2V', 'P2H', 'P3L', 'P4G', 'P3H', 'P4H', 'P5L', 'P6G']) assert.match(pageFrameText(template), /white gutters .* Keep the gutters and page edges free of any text/);
  assert.match(pageFrameText('P4G'), /divided into 4 fully separate/);
  assert.match(pageFrameText('P2V'), /no other figure resembles a named character\. Anonymous background people may fill public places/);
  assert.match(pageFrameText('P6G'), /divided into 6 fully separate/);
  assert.deepEqual(pagePanelHeadings({ page_template: 'P4H' }), ['Panel 1 (hero):', 'Panel 2 (right-top):', 'Panel 3 (right-middle):', 'Panel 4 (right-bottom):']);
  assert.deepEqual(pagePanelHeadings({ page_template: 'P4G' }), ['Panel 1 (top-left):', 'Panel 2 (top-right):', 'Panel 3 (bottom-left):', 'Panel 4 (bottom-right):']);
  assert.throws(() => pageFrameText('P5'), /unknown template/);
});

test('a well-formed page prompt has no findings; single orders are never checked', () => {
  assert.deepEqual(pagePromptFindings(prompt(), order), []);
  assert.deepEqual(pagePromptFindings({ provider_prompt: 'anything' }, { kind: undefined }), []);
  assert.deepEqual(pagePromptFindings({ provider_prompt: 'anything' }, null), []);
});

test('missing frame, sections, order, extras and caps are blocking findings', () => {
  const codes = value => pagePromptFindings(value, order).map(row => [row.code, row.production_blocking, row.severity]);
  assert.deepEqual(codes(prompt({ provider_prompt: authored().replace('straight solid white gutters', 'thin gutters') })), [['page_frame_missing', true, 'blocker']]);
  assert.deepEqual(codes(prompt({ provider_prompt: authored().replace('Panel 2 (right-top):', '') })), [['page_panel_sections_invalid', true, 'blocker']]);
  const swapped = authored().replace('Panel 2 (right-top):', '@@').replace('Panel 3 (right-bottom):', 'Panel 2 (right-top):').replace('@@', 'Panel 3 (right-bottom):');
  assert.deepEqual(codes(prompt({ provider_prompt: swapped })), [['page_panel_sections_invalid', true, 'blocker']]);
  assert.deepEqual(codes(prompt({ provider_prompt: `${authored()}\nPanel 4 (extra): a fourth view.` })), [['page_panel_sections_invalid', true, 'blocker']]);
  assert.deepEqual(codes(prompt({ reference_requirements: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(ref_id => ({ ref_id })) })), [['page_reference_cap', true, 'blocker']]);
  assert.deepEqual(codes(prompt({ shot_manifest: { visible_characters: ['Joey', 'Elena', 'Marcus', 'Vanessa', 'Richard'] } })).filter(row => row[0] !== 'page_cast_anchor_missing'), [['page_visible_people_cap', true, 'blocker']]);
});

test('the page board instruction replaces only the single-frame line', () => {
  const board = { panels: referenceBoardLayout([{ asset_id: 'a', asset_class: 'character_state' }, { asset_id: 'b', asset_class: 'location' }]).panels.map(({ x, y, width, height, role }) => ({ role, placement: { x, y, width, height } })) };
  const single = referenceBoardPromptGuidance(board), page = pageReferenceBoardPromptGuidance(board);
  assert.match(single, /Do not reproduce the board, borders, gutters/);
  assert.doesNotMatch(page, /Do not reproduce the board, borders, gutters/);
  assert.ok(page.includes(PAGE_FRAME_BOARD_LINE));
  assert.equal(page.replace(PAGE_FRAME_BOARD_LINE, ''), single.replace(/Create one coherent cinematic manhwa frame\.[^\n]*/, ''), 'identity rules and positional mapping are unchanged');
});

test('planner guidance appears only for requests containing page orders', () => {
  const build = scenes => buildCompactAuthorPromptForTests({ compactTimedPlan: { scenes }, compactSemanticPlan: {}, correctionDirectives: [], activeProvider: 'fal_ai', activeProviderOptions: {}, contentProfile: null });
  const withPage = build([{ panel_asset_order: { kind: 'page' } }]), without = build([{ panel_asset_order: { asset_id: 'a' } }]);
  assert.ok(withPage.includes(PAGE_PLANNER_GUIDANCE));
  assert.ok(!without.includes(PAGE_PLANNER_GUIDANCE));
  assert.equal(withPage.split(PAGE_PLANNER_GUIDANCE).length, 2, 'guidance appears exactly once');
});

test('dense pages size their lettering and keep small zones to one short text element', () => {
  assert.match(pageFrameText('P4G'), /one-fifth of its panel's width/);
  assert.doesNotMatch(pageFrameText('P2V'), /one-fifth/);
  const dense = { asset_id: 'page_9', kind: 'page', page_template: 'P4H' };
  const build = sections => `${pageFrameText('P4H')}\n\nA private hotel room.\n\n${pagePanelHeadings(dense).map((h, i) => `${h} ${sections[i]}`).join('\n')}`;
  const ok = ["A large card reading exactly 'BILL ERASED', '$20 MILLION A YEAR' and 'YOUR NAME ON A WING'.", 'Richard sits. A bubble reads exactly "That was too close."', 'Joey listens.', 'Richard stares.'];
  assert.deepEqual(pagePromptFindings({ image_id: 'x', provider_prompt: build(ok) }, dense), [], 'cards are allowed in the hero zone');
  const card = [ok[1], ok[2], ok[3], ok[0]];
  assert.deepEqual(pagePromptFindings({ image_id: 'x', provider_prompt: build(card) }, dense).map(row => row.code), ['page_lettering_policy']);
  const long = [ok[1], 'A bubble reads exactly "This is far too many words for a small zone."', ok[2], ok[3]];
  assert.match(pagePromptFindings({ image_id: 'x', provider_prompt: build(long) }, dense)[0].message, /over-long/);
});
test('every visible named person must be anchored in the page prompt; anonymous crowds need no anchor', () => {
  const base = prompt();
  assert.deepEqual(pagePromptFindings({ ...base, shot_manifest: { visible_characters: ['Joey', 'Elena', 'Anonymous gala guests'] } }, order), []);
  assert.deepEqual(pagePromptFindings({ ...base, shot_manifest: { visible_characters: ['Joey', 'Marcus Hale'] } }, order).map(row => row.code), ['page_cast_anchor_missing']);
});
process.stdout.write(`Panel page prompts: ${count} test groups passed.\n`);
