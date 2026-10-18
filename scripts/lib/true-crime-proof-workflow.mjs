import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateTrueCrimeProofPlan } from "./true-crime-proof-plan.mjs";

// Dedicated private proof adapter. It does not call the generated or avatar routes.
export const TRUE_CRIME_PROOF_PROFILE = "true_crime_proof_v1";
export const TRUE_CRIME_PROOF_WORKFLOW = "true_crime_hybrid_proof_v1";
export const TRUE_CRIME_PROOF_VERSION = "2026-09-08.1";
export const TRUE_CRIME_PROOF_STAGES = Object.freeze(["source_assets", "narration", "program_review"]);
const execute = promisify(execFile);
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const need = (condition, message) => { if (!condition) throw new Error(`True-crime proof: ${message}`); };
const exists = async (file) => Boolean(await fs.lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; }));
const jsonAt = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const normalized = (value) => value.trim().replace(/\s+/gu, " ");
const contained = (parent, child) => { const relative = path.relative(parent, child); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };
const exclusiveJson = (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

function allowed(value, fields, label) {
  need(plain(value), `${label} must be an object.`);
  need(Object.keys(value).every((key) => fields.includes(key)), `${label} has unsupported fields.`);
}
function safeData(value) {
  if (Array.isArray(value)) return value.every(safeData);
  if (plain(value)) return Object.entries(value).every(([key, item]) => !/^(?:api_key|access_token|bearer_token|cookie|cookies|signed_url|session_state)$/i.test(key) && safeData(item));
  return typeof value !== "string" || !/\bBearer\s+\S+|https?:\/\/[^\s"<>]+[?&](?:token|access_token|api_key|signature|sig|X-Amz-[^=]+|X-Goog-[^=]+)=/i.test(value);
}
function sourceUrl(value) {
  need(text(value), "A selected remote source needs a public reference URL.");
  let url;
  try { url = new URL(value); } catch { need(false, "Invalid source URL."); }
  need(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && safeData(value), "Source URL cannot contain credentials or a signed media token.");
}

export function trueCrimeProofWorkflowContract() {
  const payload = { schema: "goldflow_media_workflow_v1", id: TRUE_CRIME_PROOF_WORKFLOW,
    version: TRUE_CRIME_PROOF_VERSION, stage_registry_version: TRUE_CRIME_PROOF_VERSION };
  return { ...payload, sha256: hash(JSON.stringify(payload)) };
}

export async function trueCrimeProofFileRef(file) {
  need(text(file) && path.isAbsolute(file), "File references require absolute paths.");
  const stat = await fs.lstat(file);
  need(stat.isFile() && !stat.isSymbolicLink(), "Bound input must be a regular file, not a symlink.");
  return { path: file, sha256: hash(await fs.readFile(file)) };
}
async function checkRef(ref) {
  need(plain(ref) && text(ref.path) && HASH.test(ref.sha256 ?? ""), "Invalid file/hash binding.");
  const actual = await trueCrimeProofFileRef(ref.path);
  need(actual.sha256 === ref.sha256, `Stale or changed file binding: ${path.basename(ref.path)}.`);
  return actual;
}
function validateIdentity(identity, stored = false) {
  allowed(identity, ["schema", "content_profile", "media_workflow", "channel", "channel_name", "series_slug", "run_slug", "episode", "title", "run_intent", "production_eligible", "publish_allowed", "plan", "script", "sources", "narration", "providers", "audio_target", "audio_mastering", "authorization", "proof_scope", "code_files", ...(stored ? ["workflow_contract", "git", "created_at"] : [])], "Identity");
  need(identity.schema === "goldflow_true_crime_proof_identity_v1" && identity.content_profile === TRUE_CRIME_PROOF_PROFILE && identity.media_workflow === TRUE_CRIME_PROOF_WORKFLOW, "Exact private true-crime profile/workflow pair required.");
  need(identity.run_intent === "proof" && identity.production_eligible === false && identity.publish_allowed === false, "Identity must disable production and publishing.");
  need(identity.channel === "crimedungeon" && identity.channel_name === "CrimeDungeon", "This proof is locked to CrimeDungeon.");
  need(SLUG.test(identity.series_slug ?? "") && SLUG.test(identity.run_slug ?? "") && /^ep_\d+$/.test(identity.episode ?? "") && text(identity.title), "Stable series/run slugs, exact episode and title required.");
  need(!/(?:^|-)ep-?\d+(?:-|$)/.test(identity.run_slug), "Episode number belongs in episode, not run_slug.");
  allowed(identity.proof_scope, ["min_duration_sec", "max_duration_sec", "fps", "width", "height"], "Proof scope");
  const scope = identity.proof_scope;
  need(scope.min_duration_sec === 90 && scope.max_duration_sec === 150 && scope.fps === 30 && scope.width === 1920 && scope.height === 1080, "Private scope is a 90–150-second program at 1920x1080/30fps; it is not an exact 120-second promise.");
  need(identity.audio_target === "narration_with_document_reading", "Initial proof audio target must be narration with document reading.");
  allowed(identity.audio_mastering, ["sample_rate_hz", "channels", "integrated_lufs", "true_peak_dbtp"], "Audio mastering");
  need(identity.audio_mastering.sample_rate_hz === 24000 && identity.audio_mastering.channels === 1 && identity.audio_mastering.integrated_lufs === -16 && identity.audio_mastering.true_peak_dbtp === -1.5, "Explicit proof audio targets required.");
  allowed(identity.narration, ["provider", "model", "model_revision", "voice_id", "voice_sha256", "reference_audio", "reference_text"], "Narration lock");
  need(identity.narration.provider === "qwen_local" && ["model", "model_revision", "voice_id"].every((key) => text(identity.narration[key])) && HASH.test(identity.narration.voice_sha256 ?? ""), "Exact local Qwen voice/model lock required; no fallback.");
  if (identity.providers !== undefined) {
    allowed(identity.providers, ["stills"], "Providers");
    allowed(identity.providers.stills, ["provider", "model", "operations", "max_submissions"], "Stills lock");
    const stills = identity.providers.stills;
    need(stills.provider === "openai_builtin_imagegen" && stills.model === "tool_managed" && stills.max_submissions === 2
      && JSON.stringify(stills.operations) === JSON.stringify(["background_extraction", "illustrative_detective"]), "Stills are limited to the two selected built-in image operations.");
  }
  allowed(identity.authorization, ["operator", "authorized_at", "note", "plan_sha256", "script_sha256"], "Authorization");
  const authorization = identity.authorization;
  need(text(authorization.operator) && text(authorization.note) && !Number.isNaN(Date.parse(authorization.authorized_at)) && authorization.plan_sha256 === identity.plan?.sha256 && authorization.script_sha256 === identity.script?.sha256, "Operator authorization must bind the exact shown plan and spoken text.");
  need(Array.isArray(identity.sources) && identity.sources.length > 0, "Explicit source inventory required.");
  const sourceIds = new Set();
  for (const source of identity.sources) {
    allowed(source, ["id", "acquisition", "path", "sha256", "url", "locator", "use_basis"], "Source");
    need(ID.test(source.id ?? "") && !sourceIds.has(source.id) && text(source.locator) && text(source.use_basis), "Each source needs unique ID, exact locator and scoped use basis.");
    sourceIds.add(source.id);
    need(["research_copy", "pending", "evidence_only"].includes(source.acquisition), "Unsupported source acquisition state.");
    if (source.acquisition === "research_copy") need(text(source.path) && HASH.test(source.sha256 ?? ""), "Research copy must bind its existing exact bytes.");
    else need(source.path === undefined && source.sha256 === undefined, "Pending/evidence-only sources cannot pretend to have acquired bytes.");
    if (source.acquisition !== "research_copy" || source.url !== undefined) sourceUrl(source.url);
  }
  if (identity.code_files !== undefined) need(Array.isArray(identity.code_files), "code_files must be an array of file bindings.");
  need(safeData(identity), "Private credentials or signed URLs cannot enter proof artifacts.");
  if (stored) {
    need(JSON.stringify(identity.workflow_contract) === JSON.stringify(trueCrimeProofWorkflowContract()), "Stale workflow contract; never migrate an existing identity.");
    need(plain(identity.git) && HASH.test(identity.git.dirty_diff_sha256 ?? "") && text(identity.git.commit) && Array.isArray(identity.code_files), "Stored code provenance required.");
  }
}
async function validateInputs(identity) {
  for (const ref of [identity.plan, identity.script, identity.narration.reference_audio, identity.narration.reference_text, ...(identity.code_files ?? []), ...identity.sources.filter((source) => source.acquisition === "research_copy")]) await checkRef(ref);
  const plan = await jsonAt(identity.plan.path);
  const validation = validateTrueCrimeProofPlan(plan);
  need(validation.valid, `Editorial plan is invalid: ${validation.errors.join("; ")}`);
  need(plan.title === identity.title && plan.working_channel === identity.channel_name, "Plan and identity title/channel disagree.");
  const ids = new Set(identity.sources.map((source) => source.id));
  need(plan.sources.every((source) => ids.has(source.id)), "Identity must retain every plan source, including evidence-only references.");
  need(plan.scenes.every((scene) => scene.audio.origin === "narration" && ["paraphrase", "document_reading"].includes(scene.audio.text_mode)), "This first private adapter does not synthesize a suspect/officer cast or import original dialogue.");
  const scriptText = await fs.readFile(identity.script.path, "utf8");
  need(normalized(scriptText) === normalized(plan.scenes.map((scene) => scene.audio.text).join("\n\n")), "Spoken text must reproduce the exact selected plan text in source order.");
  return { plan, scriptText };
}
async function gitProvenance(repoDir, allowDirtyWorktree, dirtyReason) {
  need(text(repoDir) && path.isAbsolute(repoDir), "Explicit absolute repository directory required.");
  const git = async (...args) => (await execute("git", args, { cwd: repoDir, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const status = await git("status", "--porcelain=v1", "--untracked-files=all");
  need(!status.trim() || (allowDirtyWorktree === true && text(dirtyReason) && dirtyReason.trim().length >= 12), "Dirty proof requires allowDirtyWorktree:true and a meaningful dirtyReason.");
  const untracked = [];
  for (const relative of (await git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean)) {
    const file = path.join(repoDir, relative);
    const stat = await fs.lstat(file);
    untracked.push({ path: relative, sha256: hash(stat.isSymbolicLink() ? await fs.readlink(file) : await fs.readFile(file)) });
  }
  return { commit: (await git("rev-parse", "HEAD")).trim(), branch: (await git("branch", "--show-current")).trim(), dirty: Boolean(status.trim()),
    dirty_diff_sha256: hash(`${status}\n${await git("diff", "HEAD", "--binary")}\n${JSON.stringify(untracked)}`), dirty_reason: status.trim() ? dirtyReason : null };
}
async function audit(proofDir, event) {
  const report = { schema: "goldflow_true_crime_proof_execution_v1", id: randomUUID(), recorded_at: new Date().toISOString(), production_eligible: false, publish_allowed: false, ...event };
  need(safeData(report), "Execution report contains private data.");
  await fs.mkdir(path.join(proofDir, "reports"), { recursive: true });
  const reportPath = path.join(proofDir, "reports", `${report.id}.json`);
  await exclusiveJson(reportPath, report);
  const reportRef = await trueCrimeProofFileRef(reportPath);
  await fs.appendFile(path.join(proofDir, "execution_events.jsonl"), `${JSON.stringify({ ...report, report: reportRef })}\n`, { mode: 0o600 });
  return reportRef;
}

export async function preflightTrueCrimeProof({ proofDir, repoDir, identity: requested, allowDirtyWorktree = false, dirtyReason = "" }) {
  need(text(proofDir) && path.isAbsolute(proofDir), "Explicit absolute proofDir required.");
  need(!(await exists(proofDir)), "Preflight requires a new path; existing proof directories are immutable.");
  const identity = structuredClone(requested);
  validateIdentity(identity);
  const files = [fileURLToPath(import.meta.url), fileURLToPath(new URL("./true-crime-proof-plan.mjs", import.meta.url))];
  const supplied = identity.code_files ?? [];
  for (const ref of supplied) await checkRef(ref);
  identity.code_files = [...new Map([...(await Promise.all(files.map(trueCrimeProofFileRef))), ...supplied].map((ref) => [ref.path, ref])).values()];
  await validateInputs(identity);
  identity.git = await gitProvenance(repoDir, allowDirtyWorktree, dirtyReason);
  identity.workflow_contract = trueCrimeProofWorkflowContract();
  identity.created_at = new Date().toISOString();
  validateIdentity(identity, true);
  // No directory creation, provider invocation or report write occurs before checks above.
  await fs.mkdir(path.dirname(proofDir), { recursive: true });
  await fs.mkdir(proofDir);
  await exclusiveJson(path.join(proofDir, "run_identity.json"), identity);
  const binding = await trueCrimeProofFileRef(path.join(proofDir, "run_identity.json"));
  await exclusiveJson(path.join(proofDir, "identity_binding.json"), binding);
  await audit(proofDir, { stage: "preflight", status: "locked", identity_sha256: binding.sha256, scope: identity.proof_scope, cost_usd: 0 });
  return trueCrimeProofStatus({ proofDir });
}

export async function loadTrueCrimeProofIdentity({ proofDir }) {
  need(text(proofDir) && path.isAbsolute(proofDir), "Explicit absolute proofDir required.");
  const binding = await jsonAt(path.join(proofDir, "identity_binding.json"));
  need(binding.path === path.join(proofDir, "run_identity.json"), "Identity seal points outside this proof.");
  await checkRef(binding);
  const identity = await jsonAt(binding.path);
  validateIdentity(identity, true);
  const inputs = await validateInputs(identity);
  return { identity, ...inputs, identity_sha256: binding.sha256 };
}

async function readStage(proofDir, stage, identityHash) {
  const file = path.join(proofDir, `${stage}.json`);
  if (!(await exists(file))) return null;
  const receipt = await jsonAt(file);
  need(receipt.schema === "goldflow_true_crime_proof_stage_v1" && receipt.stage === stage && receipt.identity_sha256 === identityHash && receipt.approved === false && receipt.production_eligible === false, "Stale or invalid retained stage receipt.");
  const generationRefs = (receipt.metadata?.generation_submissions ?? []).flatMap((row) => [row.request, row.result, row.output]);
  for (const ref of [...receipt.inputs, ...receipt.artifacts, ...(receipt.acquired_sources ?? []), ...generationRefs]) await checkRef(ref);
  const resultBinding = receipt.result_binding;
  await checkRef(resultBinding);
  const result = await jsonAt(resultBinding.path);
  need(JSON.stringify(result.artifacts) === JSON.stringify(receipt.artifacts) && JSON.stringify(result.metadata) === JSON.stringify(receipt.metadata) && JSON.stringify(result.acquired_sources ?? []) === JSON.stringify(receipt.acquired_sources ?? []), "Retained producer result disagrees with its stage receipt.");
  return receipt;
}

export async function trueCrimeProofStatus({ proofDir }) {
  const loaded = await loadTrueCrimeProofIdentity({ proofDir });
  const stages = [];
  let next = null;
  let blocked = false;
  const active = await exists(path.join(proofDir, "operation.lock")) ? await jsonAt(path.join(proofDir, "operation.lock")) : null;
  let running = false;
  for (const stage of TRUE_CRIME_PROOF_STAGES) {
    const receipt = await readStage(proofDir, stage, loaded.identity_sha256);
    const started = await exists(path.join(proofDir, "attempts", stage, "start.json"));
    const state = receipt ? (stage === "source_assets" ? "candidate_ready" : "awaiting_review") : started ? (active?.stage === stage ? "running" : "needs_triage") : "pending";
    stages.push({ stage, state, artifact: receipt ? path.join(proofDir, `${stage}.json`) : null });
    if (!receipt && !next && !blocked) { if (started) { blocked = true; running = state === "running"; } else next = stage; }
  }
  if (blocked) next = null;
  const target = `--episode-dir ${JSON.stringify(proofDir)}`;
  const commandShapes = { source_assets: `node bin/goldflow.mjs crime-proof begin-assets ${target} --recipe <assets.json>`, narration: `node bin/goldflow.mjs crime-proof narrate ${target}`, program_review: `node bin/goldflow.mjs crime-proof render ${target} --manifest <render.json>` };
  return { schema: "goldflow_true_crime_proof_status_v1", proof_dir: proofDir, identity_sha256: loaded.identity_sha256,
    stages, next_stage: next, state: running ? "running" : blocked ? "needs_triage" : next ? "in_progress" : "awaiting_program_review",
    next_command_shape: next ? commandShapes[next] : running && active.stage === "source_assets" ? `node bin/goldflow.mjs crime-proof finish-assets ${target} --result <assets-result.json> --attempt-token <exact-open-attempt-token>` : null,
    production_eligible: false, publish_allowed: false, approval_recorded: false };
}

export function formatTrueCrimeProofStatus(report) {
  return `# CrimeDungeon private proof\n\nState: ${report.state}. Publishing disabled; candidates are not approved.\n\n| Stage | State |\n| --- | --- |\n${report.stages.map((row) => `| ${row.stage} | ${row.state} |`).join("\n")}\n\nNext: ${report.next_command_shape ?? "Inspect the retained candidate/attempt; no automatic retry or release."}\n`;
}

async function validateProduced(result, context) {
  const { stage, identity, outputDir } = context;
  allowed(result, ["artifacts", "metadata", "cost_usd", "acquired_sources"], "Producer result");
  need(Array.isArray(result.artifacts) && result.artifacts.length > 0 && plain(result.metadata), "Producer must return actual artifacts and metadata.");
  need(result.metadata.approved !== true && result.metadata.production_eligible !== true && result.metadata.publish_allowed !== true, "A producer cannot grant approval, production or publishing authority.");
  const reportedCost = typeof result.cost_usd === "number" && Number.isFinite(result.cost_usd) && result.cost_usd >= 0;
  const unreportedToolCost = stage === "source_assets" && result.cost_usd === null && result.metadata.cost_status === "provider_cost_not_reported";
  need((reportedCost || unreportedToolCost) && safeData(result), "Actual nonnegative cost, or explicitly unreported source-tool cost, and safe result metadata required.");
  const ids = new Set();
  const sources = new Set(identity.sources.map((source) => source.id));
  const realOutput = await fs.realpath(outputDir);
  for (const artifact of result.artifacts) {
    allowed(artifact, ["id", "path", "sha256", "kind", "source_ids", "source_text_sha256"], "Artifact");
    need(ID.test(artifact.id ?? "") && !ids.has(artifact.id) && text(artifact.kind), "Unique artifact ID and kind required."); ids.add(artifact.id);
    await checkRef(artifact);
    need(contained(realOutput, await fs.realpath(artifact.path)), "Produced artifact must live inside this attempt's output directory.");
    if (artifact.source_ids !== undefined) need(Array.isArray(artifact.source_ids) && artifact.source_ids.every((id) => sources.has(id)), "Artifact has an unselected source.");
    if (artifact.source_text_sha256 !== undefined) need(artifact.source_text_sha256 === identity.script.sha256, "Artifact spoken-text provenance is stale.");
  }
  const acquired = result.acquired_sources ?? [];
  need(Array.isArray(acquired), "acquired_sources must be an array.");
  const acquiredIds = new Set();
  for (const row of acquired) {
    allowed(row, ["id", "path", "sha256", "url"], "Acquired source");
    const selected = identity.sources.find((source) => source.id === row.id);
    need(stage === "source_assets" && selected?.acquisition === "pending" && row.url === selected.url && !acquiredIds.has(row.id), "Acquisition must match one exact pending source selected at preflight.");
    acquiredIds.add(row.id); await checkRef(row);
    need(contained(realOutput, await fs.realpath(row.path)), "Acquired bytes must remain in this attempt.");
  }
  if (stage === "source_assets") {
    need(identity.sources.filter((source) => source.acquisition === "pending").every((source) => acquiredIds.has(source.id)), "Every selected pending media source requires acquired-byte provenance.");
    need(result.artifacts.every((artifact) => Array.isArray(artifact.source_ids)), "Source assets must record source_ids; authored graphics may use an empty list.");
    const generations = result.metadata.generation_submissions ?? [];
    need(Array.isArray(generations), "Image submissions must be explicit receipts.");
    const stills = identity.providers?.stills;
    need(generations.length <= (stills?.max_submissions ?? 0), "Image submission scope exceeded or provider was not locked.");
    const operations = new Set();
    for (const generation of generations) {
      allowed(generation, ["operation", "provider", "model", "request", "result", "output"], "Image submission");
      need(stills.operations.includes(generation.operation) && !operations.has(generation.operation) && generation.provider === stills.provider && generation.model === stills.model, "Image generation drift, duplicate operation or unselected provider.");
      operations.add(generation.operation);
      for (const ref of [generation.request, generation.result, generation.output]) {
        await checkRef(ref);
        need(contained(realOutput, await fs.realpath(ref.path)), "Image request/result/output evidence must remain in this attempt.");
      }
    }
  } else {
    need(result.metadata.source_text_sha256 === identity.script.sha256 && result.metadata.tempo === 1 && ["passed", "needs_review"].includes(result.metadata.technical_qa), "Exact spoken-text, unchanged tempo and explicit technical QA required.");
    need(positive(result.metadata.measured_duration_sec) && result.metadata.measured_duration_sec <= identity.proof_scope.max_duration_sec, "Measured media duration exceeds private proof scope.");
    if (stage === "narration") {
      const voice = result.metadata.voice;
      need(plain(voice) && ["provider", "model", "model_revision", "voice_id", "voice_sha256"].every((key) => voice[key] === identity.narration[key]), "Narration voice/model drift.");
      for (const kind of ["narration_audio", "narration_receipt"]) need(result.artifacts.some((artifact) => artifact.kind === kind), `Narration candidate needs ${kind}.`);
    } else {
      need(result.metadata.measured_duration_sec >= identity.proof_scope.min_duration_sec && result.metadata.whole_narration_preserved === true, "Program must preserve all narration and fit the private budget without stretching.");
      for (const kind of ["program_video", "program_qa"]) need(result.artifacts.some((artifact) => artifact.kind === kind), `Program candidate needs ${kind}.`);
    }
  }
}

async function beginStage({ proofDir, stage, inputs = [] }) {
  need(TRUE_CRIME_PROOF_STAGES.includes(stage), "Unsupported action; approvals, release and publishing are unavailable.");
  need(Array.isArray(inputs), "Explicit input bindings are required.");
  const loaded = await loadTrueCrimeProofIdentity({ proofDir });
  const status = await trueCrimeProofStatus({ proofDir });
  need(status.next_stage === stage, `Next valid stage is ${status.next_stage ?? status.state}; do not rerun or bypass retained attempts.`);
  for (const input of inputs) await checkRef(input);
  const upstream = {};
  const inputBindings = [...inputs, loaded.identity.plan, loaded.identity.script];
  for (const prior of TRUE_CRIME_PROOF_STAGES.slice(0, TRUE_CRIME_PROOF_STAGES.indexOf(stage))) {
    upstream[prior] = await readStage(proofDir, prior, loaded.identity_sha256);
    need(upstream[prior], "Required previous candidate is absent.");
    inputBindings.push(await trueCrimeProofFileRef(path.join(proofDir, `${prior}.json`)));
  }
  const operationLock = path.join(proofDir, "operation.lock");
  const lock = await fs.open(operationLock, "wx", 0o600);
  const attemptDir = path.join(proofDir, "attempts", stage);
  const outputDir = path.join(attemptDir, "output");
  const attemptToken = randomUUID();
  const tokenHash = hash(attemptToken);
  try {
    need(!(await exists(attemptDir)), "This exact stage already has retained attempt evidence; inspect before recovery.");
    await fs.mkdir(path.dirname(attemptDir), { recursive: true });
    await fs.mkdir(attemptDir); await fs.mkdir(outputDir);
    await lock.writeFile(JSON.stringify({ stage, attempt_token_sha256: tokenHash }));
    await exclusiveJson(path.join(attemptDir, "start.json"), { stage, identity_sha256: loaded.identity_sha256, inputs: inputBindings, started_at: new Date().toISOString(), attempt_token_sha256: tokenHash, automatic_retry_allowed: false });
    await audit(proofDir, { stage, status: "started", identity_sha256: loaded.identity_sha256, inputs: inputBindings, scope: loaded.identity.proof_scope, cost_usd: null });
    return { ...structuredClone(loaded), proofDir, stage, outputDir, inputs: structuredClone(inputs), upstream: structuredClone(upstream), attempt_token: attemptToken };
  } catch (error) {
    await fs.unlink(operationLock);
    throw error;
  } finally { await lock.close(); }
}
async function attemptContext({ proofDir, stage, attempt_token }) {
  need(TRUE_CRIME_PROOF_STAGES.includes(stage) && text(attempt_token), "Exact stage and attempt token required.");
  const start = await jsonAt(path.join(proofDir, "attempts", stage, "start.json"));
  const lock = await jsonAt(path.join(proofDir, "operation.lock"));
  need(start.attempt_token_sha256 === hash(attempt_token) && lock.attempt_token_sha256 === start.attempt_token_sha256 && lock.stage === stage, "Attempt token mismatch or closed attempt.");
  need(!(await exists(path.join(proofDir, `${stage}.json`))), "A completed stage cannot be overwritten.");
  return start;
}
async function failStage(args) {
  const start = await attemptContext(args);
  await audit(args.proofDir, { stage: args.stage, status: "needs_triage", identity_sha256: start.identity_sha256,
    error_code: "retained_attempt_requires_inspection", cost_usd: null, elapsed_ms: Date.now() - Date.parse(start.started_at) });
  await fs.unlink(path.join(args.proofDir, "operation.lock"));
}
async function finishStage({ proofDir, stage, attempt_token, result }) {
  const start = await attemptContext({ proofDir, stage, attempt_token });
  try {
    const loaded = await loadTrueCrimeProofIdentity({ proofDir });
    need(start.identity_sha256 === loaded.identity_sha256, "Attempt identity changed.");
    const outputDir = path.join(proofDir, "attempts", stage, "output");
    await validateProduced(result, { ...loaded, stage, outputDir });
    for (const ref of start.inputs) await checkRef(ref);
    for (const prior of TRUE_CRIME_PROOF_STAGES.slice(0, TRUE_CRIME_PROOF_STAGES.indexOf(stage))) await readStage(proofDir, prior, loaded.identity_sha256);
    const resultPath = path.join(proofDir, "attempts", stage, "producer_result.json");
    await exclusiveJson(resultPath, result);
    const receipt = { schema: "goldflow_true_crime_proof_stage_v1", stage, identity_sha256: loaded.identity_sha256, approved: false, production_eligible: false,
      state: stage === "source_assets" ? "candidate_ready" : "awaiting_review", inputs: start.inputs, artifacts: result.artifacts,
      acquired_sources: result.acquired_sources ?? [], metadata: result.metadata, cost_usd: result.cost_usd, result_binding: await trueCrimeProofFileRef(resultPath), recorded_at: new Date().toISOString() };
    const stagePath = path.join(proofDir, `${stage}.json`);
    await exclusiveJson(stagePath, receipt);
    await audit(proofDir, { stage, status: receipt.state, identity_sha256: loaded.identity_sha256, inputs: start.inputs, output: await trueCrimeProofFileRef(stagePath), scope: loaded.identity.proof_scope, cost_usd: result.cost_usd, elapsed_ms: Date.now() - Date.parse(start.started_at) });
    await fs.unlink(path.join(proofDir, "operation.lock"));
    return trueCrimeProofStatus({ proofDir });
  } catch (error) {
    if (!(await exists(path.join(proofDir, `${stage}.json`)))) await failStage({ proofDir, stage, attempt_token });
    throw error;
  }
}

// Only source assets can be externally orchestrated (for the built-in image tool).
export async function beginTrueCrimeProofStage(args) {
  need(args.stage === "source_assets", "External stage lifecycle is source_assets only.");
  return beginStage(args);
}
export async function finishTrueCrimeProofStage(args) {
  need(args.stage === "source_assets", "External stage lifecycle is source_assets only.");
  return finishStage(args);
}
export async function failTrueCrimeProofStage(args) {
  need(args.stage === "source_assets", "External stage lifecycle is source_assets only.");
  return failStage(args);
}
export async function runTrueCrimeProofStage({ proofDir, stage, inputs = [], producer }) {
  need(typeof producer === "function", "An explicit injected producer is required.");
  const context = await beginStage({ proofDir, stage, inputs });
  let result;
  try { result = await producer(context); }
  catch (error) { await failStage({ proofDir, stage, attempt_token: context.attempt_token }); throw error; }
  return finishStage({ proofDir, stage, attempt_token: context.attempt_token, result });
}
