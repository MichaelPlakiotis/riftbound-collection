/* Riftbound collection tracker — local-only, state lives in localStorage. */

const STORAGE_KEY = 'riftbound-collection-v1';
const PREFS_KEY = 'riftbound-prefs-v1';
const DATA = window.RIFTBOUND_DATA;

if (!DATA) {
  document.body.innerHTML =
    '<p style="padding:40px;font-family:sans-serif;color:#e6edf3">' +
    'Card data missing. Run <code>node sync-cards.mjs</code> first.</p>';
  throw new Error('data/cards.js not loaded');
}

const CARDS = DATA.cards;
const META = DATA.meta;

// Prices are optional — the app works without ever running sync-prices.mjs.
const PRICE_DATA = window.RIFTBOUND_PRICES || null;
const PRICES = PRICE_DATA?.prices || {};
const PRICE_META = PRICE_DATA?.meta || null;

const priceOf = (id) => (typeof PRICES[id]?.m === 'number' ? PRICES[id].m : null);
const prevPriceOf = (id) => (typeof PRICES[id]?.p === 'number' ? PRICES[id].p : null);

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

/** UI preferences, kept apart from the collection so exports stay portable. */
const prefs = loadPrefs();

function loadPrefs() {
  const defaults = { showDetails: false, currency: 'USD' };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* preferences are cosmetic — a full quota shouldn't interrupt anything */
  }
}

/* ---------------- currency ---------------- */

/**
 * Every price in the data file is a TCGplayer market price in US dollars.
 * sync-prices.mjs bakes a USD→EUR/GBP rate into the price meta, so a reader can
 * see the worth in their own money without the page calling out to anything.
 * Converted figures are still US market prices — they are not Cardmarket, which
 * is a genuinely different market. The UI labels the rate and its date.
 */
const RATES = { USD: 1, ...(PRICE_META?.rates || {}) };
const CURRENCIES = { USD: '$', EUR: '€', GBP: '£' };
const CURRENCY_CODES = Object.keys(CURRENCIES).filter((c) => RATES[c] > 0);

let currency = CURRENCY_CODES.includes(prefs.currency) ? prefs.currency : 'USD';

// Formatters are cached: money() runs once per card per render, and rebuilding
// an Intl.NumberFormat 1300 times shows up on every keystroke in the search box.
const fmtCache = {};
const fmt = (code, decimals) =>
  (fmtCache[`${code}${decimals}`] ||= new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }));

/** Formats a USD figure in whichever currency is selected. */
function money(usd) {
  const v = usd * RATES[currency];
  // Past a thousand the cents are noise on a figure that moves daily.
  return fmt(currency, v >= 1000 ? 0 : 2).format(v);
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

/**
 * Market price plus the move since the previous sync. The stack value only shows
 * once you own more than one, otherwise it just repeats the unit price.
 */
function priceHTML(c, q) {
  if (!PRICE_DATA) return '';
  const p = priceOf(c.id);
  if (p == null) {
    return `<div class="card-price"><span class="price none" title="No TCGplayer sales data for this card">—</span></div>`;
  }

  const was = prevPriceOf(c.id);
  let delta = '';
  if (was && was > 0) {
    const pct = Math.round(((p - was) / was) * 100);
    // A penny of rounding on a $0.05 common reads as ±20%, so a move has to
    // clear both a cash and a percentage floor before it's worth showing.
    if (Math.abs(pct) >= 3 && Math.abs(p - was) >= 0.05) {
      delta =
        `<span class="delta ${pct > 0 ? 'up' : 'down'}" ` +
        `title="Was ${money(was)} on ${esc(PRICE_META.previousSync || 'the last sync')}">` +
        `${pct > 0 ? '↑' : '↓'}${Math.abs(pct)}%</span>`;
    }
  }

  const stack = q > 1 ? `<span class="stack" title="${q} copies">${money(p * q)}</span>` : '';
  return `<div class="card-price"><span class="price" title="TCGplayer market price, ${esc(
    PRICE_META.synced
  )}">${money(p)}</span>${delta}${stack}</div>`;
}

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
        ${priceHTML(c, q)}
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
  updateFilterBadge();
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

  // The stack total depends on the count, so this row has to be redrawn too.
  const priceRow = node.querySelector('.card-price');
  if (priceRow) {
    const card = CARDS.find((c) => c.id === id);
    priceRow.outerHTML = priceHTML(card, q);
  }

  renderStats();
}

/* ---------------- stats ---------------- */

/**
 * Worth of everything owned, promos included — they sit outside set completion
 * but they're still money on the shelf. Also returns the per-card line values,
 * which the breakdown panel reuses rather than walking the collection twice.
 */
function collectionValue() {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  const lines = [];

  for (const c of CARDS) {
    const q = qtyOf(c.id);
    if (!q) continue;
    const p = priceOf(c.id);
    if (p == null) {
      unpriced += q;
      continue;
    }
    priced += q;
    const line = p * q;
    total += line;
    lines.push({ card: c, q, unit: p, line });
  }

  lines.sort((a, b) => b.line - a.line);
  return { total, priced, unpriced, lines };
}

function renderStats() {
  const uniqueOwned = COLLECTABLE.filter((c) => qtyOf(c.id) > 0).length;
  const totalCopies = COLLECTABLE.reduce((n, c) => n + qtyOf(c.id), 0);
  const wishCount = COLLECTABLE.filter((c) => wishOf(c.id)).length;
  const pct = COLLECTABLE.length
    ? Math.round((uniqueOwned / COLLECTABLE.length) * 100)
    : 0;

  const open = prefs.showDetails;
  const val = PRICE_DATA ? collectionValue() : null;

  // One control for the lot: the worth chip is also the handle for the panel
  // holding set progress and the per-card value breakdown. Without a price sync
  // there's no figure to show, so the handle falls back to a plain label.
  const toggleHTML = val
    ? `<button type="button" class="stat-value" id="stat-toggle" aria-expanded="${open}"
          aria-controls="stats-panel"
          title="TCGplayer market value of every copy you own${
            val.unpriced ? ` · ${val.unpriced} copies have no price data` : ''
          }. Click for set progress and the breakdown.">
         <span class="stat-value-label">Collection worth</span>
         <span class="stat-value-num">${money(val.total)}</span>
         <span class="stat-caret" aria-hidden="true">${open ? '▴' : '▾'}</span>
       </button>`
    : `<button type="button" class="stat-value is-bare" id="stat-toggle" aria-expanded="${open}"
          aria-controls="stats-panel" title="Completion per set">
         <span class="stat-value-label">Set progress</span>
         <span class="stat-caret" aria-hidden="true">${open ? '▴' : '▾'}</span>
       </button>`;

  // Only worth offering when the price file carries a rate to convert with.
  const currencyHTML =
    CURRENCY_CODES.length > 1
      ? `<select id="cur-sel" class="sel sel-cur" aria-label="Display currency"
            title="Prices come from TCGplayer in US dollars${
              PRICE_META.ratesDate
                ? `. Other currencies are converted at the rate of ${esc(PRICE_META.ratesDate)}, not sourced from a European marketplace`
                : ''
            }">${CURRENCY_CODES.map(
              (c) =>
                `<option value="${c}"${c === currency ? ' selected' : ''}>${c} ${CURRENCIES[c]}</option>`
            ).join('')}</select>`
      : '';

  el('statline').innerHTML =
    toggleHTML +
    currencyHTML +
    `<span><b>${uniqueOwned}</b> / ${COLLECTABLE.length} unique <span class="pct">(${pct}%)</span></span>` +
    `<span><b>${totalCopies}</b> total copies</span>` +
    `<span><b>${wishCount}</b> on wishlist</span>`;

  const panel = el('stats-panel');
  panel.hidden = !open;
  // Emptied rather than just hidden — the breakdown holds card thumbnails, and
  // there's no reason to keep them (or a stale total) parked in the document.
  if (!open) {
    panel.innerHTML = '';
    return;
  }

  const setValue = {};
  for (const line of val?.lines || []) {
    setValue[line.card.set_id] = (setValue[line.card.set_id] || 0) + line.line;
  }

  const sets = META.sets
    .map((s) => {
      // Per-set rows count every card in the set, promos included — the promo
      // exclusion only applies to the overall completion figure above.
      const inSet = CARDS.filter((c) => c.set_id === s.id);
      const owned = inSet.filter((c) => qtyOf(c.id) > 0).length;
      const p = inSet.length ? Math.round((owned / inSet.length) * 100) : 0;
      const worth = setValue[s.id];
      const active = state.set === s.id;
      return `
        <button type="button" class="setrow${s.promo ? ' is-promo' : ''}${
          active ? ' is-active' : ''
        }" data-set="${esc(s.id)}" aria-pressed="${active}"
          title="${active ? 'Show all sets again' : `Show only ${esc(s.name)}`}">
          <span class="setrow-name">${esc(s.name)} <small>${esc(s.id)}</small></span>
          <span class="setrow-num">${owned} / ${inSet.length} · ${p}%${
            worth ? ` · <b>${money(worth)}</b>` : ''
          }</span>
          <span class="bar"><span class="bar-fill" style="width:${p}%"></span></span>
        </button>`;
    })
    .join('');

  panel.innerHTML = (val ? valuePanelHTML(val) : '') + sets;
}

/** Headline worth, what it's made of, and the cards actually carrying it. */
function valuePanelHTML(val) {
  const top = val.lines.slice(0, 8);
  const topShare = top.reduce((n, l) => n + l.line, 0);
  const share = val.total ? Math.round((topShare / val.total) * 100) : 0;

  const rows = top
    .map(
      (l) => `
      <li>
        <img src="${esc(l.card.image || '')}" alt="" loading="lazy" decoding="async">
        <span class="vl-name">${esc(l.card.name)}</span>
        <span class="vl-qty">${l.q}×</span>
        <span class="vl-unit">${money(l.unit)}</span>
        <span class="vl-line">${money(l.line)}</span>
      </li>`
    )
    .join('');

  return `
    <div class="value-panel">
      <div class="value-head">
        <span class="value-label">Collection worth</span>
        <span class="value-big">${money(val.total)}</span>
        <span class="value-meta">
          ${val.priced.toLocaleString('en-US')} copies priced${
            val.unpriced ? ` · ${val.unpriced} with no sales data` : ''
          }<br>
          TCGplayer market, ${esc(PRICE_META.synced)}${
            currency === 'USD'
              ? ''
              : `<br>Converted from USD at ${RATES[currency]} ${esc(currency)}/USD${
                  PRICE_META.ratesDate ? `, ${esc(PRICE_META.ratesDate)}` : ''
                }`
          }
        </span>
      </div>
      ${
        top.length
          ? `<div class="value-top">
               <h4>Most valuable — ${share}% of the total</h4>
               <ol class="value-list">${rows}</ol>
             </div>`
          : `<div class="value-top"><h4>Nothing owned yet</h4></div>`
      }
    </div>`;
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
  // The deck dialog traps focus; leave the browser's own find bar alone there.
  if (deckModal.open) return;

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

// The chip is rebuilt on every quantity change, so delegate from the statline.
el('statline').addEventListener('click', (e) => {
  if (!e.target.closest('#stat-toggle')) return;
  prefs.showDetails = !prefs.showDetails;
  savePrefs();
  renderStats();
  if (prefs.showDetails) {
    // The dropdown sits on top of the panel it just opened, so get out of the way.
    setMenu(false);
    el('stats-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});

// Every card carries a price, so a currency change is a full re-render, not
// just a header repaint. The select is rebuilt with the statline, hence delegation.
el('statline').addEventListener('change', (e) => {
  if (e.target.id !== 'cur-sel') return;
  currency = e.target.value;
  prefs.currency = currency;
  savePrefs();
  render();
});

/* ---------------- burger menu (narrow layout) ---------------- */

const menuBtn = el('btn-menu');
const topPanel = el('topbar-panel');
const wideLayout = window.matchMedia('(min-width: 761px)');

const menuOpen = () => topPanel.classList.contains('is-open');

function setMenu(open) {
  topPanel.classList.toggle('is-open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
}

menuBtn.addEventListener('click', () => setMenu(!menuOpen()));

// Anything outside the header dismisses it, the way a dropdown should.
document.addEventListener('click', (e) => {
  if (menuOpen() && !e.target.closest('.topbar')) setMenu(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuOpen() && !deckModal.open) setMenu(false);
});

// On the wide layout the panel is always visible, so a stale open flag would
// leave the burger claiming to be expanded once you rotate or resize.
wideLayout.addEventListener('change', (e) => {
  if (e.matches) setMenu(false);
});

/**
 * How many filters are narrowing the grid. The search box stays visible when
 * the menu is shut, so it isn't counted — everything hidden behind the burger is.
 */
function updateFilterBadge() {
  const n =
    [state.set, state.domain, state.rarity, state.type].filter(Boolean).length +
    (state.own === 'all' ? 0 : 1) +
    (state.hidePromos ? 0 : 1);

  const badge = el('menu-badge');
  badge.textContent = n;
  badge.hidden = n === 0;
}

// Set rows double as a filter — clicking one narrows the grid to that set,
// clicking the active one goes back to everything.
el('stats-panel').addEventListener('click', (e) => {
  const row = e.target.closest('.setrow');
  if (!row) return;
  state.set = state.set === row.dataset.set ? '' : row.dataset.set;
  el('f-set').value = state.set;
  render();
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

/* ---------------- deck generator ---------------- */

const deckModal = el('deck-modal');
let currentDeck = null;

const CURVE_LABELS = { 2: '≤2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7+' };

function domainDots(card) {
  return card.domains
    .map((d) => `<span class="dot" style="background:var(--f-${esc(d)}, #7d8896)" title="${esc(d)}"></span>`)
    .join('');
}

function deckRow(pick) {
  const c = pick.entry.card;
  const p = priceOf(c.id);
  const energy = c.stats.energy;
  return `
    <li class="deck-row">
      <span class="deck-count">${pick.count}×</span>
      <img class="deck-thumb" src="${esc(c.image || '')}" alt="" loading="lazy" decoding="async">
      <span class="deck-row-name">${esc(pick.name)}</span>
      <span class="deck-dots">${domainDots(c)}</span>
      <span class="deck-energy">${
        energy == null ? '' : `<b title="Energy cost">${energy}</b>`
      }</span>
      <span class="deck-row-price">${p == null ? '—' : money(p * pick.count)}</span>
    </li>`;
}

function deckSection(title, picks) {
  if (!picks.length) return '';
  const n = picks.reduce((a, b) => a + b.count, 0);
  return `
    <section class="deck-section">
      <h3>${esc(title)} <span>${n}</span></h3>
      <ul>${picks.map(deckRow).join('')}</ul>
    </section>`;
}

function renderDeck() {
  const body = el('deck-body');
  const deck = currentDeck;

  if (!deck?.ok) {
    el('deck-sub').textContent = '';
    body.innerHTML = `<p class="deck-empty">${esc(deck?.reason || 'Could not build a deck.')}</p>
      <p class="deck-empty-hint">Mark the cards you own with the <b>+</b> buttons first — the
      generator only ever uses copies you actually have.</p>`;
    el('deck-copy').disabled = true;
    return;
  }

  el('deck-copy').disabled = false;
  el('deck-sub').innerHTML =
    `${esc(deck.legendName)} · ${deck.identity.map((d) => `<span class="dot" ` +
      `style="background:var(--f-${esc(d)})"></span>${esc(titleCase(d))}`).join(' ')}`;

  const maxCurve = Math.max(1, ...Object.values(deck.curve));
  const curve = Object.keys(CURVE_LABELS)
    .map((k) => {
      const n = deck.curve[k] || 0;
      return `<div class="curve-col" title="${n} card${n === 1 ? '' : 's'} at ${CURVE_LABELS[k]} energy">
        <div class="curve-bar" style="height:${Math.round((n / maxCurve) * 100)}%"></div>
        <span class="curve-n">${n}</span><span class="curve-k">${CURVE_LABELS[k]}</span></div>`;
    })
    .join('');

  const runeSplit = Object.entries(deck.runeSplit || {})
    .map(([d, n]) => `<span class="dot" style="background:var(--f-${esc(d)})"></span>${n}`)
    .join(' ');

  const status = deck.complete
    ? `<p class="deck-status ok">Legal 40-card deck — every rule checks out.</p>`
    : `<ul class="deck-status warn">${deck.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;

  const main = deck.main.filter((p) => !p.chosen);
  const of = (t) => main.filter((p) => p.entry.card.type === t);

  body.innerHTML = `
    <div class="deck-stats">
      <div><b>${deck.counts.main}</b>/40 main</div>
      <div><b>${deck.counts.units}</b> units</div>
      <div><b>${deck.counts.runes}</b>/12 runes ${runeSplit}</div>
      <div><b>${deck.counts.battlefields}</b>/3 battlefields</div>
      ${PRICE_DATA ? `<div><b class="pct">${money(deck.value)}</b> deck value</div>` : ''}
    </div>
    ${status}
    <div class="deck-curve">${curve}</div>
    <div class="deck-columns">
      ${deckSection('Legend', [{ name: deck.legendName, entry: deck.legendEntry, count: 1 }])}
      ${deckSection('Chosen Champion', deck.main.filter((p) => p.chosen))}
      ${deckSection('Units', of('Unit'))}
      ${deckSection('Spells', of('Spell'))}
      ${deckSection('Gear', of('Gear'))}
      ${deckSection('Runes', deck.runes)}
      ${deckSection('Battlefields', deck.battlefields)}
    </div>
    <p class="deck-note">Card choices are a heuristic — legality is exact, but which
    of your legal cards are <em>best</em> together is a judgement call the generator
    approximates from rarity, champion tags, energy curve and keyword density.</p>`;
}

function buildDeck(legendId = null) {
  currentDeck = window.RiftboundDeck.buildDeck({
    cards: CARDS,
    qtyOf,
    priceOf,
    legendId,
  });

  const sel = el('deck-legend');
  const legends = currentDeck.legends || [];
  sel.innerHTML =
    `<option value="">Best legend (auto)</option>` +
    legends
      .map((l) => `<option value="${esc(l.card.id)}">${esc(l.name)}</option>`)
      .join('');
  sel.value = legendId || '';
  sel.hidden = legends.length < 2;

  renderDeck();
}

el('btn-deck').addEventListener('click', () => {
  setMenu(false);
  buildDeck();
  deckModal.showModal();
});

el('deck-legend').addEventListener('change', (e) => buildDeck(e.target.value || null));
el('deck-close').addEventListener('click', () => deckModal.close());

el('deck-copy').addEventListener('click', async () => {
  const text = window.RiftboundDeck.toText(currentDeck);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Decklist copied');
  } catch {
    // Clipboard needs a secure context; fall back to a download.
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'riftbound-deck.txt';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Decklist downloaded');
  }
});

// Clicking the backdrop closes, matching how the rest of the page behaves.
deckModal.addEventListener('click', (e) => {
  if (e.target === deckModal) deckModal.close();
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
