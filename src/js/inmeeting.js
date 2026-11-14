// The In-meeting tab, once drawn (views.js): keeps the countdown to the AI
// summary ticking, fills in the vote counts for signed-in team members
// (public.get_tallies: counts only, no names; with "after_answering" only for
// questions you answered or skipped) and refreshes them every
// minute, and lets "Q2" in the agenda jump to that question on the same tab.
// Who may see the counts, and when, is decided by the database.

import { html } from './dom.js';
import { onAuth } from './auth.js';
import { countdownText } from './views.js';

const REFRESH_MS = 60_000;

let detachCurrent = null;

export function detachInMeeting() {
  detachCurrent?.();
  detachCurrent = null;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// The bars start folded once the AI summary is there (it already says what
// they show), and open while there is no summary.
function tallyView(question, tally, open) {
  const fields = question.survey.filter((f) => f.type !== 'text');
  const byId = new Map((tally?.fields ?? []).map((f) => [f.id, f]));
  const answered = tally?.answered ?? 0;
  const skipped = tally?.skipped ?? 0;
  const label = `${plural(answered, 'answer')}${skipped ? ` · ${skipped} skipped` : ''}`;
  if (!answered) return html`<p class="muted small">${skipped ? `No votes yet · ${skipped} skipped` : 'No survey answers yet.'}</p>`;
  return html`
    <details class="decide-votes" ${open ? 'open' : ''}>
    <summary>${label}</summary>
    ${fields.map((field) => {
      const counts = byId.get(field.id)?.counts ?? field.options.map((option) => ({ option, count: 0 }));
      return html`
        <div class="response-field">
          ${fields.length > 1 ? html`<p class="response-label">${field.label}</p>` : ''}
          <ul class="tally">${counts.map((c) => html`
            <li>
              <span class="tally-option">${c.option}</span>
              <span class="tally-bar" aria-hidden="true"><span data-share="${Math.round((100 * c.count) / answered)}"></span></span>
              <span class="tally-count">${c.count}</span>
            </li>`)}
          </ul>
        </div>`;
    })}
    </details>`;
}

/** Bring a rendered In-meeting tab of `meeting` to life. */
export function attachInMeeting(root, meeting, backend) {
  detachInMeeting();
  const stop = new AbortController();
  const timers = [];
  const questions = new Map(meeting.questions.map((q) => [q.id, q]));

  // "Q2" in the agenda: go to the question on this tab.
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-goto]');
    if (!button) return;
    const target = root.querySelector(`#q-${CSS.escape(button.dataset.goto)}`);
    if (!target) return;
    for (const el of root.querySelectorAll('.decide-item.highlight')) el.classList.remove('highlight');
    target.classList.add('highlight');
    target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target.focus({ preventScroll: true });
  }, { signal: stop.signal });

  // The countdown to the AI summary.
  const countdown = root.querySelector('[data-countdown]');
  if (countdown) {
    const due = Number(countdown.dataset.countdown);
    const value = countdown.querySelector('[data-countdown-value]');
    const tick = () => {
      if (Date.now() >= due) {
        value.textContent = 'being written…';
        for (const p of root.querySelectorAll('[data-countdown-for]')) p.textContent = 'Summary is being written…';
        return false;
      }
      value.textContent = countdownText(due);
      return true;
    };
    if (tick()) {
      const id = setInterval(() => { if (!tick()) clearInterval(id); }, 1000);
      timers.push(() => clearInterval(id));
    }
  }

  // Vote counts, for team members.
  const boxes = [...root.querySelectorAll('[data-tallies]')];
  let client = null;
  let generation = 0;
  async function loadTallies() {
    if (!client || !boxes.length) return;
    const mine = ++generation;
    const answer = await Promise.resolve(client.rpc('get_tallies', { p_course: backend.course_id, p_meeting: meeting.id }))
      .catch((error) => ({ data: null, error }));
    if (mine !== generation || stop.signal.aborted) return;
    if (answer.error || !answer.data) return; // keep what is shown
    const data = answer.data;
    const from = data.visible_from ? new Date(data.visible_from) : null;
    const forAll = from ? ` Everyone sees them from ${from.toLocaleTimeString('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' })}${
      from.toDateString() === new Date().toDateString() ? '' : ` on ${from.toLocaleDateString('en-GB', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'short' })}`}.` : '';
    for (const box of boxes) {
      const question = questions.get(box.dataset.tallies);
      if ((data.locked ?? []).includes(question.id)) {
        box.innerHTML = String(html`<p class="muted small">Answer or skip this question on the Pre-meeting tab to see the votes.${forAll}</p>`);
      } else {
        const open = box.querySelector('details')?.open ?? !box.closest('.decide-item').querySelector('.consensus');
        box.innerHTML = String(tallyView(question, data.questions?.[question.id], open));
        for (const bar of box.querySelectorAll('[data-share]')) bar.style.width = `${bar.dataset.share}%`;
      }
      box.hidden = false;
    }
  }
  if (backend && boxes.length) {
    const unsubscribe = onAuth((state) => {
      client = state.status === 'member' ? state.client : null;
      if (client) loadTallies();
      else for (const box of boxes) box.hidden = true;
    });
    const id = setInterval(() => { if (document.visibilityState === 'visible') loadTallies(); }, REFRESH_MS);
    timers.push(() => clearInterval(id), unsubscribe);
  }

  detachCurrent = () => {
    stop.abort();
    for (const clear of timers) clear();
  };
}
