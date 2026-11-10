// Database tests: runs every file in supabase/migrations/ in PGlite (Postgres
// compiled to WebAssembly) with a small imitation of Supabase: the API roles,
// an auth schema, the default privileges on "public", and a non-superuser
// owner role that runs the setup (like "postgres" in the SQL Editor).
// Then checks who may do what.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const migrations = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'));

const ALICE = '00000000-0000-0000-0000-000000000001'; // GitHub 1001
const BOB = '00000000-0000-0000-0000-000000000002'; // GitHub 1002
const EMAIL_ONLY = '00000000-0000-0000-0000-000000000003'; // email identity with "1001"
const TWO_ACCOUNTS = '00000000-0000-0000-0000-000000000004'; // GitHub 2001 and 1001 (linked)
const REPO = 555;

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create role supabase_auth_admin nologin;
    create role owner nologin bypassrls;  -- plays Supabase's "postgres" (not a superuser)
    revoke all on schema public from public;
    alter schema public owner to owner;
    grant create on database postgres to owner;
    grant anon, authenticated, service_role to owner;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role owner in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role owner in schema public grant all on functions to anon, authenticated, service_role;

    create schema auth;
    create table auth.identities (user_id uuid, provider text, provider_id text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role, owner;
    grant execute on function auth.uid() to anon, authenticated, service_role, owner;
    grant select on auth.identities to owner;
    insert into auth.identities values
      ('${ALICE}', 'github', '1001'),
      ('${BOB}', 'github', '1002'),
      ('${EMAIL_ONLY}', 'email', '1001'),
      ('${TWO_ACCOUNTS}', 'github', '2001'),
      ('${TWO_ACCOUNTS}', 'github', '1001');
  `);
  await db.exec('set role owner;');
  for (const sql of migrations) await db.exec(sql);
  for (const sql of migrations) await db.exec(sql); // safe to run twice
  await db.exec('reset role;');
  return db;
}

function actor(db) {
  return async function as(role, sql, params = [], uid = '') {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role ${role};`);
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.exec('reset role;');
    }
  };
}

const members = (...list) => JSON.stringify(list.map(([id, login]) => ({ github_id: id, github_login: login })));

test('database: the deploy workflow keeps each course\'s team list', async () => {
  const db = await setup();
  const as = actor(db);
  const sync = (course, list, repo = REPO) => as('service_role',
    'select public.sync_course($1, $2::jsonb, $3, $4) as r', [course, list, repo, `owner/repo-${repo}`]).then((rows) => rows[0].r);

  assert.deepEqual(await sync('demo', members([1001, 'alice'], [1002, 'bob'], [1002, 'bob'])),
    { course: 'demo', members: 2, added: 2, removed: 0 });
  assert.deepEqual(await sync('demo', members([1001, 'Alice'])), { course: 'demo', members: 1, added: 0, removed: 1 });
  await sync('other', '[]');

  // Another repository can't take over a course id.
  await assert.rejects(sync('demo', members([1002, 'bob']), 777), /already belongs to repository owner\/repo-555/);
  // Released by hand, it can.
  await db.exec(`update private.courses set repo_id = null where id = 'other'`);
  await sync('other', '[]', 777);

  // A known username that now resolves to a different account is refused,
  // also when the member stays on the list under their new name.
  await assert.rejects(sync('demo', members([9999, 'alice'])), /"Alice" now belongs to a different account \(id 9999\)/);
  await assert.rejects(sync('demo', members([9999, 'alice'], [1002, 'bob'])), /different account/);
  await assert.rejects(sync('demo', members([1001, 'alice-renamed'], [9999, 'alice'])), /don't keep both/);
  // A rename (same id, new name) is fine.
  assert.deepEqual(await sync('demo', members([1001, 'alice-renamed'])), { course: 'demo', members: 1, added: 0, removed: 0 });
  // Removing a username and adding it back later is the deliberate way.
  assert.deepEqual(await sync('demo', members([1001, 'alice-renamed'], [9999, 'alice'])),
    { course: 'demo', members: 2, added: 1, removed: 0 });
  // Two members swapping usernames is fine.
  assert.deepEqual(await sync('demo', members([1001, 'alice'], [9999, 'alice-renamed'])),
    { course: 'demo', members: 2, added: 0, removed: 0 });
  // But a member can't take over another member's old name while that member
  // silently drops off the list.
  await assert.rejects(sync('demo', members([9999, 'alice'])), /different account/);

  await assert.rejects(sync('Bad Id', '[]'), /invalid course id/);
  await assert.rejects(sync('demo', '[{"github_id": "1"}]'), /github_id/);
  await assert.rejects(sync('demo', '[{"github_id": 1.5, "github_login": "x"}]'), /github_id/);
  await assert.rejects(sync('demo', '{}'), /array/);
  await assert.rejects(as('service_role', `select public.sync_course('demo', '[]'::jsonb, null, 'x')`), /repository/);
});

test('database: only team members count as members, by GitHub account id', async () => {
  const db = await setup();
  const as = actor(db);
  await as('service_role', 'select public.sync_course($1, $2::jsonb, $3, $4)', ['demo', members([1001, 'alice']), REPO, 'o/r']);
  await as('service_role', 'select public.sync_course($1, $2::jsonb, $3, $4)', ['other', members([1002, 'bob']), REPO + 1, 'o/r2']);
  const isMember = async (uid, course = 'demo') => (await as('authenticated', 'select public.is_member($1) as m', [course], uid))[0].m;

  assert.equal(await isMember(ALICE), true);
  assert.equal(await isMember(ALICE, 'other'), false);
  assert.equal(await isMember(BOB), false);
  assert.equal(await isMember(BOB, 'other'), true);
  assert.equal(await isMember(EMAIL_ONLY), false, 'a non-GitHub identity with the same id does not count');
  assert.equal(await isMember(TWO_ACCOUNTS), true, 'any of the person\'s linked GitHub accounts counts');
  assert.equal(await isMember(''), false, 'nobody signed in');
});

test('database: visitors can\'t read or change anything they shouldn\'t', async () => {
  const db = await setup();
  const as = actor(db);
  await as('service_role', 'select public.sync_course($1, $2::jsonb, $3, $4)', ['demo', members([1001, 'alice']), REPO, 'o/r']);
  const denied = (role, sql, uid = ALICE) =>
    assert.rejects(as(role, sql, [], uid), /permission denied/, `${role} should be denied: ${sql}`);

  for (const role of ['anon', 'authenticated']) {
    await denied(role, `select public.sync_course('demo', '[]'::jsonb, 1, 'x')`);
    await denied(role, `select public.sync_meetings('demo', 1, '[]'::jsonb)`);
    await denied(role, 'select * from private.members');
    await denied(role, 'select * from private.courses');
    await denied(role, 'select * from private.meetings');
    await denied(role, 'select * from private.answers');
    await denied(role, 'select private.delete_old_answers()');
    await denied(role, `select public.hook_before_user_created('{}'::jsonb)`);
  }
  await denied('authenticated', 'select public.keepalive()');
  await denied('anon', `select public.is_member('demo')`);
  await denied('anon', `select public.save_answer('demo', 'm', 'q', '{}'::jsonb)`);
  await denied('anon', `select * from public.get_answers('demo', 'm', true)`);
  await denied('anon', `select private.is_member('demo')`);
  await denied('anon', 'delete from private.heartbeat');
  await denied('supabase_auth_admin', `select public.sync_course('demo', '[]'::jsonb, 1, 'x')`);
  await denied('supabase_auth_admin', 'delete from private.members');

  // The keep-alive works with the publishable key (anon) and only touches its row.
  const [beat] = await as('anon', 'select public.keepalive() as t');
  assert.ok(beat.t);
  await as('anon', 'select public.keepalive()');
  await assert.rejects(as('anon', 'insert into private.heartbeat (id) values (2)'), /row-level security|check constraint|permission denied/);

  // Function permissions, checked directly (a call can also fail one layer
  // deeper, which would hide a missing revoke).
  const may = async (role, fn) => (await db.query(`select has_function_privilege($1, $2, 'execute') as ok`, [role, fn])).rows[0].ok;
  const expected = {
    'public.is_member(text)': ['authenticated', 'service_role'],
    'private.is_member(text)': ['authenticated'],
    'public.sync_course(text, jsonb, bigint, text)': ['service_role'],
    'public.keepalive()': ['anon', 'service_role'],
    'public.hook_before_user_created(jsonb)': ['supabase_auth_admin'],
    'private.member_github_id(text)': [],
    'private.answers_expired(date)': ['service_role'],
    'private.save_answer(text, text, text, jsonb)': ['authenticated'],
    'private.get_answers(text, text, boolean)': ['authenticated'],
    'private.delete_old_answers()': [],
    'public.save_answer(text, text, text, jsonb)': ['authenticated', 'service_role'],
    'public.get_answers(text, text, boolean)': ['authenticated', 'service_role'],
    'public.sync_meetings(text, bigint, jsonb)': ['service_role'],
  };
  for (const [fn, allowed] of Object.entries(expected)) {
    for (const role of ['anon', 'authenticated', 'service_role', 'supabase_auth_admin']) {
      assert.equal(await may(role, fn), allowed.includes(role), `${role} execute ${fn}`);
    }
  }
  // Every function in "private" is closed to visitors unless listed above.
  const privateFns = await db.query(`select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'`);
  const listed = new Set(Object.keys(expected).map((fn) => fn.replaceAll(' ', '')));
  for (const { fn } of privateFns.rows) {
    if (!listed.has(fn)) assert.equal(await may('anon', fn), false, `anon execute ${fn}`);
    assert.ok(listed.has(fn), `new private function ${fn}: add it to the expected permissions above`);
  }

  // Nothing else is reachable through the API (functions in "public").
  const fns = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`);
  assert.deepEqual(fns.rows.map((x) => x.proname),
    ['get_answers', 'hook_before_user_created', 'is_member', 'keepalive', 'save_answer', 'sync_course', 'sync_meetings']);
  const tables = await db.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`);
  assert.equal(tables.rows[0].n, 0, 'no tables in the API schema');
});

test('database: only people on a team list can create an account', async () => {
  const db = await setup();
  const as = actor(db);
  await as('service_role', 'select public.sync_course($1, $2::jsonb, $3, $4)', ['demo', members([1001, 'alice']), REPO, 'o/r']);
  const hook = async (provider, id) => (await as('supabase_auth_admin', 'select public.hook_before_user_created($1::jsonb) as r',
    [JSON.stringify({ user: { app_metadata: { provider }, user_metadata: { provider_id: id } } })]))[0].r;

  assert.deepEqual(await hook('github', '1001'), {});
  for (const [provider, id] of [['github', '1002'], ['github', '9999'], ['email', '1001'], ['github', '1001 or 1=1'], ['github', null], ['github', '01001x']]) {
    assert.equal((await hook(provider, id)).error?.http_code, 403, `rejected: ${provider} ${id}`);
  }
});

// ---------------------------------------------------------------- survey answers

const CAROL = '00000000-0000-0000-0000-000000000005'; // GitHub 1003
const OUTSIDER = '00000000-0000-0000-0000-000000000006'; // GitHub 4004, on no list

function isoDay(offset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const QUESTIONS = {
  grace: [
    { id: 'preference', type: 'single', options: ['None', '1 hour', '24 hours'], required: true },
    { id: 'reason', type: 'text', options: [], required: false },
  ],
  extras: [{ id: 'which', type: 'multiple', options: ['A', 'B', 'C'], required: false }],
};

async function surveySetup({ reveal = 'anytime', anonymous = false, date = isoDay(7) } = {}) {
  const db = await setup();
  await db.exec(`insert into auth.identities values ('${CAROL}', 'github', '1003'), ('${OUTSIDER}', 'github', '4004');`);
  const as = actor(db);
  await as('service_role', 'select public.sync_course($1, $2::jsonb, $3, $4)',
    ['demo', members([1001, 'alice'], [1002, 'bob'], [1003, 'carol']), REPO, 'o/r']);
  const meetings = JSON.stringify([
    { id: 'm1', date, reveal, anonymous, questions: QUESTIONS },
    { id: 'plain', date, reveal: 'anytime', anonymous: false, questions: {} },
  ]);
  await as('service_role', 'select public.sync_meetings($1, $2, $3::jsonb)', ['demo', REPO, meetings]);
  const save = (uid, question, answer, meeting = 'm1') => as('authenticated',
    'select public.save_answer($1, $2, $3, $4::jsonb) as at', ['demo', meeting, question, JSON.stringify(answer)], uid)
    .then((rows) => rows[0].at);
  const read = (uid, others, meeting = 'm1') => as('authenticated',
    'select * from public.get_answers($1, $2, $3)', ['demo', meeting, others], uid);
  return { db, as, save, read };
}

test('answers: team members save, change and remove their own answer, checked against the survey', async () => {
  const { save, read, db } = await surveySetup();
  assert.ok(await save(ALICE, 'grace', { preference: '1 hour', reason: '  uploads fail  ' }));
  assert.ok(await save(ALICE, 'grace', { preference: '24 hours' }), 'changing is allowed');
  assert.ok(await save(ALICE, 'extras', { which: ['A', 'C'] }));
  let mine = await read(ALICE, false);
  assert.deepEqual(mine.map((r) => [r.question_id, r.answer, r.mine, r.github_login]),
    [['extras', { which: ['A', 'C'] }, true, 'alice'], ['grace', { preference: '24 hours' }, true, 'alice']]);

  // Removing: an answer with every field empty.
  assert.equal(await save(ALICE, 'extras', { which: [] }), null);
  assert.equal(await save(ALICE, 'grace', {}), null);
  assert.deepEqual(await read(ALICE, false), []);

  const bad = [
    [{ preference: 'Two weeks' }, /must be one of its options/],
    [{ preference: ['1 hour'] }, /must be one of its options/],
    [{ reason: 'only a reason' }, /required field\(s\): preference/],
    [{ preference: '1 hour', reason: 5 }, /needs text/],
    [{ preference: '1 hour', reason: 'x'.repeat(4001) }, /longer than 4000/],
    [{ preference: '1 hour', colour: 'blue' }, /unknown survey field "colour"/],
  ];
  for (const [answer, message] of bad) await assert.rejects(save(ALICE, 'grace', answer), message, JSON.stringify(answer));
  await assert.rejects(save(ALICE, 'extras', { which: ['A', 'A'] }), /list of different options/);
  await assert.rejects(save(ALICE, 'extras', { which: 'A' }), /list of different options/);
  await assert.rejects(save(ALICE, 'nope', { x: 1 }), /no survey/);
  await assert.rejects(save(ALICE, 'grace', { preference: 'None' }, 'plain'), /no survey/);
  await assert.rejects(save(ALICE, 'grace', { preference: 'None' }, 'unknown-meeting'), /no survey \(yet\)/);
  await assert.rejects(as(db)('authenticated', `select public.save_answer('demo', 'm1', 'grace', '[]'::jsonb)`, [], ALICE), /JSON object/);

  // Not on the list, or not signed in.
  await assert.rejects(save(OUTSIDER, 'grace', { preference: 'None' }), /not on this course's team list/);
  await assert.rejects(save('', 'grace', { preference: 'None' }), /not on this course's team list/);
  await assert.rejects(read(OUTSIDER, true), /not on this course's team list/);
  await assert.rejects(save(ALICE, 'grace', { preference: 'None' }).then(() =>
    as(db)('authenticated', `select public.save_answer('other', 'm1', 'grace', '{"preference":"None"}'::jsonb)`, [], ALICE)), /team list/);
});

function as(db) {
  return actor(db);
}

test('answers: reveal "anytime" shows everyone\'s answers with names', async () => {
  const { save, read } = await surveySetup({ reveal: 'anytime' });
  await save(BOB, 'grace', { preference: 'None', reason: 'strict' });
  await save(ALICE, 'grace', { preference: '1 hour' });
  assert.deepEqual((await read(CAROL, false)), [], 'without asking, only your own');
  const all = await read(CAROL, true);
  assert.deepEqual(all.map((r) => [r.github_login, r.mine, Boolean(r.updated_at)]), [['alice', false, true], ['bob', false, true]]);
  const alice = await read(ALICE, true);
  assert.deepEqual(alice.map((r) => [r.github_login, r.mine]), [['alice', true], ['bob', false]], 'own answer first');
});

test('answers: reveal "after_answering" shows others only for questions you answered', async () => {
  const { save, read } = await surveySetup({ reveal: 'after_answering' });
  await save(BOB, 'grace', { preference: 'None' });
  await save(BOB, 'extras', { which: ['B'] });
  assert.deepEqual(await read(CAROL, true), [], 'nothing before answering');
  await save(CAROL, 'grace', { preference: '24 hours' });
  const seen = await read(CAROL, true);
  assert.deepEqual(seen.map((r) => [r.question_id, r.github_login]), [['grace', 'carol'], ['grace', 'bob']]);
  await save(CAROL, 'grace', {});
  assert.deepEqual(await read(CAROL, true), [], 'removing your answer hides the others again');
});

test('answers: anonymous meetings hide names and times of others, and their order', async () => {
  const { save, read } = await surveySetup({ anonymous: true });
  await save(BOB, 'grace', { preference: 'None' });
  await save(CAROL, 'grace', { preference: '24 hours' });
  await save(ALICE, 'grace', { preference: '1 hour' });
  const rows = await read(ALICE, true);
  assert.equal(rows[0].mine, true);
  assert.equal(rows[0].github_login, 'alice', 'you still see your own name');
  for (const r of rows.slice(1)) {
    assert.equal(r.github_login, null);
    assert.equal(r.updated_at, null);
  }
  const order = rows.slice(1).map((r) => r.answer.preference);
  const byHash = [...order].sort((a, b) => {
    const h = (x) => createHash('md5').update(JSON.stringify({ preference: x }).replace(':', ': ')).digest('hex');
    return h(a).localeCompare(h(b));
  });
  assert.deepEqual(order, byHash, 'ordered by the answer, not by who or when');
});

test('answers: removed members\' answers are hidden; answers expire 30 days after the meeting', async () => {
  const { save, read, as: run, db } = await surveySetup({ date: isoDay(-29) });
  await save(BOB, 'grace', { preference: 'None' });
  await save(ALICE, 'grace', { preference: '1 hour' });
  await run('service_role', 'select public.sync_course($1, $2::jsonb, $3, $4)', ['demo', members([1001, 'alice'], [1003, 'carol']), REPO, 'o/r']);
  assert.deepEqual((await read(ALICE, true)).map((r) => r.github_login), ['alice'], 'bob is no longer on the team');

  // Move the meeting to 31 days ago: answers are hidden, can't be saved, and get deleted.
  const old = JSON.stringify([{ id: 'm1', date: isoDay(-31), reveal: 'anytime', anonymous: false, questions: QUESTIONS }]);
  const [{ r }] = await run('service_role', 'select public.sync_meetings($1, $2, $3::jsonb) as r', ['demo', REPO, old]);
  assert.deepEqual(r, { course: 'demo', meetings: 1, deleted_answers: 2, kept_anonymous: [] });
  assert.deepEqual(await read(ALICE, true), []);
  await assert.rejects(save(ALICE, 'grace', { preference: 'None' }), /deleted 30 days after/);
  const left = await db.query('select count(*)::int as n from private.answers');
  assert.equal(left.rows[0].n, 0);
});

test('answers: once a meeting is anonymous, it stays anonymous', async () => {
  const { save, read, as: run } = await surveySetup({ anonymous: true });
  await save(BOB, 'grace', { preference: 'None', reason: 'the TA is unfair' });
  const resync = (anonymous) => run('service_role', 'select public.sync_meetings($1, $2, $3::jsonb) as r',
    ['demo', REPO, JSON.stringify([{ id: 'm1', date: isoDay(7), reveal: 'anytime', anonymous, questions: QUESTIONS }])]);
  const [{ r }] = await resync(false);
  assert.deepEqual(r.kept_anonymous, ['m1'], 'the deploy is told the setting was kept');
  await save(CAROL, 'grace', { preference: '1 hour' });
  const rows = await read(ALICE, true);
  assert.ok(rows.every((x) => x.github_login === null && x.updated_at === null), 'no names, so nobody can be found by elimination');

  // Switching anonymity on later hides the names of earlier answers too.
  const second = await surveySetup({ anonymous: false });
  await second.save(BOB, 'grace', { preference: 'None' });
  await second.as('service_role', 'select public.sync_meetings($1, $2, $3::jsonb)',
    ['demo', REPO, JSON.stringify([{ id: 'm1', date: isoDay(7), reveal: 'anytime', anonymous: true, questions: QUESTIONS }])]);
  assert.deepEqual((await second.read(ALICE, true)).map((x) => x.github_login), [null]);
});

test('answers: removing your answer works even after its survey was removed', async () => {
  const { save, read, as: run } = await surveySetup();
  await save(ALICE, 'extras', { which: ['A'] });
  await run('service_role', 'select public.sync_meetings($1, $2, $3::jsonb)',
    ['demo', REPO, JSON.stringify([{ id: 'm1', date: isoDay(7), reveal: 'anytime', anonymous: false, questions: {} }])]);
  await assert.rejects(save(ALICE, 'extras', { which: ['A'] }), /no survey/);
  assert.equal(await save(ALICE, 'extras', {}), null);
  assert.deepEqual(await read(ALICE, false), []);
});

test('answers: a deploy deletes only its own course\'s expired answers', async () => {
  const { save, as: run, db } = await surveySetup({ date: isoDay(-20) });
  await save(ALICE, 'grace', { preference: 'None' });
  // A second course (another repository) with one expired answer.
  await run('service_role', 'select public.sync_course($1, $2::jsonb, $3, $4)', ['other', members([1001, 'alice']), REPO + 1, 'o/r2']);
  await run('service_role', 'select public.sync_meetings($1, $2, $3::jsonb)',
    ['other', REPO + 1, JSON.stringify([{ id: 'old', date: isoDay(-20), reveal: 'anytime', anonymous: false, questions: QUESTIONS }])]);
  await as(db)('authenticated', `select public.save_answer('other', 'old', 'grace', '{"preference":"None"}'::jsonb)`, [], ALICE);
  await db.exec(`update private.meetings set date = current_date - 40 where course_id = 'other'`);
  const [{ r }] = await run('service_role', 'select public.sync_meetings($1, $2, $3::jsonb) as r',
    ['demo', REPO, JSON.stringify([{ id: 'm1', date: isoDay(-20), reveal: 'anytime', anonymous: false, questions: QUESTIONS }])]);
  assert.equal(r.deleted_answers, 0, 'the other course\'s answer is not counted or deleted here');
  assert.equal((await db.query(`select count(*)::int as n from private.answers where course_id = 'other'`)).rows[0].n, 1);
  assert.equal((await db.query('select private.delete_old_answers() as n')).rows[0].n, 1, 'the nightly job deletes it');
});

test('answers: the deploy\'s meeting sync checks its input and the course owner', async () => {
  const { as: run } = await surveySetup();
  const sync = (meetings, repo = REPO, course = 'demo') =>
    run('service_role', 'select public.sync_meetings($1, $2, $3::jsonb) as r', [course, repo, JSON.stringify(meetings)]);
  const ok = { id: 'm2', date: '2026-12-01', reveal: 'anytime', anonymous: false, questions: {} };
  assert.deepEqual((await sync([ok]))[0].r.meetings, 1);
  await assert.rejects(sync([ok], 777), /belongs to another repository/);
  await assert.rejects(sync([ok], REPO, 'nobody'), /no team list yet/);
  for (const bad of [
    { ...ok, id: 'Bad' }, { ...ok, date: '1.12.2026' }, { ...ok, reveal: 'later' }, { ...ok, anonymous: 'no' },
    { ...ok, questions: [] }, { ...ok, questions: { q: {} } },
    { ...ok, questions: { q: [{ id: 'f', type: 'scale', options: [], required: false }] } },
    { ...ok, questions: { q: [{ id: 'f', type: 'single', options: [1], required: false }] } },
    { ...ok, questions: { q: [{ id: 'f', type: 'single', options: ['a'] }] } },
  ]) {
    await assert.rejects(sync([bad]), /each (meeting|survey field) needs/, JSON.stringify(bad));
  }
  await assert.rejects(sync({}), /array/);
});
