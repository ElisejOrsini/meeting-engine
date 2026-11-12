// Database tests for part 3: courses managed on the site (private content,
// organizers, drafts, versions, agent keys). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, actor, ALICE, BOB, EMAIL_ONLY, TWO_ACCOUNTS, REPO } from './db-setup.mjs';

const CAROL = '00000000-0000-0000-0000-000000000005'; // GitHub 3001, on no team list
const SITE = 'https://example-org.github.io/meetings/';

const PRE = {
  background_md: 'Why we meet.',
  responses: { reveal: 'anytime' },
  questions: [
    { id: 'grace', text: 'Grace period?', needs_meeting: true, details_md: 'Details.',
      survey: [
        { id: 'pick', type: 'single', label: 'Which?', options: ['None', '1 hour'], required: true },
        { id: 'why', type: 'text', label: 'Why?' },
      ] },
    { id: 'rooms', text: 'Which rooms?' },
  ],
};

/** A database with course "widgetry" (organizer alice, member bob) and a legacy course "legacy". */
async function course() {
  const db = await setup();
  const as = actor(db);
  await db.exec('set role owner;');
  await db.query(`select private.create_course('widgetry', 'Applied Widgetry', 'alice', 1001, $1)`, [SITE]);
  await db.query(`select private.create_course('other', 'Other', 'carol', 3001, $1)`, [SITE]);
  await db.exec('reset role;');
  await db.exec(`insert into auth.identities values ('${CAROL}', 'github', '3001')`);
  const alice = (sql, params = []) => as('authenticated', sql, params, ALICE);
  const bob = (sql, params = []) => as('authenticated', sql, params, BOB);
  await alice(`select public.add_member('widgetry', 1002, 'bob', 'Bob', false)`);
  const json = async (who, sql, params = []) => Object.values((await who(sql, params))[0])[0];
  return { db, as, alice, bob, json };
}

const code = (c) => (err) => {
  assert.equal(err.code, c, `expected SQLSTATE ${c}, got ${err.code}: ${err.message}`);
  return true;
};

test('private: strangers read nothing (signed out, other GitHub accounts, no or wrong agent key)', async () => {
  const { db, as, alice, json } = await course();
  await json(alice, `select public.create_meeting('widgetry', 'kickoff', '{"title": "Kickoff"}')`);
  await json(alice, `select public.save_part('widgetry', 'kickoff', 'pre', $1, 0)`, [JSON.stringify(PRE)]);
  await alice(`select public.set_published('widgetry', 'kickoff', true)`);

  // Signed out (publishable key only): the website's functions are closed.
  for (const sql of [
    `select public.get_course('widgetry')`,
    `select public.get_versions('widgetry', 'kickoff', 'pre')`,
    `select public.save_part('widgetry', 'kickoff', 'pre', '{}', 1)`,
    `select public.add_member('widgetry', 9, 'eve')`,
    `select public.create_agent_key('widgetry', 'x', 'write')`,
    `select * from private.revisions`,
    `select * from private.agent_keys`,
    `select private.create_course('x', 'X', 'eve', 9, '${SITE}')`,
  ]) {
    await assert.rejects(as('anon', sql), /permission denied/, sql);
  }
  // Signed in, but not on this team (or not with a GitHub identity).
  for (const uid of [CAROL, EMAIL_ONLY, '']) {
    for (const sql of [
      `select public.get_course('widgetry')`,
      `select public.get_versions('widgetry', 'kickoff', 'pre')`,
      `select public.get_version('widgetry', 'kickoff', 'pre', 1)`,
      `select public.save_part('widgetry', 'kickoff', 'pre', '{}', 1)`,
      `select public.create_meeting('widgetry', 'x', '{"title": "X"}')`,
      `select public.set_published('widgetry', 'kickoff', false)`,
      `select public.add_member('widgetry', 3001, 'carol')`,
      `select public.create_agent_key('widgetry', 'x', 'write')`,
      `select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "None"}')`,
    ]) {
      await assert.rejects(as('authenticated', sql, [], uid), /not on this course's team list|permission denied/, `${uid}: ${sql}`);
    }
    assert.equal((await as('authenticated', `select count(*)::int as n from public.get_answers('widgetry', 'kickoff', true)`, [], uid)
      .catch(() => [{ n: 0 }]))[0].n, 0);
    for (const sql of ['select * from private.revisions', 'select * from private.agent_keys', 'select * from private.members']) {
      await assert.rejects(as('authenticated', sql, [], uid), /permission denied/, sql);
    }
  }
  // Agent functions without a key, with a made-up key, or signed in instead.
  for (const headers of [null, { 'x-agent-key': 'me_agent_' + '0'.repeat(64) }, { 'x-agent-key': 'nonsense' }]) {
    await assert.rejects(as('anon', 'select public.agent_get_course()', [], '', headers), code('PT401'));
    await assert.rejects(as('anon', `select public.agent_get_meeting('kickoff')`, [], '', headers), code('PT401'));
  }
  await assert.rejects(as('authenticated', 'select public.agent_get_course()', [], ALICE), /permission denied/);
  // The deploy's secret key can't read it either, nor change it.
  await assert.rejects(as('service_role', `select public.get_course('widgetry')`), /permission denied|team list/);
  await assert.rejects(as('service_role', `select public.sync_course('widgetry', '[]'::jsonb, ${REPO}, 'o/r')`),
    /managed on its website/);
  await assert.rejects(as('service_role', `select public.sync_meetings('widgetry', ${REPO}, '[]'::jsonb)`),
    /belongs to another repository|managed on its website/);
  const [{ n }] = (await db.query(`select count(*)::int as n from private.members where course_id = 'widgetry'`)).rows;
  assert.equal(n, 2, 'team list unchanged');
});

test('private: the team reads published meetings; drafts only organizers', async () => {
  const { alice, bob, json } = await course();
  assert.deepEqual(await json(alice, `select public.create_meeting('widgetry', 'kickoff', '{"title": "Kickoff"}')`),
    { id: 'kickoff', published: false });
  await json(alice, `select public.save_part('widgetry', 'kickoff', 'pre', $1, 0)`, [JSON.stringify(PRE)]);

  let site = await json(bob, `select public.get_course('widgetry')`);
  assert.equal(site.course.name, 'Applied Widgetry');
  assert.deepEqual(site.me, { login: 'bob', github_id: 1002, organizer: false });
  assert.deepEqual(site.meetings, [], 'a draft is hidden from members');
  assert.equal(site.agent_keys, null, 'keys are for organizers');
  assert.deepEqual(site.members.map((m) => [m.login, m.organizer]), [['alice', true], ['bob', false]]);
  // Nobody can answer a draft's survey.
  await assert.rejects(bob(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "None"}')`), /no survey/);

  site = await json(alice, `select public.get_course('widgetry')`);
  assert.equal(site.meetings.length, 1);
  assert.equal(site.meetings[0].pre.saved_by, 'member:alice');
  assert.equal(site.meetings[0].details.content.title, 'Kickoff');
  assert.deepEqual(site.meetings[0].post, { version: 0, content: null });

  await alice(`select public.set_published('widgetry', 'kickoff', true)`);
  site = await json(bob, `select public.get_course('widgetry')`);
  assert.equal(site.meetings[0].pre.content.questions[0].id, 'grace');
  // Published: answers work, checked against the Pre-meeting survey.
  await bob(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "1 hour"}')`);
  await assert.rejects(bob(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "2 hours"}')`), /one of its options/);
  await assert.rejects(bob(`select public.save_answer('widgetry', 'kickoff', 'rooms', '{"x": "y"}')`), /no survey/);
  const answers = await bob(`select * from public.get_answers('widgetry', 'kickoff', true)`);
  assert.equal(answers.length, 1);
});

test('private: only organizers change the team, meetings and keys; the team keeps an organizer', async () => {
  const { alice, bob, json } = await course();
  for (const sql of [
    `select public.add_member('widgetry', 2001, 'dave')`,
    `select public.update_member('widgetry', 1002, 'Bob', true)`,
    `select public.remove_member('widgetry', 1001)`,
    `select public.create_meeting('widgetry', 'x', '{"title": "X"}')`,
    `select public.save_part('widgetry', 'x', 'pre', '{}', 0)`,
    `select public.create_agent_key('widgetry', 'x', 'read')`,
    `select public.update_course('widgetry', 'Renamed')`,
    `select public.get_versions('widgetry', '', 'notes')`,
  ]) {
    await assert.rejects(bob(sql), /only organizers/, sql);
  }
  await assert.rejects(alice(`select public.add_member('widgetry', 1002, 'bob')`), /already on the team/);
  await assert.rejects(alice(`select public.add_member('widgetry', 7, 'Bob')`), /another team member/);
  await assert.rejects(alice(`select public.add_member('widgetry', 7, 'bad name!')`), /not a GitHub username/);
  await assert.rejects(alice(`select public.update_member('widgetry', 1001, null, false)`), /at least one organizer/);
  await assert.rejects(alice(`select public.remove_member('widgetry', 1001)`), /at least one organizer/);
  await alice(`select public.update_member('widgetry', 1002, 'Bob B.', true)`);
  await bob(`select public.remove_member('widgetry', 1001)`); // bob is an organizer now
  await assert.rejects(alice(`select public.get_course('widgetry')`), /not on this course's team list/);
  // Another course's organizer has no say here.
  const site = await json(bob, `select public.get_course('widgetry')`);
  assert.deepEqual(site.members.map((m) => [m.login, m.name, m.organizer]), [['bob', 'Bob B.', true]]);
  // New members can sign up (the sign-up rule reads the same team list).
  await bob(`select public.add_member('widgetry', 2001, 'dave')`);
  const ok = await bob(`select public.hook_before_user_created($1::jsonb) as r`, [JSON.stringify({
    user: { app_metadata: { provider: 'github' }, user_metadata: { provider_id: '2001' } } })]).catch((e) => e);
  assert.ok(ok instanceof Error, 'members cannot call the hook themselves');
});

test('private: every save is a version; stale saves are refused; old versions can be restored', async () => {
  const { alice, json } = await course();
  await json(alice, `select public.create_meeting('widgetry', 'kickoff', '{"title": "Kickoff"}')`);
  const save = (content, base, extra = '') =>
    json(alice, `select public.save_part('widgetry', 'kickoff', 'pre', $1, $2${extra})`, [JSON.stringify(content), base]);
  assert.deepEqual(await save(PRE, 0), { version: 1, warnings: [], answers_affected: 0 });
  await assert.rejects(save(PRE, 0), code('PT409'));
  await assert.rejects(save(PRE, 2), code('PT409'));
  await save({ ...PRE, background_md: 'Changed.' }, 1);

  const versions = await json(alice, `select public.get_versions('widgetry', 'kickoff', 'pre')`);
  assert.deepEqual(versions.map((v) => [v.version, v.saved_by]), [[2, 'member:alice'], [1, 'member:alice']]);
  const old = await json(alice, `select public.get_version('widgetry', 'kickoff', 'pre', 1)`);
  assert.equal(old.background_md, 'Why we meet.');
  await save(old, 2); // restoring = saving the old content as the newest version
  const site = await json(alice, `select public.get_course('widgetry')`);
  assert.equal(site.meetings[0].pre.version, 3);
  assert.equal(site.meetings[0].pre.content.background_md, 'Why we meet.');

  await assert.rejects(json(alice, `select public.save_part('widgetry', 'nope', 'pre', '{}', 0)`), code('PT404'));
  await assert.rejects(json(alice, `select public.save_part('widgetry', 'kickoff', 'minutes', '{}', 0)`), /unknown part/);
});

test('private: content is checked against the documented shapes', async () => {
  const { alice, json } = await course();
  await json(alice, `select public.create_meeting('widgetry', 'kickoff', '{"title": "Kickoff"}')`);
  const save = (part, content) =>
    json(alice, `select public.save_part('widgetry', 'kickoff', $1, $2, (select coalesce(max(version), 0) from (select (jsonb_array_elements(public.get_versions('widgetry', 'kickoff', $1)) ->> 'version')::int as version) v))`,
      [part, JSON.stringify(content)]);
  const bad = async (part, content, pattern) => assert.rejects(save(part, content), pattern, JSON.stringify(content));

  await bad('pre', { extra: 1 }, /pre: unknown key "extra"/);
  await bad('pre', { questions: [{ id: 'Grace', text: 'x' }] }, /not a valid id/);
  await bad('pre', { questions: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] }, /"a" is used more than once/);
  await bad('pre', { questions: [{ id: 'a' }] }, /questions\[0\]\.text: is required/);
  await bad('pre', { questions: [{ id: 'a', text: 'x', survey: [{ id: 'f', type: 'single', label: 'L', options: ['one'] }] }] }, /2 or more different options/);
  await bad('pre', { questions: [{ id: 'a', text: 'x', survey: [{ id: 'f', type: 'single', label: 'L', options: ['A', 'A'] }] }] }, /2 or more different options/);
  await bad('pre', { questions: [{ id: 'a', text: 'x', survey: [{ id: 'f', type: 'rating', label: 'L' }] }] }, /must be single, multiple or text/);
  await bad('pre', { responses: { reveal: 'never' } }, /reveal: must be anytime/);
  await bad('pre', { background_md: 'x'.repeat(20001) }, /longer than 20000/);
  await bad('details', { title: '' }, /must not be empty/);
  await bad('details', { title: 'X', starts_at: '2026-11-24 16:00' }, /time zone/);
  await bad('details', { title: 'X', duration_min: 0 }, /whole number from 1/);
  await bad('in', { items: [{ short: 'x' }] }, /needs a question or a title/);
  await bad('in', { items: [{ title: 'x', key_points: [1] }] }, /key_points/);
  await bad('post', { decisions: [{ id: 'd' }] }, /decision_md: is required/);
  await bad('post', { next_steps: [{ owner: 'alice' }] }, /what_md: is required/);
  await bad('post', { open: [{ text_md: 'x', owner: 'y' }] }, /unknown key "owner"/);

  await save('pre', PRE);
  const result = await save('in', { items: [
    { question: 'grace', short: 'Grace?', consensus_md: 'Most for 1 hour.', key_points: ['a'], contested: true,
      disagreement_md: 'Some say none.', minutes: 10 },
    { question: 'missing', short: 'x' },
    { title: 'Wrap-up', notes_md: 'Read back.' },
  ] });
  assert.deepEqual(result.warnings, ['question "missing" is not in the Pre-meeting part']);
  await save('post', {
    summary_md: 'We met.',
    decisions: [{ id: 'grace-1h', question: 'grace', decision_md: '1 hour.' }],
    next_steps: [{ what_md: 'Announce it', owner: 'alice', due: '2026-11-17', question: 'grace' }],
    open: [{ question: 'rooms', text_md: 'Rooms.', next_md: 'Next time.' }],
  });
  await save('details', { title: 'Kickoff', starts_at: '2026-11-24T16:15:00+01:00', duration_min: 60, location_md: 'HG E 33' });
});

test('private: changing answered survey fields needs force; the date and anonymity follow the parts', async () => {
  const { db, alice, bob, json } = await course();
  await json(alice, `select public.create_meeting('widgetry', 'kickoff', '{"title": "Kickoff"}')`);
  await json(alice, `select public.save_part('widgetry', 'kickoff', 'pre', $1, 0)`, [JSON.stringify(PRE)]);
  await alice(`select public.set_published('widgetry', 'kickoff', true)`);
  await bob(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "1 hour", "why": "Because."}')`);

  const changed = structuredClone(PRE);
  changed.questions[0].survey[0].options = ['None', '2 hours']; // "1 hour" was answered
  await assert.rejects(json(alice, `select public.save_part('widgetry', 'kickoff', 'pre', $1, 1)`, [JSON.stringify(changed)]),
    /1 saved answer\(s\) no longer fit/);
  const kept = structuredClone(PRE);
  kept.questions[0].survey[0].options.push('24 hours'); // adding an option is fine
  assert.equal((await json(alice, `select public.save_part('widgetry', 'kickoff', 'pre', $1, 1)`, [JSON.stringify(kept)])).answers_affected, 0);
  assert.equal((await json(alice, `select public.save_part('widgetry', 'kickoff', 'pre', $1, 2, null, true)`, [JSON.stringify(changed)])).answers_affected, 1);

  const meeting = async () => (await db.query(`select date::text, anonymous, reveal from private.meetings where course_id = 'widgetry' and id = 'kickoff'`)).rows[0];
  await json(alice, `select public.save_part('widgetry', 'kickoff', 'details', $1, 1)`,
    [JSON.stringify({ title: 'Kickoff', starts_at: '2026-11-24T23:30:00Z' })]);
  assert.equal((await meeting()).date, '2026-11-25', 'the date is the Zurich date of the start time');
  await json(alice, `select public.save_part('widgetry', 'kickoff', 'pre', $1, 3)`,
    [JSON.stringify({ ...changed, responses: { reveal: 'after_answering', anonymous: true } })]);
  assert.deepEqual(await meeting(), { date: '2026-11-25', anonymous: true, reveal: 'after_answering' });
  // Answers that already didn't fit don't ask for force again.
  assert.equal((await json(alice, `select public.save_part('widgetry', 'kickoff', 'pre', $1, 4)`, [JSON.stringify(changed)])).answers_affected, 0);
  assert.equal((await meeting()).anonymous, true, 'once anonymous, always anonymous');
  // Unpublishing closes the survey again.
  await alice(`select public.set_published('widgetry', 'kickoff', false)`);
  await assert.rejects(bob(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "None"}')`), /no survey/);
});

test('private: agent keys work for one course, can be read-only, and can be revoked', async () => {
  const { db, as, alice, bob, json } = await course();
  const key = await json(alice, `select public.create_agent_key('widgetry', 'OpenClaw', 'write')`);
  assert.match(key, /^me_agent_[0-9a-f]{64}$/);
  const readKey = await json(alice, `select public.create_agent_key('widgetry', 'Backup', 'read')`);
  const [{ stored }] = (await db.query(`select count(*)::int as stored from private.agent_keys where key_hash = $1 or key_hint = $1`, [key])).rows;
  assert.equal(stored, 0, 'the key itself is not stored');
  const agent = (sql, params = [], k = key) => as('anon', sql, params, '', { 'x-agent-key': k })
    .then((rows) => Object.values(rows[0])[0]);

  assert.deepEqual(await agent('select public.agent_whoami()'),
    { course: 'widgetry', course_name: 'Applied Widgetry', key_label: 'OpenClaw', permission: 'write', api_version: 0 });

  // Create a meeting: always a draft, saved by the agent.
  const created = await agent(`select public.agent_create_meeting('poll', 'Poll', duration_min => 60)`);
  assert.deepEqual(created, { id: 'poll', published: false,
    links: { pre: `${SITE}#/m/poll/pre`, in: `${SITE}#/m/poll/during`, post: `${SITE}#/m/poll/post` } });
  await assert.rejects(agent(`select public.agent_create_meeting('poll', 'Again')`), code('PT409'));
  const put = await agent(`select public.agent_put_section('poll', 'pre', 0, $1, 'first draft')`, [JSON.stringify(PRE)]);
  assert.equal(put.version, 1);
  await assert.rejects(agent(`select public.agent_put_section('poll', 'pre', 0, $1)`, [JSON.stringify(PRE)]), code('PT409'));
  await assert.rejects(agent(`select public.agent_put_section('poll', 'details', 1, '{"title": "x"}')`), /part must be pre, in or post/);
  await assert.rejects(agent(`select public.agent_put_section('nope', 'pre', 0, '{}')`), code('PT404'));

  // Update details: only the given fields change.
  const upd = await agent(`select public.agent_update_meeting('poll', 1, '{"starts_at": "2026-11-24T16:00:00+01:00"}')`);
  assert.equal(upd.version, 2);
  const meeting = await agent(`select public.agent_get_meeting('poll')`);
  assert.deepEqual(meeting.details.content, { title: 'Poll', duration_min: 60, starts_at: '2026-11-24T16:00:00+01:00' });
  assert.equal(meeting.details.saved_by, 'agent:OpenClaw');
  assert.equal(meeting.published, false);
  assert.equal(meeting.links.pre, `${SITE}#/m/poll/pre`);

  // Bob doesn't see the draft until an organizer publishes it.
  assert.equal((await json(bob, `select public.get_course('widgetry')`)).meetings.length, 0);
  await alice(`select public.set_published('widgetry', 'poll', true)`);
  assert.equal((await json(bob, `select public.get_course('widgetry')`)).meetings.length, 1);

  // Notes, decisions and next steps in agent_get_course.
  assert.deepEqual(await agent(`select public.agent_put_course_notes(0, '## Timeline')`), { version: 1, warnings: [] });
  await agent(`select public.agent_put_section('poll', 'post', 0, $1)`, [JSON.stringify({
    decisions: [{ id: 'grace-1h', question: 'grace', decision_md: '1 hour.' }],
    next_steps: [{ what_md: 'Announce it', owner: 'alice' }],
  })]);
  const c = await agent('select public.agent_get_course()', [], readKey);
  assert.deepEqual(c.notes, { version: 1, notes_md: '## Timeline' });
  assert.deepEqual(c.decisions, [{ id: 'grace-1h', question: 'grace', decision_md: '1 hour.', meeting: 'poll' }]);
  assert.deepEqual(c.next_steps, [{ what_md: 'Announce it', owner: 'alice', meeting: 'poll' }]);
  assert.deepEqual(c.meetings[0].parts, { details: 2, pre: 1, in: 0, post: 1 });
  assert.deepEqual(c.members.map((m) => m.login), ['alice', 'bob']);
  assert.equal(JSON.stringify(c).includes('1002'), false, 'no GitHub ids for the agent');

  // A read key can't write; nothing the agent can call changes the team or keys.
  await assert.rejects(agent(`select public.agent_put_course_notes(1, 'x')`, [], readKey), code('PT403'));
  await assert.rejects(agent(`select public.agent_create_meeting('x', 'X')`, [], readKey), code('PT403'));
  for (const sql of [`select public.add_member('widgetry', 9, 'eve')`, `select public.set_published('widgetry', 'poll', true)`,
    `select public.create_agent_key('widgetry', 'x', 'write')`, `select public.get_course('widgetry')`]) {
    await assert.rejects(as('anon', sql, [], '', { 'x-agent-key': key }), /permission denied/, sql);
  }

  // Keys belong to one course: "other"'s organizer's key sees only "other".
  const carolKey = await json((sql) => as('authenticated', sql, [], '00000000-0000-0000-0000-000000000005'),
    `select public.create_agent_key('other', 'C', 'write')`);
  assert.equal((await agent('select public.agent_whoami()', [], carolKey)).course, 'other');
  await assert.rejects(agent(`select public.agent_get_meeting('poll')`, [], carolKey), code('PT404'));
  await assert.rejects(agent(`select public.agent_put_section('poll', 'pre', 1, $1)`, [JSON.stringify(PRE)], carolKey), code('PT404'));

  // Keys are listed for organizers (without the key) and can be revoked.
  const keys = (await json(alice, `select public.get_course('widgetry')`)).agent_keys;
  assert.deepEqual(keys.map((k) => [k.label, k.permission, k.created_by, k.revoked_at]),
    [['OpenClaw', 'write', 'alice', null], ['Backup', 'read', 'alice', null]]);
  assert.ok(keys[0].last_used_at);
  assert.equal(JSON.stringify(keys).includes(key), false);
  await alice(`select public.revoke_agent_key('widgetry', $1)`, [keys[0].id]);
  await assert.rejects(agent('select public.agent_whoami()'), code('PT401'));
  assert.equal((await agent('select public.agent_whoami()', [], readKey)).permission, 'read');
});

test('private: the legacy repository courses keep working next to site courses', async () => {
  const { as, json, alice } = await course();
  const members = JSON.stringify([{ github_id: 1001, github_login: 'alice' }]);
  await as('service_role', `select public.sync_course('demo', $1::jsonb, ${REPO}, 'o/r')`, [members]);
  await as('service_role', `select public.sync_meetings('demo', ${REPO}, $1::jsonb)`, [JSON.stringify([
    { id: 'm', date: '2099-01-01', reveal: 'anytime', anonymous: false,
      questions: { q: [{ id: 'f', type: 'text', options: [], required: false }] } }])]);
  await as('authenticated', `select public.save_answer('demo', 'm', 'q', '{"f": "hi"}')`, [], ALICE);
  // A repository course is not readable through the new functions.
  await assert.rejects(json(alice, `select public.get_course('demo')`), /not on this course's team list/);
  // And creating a site course needs the SQL Editor (the owner), not the secret key.
  await assert.rejects(as('service_role', `select private.create_course('x', 'X', 'a', 1, '${SITE}')`), /permission denied/);
  await assert.rejects(as('authenticated', `select private.create_course('x', 'X', 'a', 1, '${SITE}')`, [], TWO_ACCOUNTS), /permission denied/);
});
