// The availability sheet of a meeting that is still finding a time
// ("when to meet"): your own times, everyone's times as a heat map with
// names, the best times, the agent's suggestion and, for organizers, "Pick".
// The database (part 5: get_schedule, save_availability, pick_time,
// cancel_schedule) checks everything; this file only shows and sends.
//
// - "Your times": press and drag a rectangle. It adds if you started on a free
//   slot and removes if you started on a marked one. Keyboard: arrow keys
//   move, Space or Enter marks. Saves by itself.
// - "Everyone": darker = more people free. Pointing at, tapping or focusing
//   a slot shows who is free.
// - From 860 px both grids sit side by side; narrower, a switch.

import { html } from './dom.js';
import { outlookInviteUrl } from './calendar.js';

const TIME_ZONE = 'Europe/Zurich';
const SAVE_DELAY_MS = 400;

const zurich = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
/** { date: "2026-11-24", time: "14:00" } in Zurich for a time in ms. */
export function zurichParts(ms) {
  const p = Object.fromEntries(zurich.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const dayText = (date, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
/** "Tue 24 Nov, 14:00–15:00" */
export function spanText(startMs, endMs) {
  const a = zurichParts(startMs);
  return `${dayText(a.date)}, ${a.time}–${zurichParts(endMs).time}`;
}
const lengthText = (min) => (min % 60 === 0 ? `${min / 60} hour${min === 60 ? '' : 's'}` : min > 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} minutes`);

/**
 * The grid as rows and columns: days across, times of day down.
 * Returns { days, times, at(d, t) → ms | undefined, where(ms) → [d, t] }.
 */
export function layoutGrid(gridIso) {
  const slots = gridIso.map((t) => Date.parse(t)).sort((a, b) => a - b);
  const days = [];
  const times = [];
  const byKey = new Map();
  const where = new Map();
  for (const ms of slots) {
    const { date, time } = zurichParts(ms);
    if (!days.includes(date)) days.push(date);
    if (!times.includes(time)) times.push(time);
    byKey.set(`${date} ${time}`, ms);
  }
  times.sort();
  for (const [key, ms] of byKey) {
    const [date, time] = key.split(' ');
    where.set(ms, [days.indexOf(date), times.indexOf(time)]);
  }
  return {
    days, times, slots,
    at: (d, t) => byKey.get(`${days[d]} ${times[t]}`),
    where: (ms) => where.get(ms),
  };
}

/** Load and draw the sheet into `box` (the sheet's [data-av] element). */
export async function openSchedule(box, meeting, { site, client, signal, onChange = () => {} }) {
  if (!box || !meeting) return;
  if (!client) {
    box.innerHTML = String(html`<p class="muted">Sign in to add your times.</p>`);
    return;
  }
  box.innerHTML = String(html`<p class="muted">Loading…</p>`);
  const course = site.course.id;
  const call = async (name, args) => {
    let answer;
    try {
      answer = await client.rpc(name, args);
    } catch (err) {
      throw new Error('The backend didn’t answer. Try again.', { cause: err });
    }
    if (answer.error) throw new Error(answer.error.message || 'That didn’t work.');
    return answer.data;
  };
  let data;
  try {
    data = await call('get_schedule', { p_course: course, p_meeting: meeting.id });
  } catch (err) {
    box.innerHTML = String(html`<p class="notice notice-warn">Couldn’t load the times: ${err.message}</p>`);
    return;
  }
  if (signal?.aborted) return;
  // Listeners for this opening only: they go when the sheet closes (or the
  // page changes). A change that is still waiting to be saved is sent then,
  // and box.pending lets the timeline wait for it before it redraws.
  const local = new AbortController();
  signal?.addEventListener('abort', () => local.abort(), { once: true });
  const dialog = box.closest('dialog');
  const flush = draw(box, meeting, data, { site, call, signal: local.signal, onChange });
  dialog?.addEventListener('close', () => {
    box.pending = flush();
    local.abort();
  }, { once: true, signal: local.signal });
}

function draw(box, meeting, first, { site, call, signal, onChange }) {
  let data = first;
  const organizer = site.me?.organizer === true;
  const meLogin = site.me?.login;
  const nameOf = (login) => (login === meLogin ? 'You'
    : site.members?.find((m) => m.login === login)?.name || login);
  const names = (logins) => logins.map(nameOf).join(', ');
  const grid = layoutGrid(data.grid);
  const slotMs = data.slot_min * 60_000;
  const durationMs = data.duration_min * 60_000;
  const mine = new Set((data.mine ?? []).map((t) => Date.parse(t)));
  const now = () => Date.now();

  box.innerHTML = String(html`
    <p class="sheet-text">Mark when you could meet for ${lengthText(data.duration_min)} on these days. It saves by itself.</p>
    <div class="av-suggestion" hidden></div>
    <nav class="tabs av-switch" aria-label="Show">
      <a href="#" data-pane="mine" aria-current="page">Your times</a>
      <a href="#" data-pane="all">Everyone</a>
    </nav>
    <div class="av-panes" data-show="mine">
      <section class="av-pane av-pane-mine" aria-labelledby="av-mine-h">
        <h3 class="tl-sheet-h" id="av-mine-h">Your times</h3>
        <p class="muted small av-hint">Drag over the times you’re free; drag over them again to remove them. Keyboard: arrow keys move, Space marks.</p>
        <div class="av-grid av-grid-mine" role="group" aria-labelledby="av-mine-h"></div>
        <p class="survey-status av-status" role="status"></p>
      </section>
      <section class="av-pane av-pane-all" aria-labelledby="av-all-h">
        <h3 class="tl-sheet-h" id="av-all-h">Everyone</h3>
        <p class="muted small av-count"></p>
        <div class="av-grid av-grid-all" role="group" aria-labelledby="av-all-h"></div>
        <p class="av-legend" aria-hidden="true"><span>0</span><span class="av-legend-bar"></span><span>${data.members} free</span></p>
        <p class="av-info" aria-live="polite">Point at a time (or tap it) to see who’s free.</p>
      </section>
    </div>
    <section class="av-best">
      <h3 class="tl-sheet-h">Best times for ${lengthText(data.duration_min)}</h3>
      <ul class="list av-best-list"></ul>
    </section>
    <div class="av-confirm notice" hidden></div>
    ${organizer ? html`<p class="av-organizer"><button type="button" class="link-button link-danger" data-cancel-schedule>Stop finding a time</button></p>` : ''}`);

  const grids = { mine: box.querySelector('.av-grid-mine'), all: box.querySelector('.av-grid-all') };
  const cells = { mine: [], all: [] }; // [d][t] → button

  // ----- building both grids (positions via element.style: the page's
  // security policy forbids style attributes)
  for (const [kind, el] of Object.entries(grids)) {
    el.style.gridTemplateColumns = `2.6rem repeat(${grid.days.length}, minmax(0, 1fr))`;
    // Narrow columns get short headers ("W" over "25"): see styles.css.
    el.classList.toggle('is-some', grid.days.length > 5);
    el.classList.toggle('is-many', grid.days.length > 7);
    const corner = document.createElement('span');
    corner.style.gridRow = '1';
    corner.style.gridColumn = '1';
    el.append(corner);
    grid.days.forEach((date, d) => {
      const head = document.createElement('span');
      head.className = 'av-day';
      head.setAttribute('aria-hidden', 'true');
      const part = (tag, cls, text) => {
        const x = document.createElement(tag);
        x.className = cls;
        x.textContent = text;
        return x;
      };
      const weekday = dayText(date, { weekday: 'short' });
      head.append(
        part('b', 'av-long', weekday), part('b', 'av-short', weekday.slice(0, 1)),
        part('span', 'av-long', dayText(date, { day: 'numeric', month: 'short' })),
        part('span', 'av-short', dayText(date, { day: 'numeric' })),
      );
      head.style.gridRow = '1';
      head.style.gridColumn = String(d + 2);
      el.append(head);
    });
    grid.times.forEach((time, t) => {
      if (time.endsWith(':00') || t === 0) {
        const label = document.createElement('span');
        label.className = 'av-time';
        label.setAttribute('aria-hidden', 'true');
        label.textContent = time;
        label.style.gridRow = `${t + 2}`;
        label.style.gridColumn = '1';
        el.append(label);
      }
    });
    cells[kind] = grid.days.map((date, d) => grid.times.map((time, t) => {
      const ms = grid.at(d, t);
      if (ms === undefined) return null;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `av-cell${time.endsWith(':00') ? '' : ' is-half'}${ms < now() ? ' is-past' : ''}`;
      cell.dataset.d = String(d);
      cell.dataset.t = String(t);
      cell.tabIndex = -1;
      cell.style.gridRow = String(t + 2);
      cell.style.gridColumn = String(d + 2);
      if (ms < now()) cell.setAttribute('aria-disabled', 'true');
      el.append(cell);
      return cell;
    }));
    const firstCell = cells[kind].flat().find(Boolean);
    if (firstCell) firstCell.tabIndex = 0;
  }
  const cellMs = (cell) => grid.at(Number(cell.dataset.d), Number(cell.dataset.t));
  const slotLabel = (ms) => spanText(ms, ms + slotMs);

  // ----- your times
  let drag = null;
  const inRect = (d, t) => drag
    && d >= Math.min(drag.a[0], drag.b[0]) && d <= Math.max(drag.a[0], drag.b[0])
    && t >= Math.min(drag.a[1], drag.b[1]) && t <= Math.max(drag.a[1], drag.b[1]);
  function drawMine() {
    for (const cell of cells.mine.flat()) {
      if (!cell) continue;
      const ms = cellMs(cell);
      const d = Number(cell.dataset.d);
      const t = Number(cell.dataset.t);
      const on = inRect(d, t) && ms >= now() ? drag.add : mine.has(ms);
      cell.classList.toggle('is-on', on);
      cell.setAttribute('aria-pressed', String(on));
      cell.setAttribute('aria-label', `${slotLabel(ms)}${ms < now() ? ' (past)' : ''}`);
    }
  }

  const status = box.querySelector('.av-status');
  let saveTimer = null;
  let saving = Promise.resolve();
  let pending = false;
  function scheduleSave() {
    onChange();
    pending = true;
    status.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saving = saving.then(save);
    }, SAVE_DELAY_MS);
  }
  async function save() {
    pending = false;
    const slots = [...mine].sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
    try {
      await call('save_availability', { p_course: site.course.id, p_meeting: meeting.id, p_slots: slots });
      if (signal?.aborted) return;
      if (!pending) status.textContent = mine.size ? 'Saved' : 'Saved (no times marked)';
      await refresh();
    } catch (err) {
      status.textContent = `Not saved: ${err.message}`;
    }
  }
  function toggleRect() {
    for (let d = 0; d < grid.days.length; d += 1) {
      for (let t = 0; t < grid.times.length; t += 1) {
        const ms = grid.at(d, t);
        if (ms === undefined || ms < now() || !inRect(d, t)) continue;
        if (drag.add) mine.add(ms); else mine.delete(ms);
      }
    }
  }

  grids.mine.addEventListener('pointerdown', (event) => {
    const cell = event.target.closest('.av-cell');
    if (!cell || event.button > 0 || !data.open) return;
    event.preventDefault();
    grids.mine.setPointerCapture(event.pointerId);
    const a = [Number(cell.dataset.d), Number(cell.dataset.t)];
    drag = { add: !mine.has(cellMs(cell)), a, b: a };
    moveFocus('mine', cell);
    drawMine();
  }, { signal });
  grids.mine.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('.av-grid-mine .av-cell');
    if (cell) {
      drag.b = [Number(cell.dataset.d), Number(cell.dataset.t)];
      drawMine();
    }
  }, { signal });
  const finish = () => {
    if (!drag) return;
    toggleRect();
    drag = null;
    drawMine();
    drawAll();
    scheduleSave();
  };
  grids.mine.addEventListener('pointerup', finish, { signal });
  grids.mine.addEventListener('pointercancel', finish, { signal });

  // ----- keyboard: one tab stop per grid, arrow keys move inside it
  function moveFocus(kind, cell) {
    for (const c of cells[kind].flat()) if (c) c.tabIndex = -1;
    cell.tabIndex = 0;
    if (document.activeElement !== cell) cell.focus({ preventScroll: false });
  }
  function onKey(kind, event) {
    const cell = event.target.closest('.av-cell');
    if (!cell) return;
    let d = Number(cell.dataset.d);
    let t = Number(cell.dataset.t);
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[event.key]) {
      event.preventDefault();
      d = Math.max(0, Math.min(grid.days.length - 1, d + moves[event.key][0]));
      t = Math.max(0, Math.min(grid.times.length - 1, t + moves[event.key][1]));
      const next = cells[kind][d][t];
      if (next) {
        moveFocus(kind, next);
        if (kind === 'all') showInfo(next);
      }
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault(); // no click follows, so the slot isn't toggled twice
      if (kind === 'all') return showInfo(cell);
      toggleOne(cell);
    }
  }
  function toggleOne(cell) {
    const ms = cellMs(cell);
    if (ms < now() || !data.open) return;
    if (mine.has(ms)) mine.delete(ms); else mine.add(ms);
    drawMine();
    drawAll();
    scheduleSave();
  }
  grids.mine.addEventListener('keydown', (event) => onKey('mine', event), { signal });
  grids.all.addEventListener('keydown', (event) => onKey('all', event), { signal });
  // A click without a pointer press (detail 0: screen readers, voice control,
  // switch access) marks the slot like Space does. Mouse and touch presses
  // were already handled by the drag; Space and Enter by keydown.
  grids.mine.addEventListener('click', (event) => {
    event.preventDefault();
    const cell = event.target.closest('.av-cell');
    if (!cell || event.detail !== 0) return;
    toggleOne(cell);
  }, { signal });

  // ----- everyone (your own unsaved changes included)
  const people = () => {
    const list = data.people.filter((p) => p.login !== meLogin).map((p) => ({ login: p.login, slots: new Set(p.slots.map((s) => Date.parse(s))) }));
    if (data.mine || mine.size) list.push({ login: meLogin, slots: mine });
    return list;
  };
  function drawAll() {
    const everyone = people();
    const total = Math.max(data.members, 1);
    box.querySelector('.av-count').textContent = `${everyone.length} of ${data.members} have marked their times.`;
    for (const cell of cells.all.flat()) {
      if (!cell) continue;
      const ms = cellMs(cell);
      const n = everyone.filter((p) => p.slots.has(ms)).length;
      cell.style.setProperty('--p', `${Math.round((n / total) * 100)}%`);
      cell.setAttribute('aria-label', `${slotLabel(ms)}: ${n} of ${data.members} free`);
    }
  }
  const info = box.querySelector('.av-info');
  let selected = null;
  function showInfo(cell) {
    selected?.classList.remove('is-selected');
    selected = cell;
    cell.classList.add('is-selected');
    const ms = cellMs(cell);
    const everyone = people();
    const free = everyone.filter((p) => p.slots.has(ms)).map((p) => p.login);
    const notFree = everyone.filter((p) => !p.slots.has(ms)).map((p) => p.login);
    const silent = data.not_filled_in.filter((l) => l !== meLogin || !(data.mine || mine.size));
    info.innerHTML = String(html`
      <b>${slotLabel(ms)}: ${free.length} of ${data.members} free</b><br>
      ${free.length ? html`Free: ${names(free)}<br>` : ''}
      ${notFree.length ? html`Not free: ${names(notFree)}<br>` : ''}
      ${silent.length ? html`<span class="muted">No answer yet: ${names(silent)}</span>` : ''}`);
  }
  grids.all.addEventListener('pointerover', (event) => {
    const cell = event.target.closest('.av-cell');
    if (cell && event.pointerType === 'mouse') showInfo(cell);
  }, { signal });
  grids.all.addEventListener('click', (event) => {
    const cell = event.target.closest('.av-cell');
    if (cell) {
      moveFocus('all', cell);
      showInfo(cell);
    }
  }, { signal });

  // ----- best times, the agent's suggestion, picking
  const confirmBox = box.querySelector('.av-confirm');
  function bestRow(b) {
    const start = Date.parse(b.start);
    return html`
      <li class="av-best-row">
        <span class="row-text">
          <span class="row-title">${spanText(start, Date.parse(b.end))}</span>
          <span class="row-subtitle">${b.free} of ${data.members} free${b.missing.length ? ` · can’t: ${names(b.missing)}` : ''}</span>
        </span>
        ${organizer && data.open ? html`<button type="button" class="button button-small" data-pick="${b.start}">Pick</button>` : ''}
      </li>`;
  }
  function drawBest() {
    const list = box.querySelector('.av-best-list');
    list.innerHTML = String(data.best.length ? html`${data.best.map(bestRow)}`
      : html`<li class="av-best-row muted">No time works for anyone yet.</li>`);
    const s = data.suggestion;
    const sBox = box.querySelector('.av-suggestion');
    sBox.hidden = !s;
    if (s) {
      const start = Date.parse(s.starts_at);
      sBox.innerHTML = String(html`
        <p class="consensus-label">Suggested by ${s.by ?? 'the agent'}</p>
        <p class="av-suggestion-time"><b>${spanText(start, start + durationMs)}</b> · ${s.free_at?.free ?? 0} of ${data.members} free${s.free_at?.missing?.length ? ` · can’t: ${names(s.free_at.missing)}` : ''}</p>
        ${s.note ? html`<p class="muted small">${s.note}</p>` : ''}
        ${organizer && data.open ? html`<button type="button" class="button button-small" data-pick="${s.starts_at}">Pick</button>` : ''}`);
    }
  }

  async function refresh() {
    try {
      const next = await call('get_schedule', { p_course: site.course.id, p_meeting: meeting.id });
      if (signal?.aborted) return;
      data = next;
      drawAll();
      drawBest();
    } catch {
      // keep what is shown
    }
  }

  // An inline "are you sure?". `opener`: the button that asked, which gets
  // focus back on "Cancel".
  function ask(text, yes, no, opener, onYes) {
    confirmBox.hidden = false;
    confirmBox.innerHTML = String(html`
      <p id="av-confirm-text">${text}</p>
      <p class="av-confirm-actions">
        <button type="button" class="button button-primary" data-yes aria-describedby="av-confirm-text">${yes}</button>
        <button type="button" class="link-button" data-no>${no}</button>
        <span class="survey-status" role="status"></span>
      </p>`);
    confirmBox.querySelector('[data-yes]').focus();
    confirmBox.querySelector('[data-no]').addEventListener('click', () => {
      confirmBox.hidden = true;
      if (opener?.isConnected) opener.focus();
    }, { signal });
    const button = confirmBox.querySelector('[data-yes]');
    button.addEventListener('click', async () => {
      button.disabled = true;
      const say = confirmBox.querySelector('.survey-status');
      say.textContent = 'Saving…';
      try {
        await onYes();
      } catch (err) {
        say.textContent = err.message;
        button.disabled = false;
      }
    }, { signal });
  }

  box.addEventListener('click', (event) => {
    const pick = event.target.closest('[data-pick]');
    if (pick) {
      const start = Date.parse(pick.dataset.pick);
      const when = spanText(start, start + durationMs);
      ask(`Set “${meeting.title}” to ${when}? Everyone sees the time, and this grid closes.`, 'Set the time', 'Cancel', pick, async () => {
        await call('pick_time', { p_course: site.course.id, p_meeting: meeting.id, p_starts_at: pick.dataset.pick });
        data = { ...data, open: false };
        onChange();
        const invite = outlookInviteUrl({ ...meeting, starts_at: new Date(start).toISOString(), duration: data.duration_min, date: undefined },
          { url: new URL(`#/m/${encodeURIComponent(meeting.id)}`, location.href).href });
        confirmBox.innerHTML = String(html`
          <p role="status" tabindex="-1" data-done><b>Time set: ${when}.</b> The meeting is on the timeline now.</p>
          ${invite ? html`<p><a class="button button-small" href="${invite}" target="_blank" rel="noopener">Send Outlook invite<span class="visually-hidden"> (opens Outlook in a new tab)</span></a></p>
          <p class="muted small">Opens a new Outlook event with the time filled in. Add the team and click Send.</p>` : ''}`);
        for (const b of box.querySelectorAll('[data-pick]')) b.remove();
        box.querySelector('[data-cancel-schedule]')?.remove();
        confirmBox.querySelector('[data-done]').focus();
      });
      return;
    }
    if (event.target.closest('[data-cancel-schedule]')) {
      ask('Stop finding a time? Everyone’s times in this grid are deleted. The meeting stays, without a time.', 'Stop finding a time', 'Keep it',
        event.target.closest('[data-cancel-schedule]'), async () => {
        await call('cancel_schedule', { p_course: site.course.id, p_meeting: meeting.id });
        onChange();
        box.closest('dialog')?.close();
      });
      return;
    }
    const pane = event.target.closest('[data-pane]');
    if (pane) {
      event.preventDefault();
      for (const a of box.querySelectorAll('[data-pane]')) {
        if (a === pane) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      }
      box.querySelector('.av-panes').dataset.show = pane.dataset.pane;
    }
  }, { signal });

  drawMine();
  drawAll();
  drawBest();

  // Sends a change that is still waiting (when the sheet closes).
  return () => {
    if (!pending) return saving;
    clearTimeout(saveTimer);
    saving = saving.then(save);
    return saving;
  };
}
