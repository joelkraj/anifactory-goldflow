#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCommandWorkflowRoute } from "./lib/episode-workflow-routing.mjs";
import { preflightTrueCrimeProof, trueCrimeProofStatus, formatTrueCrimeProofStatus,
  loadTrueCrimeProofIdentity, trueCrimeProofFileRef, beginTrueCrimeProofStage,
  finishTrueCrimeProofStage, failTrueCrimeProofStage, runTrueCrimeProofStage } from "./lib/true-crime-proof-workflow.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const need = (ok, message) => { if (!ok) throw new Error(`Crime proof CLI: ${message}`); };
const normalize = (text) => text.trim().replace(/\s+/gu, " ");
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const absolute = (value, label) => { need(typeof value === "string" && value.trim() && value !== "true", `${label} requires an explicit path.`); return path.resolve(value); };
const help = `Private CrimeDungeon proof; all commands require --episode-dir <absolute-proof-dir>.
  crime-proof preflight --identity <config.json> [--allow-dirty-worktree true --dirty-reason <reason>]
  crime-proof status [--format json|markdown]
  crime-proof begin-assets --recipe <assets.json>
  crime-proof finish-assets --result <assets-result.json> --attempt-token <exact-token>
  crime-proof narrate
  crime-proof render --manifest <render.json>
Candidates remain private and unapproved. No publishing, generic retry or workflow bypass is available.`;

export function parseTrueCrimeProofCliArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    need(args[i].startsWith("--"), `Unexpected positional argument ${args[i]}.`);
    const [key, ...inline] = args[i].slice(2).split("=");
    need(!Object.hasOwn(flags, key), `Repeated --${key} is ambiguous.`);
    flags[key] = inline.length ? inline.join("=") : args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
  }
  return flags;
}

async function validateRenderManifest(manifest, { identity, plan, scriptText, upstream }) {
  need(manifest?.scope === "private_proof" && manifest.production_eligible === false, "Render manifest must be a private proof.");
  const expected = { channel: identity.channel_name, series: identity.series_slug, run: identity.run_slug, episode: identity.episode, title: identity.title };
  need(Object.entries(expected).every(([key, value]) => manifest.identity?.[key] === value), "Render manifest identity differs from the locked proof.");
  const narration = upstream.narration.artifacts.find((artifact) => artifact.kind === "narration_audio");
  need(narration && manifest.narration?.path === narration.path && manifest.narration?.sha256 === narration.sha256, "Render must use the exact retained complete narration candidate.");
  need(Array.isArray(manifest.narration.units) && normalize(manifest.narration.units.map((unit) => unit.text).join("\n\n")) === normalize(scriptText), "Render narration text must preserve the authorized script in order.");
  need(Array.isArray(manifest.scenes) && manifest.scenes.length === plan.scenes.length && manifest.scenes.every((scene, i) => scene.id === plan.scenes[i].id), "Render scenes must retain the selected editorial scene IDs and order.");
  const assets = new Map(upstream.source_assets.artifacts.map((asset) => [asset.path, asset.sha256]));
  for (const [i, scene] of manifest.scenes.entries()) {
    const label = `${scene.source_label ?? ""} ${scene.disclosure ?? ""}`;
    if (plan.scenes[i].picture.origin === "recreated") need(/\b(?:ILLUSTRATIVE|RECONSTRUCTION|RECREATION)\b/i.test(label), "Recreated pictures must retain their disclosure.");
    if (plan.scenes[i].audio.text_mode === "document_reading") need(/DOCUMENT READING/i.test(label), "The exact document reading must retain its label.");
    for (const visual of [scene.background, ...(scene.layers ?? [])].filter(Boolean)) {
      if (visual.path) need(assets.get(visual.path) === visual.sha256, "Every render image/background must be a hash-bound source-assets candidate.");
    }
  }
}

export async function executeTrueCrimeProofCli(args, { repoDir = repoRoot } = {}) {
  const flags = parseTrueCrimeProofCliArgs(args);
  if (flags.help === "true") return help;
  const action = flags.action;
  const actionFlags = {
    preflight: ["identity", "repo-dir", "allow-dirty-worktree", "dirty-reason"],
    status: [], "begin-assets": ["recipe"], "finish-assets": ["result", "attempt-token"], narrate: [], render: ["manifest"],
  };
  need(Object.hasOwn(actionFlags, action), "Use preflight, status, begin-assets, finish-assets, narrate or render; no approval or publishing command exists.");
  const allowed = new Set(["action", "episode-dir", "format", ...actionFlags[action]]);
  need(Object.keys(flags).every((key) => allowed.has(key)), "Unknown flags or workflow bypass are unavailable.");
  need(flags.format === undefined || ["json", "markdown"].includes(flags.format), "format must be json or markdown.");
  const proofDir = absolute(flags["episode-dir"], "--episode-dir");
  assertCommandWorkflowRoute({ command: "crime-proof", subcommand: action, script: "true-crime-proof.mjs", flags, episodeDir: proofDir });
  let result;
  if (action === "preflight") {
    need(flags["allow-dirty-worktree"] === undefined || ["true", "false"].includes(flags["allow-dirty-worktree"]), "allow-dirty-worktree must be true or false.");
    const identity = await readJson(absolute(flags.identity, "--identity"));
    result = await preflightTrueCrimeProof({ proofDir, repoDir: flags["repo-dir"] ? absolute(flags["repo-dir"], "--repo-dir") : repoDir, identity,
      allowDirtyWorktree: flags["allow-dirty-worktree"] === "true", dirtyReason: flags["dirty-reason"] ?? "" });
  } else if (action === "status") result = await trueCrimeProofStatus({ proofDir });
  else if (action === "begin-assets") {
    const recipePath = absolute(flags.recipe, "--recipe");
    const recipeRef = await trueCrimeProofFileRef(recipePath);
    const recipe = await readJson(recipePath);
    need(recipe.schema === "goldflow_true_crime_proof_assets_v1", "Unsupported source-assets recipe.");
    const context = await beginTrueCrimeProofStage({ proofDir, stage: "source_assets", inputs: [recipeRef] });
    const contextPath = path.join(proofDir, "attempts/source_assets/external-stage-context.json");
    try {
      await fs.writeFile(contextPath, `${JSON.stringify({ stage: "source_assets", identity_sha256: context.identity_sha256, attempt_token: context.attempt_token, output_dir: context.outputDir, recipe: recipeRef }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      const { prepareTrueCrimeProofAssets } = await import("./lib/true-crime-proof-assets.mjs");
      const prepared = await prepareTrueCrimeProofAssets({ proofDir, attempt_token: context.attempt_token, recipePath });
      result = { ...prepared, stage: "source_assets", state: "awaiting_external_image_operations", attempt_context: contextPath,
        next_command_shape: `node bin/goldflow.mjs crime-proof finish-assets --episode-dir ${JSON.stringify(proofDir)} --result <assets-result.json> --attempt-token <token-from-attempt-context>` };
    } catch (error) { await failTrueCrimeProofStage({ proofDir, stage: "source_assets", attempt_token: context.attempt_token }); throw error; }
  } else if (action === "finish-assets") {
    need(typeof flags["attempt-token"] === "string" && flags["attempt-token"] !== "true", "Exact --attempt-token required.");
    const externalResult = await readJson(absolute(flags.result, "--result"));
    const { identity } = await loadTrueCrimeProofIdentity({ proofDir });
    if (Array.isArray(externalResult.acquired_sources)) externalResult.acquired_sources = externalResult.acquired_sources.map((row) => {
      const source = identity.sources.find((selected) => selected.id === row.id);
      need(Object.keys(row).every((key) => ["id", "path", "sha256", "url", "locator", "use_basis"].includes(key)), "Unknown acquired-source fields.");
      need(source && (row.locator === undefined || row.locator === source.locator) && (row.use_basis === undefined || row.use_basis === source.use_basis), "Acquisition locator/use basis drifted from its selected source.");
      return Object.fromEntries(["id", "path", "sha256", "url"].map((key) => [key, row[key]]));
    });
    result = await finishTrueCrimeProofStage({ proofDir, stage: "source_assets", attempt_token: flags["attempt-token"], result: externalResult });
  } else if (action === "narrate") {
    result = await runTrueCrimeProofStage({ proofDir, stage: "narration", producer: async ({ outputDir }) => {
      const { produceTrueCrimeProofNarration } = await import("./lib/true-crime-proof-narration.mjs");
      return produceTrueCrimeProofNarration({ proofDir, outputDir });
    } });
  } else {
    const manifestPath = absolute(flags.manifest, "--manifest");
    const manifestRef = await trueCrimeProofFileRef(manifestPath);
    result = await runTrueCrimeProofStage({ proofDir, stage: "program_review", inputs: [manifestRef], producer: async (context) => {
      const manifest = await readJson(manifestPath);
      await validateRenderManifest(manifest, context);
      const { renderTrueCrimeProof } = await import("./lib/true-crime-proof-renderer.mjs");
      const rendered = await renderTrueCrimeProof({ outputDir: context.outputDir, manifest });
      const qaFrames = await Promise.all((rendered.frames ?? []).map(async (frame, index) => ({ id: `program-frame-${index + 1}`,
        ...(await trueCrimeProofFileRef(frame.path)), kind: "program_qa_frame" })));
      return { artifacts: [
        { id: "program-video", ...rendered.output, kind: "program_video" },
        { id: "program-qa", ...rendered.technical_report, kind: "program_qa" },
        { id: "program-timeline", ...rendered.timeline, kind: "program_timeline" },
        ...qaFrames,
      ], metadata: { source_text_sha256: context.identity.script.sha256, measured_duration_sec: rendered.duration_sec, tempo: 1,
        whole_narration_preserved: true, technical_qa: context.upstream.narration.metadata.technical_qa === "needs_review" ? "needs_review" : "passed",
        render_technical_qa: "passed", narration_technical_qa: context.upstream.narration.metadata.technical_qa, human_listening_performed: false }, cost_usd: 0 };
    } });
  }
  return flags.format === "markdown" && result?.stages ? formatTrueCrimeProofStatus(result) : result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await executeTrueCrimeProofCli(process.argv.slice(2)); console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
