// Entry point: loads data/site.json and routes between pages.
//
// Routes (hash based, so GitHub Pages never sees them):
//   #/                         all meetings
//   #/m/<meeting-id>           a meeting (picks a sensible tab)
//   #/m/<meeting-id>/<tab>     tab = pre | during | post   (?focus=<question-id>)
//   #/decisions?q=<search>     all decisions, searchable
//
// Sign-in (only with a backend in course.yml) lives in auth.js.

import { html } from './dom.js';
import { startAuth, takeAuthRedirect } from './auth.js';
import { attachSurveys, detachSurveys } from './surveys.js';
import {
  TABS, defaultTab, meetingsView, meetingView, decisionsView, decisionCount, decisionList,
  allDecisions, filterDecisions, notFoundView, errorView,
} from './views.js';

const main = document.getElementById('main');
let site = null;
let lastPath = null;

function parseHash() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = hash.split('?');
  let parts;
  try {
    parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    parts = ['\u0000invalid'];
  }
  return { parts, params: new URLSearchParams(query), path: pathPart };
}

function setNav(active) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function show(view, nav) {
  main.innerHTML = String(view.body);
  document.title = `${view.title} · ${site?.course.name ?? 'Meetings'}`;
  setNav(nav);
}

function route() {
  if (!site) return;
  const { parts, params, path } = parseHash();
  const firstRender = lastPath === null;
  const pathChanged = path !== lastPath;
  lastPath = path;
  detachSurveys();

  if (parts.length === 0) {
    show(meetingsView(site), 'meetings');
  } else if (parts[0] === 'm' && parts[1] && parts.length <= 3) {
    const meeting = site.meetings.find((m) => m.id === parts[1]);
    const tab = parts[2] ?? (meeting && defaultTab(meeting));
    if (!meeting) show(notFoundView('There is no meeting with this address.'), 'meetings');
    else if (!TABS.some((t) => t.id === tab)) show(notFoundView(), 'meetings');
    else {
      show(meetingView(meeting, tab), 'meetings');
      if (tab === 'pre') attachSurveys(main, meeting, site.backend);
    }
  } else if (parts[0] === 'decisions' && parts.length === 1) {
    show(decisionsView(site, params.get('q') ?? ''), 'decisions');
    wireDecisionSearch();
  } else {
    show(notFoundView(), null);
  }

  const focus = params.get('focus');
  const target = focus && document.getElementById(`q-${focus}`);
  if (target) {
    // Move keyboard/screen-reader focus to the linked question, too.
    target.classList.add('highlight');
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
  } else if (pathChanged) {
    window.scrollTo(0, 0);
    // After in-app navigation, move focus to the new page's heading so screen
    // readers announce it (on first load the browser handles this).
    if (!firstRender) main.querySelector('h1')?.focus({ preventScroll: true });
  }
}

function wireDecisionSearch() {
  const input = document.getElementById('decision-search');
  const results = document.getElementById('decision-results');
  const count = document.getElementById('decision-count');
  const entries = allDecisions(site);
  input.addEventListener('input', () => {
    const q = input.value.trim();
    const shown = filterDecisions(entries, q);
    results.innerHTML = String(decisionList(shown));
    // Update the text of the existing status element so screen readers announce it.
    count.textContent = decisionCount(shown.length, entries.length, q);
    // Keep the search in the address bar (shareable) without re-rendering.
    history.replaceState(null, '', q ? `#/decisions?q=${encodeURIComponent(q)}` : '#/decisions');
  });
}

async function start() {
  // Back from GitHub sign-in? Restore the page first, so it is what gets drawn.
  const redirect = takeAuthRedirect();
  // The skip link targets #main, which would otherwise be read as a route.
  document.querySelector('[data-skip]')?.addEventListener('click', (event) => {
    event.preventDefault();
    main.focus();
  });
  try {
    const response = await fetch('data/site.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`could not load site data (HTTP ${response.status})`);
    site = await response.json();
  } catch (err) {
    show(errorView(err.message), null);
    return;
  }
  const footer = document.getElementById('footer-text');
  footer.innerHTML = String(html`Built with <a href="https://github.com/ElisejOrsini/meeting-engine" rel="noopener">meeting-engine</a> v${site.engine.version}`);
  window.addEventListener('hashchange', route);
  // Start sign-in first: its first, synchronous step marks the state as
  // "loading", so the first page doesn't briefly say surveys are switched off.
  const auth = site.backend && startAuth(site.backend, redirect, {
    accountEl: document.getElementById('account'),
    noticeEl: document.getElementById('site-notice'),
  });
  route();
  await auth;
}

start();
