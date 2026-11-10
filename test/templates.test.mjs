// Tests for templates/course/, the starting point of new course repositories.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, CORE_SCHEMA } from 'js-yaml';
import { loadContent } from '../build/content.mjs';
import { build } from '../build/build.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'templates', 'course');
const quiet = { log() {}, warn() {}, error() {} };

async function filesIn(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesIn(full));
    else out.push(full);
  }
  return out;
}

test('templates: the course template builds, and its meeting template is valid once copied', async () => {
  const result = await loadContent(TEMPLATE);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.site.backend, null, 'sign-in starts switched off');

  // Switching sign-in on without replacing the placeholders fails the check.
  const raw = await readFile(path.join(TEMPLATE, 'course.yml'), 'utf8');
  const start = raw.indexOf('# backend:');
  const enabled = raw.slice(0, start) + raw.slice(start).replace(/^# /gm, '');
  const tmp = await mkdtemp(path.join(tmpdir(), 'meeting-engine-template-on-'));
  await cp(TEMPLATE, tmp, { recursive: true });
  await writeFile(path.join(tmp, 'course.yml'), enabled);
  const problems = (await loadContent(tmp)).errors.join('\n');
  for (const key of ['backend.url', 'publishable_key', 'backend.course_id', 'members[0]']) {
    assert.ok(problems.includes(key), `placeholder ${key} must be refused:\n${problems}`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'meeting-engine-template-'));
  await cp(TEMPLATE, dir, { recursive: true });
  const meeting = path.join(dir, 'meetings', '2026-01-31-first');
  await cp(path.join(dir, 'meetings', '_template'), meeting, { recursive: true });
  const copied = await loadContent(dir);
  assert.deepEqual(copied.errors, []);
  assert.equal(copied.site.meetings.length, 1);
  const out = path.join(dir, '_site');
  assert.equal((await build({ contentDir: dir, outDir: out, log: quiet })).ok, true);
});

test('templates: every engine version in the template is the current one', async () => {
  const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const found = [];
  for (const file of await filesIn(TEMPLATE)) {
    const text = await readFile(file, 'utf8');
    // Any version number at all (pins, doc links, comments).
    for (const m of text.matchAll(/\bv\d+\.\d+\.\d+\b/g)) {
      found.push({ file: path.relative(ROOT, file), version: m[0] });
    }
  }
  assert.ok(found.length >= 3, 'the template pins the engine');
  for (const f of found) {
    assert.equal(f.version, `v${version}`, `${f.file} pins ${f.version}; update it to v${version} (README: Releasing)`);
  }
});

test('templates: only the main-only deploy job can use the secret key', async () => {
  const text = await readFile(path.join(TEMPLATE, '.github', 'workflows', 'deploy.yml'), 'utf8');
  const workflow = load(text, { schema: CORE_SCHEMA });
  const { build: buildJob, deploy } = workflow.jobs;
  assert.ok(!JSON.stringify(buildJob).includes('secrets.'), 'the build job uses no secrets');
  assert.equal(deploy.environment.name, 'github-pages');
  assert.equal(deploy.permissions.actions, 'read', 'the sync checks the environment\'s branch rule');
  const sync = deploy.steps.find((s) => String(s.uses ?? '').includes('meeting-engine/sync@'));
  assert.ok(sync, 'the deploy job runs the sync');
  assert.equal(sync.with['supabase-secret-key'], '${{ secrets.SUPABASE_SECRET_KEY }}');
  assert.ok(deploy.steps.indexOf(sync) < deploy.steps.findIndex((s) => String(s.uses ?? '').startsWith('actions/deploy-pages')),
    'the team list is copied before the site is published');
});
