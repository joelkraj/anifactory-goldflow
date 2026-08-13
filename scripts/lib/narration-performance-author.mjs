import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCodexCli } from "./codex-cli-runner.mjs";
import {
  narrationSourceRefKey,
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

function promptForChunk(units, chunkIndex, chunkCount) {
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
  return `You are the narration performance editor for a fast, emotional YouTube manhwa recap.

Qwen3-TTS Base has no instruction or speed channel. Your only real controls are punctuation, sentence-complete grouping, dialogue separation, and the already selected reference recording. Author those controls carefully.

Return JSON only in this exact shape:
{"units":[{"source_ref_keys":["voice_seg_01:u001"],"spoken_text":"Exact same spoken words with authored punctuation.","dialogue_separation":"preserve"}]}

Binding rules:
- Preserve every source_ref_key exactly once and in the supplied order.
- Keep each output unit inside one segment_id.
- A merge_barrier atom must remain a standalone output unit.
- Every output unit must contain at most 60 spoken words and end with terminal punctuation.
- Preserve all spoken words in exact order. You may change punctuation and capitalization only.
- Use grouping and punctuation to create energetic recap cadence, clean emotional turns, clear dialogue, and natural breath points without melodramatic pauses after every sentence.
- Keep tightly connected action sentences flowing. Separate quoted dialogue when it improves clarity.
- Do not emit stage directions, emotion tags, SSML, instructions, commentary, or unsupported controls.

Packet ${chunkIndex + 1} of ${chunkCount}:
${JSON.stringify(atoms)}`;
}

function validateChunkResult(parsed, atomicUnits) {
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
  }
  return rows.map((row) => ({
    source_ref_keys: row.source_ref_keys.map(String),
    spoken_text: String(row.spoken_text).trim(),
    dialogue_separation: String(row.dialogue_separation ?? "preserve").trim() || "preserve",
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
}) {
  const basePrompt = promptForChunk(chunk, index, chunkCount);
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
        units: validateChunkResult(extractJson(content), chunk),
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
    }),
  );
  const providers = [...new Set(calls.map((call) => call.provider))];
  const models = [...new Set(calls.map((call) => call.model))];
  const artifact = {
    schema: "goldflow_narration_actionable_direction_v1",
    status: "approved",
    generated_at: new Date().toISOString(),
    source_script_sha256: sourceScriptSha256,
    authoring: {
      kind: "llm_authored",
      provider: providers.join("+") || "planning_room",
      model: models.join("+") || "identity_locked_model",
      controls: ["punctuation", "sentence_complete_unit_boundaries", "dialogue_separation"],
      unsupported_controls_not_submitted: ["emotion_tags", "natural_language_instruct", "speed_control"],
      calls: calls.map(({ units: _units, ...call }) => call),
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
