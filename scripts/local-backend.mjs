// A local stand-in for Supabase, for previews only (npm run dev:private).
//
// It runs the real database setup (supabase/migrations) in PGlite and answers
// POST /rest/v1/rpc/<function> like Supabase's API (PostgREST) does, so the
// site and the agent API can be tried without touching a real project.
// Sign-in is pretend: scripts/local-supabase.js sends "Bearer local-user-<GitHub id>".
//
// Pretend people: 1001 you-in-preview (organizer), 1002 teammate-in-preview
// (member), 4001 stranger-in-preview (on no team list).

import { setup, actor } from '../test/db-setup.mjs';
import { importCourse } from './import.mjs';

export const LOCAL_USERS = {
  1001: { uid: '00000000-0000-0000-0000-000000000001', login: 'you-in-preview' },
  1002: { uid: '00000000-0000-0000-0000-000000000002', login: 'teammate-in-preview' },
  4001: { uid: '00000000-0000-0000-0000-000000000010', login: 'stranger-in-preview' },
};

const STATUS = { 42501: 403, 42883: 404, PGRST202: 404 };

export async function createLocalBackend({ courseId, courseName, siteUrl, importFrom, log = console.log }) {
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
