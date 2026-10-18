import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const EDITORIAL_PACKET_SCHEMA = 'crimedungeon_editorial_packet_v1';
const MODES = ['source_scene', 'social_claim', 'original_audio', 'narration_bridge', 'document', 'map_timeline', 'reconstruction', 'transition', 'conclusion'];
const OPENING_MODES = ['source_scene', 'social_claim', 'original_audio'];
const REFERENCE_METHODS = ['direct_playback', 'frame_inspection', 'transcript_review', 'automated_analysis'];
const REVIEW_CHECKS = ['package_alignment', 'source_context', 'payoffs', 'media_motivation', 'factual_limits'];
const TOLERANCE = 0.1 + 1e-9;
const LIMITS = [
  'Structural checks and recorded review declarations only; no source truth, rights, semantic payoff or editorial quality is verified.',
  'Reference methods are self-reported; automated analysis, transcripts and frames are not direct viewing/listening.',
  'No script, media, listening, production or publishing approval is granted; existing workflow gates still apply.'
];

function report(errors, blockers = [], referenceMethods = {}, contentSha256 = null) {
  return {
    schema: 'crimedungeon_editorial_check_v1',
    structurally_valid: errors.length === 0,
    ready_for_candidate: errors.length === 0 && blockers.length === 0,
    approval_granted: false,
    content_sha256: contentSha256,
    errors,
    review_blockers: blockers,
    reference_method_counts: referenceMethods,
    limitations: [...LIMITS]
  };
}

// Sort object keys recursively, retain array order, and exclude only the root
// review object. A review can then bind the exact package/source/beat content.
export function editorialContentSha256(packet) {
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) return null;
  const sortKeys = value => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
    return value;
  };
  const content = Object.fromEntries(Object.entries(packet).filter(([key]) => key !== 'review'));
  return createHash('sha256').update(JSON.stringify(sortKeys(content))).digest('hex');
}

// Pure inspection of an editorial preparation packet. This is intentionally not
// imported by any frozen proof controller or connected to a media producer.
export function validateEditorialPacket(packet) {
  const errors = [], blockers = [], referenceMethods = {};
  const contentSha256 = editorialContentSha256(packet);
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const object = (value, at, keys) => {
    if (!isObject(value)) { errors.push(`${at}: expected an object`); return {}; }
    for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${at}.${key}: unknown field`);
    return value;
  };
  const text = (value, at) => {
    if (typeof value !== 'string' || !value.trim()) { errors.push(`${at}: expected a nonblank string`); return false; }
    return true;
  };
  const number = (value, at) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) { errors.push(`${at}: expected a finite nonnegative number`); return false; }
    return true;
  };
  const enumeration = (value, at, choices) => {
    if (!choices.includes(value)) errors.push(`${at}: expected one of ${choices.join(', ')}`);
  };
  const list = (value, at, nonempty = true) => {
    if (!Array.isArray(value)) { errors.push(`${at}: expected an array`); return []; }
    if (nonempty && value.length === 0) errors.push(`${at}: must not be empty`);
    return value;
  };
  const strings = (value, at, nonempty = true) => {
    const values = list(value, at, nonempty), seen = new Set();
    values.forEach((item, index) => {
      if (!text(item, `${at}[${index}]`)) return;
      if (seen.has(item)) errors.push(`${at}[${index}]: duplicate reference ${item}`);
      seen.add(item);
    });
    return values;
  };
  const bounds = (value, at, start, end) => {
    const validStart = number(value[start], `${at}.${start}`);
    const validEnd = number(value[end], `${at}.${end}`);
    if (validStart && validEnd && value[end] <= value[start]) errors.push(`${at}: ${end} must be greater than ${start}`);
  };
  const url = (value, at) => {
    if (!text(value, at)) return;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error('not a public citation');
    } catch { errors.push(`${at}: expected an http(s) citation URL without credentials`); }
  };
  const uniqueId = (value, at, ids) => {
    if (!text(value, at)) return;
    if (ids.has(value)) errors.push(`${at}: duplicate id ${value}`);
    ids.add(value);
  };

  const root = object(packet, 'packet', ['schema', 'package', 'sources', 'beats', 'opening', 'references', 'review']);
  if (root.schema !== EDITORIAL_PACKET_SCHEMA) errors.push(`packet.schema: expected ${EDITORIAL_PACKET_SCHEMA}`);
  const packageKeys = ['title', 'premise', 'viewer_question', 'promised_answer', 'thumbnail_moment'];
  const packageCard = object(root.package, 'package', packageKeys);
  for (const key of packageKeys) text(packageCard[key], `package.${key}`);

  const allIds = new Set(), sourceIds = new Set();
  const sourceKeys = ['id', 'url', 'in_sec', 'out_sec', 'context_before', 'context_after', 'claim_supported', 'picture_origin', 'audio_origin', 'use_basis'];
  list(root.sources, 'sources').forEach((item, index) => {
    const at = `sources[${index}]`, source = object(item, at, sourceKeys);
    uniqueId(source.id, `${at}.id`, allIds);
    if (typeof source.id === 'string') sourceIds.add(source.id);
    url(source.url, `${at}.url`);
    bounds(source, at, 'in_sec', 'out_sec');
    for (const key of sourceKeys.slice(4)) text(source[key], `${at}.${key}`);
  });

  const beatKeys = ['id', 'start_sec', 'end_sec', 'question', 'source_ids', 'mode', 'picture_action', 'audio_action', 'what_changes', 'payoff_for', 'next_question'];
  const beatIndexes = new Map();
  const beats = list(root.beats, 'beats').map((item, index) => {
    const at = `beats[${index}]`, beat = object(item, at, beatKeys);
    uniqueId(beat.id, `${at}.id`, allIds);
    if (typeof beat.id === 'string') beatIndexes.set(beat.id, index);
    bounds(beat, at, 'start_sec', 'end_sec');
    for (const key of ['question', 'picture_action', 'audio_action', 'what_changes', 'next_question']) text(beat[key], `${at}.${key}`);
    enumeration(beat.mode, `${at}.mode`, MODES);
    const sourceRefs = strings(beat.source_ids, `${at}.source_ids`);
    for (const id of sourceRefs) if (typeof id === 'string' && !sourceIds.has(id)) errors.push(`${at}.source_ids: unknown source id ${id}`);
    const payoffs = strings(beat.payoff_for, `${at}.payoff_for`, false);
    return {...beat, source_ids: sourceRefs, payoff_for: payoffs};
  });
  beats.forEach((beat, index) => {
    const at = `beats[${index}]`;
    if (index === 0) {
      if (Number.isFinite(beat.start_sec) && Math.abs(beat.start_sec) > TOLERANCE) errors.push(`${at}.start_sec: timeline must begin at zero within 0.1 seconds`);
      if (!OPENING_MODES.includes(beat.mode)) errors.push(`${at}.mode: opening must use source_scene, social_claim or original_audio`);
    } else {
      const previous = beats[index - 1];
      if (Number.isFinite(beat.start_sec) && Number.isFinite(previous.end_sec) && Math.abs(beat.start_sec - previous.end_sec) > TOLERANCE) errors.push(`${at}: timeline must be contiguous within 0.1 seconds`);
      if (Number.isFinite(beat.start_sec) && Number.isFinite(previous.start_sec) && beat.start_sec <= previous.start_sec) errors.push(`${at}.start_sec: beat starts must increase`);
      if (Number.isFinite(beat.end_sec) && Number.isFinite(previous.end_sec) && beat.end_sec <= previous.end_sec) errors.push(`${at}.end_sec: beat ends must increase`);
    }
    for (const id of beat.payoff_for) {
      if (typeof id !== 'string') continue;
      const target = beatIndexes.get(id);
      if (target === undefined) errors.push(`${at}.payoff_for: unknown beat id ${id}`);
      else if (target > index) errors.push(`${at}.payoff_for: cannot resolve a future beat ${id}`);
    }
  });

  const opening = object(root.opening, 'opening', ['question_by_sec', 'first_payoff_beat_id', 'package_connection']);
  number(opening.question_by_sec, 'opening.question_by_sec');
  text(opening.package_connection, 'opening.package_connection');
  if (text(opening.first_payoff_beat_id, 'opening.first_payoff_beat_id')) {
    const index = beatIndexes.get(opening.first_payoff_beat_id), firstPayoff = beats[index];
    if (!firstPayoff) errors.push('opening.first_payoff_beat_id: unknown beat id');
    else {
      if (firstPayoff.payoff_for.length === 0) errors.push('opening.first_payoff_beat_id: selected beat must link a payoff');
      if (beats.findIndex(beat => beat.payoff_for.length > 0) !== index) errors.push('opening.first_payoff_beat_id: must identify the earliest linked payoff');
      if (Number.isFinite(opening.question_by_sec) && Number.isFinite(firstPayoff.end_sec) && opening.question_by_sec > firstPayoff.end_sec) errors.push('opening.question_by_sec: question must be introduced no later than the first payoff ends');
    }
  }

  const referenceKeys = ['url', 'in_sec', 'out_sec', 'observed', 'method', 'application'];
  list(root.references, 'references').forEach((item, index) => {
    const at = `references[${index}]`, reference = object(item, at, referenceKeys);
    url(reference.url, `${at}.url`);
    bounds(reference, at, 'in_sec', 'out_sec');
    text(reference.observed, `${at}.observed`);
    text(reference.application, `${at}.application`);
    enumeration(reference.method, `${at}.method`, REFERENCE_METHODS);
    if (REFERENCE_METHODS.includes(reference.method)) referenceMethods[reference.method] = (referenceMethods[reference.method] || 0) + 1;
  });

  const review = object(root.review, 'review', ['reviewer', 'method', ...REVIEW_CHECKS, 'decision', 'notes', 'reviewed_content_sha256']);
  text(review.reviewer, 'review.reviewer');
  text(review.notes, 'review.notes');
  enumeration(review.method, 'review.method', ['paper_edit', 'direct_playback', 'unreviewed']);
  enumeration(review.decision, 'review.decision', ['revise', 'ready_for_candidate']);
  if (review.reviewed_content_sha256 !== null && (typeof review.reviewed_content_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(review.reviewed_content_sha256))) errors.push('review.reviewed_content_sha256: expected null or a lowercase 64-character SHA-256');
  if (review.reviewed_content_sha256 === null) blockers.push('review.reviewed_content_sha256: no content hash has been reviewed');
  else if (review.reviewed_content_sha256 !== contentSha256) blockers.push('review.reviewed_content_sha256: does not match the current package, sources, beats, opening and references');
  for (const key of REVIEW_CHECKS) {
    enumeration(review[key], `review.${key}`, ['pass', 'fail', 'unreviewed']);
    if (review[key] !== 'pass') blockers.push(`review.${key}: ${['fail', 'unreviewed'].includes(review[key]) ? review[key] : 'missing or invalid'}`);
  }
  if (!['paper_edit', 'direct_playback'].includes(review.method)) blockers.push('review.method: no completed paper-edit or playback review recorded');
  if (review.decision !== 'ready_for_candidate') blockers.push('review.decision: candidate preparation has not been selected');
  return report(errors, blockers, referenceMethods, contentSha256);
}

export function formatEditorialReport(result) {
  const lines = [
    `Structurally valid: ${result.structurally_valid ? 'yes' : 'no'}`,
    `Ready for candidate, according to recorded review: ${result.ready_for_candidate ? 'yes' : 'no'}`,
    'Approval granted: no',
    `Content SHA-256: ${result.content_sha256 ?? 'unavailable'}`
  ];
  for (const [title, values] of [['Structural errors', result.errors], ['Review blockers', result.review_blockers], ['Limits', result.limitations]]) {
    if (values.length) lines.push('', `${title}:`, ...values.map(value => `- ${value}`));
  }
  lines.push('', `Reference methods: ${JSON.stringify(result.reference_method_counts)}`);
  return lines.join('\n') + '\n';
}

export async function runEditorialReviewCli(args) {
  // Honor an explicit JSON error format even when an earlier argument is bad.
  let packetPath, format = args[args.indexOf('--format') + 1] === 'json' ? 'json' : 'markdown';
  try {
    const seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index], value = args[index + 1];
      if (!['--packet', '--format'].includes(key) || seen.has(key) || value === undefined || value.startsWith('--')) throw new Error('Usage: node scripts/crime-editorial-review.mjs --packet <absolute JSON> --format json|markdown');
      seen.add(key);
      if (key === '--packet') packetPath = value;
      if (key === '--format') format = value;
    }
    if (!['json', 'markdown'].includes(format)) throw new Error('--format must be json or markdown');
    if (typeof packetPath !== 'string' || !path.isAbsolute(packetPath)) throw new Error('--packet must be an absolute JSON file path');
    const stat = await fs.stat(packetPath);
    if (!stat.isFile()) throw new Error('--packet must name a regular file');
    const result = validateEditorialPacket(JSON.parse(await fs.readFile(packetPath, 'utf8')));
    return {result, format, exitCode: result.ready_for_candidate ? 0 : 1};
  } catch (error) {
    return {result: report([error.message]), format: format === 'json' ? 'json' : 'markdown', exitCode: 1};
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {result, format, exitCode} = await runEditorialReviewCli(process.argv.slice(2));
  process.stdout.write(format === 'json' ? JSON.stringify(result, null, 2) + '\n' : formatEditorialReport(result));
  process.exitCode = exitCode;
}
