-- meeting-engine database setup, part 1: team members and sign-in.
--
-- How to run it: Supabase dashboard → SQL Editor → New query → paste this
-- whole file → Run. Supabase may warn about "destructive operations" (the file
-- replaces its own rules and functions): that's expected, run it anyway.
-- Running it again is safe (it only adds what's missing and replaces the
-- functions).
--
-- What it sets up:
--   private.courses, private.members   one row per course site, and its team
--                                      members (by numeric GitHub account id).
--                                      Written only by the deploy workflow.
--   public.is_member(course)           "is the signed-in person on this team?"
--   public.sync_course(...)            used by the deploy workflow (secret key)
--   public.keepalive()                 used by the daily keep-alive workflow
--   public.hook_before_user_created    lets only people on a team list create
--                                      an account (switched on in the dashboard)
--
-- Security model: tables live in the "private" schema, which the website's API
-- doesn't expose. Visitors can only call the functions granted to them below.

create schema if not exists private;
revoke all on schema private from public;
-- Note for later setup parts: signed-in users and the keep-alive have USAGE on
-- this schema, and Postgres lets everyone run new functions by default, so
-- every function created in "private" must revoke execute from public.

-- ---------------------------------------------------------------- tables

-- One row per course site. repo_id is the numeric id of the GitHub repository
-- whose deploys own this course: another repository's deploy can't replace its
-- team list, even with the same course_id.
create table if not exists private.courses (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  repo_id bigint check (repo_id > 0),
  repo_name text,
  synced_at timestamptz not null default now()
);

create table if not exists private.members (
  course_id text not null references private.courses (id) on delete cascade,
  github_id bigint not null check (github_id > 0),
  github_login text not null,
  primary key (course_id, github_id)
);
create index if not exists members_github_id_idx on private.members (github_id);

create table if not exists private.heartbeat (
  id int primary key default 1 check (id = 1),
  beat_at timestamptz not null default now()
);

-- Row level security on, so only the policies below (and the secret key,
-- which bypasses RLS) give access.
alter table private.courses enable row level security;
alter table private.members enable row level security;
alter table private.heartbeat enable row level security;

revoke all on table private.courses, private.members, private.heartbeat from public, anon, authenticated;

-- ---------------------------------------------------------------- who is signed in

-- Is the signed-in person on the team list of course p_course?
-- Their GitHub account ids come from auth.identities, which only Supabase Auth
-- writes (unlike user_metadata, which users can change). Numeric ids never
-- change, unlike usernames. Also used by the access rules of later setup parts.
create or replace function private.is_member(p_course text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.members m
    join auth.identities i
      on i.provider = 'github'
     and i.provider_id ~ '^[0-9]{1,18}$'
     and i.provider_id::bigint = m.github_id
    where m.course_id = p_course
      and i.user_id = (select auth.uid())
  )
$$;

-- The website calls this one (POST /rest/v1/rpc/is_member).
create or replace function public.is_member(p_course text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.is_member(p_course)
$$;

revoke all on function private.is_member(text) from public, anon;
revoke all on function public.is_member(text) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_member(text) to authenticated;
grant execute on function public.is_member(text) to authenticated;

-- ---------------------------------------------------------------- deploy workflow

-- Replaces the team list of one course. Called by the deploy workflow with the
-- secret key. p_members is [{"github_id": 123, "github_login": "name"}, ...];
-- p_repo_id / p_repo_name identify the GitHub repository that deploys it.
create or replace function public.sync_course(
  p_course text,
  p_members jsonb,
  p_repo_id bigint,
  p_repo_name text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ids bigint[];
  v_owner bigint;
  v_owner_name text;
  v_conflict record;
  v_added int;
  v_removed int;
begin
  if p_course is null or p_course !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'invalid course id: %', p_course;
  end if;
  if p_repo_id is null or p_repo_id <= 0 then
    raise exception 'p_repo_id must be the numeric id of the GitHub repository';
  end if;
  if jsonb_typeof(p_members) is distinct from 'array' then
    raise exception 'p_members must be a JSON array';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_members) m
    where jsonb_typeof(m -> 'github_id') is distinct from 'number'
       or (m ->> 'github_id')::numeric <= 0
       or (m ->> 'github_id')::numeric <> trunc((m ->> 'github_id')::numeric)
       or coalesce(m ->> 'github_login', '') = ''
  ) then
    raise exception 'each member needs a positive whole "github_id" and a "github_login"';
  end if;

  -- The course belongs to the repository that first synced it.
  select c.repo_id, c.repo_name into v_owner, v_owner_name
    from private.courses c where c.id = p_course
    for update;
  if found and v_owner is not null and v_owner <> p_repo_id then
    raise exception 'course id "%" already belongs to repository % (id %). Choose another course_id in course.yml, or, if that repository was replaced, release the course first in the SQL Editor: update private.courses set repo_id = null where id = %;',
      p_course, v_owner_name, v_owner, quote_literal(p_course);
  end if;

  select coalesce(array_agg(distinct (m ->> 'github_id')::bigint), '{}')
    into v_ids
    from jsonb_array_elements(p_members) m;

  -- A username that is already on this team must still belong to the same
  -- GitHub account. The only exception is members swapping usernames: the
  -- name's new owner is already a member, and its old owner stays on the list.
  -- Otherwise the member renamed their account and someone else took the old
  -- name: refuse, instead of letting a stranger in or dropping the member.
  select m.github_login, m.github_id as old_id, (x ->> 'github_id')::bigint as new_id
    into v_conflict
    from private.members m
    join jsonb_array_elements(p_members) x
      on lower(x ->> 'github_login') = lower(m.github_login)
    where m.course_id = p_course
      and m.github_id <> (x ->> 'github_id')::bigint
      and not (
        m.github_id = any (v_ids)
        and exists (
          select 1 from private.members k
          where k.course_id = p_course and k.github_id = (x ->> 'github_id')::bigint
        )
      )
    limit 1;
  if found then
    raise exception 'the GitHub username "%" now belongs to a different account (id %) than the team member who was added with it (id %). If the member renamed their account, replace the old username with the new one in members (don''t keep both). If the new account really is the right person, remove the username, deploy, then add it again.',
      v_conflict.github_login, v_conflict.new_id, v_conflict.old_id;
  end if;

  insert into private.courses (id, repo_id, repo_name) values (p_course, p_repo_id, p_repo_name)
    on conflict (id) do update
      set repo_id = excluded.repo_id, repo_name = excluded.repo_name, synced_at = now();

  delete from private.members
    where course_id = p_course and github_id <> all (v_ids);
  get diagnostics v_removed = row_count;

  select count(*) into v_added
    from unnest(v_ids) as new_id
    where not exists (
      select 1 from private.members pm
      where pm.course_id = p_course and pm.github_id = new_id
    );

  insert into private.members (course_id, github_id, github_login)
    select distinct on ((m ->> 'github_id')::bigint)
      p_course, (m ->> 'github_id')::bigint, m ->> 'github_login'
    from jsonb_array_elements(p_members) m
    on conflict (course_id, github_id) do update
      set github_login = excluded.github_login;

  return jsonb_build_object(
    'course', p_course,
    'members', cardinality(v_ids),
    'added', v_added,
    'removed', v_removed
  );
end
$$;

revoke all on function public.sync_course(text, jsonb, bigint, text) from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete on table private.courses, private.members, private.heartbeat to service_role;
grant execute on function public.sync_course(text, jsonb, bigint, text) to service_role;

-- ---------------------------------------------------------------- keep-alive

-- Records one heartbeat. Called daily by the keep-alive workflow with the
-- publishable key, because free Supabase projects pause after a week without
-- activity. Anyone may call it: all it can do is set one timestamp.
create or replace function public.keepalive()
returns timestamptz
language sql
security invoker
set search_path = ''
as $$
  insert into private.heartbeat (id, beat_at) values (1, now())
  on conflict (id) do update set beat_at = excluded.beat_at
  returning beat_at
$$;

revoke all on function public.keepalive() from public, authenticated;
grant execute on function public.keepalive() to anon, service_role;
grant usage on schema private to anon;
grant select, insert, update (beat_at) on table private.heartbeat to anon;
drop policy if exists "anyone can record the heartbeat" on private.heartbeat;
create policy "anyone can record the heartbeat" on private.heartbeat
  for all to anon using (id = 1) with check (id = 1);

-- ---------------------------------------------------------------- sign-up rule

-- "Before User Created" hook: a new account is only created for a GitHub
-- account that is on at least one course's team list. Switch it on in the
-- dashboard: Authentication → Auth Hooks → Add hook → Before User Created →
-- Postgres → schema "public", function "hook_before_user_created".
-- For GitHub sign-ups, Supabase fills user_metadata.provider_id from GitHub
-- itself, so it can be trusted here (users can only change it later).
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_github_id text := event -> 'user' -> 'user_metadata' ->> 'provider_id';
begin
  if event -> 'user' -> 'app_metadata' ->> 'provider' = 'github'
     and v_github_id ~ '^[0-9]{1,18}$'
     and exists (select 1 from private.members m where m.github_id = v_github_id::bigint)
  then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This GitHub account is not on a meeting-engine team list.'
  ));
end
$$;

revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated, service_role;
grant usage on schema public to supabase_auth_admin;
grant usage on schema private to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
grant select on table private.members to supabase_auth_admin;
drop policy if exists "auth can read members" on private.members;
create policy "auth can read members" on private.members
  for select to supabase_auth_admin using (true);
