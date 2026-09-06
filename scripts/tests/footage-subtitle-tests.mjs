#!/usr/bin/env node

import assert from "node:assert/strict";
import { MAX_SUBTITLE_BYTES, MAX_SUBTITLE_CUES, parseSubtitles, searchSubtitles } from "../lib/footage-subtitles.mjs";

const srt = '\uFEFF1\r\n00:01:02,345 --> 00:01:04,567\r\n<i>We’re at the café.</i>\r\n"Stay here," she said.\r\n\r\n1\r\n00:01:05,000 --> 00:01:07,000\r\nStay calm &amp; wait.\r\n\r\n00:01:08,000 --> 00:01:10,000\r\nStay here.\r\n';
const cues = parseSubtitles(srt);
assert.equal(cues.length, 3);
assert.deepEqual(cues[0], { id: "cue_000001", start_sec: 62.345, end_sec: 64.567, text: 'We’re at the café. "Stay here," she said.' });
assert.equal(cues[1].id, "cue_000002", "duplicate source labels must not collide");
assert.equal(cues[1].text, "Stay calm & wait.");
assert.deepEqual(parseSubtitles(Buffer.from(srt, "utf8")), cues);
assert.deepEqual(parseSubtitles(srt, { format: "srt" }), cues);

const vtt = `WEBVTT - local fixture
Kind: captions
Language: en

NOTE private author note
This is not dialogue --> and need not parse as a cue.

STYLE
::cue { color: lime; }

REGION
id:bottom

opening-quote
01:02.345 --> 01:04.567 line:90% position:50%,center align:center
<v Narrator><c.white>Hello, <b>world</b>!</c></v>
<00:01:03.000><lang en>Keep moving.</lang>

00:01:05.000 --> 00:01:07.000
<font color="yellow">&quot;Don&#39;t&quot;</font><br>stop &#x2014; &#233;lan.
`;
const vttCues = parseSubtitles(vtt);
assert.equal(vttCues.length, 2);
assert.deepEqual(vttCues[0], { id: "cue_000001", start_sec: 62.345, end_sec: 64.567, text: "Hello, world! Keep moving." });
assert.equal(vttCues[1].text, '"Don\'t" stop — élan.');
assert.deepEqual(parseSubtitles(vtt, { format: "webvtt" }), vttCues);
assert.deepEqual(parseSubtitles(vtt.replace(/\n/g, "\r\n"), { format: "vtt" }), vttCues);

const literalText = parseSubtitles("00:00:01,000 --> 00:00:02,000\n{\\an8}2 &lt; 3 &amp;lt;b&amp;gt; &lt;b&gt; &unknown; &#x110000; {keep this}");
assert.equal(literalText[0].text, "2 < 3 &lt;b&gt; <b> &unknown; &#x110000; {keep this}");
assert.equal(parseSubtitles('00:00:01,000 --> 00:00:02,000\n"This way --> home," she said.')[0].text, '"This way --> home," she said.', "a literal dialogue arrow is not a new timing row");
assert.equal(parseSubtitles("00:00:01.000 --> 00:00:02.000 X1:0 X2:360\nText")[0].start_sec, 1, "common SRT dot timestamps and position settings remain readable");
assert.throws(() => parseSubtitles("1\n00:61:00,000 --> 00:62:00,000\nNo"), /Subtitle line 2: invalid SRT timestamp/);
assert.throws(() => parseSubtitles("1\n00:00:01,000 -> 00:00:02,000\nNo"), /Subtitle line 2: expected a timestamp range/);
assert.throws(() => parseSubtitles("00:00:01,000 --> 00:00:02,000 nonsense\nNo"), /Subtitle line 1: invalid trailing cue settings/);
assert.throws(() => parseSubtitles("00:00:02,000 --> 00:00:01,000\nNo"), /cue end must be after its start/);
assert.throws(() => parseSubtitles("00:00:01,000 --> 00:00:01,000\nNo"), /cue end must be after its start/);
assert.throws(() => parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\n<i></i>"), /Subtitle line 3: cue has no display text/);
assert.throws(() => parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\nText\n2\n00:00:02,000 --> 00:00:03,000\nNext"), /Subtitle line 5: a blank line must separate subtitle cues/);
assert.throws(() => parseSubtitles("WEBVTT\n00:00:01.000 --> 00:00:02.000\nText"), /blank line must separate the WebVTT header/);
assert.throws(() => parseSubtitles("WEBVTT\n\n00:00:01,000 --> 00:00:02,000\nText"), /invalid VTT timestamp/);
assert.throws(() => parseSubtitles(srt, { format: "vtt" }), /requires a WEBVTT header/);
assert.throws(() => parseSubtitles(vtt, { format: "srt" }), /conflicts with requested SRT format/);
assert.throws(() => parseSubtitles(srt, { format: "ass" }), /format must be auto, srt, or vtt/);
assert.throws(() => parseSubtitles(""), /No timed subtitle cues found/);
assert.throws(() => parseSubtitles("WEBVTT\n\nNOTE nothing here"), /No timed subtitle cues found/);
assert.throws(() => parseSubtitles("not subtitles"), /Subtitle line 1: expected/);
assert.throws(() => parseSubtitles(Buffer.from([0xff, 0xfe, 0x31, 0])), /must be valid UTF-8/);
assert.throws(() => parseSubtitles("\0text"), /NUL bytes/);
assert.throws(() => parseSubtitles(null), /string or Uint8Array/);
assert.throws(() => parseSubtitles("x".repeat(MAX_SUBTITLE_BYTES + 1)), /exceeds .* bytes/);
assert.throws(() => parseSubtitles("00:00:01,000 --> 00:00:02,000\n" + "x".repeat(64 * 1024 + 1)), /cue text exceeds 64 KiB/);
assert.throws(() => parseSubtitles("00:00:01,000 --> 00:00:02,000\nx\n\n".repeat(MAX_SUBTITLE_CUES + 1)), /exceeds 100000 cues/);

const snapshot = JSON.stringify(cues);
const matches = searchSubtitles(cues, '"STAY here!"');
assert.deepEqual(matches.map((row) => row.cue_id), ["cue_000003", "cue_000001", "cue_000002"]);
assert.equal(matches[0].score, 120, "exact lexical match outranks an embedded phrase");
assert.equal(matches[1].score, 110, "an embedded phrase outranks partial term coverage");
assert.equal(matches[2].score, 5);
assert.deepEqual(Object.keys(matches[0]), ["cue_id", "start_sec", "end_sec", "text", "score"]);
assert.deepEqual(searchSubtitles(cues, "cafe").map((row) => row.cue_id), ["cue_000001"], "casefolded search ignores diacritics");
assert.deepEqual(searchSubtitles(cues, "caf"), [], "terms are not arbitrary substrings");
assert.deepEqual(searchSubtitles(cues, "spaceship"), []);
assert.equal(searchSubtitles(cues, "stay", { limit: 1 }).length, 1);
assert.equal(JSON.stringify(cues), snapshot, "search does not mutate source cue text or timing");

const affine = searchSubtitles(cues, "cafe", { offsetSec: 2.25, scale: 25 / 24 })[0];
assert.equal(affine.start_sec, cues[0].start_sec * (25 / 24) + 2.25);
assert.equal(affine.end_sec, cues[0].end_sec * (25 / 24) + 2.25);
assert.deepEqual(searchSubtitles(cues, "cafe", { offsetSec: -100 }), [], "unseekable negative adjusted starts are omitted, not clamped");
const tiedCues = [
  { id: "later", start_sec: 5, end_sec: 6, text: "hello there" },
  { id: "first", start_sec: 1, end_sec: 2, text: "hello there" },
  { id: "second", start_sec: 1, end_sec: 2, text: "hello there" },
];
assert.deepEqual(searchSubtitles(tiedCues, "hello").map((row) => row.cue_id), ["first", "second", "later"]);
for (const scale of [0, -1, Infinity, NaN, "1"]) assert.throws(() => searchSubtitles(cues, "stay", { scale }), /scale must be finite/);
for (const offsetSec of [Infinity, NaN, "0"]) assert.throws(() => searchSubtitles(cues, "stay", { offsetSec }), /offsetSec must be finite/);
for (const limit of [0, -1, 1.1, 1001, "1"]) assert.throws(() => searchSubtitles(cues, "stay", { limit }), /limit must be an integer/);
assert.throws(() => searchSubtitles(cues, "?!"), /at least one letter or number/);
assert.throws(() => searchSubtitles(cues, "x".repeat(4097)), /at most 4096 bytes/);
assert.throws(() => searchSubtitles(cues, Array.from({ length: 65 }, (_, i) => `q${i}`).join(" ")), /at most 64 distinct terms/);
assert.throws(() => searchSubtitles([cues[0], cues[0]], "stay"), /Invalid subtitle cue at index 1/);
assert.throws(() => searchSubtitles([{ ...cues[0], start_sec: -1 }], "stay"), /Invalid subtitle cue/);
assert.throws(() => searchSubtitles(cues, "stay", { scale: Number.MAX_VALUE }), /Synchronization produces invalid timestamps/);

console.log("footage subtitle tests passed (SRT, WebVTT, bounded parsing, lexical search, and explicit synchronization)");
