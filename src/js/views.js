// Page templates. Each view returns { title, body } where body is SafeHtml.

import { html, raw, link } from './dom.js';

export const TABS = [
  { id: 'pre', label: 'Pre-meeting' },
  { id: 'during', label: 'In-meeting' },
  { id: 'post', label: 'Post-meeting' },
];

// ---------- small helpers ----------

export function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDate(date, { weekday = true } = {}) {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: weekday ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function addMinutes(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function timeRange(meeting) {
  if (!meeting.time) return '';
  return meeting.duration ? `${meeting.time}–${addMinutes(meeting.time, meeting.duration)}` : meeting.time;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The tab to open when a meeting link has no tab in it. */
export function defaultTab(meeting, today = localToday()) {
  if (meeting.summary_html || meeting.decisions.length) return 'post';
  if (meeting.date === today) return 'during';
  if (meeting.date < today) return 'post';
  return 'pre';
}

function questionById(meeting, id) {
  return meeting.questions.find((q) => q.id === id);
}

function meetingFacts(meeting) {
  const facts = [formatDate(meeting.date), timeRange(meeting), meeting.location].filter(Boolean);
  return html`<p class="facts">${facts.map((f, i) => html`${i ? html`<span aria-hidden="true"> · </span>` : ''}<span>${f}</span>`)}</p>`;
}

function section(title, content, { className = '' } = {}) {
  if (!content || (typeof content === 'object' && !String(content))) return '';
  return html`<section class="block ${className}"><h2>${title}</h2>${content}</section>`;
}

// ---------- meetings list ----------

// One row of a grouped list: title, date line, status on the right, chevron.
function meetingRow(meeting, today) {
  const surveyCount = meeting.questions.filter((q) => q.survey.length).length;
  const status = [];
  if (meeting.date === today) status.push(html`<span class="badge badge-today">Today</span>`);
  if (meeting.date > today && surveyCount) status.push(html`<span>${plural(surveyCount, 'survey question')}</span>`);
  if (meeting.decisions.length) status.push(html`<span class="status-ok">${plural(meeting.decisions.length, 'decision')}</span>`);
  if (meeting.date < today && !meeting.summary_html) status.push(html`<span class="status-warn">Summary pending</span>`);
  return html`
    <li>
      <a class="row-link" href="${link('m', meeting.id)}">
        <span class="row-text">
          <span class="row-title">${meeting.title}</span>
          <span class="row-subtitle">${formatDate(meeting.date)}${meeting.time ? ` · ${meeting.time}` : ''}</span>
        </span>
        ${status.length ? html`<span class="row-meta">${status}</span>` : ''}
        <span class="chevron" aria-hidden="true"></span>
      </a>
    </li>`;
}

export function meetingsView(site, today = localToday()) {
  const upcoming = site.meetings.filter((m) => m.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = site.meetings.filter((m) => m.date < today); // already newest first
  const list = (items, empty) => (items.length
    ? html`<ul class="list">${items.map((m) => meetingRow(m, today))}</ul>`
    : html`<p class="muted">${empty}</p>`);
  return {
    title: 'Meetings',
    body: html`
      <h1 tabindex="-1">${site.course.name}</h1>
      ${site.course.description_html ? html`<div class="prose lead">${raw(site.course.description_html)}</div>` : ''}
      ${site.course.links.length ? html`<p class="course-links">${site.course.links.map((l) => html`<a href="${l.url}" rel="noopener">${l.title}</a>`)}</p>` : ''}
      <section class="block"><h2>Upcoming meetings</h2>${list(upcoming, 'No upcoming meetings yet.')}</section>
      <section class="block"><h2>Past meetings</h2>${list(past, 'No past meetings yet.')}</section>`,
  };
}

// ---------- meeting page ----------

function surveyField(question, field, disabled) {
  const name = `${question.id}--${field.id}`;
  const req = field.required ? html`<span class="required" title="Required">*</span>` : '';
  if (field.type === 'text') {
    return html`
      <div class="field">
        <label for="${name}">${field.label}${req}</label>
        <textarea id="${name}" name="${name}" rows="3" maxlength="4000" data-field="${field.id}" ${disabled ? 'disabled' : ''}></textarea>
      </div>`;
  }
  const type = field.type === 'single' ? 'radio' : 'checkbox';
  return html`
    <fieldset class="field">
      <legend>${field.label}${req}${field.type === 'multiple' ? html` <span class="muted">(choose any)</span>` : ''}</legend>
      <div class="options">${field.options.map((option, i) => html`
        <label class="option"><input type="${type}" name="${name}" value="${i}" data-field="${field.id}" ${disabled ? 'disabled' : ''}> <span>${option}</span></label>`)}
      </div>
    </fieldset>`;
}

export function revealNote(meeting) {
  return meeting.reveal === 'after_answering'
    ? 'Answering is optional. Others’ answers to a question become visible once you’ve answered it yourself.'
    : 'Answering is optional. Others’ answers stay hidden until you click “Show other responses”.';
}

function questionCard(meeting, question, index) {
  const decisions = meeting.decisions.filter((d) => d.question === question.id);
  const id = question.id;
  return html`
    <article class="card question" id="q-${id}" tabindex="-1">
      <header class="question-head">
        <div class="question-title">
          <p class="question-label">Question ${index + 1}</p>
          <h3>${question.text}</h3>
        </div>
        ${decisions.length ? html`<a class="badge badge-ok" href="${link('m', meeting.id, 'post')}">Decided</a>` : ''}
      </header>
      ${question.details_html ? html`<div class="prose">${raw(question.details_html)}</div>` : ''}
      ${question.survey.length ? html`
        <div class="question-actions" data-question="${id}">
          <span class="question-status"></span>
          <button type="button" class="link-button" data-action="open-responses" aria-haspopup="dialog" hidden>See responses</button>
          <button type="button" class="button button-small" data-action="open" aria-haspopup="dialog">Answer</button>
        </div>
        ${surveySheet(meeting, question, index)}` : ''}
    </article>`;
}

// The survey of one question, in a sheet (a modal <dialog>) so the page can be
// read without it. surveys.js opens it and brings the form to life.
function surveySheet(meeting, question, index) {
  const id = question.id;
  return html`
    <dialog class="sheet" id="sheet-${id}" data-question="${id}" aria-labelledby="sheet-title-${id}">
      <header class="sheet-header">
        <div class="sheet-heading">
          <p class="question-label">Question ${index + 1}</p>
          <h2 class="sheet-title" id="sheet-title-${id}" tabindex="-1">${question.text}</h2>
        </div>
        <button type="button" class="sheet-close" data-action="close" aria-label="Close"></button>
      </header>
      <div class="sheet-body">
        <p class="notice survey-notice">${revealNote(meeting)}</p>
        <p class="sheet-sign-in" hidden>
          <button type="button" class="button" data-action="sign-in">Sign in with GitHub</button>
        </p>
        <form class="survey" data-question="${id}" aria-label="Your answer" novalidate>
          ${question.survey.map((f) => surveyField(question, f, true))}
          <div class="survey-actions" hidden>
            <button type="submit" class="button button-primary">Save answer</button>
            <button type="button" class="link-button" data-action="clear" hidden>Remove my answer</button>
            <span class="survey-status" role="status"></span>
          </div>
        </form>
        <div class="survey-others" data-question="${id}" hidden>
          <button type="button" class="button" data-action="show">Show other responses</button>
          <span class="muted survey-others-note"></span>
          <p class="survey-others-status" role="status"></p>
          <div class="survey-results"></div>
        </div>
      </div>
    </dialog>`;
}

function preTab(meeting) {
  return html`
    ${section('Background', meeting.background_html && html`<div class="prose">${raw(meeting.background_html)}</div>`)}
    ${section('Pre-reading', meeting.prereading_html && html`<div class="prose">${raw(meeting.prereading_html)}</div>`)}
    ${meeting.questions.length ? html`
      <section class="block">
        <h2>Open questions</h2>
        ${meeting.questions.map((q, i) => questionCard(meeting, q, i))}
      </section>` : ''}
    ${!meeting.background_html && !meeting.prereading_html && !meeting.questions.length
      ? html`<p class="muted">Nothing to prepare for this meeting yet.</p>` : ''}`;
}

function duringTab(meeting) {
  let clock = meeting.time;
  const rows = meeting.agenda.map((item) => {
    let slot = '';
    if (clock && item.minutes !== undefined) {
      const end = addMinutes(clock, item.minutes);
      slot = `${clock}–${end}`;
      clock = end;
    } else {
      clock = undefined; // can't compute later slots without minutes
    }
    const q = item.question && questionById(meeting, item.question);
    return html`
      <li class="agenda-item">
        <div class="agenda-time">${slot || (item.minutes !== undefined ? `${item.minutes} min` : '')}</div>
        <div class="agenda-body">
          <div class="agenda-title">${item.title}</div>
          ${q ? html`<a class="agenda-question" href="${link('m', meeting.id, 'pre')}?focus=${encodeURIComponent(q.id)}">Q${meeting.questions.indexOf(q) + 1}: ${q.text}</a>` : ''}
          ${item.notes_html ? html`<div class="prose small">${raw(item.notes_html)}</div>` : ''}
        </div>
      </li>`;
  });
  const empty = !meeting.agenda.length && !meeting.guide_html && !meeting.questions.length;
  return html`
    ${meeting.agenda.length ? section('Agenda', html`<ol class="agenda">${rows}</ol>`) : ''}
    ${section('Meeting guide', meeting.guide_html && html`<div class="prose">${raw(meeting.guide_html)}</div>`)}
    ${meeting.questions.length ? section('Questions to decide', html`
      <ol class="question-list">${meeting.questions.map((q) => html`
        <li><a href="${link('m', meeting.id, 'pre')}?focus=${encodeURIComponent(q.id)}">${q.text}</a></li>`)}</ol>`) : ''}
    ${empty ? html`<p class="muted">No agenda for this meeting yet.</p>` : ''}`;
}

function decisionCard(decision, { meeting, showMeeting = false }) {
  const question = decision.question && questionById(meeting, decision.question);
  return html`
    <article class="card decision">
      ${showMeeting ? html`
        <p class="decision-meta"><span>${formatDate(meeting.date, { weekday: false })}</span> · <a href="${link('m', meeting.id, 'post')}">${meeting.title}</a></p>` : ''}
      ${question ? html`<p class="decision-question"><a href="${link('m', meeting.id, 'pre')}?focus=${encodeURIComponent(question.id)}">${question.text}</a></p>` : ''}
      <div class="prose decision-text">${raw(decision.decision_html)}</div>
      ${decision.rationale_html ? html`<div class="prose rationale"><span class="rationale-label">Why:</span> ${raw(decision.rationale_html)}</div>` : ''}
    </article>`;
}

function postTab(meeting, today) {
  const decided = new Set(meeting.decisions.map((d) => d.question).filter(Boolean));
  const open = meeting.questions.filter((q) => !decided.has(q.id));
  const happened = meeting.date < today || meeting.summary_html || meeting.decisions.length;
  return html`
    ${meeting.summary_html
      ? section('Summary', html`<div class="prose">${raw(meeting.summary_html)}</div>`)
      : html`<p class="notice">${happened ? 'The summary for this meeting hasn’t been added yet.' : 'The summary will appear here after the meeting.'}</p>`}
    ${meeting.decisions.length ? section(`Decisions (${meeting.decisions.length})`, html`
      ${meeting.decisions.map((d) => decisionCard(d, { meeting }))}`) : ''}
    ${happened && open.length ? section('Still open', html`
      <ul class="question-list">${open.map((q) => html`
        <li><a href="${link('m', meeting.id, 'pre')}?focus=${encodeURIComponent(q.id)}">${q.text}</a></li>`)}</ul>`) : ''}`;
}

export function meetingView(meeting, tab, today = localToday()) {
  const content = tab === 'during' ? duringTab(meeting) : tab === 'post' ? postTab(meeting, today) : preTab(meeting);
  const label = TABS.find((t) => t.id === tab)?.label ?? '';
  return {
    title: `${meeting.title} – ${label}`,
    body: html`
      <p class="breadcrumb"><a href="#/">‹ All meetings</a></p>
      <h1 tabindex="-1">${meeting.title}</h1>
      ${meetingFacts(meeting)}
      <nav class="tabs" aria-label="Meeting sections">
        ${TABS.map((t) => html`<a href="${link('m', meeting.id, t.id)}" ${t.id === tab ? html`aria-current="page"` : ''}>${t.label}</a>`)}
      </nav>
      <div class="tab-panel">${content}</div>`,
  };
}

// ---------- decisions page ----------

/** Every decision across all meetings, newest meeting first. */
export function allDecisions(site) {
  return site.meetings.flatMap((meeting) => meeting.decisions.map((decision) => {
    const question = decision.question && questionById(meeting, decision.question);
    const haystack = [decision.search_text, question?.text, meeting.title, meeting.date, formatDate(meeting.date)]
      .filter(Boolean).join('\n').toLowerCase();
    return { meeting, decision, haystack };
  }));
}

export function filterDecisions(entries, query) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? entries.filter((e) => terms.every((t) => e.haystack.includes(t))) : entries;
}

/** Text for the result count, e.g. "2 decisions match “grace” (of 9)." */
export function decisionCount(shown, total, query) {
  if (!total) return 'No decisions have been recorded yet.';
  return query
    ? `${plural(shown, 'decision')} ${shown === 1 ? 'matches' : 'match'} “${query}” (of ${total}).`
    : `${plural(total, 'decision')} from all meetings.`;
}

export function decisionList(entries) {
  return html`${entries.map((e) => decisionCard(e.decision, { meeting: e.meeting, showMeeting: true }))}`;
}

export function decisionsView(site, query) {
  const entries = allDecisions(site);
  const shown = filterDecisions(entries, query);
  return {
    title: 'Decisions',
    body: html`
      <h1 tabindex="-1">Decisions</h1>
      <p class="lead">Everything decided in past meetings, newest first.</p>
      <div class="search">
        <label for="decision-search">Search decisions</label>
        <input id="decision-search" type="search" placeholder="e.g. attendance, grace period" value="${query ?? ''}" autocomplete="off">
      </div>
      <p id="decision-count" class="muted" role="status">${decisionCount(shown.length, entries.length, query)}</p>
      <div id="decision-results">${decisionList(shown)}</div>`,
  };
}

export function notFoundView(message = 'This page doesn’t exist.') {
  return {
    title: 'Not found',
    body: html`<h1 tabindex="-1">Not found</h1><p>${message}</p><p><a href="#/">Go to all meetings</a></p>`,
  };
}

export function errorView(message) {
  return {
    title: 'Error',
    body: html`<h1 tabindex="-1">Something went wrong</h1><p>${message}</p>`,
  };
}
