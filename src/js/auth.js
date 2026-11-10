// Sign-in with GitHub through Supabase. Only used when course.yml has a
// `backend:` section.
//
// Flow (PKCE, so no tokens ever appear in the address bar):
//   1. "Sign in" remembers the current page (#/...) in sessionStorage and
//      sends the browser to GitHub via Supabase.
//   2. GitHub sends it back to this site as  ...?code=<one-time code>.
//      takeAuthRedirect() removes the code from the address bar and puts the
//      remembered page back, before the first page is drawn.
//   3. startAuth() trades the code for a session (stored in localStorage by
//      supabase-js; the trade only works in the browser that started the
//      sign-in) and asks the database whether this person is on the team
//      list. The database decides; this file only shows the result.

import { html } from './dom.js';

const RETURN_KEY = 'meeting-engine:return-to';
// Set by the database's sign-up rule (supabase/migrations, hook_before_user_created).
const NOT_ON_LIST_MESSAGE = 'not on a meeting-engine team list';

const MESSAGES = {
  'not-on-list': 'This GitHub account isn’t on the team list, so it can’t sign in. If you’re on the team, ask the course admin to add your GitHub username.',
  cancelled: 'Sign-in was cancelled.',
  failed: 'Sign-in didn’t work. Please try again.',
  unavailable: 'Sign-in isn’t available right now (the backend didn’t answer). Try again later.',
  'not-member': 'You’re signed in, but this GitHub account isn’t on this course’s team list. If you’re on the team, ask the course admin to add your GitHub username.',
  'signed-out': 'You’re signed out.',
};
const INFO_MESSAGES = new Set(['signed-out']); // shown neutral, not as a warning

// Other parts of the site (surveys) follow the sign-in state through onAuth().
// status: none (no backend) | loading | signed-out | unavailable |
//         member | not-member | member-unknown
let current = { status: 'none', login: null, client: null };
const listeners = new Set();

/** Call `listener(state)` now and whenever the sign-in state changes. Returns an unsubscribe function. */
export function onAuth(listener) {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

function publish(next) {
  if (next.status === current.status && next.login === current.login && next.client === current.client) return;
  current = next;
  for (const listener of listeners) listener(current);
}

function takeSaved(key) {
  try {
    const value = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

/**
 * Call once at startup, before the first page is drawn. If the browser just
 * came back from sign-in, cleans the address bar, restores the page the user
 * was on and returns { code, started } or { error }; otherwise returns null.
 */
export function takeAuthRedirect() {
  const url = new URL(location.href);
  // Supabase reports errors in the query and (older style) in the fragment.
  const fragment = location.hash.startsWith('#error=') ? new URLSearchParams(location.hash.slice(1)) : null;
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error') ?? fragment?.get('error');
  if (!code && !error) return null;

  // The page saved by "Sign in" (missing if the sign-in came back in a new tab).
  const saved = takeSaved(RETURN_KEY);
  const back = saved && /^#\/\S*$/.test(saved) ? saved : null;
  history.replaceState(null, '', url.pathname + (back ?? (fragment ? '#/' : location.hash)));

  if (error) {
    const description = url.searchParams.get('error_description') ?? fragment?.get('error_description') ?? '';
    // Fixed messages only: the address bar can't make the page say anything else.
    if (description.includes(NOT_ON_LIST_MESSAGE)) return { error: 'not-on-list' };
    return { error: error === 'access_denied' ? 'cancelled' : 'failed' };
  }
  return { code, started: saved !== null };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(script);
  });
}

/** Where GitHub should send the browser back to: this site's start address. */
function returnAddress() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

/** Show the sign-in button / signed-in state in `accountEl` and messages in `noticeEl`. */
export async function startAuth(backend, redirect, { accountEl, noticeEl }) {
  let state = { status: 'loading' };
  let notice = redirect?.error ?? null;
  let client = null;
  let checkedUser = null; // user id whose membership is known or being checked
  let generation = 0; // bumped on every sign-in/sign-out; older answers are ignored
  let shownMessage = null; // what the status region says now

  function render() {
    accountEl.hidden = false;
    // Keep keyboard focus in the account area when its buttons are replaced.
    const hadFocus = accountEl.contains(document.activeElement);
    const { status, login } = state;
    if (status === 'loading') {
      accountEl.innerHTML = '';
    } else if (status === 'signed-out') {
      accountEl.innerHTML = String(html`<button type="button" class="button button-small" data-auth="sign-in" aria-label="Sign in with GitHub">Sign in<span class="wide-only"> with GitHub</span></button>`);
    } else if (status === 'unavailable') {
      accountEl.innerHTML = String(html`<span class="muted">Sign-in unavailable</span>`);
    } else {
      accountEl.innerHTML = String(html`<span class="account-name" title="Signed in with GitHub">@${login}</span>
        <button type="button" class="link-button" data-auth="sign-out">Sign out</button>`);
    }
    if (hadFocus) accountEl.querySelector('button')?.focus();
    const message = notice ?? (status === 'not-member' ? 'not-member' : null);
    // Only touch the status region when the message changes: screen readers
    // announce every insertion.
    if (message !== shownMessage) {
      shownMessage = message;
      noticeEl.innerHTML = message
        ? String(html`<p class="notice${INFO_MESSAGES.has(message) ? '' : ' notice-warn'}">${MESSAGES[message]}</p>`)
        : '';
    }
    publish({ status, login: login ?? null, client });
  }

  async function update(session) {
    const userId = session?.user?.id ?? null;
    if (userId && userId === checkedUser) return; // e.g. a token refresh
    const mine = ++generation;
    checkedUser = userId;
    if (!session) {
      state = { status: 'signed-out' };
      render();
      return;
    }
    // Signed in now: earlier sign-in errors and "signed out" no longer apply.
    if (notice !== 'unavailable') notice = null;
    // Display only. The database checks membership by numeric GitHub id.
    const login = session.user.user_metadata?.user_name ?? 'GitHub user';
    let answer;
    try {
      answer = await client.rpc('is_member', { p_course: backend.course_id });
    } catch (err) {
      answer = { error: err };
    }
    if (mine !== generation) return; // someone signed in or out meanwhile
    if (answer.error) {
      checkedUser = null; // ask again on the next event
      state = { status: 'member-unknown', login };
      notice = 'unavailable';
    } else {
      state = { status: answer.data === true ? 'member' : 'not-member', login };
      if (notice === 'unavailable') notice = null;
    }
    render();
  }

  accountEl.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-auth]')?.dataset.auth;
    if (!action || !client) return;
    notice = null;
    try {
      if (action === 'sign-in') {
        try {
          sessionStorage.setItem(RETURN_KEY, location.hash || '#/');
        } catch {
          // without sessionStorage the user just lands on the start page
        }
        const { error } = await client.auth.signInWithOAuth({
          provider: 'github',
          options: { redirectTo: returnAddress() },
        });
        if (error) throw error;
      } else if (action === 'sign-out') {
        notice = 'signed-out';
        await client.auth.signOut({ scope: 'local' });
      }
    } catch {
      notice = 'failed';
      render();
    }
  });

  render();
  try {
    await loadScript('vendor/supabase.js');
    client = window.supabase.createClient(backend.url, backend.publishable_key, {
      auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true },
    });
  } catch {
    state = { status: 'unavailable' };
    render();
    return;
  }
  if (redirect?.code) {
    const { error } = await client.auth.exchangeCodeForSession(redirect.code);
    // A code this browser didn't ask for (e.g. from a shared link) is ignored quietly.
    if (error && redirect.started) {
      notice = 'failed';
      render();
    }
  }
  client.auth.onAuthStateChange((_event, session) => {
    // supabase-js asks not to call it from inside this callback directly.
    setTimeout(() => update(session), 0);
  });
}
