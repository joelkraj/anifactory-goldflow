import { createHash } from "node:crypto";
import { sanitizeBackgroundPopulation } from "./background-population-utils.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeWord(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeEvidenceText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean).map(String))];
}

function canonicalId(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
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

function smallIntegerWords(value) {
  const number = Number(value);
  const ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  if (!Number.isInteger(number) || number < 0 || number > 99) return null;
  if (number < 20) return [ones[number]];
  return [tens[Math.floor(number / 10)], ...(number % 10 ? [ones[number % 10]] : [])];
}

function spokenExpansionVariants(word) {
  const multiplier = String(word?.normalized ?? "").match(/^(\d{1,2})x$/);
  if (!multiplier) return [];
  const numberWords = smallIntegerWords(multiplier[1]);
  if (!numberWords) return [];
  return Number(multiplier[1]) === 0
    ? [[...numberWords, "times"], [...numberWords, "x"]]
    : [[...numberWords, "x"]];
}

function localAlignmentScore(scriptWords, scriptIndex, timedWords, timedIndex, horizon = 14) {
  let scriptCursor = scriptIndex;
  let timedCursor = timedIndex;
  let matches = 0;
  let gaps = 0;
  let openingRun = 0;
  let opening = true;
  const scriptLimit = Math.min(scriptWords.length, scriptIndex + horizon);
  const timedLimit = Math.min(timedWords.length, timedIndex + horizon + 6);
  while (scriptCursor < scriptLimit && timedCursor < timedLimit) {
    const scriptToken = scriptWords[scriptCursor]?.normalized;
    const timedToken = timedWords[timedCursor]?.normalized;
    if (scriptToken && scriptToken === timedToken) {
      matches += 1;
      if (opening) openingRun += 1;
      scriptCursor += 1;
      timedCursor += 1;
      continue;
    }
    opening = false;
    if (scriptWords[scriptCursor + 1]?.normalized === timedToken) {
      scriptCursor += 1;
      gaps += 1;
      continue;
    }
    if (scriptToken === timedWords[timedCursor + 1]?.normalized) {
      timedCursor += 1;
      gaps += 1;
      continue;
    }
    scriptCursor += 1;
    timedCursor += 1;
    gaps += 1;
  }
  return matches * 4 + openingRun * 3 - gaps * 0.35;
}

function uniqueNgramPositions(words, size) {
  const positions = new Map();
  for (let index = 0; index <= words.length - size; index += 1) {
    const tokens = words.slice(index, index + size).map((word) => word.normalized);
    if (tokens.some((token) => !token)) continue;
    const key = tokens.join("\u001f");
    const existing = positions.get(key);
    positions.set(key, existing == null ? index : -1);
  }
  return positions;
}

function longestIncreasingAnchors(anchors) {
  if (!anchors.length) return [];
  const tails = [];
  const tailIndexes = [];
  const previous = Array(anchors.length).fill(-1);
  for (let index = 0; index < anchors.length; index += 1) {
    const value = anchors[index].whisper_index;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tails[middle] < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    previous[index] = low > 0 ? tailIndexes[low - 1] : -1;
    tailIndexes[low] = index;
  }
  const selected = [];
  let cursor = tailIndexes[tails.length - 1];
  while (cursor >= 0) {
    selected.push(anchors[cursor]);
    cursor = previous[cursor];
  }
  return selected.reverse();
}

function alignScriptWords(scriptWords, timedWords, _lookahead = 64) {
  if (!scriptWords.length || !timedWords.length) return [];
  const ngramSize = 5;
  const scriptPositions = uniqueNgramPositions(scriptWords, ngramSize);
  const timedPositions = uniqueNgramPositions(timedWords, ngramSize);
  const candidates = [];
  for (const [key, scriptIndex] of scriptPositions) {
    const whisperIndex = timedPositions.get(key);
    if (scriptIndex < 0 || whisperIndex == null || whisperIndex < 0) continue;
    candidates.push({ script_index: scriptIndex, whisper_index: whisperIndex });
  }
  candidates.sort((left, right) => left.script_index - right.script_index || left.whisper_index - right.whisper_index);
  const anchors = longestIncreasingAnchors(candidates);
  const endpoints = [
    { script_index: 0, whisper_index: 0 },
    ...anchors.filter((anchor) => anchor.script_index > 0 && anchor.script_index < scriptWords.length - 1),
    { script_index: scriptWords.length - 1, whisper_index: timedWords.length - 1 },
  ];
  const deduped = [];
  for (const anchor of endpoints) {
    const prior = deduped.at(-1);
    if (prior && anchor.script_index === prior.script_index) {
      prior.whisper_index = Math.max(prior.whisper_index, anchor.whisper_index);
      continue;
    }
    if (prior && anchor.whisper_index <= prior.whisper_index) continue;
    deduped.push({ ...anchor });
  }
  if (deduped.at(-1)?.script_index !== scriptWords.length - 1) {
    deduped.push({ script_index: scriptWords.length - 1, whisper_index: timedWords.length - 1 });
  }

  let segment = 0;
  let previousWhisperIndex = 0;
  const aligned = scriptWords.map((word, scriptIndex) => {
    while (segment + 1 < deduped.length - 1 && scriptIndex > deduped[segment + 1].script_index) segment += 1;
    const left = deduped[segment];
    const right = deduped[Math.min(segment + 1, deduped.length - 1)];
    const denominator = Math.max(1, right.script_index - left.script_index);
    const ratio = (scriptIndex - left.script_index) / denominator;
    const projected = Math.round(left.whisper_index + ratio * (right.whisper_index - left.whisper_index));
    const whisperIndex = Math.max(previousWhisperIndex, Math.min(timedWords.length - 1, projected));
    previousWhisperIndex = whisperIndex;
    return {
      ...word,
      whisper_index: whisperIndex,
      alignment_score: timedWords[whisperIndex]?.normalized === word.normalized ? 1 : 0.9,
      alignment_method: "unique_ngram_anchor_interpolation",
    };
  });
  for (let scriptIndex = 0; scriptIndex < aligned.length; scriptIndex += 1) {
    const variants = spokenExpansionVariants(aligned[scriptIndex]);
    if (!variants.length) continue;
    const projected = aligned[scriptIndex].whisper_index;
    const minimum = Math.max(0, Number(aligned[scriptIndex - 1]?.whisper_index ?? -1) + 1, projected - 10);
    const maximum = Math.min(timedWords.length, projected + 11);
    for (const variant of variants) {
      let matched = false;
      for (let index = minimum; index < maximum; index += 1) {
        if (!variant.every((token, offset) => timedWords[index + offset]?.normalized === token)) continue;
        aligned[scriptIndex] = {
          ...aligned[scriptIndex],
          whisper_index: index,
          whisper_end_index: index + variant.length - 1,
          alignment_score: 1,
          spoken_expansion: variant.join(" "),
        };
        matched = true;
        break;
      }
      if (matched) break;
    }
  }
  return aligned;
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

function evidenceAtomSpan(atoms, evidence, maxAtoms = 8) {
  const target = normalizeText(evidence).toLowerCase();
  if (!target) return null;
  for (let start = 0; start < atoms.length; start += 1) {
    let combined = "";
    const firstAtomText = normalizeText(atoms[start].text).toLowerCase();
    for (let end = start; end < Math.min(atoms.length, start + maxAtoms); end += 1) {
      combined = normalizeText(`${combined} ${atoms[end].text}`).toLowerCase();
      const matchIndex = combined.indexOf(target);
      if (matchIndex >= 0 && matchIndex < firstAtomText.length) return { start_atom: atoms[start], end_atom: atoms[end] };
      if (combined.length > target.length * 3 + 500) break;
    }
  }
  return null;
}

function evidenceTransitionAtomIds(atoms, factLedger) {
  const barriers = new Set();
  for (const transition of factLedger?.state_transitions ?? []) {
    const excerpt = transitionEvidenceExcerpt(transition);
    const span = evidenceAtomSpan(atoms, excerpt);
    if (span) barriers.add(span.start_atom.atom_id);
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
  const scriptWords = alignScriptWords(wordsWithOffsets(script), timedWords, Number(options.lookahead ?? 64));
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
  const durationAnomalies = atoms.filter((atom) => Number(atom.duration_sec) > Number(options.maxAtomDurationSec ?? 45));
  if (durationAnomalies.length) {
    throw new Error(`Editorial atom timing alignment failed: ${durationAnomalies.slice(0, 8).map((atom) => `${atom.atom_id}:${atom.duration_sec}s`).join(", ")}`);
  }
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

export function retimeLockedEditorialBeats(lockedBeats, freshAtoms) {
  const beats = Array.isArray(lockedBeats) ? lockedBeats : [];
  const atoms = Array.isArray(freshAtoms) ? freshAtoms : [];
  if (!beats.length || !atoms.length) throw new Error("Locked beat retiming requires existing beats and fresh transcript atoms.");

  const lockedAtomIds = beats.flatMap((beat) => (beat.source_atom_ids ?? []).map(String));
  if (lockedAtomIds.length !== atoms.length) {
    throw new Error(`Locked beat retiming atom count changed (${lockedAtomIds.length} locked, ${atoms.length} fresh). Explicit regrouping is required.`);
  }
  if (new Set(lockedAtomIds).size !== lockedAtomIds.length) {
    throw new Error("Locked beat retiming found duplicate source atoms in the approved grouping.");
  }

  let atomCursor = 0;
  return beats.map((beat) => {
    const atomCount = Array.isArray(beat.source_atom_ids) ? beat.source_atom_ids.length : 0;
    if (!atomCount) throw new Error(`Locked beat ${beat.visual_beat_id ?? "unknown"} has no source atoms.`);
    const selected = atoms.slice(atomCursor, atomCursor + atomCount);
    atomCursor += atomCount;
    if (selected.length !== atomCount) throw new Error(`Locked beat ${beat.visual_beat_id ?? "unknown"} exceeds the fresh atom timeline.`);

    const freshExcerpt = normalizeText(selected.map((atom) => atom.text).join(" "));
    const lockedExcerpt = normalizeText(beat.visual_beat_script_excerpt);
    if (freshExcerpt !== lockedExcerpt) {
      throw new Error(`Locked beat ${beat.visual_beat_id ?? "unknown"} no longer matches the approved script excerpt. Explicit regrouping is required.`);
    }

    const first = selected[0];
    const last = selected.at(-1);
    const sceneDurations = new Map();
    for (const atom of selected) {
      const sceneId = String(atom.scene_id ?? "").trim();
      if (!sceneId) continue;
      const duration = Math.max(0, Number(atom.end_sec ?? 0) - Number(atom.start_sec ?? 0));
      sceneDurations.set(sceneId, (sceneDurations.get(sceneId) ?? 0) + duration);
    }
    const dominantSceneId = [...sceneDurations.entries()]
      .sort((left, right) => right[1] - left[1])[0]?.[0] ?? first.scene_id ?? beat.parent_scene_id ?? beat.scene_id ?? null;
    const dominantAtom = selected.find((atom) => atom.scene_id === dominantSceneId) ?? first;
    return {
      ...beat,
      parent_scene_id: dominantSceneId,
      scene_id: dominantSceneId,
      semantic_location: dominantAtom.semantic_location ?? beat.semantic_location ?? null,
      semantic_scene: dominantAtom.semantic_scene ?? beat.semantic_scene ?? null,
      source_atom_ids: selected.map((atom) => atom.atom_id),
      source_word_start_index: first.source_word_start_index,
      source_word_end_index: last.source_word_end_index,
      start_sec: first.start_sec,
      end_sec: last.end_sec,
      duration_sec: Number(Math.max(0, last.end_sec - first.start_sec).toFixed(3)),
      visual_beat_script_excerpt: freshExcerpt,
      timing_repair: {
        identity_preserved: true,
        prior_source_atom_ids: (beat.source_atom_ids ?? []).map(String),
        prior_scene_id: beat.parent_scene_id ?? beat.scene_id ?? null,
        repaired_scene_id: dominantSceneId,
      },
    };
  });
}

function canonicalDictionaries(factLedger) {
  const entities = (factLedger?.canonical_entities ?? factLedger?.entities ?? []).map((row) => ({
    entity_id: canonicalId(row.entity_id),
    display_name: row.display_name ?? row.label ?? row.entity_id,
    aliases: row.aliases ?? [],
    kind: row.kind ?? "person",
  })).filter((row) => row.entity_id);
  const locations = (factLedger?.canonical_locations ?? factLedger?.locations ?? []).map((row) => ({
    location_id: canonicalId(row.location_id),
    display_name: row.display_name ?? row.label ?? row.location_id,
    aliases: row.aliases ?? [],
  })).filter((row) => row.location_id);
  const props = (factLedger?.canonical_props ?? factLedger?.props ?? []).map((row) => ({
    prop_id: canonicalId(row.prop_id),
    display_name: row.display_name ?? row.label ?? row.prop_id,
    aliases: row.aliases ?? [],
  })).filter((row) => row.prop_id);
  const uiElements = (factLedger?.canonical_ui_motifs ?? factLedger?.ui_motifs ?? []).map((row) => ({
    ui_id: canonicalId(row.ui_id),
    display_name: row.display_name ?? row.label ?? row.ui_id,
    aliases: row.aliases ?? [],
  })).filter((row) => row.ui_id);
  return { entities, locations, props, uiElements };
}

function canonicalAssetId(value, rows, idField) {
  const explicit = value && typeof value === "object"
    ? canonicalId(value[idField] ?? value.canonical_id)
    : "";
  if (explicit) return explicit;
  const label = canonicalId(assetLabel(value));
  if (!label) return null;
  const matches = (rows ?? []).filter((row) => [
    row[idField],
    row.display_name,
    ...(row.aliases ?? []),
  ].some((candidate) => canonicalId(candidate) === label));
  return matches.length === 1 ? matches[0][idField] : null;
}

export function buildEditorialDirectorPrompt(atoms, factLedger, timedScenes = [], options = {}) {
  const animationEnabled = Boolean(options.animationEnabled);
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
- Identity-bearing actors include people, creatures, bosses, guardians, constructs, summons, and recurring creature systems. A nonhuman actor that moves, attacks, reacts, is fought, or is physically contacted belongs in the appropriate visible entity list, never in props.
- Resolve first-person I/me/my physical actions to the established narrator/protagonist entity when the fact ledger and scene context identify that person; do not make the acting protagonist disappear because their proper name is omitted locally.
- Select only canonical entity_id and location_id values below. For every recurring/signature prop or UI motif represented in the canonical dictionaries, return its exact prop_id or ui_id alongside the local label; use null only for a truly one-off item absent from the dictionary. If the narration gives no supported visible person, an object/UI/environment beat is valid.
- location_id is the physical camera setting of the foreground action. A destination, landmark, or room mentioned in the distance does not become the beat location until the narration places the visible subjects there.
- Composition is beat-specific. There is no global wide or close-up bias.
- Background population is neither a default nor forbidden. Use presence=explicit when the grouped atoms name a crowd/group. Use presence=implied only when a concrete local social situation logically needs anonymous people to read correctly—for example an active hearing, ceremony, class, market, public humiliation, audience reaction, staffed workplace, or assembled formation—even if the exact clause does not use the word crowd. A merely public location is insufficient. Use presence=none for private, lonely, abandoned, after-hours, isolated, or object/UI-only beats.
- Anonymous background population is not a canonical character and does not belong in physically_visible_entity_ids. Give it a concrete description, exact local evidence for the social situation, and subordinate staging that preserves the focal subject.
- Do not expand a collective phrase such as "four attackers," "the hunters," or "the crew" into every known individual identity. Keep the counted or named group in background_population unless the grouped atoms explicitly identify an individual and that identity is necessary to the decisive foreground moment.
- For dense physical action, freeze one decisive instant with at most three individually readable foreground actors. Keep additional evidenced participants as a subordinate, spatially separate background group. Preserve the narrated count and role without asking one frame to perform every attack simultaneously.
- Each beat has one decisive visible job and foreground action. The foreground action must be a direct concrete paraphrase of its exact foreground_action_evidence. Do not infer an injury, emotion, pose, wardrobe, or intent that the grouped atoms and supplied scene facts do not establish.
${animationEnabled ? `- ANIMATION MODE IS LOCKED FOR THIS PRODUCTION. Author animation_intent for every beat. This is pre-image direction: choose an animation-ready starting composition, one coherent subject action, one camera move, restrained environmental motion, a readable end state, continuity into the next shot, and immutable elements. UI/screen shots remain eligible; exact generated text legibility is not required.
- Set eligibility=animate when generated motion adds story value. Use still_preferred only when motion would undermine a decisive frozen tableau. Never invent an action beyond local evidence.
- Choose preferred_generation_duration_sec from 5 through 12 based on the complete action, not the still-cut length. Set sequence_eligible_with_next=true only when this beat and the immediately following beat can play as one uninterrupted shot in the same physical scene, depiction mode, identities, wardrobe, and screen direction.
- Author the end frame deliberately. camera_end_state and end_frame_composition must describe a stable terminal frame that can hand cleanly into the next beat; continuity_bridge must say what remains spatially unchanged across that handoff.
- Favor animation-ready staging: clear silhouettes, visible limbs, unambiguous contact, movement room, and separated depth planes. For physical contact, lock the contact point and keep the action small. For locomotion, state direction and destination. For reactions, prefer eyes, posture, breathing, hair, and one restrained gesture.` : "- ANIMATION MODE IS DISABLED. Do not return animation_intent or animation-specific direction."}

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

CANONICAL PROPS:
${JSON.stringify(dictionaries.props, null, 2)}

CANONICAL UI MOTIFS:
${JSON.stringify(dictionaries.uiElements, null, 2)}

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
    "props": [{"prop_id":"canonical prop id or null for a one-off","label":"exact local prop label"}],
    "ui_elements": [{"ui_id":"canonical UI id or null for a one-off","label":"exact local UI label"}],
    "background_population": {
      "presence": "none|implied|explicit",
      "description": "anonymous background people or null",
      "evidence": "exact local excerpt supporting the social situation or null",
      "staging": "where they appear and how they support, not compete with, the focal beat or null"
    },
    "foreground_action": "specific visible present-tense action",
    "foreground_action_evidence": "exact excerpt from grouped atoms",
    "composition_intent": "specific framing, focal subject, and spatial relationship",
    "continuity_note": "local continuity only",
    ${animationEnabled ? `"animation_intent": {
      "eligibility": "animate|still_preferred",
      "shot_class": "portrait_reaction|dialogue_pair|physical_contact|locomotion_action|object_insert|ui_or_screen|environment_establishing|effect_or_impact",
      "start_state": "visible state at the accepted first frame",
      "subject_motion": "one evidence-constrained action",
      "camera_motion": "one continuous camera move or locked camera",
      "environmental_motion": "restrained secondary motion",
      "end_state": "readable end pose/state",
      "timing_priority": "early_action|even_action|settle_hold",
      "animation_ready_composition": "how the source still should leave room for this motion",
      "continuity_bridge": "how the ending supports the following beat",
      "sequence_eligible_with_next": false,
      "preferred_generation_duration_sec": 5,
      "camera_end_state": "framing and camera position at the terminal frame",
      "end_frame_composition": "subject positions, gaze, props, and negative space at the terminal frame",
      "locked_elements": ["identity, wardrobe, anatomy, props, spatial facts"]
    },` : ""}
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
  const propIds = new Set(dictionaries.props.map((row) => row.prop_id));
  const uiIds = new Set(dictionaries.uiElements.map((row) => row.ui_id));
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
    for (const prop of row.props ?? []) {
      const propId = prop && typeof prop === "object" ? canonicalId(prop.prop_id ?? prop.canonical_id) : "";
      if (propId && !propIds.has(propId)) findings.push({ severity: "blocker", code: "editorial_unknown_prop", row_index: rowIndex, prop_id: propId });
    }
    for (const ui of row.ui_elements ?? []) {
      const uiId = ui && typeof ui === "object" ? canonicalId(ui.ui_id ?? ui.canonical_id) : "";
      if (uiId && !uiIds.has(uiId)) findings.push({ severity: "blocker", code: "editorial_unknown_ui", row_index: rowIndex, ui_id: uiId });
    }
    const groupedText = normalizeEvidenceText(atomRows.map(({ atom }) => atom.text).join(" "));
    const actionEvidence = normalizeEvidenceText(row.foreground_action_evidence);
    if (!actionEvidence || !groupedText.includes(actionEvidence)) {
      // Source-atom membership remains enforced above; authored paraphrase evidence is advisory.
      findings.push({ severity: "warning", code: "editorial_foreground_action_evidence_missing", row_index: rowIndex });
    }
    const backgroundPopulation = sanitizeBackgroundPopulation(row.background_population);
    if (backgroundPopulation.presence !== "none") {
      const populationEvidence = normalizeEvidenceText(backgroundPopulation.evidence);
      if (!backgroundPopulation.description || !backgroundPopulation.staging) {
        findings.push({ severity: "blocker", code: "editorial_background_population_contract_incomplete", row_index: rowIndex });
      }
      if (!populationEvidence || !groupedText.includes(populationEvidence)) {
        findings.push({ severity: "blocker", code: "editorial_background_population_evidence_missing", row_index: rowIndex });
      }
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
      const evidence = normalizeEvidenceText(row.entity_evidence?.[entityId]);
      if (!evidence || !groupedText.includes(evidence)) findings.push({ severity: "warning", code: "editorial_visible_entity_evidence_missing", row_index: rowIndex, entity_id: entityId });
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

export function normalizeEditorialGrouping(raw, atoms, factLedger, episode, options = {}) {
  const animationEnabled = Boolean(options.animationEnabled);
  const rows = Array.isArray(raw?.beats) ? raw.beats.map((row) => ({
    ...row,
    location_id: canonicalId(row.location_id),
    physically_visible_entity_ids: (row.physically_visible_entity_ids ?? []).map(canonicalId).filter(Boolean),
    screen_visible_entity_ids: (row.screen_visible_entity_ids ?? []).map(canonicalId).filter(Boolean),
    preview_visible_entity_ids: (row.preview_visible_entity_ids ?? []).map(canonicalId).filter(Boolean),
    mentioned_only_entity_ids: (row.mentioned_only_entity_ids ?? []).map(canonicalId).filter(Boolean),
    primary_entity_id: canonicalId(row.primary_entity_id) || null,
    entity_evidence: Object.fromEntries(Object.entries(row.entity_evidence ?? {}).map(([id, evidence]) => [canonicalId(id), evidence])),
    background_population: sanitizeBackgroundPopulation(row.background_population),
  })) : [];
  if (!rows.length) throw new Error("Editorial beat director returned no beats.");
  const findings = groupingFindings(rows, atoms, factLedger);
  if (animationEnabled) {
    rows.forEach((row, rowIndex) => {
      const intent = row.animation_intent;
      const valid = intent && typeof intent === "object"
        && ["animate", "still_preferred"].includes(String(intent.eligibility ?? ""))
        && [
          "portrait_reaction", "dialogue_pair", "physical_contact", "locomotion_action",
          "object_insert", "ui_or_screen", "environment_establishing", "effect_or_impact",
        ].includes(String(intent.shot_class ?? ""))
        && String(intent.subject_motion ?? "").trim()
        && String(intent.camera_motion ?? "").trim()
        && String(intent.end_state ?? "").trim();
      if (!valid) findings.push({ severity: "blocker", code: "editorial_animation_intent_missing_or_invalid", row_index: rowIndex });
    });
  }
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  if (blockers.length) throw new Error(`Editorial beat contract failed: ${blockers.slice(0, 12).map((finding) => `${finding.code}[row=${finding.row_index ?? "?"}${finding.entity_id ? `,entity=${finding.entity_id}` : ""}]`).join(", ")}`);
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
      visible_entities: visibleIds.map((id) => ({
        entity_id: id,
        display_name: entityMap.get(id)?.display_name ?? id,
        kind: entityMap.get(id)?.kind ?? "person",
      })),
      visible_entity_kinds: Object.fromEntries(visibleIds.map((id) => [id, entityMap.get(id)?.kind ?? "person"])),
      visible_characters: visibleIds.map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      visible_subjects: visibleIds.map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      screen_visible_characters: unique(row.screen_visible_entity_ids ?? []).map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      preview_visible_characters: unique(row.preview_visible_entity_ids ?? []).map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      mentioned_only_characters: mentionedIds.map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      primary_subject: entityMap.get(String(row.primary_entity_id ?? ""))?.display_name ?? null,
      local_props: assetLabels(row.props ?? []),
      local_ui_elements: assetLabels(row.ui_elements ?? []),
      local_prop_ids: (row.props ?? []).map((value) => canonicalAssetId(value, dictionaries.props, "prop_id")),
      local_ui_ids: (row.ui_elements ?? []).map((value) => canonicalAssetId(value, dictionaries.uiElements, "ui_id")),
      background_population: sanitizeBackgroundPopulation(row.background_population),
      editorial_cues: unique(row.editorial_cues ?? []),
      visual_novelty_directive: normalizeText(row.composition_intent),
      local_continuity_note: normalizeText(row.continuity_note),
      ...(animationEnabled ? { animation_intent: row.animation_intent } : {}),
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
    // Rails guide editorial rhythm; sub-second timing alignment variance is not a production blocker.
    if (normalizeText(beat.rail_exception) || duration >= rail.min_sec - 0.75 && duration <= rail.max_sec + 0.75) return [];
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
  const entity = (factLedger?.canonical_entities ?? []).find((row) => [row.display_name, ...(row.aliases ?? [])]
    .some((value) => normalizeText(value).toLowerCase() === normalized));
  return entity?.entity_id ? canonicalId(entity.entity_id) : null;
}

function transitionEvents(atoms, factLedger) {
  const events = [];
  for (const transition of factLedger?.state_transitions ?? []) {
    const evidence = transitionEvidenceExcerpt(transition);
    const span = evidenceAtomSpan(atoms, evidence);
    if (!span) continue;
    const stateValue = String(transition.to_state ?? "");
    const explicitTransient = /\b(?:brief|briefly|temporary|temporarily|momentary|momentarily)\b/i.test(stateValue);
    const collisionActionMisclassifiedAsInjury = String(transition.state_kind ?? "").toLowerCase() === "injury"
      && /^(?:thrown|knocked|slammed|crashed|hurled|sent)\b/i.test(stateValue)
      && /\b(?:through|into|against|across)\b/i.test(stateValue);
    events.push({
      source_word_index: span.end_atom.source_word_end_index,
      entity_id: canonicalId(transition.entity_id),
      field: transition.state_kind,
      value: transition.to_state,
      from_value: transition.from_state,
      evidence_excerpt: evidence,
      transient: explicitTransient || collisionActionMisclassifiedAsInjury,
    });
  }
  return events.sort((a, b) => a.source_word_index - b.source_word_index);
}

function bindingVisualStateValue(field, value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (/^(?:not\s+(?:specified|established|known|applicable)|unknown|unspecified|none|n\/a)\.?$/i.test(normalized)) return null;
  if (/^(?:not|no|without)\b/i.test(normalized)) return null;
  if (/\b(?:is not established|not visibly identified|not yet established)\b/i.test(normalized)) return null;
  return normalized;
}

export function projectActiveStateConstraints(beats, atoms, factLedger, timedScenes = []) {
  const events = transitionEvents(atoms, factLedger);
  const states = {};
  const transientExpirations = new Map();
  let eventCursor = 0;
  return beats.map((beat) => {
    while (eventCursor < events.length && events[eventCursor].source_word_index <= Number(beat.source_word_end_index)) {
      const event = events[eventCursor];
      const value = bindingVisualStateValue(event.field, event.value);
      if (event.entity_id && event.field && value) {
        states[event.entity_id] = {
          ...(states[event.entity_id] ?? {}),
          [event.field]: value,
          state_evidence: {
            ...(states[event.entity_id]?.state_evidence ?? {}),
            [event.field]: event.evidence_excerpt,
          },
        };
        if (event.transient) transientExpirations.set(`${event.entity_id}:${event.field}`, event.source_word_index);
      }
      eventCursor += 1;
    }
    const visibleIds = unique([
      ...(beat.physically_visible_entity_ids ?? []),
      ...(String(beat.depiction_mode ?? "") === "current_reality" ? beat.screen_visible_entity_ids ?? [] : []),
    ]);
    const scene = (timedScenes ?? []).find((row) => row.scene_id === (beat.parent_scene_id ?? beat.scene_id))
      ?? sceneForTime(timedScenes, Number(beat.start_sec ?? 0), Number(beat.end_sec ?? beat.start_sec ?? 0));
    for (const state of scene?.character_states ?? []) {
      const entityId = entityIdForName(state.character, factLedger);
      const wardrobe = bindingVisualStateValue("wardrobe", state.wardrobe);
      if (!entityId || !visibleIds.includes(entityId) || !wardrobe || states[entityId]?.wardrobe !== undefined) continue;
      states[entityId] = { ...(states[entityId] ?? {}), wardrobe };
    }
    const projectedBeat = {
      ...beat,
      active_state_constraints: {
        location_id: beat.location_id,
        entities: Object.fromEntries(visibleIds.map((id) => [id, structuredClone(states[id] ?? {})])),
        applied_through_source_word_index: beat.source_word_end_index,
      },
    };
    for (const [key, expiresAt] of transientExpirations) {
      if (expiresAt > Number(beat.source_word_end_index)) continue;
      const splitAt = key.lastIndexOf(":");
      const entityId = key.slice(0, splitAt);
      const field = key.slice(splitAt + 1);
      if (states[entityId]) {
        delete states[entityId][field];
        if (states[entityId].state_evidence) {
          delete states[entityId].state_evidence[field];
          if (!Object.keys(states[entityId].state_evidence).length) delete states[entityId].state_evidence;
        }
      }
      transientExpirations.delete(key);
    }
    return projectedBeat;
  });
}

function transitionEvidenceExcerpt(transition) {
  const explicit = normalizeText(transition?.transition_evidence_excerpt);
  if (explicit) return explicit;
  const legacyEvidence = (transition?.evidence ?? []).map((row) => normalizeText(row.exact_excerpt)).filter(Boolean);
  return legacyEvidence.at(-1) ?? "";
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
