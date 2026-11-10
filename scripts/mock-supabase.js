// A stand-in for the Supabase browser client, for local previews only:
//
//   npm run dev:mock
//
// The dev server serves this file instead of vendor/supabase.js. "Sign in"
// signs you in as a pretend team member, two made-up teammates have answered
// every survey, and your answers are kept in this browser's localStorage.
// It imitates the database's rules for reveal modes and anonymity roughly;
// the real rules live in supabase/migrations and are tested in test/.
(function () {
  const KEY = 'meeting-engine-mock-backend';
  const TEAM = ['alex-example', 'sam-example'];
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) ?? { signedIn: false, answers: {} };
    } catch {
      return { signedIn: false, answers: {} };
    }
  };
  const store = (state) => localStorage.setItem(KEY, JSON.stringify(state));
  const wait = () => new Promise((resolve) => setTimeout(resolve, 200));
  let site = null;
  const siteData = async () => (site ??= await (await fetch('data/site.json')).json());

  function teammateAnswer(question, n) {
    const answer = {};
    for (const field of question.survey) {
      if (field.type === 'text') answer[field.id] = `Made-up answer from ${TEAM[n]}.`;
      else if (field.type === 'single') answer[field.id] = field.options[(n + 1) % field.options.length];
      else answer[field.id] = field.options.filter((_, i) => i % 2 === n % 2);
    }
    return answer;
  }

  function createClient() {
    const listeners = [];
    const session = () => (load().signedIn ? { user: { id: 'mock-user', user_metadata: { user_name: 'you-in-preview' } } } : null);
    const emit = (event) => listeners.forEach((listener) => listener(event, session()));
    return {
      auth: {
        async signInWithOAuth({ options }) {
          store({ ...load(), signedIn: true });
          location.assign(`${options.redirectTo}?code=mock`);
          return { error: null };
        },
        async exchangeCodeForSession() {
          return { data: {}, error: null };
        },
        async signOut() {
          store({ ...load(), signedIn: false });
          emit('SIGNED_OUT');
          return { error: null };
        },
        onAuthStateChange(listener) {
          listeners.push(listener);
          setTimeout(() => listener('INITIAL_SESSION', session()), 0);
          return { data: { subscription: { unsubscribe() {} } } };
        },
      },
      async rpc(name, args) {
        await wait();
        if (!load().signedIn) return { data: null, error: { code: '42501', message: 'not signed in' } };
        if (name === 'is_member') return { data: true, error: null };
        const state = load();
        const mine = (state.answers[args.p_meeting] ??= {});
        if (name === 'save_answer') {
          if (!Object.keys(args.p_answer).length) {
            delete mine[args.p_question];
            store(state);
            return { data: null, error: null };
          }
          const at = new Date().toISOString();
          mine[args.p_question] = { answer: args.p_answer, at };
          store(state);
          return { data: at, error: null };
        }
        if (name === 'get_answers') {
          const meeting = (await siteData()).meetings.find((m) => m.id === args.p_meeting);
          const rows = [];
          for (const question of meeting?.questions ?? []) {
            const own = mine[question.id];
            if (own) rows.push({ question_id: question.id, answer: own.answer, github_login: 'you-in-preview', mine: true, updated_at: own.at });
            if (!question.survey.length || !args.p_others) continue;
            if (meeting.reveal === 'after_answering' && !own) continue;
            TEAM.forEach((login, n) => rows.push({
              question_id: question.id,
              answer: teammateAnswer(question, n),
              github_login: meeting.anonymous ? null : login,
              mine: false,
              updated_at: meeting.anonymous ? null : new Date().toISOString(),
            }));
          }
          return { data: rows, error: null };
        }
        return { data: null, error: { code: 'PGRST202', message: `mock: unknown function ${name}` } };
      },
    };
  }

  window.supabase = { createClient };
})();
