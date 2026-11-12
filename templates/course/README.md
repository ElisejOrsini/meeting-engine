# TA meetings: Course name

The meeting site of the Course name TA team, built with
[meeting-engine](https://github.com/ElisejOrsini/meeting-engine) and published
on GitHub Pages on every push to `main`.

**Site:** https://ORGANIZATION.github.io/REPOSITORY/

## This repository is public

Everything here, including the history of every file, can be read by anyone,
and so can the site. Before committing, check that nothing identifies a
student or a TA beyond what you'd put on a public course page:

- Summarise student feedback and survey results ("12 of 40 students asked
  for …") instead of pasting raw responses. Leave out names, e-mail
  addresses, student numbers, grades and quotes someone could be recognised by.
- Never commit meeting recordings or transcripts.
- Keep raw exports (survey results, feedback forms) outside this folder, or in
  `private/`, which git ignores. Commit files by name and look at `git status`
  first. If something private was pushed, a later commit doesn't remove it from
  the history: delete or re-create the repository.
- Never commit passwords or keys. The build refuses Supabase secret keys.
- `members:` in `course.yml` lists the team's GitHub usernames, publicly.

TA survey answers given on the site are not stored here: they live in the
Supabase backend, are visible only to the team, and are deleted 30 days after
the meeting.

## Adding a meeting

1. Copy `meetings/_template/` to `meetings/YYYY-MM-DD-short-name/`, for example
   `meetings/2026-11-17-late-submissions/`. The folder name is the meeting's
   address on the site, so choose it once.
2. Fill in `meeting.yml`: `title` and `date` are required, everything else is
   optional. Delete the agenda or the questions if you don't have them yet.
3. Add any of these files to the folder (all optional):

   | File | Shown on | What goes in it |
   |------|----------|-----------------|
   | `background.md` | Pre-meeting tab | What the meeting is about and why |
   | `prereading.md` | Pre-meeting tab | What to read beforehand; link attachments like `[slides](slides.pdf)` |
   | `guide.md` | In-meeting tab | Facilitator, note taker, goals |
   | `summary.md` | Post-meeting tab | After the meeting: who attended, what was discussed, action items |
   | `decisions.yml` | Post-meeting tab and Decisions page | After the meeting: the decisions, each linked to its question |
   | `*.pdf`, `*.png`, `*.csv`, … | as links | Attachments (pdf, png, jpg, jpeg, gif, webp, csv, txt) |

4. Push. The site updates within a couple of minutes (see the **Actions** tab).

`decisions.yml` looks like this:

```yaml
decisions:
  - id: grace-1h
    question: grace-period          # a question id from meeting.yml
    decision: We allow a 1-hour grace period.
    rationale: Most late uploads are only minutes late.
```

The full format, with every option, is in the engine's
[content format reference](https://github.com/ElisejOrsini/meeting-engine/blob/v0.5.1/docs/content-format.md).

## Checking and previewing before you push

With the engine checked out next to this repository (for example in
`~/Desktop/meeting-engine`, after `npm install` there once):

```bash
node ~/Desktop/meeting-engine/build/build.mjs --content . --check
```

```bash
node ~/Desktop/meeting-engine/scripts/dev-server.mjs --content . --port 4330
```

The second command previews the site at http://localhost:4330 (check that the
header shows this course's name). The preview uses whatever engine version is
checked out there, which can be newer than the one this site pins.

## Engine version

`.github/workflows/deploy.yml` pins the engine (`@v0.5.1`). To update, change
every `ElisejOrsini/meeting-engine…@` version in that file to the same new
version and push. If the new version's release notes add a database file,
run it in Supabase first.

## One Pages site per organization

Sign-in only stays private if this is the only Pages site of its GitHub
organization (they all share `ORGANIZATION.github.io`). Don't publish any other
Pages site from this organization; give each further course with sign-in its
own organization or a custom domain.

## Sign-in and survey answers

Set up once with the engine's
[backend setup guide](https://github.com/ElisejOrsini/meeting-engine/blob/v0.5.1/docs/backend-setup.md):
`backend:` and `members:` in `course.yml`, the `supabase-url` in the deploy
workflow, and the `SUPABASE_SECRET_KEY` secret in the `github-pages`
environment (Settings → Environments).
