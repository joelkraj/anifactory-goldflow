import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateEditorialPacket, editorialContentSha256} from '../crime-editorial-review.mjs';

// Synthetic paper-edit fixtures only. No actual source, viewing or approval claim.
const fixture = () => { const packet = {
  schema: 'crimedungeon_editorial_packet_v1',
  package: {
    title: 'Why the two clocks disagreed', premise: 'Compare two displayed clocks.',
    viewer_question: 'Were these recordings simultaneous?', promised_answer: 'Explain the documented clock offset.',
    thumbnail_moment: 'The two authentic clock displays, labeled as a synthetic fixture.'
  },
  sources: [{
    id: 'V01', url: 'https://example.org/synthetic-source', in_sec: 20, out_sec: 40,
    context_before: 'Fixture introduces the two cameras.', context_after: 'Fixture explains a clock setting.',
    claim_supported: 'The displayed clocks have different settings.', picture_origin: 'synthetic fixture',
    audio_origin: 'synthetic fixture', use_basis: 'Locally authored test description; no acquired media.'
  }],
  beats: [
    {id: 'B01', start_sec: 0, end_sec: 6, question: 'Why do these clock readings differ?', source_ids: ['V01'], mode: 'source_scene', picture_action: 'Show both displays.', audio_action: 'Play the selected exchange.', what_changes: 'The apparent difference is visible.', payoff_for: [], next_question: 'What was each clock set to?'},
    {id: 'B02', start_sec: 6, end_sec: 14, question: 'What explains the difference?', source_ids: ['V01'], mode: 'document', picture_action: 'Reveal the recorded offset.', audio_action: 'Brief narrator explanation.', what_changes: 'The offset accounts for the displayed difference.', payoff_for: ['B01'], next_question: 'No further question; close the local comparison.'}
  ],
  opening: {question_by_sec: 4, first_payoff_beat_id: 'B02', package_connection: 'The opening shows the two clocks promised by the title.'},
  references: [{url: 'https://example.org/synthetic-reference', in_sec: 4, out_sec: 12, observed: 'Synthetic example of a side-by-side comparison.', method: 'automated_analysis', application: 'Consider a comparison layout; direct playback has not been performed.'}],
  review: {reviewer: 'Synthetic fixture', method: 'paper_edit', package_alignment: 'pass', source_context: 'pass', payoffs: 'pass', media_motivation: 'pass', factual_limits: 'pass', decision: 'ready_for_candidate', notes: 'Exercises declared review completion only. No real-case review.', reviewed_content_sha256: null}
}; packet.review.reviewed_content_sha256 = editorialContentSha256(packet); return packet; };

let assertions = 0;
function check(condition, message) { assert.ok(condition, message); assertions++; }
const valid = validateEditorialPacket(fixture());
check(valid.structurally_valid && valid.ready_for_candidate, 'A completed synthetic declaration should pass the structural preparation check.');
check(valid.approval_granted === false, 'Preparation never grants approval.');
assert.deepEqual(valid.reference_method_counts, {automated_analysis: 1}); assertions++;
check(valid.limitations.some(value => value.includes('not direct viewing/listening')), 'Automated analysis must not become firsthand evidence.');

for (const [name, change, expected] of [
  ['missing source context', p => delete p.sources[0].context_after, /context_after/],
  ['blank package', p => p.package.promised_answer = ' \n ', /promised_answer/],
  ['blank change', p => p.beats[1].what_changes = '', /what_changes/],
  ['blank review', p => p.review.notes = ' ', /review.notes/],
  ['missing review', p => delete p.review, /review/],
  ['empty sources', p => p.sources = [], /sources/],
  ['empty references', p => p.references = [], /references/],
  ['empty beats', p => p.beats = [], /beats/],
  ['wrong list shape', p => p.beats[0].payoff_for = {}, /payoff_for/],
  ['negative start', p => p.sources[0].in_sec = -1, /finite nonnegative/],
  ['nonfinite value', p => p.beats[0].end_sec = Infinity, /finite nonnegative/],
  ['reversed window', p => p.sources[0].out_sec = 19, /greater than/],
  ['zero-length beat', p => p.beats[1].end_sec = 6, /greater than/],
  ['gap', p => p.beats[1].start_sec = 6.101, /contiguous/],
  ['overlap', p => p.beats[1].start_sec = 5.8, /contiguous/],
  ['late start', p => p.beats[0].start_sec = 0.2, /begin at zero/],
  ['nonincreasing beat', p => { p.beats[1].start_sec = 0; p.beats[1].end_sec = 5; }, /must increase/],
  ['unknown source', p => p.beats[0].source_ids = ['missing'], /unknown source/],
  ['missing source link', p => p.beats[0].source_ids = [], /must not be empty/],
  ['duplicate id', p => p.beats[1].id = 'B01', /duplicate id/],
  ['source/beat id collision', p => p.beats[0].id = 'V01', /duplicate id/],
  ['duplicate source ref', p => p.beats[0].source_ids.push('V01'), /duplicate reference/],
  ['future payoff', p => { p.beats[0].payoff_for = ['B02']; p.opening.first_payoff_beat_id = 'B01'; }, /future beat/],
  ['unknown payoff', p => p.beats[1].payoff_for = ['missing'], /unknown beat/],
  ['no linked opening payoff', p => p.beats[1].payoff_for = [], /must link a payoff/],
  ['later claimed first payoff', p => p.beats[0].payoff_for = ['B01'], /earliest linked payoff/],
  ['late question', p => p.opening.question_by_sec = 15, /no later than/],
  ['missing payoff target', p => p.opening.first_payoff_beat_id = 'missing', /unknown beat/],
  ['narration opening', p => p.beats[0].mode = 'narration_bridge', /opening must/],
  ['invented method', p => p.references[0].method = 'probably_watched', /expected one of/],
  ['invalid review value', p => p.review.payoffs = true, /review.payoffs/],
  ['unknown field', p => p.review.approved = true, /unknown field/],
  ['missing reviewed hash', p => delete p.review.reviewed_content_sha256, /reviewed_content_sha256/],
  ['malformed reviewed hash', p => p.review.reviewed_content_sha256 = 'ABC123', /reviewed_content_sha256/],
  ['credential URL', p => p.sources[0].url = 'https://secret@example.org/a', /without credentials/],
  ['nonweb URL', p => p.references[0].url = 'file:///tmp/source', /http\(s\)/]
]) {
  const packet = fixture(); change(packet);
  const result = validateEditorialPacket(packet);
  check(!result.structurally_valid && !result.ready_for_candidate, `${name} must fail structural readiness.`);
  check(result.errors.some(message => expected.test(message)), `${name}: ${result.errors.join('; ')}`);
}
for (const malformed of [null, [], 7, 'packet', {schema: 'wrong'}]) {
  const result = validateEditorialPacket(malformed);
  check(!result.structurally_valid && !result.ready_for_candidate, 'Malformed values must return a refusal without throwing.');
}
for (const key of ['package_alignment', 'source_context', 'payoffs', 'media_motivation', 'factual_limits']) {
  for (const state of ['fail', 'unreviewed']) {
    const packet = fixture(); packet.review[key] = state;
    const result = validateEditorialPacket(packet);
    check(result.structurally_valid && !result.ready_for_candidate, `${key}=${state} remains valid but blocked.`);
    check(result.review_blockers.some(message => message.includes(key)), 'The specific blocker must remain visible.');
  }
}
for (const mutation of [p => p.review.method = 'unreviewed', p => p.review.decision = 'revise']) {
  const packet = fixture(); mutation(packet);
  const result = validateEditorialPacket(packet);
  check(result.structurally_valid && !result.ready_for_candidate, 'Incomplete/negative recorded review must remain blocked.');
}
const rounding = fixture(); rounding.beats[1].start_sec = 6.1;
check(validateEditorialPacket(rounding).structurally_valid, 'Exactly 0.1 seconds rounding tolerance is accepted.');
const selfPayoff = fixture(); selfPayoff.beats[0].payoff_for = ['B01']; selfPayoff.opening.first_payoff_beat_id = 'B01';
check(validateEditorialPacket(selfPayoff).structurally_valid, 'A question and its answer may occur in the same beat.');

for (const [name, mutate] of [
  ['null reviewed hash', p => p.review.reviewed_content_sha256 = null],
  ['changed title', p => p.package.title = 'A changed promise'],
  ['changed source context', p => p.sources[0].context_after = 'A new fact following the excerpt.'],
  ['changed beat', p => p.beats[1].what_changes = 'The answer is now qualified.'],
  ['wrong reviewed hash', p => p.review.reviewed_content_sha256 = '0'.repeat(64)]
]) {
  const packet = fixture(); mutate(packet);
  const result = validateEditorialPacket(packet);
  check(result.structurally_valid && !result.ready_for_candidate, `${name} must block otherwise passing review declarations.`);
  check(result.review_blockers.some(value => value.includes('reviewed_content_sha256')), 'Missing/stale content binding must be explicit.');
}
const reordered = Object.fromEntries(Object.entries(fixture()).reverse());
reordered.package = Object.fromEntries(Object.entries(reordered.package).reverse());
check(editorialContentSha256(reordered) === editorialContentSha256(fixture()), 'Object key order must not change the content hash.');
const reviewOnly = fixture(); reviewOnly.review.notes = 'Updated review note.';
check(editorialContentSha256(reviewOnly) === editorialContentSha256(fixture()), 'The root review object is excluded from the content hash.');
const arrayOrder = fixture(); arrayOrder.beats.reverse();
check(editorialContentSha256(arrayOrder) !== editorialContentSha256(fixture()), 'Array order remains part of the content hash.');

const exec = promisify(execFile), cli = fileURLToPath(new URL('../crime-editorial-review.mjs', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'crime-editorial-packet-tests-'));
async function invoke(args) {
  try { const {stdout} = await exec(process.execPath, [cli, ...args], {cwd: temporary}); return {code: 0, stdout}; }
  catch (error) { return {code: error.code, stdout: error.stdout}; }
}
async function snapshot() {
  const entries = await fs.readdir(temporary);
  return Object.fromEntries(await Promise.all(entries.map(async name => [name, (await fs.readFile(path.join(temporary, name))).toString('base64')])));
}
try {
  const goodPath = path.join(temporary, 'good.json'), blockedPath = path.join(temporary, 'blocked.json'), badPath = path.join(temporary, 'bad.json');
  const blocked = fixture(); blocked.review.payoffs = 'unreviewed';
  await fs.writeFile(goodPath, JSON.stringify(fixture()));
  await fs.writeFile(blockedPath, JSON.stringify(blocked));
  await fs.writeFile(badPath, '{invalid JSON');
  const before = await snapshot();
  for (const [args, expectedCode, expectedStructural] of [
    [['--packet', goodPath, '--format', 'json'], 0, true],
    [['--packet', blockedPath, '--format', 'json'], 1, true],
    [['--packet', badPath, '--format', 'json'], 1, false],
    [['--packet', path.join(temporary, 'missing.json'), '--format', 'json'], 1, false],
    [['--packet', 'relative.json', '--format', 'json'], 1, false],
    [['--format', 'json'], 1, false],
    [['--packet', goodPath, '--packet', goodPath, '--format', 'json'], 1, false],
    [['--packet', goodPath, '--format', 'json', '--write', 'receipt.json'], 1, false]
  ]) {
    const result = await invoke(args), body = JSON.parse(result.stdout);
    assert.equal(result.code, expectedCode); assertions++;
    assert.equal(body.structurally_valid, expectedStructural); assertions++;
    check(body.approval_granted === false, 'CLI never grants approval.');
  }
  const markdown = await invoke(['--packet', goodPath, '--format', 'markdown']);
  check(markdown.code === 0 && markdown.stdout.includes('Approval granted: no'), 'Markdown output states the approval boundary.');
  assert.deepEqual(await snapshot(), before); assertions++;
  console.log(`PASS: ${assertions} editorial packet checks; malformed/timing/reference refusals, incomplete review blocking and read-only CLI. Synthetic declarations are not actual editorial or media approval.`);
} finally {
  await fs.rm(temporary, {recursive: true, force: true});
}
