import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCodexCli } from "./codex-cli-runner.mjs";
import {
  NARRATION_BOUNDARY_CLASSES,
  narrationSourceRefKey,
  normalizeNarrationPerformanceIntent,
  punctuationInsensitiveTokens,
  validateActionableNarrationDirection,
} from "./narration-performance-contract.mjs";

function sha256(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function extractJson(content) {
  const raw = String(content ?? "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error("Narration performance author did not return valid JSON.");
}

function segmentChunks(atomicUnits, maximumAtoms = 54) {
  const segments = [];
  for (const unit of atomicUnits) {
    const segmentId = String(unit.segment_id ?? unit.source_segment_ids?.[0] ?? "");
    let row = segments.at(-1);
    if (!row || row.segment_id !== segmentId) {
      row = { segment_id: segmentId, units: [] };
      segments.push(row);
    }
    row.units.push(unit);
  }
  const chunks = [];
  let current = [];
  for (const segment of segments) {
    if (current.length && current.length + segment.units.length > maximumAtoms) {
      chunks.push(current);
      current = [];
    }
    if (segment.units.length > maximumAtoms) {
      if (current.length) chunks.push(current);
      chunks.push(segment.units);
      current = [];
      continue;
    }
    current.push(...segment.units);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function promptForChunk(units, chunkIndex, chunkCount, chapterProsody = []) {
  const atoms = units.map((unit) => ({
    source_ref_key: narrationSourceRefKey(unit.source_unit_refs?.[0]),
    segment_id: unit.segment_id,
    kind: unit.kind,
    source_speaker: unit.source_speaker,
    spoken_text: unit.spoken_text,
    word_count: punctuationInsensitiveTokens(unit.spoken_text).length,
    merge_barrier: unit.source_merge_barrier === true
      || unit.risk_flags?.includes("system_ui_atomic")
      || unit.risk_flags?.includes("speaker_or_performance_turn")
      || unit.risk_flags?.includes("tts_override_applied"),
  }));
  return `You are the provider-neutral narration performance editor for a fast, emotional YouTube manhwa recap.

The output will be compiled through a capability adapter. Every model receives exact spoken text, punctuation, sentence-complete grouping, semantic boundary timing, and a locked voice. Models with an instruction channel also receive your restrained performance intent. Models without one still benefit from your punctuation, grouping, and boundary classes.

Return JSON only in this exact shape:
{"units":[{"source_ref_keys":["voice_seg_01:u001"],"spoken_text":"Exact same spoken words with authored punctuation.","dialogue_separation":"preserve","boundary_after":"sentence","performance_intent":{"energy":"controlled","tension":"neutral","intimacy":"standard","pace":"steady_forward","emphasis":[],"pause_strategy":"punctuation_led","style_tags":[]}}]}

Binding rules:
- Preserve every source_ref_key exactly once and in the supplied order.
- Keep each output unit inside one segment_id.
- A merge_barrier atom must remain a standalone output unit.
- Prefer 20-42 words when adjacent sentences belong to one breath and one dramatic thought. Treat 48 words as a soft ceiling and 60 as the hard ceiling. Never split a source sentence to hit a target.
- Every output unit must contain at most 60 spoken words and end with terminal punctuation.
- Preserve all spoken words in exact order. You may change punctuation and capitalization only.
- Use grouping and punctuation to create energetic recap cadence, clean emotional turns, clear dialogue, and natural breath points without melodramatic pauses after every sentence.
- Keep tightly connected action sentences flowing. Separate quoted dialogue when it improves clarity.
- boundary_after must be one of continuation, clause, sentence, emphasized_sentence, paragraph, reveal, episode_end. Use reveal only for a genuine disclosure/turn, paragraph for a scene or idea reset, emphasized_sentence sparingly, and ordinary sentence for most joins. Only the final output unit of the final packet may use episode_end.
- performance_intent enums: energy=restrained|low|controlled|high|urgent; tension=neutral|warm|cold|social_pressure|high; intimacy=distant|standard|close; pace=measured|steady|steady_forward|precise|fast; pause_strategy=minimal|punctuation_led|short_precise|reveal_weighted.
- emphasis may contain at most eight short phrases copied exactly from spoken_text. style_tags may contain at most six terse non-spoken descriptors. Do not write dialogue or stage directions into either field.
- Do not emit stage directions, emotion tags, SSML, instructions, commentary, or unsupported controls.

Packet ${chunkIndex + 1} of ${chunkCount}:
Episode-level chapter prosody for the segment(s) in this packet. Treat this as the global arc; unit direction should realize it without adding words or theatrical stage directions:
${JSON.stringify(chapterProsody)}

Atomic spoken units:
${JSON.stringify(atoms)}`;
}

function prosodySpinePrompt(atomicUnits) {
  const segments = [];
  for (const unit of atomicUnits) {
    const segmentId = String(unit.segment_id ?? "");
    let row = segments.at(-1);
    if (!row || row.segment_id !== segmentId) {
      row = { segment_id: segmentId, texts: [], kinds: new Set() };
      segments.push(row);
    }
    row.texts.push(String(unit.spoken_text ?? "").trim());
    row.kinds.add(String(unit.kind ?? "narration"));
  }
  const packet = segments.map((row) => ({
    segment_id: row.segment_id,
    word_count: punctuationInsensitiveTokens(row.texts.join(" ")).length,
    opening_text: row.texts.slice(0, 2).join(" ").slice(0, 600),
    ending_text: row.texts.slice(-2).join(" ").slice(-600),
    content_kinds: [...row.kinds],
  }));
  return `You are the global narration director for a fast, emotionally controlled YouTube manhwa recap. Plan one coherent episode-level delivery arc before local unit direction.

Return JSON only: {"chapters":[{"segment_id":"voice_seg_01","dramatic_function":"...","audience_effect":"...","energy_start":1,"energy_end":2,"tension_peak":3,"intimacy":2,"pace":"steady_forward","reveal_weight":2,"transition_from_previous":"...","avoidance":"..."}]}

Rules:
- Return exactly one row per supplied segment_id, in exact order, with no omissions or additions.
- All five numeric fields are integers 1-5. pace is measured, steady, steady_forward, precise, or fast.
- Shape contrast across the whole episode. Do not make every segment urgent, high-energy, intimate, or reveal-weighted.
- Preserve restrained authority. Use energy changes for actual pressure, reversals, intimacy, strategy, and payoff rather than arbitrary excitement.
- transition_from_previous explains the audible handoff. avoidance names the most likely bad read, such as flat exposition, rushed grief, fake suspense, or melodrama.
- No replacement narration and no stage directions.

Segments:
${JSON.stringify(packet)}`;
}

function validateProsodySpine(parsed, atomicUnits) {
  const rows = Array.isArray(parsed?.chapters) ? parsed.chapters : [];
  const expected = [...new Set(atomicUnits.map((unit) => String(unit.segment_id ?? "")).filter(Boolean))];
  const actual = rows.map((row) => String(row?.segment_id ?? ""));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Narration chapter prosody spine changed segment coverage or ordering.");
  }
  const allowedPace = new Set(["measured", "steady", "steady_forward", "precise", "fast"]);
  for (const row of rows) {
    for (const field of ["dramatic_function", "audience_effect", "transition_from_previous", "avoidance"]) {
      if (!String(row?.[field] ?? "").trim()) throw new Error(`Narration chapter prosody spine lacks ${field}.`);
    }
    for (const field of ["energy_start", "energy_end", "tension_peak", "intimacy", "reveal_weight"]) {
      const value = Number(row?.[field]);
      if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(`Narration chapter prosody spine has invalid ${field}.`);
    }
    if (!allowedPace.has(String(row?.pace ?? ""))) throw new Error("Narration chapter prosody spine has invalid pace.");
  }
  return rows.map((row) => ({
    segment_id: String(row.segment_id),
    dramatic_function: String(row.dramatic_function).trim(),
    audience_effect: String(row.audience_effect).trim(),
    energy_start: Number(row.energy_start),
    energy_end: Number(row.energy_end),
    tension_peak: Number(row.tension_peak),
    intimacy: Number(row.intimacy),
    pace: String(row.pace),
    reveal_weight: Number(row.reveal_weight),
    transition_from_previous: String(row.transition_from_previous).trim(),
    avoidance: String(row.avoidance).trim(),
  }));
}

function validateChunkResult(parsed, atomicUnits, chunkIndex, chunkCount) {
  const expected = atomicUnits.map((unit) => narrationSourceRefKey(unit.source_unit_refs?.[0]));
  const rows = Array.isArray(parsed?.units) ? parsed.units : [];
  const actual = rows.flatMap((row) => Array.isArray(row.source_ref_keys) ? row.source_ref_keys.map(String) : []);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Narration performance author changed source-ref coverage or ordering.");
  }
  const byKey = new Map(atomicUnits.map((unit) => [narrationSourceRefKey(unit.source_unit_refs?.[0]), unit]));
  for (const row of rows) {
    const keys = row.source_ref_keys.map(String);
    const sourceRows = keys.map((key) => byKey.get(key));
    if (new Set(sourceRows.map((unit) => unit.segment_id)).size !== 1) {
      throw new Error("Narration performance author crossed a voice segment.");
    }
    if (keys.length > 1 && sourceRows.some((unit) => (
      unit.source_merge_barrier === true
      || unit.risk_flags?.includes("system_ui_atomic")
      || unit.risk_flags?.includes("speaker_or_performance_turn")
      || unit.risk_flags?.includes("tts_override_applied")
    ))) {
      throw new Error("Narration performance author crossed an atomic performance barrier.");
    }
    const expectedWords = sourceRows.flatMap((unit) => punctuationInsensitiveTokens(unit.spoken_text));
    const actualWords = punctuationInsensitiveTokens(row.spoken_text);
    if (JSON.stringify(actualWords) !== JSON.stringify(expectedWords)) {
      throw new Error(`Narration performance author changed spoken words for ${keys.join(",")}.`);
    }
    if (actualWords.length > 60) throw new Error(`Narration unit exceeds 60 words: ${keys.join(",")}.`);
    if (!/[.!?][\"'”’)]*$/.test(String(row.spoken_text ?? "").trim())) {
      throw new Error(`Narration unit lacks terminal punctuation: ${keys.join(",")}.`);
    }
    if (!NARRATION_BOUNDARY_CLASSES.includes(String(row.boundary_after ?? ""))) {
      throw new Error(`Narration boundary class is invalid: ${keys.join(",")}.`);
    }
    const isGlobalFinal = chunkIndex === chunkCount - 1
      && row === rows.at(-1);
    if (isGlobalFinal && row.boundary_after !== "episode_end") {
      throw new Error("The final narration unit must use boundary_after=episode_end.");
    }
    if (!isGlobalFinal && row.boundary_after === "episode_end") {
      throw new Error("Only the final narration unit may use boundary_after=episode_end.");
    }
    const normalizedIntent = normalizeNarrationPerformanceIntent(
      row.performance_intent,
    );
    for (const field of ["energy", "tension", "intimacy", "pace", "pause_strategy"]) {
      if (normalizedIntent[field] !== row.performance_intent?.[field]) {
        throw new Error(`Narration performance intent ${field} is invalid: ${keys.join(",")}.`);
      }
    }
  }
  return rows.map((row) => ({
    source_ref_keys: row.source_ref_keys.map(String),
    spoken_text: String(row.spoken_text).trim(),
    dialogue_separation: String(row.dialogue_separation ?? "preserve").trim() || "preserve",
    boundary_after: String(row.boundary_after),
    performance_intent: normalizeNarrationPerformanceIntent(
      row.performance_intent,
    ),
  }));
}

async function runPool(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return output;
}

async function authoredChunk({
  chunk,
  index,
  chunkCount,
  callDir,
  repoRoot,
  provider,
  model,
  reasoningEffort,
  chapterProsody,
}) {
  const segmentIds = new Set(chunk.map((unit) => String(unit.segment_id ?? "")));
  const basePrompt = promptForChunk(
    chunk,
    index,
    chunkCount,
    chapterProsody.filter((row) => segmentIds.has(row.segment_id)),
  );
  const basePath = path.join(
    callDir,
    `performance_${String(index + 1).padStart(3, "0")}_${sha256(basePrompt).slice(0, 12)}.json`,
  );
  const attempts = [
    { prompt: basePrompt, outputPath: basePath, recovery: false },
    {
      prompt: `${basePrompt}\n\nRECOVERY: The prior packet violated exact spoken-word preservation. You may only insert, delete, or replace punctuation characters and regroup adjacent supplied atoms. Do not insert, delete, replace, contract, or reorder any word. In particular, do not add connective words between sentences. Return the complete packet again.`,
      outputPath: `${basePath}.recovery-1.json`,
      recovery: true,
    },
  ];
  let priorError = null;
  for (const attempt of attempts) {
    let content = await fs.readFile(attempt.outputPath, "utf8").catch(() => null);
    let call = null;
    if (!content) {
      call = await runCodexCli({
        prompt: attempt.prompt,
        stageName: attempt.recovery
          ? "narration_performance_authoring_recovery"
          : "narration_performance_authoring",
        repoRoot,
        outputPath: attempt.outputPath,
        provider,
        model,
        reasoningEffort,
        timeoutMs: Number(process.env.ANIFACTORY_NARRATION_PERFORMANCE_TIMEOUT_MS ?? 1_200_000),
      });
      content = call.content;
    }
    try {
      return {
        units: validateChunkResult(
          extractJson(content),
          chunk,
          index,
          chunkCount,
        ),
        provider: call?.provider ?? "content_addressed_cache",
        model: call?.model ?? model ?? "identity_locked_model",
        output_path: attempt.outputPath,
        prompt_sha256: sha256(attempt.prompt),
        reused: call === null,
        recovery: attempt.recovery,
      };
    } catch (error) {
      priorError = error;
    }
  }
  throw priorError ?? new Error(`Narration performance packet ${index + 1} failed.`);
}

export async function authorNarrationPerformanceDirection({
  atomicUnits,
  sourceScriptSha256,
  episodeDir,
  repoRoot,
  provider = null,
  model = null,
  reasoningEffort = "medium",
  concurrency = 3,
} = {}) {
  if (!Array.isArray(atomicUnits) || !atomicUnits.length) {
    throw new Error("Narration performance author requires atomic spoken units.");
  }
  const chunks = segmentChunks(atomicUnits);
  const callDir = path.join(episodeDir, "_codex_calls", "narration-performance-author");
  await fs.mkdir(callDir, { recursive: true });
  const spinePrompt = prosodySpinePrompt(atomicUnits);
  const spinePath = path.join(callDir, `chapter_prosody_${sha256(spinePrompt).slice(0, 12)}.json`);
  let spineContent = await fs.readFile(spinePath, "utf8").catch(() => null);
  let spineCall = null;
  if (!spineContent) {
    spineCall = await runCodexCli({
      prompt: spinePrompt,
      stageName: "narration_chapter_prosody_spine",
      repoRoot,
      outputPath: spinePath,
      provider,
      model,
      reasoningEffort,
      timeoutMs: Number(process.env.ANIFACTORY_NARRATION_PERFORMANCE_TIMEOUT_MS ?? 1_200_000),
    });
    spineContent = spineCall.content;
  }
  const chapterProsody = validateProsodySpine(extractJson(spineContent), atomicUnits);
  const calls = await runPool(
    chunks,
    Math.max(1, Math.min(3, Number(concurrency) || 3)),
    (chunk, index) => authoredChunk({
      chunk,
      index,
      chunkCount: chunks.length,
      callDir,
      repoRoot,
      provider,
      model,
      reasoningEffort,
      chapterProsody,
    }),
  );
  const providers = [...new Set(calls.map((call) => call.provider))];
  const models = [...new Set(calls.map((call) => call.model))];
  const artifact = {
    schema: "goldflow_narration_actionable_direction_v3",
    status: "approved",
    generated_at: new Date().toISOString(),
    source_script_sha256: sourceScriptSha256,
    authoring: {
      kind: "llm_authored",
      provider: providers.join("+") || "planning_room",
      model: models.join("+") || "identity_locked_model",
      controls: [
        "punctuation",
        "sentence_complete_unit_boundaries",
        "dialogue_separation",
        "semantic_boundary_class",
        "performance_intent",
      ],
      capability_compilation_required: true,
      calls: calls.map(({ units: _units, ...call }) => call),
      chapter_prosody_call: {
        provider: spineCall?.provider ?? "content_addressed_cache",
        model: spineCall?.model ?? model ?? "identity_locked_model",
        output_path: spinePath,
        prompt_sha256: sha256(spinePrompt),
        reused: spineCall === null,
      },
    },
    chapter_prosody_spine: {
      schema: "goldflow_narration_chapter_prosody_spine_v1",
      status: "approved",
      chapters: chapterProsody,
    },
    units: calls.flatMap((call) => call.units),
  };
  const validation = validateActionableNarrationDirection({
    artifact,
    atomicUnits,
    sourceScriptSha256,
    hardWordMax: 60,
  });
  if (validation.status !== "passed") {
    throw new Error(`Authored narration performance map failed final validation: ${JSON.stringify(validation.findings)}`);
  }
  const artifactPath = path.join(episodeDir, "narration_actionable_direction.json");
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return { artifact, artifactPath, callCount: calls.length };
}
