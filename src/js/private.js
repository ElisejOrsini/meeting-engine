// Private courses: the content comes from the database after sign-in (see
// supabase/migrations, get_course), not from data/site.json. toSite() turns
// the database's answer into the same shape the build writes for public
// sites, so the same views draw both. Markdown is rendered here, in the
// browser, with the build's renderer and safety rules (js/markdown.js is a
// copy of build/markdown.mjs).

const TIME_ZONE = 'Europe/Zurich';
const UNDER_SECTION = 1; // "#" in a section's Markdown becomes <h3> (like the build)
const INSIDE_CARD = 2;

/** "2026-11-24T15:00:00Z" -> { date: "2026-11-24", time: "16:00" } in Zurich time. */
export function zurichDateTime(iso) {
  const when = new Date(iso);
  if (!iso || Number.isNaN(when.getTime())) return { date: '', time: undefined };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(when).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function savedInfo(part) {
  if (!part?.version) return null;
  const by = String(part.saved_by ?? '');
  return {
    version: part.version,
    saved_at: part.saved_at,
    by: by.startsWith('agent:') ? `${by.slice(6)} (agent)` : by.startsWith('member:') ? `@${by.slice(7)}` : by,
  };
}

/** One meeting from get_course, in the shape the views use. */
function toMeeting(m, md) {
  const details = m.details?.content ?? {};
  const pre = m.pre?.content ?? {};
  const during = m.in?.content ?? {};
  const post = m.post?.content ?? {};
  const block = (src, headingOffset = UNDER_SECTION) => md.block(src ?? '', { headingOffset });
  const { date, time } = zurichDateTime(details.starts_at);

  const questions = (pre.questions ?? []).map((q) => ({
    id: q.id,
    text: q.text,
    needs_meeting: q.needs_meeting !== false,
    details_html: block(q.details_md, INSIDE_CARD),
    survey: (q.survey ?? []).map((f) => ({
      id: f.id, type: f.type, label: f.label, options: f.options ?? [], required: f.required === true,
    })),
  }));
  const questionText = new Map(questions.map((q) => [q.id, q.text]));

  // Until the In-meeting tab is redesigned, its items are shown as agenda items.
  const agenda = (during.items ?? []).map((item) => {
    const notes = [
      item.consensus_md,
      (item.key_points ?? []).length ? item.key_points.map((p) => `- ${p.replace(/\n+/g, ' ')}`).join('\n') : '',
      item.contested && item.disagreement_md ? `**Where people disagree:** ${item.disagreement_md}` : '',
      item.notes_md,
    ].filter(Boolean).join('\n\n');
    return {
      title: item.short || item.title || questionText.get(item.question) || '',
      minutes: Number.isInteger(item.minutes) ? item.minutes : undefined,
      question: questionText.has(item.question) ? item.question : undefined,
      notes_html: block(notes, INSIDE_CARD),
    };
  });

  const decisions = (post.decisions ?? []).map((d) => ({
    id: d.id,
    question: questionText.has(d.question) ? d.question : undefined,
    decision_html: block(d.decision_md, INSIDE_CARD),
    rationale_html: block(d.rationale_md, INSIDE_CARD),
    search_text: `${d.decision_md ?? ''}\n${d.rationale_md ?? ''}`,
  }));

  return {
    id: m.id,
    draft: m.published === false,
    title: details.title ?? m.id,
    date,
    time,
    duration: Number.isInteger(details.duration_min) ? details.duration_min : undefined,
    location_html: details.location_md ? md.inline(details.location_md) : '',
    reveal: pre.responses?.reveal === 'after_answering' ? 'after_answering' : 'anytime',
    anonymous: pre.responses?.anonymous === true,
    background_html: block(pre.background_md),
    prereading_html: block(pre.prereading_md),
    guide_html: block([during.intro_md, during.guide_md].filter(Boolean).join('\n\n')),
    summary_html: block(post.summary_md),
    agenda,
    questions,
    decisions,
    next_steps: (post.next_steps ?? []).map((s) => ({
      what_html: md.inline(s.what_md ?? ''), owner: s.owner ?? '', due: s.due ?? '', question: s.question,
    })),
    open_items: (post.open ?? []).map((o) => ({
      text_html: md.inline(o.text_md ?? ''), next_html: md.inline(o.next_md ?? ''), question: o.question,
    })),
    saved: { details: savedInfo(m.details), pre: savedInfo(m.pre), in: savedInfo(m.in), post: savedInfo(m.post) },
  };
}

/** The site object for the views, from get_course's answer. */
export function toSite(data, { createMarkdown, engine, backend }) {
  const md = createMarkdown({ files: false }); // no attachments in private courses (yet)
  const meetings = (data.meetings ?? []).map((m) => toMeeting(m, md));
  // Newest first, like the build; meetings without a time count as upcoming.
  meetings.sort((a, b) => (b.date || '9999').localeCompare(a.date || '9999') || a.id.localeCompare(b.id));
  return {
    engine,
    backend,
    private: true,
    course: {
      id: data.course?.id,
      name: data.course?.name ?? 'Meetings',
      description_html: md.block(data.course?.description_md ?? '', { headingOffset: UNDER_SECTION }),
      links: [],
      notes_html: md.block(data.notes?.content?.notes_md ?? '', { headingOffset: UNDER_SECTION }),
      notes_saved: savedInfo(data.notes),
    },
    me: data.me ?? null,
    members: data.members ?? [],
    agent_keys: data.agent_keys ?? null,
    meetings,
  };
}
