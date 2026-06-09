#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { foreignSeriesTermSpecs, protectedIpTermSpecs, resetAndTest } from "./series-foreign-lexicon.mjs";

const DATA_ROOT = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const args = process.argv.slice(2);
const flags = parseFlags(args);
const channel = flags.channel ?? "53rebirth";
const seriesSlug = flags.series ?? (channel === "53rebirth" ? "30-year-old-loser-reborn-to-buy-bitcoin" : channel);
const week = flags.week ?? "2026-W20";
const episode = flags.episode ?? "ep_01";
const weekDir = path.join(DATA_ROOT, "channels", channel, "weekly_runs", week);
const seriesDir = path.join(DATA_ROOT, "channels", channel, "series", seriesSlug);
const episodeDir = path.join(DATA_ROOT, "channels", channel, "weekly_runs", week, "episodes", episode);
const maxDurationSec = flags["max-duration-sec"] ? Number(flags["max-duration-sec"]) : null;
const repoRoot = process.cwd();

function characterVoiceCastingEnabled() {
  const value = flags["character-voice-casting"] ?? process.env.ANIFACTORY_CHARACTER_VOICE_CASTING ?? "false";
  return /^(?:true|1|yes|enabled|on)$/i.test(String(value).trim());
}

function narratorOnlyVoiceMode(dialogueContext = {}) {
  return !characterVoiceCastingEnabled()
    || dialogueContext?.voiceCastingLock?.voice_casting_mode === "narrator_only_default"
    || dialogueContext?.voiceCastingLock?.character_voice_casting_enabled === false;
}

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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

async function sha256File(filePath) {
  return sha256Text(await fs.readFile(filePath, "utf8"));
}

function palette() {
  if (seriesSlug === "30-year-old-loser-reborn-to-buy-bitcoin") {
    return {
      failed_future: ["[exhausted, worn down]", "[quiet despair]", "[voice heavy with shame]", "[flat, tired, barely holding together]"],
      haru: ["[soft, aching tenderness]", "[fragile, voice almost breaking]", "[protective whisper]", "[exhales slowly, holding back tears]"],
      regression: ["[stunned, breath shallow]", "[low, confused disbelief]", "[sharp inhale]", "[disoriented, trying to stay quiet]"],
      strategy: ["[dry, calculating focus]", "[controlled urgency]", "[quiet excitement barely contained]", "[measured, careful, afraid to hope]"],
      system: ["[cold dread]", "[hushed, clinical fear]", "[low, still, as if reading a diagnosis]", "[voice tightens]"],
      family: ["[restrained warmth]", "[guilty, quiet]", "[trying to sound like a normal son]", "[tired tenderness]"],
      dialogue: {
        "DAE-HO": "[guarded, older than his voice should be]",
        HARU: "[soft child voice, trying to sound brave]",
        "MIN-JAE": "[dry joking loyalty, quick but warm]",
        "MAN-SIK": "[rough, practical, affection hidden under irritation]",
        "SEO-RA": "[sharp, guarded, observant]",
        "MI-SOOK": "[sharp working mother voice, love hidden under impatience]",
        "JIN-TAE": "[rough PC bang owner, amused and opportunistic]",
        "SEO-YEON": "[quiet teen girl, guarded but precise]",
        "MIN-GYU": "[smug schoolboy cruelty, casual and needling]",
        BAEK: "[gentle, predatory calm]",
        "TEACHER HAN": "[clipped authority, class prejudice underneath]",
        "MIN-SEOK": "[smug, casual cruelty]",
        DEFAULT: "[lightly acted dialogue, natural and restrained]",
      },
      dialogue_mix: ["[alive, intimate storytelling]", "[acted gently, shifting between narrator and character]", "[warm but tense, dialogue held close]"],
      cliffhanger: ["[hushed, dangerous stillness]", "[low, ominous, letting the words land]", "[breath held]", "[slowly, as if the next word matters]"],
      physical: ["[breathes in]", "[exhales slowly]", "[sighs quietly]", "[voice catches]", "[swallows hard]", "[sharp inhale]", "[bitter laugh under his breath]", "[clears throat quietly]"],
      humor: ["[dry, darkly amused]", "[bitter laugh under his breath]"],
    };
  }
  return {
    default: ["[low, intimate]", "[tense, focused]", "[soft, wounded]", "[urgent, controlled]", "[cold dread]", "[quiet resolve]", "[bitterly amused]", "[hushed cliffhanger]"],
    physical: ["[exhales slowly]", "[swallows hard]", "[breathes in]"],
    dialogue: { DEFAULT: "[lightly acted dialogue, natural and restrained]" },
  };
}

function speakerLabel(value) {
  return String(value ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function canonicalSpeakerLabelForVoice(label, allLabels = []) {
  const normalized = speakerLabel(label);
  if (!normalized) return normalized;
  const sponsorBase = normalized.match(/^(SPONSOR STUDENT)(?:\s+(?:ONE|TWO|THREE|FOUR|FIVE|\d+))?$/);
  if (sponsorBase) return sponsorBase[1];
  const supportBase = normalized.match(/^(SUPPORT MAGE)(?:\s+(?:ONE|TWO|THREE|FOUR|FIVE|\d+))?$/);
  if (supportBase) return supportBase[1];
  const labels = [...new Set(allLabels.map(speakerLabel).filter(Boolean))];
  const ignored = new Set(["THE", "A", "AN"]);
  const tokens = normalized.split(/\s+/).filter((token) => !ignored.has(token));
  if (!tokens.length || tokens.length > 3) return normalized;
  const candidates = labels
    .filter((candidate) => candidate !== normalized && candidate.length > normalized.length)
    .filter((candidate) => {
      const candidateTokens = new Set(candidate.split(/\s+/));
      return tokens.every((token) => candidateTokens.has(token));
    })
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? normalized;
}

function roleTag(role) {
  const byRole = {
    narrator: "[low, intimate narration]",
    young_male: "[pitch up, nervous but trying to sound brave]",
    adult_male: "[low voice, controlled]",
    authority_male: "[low male authority voice, cold and controlled]",
    elder_male: "[older male voice, steady and textured]",
    female: "[adult female voice, alert and human]",
    young_female: "[clear teen girl voice, alert and human]",
    elder_female: "[older female voice, steady and human]",
    child: "[soft child voice, clear and simple]",
    child_male: "[soft young boy voice, clear and natural]",
    child_female: "[soft young girl voice, clear and natural]",
    kawaii_child_female: "[cute young girl voice, bright and tiny but clear]",
    toddler: "[whisper in small voice]",
    villain_male: "[low voice, gentle and dangerous]",
    intense_male: "[low voice, intense restraint]",
    mc_internal: "[close intimate internal monologue, controlled tension]",
    system: "[cold, formal system notice]",
    radio_source: "[distant, filtered radio voice]",
  };
  return byRole[role] ?? "[lightly acted dialogue, natural and restrained]";
}

function stableIndex(value, length) {
  if (!length) return 0;
  let hash = 0;
  for (const char of String(value ?? "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % length;
}

function speakerSpecificDialogueTag(speaker, role = null) {
  const label = speakerLabel(speaker);
  if (/^MC_INTERNAL$/i.test(label)) return roleTag("mc_internal");
  if (/^(SYSTEM|SYSTEM UI|UI|NOTICE|WARNING)(?:\s+\d+)?$/i.test(label)) return roleTag("system");
  const resolvedRole = role ?? fallbackRoleFromSpeakerLabel(label);
  const elderFemaleTags = [
    "[older female voice, steady and human]",
    "[elderly woman voice, careful and grounded]",
    "[mature female voice, low and composed]",
  ];
  const femaleTags = [
    "[adult female voice, alert and human]",
    "[firm female voice, controlled under pressure]",
    "[low female voice, guarded and precise]",
    "[quick female voice, tense but focused]",
  ];
  const youngFemaleTags = [
    "[clear teen girl voice, alert and human]",
    "[young female voice, quick but natural]",
    "[soft young woman voice, emotionally clear]",
  ];
  const elderMaleTags = [
    "[older male voice, steady and textured]",
    "[mature male voice, controlled and grounded]",
    "[elderly man voice, dry and deliberate]",
  ];
  const youngMaleTags = [
    "[pitch up, nervous but trying to sound brave]",
    "[young male voice, quick and wary]",
    "[teen male voice, dry and restless]",
  ];
  const adultMaleTags = [
    "[low voice, controlled but not shouting]",
    "[dry male voice, embarrassed and practical]",
    "[adult male voice, tense but conversational]",
    "[soft deadpan male voice, trying not to panic]",
  ];
  const authorityMaleTags = [
    "[low male authority voice, cold and controlled]",
    "[mature male voice, procedural and calm]",
    "[quiet institutional authority, precise and threatening]",
  ];
  const childFemaleTags = [
    "[cute young girl voice, bright and clear]",
    "[tiny princess voice, imperious but readable]",
    "[soft young girl voice, pleased with herself]",
    "[kawaii child voice, playful and crisp]",
  ];
  const childMaleTags = [
    "[soft young boy voice, clear and sincere]",
    "[small boy voice, nervous but readable]",
  ];
  if (resolvedRole === "elder_female") return elderFemaleTags[stableIndex(label, elderFemaleTags.length)];
  if (resolvedRole === "female") return femaleTags[stableIndex(label, femaleTags.length)];
  if (resolvedRole === "young_female") return youngFemaleTags[stableIndex(label, youngFemaleTags.length)];
  if (resolvedRole === "child_female" || resolvedRole === "kawaii_child_female") return childFemaleTags[stableIndex(label, childFemaleTags.length)];
  if (resolvedRole === "child_male") return childMaleTags[stableIndex(label, childMaleTags.length)];
  if (resolvedRole === "elder_male") return elderMaleTags[stableIndex(label, elderMaleTags.length)];
  if (resolvedRole === "authority_male") return authorityMaleTags[stableIndex(label, authorityMaleTags.length)];
  if (resolvedRole === "young_male") return youngMaleTags[stableIndex(label, youngMaleTags.length)];
  if (resolvedRole === "adult_male") return adultMaleTags[stableIndex(label, adultMaleTags.length)];
  if (resolvedRole === "system") return roleTag("system");
  return roleTag(resolvedRole);
}

function fallbackRoleFromSpeakerLabel(label) {
  if (/^MC_INTERNAL$/i.test(label)) return "mc_internal";
  if (/TODDLER/.test(label)) return "toddler";
  if (/\b(?:SYSTEM|UI|NOTICE|WARNING|RANK BOARD|SEAL COUNT|COUNT VISIBLE|BOARD)\b/.test(label)) return "system";
  if (/\b(?:UNKNOWN VOICE|VOICE|RADIO|BROADCAST|INTERCOM|SPEAKER)\b/.test(label)) return "radio_source";
  if (/(DAUGHTER|PRINCESS|LITTLE GIRL|GIRL CHILD|CHILD GIRL|YOUNG GIRL|KAWAII)/.test(label)) return "kawaii_child_female";
  if (/(LITTLE BOY|BOY CHILD|CHILD BOY|YOUNG BOY)/.test(label)) return "child_male";
  if (/^(MRS\.?|MS\.?|MISS|MADAM)\b/.test(label) && /\b(?:ODA|GRANDMOTHER|GRANNY|ELDER|OLD|ELDERLY|SENIOR)\b/.test(label)) return "elder_female";
  if (/^(MRS\.?|MS\.?|MISS|MADAM)\b/.test(label)) return "female";
  if (/^(MR\.?|MISTER)\b/.test(label) && /\b(?:GRANDFATHER|GRANDPA|ELDER|OLD|ELDERLY|SENIOR)\b/.test(label)) return "elder_male";
  if (/\b(?:GRANDMOTHER|GRANNY|ELDERLY WOMAN|OLD WOMAN|SENIOR WOMAN)\b/.test(label)) return "elder_female";
  if (/\b(?:GRANDFATHER|GRANDPA|ELDERLY MAN|OLD MAN|SENIOR MAN)\b/.test(label)) return "elder_male";
  if (/\b(?:DEAN|HEADMASTER|PRINCIPAL|COMMANDER|DIRECTOR|AUTHORITY)\b/.test(label)) return "authority_male";
  if (/\b(?:PROFESSOR|INSTRUCTOR|CAPTAIN|ADULT|TEACHER|OFFICER)\b/.test(label)) return "adult_male";
  if (/\b(?:CADET|STUDENT|SUPPORT BOY|COMBAT CADET)\b/.test(label)) return "young_male";
  if (/\b(?:SUPPORT GIRL|CADET GIRL|STUDENT GIRL)\b/.test(label)) return "young_female";
  if (/MOTHER|SISTER|WOMAN|GIRL|FEMALE|NURSE|AUNT|GRANDMOTHER|WAITRESS|CASHIER|CLERK/.test(label)) return "female";
  if (/CHILD|KID/.test(label)) return "child";
  if (/TEEN|YOUNG|BOY|STUDENT/.test(label)) return "young_male";
  if (/SYSTEM|UI|NOTICE|WARNING/.test(label)) return "system";
  if (/RADIO|BROADCAST|RECEIVER|KX-0/.test(label)) return "radio_source";
  return "adult_male";
}

function fallbackDialogueTagForSpeaker(speaker) {
  const text = speakerLabel(speaker);
  if (/WOMAN['’]?S VOICE|FEMALE VOICE|RECEIVER/.test(text)) return "[distant, filtered young female radio voice]";
  if (/RADIO|BROADCAST|KX-0|VOICE|UNKNOWN VOICE|INTERCOM|SPEAKER/.test(text)) return roleTag("radio_source");
  if (/\b(?:SYSTEM|UI|NOTICE|WARNING|RANK BOARD|SEAL COUNT|COUNT VISIBLE|BOARD)\b/.test(text)) return roleTag("system");
  if (/(DAUGHTER|PRINCESS|LITTLE GIRL|GIRL CHILD|CHILD GIRL|YOUNG GIRL|KAWAII)/.test(text)) return roleTag("kawaii_child_female");
  if (/(LITTLE BOY|BOY CHILD|CHILD BOY|YOUNG BOY)/.test(text)) return roleTag("child_male");
  if (/\b(?:GRANDMOTHER|GRANNY|ELDERLY WOMAN|OLD WOMAN|SENIOR WOMAN|MRS\.?\s+ODA)\b/.test(text)) return roleTag("elder_female");
  if (/\b(?:GRANDFATHER|GRANDPA|ELDERLY MAN|OLD MAN|SENIOR MAN)\b/.test(text)) return roleTag("elder_male");
  if (/MOTHER|SISTER|WOMAN|GIRL|FEMALE/.test(text)) return roleTag("female");
  if (/TODDLER/.test(text)) return roleTag("toddler");
  if (/CHILD|KID|BOY 7|GIRL 7/.test(text)) return roleTag("child");
  if (/TEEN|YOUNG|BOY|STUDENT/.test(text)) return roleTag("young_male");
  if (/SYSTEM|UI|NOTICE|WARNING/.test(text)) return roleTag("system");
  if (/VILLAIN|ANTAGONIST/.test(text)) return roleTag("villain_male");
  return roleTag("adult_male");
}

function characterTextFields(character) {
  return [
    character?.name,
    character?.character_name,
    character?.full_name,
    character?.character_id,
    character?.id,
    character?.gender,
    character?.pronouns,
    character?.age,
    character?.voice_role,
    character?.voiceRole,
    character?.fish_voice_role,
    character?.role,
    character?.relationship_to_protagonist,
    character?.description,
    character?.voice,
    character?.voice_guide,
  ].filter(Boolean).join(" ").toLowerCase();
}

function semanticVoiceRoleFromContext(speaker, segmentText = "", segment = null) {
  const speakerText = speakerLabel(speaker);
  const context = [
    speakerText,
    segmentText,
    segment?.stripped_text,
    segment?.caption_text,
    segment?.semantic_voice_context,
  ].filter(Boolean).join(" ");
  const isDisembodiedOrDeviceVoice = /RADIO|BROADCAST|RECEIVER|KX-0|LOUDSPEAKER|SPEAKER|PHONE|INTERCOM|VOICE/i.test(context);
  if (!isDisembodiedOrDeviceVoice) return null;
  if (/little girl|girl child|child girl|daughter|princess|kawaii/i.test(context)) return "kawaii_child_female";
  if (/little boy|boy child|child boy/i.test(context)) return "child_male";
  if (/woman['’]?s voice|female voice|girl['’]?s voice|young woman|teen girl|mother['’]?s voice|lorna['’]?s voice/i.test(context)) return "female";
  if (/child['’]?s voice|toddler/i.test(context)) return "child";
  if (/boy['’]?s voice|teen boy|young man['’]?s voice|young male/i.test(context)) return "young_male";
  if (/man['’]?s voice|male voice|old man|father['’]?s voice/i.test(context)) return "adult_male";
  return null;
}

async function loadDialogueContext() {
  const characterBible = await readJsonIfExists(path.join(seriesDir, "character_bible.json"), await readJsonIfExists(path.join(weekDir, "character_bible.json"), {}));
  const seriesPackage = await readJsonIfExists(path.join(seriesDir, "series_package.json"), await readJsonIfExists(path.join(weekDir, "series_package.json"), {}));
  const rawVoiceCastingLock = await readJsonIfExists(path.join(episodeDir, `voice_casting_lock_${episode}.json`), await readJsonIfExists(path.join(episodeDir, "voice_casting_lock_ep_01.json"), {}));
  const voiceCastingLock = characterVoiceCastingEnabled()
    ? await applySeriesQwenCastingMap(rawVoiceCastingLock)
    : {
        ...(rawVoiceCastingLock ?? {}),
        status: rawVoiceCastingLock?.status ?? "passed",
        production_ready: rawVoiceCastingLock?.production_ready ?? true,
        voice_casting_mode: "narrator_only_default",
        character_voice_casting_enabled: false,
        speaker_casting: {
          NARRATOR: rawVoiceCastingLock?.speaker_casting?.NARRATOR ?? rawVoiceCastingLock?.speaker_casting?.narrator ?? { id: "joel_narrator", reference_id: "joel_narrator" },
        },
      };
  const bibleCharacters = Array.isArray(characterBible?.characters) ? characterBible.characters
    : Array.isArray(characterBible?.character_bible) ? characterBible.character_bible
      : Object.values(characterBible?.characters ?? {});
  const packageCharacters = Array.isArray(seriesPackage?.character_bible) ? seriesPackage.character_bible
    : Array.isArray(seriesPackage?.characters) ? seriesPackage.characters
      : Array.isArray(seriesPackage?.character_bible?.characters) ? seriesPackage.character_bible.characters
        : seriesPackage?.character_bible && typeof seriesPackage.character_bible === "object"
          ? Object.values(seriesPackage.character_bible)
          : Object.values(seriesPackage?.character_bible?.characters ?? {});
  const byCanonicalName = new Map();
  for (const character of [...bibleCharacters, ...packageCharacters].filter(Boolean)) {
    const name = character.name ?? character.character_name ?? character.full_name ?? character.character_id ?? character.id;
    if (!name) continue;
    const key = speakerLabel(name);
    byCanonicalName.set(key, { ...(byCanonicalName.get(key) ?? {}), ...character });
  }
  const characters = [...byCanonicalName.values()];
  const entries = [];
  for (const character of characters.filter(Boolean)) {
    const name = character.name ?? character.character_name ?? character.full_name ?? character.character_id;
    if (!name) continue;
    const label = speakerLabel(name);
    const aliases = new Set([
      name,
      character.character_id,
      character.id,
      ...(character.aliases ?? []),
      ...String(name).split(/\s+/).filter((part) => part.length > 2),
    ].filter(Boolean).map((item) => String(item)));
    const voiceRole = character.voice_role ?? character.voiceRole ?? character.fish_voice_role ?? inferRoleFromCharacter(character);
    entries.push({
      label,
      name: String(name),
      aliases: [...aliases],
      role: voiceRole,
      dialogue_tag: character.dialogue_tag ?? character.voice_tag ?? roleTag(voiceRole),
    });
  }
  const roleByLabel = new Map();
  const tagByLabel = new Map();
  const byLabel = new Map();
  for (const entry of entries) {
    byLabel.set(entry.label, entry);
    roleByLabel.set(entry.label, entry.role);
    tagByLabel.set(entry.label, entry.dialogue_tag);
    for (const alias of entry.aliases ?? []) {
      const aliasLabel = speakerLabel(alias);
      if (!aliasLabel) continue;
      if (!roleByLabel.has(aliasLabel)) roleByLabel.set(aliasLabel, entry.role);
      if (!tagByLabel.has(aliasLabel)) tagByLabel.set(aliasLabel, entry.dialogue_tag);
      if (!byLabel.has(aliasLabel)) byLabel.set(aliasLabel, entry);
    }
  }
  const refByLabel = new Map(Object.entries(voiceCastingLock?.speaker_casting ?? {}).map(([label, cast]) => [speakerLabel(label), cast]));
  for (const entry of entries) {
    const cast = refByLabel.get(entry.label);
    if (!cast) continue;
    for (const alias of entry.aliases ?? []) {
      const aliasLabel = speakerLabel(alias);
      if (aliasLabel && !refByLabel.has(aliasLabel)) refByLabel.set(aliasLabel, cast);
    }
  }
  const lockedLabels = [...refByLabel.keys()];
  for (const label of lockedLabels) {
    const cast = refByLabel.get(label);
    if (cast?.role && !roleByLabel.has(label)) roleByLabel.set(label, cast.role);
    const canonical = canonicalSpeakerLabelForVoice(label, lockedLabels);
    if (canonical && cast && !refByLabel.has(canonical)) refByLabel.set(canonical, cast);
    if (canonical && cast?.role && !roleByLabel.has(canonical)) roleByLabel.set(canonical, cast.role);
    if (label === "SPONSOR STUDENT") {
      for (const suffix of ["ONE", "TWO", "THREE", "FOUR", "FIVE"]) refByLabel.set(`SPONSOR STUDENT ${suffix}`, cast);
    }
    if (label === "SUPPORT MAGE") {
      for (const suffix of ["ONE", "TWO", "THREE", "FOUR", "FIVE"]) refByLabel.set(`SUPPORT MAGE ${suffix}`, cast);
    }
  }
  return {
    entries,
    byLabel,
    roleByLabel,
    tagByLabel,
    refByLabel,
    voiceCastingLock,
    seriesPackage,
  };
}

function inferRoleFromCharacter(character) {
  const text = characterTextFields(character);
  const all = JSON.stringify(character).toLowerCase();
  const explicitRole = String(character?.voice_role ?? character?.voiceRole ?? character?.fish_voice_role ?? "").toLowerCase();
  const ageValue = Number.parseInt(String(character?.age ?? ""), 10);
  const shePronouns = (all.match(/\b(she|her|herself)\b/g) ?? []).length;
  const hePronouns = (all.match(/\b(he|him|his|himself)\b/g) ?? []).length;
  const femaleChildHint = /\b(she\/her|she\b|her\b|female|girl|daughter|princess|little girl|young girl|kawaii|cute)\b/.test(all);
  const maleChildHint = /\b(he\/him|he\b|his\b|male|boy|son|little boy|young boy)\b/.test(all);
  const childHint = /\b(child|toddler|kid|7[- ]?9|eight[- ]?year|nine[- ]?year|ten[- ]?year|eleven[- ]?year|twelve[- ]?year|little)\b/.test(all);
  const elderHint = /\b(elder|elderly|senior|old man|old woman|grandmother|grandfather|grandma|grandpa|granny|aged|retired|regular in a cardigan)\b/.test(all);
  const roleContext = [
    character?.role,
    character?.archetype,
    character?.antagonist_role,
    character?.antagonist_force,
    character?.relationship_to_protagonist,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/(?:^|_)kawaii_child_female|cute young girl|little girl|child_female/.test(explicitRole)) return "kawaii_child_female";
  if (/(?:^|_)child_male|little boy|young boy/.test(explicitRole)) return "child_male";
  if (/(?:^|_)elder_female|elderly woman|older female|senior woman/.test(explicitRole)) return "elder_female";
  if (/(?:^|_)elder_male|elderly man|older male|senior man/.test(explicitRole)) return "elder_male";
  if (/(?:^|_)young_female|teen girl|girl voice|female teen/.test(explicitRole)) return "young_female";
  if (/female|woman|girl|mother|sister/.test(explicitRole)) return "female";
  if (/child|toddler|kid/.test(explicitRole)) {
    if (/toddler/.test(explicitRole)) return "toddler";
    if (femaleChildHint) return /kawaii|cute|princess|daughter/.test(all) ? "kawaii_child_female" : "child_female";
    if (maleChildHint) return "child_male";
    return "child";
  }
  if (/young_male|teen boy|boy voice|male teen/.test(explicitRole)) return "young_male";
  if (/villain|antagonist|predatory/.test(explicitRole)) return "villain_male";
  if (/\b(villain|predator|antagonist|enemy|killer|bully|personal antagonist|noble heir)\b/.test(`${roleContext} ${text}`) && hePronouns >= shePronouns) return "villain_male";
  if (Number.isFinite(ageValue) && ageValue <= 12) {
    if (femaleChildHint || shePronouns > hePronouns) return /kawaii|cute|princess|daughter/.test(all) ? "kawaii_child_female" : "child_female";
    if (maleChildHint || hePronouns > shePronouns) return "child_male";
    return "child";
  }
  if (Number.isFinite(ageValue) && ageValue < 20) {
    if (shePronouns > hePronouns || /\b(female|girl|daughter|young woman|teen girl)\b/.test(text)) return "young_female";
    return "young_male";
  }
  if (Number.isFinite(ageValue) && ageValue >= 60) {
    if (femaleChildHint || shePronouns > hePronouns || /\b(female|woman|mother|aunt|grandmother|granny)\b/.test(all)) return "elder_female";
    return "elder_male";
  }
  if (/\b(child|toddler|kid|7[- ]?9|eight[- ]?year|nine[- ]?year)\b/.test(roleContext)) {
    if (femaleChildHint || shePronouns > hePronouns) return /kawaii|cute|princess|daughter/.test(all) ? "kawaii_child_female" : "child_female";
    if (maleChildHint || hePronouns > shePronouns) return "child_male";
    return "child";
  }
  if (/\b(authority|dean|head of|discipline|director|commander)\b/.test(`${roleContext} ${text}`)) {
    if (shePronouns > hePronouns || /\b(female|woman|mother|aunt|grandmother|granny)\b/.test(all)) return "female";
    return "authority_male";
  }
  if (/\b(adult|faculty|professor|instructor)\b/.test(`${roleContext} ${text}`)) {
    if (shePronouns > hePronouns || /\b(female|woman|mother|aunt|grandmother|granny)\b/.test(all)) return "female";
    return "adult_male";
  }
  if (hePronouns > shePronouns && Number.isFinite(ageValue) && ageValue >= 20) return "adult_male";
  if (elderHint && (shePronouns > hePronouns || /\b(female|woman|mother|aunt|grandmother|granny)\b/.test(all))) return "elder_female";
  if (elderHint) return "elder_male";
  if (hePronouns > shePronouns) return "young_male";
  if (shePronouns > hePronouns && Number.isFinite(ageValue) && ageValue < 20) return "young_female";
  if (femaleChildHint && /\b(kawaii|cute|princess|daughter|childlike|tiny|small|dependent|spoiled|plush)\b/.test(all)) return "kawaii_child_female";
  if (shePronouns > hePronouns) return "female";
  if (/\b(she\/her|she\b|her\b|female|woman|girl|mother|sister)\b/.test(text) || /\b(she\b|her\b|herself|daughter)\b/.test(all)) {
    if (/\b(teen|student|young|girl)\b/.test(text)) return "young_female";
    return "female";
  }
  if (/\b(villain|predator|antagonist|enemy|killer)\b/.test(roleContext)) return "villain_male";
  if (/\b(villain|predator|antagonist|enemy)\b/.test(text) && !/\b(she|her|female|woman|girl)\b/.test(text)) return "villain_male";
  if (/\b(teen|student|young)\b/.test(roleContext)) return "young_male";
  if (/\b(he\/him|he\b|his\b|male|man|father|brother|boy)\b/.test(text) || /\b(he\b|his\b|himself|father|brother)\b/.test(all)) return "adult_male";
  if (/\b(villain|predator|antagonist|enemy)\b/.test(all)) return "villain_male";
  return "adult_male";
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readGlobalQwenVoice(voiceId) {
  if (!voiceId) return null;
  const voicePath = path.join(DATA_ROOT, "voice_bank/qwen/voices", String(voiceId), "voice.json");
  const voice = await readJsonIfExists(voicePath, null);
  if (!voice?.approved || !voice?.source_wav) return null;
  return {
    id: voice.voice_id ?? voiceId,
    reference_id: voice.voice_id ?? voiceId,
    role: voice.descriptive_name ?? voice.voice_id ?? voiceId,
    label: voice.descriptive_name ?? voice.voice_id ?? voiceId,
    voice_descriptor: voice.description ?? voice.descriptive_name ?? voice.voice_id ?? voiceId,
    source_audio_path: voice.source_wav,
    sample_path: voice.source_wav,
    source_transcript: voice.source_transcript ?? voice.description ?? voice.descriptive_name ?? voice.voice_id ?? voiceId,
    voice_source_policy: voice.voice_source_policy ?? "global_qwen_voice_library_exact_wav_reuse",
    global_voice_path: voicePath,
    tags: voice.tags ?? {},
    used_as: voice.used_as ?? [],
  };
}

async function applySeriesQwenCastingMap(lock = {}) {
  const castingPath = path.join(DATA_ROOT, "voice_bank/qwen/casting/series", seriesSlug, "casting.json");
  const casting = await readJsonIfExists(castingPath, null);
  if (!casting?.speaker_casting || typeof casting.speaker_casting !== "object") return lock ?? {};
  const speakerCasting = { ...(lock?.speaker_casting ?? {}) };
  for (const [speaker, voiceId] of Object.entries(casting.speaker_casting)) {
    const globalVoice = await readGlobalQwenVoice(voiceId);
    if (!globalVoice) continue;
    speakerCasting[speaker] = {
      ...globalVoice,
      speaker,
      cast_from_series_map: true,
      series_casting_map_path: castingPath,
    };
  }
  return {
    ...(lock ?? {}),
    speaker_casting: speakerCasting,
    global_qwen_casting_map_applied: true,
    global_qwen_casting_map_path: castingPath,
  };
}

function artifactApproved(report) {
  if (!report || typeof report !== "object") return false;
  const status = String(report.status ?? report.approval_status ?? report.operator_status ?? "").toLowerCase();
  return report.approved === true
    || report.operator_approved === true
    || report.script_approved === true
    || status === "approved"
    || status === "operator_approved";
}

function manualAgentReviewApproved(report) {
  if (!artifactApproved(report)) return false;
  return report.manual_agent_script_review === true
    || report.review_type === "manual_creative_agent_script_review"
    || report.stage === "manual_creative_agent_script_review";
}

async function assertManualAgentScriptReview(scriptPath) {
  if (flags["allow-unlocked-script"] === "true" || flags.diagnostic === "true") return;
  const scriptHash = await sha256File(scriptPath);
  const candidates = [
    path.join(episodeDir, "manual_agent_script_review.json"),
    path.join(episodeDir, `manual_agent_script_review_${episode}.json`),
    path.join(episodeDir, "script_manual_review.json"),
    path.join(episodeDir, `script_manual_review_${episode}.json`),
    path.join(weekDir, `manual_agent_script_review_${episode}.json`),
  ];
  for (const filePath of candidates) {
    const report = await readJsonIfExists(filePath, null);
    if (!manualAgentReviewApproved(report)) continue;
    const reportHash = report.script_hash
      ?? report.source_hash
      ?? report.source_hashes?.[scriptPath]
      ?? report.source_hashes?.[path.resolve(scriptPath)];
    if (reportHash === scriptHash) return;
  }
  throw new Error(`Refusing voice-plan: manual creative agent script review is required and must be current for ${scriptPath}. Expected approved artifact at one of: ${candidates.join(", ")}. Run the agent read/rewrite pass, then create manual_agent_script_review.json before operator script approval.`);
}

async function assertScriptApprovedForVoicePlan(scriptPath) {
  if (flags["allow-unlocked-script"] === "true" || flags.diagnostic === "true") return;
  const candidates = [
    path.join(episodeDir, "script_approval.json"),
    path.join(episodeDir, `script_approval_${episode}.json`),
    path.join(episodeDir, "operator_script_approval.json"),
    path.join(episodeDir, `operator_script_approval_${episode}.json`),
    path.join(episodeDir, "script_lock.json"),
    path.join(episodeDir, `script_lock_${episode}.json`),
    path.join(weekDir, `script_approval_${episode}.json`),
    path.join(weekDir, "operator_script_approval.json"),
  ];
  for (const filePath of candidates) {
    if (artifactApproved(await readJsonIfExists(filePath, null))) return;
  }
  throw new Error(`Refusing voice-plan: script_clean.md has not been explicitly operator-approved. Script QA is not approval. Expected approved artifact at one of: ${candidates.join(", ")}. Use --allow-unlocked-script true only for diagnostics.`);
}

async function loadProviderRouting() {
  return readJsonIfExists(path.join(repoRoot, "config", "provider-routing.json"), {});
}

function requestedTtsProvider(providerRouting, voiceCastingLock = {}) {
  return flags["tts-provider"]
    ?? voiceCastingLock?.tts_provider
    ?? providerRouting.audio?.production_tts_provider
    ?? "qwen_local";
}

function isQwenLocalProvider(ttsProvider) {
  return String(ttsProvider ?? "").toLowerCase() === "qwen_local";
}

async function loadUniversalFishTags() {
  return readJsonIfExists(path.join(process.cwd(), "config", "voice", "fish-s2-pro-control-tags.json"), {
    proven_core_tags: {
      pause_timing: ["[short pause]", "[pause]", "[long pause]"],
      physical: ["[inhale]", "[exhale]", "[sigh]"],
      volume_pitch_style: ["[low voice]", "[whisper]", "[soft voice]", "[pitch up]"],
      positive: ["[excited]", "[hopeful]"],
      negative: ["[sad]", "[nervous]", "[shocked]"],
      complex_social: ["[determined]", "[sarcastic]"],
      delivery_effects: ["[emphasis]", "[interrupting]"],
    },
    freeform_tag_templates: {},
    universal_recipes: {},
  });
}

async function loadSpeakabilityRules() {
  const candidates = [
    path.join(episodeDir, "dialogue_speakability_rules.json"),
    path.join(DATA_ROOT, "channels", channel, "series", seriesSlug, "dialogue_speakability_rules.json"),
    path.join(process.cwd(), "config", "voice", "dialogue-speakability-rules.json"),
  ];
  const merged = { replacements: [], performance_replacements: [], audit_patterns: [] };
  for (const filePath of candidates) {
    const rules = await readJsonIfExists(filePath, null);
    if (!rules) continue;
    merged.replacements.push(...(rules.replacements ?? []));
    merged.performance_replacements.push(...(rules.performance_replacements ?? []));
    merged.audit_patterns.push(...(rules.audit_patterns ?? []));
  }
  return merged;
}

function stripTitle(text) {
  return String(text ?? "")
    .split(/\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^#{1,6}\s+/.test(trimmed)) return false;
      if (/^SCENE\s+\d+\b/i.test(trimmed)) return false;
      if (/^(INT\.|EXT\.|INT\/EXT\.|EST\.)\s+/i.test(trimmed)) return false;
      if (/^\[(?:COLD\s+OPEN|CUT\s+TO|TITLE\/INTRO\s+BEAT|TITLE\s+CARD|INTRO\s+BEAT|WORD\s+INDEX|SYSTEM\s+REVEAL|FIRST\s+PUBLIC\s+REVERSAL|END\s+COLD\s+OPEN|END\s+CARD)\b[^\]]*\]$/i.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function colonDialogueLine(line) {
  const cleanedLine = String(line ?? "").trim().replace(/^\[COMMENT_BAIT\]\s*/i, "").replace(/^\[BREATH_BEAT\]\s*/i, "");
  const match = cleanedLine.match(/^([A-Z][A-Z0-9'’. -]{1,40}|[A-Z][A-Za-z0-9'’. -]{1,40}):\s*(.+)$/);
  if (!match) return null;
  const rawSpeaker = match[1].trim();
  const spoken = match[2].trim();
  if (!spoken) return null;
  if (/[.!?]/.test(rawSpeaker) && !/^(?:MR|MS|MRS|DR)\./i.test(rawSpeaker)) return null;
  if (/^(CHAPTER|EPISODE|SCENE|ACT|NOTE|VISUAL|EMOTION|SFX)$/i.test(rawSpeaker)) return null;
  if (/\d/.test(rawSpeaker)) return null;
  if (/^(?:SIMPLE VERSION|PUBLIC FILE|PUBLIC STATUS|WORK VALUE|BLANK STATUS|CIVILIAN COUNT|DISTANCE TO\b.*|JAE\b.*STATUS|LEVEL\b.*|MOTHER['’]S DOSE)$/i.test(rawSpeaker)) return null;
  if (/^(?:EVERY|THE|THEN|THAT)\b/i.test(rawSpeaker) && rawSpeaker.split(/\s+/).length >= 3) return null;
  if (rawSpeaker.split(/\s+/).length > 3) return null;
  if (/\b(?:wrote|looked|stood|walked|turned|battery|lanterns|clock|sirens|forms|stairs|doors|noise|speaker|radio|receiver|weather|light|lights|item|value)\b/i.test(rawSpeaker)) return null;
  return { speaker: speakerLabel(rawSpeaker), spoken };
}

function dialogueUnit(speaker, spoken, tags, speakabilityRules = {}, dialogueContext = {}, turnIndex = 0) {
  const natural = naturalizeDialogueLine(spoken.replace(/^["“]|["”]$/g, "").trim().replace(/,\s*$/, "."), speakabilityRules);
  const mappedRole = dialogueContext.roleByLabel?.get(speakerLabel(speaker));
  const tag = speakerSpecificDialogueTag(`${speaker}-${turnIndex}`, mappedRole) ?? dialogueContext.tagByLabel?.get(speaker) ?? tags.dialogue?.[speaker] ?? fallbackDialogueTagForSpeaker(speaker);
  const performance = shapeDialoguePerformanceText(natural, speaker, mappedRole, turnIndex, speakabilityRules);
  return {
    kind: "dialogue",
    speaker,
    text: `"${natural}"`,
    performed_text: attachDialogueTag(tag, performance),
    caption_text: `"${natural}"`,
  };
}

function shouldNarrateIncidentalDialogue(speaker, spoken) {
  const label = speakerLabel(speaker);
  const line = String(spoken ?? "").replace(/^["“]|["”]$/g, "").trim();
  if (!line) return false;
  if (!/^(?:TRAINEE|BYSTANDER|CROWD|CIVILIAN|WORKER|STUDENT|HUNTER|GUARD|NURSE|CLERK|MAN|WOMAN|VOICE|ONLOOKER|SPECTATOR|WITNESS)(?:\s+\d+)?$/i.test(label)) return false;
  const wordCount = words(line).length;
  if (wordCount > 5) return false;
  if (/[?]/.test(line)) return false;
  if (/^(?:run|stop|move|hide|wait|help|open|close|duck|get down|look out|don't|do not)\b/i.test(line)) return false;
  if (/\b(?:captain|sir|ma'am|mom|mother|father|dad|doctor|healer|system|level|dead|alive|blood|fire|monster|gate)\b/i.test(line)) return false;
  return /\b(?:it|he|she|they|that|this|there|here)\b/i.test(line);
}

function lastMentionedSpeaker(text, dialogueContext) {
  let best = null;
  for (const entry of dialogueContext?.entries ?? []) {
    for (const alias of entry.aliases) {
      if (!alias || String(alias).length < 2) continue;
      const escaped = String(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = [...text.matchAll(new RegExp(`\\b${escaped}\\b`, "gi"))];
      const last = matches.at(-1);
      if (last && (!best || last.index > best.index)) best = { index: last.index, label: entry.label };
    }
  }
  return best?.label ?? null;
}

function lastMentionedEntry(text, dialogueContext, excludedLabels = new Set()) {
  let best = null;
  for (const entry of dialogueContext?.entries ?? []) {
    if (excludedLabels.has(entry.label)) continue;
    for (const alias of entry.aliases) {
      if (!alias || String(alias).length < 2) continue;
      const escaped = String(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = [...text.matchAll(new RegExp(`\\b${escaped}\\b`, "gi"))];
      const last = matches.at(-1);
      if (last && (!best || last.index > best.index)) best = { index: last.index, entry };
    }
  }
  return best?.entry ?? null;
}

function inferQuoteSpeaker(paragraph, quote, dialogueContext = {}) {
  if (/app[a']?s close|did you drink water|dinosaur has seniority|dinosaur gets first sip|don't eat the last rice|blanket up|count slow|we get first pick|i'm hanging up|i have to hang up|^yes\.?$|^no\.?$|^tonight\.?$|^tomorrow\.?$/i.test(quote)) return "DAE-HO";
  if (/^appa\b|dinosaur drank|poor people|get different dreams|basement dreams|^appa\??$|i ate at school|dinosaur gets angry/i.test(quote)) return "HARU";
  const quoteStart = paragraph.indexOf(`"${quote}"`);
  const quoteEnd = quoteStart + quote.length + 2;
  const after = paragraph.slice(quoteEnd, quoteEnd + 500);
  const before = paragraph.slice(Math.max(0, quoteStart - 500), quoteStart);
  const context = `${before} ${after}`;
  const explicitBefore = lastMentionedSpeaker(before, dialogueContext);
  const explicitAfter = lastMentionedSpeaker(after, dialogueContext);
  const speechVerbPattern = "(?:said|asked|warned|answered|whispered|muttered|shouted|called|snapped|hissed|replied|told)";
  const actorBeforeMatch = before.match(new RegExp(`\\b([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)\\s+${speechVerbPattern}\\b`, "g"))?.at(-1);
  if (actorBeforeMatch) {
    const actorName = actorBeforeMatch.replace(new RegExp(`\\s+${speechVerbPattern}\\b.*`, "i"), "");
    const actor = (dialogueContext.entries ?? []).find((entry) => entry.aliases.some((alias) => {
      const left = speakerLabel(alias);
      const right = speakerLabel(actorName);
      return left === right || left.split(" ")[0] === right || right.split(" ")[0] === left;
    }));
    if (actor) return actor.label;
  }
  const addressed = (dialogueContext.entries ?? []).find((entry) => {
    const first = String(entry.name ?? "").split(/\s+/)[0];
    return first && new RegExp(`^${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(quote);
  });
  const contextualSpeaker = lastMentionedEntry(context, dialogueContext, addressed ? new Set([addressed.label]) : new Set());
  if (contextualSpeaker && addressed) return contextualSpeaker.label;
  if (addressed) {
    const nearbyOther = [...(dialogueContext.entries ?? [])]
      .filter((entry) => entry.label !== addressed.label)
      .map((entry) => ({ entry, index: Math.max(...entry.aliases.map((alias) => {
        const match = before.match(new RegExp(`\\b${String(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
        return match?.index ?? -1;
      })) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => b.index - a.index)[0]?.entry;
    if (nearbyOther) return nearbyOther.label;
  }
  if (/man's gentle voice|man['’]s gentle voice|male voice|voice filled the booth|speaker grille|broadcast/i.test(before)) {
    const villain = (dialogueContext.entries ?? []).find((entry) => /villain|antagonist|gray|broadcast/i.test(`${entry.role} ${entry.name}`));
    if (villain) return villain.label;
  }
  if (/^\s*,?\s*she\s+(said|asked|muttered|answered|called|laughed|whispered)/i.test(after)) {
    if (explicitBefore) return explicitBefore;
    if (explicitAfter) return explicitAfter;
    if (/clerk/i.test(context)) return "CLERK";
    return "UNKNOWN_DIALOGUE";
  }
  if (/^\s*,?\s*he\s+(said|asked|muttered|answered|called|laughed|whispered)/i.test(after)) {
    if (explicitBefore) return explicitBefore;
    if (explicitAfter) return explicitAfter;
    if (/teacher|Teacher Han/i.test(context)) return "TEACHER HAN";
    if (/clerk/i.test(context)) return "CLERK";
    return "UNKNOWN_DIALOGUE";
  }
  if (explicitBefore && new RegExp(`${speechVerbPattern}\\s*$`, "i").test(before.trim())) return explicitBefore;
  if (explicitAfter && new RegExp(`^\\s*,?\\s*${speechVerbPattern}\\b`, "i").test(after)) return explicitAfter;
  if (/man's gentle voice|man['’]s gentle voice|male voice|voice filled the booth|speaker grille|broadcast/i.test(context)) {
    const villain = (dialogueContext.entries ?? []).find((entry) => /villain|antagonist|gray|broadcast/i.test(`${entry.role} ${entry.name}`));
    if (villain) return villain.label;
  }
  if (/teacher/i.test(context)) return "TEACHER HAN";
  if (/collector|man spoke/i.test(context)) return "COLLECTOR";
  if (/clerk/i.test(context)) return "CLERK";
  return null;
}

function cleanNarrationAttribution(text) {
  return text
    .replace(/^,\s*(?!The\b|This\b|That\b|A\b|An\b|His\b|Her\b)[A-Z][A-Za-z-]+(?:\s+[A-Z][A-Za-z-]+){0,2}\s+(said|asked|muttered|answered|called|laughed|whispered|warned|replied)\.?\s*/i, "")
    .replace(/^(?!The\b|This\b|That\b|A\b|An\b|His\b|Her\b)[A-Z][A-Za-z-]+(?:\s+[A-Z][A-Za-z-]+){0,2}\s+(said|asked|muttered|answered|called|laughed|whispered|warned|replied)\.?\s*/i, "")
    .replace(/^\s*(said|asked|muttered|answered|called|laughed|whispered|warned|replied)\s+[A-Z][A-Za-z-]+(?:\s+[A-Z][A-Za-z-]+){0,2}\.?\s*/i, "")
    .replace(/^,\s*(the teacher|the collector|the clerk)\s+(said|asked|muttered|answered|called|laughed|whispered)\.?\s*/i, "")
    .replace(/^(the teacher|the collector|the clerk)\s+(said|asked|muttered|answered|called|laughed|whispered)\.?\s*/i, "")
    .replace(/^\s*(said|asked)\s+(the teacher|the collector|the clerk)\.?\s*/i, "")
    .trim();
}

function applyRuleReplacements(text, rules, key = "replacements") {
  let next = text;
  for (const rule of rules?.[key] ?? []) {
    if (!rule?.from || typeof rule.to !== "string") continue;
    const pattern = rule.regex === true
      ? new RegExp(rule.from, rule.flags ?? "gi")
      : new RegExp(rule.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), rule.flags ?? "gi");
    next = next.replace(pattern, rule.to);
  }
  return next;
}

function naturalizeDialogueLine(text, rules = {}) {
  return applyRuleReplacements(text, rules);
}

function naturalizePerformanceText(text, rules = {}) {
  return applyRuleReplacements(naturalizeDialogueLine(text, rules), rules, "performance_replacements")
    .replace(/\s+/g, " ")
    .trim();
}

function startsWithPerformanceTag(text) {
  return /^\s*\[[^\]]+\]/.test(String(text ?? ""));
}

function attachDialogueTag(tag, performanceText) {
  const clean = String(performanceText ?? "").trim();
  if (!clean) return String(tag ?? "").trim();
  if (startsWithPerformanceTag(clean)) return clean;
  return `${tag} ${clean}`.trim();
}

function shapeDialoguePerformanceText(text, speaker, role, turnIndex = 0, rules = {}) {
  const performance = naturalizePerformanceText(text, rules);
  if (!performance || startsWithPerformanceTag(performance)) return performance;
  const resolvedRole = role ?? fallbackRoleFromSpeakerLabel(speakerLabel(speaker));
  const panicCue = /\b(?:emergency|monster|demon|dragon|apocalypse|blood|fire|run|dead|kill|danger|impact|exploded)\b/i.test(performance);
  const confusionCue = /\b(?:what|wait|no|n-no|sorry|okay|how|why|that is not|i am not|i don't|i cannot|can't|this is)\b/i.test(performance);
  const tendernessCue = /\b(?:please|thank you|sorry|dad|mom|father|mother|hungry|cold|hurt|home)\b/i.test(performance);
  const isQuestion = /\?["”]?$/.test(performance);
  const isShortCommand = words(performance).length <= 5 && /\b(?:bring|give|present|stop|wait|look|run|hide|open|come|go|move)\b/i.test(performance);

  if (resolvedRole === "kawaii_child_female" || resolvedRole === "child_female") {
    if (isShortCommand || /tribute|fish|mine|servant|peasant|rejected/i.test(performance)) return `[cute, bossy small voice] ${performance}`;
    if (panicCue) return `[bright little voice, alarmed but clear] ${performance}`;
    if (tendernessCue) return `[soft young girl voice, sincere] ${performance}`;
    return turnIndex % 2 ? `[cute young girl voice, crisp and emotional] ${performance}` : performance;
  }
  if (resolvedRole === "child_male" || resolvedRole === "child") {
    if (tendernessCue) return `[soft child voice, trying to be brave] ${performance}`;
    if (panicCue) return `[small child voice, scared but clear] ${performance}`;
    return performance;
  }
  if (resolvedRole === "elder_male") {
    if (confusionCue || isQuestion) return `[older male voice, dry and deliberate] ${performance}`;
    if (panicCue) return `[older male voice, controlled alarm] ${performance}`;
    return performance;
  }
  if (resolvedRole === "elder_female") {
    if (confusionCue || isQuestion) return `[elderly woman voice, careful and grounded] ${performance}`;
    if (panicCue) return `[older female voice, controlled urgency] ${performance}`;
    return performance;
  }
  if (resolvedRole === "adult_male" || resolvedRole === "young_male") {
    if (confusionCue && panicCue) return `[confused, trying not to panic] ${performance}`;
    if (confusionCue || isQuestion) return `[hesitant, thinking out loud] ${performance}`;
    if (tendernessCue) return `[guarded, emotionally exposed] ${performance}`;
    return performance;
  }
  if (resolvedRole === "female" || resolvedRole === "young_female") {
    if (panicCue) return `[alert female voice, controlled urgency] ${performance}`;
    if (isQuestion) return `[careful female voice, skeptical] ${performance}`;
  }
  return performance;
}

function isSoundDesignText(text) {
  const clean = String(text ?? "").trim();
  if (!clean) return false;
  if (isExplicitSoundDesignCueText(clean)) return true;
  if (colonDialogueLine(clean)) return false;
  if (/"[^"]+"/.test(clean)) return false;
  if (isOnomatopoeiaOnlyCue(clean)) return true;
  return false;
}

function isExplicitSoundDesignCueText(text) {
  const clean = String(text ?? "").trim();
  if (/^SFX\s*:/i.test(clean)) return true;
  const bracket = clean.match(/^\[([^\]]{1,120})\]$/);
  if (!bracket) return false;
  const cue = bracket[1].trim();
  if (/^(?:SFX|SOUND|SOUND DESIGN|AMBIENCE|AMBIENT|ROOM TONE|MUSIC|SCORE)\s*:/i.test(cue)) return true;
  return /\b(?:glass shatter|crowd laughter|crowd gasp|loud bang|impact|crash|slam|beep|alarm|siren|room tone|silence|music|score)\b/i.test(cue);
}

function isOnomatopoeiaOnlyCue(text) {
  const clean = String(text ?? "")
    .trim()
    .replace(/^SFX\s*:\s*/i, "")
    .replace(/^\[(?:SFX|SOUND|SOUND DESIGN|AMBIENCE|AMBIENT|ROOM TONE|MUSIC|SCORE)\s*:\s*/i, "")
    .replace(/\]$/i, "")
    .replace(/[()[\]{}"“”'’]/g, "")
    .trim();
  if (!clean) return false;
  const tokens = clean
    .split(/[\s,.;:!?-]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length || tokens.length > 8) return false;
  const knownSoundTokens = new Set([
    "tik", "tick", "pff", "pfft", "pop", "poof", "crack", "crk", "snap", "click", "clack",
    "beep", "bip", "buzz", "bzz", "whirr", "whir", "hiss", "shh", "shhh", "tsk", "thunk",
    "thud", "clang", "clink", "ding", "dong", "boom", "bam", "whoosh", "fwip", "splat",
  ]);
  return tokens.every((token) => knownSoundTokens.has(token) || /^[bpstwz]+$/i.test(token) && /(.)\1/.test(token));
}

function splitIntoSentences(text) {
  const value = String(text ?? "").trim();
  if (!value) return [];
  const placeholders = new Map();
  let index = 0;
  const protect = (match) => {
    const key = `__ABBR_${index++}__`;
    placeholders.set(key, match);
    return key;
  };
  const protectedValue = value
    .replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\./g, protect)
    .replace(/\b(?:a\.m\.|p\.m\.)/gi, protect)
    .replace(/\b[A-Z]\./g, protect);
  const restore = (part) => {
    let next = part;
    for (const [key, original] of placeholders) next = next.replaceAll(key, original);
    return next.trim();
  };
  return protectedValue.match(/[^.!?]+[.!?]+(?:["”])?|[^.!?]+$/g)?.map(restore).filter(Boolean) ?? [value];
}

function soundDesignUnit(text) {
  const clean = String(text ?? "")
    .trim()
    .replace(/^SFX\s*:\s*/i, "")
    .replace(/^\[(?:SFX|SOUND|SOUND DESIGN|AMBIENCE|AMBIENT|ROOM TONE|MUSIC|SCORE)\s*:\s*/i, "")
    .replace(/\]$/i, "")
    .trim();
  const cueId = inferSoundDesignCueId(clean);
  return {
    kind: "sound_design",
    speaker: "SFX",
    text: clean,
    performed_text: "",
    caption_text: `[SFX: ${clean.replace(/[.!?]+$/g, "")}]`,
    sfx_cue: {
      source: /radio|receiver|speaker|static|tone|whine|broadcast/i.test(clean) ? "radio_or_speaker" : "environment",
      cue_id: cueId,
      description: clean,
      policy: "Do not send this prose to Fish as narrator speech; layer or synthesize as sound design.",
    },
  };
}

function inferSoundDesignCueId(text) {
  const lower = String(text ?? "").toLowerCase();
  if (/\btik\.?\s*tik\.?\s*pff\b|\begg (?:crack|split|shell)|shell (?:crack|dust)|hatch pop|magical puff|glittering shell/.test(lower)) return "egg_shell_magic_pop";
  if (/\b(?:receipt printer|printer cough|thermal printer|paper feed|machine coughed)\b/.test(lower)) return "printer_cough";
  if (/\b(?:static|radio|receiver|speaker crackle|carrier whine)\b/.test(lower)) return "radio_static_bed";
  if (/\b(?:impact|slam|crash|glass crack|shatter)\b/.test(lower)) return "impact_crack";
  if (/\b(?:crowd gasp|audience gasp|gallery (?:hiss|gasp|murmur)|hiss moved through the gallery|hiss through the gallery|students? (?:gasp|leaned back)|gallery stopped laughing|nobles laughed)\b/.test(lower)) return "crowd_gasp_cut";
  return null;
}

function narrationPerformanceUnits(text) {
  const units = [];
  let remaining = text.trim().replace(/^\[COMMENT_BAIT\]\s*/i, "").replace(/^\[BREATH_BEAT\]\s*/i, "");
  const mcInternal = /^\[MC_INTERNAL\]\s*/i.test(remaining);
  if (mcInternal) {
    remaining = remaining.replace(/^\[MC_INTERNAL\]\s*:?\s*/i, "").trim();
    for (const sentence of splitIntoSentences(remaining)) {
      if (!sentence) continue;
      units.push({
        kind: "mc_internal",
        speaker: "MC_INTERNAL",
        text: sentence,
        performed_text: sentence,
        caption_text: sentence,
        metadata_tags: ["MC_INTERNAL"],
      });
    }
    return units;
  }
  if (/^SFX\s*:/i.test(remaining)) {
    units.push(soundDesignUnit(remaining));
    return units;
  }
  const weakLaugh = remaining.match(/^([A-Z][A-Za-z'’. -]{1,40}) gave a thin laugh, then swallowed the wheeze\.\s*/i);
  if (weakLaugh) {
    const speaker = speakerLabel(weakLaugh[1]);
    units.push({
      kind: "performance_action",
      speaker,
      text: weakLaugh[0].trim(),
      performed_text: "[chuckling softly] heh... [gasping quietly] mm.",
      caption_text: `[${weakLaugh[1]} laughs weakly, then catches a wheeze.]`,
    });
    remaining = remaining.slice(weakLaugh[0].length).trim();
  }
  const characterPause = remaining.match(/^([A-Z][A-Za-z'’. -]{1,40}) always paused before that one\.\s*/i);
  if (characterPause) {
    units.push({
      kind: "performance_action",
      speaker: speakerLabel(characterPause[1]),
      text: characterPause[0].trim(),
      performed_text: "[short pause]",
      caption_text: `[${characterPause[1]} goes quiet.]`,
    });
    remaining = remaining.slice(characterPause[0].length).trim();
  }
  for (const sentence of splitIntoSentences(remaining)) {
    if (isSoundDesignText(sentence)) {
      units.push(soundDesignUnit(sentence));
    } else if (sentence) {
      units.push({ kind: "narration", speaker: "NARRATOR", text: sentence, performed_text: sentence, caption_text: sentence });
    }
  }
  return units;
}

function detectMode(text, index, total, explicitSpeaker = null) {
  const upper = text.toUpperCase();
  const lower = text.toLowerCase();
  if (explicitSpeaker && /^MC_INTERNAL$/i.test(explicitSpeaker)) return "mc_internal";
  if (explicitSpeaker && /^(SYSTEM|SYSTEM UI|UI|NOTICE|WARNING)$/i.test(explicitSpeaker)) return "warning/system";
  if (explicitSpeaker && explicitSpeaker !== "NARRATOR") return "character_dialogue";
  if (/^[A-Z][A-Z0-9'’. -]{1,40}:/.test(text) || /^[A-Z][A-Za-z0-9'’. -]{1,40}:/.test(text)) return "character_dialogue";
  const sentenceParts = splitIntoSentences(text).map((part) => part.trim()).filter(Boolean);
  const shortInventoryRun = sentenceParts.length >= 4 && sentenceParts.filter((part) => words(part).length <= 4).length >= 3;
  if (shortInventoryRun && /noise thinned|forms|lanterns|exit map|doors visible|behind her|clock|sirens|badge|stairs|stairwell|froze|trapped|failed|route|shelter/i.test(lower)) {
    return "panic/freeze inventory";
  }
  if (/system|continuity|probability|timeline deviation|future son/i.test(text)) return "warning/system";
  if (/loudspeaker|radio booth|broadcast|missing brother|on air|cassette|tape label|speaker grille|pay with one voice|dead intercom|recorded yesterday/i.test(lower)) return "tense reveal";
  if (/haru|son|appa|baby bracelet|raincoat|child/i.test(lower)) return "memory/child tenderness";
  if (/bitcoin|wallet|forum|game currency|account|cash|broker/i.test(lower)) return "strategy";
  if (/woke|mirror|fifteen|2009|calendar|regression/i.test(lower)) return "regression shock";
  if (/mother|father|kitchen|family|rice|gas|heat/i.test(lower)) return "family";
  if (/laughed|joke|absurd|cosmic/i.test(lower) && !/missing|brother|voice|speaker|radio|recorded|intercom/i.test(lower)) return "dry humor";
  if (index >= total - 3) return "cliffhanger landing";
  if (/clinic|deposit|medicine|rent|coins|poverty|delivery/i.test(lower)) return "failed future / poverty";
  return "exposition narration";
}

function sanitizeDeliveryMode({ detectedMode, hasDialogue, hasNarration, speakers, body }) {
  if ((speakers ?? []).some((speaker) => /^MC_INTERNAL$/i.test(String(speaker ?? "")))) return "mc_internal";
  const nonNarratorSpeakers = (speakers ?? []).filter((speaker) => !/^(NARRATOR|SFX)$/i.test(String(speaker ?? "")));
  if (!hasDialogue && hasNarration && nonNarratorSpeakers.length === 0 && detectedMode === "character_dialogue") {
    return "exposition narration";
  }
  if (!hasDialogue && hasNarration && /^(NARRATOR)$/i.test(String(speakers?.[0] ?? "NARRATOR")) && detectedMode === "character_dialogue") {
    return "exposition narration";
  }
  if (!hasDialogue && hasNarration && /^[A-Z][A-Za-z0-9'’. -]{1,40}\s+(?:,|was|worked|counted|stood|sat|looked|walked|held|opened|closed|reached)/.test(String(body ?? ""))) {
    return detectedMode === "character_dialogue" ? "exposition narration" : detectedMode;
  }
  return detectedMode;
}

function speakerFor(text) {
  const match = text.match(/^([A-Z][A-Z0-9'’. -]{1,40}|[A-Z][A-Za-z0-9'’. -]{1,40}):/);
  return match ? match[1].trim().toUpperCase() : "NARRATOR";
}

function isNarratorSpeaker(speaker) {
  return /^(NARRATOR|VOICEOVER|VOICE\s+OVER|VO|V\.O\.)$/i.test(String(speaker ?? "").trim());
}

function leadingBracketTag(text) {
  return String(text ?? "").trim().match(/^((?:<\|speaker:\d+\|>)?\[[^\]]+\])/)?.[1]?.replace(/^<\|speaker:\d+\|>/, "") ?? null;
}

function universalTagForMode(mode, text, tags, segmentIndex) {
  const recipes = tags.universal_recipes ?? {};
  const core = tags.proven_core_tags ?? {};
  const lower = text.toLowerCase();
  const usableTags = (items) => (Array.isArray(items) ? items : []).filter((tag) => !/^\[(?:short\s+pause|pause|long\s+pause)\]$/i.test(String(tag).trim()));
  const safeNarrationTags = (items) => usableTags(items).filter((tag) => !/\[(?:screaming|shouting|loud|volume up|pitch up)\]/i.test(String(tag).trim()));
  const first = (items, fallback) => {
    const filtered = usableTags(items);
    if (!filtered.length) return fallback;
    return filtered[segmentIndex % filtered.length];
  };
  const firstSafeNarration = (items, fallback) => {
    const filtered = safeNarrationTags(items);
    if (!filtered.length) return fallback;
    return filtered[segmentIndex % filtered.length];
  };
  const mix = (items, fallback) => first(items, fallback);
  if (mode === "memory/child tenderness") {
    if (/haru|appa|child|son/.test(lower)) return mix([...(recipes.tender_child_line ?? ["[soft voice]"]), "[sad]", "[hopeful]", "[voice breaking]"], "[soft voice]");
    return first(core.negative, "[sad]");
  }
  if (mode === "regression shock") return firstSafeNarration(recipes.teen_panic, "[shocked]");
  if (mode === "strategy") return /bitcoin|wallet|forum|cash|broker/i.test(text)
    ? first(recipes.strategy_focus, "[determined]")
    : first((core.complex_social ?? []).filter((tag) => !/sarcastic|contempt/i.test(tag)), "[determined]");
  if (mode === "warning/system") return first(recipes.system_or_robotic_warning, "[low voice]");
  if (mode === "panic/freeze inventory") return mix(["[stunned, breath shallow]", "[low, tense]", "[voice tightens]", "[controlled panic]"], "[low, tense]");
  if (mode === "tense reveal") return first(recipes.revelation, "[shocked]");
  if (mode === "family") return /mother|father/.test(lower) ? first(core.negative, "[worried]") : firstSafeNarration(core.volume_pitch_style, "[low voice]");
  if (mode === "dry humor") return first(recipes.dry_humor, "[sarcastic]");
  if (mode === "cliffhanger landing") return first(recipes.cliffhanger, "[low voice]");
  if (mode === "failed future / poverty") return first(recipes.exhausted_narration, "[sad]");
  if (mode === "performed dialogue mix") return firstSafeNarration(core.volume_pitch_style, "[low voice]");
  if (mode === "exposition narration") {
    return ["[low, intimate narration]", "[quiet, focused]", "[hushed curiosity]", "[low, tense]"][segmentIndex % 4];
  }
  return first((core.complex_social ?? []).filter((tag) => !/sarcastic|contempt/i.test(tag)), "[determined]");
}

function tagForMode(mode, text, allTags, segmentIndex) {
  const speaker = speakerFor(text);
  if (mode === "character_dialogue") return allTags.dialogue?.[speaker] ?? allTags.dialogue?.DEFAULT ?? "[lightly acted dialogue]";
  if (allTags.universal_recipes || allTags.proven_core_tags) return universalTagForMode(mode, text, allTags, segmentIndex);
  const pools = {
    "failed future / poverty": allTags.failed_future ?? allTags.default,
    "memory/child tenderness": allTags.haru ?? allTags.default,
    "regression shock": allTags.regression ?? allTags.default,
    strategy: allTags.strategy ?? allTags.default,
    "warning/system": allTags.system ?? allTags.default,
    "tense reveal": allTags.system ?? allTags.cliffhanger ?? allTags.default,
    family: allTags.family ?? allTags.default,
    "dry humor": allTags.humor ?? allTags.default,
    "cliffhanger landing": allTags.cliffhanger ?? allTags.default,
    "performed dialogue mix": allTags.dialogue_mix ?? allTags.default,
    "exposition narration": allTags.default ?? allTags.strategy ?? ["[low, focused]"],
  };
  const pool = pools[mode] ?? allTags.default ?? ["[low, focused]"];
  return pool[segmentIndex % pool.length];
}

function physicalCueFor(mode, segmentIndex, allTags, text = "") {
  const lower = String(text ?? "").toLowerCase();
  const physical = (allTags.proven_core_tags?.physical ?? allTags.physical ?? [])
    .filter((tag) => {
      const value = String(tag ?? "").toLowerCase();
      if (/\[panting\]/.test(value)) return /run|ran|sprint|chase|panic|breathless|gasp|air|fight|collapse/.test(lower);
      if (/\[(?:laughing|chuckle|chuckling)\]/.test(value)) return /laugh|joke|smile|funny|comic|absurd|dry humor/.test(`${mode} ${lower}`);
      return true;
    });
  if (!physical.length) return null;
  if (Number.isFinite(maxDurationSec) && maxDurationSec > 0 && segmentIndex === 0 && ["memory/child tenderness", "failed future / poverty"].includes(mode)) {
    return "[breathes in]";
  }
  if (Number.isFinite(maxDurationSec) && maxDurationSec > 45 && ["tense reveal", "performed dialogue mix", "character_dialogue"].includes(mode) && segmentIndex === 1) {
    return physical[segmentIndex % physical.length];
  }
  if (["memory/child tenderness", "regression shock", "warning/system", "cliffhanger landing", "failed future / poverty", "family", "panic/freeze inventory"].includes(mode) && segmentIndex % 2 === 1) {
    return physical[segmentIndex % physical.length];
  }
  if (["regression shock", "warning/system", "cliffhanger landing"].includes(mode)) return physical[segmentIndex % physical.length];
  return null;
}

function pauseForMode(mode, segmentIndex) {
  if (mode === "cliffhanger landing") return "[long pause]";
  if (["warning/system", "tense reveal", "regression shock", "memory/child tenderness", "panic/freeze inventory"].includes(mode)) return segmentIndex % 2 ? "[short pause]" : null;
  if (mode === "character_dialogue") return "[micro-pause]";
  if (mode === "performed dialogue mix" && segmentIndex % 3 === 0) return "[micro-pause]";
  return null;
}

function isPauseOnlyTag(tag) {
  return /^\[(?:short\s+pause|pause|long\s+pause|micro-pause)\]$/i.test(String(tag ?? "").trim());
}

function lightlyPunctuate(text, mode) {
  if (mode === "cliffhanger landing" && !/[.!?…]$/.test(text)) return `${text}.`;
  return text;
}

function paragraphUnits(script, tags, speakabilityRules = {}, dialogueContext = {}) {
  const units = [];
  let dialogueTurnIndex = 0;
  const paragraphs = stripTitle(script).split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const lines = paragraph.split(/\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1 && lines.some((line) => colonDialogueLine(line))) {
      for (const line of lines) {
        const colon = colonDialogueLine(line);
        if (colon) {
          if (isNarratorSpeaker(colon.speaker)) {
            units.push(...narrationPerformanceUnits(cleanNarrationAttribution(colon.spoken)));
          } else if (shouldNarrateIncidentalDialogue(colon.speaker, colon.spoken)) {
            units.push(...narrationPerformanceUnits(cleanNarrationAttribution(colon.spoken)));
          } else {
            units.push(dialogueUnit(colon.speaker, colon.spoken, tags, speakabilityRules, dialogueContext, dialogueTurnIndex++));
          }
        } else if (line) {
          units.push(...narrationPerformanceUnits(cleanNarrationAttribution(line)));
        }
      }
      units.push({ kind: "segment_boundary", speaker: "BOUNDARY", text: "", performed_text: "", caption_text: "" });
      continue;
    }
    const wholeLineDialogue = colonDialogueLine(paragraph);
    if (wholeLineDialogue) {
      if (isNarratorSpeaker(wholeLineDialogue.speaker)) {
        units.push(...narrationPerformanceUnits(cleanNarrationAttribution(wholeLineDialogue.spoken)));
      } else if (shouldNarrateIncidentalDialogue(wholeLineDialogue.speaker, wholeLineDialogue.spoken)) {
        units.push(...narrationPerformanceUnits(cleanNarrationAttribution(wholeLineDialogue.spoken)));
      } else {
        units.push(dialogueUnit(wholeLineDialogue.speaker, wholeLineDialogue.spoken, tags, speakabilityRules, dialogueContext, dialogueTurnIndex++));
      }
      units.push({ kind: "segment_boundary", speaker: "BOUNDARY", text: "", performed_text: "", caption_text: "" });
      continue;
    }
    let cursor = 0;
    const quotes = [...paragraph.matchAll(/"([^"]+)"/g)];
    if (!quotes.length) {
      units.push(...narrationPerformanceUnits(paragraph));
      units.push({ kind: "segment_boundary", speaker: "BOUNDARY", text: "", performed_text: "", caption_text: "" });
      continue;
    }
    for (const quote of quotes) {
      const index = quote.index ?? 0;
      const before = cleanNarrationAttribution(paragraph.slice(cursor, index).trim());
      if (before) {
        units.push(...narrationPerformanceUnits(before));
        if (words(before).length >= 16) units.push({ kind: "segment_boundary", speaker: "BOUNDARY", text: "", performed_text: "", caption_text: "" });
      }
      const spoken = naturalizeDialogueLine(quote[1].trim().replace(/,\s*$/, "."), speakabilityRules);
      const speaker = inferQuoteSpeaker(paragraph, spoken, dialogueContext);
      if (!speaker) {
        units.push(...narrationPerformanceUnits(spoken));
        units.push({ kind: "segment_boundary", speaker: "BOUNDARY", text: "", performed_text: "", caption_text: "" });
        cursor = index + quote[0].length;
        continue;
      }
      const mappedRole = dialogueContext.roleByLabel?.get(speakerLabel(speaker));
      const tag = speakerSpecificDialogueTag(`${speaker}-${dialogueTurnIndex++}`, mappedRole) ?? dialogueContext.tagByLabel?.get(speaker) ?? tags.dialogue?.[speaker] ?? fallbackDialogueTagForSpeaker(speaker);
      const performance = shapeDialoguePerformanceText(spoken, speaker, mappedRole, dialogueTurnIndex, speakabilityRules);
      units.push({ kind: "dialogue", speaker, text: `"${spoken}"`, performed_text: attachDialogueTag(tag, performance), caption_text: `"${spoken}"` });
      units.push({ kind: "segment_boundary", speaker: "BOUNDARY", text: "", performed_text: "", caption_text: "" });
      cursor = index + quote[0].length;
    }
    const after = cleanNarrationAttribution(paragraph.slice(cursor).trim());
    if (after) units.push(...narrationPerformanceUnits(after));
    units.push({ kind: "segment_boundary", speaker: "BOUNDARY", text: "", performed_text: "", caption_text: "" });
  }
  return units;
}

function words(text) {
  return text.split(/\s+/).filter(Boolean);
}

function splitLongDialogueUnit(unit, maxWords = 38) {
  if (!unit || unit.kind !== "dialogue") return [unit];
  const spoken = String(unit.text ?? "").replace(/^["“]|["”]$/g, "").trim();
  if (words(spoken).length <= maxWords) return [unit];
  const tag = leadingBracketTag(unit.performed_text) ?? null;
  const sentences = splitIntoSentences(spoken).map((part) => part.trim()).filter(Boolean);
  if (sentences.length <= 1) return [unit];
  const chunks = [];
  let currentChunk = [];
  let currentCount = 0;
  for (const sentence of sentences) {
    const sentenceCount = words(sentence).length;
    if (currentChunk.length && currentCount + sentenceCount > maxWords) {
      chunks.push(currentChunk.join(" "));
      currentChunk = [];
      currentCount = 0;
    }
    currentChunk.push(sentence);
    currentCount += sentenceCount;
  }
  if (currentChunk.length) chunks.push(currentChunk.join(" "));
  if (chunks.length <= 1) return [unit];
  return chunks.map((chunk) => ({
    ...unit,
    text: `"${chunk}"`,
    performed_text: attachDialogueTag(tag, chunk),
    caption_text: `"${chunk}"`,
    auto_split_from_long_dialogue: true,
  }));
}

const EMOTIONAL_AUDIO_TEXTURES = ["tension", "comedy_beat", "ambient_calm", "impact", "silence", "dread", "wonder", "escalation"];

function classifyEmotionalAudioTexture(text, mode = "", sfxCues = []) {
  const haystack = [
    text,
    mode,
    ...(sfxCues ?? []).map((cue) => `${cue.cue_id ?? ""} ${cue.description ?? ""}`),
  ].join(" ").toLowerCase();
  if (/\b(silence|quiet|held breath|pause|stillness|no sound|stopped moving)\b/.test(haystack)) return "silence";
  if (/\b(exploded|shattered|impact|slam|crash|hit|cut|blood|glass teeth|monster landed|window exploded|attack|scream|alarm)\b/.test(haystack)) return "impact";
  if (/\b(dread|warning|detected|bounty|hidden|clinical|fear|threat|monster|danger|predatory|horror|dark|black shape|wrong angles|teeth|glass reflection)\b/.test(haystack)) return "dread";
  if (/\b(comedy|joke|funny|absurd|ridiculous|nope|customer-service|cheeks|tribute|offended|pudding|egg|prank|haunted)\b/.test(haystack)) return "comedy_beat";
  if (/\b(escalat|countdown|timer|chase|ran|pursuit|hurry|fast|urgent|deadline|bought|purchased|license|caught)\b/.test(haystack)) return "escalation";
  if (/\b(wonder|miracle|glow|appeared|opened|sparkle|starry|first time|impossible second|awe)\b/.test(haystack)) return "wonder";
  if (/\b(ambient|room tone|rain|wind|fluorescent|hum|static bed|store|apartment|hallway|calm)\b/.test(haystack)) return "ambient_calm";
  return "tension";
}

function classifyTempo(text, expectedDurationSec, mode = "") {
  if (/sound_design|silence/i.test(mode) || !String(text ?? "").trim()) return "silent";
  const count = words(String(text ?? "")).length;
  const duration = Math.max(1, Number(expectedDurationSec) || count / 145 * 60);
  const wps = count / duration;
  const haystack = `${mode} ${text}`.toLowerCase();
  if (/cliffhanger|memory|tender|dread|warning|system|poverty|family|slow|silence|pause|froze|nothing came|held breath|quiet|shocked/.test(haystack) || wps < 1.85 || count <= 4) return "slow";
  if (/\b(comedy|dry humor|urgent|panic|escalation|countdown|monster|attack|crash|explod|changed at once|prank|haunted|purchase|license|barrier|ran|chase)\b/.test(haystack)) return "fast";
  if (!/dialogue/.test(haystack) && wps > 3.4) return "fast";
  return "medium";
}

function expectedFishDurationSec(text, { mode = "", hasDialogue = false, hasNarration = false, speakers = [], pause = null, physical = null } = {}) {
  const count = words(String(text ?? "")).length;
  if (!count) return 1;
  const speakerText = speakers.join(" ").toUpperCase();
  const modeText = String(mode ?? "").toLowerCase();
  let wpm = 145;

  // Fish reads clean narration faster than dialogue, while dialogue and mixed
  // narration need room for acting, breaths, and speaker changes. Calibrating
  // here keeps the post-Fish duration gate meaningful instead of comparing
  // real acting against a single generic narration speed.
  if (hasDialogue && hasNarration) wpm = 120;
  else if (hasDialogue) wpm = 105;
  else if (/\b(SYSTEM|NOTICE|WARNING|UI)\b/.test(speakerText) || /system|warning/.test(modeText)) wpm = 100;
  else wpm = 190;

  if (/cliffhanger|dread|tender|memory|child|grief|shame|breath held|dangerous stillness/.test(modeText)) {
    wpm = Math.min(wpm, hasDialogue ? 105 : 145);
  }
  if (/comedy|dry humor|urgent|panic|escalation|attack|monster|countdown/.test(modeText)) {
    wpm = Math.max(wpm, hasDialogue ? 115 : 175);
  }

  const tagPadding = (pause ? 0.15 : 0) + (physical ? 0.2 : 0);
  return Number(Math.max(1, (count / wpm * 60) + tagPadding).toFixed(1));
}

function balanceTempoClassifications(segments) {
  const tempos = ["fast", "medium", "slow", "silent"];
  const counts = () => Object.fromEntries(tempos.map((tempo) => [tempo, segments.filter((segment) => segment.pacing_tempo === tempo).length]));
  let current = counts();
  let top = Object.entries(current).sort((a, b) => b[1] - a[1])[0] ?? ["medium", 0];
  if (top[0] === "silent" || !segments.length || top[1] / segments.length <= 0.6) return segments;
  const needed = Math.max(1, Math.ceil(top[1] - segments.length * 0.6));
  const candidates = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.pacing_tempo === top[0])
    .map((row) => {
      const text = `${row.segment.delivery_mode ?? ""} ${row.segment.emotional_audio_texture ?? ""} ${row.segment.stripped_text ?? ""}`.toLowerCase();
      const wordCount = words(row.segment.stripped_text ?? "").length;
      let target = null;
      let score = 0;
      if (top[0] === "medium" && (/\b(dread|warning|system|shocked|poverty|family|quiet|froze|nothing came|receipt wrapped)\b/.test(text) || wordCount <= 8)) {
        target = "slow";
        score += 3;
      }
      if (/\b(comedy_beat|impact|escalation|dry humor|dialogue|monster|crash|panic|countdown|prank|haunted|purchased|confirmed|emergency|door clicked|bank accounts|tribute first)\b/.test(text) || wordCount >= 28) {
        target = target ?? "fast";
        score += 2;
      }
      if (top[0] === "slow" && !target && wordCount >= 18 && !/\b(silence|nothing came|held breath|quiet|tender|child tenderness|cliffhanger)\b/.test(text)) {
        target = "medium";
        score += 1;
      }
      if (!target) return null;
      return { ...row, target, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  for (const candidate of candidates.slice(0, needed)) {
    candidate.segment.tempo_rebalanced_from = candidate.segment.pacing_tempo;
    candidate.segment.pacing_tempo = candidate.target;
    candidate.segment.tempo_rebalance_reason = "Automatic voice-stage tempo correction: avoid one pacing tempo dominating the episode by classifying obvious dread, comedy, impact, action, or connective beats more specifically.";
  }
  return segments;
}

function minimumPhysicalTagsForCurrentRun() {
  const isTestSlice = Number.isFinite(maxDurationSec) && maxDurationSec > 0;
  if (isTestSlice && maxDurationSec <= 45) return 0;
  if (isTestSlice && maxDurationSec < 90) return 1;
  return 2;
}

function preferredPhysicalTags(allTags = {}) {
  const configured = [
    ...(allTags.proven_core_tags?.physical ?? []),
    ...(allTags.physical ?? []),
  ].filter(Boolean);
  const fallback = ["[inhale]", "[exhale]", "[sigh]", "[swallows hard]"];
  return [...new Set([...configured, ...fallback])]
    .filter((tag) => /^\[[^\]]+\]$/.test(String(tag ?? "")))
    .filter((tag) => !/\b(?:laughing|chuckle|panting|screaming|shouting)\b/i.test(tag));
}

function ensureMinimumPhysicalTags(segments, allTags = {}) {
  const minPhysicalTags = minimumPhysicalTagsForCurrentRun();
  if (!minPhysicalTags) return segments;
  const currentCount = segments.reduce((sum, segment) => sum + (segment.physical_tags?.length ?? 0), 0);
  if (currentCount >= minPhysicalTags) return segments;
  const tags = preferredPhysicalTags(allTags);
  if (!tags.length) return segments;
  const candidates = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.fish_generation_required !== false && segment.delivery_mode !== "sound_design" && !(segment.physical_tags?.length))
    .map((row) => {
      const text = `${row.segment.delivery_mode ?? ""} ${row.segment.emotional_audio_texture ?? ""} ${row.segment.stripped_text ?? ""}`.toLowerCase();
      let score = 0;
      if (/\b(woke|trapped|beggar|body|debt|stain|blood|wrist|freezing|ice|wrong|fear|dread|cliffhanger|collector|seize|sell|vomited|hands|knuckles|hunger|soup)\b/.test(text)) score += 4;
      if (/\b(dialogue|performed dialogue|character_dialogue)\b/.test(text)) score += 2;
      if (/\b(comedy|joke|laugh|snicker)\b/.test(text)) score -= 1;
      return { ...row, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  let needed = minPhysicalTags - currentCount;
  for (const candidate of candidates) {
    if (needed <= 0) break;
    const tag = tags[(minPhysicalTags - needed) % tags.length];
    candidate.segment.physical_tags = [tag];
    candidate.segment.text = `${String(candidate.segment.text ?? "").trim()}\n${tag}`.trim();
    candidate.segment.auto_physical_tag_added = true;
    candidate.segment.auto_physical_tag_reason = "Voice-plan quality repair: long emotional/test slices need at least a few meaningful breath/body cues so Fish S2-Pro does not read everything as flat TTS.";
    candidate.segment.expected_duration_sec = Number(((candidate.segment.expected_duration_sec ?? 1) + 0.2).toFixed(1));
    needed -= 1;
  }
  return segments;
}

function alternatePerformanceTagsForRun(tag = "", segment = {}) {
  const clean = String(tag ?? "").replace(/^\s*\[|\]\s*$/g, "").trim();
  const context = `${clean} ${segment.delivery_mode ?? ""} ${segment.emotional_audio_texture ?? ""} ${segment.stripped_text ?? ""}`.toLowerCase();
  if (/\b(?:system|notice|warning|machine|classification|level|floor value|error)\b/.test(context)) {
    return [
      "[cold machine readout]",
      "[flat system warning]",
      "[clinical system notice]",
      "[low, ceremonial machine voice]",
      "[cold, clipped system notice]",
    ];
  }
  if (/\bemphasis\b/.test(context)) return ["[focused emphasis]", "[quiet emphasis]", "[tense emphasis]", "[sharp emphasis]"];
  if (/\blow voice\b/.test(context)) return ["[low, tense]", "[low, controlled]", "[low, shaken]", "[low, urgent]"];
  if (/\bsoft\b/.test(context)) return ["[soft, careful]", "[soft, worried]", "[soft, restrained]", "[soft, tense]"];
  if (/\bnervous\b/.test(context)) return ["[nervous, quick]", "[nervous, breath held]", "[nervous, trying to stay calm]"];
  if (!clean) return ["[focused]", "[quiet]", "[tense]"];
  return [`[${clean}, clipped]`, `[${clean}, restrained]`, `[${clean}, tighter]`];
}

function applySegmentTag(segment, tag, reason) {
  const oldTag = segment.tag;
  segment.tag = tag;
  if (segment.voice_direction_tag) segment.voice_direction_tag = tag;
  if (segment.performance_tag) segment.performance_tag = tag;
  if (segment.delivery_tag) segment.delivery_tag = tag;
  const text = String(segment.text ?? "").trim();
  segment.text = /^\[[^\]]+\]\s*/.test(text)
    ? text.replace(/^\[[^\]]+\]\s*/, `${tag} `)
    : `${tag} ${text}`.trim();
  segment.auto_tag_variation_from = oldTag ?? null;
  segment.auto_tag_variation_reason = reason;
}

function repairConsecutiveTagRuns(segments, maxSameTagRun = 4) {
  const voicedIndexes = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.fish_generation_required !== false && segment.delivery_mode !== "sound_design");
  let previousTag = null;
  let runLength = 0;
  for (const { segment, index } of voicedIndexes) {
    if (segment.tag === previousTag) {
      runLength += 1;
    } else {
      previousTag = segment.tag;
      runLength = 1;
    }
    if (runLength <= maxSameTagRun) continue;
    const previousSegment = segments[index - 1];
    const nextSegment = segments[index + 1];
    const replacement = alternatePerformanceTagsForRun(segment.tag, segment)
      .filter((candidate) => candidate !== segment.tag)
      .filter((candidate) => candidate !== previousSegment?.tag)
      .filter((candidate) => candidate !== nextSegment?.tag)[0];
    if (!replacement) continue;
    applySegmentTag(segment, replacement, `Automatic voice-stage tag-run repair: avoid ${maxSameTagRun + 1}+ consecutive identical delivery tags while preserving the same speaker and story text.`);
    previousTag = replacement;
    runLength = 1;
  }
  return segments;
}

function buildSegments(script, tags, speakabilityRules = {}, dialogueContext = {}) {
  const units = paragraphUnits(script, tags, speakabilityRules, dialogueContext).flatMap((unit) => splitLongDialogueUnit(unit));
  const segments = [];
  const shortSlice = Number.isFinite(maxDurationSec) && maxDurationSec > 0 && maxDurationSec <= 60;
  const testSlice = Number.isFinite(maxDurationSec) && maxDurationSec > 0;
  const targetWordMin = shortSlice ? 18 : testSlice ? 28 : 70;
  const targetWordMax = shortSlice ? 45 : testSlice ? 68 : 125;
  let current = [];
  let currentWords = 0;
  function currentSpeakerSwitchCount() {
    return current.filter((unit) => unit.kind === "dialogue" || unit.kind === "performance_action").length;
  }
  function currentHasDialogue() {
    return current.some((unit) => unit.kind === "dialogue" || unit.kind === "performance_action");
  }
  function currentHasInternal() {
    return current.some((unit) => unit.kind === "mc_internal");
  }
  function currentHasNarration() {
    return current.some((unit) => unit.kind === "narration");
  }
  function currentHasSystemDialogue() {
    return current.some((unit) => unit.kind === "dialogue" && /^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit.speaker ?? "")));
  }
  function currentHasSoundDesign() {
    return current.some((unit) => unit.kind === "sound_design");
  }
  function lastCurrentKind() {
    return current.at(-1)?.kind ?? null;
  }
  function lastCurrentSpeaker() {
    return current.at(-1)?.speaker ?? null;
  }
  function speakerContrastFamily(unit) {
    if (!unit) return "none";
    if (unit.kind === "narration") return "narrator";
    if (unit.kind === "mc_internal" || /^MC_INTERNAL$/i.test(String(unit.speaker ?? ""))) return "mc_internal";
    if (unit.kind === "sound_design") return "sfx";
    const speaker = String(unit.speaker ?? "");
    const text = `${speaker} ${unit.text ?? ""}`;
    if (/^(SYSTEM|NOTICE|WARNING|UI)$/i.test(speaker)) return "system";
    if (/\b(?:PIPIRU|LUNARIA|CHILD|GIRL CHILD|LITTLE GIRL|KAWAII|PRINCESS|CREATURE)\b/i.test(text)) return "child";
    if (/\b(?:MRS\.?|MS\.?|MISS|MIKA|ODA|MOTHER|AUNT|AUNTIE|GRANDMOTHER|GRANDMA|WOMAN|FEMALE|ELDER_FEMALE|ELDERLY)\b/i.test(text)) return "female";
    if (/\b(?:MR\.?|MISTER|MAN|FATHER|UNCLE|RENJI|DAE-HO|KAIDO|SHIROGANE|MALE)\b/i.test(text)) return "adult";
    return unit.kind === "dialogue" || unit.kind === "performance_action" ? "dialogue" : unit.kind;
  }
  function currentHasContrastFamily(family) {
    return current.some((unit) => speakerContrastFamily(unit) === family);
  }
  function highContrastSpeakerTransition(unit) {
    if (!current.length) return false;
    const nextFamily = speakerContrastFamily(unit);
    const lastFamily = speakerContrastFamily(current.at(-1));
    if (nextFamily === "sfx" || lastFamily === "sfx") return false;
    if (nextFamily === lastFamily) return false;
    const riskyPairs = new Set([
      "child:narrator",
      "narrator:child",
	      "child:adult",
	      "adult:child",
	      "female:narrator",
	      "narrator:female",
	      "female:adult",
	      "adult:female",
	      "female:system",
	      "system:female",
	      "adult:narrator",
      "narrator:adult",
      "system:narrator",
      "narrator:system",
      "system:adult",
      "adult:system",
      "system:child",
      "child:system",
    ]);
    if (riskyPairs.has(`${lastFamily}:${nextFamily}`)) return true;
    if ((lastFamily === "dialogue" && nextFamily === "narrator") || (lastFamily === "narrator" && nextFamily === "dialogue")) {
      const speakerText = String(current.at(-1)?.speaker ?? unit?.speaker ?? "");
      if (/\b(?:mrs|ms|miss|mika|oda|female|girl|woman|child|pipiru|system|ui|notice|warning)\b/i.test(speakerText)) return true;
    }
    if ((currentHasContrastFamily("child") && ["adult", "narrator", "system"].includes(nextFamily))
      || (currentHasContrastFamily("system") && ["adult", "narrator", "child"].includes(nextFamily))) return true;
    return false;
  }
  let recentNarrationContext = "";
  function shouldKeepDialogueExchangeTogether(unit) {
    const text = unit.text ?? "";
    const currentText = current.map((item) => item.text).join(" ");
    return /We get first pick because we're closer to them/i.test(text)
      || (/"No\."/.test(currentText) && unit.speaker === "DAE-HO");
  }
  function flush() {
    if (!current.length) return;
    const speakable = current.filter((unit) => unit.kind !== "sound_design");
    const sfxCues = current.filter((unit) => unit.kind === "sound_design").map((unit) => unit.sfx_cue ?? { description: unit.text });
    if (!speakable.length) {
      const soundText = current.map((unit) => unit.text).join(" ").trim();
      const expectedDuration = expectedFishDurationSec(soundText, { mode: "sound_design", speakers: ["SFX"] });
      const emotionalAudioTexture = classifyEmotionalAudioTexture(soundText, "sound_design", sfxCues);
      const segment = {
        segment_id: `voice_seg_${String(segments.length + 1).padStart(2, "0")}`,
        tag: "[sound design cue]",
        text: "",
        stripped_text: current.map((unit) => unit.text).join(" ").trim(),
        caption_text: current.map((unit) => unit.caption_text ?? unit.text).join(" ").trim(),
        delivery_mode: "sound_design",
        emotional_register: "[sound design cue]",
        speakers: ["SFX"],
        pause_plan: [],
        physical_tags: [],
        expected_duration_sec: expectedDuration,
        emotional_audio_texture: emotionalAudioTexture,
        pacing_tempo: classifyTempo(soundText, expectedDuration, "sound_design"),
        dialogue_narration_transition: "sound-design-only; do not generate Fish narration for this segment",
        risk_notes: "Requires SFX layer or silence placeholder; must not be narrated.",
        narrative_function: "sound design",
        dialogue_turn_count: 0,
        sfx_cues: sfxCues,
        fish_generation_required: false,
        semantic_voice_context: recentNarrationContext,
        performance_units: current.map((unit) => ({
          kind: unit.kind,
          speaker: unit.speaker,
          text: unit.text,
          performed_text: unit.performed_text,
          caption_text: unit.caption_text ?? unit.text,
          sfx_cue: unit.sfx_cue ?? null,
        })),
      };
      segments.push(segment);
      current = [];
      currentWords = 0;
      return;
    }
    const body = current.map((unit) => unit.text).join(" ").trim();
    const captionBody = current.map((unit) => unit.caption_text ?? unit.text).join(" ").trim();
    const performedBody = speakable.map((unit) => unit.performed_text).join(" ").trim();
    const speakers = [...new Set(current.map((unit) => unit.speaker).filter(Boolean))];
    const hasDialogue = speakable.some((unit) => unit.kind === "dialogue" || unit.kind === "performance_action");
    const hasInternal = speakable.some((unit) => unit.kind === "mc_internal");
    const hasNarration = speakable.some((unit) => unit.kind === "narration");
    const explicitPerformanceSpeaker = hasInternal
      ? "MC_INTERNAL"
      : hasDialogue && !hasNarration
        ? speakers.find((speaker) => speaker !== "NARRATOR")
        : null;
    const detectedMode = detectMode(body, segments.length, 25, explicitPerformanceSpeaker);
    const sanitizedMode = sanitizeDeliveryMode({ detectedMode, hasDialogue, hasNarration, speakers, body });
    const mode = hasDialogue && hasNarration && sanitizedMode === "exposition narration" ? "performed dialogue mix" : sanitizedMode;
    const dialogueOnly = hasDialogue && !hasNarration && !hasInternal;
    const primaryDialogueSpeaker = speakers.find((speaker) => speaker !== "NARRATOR") ?? speakers[0];
    const primaryDialogueRole = dialogueContext.roleByLabel?.get(speakerLabel(primaryDialogueSpeaker));
    const unitLeadTag = dialogueOnly ? speakerSpecificDialogueTag(`${primaryDialogueSpeaker}-${segments.length}`, primaryDialogueRole ?? fallbackRoleFromSpeakerLabel(primaryDialogueSpeaker)) : null;
    const tag = unitLeadTag ?? tagForMode(mode, body, tags, segments.length);
    const safeTag = isPauseOnlyTag(tag) ? universalTagForMode(mode, body, tags, segments.length) : tag;
    const physical = physicalCueFor(mode, segments.length, tags, body);
    const pause = pauseForMode(mode, segments.length);
    const lines = [dialogueOnly ? lightlyPunctuate(performedBody, mode) : `${safeTag} ${lightlyPunctuate(performedBody, mode)}`];
    if (physical) lines.push(physical);
    if (pause && !physical) lines.push(pause);
    const expectedDuration = expectedFishDurationSec(body, { mode, hasDialogue, hasNarration, speakers, pause, physical });
    const emotionalAudioTexture = classifyEmotionalAudioTexture(body, mode, sfxCues);
    const segment = {
      segment_id: `voice_seg_${String(segments.length + 1).padStart(2, "0")}`,
      tag: safeTag,
      text: lines.join("\n"),
      stripped_text: body,
      caption_text: captionBody,
      delivery_mode: mode,
      emotional_register: safeTag,
      speakers: speakers.length ? speakers : ["narrator"],
      pause_plan: pause ? [{ tag: pause, reason: `${mode} needs breathing room` }] : [],
      physical_tags: physical ? [physical] : [],
      expected_duration_sec: expectedDuration,
      emotional_audio_texture: emotionalAudioTexture,
      pacing_tempo: classifyTempo(body, expectedDuration, mode),
      dialogue_narration_transition: mode === "mc_internal" ? "drop room tone/crowd slightly and use close intimate MC internal delivery before returning to narrator-led pressure" : mode === "character_dialogue" ? "lightly embody speaker, then return to narrator tone on next narration segment" : "narrator-led",
      risk_notes: mode === "mc_internal" ? "Qwen should use the MC_INTERNAL casting slot; do not render this as narrator." : mode === "character_dialogue" ? "Do not flatten dialogue into generic narration." : "",
      narrative_function: segments.length === 0 ? "opening emotional engine" : mode,
      dialogue_turn_count: current.filter((unit) => unit.kind === "dialogue" || unit.kind === "performance_action").length,
      sfx_cues: sfxCues,
      fish_generation_required: true,
      semantic_voice_context: recentNarrationContext,
      performance_units: current.map((unit) => ({
        kind: unit.kind,
        speaker: unit.speaker,
        text: unit.text,
        performed_text: unit.performed_text,
        caption_text: unit.caption_text ?? unit.text,
        sfx_cue: unit.sfx_cue ?? null,
      })),
    };
    segments.push(segment);
    if (hasNarration && body) recentNarrationContext = body;
    current = [];
    currentWords = 0;
  }
  for (const unit of units) {
    if (unit.kind === "segment_boundary") {
      const boundaryShouldFlush = current.length && (
        currentHasSoundDesign()
        || currentHasSystemDialogue()
        || currentHasDialogue()
        || currentHasInternal()
        || (!currentHasDialogue() && currentWords >= 28)
        || currentWords >= targetWordMin
        || (currentHasDialogue() && currentSpeakerSwitchCount() >= 5)
      );
      if (boundaryShouldFlush) flush();
      continue;
    }
    const unitWords = words(unit.text).length;
    const nextIsPerformance = unit.kind === "dialogue" || unit.kind === "performance_action" || unit.kind === "mc_internal";
    const nextIsNarration = unit.kind === "narration";
    const nextIsSoundDesign = unit.kind === "sound_design";
    const nextIsSystemDialogue = unit.kind === "dialogue" && /^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit.speaker ?? ""));
    const speakerSwitchNeedsOwnSegment = current.length
      && nextIsPerformance
      && (currentHasDialogue() || currentHasInternal())
      && lastCurrentSpeaker()
      && unit.speaker
      && unit.speaker !== lastCurrentSpeaker()
      && (currentSpeakerSwitchCount() >= 5 || currentWords >= targetWordMin)
      && !shouldKeepDialogueExchangeTogether(unit);
    const wouldOverloadDialogue = currentHasDialogue()
      && nextIsPerformance
      && currentSpeakerSwitchCount() >= 5
      && !shouldKeepDialogueExchangeTogether(unit);
    const wouldRiskVoiceBleed = current.length
      && (((currentHasDialogue() || currentHasInternal()) && nextIsNarration && lastCurrentKind() !== "narration")
        || (currentHasNarration() && nextIsPerformance && lastCurrentKind() === "narration"))
      && (
        currentWords >= Math.floor(targetWordMin * 0.75)
        || currentSpeakerSwitchCount() >= 2
        || (currentHasNarration() && nextIsPerformance && currentWords >= 1 && unitWords >= 14)
        || (currentHasDialogue() && nextIsNarration && unitWords >= 10)
      );
    const shouldIsolateSystemNotice = current.length
      && nextIsSystemDialogue
      && currentWords >= Math.max(10, Math.floor(targetWordMin * 0.45));
    const shouldCloseAfterSystemNotice = current.length
      && currentHasSystemDialogue()
      && (
        (nextIsNarration && currentWords >= Math.max(14, Math.floor(targetWordMin * 0.55)))
        || (nextIsPerformance && !nextIsSystemDialogue && currentWords >= 4)
      );
    const shouldFlushForDialogueTurn = unit.kind === "dialogue" && currentWords >= targetWordMin;
    const shouldFlushSplitLongDialogue = unit.kind === "dialogue" && unit.auto_split_from_long_dialogue && currentHasDialogue();
    const shouldFlushForSize = currentWords + unitWords > targetWordMax;
    const shouldIsolateSoundDesign = current.length && (nextIsSoundDesign || currentHasSoundDesign());
    const shouldSplitHighContrastVoice = highContrastSpeakerTransition(unit) && !shouldKeepDialogueExchangeTogether(unit);
    if (current.length && (shouldIsolateSoundDesign || shouldIsolateSystemNotice || shouldCloseAfterSystemNotice || shouldSplitHighContrastVoice || speakerSwitchNeedsOwnSegment || wouldOverloadDialogue || wouldRiskVoiceBleed || shouldFlushForDialogueTurn || shouldFlushSplitLongDialogue || shouldFlushForSize)) flush();
    current.push(unit);
    currentWords += nextIsSoundDesign ? 0 : unitWords;
  }
  flush();
  if (Number.isFinite(maxDurationSec) && maxDurationSec > 0) {
    let total = 0;
    const selected = segments.filter((segment) => {
      if (total >= maxDurationSec) return false;
      total += segment.expected_duration_sec;
      return true;
    });
    const selectedText = selected.map((segment) => segment.stripped_text ?? "").join(" ");
    if (/"No\."?$/.test(selectedText.trim()) && !/We get first pick because we're closer to them/i.test(selectedText)) {
      const remaining = segments.slice(selected.length);
      for (const segment of remaining) {
        selected.push(segment);
        if (/We get first pick because we're closer to them/i.test(segment.stripped_text ?? "")) break;
      }
    }
    const nextSegment = segments[selected.length];
    const lastSelected = selected.at(-1);
    if (nextSegment
      && lastSelected
      && lastSelected.delivery_mode !== "character_dialogue"
      && nextSegment.delivery_mode === "character_dialogue"
      && words(lastSelected.stripped_text ?? "").length <= 8) {
      selected.push(nextSegment);
    }
    const afterSelected = segments[selected.length];
    const selectedTail = selected.at(-1);
    if (afterSelected
      && selectedTail
      && selectedTail.delivery_mode === "character_dialogue"
      && afterSelected.delivery_mode !== "character_dialogue"
      && words(afterSelected.stripped_text ?? "").length <= 8) {
      selected.push(afterSelected);
      const response = segments[selected.length];
      if (response?.delivery_mode === "character_dialogue") selected.push(response);
    }
    if (!selected.some((segment) => segment.delivery_mode === "sound_design" || segment.fish_generation_required === false)) {
      const scriptHasSfx = /^SFX\s*:/im.test(script);
      const remaining = segments.slice(selected.length);
      const firstSfxIndex = remaining.findIndex((segment) => segment.delivery_mode === "sound_design" || segment.fish_generation_required === false);
      if (scriptHasSfx && firstSfxIndex >= 0 && firstSfxIndex <= 3) {
        selected.push(...remaining.slice(0, firstSfxIndex + 1));
      }
    }
    return selected;
  }
  return segments;
}

function auditDialoguePerformance(script, segments, speakabilityRules = {}) {
  const issues = [];
  const scriptLines = script.split(/\r?\n/).map((line, index) => ({ line: index + 1, text: line.trim() })).filter((line) => line.text);
  function add(issue) {
    issues.push({ severity: "blocker", ...issue });
  }
  const performedJoined = segments.map((segment) => segment.text ?? "").join("\n");
  function addAdapterWarning(issue) {
    issues.push({ severity: "warning", auto_repaired_by_performance_adapter: true, ...issue });
  }
  const configuredAudits = speakabilityRules.audit_patterns ?? [];
  for (const line of scriptLines) {
    for (const rule of configuredAudits) {
      if (!rule?.pattern) continue;
      const pattern = new RegExp(rule.pattern, rule.flags ?? "i");
      if (!pattern.test(line.text)) continue;
      const issue = {
        code: rule.code ?? "writerly_dialogue_not_speakable",
        line: line.line,
        text: line.text,
        reason: rule.reason ?? "Dialogue may not be speakable for Fish performance.",
        suggested_fix: rule.suggested_fix ?? null,
      };
      if (pattern.test(performedJoined)) add(issue);
      else addAdapterWarning(issue);
    }
  }
  for (let index = 0; index < scriptLines.length; index++) {
    const line = scriptLines[index];
    if (!/^[A-Z][A-Z0-9 '\-.]{1,40}:\s*/.test(line.text)) continue;
    if (!/\b(?:wiring problem|electrical problem|register wiring|printer problem|machine problem|speaker problem)\b/i.test(line.text)) continue;
    const previousContext = scriptLines.slice(Math.max(0, index - 5), index).map((row) => row.text).join("\n");
    const nextContext = scriptLines.slice(index + 1, Math.min(scriptLines.length, index + 6)).map((row) => row.text).join("\n");
    const triggerPattern = /\b(?:spark|zap|zapped|shorted|flicker|glitch|printer|receipt printer|receipt machine|register|screen|speaker|static|electrical|wiring|smoke|pop|sputter|cough)\b/i;
    if (!triggerPattern.test(previousContext) && triggerPattern.test(nextContext)) {
      add({
        code: "premature_mundane_technical_excuse",
        line: line.line,
        text: line.text,
        reason: "A dialogue line explains an electrical/register/machine problem before the audience has seen or heard the technical trigger. This makes the joke feel out of order.",
        suggested_fix: "Either move the technical excuse after the visible/audio trigger, or replace it with an immediate denial line such as \"I heard nothing.\" / \"I saw nothing.\"",
      });
    }
  }
  for (const segment of segments) {
    const speakerSwitches = (segment.text.match(/<\|speaker:\d+\|>/g) ?? []).length;
    const repeatedSpeakerToken = [...segment.text.matchAll(/<\|speaker:(\d+)\|>\s*(?:[^<]{0,80}?)<\|speaker:\1\|>/g)];
    if (repeatedSpeakerToken.length) {
      add({
        code: "repeated_same_speaker_token_in_fish_request",
        segment_id: segment.segment_id,
        repeat_count: repeatedSpeakerToken.length,
        reason: "Fish S2-Pro speaker tokens should mark speaker changes only. Repeating the same token inside one speaker's line creates unnatural pauses and word breaks.",
        suggested_fix: "Compact adjacent same-speaker units before tokenization and make sentence splitting abbreviation-safe.",
      });
    }
    if (speakerSwitches > 5) {
      add({
        code: "too_many_speaker_switches_in_fish_segment",
        segment_id: segment.segment_id,
        switch_count: speakerSwitches,
        reason: "Fish S2-Pro performs dialogue more naturally when a request contains fewer speaker/mode changes.",
        suggested_fix: "Split into smaller dialogue-performance beats: line, reaction, narration button, next line.",
      });
    }
    if (/\bgave a thin laugh, then swallowed the wheeze/i.test(segment.stripped_text ?? "") && !/\[chuck|heh|laugh/i.test(segment.text)) {
      add({
        code: "performable_action_left_as_narration",
        segment_id: segment.segment_id,
        reason: "A vocal action should be performed by the character voice, not only narrated.",
        suggested_fix: "Use child speaker lane with a short natural vocalization and caption it as action.",
      });
    }
    if (/\bgave a thin laugh, then swallowed the wheeze/i.test(segment.stripped_text ?? "") && /\[chuck|heh|gasp/i.test(segment.text)) {
      issues.push({
        code: "caption_audio_action_mismatch_warning",
        severity: "warning",
        segment_id: segment.segment_id,
        reason: "Audio performs a nonverbal action while captions/stripped text still show prose narration. Subtitle generation should caption the performed action, not the old narration sentence.",
        suggested_fix: "Use performance-caption text such as '[Character gives a weak laugh and catches a wheeze]'.",
      });
    }
  }
  return {
    status: issues.some((issue) => issue.severity === "blocker") ? "failed" : "passed",
    generated_at: new Date().toISOString(),
    scope: "universal_dialogue_performance_audit",
    issues,
    blockers: issues.filter((issue) => issue.severity === "blocker"),
    warnings: issues.filter((issue) => issue.severity === "warning"),
    core_engine_recommendations: [
      "Run this audit before Fish generation.",
      "Repair writerly dialogue in script or performance-adaptation layer before rendering.",
      "Keep test slices dialogue-complete.",
      "Generate captions from audible/performed text, not only stripped script text.",
      "Split high-switch dialogue segments before calling Fish S2-Pro.",
    ],
  };
}

function qualityReport(segments, { ttsProvider = "qwen_local" } = {}) {
  const qwenLocal = isQwenLocalProvider(ttsProvider);
  const voicedSegments = segments.filter((segment) => segment.fish_generation_required !== false && segment.delivery_mode !== "sound_design");
  const tags = voicedSegments.map((segment) => segment.tag);
  const counts = Object.fromEntries([...new Set(tags)].map((tag) => [tag, tags.filter((item) => item === tag).length]));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  let maxRun = 0;
  let currentRun = 0;
  let previous = null;
  for (const tag of tags) {
    currentRun = tag === previous ? currentRun + 1 : 1;
    previous = tag;
    maxRun = Math.max(maxRun, currentRun);
  }
  const midSentenceTags = voicedSegments.filter((segment) => /[a-z0-9],?\s+\[[^\]]+\]\s+[a-z0-9]/.test(segment.text)).length;
  const physicalTags = voicedSegments.reduce((sum, segment) => sum + (segment.physical_tags?.length ?? 0), 0);
  const pauseEvents = voicedSegments.reduce((sum, segment) => sum + (segment.pause_plan?.length ?? 0), 0);
  const dialogueSegments = voicedSegments.filter((segment) => segment.dialogue_turn_count > 0 || segment.delivery_mode === "character_dialogue");
  const dialogueCovered = dialogueSegments.filter((segment) => !/calm,\s*cinematic narration|calm cinematic|cinematic narration|generic/i.test(segment.tag)).length;
  const genericTags = tags.filter((tag) => /calm, cinematic narration|calm cinematic|generic/i.test(tag)).length;
  const spokenLabelSegments = voicedSegments.filter((segment) => containsSpokenSpeakerLabel(segment.text));
  const screenplayMarkerSegments = voicedSegments.filter((segment) => containsScreenplayMarkerLeak(segment.text));
  const unknownDialogueSegments = voicedSegments.filter((segment) => (segment.performance_units ?? []).some((unit) => unit.kind === "dialogue" && /UNKNOWN_DIALOGUE/i.test(unit.speaker ?? "")));
  const pausePrimaryTagSegments = voicedSegments.filter((segment) => isPauseOnlyTag(segment.tag));
  const leadingPauseBeforePerformance = voicedSegments.filter((segment) => /^\s*\[(?:short\s+pause|pause|long\s+pause|micro-pause)\]\s+\[[^\]]+\]/i.test(segment.text ?? ""));
  const oversizedMixedDialogueSegments = voicedSegments.filter((segment) =>
    (segment.dialogue_turn_count ?? 0) > 0
    && (words(segment.stripped_text ?? "").length > 68 || Number(segment.expected_duration_sec ?? 0) > 24)
  );
  const buriedSystemNoticeSegments = voicedSegments.filter((segment) => {
    const hasSystem = (segment.performance_units ?? []).some((unit) => unit.kind === "dialogue" && /^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit.speaker ?? "")));
    if (!hasSystem) return false;
    const nonSystemDialogueCount = (segment.performance_units ?? []).filter((unit) => unit.kind === "dialogue" && !/^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit.speaker ?? ""))).length;
    return words(segment.stripped_text ?? "").length > 46 || nonSystemDialogueCount > 1 || Number(segment.expected_duration_sec ?? 0) > 18;
  });
  const tempoCounts = Object.fromEntries(["fast", "medium", "slow", "silent"].map((tempo) => [tempo, segments.filter((segment) => segment.pacing_tempo === tempo).length]));
  const topTempo = Object.entries(tempoCounts).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const topTempoPct = segments.length ? topTempo[1] / segments.length * 100 : 0;
  const unjustifiedExtremeTags = voicedSegments.filter((segment) =>
    /\[(?:screaming|shouting|loud|volume up)\]/i.test(segment.tag ?? "")
    && !/scream|shout|yell|roar|alarm|panic cry|broadcast|loudspeaker|crowd|explosion/i.test(`${segment.delivery_mode} ${segment.stripped_text} ${segment.text}`)
  );
  const unjustifiedPitchTags = voicedSegments.filter((segment) =>
    /\[pitch up\]/i.test(segment.tag ?? "")
    && !/child|teen|young|girl|boy|kitten|cat|small voice|dialogue|transformed|younger/i.test(`${segment.delivery_mode} ${segment.stripped_text} ${segment.text}`)
  );
  const topPct = tags.length ? top[1] / tags.length * 100 : 0;
  const avgWords = voicedSegments.reduce((sum, segment) => sum + segment.stripped_text.split(/\s+/).filter(Boolean).length, 0) / Math.max(1, voicedSegments.length);
  const failures = [];
  const narrationMisclassifiedAsDialogue = voicedSegments.filter((segment) => {
    const speakers = segment.speakers ?? [];
    const onlyNarrator = speakers.length === 0 || speakers.every((speaker) => /^(NARRATOR|narrator)$/i.test(String(speaker ?? "")));
    return onlyNarrator && segment.dialogue_turn_count === 0 && segment.delivery_mode === "character_dialogue";
  });
  const isTestSlice = Number.isFinite(maxDurationSec) && maxDurationSec > 0;
  const minUniqueTags = isTestSlice && maxDurationSec <= 45 ? 3 : isTestSlice && maxDurationSec < 90 ? 5 : 8;
  const maxTopTagPct = isTestSlice && maxDurationSec <= 45 ? 50 : isTestSlice && maxDurationSec < 90 ? 42 : 35;
  const minPhysicalTags = isTestSlice && maxDurationSec <= 45 ? 0 : isTestSlice && maxDurationSec < 90 ? 1 : 2;
  if (Object.keys(counts).length < minUniqueTags) failures.push({ code: "too_few_unique_tags", severity: "blocker", min_unique_tags: minUniqueTags });
  if (topPct > maxTopTagPct) failures.push({
    code: "top_tag_overused",
    severity: qwenLocal ? "warning" : "blocker",
    tag: top[0],
    pct: Number(topPct.toFixed(2)),
    max_pct: maxTopTagPct,
  });
  if (maxRun >= 5) failures.push({ code: "same_tag_repeats_5_plus", severity: "blocker" });
  if (physicalTags < minPhysicalTags) failures.push({ code: "too_few_physical_tags", severity: "blocker", min_physical_tags: minPhysicalTags });
  if (physicalTags > Math.ceil(voicedSegments.length * 0.45)) failures.push({ code: "too_many_physical_tags", severity: "warning" });
  const minPauseEvents = isTestSlice && maxDurationSec <= 45 ? 0 : isTestSlice && maxDurationSec < 90 ? 1 : 2;
  if (pauseEvents < minPauseEvents) failures.push({ code: "too_few_pause_events", severity: "blocker", min_pause_events: minPauseEvents });
  if (midSentenceTags > 0) failures.push({ code: "mid_sentence_tags", severity: "blocker", count: midSentenceTags });
  if (narrationMisclassifiedAsDialogue.length) {
    failures.push({
      code: "narration_segment_misclassified_as_character_dialogue",
      severity: "blocker",
      segment_ids: narrationMisclassifiedAsDialogue.map((segment) => segment.segment_id),
      reason: "Narrator-only segments cannot be delivered as character_dialogue; this causes Fish delivery and visual timing drift.",
    });
  }
  if (dialogueSegments.length && dialogueCovered / dialogueSegments.length < 0.9) failures.push({ code: "dialogue_treated_like_narration", severity: "blocker" });
  if (genericTags / Math.max(1, tags.length) > 0.15) failures.push({ code: "generic_tag_overused", severity: "blocker" });
  if (unjustifiedExtremeTags.length) {
    failures.push({
      code: "unjustified_extreme_voice_tag",
      severity: "blocker",
      segment_ids: unjustifiedExtremeTags.map((segment) => segment.segment_id),
      reason: "Extreme loud/screaming tags must be justified by the actual line or scene function; they cannot be selected as generic narration variety.",
    });
  }
  if (unjustifiedPitchTags.length) {
    failures.push({
      code: "unjustified_pitch_voice_tag",
      severity: "blocker",
      segment_ids: unjustifiedPitchTags.map((segment) => segment.segment_id),
      reason: "Pitch-up tags are for youth/creature/dialogue performance contexts, not generic narration variety.",
    });
  }
  const misplacedDryHumor = voicedSegments.filter((segment) => /sarcastic|contempt/i.test(segment.tag ?? "") && !/dry humor|joke|comic|banter/i.test(`${segment.delivery_mode} ${segment.stripped_text}`));
  if (misplacedDryHumor.length) {
    failures.push({
      code: "dry_humor_tag_on_non_humor_segment",
      severity: "blocker",
      segment_ids: misplacedDryHumor.map((segment) => segment.segment_id),
      reason: "Sarcastic/contempt tags are opt-in for actual humor or contempt beats; they must not become default narration tags.",
    });
  }
  if (pausePrimaryTagSegments.length) {
    failures.push({
      code: "pause_tag_used_as_primary_emotion",
      severity: "blocker",
      segment_ids: pausePrimaryTagSegments.map((segment) => segment.segment_id),
      reason: "Pause tags are timing events, not emotional delivery tags. They must not control a whole Fish segment.",
    });
  }
  if (leadingPauseBeforePerformance.length) {
    failures.push({
      code: "leading_pause_before_performance_tag",
      severity: "blocker",
      segment_ids: leadingPauseBeforePerformance.map((segment) => segment.segment_id),
      reason: "Do not start a Fish segment with a pause before the emotional/performance tag; insert silence between segments instead.",
    });
  }
  if (oversizedMixedDialogueSegments.length) {
    failures.push({
      code: qwenLocal ? "mixed_dialogue_segment_uses_qwen_unit_stitch" : "oversized_mixed_dialogue_fish_segment",
      severity: qwenLocal ? "warning" : "blocker",
      segment_ids: oversizedMixedDialogueSegments.map((segment) => segment.segment_id),
      reason: qwenLocal
        ? "Qwen local production generates and stitches per performance unit, so mixed narrator/dialogue segments are allowed only when qwen_generation_units preserve setup, line, reaction, and follow-up beats."
        : "Fish S2-Pro performs dialogue and narrator shifts better in compact context-rich beats. Long mixed segments cause voice bleed and muddy dialogue.",
      suggested_fix: qwenLocal
        ? "Verify qwen_generation_plan.json has clean per-speaker units and natural-language --instruct prompts for every mixed segment before local synthesis."
        : "Split mixed narration/dialogue/system sections into setup, line, reaction, and follow-up beats before audio generation.",
    });
  }
  if (buriedSystemNoticeSegments.length) {
    failures.push({
      code: "system_notice_buried_in_long_fish_segment",
      severity: "blocker",
      segment_ids: buriedSystemNoticeSegments.map((segment) => segment.segment_id),
      reason: "System/UI dialogue must be isolated with only immediate setup/reaction so it does not disappear inside long narrator paragraphs.",
      suggested_fix: "Segment system notices as setup + system line + short human reaction, then move crowd/context narration to a separate Fish request.",
    });
  }
  if (topTempoPct > 60) {
    failures.push({
      code: "tempo_classification_dominates_episode",
      severity: "blocker",
      tempo: topTempo[0],
      pct: Number(topTempoPct.toFixed(2)),
      reason: "More than 60% of audio segments share one pacing tempo; the episode is likely flat or rushed.",
    });
  } else if (topTempoPct > 40) {
    failures.push({
      code: "tempo_classification_over_40_percent",
      severity: "warning",
      tempo: topTempo[0],
      pct: Number(topTempoPct.toFixed(2)),
      reason: "More than 40% of audio segments share one pacing tempo. Add more breathing room or urgency variation when possible.",
    });
  }
  if (spokenLabelSegments.length) {
    failures.push({
      code: "spoken_speaker_label_leak",
      severity: "blocker",
      count: spokenLabelSegments.length,
      segment_ids: spokenLabelSegments.map((segment) => segment.segment_id),
    });
  }
  if (screenplayMarkerSegments.length) {
    failures.push({
      code: "screenplay_marker_leak",
      severity: "blocker",
      count: screenplayMarkerSegments.length,
      segment_ids: screenplayMarkerSegments.map((segment) => segment.segment_id),
      reason: "Screenplay control labels such as COLD OPEN and CUT TO must never enter Fish/narration text.",
    });
  }
  if (unknownDialogueSegments.length) {
    failures.push({
      code: "unknown_dialogue_speaker",
      severity: "blocker",
      count: unknownDialogueSegments.length,
      segment_ids: unknownDialogueSegments.map((segment) => segment.segment_id),
      reason: "Dialogue cannot be routed to a character reference when speaker ownership is unknown.",
    });
  }
  const blockers = failures.filter((failure) => failure.severity !== "warning");
  const warnings = failures.filter((failure) => failure.severity === "warning");
  return {
    status: blockers.length ? "failed_repairable" : "passed",
    test_slice: isTestSlice ? { enabled: true, max_duration_sec: maxDurationSec } : { enabled: false },
    total_segments: segments.length,
    total_tags: tags.length,
    unique_tags: Object.keys(counts).length,
    unique_tag_count: Object.keys(counts).length,
    tag_counts: counts,
    top_tag: top[0],
    top_tag_percentage: Number(topPct.toFixed(2)),
    top_tag_percentage_of_tagged_lines: Number((topPct / 100).toFixed(4)),
    generic_tag_percentage: Number((genericTags / Math.max(1, tags.length) * 100).toFixed(2)),
    generic_tag_percentage_of_tagged_lines: Number((genericTags / Math.max(1, tags.length)).toFixed(4)),
    max_consecutive_same_tag: maxRun,
    physical_tag_count: physicalTags,
    pause_event_count: pauseEvents,
    mid_sentence_tag_count: midSentenceTags,
    speaker_mode_count: Object.fromEntries([...new Set(segments.map((segment) => segment.delivery_mode))].map((mode) => [mode, segments.filter((segment) => segment.delivery_mode === mode).length])),
    tempo_classification_counts: tempoCounts,
    top_tempo_classification: topTempo[0],
    top_tempo_percentage: Number(topTempoPct.toFixed(2)),
    dialogue_tag_coverage: dialogueSegments.length ? Number((dialogueCovered / dialogueSegments.length * 100).toFixed(2)) : 100,
    average_segment_word_count: Number(avgWords.toFixed(2)),
    segment_count: segments.length,
    estimated_duration_sec: segments.reduce((sum, segment) => sum + (segment.expected_duration_sec ?? 0), 0),
    metrics: {
      unique_tag_count: Object.keys(counts).length,
      top_tag: top[0],
      top_tag_percentage: Number(topPct.toFixed(2)),
      generic_tag_percentage: Number((genericTags / Math.max(1, tags.length) * 100).toFixed(2)),
      physical_tag_count: physicalTags,
      pause_event_count: pauseEvents,
      mid_sentence_tag_count: midSentenceTags,
      segment_count: segments.length,
      dialogue_tag_coverage: dialogueSegments.length ? Number((dialogueCovered / dialogueSegments.length * 100).toFixed(2)) : 100,
      average_segment_word_count: Number(avgWords.toFixed(2)),
      estimated_duration_sec: segments.reduce((sum, segment) => sum + (segment.expected_duration_sec ?? 0), 0),
      tempo_classification_counts: tempoCounts,
      top_tempo_percentage: Number(topTempoPct.toFixed(2)),
    },
    dialogue_turn_count: segments.reduce((sum, segment) => sum + (segment.dialogue_turn_count ?? 0), 0),
    spoken_speaker_label_count: spokenLabelSegments.length,
    unknown_dialogue_speaker_count: unknownDialogueSegments.length,
    pause_primary_tag_count: pausePrimaryTagSegments.length,
    leading_pause_before_performance_tag_count: leadingPauseBeforePerformance.length,
    failures,
    blockers,
    warnings,
    tts_provider: ttsProvider,
    auto_repair_policy: qwenLocal
      ? "Preserve story text, keep Qwen spoken text clean, and repair qwen_generation_units/instruct prompts before local synthesis."
      : "Retag flagged segments from SeriesPackage palette while preserving stripped_text. Max 2 attempts before human review.",
  };
}

function containsSpokenSpeakerLabel(text) {
  const withoutSpeakerTokens = text.replace(/<\|speaker:\d+\|>/g, "");
  return /(?:^|\n)\s*[A-Z][A-Z0-9'’. -]{1,40}:\s+\S/.test(withoutSpeakerTokens);
}

function containsScreenplayMarkerLeak(text) {
  return /\[(?:COLD\s+OPEN|CUT\s+TO|TITLE\/INTRO\s+BEAT|TITLE\s+CARD|INTRO\s+BEAT|WORD\s+INDEX|SYSTEM\s+REVEAL|FIRST\s+PUBLIC\s+REVERSAL|END\s+COLD\s+OPEN|END\s+CARD)\b[^\]]*\]/i.test(String(text ?? ""));
}

function numberWord(value) {
  const lookup = {
    0: "zero",
    1: "one",
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
    9: "nine",
    10: "ten",
    11: "eleven",
    12: "twelve",
    13: "thirteen",
    14: "fourteen",
    15: "fifteen",
    16: "sixteen",
    17: "seventeen",
    18: "eighteen",
    19: "nineteen",
    20: "twenty",
  };
  return lookup[Number(value)] ?? String(value);
}

function qwenPronunciationText(value) {
  const preserveInitialCase = (replacement) => (match) => /^[A-Z]/.test(match) ? `${replacement[0].toUpperCase()}${replacement.slice(1)}` : replacement;
  return String(value ?? "")
    .replace(/\bTRUE\s+LEVEL\s*:\s*-\s*(\d{1,2})\b/gi, (_match, level) => `True level, negative ${numberWord(level)}`)
    .replace(/\bUNALLOCATED\s+STAT\s+POINTS\s*:\s*-\s*(\d{1,2})\b/gi, (_match, points) => `Unallocated stat points, negative ${numberWord(points)}`)
    .replace(/\bSSS(?:\s*[- ]\s*rank)?\b/gi, (match) => /rank/i.test(match) ? "S S S rank" : "S S S")
    .replace(/\bSS(?:\s*[- ]\s*rank)?\b/gi, (match) => /rank/i.test(match) ? "S S rank" : "S S")
    .replace(/\bS\s*[- ]\s*rank\b/gi, "S rank")
    .replace(/\b([A-Z])\s*[- ]\s*rank\b/g, "$1 rank")
    .replace(/\bXP\b/g, "X P")
    .replace(/\bHP\b/g, "H P")
    .replace(/\bMP\b/g, "M P")
    .replace(/\bDPS\b/g, "D P S")
    .replace(/\bAOE\b/g, "A O E")
    .replace(/\bUI\b/g, "U I")
    .replace(/\bID\b/g, "I D")
    .replace(/\bMC\b/g, "M C")
    .replace(/\bLevel\s*[-:]\s*-\s*(\d{1,2})\b/gi, (_match, level) => `Level negative ${numberWord(level)}`)
    .replace(/\bLevel\s+-\s*(\d{1,2})\b/gi, (_match, level) => `Level negative ${numberWord(level)}`)
    .replace(/:\s*-\s*(\d{1,2})\b/g, (_match, value) => `, negative ${numberWord(value)}`)
    .replace(/\bunconfirmed\b/gi, preserveInitialCase("not verified"))
    .replace(/\bconfirmation\b/gi, preserveInitialCase("verification"))
    .replace(/\bconfirmed\b/gi, preserveInitialCase("verified"))
    .replace(/\bconfirm\b/gi, preserveInitialCase("verify"))
    .replace(/\s+/g, " ")
    .trim();
}

function qwenSpokenText(value, speaker = "") {
  const isInterfaceSpeaker = /^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(speaker ?? ""));
  let clean = String(value ?? "")
    .replace(/<\|speaker:\d+\|>/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/^["“]|["”]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!isInterfaceSpeaker) {
    clean = clean
      .replace(/^\s*[A-Z][A-Z0-9 _'’. -]{1,40}:\s*/, "")
      .replace(/^:\s*/, "")
      .trim();
  }
  const normalized = qwenPronunciationText(clean);
  if (isInterfaceSpeaker) {
    const protectedTokens = [];
    const text = normalized.replace(/\b(?:[A-Z]\s+){1,}[A-Z]\b/g, (match) => {
      const placeholder = `__qwen_letter_token_${protectedTokens.length}__`;
      protectedTokens.push(match);
      return placeholder;
    });
    let sentenceCase = text
      .toLowerCase()
      .replace(/(^|[.!?]\s+)([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
    protectedTokens.forEach((token, index) => {
      sentenceCase = sentenceCase.replace(`__qwen_letter_token_${index}__`, token);
    });
    return sentenceCase;
  }
  return normalized;
}

function qwenBeatForUnit(segment, unit) {
  const text = `${unit?.text ?? ""} ${segment?.stripped_text ?? ""}`.toLowerCase();
  if (unit?.kind === "mc_internal" || /^MC_INTERNAL$/i.test(String(unit?.speaker ?? ""))) return "private tactical thought";
  if (/^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit?.speaker ?? ""))) return "cold system interface reveal";
  if (/level negative|level -|negative level|error|glitch|patch note|below the floor/i.test(text)) return "system anomaly reveal";
  if (/dies|death|respawn|heal|damage|monster|attack|blood|crack/i.test(text)) return "danger reversal and survival pressure";
  if (/laugh|mock|guild|official|student|crowd|argu/i.test(text)) return "public humiliation and social pressure";
  if (/protect|witness|guardian|dependent|mira|sera/i.test(text)) return "protective conflict under institutional pressure";
  if (unit?.kind === "dialogue") return "tight anime dialogue turn";
  return "urgent anime recap narration";
}

function qwenIntensityFor(segment, unit) {
  const text = `${segment?.delivery_mode ?? ""} ${segment?.emotional_audio_texture ?? ""} ${unit?.text ?? ""}`.toLowerCase();
  if (/death|dies|monster|attack|breach|crush|warning|quarantine|error|level negative|level -10|patch|reality crack/i.test(text)) return "medium-high tension with controlled adult restraint; do not raise pitch";
  if (/mock|laugh|public|guild|official|student|argu|humiliation|witness|review/i.test(text)) return "medium-high social pressure";
  if (/quiet|held|breath|tender|protect|dependent|guardian/i.test(text)) return "medium, emotionally tight";
  return "medium, forward momentum";
}

function qwenPacingFor(unit) {
  if (unit?.kind === "mc_internal" || /^MC_INTERNAL$/i.test(String(unit?.speaker ?? ""))) return "close, steady internal monologue with no theatrical projection";
  if (/^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit?.speaker ?? ""))) return "precise, steady interface cadence, slightly slower on letter ranks and warnings";
  if (unit?.kind === "dialogue" || unit?.kind === "performance_action") return "tight speaker turn, steady conversational rhythm, no long lead-in or tail";
  return "measured paragraph delivery around 150-170 words per minute, steady adult recap cadence, no rushed endings";
}

function qwenCharacterLine(speaker, role, cast = null) {
  if (/^NARRATOR$/i.test(String(speaker ?? ""))) return "grounded adult anime recap narrator, owned narrator reference, low-to-mid pitch";
  if (/^MC_INTERNAL$/i.test(String(speaker ?? ""))) return "protagonist private thought, close mic, controlled tension";
  if (/^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(speaker ?? ""))) return "cold formal interface voice, precise and emotionless";
  const descriptor = cast?.voice_descriptor ?? cast?.label ?? null;
  if (descriptor) return `${descriptor}, role ${role || "character voice"}`;
  return `story character voice, role ${role || "character voice"}`;
}

function qwenInstructForUnit({ segment, unit, role, cast }) {
  return [
    "Voice identity: match the approved local Qwen reference for this speaker.",
    `Character: ${qwenCharacterLine(unit.speaker ?? "NARRATOR", role, cast)}.`,
    `Scene beat: ${qwenBeatForUnit(segment, unit)}.`,
    `Emotion: ${segment.emotional_audio_texture ?? segment.delivery_mode ?? "tense anime recap pressure"}.`,
    `Intensity: ${qwenIntensityFor(segment, unit)}.`,
    `Pacing: ${qwenPacingFor(unit)}.`,
    "Pronunciation: spell letter ranks and UI abbreviations as separated letters when needed, for example SSS is spoken as S S S.",
    "Do not say stage directions. Do not add bracket tags. Do not add words. Do not add a foreign accent. Do not stutter, repeat syllables, repeat words, add filler sounds, or invent breath noises. Stop cleanly after the final word. Preserve exact text except approved pronunciation normalization.",
  ].join(" ");
}

function buildQwenGenerationPlan(segments, qwenConfig = {}, dialogueContext = {}, ttsProvider = "qwen_local") {
  const unitRows = [];
  const segmentRows = [];
  for (const segment of segments) {
    const units = (segment.performance_units?.length ? segment.performance_units : [{
      kind: segment.dialogue_turn_count ? "dialogue" : "narration",
      speaker: segment.speakers?.[0] ?? "NARRATOR",
      text: segment.stripped_text ?? segment.caption_text ?? segment.text,
      performed_text: segment.stripped_text ?? segment.caption_text ?? segment.text,
      caption_text: segment.caption_text ?? segment.stripped_text ?? segment.text,
    }]).filter((unit) => unit.kind !== "sound_design" && !/^SFX$/i.test(String(unit.speaker ?? "")));
    const qwenUnits = units.map((unit, index) => {
      const sourceSpeaker = unit.speaker ?? "NARRATOR";
      const speaker = characterVoiceCastingEnabled() ? sourceSpeaker : "NARRATOR";
      const cast = castForSpeaker(speaker, dialogueContext);
      const role = characterVoiceCastingEnabled()
        ? cast?.role ?? speakerRoleFor(speaker, unit.text ?? "", segment, dialogueContext)
        : "narrator";
      const spokenText = qwenSpokenText(unit.performed_text ?? unit.text ?? unit.caption_text, sourceSpeaker);
      const row = {
        segment_id: segment.segment_id,
        unit_index: index + 1,
        kind: unit.kind ?? "narration",
        speaker,
        source_speaker: sourceSpeaker,
        role,
        qwen_spoken_text: spokenText,
        caption_text: unit.caption_text ?? unit.text ?? "",
        source_text: unit.text ?? "",
        qwen_instruct: qwenInstructForUnit({ segment, unit: { ...unit, speaker }, role, cast }),
        reference_audio_path: cast?.source_audio_path ?? cast?.sample_path ?? null,
        reference_text: cast?.source_transcript ?? null,
        voice_source_policy: cast?.voice_source_policy ?? (speaker === "NARRATOR" ? "owned_qwen_narrator_reference_manifest" : "pending_voice_casting"),
        voice_casting_mode: characterVoiceCastingEnabled() ? "explicit_character_voice_casting" : "narrator_only_default",
        reference_id: cast?.reference_id ?? null,
      };
      unitRows.push(row);
      return row;
    });
    segmentRows.push({
      segment_id: segment.segment_id,
      delivery_mode: segment.delivery_mode,
      expected_duration_sec: segment.expected_duration_sec,
      unit_count: qwenUnits.length,
      speakers: [...new Set(qwenUnits.map((unit) => unit.speaker))],
      qwen_generation_units: qwenUnits,
    });
  }
  return {
    status: "passed",
    provider: ttsProvider,
    generated_at: new Date().toISOString(),
    policy: "Qwen local production plan: generate per speaker/per beat with clean spoken text, natural-language --instruct prompts, owned/consented reference audio, and stitched timing. Bracket emotion tags never enter spoken text.",
    qwen_config_policy: qwenConfig.prompting ?? null,
    pronunciation_protocol: {
      letter_ranks_are_spelled: true,
      examples: ["SSS -> S S S", "SS-rank -> S S rank", "XP -> X P", "UI -> U I", "Level -1 -> Level negative one", "confirmed -> verified"],
    },
    segment_count: segmentRows.length,
    unit_count: unitRows.length,
    segments: segmentRows,
  };
}

function stringifyForGate(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function gateExcerpt(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return "";
  const start = Math.max(0, match.index - 80);
  const end = Math.min(text.length, match.index + match[0].length + 80);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function voiceArtifactContaminationGate(artifacts, currentSourceText, { seriesPackage = {} } = {}) {
  const allowedContext = String(currentSourceText ?? "");
  const foreignTerms = foreignSeriesTermSpecs({ channel, series: seriesSlug, seriesPackage });
  const protectedTerms = protectedIpTermSpecs();
  const blockers = [];
  for (const [artifact, value] of Object.entries(artifacts ?? {})) {
    const text = stringifyForGate(value);
    for (const term of foreignTerms) {
      const appearsInArtifact = resetAndTest(term.pattern, text);
      const allowedForCurrentSeries = resetAndTest(term.pattern, allowedContext);
      if (appearsInArtifact && !allowedForCurrentSeries) {
        blockers.push({
          code: "cross_series_voice_artifact_contamination",
          artifact,
          term_id: term.id,
          label: term.label,
          excerpt: gateExcerpt(text, term.pattern),
          reason: "Voice artifacts must inherit only from the current script, SeriesPackage, and current casting context.",
        });
      }
    }
    for (const term of protectedTerms) {
      if (resetAndTest(term.pattern, text)) {
        blockers.push({
          code: "protected_or_named_voice_style_reference",
          artifact,
          term_id: term.id,
          label: term.label,
          excerpt: gateExcerpt(text, term.pattern),
          reason: "Voice planning must use generic role/style descriptors or rights-cleared reference IDs, not named character/person style labels.",
        });
      }
    }
  }
  return {
    status: blockers.length ? "failed" : "passed",
    generated_at: new Date().toISOString(),
    scope: "voice_artifacts",
    rule_0: "Voice artifacts must inherit only from the current episode script, current series package, current character bible, and current voice casting lock.",
    artifact_count: Object.keys(artifacts ?? {}).length,
    blockers,
  };
}

function isProductionCandidateVoice(voice) {
  if (!voice?.enabled || !voice?.fishReferenceId || voice?.verificationStatus !== "verified") return false;
  const useFlag = String(voice.canUsePublicly ?? voice.publicUseAllowed ?? "unknown").toLowerCase();
  if (useFlag === "false" || useFlag === "no") return false;
  if (voice.publicUseAllowed === false || voice.canUsePublicly === false) return false;
  if (/internal|restricted|test_only/i.test(`${voice.role ?? ""} ${voice.source ?? ""} ${voice.restrictedReason ?? ""}`)) return false;
  const text = stringifyForGate({
    label: voice.label,
    title: voice.resolvedTitle,
    description: voice.resolvedDescription,
    notes: voice.notes,
  });
  return !protectedIpTermSpecs().some((term) => resetAndTest(term.pattern, text));
}

function segmentTimelineState(segment) {
  const text = `${segment?.segment_id ?? ""} ${segment?.stripped_text ?? ""}`.toLowerCase();
  if (/voice_seg_0[1-5]\b/.test(text)) return "failed_future_adult";
  if (/fell from a bed|fifteen years|march 2009|mi-sook|homeroom|school|teacher|student|librarian|wallet basics|seo-yeon|min-gyu|discount household store|bus shelter|spring dust|no delivery app/i.test(text)) return "teen_past";
  return "unknown";
}

function speakerRoleFor(speaker, segmentText = "", segment = null, dialogueContext = {}) {
  const label = speakerLabel(speaker);
  if (/^NARRATOR$/i.test(label)) return "narrator";
  if (/^MC_INTERNAL$/i.test(label)) return "mc_internal";
  if (/^(SYSTEM|SYSTEM UI|UI|NOTICE|WARNING)$/i.test(label)) return "system";
  const lockedCast = castForSpeaker(label, dialogueContext);
  const lockedRole = lockedCast?.id ?? lockedCast?.reference_id ?? lockedCast?.role ?? null;
  if (lockedRole && !/^joel_narrator$/i.test(String(lockedRole))) return lockedRole;
  const semanticRole = semanticVoiceRoleFromContext(speaker, segmentText, segment);
  if (semanticRole) return semanticRole;
  if (/^(MRS\.?|MS\.?|MISS|MADAM)\b/i.test(String(speaker ?? ""))) return "female";
  if (/^(MR\.?|MISTER|MAN|FATHER|DAD|UNCLE)\b/i.test(speaker)) return "adult_male";
  const mapped = dialogueContext.roleByLabel?.get(speakerLabel(speaker));
  if (mapped) return mapped;
  if (/LITTLE GIRL|GIRL CHILD|CHILD GIRL|DAUGHTER|PRINCESS|KAWAII/i.test(speaker)) return "kawaii_child_female";
  if (/LITTLE BOY|BOY CHILD|CHILD BOY/i.test(speaker)) return "child_male";
  if (/WOMAN['’]?S VOICE|FEMALE VOICE|RECEIVER/i.test(speaker)) return "female";
  if (/RADIO|BROADCAST|KX-0|VOICE/i.test(speaker)) {
    if (/woman|female|Lorna/i.test(`${segmentText} ${segment?.stripped_text ?? ""} ${segment?.caption_text ?? ""} ${segment?.semantic_voice_context ?? ""}`)) return "female";
    return "radio_source";
  }
  if (/\b(?:HUNTER|RESCUE HUNTER|SUPPORT HUNTER|RAID LEADER)\b/i.test(speaker) && /\b(?:GIRL|WOMAN|FEMALE)\b/i.test(speaker)) return "female";
  if (/\b(?:HUNTER|RESCUE HUNTER|SUPPORT HUNTER|RAID LEADER)\b/i.test(speaker)) return "authority_male";
  if (/\b(?:SEAL COUNT|COUNT VISIBLE|RANK BOARD|PUBLIC BOARD)\b/i.test(speaker)) return "system";
  if (/\b(?:INSTRUCTOR|PROFESSOR|TEACHER|OFFICER|CAPTAIN|COMMANDER)\b/i.test(speaker)) return "adult_male";
  if (/\b(?:SUPPORT GIRL|CADET GIRL|STUDENT GIRL)\b/i.test(speaker)) return "young_female";
  if (/\b(?:CADET|STUDENT|SUPPORT BOY|COMBAT CADET)\b/i.test(speaker)) return "young_male";
  if (/MOTHER|SISTER|WOMAN|GIRL|FEMALE|CLERK|NURSE|HEALER|AUNT|GRANDMOTHER|WAITRESS|CASHIER/i.test(speaker)) return "female";
  if (/TODDLER/i.test(speaker)) return "toddler";
  if (/CHILD|KID/i.test(speaker)) return "child";
  if (/\b(?:CUSTOMER|SHOPPER|STRANGER|BYSTANDER|PEDESTRIAN|PASSERBY|GUARD|WORKER|DRIVER|MAN)\b/i.test(speaker)) return "adult_male";
  if (/SYSTEM/i.test(speaker)) return "system";
  if (/TEEN|YOUNG|BOY|STUDENT/i.test(speaker)) return "young_male";
  if (/VILLAIN|ANTAGONIST|TEACHER/i.test(speaker)) return "adult_male";
  return "narrator";
}

function energeticYoungMaleVoicePolicy(fishAudioConfig) {
  return fishAudioConfig.energeticYoungMaleVoice
    ?? fishAudioConfig.youngMaleDialogueVoice
    ?? fishAudioConfig.youngDaehoVoice
    ?? null;
}

function referenceIdForRole(role, ids, fishAudioConfig, warnings = null) {
  const direct = ids[role];
  if (direct) return direct;
  if (role === "kawaii_child_female") {
    const fallback = ids.child_female || ids.young_female || ids.female || ids.child;
    if (fallback) return fallback;
  }
  if (role === "child_female") {
    const fallback = ids.kawaii_child_female || ids.young_female || ids.female || ids.child;
    if (fallback) return fallback;
  }
  if (role === "child_male") {
    const fallback = ids.child || ids.young_male;
    if (fallback) return fallback;
  }
  if (role === "authority_male") {
    const fallback = ids.adult_male || ids.intense_male || ids.villain_male;
    if (fallback) return fallback;
  }
  const energeticYoungMalePolicy = energeticYoungMaleVoicePolicy(fishAudioConfig);
  if (role === "mc_internal") {
    const fallback = ids.mc_internal || ids.protagonist || ids.young_male || ids.adult_male || energeticYoungMalePolicy?.referenceId;
    if (fallback) return fallback;
  }
  if (role === "young_male" && energeticYoungMalePolicy?.referenceId) return energeticYoungMalePolicy.referenceId;
  if (role === "adult_male" && energeticYoungMalePolicy?.referenceId) return energeticYoungMalePolicy.referenceId;
  if (warnings && !["narrator", "adult_male", "young_male", "authority_male"].includes(role)) warnings.add(role);
  return ids.narrator || fishAudioConfig.referenceId || null;
}

function castForSpeaker(speaker, dialogueContext = {}) {
  const label = speakerLabel(speaker);
  return dialogueContext.refByLabel?.get(label)
    ?? dialogueContext.refByLabel?.get(canonicalSpeakerLabelForVoice(label, [...(dialogueContext.refByLabel?.keys?.() ?? [])]))
    ?? null;
}

function referenceIdForSpeaker(speaker, role, ids, fishAudioConfig, warnings = null, dialogueContext = {}) {
  if (narratorOnlyVoiceMode(dialogueContext)) return ids.narrator || fishAudioConfig.referenceId || "joel_narrator";
  const cast = castForSpeaker(speaker, dialogueContext);
  if (cast?.reference_id || cast?.id) return cast.reference_id ?? cast.id;
  return referenceIdForRole(role, ids, fishAudioConfig, warnings);
}

function applyPronunciationOverrides(text, fishAudioConfig) {
  let next = text;
  for (const [from, to] of Object.entries(fishAudioConfig.pronunciationOverrides ?? {})) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`\\b${escaped}\\b`, "gi"), to);
  }
  return next;
}

function speakerTokenizedText(segment, fishAudioConfig, missingRefRoles, dialogueContext = {}) {
  const ids = fishAudioConfig.characterReferenceIds ?? {};
  const units = segment.performance_units?.length
    ? segment.performance_units
    : [{ kind: "narration", speaker: "NARRATOR", performed_text: segment.text, text: segment.stripped_text ?? segment.text }];
  const compactUnits = compactPerformanceUnitsByVoice(units, segment, fishAudioConfig, missingRefRoles, dialogueContext);
  const roleOrder = [];
  const roleToSpeakerIndex = new Map();
  for (const unit of compactUnits) {
    const role = speakerRoleFor(unit.speaker ?? "NARRATOR", unit.text ?? "", segment, dialogueContext);
    const referenceId = referenceIdForSpeaker(unit.speaker ?? "NARRATOR", role, ids, fishAudioConfig, missingRefRoles, dialogueContext);
    if (!referenceId) continue;
    const key = `${role}:${referenceId}`;
    if (!roleToSpeakerIndex.has(key)) {
      roleToSpeakerIndex.set(key, roleOrder.length);
      roleOrder.push({ role, referenceId });
    }
  }
  if (!roleOrder.length) return { text: segment.text, referenceIds: null, roles: [] };
  if (roleOrder.length === 1) {
    const performed = compactUnits.map((unit) => unit.performed_text ?? unit.text).join(" ").trim();
    const clearText = /\bseniority\b/i.test(performed) ? `[speaking clearly] ${performed}` : performed;
    return {
      text: applyPronunciationOverrides(clearText, fishAudioConfig),
      referenceIds: [roleOrder[0].referenceId],
      roles: [roleOrder[0].role],
    };
  }
  const text = compactUnits.map((unit) => {
    const role = speakerRoleFor(unit.speaker ?? "NARRATOR", unit.text ?? "", segment, dialogueContext);
    const referenceId = referenceIdForSpeaker(unit.speaker ?? "NARRATOR", role, ids, fishAudioConfig, missingRefRoles, dialogueContext);
    const key = `${role}:${referenceId}`;
    const speakerIndex = roleToSpeakerIndex.has(key) ? roleToSpeakerIndex.get(key) : 0;
    const performed = unit.performed_text ?? unit.text;
    const clearText = /\bseniority\b/i.test(performed) ? `[speaking clearly] ${performed}` : performed;
    return `<|speaker:${speakerIndex}|>${applyPronunciationOverrides(clearText, fishAudioConfig)}`;
  }).join(" ");
  return {
    text,
    referenceIds: roleOrder.map((entry) => entry.referenceId),
    roles: roleOrder.map((entry) => entry.role),
  };
}

function compactPerformanceUnitsByVoice(units, segment, fishAudioConfig, missingRefRoles, dialogueContext = {}) {
  const ids = fishAudioConfig.characterReferenceIds ?? {};
  const compacted = [];
  for (const unit of units ?? []) {
    if (!unit || unit.kind === "sound_design" || unit.kind === "segment_boundary") continue;
    const role = speakerRoleFor(unit.speaker ?? "NARRATOR", unit.text ?? "", segment, dialogueContext);
    const referenceId = referenceIdForSpeaker(unit.speaker ?? "NARRATOR", role, ids, fishAudioConfig, missingRefRoles, dialogueContext);
    const key = `${role}:${referenceId ?? ""}:${speakerLabel(unit.speaker ?? "NARRATOR")}`;
    const previous = compacted.at(-1);
    if (previous?.voice_compaction_key === key) {
      previous.text = [previous.text, unit.text].filter(Boolean).join(" ").trim();
      previous.performed_text = [previous.performed_text, unit.performed_text ?? unit.text].filter(Boolean).join(" ").trim();
      previous.caption_text = [previous.caption_text, unit.caption_text ?? unit.text].filter(Boolean).join(" ").trim();
      previous.compacted_unit_count = (previous.compacted_unit_count ?? 1) + 1;
      continue;
    }
    compacted.push({
      ...unit,
      performed_text: unit.performed_text ?? unit.text,
      caption_text: unit.caption_text ?? unit.text,
      voice_compaction_key: key,
      compacted_unit_count: 1,
    });
  }
  return compacted.length ? compacted : units;
}

function applyFishReferenceIds(segments, fishAudioConfig, dialogueContext = {}) {
  const enabled = Boolean(fishAudioConfig.multiSpeakerDialogue?.enabled);
  const ids = fishAudioConfig.characterReferenceIds ?? {};
  const missingRefRoles = new Set();
  const nextSegments = segments.map((segment) => {
    if (!enabled) return { ...segment, reference_ids: null, reference_id_policy: "multi_speaker_disabled" };
    if (segment.fish_generation_required === false || segment.delivery_mode === "sound_design") {
      return {
        ...segment,
        reference_ids: null,
        speaker_reference_roles: [],
        reference_id_policy: "sound_design_no_fish_reference_required",
      };
    }
    if (!segment.dialogue_turn_count) {
      return {
        ...segment,
        reference_ids: ids.narrator || fishAudioConfig.referenceId ? [ids.narrator || fishAudioConfig.referenceId] : null,
        fish_reference_id: ids.narrator || fishAudioConfig.referenceId || null,
        speaker_context: {
          speakers: segment.speakers ?? ["NARRATOR"],
          roles: ["narrator"],
          policy: "single_narrator_reference_for_narration_segment",
        },
        reference_id_policy: "single_narrator_reference_for_narration_segment",
        energetic_young_male_voice_policy: energeticYoungMaleVoicePolicy(fishAudioConfig),
      };
    }
    const tokenized = speakerTokenizedText(segment, fishAudioConfig, missingRefRoles, dialogueContext);
    const roles = tokenized.roles.length
      ? tokenized.roles
      : [...new Set((segment.speakers ?? ["NARRATOR"]).map((speaker) => speakerRoleFor(speaker, segment.text, segment, dialogueContext)))];
    const referenceIds = tokenized.referenceIds?.length
      ? tokenized.referenceIds
      : roles.map((role) => ids[role] || ids.narrator || fishAudioConfig.referenceId).filter(Boolean);
    return {
      ...segment,
      text: tokenized.text,
      speaker_reference_roles: roles,
      reference_ids: referenceIds.length ? referenceIds : null,
      fish_reference_id: referenceIds[0] ?? null,
      speaker_context: {
        speakers: segment.speakers ?? [],
        roles,
        policy: referenceIds.length ? "fish_s2_pro_reference_ids_by_speaker_role" : "no_configured_reference_ids",
      },
      reference_id_policy: referenceIds.length ? "fish_s2_pro_reference_ids_by_speaker_role" : "no_configured_reference_ids",
      energetic_young_male_voice_policy: energeticYoungMaleVoicePolicy(fishAudioConfig),
    };
  });
  return { segments: nextSegments, missingRefRoles: [...missingRefRoles] };
}

function buildDialogueMap(segments, fishAudioConfig, dialogueContext = {}) {
  const ids = fishAudioConfig.characterReferenceIds ?? {};
  const narratorOnly = narratorOnlyVoiceMode(dialogueContext);
  const turns = [];
  for (const segment of segments) {
    for (const unit of segment.performance_units ?? []) {
      if (unit.kind !== "dialogue" && unit.kind !== "performance_action" && unit.kind !== "mc_internal") continue;
      const speaker = unit.speaker ?? "UNKNOWN_DIALOGUE";
      const role = narratorOnly ? "narrator" : speakerRoleFor(speaker, unit.text ?? "", segment, dialogueContext);
      const referenceId = referenceIdForSpeaker(speaker, role, ids, fishAudioConfig, null, dialogueContext);
      const lockedCast = narratorOnly ? null : castForSpeaker(speaker, dialogueContext);
      const contextEntry = dialogueContext.byLabel?.get(speakerLabel(speaker));
      const likelyFemale = contextEntry
        ? /\b(female|young_female|child_female|kawaii_child_female)\b/.test(String(contextEntry.role ?? ""))
        : /\b(MOTHER|SISTER|WOMAN|GIRL|FEMALE)\b/i.test(speaker);
      const likelyMale = contextEntry
        ? /\b(male|young_male|adult_male|villain_male|intense_male|child_male)\b/.test(String(contextEntry.role ?? "")) && !/\bfemale\b/.test(String(contextEntry.role ?? ""))
        : /\b(BOY|MALE|FATHER|MAN|TEEN)\b/i.test(speaker);
      const lockedCastReferenceId = lockedCast?.reference_id ?? lockedCast?.id ?? null;
      const lockedCastMatched = Boolean(lockedCastReferenceId && referenceId === lockedCastReferenceId);
      const roleMismatch = !narratorOnly && !lockedCastMatched && ((likelyFemale && !["female", "young_female", "child", "child_female", "kawaii_child_female"].includes(role))
        || (likelyMale && ["female", "young_female", "child_female", "kawaii_child_female"].includes(role)));
      turns.push({
        segment_id: segment.segment_id,
        speaker,
        role,
        reference_id: referenceId,
        text: unit.text,
        performed_text: unit.performed_text,
        status: narratorOnly ? "routed" : /UNKNOWN_DIALOGUE/i.test(speaker) ? "failed_unknown_speaker" : roleMismatch ? "failed_role_mismatch" : referenceId ? "routed" : "missing_reference_id",
        role_mismatch: roleMismatch,
      });
    }
  }
  const blockers = turns.filter((turn) => turn.status !== "routed");
  return {
    status: blockers.length ? "failed" : "passed",
    generated_at: new Date().toISOString(),
    channel,
    series_slug: seriesSlug,
    week,
    episode,
    policy: narratorOnly
      ? "Narrator-only mode routes all dialogue-like fragments, UI labels, and pseudo-speakers through the locked narrator voice."
      : "Every dialogue/performance action must have a known speaker, role, and Fish reference ID before render.",
    turns,
    blockers,
  };
}

async function main() {
  const scriptPath = path.join(episodeDir, "script_clean.md");
  if (!existsSync(scriptPath)) throw new Error(`Missing locked script: ${scriptPath}`);
  await assertManualAgentScriptReview(scriptPath);
  await assertScriptApprovedForVoicePlan(scriptPath);
  const script = await fs.readFile(scriptPath, "utf8");
  const sourceScriptHash = sha256Text(script);
  const seriesTags = palette();
  const universalTags = await loadUniversalFishTags();
  const speakabilityRules = await loadSpeakabilityRules();
  const dialogueContext = await loadDialogueContext();
  const tags = { ...seriesTags, ...universalTags };
  const providerRouting = await loadProviderRouting();
  const ttsProvider = requestedTtsProvider(providerRouting, dialogueContext.voiceCastingLock);
  const qwenLocal = isQwenLocalProvider(ttsProvider);
  const qwenConfig = await readJsonIfExists(path.join(process.cwd(), "config", "qwen-tts.json"), {});
  const fishAudioConfig = await readJsonIfExists(path.join(process.cwd(), "config", "fish-audio.json"), {});
  const fishVoicesConfig = await readJsonIfExists(path.join(process.cwd(), "config", "fish-voices.json"), {});
  const voiceQualityAdjustedSegments = repairConsecutiveTagRuns(ensureMinimumPhysicalTags(
    balanceTempoClassifications(buildSegments(script, tags, speakabilityRules, dialogueContext)),
    tags,
  ));
  const applied = applyFishReferenceIds(voiceQualityAdjustedSegments, fishAudioConfig, dialogueContext);
  const baseSegments = applied.segments ?? applied;
  const missingRefRoles = applied.missingRefRoles ?? [];
  const qwenGenerationPlan = buildQwenGenerationPlan(baseSegments, qwenConfig, dialogueContext, ttsProvider);
  qwenGenerationPlan.source_script_hash = sourceScriptHash;
  qwenGenerationPlan.source_script_path = scriptPath;
  const qwenUnitsBySegment = new Map((qwenGenerationPlan.segments ?? []).map((segment) => [segment.segment_id, segment.qwen_generation_units ?? []]));
  const segments = baseSegments.map((segment) => ({
    ...segment,
    tts_provider: ttsProvider,
    qwen_generation_units: qwenUnitsBySegment.get(segment.segment_id) ?? [],
  }));
  const dialogueMap = buildDialogueMap(segments, fishAudioConfig, dialogueContext);
  dialogueMap.source_script_hash = sourceScriptHash;
  dialogueMap.source_script_path = scriptPath;
  const strategy = {
    status: "passed",
    channel,
    series_slug: seriesSlug,
    week,
    episode,
    generated_at: new Date().toISOString(),
    source_script_hash: sourceScriptHash,
    source_script_path: scriptPath,
    tts_provider: ttsProvider,
    segment_count: segments.length,
    rules: {
      min_distinct_tags: 8,
      max_single_tag_pct: 35,
      generic_default_tag_max_pct: 15,
      max_consecutive_same_tag: 4,
      min_physical_tags: 3,
      mid_sentence_tags_allowed: false,
      sentence_boundaries_preserved: true,
    },
    palette: tags,
    qwen_local_policy: {
      enabled: qwenLocal,
      provider: qwenConfig.provider ?? "qwen3-tts",
      production_default: providerRouting.audio?.production_tts_provider ?? null,
      fallback_provider: providerRouting.audio?.fallback_tts_provider ?? "fish_api",
      spoken_text_policy: "No bracketed emotion, breath, laugh, or stage tags in Qwen spoken text. Put all performance direction in --instruct.",
      instruct_policy: "Each Qwen unit carries voice identity, character, scene beat, emotion, intensity, pacing, exact-word preservation, accent limits, and pronunciation normalization.",
      pronunciation_protocol: qwenGenerationPlan.pronunciation_protocol,
      generation_plan_path: path.join(episodeDir, "qwen_generation_plan.json"),
    },
    fish_s2_pro_policy: {
      model: fishAudioConfig.model ?? "s2-pro",
      role: qwenLocal ? "fallback_or_bakeoff_only" : "production_provider",
      phrase_level_tags: true,
      dialogue_turns_tagged_inline: true,
      multi_speaker_reference_ids_supported: true,
      multi_speaker_reference_ids_enabled: Boolean(fishAudioConfig.multiSpeakerDialogue?.enabled),
      narrator_reference_id: fishAudioConfig.referenceId ?? null,
      configured_character_reference_ids: fishAudioConfig.characterReferenceIds ?? {},
      missing_dialogue_reference_policy: fishAudioConfig.missingDialogueReferencePolicy ?? null,
      missing_dialogue_reference_roles: missingRefRoles,
      voice_casting_lock_status: dialogueContext.voiceCastingLock?.status ?? "missing",
      voice_casting_lock_path: path.join(episodeDir, `voice_casting_lock_${episode}.json`),
      universal_control_tag_library_path: "config/voice/fish-s2-pro-control-tags.json",
      speakability_rules_loaded: speakabilityRules.replacements.length + speakabilityRules.performance_replacements.length + speakabilityRules.audit_patterns.length,
      universal_control_tag_library_loaded: Boolean(universalTags?.schema_version),
      pronunciation_overrides: fishAudioConfig.pronunciationOverrides ?? {},
      available_verified_voice_candidates: (fishVoicesConfig.voices ?? [])
        .filter((voice) => isProductionCandidateVoice(voice))
        .map((voice) => ({ id: voice.id, label: voice.label, reference_id: voice.fishReferenceId, can_use_publicly: voice.canUsePublicly ?? voice.publicUseAllowed ?? "unknown", tags: voice.resolvedTags ?? [] })),
      note: qwenLocal
        ? "Fish S2-Pro metadata is retained only for fallback/bakeoff compatibility. Production Qwen local uses qwen_generation_plan.json and local source_audio_path/sample_path references."
        : "Fish S2-Pro can use bracketed natural-language direction and, when explicitly configured, multiple reference IDs with speaker tags. Public/restricted rights still need review before publishing.",
    },
    audio_performance_segments: segments,
  };
  const report = qualityReport(segments, { ttsProvider });
  report.source_script_hash = sourceScriptHash;
  report.source_script_path = scriptPath;
  const dialogueAudit = auditDialoguePerformance(script, segments, speakabilityRules);
  if (dialogueMap.status !== "passed") {
    report.status = "failed_repairable";
    report.failures.push({ code: "dialogue_map_failed", severity: "blocker", blockers: dialogueMap.blockers });
    report.blockers.push({ code: "dialogue_map_failed", severity: "blocker", blockers: dialogueMap.blockers });
  }
  const audioPerformancePlan = {
    status: report.status === "passed" ? "passed" : "failed_repairable",
    channel,
    series_slug: seriesSlug,
    week,
    episode,
    tts_provider: ttsProvider,
    generated_at: new Date().toISOString(),
    source_script_hash: sourceScriptHash,
    source_script_path: scriptPath,
    operating_rules: qwenLocal
      ? [
        "Qwen local is the production TTS provider.",
        "Spoken text must be clean: no bracketed emotion, breath, laugh, or stage tags.",
        "Use per-speaker/per-beat qwen_generation_units and stitch locally.",
        "Put voice identity, scene beat, emotion, intensity, pacing, accent limits, and exact-word preservation in --instruct.",
        "Spell ambiguous rank/acronym tokens in spoken text when needed, e.g. SSS -> S S S.",
        "Preserve captions/story text separately from Qwen pronunciation-normalized spoken text.",
      ]
      : [
        "One dominant emotion per phrase.",
        "Tags apply to the following phrase.",
        "Physical tags take time; do not stack with pauses unless intentional.",
        "Use 15-25 larger emotional segments.",
        "Preserve sentence boundaries and story facts.",
        "Dialogue receives speaker-aware performance tags.",
      ],
    qwen_generation_plan_path: qwenLocal ? path.join(episodeDir, "qwen_generation_plan.json") : null,
    segments,
  };
  const explicitFallbackAllowed = fishAudioConfig.missingDialogueReferencePolicy?.mode === "fallback_to_narrator_with_warning";
  const qwenLockedSpeakerRows = Object.entries(dialogueContext.voiceCastingLock?.speaker_casting ?? {}).map(([speaker, cast]) => ({
    speaker,
    reference_id: cast?.reference_id ?? null,
    source_audio_path: cast?.source_audio_path ?? cast?.sample_path ?? null,
    source_transcript: cast?.source_transcript ?? cast?.qwen_source_transcript ?? cast?.transcript ?? null,
    source_transcript_policy: cast?.source_transcript_policy ?? null,
    source_transcript_match_status: cast?.source_transcript_match_status ?? null,
    source_transcript_word_error_rate: cast?.source_transcript_word_error_rate ?? null,
    voice_source_policy: cast?.voice_source_policy ?? null,
  }));
  const missingQwenSourceRows = qwenLocal
    ? qwenLockedSpeakerRows.filter((row) => row.speaker && !/^(NARRATOR|SFX)$/i.test(row.speaker) && (!row.source_audio_path || !String(row.source_transcript ?? "").trim() || /failed/i.test(String(row.source_transcript_match_status ?? ""))))
    : [];
  const unverifiedQwenTranscriptRows = qwenLocal
    ? qwenLockedSpeakerRows.filter((row) => row.speaker && !/^(NARRATOR|SFX)$/i.test(row.speaker) && row.source_audio_path && row.source_transcript && !/whisper/i.test(String(row.source_transcript_policy ?? "")))
    : [];
  const referenceReport = {
    status: qwenLocal
      ? missingQwenSourceRows.length ? "blocked_missing_qwen_voice_sources_or_transcripts" : "passed"
      : missingRefRoles.length ? explicitFallbackAllowed ? "missing_refs_fallback_allowed_for_tests" : "blocked_missing_dialogue_refs" : "passed",
    production_ready: qwenLocal ? missingQwenSourceRows.length === 0 : missingRefRoles.length === 0,
    test_ready_with_fallback: qwenLocal ? missingQwenSourceRows.length === 0 : missingRefRoles.length === 0 || explicitFallbackAllowed,
    generated_at: new Date().toISOString(),
    source_script_hash: sourceScriptHash,
    source_script_path: scriptPath,
    tts_provider: ttsProvider,
    qwen_generation_plan_path: qwenLocal ? path.join(episodeDir, "qwen_generation_plan.json") : null,
    configured_character_reference_ids: fishAudioConfig.characterReferenceIds ?? {},
    required_roles_detected: [...new Set(segments.flatMap((segment) => segment.speaker_reference_roles ?? []))],
    missing_reference_roles: missingRefRoles,
    missing_qwen_voice_sources: missingQwenSourceRows,
    unverified_qwen_voice_transcripts: unverifiedQwenTranscriptRows,
    voice_casting_lock_status: dialogueContext.voiceCastingLock?.status ?? "missing",
    voice_casting_lock_path: path.join(episodeDir, `voice_casting_lock_${episode}.json`),
    locked_speakers: Object.keys(dialogueContext.voiceCastingLock?.speaker_casting ?? {}),
    qwen_locked_speaker_sources: qwenLockedSpeakerRows,
    fallback_policy: fishAudioConfig.missingDialogueReferencePolicy ?? { mode: "fallback_to_narrator_with_warning" },
    recommendation: qwenLocal
      ? missingQwenSourceRows.length
        ? "Generate/apply Qwen local voice-source designs and harden their transcripts with Whisper for every detected speaker, then rerun voice-plan."
        : unverifiedQwenTranscriptRows.length
          ? "All locked Qwen-local dialogue speakers have source audio and transcripts. Run qwen-tts harden-clone-transcripts before publish audio to verify transcripts against actual audio."
          : "All locked Qwen-local dialogue speakers have Whisper-verified source audio transcripts for production generation."
      : missingRefRoles.length
        ? `Add Fish reference IDs for: ${missingRefRoles.join(", ")} before final production, or explicitly accept narrator fallback.`
        : "All detected dialogue roles have configured reference IDs.",
  };
  await writeJson(path.join(episodeDir, "fish_reference_requirements_report.json"), referenceReport);
  await writeJson(path.join(episodeDir, "voice_reference_completeness_report.json"), referenceReport);
  const performanceText = segments
    .map((segment) => segment.fish_generation_required === false
      ? `[SFX: ${String(segment.stripped_text ?? segment.caption_text ?? "").replace(/^SFX\s*:\s*/i, "").trim()}]`
      : segment.text)
    .filter((text) => String(text ?? "").trim().length)
    .join("\n\n");
  const strippedText = segments
    .map((segment) => segment.caption_text ?? segment.stripped_text ?? segment.text)
    .filter((text) => String(text ?? "").trim().length)
    .join("\n\n");
  const currentSourceText = [
    script,
    dialogueContext.entries?.map((entry) => `${entry.name} ${entry.role}`).join("\n"),
    seriesSlug,
    channel,
  ].filter(Boolean).join("\n");
  const voiceContaminationReport = voiceArtifactContaminationGate({
    audio_performance_plan: audioPerformancePlan,
    voice_direction_strategy: strategy,
    fish_reference_requirements_report: referenceReport,
    dialogue_map: dialogueMap,
    narration_fish_performance: performanceText,
    narration_fish_stripped: strippedText,
  }, currentSourceText, { seriesPackage: dialogueContext.seriesPackage });
  if (voiceContaminationReport.status !== "passed") {
    const contaminationFailure = {
      code: "voice_artifact_contamination",
      severity: "blocker",
      blockers: voiceContaminationReport.blockers,
      reason: "Voice planning produced references that do not belong to the current series or use named protected-style voice labels.",
    };
    report.status = "failed_repairable";
    report.failures.push(contaminationFailure);
    report.blockers.push(contaminationFailure);
  }
  audioPerformancePlan.status = report.status === "passed" ? "passed" : "failed_repairable";
  strategy.status = report.status === "passed" ? "passed" : "failed_repairable";
  report.voice_artifact_contamination = voiceContaminationReport;
  await writeJson(path.join(episodeDir, "qwen_generation_plan.json"), qwenGenerationPlan);
  await writeJson(path.join(episodeDir, "audio_performance_plan.json"), audioPerformancePlan);
  await writeJson(path.join(episodeDir, "voice_artifact_contamination_report.json"), voiceContaminationReport);
  await writeJson(path.join(episodeDir, `voice_artifact_contamination_report_${episode}.json`), voiceContaminationReport);
  await fs.writeFile(path.join(episodeDir, `narration_fish_performance_${episode}.txt`), performanceText, "utf8");
  await fs.writeFile(path.join(episodeDir, `narration_fish_stripped_${episode}.txt`), strippedText, "utf8");
  await fs.writeFile(path.join(episodeDir, "narration_fish_performance_ep_01.txt"), performanceText, "utf8");
  await fs.writeFile(path.join(episodeDir, "narration_fish_stripped_ep_01.txt"), strippedText, "utf8");
  await writeJson(path.join(episodeDir, `narration_fish_diff_${episode}.json`), {
    status: "passed",
    source: "voice-direction-gate",
    generated_at: new Date().toISOString(),
    source_script_hash: sourceScriptHash,
    source_script_path: path.join(episodeDir, "script_clean.md"),
    source_segment_count: segments.length,
    fish_performance_script_hash: sha256Text(performanceText),
    stripped_narration_hash: sha256Text(strippedText),
    sfx_segments_excluded_from_fish_generation: segments.filter((segment) => segment.fish_generation_required === false).map((segment) => segment.segment_id),
    note: "Canonical Fish performance text is regenerated by voice-plan from audio_performance_plan; stale media-era scripts must not be used.",
  });
  await writeJson(path.join(episodeDir, "narration_fish_diff_ep_01.json"), {
    status: "passed",
    source: "voice-direction-gate",
    generated_at: new Date().toISOString(),
    source_script_hash: sourceScriptHash,
    source_script_path: path.join(episodeDir, "script_clean.md"),
    source_segment_count: segments.length,
    fish_performance_script_hash: sha256Text(performanceText),
    stripped_narration_hash: sha256Text(strippedText),
    sfx_segments_excluded_from_fish_generation: segments.filter((segment) => segment.fish_generation_required === false).map((segment) => segment.segment_id),
    note: "Canonical Fish performance text is regenerated by voice-plan from audio_performance_plan; stale media-era scripts must not be used.",
  });
  await fs.writeFile(path.join(episodeDir, "voice_director_debug_script.txt"), segments.slice(0, 8).map((segment) => segment.text).join("\n\n"), "utf8");
  await writeJson(path.join(episodeDir, `voice_direction_strategy_${episode}.json`), strategy);
  await writeJson(path.join(episodeDir, "voice_direction_strategy_ep_01.json"), strategy);
  await writeJson(path.join(episodeDir, `voice_direction_quality_report_${episode}.json`), report);
  await writeJson(path.join(episodeDir, "voice_direction_quality_report_ep_01.json"), report);
  await writeJson(path.join(episodeDir, `dialogue_performance_audit_${episode}.json`), dialogueAudit);
  await writeJson(path.join(episodeDir, "dialogue_performance_audit_ep_01.json"), dialogueAudit);
  await writeJson(path.join(episodeDir, "dialogue_map.json"), dialogueMap);
  console.log(JSON.stringify({ stage: "voice-plan", status: report.status, tts_provider: ttsProvider, unique_tags: report.unique_tags, segment_count: segments.length, qwen_generation_plan: qwenLocal ? path.join(episodeDir, "qwen_generation_plan.json") : null, failures: report.failures }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
