#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLLMBaseURL, getLLMModel, isLocalLLMRoute, localLLMAuthHeaders, localLLMChatCompletionURL } from "./lib/llm-router.mjs";

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
const outputPath = flags.output ?? path.join(episodeDir, "semantic_scene_plan.json");

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

async function readText(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
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

function approvedForHash(artifact, hash) {
  if (!artifact) return false;
  const status = String(artifact.status ?? artifact.approval_status ?? "").toLowerCase();
  return (artifact.approved === true || artifact.operator_approved === true || status.includes("approved") || status === "script_locked")
    && [artifact.script_clean_hash, artifact.source_script_hash].filter(Boolean).includes(hash);
}

async function requireApproval(scriptHash) {
  if (flags["allow-unlocked-script"] === "true") return { diagnostic: true };
  const manual = await readJson(path.join(episodeDir, "manual_agent_script_review.json"), null);
  const operator = await readJson(path.join(episodeDir, "operator_script_approval.json"), null);
  const lock = await readJson(path.join(episodeDir, "script_lock.json"), null);
  if (approvedForHash(manual, scriptHash) && approvedForHash(operator, scriptHash) && approvedForHash(lock, scriptHash)) {
    return { diagnostic: false };
  }
  throw new Error(`Refusing semantic scene plan: script hash ${scriptHash} is not approved/locked. Run script approve for the exact hash.`);
}

async function biblePacket() {
  const files = ["series_package.json", "series_bible.json", "character_bible.json", "location_bible.json", "visual_style_bible.json"];
  const packet = {};
  for (const file of files) {
    packet[file] = await readJson(path.join(weekDir, file), await readJson(path.join(dataRoot, "channels", channel, "series", series, file), null));
  }
  return packet;
}

function wordCount(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

function sceneCountTargets(script) {
  const words = wordCount(script);
  const target = Math.min(70, Math.max(12, Math.round(words / 200)));
  const minimum = Math.min(target, Math.max(8, Math.floor(words / 320)));
  const maximum = Math.max(target + 12, Math.ceil(words / 120));
  return { words, target, minimum, maximum };
}

function chunkSceneCountTargets(script) {
  const words = wordCount(script);
  const target = Math.max(2, Math.round(words / 200));
  const minimum = Math.max(1, Math.floor(words / 360));
  const maximum = Math.max(target + 3, Math.ceil(words / 110));
  return { words, target, minimum, maximum };
}

function scriptChunks(script, targetWords = Number(flags["semantic-chunk-words"] ?? 1000)) {
  const paragraphs = String(script ?? "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = [];
  let currentWords = 0;
  for (const paragraph of paragraphs) {
    const count = wordCount(paragraph);
    if (current.length && currentWords + count > targetWords) {
      chunks.push(current.join("\n\n"));
      current = [];
      currentWords = 0;
    }
    current.push(paragraph);
    currentWords += count;
  }
  if (current.length) chunks.push(current.join("\n\n"));
  return chunks.map((text, index) => ({ chunk_index: index + 1, chunk_count: chunks.length, text, words: wordCount(text) }));
}

function normalizeScenes(scenes) {
  return scenes.map((scene, index) => ({
    ...scene,
    scene_id: `scene_${String(index + 1).padStart(3, "0")}`,
  }));
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function semanticSceneAnchorFindingsForTests(scenes, script) {
  return semanticSceneAnchorFindings(scenes, script);
}

export function semanticSceneQualityFindingsForTests(scenes) {
  return semanticSceneQualityFindings(scenes);
}

export function semanticBuildPromptForTests(script, bibles, targets, chunk = null) {
  return buildPrompt(script, bibles, targets, chunk);
}

function semanticSceneAnchorFindings(scenes, script) {
  const scriptText = normalizeText(script);
  const findings = [];
  let cursor = 0;
  let previousStart = -1;
  for (const scene of scenes) {
    const sceneId = String(scene?.scene_id ?? "");
    const title = String(scene?.title ?? "");
    const startAnchor = normalizeText(scene?.script_excerpt_start);
    const endAnchor = normalizeText(scene?.script_excerpt_end);
    const startIndex = startAnchor ? scriptText.indexOf(startAnchor, cursor) : -1;
    const endSearchIndex = startIndex >= 0 ? startIndex : cursor;
    const endIndex = endAnchor ? scriptText.indexOf(endAnchor, endSearchIndex) : -1;
    if (!startAnchor) {
      findings.push({ severity: "blocker", code: "semantic_missing_start_anchor", scene_id: sceneId, title, message: "script_excerpt_start is empty." });
    } else if (startIndex < 0) {
      findings.push({ severity: "blocker", code: "semantic_start_anchor_not_found", scene_id: sceneId, title, anchor: startAnchor.slice(0, 180), message: "script_excerpt_start is not found in locked script at or after the previous scene." });
    }
    if (!endAnchor) {
      findings.push({ severity: "blocker", code: "semantic_missing_end_anchor", scene_id: sceneId, title, message: "script_excerpt_end is empty." });
    } else if (endIndex < 0) {
      findings.push({ severity: "blocker", code: "semantic_end_anchor_not_found", scene_id: sceneId, title, anchor: endAnchor.slice(0, 180), message: "script_excerpt_end is not found in locked script at or after this scene start." });
    }
    if (startIndex >= 0 && previousStart >= 0 && startIndex < previousStart) {
      findings.push({ severity: "blocker", code: "semantic_anchor_order_regression", scene_id: sceneId, title, message: "script_excerpt_start appears before the previous accepted scene start." });
    }
    if (startIndex >= 0 && endIndex >= 0 && endIndex < startIndex) {
      findings.push({ severity: "blocker", code: "semantic_end_before_start", scene_id: sceneId, title, message: "script_excerpt_end appears before script_excerpt_start." });
    }
    if (startIndex >= 0) previousStart = startIndex;
    if (endIndex >= 0) cursor = Math.max(cursor, endIndex);
    else if (startIndex >= 0) cursor = Math.max(cursor, startIndex);
  }
  return findings;
}

function countByCode(findings) {
  const counts = {};
  for (const finding of findings) {
    const code = String(finding.code ?? "unknown");
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

function semanticSceneQualityFindings(scenes) {
  const findings = [];
  const mixedLocationPattern = /\b(?:split|montage|then|while|plus|multiple|various|moving between|connected to|transitioning to|and later|screen|dashboard|phone|message view|overlay|system interface|document|publication screens|recorded clip|proposal screen)\b|\/|;/i;
  const propLocationPattern = /\b(?:room|corridor|hallway|hall|lobby|tower|office|desk area|entrance|elevator|warehouse|street|station|shop|library|apartment|conference|court|stage|theater|bookstore|district|square|gate|screen|dashboard|web page|feed|furniture|doors?|windows?|walls?|lighting)\b/i;
  const genericSubjectPattern = /\b(?:employees?|crowd|audience|watchers?|customers?|staff|workers?|passengers?|commuters?|students?|tenants?|people|reporters?|press|bystanders?|security guards?|online public)\b/i;
  const editorialMetaPattern = /\b(?:hook|viewer|retention|thumbnail|youtube|chapter|recap|narrator|audience should|keep watching|ctr)\b/i;
  const characterNames = [];

  for (const scene of scenes) {
    const sceneId = String(scene?.scene_id ?? "");
    const title = String(scene?.title ?? "");
    const location = normalizeText(scene?.location);
    if (location && mixedLocationPattern.test(location)) {
      findings.push({
        severity: "warning",
        code: "semantic_mixed_location_contract",
        scene_id: sceneId,
        title,
        value: location,
        message: "Location appears to mix multiple places, UI, overlays, screens, or montage language instead of one visible physical environment.",
      });
    }
    for (const subject of scene?.visible_subjects ?? []) {
      const value = normalizeText(subject);
      if (value) characterNames.push({ scene_id: sceneId, value });
      if (genericSubjectPattern.test(value)) {
        findings.push({
          severity: "warning",
          code: "semantic_generic_visible_subject",
          scene_id: sceneId,
          title,
          value,
          message: "Generic groups should only be visible subjects when the beat needs public witnesses or readable group reaction.",
        });
      }
    }
    for (const state of scene?.character_states ?? []) {
      const value = normalizeText(state?.character);
      if (value) characterNames.push({ scene_id: sceneId, value });
    }
    for (const prop of scene?.props ?? []) {
      const value = normalizeText(prop);
      if (propLocationPattern.test(value)) {
        findings.push({
          severity: "warning",
          code: "semantic_prop_location_or_ui_bleed",
          scene_id: sceneId,
          title,
          value,
          message: "Props should be tangible foreground objects, not rooms, surfaces, architecture, screens, dashboards, feeds, or location nouns.",
        });
      }
    }
    for (const text of scene?.ui_text_on_screen ?? []) {
      const value = normalizeText(text);
      if (value.length > 90 || value.split(/\s+/).length > 12) {
        findings.push({
          severity: "warning",
          code: "semantic_dense_ui_text",
          scene_id: sceneId,
          title,
          value: value.slice(0, 180),
          message: "UI text is dense enough that image prompts should use concise labels or render-layer overlays instead of asking imagegen to draw it.",
        });
      }
    }
    for (const [field, values] of [
      ["title", [scene?.title]],
      ["visual_intent", [scene?.visual_intent]],
      ["action_staging", [scene?.action_staging]],
      ["continuity_notes", scene?.continuity_notes ?? []],
    ]) {
      for (const raw of values) {
        const value = normalizeText(raw);
        if (value && editorialMetaPattern.test(value)) {
          findings.push({
            severity: "warning",
            code: "semantic_editorial_meta_language",
            scene_id: sceneId,
            title,
            field,
            value: value.slice(0, 180),
            message: "Semantic fields should describe story facts, not packaging or editor/audience intent.",
          });
        }
      }
    }
  }

  const namesByFirstToken = new Map();
  for (const item of characterNames) {
    const parts = item.value.split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const first = parts[0].toLowerCase();
    if (!namesByFirstToken.has(first)) namesByFirstToken.set(first, new Map());
    const byName = namesByFirstToken.get(first);
    if (!byName.has(item.value)) byName.set(item.value, new Set());
    byName.get(item.value).add(item.scene_id);
  }
  for (const [first, byName] of namesByFirstToken) {
    const names = [...byName.keys()];
    const hasSingle = names.some((name) => name.toLowerCase() === first);
    const multiword = names.filter((name) => name.includes(" "));
    if (hasSingle && multiword.length) {
      findings.push({
        severity: "warning",
        code: "semantic_character_alias_churn",
        character_family: first,
        names,
        scene_ids: [...new Set(names.flatMap((name) => [...byName.get(name)]))].sort(),
        message: "The plan alternates between a bare first name and full canonical name; this can split identity refs downstream.",
      });
    }
  }

  return findings;
}

function buildPrompt(script, bibles, targets, chunk = null) {
  const scopeLine = chunk
    ? `This is chunk ${chunk.chunk_index} of ${chunk.chunk_count} from the locked script. Extract semantic scenes only for this chunk, preserving local order.`
    : "Extract a semantic scene plan from the locked narration script.";
  const bibleLimit = chunk ? Number(flags["semantic-chunk-bible-chars"] ?? 8000) : 30_000;
  return `Extract a semantic scene plan from the locked narration script.
${scopeLine}

Rules:
- Use only the locked script and bibles below.
- Do not use source-seed annotations or stale scene artifacts.
- Do not rewrite the script.
- Scene boundaries should support visual planning, SFX planning, and continuity.
- No timestamps. This is semantic only.
- This script is ${targets.words} words. Return about ${targets.target} scenes.
- Hard scene-count range: minimum ${targets.minimum}, maximum ${targets.maximum}.
- Do not collapse acts, montages, flashbacks, locations, or major emotional beats into broad summaries.
- Prefer visual-production units of roughly 120-260 spoken words each; shorter is fine for fast action, reveals, UI inserts, or emotional turns.
- Include production facts needed by visual prompts: location, visible_subjects, primary_subject, visual_intent, ui_text_on_screen, sfx_cues, character_states, wardrobe, props, ref_requirements, action_staging.
- Resolve role/title aliases to canonical named characters when the script establishes that relationship. If a named person is introduced as the dean, boss, chairman, judge, professor, host, rival, spouse, parent, or another title, later role-only mentions such as "the dean" or "the judge" should refer to that named person instead of creating a new generic character. In visible_subjects and character_states, use the named character and put the role in their state, for example "Kai Cenat, acting as dean and final judge." Only create a separate role character when the script clearly introduces a different person.
- Use one canonical display name for each named person after the script establishes it. Do not alternate between a first name and a full name for the same character in visible_subjects, character_states, or character ref IDs; keep role/title aliases in the state or continuity notes.
- Treat location as one visible physical environment for this scene, not merely the parent venue name and not a mixture of UI, overlays, phone views, document views, remote call locations, or montage destinations. If a passage moves through several physical environments, split it into separate semantic scenes whenever possible. If the passage is a communication or montage beat that cannot be split cleanly, set location to the camera's primary physical environment and describe remote/on-screen material in ui_text_on_screen, action_staging, or continuity_notes.
- If a story arc stays inside one larger venue but moves through distinct visible areas, give each scene the specific area name and a matching location ref requirement. Do not reuse one broad location ref ID for different visible areas such as entrance, hallway, main room, screen wall, table area, plaza, roof, basement, server room, witness stand, audience floor, or exterior approach. Same building/campus/city/arena/company/palace is not enough to merge location refs when the visuals should change.
- visible_subjects means physically visible named people or people visibly shown through a specific screen/broadcast/replay that the scene will depict. Put remote callers, online commenters, text-message senders, and remembered people in ui_text_on_screen, action_staging, or continuity_notes unless the current visual should literally show them on a device or screen. Add anonymous groups such as workers, audience, employees, reporters, customers, or guards only when the local scene needs public witnesses, crowd pressure, or group reaction.
- props means tangible foreground objects the camera should show. Do not put rooms, doors, windows, desks, walls, stages, screens, dashboards, webpages, feeds, architecture, lighting, or whole locations in props. Put architecture and surfaces in location/action_staging, and put screens/dashboards/feeds in ui_text_on_screen or action_staging.
- ui_text_on_screen should be concise image/render guidance: short system labels, numbers, chat snippets, document titles, or key words. Do not dump long multi-line system messages, documents, article text, captions, or dense lists into imagegen text. Summarize dense UI as a visual motif here and leave exact long wording to narration/subtitles or render-layer overlays.
- Location ref_requirements are the source of truth for downstream scene scoping. Use stable, specific snake_case location ref IDs that match the scene's visible physical area. A later reference planner may merge true duplicates, but deterministic code will not invent replacement locations after this stage.
- Semantic ref_requirements are scoped target suggestions, not automatic standalone image-generation orders. Include refs for canonical recurring characters, major character states, distinct visible physical locations, signature recurring UI motifs, critical props, and high-risk one-scene close-contact characters. Do not create semantic refs for generic background groups, throwaway one-scene UI text, ordinary desks/doors/screens, or props that can be safely derived from the scene image.
- Avoid editorial/package words in semantic fields, such as hook, retention, thumbnail, CTR, narrator, recap, or what the viewer should feel. Describe the story fact visible in the scene.
- script_excerpt_start and script_excerpt_end must be exact words copied from this script text so Whisper timing can bind them later.

BIBLES:
${JSON.stringify(bibles, null, 2).slice(0, bibleLimit)}

SCRIPT:
${script}

Return one valid JSON object:
{
  "episode_summary": "...",
  "global_reference_requirements": [
    {"ref_id":"style_ref","kind":"style","description":"...","required":true}
  ],
  "scenes": [
    {
      "scene_id": "scene_001",
      "title": "...",
      "script_excerpt_start": "exact words from the first sentence of this scene",
      "script_excerpt_end": "exact words from the final sentence of this scene",
      "location": "...",
      "time": "...",
      "visible_subjects": ["..."],
      "primary_subject": "...",
      "visual_intent": "...",
      "ui_text_on_screen": ["..."],
      "sfx_cues": ["..."],
      "character_states": [{"character":"...","state":"...","wardrobe":"..."}],
      "props": ["..."],
      "ref_requirements": [{"ref_id":"...","kind":"character|location|prop|ui|style","required":true,"reason":"..."}],
      "action_staging": "...",
      "continuity_notes": ["..."]
    }
  ],
  "warnings": []
}`;
}

async function callLocal(prompt, stageName, maxTokens = null) {
  const attempts = Number(flags["semantic-json-attempts"] ?? 3);
  let lastError = null;
  let lastContent = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const retryPrompt = attempt === 1
      ? prompt
      : `${prompt}\n\nYour previous response was invalid JSON. Return one complete JSON object only. Escape all quotation marks inside string values. Do not include markdown fences, commentary, trailing commas, or partial objects.`;
    const response = await fetch(localLLMChatCompletionURL(stageName), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...localLLMAuthHeaders() },
      body: JSON.stringify({
        model: getLLMModel(stageName),
        messages: [
          { role: "system", content: "Return only valid JSON. You are a production semantic planner for longform anime/manhwa recap videos." },
          { role: "user", content: retryPrompt },
        ],
        temperature: attempt === 1 ? Number(flags["llm-temperature"] ?? 0.15) : 0,
        max_tokens: Number(maxTokens ?? flags["llm-max-tokens"] ?? 18000),
      }),
      signal: AbortSignal.timeout(Number(process.env.ANIFACTORY_SEMANTIC_PLAN_TIMEOUT_MS ?? 1_200_000)),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`local-qwen semantic plan HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content ?? raw;
    lastContent = content;
    try {
      return { provider: "local-qwen", model: getLLMModel(stageName), content, parsed: extractJson(content), json_attempt: attempt };
    } catch (error) {
      lastError = error;
      console.error(`semantic ${stageName}: invalid JSON attempt ${attempt}/${attempts}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`local-qwen semantic plan returned invalid JSON after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}; content preview: ${lastContent.slice(0, 600)}`);
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
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`codex semantic plan exited ${code}: ${stderr}`)));
    child.stdin.end(prompt);
  });
  const content = await fs.readFile(outputPath, "utf8");
  return { provider: "codex", model: "codex_cli_default", output_path: outputPath, content, parsed: extractJson(content) };
}

async function main() {
  const script = await readText(scriptPath);
  if (!script.trim()) throw new Error(`Missing script_clean.md at ${scriptPath}`);
  const scriptHash = sha256(script);
  await requireApproval(scriptHash);
  const bibles = await biblePacket();
  const targets = sceneCountTargets(script);
  const stageName = `${episode}_semantic_scene_plan`;
  let llm;
  let scenes = [];
  let semanticParsed = {};
  const useChunking = flags["semantic-chunking"] !== "false" && targets.words > Number(flags["semantic-single-call-max-words"] ?? 2500);
  if (useChunking) {
    const chunks = scriptChunks(script);
    const parsedChunks = [];
    for (const chunk of chunks) {
      const chunkTargets = chunkSceneCountTargets(chunk.text);
      const chunkPrompt = buildPrompt(chunk.text, bibles, chunkTargets, chunk);
      console.error(`semantic chunk ${chunk.chunk_index}/${chunk.chunk_count}: ${chunk.words} words, target ${chunkTargets.target} scenes`);
      const chunkStageName = `${stageName}_chunk_${String(chunk.chunk_index).padStart(2, "0")}`;
      const chunkLlm = isLocalLLMRoute(chunkStageName)
        ? await callLocal(chunkPrompt, chunkStageName, Number(flags["semantic-chunk-max-tokens"] ?? 4500))
        : await callCodex(chunkPrompt, chunkStageName);
      const chunkScenes = Array.isArray(chunkLlm.parsed.scenes) ? chunkLlm.parsed.scenes : [];
      if (chunkScenes.length < chunkTargets.minimum) {
        throw new Error(`Semantic chunk ${chunk.chunk_index}/${chunk.chunk_count} under-segmented: returned ${chunkScenes.length} scenes, minimum is ${chunkTargets.minimum} for ${chunkTargets.words} words.`);
      }
      console.error(`semantic chunk ${chunk.chunk_index}/${chunk.chunk_count}: accepted ${chunkScenes.length} scenes`);
      parsedChunks.push({ chunk, targets: chunkTargets, llm: chunkLlm, scenes: chunkScenes });
      scenes.push(...chunkScenes.map((scene) => ({ ...scene, source_chunk_index: chunk.chunk_index })));
    }
    semanticParsed = {
      episode_summary: parsedChunks.map((item) => item.llm.parsed.episode_summary).filter(Boolean).join(" "),
      global_reference_requirements: parsedChunks.flatMap((item) => item.llm.parsed.global_reference_requirements ?? []),
      warnings: parsedChunks.flatMap((item) => item.llm.parsed.warnings ?? []),
    };
    llm = {
      provider: parsedChunks[0]?.llm?.provider ?? (isLocalLLMRoute(stageName) ? "local-qwen" : "codex"),
      model: parsedChunks[0]?.llm?.model ?? (isLocalLLMRoute(stageName) ? getLLMModel(stageName) : "codex_cli_default"),
      chunked: true,
      chunk_count: chunks.length,
    };
  } else {
    const prompt = buildPrompt(script, bibles, targets);
    llm = isLocalLLMRoute(stageName) ? await callLocal(prompt, stageName) : await callCodex(prompt, stageName);
    semanticParsed = llm.parsed;
    scenes = Array.isArray(llm.parsed.scenes) ? llm.parsed.scenes : [];
  }
  if (!scenes.length) throw new Error("Semantic scene planner returned no scenes.");
  if (scenes.length < targets.minimum) {
    throw new Error(`Semantic scene planner under-segmented locked script: returned ${scenes.length} scenes, minimum is ${targets.minimum} for ${targets.words} words.`);
  }
  if (scenes.length > targets.maximum) {
    throw new Error(`Semantic scene planner over-segmented locked script: returned ${scenes.length} scenes, maximum is ${targets.maximum} for ${targets.words} words.`);
  }
  const normalizedScenes = normalizeScenes(scenes);
  const anchorFindings = semanticSceneAnchorFindings(normalizedScenes, script);
  const anchorBlockers = anchorFindings.filter((finding) => finding.severity === "blocker");
  if (anchorBlockers.length) {
    const preview = anchorBlockers.slice(0, 8).map((finding) => `${finding.scene_id} ${finding.code}: ${finding.anchor ?? finding.message}`).join("\n");
    throw new Error(`Semantic scene planner returned scene anchors that do not bind to the locked script:\n${preview}`);
  }
  const semanticQualityFindings = semanticSceneQualityFindings(normalizedScenes);
  const report = {
    schema: "goldflow_semantic_scene_plan_v1",
    status: "passed",
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: scriptHash,
    source_script_path: scriptPath,
    timing_dependency: "none_semantic_only",
    scene_count_policy: targets,
    semantic_validation: {
      anchor_finding_count: anchorFindings.length,
      anchor_findings_by_code: countByCode(anchorFindings),
      quality_finding_count: semanticQualityFindings.length,
      quality_findings_by_code: countByCode(semanticQualityFindings),
    },
    semantic_quality_findings: semanticQualityFindings,
    planner: { provider: llm.provider, model: llm.model ?? null, output_path: llm.output_path ?? null, chunked: llm.chunked ?? false, chunk_count: llm.chunk_count ?? null },
    ...semanticParsed,
    scenes: normalizedScenes,
    updated_at: new Date().toISOString(),
  };
  await writeJson(outputPath, report);
  console.log(JSON.stringify({ status: "passed", output_path: outputPath, scene_count: scenes.length, source_script_hash: scriptHash }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await writeJson(outputPath, { schema: "goldflow_semantic_scene_plan_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() }).catch(() => {});
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
