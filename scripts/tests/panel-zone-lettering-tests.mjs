import assert from 'node:assert/strict';
import { letteringFindings } from '../lib/panel-zone-lettering.mjs';
import { zoneRequestedLettering } from '../lib/panel-page-prompts.mjs';

let count = 0;
function test(name, run) { run(); count++; console.log(`ok - zone lettering: ${name}`); }
// Word rows as tesseract reports them on the gala proof crops: text(conf @left,top hHeight).
const w = (text, conf, left, top, height = 30) => ({ text, conf, box: { left, top, width: text.length * 15, height } });
const codes = (requested, words) => letteringFindings({ requested, words }).map(row => row.code);

test('the three real gala garbles are flagged', () => {
  assert.deepEqual(codes(['No more looking down.'], [w('No', 97, 125, 60), w('more', 97, 182, 66), w('looking', 96, 276, 59), w('dowrg', 86, 159, 101), w('down.', 97, 263, 101), w('tie', 32, 636, 53)]), ['zone_lettering_garbled']);
  assert.deepEqual(codes(['APPOINTMENT PENDING'], [w('APPOINTMENT', 95, 100, 40), w('PENDING', 1.6, 300, 40), w('PENDING', 96, 420, 40), w('A', 49, 600, 300)]), ['zone_lettering_garbled'], 'a near-zero-confidence doubled word still counts');
  assert.deepEqual(codes(["I'd queue again."], [w("I'd", 92, 133, 85), w('queue', 96, 198, 96), w('agian.', 56, 323, 87, 39), w('aaain.', 19, 216, 132, 31)]), ['zone_lettering_garbled']);
});

test('a doubled word OCR splits into fragments is re-joined and flagged', () => {
  const words = [{ text: '"BORROWED', conf: 71, box: { left: 60, top: 55, width: 270, height: 61 } }, { text: 'RANK', conf: 67, box: { left: 374, top: 46, width: 160, height: 70 } },
    { text: 'R', conf: 47, box: { left: 210, top: 133, width: 15, height: 30 } }, { text: 'AINK', conf: 83, box: { left: 239, top: 134, width: 105, height: 28 } }];
  assert.deepEqual(codes(['BORROWED RANK'], words), ['zone_lettering_garbled']);
});

test('clean bubbles, OCR misreads and distant art noise are not garbles', () => {
  assert.deepEqual(codes(['Why the sudden hush?'], [w('Why', 96, 100, 50), w('the', 96, 170, 50), w('y/', 49, 230, 50), w('Y', 78, 260, 50), w('sudden', 96, 290, 50), w('hush?', 96, 400, 50)]), []);
  assert.deepEqual(codes(['What else did I miss?'], [w('What', 97, 708, 65), w('el:', 95, 759, 65), w('did', 69, 717, 97, 16), w('|', 69, 750, 97, 16), w('miss?', 94, 761, 97, 16)]), [], 'a same-count substitution is an OCR misread');
  assert.deepEqual(codes(['Stay with me.'], [w('Stay', 97, 476, 51, 19), w('with', 97, 523, 51, 14), w('me.', 95, 570, 55, 10), w('me,', 31, 814, 109, 16)]), [], 'a far echo is not part of the bubble');
  assert.deepEqual(codes(['They still need answers.'], [w('They', 97, 1008, 111, 38), w('still', 97, 1114, 111), w('Vs)', 70, 681, 138, 19), w('need', 96, 958, 161, 32), w('answers.', 96, 1066, 170, 23)]), []);
});

test('missing text is reported as unread, never as garbled', () => {
  assert.deepEqual(codes(['Still beneath me.'], [w('A', 40, 10, 10)]), ['zone_lettering_unread']);
});

test('requested lettering is read from the zone section of the page prompt', () => {
  const prompt = "Frame.\n\nPanel 1 (hero): No lettering in this panel.\nPanel 2 (right-top): A panel reads exactly 'APPOINTMENT PENDING'.\nPanel 3 (right-middle): A bubble reads exactly \"Still beneath me.\"\n\nThe input is a reference board.";
  assert.deepEqual([zoneRequestedLettering(prompt, 'hero'), zoneRequestedLettering(prompt, 'right_top'), zoneRequestedLettering(prompt, 'right_middle'), zoneRequestedLettering(prompt, 'left')], [[], ['APPOINTMENT PENDING'], ['Still beneath me.'], null]);
});
console.log(`Zone lettering: ${count} test groups passed.`);
