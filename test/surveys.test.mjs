// Tests for the survey helpers in src/js/surveys.js and the meeting.yml
// "responses" settings. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { answersExpired, tally } from '../src/js/surveys.js';
import { loadContent } from '../build/content.mjs';

test('surveys: answers count as deleted from the 31st day after the meeting', () => {
  assert.equal(answersExpired('2026-10-01', '2026-10-31'), false);
  assert.equal(answersExpired('2026-10-01', '2026-11-01'), true);
  assert.equal(answersExpired('2026-12-15', '2027-01-14'), false, 'across the year end');
  assert.equal(answersExpired('2026-12-15', '2027-01-15'), true);
});

const QUESTION = {
  id: 'grace',
  survey: [
    { id: 'pick', type: 'single', label: 'Pick one', options: ['None', '1 hour', '24 hours'] },
    { id: 'also', type: 'multiple', label: 'Also', options: ['A', 'B'] },
    { id: 'why', type: 'text', label: 'Why?', options: [] },
  ],
};

test('surveys: the tally counts options, names people (or not) and lists texts', () => {
  const rows = [
    { answer: { pick: '1 hour', also: ['A', 'B'], why: '  uploads fail  ' }, github_login: 'me', mine: true },
    { answer: { pick: '1 hour', why: '   ' }, github_login: 'bob', mine: false },
    { answer: { pick: 'Two days', also: ['B'] }, github_login: null, mine: false },
  ];
  const t = tally(QUESTION, rows);
  assert.equal(t.count, 3);
  const [pick, also, why] = t.fields;
  assert.deepEqual(pick.counts.map((c) => [c.option, c.count, c.who, c.retired]), [
    ['None', 0, [], false],
    ['1 hour', 2, ['you', 'bob'], false],
    ['24 hours', 0, [], false],
    ['Two days', 1, [], true],
  ]);
  assert.equal(pick.answered, 3);
  assert.deepEqual(also.counts.map((c) => [c.option, c.count]), [['A', 1], ['B', 2]]);
  assert.equal(also.answered, 2);
  assert.deepEqual(why.texts, [{ text: 'uploads fail', who: 'you', mine: true }]);
  assert.deepEqual(tally(QUESTION, []).fields[0].counts.map((c) => c.count), [0, 0, 0]);
});

test('surveys: meeting.yml responses.anonymous must be true or false', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'meeting-engine-surveys-'));
  const write = async (name, text) => {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  };
  await write('course.yml', 'name: T\n');
  await write('meetings/2026-01-05-a/meeting.yml', 'title: A\ndate: 2026-01-05\nresponses:\n  anonymous: true\n');
  await write('meetings/2026-01-06-b/meeting.yml', 'title: B\ndate: 2026-01-06\nresponses:\n  anonymous: yes\n');
  await write('meetings/2026-01-07-c/meeting.yml', 'title: C\ndate: 2026-01-07\n');
  const { site, errors } = await loadContent(dir);
  assert.deepEqual(errors.map((e) => e.replace(/^.*meeting\.yml: /, '')), ['"responses.anonymous" must be true or false (got "yes")']);
  const byId = Object.fromEntries(site.meetings.map((m) => [m.id, m.anonymous]));
  assert.deepEqual(byId, { '2026-01-05-a': true, '2026-01-06-b': false, '2026-01-07-c': false });
});
