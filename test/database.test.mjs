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
    await denied(role, 'select * from private.members');
    await denied(role, 'select * from private.courses');
    await denied(role, `select public.hook_before_user_created('{}'::jsonb)`);
  }
  await denied('authenticated', 'select public.keepalive()');
  await denied('anon', `select public.is_member('demo')`);
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
  };
  for (const [fn, allowed] of Object.entries(expected)) {
    for (const role of ['anon', 'authenticated', 'service_role', 'supabase_auth_admin']) {
      assert.equal(await may(role, fn), allowed.includes(role), `${role} execute ${fn}`);
    }
  }
  // Every function in "private" is closed to visitors unless listed above.
  const privateFns = await db.query(`select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'`);
  for (const { fn } of privateFns.rows) {
    if (!(fn in expected)) assert.equal(await may('anon', fn), false, `anon execute ${fn}`);
    assert.ok(fn in expected, `new private function ${fn}: add it to the expected permissions above`);
  }

  // Nothing else is reachable through the API (functions in "public").
  const fns = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`);
  assert.deepEqual(fns.rows.map((x) => x.proname), ['hook_before_user_created', 'is_member', 'keepalive', 'sync_course']);
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
