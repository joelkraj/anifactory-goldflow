#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(dataRoot, "channels", channel, "weekly_runs", week);
const episodeDir = path.join(weekDir, "episodes", episode);
const scriptPath = path.join(episodeDir, "script_clean.md");
const reportPath = path.join(episodeDir, "script_speakability_report.json");
const overridesPath = path.join(episodeDir, "tts_spoken_overrides.json");
const protectedTermsPath = path.join(episodeDir, "protected_terms_report.json");

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
  return createHash("sha256").update(String(value ?? "")).digest("hex");
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

function approvedForHash(artifact, hash) {
  if (!artifact) return false;
  const status = String(artifact.status ?? artifact.approval_status ?? "").toLowerCase();
  return (artifact.approved === true || artifact.operator_approved === true || status.includes("approved") || status === "script_locked")
    && [artifact.script_clean_hash, artifact.source_script_hash, artifact.script_hash].filter(Boolean).includes(hash);
}

async function requireApproval(scriptHash) {
  if (flags["allow-unlocked-script"] === "true") return;
  const manual = await readJson(path.join(episodeDir, "manual_agent_script_review.json"), null);
  const operator = await readJson(path.join(episodeDir, "operator_script_approval.json"), null);
  const lock = await readJson(path.join(episodeDir, "script_lock.json"), null);
  if (approvedForHash(manual, scriptHash) && approvedForHash(operator, scriptHash) && approvedForHash(lock, scriptHash)) return;
  throw new Error(`Refusing speakability plan: script hash ${scriptHash} is not approved/locked. Run script approve for the exact hash.`);
}

function extractJson(text) {
  const raw = String(text ?? "").trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error(`LLM output did not contain JSON: ${raw.slice(0, 600)}`);
}

function lineNumberForIndex(text, index) {
  return String(text ?? "").slice(0, Math.max(0, index)).split("\n").length;
}

function excerptAround(text, index, length) {
  const start = Math.max(0, index - 90);
  const end = Math.min(text.length, index + length + 90);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function addMatches(script, rows, code, pattern, reason, suggestion = null) {
  for (const match of script.matchAll(pattern)) {
    rows.push({
      code,
      token: match[0],
      line: lineNumberForIndex(script, match.index ?? 0),
      excerpt: excerptAround(script, match.index ?? 0, match[0].length),
      reason,
      suggested_spoken_form: typeof suggestion === "function" ? suggestion(match) : suggestion,
    });
  }
}

function metaNarratorSuggestion(match) {
  const text = String(match[0] ?? "");
  if (/wants you to understand/i.test(text)) return "what they saw was";
  if (/will tell you/i.test(text)) return "the truth is";
  if (/will share/i.test(text)) return "the record shows";
  if (/will describe/i.test(text)) return "the footage showed";
  if (/will give it to you/i.test(text)) return "it happened";
  if (/will move fast/i.test(text)) return "the clips moved fast";
  if (/confirms?/i.test(text)) return "the record confirms";
  if (/swears this is true/i.test(text)) return "the footage proves this";
  return null;
}

function decimalSpoken(match) {
  const [left, right] = String(match[0]).split(".");
  if (/00$/.test(right ?? "")) return `${left} point zero zero`;
  return `${left} point ${String(right ?? "").split("").join(" ")}`;
}

function deterministicScan(script) {
  const rows = [];
  addMatches(script, rows, "rank_token", /\b(?:[A-Z]|SS|SSS)\s*[- ]Rank\b/g, "Letter-rank labels often need explicit TTS pronunciation.", (match) => match[0].replace(/-/g, " "));
  addMatches(script, rows, "decimal_number", /\b\d+\.\d+\b/g, "Decimal numbers can be misread or rushed by TTS.", decimalSpoken);
  addMatches(script, rows, "won_amount", /\b\d{1,3}(?:,\d{3})+\s+WON\b/gi, "Currency amounts need a stable spoken form.", null);
  addMatches(script, rows, "ui_separator", /[A-Z0-9][A-Z0-9 '\-:.,]+(?:\s*[|→]\s*[A-Z0-9][A-Z0-9 '\-:.,]+)+/g, "Ticker/UI text with separators should be converted to speakable phrases.", null);
  addMatches(script, rows, "all_caps_ui", /\b[A-Z][A-Z0-9' -]{8,}\b/g, "All-caps UI text may be spelled or shouted unless normalized.", null);
  addMatches(script, rows, "percent_token", /\b\d+(?:\.\d+)?%/g, "Percent symbols need explicit spoken wording.", (match) => match[0].replace("%", " percent"));
  addMatches(script, rows, "ratio_or_odds", /\b\d+(?:\.\d+)?\s*(?:to|:)\s*1\b/gi, "Odds/ratios need context-aware spoken wording.", null);
  addMatches(script, rows, "tts_homograph_live_content", /\blive\s+content\b/gi, "The phrase live content can be misread as liv/contented wording. Prefer livestream video content in Qwen spoken text.", (match) => preserveCase(match[0], "livestream video content"));
  addMatches(script, rows, "tts_homograph_streaming_live", /\bstreaming\s+live\b/gi, "The phrase streaming live can still make TTS choose the wrong live pronunciation. Prefer livestreaming in Qwen spoken text.", (match) => preserveCase(match[0], "livestreaming"));
  addMatches(script, rows, "tts_homograph_live_stream_noun", /\blive\s+stream\b/gi, "The phrase live stream should be collapsed to livestream for stable TTS pronunciation.", (match) => preserveCase(match[0], "livestream"));
  addMatches(script, rows, "tts_homograph_stream_content", /\bstream\s+content\b/gi, "The phrase stream content can make TTS choose the adjective content pronunciation. Prefer stream videos in Qwen spoken text.", (match) => preserveCase(match[0], "stream videos"));
  addMatches(script, rows, "tts_homograph_live_stream", /\b(?:go|went|going|goes|is|was|were|be|being|stayed|stay)\s+live\b/gi, "The word live can be misread as liv instead of live-stream live. Prefer an explicit streaming phrase in Qwen spoken text.", (match) => homographLiveSuggestion(match[0]));
  addMatches(script, rows, "tts_homograph_content_noun", /\b(?:became|become|becoming|is|was|were|are|as|into)\s+(?:her\s+|his\s+|their\s+|the\s+)?content\b/gi, "The noun content can be misread like satisfied/content. Prefer clip, video content, or stream content in Qwen spoken text.", (match) => homographContentSuggestion(match[0]));
  addMatches(
    script,
    rows,
    "meta_narrator_self_reference",
    /\b(?:the\s+)?narrator\s+(?:wants\s+you\s+to\s+understand|will\s+(?:tell|share|describe|give|move)|confirms?|swears\s+this\s+is\s+true)[^.!?\n]*(?:[.!?])?/gi,
    "Explicit narrator self-reference can sound artificial in TTS narration and should be reviewed before approval.",
    metaNarratorSuggestion,
  );
  const dedup = new Map();
  for (const row of rows) {
    const key = `${row.code}:${row.line}:${row.token}`;
    if (!dedup.has(key)) dedup.set(key, row);
  }
  return [...dedup.values()].slice(0, Number(flags["max-detected-terms"] ?? 240));
}

function preserveCase(source, replacement) {
  const text = String(source ?? "");
  if (!text) return replacement;
  return /^[A-Z]/.test(text) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
}

function homographLiveSuggestion(value) {
  const text = String(value ?? "");
  const lower = text.toLowerCase();
  if (lower.startsWith("go live")) return preserveCase(text, "start a livestream");
  if (lower.startsWith("going live")) return preserveCase(text, "starting a livestream");
  if (lower.startsWith("went live")) return preserveCase(text, "started livestreaming");
  if (lower.startsWith("goes live")) return preserveCase(text, "starts livestreaming");
  if (lower.startsWith("is live")) return preserveCase(text, "is livestreaming");
  if (lower.startsWith("was live")) return preserveCase(text, "was livestreaming");
  if (lower.startsWith("were live")) return preserveCase(text, "were livestreaming");
  if (lower.startsWith("be live")) return preserveCase(text, "be livestreaming");
  if (lower.startsWith("being live")) return preserveCase(text, "being on a livestream");
  if (lower.startsWith("stayed live")) return preserveCase(text, "kept livestreaming");
  if (lower.startsWith("stay live")) return preserveCase(text, "keep livestreaming");
  return preserveCase(text, `${text} on stream`);
}

function homographContentSuggestion(value) {
  const text = String(value ?? "");
  const lower = text.toLowerCase();
  if (/\b(?:became|become|becoming)\b/.test(lower)) return text.replace(/\bcontent\b/i, "a clip");
  if (/\binto\b/.test(lower)) return text.replace(/\bcontent\b/i, "a clip");
  if (/\b(?:her|his|their|the)\s+content\b/i.test(text)) return text.replace(/\bcontent\b/i, "stream content");
  return text.replace(/\bcontent\b/i, "video content");
}

function deterministicReplacementCandidates(script) {
  const candidates = [];
  const add = (from, to, reason) => {
    if (!from || !to || from === to) return;
    candidates.push({
      from,
      to,
      regex: false,
      flags: "g",
      scope: "qwen_spoken_text",
      reason,
    });
  };
  for (const match of String(script ?? "").matchAll(/\b(?:go|went|going|goes|is|was|were|be|being|stayed|stay)\s+live\b/gi)) {
    add(match[0], homographLiveSuggestion(match[0]), "Deterministic TTS homograph guard: force live-stream meaning for Qwen narration.");
  }
  for (const match of String(script ?? "").matchAll(/\bstreaming\s+live\b/gi)) {
    add(match[0], preserveCase(match[0], "livestreaming"), "Deterministic TTS homograph guard: force livestreaming pronunciation for Qwen narration.");
  }
  for (const match of String(script ?? "").matchAll(/\blive\s+stream\b/gi)) {
    add(match[0], preserveCase(match[0], "livestream"), "Deterministic TTS homograph guard: force livestream noun pronunciation for Qwen narration.");
  }
  for (const match of String(script ?? "").matchAll(/\blive\s+content\b/gi)) {
    add(match[0], preserveCase(match[0], "livestream video content"), "Deterministic TTS homograph guard: force live-stream media-content meaning for Qwen narration.");
  }
  for (const match of String(script ?? "").matchAll(/\bstream\s+content\b/gi)) {
    add(match[0], preserveCase(match[0], "stream videos"), "Deterministic TTS homograph guard: force media-content meaning for Qwen narration.");
  }
  for (const match of String(script ?? "").matchAll(/\b(?:became|become|becoming|is|was|were|are|as|into)\s+(?:her\s+|his\s+|their\s+|the\s+)?content\b/gi)) {
    add(match[0], homographContentSuggestion(match[0]), "Deterministic TTS homograph guard: force media-content meaning for Qwen narration.");
  }
  const seen = new Set();
  return candidates.filter((row) => {
    const key = `${row.from}\u0000${row.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function biblePacket() {
  const files = ["series_package.json", "series_bible.json", "character_bible.json", "location_bible.json", "visual_style_bible.json"];
  const packet = {};
  for (const file of files) {
    packet[file] = await readJson(path.join(weekDir, file), await readJson(path.join(dataRoot, "channels", channel, "series", series, file), null));
  }
  return packet;
}

function buildPrompt(script, bibles, detectedTerms) {
  return `You are AniFactory's TTS speakability reviewer.

Goal: prepare an approved narration script for text-to-speech without rewriting the story.

Rules:
- Do not rewrite the script.
- Do not change captions, plot, facts, names, scene order, or style.
- Produce spoken equivalents only for tokens/phrases that are risky for TTS.
- Spoken equivalents must preserve meaning and be natural for a controlled anime/manhwa narrator.
- Prefer exact literal phrase replacements. Use regex only for simple repeated token classes.
- Flag and repair ambiguous homographs when context proves the intended meaning, especially "live" meaning live-stream and "content" meaning media/clip content.
- Mark story rewrites as forbidden. This is a TTS guidance artifact, not an enhancement pass.
- Return JSON only.

BIBLES:
${JSON.stringify(bibles, null, 2).slice(0, Number(flags["speakability-bible-chars"] ?? 12_000))}

DETERMINISTIC RISK SCAN:
${JSON.stringify(detectedTerms, null, 2).slice(0, Number(flags["speakability-risk-chars"] ?? 20_000))}

SCRIPT:
${script.slice(0, Number(flags["speakability-script-chars"] ?? 80_000))}

Return one valid JSON object:
{
  "status": "passed",
  "summary": "short assessment",
  "warnings": [
    {"severity":"info|warning|blocker","code":"...","line":1,"source_text":"...","reason":"...","suggested_spoken_text":"..."}
  ],
  "replacements": [
    {
      "from": "exact source phrase or token",
      "to": "speakable replacement",
      "regex": false,
      "flags": "g",
      "scope": "qwen_spoken_text",
      "reason": "..."
    }
  ],
  "pronunciation_map": [
    {"term":"Han Tae-Jin","spoken":"Han Tae Jin","reason":"..."}
  ],
  "pacing_notes": [
    {"source_text":"...","guidance":"..."}
  ],
  "blocked_story_rewrite_requests": []
}`;
}

async function callLocal(prompt, stageName) {
  const response = await fetch(localLLMChatCompletionURL(stageName), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...localLLMAuthHeaders() },
    body: JSON.stringify({
      model: getLLMModel(stageName),
      messages: [
        { role: "system", content: "Return only valid JSON. You review scripts for TTS speakability and produce replacement artifacts without rewriting story text." },
        { role: "user", content: prompt },
      ],
      temperature: Number(flags["llm-temperature"] ?? 0.1),
      max_tokens: Number(flags["llm-max-tokens"] ?? 9000),
    }),
    signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_SPEAKABILITY_TIMEOUT_MS ?? 900_000)),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`local-qwen speakability HTTP ${response.status}: ${raw.slice(0, 1000)}`);
  const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
  return { provider: "local-qwen", model: getLLMModel(stageName), content, parsed: extractJson(content) };
}

async function callCodex(prompt, stageName) {
  const callDir = path.join(weekDir, "_codex_calls");
  await fs.mkdir(callDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join(callDir, `${stamp}-${stageName}-output.txt`);
  await new Promise((resolve, reject) => {
    const child = spawn("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "-C", repoRoot, "-o", outputPath], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`codex speakability exited ${code}: ${stderr}`)));
    child.stdin.end(prompt);
  });
  const content = await fs.readFile(outputPath, "utf8");
  return { provider: "codex", model: "codex_cli_default", output_path: outputPath, content, parsed: extractJson(content) };
}

function normalizeReplacement(row) {
  if (!row?.from || typeof row.to !== "string") return null;
  return {
    from: String(row.from),
    to: String(row.to),
    regex: row.regex === true,
    flags: row.flags ?? "g",
    scope: row.scope ?? "qwen_spoken_text",
    reason: row.reason ?? "LLM speakability replacement.",
  };
}

function artifactStatus(parsed) {
  const blockers = (parsed.warnings ?? []).filter((item) => String(item.severity ?? "").toLowerCase() === "blocker");
  return blockers.length ? "blocked" : "passed";
}

function deterministicWarnings(detectedTerms) {
  return detectedTerms
    .filter((row) => row.code === "meta_narrator_self_reference")
    .map((row) => ({
      severity: "warning",
      code: row.code,
      line: row.line,
      source_text: row.token,
      reason: row.reason,
      suggested_spoken_text: row.suggested_spoken_form,
    }));
}

async function main() {
  if (!existsSync(scriptPath)) throw new Error(`Missing script_clean.md: ${scriptPath}`);
  const script = await fs.readFile(scriptPath, "utf8");
  const scriptHash = sha256(script);
  await requireApproval(scriptHash);
  const detectedTerms = deterministicScan(script);
  const bibles = await biblePacket();
  const stageName = `${episode}_script_speakability`;
  const prompt = buildPrompt(script, bibles, detectedTerms);
  const llm = flags["deterministic-only"] === "true"
    ? { provider: "deterministic", model: null, parsed: { status: "passed", summary: "Deterministic scan only.", warnings: [], replacements: [], pronunciation_map: [], pacing_notes: [] } }
    : isLocalLLMRoute(stageName) ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
  const parsed = llm.parsed ?? {};
  const deterministicReplacements = deterministicReplacementCandidates(script);
  const replacementMap = new Map();
  for (const row of [...deterministicReplacements, ...(parsed.replacements ?? []).map(normalizeReplacement).filter(Boolean)]) {
    replacementMap.set(`${row.from}\u0000${row.regex === true}\u0000${row.scope ?? ""}`, row);
  }
  const replacements = [...replacementMap.values()];
  const warnings = [...deterministicWarnings(detectedTerms), ...(parsed.warnings ?? [])];
  const report = {
    schema: "goldflow_script_speakability_report_v1",
    status: artifactStatus(parsed),
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    policy: "Analyze TTS speakability without rewriting script_clean.md. Captions and visuals keep approved script text; TTS may use approved spoken equivalents.",
    planner: { provider: llm.provider, model: llm.model ?? null, output_path: llm.output_path ?? null },
    deterministic_risk_count: detectedTerms.length,
    deterministic_risks: detectedTerms,
    summary: parsed.summary ?? "",
    warnings,
    pronunciation_map: parsed.pronunciation_map ?? [],
    pacing_notes: parsed.pacing_notes ?? [],
    blocked_story_rewrite_requests: parsed.blocked_story_rewrite_requests ?? [],
    replacements,
    updated_at: new Date().toISOString(),
  };
  const overrides = {
    schema: "goldflow_tts_spoken_overrides_v1",
    status: report.status,
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    apply_to: ["qwen_generation_plan.qwen_spoken_text"],
    script_text_policy: "Do not mutate script_clean.md, captions, semantic scenes, or visual prompts.",
    replacements,
    pronunciation_map: report.pronunciation_map,
    updated_at: report.updated_at,
  };
  await writeJson(reportPath, report);
  await writeJson(overridesPath, overrides);
  await writeJson(protectedTermsPath, {
    schema: "goldflow_protected_terms_report_v1",
    status: "passed",
    source_script_hash: scriptHash,
    detected_terms: detectedTerms,
    updated_at: report.updated_at,
  });
  console.log(JSON.stringify({ status: report.status, report_path: reportPath, overrides_path: overridesPath, replacement_count: replacements.length, warning_count: report.warnings.length, source_script_hash: scriptHash }, null, 2));
}

main().catch(async (error) => {
  await writeJson(reportPath, { schema: "goldflow_script_speakability_report_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
