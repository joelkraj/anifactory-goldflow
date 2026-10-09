import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sha256File } from './file-hash.mjs';
import { loadRecapSourcePackage } from './recap-source-package.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const ensure = (condition, message) => { if (!condition) throw new Error(`Recap adaptation: ${message}`); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const cleanText = value => text(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function readBoundJson(file) {
  const absolute = await fs.realpath(path.resolve(file));
  const bytes = await fs.readFile(absolute);
  return { path: absolute, bytes, sha256: hash(bytes), data: JSON.parse(bytes.toString('utf8')) };
}

async function assertCurrent(sourceHashes) {
  for (const [file, expected] of Object.entries(sourceHashes)) ensure(await sha256File(file) === expected, `stale source ${file}`);
}

async function newOutputDirectory(outputDir) {
  ensure(path.isAbsolute(outputDir ?? ''), 'outputDir must be an absolute new directory');
  const output = path.resolve(outputDir);
  let ancestor = output;
  while (true) {
    ensure(!ancestor.split(path.sep).includes('episodes'), 'adaptation development must stay outside episode directories');
    ensure(!(await fs.stat(path.join(ancestor, 'run_identity.json')).then(() => true, () => false)), 'adaptation development cannot overwrite an episode');
    if (ancestor === path.dirname(ancestor)) break;
    ancestor = path.dirname(ancestor);
  }
  ensure(!(await fs.lstat(output).then(() => true, () => false)), 'output already exists; adaptation candidates are immutable');
  let existing = path.dirname(output);
  while (!(await fs.lstat(existing).then(() => true, () => false))) existing = path.dirname(existing);
  const real = await fs.realpath(existing);
  if (real !== existing) {
    const resolved = path.join(real, path.relative(existing, output));
    ensure(!resolved.split(path.sep).includes('episodes'), 'output symlink points into an episode');
    let parent = real;
    while (true) {
      ensure(!(await fs.stat(path.join(parent, 'run_identity.json')).then(() => true, () => false)), 'output symlink points into an episode');
      if (parent === path.dirname(parent)) break;
      parent = path.dirname(parent);
    }
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output);
  return output;
}

function sourceLookup(loaded) {
  const files = new Map(loaded.package.files.map(file => [file.id, file]));
  const references = new Map();
  for (const row of [...(loaded.text_index?.paragraphs ?? []), ...(loaded.text_index?.sentences ?? [])]) {
    ensure(!references.has(`text:${row.id}`), `ambiguous source text ID ${row.id}`);
    const file = files.get(row.file_id);
    ensure(file, `source text ${row.id} has unknown file`);
    references.set(`text:${row.id}`, { ...row, kind: 'text', rank: [file.source_order, row.start_char ?? 0] });
  }
  for (const panel of loaded.panel_inventory?.panels ?? []) {
    ensure(!references.has(`panel:${panel.id}`), `ambiguous panel ID ${panel.id}`);
    const file = files.get(panel.file_id);
    ensure(file, `panel ${panel.id} has unknown file`);
    references.set(`panel:${panel.id}`, { ...panel, kind: 'panel', rank: [file.source_order, panel.source_order ?? 0] });
  }
  return references;
}
const compareRank = (a, b) => a[0] - b[0] || a[1] - b[1];

export function validateRecapAdaptationDraft({ draft, sourcePackage, sourcePackageSha256 }) {
  ensure(draft?.schema === 'goldflow_recap_adaptation_draft_v1', 'unsupported draft schema');
  ensure(validHash(draft.source_package_sha256) && draft.source_package_sha256 === sourcePackageSha256, 'draft source package hash is stale or missing');
  ensure(Number.isFinite(draft.target_wpm) && draft.target_wpm > 0 && draft.target_wpm <= 400, 'target_wpm must be a positive diagnostic target');
  ensure(Array.isArray(draft.draft_units) && draft.draft_units.length > 0 && draft.draft_units.length <= 10000, 'draft_units must contain 1..10000 authored units');
  const lookup = sourceLookup(sourcePackage), ids = new Set(), rows = [];
  let previousRank = [-Infinity, -Infinity], charCursor = 0, byteCursor = 0;
  for (const unit of draft.draft_units) {
    ensure(typeof unit.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(unit.id) && !ids.has(unit.id), 'unit IDs must be unique stable identifiers'); ids.add(unit.id);
    ensure(cleanText(unit.narration_text), `unit ${unit.id} needs exact authored narration text`);
    ensure(Array.isArray(unit.source_refs) && unit.source_refs.length > 0, `unit ${unit.id} needs source references`);
    const refs = [], seen = new Set();
    let last = previousRank;
    for (const reference of unit.source_refs) {
      const referenceKey = `${reference.kind}:${reference.id}`, source = lookup.get(referenceKey);
      ensure(['text', 'panel'].includes(reference.kind) && source, `unit ${unit.id} cites unknown source ${referenceKey}`);
      ensure(!seen.has(referenceKey), `unit ${unit.id} repeats source ${referenceKey}`); seen.add(referenceKey);
      ensure(compareRank(source.rank, last) >= 0, `unit ${unit.id} reverses source order`); last = source.rank;
      if (reference.kind === 'text') ensure(text(reference.quote) && source.text.includes(reference.quote), `unit ${unit.id} quote is not exact source text for ${reference.id}`);
      else ensure(reference.quote === undefined, `panel ${reference.id} has no verified text transcript; cite artwork without an invented quote`);
      refs.push({ ...reference, file_id: source.file_id, source_rank: source.rank, source_sha256: source.sha256 ?? source.source_sha256 });
    }
    previousRank = last;
    const visual = unit.visual_intent;
    ensure(visual && Array.isArray(visual.panel_ids) && new Set(visual.panel_ids).size === visual.panel_ids.length && typeof visual.needs_artwork === 'boolean', `unit ${unit.id} needs explicit visual intent`);
    for (const id of visual.panel_ids) ensure(refs.some(ref => ref.kind === 'panel' && ref.id === id), `unit ${unit.id} visual panel ${id} is not a cited source panel`);
    ensure(visual.panel_ids.length > 0 || visual.needs_artwork, `unit ${unit.id} has neither source panels nor an artwork requirement`);
    if (visual.needs_artwork) ensure(cleanText(visual.brief), `unit ${unit.id} missing artwork needs an authored brief`);
    const narration = unit.narration_text;
    rows.push({ unit_id: unit.id, narration_text: narration, source_refs: refs, source_script_start_char: charCursor, source_script_end_char: charCursor + narration.length, source_script_start_byte: byteCursor, source_script_end_byte: byteCursor + Buffer.byteLength(narration), existing_panel_ids: [...visual.panel_ids], requires_generated_artwork: visual.needs_artwork, artwork_brief: visual.brief ?? null, semantic_review_required: true });
    charCursor += narration.length + 2; byteCursor += Buffer.byteLength(narration) + 2;
  }
  const script = draft.draft_units.map(unit => unit.narration_text).join('\n\n');
  const wordCount = script.trim().split(/\s+/u).length;
  return { script, units: rows, word_count: wordCount, estimated_duration_sec: wordCount / draft.target_wpm * 60, missing_visual_unit_count: rows.filter(row => row.requires_generated_artwork).length, source_kind: sourcePackage.package.source_kind };
}

async function inspectDraft(packagePath, draftPath) {
  const loaded = await loadRecapSourcePackage(packagePath, { verifyOriginals: true });
  const draft = await readBoundJson(draftPath);
  const packageHash = await sha256File(loaded.package_path);
  const validated = validateRecapAdaptationDraft({ draft: draft.data, sourcePackage: loaded, sourcePackageSha256: packageHash });
  const source_hashes = { ...loaded.source_hashes, [loaded.package_path]: packageHash, [draft.path]: draft.sha256 };
  await assertCurrent(source_hashes);
  return { loaded, draft, packageHash, validated, source_hashes };
}

export async function checkRecapAdaptation({ packagePath, draftPath }) {
  const checked = await inspectDraft(packagePath, draftPath);
  return { status: 'passed_structural_checks', approval_status: 'source_and_adaptation_review_required', production_eligible: false, source_kind: checked.validated.source_kind, source_package_sha256: checked.packageHash, draft_sha256: checked.draft.sha256, script_sha256: hash(checked.validated.script), unit_count: checked.validated.units.length, missing_visual_unit_count: checked.validated.missing_visual_unit_count, word_count: checked.validated.word_count, estimated_duration_sec: checked.validated.estimated_duration_sec, source_hashes: checked.source_hashes };
}

export async function prepareRecapAdaptation({ packagePath, outputDir, targetWpm = 185 }) {
  const loaded = await loadRecapSourcePackage(packagePath, { verifyOriginals: true });
  ensure(Number.isFinite(targetWpm) && targetWpm > 0 && targetWpm <= 400, 'targetWpm must be a positive diagnostic target');
  const packageHash = await sha256File(loaded.package_path);
  await assertCurrent(loaded.source_hashes);
  const output = await newOutputDirectory(outputDir);
  const template = { schema: 'goldflow_recap_adaptation_draft_v1', source_package_sha256: packageHash, target_wpm: targetWpm, draft_units: [] };
  await fs.writeFile(path.join(output, 'draft_template.json'), json(template), { flag: 'wx' });
  await fs.writeFile(path.join(output, 'authoring_packet.json'), json(loaded.adaptation_packet), { flag: 'wx' });
  const instructions = 'Author narration from this exact source package. Each ordered unit needs a unique id, exact narration_text, and source_refs. Text references require an exact source quote; panel references cite verified panel IDs without invented transcript. Author visual_intent with panel_ids, needs_artwork, and a brief when art is missing. Prose requires an artwork plan. Import preserves narration bytes and inserts only two newline separators. Structural validation does not approve source fidelity. No provider runs or production approvals are performed here.\n';
  await fs.writeFile(path.join(output, 'AUTHORING.txt'), instructions, { flag: 'wx' });
  return { status: 'ready_for_authoring', output_dir: output, source_package_sha256: packageHash, draft_template_path: path.join(output, 'draft_template.json'), production_eligible: false };
}

export async function importRecapAdaptation({ packagePath, draftPath, outputDir }) {
  const started = Date.now(), checked = await inspectDraft(packagePath, draftPath);
  const output = await newOutputDirectory(outputDir);
  const scriptPath = path.join(output, 'script_candidate.txt'), draftCopy = path.join(output, 'draft.json'), coveragePath = path.join(output, 'visual_requirements.json');
  const report = { schema: 'goldflow_recap_adaptation_report_v1', status: 'candidate_requires_review', production_eligible: false, created_at: new Date().toISOString(), source_kind: checked.validated.source_kind, source_package: { path: checked.loaded.package_path, sha256: checked.packageHash }, source_hashes: checked.source_hashes, draft: { path: draftCopy, sha256: checked.draft.sha256 }, script: { path: scriptPath, sha256: hash(checked.validated.script) }, visual_requirements: null, unit_count: checked.validated.units.length, word_count: checked.validated.word_count, target_wpm: checked.draft.data.target_wpm, estimated_duration_sec: checked.validated.estimated_duration_sec, missing_visual_unit_count: checked.validated.missing_visual_unit_count, separator: '\n\n', automatic_authoring: false, semantic_review_required: true, cost_usd: 0 };
  const coverage = { schema: 'goldflow_recap_visual_requirements_v1', source_package_sha256: checked.packageHash, script_sha256: report.script.sha256, draft_sha256: checked.draft.sha256, units: checked.validated.units, missing_visual_unit_count: report.missing_visual_unit_count, production_eligible: false };
  await fs.writeFile(scriptPath, checked.validated.script, { flag: 'wx' });
  await fs.writeFile(draftCopy, checked.draft.bytes, { flag: 'wx' });
  const coverageBytes = json(coverage);
  await fs.writeFile(coveragePath, coverageBytes, { flag: 'wx' });
  report.visual_requirements = { path: coveragePath, sha256: hash(coverageBytes) };
  await assertCurrent(checked.source_hashes);
  report.elapsed_sec = (Date.now() - started) / 1000;
  await fs.writeFile(path.join(output, 'adaptation_report.json'), json(report), { flag: 'wx' });
  await fs.writeFile(path.join(output, 'execution_events.jsonl'), `${JSON.stringify({ event: 'adaptation_imported', at: report.created_at, script_sha256: report.script.sha256, draft_sha256: report.draft.sha256, source_package_sha256: checked.packageHash, cost_usd: 0 })}\n`, { flag: 'wx' });
  return report;
}

export async function loadRecapAdaptation(adaptationDir) {
  const reportFile = await readBoundJson(path.join(path.resolve(adaptationDir), 'adaptation_report.json'));
  const report = reportFile.data;
  ensure(report.schema === 'goldflow_recap_adaptation_report_v1' && report.status === 'candidate_requires_review' && report.production_eligible === false, 'invalid adaptation report');
  await assertCurrent(report.source_hashes);
  for (const ref of [report.source_package, report.draft, report.script, report.visual_requirements]) ensure(await sha256File(ref.path) === ref.sha256, 'candidate artifact has a stale hash');
  const checked = await inspectDraft(report.source_package.path, report.draft.path);
  ensure(report.source_kind === checked.validated.source_kind && report.unit_count === checked.validated.units.length && report.word_count === checked.validated.word_count && report.missing_visual_unit_count === checked.validated.missing_visual_unit_count, 'adaptation report differs from validated source kind or coverage');
  ensure(checked.validated.script === await fs.readFile(report.script.path, 'utf8'), 'candidate differs from exact authored unit text');
  const coverage = await readBoundJson(report.visual_requirements.path);
  ensure(coverage.data.schema === 'goldflow_recap_visual_requirements_v1' && coverage.data.source_package_sha256 === report.source_package.sha256 && coverage.data.script_sha256 === report.script.sha256 && coverage.data.draft_sha256 === report.draft.sha256, 'visual requirement provenance differs from candidate');
  ensure(JSON.stringify(coverage.data.units) === JSON.stringify(checked.validated.units), 'visual requirements differ from authored source-grounded units');
  return { report, report_path: reportFile.path, report_sha256: reportFile.sha256, coverage: coverage.data, checked };
}

export async function recordRecapAdaptationReview({ adaptationDir, reviewer, note, attestation }) {
  ensure(cleanText(reviewer) && cleanText(note), 'reviewer and specific review note are required');
  ensure(attestation === 'source_and_adaptation_reviewed', 'explicit source_and_adaptation_reviewed attestation required');
  let ancestor = await fs.realpath(path.resolve(adaptationDir));
  while (true) {
    ensure(!ancestor.split(path.sep).includes('episodes') && !(await fs.stat(path.join(ancestor, 'run_identity.json')).then(() => true, () => false)), 'adaptation review cannot write inside an episode');
    if (ancestor === path.dirname(ancestor)) break;
    ancestor = path.dirname(ancestor);
  }
  const loaded = await loadRecapAdaptation(adaptationDir);
  const output = path.join(path.resolve(adaptationDir), 'reviews'); await fs.mkdir(output, { recursive: true });
  const id = randomUUID(), reviewPath = path.join(output, `review-${id}.json`);
  const review = { schema: 'goldflow_recap_adaptation_review_v1', decision: 'accepted', review_scope: 'exact_source_and_adaptation_candidate', reviewer, note, attestation, created_at: new Date().toISOString(), adaptation_report_sha256: loaded.report_sha256, source_package_sha256: loaded.report.source_package.sha256, draft_sha256: loaded.report.draft.sha256, script_sha256: loaded.report.script.sha256, visual_requirements_sha256: loaded.report.visual_requirements.sha256, production_eligible: false };
  await fs.writeFile(reviewPath, json(review), { flag: 'wx' });
  const handoff = { schema: 'goldflow_recap_narration_handoff_v1', status: 'ready_for_guarded_narration_preparation', production_eligible: false, source_mode: loaded.report.source_kind === 'comic' ? 'comic_adaptation' : loaded.report.source_kind === 'prose' ? 'prose_adaptation' : 'original_story', content_profile: 'manhwa_recap_v1', script: loaded.report.script, caption_text_source: 'exact_script_candidate_bytes', spoken_text_policy: 'shared_approved_spoken_text_lineage_only', source_package: loaded.report.source_package, adaptation_report: { path: loaded.report_path, sha256: loaded.report_sha256 }, review: { path: reviewPath, sha256: await sha256File(reviewPath) }, visual_requirements: loaded.report.visual_requirements, required_next_steps: ['explicit_narration_identity_and_scope', 'guarded_exact_script_approval', 'shared_voice_plan_and_narration_quality_contract', 'current_local_whisper_word_timing', 'authored_unit_to_word_span_binding'], providers_invoked: false, source_manufacturer_invoked: false };
  const handoffPath = path.join(output, `narration-handoff-${id}.json`);
  await fs.writeFile(handoffPath, json(handoff), { flag: 'wx' });
  await fs.appendFile(path.join(path.resolve(adaptationDir), 'execution_events.jsonl'), `${JSON.stringify({ event: 'adaptation_review_recorded', at: review.created_at, review_path: reviewPath, script_sha256: review.script_sha256, handoff_path: handoffPath })}\n`);
  return { ...review, review_path: reviewPath, narration_handoff_path: handoffPath };
}
