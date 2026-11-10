-- meeting-engine database setup, part 2: survey answers.
--
-- How to run it: like part 1 (Supabase dashboard → SQL Editor → New query →
-- paste this whole file → Run; the "destructive operation" warning is
-- expected). Part 1 must have run first. Running it again is safe.
--
-- What it sets up:
--   private.meetings                  each meeting's survey settings and fields,
--                                     copied from the course repository on deploy
--   private.answers                   one answer per person, question and meeting
--   public.save_answer(...)           the website saves or removes your answer
--   public.get_answers(...)           the website reads your answers, and the
--                                     others' when the meeting's rules allow it
--   public.sync_meetings(...)         used by the deploy workflow (secret key)
--   a nightly job (pg_cron)           deletes answers 30 days after the meeting
--
-- Rules, enforced here and not by the website:
--   - Only people on the course's team list can save or read answers.
--   - Everyone can only save, change or remove their own answer, at any time,
--     until the answers are deleted 30 days after the meeting.
--   - reveal "anytime": team members can read everyone's answers.
--     reveal "after_answering": others' answers to a question become readable
--     once you have answered that question yourself.
--   - anonymous meetings: teammates see the answers but not who gave them (the
--     database still knows, so everyone can change their own answer). Once a
--     meeting has been anonymous, it stays anonymous: removing the setting from
--     meeting.yml later doesn't reveal any names.
--   - Answers of people who are no longer on the team list are not shown.

-- ---------------------------------------------------------------- tables

create table if not exists private.meetings (
  course_id text not null references private.courses (id) on delete cascade,
  id text not null check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  date date not null,
  reveal text not null check (reveal in ('anytime', 'after_answering')),
  anonymous boolean not null default false,
  -- {"<question id>": [{"id": "...", "type": "single|multiple|text",
  --                     "options": ["..."], "required": true|false}, ...]}
  questions jsonb not null default '{}'::jsonb check (jsonb_typeof(questions) = 'object'),
  synced_at timestamptz not null default now(),
  primary key (course_id, id)
);

create table if not exists private.answers (
  course_id text not null,
  meeting_id text not null,
  question_id text not null,
  github_id bigint not null check (github_id > 0),
  -- {"<field id>": "text" | "option" | ["option", ...]}
  answer jsonb not null check (jsonb_typeof(answer) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (course_id, meeting_id, question_id, github_id),
  foreign key (course_id, meeting_id) references private.meetings (course_id, id) on delete cascade
);

alter table private.meetings enable row level security;
alter table private.answers enable row level security;
revoke all on table private.meetings, private.answers from public, anon, authenticated;
grant select, insert, update, delete on table private.meetings, private.answers to service_role;

-- ---------------------------------------------------------------- helpers

-- Answers are kept until 30 days after the meeting.
create or replace function private.answers_expired(p_date date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_date < current_date - 30
$$;

-- The signed-in person's GitHub id on the team list of p_course, or null.
create or replace function private.member_github_id(p_course text)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select min(m.github_id)
  from private.members m
  join auth.identities i
    on i.provider = 'github'
   and i.provider_id ~ '^[0-9]{1,18}$'
   and i.provider_id::bigint = m.github_id
  where m.course_id = p_course
    and i.user_id = (select auth.uid())
$$;

revoke all on function private.answers_expired(date) from public, anon, authenticated;
revoke all on function private.member_github_id(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- saving

-- Saves the signed-in person's answer to one question, checked against the
-- question's survey fields. An empty answer ({} or every field empty) removes
-- it; removing always works, even if the question's survey was renamed or
-- removed since. Returns the time it was saved, or null if it was removed.
create or replace function private.save_answer(p_course text, p_meeting text, p_question text, p_answer jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_github_id bigint := private.member_github_id(p_course);
  v_meeting private.meetings;
  v_fields jsonb;
  v_field jsonb;
  v_value jsonb;
  v_key text;
  v_clean jsonb := '{}'::jsonb;
  v_missing text[] := '{}';
  v_at timestamptz;
begin
  if v_github_id is null then
    raise exception 'you are not on this course''s team list' using errcode = '42501';
  end if;
  if p_answer = '{}'::jsonb then
    delete from private.answers a
      where a.course_id = p_course and a.meeting_id = p_meeting
        and a.question_id = p_question and a.github_id = v_github_id;
    return null;
  end if;
  select * into v_meeting from private.meetings m where m.course_id = p_course and m.id = p_meeting;
  if not found then
    raise exception 'this meeting has no survey (yet); the site may be newer than its last deploy';
  end if;
  if private.answers_expired(v_meeting.date) then
    raise exception 'answers for this meeting were deleted 30 days after it';
  end if;
  v_fields := v_meeting.questions -> p_question;
  if v_fields is null or jsonb_typeof(v_fields) <> 'array' or jsonb_array_length(v_fields) = 0 then
    raise exception 'this question has no survey';
  end if;
  if p_answer is null or jsonb_typeof(p_answer) <> 'object' then
    raise exception 'the answer must be a JSON object';
  end if;
  for v_key in select jsonb_object_keys(p_answer) loop
    if not exists (select 1 from jsonb_array_elements(v_fields) f where f ->> 'id' = v_key) then
      raise exception 'unknown survey field "%"', v_key;
    end if;
  end loop;

  for v_field in select value from jsonb_array_elements(v_fields) loop
    v_value := p_answer -> (v_field ->> 'id');
    -- Empty values don't count as answers.
    if v_value is null
       or jsonb_typeof(v_value) = 'null'
       or (jsonb_typeof(v_value) = 'string' and btrim(v_value #>> '{}') = '')
       or (jsonb_typeof(v_value) = 'array' and jsonb_array_length(v_value) = 0) then
      if coalesce((v_field ->> 'required')::boolean, false) then
        v_missing := v_missing || (v_field ->> 'id');
      end if;
      continue;
    end if;
    case v_field ->> 'type'
      when 'text' then
        if jsonb_typeof(v_value) <> 'string' then
          raise exception 'field "%" needs text', v_field ->> 'id';
        end if;
        if char_length(v_value #>> '{}') > 4000 then
          raise exception 'field "%" is longer than 4000 characters', v_field ->> 'id';
        end if;
      when 'single' then
        if jsonb_typeof(v_value) <> 'string' or not ((v_field -> 'options') ? (v_value #>> '{}')) then
          raise exception 'field "%" must be one of its options', v_field ->> 'id';
        end if;
      when 'multiple' then
        if jsonb_typeof(v_value) <> 'array'
           or exists (
             select 1 from jsonb_array_elements(v_value) o
             where jsonb_typeof(o) <> 'string' or not ((v_field -> 'options') ? (o #>> '{}'))
           )
           or (select count(*) from jsonb_array_elements(v_value))
              <> (select count(distinct o) from jsonb_array_elements(v_value) o) then
          raise exception 'field "%" must be a list of different options', v_field ->> 'id';
        end if;
      else
        raise exception 'field "%" has an unknown type', v_field ->> 'id';
    end case;
    v_clean := v_clean || jsonb_build_object(v_field ->> 'id', v_value);
  end loop;

  if v_clean = '{}'::jsonb then
    delete from private.answers a
      where a.course_id = p_course and a.meeting_id = p_meeting
        and a.question_id = p_question and a.github_id = v_github_id;
    return null;
  end if;
  if cardinality(v_missing) > 0 then
    raise exception 'please also fill in the required field(s): %', array_to_string(v_missing, ', ');
  end if;

  insert into private.answers (course_id, meeting_id, question_id, github_id, answer)
    values (p_course, p_meeting, p_question, v_github_id, v_clean)
    on conflict (course_id, meeting_id, question_id, github_id) do update
      set answer = excluded.answer, updated_at = now()
    returning updated_at into v_at;
  return v_at;
end
$$;

-- ---------------------------------------------------------------- reading

-- The answers of one meeting that the signed-in person may see: always their
-- own; with p_others also the others' (all of them for reveal "anytime", and
-- for "after_answering" only for questions they answered themselves). In
-- anonymous meetings, others' names are left out, and so is the time (it could
-- identify people); those answers come in an order that doesn't depend on who
-- gave them.
create or replace function private.get_answers(p_course text, p_meeting text, p_others boolean)
returns table (question_id text, answer jsonb, github_login text, mine boolean, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_github_id bigint := private.member_github_id(p_course);
  v_meeting private.meetings;
begin
  if v_github_id is null then
    raise exception 'you are not on this course''s team list' using errcode = '42501';
  end if;
  select * into v_meeting from private.meetings m where m.course_id = p_course and m.id = p_meeting;
  if not found or private.answers_expired(v_meeting.date) then
    return;
  end if;
  return query
    select
      a.question_id,
      a.answer,
      case when a.github_id = v_github_id or not v_meeting.anonymous then mem.github_login end,
      a.github_id = v_github_id,
      case when a.github_id = v_github_id or not v_meeting.anonymous then a.updated_at end
    from private.answers a
    join private.members mem
      on mem.course_id = a.course_id and mem.github_id = a.github_id
    where a.course_id = p_course
      and a.meeting_id = p_meeting
      and (
        a.github_id = v_github_id
        or (
          coalesce(p_others, false)
          and (
            v_meeting.reveal = 'anytime'
            or exists (
              select 1 from private.answers own
              where own.course_id = a.course_id and own.meeting_id = a.meeting_id
                and own.question_id = a.question_id and own.github_id = v_github_id
            )
          )
        )
      )
    order by
      a.question_id,
      (a.github_id = v_github_id) desc,
      case when v_meeting.anonymous then md5(a.answer::text) else lower(mem.github_login) end;
end
$$;

-- The website calls these two.
create or replace function public.save_answer(p_course text, p_meeting text, p_question text, p_answer jsonb)
returns timestamptz
language sql
security invoker
set search_path = ''
as $$
  select private.save_answer(p_course, p_meeting, p_question, p_answer)
$$;

create or replace function public.get_answers(p_course text, p_meeting text, p_others boolean default false)
returns table (question_id text, answer jsonb, github_login text, mine boolean, updated_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from private.get_answers(p_course, p_meeting, p_others)
$$;

revoke all on function private.save_answer(text, text, text, jsonb) from public, anon;
revoke all on function private.get_answers(text, text, boolean) from public, anon;
revoke all on function public.save_answer(text, text, text, jsonb) from public, anon;
revoke all on function public.get_answers(text, text, boolean) from public, anon;
grant execute on function private.save_answer(text, text, text, jsonb) to authenticated;
grant execute on function private.get_answers(text, text, boolean) to authenticated;
grant execute on function public.save_answer(text, text, text, jsonb) to authenticated;
grant execute on function public.get_answers(text, text, boolean) to authenticated;

-- ---------------------------------------------------------------- deleting

-- Deletes answers 30 days after their meeting, for all courses. Runs every
-- night (below). Returns how many answers were deleted.
create or replace function private.delete_old_answers()
returns integer
language sql
set search_path = ''
as $$
  with gone as (
    delete from private.answers a
    using private.meetings m
    where m.course_id = a.course_id and m.id = a.meeting_id
      and private.answers_expired(m.date)
    returning 1
  )
  select count(*)::integer from gone
$$;

revoke all on function private.delete_old_answers() from public, anon, authenticated, service_role;
grant execute on function private.answers_expired(date) to service_role;

-- Every night at 03:17 UTC, if Supabase's scheduler (pg_cron) is available.
-- (The website never shows expired answers either way.)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    grant usage on schema cron to postgres;
    grant all privileges on all tables in schema cron to postgres;
    perform cron.schedule('meeting-engine-delete-old-answers', '17 3 * * *',
      'select private.delete_old_answers()');
  else
    raise notice 'pg_cron is not available: old answers are hidden, and deleted on the next deploy';
  end if;
end
$$;

-- ---------------------------------------------------------------- deploy workflow

-- Replaces the survey settings of a course's meetings. Called by the deploy
-- workflow with the secret key, after sync_course. p_meetings is
-- [{"id", "date", "reveal", "anonymous", "questions": {...}}, ...].
-- Meetings missing from the list are kept until their answers expire.
-- "anonymous" can be switched on but never off again (the answers were given
-- under that promise); kept_anonymous lists meetings where the content tried.
create or replace function public.sync_meetings(p_course text, p_repo_id bigint, p_meetings jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner bigint;
  v_count int;
  v_deleted int;
  v_kept jsonb;
begin
  select c.repo_id into v_owner from private.courses c where c.id = p_course;
  if not found then
    raise exception 'course id "%" has no team list yet; the team list must be copied first', p_course;
  end if;
  if v_owner is distinct from p_repo_id then
    raise exception 'course id "%" belongs to another repository', p_course;
  end if;
  if jsonb_typeof(p_meetings) is distinct from 'array' then
    raise exception 'p_meetings must be a JSON array';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_meetings) m
    where jsonb_typeof(m) <> 'object'
       or coalesce(m ->> 'id', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
       or coalesce(m ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$'
       or coalesce(m ->> 'reveal', '') not in ('anytime', 'after_answering')
       or jsonb_typeof(m -> 'anonymous') is distinct from 'boolean'
       or jsonb_typeof(m -> 'questions') is distinct from 'object'
  ) then
    raise exception 'each meeting needs an id, a date, reveal, anonymous and questions';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_meetings) m,
         jsonb_each(m -> 'questions') q
    where jsonb_typeof(q.value) <> 'array'
       or exists (
         select 1 from jsonb_array_elements(q.value) f
         where jsonb_typeof(f) <> 'object'
            or coalesce(f ->> 'id', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
            or coalesce(f ->> 'type', '') not in ('single', 'multiple', 'text')
            or jsonb_typeof(f -> 'options') is distinct from 'array'
            or jsonb_typeof(f -> 'required') is distinct from 'boolean'
            or exists (select 1 from jsonb_array_elements(f -> 'options') o where jsonb_typeof(o) <> 'string')
       )
  ) then
    raise exception 'each survey field needs an id, a type, a list of options and required';
  end if;

  select coalesce(jsonb_agg(pm.id order by pm.id), '[]'::jsonb) into v_kept
    from private.meetings pm
    join jsonb_array_elements(p_meetings) m on m ->> 'id' = pm.id
    where pm.course_id = p_course and pm.anonymous and not (m ->> 'anonymous')::boolean;

  insert into private.meetings (course_id, id, date, reveal, anonymous, questions)
    select p_course, m ->> 'id', (m ->> 'date')::date, m ->> 'reveal', (m ->> 'anonymous')::boolean, m -> 'questions'
    from jsonb_array_elements(p_meetings) m
    on conflict (course_id, id) do update
      set date = excluded.date, reveal = excluded.reveal,
          anonymous = private.meetings.anonymous or excluded.anonymous, -- once anonymous, always
          questions = excluded.questions, synced_at = now();
  get diagnostics v_count = row_count;

  -- Also delete this course's expired answers (the nightly job does all courses).
  with gone as (
    delete from private.answers a
    using private.meetings m
    where m.course_id = p_course and a.course_id = p_course and m.id = a.meeting_id
      and private.answers_expired(m.date)
    returning 1
  )
  select count(*)::int into v_deleted from gone;
  return jsonb_build_object('course', p_course, 'meetings', v_count, 'deleted_answers', v_deleted,
    'kept_anonymous', v_kept);
end
$$;

revoke all on function public.sync_meetings(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.sync_meetings(text, bigint, jsonb) to service_role;
