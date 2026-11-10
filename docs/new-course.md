# Setting up a new course site

This guide turns [`templates/course/`](../templates/course) into a course's own
meeting site on GitHub Pages. Steps marked **(Claude Code)** are commands
Claude Code runs for you; the others are clicks on github.com or in Supabase.

Allow about 20 minutes, plus 10 for sign-in.

## 0. Decide where the site lives

**Its web address.** A Pages site's address is
`https://<organization>.github.io/<repository>/`. All Pages sites of one
organization (or personal account) share that `<organization>.github.io`
origin, and the sign-in session is stored per origin. So, if the site will
have sign-in, the organization must publish **no other Pages site**, or the
site needs a custom domain. Your personal account doesn't qualify: it
publishes the engine's demo.

To check an organization **(Claude Code)**:

```bash
gh api orgs/ORGANIZATION/repos --paginate --jq '.[] | select(.has_pages) | .full_name'
```

No output means it publishes no Pages site. (You need to be a member who can
see all its repositories.)

**Public or private.** On GitHub's free plan, an organization can only publish
Pages from a **public** repository. Then the course repository is public, and
so is everything ever committed to it. The site itself is public on any plan.
So before any content goes in, agree on what may be public:

- Student feedback and survey results: summarised or counted, not raw. No
  names, e-mail addresses, student numbers, grades, or quotes someone could be
  recognised by. Keep raw responses somewhere private (e.g. the course's
  internal drive) and link to that instead, if the team has access there.
- No recordings or transcripts.
- The team's GitHub usernames (`members:` in `course.yml`) are public.

## 1. Create the repository

1. On github.com, open the organization → **Repositories** → **New repository**.
   - Owner: the organization. Name: e.g. `ta-meetings`.
   - Visibility: **Public** (unless the organization's plan allows Pages from
     private repositories and you prefer that).
   - Don't add a README, .gitignore or license (the template has them).
   - Click **Create repository**.
2. Still on the new repository: **Settings** → **Pages** → **Build and
   deployment** → **Source**: choose **GitHub Actions**. Doing this before the
   first deploy also creates the `github-pages` environment limited to `main`.
   (If the page isn't available on an empty repository, do it right after
   step 4 and re-run the workflow under **Actions**. If **Pages** is missing
   from the settings altogether, an organization owner must allow it first:
   organization **Settings → Member privileges → Pages creation → Public**.)

## 2. Copy the template (Claude Code)

```bash
cp -R ~/Desktop/meeting-engine/templates/course ~/Desktop/ta-meetings
cd ~/Desktop/ta-meetings && git init -b main
git remote add origin https://github.com/ORGANIZATION/ta-meetings.git
```

## 3. Fill in the course and the first meeting

1. `course.yml`: the course `name` and `description`; optional `links`.
   Leave `backend:` and `members:` commented out for now.
2. `README.md`: replace "Course name", `ORGANIZATION` and `REPOSITORY`.
3. The first meeting: copy `meetings/_template/` to
   `meetings/YYYY-MM-DD-short-name/` and fill in `meeting.yml`. Only `title`
   and `date` are required: a meeting with just a `background.md` and its
   questions is fine. Add the agenda, `guide.md`, and after the meeting
   `summary.md` and `decisions.yml`, whenever they exist.
4. Check the content **(Claude Code)**:

   ```bash
   node ~/Desktop/meeting-engine/build/build.mjs --content . --check
   ```

   and look at it locally (http://localhost:4321):

   ```bash
   node ~/Desktop/meeting-engine/scripts/dev-server.mjs --content .
   ```

5. Read through everything once more with "this is public" in mind (step 0).

## 4. Publish (Claude Code)

```bash
git add -A && git commit -m "First version of the TA meeting site"
git push -u origin main
```

Then on github.com: **Actions** → **Deploy site** should turn green in a
couple of minutes. The address is under **Settings → Pages** ("Your site is
live at …"). Until sign-in is set up, the survey questions are shown but
can't be answered.

## 5. Sign-in and survey answers (optional, any time later)

This uses the existing Supabase project (see
[backend-setup.md](backend-setup.md); a different group of people running
courses should create their own project there).

1. **Supabase → Authentication → URL Configuration → Redirect URLs → Add URL**:
   the site's address from step 4, exactly, with the trailing slash.
2. **GitHub, course repository → Settings → Environments → github-pages**:
   - Under **Deployment branches and tags**, only `main` must be listed. If not,
     follow [backend-setup.md, step 6.2](backend-setup.md#6-protect-the-deploy-environment-and-add-the-secret-key).
   - Under **Environment secrets** → **Add environment secret**: Name
     `SUPABASE_SECRET_KEY`, Value: the project's secret key (Supabase →
     Settings → API Keys → Secret keys; create one per repository, e.g.
     `github-actions-ta-meetings`). Don't save it anywhere else.
3. `.github/workflows/deploy.yml` **(Claude Code)**: set `supabase-url` to the
   Project URL.
4. `course.yml` **(Claude Code)**: un-comment `backend:` and fill in `url`
   (the same Project URL), `publishable_key`, and a new `course_id` (e.g.
   `widgetry-2026`; never reuse another course's). Un-comment `members:` and
   list the team's GitHub usernames.
5. Push. The deploy's "Copy team list and survey settings" step lists the
   members it copied. Then sign in on the site to check.

The engine's daily keep-alive covers the shared project, so nothing else is
needed for it.

## Later: updating the engine

The site keeps the engine version it pins (`@v0.3.0` in
`.github/workflows/deploy.yml`) until you change it. To get a newer version,
for example a new design, change **every** `ElisejOrsini/meeting-engine…@`
version in that file to the new one and push. If that version adds a file to
the engine's `supabase/migrations/`, run it in the Supabase SQL Editor first.
