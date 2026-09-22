import { readFileSync } from "node:fs";
import path from "node:path";
import { contentProfileDefinition, DEFAULT_CONTENT_PROFILE } from "./content-profiles.mjs";
import { commandStageFor } from "./pipeline-stage-registry.mjs";
import { packagingWorkflowSupport } from "./youtube-publish-contract.mjs";
import {
  assertAvailableMediaWorkflow,
  mediaWorkflowForPreflight,
} from "./media-workflows.mjs";

const EPISODE_RUN_COMMANDS = new Set([
  "status", "relock-tts", "performance-audit", "reference-roi", "media-ready",
  "advance", "director", "audio-semantic-fork", "visual-wavefront",
  "import-proof-baseline", "cleanup",
]);

// These audited entrypoints derive their working directory only from the tuple;
// accepting --episode-dir here would make the guard inspect a different run.
const TUPLE_ONLY_EPISODE_SCRIPTS = new Set([
  "run-preflight.mjs", "source-ingest.mjs", "script-speakability-plan.mjs",
  "script-targeted-speakability.mjs", "semantic-scene-plan.mjs", "voice-direction-gate.mjs",
  "timing-bind.mjs", "visual-beat-plan.mjs", "visual-plan.mjs", "visual-reference-plan.mjs",
  "visual-prompt-review.mjs", "visual-prompt-harden.mjs", "engagement-overlay-plan.mjs",
  "visual-transition-plan.mjs", "imagegen.mjs", "codex-image-manual-import.mjs",
  "codex-image-import-staged.mjs", "render.mjs", "audio-sfx-score-enrichment.mjs",
  "audio-score-drop-plan-chunked.mjs", "audio-ambience-repair.mjs",
]);

function assertTupleOnlyContext(script, flags) {
  if (!TUPLE_ONLY_EPISODE_SCRIPTS.has(script)) return;
  if (Object.hasOwn(flags, "episode-dir")) {
    throw new Error(`Episode workflow routing: ${script} does not support --episode-dir; use complete --channel, --week, and --episode flags so the guard and child target the same run.`);
  }
  if (["channel", "week", "episode"].some((key) => typeof flags[key] !== "string" || !flags[key].trim())) {
    throw new Error(`Episode workflow routing: ${script} requires complete --channel, --week, and --episode flags; implicit default episode paths are not allowed.`);
  }
}

// Routing is an identity boundary, not a skippable stage-order check. Keep this
// read-only and call it before execution provenance can create episode files.
export function readEpisodeRoutingIdentity(episodeDir) {
  if (!episodeDir) return null;
  const identityPath = path.join(episodeDir, "run_identity.json");
  let bytes;
  try {
    bytes = readFileSync(identityPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read run identity for workflow routing: ${identityPath}`, { cause: error });
  }
  let identity;
  try {
    identity = JSON.parse(bytes);
  } catch (error) {
    throw new Error(`Invalid run identity JSON for workflow routing: ${identityPath}`, { cause: error });
  }
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error(`Run identity must be an object for workflow routing: ${identityPath}`);
  }
  return identity;
}

export function assertEpisodeWorkflowFlags(identity = {}, flags = {}) {
  const workflow = assertAvailableMediaWorkflow(identity);
  if (Object.hasOwn(flags, "media-workflow") && flags["media-workflow"] !== workflow.id) {
    throw new Error(`Media workflow is identity-locked to ${workflow.id}; --media-workflow cannot switch an existing run.`);
  }
  if (Object.hasOwn(flags, "content-profile")) {
    const requested = contentProfileDefinition(flags["content-profile"]);
    const locked = identity.content_profile_config?.id ?? identity.content_profile ?? DEFAULT_CONTENT_PROFILE;
    if (requested.config.id !== locked) {
      throw new Error(`Content profile is identity-locked to ${locked}; --content-profile cannot switch an existing run.`);
    }
  }
  return workflow;
}

export function assertCommandWorkflowRoute({ command, subcommand, script, flags = {}, episodeDir = null }) {
  if (command === "footage") return null;
  const preflight = command === "run" && subcommand === "preflight";
  const requiresEpisodeContext = !preflight && (
    commandStageFor(command, subcommand, flags) !== null
    || (command === "run" && EPISODE_RUN_COMMANDS.has(subcommand))
    || script === "youtube-publish.mjs"
    || TUPLE_ONLY_EPISODE_SCRIPTS.has(script)
  );
  // Many older child scripts have production-directory defaults. Never let an
  // omitted/partial context skip identity routing and then dispatch to those
  // defaults, including when the ordinary stage-order guard is bypassed.
  if (requiresEpisodeContext && !episodeDir) {
    throw new Error("Episode workflow routing requires explicit --episode-dir or complete --channel, --week, and --episode flags before execution; implicit default episode paths are not allowed.");
  }
  if ((requiresEpisodeContext || preflight) && Object.hasOwn(flags, "episodeDir")) {
    throw new Error("Episode workflow routing does not accept the ambiguous --episodeDir alias; use --episode-dir for supported commands or complete --channel, --week, and --episode flags.");
  }
  const identity = readEpisodeRoutingIdentity(episodeDir);
  if (preflight) {
    const binding = mediaWorkflowForPreflight({
      contentProfile: flags["content-profile"],
      mediaWorkflow: flags["media-workflow"],
    });
    if (binding.media_workflow === "avatar_footage_pilot_v1") throw new Error("Use pilot preflight for the bounded avatar proof; run preflight is generated-visuals only.");
    // Validate custom profile paths too, before beginStageExecution can write.
    const profile = contentProfileDefinition(flags["content-profile"]);
    assertAvailableMediaWorkflow({ ...binding, content_profile: profile.config.id, content_profile_config: profile.config });
    assertTupleOnlyContext(script, flags);
    if (identity) throw new Error("Run identity already exists. Preflight cannot overwrite or migrate an existing run.");
    return binding;
  }
  let workflow = null;
  if (identity) {
    workflow = assertEpisodeWorkflowFlags(identity, flags);
    if (identity.image_provider === "openart_cli") {
      const imageMutation = command === "imagegen" && !["openart", "analyze", "qa"].includes(subcommand);
      const visualMutation = command === "visual" && ["refs", "approve-ref-plan", "approve-refs", "plan", "harden", "review"].includes(subcommand);
      if (imageMutation || visualMutation) throw new Error("OpenArt identities require the guarded OpenArt bank/generation adapter; other provider or reference dispatch paths cannot satisfy this identity.");
      if ((flags["image-provider"] ?? flags.provider) && !["openart", "openart_cli"].includes(flags["image-provider"] ?? flags.provider)) throw new Error("The OpenArt image provider is identity-locked.");
    }
    if (workflow.id === "avatar_footage_pilot_v1" && command !== "pilot" && !(command === "run" && subcommand === "status")) {
      throw new Error("Avatar pilot permits only pilot commands and run status. Generated production, source manufacture, auto-advance and publishing are unavailable, including with workflow bypass.");
    }
    if (script === "youtube-publish.mjs") {
      const support = packagingWorkflowSupport(identity);
      if (!support.available) throw new Error(support.reason);
    }
  } else if (Object.hasOwn(flags, "media-workflow") || Object.hasOwn(flags, "content-profile")) {
    const contentProfile = flags["content-profile"] ?? DEFAULT_CONTENT_PROFILE;
    const binding = mediaWorkflowForPreflight({
      contentProfile,
      mediaWorkflow: flags["media-workflow"] ?? "generated_visuals_v1",
    });
    const profile = contentProfileDefinition(contentProfile);
    workflow = assertAvailableMediaWorkflow({ ...binding, content_profile: profile.config.id, content_profile_config: profile.config });
  }
  assertTupleOnlyContext(script, flags);
  const sourceAuthoringScripts = new Set([
    "source-script-manufacturer.mjs", "winner-source.mjs", "winner-source-room-v2.mjs",
  ]);
  if (sourceAuthoringScripts.has(script)) {
    const selectedProfile = identity?.content_profile_config?.id ?? identity?.content_profile
      ?? (flags["content-profile"] ? contentProfileDefinition(flags["content-profile"]).config.id : DEFAULT_CONTENT_PROFILE);
    if (selectedProfile !== "manhwa_recap_v1") {
      throw new Error(`Source manufacture/story-room authoring supports manhwa_recap_v1 only; ${selectedProfile} must use its own source-development guidance.`);
    }
  }
  return workflow;
}
