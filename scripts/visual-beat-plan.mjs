#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { alignExcerptRowsToWhisper } from "./lib/transcript-excerpt-alignment.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";
import { isCodexCacheCompatible, readCodexCallMetadata, runCodexCli } from "./lib/codex-cli-runner.mjs";
import {
  buildEditorialDirectorPrompt,
  buildTranscriptAtoms,
  editorialBeatCoverageFindings,
  editorialRetentionRailFindings,
  groupingLockHash,
  normalizeEditorialGrouping,
  projectActiveStateConstraints,
} from "./lib/editorial-beat-director.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const timedPlanPath = flags.timed ?? path.join(episodeDir, "timed_scene_plan.json");
const scriptPath = flags.script ?? path.join(episodeDir, "script_clean.md");
const wordTimingPath = flags.wordTiming ?? flags["word-timing"] ?? path.join(episodeDir, `narration_word_timing_${episode}.json`);
const outputPath = flags.output ?? path.join(episodeDir, "visual_beat_plan.json");
const storyFactLedgerPath = flags["story-fact-ledger"] ?? path.join(episodeDir, "story_fact_ledger.json");
const runIdentityPath = path.join(episodeDir, "run_identity.json");
const visualBeatApprovalPath = flags["approval-output"] ?? path.join(episodeDir, "visual_beat_approval.json");
const targetBeatSec = Number(flags["target-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_TARGET_BEAT_SEC ?? 8.5);
const maxBeatSec = Number(flags["max-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_MAX_BEAT_SEC ?? 15);
const minBeatSec = Number(flags["min-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_MIN_BEAT_SEC ?? 3);
const hookDurationSec = Number(flags["hook-duration-sec"] ?? process.env.ANIFACTORY_VISUAL_HOOK_DURATION_SEC ?? 30);
const hookTargetBeatSec = Number(flags["hook-target-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_HOOK_TARGET_BEAT_SEC ?? 3.2);
const hookMaxBeatSec = Number(flags["hook-max-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_HOOK_MAX_BEAT_SEC ?? 4.2);
const hookMinBeatSec = Number(flags["hook-min-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_HOOK_MIN_BEAT_SEC ?? 2.2);
const retentionRampSec = Number(flags["retention-ramp-sec"] ?? process.env.ANIFACTORY_VISUAL_RETENTION_RAMP_SEC ?? 180);
const rampTargetBeatSec = Number(flags["ramp-target-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_RAMP_TARGET_BEAT_SEC ?? 5.2);
const rampMaxBeatSec = Number(flags["ramp-max-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_RAMP_MAX_BEAT_SEC ?? 6.5);
const rampMinBeatSec = Number(flags["ramp-min-beat-sec"] ?? process.env.ANIFACTORY_VISUAL_RAMP_MIN_BEAT_SEC ?? 3.2);
const allowEmptyBeatExcerpts = flags["allow-empty-beat-excerpts"] === "true" || process.env.ANIFACTORY_ALLOW_EMPTY_VISUAL_BEAT_EXCERPTS === "true";
const allowUnderTargetRetentionBeats = flags["allow-under-target-retention-beats"] === "true"
  || process.env.ANIFACTORY_ALLOW_UNDER_TARGET_RETENTION_BEATS === "true";
const blockVisualBeatQualityFindings = flags["block-visual-beat-quality-findings"] === "true"
  || process.env.ANIFACTORY_BLOCK_VISUAL_BEAT_QUALITY_FINDINGS === "true";
const scopeStartSec = flags["scope-start-sec"] == null ? null : Number(flags["scope-start-sec"]);
const scopeEndSec = flags["scope-end-sec"] ?? flags["max-time-sec"] ?? flags["first-sec"];
const scopeEndSecNumber = scopeEndSec == null ? null : Number(scopeEndSec);
const VISUAL_BEAT_CONTRACT_VERSION = "visual_beat_ref_strategy_v2";
const EDITORIAL_VISUAL_BEAT_CONTRACT_VERSION = "visual_beat_editorial_v3";

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

export function factLedgerMatchesScriptForTests(factLedger, scriptPathValue, scriptHash) {
  const recordedHash = factLedger?.source_hashes?.[scriptPathValue] ?? factLedger?.source_script_hash ?? null;
  return factLedger?.status === "passed" && recordedHash === scriptHash;
}

function normalizedScopeToken(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9']+/g, "").replace(/^'+|'+$/g, "");
}

export function scriptPrefixForTimedWordsForTests(scriptText, timedWords) {
  const sourceTokens = String(scriptText ?? "").trim().split(/\s+/).filter(Boolean);
  const sourceNormalized = sourceTokens.map(normalizedScopeToken);
  const timingNormalized = (timedWords ?? []).map((row) => normalizedScopeToken(row?.normalized ?? row?.word)).filter(Boolean);
  for (let window = Math.min(18, timingNormalized.length); window >= Math.min(5, timingNormalized.length); window -= 1) {
    const needle = timingNormalized.slice(-window);
    const candidates = [];
    for (let index = 0; index <= sourceNormalized.length - needle.length; index += 1) {
      if (needle.every((token, offset) => sourceNormalized[index + offset] === token)) candidates.push(index + needle.length);
    }
    if (!candidates.length) continue;
    const endExclusive = candidates.sort((left, right) => Math.abs(left - timingNormalized.length) - Math.abs(right - timingNormalized.length))[0];
    return {
      script: `${sourceTokens.slice(0, endExclusive).join(" ")}\n`,
      source_word_end_exclusive: endExclusive,
      matched_timing_tail_words: window,
      fallback: false,
    };
  }
  const endExclusive = Math.min(sourceTokens.length, timingNormalized.length);
  return {
    script: `${sourceTokens.slice(0, endExclusive).join(" ")}\n`,
    source_word_end_exclusive: endExclusive,
    matched_timing_tail_words: 0,
    fallback: true,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function hashFile(filePath) {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function beatFocusLabel(index, count, startSec = null) {
  if (Number.isFinite(Number(startSec)) && Number(startSec) < hookDurationSec) {
    const hookLabels = [
      "hook visual punch: immediate high-contrast premise image",
      "hook reversal beat with changed camera angle and visible stakes",
      "hook escalation beat with new subject, new prop, or system/story reveal",
      "hook reaction beat: readable face, hand, crowd, or UI consequence",
      "hook payoff beat that forces the next click-forward question",
    ];
    return hookLabels[index % hookLabels.length];
  }
  if (Number.isFinite(Number(startSec)) && Number(startSec) < retentionRampSec) {
    const rampLabels = [
      "retention ramp: new story information with changed composition",
      "retention ramp: emotional reaction or social proof beat",
      "retention ramp: system/threat/status reveal beat",
      "retention ramp: movement beat that pulls viewer to the next question",
    ];
    return rampLabels[index % rampLabels.length];
  }
  if (count === 1) return "single establishing visual beat";
  if (index === 0) return "establish current location, visible subjects, and spatial relationship";
  if (index === count - 1) return "end-state beat showing the scene consequence or reveal";
  if (count === 2) return "reaction or action progression beat";
  const middle = index / Math.max(1, count - 1);
  if (middle < 0.4) return "early action beat with clear subject motion and readable staging";
  if (middle < 0.75) return "middle escalation beat with changed pose, changed camera angle, and current-scene action";
  return "late action beat with consequence, reaction, or UI/story reveal";
}

function splitSentences(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [];
}

function spokenWordCount(text) {
  return String(text ?? "")
    .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function splitLongSentence(text, maxWords = 24) {
  const source = String(text ?? "").trim();
  if (spokenWordCount(source) <= maxWords) return [source].filter(Boolean);
  const clauses = source
    .split(/(?<=[,;:])\s+|\s+(?=\b(?:then|but|and|because|while|when|before|after)\b)/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (clauses.length <= 1) return [source];
  const chunks = [];
  let current = "";
  for (const clause of clauses) {
    const candidate = current ? `${current} ${clause}` : clause;
    if (current && spokenWordCount(candidate) > maxWords) {
      chunks.push(current);
      current = clause;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitByWordCount(text, maxWords = 18) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const chunks = [];
  for (let index = 0; index < words.length; index += maxWords) {
    chunks.push(words.slice(index, index + maxWords).join(" "));
  }
  return chunks;
}

function sceneWords(wordTiming, scene) {
  const words = Array.isArray(wordTiming?.words) ? wordTiming.words : [];
  const start = Number(scene.start_sec ?? 0);
  const end = Number(scene.end_sec ?? (start + Number(scene.duration_sec ?? 0)));
  return words.filter((word) => {
    const wordStart = Number(word.start_sec ?? word.start ?? 0);
    const wordEnd = Number(word.end_sec ?? word.end ?? wordStart);
    return wordEnd >= start - 0.35 && wordStart <= end + 0.35;
  });
}

function timedTextUnits(sceneText, scene, wordRows) {
  const rawSentences = splitSentences(sceneText).flatMap((sentence) => splitLongSentence(sentence));
  const sentenceWords = rawSentences.map(spokenWordCount);
  const totalSentenceWords = sentenceWords.reduce((sum, count) => sum + count, 0);
  const sceneStart = Number(scene.start_sec ?? 0);
  const sceneEnd = Number(scene.end_sec ?? (sceneStart + Number(scene.duration_sec ?? 0)));
  const sceneDuration = Math.max(0.001, sceneEnd - sceneStart);
  let cumulativeWords = 0;
  return rawSentences.map((text, index) => {
    const count = Math.max(1, sentenceWords[index] ?? 1);
    const startRatio = totalSentenceWords > 0 ? cumulativeWords / totalSentenceWords : index / Math.max(1, rawSentences.length);
    const endRatio = totalSentenceWords > 0 ? (cumulativeWords + count) / totalSentenceWords : (index + 1) / Math.max(1, rawSentences.length);
    const wordStartIndex = Math.min(Math.max(0, Math.floor(startRatio * wordRows.length)), Math.max(0, wordRows.length - 1));
    const wordEndIndex = Math.min(Math.max(wordStartIndex, Math.ceil(endRatio * wordRows.length) - 1), Math.max(0, wordRows.length - 1));
    const startWord = wordRows[wordStartIndex] ?? null;
    const endWord = wordRows[wordEndIndex] ?? null;
    const startSec = startWord ? Number(startWord.start_sec ?? startWord.start ?? sceneStart) : sceneStart + sceneDuration * startRatio;
    const endSec = endWord ? Number(endWord.end_sec ?? endWord.end ?? (sceneStart + sceneDuration * endRatio)) : sceneStart + sceneDuration * endRatio;
    cumulativeWords += count;
    return {
      text,
      start_sec: Number(Math.max(sceneStart, Math.min(sceneEnd, startSec)).toFixed(3)),
      end_sec: Number(Math.max(sceneStart, Math.min(sceneEnd, endSec)).toFixed(3)),
      word_count: count,
    };
  });
}

function editorialCueForText(text, scene = {}) {
  const source = String(text ?? "").toLowerCase();
  const cues = [];
  if (/\b(?:system|quest|mission|reward|penalty|rank|level|status|activated|interface|panel|notification|dashboard|ledger|audit|skill|ability|regression|transmigration)\b/.test(source)) cues.push("system_message");
  if (/\b(?:goal|objective|condition|failure|complete|completed|success|timer|deadline|percent|score|trial|task|challenge|requirement)\b/.test(source)) cues.push("objective_or_reward");
  if (/\b(?:audience|crowd|public|witness|viewer|viewers|chat|comment|comments|message|messages|broadcast|livestream|recording|camera|metric|counter|count|score|rank|ranking|rating|votes|followers|likes|subscribers|reputation|credibility|trust|truth)\b/.test(source)) cues.push("chat_or_viewer_count_change");
  if (/\b(?:humiliated|shamed|insulted|laughed|mocked|rejected|betrayed|dumped|exposed|embarrassed|framed|accused|blamed|exiled|threatened|called me|called you|labeled me|labeled you|branded me|branded you|kneel|begged)\b/.test(source)
    || /\b(?:they|crowd|public|audience|everyone)\s+(?:see|sees|saw|treat|treated|label|labeled|brand|branded|frame|framed|record|recorded|clip|clipped)\s+(?:you|me|him|her|them)\s+as\b/.test(source)) cues.push("public_humiliation_or_reversal");
  if (/\b(?:but|then|instead|until|suddenly|for the first time|mistake|changed|turned|opened|stopped)\b/.test(source)) cues.push("emotional_pivot");
  if (/\b(?:threat|danger|warning|warned|warns|enemy|rival|failure|remain|lost|kill|trap|punish)\b/.test(source)) cues.push("threat_reveal");
  if (/\b(?:hall|room|stage|lobby|campus|arena|court|boardroom|office|dorm|apartment|kitchen|elevator|tower|district|station|gym|street|floor|hallway|corridor|courtyard|temple|palace|library|classroom|studio|theater|restaurant|cafe|hospital|bank|store|market|platform|roof|basement|warehouse|server|train|capital)\b/.test(source)) cues.push("location_signal");
  const visibleSubjects = Array.isArray(scene.visible_subjects) ? scene.visible_subjects : [];
  const namedMentions = visibleSubjects.filter((name) => {
    const first = String(name).split(/\s+/)[0]?.toLowerCase();
    return first && first.length > 2 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  });
  if (namedMentions.length) cues.push("named_character_present");
  return [...new Set(cues)];
}

function visualJobFromCues(cues, text, index, count, startSec) {
  const cueSet = new Set(cues);
  const source = String(text ?? "").toLowerCase();
  if (Number(startSec) < hookDurationSec && index === 0) return "premise_image";
  if (cueSet.has("public_humiliation_or_reversal")) return "humiliation_image";
  if (/\b(?:consequence|proof|evidence|receipt|result|payoff|revealed|exposed|confirmed|failed|failure|shattered|landed)\b/i.test(source)) return "consequence";
  if (cueSet.has("chat_or_viewer_count_change") && /\b(?:chat|comment|message|viewer|viewers|audience|count|watching|metric|counter|score|rank|ranking|rating|votes|followers|likes|subscribers|reputation|credibility|trust|truth)\b/i.test(source)) return "chat_ui_insert";
  if (cueSet.has("location_signal") && /\b(?:crossed|entered|arrived|walked|stepped|moved|went|into|inside|through|toward)\b/i.test(source)) return "location_transition";
  if (cueSet.has("system_message") || cueSet.has("objective_or_reward")) return "system_reveal";
  if (cueSet.has("chat_or_viewer_count_change")) return "reaction_shot";
  if (cueSet.has("location_signal") && index === 0) return "location_transition";
  if (cueSet.has("threat_reveal")) return "threat_reveal";
  if (/\b(?:watched|looked|laughed|smiled|said|asked|voice|hand)\b/i.test(source)) return "reaction_shot";
  if (index === count - 1) return "cliffhanger_question";
  return "story_progression";
}

function shotJobFromVisualJob(visualJob) {
  const map = {
    premise_image: "environment_establishing",
    humiliation_image: "interaction",
    system_reveal: "ui_reveal",
    reaction_shot: "emotional_reaction",
    chat_ui_insert: "ui_reveal",
    remote_witness_cutaway: "emotional_reaction",
    location_transition: "transition",
    consequence: "consequence",
    cliffhanger_question: "transition",
    threat_reveal: "ui_reveal",
    story_progression: "interaction",
  };
  return map[visualJob] ?? "interaction";
}

function retentionVariedVisualJob(visualJob, { location, previousBeats = [], beatText = "", startSec = 0 } = {}) {
  if (Number(startSec) >= retentionRampSec || !location || !visualJob) return visualJob;
  let sameRun = 0;
  for (let index = previousBeats.length - 1; index >= 0; index -= 1) {
    const previous = previousBeats[index];
    if (normalizeComparable(previous.local_location ?? previous.location ?? "") !== normalizeComparable(location)) break;
    if (String(previous.visual_job ?? "") !== String(visualJob)) break;
    sameRun += 1;
  }
  if (sameRun < 3) return visualJob;
  const source = String(beatText ?? "").toLowerCase();
  const alternates = [];
  if (/\b(?:system|quest|status|rank|level|panel|screen|ledger|audit|message|timer|counter)\b/.test(source)) alternates.push("system_reveal", "chat_ui_insert");
  if (/\b(?:recorder|flare|ledger|contract|receipt|knife|bell|rope|shield|paper|card|key|badge)\b/.test(source)) alternates.push("consequence");
  if (/\b(?:danger|trap|monster|kill|threat|warning|blood|attack|hounds|enemy)\b/.test(source)) alternates.push("threat_reveal");
  if (/\b(?:entered|crossed|toward|through|corridor|hall|room|gate|door|crawlspace|bridge|library)\b/.test(source)) alternates.push("location_transition");
  alternates.push("reaction_shot", "consequence", "threat_reveal", "location_transition");
  return alternates.find((candidate) => candidate !== visualJob) ?? visualJob;
}

function mergeEditorialUnits(units, scene) {
  const maxHoldForStart = (startSec) => {
    const value = Number(startSec);
    if (value < hookDurationSec) return hookMaxBeatSec;
    if (value < retentionRampSec) return rampMaxBeatSec;
    return maxBeatSec;
  };
  const merged = [];
  for (const unit of units) {
    const duration = Number(unit.end_sec) - Number(unit.start_sec);
    const retentionRunway = Number(unit.start_sec) < retentionRampSec;
    const hardCueCodes = retentionRunway ? [
      "system_message",
      "objective_or_reward",
      "public_humiliation_or_reversal",
      "chat_or_viewer_count_change",
      "threat_reveal",
      "location_signal",
    ] : [
      "system_message",
      "objective_or_reward",
      "threat_reveal",
      "location_signal",
    ];
    const strongCue = unit.editorial_cues.some((cue) => hardCueCodes.includes(cue));
    const targetForTime = Number(unit.start_sec) < hookDurationSec
      ? hookTargetBeatSec * 0.85
      : Number(unit.start_sec) < retentionRampSec
        ? rampTargetBeatSec * 0.8
        : targetBeatSec;
    const previous = merged[merged.length - 1];
    const previousDuration = previous ? Number(previous.end_sec) - Number(previous.start_sec) : 0;
    const previousMaxHold = previous ? maxHoldForStart(previous.start_sec) : maxBeatSec;
    if (previous && !strongCue && previousDuration < targetForTime && previousDuration + duration <= previousMaxHold) {
      previous.text = `${previous.text} ${unit.text}`.trim();
      previous.end_sec = unit.end_sec;
      previous.word_count += unit.word_count;
      previous.editorial_cues = [...new Set([...previous.editorial_cues, ...unit.editorial_cues])];
      previous.visual_job = visualJobFromCues(previous.editorial_cues, previous.text, merged.length - 1, units.length, previous.start_sec);
      previous.suggested_shot_job = shotJobFromVisualJob(previous.visual_job);
    } else {
      merged.push({ ...unit });
    }
  }
  const minHoldForStart = (startSec) => {
    const value = Number(startSec);
    if (value < hookDurationSec) return Math.max(0.75, hookMinBeatSec * 0.6);
    if (value < retentionRampSec) return Math.min(3.6, Math.max(2.8, rampTargetBeatSec * 0.62));
    return Math.min(4.5, Math.max(3.5, targetBeatSec * 0.65));
  };
  const coalesced = [];
  for (let index = 0; index < merged.length; index += 1) {
    const unit = { ...merged[index] };
    const unitStart = Number(unit.start_sec);
    const unitDuration = Number(unit.end_sec) - unitStart;
    const minHoldSec = minHoldForStart(unitStart);
    if (Number.isFinite(unitDuration) && unitDuration < minHoldSec) {
      const previous = coalesced[coalesced.length - 1];
      const previousStart = previous ? Number(previous.start_sec) : null;
      const previousDuration = previous ? Number(previous.end_sec) - Number(previous.start_sec) : 0;
      const next = merged[index + 1];
      const previousTarget = previousStart !== null && previousStart < hookDurationSec
        ? hookTargetBeatSec
        : previousStart !== null && previousStart < retentionRampSec
          ? rampTargetBeatSec
          : targetBeatSec;
      const previousCanAbsorb = previous
        && previousDuration + unitDuration <= maxHoldForStart(previousStart)
        && (unitDuration < 1.5 || previousDuration < previousTarget * 1.25);
      const nextCanAbsorb = Boolean(next);
      if (previousCanAbsorb) {
        previous.text = `${previous.text} ${unit.text}`.trim();
        previous.end_sec = unit.end_sec;
        previous.word_count += unit.word_count;
        previous.editorial_cues = [...new Set([...previous.editorial_cues, ...unit.editorial_cues])];
        previous.visual_job = visualJobFromCues(previous.editorial_cues, previous.text, coalesced.length - 1, units.length, previous.start_sec);
        previous.suggested_shot_job = shotJobFromVisualJob(previous.visual_job);
        continue;
      }
      if (nextCanAbsorb) {
        next.text = `${unit.text} ${next.text}`.trim();
        next.start_sec = unit.start_sec;
        next.word_count += unit.word_count;
        next.editorial_cues = [...new Set([...unit.editorial_cues, ...next.editorial_cues])];
        next.visual_job = visualJobFromCues(next.editorial_cues, next.text, index, units.length, next.start_sec);
        next.suggested_shot_job = shotJobFromVisualJob(next.visual_job);
        continue;
      }
    }
    coalesced.push(unit);
  }
  const bounded = [];
  for (const unit of coalesced) {
    const duration = Number(unit.end_sec) - Number(unit.start_sec);
    const maxHoldSec = maxHoldForStart(unit.start_sec);
    let sentenceParts = splitSentences(unit.text);
    if (duration > maxHoldSec && sentenceParts.length <= 1) {
      const wordCount = Math.max(1, spokenWordCount(unit.text));
      const dynamicMaxWords = Math.max(6, Math.floor(wordCount * (maxHoldSec / duration)));
      sentenceParts = splitLongSentence(unit.text, dynamicMaxWords);
      if (sentenceParts.length <= 1) sentenceParts = splitByWordCount(unit.text, dynamicMaxWords);
    }
    if (duration <= maxHoldSec || sentenceParts.length <= 1) {
      bounded.push(unit);
      continue;
    }
    const partWeights = sentenceParts.map((sentence) => Math.max(1, spokenWordCount(sentence)));
    const totalWeight = partWeights.reduce((sum, weight) => sum + weight, 0);
    let chunkText = "";
    let chunkWeight = 0;
    let chunkStart = Number(unit.start_sec);
    let elapsed = 0;
    const flushChunk = () => {
      if (!chunkText) return;
      const chunkDuration = duration * (chunkWeight / totalWeight);
      const chunkEnd = Math.min(Number(unit.end_sec), chunkStart + chunkDuration);
      const chunkCues = editorialCueForText(chunkText, scene);
      const visualJob = visualJobFromCues(chunkCues, chunkText, bounded.length, coalesced.length, chunkStart);
      bounded.push({
        ...unit,
        text: chunkText.trim(),
        start_sec: Number(chunkStart.toFixed(3)),
        end_sec: Number(chunkEnd.toFixed(3)),
        word_count: chunkWeight,
        editorial_cues: chunkCues,
        visual_job: visualJob,
        suggested_shot_job: shotJobFromVisualJob(visualJob),
      });
      elapsed += chunkDuration;
      chunkStart = Number(unit.start_sec) + elapsed;
      chunkText = "";
      chunkWeight = 0;
    };
    for (let index = 0; index < sentenceParts.length; index += 1) {
      const sentence = sentenceParts[index];
      const weight = partWeights[index];
      const candidateWeight = chunkWeight + weight;
      const candidateDuration = duration * (candidateWeight / totalWeight);
      if (chunkText && candidateDuration > maxHoldSec) flushChunk();
      chunkText = `${chunkText} ${sentence}`.trim();
      chunkWeight += weight;
    }
    flushChunk();
  }
  const sceneStart = Number(scene.start_sec ?? 0);
  let cursor = sceneStart;
  const sequential = bounded.map((unit) => {
    const start = Math.max(cursor, Number(unit.start_sec));
    const end = Math.max(start + 0.25, Number(unit.end_sec));
    cursor = end;
    return {
      ...unit,
      start_sec: Number(start.toFixed(3)),
      end_sec: Number(end.toFixed(3)),
    };
  });
  return sequential.map((unit, index, rows) => ({
    ...unit,
    visual_job: visualJobFromCues(unit.editorial_cues, unit.text, index, rows.length, unit.start_sec),
    suggested_shot_job: shotJobFromVisualJob(visualJobFromCues(unit.editorial_cues, unit.text, index, rows.length, unit.start_sec)),
    beat_focus: beatFocusLabel(index, rows.length, unit.start_sec),
    location_timeline_label: scene.location ? `${formatTimestamp(unit.start_sec)} ${scene.location}` : null,
  }));
}

function formatTimestamp(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function sceneTextFromAnchors(scriptText, scene, searchFrom = 0) {
  const startAnchor = String(scene.script_excerpt_start ?? "").trim();
  const endAnchor = String(scene.script_excerpt_end ?? "").trim();
  if (!scriptText || !startAnchor || !endAnchor) return "";
  let start = scriptText.indexOf(startAnchor, Math.max(0, searchFrom));
  if (start < 0) start = scriptText.indexOf(startAnchor);
  if (start < 0) return "";
  const end = scriptText.indexOf(endAnchor, start);
  if (end < 0) return "";
  return scriptText.slice(start, end + endAnchor.length).trim();
}

function splitSceneText(sceneText, count) {
  const sentences = splitSentences(sceneText);
  if (!sentences.length) return Array.from({ length: count }, () => "");
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * sentences.length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * sentences.length / count));
    return sentences.slice(start, end).join(" ");
  });
}

function compactBeatAction(text, fallback) {
  const cleaned = String(text || fallback || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 360 ? `${cleaned.slice(0, 357).trim()}...` : cleaned;
}

function suggestedShotJobForBeat({ text = "", index = 0, count = 1, startSec = 0 }) {
  const source = String(text ?? "").toLowerCase();
  if (/\b(?:system|quest|mission|status|rank|level|panel|screen|metric|counter|timer|score|notification|dashboard|interface|ui|ledger|audit|gauge)\b/.test(source)) return "ui_reveal";
  if (/\b(?:phone|text|message|receipt|invoice|contract|document|paper|card|ring|box|flowers|mug|cup|bottle|key|badge|wallet|bank|wire|ledger|camera)\b/.test(source)) return "object_insert";
  if (/\b(?:punch|kick|strike|shove|grab|slam|run|walk|rush|chase|fall|collapse|throw|pull|push|cut|blood|fight|attack|impact|dodge|enter|leave|arrive|step)\b/.test(source)) return "physical_action";
  if (/\b(?:said|asked|told|called|laughed|smiled|watched|looked|turned|faced|hand|voice)\b/.test(source)) return "interaction";
  if (/\b(?:crowd|audience|viewers|room|hall|stage|street|lobby|office|dorm|apartment|kitchen|elevator|court|boardroom|campus|arena|floor)\b/.test(source)) return index === 0 || Number(startSec) < hookDurationSec ? "environment_establishing" : "emotional_reaction";
  if (/\b(?:failed|failure|complete|result|consequence|after|proof|revealed|exposed|changed|lost|won)\b/.test(source)) return "consequence";
  const cycle = ["emotional_reaction", "interaction", "object_insert", "ui_reveal", "consequence", "transition"];
  if (count <= 1) return "environment_establishing";
  return cycle[index % cycle.length];
}

function normalizedTokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/_ref\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function refIdForSubject(subject, kind = "ref") {
  const base = String(subject ?? kind)
    .toLowerCase()
    .replace(/\b(?:the|a|an|his|her|their|my|our)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${base || kind}_ref`;
}

function normalizedName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseName(value) {
  return String(value ?? "")
    .replace(/_ref$/i, "")
    .replace(/^(?:char|character|protagonist|mc|host)_/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function hasFirstPersonNarration(text) {
  return /\b(?:i|me|my|mine|myself)\b/i.test(String(text ?? ""));
}

function firstPersonProtagonistName(scene) {
  const requirements = Array.isArray(scene?.ref_requirements) ? scene.ref_requirements : [];
  const characterRequirements = requirements.filter((requirement) => String(requirement?.kind ?? "").toLowerCase() === "character");
  const protagonistRequirement = characterRequirements.find((requirement) => (
    /\b(?:protagonist|main character|main lead|mc|host|narrator|viewpoint character|pov character)\b/i.test([
      requirement?.subject,
      requirement?.character,
      requirement?.role,
      requirement?.ref_id,
      requirement?.reason,
      requirement?.description,
    ].filter(Boolean).join(" "))
  ));
  const label = protagonistRequirement?.subject
    ?? protagonistRequirement?.character
    ?? protagonistRequirement?.name
    ?? protagonistRequirement?.ref_id;
  if (label) return titleCaseName(label);
  const scenePrimary = String(scene?.primary_subject ?? "").trim();
  if (scenePrimary && !/\b(?:antagonist|enemy|villain|culprit|target|rival|manager|captain|doctor|clerk|assessor)\b/i.test(scenePrimary)) {
    return scenePrimary;
  }
  return null;
}

function uniqueNames(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const name = String(value ?? "").trim();
    const key = normalizedName(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function namesInText(names, text) {
  const source = normalizedName(text);
  const sourceTokens = new Set(source.split(" ").filter(Boolean));
  return [...new Set((names ?? [])
    .map((name) => String(name ?? "").trim())
    .filter(Boolean)
    .filter((name) => {
      const normalized = normalizedName(name);
      const first = normalized.split(" ")[0];
      const nameTokens = normalizedTokens(name);
      const overlap = nameTokens.filter((token) => sourceTokens.has(token)).length;
      const requiredOverlap = nameTokens.length >= 3 ? 2 : 1;
      return normalized && (
        source.includes(normalized)
        || (first && first.length > 2 && source.split(" ").includes(first))
        || (nameTokens.length > 0 && overlap >= requiredOverlap)
      );
    }))];
}

function localVisibleCharacters(scene, beatText) {
  const visibleSubjects = Array.isArray(scene.visible_subjects) ? scene.visible_subjects : [];
  const stateNames = (Array.isArray(scene.character_states) ? scene.character_states : []).map((state) => state?.character).filter(Boolean);
  const candidates = [...new Set([...visibleSubjects, ...stateNames].map((name) => String(name ?? "").trim()).filter(Boolean))];
  const mentioned = namesInText(candidates, beatText);
  const firstPersonProtagonist = hasFirstPersonNarration(beatText) ? firstPersonProtagonistName(scene) : null;
  if (mentioned.length) return uniqueNames([firstPersonProtagonist, ...mentioned].filter(Boolean));
  const lower = String(beatText ?? "").toLowerCase();
  if (firstPersonProtagonist) return [firstPersonProtagonist];
  if (/\b(?:he|him|his)\b/.test(lower) && scene.primary_subject) return [scene.primary_subject];
  return scene.primary_subject ? [scene.primary_subject] : [];
}

function localMentionedOnlyCharacters(scene, beatText, visibleCharacters) {
  const visible = new Set((visibleCharacters ?? []).map(normalizedName));
  const candidates = [
    ...(Array.isArray(scene.visible_subjects) ? scene.visible_subjects : []),
    ...(Array.isArray(scene.character_states) ? scene.character_states : []).map((state) => state?.character),
  ].map((name) => String(name ?? "").trim()).filter(Boolean);
  return namesInText(candidates, beatText).filter((name) => !visible.has(normalizedName(name)));
}

function localProps(scene, beatText) {
  const props = Array.isArray(scene.props) ? scene.props : [];
  const source = normalizedName(beatText);
  const sourceTokens = new Set(source.split(" ").filter(Boolean));
  const matched = props.filter((prop) => {
    const tokens = normalizedTokens(prop);
    const overlap = tokens.filter((token) => sourceTokens.has(token)).length;
    return tokens.length > 0 && overlap >= Math.min(2, tokens.length);
  });
  return [...new Set(matched)];
}

function localUiElements(scene, beatText) {
  const source = String(beatText ?? "");
  const sceneUi = Array.isArray(scene.ui_text_on_screen) ? scene.ui_text_on_screen : [];
  const hasUiCue = /\b(?:system|quest|status|rank|level|panel|screen|notification|dashboard|ledger|audit|timer|score|counter|message|chat|viewer|viewers)\b/i.test(source);
  if (!hasUiCue) return [];
  return sceneUi.length ? sceneUi.slice(0, 4) : ["system/status UI motif"];
}

function generationModeForBeatRef({ kind, beat, subject, visibleCharacters }) {
  const start = Number(beat.start_sec ?? 0);
  const source = String(beat.visual_beat_script_excerpt ?? beat.visual_beat_action ?? "").toLowerCase();
  const hookOrRamp = start < retentionRampSec;
  if (kind === "character") {
    if ((visibleCharacters ?? []).length && (hookOrRamp || normalizedName(subject) === normalizedName(beat.primary_subject))) return "standalone_ref";
    if (/\b(?:grab|shove|push|pull|strike|fight|restrain|carry|rescue|touch|hold|attack)\b/.test(source)) return "standalone_ref";
    return "derive_from_best_cut";
  }
  if (kind === "location") {
    if (hookOrRamp) return "standalone_ref";
    if (beat.visual_job === "location_transition" || beat.suggested_shot_job === "environment_establishing") return "derive_from_first_clean_wide_cut";
    return "derive_from_best_cut";
  }
  if (kind === "ui") {
    return hookOrRamp || /\b(?:system|quest|status|rank|level)\b/.test(source) ? "standalone_ref" : "derive_from_best_cut";
  }
  if (kind === "prop") {
    if (hookOrRamp && /\b(?:evidence|recorder|badge|contract|receipt|ring|key|weapon|phone)\b/.test(source)) return "standalone_ref";
    return "derive_from_best_cut";
  }
  return "no_ref_needed";
}

function anchorPolicyForMode(mode) {
  if (mode === "derive_from_first_clean_cut") return "first_clean_visible_cut";
  if (mode === "derive_from_first_clean_wide_cut") return "first_clean_wide_cut";
  if (mode === "derive_from_best_cut") return "best_clean_visible_cut";
  return "none";
}

function beatRefNeed({ refId, kind, subject, mode, reason, beat }) {
  return {
    ref_id: refId,
    kind,
    subject,
    generation_mode: mode,
    advisory: true,
    locked_reference_target: false,
    suggested_required_before_imagegen: mode === "standalone_ref" || mode === "manual_review",
    anchor_cut_policy: anchorPolicyForMode(mode),
    required_before_imagegen: false,
    source: "visual_beat_ref_strategy",
    scene_id: beat.parent_scene_id ?? beat.scene_id,
    visual_beat_id: beat.visual_beat_id,
    image_id_hint: beat.image_id_hint ?? null,
    reason,
  };
}

function semanticRequirementForSubject(requirements, subject) {
  const subjectTokens = normalizedTokens(subject);
  if (!subjectTokens.length) return null;
  let best = null;
  for (const requirement of (Array.isArray(requirements) ? requirements : [])) {
    const requirementTokens = normalizedTokens(`${requirement?.ref_id ?? ""} ${requirement?.subject ?? ""} ${requirement?.description ?? ""} ${requirement?.reason ?? ""}`);
    if (!requirementTokens.length) continue;
    const overlap = subjectTokens.filter((token) => requirementTokens.includes(token)).length;
    const firstMatches = subjectTokens[0] && requirementTokens.includes(subjectTokens[0]) ? 1 : 0;
    const score = overlap + firstMatches;
    if (score > (best?.score ?? 0)) best = { score, requirement };
  }
  return best?.score > 0 ? best.requirement : null;
}

function localBeatReferenceNeeds(scene, beat, {
  visibleCharacters = [],
  mentionedOnlyCharacters = [],
  props = [],
  uiElements = [],
} = {}) {
  const needs = [];
  const sceneId = beat.parent_scene_id ?? beat.scene_id;
  const semanticRequirements = Array.isArray(scene.ref_requirements) ? scene.ref_requirements : [];
  const semanticByKind = new Map();
  for (const requirement of semanticRequirements) {
    const kind = String(requirement?.kind ?? "").toLowerCase();
    if (!semanticByKind.has(kind)) semanticByKind.set(kind, []);
    semanticByKind.get(kind).push(requirement);
  }

  for (const character of visibleCharacters) {
    const requirement = semanticRequirementForSubject(semanticByKind.get("character") ?? [], character);
    const mode = generationModeForBeatRef({ kind: "character", beat, subject: character, visibleCharacters });
    needs.push(beatRefNeed({
      refId: requirement?.ref_id ?? refIdForSubject(character, "character"),
      kind: "character",
      subject: character,
      mode,
      reason: requirement?.reason ?? "Visible local beat character; visual prompts need identity/wardrobe continuity if recurring or high-risk.",
      beat,
    }));
  }

  for (const character of mentionedOnlyCharacters) {
    const requirement = semanticRequirementForSubject(semanticByKind.get("character") ?? [], character);
    needs.push(beatRefNeed({
      refId: requirement?.ref_id ?? refIdForSubject(character, "character"),
      kind: "character",
      subject: character,
      mode: "no_ref_needed",
      reason: requirement?.reason ?? "Character is mentioned in the local beat excerpt but not physically visible.",
      beat,
    }));
  }

  const locationRequirements = (semanticByKind.get("location") ?? []).filter((requirement) => (
    !Array.isArray(requirement.scene_ids)
    || !requirement.scene_ids.length
    || requirement.scene_ids.includes(sceneId)
  ));
  const locationSubject = beat.location ?? scene.location ?? null;
  if (locationSubject) {
    const requirement = locationRequirements[0] ?? null;
    const mode = generationModeForBeatRef({ kind: "location", beat, subject: locationSubject, visibleCharacters });
    needs.push(beatRefNeed({
      refId: requirement?.ref_id ?? refIdForSubject(locationSubject, "location"),
      kind: "location",
      subject: locationSubject,
      mode,
      reason: requirement?.reason ?? "Local beat has a physical environment that should guide prompt/ref planning.",
      beat,
    }));
  }

  for (const prop of props.slice(0, 6)) {
    const requirement = semanticRequirementForSubject(semanticByKind.get("prop") ?? [], prop);
    const mode = generationModeForBeatRef({ kind: "prop", beat, subject: prop, visibleCharacters });
    needs.push(beatRefNeed({
      refId: requirement?.ref_id ?? refIdForSubject(prop, "prop"),
      kind: "prop",
      subject: prop,
      mode,
      reason: requirement?.reason ?? "Local beat prop/object may need continuity if it recurs or carries story evidence.",
      beat,
    }));
  }

  for (const ui of uiElements.slice(0, 4)) {
    const requirement = semanticRequirementForSubject(semanticByKind.get("ui") ?? [], ui);
    const mode = generationModeForBeatRef({ kind: "ui", beat, subject: ui, visibleCharacters });
    needs.push(beatRefNeed({
      refId: requirement?.ref_id ?? refIdForSubject(ui, "ui"),
      kind: "ui",
      subject: ui,
      mode,
      reason: requirement?.reason ?? "Local beat includes UI/system/chat/status imagery.",
      beat,
    }));
  }

  const seen = new Set();
  return needs.filter((need) => {
    const key = `${need.kind}|${need.ref_id}|${need.generation_mode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function localBeatLocation(scene, beatText) {
  const locationRequirements = (Array.isArray(scene.ref_requirements) ? scene.ref_requirements : [])
    .filter((requirement) => String(requirement?.kind ?? "").toLowerCase() === "location");
  if (!locationRequirements.length) return scene.location ?? null;
  const excerptTokens = new Set(normalizedTokens(beatText));
  let best = null;
  for (const requirement of locationRequirements) {
    const fallbackLabel = String(requirement.subject ?? requirement.location ?? scene.location ?? requirement.reason ?? "").trim();
    const label = fallbackLabel || humanizeReferenceId(requirement.ref_id);
    const tokens = normalizedTokens(`${requirement.ref_id ?? ""} ${requirement.subject ?? ""} ${requirement.reason ?? ""}`);
    const score = tokens.filter((token) => excerptTokens.has(token)).length;
    if (score > (best?.score ?? 0)) best = { score, label };
  }
  if (best?.score > 0) return best.label;
  return scene.location ?? null;
}

function humanizeReferenceId(refId) {
  return String(refId ?? "")
    .replace(/_ref$/i, "")
    .replace(/^(?:loc|char|prop|ui|style|effect|action)_/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitScene(scene, scriptText, wordTiming, searchFrom = 0) {
  const duration = Math.max(1, Number(scene.duration_sec ?? 0));
  const sceneText = sceneTextFromAnchors(scriptText, scene, searchFrom);
  const wordRows = sceneWords(wordTiming, scene);
  const timedUnits = timedTextUnits(sceneText, scene, wordRows)
    .map((unit) => ({
      ...unit,
      editorial_cues: editorialCueForText(unit.text, scene),
    }));
  const editorialUnits = mergeEditorialUnits(timedUnits, scene);
  const beats = [];
  for (let index = 0; index < editorialUnits.length; index += 1) {
    const unit = editorialUnits[index];
    const beatStart = Number(unit.start_sec);
    const beatEnd = Number(unit.end_sec);
    const focus = unit.beat_focus ?? beatFocusLabel(index, editorialUnits.length, beatStart);
    const beatText = unit.text ?? "";
    const location = localBeatLocation(scene, beatText);
    const rawVisualJob = unit.visual_job ?? visualJobFromCues(unit.editorial_cues ?? [], beatText, index, editorialUnits.length, beatStart);
    const visualJob = retentionVariedVisualJob(rawVisualJob, { location, previousBeats: beats, beatText, startSec: beatStart });
    const suggestedShotJob = shotJobFromVisualJob(visualJob) ?? unit.suggested_shot_job ?? suggestedShotJobForBeat({ text: beatText, index, count: editorialUnits.length, startSec: beatStart });
    const baseBeat = {
      ...scene,
      location,
      parent_scene_id: scene.scene_id,
      scene_id: scene.scene_id,
      visual_beat_id: `${scene.scene_id}_beat_${String(index + 1).padStart(2, "0")}`,
      start_sec: Number(beatStart.toFixed(3)),
      visual_job: visualJob,
      suggested_shot_job: suggestedShotJob,
      visual_beat_script_excerpt: beatText,
      visual_beat_action: compactBeatAction(beatText, focus),
    };
    const visibleCharacters = localVisibleCharacters(scene, beatText);
    const mentionedOnlyCharacters = localMentionedOnlyCharacters(scene, beatText, visibleCharacters);
    const props = localProps(scene, beatText);
    const uiElements = localUiElements(scene, beatText);
    const refNeeds = localBeatReferenceNeeds(scene, baseBeat, {
      visibleCharacters,
      mentionedOnlyCharacters,
      props,
      uiElements,
    });
    beats.push({
      ...scene,
      location,
      local_location: location,
      visible_characters: visibleCharacters,
      mentioned_only_characters: mentionedOnlyCharacters,
      local_props: props,
      local_ui_elements: uiElements,
      ref_needs: refNeeds,
      beat_ref_requirements: refNeeds,
      visual_beat_contract_version: VISUAL_BEAT_CONTRACT_VERSION,
      visual_beat_id: baseBeat.visual_beat_id,
      parent_scene_id: scene.scene_id,
      scene_id: scene.scene_id,
      beat_index: index + 1,
      beat_count: editorialUnits.length,
      start_sec: Number(beatStart.toFixed(3)),
      end_sec: Number(beatEnd.toFixed(3)),
      duration_sec: Number(Math.max(1, beatEnd - beatStart).toFixed(3)),
      visual_beat_focus: focus,
      visual_beat_script_excerpt: beatText,
      visual_beat_action: compactBeatAction(beatText, focus),
      editorial_cues: unit.editorial_cues ?? [],
      visual_job: visualJob,
      suggested_shot_job: suggestedShotJob,
      location_timeline_label: unit.location_timeline_label ?? null,
      visual_novelty_directive: `${unit.visual_job ?? suggestedShotJob}: make this cut's visible focus distinct from the previous beat while staying inside the current beat excerpt.`,
      hook_visual: beatStart < hookDurationSec,
      retention_ramp_visual: beatStart >= hookDurationSec && beatStart < retentionRampSec,
      hook_visual_intent: beatStart < hookDurationSec
        ? "fast opening retention cut: new information, new composition, and transition-ready motion"
        : null,
      retention_ramp_intent: beatStart >= hookDurationSec && beatStart < retentionRampSec
        ? "first-three-minutes retention cut: keep visual novelty and story momentum without hook-level chaos"
        : null,
      image_id_hint: `${episode}-cut-${String(beats.length + 1).padStart(3, "0")}`,
    });
  }
  return { beats, sceneText };
}

function assertBeatExcerptQuality(beats) {
  if (allowEmptyBeatExcerpts) return;
  const failures = [];
  for (const beat of beats) {
    const excerpt = String(beat.visual_beat_script_excerpt ?? "").trim();
    if (!excerpt) failures.push(`${beat.visual_beat_id} has empty visual_beat_script_excerpt`);
  }
  if (failures.length) {
    throw new Error(`Visual beat excerpt quality gate failed:\n${failures.slice(0, 40).join("\n")}`);
  }
}

function normalizeGlobalBeatTimeline(beats) {
  let cursor = 0;
  return beats.map((beat) => {
    const start = Math.max(cursor, Number(beat.start_sec ?? cursor));
    const rawEnd = Number(beat.end_sec ?? (start + Number(beat.duration_sec ?? 1)));
    const end = Math.max(start + 0.25, rawEnd);
    cursor = end;
    return {
      ...beat,
      start_sec: Number(start.toFixed(3)),
      end_sec: Number(end.toFixed(3)),
      duration_sec: Number(Math.max(0.25, end - start).toFixed(3)),
    };
  });
}

export function closeVisualBeatTimelineForTests(beats, timelineEndSec = null) {
  const ordered = [...(beats ?? [])].sort((left, right) => Number(left.start_sec ?? 0) - Number(right.start_sec ?? 0));
  return ordered.map((beat, index) => {
    const start = Number(beat.start_sec ?? 0);
    const nextStart = Number(ordered[index + 1]?.start_sec);
    if (Number.isFinite(nextStart) && nextStart <= start) {
      throw new Error(`Visual beat timeline has non-increasing starts at ${beat.visual_beat_id ?? beat.image_id_hint ?? index}.`);
    }
    const requestedEnd = Number.isFinite(nextStart)
      ? nextStart
      : Number.isFinite(Number(timelineEndSec))
        ? Number(timelineEndSec)
        : Number(beat.end_sec ?? (start + Number(beat.duration_sec ?? 0.25)));
    const end = Number.isFinite(nextStart) ? nextStart : Math.max(start + 0.25, requestedEnd);
    return { ...beat, end_sec: Number(end.toFixed(3)), duration_sec: Number((end - start).toFixed(3)) };
  });
}

function assertRetentionBeatDensity(beats) {
  if (allowUnderTargetRetentionBeats) return;
  const ordered = [...beats].sort((a, b) => Number(a.start_sec ?? 0) - Number(b.start_sec ?? 0));
  const totalEnd = ordered.reduce((max, beat) => Math.max(max, Number(beat.end_sec ?? (Number(beat.start_sec ?? 0) + Number(beat.duration_sec ?? 0))) || 0), 0);
  const hookCoveredSec = Math.max(0, Math.min(totalEnd, hookDurationSec));
  const rampCoveredSec = Math.max(0, Math.min(totalEnd, retentionRampSec) - hookDurationSec);
  const hookBeats = ordered.filter((beat) => Number(beat.start_sec ?? 0) < hookDurationSec).length;
  const rampBeats = ordered.filter((beat) => {
    const start = Number(beat.start_sec ?? 0);
    return start >= hookDurationSec && start < retentionRampSec;
  }).length;
  const requiredHookBeats = hookCoveredSec > 0 ? Math.max(1, Math.ceil(hookCoveredSec / Math.max(1, hookMaxBeatSec))) : 0;
  const requiredRampBeats = rampCoveredSec > 0 ? Math.max(1, Math.ceil(rampCoveredSec / Math.max(1, rampMaxBeatSec))) : 0;
  const failures = [];
  if (hookBeats < requiredHookBeats) {
    failures.push(`hook beat density ${hookBeats}<${requiredHookBeats} for ${Number(hookCoveredSec).toFixed(1)}s covered at max ${hookMaxBeatSec}s`);
  }
  if (rampBeats < requiredRampBeats) {
    failures.push(`retention ramp beat density ${rampBeats}<${requiredRampBeats} for ${Number(rampCoveredSec).toFixed(1)}s covered at max ${rampMaxBeatSec}s`);
  }
  if (failures.length) {
    throw new Error(`Visual beat density gate failed:\n${failures.join("\n")}`);
  }
}

function normalizeComparable(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstName(value) {
  return String(value ?? "").trim().split(/\s+/)[0] ?? "";
}

function mentionedKnownCharacters(beat) {
  const excerpt = String(beat.visual_beat_script_excerpt ?? "");
  const visibleSubjects = Array.isArray(beat.visible_characters) && beat.visible_characters.length
    ? beat.visible_characters
    : Array.isArray(beat.visible_subjects) ? beat.visible_subjects : [];
  const characterStates = Array.isArray(beat.character_states) ? beat.character_states : [];
  const knownNames = [
    beat.primary_subject,
    ...visibleSubjects,
    ...characterStates.map((state) => state?.character),
  ]
    .map((name) => String(name ?? "").trim())
    .filter((name) => name && /^[A-Z][\p{L}\p{N}'’-]+/u.test(name));
  const uniqueNames = [...new Set(knownNames)];
  return uniqueNames.filter((name) => {
    const escapedFull = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const first = firstName(name);
    const escapedFirst = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escapedFull}\\b`, "u").test(excerpt)
      || (first.length > 2 && new RegExp(`\\b${escapedFirst}\\b`, "u").test(excerpt));
  });
}

function namedCharacterCoverageFindings(beats) {
  const findings = [];
  for (const beat of beats) {
    const visibleSubjects = (Array.isArray(beat.visible_characters) && beat.visible_characters.length
      ? beat.visible_characters
      : Array.isArray(beat.visible_subjects) ? beat.visible_subjects : [])
      .map(normalizeComparable)
      .filter(Boolean);
    const mentioned = mentionedKnownCharacters(beat);
    for (const name of mentioned) {
      const normalizedName = normalizeComparable(name);
      const normalizedFirst = normalizeComparable(firstName(name));
      const covered = visibleSubjects.some((subject) => (
        subject === normalizedName
        || subject.includes(normalizedName)
        || (normalizedFirst && subject.split(/\s+/).includes(normalizedFirst))
      ));
      if (!covered) {
        findings.push({
          code: "named_character_not_visible_subject",
          severity: "warning",
          scene_id: beat.parent_scene_id ?? beat.scene_id,
          visual_beat_id: beat.visual_beat_id,
          character: name,
          message: `Beat excerpt mentions ${name}, but the beat visible_subjects do not include that character. Carry this as local edit direction; prompt authoring must let the local excerpt win over stale parent-scene subjects.`,
        });
      }
    }
  }
  return findings;
}

function locationMentionPhrases(text) {
  const source = String(text ?? "");
  const phrases = [];
  const venueNouns = "Hall|Room|Stage|Lobby|Campus|Arena|Court|Boardroom|Office|Dorm|Apartment|Kitchen|Elevator|Tower|District|Station|Gym|Street|Floor|Hallway|Corridor|Courtyard|Temple|Palace|Library|Classroom|Studio|Theater|Restaurant|Cafe|Hospital|Bank|Store|Market|Platform|Roof|Basement|Warehouse|Server";
  const properVenuePattern = new RegExp(`\\b([A-Z][\\p{L}\\p{N}'’-]*(?:\\s+[A-Z][\\p{L}\\p{N}'’-]*){0,3}\\s+(?:${venueNouns}))\\b`, "gu");
  for (const match of source.matchAll(properVenuePattern)) phrases.push(match[1]);
  const stop = "(?!(?:a|an|and|as|at|box|for|frame|from|gifts|his|her|in|inside|into|my|next|of|on|open|our|report|same|the|their|to|whole|with|your)\\b)";
  const commonVenuePattern = new RegExp(`\\b(?:the\\s+)?((?:${stop}[a-z][\\p{L}\\p{N}'’-]*\\s+){1,3}(?:${venueNouns.toLowerCase().replaceAll("|", "|")}))\\b`, "giu");
  for (const match of source.matchAll(commonVenuePattern)) phrases.push(match[1]);
  const genericMovementPattern = /\b(?:entered|arrived at|walked into|stepped into|crossed into|moved into|went into|inside|through|toward)\s+(?:the\s+)?(hall|room|stage|lobby|campus|arena|court|boardroom|office|dorm|apartment|kitchen|elevator|tower|district|station|gym|street|floor|hallway|corridor|courtyard|temple|palace|library|classroom|studio|theater|restaurant|cafe|hospital|bank|store|market|platform|roof|basement|warehouse|server)\b/giu;
  for (const match of source.matchAll(genericMovementPattern)) phrases.push(match[1]);
  return [...new Set(phrases.map((phrase) => phrase.trim()).filter(Boolean))];
}

function locationMentionCoverageFindings(beats) {
  const findings = [];
  for (const beat of beats) {
    const beatLocation = beat.local_location ?? beat.location ?? beat.location_timeline_label ?? "";
    const location = normalizeComparable(beatLocation);
    if (!location) continue;
    for (const phrase of locationMentionPhrases(beat.visual_beat_script_excerpt)) {
      const normalizedPhrase = normalizeComparable(phrase);
      const tokens = normalizedPhrase.split(/\s+/).filter((token) => token.length > 2);
      const matchingTokens = tokens.filter((token) => location.split(/\s+/).includes(token));
      const covered = normalizedPhrase && (
        location.includes(normalizedPhrase)
        || normalizedPhrase.includes(location)
        || (tokens.length > 0 && matchingTokens.length >= Math.min(2, tokens.length))
      );
      if (!covered) {
        findings.push({
          code: "location_mention_not_in_beat_location",
          severity: "warning",
          scene_id: beat.parent_scene_id ?? beat.scene_id,
          visual_beat_id: beat.visual_beat_id,
          mentioned_location: phrase,
          beat_location: beatLocation || null,
          message: `Beat excerpt names ${phrase}, but the beat location is ${beatLocation || "(missing)"}.`,
        });
      }
    }
  }
  return findings;
}

function repeatedBeatJobFindings(beats, {
  maxConsecutiveSameLocationJob = 3,
  retentionEndSec = retentionRampSec,
} = {}) {
  const ordered = [...beats].sort((a, b) => Number(a.start_sec ?? 0) - Number(b.start_sec ?? 0));
  const findings = [];
  let current = null;
  for (const beat of ordered) {
    const start = Number(beat.start_sec ?? 0);
    if (start >= retentionEndSec) {
      if (current && current.count > maxConsecutiveSameLocationJob) findings.push(current);
      current = null;
      continue;
    }
    const location = normalizeComparable(beat.local_location ?? beat.location ?? "none") || "none";
    const job = String(beat.visual_job ?? "none");
    const key = `${location}|${job}`;
    if (!current || current.key !== key) {
      if (current && current.count > maxConsecutiveSameLocationJob) findings.push(current);
      current = {
        code: "repeated_location_visual_job_run",
        severity: "warning",
        key,
        location: beat.local_location ?? beat.location ?? null,
        visual_job: job,
        start_sec: beat.start_sec,
        end_sec: beat.end_sec,
        count: 1,
        first_visual_beat_id: beat.visual_beat_id,
        last_visual_beat_id: beat.visual_beat_id,
        message: "",
      };
    } else {
      current.count += 1;
      current.end_sec = beat.end_sec;
      current.last_visual_beat_id = beat.visual_beat_id;
    }
  }
  if (current && current.count > maxConsecutiveSameLocationJob) findings.push(current);
  return findings.map((finding) => ({
    ...finding,
    message: `Repeated ${finding.visual_job} beats in ${finding.location ?? "unknown location"} for ${finding.count} consecutive cuts.`,
  }));
}

function longSameLocationBeatFindings(beats, {
  maxSameLocationSpanSec = 150,
  retentionStartSec = retentionRampSec,
} = {}) {
  const ordered = [...beats].sort((a, b) => Number(a.start_sec ?? 0) - Number(b.start_sec ?? 0));
  const findings = [];
  let current = null;
  for (const beat of ordered) {
    const location = normalizeComparable(beat.local_location ?? beat.location ?? "none") || "none";
    if (!current || current.location_key !== location) {
      if (current) findings.push(current);
      current = {
        code: "long_same_location_beat_span",
        severity: "warning",
        location_key: location,
        location: beat.local_location ?? beat.location ?? null,
        start_sec: Number(beat.start_sec ?? 0),
        end_sec: Number(beat.end_sec ?? beat.start_sec ?? 0),
        count: 1,
        first_visual_beat_id: beat.visual_beat_id,
        last_visual_beat_id: beat.visual_beat_id,
      };
    } else {
      current.end_sec = Number(beat.end_sec ?? current.end_sec);
      current.count += 1;
      current.last_visual_beat_id = beat.visual_beat_id;
    }
  }
  if (current) findings.push(current);
  return findings
    .filter((span) => {
      if (span.location_key === "none") return false;
      const measuredStart = Math.max(span.start_sec, retentionStartSec);
      return span.end_sec > measuredStart && span.end_sec - measuredStart > maxSameLocationSpanSec && span.count >= 8;
    })
    .map((span) => ({
      ...span,
      measured_after_retention_start_sec: Number((span.end_sec - Math.max(span.start_sec, retentionStartSec)).toFixed(3)),
      message: `Beat plan holds ${span.location ?? "one location"} for ${span.count} cuts and ${Number(span.end_sec - Math.max(span.start_sec, retentionStartSec)).toFixed(1)}s after the retention runway.`,
    }));
}

function visualBeatQualityFindings(beats) {
  return [
    ...namedCharacterCoverageFindings(beats),
    ...locationMentionCoverageFindings(beats),
    ...repeatedBeatJobFindings(beats),
    ...longSameLocationBeatFindings(beats),
  ];
}

function assertVisualBeatQualityFindings(findings) {
  if (!blockVisualBeatQualityFindings) return;
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  if (blockers.length) {
    throw new Error(`Visual beat quality gate failed:\n${blockers.slice(0, 40).map((finding) => (
      `${finding.code} ${finding.visual_beat_id ?? finding.first_visual_beat_id ?? finding.scene_id ?? ""}: ${finding.message}`
    )).join("\n")}`);
  }
}

function scopeBeatsByTime(beats) {
  const start = Number.isFinite(scopeStartSec) ? scopeStartSec : null;
  const end = Number.isFinite(scopeEndSecNumber) ? scopeEndSecNumber : null;
  if (start === null && end === null) return beats;
  return beats.filter((beat) => {
    const beatStart = Number(beat.start_sec ?? 0);
    const beatEnd = Number(beat.end_sec ?? (beatStart + Number(beat.duration_sec ?? 0)));
    if (start !== null && beatEnd <= start) return false;
    if (end !== null && beatStart >= end) return false;
    return true;
  }).map((beat) => ({
    ...beat,
    scope_window_sec: {
      start_sec: start,
      end_sec: end,
    },
  }));
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
  throw new Error("Editorial beat director did not return valid JSON.");
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, runWorker));
  return results;
}

function editorialAtomChunks(atoms, maxAtoms = 40) {
  const chunks = [];
  let current = [];
  for (const atom of atoms) {
    if (current.length >= maxAtoms && atom.transition_barrier_before) {
      chunks.push(current);
      current = [];
    }
    current.push(atom);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function callEditorialLlm(prompt, stageName) {
  if (isLocalLLMRoute(stageName)) {
    const response = await fetch(localLLMChatCompletionURL(stageName), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...localLLMAuthHeaders() },
      body: JSON.stringify({
        model: getLLMModel(stageName),
        messages: [
          { role: "system", content: "Return one valid JSON object only. You are an editorial beat director for timed manhwa recap narration." },
          { role: "user", content: prompt },
        ],
        temperature: Number(flags["llm-temperature"] ?? 0.25),
        max_tokens: Number(flags["editorial-chunk-max-tokens"] ?? 9000),
      }),
      signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_VISUAL_BEAT_LLM_TIMEOUT_MS ?? 1_200_000)),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Editorial beat local LLM HTTP ${response.status}: ${raw.slice(0, 800)}`);
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
    return { parsed: extractJson(content), provider: "local-qwen", model: getLLMModel(stageName), output_path: null };
  }
  const callDir = path.join(episodeDir, "_codex_calls", "visual-beat-director");
  await fs.mkdir(callDir, { recursive: true });
  const outputPath = path.join(callDir, `${stageName}-output.txt`);
  const metadata = await readCodexCallMetadata(outputPath);
  const cached = await fs.readFile(outputPath, "utf8").catch(() => null);
  if (cached && flags["reuse-codex-calls"] !== "false" && isCodexCacheCompatible(metadata, {
    model: flags.model ?? flags["llm-model"] ?? null,
    reasoningEffort: flags["reasoning-effort"] ?? null,
    promptHash: sha256(prompt),
  })) {
    return { parsed: extractJson(cached), provider: "codex", model: metadata.model, reasoning_effort: metadata.reasoning_effort, output_path: outputPath, reused: true };
  }
  const call = await runCodexCli({
    prompt,
    stageName,
    repoRoot,
    outputPath,
    model: flags.model ?? flags["llm-model"] ?? null,
    reasoningEffort: flags["reasoning-effort"] ?? null,
    timeoutMs: Number(process.env.ANIFACTORY_VISUAL_BEAT_LLM_TIMEOUT_MS ?? 1_200_000),
  });
  return { parsed: extractJson(call.content), provider: "codex", model: call.model, reasoning_effort: call.reasoning_effort, output_path: outputPath, reused: false };
}

async function directEditorialBeats(atoms, factLedger, timedScenes) {
  const chunks = editorialAtomChunks(atoms, Math.max(8, Number(flags["editorial-chunk-atoms"] ?? 40)));
  const concurrency = Math.max(1, Math.min(8, Number(flags.concurrency ?? flags["editorial-concurrency"] ?? 4)));
  const results = await runPool(chunks, concurrency, async (chunk, index) => {
    const basePrompt = buildEditorialDirectorPrompt(chunk, factLedger, timedScenes);
    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, Number(flags["editorial-attempts"] ?? 2)); attempt += 1) {
      const prompt = attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nCorrection pass: the prior grouping failed deterministic validation with: ${lastError?.message}. Return complete corrected JSON satisfying atom coverage, transition barriers, evidence, and timing rails.`;
      const call = await callEditorialLlm(prompt, `${episode}_editorial_beats_${String(index + 1).padStart(3, "0")}_attempt_${attempt}`);
      try {
        const normalized = normalizeEditorialGrouping(call.parsed, chunk, factLedger, episode);
        return { ...normalized, call, atom_count: chunk.length };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`Editorial beat chunk ${index + 1} failed.`);
  });
  return {
    beats: results.flatMap((result) => result.beats),
    planner: {
      provider: results[0]?.call?.provider ?? null,
      model: results[0]?.call?.model ?? null,
      reasoning_effort: results[0]?.call?.reasoning_effort ?? null,
      chunk_count: chunks.length,
      concurrency,
      reused_chunk_count: results.filter((result) => result.call.reused).length,
      output_paths: results.map((result) => result.call.output_path).filter(Boolean),
    },
  };
}

function enrichEditorialBeat(beat, timedScenes) {
  const scene = timedScenes.find((candidate) => candidate.scene_id === beat.parent_scene_id) ?? beat;
  const visibleCharacters = beat.visible_characters ?? [];
  const mentionedOnlyCharacters = beat.mentioned_only_characters ?? [];
  const props = beat.local_props ?? [];
  const uiElements = beat.local_ui_elements ?? [];
  const refNeeds = localBeatReferenceNeeds(scene, beat, {
    visibleCharacters,
    mentionedOnlyCharacters,
    props,
    uiElements,
  });
  return {
    ...beat,
    visual_beat_contract_version: EDITORIAL_VISUAL_BEAT_CONTRACT_VERSION,
    ref_needs: refNeeds,
    beat_ref_requirements: refNeeds,
    hook_visual_intent: beat.hook_visual ? "opening retention cut with one decisive visible story payload" : null,
    retention_ramp_intent: beat.retention_ramp_visual ? "retention cut with clear story movement and distinct visual job" : null,
  };
}

async function existingGroupingLock() {
  const approval = await readJson(visualBeatApprovalPath, null);
  const plan = await readJson(outputPath, null);
  if (!approval || !plan) return null;
  const planHash = await hashFile(outputPath);
  if (approval.status === "approved" && approval.visual_beat_plan_sha256 === planHash) return { approval, plan };
  return null;
}

async function editorialBeatPlan(timedPlan, scriptText, wordTiming, factLedger) {
  const locked = await existingGroupingLock();
  if (locked && flags["approve-regrouping"] !== "true") {
    console.error(`visual beats: grouping lock current; reusing ${outputPath}`);
    return { reused: true, report: locked.plan };
  }
  if (await readJson(visualBeatApprovalPath, null) && flags["approve-regrouping"] !== "true") {
    throw new Error("Visual beat grouping was previously locked. Pass --approve-regrouping true only with explicit operator approval.");
  }
  const boundedScope = Number.isFinite(scopeEndSecNumber);
  const scopedScript = boundedScope ? scriptPrefixForTimedWordsForTests(scriptText, wordTiming.words) : { script: scriptText, source_word_end_exclusive: null, matched_timing_tail_words: null, fallback: false };
  const atoms = buildTranscriptAtoms(scopedScript.script, wordTiming.words, timedPlan.scenes, factLedger);
  const directed = await directEditorialBeats(atoms, factLedger, timedPlan.scenes);
  const projectedBase = projectActiveStateConstraints(directed.beats, atoms, factLedger, timedPlan.scenes)
    .map((beat) => enrichEditorialBeat(beat, timedPlan.scenes));
  const projected = projectedBase.map((beat, index) => ({
    ...beat,
    beat_index: index + 1,
    beat_count: projectedBase.length,
    location_timeline_label: `${Math.floor(Number(beat.start_sec ?? 0) / 60)}:${String(Math.floor(Number(beat.start_sec ?? 0) % 60)).padStart(2, "0")} ${beat.local_location ?? beat.location ?? ""}`.trim(),
  }));
  const coverageFindings = editorialBeatCoverageFindings(projected, wordTiming.words.length);
  if (coverageFindings.some((finding) => finding.severity === "blocker")) {
    throw new Error(`Editorial beat Whisper coverage failed: ${coverageFindings.map((finding) => finding.code).join(", ")}`);
  }
  return { reused: false, atoms, beats: projected, planner: { ...directed.planner, bounded_script_scope: boundedScope ? scopedScript : null }, coverageFindings };
}

async function main() {
  const [timedPlan, scriptText, wordTiming, runIdentity, factLedger] = await Promise.all([
    readJson(timedPlanPath, null),
    fs.readFile(scriptPath, "utf8").catch(() => ""),
    readJson(wordTimingPath, null),
    readJson(runIdentityPath, {}),
    readJson(storyFactLedgerPath, null),
  ]);
  if (timedPlan?.status !== "passed" || !Array.isArray(timedPlan.scenes) || !timedPlan.scenes.length) throw new Error(`Missing passed timed scene plan: ${timedPlanPath}`);
  if (!scriptText.trim()) throw new Error(`Missing script: ${scriptPath}`);
  if (wordTiming?.status !== "passed" || !Array.isArray(wordTiming.words) || !wordTiming.words.length) throw new Error(`Missing passed local Whisper word timing: ${wordTimingPath}`);
  const scriptHash = sha256(scriptText);
  if (timedPlan.source_script_hash && timedPlan.source_script_hash !== scriptHash) throw new Error("timed_scene_plan.json is stale for current script_clean.md.");
  if (wordTiming.source_script_hash && wordTiming.source_script_hash !== scriptHash) throw new Error("narration_word_timing is stale for current script_clean.md.");
  const useEditorialDirector = runIdentity.schema === "goldflow_run_identity_v2" && flags["legacy-deterministic-beats"] !== "true";
  let numberedBeatsAll;
  let whisperAlignmentSummary;
  let editorialResult = null;
  if (useEditorialDirector) {
    if (!factLedgerMatchesScriptForTests(factLedger, scriptPath, scriptHash)) {
      throw new Error(`Editorial beat direction requires current passed story_fact_ledger.json: ${storyFactLedgerPath}`);
    }
    editorialResult = await editorialBeatPlan(timedPlan, scriptText, wordTiming, factLedger);
    if (editorialResult.reused) {
      console.log(JSON.stringify({ status: "passed", output_path: outputPath, reused_grouping_lock: true, visual_beat_count: editorialResult.report.visual_beat_count }, null, 2));
      return;
    }
    numberedBeatsAll = closeVisualBeatTimelineForTests(editorialResult.beats, Number.isFinite(scopeEndSecNumber) ? scopeEndSecNumber : wordTiming.audio_duration_sec);
    const appliedRailFindings = editorialRetentionRailFindings(numberedBeatsAll);
    if (appliedRailFindings.length) {
      throw new Error(`Editorial applied hold rails failed: ${appliedRailFindings.slice(0, 12).map((finding) => `${finding.visual_beat_id}:${finding.duration_sec}s`).join(", ")}`);
    }
    whisperAlignmentSummary = {
      mode: "exact_whisper_word_span_atoms",
      atom_count: editorialResult.atoms.length,
      covered_word_count: wordTiming.words.length,
      finding_count: editorialResult.coverageFindings.length,
    };
  } else {
    const beats = [];
    let scriptCursor = 0;
    for (const scene of timedPlan.scenes) {
      const result = splitScene(scene, scriptText, wordTiming, scriptCursor);
      for (const beat of result.beats) beats.push(beat);
      if (result.sceneText) {
        const start = scriptText.indexOf(result.sceneText, scriptCursor);
        if (start >= 0) scriptCursor = start + result.sceneText.length;
      }
    }
    const whisperAligned = alignExcerptRowsToWhisper(beats, wordTiming.words);
    numberedBeatsAll = normalizeGlobalBeatTimeline(whisperAligned.rows).map((beat, index) => ({
      ...beat,
      image_id_hint: `${episode}-cut-${String(index + 1).padStart(3, "0")}`,
    }));
    whisperAlignmentSummary = whisperAligned.summary;
  }
  const numberedBeats = scopeBeatsByTime(numberedBeatsAll);
  assertBeatExcerptQuality(numberedBeats);
  assertRetentionBeatDensity(numberedBeats);
  const qualityFindings = visualBeatQualityFindings(numberedBeats);
  assertVisualBeatQualityFindings(qualityFindings);
  const qualityFindingsByBeat = new Map();
  for (const finding of qualityFindings) {
    const beatId = finding.visual_beat_id ?? finding.first_visual_beat_id ?? null;
    if (!beatId) continue;
    const rows = qualityFindingsByBeat.get(beatId) ?? [];
    rows.push(finding);
    qualityFindingsByBeat.set(beatId, rows);
  }
  const beatsWithQuality = numberedBeats.map((beat) => ({
    ...beat,
    visual_beat_quality_findings: qualityFindingsByBeat.get(beat.visual_beat_id) ?? [],
  }));
  const cueCounts = {};
  for (const beat of beatsWithQuality) {
    for (const cue of beat.editorial_cues ?? []) cueCounts[cue] = (cueCounts[cue] ?? 0) + 1;
  }
  const locationTimeline = numberedBeats
    .filter((beat, index, rows) => beat.location && (index === 0 || beat.location !== rows[index - 1]?.location))
    .map((beat) => ({
      start_sec: beat.start_sec,
      timestamp: formatTimestamp(beat.start_sec),
      location: beat.location,
      scene_id: beat.parent_scene_id ?? beat.scene_id,
      visual_beat_id: beat.visual_beat_id,
      excerpt: beat.visual_beat_script_excerpt,
    }));
  const report = {
    schema: useEditorialDirector ? "goldflow_visual_beat_plan_v2" : "goldflow_visual_beat_plan_v1",
    planner_contract_version: useEditorialDirector ? EDITORIAL_VISUAL_BEAT_CONTRACT_VERSION : VISUAL_BEAT_CONTRACT_VERSION,
    visual_beat_contract_version: useEditorialDirector ? EDITORIAL_VISUAL_BEAT_CONTRACT_VERSION : VISUAL_BEAT_CONTRACT_VERSION,
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_artifact_paths: [timedPlanPath, scriptPath, wordTimingPath, ...(useEditorialDirector ? [storyFactLedgerPath] : [])],
    source_hashes: Object.fromEntries((await Promise.all([timedPlanPath, scriptPath, wordTimingPath, ...(useEditorialDirector ? [storyFactLedgerPath] : [])].map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash)),
    timing_source: timedPlan.timing_source,
    audio_duration_sec: timedPlan.audio_duration_sec,
    word_timing_path: wordTimingPath,
    word_timing_audio_hash: wordTiming.narration_audio_hash ?? null,
    scene_count: timedPlan.scenes.length,
    visual_beat_count: beatsWithQuality.length,
    visual_beat_scope: {
      mode: numberedBeats.length === numberedBeatsAll.length ? "full_episode" : "time_scoped",
      scope_start_sec: Number.isFinite(scopeStartSec) ? scopeStartSec : null,
      scope_end_sec: Number.isFinite(scopeEndSecNumber) ? scopeEndSecNumber : null,
      selected_visual_beat_count: numberedBeats.length,
      total_visual_beat_count: numberedBeatsAll.length,
      selected_scene_ids: [...new Set(numberedBeats.map((beat) => beat.parent_scene_id ?? beat.scene_id).filter(Boolean))],
    },
    hook_duration_sec: hookDurationSec,
    hook_visual_beat_count: beatsWithQuality.filter((beat) => Number(beat.start_sec) < hookDurationSec).length,
    retention_ramp_sec: retentionRampSec,
    retention_ramp_visual_beat_count: beatsWithQuality.filter((beat) => Number(beat.start_sec) >= hookDurationSec && Number(beat.start_sec) < retentionRampSec).length,
    editorial_cue_counts: cueCounts,
    visual_beat_quality_findings: qualityFindings,
    visual_beat_quality_summary: {
      finding_count: qualityFindings.length,
      warning_count: qualityFindings.filter((finding) => finding.severity === "warning").length,
      blocker_count: qualityFindings.filter((finding) => finding.severity === "blocker").length,
      codes: Object.fromEntries([...new Set(qualityFindings.map((finding) => finding.code))].map((code) => [
        code,
        qualityFindings.filter((finding) => finding.code === code).length,
      ])),
    },
    location_timeline: locationTimeline,
    policy: useEditorialDirector
      ? "LLM editorial direction over clause/sentence atoms bound to exact Whisper word spans. The LLM owns depiction and composition; deterministic validation owns coverage, order, transition barriers, IDs, state projection, and timing rails."
      : "Transcript-first editorial beat planning from final script text plus local Whisper word timing. Every beat must carry exact local narration excerpt, local location, visible characters, mentioned-only characters, props/UI, visual job, and beat-level advisory reference hints before reference or prompt authoring. Beat ref_needs are local evidence, not official locked reference targets.",
    whisper_excerpt_alignment: whisperAlignmentSummary,
    editorial_director: useEditorialDirector ? {
      ...editorialResult.planner,
      atom_count: editorialResult.atoms.length,
      grouping_lock_sha256: groupingLockHash(beatsWithQuality),
      active_state_projection: "binding_per_beat",
      retention_rails: {
        sec_0_30: [2.2, 4.5],
        sec_30_180: [3.2, 7],
        sec_180_1200: [5, 12],
        sec_1200_plus: [7, 15],
      },
    } : null,
    beat_settings: {
      target_beat_sec: targetBeatSec,
      max_beat_sec: maxBeatSec,
      min_beat_sec: minBeatSec,
      hook_duration_sec: hookDurationSec,
      hook_target_beat_sec: hookTargetBeatSec,
      hook_max_beat_sec: hookMaxBeatSec,
      hook_min_beat_sec: hookMinBeatSec,
      retention_ramp_sec: retentionRampSec,
      ramp_target_beat_sec: rampTargetBeatSec,
      ramp_max_beat_sec: rampMaxBeatSec,
      ramp_min_beat_sec: rampMinBeatSec,
    },
    beats: beatsWithQuality,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  if (useEditorialDirector) {
    const planHash = await hashFile(outputPath);
    await writeJson(visualBeatApprovalPath, {
      schema: "goldflow_visual_beat_approval_v1",
      status: "approved",
      approval_kind: "grouping_lock",
      visual_beat_plan_path: outputPath,
      visual_beat_plan_sha256: planHash,
      grouping_lock_sha256: report.editorial_director.grouping_lock_sha256,
      approved_by: flags["approved-by"] ?? "codex-agent",
      approval_note: flags.note ?? "LLM grouping passed exact Whisper coverage, transition, evidence, timing-rail, and active-state validation.",
      regrouping_requires_explicit_operator_approval: true,
      updated_at: new Date().toISOString(),
    });
  }
  console.log(JSON.stringify({ status: report.status, output_path: outputPath, scene_count: report.scene_count, visual_beat_count: report.visual_beat_count }, null, 2));
}

export const visualBeatInternalsForTests = {
  firstPersonProtagonistName,
  hasFirstPersonNarration,
  localVisibleCharacters,
  localBeatReferenceNeeds,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    await writeJson(outputPath, { schema: "goldflow_visual_beat_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
