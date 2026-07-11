#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codexCallMetadataPath, isCodexCacheCompatible, readCodexCallMetadata, runCodexCli } from "./lib/codex-cli-runner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = parseFlags(process.argv.slice(2));

function parseFlags(parts) {
  const parsed = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const value = parts[index + 1] && !parts[index + 1].startsWith("--") ? parts[index + 1] : "true";
    parsed[key] = value;
    if (value !== "true") index += 1;
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeComparable(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function words(value) {
  return normalizeComparable(value).split(/\s+/).filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

function extractJson(content) {
  const raw = String(content ?? "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error("Codex output did not contain a valid JSON object.");
}

async function runCodexJson(prompt, stageName, callDir, { force = false, timeoutMs = 8 * 60_000 } = {}) {
  const outputPath = path.join(callDir, `${stageName}-output.txt`);
  if (!force) {
    const cached = await fs.readFile(outputPath, "utf8").catch(() => null);
    const metadata = await readCodexCallMetadata(outputPath);
    if (cached && isCodexCacheCompatible(metadata, {
      model: flags.model ?? flags["llm-model"] ?? null,
      reasoningEffort: flags["reasoning-effort"] ?? null,
      promptHash: sha256(prompt),
    })) {
      console.error(`planner A/B ${stageName}: reusing ${outputPath}`);
      return {
        parsed: extractJson(cached),
        outputPath,
        reused: true,
        model: metadata.model,
        reasoning_effort: metadata.reasoning_effort,
        codex_cli_path: metadata.codex_cli_path,
        codex_cli_version: metadata.codex_cli_version,
      };
    }
  }
  await fs.mkdir(callDir, { recursive: true });
  const attempts = Math.max(1, Number(flags["codex-call-attempts"] ?? 2));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const attemptPath = path.join(callDir, `${stageName}-attempt-${attempt}-output.txt`);
    try {
      console.error(`planner A/B ${stageName}: Codex attempt ${attempt}/${attempts}`);
      const call = await runCodexCli({
        prompt,
        stageName,
        repoRoot,
        outputPath: attemptPath,
        model: flags.model ?? flags["llm-model"] ?? null,
        reasoningEffort: flags["reasoning-effort"] ?? null,
        timeoutMs,
      });
      const parsed = extractJson(call.content);
      await fs.copyFile(attemptPath, outputPath);
      await fs.copyFile(codexCallMetadataPath(attemptPath), codexCallMetadataPath(outputPath));
      return {
        parsed,
        outputPath,
        reused: false,
        model: call.model,
        reasoning_effort: call.reasoning_effort,
        codex_cli_path: call.codex_cli_path,
        codex_cli_version: call.codex_cli_version,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`Codex failed for ${stageName}`);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function semanticCandidate(scene) {
  return {
    scene_id: scene.scene_id,
    title: scene.title,
    location: scene.location,
    time: scene.time,
    visible_subjects: scene.visible_subjects ?? [],
    primary_subject: scene.primary_subject ?? null,
    character_states: (scene.character_states ?? []).map((state) => ({
      character: state.character,
      visible_state: state.visible_state ?? null,
      wardrobe: state.wardrobe ?? null,
    })),
    props: scene.props ?? [],
    ui_text_on_screen: scene.ui_text_on_screen ?? [],
  };
}

function referenceScopeOverlay(visualRefs, variantBeats) {
  const visibleScenesByName = new Map();
  for (const beat of variantBeats) {
    const sceneId = String(beat.parent_scene_id ?? beat.scene_id ?? "");
    for (const name of beat.visible_characters ?? []) {
      const key = normalizeComparable(name);
      if (!key || !sceneId) continue;
      if (!visibleScenesByName.has(key)) visibleScenesByName.set(key, new Set());
      visibleScenesByName.get(key).add(sceneId);
    }
  }
  const scopeAdditions = [];
  const referenceTargets = (visualRefs.reference_targets ?? []).map((target) => {
    if (String(target.kind ?? "").toLowerCase() !== "character_state") return target;
    const keys = unique([target.subject, target.character].map(normalizeComparable));
    const additions = unique(keys.flatMap((key) => [...(visibleScenesByName.get(key) ?? [])]));
    if (!additions.length) return target;
    const original = Array.isArray(target.scene_ids) ? target.scene_ids.map(String) : [];
    const sceneIds = unique([...original, ...additions]);
    const added = sceneIds.filter((sceneId) => !original.includes(sceneId));
    if (added.length) scopeAdditions.push({ ref_id: target.ref_id, added_scene_ids: added, reason: "exact canonical visible-character match from editorial beat" });
    return { ...target, scene_ids: sceneIds };
  });
  return {
    ...visualRefs,
    schema: "goldflow_visual_reference_plan_ab_scope_overlay_v1",
    reference_targets: referenceTargets,
    diagnostic_scope_overlay: {
      policy: "Only exact normalized character display-name matches add scene scope. No replacement refs are authored or guessed.",
      additions: scopeAdditions,
    },
  };
}

function atomFromBeat(beat) {
  return {
    atom_id: String(beat.visual_beat_id),
    scene_id: String(beat.parent_scene_id ?? beat.scene_id),
    start_sec: Number(beat.start_sec),
    end_sec: Number(beat.end_sec ?? (Number(beat.start_sec) + Number(beat.duration_sec))),
    text: normalizeText(beat.visual_beat_script_excerpt),
  };
}

function buildFactLedgerPrompt(atoms, semanticCandidates) {
  return `Build a factual story continuity ledger for this timed narration excerpt.

You are a continuity indexer, not a visual director. TIMED NARRATION is the sole story authority. SEMANTIC CANDIDATES are untrusted extraction hints: retain only facts supported by the narration. Do not write camera direction, composition, visual jobs, image prompts, retention advice, or reference-generation decisions.

Requirements:
- Canonicalize each recurring named person, creature, organization, and meaningful group to one stable snake_case entity_id. Preserve aliases separately.
- Canonicalize each physically distinct location to one stable snake_case location_id. A new visible area inside a larger venue is a separate location when its architecture or spatial function changes.
- For every atom, distinguish physically visible entities, entities visible through a screen/replay/UI, and entities merely mentioned.
- Record only explicit appearance, wardrobe, injury, prop, UI, action, and state-transition facts. Abstract humiliation, poverty, fear, or social ruin is not physical grime or damaged clothing unless the narration says so.
- evidence_excerpt must be exact contiguous words copied from that atom's text.
- Every input atom_id must appear exactly once in atom_facts and in the original order.
- Use confidence "explicit" for stated facts and "supported_inference" only when physical continuity requires a conservative inference. Explain every supported inference in warnings.

TIMED NARRATION:
${JSON.stringify(atoms, null, 2)}

SEMANTIC CANDIDATES:
${JSON.stringify(semanticCandidates, null, 2)}

Return JSON only:
{
  "entities": [{"entity_id":"...","display_name":"...","aliases":[],"kind":"person|creature|group|organization|object"}],
  "locations": [{"location_id":"...","label":"...","parent_location_id":null,"aliases":[]}],
  "atom_facts": [{
    "atom_id":"...",
    "location_id":"...",
    "physically_visible_entity_ids":[],
    "screen_visible_entity_ids":[],
    "mentioned_only_entity_ids":[],
    "explicit_actions":[],
    "props":[],
    "ui_elements":[],
    "state_changes":[],
    "evidence_excerpt":"exact source words",
    "confidence":"explicit|supported_inference"
  }],
  "continuity_transitions": [{"after_atom_id":"...","entity_id":"...","field":"location|wardrobe|injury|status|possession","from":"...","to":"...","evidence_excerpt":"exact source words"}],
  "warnings": []
}`;
}

function validateFactLedger(raw, atoms) {
  const entities = Array.isArray(raw?.entities) ? raw.entities : [];
  const locations = Array.isArray(raw?.locations) ? raw.locations : [];
  const atomFacts = Array.isArray(raw?.atom_facts) ? raw.atom_facts : [];
  const expectedIds = atoms.map((atom) => atom.atom_id);
  const actualIds = atomFacts.map((fact) => String(fact.atom_id ?? ""));
  if (actualIds.length !== expectedIds.length || !expectedIds.every((id, index) => id === actualIds[index])) {
    throw new Error(`Fact ledger atom coverage mismatch. Expected ${expectedIds.length} ordered atoms, received ${actualIds.length}.`);
  }
  const entityIds = new Set(entities.map((entity) => String(entity.entity_id ?? "")).filter(Boolean));
  const locationIds = new Set(locations.map((location) => String(location.location_id ?? "")).filter(Boolean));
  const atomById = new Map(atoms.map((atom) => [atom.atom_id, atom]));
  for (const fact of atomFacts) {
    const atom = atomById.get(String(fact.atom_id));
    if (!atom) throw new Error(`Fact ledger returned unknown atom_id ${fact.atom_id}.`);
    if (!locationIds.has(String(fact.location_id ?? ""))) throw new Error(`Fact ledger atom ${fact.atom_id} uses unknown location_id ${fact.location_id}.`);
    for (const field of ["physically_visible_entity_ids", "screen_visible_entity_ids", "mentioned_only_entity_ids"]) {
      for (const id of fact[field] ?? []) {
        if (!entityIds.has(String(id))) throw new Error(`Fact ledger atom ${fact.atom_id} uses unknown entity_id ${id} in ${field}.`);
      }
    }
    const evidence = normalizeComparable(fact.evidence_excerpt);
    if (!evidence || !normalizeComparable(atom.text).includes(evidence)) {
      throw new Error(`Fact ledger atom ${fact.atom_id} evidence is not an exact source substring: ${fact.evidence_excerpt}`);
    }
  }
  return {
    schema: "goldflow_story_fact_ledger_ab_v1",
    status: "passed",
    entities,
    locations,
    atom_facts: atomFacts,
    continuity_transitions: Array.isArray(raw.continuity_transitions) ? raw.continuity_transitions : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  };
}

function buildEditorialBeatPrompt(sceneId, atoms, ledger, { preserveAtomBoundaries = false } = {}) {
  const atomIds = new Set(atoms.map((atom) => atom.atom_id));
  const atomFacts = ledger.atom_facts.filter((fact) => atomIds.has(String(fact.atom_id)));
  const boundaryRule = preserveAtomBoundaries
    ? "- Output exactly one beat per source atom. Each source_atom_ids array must contain exactly one atom_id. Preserve the proven production timing while replacing heuristic direction with editorial judgment."
    : "- A beat may keep one atom or merge adjacent atoms only when one coherent still frame can honestly depict the combined moment. Never merge across a location change, named-character entrance, system reveal, objective change, threat reveal, physical-action turn, or emotional reversal.";
  return `Direct the visual beats for one timed narration scene.

You are the editorial beat director. Decide what the viewer needs to see now to understand, feel, and keep watching. The exact atom text and FACT LEDGER are authoritative. Do not write image-generation prompt prose yet.

Rules:
- Use every source atom exactly once, in order.
${boundaryRule}
- Do not split atoms and do not add story facts.
- Each beat has one visual job and one decisive foreground action, reaction, object, UI reveal, location transition, or consequence.
- Select physically visible and screen-visible entities from the ledger. Mentioned-only entities remain offscreen.
- A person, creature, or location explicitly described inside a system prediction, prophecy, hypothetical route, memory, flashback, dossier image, or narrated future may be depicted as a clearly framed preview even when it is not physically present now. Put those entities in preview_visible_entity_ids and set depiction_mode accordingly. This is different from inventing a body for a person who is merely named in exposition.
- Composition intent is creative and beat-specific. Use the strongest framing for the moment without a global wide or close-up bias.
- Pacing target: 0-30 seconds usually 2.5-4.5 seconds; 30-180 seconds usually 4-7 seconds; after 180 seconds merge only when a stronger 7-11 second editorial frame results.
- Keep adjacent beats visually distinct through subject, action, scale, angle, object focus, UI focus, reaction, or environment.

SCENE ID: ${sceneId}

SOURCE ATOMS:
${JSON.stringify(atoms, null, 2)}

CANONICAL ENTITIES:
${JSON.stringify(ledger.entities, null, 2)}

CANONICAL LOCATIONS:
${JSON.stringify(ledger.locations, null, 2)}

ATOM FACTS:
${JSON.stringify(atomFacts, null, 2)}

Return JSON only:
{
  "beats": [{
    "source_atom_ids": ["contiguous atom ids"],
    "visual_job": "premise_image|humiliation_image|system_reveal|reaction_shot|ui_insert|remote_witness_cutaway|location_transition|physical_action|consequence|threat_reveal|cliffhanger_question",
    "shot_job": "environment_establishing|body_state_proof|object_insert|interaction|physical_action|emotional_reaction|consequence|ui_reveal|transition",
    "local_location_id": "canonical id",
    "physically_visible_entity_ids": [],
    "screen_visible_entity_ids": [],
    "preview_visible_entity_ids": [],
    "mentioned_only_entity_ids": [],
    "depiction_mode": "current_reality|system_preview|hypothetical_preview|memory_or_flashback|document_or_screen",
    "primary_entity_id": null,
    "props": [],
    "ui_elements": [],
    "foreground_action": "specific present-tense visible moment",
    "composition_intent": "concise editorial framing and spatial intent",
    "continuity_note": "only current continuity needed by prompt author",
    "editorial_cues": []
  }],
  "warnings": []
}`;
}

function normalizeEditorialScene(raw, atoms, ledger, sceneMeta, beatOffset, { preserveAtomBoundaries = false } = {}) {
  const rows = Array.isArray(raw?.beats) ? raw.beats : [];
  if (!rows.length) throw new Error(`Editorial director returned no beats for ${sceneMeta.scene_id}.`);
  if (preserveAtomBoundaries && rows.length !== atoms.length) {
    throw new Error(`Editorial director returned ${rows.length} beats for ${atoms.length} atoms in boundary-preserving mode for ${sceneMeta.scene_id}.`);
  }
  const expectedIds = atoms.map((atom) => atom.atom_id);
  const flattened = rows.flatMap((row) => row.source_atom_ids ?? []).map(String);
  if (flattened.length !== expectedIds.length || !expectedIds.every((id, index) => id === flattened[index])) {
    throw new Error(`Editorial director coverage mismatch for ${sceneMeta.scene_id}.`);
  }
  const atomIndex = new Map(atoms.map((atom, index) => [atom.atom_id, index]));
  const atomMap = new Map(atoms.map((atom) => [atom.atom_id, atom]));
  const factMap = new Map(ledger.atom_facts.map((fact) => [String(fact.atom_id), fact]));
  const entityMap = new Map(ledger.entities.map((entity) => [String(entity.entity_id), entity]));
  const locationMap = new Map(ledger.locations.map((location) => [String(location.location_id), location]));
  const allowedEntityIds = new Set(entityMap.keys());
  const output = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const ids = (row.source_atom_ids ?? []).map(String);
    const indexes = ids.map((id) => atomIndex.get(id));
    if (indexes.some((value) => !Number.isInteger(value))) throw new Error(`Unknown source atom in ${sceneMeta.scene_id}.`);
    if (indexes.some((value, position) => position > 0 && value !== indexes[position - 1] + 1)) {
      throw new Error(`Non-contiguous source atoms in ${sceneMeta.scene_id}.`);
    }
    const locationId = String(row.local_location_id ?? "");
    const location = locationMap.get(locationId);
    if (!location) throw new Error(`Editorial beat in ${sceneMeta.scene_id} uses unknown location_id ${locationId}.`);
    const entityFields = ["physically_visible_entity_ids", "screen_visible_entity_ids", "preview_visible_entity_ids", "mentioned_only_entity_ids"];
    for (const field of entityFields) {
      for (const id of row[field] ?? []) {
        if (!allowedEntityIds.has(String(id))) throw new Error(`Editorial beat in ${sceneMeta.scene_id} uses unknown entity_id ${id}.`);
      }
    }
    const firstAtom = atomMap.get(ids[0]);
    const lastAtom = atomMap.get(ids.at(-1));
    const excerpt = ids.map((id) => atomMap.get(id).text).join(" ");
    const physicallyVisible = unique((row.physically_visible_entity_ids ?? []).map(String));
    const screenVisible = unique((row.screen_visible_entity_ids ?? []).map(String));
    const previewVisible = unique((row.preview_visible_entity_ids ?? []).map(String));
    const visibleIds = unique([...physicallyVisible, ...screenVisible, ...previewVisible]);
    const mentionedIds = unique((row.mentioned_only_entity_ids ?? []).map(String)).filter((id) => !visibleIds.includes(id));
    const visibleNames = visibleIds.map((id) => entityMap.get(id)?.display_name).filter(Boolean);
    const mentionedNames = mentionedIds.map((id) => entityMap.get(id)?.display_name).filter(Boolean);
    const primaryName = entityMap.get(String(row.primary_entity_id ?? ""))?.display_name ?? visibleNames[0] ?? null;
    const startSec = Number(firstAtom.start_sec);
    const endSec = Number(lastAtom.end_sec);
    output.push({
      scene_id: sceneMeta.scene_id,
      parent_scene_id: sceneMeta.scene_id,
      title: sceneMeta.title,
      time: sceneMeta.time ?? null,
      source_atom_ids: ids,
      visual_beat_id: `${sceneMeta.scene_id}_editorial_${String(index + 1).padStart(2, "0")}`,
      beat_index: index + 1,
      beat_count: rows.length,
      start_sec: Number(startSec.toFixed(3)),
      end_sec: Number(endSec.toFixed(3)),
      duration_sec: Number(Math.max(1, endSec - startSec).toFixed(3)),
      visual_beat_script_excerpt: excerpt,
      visual_beat_action: normalizeText(row.foreground_action),
      visual_beat_focus: normalizeText(row.composition_intent),
      visual_job: String(row.visual_job ?? "consequence"),
      suggested_shot_job: String(row.shot_job ?? "interaction"),
      editorial_cues: Array.isArray(row.editorial_cues) ? row.editorial_cues.map(String) : [],
      location: location.label,
      local_location: location.label,
      location_id: locationId,
      location_timeline_label: `${Math.floor(startSec / 60)}:${String(Math.floor(startSec % 60)).padStart(2, "0")} ${location.label}`,
      visible_characters: visibleNames,
      visible_subjects: visibleNames,
      screen_visible_characters: screenVisible.map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      preview_visible_characters: previewVisible.map((id) => entityMap.get(id)?.display_name).filter(Boolean),
      depiction_mode: String(row.depiction_mode ?? "current_reality"),
      mentioned_only_characters: mentionedNames,
      primary_subject: primaryName,
      local_props: unique((row.props ?? []).map(String)),
      local_ui_elements: unique((row.ui_elements ?? []).map(String)),
      visual_novelty_directive: normalizeText(row.composition_intent),
      local_continuity_note: normalizeText(row.continuity_note),
      fact_ledger_rows: ids.map((id) => factMap.get(id)).filter(Boolean),
      hook_visual: startSec < 30,
      retention_ramp_visual: startSec >= 30 && startSec < 180,
      __ab_absolute_index: beatOffset + index,
    });
  }
  return output;
}

async function runCommand(command, args, { timeoutMs = 30 * 60_000 } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit", env: { ...process.env } });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`));
    });
  });
}

function meaningfulTokens(value) {
  const stop = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "at", "with", "from", "for", "as", "is", "was", "are", "be", "his", "her", "their", "this", "that", "into", "under", "over"]);
  return words(value).filter((token) => token.length > 2 && !stop.has(token));
}

function setDifference(a, b) {
  const right = new Set(b.map(normalizeComparable));
  return a.filter((value) => !right.has(normalizeComparable(value)));
}

function longestSameRun(rows, keyFn) {
  let longest = 0;
  let current = 0;
  let previous = null;
  for (const row of rows) {
    const key = keyFn(row);
    current = key === previous ? current + 1 : 1;
    previous = key;
    longest = Math.max(longest, current);
  }
  return longest;
}

function adjacentJaccard(prompts) {
  const scores = [];
  for (let index = 1; index < prompts.length; index += 1) {
    const left = new Set(meaningfulTokens(prompts[index - 1].modelslab_image_prompt ?? prompts[index - 1].image_prompt));
    const right = new Set(meaningfulTokens(prompts[index].modelslab_image_prompt ?? prompts[index].image_prompt));
    const union = new Set([...left, ...right]);
    const intersection = [...left].filter((token) => right.has(token));
    scores.push(union.size ? intersection.length / union.size : 0);
  }
  return average(scores);
}

function evaluateLane(label, beats, prompts, provider) {
  const promptByBeat = new Map(prompts.map((prompt) => [String(prompt.visual_beat_id), prompt]));
  const alignedPrompts = beats.map((beat) => promptByBeat.get(String(beat.visual_beat_id))).filter(Boolean);
  const promptWordCounts = alignedPrompts.map((prompt) => words(prompt.modelslab_image_prompt ?? prompt.image_prompt).length);
  const durations = beats.map((beat) => Number(beat.duration_sec));
  let missingVisibleNames = 0;
  let manifestSourceCharacterDrift = 0;
  let topLevelManifestDisagreements = 0;
  let weakLocationPrompts = 0;
  let repeatedNameClauses = 0;
  let inactiveProviderPrompts = 0;
  for (const beat of beats) {
    const prompt = promptByBeat.get(String(beat.visual_beat_id));
    if (!prompt) continue;
    const prose = normalizeComparable(prompt.modelslab_image_prompt ?? prompt.image_prompt);
    const manifestVisible = prompt.shot_manifest?.visible_characters ?? [];
    const beatVisible = beat.visible_characters ?? [];
    missingVisibleNames += manifestVisible.filter((name) => !prose.includes(normalizeComparable(name))).length;
    manifestSourceCharacterDrift += setDifference(manifestVisible, beatVisible).length;
    const topVisible = (prompt.visible_subjects ?? []).filter((value) => typeof value === "string");
    if (setDifference(topVisible, manifestVisible).length || setDifference(manifestVisible, topVisible).length) topLevelManifestDisagreements += 1;
    const locationTokens = meaningfulTokens(beat.local_location ?? beat.location).slice(0, 12);
    const locationHits = locationTokens.filter((token) => prose.includes(token));
    if (locationTokens.length >= 3 && locationHits.length < Math.min(3, Math.ceil(locationTokens.length * 0.3))) weakLocationPrompts += 1;
    for (const name of manifestVisible) {
      const normalizedName = normalizeText(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${normalizedName}\\s*:\\s*${normalizedName}\\b`, "i").test(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "")) repeatedNameClauses += 1;
    }
    if (provider === "modelslab" && prompt.codex_image_prompt) inactiveProviderPrompts += 1;
    if (provider === "codex_imagegen" && prompt.modelslab_image_prompt) inactiveProviderPrompts += 1;
  }
  const band = (start, end) => {
    const rows = beats.filter((beat) => Number(beat.start_sec) >= start && Number(beat.start_sec) < end);
    return {
      cuts: rows.length,
      average_hold_sec: Number(average(rows.map((row) => Number(row.duration_sec))).toFixed(2)),
      median_hold_sec: Number(percentile(rows.map((row) => Number(row.duration_sec)), 0.5).toFixed(2)),
    };
  };
  return {
    label,
    beat_count: beats.length,
    prompt_count: alignedPrompts.length,
    timing: {
      average_hold_sec: Number(average(durations).toFixed(2)),
      median_hold_sec: Number(percentile(durations, 0.5).toFixed(2)),
      first_30_sec: band(0, 30),
      sec_30_to_180: band(30, 180),
      sec_180_to_300: band(180, 300.001),
    },
    prompt_complexity: {
      average_words: Number(average(promptWordCounts).toFixed(1)),
      p90_words: percentile(promptWordCounts, 0.9),
      inactive_provider_prompt_count: inactiveProviderPrompts,
      repeated_name_clause_count: repeatedNameClauses,
    },
    contract_findings: {
      prompt_missing_manifest_visible_names: missingVisibleNames,
      manifest_characters_not_in_source_beat: manifestSourceCharacterDrift,
      top_level_manifest_disagreement_cuts: topLevelManifestDisagreements,
      weak_location_token_coverage_cuts: weakLocationPrompts,
    },
    variety: {
      longest_same_location_visual_job_run: longestSameRun(beats, (beat) => `${normalizeComparable(beat.local_location ?? beat.location)}|${beat.visual_job ?? ""}`),
      average_adjacent_prompt_jaccard: Number(adjacentJaccard(alignedPrompts).toFixed(4)),
      distinct_visual_jobs: unique(beats.map((beat) => beat.visual_job)).length,
      distinct_shot_jobs: unique(alignedPrompts.map((prompt) => prompt.shot_manifest?.shot_job)).length,
    },
    reference_use: {
      average_attached_refs: Number(average(alignedPrompts.map((prompt) => (prompt.reference_requirements ?? []).length)).toFixed(2)),
      four_ref_cuts: alignedPrompts.filter((prompt) => (prompt.reference_requirements ?? []).length === 4).length,
      zero_ref_cuts: alignedPrompts.filter((prompt) => !(prompt.reference_requirements ?? []).length).length,
    },
  };
}

function sampleIndexes(length, count = 12) {
  if (length <= count) return Array.from({ length }, (_, index) => index);
  return unique(Array.from({ length: count }, (_, index) => Math.round(index * (length - 1) / (count - 1))));
}

function evaluationMarkdown(report, baselineBeats, baselinePrompts, variantBeats, variantPrompts) {
  const baselinePromptByBeat = new Map(baselinePrompts.map((prompt) => [String(prompt.visual_beat_id), prompt]));
  const variantPromptByBeat = new Map(variantPrompts.map((prompt) => [String(prompt.visual_beat_id), prompt]));
  const lines = [
    "# Visual Planner A/B Diagnostic",
    "",
    `Scope: 0-${report.scope_end_sec} seconds`,
    "",
    "## Metrics",
    "",
    "```json",
    JSON.stringify({ baseline: report.baseline, variant: report.variant }, null, 2),
    "```",
    "",
    "## Baseline Samples",
    "",
  ];
  for (const index of sampleIndexes(baselineBeats.length)) {
    const beat = baselineBeats[index];
    const prompt = baselinePromptByBeat.get(String(beat.visual_beat_id));
    lines.push(`### A ${beat.visual_beat_id} @ ${Number(beat.start_sec).toFixed(1)}s`);
    lines.push(`Excerpt: ${normalizeText(beat.visual_beat_script_excerpt)}`);
    lines.push(`Job: ${beat.visual_job}; visible: ${(beat.visible_characters ?? []).join(", ") || "none"}; location: ${beat.local_location ?? beat.location}`);
    lines.push(`Prompt: ${normalizeText(prompt?.modelslab_image_prompt ?? prompt?.image_prompt)}`);
    lines.push("");
  }
  lines.push("## Variant Samples", "");
  for (const index of sampleIndexes(variantBeats.length)) {
    const beat = variantBeats[index];
    const prompt = variantPromptByBeat.get(String(beat.visual_beat_id));
    lines.push(`### B ${beat.visual_beat_id} @ ${Number(beat.start_sec).toFixed(1)}s`);
    lines.push(`Excerpt: ${normalizeText(beat.visual_beat_script_excerpt)}`);
    lines.push(`Job: ${beat.visual_job}; visible: ${(beat.visible_characters ?? []).join(", ") || "none"}; location: ${beat.local_location ?? beat.location}`);
    lines.push(`Prompt: ${normalizeText(prompt?.modelslab_image_prompt ?? prompt?.image_prompt)}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const episodeDir = path.resolve(flags["episode-dir"] ?? "");
  if (!flags["episode-dir"]) throw new Error("visual planner-ab requires --episode-dir <path>.");
  const scopeEndSec = Number(flags["scope-end-sec"] ?? 300);
  if (!Number.isFinite(scopeEndSec) || scopeEndSec <= 0) throw new Error("--scope-end-sec must be a positive number.");
  const label = String(flags.label ?? `first_${Math.round(scopeEndSec)}s_lean_editorial_v1`).replace(/[^a-zA-Z0-9_-]+/g, "_");
  const diagnosticDir = path.join(episodeDir, "diagnostics", `visual_planner_ab_${label}`);
  const callDir = path.join(diagnosticDir, "llm_calls");
  const force = flags.force === "true";
  const preserveAtomBoundaries = flags["preserve-atom-boundaries"] === "true";

  const paths = {
    identity: path.join(episodeDir, "run_identity.json"),
    semantic: path.join(episodeDir, "semantic_scene_plan.json"),
    timed: path.join(episodeDir, "timed_scene_plan.json"),
    beats: path.join(episodeDir, "visual_beat_plan.json"),
    prompts: path.join(episodeDir, "section_image_prompts.json"),
    refs: path.join(episodeDir, "visual_reference_plan.json"),
    states: path.join(episodeDir, "character_state_refs.json"),
  };
  const [identity, semantic, timed, baselinePlan, baselinePromptPlan, visualRefs, characterStates] = await Promise.all([
    readJson(paths.identity), readJson(paths.semantic), readJson(paths.timed), readJson(paths.beats),
    readJson(paths.prompts), readJson(paths.refs), readJson(paths.states),
  ]);
  if (!identity || semantic?.status !== "passed" || timed?.status !== "passed" || baselinePlan?.status !== "passed" || baselinePromptPlan?.status !== "passed") {
    throw new Error("The selected episode is missing a passed identity, semantic, timed, visual-beat, or prompt artifact.");
  }
  if (visualRefs?.status !== "passed" || !["approved", "passed"].includes(characterStates?.status)) {
    throw new Error("The selected episode needs passed refs and approved character states for prompt A/B authoring.");
  }
  const selectedBaselineBeats = (baselinePlan.beats ?? []).filter((beat) => Number(beat.start_sec) < scopeEndSec);
  if (!selectedBaselineBeats.length) throw new Error("No baseline beats fall inside the requested scope.");
  const selectedBeatIds = new Set(selectedBaselineBeats.map((beat) => String(beat.visual_beat_id)));
  const selectedBaselinePrompts = (baselinePromptPlan.prompts ?? []).filter((prompt) => selectedBeatIds.has(String(prompt.visual_beat_id)));
  if (selectedBaselinePrompts.length !== selectedBaselineBeats.length) {
    throw new Error(`Baseline prompt coverage mismatch: ${selectedBaselinePrompts.length} prompts for ${selectedBaselineBeats.length} beats.`);
  }
  const atoms = selectedBaselineBeats.map(atomFromBeat);
  const selectedSceneIds = unique(atoms.map((atom) => atom.scene_id));
  const semanticByScene = new Map((semantic.scenes ?? []).map((scene) => [String(scene.scene_id), scene]));
  const semanticCandidates = selectedSceneIds.map((sceneId) => semanticCandidate(semanticByScene.get(sceneId) ?? { scene_id: sceneId }));
  const scopeHash = sha256(JSON.stringify({ source_script_hash: semantic.source_script_hash, scopeEndSec, atoms }));

  await writeJson(path.join(diagnosticDir, "baseline_extract.json"), {
    schema: "goldflow_visual_planner_ab_baseline_v1",
    status: "passed",
    scope_end_sec: scopeEndSec,
    scope_hash: scopeHash,
    beats: selectedBaselineBeats,
    prompts: selectedBaselinePrompts,
  });

  const ledgerPath = path.join(diagnosticDir, "story_fact_ledger.json");
  const suppliedLedgerPath = flags["fact-ledger"] ? path.resolve(flags["fact-ledger"]) : null;
  let ledger = suppliedLedgerPath ? await readJson(suppliedLedgerPath, null) : (!force ? await readJson(ledgerPath, null) : null);
  if (suppliedLedgerPath && (ledger?.status !== "passed" || ledger.scope_hash !== scopeHash)) {
    throw new Error(`Supplied fact ledger does not match this scope: ${suppliedLedgerPath}`);
  }
  if (ledger?.status !== "passed" || ledger.scope_hash !== scopeHash) {
    const ledgerCall = await runCodexJson(buildFactLedgerPrompt(atoms, semanticCandidates), "story_fact_ledger", callDir, { force });
    ledger = {
      ...validateFactLedger(ledgerCall.parsed, atoms),
      scope_end_sec: scopeEndSec,
      scope_hash: scopeHash,
      source_script_hash: semantic.source_script_hash,
      planner: { provider: "codex", output_path: ledgerCall.outputPath, reused: ledgerCall.reused },
      updated_at: new Date().toISOString(),
    };
    await writeJson(ledgerPath, ledger);
  } else if (suppliedLedgerPath) {
    await writeJson(ledgerPath, { ...ledger, reused_from: suppliedLedgerPath });
  }

  const atomsByScene = selectedSceneIds.map((sceneId) => ({ sceneId, atoms: atoms.filter((atom) => atom.scene_id === sceneId) }));
  const suppliedEditorialBeatPath = flags["editorial-beats"] ? path.resolve(flags["editorial-beats"]) : null;
  let variantBeats = [];
  if (suppliedEditorialBeatPath) {
    const suppliedPlan = await readJson(suppliedEditorialBeatPath, null);
    if (suppliedPlan?.status !== "passed" || suppliedPlan.scope_hash !== scopeHash || !Array.isArray(suppliedPlan.beats)) {
      throw new Error(`Supplied editorial beat plan does not match this scope: ${suppliedEditorialBeatPath}`);
    }
    variantBeats = suppliedPlan.beats;
  } else {
    const editorialResults = await mapWithConcurrency(
      atomsByScene,
      Number(flags["beat-concurrency"] ?? 4),
      async ({ sceneId, atoms: sceneAtoms }) => {
        const result = await runCodexJson(
          buildEditorialBeatPrompt(sceneId, sceneAtoms, ledger, { preserveAtomBoundaries }),
          `editorial_beats_${sceneId}`,
          callDir,
          { force, timeoutMs: Number(flags["codex-call-timeout-ms"] ?? 8 * 60_000) },
        );
        return { sceneId, sceneAtoms, result };
      },
    );
    for (const item of editorialResults) {
      const sceneMeta = semanticByScene.get(item.sceneId) ?? { scene_id: item.sceneId, title: item.sceneId };
      variantBeats.push(...normalizeEditorialScene(item.result.parsed, item.sceneAtoms, ledger, sceneMeta, variantBeats.length, { preserveAtomBoundaries }));
    }
  }
  const variantBeatPath = path.join(diagnosticDir, "variant_visual_beat_plan.json");
  await writeJson(variantBeatPath, {
    schema: "goldflow_visual_beat_plan_ab_v1",
    status: "passed",
    source_script_hash: semantic.source_script_hash,
    timing_source: baselinePlan.timing_source ?? "local_whisper_word_timing",
    scope_end_sec: scopeEndSec,
    scope_hash: scopeHash,
    planner: { provider: "codex", mode: "evidence_ledger_editorial_director" },
    beat_count: variantBeats.length,
    beats: variantBeats,
    updated_at: new Date().toISOString(),
  });
  const thinSemanticPath = path.join(diagnosticDir, "thin_semantic_context.json");
  await writeJson(thinSemanticPath, {
    schema: "goldflow_thin_semantic_context_ab_v1",
    status: "passed",
    source_script_hash: semantic.source_script_hash,
    episode_summary: "",
    global_reference_requirements: [],
    style_summary: semantic.style_summary ?? "",
    warnings: [],
    policy: "Evidence and local editorial beats are authoritative; broad semantic visual prose is intentionally absent.",
    updated_at: new Date().toISOString(),
  });
  const variantReferencePath = path.join(diagnosticDir, "variant_reference_scope_overlay.json");
  const variantReferencePlan = referenceScopeOverlay(visualRefs, variantBeats);
  await writeJson(variantReferencePath, variantReferencePlan);

  const variantPromptPath = path.join(diagnosticDir, "variant_section_image_prompts.json");
  const existingVariantPrompts = !force ? await readJson(variantPromptPath, null) : null;
  if (existingVariantPrompts?.status !== "passed" || existingVariantPrompts?.prompts?.length !== variantBeats.length) {
    const args = [
      path.join(repoRoot, "bin", "goldflow.mjs"), "visual", "plan",
      "--channel", String(identity.channel ?? "53rebirth"),
      "--series", String(identity.series_slug),
      "--week", String(identity.week),
      "--episode", String(identity.episode),
      "--timed", paths.timed,
      "--semantic", thinSemanticPath,
      "--visual-refs", variantReferencePath,
      "--character-state-refs", paths.states,
      "--beats", variantBeatPath,
      "--output", variantPromptPath,
      "--workflow-bypass", "true",
      "--visual-chunk-scenes", String(flags["visual-chunk-scenes"] ?? 4),
      "--visual-chunk-concurrency", String(flags["visual-chunk-concurrency"] ?? 6),
      "--codex-call-attempts", String(flags["codex-call-attempts"] ?? 2),
      "--codex-call-timeout-ms", String(flags["codex-call-timeout-ms"] ?? 480000),
    ];
    if (flags["compact-editorial-proof"] === "true") args.push("--compact-editorial-proof", "true");
    await runCommand(process.execPath, args, { timeoutMs: Number(flags["prompt-timeout-ms"] ?? 30 * 60_000) });
  }
  const variantPromptPlan = await readJson(variantPromptPath, null);
  if (variantPromptPlan?.status !== "passed" || variantPromptPlan.prompts?.length !== variantBeats.length) {
    throw new Error(`Variant prompt plan did not pass: ${variantPromptPath}`);
  }

  const baselineMetrics = evaluateLane("current_production", selectedBaselineBeats, selectedBaselinePrompts, identity.image_provider);
  const variantMetrics = evaluateLane("thin_ledger_llm_editorial", variantBeats, variantPromptPlan.prompts, identity.image_provider);
  const evaluation = {
    schema: "goldflow_visual_planner_ab_evaluation_v1",
    status: "passed",
    episode_dir: episodeDir,
    scope_end_sec: scopeEndSec,
    scope_hash: scopeHash,
    baseline: baselineMetrics,
    variant: variantMetrics,
    interpretation_guardrail: "Metrics surface contract and complexity differences; final recommendation requires manual editorial comparison of the saved samples.",
    artifact_paths: {
      baseline: path.join(diagnosticDir, "baseline_extract.json"),
      story_fact_ledger: ledgerPath,
      variant_beats: variantBeatPath,
      variant_reference_scope_overlay: variantReferencePath,
      variant_prompts: variantPromptPath,
      sample_report: path.join(diagnosticDir, "evaluation_samples.md"),
    },
    updated_at: new Date().toISOString(),
  };
  await writeJson(path.join(diagnosticDir, "evaluation_metrics.json"), evaluation);
  await writeText(
    path.join(diagnosticDir, "evaluation_samples.md"),
    evaluationMarkdown(evaluation, selectedBaselineBeats, selectedBaselinePrompts, variantBeats, variantPromptPlan.prompts),
  );
  console.log(JSON.stringify({
    status: "passed",
    diagnostic_dir: diagnosticDir,
    baseline_beats: selectedBaselineBeats.length,
    variant_beats: variantBeats.length,
    evaluation_path: path.join(diagnosticDir, "evaluation_metrics.json"),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
