import { createHash } from "node:crypto";
import { assertAvailableMediaWorkflow } from "./media-workflows.mjs";

export const PANEL_PRODUCTION_RENDER_PROFILE = "panel_composition_v1";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

// Scene-art allocation route locked into the contract of NEW panel identities
// (R10). Dense multi-zone pages are the production default; a historical
// identity whose contract carries no allocation_route keeps its recorded
// legacy authored route and is never rewritten.
export const PANEL_ALLOCATION_ROUTE_DENSE = "dense_pages_v1";
export const PANEL_ALLOCATION_ROUTE_LEGACY = "legacy_authored_v1";
export const DENSE_PAGES_ALLOCATION_ROUTE = Object.freeze({
  id: PANEL_ALLOCATION_ROUTE_DENSE,
  plan_schema: "goldflow_panel_asset_plan_v2",
  beats_per_generation: 5,
  page_canvas: Object.freeze({ width: 3840, height: 2160 }),
  page_reference_board: Object.freeze({ width: 1024, height: 576 }),
  author_command: "visual panel-assets --action author-dense",
  import_approver: "automated:allocation_validator",
});

function contractBody({ allocationRoute }) {
  return {
    schema: "goldflow_panel_production_contract_v1",
    id: PANEL_PRODUCTION_RENDER_PROFILE,
    version: allocationRoute ? "2026-10-20.1" : "2026-10-17.1",
    content_profile: "manhwa_recap_v1",
    media_workflow: "generated_visuals_v1",
    asset_policy: "authored_reuse_before_generation",
    composition_schema: "goldflow_panel_production_timeline_v1",
    canvas: { width: 1920, height: 1080, fps: 30 },
    audio_target: "narrator_only",
    generated_motion_policy: "disabled",
    parallax_policy: "disabled",
    ...(allocationRoute ? { allocation_route: structuredClone(allocationRoute) } : {}),
  };
}
function sealed(body) {
  return { ...body, sha256: createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex") };
}

/** New identities lock the dense-page route; pass { allocationRoute: null } only to reproduce the legacy contract. */
export function createPanelProductionContract({ allocationRoute = DENSE_PAGES_ALLOCATION_ROUTE } = {}) {
  return sealed(contractBody({ allocationRoute }));
}
export const createLegacyPanelProductionContract = () => createPanelProductionContract({ allocationRoute: null });

/** The locked allocation route of a panel identity: dense_pages_v1, or legacy_authored_v1 for historical contracts. */
export function panelAllocationRoute(identity = {}) {
  return identity?.panel_composition_contract?.allocation_route?.id === PANEL_ALLOCATION_ROUTE_DENSE ? PANEL_ALLOCATION_ROUTE_DENSE : PANEL_ALLOCATION_ROUTE_LEGACY;
}

export function isPanelProductionIdentity(identity = {}) {
  return identity?.render_profile === PANEL_PRODUCTION_RENDER_PROFILE;
}

export function assertPanelProductionIdentity(identity = {}) {
  if (!isPanelProductionIdentity(identity)) throw new Error("Panel composition requires a new identity locked to render_profile panel_composition_v1.");
  if (identity.schema !== "goldflow_run_identity_v2" || identity.content_profile !== "manhwa_recap_v1"
    || identity.content_profile_config?.id != null && identity.content_profile_config.id !== "manhwa_recap_v1"
    || identity.media_workflow !== "generated_visuals_v1" || identity.run_intent !== "production") {
    throw new Error("Panel composition requires a production v2 manhwa_recap_v1 + generated_visuals_v1 identity; existing identities cannot be migrated.");
  }
  assertAvailableMediaWorkflow(identity);
  const recorded = JSON.stringify(canonical(identity.panel_composition_contract));
  const expected = [createPanelProductionContract(), createLegacyPanelProductionContract()].find((contract) => JSON.stringify(canonical(contract)) === recorded);
  if (!expected) throw new Error("Panel composition contract is missing, unsupported, or has a stale hash.");
  if (identity.audio_target !== "narrator_only" || identity.generated_motion_policy !== "disabled"
    || identity.parallax_policy !== "disabled"
    || [identity.animation_policy, identity.ltx_video_policy].some((value) => value != null && value !== "disabled")
    || Number(identity.generated_motion_required_through_sec ?? 0) !== 0) {
    throw new Error("Panel composition v1 requires narrator_only audio, disabled generated motion and disabled parallax.");
  }
  return expected;
}

// Check user intent before defaults can silently discard an incompatible request.
export function assertPanelProductionPreflightFlags(flags = {}, { contentProfile, mediaWorkflow } = {}) {
  const requested = flags["render-profile"] ?? flags.render;
  if (requested !== PANEL_PRODUCTION_RENDER_PROFILE) return false;
  if (contentProfile !== "manhwa_recap_v1" || mediaWorkflow !== "generated_visuals_v1") throw new Error("panel_composition_v1 supports manhwa_recap_v1 + generated_visuals_v1 only.");
  for (const name of ["intent", "run-intent"]) {
    if (flags[name] != null && flags[name] !== "production") throw new Error("panel_composition_v1 requires production intent; private proofs retain their separate commands and identities.");
  }
  for (const name of ["render-profile", "render", "motion"]) {
    if (flags[name] != null && flags[name] !== PANEL_PRODUCTION_RENDER_PROFILE) throw new Error(`panel_composition_v1 conflicts with --${name} ${flags[name]}.`);
  }
  for (const name of ["audio-target", "audio"]) {
    if (flags[name] != null && flags[name] !== "narrator_only") throw new Error(`panel_composition_v1 requires --${name} narrator_only.`);
  }
  for (const name of ["generated-motion-policy", "animation-policy", "ltx-video-policy", "parallax-policy"]) {
    if (flags[name] != null && flags[name] !== "disabled") throw new Error(`panel_composition_v1 requires --${name} disabled.`);
  }
  for (const name of ["generated-motion-provider", "video-provider", "generated-motion-model", "video-model", "parallax-background-provider"]) {
    if (flags[name] != null) throw new Error(`panel_composition_v1 does not support --${name}.`);
  }
  for (const [name, expected] of [["width", 1920], ["height", 1080], ["fps", 30], ["generated-motion-required-through-sec", 0]]) {
    if (flags[name] != null && Number(flags[name]) !== expected) throw new Error(`panel_composition_v1 requires --${name} ${expected}.`);
  }
  return true;
}
