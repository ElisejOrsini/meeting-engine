// Database tests for part 5: finding a time for a meeting (grids, everyone's
// free times, picking the time, the agent's suggestion). Run with: npm test
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
  const d = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + n));
  return d.toISOString().slice(0, 10);
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
  /** Zurich wall-clock time on day n as a UTC ISO string. */
  const at = async (n, time) => (await db.query(
    `select to_char((($1::date + $2::time) at time zone 'Europe/Zurich') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as t`,
    [day(n), time])).rows[0].t;
  return { db, as, alice, bob, carol, json, agent, reader, at };
}

const sameTimes = (a, b) => assert.deepEqual(a.map((t) => Date.parse(t)), b.map((t) => Date.parse(t)));

test('scheduling: an organizer adds a meeting that finds a time; the team fills in its times with names', async () => {
  const { alice, bob, carol, json, at } = await course();
  const grid = { days: [day(3), day(4)], from: '09:00', to: '12:00', slot_min: 30 };
  const added = await json(alice, `select public.add_meeting('widgetry', $1, $2)`,
    [JSON.stringify({ title: 'Exam préparation!', duration_min: 60 }), JSON.stringify(grid)]);
  assert.equal(added.id, `${day(3)}-exam-preparation`, 'id from the first day and the title');
  assert.equal(added.published, true, 'visible to the team at once');

  const listed = (await json(bob, `select public.get_course('widgetry')`)).schedules;
  assert.equal(listed.length, 1);
  assert.deepEqual({ ...listed[0], suggestion: undefined },
    { meeting: added.id, days: [day(3), day(4)], from: '09:00', to: '12:00', slot_min: 30, duration_min: 60,
      filled_in: 0, mine: false, suggestion: undefined });

  // Bob: free 9:00–10:30 on the first day and 9:00–10:00 on the second; a
  // slot outside the grid is left out.
  const mine = [await at(3, '09:00'), await at(3, '09:30'), await at(3, '10:00'), await at(4, '09:00'), await at(4, '09:30'),
    await at(3, '13:00')];
  const saved = await json(bob, `select public.save_availability('widgetry', $1, $2)`, [added.id, JSON.stringify(mine)]);
  sameTimes(saved.slots, mine.slice(0, 5));
  await alice(`select public.save_availability('widgetry', $1, $2)`, [added.id, JSON.stringify([await at(3, '09:30'), await at(3, '10:00')])]);

  const s = await json(bob, `select public.get_schedule('widgetry', $1)`, [added.id]);
  assert.equal(s.grid.length, 12, '2 days × 6 half hours');
  assert.equal(s.members, 2);
  assert.equal(s.filled_in, 2);
  assert.deepEqual(s.not_filled_in, []);
  assert.deepEqual(s.people.map((p) => p.login), ['alice', 'bob'], 'names, like when2meet');
  sameTimes(s.mine, mine.slice(0, 5));
  assert.equal(Date.parse(s.best[0].start), Date.parse(await at(3, '09:30')), 'both are free 9:30–10:30');
  assert.deepEqual(s.best[0].available, ['alice', 'bob']);
  assert.equal(s.best.length, 2, '9:00 on the first day is too close to 9:30');
  assert.equal(Date.parse(s.best[1].start), Date.parse(await at(4, '09:00')));
  assert.equal(s.best[1].free, 1);
  assert.deepEqual(s.best[1].missing, ['alice']);
  for (const b of s.best.slice(1)) {
    assert.ok(Math.abs(Date.parse(b.start) - Date.parse(s.best[0].start)) >= 120 * 60_000, 'best times don’t crowd each other');
  }
  assert.equal((await json(bob, `select public.get_course('widgetry')`)).schedules[0].mine, true);

  // Only organizers add meetings; strangers see nothing.
  await assert.rejects(bob(`select public.add_meeting('widgetry', '{"title": "Mine"}'::jsonb)`), /only organizers/);
  await assert.rejects(carol(`select public.get_schedule('widgetry', $1)`, [added.id]), /not on this course's team list/);
  await assert.rejects(carol(`select public.save_availability('widgetry', $1, '[]'::jsonb)`, [added.id]), /not on this course's team list/);
});

test('scheduling: picking a time sets it on the meeting and closes the grid', async () => {
  const { alice, bob, json, at } = await course();
  const { id } = await json(alice, `select public.add_meeting('widgetry', $1, $2)`,
    [JSON.stringify({ title: 'Retro', location_md: 'HG E 33' }), JSON.stringify({ days: [day(5)], from: '14:00', to: '17:00' })]);

  await assert.rejects(bob(`select public.pick_time('widgetry', $1, $2)`, [id, await at(5, '14:00')]), /only organizers/);
  await assert.rejects(alice(`select public.pick_time('widgetry', $1, $2)`, [id, await at(5, '16:30')]), /doesn't fit/,
    'a 60 minute meeting from 16:30 runs past 17:00');
  await assert.rejects(alice(`select public.pick_time('widgetry', $1, 'tomorrow')`, [id]), /not a time/);

  const picked = await json(alice, `select public.pick_time('widgetry', $1, $2)`, [id, await at(5, '15:00')]);
  assert.equal(picked.duration_min, 60);
  const meeting = (await json(bob, `select public.get_course('widgetry')`)).meetings.find((m) => m.id === id);
  assert.equal(Date.parse(meeting.details.content.starts_at), Date.parse(await at(5, '15:00')));
  assert.equal(meeting.details.content.location_md, 'HG E 33', 'the other details stay');
  assert.equal(meeting.details.saved_by, 'member:alice');
  assert.deepEqual((await json(bob, `select public.get_course('widgetry')`)).schedules, [], 'no longer looking for a time');
  await assert.rejects(bob(`select public.save_availability('widgetry', $1, '[]'::jsonb)`, [id]), /already has its time/);
  await assert.rejects(alice(`select public.pick_time('widgetry', $1, $2)`, [id, await at(5, '14:00')]), /already has its time/);

  // Cancelling a grid deletes it.
  const other = await json(alice, `select public.add_meeting('widgetry', '{"title": "Other"}'::jsonb, $1)`,
    [JSON.stringify({ days: [day(6)] })]);
  await assert.rejects(bob(`select public.cancel_schedule('widgetry', $1)`, [other.id]), /only organizers/);
  await alice(`select public.cancel_schedule('widgetry', $1)`, [other.id]);
  await assert.rejects(bob(`select public.get_schedule('widgetry', $1)`, [other.id]), /not looking for a time/);
});

test('scheduling: grids are checked (days ahead, at most 14, on the slot grid, the meeting fits)', async () => {
  const { alice, json } = await course();
  const add = (schedule, details = { title: 'X' }) => json(alice, `select public.add_meeting('widgetry', $1, $2)`,
    [JSON.stringify(details), JSON.stringify(schedule)]);
  await assert.rejects(add({ days: [day(-1)] }), /in the past/);
  await assert.rejects(add({ days: Array.from({ length: 15 }, (_, i) => day(i + 1)) }), /1 to 14 days/);
  await assert.rejects(add({ days: [day(1), day(1)] }), /listed twice/);
  await assert.rejects(add({ days: [day(1), day(40)] }), /within 4 weeks/);
  await assert.rejects(add({ days: ['2026-02-30'] }), /not a real date/);
  await assert.rejects(add({ days: [day(1)], from: '9:00' }), /not a time like 09:00/);
  await assert.rejects(add({ days: [day(1)], from: '18:00', to: '09:00' }), /must be before/);
  await assert.rejects(add({ days: [day(1)], from: '09:15' }), /on the slot grid/);
  await assert.rejects(add({ days: [day(1)], slot_min: 20 }), /15, 30 or 60/);
  await assert.rejects(add({ days: [day(1)], from: '09:00', to: '10:00', duration_min: 90 }), /must be a multiple of 30 and fit/);
  await assert.rejects(add({ days: [day(1)], hours: 3 }), /unknown key "hours"/);
  await assert.rejects(add({ days: [day(1)] }, { title: 'X', starts_at: '2026-12-01T10:00:00Z' }), /no starts_at yet/);
  // A fixed-time meeting needs no grid.
  const fixed = await json(alice, `select public.add_meeting('widgetry', $1)`,
    [JSON.stringify({ title: 'Fixed', starts_at: `${day(2)}T13:00:00Z` })]);
  assert.equal(fixed.id, `${day(2)}-fixed`);
  assert.equal(fixed.finding_a_time, false);
  const again = await json(alice, `select public.add_meeting('widgetry', $1)`,
    [JSON.stringify({ title: 'Fixed', starts_at: `${day(2)}T15:00:00Z` })]);
  assert.equal(again.id, `${day(2)}-fixed-2`, 'ids stay unique');
});

test('scheduling: the agent opens a grid, reads who is free (names), and only suggests a time', async () => {
  const { alice, bob, json, agent, reader, at } = await course();
  await agent(`select public.agent_create_meeting('planning', 'Planning', duration_min => 30)`);
  const opened = await agent(`select public.agent_open_scheduling('planning', $1, '10:00', '12:00')`, [JSON.stringify([day(2), day(3)])]);
  assert.equal(opened.duration_min, 30, 'the meeting’s length from its details');
  assert.equal(opened.published, false);
  assert.equal(opened.links.schedule, `${SITE}#/timeline?open=planning`);
  await assert.rejects(reader(`select public.agent_open_scheduling('planning', $1)`, [JSON.stringify([day(2)])]), /may only read/);
  await assert.rejects(agent(`select public.agent_open_scheduling('nope', $1)`, [JSON.stringify([day(2)])]), /no meeting "nope"/);

  // A draft's grid: organizers only; the agent is told to get it published.
  await assert.rejects(bob(`select public.get_schedule('widgetry', 'planning')`), /not looking for a time/);
  let due = (await agent(`select public.agent_due()`)).items.filter((i) => i.kind === 'schedule');
  assert.equal(due.length, 1);
  assert.equal(due[0].state, 'draft');
  await alice(`select public.set_published('widgetry', 'planning', true)`);
  due = (await agent(`select public.agent_due()`)).items.filter((i) => i.kind === 'schedule');
  assert.equal(due[0].state, 'due', 'first day is two days away or closer');
  assert.deepEqual(due[0].not_filled_in, ['alice', 'bob']);

  await bob(`select public.save_availability('widgetry', 'planning', $1)`, [JSON.stringify([await at(2, '10:00'), await at(3, '11:30')])]);
  const a = await reader(`select public.agent_get_availability('planning')`);
  assert.equal(a.filled_in, 1);
  assert.deepEqual(a.not_filled_in, ['alice']);
  assert.deepEqual(a.people, [{ login: 'bob', slots: a.people[0].slots }]);
  assert.deepEqual(a.slots.map((x) => x.available), [['bob'], ['bob']]);
  assert.equal(a.best.length, 2);

  // Changing the grid keeps the times that still exist.
  await agent(`select public.agent_open_scheduling('planning', $1, '10:00', '12:00')`, [JSON.stringify([day(3)])]);
  sameTimes((await agent(`select public.agent_get_availability('planning')`)).people[0].slots, [await at(3, '11:30')]);

  // A suggestion, not a pick.
  await assert.rejects(reader(`select public.agent_suggest_time('planning', $1)`, [await at(3, '11:30')]), /may only read/);
  await assert.rejects(agent(`select public.agent_suggest_time('planning', $1)`, [await at(3, '12:00')]), /doesn't fit/);
  const suggested = await agent(`select public.agent_suggest_time('planning', $1, 'Bob is free then.')`, [await at(3, '11:30')]);
  assert.equal(suggested.suggestion.by, 'OpenClaw');
  assert.equal(suggested.free_at.free, 1);
  const s = await json(bob, `select public.get_schedule('widgetry', 'planning')`);
  assert.equal(s.suggestion.note, 'Bob is free then.');
  assert.deepEqual(s.suggestion.free_at.available, ['bob']);
  assert.equal((await agent(`select public.agent_due()`)).items.find((i) => i.kind === 'schedule').state, 'suggested');
  const meeting = await agent(`select public.agent_get_meeting('planning')`);
  assert.equal(meeting.details.content.starts_at, undefined, 'the suggestion doesn’t set the time');

  await json(alice, `select public.pick_time('widgetry', 'planning', $1)`, [s.suggestion.starts_at]);
  assert.equal((await agent(`select public.agent_due()`)).items.filter((i) => i.kind === 'schedule').length, 0);
  await assert.rejects(agent(`select public.agent_suggest_time('planning', $1)`, [await at(3, '11:00')]), /already has its time/);
});

test('scheduling: times are hidden and deleted 30 days after the meeting; removed members drop out', async () => {
  const { db, alice, bob, json, agent, at } = await course();
  const { id } = await json(alice, `select public.add_meeting('widgetry', '{"title": "Old"}'::jsonb, $1)`,
    [JSON.stringify({ days: [day(1)] })]);
  await bob(`select public.save_availability('widgetry', $1, $2)`, [id, JSON.stringify([await at(1, '09:00')])]);
  await alice(`select public.remove_member('widgetry', 1002)`);
  const s = await json(alice, `select public.get_schedule('widgetry', $1)`, [id]);
  assert.equal(s.filled_in, 0, 'removed members don’t count');
  assert.deepEqual(s.people, []);
  await alice(`select public.add_member('widgetry', 1002, 'bob', 'Bob', false)`);

  await db.exec(`set role owner;
    update private.schedules set days = array[current_date - 40] where meeting_id = '${id}';
    update private.meetings set date = current_date - 40 where id = '${id}';
    reset role;`);
  await assert.rejects(alice(`select public.get_schedule('widgetry', $1)`, [id]), /not looking for a time/);
  await assert.rejects(agent(`select public.agent_get_availability($1)`, [id]), /not looking for a time/);
  assert.deepEqual((await json(alice, `select public.get_course('widgetry')`)).schedules, []);
  await db.exec('set role owner;');
  assert.equal((await db.query('select private.delete_old_availability() as n')).rows[0].n, 1);
  assert.equal((await db.query('select count(*)::int as n from private.availability')).rows[0].n, 0, 'everyone’s times are gone');
  await db.exec('reset role;');
});

test('scheduling: changing a grid keeps only real answers (review fixes)', async () => {
  const { alice, bob, json, agent, at } = await course();
  await agent(`select public.agent_create_meeting('move', 'Move', duration_min => 60)`);
  await alice(`select public.set_published('widgetry', 'move', true)`);
  await agent(`select public.agent_open_scheduling('move', $1, '09:00', '12:00')`, [JSON.stringify([day(2)])]);
  await bob(`select public.save_availability('widgetry', 'move', $1)`, [JSON.stringify([await at(2, '10:00')])]);
  await alice(`select public.save_availability('widgetry', 'move', '[]'::jsonb)`); // "no time works" stays an answer

  // Other days: Bob's times are all gone, so he has to answer again.
  await agent(`select public.agent_open_scheduling('move', $1, '09:00', '12:00')`, [JSON.stringify([day(3)])]);
  let s = await json(bob, `select public.get_schedule('widgetry', 'move')`);
  assert.equal(s.filled_in, 1, 'only Alice’s deliberate "nothing works" remains');
  assert.deepEqual(s.not_filled_in, ['bob']);
  assert.equal(s.mine, null);
  assert.equal((await json(bob, `select public.get_course('widgetry')`)).schedules[0].mine, false, '"Add your times" again');
  assert.equal((await agent(`select public.agent_due()`)).items.find((i) => i.kind === 'schedule').not_filled_in[0], 'bob');

  // A new slot length starts everyone afresh (a 30-minute mark doesn't cover an hour).
  await bob(`select public.save_availability('widgetry', 'move', $1)`, [JSON.stringify([await at(3, '10:00')])]);
  await agent(`select public.agent_open_scheduling('move', $1, '09:00', '12:00', 60)`, [JSON.stringify([day(3)])]);
  s = await json(bob, `select public.get_schedule('widgetry', 'move')`);
  assert.equal(s.filled_in, 0);
  assert.deepEqual(s.best, []);

  // Durations written as 90.0 (as some JSON libraries do) work.
  await agent(`select public.agent_update_meeting('move', 1, '{"title": "Move", "duration_min": 90.0}'::jsonb)`);
  const reopened = await agent(`select public.agent_open_scheduling('move', $1, '09:00', '12:00')`, [JSON.stringify([day(3)])]);
  assert.equal(reopened.duration_min, 90);
  const added = await json(alice, `select public.add_meeting('widgetry', '{"title": "Long", "duration_min": 120.0}'::jsonb, $1)`,
    [JSON.stringify({ days: [day(2)], slot_min: 30.0 })]);
  assert.equal((await json(alice, `select public.get_schedule('widgetry', $1)`, [added.id])).duration_min, 120);
  await assert.rejects(json(alice, `select public.add_meeting('widgetry', '{"title": "X"}'::jsonb, $1)`,
    [JSON.stringify({ days: [day(2)], slot_min: 'thirty' })]), /15, 30 or 60/);
});

test('scheduling: a grid nobody picks a time for is hidden and deleted 30 days after its last day', async () => {
  const { db, alice, bob, json, at } = await course();
  const { id } = await json(alice, `select public.add_meeting('widgetry', '{"title": "Never picked"}'::jsonb, $1)`,
    [JSON.stringify({ days: [day(1)] })]);
  await bob(`select public.save_availability('widgetry', $1, $2)`, [id, JSON.stringify([await at(1, '09:00')])]);
  // Its day passes: no longer listed as open (nothing left to pick) …
  await db.exec(`set role owner; update private.schedules set days = array[current_date - 2] where meeting_id = '${id}'; reset role;`);
  assert.deepEqual((await json(alice, `select public.get_course('widgetry')`)).schedules, []);
  // … and 31 days later it is gone, although part 3's placeholder date (created + 60 days) is still ahead.
  await db.exec(`set role owner; update private.schedules set days = array[current_date - 31] where meeting_id = '${id}'; reset role;`);
  const placeholder = (await db.query(`select date > current_date as later from private.meetings where id = $1`, [id])).rows[0].later;
  assert.equal(placeholder, true, 'the meeting’s date is still the placeholder');
  await assert.rejects(alice(`select public.get_schedule('widgetry', $1)`, [id]), /not looking for a time/);
  await db.exec('set role owner;');
  assert.equal((await db.query('select private.delete_old_availability() as n')).rows[0].n, 1);
  await db.exec('reset role;');
});
