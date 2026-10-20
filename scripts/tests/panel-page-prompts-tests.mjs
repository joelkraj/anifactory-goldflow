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
  for (const template of ['P2V', 'P2H', 'P3L', 'P4G']) assert.match(pageFrameText(template), /white gutters .* No captions, speech bubbles/);
  assert.match(pageFrameText('P4G'), /divided into 4 fully separate/);
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
  assert.deepEqual(codes(prompt({ reference_requirements: ['a', 'b', 'c', 'd', 'e'].map(ref_id => ({ ref_id })) })), [['page_reference_cap', true, 'blocker']]);
  assert.deepEqual(codes(prompt({ shot_manifest: { visible_characters: ['Joey', 'Elena', 'Marcus', 'Vanessa'] } })), [['page_visible_people_cap', true, 'blocker']]);
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

process.stdout.write(`Panel page prompts: ${count} test groups passed.\n`);
