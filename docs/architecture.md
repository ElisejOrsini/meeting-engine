# Architecture proposal: a private meeting site an agent can run

**Status: proposal (2026-11-10); decisions 1–5 taken on 2026-11-12;
milestone 5 built in v0.5.0.** Decisions still open are listed at the end. The interface for the agent is drafted separately in
[agent-api.md](agent-api.md), so the agent project can read it on its own.

## In short

Today, meeting content is Markdown and YAML in a public git repository, built
into a public website. Course plans are internal, so that no longer works.

The proposal:

1. **A private app per course.** The course's website becomes an empty shell
   (code only, no content), still on GitHub Pages in the course's
   organization. You sign in with GitHub, and only then does the page load the
   course's meetings.
2. **All content lives in the Supabase database in Zurich** that already holds
   sign-in and survey answers: meetings, questions, the In-meeting and
   Post-meeting text, availability, decisions and next steps. The database
   itself checks that only the course's team can read it.
3. **The agent (OpenClaw) gets its own key per course,** which you create and
   can revoke on the site. With it, the agent can read the course and the
   survey results, and write meeting sections. It can't change who is on the
   team, and it never sees who gave which survey answer.
4. **Every change is kept as a version,** so a bad agent edit can be undone.
   Optionally, a nightly copy goes to a private repository as a backup.
5. **No content in git anymore.** The course repository only holds the
   website's settings. What the agent uploads is on the site immediately, with
   no build in between.

Cost: CHF 0 per month on the free plans (optional: USD 25 per month for
Supabase Pro, which adds daily backups). Nothing runs on your own machines.

## What changes and why

| | Today (v0.4) | Proposed |
|---|---|---|
| Where content lives | public git repo per course | Supabase database (Zurich), private to the team |
| Who can read it | anyone on the internet | signed-in team members only (checked by the database) |
| Website | built per course from the repo, on that course's Pages site | the same app on each course's Pages site, loading content after sign-in |
| How content gets in | edit files, commit, push, wait for deploy | the agent (or you) saves through the API; visible at once |
| Team list | `members:` in `course.yml`, copied on deploy | in the database, managed on the site by organizers |
| History | git | versions in the database (+ optional nightly git backup) |
| Secrets in GitHub | Supabase secret key in each course repo | none |

## 1. Hosting

### The three options

| | **A. App shell + Supabase** (recommended) | **B. Own VPS** (app + SQLite + Caddy) | **C. Cloudflare Pages + Access** |
|---|---|---|---|
| How it works | Public page with code only; content, votes and availability in Supabase behind row-level security | A small server you run: website, database and API in one | Today's static site, built from a private repo; Cloudflare asks for a login before showing any page |
| Where data is stored | Zurich (AWS eu-central-2), run by Supabase Inc. (US company) | wherever your VPS is (Swiss if the provider is Swiss) | Content: cached on Cloudflare's worldwide network (US company). Votes: still Supabase |
| Private? | Yes: the database refuses non-members | Yes | Yes, but with two separate sign-ins (Cloudflare, then GitHub for votes) |
| Monthly cost | CHF 0 (USD 25 for Pro with backups) | your VPS (about CHF 5 for a separate small one) | CHF 0 (free up to 50 users) |
| RAM on your machines | none | 150–300 MB for the app; 1 GB VPS enough | none |
| Agent interface | per-course key, checked by the database | per-course key, checked by the app | the agent pushes to git (a GitHub token per repository) |
| Work for me | moderate: content moves from build time to the browser; the database part extends what exists | large: sign-in, sessions, backups, security updates, TLS, all new | small at first, but still two systems and two logins |
| Work for you | almost none (a few Supabase clicks per release, as today) | keeping a server updated and backed up | Cloudflare account and domain setup |
| Backups | not on the free plan: nightly export (below) or Pro | you set them up | git |

### Recommendation: A, with one change

**Keep A**, with one refinement: instead of one Pages site per course, there
is **one app for all courses**. Since the app holds no content, it doesn't
need to be built per course. That removes the course repositories, the deploy
workflow, the secret key in GitHub and the "own web address per course"
problem from today's setup.

Why A over the others:

- **Everything the In-meeting tab needs is in one place.** It combines the
  questions, the votes and the agent's notes; the scheduling grid combines
  availability with the meeting. In one database that is one query; in C it
  is two systems with two logins.
- **The database already enforces who may read what**, and that part is
  tested (sign-in, team lists, survey rules). A extends it; B would rebuild
  it from scratch.
- **The agent's key can be narrow.** A git token (C) can rewrite anything in
  the repository, including the team list. A database key can be limited to
  "write meeting sections of this one course".
- **Agent edits appear immediately**, with no build or deploy in between.
- **No server for you to maintain.** Your VPS is meant to keep OpenClaw
  isolated; putting the website and its data next to it would mix the two,
  and a server needs updates and backups that are easy to forget.

**Decided (2026-11-12): A.** The agent's interface is written so that it
doesn't depend on Supabase (see [agent-api.md](agent-api.md)), so a later move
to B wouldn't change anything on the agent side.

### Data protection (ETH)

What the site stores, all of it internal course information:

- **Content:** course plans, questions, summaries, decisions, next steps.
- **Personal data:** GitHub username and numeric id of each team member; an
  optional display name; survey answers (opinions, sometimes free text);
  availability (when someone is free); who owns which next step.
- **Not stored:** email addresses, meeting transcripts, recordings, student
  data.

Decided (2026-11-12): the data isn't sensitive and may be stored with
Supabase. The goal is that only the team can read the team's internal
communication, not that it stays with a Swiss-controlled provider.

- Supabase stores the data in Zurich.
- GitHub Pages (US) only serves the app's code, never content.
- **Transcripts never go to the site.** You give the transcript to OpenClaw;
  only its summary is uploaded. Where OpenClaw sends the transcript (its AI
  provider) is a question for the OpenClaw project.
- Data minimisation stays as today: individual survey answers and availability
  are deleted 30 days after the meeting (see section 6).

## 2. How the parts fit together

```
 Team members' browsers                          OpenClaw (your VPS)
 <organization>.github.io/<repository>/          agent key for one course
   app shell: HTML, CSS, JS, no content          (in OpenClaw's secret store)
            │  GitHub sign-in                              │
            │  then: read content, vote,                   │  agent API:
            │  fill in availability                        │  read course and results,
            ▼                                              ▼  write meeting sections
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Supabase project "meeting-engine" (Zurich)                           │
 │   sign-in (GitHub)   database with access rules   nightly clean-up   │
 └──────────────────────────────────────────────────────────────────────┘
            │  optional, nightly, read-only key
            ▼
 private backup repository (e.g. in the course's organization)
```

- The engine repository stays public: it holds the code, the demo and the
  docs, never course content.
- The public demo stays as it is: built from files in the engine
  repository, with made-up content.
- The app renders Markdown in the browser with the same safety rules as
  today's build (no raw HTML, only safe links), because content may be written
  by an agent.

## 3. Data model

All tables are in the database's `private` schema, as today. Nothing is
readable directly; the site and the agent call functions that check access.

| Table | One row per | Main fields |
|---|---|---|
| `courses` | course | id (e.g. `widgetry-2026`), name, description, notes (Markdown: rough timeline and context), created_at |
| `members` | person in a course | course, GitHub id, GitHub username, display name (optional), organizer yes/no |
| `agent_keys` | agent key | course, label ("OpenClaw"), hash of the key (never the key), allowed actions, created by, last used, revoked at |
| `meetings` | meeting | course, id (e.g. `next-steps`), title, start time (empty until picked), duration, location, published yes/no, created_at |
| `revisions` | saved version of one part of a meeting | course, meeting, part (`details`, `pre`, `in`, `post`), version number, content (JSON), who saved it (member or agent key), note, time |
| `answers` | (kept as today) survey answer | course, meeting, question, person, answer, updated_at |
| `availability_grids` | meeting being scheduled | meeting, days, from–to hours, slot length, time zone, open yes/no |
| `availability` | person in a grid | meeting, person, list of free slots, updated_at |
| `tallies` | vote count snapshot | meeting, question, field, counts per option, how many answered, time taken |

The content of each part is a JSON document (shapes in
[agent-api.md](agent-api.md#content-shapes)). In plain words:

- **Pre-meeting:** background, optional pre-reading, the questions (each with
  details, optional survey fields, and "needs the meeting" yes/no), and the
  answer settings (reveal, anonymous). This is today's `meeting.yml` +
  `background.md` + `prereading.md`, one to one.
- **In-meeting:** per question: a short version, the consensus, key points,
  and for contested questions where people disagree and why; plus optional
  agenda items and a short guide. The small charts come from the vote counts,
  drawn by the site, not by the agent (so the numbers are always real).
- **Post-meeting:** a short summary for those who missed it, decisions (each
  linked to its question), next steps (what, who, by when), and what is still
  open. No status, check boxes or reminders: it's written once and read.
- **Decisions page:** collected from all Post-meeting parts, as today.

Why JSON documents per part instead of a table per question or decision: the
agent writes a whole section at once, versions stay simple (one version = one
complete section), and the shapes match today's files, so import, export and
backup are straightforward. Survey answers are checked against the questions
in the current Pre-meeting version, which replaces today's "sync on deploy".

Meeting ids no longer start with the date, because the date is often unknown
when a meeting is created. That also removes today's problem of answers
disappearing when a meeting is moved.

## 4. Versions, history and backups

- **Every save is a new version.** Nothing is overwritten: the site shows the
  newest version, says who saved it and when ("updated by OpenClaw 2 hours
  ago"), and an organizer can open older versions and restore one (restoring
  saves a copy of the old version as the newest).
- **No lost edits:** a save names the version it was based on. If someone else
  saved in between, the save is refused and the agent reloads first.
- **Backups:** Supabase's free plan has no backups. Two ways to cover that,
  which can be combined:
  1. **Nightly export** (recommended, free): a scheduled GitHub Action in a
     private repository (in the course organization, or on ETH's own GitLab
     if you prefer Swiss hosting) reads the course with a read-only agent key
     and writes it as files, in today's Markdown/YAML format. This gives a
     second history in git and a way back to static files. Survey answers and
     availability are not exported.
  2. **Supabase Pro** (USD 25/month): daily backups kept for 7 days, and the
     project never pauses.

## 5. Sign-in and permissions

### People

Sign-in stays GitHub through Supabase, as today; nothing changes for team
members. Two roles:

- **Member:** reads the course, answers surveys, fills in availability.
- **Organizer** (you, and anyone you choose): additionally publishes meetings,
  picks the meeting time, manages the team list and agent keys, and restores
  old versions.

The team list moves from `course.yml` into the database. Organizers add people
by GitHub username on a small Team page; the site looks up the numeric GitHub
id, as the deploy does today. (A second role is new: so far there was only one.
Without it, every team member could change the team list.)

### The agent

- An organizer creates a key on the Team page: label ("OpenClaw"), what it may
  do (**read**, or **read and write**). The key is shown **once**; you paste
  it into OpenClaw's secret store, never into a chat or file. The database
  keeps only a fingerprint (hash), so a database leak doesn't leak the key.
- One key = one course. Revoking it on the Team page takes effect immediately.
- What a key can never do: change the team list or keys, publish a meeting
  draft, see who gave which survey answer, delete versions.
- Each save records which key made it, and "last used" is shown next to the key.

## 6. Privacy rules and the 30-day deletion

| Data | Kept | Who sees it |
|---|---|---|
| Survey answers (choices and free text, with who gave them) | until 30 days after the meeting, then deleted (nightly, as today) | team, following the meeting's reveal and anonymity settings |
| Availability | until 30 days after the meeting (same nightly job) | team, with names (like when2meet) |
| Vote counts (numbers only, no names, no text) | with the meeting, kept | team |
| Meeting content and its versions | until the course is deleted | team |
| What the agent gets from survey answers | — | counts per option, and free-text answers labelled "Person 1, 2, …" (the same label for the same person within one meeting), never names |
| Transcripts | never stored on the site | — |

What changes compared with today:

- The deletion itself stays. A meeting that never gets a time counts as
  happening 60 days after it was created.
- **New:** the counts behind the In-meeting charts are kept as a snapshot, so
  the charts still work after the answers are gone. The snapshot is taken when
  the agent writes the In-meeting section, and again just before deletion.
- **New:** availability follows the same rule.
- The In-meeting text the agent writes paraphrases free-text answers without
  names.

## 7. The lifecycle, step by step

| Step | Who | What happens on the site | Agent API calls |
|---|---|---|---|
| 1. Draft the Pre-meeting part | you + OpenClaw | the agent creates the meeting as a draft and uploads the Pre-meeting part; you check it on the site and publish it | `get_course` (notes, earlier decisions), `create_meeting`, `put_section pre` |
| 2. Votes and availability | team | members answer surveys and fill in the grid | `open_scheduling` (days and hours to offer) |
| 3a. Invitation email | OpenClaw drafts, you send | — | `get_meeting` (links), `get_responses` / `get_availability` (counts, for reminders) |
| 3b. Pick a time, announce it | you pick (on the site, or tell OpenClaw); OpenClaw drafts the email | the grid closes, the meeting shows its time and an "add to calendar" file | `get_availability` (best slots), `set_time` |
| 4. In-meeting part | OpenClaw, a few hours before | In-meeting tab filled; vote charts appear | `get_responses`, `put_section in` |
| 5. Post-meeting part | you give OpenClaw the transcript; it writes | Post-meeting tab and Decisions page filled | `put_section post` |

Full request and response shapes: [agent-api.md](agent-api.md).

## 8. Migration from today's model

1. **Database:** a new setup file (part 3) adds the tables above and the agent
   functions. You run it in the SQL Editor, as before. It keeps the existing
   sign-in, team lists and answers working.
2. **App:** the site loads content from the database after sign-in instead of
   from a built file. The Pre-meeting design stays as it is.
3. **Import tool:** `scripts/import.mjs` reads a course folder in today's
   format (checked by today's validator) and uploads it through the agent API
   with a write key, straight into the private database; the content never
   goes to a public repository.
4. **Course repositories hold only settings:** `course.yml` with
   `private: true`, the deploy workflow (no secrets, no sync) and a README,
   from `templates/private-course/`. Public courses (v0.4 style) keep working.
5. **Demo:** unchanged, a public course built from files.
6. **30-day deletion:** unchanged for answers, extended to availability, and
   vote counts survive as a snapshot (section 6).

## 9. Milestones

Proposed order, following the meeting lifecycle. Each milestone ends with a
version you can try before the next starts. Design milestones start with 2–3
mockups for you to choose from.

| # | Milestone | You can then… |
|---|---|---|
| 5 | **Private site** (done, v0.5.0): database part 3, app loads content after sign-in, Team page (organizers, members, agent keys), drafts, versions, import tool, local preview. | use a course site privately, edited by hand through Claude Code |
| 6 | **Agent API v1:** agent keys, read course and results, write sections, versions and restore, final [agent-api.md](agent-api.md) with a test script | connect OpenClaw (in its own project) |
| 7 | **Scheduling grid** (design, then build): when2meet-style grid, organizer picks the time, add-to-calendar file, agent calls | replace when2meet |
| 8 | **In-meeting tab redesign** (design, then build): short questions, consensus, small vote charts, details on contested questions | run a meeting from the new tab |
| 9 | **Post-meeting additions:** next steps with owner and due date, still open, Decisions page from the database | full lifecycle |
| 10 | **Backups and clean-up:** nightly export to a private repository, retire the course template and old docs, release v1.0 | — |

7 and 8 can swap if the In-meeting tab is more urgent than scheduling.

## Decisions for you

1. ~~**Hosting:** A, B or C?~~ **Decided 2026-11-12: A**, no ETH check needed.
2. ~~One app for all courses?~~ **Decided 2026-11-12: one app per course
   organization** (e.g. `widgetry-tas-2026.github.io/meetings/`). The course's
   repository holds only the app's settings (no content, no secrets) and
   deploys the pinned app version. Each course keeps its own web address and
   sign-in session.
3. ~~Organizer role?~~ **Decided: yes.**
4. ~~Agent drafts?~~ **Decided: new meetings start as drafts**; later edits to a
   published meeting go live at once (and can be undone).
5. ~~Course notes?~~ **Decided: course notes on the site**, visible to the team,
   readable and editable by the agent.
6. **Backups:** nightly export to a private repository (where: GitHub
   organization or ETH GitLab), Supabase Pro, both, or neither for now?
7. **Agent and names:** the agent sees availability with names (for "who
   can't make it"), but survey answers without names. OK?
8. **Milestone order:** scheduling (7) before In-meeting (8), or the other way
   round?
