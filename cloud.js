/*
 * Optional cloud sync — an account, and one row of Postgres holding the
 * collection. Everything here is additive: signed out, the app is the local-only
 * tracker it has always been, and if supabase-config.js still holds placeholders
 * the account button removes itself and not a byte of Supabase is fetched.
 *
 * Sync model, in one paragraph. The first time a device signs in to an account
 * it *merges* — local and cloud are two histories that both deserve to survive,
 * so each card takes the larger quantity and either side's wishlist flag. After
 * that the cloud is authoritative: a device that sees a newer updated_at than
 * the one it last applied replaces its local copy wholesale. That's what makes
 * removals travel — a merge-on-every-sync would quietly resurrect every card you
 * ever sold. The cost is that two devices editing at the same moment resolve
 * last-write-wins, which is the right trade for a collection tracker.
 */
(() => {
  const CFG = window.RIFTBOUND_SUPABASE;
  const App = window.RiftboundApp;
  const accountBtn = document.getElementById('btn-account');
  const modal = document.getElementById('auth-modal');

  const configured =
    CFG?.url && CFG?.anonKey && !CFG.url.startsWith('YOUR_') && !CFG.anonKey.startsWith('YOUR_');

  // No project wired up yet — leave the UI exactly as it was.
  if (!configured || !App || !accountBtn || !modal) {
    accountBtn?.remove();
    return;
  }

  const SYNC_KEY = 'riftbound-cloud-v1';
  const VENDOR = 'vendor/supabase.js';
  const PUSH_DELAY = 1500;
  const REFRESH_EVERY = 30_000;

  /* ---------------- library + client, both loaded on demand ---------------- */

  let libPromise;
  function ensureLib() {
    libPromise ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = VENDOR;
      s.onload = () => (window.supabase ? resolve(window.supabase) : reject(new Error('no global')));
      s.onerror = () => reject(new Error('could not load vendor/supabase.js'));
      document.head.append(s);
    });
    return libPromise;
  }

  let sb;
  async function client() {
    if (!sb) sb = (await ensureLib()).createClient(CFG.url, CFG.anonKey);
    return sb;
  }

  /* ---------------- what this device already knows ---------------- */

  /** { userId, appliedAt } — the server timestamp our local copy corresponds to. */
  function readSync() {
    try {
      return JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function writeSync(v) {
    try {
      localStorage.setItem(SYNC_KEY, JSON.stringify(v));
    } catch {
      /* sync bookkeeping is recoverable — a full quota just means we merge again */
    }
  }

  /* ---------------- collection helpers ---------------- */

  /** Union of two collections: the larger count, and a wishlist flag from either. */
  function merge(a, b) {
    const out = {};
    for (const id of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      const q = Math.max(a?.[id]?.q || 0, b?.[id]?.q || 0);
      const w = !!(a?.[id]?.w || b?.[id]?.w);
      if (q > 0 || w) out[id] = { q, w };
    }
    return out;
  }

  /** Key order isn't meaningful, so compare a normalised form. */
  const stable = (o) =>
    JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k].q, !!o[k].w]));

  const sameAs = (a, b) => stable(a) === stable(b);

  /* ---------------- reads and writes ---------------- */

  /** The user's row, or null when they've never synced. RLS scopes this to them. */
  async function pull(userId) {
    const c = await client();
    const { data, error } = await c
      .from('collections')
      .select('data, updated_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  /** Upserts and returns the server's updated_at, which the trigger owns. */
  async function push(userId, coll) {
    const c = await client();
    const { data, error } = await c
      .from('collections')
      .upsert(
        { user_id: userId, data: coll, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
      .select('updated_at')
      .single();
    if (error) throw error;
    return data.updated_at;
  }

  /* ---------------- sync ---------------- */

  let user = null;
  let pushTimer;
  let lastRefresh = 0;

  async function reconcile({ announce = false } = {}) {
    if (!user) return;
    const local = App.getCollection();
    const memory = readSync();
    let remote;

    try {
      remote = await pull(user.id);
    } catch (err) {
      setStatus('offline');
      if (announce) App.toast('Signed in — could not reach your collection');
      return;
    }

    // Nothing stored yet: this local collection becomes the account's.
    if (!remote) {
      try {
        const at = await push(user.id, local);
        writeSync({ userId: user.id, appliedAt: at });
        setStatus('synced');
        if (announce) App.toast('Signed in — collection saved to your account');
      } catch {
        setStatus('offline');
      }
      return;
    }

    // First sign-in for this account on this device — two real histories.
    if (memory?.userId !== user.id) {
      const merged = merge(local, remote.data);
      const grew = !sameAs(merged, local);
      App.applyCollection(merged);
      try {
        const at = sameAs(merged, remote.data)
          ? remote.updated_at
          : await push(user.id, merged);
        writeSync({ userId: user.id, appliedAt: at });
        setStatus('synced');
      } catch {
        setStatus('offline');
      }
      if (announce) {
        App.toast(grew ? 'Signed in — collections merged' : 'Signed in — collection synced');
      }
      return;
    }

    // Known device: take the cloud's copy when someone else has moved it on.
    if (remote.updated_at !== memory.appliedAt) {
      App.applyCollection(remote.data);
      writeSync({ userId: user.id, appliedAt: remote.updated_at });
      setStatus('synced');
      App.toast(announce ? 'Signed in — collection restored' : 'Collection updated from another device');
      return;
    }

    setStatus('synced');
    if (announce) App.toast('Signed in');
  }

  /** app.js calls this after every local write. */
  function onLocalChange() {
    if (!user) return;
    setStatus('saving');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try {
        const at = await push(user.id, App.getCollection());
        writeSync({ userId: user.id, appliedAt: at });
        setStatus('synced');
      } catch {
        setStatus('offline');
      }
    }, PUSH_DELAY);
  }

  window.RiftboundCloud = { onLocalChange };

  // Coming back to the tab is the natural moment to notice another device's edits.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !user) return;
    if (Date.now() - lastRefresh < REFRESH_EVERY) return;
    lastRefresh = Date.now();
    reconcile();
  });

  /* ---------------- UI ---------------- */

  const form = document.getElementById('auth-form');
  const signedPane = document.getElementById('auth-signed');
  const emailInput = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');
  const errorLine = document.getElementById('auth-error');
  const submitBtn = document.getElementById('auth-submit');
  const titleEl = document.getElementById('auth-title');
  const subEl = document.getElementById('auth-sub');
  const switchBtn = document.getElementById('auth-switch');
  const switchText = document.getElementById('auth-switch-text');
  const whoEl = document.getElementById('auth-who');

  let mode = 'signin';
  let busy = false;

  const STATUS = {
    synced: { text: 'Synced', cls: 'ok' },
    saving: { text: 'Saving…', cls: 'busy' },
    offline: { text: 'Offline', cls: 'warn' },
  };

  function setStatus(kind) {
    const s = STATUS[kind];
    if (!s || !user) return;
    accountBtn.dataset.sync = s.cls;
    accountBtn.title = `${user.email} — ${s.text}`;
  }

  function paintButton() {
    if (user) {
      accountBtn.textContent = user.email.split('@')[0];
      accountBtn.classList.add('is-signed-in');
      setStatus('synced');
    } else {
      accountBtn.textContent = 'Sign in';
      accountBtn.classList.remove('is-signed-in');
      delete accountBtn.dataset.sync;
      accountBtn.title = 'Sign in to sync your collection';
    }
  }

  function setMode(next) {
    mode = next;
    const signup = mode === 'signup';
    titleEl.textContent = signup ? 'Create an account' : 'Sign in';
    subEl.textContent = signup
      ? 'Your collection follows you to any device you sign in on.'
      : 'Welcome back — your collection is waiting.';
    submitBtn.textContent = signup ? 'Create account' : 'Sign in';
    passwordInput.autocomplete = signup ? 'new-password' : 'current-password';
    switchText.textContent = signup ? 'Already have an account?' : 'New here?';
    switchBtn.textContent = signup ? 'Sign in' : 'Create an account';
    showError('');
  }

  function showError(msg) {
    errorLine.textContent = msg;
    errorLine.hidden = !msg;
  }

  function setBusy(on) {
    busy = on;
    submitBtn.disabled = on;
    submitBtn.textContent = on
      ? mode === 'signup' ? 'Creating…' : 'Signing in…'
      : mode === 'signup' ? 'Create account' : 'Sign in';
  }

  function openModal() {
    const signedIn = !!user;
    form.hidden = signedIn;
    signedPane.hidden = !signedIn;
    if (signedIn) {
      whoEl.textContent = user.email;
    } else {
      setMode('signin');
      form.reset();
      // Belt and braces: a dialog reopened after a failed attempt should never
      // present a disabled button.
      setBusy(false);
    }
    modal.showModal();
    if (!signedIn) emailInput.focus();
  }

  accountBtn.addEventListener('click', openModal);

  switchBtn.addEventListener('click', () => {
    setMode(mode === 'signup' ? 'signin' : 'signup');
    emailInput.focus();
  });

  document.getElementById('auth-cancel').addEventListener('click', () => modal.close());
  document.getElementById('auth-done').addEventListener('click', () => modal.close());

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });

  /** Supabase's messages are decent but a few are worth saying in plain English. */
  function friendly(message) {
    const m = String(message || '');
    if (/invalid login credentials/i.test(m)) return 'That email and password don\'t match.';
    if (/user already registered/i.test(m)) return 'That email already has an account — sign in instead.';
    if (/password should be at least/i.test(m)) return 'Passwords need at least 6 characters.';
    if (/email address .* invalid/i.test(m)) return 'That doesn\'t look like a valid email address.';
    if (/failed to fetch|network/i.test(m)) return 'Could not reach the server — check your connection.';
    return m || 'Something went wrong.';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) return;

    setBusy(true);
    showError('');
    try {
      const c = await client();
      const { data, error } =
        mode === 'signup'
          ? await c.auth.signUp({ email, password })
          : await c.auth.signInWithPassword({ email, password });

      if (error) throw error;

      // Signing up with email confirmation still switched on returns no session.
      if (!data.session) {
        showError('Check your email to confirm the account, then sign in.');
        setBusy(false);
        return;
      }
      // Must clear before closing: the guard at the top of this handler reads
      // `busy`, so leaving it set makes every later submit a no-op — sign in,
      // sign out, sign in again would silently do nothing until a page reload.
      setBusy(false);
      modal.close();
      // onAuthStateChange does the rest.
    } catch (err) {
      showError(friendly(err?.message));
      setBusy(false);
    }
  });

  document.getElementById('auth-signout').addEventListener('click', async () => {
    clearTimeout(pushTimer);
    try {
      const c = await client();
      // 'local' signs this browser out. The default, 'global', revokes every
      // session the account has — signing out on a phone would boot the laptop.
      await c.auth.signOut({ scope: 'local' });
    } catch {
      /* a failed sign-out still clears locally below */
    }
    modal.close();
    App.toast('Signed out — your collection stays on this device');
  });

  /* ---------------- session ---------------- */

  paintButton();

  /**
   * Only wake Supabase up if there's plausibly a session to restore — a fresh
   * visitor who never signs in pays nothing for any of this.
   */
  function hasStoredSession() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('sb-') && k.endsWith('-auth-token')) return true;
      }
    } catch {
      /* private mode — treat as signed out */
    }
    return false;
  }

  async function watchAuth() {
    const c = await client();
    c.auth.onAuthStateChange((event, session) => {
      const next = session?.user ?? null;
      const changed = next?.id !== user?.id;
      user = next;
      paintButton();
      if (!user) return;
      // SIGNED_IN also fires on token refresh; only resync when the user changed.
      if (changed) reconcile({ announce: event === 'SIGNED_IN' });
    });
    const { data } = await c.auth.getSession();
    if (data.session?.user && !user) {
      user = data.session.user;
      paintButton();
      reconcile();
    }
  }

  if (hasStoredSession()) watchAuth().catch(() => {});
  // A click on the account button needs the listener wired up too.
  accountBtn.addEventListener('click', () => watchAuth().catch(() => {}), { once: true });
})();
