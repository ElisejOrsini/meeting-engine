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
// - A meeting that is still finding a time ("planned meeting") sits on the
//   first day of its grid, with its days shaded; its sheet is the
//   availability grid (schedule.js). Organizers add meetings with "+ Add".
//
// Dates are "YYYY-MM-DD" strings (Zurich time, like the rest of the site);
// the arithmetic below works on them in UTC so no time zone can shift a day.

import { html, raw, link } from './dom.js';
import { localToday, meetingFacts, timeRange, plural, daysLabel } from './views.js';
import { openSchedule } from './schedule.js';
import {
  taskSheet, checkinSheet, suggestionSheet, itemSheetId, suggestionSheetId, itemSubtitle, itemFields,
  readItemFields, wireWhoPickers, wireItemActions, openCheckin, nameOf, plainText, announce,
} from './items.js';
import { zurichToDate } from './calendar.js';

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

// Small line icons, one per kind of item (tasks and check-ins come later).
const ICONS = {
  meeting: raw('<circle cx="6" cy="5.6" r="2.2"/><path d="M2.2 13.2c0-2.2 1.7-3.8 3.8-3.8s3.8 1.6 3.8 3.8"/><circle cx="11.3" cy="6.3" r="1.7"/><path d="M11.2 9.5c1.8 0 3 1.4 3 3.3"/>'),
  window: raw('<circle cx="8" cy="8" r="5.8"/><path d="M8 4.9V8l2.1 1.5"/>'),
  checkin: raw('<path d="M3.2 3h9.6c.6 0 1 .4 1 1v6.2c0 .6-.4 1-1 1H7.2L4.4 13.6v-2.4H3.2c-.6 0-1-.4-1-1V4c0-.6.4-1 1-1z"/><path d="M5 6.1h6M5 8.3h3.8"/>'),
  task: raw('<path d="M4 14.2V2.4"/><path d="M4 2.9h8l-1.8 2.7L12 8.4H4"/>'),
};
ICONS.suggestion = ICONS.task;
function chip(kind, past) {
  return html`<span class="chip chip-${kind} ${past ? 'is-past' : 'is-upcoming'}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind]}</svg></span>`;
}

export { daysLabel };

// What the line shows: meetings with a date, meetings still finding a time
// ("planned", on the first day of their grid), tasks and written check-ins
// (on their due date) and, for organizers, suggested tasks.
function itemsOf(site) {
  const members = site.members?.length ?? 0;
  const items = [];
  for (const item of site.items ?? []) items.push({ kind: item.kind, item, date: item.due });
  if (site.me?.organizer === true) {
    for (const s of site.suggestions ?? []) items.push({ kind: 'suggestion', suggestion: s, date: s.due });
  }
  for (const meeting of site.meetings) {
    const s = meeting.schedule;
    if (s?.days?.length) {
      items.push({ kind: 'window', meeting, date: s.days[0], end: s.days.at(-1), days: s.days, members });
    } else if (meeting.date) {
      items.push({ kind: 'meeting', meeting, date: meeting.date });
    }
  }
  const order = { window: 0, meeting: 1, checkin: 2, task: 3, suggestion: 4 };
  return items.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind]
    || (a.meeting?.time ?? '').localeCompare(b.meeting?.time ?? ''));
}

function meetingSubtitle(meeting, past) {
  const questions = meeting.questions.length;
  if (!past) return [timeRange(meeting), questions ? plural(questions, 'question') : ''].filter(Boolean).join(' · ');
  if (meeting.decisions.length) return plural(meeting.decisions.length, 'decision');
  return meeting.summary_html ? 'Summary written' : 'Summary pending';
}

// A task, check-in or suggested task on the line.
function otherRow(site, entry, { today, showDate }) {
  const past = entry.date < today;
  const rel = relativeDay(entry.date, today);
  const date = html`<span class="tl-date">${showDate ? html`<span class="tl-wd">${dayLabel(entry.date)}</span>${rel ? html`<span class="tl-rel">${rel}</span>` : ''}` : ''}</span>`;
  if (entry.kind === 'suggestion') {
    const s = entry.suggestion;
    return html`
      <button type="button" class="tl-item tl-row ${past ? 'is-past' : 'is-future'} kind-suggestion is-upcoming" data-open="${suggestionSheetId(s)}" aria-haspopup="dialog">
        ${date}
        <span class="tl-rail">${chip('suggestion', false)}</span>
        <span class="tl-card">
          <span class="tl-kind">Suggested task · organizers</span>
          <span class="tl-title">${plainText(s.what_md)}</span>
          <span class="tl-sub">From ${s.meeting_title}${s.people.length ? ` · ${s.people.map((l) => nameOf(site, l)).join(', ')}` : s.owner ? ` · ${s.owner}` : ''}</span>
        </span>
      </button>`;
  }
  const { item } = entry;
  const write = item.kind === 'checkin' && item.published && item.for_me && !past;
  return html`
    <button type="button" class="tl-item tl-row ${past ? 'is-past' : 'is-future'} kind-${item.kind} ${past ? 'is-done' : 'is-upcoming'}${item.for_me && item.kind === 'task' && !item.everyone ? ' is-mine' : ''}" data-open="${itemSheetId(item)}" aria-haspopup="dialog">
      ${date}
      <span class="tl-rail">${chip(item.kind, past)}</span>
      <span class="tl-card">
        <span class="tl-kind">${item.kind === 'checkin' ? 'Written check-in' : 'Task'}${item.published ? '' : ' · Draft'}</span>
        <span class="tl-title">${item.title}</span>
        <span class="tl-sub">${itemSubtitle(site, item)}</span>
        ${write ? html`<span class="tl-cta">${item.mine ? 'Change your update' : 'Write your update'}</span>` : ''}
      </span>
    </button>`;
}

function itemRow(item, { today, showDate, site }) {
  if (!item.meeting) return otherRow(site, item, { today, showDate });
  const { meeting } = item;
  const planned = item.kind === 'window';
  const past = (planned ? item.end : item.date) < today;
  const when = item.date < today ? 'is-past' : 'is-future'; // today's items come after the today row
  const rel = relativeDay(item.date, today);
  const s = meeting.schedule;
  return html`
    <button type="button" class="tl-item tl-row ${when} kind-${item.kind} ${past ? 'is-done' : 'is-upcoming'}" data-open="${meeting.id}" aria-haspopup="dialog">
      <span class="tl-date">${showDate ? html`<span class="tl-wd">${dayLabel(item.date)}</span>${rel ? html`<span class="tl-rel">${rel}</span>` : ''}` : ''}</span>
      <span class="tl-rail">${chip(item.kind, past)}</span>
      <span class="tl-card">
        <span class="tl-kind">${planned ? 'Planned meeting' : 'Meeting'}${meeting.draft ? ' · Draft' : ''}</span>
        <span class="tl-title">${meeting.title}</span>
        <span class="tl-sub">${planned
          ? `${daysLabel(item.date, item.end)} · ${s.filled_in} of ${item.members} answered`
          : meetingSubtitle(meeting, past)}</span>
        ${planned ? html`<span class="tl-cta">${s.mine ? 'Change your times' : 'Add your times'}</span>` : ''}
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

function sheetHeader(id, label, title) {
  return html`
    <header class="sheet-header">
      <div class="sheet-heading">
        <p class="question-label">${label}</p>
        <h2 class="sheet-title" id="tl-title-${id}" tabindex="-1">${title}</h2>
      </div>
      <button type="button" class="sheet-close" data-action="close" aria-label="Close"></button>
    </header>`;
}

function meetingSheet(meeting, today) {
  const past = meeting.date ? meeting.date < today : false;
  const questions = meeting.questions.length;
  return html`
    <dialog class="sheet tl-sheet" data-sheet="${meeting.id}" aria-labelledby="tl-title-${meeting.id}">
      ${sheetHeader(meeting.id, `Meeting${meeting.draft ? ' · Draft' : ''}`, meeting.title)}
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

// The availability sheet of a planned meeting; schedule.js fills it in.
function plannedSheet(meeting) {
  return html`
    <dialog class="sheet sheet-wide tl-sheet" data-sheet="${meeting.id}" data-schedule="${meeting.id}" aria-labelledby="tl-title-${meeting.id}">
      ${sheetHeader(meeting.id, `Planned meeting · find a time${meeting.draft ? ' · Draft' : ''}`, meeting.title)}
      <div class="sheet-body">
        <div class="av" data-av><p class="muted">Loading…</p></div>
        <p class="tl-sheet-actions"><a class="link-button" href="${link('m', meeting.id)}">Open the meeting page (pre-reading and questions)</a></p>
      </div>
    </dialog>`;
}

// "+ Add" for organizers: a meeting that still has to find a time, or one
// with a fixed time. Both are visible to the team at once.
function addSheet(site, today) {
  const monday = addDays(weekStartOf(today), 7);
  return html`
    <dialog class="sheet tl-sheet" data-sheet="__add" aria-labelledby="tl-title-add">
      ${sheetHeader('add', 'Organizers', 'Add to the timeline')}
      <div class="sheet-body">
        <form class="tl-add" novalidate>
          <fieldset class="field">
            <legend>What</legend>
            <div class="options">
              <label class="option"><input type="radio" name="kind" value="find" checked> <span>Find a time for a meeting</span></label>
              <label class="option"><input type="radio" name="kind" value="fixed"> <span>Meeting with a fixed time</span></label>
              <label class="option"><input type="radio" name="kind" value="task"> <span>Task</span></label>
              <label class="option"><input type="radio" name="kind" value="checkin"> <span>Written check-in</span></label>
            </div>
          </fieldset>
          <div data-for="find fixed">
            <div class="field">
              <label for="add-title">Title</label>
              <input id="add-title" name="title" class="text-input" maxlength="200" autocomplete="off" placeholder="e.g. Exam preparation">
            </div>
          </div>
          <div data-for="task" hidden>${itemFields(site, 'task', 'add-task', { due: monday })}</div>
          <div data-for="checkin" hidden>${itemFields(site, 'checkin', 'add-checkin', { due: addDays(monday, 4) })}</div>
          <div data-for="find">
            <div class="add-row">
              <div class="field"><label for="add-from">First day</label><input id="add-from" name="from" type="date" class="text-input" value="${monday}" min="${today}"></div>
              <div class="field"><label for="add-to">Last day</label><input id="add-to" name="to" type="date" class="text-input" value="${addDays(monday, 4)}" min="${today}"></div>
            </div>
            <div class="add-row">
              <div class="field"><label for="add-start">Earliest start</label><input id="add-start" name="start" type="time" step="1800" class="text-input" value="09:00"></div>
              <div class="field"><label for="add-end">Latest end</label><input id="add-end" name="end" type="time" step="1800" class="text-input" value="18:00"></div>
            </div>
            <label class="option add-weekends"><input type="checkbox" name="weekends"> <span>Include Saturdays and Sundays</span></label>
          </div>
          <div data-for="fixed" hidden>
            <div class="add-row">
              <div class="field"><label for="add-date">Date</label><input id="add-date" name="date" type="date" class="text-input" value="${monday}" min="${today}"></div>
              <div class="field"><label for="add-time">Time</label><input id="add-time" name="time" type="time" step="900" class="text-input" value="14:00"></div>
            </div>
            <div class="field"><label for="add-place">Place <span class="muted">(optional)</span></label><input id="add-place" name="place" class="text-input" maxlength="300" autocomplete="off" placeholder="e.g. HG E 33 and Zoom"></div>
          </div>
          <div class="field" data-for="find fixed">
            <label for="add-length">Length</label>
            <select id="add-length" name="duration" class="text-input">
              <option value="30">30 minutes</option>
              <option value="60" selected>1 hour</option>
              <option value="90">1½ hours</option>
              <option value="120">2 hours</option>
            </select>
          </div>
          <div class="survey-actions">
            <button type="submit" class="button button-primary">Add to timeline</button>
            <span class="survey-status" role="status"></span>
          </div>
        </form>
      </div>
    </dialog>`;
}

/** The rows of the line, from `start` to `end`, with month headings. */
function lineRows(items, { today, semester, start, end, site }) {
  const byDate = new Map();
  const busy = new Set(); // days with something on (all days of a planned meeting's grid)
  for (const item of items) {
    if (!byDate.has(item.date)) byDate.set(item.date, []);
    byDate.get(item.date).push(item);
    for (const d of item.days ?? [item.date]) busy.add(d);
  }
  const windows = items.filter((it) => it.kind === 'window');
  const windowOn = (d) => windows.find((w) => d >= w.date && d <= w.end);
  const thisWeek = weekStartOf(today);
  const lastDetailWeek = addDays(thisWeek, 7 * (DETAIL_WEEKS - 1));
  const isDetailWeek = (ws) => ws >= thisWeek && ws <= lastDetailWeek;
  const hasItems = (ws) => [0, 1, 2, 3, 4, 5, 6].some((i) => busy.has(addDays(ws, i)));
  const when = (d) => (d < today ? 'is-past' : d === today ? 'is-today' : 'is-future');

  const weeks = [];
  for (let ws = weekStartOf(start); ws <= end; ws = addDays(ws, 7)) weeks.push(ws);

  const rows = []; // [date, html, isClosingTag]
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
    // Far from today, a planned meeting that started in an earlier week gets
    // a short shaded row here, so its band doesn't seem to end early.
    if (!isDetailWeek(ws)) {
      for (const w of windows.filter((x) => x.date < ws && x.end >= ws)) {
        rows.push([first, html`
          <div class="tl-span"><div class="tl-dayrow tl-row ${when(first)} is-offered is-continued">
            <span class="tl-date">until ${dayLabel(w.end)}</span>
            <span class="tl-rail"><i class="tl-daytick"></i></span>
            <span class="tl-continued">${w.meeting.title}: still finding a time</span>
          </div></div>`]);
      }
    }
    // Near today, a planned meeting's days sit inside a shaded band.
    let band = null;
    const closeBand = () => {
      if (band) rows.push([band, raw('</div>'), 'close']);
      band = null;
    };
    for (let k = 0; k < 7; k += 1) {
      const d = addDays(ws, k);
      if (d < start || d > end) continue;
      const list = byDate.get(d) ?? [];
      const win = isDetailWeek(ws) ? windowOn(d) : null;
      if (band && !win) closeBand();
      if (win && !band) {
        band = d;
        rows.push([d, raw('<div class="tl-span">'), 'open']);
      }
      if (d === today) {
        rows.push([d, html`
          <div class="tl-today tl-row is-today" id="tl-today">
            <span class="tl-date"><span class="tl-wd">${dayLabel(d)}</span></span>
            <span class="tl-rail"><i class="tl-today-dot"></i></span>
            <span class="tl-today-line">Today</span>
          </div>`]);
      }
      list.forEach((item, n) => {
        const row = itemRow(item, { today, showDate: n === 0 && d !== today, site });
        // Far from today a planned meeting has no day rows: shade just its row.
        rows.push([d, item.kind === 'window' && !isDetailWeek(ws)
          ? html`<div class="tl-span"><span class="tl-span-end">until ${dayLabel(item.end)}</span>${row}</div>` : row]);
      });
      if (!list.length && isDetailWeek(ws) && d !== today) {
        const offered = win?.days.includes(d);
        rows.push([d, html`
          <div class="tl-dayrow tl-row ${when(d)}${k >= 5 ? ' is-weekend' : ''}${offered ? ' is-offered' : ''}" aria-hidden="true">
            <span class="tl-date">${dayLabel(d)}</span>
            <span class="tl-rail"><i class="tl-daytick"></i></span>
            <span></span>
          </div>`]);
      }
    }
    closeBand();
  }

  // Month headings go where the month changes; never inside a band (it is
  // closed before the heading and opened again after it).
  const out = [];
  let month = '';
  let inBand = false;
  const thisYear = today.slice(0, 4);
  for (const [d, part, kind] of rows) {
    if (kind !== 'close' && d.slice(0, 7) !== month) {
      month = d.slice(0, 7);
      const name = fmt(d, { month: 'long' }) + (d.slice(0, 4) === thisYear ? '' : ` ${d.slice(0, 4)}`);
      if (inBand) out.push(raw('</div>'));
      out.push(html`<h2 class="tl-month tl-row ${d <= today ? 'is-past' : 'is-future'}">${name}</h2>`);
      if (inBand && kind !== 'open') out.push(raw('<div class="tl-span">'));
    }
    if (kind === 'open') inBand = true;
    if (kind === 'close') inBand = false;
    out.push(part);
  }
  return out;
}

export function timelineView(site, { today = localToday() } = {}) {
  const semester = site.course.semester ?? null;
  const items = itemsOf(site);
  const undated = site.meetings.filter((m) => !m.date && !m.schedule);
  const semesterEnd = semester ? addDays(weekStartOf(semester.start), semester.weeks * 7 - 1) : null;
  const start = minDate(today, items[0]?.date, semester?.start && weekStartOf(semester.start));
  const end = maxDate(addDays(weekStartOf(today), 7 * DETAIL_WEEKS - 1), ...items.map((it) => it.end ?? it.date), semesterEnd);
  const organizer = site.private && site.me?.organizer === true;
  return {
    title: 'Timeline',
    body: html`
      <div class="tl-head">
        <h1 tabindex="-1">Timeline</h1>
        ${organizer ? html`<button type="button" class="button button-small" data-open="__add" aria-haspopup="dialog">+ Add</button>` : ''}
      </div>
      <p class="tl-legend" aria-hidden="true">
        <span>${chip('meeting', false)}Meeting</span>
        <span>${chip('window', false)}Finding a time</span>
        <span>${chip('checkin', false)}Written check-in</span>
        <span>${chip('task', false)}Task</span>
      </p>
      ${undated.length ? html`
        <p class="muted small tl-undated">No time set yet: ${undated.map((m, i) => html`${i ? ', ' : ''}<a href="${link('m', m.id)}">${m.title}</a>`)}</p>` : ''}
      <div class="tl">${lineRows(items, { today, semester, start, end, site })}</div>
      ${items.map((it) => {
        if (it.kind === 'window') return plannedSheet(it.meeting);
        if (it.kind === 'meeting') return meetingSheet(it.meeting, today);
        if (it.kind === 'task') return taskSheet(site, it.item);
        if (it.kind === 'checkin') return checkinSheet(site, it.item);
        return suggestionSheet(site, it.suggestion);
      })}
      ${organizer ? addSheet(site, today) : ''}`,
  };
}

// ---------- behaviour ----------

let detachCurrent = null;

export function detachTimeline() {
  detachCurrent?.();
  detachCurrent = null;
}

/** The days from `from` to `to` (inclusive), without weekends unless asked. */
export function daysBetweenDates(from, to, { weekends = false } = {}) {
  const days = [];
  for (let d = from; d <= to && days.length < 60; d = addDays(d, 1)) {
    if (weekends || weekdayOf(d) < 5) days.push(d);
  }
  return days;
}

/**
 * Opens and closes the sheets of a drawn timeline, fills in the availability
 * sheets (schedule.js) and sends "+ Add". `open`: a meeting id whose sheet
 * opens right away (links like #/timeline?open=<id>).
 */
export function attachTimeline(root, { site, client, reload, open } = {}) {
  detachTimeline();
  const stop = new AbortController();
  const sheetFor = (id) => root.querySelector(`dialog.tl-sheet[data-sheet="${CSS.escape(id)}"]`);
  const meetings = new Map(site.meetings.map((m) => [m.id, m]));
  let changed = false; // something was saved in a sheet: redraw the line when it closes

  function openSheet(id) {
    const sheet = sheetFor(id);
    if (!sheet || sheet.open) return;
    sheet.showModal();
    sheet.querySelector('.sheet-title')?.focus();
    if (sheet.dataset.checkin) {
      openCheckin(sheet.querySelector('[data-checkin-box]'), (site.items ?? []).find((i) => i.id === sheet.dataset.checkin), {
        site, client, signal: stop.signal, onChange: () => { changed = true; },
      });
    }
    if (sheet.dataset.schedule) {
      openSchedule(sheet.querySelector('[data-av]'), meetings.get(sheet.dataset.schedule), {
        site, client, signal: stop.signal, onChange: () => { changed = true; },
      });
    }
  }

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
    if (opener) return openSheet(opener.dataset.open);
    if (event.target.closest('[data-action="close"]')) event.target.closest('dialog')?.close();
  }, { signal: stop.signal });

  for (const sheet of root.querySelectorAll('dialog.tl-sheet')) {
    sheet.addEventListener('close', () => {
      if (!changed || !reload) return;
      changed = false;
      // After the sheet's own close handler (schedule.js) has sent a change
      // that was still waiting. Redraw in place, focus back on the item.
      setTimeout(async () => {
        await (sheet.querySelector('[data-av]') ?? sheet.querySelector('[data-checkin-box]'))?.pending;
        if (!stop.signal.aborted) reload({ keepView: true, focus: `[data-open="${CSS.escape(sheet.dataset.sheet)}"]` });
      }, 0);
    }, { signal: stop.signal });
  }

  const form = root.querySelector('form.tl-add');
  if (form) wireAddForm(form, { site, client, reload, signal: stop.signal });
  wireWhoPickers(root, stop.signal);
  if (site.me?.organizer === true && client) wireItemActions(root, { site, client, reload, signal: stop.signal });

  if (open) openSheet(open);
  detachCurrent = () => stop.abort();
}

function wireAddForm(form, { site, client, reload, signal }) {
  const status = form.querySelector('.survey-status');
  const sync = () => {
    const kind = form.elements.kind.value;
    for (const el of form.querySelectorAll('[data-for]')) el.hidden = !el.dataset.for.split(' ').includes(kind);
  };
  form.addEventListener('change', sync, { signal });
  sync();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const f = form.elements;
    const say = (text, field) => {
      status.textContent = text;
      field?.focus();
    };
    if (f.kind.value === 'task' || f.kind.value === 'checkin') {
      const kind = f.kind.value;
      const read = readItemFields(form, kind, `add-${kind}`);
      if (read.error) return say(read.error, form.querySelector(`#${CSS.escape(read.focus)}`));
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      say('Adding…');
      try {
        const { data, error } = await client.rpc('add_item', { p_course: site.course.id, p_kind: kind, p_item: read.item });
        if (error) throw new Error(error.message);
        form.closest('dialog')?.close();
        await reload({ keepView: true, open: `item-${data.id}` });
        announce(kind === 'checkin' ? 'Check-in added.' : 'Task added.');
      } catch (err) {
        say(`Couldn’t add it: ${err.message}`);
        button.disabled = false;
      }
      return undefined;
    }
    const title = f.title.value.trim();
    if (!title) return say('Give it a title.', f.title);
    const length = Number(f.duration.value); // not "length": form.elements.length is the number of fields
    let args;
    if (f.kind.value === 'find') {
      if (!f.from.value || !f.to.value || f.to.value < f.from.value) return say('Check the days: the last day can’t be before the first.', f.to);
      const days = daysBetweenDates(f.from.value, f.to.value, { weekends: f.weekends.checked });
      if (!days.length) return say('There are no weekdays between these days. Tick “Include Saturdays and Sundays”, or pick other days.', f.from);
      if (days.length > 14) return say(`That’s ${days.length} days; 14 at most.`, f.to);
      if (!f.start.value || !f.end.value || f.end.value <= f.start.value) return say('The latest end must be after the earliest start.', f.end);
      args = {
        p_course: site.course.id,
        p_details: { title, duration_min: length },
        p_schedule: { days, from: f.start.value, to: f.end.value, slot_min: 30, duration_min: length },
      };
    } else {
      if (!f.date.value || !f.time.value) return say('Give the date and the time.', f.date);
      const place = f.place.value.trim();
      args = {
        p_course: site.course.id,
        p_details: {
          title, duration_min: length, starts_at: zurichToDate(f.date.value, f.time.value).toISOString(),
          ...(place ? { location_md: place } : {}),
        },
      };
    }
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    say('Adding…');
    try {
      const { data, error } = await client.rpc('add_meeting', args);
      if (error) throw new Error(error.message);
      form.closest('dialog')?.close();
      // Redraw with the new meeting and open its sheet (its availability grid).
      await reload({ keepView: true, open: data.id });
    } catch (err) {
      say(`Couldn’t add it: ${err.message}`);
      button.disabled = false;
    }
  }, { signal });
}

/** Scroll so that today sits in the middle of the screen. */
export function centerToday(root) {
  root.querySelector('#tl-today')?.scrollIntoView({ block: 'center' });
}
