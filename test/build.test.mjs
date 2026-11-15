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

test('build: refuses an output path that is an existing file', async () => {
  const { build } = await import('../build/build.mjs');
  const dir = await fixture({
    'content/course.yml': 'name: T\n',
    'content/meetings/m/meeting.yml': 'title: M\ndate: 2026-03-03\n',
    'notes.txt': 'keep me',
  });
  try {
    const result = await build({ contentDir: path.join(dir, 'content'), outDir: path.join(dir, 'notes.txt'), log: { log() {}, warn() {}, error() {} } });
    assert.equal(result.ok, false);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(path.join(dir, 'notes.txt'), 'utf8'), 'keep me');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('content: reveal mode defaults to anytime', async () => {
  const dir = await fixture({
    'course.yml': 'name: T\n',
    'meetings/a/meeting.yml': 'title: A\ndate: 2026-03-03\n',
    'meetings/b/meeting.yml': 'title: B\ndate: 2026-03-04\nresponses:\n  reveal: after_answering\n',
  });
  try {
    const { site, errors } = await loadContent(dir);
    assert.deepEqual(errors, []);
    const byId = Object.fromEntries(site.meetings.map((m) => [m.id, m.reveal]));
    assert.deepEqual(byId, { a: 'anytime', b: 'after_answering' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('views: the In-meeting tab works on its own (no links to Pre-meeting) and counts down to the AI summary', async () => {
  const { meetingView, summaryState, countdownText } = await import('../src/js/views.js');
  const start = Date.parse('2026-11-17T13:00:00Z');
  const meeting = {
    id: 'm', title: 'M', date: '2026-11-17', time: '14:00', duration: 60, starts_at: '2026-11-17T13:00:00Z',
    questions: [
      { id: 'a', text: 'Should we allow a grace period?', details_html: '<p>Context</p>', survey: [{ id: 'p', type: 'single', label: 'Which?', options: ['x', 'y'] }] },
      { id: 'b', text: 'Rooms?', details_html: '', survey: [] },
    ],
    agenda: [{ title: 'Grace', minutes: 20, question: 'a', notes_html: '' }, { title: 'Wrap-up', minutes: 5 }],
    decisions: [], summaries: {}, guide_html: '', intro_html: '',
  };
  assert.equal(summaryState(meeting, start - 3 * 3600_000), 'waiting');
  assert.equal(summaryState(meeting, start - 10 * 60_000), 'writing');
  assert.equal(summaryState(meeting, start + 2 * 3600_000), 'none', 'nothing to wait for after the meeting');
  assert.equal(summaryState({ ...meeting, starts_at: undefined }, start), 'none', 'no countdown without a time');
  assert.equal(countdownText(start, start - (26 * 3600 + 60) * 1000), 'in 1 d 2 h');
  assert.equal(countdownText(start, start - 754_000), 'in 12:34');

  const waiting = String(meetingView(meeting, 'during').body);
  assert.doesNotMatch(waiting.split('tab-panel')[1], /\/pre|href=/, 'no links out of the tab (back to Pre-meeting)');
  assert.match(waiting, /data-countdown="\d+"/);
  assert.match(waiting, /data-goto="a"[^>]*>Q1</);
  assert.match(waiting, /14:00–14:20/);

  const done = { ...meeting, summaries: { a: { short: 'Grace period?', consensus_html: '<p>Most want 1 hour.</p>', key_points: [], contested: true, disagreement_html: '<p>15 min vs 1 h</p>' } } };
  assert.equal(summaryState(done, start - 10 * 60_000), 'done');
  const shown = String(meetingView(done, 'during').body);
  assert.doesNotMatch(shown, /data-countdown=/);
  assert.match(shown, /Grace period\?<\/h3>/);
  assert.match(shown, /Most want 1 hour/);
  assert.match(shown, /Where people disagree/);
  assert.match(shown, /Should we allow a grace period\?/, 'the full question is still there, folded');
});

test('content: course.yml "semester" sets teaching week 1', async () => {
  const dir = await fixture({
    'course.yml': 'name: T\nsemester:\n  start: 2026-09-14\n',
  });
  const bad = await fixture({
    'course.yml': 'name: T\nsemester:\n  start: 2026-09-31\n  weeks: 0\n',
  });
  try {
    const ok = await loadContent(dir);
    assert.deepEqual(ok.site.course.semester, { start: '2026-09-14', weeks: 14 });
    const wrong = await loadContent(bad);
    const all = wrong.errors.map((e) => e.message ?? String(e)).join('\n');
    assert.match(all, /semester\.start" is not a real calendar date/);
    assert.match(all, /semester\.weeks" must be a whole number/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(bad, { recursive: true, force: true });
  }
});

test('timeline: one line with week headers, today in the middle, quiet empty weeks', async () => {
  const { timelineView, teachingWeek, relativeWeek, relativeDay, rangeLabel } = await import('../src/js/timeline.js');
  const semester = { start: '2026-09-14', weeks: 14 };
  assert.equal(teachingWeek(semester, '2026-09-14'), 1);
  assert.equal(teachingWeek(semester, '2026-11-22'), 10);
  assert.equal(teachingWeek(semester, '2026-12-21'), null, 'after the last teaching week');
  assert.equal(teachingWeek(null, '2026-11-22'), null);
  assert.equal(relativeWeek('2026-11-16', '2026-11-14'), 'Next week');
  assert.equal(relativeWeek('2026-10-26', '2026-11-14'), '2 weeks ago');
  assert.equal(relativeDay('2026-11-17', '2026-11-14'), 'in 3 days');
  assert.equal(relativeDay('2026-12-15', '2026-11-14'), '');
  assert.equal(rangeLabel('2026-11-16', '2026-11-22'), '16–22 Nov');
  assert.equal(rangeLabel('2026-11-30', '2026-12-06'), '30 Nov – 6 Dec');

  const meeting = (id, date, extra = {}) => ({
    id, title: `Meeting ${id}`, date, time: '14:00', duration: 60, questions: [], decisions: [], summary_html: '', ...extra,
  });
  const site = {
    course: { name: 'T', semester },
    meetings: [
      meeting('kickoff', '2026-09-15', { summary_html: '<p>Roles.</p>', decisions: [{ decision_html: '<p>Rotate sheets.</p>' }] }),
      meeting('late', '2026-11-17', { questions: [{ id: 'q' }, { id: 'r' }] }),
      meeting('retro', '2026-12-15', { draft: true }),
      meeting('someday', '', { time: undefined }),
    ],
  };
  const body = String(timelineView(site, { today: '2026-11-14' }).body);
  // Months in order, oldest at the top (October is inside the merged quiet weeks).
  const months = [...body.matchAll(/class="tl-month[^"]*">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(months, ['September', 'November', 'December']);
  assert.match(body, /Week 10<\/span>[\s\S]*?16–22 Nov <span class="tl-relweek">· Next week/);
  assert.match(body, /id="tl-today"/);
  assert.match(body, /Weeks 2–8<\/span>[\s\S]*?21 Sept? – 8 Nov <span class="tl-relweek">· nothing on/, 'empty past weeks merge into one line');
  assert.match(body, /nothing planned yet/, 'empty future weeks too');
  // This week and the next two: every day; Wed 25 Nov has nothing but still shows.
  assert.match(body, /tl-dayrow[^>]*>\s*<span class="tl-date">Wed 25</);
  assert.doesNotMatch(body, /tl-dayrow[^>]*>\s*<span class="tl-date">Wed 9</, 'far from today only days with something on');
  // Items and their sheets.
  assert.match(body, /data-open="late"[\s\S]*?in 3 days[\s\S]*?14:00–15:00 · 2 questions/);
  assert.match(body, /is-done" data-open="kickoff"[\s\S]*?1 decision/);
  assert.match(body, /Meeting · Draft/);
  assert.match(body, /data-sheet="kickoff"[\s\S]*?Rotate sheets[\s\S]*?href="#\/m\/kickoff">Open meeting/);
  assert.match(body, /No time set yet: <a href="#\/m\/someday">/);
  assert.doesNotMatch(body, /style=/, 'no inline styles (the security policy forbids them)');
});

test('calendar: the .ics file and the Outlook invite carry the meeting in UTC', async () => {
  const { icsFor, outlookInviteUrl, zurichToDate, meetingTimes } = await import('../src/js/calendar.js');
  assert.equal(zurichToDate('2026-11-24', '14:00').toISOString(), '2026-11-24T13:00:00.000Z', 'winter: UTC+1');
  assert.equal(zurichToDate('2026-06-02', '14:00').toISOString(), '2026-06-02T12:00:00.000Z', 'summer: UTC+2');
  assert.equal(zurichToDate('2026-10-25', '02:30').toISOString().slice(0, 13), '2026-10-25T01', 'the clock-change night');
  const meeting = { id: 'late', title: 'Late submissions; rules, again', date: '2026-11-24', time: '14:00', duration: 90,
    location: 'HG E 33, and Zoom' };
  assert.equal(meetingTimes(meeting).end.toISOString(), '2026-11-24T14:30:00.000Z');
  assert.equal(meetingTimes({ ...meeting, starts_at: '2026-11-24T15:00:00Z' }).start.toISOString(), '2026-11-24T15:00:00.000Z',
    'private courses: starts_at wins');
  assert.equal(meetingTimes({ id: 'x', title: 'X', date: '' }), null);
  const ics = icsFor(meeting, { url: 'https://example.org/#/m/late', courseId: 'aip', now: new Date('2026-11-14T10:00:00Z') });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nDTSTART:20261124T130000Z\r\nDTEND:20261124T143000Z\r\n/);
  assert.ok(ics.includes('\r\nSUMMARY:Late submissions\\; rules\\, again\r\n'), ics);
  assert.match(ics, /\r\nLOCATION:HG E 33\\, and Zoom\r\n/);
  assert.match(ics, /\r\nUID:aip-late@meeting-engine\r\n/);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, `folded: ${line}`);
  const long = icsFor({ ...meeting, title: 'Ü'.repeat(80) });
  assert.ok(long.includes('\r\n '), 'long lines are folded');
  const url = new URL(outlookInviteUrl(meeting, { url: 'https://example.org/#/m/late' }));
  assert.equal(url.origin, 'https://outlook.office.com');
  assert.equal(url.searchParams.get('startdt'), '2026-11-24T13:00:00Z');
  assert.equal(url.searchParams.get('enddt'), '2026-11-24T14:30:00Z');
  assert.equal(url.searchParams.get('subject'), meeting.title);
  assert.match(url.searchParams.get('body'), /https:\/\/example\.org\/#\/m\/late/);
});

test('timeline: a meeting still finding a time sits on its first day with its days shaded', async () => {
  const { timelineView, daysBetweenDates, daysLabel } = await import('../src/js/timeline.js');
  const { layoutGrid, spanText } = await import('../src/js/schedule.js');
  assert.deepEqual(daysBetweenDates('2026-11-20', '2026-11-24'), ['2026-11-20', '2026-11-23', '2026-11-24'], 'weekdays only');
  assert.equal(daysBetweenDates('2026-11-20', '2026-11-24', { weekends: true }).length, 5);
  assert.equal(daysLabel('2026-11-23', '2026-11-27'), 'Mon 23 – Fri 27 Nov');

  const base = { questions: [], decisions: [], summary_html: '' };
  const site = {
    private: true,
    course: { id: 'c', name: 'T', semester: { start: '2026-09-14', weeks: 14 } },
    me: { login: 'alice', organizer: true },
    members: [{ login: 'alice' }, { login: 'bob' }, { login: 'carol' }],
    meetings: [
      { ...base, id: 'prep', title: 'Exam prep', date: '', schedule: {
        days: ['2026-11-23', '2026-11-24', '2026-11-26'], from: '09:00', to: '18:00', slot_min: 30, duration_min: 60,
        filled_in: 2, mine: false } },
      { ...base, id: 'far', title: 'Far away', date: '', schedule: {
        days: ['2027-01-11', '2027-01-12'], from: '09:00', to: '18:00', slot_min: 30, duration_min: 60, filled_in: 0, mine: true } },
    ],
  };
  const body = String(timelineView(site, { today: '2026-11-14' }).body);
  assert.match(body, /data-open="prep"[\s\S]*?Planned meeting[\s\S]*?Mon 23 – Thu 26 Nov · 2 of 3 answered[\s\S]*?Add your times/);
  assert.match(body, /<div class="tl-span">[\s\S]*?data-open="prep"[\s\S]*?Tue 24[\s\S]*?Wed 25[\s\S]*?Thu 26[\s\S]*?<\/div>\s*<div class="tl-dayrow[^"]*"[^>]*>\s*<span class="tl-date">Fri 27/,
    'the band covers Mon 23 – Thu 26, then ends');
  assert.match(body, /tl-dayrow[^"]*is-offered[^>]*>\s*<span class="tl-date">Tue 24/, 'offered days are marked');
  assert.doesNotMatch(body, /tl-dayrow[^"]*is-offered[^>]*>\s*<span class="tl-date">Wed 25/, 'Wednesday isn’t offered');
  assert.match(body, /class="tl-span"><span class="tl-span-end">until Tue 12<\/span>[\s\S]*?Change your times/, 'far away: just its row');
  assert.match(body, /January 2027/);
  assert.match(body, /data-sheet="prep" data-schedule="prep"/);
  assert.match(body, /data-open="__add"/, 'organizers see + Add');
  assert.doesNotMatch(body, /No time set yet/, 'planned meetings aren’t listed as without a time');
  assert.doesNotMatch(String(timelineView({ ...site, me: { login: 'bob', organizer: false } }, { today: '2026-11-14' }).body), /data-open="__add"/);
  assert.doesNotMatch(body, /style=/, 'no inline styles');

  // The grid: days across, times down, in Zurich time (also across a clock change).
  const grid = layoutGrid(['2026-10-24T07:00:00Z', '2026-10-24T07:30:00Z', '2026-10-26T08:00:00Z', '2026-10-26T08:30:00Z']);
  assert.deepEqual(grid.days, ['2026-10-24', '2026-10-26']);
  assert.deepEqual(grid.times, ['09:00', '09:30']);
  assert.equal(grid.at(1, 0), Date.parse('2026-10-26T08:00:00Z'), '09:00 in winter time is 08:00 UTC');
  assert.equal(spanText(Date.parse('2026-11-24T13:00:00Z'), Date.parse('2026-11-24T14:00:00Z')), 'Tue 24 Nov, 14:00–15:00');
});

test('timeline: review fixes (length field, month headings outside the band)', async () => {
  const { timelineView } = await import('../src/js/timeline.js');
  const base = { questions: [], decisions: [], summary_html: '' };
  const site = {
    private: true,
    course: { id: 'c', name: 'T' },
    me: { login: 'alice', organizer: true },
    members: [{ login: 'alice' }],
    meetings: [{ ...base, id: 'cross', title: 'Across months', date: '', schedule: {
      days: ['2026-11-30', '2026-12-01', '2026-12-02'], from: '09:00', to: '18:00', slot_min: 30, duration_min: 60, filled_in: 0, mine: false } }],
  };
  const body = String(timelineView(site, { today: '2026-11-20' }).body);
  // form.elements.length is the number of fields, so the select must not be called "length".
  assert.match(body, /<select id="add-length" name="duration"/);
  assert.doesNotMatch(body, /name="length"/);
  // The band is closed right before the December heading and opened again after it.
  const at = body.indexOf('>December</h2>');
  assert.match(body.slice(0, at), /<div class="tl-span">[\s\S]*<\/div><h2 class="tl-month[^>]*$/);
  assert.match(body.slice(at), /^>December<\/h2><div class="tl-span">/);

  // A planned meeting running past the day-by-day weeks continues in a short row.
  const later = String(timelineView({ ...site, meetings: [{ ...site.meetings[0], schedule: {
    ...site.meetings[0].schedule, days: ['2026-11-26', '2026-12-04'] } }] }, { today: '2026-11-14' }).body);
  assert.match(later, /30 Nov – 6 Dec[\s\S]*?is-continued[\s\S]*?until Fri 4[\s\S]*?Across months: still finding a time/);
});

test('views: a meeting still finding a time asks for your availability and links to its grid', async () => {
  const { meetingsView, meetingView } = await import('../src/js/views.js');
  const meeting = {
    id: 'prep', title: 'Exam prep', date: '2026-12-31', questions: [], decisions: [], summary_html: '', agenda: [],
    schedule: { days: ['2026-11-23', '2026-11-27'], filled_in: 3, mine: false },
  };
  const site = { course: { name: 'T', links: [] }, members: [{}, {}, {}, {}, {}], meetings: [meeting] };
  const list = String(meetingsView(site, '2026-11-15').body);
  assert.match(list, /Time not set yet · finding a time, Mon 23 – Fri 27 Nov/, 'not its placeholder date');
  assert.match(list, /<li class="has-action">\s*<a class="row-link" href="#\/m\/prep">[\s\S]*?<\/a>\s*<span class="row-action">\s*<a class="button button-small" href="#\/timeline\?open=prep">Add your availability[\s\S]*?3 of 5 answered[\s\S]*?<\/li>/,
    'the button sits inside the meeting’s own row');
  assert.ok(list.indexOf('Upcoming meetings') < list.indexOf('Exam prep') && list.indexOf('Exam prep') < list.indexOf('Past meetings'));
  const page = String(meetingView(meeting, 'pre', '2026-11-15', { members: 5 }).body);
  assert.match(page, /finding a time for this meeting[\s\S]*?Mon 23 – Fri 27 Nov\. 3 of 5 have answered[\s\S]*?href="#\/timeline\?open=prep">Add your availability/);
  const mine = String(meetingsView({ ...site, meetings: [{ ...meeting, schedule: { ...meeting.schedule, mine: true } }] }, '2026-11-15').body);
  assert.match(mine, /Change your availability/);
});

test('timeline: tasks, check-ins and suggested tasks (rows, sheets, who)', async () => {
  const { timelineView } = await import('../src/js/timeline.js');
  const { whoText, plainText } = await import('../src/js/items.js');
  const site = {
    private: true,
    course: { id: 'c', name: 'T' },
    me: { login: 'alice', organizer: true },
    members: [{ login: 'alice', name: 'Alice' }, { login: 'bob', name: 'Bob' }],
    meetings: [],
    items: [
      { id: 't1', kind: 'task', title: 'Upload sheet 9', due: '2026-11-19', details_html: '', everyone: false, people: ['bob', 'alice'],
        published: true, for_me: true, expected: 0, written: 0 },
      { id: 'c1', kind: 'checkin', title: 'Project status', due: '2026-11-20', details_html: '<p>How is it going?</p>', everyone: true,
        people: [], published: true, for_me: true, expected: 2, written: 1, mine: false },
      { id: 'd1', kind: 'task', title: 'Book a room', due: '2026-11-25', details_html: '', everyone: true, people: [], published: false },
    ],
    suggestions: [
      { meeting: 'm1', meeting_title: 'Retro', key: 'aaaaaaaaaaaaaaaa', what_md: 'Upload to [Moodle](https://moodle.example/x)', owner: 'bob', due: '2026-11-18', people: ['bob'] },
      { meeting: 'm2', meeting_title: 'Other', key: 'aaaaaaaaaaaaaaaa', what_md: 'Same step', owner: '', due: '2026-11-18', people: [] },
    ],
  };
  assert.equal(whoText(site, site.items[0]), 'You and Bob');
  assert.equal(whoText(site, { everyone: false, people: [] }), 'Nobody (they left the team)');
  assert.equal(plainText('Upload to [Moodle](https://x) **now**'), 'Upload to Moodle now');
  const body = String(timelineView(site, { today: '2026-11-15' }).body);
  assert.match(body, /data-open="item-t1"[\s\S]*?Task<\/span>[\s\S]*?Upload sheet 9[\s\S]*?You and Bob/);
  assert.match(body, /data-open="item-c1"[\s\S]*?Written check-in[\s\S]*?Everyone · 1 of 2 written[\s\S]*?Write your update/);
  assert.match(body, /Task · Draft[\s\S]*?Book a room/);
  assert.match(body, /data-sheet="item-c1" data-item="c1" data-checkin="c1"/);
  // Suggested tasks: plain text in the row (no links inside the button), unique field ids.
  const row = body.slice(body.indexOf('data-open="suggest-m1-'), body.indexOf('</button>', body.indexOf('data-open="suggest-m1-')));
  assert.doesNotMatch(row, /<a /);
  assert.match(row, /Upload to Moodle/);
  assert.match(body, /id="s-m1-aaaaaaaaaaaaaaaa-title"/);
  assert.match(body, /id="s-m2-aaaaaaaaaaaaaaaa-title"/);
  assert.match(body, /<legend>Who<\/legend>[\s\S]*?id="add-task-everyone"/);
  assert.doesNotMatch(String(timelineView({ ...site, me: { login: 'bob', organizer: false } }, { today: '2026-11-15' }).body), /Suggested task/,
    'suggestions are for organizers');
  assert.doesNotMatch(body, /style=/);
});
