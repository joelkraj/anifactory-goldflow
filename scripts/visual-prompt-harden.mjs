#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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
const sampleCount = Math.max(1, Number(flags["sample-count"] ?? 12));
const maxRefs = Math.max(1, Math.min(4, Number(flags["max-scene-references"] ?? 4)));

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

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
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
  };
}

function promptText(prompt) {
  return [
    prompt.modelslab_image_prompt,
    prompt.image_prompt,
    prompt.primary_subject,
    prompt.location,
    ...(Array.isArray(prompt.visible_subjects) ? prompt.visible_subjects : []),
    prompt.visual_beat_action,
    prompt.visual_beat_script_excerpt,
  ].filter(Boolean).join(" | ");
}

function promptWorld(prompt) {
  const text = promptText(prompt);
  if (/\b(?:joey|preston blackwell|blackwell solutions|mercer systems|vivian mercer|life ascension system|smiling oaks|mara klein)\b/i.test(text)) return "modern_system";
  if (/\b(?:mu[-\s]?gyeol|murim|dantian|heavenly demon|azure sky jin clan|seol[-\s]?ah|jin tae[-\s]?sang)\b/i.test(text)) return "murim";
  if (/\bjoey|blackwell|mercer\b/i.test(series)) return "modern_system";
  return "modern_system";
}

function characterMatchText(prompt) {
  return [
    prompt.modelslab_image_prompt,
    prompt.image_prompt,
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
  for (const ref of characterRefs) referenceById.set(sourceRefId(ref), { ...ref, kind: "character_state", ref_id: sourceRefId(ref), subject: ref.character });
  const locationTargets = referenceTargets.filter((target) => String(target.kind ?? "") === "location");
  return { referenceById, characterRefs, locationTargets };
}

const genericLocationContracts = [
  {
    id: "support_office",
    preferredRefId: "support_office_ref",
    label: "DEAD-END CUSTOMER SUPPORT OFFICE",
    patterns: [/\bsupport job\b/i, /\bcustomer support\b/i, /\bheadset\b/i, /\bunresolved support tickets?\b/i, /\bsupport tickets?\b/i, /\bmanager\b/i, /\bDarren\b/i],
    targetPatterns: [/\bsupport\b/i, /\bcall[-\s]?center\b/i, /\bcustomer support\b/i, /\bheadset stations?\b/i],
    requiredClause: "Visible location: dead-end customer support office with cubicle rows, headset stations, ticket queue monitors, fluorescent ceiling lights, coworkers at desks, plastic office chairs, and workplace paperwork.",
    forbiddenClause: "Location guardrail: every visible environmental cue reinforces a customer support workplace: cubicle rows, headset stations, ticket monitors, office chairs, and coworker desk rows.",
  },
  {
    id: "apartment",
    preferredRefId: "joey_apartment_ref",
    label: "MODEST APARTMENT",
    patterns: [/\bapartment\b/i, /\bkitchen table\b/i, /\bkitchen\b/i, /\bfridge\b/i, /\brefrigerator\b/i, /\bbedroom\b/i, /\bcloset\b/i, /\bhome\b/i, /\bproperty division\b/i, /\bcredit cards?\b/i, /\bmedical bill\b/i, /\bcar loan\b/i, /\bcomfort loop\b/i, /\bjunk food\b/i, /\bpizza\b/i, /\bsoda\b/i, /\bchips\b/i, /\bcookies\b/i, /\bfrozen meals?\b/i, /\bcheesecake\b/i, /\bold sneakers?\b/i, /\bside of the bed\b/i],
    targetPatterns: [/\bapartment\b/i, /\bmodest apartment\b/i, /\bkitchen\b/i, /\bhome\b/i],
    requiredClause: "Visible location: modest apartment with domestic kitchen or bedroom details, basic table, cheap chair, lived-in personal clutter, bills or personal belongings where relevant, and lonely residential lighting.",
    forbiddenClause: "Location guardrail: every visible environmental cue reinforces a modest home interior: domestic table, personal clutter, household lighting, and lived-in residential details.",
  },
  {
    id: "gym",
    preferredRefId: "twenty_four_hour_gym_ref",
    label: "TWENTY FOUR HOUR GYM",
    patterns: [/\bgym\b/i, /\btreadmill\b/i, /\bdumbbell\b/i, /\bworkout\b/i, /\bpull-ups?\b/i, /\btraining\b/i, /\bincline\b/i, /\bgrabbed the rails\b/i, /\blower back\b/i, /\bsweat poured\b/i],
    targetPatterns: [/\bgym\b/i, /\btreadmill\b/i, /\bdumbbell\b/i],
    requiredClause: "Visible location: twenty four hour gym with treadmill row, dumbbell rack, mirror wall, rubber floor, practical machines, and fluorescent early-morning lighting.",
    forbiddenClause: "Location guardrail: every visible environmental cue reinforces a fitness center: machines, mirrors, rubber floor, dumbbells, and treadmill rows.",
  },
  {
    id: "dental_office",
    preferredRefId: "dental_office_ref",
    label: "DENTAL PRACTICE OFFICE",
    patterns: [/\bdental\b/i, /\bdentist\b/i, /\bSmiling Oaks\b/i, /\bpatient\b/i, /\bMara\b/i],
    targetPatterns: [/\bdental\b/i, /\bdentist\b/i, /\bpractice\b/i, /\bpatient\b/i],
    requiredClause: "Visible location: dental practice office with reception counter, appointment calendar monitor, patient chairs, dental posters, organized front-desk paperwork, and clean clinical lighting.",
    forbiddenClause: "Location guardrail: every visible environmental cue reinforces a dental practice: reception counter, patient seating, dental posters, appointment screens, and clean clinical lighting.",
  },
  {
    id: "summit",
    preferredRefId: "northbridge_summit_ref",
    label: "SMALL BUSINESS SUMMIT",
    patterns: [/\bsummit\b/i, /\bstage\b/i, /\baudience\b/i, /\bspeaker\b/i, /\bpresentation\b/i, /\bfront row\b/i],
    targetPatterns: [/\bsummit\b/i, /\bconference\b/i, /\bstage\b/i, /\baudience\b/i],
    requiredClause: "Visible location: hotel conference-room small business summit with low stage, projection screen, seated audience rows, podium or presentation area, warm ceiling lights, and event atmosphere.",
    forbiddenClause: "Location guardrail: every visible environmental cue reinforces a public conference venue: stage, audience rows, podium, projection screen, and event lighting.",
  },
  {
    id: "vending_route",
    preferredRefId: "vending_route_ref",
    label: "VENDING ROUTE LOCATION",
    patterns: [/\bvending\b/i, /\bmachines?\b/i, /\bsnacks?\b/i, /\bcard readers?\b/i, /\broute\b/i],
    targetPatterns: [/\bvending\b/i, /\bsnack\b/i, /\bmachine\b/i],
    requiredClause: "Visible location: vending route location with snack and drink machines, card readers, inventory boxes, service cart, commercial hallway or gym corner, and utility lighting.",
    forbiddenClause: "Location guardrail: every visible environmental cue reinforces vending-route operations: snack machines, drink machines, inventory boxes, card readers, and service-cart details.",
  },
  {
    id: "startup_office",
    preferredRefId: "mercer_systems_office_ref",
    label: "MERCER SYSTEMS STARTUP OFFICE",
    patterns: [/\bMercer Systems\b/i, /\bstartup office\b/i, /\bwhiteboards?\b/i, /\btitle company\b/i, /\bfirst client check\b/i, /\bNina\b/i],
    targetPatterns: [/\bMercer Systems\b/i, /\bstartup\b/i, /\bwhiteboards?\b/i, /\bfounder workspace\b/i],
    requiredClause: "Visible location: small growing startup office with glass office walls, whiteboards full of diagrams, practical desks, visible wires, coffee machine, framed first-client check, and working team atmosphere.",
    forbiddenClause: "Location guardrail: every visible environmental cue reinforces a growing startup office: whiteboards, glass office walls, practical desks, visible wires, and working team details.",
  },
  {
    id: "boardroom",
    preferredRefId: "blackwell_boardroom_ref",
    label: "EXECUTIVE BOARDROOM",
    patterns: [/\bboardroom\b/i, /\bboard meeting\b/i, /\bboard members?\b/i, /\binvestors?\b/i, /\bconference table\b/i, /\brestructuring\b/i, /\bcreditor\b/i],
    targetPatterns: [/\bboardroom\b/i, /\bconference table\b/i, /\bexecutive\b/i],
    requiredClause: "Visible location: executive boardroom with long conference table, board packets, laptops, water glasses, glass walls, city view, suited decision-makers, and power-center lighting.",
    forbiddenClause: "Location guardrail: every visible environmental cue reinforces an executive boardroom: long conference table, packets, laptops, suited decision-makers, glass walls, and city view.",
  },
  {
    id: "lobby_elevator",
    preferredRefId: "blackwell_lobby_elevator_ref",
    label: "CORPORATE LOBBY AND ELEVATOR",
    patterns: [/\blobby\b/i, /\belevator\b/i, /\bsecurity desk\b/i, /\bmarble floors?\b/i, /\bBlackwell Tower\b/i],
    targetPatterns: [/\blobby\b/i, /\belevator\b/i, /\bsecurity desk\b/i, /\bmarble\b/i],
    requiredClause: "Visible location: corporate tower lobby and elevator area with marble floors, security desk, polished steel elevator doors, reflective glass, and upscale finance atmosphere.",
    forbiddenClause: "Location guardrail: every visible environmental cue reinforces corporate entry architecture: marble floor, security desk, steel elevator doors, glass entrance, and reflective lobby surfaces.",
  },
  {
    id: "executive_lounge",
    preferredRefId: "blackwell_lounge_ref",
    label: "EXECUTIVE LOUNGE",
    patterns: [/\bexecutive lounge\b/i, /\bleather couch\b/i, /\bglass desk\b/i, /\bwedding ring\b/i, /\breturned ring\b/i],
    targetPatterns: [/\blounge\b/i, /\bleather couch\b/i, /\bglass desk\b/i],
    requiredClause: "Visible location: luxury executive lounge with leather couch, glass desk, framed business magazine covers, wine glass, polished surfaces, and high-floor city windows.",
    forbiddenClause: "Location guardrail: every visible environmental cue reinforces an elite executive lounge: leather couch, glass desk, wine glass, framed magazine covers, polished surfaces, and skyline windows.",
  },
  {
    id: "coffee_courthouse",
    preferredRefId: "coffee_shop_courthouse_ref",
    label: "COFFEE SHOP NEAR COURTHOUSE",
    patterns: [/\bcoffee shop\b/i, /\bcourthouse\b/i, /\bdivorce documents?\b/i, /\blatte\b/i],
    targetPatterns: [/\bcoffee\b/i, /\bcourthouse\b/i],
    requiredClause: "Visible location: urban coffee shop exterior near courthouse with glass storefront, sidewalk tables, daylight, passing businesspeople, and legal-district atmosphere.",
    forbiddenClause: "Location guardrail: every visible environmental cue reinforces a public legal-district coffee-shop exterior: glass storefront, sidewalk tables, courthouse-adjacent street, and daylight foot traffic.",
  },
];

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

function locationContractForPrompt(prompt) {
  const beatText = beatContractText(prompt);
  const excerptText = String(prompt.visual_beat_script_excerpt ?? "");
  if (hasExecutiveLoungeSignal(beatText)) {
    return genericLocationContracts.find((contract) => contract.id === "executive_lounge") ?? null;
  }
  if (/\bone hundred and eighty days later\b|\bnew body\b|\bclean suit\b|\btwo attorneys\b|\bdebt documents\b|\bwalked back into the same building\b/i.test(beatText)) {
    return genericLocationContracts.find((contract) => contract.id === "lobby_elevator") ?? null;
  }
  if (
    /\b(?:brought dinner|paper bag with Thai food|holding a paper bag|stood in the elevator|elevator opened|remember we were married|remember I was still trying)\b/i.test(excerptText)
    && !/\b(?:found Vivian|Vivian in the executive lounge|sitting on a leather couch|wedding ring missing|Preston|looked at my stomach|everyone laughed)\b/i.test(excerptText)
  ) {
    return genericLocationContracts.find((contract) => contract.id === "lobby_elevator") ?? null;
  }
  if (/\bweighed two hundred and fifty pounds\b|\bshirts pulled at the buttons\b|\bshirt buttons\b|\bbody-state proof\b/i.test(beatText)) {
    return genericLocationContracts.find((contract) => contract.id === "lobby_elevator") ?? null;
  }
  if (/\bVivian used to say\b|\bbarely looked at me\b|\bstopped looking at me\b/i.test(excerptText)) {
    return genericLocationContracts.find((contract) => contract.id === "apartment") ?? null;
  }
  if (/\b(?:vending route|vending machines?|snack inventory|stale snacks?|card readers?|route economics|cash-flow acquisition)\b/i.test(beatText)) {
    return genericLocationContracts.find((contract) => contract.id === "vending_route") ?? null;
  }
  if (
    /\b(?:private group chat|chat screenshot|mocking chat|dentist bots?|social humiliation|mockery detected|Preston wrote|cold email|cold outreach|outreach list|first real interested reply|sent my first|sent one hundred|four replies|reply asking|called her|phone call|missed calls?|A I receptionist|text-back|review follow-up|five system-guided questions|Mara|Smiling Oaks)\b/i.test(beatText)
    && !/\b(?:walked into|arrived at|entered|inside|in-person|visited|reception counter|patient chairs|clinic room|dental chair)\b/i.test(beatText)
  ) {
    return genericLocationContracts.find((contract) => contract.id === "apartment") ?? null;
  }
  const matches = genericLocationContracts
    .map((contract, index) => ({
      contract,
      index,
      count: contract.patterns.filter((pattern) => pattern.test(beatText)).length,
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index);
  return matches[0]?.contract ?? null;
}

function applyLocationContract(text, contract) {
  if (!contract) return text;
  text = stripMixedLocationLanguage(text, contract);
  const clauses = [];
  if (!text.includes(contract.requiredClause)) clauses.push(contract.requiredClause);
  if (!text.includes(contract.forbiddenClause)) clauses.push(contract.forbiddenClause);
  if (!clauses.length) return text;
  return `${text} ${clauses.join(" ")}`.trim();
}

function stripMixedLocationLanguage(text, contract) {
  let next = String(text ?? "");
  if (contract.id === "support_office") {
    next = next
      .replace(/\bfirst through a work interaction with Darren and then through a nighttime confrontation with debt at the kitchen table\b/gi, "through a work interaction with Darren inside the support office")
      .replace(/\bThen montage small daily missions with brief inserts\. End at 9:17 P\.M\. with the narrator seated at the kitchen table, accounts open, notebook total written, and the money stat notification appearing\./gi, "")
      .replace(/\blater anxious while facing avoided debt\b/gi, "focused during the workplace social test")
      .replace(/\blater apartment casual clothes at kitchen table\b/gi, "same tired work clothes in the support office")
      .replace(/\bThe environment is Customer support workplace, then narrators apartment kitchen table\./gi, "The environment is a dead-end customer support workplace.")
      .replace(/\bThe early grind is grounded in a modest apartment, gym, laptop workspace, blue system glow, effort, loneliness, and routine discipline\./gi, "The workday grind is grounded in a support office, headset station, ticket queue monitor, blue system glow, effort, loneliness, and routine discipline.");
  }
  if (contract.id === "apartment") {
    next = next
      .replace(/\bAt work, place Darren slightly foregrounded while the system window opens above his shoulder and the narrator answers plainly\./gi, "")
      .replace(/\bThe environment is Customer support workplace, then narrators apartment kitchen table\./gi, "The environment is Joey's modest apartment kitchen table workspace.")
      .replace(/\bwork interaction with Darren\b/gi, "private debt confrontation")
      .replace(/\bsupport headset\b/gi, "household table lamp")
      .replace(/\bstack of unresolved support tickets\b/gi, "stack of unpaid bills");
  }
  if (contract.id === "vending_route") {
    next = next
      .replace(/\bMercer Systems office\b/gi, "vending route location")
      .replace(/\bstartup office\b/gi, "vending route location")
      .replace(/\bwhiteboards full of diagrams\b/gi, "rows of snack and drink machines")
      .replace(/\bcheap desks\b/gi, "inventory boxes and service cart");
  }
  if (contract.id === "dental_office") {
    next = next
      .replace(/\bgeneric office\b/gi, "dental practice office")
      .replace(/\bapartment workspace\b/gi, "dental practice reception workspace");
  }
  return next.replace(/\s+/g, " ").trim();
}

function removeConflictingSingleLocationClauses(text, contract) {
  if (!contract) return text;
  const keepersByContract = {
    support_office: /\bsupport|customer support|cubicle|headset|ticket queue/i,
    apartment: /\bapartment|bedroom|bathroom|kitchen|desk|home|dumpster|fridge/i,
    gym: /\bgym|treadmill|dumbbell|bench/i,
    dental_office: /\bdental|clinic|patient|reception/i,
    summit: /\bsummit|conference|stage|audience|presentation/i,
    vending_route: /\bvending|snack|drink machine|inventory/i,
    startup_office: /\bMercer Systems|startup|whiteboard|office routine/i,
    boardroom: /\bboardroom|conference table|board packet|creditor/i,
    lobby_elevator: /\bBlackwell|corporate lobby|lobby|elevator|security desk|marble|corporate entrance/i,
    executive_lounge: /\bexecutive lounge|leather couch|glass desk/i,
    coffee_courthouse: /\bcoffee|courthouse/i,
  };
  const keeper = keepersByContract[contract.id];
  if (!keeper) return text;
  let next = String(text ?? "");
  next = next.replace(/\bSingle location: [^.]+\.(?: (?:Show|Keep|Joey|The|Visible|Do not|No) [^.]+\.)*/gi, (clause) => {
    return keeper.test(clause) ? clause : "";
  });
  return next.replace(/\s+/g, " ").trim();
}

function removeConflictingVisibleLocationClauses(text, contract) {
  if (!contract) return text;
  const keepersByContract = {
    support_office: /\bsupport|customer support|cubicle|headset|ticket/i,
    apartment: /\bapartment|domestic|home|kitchen|bedroom|bathroom|residential|household/i,
    gym: /\bgym|fitness|treadmill|dumbbell/i,
    dental_office: /\bdental|clinic|patient|reception/i,
    summit: /\bsummit|conference|stage|audience|presentation/i,
    vending_route: /\bvending|snack|drink machine|inventory/i,
    startup_office: /\bMercer Systems|startup|whiteboard/i,
    boardroom: /\bboardroom|conference table|board packet|creditor/i,
    lobby_elevator: /\bcorporate tower|lobby|elevator|security desk|marble|steel elevator/i,
    executive_lounge: /\bexecutive lounge|leather couch|glass desk|wine glass/i,
    coffee_courthouse: /\bcoffee|courthouse|legal-district/i,
  };
  const keeper = keepersByContract[contract.id];
  if (!keeper) return text;
  let next = String(text ?? "");
  next = next.replace(/\bVisible location: [^.]+\./gi, (clause) => (keeper.test(clause) ? clause : ""));
  next = next.replace(/\bLocation guardrail: [^.]+\./gi, (clause) => (keeper.test(clause) ? clause : ""));
  return next.replace(/\s+/g, " ").trim();
}

function sceneNumber(prompt) {
  const match = String(prompt.scene_id ?? "").match(/scene_(\d+)/i);
  return match ? Number(match[1]) : null;
}

function joeyProgressionClause(prompt, requirements) {
  const hasJoey = requirements.some((req) => /^joey_/i.test(req.ref_id ?? ""))
    || /\bjoey mercer\b/i.test(promptText(prompt));
  if (!hasJoey) return "";
  const scene = sceneNumber(prompt);
  const text = promptText(prompt);
  if (/\bjoey_owner_ref\b/i.test(JSON.stringify(requirements)) || (scene && scene >= 38)) {
    return "Joey progression state: final owner version, lean athletic build, sharp grooming, charcoal tailored suit or boardroom-grade businesswear, calm authority, expensive cleanliness, polished executive presentation.";
  }
  if (/\bjoey_emerging_founder_ref\b/i.test(JSON.stringify(requirements)) || (scene && scene >= 19)) {
    if (scene === 26 || /\bvending|asset|route|machine\b/i.test(text)) {
      return "Joey progression state: mid-transformation asset operator, visibly slimmer than the opening, clean fitted practical clothes, focused hands-on business posture, organized rather than desperate.";
    }
    if (scene && scene >= 31) {
      return "Joey progression state: late transformation operator, leaner face, strong posture, neat hair, fitted professional clothes, composed founder confidence.";
    }
    return "Joey progression state: emerging founder, noticeably slimmer than the opening but not final, clean grooming, fitted black jacket or practical business-casual clothes, focused self-improvement energy.";
  }
  if (scene && scene >= 8) {
    return "Joey progression state: early discipline phase, still overweight and tired but cleaner and more intentional than the rain-night opening, simple gym or work clothes, beginning self-control.";
  }
  return "Joey progression state: opening discarded-husband phase, visibly overweight at two hundred fifty pounds, strained old clothes, tired posture, rain-night vulnerability.";
}

function enforceSingleMomentComposition(text, prompt) {
  let next = String(text ?? "");
  const beat = `${prompt.visual_beat_script_excerpt ?? ""} ${prompt.visual_beat_action ?? ""}`;
  let openingSpecificRewrite = false;
  if (/\b(?:pizza|soda|chips|cookies|frozen meals?|cheesecake|comfort food|comfort loop|full trash bag|dumpster|MISSION COMPLETE|CRAVING RESISTANCE|PAIN TOLERANCE|ONE HUNDRED EIGHTY DAY ASCENSION QUEST|slept three hours)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    const cleanupBase = (replacement) => {
      next = next
        .replace(/\bThe image depicts Turn the act of throwing away comfort food into the narrators first quiet victory, then introduce the larger one-hundred-eighty-day quest before a short exhausted sleep\./gi, replacement)
        .replace(/\bShow close inserts of junk food and wine going into the trash, then the narrator carrying the heavy bag outside\. Finish with him under quiet city light beside the dumpster, followed by the system quest overlay and a brief bedroom sleep beat\./gi, "")
        .replace(/\bVisible objects include full trash bag, dumpster, wet pavement, system quest window, bed, integrated naturally into the scene\./gi, "Visible objects match only this current beat, integrated naturally into the scene.")
        .replace(/\bThe environment is Apartment kitchen, outside dumpster area, then narrators bedroom\./gi, "The environment matches only this current beat, not the whole montage.")
        .replace(/\bThe early grind is grounded in a modest apartment, gym, laptop workspace, blue system glow, effort, loneliness, and routine discipline\./gi, "The early grind is grounded in the current location, blue system glow, effort, loneliness, and routine discipline.")
        .replace(/\bblackwell solutions executive lounge and elevator exit\b/gi, "the current apartment cleanup location")
        .replace(/\bluxury executive lounge with leather couch, glass desk, framed business magazine covers, wine glass, polished surfaces, and high-floor city windows\b/gi, "modest apartment cleanup space with fridge, cabinets, trash bag, scattered food packaging, and lonely household lighting")
        .replace(/\bevery visible environmental cue reinforces an elite executive lounge: leather couch, glass desk, wine glass, framed magazine covers, polished surfaces, and skyline windows\b/gi, "every visible environmental cue reinforces the current apartment cleanup beat: fridge, cabinets, trash bag, food packaging, wet pavement, or bed only when relevant");
    };
    if (/\b(?:pizza|soda|chips|cookies|frozen meals?|cheesecake)\b/i.test(beat)) {
      cleanupBase("The image depicts one apartment-kitchen cleanup moment: overweight Joey stands at the open fridge or counter putting junk food into one black trash bag, face tired but newly resolved.");
      next += " Single location: modest apartment kitchen only, with open fridge, cabinets, food packaging, trash bag, and lonely household lighting. Do not show the dumpster, street, bed, office, lounge, or multiple time moments.";
    } else if (/\b(?:full trash bag|carried it outside|dumpster|rain had stopped|city was quiet|MISSION COMPLETE)\b/i.test(beat)) {
      cleanupBase("The image depicts one quiet exterior victory moment: overweight Joey stands beside the apartment dumpster at night with the full trash bag, wet pavement, calm city light, and a small blue system glow nearby.");
      next += " Single location: apartment dumpster exterior at night only, with wet pavement, trash bag, dumpster, quiet city light, and no bedroom, fridge, office, or lounge.";
    } else if (/\b(?:CRAVING RESISTANCE|PAIN TOLERANCE|another window opened)\b/i.test(beat)) {
      cleanupBase("The image depicts one system-reward moment after the cleanup: overweight Joey stands alone near the apartment doorway or dumpster with the trash bag down and a clean blue holographic reward interface floating beside him.");
      next += " Single location: quiet apartment threshold or dumpster exterior only, centered on Joey, the set-down trash bag, and a clean blue system glow. Do not use panel grids, multiple inserts, bedroom sleep, or food closeup montage.";
    } else if (/\b(?:ONE HUNDRED EIGHTY DAY ASCENSION QUEST|slept three hours|four-thirty A\.?\s*M\.?|bedroom sleep)\b/i.test(beat)) {
      cleanupBase("The image depicts one exhausted bedroom transition moment: overweight Joey lies or sits on the bed in the dim modest apartment bedroom while a blue system quest glow floats near the alarm clock.");
      next += " Single location: modest bedroom only, with bed, alarm phone or clock, dim blue holographic glow, and no kitchen, dumpster, office, lounge, or multiple panels.";
    }
  }
  if (/\b(?:four-thirty|alarm screamed|reached for the alarm|stand up within ten seconds|old identity reinforced|chest felt heavy|side of the bed|bathroom mirror|round face|tired eyes|stubble|stomach hanging|BODY|DISCIPLINE|starting screen|old sneakers|walked to the gym)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    const wakeBase = (replacement) => {
      next = next
        .replace(/\bThe image depicts Frame the smallest possible discipline choice, standing up, as a major identity break, then confront the narrators body and status through the bathroom mirror system overlay\./gi, replacement)
        .replace(/\bBegin with a close shot of the phone alarm at 4:30 A\.M\. and the narrator reaching toward it\. Freeze the moment with the system overlay, then stage him standing\. Move to a harsh bathroom mirror shot showing his full unflattering reflection with stats overlaid, ending as he puts on old sneakers\./gi, "")
        .replace(/\bVisible objects include phone alarm, bathroom mirror, old sneakers, system status overlay, integrated naturally into the scene\./gi, "Visible objects match only this current beat, integrated naturally into the scene.")
        .replace(/\bVisible objects include phone alarm, cold bed with empty Vivian side, bathroom mirror, old sneakers, system stat overlay, integrated naturally into the scene\./gi, "Visible objects match only this current beat, integrated naturally into the scene.")
        .replace(/\bThe environment is Bedroom, bathroom mirror, then apartment entryway\./gi, "The environment matches only this current wake-up beat, not the whole sequence.")
        .replace(/\bThe early grind is grounded in a modest apartment, gym, laptop workspace, blue system glow, effort, loneliness, and routine discipline\./gi, "The early grind is grounded in the current wake-up location, blue system glow, effort, loneliness, and routine discipline.");
    };
    if (/\b(?:four-thirty|alarm screamed|reached for the alarm|stand up within ten seconds)\b/i.test(beat)) {
      wakeBase("The image depicts one bedroom alarm moment: overweight Joey in clean simple sleep or office clothes reaches toward a phone alarm on the bedside table while a blue system glow freezes the choice.");
      next += " Single location: modest bedroom only, with bed, bedside phone alarm, shoes on floor, and blue system glow. Do not show the bathroom mirror, gym, treadmill, sneakers sequence, or panel montage.";
    } else if (/\b(?:chest felt heavy|side of the bed|apartment was cold)\b/i.test(beat)) {
      wakeBase("The image depicts one cold-bedroom grief moment: overweight Joey sits on the edge of the bed in the modest apartment, looking at the empty cold side where Vivian used to sleep, exhausted but not reaching for her.");
      next += " Single location: modest bedroom only, with bed, empty pillow or blanket space, dim morning light, and blue system glow. Do not show bathroom mirror, gym, phone collage, or panel montage.";
    } else if (/\b(?:bathroom mirror|Round face|Tired eyes|Stubble|Stomach hanging|stats over my reflection|BODY|DISCIPLINE)\b/i.test(beat)) {
      wakeBase("The image depicts one bathroom mirror truth moment: overweight Joey faces the mirror with tired eyes and tense posture while a clean blue system reflection glow floats beside the mirror.");
      next = next
        .replace(/\bA man who had spent years saying silent reaction until tomorrow became the woman he loved leaving with another man\./gi, "A solo self-confrontation with his old identity.")
        .replace(/\bwoman he loved leaving with another man\b/gi, "old emotional failure")
        .replace(/\bVivian\b/gi, "the absent spouse");
      next += " Single location: modest bathroom only. Show one physical Joey and, if needed, one clearly flat mirror reflection aligned inside the mirror plane; the blue stat panel uses abstract unreadable glyph bars only. Keep the mirror solo: no spouse figure, no couple image, no second man, no family portrait, no inset panels, no bedroom, no gym.";
    } else if (/\b(?:old identity reinforced|Ten seconds|So I stood)\b/i.test(beat)) {
      wakeBase("The image depicts one discipline action moment: overweight Joey has just stood beside the bed in the modest bedroom, tired but upright, with the alarm phone below him and blue system light nearby.");
      next += " Single location: modest bedroom only, one physical Joey standing beside the bed, no mirror reflection, no gym, no panels, no alternate Joey poses.";
    } else if (/\b(?:starting screen|old sneakers|walked to the gym)\b/i.test(beat)) {
      wakeBase("The image depicts one apartment entryway departure moment: overweight Joey ties or steps into old sneakers by the apartment door, ready to walk to the gym, with a quiet blue system glow behind him.");
      next += " Single location: apartment entryway only, with old sneakers, door, coat hook, and blue system glow. The blue system glow uses abstract unreadable glyph bars only, not readable title text or subtitle strips. Do not show the gym interior, treadmill, bathroom mirror, bed, or panel montage.";
    }
  }
  if (/\b(?:gym was open|stepped inside|treadmill|Speed: three|Incline: two|lower back hurt|sweat poured|grabbed the rails|two guys near the dumbbells|dumbbells glanced|near fall|twenty minutes|thirty minutes|completed thirty|collapses onto a bench|face burned|public shame|stared at the clock|twelve minutes|legs felt like rubber|did not step off|laughing stopped|hit stop|stumbled to a bench|pain tolerance|shame conversion|breathing hard|sweat dripping|same two guys|glanced over|did not laugh|forgotten me)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    const gymBase = (replacement) => {
      next = next
        .replace(/\bThe image depicts Show the narrator entering an intimidating gym, nearly failing on the treadmill under public judgment, then converting shame into focus and earning his first pain-based reward\./gi, replacement)
        .replace(/\bStart with the narrator entering the gym and feeling exposed\. Stage him on the treadmill as speed and incline are visible, then show his near fall and the two men laughing near the dumbbells\. Keep the focus on the narrators face and legs as he lowers speed but stays on until twenty minutes, then collapses onto a bench with the reward overlay\./gi, "")
        .replace(/\bThe image depicts Show Joey resisting Vivians guilt-text emotional hook, choosing discipline instead, and gaining visible progress at the gym while the old mockery loses power\./gi, replacement)
        .replace(/\bThe image depicts Show Joey resisting the contact guilt-text emotional hook, choosing discipline instead, and gaining visible progress at the gym while the old mockery loses power\./gi, replacement)
        .replace(/\bStart with a compressed emotional beat of Joey reading Vivians text and staring at the phone\. The system reframes the message as a trap, and Joey places the phone face down\. Cut to the treadmill where the same two men are nearby, one glances over without laughing, and Joey finishes thirty minutes as stat gains and weight progress appear\./gi, "")
        .replace(/\bStart with a compressed emotional beat of Joey reading the contact text and staring at the phone\. The system reframes the message as a trap, and Joey places the phone face down\. Cut to the treadmill where the same two men are nearby, one glances over without laughing, and Joey finishes thirty minutes as stat gains and weight progress appear\./gi, "")
        .replace(/\bVisible objects include treadmill, treadmill display, gym bench, dumbbells, system ability window, integrated naturally into the scene\./gi, "Visible objects match only this current gym beat, integrated naturally into the scene.")
        .replace(/\bVisible objects include phone, (?:Vivian|the contact|the absent spouse) text message, treadmill, gym equipment, weight\/status system display, integrated naturally into the scene\./gi, "Visible objects match only this current gym beat, integrated naturally into the scene.")
        .replace(/\bThe people in the frame are Joey Mercer, phone, floating system interface, two gym men, arranged with clean separation and distinct faces\./gi, "The people in the frame are Joey Mercer and two distinct background gym men, arranged with clear spacing and secondary background focus.")
        .replace(/\bThe environment is Twenty-four-hour gym treadmill area and dumbbell zone\./gi, "The environment is the current gym beat only, not the whole workout sequence.")
        .replace(/\bThe environment is Joeys apartment, then gym treadmill area\./gi, "The environment is the gym treadmill area.");
    };
    if (/\b(?:gym was open|stepped inside|felt like everyone knew)\b/i.test(beat)) {
      gymBase("The image depicts one gym entrance moment: overweight Joey steps into a twenty-four-hour gym under harsh fluorescent light, feeling exposed, with machines and mirrors stretching behind him.");
      next += " Single location: gym entrance/treadmill area only, one physical Joey entering, no bench collapse, no duplicate Joey, no panel montage.";
    } else if (/\b(?:got on the treadmill|Speed: three)\b/i.test(beat)) {
      gymBase("The image depicts one treadmill start moment: overweight Joey is on the treadmill gripping the rails, display glowing nearby, trying to begin despite embarrassment.");
      next += " Single location: treadmill row only. Joey appears once, physically on the treadmill; any background gym members are slimmer or differently dressed and must not resemble Joey.";
    } else if (/\b(?:Incline: two|lower back hurt|sweat poured)\b/i.test(beat)) {
      gymBase("The image depicts one painful treadmill effort moment: overweight Joey sweats heavily on the treadmill, face strained, lower back tense, hands near the rails, refusing to step off.");
      next += " Single location: treadmill row only, Joey appears once on the treadmill, no separate standing Joey, no bench, no reward overlay, no panel montage.";
    } else if (/\b(?:grabbed the rails|near fall|two guys near the dumbbells|dumbbells glanced|smirked|laughed)\b/i.test(beat)) {
      gymBase("The image depicts one public gym shame moment: overweight Joey nearly stumbles on the treadmill while two different-looking fit gym guys smirk near the dumbbell rack in the background.");
      next += " Single location: treadmill and dumbbell area only. Joey appears once on the treadmill; the two gym guys are visibly different from Joey in body type, hairstyle, wardrobe color, and face shape.";
    } else if (/\b(?:face burned|public shame|stared at the clock|twelve minutes|legs felt like rubber|did not step off|laughing stopped)\b/i.test(beat)) {
      gymBase("The image depicts one persistence-on-treadmill moment: overweight Joey stays on the treadmill despite burning shame, sweat, and public embarrassment, with the display and blue system glow near him.");
      next += " Single location: treadmill row only, Joey appears once on the treadmill, no separate standing Joey, no bench collapse, no reward-panel collage, no panel montage.";
    } else if (/\b(?:same two guys|glanced over|did not laugh|forgotten me|completed thirty minutes)\b/i.test(beat)) {
      gymBase("The image depicts one thirty-minute treadmill completion moment: overweight Joey finishes the workout on the treadmill, breathing hard but focused, while two different-looking gym men in the background no longer laugh.");
      next += " Single location: treadmill row only. Joey appears once on the treadmill near the glowing display; background gym men are visually distinct and secondary.";
    } else if (/\b(?:twenty minutes|bench|reward overlay|pain tolerance|shame conversion|hit stop|stumbled to a bench|breathing hard|sweat dripping)\b/i.test(beat)) {
      gymBase("The image depicts one post-workout reward moment: overweight Joey sits exhausted on a gym bench with sweat on his face while a clean blue system reward glow floats beside the bench.");
      next += " Single location: gym bench area only, Joey appears once seated, no treadmill duplicate, no extra Joey-like background figures, no panel montage.";
    }
  }
  if (/\b(?:hook sank|system did not make me rich|effort feel like it had a receipt|went to work|headset|Darren|support tickets|self-deprecate|apologizing for existing|hard night|handling it|good|presence plus one)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    const supportBase = (replacement) => {
      next = next
        .replace(/\bThe image depicts Connect the systems addictive receipt-like rewards to everyday discipline, first through a work interaction with Darren and then through a nighttime confrontation with debt at the kitchen table\./gi, replacement)
        .replace(/\bThe image depicts Connect the systems addictive receipt-like rewards to everyday discipline, through a work interaction with Darren inside the support office\./gi, replacement)
        .replace(/\bBegin with a reflective transition from the gym reward to the idea of effort having a receipt\. At work, place Darren slightly foregrounded while the system window opens above his shoulder and the narrator answers plainly\. Then montage small daily missions with brief inserts\. End at 9:17 P\.M\. with the narrator seated at the kitchen table, accounts open, notebook total written, and the money stat notification appearing\./gi, "")
        .replace(/\bThen montage small daily missions with brief inserts\./gi, "")
        .replace(/\bEnd at 9:17 P\.M\. with the narrator seated at the kitchen table, accounts open, notebook total written, and the money stat notification appearing\./gi, "")
        .replace(/\bVisible objects include support headset, stack of unresolved support tickets, office desk, water bottle, stairs, integrated naturally into the scene\./gi, "Visible objects match only this current support-office beat, integrated naturally into the scene.")
        .replace(/\bThe environment is Customer support workplace, then narrators apartment kitchen table\./gi, "The environment is a dead-end customer support office.")
        .replace(/\bThe early grind is grounded in a modest apartment, gym, laptop workspace, blue system glow, effort, loneliness, and routine discipline\./gi, "The early grind is grounded in the support office, headset station, ticket queue, blue system glow, effort, and routine discipline.");
    };
    if (/\b(?:hook sank|system did not make me rich|effort feel like it had a receipt)\b/i.test(beat)) {
      supportBase("The image depicts one reflective transition moment: overweight Joey sits alone after the gym with a small abstract blue receipt-like glow beside him, realizing effort can pay back.");
      next = next.replace(/\bDarren\b/gi, "distant office figure").replace(/\bmanager\b/gi, "workplace figure");
      next += " Single location: quiet gym bench or transition space only, one Joey, no Darren close-up, no office desk, no kitchen table, no debt documents.";
    } else if (/\b(?:self-deprecate|apologizing for existing|hard night|handling it|good|presence plus one)\b/i.test(beat)) {
      supportBase("The image depicts one silent workplace self-respect moment: overweight Joey faces Darren in the support office with calm posture while a small blue system glow floats above the desk.");
      next = next
        .replace(/\bI’m handling it\.\s*”?/gi, "silent calm response beat.")
        .replace(/\bAlright,?\s*”?\s*he said\.?\s*”?\s*Good\.?/gi, "Darren gives a small surprised nod.")
        .replace(/\b“Good\b/gi, "Darren gives a small surprised nod")
        .replace(/\bgood\b/gi, "a small surprised nod")
        .replace(/\bReward: PRESENCE plus one\b/gi, "abstract presence reward glyphs");
      next += " Single location: customer support office only, Joey and Darren are separate full bodies with clear eyelines. Communicate the answer through posture and expression only; no speech balloon, no subtitle strip, no readable quote text.";
    } else if (/\b(?:went to work|headset|support tickets|Darren)\b/i.test(beat)) {
      supportBase("The image depicts one support-office arrival moment: overweight Joey stands at a cubicle with headset and ticket queue while Darren holds unresolved support tickets nearby.");
      next += " Single location: customer support office only, with cubicles, headset station, ticket queue, Darren, and no apartment kitchen or debt table.";
    }
  }
  if (/\b(?:kitchen table|accounts open|credit cards?|car loan|medical bill|personal loan|debt|forty-six thousand|financial truth|money stat|skill asset path|earn without permission|one thousand dollars|fourteen days)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Connect the systems addictive receipt-like rewards to everyday discipline, first through a work interaction with Darren and then through a nighttime confrontation with debt at the kitchen table\./gi, "The image depicts one apartment debt-truth moment: overweight Joey sits alone at the kitchen table with bills, notebook, laptop, and a blue system finance glow.")
      .replace(/\bBegin with a reflective transition from the gym reward to the idea of effort having a receipt\. At work, place Darren slightly foregrounded while the system window opens above his shoulder and the narrator answers plainly\. Then montage small daily missions with brief inserts\. End at 9:17 P\.M\. with the narrator seated at the kitchen table, accounts open, notebook total written, and the money stat notification appearing\./gi, "")
      .replace(/\bAt work, place Darren slightly foregrounded while the system window opens above his shoulder and the narrator answers plainly\./gi, "")
      .replace(/\bDarren\b/gi, "no coworker")
      .replace(/\bmanager\b/gi, "no coworker")
      .replace(/\bsupport headset\b/gi, "laptop")
      .replace(/\bstack of unresolved support tickets\b/gi, "stack of unpaid bills")
      .replace(/\boffice desk\b/gi, "kitchen table")
      .replace(/\bThe environment is Customer support workplace, then narrators apartment kitchen table\./gi, "The environment is Joey's modest apartment kitchen table.")
      .replace(/\bThe early grind is grounded in a modest apartment, gym, laptop workspace, blue system glow, effort, loneliness, and routine discipline\./gi, "The early grind is grounded in the modest apartment kitchen, unpaid bills, laptop work, blue system glow, effort, loneliness, and routine discipline.");
    next += " Single location: modest apartment kitchen table only, with bills, notebook, laptop, calculator or bank pages, and blue system finance glow. Joey is alone; no coworker, no support office, no cubicles, no headset, no gym.";
  }
  if (/\b(?:all day,? the missions came|Drink water|Take stairs|Do not check|reread old messages|Eat protein)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Connect the systems addictive receipt-like rewards to everyday discipline, first through a private debt confrontation and then through a nighttime confrontation with debt at the kitchen table\./gi, "The image depicts one daily self-control mission moment: overweight Joey alone completes a small disciplined action with a blue system glow nearby.")
      .replace(/\bThe image depicts Connect the systems addictive receipt-like rewards to everyday discipline, first through a work interaction with Darren and then through a nighttime confrontation with debt at the kitchen table\./gi, "The image depicts one daily self-control mission moment: overweight Joey alone completes a small disciplined action with a blue system glow nearby.")
      .replace(/\bThen montage small daily missions with brief inserts\./gi, "")
      .replace(/\bEnd at 9:17 P\.M\. with the narrator seated at the kitchen table, accounts open, notebook total written, and the money stat notification appearing\./gi, "")
      .replace(/\bAt work, place no coworker slightly foregrounded while the system window opens above his shoulder and the narrator answers plainly\./gi, "")
      .replace(/\bAt work, place Darren slightly foregrounded while the system window opens above his shoulder and the narrator answers plainly\./gi, "")
      .replace(/\bVisible objects include support headset, stack of unresolved support tickets, office desk, water bottle, stairs, integrated naturally into the scene\./gi, "Visible objects match only this current daily mission beat, integrated naturally into the scene.")
      .replace(/\bThe environment is Customer support workplace, then narrators apartment kitchen table\./gi, "The environment is the current daily mission location.")
      .replace(/\bVivian’s location\b/gi, "a phone location app left unopened")
      .replace(/\bVivian\b/gi, "the absent contact")
      .replace(/\bDarren\b/gi, "no coworker")
      .replace(/\bmanager\b/gi, "no coworker");
    next += " Single solo-Joey frame only: show one small action such as water bottle, stairs, closed phone, meal prep, or notebook checklist. No spouse figure, no coworker, no second seated Joey, no split-screen montage, no extra named character.";
  }
  if (/\b(?:searched for skills|Websites|Ads|Copywriting|Bookkeeping|Appointment setting|Automation|Missed-call recovery|A I receptionist|local businesses lose revenue|PATTERN DETECTED|simple automation|watched tutorials|connect forms|calendar booking|automated follow-up|test workflows|fixed them|slept ninety minutes|WAKE ANYWAY)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Turn research, tutorial watching, broken test workflows, sleep deprivation, and repeated discipline into a concentrated skill-building montage\./gi, "The image depicts one solo skill-building work moment: overweight Joey at his apartment desk uses a laptop with abstract workflow cards and blue system glow.")
      .replace(/\bShow fast cuts of Joey researching paid skills, system highlights appearing over search results, then ugly workflow diagrams breaking and being repaired\. End with the alarm ringing after almost no sleep and a system mission ordering him to wake anyway, then a compressed montage of pain, work, gym, calls, and learning\./gi, "")
      .replace(/\bThe environment is Joeys apartment workspace, shifting into a compressed workweek montage\./gi, "The environment is Joey's apartment workspace.")
      .replace(/\bThe people in the frame are Joey Mercer, laptop screen, floating system interface, arranged with clean separation and distinct faces\./gi, "The only visible person in the frame is Joey Mercer; laptop and system UI are abstract object layers, not people.")
      .replace(/\bVisible objects include laptop, tutorial videos, forms, message automation diagram, calendar booking screen, integrated naturally into the scene\./gi, "Visible objects include laptop, notebook, abstract workflow nodes, calendar icon cards, form cards, and blue system glow, integrated naturally into the scene.");
    next += " Single location: apartment laptop workspace only. Show exactly one Joey, no video-call portraits, no customer photos, no office panels, no dental office, no gym, no bed alarm, no multi-panel montage. UI cards use icons and abstract glyphs, not human faces.";
  }
  if (/\b(?:No Vivian|she texted me|spiraling|emotional trap|phone face down|guilt-text|I didn.?t want to hurt you|phone for three minutes|EMOTIONAL TRAP DETECTED|do not provide comfort|person who broke you)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Show Joey resisting Vivians guilt-text emotional hook, choosing discipline instead, and gaining visible progress at the gym while the old mockery loses power\./gi, "The image depicts one phone self-control moment: overweight Joey alone looks at a smartphone notification, then keeps his hand away as a blue system warning glow appears.")
      .replace(/\bThe image depicts Show Joey resisting the contact guilt-text emotional hook, choosing discipline instead, and gaining visible progress at the gym while the old mockery loses power\./gi, "The image depicts one phone self-control moment: overweight Joey alone looks at a smartphone notification, then keeps his hand away as a blue system warning glow appears.")
      .replace(/\bStart with a compressed emotional beat of Joey reading Vivians text and staring at the phone\. The system reframes the message as a trap, and Joey places the phone face down\. Cut to the treadmill where the same two men are nearby, one glances over without laughing, and Joey finishes thirty minutes as stat gains and weight progress appear\./gi, "")
      .replace(/\bStart with a compressed emotional beat of Joey reading the contact text and staring at the phone\. The system reframes the message as a trap, and Joey places the phone face down\. Cut to the treadmill where the same two men are nearby, one glances over without laughing, and Joey finishes thirty minutes as stat gains and weight progress appear\./gi, "")
      .replace(/\bThe people in the frame are Joey Mercer, phone, floating system interface, two gym men, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey Mercer; the phone notification and blue system interface are object/UI elements.")
      .replace(/\bVisible objects include phone, (?:Vivian|the contact|the absent spouse) text message, treadmill, gym equipment, weight\/status system display, integrated naturally into the scene\./gi, "Visible objects include smartphone, apartment desk, simple chair, laptop or notebook, and blue system warning glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Joeys apartment, then gym treadmill area\./gi, "The environment is Joey's apartment desk or quiet room.")
      .replace(/\bVivians\b/gi, "the contact's")
      .replace(/\bVivian\b/gi, "the contact")
      .replace(/\btwo gym men\b/gi, "no gym men");
    next += " Single location: apartment desk or quiet room only. The contact appears only as a tiny phone notification icon, not as a person, portrait, inset, or body. No gym men, no treadmill, no split-screen montage.";
  }
  if (/\b(?:BODY plus two|DISCIPLINE plus two|WEIGHT:|two hundred forty-four pounds|Progress was progress)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Show Joey resisting Vivians guilt-text emotional hook, choosing discipline instead, and gaining visible progress at the gym while the old mockery loses power\./gi, "The image depicts one body-progress check moment: overweight Joey stands in a modest bathroom near a scale or mirror, cleaner and more focused, with a blue system stat glow beside him.")
      .replace(/\bThe image depicts Show Joey resisting the contact guilt-text emotional hook, choosing discipline instead, and gaining visible progress at the gym while the old mockery loses power\./gi, "The image depicts one body-progress check moment: overweight Joey stands in a modest bathroom near a scale or mirror, cleaner and more focused, with a blue system stat glow beside him.")
      .replace(/\bStart with a compressed emotional beat of Joey reading Vivians text and staring at the phone\. The system reframes the message as a trap, and Joey places the phone face down\. Cut to the treadmill where the same two men are nearby, one glances over without laughing, and Joey finishes thirty minutes as stat gains and weight progress appear\./gi, "")
      .replace(/\bStart with a compressed emotional beat of Joey reading the contact text and staring at the phone\. The system reframes the message as a trap, and Joey places the phone face down\. Cut to the treadmill where the same two men are nearby, one glances over without laughing, and Joey finishes thirty minutes as stat gains and weight progress appear\./gi, "")
      .replace(/\bThe people in the frame are Joey Mercer, phone, floating system interface, two gym men, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey Mercer; the blue stat glow is an abstract UI element.")
      .replace(/\bVisible objects include phone, (?:Vivian|the contact|the absent spouse) text message, treadmill, gym equipment, weight\/status system display, integrated naturally into the scene\./gi, "Visible objects include bathroom mirror or scale, towel, simple sink, and blue system stat glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Joeys apartment, then gym treadmill area\./gi, "The environment is Joey's modest bathroom or apartment progress-check space.");
    next += " Single location: modest bathroom progress-check only, one physical Joey, one flat mirror reflection at most, scale or mirror visible, no gym men, no phone message, no treadmill, no split-screen montage.";
  }
  if (/\bone hundred and eighty days later\b|\bnew body\b|\bclean suit\b|\btwo attorneys\b|\bdebt documents\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bOpening hook frame with aggressive Ken Burns-ready depth\./gi, "Future-owner contrast frame with aggressive Ken Burns-ready depth.")
      .replace(/\bJoey Mercer is visibly overweight at two hundred fifty pounds with a round tired face, light stubble, strained old shirt, cheap damp jacket, and exhausted posture\./gi, "Joey Mercer is lean and handsome in a clean charcoal suit, walking with calm owner-level authority beside two attorneys.")
      .replace(/\bThe image depicts Establish Joeys humiliation arc by contrasting the future version with a new body and clean suit against his earlier exhausted, overweight, broke state\./gi, "The image depicts the 180-day-later reversal: improved Joey walking back into Blackwell Solutions with two attorneys and controlled debt documents.")
      .replace(/\bThe image depicts one opening humiliation hook: overweight Joey alone in the rain outside Blackwell Solutions, holding a soaked takeout bag with exhausted posture and blue system light streaks in the environment\./gi, "The image depicts the 180-day-later reversal: improved Joey walking back into Blackwell Solutions with two attorneys and controlled debt documents.")
      .replace(/\bUse a single present-tense frame, not a split screen: overweight Joey stands in rain outside the corporate entrance with the takeout bag, readable shame and isolation\./gi, "Use a single present-tense frame, not a split screen: improved Joey strides through the corporate entrance with attorneys behind him and debt documents visible in his hand.")
      .replace(/\bKeep the past version visibly overweight, sweaty, and worn down\./gi, "Keep this as the future improved version: lean body, clean suit, sharp grooming, calm expression.")
      .replace(/\bThe only named person in the frame is Joey Mercer; background office silhouettes may be distant and indistinct\./gi, "The only named person in the frame is Joey Mercer; the two attorneys are supporting business silhouettes with legal folders.")
      .replace(/\bVisible objects include a soaked takeout bag, rain puddles, corporate entrance glass, and blue transition light streaks, integrated naturally into the scene\./gi, "Visible objects include legal folders, debt document packets, polished corporate glass, elevator reflections, and blue transition light streaks, integrated naturally into the scene.")
      .replace(/\bThe environment is a rainy corporate tower exterior with reflective pavement and Blackwell Solutions entrance atmosphere\./gi, "The environment is the polished Blackwell Solutions corporate lobby and entrance area.")
      .replace(/\bJoey progression state: opening discarded-husband phase[^.]*\./gi, "Joey progression state: final owner preview, lean athletic build, sharp grooming, clean suit, calm authority.");
    next += " Single location: polished Blackwell Solutions corporate lobby or elevator entrance only, with marble, glass, security desk, or elevator doors. The two attorneys are secondary business figures with different faces, hair, body shapes, and suit colors from Joey; they stay slightly behind him and never borrow Joey's face.";
  } else if (/\bweighed two hundred and fifty pounds\b|\bshirts pulled at the buttons\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Establish Joeys humiliation arc by contrasting the future version with a new body and clean suit against his earlier exhausted, overweight, broke state\./gi, "The image depicts a close body-state proof frame: overweight Joey's strained shirt buttons, tired face, and uncomfortable posture in harsh office-elevator lighting.")
      .replace(/\bThe image depicts one opening humiliation hook: overweight Joey alone in the rain outside Blackwell Solutions, holding a soaked takeout bag with exhausted posture and blue system light streaks in the environment\./gi, "The image depicts a close body-state proof frame: overweight Joey's strained shirt buttons, tired face, and uncomfortable posture in harsh office-elevator lighting.")
      .replace(/\bUse a single present-tense frame, not a split screen: overweight Joey stands in rain outside the corporate entrance with the takeout bag, readable shame and isolation\./gi, "Use a single present-tense frame: a tight waist-up or three-quarter shot emphasizing shirt tension, heavy breathing, and shame without changing location into another full rain exterior.")
      .replace(/\bVisible objects include a soaked takeout bag, rain puddles, corporate entrance glass, and blue transition light streaks, integrated naturally into the scene\./gi, "Visible objects include strained shirt buttons, old belt, damp collar, elevator glass reflection, and blue transition light streaks, integrated naturally into the scene.")
      .replace(/\bThe environment is a rainy corporate tower exterior with reflective pavement and Blackwell Solutions entrance atmosphere\./gi, "The environment is a close reflective corporate elevator or lobby detail, not a repeated exterior portrait.");
    next += " Single location: corporate lobby or elevator body-detail shot only, with Joey's strained shirt buttons, damp collar, old belt, glass reflection, marble, and elevator light visible.";
  } else if (/\bdead-end support job\b|\bheadset\b|\bstrangers yelled\b|\bnine hours a day\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bOpening hook frame with aggressive Ken Burns-ready depth\./gi, "Work-grind hook frame with aggressive Ken Burns-ready depth.")
      .replace(/\bThe image depicts Establish Joeys humiliation arc by contrasting the future version with a new body and clean suit against his earlier exhausted, overweight, broke state\./gi, "The image depicts Joey at his dead-end support job, wearing a headset at a cubicle while unresolved tickets pile up and blue transition streaks show pressure.")
      .replace(/\bThe image depicts one opening humiliation hook: overweight Joey alone in the rain outside Blackwell Solutions, holding a soaked takeout bag with exhausted posture and blue system light streaks in the environment\./gi, "The image depicts Joey at his dead-end support job, wearing a headset at a cubicle while unresolved tickets pile up and blue transition streaks show pressure.")
      .replace(/\bUse a single present-tense frame, not a split screen: overweight Joey stands in rain outside the corporate entrance with the takeout bag, readable shame and isolation\./gi, "Use a single present-tense frame: overweight Joey at a support-office workstation, headset on, shoulders tired, ticket queue glowing nearby.")
      .replace(/\bVisible objects include a soaked takeout bag, rain puddles, corporate entrance glass, and blue transition light streaks, integrated naturally into the scene\./gi, "Visible objects include headset, support monitor, ticket queue, office workstation, plastic chair, and blue transition light streaks, integrated naturally into the scene.")
      .replace(/\bThe environment is a rainy corporate tower exterior with reflective pavement and Blackwell Solutions entrance atmosphere\./gi, "The environment is a dead-end customer support office with cubicles and headset stations.");
  } else if (/\bVivian used to say\b|\bbarely looked at me\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Establish Joeys humiliation arc by contrasting the future version with a new body and clean suit against his earlier exhausted, overweight, broke state\./gi, "The image depicts emotional neglect: Joey alone at the edge of a dim apartment or office corridor, holding himself small while cool blue light isolates him.")
      .replace(/\bThe image depicts one opening humiliation hook: overweight Joey alone in the rain outside Blackwell Solutions, holding a soaked takeout bag with exhausted posture and blue system light streaks in the environment\./gi, "The image depicts emotional neglect: Joey alone at the edge of a dim apartment or office corridor, holding himself small while cool blue light isolates him.")
      .replace(/\bUse a single present-tense frame, not a split screen: overweight Joey stands in rain outside the corporate entrance with the takeout bag, readable shame and isolation\./gi, "Use a single present-tense frame: Joey in a quiet interior, eyes lowered, with a distant empty space where connection used to be.")
      .replace(/\bVisible objects include a soaked takeout bag, rain puddles, corporate entrance glass, and blue transition light streaks, integrated naturally into the scene\./gi, "Visible objects include dim interior light, distant doorway, simple personal items, and blue transition light streaks, integrated naturally into the scene.")
      .replace(/\bThe environment is a rainy corporate tower exterior with reflective pavement and Blackwell Solutions entrance atmosphere\./gi, "The environment is a quiet lonely interior, distinct from the repeated rain exterior.")
      .replace(/\ba discarded husband becoming a future owner through rain, documents, and blue system energy\b/gi, "a discarded husband standing alone in a modest apartment while connection quietly fades");
  }
  if (/\b(?:brought dinner|paper bag with Thai food|holding a paper bag|stood in the elevator|elevator opened|remember we were married|remember I was still trying)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    const setupFrame = /\belevator opened|remember we were married|remember I was still trying\b/i.test(beat)
      ? "The image depicts one approach-threshold moment: overweight Joey stands alone as polished elevator doors open onto the twenty-third-floor corporate corridor, clutching the Thai takeout bag with nervous hope."
      : "The image depicts one approach setup moment: overweight Joey rides or exits the corporate elevator alone with a paper Thai takeout bag, sweating through his old shirt collar under polished office lights.";
    next = next
      .replace(/\bThe image depicts Build dread as Joey arrives with dinner, follows Vivians intimate laughter, and discovers her with Preston in a wealthy executive space\./gi, setupFrame)
      .replace(/\bStage Joey moving from elevator to corridor, guided by Vivians laughter\. Reveal Vivian seated on the leather couch with wine and no ring, Preston standing beside her\. Prestons gaze moves from the food bag to Joeys stomach before he smiles\./gi, "Stage only the approach before the reveal: Joey alone in the elevator or corridor, tense shoulders, takeout bag visible, glossy glass and elevator reflections around him.")
      .replace(/\bThe people in the frame are Joey Mercer, Vivian, Preston Blackwell, assistants outside the executive lounge, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey Mercer; distant office silhouettes may be tiny and indistinct behind glass.")
      .replace(/\bVisible objects include paper bag with Thai food, glass conference rooms, framed magazine covers of Preston Blackwell, leather couch, wine glass, integrated naturally into the scene\./gi, "Visible objects include the paper Thai takeout bag, elevator doors, polished glass corridor, reflective marble or metal, and blue transition streaks.")
      .replace(/\bThe environment is Blackwell Solutions twenty-third floor, elevator corridor, glass conference rooms, executive lounge\.\./gi, "The environment is the Blackwell Solutions elevator corridor before the lounge reveal.")
      .replace(/\bThe opening betrayal feels cold and luxurious, with tense distance between Joey, Vivian, and Preston inside a high-floor office\./gi, "The approach feels cold and luxurious, with Joey isolated in the high-floor corporate corridor before the betrayal is visible.")
      .replace(/\bVivians\b/gi, "the distant")
      .replace(/\bVivian\b/gi, "the distant source")
      .replace(/\bPreston Blackwell\b/gi, "distant executive branding")
      .replace(/\bPreston\b/gi, "distant executive branding")
      .replace(/\bleather couch\b/gi, "elevator threshold")
      .replace(/\bexecutive lounge\b/gi, "elevator corridor");
    next += " Single location: Blackwell Solutions elevator corridor only, with Joey alone, takeout bag in hand, polished elevator doors, glass corridor, reflective floor, and no visible confrontation yet.";
  }
  if (openingSpecificRewrite) {
    next = next
      .replace(/\bOpen with a sharp contrast: future Joey entering the building with attorneys and debt documents, then cut back to past Joey exhausted at work and standing in rain with takeout\./gi, "")
      .replace(/\bThe people in the frame are Joey Mercer, two attorneys, anonymous call-center workers or implied headset environment, arranged with clean separation and distinct faces\./gi, "The only named person in the frame is Joey Mercer; incidental background workers, if present, remain distant and visually distinct.")
      .replace(/\bVisible objects include debt documents, headset, office workstation, takeout bag in rain, integrated naturally into the scene\./gi, "Visible objects are only the current beat's physical props, staged together in one readable place.")
      .replace(/\bThe environment is Narrative montage between future Blackwell Solutions entrance and Joeys past daily life\.\./gi, "The environment matches only the current beat, not a montage.")
      .replace(/\bNarrative montage between future Blackwell Solutions entrance and Joeys past daily life\b/gi, "single current-beat location")
      .replace(/\bKeep the past version visibly overweight, sweaty, and worn down\./gi, "Keep the visible body state faithful to the current beat.")
      .replace(/\bNo speech bubbles, no captions, no captions\b/gi, "No speech bubbles, no captions");
  }
  if (!openingSpecificRewrite && /\b(?:Opening hook frame|future Joey|earlier exhausted|sharp contrast|then cut back|Narrative montage between)\b/i.test(next)) {
    next = next
      .replace(/\bThe image depicts Establish Joeys humiliation arc by contrasting the future version with a new body and clean suit against his earlier exhausted, overweight, broke state\./gi, "The image depicts one opening humiliation hook: overweight Joey alone in the rain outside Blackwell Solutions, holding a soaked takeout bag with exhausted posture and blue system light streaks in the environment.")
      .replace(/\bOpen with a sharp contrast: future Joey entering the building with attorneys and debt documents, then cut back to past Joey exhausted at work and standing in rain with takeout\./gi, "Use a single present-tense frame, not a split screen: overweight Joey stands in rain outside the corporate entrance with the takeout bag, readable shame and isolation.")
      .replace(/\bThe people in the frame are Joey Mercer, two attorneys, anonymous call-center workers or implied headset environment, arranged with clean separation and distinct faces\./gi, "The only named person in the frame is Joey Mercer; background office silhouettes may be distant and indistinct.")
      .replace(/\bVisible objects include debt documents, headset, office workstation, takeout bag in rain, integrated naturally into the scene\./gi, "Visible objects include a soaked takeout bag, rain puddles, corporate entrance glass, and blue transition light streaks, integrated naturally into the scene.")
      .replace(/\bThe environment is Narrative montage between future Blackwell Solutions entrance and Joeys past daily life\.\./gi, "The environment is a rainy corporate tower exterior with reflective pavement and Blackwell Solutions entrance atmosphere.");
  }
  if (/\b(?:phone|voicemail|call|called|message|text)\b/i.test(beat) && /\bJoey\b/i.test(next)) {
    next = next
      .replace(/\bMara Klein\b/gi, "remote prospect contact icon")
      .replace(/\bMara\b/gi, "remote prospect contact icon")
      .replace(/\bVivians\b/gi, "the contact")
      .replace(/\bVivian\b/gi, "the contact")
      .replace(/\bMISSION:\s*ANSWER ONLY IF YOU CAN SURVIVE HER VOICE WITHOUT BEGGING\b/gi, "a blue mission interface about resisting the call")
      .replace(/\bMISSION:\s*DO NOT PROVIDE COMFORT TO THE PERSON WHO BROKE YOU\b/gi, "a blue mission interface about emotional self-control")
      .replace(/\bShow the phone face-up with Vivians name pulsing, Joeys hand hovering but not touching it, then a close-up of his face as he listens to the voicemail once\. End with his thumb deleting it and the system reward appearing beside him\./gi, "Use an intentional controlled manga panel layout: largest panel shows Joey at his apartment desk with one hand hovering near the phone; smaller prop panels show pure graphic UI symbols: smartphone notification card, blank circular contact silhouette, and abstract blue system glyph bars.")
      .replace(/\bThe people in the frame are Joey, system interface, Vivian as phone contact only, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; Vivian appears only as a tiny contact avatar icon on the phone screen, not as a body, portrait panel, inset, or second character.")
      .replace(/\bVisible objects include smartphone, voicemail screen, work desk, system mission overlay, integrated naturally into the scene\./gi, "Visible objects include smartphone, apartment desk, laptop, notebook, and blue system mission overlay, integrated naturally into the scene.");
    if (!/intentional controlled manga panel layout/i.test(next)) {
      next += " Intentional controlled manga panel layout allowed for this communication beat: largest panel is Joey in the real local room; small secondary panels are pure graphic UI symbols only: envelope icons, checkmarks, phone handset icons, blank circular contact silhouettes, call-flow cards, and abstract blue system glyphs.";
    }
    if (!/exactly one physical Joey/i.test(next)) {
      next += " Exactly one physical Joey across the entire image; no duplicate Joey, no miniature Joey, no reflection Joey, no second body of Joey in another panel.";
    }
    if (!/remote caller is not visible as a person/i.test(next)) {
      next += " Remote caller is not visible as a person; show only a tiny blank circular contact silhouette, envelope icons, phone UI shapes, or abstract call-flow cards.";
    }
  }
  if (/\b(?:cold email|cold outreach|outreach list|first real interested reply|five system-guided questions)\b/i.test(next)) {
    next = next
      .replace(/\bShow Joey grinding through cold outreach, receiving his first real interested reply, then surviving a tense sales call by asking guided questions instead of panicking\./gi, "Use an intentional controlled manga panel layout for a cold-outreach work beat: largest panel shows Joey at his apartment desk sending emails on a laptop; small secondary panels show pure graphic UI symbols: envelope icons, blank reply cards, a phone handset icon, checkmarks, and a gold opportunity glow.")
      .replace(/\bBegin with a visual count-up of cold emails and messages going out with no response\. Show one reply asking for explanation, then a gold system opportunity overlay identifying the dental office\./gi, "Panel roles stay clear: main physical panel is Joey working alone; small panels are abstract email count-up icons, checklist marks, blank reply cards, and one gold opportunity badge.")
      .replace(/\bStage the phone call as tense close-ups or split-screen: Joeys shaking hand, remote prospect contact icon busy at a clinic desk, five system-guided questions appearing one by one, and remote prospect contact icon finally asking if he can build it\./gi, "For the phone-call portion, represent the remote prospect only as a blank circular contact silhouette and use call-flow cards plus five abstract question markers.")
      .replace(/\bStage the phone call as tense close-ups or split-screen: Joeys shaking hand, Mara busy at a clinic desk, five system-guided questions appearing one by one, and Mara finally asking if he can build it\./gi, "For the phone-call portion, represent the remote prospect only as a blank circular contact silhouette and use call-flow cards plus five abstract question markers.")
      .replace(/\bThe people in the frame are Joey Mercer, floating system interface, remote prospect contact icon, arranged with clean separation and distinct faces\./gi, "The only visible person in the frame is Joey Mercer; the system interface and remote reply are abstract icons, not people.")
      .replace(/\bThe people in the frame are Joey Mercer, floating system interface, Mara Klein, arranged with clean separation and distinct faces\./gi, "The only visible person in the frame is Joey Mercer; the system interface and remote reply are abstract icons, not people.")
      .replace(/\bVisible objects include laptop, email inbox, phone, cold outreach list, dental office phone or desk, integrated naturally into the scene\./gi, "Visible objects include laptop, email inbox shapes, phone on desk, cold outreach checklist, notebook, and blue system UI icons, integrated naturally into the scene.")
      .replace(/\bThe environment is Joeys apartment workspace during outreach, then phone call with remote prospect contact icon at Smiling Oaks Dental\./gi, "The environment is Joey's apartment workspace during cold outreach.")
      .replace(/\bThe environment is Joeys apartment workspace during outreach, then phone call with Mara Klein at Smiling Oaks Dental\./gi, "The environment is Joey's apartment workspace during cold outreach.")
      .replace(/\bThe environment is Joeys dental practice reception workspace during outreach, then phone call with Mara Klein at Smiling Oaks Dental\./gi, "The environment is Joey's apartment workspace during cold outreach.")
      .replace(/\bThe environment is Joeys dental practice reception workspace during outreach, then phone call with remote prospect contact icon at Smiling Oaks Dental\./gi, "The environment is Joey's apartment workspace during cold outreach.");
    if (!/intentional controlled manga panel layout/i.test(next)) {
      next += " Intentional controlled manga panel layout allowed here: largest panel is Joey in his local workspace; smaller panels are pure graphic UI symbols only: email icons, blank reply cards, phone handset icons, checkmarks, abstract system cards, and opportunity badges.";
    }
    if (!/exactly one physical Joey/i.test(next)) {
      next += " Exactly one physical Joey across the entire image; no duplicate Joey, no miniature Joey, no second Joey pose in another panel.";
    }
    if (!/no human portraits inside any UI/i.test(next)) {
      next += " No human portraits inside any UI panel, no remote office scene, no extra sales prospects visible; remote identity is only a blank circular silhouette contact icon.";
    }
  }
  if (/\b(?:charged fifteen hundred|setup and three hundred|said the price|almost apologized|discount impulse|state price and remain silent|stayed silent|send the invoice|payment notification arrived|invoice|fifteen hundred dollars received)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    const priceBase = (replacement) => {
      next = next
        .replace(/\bThe image depicts Show Joey holding his price, receiving fifteen hundred dollars, breaking emotionally from proof rather than revenge, and completing a rough but working missed-call automation by Day fourteen\./gi, replacement)
        .replace(/\bShow Joey nearly apologizing after naming the price, then freezing as the red system warning tells him to stay silent\. After (?:Mara|remote prospect contact icon) agrees, Joey stares at the phone until the payment notification arrives and the system fills the screen with completion rewards\. He sits alone at the kitchen table crying quietly\. End on Day fourteen with a simple but functional automation chain: missed call, automatic text, patient clicks the link, appointment booked\./gi, "")
        .replace(/\bThe people in the frame are Joey Mercer, floating system interface, phone or laptop payment notification, automation workflow screen, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey Mercer; phone, laptop, invoice, payment notification, and system glow are object/UI elements.")
        .replace(/\bVisible objects include phone, invoice, payment notification, laptop, kitchen table, integrated naturally into the scene\./gi, "Visible objects match only this current price/payment beat, integrated naturally into the scene.")
        .replace(/\bThe environment is Joeys apartment kitchen table and laptop workspace, with implied Smiling Oaks Dental automation result\./gi, "The environment is Joey's apartment kitchen table and laptop workspace.")
        .replace(/\bIntentional controlled manga panel layout allowed for this communication beat:[^.]+\./gi, "")
        .replace(/\bIntentional controlled manga panel layout allowed here:[^.]+\./gi, "")
        .replace(/\bRemote caller is not visible as a person; show only a tiny blank circular contact silhouette, envelope icons, phone UI shapes, or abstract call-flow cards\./gi, "")
        .replace(/\bNo human portraits inside any UI panel, no remote office scene, no extra sales prospects visible; remote identity is only a blank circular silhouette contact icon\./gi, "")
        .replace(/\bClean controlled manga panel borders are allowed only to separate the planned device\/UI panels\./gi, "Use one continuous full-frame composition without manga panel borders.")
        .replace(/\bNo speech bubbles, no captions, no captions\b/gi, "No speech bubbles, no captions");
    };
    if (/\b(?:charged fifteen hundred|setup and three hundred|said the price|almost apologized)\b/i.test(beat)) {
      priceBase("The image depicts one price-holding moment: overweight Joey sits at his apartment desk with phone and laptop invoice open, stopping himself before apologizing while a small red system warning glow appears beside the phone.");
      next += " Single location: apartment desk only. One physical Joey, phone, laptop invoice, notebook, and red warning glow; no payment received moment, no crying scene, no automation workflow result, no remote person.";
    } else if (/\b(?:discount impulse|state price and remain silent|stayed silent)\b/i.test(beat)) {
      priceBase("The image depicts one silent self-control moment: overweight Joey keeps his mouth shut after naming the price, hand clenched near the phone, red system warning glow floating beside the laptop.");
      next += " Single location: apartment desk only. One physical Joey holding still near phone and laptop; no remote person, no speech bubble, no payment celebration, no automation workflow montage.";
    } else if (/\b(?:send the invoice|payment notification arrived|invoice|fifteen hundred dollars received)\b/i.test(beat)) {
      priceBase("The image depicts one first-payment proof moment: a phone or laptop payment notification glows on Joey's apartment desk while overweight Joey freezes behind it in quiet disbelief.");
      next += " Single location: apartment desk only. Payment notification is an abstract glowing card, Joey appears once behind it, no remote person, no crying scene, no workflow montage, no panel grid.";
    }
  }
  if (/\b(?:SALES INSTINCT|OPPORTUNITY RADAR|REVENUE LEAK|MONEY STATUS UPDATED|ASCENSION QUEST COMPLETE|NOT HELPLESS)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Show Joey holding his price, receiving fifteen hundred dollars, breaking emotionally from proof rather than revenge, and completing a rough but working missed-call automation by Day fourteen\./gi, "The image depicts one first-business-reward moment: overweight Joey sits at his apartment desk as blue and gold system reward light blooms beside the laptop and payment proof.")
      .replace(/\bShow Joey nearly apologizing after naming the price, then freezing as the red system warning tells him to stay silent\. After (?:Mara|remote prospect contact icon) agrees, Joey stares at the phone until the payment notification arrives and the system fills the screen with completion rewards\. He sits alone at the kitchen table crying quietly\. End on Day fourteen with a simple but functional automation chain: missed call, automatic text, patient clicks the link, appointment booked\./gi, "")
      .replace(/\bThe people in the frame are Joey Mercer, floating system interface, phone or laptop payment notification, automation workflow screen, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey Mercer; system reward glow, phone, laptop, and payment proof are object/UI elements.")
      .replace(/\bVisible objects include phone, invoice, payment notification, laptop, kitchen table, integrated naturally into the scene\./gi, "Visible objects include phone, laptop, notebook, payment proof glow, and abstract blue-gold system reward cards, integrated naturally into the scene.")
      .replace(/\bThe environment is Joeys apartment kitchen table and laptop workspace, with implied Smiling Oaks Dental automation result\./gi, "The environment is Joey's apartment kitchen table and laptop workspace.");
    next += " Single location: apartment desk only. One physical Joey reacting to payment/reward proof, no remote person, no crying closeup, no automation workflow montage, no panel grid.";
  }
  if (
    /\b(?:sat alone at my kitchen table and cried|quiet tears|not freedom|not revenge|proof is addictive|lived on promises)\b/i.test(beat)
    && !/\b(?:Day fourteen|system I built|missed call|automatic text|patient clicks|appointment booked|that thing|three appointments)\b/i.test(beat)
  ) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Show Joey holding his price, receiving fifteen hundred dollars, breaking emotionally from proof rather than revenge, and completing a rough but working missed-call automation by Day fourteen\./gi, "The image depicts one quiet proof-tears moment: overweight Joey sits alone at the apartment kitchen table, eyes wet but controlled, with the first payment glow fading on the phone beside his hand.")
      .replace(/\bShow Joey nearly apologizing after naming the price, then freezing as the red system warning tells him to stay silent\. After (?:Mara|remote prospect contact icon) agrees, Joey stares at the phone until the payment notification arrives and the system fills the screen with completion rewards\. He sits alone at the kitchen table crying quietly\. End on Day fourteen with a simple but functional automation chain: missed call, automatic text, patient clicks the link, appointment booked\./gi, "")
      .replace(/\bThe people in the frame are Joey Mercer, floating system interface, phone or laptop payment notification, automation workflow screen, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey Mercer; phone, laptop, and fading system glow are object/UI elements.")
      .replace(/\bVisible objects include phone, invoice, payment notification, laptop, kitchen table, integrated naturally into the scene\./gi, "Visible objects include phone, laptop, kitchen table, notebook, and fading payment glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Joeys apartment kitchen table and laptop workspace, with implied Smiling Oaks Dental automation result\./gi, "The environment is Joey's apartment kitchen table and laptop workspace.");
    next += " Single location: apartment kitchen table only. One physical Joey, quiet tears, payment proof nearby, no remote person, no workflow montage, no panel grid.";
  }
  if (/\b(?:Day fourteen|system I built|missed call|automatic text|patient clicks|appointment booked|that thing|three appointments)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Show Joey holding his price, receiving fifteen hundred dollars, breaking emotionally from proof rather than revenge, and completing a rough but working missed-call automation by Day fourteen\./gi, "The image depicts one working-automation proof moment: Joey at his apartment laptop watches a simple missed-call workflow run successfully through abstract phone, text, booking-link, and appointment cards.")
      .replace(/\bThe image depicts one quiet proof-tears moment:[^.]+\./gi, "The image depicts one working-automation proof moment: Joey at his apartment laptop watches a simple missed-call workflow run successfully through abstract phone, text, booking-link, and appointment cards.")
      .replace(/\bShow Joey nearly apologizing after naming the price, then freezing as the red system warning tells him to stay silent\. After (?:Mara|remote prospect contact icon) agrees, Joey stares at the phone until the payment notification arrives and the system fills the screen with completion rewards\. He sits alone at the kitchen table crying quietly\. End on Day fourteen with a simple but functional automation chain: missed call, automatic text, patient clicks the link, appointment booked\./gi, "")
      .replace(/\bThe people in the frame are Joey Mercer, floating system interface, phone or laptop payment notification, automation workflow screen, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey Mercer; automation workflow cards are abstract object/UI elements.")
      .replace(/\bThe only visible person is Joey Mercer; phone, laptop, and fading system glow are object\/UI elements\./gi, "The only visible person is Joey Mercer; automation workflow cards are abstract object/UI elements.")
      .replace(/\bVisible objects include phone, invoice, payment notification, laptop, kitchen table, integrated naturally into the scene\./gi, "Visible objects include laptop, phone, abstract workflow cards, notebook, and booking confirmation glow, integrated naturally into the scene.")
      .replace(/\bVisible objects include phone, laptop, kitchen table, notebook, and fading payment glow, integrated naturally into the scene\./gi, "Visible objects include laptop, phone, abstract workflow cards, notebook, and booking confirmation glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Joeys apartment kitchen table and laptop workspace, with implied Smiling Oaks Dental automation result\./gi, "The environment is Joey's apartment laptop workspace.");
    next += " Single location: apartment laptop workspace only. One physical Joey, abstract workflow cards, no remote clinic, no patient, no sales prospect, no crying scene, no panel grid.";
  }
  if (/\b(?:Mara called me the next day|referred me|Day thirty|five clients|twenty-two pounds|my face looked different|shirts fit|bathroom mirror|DAY THIRTY ASCENSION REPORT|QUIETLY RISING|NO-CONTACT STREAK)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Show Joeys first concrete transformation milestone: new clients, early recurring revenue, visible weight loss, and the system validating his progress through a mirror report\./gi, "The image depicts one Day 30 bathroom mirror milestone: cleaner, slimmer-but-still-overweight Joey faces the modest bathroom mirror with a calm expression while blue system progress glow reflects beside him.")
      .replace(/\bBegin with Joey holding his phone as Maras call confirms new appointments, then cut through quick referral-chain business flashes before landing on Joey in the bathroom mirror, studying his slimmer face and the glowing system report reflected over the glass\./gi, "")
      .replace(/\bThe people in the frame are Joey, system interface, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; the blue system progress glow is an abstract UI element.")
      .replace(/\bVisible objects include phone, bathroom mirror, scale, client notes, laptop or small workstation, integrated naturally into the scene\./gi, "Visible objects include bathroom mirror, scale, towel, sink, and blue system progress glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Joeys bathroom and small apartment workspace, with implied montage flashes of client referrals\./gi, "The environment is Joey's modest bathroom.")
      .replace(/\bIntentional controlled manga panel layout allowed for this communication beat:[^.]+\./gi, "")
      .replace(/\bRemote caller is not visible as a person; show only a tiny blank circular contact silhouette, envelope icons, phone UI shapes, or abstract call-flow cards\./gi, "")
      .replace(/\bSingle location: modest apartment kitchen table only,[^.]+\./gi, "")
      .replace(/\bSingle location: apartment laptop workspace only,[^.]+\./gi, "")
      .replace(/\bSingle location: apartment laptop workspace only\.[^.]+\./gi, "");
    next += " Single location: modest bathroom only. One physical Joey and one flat mirror reflection aligned inside the mirror plane, no phone call, no referral montage, no extra client figures, no panel grid.";
  }
  if (/\b(?:Vivian called|Not texted|voicemail|watched her name|Once\. Twice\. Three times|did not forbid me from answering|let it ring|message appeared|played it once|Her voice|deleted it|SELF-RESPECT)\b/i.test(beat)) {
    openingSpecificRewrite = true;
    next = next
      .replace(/\bThe image depicts Frame Vivians call as a controlled emotional test, showing Joey resisting the old impulse to answer, listening once, and deleting the message without losing himself\./gi, "The image depicts one phone self-respect test moment: Joey sits alone at the apartment desk with his hand near the ringing phone, choosing control instead of begging.")
      .replace(/\bThe image depicts Frame the contact call as a controlled emotional test, showing Joey resisting the old impulse to answer, listening once, and deleting the message without losing himself\./gi, "The image depicts one phone self-respect test moment: Joey sits alone at the apartment desk with his hand near the ringing phone, choosing control instead of begging.")
      .replace(/\bShow the phone face-up with Vivians name pulsing, Joeys hand hovering but not touching it, then a close-up of his face as he listens to the voicemail once\. End with his thumb deleting it and the system reward appearing beside him\./gi, "")
      .replace(/\bShow the phone face-up with the contact name pulsing, Joeys hand hovering but not touching it, then a close-up of his face as he listens to the voicemail once\. End with his thumb deleting it and the system reward appearing beside him\./gi, "")
      .replace(/\bThe people in the frame are Joey, system interface, Vivian as phone contact only, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; the caller is only a blank contact icon on the phone.")
      .replace(/\bThe people in the frame are Joey, system interface, the contact as phone contact only, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; the caller is only a blank contact icon on the phone.")
      .replace(/\bVisible objects include smartphone, voicemail screen, work desk, system mission overlay, integrated naturally into the scene\./gi, "Visible objects include smartphone, apartment desk, laptop, notebook, and blue system self-respect glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Joeys apartment, near his phone and workstation\./gi, "The environment is Joey's apartment desk or quiet room.")
      .replace(/\bIntentional controlled manga panel layout allowed for this communication beat:[^.]+\./gi, "")
      .replace(/\bRemote caller is not visible as a person; show only a tiny blank circular contact silhouette, envelope icons, phone UI shapes, or abstract call-flow cards\./gi, "")
      .replace(/\bClean controlled manga panel borders are allowed only to separate the planned device\/UI panels\./gi, "Use one continuous full-frame composition without manga panel borders.")
      .replace(/\bSingle location: apartment dumpster exterior at night only,[^.]+\./gi, "");
    next += " Single location: apartment desk or quiet room only. One physical Joey, phone contact icon only, no visible caller, no spouse portrait, no duplicate face close-up, no dumpster, no gym, no panel grid.";
  }
  if (/\b(?:private group chat|screenshot from a private group chat|Preston had written|dentist bots?|Men like him|social humiliation|ELITE TARGET MOCKERY|OUTEARN PRESTON|monthly salary|first checkpoint)\b/i.test(beat + " " + next)) {
    next = next
      .replace(/\bThe image depicts Turn social humiliation into a mission unlock: Joey reads Prestons private insult, feels old shame rising, then sees the system convert it into a financial target\./gi, "The image depicts one private-chat mockery reaction: Joey alone at his apartment desk reads a phone screenshot, steadies his breathing, and watches a blue system target glow appear beside the desk.")
      .replace(/\bStage Joey seated alone in a dim room, phone glowing in his hand as the mocking chat text appears\. His jaw tightens and fingers tremble, then a large system warning panel opens in the air, replacing shame with a cold target number\./gi, "Stage one local room only: Joey seated at the desk, phone glow on his hand, jaw tight, system target glow hovering with abstract number bars and no readable text.")
      .replace(/\bThe people in the frame are Joey, system interface, Leah as message sender only, Preston as private chat text only, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; Leah and Preston are not shown as people, portraits, panels, or office figures, only implied by abstract device notifications.")
      .replace(/\bVisible objects include smartphone, private group chat screenshot, dark apartment desk, system mission panel, integrated naturally into the scene\./gi, "Visible objects include smartphone, abstract chat-card shapes, dark apartment desk, laptop, notebook, and blue system mission glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Joeys apartment at night, lit by phone and system UI\./gi, "The environment is Joey's apartment desk at night, lit by phone glow and system UI.")
      .replace(/\bVisible location: dental practice office[^.]+\./gi, "")
      .replace(/\bLocation guardrail: every visible environmental cue reinforces a dental practice:[^.]+\./gi, "")
      .replace(/\bIntentional controlled manga panel layout allowed for this communication beat:[^.]+\./gi, "")
      .replace(/\bRemote caller is not visible as a person; show only a tiny blank circular contact silhouette, envelope icons, phone UI shapes, or abstract call-flow cards\./gi, "")
      .replace(/\bClean controlled manga panel borders are allowed only to separate the planned device\/UI panels\./gi, "Use one continuous full-frame composition without manga panel borders.");
    next += " Private remote-insult rule: one physical Joey in his apartment only; no Preston body, no Leah body, no dental office, no customer office, no phone portrait, no split panel. Device content is abstract unreadable cards/icons only. System slogans, mission names, target numbers, and checkpoint phrases must be represented as blue bars, arrows, graphs, locks, and glow symbols only; no bottom subtitle strip, no readable UI wording, no white text lines.";
  }
  if (
    /\b(?:posted publicly|business account|entrepreneur after getting dumped|Do not respond online|public status reversal|Northbridge|event map|case-study evidence|twelve-minute talk)\b/i.test(beat + " " + next)
    && !/\b(?:speaker drop|practiced that talk|recorded myself|fixed my posture|hands moved|stood backstage|tailored suit|front row|presentation|introduced me as)\b/i.test(beat)
  ) {
    next = next
      .replace(/\bThe image depicts Convert Prestons online insult into a strategic mission path, showing the narrator choosing public status reversal instead of reacting online\./gi, "The image depicts one online-provocation strategy beat: Joey sits alone at his laptop, refusing to type a reply while a blue system path turns the public post into an event opportunity.")
      .replace(/\bShow Prestons business-account post on a screen, then the narrator sitting still instead of typing a reply\. The system identifies the provocation, opens a Northbridge event map, and the narrator sends case-study evidence to the organizer\. End on the organizers reply offering a twelve-minute talk\./gi, "Keep it local and abstract: laptop screen with unreadable public-post cards, map-like blue event pins, case-study document icons, and one calm hand away from the keyboard.")
      .replace(/\bThe people in the frame are narrator, Preston as public profile image or post avatar, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; Preston is not shown as a body, portrait, avatar face, or inset panel.")
      .replace(/\bVisible objects include laptop, business account post, digital map, email inbox, client case study notes, integrated naturally into the scene\./gi, "Visible objects include laptop, abstract unreadable public-post card, blue event-map pins, case-study folders, phone, and system mission glow, integrated naturally into the scene.")
      .replace(/\bThe environment is narrators work setup with laptop and system UI, transitioning through digital posts, map overlay, and email response\./gi, "The environment is Joey's apartment laptop workspace at night.")
      .replace(/\bVisible location: hotel conference-room small business summit[^.]+\./gi, "")
      .replace(/\bLocation guardrail: every visible environmental cue reinforces a public conference venue:[^.]+\./gi, "")
      .replace(/\bSingle location: modest bathroom only\.[^.]+\./gi, "Single location: apartment laptop workspace at night only.")
      .replace(/\bKeep the mirror solo:[^.]+\./gi, "")
      .replace(/\bNo speech bubbles, no captions, no captions, no written words, no lettering, no dialogue balloons, no title cards, no manga panel borders\./gi, "No speech bubbles, no captions, no written words, no lettering, no dialogue balloons, no title cards, no manga panel borders.");
    next += " Online provocation rule: one physical Joey only, no Preston portrait, no Vivian, no event stage yet, no office scene. Public post and event are abstract unreadable UI cards/icons beside the laptop.";
  }
  if (/\b(?:speaker drop|twelve-minute talk|GATE OPENED|practiced that talk|recorded myself|hated how I sounded|fixed my posture|hands moved|practiced with them still)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts Show the narrator transforming discomfort into stage readiness, then arriving backstage as a leaner founder facing Vivian and Preston in the audience\./gi, "The image depicts one speaking-preparation beat: Joey practices a business talk alone, recording himself and correcting posture with focused discipline.")
      .replace(/\bUse a montage of the narrator recording himself, correcting posture, stilling his hands, and repeating the talk while exhausted\. Cut to Day eighty-two backstage, where he adjusts his first tailored suit and sees Vivian beside Preston in the front row\. Vivian reacts with parted lips while Preston leans in to whisper\./gi, "Keep only the current preparation moment: Joey alone with phone camera or mirror, notes, laptop, and controlled hand posture. Do not show the summit audience yet.")
      .replace(/\bThe people in the frame are narrator, Vivian, Preston, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; Vivian and Preston are not present during practice.")
      .replace(/\bVisible objects include phone or camera for self-recording, mirror, tailored suit, backstage curtain, summit seating, integrated naturally into the scene\./gi, "Visible objects include phone or camera for self-recording, mirror or laptop camera, presentation notes, simple apartment furniture, and blue system readiness glow, integrated naturally into the scene.")
      .replace(/\bThe environment is practice space and backstage at the Northbridge hotel\./gi, "The environment is Joey's apartment practice space.")
      .replace(/\bVisible location: hotel conference-room small business summit[^.]+\./gi, "")
      .replace(/\bLocation guardrail: every visible environmental cue reinforces a public conference venue:[^.]+\./gi, "")
      .replace(/\bSingle location: apartment laptop workspace only\.[^.]+\./gi, "Single location: apartment practice space only, with phone camera, mirror or laptop, notes, and no audience.")
      .replace(/\bOnline provocation rule:[^.]+\./gi, "");
    next += " Speaking-practice rule: one physical Joey only, no Vivian, no Preston, no front row, no audience, no backstage curtain unless the excerpt explicitly says backstage. Show practice through phone camera, mirror, notes, posture, and still hands.";
  }
  if (/\b(?:stood backstage|Northbridge hotel|first tailored suit|backstage)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts one speaking-preparation beat: Joey practices a business talk alone, recording himself and correcting posture with focused discipline\./gi, "The image depicts one backstage arrival beat: Joey stands backstage at the Northbridge hotel in his first tailored suit, steadying his hands before speaking.")
      .replace(/\bThe image depicts Show the narrator transforming discomfort into stage readiness, then arriving backstage as a leaner founder facing Vivian and Preston in the audience\./gi, "The image depicts one backstage arrival beat: Joey stands backstage at the Northbridge hotel in his first tailored suit, steadying his hands before speaking.")
      .replace(/\bKeep only the current preparation moment: Joey alone with phone camera or mirror, notes, laptop, and controlled hand posture\. Do not show the summit audience yet\./gi, "Keep only the backstage moment: tailored suit, curtain edge, stage light spill, presentation notes, and Joey's controlled posture. Do not show front-row reactions unless the excerpt explicitly says he sees them.")
      .replace(/\bUse a montage of the narrator recording himself, correcting posture, stilling his hands, and repeating the talk while exhausted\. Cut to Day eighty-two backstage, where he adjusts his first tailored suit and sees Vivian beside Preston in the front row\. Vivian reacts with parted lips while Preston leans in to whisper\./gi, "Keep only the backstage moment: tailored suit, curtain edge, stage light spill, presentation notes, and Joey's controlled posture. Do not show front-row reactions unless the excerpt explicitly says he sees them.")
      .replace(/\bThe people in the frame are narrator, Vivian, Preston, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; Vivian and Preston are not visible in this backstage beat.")
      .replace(/\bThe only visible person is Joey; Vivian and Preston are not present during practice\./gi, "The only visible person is Joey; Vivian and Preston are not visible in this backstage beat.")
      .replace(/\bVisible objects include phone or camera for self-recording, mirror or laptop camera, presentation notes, simple apartment furniture, and blue system readiness glow, integrated naturally into the scene\./gi, "Visible objects include tailored suit, backstage curtain, presentation notes, stage light spill, and blue system readiness glow, integrated naturally into the scene.")
      .replace(/\bVisible objects include phone or camera for self-recording, mirror, tailored suit, backstage curtain, summit seating, integrated naturally into the scene\./gi, "Visible objects include tailored suit, backstage curtain, presentation notes, stage light spill, and blue system readiness glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Joey's apartment practice space\./gi, "The environment is backstage at the Northbridge hotel.")
      .replace(/\bThe environment is practice space and backstage at the Northbridge hotel\./gi, "The environment is backstage at the Northbridge hotel.")
      .replace(/\bOnline provocation rule:[^.]+\./gi, "")
      .replace(/\bSpeaking-practice rule:[^.]+\./gi, "");
    next += " Backstage rule: one physical Joey only, no Vivian, no Preston, no audience reaction yet, no apartment desk. Stage cues must read as backstage: curtain edge, stage light spill, suit, notes.";
  }
  if (
    /\b(?:two hundred four pounds|Forty-six pounds gone|BODY:\s*sixty|DISCIPLINE:\s*seventy|STATUS:\s*EMERGING FOUNDER)\b/i.test(beat)
    && !/\b(?:front row beside Preston|mouth parted|Preston leaned|She did not laugh|better than applause)\b/i.test(beat)
  ) {
    next = next
      .replace(/\bThe image depicts Show the narrator transforming discomfort into stage readiness, then arriving backstage as a leaner founder facing (?:Vivian|the absent spouse) and Preston in the audience\./gi, "The image depicts one backstage body-and-status beat: Joey in his first tailored suit stands near a curtain edge as a blue abstract stat glow confirms his transformation.")
      .replace(/\bUse a montage of the narrator recording himself, correcting posture, stilling his hands, and repeating the talk while exhausted\. Cut to Day eighty-two backstage, where he adjusts his first tailored suit and sees (?:Vivian|the absent spouse) beside Preston in the front row\. (?:Vivian|the absent spouse) reacts with parted lips while Preston leans in to whisper\./gi, "Keep only Joey backstage with suit, posture, presentation notes, and abstract stat bars. Do not show the audience, Vivian, or Preston yet.")
      .replace(/\bThe people in the frame are narrator, (?:Vivian|the absent spouse), Preston, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; audience figures, Vivian, and Preston are not visible in this stat beat.")
      .replace(/\bVisible objects include phone or camera for self-recording, mirror, tailored suit, backstage curtain, summit seating, integrated naturally into the scene\./gi, "Visible objects include tailored suit, backstage curtain, presentation notes, abstract blue stat bars, and stage light spill, integrated naturally into the scene.")
      .replace(/\bThe environment is practice space and backstage at the Northbridge hotel\./gi, "The environment is backstage at the Northbridge hotel.")
      .replace(/\bSingle location: apartment laptop workspace at night only\./gi, "")
      .replace(/\bOnline provocation rule:[^.]+\./gi, "");
    next += " Backstage stat rule: one physical Joey only, no Vivian, no Preston, no front-row audience, no apartment laptop, no practice montage. Blue stats are abstract bars only.";
  }
  if (/\b(?:front row beside Preston|mouth parted|Preston leaned|She did not laugh|better than applause)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts one backstage body-and-status beat: Joey in his first tailored suit stands near a curtain edge as a blue abstract stat glow confirms his transformation\./gi, "The image depicts one front-row recognition beat: Joey stands at the stage edge or backstage opening while Vivian and Preston sit together in the front row and react to his changed presence.")
      .replace(/\bThe image depicts Show the narrator transforming discomfort into stage readiness, then arriving backstage as a leaner founder facing (?:Vivian|the absent spouse) and Preston in the audience\./gi, "The image depicts one front-row recognition beat: Joey stands at the stage edge or backstage opening while Vivian and Preston sit together in the front row and react to his changed presence.")
      .replace(/\bKeep only Joey backstage with suit, posture, presentation notes, and abstract stat bars\. Do not show the audience, Vivian, or Preston yet\./gi, "Keep only the summit front-row moment: Joey in foreground or stage edge, Vivian seated with surprised restraint, Preston leaning in with a tight expression, audience rows around them.")
      .replace(/\bUse a montage of the narrator recording himself, correcting posture, stilling his hands, and repeating the talk while exhausted\. Cut to Day eighty-two backstage, where he adjusts his first tailored suit and sees (?:Vivian|the absent spouse) beside Preston in the front row\. (?:Vivian|the absent spouse) reacts with parted lips while Preston leans in to whisper\./gi, "Keep only the summit front-row moment: Joey in foreground or stage edge, Vivian seated with surprised restraint, Preston leaning in with a tight expression, audience rows around them.")
      .replace(/\bThe only visible person is Joey; audience figures, Vivian, and Preston are not visible in this stat beat\./gi, "The visible named people are Joey, Vivian, and Preston only, all separated clearly in the summit room.")
      .replace(/\bThe people in the frame are narrator, (?:Vivian|the absent spouse), Preston, arranged with clean separation and distinct faces\./gi, "The visible named people are Joey, Vivian, and Preston only, all separated clearly in the summit room.")
      .replace(/\bVisible objects include tailored suit, backstage curtain, presentation notes, abstract blue stat bars, and stage light spill, integrated naturally into the scene\./gi, "Visible objects include stage edge, front-row chairs, presentation screen glow, Vivian's phone or program, and audience seating, integrated naturally into the scene.")
      .replace(/\bVisible objects include phone or camera for self-recording, mirror, tailored suit, backstage curtain, summit seating, integrated naturally into the scene\./gi, "Visible objects include stage edge, front-row chairs, presentation screen glow, Vivian's phone or program, and audience seating, integrated naturally into the scene.")
      .replace(/\bThe environment is backstage at the Northbridge hotel\./gi, "The environment is the Northbridge summit room with front-row audience seating.")
      .replace(/\bThe environment is practice space and backstage at the Northbridge hotel\./gi, "The environment is the Northbridge summit room with front-row audience seating.")
      .replace(/\bSingle location: treadmill row only[^.]*\./gi, "")
      .replace(/\bJoey appears once on the treadmill near the glowing display; background gym men are visually distinct and secondary\./gi, "")
      .replace(/\bPublic post and event are abstract unreadable UI cards\/icons beside the laptop\./gi, "")
      .replace(/\bBackstage stat rule:[^.]+\./gi, "")
      .replace(/\bOnline provocation rule:[^.]+\./gi, "");
    next += " Front-row summit rule: Joey, Vivian, and Preston may appear once each; no gym, no treadmill, no apartment laptop, no practice montage, no duplicate Joey.";
  }
  if (/\b(?:host introduced me|founder of Mercer Systems|for twelve minutes|business owners|money leaking out|missed calls|response times|people started taking notes|OPPORTUNITY RADAR|High-intent prospect|Harrow Medical)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts Show the narrator earning authority through practical business insight as the room shifts from skepticism to attention\./gi, "The image depicts one summit presentation authority beat: Joey speaks onstage with calm confidence while business owners in the audience take notes.")
      .replace(/\bFrame the narrator onstage explaining missed calls, inboxes, reviews, and follow-ups while audience members gradually quiet and begin taking notes\. The system subtly highlights high-intent prospects and identifies Harrow Medical Aesthetics as a dissatisfied Blackwell client\./gi, "Keep only the stage presentation moment: Joey at microphone, presentation screen with abstract workflow icons, audience taking notes, subtle blue opportunity highlights over a few audience seats.")
      .replace(/\bThe people in the frame are narrator, business owners, auto clinic owner, orthodontic group CFO, Harrow Medical Aesthetics director, arranged with clean separation and distinct faces\./gi, "The visible people are Joey onstage and varied business-owner audience members seated below; prospects are subtle highlighted audience silhouettes, not named portrait panels.")
      .replace(/\bVisible objects include stage microphone, presentation screen, notebooks, phones, conference chairs, integrated naturally into the scene\./gi, "Visible objects include stage microphone, presentation screen with abstract workflow icons, notebooks, phones, audience chairs, and blue opportunity highlights, integrated naturally into the scene.")
      .replace(/\bVisible location: modest apartment[^.]+\./gi, "")
      .replace(/\bLocation guardrail: every visible environmental cue reinforces a modest home interior:[^.]+\./gi, "")
      .replace(/\bSingle location: treadmill row only[^.]*\./gi, "")
      .replace(/\bSingle location: apartment desk only[^.]*\./gi, "");
    next = next
      .replace(/\bOne physical Joey reacting to payment\/reward proof, no remote person, no crying closeup, no automation workflow montage, no panel grid\./gi, "")
      .replace(/\bJoey is alone; no coworker, no support office, no cubicles, no headset, no gym\./gi, "");
    next += " Summit presentation rule: stage and audience only, no apartment, no gym, no treadmill, no payment desk, no vending machines. Joey appears once at the front.";
  }
  if (/\b(?:Preston raised his hand|PUBLIC CHALLENGE|ANSWER WITHOUT DEFENSIVENESS|Preston.?s smile tightened|Silence\. Then applause|PUBLIC REPUTATION REVERSAL|business owners lined up|Preston stood near the back|Vivian watched me)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts Show the narrator calmly defeating Preston in public, converting the event into contracts, then unlocking ownership-focused opportunities\./gi, "The image depicts one summit Q&A confrontation beat: Joey stands calmly onstage while Preston stands in the audience challenging him, and the room watches the exchange.")
      .replace(/\bPreston stands during Q&A with a polished smile and dismissive question\. The narrator waits one second, answers without defensiveness, names Harrow Medicals missed leads, and frames automation as leadership problem-solving\. The room turns silent, then applauds\. Follow with business owners lining up, Preston isolated at the back pretending to check his phone, the contact watching with regret, then a late-night system screen showing revenue milestones and the first vending-route asset opportunity\./gi, "Keep only the Q&A confrontation moment: Preston standing with a polished challenge posture, Joey onstage composed, audience turning toward Harrow's table, blue system confidence glow near Joey.")
      .replace(/\bThe people in the frame are narrator, Preston, the contact, Harrow Medical Aesthetics director, business owners, arranged with clean separation and distinct faces\./gi, "The visible people are Joey onstage, Preston standing in the audience, and varied business-owner audience members; Vivian may be seated as one separate woman only if visible in the front row.")
      .replace(/\bVisible objects include stage microphone, audience chairs, phones, business cards, contract documents, integrated naturally into the scene\./gi, "Visible objects include stage microphone, audience chairs, phones, notebooks, presentation screen, and subtle blue system confidence glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Northbridge summit Q&A, event networking area, then narrators late-night workspace with asset maps\./gi, "The environment is the Northbridge summit Q&A room.")
      .replace(/\bVisible location: vending route location[^.]+\./gi, "")
      .replace(/\bLocation guardrail: every visible environmental cue reinforces vending-route operations:[^.]+\./gi, "")
      .replace(/\bSingle location: apartment dumpster exterior at night only,[^.]+\./gi, "")
      .replace(/\bSingle location: modest apartment kitchen table only,[^.]+\./gi, "")
      .replace(/\bSingle location: apartment laptop workspace only\.[^.]+\./gi, "")
      .replace(/\bPrivate remote-insult rule:[^.]+\./gi, "");
    next = next
      .replace(/\bJoey is alone; no coworker, no support office, no cubicles, no headset, no gym\./gi, "")
      .replace(/\bUI cards use icons and abstract glyphs, not human faces\./gi, "")
      .replace(/\bExactly one physical Joey across the entire image;[^\n]+?second body of Joey in another panel\./gi, "Exactly one physical Joey across the entire image; Preston appears once as a separate man in the audience.")
      .replace(/\bDevice content is abstract unreadable cards\/icons only\./gi, "")
      .replace(/\bSystem slogans, mission names, target numbers, and checkpoint phrases must be represented as blue bars, arrows, graphs, locks, and glow symbols only; no bottom subtitle strip, no readable UI wording, no white text lines\./gi, "")
      .replace(/\bJoey progression state: mid-transformation asset operator[^.]*\./gi, "Joey progression state: emerging founder, noticeably slimmer than the opening but not final, clean grooming, fitted black jacket or practical business-casual clothes, focused speaker authority.");
    next += " Summit Q&A rule: stage/audience only, no vending machines, no apartment, no dumpster, no late-night asset map, no client-contract montage. Joey and Preston appear once each.";
    next += " Q&A must be silent body language only: Preston raises his hand and stands with a challenging posture, but no speech bubble, no white balloon shape, no floating question text, no readable quote, no dialogue card.";
  }
  if (/\b(?:Investors|Current profit|Projected profit|Strategic value|route economics|cash-flow acquisition|beneath the revenge fantasy|wanted software|skyscrapers|Preston.?s office|system displayed one line|SMALL ASSETS|LARGE ONES)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts Show the protagonist accepting an unglamorous but practical asset lesson, negotiating the vending route, physically improving the machines, and receiving system confirmation as cash flow begins to work\./gi, "The image depicts one early vending-opportunity analysis beat: Joey studies an unglamorous vending machine route as blue financial projection glyphs hover beside the machines.")
      .replace(/\bBegin with system financial projections hovering over dull vending machines, then show negotiation with the tired seller, moving machines, replacing inventory, installing card readers, and ending on the protagonist beside a clean machine as the system reward appears\./gi, "Keep only the analysis moment: dull vending machines, simple projection glow, Joey weighing the practical asset lesson. Do not show negotiation, relocation, customers, or final reward yet.")
      .replace(/\bThe people in the frame are protagonist, tired vending route seller, gym customers, medical office staff, system UI, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; all other business context appears as machines, inventory boxes, and abstract system projection icons.")
      .replace(/\bVisible objects include vending machines, stale snack inventory, protein snacks and drinks, card readers, purchase agreement, integrated naturally into the scene\./gi, "Visible objects include vending machines, stale snacks, card reader, inventory boxes, simple purchase folder, and blue projection glyphs, integrated naturally into the scene.")
      .replace(/\bThe environment is small-business montage across vending-machine locations: bad original locations, twenty-four-hour gym, medical office, and protagonists work area\./gi, "The environment is one quiet vending route location with snack machines.")
      .replace(/\bThe public reputation reversal is staged with presentation lights, business audience reactions, and confident speaker energy\./gi, "The asset-operator phase is practical, grounded, and hands-on, with vending machines, inventory, card readers, and cash-flow system glow.")
      .replace(/\bSingle full-frame composition, one continuous cinematic moment, no split-screen panels, no inset panels, no storyboard montage, no white dialogue bubbles, no speech balloons\./gi, "Single full-frame composition, one continuous vending-route moment, no split-screen panels, no inset panels, no storyboard montage, no white dialogue bubbles, no speech balloons.");
    next += " Early vending analysis rule: one Joey only, no seller, no customers, no medical staff, no gym crowd, no negotiation handshake, no relocation montage, no summit audience.";
  }
  if (/\b(?:bought the vending route|after negotiation|seller was tired|purchase agreement)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts Show the protagonist accepting an unglamorous but practical asset lesson, negotiating the vending route, physically improving the machines, and receiving system confirmation as cash flow begins to work\./gi, "The image depicts one vending-route purchase beat: Joey and a tired seller finalize a simple purchase agreement beside dull vending machines.")
      .replace(/\bBegin with system financial projections hovering over dull vending machines, then show negotiation with the tired seller, moving machines, replacing inventory, installing card readers, and ending on the protagonist beside a clean machine as the system reward appears\./gi, "Keep only the purchase/negotiation moment: Joey, one tired seller, a purchase folder, vending machines, and modest inventory boxes. Do not show relocation, gym customers, medical staff, or final reward yet.")
      .replace(/\bThe people in the frame are protagonist, tired vending route seller, gym customers, medical office staff, system UI, arranged with clean separation and distinct faces\./gi, "The visible people are Joey and one tired vending-route seller only; no customers or medical staff.")
      .replace(/\bVisible objects include vending machines, stale snack inventory, protein snacks and drinks, card readers, purchase agreement, integrated naturally into the scene\./gi, "Visible objects include vending machines, stale snack inventory, card reader, inventory boxes, and purchase agreement folder, integrated naturally into the scene.")
      .replace(/\bThe environment is small-business montage across vending-machine locations: bad original locations, twenty-four-hour gym, medical office, and protagonists work area\./gi, "The environment is one quiet vending route location with snack machines.")
      .replace(/\bThe public reputation reversal is staged with presentation lights, business audience reactions, and confident speaker energy\./gi, "The asset-operator phase is practical, grounded, and hands-on, with vending machines, inventory, card readers, and purchase paperwork.");
    next += " Vending purchase rule: one Joey and one seller only, no gym customers, no medical staff, no relocation montage, no clean final machine yet, no summit audience.";
  }
  if (/\b(?:machines were in bad locations|snacks were stale|card readers did not work|not glamorous|It was ownership)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts Show the protagonist accepting an unglamorous but practical asset lesson, negotiating the vending route, physically improving the machines, and receiving system confirmation as cash flow begins to work\./gi, "The image depicts one vending-route inspection beat: Joey studies the flawed machines and inventory problems with practical focus.")
      .replace(/\bBegin with system financial projections hovering over dull vending machines, then show negotiation with the tired seller, moving machines, replacing inventory, installing card readers, and ending on the protagonist beside a clean machine as the system reward appears\./gi, "Keep only the inspection/problem moment: bad machine placement, stale snacks, broken card reader, inventory boxes, and Joey evaluating what must be fixed. Do not show seller, customers, relocation, or final reward yet.")
      .replace(/\bThe people in the frame are protagonist, tired vending route seller, gym customers, medical office staff, system UI, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; machines and inventory show the problem.")
      .replace(/\bThe environment is small-business montage across vending-machine locations: bad original locations, twenty-four-hour gym, medical office, and protagonists work area\./gi, "The environment is one quiet, unimpressive vending location.")
      .replace(/\bThe public reputation reversal is staged with presentation lights, business audience reactions, and confident speaker energy\./gi, "The asset-operator phase is practical, grounded, and hands-on, with vending machines, inventory, card readers, and cash-flow system glow.");
    next += " Vending inspection rule: one Joey only, no seller, no customers, no medical staff, no gym crowd, no relocation montage, no final clean machine yet.";
  }
  if (/\b(?:stopped acting like a freelancer|started acting like an owner|What system can I sell repeatedly|rebuilt everything|offer became sharper|Missed-call recovery|A I receptionist|C R M cleanup|Review automation|Lead follow-up|Reactivation campaign|revenue recovery system)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts Show Joey professionalizing the business, raising prices, enduring rejection, learning to sell value, and rapidly stacking clients\./gi, "The image depicts one offer-building strategy moment: slimmer Joey works at his apartment laptop, reorganizing proposal cards and automation-flow diagrams into a sharper repeatable service offer.")
      .replace(/\bUse a compressed montage: Joey rewriting offer copy, crossing out old pricing, enduring a laugh and a hang-up, then calmly asking the roofing owner about missed leads\. The scene peaks on the owner signing, followed by fast flashes of a plumber, med spa upgrade, and dentist group introduction\./gi, "Keep the moment local and strategic: Joey at one desk, laptop open, proposal pages spread out, abstract service modules arranged like cards, blue system glow sharpening the plan.")
      .replace(/\bThe people in the frame are Joey, roofing company owner, plumber, med spa owner, Mara, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; customers are represented only by abstract industry icons or unsigned proposal cards, not by bodies or portraits.")
      .replace(/\bThe people in the frame are Joey, roofing company owner, plumber, med spa owner, remote prospect contact icon, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; remote prospects are represented only by abstract industry icons or blank contact cards, not by bodies or portraits.")
      .replace(/\bVisible objects include laptop, CRM dashboard, sales call headset, proposal documents, contract, integrated naturally into the scene\./gi, "Visible objects include laptop, proposal pages, automation-flow cards, pricing notebook, phone on desk, and blue system planning glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Montage across Joeys apartment workspace, sales calls, small business offices, and client meetings\./gi, "The environment is Joey's apartment laptop workspace.")
      .replace(/\bVisible location: dental practice office[^.]+\./gi, "")
      .replace(/\bLocation guardrail: every visible environmental cue reinforces a dental practice:[^.]+\./gi, "");
    next += " Offer-building rule: single local apartment workspace, exactly one Joey, no client meeting, no signing handshake, no customer bodies, no office montage, no gym, no duplicate Joey. Abstract UI/service cards may use controlled manga panel borders if needed, but every small panel is graphic-only.";
  }
  if (/\b(?:stopped charging|New price|first time|second time|prospect laughed|someone hung up|roofing company owner|SALES INSTINCT|Hidden objection|one roof worth|leads do you miss|one extra job|He signed|CLOSE COMPLETE|MONEY: plus five thousand)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts Show Joey professionalizing the business, raising prices, enduring rejection, learning to sell value, and rapidly stacking clients\./gi, "The image depicts one remote high-ticket sales beat: emerging-founder Joey works from his apartment desk, holding firm on pricing while abstract phone, roof, rejection, and contract-status icons orbit the blue system glow.")
      .replace(/\bUse a compressed montage: Joey rewriting offer copy, crossing out old pricing, enduring a laugh and a hang-up, then calmly asking the roofing owner about missed leads\. The scene peaks on the owner signing, followed by fast flashes of a plumber, med spa upgrade, and dentist group introduction\./gi, "Keep it as one local remote-sales moment: phone on speaker, proposal page, pricing notebook, roof-shaped business icon, and abstract accept/reject cards. The remote prospect is never visible as a person.")
      .replace(/\bThe people in the frame are Joey, roofing company owner, plumber, med spa owner, Mara, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; the roofing prospect is represented only by an abstract roof/contact icon, not by a body or portrait.")
      .replace(/\bVisible objects include laptop, CRM dashboard, sales call headset, proposal documents, contract, integrated naturally into the scene\./gi, "Visible objects include laptop, phone, proposal document, pricing notebook, abstract roof/contact icon, accept/reject cards, and blue system sales glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Montage across Joeys apartment workspace, sales calls, small business offices, and client meetings\./gi, "The environment is Joey's apartment desk during a remote sales call.")
      .replace(/\bSingle location: modest apartment kitchen table only,[^.]+\./gi, "Single location: apartment desk during remote sales call only, with phone, laptop, proposal, pricing notebook, and abstract sales cards.")
      .replace(/\bSingle location: apartment desk only\. One physical Joey reacting to payment\/reward proof, no remote person, no crying closeup, no automation workflow montage, no panel grid\./gi, "Single location: apartment desk during remote sales call only. One physical Joey, no remote person, no client body, no customer portrait, no handshake, no office montage, no panel grid.");
    next += " Remote sales rule: exactly one physical Joey in the local apartment workspace; represent all prospects as abstract business/contact icons and contract cards only. No roofing owner body, no plumber body, no med spa owner body, no Mara portrait, no customer office, no handshake.";
  }
  if (/\b(?:plumber signed|med spa upgraded|dentist group|six locations|worked like a man trying to outrun a ghost)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts Show Joey professionalizing the business, raising prices, enduring rejection, learning to sell value, and rapidly stacking clients\./gi, "The image depicts one client-stack momentum beat: Joey at his apartment workspace as abstract industry contract cards stack up around the laptop.")
      .replace(/\bUse a compressed montage: Joey rewriting offer copy, crossing out old pricing, enduring a laugh and a hang-up, then calmly asking the roofing owner about missed leads\. The scene peaks on the owner signing, followed by fast flashes of a plumber, med spa upgrade, and dentist group introduction\./gi, "Use a single full-frame desk composition: Joey works at his real apartment desk while simple icon-only contract cards stack on the desk or hover as abstract holograms, such as wrench icon, spa sparkle icon, dental location icon, checkmarks, and abstract contract cards.")
      .replace(/\bThe people in the frame are Joey, roofing company owner, plumber, med spa owner, Mara, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; plumber, med spa, dental group, and referrer are represented only by abstract industry icons and contract cards.")
      .replace(/\bVisible objects include laptop, CRM dashboard, sales call headset, proposal documents, contract, integrated naturally into the scene\./gi, "Visible objects include laptop, proposal stack, contract cards, phone, notebook, abstract industry icons, and blue system momentum glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Montage across Joeys apartment workspace, sales calls, small business offices, and client meetings\./gi, "The environment is Joey's apartment workspace.")
      .replace(/\bNo speech bubbles, no captions, no captions, no written words, no lettering, no dialogue balloons, no title cards, no manga panel borders\./gi, "No speech bubbles, no captions, no written words, no lettering, no dialogue balloons, no title cards, no manga panel borders.")
      .replace(/\bClean controlled manga panel borders are allowed only to separate the planned graphic contract panels\./gi, "");
    next += " Client-stack rule: one physical Joey only; no client bodies, no portraits, no offices, no handshakes, no manga panels, no inset panels, no comic boxes. Use icon-only contract cards as objects or holograms in the same modest apartment workspace.";
    next += " Apartment environment lock: show domestic window light, bookshelf or kitchen shelf, personal desk clutter, and residential furniture; no fluorescent office ceiling, no cubicle room, no clinic lobby, no conference room.";
    next += " Contract cards must be icon-only: no white speech bubbles, no handwritten note boxes, no readable paragraphs, no office room inside a panel, no people icons that look like real characters.";
  }
  if (/\b(?:Wake at four-thirty|Sales calls at lunch|Client builds at night|Meal prep at midnight|Walks when cravings hit|Day forty-seven|body broke|floor beside my bed|shoes in my hand|unable to stand|Everything hurt|One day off|FATIGUE LIMIT|Recovery mission|recover like an athlete|SUSTAINABILITY|pain and damage|trained better|Sleep eight hours|Stretch twenty minutes|Eat clean|No guilt spiral)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts Complete the chunk with Joey hitting exhaustion, learning sustainable recovery, quitting his old job, and meeting (?:Vivian|the absent spouse) as a visibly changed man outside the courthouse coffee shop\./gi, "The image depicts one self-improvement routine or fatigue-management beat with Joey alone, showing discipline turning into sustainable recovery.")
      .replace(/\bOpen with fast routine fragments, then slow abruptly as Joey sits on the bedroom floor holding his shoes, unable to stand\. After the recovery mission, show him training better, packing his desk into one cardboard box, leaving the headset behind, and standing outside the courthouse coffee shop in fitted jeans and a black jacket as (?:Vivian|the absent spouse) freezes and visually scans his changed face, shoulders, and waist\./gi, "Keep only the current routine/recovery moment: Joey alone with the relevant props such as shoes, bed, meal prep containers, laptop, gym bag, water bottle, or blue recovery system glow.")
      .replace(/\bThe people in the frame are Joey, Darren, Vivian, system interface, support job manager as implied\/offscreen, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; the system interface is an abstract blue holographic glow.")
      .replace(/\bThe people in the frame are Joey, Darren, the absent spouse, system interface, support job manager as implied\/offscreen, arranged with clean separation and distinct faces\./gi, "The only visible person is Joey; the system interface is an abstract blue holographic glow.")
      .replace(/\bVisible objects include bed, shoes, meal prep containers, support job headset, cardboard box, integrated naturally into the scene\./gi, "Visible objects include only the current routine props: bed, shoes, water bottle, meal prep containers, laptop, phone alarm, or blue recovery glow as appropriate.")
      .replace(/\bThe environment is Joeys bedroom, gym, support-job office, and courthouse coffee shop exterior\./gi, "The environment is Joey's modest bedroom or apartment routine space.")
      .replace(/\bVisible location: dead-end customer support office[^.]+\./gi, "")
      .replace(/\bLocation guardrail: every visible environmental cue reinforces a customer support workplace:[^.]+\./gi, "")
      .replace(/\bSingle location: modest bathroom only\.[^.]+\./gi, "Single location: modest bedroom or apartment routine space only.")
      .replace(/\bKeep the mirror solo:[^.]+\./gi, "")
      .replace(/\bSingle location: modest bedroom only,[^.]+\./gi, "Single location: modest bedroom or apartment routine space only, with bed, shoes, phone alarm, meal prep, laptop, water bottle, or blue recovery glow.");
    next += " Routine/recovery rule: one physical Joey only, no Vivian, no Darren, no manager, no courthouse coffee shop, no support office, no future quitting scene, no bathroom mirror unless the current excerpt explicitly says mirror.";
  }
  if (/\b(?:quit the support job|packed my desk|cardboard box|Darren|headset on my desk|LEAVE DEAD-END IDENTITY|FULL-TIME OPERATOR|coffin with benefits|I'm sure|I’m sure)\b/i.test(beat)) {
    next = next
      .replace(/\bThe image depicts Complete the chunk with Joey hitting exhaustion, learning sustainable recovery, quitting his old job, and meeting (?:Vivian|the absent spouse) as a visibly changed man outside the courthouse coffee shop\./gi, "The image depicts one support-job exit beat: emerging-founder Joey calmly packs his old support desk into a cardboard box and leaves the headset behind.")
      .replace(/\bOpen with fast routine fragments, then slow abruptly as Joey sits on the bedroom floor holding his shoes, unable to stand\. After the recovery mission, show him training better, packing his desk into one cardboard box, leaving the headset behind, and standing outside the courthouse coffee shop in fitted jeans and a black jacket as (?:Vivian|the absent spouse) freezes and visually scans his changed face, shoulders, and waist\./gi, "Keep only the current support-office resignation moment: Joey, his box, the abandoned headset, cubicle row, and possibly Darren nearby reacting silently.")
      .replace(/\bThe people in the frame are Joey, Darren, Vivian, system interface, support job manager as implied\/offscreen, arranged with clean separation and distinct faces\./gi, "The visible people are Joey and, only if needed, Darren as one distinct support-office manager; Vivian is not present.")
      .replace(/\bThe people in the frame are Joey, Darren, the absent spouse, system interface, support job manager as implied\/offscreen, arranged with clean separation and distinct faces\./gi, "The visible people are Joey and, only if needed, Darren as one distinct support-office manager; no spouse figure is present.")
      .replace(/\bVisible objects include bed, shoes, meal prep containers, support job headset, cardboard box, integrated naturally into the scene\./gi, "Visible objects include cardboard box, abandoned headset, support desk, ticket monitor, office chair, and blue system glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Joeys bedroom, gym, support-job office, and courthouse coffee shop exterior\./gi, "The environment is the dead-end customer support office.")
      .replace(/\bSingle location: apartment dumpster exterior at night only,[^.]+\./gi, "Single location: customer support office only, with cubicles, headset station, ticket queue, cardboard box, and no apartment, dumpster, gym, courthouse, or coffee shop.")
      .replace(/\bRoutine\/recovery rule:[^.]+\./gi, "");
    next += " Support-exit rule: no Vivian, no coffee shop, no courthouse, no bedroom, no gym, no dumpster. Joey appears once, leaving the old support identity through box/headset/cubicle props.";
  }
  if (
    /\b(?:coffee shop near the courthouse|outside a coffee shop|Vivian walked out|latte|she looked at my face|Then my shoulders|Then my waist|looked away quickly|old Vivian|phone buzzed|I should take this|walked past her|CLOSURE WITHOUT CHASING)\b/i.test(beat)
    && !/\b(?:posted publicly|business account|entrepreneur after getting dumped|Do not respond online|public status reversal|online insult|online provocation)\b/i.test(beat)
  ) {
    next = next
      .replace(/\bThe image depicts Complete the chunk with Joey hitting exhaustion, learning sustainable recovery, quitting his old job, and meeting (?:Vivian|the absent spouse) as a visibly changed man outside the courthouse coffee shop\./gi, "The image depicts one courthouse coffee-shop encounter: slimmer Joey stands in fitted black jacket while Vivian notices his changed body and composure.")
      .replace(/\bOpen with fast routine fragments, then slow abruptly as Joey sits on the bedroom floor holding his shoes, unable to stand\. After the recovery mission, show him training better, packing his desk into one cardboard box, leaving the headset behind, and standing outside the courthouse coffee shop in fitted jeans and a black jacket as (?:Vivian|the absent spouse) freezes and visually scans his changed face, shoulders, and waist\./gi, "Keep only the in-person coffee-shop moment: Joey and Vivian outside the cafe, latte in her hand where relevant, courthouse/legal district cues, and controlled distance between them.")
      .replace(/\bThe image depicts Show the narrator refusing to perform emotionally for the contact, while the contact wavers between old familiarity and her managed new life\./gi, "The image depicts Joey refusing to perform emotionally for Vivian while she wavers between old familiarity and her managed new life.")
      .replace(/\bthe contact averts her gaze, starts and finishes the hesitant compliment, then checks her buzzing phone with Prestons name visible\. The narrator nods, walks past her without asking her to stay, and a quiet system reward appears beside him\./gi, "Vivian averts her gaze, checks a buzzing phone represented with an abstract contact glow, and Joey calmly walks past without asking her to stay.")
      .replace(/\bThe people in the frame are Joey, Darren, Vivian, system interface, support job manager as implied\/offscreen, arranged with clean separation and distinct faces\./gi, "The visible people are Joey and Vivian only, separated clearly in the coffee-shop exterior space.")
      .replace(/\bThe people in the frame are narrator, the contact, arranged with clean separation and distinct faces\./gi, "The visible people are Joey and Vivian only, separated clearly in the coffee-shop exterior space.")
      .replace(/\bVisible objects include bed, shoes, meal prep containers, support job headset, cardboard box, integrated naturally into the scene\./gi, "Visible objects include latte cup, phone, divorce document folder, cafe glass, sidewalk tables, and subtle blue system glow, integrated naturally into the scene.")
      .replace(/\bVisible objects include the contact's phone, system UI overlay, integrated naturally into the scene\./gi, "Visible objects include Vivian's phone as an object, latte cup, divorce document folder, cafe glass, sidewalk tables, and subtle blue system glow, integrated naturally into the scene.")
      .replace(/\bThe environment is Joeys bedroom, gym, support-job office, and courthouse coffee shop exterior\./gi, "The environment is the urban coffee shop exterior near the courthouse.")
      .replace(/\bThe environment is quiet public interior or corridor where the narrator and the contact have a brief private-feeling exchange\./gi, "The environment is the urban coffee shop exterior near the courthouse.")
      .replace(/\bSingle location: apartment desk or quiet room only\.[^.]+\./gi, "Single location: courthouse coffee-shop exterior only, with Joey and Vivian physically present; the phone is only a prop in Vivian's hand.")
      .replace(/\bExactly one physical Joey across the entire image;[^\n]+?second body of Joey in another panel\./gi, "Exactly one physical Joey across the entire image; Vivian is a separate woman, not a duplicate or phone portrait.")
      .replace(/\bRemote sales rule:[^.]+\./gi, "")
      .replace(/\bSupport-exit rule:[^.]+\./gi, "");
    next += " Coffee encounter rule: show Joey and Vivian physically present outside the cafe; no Darren, no support office, no apartment, no remote caller portrait, no duplicate Joey, no Preston body. Vivian's phone may glow but must not become an inset portrait.";
  }
  if (/\b(?:hands shook|called her|called him|remote-call start|This is Joey|begins a tense remote sales call)\b/i.test(beat + " " + next)) {
    next = next
      .replace(/\bUse an intentional controlled manga panel layout for a cold-outreach work beat: largest panel shows Joey at his apartment desk sending emails on a laptop; small secondary panels show pure graphic UI symbols: envelope icons, blank reply cards, a phone handset icon, checkmarks, and a gold opportunity glow\./gi, "The image depicts one local phone-call start moment: Joey sits at his apartment desk with one hand trembling near the phone, laptop open, notebook beside him, and a small blue system glow showing abstract question markers.")
      .replace(/\bPanel roles stay clear: main physical panel is Joey working alone; small panels are abstract email count-up icons, checklist marks, blank reply cards, and one gold opportunity badge\./gi, "")
      .replace(/\bFor the phone-call portion, represent the remote prospect only as a blank circular contact silhouette and use call-flow cards plus five abstract question markers\./gi, "")
      .replace(/\bIntentional controlled manga panel layout allowed for this communication beat:[^.]+\./gi, "")
      .replace(/\bIntentional controlled manga panel layout allowed here:[^.]+\./gi, "")
      .replace(/\bRemote caller is not visible as a person; show only a tiny blank circular contact silhouette, envelope icons, phone UI shapes, or abstract call-flow cards\./gi, "")
      .replace(/\bNo human portraits inside any UI panel, no remote office scene, no extra sales prospects visible; remote identity is only a blank circular silhouette contact icon\./gi, "")
      .replace(/\bClean controlled manga panel borders are allowed only to separate the planned device\/UI panels\./gi, "Use one continuous full-frame composition without manga panel borders.");
    next += " Single full-frame local call-start composition only: one physical Joey, phone on desk, laptop, notebook, blue abstract question markers. No panel grid, no secondary panels, no remote caller, no contact portrait, no extra person, no duplicate Joey.";
  }
  if (!/intentional controlled manga panel layout/i.test(next) && !/single full-frame composition|one continuous cinematic frame/i.test(next)) {
    next += " Single full-frame composition, one continuous cinematic moment, no split-screen panels, no inset panels, no storyboard montage, no white dialogue bubbles, no speech balloons.";
  }
  if (/intentional controlled manga panel layout/i.test(next)) {
    next = next
      .replace(/\bNo speech bubbles, no captions, no captions, no written words, no lettering, no dialogue balloons, no title cards, no manga panel borders\./gi, "No speech bubbles, no captions, no written words, no lettering, no dialogue balloons, no title cards. Clean controlled manga panel borders are allowed only to separate the planned device/UI panels.")
      .replace(/\bNo speech bubbles, no captions, no written words, no lettering, no dialogue balloons, no title cards, no manga panel borders\./gi, "No speech bubbles, no captions, no written words, no lettering, no dialogue balloons, no title cards. Clean controlled manga panel borders are allowed only to separate the planned device/UI panels.")
      .replace(/\bno split-screen montage\b/gi, "no uncontrolled montage");
  }
  if (/\b(?:said|asked|told|whispered|called|answered|laughed|shouted|replied|spoke|speaking|dialogue|spoken line)\b/i.test(beat + " " + next)) {
    next += " Silent textless acting frame: communicate dialogue only through posture, eyelines, facial expression, hand placement, and object staging. Do not draw speech-balloon shapes, subtitle strips, caption boxes, quotation marks, readable words, or comic lettering anywhere.";
  }
  return next.replace(/\s+/g, " ").trim();
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

function trimRequirements(requirements) {
  const nonStyle = requirements.filter((req) => referenceKindRank(req.kind) < 9);
  const style = requirements.filter((req) => referenceKindRank(req.kind) >= 9);
  const pool = nonStyle.length ? nonStyle : style;
  const chars = pool.filter((req) => referenceKindRank(req.kind) === 0);
  const locs = pool.filter((req) => referenceKindRank(req.kind) === 1);
  const others = pool.filter((req) => referenceKindRank(req.kind) > 1).sort((a, b) => referenceKindRank(a.kind) - referenceKindRank(b.kind));
  const selected = [];
  for (const req of chars) if (selected.length < maxRefs) selected.push(req);
  for (const req of locs) if (selected.length < maxRefs) selected.push(req);
  for (const req of others) if (selected.length < maxRefs) selected.push(req);
  return selected.map((req, index) => ({ ...req, slot_order: index + 1 }));
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
  const findings = [];
  const shotManifest = sanitizeShotManifest(prompt.shot_manifest);
  const precleanText = ensurePromptClauses(prompt, 0);
  const precleanedPrompt = {
    ...prompt,
    modelslab_image_prompt: precleanText,
    image_prompt: precleanText,
  };
  let chars = matchedCharacters(precleanedPrompt, indexes.characterRefs);
  const normalizedPrecleanText = normalize(promptText(precleanedPrompt));
  if (/\bone hundred and eighty days later\b|\bnew body\b|\bclean suit\b|\btwo attorneys\b|\bdebt documents\b/i.test(`${prompt.visual_beat_script_excerpt ?? ""} ${prompt.visual_beat_action ?? ""}`)) {
    const ownerRef = indexes.characterRefs.find((ref) => sourceRefId(ref) === "joey_owner_ref");
    if (ownerRef) chars = [ownerRef, ...chars.filter((ref) => sourceRefId(ref) !== "joey_overweight_ref" && sourceRefId(ref) !== "joey_early_discipline_ref" && sourceRefId(ref) !== "joey_emerging_founder_ref")];
  }
  const currentBeatText = `${prompt.visual_beat_script_excerpt ?? ""} ${prompt.visual_beat_action ?? ""}`;
  const excerptText = String(prompt.visual_beat_script_excerpt ?? "");
  if (
    /\b(?:brought dinner|paper bag with Thai food|holding a paper bag|stood in the elevator|elevator opened|remember we were married|remember I was still trying)\b/i.test(excerptText)
    && !/\b(?:Preston|boss stood|boss smiled|Vivian in the executive lounge|sitting on a leather couch|wedding ring missing|found Vivian|looked at my stomach|everyone laughed)\b/i.test(excerptText)
  ) {
    chars = chars.filter((ref) => /^joey_/i.test(sourceRefId(ref) ?? ""));
  }
  if (
    (
      (
        /\b(?:mu gyeol|wounded young swordsman|young swordsman in damaged martial robes|pale bloodied young korean swordsman)\b/i.test(normalizedPrecleanText)
        && /\b(?:awakened sword|awakened mother blade|black mother blade|black veined blade|torn dark martial clothing|damaged martial robes)\b/i.test(normalizedPrecleanText)
      )
      || (
        /\bmu gyeol\b/i.test(normalizedPrecleanText)
        && /\b(?:ancestral hall|jin clan martial hall|altar steps|altar center|polished floor)\b/i.test(normalizedPrecleanText)
        && !/\b(?:patched gray|spirit rope|guard cloak|mother room|snow courtyard|ravine|child memory)\b/i.test(normalizedPrecleanText)
      )
    )
    && !chars.some((ref) => sourceRefId(ref) === "char_jin_mu_gyeol_mother_blade_escape")
  ) {
    const currentMuGyeolRef = indexes.characterRefs.find((ref) => sourceRefId(ref) === "char_jin_mu_gyeol_mother_blade_escape");
    if (currentMuGyeolRef) chars = [currentMuGyeolRef, ...chars];
  }
  const location = locationForPrompt(precleanedPrompt, indexes.locationTargets);
  let locationContract = locationContractForPrompt(precleanedPrompt);
  if (location?.ref_id && locationContract?.preferredRefId !== location.ref_id) {
    locationContract = genericLocationContracts.find((contract) => contract.preferredRefId === location.ref_id) ?? locationContract;
  }
  const requirements = [];
  for (const ref of chars) {
    const refId = sourceRefId(ref);
    const baseIdentityRefId = ref.base_identity_ref_id ?? ref.base_identity_ref ?? null;
    const faceOnly = String(ref.identity_usage ?? "").toLowerCase() === "face_only" && baseIdentityRefId;
    requirements.push(makeRequirement(
      faceOnly ? baseIdentityRefId : refId,
      "character_state",
      faceOnly
        ? `face-only identity anchor for ${ref.character ?? ref.subject ?? refId}; current state comes from prompt text`
        : `character identity and wardrobe for ${ref.character ?? ref.subject ?? refId}`,
      faceOnly
        ? `Deterministic hardening: visible transformed character state ${refId}; attach base identity face-only and use prompt text for body, grooming, wardrobe, and posture.`
        : "Deterministic hardening: visible character or resolved role alias.",
      1,
      true,
      faceOnly ? {
        source_state_ref_id: refId,
        identity_usage: "face_only",
        state_contract: ref.scene_prompt_anchor ?? ref.prompt_anchor ?? "",
      } : {}
    ));
  }
  if (location) {
    requirements.push(makeRequirement(
      location.ref_id,
      "location",
      `location environment for ${location.subject ?? location.ref_id}`,
      "Deterministic hardening: active continuous-location scene anchor."
    ));
  }
  requirements.push(...existingConcreteRequirements(prompt));
  const forbiddenManifestRefs = new Set((shotManifest?.forbidden_ref_ids ?? []).map((id) => String(id)));
  const dedupedRequirements = dedupeRequirements(requirements);
  const strippedForbiddenRefs = dedupedRequirements.filter((req) => forbiddenManifestRefs.has(req.ref_id)).map((req) => req.ref_id);
  if (strippedForbiddenRefs.length) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "warning",
      code: "shot_manifest_forbidden_ref_stripped",
      message: `Shot manifest forbade refs that were stripped before imagegen: ${strippedForbiddenRefs.join(", ")}.`,
      resolved: true,
    });
  }
  let selectedRequirements = trimRequirements(dedupedRequirements.filter((req) => !forbiddenManifestRefs.has(req.ref_id)));
  let text = ensurePromptClauses(precleanedPrompt, selectedRequirements.filter((req) => referenceKindRank(req.kind) === 0).length);
  const stateContracts = selectedRequirements
    .filter((req) => req.identity_usage === "face_only" && req.state_contract)
    .map((req) => `Visible transformed character state: ${req.state_contract}. Use the attached base identity only for facial likeness of that named character; the current prompt controls body, grooming, wardrobe, posture, and social status. Supporting people, attorneys, staff, crowds, coworkers, and silhouettes must use distinct one-off faces and must not resemble the attached face anchor.`);
  for (const contract of stateContracts) {
    if (!text.includes(contract)) text = `${text} ${contract}`.trim();
  }
  text = resolveCharacterStateConflicts(text, selectedRequirements);
  text = sanitizeUnattachedCharacterMentions(text, selectedRequirements, indexes.characterRefs);
  text = applyShotContract(text, precleanedPrompt);
  text = stripDialogueCueLanguage(text);
  text = applyLocationContract(text, locationContract);
  const progression = joeyProgressionClause(precleanedPrompt, selectedRequirements);
  if (progression && !text.includes(progression)) text = `${text} ${progression}`.trim();
  text = enforceSingleMomentComposition(text, precleanedPrompt);
  text = removeConflictingSingleLocationClauses(text, locationContract);
  text = removeConflictingVisibleLocationClauses(text, locationContract);
  text = stripDialogueCueLanguage(text);
  if (locationContract && !location) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "blocker",
      code: "missing_location_ref_for_beat_contract",
      message: `Beat-level location contract ${locationContract.label} was detected, but no matching location reference target exists.`,
      resolved: false,
    });
  }
  const primaryLabel = /\b(?:childhood memory|young mu[- ]gyeol|young seol[- ]ah|as children)\b/i.test(text)
    ? "two child memory silhouettes"
    : String(prompt.primary_subject ?? "").trim();
  if (primaryLabel && !/primary visual focus:/i.test(text)) {
    text = `${text} Primary visual focus: ${primaryLabel}; supporting figures must not take over the center composition unless they are the action subject.`.trim();
  }
  if (selectedRequirements.some((req) => req.ref_id === "char_jin_mu_gyeol_disgraced_gray_robes") && !/Mu-gyeol remains in patched gray robes/i.test(text)) {
    text = `${text} Mu-gyeol remains in patched gray winter-thin robes with bruised exhausted features; do not change him into clean green, blue, white, or noble robes. Show only one Mu-gyeol in the entire frame, with no twin, no second seated copy, no mirrored duplicate, and no alternate-pose duplicate.`.trim();
  }
  const unresolvedRole = /\b(?:white[-\s]bearded elder|patriarch|deputy envoy|murim alliance envoy|replacement heir|favored heir|cousin attacker|victorious cousin)\b/i.test(promptText(prompt))
    && !selectedRequirements.some((req) => referenceKindRank(req.kind) === 0);
  if (unresolvedRole) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "blocker",
      code: "unresolved_character_alias",
      message: "Prompt contains a visible role alias but no matching character_state reference was attached.",
      resolved: false,
    });
  }
  if (location && !selectedRequirements.some((req) => req.ref_id === location.ref_id)) {
    const characterSlotCount = selectedRequirements.filter((req) => referenceKindRank(req.kind) === 0).length;
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: characterSlotCount >= maxRefs ? "warning" : "blocker",
      code: "missing_location_ref",
      message: characterSlotCount >= maxRefs
        ? `Continuous location ${location.ref_id} was dropped because all four reference slots are occupied by visible characters.`
        : `Continuous location ${location.ref_id} could not fit into the four-reference limit.`,
      resolved: characterSlotCount >= maxRefs,
    });
  }
  if (shotManifest?.location_ref_id) {
    const selectedLocationIds = selectedRequirements.filter((req) => referenceKindRank(req.kind) === 1).map((req) => req.ref_id);
    if (!selectedLocationIds.includes(shotManifest.location_ref_id)) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "shot_manifest_location_ref_mismatch",
        message: `Shot manifest requested location ${shotManifest.location_ref_id}, but selected location refs are ${selectedLocationIds.length ? selectedLocationIds.join(", ") : "none"}.`,
        resolved: false,
      });
    }
  }
  if (shotManifest?.forbidden_ref_ids?.length) {
    const selectedRefIds = new Set(selectedRequirements.flatMap((req) => [req.ref_id, req.source_state_ref_id].filter(Boolean)));
    const stillAttached = shotManifest.forbidden_ref_ids.filter((refId) => selectedRefIds.has(refId));
    if (stillAttached.length) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "blocker",
        code: "shot_manifest_forbidden_ref_attached",
        message: `Shot manifest forbids refs that are still selected: ${stillAttached.join(", ")}.`,
        resolved: false,
      });
    }
  }
  if (shotManifest?.character_state_ref_ids?.length) {
    const selectedRefIds = new Set(selectedRequirements.flatMap((req) => [req.ref_id, req.source_state_ref_id].filter(Boolean)));
    const missingCharacterRefs = shotManifest.character_state_ref_ids.filter((refId) => !selectedRefIds.has(refId));
    if (missingCharacterRefs.length) {
      findings.push({
        image_id: prompt.image_id,
        scene_id: prompt.scene_id,
        severity: "warning",
        code: "shot_manifest_character_ref_not_selected",
        message: `Shot manifest expected character state refs not selected after hardening: ${missingCharacterRefs.join(", ")}.`,
        resolved: true,
      });
    }
  }
  if (selectedRequirements.filter((req) => referenceKindRank(req.kind) === 0).length >= 2 && !/separate complete bod|distinct face placement|readable robe boundaries/i.test(text)) {
    findings.push({
      image_id: prompt.image_id,
      scene_id: prompt.scene_id,
      severity: "blocker",
      code: "missing_multi_character_staging",
      message: "Multi-character cut lacks explicit positive spatial staging.",
      resolved: false,
    });
  }
  return {
    prompt: {
      ...prompt,
      image_prompt: text,
      modelslab_image_prompt: text,
      prompt_hash: sha256(text),
      reference_requirements: selectedRequirements,
      required_reference_paths: [],
      reference_usage: selectedRequirements.map((req) => ({
        ref_id: req.ref_id,
        usage: "attach_existing_ref",
        reason: req.reason ?? "Selected by deterministic prompt hardening.",
      })),
      shot_manifest: shotManifest,
      hardening_notes: [
        ...(prompt.hardening_notes ?? []),
        "visual-prompt-harden applied: character alias resolution, sticky location refs, style/staging clauses, and four-reference trimming.",
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
  const lines = [
    "# Visual Prompt Hardening Sample",
    "",
    `Status: ${report.status}`,
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
    const result = hardenPrompt(prompt, indexes);
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
    prompt_policy: "LLM-authored and reviewed prompts with deterministic hardening for aliases, sticky location refs, multi-character staging, and reference limits",
    prompts,
    visual_prompt_hardening_report_path: reportPath,
    visual_prompt_hardening_sample_path: samplePath,
    updated_at: report.updated_at,
  };
  await writeJson(outputPath, hardenedPlan);
  await writeJson(reportPath, report);
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
