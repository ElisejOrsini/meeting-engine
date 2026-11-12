# Setting up a private course site

A private course keeps everything the team writes (meetings, questions,
summaries, decisions, the team list, survey answers) in the Supabase
database, where only signed-in team members can read it. The course's GitHub
repository holds only the website's settings and is public; it contains
nothing internal. Background: [architecture.md](architecture.md).

Steps marked **(Claude Code)** are things Claude Code does for you; the others
are clicks in Supabase or on github.com. Allow about 30 minutes.

What you need first:

- The shared Supabase project with sign-in already set up
  ([backend-setup.md](backend-setup.md), steps 1–3).
- A GitHub organization for the course that publishes **no other Pages site**
  (each site needs its own web address for sign-in; see
  [new-course.md](new-course.md), step 0, for how to check or create one).

## 1. Update the database (once per Supabase project, per engine release)

Private courses need part 3 of the database setup,
[`20261112120000_private_content.sql`](../supabase/migrations/20261112120000_private_content.sql).

1. Open https://supabase.com/dashboard and click the project (`meeting-engine`).
2. Left sidebar: **SQL Editor** → **New query** (the **+** at the top).
3. Open the file on GitHub, click **Copy raw file** (the two-squares icon
   above the code), paste everything into the editor, and click **Run**.
4. A warning about a **destructive operation** is expected (the file replaces
   older versions of its own functions). Click **Run this query**.
5. You should see "Success. No rows returned".

Courses deployed from a repository (the demo) keep working unchanged.

## 2. Create the course in the database

Still in the SQL Editor, in a new query. Replace the four values, then **Run**:

```sql
select private.create_course(
  'widgetry-2026',                              -- course id: lowercase, digits, dashes; never changes
  'Applied Widgetry',                           -- name shown on the site
  'your-github-username', 12345678,             -- you, the first organizer: username and numeric id
  'https://widgetry-tas-2026.github.io/meetings/'  -- the site's address, with the final /
);
```

- Your numeric GitHub id: open `https://api.github.com/users/<your username>`
  in the browser and copy the number after `"id":`.
- The address is `https://<organization>.github.io/<repository>/` for the
  repository you create in step 3.

It answers `Course "widgetry-2026" created with … as organizer.` Only the SQL
Editor can create courses; the website can't.

## 3. Create the course repository (Claude Code)

Claude Code copies [`templates/private-course/`](../templates/private-course)
into a new folder, fills in `course.yml` (name, Project URL, publishable key,
course id) and checks it:

```bash
node build/build.mjs --content <folder> --check
```

Then, with your OK, it creates the **public** repository in the organization
and pushes. The repository has three files: `course.yml`, the deploy workflow
and a README. No secret goes anywhere.

## 4. Switch on GitHub Pages

1. On github.com, open the repository → **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment** → **Source**, choose **GitHub Actions**.
3. Open the **Actions** tab. If the "Deploy site" run failed because Pages
   wasn't on yet, open it and click **Re-run all jobs**. Wait for the green tick.

## 5. Allow the site's address in Supabase

1. Supabase: **Authentication** → **URL Configuration**.
2. Under **Redirect URLs**, click **Add URL**, paste the site's address exactly
   (with the final `/`), and save.

## 6. Sign in and add the team

1. Open the site and click **Sign in with GitHub**. You see the (empty) course.
2. Click **Team** (top right). Under **Add someone**, type each team member's
   GitHub username (and optionally a name) and click **Add**. Tick
   **Organizer** for anyone who should also manage the team and publish
   meetings.
3. Team members can sign in right away; nobody else can.

Ask the team to switch on two-factor authentication for their GitHub
accounts (github.com → profile picture → **Settings** → **Password and
authentication**): their GitHub account is their key to the team's notes.

## 7. Import existing meetings (optional, Claude Code)

Meetings written as files ([content-format.md](content-format.md)) can be
imported:

1. On the Team page, under **Agent keys**, create a key with label `Import`
   and **Read and write**. Click **Copy** (it's shown only once).
2. In Claude Code's terminal panel (not in the chat), type the start of the
   command, paste the key after the `=` and press Enter:

   ```bash
   read -s MEETING_ENGINE_AGENT_KEY && export MEETING_ENGINE_AGENT_KEY
   ```

   (`read -s` waits for you to paste the key without showing it; the key
   stays in that terminal only.) Then Claude Code runs, in the same terminal:

   ```bash
   node scripts/import.mjs --content <folder> --url <Project URL> --publishable-key <publishable key>
   ```

3. Imported meetings are **drafts**. Open each one on the site, check it, and
   click **Publish**.
4. Back on the Team page, **Revoke** the Import key.

Attachments (PDFs, images, CSV files) are not imported yet; links to them are
shown as plain text.

## 8. Connect the agent (milestone 6)

Create a separate key for the agent (label `OpenClaw`, **Read and write**) and
put it straight into the agent's secret settings. The agent's interface is
described in [agent-api.md](agent-api.md).

## Checking that it's private

Do this once after setup, and after engine updates:

1. In a private browser window (not signed in), open the site: you see only
   "Sign in with GitHub", no meeting names.
2. Ask someone who is not on the team to sign in: they see "nothing to show".
3. **(Claude Code)** Call the database directly with only the public key, the
   way a stranger could:

   ```bash
   curl -s -X POST "<Project URL>/rest/v1/rpc/get_course" \
     -H "apikey: <publishable key>" -H 'content-type: application/json' \
     -d '{"p_course": "<course id>"}'
   ```

   The answer must be a "permission denied" error, not content.

## Day to day

- **Team changes:** organizers use the Team page. Removed people lose access
  at once.
- **A key leaked or is no longer needed:** Team page → **Revoke**.
- **An edit went wrong:** every save is kept as a version. Restoring from the
  site comes in a later milestone; until then Claude Code can restore one with
  `get_versions` / `get_version` and `save_part`.
- **Engine updates:** change the version in the repository's workflow; run new
  database parts first (step 1).
