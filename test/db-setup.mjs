// Shared setup for the database tests: runs every file in supabase/migrations/
// in PGlite (Postgres compiled to WebAssembly) with a small imitation of
// Supabase: the API roles, an auth schema, the default privileges on "public",
// and a non-superuser owner role that runs the setup (like "postgres" in the
// SQL Editor).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const migrations = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'));

export const ALICE = '00000000-0000-0000-0000-000000000001'; // GitHub 1001
export const BOB = '00000000-0000-0000-0000-000000000002'; // GitHub 1002
export const EMAIL_ONLY = '00000000-0000-0000-0000-000000000003'; // email identity with "1001"
export const TWO_ACCOUNTS = '00000000-0000-0000-0000-000000000004'; // GitHub 2001 and 1001 (linked)
export const REPO = 555;

export async function setup() {
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

export function actor(db) {
  // headers: the request headers PostgREST would pass on (e.g. x-agent-key).
  return async function as(role, sql, params = [], uid = '', headers = null) {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`,
      [uid, headers ? JSON.stringify(headers) : '']);
    await db.exec(`reset role; set role ${role};`);
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.exec('reset role;');
    }
  };
}
