#!/usr/bin/env node
// Build a meeting site.
//
//   node build/build.mjs --content <folder> --out <folder>   build the site
//   node build/build.mjs --content <folder> --check          only validate content
//
// <folder> contains course.yml and meetings/. See docs/content-format.md.

import { realpathSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadContent } from './content.mjs';
import { escapeHtml } from './markdown.mjs';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ENGINE_ROOT, 'src');
// Written into every output folder. The build only deletes a folder that has it.
const OUTPUT_MARKER = '.meeting-engine-output';
const require = createRequire(import.meta.url);

/**
 * The Content-Security-Policy connect-src: the site itself, plus the backend
 * if there is one; private courses also look up GitHub usernames (Team page).
 */
export function connectSrc(backend, { isPrivate = false } = {}) {
  if (!backend) return `'self'`;
  return isPrivate ? `'self' ${backend.url} https://api.github.com` : `'self' ${backend.url}`;
}

export async function engineVersion() {
  const pkg = JSON.parse(await readFile(path.join(ENGINE_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/**
 * The real on-disk path (symlinks resolved, and on macOS the real upper/lower
 * case). For a folder that doesn't exist yet, resolve its nearest parent.
 */
function realPath(p) {
  const abs = path.resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realPath(parent), path.basename(abs));
  }
}

/** Returns an error message if `out` must not be deleted and rebuilt, else null. */
async function checkOutputFolder(out, contentDir) {
  const realOut = realPath(out);
  for (const protectedDir of [contentDir, ENGINE_ROOT, process.cwd()].map(realPath)) {
    if (isInside(realOut, protectedDir)) return `it contains ${protectedDir}`;
  }
  let info;
  try {
    info = await lstat(out);
  } catch (err) {
    if (err.code === 'ENOENT') return null; // doesn't exist yet
    throw err;
  }
  if (!info.isDirectory()) return 'it is a file or link, not a folder; choose a folder name for the website';
  const entries = await readdir(out);
  if (entries.length && !entries.includes(OUTPUT_MARKER)) {
    return 'it already exists and was not created by this build (delete it yourself or pick another folder)';
  }
  return null;
}

/** Validate content and, unless `check` is set, write the site to `outDir`. */
export async function build({ contentDir, outDir, check = false, log = console }) {
  const result = await loadContent(contentDir, { engineVersion: await engineVersion() });
  for (const w of result.warnings) log.warn(`warning: ${w}`);
  if (result.errors.length) {
    for (const e of result.errors) log.error(`error: ${e}`);
    log.error(`\n${result.errors.length} problem(s) found in ${contentDir}. Nothing was built.`);
    return { ok: false, ...result };
  }
  const count = result.site.meetings.length;
  if (check) {
    log.log(`Content OK: ${count} meeting(s), ${result.warnings.length} warning(s).`);
    return { ok: true, ...result };
  }

  const out = path.resolve(outDir);
  const refusal = await checkOutputFolder(out, contentDir);
  if (refusal) {
    log.error(`error: refusing to use "${outDir}" as output folder: ${refusal}`);
    return { ok: false, ...result };
  }
  await rm(out, { recursive: true, force: true });
  await cp(SRC_DIR, out, { recursive: true });
  await writeFile(path.join(out, OUTPUT_MARKER), 'Built by meeting-engine. This folder is deleted on every build.\n');

  const indexFile = path.join(out, 'index.html');
  const index = await readFile(indexFile, 'utf8');
  const courseName = escapeHtml(result.site.course.name);
  // Replacer functions, so "$&" etc. in the name are not treated as patterns.
  await writeFile(indexFile, index
    .replaceAll('{{COURSE_NAME}}', () => courseName)
    .replaceAll('{{CONNECT_SRC}}', () => connectSrc(result.site.backend, { isPrivate: result.site.private }))); // URL checked by the loader

  if (result.site.backend) {
    // The Supabase browser client (pinned in package.json), served from the
    // site itself so the page's script policy can stay "own origin only".
    const client = require.resolve('@supabase/supabase-js/dist/umd/supabase.js');
    await mkdir(path.join(out, 'vendor'), { recursive: true });
    await cp(client, path.join(out, 'vendor', 'supabase.js'));
    await cp(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'LICENSE'),
      path.join(out, 'vendor', 'supabase.LICENSE.txt'));
  }

  if (result.site.private) {
    // Private courses render Markdown in the browser, with the same renderer
    // and safety rules the build uses (build/markdown.mjs), and the same
    // pinned version of marked, served from the site itself.
    const markdown = await readFile(path.join(ENGINE_ROOT, 'build', 'markdown.mjs'), 'utf8');
    const browserMarkdown = markdown.replace("from 'marked';", "from '../vendor/marked.esm.js';");
    if (browserMarkdown === markdown) throw new Error('build/markdown.mjs: could not point the marked import at vendor/');
    await writeFile(path.join(out, 'js', 'markdown.js'), browserMarkdown);
    const markedDir = path.dirname(require.resolve('marked/package.json'));
    await mkdir(path.join(out, 'vendor'), { recursive: true });
    await cp(path.join(markedDir, 'lib', 'marked.esm.js'), path.join(out, 'vendor', 'marked.esm.js'));
    await cp(path.join(markedDir, 'LICENSE'), path.join(out, 'vendor', 'marked.LICENSE.txt'));
  }

  await mkdir(path.join(out, 'data'), { recursive: true });
  await writeFile(path.join(out, 'data', 'site.json'), JSON.stringify(result.site));
  for (const asset of result.assets) {
    const target = path.join(out, asset.to);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(asset.from, target, { dereference: true });
  }
  // Tell GitHub Pages not to run Jekyll on the output.
  await writeFile(path.join(out, '.nojekyll'), '');
  log.log(`Built ${count} meeting(s) into ${path.relative(process.cwd(), out) || out}.`);
  return { ok: true, ...result };
}

async function main() {
  const { values } = parseArgs({
    options: {
      content: { type: 'string', default: '.' },
      out: { type: 'string', default: '_site' },
      check: { type: 'boolean', default: false },
    },
  });
  const { ok } = await build({ contentDir: values.content, outDir: values.out, check: values.check });
  process.exitCode = ok ? 0 : 1;
}

// Run main() only when this file is executed directly (not imported).
// realpath on both sides, because macOS temp folders and CI work folders can be symlinks.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
