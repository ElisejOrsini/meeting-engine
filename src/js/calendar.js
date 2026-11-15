// Calendar entries for a meeting with a time:
// - "Add to calendar": a small .ics file (Apple Calendar, Outlook, Google
//   Calendar) that each person opens to add the meeting to their calendar.
// - "Outlook invite" (organizers): opens a new Outlook (Microsoft 365) event
//   with the title, time, place and a link to the meeting page filled in. The
//   organizer adds the team and clicks Send, and everyone gets a real
//   invitation they can accept. (The site can't send email itself.)
// Times are written in UTC ("…Z"), so no time zone can get lost on the way.

const TIME_ZONE = 'Europe/Zurich';

/** Zurich wall-clock date "YYYY-MM-DD" + time "HH:MM" → Date. */
export function zurichToDate(date, time) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Zurich's offset at that moment (1 or 2 hours), found by formatting it.
  const offsetAt = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms;
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms); // again, in case the first guess was across a clock change
  return new Date(ms);
}

/** Start and end of a meeting, or null if it has no time yet. */
export function meetingTimes(meeting) {
  let start = meeting.starts_at ? new Date(meeting.starts_at) : null;
  if (!start && meeting.date && meeting.time) start = zurichToDate(meeting.date, meeting.time);
  if (!start || Number.isNaN(start.getTime())) return null;
  return { start, end: new Date(start.getTime() + (meeting.duration ?? 60) * 60_000) };
}

const icsTime = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261124T130000Z
const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines longer than 75 bytes are folded (RFC 5545), without splitting a character.
function fold(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = new TextEncoder().encode(ch).length;
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

/** The .ics text for a meeting (null without a time). `url`: the meeting page. */
export function icsFor(meeting, { url, courseId = 'course', now = new Date() } = {}) {
  const times = meetingTimes(meeting);
  if (!times) return null;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//meeting-engine//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsText(`${courseId}-${meeting.id}@meeting-engine`)}`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(times.start)}`,
    `DTEND:${icsTime(times.end)}`,
    `SUMMARY:${icsText(meeting.title)}`,
    meeting.location ? `LOCATION:${icsText(meeting.location)}` : null,
    url ? `DESCRIPTION:${icsText(`Meeting page: ${url}`)}` : null,
    url ? `URL:${icsText(url)}` : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** A new Outlook (Microsoft 365) event with the meeting filled in. */
export function outlookInviteUrl(meeting, { url } = {}) {
  const times = meetingTimes(meeting);
  if (!times) return null;
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: meeting.title,
    startdt: iso(times.start),
    enddt: iso(times.end),
  });
  if (meeting.location) params.set('location', meeting.location);
  if (url) params.set('body', `Meeting page (agenda, survey and notes): ${url}`);
  return `https://outlook.office.com/calendar/deeplink/compose?${params}`;
}

/** File name for the .ics: "2026-11-24-late-submissions.ics". */
export const icsFileName = (meeting) => `${meeting.id.replace(/[^a-z0-9-]/g, '') || 'meeting'}.ics`;

/** Download the meeting's .ics (button [data-ics] on the meeting page). */
export function downloadIcs(meeting, options) {
  const text = icsFor(meeting, options);
  if (!text) return;
  const href = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = href;
  a.download = icsFileName(meeting);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
