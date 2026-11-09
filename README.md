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

**Demo:** https://elisejorsini.github.io/meeting-engine/ (made-up example course)

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
  (`uses: ElisejOrsini/meeting-engine@v0.1.0`). To give a course a newer
  engine, change that one version number.
- The permanent record (summaries and decisions) always lives in git.

## Status

| # | Milestone | Status |
|---|-----------|--------|
| 1 | Static site: meetings from content files, three tabs, Decisions page, deployed to Pages | done |
| 2 | Course repo template + step-by-step guide; first real course site online | next |
| 3 | Backend (Supabase) + GitHub login + allowlist, enforced server-side | planned |
| 4 | Survey answers with hidden responses and "Show other responses" | planned |
| 5 | Live in-meeting notes | later, optional |
| 6 | Agent automation (e.g. an OpenClaw agent turning transcripts into summaries) | later, optional |

Until milestone 6, meetings are maintained by hand, with help from Claude Code
if you like: add a meeting folder, and after the meeting write `summary.md` and
`decisions.yml`, then run the check and commit.

## Using the engine in a course repository

Milestone 2 adds a ready-made course template and a step-by-step guide. Until
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
      - uses: ElisejOrsini/meeting-engine@v0.1.0   # the engine version
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
| `build/` | Build script: reads and validates content, renders Markdown, writes the site |
| `src/` | The website (plain HTML, CSS and JavaScript, no framework) |
| `demo/` | Made-up example course, published as this repo's own Pages site |
| `docs/content-format.md` | Reference for every content file and option |
| `test/` | Tests (`npm test`) |
| `scripts/dev-server.mjs` | Local preview server |
| `.github/workflows/pages.yml` | Tests, builds `demo/` and deploys it to Pages on every push to `main` |

## Security notes

- GitHub Pages sites are public. Never commit passwords, tokens or private keys.
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
  (`<name>.github.io`). Before login is added (Milestone 3), each course site
  needs its own origin (a custom domain, or an organization that hosts nothing
  else on Pages), so other Pages sites can't read the login session.

## Releasing a new engine version

1. Make the change, run `npm test`, push to `main`, and check the demo site.
2. Update `version` in `package.json`, commit, then create a tag and release:
   `git tag v0.2.0 && git push origin v0.2.0`.
3. In each course repo, change `@v0.1.0` to `@v0.2.0` in
   `.github/workflows/deploy.yml`.

## License

MIT, see [LICENSE](LICENSE).
