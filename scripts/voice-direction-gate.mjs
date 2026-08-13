#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasTtsTerminalPunctuation } from "./lib/tts-text-boundaries.mjs";

export { hasTtsTerminalPunctuation } from "./lib/tts-text-boundaries.mjs";
import { foreignSeriesTermSpecs, protectedIpTermSpecs, resetAndTest } from "./series-foreign-lexicon.mjs";
import {
  QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  QWEN_JOEL_PRIMARY_LOCK,
  QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK,
  QWEN_LIAM_PRIMARY_LOCK,
  QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT,
  QWEN_LOCAL_FALLBACK_LOCK,
} from "./lib/narration-tts-policy.mjs";
import {
  buildQwenLiamBatchPlan,
  qwenBatchBindingByUnit,
} from "./lib/qwen-liam-batch-contract.mjs";
import { contentProfileForIdentity } from "./lib/content-profiles.mjs";
import { buildTtsSpokenTextAudit } from "./lib/tts-spoken-text-audit.mjs";
import {
  buildNarrationPerformanceContract,
  canonicalNarrationContractSha256,
  narrationSourceRefKey,
  validateActionableNarrationDirection,
} from "./lib/narration-performance-contract.mjs";
import { authorNarrationPerformanceDirection } from "./lib/narration-performance-author.mjs";

const DATA_ROOT = process.env.ANIFACTORY_DATA_ROOT || "/Users/joel/AniFactoryData";
const DEFAULT_QWEN_NARRATOR_VOICE_ID = "joel_owned_narrator_clone";
const DEFAULT_QWEN_NARRATOR_VOICE_POLICY = "default_joel_owned_narrator_clone";
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
const emitLegacyFishArtifacts = flags["emit-legacy-fish-artifacts"] === "true";
const repoRoot = process.cwd();

function qwenPrimaryLockForVoiceId(voiceId, referenceVariantId = null) {
  return voiceId === QWEN_LIAM_PRIMARY_LOCK.voice_id
    ? QWEN_LIAM_PRIMARY_LOCK
    : referenceVariantId === QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK.reference_variant_id
      ? QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK
    : QWEN_JOEL_PRIMARY_LOCK;
}

function characterVoiceCastingEnabled() {
  const value = flags["character-voice-casting"] ?? process.env.ANIFACTORY_CHARACTER_VOICE_CASTING ?? "false";
  return /^(?:true|1|yes|enabled|on)$/i.test(String(value).trim());
}

function narratorOnlyVoiceMode(dialogueContext = {}) {
  return !characterVoiceCastingEnabled()
    || dialogueContext?.voiceCastingLock?.voice_casting_mode === "narrator_only_default"
    || dialogueContext?.voiceCastingLock?.character_voice_casting_enabled === false;
}

function cleanVoiceId(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizeTtsProvider(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (["kokoro", "kokoro_local", "local_kokoro", "mlx_kokoro"].includes(normalized)) return "kokoro_local";
  if (["qwen", "qwen_local", "local_qwen", "local_qwen3", "modelslab_qwen", "qwen3"].includes(normalized)) return "qwen_local";
  if (["fish", "fish_api", "fish_s2", "fish_s2_pro"].includes(normalized)) return "fish_api";
  return normalized || null;
}

function identityLockedTtsProvider(identity = {}) {
  return normalizeTtsProvider(
    identity?.tts_provider
      ?? identity?.provider_locks?.tts_provider
      ?? identity?.voice_provider_options?.primary?.provider
      ?? identity?.voice_provider_options?.tts_provider
      ?? null,
  );
}

function selectedQwenNarratorVoiceId(identity = {}) {
  const lockedProvider = identityLockedTtsProvider(identity);
  if (lockedProvider === "kokoro_local") {
    return cleanVoiceId(identity?.voice_provider_options?.fallback?.reference_voice_id)
      ?? QWEN_LOCAL_FALLBACK_LOCK.reference_voice_id;
  }
  const legacyGenericNarratorFlag = !lockedProvider || lockedProvider === "qwen_local"
    ? flags["narrator-voice-id"]
    : null;
  const legacyGenericNarratorVoiceId = !lockedProvider || lockedProvider === "qwen_local"
    ? identity?.narrator_voice_id
    : null;
  return cleanVoiceId(flags["qwen-narrator-voice-id"])
    ?? cleanVoiceId(legacyGenericNarratorFlag)
    ?? cleanVoiceId(identity?.voice_provider_options?.qwen_narrator_voice_id)
    ?? cleanVoiceId(identity?.qwen_narrator_voice_id)
    ?? cleanVoiceId(legacyGenericNarratorVoiceId)
    ?? DEFAULT_QWEN_NARRATOR_VOICE_ID;
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
      failed_future: ["[exhausted but forward]", "[restrained despair]", "[shame held under control]", "[worn down, still moving]"],
      haru: ["[aching tenderness, steady pace]", "[fragile but clear]", "[protective and direct]", "[holding back tears, still moving]"],
      regression: ["[stunned, breath controlled]", "[confused disbelief, moving forward]", "[sharp realization]", "[disoriented but focused]"],
      strategy: ["[dry, calculating focus]", "[controlled urgency]", "[excitement contained]", "[measured and alert]"],
      system: ["[cold, clipped system readout]", "[clinical warning, steady pace]", "[precise machine notice]", "[controlled alarm]"],
      family: ["[restrained warmth]", "[guilty but clear]", "[trying to sound normal]", "[tired tenderness, steady pace]"],
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
      cliffhanger: ["[dangerous restraint, forward pace]", "[ominous and controlled]", "[tension held without pausing]", "[clipped cliffhanger landing]"],
      physical: ["[breathes in]", "[exhales slowly]", "[sighs quietly]", "[voice catches]", "[swallows hard]", "[sharp inhale]", "[bitter laugh under his breath]", "[clears throat quietly]"],
      humor: ["[dry, darkly amused]", "[bitter laugh under his breath]"],
    };
  }
  return {
    default: ["[grounded, forward]", "[tense, focused]", "[wounded but controlled]", "[urgent, controlled]", "[cold tension]", "[firm resolve]", "[bitterly amused]", "[clipped cliffhanger]"],
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
  const runIdentity = await readJsonIfExists(path.join(episodeDir, "run_identity.json"), {});
  const puckPrimaryIdentity = identityLockedTtsProvider(runIdentity) === "kokoro_local";
  const narratorVoiceId = selectedQwenNarratorVoiceId(runIdentity);
  const qwenPrimaryIdentity = identityLockedTtsProvider(runIdentity) === "qwen_local"
    && [QWEN_JOEL_PRIMARY_LOCK.voice_id, QWEN_LIAM_PRIMARY_LOCK.voice_id].includes(narratorVoiceId);
  const qwenPrimaryLock = qwenPrimaryLockForVoiceId(narratorVoiceId);
  const narratorVoice = await readGlobalQwenVoice(narratorVoiceId);
  const rawVoiceCastingLock = await readJsonIfExists(path.join(episodeDir, `voice_casting_lock_${episode}.json`), await readJsonIfExists(path.join(episodeDir, "voice_casting_lock_ep_01.json"), {}));
  const rawNarratorCast = rawVoiceCastingLock?.speaker_casting?.NARRATOR ?? rawVoiceCastingLock?.speaker_casting?.narrator ?? null;
  const rawNarratorVoiceId = cleanVoiceId(rawNarratorCast?.reference_id) ?? cleanVoiceId(rawNarratorCast?.id);
  const narratorCast = qwenPrimaryIdentity
    ? {
        id: qwenPrimaryLock.voice_id,
        reference_id: qwenPrimaryLock.voice_id,
        source_audio_path: qwenPrimaryLock.reference_audio_path,
        source_transcript: qwenPrimaryLock.reference_text,
        source_transcript_sha256: qwenPrimaryLock.reference_text_sha256,
        voice_source_policy: qwenPrimaryLock.voice_continuity_contract,
      }
    : puckPrimaryIdentity
    ? {
        id: QWEN_LOCAL_FALLBACK_LOCK.reference_voice_id,
        reference_id: QWEN_LOCAL_FALLBACK_LOCK.reference_voice_id,
        source_audio_path: QWEN_LOCAL_FALLBACK_LOCK.reference_audio_path,
        source_transcript: QWEN_LOCAL_FALLBACK_LOCK.reference_text,
        source_transcript_sha256: QWEN_LOCAL_FALLBACK_LOCK.reference_text_sha256,
        voice_source_policy: "puck_primary_qwen_exact_unit_clone",
      }
    : rawNarratorVoiceId === narratorVoiceId ? rawNarratorCast
      ?? narratorVoice
      ?? { id: narratorVoiceId, reference_id: narratorVoiceId }
      : narratorVoice
        ?? rawNarratorCast
        ?? { id: narratorVoiceId, reference_id: narratorVoiceId };
  const voiceCastingLock = characterVoiceCastingEnabled()
    ? await applySeriesQwenCastingMap(rawVoiceCastingLock)
    : {
        ...(rawVoiceCastingLock ?? {}),
        status: rawVoiceCastingLock?.status ?? "passed",
        production_ready: rawVoiceCastingLock?.production_ready ?? true,
        narrator_voice_id: rawVoiceCastingLock?.narrator_voice_id ?? narratorVoiceId,
        requested_narrator_voice_id: rawVoiceCastingLock?.requested_narrator_voice_id ?? narratorVoiceId,
        narrator_voice_policy: qwenPrimaryIdentity
          ? "single_qwen_reference_clone"
          : puckPrimaryIdentity
          ? "single_puck_identity_with_qwen_exact_unit_clone"
          : rawVoiceCastingLock?.narrator_voice_policy ?? runIdentity?.qwen_narrator_voice_policy ?? runIdentity?.voice_provider_options?.qwen_narrator_voice_policy ?? DEFAULT_QWEN_NARRATOR_VOICE_POLICY,
        voice_casting_mode: "narrator_only_default",
        character_voice_casting_enabled: false,
        run_identity_path: path.join(episodeDir, "run_identity.json"),
        speaker_casting: {
          NARRATOR: narratorCast,
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
    runIdentity,
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

function requestedTtsProvider(providerRouting, voiceCastingLock = {}, runIdentity = {}) {
  const lockedProvider = identityLockedTtsProvider(runIdentity);
  const requestedProvider = normalizeTtsProvider(flags["tts-provider"]);
  if (lockedProvider && requestedProvider && lockedProvider !== requestedProvider) {
    throw new Error(`Refusing voice-plan provider drift: run_identity.json locks '${lockedProvider}', but --tts-provider requested '${requestedProvider}'.`);
  }
  return lockedProvider
    ?? requestedProvider
    ?? normalizeTtsProvider(voiceCastingLock?.tts_provider)
    ?? normalizeTtsProvider(providerRouting.audio?.production_tts_provider)
    ?? "qwen_local";
}

function isQwenLocalProvider(ttsProvider) {
  return normalizeTtsProvider(ttsProvider) === "qwen_local";
}

function isKokoroLocalProvider(ttsProvider) {
  return normalizeTtsProvider(ttsProvider) === "kokoro_local";
}

function isUnitBasedNarratorProvider(ttsProvider) {
  return isQwenLocalProvider(ttsProvider) || isKokoroLocalProvider(ttsProvider);
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

async function loadTtsSpokenOverrides(sourceScriptHash) {
  const filePath = path.join(episodeDir, "tts_spoken_overrides.json");
  const artifact = await readJsonIfExists(filePath, null);
  if (!artifact) return { artifact: null, replacements: [], pronunciation_map: [] };
  if (artifact.source_script_hash !== sourceScriptHash) {
    throw new Error(`Stale TTS spoken overrides: ${filePath} is for ${artifact.source_script_hash}, current script is ${sourceScriptHash}. Rerun script speakability.`);
  }
  if (!/^(passed|approved)$/i.test(String(artifact.status ?? ""))) {
    throw new Error(`TTS spoken overrides are not passed/approved: ${artifact.status ?? "missing_status"}. Review ${filePath}.`);
  }
  return {
    artifact,
    replacements: artifact.replacements ?? [],
    pronunciation_map: artifact.pronunciation_map ?? [],
  };
}

async function requireSpeakabilityReport(sourceScriptHash) {
  if (flags["allow-missing-speakability"] === "true") return { status: "diagnostic_bypass" };
  const filePath = path.join(episodeDir, "script_speakability_report.json");
  const report = await readJsonIfExists(filePath, null);
  if (!report) throw new Error(`Missing script_speakability_report.json. Run: node bin/goldflow.mjs script speakability --channel ${channel} --series ${seriesSlug} --week ${week} --episode ${episode}`);
  if (report.source_script_hash !== sourceScriptHash) {
    throw new Error(`Stale script_speakability_report.json: report is for ${report.source_script_hash}, current script is ${sourceScriptHash}. Rerun script speakability.`);
  }
  if (!/^(passed|approved)$/i.test(String(report.status ?? ""))) {
    throw new Error(`Script speakability status is ${report.status ?? "missing_status"}. Resolve blockers before voice-plan.`);
  }
  return report;
}

function applySpokenOverrideRules(text, rules = []) {
  return applySpokenOverrideRulesWithAudit(text, rules).text;
}

function canonicalSpokenOverrideScope(value) {
  const normalized = String(value ?? "tts_spoken_text").trim().toLowerCase();
  if (["tts_spoken_text", "qwen_spoken_text", "narration_generation_plan.spoken_text", "qwen_generation_plan.qwen_spoken_text"].includes(normalized)) {
    return "tts_spoken_text";
  }
  return normalized;
}

function applySpokenOverrideRulesWithAudit(text, rules = []) {
  let next = String(text ?? "");
  const applied = [];
  for (const [index, rule] of (rules ?? []).entries()) {
    if (!rule?.from || typeof rule.to !== "string") continue;
    const scope = canonicalSpokenOverrideScope(rule.scope);
    if (scope !== "tts_spoken_text") continue;
    const flagsValue = rule.flags ?? "g";
    const pattern = rule.regex === true
      ? new RegExp(rule.from, flagsValue)
      : new RegExp(rule.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flagsValue);
    const before = next;
    next = next.replace(pattern, rule.to);
    if (next !== before) {
      applied.push({
        rule_index: index,
        from: rule.from,
        to: rule.to,
        scope,
        source_scope: rule.scope ?? "tts_spoken_text",
        asr_equivalence_allowed: rule.asr_equivalence_allowed === true,
        provider_scope: Array.isArray(rule.provider_scope) ? rule.provider_scope.map(normalizeTtsProvider).filter(Boolean) : [],
      });
    }
  }
  return { text: next, applied };
}

function applyPronunciationMap(text, pronunciationMap = []) {
  let next = String(text ?? "");
  for (const entry of pronunciationMap ?? []) {
    if (!entry?.term || typeof entry.spoken !== "string") continue;
    const pattern = new RegExp(entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    next = next.replace(pattern, entry.spoken);
  }
  return next;
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
  if (/^(CHAPTER|EPISODE|SCENE|ACT|NOTE|VISUAL|EMOTION|SFX|ROLE|REQUIREMENTS?|STATUS|TARGET|SYSTEM|NOTICE|WARNING|WAGER|BALANCE|COST|ALLOCATION|VERDICT|METHOD|DURATION|PARTY SIZE|CASUALTIES|DEBTORS?|FINAL BALANCE)$/i.test(rawSpeaker)) return null;
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
  if (seriesSlug === "30-year-old-loser-reborn-to-buy-bitcoin") {
    if (/app[a']?s close|did you drink water|dinosaur has seniority|dinosaur gets first sip|don't eat the last rice|blanket up|count slow|we get first pick|i'm hanging up|i have to hang up|^yes\.?$|^no\.?$|^tonight\.?$|^tomorrow\.?$/i.test(quote)) return "DAE-HO";
    if (/^appa\b|dinosaur drank|poor people|get different dreams|basement dreams|^appa\??$|i ate at school|dinosaur gets angry/i.test(quote)) return "HARU";
  }
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
  if (/^\s*,?\s*she\s+(said|asked|muttered|answered|called|laughed|whispered|warned|replied|rasped|snarled|shouted|snapped|hissed|sighed|continued|commanded|declared|announced|responded|ordered)/i.test(after)) {
    if (explicitBefore) return explicitBefore;
    if (explicitAfter) return explicitAfter;
    if (/clerk/i.test(context)) return "CLERK";
    return "UNKNOWN_DIALOGUE";
  }
  if (/^\s*,?\s*he\s+(said|asked|muttered|answered|called|laughed|whispered|warned|replied|rasped|snarled|shouted|snapped|hissed|sighed|continued|commanded|declared|announced|responded|ordered)/i.test(after)) {
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
  // Attribution is approved story text. A prior heuristic treated any leading
  // noun followed by words such as "snapped", "ordered", or "continued" as a
  // disposable dialogue tag. That deleted valid lines such as "The ring
  // snapped..." and "Joey ordered...". Only an approved, hash-bound
  // tts_spoken_overrides rule may remove or replace narration words.
  return String(text ?? "").trim();
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

const NON_SPOKEN_BRACKET_PREFIX = /^(?:SFX|SOUND|SOUND DESIGN|AMBIENCE|AMBIENT|ROOM TONE|MUSIC|SCORE|COMMENT_BAIT|BREATH_BEAT|MC_INTERNAL)\b\s*:*/i;
const NON_SPOKEN_BRACKET_DIRECTION = /^(?:short\s+pause|pause|long\s+pause|micro-pause|beat|silence|laughs?|chuckles?|sighs?|gasps?|breathes?|whispers?|shouts?|screams?|music\s+(?:starts?|stops?|rises?|fades?)|fade\s+(?:in|out)|cut\s+to|scene\s+change|end(?:\s+episode)?|camera|close-up|wide\s+shot)\b/i;

function standaloneSystemUiText(text) {
  const clean = String(text ?? "").trim();
  const match = clean.match(/^\[([^\]\n]+)\]$/);
  if (!match) return null;
  const body = match[1].trim();
  if (!body || NON_SPOKEN_BRACKET_PREFIX.test(body) || NON_SPOKEN_BRACKET_DIRECTION.test(body)) return null;
  if (isExplicitSoundDesignCueText(clean)) return null;
  return body;
}

function systemUiUnit(text) {
  const spoken = standaloneSystemUiText(text);
  if (!spoken) return null;
  return {
    kind: "system_ui",
    speaker: "SYSTEM",
    text: spoken,
    performed_text: spoken,
    caption_text: String(text ?? "").trim(),
    metadata_tags: ["SYSTEM_UI", "SPEAK_BRACKET_CONTENTS"],
  };
}

const COLONLESS_SYSTEM_UI_OPENING = /^(?:SYSTEM|SYSTEM UI|UI|NOTICE|WARNING|MESSAGE|HOST STATUS|STATUS|ANALYZING|SKILL|SKILL ACQUIRED|CLAIM|CLAIM ATTEMPT|TARGET|CONDITION|CONDITION MET|PENDING|TERRITORY|NEW STATUS|TRANSFER|CONTROL|ASSET|PACT|CONTRACT|AGGRESSOR|CIVIC HALL|ROYAL MARRIAGE PACT|TENANT CHANGE)\b/u;

function colonlessSystemUiBlock(text) {
  const caption = String(text ?? "").trim();
  if (!caption || /["“”]/u.test(caption)) return null;
  const lines = caption.split(/\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.some((line) => /[a-z]/u.test(line) || !/[A-Z]/u.test(line))) return null;
  const opening = lines[0];
  if (!COLONLESS_SYSTEM_UI_OPENING.test(opening)) return null;
  if (lines.some((line) => words(line).length > 28)) return null;
  const spoken = lines.join(" ");
  return {
    kind: "system_ui",
    speaker: "SYSTEM",
    text: spoken,
    performed_text: spoken,
    caption_text: caption,
    merge_barrier: true,
    atomic: true,
    metadata_tags: ["SYSTEM_UI", "SPEAK_COLONLESS_ALL_CAPS_BLOCK", "ATOMIC"],
  };
}

function isKnownDialogueSpeakerLabel(label, dialogueContext = {}) {
  const normalized = speakerLabel(label);
  if (!normalized) return false;
  if (dialogueContext?.roleByLabel?.has?.(normalized)) return true;
  if ((dialogueContext?.entries ?? []).some((entry) => (
    entry?.label === normalized
    || (entry?.aliases ?? []).some((alias) => speakerLabel(alias) === normalized)
  ))) return true;
  return /^(?:NARRATOR|VOICEOVER|VOICE OVER|VO|V\.O\.|MC_INTERNAL|TRAINEE|BYSTANDER|CROWD|CIVILIAN|WORKER|STUDENT|HUNTER|GUARD|NURSE|CLERK|MAN|WOMAN|VOICE|ONLOOKER|SPECTATOR|WITNESS)(?:\s+\d+)?$/i.test(normalized);
}

function colonSystemUiUnit(text, dialogueContext = {}) {
  const clean = String(text ?? "")
    .trim()
    .replace(/^\[COMMENT_BAIT\]\s*/i, "")
    .replace(/^\[BREATH_BEAT\]\s*/i, "");
  const match = clean.match(/^([A-Z][A-Z0-9 _'’. -]{1,80}):\s*(\S.*)$/);
  if (!match) return null;
  const label = match[1].trim();
  const explicitInterfaceLabel = /^(?:SYSTEM|SYSTEM UI|UI|NOTICE|WARNING)\b/i.test(label);
  const allCapsRecord = !/[a-z]/.test(clean)
    && /[A-Z]/.test(match[2])
    && !isKnownDialogueSpeakerLabel(label, dialogueContext);
  if (!explicitInterfaceLabel && !allCapsRecord) return null;
  return {
    kind: "system_ui",
    speaker: "SYSTEM",
    text: clean,
    performed_text: clean,
    caption_text: clean,
    metadata_tags: ["SYSTEM_UI", "SPEAK_COLON_LABEL_AND_VALUE"],
  };
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
    .replace(/\[[^\]\n]+\]/g, protect)
    .replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St)\./g, protect)
    .replace(/\b(?:a\.m\.|p\.m\.)/gi, protect)
    .replace(/\b[A-Z]\./g, protect);
  const restore = (part) => {
    let next = part;
    for (const [key, original] of placeholders) next = next.replaceAll(key, original);
    return next.trim();
  };
  return protectedValue.match(/[^.!?]+[.!?]+(?:[\]"”’)]*)?|[^.!?]+$/g)?.map(restore).filter(Boolean) ?? [value];
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
  const interfaceUnit = systemUiUnit(remaining);
  if (interfaceUnit) {
    units.push(interfaceUnit);
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

function detectMode(text, explicitSpeaker = null) {
  const lower = text.toLowerCase();
  if (explicitSpeaker && /^MC_INTERNAL$/i.test(explicitSpeaker)) return "mc_internal";
  if (explicitSpeaker && /^(SYSTEM|SYSTEM UI|UI|NOTICE|WARNING)$/i.test(explicitSpeaker)) return "warning/system";
  if (explicitSpeaker && explicitSpeaker !== "NARRATOR") return "character_dialogue";
  if (/^(?:SYSTEM(?: UI| WARNING)?|UI|NOTICE|WARNING)\s*:/i.test(text)) return "warning/system";
  if (/^[A-Z][A-Z0-9'’. -]{1,40}:/.test(text) || /^[A-Z][A-Za-z0-9'’. -]{1,40}:/.test(text)) return "character_dialogue";
  const sentenceParts = splitIntoSentences(text).map((part) => part.trim()).filter(Boolean);
  const shortInventoryRun = sentenceParts.length >= 4 && sentenceParts.filter((part) => words(part).length <= 4).length >= 3;
  if (shortInventoryRun && /noise thinned|forms|lanterns|exit map|doors visible|behind her|clock|sirens|badge|stairs|stairwell|froze|trapped|failed|route|shelter/i.test(lower)) {
    return "panic/freeze inventory";
  }
  if (/\b(?:system|continuity|probability|timeline deviation|quest|reward|skill|status|warning|notice)\b/i.test(text)) return "warning/system";
  if (/\b(?:loudspeaker|broadcast|transmission|recording|intercom|surveillance feed|went on air|on the air)\b/i.test(lower)) return "tense reveal";
  if (/\b(?:child|son|daughter|baby|toddler|little boy|little girl)\b/i.test(lower)) return "memory/child tenderness";
  if (/\b(?:strategy|contingency|analytics|contract|evidence|receipt|dashboard|leverage|negotiat(?:e|ed|ion)|budget|revenue|broker|wallet)\b/i.test(lower)) return "strategy";
  if (/\b(?:regression|regressed|second life|returned to the past|woke up younger|woke up years earlier|calendar showed)\b/i.test(lower)) return "regression shock";
  if (/\b(?:mother|father|parent|parents|family|sister|brother)\b/i.test(lower)) return "family";
  if (/\b(?:laughed|joke|absurd|ridiculous|deadpan)\b/i.test(lower) && !/\b(?:missing|voice|speaker|recorded|intercom)\b/i.test(lower)) return "dry humor";
  if (/\b(?:but (?:he|she|they|i) (?:did not|didn't) know|had no idea what came next|was only the beginning|had only begun|was not over yet|wasn't over yet|one final warning|waiting for (?:him|her|them)|what came next)\b/i.test(lower)) return "cliffhanger landing";
  if (/\b(?:clinic|deposit|medicine|rent|poverty|eviction|debt collector|unpaid bill)\b/i.test(lower)) return "failed future / poverty";
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
    return ["[warm, direct]", "[tender, moving forward]", "[protective, controlled]"][segmentIndex % 3];
  }
  if (mode === "regression shock") return ["[shocked, moving forward]", "[urgent disbelief]", "[controlled shock]"][segmentIndex % 3];
  if (mode === "strategy") return ["[focused, brisk]", "[analytical, direct]", "[determined, forward]"][segmentIndex % 3];
  if (mode === "warning/system") return ["[cold, clipped system notice]", "[precise machine readout]", "[formal system warning]"][segmentIndex % 3];
  if (mode === "panic/freeze inventory") return ["[controlled urgency]", "[tense, moving forward]", "[stunned but direct]"][segmentIndex % 3];
  if (mode === "tense reveal") return ["[tense reveal, forward]", "[shocked, controlled]", "[urgent realization]"][segmentIndex % 3];
  if (mode === "family") return ["[grounded, forward narration]", "[concerned, direct]", "[protective, controlled]"][segmentIndex % 3];
  if (mode === "dry humor") return first(recipes.dry_humor, "[sarcastic]");
  if (mode === "cliffhanger landing") return ["[tense, moving forward]", "[ominous, controlled]", "[sharp cliffhanger landing]"][segmentIndex % 3];
  if (mode === "failed future / poverty") return ["[strained, moving forward]", "[weary but direct]", "[grim, controlled]"][segmentIndex % 3];
  if (mode === "performed dialogue mix") return "[lightly acted dialogue, natural and restrained]";
  if (mode === "exposition narration") {
    return ["[grounded, forward narration]", "[focused, brisk]", "[curious, controlled]", "[tense, moving forward]"][segmentIndex % 4];
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
  if (["memory/child tenderness", "regression shock", "cliffhanger landing", "failed future / poverty", "family", "panic/freeze inventory"].includes(mode) && segmentIndex % 6 === 1) {
    return physical[segmentIndex % physical.length];
  }
  return null;
}

function pauseForMode(mode, segmentIndex) {
  if (mode === "cliffhanger landing") return segmentIndex % 4 === 1 ? "[micro-pause]" : null;
  if (["warning/system", "tense reveal", "regression shock", "memory/child tenderness", "panic/freeze inventory"].includes(mode)) return segmentIndex % 6 === 1 ? "[short pause]" : null;
  if (mode === "character_dialogue") return segmentIndex % 4 === 1 ? "[micro-pause]" : null;
  if (mode === "performed dialogue mix" && segmentIndex % 6 === 1) return "[micro-pause]";
  return null;
}

function isPauseOnlyTag(tag) {
  return /^\[(?:short\s+pause|pause|long\s+pause|micro-pause)\]$/i.test(String(tag ?? "").trim());
}

function lightlyPunctuate(text, mode) {
  if (mode === "cliffhanger landing" && !/[.!?…]$/.test(text)) return `${text}.`;
  return text;
}

export function isInlineQuotedNarrationTerm({ before = "", quotedText = "" } = {}) {
  const cleanQuotedText = String(quotedText ?? "").trim();
  if (!cleanQuotedText || words(cleanQuotedText).length > 8) return false;
  if (/[.!?…—]["”’\])]*$/u.test(cleanQuotedText)) return false;
  return /\b(?:write|writes|wrote|written|type|typed|enter|entered|label|labeled|mark|marked|list|listed|name|named|call|called|describe|described|record|recorded)\s*[:=-]?\s*$/i
    .test(String(before ?? "").trim());
}

export function normalizeAtomicSpokenTerminal(spokenText, { sourceText = "", kind = "narration" } = {}) {
  const cleanSpokenText = String(spokenText ?? "").trim();
  if (!cleanSpokenText || hasTtsTerminalPunctuation(cleanSpokenText)) return cleanSpokenText;
  const cleanSourceText = String(sourceText ?? "").trim();
  const allCapsDisplayLine = /[A-Z]/.test(cleanSourceText)
    && /^[A-Z0-9][A-Z0-9 '&:/+,%().-]*$/u.test(cleanSourceText);
  if (kind === "system_ui" || allCapsDisplayLine) return `${cleanSpokenText}.`;
  return cleanSpokenText;
}

function paragraphUnits(script, tags, speakabilityRules = {}, dialogueContext = {}) {
  const units = [];
  let dialogueTurnIndex = 0;
  let recentNarrationContext = "";
  const rememberNarrationContext = (value) => {
    const clean = String(value ?? "").trim();
    if (!clean) return;
    recentNarrationContext = `${recentNarrationContext}\n${clean}`.trim().slice(-900);
  };
  const paragraphs = stripTitle(script).split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const colonlessInterface = colonlessSystemUiBlock(paragraph);
    if (colonlessInterface) {
      units.push(colonlessInterface);
      units.push({ kind: "segment_boundary", speaker: "BOUNDARY", text: "", performed_text: "", caption_text: "" });
      continue;
    }
    const lines = paragraph.split(/\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1 && lines.some((line) => colonSystemUiUnit(line, dialogueContext) || colonDialogueLine(line))) {
      for (const line of lines) {
        const interfaceUnit = colonSystemUiUnit(line, dialogueContext);
        if (interfaceUnit) {
          units.push(interfaceUnit);
          continue;
        }
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
          rememberNarrationContext(line);
        }
      }
      units.push({ kind: "segment_boundary", speaker: "BOUNDARY", text: "", performed_text: "", caption_text: "" });
      continue;
    }
    const wholeLineInterface = colonSystemUiUnit(paragraph, dialogueContext);
    if (wholeLineInterface) {
      units.push(wholeLineInterface);
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
      rememberNarrationContext(paragraph);
      units.push({ kind: "segment_boundary", speaker: "BOUNDARY", text: "", performed_text: "", caption_text: "" });
      continue;
    }
    const allQuotesAreInlineNarrationTerms = quotes.every((quote) => isInlineQuotedNarrationTerm({
      before: paragraph.slice(0, quote.index ?? 0),
      quotedText: quote[1],
    }));
    if (allQuotesAreInlineNarrationTerms) {
      units.push(...narrationPerformanceUnits(paragraph));
      rememberNarrationContext(paragraph);
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
      let speaker = inferQuoteSpeaker(paragraph, spoken, dialogueContext);
      if ((!speaker || /UNKNOWN_DIALOGUE/i.test(speaker)) && recentNarrationContext) {
        const contextualSpeaker = inferQuoteSpeaker(`${recentNarrationContext}\n${paragraph}`, spoken, dialogueContext);
        if (contextualSpeaker && !/UNKNOWN_DIALOGUE/i.test(contextualSpeaker)) speaker = contextualSpeaker;
      }
      if (/UNKNOWN_DIALOGUE/i.test(speaker ?? "")) speaker = null;
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
    rememberNarrationContext(paragraph);
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
  if (/\b(?:slow|silence|pause|held breath|extended stillness)\b/.test(haystack) || wps < 1.85 || count <= 4) return "slow";
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

  // Keep expected durations aligned with the production recap cadence. Emotion
  // changes emphasis, not the underlying pace; slow metadata otherwise nudges
  // voice plans toward long pauses that the final narration should not contain.
  if (hasDialogue && hasNarration) wpm = 195;
  else if (hasDialogue) wpm = 200;
  else if (/\b(SYSTEM|NOTICE|WARNING|UI)\b/.test(speakerText) || /system|warning/.test(modeText)) wpm = 205;
  else wpm = 215;

  if (/comedy|dry humor|urgent|panic|escalation|attack|monster|countdown/.test(modeText)) {
    wpm = Math.max(wpm, hasDialogue ? 205 : 215);
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
      if (top[0] === "medium" && (/\b(silence|pause|held breath|extended stillness)\b/.test(text) || wordCount <= 4)) {
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
  if (/\bemphasis\b/.test(context)) return ["[focused emphasis]", "[controlled emphasis]", "[tense emphasis]", "[sharp emphasis]"];
  if (/\blow voice\b/.test(context)) return ["[low, tense]", "[low, controlled]", "[low, shaken]", "[low, urgent]"];
  if (/\bsoft\b/.test(context)) return ["[soft, careful]", "[soft, worried]", "[soft, restrained]", "[soft, tense]"];
  if (/\bnervous\b/.test(context)) return ["[nervous, quick]", "[nervous, breath held]", "[nervous, trying to stay calm]"];
  if (!clean) return ["[focused]", "[controlled]", "[tense]"];
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
  const isSystemPerformanceUnit = (unit) => (
    (unit?.kind === "dialogue" || unit?.kind === "system_ui")
    && /^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit?.speaker ?? ""))
  );
  function currentSpeakerSwitchCount() {
    return current.filter((unit) => unit.kind === "dialogue" || unit.kind === "performance_action" || unit.kind === "system_ui").length;
  }
  function currentHasDialogue() {
    return current.some((unit) => unit.kind === "dialogue" || unit.kind === "performance_action" || unit.kind === "system_ui");
  }
  function currentHasInternal() {
    return current.some((unit) => unit.kind === "mc_internal");
  }
  function currentHasNarration() {
    return current.some((unit) => unit.kind === "narration");
  }
  function currentHasSystemDialogue() {
    return current.some(isSystemPerformanceUnit);
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
    return unit.kind === "dialogue" || unit.kind === "performance_action" || unit.kind === "system_ui" ? "dialogue" : unit.kind;
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
    const hasDialogue = speakable.some((unit) => unit.kind === "dialogue" || unit.kind === "performance_action" || unit.kind === "system_ui");
    const hasInternal = speakable.some((unit) => unit.kind === "mc_internal");
    const hasNarration = speakable.some((unit) => unit.kind === "narration");
    const explicitPerformanceSpeaker = hasInternal
      ? "MC_INTERNAL"
      : hasDialogue && !hasNarration
        ? speakers.find((speaker) => speaker !== "NARRATOR")
        : null;
    const detectedMode = detectMode(body, explicitPerformanceSpeaker);
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
      dialogue_turn_count: current.filter((unit) => unit.kind === "dialogue" || unit.kind === "performance_action" || unit.kind === "system_ui").length,
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
    const nextIsPerformance = unit.kind === "dialogue" || unit.kind === "performance_action" || unit.kind === "mc_internal" || unit.kind === "system_ui";
    const nextIsNarration = unit.kind === "narration";
    const nextIsSoundDesign = unit.kind === "sound_design";
    const nextIsSystemDialogue = isSystemPerformanceUnit(unit);
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
    const shouldFlushForDialogueTurn = (unit.kind === "dialogue" || unit.kind === "system_ui") && currentWords >= targetWordMin;
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

export function minimumPauseEventsForProfile(contentProfile = {}, {
  isTestSlice = false,
  maxDurationSec: durationLimitSec = null,
} = {}) {
  const configured = contentProfile?.voice?.longform_minimum_pause_events;
  const longformMinimum = Number.isInteger(configured) && configured >= 0 ? configured : 2;
  if (isTestSlice && durationLimitSec <= 45) return 0;
  if (isTestSlice && durationLimitSec < 90) return Math.min(1, longformMinimum);
  return longformMinimum;
}

function qualityReport(segments, {
  ttsProvider = "qwen_local",
  contentProfile = {},
} = {}) {
  const unitBasedNarrator = isUnitBasedNarratorProvider(ttsProvider);
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
  const spokenLabelSegments = voicedSegments.filter((segment) => {
    if (!containsSpokenSpeakerLabel(segment.text)) return false;
    const speakableUnits = (segment.performance_units ?? []).filter((unit) => unit.kind !== "sound_design");
    const onlyApprovedSystemUi = speakableUnits.length > 0 && speakableUnits.every((unit) => (
      unit.kind === "system_ui"
      && /^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit.speaker ?? ""))
    ));
    return !onlyApprovedSystemUi;
  });
  const screenplayMarkerSegments = voicedSegments.filter((segment) => containsScreenplayMarkerLeak(segment.text));
  const unknownDialogueSegments = voicedSegments.filter((segment) => (segment.performance_units ?? []).some((unit) => unit.kind === "dialogue" && /UNKNOWN_DIALOGUE/i.test(unit.speaker ?? "")));
  const pausePrimaryTagSegments = voicedSegments.filter((segment) => isPauseOnlyTag(segment.tag));
  const leadingPauseBeforePerformance = voicedSegments.filter((segment) => /^\s*\[(?:short\s+pause|pause|long\s+pause|micro-pause)\]\s+\[[^\]]+\]/i.test(segment.text ?? ""));
  const oversizedMixedDialogueSegments = voicedSegments.filter((segment) =>
    (segment.dialogue_turn_count ?? 0) > 0
    && (words(segment.stripped_text ?? "").length > 68 || Number(segment.expected_duration_sec ?? 0) > 24)
  );
  const buriedSystemNoticeSegments = voicedSegments.filter((segment) => {
    const hasSystem = (segment.performance_units ?? []).some((unit) => (
      (unit.kind === "dialogue" || unit.kind === "system_ui")
      && /^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit.speaker ?? ""))
    ));
    if (!hasSystem) return false;
    const nonSystemDialogueCount = (segment.performance_units ?? []).filter((unit) => (
      (unit.kind === "dialogue" || unit.kind === "system_ui")
      && !/^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit.speaker ?? ""))
    )).length;
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
  const shortProofSegmentCount = voicedSegments.length <= 40;
  const mediumProofSegmentCount = voicedSegments.length <= 60;
  const minUniqueTags = isTestSlice && maxDurationSec <= 45 ? 3 : isTestSlice && maxDurationSec < 90 ? 5 : shortProofSegmentCount ? 5 : mediumProofSegmentCount ? 6 : 8;
  const maxTopTagPct = isTestSlice && maxDurationSec <= 45 ? 50 : isTestSlice && maxDurationSec < 90 ? 42 : shortProofSegmentCount ? 45 : mediumProofSegmentCount ? 40 : 35;
  const minPhysicalTags = isTestSlice && maxDurationSec <= 45 ? 0 : isTestSlice && maxDurationSec < 90 ? 1 : 2;
  if (Object.keys(counts).length < minUniqueTags) failures.push({ code: "too_few_unique_tags", severity: "blocker", min_unique_tags: minUniqueTags });
  if (topPct > maxTopTagPct) failures.push({
    code: "top_tag_overused",
    severity: unitBasedNarrator ? "warning" : "blocker",
    tag: top[0],
    pct: Number(topPct.toFixed(2)),
    max_pct: maxTopTagPct,
  });
  if (maxRun >= 5) failures.push({ code: "same_tag_repeats_5_plus", severity: "blocker" });
  if (physicalTags < minPhysicalTags) failures.push({ code: "too_few_physical_tags", severity: "blocker", min_physical_tags: minPhysicalTags });
  if (physicalTags > Math.ceil(voicedSegments.length * 0.45)) failures.push({ code: "too_many_physical_tags", severity: "warning" });
  const minPauseEvents = minimumPauseEventsForProfile(contentProfile, {
    isTestSlice,
    maxDurationSec,
  });
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
      code: unitBasedNarrator ? "mixed_dialogue_segment_uses_unit_stitch" : "oversized_mixed_dialogue_fish_segment",
      severity: unitBasedNarrator ? "warning" : "blocker",
      segment_ids: oversizedMixedDialogueSegments.map((segment) => segment.segment_id),
      reason: unitBasedNarrator
        ? "The active local narrator provider generates and stitches bounded performance units, so mixed narrator/dialogue segments are allowed only when narration_generation_units preserve setup, line, reaction, and follow-up beats."
        : "Fish S2-Pro performs dialogue and narrator shifts better in compact context-rich beats. Long mixed segments cause voice bleed and muddy dialogue.",
      suggested_fix: unitBasedNarrator
        ? "Verify narration_generation_plan.json has clean, sentence-bounded units and provider-appropriate controls for every mixed segment before local synthesis."
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
      severity: unitBasedNarrator ? "warning" : "blocker",
      tempo: topTempo[0],
      pct: Number(topTempoPct.toFixed(2)),
      reason: unitBasedNarrator
        ? "More than 60% of local narrator units share one pacing label. This is diagnostic because recap narration may intentionally sustain a fast provider-native cadence; emotional variation must come from emphasis rather than forced slow tags."
        : "More than 60% of audio segments share one pacing tempo; the episode is likely flat or rushed.",
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
    pause_event_policy: {
      content_profile: contentProfile?.id ?? null,
      longform_minimum_pause_events: Number.isInteger(contentProfile?.voice?.longform_minimum_pause_events)
        ? contentProfile.voice.longform_minimum_pause_events
        : 2,
      effective_minimum_pause_events: minPauseEvents,
    },
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
    auto_repair_policy: unitBasedNarrator
      ? "Preserve exact story/caption text, keep TTS spoken text clean, and repair narration_generation_units or provider controls before local synthesis."
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

function integerToSpokenWords(value) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isSafeInteger(number) || number < 0) return String(value ?? "");
  if (number < 21) return numberWord(number);
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const teens = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const underThousand = (amount) => {
    if (amount < 10) return ones[amount];
    if (amount < 20) return teens[amount - 10];
    if (amount < 100) return `${tens[Math.floor(amount / 10)]}${amount % 10 ? `-${ones[amount % 10]}` : ""}`;
    const remainder = amount % 100;
    return `${ones[Math.floor(amount / 100)]} hundred${remainder ? ` and ${underThousand(remainder)}` : ""}`;
  };
  if (number < 1_000) return underThousand(number);
  const scales = [[1_000_000_000, "billion"], [1_000_000, "million"], [1_000, "thousand"]];
  const parts = [];
  let remainder = number;
  for (const [scale, label] of scales) {
    if (remainder < scale) continue;
    const count = Math.floor(remainder / scale);
    parts.push(`${integerToSpokenWords(count)} ${label}`);
    remainder %= scale;
  }
  if (remainder) parts.push(underThousand(remainder));
  return parts.join(" ");
}

function numberToSpokenWords(value) {
  const normalized = String(value ?? "").replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return String(value ?? "");
  const [whole, decimal] = normalized.split(".");
  const wholeWords = integerToSpokenWords(whole);
  if (!decimal) return wholeWords;
  return `${wholeWords} point ${[...decimal].map((digit) => numberWord(digit)).join(" ")}`;
}

function clockTimeToSpokenWords(hour, minute, meridiem) {
  const hourWords = integerToSpokenWords(hour);
  const minuteNumber = Number(minute);
  const minuteWords = minuteNumber === 0
    ? ""
    : minuteNumber < 10
      ? `oh ${numberWord(minuteNumber)}`
      : integerToSpokenWords(minuteNumber);
  const meridiemWords = String(meridiem ?? "").toUpperCase() === "AM" ? "A M" : "P M";
  return [hourWords, minuteWords, meridiemWords].filter(Boolean).join(" ");
}

function normalizeOrdinaryAllCapsForTts(value) {
  // Kokoro may interpret ordinary all-caps UI words as initialisms (for
  // example CROWNS -> C R O W N S). Approved initialisms have already been
  // expanded into separated single letters before this runs, so case-fold
  // every remaining multi-letter all-caps token for the spoken layer only.
  return String(value ?? "").replace(/\b[A-Z][A-Z0-9']+\b/g, (token) => (
    `${token[0]}${token.slice(1).toLowerCase()}`
  ));
}

function qwenPronunciationText(value) {
  const preserveInitialCase = (replacement) => (match) => /^[A-Z]/.test(match) ? `${replacement[0].toUpperCase()}${replacement.slice(1)}` : replacement;
  const normalized = String(value ?? "")
    .replace(/\b(\d{1,2}):([0-5]\d)\s*([AP])\.?M\.?(?=\s|[,;!?]|$)/gi, (_match, hour, minute, marker) => (
      clockTimeToSpokenWords(hour, minute, `${marker}M`)
    ))
    .replace(/\b(\d{1,2})([0-5]\d)\s*([AP])\.?M\.?(?=\s|[,;!?]|$)/gi, (_match, hour, minute, marker) => (
      Number(hour) >= 1 && Number(hour) <= 12
        ? clockTimeToSpokenWords(hour, minute, `${marker}M`)
        : _match
    ))
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
    .replace(/\bCEO\b/g, "C E O")
    .replace(/\bCFO\b/g, "C F O")
    .replace(/\bCOO\b/g, "C O O")
    .replace(/\bCTO\b/g, "C T O")
    .replace(/\bCIO\b/g, "C I O")
    .replace(/\bCMO\b/g, "C M O")
    .replace(/\bHR\b/g, "H R")
    .replace(/\bPR\b/g, "P R")
    .replace(/\bAI\b/g, "A I")
    .replace(/\bUI\b/g, "U I")
    .replace(/\bUX\b/g, "U X")
    .replace(/\bAPI\b/g, "A P I")
    .replace(/\bFBI\b/g, "F B I")
    .replace(/\bNYPD\b/g, "N Y P D")
    .replace(/\bIRS\b/g, "I R S")
    .replace(/\bSEC\b/g, "S E C")
    .replace(/\bNDA\b/g, "N D A")
    .replace(/\bLLC\b/g, "L L C")
    .replace(/\bIPO\b/g, "I P O")
    .replace(/\bIT(?=\s+(?:DEPARTMENT|TEAM|STAFF|SUPPORT|INFRASTRUCTURE|SYSTEMS?|NETWORK|SECURITY|OPERATIONS?|ADMIN(?:ISTRATOR)?|TECHNICIAN|DIRECTOR|MANAGER|SPECIALIST|SERVICES?)\b)/g, "I T")
    .replace(/\b(?:WORKS?|WORKED|CAREER|JOB)\s+(?:IN|WITH)\s+IT\b/g, (match) => match.replace(/\bIT\b/, "I T"))
    .replace(/\bDNA\b/g, "D N A")
    .replace(/\bGPS\b/g, "G P S")
    .replace(/\bUSB\b/g, "U S B")
    .replace(/\bPDF\b/g, "P D F")
    .replace(/\bURL\b/g, "U R L")
    .replace(/\bVIP\b/g, "V I P")
    .replace(/\bID\b/g, "I D")
    .replace(/\bMC\b/g, "M C")
    .replace(/\bLevel\s*[-:]\s*-\s*(\d{1,2})\b/gi, (_match, level) => `Level negative ${numberWord(level)}`)
    .replace(/\bLevel\s+-\s*(\d{1,2})\b/gi, (_match, level) => `Level negative ${numberWord(level)}`)
    .replace(/:\s*-\s*(\d{1,2})\b/g, (_match, value) => `, negative ${numberWord(value)}`)
    .replace(/\b(\d[\d,]*)\s*x\b/gi, (_match, multiplier) => (
      Number(String(multiplier).replace(/,/g, "")) === 0
        ? "zero times"
        : `${integerToSpokenWords(multiplier)} times`
    ))
    .replace(/\b(\d[\d,]*(?:\.\d+)?)\s*\/\s*(\d[\d,]*(?:\.\d+)?)\b/g, (_match, left, right) => `${numberToSpokenWords(left)} out of ${numberToSpokenWords(right)}`)
    .replace(/\b(\d[\d,]*(?:\.\d+)?)%/g, (_match, number) => `${numberToSpokenWords(number)} percent`)
    .replace(/\b\d[\d,]*(?:\.\d+)?\b/g, (number) => numberToSpokenWords(number))
    .replace(/\s+/g, " ")
    .trim();
  return normalizeOrdinaryAllCapsForTts(normalized);
}

function qwenSpokenText(value, speaker = "", ttsOverrides = {}) {
  return qwenSpokenTextDetailed(value, speaker, ttsOverrides).text;
}

function stripBalancedOuterDialogueQuotes(value) {
  const text = String(value ?? "").trim();
  const pairs = new Map([['"', '"'], ["“", "”"]]);
  return pairs.get(text[0]) === text.at(-1) ? text.slice(1, -1).trim() : text;
}

function qwenSpokenTextDetailed(value, speaker = "", ttsOverrides = {}) {
  const clean = stripBalancedOuterDialogueQuotes(String(value ?? "")
    .replace(/<\|speaker:\d+\|>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
  const replacementResult = applySpokenOverrideRulesWithAudit(clean, ttsOverrides.replacements ?? []);
  const overridden = applyPronunciationMap(
    replacementResult.text,
    ttsOverrides.pronunciation_map ?? [],
  ).replace(/\[[^\]]+\]/g, " ").replace(/\s+/g, " ").trim();
  const normalized = qwenPronunciationText(overridden);
  return { text: normalized, applied_replacements: replacementResult.applied };
}

export function voiceDirectionTransformForTests(value, { speaker = "", ttsOverrides = {} } = {}) {
  const clean = cleanNarrationAttribution(String(value ?? "").trim());
  const paragraphUnitRows = paragraphUnits(String(value ?? ""), {}, {}, {})
    .filter((unit) => unit.kind !== "segment_boundary")
    .map((unit) => ({
      kind: unit.kind,
      speaker: unit.speaker,
      text: unit.text,
      performed_text: unit.performed_text,
      caption_text: unit.caption_text,
    }));
  return {
    clean_narration_attribution: clean,
    qwen_spoken_text: qwenSpokenText(clean, speaker, ttsOverrides),
    paragraph_units: paragraphUnitRows,
  };
}

export function qwenGenerationPlanForTests(segments, {
  ttsOverrides = {},
  ttsProvider = "qwen_local",
  actionableDirectionArtifact = null,
  sourceScriptSha256 = null,
} = {}) {
  return buildQwenGenerationPlan(
    segments,
    {},
    {},
    ttsProvider,
    ttsOverrides,
    undefined,
    actionableDirectionArtifact,
    sourceScriptSha256,
  );
}

export function applyActionableNarrationDirectionForTests({
  atomicUnits,
  artifact,
  sourceScriptSha256,
  providerContext,
} = {}) {
  return applyActionableNarrationDirection(
    atomicUnits,
    artifact,
    sourceScriptSha256,
    providerContext,
  );
}

export function buildExactSpokenPlanForDiagnostics(
  script,
  { ttsOverrides = {}, ttsProvider = "supertonic_local", dialogueContext = {} } = {},
) {
  const segments = buildSegments(String(script ?? ""), palette(), {}, dialogueContext);
  const plan = buildQwenGenerationPlan(segments, {}, dialogueContext, ttsProvider, ttsOverrides);
  const sourceScriptHash = sha256Text(script);
  const textIntegrityCoverage = qwenTextIntegrityCoverageForTests(script, plan, {
    ttsOverrides,
    dialogueContext,
  });
  const systemUiSpeechCoverage = systemUiSpeechCoverageForTests(script, plan, dialogueContext);
  plan.source_script_hash = sourceScriptHash;
  plan.text_integrity_coverage = textIntegrityCoverage;
  plan.system_ui_speech_coverage = systemUiSpeechCoverage;
  plan.status = textIntegrityCoverage.status === "passed"
    && systemUiSpeechCoverage.status === "passed"
    && plan.kokoro_unit_boundary_integrity?.status !== "blocked"
    ? "passed"
    : "blocked";
  return {
    status: plan.status,
    source_script_hash: sourceScriptHash,
    segments,
    plan,
    text_integrity_coverage: textIntegrityCoverage,
    system_ui_speech_coverage: systemUiSpeechCoverage,
  };
}

export function voiceDirectionMetadataForTests(texts) {
  const tags = { universal_recipes: {}, proven_core_tags: {} };
  return texts.map((text, index) => {
    const deliveryMode = detectMode(String(text ?? ""));
    const performanceTag = universalTagForMode(deliveryMode, String(text ?? ""), tags, index);
    const physicalTag = physicalCueFor(deliveryMode, index, tags, String(text ?? ""));
    const pauseTag = pauseForMode(deliveryMode, index);
    const expectedDurationSec = expectedFishDurationSec(String(text ?? ""), {
      mode: deliveryMode,
      hasNarration: true,
      speakers: ["NARRATOR"],
      pause: pauseTag,
      physical: physicalTag,
    });
    return {
      delivery_mode: deliveryMode,
      performance_tag: performanceTag,
      physical_tag: physicalTag,
      pause_tag: pauseTag,
      pacing_tempo: classifyTempo(String(text ?? ""), expectedDurationSec, deliveryMode),
    };
  });
}

function isSpeakableQwenText(value) {
  return /[\p{L}\p{N}]/u.test(String(value ?? ""));
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
  if (unit?.kind === "mc_internal" || /^MC_INTERNAL$/i.test(String(unit?.speaker ?? ""))) return "close internal monologue near 210-215 spoken words per minute, controlled and direct, with no theatrical pause";
  if (/^(SYSTEM|NOTICE|WARNING|UI)$/i.test(String(unit?.speaker ?? ""))) return "precise interface cadence near 205-215 spoken words per minute, clear on letter ranks and warnings, with no long pauses";
  if (unit?.kind === "dialogue" || unit?.kind === "performance_action") return "tight speaker turn near 205-215 spoken words per minute, conversational but clipped, with no long lead-in or tail";
  return "forward anime recap narration around 215 spoken words per minute, energetic and clean, with clean sentence endings and no slow dramatic gaps";
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
    "Pacing priority: preserve the target cadence on tender, fearful, system, and cliffhanger beats; express emotion through emphasis and tone rather than silence, whispering, or extended pauses.",
    "Pronunciation: spell letter ranks and UI abbreviations as separated letters when needed, for example SSS is spoken as S S S.",
    "Do not say stage directions. Do not add bracket tags. Do not add words. Do not add a foreign accent. Do not stutter, repeat syllables, repeat words, add filler sounds, or invent breath noises. Stop cleanly after the final word. Preserve exact text except approved pronunciation normalization.",
  ].join(" ");
}

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function puckQwenFallbackIdentityControls() {
  return {
    target_voice_id: QWEN_LOCAL_FALLBACK_LOCK.reference_voice_id,
    target_voice_sha256: QWEN_LOCAL_FALLBACK_LOCK.reference_voice_sha256,
    reference_audio_path: QWEN_LOCAL_FALLBACK_LOCK.reference_audio_path,
    reference_audio_sha256: QWEN_LOCAL_FALLBACK_LOCK.reference_audio_sha256,
    reference_transcript_path: QWEN_LOCAL_FALLBACK_LOCK.reference_text_path,
    reference_transcript_sha256: QWEN_LOCAL_FALLBACK_LOCK.reference_text_sha256,
    reference_transcript_file_sha256: QWEN_LOCAL_FALLBACK_LOCK.reference_text_file_sha256,
    reference_metadata_path: QWEN_LOCAL_FALLBACK_LOCK.reference_metadata_path,
    reference_metadata_sha256: QWEN_LOCAL_FALLBACK_LOCK.reference_metadata_sha256,
    voice_continuity_contract: QWEN_LOCAL_FALLBACK_LOCK.voice_continuity_contract,
    speaker_similarity_method: QWEN_LOCAL_FALLBACK_LOCK.speaker_similarity_method,
    speaker_similarity_model_path: QWEN_LOCAL_FALLBACK_LOCK.speaker_similarity_model_path,
    speaker_similarity_model_sha256: QWEN_LOCAL_FALLBACK_LOCK.speaker_similarity_model_sha256,
    hard_minimum_cosine_similarity: QWEN_LOCAL_FALLBACK_LOCK.minimum_cosine_similarity,
    warning_floor_cosine_similarity: QWEN_LOCAL_FALLBACK_LOCK.warning_floor_cosine_similarity ?? 0.90,
    fallback_scope: "exact_failed_unit_only",
    exact_unit_only: true,
    whole_episode_fallback_allowed: false,
  };
}

function qwenLiamPrimaryIdentityControls(
  synthesisContract = QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT,
  voiceLock = QWEN_JOEL_PRIMARY_LOCK,
) {
  return {
    model_id: voiceLock.model_id,
    model_revision: voiceLock.model_revision,
    target_voice_id: voiceLock.voice_id,
    target_voice_sha256: voiceLock.voice_sha256,
    reference_audio_path: voiceLock.reference_audio_path,
    reference_audio_sha256: voiceLock.reference_audio_sha256,
    reference_text: voiceLock.reference_text,
    reference_text_sha256: voiceLock.reference_text_sha256,
    reference_transcript: voiceLock.reference_text,
    reference_transcript_sha256: voiceLock.reference_text_sha256,
    reference_manifest_path: voiceLock.reference_manifest_path,
    reference_manifest_sha256: voiceLock.reference_manifest_sha256,
    reference_metadata_path: voiceLock.reference_metadata_path,
    reference_metadata_sha256: voiceLock.reference_metadata_sha256,
    reference_voice_id: voiceLock.reference_voice_id,
    reference_voice_sha256: voiceLock.reference_voice_sha256,
    voice_continuity_contract: voiceLock.voice_continuity_contract,
    speaker_similarity_method: voiceLock.speaker_similarity_method,
    speaker_similarity_model_path: voiceLock.speaker_similarity_model_path,
    speaker_similarity_model_sha256:
      voiceLock.speaker_similarity_model_sha256,
    hard_minimum_cosine_similarity:
      voiceLock.minimum_cosine_similarity,
    warning_floor_cosine_similarity:
      voiceLock.warning_floor_cosine_similarity,
    delivery_control: "base_icl_reference_audio_only",
    instruct_supported: false,
    instruct_submitted: false,
    instruct: null,
    speed_control_supported: false,
    native_speed: null,
    continuous_requests: false,
    synthesis_contract: synthesisContract,
    unit_contract: voiceLock.unit_contract,
    stitch_contract: voiceLock.stitch_contract,
  };
}

function providerPlanContext(runIdentity = {}, providerRouting = {}, ttsProvider = "qwen_local") {
  const provider = normalizeTtsProvider(ttsProvider) ?? "qwen_local";
  const voiceOptions = runIdentity?.voice_provider_options ?? {};
  const primary = voiceOptions?.primary ?? {};
  const fallback = voiceOptions?.fallback ?? {};
  const fallbackProvider = normalizeTtsProvider(
    runIdentity?.tts_fallback_provider
      ?? runIdentity?.fallback_tts_provider
      ?? fallback?.provider
      ?? voiceOptions?.fallback_tts_provider
      ?? providerRouting?.audio?.fallback_tts_provider
      ?? (provider === "kokoro_local" ? "qwen_local" : null),
  );
  const kokoroVoice = cleanVoiceId(
    primary?.voice_id
      ?? primary?.voice
      ?? runIdentity?.tts_voice_id
      ?? runIdentity?.narrator_voice_id
      ?? voiceOptions?.kokoro_voice_id
      ?? voiceOptions?.narrator_voice_id,
  ) ?? "am_puck";
  const kokoroSpeed = finitePositive(
    primary?.native_speed
      ?? runIdentity?.tts_native_speed
      ?? voiceOptions?.tts_native_speed
      ?? voiceOptions?.kokoro_native_speed,
    1.2,
  );
  if (provider === "kokoro_local" && kokoroVoice !== QWEN_LOCAL_FALLBACK_LOCK.reference_voice_id) {
    throw new Error(`New Kokoro narration plans are Puck-only: expected ${QWEN_LOCAL_FALLBACK_LOCK.reference_voice_id}, got ${kokoroVoice}. Other presets are bakeoff-only.`);
  }
  const puckQwenFallback = provider === "kokoro_local" && fallbackProvider === "qwen_local";
  const requestedQwenVoiceId = cleanVoiceId(
      primary?.voice_id
        ?? runIdentity?.narrator_voice_id
        ?? runIdentity?.tts_voice_id,
    ) ?? QWEN_JOEL_PRIMARY_LOCK.voice_id;
  const qwenPrimary = provider === "qwen_local"
    && [QWEN_JOEL_PRIMARY_LOCK.voice_id, QWEN_LIAM_PRIMARY_LOCK.voice_id].includes(requestedQwenVoiceId);
  const requestedReferenceVariantId = cleanVoiceId(
    primary?.reference_variant_id
      ?? runIdentity?.provider_locks?.primary_reference_variant_id,
  );
  const qwenPrimaryLock = qwenPrimaryLockForVoiceId(
    requestedQwenVoiceId,
    requestedReferenceVariantId,
  );
  if (provider === "qwen_local" && !qwenPrimary) {
    throw new Error(
      `Local Qwen narration plans require an approved narrator voice; got ${requestedQwenVoiceId}.`,
    );
  }
  if (provider === "qwen_local" && fallbackProvider) {
    throw new Error("Qwen production uses one provider and one voice; fallback must be null.");
  }
  const synthesisContract = qwenPrimary
    ? voiceOptions.synthesis_contract ?? QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT
    : null;
  if (qwenPrimary && ![
    QWEN_LIAM_SERIAL_SYNTHESIS_CONTRACT,
    QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT,
  ].some((contract) => (
    JSON.stringify(contract) === JSON.stringify(synthesisContract)
  ))) {
    throw new Error(
      "Qwen Liam synthesis contract is neither the legacy serial lock nor "
      + "the approved deterministic batch-four lock.",
    );
  }
  return {
    primary_provider: provider,
    fallback_provider: fallbackProvider,
    kokoro: {
      provider: "kokoro_local",
      enabled: provider === "kokoro_local",
      voice: kokoroVoice,
      voice_id: kokoroVoice,
      lang_code: String(primary?.lang_code ?? primary?.language_code ?? "a"),
      native_speed: kokoroSpeed,
      model_id: primary?.model_id ?? runIdentity?.tts_model ?? voiceOptions?.kokoro_model_id ?? "mlx-community/Kokoro-82M-bf16",
      model_revision: primary?.model_revision ?? runIdentity?.tts_model_revision ?? voiceOptions?.kokoro_model_revision ?? null,
      runtime: primary?.runtime ?? voiceOptions?.kokoro_runtime ?? "mlx-audio",
      runtime_version: primary?.runtime_version ?? voiceOptions?.kokoro_runtime_version ?? null,
      accepts_instruction: false,
      instruction_submitted: false,
      narrator_only: true,
    },
    qwen3: {
      provider: "qwen_local",
      enabled: provider === "qwen_local",
      fallback: puckQwenFallback,
      language: "English",
      temperature: qwenPrimaryLock.temperature,
      top_p: qwenPrimaryLock.top_p,
      top_k: qwenPrimaryLock.top_k,
      repetition_penalty: qwenPrimaryLock.repetition_penalty,
      max_tokens: qwenPrimaryLock.max_tokens,
      ...(qwenPrimary
        ? qwenLiamPrimaryIdentityControls(synthesisContract, qwenPrimaryLock)
        : {}),
      ...(puckQwenFallback ? {
        delivery_control: "base_icl_reference_audio_only",
        instruct_supported: false,
        instruct_submitted: false,
        instruct: null,
        ...puckQwenFallbackIdentityControls(),
      } : {}),
    },
  };
}

function protectedTermsForUnit(sourceText, spokenText, ttsOverrides = {}, appliedReplacements = []) {
  const source = String(sourceText ?? "");
  const terms = [];
  const addMatches = (pattern) => {
    for (const match of source.matchAll(pattern)) {
      const value = String(match[0] ?? "").trim();
      if (value) terms.push(value);
    }
  };
  addMatches(/[$£€¥]\s*\d[\d,]*(?:\.\d+)?/g);
  addMatches(/\b\d[\d,]*(?:\.\d+)?(?:%|[xX])?\b/g);
  addMatches(/\b(?:SSS|SS|XP|HP|MP|DPS|AOE|CEO|CFO|COO|CTO|CIO|CMO|HR|PR|AI|UI|UX|API|FBI|NYPD|IRS|SEC|NDA|LLC|IPO|IT|DNA|GPS|USB|PDF|URL|VIP|ID|MC)(?:\s*[- ]\s*rank)?\b/g);
  for (const entry of ttsOverrides.pronunciation_map ?? []) {
    if (!entry?.term) continue;
    const pattern = new RegExp(entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (pattern.test(source)) terms.push(String(entry.term));
  }
  for (const applied of appliedReplacements ?? []) {
    if (applied?.to) terms.push(String(applied.to));
  }
  if (/^(?:SYSTEM|NOTICE|WARNING|UI)\b/i.test(source)) {
    const label = source.match(/^[A-Z][A-Z0-9 _'’. -]{1,80}(?=:)/)?.[0];
    if (label) terms.push(label.trim());
  }
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}

function riskFlagsForUnit({ unit, sourceText, spokenText, protectedTerms, appliedReplacements }) {
  const flags = [];
  const sourceSpeaker = String(unit?.speaker ?? "NARRATOR");
  const kind = String(unit?.kind ?? "narration");
  const wordTotal = words(spokenText).length;
  if (/^(?:SYSTEM|NOTICE|WARNING|UI)$/i.test(sourceSpeaker) || kind === "system_ui") flags.push("system_ui_atomic");
  if (kind !== "narration") flags.push("speaker_or_performance_turn");
  if (wordTotal <= 4) flags.push("very_short_unit");
  if (wordTotal > 50) flags.push("long_unit");
  if (protectedTerms.length) flags.push("protected_term_or_value");
  if ((appliedReplacements ?? []).length) flags.push("tts_override_applied");
  if (/["“”]/u.test(sourceText)) flags.push("quoted_speech");
  if (/[…]|--|—/u.test(sourceText)) flags.push("complex_punctuation");
  if (/\b(?:live|content|read|lead|wind|tear|close|minute)\b/i.test(sourceText)) flags.push("homograph_risk");
  if (/\b([\p{L}']+)(?:[\s,]+\1)\b/iu.test(sourceText)) flags.push("approved_repetition");
  return [...new Set(flags)];
}

function stableNarrationUnitId(segmentId, sourceUnitRefs = []) {
  const refs = (sourceUnitRefs ?? []).map((ref) => ({
    segment_id: String(ref?.segment_id ?? segmentId ?? ""),
    unit_index: Number(ref?.unit_index),
    kind: String(ref?.kind ?? "narration"),
    source_speaker: String(ref?.source_speaker ?? "NARRATOR"),
    source_text_sha256: String(ref?.source_text_sha256 ?? ""),
    caption_text_sha256: String(ref?.caption_text_sha256 ?? ""),
  }));
  const firstIndex = refs[0]?.unit_index ?? 0;
  const finalIndex = refs.at(-1)?.unit_index ?? firstIndex;
  const sourceRange = firstIndex === finalIndex
    ? `u${String(firstIndex).padStart(3, "0")}`
    : `u${String(firstIndex).padStart(3, "0")}-${String(finalIndex).padStart(3, "0")}`;
  const segmentSlug = String(segmentId ?? "segment")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `narr_${segmentSlug}_${sourceRange}_${sha256Text(JSON.stringify(refs)).slice(0, 12)}`;
}

function sourceUnitHasExplicitMergeBarrier(unit = {}) {
  const metadataTags = Array.isArray(unit?.metadata_tags) ? unit.metadata_tags : [];
  return unit?.merge_barrier === true
    || unit?.do_not_merge === true
    || unit?.atomic === true
    || Boolean(unit?.boundary_before)
    || Boolean(unit?.boundary_after)
    || metadataTags.some((tag) => /^(?:MERGE_BARRIER|ATOMIC|DO_NOT_MERGE)$/i.test(String(tag ?? "")));
}

function kokoroNarrationGroupCost(wordCount) {
  if (wordCount < 24) return 85 + (24 - wordCount) * 6;
  if (wordCount <= 46) return 5 + Math.abs(36 - wordCount) * 0.35;
  return 35 + (wordCount - 46) * 4;
}

function partitionKokoroNarrationRun(rows) {
  const count = rows.length;
  if (count <= 1) return count ? [rows] : [];
  const best = Array(count + 1).fill(null);
  best[count] = { cost: 0, groups: [] };
  for (let start = count - 1; start >= 0; start -= 1) {
    let wordCount = 0;
    for (let end = start; end < count; end += 1) {
      wordCount += Number(rows[end]?.word_count ?? 0);
      const oneUnavoidablyLongSourceUnit = end === start && wordCount > 54;
      if (wordCount > 54 && !oneUnavoidablyLongSourceUnit) break;
      const tail = best[end + 1];
      if (!tail) continue;
      const candidate = {
        cost: kokoroNarrationGroupCost(wordCount) + tail.cost,
        groups: [rows.slice(start, end + 1), ...tail.groups],
      };
      const current = best[start];
      if (!current
        || candidate.cost < current.cost - 1e-9
        || (Math.abs(candidate.cost - current.cost) <= 1e-9 && candidate.groups.length < current.groups.length)) {
        best[start] = candidate;
      }
      if (oneUnavoidablyLongSourceUnit) break;
    }
  }
  return best[0]?.groups ?? rows.map((row) => [row]);
}

function mergeKokoroNarrationRows(rows, segment, providerContext) {
  if (rows.length === 1) {
    return {
      ...rows[0],
      grouped_source_unit_count: 1,
      grouping_policy: "kokoro_safe_adjacent_narration_v1",
    };
  }
  const first = rows[0];
  const sourceUnitRefs = rows.flatMap((row) => row.source_unit_refs ?? []);
  const sourceText = rows.map((row) => row.source_text).filter(Boolean).join(" ").trim();
  const captionText = rows.map((row) => row.caption_text).filter(Boolean).join(" ").trim();
  const spokenText = rows.map((row) => row.spoken_text).filter(Boolean).join(" ").trim();
  const appliedReplacements = rows.flatMap((row) => row.tts_override_replacements_applied ?? []);
  const protectedTerms = [...new Set(rows.flatMap((row) => row.protected_terms ?? []).filter(Boolean))];
  const sourceSpeaker = first.source_speaker ?? "NARRATOR";
  const fallbackInstruction = qwenInstructForUnit({
    segment,
    unit: { kind: "narration", speaker: sourceSpeaker, text: sourceText },
    role: first.role,
    cast: null,
  });
  const riskFlags = riskFlagsForUnit({
    unit: { kind: "narration", speaker: sourceSpeaker },
    sourceText,
    spokenText,
    protectedTerms,
    appliedReplacements,
  });
  const merged = {
    ...first,
    unit_id: stableNarrationUnitId(segment.segment_id, sourceUnitRefs),
    source_unit_index: sourceUnitRefs[0]?.unit_index ?? first.source_unit_index,
    source_unit_end_index: sourceUnitRefs.at(-1)?.unit_index ?? first.source_unit_index,
    source_unit_refs: sourceUnitRefs,
    source_segment_ids: [...new Set(sourceUnitRefs.map((ref) => ref.segment_id).filter(Boolean))],
    source_text: sourceText,
    source_text_sha256: sha256Text(sourceText),
    caption_text: captionText,
    caption_text_sha256: sha256Text(captionText),
    spoken_text: spokenText,
    tts_spoken_text: spokenText,
    qwen_spoken_text: spokenText,
    spoken_text_sha256: sha256Text(spokenText),
    word_count: words(spokenText).length,
    risk_flags: [...new Set(["grouped_narration_unit", ...riskFlags])],
    protected_tokens: protectedTerms,
    protected_terms: protectedTerms,
    merge_barrier: false,
    boundary_before: first.boundary_before ?? null,
    boundary_after: rows.at(-1)?.boundary_after ?? null,
    qwen_instruct: null,
    provider_controls: {
      kokoro: {
        ...providerContext.kokoro,
        qwen_instruct_claimed: false,
      },
      qwen3: {
        ...providerContext.qwen3,
        delivery_control: "base_icl_reference_audio_only",
        instruct_supported: false,
        instruct_submitted: false,
        instruct: null,
        diagnostic_delivery_note: fallbackInstruction,
      },
    },
    grouped_source_unit_count: sourceUnitRefs.length,
    grouping_policy: "kokoro_safe_adjacent_narration_v1",
  };
  if (appliedReplacements.length) merged.tts_override_replacements_applied = appliedReplacements;
  else delete merged.tts_override_replacements_applied;
  return merged;
}

function compactKokoroNarrationUnits(rows, segment, providerContext) {
  const compacted = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    for (const group of partitionKokoroNarrationRun(pending)) {
      compacted.push(mergeKokoroNarrationRows(group, segment, providerContext));
    }
    pending = [];
  };
  for (const row of rows) {
    const previous = pending.at(-1);
    const consecutiveSourceUnits = !previous
      || Number(row.source_unit_index) === Number(previous.source_unit_index) + 1;
    const sameSpeaker = !previous
      || (row.source_speaker === previous.source_speaker && row.speaker === previous.speaker);
    const mergeableNarration = row.kind === "narration"
      && row.merge_barrier !== true
      && row.source_merge_barrier !== true
      && !row.risk_flags?.includes("system_ui_atomic")
      && !row.risk_flags?.includes("speaker_or_performance_turn");
    if (!mergeableNarration || !consecutiveSourceUnits || !sameSpeaker) {
      flush();
      if (mergeableNarration) pending.push(row);
      else compacted.push(row);
      continue;
    }
    pending.push(row);
  }
  flush();
  return compacted;
}

function qwenLiamNarrationGroupCost(wordCount) {
  if (wordCount <= 60) return 1 + Math.abs(40 - wordCount) * 0.05;
  return Number.POSITIVE_INFINITY;
}

function partitionQwenLiamNarrationRun(rows) {
  const count = rows.length;
  if (count <= 1) return count ? [rows] : [];
  const best = Array(count + 1).fill(null);
  best[count] = { cost: 0, groups: [] };
  for (let start = count - 1; start >= 0; start -= 1) {
    let wordCount = 0;
    for (let end = start; end < count; end += 1) {
      wordCount += Number(rows[end]?.word_count ?? 0);
      if (wordCount > 60) break;
      const tail = best[end + 1];
      if (!tail) continue;
      const candidate = {
        cost: qwenLiamNarrationGroupCost(wordCount) + tail.cost,
        groups: [rows.slice(start, end + 1), ...tail.groups],
      };
      const current = best[start];
      if (!current
        || candidate.cost < current.cost - 1e-9
        || (Math.abs(candidate.cost - current.cost) <= 1e-9
          && candidate.groups.length < current.groups.length)) {
        best[start] = candidate;
      }
    }
  }
  // A source sentence above 60 words is intentionally left intact so the
  // boundary validator can block it before synthesis. We never split prose in
  // the middle of a sentence merely to satisfy the cap.
  return best[0]?.groups ?? rows.map((row) => [row]);
}

function mergeQwenLiamNarrationRows(rows, providerContext) {
  if (rows.length === 1) {
    return {
      ...rows[0],
      grouped_source_unit_count: 1,
      grouping_policy: "qwen_base_sentence_complete_hard_max_v2",
      qwen_instruct: null,
      reference_audio_path: providerContext.qwen3.reference_audio_path,
      reference_text: providerContext.qwen3.reference_text,
      reference_id: providerContext.qwen3.target_voice_id,
      voice_source_policy: providerContext.qwen3.voice_continuity_contract,
    };
  }
  const first = rows[0];
  const sourceUnitRefs = rows.flatMap((row) => row.source_unit_refs ?? []);
  const sourceText = rows.map((row) => row.source_text).filter(Boolean).join(" ").trim();
  const captionText = rows.map((row) => row.caption_text).filter(Boolean).join(" ").trim();
  const spokenText = rows.map((row) => row.spoken_text).filter(Boolean).join(" ").trim();
  const appliedReplacements = rows.flatMap(
    (row) => row.tts_override_replacements_applied ?? [],
  );
  const protectedTerms = [...new Set(
    rows.flatMap((row) => row.protected_terms ?? []).filter(Boolean),
  )];
  const riskFlags = riskFlagsForUnit({
    unit: { kind: "narration", speaker: first.source_speaker ?? "NARRATOR" },
    sourceText,
    spokenText,
    protectedTerms,
    appliedReplacements,
  });
  const merged = {
    ...first,
    unit_id: stableNarrationUnitId(first.segment_id, sourceUnitRefs),
    source_unit_index: sourceUnitRefs[0]?.unit_index ?? first.source_unit_index,
    source_unit_end_index: sourceUnitRefs.at(-1)?.unit_index ?? first.source_unit_index,
    source_unit_refs: sourceUnitRefs,
    source_segment_ids: [...new Set(
      sourceUnitRefs.map((ref) => ref.segment_id).filter(Boolean),
    )],
    source_text: sourceText,
    source_text_sha256: sha256Text(sourceText),
    caption_text: captionText,
    caption_text_sha256: sha256Text(captionText),
    spoken_text: spokenText,
    tts_spoken_text: spokenText,
    qwen_spoken_text: spokenText,
    spoken_text_sha256: sha256Text(spokenText),
    word_count: words(spokenText).length,
    risk_flags: [...new Set(["grouped_narration_unit", ...riskFlags])],
    protected_tokens: protectedTerms,
    protected_terms: protectedTerms,
    merge_barrier: rows.some((row) => row.merge_barrier === true),
    boundary_before: first.boundary_before ?? null,
    boundary_after: rows.at(-1)?.boundary_after ?? null,
    qwen_instruct: null,
    provider_controls: {
      ...first.provider_controls,
      qwen3: {
        ...providerContext.qwen3,
        delivery_control: "base_icl_reference_audio_only",
        instruct_supported: false,
        instruct_submitted: false,
        instruct: null,
      },
    },
    reference_audio_path: providerContext.qwen3.reference_audio_path,
    reference_text: providerContext.qwen3.reference_text,
    reference_id: providerContext.qwen3.target_voice_id,
    voice_source_policy: providerContext.qwen3.voice_continuity_contract,
    grouped_source_unit_count: sourceUnitRefs.length,
    grouping_policy: "qwen_base_sentence_complete_hard_max_v2",
  };
  if (appliedReplacements.length) {
    merged.tts_override_replacements_applied = appliedReplacements;
  } else {
    delete merged.tts_override_replacements_applied;
  }
  return merged;
}

function compactQwenLiamNarrationUnits(rows, providerContext) {
  const compacted = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    for (const group of partitionQwenLiamNarrationRun(pending)) {
      compacted.push(mergeQwenLiamNarrationRows(group, providerContext));
    }
    pending = [];
  };
  for (const row of rows) {
    const rowSegmentId = String(
      row.source_segment_ids?.[0]
        ?? row.source_unit_refs?.[0]?.segment_id
        ?? row.segment_id
        ?? "",
    );
    const pendingSegmentId = String(
      pending[0]?.source_segment_ids?.[0]
        ?? pending[0]?.source_unit_refs?.[0]?.segment_id
        ?? pending[0]?.segment_id
        ?? "",
    );
    if (pending.length && (
      row.boundary_before === "segment"
      || rowSegmentId !== pendingSegmentId
    )) {
      flush();
    }
    const previous = pending.at(-1);
    const sameSpeaker = !previous
      || (row.source_speaker === previous.source_speaker
        && row.speaker === previous.speaker);
    const sourceOrPerformanceBarrier = row.source_merge_barrier === true
      || row.risk_flags?.includes("system_ui_atomic")
      || row.risk_flags?.includes("speaker_or_performance_turn")
      || row.risk_flags?.includes("tts_override_applied");
    const segmentBoundaryOnly = row.merge_barrier === true
      && row.boundary_after === "segment"
      && !sourceOrPerformanceBarrier
      && !row.boundary_before
      && !(
        row.boundary_after
        && row.boundary_after !== "segment"
      );
    const mergeableNarration = row.kind === "narration"
      && (row.merge_barrier !== true || segmentBoundaryOnly)
      && !sourceOrPerformanceBarrier;
    if (!mergeableNarration || !sameSpeaker) {
      flush();
      if (mergeableNarration) pending.push(row);
      else compacted.push(mergeQwenLiamNarrationRows([row], providerContext));
      continue;
    }
    pending.push(row);
    if (row.boundary_after === "segment") flush();
  }
  flush();
  return compacted;
}

function applyActionableNarrationDirection(
  atomicUnits,
  artifact,
  sourceScriptSha256,
  providerContext,
) {
  const artifactSha256 = artifact
    ? canonicalNarrationContractSha256(artifact)
    : null;
  const validation = validateActionableNarrationDirection({
    artifact,
    atomicUnits,
    sourceScriptSha256,
    hardWordMax: 60,
  });
  if (validation.status === "blocked") {
    const error = new Error(
      `LLM-authored narration direction is invalid: ${JSON.stringify(validation.findings)}`,
    );
    error.code = "ACTIONABLE_NARRATION_DIRECTION_INVALID";
    throw error;
  }
  if (validation.status !== "passed") {
    return {
      units: compactQwenLiamNarrationUnits(atomicUnits, providerContext),
      provenance: {
        authoring_kind: "deterministic_fallback",
        artifact_path: null,
        artifact_sha256: null,
        controls_applied: ["sentence_complete_unit_boundaries"],
        descriptive_metadata_actionable: false,
      },
    };
  }
  const unitByKey = new Map(
    atomicUnits.map((unit) => [
      narrationSourceRefKey(unit.source_unit_refs?.[0]),
      unit,
    ]),
  );
  const units = validation.groups.map((group) => {
    const rows = group.source_ref_keys.map((key) => unitByKey.get(String(key)));
    const merged = mergeQwenLiamNarrationRows(rows, providerContext);
    const spokenText = String(group.spoken_text).trim();
    return {
      ...merged,
      spoken_text: spokenText,
      tts_spoken_text: spokenText,
      qwen_spoken_text: spokenText,
      spoken_text_sha256: sha256Text(spokenText),
      word_count: words(spokenText).length,
      grouping_policy: "llm_authored_actionable_boundaries_v1",
      actionable_direction: {
        authoring_kind: "llm_authored",
        dialogue_separation: group.dialogue_separation ?? "preserve",
        punctuation_authored: true,
        source_ref_keys: group.source_ref_keys,
      },
    };
  });
  return {
    units,
    provenance: {
      authoring_kind: "llm_authored",
      provider: artifact.authoring.provider,
      model: artifact.authoring.model,
      artifact_path: artifact.artifact_path ?? null,
      artifact_sha256: artifactSha256,
      controls_applied: [
        "punctuation",
        "sentence_complete_unit_boundaries",
        "dialogue_separation",
      ],
      descriptive_metadata_actionable: false,
    },
  };
}

function sentenceCompleteUnitBoundaryIntegrity(units, enabled) {
  if (!enabled) {
    return {
      status: "not_applicable",
      enabled: false,
      unit_count: units.length,
      blockers: [],
    };
  }
  const blockers = [];
  for (const unit of units) {
    const sourceText = String(unit?.source_text ?? "").trim();
    const spokenText = String(
      unit?.spoken_text
        ?? unit?.tts_spoken_text
        ?? unit?.qwen_spoken_text
        ?? "",
    ).trim();
    const refs = Array.isArray(unit?.source_unit_refs) ? unit.source_unit_refs : [];
    const exactSourceJoin = refs.map((ref) => String(ref?.source_text ?? "")).filter(Boolean).join(" ").trim();
    if (!refs.length || sourceText !== exactSourceJoin) {
      blockers.push({
        code: "tts_unit_not_exact_whole_source_unit_join",
        unit_id: unit?.unit_id ?? null,
        source_text: sourceText,
      });
    }
    const sourceSegmentIds = [...new Set([
      ...(unit?.source_segment_ids ?? []),
      ...refs.map((ref) => ref?.segment_id),
    ].map((value) => String(value ?? "").trim()).filter(Boolean))];
    if (sourceSegmentIds.length > 1) {
      blockers.push({
        code: "tts_unit_crosses_voice_segment_boundary",
        unit_id: unit?.unit_id ?? null,
        source_segment_ids: sourceSegmentIds,
      });
    }
    if (!/^[\p{L}\p{N}"“‘(\[]/u.test(sourceText)) {
      blockers.push({
        code: "tts_unit_possible_mid_sentence_start",
        unit_id: unit?.unit_id ?? null,
        source_text: sourceText,
      });
    }
    if (!hasTtsTerminalPunctuation(spokenText)) {
      blockers.push({
        code: "tts_unit_missing_terminal_punctuation",
        unit_id: unit?.unit_id ?? null,
        source_text: sourceText,
        spoken_text: spokenText,
      });
    }
    const spokenWordCount = words(spokenText).length;
    if (spokenWordCount > 60) {
      blockers.push({
        code: "tts_unit_exceeds_hard_word_maximum",
        unit_id: unit?.unit_id ?? null,
        spoken_word_count: spokenWordCount,
        hard_spoken_words_max: 60,
      });
    }
  }
  return {
    status: blockers.length ? "blocked" : "passed",
    enabled: true,
    unit_count: units.length,
    whole_source_units_only: blockers.every((row) => row.code !== "tts_unit_not_exact_whole_source_unit_join"),
    clean_start_count: units.length - blockers.filter((row) => row.code === "tts_unit_possible_mid_sentence_start").length,
    terminal_punctuation_count: units.length - blockers.filter((row) => row.code === "tts_unit_missing_terminal_punctuation").length,
    within_hard_word_maximum_count: units.length
      - blockers.filter((row) => row.code === "tts_unit_exceeds_hard_word_maximum").length,
    within_voice_segment_boundary_count: units.length
      - blockers.filter((row) => row.code === "tts_unit_crosses_voice_segment_boundary").length,
    blocker_count: blockers.length,
    blockers: blockers.slice(0, 50),
    policy: "Every request is assembled only from complete source sentences or atomic system/dialogue units, stays inside one voice-direction segment, starts on a clean sentence or paragraph boundary, ends on terminal punctuation, and contains no more than 60 spoken words. Voice-segment crossing and mid-sentence slicing are forbidden.",
  };
}

function buildQwenGenerationPlan(
  segments,
  qwenConfig = {},
  dialogueContext = {},
  ttsProvider = "qwen_local",
  ttsOverrides = {},
  providerContext = providerPlanContext({
    tts_provider: ttsProvider,
    tts_fallback_provider: ttsProvider === "qwen_local" ? null : "qwen_local",
    narrator_voice_id: ttsProvider === "qwen_local"
      ? QWEN_JOEL_PRIMARY_LOCK.voice_id
      : QWEN_LOCAL_FALLBACK_LOCK.reference_voice_id,
    voice_provider_options: {
      primary: ttsProvider === "qwen_local"
        ? { ...QWEN_JOEL_DRY_DEADPAN_PRIMARY_LOCK }
        : { voice_id: QWEN_LOCAL_FALLBACK_LOCK.reference_voice_id },
      fallback: ttsProvider === "qwen_local"
        ? null
        : { ...QWEN_LOCAL_FALLBACK_LOCK },
      synthesis_contract: ttsProvider === "qwen_local"
        ? QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT
        : null,
    },
  }, {}, ttsProvider),
  actionableDirectionArtifact = null,
  sourceScriptSha256 = null,
) {
  const unitRows = [];
  let segmentRows = [];
  const appliedOverrideRules = new Map();
  for (const segment of segments) {
    const units = segment.performance_units?.length ? segment.performance_units : [{
      kind: segment.dialogue_turn_count ? "dialogue" : "narration",
      speaker: segment.speakers?.[0] ?? "NARRATOR",
      text: segment.stripped_text ?? segment.caption_text ?? segment.text,
      performed_text: segment.stripped_text ?? segment.caption_text ?? segment.text,
      caption_text: segment.caption_text ?? segment.stripped_text ?? segment.text,
    }];
    const qwenUnits = [];
    for (const [sourceUnitOffset, unit] of units.entries()) {
      if (unit.kind === "sound_design" || /^SFX$/i.test(String(unit.speaker ?? ""))) continue;
      const sourceSpeaker = unit.speaker ?? "NARRATOR";
      const speaker = characterVoiceCastingEnabled() ? sourceSpeaker : "NARRATOR";
      const cast = castForSpeaker(speaker, dialogueContext);
      const role = characterVoiceCastingEnabled()
        ? cast?.role ?? speakerRoleFor(speaker, unit.text ?? "", segment, dialogueContext)
        : "narrator";
      const rawPerformanceText = unit.performed_text ?? unit.text ?? unit.caption_text;
      const spoken = qwenSpokenTextDetailed(rawPerformanceText, sourceSpeaker, ttsOverrides);
      const spokenText = normalizeAtomicSpokenTerminal(spoken.text, {
        sourceText: unit.text ?? "",
        kind: unit.kind ?? "narration",
      });
      if (!isSpeakableQwenText(spokenText)) continue;
      const sourceUnitIndex = sourceUnitOffset + 1;
      const qwenInstruction = qwenInstructForUnit({ segment, unit: { ...unit, speaker: sourceSpeaker }, role, cast });
      const protectedTerms = protectedTermsForUnit(unit.text ?? "", spokenText, ttsOverrides, spoken.applied_replacements);
      const riskFlags = riskFlagsForUnit({
        unit,
        sourceText: unit.text ?? "",
        spokenText,
        protectedTerms,
        appliedReplacements: spoken.applied_replacements,
      });
      const sourceText = unit.text ?? "";
      const captionText = unit.caption_text ?? unit.text ?? "";
      const isKokoroPrimary = providerContext.primary_provider === "kokoro_local";
      const sourceUnitRef = {
        segment_id: segment.segment_id,
        unit_index: sourceUnitIndex,
        kind: unit.kind ?? "narration",
        source_speaker: sourceSpeaker,
        source_text: sourceText,
        source_text_sha256: sha256Text(sourceText),
        caption_text: captionText,
        caption_text_sha256: sha256Text(captionText),
      };
      const sourceMergeBarrier = sourceUnitHasExplicitMergeBarrier(unit);
      const stableUnitId = stableNarrationUnitId(segment.segment_id, [sourceUnitRef]);
      const row = {
        unit_id: stableUnitId,
        order_index: null,
        segment_id: segment.segment_id,
        unit_index: qwenUnits.length + 1,
        source_unit_index: sourceUnitIndex,
        source_segment_ids: [segment.segment_id],
        source_unit_refs: [sourceUnitRef],
        kind: unit.kind ?? "narration",
        speaker,
        source_speaker: sourceSpeaker,
        role,
        spoken_text: spokenText,
        tts_spoken_text: spokenText,
        qwen_spoken_text: spokenText,
        spoken_text_sha256: sha256Text(spokenText),
        word_count: words(spokenText).length,
        caption_text: captionText,
        caption_text_sha256: sha256Text(captionText),
        source_text: sourceText,
        source_text_sha256: sha256Text(sourceText),
        delivery_class: segment.delivery_mode ?? "exposition narration",
        risk_flags: riskFlags,
        protected_tokens: protectedTerms,
        protected_terms: protectedTerms,
        source_merge_barrier: sourceMergeBarrier,
        merge_barrier: sourceMergeBarrier || riskFlags.includes("system_ui_atomic") || riskFlags.includes("speaker_or_performance_turn") || riskFlags.includes("tts_override_applied"),
        boundary_before: qwenUnits.length === 0 ? "segment" : null,
        boundary_after: null,
        qwen_instruct: null,
        provider_controls: {
          kokoro: {
            ...providerContext.kokoro,
            qwen_instruct_claimed: false,
          },
          qwen3: {
            ...providerContext.qwen3,
            ...(isKokoroPrimary ? {
              delivery_control: "base_icl_reference_audio_only",
              instruct_supported: false,
              instruct_submitted: false,
              instruct: null,
              diagnostic_delivery_note: qwenInstruction,
            } : {
              delivery_control: "base_icl_reference_audio_only",
              instruct_supported: false,
              instruct_submitted: false,
              instruct: null,
              diagnostic_delivery_note: qwenInstruction,
            }),
          },
        },
        reference_audio_path: isKokoroPrimary
          ? null
          : providerContext.qwen3.reference_audio_path,
        reference_text: isKokoroPrimary
          ? null
          : providerContext.qwen3.reference_text,
        voice_source_policy: isKokoroPrimary
          ? "bundled_kokoro_preset_no_reference_audio_required"
          : "qwen_liam_primary_reference_clone",
        voice_casting_mode: characterVoiceCastingEnabled() ? "explicit_character_voice_casting" : "narrator_only_default",
        reference_id: isKokoroPrimary
          ? providerContext.kokoro.voice_id
          : providerContext.qwen3.target_voice_id,
      };
      if (spoken.applied_replacements?.length) {
        row.tts_override_replacements_applied = spoken.applied_replacements;
        for (const applied of spoken.applied_replacements) {
          if (!appliedOverrideRules.has(applied.rule_index)) {
            appliedOverrideRules.set(applied.rule_index, {
              ...applied,
              application_count: 0,
              examples: [],
            });
          }
          const summary = appliedOverrideRules.get(applied.rule_index);
          summary.application_count += 1;
          if (summary.examples.length < 3) {
            summary.examples.push({
              segment_id: segment.segment_id,
              unit_index: row.unit_index,
              qwen_spoken_text: spokenText,
            });
          }
        }
      }
      qwenUnits.push(row);
    }
    const generationUnits = providerContext.primary_provider === "kokoro_local"
      ? compactKokoroNarrationUnits(qwenUnits, segment, providerContext)
      : qwenUnits;
    for (const [segmentUnitOffset, unit] of generationUnits.entries()) {
      unit.unit_index = segmentUnitOffset + 1;
      unit.order_index = unitRows.length;
      unitRows.push(unit);
    }
    if (generationUnits.length) {
      generationUnits.at(-1).boundary_after = "segment";
      generationUnits.at(-1).merge_barrier = true;
    }
    segmentRows.push({
      segment_id: segment.segment_id,
      delivery_mode: segment.delivery_mode,
      expected_duration_sec: segment.expected_duration_sec,
      unit_count: generationUnits.length,
      source_unit_count: qwenUnits.length,
      speakers: [...new Set(generationUnits.map((unit) => unit.speaker))],
      generation_units: generationUnits,
      narration_units: generationUnits,
      narration_generation_units: generationUnits,
      qwen_generation_units: generationUnits,
    });
  }
  const performanceAuthoringAtomicUnits = providerContext.primary_provider === "qwen_local"
    ? unitRows.map((unit) => structuredClone(unit))
    : [];
  if (providerContext.primary_provider === "qwen_local") {
    const directed = applyActionableNarrationDirection(
      unitRows,
      actionableDirectionArtifact,
      sourceScriptSha256,
      providerContext,
    );
    const compactedUnits = directed.units;
    unitRows.splice(0, unitRows.length, ...compactedUnits);
    for (const [index, unit] of unitRows.entries()) {
      unit.order_index = index;
      unit.segment_id = unit.source_segment_ids?.[0] ?? unit.segment_id;
      unit.unit_index = null;
      if (index === unitRows.length - 1) unit.boundary_after = "episode";
    }
    const sourceCounts = new Map(
      segmentRows.map((segment) => [segment.segment_id, segment.source_unit_count]),
    );
    const segmentMetadata = new Map(
      segments.map((segment) => [segment.segment_id, segment]),
    );
    segmentRows = segments.map((segment) => {
      const generationUnits = unitRows.filter(
        (unit) => unit.source_segment_ids?.[0] === segment.segment_id,
      );
      for (const [index, unit] of generationUnits.entries()) {
        unit.unit_index = index + 1;
      }
      return {
        segment_id: segment.segment_id,
        delivery_mode: segmentMetadata.get(segment.segment_id)?.delivery_mode,
        expected_duration_sec:
          segmentMetadata.get(segment.segment_id)?.expected_duration_sec,
        unit_count: generationUnits.length,
        source_unit_count: sourceCounts.get(segment.segment_id) ?? 0,
        speakers: [...new Set(generationUnits.map((unit) => unit.speaker))],
        generation_units: generationUnits,
        narration_units: generationUnits,
        narration_generation_units: generationUnits,
        qwen_generation_units: generationUnits,
      };
    });
  }
  const loadedOverrides = (ttsOverrides.replacements ?? []).map((rule, index) => ({
    rule_index: index,
    from: rule.from ?? null,
    to: rule.to ?? null,
    scope: canonicalSpokenOverrideScope(rule.scope),
    source_scope: rule.scope ?? "tts_spoken_text",
    regex: rule.regex === true,
  }));
  const appliedRules = [...appliedOverrideRules.values()];
  const appliedRuleIndexes = new Set(appliedRules.map((rule) => rule.rule_index));
  const unmatchedRules = loadedOverrides.filter((rule) => !appliedRuleIndexes.has(rule.rule_index));
  if (unitRows.length) {
    unitRows[0].risk_flags = [...new Set(["episode_opening_unit", ...unitRows[0].risk_flags])];
    unitRows.at(-1).risk_flags = [...new Set([...unitRows.at(-1).risk_flags, "episode_final_unit"])];
  }
  const sentenceBoundaryIntegrity = sentenceCompleteUnitBoundaryIntegrity(
    unitRows,
    ["kokoro_local", "qwen_local"].includes(providerContext.primary_provider),
  );
  const qwenBatchPlan = providerContext.primary_provider === "qwen_local"
    ? buildQwenLiamBatchPlan(
        unitRows,
        providerContext.qwen3.synthesis_contract,
      )
    : null;
  if (qwenBatchPlan) {
    const bindingByUnit = qwenBatchBindingByUnit(qwenBatchPlan);
    for (const unit of unitRows) {
      unit.synthesis_cohort = bindingByUnit.get(String(unit.unit_id));
    }
  }
  const directionProvenance = providerContext.primary_provider === "qwen_local"
    ? (unitRows[0]?.actionable_direction?.authoring_kind === "llm_authored"
      ? {
          authoring_kind: "llm_authored",
          provider: actionableDirectionArtifact?.authoring?.provider ?? null,
          model: actionableDirectionArtifact?.authoring?.model ?? null,
          artifact_path: actionableDirectionArtifact?.artifact_path ?? null,
          artifact_sha256: actionableDirectionArtifact
            ? canonicalNarrationContractSha256(actionableDirectionArtifact)
            : null,
          controls_applied: ["punctuation", "sentence_complete_unit_boundaries", "dialogue_separation"],
          descriptive_metadata_actionable: false,
        }
      : {
          authoring_kind: "deterministic_fallback",
          artifact_path: null,
          artifact_sha256: null,
          controls_applied: ["sentence_complete_unit_boundaries"],
          descriptive_metadata_actionable: false,
        })
    : {
        authoring_kind: "provider_native_deterministic",
        artifact_path: null,
        artifact_sha256: null,
        controls_applied: ["punctuation", "sentence_complete_unit_boundaries"],
        descriptive_metadata_actionable: false,
      };
  const performanceContract = buildNarrationPerformanceContract({
    provider: providerContext.primary_provider,
    modelId: providerContext.qwen3.model_id ?? providerContext.kokoro.model_id,
    modelRevision: providerContext.qwen3.model_revision ?? providerContext.kokoro.model_revision,
    voiceId: providerContext.qwen3.target_voice_id ?? providerContext.kokoro.voice_id,
    voiceSha256: providerContext.qwen3.target_voice_sha256 ?? QWEN_LOCAL_FALLBACK_LOCK.reference_voice_sha256,
    referenceAudioSha256: providerContext.qwen3.reference_audio_sha256 ?? null,
    referenceTextSha256: providerContext.qwen3.reference_text_sha256 ?? null,
    synthesisContract: providerContext.qwen3.synthesis_contract ?? null,
    actionableDirection: directionProvenance,
    hardWordMax: 60,
  });
  return {
    schema: "goldflow_tts_generation_plan_v2",
    status: sentenceBoundaryIntegrity.status === "blocked" ? "blocked" : "passed",
    provider: providerContext.primary_provider,
    primary_provider: providerContext.primary_provider,
    fallback_provider: providerContext.fallback_provider,
    ...(providerContext.primary_provider === "kokoro_local" ? {
      narrator_voice_id: providerContext.kokoro.voice_id,
      narrator_voice_sha256: QWEN_LOCAL_FALLBACK_LOCK.reference_voice_sha256,
      narrator_identity_policy: "single_puck_identity_with_qwen_exact_unit_clone",
    } : {
      narrator_voice_id: providerContext.qwen3.target_voice_id,
      narrator_voice_sha256: providerContext.qwen3.target_voice_sha256,
      narrator_identity_policy: "single_qwen_reference_clone",
    }),
    generated_at: new Date().toISOString(),
    policy: "Provider-neutral narrator generation plan. Spoken text is clean and separate from exact captions/source. Qwen3-TTS Base receives only spoken text, punctuation, unit boundaries, dialogue separation, and the identity-locked reference audio/transcript. Descriptive emotion or pacing metadata is diagnostic and is never represented as an effective instruction.",
    direction_metadata: {
      actionable: directionProvenance,
      descriptive: {
        authoring_kind: "deterministic_diagnostic",
        submitted_to_qwen_base: false,
        fields: ["delivery_mode", "emotional_audio_texture", "pacing_tempo", "diagnostic_delivery_note"],
      },
    },
    performance_contract: performanceContract,
    _performance_authoring_atomic_units: performanceAuthoringAtomicUnits,
    provider_controls: {
      kokoro: providerContext.kokoro,
      qwen3: providerContext.qwen3,
    },
    kokoro_unit_grouping: {
      enabled: providerContext.primary_provider === "kokoro_local",
      target_spoken_words_min: 24,
      target_spoken_words_max: 46,
      hard_spoken_words_max: 54,
      policy: "Compact only adjacent same-speaker narration inside one existing segment. System/UI, dialogue, performance, speaker changes, sound design, explicit merge barriers, source-index gaps, and segment boundaries remain atomic barriers. A single source sentence longer than the hard maximum remains intact.",
    },
    qwen_liam_unit_grouping: {
      enabled: providerContext.primary_provider === "qwen_local",
      sentence_complete: true,
      target_spoken_words_min: null,
      target_spoken_words_max: 60,
      hard_spoken_words_max: 60,
      continuous_requests_allowed: false,
      policy: "LLM-authored actionable boundaries are used when a valid hash-bound direction artifact exists; otherwise deterministic sentence-complete grouping is the fallback. There is no minimum word target. Voice-segment boundaries, system/UI, dialogue, performance, speaker changes, sound design, and explicit merge barriers remain atomic. Never split a sentence or exceed 60 spoken words.",
    },
    qwen_liam_batch_plan: qwenBatchPlan,
    sentence_unit_boundary_integrity: sentenceBoundaryIntegrity,
    // Compatibility alias for historical validators; the report body is now
    // provider-neutral and applies to Qwen Liam too.
    kokoro_unit_boundary_integrity: sentenceBoundaryIntegrity,
    instruction_delivery: {
      kokoro: {
        supported: false,
        submitted: false,
        policy: "Kokoro Puck delivery is controlled by exact spoken text, punctuation, stable source-bound narration groups, locked voice, native speed, and stitch gaps. It cannot claim qwen_instruct delivery.",
      },
      qwen3: {
        planned: providerContext.primary_provider === "qwen_local" || providerContext.fallback_provider === "qwen_local",
        submitted_by_voice_plan: false,
        supported: false,
        delivery_control: "base_icl_reference_audio_only",
        fallback_delivery_control: providerContext.fallback_provider === "qwen_local"
          ? "base_icl_reference_audio_only"
          : null,
        policy: providerContext.primary_provider === "qwen_local"
          ? "Qwen3 Base uses exact spoken text plus the pinned Liam reference audio and transcript. It receives no effective instruct, no continuous longform request, and no speed or post-tempo processing."
          : providerContext.fallback_provider === "qwen_local"
          ? "The locked Qwen3 Base ICL fallback ignores instruct; it uses exact spoken text plus the pinned reference audio and reference transcript only."
          : "Per-unit instructions remain declarative controls only for an explicit Qwen route whose selected model/runtime supports them.",
        ...(providerContext.primary_provider === "qwen_local"
          ? qwenLiamPrimaryIdentityControls()
          : providerContext.qwen3.fallback ? puckQwenFallbackIdentityControls() : {}),
      },
    },
    qwen_config_policy: qwenConfig.prompting ?? null,
    pronunciation_protocol: {
      letter_ranks_are_spelled: true,
      examples: ["SSS -> S S S", "SS-rank -> S S rank", "XP -> X P", "UI -> U I", "Level -1 -> Level negative one", "confirmed -> verified"],
      tts_spoken_overrides_loaded: (ttsOverrides.replacements ?? []).length,
      tts_spoken_overrides_applied: appliedRules.length,
    },
    tts_override_application_audit: {
      loaded_count: loadedOverrides.length,
      applied_rule_count: appliedRules.length,
      unmatched_rule_count: unmatchedRules.length,
      applied_rules: appliedRules,
      unmatched_rules: unmatchedRules,
    },
    segment_count: segmentRows.length,
    unit_count: unitRows.length,
    system_ui_unit_count: unitRows.filter((unit) => /^SYSTEM$/i.test(String(unit.source_speaker ?? ""))).length,
    units: unitRows,
    segments: segmentRows,
  };
}

function systemUiSpeechCoverage(script, plan, dialogueContext = {}) {
  const expected = stripTitle(String(script ?? ""))
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap((paragraph) => {
      const colonlessBlock = colonlessSystemUiBlock(paragraph);
      if (colonlessBlock) return [colonlessBlock.text];
      return paragraph.split(/\n/)
        .map((line) => {
          const bracketed = standaloneSystemUiText(line);
          if (bracketed) return bracketed;
          return colonSystemUiUnit(line, dialogueContext)?.text ?? null;
        })
        .filter(Boolean);
    });
  const planned = (plan?.segments ?? [])
    .flatMap((segment) => segment.qwen_generation_units ?? [])
    .filter((unit) => /^SYSTEM$/i.test(String(unit.source_speaker ?? "")))
    .map((unit) => String(unit.source_text ?? "").trim());
  const remaining = new Map();
  for (const text of planned) remaining.set(text, (remaining.get(text) ?? 0) + 1);
  const missing = [];
  for (const text of expected) {
    const count = remaining.get(text) ?? 0;
    if (count > 0) remaining.set(text, count - 1);
    else missing.push(text);
  }
  const unexpected = [];
  for (const [text, count] of remaining) {
    for (let index = 0; index < count; index += 1) unexpected.push(text);
  }
  return {
    status: missing.length || unexpected.length ? "blocked" : "passed",
    expected_count: expected.length,
    planned_count: planned.length,
    missing_count: missing.length,
    unexpected_count: unexpected.length,
    missing,
    unexpected,
    policy: "Every standalone system/UI bracket line, detected colon label-and-value record, and consecutive all-caps period-delimited interface block in the locked script must become one spoken SYSTEM source unit. Only standalone outer brackets are removed; all-caps blocks preserve their line text and order.",
  };
}

export function systemUiSpeechCoverageForTests(script, plan, dialogueContext = {}) {
  return systemUiSpeechCoverage(script, plan, dialogueContext);
}

function coverageTokens(value) {
  return (String(value ?? "")
    .normalize("NFKC")
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [])
    .map((token) => token.replaceAll("’", "'").toLowerCase());
}

function tokenCoverageComparison(expectedTokens, actualTokens) {
  const sharedLength = Math.min(expectedTokens.length, actualTokens.length);
  let firstMismatchIndex = -1;
  for (let index = 0; index < sharedLength; index += 1) {
    if (expectedTokens[index] !== actualTokens[index]) {
      firstMismatchIndex = index;
      break;
    }
  }
  if (firstMismatchIndex < 0 && expectedTokens.length !== actualTokens.length) firstMismatchIndex = sharedLength;
  const contextStart = firstMismatchIndex < 0 ? 0 : Math.max(0, firstMismatchIndex - 6);
  const contextEnd = firstMismatchIndex < 0 ? 0 : firstMismatchIndex + 10;
  return {
    status: firstMismatchIndex < 0 ? "passed" : "blocked",
    expected_token_count: expectedTokens.length,
    actual_token_count: actualTokens.length,
    first_mismatch_token_index: firstMismatchIndex < 0 ? null : firstMismatchIndex,
    expected_context: firstMismatchIndex < 0 ? [] : expectedTokens.slice(contextStart, contextEnd),
    actual_context: firstMismatchIndex < 0 ? [] : actualTokens.slice(contextStart, contextEnd),
  };
}

function scriptSpeakableFragmentsForCoverage(script, dialogueContext = {}) {
  const fragments = [];
  for (const rawLine of stripTitle(script).split(/\n/)) {
    let line = String(rawLine ?? "").trim();
    if (!line) continue;
    line = line
      .replace(/^\[COMMENT_BAIT\]\s*/i, "")
      .replace(/^\[BREATH_BEAT\]\s*/i, "")
      .replace(/^\[MC_INTERNAL\]\s*:?\s*/i, "")
      .trim();
    if (!line || isSoundDesignText(line)) continue;
    const bracketedInterface = standaloneSystemUiText(line);
    if (bracketedInterface) {
      fragments.push(bracketedInterface);
      continue;
    }
    if (/^\[[^\]\n]+\]$/.test(line)) continue;
    const colonInterface = colonSystemUiUnit(line, dialogueContext);
    if (colonInterface) {
      fragments.push(colonInterface.text);
      continue;
    }
    const colonDialogue = colonDialogueLine(line);
    fragments.push(colonDialogue?.spoken ?? line);
  }
  return fragments;
}

function expectedSpokenTokensForUnit(unit, ttsOverrides = {}) {
  const sourceText = String(unit?.source_text ?? "")
    .replace(/<\|speaker:\d+\|>/g, " ")
    .trim();
  const replacement = applySpokenOverrideRules(sourceText, ttsOverrides.replacements ?? []);
  const pronounced = applyPronunciationMap(replacement, ttsOverrides.pronunciation_map ?? []);
  return coverageTokens(qwenPronunciationText(pronounced));
}

export function qwenTextIntegrityCoverageForTests(script, plan, { ttsOverrides = {}, dialogueContext = {} } = {}) {
  const units = (plan?.segments ?? []).flatMap((segment) => segment.qwen_generation_units ?? []);
  const expectedScriptTokens = coverageTokens(scriptSpeakableFragmentsForCoverage(script, dialogueContext).join(" "));
  const plannedSourceTokens = coverageTokens(units.map((unit) => unit.source_text ?? "").join(" "));
  const scriptToPlan = tokenCoverageComparison(expectedScriptTokens, plannedSourceTokens);
  const spokenUnitFindings = [];
  let expectedSpokenTokenCount = 0;
  let actualSpokenTokenCount = 0;
  for (const unit of units) {
    const expectedTokens = expectedSpokenTokensForUnit(unit, ttsOverrides);
    const actualTokens = coverageTokens(unit.qwen_spoken_text);
    expectedSpokenTokenCount += expectedTokens.length;
    actualSpokenTokenCount += actualTokens.length;
    const comparison = tokenCoverageComparison(expectedTokens, actualTokens);
    if (comparison.status !== "passed") {
      spokenUnitFindings.push({
        code: "qwen_spoken_unit_coverage_mismatch",
        segment_id: unit.segment_id ?? null,
        unit_index: unit.unit_index ?? null,
        source_speaker: unit.source_speaker ?? null,
        source_text: unit.source_text ?? "",
        qwen_spoken_text: unit.qwen_spoken_text ?? "",
        ...comparison,
      });
    }
  }
  const findings = [];
  if (scriptToPlan.status !== "passed") {
    findings.push({
      code: "script_to_qwen_plan_source_coverage_mismatch",
      severity: "blocker",
      ...scriptToPlan,
    });
  }
  if (spokenUnitFindings.length) {
    findings.push({
      code: "qwen_plan_source_to_spoken_coverage_mismatch",
      severity: "blocker",
      mismatch_unit_count: spokenUnitFindings.length,
      mismatch_units: spokenUnitFindings.slice(0, 20),
    });
  }
  return {
    status: findings.length ? "blocked" : "passed",
    policy: "Every speakable lexical token in the locked script must remain present and ordered in the Qwen plan and spoken text unless an approved, hash-bound tts_spoken_overrides rule or explicit pronunciation mapping accounts for the change.",
    normalization_policy: [
      "Coverage ignores case and punctuation but never ignores lexical words.",
      "Markdown titles, scene headers, explicit production directions, and explicit sound-design cues are non-spoken.",
      "Recognized character speaker labels are metadata; SYSTEM/UI label-and-value text remains spoken.",
      "Outer dialogue quotes and standalone SYSTEM/UI brackets are syntax; their lexical contents remain spoken.",
      "Numeric verbalization, approved initialism expansion, approved pronunciation mappings, and hash-bound TTS-only overrides are compared as intended spoken forms.",
    ],
    script_to_plan_source: scriptToPlan,
    plan_source_to_spoken: {
      status: spokenUnitFindings.length ? "blocked" : "passed",
      unit_count: units.length,
      expected_token_count: expectedSpokenTokenCount,
      actual_token_count: actualSpokenTokenCount,
      mismatch_unit_count: spokenUnitFindings.length,
      mismatch_units: spokenUnitFindings.slice(0, 20),
    },
    findings,
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

function voiceArtifactContaminationGate(artifacts, currentSourceText, {
  seriesPackage = {},
  trustedReferenceTexts = [],
} = {}) {
  const allowedContext = String(currentSourceText ?? "");
  const foreignTerms = foreignSeriesTermSpecs({ channel, series: seriesSlug, seriesPackage });
  const protectedTerms = protectedIpTermSpecs();
  const blockers = [];
  for (const [artifact, value] of Object.entries(artifacts ?? {})) {
    let text = stringifyForGate(value);
    for (const trustedReferenceText of trustedReferenceTexts) {
      const exact = String(trustedReferenceText ?? "").trim();
      if (exact) text = text.split(exact).join("[RIGHTS_CLEARED_REFERENCE_TRANSCRIPT]");
    }
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
      const appearsInArtifact = resetAndTest(term.pattern, text);
      const allowedFromSourceText = resetAndTest(term.pattern, allowedContext);
      if (appearsInArtifact && !allowedFromSourceText) {
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
  if (lockedRole && !/^(joel_narrator|joel_owned_narrator_clone(?:_220wpm)?)$/i.test(String(lockedRole))) return lockedRole;
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
  if (narratorOnlyVoiceMode(dialogueContext)) {
    const lockedNarrator = dialogueContext.voiceCastingLock?.speaker_casting?.NARRATOR ?? {};
    return lockedNarrator.reference_id
      || lockedNarrator.id
      || dialogueContext.voiceCastingLock?.narrator_voice_id
      || ids.narrator
      || fishAudioConfig.referenceId
      || DEFAULT_QWEN_NARRATOR_VOICE_ID;
  }
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

function canonicalPlanHash(value) {
  function canonicalize(item) {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !["generated_at", "plan_sha256", "canonical_plan_sha256"].includes(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return sha256Text(JSON.stringify(canonicalize(value)));
}

async function main() {
  const scriptPath = path.join(episodeDir, "script_clean.md");
  if (!existsSync(scriptPath)) throw new Error(`Missing locked script: ${scriptPath}`);
  await assertManualAgentScriptReview(scriptPath);
  await assertScriptApprovedForVoicePlan(scriptPath);
  const script = await fs.readFile(scriptPath, "utf8");
  const sourceScriptHash = sha256Text(script);
  const scriptSpeakabilityReport = await requireSpeakabilityReport(sourceScriptHash);
  const ttsSpokenOverrides = await loadTtsSpokenOverrides(sourceScriptHash);
  const seriesTags = palette();
  const universalTags = await loadUniversalFishTags();
  const speakabilityRules = await loadSpeakabilityRules();
  const dialogueContext = await loadDialogueContext();
  const tags = { ...seriesTags, ...universalTags };
  const providerRouting = await loadProviderRouting();
  const runIdentity = dialogueContext.runIdentity ?? {};
  const ttsProvider = requestedTtsProvider(providerRouting, dialogueContext.voiceCastingLock, runIdentity);
  const qwenLocal = isQwenLocalProvider(ttsProvider);
  const kokoroLocal = isKokoroLocalProvider(ttsProvider);
  const unitBasedNarrator = isUnitBasedNarratorProvider(ttsProvider);
  const providerContext = providerPlanContext(runIdentity, providerRouting, ttsProvider);
  const narrationGenerationPlanPath = path.join(episodeDir, "narration_generation_plan.json");
  const actionableDirectionPath = path.join(
    episodeDir,
    "narration_actionable_direction.json",
  );
  const spokenTextAuditPath = path.join(episodeDir, `tts_spoken_text_audit_${episode}.json`);
  const qwenGenerationPlanPath = path.join(episodeDir, "qwen_generation_plan.json");
  const qwenConfig = await readJsonIfExists(path.join(process.cwd(), "config", "qwen-tts.json"), {});
  const fishAudioConfig = await readJsonIfExists(path.join(process.cwd(), "config", "fish-audio.json"), {});
  const fishVoicesConfig = await readJsonIfExists(path.join(process.cwd(), "config", "fish-voices.json"), {});
  const actionableDirectionArtifact = await readJsonIfExists(
    actionableDirectionPath,
    null,
  );
  if (actionableDirectionArtifact) {
    actionableDirectionArtifact.artifact_path = actionableDirectionPath;
  }
  const voiceQualityAdjustedSegments = repairConsecutiveTagRuns(ensureMinimumPhysicalTags(
    balanceTempoClassifications(buildSegments(script, tags, speakabilityRules, dialogueContext)),
    tags,
  ));
  const applied = unitBasedNarrator
    ? { segments: voiceQualityAdjustedSegments, missingRefRoles: [] }
    : applyFishReferenceIds(voiceQualityAdjustedSegments, fishAudioConfig, dialogueContext);
  const baseSegments = applied.segments ?? applied;
  const missingRefRoles = applied.missingRefRoles ?? [];
  const narrationPlanDraft = buildQwenGenerationPlan(
    baseSegments,
    qwenConfig,
    dialogueContext,
    ttsProvider,
    ttsSpokenOverrides,
    providerContext,
    null,
    sourceScriptHash,
  );
  let effectiveActionableDirection = actionableDirectionArtifact;
  if (qwenLocal) {
    const atomicUnits = narrationPlanDraft._performance_authoring_atomic_units ?? [];
    const existingValidation = validateActionableNarrationDirection({
      artifact: effectiveActionableDirection,
      atomicUnits,
      sourceScriptSha256: sourceScriptHash,
      hardWordMax: 60,
    });
    if (existingValidation.status !== "passed") {
      const authored = await authorNarrationPerformanceDirection({
        atomicUnits,
        sourceScriptSha256: sourceScriptHash,
        episodeDir,
        repoRoot,
        provider: flags["performance-planner-provider"] ?? null,
        model: flags["performance-planner-model"] ?? flags.model ?? flags["llm-model"] ?? null,
        reasoningEffort: flags["performance-reasoning-effort"] ?? "medium",
        concurrency: Number(flags["performance-concurrency"] ?? 3),
      });
      effectiveActionableDirection = authored.artifact;
      effectiveActionableDirection.artifact_path = authored.artifactPath;
    }
  }
  const narrationGenerationPlan = qwenLocal
    ? buildQwenGenerationPlan(
        baseSegments,
        qwenConfig,
        dialogueContext,
        ttsProvider,
        ttsSpokenOverrides,
        providerContext,
        effectiveActionableDirection,
        sourceScriptHash,
      )
    : narrationPlanDraft;
  delete narrationGenerationPlan._performance_authoring_atomic_units;
  const speakabilityReportPath = path.join(episodeDir, "script_speakability_report.json");
  const ttsSpokenOverridesPath = path.join(episodeDir, "tts_spoken_overrides.json");
  narrationGenerationPlan.source_script_hash = sourceScriptHash;
  narrationGenerationPlan.source_script_path = scriptPath;
  narrationGenerationPlan.script_speakability_report_path = speakabilityReportPath;
  narrationGenerationPlan.tts_spoken_overrides_path = ttsSpokenOverridesPath;
  narrationGenerationPlan.source_hashes = {
    script_clean_sha256: sourceScriptHash,
    script_speakability_report_sha256: existsSync(speakabilityReportPath) ? await sha256File(speakabilityReportPath) : null,
    tts_spoken_overrides_sha256: existsSync(ttsSpokenOverridesPath) ? await sha256File(ttsSpokenOverridesPath) : null,
    run_identity_sha256: existsSync(path.join(episodeDir, "run_identity.json")) ? await sha256File(path.join(episodeDir, "run_identity.json")) : null,
  };
  const narrationTextIntegrityCoverage = {
    ...qwenTextIntegrityCoverageForTests(script, narrationGenerationPlan, { ttsOverrides: ttsSpokenOverrides, dialogueContext }),
    generated_at: new Date().toISOString(),
    source_script_hash: sourceScriptHash,
    source_script_path: scriptPath,
    narration_generation_plan_path: narrationGenerationPlanPath,
  };
  narrationGenerationPlan.text_integrity_coverage = narrationTextIntegrityCoverage;
  const systemUiCoverage = systemUiSpeechCoverage(script, narrationGenerationPlan, dialogueContext);
  narrationGenerationPlan.system_ui_speech_coverage = systemUiCoverage;
  const spokenTextAudit = buildTtsSpokenTextAudit({
    plan: narrationGenerationPlan,
    sourceScriptSha256: sourceScriptHash,
    sourceScriptPath: scriptPath,
    overridesSha256: narrationGenerationPlan.source_hashes.tts_spoken_overrides_sha256,
    planPath: narrationGenerationPlanPath,
    provider: providerContext.primary_provider,
    voiceId: narrationGenerationPlan.narrator_voice_id,
  });
  narrationGenerationPlan.tts_spoken_text_audit = {
    status: spokenTextAudit.status,
    path: spokenTextAuditPath,
    audit_sha256: spokenTextAudit.audit_sha256,
    unit_contract_sha256: spokenTextAudit.unit_contract_sha256,
    blocker_count: spokenTextAudit.blocker_count,
    warning_count: spokenTextAudit.warning_count,
  };
  const generationUnitsBySegment = new Map((narrationGenerationPlan.segments ?? []).map((segment) => [segment.segment_id, segment.generation_units ?? []]));
  const segments = baseSegments.map((segment) => ({
    ...segment,
    tts_provider: ttsProvider,
    generation_units: generationUnitsBySegment.get(segment.segment_id) ?? [],
    narration_generation_units: generationUnitsBySegment.get(segment.segment_id) ?? [],
    qwen_generation_units: generationUnitsBySegment.get(segment.segment_id) ?? [],
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
    unit_tts_policy: {
      enabled: unitBasedNarrator,
      primary_provider: providerContext.primary_provider,
      fallback_provider: providerContext.fallback_provider,
      canonical_generation_plan_path: narrationGenerationPlanPath,
      spoken_text_policy: "Use exact unit spoken_text/tts_spoken_text, preserve exact source and caption text separately, and never synthesize production-direction tags.",
      boundary_policy: "Respect merge_barrier and system/UI atomic boundaries. Stitch only at declared unit boundaries.",
    },
    kokoro_local_policy: {
      enabled: kokoroLocal,
      voice_id: providerContext.kokoro.voice_id,
      native_speed: providerContext.kokoro.native_speed,
      model_id: providerContext.kokoro.model_id,
      runtime: providerContext.kokoro.runtime,
      source_audio_required: false,
      instruction_delivery_supported: false,
      qwen_instruct_claimed: false,
      generation_plan_path: narrationGenerationPlanPath,
      delivery_policy: "Puck delivery comes from clean spoken text, punctuation, bounded units, native speed, and stitch timing. Kokoro does not receive or claim Qwen instruction prompts.",
    },
    qwen_local_policy: {
      enabled: qwenLocal,
      available_as_fallback: providerContext.fallback_provider === "qwen_local",
      provider: qwenConfig.provider ?? "qwen3-tts",
      production_default: providerRouting.audio?.production_tts_provider ?? null,
      fallback_provider: providerContext.fallback_provider,
      spoken_text_policy: "No bracketed emotion, breath, laugh, or stage tags in Qwen spoken text. Each request contains complete sentences only.",
      instruct_policy: "Qwen3-TTS Base receives no effective instruct. Delivery comes from exact spoken text, authored punctuation, sentence-complete unit boundaries with no forced minimum, dialogue separation, and the pinned reference clone.",
      request_policy: "One request per sentence-complete unit; no continuous longform requests.",
      post_tempo_processing: false,
      pronunciation_protocol: narrationGenerationPlan.pronunciation_protocol,
      generation_plan_path: qwenLocal ? qwenGenerationPlanPath : narrationGenerationPlanPath,
      script_speakability_status: scriptSpeakabilityReport.status ?? null,
      tts_spoken_overrides_loaded: ttsSpokenOverrides.replacements.length,
    },
    fish_s2_pro_policy: {
      model: fishAudioConfig.model ?? "s2-pro",
      role: unitBasedNarrator ? "fallback_or_bakeoff_only" : "production_provider",
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
      note: unitBasedNarrator
        ? "Fish S2-Pro metadata is retained only for fallback/bakeoff compatibility. The active local narrator provider uses narration_generation_plan.json."
        : "Fish S2-Pro can use bracketed natural-language direction and, when explicitly configured, multiple reference IDs with speaker tags. Public/restricted rights still need review before publishing.",
    },
    audio_performance_segments: segments,
  };
  const contentProfile = contentProfileForIdentity(runIdentity);
  const report = qualityReport(segments, { ttsProvider, contentProfile });
  if (narrationTextIntegrityCoverage.status !== "passed") {
    const textIntegrityFailure = {
      code: "narration_text_integrity_coverage_failed",
      legacy_code: "qwen_text_integrity_coverage_failed",
      severity: "blocker",
      findings: narrationTextIntegrityCoverage.findings,
    };
    report.status = "failed_repairable";
    report.failures.push(textIntegrityFailure);
    report.blockers.push(textIntegrityFailure);
  }
  if (systemUiCoverage.status !== "passed") {
    const systemUiFailure = {
      code: "system_ui_speech_coverage_missing",
      severity: "blocker",
      ...systemUiCoverage,
    };
    report.status = "failed_repairable";
    report.failures.push(systemUiFailure);
    report.blockers.push(systemUiFailure);
  }
  if (spokenTextAudit.status !== "passed") {
    const spokenTextFailure = {
      code: "tts_spoken_text_audit_failed",
      severity: "blocker",
      audit_path: spokenTextAuditPath,
      blockers: spokenTextAudit.blockers,
    };
    report.status = "failed_repairable";
    report.failures.push(spokenTextFailure);
    report.blockers.push(spokenTextFailure);
  }
  if (narrationGenerationPlan.kokoro_unit_boundary_integrity?.status === "blocked") {
    const boundaryFailure = {
      code: "sentence_unit_boundary_integrity_failed",
      severity: "blocker",
      ...narrationGenerationPlan.kokoro_unit_boundary_integrity,
    };
    report.status = "failed_repairable";
    report.failures.push(boundaryFailure);
    report.blockers.push(boundaryFailure);
  }
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
    operating_rules: kokoroLocal
      ? [
        `Kokoro local Puck (${providerContext.kokoro.voice_id}) is the production narrator at locked native speed ${providerContext.kokoro.native_speed}.`,
        "Synthesize exact narration_generation_units spoken_text/tts_spoken_text with no bracketed emotion, breath, laugh, or production-direction tags.",
        "Preserve exact source_text and caption_text separately; TTS-only pronunciation normalization must never leak into captions.",
        "Respect merge_barrier, system/UI atomic units, sentence boundaries, and declared stitch timing.",
        "Kokoro accepts no Qwen instruction prompt. Delivery comes from clean text, punctuation, unit boundaries, native speed, and the locked preset.",
        "The locked Qwen3 Base fallback uses exact text plus its pinned reference audio/transcript only; do not claim that an authored delivery note is submitted as an effective instruct.",
      ]
      : qwenLocal
      ? [
        `Qwen3-TTS 1.7B Base with the pinned ${providerContext.qwen3.target_voice_id} reference clone is the sole production narrator.`,
        "Spoken text must be clean: no bracketed emotion, breath, laugh, or stage tags.",
        "Use sentence-complete narration units with no forced minimum and a hard 60-word maximum.",
        providerContext.qwen3.synthesis_contract?.mode
          === QWEN_LIAM_BATCH4_SYNTHESIS_CONTRACT.mode
          ? "Synthesize deterministic length-matched cohorts of four through one resident model. The final cohort may contain one to three real units; never pad with dummy text. Restore original source order before QA and stitching."
          : "This existing run is pinned to serial one-unit requests. Never send a continuous longform request.",
        "Recover only the exact objectively truncated or operator-confirmed unit in explicit serial recovery mode; never change provider, model, reference voice, text, or generation settings.",
        "Qwen Base receives exact text plus the identity-locked reference audio/transcript only; do not claim an effective instruct channel.",
        "Stitch every adjacent unit with 80 ms of silence.",
        "Do not apply post-tempo processing or any unsupported native-speed control.",
        "Spell ambiguous rank/acronym tokens in spoken text when needed, e.g. SSS -> S S S.",
        "Preserve captions/story text separately from Qwen pronunciation-normalized spoken text.",
        "Apply approved tts_spoken_overrides.json only to tts_spoken_text, never to script_clean.md or captions.",
      ]
      : [
        "One dominant emotion per phrase.",
        "Tags apply to the following phrase.",
        "Physical tags take time; do not stack with pauses unless intentional.",
        "Use 15-25 larger emotional segments.",
        "Preserve sentence boundaries and story facts.",
        "Dialogue receives speaker-aware performance tags.",
      ],
    narration_generation_plan_path: narrationGenerationPlanPath,
    qwen_generation_plan_path: qwenLocal ? qwenGenerationPlanPath : null,
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
    status: kokoroLocal
      ? "passed"
      : qwenLocal
      ? missingQwenSourceRows.length ? "blocked_missing_qwen_voice_sources_or_transcripts" : "passed"
      : missingRefRoles.length ? explicitFallbackAllowed ? "missing_refs_fallback_allowed_for_tests" : "blocked_missing_dialogue_refs" : "passed",
    production_ready: kokoroLocal ? true : qwenLocal ? missingQwenSourceRows.length === 0 : missingRefRoles.length === 0,
    test_ready_with_fallback: kokoroLocal ? true : qwenLocal ? missingQwenSourceRows.length === 0 : missingRefRoles.length === 0 || explicitFallbackAllowed,
    generated_at: new Date().toISOString(),
    source_script_hash: sourceScriptHash,
    source_script_path: scriptPath,
    tts_provider: ttsProvider,
    narration_generation_plan_path: narrationGenerationPlanPath,
    qwen_generation_plan_path: qwenLocal ? qwenGenerationPlanPath : null,
    source_audio_required: kokoroLocal ? false : qwenLocal ? characterVoiceCastingEnabled() : true,
    preset_voice: kokoroLocal
      ? {
        voice_id: providerContext.kokoro.voice_id,
        model_id: providerContext.kokoro.model_id,
        model_revision: providerContext.kokoro.model_revision,
        runtime: providerContext.kokoro.runtime,
        native_speed: providerContext.kokoro.native_speed,
        policy: "Bundled Kokoro voice preset; no cloned/source audio is required.",
      }
      : null,
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
    recommendation: kokoroLocal
      ? `Kokoro preset ${providerContext.kokoro.voice_id} is complete and production-ready without source audio. Generate exact narration plan units and retain Qwen only as the declared fallback.`
      : qwenLocal
      ? missingQwenSourceRows.length
        ? "Generate/apply Qwen local voice-source designs and harden their transcripts with Whisper for every detected speaker, then rerun voice-plan."
        : unverifiedQwenTranscriptRows.length
          ? "All locked Qwen-local dialogue speakers have source audio and transcripts. Run qwen-tts harden-clone-transcripts before publish audio to verify transcripts against actual audio."
          : "All locked Qwen-local dialogue speakers have Whisper-verified source audio transcripts for production generation."
      : missingRefRoles.length
        ? `Add Fish reference IDs for: ${missingRefRoles.join(", ")} before final production, or explicitly accept narrator fallback.`
        : "All detected dialogue roles have configured reference IDs.",
  };
  await writeJson(path.join(episodeDir, "voice_reference_completeness_report.json"), referenceReport);
  if (!unitBasedNarrator || emitLegacyFishArtifacts) {
    await writeJson(path.join(episodeDir, "fish_reference_requirements_report.json"), {
      ...referenceReport,
      legacy_artifact: true,
      legacy_artifact_policy: unitBasedNarrator
        ? "emitted only because --emit-legacy-fish-artifacts true was passed"
        : "Fish is the active or fallback production TTS provider for this run",
    });
  }
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
  }, currentSourceText, {
    seriesPackage: dialogueContext.seriesPackage,
    trustedReferenceTexts: [
      providerContext.qwen3.reference_text,
      providerContext.kokoro.reference_text,
    ],
  });
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
  narrationGenerationPlan.status = report.status === "passed" ? "passed" : "failed_repairable";
  narrationGenerationPlan.canonical_plan_path = narrationGenerationPlanPath;
  narrationGenerationPlan.legacy_qwen_generation_plan_path = qwenLocal ? qwenGenerationPlanPath : null;
  narrationGenerationPlan.plan_sha256 = canonicalPlanHash(narrationGenerationPlan);
  report.voice_artifact_contamination = voiceContaminationReport;
  await writeJson(narrationGenerationPlanPath, narrationGenerationPlan);
  await writeJson(spokenTextAuditPath, spokenTextAudit);
  if (qwenLocal) {
    await writeJson(qwenGenerationPlanPath, {
      ...narrationGenerationPlan,
      legacy_artifact: true,
      compatibility_role: "explicit_qwen_provider_plan_alias",
      canonical_plan_path: narrationGenerationPlanPath,
      canonical_plan_sha256: narrationGenerationPlan.plan_sha256,
    });
  }
  await writeJson(path.join(episodeDir, "narration_text_integrity_coverage_report.json"), narrationTextIntegrityCoverage);
  if (qwenLocal) {
    await writeJson(path.join(episodeDir, "qwen_text_integrity_coverage_report.json"), {
      ...narrationTextIntegrityCoverage,
      legacy_artifact: true,
      compatibility_role: "explicit_qwen_provider_integrity_alias",
      canonical_plan_path: narrationGenerationPlanPath,
    });
  }
  await writeJson(path.join(episodeDir, "system_ui_speech_coverage_report.json"), {
    ...systemUiCoverage,
    source_script_hash: sourceScriptHash,
    source_script_path: scriptPath,
    narration_generation_plan_path: narrationGenerationPlanPath,
    narration_generation_plan_sha256: narrationGenerationPlan.plan_sha256,
    qwen_generation_plan_path: qwenLocal ? qwenGenerationPlanPath : null,
    generated_at: new Date().toISOString(),
  });
  await writeJson(path.join(episodeDir, "audio_performance_plan.json"), audioPerformancePlan);
  await writeJson(path.join(episodeDir, "voice_artifact_contamination_report.json"), voiceContaminationReport);
  await writeJson(path.join(episodeDir, `voice_artifact_contamination_report_${episode}.json`), voiceContaminationReport);
  if (!unitBasedNarrator || emitLegacyFishArtifacts) {
    const fishDiff = {
      status: "passed",
      source: "voice-direction-gate",
      generated_at: new Date().toISOString(),
      source_script_hash: sourceScriptHash,
      source_script_path: path.join(episodeDir, "script_clean.md"),
      source_segment_count: segments.length,
      fish_performance_script_hash: sha256Text(performanceText),
      stripped_narration_hash: sha256Text(strippedText),
      sfx_segments_excluded_from_fish_generation: segments.filter((segment) => segment.fish_generation_required === false).map((segment) => segment.segment_id),
      legacy_artifact: true,
      legacy_artifact_policy: unitBasedNarrator
        ? "emitted only because --emit-legacy-fish-artifacts true was passed"
        : "Fish is the active or fallback production TTS provider for this run",
      note: "Canonical Fish performance text is regenerated by voice-plan from audio_performance_plan; stale media-era scripts must not be used.",
    };
    await fs.writeFile(path.join(episodeDir, `narration_fish_performance_${episode}.txt`), performanceText, "utf8");
    await fs.writeFile(path.join(episodeDir, `narration_fish_stripped_${episode}.txt`), strippedText, "utf8");
    await fs.writeFile(path.join(episodeDir, "narration_fish_performance_ep_01.txt"), performanceText, "utf8");
    await fs.writeFile(path.join(episodeDir, "narration_fish_stripped_ep_01.txt"), strippedText, "utf8");
    await writeJson(path.join(episodeDir, `narration_fish_diff_${episode}.json`), fishDiff);
    await writeJson(path.join(episodeDir, "narration_fish_diff_ep_01.json"), fishDiff);
  }
  await fs.writeFile(path.join(episodeDir, "voice_director_debug_script.txt"), segments.slice(0, 8).map((segment) => segment.text).join("\n\n"), "utf8");
  await writeJson(path.join(episodeDir, `voice_direction_strategy_${episode}.json`), strategy);
  await writeJson(path.join(episodeDir, "voice_direction_strategy_ep_01.json"), strategy);
  await writeJson(path.join(episodeDir, `voice_direction_quality_report_${episode}.json`), report);
  await writeJson(path.join(episodeDir, "voice_direction_quality_report_ep_01.json"), report);
  await writeJson(path.join(episodeDir, `dialogue_performance_audit_${episode}.json`), dialogueAudit);
  await writeJson(path.join(episodeDir, "dialogue_performance_audit_ep_01.json"), dialogueAudit);
  await writeJson(path.join(episodeDir, "dialogue_map.json"), dialogueMap);
  console.log(JSON.stringify({
    stage: "voice-plan",
    status: report.status,
    tts_provider: ttsProvider,
    unique_tags: report.unique_tags,
    segment_count: segments.length,
    narration_generation_plan: narrationGenerationPlanPath,
    narration_generation_plan_sha256: narrationGenerationPlan.plan_sha256,
    qwen_generation_plan: qwenLocal ? qwenGenerationPlanPath : null,
    failures: report.failures,
  }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
