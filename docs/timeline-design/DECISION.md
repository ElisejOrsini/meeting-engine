# Timeline design: decision

Agreed with the user on 14 Nov 2026 in the design session. This replaces the
Decisions tab (part A of [`docs/redesign-plan.md`](../redesign-plan.md)).

**Chosen: one vertical line, September at the top.** The horizontal and
calendar versions were tried and dropped:

- Horizontal didn't fit the screen well (on a phone about a week is visible)
  and needed a zoom control.
- The calendar hid what happens on each day: you couldn't scroll through the
  history and read meeting names.
- Vertical fits the screen, scrolls naturally and works the same on phones.

**Final mockup:** [`vertical.html`](vertical.html) + [`vertical.js`](vertical.js),
with the shared data, sheets and the availability grid in
[`mockup.js`](mockup.js) and styles in [`mockup.css`](mockup.css) (on top of
`src/styles.css`). To see it: preview config `timeline-mockups` in
`.claude/launch.json` (runs [`serve.py`](serve.py), port 4330), then open
`http://localhost:4330/docs/timeline-design/vertical.html`. The mockup is made-up
data, nothing is saved, and "today" is fixed to Sat 14 Nov 2026.

## Layout

Three columns per row: **date** (right-aligned, 5.75rem; 4.5rem under 520 px)
· **rail** (28 px, the line runs through its middle) · **content**.

- **The line** is drawn piece by piece by every row: solid grey up to today,
  dashed after. Month names ("November") are large headings in the content
  column where the month changes.
- **Week headers** every week: a short tick across the line; date column
  "Week 10" (teaching week, counted from Mon 14 Sep; left empty outside weeks
  1–14); content "16–22 Nov · Next week". The relative part reads This week /
  Next week / Last week / In N weeks / N weeks ago. The current week's header
  is in the accent colour.
- **Around today it's day by day:** this week and the next two weeks show every
  day as its own slim row ("Mon 16" + small dot), even if it's empty; weekends
  lighter. This is what lets people use it without a calendar.
- **Further away only days with something on them are shown.** Runs of weeks
  with nothing on are merged into one quiet line: "Weeks 5–6 · 12–25 Oct ·
  nothing on" (past) or "· nothing planned yet" (future). A run never crosses
  today. So there are no long blank stretches, but every week is accounted for.
- **Item rows:** date column "Tue 17" (weekday + day; the week header above
  gives the month) and under it how far away it is ("in 3 days", "tomorrow",
  "4 days ago"; only within ±13 days). On the rail an icon chip; in the content
  a card with the kind label, title and one line of details.
- **Upcoming items** are on white cards (`--surface`); **past items** are plain
  text on the page background, with grey icon and label, so history stays calm.
- **Today:** its own row, accent dot with a soft ring, "Sat 14" and "Today" in
  accent with a thin accent line to the right.
- **Planned meeting (finding a time):** a shaded rounded band
  (`--accent-tint`) over the days it covers, with the line thickened into a
  translucent accent bar. Inside: the card ("Planned meeting · Exam
  preparation · Mon 23 – Fri 27 Nov · 7 of 11 answered") with an **Add your
  times** button; the remaining days of the window are listed as day rows in
  accent. If a window is outside the day-by-day weeks, only its row is shaded
  and the date column adds "until Fri 27".
- **On open** the page scrolls so that today is in the middle of the screen.

## Telling the kinds apart

Each kind has a small line icon in a round chip on the line (26 px), and its
kind label above the card title in the same colour. Past items turn grey.

| Kind | Label | Icon | Colour (light / dark) |
|---|---|---|---|
| Meeting | Meeting | two people | accent blue (`--accent`) |
| Meeting still looking for a time | Planned meeting | clock, dashed outline | accent blue |
| Written check-in | Written check-in | speech bubble with lines | purple `#8a3fb3` / `#d08bf5` |
| Task | Task | flag (rounded-square chip) | teal `#00757a` / `#5fd9d2` |

**Change to `docs/design.md`:** this adds two colours beyond the one accent
(purple and teal), used only for these icons and kind labels. Add them as
tokens (`--c-checkin`, `--c-task` + tints, as in `mockup.css`) and note the
exception in the colour section. Check AA contrast on `--bg` and `--surface`.

## What happens on click

All in sheets, the same component and behaviour as the survey sheets.

- **Past meeting:** facts (date · time · place), the short summary, the list of
  decisions (green ✓), button **Open meeting** → the meeting's Post-meeting tab.
- **Upcoming meeting:** facts, "2 questions to think about before the meeting ·
  you've answered 1", **Open meeting** → Pre-meeting tab.
- **Planned meeting → availability ("when to meet"), a wide sheet:**
  - "Your times" grid: days across, 30-minute slots down (9:00–18:00 in the
    mockup). Press and drag a rectangle; it adds if you started on a free slot
    and removes if you started on a marked one. Saves by itself ("Saving…" →
    "Saved"), no save button.
  - "Everyone" grid: heat map (darker = more people free, legend 0 → 11).
    Pointing at a slot (tapping on phones) shows "Tue 24 Nov, 14:00–14:30: 7 of
    11 free" with names: free / not free / no answer yet. "8 of 11 have marked
    their times."
  - From 860 px the two grids sit side by side; narrower, a segmented control
    switches between them.
  - **Best times for 60 minutes:** the top three starts (no two overlapping),
    "6 of 11 free · can't: Noah". Organizers see **Pick**; picking turns the
    shaded span into a normal meeting at that time.
- **Task:** date · person, a short description, "Agreed in Project milestones
  (Tue 10 Nov)" linking to that meeting's sheet. No "done" tick.
- **Written check-in:** the question, "Due Fri 20 Nov · 6 of 11 written", your
  own box first (Post update / Save changes), then everyone's updates with name
  and day, then "Not written yet: …".
- **+ Add** (organizers only), a sheet with: Find a time for a meeting (from–to
  dates, max. two weeks) · Meeting with a fixed time (date, time) · Task (date,
  optional person, i.e. a name or "Everyone") · Check-in (due date, question).

## In and out

**In:** meetings (past and upcoming), planned meetings with the availability
grid, tasks, written check-ins, week headers with teaching weeks and relative
labels, day-by-day rows around today, merged quiet weeks, today marker,
organizer "+ Add" and "Pick".

**Out:** horizontal line, zoom levels, calendar month view, a design switcher.
Not added (kept light, as the team prefers): task "done" ticks or status,
reminders, reactions/comments on check-ins.

## Open questions from the plan

Not discussed in this session; the mockup implies these defaults for the main
session to confirm with the user:

1. **Decisions search:** the mockup has no search. Decisions are reachable
   through the timeline (a past meeting's sheet lists them) and the
   Post-meeting tab.
2. **Tasks:** markers only (title, date, optional person, description), no done
   tick.
3. **Check-ins:** the whole team sees all updates with names. How long they're
   kept wasn't discussed.

## Notes for building it

- The app's Content Security Policy forbids inline `style` attributes: set the
  heat-map level (`--p`) and grid positions from JavaScript via
  `element.style`, as the mockup's availability grid already does. The mockup's
  `style="grid-column…"` strings don't matter any more (they were only in the
  dropped calendar).
- The availability grid needs keyboard support in the real version (e.g.
  arrow keys to move, Space to toggle a slot) and a text alternative for the
  heat map; the mockup is pointer-only. `touch-action: none` on "Your times"
  means the sheet scrolls by dragging outside the grid on phones.
- Relative labels and "today" depend on the viewer's date (Europe/Zurich, like
  the rest of the site).
- The header link "Decisions" becomes "Timeline".
