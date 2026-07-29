const PRESENCE_VALUES = new Set(["none", "implied", "explicit"]);
const POPULATION_CUE = /\b(?:audience|attendees?|bystanders?|cadets?|citizens?|civilians?|classmates?|clerks?|commuters?|creators?|crew|crews|crowd|customers?|delegates?|divers?|employees?|engineers?|extras?|families|fans|figures?|goblins?|guards?|guests?|guild members?|hunters?|investigators?|jurors?|listeners?|members?|monsters?|nobles?|observers?|occupants?|officials?|onlookers?|operators?|participants?|passengers?|patrons?|people|prisoners?|reporters?|residents?|shoppers?|silhouettes?|soldiers?|spectators?|staff|stewards?|students?|supporters?|teams?|trainees?|viewers?|villagers?|warriors?|witnesses?|workers?)\b/i;

function clean(value) {
  return String(value ?? "").trim();
}

export function sanitizeBackgroundPopulation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { presence: "none", description: null, evidence: null, staging: null };
  }
  const requestedPresence = clean(value.presence).toLowerCase();
  const presence = PRESENCE_VALUES.has(requestedPresence) ? requestedPresence : "none";
  return {
    presence,
    description: clean(value.description) || null,
    evidence: clean(value.evidence) || null,
    staging: clean(value.staging) || null,
  };
}

export function backgroundPopulationIsRequired(value) {
  return ["implied", "explicit"].includes(sanitizeBackgroundPopulation(value).presence);
}

export function backgroundPopulationFindings(prompt) {
  const population = sanitizeBackgroundPopulation(prompt?.shot_manifest?.background_population);
  if (!backgroundPopulationIsRequired(population)) return [];
  const base = {
    image_id: prompt?.image_id ?? null,
    scene_id: prompt?.scene_id ?? null,
    severity: "blocker",
    resolved: false,
  };
  const findings = [];
  if (!population.description || !population.staging) {
    findings.push({
      ...base,
      code: "background_population_contract_incomplete",
      message: "An implied or explicit background population needs both a concrete description and staging.",
    });
  }
  const promptText = [
    prompt?.provider_prompt,
    prompt?.modelslab_image_prompt,
    prompt?.image_prompt,
    prompt?.codex_image_prompt,
  ].filter(Boolean).join(" ");
  if (!POPULATION_CUE.test(promptText)) {
    findings.push({
      ...base,
      code: "background_population_missing_from_prompt",
      message: `The ${population.presence} background population is present in shot_manifest but absent from provider prompt prose.`,
    });
  }
  return findings;
}

export function backgroundPopulationCuePresent(value) {
  return POPULATION_CUE.test(String(value ?? ""));
}
