// Load a content folder (course.yml + meetings/*/) into one data object,
// validating everything on the way. All problems are collected and reported
// together, each with the file it came from, so a person or an agent can fix
// them in one pass.
//
// The file formats are documented in docs/content-format.md. Keep that file in
// sync with the rules below.

import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { load, CORE_SCHEMA } from 'js-yaml';
import { createMarkdown } from './markdown.mjs';

export const ASSET_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.csv', '.txt',
]);
const MEETING_FILES = ['meeting.yml', 'background.md', 'prereading.md', 'guide.md', 'summary.md', 'decisions.yml'];

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID_HINT = 'must be lowercase letters and digits, separated by single dashes (like "grace-period")';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const FIELD_TYPES = ['single', 'multiple', 'text'];
const REVEAL_MODES = ['anytime', 'after_answering']; // first one is the default

// Supabase settings in course.yml. The URL must be a supabase.co project URL,
// because the deploy workflow sends the secret key there.
const SUPABASE_URL_PATTERN = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/;
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{10,}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

// Heading levels: a "# Heading" in a file becomes <h3> under a section <h2>,
// and <h4> inside a card whose title is <h3>.
const UNDER_SECTION = 2;
const INSIDE_CARD = 3;

class Problems {
  constructor(root) {
    this.root = root;
    this.errors = [];
    this.warnings = [];
  }
  rel(file) {
    return path.relative(this.root, file) || path.basename(file);
  }
  format(file, message) {
    return safeLogText(`${this.rel(file)}: ${message}`);
  }
  error(file, message) {
    const text = this.format(file, message);
    if (!this.errors.includes(text)) this.errors.push(text);
  }
  warn(file, message) {
    const text = this.format(file, message);
    if (!this.warnings.includes(text)) this.warnings.push(text);
  }
}

/**
 * Make text that quotes content (or a server's reply) safe to print in a
 * GitHub Actions log: newlines are escaped, so a value can't start a new line
 * (the runner obeys lines starting with "::"), and "##[" is broken up (the
 * runner's older command syntax works anywhere in a line).
 */
export function safeLogText(text) {
  return String(text)
    .replace(/[\r\n\u2028\u2029]/g, (c) => JSON.stringify(c).slice(1, -1))
    .replaceAll('##[', '# #[');
}

/** File type at `file` without following symlinks, or null if missing. */
async function kindOf(file) {
  try {
    const s = await lstat(file);
    if (s.isSymbolicLink()) return 'symlink';
    if (s.isDirectory()) return 'dir';
    return s.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
}

/**
 * Does `text` contain a Supabase secret key? Checks for new secret keys
 * (sb_secret_...) and old-style service_role keys (JWTs with role
 * "service_role"). Returns a short description, never the key itself.
 */
export function findSecretKey(text) {
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) return 'a Supabase secret key (sb_secret_...)';
  for (const [, payload] of text.matchAll(/eyJ[A-Za-z0-9_-]{5,}\.(eyJ[A-Za-z0-9_-]{5,})\.[A-Za-z0-9_-]+/g)) {
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (claims?.role === 'service_role') return 'a Supabase service_role key';
    } catch {
      // not a JWT after all
    }
  }
  return null;
}

/** Read a text file. Symbolic links are refused so nothing outside the content folder is published. */
async function readText(file, problems) {
  const kind = await kindOf(file);
  if (kind === null) return null;
  if (kind !== 'file') {
    problems.error(file, kind === 'symlink' ? 'symbolic links are not allowed in content' : 'expected a file');
    return null;
  }
  const text = await readFile(file, 'utf8');
  if (reportSecretKey(text, file, problems)) return null;
  return text;
}

/**
 * The texts in an attachment to check for keys, one at a time: the raw bytes,
 * UTF-16 text (e.g. Excel's "Unicode Text"), and the compressed streams of a
 * PDF, where most PDF writers keep the page text (with kerned text pieces
 * joined). Images and PDF text drawn with embedded-font codes can't be checked.
 * Calls onLimit() and stops if a PDF inflates to more than `budget` bytes.
 */
export function* attachmentTexts(bytes, extension, { budget = 256 * 1024 * 1024, onLimit = () => {} } = {}) {
  const raw = bytes.toString('latin1');
  yield raw;
  const bom = bytes.subarray(0, 2).toString('hex');
  let nulOdd = 0;
  for (let i = 1; i < Math.min(bytes.length, 4096); i += 2) if (bytes[i] === 0) nulOdd += 1;
  const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
  if (bom === 'fffe' || nulOdd > 64) yield even.toString('utf16le');
  if (bom === 'feff') yield Buffer.from(even).swap16().toString('utf16le');
  if (extension !== '.pdf') return;
  // "stream" right after a non-letter, so "endstream" or "upstream" don't count.
  const marker = /(?<![A-Za-z])stream\r?\n/g;
  let used = 0;
  for (let m = marker.exec(raw); m; m = marker.exec(raw)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) return;
    marker.lastIndex = end + 'endstream'.length;
    let text;
    try {
      text = inflateSync(bytes.subarray(start, end), { maxOutputLength: 64 * 1024 * 1024 }).toString('latin1');
    } catch {
      continue; // not a Flate stream (or too large): nothing to read
    }
    used += text.length;
    if (used > budget) {
      onLimit();
      return;
    }
    yield text;
    // Kerned text is written as [(sb) -0.2 (_se) -0.2 (cret)] TJ: join the pieces.
    if (text.includes('TJ')) yield text.replace(/\)\s*-?(?:\d+\.?\d*|\.\d+)\s*\(/g, '');
  }
}

/** Report a secret key in `texts` (a string or an iterable of strings; never the key itself). Returns true if one was found. */
function reportSecretKey(texts, file, problems) {
  let secret = null;
  for (const text of typeof texts === 'string' ? [texts] : texts) {
    secret = findSecretKey(text);
    if (secret) break;
  }
  if (!secret) return false;
  problems.error(file, `contains ${secret}. Secret keys must never be in content files or attachments, `
    + 'because the repository and the website are public. Remove it. If it was ever committed or pushed, '
    + 'also delete that key in Supabase (Settings → API Keys) and create a new one.');
  return true;
}

/** undefined = file missing, null = file broken (already reported), otherwise the parsed value. */
async function readYaml(file, problems) {
  const text = await readText(file, problems);
  if (text === null) return (await kindOf(file)) === null ? undefined : null;
  // A file with only comments/whitespace counts as empty.
  if (!text.replace(/^\s*#.*$/gm, '').trim()) return {};
  try {
    // CORE_SCHEMA: dates stay strings, "yes"/"no" stay strings.
    return load(text, { schema: CORE_SCHEMA, filename: file }) ?? {};
  } catch (err) {
    problems.error(file, `invalid YAML: ${err.message}`);
    return null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRealDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

const QUOTE_HINT = 'put it in quotes if it contains ": " or starts with a special character';

/** Small helper for checking one YAML object against expected keys. */
function checker(problems, file, where) {
  const at = (key) => (where ? `${where}.${key}` : key);
  return {
    keys(obj, allowed) {
      for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) {
          problems.error(file, `unknown key "${at(key)}" (allowed: ${allowed.join(', ')})`);
        }
      }
    },
    string(obj, key, { required = false, pattern, patternHint } = {}) {
      let value = obj[key];
      if (value === undefined || value === null || value === '') {
        if (required) problems.error(file, `"${at(key)}" is required`);
        return undefined;
      }
      if (typeof value === 'number' || typeof value === 'boolean') value = String(value);
      if (typeof value !== 'string') {
        problems.error(file, `"${at(key)}" must be plain text (${QUOTE_HINT})`);
        return undefined;
      }
      if (pattern && !pattern.test(value)) {
        problems.error(file, `"${at(key)}" ${patternHint ?? `must match ${pattern}`} (got "${value}")`);
        return undefined;
      }
      return value;
    },
    minutes(obj, key, { min = 0 } = {}) {
      const value = obj[key];
      if (value === undefined || value === null) return undefined;
      if (!Number.isInteger(value) || value < min) {
        problems.error(file, `"${at(key)}" must be a whole number of minutes, at least ${min} (got ${JSON.stringify(value)})`);
        return undefined;
      }
      return value;
    },
    list(obj, key) {
      const value = obj[key];
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) {
        problems.error(file, `"${at(key)}" must be a list`);
        return [];
      }
      return value;
    },
    object(obj, key) {
      const value = obj[key];
      if (value === undefined || value === null) return {};
      if (!isObject(value)) {
        problems.error(file, `"${at(key)}" must be a mapping (key: value pairs)`);
        return {};
      }
      return value;
    },
  };
}

const DEFAULT_COURSE = { name: 'Meetings', description_html: '', links: [] };
const NO_COURSE = { course: DEFAULT_COURSE, backend: null, members: [] };

/** The optional `backend:` section: where sign-in and survey answers live. */
function loadBackend(raw, file, problems) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) {
    problems.error(file, '"backend" must be a mapping with url, publishable_key and course_id');
    return null;
  }
  const c = checker(problems, file, 'backend');
  c.keys(raw, ['url', 'publishable_key', 'course_id']);
  const url = c.string(
    { url: typeof raw.url === 'string' ? raw.url.trim().replace(/\/+$/, '') : raw.url }, 'url',
    { required: true, pattern: SUPABASE_URL_PATTERN, patternHint: 'must be the Supabase Project URL, like https://abcdefghijklmnopqrst.supabase.co' },
  );
  // Checked by hand, so a wrong key is never repeated in the error message.
  let key = raw.publishable_key;
  if (key === undefined || key === null || key === '') {
    problems.error(file, '"backend.publishable_key" is required');
    key = undefined;
  } else if (typeof key !== 'string' || !PUBLISHABLE_KEY_PATTERN.test(key)) {
    if (typeof key !== 'string' || !findSecretKey(key)) { // secret keys are already reported
      problems.error(file, '"backend.publishable_key" must be the publishable key, which starts with sb_publishable_ '
        + '(Supabase dashboard: Settings → API Keys)');
    }
    key = undefined;
  }
  const courseId = c.string(raw, 'course_id', { required: true, pattern: ID_PATTERN, patternHint: ID_HINT });
  return url && key && courseId ? { url, publishable_key: key, course_id: courseId } : null;
}

/** The optional `members:` list: GitHub usernames allowed to sign in. */
function loadMembers(list, file, problems) {
  const seen = new Set();
  return list.map((entry, i) => {
    if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) {
      // YAML reads 0123, 1e3, true or null as values, not names: a different account.
      problems.error(file, `members[${i}] must be in quotes, because YAML reads it as a number or a special value `
        + '(write it like - "0123")');
      return null;
    }
    const name = typeof entry === 'string' ? entry.trim().replace(/^@/, '') : entry;
    if (typeof name !== 'string' || !GITHUB_LOGIN_PATTERN.test(name)) {
      problems.error(file, `members[${i}] must be a GitHub username, like "octocat"`);
      return null;
    }
    if (seen.has(name.toLowerCase())) {
      problems.error(file, `members: "${name}" is listed twice`);
      return null;
    }
    seen.add(name.toLowerCase());
    return name;
  }).filter(Boolean);
}

function loadCourse(raw, file, problems) {
  if (raw === undefined) {
    problems.error(file, 'missing course.yml');
    return NO_COURSE;
  }
  if (raw === null) return NO_COURSE; // already reported
  if (!isObject(raw)) {
    problems.error(file, 'course.yml must be a mapping (key: value pairs)');
    return NO_COURSE;
  }
  const c = checker(problems, file, '');
  c.keys(raw, ['name', 'description', 'links', 'backend', 'members']);
  const backend = loadBackend(raw.backend, file, problems);
  const memberList = c.list(raw, 'members');
  const members = loadMembers(memberList, file, problems);
  if (raw.backend && !memberList.length) {
    problems.warn(file, 'nobody can sign in yet: add the team\'s GitHub usernames under "members"');
  }
  if (!raw.backend && members.length) {
    problems.warn(file, '"members" has no effect without a "backend" section');
  }
  const md = createMarkdown();
  const links = c.list(raw, 'links').map((link, i) => {
    if (!isObject(link)) {
      problems.error(file, `links[${i}] must have "title" and "url"`);
      return null;
    }
    const lc = checker(problems, file, `links[${i}]`);
    lc.keys(link, ['title', 'url']);
    const title = lc.string(link, 'title', { required: true });
    const url = lc.string(link, 'url', {
      required: true,
      pattern: /^(https?:\/\/|mailto:)\S+$/,
      patternHint: 'must start with https://, http:// or mailto:',
    });
    return title && url ? { title, url } : null;
  }).filter(Boolean);
  const descriptionHtml = md.block(c.string(raw, 'description'), { headingOffset: 1, source: 'course.yml' });
  for (const { href } of md.fileLinks) problems.error(file, `description links to "${href}"; use a full https:// address`);
  return {
    course: {
      name: c.string(raw, 'name', { required: true }) ?? DEFAULT_COURSE.name,
      description_html: descriptionHtml,
      links,
    },
    backend,
    members,
  };
}

function loadQuestions(list, file, problems, md) {
  const ids = new Set();
  return list.map((q, i) => {
    const where = `questions[${i}]`;
    if (!isObject(q)) {
      problems.error(file, `${where} must be a mapping with at least "id" and "text"`);
      return null;
    }
    const c = checker(problems, file, where);
    c.keys(q, ['id', 'text', 'details', 'survey']);
    const id = c.string(q, 'id', { required: true, pattern: ID_PATTERN, patternHint: ID_HINT });
    if (id && ids.has(id)) problems.error(file, `${where}: duplicate question id "${id}"`);
    if (id) ids.add(id);
    const fieldIds = new Set();
    const survey = c.list(q, 'survey').map((f, j) => {
      const fwhere = `${where}.survey[${j}]`;
      if (!isObject(f)) {
        problems.error(file, `${fwhere} must be a mapping with "id", "type" and "label"`);
        return null;
      }
      const fc = checker(problems, file, fwhere);
      fc.keys(f, ['id', 'type', 'label', 'options', 'required']);
      const fid = fc.string(f, 'id', { required: true, pattern: ID_PATTERN, patternHint: ID_HINT });
      if (fid && fieldIds.has(fid)) problems.error(file, `${fwhere}: duplicate field id "${fid}"`);
      if (fid) fieldIds.add(fid);
      const type = fc.string(f, 'type', { required: true });
      if (type && !FIELD_TYPES.includes(type)) {
        problems.error(file, `${fwhere}.type must be one of ${FIELD_TYPES.join(', ')} (got "${type}")`);
      }
      const label = fc.string(f, 'label', { required: true });
      let options = [];
      if (type === 'single' || type === 'multiple') {
        options = fc.list(f, 'options').map((o, k) => {
          if (typeof o === 'string' && o.trim()) return o;
          if (typeof o === 'number' || typeof o === 'boolean') return String(o);
          problems.error(file, `${fwhere}.options[${k}] must be plain text (${QUOTE_HINT})`);
          return null;
        }).filter((o) => o !== null);
        if (options.length < 2) problems.error(file, `${fwhere}: "${type}" fields need at least 2 options`);
        if (new Set(options).size !== options.length) problems.error(file, `${fwhere}: options must be different from each other`);
      } else if (f.options !== undefined) {
        problems.error(file, `${fwhere}: "options" only applies to single and multiple fields`);
      }
      if (f.required !== undefined && typeof f.required !== 'boolean') {
        problems.error(file, `${fwhere}.required must be true or false`);
      }
      return { id: fid, type, label, options, required: f.required === true };
    }).filter(Boolean);
    return {
      id,
      text: c.string(q, 'text', { required: true }) ?? '',
      details_html: md.block(c.string(q, 'details'), { headingOffset: INSIDE_CARD, source: 'meeting.yml' }),
      survey,
    };
  }).filter(Boolean);
}

function loadAgenda(list, file, problems, md, questionIds) {
  return list.map((item, i) => {
    const where = `agenda[${i}]`;
    if (!isObject(item)) {
      problems.error(file, `${where} must be a mapping with at least "title"`);
      return null;
    }
    const c = checker(problems, file, where);
    c.keys(item, ['title', 'minutes', 'question', 'notes']);
    const question = c.string(item, 'question');
    if (question && !questionIds.has(question)) {
      problems.error(file, `${where}.question "${question}" does not match any question id`);
    }
    return {
      title: c.string(item, 'title', { required: true }) ?? '',
      minutes: c.minutes(item, 'minutes', { min: 0 }),
      question: question && questionIds.has(question) ? question : undefined,
      notes_html: md.block(c.string(item, 'notes'), { headingOffset: INSIDE_CARD, source: 'meeting.yml' }),
    };
  }).filter(Boolean);
}

function loadDecisions(raw, file, problems, md, questionIds) {
  if (raw === undefined || raw === null) return [];
  if (!isObject(raw)) {
    problems.error(file, 'decisions.yml must be a mapping with a "decisions" list');
    return [];
  }
  const c = checker(problems, file, '');
  c.keys(raw, ['decisions']);
  const ids = new Set();
  return c.list(raw, 'decisions').map((d, i) => {
    const where = `decisions[${i}]`;
    if (!isObject(d)) {
      problems.error(file, `${where} must be a mapping with "id" and "decision"`);
      return null;
    }
    const dc = checker(problems, file, where);
    dc.keys(d, ['id', 'question', 'decision', 'rationale']);
    const id = dc.string(d, 'id', { required: true, pattern: ID_PATTERN, patternHint: ID_HINT });
    if (id && ids.has(id)) problems.error(file, `${where}: duplicate decision id "${id}"`);
    if (id) ids.add(id);
    const question = dc.string(d, 'question');
    if (question && !questionIds.has(question)) {
      problems.error(file, `${where}.question "${question}" does not match any question id in meeting.yml`);
    }
    const decision = dc.string(d, 'decision', { required: true }) ?? '';
    const rationale = dc.string(d, 'rationale') ?? '';
    const opts = { headingOffset: INSIDE_CARD, source: 'decisions.yml' };
    return {
      id,
      question: question && questionIds.has(question) ? question : undefined,
      decision_html: md.block(decision, opts),
      rationale_html: md.block(rationale, opts),
      // Plain text for client-side search.
      search_text: `${decision}\n${rationale}`,
    };
  }).filter(Boolean);
}

/**
 * Look at every entry of a meeting folder: collect attachments, refuse
 * symlinks, catch misnamed files (also on case-insensitive disks like macOS).
 */
async function scanMeetingFolder(dir, problems, base = '') {
  const assets = [];
  for (const entry of await readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, rel);
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    if (entry.isSymbolicLink()) {
      problems.error(full, 'symbolic links are not allowed in content');
    } else if (entry.isDirectory()) {
      assets.push(...await scanMeetingFolder(dir, problems, rel));
    } else if (!base && MEETING_FILES.includes(entry.name)) {
      // a known content file
    } else if (!base && MEETING_FILES.includes(entry.name.toLowerCase())) {
      problems.error(full, `rename to ${entry.name.toLowerCase()} (file names are case-sensitive on the server)`);
    } else if (ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      // Attachments are published as they are, so check them for keys too.
      const texts = attachmentTexts(await readFile(full), path.extname(entry.name).toLowerCase(), {
        onLimit: () => problems.warn(full, 'is too large to check completely for secret keys'),
      });
      if (!reportSecretKey(texts, full, problems)) assets.push(rel);
    } else {
      problems.warn(full, `is not published (known files: ${MEETING_FILES.join(', ')}; attachments: ${[...ASSET_EXTENSIONS].join(' ')})`);
    }
  }
  return assets;
}

async function loadMeeting(dir, id, problems) {
  const file = path.join(dir, 'meeting.yml');
  const raw = await readYaml(file, problems);
  if (raw === undefined) {
    problems.error(dir, 'missing meeting.yml');
    return null;
  }
  if (raw === null) return null; // already reported
  if (!isObject(raw)) {
    problems.error(file, 'meeting.yml must be a mapping (key: value pairs)');
    return null;
  }
  const assets = await scanMeetingFolder(dir, problems);
  const md = createMarkdown({ assetBase: `content/${id}/` });
  const c = checker(problems, file, '');
  c.keys(raw, ['title', 'date', 'time', 'duration', 'location', 'responses', 'agenda', 'questions']);

  let date = c.string(raw, 'date', { required: true, pattern: DATE_PATTERN, patternHint: 'must look like 2026-11-17' });
  if (date && !isRealDate(date)) {
    problems.error(file, `"date" is not a real calendar date (got "${date}")`);
    date = undefined;
  }
  const prefix = /^(\d{4}-\d{2}-\d{2})(?:-|$)/.exec(id)?.[1];
  if (date && prefix && prefix !== date) {
    problems.error(file, `folder name starts with ${prefix} but "date" is ${date}; make them match `
      + '(renaming the folder gives the meeting a new address, and its survey starts again without earlier answers)');
  }

  const responses = c.object(raw, 'responses');
  checker(problems, file, 'responses').keys(responses, ['reveal', 'anonymous']);
  const reveal = responses.reveal ?? REVEAL_MODES[0];
  if (!REVEAL_MODES.includes(reveal)) {
    problems.error(file, `"responses.reveal" must be one of ${REVEAL_MODES.join(', ')} (got "${reveal}")`);
  }
  const anonymous = responses.anonymous ?? false;
  if (typeof anonymous !== 'boolean') {
    problems.error(file, `"responses.anonymous" must be true or false (got ${JSON.stringify(anonymous)})`);
  }

  const questions = loadQuestions(c.list(raw, 'questions'), file, problems, md);
  const questionIds = new Set(questions.map((q) => q.id).filter(Boolean));
  const agenda = loadAgenda(c.list(raw, 'agenda'), file, problems, md, questionIds);
  const duration = c.minutes(raw, 'duration', { min: 1 });
  const agendaMinutes = agenda.reduce((sum, item) => sum + (item.minutes ?? 0), 0);
  if (duration && agendaMinutes > duration) {
    problems.warn(file, `agenda adds up to ${agendaMinutes} minutes but "duration" is ${duration}`);
  }

  const decisionsFile = path.join(dir, 'decisions.yml');
  const decisions = loadDecisions(await readYaml(decisionsFile, problems), decisionsFile, problems, md, questionIds);

  const text = async (name) => md.block(await readText(path.join(dir, name), problems), { headingOffset: UNDER_SECTION, source: name });
  const meeting = {
    id,
    title: c.string(raw, 'title', { required: true }) ?? id,
    date: date ?? '',
    time: c.string(raw, 'time', { pattern: TIME_PATTERN, patternHint: 'must look like "14:00" (24-hour clock, in quotes)' }),
    duration,
    location: c.string(raw, 'location'),
    reveal: REVEAL_MODES.includes(reveal) ? reveal : REVEAL_MODES[0],
    anonymous: anonymous === true,
    background_html: await text('background.md'),
    prereading_html: await text('prereading.md'),
    guide_html: await text('guide.md'),
    summary_html: await text('summary.md'),
    agenda,
    questions,
    decisions,
  };

  // Every relative link must point at an attachment that gets published.
  const published = new Set(assets);
  for (const link of md.fileLinks) {
    if (!published.has(link.path)) {
      problems.error(path.join(dir, link.source), `links to "${link.href}", which is not an attachment in this meeting folder`
        + ' (web addresses need https://; attachments must be one of '
        + `${[...ASSET_EXTENSIONS].join(' ')} and the name must match exactly)`);
    }
  }
  return { meeting, assets };
}

/**
 * Load and validate a content folder.
 * Returns { site, errors, warnings, assets: [{ from, to }] }.
 */
export async function loadContent(contentDir, { engineVersion = '0.0.0' } = {}) {
  const root = path.resolve(contentDir);
  const problems = new Problems(root);
  const courseFile = path.join(root, 'course.yml');
  const { course, backend, members } = loadCourse(await readYaml(courseFile, problems), courseFile, problems);

  const meetingsDir = path.join(root, 'meetings');
  const meetings = [];
  const assets = [];
  const kind = await kindOf(meetingsDir);
  if (kind !== 'dir') {
    problems.error(meetingsDir, kind === null ? 'missing meetings/ folder' : 'meetings must be a normal folder');
  } else {
    for (const entry of await readdir(meetingsDir, { withFileTypes: true })) {
      const dir = path.join(meetingsDir, entry.name);
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      if (entry.isSymbolicLink()) {
        problems.error(dir, 'symbolic links are not allowed in content');
        continue;
      }
      if (!entry.isDirectory()) {
        problems.warn(dir, 'is ignored: each meeting needs its own folder with a meeting.yml');
        continue;
      }
      if (!ID_PATTERN.test(entry.name)) {
        problems.error(dir, `meeting folder name ${ID_HINT}, e.g. 2026-11-17-grading-policy`);
        continue;
      }
      const loaded = await loadMeeting(dir, entry.name, problems);
      if (!loaded) continue;
      for (const rel of loaded.assets) {
        assets.push({ from: path.join(dir, rel), to: path.join('content', entry.name, rel) });
      }
      meetings.push(loaded.meeting);
    }
  }
  meetings.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

  return {
    // site becomes data/site.json (public). The member list is not in it:
    // the website doesn't need it, and the deploy workflow sends it to the backend.
    site: { engine: { version: engineVersion }, course, backend, meetings },
    members,
    errors: problems.errors,
    warnings: problems.warnings,
    assets,
  };
}
