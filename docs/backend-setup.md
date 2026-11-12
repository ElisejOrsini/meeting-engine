# Backend setup: GitHub sign-in with a team list

The website itself is static and public. Sign-in and survey answers use a
small [Supabase](https://supabase.com) project:

- People sign in with their GitHub account.
- Only GitHub accounts on a course's team list (`members:` in `course.yml`) can
  create an account, and the database checks the list again on every request.
- The team list lives in git. Every deploy copies it to Supabase, matched by
  each person's numeric GitHub account id (which never changes, unlike usernames).
- One Supabase project can serve several course sites; each course has its own
  `course_id` and its own team list.
- Survey answers are stored there, readable only by the course's team, and
  deleted automatically 30 days after the meeting.

Steps 1–3 happen once per Supabase project. Steps 4–8 happen once per course
site, in this order.

**Who should share a project:** only courses run by the same people. Anyone
who holds the project's secret key can change every course's team list in it,
so a colleague who runs their own courses should create their own project.

## Keys: which are public, which are secret

| Value | Where to find it | Where it goes | Public? |
|-------|------------------|---------------|---------|
| Project URL (`https://<20 letters>.supabase.co`) | Supabase: **Connect** button at the top, or **Settings → Data API** | `course.yml` and the deploy workflow | yes |
| Publishable key (`sb_publishable_…`) | Supabase: **Settings → API Keys** | `course.yml` | yes, it only allows what the database rules allow |
| Secret key (`sb_secret_…`) | Supabase: **Settings → API Keys → Secret keys** | a GitHub environment secret, nowhere else | **no, never** |
| Database password | your password manager | nowhere; the engine doesn't need it | **no** |
| GitHub OAuth client secret | GitHub's OAuth app page | Supabase's GitHub settings, nowhere else | **no** |

The build refuses to run if a secret key appears in a content file, or in an
attachment where it can be read: text files, and the text of many PDFs. Images
and some PDFs (text drawn with embedded-font codes) can't be checked, so never
put keys in screenshots or slides either.

## 1. Create the project and connect GitHub sign-in (once)

1. Go to https://supabase.com/dashboard and click **Continue with GitHub**.
2. Click **New project**. Name: `meeting-engine`. Database password: click
   **Generate a password** and save it in your password manager. Region:
   **Central Europe (Zurich)**. Click **Create new project**.
3. In the project: **Authentication** (left sidebar) → **Sign In / Providers** →
   expand **GitHub** and copy the **Callback URL**.
4. In a new tab, open https://github.com/settings/developers → **New OAuth App**:
   - Application name: `Meeting engine`
   - Homepage URL: your site, e.g. `https://elisejorsini.github.io/meeting-engine/`
   - Authorization callback URL: the Callback URL from step 3
   - Leave **Enable Device Flow** unticked.

   Click **Register application**, copy the **Client ID**, then click
   **Generate a new client secret** and copy it.
5. Back in Supabase, in the GitHub section: turn on **GitHub Enabled**, paste
   the Client ID and Client Secret, click **Save**.
6. On the same page, turn **Email** off, so GitHub is the only way to sign in.

## 2. Set up the database (once, and again for each new file)

The folder [`supabase/migrations/`](../supabase/migrations) has one file per
part, to be run in order (part 1: team lists and sign-in; part 2: survey
answers, which also sets up the nightly deletion of old answers). For each file:

1. In the project, open **SQL Editor** (left sidebar) and click **New query**.
2. Open the file on GitHub, click the **Copy raw file** button, paste
   everything into the editor, and click **Run**.
3. Supabase may warn about a **destructive operation**. That's expected: the
   file replaces older versions of its own rules and functions, and deletes
   nothing else. Click **Run this query**.
4. You should see "Success. No rows returned".

When a later engine version adds a new file there, run that file the same way.
Each file can safely be run more than once.

## 3. Switch on the sign-up rule (once, after step 2)

This stops anyone who is not on a team list from even creating an account.

1. **Authentication** → **Auth Hooks** (sometimes shown as just **Hooks**, in
   the Configuration part of the sidebar).
2. Click **Add hook** and choose **Before User Created**.
3. Hook type: **Postgres**. Schema: `public`. Function: `hook_before_user_created`.
4. Click **Create hook** (or **Save**).

## 4. Give the course site its own web address

All Pages sites of one GitHub account or organization share one web origin
(`<name>.github.io`), and the sign-in session is stored per origin. So a course
site with sign-in needs an address no other Pages site uses:

- a GitHub organization (or account) that publishes no other Pages site, or
- a custom domain.

Your personal account doesn't qualify for a course site, because it already
publishes the demo. Make sure the site has deployed at least once (without
sign-in) before step 6.

## 5. Allow the site's address in Supabase

1. **Authentication** → **URL Configuration**.
2. Under **Redirect URLs**, click **Add URL** and add the site's address
   exactly, with the trailing slash, e.g. `https://ta-widgetry.github.io/meetings/`.
3. If **Site URL** is still the default (`http://localhost:3000`), set it to
   that address too.

For local previews, `http://localhost:4321/` is also on the demo project's list.

## 6. Protect the deploy environment and add the secret key

The key goes into the repository's `github-pages` environment, which GitHub
creates when the site is first deployed. The environment must only run for
`main`, so workflows on other branches can't read the key. The deploy checks
this rule and refuses to use the key otherwise.

1. On GitHub, in the course repository: **Settings** → **Environments** →
   **github-pages**. (If it's missing, the site hasn't deployed yet: see step 4.)
2. Under **Deployment branches and tags**, it must say **Selected branches and
   tags** with only `main` listed. If it says anything else:
   1. Choose **Selected branches and tags**.
   2. Click **Add deployment branch or tag rule**.
   3. Ref type: **Branch**. Name pattern: `main`. Click **Add rule**.
   4. Remove any other rule in the list.
3. In Supabase: **Settings** (bottom of the sidebar) → **API Keys**. Under
   **Secret keys**, click **Add new secret key**, name it `github-actions`,
   create it, then copy it (it starts with `sb_secret_`).
4. Back on GitHub, on the github-pages page, under **Environment secrets**,
   click **Add environment secret**.
   - Name: `SUPABASE_SECRET_KEY`
   - Value: paste the key
   - Click **Add secret**.
5. Don't paste the key anywhere else: not in chat, not in a file, and not as a
   repository or organization secret (**Settings → Secrets and variables →
   Actions**), because those can be used from any branch. The deploy can check
   the environment's branch rule, but not where else the key is stored.

If the key ever leaks, delete it in **Settings → API Keys** and create a new
one, then update the GitHub secret.

## 7. Copy the team list on every deploy (workflow)

Sign-in needs engine **v0.2.0 or newer**, survey answers **v0.3.0 or newer**.
Do this before step 8: until
`course.yml` has a `backend:` section, the sync step just says "nothing to do".

In `.github/workflows/deploy.yml`:

1. Change the build step to `uses: ElisejOrsini/meeting-engine@v0.5.0`.
2. Replace the whole `deploy:` job with the one below. Put your Project URL in
   `supabase-url`.

Both `uses:` lines of the engine must have the same version.

```yaml
  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read       # lets the sync check the github-pages branch rule
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: ElisejOrsini/meeting-engine/sync@v0.5.0
        with:
          supabase-url: https://abcdefghijklmnopqrst.supabase.co   # your Project URL
          supabase-secret-key: ${{ secrets.SUPABASE_SECRET_KEY }}
      - id: deployment
        uses: actions/deploy-pages@v5
```

`supabase-url` is written in the workflow on purpose: the secret key is only
ever sent to that address, and `backend.url` in `course.yml` must match it.

If the sync fails (for example, a username has a typo or the secret is
missing), the site isn't published and the error says what to fix.

The sync also copies each meeting's survey settings (date, reveal mode,
anonymity and fields), so the database can check answers. The first deploy
ties the `course_id` to this repository, so another repository can't replace
this course's team list or settings.

## 8. Configure the course (`course.yml`)

```yaml
backend:
  url: https://abcdefghijklmnopqrst.supabase.co   # Project URL (Connect button)
  publishable_key: sb_publishable_...               # Settings → API Keys
  course_id: applied-widgetry-2026                  # unique within this Supabase project
members:                                            # GitHub usernames of the team
  - ElisejOrsini
  - some-colleague
```

Choose a new `course_id` for each course site (and don't change it later, since
survey answers will be stored under it). `members` is visible to anyone who can
see the repository. Put usernames that look like numbers in quotes (`- "0123"`).

## Changing the team

Edit `members:` in `course.yml` and push. Removed people lose access right after
the deploy (their account stays, but the database no longer lets them in).

If a team member renames their GitHub account, the next deploy stops with
"there is no GitHub account …". Replace the old username with the new one (don't
keep both). Their access keeps working in the meantime, because it is tied to
the numeric account id. If someone else has meanwhile registered the old
username, the deploy refuses to let that stranger in and says so.

If other people (or, later, an agent) get write access to the course
repository, protect `course.yml` and `.github/` with a required review
(a `CODEOWNERS` file and branch protection), since they control who can sign in.

## Keeping the project awake

Free Supabase projects pause after about a week without activity. The
[Keep backend awake](../.github/workflows/keepalive.yml) workflow in the engine
repository records a heartbeat every day. It only covers the project named in
the demo's `course.yml`, which the course sites of the engine's owner share.

A different Supabase project needs its own daily heartbeat. Add this workflow
to one repository that uses the project, as `.github/workflows/keepalive.yml`
(it needs no secrets):

```yaml
name: Keep backend awake
on:
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  heartbeat:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: ElisejOrsini/meeting-engine/keepalive@v0.5.0
```

- If the project was paused anyway, the workflow fails and GitHub emails you.
  Open the project in the Supabase dashboard and click **Restore project**.
- GitHub switches off scheduled workflows after 60 days without commits in a
  public repository. If that happens: **Actions** → **Keep backend awake** →
  **Enable workflow**.

## Troubleshooting

| What you see | What to do |
|--------------|------------|
| "This GitHub account isn't on the team list" | Add the username to `members:` and push. Wait for the deploy to finish. |
| "You're signed in, but this GitHub account isn't on this course's team list" | Same: the person is on another course's list, not this one. |
| "Sign-in isn't available right now" | The project may be paused (see above), or the database setup (step 2) hasn't been run. |
| After sign-in, GitHub sends you to a different site | Add the site's exact address to **Redirect URLs** (step 5). |
| Build error `unknown key "backend"` | The build step still uses an engine older than v0.2.0 (step 7). |
| Build error `unknown key "responses.anonymous"` | The build step still uses an engine older than v0.3.0 (step 7). |
| Deploy error "SUPABASE_SECRET_KEY secret is missing" | Do step 6 and step 7. |
| Deploy error "… lets every branch use its secret" or "must allow only the branch" | Fix the branch rule (step 6.2), then re-run the workflow. |
| Deploy error "could not read the github-pages environment's settings" | Add `actions: read` to the deploy job's permissions (step 7). |
| Deploy error "HTTP 404 … database setup" | Do step 2 (all files, in order). |
| "Couldn't save your answer: this meeting has no survey (yet)" | Most likely the sync step still uses an engine older than v0.3.0: both `uses:` lines must have the same version (step 7). Otherwise the meeting was added after the last deploy: push, wait for the deploy, then try again. |
| "Answering isn't available right now" | Same as "Sign-in isn't available right now". |
| Deploy error "… is not the project this workflow allows" | `backend.url` in `course.yml` and `supabase-url` in the workflow differ; fix the wrong one. |
| Deploy error "course id … already belongs to repository …" | Pick another `course_id`, or follow the instructions in the message if you replaced the repository. |
| Deploy error "the GitHub username … now belongs to a different account" | See "Changing the team". |
