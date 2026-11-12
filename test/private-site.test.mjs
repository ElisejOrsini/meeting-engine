// Private courses end to end, without a browser: import the demo content
// through the agent API into the real database setup (local backend), load it
// the way the site does (get_course), and turn it into what the views draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalBackend } from '../scripts/local-backend.mjs';
import { meetingParts, zurichIso } from '../scripts/import.mjs';
import { toSite, zurichDateTime } from '../src/js/private.js';
import { createMarkdown } from '../build/markdown.mjs';
import { loadContent } from '../build/content.mjs';
import { build } from '../build/build.mjs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SITE = 'http://localhost:9999/';

test('import: Zurich times, in winter and summer', () => {
  assert.equal(zurichIso('2026-11-10', '16:15'), '2026-11-10T16:15:00+01:00');
  assert.equal(zurichIso('2026-07-01', '09:00'), '2026-07-01T09:00:00+02:00');
  assert.equal(zurichIso('2026-03-29', '03:30'), '2026-03-29T03:30:00+02:00'); // just after the switch
  assert.deepEqual(zurichDateTime('2026-11-24T23:30:00Z'), { date: '2026-11-25', time: '00:30' });
  assert.deepEqual(zurichDateTime(null), { date: '', time: undefined });
});

test('import: a meeting folder becomes the documented parts', async () => {
  const parts = await meetingParts('demo/meetings/2026-11-17-late-submissions');
  assert.equal(parts.details.title, 'Late submission policy');
  assert.match(parts.details.starts_at, /^2026-11-17T\d{2}:\d{2}:00\+01:00$/);
  assert.ok(parts.pre.background_md.length > 0);
  assert.ok(parts.pre.questions.every((q) => q.id && q.text));
  assert.ok(parts.in.items.length > 0);
  assert.ok(parts.in.guide_md.length > 0);
  assert.deepEqual(parts.post, {}, 'nothing after the meeting yet');
});

test('private site: the demo, imported through the agent API, loads for the team only', async () => {
  const lines = [];
  const backend = await createLocalBackend({
    courseId: 'widgetry', courseName: 'Widgetry', siteUrl: SITE, importFrom: 'demo', log: (l) => lines.push(l),
  });
  assert.equal(lines.length, 2, lines.join('\n'));

  const asOrganizer = await backend.rpc('get_course', { p_course: 'widgetry' }, { githubId: 1001 });
  assert.equal(asOrganizer.status, 200);
  const data = asOrganizer.body;
  assert.equal(data.me.organizer, true);
  assert.equal(data.meetings.length, 2);
  assert.ok(data.agent_keys.length === 1 && data.agent_keys[0].label === 'Import (preview)');
  assert.equal(data.meetings[0].pre.saved_by, 'agent:Import (preview)');

  // Same answers as the file-built demo, from the database.
  const site = toSite(data, { createMarkdown, engine: { version: 'test' }, backend: { course_id: 'widgetry' } });
  const files = (await loadContent('demo')).site;
  for (const fileMeeting of files.meetings) {
    const m = site.meetings.find((x) => x.id === fileMeeting.id);
    assert.ok(m, fileMeeting.id);
    assert.equal(m.title, fileMeeting.title);
    assert.equal(m.date, fileMeeting.date);
    assert.equal(m.time, fileMeeting.time);
    assert.equal(m.background_html, fileMeeting.background_html.replaceAll('content/' + m.id + '/', ''));
    assert.deepEqual(m.questions.map((q) => [q.id, q.text, q.survey]), fileMeeting.questions.map((q) => [q.id, q.text, q.survey]));
    assert.deepEqual(m.decisions.map((d) => [d.id, d.question]), fileMeeting.decisions.map((d) => [d.id, d.question]));
    assert.equal(m.summary_html, fileMeeting.summary_html);
    assert.equal(m.agenda.length, fileMeeting.agenda.length);
    assert.equal(m.draft, false);
  }

  // The teammate sees the same meetings, but no keys; strangers and visitors nothing.
  const asMember = await backend.rpc('get_course', { p_course: 'widgetry' }, { githubId: 1002 });
  assert.equal(asMember.body.meetings.length, 2);
  assert.equal(asMember.body.agent_keys, null);
  const asStranger = await backend.rpc('get_course', { p_course: 'widgetry' }, { githubId: 4001 });
  assert.equal(asStranger.status, 403);
  assert.doesNotMatch(JSON.stringify(asStranger.body), /Late submission/);
  const signedOut = await backend.rpc('get_course', { p_course: 'widgetry' });
  assert.equal(signedOut.status, 401);
  const wrongKey = await backend.rpc('agent_get_course', {}, { agentKey: 'me_agent_' + 'a'.repeat(64) });
  assert.equal(wrongKey.status, 401);
  const unknownFn = await backend.rpc('nope', {});
  assert.equal(unknownFn.status, 404);
});

test('private site: Markdown from the database is rendered with the safety rules', () => {
  const site = toSite({
    course: { id: 'c', name: 'C', description_md: 'Hi <script>alert(1)</script>' },
    notes: { version: 1, content: { notes_md: '[x](javascript:alert(1)) ![t](https://tracker.example/p.png)' } },
    meetings: [{
      id: 'm', published: false,
      details: { version: 1, content: { title: 'M', location_md: 'Room [Zoom](https://example.org/z)' } },
      pre: { version: 1, content: { questions: [{ id: 'q', text: 'Q?', details_md: '<img src=x onerror=alert(1)>' }] } },
      in: { version: 0, content: null },
      post: { version: 1, content: {
        next_steps: [{ what_md: 'Do **it**', owner: 'alice', due: '2026-12-01' }],
        open: [{ question: 'q', text_md: 'Still unclear' }],
      } },
    }],
  }, { createMarkdown, engine: {}, backend: {} });
  assert.match(site.course.description_html, /&lt;script&gt;/);
  assert.doesNotMatch(site.course.notes_html, /javascript:|<img/);
  const m = site.meetings[0];
  assert.equal(m.draft, true);
  assert.equal(m.date, '');
  assert.match(m.location_html, /<a href="https:\/\/example.org\/z">Zoom<\/a>/);
  assert.match(m.questions[0].details_html, /&lt;img/);
  assert.match(m.next_steps[0].what_html, /<strong>it<\/strong>/);
  assert.equal(m.open_items[0].question, 'q');
});

test('build: a private course publishes an empty shell, and refuses meeting content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'me-private-'));
  try {
    await writeFile(path.join(dir, 'course.yml'), await readFile('demo-private/course.yml', 'utf8'));
    const out = path.join(dir, '_site');
    const result = await build({ contentDir: dir, outDir: out, log: { log() {}, warn() {}, error() {} } });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const siteJson = JSON.parse(await readFile(path.join(out, 'data', 'site.json'), 'utf8'));
    assert.deepEqual(siteJson.meetings, []);
    assert.equal(siteJson.private, true);
    assert.match(await readFile(path.join(out, 'js', 'markdown.js'), 'utf8'), /from '\.\.\/vendor\/marked\.esm\.js'/);
    assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /connect-src 'self' https:\/\/a{20}\.supabase\.co https:\/\/api\.github\.com/);

    await mkdir(path.join(dir, 'meetings', '2026-01-01-x'), { recursive: true });
    const refused = await build({ contentDir: dir, outDir: out, check: true, log: { log() {}, warn() {}, error() {} } });
    assert.equal(refused.ok, false);
    assert.match(refused.errors.join('\n'), /keeps its meetings in the database/);

    await rm(path.join(dir, 'meetings'), { recursive: true });
    await writeFile(path.join(dir, 'course.yml'), `${await readFile('demo-private/course.yml', 'utf8')}members:\n  - someone\n`);
    const withMembers = await build({ contentDir: dir, outDir: out, check: true, log: { log() {}, warn() {}, error() {} } });
    assert.match(withMembers.errors.join('\n'), /Team page/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('build: course.yml "home" adds a link back to another site in the header', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'me-home-'));
  const quiet = { log() {}, warn() {}, error() {} };
  try {
    const base = await readFile('demo-private/course.yml', 'utf8');
    await writeFile(path.join(dir, 'course.yml'), `${base}home:\n  title: Public site\n  url: ../\n`);
    const out = path.join(dir, '_site');
    assert.equal((await build({ contentDir: dir, outDir: out, log: quiet })).ok, true);
    assert.match(await readFile(path.join(out, 'index.html'), 'utf8'), /<a href="\.\.\/" class="home-link"><span aria-hidden="true">‹ <\/span>Public site<\/a>/);
    for (const url of ['javascript:alert(1)', 'http://example.org', '"><script>']) {
      await writeFile(path.join(dir, 'course.yml'), `${base}home:\n  title: X\n  url: '${url}'\n`);
      const r = await build({ contentDir: dir, outDir: out, check: true, log: quiet });
      assert.equal(r.ok, false, url);
    }
    // Without "home", no link (and no leftover placeholder).
    await writeFile(path.join(dir, 'course.yml'), base);
    await build({ contentDir: dir, outDir: out, log: quiet });
    const index = await readFile(path.join(out, 'index.html'), 'utf8');
    assert.doesNotMatch(index, /home-link|\{\{/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
