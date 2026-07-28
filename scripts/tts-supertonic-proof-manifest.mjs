#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactSpokenPlanForDiagnostics } from "./voice-direction-gate.mjs";

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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertExternalOutput(outputDir, episodeDir) {
  if (isInside(outputDir, episodeDir)) {
    throw new Error(`Proof output must be outside the source episode: ${outputDir}`);
  }
  if (path.resolve(outputDir).split(path.sep).includes("episodes")) {
    throw new Error(`Proof output cannot be written under any production episodes directory: ${outputDir}`);
  }
}

function assertCurrentHash(label, artifact, expectedHash) {
  if (artifact?.source_script_hash !== expectedHash) {
    throw new Error(`${label} is stale: expected source_script_hash ${expectedHash}, found ${artifact?.source_script_hash ?? "missing"}`);
  }
}

function numberFlag(flags, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const value = Number(flags[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${name} must be between ${min} and ${max}`);
  }
  return value;
}

function supertonicSafeText(value) {
  const keepUpper = new Set(["UI", "ID", "SSS", "SS", "S", "A", "B", "C", "D", "E", "F"]);
  return String(value ?? "")
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replaceAll("‘", "'")
    .replaceAll("’", "'")
    .replace(/\b[A-Z][A-Z0-9' -]{2,}\b/g, (match) => match
      .split(/(\s+|-)/)
      .map((part) => {
        if (/^\s+$|^-$/u.test(part) || keepUpper.has(part) || !/[A-Z]/.test(part)) return part;
        return part.charAt(0) + part.slice(1).toLowerCase();
      })
      .join(""))
    .replace(/\s+/g, " ")
    .trim();
}

function coverageTokens(value) {
  return (String(value ?? "").normalize("NFKC").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [])
    .map((token) => token.replaceAll("’", "'").toLowerCase());
}

function applyProofPunctuationRules(value, rules) {
  let text = String(value ?? "");
  for (const rule of rules) {
    if (!rule?.from || !rule?.to) continue;
    if (coverageTokens(rule.from).join("\u001f") !== coverageTokens(rule.to).join("\u001f")) {
      throw new Error(`Proof punctuation rule changes lexical text: ${rule.from} -> ${rule.to}`);
    }
    text = text.replaceAll(rule.from, rule.to);
  }
  return text;
}

function exactPlanSourceUnits(plan, punctuationRules = []) {
  return (plan?.segments ?? []).flatMap((segment) => (segment.qwen_generation_units ?? []).map((unit) => {
    const text = applyProofPunctuationRules(supertonicSafeText(unit.qwen_spoken_text), punctuationRules);
    const sourceSpeaker = String(unit.source_speaker ?? unit.speaker ?? "NARRATOR");
    const captionText = String(unit.caption_text ?? unit.source_text ?? "").trim();
    const captionLetters = captionText.replace(/[^\p{L}]+/gu, "");
    const allCapsUi = captionLetters.length >= 2 && captionLetters === captionLetters.toUpperCase();
    const contextFamily = allCapsUi
      ? "system_ui"
      : /^NARRATOR$/i.test(sourceSpeaker) && String(unit.kind ?? "narration").toLowerCase() === "narration"
      ? "narration"
      : `performance:${sourceSpeaker.toUpperCase()}`;
    return {
      source_id: `${segment.segment_id}#${unit.unit_index}`,
      source_segment_id: segment.segment_id,
      source_segment_ids: [segment.segment_id],
      source_speaker: sourceSpeaker,
      source_speakers: [sourceSpeaker],
      unit_index: unit.unit_index,
      text,
      caption_text: captionText,
      kind: unit.kind ?? "narration",
      context_family: contextFamily,
      merge_barrier: contextFamily !== "narration",
      tts_override_replacements_applied: unit.tts_override_replacements_applied ?? [],
      source_unit_refs: [{
        segment_id: segment.segment_id,
        unit_index: unit.unit_index,
        source_speaker: sourceSpeaker,
        caption_text: unit.caption_text ?? unit.source_text ?? "",
      }],
    };
  })).filter((unit) => /[\p{L}\p{N}]/u.test(unit.text));
}

function reflowAtSentenceBoundaries(sourceUnits, maxChars) {
  const runs = [];
  for (const unit of sourceUnits) {
    const previous = runs.at(-1)?.at(-1);
    if (previous && previous.context_family === unit.context_family) runs.at(-1).push(unit);
    else runs.push([unit]);
  }
  const output = [];
  const textForRange = (tokens, start, end) => tokens.slice(start, end).map((row) => row.word).join(" ");
  const isSentenceEnd = (token) => /[.!?]["')\]]*$/u.test(token ?? "");
  const isClauseEnd = (token) => /[,;:—]["')\]]*$/u.test(token ?? "");
  for (const run of runs) {
    const tokens = run.flatMap((source) => source.text.split(/\s+/).filter(Boolean).map((word) => ({ word, source })));
    let start = 0;
    while (start < tokens.length) {
      let farthest = start + 1;
      while (farthest <= tokens.length && textForRange(tokens, start, farthest).length <= maxChars) farthest += 1;
      farthest = Math.max(start + 1, farthest - 1);
      let end = farthest;
      if (farthest < tokens.length) {
        const sentenceEnds = [];
        const clauseEnds = [];
        for (let candidate = start + 1; candidate <= farthest; candidate += 1) {
          if (isSentenceEnd(tokens[candidate - 1].word)) sentenceEnds.push(candidate);
          else if (isClauseEnd(tokens[candidate - 1].word)) clauseEnds.push(candidate);
        }
        end = sentenceEnds.at(-1) ?? clauseEnds.at(-1) ?? farthest;
      }
      const selected = tokens.slice(start, end);
      const sources = [...new Map(selected.map((row) => [row.source.source_id, row.source])).values()];
      const text = selected.map((row) => row.word).join(" ");
      const sourceUnitRefs = sources.flatMap((source) => source.source_unit_refs)
        .filter((row, index, rows) => rows.findIndex((candidate) => candidate.segment_id === row.segment_id
          && candidate.unit_index === row.unit_index) === index);
      const sourceSegmentIds = [...new Set(sources.map((source) => source.source_segment_id))];
      const first = sources[0];
      output.push({
        unit_id: `stp_${first.source_segment_id}_${first.unit_index}_${sha256(text).slice(0, 12)}`.replace(/[^A-Za-z0-9_.-]/g, "-"),
        text,
        word_count: selected.length,
        character_count: text.length,
        caption_text: null,
        caption_policy: "The locked script remains caption truth; proof-side units carry source references rather than re-authored captions.",
        source_segment_ids: sourceSegmentIds,
        source_speakers: [...new Set(sources.map((source) => source.source_speaker))],
        source_unit_refs: sourceUnitRefs,
        kind: sources.length === 1 ? first.kind : "narration",
        context_family: first.context_family,
        speaker: "NARRATOR",
        voice_id: "supertonic3_M3",
        merge_barrier: sources.some((source) => source.merge_barrier),
        ended_at_sentence_boundary: isSentenceEnd(selected.at(-1)?.word),
        ended_at_clause_boundary: isClauseEnd(selected.at(-1)?.word),
        tts_override_replacements_applied: sources.flatMap((source) => source.tts_override_replacements_applied ?? []),
      });
      start = end;
    }
  }
  return output;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const episodeDir = path.resolve(String(flags["episode-dir"] ?? ""));
  const outputDir = path.resolve(String(flags["output-dir"] ?? ""));
  if (!flags["episode-dir"] || !flags["output-dir"]) {
    throw new Error("Usage: tts-supertonic-proof-manifest.mjs --episode-dir <approved episode> --output-dir <external proof dir>");
  }
  assertExternalOutput(outputDir, episodeDir);

  const targetDurationSec = numberFlag(flags, "target-sec", 600, { min: 60, max: 1800 });
  const targetWpm = numberFlag(flags, "target-wpm", 208.611, { min: 100, max: 350 });
  const minWords = numberFlag(flags, "min-words", 20, { min: 1, max: 100 });
  const maxWords = numberFlag(flags, "max-words", 45, { min: minWords, max: 100 });
  const maxChars = numberFlag(flags, "max-chars", 280, { min: 100, max: 300 });
  const lookaheadWords = Math.ceil(numberFlag(
    flags,
    "lookahead-words",
    targetDurationSec * targetWpm / 60 * 1.12,
    { min: 100, max: 10000 },
  ));

  const scriptPath = path.join(episodeDir, "script_clean.md");
  const lockPath = path.join(episodeDir, "script_lock.json");
  const identityPath = path.join(episodeDir, "run_identity.json");
  const speakabilityPath = path.join(episodeDir, "script_speakability_report.json");
  const overridesPath = path.join(episodeDir, "tts_spoken_overrides.json");
  const proofPunctuationPath = path.join(outputDir, "proof_tts_punctuation_overrides.json");
  const [scriptBuffer, lock, identity, speakability, overrides] = await Promise.all([
    fs.readFile(scriptPath),
    readJson(lockPath),
    readJson(identityPath),
    readJson(speakabilityPath),
    readJson(overridesPath),
  ]);
  const script = scriptBuffer.toString("utf8");
  const scriptHash = sha256(scriptBuffer);
  if (lock?.status !== "script_locked") throw new Error(`Script lock is not approved: ${lock?.status ?? "missing"}`);
  assertCurrentHash("script_lock.json", lock, scriptHash);
  if (speakability?.status !== "passed") throw new Error(`Speakability report is not passed: ${speakability?.status ?? "missing"}`);
  assertCurrentHash("script_speakability_report.json", speakability, scriptHash);
  if (overrides?.status !== "passed") throw new Error(`TTS spoken overrides are not passed: ${overrides?.status ?? "missing"}`);
  assertCurrentHash("tts_spoken_overrides.json", overrides, scriptHash);
  const proofPunctuation = await readJson(proofPunctuationPath).catch(() => ({
    status: "not_configured",
    source_script_hash: scriptHash,
    rules: [],
  }));
  if (!["passed", "not_configured"].includes(proofPunctuation.status)) {
    throw new Error(`Proof punctuation overrides are not approved: ${proofPunctuation.status ?? "missing"}`);
  }
  if (proofPunctuation.status === "passed") {
    assertCurrentHash("proof_tts_punctuation_overrides.json", proofPunctuation, scriptHash);
  }

  const exact = buildExactSpokenPlanForDiagnostics(script, {
    ttsOverrides: overrides,
    ttsProvider: "supertonic_local",
  });
  if (exact.status !== "passed") {
    throw new Error(`Fresh proof voice plan failed exact coverage: ${JSON.stringify({
      text_integrity: exact.text_integrity_coverage,
      system_ui: exact.system_ui_speech_coverage,
    })}`);
  }

  const exactSourceUnits = exactPlanSourceUnits(exact.plan, proofPunctuation.rules ?? []);
  const expectedSpokenTokens = coverageTokens((exact.plan.segments ?? [])
    .flatMap((segment) => segment.qwen_generation_units ?? [])
    .map((unit) => unit.qwen_spoken_text)
    .join(" "));
  const adaptedSpokenTokens = coverageTokens(exactSourceUnits.map((unit) => unit.text).join(" "));
  if (expectedSpokenTokens.join("\u001f") !== adaptedSpokenTokens.join("\u001f")) {
    throw new Error("Supertonic text adaptation changed lexical coverage; proof generation is blocked.");
  }
  const allUnits = reflowAtSentenceBoundaries(exactSourceUnits, maxChars);
  const selected = [];
  let selectedWords = 0;
  for (const unit of allUnits) {
    selected.push(unit);
    selectedWords += unit.word_count;
    if (selectedWords >= lookaheadWords) break;
  }
  if (!selected.length || selectedWords < lookaheadWords) {
    throw new Error(`Episode has only ${selectedWords} selectable words; proof lookahead requires ${lookaheadWords}`);
  }
  const oversized = selected.filter((unit) => unit.text.length > maxChars);
  if (oversized.length) {
    throw new Error(`Proof contains ${oversized.length} unit(s) over ${maxChars} characters: ${oversized.slice(0, 5).map((row) => row.unit_id).join(", ")}`);
  }

  await fs.mkdir(outputDir, { recursive: true });
  const freshPlanPath = path.join(outputDir, "fresh_exact_voice_plan.json");
  const manifestPath = path.join(outputDir, "proof_generation_manifest.json");
  await writeJson(freshPlanPath, {
    schema: "goldflow_supertonic_proof_fresh_voice_plan_v1",
    status: "passed",
    diagnostic_only: true,
    source_episode_dir: episodeDir,
    source_script_path: scriptPath,
    source_script_hash: scriptHash,
    text_integrity_coverage: exact.text_integrity_coverage,
    system_ui_speech_coverage: exact.system_ui_speech_coverage,
    plan: exact.plan,
  });
  const manifest = {
    schema: "goldflow_supertonic_ten_minute_proof_manifest_v1",
    status: "passed",
    diagnostic_only: true,
    production_artifacts_mutated: false,
    generated_at: new Date().toISOString(),
    source_episode_dir: episodeDir,
    source_identity: {
      channel: identity.channel,
      series_slug: identity.series_slug,
      week: identity.week,
      episode: identity.episode,
      title: identity.title,
      proof_scope: identity.proof_scope,
    },
    source_artifacts: {
      script_path: scriptPath,
      script_sha256: scriptHash,
      script_lock_path: lockPath,
      script_lock_sha256: sha256(await fs.readFile(lockPath)),
      speakability_path: speakabilityPath,
      speakability_sha256: sha256(await fs.readFile(speakabilityPath)),
      overrides_path: overridesPath,
      overrides_sha256: sha256(await fs.readFile(overridesPath)),
      fresh_voice_plan_path: freshPlanPath,
      fresh_voice_plan_sha256: sha256(await fs.readFile(freshPlanPath)),
      proof_punctuation_overrides_path: proofPunctuation.status === "passed" ? proofPunctuationPath : null,
      proof_punctuation_overrides_sha256: proofPunctuation.status === "passed"
        ? sha256(await fs.readFile(proofPunctuationPath))
        : null,
    },
    coverage: {
      text_integrity: exact.text_integrity_coverage,
      system_ui_speech: exact.system_ui_speech_coverage,
    },
    proof_scope: {
      selection: "contiguous opening prefix, whole synthesis units only",
      target_duration_sec: targetDurationSec,
      target_wpm_estimate: targetWpm,
      lookahead_word_target: lookaheadWords,
      selected_lookahead_word_count: selectedWords,
      selected_lookahead_unit_count: selected.length,
      final_selection_rule: "retain complete units through the first prepared-audio boundary at or after target_duration_sec",
    },
    synthesis: {
      provider: "local_supertonic",
      model: "supertonic-3",
      model_source: "Supertone/supertonic-3",
      voice: "M3",
      language_code: "en",
      native_speed: 1.12,
      total_steps: 8,
      max_chunk_length: maxChars,
      internal_chunk_silence_sec: 0,
      expected_sdk_chunks_per_passage: 1,
      reference_audio: null,
      voice_clone: false,
      proof_punctuation_rules: proofPunctuation.rules ?? [],
    },
    unitization: {
      min_words: minWords,
      max_words: maxWords,
      max_chars: maxChars,
      narrator_only: true,
      instruction_field: null,
      strategy: "sentence_boundary_first_reflow_with_clause_fallback",
      lexical_coverage_after_supertonic_adaptation: "passed",
    },
    passages: selected.map((unit, index) => ({
      id: unit.unit_id,
      order: index + 1,
      text: unit.text,
      text_sha256: sha256(unit.text),
      word_count: unit.word_count,
      character_count: unit.character_count,
      caption_text: unit.caption_text,
      caption_fragments: unit.caption_fragments,
      source_segment_ids: unit.source_segment_ids,
      source_speakers: unit.source_speakers,
      source_unit_refs: unit.source_unit_refs,
      ended_at_sentence_boundary: unit.ended_at_sentence_boundary,
      ended_at_clause_boundary: unit.ended_at_clause_boundary,
      context_family: unit.context_family,
      chunk_policy: {
        sentence_boundary_preferred: true,
        clause_boundary_fallback: true,
        hard_max_chars: maxChars,
        below_min_word_target: unit.word_count < minWords,
        above_max_word_target: unit.word_count > maxWords,
        merge_barrier: unit.merge_barrier,
      },
      tts_override_replacements_applied: unit.tts_override_replacements_applied,
    })),
  };
  await writeJson(manifestPath, manifest);
  console.log(JSON.stringify({
    status: "passed",
    manifest_path: manifestPath,
    selected_unit_count: selected.length,
    selected_word_count: selectedWords,
    text_integrity_coverage: exact.text_integrity_coverage.status,
    system_ui_speech_coverage: exact.system_ui_speech_coverage.status,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
