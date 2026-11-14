// The Timeline page (#/timeline): every meeting on one vertical line, the
// oldest at the top. The design is in docs/timeline-design/DECISION.md.
//
// - Every week starts with a small header: the teaching week (if course.yml
//   has `semester:`), the dates and "Next week" / "3 weeks ago".
// - This week and the next two show every day as its own slim row, so the
//   rhythm of the days is visible without a calendar.
// - Further away only days with something on them are shown; runs of empty
//   weeks merge into one quiet line ("Weeks 5–6 · 12–25 Oct · nothing on").
// - The line is solid up to today and dashed after it.
// - A click on a meeting opens a sheet with its facts, summary and
//   decisions, and "Open meeting".
//
// Dates are "YYYY-MM-DD" strings (Zurich time, like the rest of the site);
// the arithmetic below works on them in UTC so no time zone can shift a day.

import { html, raw, link } from './dom.js';
import { localToday, meetingFacts, timeRange, plural } from './views.js';

const DAY_MS = 864e5;
const DETAIL_WEEKS = 3; // this week and the next two: day by day

const asDate = (s) => new Date(`${s}T00:00:00Z`);
export function addDays(s, n) {
  const d = asDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((asDate(b) - asDate(a)) / DAY_MS);
const weekdayOf = (s) => (asDate(s).getUTCDay() + 6) % 7; // 0 = Monday
export const weekStartOf = (s) => addDays(s, -weekdayOf(s));
const fmt = (s, opts) => asDate(s).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
const dayLabel = (s) => `${fmt(s, { weekday: 'short' })} ${Number(s.slice(8))}`; // "Tue 17"
const minDate = (...dates) => dates.filter(Boolean).sort()[0];
const maxDate = (...dates) => dates.filter(Boolean).sort().at(-1);

/** Teaching week of `date` (1 … semester.weeks), or null outside the semester. */
export function teachingWeek(semester, date) {
  if (!semester?.start) return null;
  const n = Math.floor(daysBetween(weekStartOf(semester.start), date) / 7) + 1;
  return n >= 1 && n <= (semester.weeks ?? 14) ? n : null;
}

/** "16–22 Nov" or "30 Nov – 6 Dec". */
export function rangeLabel(a, b) {
  return a.slice(0, 7) === b.slice(0, 7)
    ? `${Number(a.slice(8))}–${fmt(b, { day: 'numeric', month: 'short' })}`
    : `${fmt(a, { day: 'numeric', month: 'short' })} – ${fmt(b, { day: 'numeric', month: 'short' })}`;
}

/** "This week", "Next week", "Last week", "In 3 weeks", "3 weeks ago". */
export function relativeWeek(weekStart, today) {
  const n = daysBetween(weekStartOf(today), weekStart) / 7;
  if (n === 0) return 'This week';
  if (n === 1) return 'Next week';
  if (n === -1) return 'Last week';
  return n > 0 ? `In ${n} weeks` : `${-n} weeks ago`;
}

/** "today", "tomorrow", "in 3 days", "4 days ago"; '' beyond ±13 days. */
export function relativeDay(date, today) {
  const n = daysBetween(today, date);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1 && n < 14) return `in ${n} days`;
  if (n < -1 && n > -14) return `${-n} days ago`;
  return '';
}

// Small line icons, one per kind of item (more kinds come with scheduling,
// tasks and check-ins).
const ICONS = {
  meeting: raw('<circle cx="6" cy="5.6" r="2.2"/><path d="M2.2 13.2c0-2.2 1.7-3.8 3.8-3.8s3.8 1.6 3.8 3.8"/><circle cx="11.3" cy="6.3" r="1.7"/><path d="M11.2 9.5c1.8 0 3 1.4 3 3.3"/>'),
};
function chip(kind, past) {
  return html`<span class="chip chip-${kind} ${past ? 'is-past' : 'is-upcoming'}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind]}</svg></span>`;
}

function meetingSubtitle(meeting, past) {
  const questions = meeting.questions.length;
  if (!past) return [timeRange(meeting), questions ? plural(questions, 'question') : ''].filter(Boolean).join(' · ');
  if (meeting.decisions.length) return plural(meeting.decisions.length, 'decision');
  return meeting.summary_html ? 'Summary written' : 'Summary pending';
}

function itemRow(meeting, { today, showDate }) {
  const past = meeting.date < today;
  const when = past ? 'is-past' : 'is-future'; // today's meetings come after the today row
  const rel = relativeDay(meeting.date, today);
  return html`
    <button type="button" class="tl-item tl-row ${when} kind-meeting ${past ? 'is-done' : 'is-upcoming'}" data-open="${meeting.id}" aria-haspopup="dialog">
      <span class="tl-date">${showDate ? html`<span class="tl-wd">${dayLabel(meeting.date)}</span>${rel ? html`<span class="tl-rel">${rel}</span>` : ''}` : ''}</span>
      <span class="tl-rail">${chip('meeting', past)}</span>
      <span class="tl-card">
        <span class="tl-kind">Meeting${meeting.draft ? ' · Draft' : ''}</span>
        <span class="tl-title">${meeting.title}</span>
        <span class="tl-sub">${meetingSubtitle(meeting, past)}</span>
      </span>
    </button>`;
}

function weekHead(weekStart, { toWeek = weekStart, quiet = false, first, today, semester }) {
  const weekEnd = addDays(toWeek, 6);
  const a = teachingWeek(semester, weekStart);
  const b = teachingWeek(semester, toWeek);
  const label = a && b ? (a === b ? `Week ${a}` : `Weeks ${a}–${b}`) : '';
  const extra = quiet ? (weekEnd < today ? 'nothing on' : 'nothing planned yet') : relativeWeek(weekStart, today);
  const when = first <= today ? 'is-past' : 'is-future'; // the line is solid up to today
  const current = weekStart === weekStartOf(today);
  return html`
    <h3 class="tl-weekhead tl-row ${when}${current ? ' is-current' : ''}${quiet ? ' is-quiet' : ''}">
      <span class="tl-date">${label}</span>
      <span class="tl-rail"><i class="tl-wtick"></i></span>
      <span class="tl-weektext">${rangeLabel(first, weekEnd)} <span class="tl-relweek">· ${extra}</span></span>
    </h3>`;
}

function meetingSheet(meeting, today) {
  const past = meeting.date ? meeting.date < today : false;
  const questions = meeting.questions.length;
  return html`
    <dialog class="sheet tl-sheet" data-sheet="${meeting.id}" aria-labelledby="tl-title-${meeting.id}">
      <header class="sheet-header">
        <div class="sheet-heading">
          <p class="question-label">Meeting${meeting.draft ? ' · Draft' : ''}</p>
          <h2 class="sheet-title" id="tl-title-${meeting.id}" tabindex="-1">${meeting.title}</h2>
        </div>
        <button type="button" class="sheet-close" data-action="close" aria-label="Close"></button>
      </header>
      <div class="sheet-body">
        ${meetingFacts(meeting)}
        ${past ? html`
          ${meeting.summary_html ? html`<div class="prose tl-summary">${raw(meeting.summary_html)}</div>`
            : html`<p class="muted">No summary yet.</p>`}
          ${meeting.decisions.length ? html`
            <h3 class="tl-sheet-h">${plural(meeting.decisions.length, 'decision')}</h3>
            <ul class="tl-decisions">${meeting.decisions.map((d) => html`<li><div class="prose">${raw(d.decision_html)}</div></li>`)}</ul>` : ''}`
          : html`
          <p>${questions ? `${plural(questions, 'question')} to think about before the meeting.` : 'Nothing to prepare yet.'}</p>`}
        <p class="tl-sheet-actions"><a class="button button-primary" href="${link('m', meeting.id)}">Open meeting</a></p>
      </div>
    </dialog>`;
}

/** The rows of the line, from `start` to `end`, with month headings. */
function lineRows(meetings, { today, semester, start, end }) {
  const byDate = new Map();
  for (const m of meetings) {
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  }
  const thisWeek = weekStartOf(today);
  const lastDetailWeek = addDays(thisWeek, 7 * (DETAIL_WEEKS - 1));
  const isDetailWeek = (ws) => ws >= thisWeek && ws <= lastDetailWeek;
  const hasItems = (ws) => [0, 1, 2, 3, 4, 5, 6].some((i) => byDate.has(addDays(ws, i)));
  const when = (d) => (d < today ? 'is-past' : d === today ? 'is-today' : 'is-future');

  const weeks = [];
  for (let ws = weekStartOf(start); ws <= end; ws = addDays(ws, 7)) weeks.push(ws);

  const rows = []; // [date, html]
  for (let i = 0; i < weeks.length; i += 1) {
    const ws = weeks[i];
    const first = maxDate(ws, start);
    if (!isDetailWeek(ws) && !hasItems(ws)) {
      // Merge a run of empty weeks into one quiet line; a run never crosses today.
      let j = i;
      while (j + 1 < weeks.length && !isDetailWeek(weeks[j + 1]) && !hasItems(weeks[j + 1])
        && (weeks[j + 1] < thisWeek) === (ws < thisWeek)) j += 1;
      rows.push([first, weekHead(ws, { toWeek: weeks[j], quiet: true, first, today, semester })]);
      i = j;
      continue;
    }
    rows.push([first, weekHead(ws, { first, today, semester })]);
    for (let k = 0; k < 7; k += 1) {
      const d = addDays(ws, k);
      if (d < start || d > end) continue;
      const list = byDate.get(d) ?? [];
      if (d === today) {
        rows.push([d, html`
          <div class="tl-today tl-row is-today" id="tl-today">
            <span class="tl-date"><span class="tl-wd">${dayLabel(d)}</span></span>
            <span class="tl-rail"><i class="tl-today-dot"></i></span>
            <span class="tl-today-line">Today</span>
          </div>`]);
      }
      list.forEach((m, n) => rows.push([d, itemRow(m, { today, showDate: n === 0 && d !== today })]));
      if (!list.length && isDetailWeek(ws) && d !== today) {
        rows.push([d, html`
          <div class="tl-dayrow tl-row ${when(d)}${k >= 5 ? ' is-weekend' : ''}" aria-hidden="true">
            <span class="tl-date">${dayLabel(d)}</span>
            <span class="tl-rail"><i class="tl-daytick"></i></span>
            <span></span>
          </div>`]);
      }
    }
  }

  const out = [];
  let month = '';
  const thisYear = today.slice(0, 4);
  for (const [d, part] of rows) {
    if (d.slice(0, 7) !== month) {
      month = d.slice(0, 7);
      const name = fmt(d, { month: 'long' }) + (d.slice(0, 4) === thisYear ? '' : ` ${d.slice(0, 4)}`);
      out.push(html`<h2 class="tl-month tl-row ${d <= today ? 'is-past' : 'is-future'}">${name}</h2>`);
    }
    out.push(part);
  }
  return out;
}

export function timelineView(site, { today = localToday() } = {}) {
  const semester = site.course.semester ?? null;
  const dated = site.meetings.filter((m) => m.date)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
  const undated = site.meetings.filter((m) => !m.date);
  const semesterEnd = semester ? addDays(weekStartOf(semester.start), semester.weeks * 7 - 1) : null;
  const start = minDate(today, dated[0]?.date, semester?.start && weekStartOf(semester.start));
  const end = maxDate(addDays(weekStartOf(today), 7 * DETAIL_WEEKS - 1), dated.at(-1)?.date, semesterEnd);
  return {
    title: 'Timeline',
    body: html`
      <h1 tabindex="-1">Timeline</h1>
      ${undated.length ? html`
        <p class="muted small tl-undated">No time set yet: ${undated.map((m, i) => html`${i ? ', ' : ''}<a href="${link('m', m.id)}">${m.title}</a>`)}</p>` : ''}
      <div class="tl">${lineRows(dated, { today, semester, start, end })}</div>
      ${dated.map((m) => meetingSheet(m, today))}`,
  };
}

// ---------- behaviour ----------

let detachCurrent = null;

export function detachTimeline() {
  detachCurrent?.();
  detachCurrent = null;
}

/** Opens and closes the sheets of a drawn timeline. */
export function attachTimeline(root) {
  detachTimeline();
  const stop = new AbortController();
  const sheetFor = (id) => root.querySelector(`dialog.tl-sheet[data-sheet="${CSS.escape(id)}"]`);

  // A click on the dimmed backdrop closes the sheet, but only if the press
  // started there too (not when selecting text and releasing outside).
  let pressedBackdrop = null;
  root.addEventListener('pointerdown', (event) => {
    pressedBackdrop = event.target.matches?.('dialog.tl-sheet') ? event.target : null;
  }, { signal: stop.signal });

  root.addEventListener('click', (event) => {
    if (event.target.matches?.('dialog.tl-sheet')) {
      if (pressedBackdrop === event.target) event.target.close();
      return;
    }
    const opener = event.target.closest('[data-open]');
    if (opener) {
      const sheet = sheetFor(opener.dataset.open);
      if (!sheet || sheet.open) return;
      sheet.showModal();
      sheet.querySelector('.sheet-title')?.focus();
      return;
    }
    if (event.target.closest('[data-action="close"]')) event.target.closest('dialog')?.close();
  }, { signal: stop.signal });

  detachCurrent = () => stop.abort();
}

/** Scroll so that today sits in the middle of the screen. */
export function centerToday(root) {
  root.querySelector('#tl-today')?.scrollIntoView({ block: 'center' });
}
