-- meeting-engine database setup, part 5: finding a time for a meeting.
--
-- How to run it: like parts 1–4 (Supabase dashboard → SQL Editor → New query →
-- paste this whole file → Run). Parts 1–4 must have run first. Running it
-- again is safe.
--
-- What it adds:
--   private.schedules        a meeting's "find a time" grid: the days, the
--                            hours, the slot length and the meeting's length;
--                            open until an organizer picks a time
--   private.availability     each person's free slots in a grid
--   For the website (signed-in team members):
--     public.get_course(course)                now also lists the open grids
--     public.get_schedule(course, meeting)     the grid, everyone's times
--                                              (with names) and the best times
--     public.save_availability(course, meeting, slots)   your own free slots
--   For organizers:
--     public.add_meeting(course, details, schedule)   a new meeting, visible
--                                              to the team at once; with a
--                                              schedule it starts by finding
--                                              a time
--     public.pick_time(course, meeting, starts_at)    sets the time, closes the grid
--     public.cancel_schedule(course, meeting)         stops finding a time
--   For an agent (see docs/agent-api.md):
--     public.agent_open_scheduling(meeting, days, …)  opens (or changes) a grid
--     public.agent_get_availability(meeting)          who is free when, best times
--     public.agent_suggest_time(meeting, starts_at, note)   a suggestion only;
--                                              an organizer picks the time
--     public.agent_due()                       now also lists open grids
--   And: a question's vote counts become visible to the whole team once it
--   has an AI summary (public.get_tallies).
--
-- Rules:
--   - Only the course's team sees a grid, with names (like when2meet); agents
--     see the names too (decided 14 Nov 2026). Drafts only organizers.
--   - Everyone changes only their own times. Only organizers pick the time;
--     an agent may only suggest one.
--   - Times are in the course's time zone (Europe/Zurich).
--   - Availability is deleted 30 days after the meeting (nightly, like survey
--     answers), and hidden from then on.

-- ---------------------------------------------------------------- tables

create table if not exists private.schedules (
  course_id text not null,
  meeting_id text not null,
  days date[] not null check (cardinality(days) between 1 and 14),
  day_from time not null,
  day_to time not null,
  slot_min integer not null default 30 check (slot_min in (15, 30, 60)),
  duration_min integer not null default 60 check (duration_min between 15 and 480),
  open boolean not null default true,
  -- {"starts_at", "note", "by", "at"}: the agent's suggestion, if any
  suggestion jsonb,
  created_at timestamptz not null default now(),
  picked_at timestamptz,
  picked_by bigint,
  primary key (course_id, meeting_id),
  foreign key (course_id, meeting_id) references private.meetings (course_id, id) on delete cascade,
  check (day_from < day_to)
);

create table if not exists private.availability (
  course_id text not null,
  meeting_id text not null,
  github_id bigint not null,
  slots timestamptz[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (course_id, meeting_id, github_id),
  foreign key (course_id, meeting_id) references private.schedules (course_id, meeting_id) on delete cascade
);

alter table private.schedules enable row level security;
alter table private.availability enable row level security;

-- ---------------------------------------------------------------- the grid

-- Every slot start of a grid, in order (the days' hours in Zurich time).
create or replace function private.grid_slots(p_days date[], p_from time, p_to time, p_slot integer)
returns timestamptz[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(t order by t), '{}')
  from unnest(p_days) d,
       generate_series(((d + p_from) at time zone 'Europe/Zurich'),
                       ((d + p_to) at time zone 'Europe/Zurich') - make_interval(mins => p_slot),
                       make_interval(mins => p_slot)) t
$$;

create or replace function private.schedule_grid(s private.schedules)
returns timestamptz[]
language sql
stable
set search_path = ''
as $$
  select private.grid_slots(s.days, s.day_from, s.day_to, s.slot_min)
$$;

-- The slots a meeting starting at p_start covers.
create or replace function private.meeting_slots(s private.schedules, p_start timestamptz)
returns timestamptz[]
language sql
stable
set search_path = ''
as $$
  select array(select generate_series(p_start,
                                      p_start + make_interval(mins => s.duration_min - s.slot_min),
                                      make_interval(mins => s.slot_min)))
$$;

-- A grid from what the site or an agent sent:
-- {"days": ["2026-11-23", …], "from": "09:00", "to": "18:00", "slot_min": 30, "duration_min": 60}
-- p_duration: the meeting's length when "duration_min" is not given.
create or replace function private.parse_schedule(p jsonb, p_duration integer)
returns private.schedules
language plpgsql
stable
set search_path = ''
as $$
declare
  s private.schedules;
  v_item jsonb;
  v_days date[] := '{}';
  v_today date := (now() at time zone 'Europe/Zurich')::date;
  v_hours integer;
begin
  perform private.check_keys(p, 'schedule', '{days,from,to,slot_min,duration_min}', '{days}');
  if jsonb_typeof(p -> 'days') <> 'array' or jsonb_array_length(p -> 'days') not between 1 and 14 then
    raise exception 'schedule.days: give 1 to 14 days, like ["2026-11-23", "2026-11-24"]';
  end if;
  for v_item in select * from jsonb_array_elements(p -> 'days') loop
    if jsonb_typeof(v_item) <> 'string' or (v_item #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'schedule.days: "%" is not a date like 2026-11-23', v_item #>> '{}';
    end if;
    begin
      v_days := v_days || (v_item #>> '{}')::date;
    exception when others then
      raise exception 'schedule.days: "%" is not a real date', v_item #>> '{}';
    end;
  end loop;
  select array_agg(distinct d order by d) into s.days from unnest(v_days) d;
  if cardinality(s.days) <> cardinality(v_days) then
    raise exception 'schedule.days: a day is listed twice';
  end if;
  if s.days[1] < v_today then
    raise exception 'schedule.days: % is in the past', s.days[1];
  end if;
  if s.days[cardinality(s.days)] - s.days[1] > 27 then
    raise exception 'schedule.days: all days must lie within 4 weeks';
  end if;

  foreach v_item in array array[coalesce(p -> 'from', '"09:00"'), coalesce(p -> 'to', '"18:00"')] loop
    if jsonb_typeof(v_item) <> 'string' or (v_item #>> '{}') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
      raise exception 'schedule.from/to: "%" is not a time like 09:00', v_item #>> '{}';
    end if;
  end loop;
  s.day_from := coalesce(p ->> 'from', '09:00')::time;
  s.day_to := coalesce(p ->> 'to', '18:00')::time;
  if s.day_from >= s.day_to then
    raise exception 'schedule: "from" (%) must be before "to" (%)', to_char(s.day_from, 'HH24:MI'), to_char(s.day_to, 'HH24:MI');
  end if;

  if coalesce(jsonb_typeof(p -> 'slot_min'), 'null') = 'null' then
    s.slot_min := 30;
  elsif jsonb_typeof(p -> 'slot_min') <> 'number' then
    raise exception 'schedule.slot_min: must be 15, 30 or 60';
  elsif (p ->> 'slot_min')::numeric not in (15, 30, 60) then
    raise exception 'schedule.slot_min: must be 15, 30 or 60';
  else
    s.slot_min := (p ->> 'slot_min')::numeric::integer;
  end if;
  if (extract(hour from s.day_from) * 60 + extract(minute from s.day_from))::integer % s.slot_min <> 0
     or (extract(hour from s.day_to) * 60 + extract(minute from s.day_to))::integer % s.slot_min <> 0 then
    raise exception 'schedule: "from" and "to" must be on the slot grid (every % minutes)', s.slot_min;
  end if;

  if coalesce(jsonb_typeof(p -> 'duration_min'), 'null') = 'null' then
    s.duration_min := coalesce(p_duration, 60);
  elsif jsonb_typeof(p -> 'duration_min') <> 'number' or (p ->> 'duration_min') !~ '^\d{1,3}(\.0+)?$' then
    raise exception 'schedule.duration_min: must be a whole number of minutes';
  else
    s.duration_min := (p ->> 'duration_min')::numeric::integer;
  end if;
  v_hours := (extract(epoch from (s.day_to - s.day_from)) / 60)::integer;
  if s.duration_min not between 15 and 480 or s.duration_min % s.slot_min <> 0 or s.duration_min > v_hours then
    raise exception 'schedule.duration_min: % minutes must be a multiple of % and fit between % and %',
      s.duration_min, s.slot_min, to_char(s.day_from, 'HH24:MI'), to_char(s.day_to, 'HH24:MI');
  end if;
  s.open := true;
  return s;
end
$$;

-- Saves a grid for a meeting (new, or changed). Opens it again if a time was
-- picked before. When it changes, people's times are kept for the slots that
-- still exist; someone with none left has to answer again (their row goes,
-- so they count as "not filled in"). A new slot length starts everyone
-- afresh: a 30-minute mark can't say whether the whole hour is free.
create or replace function private.store_schedule(p_course text, p_meeting text, s private.schedules)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grid timestamptz[] := private.schedule_grid(s);
  v_old_slot integer;
begin
  select sc.slot_min into v_old_slot from private.schedules sc
    where sc.course_id = p_course and sc.meeting_id = p_meeting;
  if v_old_slot is not null and v_old_slot <> s.slot_min then
    delete from private.availability a where a.course_id = p_course and a.meeting_id = p_meeting;
  end if;
  insert into private.schedules (course_id, meeting_id, days, day_from, day_to, slot_min, duration_min, open)
    values (p_course, p_meeting, s.days, s.day_from, s.day_to, s.slot_min, s.duration_min, true)
  on conflict (course_id, meeting_id) do update set
    days = excluded.days, day_from = excluded.day_from, day_to = excluded.day_to,
    slot_min = excluded.slot_min, duration_min = excluded.duration_min,
    open = true, suggestion = null, picked_at = null, picked_by = null;
  delete from private.availability a
    where a.course_id = p_course and a.meeting_id = p_meeting
      and cardinality(a.slots) > 0 and not (a.slots && v_grid);
  update private.availability a
    set slots = array(select t from unnest(a.slots) t where t = any (v_grid) order by t)
    where a.course_id = p_course and a.meeting_id = p_meeting;
end
$$;

-- The day availability is kept 30 days after: the grid's last day, or the
-- meeting's day once a time is picked (if later). While no time is picked,
-- meetings.date is only a placeholder (part 3: 60 days after creation), so
-- it doesn't count.
create or replace function private.schedule_end(s private.schedules, p_meeting_date date)
returns date
language sql
immutable
set search_path = ''
as $$
  select greatest(s.days[cardinality(s.days)], case when s.open then null else p_meeting_date end)
$$;

create or replace function private.schedule_expired(p_course text, p_meeting text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.answers_expired(private.schedule_end(s, m.date))
    from private.schedules s
    join private.meetings m on m.course_id = s.course_id and m.id = s.meeting_id
    where s.course_id = p_course and s.meeting_id = p_meeting), true)
$$;

-- The grid of a meeting the caller (a team member) may see: published
-- meetings, drafts only for organizers. HTTP 404 otherwise.
create or replace function private.visible_schedule(p_course text, p_meeting text)
returns private.schedules
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s private.schedules;
begin
  select sc.* into s
    from private.schedules sc
    join private.meetings m on m.course_id = sc.course_id and m.id = sc.meeting_id
    where sc.course_id = p_course and sc.meeting_id = p_meeting
      and (m.published or private.organizer_github_id(p_course) is not null);
  if not found or private.schedule_expired(p_course, p_meeting) then
    raise exception 'meeting "%" is not looking for a time', p_meeting using errcode = 'PT404';
  end if;
  return s;
end
$$;

-- The start time p_start (text, ISO 8601) if the whole meeting fits into the
-- grid from there; an error otherwise.
create or replace function private.valid_start(s private.schedules, p_start text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_start timestamptz;
begin
  begin
    v_start := p_start::timestamptz;
  exception when others then
    v_start := null;
  end;
  if v_start is null or p_start !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$' then
    raise exception 'starts_at: "%" is not a time like 2026-11-24T14:00:00+01:00', p_start;
  end if;
  if not (private.meeting_slots(s, v_start) <@ private.schedule_grid(s)) then
    raise exception 'starts_at: a % minute meeting from % doesn''t fit into the grid', s.duration_min,
      to_char(v_start at time zone 'Europe/Zurich', 'Dy DD Mon HH24:MI');
  end if;
  return v_start;
end
$$;

-- Who of the team is free for a whole meeting starting at p_start:
-- {"start", "end", "free", "available": [logins], "missing": [logins]}
-- ("missing": filled in, but not free then).
create or replace function private.free_at(s private.schedules, p_start timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'start', p_start,
    'end', p_start + make_interval(mins => s.duration_min),
    'free', count(*) filter (where a.slots @> private.meeting_slots(s, p_start)),
    'available', coalesce(jsonb_agg(m.github_login order by lower(m.github_login))
                   filter (where a.slots @> private.meeting_slots(s, p_start)), '[]'::jsonb),
    'missing', coalesce(jsonb_agg(m.github_login order by lower(m.github_login))
                 filter (where not a.slots @> private.meeting_slots(s, p_start)), '[]'::jsonb))
  from private.availability a
  join private.members m on m.course_id = a.course_id and m.github_id = a.github_id
  where a.course_id = s.course_id and a.meeting_id = s.meeting_id
$$;

-- The best start times, most people free first (then earliest), at most
-- p_limit, none closer to another than the meeting plus two slots. Only
-- times still ahead, and only where at least one person is free.
create or replace function private.best_times(s private.schedules, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_grid timestamptz[] := private.schedule_grid(s);
  v_best jsonb := '[]'::jsonb;
  v_taken timestamptz[] := '{}';
  v_gap interval := make_interval(mins => s.duration_min + 2 * s.slot_min);
  r record;
begin
  for r in
    select x.start, x.free
    from (
      select g.t as start,
             (select count(*) from private.availability a
                join private.members m on m.course_id = a.course_id and m.github_id = a.github_id
               where a.course_id = s.course_id and a.meeting_id = s.meeting_id
                 and a.slots @> private.meeting_slots(s, g.t)) as free
      from unnest(v_grid) g (t)
      where g.t >= now() and private.meeting_slots(s, g.t) <@ v_grid
    ) x
    where x.free > 0
    order by x.free desc, x.start
  loop
    exit when jsonb_array_length(v_best) >= p_limit;
    continue when exists (select 1 from unnest(v_taken) t where t > r.start - v_gap and t < r.start + v_gap);
    v_taken := v_taken || r.start;
    v_best := v_best || jsonb_build_array(private.free_at(s, r.start));
  end loop;
  return v_best;
end
$$;

-- A grid with everyone's times, as the site and the agent get it.
create or replace function private.schedule_json(s private.schedules, p_best integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'meeting', s.meeting_id,
    'open', s.open,
    'days', to_jsonb(s.days),
    'from', to_char(s.day_from, 'HH24:MI'),
    'to', to_char(s.day_to, 'HH24:MI'),
    'slot_min', s.slot_min,
    'duration_min', s.duration_min,
    'time_zone', 'Europe/Zurich',
    'grid', to_jsonb(private.schedule_grid(s)),
    'suggestion', case when s.suggestion is not null
                    then s.suggestion || jsonb_build_object('free_at', private.free_at(s, (s.suggestion ->> 'starts_at')::timestamptz)) end,
    'members', (select count(*) from private.members m where m.course_id = s.course_id),
    'filled_in', (select count(*) from private.availability a
                    join private.members m on m.course_id = a.course_id and m.github_id = a.github_id
                   where a.course_id = s.course_id and a.meeting_id = s.meeting_id),
    'not_filled_in', (select coalesce(jsonb_agg(m.github_login order by lower(m.github_login)), '[]'::jsonb)
                        from private.members m
                       where m.course_id = s.course_id
                         and not exists (select 1 from private.availability a
                                          where a.course_id = s.course_id and a.meeting_id = s.meeting_id
                                            and a.github_id = m.github_id)),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('login', m.github_login, 'slots', to_jsonb(a.slots))
                                 order by lower(m.github_login)), '[]'::jsonb)
                 from private.availability a
                 join private.members m on m.course_id = a.course_id and m.github_id = a.github_id
                where a.course_id = s.course_id and a.meeting_id = s.meeting_id),
    'best', private.best_times(s, p_best))
$$;

-- The open grids of a course, short (for get_course and agent_due).
create or replace function private.schedule_summary(s private.schedules, p_me bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'meeting', s.meeting_id,
    'days', to_jsonb(s.days),
    'from', to_char(s.day_from, 'HH24:MI'),
    'to', to_char(s.day_to, 'HH24:MI'),
    'slot_min', s.slot_min,
    'duration_min', s.duration_min,
    'filled_in', (select count(*) from private.availability a
                    join private.members m on m.course_id = a.course_id and m.github_id = a.github_id
                   where a.course_id = s.course_id and a.meeting_id = s.meeting_id),
    'mine', exists (select 1 from private.availability a
                     where a.course_id = s.course_id and a.meeting_id = s.meeting_id and a.github_id = p_me),
    'suggestion', s.suggestion)
$$;

revoke all on function private.grid_slots(date[], time, time, integer) from public, anon, authenticated;
revoke all on function private.schedule_grid(private.schedules) from public, anon, authenticated;
revoke all on function private.meeting_slots(private.schedules, timestamptz) from public, anon, authenticated;
revoke all on function private.parse_schedule(jsonb, integer) from public, anon, authenticated;
revoke all on function private.store_schedule(text, text, private.schedules) from public, anon, authenticated;
revoke all on function private.schedule_end(private.schedules, date) from public, anon, authenticated;
revoke all on function private.schedule_expired(text, text) from public, anon, authenticated;
revoke all on function private.visible_schedule(text, text) from public, anon, authenticated;
revoke all on function private.valid_start(private.schedules, text) from public, anon, authenticated;
revoke all on function private.free_at(private.schedules, timestamptz) from public, anon, authenticated;
revoke all on function private.best_times(private.schedules, integer) from public, anon, authenticated;
revoke all on function private.schedule_json(private.schedules, integer) from public, anon, authenticated;
revoke all on function private.schedule_summary(private.schedules, bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------- links for agents

-- Part 3's links, plus "schedule": the meeting on the timeline (its grid,
-- while it is looking for a time).
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
    'post', c.site_url || '#/m/' || p_meeting || '/post',
    'schedule', c.site_url || '#/timeline?open=' || p_meeting) end
  from private.courses c where c.id = p_course
$$;

-- ---------------------------------------------------------------- the website: reading

-- Part 3's get_course, plus "schedules": the open grids the caller may see.
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

-- One grid with everyone's times (names) and the three best times, plus
-- "mine": your own slots (null if you haven't filled it in).
create or replace function private.get_schedule(p_course text, p_meeting text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_member(p_course);
  s private.schedules := private.visible_schedule(p_course, p_meeting);
begin
  return private.schedule_json(s, 3) || jsonb_build_object(
    'mine', (select to_jsonb(a.slots) from private.availability a
              where a.course_id = p_course and a.meeting_id = p_meeting and a.github_id = v_me));
end
$$;

-- ---------------------------------------------------------------- the website: everyone

-- Replaces your free slots in a grid (a list of slot start times). Slots that
-- aren't in the grid are left out. An empty list means "no time works".
create or replace function private.save_availability(p_course text, p_meeting text, p_slots jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_member(p_course);
  s private.schedules := private.visible_schedule(p_course, p_meeting);
  v_slots timestamptz[];
begin
  if not s.open then
    raise exception 'this meeting already has its time' using errcode = 'PT409';
  end if;
  if jsonb_typeof(p_slots) is distinct from 'array' or jsonb_array_length(p_slots) > 1500 then
    raise exception 'slots: expected a list of times, like ["2026-11-24T13:00:00Z"]';
  end if;
  begin
    select coalesce(array_agg(distinct (x #>> '{}')::timestamptz), '{}') into v_slots
      from jsonb_array_elements(p_slots) x;
  exception when others then
    raise exception 'slots: expected a list of times, like ["2026-11-24T13:00:00Z"]';
  end;
  v_slots := array(select t from unnest(v_slots) t where t = any (private.schedule_grid(s)) order by t);
  insert into private.availability (course_id, meeting_id, github_id, slots, updated_at)
    values (p_course, p_meeting, v_me, v_slots, now())
  on conflict (course_id, meeting_id, github_id) do update set slots = excluded.slots, updated_at = now();
  return jsonb_build_object('saved_at', now(), 'slots', to_jsonb(v_slots));
end
$$;

-- ---------------------------------------------------------------- the website: organizers

-- A meeting id from a date and a title: "2026-11-24-exam-preparation".
create or replace function private.meeting_id_for(p_course text, p_day date, p_title text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_slug text := replace(lower(coalesce(p_title, '')), 'ß', 'ss');
  v_base text;
  v_id text;
  n integer := 1;
begin
  v_slug := translate(v_slug, 'äöüàáâãåæéèêëíìîïóòôõøúùûçñ', 'aouaaaaaaeeeeiiiiooooouuucn');
  v_slug := btrim(regexp_replace(v_slug, '[^a-z0-9]+', '-', 'g'), '-');
  v_slug := btrim(left(v_slug, 50), '-');
  v_base := to_char(p_day, 'YYYY-MM-DD') || '-' || coalesce(nullif(v_slug, ''), 'meeting');
  v_id := v_base;
  while exists (select 1 from private.meetings m where m.course_id = p_course and m.id = v_id) loop
    n := n + 1;
    v_id := v_base || '-' || n;
  end loop;
  return v_id;
end
$$;

-- A new meeting, visible to the team at once (decided 14 Nov 2026). With a
-- schedule ({"days", "from", "to", "slot_min", "duration_min"}) it starts by
-- finding a time and must not have starts_at yet.
create or replace function private.add_meeting(p_course text, p_details jsonb, p_schedule jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_organizer(p_course);
  v_finding boolean := coalesce(jsonb_typeof(p_schedule), 'null') <> 'null';
  s private.schedules;
  v_day date;
  v_id text;
begin
  perform private.check_part('details', p_details);
  if v_finding and coalesce(jsonb_typeof(p_details -> 'starts_at'), 'null') <> 'null' then
    raise exception 'a meeting that is still looking for a time has no starts_at yet';
  end if;
  if v_finding then
    s := private.parse_schedule(p_schedule, (p_details ->> 'duration_min')::numeric::integer);
  end if;
  v_day := coalesce(s.days[1], ((p_details ->> 'starts_at')::timestamptz at time zone 'Europe/Zurich')::date,
                    (now() at time zone 'Europe/Zurich')::date);
  v_id := private.meeting_id_for(p_course, v_day, p_details ->> 'title');
  perform private.new_meeting(p_course, v_id, p_details, v_me, null);
  update private.meetings m set published = true where m.course_id = p_course and m.id = v_id;
  perform private.refresh_meeting(p_course, v_id);
  if v_finding then
    perform private.store_schedule(p_course, v_id, s);
  end if;
  return jsonb_build_object('id', v_id, 'published', true, 'finding_a_time', v_finding);
end
$$;

-- Sets the meeting's time (a start where the whole meeting fits into the
-- grid) and its length, and closes the grid. Organizers only.
create or replace function private.pick_time(p_course text, p_meeting text, p_starts_at text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me bigint := private.require_organizer(p_course);
  s private.schedules := private.visible_schedule(p_course, p_meeting);
  v_start timestamptz;
  v_current jsonb;
  v_saved jsonb;
begin
  if not s.open then
    raise exception 'this meeting already has its time' using errcode = 'PT409';
  end if;
  v_start := private.valid_start(s, p_starts_at);
  v_current := private.current_part(p_course, p_meeting, 'details');
  v_saved := private.write_part(p_course, p_meeting, 'details',
    (v_current -> 'content') || jsonb_build_object(
      'starts_at', to_char(v_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'duration_min', s.duration_min),
    (v_current ->> 'version')::integer, 'time picked', false, v_me, null);
  update private.schedules sc set open = false, picked_at = now(), picked_by = v_me
    where sc.course_id = p_course and sc.meeting_id = p_meeting;
  return jsonb_build_object('starts_at', v_start, 'duration_min', s.duration_min, 'details_version', v_saved -> 'version');
end
$$;

-- Stops finding a time: deletes the grid and everyone's times in it.
create or replace function private.cancel_schedule(p_course text, p_meeting text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_organizer(p_course);
  delete from private.schedules sc where sc.course_id = p_course and sc.meeting_id = p_meeting;
  if not found then
    raise exception 'meeting "%" is not looking for a time', p_meeting using errcode = 'PT404';
  end if;
end
$$;

-- ---------------------------------------------------------------- agents

-- Opens a grid for a meeting (draft or published), or changes it.
create or replace function private.agent_open_scheduling(p_meeting text, p_schedule jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(true);
  v_published boolean;
  v_details jsonb;
  s private.schedules;
begin
  select m.published into v_published from private.meetings m where m.course_id = k.course_id and m.id = p_meeting;
  if not found then
    raise exception 'there is no meeting "%" in this course', p_meeting using errcode = 'PT404';
  end if;
  v_details := private.current_part(k.course_id, p_meeting, 'details') -> 'content';
  s := private.parse_schedule(p_schedule,
         case when jsonb_typeof(v_details -> 'duration_min') = 'number' then (v_details ->> 'duration_min')::numeric::integer end);
  perform private.store_schedule(k.course_id, p_meeting, s);
  select * into s from private.schedules sc where sc.course_id = k.course_id and sc.meeting_id = p_meeting;
  return private.schedule_summary(s, null) - 'mine' - 'suggestion'
    || jsonb_build_object('open', true, 'published', v_published,
                          'links', private.meeting_links(k.course_id, p_meeting));
end
$$;

-- Everyone's times (with GitHub usernames), who hasn't filled in, per slot
-- who is free, and the five best times.
create or replace function private.agent_get_availability(p_meeting text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(false);
  s private.schedules;
begin
  select * into s from private.schedules sc where sc.course_id = k.course_id and sc.meeting_id = p_meeting;
  if not found or private.schedule_expired(k.course_id, p_meeting) then
    raise exception 'meeting "%" is not looking for a time', p_meeting using errcode = 'PT404';
  end if;
  return private.schedule_json(s, 5) || jsonb_build_object(
    'slots', (select coalesce(jsonb_agg(jsonb_build_object('start', g.t, 'available', x.who) order by g.t), '[]'::jsonb)
                from unnest(private.schedule_grid(s)) g (t)
                cross join lateral (
                  select jsonb_agg(m.github_login order by lower(m.github_login)) as who
                  from private.availability a
                  join private.members m on m.course_id = a.course_id and m.github_id = a.github_id
                  where a.course_id = s.course_id and a.meeting_id = s.meeting_id and g.t = any (a.slots)) x
               where x.who is not null),
    'links', private.meeting_links(k.course_id, p_meeting));
end
$$;

-- Suggests a time; the site shows it to organizers with "Pick". Replaces an
-- earlier suggestion.
create or replace function private.agent_suggest_time(p_meeting text, p_starts_at text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k private.agent_keys := private.agent_key(true);
  s private.schedules;
  v_start timestamptz;
begin
  select * into s from private.schedules sc where sc.course_id = k.course_id and sc.meeting_id = p_meeting;
  if not found or private.schedule_expired(k.course_id, p_meeting) then
    raise exception 'meeting "%" is not looking for a time', p_meeting using errcode = 'PT404';
  end if;
  if not s.open then
    raise exception 'this meeting already has its time' using errcode = 'PT409';
  end if;
  if char_length(coalesce(p_note, '')) > 500 then
    raise exception 'note: at most 500 characters';
  end if;
  v_start := private.valid_start(s, p_starts_at);
  update private.schedules sc
    set suggestion = jsonb_strip_nulls(jsonb_build_object(
      'starts_at', v_start, 'note', nullif(btrim(p_note), ''), 'by', k.label, 'at', now()))
    where sc.course_id = k.course_id and sc.meeting_id = p_meeting
    returning sc.* into s;
  return jsonb_build_object('suggestion', s.suggestion, 'free_at', private.free_at(s, v_start),
                            'links', private.meeting_links(k.course_id, p_meeting));
end
$$;

-- Part 4's "what's due" list, plus open grids ("schedule"):
--   state "draft"      the meeting isn't published, so nobody can fill it in
--                      yet (ask an organizer to publish it)
--   state "waiting"    people are still filling it in
--   state "due"        time to suggest a time: everyone has filled it in, or
--                      the first day is two days away or closer
--   state "suggested"  a suggestion is waiting for an organizer's "Pick"
-- Listed until a time is picked or the last day has passed.
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
      select jsonb_agg(item order by (item ->> 'due_at')::timestamptz, item ->> 'meeting')
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
      ) items), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------- vote counts (part 4)

-- Part 4's get_tallies, with one more way to see a question's counts: once
-- it has an AI summary on the In-meeting tab. The summary already says how
-- people voted ("5 of 10"), so the counts are no secret any more; the
-- In-meeting tab shows them as a small chart under it (decided 15 Nov 2026).
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
  v_open text[];
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
  -- Questions you answered or skipped, and questions with an AI summary.
  select coalesce(array_agg(a.question_id), '{}') into v_open
    from private.answers a
    where a.course_id = p_course and a.meeting_id = p_meeting and a.github_id = v_github_id;
  select v_open || coalesce(array_agg(distinct it ->> 'question'), '{}') into v_open
    from jsonb_array_elements(coalesce(
      private.current_part(p_course, p_meeting, 'in') -> 'content' -> 'items', '[]'::jsonb)) it
    where it ->> 'question' is not null and btrim(coalesce(it ->> 'consensus_md', '')) <> '';
  return jsonb_build_object(
    'as_of', now(),
    'starts_at', v_starts,
    'visible', v_all,
    'visible_from', v_from,
    'questions', (select coalesce(jsonb_object_agg(t.key, t.value), '{}'::jsonb)
                    from jsonb_each(v_tallies) t where v_all or t.key = any (v_open)),
    'locked', (select coalesce(jsonb_agg(q.key order by q.key), '[]'::jsonb)
                 from jsonb_object_keys(v_meeting.questions) q (key)
                where not v_all and q.key <> all (v_open)));
end
$$;

revoke all on function private.get_tallies(text, text) from public, anon, authenticated;
grant execute on function private.get_tallies(text, text) to authenticated;

-- ---------------------------------------------------------------- deleting old availability

-- Deletes grids (and everyone's times in them) 30 days after the meeting.
create or replace function private.delete_old_availability()
returns integer
language sql
set search_path = ''
as $$
  with gone as (
    delete from private.schedules s
    using private.meetings m
    where m.course_id = s.course_id and m.id = s.meeting_id
      and private.answers_expired(private.schedule_end(s, m.date))
    returning 1
  )
  select count(*)::integer from gone
$$;

revoke all on function private.delete_old_availability() from public, anon, authenticated, service_role;

-- Every night at 03:27 UTC, if Supabase's scheduler (pg_cron) is available.
-- (The website and the agent never show expired availability either way.)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('meeting-engine-delete-old-availability', '27 3 * * *',
      'select private.delete_old_availability()');
  else
    raise notice 'pg_cron is not available: old availability is hidden, but not deleted';
  end if;
end
$$;

-- ---------------------------------------------------------------- permissions and the API

revoke all on function private.meeting_links(text, text) from public, anon, authenticated;
revoke all on function private.get_course(text) from public, anon, authenticated;
revoke all on function private.get_schedule(text, text) from public, anon, authenticated;
revoke all on function private.save_availability(text, text, jsonb) from public, anon, authenticated;
revoke all on function private.meeting_id_for(text, date, text) from public, anon, authenticated;
revoke all on function private.add_meeting(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.pick_time(text, text, text) from public, anon, authenticated;
revoke all on function private.cancel_schedule(text, text) from public, anon, authenticated;
revoke all on function private.agent_open_scheduling(text, jsonb) from public, anon, authenticated;
revoke all on function private.agent_get_availability(text) from public, anon, authenticated;
revoke all on function private.agent_suggest_time(text, text, text) from public, anon, authenticated;
revoke all on function private.agent_due() from public, anon, authenticated;

grant execute on function private.get_course(text), private.get_schedule(text, text),
  private.save_availability(text, text, jsonb), private.add_meeting(text, jsonb, jsonb),
  private.pick_time(text, text, text), private.cancel_schedule(text, text)
  to authenticated;
grant execute on function private.agent_open_scheduling(text, jsonb), private.agent_get_availability(text),
  private.agent_suggest_time(text, text, text), private.agent_due()
  to anon;

create or replace function public.get_schedule(p_course text, p_meeting text) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.get_schedule(p_course, p_meeting) $$;
create or replace function public.save_availability(p_course text, p_meeting text, p_slots jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.save_availability(p_course, p_meeting, p_slots) $$;
create or replace function public.add_meeting(p_course text, p_details jsonb, p_schedule jsonb default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.add_meeting(p_course, p_details, p_schedule) $$;
create or replace function public.pick_time(p_course text, p_meeting text, p_starts_at text) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.pick_time(p_course, p_meeting, p_starts_at) $$;
create or replace function public.cancel_schedule(p_course text, p_meeting text) returns void
language sql security invoker set search_path = ''
as $$ select private.cancel_schedule(p_course, p_meeting) $$;

revoke all on function public.get_schedule(text, text), public.save_availability(text, text, jsonb),
  public.add_meeting(text, jsonb, jsonb), public.pick_time(text, text, text), public.cancel_schedule(text, text)
  from public, anon;
grant execute on function public.get_schedule(text, text), public.save_availability(text, text, jsonb),
  public.add_meeting(text, jsonb, jsonb), public.pick_time(text, text, text), public.cancel_schedule(text, text)
  to authenticated;

create or replace function public.agent_open_scheduling(meeting text, days jsonb, from_time text default '09:00',
  to_time text default '18:00', slot_min integer default 30, duration_min integer default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_open_scheduling(meeting, jsonb_strip_nulls(jsonb_build_object(
  'days', days, 'from', from_time, 'to', to_time, 'slot_min', slot_min, 'duration_min', duration_min))) $$;
create or replace function public.agent_get_availability(meeting text) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_get_availability(meeting) $$;
create or replace function public.agent_suggest_time(meeting text, starts_at text, note text default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.agent_suggest_time(meeting, starts_at, note) $$;

revoke all on function public.agent_open_scheduling(text, jsonb, text, text, integer, integer),
  public.agent_get_availability(text), public.agent_suggest_time(text, text, text)
  from public, authenticated;
grant execute on function public.agent_open_scheduling(text, jsonb, text, text, integer, integer),
  public.agent_get_availability(text), public.agent_suggest_time(text, text, text)
  to anon;
