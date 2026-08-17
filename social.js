/*
 * Public profiles — the half of an account other people can see.
 *
 * Two things live here. First, a switch in the account dialog: off by default,
 * and while it's off nothing about the account is visible to anybody. Turn it on
 * under a handle you choose and other *signed-in* collectors can find you and
 * read your collection. Second, the browser behind the button next to the search
 * box, which lists everyone who has done that and opens the one you pick.
 *
 * The handle exists so an email address doesn't have to be the name on a public
 * listing. It's the only identifier that crosses between accounts; auth.users is
 * never queried and no address is ever stored in a table this file reads.
 *
 * "Opens the one you pick" means app.js's visiting mode, not a viewer of our
 * own: their collection goes into the existing grid, so the search box, all six
 * filters, every sort, the set-progress panel and the value breakdown are
 * already pointed at it. This file's job stops at fetching the data, sanitising
 * it and handing it over.
 *
 * Everything is additive in the same way cloud.js is. cloud.js only publishes
 * window.RiftboundCloud once a Supabase project is configured, so its absence is
 * the signal to strip this feature out of the page entirely.
 */
(() => {
  const App = window.RiftboundApp;
  const Cloud = window.RiftboundCloud;
  const browseBtn = document.getElementById('btn-collectors');
  const modal = document.getElementById('collectors-modal');
  const pane = document.getElementById('profile-pane');

  if (!Cloud?.onUser || !App?.setViewing || !browseBtn || !modal || !pane) {
    browseBtn?.remove();
    modal?.remove();
    pane?.remove();
    return;
  }

  /** Matches the check constraint on profiles.handle, so the two can't disagree. */
  const HANDLE_RE = /^[A-Za-z0-9_-]{3,20}$/;
  const LIST_LIMIT = 200;

  /** undefined until cloud.js has resolved the session; null means signed out. */
  let user;
  /** The signed-in user's own profile row, or null when they've never made one. */
  let profile = null;

  const escHtml = (s) =>
    String(s).replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
    );

  const num = (v) => (Number(v) || 0).toLocaleString('en-US');

  /* ================= your public profile ================= */

  const publicToggle = document.getElementById('profile-public');
  const detail = document.getElementById('profile-detail');
  const handleInput = document.getElementById('profile-handle');
  const saveBtn = document.getElementById('profile-save');
  const msgEl = document.getElementById('profile-msg');
  const linkEl = document.getElementById('profile-link');

  /** True between flipping the switch on and saving the handle that makes it real. */
  let choosing = false;
  let saving = false;

  function setMsg(text, kind = 'info') {
    msgEl.textContent = text || '';
    msgEl.hidden = !text;
    msgEl.className = `profile-msg is-${kind}`;
  }

  /**
   * Everything except the text being typed. Kept apart from the field on purpose:
   * a save that fails because a handle is taken has to leave what you wrote in
   * place for you to edit, not replace it with the last thing that saved.
   */
  function syncControls() {
    const listed = !!profile?.is_public;
    publicToggle.checked = listed;
    publicToggle.disabled = saving;
    saveBtn.disabled = saving;
    detail.hidden = !listed && !choosing;

    if (!listed) {
      linkEl.hidden = true;
      linkEl.innerHTML = '';
      return;
    }
    linkEl.hidden = false;
    linkEl.innerHTML =
      `Your link: <button class="linkish" type="button" data-act="copy-link">` +
      `${escHtml(profileUrl(profile.handle))}</button>`;
  }

  const profileUrl = (handle) => {
    const u = new URL(location.href);
    u.hash = '';
    u.search = `?u=${encodeURIComponent(handle)}`;
    return u.toString();
  };

  async function loadProfile() {
    if (!user) {
      profile = null;
      return;
    }
    const c = await Cloud.client();
    const { data, error } = await c
      .from('profiles')
      .select('handle, is_public')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) throw error;
    profile = data;
  }

  /** Called when the account dialog opens, which is the only way to see the pane. */
  async function refreshProfile() {
    choosing = false;
    setMsg('');
    if (!user) return;
    try {
      await loadProfile();
      handleInput.value = profile?.handle || '';
    } catch {
      setMsg('Could not load your profile — check your connection.', 'warn');
    }
    syncControls();
  }

  /** Supabase reports these as constraint names; say what they mean instead. */
  function profileError(err) {
    const m = String(err?.message || '');
    if (/duplicate key|profiles_handle_key/i.test(m)) return 'That handle is taken — try another.';
    if (/profiles_handle_shape|check constraint/i.test(m))
      return 'Handles are 3–20 characters: letters, digits, - and _.';
    if (/failed to fetch|network/i.test(m)) return 'Could not reach the server — try again.';
    return m || 'Could not save that.';
  }

  async function saveProfile({ handle, isPublic }) {
    if (saving || !user) return;
    const name = handle ?? profile?.handle;
    if (!name) return;

    saving = true;
    syncControls();
    setMsg('Saving…');
    try {
      const c = await Cloud.client();
      const { data, error } = await c
        .from('profiles')
        .upsert({ user_id: user.id, handle: name, is_public: isPublic }, { onConflict: 'user_id' })
        .select('handle, is_public')
        .single();
      if (error) throw error;
      profile = data;
      choosing = false;
      setMsg(
        data.is_public
          ? `Listed as ${data.handle}. Other signed-in collectors can browse your collection — they can't change it.`
          : 'Your collection is private again. Nobody else can see it.',
        'ok'
      );
    } catch (err) {
      setMsg(profileError(err), 'warn');
    } finally {
      saving = false;
      syncControls();
    }
  }

  publicToggle.addEventListener('change', () => {
    if (saving) {
      syncControls();
      return;
    }
    const on = publicToggle.checked;

    // Nothing to publish under yet: open the field and wait, rather than listing
    // an account with no name on it. The switch stays visibly on so the pending
    // intent is obvious, and syncControls() puts it back if they close the dialog.
    if (on && !profile?.handle) {
      choosing = true;
      detail.hidden = false;
      handleInput.focus();
      setMsg("Pick a handle first — it's the name other collectors will see.");
      return;
    }

    // Going private is instant and needs no ceremony; it's the direction nobody
    // should have to confirm twice.
    saveProfile({ isPublic: on });
  });

  saveBtn.addEventListener('click', () => {
    const handle = handleInput.value.trim();
    if (!HANDLE_RE.test(handle)) {
      setMsg('Handles are 3–20 characters: letters, digits, - and _.', 'warn');
      handleInput.focus();
      return;
    }
    saveProfile({ handle, isPublic: true });
  });

  handleInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    saveBtn.click();
  });

  linkEl.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-act="copy-link"]') || !profile?.handle) return;
    try {
      await navigator.clipboard.writeText(profileUrl(profile.handle));
      App.toast('Profile link copied');
    } catch {
      // Clipboard access needs a secure context; the link is on screen anyway.
      setMsg('Could not reach the clipboard — copy the link above by hand.', 'warn');
    }
  });

  // The pane is only reachable through the account dialog, and cloud.js opens
  // that. Loading on the click means a visitor who never opens it never queries.
  document.getElementById('btn-account')?.addEventListener('click', refreshProfile);

  /* ================= browsing other collectors ================= */

  const listEl = document.getElementById('collectors-list');
  const searchWrap = document.getElementById('collectors-search-wrap');
  const searchEl = document.getElementById('collectors-search');
  const subEl = document.getElementById('collectors-sub');

  /** Fetched once per opening, so typing in the filter re-queries nothing. */
  let collectors = null;
  let listState = 'idle';

  /** Compact enough for a list row; app.js has the long form for the visiting bar. */
  function agoShort(iso) {
    const then = Date.parse(iso || '');
    if (!Number.isFinite(then)) return 'no cards yet';
    const days = Math.floor((Date.now() - then) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    return `${Math.round(days / 30)}mo ago`;
  }

  const rowHTML = (r) => `
    <button class="collector" type="button"
            data-id="${escHtml(r.user_id)}" data-handle="${escHtml(r.handle)}">
      <span class="collector-avatar" aria-hidden="true">${escHtml(
        r.handle.slice(0, 2).toUpperCase()
      )}</span>
      <span class="collector-main">
        <span class="collector-handle">${escHtml(r.handle)}${
          r.user_id === user?.id ? ' <em>you</em>' : ''
        }</span>
        <span class="collector-stats">${num(r.unique_cards)} unique · ${num(
          r.total_copies
        )} copies</span>
      </span>
      <span class="collector-when">${escHtml(agoShort(r.collection_updated_at))}</span>
    </button>`;

  function paintSignedOut() {
    searchWrap.hidden = true;
    subEl.textContent = 'Browse and compare other players’ collections.';
    listEl.innerHTML = `
      <p class="collectors-note">Public collections are shared between accounts,
        so reading them needs one of your own. It's an email and a password, and
        it syncs your collection across your devices while it's at it.<br>
        <button class="linkish" type="button" data-act="signin">Sign in or create an account</button>
      </p>`;
  }

  function renderList() {
    if (user === undefined) {
      searchWrap.hidden = true;
      listEl.innerHTML = `<p class="collectors-note">Checking your session…</p>`;
      return;
    }
    if (!user) return paintSignedOut();

    subEl.textContent = 'Everyone who has made their collection public.';

    if (listState !== 'ready') {
      searchWrap.hidden = true;
      listEl.innerHTML =
        listState === 'error'
          ? `<p class="collectors-note">Could not reach the server.
               <button class="linkish" type="button" data-act="retry">Try again</button></p>`
          : `<p class="collectors-note">Loading…</p>`;
      return;
    }

    if (!collectors.length) {
      searchWrap.hidden = true;
      listEl.innerHTML = `
        <p class="collectors-note">Nobody has made their collection public yet.
          You could be the first — open your account and turn on
          <b>Public profile</b>.</p>`;
      return;
    }

    // A filter box under six names is more furniture than help.
    searchWrap.hidden = collectors.length < 6;

    const term = searchEl.value.trim().toLowerCase();
    const rows = term ? collectors.filter((r) => r.handle.toLowerCase().includes(term)) : collectors;
    listEl.innerHTML = rows.length
      ? rows.map(rowHTML).join('')
      : `<p class="collectors-note">No handle matches “${escHtml(term)}”.</p>`;
  }

  async function loadCollectors() {
    // Only blank the list the first time. Reopening the dialog refetches, and
    // flashing "Loading…" over names that are already right reads as a glitch.
    if (!collectors) {
      listState = 'loading';
      renderList();
    }
    try {
      const c = await Cloud.client();
      const { data, error } = await c
        .from('public_collectors')
        .select('user_id, handle, unique_cards, total_copies, collection_updated_at')
        // Biggest first: with no other signal, the collections worth opening are
        // the ones with something in them.
        .order('unique_cards', { ascending: false })
        .limit(LIST_LIMIT);
      if (error) throw error;
      collectors = data || [];
      listState = 'ready';
    } catch {
      listState = 'error';
    }
    renderList();
  }

  async function openCollector(userId, handle) {
    const buttons = [...listEl.querySelectorAll('.collector')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      const c = await Cloud.client();
      // RLS decides this, not the client: the row comes back only while that
      // account's profile is public, and no policy exists that would let this
      // request write to it.
      const { data, error } = await c
        .from('collections')
        .select('data, updated_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;

      modal.close();
      App.setViewing({
        handle,
        // Nothing off the network is trusted with a card id. sanitize drops ones
        // this build doesn't know and clamps every count to the range the app's
        // own writes can produce.
        data: App.sanitize(data?.data || {}),
        updatedAt: data?.updated_at || null,
      });
      App.toast(`Looking through ${handle}'s collection`);
    } catch {
      App.toast('Could not open that collection');
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  browseBtn.addEventListener('click', () => {
    modal.showModal();
    // A stored token may not have been exchanged for a session yet, and a click
    // here is the moment that starts mattering. Idempotent after the first call.
    Cloud.ensureAuth();
    renderList();
    if (user) loadCollectors();
  });

  listEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="signin"]')) {
      modal.close();
      document.getElementById('btn-account')?.click();
      return;
    }
    if (e.target.closest('[data-act="retry"]')) return loadCollectors();

    const row = e.target.closest('.collector');
    if (row) openCollector(row.dataset.id, row.dataset.handle);
  });

  searchEl.addEventListener('input', renderList);
  document.getElementById('collectors-close').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });
  modal.addEventListener('close', () => {
    searchEl.value = '';
  });

  /* ================= shareable links ================= */

  const linkedHandle = () => new URLSearchParams(location.search).get('u');

  /**
   * app.js announces every entry into and exit from visiting mode, including the
   * "Back to mine" button it owns, so the address bar can follow along without
   * app.js needing to know that a URL is involved.
   */
  document.addEventListener('riftbound:viewing', (e) => {
    const url = new URL(location.href);
    if (e.detail?.handle) url.searchParams.set('u', e.detail.handle);
    else url.searchParams.delete('u');
    history.replaceState(null, '', url);
  });

  let deepLinkTried = false;

  async function openDeepLink() {
    const handle = linkedHandle();
    if (!handle || deepLinkTried) return;
    deepLinkTried = true;
    try {
      const c = await Cloud.client();
      // `_` is legal in a handle and a single-character wildcard to LIKE, so it
      // has to be escaped or `a_b` would also match `axb` — and two matches make
      // maybeSingle() an error rather than a lookup.
      const pattern = handle.replace(/[\\%_]/g, '\\$&');
      const { data, error } = await c
        .from('public_collectors')
        .select('user_id, handle')
        .ilike('handle', pattern)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        App.toast(`No public collection for “${handle}”`);
        history.replaceState(null, '', location.pathname);
        return;
      }
      await openCollector(data.user_id, data.handle);
    } catch {
      App.toast('Could not open that profile link');
    }
  }

  /* ================= session ================= */

  Cloud.onUser((next) => {
    const changed = user === undefined || (next?.id || null) !== (user?.id || null);
    user = next || null;
    if (!changed) return;

    profile = null;
    collectors = null;
    listState = 'idle';

    // Whatever was on screen was fetched under the previous session's rights.
    if (App.viewingHandle()) App.setViewing(null);

    if (modal.open) {
      renderList();
      if (user) loadCollectors();
    }

    if (user) openDeepLink();
    else if (linkedHandle()) App.toast('Sign in to open that collection link');
  });
})();
