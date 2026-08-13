import { promises as fs } from "node:fs";
import path from "node:path";

export const SOURCE_NAME_FAMILIARITY_SCHEMA = "goldflow_source_name_familiarity_v1";
export const DEFAULT_NAME_TTL_EPISODES = 12;

export function titleSignalsContinuation(title) {
  return /\b(?:part|episode|ep\.?)\s*(?:[2-9]|\d{2,}|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(String(title ?? ""));
}

export function continuationExemptNameFamiliarityLedger({ ttlEpisodes = DEFAULT_NAME_TTL_EPISODES } = {}) {
  return {
    schema: SOURCE_NAME_FAMILIARITY_SCHEMA,
    policy: "continuation_exempt",
    applies: false,
    ttl_episodes: ttlEpisodes,
    exempt_names: ["Joey", "Joey Manhwa", "all established continuation cast"],
    guidance: "This development is a continuation. Preserve established cast names and introduce new names only when the story adds new characters; channel-recency weights do not apply.",
    names: [],
  };
}

function cleanName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizedName(value) {
  return cleanName(value).toLocaleLowerCase("en-US");
}

export function familiarityWeight(ageEpisodes, ttlEpisodes = DEFAULT_NAME_TTL_EPISODES) {
  if (!Number.isInteger(ageEpisodes) || ageEpisodes < 0) return 0;
  if (!Number.isInteger(ttlEpisodes) || ttlEpisodes < 1 || ageEpisodes >= ttlEpisodes) return 0;
  const recency = 1 - (ageEpisodes / ttlEpisodes);
  return Number((0.15 + (0.70 * recency)).toFixed(3));
}

export function buildSourceNameFamiliarityLedger(releases, {
  ttlEpisodes = DEFAULT_NAME_TTL_EPISODES,
  exemptNames = ["Joey", "Joey Manhwa"],
} = {}) {
  const ordered = [...releases]
    .filter((release) => release && typeof release === "object")
    .sort((left, right) => String(right.released_at ?? "").localeCompare(String(left.released_at ?? "")));
  const exemptions = new Set(exemptNames.map(normalizedName));
  const names = new Map();
  for (const [ageEpisodes, release] of ordered.entries()) {
    if (release.schema !== "goldflow_source_room_release_v2" || release.status !== "released") continue;
    const weight = familiarityWeight(ageEpisodes, ttlEpisodes);
    if (weight === 0) continue;
    for (const row of release.character_name_usage ?? []) {
      if (row?.reuse_disposition === "series_recurring") continue;
      const name = cleanName(row?.name);
      const key = normalizedName(name);
      if (!name || exemptions.has(key)) continue;
      const current = names.get(key) ?? {
        name,
        familiarity_weight: 0,
        most_recent_age_episodes: ageEpisodes,
        occurrences_within_ttl: 0,
        prior_roles: [],
        source_release_paths: [],
      };
      current.familiarity_weight = Math.max(current.familiarity_weight, weight);
      current.most_recent_age_episodes = Math.min(current.most_recent_age_episodes, ageEpisodes);
      current.occurrences_within_ttl += 1;
      if (cleanName(row?.role) && !current.prior_roles.includes(cleanName(row.role))) current.prior_roles.push(cleanName(row.role));
      if (release.__release_path && !current.source_release_paths.includes(release.__release_path)) current.source_release_paths.push(release.__release_path);
      names.set(key, current);
    }
  }
  return {
    schema: SOURCE_NAME_FAMILIARITY_SCHEMA,
    policy: "soft_decaying_preference",
    ttl_episodes: ttlEpisodes,
    exempt_names: [...exemptNames],
    guidance: "A higher weight means prefer a different natural, story-appropriate supporting-character name when choices are otherwise equal. Reuse remains allowed when it materially fits the story or denotes an approved recurring series character.",
    names: [...names.values()].sort((left, right) => right.familiarity_weight - left.familiarity_weight || left.name.localeCompare(right.name)),
  };
}

async function findReleasePaths(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name === "source_room_release_v2.json") found.push(candidate);
    }
  }
  await visit(root);
  return found;
}

export async function buildSourceNameFamiliarityLedgerFromDisk(sourceDevelopmentRoot, {
  excludeDirectory = null,
  ttlEpisodes = DEFAULT_NAME_TTL_EPISODES,
} = {}) {
  const releasePaths = await findReleasePaths(sourceDevelopmentRoot);
  const releases = [];
  for (const releasePath of releasePaths) {
    if (excludeDirectory && releasePath.startsWith(`${path.resolve(excludeDirectory)}${path.sep}`)) continue;
    const document = JSON.parse(await fs.readFile(releasePath, "utf8"));
    releases.push({ ...document, __release_path: releasePath });
  }
  return buildSourceNameFamiliarityLedger(releases, { ttlEpisodes });
}

export function validateSourceNameFamiliarityLedger(document) {
  const blockers = [];
  if (document?.schema !== SOURCE_NAME_FAMILIARITY_SCHEMA) blockers.push("name_familiarity_schema_invalid");
  if (!["soft_decaying_preference", "continuation_exempt"].includes(document?.policy)) blockers.push("name_familiarity_policy_invalid");
  if (document?.policy === "continuation_exempt" && document?.applies !== false) blockers.push("name_familiarity_continuation_applies_invalid");
  if (!Number.isInteger(document?.ttl_episodes) || document.ttl_episodes < 1) blockers.push("name_familiarity_ttl_invalid");
  if (!Array.isArray(document?.exempt_names)) blockers.push("name_familiarity_exemptions_invalid");
  if (!Array.isArray(document?.names)) blockers.push("name_familiarity_names_invalid");
  for (const [index, row] of (document?.names ?? []).entries()) {
    if (!cleanName(row?.name)) blockers.push(`name_familiarity_${index}_name_missing`);
    if (!Number.isFinite(row?.familiarity_weight) || row.familiarity_weight <= 0 || row.familiarity_weight > 1) blockers.push(`name_familiarity_${index}_weight_invalid`);
    if (!Number.isInteger(row?.most_recent_age_episodes) || row.most_recent_age_episodes < 0) blockers.push(`name_familiarity_${index}_age_invalid`);
    if (!Number.isInteger(row?.occurrences_within_ttl) || row.occurrences_within_ttl < 1) blockers.push(`name_familiarity_${index}_occurrences_invalid`);
  }
  return { done: blockers.length === 0, blockers };
}
