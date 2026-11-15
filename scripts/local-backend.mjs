// A local stand-in for Supabase, for previews only (npm run dev:private).
//
// It runs the real database setup (supabase/migrations) in PGlite and answers
// POST /rest/v1/rpc/<function> like Supabase's API (PostgREST) does, so the
// site and the agent API can be tried without touching a real project.
// Sign-in is pretend: scripts/local-supabase.js sends "Bearer local-user-<GitHub id>".
//
// Pretend people: 1001 you-in-preview (organizer), 1002 teammate-in-preview
// (member), 4001 stranger-in-preview (on no team list).

import { readFile } from 'node:fs/promises';
import { setup, actor } from '../test/db-setup.mjs';
import { importCourse } from './import.mjs';

export const LOCAL_USERS = {
  1001: { uid: '00000000-0000-0000-0000-000000000001', login: 'you-in-preview' },
  1002: { uid: '00000000-0000-0000-0000-000000000002', login: 'teammate-in-preview' },
  4001: { uid: '00000000-0000-0000-0000-000000000010', login: 'stranger-in-preview' },
};

const STATUS = { 42501: 403, 42883: 404, PGRST202: 404 };

export async function createLocalBackend({ courseId, courseName, siteUrl, importFrom, exampleFrom, log = console.log }) {
  const db = await setup();
  const as = actor(db);
  await db.query(`insert into auth.identities values ($1, 'github', '4001')`, [LOCAL_USERS[4001].uid]);
  await db.exec('set role owner;');
  await db.query('select private.create_course($1, $2, $3, 1001, $4)', [courseId, courseName, LOCAL_USERS[1001].login, siteUrl]);
  await db.query(`insert into private.members (course_id, github_id, github_login, display_name) values ($1, 1002, $2, 'Teammate')`,
    [courseId, LOCAL_USERS[1002].login]);
  await db.exec('reset role;');

  /** Calls public.<name>(args) as Supabase would; returns { status, body }. */
  async function rpc(name, args, { githubId = null, agentKey = null } = {}) {
    const fn = await db.query(
      `select p.proretset, p.prorettype = 'void'::regtype as void, coalesce(p.proargnames, '{}') as names
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1`, [name]);
    if (fn.rows.length !== 1) {
      return { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
    }
    const { proretset, void: isVoid, names } = fn.rows[0];
    const keys = Object.keys(args ?? {});
    const unknown = keys.find((k) => !names.includes(k));
    if (unknown) return { status: 404, body: { code: 'PGRST202', message: `public.${name} has no parameter ${unknown}` } };
    const values = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    const call = `public.${name}(${keys.map((k, i) => `"${k}" => $${i + 1}`).join(', ')})`;
    const user = githubId ? LOCAL_USERS[githubId] : null;
    const role = user ? 'authenticated' : 'anon';
    try {
      const rows = await as(role, proretset ? `select * from ${call}` : `select ${call} as r`, values,
        user?.uid ?? '', agentKey ? { 'x-agent-key': agentKey } : null);
      return { status: isVoid ? 204 : 200, body: isVoid ? null : proretset ? rows : rows[0].r };
    } catch (err) {
      const code = String(err.code ?? '');
      const status = /^PT\d{3}$/.test(code) ? Number(code.slice(2)) : STATUS[code] === 403 && !user ? 401 : STATUS[code] ?? 400;
      return { status, body: { code, message: err.message, details: null, hint: null } };
    }
  }

  if (importFrom) {
    // The import uses the agent API, like the real import, with a key the
    // pretend organizer creates.
    const created = await rpc('create_agent_key', { p_course: courseId, p_label: 'Import (preview)', p_permission: 'write' }, { githubId: 1001 });
    if (created.status !== 200) throw new Error(`could not create a preview key: ${created.body?.message}`);
    const agentKey = created.body;
    const call = async (name, args) => {
      const r = await rpc(name, args, { agentKey });
      if (r.status >= 300) {
        const err = new Error(`${name}: HTTP ${r.status}: ${r.body?.message}`);
        err.status = r.status;
        throw err;
      }
      return r.body;
    };
    for (const line of await importCourse({ contentDir: importFrom, call })) log(`  imported ${line}`);
    await db.exec(`update private.meetings set published = true where course_id = '${courseId.replace(/'/g, "''")}'`);
    await db.query(`select private.refresh_meeting($1, id) from private.meetings where course_id = $1`, [courseId]);
  }

  if (exampleFrom) {
    for (const line of await addExample({ db, as, rpc, courseId, file: exampleFrom })) log(`  example: ${line}`);
  }

  /** Node http handler for /rest/v1/rpc/*; returns false if the request isn't for it. */
  async function handle(req, res, pathname) {
    const match = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(pathname);
    if (!match) return false;
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return true;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let args;
    try {
      args = body ? JSON.parse(body) : {};
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'invalid JSON' }));
      return true;
    }
    const bearer = /^Bearer local-user-(\d+)$/.exec(req.headers.authorization ?? '');
    const result = await rpc(match[1], args, {
      githubId: bearer && LOCAL_USERS[bearer[1]] ? Number(bearer[1]) : null,
      agentKey: req.headers['x-agent-key'] ?? null,
    });
    res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(result.body === null ? '' : JSON.stringify(result.body));
    return true;
  }

  return { db, rpc, handle };
}

/**
 * Made-up survey answers from pretend teammates (GitHub ids 2001, 2002, …),
 * then the In-meeting AI summary an agent would write from them, saved
 * through the agent API like OpenClaw would. See demo-private/example-responses.json.
 */
async function addExample({ db, as, rpc, courseId, file }) {
  const example = JSON.parse(await readFile(file, 'utf8'));
  const { meeting } = example;
  const uidOf = (i) => `00000000-0000-0000-0000-0000000020${String(i).padStart(2, '0')}`;
  for (const [i, person] of example.people.entries()) {
    await db.query(`insert into auth.identities values ($1, 'github', $2)`, [uidOf(i), String(2001 + i)]);
    await db.exec('set role owner;');
    await db.query(`insert into private.members (course_id, github_id, github_login, display_name) values ($1, $2, $3, $4)`,
      [courseId, 2001 + i, person.login, person.name]);
    await db.exec('reset role;');
    for (const [question, answer] of Object.entries(example.answers[person.login] ?? {})) {
      if (answer === 'skip') {
        await as('authenticated', 'select public.skip_question($1, $2, $3)', [courseId, meeting, question], uidOf(i));
      } else {
        await as('authenticated', 'select public.save_answer($1, $2, $3, $4)', [courseId, meeting, question, JSON.stringify(answer)], uidOf(i));
      }
    }
  }
  const key = await rpc('create_agent_key', { p_course: courseId, p_label: 'OpenClaw (example)', p_permission: 'write' }, { githubId: 1001 });
  const agentKey = key.body;
  const current = (await rpc('agent_get_meeting', { meeting }, { agentKey })).body;
  const content = current.in?.content ?? { items: [] };
  const summaries = example.summary.questions;
  const items = content.items.map((item) => (item.question && summaries[item.question] ? { ...item, ...summaries[item.question] } : item));
  const saved = await rpc('agent_put_section', {
    meeting, part: 'in', base_version: current.in?.version ?? 0,
    content: { ...content, intro_md: example.summary.intro_md, items }, note: 'AI summary (example)',
  }, { agentKey });
  if (saved.status !== 200) throw new Error(`example summary: HTTP ${saved.status}: ${saved.body?.message}`);
  const lines = [`${example.people.length} teammates answered the survey of ${meeting}`, 'wrote the In-meeting AI summary as "OpenClaw (example)"'];

  // Tasks and written check-ins (v0.9.0).
  const t = example.timeline;
  if (t) {
    const ok = (r, what) => {
      if (r.status >= 300) throw new Error(`example ${what}: HTTP ${r.status}: ${r.body?.message}`);
      return r.body;
    };
    const uidOfLogin = (login) => uidOf(example.people.findIndex((p) => p.login === login));
    for (const task of t.tasks ?? []) {
      ok(await rpc('add_item', { p_course: courseId, p_kind: 'task', p_item: task }, { githubId: 1001 }), 'task');
    }
    for (const { updates = {}, ...checkin } of t.checkins ?? []) {
      const added = ok(await rpc('add_item', { p_course: courseId, p_kind: 'checkin', p_item: checkin }, { githubId: 1001 }), 'check-in');
      for (const [login, text] of Object.entries(updates)) {
        await as('authenticated', 'select public.save_checkin_update($1, $2, $3)', [courseId, added.id, text], uidOfLogin(login));
      }
    }
    for (const draft of t.drafts ?? []) {
      ok(await rpc('agent_create_task', { title: draft.title, due: draft.due, details_md: draft.details_md ?? null }, { agentKey }), 'draft');
    }
    if (t.next_steps?.length) {
      const m = ok(await rpc('agent_get_meeting', { meeting: t.next_steps_meeting }, { agentKey }), 'meeting');
      ok(await rpc('agent_put_section', {
        meeting: t.next_steps_meeting, part: 'post', base_version: m.post?.version ?? 0,
        content: { ...(m.post?.content ?? {}), next_steps: [...(m.post?.content?.next_steps ?? []), ...t.next_steps] },
        note: 'next steps (example)',
      }, { agentKey }), 'next steps');
    }
    lines.push(`added ${(t.tasks ?? []).length} tasks, ${(t.checkins ?? []).length} check-in, ${(t.drafts ?? []).length} agent draft and ${(t.next_steps ?? []).length} next steps (suggested tasks)`);
  }
  return lines;
}
