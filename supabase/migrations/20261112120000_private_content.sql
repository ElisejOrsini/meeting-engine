-- meeting-engine database setup, part 3: private courses, managed on the site.
--
-- How to run it: like parts 1 and 2 (Supabase dashboard → SQL Editor → New
-- query → paste this whole file → Run; the "destructive operation" warning is
-- expected). Parts 1 and 2 must have run first. Running it again is safe.
--
-- What it adds:
--   A second kind of course: "managed on the site". Its content (meetings,
--   questions, In-meeting and Post-meeting text, course notes) lives here, not
--   in a public repository, and only its team can read it. Courses deployed
--   from a repository (engine v0.4 and older) keep working as before.
--
--   private.revisions        every saved version of every part of a meeting
--                            (details, pre, in, post) and of the course notes;
--                            nothing is overwritten
--   private.agent_keys       keys for an AI agent, one course each; only a
--                            fingerprint (sha256) of the key is stored
--   members.organizer        organizers manage the team list and agent keys,
--                            and publish draft meetings
--
--   For the website (signed-in team members):
--     public.get_course(course)                everything the site shows
--     public.save_part / create_meeting / set_published / get_versions /
--       get_version / add_member / update_member / remove_member /
--       create_agent_key / revoke_agent_key / update_course   organizers only
--   For an agent (publishable key + "x-agent-key" header, see docs/agent-api.md):
--     public.agent_whoami / agent_get_course / agent_get_meeting /
--       agent_create_meeting / agent_update_meeting / agent_put_section /
--       agent_put_course_notes
--   For you, in the SQL Editor only:
--     private.create_course(id, name, your GitHub username, your GitHub id, site address)
--
-- Rules, enforced here and not by the website:
--   - Only the course's team can read anything; draft meetings only organizers.
--   - Only organizers change the team, keys, drafts and meeting text by hand.
--   - An agent key works for one course. "read" keys only read; "write" keys
--     can also create meetings (always as drafts) and save new versions. No key
--     can change the team or keys, publish, or see who gave which answer.
--   - Every save names the version it was based on; if someone saved in
--     between, the save is refused (HTTP 409) instead of overwriting.
--   - The deploy workflow (secret key) can't change a course managed on the site.

-- ---------------------------------------------------------------- columns and tables

alter table private.courses add column if not exists name text;
alter table private.courses add column if not exists description_md text;
alter table private.courses add column if not exists site_url text;
alter table private.courses add column if not exists managed_in text not null default 'repo';
alter table private.courses add column if not exists created_at timestamptz not null default now();
alter table private.courses drop constraint if exists courses_managed_in_check;
alter table private.courses add constraint courses_managed_in_check check (managed_in in ('repo', 'site'));

alter table private.members add column if not exists organizer boolean not null default false;
alter table private.members add column if not exists display_name text;

alter table private.meetings add column if not exists published boolean not null default false;
alter table private.meetings add column if not exists created_at timestamptz not null default now();

-- One row per saved version. meeting_id is '' for course-level parts (notes).
create table if not exists private.revisions (
  course_id text not null references private.courses (id) on delete cascade,
  meeting_id text not null default '',
  part text not null check (part in ('notes', 'details', 'pre', 'in', 'post')),
  version integer not null check (version > 0),
  content jsonb not null,
  saved_by_member bigint,
  saved_by_key uuid,
  note text check (char_length(note) <= 500),
  saved_at timestamptz not null default now(),
  primary key (course_id, meeting_id, part, version),
  check ((part = 'notes') = (meeting_id = ''))
);

create table if not exists private.agent_keys (
  id uuid primary key default gen_random_uuid(),
  course_id text not null references private.courses (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 60),
  permission text not null check (permission in ('read', 'write')),
  key_hash text not null unique,
  key_hint text not null,
  created_by bigint,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

alter table private.revisions enable row level security;
alter table private.agent_keys enable row level security;
revoke all on table private.revisions, private.agent_keys from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- the deploy can't touch site-managed courses

-- The deploy workflow uses the secret key (role service_role) and functions
-- from parts 1 and 2. For courses managed on the site, it is refused here, so
-- this holds even if those parts are run again later.
create or replace function private.guard_site_managed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_course text;
begin
  if current_user <> 'service_role' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'courses' then
    v_course := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    v_course := case when tg_op = 'DELETE' then old.course_id else new.course_id end;
  end if;
  if exists (select 1 from private.courses c where c.id = v_course and c.managed_in = 'site') then
    raise exception 'course "%" is managed on its website; a deploy can no longer change its team list or meetings', v_course;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
revoke all on function private.guard_site_managed() from public, anon, authenticated;

drop trigger if exists guard_site_managed on private.courses;
create trigger guard_site_managed before update or delete on private.courses
  for each row execute function private.guard_site_managed();
drop trigger if exists guard_site_managed on private.members;
create trigger guard_site_managed before insert or update or delete on private.members
  for each row execute function private.guard_site_managed();
drop trigger if exists guard_site_managed on private.meetings;
create trigger guard_site_managed before insert or update or delete on private.meetings
  for each row execute function private.guard_site_managed();

-- ---------------------------------------------------------------- who is calling

-- The signed-in person's GitHub id if they are an organizer of p_course.
create or replace function private.organizer_github_id(p_course text)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select m.github_id
  from private.members m
  where m.course_id = p_course
    and m.organizer
    and m.github_id = private.member_github_id(p_course)
$$;

-- The course must be managed on the site, and the caller on its team list.
-- Returns the caller's GitHub id.
create or replace function private.require_member(p_course text)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id bigint := private.member_github_id(p_course);
begin
  if v_id is null or not exists (select 1 from private.courses c where c.id = p_course and c.managed_in = 'site') then
    raise exception 'you are not on this course''s team list' using errcode = '42501';
  end if;
  return v_id;
end
$$;

create or replace function private.require_organizer(p_course text)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id bigint := private.require_member(p_course);
begin
  if private.organizer_github_id(p_course) is null then
    raise exception 'only organizers can do this' using errcode = '42501';
  end if;
  return v_id;
end
$$;

-- The agent key from the request's "x-agent-key" header. HTTP 401 if it is
-- missing, unknown or revoked; 403 if write access is needed but not allowed.
create or replace function private.agent_key(p_write boolean)
returns private.agent_keys
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raw text;
  v_key private.agent_keys;
begin
  begin
    v_raw := nullif(current_setting('request.headers', true), '')::json ->> 'x-agent-key';
  exception when others then
    v_raw := null;
  end;
  if v_raw is null or v_raw !~ '^me_agent_[0-9a-f]{64}$' then
    raise exception 'missing or malformed agent key (header x-agent-key)' using errcode = 'PT401';
  end if;
  select * into v_key from private.agent_keys k
    where k.key_hash = encode(sha256(convert_to(v_raw, 'UTF8')), 'hex') and k.revoked_at is null;
  if not found or not exists (select 1 from private.courses c where c.id = v_key.course_id and c.managed_in = 'site') then
    raise exception 'unknown or revoked agent key' using errcode = 'PT401';
  end if;
  if p_write and v_key.permission <> 'write' then
    raise exception 'this agent key may only read' using errcode = 'PT403';
  end if;
  update private.agent_keys k set last_used_at = now()
    where k.id = v_key.id and (k.last_used_at is null or k.last_used_at < now() - interval '1 minute');
  return v_key;
end
$$;

revoke all on function private.organizer_github_id(text) from public, anon, authenticated;
revoke all on function private.require_member(text) from public, anon, authenticated;
revoke all on function private.require_organizer(text) from public, anon, authenticated;
revoke all on function private.agent_key(boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------- checking content

-- p_obj must be an object with only the allowed keys and all required keys.
create or replace function private.check_keys(p_obj jsonb, p_path text, p_allowed text[], p_required text[] default '{}')
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
begin
  if jsonb_typeof(p_obj) is distinct from 'object' then
    raise exception '%: must be an object', p_path;
  end if;
  select k into v_key from jsonb_object_keys(p_obj) k where k <> all (p_allowed) order by k limit 1;
  if found then
    raise exception '%: unknown key "%" (allowed: %)', p_path, v_key, array_to_string(p_allowed, ', ');
  end if;
  foreach v_key in array p_required loop
    if coalesce(jsonb_typeof(p_obj -> v_key), 'null') = 'null' then
      raise exception '%.%: is required', p_path, v_key;
    end if;
  end loop;
end
$$;

-- Optional text value (null counts as missing). p_kind: 'text' | 'id' | 'date-or-text'.
create or replace function private.check_text(p_obj jsonb, p_key text, p_path text, p_max integer,
  p_required boolean default false, p_kind text default 'text')
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p_obj -> p_key;
begin
  if coalesce(jsonb_typeof(v), 'null') = 'null' then
    if p_required then raise exception '%.%: is required', p_path, p_key; end if;
    return;
  end if;
  if jsonb_typeof(v) <> 'string' then
    raise exception '%.%: must be text', p_path, p_key;
  end if;
  if p_required and btrim(v #>> '{}') = '' then
    raise exception '%.%: must not be empty', p_path, p_key;
  end if;
  if char_length(v #>> '{}') > p_max then
    raise exception '%.%: is longer than % characters', p_path, p_key, p_max;
  end if;
  if p_kind = 'id' and (v #>> '{}') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception '%.%: "%" is not a valid id (lowercase letters and digits, separated by single dashes)', p_path, p_key, v #>> '{}';
  end if;
end
$$;

create or replace function private.check_bool(p_obj jsonb, p_key text, p_path text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if coalesce(jsonb_typeof(p_obj -> p_key), 'null') not in ('null', 'boolean') then
    raise exception '%.%: must be true or false', p_path, p_key;
  end if;
end
$$;

create or replace function private.check_int(p_obj jsonb, p_key text, p_path text, p_min integer, p_max integer)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p_obj -> p_key;
begin
  if coalesce(jsonb_typeof(v), 'null') = 'null' then return; end if;
  if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric)
     or (v #>> '{}')::numeric not between p_min and p_max then
    raise exception '%.%: must be a whole number from % to %', p_path, p_key, p_min, p_max;
  end if;
end
$$;

-- Optional array of at most p_max items; returns it ('[]' if missing).
create or replace function private.check_array(p_obj jsonb, p_key text, p_path text, p_max integer)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := p_obj -> p_key;
begin
  if coalesce(jsonb_typeof(v), 'null') = 'null' then return '[]'::jsonb; end if;
  if jsonb_typeof(v) <> 'array' then
    raise exception '%.%: must be a list', p_path, p_key;
  end if;
  if jsonb_array_length(v) > p_max then
    raise exception '%.%: has more than % items', p_path, p_key, p_max;
  end if;
  return v;
end
$$;

-- The ids in p_items (each item's "id") must be different.
create or replace function private.check_unique_ids(p_items jsonb, p_path text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_dup text;
begin
  select i ->> 'id' into v_dup from jsonb_array_elements(p_items) i
    group by i ->> 'id' having count(*) > 1 limit 1;
  if found then
    raise exception '%: the id "%" is used more than once', p_path, v_dup;
  end if;
end
$$;

-- Checks one part's content. Raises an error naming the problem, or returns.
create or replace function private.check_part(p_part text, c jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_md constant integer := 20000;
  v_items jsonb;
  v_item jsonb;
  v_fields jsonb;
  v_field jsonb;
  v_path text;
  v_fpath text;
  v_options jsonb;
  i integer;
  j integer;
begin
  if c is null or octet_length(c::text) > 500000 then
    raise exception '%: content is missing or larger than 500 kB', p_part;
  end if;

  if p_part = 'notes' then
    perform private.check_keys(c, 'notes', '{notes_md}', '{notes_md}');
    perform private.check_text(c, 'notes_md', 'notes', 100000);

  elsif p_part = 'details' then
    perform private.check_keys(c, 'details', '{title,starts_at,duration_min,location_md}', '{title}');
    perform private.check_text(c, 'title', 'details', 200, true);
    perform private.check_text(c, 'starts_at', 'details', 40);
    if coalesce(jsonb_typeof(c -> 'starts_at'), 'null') <> 'null' then
      if (c ->> 'starts_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$' then
        raise exception 'details.starts_at: must be a date and time with time zone, e.g. 2026-11-24T16:15:00+01:00';
      end if;
      begin
        perform (c ->> 'starts_at')::timestamptz;
      exception when others then
        raise exception 'details.starts_at: "%" is not a valid time', c ->> 'starts_at';
      end;
    end if;
    perform private.check_int(c, 'duration_min', 'details', 1, 1440);
    perform private.check_text(c, 'location_md', 'details', 2000);

  elsif p_part = 'pre' then
    perform private.check_keys(c, 'pre', '{background_md,prereading_md,responses,questions}');
    perform private.check_text(c, 'background_md', 'pre', v_md);
    perform private.check_text(c, 'prereading_md', 'pre', v_md);
    if coalesce(jsonb_typeof(c -> 'responses'), 'null') <> 'null' then
      perform private.check_keys(c -> 'responses', 'pre.responses', '{reveal,anonymous}');
      if coalesce(c -> 'responses' ->> 'reveal', 'anytime') not in ('anytime', 'after_answering') then
        raise exception 'pre.responses.reveal: must be anytime or after_answering';
      end if;
      perform private.check_bool(c -> 'responses', 'anonymous', 'pre.responses');
    end if;
    v_items := private.check_array(c, 'questions', 'pre', 100);
    for i in 0 .. jsonb_array_length(v_items) - 1 loop
      v_item := v_items -> i;
      v_path := format('pre.questions[%s]', i);
      perform private.check_keys(v_item, v_path, '{id,text,needs_meeting,details_md,survey}', '{id,text}');
      perform private.check_text(v_item, 'id', v_path, 80, true, 'id');
      perform private.check_text(v_item, 'text', v_path, 500, true);
      perform private.check_bool(v_item, 'needs_meeting', v_path);
      perform private.check_text(v_item, 'details_md', v_path, v_md);
      v_fields := private.check_array(v_item, 'survey', v_path, 20);
      for j in 0 .. jsonb_array_length(v_fields) - 1 loop
        v_field := v_fields -> j;
        v_fpath := format('%s.survey[%s]', v_path, j);
        perform private.check_keys(v_field, v_fpath, '{id,type,label,options,required}', '{id,type,label}');
        perform private.check_text(v_field, 'id', v_fpath, 80, true, 'id');
        perform private.check_text(v_field, 'label', v_fpath, 500, true);
        perform private.check_bool(v_field, 'required', v_fpath);
        if (v_field ->> 'type') in ('single', 'multiple') then
          v_options := private.check_array(v_field, 'options', v_fpath, 50);
          if jsonb_array_length(v_options) < 2
             or exists (select 1 from jsonb_array_elements(v_options) o
                        where jsonb_typeof(o) <> 'string' or btrim(o #>> '{}') = '' or char_length(o #>> '{}') > 200)
             or (select count(distinct o) from jsonb_array_elements(v_options) o) <> jsonb_array_length(v_options) then
            raise exception '%.options: needs 2 or more different options, each 1 to 200 characters', v_fpath;
          end if;
        elsif (v_field ->> 'type') = 'text' then
          if coalesce(jsonb_typeof(v_field -> 'options'), 'null') <> 'null'
             and v_field -> 'options' <> '[]'::jsonb then
            raise exception '%.options: text fields have no options', v_fpath;
          end if;
        else
          raise exception '%.type: must be single, multiple or text', v_fpath;
        end if;
      end loop;
      perform private.check_unique_ids(v_fields, v_path || '.survey');
    end loop;
    perform private.check_unique_ids(v_items, 'pre.questions');

  elsif p_part = 'in' then
    perform private.check_keys(c, 'in', '{intro_md,items,guide_md}');
    perform private.check_text(c, 'intro_md', 'in', v_md);
    perform private.check_text(c, 'guide_md', 'in', v_md);
    v_items := private.check_array(c, 'items', 'in', 100);
    for i in 0 .. jsonb_array_length(v_items) - 1 loop
      v_item := v_items -> i;
      v_path := format('in.items[%s]', i);
      perform private.check_keys(v_item, v_path,
        '{question,title,short,consensus_md,key_points,contested,disagreement_md,minutes,notes_md}');
      perform private.check_text(v_item, 'question', v_path, 80, false, 'id');
      perform private.check_text(v_item, 'title', v_path, 200);
      if coalesce(v_item ->> 'question', '') = '' and btrim(coalesce(v_item ->> 'title', '')) = '' then
        raise exception '%: needs a question or a title', v_path;
      end if;
      perform private.check_text(v_item, 'short', v_path, 300);
      perform private.check_text(v_item, 'consensus_md', v_path, v_md);
      v_fields := private.check_array(v_item, 'key_points', v_path, 20);
      if exists (select 1 from jsonb_array_elements(v_fields) p
                 where jsonb_typeof(p) <> 'string' or char_length(p #>> '{}') > 1000) then
        raise exception '%.key_points: must be a list of texts of up to 1000 characters', v_path;
      end if;
      perform private.check_bool(v_item, 'contested', v_path);
      perform private.check_text(v_item, 'disagreement_md', v_path, v_md);
      perform private.check_int(v_item, 'minutes', v_path, 0, 600);
      perform private.check_text(v_item, 'notes_md', v_path, v_md);
    end loop;

  elsif p_part = 'post' then
    perform private.check_keys(c, 'post', '{summary_md,decisions,next_steps,open}');
    perform private.check_text(c, 'summary_md', 'post', v_md);
    v_items := private.check_array(c, 'decisions', 'post', 100);
    for i in 0 .. jsonb_array_length(v_items) - 1 loop
      v_item := v_items -> i;
      v_path := format('post.decisions[%s]', i);
      perform private.check_keys(v_item, v_path, '{id,question,decision_md,rationale_md}', '{id,decision_md}');
      perform private.check_text(v_item, 'id', v_path, 80, true, 'id');
      perform private.check_text(v_item, 'question', v_path, 80, false, 'id');
      perform private.check_text(v_item, 'decision_md', v_path, 5000, true);
      perform private.check_text(v_item, 'rationale_md', v_path, 5000);
    end loop;
    perform private.check_unique_ids(v_items, 'post.decisions');
    v_items := private.check_array(c, 'next_steps', 'post', 100);
    for i in 0 .. jsonb_array_length(v_items) - 1 loop
      v_item := v_items -> i;
      v_path := format('post.next_steps[%s]', i);
      perform private.check_keys(v_item, v_path, '{what_md,owner,due,question}', '{what_md}');
      perform private.check_text(v_item, 'what_md', v_path, 2000, true);
      perform private.check_text(v_item, 'owner', v_path, 100);
      perform private.check_text(v_item, 'due', v_path, 100);
      perform private.check_text(v_item, 'question', v_path, 80, false, 'id');
    end loop;
    v_items := private.check_array(c, 'open', 'post', 100);
    for i in 0 .. jsonb_array_length(v_items) - 1 loop
      v_item := v_items -> i;
      v_path := format('post.open[%s]', i);
      perform private.check_keys(v_item, v_path, '{question,text_md,next_md}', '{text_md}');
      perform private.check_text(v_item, 'question', v_path, 80, false, 'id');
      perform private.check_text(v_item, 'text_md', v_path, 2000, true);
      perform private.check_text(v_item, 'next_md', v_path, 2000);
    end loop;

  else
    raise exception 'unknown part "%" (details, pre, in, post)', p_part;
  end if;
end
$$;

revoke all on function private.check_keys(jsonb, text, text[], text[]) from public, anon, authenticated;
revoke all on function private.check_text(jsonb, text, text, integer, boolean, text) from public, anon, authenticated;
revoke all on function private.check_bool(jsonb, text, text) from public, anon, authenticated;
revoke all on function private.check_int(jsonb, text, text, integer, integer) from public, anon, authenticated;
revoke all on function private.check_array(jsonb, text, text, integer) from public, anon, authenticated;
revoke all on function private.check_unique_ids(jsonb, text) from public, anon, authenticated;
revoke all on function private.check_part(text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- reading parts

-- The survey fields of a Pre-meeting part, in the form answers are checked
-- against (see part 2): {"<question id>": [{"id", "type", "options", "required"}]}.
create or replace function private.survey_map(p_pre jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(q ->> 'id', (
    select jsonb_agg(jsonb_build_object(
      'id', f ->> 'id', 'type', f ->> 'type',
      'options', coalesce(nullif(f -> 'options', 'null'::jsonb), '[]'::jsonb),
      'required', coalesce((f ->> 'required')::boolean, false)) order by n)
    from jsonb_array_elements(q -> 'survey') with ordinality as s (f, n))), '{}'::jsonb)
  from jsonb_array_elements(coalesce(nullif(p_pre -> 'questions', 'null'::jsonb), '[]'::jsonb)) q
  where jsonb_typeof(q -> 'survey') = 'array' and jsonb_array_length(q -> 'survey') > 0
$$;

create or replace function private.saved_by(r private.revisions)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when r.saved_by_key is not null then
      'agent:' || coalesce((select k.label from private.agent_keys k where k.id = r.saved_by_key), 'deleted key')
    when r.saved_by_member is not null then
      'member:' || coalesce((select m.github_login from private.members m
                              where m.course_id = r.course_id and m.github_id = r.saved_by_member), 'former member')
    else 'admin'
  end
$$;

-- The newest version of one part: {version, content, saved_at, saved_by}, or
-- {version: 0, content: null} if it was never saved.
create or replace function private.current_part(p_course text, p_meeting text, p_part text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('version', r.version, 'content', r.content,
                               'saved_at', r.saved_at, 'saved_by', private.saved_by(r))
       from private.revisions r
      where r.course_id = p_course and r.meeting_id = p_meeting and r.part = p_part
      order by r.version desc limit 1),
    jsonb_build_object('version', 0, 'content', null))
$$;

create or replace function private.meeting_json(p_course text, p_meeting text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id,
    'published', m.published,
    'details', private.current_part(p_course, m.id, 'details'),
    'pre', private.current_part(p_course, m.id, 'pre'),
    'in', private.current_part(p_course, m.id, 'in'),
    'post', private.current_part(p_course, m.id, 'post'))
  from private.meetings m
  where m.course_id = p_course and m.id = p_meeting
$$;

revoke all on function private.survey_map(jsonb) from public, anon, authenticated;
revoke all on function private.saved_by(private.revisions) from public, anon, authenticated;
revoke all on function private.current_part(text, text, text) from public, anon, authenticated;
revoke all on function private.meeting_json(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- writing parts

-- Brings the survey settings that part 2 checks answers against up to date
-- with a meeting's newest details and Pre-meeting part: the date answers
-- expire after, reveal, anonymous (once on, always on) and the survey fields
-- (only for published meetings, so nobody answers a draft).
create or replace function private.refresh_meeting(p_course text, p_meeting text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_details jsonb := private.current_part(p_course, p_meeting, 'details') -> 'content';
  v_pre jsonb := private.current_part(p_course, p_meeting, 'pre') -> 'content';
begin
  update private.meetings m set
    date = coalesce(((v_details ->> 'starts_at')::timestamptz at time zone 'Europe/Zurich')::date,
                    (m.created_at at time zone 'Europe/Zurich')::date + 60),
    reveal = coalesce(v_pre -> 'responses' ->> 'reveal', 'anytime'),
    anonymous = m.anonymous or coalesce((v_pre -> 'responses' ->> 'anonymous')::boolean, false),
    questions = case when m.published then private.survey_map(v_pre) else '{}'::jsonb end,
    synced_at = now()
  where m.course_id = p_course and m.id = p_meeting;
end
$$;

-- Does a saved answer ({"<field id>": value}) fit the survey fields p_fields?
create or replace function private.answer_fits(p_answer jsonb, p_fields jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select not exists (
    select 1 from jsonb_each(p_answer) f
    where not exists (
      select 1 from jsonb_array_elements(coalesce(p_fields, '[]'::jsonb)) nf
      where nf ->> 'id' = f.key
        and (
          (nf ->> 'type' = 'text' and jsonb_typeof(f.value) = 'string')
          or (nf ->> 'type' = 'single' and jsonb_typeof(f.value) = 'string'
              and (nf -> 'options') ? (f.value #>> '{}'))
          or (nf ->> 'type' = 'multiple' and jsonb_typeof(f.value) = 'array'
              and not exists (select 1 from jsonb_array_elements_text(f.value) o
                              where not ((nf -> 'options') ? o)))
        )
    )
  )
$$;

-- How many saved answers fit the survey fields p_old but would no longer fit
-- p_new (a field or option they use was removed, renamed or changed type).
create or replace function private.answers_affected(p_course text, p_meeting text, p_old jsonb, p_new jsonb)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from private.answers a
  where a.course_id = p_course and a.meeting_id = p_meeting
    and private.answer_fits(a.answer, p_old -> a.question_id)
    and not private.answer_fits(a.answer, p_new -> a.question_id)
$$;

-- Saves a new version of one part. Used by organizers and agents (exactly one
-- of p_member / p_key says who). Returns {version, warnings, answers_affected}.
create or replace function private.write_part(
  p_course text, p_meeting text, p_part text, p_content jsonb, p_base_version integer,
  p_note text, p_force boolean, p_member bigint, p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meeting text := case when p_part = 'notes' then '' else coalesce(p_meeting, '') end;
  v_current integer;
  v_affected integer := 0;
  v_warnings jsonb := '[]'::jsonb;
  v_questions text[];
begin
  if p_part is null or p_part not in ('notes', 'details', 'pre', 'in', 'post') then
    raise exception 'unknown part "%" (details, pre, in, post)', p_part;
  end if;
  -- One save at a time per course (also makes the version check below safe).
  perform 1 from private.courses c where c.id = p_course for update;
  if p_part <> 'notes' and not exists (
    select 1 from private.meetings m where m.course_id = p_course and m.id = v_meeting
  ) then
    raise exception 'there is no meeting "%" in this course', p_meeting using errcode = 'PT404';
  end if;

  select coalesce(max(r.version), 0) into v_current
    from private.revisions r
    where r.course_id = p_course and r.meeting_id = v_meeting and r.part = p_part;
  if p_base_version is null or p_base_version <> v_current then
    raise exception 'conflict: % was saved as version % since version % (reload, keep the newer changes, and save again)',
      coalesce(nullif(p_meeting, '') || ' ', '') || p_part, v_current, coalesce(p_base_version::text, '(none)')
      using errcode = 'PT409';
  end if;

  perform private.check_part(p_part, p_content);

  if p_part = 'pre' then
    v_affected := private.answers_affected(p_course, v_meeting,
      private.survey_map(private.current_part(p_course, v_meeting, 'pre') -> 'content'),
      private.survey_map(p_content));
    if v_affected > 0 and not coalesce(p_force, false) then
      raise exception '% saved answer(s) no longer fit the changed survey fields; to save anyway (they will be hidden or shown as "no longer an option"), send force: true', v_affected;
    end if;
  end if;

  -- In-meeting and Post-meeting items may point at questions: warn about unknown ones.
  if p_part in ('in', 'post') then
    select coalesce(array_agg(q ->> 'id'), '{}') into v_questions
      from jsonb_array_elements(coalesce(
        private.current_part(p_course, v_meeting, 'pre') -> 'content' -> 'questions', '[]'::jsonb)) q;
    select coalesce(jsonb_agg(distinct format('question "%s" is not in the Pre-meeting part', x.q)), '[]'::jsonb)
      into v_warnings
      from (
        select i ->> 'question' as q from jsonb_array_elements(coalesce(p_content -> 'items', '[]'::jsonb)) i
        union all select i ->> 'question' from jsonb_array_elements(coalesce(p_content -> 'decisions', '[]'::jsonb)) i
        union all select i ->> 'question' from jsonb_array_elements(coalesce(p_content -> 'next_steps', '[]'::jsonb)) i
        union all select i ->> 'question' from jsonb_array_elements(coalesce(p_content -> 'open', '[]'::jsonb)) i
      ) x
      where x.q is not null and x.q <> all (v_questions);
  end if;

  insert into private.revisions (course_id, meeting_id, part, version, content, saved_by_member, saved_by_key, note)
    values (p_course, v_meeting, p_part, v_current + 1, p_content, p_member, p_key, nullif(btrim(p_note), ''));

  if p_part in ('details', 'pre') then
    perform private.refresh_meeting(p_course, v_meeting);
  end if;
  return jsonb_build_object('version', v_current + 1, 'warnings', v_warnings, 'answers_affected', v_affected);
end
$$;

-- Creates a draft meeting with its first details version.
create or replace function private.new_meeting(p_course text, p_id text, p_details jsonb, p_member bigint, p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_id is null or p_id !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p_id) > 80 then
    raise exception 'meeting id "%" is not valid (lowercase letters and digits, separated by single dashes, up to 80 characters)', p_id;
  end if;
  perform private.check_part('details', p_details);
  perform 1 from private.courses c where c.id = p_course for update;
  if exists (select 1 from private.meetings m where m.course_id = p_course and m.id = p_id) then
    raise exception 'a meeting with the id "%" already exists', p_id using errcode = 'PT409';
  end if;
  insert into private.meetings (course_id, id, date, reveal, anonymous, questions, published)
    values (p_course, p_id, (now() at time zone 'Europe/Zurich')::date + 60, 'anytime', false, '{}'::jsonb, false);
  perform private.write_part(p_course, p_id, 'details', p_details, 0, 'created', false, p_member, p_key);
  return jsonb_build_object('id', p_id, 'published', false);
end
$$;

revoke all on function private.refresh_meeting(text, text) from public, anon, authenticated;
revoke all on function private.answer_fits(jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.answers_affected(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.write_part(text, text, text, jsonb, integer, text, boolean, bigint, uuid) from public, anon, authenticated;
revoke all on function private.new_meeting(text, text, jsonb, bigint, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- the website: reading

-- Everything the site shows for one course. Draft meetings (and the agent
-- keys) only for organizers.
create or replace function private.get_course(p_course text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_member(p_course);
  v_organizer boolean := private.organizer_github_id(p_course) is not null;
begin
  return (
    select jsonb_build_object(
      'course', jsonb_build_object('id', c.id, 'name', coalesce(c.name, c.id),
                                   'description_md', c.description_md, 'site_url', c.site_url),
      'me', (select jsonb_build_object('login', m.github_login, 'github_id', m.github_id, 'organizer', m.organizer)
               from private.members m where m.course_id = p_course and m.github_id = v_me),
      'members', (select coalesce(jsonb_agg(jsonb_build_object(
                    'login', m.github_login, 'github_id', m.github_id, 'name', m.display_name,
                    'organizer', m.organizer) order by lower(m.github_login)), '[]'::jsonb)
                  from private.members m where m.course_id = p_course),
      'notes', private.current_part(p_course, '', 'notes'),
      'meetings', (select coalesce(jsonb_agg(private.meeting_json(p_course, m.id) order by m.date, m.id), '[]'::jsonb)
                   from private.meetings m
                   where m.course_id = p_course and (m.published or v_organizer)),
      'agent_keys', case when v_organizer then (
                      select coalesce(jsonb_agg(jsonb_build_object(
                        'id', k.id, 'label', k.label, 'permission', k.permission, 'hint', k.key_hint,
                        'created_at', k.created_at, 'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at,
                        'created_by', (select m.github_login from private.members m
                                        where m.course_id = k.course_id and m.github_id = k.created_by))
                        order by k.created_at), '[]'::jsonb)
                      from private.agent_keys k where k.course_id = p_course) end)
    from private.courses c where c.id = p_course
  );
end
$$;

-- The versions of one part (newest first), without their content. Organizers.
create or replace function private.get_versions(p_course text, p_meeting text, p_part text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_organizer(p_course);
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'version', r.version, 'saved_at', r.saved_at, 'saved_by', private.saved_by(r), 'note', r.note)
            order by r.version desc), '[]'::jsonb)
          from private.revisions r
          where r.course_id = p_course and r.part = p_part
            and r.meeting_id = case when p_part = 'notes' then '' else p_meeting end);
end
$$;

create or replace function private.get_version(p_course text, p_meeting text, p_part text, p_version integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_organizer(p_course);
  return (select r.content from private.revisions r
          where r.course_id = p_course and r.part = p_part and r.version = p_version
            and r.meeting_id = case when p_part = 'notes' then '' else p_meeting end);
end
$$;

-- ---------------------------------------------------------------- the website: organizers

create or replace function private.save_part(p_course text, p_meeting text, p_part text, p_content jsonb,
  p_base_version integer, p_note text, p_force boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.write_part(p_course, p_meeting, p_part, p_content, p_base_version, p_note, p_force,
                            private.require_organizer(p_course), null);
end
$$;

create or replace function private.create_meeting(p_course text, p_id text, p_details jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.new_meeting(p_course, p_id, p_details, private.require_organizer(p_course), null);
end
$$;

create or replace function private.set_published(p_course text, p_meeting text, p_published boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_organizer(p_course);
  update private.meetings m set published = coalesce(p_published, false)
    where m.course_id = p_course and m.id = p_meeting;
  if not found then
    raise exception 'there is no meeting "%" in this course', p_meeting using errcode = 'PT404';
  end if;
  perform private.refresh_meeting(p_course, p_meeting);
  return coalesce(p_published, false);
end
$$;

create or replace function private.update_course(p_course text, p_name text, p_description_md text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_organizer(p_course);
  if p_name is null or btrim(p_name) = '' or char_length(p_name) > 100 then
    raise exception 'the course name must be 1 to 100 characters';
  end if;
  if char_length(p_description_md) > 20000 then
    raise exception 'the description is longer than 20000 characters';
  end if;
  update private.courses c set name = btrim(p_name), description_md = nullif(btrim(p_description_md), '')
    where c.id = p_course;
end
$$;

-- Adds a person by numeric GitHub id (the site looks it up from the username).
create or replace function private.add_member(p_course text, p_github_id bigint, p_login text,
  p_name text, p_organizer boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_organizer(p_course);
  if p_github_id is null or p_github_id <= 0 then
    raise exception 'a GitHub account id is needed';
  end if;
  if p_login is null or p_login !~ '^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$' then
    raise exception '"%" is not a GitHub username', p_login;
  end if;
  if char_length(p_name) > 100 then
    raise exception 'the name is longer than 100 characters';
  end if;
  if exists (select 1 from private.members m where m.course_id = p_course and m.github_id = p_github_id) then
    raise exception '% is already on the team', p_login;
  end if;
  if exists (select 1 from private.members m where m.course_id = p_course and lower(m.github_login) = lower(p_login)) then
    raise exception 'another team member is listed with the username %; remove them first if they renamed their account', p_login;
  end if;
  insert into private.members (course_id, github_id, github_login, display_name, organizer)
    values (p_course, p_github_id, p_login, nullif(btrim(p_name), ''), coalesce(p_organizer, false));
end
$$;

create or replace function private.update_member(p_course text, p_github_id bigint, p_name text, p_organizer boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_organizer(p_course);
  if char_length(p_name) > 100 then
    raise exception 'the name is longer than 100 characters';
  end if;
  perform 1 from private.courses c where c.id = p_course for update;
  update private.members m set display_name = nullif(btrim(p_name), ''), organizer = coalesce(p_organizer, false)
    where m.course_id = p_course and m.github_id = p_github_id;
  if not found then
    raise exception 'this person is not on the team' using errcode = 'PT404';
  end if;
  if not exists (select 1 from private.members m where m.course_id = p_course and m.organizer) then
    raise exception 'the team needs at least one organizer';
  end if;
end
$$;

create or replace function private.remove_member(p_course text, p_github_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_organizer(p_course);
  perform 1 from private.courses c where c.id = p_course for update;
  delete from private.members m where m.course_id = p_course and m.github_id = p_github_id;
  if not found then
    raise exception 'this person is not on the team' using errcode = 'PT404';
  end if;
  if not exists (select 1 from private.members m where m.course_id = p_course and m.organizer) then
    raise exception 'the team needs at least one organizer';
  end if;
end
$$;

-- Creates an agent key and returns it. This is the only time the key is
-- shown: only its sha256 fingerprint is stored.
create or replace function private.create_agent_key(p_course text, p_label text, p_permission text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_organizer(p_course);
  -- 2 × 122 random bits from the database's secure random generator.
  v_key text := 'me_agent_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if p_permission is null or p_permission not in ('read', 'write') then
    raise exception 'permission must be read or write';
  end if;
  insert into private.agent_keys (course_id, label, permission, key_hash, key_hint, created_by)
    values (p_course, btrim(p_label), p_permission,
            encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), '…' || right(v_key, 4), v_me);
  return v_key;
end
$$;

create or replace function private.revoke_agent_key(p_course text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_organizer(p_course);
  update private.agent_keys k set revoked_at = now()
    where k.course_id = p_course and k.id = p_id and k.revoked_at is null;
end
$$;

-- ---------------------------------------------------------------- agents

create or replace function private.agent_whoami()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(false);
begin
  return (select jsonb_build_object('course', c.id, 'course_name', coalesce(c.name, c.id),
                                    'key_label', k.label, 'permission', k.permission, 'api_version', 0)
          from private.courses c where c.id = k.course_id);
end
$$;

-- Links into the course site, for emails.
create or replace function private.meeting_links(p_course text, p_meeting text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when c.site_url is null then '{}'::jsonb else jsonb_build_object(
    'pre', c.site_url || '#/m/' || p_meeting || '/pre',
    'in', c.site_url || '#/m/' || p_meeting || '/during',
    'post', c.site_url || '#/m/' || p_meeting || '/post') end
  from private.courses c where c.id = p_course
$$;

create or replace function private.agent_get_course()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(false);
begin
  return (
    select jsonb_build_object(
      'course', jsonb_build_object('id', c.id, 'name', coalesce(c.name, c.id),
                                  'description_md', c.description_md, 'site_url', c.site_url),
      'notes', (select jsonb_build_object('version', p.j -> 'version', 'notes_md', p.j -> 'content' ->> 'notes_md')
                from private.current_part(c.id, '', 'notes') as p (j)),
      'members', (select coalesce(jsonb_agg(jsonb_build_object(
                    'login', m.github_login, 'name', m.display_name, 'organizer', m.organizer)
                    order by lower(m.github_login)), '[]'::jsonb)
                  from private.members m where m.course_id = c.id),
      'meetings', (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', x.j ->> 'id', 'published', (x.j ->> 'published')::boolean,
                     'title', x.j -> 'details' -> 'content' ->> 'title',
                     'starts_at', x.j -> 'details' -> 'content' -> 'starts_at',
                     'duration_min', x.j -> 'details' -> 'content' -> 'duration_min',
                     'parts', jsonb_build_object(
                       'details', (x.j -> 'details' ->> 'version')::int,
                       'pre', (x.j -> 'pre' ->> 'version')::int,
                       'in', (x.j -> 'in' ->> 'version')::int,
                       'post', (x.j -> 'post' ->> 'version')::int))
                     order by x.date, x.id), '[]'::jsonb)
                   from (select m.id, m.date, private.meeting_json(c.id, m.id) as j
                         from private.meetings m where m.course_id = c.id) x),
      'decisions', (select coalesce(jsonb_agg(d.value || jsonb_build_object('meeting', p.meeting_id)
                      order by p.meeting_id, d.n), '[]'::jsonb)
                    from (select distinct on (r.meeting_id) r.meeting_id, r.content
                          from private.revisions r
                          where r.course_id = c.id and r.part = 'post'
                          order by r.meeting_id, r.version desc) p,
                         jsonb_array_elements(coalesce(p.content -> 'decisions', '[]'::jsonb)) with ordinality d (value, n)),
      'next_steps', (select coalesce(jsonb_agg(d.value || jsonb_build_object('meeting', p.meeting_id)
                       order by p.meeting_id, d.n), '[]'::jsonb)
                     from (select distinct on (r.meeting_id) r.meeting_id, r.content
                           from private.revisions r
                           where r.course_id = c.id and r.part = 'post'
                           order by r.meeting_id, r.version desc) p,
                          jsonb_array_elements(coalesce(p.content -> 'next_steps', '[]'::jsonb)) with ordinality d (value, n)))
    from private.courses c where c.id = k.course_id
  );
end
$$;

create or replace function private.agent_get_meeting(p_meeting text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(false);
  v jsonb := private.meeting_json(k.course_id, p_meeting);
begin
  if v is null then
    raise exception 'there is no meeting "%" in this course', p_meeting using errcode = 'PT404';
  end if;
  return v || jsonb_build_object('links', private.meeting_links(k.course_id, p_meeting));
end
$$;

create or replace function private.agent_create_meeting(p_id text, p_details jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(true);
begin
  return private.new_meeting(k.course_id, p_id, p_details, null, k.id)
    || jsonb_build_object('links', private.meeting_links(k.course_id, p_id));
end
$$;

-- Changes some details fields; the others keep their current value. A null
-- value removes an optional field.
create or replace function private.agent_update_meeting(p_meeting text, p_base_version integer, p_details jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(true);
  v_current jsonb := private.current_part(k.course_id, p_meeting, 'details') -> 'content';
begin
  if jsonb_typeof(p_details) is distinct from 'object' then
    raise exception 'details: must be an object';
  end if;
  return private.write_part(k.course_id, p_meeting, 'details',
    jsonb_strip_nulls(coalesce(v_current, '{}'::jsonb) || p_details),
    p_base_version, null, false, null, k.id);
end
$$;

create or replace function private.agent_put_section(p_meeting text, p_part text, p_base_version integer,
  p_content jsonb, p_note text, p_force boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(true);
begin
  if p_part is null or p_part not in ('pre', 'in', 'post') then
    raise exception 'part must be pre, in or post (use agent_update_meeting for details)';
  end if;
  return private.write_part(k.course_id, p_meeting, p_part, p_content, p_base_version, p_note, p_force, null, k.id);
end
$$;

create or replace function private.agent_put_course_notes(p_base_version integer, p_notes_md text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(true);
begin
  return private.write_part(k.course_id, '', 'notes', jsonb_build_object('notes_md', p_notes_md),
                            p_base_version, p_note, false, null, k.id) - 'answers_affected';
end
$$;

-- ---------------------------------------------------------------- for you, in the SQL Editor

-- Creates a course managed on the site, with you as its first organizer.
-- Your numeric GitHub id: https://api.github.com/users/<your username> ("id").
-- Example:
--   select private.create_course('widgetry-2026', 'Applied Widgetry', 'your-username', 12345678,
--                                'https://your-org.github.io/meetings/');
create or replace function private.create_course(p_id text, p_name text, p_login text, p_github_id bigint, p_site_url text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from private.courses c where c.id = p_id) then
    raise exception 'a course with the id "%" already exists', p_id;
  end if;
  if p_site_url is null or p_site_url !~ '^(https://[^/:]+|http://(localhost|127\.0\.0\.1):[0-9]+)/([^?#]*/)?$' then
    raise exception 'the site address must start with https:// and end with /';
  end if;
  insert into private.courses (id, name, site_url, managed_in) values (p_id, btrim(p_name), p_site_url, 'site');
  insert into private.members (course_id, github_id, github_login, organizer) values (p_id, p_github_id, p_login, true);
  return format('Course "%s" created with %s as organizer.', p_id, p_login);
end
$$;

revoke all on function private.get_course(text) from public, anon;
revoke all on function private.get_versions(text, text, text) from public, anon;
revoke all on function private.get_version(text, text, text, integer) from public, anon;
revoke all on function private.save_part(text, text, text, jsonb, integer, text, boolean) from public, anon;
revoke all on function private.create_meeting(text, text, jsonb) from public, anon;
revoke all on function private.set_published(text, text, boolean) from public, anon;
revoke all on function private.update_course(text, text, text) from public, anon;
revoke all on function private.add_member(text, bigint, text, text, boolean) from public, anon;
revoke all on function private.update_member(text, bigint, text, boolean) from public, anon;
revoke all on function private.remove_member(text, bigint) from public, anon;
revoke all on function private.create_agent_key(text, text, text) from public, anon;
revoke all on function private.revoke_agent_key(text, uuid) from public, anon;
revoke all on function private.agent_whoami() from public, authenticated;
revoke all on function private.meeting_links(text, text) from public, anon, authenticated;
revoke all on function private.agent_get_course() from public, authenticated;
revoke all on function private.agent_get_meeting(text) from public, authenticated;
revoke all on function private.agent_create_meeting(text, jsonb) from public, authenticated;
revoke all on function private.agent_update_meeting(text, integer, jsonb) from public, authenticated;
revoke all on function private.agent_put_section(text, text, integer, jsonb, text, boolean) from public, authenticated;
revoke all on function private.agent_put_course_notes(integer, text, text) from public, authenticated;
revoke all on function private.create_course(text, text, text, bigint, text) from public, anon, authenticated, service_role;

grant execute on function private.get_course(text), private.get_versions(text, text, text),
  private.get_version(text, text, text, integer),
  private.save_part(text, text, text, jsonb, integer, text, boolean), private.create_meeting(text, text, jsonb),
  private.set_published(text, text, boolean), private.update_course(text, text, text),
  private.add_member(text, bigint, text, text, boolean), private.update_member(text, bigint, text, boolean),
  private.remove_member(text, bigint), private.create_agent_key(text, text, text),
  private.revoke_agent_key(text, uuid)
  to authenticated;
grant execute on function private.agent_whoami(), private.agent_get_course(), private.agent_get_meeting(text),
  private.agent_create_meeting(text, jsonb), private.agent_update_meeting(text, integer, jsonb),
  private.agent_put_section(text, text, integer, jsonb, text, boolean),
  private.agent_put_course_notes(integer, text, text)
  to anon;

-- ---------------------------------------------------------------- public wrappers (the API)

-- The website calls these (signed in). Parameter names are the JSON keys.
create or replace function public.get_course(p_course text) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.get_course(p_course) $$;
create or replace function public.get_versions(p_course text, p_meeting text, p_part text) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.get_versions(p_course, p_meeting, p_part) $$;
create or replace function public.get_version(p_course text, p_meeting text, p_part text, p_version integer) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.get_version(p_course, p_meeting, p_part, p_version) $$;
create or replace function public.save_part(p_course text, p_meeting text, p_part text, p_content jsonb,
  p_base_version integer, p_note text default null, p_force boolean default false) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.save_part(p_course, p_meeting, p_part, p_content, p_base_version, p_note, p_force) $$;
create or replace function public.create_meeting(p_course text, p_id text, p_details jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.create_meeting(p_course, p_id, p_details) $$;
create or replace function public.set_published(p_course text, p_meeting text, p_published boolean) returns boolean
language sql security invoker set search_path = ''
as $$ select private.set_published(p_course, p_meeting, p_published) $$;
create or replace function public.update_course(p_course text, p_name text, p_description_md text default null) returns void
language sql security invoker set search_path = ''
as $$ select private.update_course(p_course, p_name, p_description_md) $$;
create or replace function public.add_member(p_course text, p_github_id bigint, p_login text,
  p_name text default null, p_organizer boolean default false) returns void
language sql security invoker set search_path = ''
as $$ select private.add_member(p_course, p_github_id, p_login, p_name, p_organizer) $$;
create or replace function public.update_member(p_course text, p_github_id bigint, p_name text, p_organizer boolean) returns void
language sql security invoker set search_path = ''
as $$ select private.update_member(p_course, p_github_id, p_name, p_organizer) $$;
create or replace function public.remove_member(p_course text, p_github_id bigint) returns void
language sql security invoker set search_path = ''
as $$ select private.remove_member(p_course, p_github_id) $$;
create or replace function public.create_agent_key(p_course text, p_label text, p_permission text) returns text
language sql volatile security invoker set search_path = ''
as $$ select private.create_agent_key(p_course, p_label, p_permission) $$;
create or replace function public.revoke_agent_key(p_course text, p_id uuid) returns void
language sql security invoker set search_path = ''
as $$ select private.revoke_agent_key(p_course, p_id) $$;

-- Agents call these with the publishable key and the "x-agent-key" header.
-- Parameter names are the JSON keys documented in docs/agent-api.md.
create or replace function public.agent_whoami() returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_whoami() $$;
create or replace function public.agent_get_course() returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_get_course() $$;
create or replace function public.agent_get_meeting(meeting text) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_get_meeting(meeting) $$;
create or replace function public.agent_create_meeting(id text, title text, starts_at text default null,
  duration_min integer default null, location_md text default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_create_meeting(id, jsonb_strip_nulls(jsonb_build_object(
  'title', title, 'starts_at', starts_at, 'duration_min', duration_min, 'location_md', location_md))) $$;
create or replace function public.agent_update_meeting(meeting text, base_version integer, details jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_update_meeting(meeting, base_version, details) $$;
create or replace function public.agent_put_section(meeting text, part text, base_version integer, content jsonb,
  note text default null, force boolean default false) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_put_section(meeting, part, base_version, content, note, force) $$;
create or replace function public.agent_put_course_notes(base_version integer, notes_md text, note text default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_put_course_notes(base_version, notes_md, note) $$;

revoke all on function public.get_course(text), public.get_versions(text, text, text),
  public.get_version(text, text, text, integer),
  public.save_part(text, text, text, jsonb, integer, text, boolean), public.create_meeting(text, text, jsonb),
  public.set_published(text, text, boolean), public.update_course(text, text, text),
  public.add_member(text, bigint, text, text, boolean), public.update_member(text, bigint, text, boolean),
  public.remove_member(text, bigint), public.create_agent_key(text, text, text),
  public.revoke_agent_key(text, uuid)
  from public, anon;
grant execute on function public.get_course(text), public.get_versions(text, text, text),
  public.get_version(text, text, text, integer),
  public.save_part(text, text, text, jsonb, integer, text, boolean), public.create_meeting(text, text, jsonb),
  public.set_published(text, text, boolean), public.update_course(text, text, text),
  public.add_member(text, bigint, text, text, boolean), public.update_member(text, bigint, text, boolean),
  public.remove_member(text, bigint), public.create_agent_key(text, text, text),
  public.revoke_agent_key(text, uuid)
  to authenticated;

revoke all on function public.agent_whoami(), public.agent_get_course(), public.agent_get_meeting(text),
  public.agent_create_meeting(text, text, text, integer, text), public.agent_update_meeting(text, integer, jsonb),
  public.agent_put_section(text, text, integer, jsonb, text, boolean),
  public.agent_put_course_notes(integer, text, text)
  from public, authenticated;
grant execute on function public.agent_whoami(), public.agent_get_course(), public.agent_get_meeting(text),
  public.agent_create_meeting(text, text, text, integer, text), public.agent_update_meeting(text, integer, jsonb),
  public.agent_put_section(text, text, integer, jsonb, text, boolean),
  public.agent_put_course_notes(integer, text, text)
  to anon;
