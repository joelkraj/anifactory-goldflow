// A separate, import-based private proof lane. No generated-visual stage aliases.
const definitions = [
  ["run_identity", "preflight", "run_identity.json", "automatic"],
  ["pilot_script", "ingest", "pilot_script.json", "automatic"],
  ["pilot_script_approval", "approve-script", "pilot_script_approval.json", "operator"],
  ["pilot_evidence", "approve-evidence", "pilot_evidence.json", "operator"],
  ["pilot_voice_sample", "import-voice-sample", "pilot_voice_sample.json", "automatic"],
  ["pilot_voice_sample_approval", "approve-voice-sample", "pilot_voice_sample_approval.json", "operator"],
  ["pilot_narration", "import-narration", "pilot_narration.json", "automatic"],
  ["pilot_asset_plan", "plan-assets", "pilot_asset_plan.json", "automatic"],
  ["pilot_asset_plan_approval", "approve-asset-plan", "pilot_asset_plan_approval.json", "operator"],
  ["pilot_media", "import-media", "pilot_media.json", "automatic"],
  ["pilot_timeline", "timeline", "pilot_timeline.json", "automatic"],
  ["pilot_timeline_approval", "approve-timeline", "pilot_timeline_approval.json", "operator"],
  ["pilot_render", "render", "pilot_render.json", "automatic"],
  ["pilot_final_qa", "final-qa", "pilot_final_qa.json", "operator"],
];
export const AVATAR_PILOT_STAGES = Object.freeze(definitions.map(([id, action, output, approval], index) => Object.freeze({
  id, title: id.replaceAll("_", " "), action, output, approval,
  commands: [`pilot ${action}`], validator: `${id}_hash_bound_v1`,
  dependencies: index ? [definitions[index - 1][0]] : [],
})));
export function pilotCommandShape(stage, episodeDir) {
  const extras = {
    preflight: "--identity <proof-config.json>",
    ingest: "--script <spoken-text.md>",
    "approve-evidence": "--input <reviewed-evidence.json> --reviewer <name> --note <basis>",
    "import-voice-sample": "--input <audited-sample-bundle.json>",
    "approve-voice-sample": "--reviewer <name> --note <review> --accept true --attestation complete_opening_listened_end_to_end",
    "import-narration": "--input <audited-full-bundle.json>",
    "plan-assets": "--input <asset-plan.json>", "import-media": "--input <media-manifest.json>",
    timeline: "--input <timeline.json>",
    "final-qa": "--reviewer <name> --note <review> --attestation entire_90_second_program_watched_and_listened",
  };
  const extra = extras[stage.action] ?? (stage.approval === "operator" ? "--reviewer <name> --note <review> --accept true" : "");
  return `node bin/goldflow.mjs pilot ${stage.action} --episode-dir ${JSON.stringify(episodeDir)} ${extra}`.trim();
}
