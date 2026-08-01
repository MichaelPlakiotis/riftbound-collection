/* Riftbound collection tracker — local-only, state lives in localStorage. */

const STORAGE_KEY = 'riftbound-collection-v1';
const DATA = window.RIFTBOUND_DATA;

if (!DATA) {
  document.body.innerHTML =
    '<p style="padding:40px;font-family:sans-serif;color:#e6edf3">' +
    'Card data missing. Run <code>node sync-cards.mjs</code> first.</p>';
  throw new Error('data/cards.js not loaded');
}

const CARDS = DATA.cards;
const META = DATA.meta;

// Promo sets (organized play, judge, general promos) aren't part of normal set
// completion, so they're excluded from the denominator and hidden by default.
const PROMO_SETS = new Set(META.sets.filter((s) => s.promo).map((s) => s.id));
const isPromo = (c) => PROMO_SETS.has(c.set_id);
const COLLECTABLE = CARDS.filter((c) => !isPromo(c));

/* ---------------- persistence ---------------- */

/** collection: { [cardId]: { q: number, w: boolean } } — entries are pruned when empty. */
let collection = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
    } catch (err) {
      toast('Could not save — storage may be full');
    }
  }, 150);
}

const qtyOf = (id) => collection[id]?.q || 0;
const wishOf = (id) => !!collection[id]?.w;

function setEntry(id, patch) {
  const cur = collection[id] || { q: 0, w: false };
  const next = { ...cur, ...patch };
  if (next.q <= 0 && !next.w) delete collection[id];
  else collection[id] = { q: Math.max(0, next.q | 0), w: !!next.w };
  save();
}

/* ---------------- filter state ---------------- */

const state = {
  q: '',
  set: '',
  domain: '',
  rarity: '',
  type: '',
  own: 'all',
  hidePromos: true,
};

const el = (id) => document.getElementById(id);
const grid = el('grid');

/* ---------------- filtering ---------------- */

function matches(c) {
  // An explicit set choice wins over the promo toggle, so picking a promo set works.
  if (state.hidePromos && !state.set && isPromo(c)) return false;
  if (state.set && c.set_id !== state.set) return false;
  // Cards can span several domains (Vendetta's cross-domain cards) — match any.
  if (state.domain && !c.domains.includes(state.domain)) return false;
  if (state.rarity && c.rarity !== state.rarity) return false;
  if (state.type && c.type !== state.type) return false;

  const q = qtyOf(c.id);
  if (state.own === 'owned' && q === 0) return false;
  if (state.own === 'missing' && q > 0) return false;
  if (state.own === 'wishlist' && !wishOf(c.id)) return false;

  if (state.q) {
    const hay = [c.name, c.description || '', (c.keywords || []).join(' '), c.id]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(state.q)) return false;
  }
  return true;
}

/* ---------------- rendering ---------------- */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])
  );

function cardHTML(c) {
  const q = qtyOf(c.id);
  const w = wishOf(c.id);
  const img = c.image || c.image_full || '';
  const num = String(c.collector_number).padStart(3, '0') + (c.variant ? c.variant : '');
  const dots = c.domains
    .map(
      (d) =>
        `<span class="dot" style="background:var(--f-${esc(d)}, #7d8896)" title="${esc(d)}"></span>`
    )
    .join('');

  return `
    <article class="card ${q > 0 ? 'is-owned' : ''} ${w ? 'is-wish' : ''}" data-id="${esc(c.id)}">
      <div class="card-img">
        <img src="${esc(img)}" alt="${esc(c.name)}" loading="lazy" decoding="async">
        <span class="qty-badge" ${q > 0 ? '' : 'hidden'}>${q}</span>
        <button class="wish-btn ${w ? 'on' : ''}" type="button"
                data-act="wish" title="Toggle wishlist"
                aria-label="Toggle wishlist for ${esc(c.name)}"
                aria-pressed="${w}">${w ? '★' : '☆'}</button>
      </div>
      <div class="card-body">
        <div class="card-name" title="${esc(c.description || c.name)}">${esc(c.name)}</div>
        <div class="card-meta">
          <span class="dots">${dots}</span>
          <span style="color:var(--r-${esc(c.rarity)}, #7d8896)">${esc(c.rarity)}</span>
          <span class="num">${esc(c.set_id)}-${esc(num)}</span>
        </div>
        <div class="stepper">
          <button type="button" data-act="dec" aria-label="Remove one" ${q === 0 ? 'disabled' : ''}>−</button>
          <input type="number" min="0" max="99" value="${q}" data-act="qty"
                 aria-label="Copies of ${esc(c.name)} owned">
          <button type="button" data-act="inc" aria-label="Add one">+</button>
        </div>
      </div>
    </article>`;
}

function render() {
  const list = CARDS.filter(matches);
  grid.innerHTML = list.map(cardHTML).join('');
  el('empty').hidden = list.length > 0;
  el('result-count').textContent =
    `${list.length} card${list.length === 1 ? '' : 's'} shown`;
  renderStats();
}

/** Refresh one tile in place so the grid doesn't jump while you tap +/−. */
function refreshCard(id) {
  const node = grid.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!node) return;
  const q = qtyOf(id);
  const w = wishOf(id);

  node.classList.toggle('is-owned', q > 0);
  node.classList.toggle('is-wish', w);

  const badge = node.querySelector('.qty-badge');
  badge.textContent = q;
  badge.hidden = q === 0;

  const wishBtn = node.querySelector('.wish-btn');
  wishBtn.classList.toggle('on', w);
  wishBtn.textContent = w ? '★' : '☆';
  wishBtn.setAttribute('aria-pressed', String(w));

  node.querySelector('[data-act="qty"]').value = q;
  node.querySelector('[data-act="dec"]').disabled = q === 0;

  renderStats();
}

/* ---------------- stats ---------------- */

function renderStats() {
  const uniqueOwned = COLLECTABLE.filter((c) => qtyOf(c.id) > 0).length;
  const totalCopies = COLLECTABLE.reduce((n, c) => n + qtyOf(c.id), 0);
  const wishCount = COLLECTABLE.filter((c) => wishOf(c.id)).length;
  const pct = COLLECTABLE.length
    ? Math.round((uniqueOwned / COLLECTABLE.length) * 100)
    : 0;

  el('statline').innerHTML =
    `<span><b>${uniqueOwned}</b> / ${COLLECTABLE.length} unique <span class="pct">(${pct}%)</span></span>` +
    `<span><b>${totalCopies}</b> total copies</span>` +
    `<span><b>${wishCount}</b> on wishlist</span>`;

  const panel = el('stats-panel');
  if (panel.hidden) return;

  panel.innerHTML = META.sets
    .map((s) => {
      // Per-set rows count every card in the set, promos included — the promo
      // exclusion only applies to the overall completion figure above.
      const inSet = CARDS.filter((c) => c.set_id === s.id);
      const owned = inSet.filter((c) => qtyOf(c.id) > 0).length;
      const p = inSet.length ? Math.round((owned / inSet.length) * 100) : 0;
      return `
        <div class="setrow${s.promo ? ' is-promo' : ''}">
          <div class="setrow-name">${esc(s.name)} <small>${esc(s.id)}</small></div>
          <div class="setrow-num">${owned} / ${inSet.length} · ${p}%</div>
          <div class="bar"><div class="bar-fill" style="width:${p}%"></div></div>
        </div>`;
    })
    .join('');
}

/* ---------------- events ---------------- */

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.tagName === 'INPUT') return;
  const id = btn.closest('.card')?.dataset.id;
  if (!id) return;

  const act = btn.dataset.act;
  if (act === 'inc') setEntry(id, { q: qtyOf(id) + 1 });
  else if (act === 'dec') setEntry(id, { q: qtyOf(id) - 1 });
  else if (act === 'wish') setEntry(id, { w: !wishOf(id) });
  else return;

  refreshCard(id);
});

grid.addEventListener('change', (e) => {
  const input = e.target.closest('[data-act="qty"]');
  if (!input) return;
  const id = input.closest('.card')?.dataset.id;
  if (!id) return;
  const n = Math.min(99, Math.max(0, parseInt(input.value, 10) || 0));
  setEntry(id, { q: n });
  refreshCard(id);
});

let searchTimer;
el('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value.trim().toLowerCase();
  searchTimer = setTimeout(() => {
    state.q = v;
    render();
  }, 180);
});

// Ctrl/Cmd+F should search the collection, not the rendered page — the browser's
// find bar only sees the cards already in the DOM. Escape gives a way back out.
document.addEventListener('keydown', (e) => {
  const search = el('search');

  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key?.toLowerCase() === 'f') {
    e.preventDefault();
    search.focus();
    search.select();
    return;
  }

  if (e.key === 'Escape' && document.activeElement === search) {
    if (search.value) {
      search.value = '';
      state.q = '';
      render();
    } else {
      search.blur();
    }
  }
});

function bindSelect(id, key, label, values, labelFn = (v) => v) {
  const sel = el(id);
  sel.innerHTML =
    `<option value="">${label}</option>` +
    values.map((v) => `<option value="${esc(v)}">${esc(labelFn(v))}</option>`).join('');
  sel.addEventListener('change', () => {
    state[key] = sel.value;
    render();
  });
}

el('f-own').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-own]');
  if (!btn) return;
  el('f-own').querySelectorAll('button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.own = btn.dataset.own;
  render();
});

el('f-hide-promos').addEventListener('change', (e) => {
  state.hidePromos = e.target.checked;
  render();
});

el('btn-stats').addEventListener('click', () => {
  const panel = el('stats-panel');
  panel.hidden = !panel.hidden;
  el('btn-stats').setAttribute('aria-expanded', String(!panel.hidden));
  renderStats();
});

el('btn-reset').addEventListener('click', () => {
  Object.assign(state, { q: '', set: '', domain: '', rarity: '', type: '', own: 'all' });
  el('search').value = '';
  ['f-set', 'f-domain', 'f-rarity', 'f-type'].forEach((id) => (el(id).value = ''));
  el('f-own').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.own === 'all')
  );
  render();
});

/* ---------------- export / import ---------------- */

el('btn-export').addEventListener('click', () => {
  const payload = {
    app: 'riftbound-collection',
    version: 1,
    exportedAt: new Date().toISOString(),
    collection,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `riftbound-collection-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Collection exported');
});

el('btn-import').addEventListener('click', () => el('file-import').click());

el('file-import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = data.collection ?? data;
    if (!incoming || typeof incoming !== 'object') throw new Error('bad shape');

    const known = new Set(CARDS.map((c) => c.id));
    const clean = {};
    let skipped = 0;
    for (const [id, v] of Object.entries(incoming)) {
      if (!known.has(id)) { skipped++; continue; }
      const q = Math.min(99, Math.max(0, parseInt(v?.q, 10) || 0));
      const w = !!v?.w;
      if (q > 0 || w) clean[id] = { q, w };
    }

    const count = Object.keys(clean).length;
    if (!confirm(`Import ${count} card entries? This replaces your current collection.`)) return;

    collection = clean;
    save();
    render();
    toast(`Imported ${count} entries${skipped ? ` (${skipped} unknown ids skipped)` : ''}`);
  } catch {
    toast('Could not read that file');
  } finally {
    e.target.value = '';
  }
});

let toastTimer;
function toast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* ---------------- init ---------------- */

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

bindSelect('f-set', 'set', 'All sets', META.sets.map((s) => s.id),
  (id) => META.sets.find((s) => s.id === id).name);
bindSelect('f-domain', 'domain', 'All domains', META.domains, titleCase);
bindSelect('f-rarity', 'rarity', 'All rarities', META.rarities, titleCase);
bindSelect('f-type', 'type', 'All types', META.types);

render();
