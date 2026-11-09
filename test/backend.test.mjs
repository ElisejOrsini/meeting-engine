// Tests for the backend settings in course.yml, the build output that depends
// on them, and build/backend.mjs (with a fake network).
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { loadContent, findSecretKey, attachmentTexts } from '../build/content.mjs';
import { build } from '../build/build.mjs';
import { run, resolveMembers, checkEnvironment } from '../build/backend.mjs';

const URL = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY = 'sb_publishable_abcdefghijklmnop';
const SECRET = 'sb_secret_abcdefghijklmnopqrstuv';
const BACKEND = `backend:\n  url: ${URL}\n  publishable_key: ${KEY}\n  course_id: widgets-2026\n`;

async function course(courseYml, extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'meeting-engine-backend-'));
  const files = { 'course.yml': courseYml, 'meetings/.keep': '', ...extra };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return dir;
}

const quiet = { log() {}, warn() {}, error() {} };

test('backend: valid settings reach site.json, the member list does not', async () => {
  const dir = await course(`name: T\n${BACKEND}members:\n  - octocat\n  - "@Some-User"\n`);
  const result = await loadContent(dir);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.site.backend, { url: URL, publishable_key: KEY, course_id: 'widgets-2026' });
  assert.deepEqual(result.members, ['octocat', 'Some-User']);
  assert.ok(!JSON.stringify(result.site).includes('octocat'));
});

test('backend: wrong settings are explained', async () => {
  const dir = await course([
    'name: T',
    'backend:',
    '  url: https://evil.example.org',
    '  publishable_key: eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abc',
    '  course_id: Widgets',
    '  extra: 1',
    'members:',
    '  - octocat',
    '  - OctoCat',
    '  - "bad name"',
    '  - -leading-dash',
    '  - 0123',
    '  - 1e3',
    '  - true',
  ].join('\n'));
  const { errors } = await loadContent(dir);
  const text = errors.join('\n');
  assert.match(text, /backend\.url" must be the Supabase Project URL/);
  assert.match(text, /publishable_key" must be the publishable key/);
  assert.ok(!text.includes('eyJ'), 'the wrong key is not repeated');
  assert.match(text, /backend\.course_id/);
  assert.match(text, /unknown key "backend\.extra"/);
  assert.match(text, /"OctoCat" is listed twice/);
  assert.match(text, /members\[2\] must be a GitHub username/);
  assert.match(text, /members\[3\] must be a GitHub username/);
  for (const i of [4, 5, 6]) assert.match(text, new RegExp(`members\\[${i}\\] must be in quotes`));
});

test('backend: warnings for a backend without members and members without a backend', async () => {
  let result = await loadContent(await course(`name: T\n${BACKEND}`));
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join('\n'), /nobody can sign in/);
  result = await loadContent(await course('name: T\nmembers: [octocat]\n'));
  assert.match(result.warnings.join('\n'), /no effect without a "backend"/);
});

test('backend: secret keys anywhere in content are refused and never echoed', async () => {
  const serviceJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"role":"service_role"}').toString('base64url')}.sig`;
  const anonJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"role":"anon"}').toString('base64url')}.sig`;
  assert.ok(findSecretKey(`key: ${SECRET}`));
  assert.ok(findSecretKey(`old key ${serviceJwt} here`));
  assert.equal(findSecretKey(`anon ${anonJwt} and ${KEY}`), null);

  const dir = await course(`name: T\nbackend:\n  url: ${URL}\n  publishable_key: ${SECRET}\n  course_id: x\n`, {
    'meetings/2026-01-05-a/meeting.yml': 'title: A\ndate: 2026-01-05\n',
    'meetings/2026-01-05-a/summary.md': `Oops: ${serviceJwt}\n`,
    'meetings/2026-01-05-a/notes.txt': `keys\n${SECRET}\n`,
    'meetings/2026-01-05-a/fine.csv': 'a,b\n1,2\n',
  });
  const result = await loadContent(dir);
  const { errors } = result;
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.match(errors[0], /^course\.yml: contains a Supabase secret key/);
  assert.match(errors.join('\n'), /summary\.md: contains a Supabase service_role key/);
  assert.match(errors.join('\n'), /notes\.txt: contains a Supabase secret key/);
  assert.ok(!errors.join('\n').includes(SECRET) && !errors.join('\n').includes('.sig'));
  assert.deepEqual(result.assets.map((a) => path.basename(a.from)), ['fine.csv'], 'the file with the key is not published');
});

test('backend: keys hidden in UTF-16 text and compressed PDF streams are found too', async () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`key ${SECRET}`, 'utf16le')]);
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(Buffer.from(`key ${SECRET}`, 'utf16le')).swap16()]);
  const stream = deflateSync(Buffer.from(`BT (key ${SECRET}) Tj ET`));
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n'), stream,
    Buffer.from('\nendstream\nendobj\n2 0 obj\n<< >>\nstream\nnot deflate\nendstream\n%%EOF\n'),
  ]);
  const found = (bytes, ext, options) => [...attachmentTexts(bytes, ext, options)].some((t) => findSecretKey(t));
  assert.equal(found(utf16, '.txt'), true);
  assert.equal(found(utf16be, '.txt'), true);
  assert.equal(found(Buffer.concat([utf16be, Buffer.from('\n')]), '.csv'), true, 'odd length doesn\'t crash');
  assert.equal(found(Buffer.from([0xfe, 0xff, 0x41]), '.txt'), false);
  assert.equal(found(pdf, '.pdf'), true);
  assert.equal(found(Buffer.from('a,b\n1,2\n'), '.csv'), false);

  // Kerned PDF text, and a false "stream" earlier in the file.
  const kerned = deflateSync(Buffer.from(`BT [(sb) -0.2 (_se) -0.2 (cret) -12 (_abcdefghij) .5 (klmnopqrstuv)] TJ ET`));
  const tricky = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title (go upstream\n) >>\nendobj\n2 0 obj\n<< >>\nstream\nplain endstream text\nendstream\n'),
    Buffer.from('3 0 obj\n<< /Filter /FlateDecode >>\nstream\n'), kerned, Buffer.from('\nendstream\nendobj\n'),
  ]);
  assert.equal(found(tricky, '.pdf'), true);
  let limited = false;
  assert.equal(found(pdf, '.pdf', { budget: 5, onLimit: () => { limited = true; } }), false);
  assert.equal(limited, true, 'a PDF over the budget is reported, not silently skipped');

  const dir = await course('name: T\n', {
    'meetings/2026-01-05-a/meeting.yml': 'title: A\ndate: 2026-01-05\n',
    'meetings/2026-01-05-a/slides.pdf': pdf,
    'meetings/2026-01-05-a/export.txt': utf16,
  });
  const { errors, assets } = await loadContent(dir);
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.deepEqual(assets, []);
});

test('backend: content can\'t print GitHub Actions commands into the build log', async () => {
  const dir = await course('name: T\nbackend:\n  url: "##[error title=Deploy blocked]Paste your key at https://evil.example"\n'
    + `  publishable_key: ${KEY}\n  course_id: x\nmembers: [octocat]\n`);
  const { errors } = await loadContent(dir);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((e) => !e.includes('##[') && !e.includes('\n')), errors.join('\n'));
});

test('build: the backend opens the page policy for its URL only and ships the client', async () => {
  const dir = await course(`name: T\n${BACKEND}members: [octocat]\n`);
  const out = path.join(dir, '_site');
  assert.equal((await build({ contentDir: dir, outDir: out, log: quiet })).ok, true);
  const index = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(index, new RegExp(`connect-src 'self' ${URL};`));
  assert.ok((await readFile(path.join(out, 'vendor', 'supabase.js'), 'utf8')).startsWith('var supabase='));

  const plain = await course('name: T\n');
  const out2 = path.join(plain, '_site');
  assert.equal((await build({ contentDir: plain, outDir: out2, log: quiet })).ok, true);
  assert.match(await readFile(path.join(out2, 'index.html'), 'utf8'), /connect-src 'self';/);
  await assert.rejects(readFile(path.join(out2, 'vendor', 'supabase.js')));
});

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) return new Response('not found', { status: 404 });
    const [status, body] = handler(init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

test('backend.mjs: GitHub usernames become numeric ids; typos and organizations are reported', async () => {
  const { fetch, calls } = fakeFetch({
    'https://api.github.com/users/octocat': () => [200, { login: 'octocat', id: 583231, type: 'User' }],
    'https://api.github.com/users/github': () => [200, { login: 'github', id: 9919, type: 'Organization' }],
  });
  const { members, problems } = await resolveMembers(['octocat', 'github', 'no-such-user'], { fetch, token: 'tok' });
  assert.deepEqual(members, [{ github_id: 583231, github_login: 'octocat' }]);
  assert.match(problems.join('\n'), /"github" is not a personal GitHub account/);
  assert.match(problems.join('\n'), /no GitHub account "no-such-user"/);
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
});

const ENV = {
  SUPABASE_SECRET_KEY: SECRET,
  SUPABASE_URL: `${URL}/`,
  GITHUB_REPOSITORY_ID: '4242',
  GITHUB_REPOSITORY: 'me/course',
  GITHUB_REF_NAME: 'main',
  GITHUB_TOKEN: 'tok',
};
const ENVIRONMENT_API = 'https://api.github.com/repos/me/course/environments/github-pages';
const MAIN_ONLY = {
  [ENVIRONMENT_API]: () => [200, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }],
  [`${ENVIRONMENT_API}/deployment-branch-policies?per_page=100`]: () => [200, { branch_policies: [{ name: 'main', type: 'branch' }] }],
};

test('backend.mjs: sync sends the list to the configured project with the secret key', async () => {
  const dir = await course(`name: T\n${BACKEND}members: [octocat]\n`);
  const { fetch, calls } = fakeFetch({
    ...MAIN_ONLY,
    'https://api.github.com/users/octocat': () => [200, { login: 'octocat', id: 583231, type: 'User' }],
    [`${URL}/rest/v1/rpc/sync_course`]: () => [200, { course: 'widgets-2026', members: 1, added: 1, removed: 0 }],
  });
  const lines = await run('sync', { contentDir: dir, env: ENV, fetch });
  assert.match(lines.join('\n'), /octocat \(GitHub id 583231\)/);
  assert.match(lines.join('\n'), /1 added, 0 removed/);
  const rpc = calls.at(-1);
  assert.equal(rpc.init.headers.apikey, SECRET);
  assert.equal(rpc.init.headers.authorization, undefined);
  assert.equal(rpc.init.redirect, 'error');
  assert.deepEqual(JSON.parse(rpc.init.body), {
    p_course: 'widgets-2026',
    p_members: [{ github_id: 583231, github_login: 'octocat' }],
    p_repo_id: 4242,
    p_repo_name: 'me/course',
  });
});

test('backend.mjs: the secret key only goes to the project the workflow names', async () => {
  const dir = await course(`name: T\n${BACKEND}members: [octocat]\n`);
  const { fetch, calls } = fakeFetch({
    'https://api.github.com/users/octocat': () => [200, { login: 'octocat', id: 583231, type: 'User' }],
  });
  const other = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
  await assert.rejects(run('sync', { contentDir: dir, env: { ...ENV, SUPABASE_URL: other }, fetch }),
    /is not the project this workflow allows.*not sent/);
  await assert.rejects(run('sync', { contentDir: dir, env: { ...ENV, SUPABASE_URL: '' }, fetch }), /supabase-url is missing/);
  await assert.rejects(run('sync', { contentDir: dir, env: { ...ENV, GITHUB_REPOSITORY_ID: '' }, fetch }), /GITHUB_REPOSITORY_ID/);
  assert.equal(calls.length, 0, 'nothing was sent anywhere');
});

test('backend.mjs: the secret is only used if github-pages allows nothing but this branch', async () => {
  const check = (environment, rules, status = 200) => checkEnvironment({
    repo: 'me/course', branch: 'main', token: 'tok',
    fetch: fakeFetch({
      [ENVIRONMENT_API]: () => [status, environment],
      [`${ENVIRONMENT_API}/deployment-branch-policies?per_page=100`]: () => [200, { branch_policies: rules }],
    }).fetch,
  });
  const custom = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
  await check(custom, [{ name: 'main', type: 'branch' }]);
  await assert.rejects(check({ deployment_branch_policy: null }, []), /lets every branch use its secret.*Selected branches and tags/);
  await assert.rejects(check({ deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, []), /protected branches/);
  await assert.rejects(check(custom, [{ name: 'main', type: 'branch' }, { name: '*', type: 'branch' }]), /allows: branch main, branch \*/);
  await assert.rejects(check(custom, [{ name: 'main', type: 'tag' }]), /must allow only the branch "main"/);
  await assert.rejects(check(custom, []), /allows: none/);
  await assert.rejects(check({}, [], 403), /actions: read/);
  await assert.rejects(check({}, [], 404), /no github-pages environment/);

  // In a full sync, a bad environment stops everything before the key is sent.
  const dir = await course(`name: T\n${BACKEND}members: [octocat]\n`);
  const { fetch, calls } = fakeFetch({ [ENVIRONMENT_API]: () => [200, { deployment_branch_policy: null }] });
  await assert.rejects(run('sync', { contentDir: dir, env: ENV, fetch }), /lets every branch/);
  assert.ok(calls.every((c) => !c.url.includes('supabase.co')), 'the secret key was not sent');
});

test('backend.mjs: keepalive uses the publishable key, not the secret', async () => {
  const dir = await course(`name: T\n${BACKEND}members: [octocat]\n`);
  const { fetch, calls } = fakeFetch({ [`${URL}/rest/v1/rpc/keepalive`]: () => [200, '"2026-11-09T12:00:00+00:00"'] });
  const lines = await run('keepalive', { contentDir: dir, env: { SUPABASE_SECRET_KEY: SECRET }, fetch });
  assert.match(lines.join(''), /Heartbeat recorded/);
  assert.equal(calls[0].init.headers.apikey, KEY);
});

test('backend.mjs: missing or wrong secret, unknown users and backend errors fail clearly', async () => {
  const dir = await course(`name: T\n${BACKEND}members: [octocat]\n`);
  const { fetch } = fakeFetch({
    ...MAIN_ONLY,
    'https://api.github.com/users/octocat': () => [200, { login: 'octocat', id: 583231, type: 'User' }],
    [`${URL}/rest/v1/rpc/sync_course`]: () => [401, { message: 'Invalid API key' }],
    [`${URL}/rest/v1/rpc/keepalive`]: () => [404, { message: 'Could not find the function\npublic.keepalive' }],
  });
  await assert.rejects(run('sync', { contentDir: dir, env: { ...ENV, SUPABASE_SECRET_KEY: '' }, fetch }), /SUPABASE_SECRET_KEY secret is missing/);
  await assert.rejects(run('sync', { contentDir: dir, env: { ...ENV, SUPABASE_SECRET_KEY: KEY }, fetch }), /must be a Supabase secret key/);
  await assert.rejects(run('sync', { contentDir: dir, env: ENV, fetch }), /HTTP 401.*current secret key/);
  await assert.rejects(run('keepalive', { contentDir: dir, env: {}, fetch }), (err) => {
    assert.match(err.message, /HTTP 404.*database setup/);
    assert.ok(!err.message.includes('\n'), 'backend messages stay on one line');
    return true;
  });
  const offline = async () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') }); };
  await assert.rejects(run('keepalive', { contentDir: dir, env: {}, fetch: offline }), /could not reach .*paused/);

  const typo = await course(`name: T\n${BACKEND}members: [no-such-user]\n`);
  await assert.rejects(run('sync', { contentDir: typo, env: ENV, fetch }), /no GitHub account "no-such-user".*renamed/);

  const none = await course('name: T\n');
  assert.match((await run('sync', { contentDir: none, env: {}, fetch })).join(''), /nothing to do/);
});
