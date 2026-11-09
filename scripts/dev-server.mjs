#!/usr/bin/env node
// Local preview: rebuilds the site whenever a page is (re)loaded, then serves it.
//
//   node scripts/dev-server.mjs --content demo [--port 4321]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from '../build/build.mjs';
import { escapeHtml } from '../build/markdown.mjs';

const { values } = parseArgs({
  options: {
    content: { type: 'string', default: 'demo' },
    port: { type: 'string', default: '4321' },
  },
});

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ENGINE_ROOT, '.dev-site');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const quietLog = { log: () => {}, warn: console.warn, error: console.error };

const ALLOWED_HOSTS = new Set([`localhost:${values.port}`, `127.0.0.1:${values.port}`]);

// Requests that arrive while a build is running share it (two builds at once
// would delete each other's output).
let running = null;
function rebuild() {
  running ??= (async () => {
    const errors = [];
    try {
      const result = await build({
        contentDir: values.content,
        outDir: OUT,
        log: { ...quietLog, error: (m) => errors.push(m) },
      });
      return { ok: result.ok, errors };
    } catch (err) {
      return { ok: false, errors: [String(err?.stack ?? err)] };
    } finally {
      running = null;
    }
  })();
  return running;
}

const server = createServer(async (req, res) => {
  // Only answer requests for this machine (protects against DNS rebinding).
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  if (pathname === '/index.html') {
    const { ok, errors } = await rebuild();
    if (!ok) {
      res.writeHead(500, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><meta charset="utf-8"><title>Build failed</title><h1>Build failed</h1><pre>${escapeHtml(errors.join('\n'))}</pre>`);
      return;
    }
  }

  const file = path.join(OUT, pathname);
  if (!file.startsWith(OUT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(await readFile(file));
  } catch {
    if (res.headersSent) return;
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

// 127.0.0.1: reachable only from this computer, not from the network.
server.listen(Number(values.port), '127.0.0.1', () => {
  console.log(`Preview: http://localhost:${values.port}/  (reload the page to rebuild)`);
});
