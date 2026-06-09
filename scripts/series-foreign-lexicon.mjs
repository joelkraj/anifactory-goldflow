const SERIES_FOREIGN_TERM_GROUPS = {
  rebirth_53: [
    { id: "haru", label: "Haru", terms: ["Haru"] },
    { id: "dae_ho", label: "Dae-ho", patterns: ["\\bDae-?ho\\b", "\\bKang Dae\\b", "\\bKang Dae-ho\\b"] },
    { id: "seo_yuna", label: "Seo Yuna", patterns: ["\\bSeo Yuna\\b", "\\bSeo-?jin\\b", "\\bKang Seo\\b"] },
    { id: "kang_house", label: "Kang House", terms: ["Kang House", "Kang access"] },
    { id: "phone_scam", label: "phone scam", terms: ["phone scam", "phone seller"] },
    { id: "rice_ball", label: "rice ball", terms: ["rice ball", "rice cup"] },
    { id: "timeline_ledger", label: "timeline ledger", terms: ["timeline ledger"] },
    { id: "fading_loved_one", label: "fading loved one", terms: ["fading loved one", "fading handprint", "fading child"] },
    { id: "old_record_owner", label: "old record owner", terms: ["old record owner"] },
  ],
  negative_level: [
    { id: "hyun_woo", label: "Hyun-woo", patterns: ["\\bHyun-?woo\\b", "\\bCha Hyun\\b", "\\bCha Hyun[- ]woo\\b"] },
    { id: "copper_name_tag", label: "copper name tag", terms: ["copper name tag", "CHA MIN-SEO", "M-144"] },
    { id: "exam_bracelet", label: "exam bracelet", terms: ["exam bracelet", "bracelet", "storage space", "candidate hunter", "masked evaluator", "north-lab transfer", "pre-tutorial", "familiar license"] },
    { id: "rank_terms", label: "rank/system terms", patterns: ["\\bF-rank\\b", "\\bM-rank\\b", "\\bSSS\\s*Rank\\s*Crystal\\b"] },
  ],
  mageless: [
    { id: "mageless", label: "Mageless", terms: ["Mageless", "SSS Rank Crystal"] },
  ],
  retail_crate: [
    { id: "crate_king", label: "Crate King", terms: ["Crate King", "debt bell"] },
  ],
  miscellaneous_series: [
    { id: "se_ra", label: "Se-ra", terms: ["Se-ra", "Yoon Se-ra"] },
  ],
};

const PROTECTED_IP_TERM_SPECS = [
  { id: "renji", label: "Renji", terms: ["Renji"] },
  { id: "yuji", label: "Yuji", terms: ["Yuji", "Yuji-style"] },
  { id: "gojo", label: "Gojo", terms: ["Gojo", "Gojo-style"] },
  { id: "keanu", label: "Keanu", terms: ["Keanu", "Keanu-style"] },
  { id: "thragg", label: "Thragg", terms: ["Thragg", "Thragg-style"] },
  { id: "dexter", label: "Dexter", terms: ["Dexter", "Dexter-style"] },
  { id: "ishowspeed", label: "IShowSpeed", patterns: ["\\bIShowSpeed[- ]style\\b", "\\bIshowspeed\\b", "\\bIShowSpeed\\b"] },
  { id: "naruto", label: "Naruto", terms: ["Naruto"] },
  { id: "solo_leveling", label: "Solo Leveling", terms: ["Solo Leveling"] },
  { id: "jujutsu", label: "Jujutsu", terms: ["Jujutsu"] },
  { id: "demon_slayer", label: "Demon Slayer", terms: ["Demon Slayer"] },
  { id: "one_piece", label: "One Piece", terms: ["One Piece"] },
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSlug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function currentSeriesSlugs({ channel = "", series = "", seriesPackage = {} } = {}) {
  return [
    channel,
    series,
    seriesPackage.series_slug,
    seriesPackage.slug,
    seriesPackage.title,
    seriesPackage.series_title,
    seriesPackage.premise,
  ].map(normalizeSlug).filter(Boolean);
}

function groupIsNative(groupId, slugs) {
  const joined = slugs.join(" ");
  if (groupId === "rebirth_53") return /\b(?:53rebirth|rebirth-bitcoin|future-son|kang-dae|haru)\b/.test(joined);
  if (groupId === "negative_level") return /\b(?:negative-level|hyun-woo|storage-space|rankless|exam)\b/.test(joined);
  if (groupId === "mageless") return /\bmageless\b/.test(joined);
  if (groupId === "retail_crate") return /\bcrate-king\b/.test(joined);
  return false;
}

function normalizeSpec(raw) {
  if (typeof raw === "string") return { id: raw.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: raw, terms: [raw] };
  return raw && typeof raw === "object" ? raw : null;
}

function specPattern(spec) {
  const pieces = [
    ...(spec.patterns ?? []),
    ...(spec.terms ?? []).map((term) => `\\b${escapeRegExp(term)}\\b`),
  ].filter(Boolean);
  if (!pieces.length) return null;
  return new RegExp(pieces.join("|"), "i");
}

export function compileTermSpecs(specs = []) {
  return specs
    .map(normalizeSpec)
    .filter(Boolean)
    .map((spec) => ({ ...spec, pattern: spec.pattern instanceof RegExp ? spec.pattern : specPattern(spec) }))
    .filter((spec) => spec.pattern);
}

export function protectedIpTermSpecs() {
  return compileTermSpecs(PROTECTED_IP_TERM_SPECS);
}

export function foreignSeriesTermSpecs({ channel = "", series = "", seriesPackage = {} } = {}) {
  const explicit = seriesPackage.foreign_series_terms
    ?? seriesPackage.cross_series_foreign_terms
    ?? seriesPackage.contamination_foreign_terms
    ?? null;
  if (Array.isArray(explicit) && explicit.length) return compileTermSpecs(explicit);
  const slugs = currentSeriesSlugs({ channel, series, seriesPackage });
  const specs = [];
  for (const [groupId, groupSpecs] of Object.entries(SERIES_FOREIGN_TERM_GROUPS)) {
    if (groupIsNative(groupId, slugs)) continue;
    specs.push(...groupSpecs);
  }
  return compileTermSpecs(specs);
}

export function resetAndTest(pattern, text) {
  if (!(pattern instanceof RegExp)) return false;
  pattern.lastIndex = 0;
  const result = pattern.test(String(text ?? ""));
  pattern.lastIndex = 0;
  return result;
}
