// Opt-in admission policy. Historical identities keep their existing capacities.
export const CONSERVATIVE_GOOGLE_IMAGE_SCHEDULING = Object.freeze({
  schema: "goldflow_google_image_scheduling_v1",
  policy_id: "conservative_three_lane_v1",
  total_concurrency: 3,
  google_flow_concurrency: 2,
  google_gemini_concurrency: 1,
  minimum_submit_interval_ms: 45_000,
  submit_jitter_max_ms: 5_000,
  shared_gate_required: true,
});

export function googleImageSchedulingPolicy(value) {
  if (value == null || value === "") return null;
  if (value !== CONSERVATIVE_GOOGLE_IMAGE_SCHEDULING.policy_id) {
    throw new Error(`Unsupported Google image scheduling policy: ${value}.`);
  }
  return { ...CONSERVATIVE_GOOGLE_IMAGE_SCHEDULING };
}

export function googleImageSchedulingForIdentity(identity = {}) {
  const contract = identity.image_provider_options?.scheduling;
  if (contract == null) {
    if (identity.provider_locks?.image_scheduling != null) throw new Error("Google image scheduling options are missing from the locked identity.");
    return null;
  }
  const expected = CONSERVATIVE_GOOGLE_IMAGE_SCHEDULING;
  for (const [name, value] of Object.entries(expected)) {
    if (contract[name] !== value || identity.provider_locks?.image_scheduling?.[name] !== value) {
      throw new Error(`Google image scheduling identity mismatch: ${name}.`);
    }
  }
  if (Object.keys(contract).length !== Object.keys(expected).length
    || Object.keys(identity.provider_locks.image_scheduling).length !== Object.keys(expected).length) {
    throw new Error("Google image scheduling identity has unsupported fields.");
  }
  return { ...expected };
}
