#!/usr/bin/env node
// Local review only. Byte ranges let the browser seek large MP4/WAV proofs.
import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function startPanelReviewServer({ directory, port = 0 }) {
  const root = await fsp.realpath(directory);
  if (!(await fsp.stat(root)).isDirectory()) throw new Error('Review directory is required');
  const types = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
  const server = http.createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = await fsp.realpath(path.resolve(root, `.${name === '/' ? '/compare.html' : name}`));
      if (!file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
      const stat = await fsp.stat(file);
      if (!stat.isFile()) { response.writeHead(404).end(); return; }
      const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
      let start = 0, end = stat.size - 1, status = 200;
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end(); return; }
        if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end(); return; }
        status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers['Content-Length'] = Math.max(0, end - start + 1);
      response.writeHead(status, headers);
      if (request.method === 'HEAD' || stat.size === 0) { response.end(); return; }
      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--directory', '--port'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/panel-layout-review-server.mjs --directory <proof-directory> [--port <number>]');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!options.directory) throw new Error('--directory is required');
  startPanelReviewServer({ directory: options.directory, port: Number(options.port || 0) }).then(({ url }) => console.log(`Local panel review: ${url}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
