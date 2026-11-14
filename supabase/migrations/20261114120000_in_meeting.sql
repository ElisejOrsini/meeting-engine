-- meeting-engine database setup, part 4: the In-meeting tab.
--
-- How to run it: like parts 1–3 (Supabase dashboard → SQL Editor → New query →
-- paste this whole file → Run). Parts 1–3 must have run first. Running it
-- again is safe.
--
-- What it adds:
--   private.tallies          the last vote counts of each question, kept when
--                            the answers are deleted (30 days after the
--                            meeting), so the In-meeting charts stay
--   answers.skipped          "Skip" on a survey question: counts like an
--                            answer for seeing the others' answers and the
--                            vote counts, but is not a vote
--   For the website (signed-in team members):
--     public.skip_question(course, meeting, question)
--     public.get_tallies(course, meeting)      vote counts, no names
--   For an agent (see docs/agent-api.md):
--     public.agent_get_responses(meeting)      counts and written answers,
--                                              people as P1, P2, … (no names)
--     public.agent_due()                       what the agent should do now
--
-- Rules:
--   - Counts never carry names. Written answers only go to agents, labelled
--     P1, P2, … per meeting.
--   - With reveal "after_answering", you see a question's counts (and the
--     others' answers) once you have answered or skipped it; everyone sees the
--     counts from 30 minutes before the meeting (when the AI summary is
--     written). With "anytime", the counts are always visible.
--   - Agents still can't see who gave which answer.

-- ---------------------------------------------------------------- tables

-- A skipped question is stored as an empty answer with skipped = true.
alter table private.answers add column if not exists skipped boolean not null default false;

-- Saving a real answer (part 2's save_answer) ends a skip.
create or replace function private.unskip_answer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.answer <> '{}'::jsonb then
    new.skipped := false;
  end if;
  return new;
end
$$;

drop trigger if exists unskip_on_answer on private.answers;
create trigger unskip_on_answer before insert or update on private.answers
  for each row execute function private.unskip_answer();

create table if not exists private.tallies (
  course_id text not null,
  meeting_id text not null,
  question_id text not null,
  -- {"answered": 6, "fields": [{"id", "type", "answered", "counts": [{"option", "count"}]}]}
  tally jsonb not null,
  taken_at timestamptz not null default now(),
  primary key (course_id, meeting_id, question_id),
  foreign key (course_id, meeting_id) references private.meetings (course_id, id) on delete cascade
);

alter table private.tallies enable row level security;
revoke all on table private.tallies from public, anon, authenticated;
grant select, insert, update, delete on table private.tallies to service_role;

-- ---------------------------------------------------------------- skipping

-- Marks one survey question as skipped by the signed-in person (replacing
-- their answer, if any). Removing it works like removing an answer
-- (save_answer with {}). Returns the time it was saved.
create or replace function private.skip_question(p_course text, p_meeting text, p_question text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_github_id bigint := private.member_github_id(p_course);
  v_meeting private.meetings;
  v_at timestamptz;
begin
  if v_github_id is null then
    raise exception 'you are not on this course''s team list' using errcode = '42501';
  end if;
  select * into v_meeting from private.meetings m where m.course_id = p_course and m.id = p_meeting;
  if not found then
    raise exception 'this meeting has no survey (yet); the site may be newer than its last deploy';
  end if;
  if private.answers_expired(v_meeting.date) then
    raise exception 'answers for this meeting were deleted 30 days after it';
  end if;
  if jsonb_typeof(v_meeting.questions -> p_question) is distinct from 'array'
     or jsonb_array_length(v_meeting.questions -> p_question) = 0 then
    raise exception 'this question has no survey';
  end if;
  insert into private.answers (course_id, meeting_id, question_id, github_id, answer, skipped)
    values (p_course, p_meeting, p_question, v_github_id, '{}'::jsonb, true)
    on conflict (course_id, meeting_id, question_id, github_id) do update
      set answer = '{}'::jsonb, skipped = true, updated_at = now()
    returning updated_at into v_at;
  return v_at;
end
$$;

-- Part 2's get_answers, now leaving out others' skips. Your own skip comes
-- back as an empty answer ({}), which a real answer never is. A skip unlocks
-- the others' answers to that question, like an answer does.
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
          and not a.skipped
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

revoke all on function private.unskip_answer() from public, anon, authenticated;
revoke all on function private.skip_question(text, text, text) from public, anon, authenticated;
grant execute on function private.skip_question(text, text, text) to authenticated;

create or replace function public.skip_question(p_course text, p_meeting text, p_question text) returns timestamptz
language sql security invoker set search_path = ''
as $$ select private.skip_question(p_course, p_meeting, p_question) $$;

revoke all on function public.skip_question(text, text, text) from public, anon;
grant execute on function public.skip_question(text, text, text) to authenticated;

-- ---------------------------------------------------------------- counting

-- When the meeting starts: the details' starts_at for courses managed on the
-- site, otherwise the start of the meeting's day (Zurich). Null if unknown.
create or replace function private.meeting_starts_at(p_course text, p_meeting text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when c.managed_in = 'site' then
      (private.current_part(p_course, p_meeting, 'details') -> 'content' ->> 'starts_at')::timestamptz
    else (m.date::timestamp at time zone 'Europe/Zurich')
  end
  from private.meetings m
  join private.courses c on c.id = m.course_id
  where m.course_id = p_course and m.id = p_meeting
$$;

-- The vote counts of one meeting, from the current answers:
-- {"<question id>": {"answered", "skipped", "fields": [{"id", "type", "answered",
--   "counts": [{"option", "count"}]}]}}, choice fields only, options in survey
-- order, plus "skipped" (how many skipped the question; skips are not votes).
-- Answers of people no longer on the team are not counted (as on the
-- Pre-meeting tab).
create or replace function private.live_tallies(p_course text, p_meeting text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with x as (
    select a.question_id, a.answer, a.skipped
    from private.answers a
    join private.members mem on mem.course_id = a.course_id and mem.github_id = a.github_id
    where a.course_id = p_course and a.meeting_id = p_meeting
  ), a as (select * from x where not x.skipped)
  select coalesce(jsonb_object_agg(q.key, jsonb_build_object(
    'answered', (select count(*) from a where a.question_id = q.key),
    'skipped', (select count(*) from x where x.question_id = q.key and x.skipped),
    'fields', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', f ->> 'id',
        'type', f ->> 'type',
        'answered', (select count(*) from a where a.question_id = q.key
                       and jsonb_typeof(a.answer -> (f ->> 'id')) in ('string', 'array')
                       and a.answer -> (f ->> 'id') not in ('""'::jsonb, '[]'::jsonb)),
        'counts', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'option', o.value,
            'count', (select count(*) from a where a.question_id = q.key and (a.answer -> (f ->> 'id')) ? o.value)
          ) order by o.n), '[]'::jsonb)
          from jsonb_array_elements_text(f -> 'options') with ordinality as o (value, n))
      ) order by fn), '[]'::jsonb)
      from jsonb_array_elements(q.value) with ordinality as s (f, fn)
      where f ->> 'type' in ('single', 'multiple')))), '{}'::jsonb)
  from private.meetings m, jsonb_each(m.questions) q
  where m.course_id = p_course and m.id = p_meeting
$$;

-- Keeps the current counts of one meeting (replacing the last snapshot).
-- Does nothing once the answers have expired, so the last real counts stay.
create or replace function private.snapshot_tallies(p_course text, p_meeting text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date date;
begin
  select m.date into v_date from private.meetings m where m.course_id = p_course and m.id = p_meeting;
  if not found or private.answers_expired(v_date) then
    return;
  end if;
  delete from private.tallies t where t.course_id = p_course and t.meeting_id = p_meeting;
  insert into private.tallies (course_id, meeting_id, question_id, tally)
    select p_course, p_meeting, x.key, x.value
    from jsonb_each(private.live_tallies(p_course, p_meeting)) x;
end
$$;

-- The counts to show: live while the answers exist, the snapshot afterwards.
create or replace function private.current_tallies(p_course text, p_meeting text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.answers_expired(m.date) then
      (select coalesce(jsonb_object_agg(t.question_id, t.tally), '{}'::jsonb)
         from private.tallies t where t.course_id = p_course and t.meeting_id = p_meeting)
    else private.live_tallies(p_course, p_meeting)
  end
  from private.meetings m
  where m.course_id = p_course and m.id = p_meeting
$$;

-- A snapshot is also taken whenever a new In-meeting version is saved (that
-- is when the summary is written).
create or replace function private.snapshot_on_in()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.part = 'in' then
    perform private.snapshot_tallies(new.course_id, new.meeting_id);
  end if;
  return new;
end
$$;

drop trigger if exists snapshot_tallies_on_in on private.revisions;
create trigger snapshot_tallies_on_in after insert on private.revisions
  for each row execute function private.snapshot_on_in();

-- The nightly clean-up (part 2) now keeps the counts before deleting answers.
create or replace function private.delete_old_answers()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
  r record;
begin
  for r in
    select distinct a.course_id, a.meeting_id
    from private.answers a
    join private.meetings m on m.course_id = a.course_id and m.id = a.meeting_id
    where private.answers_expired(m.date)
  loop
    delete from private.tallies t where t.course_id = r.course_id and t.meeting_id = r.meeting_id;
    insert into private.tallies (course_id, meeting_id, question_id, tally)
      select r.course_id, r.meeting_id, x.key, x.value
      from jsonb_each(private.live_tallies(r.course_id, r.meeting_id)) x;
  end loop;
  with gone as (
    delete from private.answers a
    using private.meetings m
    where m.course_id = a.course_id and m.id = a.meeting_id
      and private.answers_expired(m.date)
    returning 1
  )
  select count(*)::integer into v_count from gone;
  return v_count;
end
$$;

revoke all on function private.meeting_starts_at(text, text) from public, anon, authenticated;
revoke all on function private.live_tallies(text, text) from public, anon, authenticated;
revoke all on function private.snapshot_tallies(text, text) from public, anon, authenticated;
revoke all on function private.current_tallies(text, text) from public, anon, authenticated;
revoke all on function private.snapshot_on_in() from public, anon, authenticated;
revoke all on function private.delete_old_answers() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- the website

-- Vote counts of one meeting for a team member:
-- {"as_of", "starts_at", "visible", "visible_from", "questions", "locked"}.
-- "questions" has the counts of the questions you may see; "locked" lists the
-- others. With reveal "anytime" nothing is locked. With "after_answering", a
-- question unlocks once you answered or skipped it, and everything unlocks
-- 30 minutes before the meeting ("visible_from"; "visible": all unlocked).
create or replace function private.get_tallies(p_course text, p_meeting text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_github_id bigint := private.member_github_id(p_course);
  v_meeting private.meetings;
  v_starts timestamptz;
  v_from timestamptz;
  v_all boolean;
  v_tallies jsonb;
  v_mine text[];
begin
  if v_github_id is null then
    raise exception 'you are not on this course''s team list' using errcode = '42501';
  end if;
  select * into v_meeting from private.meetings m where m.course_id = p_course and m.id = p_meeting;
  if not found or (not v_meeting.published and private.organizer_github_id(p_course) is null
                   and exists (select 1 from private.courses c where c.id = p_course and c.managed_in = 'site')) then
    raise exception 'there is no meeting "%" in this course', p_meeting using errcode = 'PT404';
  end if;
  v_starts := private.meeting_starts_at(p_course, p_meeting);
  v_from := case when v_meeting.reveal = 'anytime' then null else v_starts - interval '30 minutes' end;
  v_all := v_meeting.reveal = 'anytime' or (v_from is not null and now() >= v_from)
           or private.answers_expired(v_meeting.date);
  v_tallies := private.current_tallies(p_course, p_meeting);
  select coalesce(array_agg(a.question_id), '{}') into v_mine
    from private.answers a
    where a.course_id = p_course and a.meeting_id = p_meeting and a.github_id = v_github_id;
  return jsonb_build_object(
    'as_of', now(),
    'starts_at', v_starts,
    'visible', v_all,
    'visible_from', v_from,
    'questions', (select coalesce(jsonb_object_agg(t.key, t.value), '{}'::jsonb)
                    from jsonb_each(v_tallies) t where v_all or t.key = any (v_mine)),
    'locked', (select coalesce(jsonb_agg(q.key order by q.key), '[]'::jsonb)
                 from jsonb_object_keys(v_meeting.questions) q (key)
                where not v_all and q.key <> all (v_mine)));
end
$$;

revoke all on function private.get_tallies(text, text) from public, anon, authenticated;
grant execute on function private.get_tallies(text, text) to authenticated;

create or replace function public.get_tallies(p_course text, p_meeting text) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.get_tallies(p_course, p_meeting) $$;

revoke all on function public.get_tallies(text, text) from public, anon;
grant execute on function public.get_tallies(text, text) to authenticated;

-- ---------------------------------------------------------------- the agent

-- Survey results of one meeting without names (see docs/agent-api.md).
create or replace function private.agent_get_responses(p_meeting text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(false);
  v_meeting private.meetings;
  v_pre jsonb;
  v_tallies jsonb;
  v_expired boolean;
begin
  select * into v_meeting from private.meetings m where m.course_id = k.course_id and m.id = p_meeting;
  if not found then
    raise exception 'there is no meeting "%" in this course', p_meeting using errcode = 'PT404';
  end if;
  v_pre := private.current_part(k.course_id, p_meeting, 'pre') -> 'content';
  v_expired := private.answers_expired(v_meeting.date);
  v_tallies := private.current_tallies(k.course_id, p_meeting);
  return (
    with a as (
      select a.question_id, a.answer, a.updated_at,
             -- P1, P2, …: the same person keeps the same label within this
             -- meeting; the order doesn't depend on who they are.
             'P' || dense_rank() over (order by md5(k.course_id || '/' || p_meeting || '/' || a.github_id::text)) as who
      from private.answers a
      join private.members mem on mem.course_id = a.course_id and mem.github_id = a.github_id
      where a.course_id = k.course_id and a.meeting_id = p_meeting and not v_expired and not a.skipped
    )
    select jsonb_build_object(
      'as_of', now(),
      'expired', v_expired,
      'members', (select count(*) from private.members mem where mem.course_id = k.course_id),
      'answered_any', (select count(distinct a.who) from a),
      'questions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', q ->> 'id',
          'text', q ->> 'text',
          'needs_meeting', coalesce((q ->> 'needs_meeting')::boolean, true),
          'answered', coalesce((v_tallies -> (q ->> 'id') ->> 'answered')::integer, 0),
          'skipped', coalesce((v_tallies -> (q ->> 'id') ->> 'skipped')::integer, 0),
          'fields', coalesce((
            select jsonb_agg(case
              when f ->> 'type' = 'text' then jsonb_build_object(
                'id', f ->> 'id', 'type', 'text', 'label', f ->> 'label',
                'texts', coalesce((
                  select jsonb_agg(jsonb_build_object('who', a.who, 'text', a.answer ->> (f ->> 'id')) order by a.updated_at)
                  from a where a.question_id = q ->> 'id'
                    and btrim(coalesce(a.answer ->> (f ->> 'id'), '')) <> ''), '[]'::jsonb))
              else jsonb_build_object(
                'id', f ->> 'id', 'type', f ->> 'type', 'label', f ->> 'label',
                'answered', coalesce((
                  select (tf ->> 'answered')::integer
                  from jsonb_array_elements(v_tallies -> (q ->> 'id') -> 'fields') tf
                  where tf ->> 'id' = f ->> 'id'), 0),
                'counts', coalesce((
                  select tf -> 'counts'
                  from jsonb_array_elements(v_tallies -> (q ->> 'id') -> 'fields') tf
                  where tf ->> 'id' = f ->> 'id'), '[]'::jsonb))
              end order by fn)
            from jsonb_array_elements(coalesce(q -> 'survey', '[]'::jsonb)) with ordinality as s (f, fn)), '[]'::jsonb)
        ) order by qn)
        from jsonb_array_elements(coalesce(v_pre -> 'questions', '[]'::jsonb)) with ordinality as x (q, qn)
        where jsonb_array_length(coalesce(q -> 'survey', '[]'::jsonb)) > 0), '[]'::jsonb))
  );
end
$$;

-- What the agent should do now, soonest first. Each item has "kind", "state"
-- ("due": do it now; "upcoming": not yet) and "due_at". For now one kind:
--   in_summary  write the In-meeting summary (consensus per survey question,
--               via agent_get_responses → agent_put_section "in"), due 30
--               minutes before the meeting. Listed from 7 days before until the
--               meeting ends, while a survey question has no consensus_md yet.
-- Later releases add kinds (scheduling, check-ins).
create or replace function private.agent_due()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(false);
begin
  return jsonb_build_object(
    'now', now(),
    'items', coalesce((
      select jsonb_agg(item order by item ->> 'due_at')
      from (
        select jsonb_build_object(
          'kind', 'in_summary',
          'meeting', x.id,
          'title', x.title,
          'starts_at', x.starts_at,
          'due_at', x.starts_at - interval '30 minutes',
          'state', case when now() >= x.starts_at - interval '30 minutes' then 'due' else 'upcoming' end,
          'missing', x.missing,
          'in_version', x.in_version,
          'links', private.meeting_links(k.course_id, x.id)) as item
        from (
          select m.id,
                 d -> 'content' ->> 'title' as title,
                 (d -> 'content' ->> 'starts_at')::timestamptz as starts_at,
                 coalesce((d -> 'content' ->> 'duration_min')::integer, 60) as duration,
                 (i ->> 'version')::integer as in_version,
                 (select coalesce(jsonb_agg(q.key order by q.key), '[]'::jsonb)
                    from jsonb_object_keys(m.questions) q (key)
                   where not exists (
                     select 1 from jsonb_array_elements(coalesce(i -> 'content' -> 'items', '[]'::jsonb)) it
                     where it ->> 'question' = q.key and btrim(coalesce(it ->> 'consensus_md', '')) <> '')) as missing
          from private.meetings m,
               lateral (select private.current_part(m.course_id, m.id, 'details') as d,
                               private.current_part(m.course_id, m.id, 'in') as i) p
          where m.course_id = k.course_id and m.published and m.questions <> '{}'::jsonb
        ) x
        where x.starts_at is not null
          and now() < x.starts_at + make_interval(mins => x.duration)
          and now() >= x.starts_at - interval '7 days'
          and jsonb_array_length(x.missing) > 0
      ) items), '[]'::jsonb));
end
$$;

revoke all on function private.agent_get_responses(text) from public, anon, authenticated;
revoke all on function private.agent_due() from public, anon, authenticated;
grant execute on function private.agent_get_responses(text), private.agent_due() to anon;

create or replace function public.agent_get_responses(meeting text) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_get_responses(meeting) $$;
create or replace function public.agent_due() returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_due() $$;

revoke all on function public.agent_get_responses(text), public.agent_due() from public, authenticated;
grant execute on function public.agent_get_responses(text), public.agent_due() to anon;
