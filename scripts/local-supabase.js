// A stand-in for the Supabase browser client that talks to the local backend
// (scripts/local-backend.mjs), for previews only:
//
//   npm run dev:private
//
// "Sign in" signs you in as a pretend person. Who, is kept in this browser
// (localStorage "meeting-engine-local-user"): 1001 = you-in-preview
// (organizer, the default), 1002 = teammate-in-preview (member),
// 4001 = stranger-in-preview (on no team list). Everything else goes to the
// local database, with its real rules.
(function () {
  const KEY = 'meeting-engine-local-user';
  const LOGINS = { 1001: 'you-in-preview', 1002: 'teammate-in-preview', 4001: 'stranger-in-preview' };
  const user = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const set = (value) => {
    if (value === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, value);
  };

  function createClient(url) {
    const listeners = [];
    const session = () => {
      const id = user();
      if (!id || id === 'signed-out') return null;
      return { user: { id: `local-${id}`, user_metadata: { user_name: LOGINS[id] ?? `user-${id}` } } };
    };
    const emit = (event) => listeners.forEach((listener) => listener(event, session()));
    return {
      auth: {
        async signInWithOAuth({ options }) {
          const current = user();
          set(current && current !== 'signed-out' ? current : '1001');
          location.assign(`${options.redirectTo}?code=local`);
          return { error: null };
        },
        async exchangeCodeForSession() {
          return { data: {}, error: null };
        },
        async signOut() {
          set('signed-out');
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
        const id = user();
        const headers = { 'content-type': 'application/json' };
        if (id && id !== 'signed-out') headers.authorization = `Bearer local-user-${id}`;
        const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args ?? {}) });
        const text = await response.text();
        const body = text ? JSON.parse(text) : null;
        return response.ok ? { data: body, error: null } : { data: null, error: body };
      },
    };
  }

  window.supabase = { createClient };
})();
