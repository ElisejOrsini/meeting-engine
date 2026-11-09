// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMarkdown } from '../build/markdown.mjs';
import { loadContent } from '../build/content.mjs';

async function fixture(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'meeting-engine-test-'));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return dir;
}

test('markdown: raw HTML is shown as text, not rendered', () => {
  const md = createMarkdown();
  const out = md.block('Hello <script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<script'), out);
  assert.ok(!out.includes('<img'), out);
  assert.ok(out.includes('&lt;script&gt;'), out);
});

test('markdown: dangerous link schemes are neutralised', () => {
  const md = createMarkdown();
  const bad = [
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', '<java\tscript:alert(1)>', 'data:text/html,x', 'vbscript:x',
    '&#106;avascript:alert(1)', '&#x6A;avascript:alert(1)', '&#106avascript:alert(1)',
    'javascript&colon;alert(1)', 'java&Tab;script:alert(1)', 'java&#9;script:alert(1)', '&jscr;avascript:x',
  ];
  for (const href of bad) {
    const out = md.block(`[click](${href}) ![img](${href})`);
    const hrefs = [...out.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(hrefs.every((h) => h === '#'), `${href} -> ${out}`);
  }
  const ok = md.block('[a](https://example.org) [b](mailto:x@example.org)');
  assert.ok(ok.includes('href="https://example.org"'));
  assert.ok(ok.includes('href="mailto:x@example.org"'));
});

test('markdown: relative links point into the meeting folder', () => {
  const md = createMarkdown({ assetBase: 'content/m1/' });
  assert.ok(md.block('[slides](./slides.pdf)').includes('href="content/m1/slides.pdf"'));
  assert.ok(md.block('[x](https://a.b/c)').includes('href="https://a.b/c"'));
});

test('content: the demo course is valid', async () => {
  const result = await loadContent('demo');
  assert.deepEqual(result.errors, []);
  assert.ok(result.site.meetings.length >= 2);
});

test('content: problems are reported with file names', async () => {
  const dir = await fixture({
    'course.yml': 'name: Test\ncolour: blue\n',
    'meetings/2026-01-05-a/meeting.yml': [
      'title: A',
      'date: 2026-01-06',
      'questions:',
      '  - id: q1',
      '    text: Q?',
      '    survey:',
      '      - { id: f, type: single, label: L, options: [only-one] }',
      'agenda:',
      '  - { title: T, question: nope }',
    ].join('\n'),
    'meetings/2026-01-05-a/decisions.yml': 'decisions:\n  - { id: d1, question: q2, decision: X }\n',
    'meetings/Bad Name/meeting.yml': 'title: B\ndate: 2026-01-01\n',
  });
  try {
    const { errors } = await loadContent(dir);
    const all = errors.join('\n');
    assert.match(all, /course\.yml: unknown key "colour"/);
    assert.match(all, /folder name starts with 2026-01-05 but "date" is 2026-01-06/);
    assert.match(all, /need at least 2 options/);
    assert.match(all, /agenda\[0\]\.question "nope"/);
    assert.match(all, /decisions\.yml: decisions\[0\]\.question "q2"/);
    assert.match(all, /Bad Name: meeting folder name must be/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('content: YAML dates and yes/no stay text', async () => {
  const dir = await fixture({
    'course.yml': 'name: no\n',
    'meetings/m/meeting.yml': 'title: yes\ndate: 2026-02-03\ntime: "09:30"\n',
  });
  try {
    const { site, errors } = await loadContent(dir);
    assert.deepEqual(errors, []);
    assert.equal(site.course.name, 'no');
    assert.equal(site.meetings[0].title, 'yes');
    assert.equal(site.meetings[0].date, '2026-02-03');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('content: impossible dates, fractional minutes and odd options are rejected', async () => {
  const dir = await fixture({
    'course.yml': 'name: T\n',
    'meetings/2026-02-30-x/meeting.yml': [
      'title: X',
      'date: 2026-02-30',
      'duration: 45.5',
      'agenda:',
      '  - { title: A, minutes: 7.5 }',
      'questions:',
      '  - id: q',
      '    text: Q?',
      '    survey:',
      '      - id: f',
      '        type: single',
      '        label: L',
      '        options:',
      '          - Recap: 10 minutes',
      '          -',
      '          - Fine',
    ].join('\n'),
  });
  try {
    const all = (await loadContent(dir)).errors.join('\n');
    assert.match(all, /not a real calendar date/);
    assert.match(all, /"duration" must be a whole number/);
    assert.match(all, /agenda\[0\]\.minutes" must be a whole number/);
    assert.match(all, /options\[0\] must be plain text/);
    assert.match(all, /options\[1\] must be plain text/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('content: empty or comment-only YAML files are fine', async () => {
  const dir = await fixture({
    'course.yml': 'name: T\n',
    'meetings/m/meeting.yml': 'title: M\ndate: 2026-03-03\n',
    'meetings/m/decisions.yml': '# Decisions are added after the meeting.\n',
  });
  try {
    const { errors, site } = await loadContent(dir);
    assert.deepEqual(errors, []);
    assert.deepEqual(site.meetings[0].decisions, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('content: links, file names and symlinks are checked', async () => {
  const dir = await fixture({
    'course.yml': 'name: T\n',
    'meetings/m/meeting.yml': 'title: M\ndate: 2026-03-03\n',
    'meetings/m/background.md': '[ok](slides.pdf) [missing](notes.docx) [site](www.example.org) [toc](#top) [route](#/decisions)',
    'meetings/m/slides.pdf': '%PDF-1.4',
    'meetings/m/Summary.md': 'x',
    'meetings/m/draft.docx': 'x',
    'secret.txt': 'secret',
  });
  try {
    const { symlink } = await import('node:fs/promises');
    await symlink(path.join(dir, 'secret.txt'), path.join(dir, 'meetings/m/leak.txt'));
    const { errors, warnings, site } = await loadContent(dir);
    const all = errors.join('\n');
    assert.match(all, /links to "notes\.docx"/);
    assert.match(all, /links to "www\.example\.org"/);
    assert.doesNotMatch(all, /slides\.pdf/);
    assert.match(all, /Summary\.md: rename to summary\.md/);
    assert.match(all, /leak\.txt: symbolic links are not allowed/);
    assert.match(warnings.join('\n'), /draft\.docx: is not published/);
    const bg = site.meetings[0].background_html;
    assert.ok(bg.includes('href="content/m/slides.pdf"'), bg);
    assert.ok(bg.includes('href="#/decisions"'), bg);
    assert.ok(!bg.includes('href="#top"'), bg); // in-page anchors become plain text
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('markdown: headings are shifted to fit the page outline', () => {
  const md = createMarkdown();
  assert.match(md.block('# Title', { headingOffset: 2 }), /^<h3>Title<\/h3>/);
  assert.match(md.block('##### Deep', { headingOffset: 3 }), /^<h6>Deep<\/h6>/);
});

test('build: refuses to overwrite folders it did not create, keeps $ in names', async () => {
  const { build } = await import('../build/build.mjs');
  const dir = await fixture({
    'content/course.yml': 'name: "Fees $` and $& 101"\n',
    'content/meetings/m/meeting.yml': 'title: M\ndate: 2026-03-03\n',
    'precious/file.txt': 'keep me',
  });
  const quiet = { log() {}, warn() {}, error() {} };
  try {
    const refused = await build({ contentDir: path.join(dir, 'content'), outDir: path.join(dir, 'precious'), log: quiet });
    assert.equal(refused.ok, false);
    const out = path.join(dir, 'out');
    assert.equal((await build({ contentDir: path.join(dir, 'content'), outDir: out, log: quiet })).ok, true);
    assert.equal((await build({ contentDir: path.join(dir, 'content'), outDir: out, log: quiet })).ok, true); // rebuild is fine
    const { readFile } = await import('node:fs/promises');
    const index = await readFile(path.join(out, 'index.html'), 'utf8');
    assert.equal(index.match(/<head>/g).length, 1);
    assert.ok(index.includes('<title>Fees $` and $&amp; 101</title>'), index);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('views: past meetings open on the Post-meeting tab', async () => {
  const { defaultTab } = await import('../src/js/views.js');
  const m = (date, extra = {}) => ({ date, summary_html: '', decisions: [], ...extra });
  assert.equal(defaultTab(m('2026-01-01'), '2026-01-02'), 'post');
  assert.equal(defaultTab(m('2026-01-02'), '2026-01-02'), 'during');
  assert.equal(defaultTab(m('2026-01-03'), '2026-01-02'), 'pre');
});

test('markdown: raw HTML after inline tags is still escaped', () => {
  const md = createMarkdown();
  for (const payload of [
    'See <code> <img src=x onerror=alert(1) ',
    'Note <code> <meta http-equiv=refresh content=1;url=/x',
    '<kbd> <iframe src=/data/site.json',
    '<pre>\n<script>alert(1)</script>',
  ]) {
    const out = md.block(payload);
    assert.ok(!/<(img|meta|iframe|script)/i.test(out), `${payload} -> ${out}`);
  }
  assert.ok(md.block('`<b>`').includes('<code>&lt;b&gt;</code>'));
});

test('markdown: external images become links', () => {
  const out = createMarkdown().block('![chart](https://example.org/p.png)');
  assert.ok(!out.includes('<img'), out);
  assert.ok(out.includes('<a href="https://example.org/p.png">chart</a>'), out);
});

test('content: values with newlines cannot start new log lines', async () => {
  const dir = await fixture({
    'course.yml': 'name: T\n',
    'meetings/m/meeting.yml': 'title: M\ndate: 2026-03-03\ntime: "x\\n::error::fake"\n',
  });
  try {
    const { errors } = await loadContent(dir);
    assert.ok(errors.length > 0);
    assert.ok(errors.every((e) => !/[\r\n]/.test(e)), errors.join('|'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
