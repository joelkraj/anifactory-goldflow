import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeWord(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean).map(String))];
}

function assetLabel(value) {
  if (typeof value === "string" || typeof value === "number") return normalizeText(value);
  if (!value || typeof value !== "object") return "";
  return normalizeText(value.text ?? value.label ?? value.display_name ?? value.name ?? value.ui_id ?? value.prop_id ?? value.type ?? "");
}

function assetLabels(values) {
  return unique((values ?? []).map(assetLabel).filter(Boolean));
}

function editDistance(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  const previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

function wordsWithOffsets(script) {
  return [...String(script ?? "").matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)].map((match, index) => ({
    script_word_index: index,
    value: match[0],
    normalized: normalizeWord(match[0]),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function whisperRows(words) {
  return (words ?? []).map((word, index) => ({
    index: Number.isInteger(word.index) ? word.index : index,
    normalized: normalizeWord(word.normalized ?? word.word ?? word.text),
    start_sec: Number(word.start_sec ?? word.start ?? 0),
    end_sec: Number(word.end_sec ?? word.end ?? word.start_sec ?? word.start ?? 0),
  }));
}

function alignScriptWords(scriptWords, timedWords, lookahead = 9) {
  let cursor = 0;
  return scriptWords.map((word) => {
    let selected = -1;
    let selectedScore = -1;
    for (let index = cursor; index < Math.min(timedWords.length, cursor + lookahead); index += 1) {
      const candidate = timedWords[index].normalized;
      if (!candidate || !word.normalized) continue;
      const exact = candidate === word.normalized;
      const distance = exact ? 0 : editDistance(candidate, word.normalized);
      const score = exact ? 1 : 1 - distance / Math.max(candidate.length, word.normalized.length, 1);
      if (score > selectedScore) {
        selected = index;
        selectedScore = score;
      }
      if (exact) break;
    }
    if (selected >= 0 && (selectedScore >= 0.72 || word.normalized.length <= 2 && selectedScore >= 0.5)) {
      cursor = selected + 1;
      return { ...word, whisper_index: selected, alignment_score: Number(selectedScore.toFixed(4)) };
    }
    return { ...word, whisper_index: null, alignment_score: 0 };
  });
}

function clauseSpans(script, alignedWords, { maxWords = 18, minWords = 5 } = {}) {
  if (!alignedWords.length) return [];
  const conjunctions = new Set(["and", "but", "then", "because", "while", "when", "before", "after", "until", "instead"]);
  const spans = [];
  let start = 0;
  for (let index = 0; index < alignedWords.length; index += 1) {
    const next = alignedWords[index + 1] ?? null;
    const between = next ? String(script).slice(alignedWords[index].end, next.start) : String(script).slice(alignedWords[index].end);
    const count = index - start + 1;
    const sentenceBoundary = /[.!?]["'”’)]*\s*$/.test(between);
    const clauseBoundary = /[,;:]\s*$/.test(between) || (next && conjunctions.has(next.normalized));
    const hardMax = count >= maxWords;
    const shouldBreak = sentenceBoundary || hardMax || (clauseBoundary && count >= minWords);
    if (!shouldBreak && next) continue;
    spans.push({ start_word: start, end_word: index });
    start = index + 1;
  }
  return spans;
}

function sceneForTime(timedScenes, startSec, endSec) {
  const midpoint = startSec + (endSec - startSec) / 2;
  return (timedScenes ?? []).find((scene) => {
    const start = Number(scene.start_sec ?? 0);
    const end = Number(scene.end_sec ?? start + Number(scene.duration_sec ?? 0));
    return midpoint >= start - 0.01 && midpoint <= end + 0.01;
  }) ?? (timedScenes ?? []).find((scene) => Number(scene.end_sec ?? 0) >= startSec) ?? null;
}

function evidenceTransitionAtomIds(atoms, factLedger) {
  const barriers = new Set();
  for (const transition of factLedger?.state_transitions ?? []) {
    for (const evidence of transition.evidence ?? []) {
      const excerpt = normalizeText(evidence.exact_excerpt);
      const atom = atoms.find((candidate) => excerpt && normalizeText(candidate.text).includes(excerpt));
      if (atom) barriers.add(atom.atom_id);
    }
  }
  return barriers;
}

export function retentionRailForTime(startSec) {
  const start = Number(startSec ?? 0);
  if (start < 30) return { band: "0_30", min_sec: 2.2, max_sec: 4.5 };
  if (start < 180) return { band: "30_180", min_sec: 3.2, max_sec: 7 };
  if (start < 1200) return { band: "180_1200", min_sec: 5, max_sec: 12 };
  return { band: "1200_plus", min_sec: 7, max_sec: 15 };
}

export function buildTranscriptAtoms(script, words, timedScenes = [], factLedger = {}, options = {}) {
  const timedWords = whisperRows(words);
  if (!timedWords.length) throw new Error("Editorial atoms require Whisper words.");
  const scriptWords = alignScriptWords(wordsWithOffsets(script), timedWords, Number(options.lookahead ?? 9));
  const spans = clauseSpans(script, scriptWords, options);
  const atomStarts = [];
  for (let index = 0; index < spans.length; index += 1) {
    const spanWords = scriptWords.slice(spans[index].start_word, spans[index].end_word + 1);
    const firstMatched = spanWords.find((word) => Number.isInteger(word.whisper_index))?.whisper_index;
    const minimum = index === 0 ? 0 : atomStarts[index - 1] + 1;
    atomStarts.push(Math.min(timedWords.length - 1, Math.max(minimum, Number.isInteger(firstMatched) ? firstMatched : minimum)));
  }
  const atoms = spans.map((span, index) => {
    const first = scriptWords[span.start_word];
    const last = scriptWords[span.end_word];
    const next = scriptWords[span.end_word + 1] ?? null;
    const charEnd = next ? next.start : String(script).length;
    const wordStart = atomStarts[index];
    const wordEnd = index + 1 < atomStarts.length ? atomStarts[index + 1] - 1 : timedWords.length - 1;
    const startSec = timedWords[wordStart].start_sec;
    const endSec = timedWords[Math.max(wordStart, wordEnd)].end_sec;
    const scene = sceneForTime(timedScenes, startSec, endSec);
    return {
      atom_id: `atom_w${String(wordStart).padStart(6, "0")}_w${String(Math.max(wordStart, wordEnd)).padStart(6, "0")}`,
      source_script_word_start: span.start_word,
      source_script_word_end: span.end_word,
      source_word_start_index: wordStart,
      source_word_end_index: Math.max(wordStart, wordEnd),
      start_sec: Number(startSec.toFixed(3)),
      end_sec: Number(endSec.toFixed(3)),
      duration_sec: Number(Math.max(0, endSec - startSec).toFixed(3)),
      text: String(script).slice(first.start, Math.max(last.end, charEnd)).trim(),
      scene_id: scene?.scene_id ?? null,
      semantic_location: scene?.location ?? null,
      semantic_scene: scene ?? null,
      transition_barrier_before: false,
    };
  });
  const transitionAtoms = evidenceTransitionAtomIds(atoms, factLedger);
  for (let index = 0; index < atoms.length; index += 1) {
    const previous = atoms[index - 1] ?? null;
    atoms[index].transition_barrier_before = index > 0 && (
      atoms[index].scene_id !== previous?.scene_id
      || normalizeText(atoms[index].semantic_location) !== normalizeText(previous?.semantic_location)
      || transitionAtoms.has(atoms[index].atom_id)
      || [30, 180, 1200].some((boundary) => previous.start_sec < boundary && atoms[index].start_sec >= boundary)
    );
  }
  return atoms;
}

function canonicalDictionaries(factLedger) {
  const entities = (factLedger?.canonical_entities ?? factLedger?.entities ?? []).map((row) => ({
    entity_id: String(row.entity_id ?? ""),
    display_name: row.display_name ?? row.label ?? row.entity_id,
    aliases: row.aliases ?? [],
    kind: row.kind ?? "person",
  })).filter((row) => row.entity_id);
  const locations = (factLedger?.canonical_locations ?? factLedger?.locations ?? []).map((row) => ({
    location_id: String(row.location_id ?? ""),
    display_name: row.display_name ?? row.label ?? row.location_id,
    aliases: row.aliases ?? [],
  })).filter((row) => row.location_id);
  return { entities, locations };
}

export function buildEditorialDirectorPrompt(atoms, factLedger, timedScenes = []) {
  const dictionaries = canonicalDictionaries(factLedger);
  const sceneIds = new Set(atoms.map((atom) => atom.scene_id).filter(Boolean));
  const sceneContext = (timedScenes ?? []).filter((scene) => sceneIds.has(scene.scene_id)).map((scene) => ({
    scene_id: scene.scene_id,
    title: scene.title,
    location: scene.location,
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
    character_states: scene.character_states ?? [],
    props: scene.props ?? [],
    ui_text_on_screen: scene.ui_text_on_screen ?? [],
  }));
  return `Act as the editorial beat director for timed manhwa recap narration.

Decide what the viewer needs to see right now to understand, feel, and keep watching. You own visual job, depiction mode, visible/screen/preview/mentioned entities, location, foreground action, and composition. Do not write an image-generation prompt.

Hard rails:
- Use every atom_id exactly once and in order. You may merge adjacent atoms into one beat.
- Never reorder, overlap, omit, duplicate, or invent atoms.
- Never merge across an atom with transition_barrier_before=true.
- Retention holds: 0-30s 2.2-4.5s; 30-180s 3.2-7s; 180-1200s 5-12s; after 1200s 7-15s. Measure a beat from its first atom start through the next unmerged atom start, because the image remains visible during the narration pause. Merge adjacent atoms to fit when story truth allows. An indivisible atom or mandatory transition may use a concise rail_exception.
- Current reality, screen/replay, preview/hypothetical, memory/flashback, and mentioned-only are distinct depiction modes.
- Mentioned-only entities stay offscreen. Every visible entity needs an exact evidence excerpt from the grouped atoms.
- Resolve first-person I/me/my physical actions to the established narrator/protagonist entity when the fact ledger and scene context identify that person; do not make the acting protagonist disappear because their proper name is omitted locally.
- Select only canonical entity_id and location_id values below. If the narration gives no supported visible person, an object/UI/environment beat is valid.
- Composition is beat-specific. There is no global wide or close-up bias.
- Each beat has one decisive visible job and foreground action. The foreground action must be a direct concrete paraphrase of its exact foreground_action_evidence. Do not infer an injury, emotion, pose, wardrobe, or intent that the grouped atoms and supplied scene facts do not establish.

ATOMS:
${JSON.stringify(atoms.map((atom) => ({
    atom_id: atom.atom_id,
    scene_id: atom.scene_id,
    start_sec: atom.start_sec,
    end_sec: atom.end_sec,
    next_atom_start_sec: atoms[atoms.indexOf(atom) + 1]?.start_sec ?? atom.end_sec,
    duration_sec: atom.duration_sec,
    text: atom.text,
    semantic_location: atom.semantic_location,
    transition_barrier_before: atom.transition_barrier_before,
  })), null, 2)}

CANONICAL ENTITIES:
${JSON.stringify(dictionaries.entities, null, 2)}

CANONICAL LOCATIONS:
${JSON.stringify(dictionaries.locations, null, 2)}

SEMANTIC SCENE CONTEXT (broad hints, local atoms win):
${JSON.stringify(sceneContext, null, 2)}

Return JSON only:
{
  "beats": [{
    "source_atom_ids": ["contiguous atom ids"],
    "visual_job": "premise_image|humiliation_image|system_reveal|reaction_shot|ui_insert|remote_witness_cutaway|location_transition|physical_action|consequence|threat_reveal|cliffhanger_question|story_progression",
    "shot_job": "environment_establishing|body_state_proof|object_insert|interaction|physical_action|emotional_reaction|consequence|ui_reveal|transition",
    "depiction_mode": "current_reality|system_preview|hypothetical_preview|memory_or_flashback|document_or_screen",
    "location_id": "canonical location id",
    "physically_visible_entity_ids": [],
    "screen_visible_entity_ids": [],
    "preview_visible_entity_ids": [],
    "mentioned_only_entity_ids": [],
    "primary_entity_id": null,
    "entity_evidence": {"entity_id":"exact excerpt from grouped atoms"},
    "props": [],
    "ui_elements": [],
    "foreground_action": "specific visible present-tense action",
    "foreground_action_evidence": "exact excerpt from grouped atoms",
    "composition_intent": "specific framing, focal subject, and spatial relationship",
    "continuity_note": "local continuity only",
    "editorial_cues": [],
    "rail_exception": null
  }],
  "warnings": []
}`;
}

function groupingFindings(rows, atoms, factLedger) {
  const findings = [];
  const expected = atoms.map((atom) => atom.atom_id);
  const flattened = rows.flatMap((row) => row.source_atom_ids ?? []).map(String);
  if (flattened.length !== expected.length || !expected.every((id, index) => id === flattened[index])) {
    findings.push({ severity: "blocker", code: "editorial_atom_coverage_mismatch" });
    return findings;
  }
  const atomMap = new Map(atoms.map((atom, index) => [atom.atom_id, { atom, index }]));
  const dictionaries = canonicalDictionaries(factLedger);
  const entityIds = new Set(dictionaries.entities.map((row) => row.entity_id));
  const locationIds = new Set(dictionaries.locations.map((row) => row.location_id));
  for (const [rowIndex, row] of rows.entries()) {
    const ids = (row.source_atom_ids ?? []).map(String);
    const atomRows = ids.map((id) => atomMap.get(id));
    if (atomRows.some((value) => !value)) {
      findings.push({ severity: "blocker", code: "editorial_unknown_atom", row_index: rowIndex });
      continue;
    }
    if (atomRows.some((value, index) => index > 0 && value.index !== atomRows[index - 1].index + 1)) {
      findings.push({ severity: "blocker", code: "editorial_noncontiguous_atoms", row_index: rowIndex });
    }
    if (atomRows.slice(1).some(({ atom }) => atom.transition_barrier_before)) {
      findings.push({ severity: "blocker", code: "editorial_crossed_transition_barrier", row_index: rowIndex });
    }
    if (!locationIds.has(String(row.location_id ?? ""))) findings.push({ severity: "blocker", code: "editorial_unknown_location", row_index: rowIndex });
    const groupedText = normalizeText(atomRows.map(({ atom }) => atom.text).join(" ")).toLowerCase();
    const actionEvidence = normalizeText(row.foreground_action_evidence).toLowerCase();
    if (!actionEvidence || !groupedText.includes(actionEvidence)) {
      findings.push({ severity: "blocker", code: "editorial_foreground_action_evidence_missing", row_index: rowIndex });
    }
    for (const field of ["physically_visible_entity_ids", "screen_visible_entity_ids", "preview_visible_entity_ids", "mentioned_only_entity_ids"]) {
      for (const entityId of row[field] ?? []) {
        if (!entityIds.has(String(entityId))) findings.push({ severity: "blocker", code: "editorial_unknown_entity", row_index: rowIndex, entity_id: entityId });
      }
    }
    const visible = unique([
      ...(row.physically_visible_entity_ids ?? []),
      ...(row.screen_visible_entity_ids ?? []),
      ...(row.preview_visible_entity_ids ?? []),
    ]);
    for (const entityId of visible) {
      const evidence = normalizeText(row.entity_evidence?.[entityId]).toLowerCase();
      if (!evidence || !groupedText.includes(evidence)) findings.push({ severity: "blocker", code: "editorial_visible_entity_evidence_missing", row_index: rowIndex, entity_id: entityId });
    }
    const first = atomRows[0].atom;
    const last = atomRows.at(-1).atom;
    const nextRowFirstId = rows[rowIndex + 1]?.source_atom_ids?.[0];
    const nextRowFirst = nextRowFirstId ? atomMap.get(String(nextRowFirstId))?.atom : null;
    const duration = (nextRowFirst?.start_sec ?? last.end_sec) - first.start_sec;
    const rail = retentionRailForTime(first.start_sec);
    if ((duration < rail.min_sec - 0.05 || duration > rail.max_sec + 0.05) && !normalizeText(row.rail_exception)) {
      findings.push({ severity: "blocker", code: "editorial_retention_rail_violation", row_index: rowIndex, duration_sec: duration, rail });
    }
  }
  return findings;
}

export function normalizeEditorialGrouping(raw, atoms, factLedger, episode) {
  const rows = Array.isArray(raw?.beats) ? raw.beats : [];
  if (!rows.length) throw new Error("Editorial beat director returned no beats.");
  const findings = groupingFindings(rows, atoms, factLedger);
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  if (blockers.length) throw new Error(`Editorial beat contract failed: ${blockers.slice(0, 12).map((finding) => finding.code).join(", ")}`);
  const atomMap = new Map(atoms.map((atom) => [atom.atom_id, atom]));
  const dictionaries = canonicalDictionaries(factLedger);
  const entityMap = new Map(dictionaries.entities.map((row) => [row.entity_id, row]));
  const locationMap = new Map(dictionaries.locations.map((row) => [row.location_id, row]));
  const beats = rows.map((row) => {
    const ids = row.source_atom_ids.map(String);
    const selected = ids.map((id) => atomMap.get(id));
    const first = selected[0];
    const last = selected.at(-1);
    const startIndex = first.source_word_start_index;
    const endIndex = last.source_word_end_index;
    const visibleIds = unique([
      ...(row.physically_visible_entity_ids ?? []),
      ...(row.screen_visible_entity_ids ?? []),
      ...(row.preview_visible_entity_ids ?? []),
    ]);
    const mentionedIds = unique(row.mentioned_only_entity_ids ?? []).filter((id) => !visibleIds.includes(id));
    const scene = first.semantic_scene ?? {};
    return {
      ...scene,
      scene_id: first.scene_id ?? scene.scene_id,
      parent_scene_id: first.scene_id ?? scene.scene_id,
      visual_beat_id: `beat_w${String(startIndex).padStart(6, "0")}_w${String(endIndex).padStart(6, "0")}`,
      image_id_hint: `${episode}-w${String(startIndex).padStart(6, "0")}-w${String(endIndex).padStart(6, "0")}`,
      source_atom_ids: ids,
      source_word_start_index: startIndex,
      source_word_end_index: endIndex,
      start_sec: first.start_sec,
      end_sec: last.end_sec,
      duration_sec: Number((last.end_sec - first.start_sec).toFixed(3)),
      visual_beat_script_excerpt: normalizeText(selected.map((atom) => atom.text).join(" ")),
      visual_beat_action: normalizeText(row.foreground_action),
      visual_beat_action_evidence: normalizeText(row.foreground_action_evidence),
      visual_beat_focus: normalizeText(row.composition_intent),
      visual_job: String(row.visual_job),
      suggested_shot_job: String(row.shot_job),
      depiction_mode: String(row.depiction_mode),
      location_id: String(row.location_id),
      location: locationMap.get(String(row.location_id))?.display_name ?? String(row.location_id),
      local_location: locationMap.get(String(row.location_id))?.display_name ?? String(row.location_id),
      physically_visible_entity_ids: unique(row.physically_visible_entity_ids ?? []),
      screen_visible_entity_ids: unique(row.screen_visible_entity_ids ?? []),
      preview_visible_entity_ids: unique(row.preview_visible_entity_ids ?? []),
      mentioned_only_entity_ids: mentionedIds,
      visible_characters: visibleIds.map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      visible_subjects: visibleIds.map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      screen_visible_characters: unique(row.screen_visible_entity_ids ?? []).map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      preview_visible_characters: unique(row.preview_visible_entity_ids ?? []).map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      mentioned_only_characters: mentionedIds.map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      primary_subject: entityMap.get(String(row.primary_entity_id ?? ""))?.display_name ?? null,
      local_props: assetLabels(row.props ?? []),
      local_ui_elements: assetLabels(row.ui_elements ?? []),
      editorial_cues: unique(row.editorial_cues ?? []),
      visual_novelty_directive: normalizeText(row.composition_intent),
      local_continuity_note: normalizeText(row.continuity_note),
      rail_exception: normalizeText(row.rail_exception) || null,
      retention_rail: retentionRailForTime(first.start_sec),
      hook_visual: first.start_sec < 30,
      retention_ramp_visual: first.start_sec >= 30 && first.start_sec < 180,
    };
  });
  return { beats, findings };
}

export function editorialRetentionRailFindings(beats) {
  return (beats ?? []).flatMap((beat, index) => {
    const rail = beat.retention_rail ?? retentionRailForTime(beat.start_sec);
    const duration = Number(beat.duration_sec ?? (Number(beat.end_sec ?? 0) - Number(beat.start_sec ?? 0)));
    if (normalizeText(beat.rail_exception) || duration >= rail.min_sec - 0.05 && duration <= rail.max_sec + 0.05) return [];
    return [{
      severity: "blocker",
      code: "editorial_applied_hold_rail_violation",
      beat_index: index,
      visual_beat_id: beat.visual_beat_id ?? null,
      duration_sec: Number(duration.toFixed(3)),
      rail,
    }];
  });
}

function entityIdForName(name, factLedger) {
  const normalized = normalizeText(name).toLowerCase();
  return (factLedger?.canonical_entities ?? []).find((entity) => [entity.display_name, ...(entity.aliases ?? [])]
    .some((value) => normalizeText(value).toLowerCase() === normalized))?.entity_id ?? null;
}

function transitionEvents(atoms, factLedger) {
  const events = [];
  for (const transition of factLedger?.state_transitions ?? []) {
    const evidence = (transition.evidence ?? []).map((row) => normalizeText(row.exact_excerpt)).find(Boolean);
    const atom = atoms.find((candidate) => evidence && normalizeText(candidate.text).includes(evidence));
    if (!atom) continue;
    events.push({
      source_word_index: atom.source_word_start_index,
      entity_id: transition.entity_id,
      field: transition.state_kind,
      value: transition.to_state,
      evidence_excerpt: evidence,
    });
  }
  return events.sort((a, b) => a.source_word_index - b.source_word_index);
}

export function projectActiveStateConstraints(beats, atoms, factLedger, timedScenes = []) {
  const events = transitionEvents(atoms, factLedger);
  const states = {};
  let eventCursor = 0;
  const orderedScenes = [...(timedScenes ?? [])].sort((a, b) => Number(a.start_sec ?? 0) - Number(b.start_sec ?? 0));
  let sceneCursor = 0;
  return beats.map((beat) => {
    while (sceneCursor < orderedScenes.length && Number(orderedScenes[sceneCursor].start_sec ?? 0) <= Number(beat.start_sec ?? 0) + 0.001) {
      const scene = orderedScenes[sceneCursor];
      for (const state of scene.character_states ?? []) {
        const entityId = entityIdForName(state.character, factLedger);
        if (!entityId) continue;
        states[entityId] = {
          ...(states[entityId] ?? {}),
          ...(state.wardrobe ? { wardrobe: state.wardrobe } : {}),
          ...(state.visible_state ? { visible_state: state.visible_state } : {}),
          ...(state.state ? { status: state.state } : {}),
        };
      }
      sceneCursor += 1;
    }
    while (eventCursor < events.length && events[eventCursor].source_word_index <= Number(beat.source_word_end_index)) {
      const event = events[eventCursor];
      if (event.entity_id && event.field) {
        states[event.entity_id] = { ...(states[event.entity_id] ?? {}), [event.field]: event.value, evidence_excerpt: event.evidence_excerpt };
      }
      eventCursor += 1;
    }
    const visibleIds = unique([
      ...(beat.physically_visible_entity_ids ?? []),
      ...(beat.screen_visible_entity_ids ?? []),
      ...(beat.preview_visible_entity_ids ?? []),
    ]);
    return {
      ...beat,
      active_state_constraints: {
        location_id: beat.location_id,
        entities: Object.fromEntries(visibleIds.map((id) => [id, structuredClone(states[id] ?? {})])),
        applied_through_source_word_index: beat.source_word_end_index,
      },
    };
  });
}

export function editorialBeatCoverageFindings(beats, whisperWordCount) {
  const findings = [];
  const ordered = [...beats].sort((a, b) => a.source_word_start_index - b.source_word_start_index);
  let cursor = 0;
  for (const beat of ordered) {
    if (beat.source_word_start_index !== cursor) findings.push({ severity: "blocker", code: "beat_word_coverage_gap_or_overlap", expected: cursor, actual: beat.source_word_start_index });
    cursor = beat.source_word_end_index + 1;
  }
  if (cursor !== whisperWordCount) findings.push({ severity: "blocker", code: "beat_word_coverage_incomplete", expected: whisperWordCount, actual: cursor });
  return findings;
}

export function groupingLockHash(beats) {
  return sha256(JSON.stringify(beats.map((beat) => ({
    visual_beat_id: beat.visual_beat_id,
    image_id_hint: beat.image_id_hint,
    source_atom_ids: beat.source_atom_ids,
    source_word_start_index: beat.source_word_start_index,
    source_word_end_index: beat.source_word_end_index,
  }))));
}
