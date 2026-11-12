#!/usr/bin/env node
// Import a course folder in the file format (docs/content-format.md) into a
// private course, through the agent API (docs/agent-api.md).
//
//   MEETING_ENGINE_AGENT_KEY=me_agent_... \
//   node scripts/import.mjs --content ../my-course --url https://<project>.supabase.co --publishable-key sb_publishable_...
//
// The key is read from the environment (never from the command line, so it
// doesn't end up in your shell history). It needs write access. Meetings are
// created as drafts (an organizer publishes them on the site); a meeting that
// already exists gets new versions of its parts, so running it twice is safe.
// Attachments (pdf, images, csv) are not imported: their links stay as text.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { load, CORE_SCHEMA } from 'js-yaml';
import { loadContent } from '../build/content.mjs';

/** "2026-11-10" + "16:15" in Zurich -> "2026-11-10T16:15:00+01:00". */
export function zurichIso(date, time = '00:00') {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  // Zurich's offset at that moment (+1 in winter, +2 in summer).
  const offsetAt = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms) / 60000;
  };
  const offset = offsetAt(asUtc - offsetAt(asUtc) * 60000);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date}T${pad(h)}:${pad(mi)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

async function readOptional(file) {
  try {
    const text = await readFile(file, 'utf8');
    return text.replace(/^\s*#.*$/gm, '').trim() ? text.trim() : undefined;
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''
  && !(Array.isArray(v) && v.length === 0)));

/**
 * The parts of one meeting folder, in the shapes of docs/agent-api.md.
 * The folder must already have passed the content check.
 */
export async function meetingParts(dir) {
  const meeting = load(await readFile(path.join(dir, 'meeting.yml'), 'utf8'), { schema: CORE_SCHEMA }) ?? {};
  const decisionsFile = await readOptional(path.join(dir, 'decisions.yml'));
  const decisions = decisionsFile ? (load(decisionsFile, { schema: CORE_SCHEMA })?.decisions ?? []) : [];
  const text = (v) => (v === undefined || v === null ? undefined : String(v));

  const details = clean({
    title: String(meeting.title),
    starts_at: meeting.date ? zurichIso(String(meeting.date), meeting.time ? String(meeting.time) : '00:00') : undefined,
    duration_min: meeting.duration,
    location_md: text(meeting.location),
  });
  // A meeting without a time keeps only its date: midnight in Zurich.
  const pre = clean({
    background_md: await readOptional(path.join(dir, 'background.md')),
    prereading_md: await readOptional(path.join(dir, 'prereading.md')),
    responses: meeting.responses ? clean({
      reveal: meeting.responses.reveal, anonymous: meeting.responses.anonymous,
    }) : undefined,
    questions: (meeting.questions ?? []).map((q) => clean({
      id: q.id,
      text: String(q.text),
      details_md: text(q.details),
      survey: (q.survey ?? []).map((f) => clean({
        id: f.id, type: f.type, label: String(f.label),
        options: f.options?.map(String), required: f.required,
      })),
    })),
  });
  const guide = await readOptional(path.join(dir, 'guide.md'));
  const during = clean({
    items: (meeting.agenda ?? []).map((a) => clean({
      title: String(a.title), question: a.question, minutes: a.minutes, notes_md: text(a.notes),
    })),
    guide_md: guide,
  });
  const post = clean({
    summary_md: await readOptional(path.join(dir, 'summary.md')),
    decisions: decisions.map((d) => clean({
      id: d.id, question: d.question, decision_md: text(d.decision), rationale_md: text(d.rationale),
    })),
  });
  return { details, pre, in: during, post };
}

/**
 * Import every meeting of a content folder. `call(name, args)` calls an
 * agent API function and returns its result (or throws an Error with
 * `.status`). Returns a list of lines describing what happened.
 */
export async function importCourse({ contentDir, call, log = () => {} }) {
  const content = await loadContent(contentDir);
  if (content.errors.length) {
    throw new Error(`the content has ${content.errors.length} problem(s); fix them first:\n${content.errors.join('\n')}`);
  }
  const lines = [];
  for (const meeting of [...content.site.meetings].reverse()) { // oldest first
    const parts = await meetingParts(path.join(contentDir, 'meetings', meeting.id));
    let current;
    try {
      await call('agent_create_meeting', { id: meeting.id, ...parts.details });
      current = await call('agent_get_meeting', { meeting: meeting.id });
      log(`${meeting.id}: created (draft)`);
    } catch (err) {
      if (err.status !== 409) throw err;
      current = await call('agent_get_meeting', { meeting: meeting.id });
      await call('agent_update_meeting', { meeting: meeting.id, base_version: current.details.version, details: parts.details });
      log(`${meeting.id}: exists, updating`);
    }
    const saved = [];
    for (const part of ['pre', 'in', 'post']) {
      if (!Object.keys(parts[part]).length) continue;
      if (JSON.stringify(current[part].content) === JSON.stringify(parts[part])) continue;
      await call('agent_put_section', {
        meeting: meeting.id, part, base_version: current[part].version, content: parts[part], note: 'imported from files',
      });
      saved.push(part);
    }
    lines.push(`${meeting.id}: ${saved.length ? `saved ${saved.join(', ')}` : 'nothing new'}`);
  }
  return lines;
}

/** An agent API caller over HTTPS (PostgREST, as Supabase runs it). */
export function httpCaller({ url, publishableKey, agentKey, fetch = globalThis.fetch }) {
  return async (name, args) => {
    const response = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: publishableKey, 'x-agent-key': agentKey, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { message: text };
    }
    if (!response.ok) {
      const err = new Error(`${name}: HTTP ${response.status}: ${body?.message ?? text}`);
      err.status = response.status;
      throw err;
    }
    return body;
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      content: { type: 'string' },
      url: { type: 'string' },
      'publishable-key': { type: 'string' },
    },
  });
  const agentKey = process.env.MEETING_ENGINE_AGENT_KEY;
  if (!values.content || !values.url || !values['publishable-key'] || !agentKey) {
    console.error('usage: MEETING_ENGINE_AGENT_KEY=me_agent_... node scripts/import.mjs --content <folder> --url <Project URL> --publishable-key <sb_publishable_...>');
    process.exitCode = 2;
    return;
  }
  const call = httpCaller({ url: values.url, publishableKey: values['publishable-key'], agentKey });
  const who = await call('agent_whoami', {});
  console.log(`Importing into course "${who.course}" (${who.course_name}) with key "${who.key_label}".`);
  for (const line of await importCourse({ contentDir: values.content, call, log: console.log })) console.log(line);
  console.log('Done. The new meetings are drafts: publish them on the site.');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  });
}
