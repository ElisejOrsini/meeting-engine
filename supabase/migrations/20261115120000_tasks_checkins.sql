-- meeting-engine database setup, part 6: tasks and written check-ins on the
-- timeline.
--
-- How to run it: like parts 1–5 (Supabase dashboard → SQL Editor → New query →
-- paste this whole file → Run). Parts 1–5 must have run first. Running it
-- again is safe.
--
-- What it adds:
--   private.timeline_items   tasks and written check-ins: a title, a due
--                            date, who (team members, or everyone), a
--                            description or the check-in's question; drafts
--                            (made by an agent) until an organizer publishes
--   private.checkin_updates  each person's written update to a check-in
--   private.step_choices     next steps of a meeting that an organizer added
--                            to the timeline as a task, or dismissed
--   For the website (signed-in team members):
--     public.get_course(course)                now also lists tasks and
--                                              check-ins, and for organizers
--                                              the suggested tasks
--     public.get_checkin(course, item)         a check-in with everyone's updates
--     public.save_checkin_update(course, item, text)   your own update ('' removes it)
--   For organizers:
--     public.add_item / update_item / delete_item / publish_item
--     public.add_suggested_task(course, meeting, key, item) / dismiss_suggestion
--   For an agent (see docs/agent-api.md):
--     public.agent_list_items / agent_get_checkin / agent_create_task /
--       agent_create_checkin / agent_update_item / agent_delete_item
--     public.agent_due()                       now also lists check-ins and drafts
--
-- Rules:
--   - Only the course's team sees tasks and check-ins; drafts only organizers.
--   - Everyone sees all check-in updates with names; agents too (decided
--     15 Nov 2026). Everyone writes or removes only their own update.
--   - Only organizers add, change, publish or delete items. An agent's items
--     are drafts, which it may change or delete until they are published.
--   - Check-in updates are deleted 60 days after the check-in's due date
--     (nightly), and hidden from then on. The check-in itself stays.

-- ---------------------------------------------------------------- tables

create table if not exists private.timeline_items (
  course_id text not null references private.courses (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  kind text not null check (kind in ('task', 'checkin')),
  title text not null check (char_length(title) between 1 and 200),
  due date not null,
  -- a task's description, or a check-in's question (Markdown)
  details_md text check (char_length(details_md) <= 5000),
  -- who: team members' GitHub ids; empty = everyone
  people bigint[] not null default '{}',
  -- the meeting a task was agreed in (no foreign key: a deleted meeting just
  -- drops the link)
  meeting_id text,
  published boolean not null default true,
  created_at timestamptz not null default now(),
  created_by_member bigint,
  created_by_key uuid,
  updated_at timestamptz not null default now(),
  primary key (course_id, id)
);

create table if not exists private.checkin_updates (
  course_id text not null,
  item_id uuid not null,
  github_id bigint not null,
  text text not null check (char_length(text) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (course_id, item_id, github_id),
  foreign key (course_id, item_id) references private.timeline_items (course_id, id) on delete cascade
);

create table if not exists private.step_choices (
  course_id text not null,
  meeting_id text not null,
  step_key text not null,
  choice text not null check (choice in ('added', 'dismissed')),
  item_id uuid,
  chosen_at timestamptz not null default now(),
  chosen_by bigint,
  primary key (course_id, meeting_id, step_key),
  foreign key (course_id, meeting_id) references private.meetings (course_id, id) on delete cascade
);

alter table private.timeline_items enable row level security;
alter table private.checkin_updates enable row level security;
alter table private.step_choices enable row level security;

-- ---------------------------------------------------------------- helpers

-- Check-in updates are kept until 60 days after the due date.
create or replace function private.updates_expired(p_due date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_due < (now() at time zone 'Europe/Zurich')::date - 60
$$;

-- The date in p_text ("YYYY-MM-DD"), or null if it isn't a real date.
create or replace function private.real_date(p_text text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_text is null or p_text !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return p_text::date;
exception when others then
  return null;
end
$$;

-- An item from what the site or an agent sent. p_kind 'task':
--   {"title", "due": "2026-11-20", "details_md"?, "people"?: ["login", …] or "everyone", "meeting"?}
-- p_kind 'checkin': the same with "question_md" instead of "details_md", no "meeting".
create or replace function private.parse_item(p_course text, p_kind text, p jsonb)
returns private.timeline_items
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i private.timeline_items;
  v_today date := (now() at time zone 'Europe/Zurich')::date;
  v_text_key text := case when p_kind = 'checkin' then 'question_md' else 'details_md' end;
  v_login jsonb;
  v_id bigint;
begin
  if p_kind is null or p_kind not in ('task', 'checkin') then
    raise exception 'kind: must be "task" or "checkin"';
  end if;
  if p_kind = 'task' then
    perform private.check_keys(p, 'task', '{title,due,details_md,people,meeting}', '{title,due}');
  else
    perform private.check_keys(p, 'checkin', '{title,due,question_md,people}', '{title,due}');
  end if;
  perform private.check_text(p, 'title', p_kind, 200, true);
  perform private.check_text(p, v_text_key, p_kind, 5000);
  if jsonb_typeof(p -> 'due') <> 'string' or (p ->> 'due') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '%.due: must be a date like 2026-11-20', p_kind;
  end if;
  begin
    i.due := (p ->> 'due')::date;
  exception when others then
    raise exception '%.due: "%" is not a real date', p_kind, p ->> 'due';
  end;
  if i.due < v_today - 365 or i.due > v_today + 365 then
    raise exception '%.due: must be within a year from today', p_kind;
  end if;
  i.course_id := p_course;
  i.kind := p_kind;
  i.title := btrim(p ->> 'title');
  i.details_md := nullif(btrim(coalesce(p ->> v_text_key, '')), '');
  i.people := '{}';
  if coalesce(jsonb_typeof(p -> 'people'), 'null') = 'null' or (p -> 'people') = '"everyone"'::jsonb then
    null; -- everyone
  elsif jsonb_typeof(p -> 'people') <> 'array' or jsonb_array_length(p -> 'people') > 100 then
    raise exception '%.people: a list of team members'' GitHub usernames, or "everyone"', p_kind;
  else
    for v_login in select * from jsonb_array_elements(p -> 'people') loop
      if v_login = '"everyone"'::jsonb then
        i.people := '{}';
        exit;
      end if;
      select m.github_id into v_id from private.members m
        where m.course_id = p_course and jsonb_typeof(v_login) = 'string'
          and lower(m.github_login) = lower(v_login #>> '{}');
      if v_id is null then
        raise exception '%.people: "%" is not on the team list', p_kind, v_login #>> '{}';
      end if;
      if not (v_id = any (i.people)) then
        i.people := i.people || v_id;
      end if;
      v_id := null;
    end loop;
  end if;
  if p_kind = 'task' and coalesce(jsonb_typeof(p -> 'meeting'), 'null') <> 'null' then
    if jsonb_typeof(p -> 'meeting') <> 'string'
       or not exists (select 1 from private.meetings m where m.course_id = p_course and m.id = p ->> 'meeting') then
      raise exception 'task.meeting: there is no meeting "%" in this course', p ->> 'meeting';
    end if;
    i.meeting_id := p ->> 'meeting';
  end if;
  return i;
end
$$;

-- An item as the site and the agent get it. p_me: the caller's GitHub id
-- (null for agents).
create or replace function private.item_json(i private.timeline_items, p_me bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', i.id,
    'kind', i.kind,
    'title', i.title,
    'due', i.due,
    (case when i.kind = 'checkin' then 'question_md' else 'details_md' end), i.details_md,
    'everyone', cardinality(i.people) = 0,
    'people', (select coalesce(jsonb_agg(m.github_login order by lower(m.github_login)), '[]'::jsonb)
                 from private.members m where m.course_id = i.course_id and m.github_id = any (i.people)),
    -- everyone it was for has left the team
    'nobody', cardinality(i.people) > 0 and not exists (
                select 1 from private.members m where m.course_id = i.course_id and m.github_id = any (i.people)),
    -- the meeting it was agreed in; a draft meeting only for organizers and agents
    'meeting', (select m.id from private.meetings m
                 where m.course_id = i.course_id and m.id = i.meeting_id
                   and (m.published or p_me is null or private.organizer_github_id(i.course_id) is not null)),
    'published', i.published,
    'created_by', case when i.created_by_key is not null
                    then 'agent:' || coalesce((select k.label from private.agent_keys k where k.id = i.created_by_key), 'agent')
                    else (select '@' || m.github_login from private.members m
                           where m.course_id = i.course_id and m.github_id = i.created_by_member) end,
    'for_me', p_me is not null and (cardinality(i.people) = 0 or p_me = any (i.people)),
    'expected', case when i.kind = 'checkin' then (
                  select count(*) from private.members m
                   where m.course_id = i.course_id and (cardinality(i.people) = 0 or m.github_id = any (i.people))) end,
    -- of the people it asks (anyone may write, but only they are counted)
    'written', case when i.kind = 'checkin' then (
                 select count(*) from private.checkin_updates u
                   join private.members m on m.course_id = u.course_id and m.github_id = u.github_id
                  where u.course_id = i.course_id and u.item_id = i.id and not private.updates_expired(i.due)
                    and (cardinality(i.people) = 0 or u.github_id = any (i.people))) end,
    'mine', case when i.kind = 'checkin' then p_me is not null and exists (
              select 1 from private.checkin_updates u
               where u.course_id = i.course_id and u.item_id = i.id and u.github_id = p_me
                 and not private.updates_expired(i.due)) end)
$$;

-- A check-in with everyone's updates (names) and who hasn't written yet.
create or replace function private.checkin_json(i private.timeline_items, p_me bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.item_json(i, p_me) || jsonb_build_object(
    'expired', private.updates_expired(i.due),
    'updates', case when private.updates_expired(i.due) then '[]'::jsonb else (
                 select coalesce(jsonb_agg(jsonb_build_object(
                          'login', m.github_login, 'text', u.text, 'updated_at', u.updated_at)
                          order by u.updated_at), '[]'::jsonb)
                   from private.checkin_updates u
                   join private.members m on m.course_id = u.course_id and m.github_id = u.github_id
                  where u.course_id = i.course_id and u.item_id = i.id) end,
    'not_written', case when private.updates_expired(i.due) then '[]'::jsonb else (
                     select coalesce(jsonb_agg(m.github_login order by lower(m.github_login)), '[]'::jsonb)
                       from private.members m
                      where m.course_id = i.course_id
                        and (cardinality(i.people) = 0 or m.github_id = any (i.people))
                        and not exists (select 1 from private.checkin_updates u
                                         where u.course_id = i.course_id and u.item_id = i.id
                                           and u.github_id = m.github_id)) end)
$$;

-- A next step's key: stable as long as its text and due date stay the same.
create or replace function private.step_key(p_step jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(md5(coalesce(p_step ->> 'what_md', '') || '|' || coalesce(p_step ->> 'due', '')), 16)
$$;

-- Suggested tasks (organizers): next steps of published meetings with a real
-- due date from a week ago on, that nobody has added or dismissed yet. Keys
-- are unique within a meeting: a repeated next step (same text and date)
-- gets its position mixed in.
create or replace function private.suggestions_json(p_course text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'meeting', x.meeting_id, 'meeting_title', x.title, 'key', x.key,
           'what_md', x.step ->> 'what_md', 'owner', x.step ->> 'owner', 'due', x.step ->> 'due',
           'people', x.people) order by x.due, x.meeting_id, x.key), '[]'::jsonb)
  from (
    select y.*,
           case when y.n = 1 then y.base
                else left(md5(y.base || '|' || y.n), 16) end as key
    from (
      select m.id as meeting_id,
             private.current_part(m.course_id, m.id, 'details') -> 'content' ->> 'title' as title,
             st as step,
             private.real_date(st ->> 'due') as due,
             private.step_key(st) as base,
             row_number() over (partition by m.id, private.step_key(st) order by pos) as n,
             -- the owner, if it is a team member's username or name
             (select coalesce(jsonb_agg(mm.github_login), '[]'::jsonb) from private.members mm
               where mm.course_id = m.course_id
                 and (lower(mm.github_login) = lower(btrim(coalesce(st ->> 'owner', ''), ' @'))
                      or lower(mm.display_name) = lower(btrim(coalesce(st ->> 'owner', ''))))) as people
      from private.meetings m,
           jsonb_array_elements(coalesce(
             private.current_part(m.course_id, m.id, 'post') -> 'content' -> 'next_steps', '[]'::jsonb))
             with ordinality as e (st, pos)
      where m.course_id = p_course and m.published
    ) y
    where y.due is not null and y.due >= (now() at time zone 'Europe/Zurich')::date - 7
  ) x
  where not exists (select 1 from private.step_choices c
                     where c.course_id = p_course and c.meeting_id = x.meeting_id and c.step_key = x.key)
$$;

-- The item of a course an organizer or member may see (drafts: organizers).
create or replace function private.visible_item(p_course text, p_id uuid)
returns private.timeline_items
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i private.timeline_items;
begin
  select * into i from private.timeline_items t
    where t.course_id = p_course and t.id = p_id
      and (t.published or private.organizer_github_id(p_course) is not null);
  if not found then
    raise exception 'there is no such task or check-in in this course' using errcode = 'PT404';
  end if;
  return i;
end
$$;

-- Makes a uuid from text, or raises HTTP 404 (instead of an ugly cast error).
create or replace function private.item_uuid(p_id text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p_id::uuid;
exception when others then
  raise exception 'there is no such task or check-in in this course' using errcode = 'PT404';
end
$$;

revoke all on function private.updates_expired(date) from public, anon, authenticated;
revoke all on function private.real_date(text) from public, anon, authenticated;
revoke all on function private.parse_item(text, text, jsonb) from public, anon, authenticated;
revoke all on function private.item_json(private.timeline_items, bigint) from public, anon, authenticated;
revoke all on function private.checkin_json(private.timeline_items, bigint) from public, anon, authenticated;
revoke all on function private.step_key(jsonb) from public, anon, authenticated;
revoke all on function private.suggestions_json(text) from public, anon, authenticated;
revoke all on function private.visible_item(text, uuid) from public, anon, authenticated;
revoke all on function private.item_uuid(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- the website: reading

-- Part 5's get_course, plus "items" (tasks and check-ins; drafts for
-- organizers) and, for organizers, "suggestions" (suggested tasks).
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
      'schedules', (select coalesce(jsonb_agg(private.schedule_summary(s, v_me) order by s.days[1], s.meeting_id), '[]'::jsonb)
                    from private.schedules s
                    join private.meetings m on m.course_id = s.course_id and m.id = s.meeting_id
                    where s.course_id = p_course and s.open and (m.published or v_organizer)
                      and s.days[cardinality(s.days)] >= (now() at time zone 'Europe/Zurich')::date),
      'items', (select coalesce(jsonb_agg(private.item_json(t, v_me) order by t.due, t.created_at), '[]'::jsonb)
                from private.timeline_items t
                where t.course_id = p_course and (t.published or v_organizer)),
      'suggestions', case when v_organizer then private.suggestions_json(p_course) else '[]'::jsonb end,
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

create or replace function private.get_checkin(p_course text, p_item text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_member(p_course);
  i private.timeline_items := private.visible_item(p_course, private.item_uuid(p_item));
begin
  if i.kind <> 'checkin' then
    raise exception 'this is a task, not a check-in' using errcode = 'PT404';
  end if;
  return private.checkin_json(i, v_me);
end
$$;

-- ---------------------------------------------------------------- the website: everyone

-- Saves your update to a published check-in; empty text removes it.
create or replace function private.save_checkin_update(p_course text, p_item text, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_member(p_course);
  i private.timeline_items := private.visible_item(p_course, private.item_uuid(p_item));
  v_text text := btrim(coalesce(p_text, ''));
begin
  if i.kind <> 'checkin' or not i.published then
    raise exception 'there is no such check-in to write to' using errcode = 'PT404';
  end if;
  if private.updates_expired(i.due) then
    raise exception 'this check-in is closed: its updates were deleted 60 days after it was due' using errcode = 'PT409';
  end if;
  if char_length(v_text) > 4000 then
    raise exception 'text: at most 4000 characters';
  end if;
  if v_text = '' then
    delete from private.checkin_updates u
      where u.course_id = p_course and u.item_id = i.id and u.github_id = v_me;
    return jsonb_build_object('saved_at', now(), 'text', null);
  end if;
  insert into private.checkin_updates (course_id, item_id, github_id, text)
    values (p_course, i.id, v_me, v_text)
  on conflict (course_id, item_id, github_id) do update set text = excluded.text, updated_at = now();
  return jsonb_build_object('saved_at', now(), 'text', v_text);
end
$$;

-- ---------------------------------------------------------------- the website: organizers

create or replace function private.add_item(p_course text, p_kind text, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_organizer(p_course);
  i private.timeline_items := private.parse_item(p_course, p_kind, p_item);
begin
  insert into private.timeline_items (course_id, kind, title, due, details_md, people, meeting_id, published, created_by_member)
    values (p_course, i.kind, i.title, i.due, i.details_md, i.people, i.meeting_id, true, v_me)
    returning * into i;
  return private.item_json(i, v_me);
end
$$;

-- Replaces an item's fields (its kind stays). Organizers, published or not.
create or replace function private.update_item(p_course text, p_item text, p_fields jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_organizer(p_course);
  i private.timeline_items := private.visible_item(p_course, private.item_uuid(p_item));
  n private.timeline_items := private.parse_item(p_course, i.kind, p_fields);
begin
  update private.timeline_items t set
    title = n.title, due = n.due, details_md = n.details_md, people = n.people,
    -- the meeting link stays unless "meeting" is given (null removes it)
    meeting_id = case when p_fields ? 'meeting' then n.meeting_id else t.meeting_id end,
    updated_at = now()
    where t.course_id = p_course and t.id = i.id
    returning * into i;
  return private.item_json(i, v_me);
end
$$;

create or replace function private.delete_item(p_course text, p_item text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := private.item_uuid(p_item);
begin
  perform private.require_organizer(p_course);
  delete from private.timeline_items t where t.course_id = p_course and t.id = v_id;
  if not found then
    raise exception 'there is no such task or check-in in this course' using errcode = 'PT404';
  end if;
end
$$;

create or replace function private.publish_item(p_course text, p_item text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_organizer(p_course);
  i private.timeline_items := private.visible_item(p_course, private.item_uuid(p_item));
begin
  update private.timeline_items t set published = true, updated_at = now()
    where t.course_id = p_course and t.id = i.id
    returning * into i;
  return private.item_json(i, v_me);
end
$$;

-- Turns a suggested task (a meeting's next step) into a task. p_item may
-- change the title, due date and who; the task links to the meeting.
create or replace function private.add_suggested_task(p_course text, p_meeting text, p_key text, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_organizer(p_course);
  i private.timeline_items;
begin
  if not exists (select 1 from jsonb_array_elements(private.suggestions_json(p_course)) s
                  where s ->> 'meeting' = p_meeting and s ->> 'key' = p_key) then
    raise exception 'this suggestion is gone (added, dismissed or changed meanwhile)' using errcode = 'PT409';
  end if;
  i := private.parse_item(p_course, 'task', jsonb_set(p_item, '{meeting}', to_jsonb(p_meeting)));
  -- Claim the suggestion first: a second click (or organizer) at the same
  -- moment waits on this row and then finds it taken.
  insert into private.step_choices (course_id, meeting_id, step_key, choice, chosen_by)
    values (p_course, p_meeting, p_key, 'added', v_me)
  on conflict (course_id, meeting_id, step_key) do nothing;
  if not found then
    raise exception 'this suggestion is gone (added, dismissed or changed meanwhile)' using errcode = 'PT409';
  end if;
  insert into private.timeline_items (course_id, kind, title, due, details_md, people, meeting_id, published, created_by_member)
    values (p_course, 'task', i.title, i.due, i.details_md, i.people, i.meeting_id, true, v_me)
    returning * into i;
  update private.step_choices c set item_id = i.id
    where c.course_id = p_course and c.meeting_id = p_meeting and c.step_key = p_key;
  return private.item_json(i, v_me);
end
$$;

create or replace function private.dismiss_suggestion(p_course text, p_meeting text, p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_organizer(p_course);
begin
  if not exists (select 1 from private.meetings m where m.course_id = p_course and m.id = p_meeting) then
    raise exception 'there is no meeting "%" in this course', p_meeting using errcode = 'PT404';
  end if;
  if p_key is null or p_key !~ '^[0-9a-f]{16}$' then
    raise exception 'key: not a suggestion key';
  end if;
  insert into private.step_choices (course_id, meeting_id, step_key, choice, chosen_by)
    values (p_course, p_meeting, p_key, 'dismissed', v_me)
  on conflict (course_id, meeting_id, step_key) do update
    set choice = 'dismissed', item_id = null, chosen_at = now(), chosen_by = excluded.chosen_by;
end
$$;

-- ---------------------------------------------------------------- agents

-- Every task and check-in (drafts too), soonest first.
create or replace function private.agent_list_items()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(false);
begin
  return jsonb_build_object('items', (
    select coalesce(jsonb_agg(private.item_json(t, null)
                              || jsonb_build_object('links', private.item_links(k.course_id, t.id))
                              order by t.due, t.created_at), '[]'::jsonb)
    from private.timeline_items t where t.course_id = k.course_id));
end
$$;

create or replace function private.agent_get_checkin(p_item text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(false);
  i private.timeline_items;
begin
  select * into i from private.timeline_items t
    where t.course_id = k.course_id and t.id = private.item_uuid(p_item) and t.kind = 'checkin';
  if not found then
    raise exception 'there is no such check-in in this course' using errcode = 'PT404';
  end if;
  return private.checkin_json(i, null) || jsonb_build_object('links', private.item_links(k.course_id, i.id));
end
$$;

-- A task or check-in as a draft; an organizer publishes it on the site.
create or replace function private.agent_create_item(p_kind text, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(true);
  i private.timeline_items := private.parse_item(k.course_id, p_kind, p_item);
begin
  if (select count(*) from private.timeline_items t
       where t.course_id = k.course_id and not t.published) >= 200 then
    raise exception 'too many drafts (200): ask an organizer to publish or delete some' using errcode = 'PT409';
  end if;
  insert into private.timeline_items (course_id, kind, title, due, details_md, people, meeting_id, published, created_by_key)
    values (k.course_id, i.kind, i.title, i.due, i.details_md, i.people, i.meeting_id, false, k.id)
    returning * into i;
  return private.item_json(i, null) || jsonb_build_object('links', private.item_links(k.course_id, i.id));
end
$$;

-- Changes or deletes a draft (not yet published).
create or replace function private.agent_draft(k private.agent_keys, p_item text)
returns private.timeline_items
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i private.timeline_items;
begin
  select * into i from private.timeline_items t where t.course_id = k.course_id and t.id = private.item_uuid(p_item);
  if not found then
    raise exception 'there is no such task or check-in in this course' using errcode = 'PT404';
  end if;
  if i.published then
    raise exception 'this item is published: only organizers can change it now' using errcode = 'PT409';
  end if;
  return i;
end
$$;

create or replace function private.agent_update_item(p_item text, p_fields jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(true);
  i private.timeline_items := private.agent_draft(k, p_item);
  n private.timeline_items := private.parse_item(k.course_id, i.kind, p_fields);
begin
  update private.timeline_items t set
    title = n.title, due = n.due, details_md = n.details_md, people = n.people,
    meeting_id = case when p_fields ? 'meeting' then n.meeting_id else t.meeting_id end,
    updated_at = now()
    where t.course_id = k.course_id and t.id = i.id and not t.published -- (published meanwhile?)
    returning * into i;
  if not found then
    raise exception 'this item is published: only organizers can change it now' using errcode = 'PT409';
  end if;
  return private.item_json(i, null) || jsonb_build_object('links', private.item_links(k.course_id, i.id));
end
$$;

create or replace function private.agent_delete_item(p_item text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(true);
  i private.timeline_items := private.agent_draft(k, p_item);
begin
  delete from private.timeline_items t where t.course_id = k.course_id and t.id = i.id and not t.published;
  if not found then
    raise exception 'this item is published: only organizers can change it now' using errcode = 'PT409';
  end if;
end
$$;

-- The item on the site's timeline.
create or replace function private.item_links(p_course text, p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when c.site_url is null then '{}'::jsonb
              else jsonb_build_object('timeline', c.site_url || '#/timeline?open=item-' || p_id) end
  from private.courses c where c.id = p_course
$$;

-- Part 5's "what's due" list, plus:
--   "checkin"  a published check-in from 3 days before its due date until 2
--              days after, while someone it is meant for hasn't written:
--              state "upcoming", "due" (due today or tomorrow: remind
--              not_written) or "overdue"
--   "draft"    a task or check-in waiting for an organizer to publish it
create or replace function private.agent_due()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(false);
  v_today date := (now() at time zone 'Europe/Zurich')::date;
begin
  return jsonb_build_object(
    'now', now(),
    'items', coalesce((
      select jsonb_agg(item order by (item ->> 'due_at')::timestamptz, item ->> 'meeting', item ->> 'item')
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
                 coalesce((d -> 'content' ->> 'duration_min')::numeric::integer, 60) as duration,
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

        union all

        select jsonb_build_object(
          'kind', 'schedule',
          'meeting', y.meeting_id,
          'title', y.title,
          'first_day', y.days[1],
          'last_day', y.days[cardinality(y.days)],
          'members', y.members,
          'filled_in', y.filled_in,
          'not_filled_in', y.not_filled_in,
          'suggestion', y.suggestion,
          'due_at', y.due_at,
          'state', case when not y.published then 'draft'
                        when y.suggestion is not null then 'suggested'
                        when y.filled_in >= y.members or now() >= y.due_at then 'due'
                        else 'waiting' end,
          'links', private.meeting_links(k.course_id, y.meeting_id))
        from (
          select s.meeting_id, s.days, s.suggestion, m.published,
                 private.current_part(s.course_id, s.meeting_id, 'details') -> 'content' ->> 'title' as title,
                 ((s.days[1] - 2) + time '00:00') at time zone 'Europe/Zurich' as due_at,
                 (select count(*) from private.members mm where mm.course_id = s.course_id) as members,
                 (select count(*) from private.availability a
                    join private.members mm on mm.course_id = a.course_id and mm.github_id = a.github_id
                   where a.course_id = s.course_id and a.meeting_id = s.meeting_id) as filled_in,
                 (select coalesce(jsonb_agg(mm.github_login order by lower(mm.github_login)), '[]'::jsonb)
                    from private.members mm
                   where mm.course_id = s.course_id
                     and not exists (select 1 from private.availability a
                                      where a.course_id = s.course_id and a.meeting_id = s.meeting_id
                                        and a.github_id = mm.github_id)) as not_filled_in
          from private.schedules s
          join private.meetings m on m.course_id = s.course_id and m.id = s.meeting_id
          where s.course_id = k.course_id and s.open and s.days[cardinality(s.days)] >= v_today
        ) y

        union all

        select jsonb_build_object(
          'kind', 'checkin',
          'item', c.id,
          'title', c.title,
          'due', c.due,
          'due_at', (c.due + time '00:00') at time zone 'Europe/Zurich',
          'state', case when c.due < v_today then 'overdue'
                        when c.due <= v_today + 1 then 'due'
                        else 'upcoming' end,
          'expected', c.j -> 'expected',
          'written', c.j -> 'written',
          'not_written', c.j -> 'not_written',
          'links', private.item_links(k.course_id, c.id))
        from (
          select t.id, t.title, t.due, private.checkin_json(t, null) as j
          from private.timeline_items t
          where t.course_id = k.course_id and t.kind = 'checkin' and t.published
            and t.due between v_today - 2 and v_today + 3
        ) c
        where jsonb_array_length(c.j -> 'not_written') > 0

        union all

        select jsonb_build_object(
          'kind', 'draft',
          'item', t.id,
          'item_kind', t.kind,
          'title', t.title,
          'due', t.due,
          'due_at', t.created_at,
          'state', 'draft',
          'links', private.item_links(k.course_id, t.id))
        from private.timeline_items t
        where t.course_id = k.course_id and not t.published
      ) items), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------- deleting old updates

create or replace function private.delete_old_checkin_updates()
returns integer
language sql
set search_path = ''
as $$
  with gone as (
    delete from private.checkin_updates u
    using private.timeline_items t
    where t.course_id = u.course_id and t.id = u.item_id and private.updates_expired(t.due)
    returning 1
  )
  select count(*)::integer from gone
$$;

revoke all on function private.delete_old_checkin_updates() from public, anon, authenticated, service_role;

-- Every night at 03:37 UTC, with the scheduler (pg_cron) that part 2 set up.
-- Only uses it: "create extension" on an installed pg_cron re-runs
-- Supabase's own permission script, which fails and would undo this file.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('meeting-engine-delete-old-checkin-updates', '37 3 * * *',
      'select private.delete_old_checkin_updates()');
  else
    raise notice 'pg_cron is not set up (part 2 does that): old check-in updates are hidden, but not deleted';
  end if;
end
$$;

-- ---------------------------------------------------------------- permissions and the API

revoke all on function private.get_course(text) from public, anon, authenticated;
revoke all on function private.get_checkin(text, text) from public, anon, authenticated;
revoke all on function private.save_checkin_update(text, text, text) from public, anon, authenticated;
revoke all on function private.add_item(text, text, jsonb) from public, anon, authenticated;
revoke all on function private.update_item(text, text, jsonb) from public, anon, authenticated;
revoke all on function private.delete_item(text, text) from public, anon, authenticated;
revoke all on function private.publish_item(text, text) from public, anon, authenticated;
revoke all on function private.add_suggested_task(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function private.dismiss_suggestion(text, text, text) from public, anon, authenticated;
revoke all on function private.agent_list_items() from public, anon, authenticated;
revoke all on function private.agent_get_checkin(text) from public, anon, authenticated;
revoke all on function private.agent_create_item(text, jsonb) from public, anon, authenticated;
revoke all on function private.agent_draft(private.agent_keys, text) from public, anon, authenticated;
revoke all on function private.agent_update_item(text, jsonb) from public, anon, authenticated;
revoke all on function private.agent_delete_item(text) from public, anon, authenticated;
revoke all on function private.item_links(text, uuid) from public, anon, authenticated;
revoke all on function private.agent_due() from public, anon, authenticated;

grant execute on function private.get_course(text), private.get_checkin(text, text),
  private.save_checkin_update(text, text, text), private.add_item(text, text, jsonb),
  private.update_item(text, text, jsonb), private.delete_item(text, text), private.publish_item(text, text),
  private.add_suggested_task(text, text, text, jsonb), private.dismiss_suggestion(text, text, text)
  to authenticated;
grant execute on function private.agent_list_items(), private.agent_get_checkin(text),
  private.agent_create_item(text, jsonb), private.agent_update_item(text, jsonb),
  private.agent_delete_item(text), private.agent_due()
  to anon;

create or replace function public.get_checkin(p_course text, p_item text) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.get_checkin(p_course, p_item) $$;
create or replace function public.save_checkin_update(p_course text, p_item text, p_text text) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.save_checkin_update(p_course, p_item, p_text) $$;
create or replace function public.add_item(p_course text, p_kind text, p_item jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.add_item(p_course, p_kind, p_item) $$;
create or replace function public.update_item(p_course text, p_item text, p_fields jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.update_item(p_course, p_item, p_fields) $$;
create or replace function public.delete_item(p_course text, p_item text) returns void
language sql security invoker set search_path = ''
as $$ select private.delete_item(p_course, p_item) $$;
create or replace function public.publish_item(p_course text, p_item text) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.publish_item(p_course, p_item) $$;
create or replace function public.add_suggested_task(p_course text, p_meeting text, p_key text, p_item jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.add_suggested_task(p_course, p_meeting, p_key, p_item) $$;
create or replace function public.dismiss_suggestion(p_course text, p_meeting text, p_key text) returns void
language sql security invoker set search_path = ''
as $$ select private.dismiss_suggestion(p_course, p_meeting, p_key) $$;

revoke all on function public.get_checkin(text, text), public.save_checkin_update(text, text, text),
  public.add_item(text, text, jsonb), public.update_item(text, text, jsonb), public.delete_item(text, text),
  public.publish_item(text, text), public.add_suggested_task(text, text, text, jsonb),
  public.dismiss_suggestion(text, text, text)
  from public, anon;
grant execute on function public.get_checkin(text, text), public.save_checkin_update(text, text, text),
  public.add_item(text, text, jsonb), public.update_item(text, text, jsonb), public.delete_item(text, text),
  public.publish_item(text, text), public.add_suggested_task(text, text, text, jsonb),
  public.dismiss_suggestion(text, text, text)
  to authenticated;

create or replace function public.agent_list_items() returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_list_items() $$;
create or replace function public.agent_get_checkin(item text) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_get_checkin(item) $$;
create or replace function public.agent_create_task(title text, due text, details_md text default null,
  people jsonb default null, meeting text default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_create_item('task', jsonb_strip_nulls(jsonb_build_object(
  'title', title, 'due', due, 'details_md', details_md, 'people', people, 'meeting', meeting))) $$;
create or replace function public.agent_create_checkin(title text, due text, question_md text default null,
  people jsonb default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_create_item('checkin', jsonb_strip_nulls(jsonb_build_object(
  'title', title, 'due', due, 'question_md', question_md, 'people', people))) $$;
create or replace function public.agent_update_item(item text, fields jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_update_item(item, fields) $$;
create or replace function public.agent_delete_item(item text) returns void
language sql security invoker set search_path = ''
as $$ select private.agent_delete_item(item) $$;

revoke all on function public.agent_list_items(), public.agent_get_checkin(text),
  public.agent_create_task(text, text, text, jsonb, text), public.agent_create_checkin(text, text, text, jsonb),
  public.agent_update_item(text, jsonb), public.agent_delete_item(text)
  from public, authenticated;
grant execute on function public.agent_list_items(), public.agent_get_checkin(text),
  public.agent_create_task(text, text, text, jsonb, text), public.agent_create_checkin(text, text, text, jsonb),
  public.agent_update_item(text, jsonb), public.agent_delete_item(text)
  to anon;
