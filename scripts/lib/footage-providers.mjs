import fs from 'node:fs';
import path from 'node:path';

// Metadata adapters only. Download URLs are private, short-lived capabilities:
// callers must never persist/log the return value of resolve().
// Contracts checked against https://api.real-debrid.com/ and TorBox's official
// Postman Main API on 2026-09-06. No undocumented cache endpoint is used.
const API_BASES = {
  torbox: 'https://api.torbox.app/v1/api/',
  real_debrid: 'https://api.real-debrid.com/rest/1.0/',
};
const KEY_NAMES = ['GOLDFLOW_TORBOX_API_KEY', 'GOLDFLOW_REAL_DEBRID_API_KEY'];
const MAX_CONFIG_BYTES = 65_536;
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_SOURCES = 100;

export class FootageProviderError extends Error {
  constructor(provider, code, message) {
    super(`${provider}: ${message}`);
    this.name = 'FootageProviderError';
    this.provider = provider;
    this.code = code;
  }
}

function fail(provider, code, message) {
  throw new FootageProviderError(provider, code, message);
}

function canonicalProvider(value) {
  if (value === 'torbox') return value;
  if (['real_debrid', 'real-debrid', 'realdebrid'].includes(value)) return 'real_debrid';
  fail('footage', 'INVALID_PROVIDER', 'choose torbox or real_debrid.');
}

function apiKeyValue(value, label) {
  const key = value == null ? '' : String(value).trim();
  if (key && (!/^[A-Za-z0-9._~+/-]+=*$/.test(key) || key.length > 2048)) {
    fail('footage', 'INVALID_KEY', `${label} must be a single API token (value hidden).`);
  }
  return key;
}

// This is a deliberately small dotenv grammar, never sourced/evaluated by a shell.
// No expansion, escapes, multiline values, export syntax, or unknown settings.
export function loadFootageConfig({ repoRoot, env = process.env } = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot) fail('footage', 'INVALID_CONFIG', 'repoRoot is required.');
  const configPath = path.resolve(repoRoot, '.env.footage.local');
  const values = Object.create(null);
  let contents = '';
  try {
    const stat = fs.statSync(configPath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
      fail('footage', 'INVALID_CONFIG', 'the footage configuration must be a small regular file.');
    }
    contents = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error instanceof FootageProviderError) throw error;
    if (error.code !== 'ENOENT') fail('footage', 'CONFIG_READ_FAILED', 'could not read the footage configuration.');
  }
  for (const [index, raw] of contents.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !KEY_NAMES.includes(match[1]) || Object.hasOwn(values, match[1])) {
      fail('footage', 'INVALID_CONFIG', `invalid or duplicate setting on config line ${index + 1} (value hidden).`);
    }
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(value);
      if (!quoted) fail('footage', 'INVALID_CONFIG', `invalid quoting on config line ${index + 1} (value hidden).`);
      value = quoted[2];
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = apiKeyValue(value, match[1]);
  }
  const get = (name) => apiKeyValue(Object.hasOwn(env, name) ? env[name] : values[name], name);
  return { torboxApiKey: get(KEY_NAMES[0]), realDebridApiKey: get(KEY_NAMES[1]), configPath };
}

export function footageConfigStatus(config) {
  return {
    config_path: config.configPath,
    providers: {
      torbox: { configured: Boolean(config.torboxApiKey) },
      real_debrid: { configured: Boolean(config.realDebridApiKey) },
    },
  };
}

function sourceId(value, provider) {
  const id = String(value ?? '');
  const valid = provider === 'torbox' ? /^(0|[1-9]\d{0,15})$/.test(id) : /^[A-Za-z0-9]{1,64}$/.test(id);
  if (!valid || (provider === 'torbox' && !Number.isSafeInteger(Number(id)))) {
    fail(provider, 'INVALID_SOURCE_ID', 'source ID is invalid.');
  }
  return id;
}

function fileId(value, provider) {
  const id = String(value ?? '');
  if (!/^(0|[1-9]\d{0,15})$/.test(id) || !Number.isSafeInteger(Number(id))) {
    fail(provider, 'INVALID_FILE_ID', 'file ID must be a nonnegative integer.');
  }
  return id;
}

function integer(value, { min = 0, max = Number.MAX_SAFE_INTEGER, label = 'value', provider }) {
  const parsed = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail(provider, 'INVALID_INPUT', `${label} is outside the supported bounds.`);
  }
  return parsed;
}

function infoHash(value, provider) {
  if (typeof value !== 'string' || !/^[a-f\d]{40}$/i.test(value)) {
    fail(provider, 'INVALID_HASH', 'a 40-character hexadecimal BitTorrent v1 info hash is required.');
  }
  return value.toLowerCase();
}

function hashFromMagnet(value, provider) {
  if (typeof value !== 'string' || value.length > 16_384 || /[\u0000-\u0020\u007f]/.test(value)) {
    fail(provider, 'INVALID_MAGNET', 'a valid bounded magnet URI is required (value hidden).');
  }
  let magnet;
  try { magnet = new URL(value); } catch { fail(provider, 'INVALID_MAGNET', 'invalid magnet URI (value hidden).'); }
  const hashes = magnet.searchParams.getAll('xt').filter((entry) => /^urn:btih:/i.test(entry));
  if (magnet.protocol !== 'magnet:' || hashes.length !== 1) {
    fail(provider, 'INVALID_MAGNET', 'one BitTorrent v1 info hash is required in the magnet URI.');
  }
  let hash = hashes[0].slice(9);
  if (/^[a-z2-7]{32}$/i.test(hash)) {
    let buffer = 0;
    let bits = 0;
    const bytes = [];
    for (const character of hash.toUpperCase()) {
      buffer = (buffer << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character);
      bits += 5;
      if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); }
    }
    hash = Buffer.from(bytes).toString('hex');
  }
  return infoHash(hash, provider);
}

function byteCount(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function recordedHash(value) {
  return typeof value === 'string' && /^[a-f\d]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function basename(value) {
  return path.posix.basename(String(value ?? '').replaceAll('\\', '/')).normalize('NFC');
}

function safeFilename(value, apiKey) {
  let name = basename(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
  if (apiKey) name = name.split(apiKey).join('[redacted]');
  if (/:\/\/|[?&](?:token|key|auth)=/i.test(name)) name = '[redacted filename]';
  return name.slice(0, 512) || '(unnamed file)';
}

function safeCacheFiles(files, provider, apiKey) {
  const seen = new Set();
  return files.map((file) => {
    const id = fileId(file?.id, provider);
    if (seen.has(id)) fail(provider, 'INVALID_RESPONSE', 'provider returned duplicate cached file IDs.');
    seen.add(id);
    return { file_id: id, filename: safeFilename(file.name, apiKey), bytes: byteCount(file.size) };
  });
}

function expires(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function privateHttpsUrl(value, provider) {
  let url;
  try { url = new URL(value); } catch { fail(provider, 'INVALID_DOWNLOAD_URL', 'provider returned an invalid download link (value hidden).'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    fail(provider, 'INVALID_DOWNLOAD_URL', 'provider download links must use HTTPS without embedded login credentials.');
  }
  return url.href;
}

function pendingTorBoxFileMetadata(info, provider) {
  // Observed account-list contract: a pending/nonpresent torrent may explicitly
  // return files:null. Missing fields or other types are not the same evidence.
  return provider === 'torbox' && info?.files === null
    && typeof info.download_finished === 'boolean' && typeof info.download_present === 'boolean'
    && (!info.download_finished || !info.download_present);
}

function fileRows(info, provider, apiKey) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) fail(provider, 'INVALID_RESPONSE', 'provider returned invalid torrent metadata.');
  const id = sourceId(info.id, provider);
  if (pendingTorBoxFileMetadata(info, provider)) return [];
  if (!Array.isArray(info.files)) fail(provider, 'INVALID_RESPONSE', 'provider omitted file metadata; no file is assumed ready.');
  const ids = new Set();
  return info.files.map((file) => {
    const fid = fileId(file?.id, provider);
    if (ids.has(fid)) fail(provider, 'INVALID_RESPONSE', 'provider returned duplicate file IDs.');
    ids.add(fid);
    const ready = provider === 'torbox'
      ? info.download_finished === true && info.download_present === true && info.airlocked !== true && file.infected !== true && file.zipped !== true
      : info.status === 'downloaded' && Number(file.selected) === 1;
    return {
      provider, source_id: id, file_id: fid,
      filename: safeFilename(provider === 'torbox' ? file.name : file.path, apiKey),
      bytes: byteCount(provider === 'torbox' ? file.size : file.bytes),
      ready,
      source_hash: recordedHash(info.hash),
    };
  });
}

export function createFootageProvider(name, { apiKey, fetchImpl = globalThis.fetch, timeoutMs = 10_000, maxResponseBytes = MAX_API_BYTES } = {}) {
  const provider = canonicalProvider(name);
  const key = apiKeyValue(apiKey, provider);
  if (!key) fail(provider, 'KEY_MISSING', 'API key is not configured.');
  if (typeof fetchImpl !== 'function') fail(provider, 'INVALID_CONFIG', 'fetch implementation is required.');
  integer(timeoutMs, { min: 1, max: 60_000, label: 'request timeout', provider });
  integer(maxResponseBytes, { min: 1, max: MAX_API_BYTES, label: 'response limit', provider });

  async function request(endpoint, { method = 'GET', query = {}, body } = {}) {
    const url = new URL(endpoint, API_BASES[provider]);
    for (const [field, value] of Object.entries(query)) url.searchParams.set(field, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader;
    try {
      const response = await fetchImpl(url.href, {
        method, headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        body, redirect: 'manual', signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = Number.isInteger(response.status) ? response.status : 0;
        fail(provider, `HTTP_${status}`, `API request failed (HTTP ${status}); no automatic retry was made.`);
      }
      const totalCount = byteCount(response.headers.get('x-total-count'));
      // A real empty RD inventory returns HTTP 204, not an empty JSON array.
      // This exception is endpoint-specific, never generic empty-body success.
      const inventoryRequest = method === 'GET'
        && ((provider === 'real_debrid' && endpoint === 'torrents')
          || (provider === 'torbox' && endpoint === 'torrents/mylist' && !Object.hasOwn(query, 'id')));
      if (inventoryRequest && provider === 'real_debrid' && response.status === 204) {
        return { data: [], totalCount: 0 };
      }
      if (inventoryRequest && response.status !== 200) {
        await response.body?.cancel();
        fail(provider, 'INVALID_RESPONSE', 'provider returned an unsupported inventory response status.');
      }
      if (response.status === 204 || response.status === 202) return { data: null, totalCount };
      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > maxResponseBytes) {
        await response.body?.cancel();
        fail(provider, 'RESPONSE_TOO_LARGE', 'API response exceeded the metadata byte limit.');
      }
      if (!response.body?.getReader) fail(provider, 'INVALID_RESPONSE', 'API returned no readable metadata.');
      reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) {
          await reader.cancel();
          fail(provider, 'RESPONSE_TOO_LARGE', 'API response exceeded the metadata byte limit.');
        }
        chunks.push(Buffer.from(value));
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
      catch { fail(provider, 'INVALID_RESPONSE', 'API returned invalid JSON metadata (body hidden).'); }
      if (provider === 'torbox') {
        if (!payload || payload.success !== true || !Object.hasOwn(payload, 'data')) {
          fail(provider, 'PROVIDER_REJECTED', 'provider rejected the request (response details hidden); no automatic retry was made.');
        }
        return { data: payload.data, totalCount };
      }
      if (!payload || (typeof payload === 'object' && Object.hasOwn(payload, 'error'))) {
        fail(provider, 'PROVIDER_REJECTED', 'provider rejected the request (response details hidden).');
      }
      return { data: payload, totalCount };
    } catch (error) {
      if (error instanceof FootageProviderError) throw error;
      fail(provider, controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED',
        controller.signal.aborted ? 'API request timed out; no automatic retry was made.' : 'API transport failed (details hidden); no automatic retry was made.');
    } finally {
      clearTimeout(timer);
      reader?.releaseLock();
    }
  }

  async function info(source) {
    const id = sourceId(source, provider);
    const { data } = provider === 'torbox'
      ? await request('torrents/mylist', { query: { id, bypass_cache: true } })
      : await request(`torrents/info/${id}`);
    if (!data || Array.isArray(data) || String(data.id) !== id) fail(provider, 'SOURCE_MISMATCH', 'provider did not return the exact requested source.');
    return data;
  }

  async function select({ sourceId: source, fileIds, allowUncached = false } = {}) {
    if (provider !== 'real_debrid') fail(provider, 'UNSUPPORTED_OPERATION', 'TorBox selects all source files server-side; file selection is not supported.');
    if (allowUncached !== true) fail(provider, 'UNCACHED_NOT_AUTHORIZED', 'selecting files may start a server-side download; explicit allowUncached is required.');
    const id = sourceId(source, provider);
    if (!Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 100) {
      fail(provider, 'INVALID_FILE_ID', 'select requires one to one hundred explicit file IDs; all is not accepted.');
    }
    const selectedIds = fileIds.map((value) => fileId(value, provider));
    if (new Set(selectedIds).size !== selectedIds.length) fail(provider, 'INVALID_FILE_ID', 'duplicate file IDs are not accepted.');
    const sourceInfo = await info(id);
    const rows = fileRows(sourceInfo, provider, key);
    if (selectedIds.some((fid) => !rows.some((row) => row.file_id === fid))) fail(provider, 'FILE_NOT_FOUND', 'an explicit file ID is not present in this source.');
    if (sourceInfo.status !== 'waiting_files_selection') {
      fail(provider, 'SELECTION_NOT_PENDING', 'source is not waiting for file selection; existing selections are preserved.');
    }
    await request(`torrents/selectFiles/${id}`, { method: 'POST', body: new URLSearchParams({ files: selectedIds.join(',') }) });
    return { provider, source_id: id, selected_file_ids: selectedIds, status: 'selection_submitted', ready: false };
  }

  return Object.freeze({
    provider,
    async account() {
      const { data } = await request(provider === 'torbox' ? 'user/me' : 'user', { query: provider === 'torbox' ? { settings: false } : {} });
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail(provider, 'INVALID_RESPONSE', 'provider returned invalid account metadata.');
      return {
        provider, authenticated: true,
        plan: provider === 'torbox' ? (Number.isInteger(data.plan) ? data.plan : null) : (['premium', 'free'].includes(data.type) ? data.type : null),
        expires_at: expires(provider === 'torbox' ? data.premium_expires_at : data.expiration),
      };
    },
    async list({ limit = 20, offset = 0, refresh = false } = {}) {
      if (typeof refresh !== 'boolean') fail(provider, 'INVALID_INPUT', 'refresh must be a boolean.');
      if (refresh && provider !== 'torbox') fail(provider, 'UNSUPPORTED_OPERATION', 'Fresh inventory requests are supported only for TorBox.');
      const count = integer(limit, { min: 1, max: MAX_PAGE_SOURCES, label: 'page limit', provider });
      const start = integer(offset, { label: 'page offset', provider });
      const { data, totalCount } = await request(provider === 'torbox' ? 'torrents/mylist' : 'torrents', {
        query: { limit: count, offset: start, ...(refresh ? { bypass_cache: true } : {}) },
      });
      if (!Array.isArray(data) || data.length > count) fail(provider, 'INVALID_RESPONSE', 'provider returned an invalid source page.');
      const items = [];
      const pendingSources = [];
      const seen = new Set();
      for (const source of data) {
        const id = sourceId(source?.id, provider);
        if (seen.has(id)) fail(provider, 'INVALID_RESPONSE', 'provider returned duplicate source IDs.');
        seen.add(id);
        items.push(...fileRows(provider === 'torbox' ? source : await info(id), provider, key));
        if (pendingTorBoxFileMetadata(source, provider)) {
          pendingSources.push({ provider, source_id: id, ready: false,
            readiness_reason: source.download_finished ? 'download_not_present' : 'download_not_finished' });
        }
      }
      const hasMore = totalCount == null ? data.length === count : start + data.length < totalCount;
      return { provider, items, source_count: data.length, pending_source_count: pendingSources.length, pending_sources: pendingSources,
        offset: start, limit: count, has_more: hasMore, next_offset: hasMore ? start + data.length : null };
    },
    async cacheCheck({ hash } = {}) {
      if (provider !== 'torbox') fail(provider, 'UNSUPPORTED_OPERATION', 'Real-Debrid has no supported cache-check endpoint in this integration.');
      const normalized = infoHash(hash, provider);
      const { data } = await request('torrents/checkcached', { query: { hash: normalized, format: 'object', list_files: true } });
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail(provider, 'INVALID_RESPONSE', 'provider returned invalid cache metadata.');
      const cached = data[normalized];
      if (!cached) return { provider, source_hash: normalized, cached: false, files: [] };
      if (recordedHash(cached.hash) !== normalized || !Array.isArray(cached.files)) fail(provider, 'SOURCE_MISMATCH', 'cached metadata does not match the requested info hash.');
      return { provider, source_hash: normalized, cached: true, files: safeCacheFiles(cached.files, provider, key) };
    },
    async add({ magnet, allowUncached = false, fileIds } = {}) {
      const hash = hashFromMagnet(magnet, provider);
      if (typeof allowUncached !== 'boolean') fail(provider, 'INVALID_INPUT', 'allowUncached must be a boolean.');
      if (provider === 'torbox') {
        if (fileIds !== undefined) fail(provider, 'UNSUPPORTED_OPERATION', 'TorBox acquires all files server-side; explicit per-file selection is unavailable.');
        const form = new FormData();
        form.set('magnet', magnet.normalize('NFC'));
        form.set('add_only_if_cached', String(!allowUncached));
        form.set('allow_zip', 'false');
        const { data } = await request('torrents/createtorrent', { method: 'POST', body: form });
        const id = sourceId(data?.torrent_id, provider);
        if (recordedHash(data.hash) !== hash) fail(provider, 'SOURCE_MISMATCH', 'added source hash did not match the requested magnet; inspect the provider account before another add.');
        return { provider, source_id: id, source_hash: hash, status: 'added', cached_only: !allowUncached, ready: false };
      }
      if (allowUncached !== true) fail(provider, 'UNCACHED_NOT_AUTHORIZED', 'Real-Debrid cannot enforce cached-only addition; explicit allowUncached is required.');
      // Validate optional selection before making the irreversible add request.
      if (fileIds !== undefined && (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > 100 || new Set(fileIds.map((id) => fileId(id, provider))).size !== fileIds.length)) {
        fail(provider, 'INVALID_FILE_ID', 'add requires unique explicit file IDs when fileIds is provided.');
      }
      const { data } = await request('torrents/addMagnet', { method: 'POST', body: new URLSearchParams({ magnet: magnet.normalize('NFC') }) });
      const id = sourceId(data?.id, provider);
      if (fileIds !== undefined) {
        try { return { ...await select({ sourceId: id, fileIds, allowUncached }), source_hash: hash }; }
        catch (error) {
          // Preserve the new ID for a deliberate follow-up; never retry an add.
          return { provider, source_id: id, source_hash: hash, status: 'added_selection_pending', ready: false, selection_required: true,
            selection_error_code: error instanceof FootageProviderError ? error.code : 'SELECTION_FAILED' };
        }
      }
      return { provider, source_id: id, source_hash: hash, status: 'added_selection_pending', ready: false, selection_required: true };
    },
    select,
    async resolve({ sourceId: source, fileId: file } = {}) {
      const id = sourceId(source, provider);
      const fid = fileId(file, provider);
      const sourceInfo = await info(id);
      const row = fileRows(sourceInfo, provider, key).find((item) => item.file_id === fid);
      if (pendingTorBoxFileMetadata(sourceInfo, provider)) fail(provider, 'FILE_NOT_READY', 'source file metadata is pending; no file ID or readiness is assumed.');
      if (!row) fail(provider, 'FILE_NOT_FOUND', 'exact file ID was not found in this source.');
      if (!row.ready) fail(provider, 'FILE_NOT_READY', 'exact source file is not ready; no source was added or selected.');
      if (provider === 'torbox') {
        const { data } = await request('torrents/requestdl', { query: { token: key, torrent_id: id, file_id: fid, zip_link: false, redirect: false } });
        return { ...row, url: privateHttpsUrl(data, provider) };
      }
      const selected = sourceInfo.files.filter((item) => Number(item.selected) === 1);
      if (!Array.isArray(sourceInfo.links) || selected.length !== sourceInfo.links.length) {
        fail(provider, 'AMBIGUOUS_FILE_LINK', 'selected files and links are not one-to-one; split/archive sources are unsupported.');
      }
      const selectedIndex = selected.findIndex((item) => String(item.id) === fid);
      const target = selected[selectedIndex];
      if (selected.filter((item) => basename(item.path) === basename(target.path) && byteCount(item.bytes) === byteCount(target.bytes)).length !== 1) {
        fail(provider, 'AMBIGUOUS_FILE_LINK', 'selected source has indistinguishable filenames and sizes; select a source with unambiguous files.');
      }
      const hostLink = privateHttpsUrl(sourceInfo.links[selectedIndex], provider);
      const { data } = await request('unrestrict/link', { method: 'POST', body: new URLSearchParams({ link: hostLink }) });
      // The API does not formally guarantee file/link ordering. Ordering chooses
      // only a candidate; exact returned filename AND bytes prove the binding.
      if (Array.isArray(data) || basename(data?.filename) !== basename(target.path) || row.bytes == null || row.bytes === 0 || byteCount(data?.filesize) !== row.bytes) {
        fail(provider, 'FILE_LINK_MISMATCH', 'resolved filename and size did not prove the exact requested file; no clip may use this link.');
      }
      return { ...row, url: privateHttpsUrl(data.download, provider) };
    },
  });
}
