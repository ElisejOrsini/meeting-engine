// Date and time fields that always read European: 17/11/2026 and 14:00.
//
// The browser's own <input type="date"> and <input type="time"> follow the
// browser's language, so in an English (US) browser they show 11/17/2026 and
// 2:00 PM, and a page can't change that. So:
// - a date is a text field (DD/MM/YYYY) plus a calendar button that opens the
//   browser's picker; a hidden <input type="date"> next to it carries the
//   field's name and its value as YYYY-MM-DD, so forms read it as before;
// - a time is a list of 24-hour times.
import { html } from './dom.js';

const pad = (n) => String(n).padStart(2, '0');

/** "2026-11-17" → "17/11/2026" ('' for anything else). */
export function isoToEuropean(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/**
 * What someone typed → "YYYY-MM-DD", or '' if it isn't a real date.
 * Day first: 17/11/2026, 17.11.2026, 17-11-2026, 17/11/26, 17112026; also 2026-11-17.
 */
export function europeanToIso(text) {
  const s = String(text ?? '').trim();
  let d, m, y;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) [, y, m, d] = match;
  else if ((match = /^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2}|\d{4})$/.exec(s))) [, d, m, y] = match;
  else if ((match = /^(\d{2})(\d{2})(\d{2}|\d{4})$/.exec(s))) [, d, m, y] = match; // 17112026, 171126
  else return '';
  y = Number(y.length === 2 ? `20${y}` : y);
  m = Number(m);
  d = Number(d);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * A date field. `id` goes on the visible text field (for its <label>),
 * `name` on the hidden field that holds YYYY-MM-DD.
 */
export function dateField({ id, name, label = 'the date', value = '', min = '' }) {
  return html`<span class="date-field">
    <input id="${id}" type="text" class="text-input date-text" autocomplete="off"
      placeholder="DD/MM/YYYY" maxlength="10" value="${isoToEuropean(value)}">
    <button type="button" class="date-pick" aria-label="Pick ${label} from a calendar"></button>
    <input type="date" class="date-native" name="${name}" value="${value}" ${min ? html`min="${min}"` : ''} tabindex="-1" aria-hidden="true">
  </span>`;
}

/** A 24-hour time list from `from` to `to` (both "HH:MM"), every `step` minutes. */
export function timeField({ id, name, value, step = 30, from = '00:00', to = '23:59' }) {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const times = [];
  for (let t = toMin(from); t <= toMin(to); t += step) times.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
  if (value && !times.includes(value)) {
    times.push(value);
    times.sort();
  }
  return html`<select id="${id}" name="${name}" class="text-input">
    ${times.map((t) => html`<option value="${t}" ${t === value ? 'selected' : ''}>${t}</option>`)}
  </select>`;
}

// One set of listeners for every date field on the page (forms are drawn
// and redrawn at any time, e.g. in dialogs).
if (typeof document !== 'undefined') {
  const parts = (el) => {
    const box = el.closest('.date-field');
    return box && { text: box.querySelector('.date-text'), native: box.querySelector('.date-native') };
  };
  // Typing: keep the hidden value in step ('' while it isn't a date yet).
  document.addEventListener('input', (event) => {
    if (!event.target.matches?.('.date-text')) return;
    const p = parts(event.target);
    p.native.value = europeanToIso(p.text.value);
  });
  // Leaving the field: tidy what was typed (1.2.26 → 01/02/2026).
  document.addEventListener('focusout', (event) => {
    if (!event.target.matches?.('.date-text')) return;
    const p = parts(event.target);
    const iso = europeanToIso(p.text.value);
    if (iso) p.text.value = isoToEuropean(iso);
  });
  // Picked in the calendar: show it in the text field.
  document.addEventListener('change', (event) => {
    if (!event.target.matches?.('.date-native')) return;
    const p = parts(event.target);
    p.text.value = isoToEuropean(p.native.value);
    p.text.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // The calendar button opens the browser's picker (where it can).
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('.date-pick');
    if (!button) return;
    const p = parts(button);
    try {
      p.native.showPicker();
    } catch {
      p.text.focus();
    }
  });
  // Code that focuses the hidden field (e.g. to point at an error) lands on the text field.
  document.addEventListener('focusin', (event) => {
    if (event.target.matches?.('.date-native')) parts(event.target).text.focus();
  });
}
