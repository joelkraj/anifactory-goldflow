#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sanitizeCharacterStaging } from "./lib/character-staging-utils.mjs";
import { outOfScopeLocationRefMentions } from "./lib/visual-scope-utils.mjs";

const dataRoot = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const flags = parseFlags(process.argv.slice(2));
const channel = flags.channel ?? "53rebirth";
const series = flags.series ?? flags.seriesSlug ?? "series";
const week = flags.week ?? "current";
const episode = flags.episode ?? "ep_01";
const episodeDir = path.join(dataRoot, "channels", channel, "weekly_runs", week, "episodes", episode);
const promptPath = flags.prompts ?? path.join(episodeDir, "section_image_prompts_reviewed.json");
const timedPlanPath = flags.timed ?? path.join(episodeDir, "timed_scene_plan.json");
const visualReferencePlanPath = flags.visualRefs ?? flags["visual-refs"] ?? path.join(episodeDir, "visual_reference_plan.json");
const characterStateRefsPath = flags.characterStateRefs ?? flags["character-state-refs"] ?? path.join(episodeDir, "character_state_refs.json");
const outputPath = flags.output ?? path.join(episodeDir, "section_image_prompts_hardened.json");
const reportPath = flags.report ?? flags["report-output"] ?? path.join(episodeDir, `visual_prompt_hardening_${episode}.json`);
const samplePath = flags.sample ?? flags["sample-output"] ?? path.join(episodeDir, `visual_prompt_hardening_sample_${episode}.md`);
const mutationHitsOutputPath = flags["mutation-hits-output"] ?? null;
const sampleCount = Math.max(1, Number(flags["sample-count"] ?? 12));
const maxRefs = Math.max(1, Math.min(4, Number(flags["max-scene-references"] ?? 4)));
const hardenMode = String(flags.mode ?? flags["harden-mode"] ?? "sanitize").toLowerCase();
const effectiveHardenMode = "sanitize";
const mutationTrackingEnabled = Boolean(mutationHitsOutputPath);
const mutationStats = new Map();

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

function mutationStat(name) {
  if (!mutationStats.has(name)) {
    mutationStats.set(name, {
      function_name: name,
      call_count: 0,
      matched_count: 0,
      changed_count: 0,
      examples: [],
    });
  }
  return mutationStats.get(name);
}

function recordMutationHit(name, { before, after, matched = null, prompt = null }) {
  if (!mutationTrackingEnabled) return after;
  const stat = mutationStat(name);
  stat.call_count += 1;
  const normalizedBefore = String(before ?? "");
  const normalizedAfter = String(after ?? "");
  const derivedMatch = matched == null ? normalizedBefore !== normalizedAfter : Boolean(matched);
  if (derivedMatch) stat.matched_count += 1;
  if (normalizedBefore !== normalizedAfter) {
    stat.changed_count += 1;
    if (stat.examples.length < 3) {
      stat.examples.push({
        image_id: prompt?.image_id ?? null,
        scene_id: prompt?.scene_id ?? null,
        before: normalizedBefore,
        after: normalizedAfter,
      });
    }
  }
  return after;
}

function trackedMutation(name, before, mutate, options = {}) {
  const after = mutate(String(before ?? ""));
  return recordMutationHit(name, { before, after, ...options });
}

function trackedValueMutation(name, before, after, options = {}) {
  return recordMutationHit(name, { before, after, ...options });
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

function sceneIdNumber(sceneId) {
  const match = String(sceneId ?? "").match(/^scene_(\d+)$/);
  return match ? Number(match[1]) : null;
}

function sceneIdsCover(sceneIds, sceneId) {
  if (!Array.isArray(sceneIds) || !sceneIds.length || sceneIds.includes("*")) return true;
  if (sceneIds.includes(sceneId)) return true;
  const current = sceneIdNumber(sceneId);
  const numeric = sceneIds.map(sceneIdNumber).filter((value) => Number.isFinite(value));
  if (current !== null && sceneIds.length === 2 && numeric.length === 2) {
    const low = Math.min(...numeric);
    const high = Math.max(...numeric);
    return current >= low && current <= high;
  }
  return false;
}

function compactWords(value) {
  return normalize(value).replace(/\s+/g, "");
}

function sanitizeShotManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const arrayOfStrings = (field) => Array.isArray(value[field]) ? value[field].map((item) => String(item ?? "").trim()).filter(Boolean) : [];
  return {
    shot_job: value.shot_job ? String(value.shot_job) : null,
    visible_characters: arrayOfStrings("visible_characters"),
    mentioned_only_characters: arrayOfStrings("mentioned_only_characters"),
    primary_character: value.primary_character ? String(value.primary_character) : null,
    character_state_ref_ids: arrayOfStrings("character_state_ref_ids"),
    protagonist_state_ref_id: value.protagonist_state_ref_id ? String(value.protagonist_state_ref_id) : null,
    location_ref_id: value.location_ref_id ? String(value.location_ref_id) : null,
    foreground_action: value.foreground_action ? String(value.foreground_action) : null,
    visible_props: arrayOfStrings("visible_props"),
    ui_elements: arrayOfStrings("ui_elements"),
    forbidden_ref_ids: arrayOfStrings("forbidden_ref_ids"),
    continuity_notes: value.continuity_notes ? String(value.continuity_notes) : null,
    character_staging: sanitizeCharacterStaging(value.character_staging),
  };
}

function promptText(prompt) {
  return [
    prompt.modelslab_image_prompt,
    prompt.image_prompt,
    prompt.codex_image_prompt,
    prompt.primary_subject,
    prompt.location,
    ...(Array.isArray(prompt.visible_subjects) ? prompt.visible_subjects : []),
    prompt.visual_beat_action,
    prompt.visual_beat_script_excerpt,
  ].filter(Boolean).join(" | ");
}

function promptWorld(prompt) {
  return null;
}

function characterMatchText(prompt) {
  return [
    prompt.modelslab_image_prompt,
    prompt.image_prompt,
    prompt.codex_image_prompt,
    prompt.primary_subject,
  ].filter(Boolean).join(" | ");
}

function sceneAllowed(ref, sceneId) {
  return !Array.isArray(ref.scene_ids) || !ref.scene_ids.length || ref.scene_ids.includes(sceneId);
}

function sourceRefId(ref) {
  return ref.source_ref_id ?? ref.ref_id ?? (ref.state_ref_id ? `char_${ref.state_ref_id}` : null);
}

function characterAliases(ref) {
  const character = String(ref.character ?? ref.subject ?? "");
  const n = normalize(character);
  const aliases = new Set([n, compactWords(character)]);
  const lower = n;
  if ((lower === "jin mu gyeol" || lower.includes("jin mu gyeol")) && !lower.includes("cousin")) aliases.add("mu gyeol");
  if (lower === "jin seol ah") {
    aliases.add("seol ah");
    aliases.add("sister");
    aliases.add("younger sister");
    aliases.add("lady seol ah");
  }
  if (lower === "jin tae sang" || lower.includes("jin tae sang")) {
    aliases.add("tae sang");
    aliases.add("patriarch");
    aliases.add("father");
    aliases.add("clan patriarch");
  }
  if (lower === "elder jin baek") {
    aliases.add("jin baek");
    aliases.add("elder baek");
    aliases.add("elder");
    aliases.add("white bearded elder");
    aliases.add("white bearded man");
    aliases.add("elder with cane");
  }
  if (lower === "envoy do hyun" || lower.includes("envoy do hyun")) {
    aliases.add("do hyun");
    aliases.add("envoy");
    aliases.add("deputy envoy");
    aliases.add("murim alliance envoy");
  }
  if (lower === "jin woon hak") {
    aliases.add("woon hak");
    aliases.add("replacement heir");
    aliases.add("favored heir");
    aliases.add("new young tiger");
  }
  if (lower.includes("cousin")) {
    aliases.add("cousin");
    aliases.add("duel attacker");
    aliases.add("victorious cousin");
  }
  return [...aliases].filter(Boolean);
}

function referenceKindRank(kind) {
  const value = String(kind ?? "").toLowerCase();
  if (value.includes("character")) return 0;
  if (value.includes("location")) return 1;
  if (value.includes("prop") || value.includes("ui")) return 2;
  if (value.includes("action") || value.includes("effect")) return 3;
  if (value.includes("style")) return 9;
  return 6;
}

function makeRequirement(ref_id, kind, slot_purpose, reason, slot_order = 1, required = true, extra = {}) {
  return { ref_id, kind, required, slot_order, slot_purpose, reason, ...extra };
}

function buildIndexes(visualReferencePlan, characterStateRefs) {
  const referenceTargets = visualReferencePlan?.reference_targets ?? [];
  const referenceById = new Map(referenceTargets.map((target) => [target.ref_id, target]));
  const visualCharacterRefs = referenceTargets
    .filter((target) => String(target.kind ?? "") === "character_state" && target.ref_id)
    .map((target) => ({
      ...target,
      character: target.subject ?? target.character ?? target.ref_id,
      source_ref_id: target.ref_id,
      scene_prompt_anchor: target.scene_prompt_anchor ?? target.prompt_anchor,
    }));
  const characterRefs = [
    ...(characterStateRefs?.character_state_refs ?? []),
    ...visualCharacterRefs,
  ].filter((ref) => sourceRefId(ref));
  const refIdByStateId = new Map();
  for (const ref of characterRefs) {
    const refId = sourceRefId(ref);
    referenceById.set(refId, { ...ref, kind: "character_state", ref_id: refId, subject: ref.character });
    if (ref.state_ref_id) refIdByStateId.set(String(ref.state_ref_id), refId);
  }
  const locationTargets = referenceTargets.filter((target) => String(target.kind ?? "") === "location");
  return { referenceById, refIdByStateId, characterRefs, locationTargets };
}

const genericLocationContracts = [];

function beatContractText(prompt) {
  return [
    prompt.modelslab_image_prompt,
    prompt.image_prompt,
    prompt.visual_beat_script_excerpt,
    prompt.visual_beat_action,
    prompt.location,
    prompt.primary_subject,
    ...(Array.isArray(prompt.visible_subjects) ? prompt.visible_subjects : []),
  ].filter(Boolean).join(" ");
}

function locationTargetForContract(contract, locationTargets) {
  if (!contract) return null;
  if (contract.preferredRefId) {
    const exact = locationTargets.find((target) => target.ref_id === contract.preferredRefId);
    if (exact) return exact;
  }
  return locationTargets.find((target) => {
    const text = `${target.ref_id ?? ""} ${target.subject ?? ""} ${target.prompt_anchor ?? ""}`;
    return contract.targetPatterns.some((pattern) => pattern.test(text));
  }) ?? null;
}

function hasExecutiveLoungeSignal(value) {
  return /\b(?:executive lounge|leather couch|glass desk|wine glass|wedding ring|returned ring|bare ring finger)\b/i.test(String(value ?? ""));
}

function hasRainyStreetSignal(value) {
  return /\b(?:rainy street|rain running|hard silver rain|silver rain|puddled street|puddles?|wet pavement|streetlights?|parked car|corporate entrance|outside Blackwell|sidewalk outside|walking home through the rain|walk home through the rain)\b/i.test(String(value ?? ""));
}

function locationContractForPrompt(prompt) {
  return null;
}

function applyLocationContract(text, contract) {
  return String(text ?? "");
}

function removeConflictingSingleLocationClauses(text, contract) {
  return String(text ?? "");
}

function removeConflictingVisibleLocationClauses(text, contract) {
  return String(text ?? "");
}

function sceneNumber(prompt) {
  const match = String(prompt.scene_id ?? "").match(/scene_(\d+)/i);
  return match ? Number(match[1]) : null;
}

function joeyProgressionClause(prompt, requirements) {
  return "";
}

function enforceSingleMomentComposition(text, prompt) {
  return String(text ?? "").trim();
}

function shotRoleForPrompt(prompt) {
  const beat = `${prompt.visual_beat_script_excerpt ?? ""} ${prompt.visual_beat_action ?? ""}`;
  const lower = beat.toLowerCase();
  if (/\b(?:wedding ring|returned ring|glass desk|phone|text|voicemail|message|invoice|payment|bill|debt|memo|file|folder|document|contract|packet|receivable|covenant)\b/i.test(beat)) {
    return "Current cut shot job: object-action insert, with the named prop or screen action clearly foregrounded and the character reaction staged around that object.";
  }
  if (/\b(?:went to work|arrived|entered|walked into|elevator opened|lobby|office|gym|summit|boardroom|coffee shop|courthouse)\b/i.test(beat)) {
    return "Current cut shot job: location-establishing action frame, showing the character entering or occupying the specific location with enough environmental proof for the viewer to identify the place.";
  }
  if (/\b(?:said|asked|told|called|answered|whispered|laughed|smiled|looked|saw|watched|spoke|raised his hand)\b/i.test(beat)) {
    return "Current cut shot job: silent character interaction frame, with clear eyelines, separated bodies, readable facial reactions, and the dominant emotional reaction driving the composition.";
  }
  if (/\b(?:stood|walked|ran|trained|worked|built|sent|signed|bought|collected|packed|quit|deleted|selected|opened)\b/i.test(beat)) {
    return "Current cut shot job: visible physical action frame, centered on the concrete action described in the beat rather than a static portrait.";
  }
  if (/\b(?:realized|understood|thought|remembered|wanted|felt|changed|proof|mission complete|reward|status updated)\b/i.test(beat)) {
    return "Current cut shot job: emotional-reaction frame, with posture, lighting, and one clear visual symbol showing the internal change.";
  }
  if (lower.trim()) {
    return "Current cut shot job: beat-specific story frame, showing a distinct moment from the current narration excerpt with changed camera angle and changed character posture from neighboring cuts.";
  }
  return "Current cut shot job: distinct story frame with changed camera angle, changed pose, and a concrete visible action.";
}

function beatActionClause(prompt) {
  let excerpt = String(prompt.visual_beat_script_excerpt ?? prompt.visual_beat_action ?? "")
    .replace(/“[^”]{1,180}”/g, "silent reaction")
    .replace(/“[^”]{1,220}$/g, "silent reaction")
    .replace(/"[^"]{1,180}"/g, "silent reaction")
    .replace(/"[^"]{1,220}$/g, "silent reaction")
    .replace(/\bMISSION:\s*[A-Z0-9 ,.'-]{8,160}/g, "a blue mission interface")
    .replace(/\b(?:STATUS|BODY|DISCIPLINE|REWARD|PENALTY FOR FAILURE|FAILURE CONDITION|NEW STAT):\s*[A-Z0-9 ,.'-]{2,180}/g, "a blue system interface")
    .replace(/\bYOU ARE NOT YOUR STARTING SCREEN\b/gi, "an abstract blue identity-reset interface")
    .replace(/\bDISCARDED HUSBAND\b/gi, "abstract status glyphs")
    .replace(/\b(?:BODY|DISCIPLINE)\s*:\s*(?:twelve|eight|\d+)\b/gi, "abstract stat glyphs")
    .replace(/\s+/g, " ")
    .trim();
  if (/\b(?:cold email|cold outreach|first real interested reply|four replies|Can you explain|Mara Klein|Smiling Oaks|missed calls?|called her|Hi,|This is Joey|A I receptionist|text-back|review follow-up|send the invoice|payment notification arrived)\b/i.test(excerpt)) {
    excerpt = excerpt
      .replace(/\bI got four replies\. Three (?:said|reacted silently) no\. One (?:said|reacted silently):?\s*Can you explain what you mean\??/gi, "One abstract positive reply notification appears after many failed outreach attempts.")
      .replace(/\bCan you explain what you mean\??/gi, "an abstract positive reply notification")
      .replace(/\bThe sender was Mara Klein, owner of Smiling Oaks Dental\./gi, "A remote prospect card appears as a gold opportunity alert.")
      .replace(/\bMara Klein\b/gi, "remote prospect card")
      .replace(/\bMara\b/gi, "remote prospect card")
      .replace(/\bSmiling Oaks Dental\b/gi, "remote dental prospect")
      .replace(/\bMy hands shook when I called her\.?\s*silent reaction beat\.?/gi, "Joey's hand shakes near the phone as he begins a tense remote sales call.")
      .replace(/\bMy hands shook when silent reaction beat\.?\s*silent reaction\.?/gi, "Joey's hand shakes near the phone as he begins a tense remote sales call.")
      .replace(/\bHi,?\s*remote prospect contact icon\.?\s*This is Joey Mercer\.?/gi, "a tense remote-call start represented by phone and call-flow icons.")
      .replace(/\bHi,?\s*remote prospect card\.?\s*This is Joey Mercer\.?/gi, "a tense remote-call start represented by phone and call-flow icons.")
      .replace(/\bObserved weakness:[^.]+\.?/gi, "Abstract missed-call weakness cards appear.")
      .replace(/\bEstimated [^.]+\.?/gi, "Abstract revenue-leak estimate cards appear.")
      .replace(/\bRecommended offer:[^.]+\.?/gi, "Abstract offer cards appear.")
      .replace(/\bWarning:[^.]+\.?/gi, "A blue system caution card appears.")
      .replace(/\bMicro-mission:[^.]+\.?/gi, "Five question-marker cards appear.")
      .replace(/\bSend the invoice\.?\s*I stared at the phone after she hung up\. Then the payment notification arrived\.?/gi, "Invoice request and payment notification cards appear.")
      .replace(/\bI.?m the one who sent the message about missed calls\.?/gi, "A missed-call topic card appears.")
      .replace(/\bShe sounded busy, suspicious, and one sentence away from hanging up\.?/gi, "A tense phone-call pressure icon appears.")
      .replace(/\bOld Joey would have rushed\.?\s*Apologized\.?/gi, "Old apology reflex appears as a small broken-habit warning icon.")
      .replace(/\bNot a script\. More like a path\.?/gi, "A five-question call path appears.")
      .replace(/\bHow many calls does your front desk miss during lunch\??/gi, "A missed-call question card appears.")
      .replace(/\bToo many\.?/gi, "An abstract high-volume answer card appears.")
      .replace(/\bWhat happens to those calls\??/gi, "A call-routing question card appears.")
      .replace(/\bThey leave voicemails\.?/gi, "A voicemail icon card appears.")
      .replace(/\bSometimes we call back\. Sometimes they book somewhere else\.?/gi, "A lost-booking flow card appears.")
      .replace(/\bHow quickly do you usually respond\??/gi, "A response-time question card appears.")
      .replace(/\bAnother pause\.?/gi, "A pause icon appears.")
      .replace(/[“”"]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  const dialogueHeavy = /\b(?:said|asked|told|whispered|called|answered|shouted|replied|spoke)\b/i.test(excerpt);
  if (dialogueHeavy) {
    excerpt = excerpt
      .replace(/\b(?:he|she|they|I|Joey|Preston|Vivian|Darren|Mara|Evelyn|Marcus)\s+(?:said|asked|told|whispered|called|answered|shouted|replied|spoke)\b[^.?!]{0,160}[.?!]?/gi, "silent reaction beat.")
      .replace(/\b(?:said|asked|told|whispered|called|answered|shouted|replied|spoke)\b/gi, "reacted silently")
      .replace(/\ba spoken line\b/gi, "silent reaction")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (!excerpt) return "";
  const compact = excerpt.length > 220 ? `${excerpt.slice(0, 220).replace(/\s+\S*$/, "")}.` : excerpt;
  return `Current narration moment to stage visually without visible text: ${compact}`;
}

function applyShotContract(text, prompt) {
  const role = shotRoleForPrompt(prompt);
  const beat = beatActionClause(prompt);
  const clauses = [role, beat].filter(Boolean);
  return `${clauses.join(" ")} ${text}`.replace(/\s+/g, " ").trim();
}

function stripDialogueCueLanguage(text) {
  return String(text ?? "")
    .replace(/\ba blue system interfacenderneath it appeared a sentence\b/gi, "a blue system interface appeared")
    .replace(/\bspeaking or reacting character\b/gi, "dominant reacting character")
    .replace(/\bwhile Preston humiliates him loudly\b/gi, "while Preston performs smug public contempt through posture and expression")
    .replace(/\bPreston humiliates him loudly\b/gi, "Preston performs smug public contempt through posture and expression")
    .replace(/\bVivian whispered something\b/gi, "Vivian leans close in a private cruel aside")
    .replace(/\bPreston laughed again\b/gi, "Preston smirks in the background")
    .replace(/\bEveryone laughed\b/gi, "the surrounding assistants show mocking smiles")
    .replace(/\bloudly\b/gi, "visibly")
    .replace(/\bsilent dialogue-free reaction\b/gi, "silent reaction")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeUnattachedCharacterMentions(text, selectedRequirements, characterRefs) {
  const attached = new Set(selectedRequirements.filter((req) => referenceKindRank(req.kind) === 0).map((req) => req.ref_id));
  let next = text;
  for (const ref of characterRefs) {
    const refId = sourceRefId(ref);
    if (!refId || attached.has(refId)) continue;
    const names = [ref.character, ref.subject, ...(characterAliases(ref) ?? [])]
      .map((name) => String(name ?? "").trim())
      .filter((name) => name && name.length >= 3)
      .sort((a, b) => b.length - a.length);
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      next = next
        .replace(new RegExp(`\\b${escaped}\\s*(?:'s|s)\\s+(?:text|message|voicemail|phone call|call|chat|post|profile|name)\\b`, "gi"), "the phone contact notification")
        .replace(new RegExp(`\\b(?:text|message|voicemail|phone call|call|chat|post|profile|name)\\s+(?:from|of|for)\\s+${escaped}\\b`, "gi"), "phone contact notification")
        .replace(new RegExp(`\\b${escaped}\\b.{0,40}\\b(?:on the phone|on a screen|in a screenshot|in a chat|in a message|in a voicemail|as a contact|as a profile)\\b`, "gi"), "a contact notification on the device screen")
        .replace(new RegExp(`\\b(?:memory|thought|flashback|ghosted overlay|overlay|inset)\\s+(?:of\\s+)?${escaped}\\b`, "gi"), "soft abstract memory lighting");
    }
  }
  return next;
}

function locationForPrompt(prompt, locationTargets) {
  const sceneId = prompt.scene_id;
  const promptLocationText = normalize(`${prompt.modelslab_image_prompt ?? prompt.image_prompt ?? ""}`);
  const fallbackLocationText = normalize(`${prompt.location ?? ""} ${prompt.modelslab_image_prompt ?? prompt.image_prompt ?? ""}`);
  const beatSpecificText = [
    prompt.visual_beat_script_excerpt,
    prompt.visual_beat_action,
    prompt.location,
    prompt.primary_subject,
    ...(Array.isArray(prompt.visible_subjects) ? prompt.visible_subjects : []),
  ].filter(Boolean).join(" ");
  const excerptText = String(prompt.visual_beat_script_excerpt ?? "");
  if (hasExecutiveLoungeSignal(beatSpecificText) || hasExecutiveLoungeSignal(promptText(prompt))) {
    const exact = locationTargets.find((location) => location.ref_id === "blackwell_lounge_ref");
    if (exact) return exact;
  }
  if (hasRainyStreetSignal(beatSpecificText) || hasRainyStreetSignal(promptText(prompt))) {
    const exact = locationTargets.find((location) => location.ref_id === "rainy_street_ref");
    if (exact) return exact;
  }
  if (
    /\b(?:brought dinner|paper bag with Thai food|holding a paper bag|stood in the elevator|elevator opened|remember we were married|remember I was still trying)\b/i.test(excerptText)
    && !/\b(?:found Vivian|Vivian in the executive lounge|sitting on a leather couch|wedding ring missing|Preston|looked at my stomach|everyone laughed)\b/i.test(excerptText)
  ) {
    const exact = locationTargets.find((location) => location.ref_id === "blackwell_lobby_elevator_ref");
    if (exact) return exact;
  }
  if (/\bVivian used to say\b|\bbarely looked at me\b|\bstopped looking at me\b/i.test(excerptText)) {
    const exact = locationTargets.find((location) => location.ref_id === "joey_apartment_ref");
    if (exact) return exact;
  }
  const beatLocationOverrides = [
    { pattern: /\bone hundred and eighty days later\b|\bnew body\b|\bclean suit\b|\btwo attorneys\b|\bdebt documents\b|\bwalked back into the same building\b/i, ref_id: "blackwell_lobby_elevator_ref", ref: /\blobby\b|\belevator\b|\bcorporate tower\b|\bsecurity desk\b/i },
    { pattern: /\bbrought dinner\b|\bpaper bag with Thai food\b|\bholding a paper bag\b|\bstood in the elevator\b|\belevator opened\b|\bremember we were married\b|\bremember I was still trying\b/i, ref_id: "blackwell_lobby_elevator_ref", ref: /\blobby\b|\belevator\b|\bcorporate tower\b|\bsecurity desk\b/i },
    { pattern: /\bweighed two hundred and fifty pounds\b|\bshirts pulled at the buttons\b|\bshirt buttons\b|\bbody-state proof\b/i, ref_id: "blackwell_lobby_elevator_ref", ref: /\blobby\b|\belevator\b|\bcorporate tower\b|\bsecurity desk\b/i },
    { pattern: /\bPreston raised his hand\b|\bPUBLIC CHALLENGE\b|\bANSWER WITHOUT DEFENSIVENESS\b|\bQ&A\b|\bhost asked for questions\b/i, ref_id: "northbridge_summit_ref", ref: /\bsummit\b|\bconference\b|\bstage\b|\baudience\b/i },
    { pattern: /\bvending\b|\bsnack\b|\bcard readers?\b|\broute economics\b/i, ref_id: "vending_route_ref", ref: /\bvending\b|\bsnack\b|\bmachine\b|\broute\b/i },
    { pattern: /\bdental\b|\bdentist\b|\bSmiling Oaks\b|\bappointments?\b|\bMara\b/i, ref_id: "dental_office_ref", ref: /\bdental\b|\bdentist\b|\bpractice\b|\bpatient\b/i },
    { pattern: /\bsupport job\b|\bheadset\b|\bsupport tickets?\b|\bDarren\b/i, ref_id: "support_office_ref", ref: /\bsupport\b|\bcall[-\s]?center\b|\bheadset\b/i },
  ];
  for (const row of beatLocationOverrides) {
    if (!row.pattern.test(beatSpecificText)) continue;
    if (
      row.ref_id === "dental_office_ref"
      && /\b(?:private group chat|chat screenshot|mocking chat|dentist bots?|social humiliation|mockery detected|Preston wrote|cold email|cold outreach|outreach list|called her|phone call|remote prospect|reply notification|A I receptionist|text-back|review follow-up)\b/i.test(beatSpecificText)
      && !/\b(?:walked into|arrived at|entered|inside|in-person|visited|reception counter|patient chairs|clinic room|dental chair)\b/i.test(beatSpecificText)
    ) {
      continue;
    }
    const exact = locationTargets.find((location) => location.ref_id === row.ref_id);
    if (exact) return exact;
    const target = locationTargets.find((location) => row.ref.test(`${location.ref_id ?? ""} ${location.subject ?? ""} ${location.prompt_anchor ?? ""}`));
    if (target) return target;
  }
  const contract = locationContractForPrompt(prompt);
  const contractTarget = locationTargetForContract(contract, locationTargets);
  if (contractTarget) return contractTarget;
  if (
    /\b(?:punishment courtyard|courtyard gate|punishment post|winter stone courtyard|snowy stone path|icy stone path)\b/i.test(promptLocationText)
    && /\b(?:banquet hall glow|music from the hall|sound wave lines.*banquet hall|banquet hall sound|hall glow)\b/i.test(promptLocationText)
  ) {
    const target = locationTargets.find((location) => location.ref_id === "loc_punishment_courtyard");
    if (target) return target;
  }
  if (
    /\b(?:side corridor|corridor pillar|pillar shadow|carved window lattice|side wall of the ancestral hall|servants passage|service passage|wooden ladder|rafters above|rafter gaps)\b/i.test(promptLocationText)
    && /\b(?:banquet hall glow|music from the hall|banquet continuing|hall glow)\b/i.test(promptLocationText)
  ) {
    const target = locationTargets.find((location) => location.ref_id === "loc_ancestral_hall_altar_rafters");
    if (target) return target;
  }
  if (/\b(?:punishment courtyard|courtyard gate|punishment post|gate-side punishment courtyard|snowy gray stone path|icy stone path|subdued guards|gate path opening)\b/i.test(promptLocationText)) {
    const target = locationTargets.find((location) => location.ref_id === "loc_punishment_courtyard");
    if (target) return target;
  }
  const explicitVenueMap = [
    { pattern: /\b(?:great clan hall|banquet hall|honored seat|elder row|ancestral tablet|ceremony hall)\b/i, ref_id: "loc_azure_sky_banquet_hall" },
    { pattern: /\b(?:punishment courtyard)\b/i, ref_id: "loc_punishment_courtyard" },
    { pattern: /\b(?:ancestral hall|altar|rafter|service passage|servants passage|ceiling beam)\b/i, ref_id: "loc_ancestral_hall_altar_rafters" },
    { pattern: /\b(?:east courtyard|mother room|plum tree|old room)\b/i, ref_id: "loc_east_courtyard_mothers_room" },
    { pattern: /\b(?:rooftop|training square|garden wall)\b/i, ref_id: "loc_clan_rooftops_training_square" },
    { pattern: /\b(?:snowy courtyard|broken wall)\b/i, ref_id: "loc_snowy_courtyard_broken_wall" },
    { pattern: /\b(?:underground channel|ravine|water channel)\b/i, ref_id: "loc_underground_channel_winter_ravine" },
    { pattern: /\b(?:duel platform|arena edge)\b/i, ref_id: "loc_duel_platform_flashback" },
  ];
  const contextualMap = [
    { pattern: /\b(?:ancestral hall|altar|rafter|service passage|servants passage|ceiling beam)\b/i, ref_id: "loc_ancestral_hall_altar_rafters" },
    { pattern: /\b(?:spirit rope|courtyard gate)\b/i, ref_id: "loc_punishment_courtyard" },
    { pattern: /\b(?:east courtyard|mother room|plum tree|old room)\b/i, ref_id: "loc_east_courtyard_mothers_room" },
    { pattern: /\b(?:rooftop|training square|garden wall)\b/i, ref_id: "loc_clan_rooftops_training_square" },
    { pattern: /\b(?:snowy courtyard|broken wall)\b/i, ref_id: "loc_snowy_courtyard_broken_wall" },
    { pattern: /\b(?:underground channel|ravine|water channel)\b/i, ref_id: "loc_underground_channel_winter_ravine" },
    { pattern: /\b(?:duel platform|arena edge)\b/i, ref_id: "loc_duel_platform_flashback" },
    { pattern: /\b(?:great clan hall|banquet hall|honored seat|elder row|ancestral tablet|ceremony hall)\b/i, ref_id: "loc_azure_sky_banquet_hall" },
  ];
  for (const row of explicitVenueMap) {
    if (row.pattern.test(promptLocationText)) {
      const target = locationTargets.find((location) => location.ref_id === row.ref_id);
      if (target) return target;
    }
  }
  for (const row of [...explicitVenueMap, ...contextualMap]) {
    if (row.pattern.test(fallbackLocationText)) {
      const target = locationTargets.find((location) => location.ref_id === row.ref_id);
      if (target) return target;
    }
  }
  const candidates = locationTargets.filter((target) => Array.isArray(target.scene_ids) && target.scene_ids.includes(sceneId));
  if (!candidates.length) return null;
  const mixedLocationScene = /\b(?:then|montage|later|after|before|while|meanwhile)\b/i.test(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "");
  if (mixedLocationScene && !normalize(prompt.location)) return null;
  const genericPreferredLocationIds = new Set(genericLocationContracts.map((contract) => contract.preferredRefId).filter(Boolean));
  const loc = normalize(prompt.location);
  if (!loc) return null;
  if (candidates.length === 1 && !genericPreferredLocationIds.has(candidates[0].ref_id)) return candidates[0];
  return candidates.find((target) => normalize(`${target.subject} ${target.prompt_anchor}`).includes(loc.split(" ").slice(0, 3).join(" "))) ?? null;
}

function matchedCharacters(prompt, characterRefs) {
  const sceneId = prompt.scene_id;
  const text = normalize(characterMatchText(prompt));
  const compact = compactWords(characterMatchText(prompt));
  const currentBeatText = `${prompt.visual_beat_script_excerpt ?? ""} ${prompt.visual_beat_action ?? ""}`;
  const visible = (Array.isArray(prompt.visible_subjects) ? prompt.visible_subjects : []).map(normalize);
  const primary = normalize(prompt.primary_subject);
  const rows = [];
  for (const ref of characterRefs) {
    const aliases = characterAliases(ref);
    const characterName = normalize(ref.character ?? ref.subject ?? "");
    const aliasMatches = (value) => {
      const normalizedValue = normalize(value);
      const compactValue = normalizedValue.replace(/\s+/g, "");
      return aliases.some((alias) => {
        const aliasNorm = normalize(alias);
        const aliasCompact = aliasNorm.replace(/\s+/g, "");
        return normalizedValue === aliasNorm
          || normalizedValue.includes(aliasNorm)
          || aliasNorm.includes(normalizedValue)
          || compactValue.includes(aliasCompact)
          || aliasCompact.includes(compactValue);
      });
    };
    const hit = aliases.find((alias) => {
      if (!alias) return false;
      const aliasNorm = normalize(alias);
      return primary === aliasNorm
        || text.includes(aliasNorm)
        || compact.includes(aliasNorm.replace(/\s+/g, ""));
    });
    if (!hit) continue;
    if (!characterIsPhysicallyStaged(prompt, aliases, hit)) continue;
    if (
      /\b(?:childhood memory|young mu gyeol|young seol ah|as children)\b/i.test(text)
      && !/\bunseen hands\b/i.test(text)
      && !/\b(?:child|childhood|young)\b/i.test(normalize(ref.state ?? ref.state_label ?? ref.ref_id ?? ref.source_ref_id ?? ""))
    ) {
      continue;
    }
    if (
      characterName.includes("jin mu gyeol")
      && !primary.includes("mu gyeol")
      && !visible.some((subject) => aliasMatches(subject))
      && /\bmu gyeol s mother\b/i.test(text)
      && !/\bmu gyeol\b(?! s mother)/i.test(text)
    ) {
      continue;
    }
    const allowed = sceneAllowed(ref, sceneId);
    const refId = sourceRefId(ref);
    if (
      refId === "darren_ref"
      && !/\b(?:Darren|manager|went to work|support|headset|tickets?|workplace|office|self-deprecate|apologizing|handling it|hard night)\b/i.test(currentBeatText)
    ) {
      continue;
    }
    const roleOverride = (
      /\b(?:elder|elder jin baek|white bearded elder|patriarch|jin tae sang|envoy|envoy do hyun|deputy envoy|murim alliance envoy|replacement heir|favored heir|jin woon hak|cousin|victorious cousin|duel attacker)\b/i.test(hit)
    );
    if (!allowed && !roleOverride) continue;
    const primaryBoost = primary && aliasMatches(primary) ? 0 : 1;
    const visibleIndex = visible.findIndex((subject) => aliasMatches(subject));
    const firstMention = Math.min(
      ...aliases.map((alias) => text.indexOf(normalize(alias))).filter((index) => index >= 0),
      ...aliases.map((alias) => compact.indexOf(normalize(alias).replace(/\s+/g, ""))).filter((index) => index >= 0)
    );
    const mentionRank = Number.isFinite(firstMention) ? Math.min(80, firstMention / 40) : 100;
    rows.push({
      ref,
      hit,
      score: (allowed ? 0 : 25)
        + primaryBoost * 5
        + (visibleIndex >= 0 ? visibleIndex * 8 : 80)
        + mentionRank,
    });
  }
  return rows.sort((a, b) => a.score - b.score).map((row) => row.ref);
}

function characterIsPhysicallyStaged(prompt, aliases, hit) {
  const text = String(characterMatchText(prompt) ?? "");
  const visible = (Array.isArray(prompt.visible_subjects) ? prompt.visible_subjects : []).map(normalize);
  const primary = normalize(prompt.primary_subject);
  const aliasNorms = aliases.map(normalize).filter(Boolean);
  if (primary && aliasNorms.some((alias) => primary === alias || primary.includes(alias))) return true;
  if (visible.some((subject) => aliasNorms.some((alias) => subject === alias || subject.includes(alias)))) return true;
  const alias = normalize(hit);
  const compact = alias.replace(/\s+/g, "\\s+");
  if (
    !/\bjoey\b/i.test(alias)
    && new RegExp(`\\b(?:called|call|phone|voicemail|message|text|contact|notification|screenshot|chat)\\b.{0,90}\\b${compact}\\b|\\b${compact}\\b.{0,90}\\b(?:called|call|phone|voicemail|message|text|contact|notification|screenshot|chat|sounded|voice)\\b`, "i").test(text)
  ) {
    return false;
  }
  const nonPhysicalPatterns = [
    new RegExp(`\\b${compact}\\b.{0,80}\\b(?:text|message|voicemail|phone|call|screenshot|chat|post|memo|file|document|memory|thought|name|location|profile|inset|hologram|screen)\\b`, "i"),
    new RegExp(`\\b(?:text|message|voicemail|phone|call|screenshot|chat|post|memo|file|document|memory|thought|name|location|profile|inset|hologram|screen)\\b.{0,80}\\b${compact}\\b`, "i"),
    new RegExp(`\\b${compact}\\s*(?:'s|s)\\b.{0,80}\\b(?:text|message|voicemail|phone|call|name|profile|file|document|ring|office|company|memory)\\b`, "i"),
  ];
  const physicalPatterns = [
    new RegExp(`\\b${compact}\\b.{0,100}\\b(?:stands?|sits?|walks?|enters?|faces?|leans?|cries|smiles|holds?|reaches?|looks?|watches?|beside|next to|across from|in front of|foreground|background|full-body|body|face|eyes|hands?)\\b`, "i"),
    new RegExp(`\\b(?:stands?|sits?|walks?|enters?|faces?|leans?|cries|smiles|holds?|reaches?|looks?|watches?|beside|next to|across from|in front of|foreground|background|full-body|body|face|eyes|hands?)\\b.{0,100}\\b${compact}\\b`, "i"),
  ];
  if (physicalPatterns.some((pattern) => pattern.test(text))) return true;
  if (nonPhysicalPatterns.some((pattern) => pattern.test(text))) return false;
  return true;
}

function existingConcreteRequirements(prompt) {
  const currentBeatText = [
    prompt.visual_beat_script_excerpt,
    prompt.visual_beat_action,
  ].filter(Boolean).join(" ");
  const futureOwnerContrast = /\bone hundred and eighty days later\b|\bnew body\b|\bclean suit\b|\btwo attorneys\b|\bdebt documents\b/i.test(currentBeatText);
  return (prompt.reference_requirements ?? [])
    .filter((req) => {
      if (!req?.ref_id) return false;
      const kind = String(req.kind ?? "").toLowerCase();
      if (kind.includes("style") || kind.includes("character") || kind.includes("location") || req.ref_id === "style_ref") return false;
      const refId = String(req.ref_id ?? "");
      if (/wedding_ring|ring_glass/i.test(refId) && !/\bwedding ring\b|returned ring|glass desk|returned item/i.test(currentBeatText)) return false;
      if (/takeout/i.test(refId) && (futureOwnerContrast || !/\btakeout\b|food bag|thai food|puddle|rain/i.test(currentBeatText))) return false;
      if (/legal_debt_documents/i.test(refId) && !/\bdebt\b|documents?\b|board packets?\b|covenant|receivable|legal\b|attorneys?\b/i.test(currentBeatText)) return false;
      return true;
    })
    .map((req) => ({ ...req, required: req.required !== false }));
}

function resolveCharacterStateConflicts(text, selectedRequirements) {
  let next = String(text ?? "");
  const selectedIds = new Set(selectedRequirements.map((req) => req.ref_id));
  if (selectedIds.has("joey_early_discipline_ref")) {
    next = next
      .replace(/\bJoey Mercer is visibly overweight at two hundred fifty pounds with a round tired face, light stubble, strained old shirt, cheap damp jacket, and exhausted posture\./gi, "Joey Mercer is still visibly overweight with a round tired face and light stubble, wearing a clean simple office shirt and plain dark pants, with cautious focused posture.")
      .replace(/\bcheap damp jacket\b/gi, "clean simple office shirt")
      .replace(/\bstrained old shirt\b/gi, "clean simple office shirt")
      .replace(/\bsweaty, and worn down\b/gi, "tired but controlled")
      .replace(/\bsimple gym or work clothes\b/gi, "clean simple gym or work clothes");
  }
  if (selectedRequirements.filter((req) => referenceKindRank(req.kind) === 0).length === 1) {
    next += " Any background people must be visibly different from the referenced character in age, hairstyle, wardrobe, face shape, and body type.";
  }
  return next.replace(/\s+/g, " ").trim();
}

function dedupeRequirements(requirements) {
  const seen = new Set();
  const out = [];
  for (const req of requirements) {
    if (!req?.ref_id || seen.has(req.ref_id)) continue;
    seen.add(req.ref_id);
    out.push(req);
  }
  return out;
}

function trimRequirements(requirements, options = {}) {
  const nonStyle = requirements.filter((req) => referenceKindRank(req.kind) < 9);
  const style = requirements.filter((req) => referenceKindRank(req.kind) >= 9);
  const pool = nonStyle.length ? nonStyle : style;
  const chars = pool.filter((req) => referenceKindRank(req.kind) === 0);
  const locs = pool.filter((req) => referenceKindRank(req.kind) === 1);
  const others = pool.filter((req) => referenceKindRank(req.kind) > 1).sort((a, b) => referenceKindRank(a.kind) - referenceKindRank(b.kind));
  const selected = [];
  const selectedIds = new Set();
  const protectedRefIds = new Set((options.protectedRefIds ?? []).map(String).filter(Boolean));
  const add = (req) => {
    if (!req?.ref_id || selectedIds.has(req.ref_id) || selected.length >= maxRefs) return;
    selected.push(req);
    selectedIds.add(req.ref_id);
  };
  for (const req of pool) {
    if (selected.length >= maxRefs) break;
    if (protectedRefIds.has(req.ref_id)) add(req);
  }
  for (const req of chars) add(req);
  for (const req of locs) add(req);
  for (const req of others) add(req);
  return selected.slice(0, maxRefs).map((req, index) => ({ ...req, slot_order: index + 1 }));
}

function ensurePromptClauses(prompt, characterCount) {
  const world = promptWorld(prompt);
  const styleClause = world === "murim"
    ? "Clean dark Korean murim manhwa/webtoon illustration, crisp inked linework, controlled cel shading, dramatic lantern-and-winter lighting, full-frame cinematic composition."
    : "Bright vibrant modern anime/manhwa film still, saturated color, crisp linework, glossy highlights, cinematic lighting, expressive faces, polished 16:9 longform video composition.";
  const stagingClause = world === "murim"
    ? "The frame stages each visible character as a separate complete body with clear spacing, distinct face placement, visible shoulders, readable robe boundaries, and one continuous manga frame."
    : "The frame stages each visible character as a separate complete body with clear spacing, distinct face placement, visible shoulders, readable modern clothing boundaries, and one continuous cinematic frame.";
  const exactCharacterClause = "Show exactly one person for each named character; do not duplicate any referenced character, do not show alternate poses of the same character, and do not create extra lookalike copies.";
  const distantSecondaryClause = "For close-up foreground compositions, any secondary character must appear only as a separate distant full-body figure on the floor plane with clear empty space around them, never as a portrait insert, torso overlay, badge, reflection, or miniature figure attached to the foreground character.";
  const noSpeechBubbleClause = "No speech bubbles, no dialogue balloons, no captions, and no comic lettering.";
  const silentSceneClause = "Silent cinematic illustration with no speech bubbles, no captions, no dialogue lettering, and no floating words.";
  const uiPlacementClause = world === "murim"
    ? "Any supernatural system window, ledger panel, or interface is an immaterial floating black-red mystical light panel high to the left or right of the character in open air, outside the body silhouette, with a visible air gap from every hand; it must not be held, touched, gripped, pinched, carried, or placed between fingers, must not become a book, laptop, tablet, phone, monitor, physical screen, keyboard, scroll, or board, and it must use ledger glyph lines, marks, or text-like rows with rim glow, not a solid opaque square, not a censor block, and it must not overlap eyes, face, head, hands, torso, robe silhouette, or important props."
    : "Any Life Ascension System interface is an immaterial translucent blue holographic window floating high beside Joey or beside the relevant object in open air, outside every body silhouette, with a visible air gap from hands and face; it must not become a laptop, phone, monitor, physical paper, solid block, censor panel, or caption, and it must not overlap eyes, face, head, hands, torso, or important props.";
  let text = String(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "").trim();
  const hasCloseForeground = /\b(?:close[-\s]?up|face fills the foreground|foreground portrait|three[-\s]?quarter close)/i.test(text);
  const hasDistantSecondary = /\b(?:small visible figure|far below|distant figure|kneels far|kneeling far|background figure)\b/i.test(text);
  const allowsText = /\b(?:ledger|system|interface|ui|blue window|black window|document|surrender document|seal|tablet|scroll|inscription|engraving|written|characters|red characters|text)\b/i.test(text);
  if (/\b(?:label|labels|caption|captions|title card|subtitle|subtitles|large word|readable word|status word|ui word|system word)\b/i.test(text)) {
    text = text
      .replace(/\btwo simple large labels\b/gi, "two small unreadable red seal motifs")
      .replace(/\bone large label\s*:\s*[A-Z ]+\b/gi, "one unreadable red seal glyph cluster")
      .replace(/\bone large word\s*:\s*[A-Z ]+\b/gi, "one unreadable red seal glyph cluster")
      .replace(/\bone readable word\s*:\s*[A-Z ]+\b/gi, "one unreadable red seal glyph cluster")
      .replace(/\bstatus word\s*:\s*[A-Z ]+\b/gi, "unreadable red seal glyph cluster")
      .replace(/\bsimple ui word\s*:\s*[A-Z ]+\b/gi, "unreadable red seal glyph cluster")
      .replace(/\bui word\s*:\s*[A-Z ]+\b/gi, "unreadable red seal glyph cluster")
      .replace(/\bsystem word\s*:\s*[A-Z ]+\b/gi, "unreadable red seal glyph cluster")
      .replace(/\bone large label\b/gi, "one unreadable red seal glyph cluster")
      .replace(/\bone large word\b/gi, "one unreadable red seal glyph cluster")
      .replace(/\blarge label\s*:\s*[A-Z ]+\b/gi, "unreadable red seal glyph cluster")
      .replace(/\blarge word\s*:\s*[A-Z ]+\b/gi, "unreadable red seal glyph cluster")
      .replace(/\blabel\s*:\s*[A-Z ]+\b/gi, "unreadable red seal glyph cluster")
      .replace(/\bsimple large labels\b/gi, "small unreadable red seal motifs")
      .replace(/\blarge labels\b/gi, "small unreadable red seal motifs")
      .replace(/\blarge label\b/gi, "unreadable red seal glyph cluster")
      .replace(/\bclear labels\b/gi, "unreadable red seal motifs")
      .replace(/\bwritten labels\b/gi, "unreadable red seal motifs")
      .replace(/\blabels\b/gi, "unreadable red seal motifs")
      .replace(/\blabel\b/gi, "unreadable red seal motif")
      .replace(/\bcaptions\b/gi, "unreadable decorative glyph marks")
      .replace(/\bcaption\b/gi, "unreadable decorative glyph mark")
      .replace(/\btitle card\b/gi, "decorative red seal panel")
      .replace(/\bsubtitles\b/gi, "unreadable decorative glyph marks");
    text = text
      .replace(/\bno unreadable decorative glyph marks\b/gi, "no captions")
      .replace(/\bno unreadable decorative glyph mark\b/gi, "no caption")
      .replace(/\bno unreadable red seal motifs\b/gi, "no labels")
      .replace(/\bno unreadable red seal motif\b/gi, "no label");
  }
  if (/\b(?:raises three fingers|open palm held between|hand-action composition|poised palm)\b/i.test(text)) {
    text = text
      .replace(/\braises three fingers\b/gi, "raises three rigid fingers at shoulder height in a formal martial challenge gesture")
      .replace(/\bopen palm held between senior and junior positions\b/gi, "open striking palm held at chest height, fingers together, aimed toward the opponent with clear air gap between both fighters")
      .replace(/\bclose hand-action composition\b/gi, "close martial challenge composition")
      .replace(/\bpoised palm and measured distance\b/gi, "poised striking palm, clear no-contact distance, tense opposing stances");
  }
  if (/\b(?:glow|reveal|blur|streaks|energy)\b[^.]*\bbehind him\b|\bbehind him\b[^.]*\b(?:glow|reveal|blur|streaks|energy)\b/i.test(text)) {
    text = text
      .replace(/\bBehind him, Woon-hak's blue-white palm glow and black-red ledger reveal blur into streaks of moon-white light\b/gi, "Behind him, abstract blue-white palm energy and black-red ledger light form simple ribbon-like moon-white light streaks and empty glow only")
      .replace(/\bblur into streaks\b/gi, "form simple ribbon-like abstract light streaks");
    text = text
      .replace(/\bwithout forming a body or face of moon-white light\b/gi, "as moon-white light")
      .replace(/,\s*with no spectral body, no extra face, and no second portrait\b/gi, "")
      .replace(/,\s*without forming a body or face\b/gi, "");
  }
  if (/\b(?:soft reflection|reflected face|face reflected|reflection above the blade|appears in .*reflection|basin reflection|memory image forms)\b/i.test(text)) {
    text = text
      .replace(/\bsoft memory image forms in the basin reflection: young Seol-ah smiling warmly during sword-qi practice\b/gi, "soft translucent memory silhouettes of young Seol-ah and young Mu-gyeol practicing sword qi appear in open air above the basin, while the basin holds clean moonlit water highlights")
      .replace(/\ba soft memory image forms in the basin reflection: young Seol-ah smiling warmly during sword-qi practice\b/gi, "soft translucent memory silhouettes of young Seol-ah and young Mu-gyeol practicing sword qi appear in open air above the basin, while the basin holds clean moonlit water highlights")
      .replace(/\bmemory image forms in the basin reflection\b/gi, "memory silhouettes appear in open air above the basin")
      .replace(/\bforeground basin reflection\b/gi, "foreground basin with clean moonlit water highlights and memory silhouettes staged separately above it")
      .replace(/\ba soft translucent memory silhouettes\b/gi, "soft translucent memory silhouettes")
      .replace(/[^.]*\bappears in a soft reflection above the blade\.[ ]*/gi, "No reflected character face appears on or above the blade. ")
      .replace(/face reflected in the polished red ink dish beside the scroll/gi, "clean red ink dish beside the scroll with no reflected face")
      .replace(/[^.]*\bface reflected in\b[^.]*\.[ ]*/gi, "No reflected character face appears inside any prop, seal, mirror, ink dish, blade, or document. ")
      .replace(/\bsoft reflection above the blade\b/gi, "clean blade surface with no reflected face")
      .replace(/\bface reflected\b/gi, "clean reflected lantern light")
      .replace(/\breflected face\b/gi, "clean reflected lantern light");
  }
  if (/\b(?:childhood memory|young mu-gyeol|young seol-ah|young mu gyeol|young seol ah|as children)\b/i.test(text)) {
    text = text
      .replace(/\byoung Mu-gyeol moves first along the maintenance beams and reaches back toward young Seol-ah, who hesitates above banquet trays of dried persimmons below\b/gi, "two small child memory silhouettes move along the maintenance beams, one leading and one hesitating above banquet trays of dried persimmons below")
      .replace(/Primary visual focus:\s*young Mu[-\u2010-\u2015 ]gyeol and young Seol[-\u2010-\u2015 ]ah/gi, "Primary visual focus: two child memory silhouettes")
      .replace(/Primary visual focus:[^.]*young[^.;]*Seol[^.;]*/gi, "Primary visual focus: two child memory silhouettes")
      .replace(/\bsmall hands\b/gi, "small child-silhouette gestures");
  }
  text = text
    .replace(/\bfalls screaming\b/gi, "falls with mouth open in silent pain")
    .replace(/\bfalling screaming\b/gi, "falling with mouth open in silent pain")
    .replace(/\bscreams and falls\b/gi, "falls with mouth open in silent pain")
    .replace(/\bscreams as\b/gi, "recoils with mouth open in silent pain as")
    .replace(/\bscreamed as\b/gi, "recoiled with mouth open in silent pain as")
    .replace(/\bscreams\b/gi, "mouth open in silent pain")
    .replace(/\bscreamed\b/gi, "mouth open in silent pain")
    .replace(/\bscreaming across\b/gi, "sprawling in silent pain across")
    .replace(/\bscreaming\b/gi, "mouth open in silent pain")
    .replace(/\ba red-black ledger opens in front of Mu-gyeol's eyes\b/gi, "a red-black ledger light panel floats high beside Mu-gyeol's face with clear empty space around his eyes and hands")
    .replace(/\bthe red-black ledger opens in front of Mu-gyeol's eyes\b/gi, "the red-black ledger light panel floats high beside Mu-gyeol's face with clear empty space around his eyes and hands")
    .replace(/\bred-black ledger opens in front of Mu-gyeol's eyes\b/gi, "red-black ledger light panel floats high beside Mu-gyeol's face with clear empty space around his eyes and hands")
    .replace(/\bledger opens in front of Mu-gyeol's eyes\b/gi, "ledger light panel floats high beside Mu-gyeol's face with clear empty space around his eyes and hands");
  if (/\bblood drop\b/i.test(text) && /\bledger glow\b/i.test(text)) {
    text = text.replace(/\bquiet black-red ledger glow beside his hands\b/gi, "subtle red supernatural rim light reflected far behind the falling blood");
  }
  if (/\b(?:extreme close-up|tight low-angle close-up|cinematic injury insert|primary visual focus: spirit rope|blood dampens|bloodied fingers|spirit rope fibers|bound wrists raised)\b/i.test(text)) {
    text = text
      .replace(/\bas a black-red ledger panel confirms hostile restraint\b/gi, "with faint red supernatural rim light across the rope and stones")
      .replace(/\bblack-red ledger authorization panel hovering beside the flowing qi\b/gi, "faint red ledger rim light behind the flowing qi")
      .replace(/\bblack-red ledger panels reflecting on dimming rope fibers\b/gi, "faint red reflections from distant ledger light on dimming rope fibers")
      .replace(/\bred interface glow\b/gi, "faint red rim glow");
  }
  const hasUiLikeElement = /\b(?:interface|interfaces|system window|system windows|ledger panel|ledger panels|ledger choice panel|ledger choice panels|choice panel|choice panels|ledger prompt|ledger prompts|authorization panel|authorization panels|status panel|status panels|alert panel|alert panels|ledger warning page|warning page|ledger page|ledger pages|ledger glow|ledger pulses|legal seal panel|legal seal panels|proof panel|proof panels|proof seal|proof seals|debt scale|debt scales|floating page|floating pages|offense categor|black window|black windows|blue window|blue windows|square black shadow|window opened|black shadow interface|command panel|command panels)\b/i.test(text);
  if (hasUiLikeElement) {
    text = text
      .replace(/\bUI-focused full-frame composition\b/gi, "mystical floating ledger-panel composition")
      .replace(/\bA demonic ledger panel floats in front of Mu-gyeol's calm injured face\b/gi, "A demonic ledger light panel floats high beside Mu-gyeol's calm injured face with clear empty air around his head and hands")
      .replace(/\bledger panel floats in front of ([^,.;]+face)\b/gi, "ledger light panel floats high beside $1 with clear empty air around the head and hands")
      .replace(/\ba single red-black ledger prompt hovering near his shoulder like a judgment seal\b/gi, "a single red-black ledger light panel floating high beside his shoulder with clear empty air around his head and hands")
      .replace(/\bA black-red ledger choice panel hovering inches from Mu-gyeol's face\b/gi, "A black-red ledger choice light panel floating high beside Mu-gyeol's face with clear empty air around his head and hands")
      .replace(/\bas his injured hand reaches toward the glowing option\b/gi, "while his injured hand grips the wooden ladder rung away from the glowing option")
      .replace(/\ba compact black-red ledger panel beside his wrist\b/gi, "a compact black-red ledger light panel floating high beside his raised palm with clear empty air around the wrist and fingers")
      .replace(/\bledger panel beside his wrist\b/gi, "ledger light panel floating high beside his raised palm with clear empty air around the wrist and fingers")
      .replace(/\bblack floating panels\b/gi, "immaterial black-red ledger light panels floating high in open air")
      .replace(/\bThe ledger pulses red in the courtyard foreground\b/gi, "An immaterial red ledger light panel pulses high in the open courtyard air")
      .replace(/\bpulsing ledger framed between his face and the glowing banquet entrance\b/gi, "pulsing ledger light panel floating high beside the glowing banquet entrance with clear empty air around Mu-gyeol's face and hands")
      .replace(/\bred alert panels stacked beside his restrained arms\b/gi, "red alert light panels floating high away from his restrained arms")
      .replace(/\bsmall dark-red status panel glowing weakly beside his shoulder\b/gi, "small immaterial dark-red status light panel floating high beside his shoulder with clear air around every hand")
      .replace(/\bblack floating pages\b/gi, "immaterial floating black-red glyph panels")
      .replace(/\bfloating pages\b/gi, "immaterial floating glyph panels")
      .replace(/\bblack floating ledger pages\b/gi, "immaterial floating black-red mystical ledger light panels")
      .replace(/\bfloating ledger pages\b/gi, "immaterial floating mystical ledger light panels")
      .replace(/\bblack-red supernatural ledger warning page opens beside his shoulder\b/gi, "black-red immaterial ledger warning light panel floats high beside his shoulder with clear air around every hand")
      .replace(/\bledger warning page opens beside his shoulder\b/gi, "immaterial ledger warning light panel floats high beside his shoulder with clear air around every hand")
      .replace(/\bred ledger page opens wide in front of\b/gi, "wide immaterial red ledger light panel floats high beside")
      .replace(/\bledger page opens wide in front of\b/gi, "immaterial ledger light panel floats high beside")
      .replace(/\bledger interface blooms above ([^,.;]+hand[^,.;]* and [^,.;]+blade)\b/gi, "ledger interface blooms high beside $1 with a clear air gap from the hand and blade")
      .replace(/\bsupernatural ledger interface blooms above ([^,.;]+hand[^,.;]* and [^,.;]+blade)\b/gi, "supernatural ledger interface blooms high beside $1 with a clear air gap from the hand and blade")
      .replace(/\bledger panel blooms above ([^,.;]+hand[^,.;]* and [^,.;]+blade)\b/gi, "ledger light panel blooms high beside $1 with a clear air gap from the hand and blade")
      .replace(/\binterface blooms above ([^,.;]+hand[^,.;]* and [^,.;]+blade)\b/gi, "interface blooms high beside $1 with a clear air gap from the hand and blade")
      .replace(/\babove Mu-gyeol's wounded hand and awakened mother blade\b/gi, "high beside Mu-gyeol's wounded hand and awakened mother blade with a clear air gap")
      .replace(/\bred ledger page\b/gi, "red ledger light panel")
      .replace(/\bledger warning page\b/gi, "ledger warning light panel")
      .replace(/\bledger page\b/gi, "ledger light panel")
      .replace(/\bledger pages\b/gi, "mystical ledger light panels")
      .replace(/\bred legal seal panels\b/gi, "immaterial red legal seal light panels")
      .replace(/\bred legal seals\b/gi, "immaterial red legal seal light marks")
      .replace(/\bproof panels\b/gi, "immaterial proof glyph panels")
      .replace(/\bproof seals\b/gi, "floating proof-seal light marks")
      .replace(/\bdebt scales\b/gi, "floating balance-scale light icons")
      .replace(/\bledger glow beside his hands\b/gi, "faint red ledger rim light on the floor high away from his hands")
      .replace(/\bledger glow beside [^,.;]+hands\b/gi, "faint red ledger rim light in open air away from every hand")
      .replace(/\boffense categories\b/gi, "unreadable offense-category glyph bands")
      .replace(/\bdirectly before his eyes\b/gi, "floating beside his face with clear empty space")
      .replace(/\bbefore his eyes\b/gi, "beside his face with clear empty space")
      .replace(/\bledger opens in front of Mu-gyeol's eyes\b/gi, "ledger light panel floats high beside Mu-gyeol's face with clear empty space around his eyes and hands")
      .replace(/\bred-black ledger opens in front of Mu-gyeol's eyes\b/gi, "red-black ledger light panel floats high beside Mu-gyeol's face with clear empty space around his eyes and hands")
      .replace(/\ba red-black ledger opens in front of Mu-gyeol's eyes\b/gi, "a red-black ledger light panel floats high beside Mu-gyeol's face with clear empty space around his eyes and hands")
      .replace(/\bthe red-black ledger opens in front of Mu-gyeol's eyes\b/gi, "the red-black ledger light panel floats high beside Mu-gyeol's face with clear empty space around his eyes and hands")
      .replace(/\brestrained supernatural panels pulsing near his face\b/gi, "restrained supernatural light panels pulsing high beside his face with clear empty space around his eyes and hands")
      .replace(/\bsupernatural panels pulsing near his face\b/gi, "supernatural light panels pulsing high beside his face with clear empty space around his eyes and hands")
      .replace(/\bover his face\b/gi, "beside his face")
      .replace(/\bpulsing beside him\b/gi, "floating high beside him with clear empty air between the panels and every hand")
      .replace(/\bstacking offense categories and proof seals between them\b/gi, "floating high as unreadable offense-category glyph bands and proof-seal light marks in the empty air between the characters")
      .replace(/\bopens as stacked red-black command panels around\b/gi, "appears as immaterial stacked red-black mystical light panels beside")
      .replace(/\bstacked red-black command panels around\b/gi, "immaterial stacked red-black mystical light panels beside")
      .replace(/\breadable pattern\b/gi, "geometric glyph pattern")
      .replace(/\bsquare black shadow interface\b/gi, "translucent black-red mystical ledger panel with faint red glyph lines");
  }
  text = text.replace(/\bcensor panel, or unreadable decorative glyph mark\b/gi, "censor panel, or caption");
  if (/\b(?:near the patriarch|beside the patriarch|patriarch's authority)\b/i.test(text) && !/\bchar_jin_tae_sang\b/i.test(JSON.stringify(prompt.reference_requirements ?? []))) {
    text = text
      .replace(/\bnear the patriarch\b/gi, "near the highest clan seat")
      .replace(/\bbeside the patriarch\b/gi, "near the highest clan seat")
      .replace(/\bpatriarch's authority\b/gi, "highest clan authority");
  }
  if (!/\bchar_envoy_do_hyun\b/i.test(JSON.stringify(prompt.reference_requirements ?? []))) {
    text = text
      .replace(/\bEnvoy Do\b/gi, "a composed Murim Alliance envoy silhouette")
      .replace(/\bEnvoy Do Hyun\b/gi, "a composed Murim Alliance envoy silhouette")
      .replace(/\bDo Hyun\b/gi, "the composed alliance envoy silhouette");
  }
  if (!/\bchar_jin_tae_sang\b/i.test(JSON.stringify(prompt.reference_requirements ?? []))) {
    text = text
      .replace(/\bthe patriarch\b/gi, "the highest clan-seat figure")
      .replace(/\bThe patriarch\b/gi, "The highest clan-seat figure")
      .replace(/\bpatriarch\b/gi, "highest clan-seat figure");
  }
  const hasPhysicalRestraint = /\b(?:bound wrists|bound hands|spirit rope|restrained arms|restrained wrists|restrained hands|physical bindings?|tied up|tied wrists|rope around|rope binds|rope tightens)\b/i.test(text);
  if (hasPhysicalRestraint && hasUiLikeElement && !/bound hands remain visibly empty/i.test(text)) {
    text += " Bound hands remain visibly empty and physically separate from every floating ledger panel.";
  }
  if (hasPhysicalRestraint && hasUiLikeElement && !/hands stay low near/i.test(text)) {
    text += " Bound hands stay low near the lap or waist with palms away from the panels.";
  }
  if (/\bholographic ledger alert shimmer nearby\b/i.test(text) && /\b(?:surrender document|blood seal|ritual brush|altar)\b/i.test(text)) {
    text = text.replace(/\bclean holographic ledger alert shimmer nearby\b/gi, "red seal glow rippling across the paper and brush water");
  }
  if (/\bseol-ah\b/i.test(text) && /\bpatriarch\b/i.test(text) && /\belder jin baek\b/i.test(text) && !/two older male figures are staged as distinct people/i.test(text)) {
    text += " Two older male figures are staged as distinct people: the patriarch occupies the highest clan-seat side in blue-and-gold authority robes, while Elder Jin Baek stands separately near the altar with a cane or iron staff.";
  }
  if (hasCloseForeground && hasDistantSecondary) {
    text = text
      .replace(/\b(?:as a )?small visible figure\b/gi, "as a separate distant full-body figure on the floor plane")
      .replace(/\bkneels far below the steps\b/gi, "kneels on the floor below the steps with clear empty space separating him from the foreground subject")
      .replace(/\bfar below the steps\b/gi, "on the floor below the steps with clear empty space separating the figures");
  }
  const additions = [];
  if (!/bright vibrant modern anime|clean dark korean murim manhwa|crisp inked linework|webtoon illustration/i.test(text)) additions.push(styleClause);
  if (characterCount >= 2 && !/separate complete bod|distinct face placement|readable (?:robe|modern clothing) boundaries/i.test(text)) additions.push(stagingClause);
  if (characterCount >= 1 && !/exactly one person for each named character|do not duplicate any referenced character/i.test(text)) additions.push(exactCharacterClause);
  if (characterCount >= 2 && hasCloseForeground && hasDistantSecondary && !/portrait insert|torso overlay|miniature figure attached/i.test(text)) additions.push(distantSecondaryClause);
  if (!/no speech bubbles|no dialogue balloons|no comic lettering/i.test(text)) additions.push(noSpeechBubbleClause);
  if (hasUiLikeElement && !/Life Ascension System interface is an immaterial|must not become a book, laptop, tablet, phone, monitor, physical screen, keyboard/i.test(text)) additions.push(uiPlacementClause);
  if (!allowsText && !/no speech bubbles|no dialogue lettering|no floating words/i.test(text)) additions.push(silentSceneClause);
  if (additions.length) text = `${text} ${additions.join(" ")}`.trim();
  return text;
}

function hardenPrompt(prompt, indexes) {
  return sanitizePrompt(prompt, indexes);
}

function sanitizePositiveVisualPrompt(value) {
  return String(value ?? "")
    .replace(/\bno[-\s]?contact\b/gi, "contact-silence")
    .replace(/\bdo\s+not\s+self[-\s]?deprecate\b/gi, "self-respect response")
    .replace(/\bdo\s+not\s+beg\b/gi, "stand firm")
    .replace(/\bdo\s+not\s+call\b/gi, "call restraint")
    .replace(/\bdo\s+not\s+text\b/gi, "message restraint")
    .replace(/\bdo\s+not\s+return upstairs\b/gi, "upstairs restraint")
    .replace(/\bdo\s+not\s+return\b/gi, "return restraint")
    .replace(/\bnot\s+call\b/gi, "call restraint")
    .replace(/\bnot\s+text\b/gi, "message restraint")
    .replace(/\bnot\s+return\b/gi, "return restraint")
    .replace(/\bnot\s+beg\b/gi, "stand firm")
    .replace(/\bnot\s+self[-\s]?deprecate\b/gi, "self-respect response")
    .replace(/\bnot\s+performing\s+for\s+her\b/gi, "self-contained composure")
    .replace(/\bnot\s+performing\b/gi, "self-contained composure")
    .replace(/\bnot\s+chasing\b/gi, "controlled distance")
    .replace(/\bnot\s+confident\s+yet\b/gi, "cautiously building confidence")
    .replace(/\bwithout\s+performing\s+for\s+her\b/gi, "with self-contained composure")
    .replace(/\bwithout\s+performing\b/gi, "with self-contained composure")
    .replace(/\bwithout\s+chasing\b/gi, "with controlled distance")
    .replace(/\bno\s+rain[-\s]?night\s+grime\b/gi, "cleaner than the rain-night version")
    .replace(/\bno\s+rain[-\s]?soaked\s+jacket\b/gi, "clean dry simple clothing")
    .replace(/\bno\s+food\s+stains\b/gi, "clean unstained clothing")
    .replace(/\binstead\s+of\b/gi, "with")
    .replace(/\brather\s+than\b/gi, "with")
    .replace(/\bnegative\s+prompt\b/gi, "visual prompt")
    .replace(/--no\b/gi, "")
    .replace(/\bdo\s+not\b/gi, "show restraint")
    .replace(/\bdon't\b/gi, "show restraint")
    .replace(/\bwithout\b/gi, "with")
    .replace(/\bavoid\b/gi, "favor")
    .replace(/\bexclude\b/gi, "favor")
    .replace(/\bnot\b/gi, "restrained")
    .replace(/\bno\b/gi, "clean")
    .replace(/\s+/g, " ")
    .trim();
}

function manifestNameSet(values) {
  return new Set((Array.isArray(values) ? values : []).map(normalize).filter(Boolean));
}

function characterRefNameMatches(ref, names) {
  const labels = [
    ref?.character,
    ref?.subject,
    ...(ref ? characterAliases(ref) : []),
  ].map(normalize).filter(Boolean);
  return labels.some((label) => names.has(label) || [...names].some((name) => label.includes(name) || name.includes(label)));
}

function targetReferencePath(target) {
  return target?.reference_image_path ?? target?.required_reference_path ?? target?.path ?? null;
}

function sanitizeRequirementFromRefId(refId, indexes, base = {}) {
  refId = indexes.refIdByStateId?.get(refId) ?? refId;
  const target = indexes.referenceById.get(refId);
  if (!target) return null;
  const rawKind = String(base.kind ?? target.kind ?? "").toLowerCase();
  const isCharacter = rawKind.includes("character");
  const baseIdentityRefId = target.base_identity_ref_id ?? target.base_identity_ref ?? null;
  const faceOnly = isCharacter && String(target.identity_usage ?? "").toLowerCase() === "face_only" && baseIdentityRefId;
  const selectedRefId = faceOnly ? baseIdentityRefId : refId;
  const selectedTarget = indexes.referenceById.get(selectedRefId) ?? target;
  const kind = isCharacter ? "character_state" : (base.kind ?? target.kind ?? "source_anchor");
  const subject = target.character ?? target.subject ?? refId;
  return {
    ...base,
    ref_id: selectedRefId,
    kind,
    required: base.required !== false,
    slot_order: Number(base.slot_order ?? 50),
    slot_purpose: base.slot_purpose ?? (
      isCharacter
        ? (faceOnly ? `face-only identity anchor for ${subject}` : `character identity and wardrobe for ${subject}`)
        : `${kind} reference for ${target.subject ?? selectedRefId}`
    ),
    reason: base.reason ?? "Sanitizer: LLM-selected or manifest-required reference validated against approved reference ledger.",
    source_state_ref_id: faceOnly ? refId : base.source_state_ref_id,
    identity_usage: faceOnly ? "face_only" : base.identity_usage,
    state_contract: faceOnly ? (target.scene_prompt_anchor ?? target.prompt_anchor ?? "") : base.state_contract,
    reference_image_path: targetReferencePath(selectedTarget),
  };
}

function refSelectionIds(req) {
  return [req?.ref_id, req?.source_state_ref_id].filter(Boolean).map(String);
}

function looksLikePhysicalLocation(prompt, promptTextValue) {
  const text = [
    prompt.location,
    prompt.shot_manifest?.foreground_action,
    promptTextValue,
  ].filter(Boolean).join(" ");
  return /\b(?:apartment|kitchen|bedroom|bathroom|gym|treadmill|office|workplace|cubicle|support desk|street|sidewalk|lobby|elevator|coffee shop|courthouse|corridor|boardroom|conference|stage|hotel|tower|clinic|dental|warehouse|room|table)\b/i.test(text);
}

function applyNamedCharacterMultiplicityContract(text, shotManifest) {
  const value = String(text ?? "").trim();
  const shotJob = String(shotManifest?.shot_job ?? "");
  const explicitSplitPanel = /\b(?:split[- ]panel|comic[- ]panel|manga panel|multi[- ]panel|panel grid)\b/i.test(`${shotJob} ${value}`);
  const baseClause = "Show exactly one visible body for each named character in this cut; do not duplicate any named character as extra bodies, back views, reflections, portraits, inset heads, miniature figures, or alternate poses.";
  const montageClause = explicitSplitPanel
    ? "Because this is an explicit split-panel composition, keep each panel clean and do not duplicate the same named character within any single panel."
    : "For memory, flashback, collage, montage, retrospective, or overlapping-vignette beats, the named character appears only once in the main composition; surrounding vignettes must contain only props, lighting, anonymous silhouettes, screens, environment fragments, hands, food, phones, bags, receipts, and city details, never the named character again.";
  const clauses = [baseClause, montageClause].filter((clause) => !value.includes(clause));
  return [value, ...clauses].join(" ").replace(/\s+/g, " ").trim();
}

function sanitizeModelSafeBeautyLanguage(text) {
  return String(text ?? "")
    .replace(/\bbreathtaking\s+adult\s+campus\s+goddess\b/gi, "striking high-status campus woman")
    .replace(/\bbreathtaking\s+adult\s+woman\b/gi, "striking elegant adult woman")
    .replace(/\bcampus\s+goddess\b/gi, "high-status campus woman")
    .replace(/\bgoddess\s+state\b/gi, "high-status campus state")
    .replace(/\bgoddess\s+formal\s+styling\b/gi, "polished ceremony styling")
    .replace(/\bformal\s+dress\b/gi, "modest formal outfit")
    .replace(/\bthrone\s+lineup\b/gi, "ceremonial seating lineup")
    .replace(/\bmain\s+throne\b/gi, "central ceremonial chair")
    .replace(/\bthrone\s+arrangement\b/gi, "ceremonial seating arrangement")
    .replace(/\bleans\s+closer\s+across\b/gi, "sits forward at")
    .replace(/\bleans\s+closer\b/gi, "sits forward")
    .replace(/\bnarrow\s+gap\b/gi, "desk space")
    .replace(/\blong\s+black\s+hair\s+falling\s+forward\b/gi, "long black hair neatly styled")
    .replace(/\bblack\s+skirt\b/gi, "modest dark uniform skirt")
    .replace(/\bhot\b/gi, "striking")
    .replace(/\bsexy\b/gi, "glamorous")
    .replace(/\bseductive\b/gi, "confident")
    .replace(/\bsensual\b/gi, "elegant")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizePrompt(prompt, indexes) {
  const findings = [];
  const shotManifest = sanitizeShotManifest(prompt.shot_manifest);
  const forbiddenRefs = new Set((shotManifest?.forbidden_ref_ids ?? []).map(String));
  const mentionedOnly = manifestNameSet(shotManifest?.mentioned_only_characters);
  const visibleNames = manifestNameSet(shotManifest?.visible_characters);
  const requestedLocationRefId = shotManifest?.location_ref_id ? String(shotManifest.location_ref_id) : null;
  const requestedCharacterRefIds = (shotManifest?.character_state_ref_ids ?? []).map((refId) => indexes.refIdByStateId?.get(String(refId)) ?? String(refId));
  if (shotManifest) {
    shotManifest.character_state_ref_ids = requestedCharacterRefIds;
    if (shotManifest.protagonist_state_ref_id) {
      shotManifest.protagonist_state_ref_id = indexes.refIdByStateId?.get(String(shotManifest.protagonist_state_ref_id)) ?? String(shotManifest.protagonist_state_ref_id);
    }
  }
  let promptTextValue = trackedMutation(
    "sanitizePositiveVisualPrompt",
    prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "",
    (value) => sanitizePositiveVisualPrompt(value),
    { prompt }
  );
  promptTextValue = trackedMutation("sanitizeModelSafeBeautyLanguage", promptTextValue, (value) => sanitizeModelSafeBeautyLanguage(value), { prompt });
  promptTextValue = trackedValueMutation(
    "applyNamedCharacterMultiplicityContract",
    promptTextValue,
    applyNamedCharacterMultiplicityContract(promptTextValue, shotManifest),
    { prompt }
  );
  let codexPromptTextValue = prompt.codex_image_prompt
    ? trackedMutation("sanitizePositiveVisualPrompt", prompt.codex_image_prompt, (value) => sanitizePositiveVisualPrompt(value), { prompt })
    : null;
  if (codexPromptTextValue) {
    codexPromptTextValue = trackedMutation("sanitizeModelSafeBeautyLanguage", codexPromptTextValue, (value) => sanitizeModelSafeBeautyLanguage(value), { prompt });
    codexPromptTextValue = trackedValueMutation(
      "applyNamedCharacterMultiplicityContract",
      codexPromptTextValue,
      applyNamedCharacterMultiplicityContract(codexPromptTextValue, shotManifest),
      { prompt }
    );
  }

  const inputRequirements = Array.isArray(prompt.reference_requirements) ? prompt.reference_requirements : [];
  const accepted = [];
  for (const req of inputRequirements) {
    if (!req?.ref_id) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "reference_missing_ref_id",
        message: "A reference requirement is missing ref_id.",
        resolved: false,
      });
      continue;
    }
    const rawRefId = String(req.ref_id);
    const target = indexes.referenceById.get(rawRefId);
    if (!target) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "unknown_reference_id",
        message: `Reference id ${rawRefId} is not present in approved reference artifacts.`,
        resolved: false,
      });
      continue;
    }
    if (forbiddenRefs.has(rawRefId)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "shot_manifest_forbidden_ref_stripped",
        message: `Shot manifest forbade ref stripped before imagegen: ${rawRefId}.`,
        resolved: true,
      });
      continue;
    }
    const canonical = sanitizeRequirementFromRefId(rawRefId, indexes, req);
    const selectedIds = refSelectionIds(canonical);
    if (selectedIds.some((id) => forbiddenRefs.has(id))) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "shot_manifest_forbidden_ref_stripped",
        message: `Shot manifest forbade ref stripped before imagegen: ${selectedIds.find((id) => forbiddenRefs.has(id))}.`,
        resolved: true,
      });
      continue;
    }
    const canonicalTarget = indexes.referenceById.get(canonical.source_state_ref_id ?? canonical.ref_id) ?? target;
    if (referenceKindRank(canonical.kind) === 0 && mentionedOnly.size && characterRefNameMatches(canonicalTarget, mentionedOnly) && !characterRefNameMatches(canonicalTarget, visibleNames)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "mentioned_only_character_ref_stripped",
        message: `Character ref ${rawRefId} was stripped because the shot manifest marks that character as mentioned-only.`,
        resolved: true,
      });
      continue;
    }
    accepted.push(canonical);
  }

  for (const refId of requestedCharacterRefIds) {
    if (accepted.some((req) => refSelectionIds(req).includes(refId))) continue;
    if (forbiddenRefs.has(refId)) continue;
    const canonical = sanitizeRequirementFromRefId(refId, indexes, {
      kind: "character_state",
      required: true,
      reason: "Sanitizer: character ref required by LLM shot_manifest.",
    });
    if (canonical) {
      accepted.push(canonical);
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "manifest_character_ref_added",
        message: `Added character ref ${refId} because it was declared in shot_manifest.character_state_ref_ids.`,
        resolved: true,
      });
    } else {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "unknown_manifest_character_ref",
        message: `Shot manifest requested unknown character ref ${refId}.`,
        resolved: false,
      });
    }
  }

  if (requestedLocationRefId) {
    const locationReqs = accepted.filter((req) => referenceKindRank(req.kind) === 1);
    const mismatched = locationReqs.filter((req) => req.ref_id !== requestedLocationRefId);
    if (mismatched.length) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "manifest_location_ref_replaced",
        message: `Replaced location refs ${mismatched.map((req) => req.ref_id).join(", ")} with manifest location ${requestedLocationRefId}.`,
        resolved: true,
      });
      for (const req of mismatched) accepted.splice(accepted.indexOf(req), 1);
    }
    if (!accepted.some((req) => req.ref_id === requestedLocationRefId)) {
      const canonical = sanitizeRequirementFromRefId(requestedLocationRefId, indexes, {
        kind: "location",
        required: true,
        reason: "Sanitizer: location ref required by LLM shot_manifest.",
      });
      if (canonical) {
        accepted.push(canonical);
        findings.push({
          image_id: prompt.image_id,
          scene_id: prompt.scene_id,
          severity: "warning",
          code: "manifest_location_ref_added",
          message: `Added location ref ${requestedLocationRefId} because it was declared in shot_manifest.location_ref_id.`,
          resolved: true,
        });
      } else {
        findings.push({
          image_id: prompt.image_id,
          scene_id: prompt.scene_id,
          severity: "blocker",
          code: "unknown_manifest_location_ref",
          message: `Shot manifest requested unknown location ref ${requestedLocationRefId}.`,
          resolved: false,
        });
      }
    }
  }

  const deduped = dedupeRequirements(accepted);
  const protectedRefIds = [
    shotManifest?.protagonist_state_ref_id,
    requestedLocationRefId,
  ].filter(Boolean);
  const selectedRequirements = trimRequirements(deduped, { protectedRefIds });
  if (deduped.length > selectedRequirements.length) {
    const selectedIds = new Set(selectedRequirements.map((req) => req.ref_id));
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "warning",
      code: "reference_limit_trimmed",
      message: `Trimmed refs to max ${maxRefs}: ${deduped.filter((req) => !selectedIds.has(req.ref_id)).map((req) => req.ref_id).join(", ")}.`,
      resolved: true,
    });
  }

  const selectedIds = new Set(selectedRequirements.flatMap(refSelectionIds));
  const selectedAtRefLimit = deduped.length > selectedRequirements.length;
  const locationPreservedForRefLimit = requestedLocationRefId && selectedRequirements.some((req) => req.ref_id === requestedLocationRefId);
  const protectedCharacterRefIds = new Set([shotManifest?.protagonist_state_ref_id].filter(Boolean).map(String));
  for (const refId of requestedCharacterRefIds) {
    if (!selectedIds.has(refId)) {
      if (selectedAtRefLimit && locationPreservedForRefLimit && !protectedCharacterRefIds.has(refId)) {
        findings.push({
          image_id: prompt.image_id,
          scene_id: prompt.scene_id,
          severity: "warning",
          code: "manifest_character_ref_dropped_for_location_ref_limit",
          message: `Shot manifest expected character ref ${refId}, but it was dropped to preserve manifest location ${requestedLocationRefId} within the max ${maxRefs} reference limit.`,
          resolved: true,
        });
        continue;
      }
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "manifest_character_ref_missing_after_sanitize",
        message: `Shot manifest expected character ref ${refId}, but it is not selected after sanitation.`,
        resolved: false,
      });
    }
  }
  if (requestedLocationRefId && !selectedRequirements.some((req) => req.ref_id === requestedLocationRefId)) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "blocker",
      code: "manifest_location_ref_missing_after_sanitize",
      message: `Shot manifest expected location ref ${requestedLocationRefId}, but it is not selected after sanitation.`,
      resolved: false,
    });
  }
  if (!requestedLocationRefId
    && !selectedRequirements.some((req) => referenceKindRank(req.kind) === 1)
    && looksLikePhysicalLocation(prompt, promptTextValue)) {
    const inScopeLocationRefs = indexes.locationTargets.filter((target) => sceneIdsCover(target.scene_ids, prompt.scene_id));
    const hasInScopeLocationRef = inScopeLocationRefs.length > 0;
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: hasInScopeLocationRef ? "blocker" : "warning",
      code: "physical_location_ref_missing",
      message: hasInScopeLocationRef
        ? `Prompt describes a real physical environment, but the LLM did not set shot_manifest.location_ref_id or attach an in-scope location ref. Available in-scope location refs: ${inScopeLocationRefs.map((target) => target.ref_id).join(", ")}.`
        : "Prompt describes a real physical environment, but no approved in-scope location ref exists; proceeding with concrete generic location staging.",
      resolved: !hasInScopeLocationRef,
    });
  }
  for (const refId of forbiddenRefs) {
    if (selectedIds.has(refId)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "shot_manifest_forbidden_ref_attached",
        message: `Shot manifest forbids ref ${refId}, but it is still selected after sanitation.`,
        resolved: false,
      });
    }
  }
  const selectedLocationRefId = requestedLocationRefId ?? selectedRequirements.find((req) => referenceKindRank(req.kind) === 1)?.ref_id ?? null;
  for (const mention of outOfScopeLocationRefMentions({
    text: [promptTextValue, codexPromptTextValue].filter(Boolean).join(" "),
    locationTargets: indexes.locationTargets,
    allowedLocationRefId: selectedLocationRefId,
  })) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "blocker",
      code: mention.code,
      message: mention.message,
      ref_id: mention.ref_id,
      resolved: false,
    });
  }

  return {
    prompt: {
      ...prompt,
      image_prompt: promptTextValue,
      modelslab_image_prompt: promptTextValue,
      codex_image_prompt: codexPromptTextValue,
      prompt_hash: sha256(promptTextValue),
      reference_requirements: selectedRequirements,
      required_reference_paths: selectedRequirements.map((req) => req.reference_image_path).filter(Boolean),
      reference_usage: selectedRequirements.map((req) => ({
        ref_id: req.ref_id,
        usage: "attach_existing_ref",
        reason: req.reason ?? "Sanitizer: validated LLM-authored reference selection.",
      })),
      shot_manifest: shotManifest,
      hardening_notes: [
        ...(prompt.hardening_notes ?? []),
        "visual-prompt-harden sanitize mode: validated LLM-authored refs, normalized approved ref IDs, stripped forbidden refs, enforced max ref count; no creative prompt rewrite.",
      ],
    },
    findings,
  };
}

function selectSamples(prompts) {
  const selected = [];
  const seen = new Set();
  const add = (prompt, reason) => {
    if (!prompt || seen.has(prompt.image_id) || selected.length >= sampleCount) return;
    seen.add(prompt.image_id);
    selected.push({ image_id: prompt.image_id, reason });
  };
  const find = (predicate) => prompts.find((prompt) => !seen.has(prompt.image_id) && predicate(prompt));
  add(prompts[0], "first cut hook");
  add(find((p) => (p.reference_requirements ?? []).some((r) => String(r.kind).includes("location"))), "location-anchor cut");
  add(find((p) => /white[-\s]bearded elder|elder jin baek|elder lifts|elder gestures/i.test(promptText(p))), "elder alias cut");
  add(find((p) => /patriarch|jin tae sang/i.test(promptText(p))), "patriarch alias cut");
  add(find((p) => /deputy envoy|murim alliance envoy|envoy do hyun/i.test(promptText(p))), "envoy alias cut");
  add(find((p) => (p.reference_requirements ?? []).filter((r) => String(r.kind).includes("character")).length >= 3), "crowded multi-character identity cut");
  add(find((p) => (p.reference_requirements ?? []).filter((r) => String(r.kind).includes("character")).length >= 2), "multi-character identity cut");
  add(find((p) => /strike|palm|blood|sword|attack|duel|impact|break|counter|qi|dantian/i.test(promptText(p))), "action/combat cut");
  add(find((p) => /ledger|window|system|ui|text|screen|seal|document|token|jade|rope/i.test(promptText(p))), "UI/prop/document cut");
  add(find((p) => Number(String(p.image_id ?? "").match(/cut-(\d+)/)?.[1] ?? 0) > 300), "late-episode continuity cut");
  const byLocation = new Set();
  for (const prompt of prompts) {
    const loc = normalize(prompt.location);
    if (loc && !byLocation.has(loc)) {
      byLocation.add(loc);
      add(prompt, `first location block: ${prompt.location}`);
    }
  }
  for (const prompt of prompts) add(prompt, "coverage fill");
  return selected;
}

function sampleMarkdown(prompts, sampleRows, report) {
  const byId = new Map(prompts.map((prompt) => [prompt.image_id, prompt]));
  const title = "Visual Prompt Sanitation Sample";
  const lines = [
    `# ${title}`,
    "",
    `Status: ${report.status}`,
    `Mode: ${report.harden_mode ?? "sanitize"}`,
    `Prompt count: ${prompts.length}`,
    `Unresolved blockers: ${report.unresolved_blocker_count}`,
    "",
  ];
  for (const row of sampleRows) {
    const prompt = byId.get(row.image_id);
    if (!prompt) continue;
    lines.push(`## ${prompt.image_id}`);
    lines.push("");
    lines.push(`Reason: ${row.reason}`);
    lines.push(`Scene: ${prompt.scene_id}`);
    lines.push(`Location: ${prompt.location ?? ""}`);
    lines.push(`Subjects: ${(prompt.visible_subjects ?? []).join(", ")}`);
    lines.push("");
    lines.push("References:");
    for (const req of prompt.reference_requirements ?? []) {
      lines.push(`- ${req.slot_order}. ${req.kind}:${req.ref_id} - ${req.slot_purpose}`);
    }
    if (!(prompt.reference_requirements ?? []).length) lines.push("- none");
    lines.push("");
    lines.push("Prompt:");
    lines.push("");
    lines.push(prompt.modelslab_image_prompt ?? prompt.image_prompt ?? "");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const [promptPlan, timedPlan, visualReferencePlan, characterStateRefs] = await Promise.all([
    readJson(promptPath, null),
    readJson(timedPlanPath, null),
    readJson(visualReferencePlanPath, null),
    readJson(characterStateRefsPath, null),
  ]);
  if (!Array.isArray(promptPlan?.prompts) || !promptPlan.prompts.length) throw new Error(`Missing prompt plan: ${promptPath}`);
  if (timedPlan?.status !== "passed") throw new Error(`Missing passed timed scene plan: ${timedPlanPath}`);
  if (visualReferencePlan?.status !== "passed") throw new Error(`Missing passed visual reference plan: ${visualReferencePlanPath}`);
  if (!["approved", "passed"].includes(characterStateRefs?.status) && flags["allow-draft-refs"] !== "true") {
    throw new Error(`character_state_refs must be approved before prompt hardening. Current status: ${characterStateRefs?.status ?? "missing"}.`);
  }
  const indexes = buildIndexes(visualReferencePlan, characterStateRefs);
  const prompts = [];
  const findings = [];
  for (const prompt of promptPlan.prompts) {
    const result = sanitizePrompt(prompt, indexes);
    prompts.push(result.prompt);
    findings.push(...result.findings);
  }
  const unresolvedBlockers = findings.filter((finding) => finding.severity === "blocker" && finding.resolved !== true);
  const status = unresolvedBlockers.length ? "blocked" : "passed";
  const sourcePaths = [promptPath, timedPlanPath, visualReferencePlanPath, characterStateRefsPath];
  const sourceHashes = Object.fromEntries((await Promise.all(sourcePaths.map(async (filePath) => [filePath, await hashFile(filePath)]))).filter(([, hash]) => hash));
  const sampleRows = selectSamples(prompts);
  const report = {
    schema: "goldflow_visual_prompt_hardening_v1",
    status,
    channel,
    series_slug: series,
    week,
    episode,
    source_script_hash: promptPlan.source_script_hash,
    source_artifact_paths: sourcePaths,
    source_hashes: sourceHashes,
    input_prompt_count: promptPlan.prompts.length,
    hardened_prompt_count: prompts.length,
    harden_mode: effectiveHardenMode,
    sample_prompt_count: sampleRows.length,
    sample_prompt_ids: sampleRows,
    findings,
    unresolved_blocker_count: unresolvedBlockers.length,
    hardened_prompt_plan_path: outputPath,
    sample_review_path: samplePath,
    updated_at: new Date().toISOString(),
  };
  const hardenedPlan = {
    ...promptPlan,
    status,
    source_artifact_paths: sourcePaths,
    source_hashes: sourceHashes,
    prompt_policy: "LLM-authored prompts with deterministic sanitation only: approved ref ID/path validation, forbidden-ref stripping, manifest enforcement, and max-reference trimming",
    prompts,
    visual_prompt_hardening_report_path: reportPath,
    visual_prompt_hardening_sample_path: samplePath,
    updated_at: report.updated_at,
  };
  await writeJson(outputPath, hardenedPlan);
  await writeJson(reportPath, report);
  if (mutationTrackingEnabled) {
    await writeJson(mutationHitsOutputPath, {
      schema: "goldflow_visual_prompt_hardening_mutation_hits_v1",
      status,
      channel,
      series_slug: series,
      week,
      episode,
      harden_mode: effectiveHardenMode,
      prompt_path: promptPath,
      prompt_count: prompts.length,
      functions: [...mutationStats.values()].sort((a, b) => b.changed_count - a.changed_count || b.matched_count - a.matched_count || a.function_name.localeCompare(b.function_name)),
      updated_at: report.updated_at,
    });
  }
  await fs.mkdir(path.dirname(samplePath), { recursive: true });
  await fs.writeFile(samplePath, sampleMarkdown(prompts, sampleRows, report), "utf8");
  console.log(JSON.stringify({ status, output_path: outputPath, report_path: reportPath, sample_path: samplePath, prompt_count: prompts.length, sample_prompt_count: sampleRows.length, unresolved_blocker_count: unresolvedBlockers.length }, null, 2));
  if (status !== "passed") process.exitCode = 1;
}

main().catch(async (error) => {
  const failed = { schema: "goldflow_visual_prompt_hardening_v1", status: "failed", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() };
  await writeJson(reportPath, failed).catch(() => {});
  console.error(failed.error);
  process.exitCode = 1;
});
