import assert from 'node:assert/strict';
import { buildSubtitleEventsForTests } from '../render.mjs';

for (const [name, words, caption] of [
  ['leading', [
    { word: 'Wrong.', start_sec: 0, end_sec: 0 },
    { word: 'The', start_sec: 0, end_sec: 0.3 },
    { word: 'door', start_sec: 0.3, end_sec: 0.6 },
    { word: 'opened.', start_sec: 0.6, end_sec: 1 },
  ], 'Correct. The door opened.'],
  ['trailing', [
    { word: 'She', start_sec: 0, end_sec: 0.4 },
    { word: 'answered.', start_sec: 0.4, end_sec: 1 },
    { word: 'wrong.', start_sec: 1, end_sec: 1 },
  ], 'She answered. Yes.'],
  ['consecutive', [
    { word: 'Wrong.', start_sec: 0, end_sec: 0 },
    { word: 'Wrong.', start_sec: 0, end_sec: 0 },
    { word: 'Listen.', start_sec: 0, end_sec: 1 },
  ], 'No. Wait. Listen.'],
]) {
  const timing = { words: words.map((word, index) => ({ ...word, index })) };
  const before = JSON.stringify(timing);
  const result = buildSubtitleEventsForTests(timing, null, {
    status: 'passed',
    beats: [{ source_word_start_index: 0, source_word_end_index: words.length - 1, visual_beat_script_excerpt: caption }],
  });
  assert.equal(result.source, 'approved_visual_beat_script_text_timed_by_whisper', name);
  assert.equal(result.events.map(row => row.text).join(' '), caption, name);
  assert.equal(JSON.stringify(timing), before, 'Whisper timing must remain immutable');
  assert.ok(result.events.every((row, index, all) => row.end_sec > row.start_sec && (index === 0 || row.start_sec >= all[index - 1].end_sec)), name);
}
console.log('Collapsed caption regression tests passed.');
