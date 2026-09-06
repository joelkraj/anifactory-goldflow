import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

export function footageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function detectFootageContainer(prefix) {
  if (prefix.length >= 12 && ['ftyp', 'moov', 'mdat', 'free', 'wide'].includes(prefix.toString('ascii', 4, 8))) return 'mov';
  if (prefix.length >= 4 && prefix.readUInt32BE(0) === 0x1a45dfa3) return 'matroska';
  throw footageError('FOOTAGE_FORMAT', 'The selected file is not a native MP4 or MKV container.');
}

// IPv6 is deliberately unsupported for this first lane. DNS answers are validated
// and pinned to the actual socket, so a later DNS change cannot redirect a request.
export function isPublicFootageAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

async function pinnedTarget(value, testAllowedOrigin, signal) {
  let url;
  try { url = new URL(value); } catch { throw footageError('FOOTAGE_URL', 'The media URL is invalid.'); }
  const fixture = testAllowedOrigin && url.origin === testAllowedOrigin && url.hostname === '127.0.0.1';
  if (url.username || url.password || url.hash || (!fixture && url.protocol !== 'https:')
    || (fixture && !['http:', 'https:'].includes(url.protocol))) {
    throw footageError('FOOTAGE_URL', 'Media requires a credential-free public HTTPS URL.');
  }
  if (/\.(?:m3u8?|mpd|pls)(?:$|\/)/i.test(url.pathname)) {
    throw footageError('FOOTAGE_FORMAT', 'Playlists are not supported; select a native MP4 or MKV file.');
  }
  let addresses;
  try {
    addresses = isIP(url.hostname)
      ? [{ address: url.hostname, family: isIP(url.hostname) }]
      : await new Promise((resolve, reject) => {
        const abort = () => reject(footageError('FOOTAGE_TIMEOUT', 'The bounded media transfer timed out.'));
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        lookup(url.hostname, { all: true, family: 4, verbatim: true })
          .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
  } catch { throw footageError('FOOTAGE_NETWORK', 'The media host could not be resolved.'); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicFootageAddress(address) && !(fixture && address === '127.0.0.1'))) {
    throw footageError('FOOTAGE_PRIVATE_HOST', 'Private, reserved, and unsupported media addresses are blocked.');
  }
  return { url, ...addresses[0] };
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw footageError('FOOTAGE_LIMIT', `${label} must be a positive safe integer.`);
}

function responseValidator(headers, origin) {
  const etag = headers.etag;
  // If-Match uses strong comparison; weak ETags cannot bind byte identity.
  if (typeof etag === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) {
    return { kind: 'strong_etag', responseHeader: 'etag', requestHeader: 'If-Match', value: etag, origin };
  }
  const modified = headers['last-modified'];
  if (typeof modified === 'string' && Number.isFinite(Date.parse(modified))
    && new Date(modified).toUTCString() === modified) {
    return { kind: 'last_modified', responseHeader: 'last-modified', requestHeader: 'If-Unmodified-Since', value: modified, origin };
  }
  return null;
}

/** Internal, tokenized, loopback-only byte-range bridge. Never expose its URL in receipts. */
export async function createFootageRangeProxy({ url, bytes, maxBytes = 128 * 1024 * 1024,
  timeoutMs = 120000, chunkBytes = 1024 * 1024, maxRequests = 256, _testAllowedOrigin } = {}) {
  for (const [value, label] of [[maxBytes, 'maxBytes'], [timeoutMs, 'timeoutMs'], [chunkBytes, 'chunkBytes'], [maxRequests, 'maxRequests']]) positiveInteger(value, label);
  if (chunkBytes > 4 * 1024 * 1024) throw footageError('FOOTAGE_LIMIT', 'Range chunks may not exceed 4 MiB.');
  if (bytes != null) positiveInteger(bytes, 'source bytes');
  const controller = new AbortController();
  let fatal = null;
  let closed = false;
  let total = bytes ?? null;
  let resolvedUrl = url;
  let validator;
  let chain = Promise.resolve();
  const cache = new Map();
  const stats = { transferred_bytes: 0, request_count: 0, range_supported: false, source_bytes: total,
    source_version_validation: 'unavailable', source_validator_sha256: null };
  const fail = (error) => {
    const safe = String(error.code ?? '').startsWith('FOOTAGE_') ? error
      : footageError('FOOTAGE_NETWORK', 'The bounded media transfer failed; source details were withheld.');
    if (!fatal && !closed) fatal = safe;
    controller.abort();
    return fatal ?? safe;
  };
  const timer = setTimeout(() => fail(footageError('FOOTAGE_TIMEOUT', 'The bounded media transfer timed out.')), timeoutMs);
  const throwIfStopped = () => {
    if (fatal) throw fatal;
    if (closed || controller.signal.aborted) throw footageError('FOOTAGE_CANCELLED', 'The media transfer has stopped.');
  };

  async function requestRange(start, end, redirectCount = 0, currentUrl = resolvedUrl) {
    throwIfStopped();
    const target = await pinnedTarget(currentUrl, _testAllowedOrigin, controller.signal);
    throwIfStopped();
    if (stats.request_count >= maxRequests) throw fail(footageError('FOOTAGE_REQUEST_LIMIT', 'The media request-count limit was reached.'));
    // Requests are serialized. Reserving the complete requested payload before
    // admission also makes redirects and speculative reads fail closed.
    if (stats.transferred_bytes + end - start + 1 > maxBytes) throw fail(footageError('FOOTAGE_BYTE_LIMIT', 'The media byte budget was reached; no full-download fallback was attempted.'));
    stats.request_count += 1;
    const result = await new Promise((resolve, reject) => {
      const transport = target.url.protocol === 'https:' ? https : http;
      const req = transport.get(target.url, {
        agent: false, signal: controller.signal,
        lookup: (_host, options, callback) => options?.all
          ? callback(null, [{ address: target.address, family: target.family }])
          : callback(null, target.address, target.family),
        headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity', 'User-Agent': 'Goldflow-Footage/1',
          ...(validator && validator.origin === target.url.origin ? { [validator.requestHeader]: validator.value } : {}) },
      }, (res) => {
        const rejectResponse = (code, message) => { reject(footageError(code, message)); res.destroy(); };
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          res.destroy();
          if (!location || redirectCount >= 3) return reject(footageError('FOOTAGE_REDIRECT', 'The media redirect limit was reached or the redirect is invalid.'));
          let destination;
          try { destination = new URL(location, target.url).href; } catch { return reject(footageError('FOOTAGE_REDIRECT', 'The media redirect is invalid.')); }
          return resolve({ redirect: destination });
        }
        if (res.statusCode === 412 && validator) return rejectResponse('FOOTAGE_SOURCE_CHANGED', 'The media source changed during the bounded extraction.');
        if (res.statusCode !== 206) return rejectResponse('FOOTAGE_RANGE_REQUIRED', 'The media host did not honor the bounded range request (206 required).');
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers['content-range'] ?? ''));
        const values = match?.slice(1).map(Number);
        if (!values || values.some((value) => !Number.isSafeInteger(value)) || values[0] !== start
          || values[2] <= start || values[1] !== Math.min(end, values[2] - 1)
          || (total != null && total !== values[2])) {
          return rejectResponse('FOOTAGE_CONTENT_RANGE', 'The media host returned an invalid or changed Content-Range.');
        }
        const expected = values[1] - values[0] + 1;
        if ((res.headers['content-length'] != null && String(expected) !== res.headers['content-length'])
          || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
          return rejectResponse('FOOTAGE_CONTENT_LENGTH', 'The ranged media response has an invalid length or encoding.');
        }
        if (/text\/|json|mpegurl|dash\+xml/i.test(String(res.headers['content-type'] ?? ''))) {
          return rejectResponse('FOOTAGE_FORMAT', 'The media response is not a native video file.');
        }
        if (validator === undefined) {
          validator = responseValidator(res.headers, target.url.origin);
          if (validator) {
            stats.source_version_validation = validator.kind;
            // Raw validators may contain host-specific data; retain only a hash.
            stats.source_validator_sha256 = createHash('sha256').update(`${validator.kind}\n${validator.value}`).digest('hex');
          }
        } else if (validator && res.headers[validator.responseHeader] !== validator.value) {
          return rejectResponse('FOOTAGE_SOURCE_CHANGED', 'The media source validator changed or disappeared during extraction.');
        }
        // Without a first-response validator, equal size and bounded ranges do
        // not prove an immutable source. Keep that limitation explicit in stats.
        total = values[2];
        stats.source_bytes = total;
        let received = 0;
        const parts = [];
        res.on('data', (part) => {
          received += part.length;
          stats.transferred_bytes += part.length;
          if (received > expected || stats.transferred_bytes > maxBytes) {
            rejectResponse('FOOTAGE_BYTE_LIMIT', 'The media response exceeded its reserved byte range.');
          } else parts.push(part);
        });
        res.on('aborted', () => reject(footageError('FOOTAGE_TRUNCATED', 'The ranged media response ended early.')));
        res.on('error', () => reject(footageError('FOOTAGE_NETWORK', 'The ranged media response failed.')));
        res.on('end', () => {
          if (received !== expected) return reject(footageError('FOOTAGE_TRUNCATED', 'The ranged media response ended early.'));
          stats.range_supported = true;
          resolvedUrl = target.url.href;
          resolve({ data: Buffer.concat(parts, received) });
        });
      });
      req.on('error', () => reject(fatal ?? footageError('FOOTAGE_NETWORK', 'The bounded media request failed.')));
    });
    if (result.redirect) return requestRange(start, end, redirectCount + 1, result.redirect);
    return result.data;
  }

  function read(start, end) {
    const key = `${start}-${end}`;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    const task = chain.then(async () => {
      throwIfStopped();
      if (cache.has(key)) return cache.get(key);
      const result = await requestRange(start, end);
      cache.set(key, result);
      while (cache.size > 8) cache.delete(cache.keys().next().value);
      return result;
    }).catch((error) => { throw fail(error); });
    chain = task.catch(() => {});
    return task;
  }

  let server;
  const close = async () => {
    closed = true;
    clearTimeout(timer);
    controller.abort();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await chain;
  };
  try {
    const prefix = await read(0, Math.min(4095, (total ?? 4096) - 1, maxBytes - 1));
    const container = detectFootageContainer(prefix);
    stats.source_probe_sha256 = createHash('sha256').update(prefix).digest('hex');
    const tokenPath = `/${randomBytes(24).toString('hex')}/media`;
    server = http.createServer(async (req, res) => {
      // Exact token path, no CORS, no forwarding of incoming headers or URLs.
      if (req.url !== tokenPath || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return; }
      try {
        throwIfStopped();
        const match = req.headers.range == null ? null : /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (req.headers.range != null && !match) { res.writeHead(416); res.end(); return; }
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0) { res.writeHead(416); res.end(); return; }
        res.writeHead(match ? 206 : 200, {
          'Accept-Ranges': 'bytes', 'Content-Type': container === 'mov' ? 'video/mp4' : 'video/x-matroska',
          'Content-Length': end - start + 1, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
          'Cache-Control': 'no-store', Connection: 'close',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        let position = start;
        while (position <= end && !res.destroyed && !res.writableEnded) {
          const rangeStart = Math.floor(position / chunkBytes) * chunkBytes;
          const rangeEnd = Math.min(total - 1, rangeStart + chunkBytes - 1);
          const data = await read(rangeStart, rangeEnd);
          if (res.destroyed) break;
          const count = Math.min(end - position + 1, rangeEnd - position + 1);
          const writable = res.write(data.subarray(position - rangeStart, position - rangeStart + count));
          position += count;
          if (!writable && !res.destroyed) await new Promise((resolve) => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.once('drain', done); res.once('close', done);
          });
        }
        if (!res.destroyed) res.end();
      } catch { res.destroy(); }
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return {
      url: `http://127.0.0.1:${server.address().port}${tokenPath}`,
      stats, container, close, get failure() { return fatal; },
      assertHealthy: throwIfStopped,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
