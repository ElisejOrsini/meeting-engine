# meeting-engine

A small website engine for running team meetings (built for university TA
teams). Each meeting gets three tabs:

- **Pre-meeting**: background, pre-reading and the open questions, with
  optional survey fields (single choice, multiple choice, free text).
- **In-meeting**: the agenda with time slots and a meeting guide.
- **Post-meeting**: the summary and the decisions, each linked to the
  question it answers.

A **Decisions** page collects every decision from every meeting and lets you
search them.

Team members can sign in with GitHub. Only people on the course's team list
can sign in; the list lives in the course repository.

**Demo:** https://elisejorsini.github.io/meeting-engine/ (made-up example course;
sign-in only works for the demo's own team list)

## How it works

```
meeting-engine (this repo, public)          course repo (one per course)
  build/   turns content into a website       course.yml
  src/     the website itself                 meetings/2026-11-17-.../
  action.yml  GitHub Action  <──── uses ────  .github/workflows/deploy.yml
  demo/    example content                      (pins an engine version)
```

- Meeting content is plain files: one folder per meeting, Markdown for text,
  YAML for questions and survey fields. Adding a meeting means adding a folder.
  The format is documented in [docs/content-format.md](docs/content-format.md).
- On every push, GitHub Actions builds the site and publishes it on
  GitHub Pages. No server is needed.
- Course repos use the engine at a pinned version
  (`uses: ElisejOrsini/meeting-engine@v0.2.0`). To give a course a newer
  engine, change the version in its workflow (in every `uses:` line of the
  engine, if there are several).
- The permanent record (summaries and decisions) always lives in git.
- Sign-in uses a small [Supabase](https://supabase.com) project (GitHub login).
  The team list (`members:` in `course.yml`) is copied to it on every deploy, and
  the database itself checks it. Setup, click by click:
  [docs/backend-setup.md](docs/backend-setup.md).

## Status

| # | Milestone | Status |
|---|-----------|--------|
| 1 | Static site: meetings from content files, three tabs, Decisions page, deployed to Pages | done |
| 2 | Backend (Supabase) + GitHub login + allowlist, enforced server-side; tried on the demo site | in progress |
| 3 | Survey answers (answering is optional; others' answers revealed on request, or only after answering) | planned |
| 4 | Course template (in this repo) + step-by-step guide; first real course site online | planned |
| 5 | Live in-meeting notes | later, optional |
| 6 | Agent automation (e.g. an OpenClaw agent turning transcripts into summaries) | later, optional |

Until milestone 6, meetings are maintained by hand, with help from Claude Code
if you like: add a meeting folder, and after the meeting write `summary.md` and
`decisions.yml`, then run the check and commit.

## Using the engine in a course repository

Milestone 4 adds a ready-made course template and a step-by-step guide. Until
then, this is the whole setup: a repository with `course.yml`, a `meetings/`
folder and this workflow file at `.github/workflows/deploy.yml`:

```yaml
name: Deploy site
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: pages
  cancel-in-progress: false
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: ElisejOrsini/meeting-engine@v0.2.0   # the engine version
        with:
          content-dir: .
          out-dir: _site
      - uses: actions/upload-pages-artifact@v5
        with:
          path: _site
  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

Then, once, in the course repository on github.com: **Settings → Pages →
Build and deployment → Source: GitHub Actions**.

For sign-in, the `deploy` job also runs the engine's sync action, with the
secret key from the `github-pages` environment; see
[docs/backend-setup.md](docs/backend-setup.md), step 7.

## Working on the engine locally

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install        # once
npm run dev        # preview the demo at http://localhost:4321 (reload to rebuild)
npm run check      # validate the demo content
npm test           # run the tests
npm run build      # build the demo into _site/
```

To preview another content folder: `node scripts/dev-server.mjs --content ../my-course`.

## Repository layout

| Path | What it is |
|------|------------|
| `action.yml` | The GitHub Action course repos use to build their site |
| `build/` | Build script: reads and validates content, renders Markdown, writes the site; `backend.mjs` copies the team list to Supabase |
| `supabase/migrations/` | Database setup, pasted into the Supabase SQL Editor ([guide](docs/backend-setup.md)) |
| `src/` | The website (plain HTML, CSS and JavaScript, no framework) |
| `demo/` | Made-up example course, published as this repo's own Pages site |
| `docs/content-format.md` | Reference for every content file and option |
| `docs/backend-setup.md` | Sign-in setup, click by click |
| `test/` | Tests (`npm test`) |
| `scripts/dev-server.mjs` | Local preview server |
| `sync/action.yml` | The GitHub Action that copies a course's team list to Supabase (deploy job only) |
| `keepalive/action.yml` | The GitHub Action that records a daily heartbeat so a free Supabase project isn't paused |
| `.github/workflows/pages.yml` | Tests, builds `demo/`, copies its team list to Supabase and deploys it to Pages on every push to `main` |
| `.github/workflows/keepalive.yml` | Daily heartbeat that keeps the shared Supabase project from pausing |

## Security notes

- GitHub Pages sites are public. Never commit passwords, tokens or private keys.
  The build refuses content that contains a Supabase secret key (also in
  attachments, where the text can be read). The secret key lives only in the `github-pages` environment; the
  build needs no secrets. Before using the key, the deploy checks that this
  environment only runs for `main`. It only sends the key to the project URL
  written in the workflow, refuses if `course.yml` names a different one, and
  ties each course id to its repository. The team list
  (`members:`) decides who can sign in, so protect `course.yml` with a required
  review if others or an agent can push to the course repository.
- Sign-in is checked by the database, not by the website: data is only
  readable through database functions that look up the signed-in person's
  numeric GitHub id in the course's team list. New accounts are only created
  for people on a team list.
- Content is treated as untrusted, because it may be written by an AI agent
  from meeting transcripts. Raw HTML in Markdown is shown as text. Links may only
  be `https:`, `mailto:`, site pages or attachments. Images must be attachments
  (images from other websites could track viewers, so they become links). The
  page sets a Content Security Policy that only allows scripts and images from
  its own origin (see the next point about what "origin" means on GitHub Pages).
- The build refuses symbolic links in content, and it only deletes an output
  folder it created itself.
- Meeting transcripts can contain personal data and must not be committed to a
  public repository.
- All project sites of one GitHub account or organization share one web origin
  (`<name>.github.io`), and the sign-in session is stored per origin. A course
  site with sign-in therefore needs its own origin (a custom domain, or an
  organization or account that hosts nothing else on Pages), so other Pages
  sites can't read the session. The demo is the only Pages site of its account.

## Releasing a new engine version

1. Make the change, run `npm test`, push to `main`, and check the demo site.
2. Update `version` in `package.json`, commit, then create a tag and release,
   e.g. `git tag v0.3.0 && git push origin v0.3.0`.
3. In each course repo, change the version in every `ElisejOrsini/meeting-engine…@`
   line of `.github/workflows/` (build, sync and keep-alive must match).
4. If the release adds a file to `supabase/migrations/`, run it in the SQL
   Editor before the course sites update (see docs/backend-setup.md, step 2).

## License

MIT, see [LICENSE](LICENSE).
