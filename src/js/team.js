// Private courses: the Team page (team list and agent keys) and the
// "Publish" button on draft meetings. The database checks every change
// (only organizers may make them); this file only sends them and shows the
// result.

import { newKeyNotice } from './views.js';

const GITHUB_LOGIN = /^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$/;

/** Calls a database function; returns its data or throws an Error with a readable message. */
async function call(client, name, args) {
  let result;
  try {
    result = await client.rpc(name, args);
  } catch (err) {
    throw new Error('The backend didn’t answer. Try again.', { cause: err });
  }
  if (result.error) throw new Error(result.error.message || 'That didn’t work.');
  return result.data;
}

/** GitHub's numeric id and exact spelling of a username (public GitHub API). */
async function lookUpGitHubUser(login, fetchImpl = fetch) {
  const response = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (response.status === 404) throw new Error(`There is no GitHub account called “${login}”.`);
  if (!response.ok) throw new Error(`Couldn’t look up “${login}” on GitHub (HTTP ${response.status}). Try again in a minute.`);
  const user = await response.json();
  if (user.type && user.type !== 'User') throw new Error(`“${login}” is a GitHub ${user.type.toLowerCase()}, not a person’s account.`);
  if (!Number.isSafeInteger(user.id) || !GITHUB_LOGIN.test(user.login ?? '')) throw new Error('GitHub’s answer looked wrong. Try again.');
  return { id: user.id, login: user.login };
}

/**
 * Wire up the Team page. `reload()` fetches the course again and redraws.
 */
export function attachTeam(root, { site, client, reload }) {
  const course = site.course.id;
  const status = root.querySelector('#team-status');
  const say = (text) => { if (status) status.textContent = text; };
  const memberOf = (el) => site.members.find((m) => String(m.github_id) === el.closest('[data-member]')?.dataset.member);

  async function act(button, work, done) {
    if (button) button.disabled = true;
    say('Saving…');
    try {
      await work();
      say(done);
      await reload();
    } catch (err) {
      say(err.message);
      if (button) button.disabled = false;
    }
  }

  root.querySelector('#add-member')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const login = form.login.value.trim().replace(/^@/, '');
    if (!GITHUB_LOGIN.test(login)) {
      say('Enter a GitHub username, like octocat.');
      form.login.focus();
      return;
    }
    act(form.querySelector('button[type=submit]'), async () => {
      const user = await lookUpGitHubUser(login);
      await call(client, 'add_member', {
        p_course: course, p_github_id: user.id, p_login: user.login,
        p_name: form.name.value.trim() || null, p_organizer: form.organizer.checked,
      });
    }, `Added ${login}.`);
  });

  root.querySelector('#add-key')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type=submit]');
    const label = form.label.value.trim();
    if (!label) {
      say('Give the key a label, e.g. OpenClaw.');
      return;
    }
    button.disabled = true;
    say('Creating…');
    try {
      const key = await call(client, 'create_agent_key', { p_course: course, p_label: label, p_permission: form.permission.value });
      const box = root.querySelector('#new-key');
      box.innerHTML = String(newKeyNotice(key));
      box.hidden = false;
      form.hidden = true;
      say('Key created. Copy it now; then reload the page.');
      box.querySelector('[data-action="copy-key"]').addEventListener('click', async () => {
        const copied = box.querySelector('#copy-status');
        try {
          await navigator.clipboard.writeText(key);
          copied.textContent = 'Copied.';
        } catch {
          copied.textContent = 'Couldn’t copy; select the key and copy it by hand.';
        }
      });
    } catch (err) {
      say(err.message);
      button.disabled = false;
    }
  });

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action } = button.dataset;
    if (action === 'toggle-organizer') {
      const m = memberOf(button);
      act(button, () => call(client, 'update_member', {
        p_course: course, p_github_id: m.github_id, p_name: m.name, p_organizer: !m.organizer,
      }), m.organizer ? `${m.login} is now a member.` : `${m.login} is now an organizer.`);
    } else if (action === 'remove-member') {
      const m = memberOf(button);
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Remove @${m.login} from the team? They lose access right away.`)) return;
      act(button, () => call(client, 'remove_member', { p_course: course, p_github_id: m.github_id }), `Removed ${m.login}.`);
    } else if (action === 'revoke-key') {
      const id = button.closest('[data-key]')?.dataset.key;
      const key = site.agent_keys?.find((k) => k.id === id);
      // eslint-disable-next-line no-alert
      if (!key || !window.confirm(`Revoke the key “${key.label}”? Whatever uses it stops working right away.`)) return;
      act(button, () => call(client, 'revoke_agent_key', { p_course: course, p_id: id }), 'Key revoked.');
    }
  });
}

/** The "Publish" button on a draft meeting's page. */
export function attachPublish(root, { site, client, reload }) {
  const banner = root.querySelector('[data-draft]');
  const button = banner?.querySelector('[data-action="publish"]');
  if (!button) return;
  button.addEventListener('click', async () => {
    const status = banner.querySelector('[data-publish-status]');
    button.disabled = true;
    status.textContent = 'Publishing…';
    try {
      await call(client, 'set_published', { p_course: site.course.id, p_meeting: banner.dataset.draft, p_published: true });
      await reload();
    } catch (err) {
      status.textContent = err.message;
      button.disabled = false;
    }
  });
}

export { lookUpGitHubUser };
