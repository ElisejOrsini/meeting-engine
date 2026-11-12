#!/usr/bin/env node
// Local preview: rebuilds the site whenever a page is (re)loaded, then serves it.
//
//   node scripts/dev-server.mjs --content demo [--port 4321] [--mock-backend]
//   node scripts/dev-server.mjs --content demo-private --local-backend [--import demo]
//
// --mock-backend replaces the Supabase client with scripts/mock-supabase.js:
// sign-in and survey answers are simulated in the browser, so they can be
// tried without a real sign-in.
//
// --local-backend is for private courses (course.yml: private: true): it runs
// the real database setup in a local, in-memory database (scripts/local-backend.mjs),
// and the site talks to it instead of Supabase, with pretend sign-in
// (scripts/local-supabase.js). --import <folder> first imports a content
// folder through the agent API, and publishes its meetings. Nothing is saved:
// restarting the server starts from scratch.
//
// --hub <folder> --base <path> preview a site that has other pages next to the
// meeting site (like AIP-PAGE): files from <folder> are served at /, and the
// meeting site at /<path>/.

import { createServer } from 'node:http';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from '../build/build.mjs';
import { escapeHtml } from '../build/markdown.mjs';
import { loadContent } from '../build/content.mjs';
import { createLocalBackend } from './local-backend.mjs';

const { values } = parseArgs({
  options: {
    content: { type: 'string', default: 'demo' },
    port: { type: 'string', default: '4321' },
    'mock-backend': { type: 'boolean', default: false },
    'local-backend': { type: 'boolean', default: false },
    import: { type: 'string' },
    hub: { type: 'string' },
    base: { type: 'string', default: '' },
  },
});
const BASE = values.base.replace(/^\/+|\/+$/g, '');
const SITE_PREFIX = BASE ? `/${BASE}/` : '/';
const ORIGIN = `http://localhost:${values.port}`;

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// One build folder per port, so two previews (e.g. with and without the mock
// backend) don't overwrite each other.
const OUT = path.join(ENGINE_ROOT, '.dev-site', values.port);
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
      if (result.ok && values['mock-backend'] && result.site.backend) {
        await copyFile(path.join(ENGINE_ROOT, 'scripts', 'mock-supabase.js'), path.join(OUT, 'vendor', 'supabase.js'));
      }
      if (result.ok && localBackend) {
        // Point the site at the local backend (this server) instead of Supabase.
        await copyFile(path.join(ENGINE_ROOT, 'scripts', 'local-supabase.js'), path.join(OUT, 'vendor', 'supabase.js'));
        const siteFile = path.join(OUT, 'data', 'site.json');
        const site = JSON.parse(await readFile(siteFile, 'utf8'));
        const realUrl = site.backend.url;
        site.backend.url = ORIGIN;
        await writeFile(siteFile, JSON.stringify(site));
        const indexFile = path.join(OUT, 'index.html');
        await writeFile(indexFile, (await readFile(indexFile, 'utf8')).replaceAll(realUrl, ORIGIN));
      }
      return { ok: result.ok, errors };
    } catch (err) {
      return { ok: false, errors: [String(err?.stack ?? err)] };
    } finally {
      running = null;
    }
  })();
  return running;
}

let localBackend = null;
if (values['local-backend']) {
  const content = await loadContent(values.content);
  if (!content.site.private) {
    console.error('--local-backend needs a private course (course.yml: private: true), e.g. --content demo-private');
    process.exit(2);
  }
  console.log('Starting the local backend (the real database setup, in memory)…');
  localBackend = await createLocalBackend({
    courseId: content.site.backend.course_id,
    courseName: content.site.course.name,
    siteUrl: `${ORIGIN}${SITE_PREFIX}`,
    importFrom: values.import,
  });
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
  if (localBackend && await localBackend.handle(req, res, pathname)) return;
  if (BASE && pathname === `/${BASE}`) {
    res.writeHead(301, { location: SITE_PREFIX }).end();
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  let root = OUT;
  if (values.hub && !pathname.startsWith(SITE_PREFIX)) {
    root = path.resolve(values.hub);
  } else if (BASE) {
    pathname = pathname.slice(SITE_PREFIX.length - 1);
  }

  if (root === OUT && pathname === '/index.html') {
    const { ok, errors } = await rebuild();
    if (!ok) {
      res.writeHead(500, { 'content-type': TYPES['.html'] });
      res.end(`<!doctype html><meta charset="utf-8"><title>Build failed</title><h1>Build failed</h1><pre>${escapeHtml(errors.join('\n'))}</pre>`);
      return;
    }
  }

  const file = path.join(root, pathname);
  if (!file.startsWith(root + path.sep)) {
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
  console.log(`Preview: http://localhost:${values.port}${SITE_PREFIX}  (reload the page to rebuild)`);
  if (values.hub) console.log(`Hub: http://localhost:${values.port}/ (from ${values.hub})`);
  if (values['mock-backend']) console.log('Mock backend: sign-in and survey answers are simulated in this browser.');
  if (localBackend) {
    console.log('Local backend: "Sign in" signs you in as you-in-preview (organizer). To be someone else, run in the');
    console.log('browser console: localStorage.setItem("meeting-engine-local-user", "1002") (teammate) or "4001" (stranger).');
  }
});
