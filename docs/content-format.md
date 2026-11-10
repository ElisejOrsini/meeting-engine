# Content format

A course's content folder looks like this:

```
course.yml
meetings/
  2026-11-17-late-submissions/
    meeting.yml        required: title, date, agenda, questions, survey fields
    background.md      optional: shown on the Pre-meeting tab
    prereading.md      optional: shown on the Pre-meeting tab
    guide.md           optional: shown on the In-meeting tab
    summary.md         optional: shown on the Post-meeting tab (added after the meeting)
    decisions.yml      optional: shown on the Post-meeting tab and the Decisions page
    slides.pdf         optional attachments (pdf, png, jpg, jpeg, gif, webp, csv, txt)
  _template/           folders starting with "_" or "." are ignored
```

Check your content with `node build/build.mjs --content <folder> --check`
(from the engine folder) or `npm run check` for the demo. Every problem is
listed with its file name. Unknown keys are errors, so typos are caught.

## Rules that apply everywhere

- **Ids** (meeting folders, question ids, survey field ids, decision ids) use
  lowercase letters and digits separated by single dashes: `grace-period`,
  `q1`. Not allowed: `Grace`, `grace--period`, `grace-`, `grace_period`.
- **Meeting folder names** should start with the meeting date:
  `2026-11-17-late-submissions`. If they do, the date must match `date:` in
  `meeting.yml`. The folder name is the meeting's address on the site
  (`#/m/2026-11-17-late-submissions`), so don't rename it after sharing links.
- **File names** are exact and lowercase (`summary.md`, not `Summary.md`).
  Other files in a meeting folder are published only if they are attachments
  (pdf, png, jpg, jpeg, gif, webp, csv, txt); anything else gives a warning.
  Symbolic links are not allowed.
- **Markdown** is GitHub-flavoured. Raw HTML is shown as text, not rendered.
  Links may be `https://…`, `mailto:…`, another page of the site (`#/decisions`)
  or an attachment in the same meeting folder (`[slides](slides.pdf)`); a link
  to an attachment that doesn't exist is an error. Other links (`#section`,
  `/path`, `javascript:`) are shown as plain text. Headings are fine: `#` in a
  file becomes a sub-heading of the section it appears in.
- **Text values** in YAML that contain `: ` or start with a special character
  (`*`, `&`, `!`, `[`, `{`, `-`, `#`, `|`, `>`, `%`, `@`, `` ` ``) must be in
  quotes: `- "Recap: 10 minutes"`.
- **Empty files** (or files with only `#` comments) count as empty, not as errors.
- **Don't change ids after people have answered surveys.** Survey answers are
  stored by meeting, question and field id.

## course.yml

```yaml
name: "Applied Widgetry"          # required, shown in the header
description: |                    # optional, Markdown, shown on the start page
  TA team meetings for Applied Widgetry.
links:                            # optional, shown on the start page
  - title: Course website         # required
    url: https://example.org      # required, https://, http:// or mailto:

backend:                          # optional: GitHub sign-in (and later survey answers)
  url: https://abcdefghijklmnopqrst.supabase.co   # required, the Supabase Project URL
  publishable_key: sb_publishable_...             # required, the publishable key (public)
  course_id: applied-widgetry-2026                # required, an id; unique per course in the project
members:                          # GitHub usernames allowed to sign in
  - ElisejOrsini
```

`backend` and `members` are explained, with the one-time Supabase setup, in
[backend-setup.md](backend-setup.md). Never put a secret key (`sb_secret_…`)
in any content file: the check refuses it, because the repository and the site
are public. The member list is not published on the site, but anyone who can
see the repository can read it.

## meeting.yml

```yaml
title: Late submission policy     # required
date: 2026-11-17                  # required, YYYY-MM-DD
time: "14:00"                     # optional start time, 24h, in quotes
duration: 60                      # optional, whole minutes
location: Room HG E 33 and online # optional

responses:
  reveal: anytime                 # anytime (default) | after_answering
  # Answering is always optional. Others' answers start hidden in both modes.
  # anytime: anyone on the team can click "Show other responses", answered or not
  # after_answering: for each question, the button only works once you've
  #   answered it yourself (avoids anchoring; people who don't answer never
  #   see the others)
  anonymous: false                # optional, default false; true: teammates see
                                  # the answers but not who gave them

agenda:                           # optional, shown on the In-meeting tab
  - title: Survey results on grace periods   # required
    minutes: 20                   # optional, whole minutes; with `time` the site shows 14:05–14:25
    question: grace-period        # optional, links to a question id below
    notes: Start with the numbers.   # optional, Markdown

questions:                        # optional, shown on the Pre-meeting tab
  - id: grace-period              # required, unique in this meeting
    text: Should we allow a grace period?   # required, plain text
    details: |                    # optional, Markdown
      Context for the question.
    survey:                       # optional list of survey fields
      - id: preference            # required, unique in this question
        type: single              # required: single | multiple | text
        label: Which grace period would you prefer?   # required
        options: [None, 1 hour, 24 hours]   # single/multiple only: 2 or more, all different
        required: true            # optional, default false
      - id: reason
        type: text
        label: Why?
```

## Survey answers

With sign-in set up (`backend:` in `course.yml`, see
[backend-setup.md](backend-setup.md)), team members can answer the survey
fields on the Pre-meeting tab:

- Answering is optional, and everyone can change or remove their answer at any
  time.
- Others' answers are shown on request, following `responses.reveal`. Names are
  shown next to answers, unless the meeting has `responses.anonymous: true`.
- Answers are deleted automatically **30 days after the meeting**. Anything
  worth keeping belongs in `summary.md` or `decisions.yml`.
- `anonymous: true` is a promise: once a deploy has made a meeting anonymous, it
  stays anonymous, even if the line is removed later (the deploy log then says
  so). Turning it on later also hides the names of earlier answers.
- After changing a meeting's survey, deploy (push) before people answer: the
  backend checks answers against the survey of the last deploy. If you rename
  an option, earlier answers keep the old text (shown as "no longer an option").
- Answers are stored by meeting folder, question id and field id. Renaming a
  meeting folder (also when a meeting is rescheduled, since the folder name
  starts with the date) or a question id, or removing a survey, hides the
  earlier answers on the site. Renaming a field id hides what was answered in
  that field, but those answers still count as responses until people answer
  again. Hidden answers are deleted 30 days after the date the meeting had when
  they were given. So reschedule or rename before people answer, or ask them to
  answer again.

## decisions.yml

Written after the meeting. Each decision can point at the question it answers.

```yaml
decisions:
  - id: grace-1h                  # required, unique in this meeting
    question: grace-period        # optional, must be a question id from meeting.yml
    decision: We allow a 1-hour grace period.   # required, Markdown
    rationale: Most late uploads are only minutes late.   # optional, Markdown
```

Questions without a decision are listed as **Still open** on the Post-meeting
tab once the meeting has happened.

## summary.md

Free Markdown. A good summary has who attended, what was discussed, and action
items (who does what, by when). Decisions belong in `decisions.yml`, not only in
the summary, so they show up on the Decisions page.
