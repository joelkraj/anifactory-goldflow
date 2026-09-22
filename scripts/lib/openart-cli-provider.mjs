import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const OPENART_CLI_PATH = '/Users/joel/.local/bin/openart';
export const OPENART_PRIMARY_MODEL = 'gpt-image-2-5-sunburst';
export const OPENART_REPAIR_MODELS = Object.freeze(['nano-banana-2', 'byte-plus-seedream-5-pro']);
export const OPENART_LOW_PARAMS = Object.freeze({
  imageCount: 1, aspectRatio: '16:9', resolutionTier: '1k', quality: 'low',
  outputFormat: 'png', lockAspectRatio: true, autoEnhancePrompt: false,
});
export const OPENART_CLI_CREDENTIAL_PATH = '/Users/joel/.openart/cli-credentials.json';
export const OPENART_CLI_ORIGIN = 'https://openart.ai';
// The release CLI's production API base is https://openart.ai/suite. This is
// distinct from the OAuth origin persisted in cli-credentials.json.
export const OPENART_CLI_GENERATE_PATH = '/suite/api/cli/v1/generate';
export const OPENART_CLI_COST_PATH = '/suite/api/cli/v1/model-cost';
export const OPENART_MAX_PARALLEL_GENERATIONS = 32;
const OPENART_ERROR_BODY_LIMIT = 1024;

const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

export function sanitizeOpenArtEvidence(value, key = '') {
  if (/(?:token|cookie|secret|authorization|email|signed)/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitizeOpenArtEvidence(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeOpenArtEvidence(item, name)]));
  }
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/[^\s"<>]+/g, '[URL_REDACTED]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL_REDACTED]');
  }
  return value;
}

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = sanitizeOpenArtEvidence(details);
  throw error;
}

function boundedProviderBody(body) {
  if (typeof body !== 'string') return body;
  return body.length <= OPENART_ERROR_BODY_LIMIT
    ? body
    : `${body.slice(0, OPENART_ERROR_BODY_LIMIT)}...[truncated ${body.length - OPENART_ERROR_BODY_LIMIT} bytes]`;
}

export async function runOpenArtCli(args, { cliPath = OPENART_CLI_PATH, timeoutMs = 45000 } = {}) {
  // No shell, no token argument/environment construction, and no automatic command retry.
  try {
    const result = await execFileAsync(cliPath, [...args, '--json', '--no-input'], {
      timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    fail('openart_cli_command_failed', 'OpenArt CLI command failed; retain its exact scope before recovery.', {
      command: [cliPath, ...args], exit_code: error.code,
      stderr: error.stderr || error.message,
    });
  }
}

async function writeReceipt(file, record) {
  if (!file || !path.isAbsolute(file)) fail('openart_receipt_path_required', 'An absolute immutable receipt path is required.');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = `${JSON.stringify(sanitizeOpenArtEvidence(record), null, 2)}\n`;
  await fs.writeFile(file, bytes, { flag: 'wx' });
  return { provider_receipt_path: file, provider_receipt_sha256: hash(bytes) };
}

async function assertAbsent(file) {
  try { await fs.access(file); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail('openart_existing_attempt', 'The requested attempt artifact already exists; recover by its recorded ID, not by resubmitting.', { path: file });
}

function validateFormValue(value, schema, name) {
  if (!schema) return `${name} is not in the live model form`;
  if (schema.const !== undefined && value !== schema.const) return `${name} violates the live constant`;
  if (schema.enum && !schema.enum.includes(value)) return `${name} is not a live enum value`;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${name} must be boolean`;
  if (schema.type === 'string' && typeof value !== 'string') return `${name} must be a string`;
  if (schema.type === 'integer' && (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return `${name} is outside the live integer range`;
  return null;
}

function validateExactImageJob(job) {
  if (!job || typeof job !== 'object') fail('openart_exact_job_required', 'An exact OpenArt image job is required.');
  if (!/^[A-Za-z0-9._-]+$/.test(job.assignmentId || '')) fail('openart_exact_assignment_required', 'Each exact OpenArt job needs a safe assignment ID.');
  if (!job.prompt?.trim()) fail('openart_exact_prompt_required', 'Each exact OpenArt job needs a non-empty prompt.');
  if (!job.projectId?.trim()) fail('openart_project_required', 'Each exact OpenArt job needs an explicit project ID.');
  if (!path.isAbsolute(job.receiptPath || '')) fail('openart_receipt_path_required', 'Each exact OpenArt job needs an absolute immutable receipt path.');
  const references = job.references ?? [];
  if (!Array.isArray(references) || references.length > 16) fail('openart_exact_references_invalid', 'Exact OpenArt jobs accept at most sixteen ordered image references.');
  for (const [index, reference] of references.entries()) {
    let url;
    try { url = new URL(reference.url); } catch { fail('openart_exact_reference_url_invalid', `Reference ${index + 1} needs an OpenArt CDN URL.`); }
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.openart.ai') fail('openart_exact_reference_url_invalid', `Reference ${index + 1} is not on the OpenArt CDN.`);
    if (!reference.id?.trim() || !reference.label?.trim() || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')) fail('openart_exact_reference_identity_invalid', `Reference ${index + 1} needs its stable ID, label, and approved SHA-256.`);
  }
  if (!Number.isFinite(job.creditsQuoted) || job.creditsQuoted < 0) fail('openart_exact_quote_required', 'Each exact OpenArt job needs its current configured credit quote.');
  return { ...job, references };
}

export function buildExactOpenArtImageRequest(job) {
  const checked = validateExactImageJob(job);
  const mode = checked.references.length ? 'image2image' : 'text2image';
  return {
    model: OPENART_PRIMARY_MODEL,
    media: 'image',
    mode,
    params: {
      prompt: checked.prompt,
      ...OPENART_LOW_PARAMS,
      ...(checked.references.length ? {
        visualReferences: checked.references.map((reference) => ({
          type: 'image', id: reference.id, url: reference.url, label: reference.label,
        })),
      } : {}),
      variant: 'sunburst',
    },
    projectId: checked.projectId,
  };
}

async function readOpenArtCliCredential({ credentialPath = OPENART_CLI_CREDENTIAL_PATH } = {}) {
  if (!path.isAbsolute(credentialPath)) fail('openart_credential_path_invalid', 'OpenArt CLI credential path must be absolute.');
  const stat = await fs.stat(credentialPath);
  if ((stat.mode & 0o077) !== 0) fail('openart_credential_permissions_invalid', 'OpenArt CLI credential file must not be accessible to group or other users.');
  const credential = JSON.parse(await fs.readFile(credentialPath, 'utf8'));
  if (credential.origin !== OPENART_CLI_ORIGIN || credential.type !== 'oauth' || !credential.accessToken || !credential.refreshToken) fail('openart_credential_invalid', 'OpenArt CLI OAuth credential is incomplete or has an unexpected origin.');
  return credential;
}

function exactCostItem(response, request) {
  const item = response?.items?.find((row) => row.model === request.model && row.mode === request.mode);
  if (!item || !Number.isFinite(item.totalCredits) || item.totalCredits < 0) fail('openart_exact_quote_invalid', 'OpenArt returned no finite configured-price quote.', { response });
  const expected = {
    imageCount: request.params.imageCount,
    resolutionTier: request.params.resolutionTier,
    aspectRatio: request.params.aspectRatio,
    quality: request.params.quality,
  };
  for (const [key, value] of Object.entries(expected)) if (item.config?.[key] !== value) fail('openart_exact_quote_mismatch', `OpenArt quote did not bind exact ${key}.`, { item });
  return item;
}

/** Read-only current configured pricing for exact requests. */
export async function quoteExactOpenArtImageBatch({
  jobs, credentialPath = OPENART_CLI_CREDENTIAL_PATH, runCli = runOpenArtCli, fetchImpl = fetch,
} = {}) {
  if (!Array.isArray(jobs) || !jobs.length) fail('openart_exact_jobs_required', 'At least one exact OpenArt image job is required.');
  const requests = jobs.map((job) => buildExactOpenArtImageRequest(job));
  const account = await runCli(['account']);
  const credential = await readOpenArtCliCredential({ credentialPath });
  const quoted = await boundedMap(requests, Math.min(OPENART_MAX_PARALLEL_GENERATIONS, requests.length), async (request) => {
    const result = await fetchImpl(new URL(OPENART_CLI_COST_PATH, credential.origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        'content-type': 'application/json', accept: 'application/json',
        'user-agent': 'openart-cli/0.1.1 goldflow-exact-compat/1',
      },
      body: JSON.stringify({ model: request.model, mode: request.mode, params: request.params }),
    });
    const body = await result.text();
    if (!result.ok) fail('openart_exact_quote_failed', `OpenArt exact quote failed with HTTP ${result.status}.`, { body: boundedProviderBody(body) });
    let response;
    try { response = JSON.parse(body); } catch { fail('openart_exact_quote_invalid', 'OpenArt exact quote returned non-JSON data.'); }
    const item = exactCostItem(response, request);
    return {
      model: item.model, mode: item.mode, credits: item.totalCredits,
      config: item.config, reference_count: request.params.visualReferences?.length ?? 0,
      request_sha256: hash(JSON.stringify(request)),
    };
  });
  const failed = quoted.find((row) => row.status === 'rejected');
  if (failed) throw failed.reason;
  return {
    observed_at: now(), plan: account.plan, account_credits_available: account.credits,
    quotes: quoted.map((row) => row.value),
  };
}

async function boundedMap(rows, concurrency, worker) {
  const results = new Array(rows.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= rows.length) return;
      try { results[index] = { status: 'fulfilled', value: await worker(rows[index], index) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, run));
  return results;
}

function exactReceiptRecord(job, request, response, { dryRun, idempotencyKey }) {
  const referenceEvidence = job.references.map((reference) => ({
    id: reference.id, label: reference.label, sha256: reference.sha256,
    url_sha256: hash(reference.url),
  }));
  return {
    schema: 'goldflow_openart_exact_cli_submission_v1',
    created_at: now(), assignment_id: job.assignmentId,
    transport: 'openart_cli_oauth_api_compat_v1', endpoint: `POST ${OPENART_CLI_GENERATE_PATH}`,
    model: request.model, media: request.media, mode: request.mode,
    params: { ...request.params, prompt: undefined, visualReferences: undefined },
    prompt_sha256: hash(job.prompt), references: referenceEvidence,
    project_id: job.projectId, credits_quoted: job.creditsQuoted,
    request_sha256: hash(JSON.stringify(request)), idempotency_key_sha256: hash(idempotencyKey),
    dry_run: dryRun, submitted: !dryRun,
    history_id: response?.historyId ?? response?.history?.id ?? null,
    provider_status: response?.status ?? response?.history?.status ?? (dryRun ? 'dry_run' : null),
    raw_credentials_read: !dryRun,
    credential_origin: dryRun ? null : OPENART_CLI_ORIGIN,
    response: dryRun ? null : sanitizeOpenArtEvidence(response),
  };
}

/**
 * Submit exact GPT Image 2.5 requests through the official CLI OAuth/API
 * surface. The released CLI cannot serialize its own non-default image form,
 * so this compatibility path refreshes its documented private OAuth file and
 * posts the exact form body directly. Tokens remain process-local and are
 * never returned, logged, or written to receipts. There is no retry/failover.
 */
export async function submitExactOpenArtImageBatch({
  jobs, concurrency = 24, maxCreditCost = 20, totalCreditBudget,
  execute = false, credentialPath = OPENART_CLI_CREDENTIAL_PATH,
  runCli = runOpenArtCli, fetchImpl = fetch,
} = {}) {
  if (!Array.isArray(jobs) || !jobs.length) fail('openart_exact_jobs_required', 'At least one exact OpenArt image job is required.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > OPENART_MAX_PARALLEL_GENERATIONS) fail('openart_exact_concurrency_invalid', 'OpenArt concurrency must be from one through thirty-two.');
  const checked = jobs.map(validateExactImageJob);
  if (new Set(checked.map((job) => job.assignmentId)).size !== checked.length || new Set(checked.map((job) => job.receiptPath)).size !== checked.length) fail('openart_exact_jobs_duplicate', 'Assignment IDs and receipt paths must be unique.');
  const quoted = checked.reduce((sum, job) => sum + job.creditsQuoted, 0);
  if (checked.some((job) => job.creditsQuoted > maxCreditCost)) fail('openart_exact_job_budget_exceeded', 'An exact OpenArt job exceeds the per-request credit ceiling.');
  if (!Number.isFinite(totalCreditBudget) || totalCreditBudget < quoted) fail('openart_exact_batch_budget_exceeded', 'The exact OpenArt batch is not covered by its explicit credit budget.');
  await Promise.all(checked.map((job) => assertAbsent(job.receiptPath)));

  let credential = null;
  if (execute) {
    // Refresh through the official binary before reading its private file.
    await runCli(['account']);
    credential = await readOpenArtCliCredential({ credentialPath });
  }
  const results = await boundedMap(checked, concurrency, async (job) => {
    const request = buildExactOpenArtImageRequest(job);
    const idempotencyKey = `goldflow-${hash(`${job.assignmentId}:${JSON.stringify(request)}`).slice(0, 32)}`;
    let response = null;
    if (execute) {
      const result = await fetchImpl(new URL(OPENART_CLI_GENERATE_PATH, credential.origin), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          'content-type': 'application/json', accept: 'application/json',
          'user-agent': 'openart-cli/0.1.1 goldflow-exact-compat/1',
          'x-idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(request),
      });
      const body = await result.text();
      if (!result.ok) fail('openart_exact_submission_failed', `OpenArt exact submission failed with HTTP ${result.status}.`, { body: boundedProviderBody(body) });
      try { response = JSON.parse(body); } catch { fail('openart_exact_submission_invalid', 'OpenArt exact submission returned non-JSON data.'); }
      if (!(response.historyId || response.history?.id)) fail('openart_exact_history_id_missing', 'OpenArt exact submission returned no history ID.', { response });
    }
    const record = exactReceiptRecord(job, request, response, { dryRun: !execute, idempotencyKey });
    const receipt = await writeReceipt(job.receiptPath, record);
    return { assignment_id: job.assignmentId, history_id: record.history_id, request_sha256: record.request_sha256, ...receipt };
  });
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    const error = new Error(`Exact OpenArt batch completed with ${failures.length} failed assignment(s); inspect successful immutable receipts and triage only failed IDs.`);
    error.code = 'openart_exact_batch_partial_failure';
    error.results = results.map((result) => result.status === 'fulfilled' ? result : { status: 'rejected', error: sanitizeOpenArtEvidence({ code: result.reason?.code, message: result.reason?.message, details: result.reason?.details }) });
    throw error;
  }
  return { schema: 'goldflow_openart_exact_cli_batch_v1', dry_run: !execute, concurrency, quoted_credits: quoted, results: results.map((result) => result.value) };
}

export async function discoverOpenArtContract({
  modelId = OPENART_PRIMARY_MODEL, mode = 'text2image', params = OPENART_LOW_PARAMS,
  referenceCount = 0, receiptPath, runCli = runOpenArtCli,
} = {}) {
  if (!['text2image', 'image2image'].includes(mode)) fail('openart_invalid_mode', 'Only still-image modes are supported.');
  if (referenceCount < 0 || !Number.isInteger(referenceCount)) fail('openart_invalid_reference_count', 'Reference count must be a non-negative integer.');
  const [version, form, cost] = await Promise.all([
    runCli(['version']),
    runCli(['model', 'form', modelId, mode, '--no-cache']),
    runCli(['model', 'cost', '--model', modelId, '--mode', mode, '--no-cache']),
  ]);
  const properties = form.jsonSchema?.properties || {};
  const invalid = Object.entries(params).map(([name, value]) => validateFormValue(value, properties[name], name)).filter(Boolean);
  const maxReferences = properties.visualReferences?.maxItems ?? 0;
  if ((mode === 'image2image') !== (referenceCount > 0) || referenceCount > maxReferences) invalid.push('Reference count does not match the live mode/form.');
  const quoted = cost.items?.find((item) => item.model === modelId && item.mode === mode) || null;
  const defaults = Object.fromEntries(Object.entries(properties).filter(([, spec]) => spec.default !== undefined).map(([name, spec]) => [name, spec.default]));
  const mismatches = Object.entries(params).filter(([name, value]) => JSON.stringify(quoted?.config?.[name] ?? defaults[name]) !== JSON.stringify(value)).map(([name]) => name);
  // v0.1.1's documented image CLI sends prompt + references only. Its cost command
  // quotes defaults only. A model schema is not proof that this CLI exposes them.
  const blockers = [...invalid];
  if (mismatches.length) blockers.push(`Installed CLI has no image settings flags; desired settings differ from the quoted/default configuration: ${mismatches.join(', ')}.`);
  if (referenceCount > 0 && quoted?.config?.referenceCount !== referenceCount) blockers.push('Default CLI quote does not bind the requested ordered reference count.');
  blockers.push('Generation is disabled in this CLI adapter until a supported exact-parameter submission and discounted quote contract are verified.');
  const record = {
    schema: 'goldflow_openart_cli_contract_discovery_v1', created_at: now(),
    status: 'blocked_before_dispatch', model_id: modelId, mode, params, reference_count: referenceCount,
    cli_version: version, live_form: form, live_default_cost: cost,
    quoted_default_credits: quoted?.totalCredits ?? null, configured_credits: null,
    maximum_reference_count: maxReferences, schema_valid: invalid.length === 0,
    default_mismatches: mismatches, dispatch_supported: false, blockers,
    discount: { advertised_percent: 10, actual_verified: false, billed_credits: null },
    transport: 'openart_cli', raw_credentials_read: false,
  };
  return { ...sanitizeOpenArtEvidence(record), ...(receiptPath ? await writeReceipt(receiptPath, record) : {}) };
}

export async function generateOpenArtImage(options = {}) {
  const contract = await discoverOpenArtContract({ ...options, referenceCount: options.references?.length || 0 });
  fail('openart_cli_settings_unsupported', 'Current OpenArt CLI cannot submit the locked low-quality image configuration. No generation or upload was submitted.', { contract });
}

export async function getOpenArtAccount({ runCli = runOpenArtCli } = {}) {
  const response = await runCli(['account']);
  return { plan: response.plan, credits: response.credits, account_fingerprint: response.user?.uid ? hash(response.user.uid) : null };
}

export async function listOpenArtProjects({ runCli = runOpenArtCli } = {}) {
  return sanitizeOpenArtEvidence(await runCli(['project', 'list']));
}

export async function createOpenArtProject({ name, description = '', receiptPath, runCli = runOpenArtCli } = {}) {
  if (!name?.trim()) fail('openart_project_name_required', 'Project name is required.');
  const preflightPath = `${receiptPath}.request.json`;
  await assertAbsent(receiptPath);
  await writeReceipt(preflightPath, { schema: 'goldflow_openart_project_request_v1', created_at: now(), name, description, submission_count: 1 });
  const response = await runCli(['project', 'create', '--name', name, ...(description ? ['--description', description] : [])]);
  const id = response.id || response.project?.id;
  if (!id) fail('openart_project_id_missing', 'Project creation returned no ID; inspect the account before any retry.', { response });
  const record = { schema: 'goldflow_openart_project_receipt_v1', created_at: now(), project_id: id, response };
  return { project_id: id, ...await writeReceipt(receiptPath, record) };
}

export async function uploadOpenArtAsset({ localPath, path: inputPath, sha256, projectId, receiptPath, runCli = runOpenArtCli } = {}) {
  const file = localPath || inputPath;
  if (!file || !path.isAbsolute(file) || !sha256 || !projectId) fail('openart_upload_contract_required', 'Upload requires absolute path, expected SHA-256, and explicit project ID.');
  const bytes = await fs.readFile(file);
  if (hash(bytes) !== sha256) fail('openart_upload_hash_mismatch', 'Local asset differs from the approved upload hash.');
  await assertAbsent(receiptPath);
  await writeReceipt(`${receiptPath}.request.json`, { schema: 'goldflow_openart_upload_request_v1', created_at: now(), local_path: file, sha256, project_id: projectId, submission_count: 1 });
  const response = await runCli(['upload', 'add', file, '--project', projectId]);
  const id = response.id || response.asset?.id || response.visualReference?.id || response.resource?.id;
  if (!id) fail('openart_upload_id_missing', 'Upload returned no stable asset ID; inspect the project before any retry.', { response });
  const record = { schema: 'goldflow_openart_upload_receipt_v1', created_at: now(), local_path: file, sha256, project_id: projectId, openart_asset_id: id, response };
  return { openart_asset_id: id, local_path: file, sha256, ...await writeReceipt(receiptPath, record) };
}

export async function listOpenArtAssets({ projectId, limit = 100, cursor, runCli = runOpenArtCli } = {}) {
  if (!projectId) fail('openart_project_required', 'Use an explicit OpenArt project.');
  return sanitizeOpenArtEvidence(await runCli(['upload', 'list', '--type', 'image', '--project', projectId, '--limit', String(limit), ...(cursor ? ['--cursor', cursor] : [])]));
}

export async function listOpenArtCreations({ projectId, limit = 100, cursor, runCli = runOpenArtCli } = {}) {
  if (!projectId) fail('openart_project_required', 'Use an explicit OpenArt project.');
  return sanitizeOpenArtEvidence(await runCli(['creation', 'list', '--type', 'image', '--project', projectId, '--limit', String(limit), ...(cursor ? ['--cursor', cursor] : [])]));
}

export async function getOpenArtCreation({ creationId, wait = false, timeoutSec = 30, receiptPath, runCli = runOpenArtCli } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(creationId || '')) fail('openart_creation_id_required', 'Use the exact recorded creation history ID.');
  const response = await runCli(['creation', wait ? 'wait' : 'get', creationId, ...(wait ? ['--timeout', `${Math.min(timeoutSec, 45)}s`] : [])]);
  const record = { schema: 'goldflow_openart_creation_observation_v1', observed_at: now(), creation_id: creationId, response };
  return { ...sanitizeOpenArtEvidence(record), ...(receiptPath ? await writeReceipt(receiptPath, record) : {}) };
}

export async function downloadOpenArtCreation({ creationId, openartAssetId, outputPath, receiptPath, runCli = runOpenArtCli, fetchImpl = fetch } = {}) {
  if (!path.isAbsolute(outputPath || '') || !receiptPath) fail('openart_output_required', 'Download requires absolute output and receipt paths.');
  if (!/^[A-Za-z0-9_-]+$/.test(creationId || '')) fail('openart_creation_id_required', 'Use the exact recorded creation history ID.');
  await assertAbsent(outputPath);
  await assertAbsent(receiptPath);
  const response = await runCli(['creation', 'get', creationId]);
  if (response.history?.id !== creationId || response.history?.status !== 'completed') fail('openart_creation_not_complete', 'The recorded creation is not complete; do not resubmit it.', { response });
  const resources = (response.resources || []).filter((item) => item.resourceType === 'image' && item.status === 'completed');
  const resource = openartAssetId ? resources.find((item) => item.id === openartAssetId) : (resources.length === 1 ? resources[0] : null);
  if (!resource || resource.generation?.historyId !== creationId) fail('openart_resource_ambiguous', 'Choose the exact generated OpenArt asset ID from this creation.', { resources });
  const url = new URL(resource.url);
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.openart.ai') fail('openart_untrusted_download_origin', 'Creation output is not on the documented OpenArt CDN.');
  const media = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(45000) });
  if (!media.ok) fail('openart_download_failed', `OpenArt output download failed with HTTP ${media.status}.`);
  const bytes = Buffer.from(await media.arrayBuffer());
  const sharp = (await import('sharp')).default;
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(metadata.format)) fail('openart_invalid_raster', 'OpenArt result is not a supported readable still raster.');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes, { flag: 'wx' });
  const record = {
    schema: 'goldflow_openart_download_receipt_v1', created_at: now(), creation_id: creationId,
    openart_asset_id: resource.id, output_path: outputPath, sha256: hash(bytes),
    width: metadata.width, height: metadata.height, format: metadata.format,
    source_response: response, source_url_sha256: hash(resource.url),
    model_params_and_charge_verified: false,
    note: 'CLI creation get supplies IDs/results only. Bind separate exact dispatch/model/settings/cost evidence before production acceptance.',
  };
  return { ...sanitizeOpenArtEvidence(record), ...await writeReceipt(receiptPath, record) };
}
