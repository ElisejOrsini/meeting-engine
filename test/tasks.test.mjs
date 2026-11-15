// Database tests for part 6: tasks and written check-ins on the timeline,
// suggested tasks from next steps, and the agent's drafts. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, actor, ALICE, BOB } from './db-setup.mjs';

const SITE = 'https://example-org.github.io/meetings/';
const CAROL = '00000000-0000-0000-0000-000000000005'; // GitHub 3001, on no team list

/** The Zurich date `n` days from today, "YYYY-MM-DD". */
function day(n) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + n)).toISOString().slice(0, 10);
}

async function course() {
  const db = await setup();
  const as = actor(db);
  await db.exec('set role owner;');
  await db.query(`select private.create_course('widgetry', 'Applied Widgetry', 'alice', 1001, $1)`, [SITE]);
  await db.exec('reset role;');
  await db.exec(`insert into auth.identities values ('${CAROL}', 'github', '3001')`);
  const alice = (sql, params = []) => as('authenticated', sql, params, ALICE);
  const bob = (sql, params = []) => as('authenticated', sql, params, BOB);
  const carol = (sql, params = []) => as('authenticated', sql, params, CAROL);
  const json = async (who, sql, params = []) => Object.values((await who(sql, params))[0])[0];
  await alice(`select public.add_member('widgetry', 1002, 'bob', 'Bob', false)`);
  const keyOf = (permission) => json(alice, `select public.create_agent_key('widgetry', 'OpenClaw', $1)`, [permission]);
  const agentWith = (key) => (sql, params = []) => as('anon', sql, params, '', { 'x-agent-key': key })
    .then((rows) => Object.values(rows[0])[0]);
  const agent = agentWith(await keyOf('write'));
  const reader = agentWith(await keyOf('read'));
  const items = async (who) => (await json(who, `select public.get_course('widgetry')`)).items;
  return { db, alice, bob, carol, json, agent, reader, items };
}

test('tasks: organizers add tasks and check-ins for people or everyone; the team sees them', async () => {
  const { alice, bob, carol, json, items } = await course();
  await json(alice, `select public.create_meeting('widgetry', 'kickoff', '{"title": "Kickoff"}'::jsonb)`);
  const task = await json(alice, `select public.add_item('widgetry', 'task', $1)`, [JSON.stringify({
    title: 'Upload sheet 9', due: day(4), details_md: 'Solutions after Friday.', people: ['BOB'], meeting: 'kickoff' })]);
  assert.equal(task.kind, 'task');
  assert.deepEqual(task.people, ['bob'], 'logins, case-insensitive');
  assert.equal(task.everyone, false);
  assert.equal(task.published, true, 'visible at once');
  assert.equal(task.created_by, '@alice');
  const checkin = await json(alice, `select public.add_item('widgetry', 'checkin', $1)`, [JSON.stringify({
    title: 'Project status', due: day(5), question_md: 'How are your groups doing?', people: 'everyone' })]);
  assert.equal(checkin.everyone, true);
  assert.equal(checkin.expected, 2);
  assert.equal(checkin.written, 0);

  const seen = await items(bob);
  assert.deepEqual(seen.map((i) => i.title), ['Upload sheet 9', 'Project status'], 'soonest first');
  assert.equal(seen[0].for_me, true);
  assert.equal(seen[0].meeting, null, 'kickoff is still a draft: members don’t see its id');
  assert.equal((await items(alice))[0].meeting, 'kickoff', 'organizers do');
  assert.equal(seen[1].question_md, 'How are your groups doing?');

  await assert.rejects(bob(`select public.add_item('widgetry', 'task', '{"title": "X", "due": "${day(1)}"}'::jsonb)`), /only organizers/);
  await assert.rejects(bob(`select public.delete_item('widgetry', $1)`, [task.id]), /only organizers/);
  await assert.rejects(carol(`select public.get_course('widgetry')`), /not on this course's team list/);
  await assert.rejects(carol(`select public.get_checkin('widgetry', $1)`, [checkin.id]), /not on this course's team list/);

  // Checks: unknown people, bad dates, wrong keys.
  const add = (kind, item) => json(alice, `select public.add_item('widgetry', $1, $2)`, [kind, JSON.stringify(item)]);
  await assert.rejects(add('task', { title: 'X', due: day(1), people: ['nobody'] }), /"nobody" is not on the team list/);
  await assert.rejects(add('task', { title: 'X', due: '2026-02-30' }), /not a real date/);
  await assert.rejects(add('task', { title: 'X', due: day(400) }), /within a year/);
  await assert.rejects(add('checkin', { title: 'X', due: day(1), meeting: 'kickoff' }), /unknown key "meeting"/);
  await assert.rejects(add('task', { title: ' ', due: day(1) }), /must not be empty/);
  await assert.rejects(add('note', { title: 'X', due: day(1) }), /"task" or "checkin"/);
  await assert.rejects(add('task', { title: 'X', due: day(1), meeting: 'nope' }), /no meeting "nope"/);

  // Organizers change and delete items.
  const changed = await json(alice, `select public.update_item('widgetry', $1, $2)`, [task.id,
    JSON.stringify({ title: 'Upload sheet 10', due: day(6), people: ['alice', 'bob'] })]);
  assert.equal(changed.title, 'Upload sheet 10');
  assert.deepEqual(changed.people, ['alice', 'bob']);
  assert.equal(changed.meeting, 'kickoff', 'the meeting link stays when "meeting" isn’t sent');
  const unlinked = await json(alice, `select public.update_item('widgetry', $1, $2)`, [task.id,
    JSON.stringify({ title: 'Upload sheet 10', due: day(6), meeting: null })]);
  assert.equal(unlinked.meeting, null, 'null removes it');
  assert.equal(unlinked.everyone, true, 'the other fields are replaced');
  await alice(`select public.delete_item('widgetry', $1)`, [task.id]);
  assert.equal((await items(bob)).length, 1);
  await assert.rejects(alice(`select public.delete_item('widgetry', 'not-a-uuid')`), /no such task/);
});

test('check-ins: everyone writes their own update; everyone reads them with names', async () => {
  const { db, alice, bob, json } = await course();
  const c = await json(alice, `select public.add_item('widgetry', 'checkin', $1)`,
    [JSON.stringify({ title: 'Status', due: day(2), people: ['bob'] })]);
  assert.equal(c.expected, 1, 'only Bob is asked');
  await bob(`select public.save_checkin_update('widgetry', $1, '  Group B is on track.  ')`, [c.id]);
  await alice(`select public.save_checkin_update('widgetry', $1, 'Mine too.')`, [c.id]); // anyone may write
  let s = await json(bob, `select public.get_checkin('widgetry', $1)`, [c.id]);
  assert.deepEqual(s.updates.map((u) => [u.login, u.text]), [['bob', 'Group B is on track.'], ['alice', 'Mine too.']]);
  assert.deepEqual(s.not_written, []);
  assert.equal(s.mine, true);
  assert.equal(s.written, 1, 'only the people asked are counted');
  assert.equal(s.expected, 1);
  await bob(`select public.save_checkin_update('widgetry', $1, 'Changed.')`, [c.id]);
  await bob(`select public.save_checkin_update('widgetry', $1, '')`, [c.id]);
  s = await json(alice, `select public.get_checkin('widgetry', $1)`, [c.id]);
  assert.deepEqual(s.not_written, ['bob'], 'removing your update');
  await assert.rejects(bob(`select public.save_checkin_update('widgetry', $1, $2)`, [c.id, 'x'.repeat(4001)]), /at most 4000/);
  const task = await json(alice, `select public.add_item('widgetry', 'task', $1)`, [JSON.stringify({ title: 'T', due: day(2) })]);
  await assert.rejects(bob(`select public.save_checkin_update('widgetry', $1, 'x')`, [task.id]), /no such check-in/);
  await assert.rejects(bob(`select public.get_checkin('widgetry', $1)`, [task.id]), /a task, not a check-in/);

  // 60 days after the due date the updates are hidden, closed, and deleted at night.
  await bob(`select public.save_checkin_update('widgetry', $1, 'Old news.')`, [c.id]);
  await db.exec(`set role owner; update private.timeline_items set due = current_date - 61 where id = '${c.id}'; reset role;`);
  s = await json(bob, `select public.get_checkin('widgetry', $1)`, [c.id]);
  assert.equal(s.expired, true);
  assert.deepEqual(s.updates, []);
  assert.equal(s.written, 0);
  await assert.rejects(bob(`select public.save_checkin_update('widgetry', $1, 'x')`, [c.id]), /closed/);
  await db.exec('set role owner;');
  assert.equal((await db.query('select private.delete_old_checkin_updates() as n')).rows[0].n, 2);
  await db.exec('reset role;');
});

test('tasks: the agent makes drafts; organizers publish them; the agent sees names', async () => {
  const { alice, bob, json, agent, reader, items } = await course();
  const draft = await agent(`select public.agent_create_task('Draft exam questions', $1, 'Two each.', '["bob"]'::jsonb)`, [day(7)]);
  assert.equal(draft.published, false);
  assert.equal(draft.created_by, 'agent:OpenClaw');
  assert.match(draft.links.timeline, new RegExp(`#/timeline\\?open=item-${draft.id}$`));
  assert.deepEqual(await items(bob), [], 'the team doesn’t see drafts');
  assert.equal((await items(alice)).length, 1, 'organizers do');
  await assert.rejects(reader(`select public.agent_create_task('X', $1)`, [day(1)]), /may only read/);
  await assert.rejects(agent(`select public.agent_create_checkin('X', $1, null, '["zoe"]'::jsonb)`, [day(1)]), /"zoe" is not on the team list/);

  let due = (await agent(`select public.agent_due()`)).items.filter((i) => i.kind === 'draft');
  assert.deepEqual(due.map((i) => [i.title, i.state]), [['Draft exam questions', 'draft']]);

  const fixed = await agent(`select public.agent_update_item($1, $2)`, [draft.id,
    JSON.stringify({ title: 'Draft exam questions', due: day(8), people: 'everyone' })]);
  assert.equal(fixed.everyone, true);
  await json(alice, `select public.publish_item('widgetry', $1)`, [draft.id]);
  assert.equal((await items(bob)).length, 1);
  await assert.rejects(agent(`select public.agent_update_item($1, '{"title": "X", "due": "${day(1)}"}'::jsonb)`, [draft.id]), /only organizers/);
  await assert.rejects(agent(`select public.agent_delete_item($1)`, [draft.id]), /only organizers/);
  const gone = await agent(`select public.agent_create_task('Delete me', $1)`, [day(3)]);
  await agent(`select public.agent_delete_item($1)`, [gone.id]);
  assert.equal((await agent(`select public.agent_list_items()`)).items.length, 1);

  // Check-ins: names for the agent, and reminders in agent_due.
  const c = await agent(`select public.agent_create_checkin('Project status', $1, 'How is it going?')`, [day(1)]);
  await json(alice, `select public.publish_item('widgetry', $1)`, [c.id]);
  await bob(`select public.save_checkin_update('widgetry', $1, 'Fine.')`, [c.id]);
  const read = await reader(`select public.agent_get_checkin($1)`, [c.id]);
  assert.deepEqual(read.updates.map((u) => u.login), ['bob']);
  assert.deepEqual(read.not_written, ['alice']);
  due = (await agent(`select public.agent_due()`)).items.filter((i) => i.kind === 'checkin');
  assert.deepEqual(due.map((i) => [i.state, i.not_written]), [['due', ['alice']]], 'due tomorrow: remind Alice');
  await alice(`select public.save_checkin_update('widgetry', $1, 'Fine too.')`, [c.id]);
  assert.equal((await agent(`select public.agent_due()`)).items.filter((i) => i.kind === 'checkin').length, 0, 'everyone wrote');
});

test('suggested tasks: next steps with a due date, for organizers to add or dismiss', async () => {
  const { alice, bob, json, items } = await course();
  await json(alice, `select public.create_meeting('widgetry', 'retro', '{"title": "Retro"}'::jsonb)`);
  await alice(`select public.set_published('widgetry', 'retro', true)`);
  const post = { next_steps: [
    { what_md: 'Announce the rule', owner: '@Bob', due: day(3) },
    { what_md: 'Book a room', owner: 'all TAs', due: day(5) },
    { what_md: 'Think about it', owner: 'alice', due: 'before the midterm' },
    { what_md: 'Long ago', due: day(-10) },
  ] };
  await json(alice, `select public.save_part('widgetry', 'retro', 'post', $1, 0)`, [JSON.stringify(post)]);

  let s = (await json(alice, `select public.get_course('widgetry')`)).suggestions;
  assert.deepEqual(s.map((x) => [x.what_md, x.people]), [['Announce the rule', ['bob']], ['Book a room', []]],
    'only real dates from a week ago on; the owner matched to the team');
  assert.equal(s[0].meeting_title, 'Retro');
  assert.deepEqual((await json(bob, `select public.get_course('widgetry')`)).suggestions, [], 'organizers only');

  const added = await json(alice, `select public.add_suggested_task('widgetry', 'retro', $1, $2)`, [s[0].key,
    JSON.stringify({ title: 'Announce the late-submission rule', due: s[0].due, people: ['bob'] })]);
  assert.equal(added.meeting, 'retro', 'agreed in the meeting');
  await assert.rejects(alice(`select public.add_suggested_task('widgetry', 'retro', $1, $2)`, [s[0].key,
    JSON.stringify({ title: 'Again', due: s[0].due })]), /suggestion is gone/);
  await alice(`select public.dismiss_suggestion('widgetry', 'retro', $1)`, [s[1].key]);
  await assert.rejects(bob(`select public.dismiss_suggestion('widgetry', 'retro', $1)`, [s[1].key]), /only organizers/);
  s = (await json(alice, `select public.get_course('widgetry')`)).suggestions;
  assert.deepEqual(s, []);
  assert.deepEqual((await items(bob)).map((i) => i.title), ['Announce the late-submission rule']);

  // A next step that changes is suggested again.
  post.next_steps[1].due = day(6);
  await json(alice, `select public.save_part('widgetry', 'retro', 'post', $1, 1)`, [JSON.stringify(post)]);
  assert.deepEqual((await json(alice, `select public.get_course('widgetry')`)).suggestions.map((x) => x.what_md), ['Book a room']);
});

test('tasks: review fixes (people who left, impossible dates, repeated next steps, double clicks)', async () => {
  const { alice, bob, json, items } = await course();
  // Everyone it was for left the team: "nobody", not "everyone".
  const t = await json(alice, `select public.add_item('widgetry', 'task', $1)`, [JSON.stringify({ title: 'Bob’s', due: day(2), people: ['bob'] })]);
  await alice(`select public.remove_member('widgetry', 1002)`);
  const left = (await items(alice)).find((i) => i.id === t.id);
  assert.deepEqual([left.everyone, left.nobody, left.people], [false, true, []]);

  await json(alice, `select public.create_meeting('widgetry', 'm', '{"title": "M"}'::jsonb)`);
  await alice(`select public.set_published('widgetry', 'm', true)`);
  await json(alice, `select public.save_part('widgetry', 'm', 'post', $1, 0)`, [JSON.stringify({ next_steps: [
    { what_md: 'Grade sheet 8', owner: 'Mia', due: day(3) },
    { what_md: 'Grade sheet 8', owner: 'Jonas', due: day(3) },
    { what_md: 'Impossible', due: '2026-11-31' },
  ] })]);
  const s = (await json(alice, `select public.get_course('widgetry')`)).suggestions;
  assert.equal(s.length, 2, 'the impossible date isn’t suggested');
  assert.notEqual(s[0].key, s[1].key, 'repeated next steps get their own keys');
  await json(alice, `select public.add_suggested_task('widgetry', 'm', $1, $2)`, [s[0].key, JSON.stringify({ title: 'Grade', due: day(3) })]);
  await assert.rejects(alice(`select public.add_suggested_task('widgetry', 'm', $1, $2)`, [s[0].key, JSON.stringify({ title: 'Grade', due: day(3) })]),
    /suggestion is gone/, 'a second click doesn’t add it twice');
  assert.equal((await json(alice, `select public.get_course('widgetry')`)).suggestions.length, 1, 'the other one is still there');
  assert.equal((await items(alice)).filter((i) => i.title === 'Grade').length, 1);
});
