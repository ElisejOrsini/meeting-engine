// Survey answers on the Pre-meeting tab.
//
// views.js draws each question's survey as a disabled form. attachSurveys()
// brings those forms to life for signed-in team members: it fills in their
// saved answers, saves changes, and shows the others' responses on request.
// Every rule (who may answer, what an answer may contain, when others'
// answers are visible, anonymity, deletion after 30 days) is enforced by the
// database (supabase/migrations); this file only follows it.

import { html } from './dom.js';
import { onAuth } from './auth.js';
import { localToday, revealNote } from './views.js';

export const KEEP_DAYS = 30;

/** Have this meeting's answers been deleted (30 days after the meeting)? */
export function answersExpired(date, today = localToday()) {
  const until = new Date(`${date}T00:00:00Z`);
  until.setUTCDate(until.getUTCDate() + KEEP_DAYS);
  return until.toISOString().slice(0, 10) < today;
}

function who(row) {
  return row.mine ? 'you' : row.github_login ?? null;
}

/**
 * Summarise the answers to one question: per choice field, how many people
 * chose each option (and who, unless anonymous); per text field, the texts.
 * Options that are no longer in the survey but were chosen are listed last.
 */
export function tally(question, rows) {
  const fields = question.survey.map((field) => {
    if (field.type === 'text') {
      const texts = rows
        .filter((r) => typeof r.answer?.[field.id] === 'string' && r.answer[field.id].trim())
        .map((r) => ({ text: r.answer[field.id].trim(), who: who(r), mine: Boolean(r.mine) }));
      return { field, texts };
    }
    const chosen = (r) => [].concat(r.answer?.[field.id] ?? []).filter((v) => typeof v === 'string');
    const known = new Set(field.options);
    const extra = [...new Set(rows.flatMap(chosen).filter((v) => !known.has(v)))];
    const counts = [...field.options, ...extra].map((option) => {
      const by = rows.filter((r) => chosen(r).includes(option));
      return { option, count: by.length, who: by.map(who).filter(Boolean), retired: !known.has(option) };
    });
    return { field, counts, answered: rows.filter((r) => chosen(r).length).length };
  });
  return { count: rows.length, fields };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function resultsView(question, rows) {
  const t = tally(question, rows);
  const heading = `responses-${question.id}`;
  const fieldView = (f) => {
    if (f.texts) {
      return html`
        <div class="response-field">
          <p class="response-label">${f.field.label}</p>
          ${f.texts.length ? html`
            <ul class="text-answers">${f.texts.map((x) => html`
              <li><p class="text-answer">${x.text}</p>${x.who ? html`<span class="muted">— ${x.who}</span>` : ''}</li>`)}
            </ul>` : html`<p class="muted">No written answers.</p>`}
        </div>`;
    }
    return html`
      <div class="response-field">
        <p class="response-label">${f.field.label}</p>
        <ul class="tally">${f.counts.map((c) => html`
          <li>
            <span class="tally-option">${c.option}${c.retired ? html` <span class="muted">(no longer an option)</span>` : ''}</span>
            <span class="tally-bar" aria-hidden="true"><span data-share="${t.count ? Math.round((100 * c.count) / t.count) : 0}"></span></span>
            <span class="tally-count">${c.count}</span>
            ${c.who.length ? html`<span class="tally-names">${c.who.join(', ')}</span>` : ''}
          </li>`)}
        </ul>
      </div>`;
  };
  return html`
    <section class="responses" aria-labelledby="${heading}">
      <h4 id="${heading}" tabindex="-1">${t.count ? plural(t.count, 'response') : 'No responses yet'}</h4>
      ${t.count ? t.fields.map(fieldView) : ''}
    </section>`;
}

function formatTime(timestamp) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
  } catch {
    return '';
  }
}

/** Fill a question's form with an answer (or clear it). */
function fill(form, question, answer) {
  for (const input of form.querySelectorAll('[data-field]')) {
    const field = question.survey.find((f) => f.id === input.dataset.field);
    const value = answer?.[input.dataset.field];
    if (!field) continue;
    if (field.type === 'text') input.value = typeof value === 'string' ? value : '';
    else input.checked = [].concat(value ?? []).includes(field.options[Number(input.value)]);
  }
}

/** Read a question's form: the non-empty values, and the labels of required fields left empty. */
function collect(form, question) {
  const answer = {};
  for (const field of question.survey) {
    const inputs = [...form.querySelectorAll('[data-field]')].filter((i) => i.dataset.field === field.id);
    if (field.type === 'text') {
      const text = inputs[0]?.value.trim() ?? '';
      if (text) answer[field.id] = text;
    } else {
      const picked = inputs.filter((i) => i.checked).map((i) => field.options[Number(i.value)]).filter(Boolean);
      if (field.type === 'single' && picked.length) answer[field.id] = picked[0];
      if (field.type === 'multiple' && picked.length) answer[field.id] = picked;
    }
  }
  const missing = question.survey.filter((f) => f.required && !(f.id in answer)).map((f) => f.label);
  return { answer, missing };
}

/** The message to show for a failed call: our own database messages, or a general one. */
function problem(error, action) {
  // P0001: raised by the meeting-engine database functions, written for people.
  if (error?.code === 'P0001' && error.message) return `Couldn’t ${action}: ${error.message}.`;
  if (error?.code === '42501') return `Couldn’t ${action}: you’re not on this course’s team list.`;
  return `Couldn’t ${action} (the backend didn’t answer). Please try again.`;
}

/** Call a database function; never throws (network errors come back as { error }). */
function call(client, name, args) {
  // supabase-js returns a "thenable" without .catch(), so wrap it in a real promise.
  return Promise.resolve(client.rpc(name, args)).catch((error) => ({ data: null, error }));
}

let detachCurrent = null;
// Saves still being sent for a page that was left; a newly shown page waits
// for them before loading the person's answers.
let flushing = Promise.resolve();

/** Stop following the surveys of the page that was shown before. */
export function detachSurveys() {
  detachCurrent?.();
  detachCurrent = null;
}

/** Bring the survey forms on `root` (a rendered Pre-meeting tab of `meeting`) to life. */
export function attachSurveys(root, meeting, backend) {
  detachSurveys();
  const forms = [...root.querySelectorAll('form.survey[data-question]')];
  if (!forms.length) return;
  const notice = root.querySelector('#survey-notice');
  const questions = new Map(meeting.questions.map((q) => [q.id, q]));
  const expired = answersExpired(meeting.date);
  const stop = new AbortController();
  const others = (id) => root.querySelector(`.survey-others[data-question="${CSS.escape(id)}"]`);
  const formFor = (id) => forms.find((f) => f.dataset.question === id);

  let auth = { status: 'none' };
  let mine = new Map(); // question id -> { answer, updated_at }
  let loaded = false; // own answers loaded for the current member
  let loadFailed = false;
  let generation = 0; // bumped when the person changes; older answers are ignored
  const shown = new Set(); // questions whose others' responses are open
  const busy = new Set(); // questions being saved right now
  const pending = new Map(); // question id -> the answer to save once the current save is done

  function noticeText() {
    if (auth.status === 'none') return 'Answering surveys isn’t switched on for this site.';
    if (expired) return `The survey answers for this meeting were deleted ${KEEP_DAYS} days after it.`;
    switch (auth.status) {
      case 'signed-out': return `Sign in with GitHub (top right) to answer. ${revealNote(meeting)}`;
      case 'not-member': return 'Your GitHub account isn’t on this course’s team list, so you can’t answer here.';
      case 'unavailable':
      case 'member-unknown': return 'Answering isn’t available right now (the backend didn’t answer). Please try again later.';
      case 'member':
        if (loadFailed) return 'Couldn’t load your answers (the backend didn’t answer). Please reload the page.';
        return `${revealNote(meeting)} ${meeting.anonymous
          ? 'This meeting is anonymous: teammates see the answers, not who gave them.'
          : 'Teammates see your GitHub username next to your answers.'} Answers are deleted ${KEEP_DAYS} days after the meeting.`;
      default: return revealNote(meeting);
    }
  }

  function setStatus(form, text, isError = false) {
    const el = form.querySelector('.survey-status');
    el.textContent = text;
    el.classList.toggle('survey-error', isError);
  }

  function render() {
    // Only on change: the notice is a live region, and screen readers announce every update.
    const text = noticeText();
    if (notice && notice.textContent !== text) notice.textContent = text;
    const active = auth.status === 'member' && loaded && !expired;
    for (const form of forms) {
      const id = form.dataset.question;
      for (const input of form.querySelectorAll('input, textarea')) input.disabled = !active;
      form.querySelector('.survey-actions').hidden = !active;
      form.querySelector('[data-action="clear"]').hidden = !mine.has(id);
      const area = others(id);
      area.hidden = !active;
      const locked = meeting.reveal === 'after_answering' && !mine.has(id);
      if (locked && shown.has(id)) {
        shown.delete(id);
        area.querySelector('.survey-results').innerHTML = '';
      }
      const button = area.querySelector('[data-action="show"]');
      button.disabled = locked;
      button.textContent = shown.has(id) ? 'Refresh responses' : 'Show other responses';
      area.querySelector('.survey-others-note').textContent = locked ? 'Answer this question to see the others’ responses.' : '';
    }
  }

  function reset() {
    generation += 1;
    mine = new Map();
    loaded = false;
    loadFailed = false;
    shown.clear();
    busy.clear();
    pending.clear();
    for (const form of forms) {
      fill(form, questions.get(form.dataset.question), undefined);
      setStatus(form, '');
      const area = others(form.dataset.question);
      area.querySelector('.survey-results').innerHTML = '';
      area.querySelector('.survey-others-status').textContent = '';
    }
  }

  async function loadMine() {
    const mineGeneration = generation;
    await flushing;
    if (stop.signal.aborted || mineGeneration !== generation) return;
    const { data, error } = await call(auth.client, 'get_answers', {
      p_course: backend.course_id, p_meeting: meeting.id, p_others: false,
    });
    if (stop.signal.aborted || mineGeneration !== generation) return;
    if (error) {
      loadFailed = true;
    } else {
      for (const row of data ?? []) if (row.mine) mine.set(row.question_id, row);
      for (const form of forms) {
        const row = mine.get(form.dataset.question);
        fill(form, questions.get(form.dataset.question), row?.answer);
        if (row) setStatus(form, `You answered on ${formatTime(row.updated_at)}.`);
      }
      loaded = true;
    }
    render();
  }

  async function showOthers(id, { focus = false } = {}) {
    const area = others(id);
    const results = area.querySelector('.survey-results');
    const status = area.querySelector('.survey-others-status'); // a live region
    const showGeneration = generation;
    status.classList.remove('survey-error');
    status.textContent = 'Loading responses…';
    const { data, error } = await call(auth.client, 'get_answers', {
      p_course: backend.course_id, p_meeting: meeting.id, p_others: true,
    });
    if (stop.signal.aborted || showGeneration !== generation) return;
    if (error) {
      status.classList.add('survey-error');
      status.textContent = problem(error, 'load the responses');
      return;
    }
    status.textContent = '';
    shown.add(id);
    results.innerHTML = String(resultsView(questions.get(id), (data ?? []).filter((r) => r.question_id === id)));
    // Bar widths are set here, not in the markup: the page's policy forbids inline styles.
    for (const bar of results.querySelectorAll('[data-share]')) bar.style.width = `${bar.dataset.share}%`;
    render();
    if (focus) results.querySelector('h4')?.focus();
  }

  async function save(form, answer) {
    const id = form.dataset.question;
    setStatus(form, 'Saving…');
    // Saving again while a save is under way: remember the newest answer and
    // send it right after (buttons aren't disabled, as that drops keyboard focus).
    if (busy.has(id)) {
      pending.set(id, answer);
      return;
    }
    busy.add(id);
    const saveGeneration = generation;
    const { client } = auth;
    const args = { p_course: backend.course_id, p_meeting: meeting.id, p_question: id };
    const { data, error } = await call(client, 'save_answer', { ...args, p_answer: answer });
    busy.delete(id);
    if (stop.signal.aborted) {
      // The page was left meanwhile: still send the newest answer the person asked for.
      if (pending.has(id)) {
        const next = pending.get(id);
        flushing = flushing.then(() => call(client, 'save_answer', { ...args, p_answer: next }));
      }
      return;
    }
    if (saveGeneration !== generation) return; // signed out or another person: drop it
    if (!error) {
      if (data === null) mine.delete(id);
      else mine.set(id, { answer, updated_at: data });
    }
    if (pending.has(id)) {
      const next = pending.get(id);
      pending.delete(id);
      render();
      save(form, next);
      return;
    }
    if (error) {
      setStatus(form, problem(error, 'save your answer'), true);
      render();
      return;
    }
    const clear = form.querySelector('[data-action="clear"]');
    const clearHadFocus = document.activeElement === clear;
    if (data === null) {
      fill(form, questions.get(id), undefined);
      setStatus(form, 'Your answer was removed.');
    } else {
      setStatus(form, `Saved on ${formatTime(data)}.`);
    }
    render();
    // "Remove my answer" disappears with the answer: keep keyboard focus in the question.
    if (clearHadFocus && clear.hidden) form.querySelector('input, textarea')?.focus();
    if (shown.has(id)) showOthers(id);
  }

  root.addEventListener('submit', (event) => {
    const form = event.target.closest('form.survey[data-question]');
    if (!form || !forms.includes(form)) return;
    event.preventDefault();
    if (auth.status !== 'member' || !loaded || expired) return;
    const { answer, missing } = collect(form, questions.get(form.dataset.question));
    const empty = Object.keys(answer).length === 0;
    // Empty with nothing stored (and nothing being saved): there's nothing to remove.
    if (empty && !mine.has(form.dataset.question) && !busy.has(form.dataset.question)) {
      setStatus(form, 'Nothing to save yet: choose or write something first.', true);
    } else if (!empty && missing.length) {
      setStatus(form, `Please also fill in: ${missing.join(', ')}.`, true);
    } else {
      save(form, empty ? {} : answer);
    }
  }, { signal: stop.signal });

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || auth.status !== 'member' || !loaded) return;
    const id = button.closest('[data-question]')?.dataset.question;
    if (!id || !questions.has(id)) return;
    if (button.dataset.action === 'clear') save(formFor(id), {});
    if (button.dataset.action === 'show') showOthers(id, { focus: true });
  }, { signal: stop.signal });

  const unsubscribe = onAuth((state) => {
    const before = auth;
    auth = state;
    const sameMember = before.status === 'member' && state.status === 'member' && before.login === state.login;
    if (!sameMember) {
      reset();
      if (state.status === 'member' && !expired) loadMine();
    }
    render();
  });

  detachCurrent = () => {
    stop.abort();
    unsubscribe();
  };
}
