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
