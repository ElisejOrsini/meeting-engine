#!/usr/bin/env node
// Talk to the course's backend (Supabase) from GitHub Actions.
//
//   node build/backend.mjs sync --content <folder>       copy the team list (members:) to the backend
//   node build/backend.mjs keepalive --content <folder>  record a heartbeat, so a free project isn't paused
//
// `sync` runs in the deploy job (see sync/action.yml): it copies the team list
// and each meeting's survey settings. It needs:
//   SUPABASE_SECRET_KEY   the project's secret key (a GitHub environment secret)
//   SUPABASE_URL          the project URL, written in the workflow. The secret
//                         key is only sent there, and course.yml must agree.
//   GITHUB_REPOSITORY_ID, GITHUB_REPOSITORY, GITHUB_REF_NAME   set by GitHub
//                         Actions; the course is tied to this repository
//   GITHUB_TOKEN          with "actions: read", to check that the github-pages
//                         environment (which holds the secret) only allows this
//                         branch, and to look up GitHub accounts
// `keepalive` only uses the publishable key from course.yml.
// If course.yml has no `backend:` section, both commands do nothing.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadContent, safeLogText } from './content.mjs';

const SECRET_KEY_PATTERN = /^sb_secret_[A-Za-z0-9_-]{10,}$/;
const ENVIRONMENT = 'github-pages';

function githubHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'meeting-engine',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** Messages from GitHub or Supabase can contain anything; keep them short and safe to log. */
function oneLine(text) {
  return safeLogText(String(text ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 300));
}

/**
 * Turn GitHub usernames into { github_id, github_login }. The numeric id is
 * what the backend checks: it never changes, while a username can be renamed
 * and later taken by someone else.
 */
export async function resolveMembers(logins, { fetch = globalThis.fetch, token } = {}) {
  const members = [];
  const problems = [];
  for (const login of logins) {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      redirect: 'error',
      headers: githubHeaders(token),
    });
    if (response.status === 404) {
      problems.push(`members: there is no GitHub account "${login}" (check the spelling; `
        + 'if the person renamed their GitHub account, put the new username here)');
      continue;
    }
    if (!response.ok) {
      throw new Error(`GitHub didn't answer the lookup of "${login}" (HTTP ${response.status}); try again later`);
    }
    const user = await response.json();
    if (user.type !== 'User' || !Number.isSafeInteger(user.id) || user.id <= 0) {
      problems.push(`members: "${login}" is not a personal GitHub account (it is a ${oneLine(user.type) || 'different kind of account'})`);
      continue;
    }
    members.push({ github_id: user.id, github_login: oneLine(user.login) });
  }
  return { members, problems };
}

/**
 * The secret key lives in the github-pages environment. Before using it,
 * check that this environment only runs for `branch` (the one deploying now),
 * so workflows on other branches can't read the key. Throws if it doesn't.
 */
export async function checkEnvironment({ repo, branch, token, fetch = globalThis.fetch }) {
  const FIX = `In the repository: Settings → Environments → ${ENVIRONMENT} → Deployment branches and tags → `
    + `Selected branches and tags → Add deployment branch or tag rule → Ref type: Branch, Name pattern: ${branch} → `
    + 'Add rule, and remove any other rule. Then re-run this workflow.';
  const base = `https://api.github.com/repos/${repo}/environments/${ENVIRONMENT}`;
  const get = async (url) => {
    const response = await fetch(url, { redirect: 'error', headers: githubHeaders(token) });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`the sync could not read the ${ENVIRONMENT} environment's settings (HTTP ${response.status}). `
        + 'Add "actions: read" to the permissions of the deploy job (see docs/backend-setup.md, step 7).');
    }
    if (response.status === 404) {
      throw new Error(`this repository has no ${ENVIRONMENT} environment. The deploy job must use `
        + `"environment: ${ENVIRONMENT}" and keep SUPABASE_SECRET_KEY there (see docs/backend-setup.md).`);
    }
    if (!response.ok) throw new Error(`GitHub didn't answer (HTTP ${response.status}); try again later`);
    return response.json();
  };
  const policy = (await get(base)).deployment_branch_policy;
  if (!policy) {
    throw new Error(`the ${ENVIRONMENT} environment lets every branch use its secret, so the key was not used. ${FIX}`);
  }
  if (!policy.custom_branch_policies) {
    throw new Error(`the ${ENVIRONMENT} environment allows "protected branches", which can mean every branch. ${FIX}`);
  }
  const rules = (await get(`${base}/deployment-branch-policies?per_page=100`)).branch_policies ?? [];
  const others = rules.filter((r) => (r.type ?? 'branch') !== 'branch' || r.name !== branch);
  if (!rules.length || others.length) {
    const listed = rules.map((r) => oneLine(`${r.type ?? 'branch'} ${r.name}`)).join(', ') || 'none';
    throw new Error(`the ${ENVIRONMENT} environment must allow only the branch "${branch}" (it allows: ${listed}). ${FIX}`);
  }
}

const PAUSED_HINT = ' The project may be paused: open it in the Supabase dashboard and restore it.';

async function callRpc(url, key, name, body, fetch) {
  let response;
  try {
    response = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      // Never follow a redirect: the key must not be sent anywhere else.
      redirect: 'error',
      // New-style keys go in the apikey header only (they are not JWTs).
      headers: { apikey: key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`could not reach ${url} (${oneLine(err.cause?.message ?? err.message)}).${PAUSED_HINT}`);
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).message ?? text;
    } catch {
      // not JSON
    }
    let hint = '';
    if (response.status === 401) {
      hint = name === 'keepalive'
        ? ' Check backend.publishable_key in course.yml.'
        : ' Check that the SUPABASE_SECRET_KEY secret is the current secret key of this project.';
    }
    if (response.status === 404) hint = ' Has the database setup (supabase/migrations) been run in the SQL Editor?';
    if (response.status >= 500) hint = PAUSED_HINT;
    throw new Error(`the backend refused "${name}" (HTTP ${response.status}): ${oneLine(detail)}.${hint}`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`the backend's answer to "${name}" was not valid JSON.${PAUSED_HINT}`);
  }
}

/** Meeting ids from the backend's answer (only well-formed ones). */
function keptAnonymous(value) {
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) : [];
}

/** A count from the backend's answer, or "?" if it isn't a plain number. */
function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : '?';
}

/** Run one command. Returns a list of lines to print; throws on failure. */
export async function run(command, { contentDir, env = process.env, fetch = globalThis.fetch }) {
  const content = await loadContent(contentDir);
  if (content.errors.length) {
    throw new Error(`${content.errors.length} problem(s) in the content; run the build or check first:\n${content.errors.join('\n')}`);
  }
  const { backend } = content.site;
  if (!backend) return ['course.yml has no backend section; nothing to do.'];
  if (content.site.private && command === 'sync') {
    return ['This is a private course: its team list and meetings are managed on the site; nothing to copy.'];
  }

  if (command === 'keepalive') {
    const at = await callRpc(backend.url, backend.publishable_key, 'keepalive', {}, fetch);
    return [`Heartbeat recorded at ${oneLine(at)} for ${backend.url}.`];
  }
  if (command !== 'sync') throw new Error(`unknown command "${command}" (use sync or keepalive)`);

  const secretKey = env.SUPABASE_SECRET_KEY ?? '';
  if (!secretKey) {
    throw new Error('course.yml has a backend section, but the SUPABASE_SECRET_KEY secret is missing. '
      + 'Add it as an environment secret of the github-pages environment '
      + '(Settings → Environments → github-pages; see docs/backend-setup.md).');
  }
  if (!SECRET_KEY_PATTERN.test(secretKey)) {
    throw new Error('SUPABASE_SECRET_KEY must be a Supabase secret key (it starts with sb_secret_).');
  }
  // The workflow, not the content, says where the secret key may go.
  const allowedUrl = (env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!allowedUrl) {
    throw new Error('supabase-url is missing: give the sync step the Supabase Project URL (see docs/backend-setup.md).');
  }
  if (allowedUrl !== backend.url) {
    throw new Error(`course.yml's backend.url (${backend.url}) is not the project this workflow allows (${oneLine(allowedUrl)}). `
      + 'The secret key was not sent. Fix whichever of the two is wrong.');
  }
  const repoId = Number(env.GITHUB_REPOSITORY_ID);
  if (!Number.isSafeInteger(repoId) || repoId <= 0 || !env.GITHUB_REPOSITORY || !env.GITHUB_REF_NAME) {
    throw new Error('GITHUB_REPOSITORY_ID is missing; the sync only runs inside GitHub Actions.');
  }
  await checkEnvironment({ repo: env.GITHUB_REPOSITORY, branch: env.GITHUB_REF_NAME, token: env.GITHUB_TOKEN, fetch });

  const { members, problems } = await resolveMembers(content.members, { fetch, token: env.GITHUB_TOKEN });
  if (problems.length) throw new Error(`course.yml: ${problems.join('; ')}`);
  const result = await callRpc(backend.url, secretKey, 'sync_course', {
    p_course: backend.course_id,
    p_members: members,
    p_repo_id: repoId,
    p_repo_name: oneLine(env.GITHUB_REPOSITORY ?? ''),
  }, fetch);
  const meetings = await callRpc(backend.url, secretKey, 'sync_meetings', {
    p_course: backend.course_id,
    p_repo_id: repoId,
    p_meetings: surveySettings(content.site.meetings),
  }, fetch);
  return [
    `Team list of course "${backend.course_id}" copied to ${backend.url}:`,
    ...members.map((m) => `  ${m.github_login} (GitHub id ${m.github_id})`),
    `${count(result?.members)} member(s): ${count(result?.added)} added, ${count(result?.removed)} removed.`,
    `Survey settings of ${count(meetings?.meetings)} meeting(s) copied; ${count(meetings?.deleted_answers)} answer(s) `
      + 'older than 30 days after their meeting deleted.',
    ...keptAnonymous(meetings?.kept_anonymous).map((id) => `Note: meeting ${id} stays anonymous. Its answers were `
      + 'given under that promise, so names are never shown for it, even though meeting.yml no longer says anonymous: true.'),
  ];
}

/**
 * What the backend needs to know about each meeting to check answers: date
 * (answers are deleted 30 days later), reveal mode, anonymity, and the survey
 * fields of each question.
 */
export function surveySettings(meetings) {
  return meetings.map((m) => ({
    id: m.id,
    date: m.date,
    reveal: m.reveal,
    anonymous: m.anonymous,
    questions: Object.fromEntries(m.questions.filter((q) => q.survey.length).map((q) => [
      q.id,
      q.survey.map((f) => ({ id: f.id, type: f.type, options: f.options, required: f.required })),
    ])),
  }));
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { content: { type: 'string', default: '.' } },
  });
  try {
    for (const line of await run(positionals[0], { contentDir: values.content })) console.log(safeLogText(line));
  } catch (err) {
    // One "error:" line per problem, each made safe for the Actions log.
    for (const line of String(err.message).split('\n')) console.error(`error: ${safeLogText(line)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
