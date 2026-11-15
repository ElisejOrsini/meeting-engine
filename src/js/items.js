// Tasks, written check-ins and suggested tasks on the timeline (database
// part 6): their sheets, the "who" picker, organizers' Publish / Edit /
// Delete, and writing your own check-in update. timeline.js draws the line
// and opens the sheets; the database checks every change.

import { html, raw, link } from './dom.js';
import { formatDate } from './views.js';

/** "Mia", "You", or the GitHub username, for a login. */
export function nameOf(site, login) {
  if (login === site.me?.login) return 'You';
  return site.members?.find((m) => m.login === login)?.name || login;
}

/** "Everyone", "You and Mia", "Mia, Jonas and Lea". */
export function whoText(site, item) {
  if (item.everyone) return 'Everyone';
  if (!item.people?.length) return 'Nobody (they left the team)';
  const names = item.people.map((l) => nameOf(site, l)).sort((a, b) => (a === 'You' ? -1 : b === 'You' ? 1 : 0));
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const kindLabel = (item) => `${item.kind === 'checkin' ? 'Written check-in' : 'Task'}${item.published ? '' : ' · Draft'}`;

/** A next step's text without Markdown, for rows and titles (no links inside buttons). */
export function plainText(md) {
  return String(md ?? '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
}

/** Tells screen readers what just happened (a live region outside <main>). */
export function announce(text) {
  const live = document.getElementById('live-status');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 60);
}

/** Sheet id of an item on the timeline (also in links: #/timeline?open=item-<id>). */
export const itemSheetId = (item) => `item-${item.id}`;
export const suggestionSheetId = (s) => `suggest-${s.meeting}-${s.key}`;

// ---------- the "who" picker and the fields of a task or check-in

function whoPicker(site, prefix, selected, everyone) {
  return html`
    <fieldset class="field who-picker" data-who>
      <legend>Who</legend>
      <div class="options">
        <label class="option"><input type="checkbox" id="${prefix}-everyone" name="${prefix}-everyone" data-everyone ${everyone ? 'checked' : ''}> <span>Everyone</span></label>
        ${(site.members ?? []).map((m) => html`
          <label class="option"><input type="checkbox" name="${prefix}-person" value="${m.login}" data-person
            ${!everyone && selected.includes(m.login) ? 'checked' : ''} ${everyone ? 'disabled' : ''}> <span>${m.name || m.login}${m.login === site.me?.login ? ' (you)' : ''}</span></label>`)}
      </div>
    </fieldset>`;
}

/** The fields of a task or check-in (for "+ Add", Edit and suggestions). */
export function itemFields(site, kind, prefix, item = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return html`
    <div class="field">
      <label for="${prefix}-title">Title</label>
      <input id="${prefix}-title" name="${prefix}-title" class="text-input" maxlength="200" autocomplete="off"
        value="${item.title ?? ''}" placeholder="${kind === 'checkin' ? 'e.g. Project status' : 'e.g. Upload exercise sheet 9'}">
    </div>
    <div class="field">
      <label for="${prefix}-due">${kind === 'checkin' ? 'Write by' : 'Due'}</label>
      <input id="${prefix}-due" name="${prefix}-due" type="date" class="text-input" value="${item.due ?? ''}" min="${item.due && item.due < today ? item.due : today}">
    </div>
    ${whoPicker(site, prefix, item.people ?? [], item.everyone ?? true)}
    <div class="field">
      <label for="${prefix}-text">${kind === 'checkin' ? 'Question for everyone' : html`Details <span class="muted">(optional)</span>`}</label>
      <textarea id="${prefix}-text" name="${prefix}-text" rows="3" maxlength="5000" class="text-input"
        placeholder="${kind === 'checkin' ? 'e.g. How are your project groups doing? Anything blocking you?' : ''}">${item.details_md ?? ''}</textarea>
    </div>`;
}

/** Reads itemFields back: the item as the database takes it, or an error text. */
export function readItemFields(form, kind, prefix) {
  const value = (name) => form.querySelector(`[name="${prefix}-${name}"]`)?.value.trim() ?? '';
  const title = value('title');
  if (!title) return { error: 'Give it a title.', focus: `${prefix}-title` };
  const due = value('due');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return { error: 'Give the date.', focus: `${prefix}-due` };
  const everyone = form.querySelector(`[name="${prefix}-everyone"]`)?.checked;
  const people = [...form.querySelectorAll(`[name="${prefix}-person"]:checked`)].map((c) => c.value);
  if (!everyone && !people.length) return { error: 'Choose who, or Everyone.', focus: `${prefix}-everyone` };
  const text = value('text');
  if (kind === 'checkin' && !text) return { error: 'Write the question everyone answers.', focus: `${prefix}-text` };
  return {
    item: {
      title, due, people: everyone ? 'everyone' : people,
      ...(text ? { [kind === 'checkin' ? 'question_md' : 'details_md']: text } : {}),
    },
  };
}

/** "Everyone" switches the people off (and back on). */
export function wireWhoPickers(root, signal) {
  root.addEventListener('change', (event) => {
    const all = event.target.closest('[data-everyone]');
    if (!all) return;
    for (const box of all.closest('[data-who]').querySelectorAll('[data-person]')) box.disabled = all.checked;
  }, { signal });
}

// ---------- sheets

function header(id, label, title) {
  return html`
    <header class="sheet-header">
      <div class="sheet-heading">
        <p class="question-label">${label}</p>
        <h2 class="sheet-title" id="tl-title-${id}" tabindex="-1">${title}</h2>
      </div>
      <button type="button" class="sheet-close" data-action="close" aria-label="Close"></button>
    </header>`;
}

// Organizers: publish a draft, change or delete an item.
function organizerActions(site, item) {
  if (site.me?.organizer !== true) return '';
  return html`
    <div class="item-organizer">
      <p class="item-actions">
        ${item.published ? '' : html`<button type="button" class="button button-primary button-small" data-item-action="publish">Publish</button>`}
        <button type="button" class="button button-small" data-item-action="edit" aria-expanded="false">Edit</button>
        <button type="button" class="link-button link-danger" data-item-action="delete">Delete</button>
        <span class="survey-status" role="status"></span>
      </p>
      ${item.published ? '' : html`<p class="muted small">Draft${item.created_by ? ` by ${item.created_by.replace(/^agent:/, '')}` : ''}: only organizers see it until it’s published.</p>`}
      <form class="item-edit" data-item-edit hidden novalidate>
        ${itemFields(site, item.kind, `edit-${item.id}`, item)}
        <p class="item-actions">
          <button type="submit" class="button button-primary">Save changes</button>
          <button type="button" class="link-button" data-item-action="cancel-edit">Cancel</button>
          <span class="survey-status" role="status"></span>
        </p>
      </form>
    </div>`;
}

export function taskSheet(site, item) {
  const meeting = item.meeting && site.meetings.find((m) => m.id === item.meeting);
  return html`
    <dialog class="sheet tl-sheet" data-sheet="${itemSheetId(item)}" data-item="${item.id}" aria-labelledby="tl-title-${itemSheetId(item)}">
      ${header(itemSheetId(item), kindLabel(item), item.title)}
      <div class="sheet-body">
        <p class="facts">Due ${formatDate(item.due)} · ${whoText(site, item)}</p>
        ${item.details_html ? html`<div class="prose tl-summary">${raw(item.details_html)}</div>` : ''}
        ${meeting ? html`<p class="muted small">Agreed in <a href="${link('m', meeting.id, 'post')}">${meeting.title}${meeting.date ? ` (${formatDate(meeting.date, { weekday: false })})` : ''}</a></p>` : ''}
        ${organizerActions(site, item)}
      </div>
    </dialog>`;
}

export function checkinSheet(site, item) {
  return html`
    <dialog class="sheet tl-sheet" data-sheet="${itemSheetId(item)}" data-item="${item.id}" data-checkin="${item.id}" aria-labelledby="tl-title-${itemSheetId(item)}">
      ${header(itemSheetId(item), kindLabel(item), item.title)}
      <div class="sheet-body">
        ${item.details_html ? html`<div class="prose checkin-question">${raw(item.details_html)}</div>` : ''}
        <p class="facts">Write by ${formatDate(item.due)} · ${whoText(site, item)}</p>
        <div class="checkin" data-checkin-box><p class="muted">Loading…</p></div>
        ${organizerActions(site, item)}
      </div>
    </dialog>`;
}

const suggestionPrefix = (s) => `s-${s.meeting}-${s.key}`;

export function suggestionSheet(site, s) {
  const id = suggestionSheetId(s);
  const plain = plainText(s.what_md).slice(0, 200);
  return html`
    <dialog class="sheet tl-sheet" data-sheet="${id}" data-suggestion="${s.key}" data-meeting="${s.meeting}" aria-labelledby="tl-title-${id}">
      ${header(id, 'Suggested task · organizers', plain)}
      <div class="sheet-body">
        <p class="facts">A next step from <a href="${link('m', s.meeting, 'post')}">${s.meeting_title}</a>${s.people.length ? ` · ${s.people.map((l) => nameOf(site, l)).join(', ')}` : s.owner ? ` · ${s.owner}` : ''} · due ${formatDate(s.due)}</p>
        <p class="muted small">Add it to the timeline as a task (everyone sees it then), or dismiss it.</p>
        <form class="item-edit" data-suggestion-form novalidate>
          ${itemFields(site, 'task', suggestionPrefix(s), { title: plain, due: s.due, people: s.people, everyone: !s.people.length })}
          <p class="item-actions">
            <button type="submit" class="button button-primary">Add to timeline</button>
            <button type="button" class="link-button" data-item-action="dismiss">Dismiss</button>
            <span class="survey-status" role="status"></span>
          </p>
        </form>
      </div>
    </dialog>`;
}

// ---------- behaviour

async function call(client, name, args) {
  let answer;
  try {
    answer = await client.rpc(name, args);
  } catch (err) {
    throw new Error('The backend didn’t answer. Try again.', { cause: err });
  }
  if (answer.error) throw new Error(answer.error.message || 'That didn’t work.');
  return answer.data;
}

const dayText = (iso) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/Zurich', weekday: 'short', day: 'numeric', month: 'short' });

/**
 * Loads a check-in into its sheet: your box, everyone's updates, who hasn't
 * written. The form is drawn once; after saving only the counts and the
 * updates are redrawn, so focus and the status message stay where they are.
 * box.pending: a save still on its way (the timeline waits for it on close).
 */
export async function openCheckin(box, item, { site, client, signal, onChange }) {
  if (!box || !item || !client) return;
  const load = () => call(client, 'get_checkin', { p_course: site.course.id, p_item: item.id });
  let data;
  try {
    data = await load();
  } catch (err) {
    box.innerHTML = String(html`<p class="notice notice-warn">Couldn’t load the updates: ${err.message}</p>`);
    return;
  }
  if (signal?.aborted) return;
  const me = site.me?.login;
  const canWrite = item.published && !data.expired;
  const mineOf = (d) => d.updates.find((u) => u.login === me);
  box.innerHTML = String(html`
    <p class="checkin-count" data-count></p>
    ${canWrite ? html`
      <form class="checkin-form" novalidate>
        <div class="field">
          <label for="ci-${item.id}">Your update</label>
          <textarea id="ci-${item.id}" rows="4" maxlength="4000" class="text-input" placeholder="A few sentences are enough.">${mineOf(data)?.text ?? ''}</textarea>
        </div>
        <div class="survey-actions">
          <button type="submit" class="button button-primary" data-post></button>
          <button type="button" class="link-button" data-remove-update hidden>Remove my update</button>
          <span class="survey-status" role="status"></span>
        </div>
      </form>` : html`<p class="muted small">${data.expired ? 'The updates were deleted 60 days after the due date.' : 'Publish the check-in first; then everyone can write.'}</p>`}
    <div data-updates></div>`);

  function draw(d) {
    const mine = mineOf(d);
    const others = d.updates.filter((u) => u.login !== me);
    box.querySelector('[data-count]').textContent = `${d.written} of ${d.expected} written`;
    const post = box.querySelector('[data-post]');
    if (post) post.textContent = mine ? 'Save changes' : 'Post update';
    const remove = box.querySelector('[data-remove-update]');
    if (remove) remove.hidden = !mine;
    box.querySelector('[data-updates]').innerHTML = String(html`
      ${d.updates.length ? html`
        <h3 class="tl-sheet-h">Updates</h3>
        <ul class="text-answers checkin-updates">${[mine, ...others].filter(Boolean).map((u) => html`
          <li><p class="text-answer">${u.text}</p><p class="muted small">${nameOf(site, u.login)} · ${dayText(u.updated_at)}</p></li>`)}
        </ul>` : ''}
      ${d.not_written.length ? html`<p class="muted small">Not written yet: ${d.not_written.map((l) => nameOf(site, l)).join(', ')}</p>` : ''}`);
  }
  draw(data);

  const form = box.querySelector('.checkin-form');
  const status = form?.querySelector('.survey-status');
  const save = (text) => {
    onChange(); // the line is redrawn when the sheet closes, even if this is still saving
    status.textContent = 'Saving…';
    box.pending = (async () => {
      try {
        await call(client, 'save_checkin_update', { p_course: site.course.id, p_item: item.id, p_text: text });
        if (!text) form.querySelector('textarea').value = '';
        if (!signal?.aborted) draw(await load());
        status.textContent = text ? 'Saved' : 'Removed';
        if (!text) form.querySelector('textarea').focus();
      } catch (err) {
        status.textContent = `Not saved: ${err.message}`;
      }
    })();
    return box.pending;
  };
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = form.querySelector('textarea').value.trim();
    if (!text) {
      status.textContent = 'Write something first (or “Remove my update”).';
      form.querySelector('textarea').focus();
      return;
    }
    save(text);
  }, { signal });
  box.querySelector('[data-remove-update]')?.addEventListener('click', () => save(''), { signal });
}

/**
 * Organizers' actions in item and suggestion sheets (one listener on the
 * timeline). `done()` closes the sheet and redraws the line.
 */
export function wireItemActions(root, { site, client, reload, signal }) {
  const course = site.course.id;
  // Does `work`, closes the sheet, redraws the line in place, puts focus on
  // `focus(result)` (a selector) and announces `message`.
  async function act(sheet, say, work, { focus, message }) {
    say.textContent = 'Saving…';
    try {
      const result = await work();
      sheet.close();
      await reload({ keepView: true, focus: focus(result) });
      announce(message);
    } catch (err) {
      say.textContent = err.message;
    }
  }
  const topStatus = (sheet) => sheet.querySelector('.item-organizer > .item-actions .survey-status');
  const rowOf = (id) => `[data-open="item-${CSS.escape(id)}"]`;
  const showError = (form, read) => {
    form.querySelector('.survey-status').textContent = read.error;
    form.querySelector(`#${CSS.escape(read.focus)}`)?.focus();
  };

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-item-action]');
    if (!button) return;
    const sheet = button.closest('dialog');
    const id = sheet?.dataset.item;
    const action = button.dataset.itemAction;
    if (action === 'publish') {
      return act(sheet, topStatus(sheet), () => call(client, 'publish_item', { p_course: course, p_item: id }),
        { focus: () => rowOf(id), message: 'Published.' });
    }
    if (action === 'edit' || action === 'cancel-edit') {
      const form = sheet.querySelector('[data-item-edit]');
      form.hidden = action === 'cancel-edit';
      sheet.querySelector('[data-item-action="edit"]')?.setAttribute('aria-expanded', String(!form.hidden));
      if (!form.hidden) form.querySelector('input')?.focus();
      else sheet.querySelector('[data-item-action="edit"]')?.focus();
      return undefined;
    }
    if (action === 'delete') {
      if (button.dataset.confirm !== 'yes') {
        button.dataset.confirm = 'yes';
        button.textContent = sheet.dataset.checkin ? 'Delete it and everyone’s updates?' : 'Really delete?';
        return undefined;
      }
      return act(sheet, topStatus(sheet), () => call(client, 'delete_item', { p_course: course, p_item: id }),
        { focus: () => 'h1', message: 'Deleted.' });
    }
    if (action === 'dismiss') {
      return act(sheet, sheet.querySelector('[data-suggestion-form] .survey-status'), () => call(client, 'dismiss_suggestion', {
        p_course: course, p_meeting: sheet.dataset.meeting, p_key: sheet.dataset.suggestion,
      }), { focus: () => 'h1', message: 'Suggestion dismissed.' });
    }
    return undefined;
  }, { signal });

  // An armed "Really delete?" is disarmed when its sheet closes.
  for (const sheet of root.querySelectorAll('dialog.tl-sheet')) {
    sheet.addEventListener('close', () => {
      const del = sheet.querySelector('[data-item-action="delete"][data-confirm="yes"]');
      if (del) {
        delete del.dataset.confirm;
        del.textContent = 'Delete';
      }
    }, { signal });
  }

  root.addEventListener('submit', (event) => {
    const form = event.target;
    const sheet = form.closest('dialog');
    if (form.matches('[data-item-edit]')) {
      event.preventDefault();
      const item = site.items.find((i) => i.id === sheet.dataset.item);
      const read = readItemFields(form, item.kind, `edit-${item.id}`);
      if (read.error) return showError(form, read);
      return act(sheet, form.querySelector('.survey-status'),
        () => call(client, 'update_item', { p_course: course, p_item: item.id, p_fields: read.item }),
        { focus: () => rowOf(item.id), message: 'Saved.' });
    }
    if (form.matches('[data-suggestion-form]')) {
      event.preventDefault();
      const s = (site.suggestions ?? []).find((x) => x.key === sheet.dataset.suggestion && x.meeting === sheet.dataset.meeting);
      const read = readItemFields(form, 'task', suggestionPrefix(s));
      if (read.error) return showError(form, read);
      form.querySelector('[type="submit"]').disabled = true;
      return act(sheet, form.querySelector('.survey-status'), () => call(client, 'add_suggested_task', {
        p_course: course, p_meeting: s.meeting, p_key: s.key, p_item: read.item,
      }), { focus: (added) => rowOf(added.id), message: 'Added to the timeline.' })
        .finally(() => { form.querySelector('[type="submit"]').disabled = false; });
    }
    return undefined;
  }, { signal });
}

/** The subtitle of an item on the line. */
export function itemSubtitle(site, item) {
  if (item.kind === 'checkin') return `${whoText(site, item)} · ${item.written} of ${item.expected} written`;
  return whoText(site, item);
}

