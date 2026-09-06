import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createFootageProvider, loadFootageConfig, footageConfigStatus,
} from '../lib/footage-providers.mjs';

const KEY = 'private-test-token-not-a-real-key';
const HASH = '0123456789abcdef0123456789abcdef01234567';
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=fixture.mp4`;
const PRIVATE_URL = `https://cdn.example.test/private.mp4?token=${KEY}`;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const torbox = (data) => json({ success: true, error: null, detail: 'provider details stay private', data });
function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    assert.equal(options.redirect, 'manual', 'authenticated requests must not follow redirects');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.ok(options.signal instanceof AbortSignal);
    if (!responses.length) throw new Error('unexpected network call');
    const response = responses.shift();
    return typeof response === 'function' ? response(url, options) : response;
  };
  return { fetchImpl, calls };
}
function client(provider, responses, options = {}) {
  const mock = mockFetch(responses);
  return { ...mock, api: createFootageProvider(provider, { apiKey: KEY, fetchImpl: mock.fetchImpl, ...options }) };
}
function tbSource(overrides = {}) {
  return { id: 4, hash: HASH, download_finished: true, download_present: true, airlocked: false,
    files: [{ id: 0, name: 'fixture/movie.mp4', size: 1000, zipped: false, infected: false }], ...overrides };
}
function rdSource(overrides = {}) {
  return { id: 'ABC', hash: HASH, status: 'downloaded',
    files: [{ id: 7, path: '/movie.mp4', bytes: 1000, selected: 1 }], links: ['https://real-debrid.com/d/FILE7'], ...overrides };
}
async function rejectsSafe(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.name, 'FootageProviderError');
    assert.ok(!String(error.stack).includes(KEY));
    assert.ok(!String(error.stack).includes(PRIVATE_URL));
    assert.ok(!JSON.stringify(error).includes(KEY));
    return true;
  });
}

test('configuration loads only explicit file keys, environment wins, status exposes booleans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldflow-footage-config-'));
  try {
    fs.writeFileSync(path.join(dir, '.env.footage.local'), `# secrets never evaluated\nGOLDFLOW_TORBOX_API_KEY='file-token' # note\nGOLDFLOW_REAL_DEBRID_API_KEY="file-rd-token"\n`, { mode: 0o600 });
    const config = loadFootageConfig({ repoRoot: dir, env: { GOLDFLOW_TORBOX_API_KEY: KEY } });
    assert.equal(config.torboxApiKey, KEY);
    assert.equal(config.realDebridApiKey, 'file-rd-token');
    assert.equal(config.configPath, path.join(dir, '.env.footage.local'));
    const status = footageConfigStatus(config);
    assert.deepEqual(status.providers, { torbox: { configured: true }, real_debrid: { configured: true } });
    assert.ok(!JSON.stringify(status).includes(KEY));
    assert.equal(loadFootageConfig({ repoRoot: dir, env: { GOLDFLOW_TORBOX_API_KEY: '' } }).torboxApiKey, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('configuration is optional and rejects shell expansion, unknown/duplicate keys and multiline secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldflow-footage-config-invalid-'));
  try {
    assert.equal(loadFootageConfig({ repoRoot: dir, env: {} }).torboxApiKey, '');
    for (const contents of [
      `GOLDFLOW_TORBOX_API_KEY=$(echo ${KEY})`, `GOLDFLOW_TORBOX_API_KEY=\`${KEY}\``,
      `UNEXPECTED=${KEY}`, `GOLDFLOW_TORBOX_API_KEY='${KEY}\nother'`,
      `GOLDFLOW_TORBOX_API_KEY=${KEY}\nGOLDFLOW_TORBOX_API_KEY=second`,
    ]) {
      fs.writeFileSync(path.join(dir, '.env.footage.local'), contents);
      assert.throws(() => loadFootageConfig({ repoRoot: dir, env: {} }), (error) => !error.message.includes(KEY));
    }
    fs.writeFileSync(path.join(dir, '.env.footage.local'), '#'.repeat(65_537));
    assert.throws(() => loadFootageConfig({ repoRoot: dir, env: {} }), { code: 'INVALID_CONFIG' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('configuration/key validation never prints invalid input', () => {
  assert.throws(() => createFootageProvider('other', { apiKey: KEY }), { code: 'INVALID_PROVIDER' });
  assert.throws(() => createFootageProvider('torbox'), { code: 'KEY_MISSING' });
  assert.throws(() => createFootageProvider('torbox', { apiKey: `${KEY}\nsecret` }), (error) => !error.message.includes(KEY));
});

test('TorBox account uses canonical endpoint and exposes no email/auth/customer data', async () => {
  const { api, calls } = client('torbox', [torbox({ email: 'private@example.test', auth_id: KEY, customer: KEY,
    plan: 2, premium_expires_at: '2027-01-01T00:00:00Z' })]);
  assert.deepEqual(await api.account(), { provider: 'torbox', authenticated: true, plan: 2, expires_at: '2027-01-01T00:00:00.000Z' });
  assert.equal(calls[0].url.href, 'https://api.torbox.app/v1/api/user/me?settings=false');
});

test('Real-Debrid account aliases normalize and only allow known plan/date fields', async () => {
  const { api, calls } = client('real-debrid', [json({ type: 'premium', expiration: '2027-01-01T00:00:00Z', email: KEY, username: KEY })]);
  assert.equal(api.provider, 'real_debrid');
  assert.deepEqual(await api.account(), { provider: 'real_debrid', authenticated: true, plan: 'premium', expires_at: '2027-01-01T00:00:00.000Z' });
  assert.equal(calls[0].url.pathname, '/rest/1.0/user');
});

test('TorBox inventory requires completed AND present; infected/zipped/airlocked sources are not ready', async () => {
  const sources = [tbSource(), tbSource({ id: 5, download_finished: false }), tbSource({ id: 6, download_present: false }),
    tbSource({ id: 7, airlocked: true }), tbSource({ id: 8, files: [{ id: 0, name: 'zip.mp4', size: 100, zipped: true }] }),
    tbSource({ id: 9, files: [{ id: 0, name: 'bad.mp4', size: 100, infected: true }] })];
  const { api, calls } = client('torbox', [torbox(sources)]);
  const result = await api.list({ limit: 6, offset: 2 });
  assert.deepEqual(result.items.map((row) => row.ready), [true, false, false, false, false, false]);
  assert.deepEqual(result.items[0], { provider: 'torbox', source_id: '4', file_id: '0', filename: 'movie.mp4', bytes: 1000, ready: true, source_hash: HASH });
  assert.equal(result.next_offset, 8);
  assert.equal(result.source_count, 6);
  assert.equal(calls[0].url.searchParams.get('offset'), '2');
});

test('Real-Debrid inventory reads exact source details, preserves unselected files and pagination', async () => {
  const details = rdSource({ files: [{ id: 7, path: '/movie.mp4', bytes: 1000, selected: 1 }, { id: 8, path: '/bonus.mp4', bytes: 200, selected: 0 }] });
  const { api, calls } = client('real_debrid', [json([{ id: 'ABC' }], 200, { 'x-total-count': '5' }), json(details)]);
  const result = await api.list({ limit: 1, offset: 1 });
  assert.deepEqual(result.items.map((row) => [row.file_id, row.ready]), [['7', true], ['8', false]]);
  assert.equal(result.next_offset, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.pathname, '/rest/1.0/torrents/info/ABC');
});

test('inventory is bounded and never dumps metadata URLs/tokens', async () => {
  const { api, calls } = client('torbox', [torbox([tbSource({ files: [{ id: 0, name: `${KEY}.mp4`, size: 20 }] })])]);
  const result = await api.list();
  assert.equal(calls[0].url.searchParams.get('limit'), '20');
  assert.equal(result.has_more, false);
  assert.ok(!JSON.stringify(result).includes(KEY));
  await rejectsSafe(() => api.list({ limit: 101 }), 'INVALID_INPUT');
  assert.equal(calls.length, 1);
});

test('TorBox cache hit/miss use explicit object format and files', async () => {
  const { api, calls } = client('torbox', [torbox({ [HASH]: { hash: HASH, files: [{ id: 7, name: 'fixture/movie.mp4', size: 1000 }] } }), torbox({})]);
  assert.deepEqual(await api.cacheCheck({ hash: HASH.toUpperCase() }), { provider: 'torbox', source_hash: HASH, cached: true,
    files: [{ file_id: '7', filename: 'movie.mp4', bytes: 1000 }] });
  assert.equal((await api.cacheCheck({ hash: HASH })).cached, false);
  assert.equal(calls[0].url.searchParams.get('format'), 'object');
  assert.equal(calls[0].url.searchParams.get('list_files'), 'true');
});

test('Real-Debrid cached-only add/cache check are refused before network', async () => {
  const { api, calls } = client('real_debrid', []);
  await rejectsSafe(() => api.cacheCheck({ hash: HASH }), 'UNSUPPORTED_OPERATION');
  await rejectsSafe(() => api.add({ magnet: MAGNET }), 'UNCACHED_NOT_AUTHORIZED');
  assert.equal(calls.length, 0);
});

test('TorBox add defaults cached-only and forbids implicit zip acquisition', async () => {
  const { api, calls } = client('torbox', [torbox({ torrent_id: 5, hash: HASH, auth_id: KEY }), torbox({ torrent_id: 6, hash: HASH })]);
  const added = await api.add({ magnet: MAGNET });
  assert.deepEqual(added, { provider: 'torbox', source_id: '5', source_hash: HASH, status: 'added', cached_only: true, ready: false });
  assert.equal(calls[0].url.pathname, '/v1/api/torrents/createtorrent');
  assert.ok(calls[0].options.body instanceof FormData);
  assert.equal(calls[0].options.body.get('add_only_if_cached'), 'true');
  assert.equal(calls[0].options.body.get('allow_zip'), 'false');
  await api.add({ magnet: MAGNET, allowUncached: true });
  assert.equal(calls[1].options.body.get('add_only_if_cached'), 'false');
});

test('Real-Debrid explicit add never selects all files implicitly', async () => {
  const { api, calls } = client('real_debrid', [json({ id: 'ABC', uri: PRIVATE_URL }, 201)]);
  const result = await api.add({ magnet: MAGNET, allowUncached: true });
  assert.equal(result.source_id, 'ABC');
  assert.equal(result.selection_required, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.body.get('magnet'), MAGNET);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('Real-Debrid explicit select validates requested file membership and mutation permission', async () => {
  const { api, calls } = client('real_debrid', [json(rdSource({ status: 'waiting_files_selection' })), new Response(null, { status: 204 })]);
  await rejectsSafe(() => api.select({ sourceId: 'ABC', fileIds: [7] }), 'UNCACHED_NOT_AUTHORIZED');
  const selected = await api.select({ sourceId: 'ABC', fileIds: [7], allowUncached: true });
  assert.deepEqual(selected.selected_file_ids, ['7']);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.pathname, '/rest/1.0/torrents/selectFiles/ABC');
  assert.equal(calls[1].options.body.get('files'), '7');
});

test('selection cannot overwrite an active/finished source or select unknown IDs', async () => {
  for (const [details, fileIds, code] of [[rdSource(), [7], 'SELECTION_NOT_PENDING'], [rdSource({ status: 'waiting_files_selection' }), [999], 'FILE_NOT_FOUND']]) {
    const { api, calls } = client('real_debrid', [json(details)]);
    await rejectsSafe(() => api.select({ sourceId: 'ABC', fileIds, allowUncached: true }), code);
    assert.equal(calls.length, 1);
  }
});

test('optional Real-Debrid selection preserves newly added source when metadata is not ready', async () => {
  const { api, calls } = client('real_debrid', [json({ id: 'ABC' }, 201), json(rdSource({ status: 'magnet_conversion', files: [] }))]);
  const result = await api.add({ magnet: MAGNET, allowUncached: true, fileIds: [7] });
  assert.equal(result.source_id, 'ABC');
  assert.equal(result.selection_required, true);
  assert.equal(result.selection_error_code, 'FILE_NOT_FOUND');
  assert.equal(calls.length, 2, 'add must not be retried/polled');
});

test('TorBox resolves exact file ID including zero and private URL is only in resolve result', async () => {
  const { api, calls } = client('torbox', [torbox(tbSource()), torbox(PRIVATE_URL)]);
  const result = await api.resolve({ sourceId: '4', fileId: '0' });
  assert.equal(result.url, PRIVATE_URL);
  assert.equal(result.file_id, '0');
  assert.equal(calls[0].url.searchParams.get('bypass_cache'), 'true');
  assert.equal(calls[1].url.searchParams.get('token'), KEY);
  assert.equal(calls[1].url.searchParams.get('file_id'), '0');
  assert.equal(calls[1].url.searchParams.get('zip_link'), 'false');
  assert.equal(calls[1].url.searchParams.get('redirect'), 'false');
});

test('resolve refuses not-ready or unselected files without mutating/resolving links', async () => {
  for (const [provider, response, source, file] of [
    ['torbox', torbox(tbSource({ download_present: false })), '4', '0'],
    ['real_debrid', json(rdSource({ files: [{ id: 7, path: '/movie.mp4', bytes: 1000, selected: 0 }] })), 'ABC', '7'],
    ['real_debrid', json(rdSource({ status: 'downloading' })), 'ABC', '7'],
  ]) {
    const { api, calls } = client(provider, [response]);
    await rejectsSafe(() => api.resolve({ sourceId: source, fileId: file }), 'FILE_NOT_READY');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, 'GET');
  }
});

test('Real-Debrid resolves exact selected-file candidate and verifies basename AND bytes', async () => {
  const details = rdSource({ files: [{ id: 2, path: '/skip.txt', bytes: 9, selected: 0 },
    { id: 5, path: '/extras/bonus.mp4', bytes: 200, selected: 1 }, { id: 7, path: '/feature/movie.mp4', bytes: 1000, selected: 1 }],
    links: ['https://real-debrid.com/d/BONUS', 'https://real-debrid.com/d/MOVIE'] });
  const { api, calls } = client('real_debrid', [json(details), json({ filename: 'movie.mp4', filesize: 1000, download: PRIVATE_URL })]);
  const result = await api.resolve({ sourceId: 'ABC', fileId: 7 });
  assert.equal(result.filename, 'movie.mp4');
  assert.equal(result.url, PRIVATE_URL);
  assert.equal(calls[1].options.body.get('link'), 'https://real-debrid.com/d/MOVIE');
  assert.equal(calls[1].url.pathname, '/rest/1.0/unrestrict/link');
});

test('Real-Debrid rejects split links, duplicate basename/size, wrong filename, wrong bytes', async () => {
  const split = client('real_debrid', [json(rdSource({ links: ['https://real-debrid.com/d/A', 'https://real-debrid.com/d/B'] }))]);
  await rejectsSafe(() => split.api.resolve({ sourceId: 'ABC', fileId: 7 }), 'AMBIGUOUS_FILE_LINK');
  assert.equal(split.calls.length, 1);
  const duplicate = client('real_debrid', [json(rdSource({ files: [{ id: 7, path: '/a/movie.mp4', bytes: 1000, selected: 1 },
    { id: 8, path: '/b/movie.mp4', bytes: 1000, selected: 1 }], links: ['https://real-debrid.com/d/A', 'https://real-debrid.com/d/B'] }))]);
  await rejectsSafe(() => duplicate.api.resolve({ sourceId: 'ABC', fileId: 7 }), 'AMBIGUOUS_FILE_LINK');
  for (const response of [{ filename: 'different.mp4', filesize: 1000 }, { filename: 'movie.mp4', filesize: 999 }]) {
    const { api } = client('real_debrid', [json(rdSource()), json({ ...response, download: PRIVATE_URL })]);
    await rejectsSafe(() => api.resolve({ sourceId: 'ABC', fileId: 7 }), 'FILE_LINK_MISMATCH');
  }
});

test('invalid hashes/IDs/magnets cannot cause network calls or expose source data', async () => {
  const { api, calls } = client('torbox', []);
  await rejectsSafe(() => api.cacheCheck({ hash: KEY }), 'INVALID_HASH');
  await rejectsSafe(() => api.add({ magnet: `https://example.test/${KEY}` }), 'INVALID_MAGNET');
  await rejectsSafe(() => api.resolve({ sourceId: '../user', fileId: 0 }), 'INVALID_SOURCE_ID');
  await rejectsSafe(() => api.resolve({ sourceId: 4, fileId: 'all' }), 'INVALID_FILE_ID');
  assert.equal(calls.length, 0);
});

test('HTTP, provider, JSON, transport and redirect failures hide secrets and do not retry', async () => {
  const cases = [
    [json({ error: KEY, detail: PRIVATE_URL }, 401), 'HTTP_401'],
    [json({ success: false, error: KEY, detail: PRIVATE_URL }), 'PROVIDER_REJECTED'],
    [new Response(`not json ${PRIVATE_URL}`), 'INVALID_RESPONSE'],
    [() => { throw new Error(`failed fetch ${PRIVATE_URL}`); }, 'REQUEST_FAILED'],
    [new Response(null, { status: 302, headers: { location: PRIVATE_URL } }), 'HTTP_302'],
  ];
  for (const [response, code] of cases) {
    const { api, calls } = client('torbox', [response]);
    await rejectsSafe(() => api.account(), code);
    assert.equal(calls.length, 1);
  }
});

test('response size limits apply both declared and chunked bytes', async () => {
  for (const headers of [{ 'content-length': '999' }, {}]) {
    const { api } = client('torbox', [json({ success: true, data: KEY }, 200, headers)], { maxResponseBytes: 20 });
    await rejectsSafe(() => api.account(), 'RESPONSE_TOO_LARGE');
  }
});

test('timeout aborts transport without exposing credential-bearing request URL', async () => {
  const { api, calls } = client('torbox', [(_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error(PRIVATE_URL)), { once: true });
  })], { timeoutMs: 5 });
  await rejectsSafe(() => api.account(), 'REQUEST_TIMEOUT');
  assert.equal(calls.length, 1);
});

test('non-HTTPS and credential-embedded download links fail closed', async () => {
  for (const link of ['http://cdn.example.test/movie.mp4', 'https://user:password@cdn.example.test/movie.mp4']) {
    const { api } = client('torbox', [torbox(tbSource()), torbox(link)]);
    await rejectsSafe(() => api.resolve({ sourceId: 4, fileId: 0 }), 'INVALID_DOWNLOAD_URL');
  }
});

test('provider identity and duplicate file metadata cannot silently select another source', async () => {
  const wrong = client('torbox', [torbox(tbSource({ id: 8 }))]);
  await rejectsSafe(() => wrong.api.resolve({ sourceId: 4, fileId: 0 }), 'SOURCE_MISMATCH');
  const duplicates = client('torbox', [torbox([tbSource({ files: [{ id: 0, name: 'a.mp4' }, { id: 0, name: 'b.mp4' }] })])]);
  await rejectsSafe(() => duplicates.api.list(), 'INVALID_RESPONSE');
});

test('TorBox rejects a cache result for another hash or duplicate cache file IDs', async () => {
  for (const [data, code] of [
    [{ [HASH]: { hash: 'a'.repeat(40), files: [] } }, 'SOURCE_MISMATCH'],
    [{ [HASH]: { hash: HASH, files: [{ id: 0 }, { id: 0 }] } }, 'INVALID_RESPONSE'],
  ]) {
    const { api } = client('torbox', [torbox(data)]);
    await rejectsSafe(() => api.cacheCheck({ hash: HASH }), code);
  }
});

test('magnet base32 hash is normalized and multiple v1 hashes are rejected', async () => {
  const zeroHash = '0'.repeat(40);
  const { api, calls } = client('torbox', [torbox({ torrent_id: 8, hash: zeroHash })]);
  const result = await api.add({ magnet: `magnet:?xt=urn:btih:${'A'.repeat(32)}` });
  assert.equal(result.source_hash, zeroHash);
  await rejectsSafe(() => api.add({ magnet: `${MAGNET}&xt=urn:btih:${HASH}` }), 'INVALID_MAGNET');
  assert.equal(calls.length, 1);
});

test('invalid mutation scope is rejected before creating or selecting remote sources', async () => {
  const { api, calls } = client('real_debrid', []);
  await rejectsSafe(() => api.add({ magnet: MAGNET, allowUncached: true, fileIds: ['all'] }), 'INVALID_FILE_ID');
  await rejectsSafe(() => api.add({ magnet: MAGNET, allowUncached: true, fileIds: [7, '7'] }), 'INVALID_FILE_ID');
  await rejectsSafe(() => api.select({ sourceId: 'ABC', fileIds: [7, 7], allowUncached: true }), 'INVALID_FILE_ID');
  assert.equal(calls.length, 0);
});

for (const [name, fn] of tests) {
  await fn();
  process.stdout.write(`ok - ${name}\n`);
}
process.stdout.write(`footage provider tests passed (${tests.length} tests)\n`);
