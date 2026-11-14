// The timeline: one vertical line, September at the top.
// - Every week starts with a small header (teaching week, dates, "Next week").
// - Around today (this week and the next two) every day gets its own row with
//   its weekday, so you can see the rhythm of the days without a calendar.
// - Further away only days with something on them are shown; weeks with
//   nothing at all are merged into one line ("Weeks 5–6 · nothing on").
// - Each kind of item has its own icon and colour on the line.
// Past = solid line, future = dashed.
import {
  startMockup, RANGE, TODAY, addDays, daysBetween, fmt, weekdayOf, teachingWeek, esc,
  itemDate, isPast, kindLabel, itemSubtitle, chip,
} from './mockup.js';

const weekStartOf = (d) => addDays(d, -weekdayOf(d));
const THIS_WEEK = weekStartOf(TODAY);
const isDetailWeek = (ws) => ws >= THIS_WEEK && ws <= addDays(THIS_WEEK, 14);
const when = (d) => (d < TODAY ? 'is-past' : d === TODAY ? 'is-today' : 'is-future');
const dayLabel = (d) => `${fmt(d, { weekday: 'short' })} ${Number(d.slice(8))}`; // "Tue 17"

function rangeLabel(a, b) {
  const sameMonth = a.slice(0, 7) === b.slice(0, 7);
  return sameMonth
    ? `${Number(a.slice(8))}–${fmt(b, { day: 'numeric', month: 'short' })}`
    : `${fmt(a, { day: 'numeric', month: 'short' })} – ${fmt(b, { day: 'numeric', month: 'short' })}`;
}
function relWeek(ws) {
  const n = daysBetween(THIS_WEEK, ws) / 7;
  if (n === 0) return 'This week';
  if (n === 1) return 'Next week';
  if (n === -1) return 'Last week';
  return n > 0 ? `In ${n} weeks` : `${-n} weeks ago`;
}
function relDay(d) {
  const n = daysBetween(TODAY, d);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1 && n < 14) return `in ${n} days`;
  if (n < -1 && n > -14) return `${-n} days ago`;
  return '';
}

function itemRow(it, showDate) {
  const d = itemDate(it);
  const rel = relDay(d);
  return `
    <button type="button" class="vt-item vt-row ${when(d)} kind-${it.type} ${isPast(it) ? 'is-done' : 'is-upcoming'}" data-id="${esc(it.id)}">
      <span class="vt-date">${showDate ? `<span class="vt-wd">${esc(dayLabel(d))}</span>${rel ? `<span class="vt-rel">${esc(rel)}</span>` : ''}` : ''}</span>
      <span class="vt-rail">${chip(it)}</span>
      <span class="vt-card">
        <span class="vt-kind">${esc(kindLabel(it))}</span>
        <span class="vt-title">${esc(it.title)}</span>
        <span class="vt-sub">${esc(itemSubtitle(it, { withDate: false }))}</span>
        ${it.type === 'window' ? '<span class="fake-button">Add your times</span>' : ''}
      </span>
    </button>`;
}

function weekHead(ws, { toWs = ws, quiet = false } = {}) {
  const we = addDays(toWs, 6);
  const a = teachingWeek(ws);
  const b = teachingWeek(toWs);
  const label = a && b ? (a === b ? `Week ${a}` : `Weeks ${a}–${b}`) : '';
  const rel = toWs === ws ? relWeek(ws) : '';
  const extra = quiet ? (we < TODAY ? 'nothing on' : 'nothing planned yet') : rel;
  const first = ws < RANGE.start ? RANGE.start : ws;
  return `
    <div class="vt-weekhead vt-row ${when(first)}${ws === THIS_WEEK ? ' is-current' : ''}${quiet ? ' is-quiet' : ''}">
      <span class="vt-date">${esc(label)}</span>
      <span class="vt-rail"><i class="vt-wtick"></i></span>
      <span class="vt-weektext">${esc(rangeLabel(first, we))}${extra ? ` <span class="vt-relweek">· ${esc(extra)}</span>` : ''}</span>
    </div>`;
}

function render(root, items, { first } = {}) {
  const byDate = new Map();
  for (const it of items) {
    const d = itemDate(it);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(it);
  }
  const windows = items.filter((it) => it.type === 'window');
  const inWindow = (d) => windows.find((w) => d >= w.start && d <= w.end);

  const rows = []; // [date, html]: month headers are slotted in where the month changes
  const weeks = [];
  for (let ws = weekStartOf(RANGE.start); ws <= RANGE.end; ws = addDays(ws, 7)) weeks.push(ws);
  const hasItems = (ws) => [...Array(7).keys()].some((i) => byDate.has(addDays(ws, i)));

  for (let i = 0; i < weeks.length; i += 1) {
    const ws = weeks[i];
    if (!isDetailWeek(ws) && !hasItems(ws)) {
      // Merge a run of empty weeks into one quiet line.
      let j = i;
      while (j + 1 < weeks.length && !isDetailWeek(weeks[j + 1]) && !hasItems(weeks[j + 1])
        && (weeks[j + 1] < THIS_WEEK) === (ws < THIS_WEEK)) j += 1;
      rows.push([ws < RANGE.start ? RANGE.start : ws, weekHead(ws, { toWs: weeks[j], quiet: true })]);
      i = j;
      continue;
    }
    rows.push([ws < RANGE.start ? RANGE.start : ws, weekHead(ws)]);
    let span = null;
    const closeSpan = () => { if (span) { rows.push([span.date, '</div>']); span = null; } };
    for (let k = 0; k < 7; k += 1) {
      const d = addDays(ws, k);
      if (d < RANGE.start || d > RANGE.end) continue;
      const list = byDate.get(d) ?? [];
      const win = inWindow(d);
      if (isDetailWeek(ws)) {
        if (span && win !== span.win) closeSpan();
        if (win && !span) { span = { win, date: d }; rows.push([d, '<div class="vt-span">']); }
      }
      if (d === TODAY) {
        rows.push([d, `
          <div class="vt-today vt-row is-today" id="today">
            <span class="vt-date"><span class="vt-wd">${esc(dayLabel(d))}</span></span>
            <span class="vt-rail"><i class="vt-today-dot"></i></span>
            <span class="vt-today-line">Today</span>
          </div>`]);
      }
      if (list.length) {
        list.forEach((it, n) => {
          const html = itemRow(it, n === 0 && d !== TODAY);
          // Far from today a planned meeting has no day rows; shade just its row.
          rows.push([d, it.type === 'window' && !isDetailWeek(ws)
            ? `<div class="vt-span"><span class="vt-span-end">until ${esc(dayLabel(it.end))}</span>${html}</div>` : html]);
        });
      } else if (isDetailWeek(ws) && d !== TODAY) {
        rows.push([d, `
          <div class="vt-dayrow vt-row ${when(d)}${k >= 5 ? ' is-weekend' : ''}">
            <span class="vt-date">${esc(dayLabel(d))}</span>
            <span class="vt-rail"><i class="vt-daytick"></i></span>
            <span></span>
          </div>`]);
      }
    }
    closeSpan();
  }

  let month = '';
  let html = '';
  for (const [d, part] of rows) {
    if (!part.startsWith('</div') && d.slice(0, 7) !== month) {
      month = d.slice(0, 7);
      html += `<h2 class="vt-month vt-row ${when(d)}">${esc(fmt(d, { month: 'long' }))}</h2>`;
    }
    html += part;
  }
  root.innerHTML = `<div class="vt">${html}</div>`;
  if (first) requestAnimationFrame(() => root.querySelector('#today').scrollIntoView({ block: 'center' }));
}

startMockup({ render });
