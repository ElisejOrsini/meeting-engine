// Shared data and behaviour for the timeline mockups. NOT part of the app:
// made-up data, nothing is saved. Each layout (vertical.js, horizontal.js,
// calendar.js) only draws the line; the sheets behind every click live here.

export const TODAY = '2026-11-14';
export const RANGE = { start: '2026-09-01', end: '2026-12-23' };
const SEMESTER_START = '2026-09-14'; // Monday of teaching week 1
export const ME = 'You';
export const TEAM = [ME, 'Mia', 'Jonas', 'Lea', 'Noah', 'Sara', 'Luca', 'Nina', 'Tim', 'Anja', 'Felix'];

// ---------- small helpers ----------

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const D = (s) => new Date(`${s}T00:00:00Z`);
export const isoOf = (d) => d.toISOString().slice(0, 10);
export function addDays(s, n) { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); }
export const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 864e5);
export const fmt = (s, opts) => D(s).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
export const fmtDay = (s) => fmt(s, { weekday: 'short', day: 'numeric', month: 'short' }); // "Tue 17 Nov"
export const weekdayOf = (s) => (D(s).getUTCDay() + 6) % 7; // 0 = Monday
export function teachingWeek(s) {
  const n = Math.floor(daysBetween(SEMESTER_START, s) / 7) + 1;
  return n >= 1 && n <= 14 ? n : null;
}
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const timeRange = (it) => (it.time ? `${it.time}–${hhmm(toMin(it.time) + (it.duration ?? 60))}` : '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function rangeText(a, b) {
  return fmt(a, { month: 'short' }) === fmt(b, { month: 'short' })
    ? `${fmt(a, { weekday: 'short', day: 'numeric' })} – ${fmtDay(b)}`
    : `${fmtDay(a)} – ${fmtDay(b)}`;
}

// ---------- made-up data: a TA team's autumn semester ----------

function rng(seed) { // small deterministic random generator (mulberry32)
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeAvailability(win) {
  const days = daysBetween(win.start, win.end) + 1;
  const slots = ((win.to - win.from) * 60) / win.slot;
  const out = Object.fromEntries(TEAM.map((n) => [n, new Set()]));
  ['Mia', 'Jonas', 'Lea', 'Noah', 'Sara', 'Luca', 'Nina'].forEach((name, i) => {
    const r = rng(17 + i * 101);
    const set = new Set();
    for (let d = 0; d < days; d += 1) {
      let free = r() < 0.55;
      for (let s = 0; s < slots; s += 1) {
        if (r() < 0.22) free = !free;
        if (free) set.add(`${d}:${s}`);
      }
    }
    if (name !== 'Noah') ['1:10', '1:11'].forEach((k) => set.add(k)); // Tue 14:00–15:00 works for most
    if (name !== 'Lea' && name !== 'Sara') ['3:2', '3:3'].forEach((k) => set.add(k)); // Thu 10:00–11:00
    out[name] = set;
  });
  return out;
}

const windowItem = {
  id: 'exam-prep', type: 'window', title: 'Exam preparation', start: '2026-11-23', end: '2026-11-27',
  from: 9, to: 18, slot: 30, duration: 60,
};
windowItem.availability = fakeAvailability(windowItem);

export const state = {
  items: [
    { id: 'kickoff', type: 'meeting', date: '2026-09-08', time: '14:00', duration: 60, title: 'Kick-off and roles', place: 'HG E 33',
      summary: 'Who takes which exercise sheets, how we share the grading, and how often we meet.',
      decisions: ['Each TA owns two exercise sheets, in rotation.', 'We meet every second Tuesday, plus extra meetings when needed.'] },
    { id: 'format', type: 'meeting', date: '2026-09-22', time: '14:00', duration: 60, title: 'Exercise session format', place: 'HG E 33',
      summary: 'First feedback from the sessions; recap or straight into exercises?',
      decisions: ['Every session starts with a 10-minute recap of the lecture.'] },
    { id: 'rubric', type: 'meeting', date: '2026-10-06', time: '14:00', duration: 60, title: 'Grading rubric', place: 'Online',
      summary: 'A shared rubric so grades don’t depend on who marks.',
      decisions: ['Four levels per task: missing, partial, mostly, complete.', 'Borderline cases get a second marker.'] },
    { id: 'sessions-review', type: 'meeting', date: '2026-10-27', time: '14:00', duration: 60, title: 'Exercise sessions review', place: 'HG E 33',
      summary: 'Halfway through: what works in the sessions and what doesn’t.',
      decisions: ['Keep the recap, drop the weekly quiz.'] },
    { id: 'milestones', type: 'meeting', date: '2026-11-10', time: '14:00', duration: 60, title: 'Project milestones', place: 'HG E 33',
      summary: 'Milestone 1 went well; several groups asked for more time for milestone 2.',
      decisions: ['Milestone 2 moves to Fri 27 Nov.'] },
    { id: 'late', type: 'meeting', date: '2026-11-17', time: '14:00', duration: 60, title: 'Late submissions', place: 'HG E 33 and online',
      questions: 2, answered: 1 },
    { id: 'retro', type: 'meeting', date: '2026-12-15', time: '16:00', duration: 60, title: 'Semester retro', place: 'HG E 33',
      questions: 0, answered: 0 },
    windowItem,
    { id: 'sheet9', type: 'task', date: '2026-11-19', title: 'Upload exercise sheet 9', who: 'Mia',
      details: 'Solutions go up after the Friday sessions.', from: 'milestones' },
    { id: 'exam-draft', type: 'task', date: '2026-12-04', title: 'Draft exam questions', who: 'Everyone',
      details: 'Two questions each, with a short solution, in the shared exam folder.', from: 'milestones' },
    { id: 'status', type: 'checkin', date: '2026-11-20', title: 'Project status',
      prompt: 'How are your project groups doing? Anything blocking you?',
      updates: [
        { who: 'Mia', when: '12 Nov', text: 'Group B is on track. Two groups still struggle with the data loader; I’ll run an extra office hour on Thursday.' },
        { who: 'Jonas', when: '12 Nov', text: 'All four of my groups handed in milestone 1. One group is a member short since last week.' },
        { who: 'Lea', when: '13 Nov', text: 'Fine overall. Group 7 wants to change its topic; we should decide before the 27th.' },
        { who: 'Noah', when: '13 Nov', text: 'Nothing blocking.' },
        { who: 'Sara', when: '13 Nov', text: 'Two groups are behind. I asked them for a plan by Monday.' },
        { who: 'Nina', when: '14 Nov', text: 'On track. Could someone cover my Friday session on 27 Nov?' },
      ] },
  ],
};

// ---------- what every layout needs to know about an item ----------

export const itemDate = (it) => (it.type === 'window' ? it.start : it.date);
export const isPast = (it) => (it.type === 'window' ? it.end < TODAY : it.date < TODAY);
export const kindLabel = (it) => ({ meeting: 'Meeting', window: 'Planned meeting', task: 'Task', checkin: 'Written check-in' }[it.type]);

// Small line icons, one per kind, so the kinds can be told apart at a glance.
const ICONS = {
  meeting: '<circle cx="6" cy="5.6" r="2.2"/><path d="M2.2 13.2c0-2.2 1.7-3.8 3.8-3.8s3.8 1.6 3.8 3.8"/><circle cx="11.3" cy="6.3" r="1.7"/><path d="M11.2 9.5c1.8 0 3 1.4 3 3.3"/>',
  window: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.9V8l2.1 1.5"/>',
  checkin: '<path d="M3.2 3h9.6c.6 0 1 .4 1 1v6.2c0 .6-.4 1-1 1H7.2L4.4 13.6v-2.4H3.2c-.6 0-1-.4-1-1V4c0-.6.4-1 1-1z"/><path d="M5 6.1h6M5 8.3h3.8"/>',
  task: '<path d="M4 14.2V2.4"/><path d="M4 2.9h8l-1.8 2.7L12 8.4H4"/>',
};
export const icon = (type) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[type]}</svg>`;
/** A round icon chip for the line: colour by kind, grey once it's past. */
export const chip = (it) => `<span class="chip chip-${it.type} ${isPast(it) ? 'is-past' : 'is-upcoming'}">${icon(it.type)}</span>`;
export const answeredCount = (win) => Object.values(win.availability).filter((s) => s.size).length;

export function itemSubtitle(it, { withDate = true } = {}) {
  const date = withDate && it.type !== 'window' ? fmtDay(it.date) : '';
  if (it.type === 'meeting') {
    const extra = isPast(it)
      ? (it.decisions?.length ? plural(it.decisions.length, 'decision') : '')
      : [timeRange(it), it.questions ? plural(it.questions, 'question') : ''].filter(Boolean).join(' · ');
    return [date, extra].filter(Boolean).join(' · ');
  }
  if (it.type === 'window') return `${rangeText(it.start, it.end)} · ${answeredCount(it)} of ${TEAM.length} answered`;
  if (it.type === 'task') return [date && `${isPast(it) ? '' : 'Due '}${date}`, it.who].filter(Boolean).join(' · ');
  if (it.type === 'checkin') return [date && `Due ${date}`, `${it.updates.length} of ${TEAM.length} written`].filter(Boolean).join(' · ');
  return date;
}

/** Marker (dot) classes: shape by kind, filled when past, accent when upcoming. */
export const markerClass = (it) => `mk mk-${it.type} ${isPast(it) ? 'is-past' : 'is-upcoming'}`;

export function sortedItems() {
  return [...state.items].sort((a, b) => itemDate(a).localeCompare(itemDate(b)) || (a.time ?? '').localeCompare(b.time ?? ''));
}

// ---------- page chrome ----------

let renderFn = null;
let rootEl = null;

/** Builds the page around the layout and calls render(root, items) now and after every change. */
export function startMockup({ render, wide = false }) {
  renderFn = render;
  document.body.innerHTML = `
    <a class="skip-link" href="#timeline">Skip to the timeline</a>
    <header class="site-header">
      <div class="wrap header-inner">
        <a class="course-name" href="index.html">Widgetry TAs</a>
        <div class="header-right">
          <nav class="site-nav" aria-label="Main">
            <a href="#" data-fake="Meetings">Meetings</a>
            <a href="#" aria-current="page">Timeline</a>
            <a href="#" data-fake="Team">Team</a>
          </nav>
        </div>
      </div>
    </header>
    <main class="mock-main" id="main">
      <div class="wrap">
        <div class="mock-bar">
          <span class="mock-pill" title="Made-up data. Nothing is saved.">Mockup</span>
          <span class="muted small">Made-up data · nothing is saved</span>
        </div>
        <div class="tl-head">
          <h1 tabindex="-1">Timeline</h1>
          <button type="button" class="button button-small" data-add>+ Add</button>
        </div>
        <p class="tl-legend" aria-label="Legend">
          <span>${chip({ type: 'meeting', date: '2099-01-01' })}Meeting</span>
          <span>${chip({ type: 'window', start: '2099-01-01', end: '2099-01-01' })}Planned meeting</span>
          <span>${chip({ type: 'checkin', date: '2099-01-01' })}Written check-in</span>
          <span>${chip({ type: 'task', date: '2099-01-01' })}Task</span>
          <span>${chip({ type: 'meeting', date: '2000-01-01' })}Past</span>
        </p>
      </div>
      <div id="timeline" class="${wide ? 'tl-wide' : 'wrap'}" tabindex="-1"></div>
    </main>
    <div class="mock-toast" role="status" aria-live="polite"></div>`;
  rootEl = document.getElementById('timeline');
  document.querySelector('[data-add]').addEventListener('click', addSheet);
  document.querySelectorAll('[data-fake]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    toast(`The ${a.dataset.fake} page isn’t part of this mockup.`);
  }));
  rootEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-id]');
    if (!btn) return;
    const item = state.items.find((it) => it.id === btn.dataset.id);
    if (item) openItem(item);
  });
  rerender({ first: true });
}

export function rerender(opts = {}) {
  renderFn(rootEl, sortedItems(), opts);
}

let toastTimer;
export function toast(text) {
  const el = document.querySelector('.mock-toast');
  el.textContent = text;
  el.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-shown'), 3200);
}

// ---------- sheets (same look and behaviour as the survey sheets) ----------

export function openSheet({ label, title, body, wide = false }) {
  const dlg = document.createElement('dialog');
  dlg.className = `sheet${wide ? ' sheet-wide' : ''}`;
  dlg.innerHTML = `
    <header class="sheet-header">
      <div class="sheet-heading">
        ${label ? `<p class="question-label">${esc(label)}</p>` : ''}
        <h2 class="sheet-title" tabindex="-1">${esc(title)}</h2>
      </div>
      <button type="button" class="sheet-close" aria-label="Close"></button>
    </header>
    <div class="sheet-body"></div>`;
  const bodyEl = dlg.querySelector('.sheet-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.append(body);
  document.body.append(dlg);
  dlg.querySelector('.sheet-close').addEventListener('click', () => dlg.close());
  let pressed = null; // close on a backdrop click only if the press started there
  dlg.addEventListener('pointerdown', (e) => { pressed = e.target; });
  dlg.addEventListener('click', (e) => { if (e.target === dlg && pressed === dlg) dlg.close(); });
  dlg.addEventListener('close', () => { setTimeout(() => dlg.remove(), 450); rerender(); });
  dlg.showModal();
  dlg.querySelector('.sheet-title').focus();
  return dlg;
}

export function openItem(item) {
  if (item.type === 'meeting') meetingSheet(item);
  else if (item.type === 'window') availabilitySheet(item);
  else if (item.type === 'task') taskSheet(item);
  else if (item.type === 'checkin') checkinSheet(item);
}

function meetingSheet(m) {
  const past = isPast(m);
  const facts = [fmtDay(m.date), timeRange(m), m.place].filter(Boolean).join(' · ');
  const body = `
    <p class="facts">${esc(facts)}</p>
    ${past ? `
      ${m.summary ? `<p class="sheet-text">${esc(m.summary)}</p>` : ''}
      ${m.decisions?.length ? `
        <h3 class="sheet-h">Decided</h3>
        <ul class="mk-decisions">${m.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}`
    : `<p class="sheet-text">${m.questions
      ? `${plural(m.questions, 'question')} to think about before the meeting · you’ve answered ${m.answered}.`
      : 'Nothing to prepare yet.'}</p>`}
    <p class="sheet-actions"><button type="button" class="button" data-go>Open meeting</button></p>`;
  const dlg = openSheet({ label: past ? 'Past meeting' : 'Upcoming meeting', title: m.title, body });
  dlg.querySelector('[data-go]').addEventListener('click', () => {
    dlg.close();
    toast(`In the app this opens the meeting’s ${past ? 'Post-meeting' : 'Pre-meeting'} tab.`);
  });
}

function taskSheet(t) {
  const from = state.items.find((it) => it.id === t.from);
  const body = `
    <p class="facts">${esc(itemSubtitle(t))}</p>
    ${t.details ? `<p class="sheet-text">${esc(t.details)}</p>` : ''}
    ${from ? `<p class="muted small">Agreed in <button type="button" class="link-button" data-from>${esc(from.title)} (${esc(fmtDay(from.date))})</button></p>` : ''}`;
  const dlg = openSheet({ label: 'Task', title: t.title, body });
  dlg.querySelector('[data-from]')?.addEventListener('click', () => { dlg.close(); setTimeout(() => meetingSheet(from), 200); });
}

function checkinSheet(c) {
  const wrap = document.createElement('div');
  const draw = () => {
    const mine = c.updates.find((u) => u.who === ME);
    const others = c.updates.filter((u) => u.who !== ME);
    const missing = TEAM.filter((n) => !c.updates.some((u) => u.who === n));
    wrap.innerHTML = `
      <p class="sheet-prompt">${esc(c.prompt)}</p>
      <p class="facts">Due ${esc(fmtDay(c.date))} · ${c.updates.length} of ${TEAM.length} written</p>
      <form class="ci-form" novalidate>
        <div class="field">
          <label for="ci-text">Your update</label>
          <textarea id="ci-text" rows="3" maxlength="2000" placeholder="A few sentences are enough.">${esc(mine?.text ?? '')}</textarea>
        </div>
        <div class="survey-actions">
          <button type="submit" class="button button-primary">${mine ? 'Save changes' : 'Post update'}</button>
          <span class="survey-status" role="status"></span>
        </div>
      </form>
      <h3 class="sheet-h">Updates</h3>
      <ul class="text-answers">${[mine, ...others].filter(Boolean).map((u) => `
        <li><p class="text-answer">${esc(u.text)}</p><p class="muted">${esc(u.who === ME ? 'You' : u.who)} · ${esc(u.when)}</p></li>`).join('')}
      </ul>
      ${missing.length ? `<p class="muted small">Not written yet: ${esc(missing.join(', '))}</p>` : ''}`;
    wrap.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = wrap.querySelector('textarea').value.trim();
      const status = wrap.querySelector('.survey-status');
      if (!text) { status.textContent = 'Write something first.'; return; }
      status.textContent = 'Saving…';
      setTimeout(() => {
        if (mine) mine.text = text; else c.updates.push({ who: ME, when: 'just now', text });
        draw();
        wrap.querySelector('.survey-status').textContent = 'Saved';
      }, 400);
    });
  };
  draw();
  openSheet({ label: 'Written check-in', title: c.title, body: wrap });
}

// ---------- the availability sheet ("when to meet") ----------

function availabilitySheet(win) {
  const days = daysBetween(win.start, win.end) + 1;
  const slots = ((win.to - win.from) * 60) / win.slot;
  const need = win.duration / win.slot; // slots in one meeting
  const people = win.availability;
  const mine = people[ME];
  const slotTime = (s) => hhmm(win.from * 60 + s * win.slot);
  const dayOf = (d) => addDays(win.start, d);

  const wrap = document.createElement('div');
  wrap.className = 'av';
  wrap.innerHTML = `
    <p class="sheet-text">Mark when you could meet for an hour between ${esc(rangeText(win.start, win.end))}. It saves by itself.</p>
    <nav class="tabs av-switch" aria-label="Show">
      <a href="#" data-pane="mine" aria-current="page">Your times</a>
      <a href="#" data-pane="all">Everyone</a>
    </nav>
    <div class="av-panes" data-show="mine">
      <section class="av-pane av-pane-mine">
        <h3 class="sheet-h">Your times</h3>
        <p class="muted small av-hint">Drag over the times you’re free. Drag over them again to remove them.</p>
        <div class="av-grid av-grid-mine"></div>
        <p class="survey-status av-status" role="status"></p>
      </section>
      <section class="av-pane av-pane-all">
        <h3 class="sheet-h">Everyone</h3>
        <p class="muted small av-count"></p>
        <div class="av-grid av-grid-all"></div>
        <p class="av-legend"><span>0</span><span class="av-legend-bar"></span><span>${TEAM.length} free</span></p>
        <p class="av-info" aria-live="polite">Point at a time (or tap it) to see who’s free.</p>
      </section>
    </div>
    <section class="av-best">
      <h3 class="sheet-h">Best times for ${win.duration} minutes</h3>
      <ul class="list av-best-list"></ul>
      <p class="muted small">Only organizers see “Pick”. Picking turns the shaded span into the meeting.</p>
    </section>`;

  const grids = { mine: wrap.querySelector('.av-grid-mine'), all: wrap.querySelector('.av-grid-all') };
  for (const [kind, grid] of Object.entries(grids)) {
    grid.style.gridTemplateColumns = `2.6rem repeat(${days}, minmax(0, 1fr))`;
    const corner = document.createElement('span');
    corner.style.gridRow = '1'; corner.style.gridColumn = '1';
    grid.append(corner);
    for (let d = 0; d < days; d += 1) {
      const h = document.createElement('span');
      h.className = 'av-day';
      h.innerHTML = `<b>${esc(fmt(dayOf(d), { weekday: 'short' }))}</b> ${esc(fmt(dayOf(d), { day: 'numeric' }))}`;
      h.style.gridRow = '1'; h.style.gridColumn = String(d + 2);
      grid.append(h);
    }
    for (let s = 0; s < slots; s += 1) {
      if (s % 2 === 0) {
        const t = document.createElement('span');
        t.className = 'av-time';
        t.textContent = slotTime(s);
        t.style.gridRow = `${s + 2} / span 2`; t.style.gridColumn = '1';
        grid.append(t);
      }
      for (let d = 0; d < days; d += 1) {
        const c = document.createElement('span');
        c.className = `av-cell${s % 2 ? ' is-half' : ''}`;
        c.dataset.d = d; c.dataset.s = s; c.dataset.kind = kind;
        c.style.gridRow = String(s + 2); c.style.gridColumn = String(d + 2);
        grid.append(c);
      }
    }
  }

  const key = (d, s) => `${d}:${s}`;
  const freeAt = (k) => Object.keys(people).filter((n) => people[n].has(k));

  // Your grid: drag a rectangle; it adds if you started on an empty slot, removes otherwise.
  let drag = null;
  const inRect = (d, s) => drag
    && d >= Math.min(drag.a[0], drag.b[0]) && d <= Math.max(drag.a[0], drag.b[0])
    && s >= Math.min(drag.a[1], drag.b[1]) && s <= Math.max(drag.a[1], drag.b[1]);
  const drawMine = () => {
    grids.mine.querySelectorAll('.av-cell').forEach((c) => {
      const d = +c.dataset.d; const s = +c.dataset.s;
      const on = inRect(d, s) ? drag.add : mine.has(key(d, s));
      c.classList.toggle('is-on', on);
    });
  };
  const cellAt = (x, y) => document.elementFromPoint(x, y)?.closest('.av-cell[data-kind="mine"]');
  grids.mine.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.av-cell');
    if (!c || e.button > 0) return;
    e.preventDefault();
    grids.mine.setPointerCapture(e.pointerId);
    const a = [+c.dataset.d, +c.dataset.s];
    drag = { add: !mine.has(key(...a)), a, b: a };
    drawMine();
  });
  grids.mine.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = cellAt(e.clientX, e.clientY);
    if (c) { drag.b = [+c.dataset.d, +c.dataset.s]; drawMine(); }
  });
  const finish = () => {
    if (!drag) return;
    for (let d = 0; d < days; d += 1) {
      for (let s = 0; s < slots; s += 1) {
        if (inRect(d, s)) { if (drag.add) mine.add(key(d, s)); else mine.delete(key(d, s)); }
      }
    }
    drag = null;
    drawMine(); drawAll(); drawBest();
    const status = wrap.querySelector('.av-status');
    status.textContent = 'Saving…';
    setTimeout(() => { status.textContent = mine.size ? 'Saved' : 'Saved (no times marked)'; }, 450);
  };
  grids.mine.addEventListener('pointerup', finish);
  grids.mine.addEventListener('pointercancel', finish);

  // Everyone: a heat map; darker = more people free.
  let selected = null;
  const drawAll = () => {
    const answered = answeredCount(win);
    wrap.querySelector('.av-count').textContent = `${answered} of ${TEAM.length} have marked their times.`;
    grids.all.querySelectorAll('.av-cell').forEach((c) => {
      const n = freeAt(key(c.dataset.d, c.dataset.s)).length;
      c.style.setProperty('--p', `${Math.round((n / TEAM.length) * 100)}%`);
      c.classList.toggle('is-selected', selected === c);
    });
  };
  const info = (c) => {
    const k = key(c.dataset.d, c.dataset.s);
    const free = freeAt(k);
    const answered = Object.keys(people).filter((n) => people[n].size);
    const notFree = answered.filter((n) => !free.includes(n));
    const silent = TEAM.filter((n) => !answered.includes(n));
    const s = +c.dataset.s;
    wrap.querySelector('.av-info').innerHTML = `
      <b>${esc(fmtDay(dayOf(+c.dataset.d)))}, ${slotTime(s)}–${slotTime(s + 1)}: ${free.length} of ${TEAM.length} free</b><br>
      ${free.length ? `Free: ${esc(free.join(', '))}<br>` : ''}
      ${notFree.length ? `Not free: ${esc(notFree.join(', '))}<br>` : ''}
      ${silent.length ? `<span class="muted">No answer yet: ${esc(silent.join(', '))}</span>` : ''}`;
  };
  grids.all.addEventListener('pointerover', (e) => { const c = e.target.closest('.av-cell'); if (c && e.pointerType === 'mouse') info(c); });
  grids.all.addEventListener('click', (e) => {
    const c = e.target.closest('.av-cell');
    if (!c) return;
    selected = c; info(c); drawAll();
  });

  // Best times: every start where the whole meeting fits, by how many are free throughout.
  const drawBest = () => {
    const options = [];
    for (let d = 0; d < days; d += 1) {
      for (let s = 0; s + need <= slots; s += 1) {
        const free = TEAM.filter((n) => [...Array(need).keys()].every((i) => people[n].has(key(d, s + i))));
        options.push({ d, s, free });
      }
    }
    options.sort((a, b) => b.free.length - a.free.length || a.d - b.d || a.s - b.s);
    const best = [];
    for (const o of options) {
      if (best.length === 3) break;
      if (best.some((b) => b.d === o.d && Math.abs(b.s - o.s) < need + 2)) continue;
      best.push(o);
    }
    const answered = Object.keys(people).filter((n) => people[n].size);
    wrap.querySelector('.av-best-list').innerHTML = best.map((o, i) => {
      const missing = answered.filter((n) => !o.free.includes(n));
      return `
        <li class="av-best-row">
          <span class="row-text">
            <span class="row-title">${esc(fmtDay(dayOf(o.d)))}, ${slotTime(o.s)}–${slotTime(o.s + need)}</span>
            <span class="row-subtitle">${o.free.length} of ${TEAM.length} free${missing.length ? ` · can’t: ${esc(missing.join(', '))}` : ''}</span>
          </span>
          <button type="button" class="button button-small" data-pick="${i}">Pick</button>
        </li>`;
    }).join('');
    wrap.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
      const o = best[+b.dataset.pick];
      const date = dayOf(o.d);
      const time = slotTime(o.s);
      const idx = state.items.indexOf(win);
      state.items[idx] = { id: win.id, type: 'meeting', date, time, duration: win.duration, title: win.title, place: '', questions: 0, answered: 0 };
      dlg.close();
      toast(`${win.title} is set for ${fmtDay(date)}, ${time}. The shaded span became a meeting.`);
    }));
  };

  // Phones and narrow sheets: a switch between the two grids. Wide sheets show both.
  wrap.querySelectorAll('[data-pane]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    wrap.querySelectorAll('[data-pane]').forEach((x) => {
      if (x === a) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
    });
    wrap.querySelector('.av-panes').dataset.show = a.dataset.pane;
  }));

  drawMine(); drawAll(); drawBest();
  const dlg = openSheet({ label: 'Planned meeting · find a time', title: win.title, body: wrap, wide: true });
}

// ---------- adding something (organizers) ----------

function addSheet() {
  const wrap = document.createElement('form');
  wrap.className = 'add-form';
  wrap.noValidate = true;
  wrap.innerHTML = `
    <fieldset class="field">
      <legend>What</legend>
      <div class="options">
        <label class="option"><input type="radio" name="type" value="window" checked> <span>Find a time for a meeting</span></label>
        <label class="option"><input type="radio" name="type" value="meeting"> <span>Meeting with a fixed time</span></label>
        <label class="option"><input type="radio" name="type" value="task"> <span>Task</span></label>
        <label class="option"><input type="radio" name="type" value="checkin"> <span>Check-in</span></label>
      </div>
    </fieldset>
    <div class="field"><label for="add-title">Title</label><input id="add-title" name="title" class="text-input" autocomplete="off" placeholder="e.g. Exam review"></div>
    <div class="add-row" data-for="window">
      <div class="field"><label for="add-from">From</label><input id="add-from" name="from" type="date" class="text-input" value="2026-11-30"></div>
      <div class="field"><label for="add-to">To</label><input id="add-to" name="to" type="date" class="text-input" value="2026-12-04"></div>
    </div>
    <div class="add-row" data-for="meeting task checkin">
      <div class="field"><label for="add-date">Date</label><input id="add-date" name="date" type="date" class="text-input" value="2026-12-02"></div>
      <div class="field" data-for="meeting"><label for="add-time">Time</label><input id="add-time" name="time" type="time" class="text-input" value="14:00"></div>
    </div>
    <div class="field" data-for="task"><label for="add-who">Who <span class="muted">(optional)</span></label><input id="add-who" name="who" class="text-input" autocomplete="off" placeholder="A name, or Everyone"></div>
    <div class="field" data-for="checkin"><label for="add-prompt">Question for everyone</label><input id="add-prompt" name="prompt" class="text-input" value="How are your groups doing?"></div>
    <div class="survey-actions"><button type="submit" class="button button-primary">Add to timeline</button><span class="survey-status" role="status"></span></div>`;
  const sync = () => {
    const type = wrap.elements.type.value;
    wrap.querySelectorAll('[data-for]').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(type); });
  };
  wrap.addEventListener('change', sync);
  sync();
  wrap.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = wrap.elements;
    const type = f.type.value;
    const title = f.title.value.trim();
    if (!title) { wrap.querySelector('.survey-status').textContent = 'Give it a title.'; f.title.focus(); return; }
    const id = `new-${Date.now()}`;
    let item;
    if (type === 'window') {
      if (!f.from.value || !f.to.value || f.to.value < f.from.value) { wrap.querySelector('.survey-status').textContent = 'Check the dates.'; return; }
      item = { id, type, title, start: f.from.value, end: f.to.value, from: 9, to: 18, slot: 30, duration: 60 };
      const days = daysBetween(item.start, item.end) + 1;
      item.availability = Object.fromEntries(TEAM.map((n) => [n, new Set()]));
      if (days > 14) { wrap.querySelector('.survey-status').textContent = 'Two weeks at most.'; return; }
    } else if (type === 'meeting') item = { id, type, title, date: f.date.value, time: f.time.value, duration: 60, place: '', questions: 0, answered: 0 };
    else if (type === 'task') item = { id, type, title, date: f.date.value, who: f.who.value.trim(), details: '' };
    else item = { id, type, title, date: f.date.value, prompt: f.prompt.value.trim() || 'How is it going?', updates: [] };
    state.items.push(item);
    dlg.close();
    toast(`Added “${title}” to the timeline.`);
  });
  const dlg = openSheet({ label: 'Organizers', title: 'Add to the timeline', body: wrap });
}
