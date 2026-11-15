// Database tests for part 4: vote counts for the In-meeting tab, the snapshot
// kept after the answers are deleted, and the agent's responses and "what's
// due" list. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, actor, ALICE, BOB } from './db-setup.mjs';

const SITE = 'https://example-org.github.io/meetings/';
const CAROL = '00000000-0000-0000-0000-000000000005'; // GitHub 3001, on no team list

const pre = (reveal = 'anytime') => ({
  background_md: 'Why we meet.',
  responses: { reveal },
  questions: [
    { id: 'grace', text: 'Grace period?',
      survey: [
        { id: 'pick', type: 'single', label: 'Which?', options: ['None', '1 hour', '24 hours'] },
        { id: 'also', type: 'multiple', label: 'Also?', options: ['Email', 'Forum'] },
        { id: 'why', type: 'text', label: 'Why?' },
      ] },
    { id: 'rooms', text: 'Which rooms?' },
  ],
});

const inMinutes = (min) => new Date(Date.now() + min * 60_000).toISOString();

async function course({ startsInMinutes = 60 * 24, reveal = 'anytime' } = {}) {
  const db = await setup();
  const as = actor(db);
  await db.exec('set role owner;');
  await db.query(`select private.create_course('widgetry', 'Applied Widgetry', 'alice', 1001, $1)`, [SITE]);
  await db.exec('reset role;');
  await db.exec(`insert into auth.identities values ('${CAROL}', 'github', '3001')`);
  const alice = (sql, params = []) => as('authenticated', sql, params, ALICE);
  const bob = (sql, params = []) => as('authenticated', sql, params, BOB);
  const json = async (who, sql, params = []) => Object.values((await who(sql, params))[0])[0];
  await alice(`select public.add_member('widgetry', 1002, 'bob', 'Bob', false)`);
  await json(alice, `select public.create_meeting('widgetry', 'kickoff', $1)`,
    [JSON.stringify({ title: 'Kickoff', starts_at: inMinutes(startsInMinutes), duration_min: 60 })]);
  await json(alice, `select public.save_part('widgetry', 'kickoff', 'pre', $1, 0)`, [JSON.stringify(pre(reveal))]);
  await alice(`select public.set_published('widgetry', 'kickoff', true)`);
  const key = await json(alice, `select public.create_agent_key('widgetry', 'OpenClaw', 'write')`);
  const agent = (sql, params = []) => as('anon', sql, params, '', { 'x-agent-key': key })
    .then((rows) => Object.values(rows[0])[0]);
  return { db, as, alice, bob, json, agent };
}

const counts = (field) => Object.fromEntries(field.counts.map((c) => [c.option, c.count]));

test('in-meeting: the team sees vote counts without names; strangers see nothing', async () => {
  const { as, alice, bob, json } = await course();
  await alice(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "1 hour", "also": ["Email", "Forum"], "why": "Fair"}')`);
  await bob(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "1 hour", "also": ["Forum"]}')`);

  const t = await json(bob, `select public.get_tallies('widgetry', 'kickoff')`);
  assert.equal(t.visible, true);
  assert.equal(t.visible_from, null);
  const grace = t.questions.grace;
  assert.equal(grace.answered, 2);
  assert.deepEqual(grace.fields.map((f) => f.id), ['pick', 'also'], 'choice fields only, in survey order');
  assert.deepEqual(grace.fields[0].counts.map((c) => c.option), ['None', '1 hour', '24 hours'], 'options in survey order');
  assert.deepEqual(counts(grace.fields[0]), { None: 0, '1 hour': 2, '24 hours': 0 });
  assert.deepEqual(counts(grace.fields[1]), { Email: 1, Forum: 2 });
  assert.equal(grace.fields[1].answered, 2);
  assert.doesNotMatch(JSON.stringify(t), /alice|bob|Fair/, 'no names and no written answers');
  assert.equal(t.questions.rooms, undefined, 'questions without a survey have no counts');

  await assert.rejects(as('anon', `select public.get_tallies('widgetry', 'kickoff')`), /permission denied/);
  await assert.rejects(as('authenticated', `select public.get_tallies('widgetry', 'kickoff')`, [], CAROL), /not on this course's team list/);
  await assert.rejects(json(bob, `select public.get_tallies('widgetry', 'nope')`), /no meeting "nope"/);
});

test('in-meeting: with reveal after_answering, counts unlock per question once you answer or skip, for all 30 minutes before', async () => {
  const later = await course({ reveal: 'after_answering', startsInMinutes: 120 });
  await later.alice(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "None"}')`);
  const hidden = await later.json(later.bob, `select public.get_tallies('widgetry', 'kickoff')`);
  assert.equal(hidden.visible, false);
  assert.deepEqual(hidden.questions, {});
  assert.deepEqual(hidden.locked, ['grace']);
  assert.ok(Math.abs(new Date(hidden.visible_from) - (new Date(hidden.starts_at) - 30 * 60_000)) < 1000);
  // Alice answered: she sees the counts.
  assert.equal((await later.json(later.alice, `select public.get_tallies('widgetry', 'kickoff')`)).questions.grace.answered, 1);

  // Bob skips: the question unlocks for him, and the skip is not a vote.
  await later.bob(`select public.skip_question('widgetry', 'kickoff', 'grace')`);
  const unlocked = await later.json(later.bob, `select public.get_tallies('widgetry', 'kickoff')`);
  assert.deepEqual(unlocked.locked, []);
  assert.equal(unlocked.questions.grace.answered, 1);
  assert.equal(unlocked.questions.grace.skipped, 1);
  assert.deepEqual(counts(unlocked.questions.grace.fields[0]), { None: 1, '1 hour': 0, '24 hours': 0 });

  const soon = await course({ reveal: 'after_answering', startsInMinutes: 20 });
  await soon.alice(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "None"}')`);
  const shown = await soon.json(soon.bob, `select public.get_tallies('widgetry', 'kickoff')`);
  assert.equal(shown.visible, true);
  assert.deepEqual(shown.locked, []);
  assert.equal(shown.questions.grace.answered, 1);
});

test('skipping: works like an answer for unlocking, others never see it, answering ends it', async () => {
  const { alice, bob, json, agent } = await course({ reveal: 'after_answering' });
  const rows = async (who) => (await who(`select * from public.get_answers('widgetry', 'kickoff', true)`));
  await alice(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "1 hour"}')`);
  assert.equal((await rows(bob)).length, 0, 'locked before answering or skipping');

  assert.ok(await json(bob, `select public.skip_question('widgetry', 'kickoff', 'grace')`));
  const bobSees = await rows(bob);
  assert.deepEqual(bobSees.map((r) => [r.mine, r.answer]), [[true, {}], [false, { pick: '1 hour' }]],
    'his own skip comes back as an empty answer; the others\' answers unlock');
  const aliceSees = await rows(alice);
  assert.deepEqual(aliceSees.map((r) => r.github_login), ['alice'], 'others never see a skip');

  const r = await agent(`select public.agent_get_responses('kickoff')`);
  assert.equal(r.answered_any, 1);
  assert.equal(r.questions[0].answered, 1);
  assert.equal(r.questions[0].skipped, 1);

  // Answering after skipping replaces the skip; removing works the same for both.
  await bob(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "None"}')`);
  assert.equal((await rows(alice)).length, 2);
  assert.equal((await json(bob, `select public.get_tallies('widgetry', 'kickoff')`)).questions.grace.skipped, 0);
  await bob(`select public.skip_question('widgetry', 'kickoff', 'grace')`);
  await bob(`select public.save_answer('widgetry', 'kickoff', 'grace', '{}')`);
  assert.deepEqual((await rows(bob)), [], 'skip removed: locked again');

  await assert.rejects(json(bob, `select public.skip_question('widgetry', 'kickoff', 'rooms')`), /no survey/);
  await assert.rejects(json(bob, `select public.skip_question('widgetry', 'nope', 'grace')`), /no survey/);
});

test('in-meeting: the counts survive the 30-day deletion of the answers', async () => {
  const { db, alice, bob, json } = await course();
  await alice(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "24 hours"}')`);
  await bob(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "None"}')`);
  // Saving the In-meeting part takes a snapshot.
  await json(alice, `select public.save_part('widgetry', 'kickoff', 'in', $1, 0)`,
    [JSON.stringify({ items: [{ question: 'grace', consensus_md: 'Split.' }] })]);
  assert.equal((await db.query(`select count(*)::int as n from private.tallies`)).rows[0].n, 1);
  // A later answer is still counted live, and the nightly clean-up keeps it.
  await bob(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "24 hours"}')`);
  await db.exec(`update private.meetings set date = current_date - 40`);
  await db.exec('set role owner;');
  assert.equal((await db.query(`select private.delete_old_answers() as n`)).rows[0].n, 2);
  await db.exec('reset role;');
  assert.equal((await db.query(`select count(*)::int as n from private.answers`)).rows[0].n, 0);
  const t = await json(bob, `select public.get_tallies('widgetry', 'kickoff')`);
  assert.equal(t.visible, true);
  assert.deepEqual(counts(t.questions.grace.fields[0]), { None: 0, '1 hour': 0, '24 hours': 2 });
});

test('in-meeting: the agent gets counts and written answers as P1, P2, never names', async () => {
  const { alice, bob, agent } = await course();
  await alice(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "1 hour", "why": "Most are minutes late."}')`);
  await bob(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "None", "why": "Keep it simple."}')`);
  const r = await agent(`select public.agent_get_responses('kickoff')`);
  assert.equal(r.members, 2);
  assert.equal(r.answered_any, 2);
  assert.equal(r.expired, false);
  assert.deepEqual(r.questions.map((q) => q.id), ['grace'], 'only questions with a survey');
  const [pick, also, why] = r.questions[0].fields;
  assert.deepEqual(counts(pick), { None: 1, '1 hour': 1, '24 hours': 0 });
  assert.equal(pick.label, 'Which?');
  assert.equal(also.answered, 0);
  assert.deepEqual(why.texts.map((t) => t.text).sort(), ['Keep it simple.', 'Most are minutes late.']);
  assert.deepEqual(why.texts.map((t) => t.who).sort(), ['P1', 'P2']);
  assert.doesNotMatch(JSON.stringify(r), /alice|bob|1001|1002/);
  await assert.rejects(agent(`select public.agent_get_responses('nope')`), /no meeting "nope"/);
});

test('in-meeting: agent_due lists summaries to write until every survey question has one', async () => {
  const soon = await course({ startsInMinutes: 20 });
  let due = await soon.agent('select public.agent_due()');
  assert.equal(due.items.length, 1);
  const [item] = due.items;
  assert.equal(item.kind, 'in_summary');
  assert.equal(item.meeting, 'kickoff');
  assert.equal(item.title, 'Kickoff');
  assert.equal(item.state, 'due');
  assert.deepEqual(item.missing, ['grace']);
  assert.equal(item.in_version, 0);
  assert.equal(item.links.in, `${SITE}#/m/kickoff/during`);

  await soon.agent(`select public.agent_put_section('kickoff', 'in', 0, $1)`,
    [JSON.stringify({ items: [{ question: 'grace', short: 'Grace period?', consensus_md: 'Most want 1 hour.' }] })]);
  due = await soon.agent('select public.agent_due()');
  assert.deepEqual(due.items, [], 'done once every survey question has a consensus');

  const later = await course({ startsInMinutes: 60 * 24 * 2 });
  assert.equal((await later.agent('select public.agent_due()')).items[0].state, 'upcoming');
  const far = await course({ startsInMinutes: 60 * 24 * 10 });
  assert.deepEqual((await far.agent('select public.agent_due()')).items, [], 'not listed more than 7 days ahead');
  const over = await course({ startsInMinutes: -90 });
  assert.deepEqual((await over.agent('select public.agent_due()')).items, [], 'not listed after the meeting');
});

test('in-meeting: a question with an AI summary shows its counts to everyone (after_answering)', async () => {
  const { alice, bob, json, agent } = await course({ reveal: 'after_answering' });
  await alice(`select public.save_answer('widgetry', 'kickoff', 'grace', '{"pick": "1 hour"}')`);
  let t = await json(bob, `select public.get_tallies('widgetry', 'kickoff')`);
  assert.deepEqual(t.locked, ['grace'], 'locked before the summary');
  const meeting = await agent(`select public.agent_get_meeting('kickoff')`);
  await agent(`select public.agent_put_section('kickoff', 'in', $1, $2)`, [meeting.in.version,
    JSON.stringify({ items: [{ title: 'Grace', question: 'grace', consensus_md: 'Everyone who answered wants 1 hour.' }] })]);
  t = await json(bob, `select public.get_tallies('widgetry', 'kickoff')`);
  assert.deepEqual(t.locked, [], 'unlocked once summarized');
  assert.equal(t.questions.grace.answered, 1);
  const answers = await bob(`select * from public.get_answers('widgetry', 'kickoff', true)`);
  assert.ok(!JSON.stringify(answers).includes('1 hour'), 'others’ answers themselves (with names) stay hidden');
});
