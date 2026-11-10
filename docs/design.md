# Design rules

How the meeting site looks and behaves, so every change stays consistent.
Based on Apple's design principles as summarised in the
[apple-design skill](../.claude/skills/apple-design/SKILL.md) (from Apple's
WWDC design talks), adapted to this site. Everything is implemented in
[`src/styles.css`](../src/styles.css) with the tokens below; components use
tokens, never raw colours.

## Principles for this site

- **Simplicity, not minimalism.** Each page has one obvious main thing: the
  meeting list, a meeting's current tab, the decisions. Hierarchy comes from
  size, weight and space, not from boxes, lines and colours.
- **Content first.** Text sits on the page background. Only things you act on
  or scan as a unit get a surface: questions, decisions, lists, notices.
- **One accent colour** (blue) for everything interactive. Green and orange
  appear only as small status signals ("Decided", "Summary pending").
- **Familiar controls.** Segmented control for the meeting tabs, grouped lists
  with chevrons for navigation, pill buttons, native radio buttons and
  checkboxes (tinted with the accent).
- **Immediate feedback.** Buttons respond on press; saving shows "Saving…",
  then "Saved"; errors appear next to what caused them.

## Constraints

- The page's Content Security Policy allows only the site's own files: no web
  fonts, no external images or scripts, no inline `style` attributes in markup
  (set dynamic sizes from JavaScript via `element.style`, as the survey bars do).
- No CSS or JavaScript frameworks.
- Must work in light and dark mode, from 320 px wide phones up, with keyboard
  only, and with the system settings for reduced motion, reduced transparency
  and increased contrast.

## Typography

System font: `-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto,
"Helvetica Neue", Arial, sans-serif` (San Francisco on Apple devices, which
handles optical sizing itself).

| Role | Size | Line height | Weight | Tracking |
|------|------|-------------|--------|----------|
| Large title (page `h1`) | `clamp(1.875rem, 1.2rem + 2.6vw, 2.5rem)` | 1.1 | 700 | -0.022em |
| Title (`h2`) | 1.375rem | 1.25 | 700 | -0.014em |
| Headline (card titles, `h3`) | 1.125rem | 1.35 | 600 | -0.01em |
| Body | 1.0625rem (17 px) | 1.53 | 400 | 0 |
| Callout (secondary text, labels) | 0.9375rem | 1.45 | 400–600 | 0 |
| Footnote (meta, captions) | 0.8125rem | 1.4 | 400–600 | 0.01em |

Larger text gets tighter tracking and line height; small text slightly looser.
Sizes are in `rem`, so the reader's text-size setting scales everything.

## Colour tokens

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--bg` | `#f5f5f7` | `#000000` | page background |
| `--surface` | `#ffffff` | `#1c1c1e` | cards, lists, header material |
| `--surface-2` | `#f5f5f7` | `#2c2c2e` | nested surfaces (option groups) |
| `--text` | `#1d1d1f` | `#f5f5f7` | primary text |
| `--text-2` | `#6e6e73` | `#a1a1a6` | secondary text (meta, labels) |
| `--text-3` | `#86868b` | `#8d8d93` | tertiary (chevrons, placeholders) |
| `--separator` | `rgb(0 0 0 / 0.1)` | `rgb(255 255 255 / 0.12)` | hairlines |
| `--control-border` | `#8a8a8e` | `#7c7c80` | text fields (≥ 3:1 contrast) |
| `--fill` | `rgb(118 118 128 / 0.12)` | `rgb(118 118 128 / 0.24)` | control tracks, hover |
| `--accent` | `#0066cc` | `#2997ff` | links, accent text |
| `--accent-fill` | `#0071e3` | `#0071e3` | filled buttons (white text, 4.7:1) |
| `--accent-tint` | `rgb(0 113 227 / 0.1)` | `rgb(10 132 255 / 0.18)` | tinted buttons, highlights |
| `--green` / `--green-tint` | `#1a7330` / 0.12 | `#30d158` / 0.18 | "Decided", decisions |
| `--orange` / `--orange-tint` | `#a54a00` / 0.12 | `#ff9f0a` / 0.18 | "Summary pending", warnings |

Text colours meet WCAG AA (4.5:1) on `--bg` and `--surface` in both modes.
Links in running text are underlined (blue alone isn't distinct enough from
black text); navigation links and buttons are not.

## Spacing and shape

- 4 px base: 4, 8, 12, 16, 20, 24, 32, 40, 56. Sections are 40 px apart; cards 12 px.
- Content column: `48rem` max, 16 px side gutters on phones, 24 px from 640 px up.
- Radius: cards and lists 18 px, controls 10–12 px, buttons and pills fully round.
- No borders on cards in light mode (white on grey is enough); no shadows except
  the selected segment of the segmented control and the header material.

## Components

- **Header:** sticky translucent material (`--surface` at 72% + `backdrop-filter:
  saturate(180%) blur(20px)`) with a faint hairline; content scrolls under it.
  Opaque when the browser can't blur, or with reduced transparency or higher
  contrast. Course name left (headline weight), navigation and account right;
  the current page is shown in primary text colour and semibold.
- **Page title area:** small "‹ All meetings" back link, large title, one line of
  secondary facts (date · time · place).
- **Meeting tabs:** segmented control. Grey track (`--fill`), equal segments, the
  selected one raised (`--surface` + small shadow). Full width on phones.
- **Lists of meetings:** one grouped list (rounded surface, rows separated by inset
  hairlines). Each row: title, secondary date line, status on the right
  ("Today" as an accent pill; other statuses as small secondary text), chevron.
  The whole row is the link.
- **Cards** (questions, decisions): `--surface`, radius 18 px, 20–24 px padding.
  Question cards show a small "Question N" label above the headline, the
  context, and an action row: status ("✓ Answered" in green) on the left,
  "See responses" (when allowed) and "Answer" / "Edit answer" on the right.
  The survey itself is not on the page, so the pre-meeting reads without it.
- **Sheets** (the survey of one question): a modal `<dialog>` (keeps focus
  inside, closes with Escape, makes the page inert). Header with the question
  and a round close button; the body scrolls. Closes with ×, Escape, or a click
  on the dimmed backdrop (only if the press started there). Opening focuses the
  title, not a field (no keyboard popping up on phones); closing returns focus
  to the button that opened it. From 641 px: centred, 36rem wide, rises 24 px
  and scales from 0.97. Phones: a bottom sheet, full width, rounded top corners,
  slides up from the bottom edge. Both leave along the same path they came
  (iOS sheet curve `cubic-bezier(0.32, 0.72, 0, 1)`, 0.4 s); the backdrop dims
  to 38% black. No grabber, since sheets can't be dragged (yet).
- **Buttons:** pill shaped, at least 44 px tall. Primary = filled accent (one per
  form: "Save answer"); secondary = tinted accent ("Show other responses",
  "Sign in"); tertiary = plain accent text ("Remove my answer", "Sign out").
- **Forms:** options are rows in a grouped `--surface-2` box with native radio
  buttons / checkboxes (`accent-color`), whole row clickable, checked row tinted.
  Text fields: 12 px radius, `--control-border`, accent focus ring.
- **Survey results:** per option a label, a thin rounded bar (accent on `--fill`)
  and a count; names in footnote size below. Written answers as a list with
  hairlines.
- **Notices:** rounded callouts in `--fill` (information) or `--orange-tint`
  (problems), callout size text. Status messages next to buttons are short.
- **Agenda:** a grouped list; time in secondary tabular figures on the left.

## Motion

- Buttons, segments and list rows react on press: `transform: scale(0.97)`
  (rows: background change) in 100 ms. Colour changes ease in 150–200 ms.
- No decorative or looping animation. Animate only `transform`, `opacity` and
  colours.
- `prefers-reduced-motion: reduce`: no scaling or movement, only colour changes;
  sheets fade in and out in 0.2 s instead of sliding.
- `prefers-reduced-transparency: reduce` and `prefers-contrast: more`: opaque
  header; with more contrast also stronger separators, card outlines and darker
  secondary text.
- Future gesture-driven features (drag, swipe, sheets) follow the skill's motion
  rules: interruptible, springs, velocity hand-off, spatially consistent.

## Checking a change

1. `npm run dev` (port 4321) and `npm run dev:mock` (port 4322, signed in with
   survey states).
2. Look at the start page, a meeting's three tabs, the Decisions page, and the
   survey sheet in each state (signed out, answering, responses shown), in
   light and dark, at 320 px and desktop width.
3. Tab through the page: every control shows a focus ring and nothing is hidden
   under the sticky header.
