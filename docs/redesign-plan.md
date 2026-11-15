# Plan: timeline and a new In-meeting tab

Draft, 14 Nov 2026. Covers the private site only (courses with `private: true`).
Nothing here is built yet. The timeline's look was decided in a separate
design session (part A below).

## What changes, in one sentence each

- **Decisions tab → Timeline.** One straight, continuous line through the
  semester with past meetings (history), upcoming meetings, scheduling windows,
  tasks and check-ins on it.
- **Scheduling (our own "when to meet").** A new meeting without a time shows up
  as a shaded span on the timeline; clicking it opens an availability grid
  where everyone marks when they're free.
- **Meetings tab:** stays as it is (upcoming and past meetings).
- **Pre-meeting tab:** stays as it is.
- **In-meeting tab:** rebuilt as a short agenda that works on its own: the key
  questions in one line each, a short AI summary of what the survey answers
  showed, and nothing that sends you back to the Pre-meeting tab.

## Agent friendly, everywhere

Everything a person can do or read on the site, an agent (OpenClaw or Claude
Code, with an agent key) can do or read through the agent API too. The plan is
for an OpenClaw skill to take over most head-TA work, including keeping the
site up to date. So every release below ships with:

- **Agent API functions** for its new parts (read and write), documented in
  [agent-api.md](agent-api.md) with an example, and tested like the rest.
- **Clear "what's due" information**, so the agent doesn't have to work it
  out: a function that lists what needs doing now (e.g. "summary for Exam
  preparation due at 13:30", "planned meeting: 9 of 11 answered, window ends
  Friday", "check-in due tomorrow, 4 not written").
- The same limits as today: an agent can't change the team or keys or see who
  gave which survey answer.

What the agent may not do on its own stays with organizers (publishing a
draft meeting, picking a meeting time) unless you decide otherwise later.

---

## A. Timeline (replaces the Decisions tab)

**Design decided** (14 Nov 2026, design session): full details, mockup and
build notes in [timeline-design/DECISION.md](timeline-design/DECISION.md).

- **One vertical line**, September at the top; the page opens with today in
  the middle. Horizontal and calendar were tried and dropped.
- **Week headers** every week ("Week 10 · 16–22 Nov · Next week"). This week
  and the next two show every day as its own row; further away only days with
  something on, and empty weeks merge into one quiet line.
- **Four kinds**, each with its own icon and colour: meeting (blue), planned
  meeting still looking for a time (blue, dashed clock, shaded band over its
  days), written check-in (purple), task (teal). Upcoming items on white cards,
  past items plain and grey.
- **Clicks open sheets** (like the survey sheets): a meeting shows its facts,
  summary and decisions with "Open meeting"; a planned meeting opens the
  availability grid ("Your times" to drag, "Everyone" heat map with names,
  best three times, organizers "Pick"); a task shows date, person,
  description; a check-in shows your box and everyone's updates.
- **Organizers** get "+ Add": find a time (max. two weeks), meeting with a
  fixed time, task, check-in.
- **Left out on purpose:** done ticks, reminders, comments on check-ins,
  search. The header link "Decisions" becomes "Timeline".
- **Design rules change:** two extra colours (purple, teal) only for these
  icons and labels; `docs/design.md` gets them as tokens.

**Scheduling, step by step**

1. An organizer adds "Find a time" for a meeting: from–to dates (at most two
   weeks).
2. The days appear as a shaded band on the timeline with "Add your times".
3. Members drag over the slots when they're free; it saves by itself.
4. The organizer picks one of the best times. The band becomes a normal
   meeting at that time.

**Where the decisions go:** on each meeting's Post-meeting tab and in the
past meeting's sheet on the timeline. The search across all decisions is
dropped (decided 14 Nov).

**Check-ins:** everyone sees all updates with names. Updates are deleted 60
days after the check-in's due date (nightly, like survey answers).

**Later, not now:** a "done" tick on tasks. Tasks are built as markers only
(title, date, optional person, description); the tick can be added later
without changing anything else.

## B. Meetings tab

No change: upcoming and past meetings. The "Course notes and timeline" box at
the bottom stays for now; once the timeline exists, the notes may only need to
hold background (no dates).

## C. In-meeting tab

Built so it can be the only thing on the screen during the meeting.

1. **Pre-reading at a glance.** The questions to decide, one line each (the
   `short` version), numbered. Together with the summaries under them, this
   is the reminder of what needs to be decided; no separate overview.
2. **What the team thinks**, under each question: a two- or three-sentence AI
   summary of the survey answers (the consensus), small vote bars with the real
   counts (drawn by the site, so the numbers are always right), and, if people
   disagree, one line on where and why.
3. **Agenda.** Times and titles in a compact list. Tapping an item opens it
   **in place** (key points, notes, the vote bars) instead of jumping to the
   Pre-meeting tab.
4. The meeting guide (if any) at the bottom, collapsed.

**When and who writes the AI summary:** **OpenClaw** (decided 14 Nov; Claude
Code with an agent key works the same way), **30 minutes before the meeting
starts**, from the survey
answers. Until then, the In-meeting tab shows a live countdown in place of
each summary ("AI summary in 1 d 4 h", then "in 12:34"). After the 30-minute
mark and until it's saved: "Being written…". Answers given after that point
aren't in the summary (the tab says so); the vote bars stay live. A meeting
without a time shows no countdown. The database already has
room for it (`in` part: `short`, `consensus_md`, `key_points`, `contested`,
`disagreement_md`). The site itself doesn't call an AI. A "Generate summary"
button on the site would need a paid API key and a server function, so it's
left for later, if ever.

**Vote counts and skipping** (decided 14 Nov): with "after_answering", you
see a question's counts once you've answered **or skipped** it, or once it has
an AI summary (decided 15 Nov: the summary already gives the numbers; the
In-meeting tab shows them as a small chart under it); everyone sees them from
30 minutes before the meeting. The survey sheet has a **Skip**
button right next to "Save answer", so not answering takes the same one
click. A skip isn't a vote.

Also: the vote counts are saved as a snapshot, so the bars still show after
the answers are deleted (30 days after the meeting).

## D. Database (one new SQL file, "part 4", run once in the SQL Editor)

- `availability_grids` and `availability` (already sketched in
  architecture.md).
- `timeline_items` (tasks and check-ins) and `checkin_updates` (one per person
  per check-in).
- `tallies` (vote count snapshots for the In-meeting bars).
- Same rules as today: only team members can read, only organizers create
  windows, tasks and check-ins; everyone edits only their own availability and
  updates. The agent API gets matching read/write functions later.

## Order of work (one release each)

1. **Design session** finishes the timeline look and features. *(done, see
   [timeline-design/DECISION.md](timeline-design/DECISION.md))*
2. **v0.6.0 In-meeting tab** (part C). *(released 14 Nov; database part 4 =
   `supabase/migrations/20261114120000_in_meeting.sql`, also adds
   `agent_get_responses` and `agent_due`)*
3. **v0.7.0 Timeline with meetings only** (part A, no new data): replaces the
   Decisions tab. *(released 14 Nov: `src/js/timeline.js`,
   `#/timeline`, old `#/decisions` links lead there; new optional
   `semester: { start, weeks }` in course.yml for the "Week 10" labels)*
4. **v0.8.0 Scheduling** (availability windows and grid, DB part 5).
   *(released 14–15 Nov as v0.8.0/v0.8.1: `supabase/migrations/20261114180000_scheduling.sql`,
   `src/js/schedule.js`, `src/js/calendar.js`. Decided 14 Nov: the agent sees
   names in availability; meetings added on the site are visible at once;
   after "Pick", organizers get "Send Outlook invite" (a prefilled Outlook
   event, sent from their own mailbox) and everyone "Add to calendar".)*
5. **v0.9.0 Tasks and check-ins.** Decided 15 Nov:
   - **Who:** pick people from the team list, or Everyone. Check-ins get the
     same "who should write" list (e.g. one person per project pair), so
     "Not written yet" only lists the people it is meant for.
   - **Next steps** of a meeting with a real due date become **suggested
     tasks** on the timeline, only for organizers, who add (choosing who) or
     dismiss each one.
   - **Agent-made tasks and check-ins** start as drafts, like its meetings;
     an organizer publishes them. Tasks and check-ins added on the site are
     visible at once.
   - **The agent sees names** in check-in updates (like the team).
   - Database part 6. Updates are deleted 60 days after the check-in's due
     date (nightly); the check-in itself stays on the timeline as history.
   - *(released 15 Nov: `supabase/migrations/20261115120000_tasks_checkins.sql`,
     `src/js/items.js`; preview with `npm run dev:example`.)*

Each release: tests, preview on `private-local`, your OK, then tag and push.

## Answered questions (14 Nov 2026)

1. **Decisions search:** dropped.
2. **Task "done" tick:** documented as a later idea, not built now.
3. **Check-ins:** visible to the team with names; deleted 60 days after the
   due date.
4. **AI summary:** written by OpenClaw 30 minutes before the meeting, with a
   live countdown on the In-meeting tab until then. The whole site stays
   agent friendly (OpenClaw or Claude Code).
5. **Overview of what needs deciding:** the Pre-meeting tab is the detailed
   version; on the In-meeting tab the questions with their summaries are the
   reminder. No extra overview.

## Still to settle while building

- **How OpenClaw knows it's time:** it checks the "what's due" list (above)
  on its own schedule, e.g. every 5 minutes. Set up in the OpenClaw skill,
  which lives in its own project, not here.
- ~~Agent picking times~~ **Decided 14 Nov:** OpenClaw only suggests a time
  (shown on the planned meeting); an organizer confirms it with "Pick".
