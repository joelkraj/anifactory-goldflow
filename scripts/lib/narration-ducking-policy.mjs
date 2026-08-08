export const DEFAULT_NARRATION_DUCKING_POLICY = Object.freeze({
  threshold: 0.022,
  ratio: 7,
  attack_ms: 12,
  release_ms: 390,
  silence_surge_cap: Object.freeze({
    threshold: 0.016,
    ratio: 6,
    attack_ms: 20,
    release_ms: 200,
  }),
});

function finiteWithin(value, fallback, minimum, maximum, label) {
  const numeric = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}; received ${value}.`);
  }
  return numeric;
}

export function resolveNarrationDuckingPolicy(overrides = {}) {
  const capOverrides = overrides.silence_surge_cap ?? {};
  return {
    threshold: finiteWithin(
      overrides.threshold,
      DEFAULT_NARRATION_DUCKING_POLICY.threshold,
      0.000976563,
      1,
      "Narration duck threshold",
    ),
    ratio: finiteWithin(
      overrides.ratio,
      DEFAULT_NARRATION_DUCKING_POLICY.ratio,
      1,
      20,
      "Narration duck ratio",
    ),
    attack_ms: finiteWithin(
      overrides.attack_ms ?? overrides.attackMs,
      DEFAULT_NARRATION_DUCKING_POLICY.attack_ms,
      0.01,
      2000,
      "Narration duck attack",
    ),
    release_ms: finiteWithin(
      overrides.release_ms ?? overrides.releaseMs,
      DEFAULT_NARRATION_DUCKING_POLICY.release_ms,
      0.01,
      9000,
      "Narration duck release",
    ),
    silence_surge_cap: {
      threshold: finiteWithin(
        capOverrides.threshold ?? overrides.silence_surge_cap_threshold,
        DEFAULT_NARRATION_DUCKING_POLICY.silence_surge_cap.threshold,
        0.000976563,
        1,
        "Music silence-surge cap threshold",
      ),
      ratio: finiteWithin(
        capOverrides.ratio ?? overrides.silence_surge_cap_ratio,
        DEFAULT_NARRATION_DUCKING_POLICY.silence_surge_cap.ratio,
        1,
        20,
        "Music silence-surge cap ratio",
      ),
      attack_ms: finiteWithin(
        capOverrides.attack_ms ?? capOverrides.attackMs ?? overrides.silence_surge_cap_attack_ms,
        DEFAULT_NARRATION_DUCKING_POLICY.silence_surge_cap.attack_ms,
        0.01,
        2000,
        "Music silence-surge cap attack",
      ),
      release_ms: finiteWithin(
        capOverrides.release_ms ?? capOverrides.releaseMs ?? overrides.silence_surge_cap_release_ms,
        DEFAULT_NARRATION_DUCKING_POLICY.silence_surge_cap.release_ms,
        0.01,
        9000,
        "Music silence-surge cap release",
      ),
    },
  };
}

export function narrationDuckingFilter(overrides = {}) {
  const policy = resolveNarrationDuckingPolicy(overrides);
  return [
    `sidechaincompress=threshold=${policy.threshold}`,
    `ratio=${policy.ratio}`,
    `attack=${policy.attack_ms}`,
    `release=${policy.release_ms}`,
  ].join(":");
}

export function narrationDuckingFilterChain(overrides = {}) {
  const policy = resolveNarrationDuckingPolicy(overrides);
  const cap = policy.silence_surge_cap;
  return [
    narrationDuckingFilter(policy),
    `acompressor=threshold=${cap.threshold}:ratio=${cap.ratio}:attack=${cap.attack_ms}:release=${cap.release_ms}`,
  ].join(",");
}
