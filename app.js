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
  const defaults = { showDetails: false, currency: 'USD', sort: '', packMuted: false };
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
  sort: '',
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

/* ---------------- sorting ---------------- */

/**
 * Default order is the order sync-cards.mjs wrote — set by set, oldest first,
 * ascending collector number — which is what the grid showed before there was
 * anything to sort by. It doubles as the tie-breaker for every other sort, so
 * cards sharing a price or a cost still come out in a stable, browsable order.
 */
const CARD_INDEX = new Map(CARDS.map((c, i) => [c.id, i]));
const byNumber = (a, b) => CARD_INDEX.get(a.id) - CARD_INDEX.get(b.id);

/**
 * Sorts on a numeric key, `dir` being 1 for ascending. Cards without the key —
 * no sales data, or a Rune with no energy cost — always sink to the bottom
 * instead of piling up at the top whenever the direction flips.
 */
const byNumeric = (key, dir) => (a, b) => {
  const x = key(a);
  const y = key(b);
  if (x == null || y == null) {
    if (x == null && y == null) return byNumber(a, b);
    return x == null ? 1 : -1;
  }
  return (x - y) * dir || byNumber(a, b);
};

const energyOf = (c) => c.stats?.energy ?? null;

// Card-type order follows how the deck panel groups them, which reads far
// better than alphabetical: the pieces you build around come first.
const TYPE_ORDER = ['Legend', 'Unit', 'Spell', 'Gear', 'Rune', 'Battlefield'];
const typeRank = (c) => {
  const i = TYPE_ORDER.indexOf(c.type);
  return i === -1 ? TYPE_ORDER.length : i;
};

/** `priced` options are dropped from the menu when no price file is loaded. */
const SORTS = [
  { id: '', label: 'Sort: Set order', cmp: byNumber },
  {
    id: 'price-desc',
    label: 'Sort: Price high → low',
    priced: true,
    cmp: byNumeric((c) => priceOf(c.id), -1),
  },
  {
    id: 'price-asc',
    label: 'Sort: Price low → high',
    priced: true,
    cmp: byNumeric((c) => priceOf(c.id), 1),
  },
  { id: 'cost-asc', label: 'Sort: Cost low → high', cmp: byNumeric(energyOf, 1) },
  { id: 'cost-desc', label: 'Sort: Cost high → low', cmp: byNumeric(energyOf, -1) },
  {
    id: 'type',
    label: 'Sort: Type',
    // Within a type the curve is the useful second axis, so group by cost too.
    cmp: (a, b) => typeRank(a) - typeRank(b) || byNumeric(energyOf, 1)(a, b),
  },
  {
    id: 'name',
    label: 'Sort: Name A → Z',
    cmp: (a, b) => a.name.localeCompare(b.name) || byNumber(a, b),
  },
].filter((s) => !s.priced || PRICE_DATA);

const sortCmp = (id) => (SORTS.find((s) => s.id === id) || SORTS[0]).cmp;

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
  const list = CARDS.filter(matches).sort(sortCmp(state.sort));
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
  // The dialogs trap focus; leave the browser's own find bar alone in there.
  if (deckModal.open || packModal.open) return;

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

/**
 * Sort order is a view preference rather than a filter, so it's remembered
 * between visits like the currency is. It still sits in the filter bar, so
 * Reset clears it along with everything else there.
 */
function bindSort() {
  const sel = el('f-sort');
  sel.innerHTML = SORTS.map(
    (s) => `<option value="${esc(s.id)}"${s.id === state.sort ? ' selected' : ''}>${esc(s.label)}</option>`
  ).join('');
  sel.classList.toggle('is-set', !!state.sort);

  sel.addEventListener('change', () => {
    state.sort = sel.value;
    prefs.sort = sel.value;
    savePrefs();
    sel.classList.toggle('is-set', !!state.sort);
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
  if (e.key === 'Escape' && menuOpen() && !deckModal.open && !packModal.open) setMenu(false);
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
  Object.assign(state, { q: '', set: '', domain: '', rarity: '', type: '', own: 'all', sort: '' });
  el('search').value = '';
  ['f-set', 'f-domain', 'f-rarity', 'f-type', 'f-sort'].forEach((id) => (el(id).value = ''));
  el('f-sort').classList.remove('is-set');
  prefs.sort = '';
  savePrefs();
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

/* ---------------- pack simulator ---------------- */

const PACK = window.RiftboundPack;
const packModal = el('pack-modal');
const packStage = el('pack-stage');
const PACK_SETS = PACK.openableSets(CARDS, META.sets);

/**
 * A pack is drawn, shown and dropped. Nothing it opens reaches the collection or
 * localStorage — the tally below lives in memory for the length of the visit so
 * the summary can put what you actually hit next to what the odds say, and a
 * reload wipes it. The odds themselves are the only lasting thing here, and
 * they're derived from the slot table rather than recorded.
 */
const packRun = { opened: 0, hits: {}, cards: 0 };

let packPhase = 'choose';
let packSetId = null;
let currentPack = null;
let packAt = -1;

/* --- sound. No binary assets and no network calls, so every effect is built
   out of oscillators and a noise buffer at the moment it plays. --- */

let actx = null;

/** Returns null when muted or unsupported, which every caller treats as silence. */
function audio() {
  if (prefs.packMuted) return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  // Constructed on the click that opens the modal — browsers refuse a context
  // that isn't traceable to a gesture, and a suspended one has to be resumed.
  actx ||= new Ctor();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

function tone(ctx, { freq, at = 0, dur = 0.3, type = 'triangle', gain = 0.16, to }) {
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  // Ramps are exponential, which can't reach or start from a true zero.
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.014);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

/** Filtered noise — the tearing foil, and the little click on a card turning. */
function noise(ctx, { at = 0, dur = 0.5, gain = 0.22, from = 2600, to = 400, q = 0.7 }) {
  const t0 = ctx.currentTime + at;
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, t0);
  filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(filter).connect(g).connect(ctx.destination);
  src.start(t0);
}

const sfx = {
  rip() {
    const ctx = audio();
    if (!ctx) return;
    noise(ctx, { dur: 0.55, gain: 0.3, from: 5200, to: 600, q: 0.5 });
    noise(ctx, { at: 0.1, dur: 0.4, gain: 0.16, from: 1800, to: 200 });
    tone(ctx, { freq: 180, to: 60, dur: 0.5, type: 'sine', gain: 0.14 });
  },
  flip() {
    const ctx = audio();
    if (!ctx) return;
    noise(ctx, { dur: 0.09, gain: 0.09, from: 4000, to: 1400, q: 1.2 });
  },
  /** The payoff. Each tier gets a longer, brighter arpeggio than the last. */
  hit(rarity) {
    const ctx = audio();
    if (!ctx) return;
    const notes = {
      rare: [659.25, 987.77],
      epic: [523.25, 659.25, 783.99, 1046.5],
      showcase: [523.25, 659.25, 783.99, 1046.5, 1318.5],
    }[rarity];
    if (!notes) return;

    const step = rarity === 'rare' ? 0.075 : 0.09;
    notes.forEach((f, i) =>
      tone(ctx, { freq: f, at: i * step, dur: 0.5, gain: 0.15, type: 'triangle' })
    );
    if (rarity === 'rare') return;

    // A held fifth under the run, and a shimmer on top of the best pulls.
    tone(ctx, { freq: 261.63, dur: 0.9, gain: 0.1, type: 'sine' });
    tone(ctx, {
      freq: notes[notes.length - 1] * 2,
      at: notes.length * step,
      dur: 1.1,
      gain: 0.07,
      type: 'sine',
    });
    if (rarity === 'showcase') {
      tone(ctx, { freq: 130.81, dur: 1.3, gain: 0.12, type: 'sine' });
    }
  },
};

/* --- stage --- */

const HYPE = new Set(['rare', 'epic', 'showcase']);
const pctText = (p) => (p >= 0.995 ? '~100%' : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`);

/** "1 in 1 packs" is nonsense, so the near-certain rarities get words instead. */
function oneIn(p) {
  if (p >= 0.995) return 'every pack';
  if (p >= 0.9) return 'almost every pack';
  return `1 in ${Math.round(1 / p)} packs`;
}

function packSetName(id) {
  return META.sets.find((s) => s.id === id)?.name || id;
}

/** Phase one: which set are we opening. */
function renderPackChoose() {
  const tiles = PACK_SETS.map((s) => {
    const odds = PACK.odds(CARDS, s.id);
    const inSet = CARDS.filter((c) => c.set_id === s.id).length;
    return `
      <button class="pack-pick" type="button" data-set="${esc(s.id)}">
        <span class="pack-mini" aria-hidden="true"><b>${esc(s.id)}</b></span>
        <span class="pack-pick-body">
          <span class="pack-pick-name">${esc(s.name)}</span>
          <span class="pack-pick-meta">${inSet} cards · released ${esc(s.released)}</span>
          <span class="pack-pick-odds">Epic ${oneIn(odds.epic)}${
            odds.showcase ? ` · Showcase ${oneIn(odds.showcase)}` : ''
          }</span>
        </span>
      </button>`;
  }).join('');

  packStage.innerHTML = `
    <div class="pack-choose">
      <p class="pack-lede">Pick a set. Packs follow the printed configuration —
        7 commons, 3 uncommons, 2 rare-or-better foils, 1 wildcard foil and a rune.</p>
      <div class="pack-picks">${tiles}</div>
      <p class="pack-note">Nothing you open is added to your collection or saved
        anywhere. Only the odds outlast the pack.</p>
    </div>`;
}

/** Phase two: the sealed wrapper, waiting to be torn. */
function renderPackSealed() {
  const name = packSetName(packSetId);
  packStage.innerHTML = `
    <div class="pack-sealed">
      <button class="booster" type="button" id="booster" aria-label="Tear open the pack">
        ${['top', 'bottom']
          .map(
            (half) => `
          <span class="booster-piece ${half}">
            <span class="booster-art">
              <span class="booster-brand">Riftbound</span>
              <span class="booster-set">${esc(name)}</span>
              <span class="booster-rune" aria-hidden="true"></span>
              <span class="booster-foot">Booster Pack</span>
            </span>
          </span>`
          )
          .join('')}
        <span class="booster-shine" aria-hidden="true"></span>
        ${Array.from({ length: 14 }, (_, i) => `<span class="shard s${i}"></span>`).join('')}
      </button>
      <p class="pack-hint">Tap the pack to rip it open</p>
    </div>`;
}

/** The hero card for the reveal, built fresh each time so the flip re-runs. */
function revealCardHTML(pull, i) {
  const c = pull.card;
  const p = priceOf(c.id);
  const hype = HYPE.has(c.rarity);
  const num = String(c.collector_number).padStart(3, '0') + (c.variant || '');

  return `
    <div class="reveal-card r-${esc(c.rarity)}${hype ? ' is-hype' : ''}" data-i="${i}">
      <div class="reveal-flip">
        <div class="reveal-face back" aria-hidden="true"><span class="back-rune"></span></div>
        <div class="reveal-face front">
          <img src="${esc(c.image || '')}" alt="${esc(c.name)}" decoding="async">
        </div>
      </div>
      <div class="reveal-info">
        <span class="reveal-rarity">${esc(c.rarity)}</span>
        <span class="reveal-name">${esc(c.name)}</span>
        <span class="reveal-sub">${esc(c.set_id)}-${esc(num)} · ${esc(pull.slot)} slot${
          p == null ? '' : ` · <b>${money(p)}</b>`
        }</span>
      </div>
      ${hype ? '<div class="burst" aria-hidden="true"></div>' : ''}
    </div>`;
}

function renderPackReveal() {
  packStage.innerHTML = `
    <div class="pack-reveal" id="pack-reveal">
      <div class="reveal-slot" id="reveal-slot"></div>
      <div class="reveal-strip" id="reveal-strip"></div>
      <div class="reveal-foot">
        <span class="reveal-count" id="reveal-count"></span>
        <p class="pack-hint">Click, tap or press <kbd>Space</kbd> for the next card</p>
        <button class="btn btn-quiet" type="button" data-act="reveal-all">Reveal all</button>
      </div>
    </div>`;
  advanceReveal();
}

/** Turns over the next card, or moves to the summary once the pack is spent. */
function advanceReveal() {
  if (!currentPack) return;
  if (packAt >= currentPack.cards.length - 1) {
    showPackSummary();
    return;
  }

  packAt++;
  const pull = currentPack.cards[packAt];
  const slot = el('reveal-slot');
  slot.innerHTML = revealCardHTML(pull, packAt);
  el('reveal-count').textContent = `${packAt + 1} / ${currentPack.cards.length}`;

  const node = slot.firstElementChild;
  // The card mounts face-down; flipping on the next frame is what makes the
  // transition run at all, and it's the beat the sound has to land on.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      node.classList.add('is-open');
      if (HYPE.has(pull.card.rarity)) sfx.hit(pull.card.rarity);
      else sfx.flip();
    });
  });

  const strip = el('reveal-strip');
  strip.insertAdjacentHTML(
    'beforeend',
    `<span class="strip-dot r-${esc(pull.card.rarity)}" title="${esc(pull.card.name)}"></span>`
  );
}

function revealAll() {
  if (!currentPack) return;
  const best = currentPack.cards
    .slice(packAt + 1)
    .map((p) => p.card.rarity)
    .filter((r) => HYPE.has(r))
    .sort((a, b) => PACK.LADDER.indexOf(b) - PACK.LADDER.indexOf(a))[0];
  if (best) sfx.hit(best);
  packAt = currentPack.cards.length - 1;
  showPackSummary();
}

function showPackSummary() {
  packPhase = 'summary';
  const odds = PACK.odds(CARDS, packSetId);
  const counts = currentPack.counts;

  // Counted here rather than at open time so "Reveal all" and a walked-through
  // pack tally identically, and an abandoned pack doesn't count at all.
  packRun.opened++;
  packRun.cards += currentPack.cards.length;
  for (const [r, n] of Object.entries(counts)) packRun.hits[r] = (packRun.hits[r] || 0) + n;

  const value = PRICE_DATA
    ? currentPack.cards.reduce((n, p) => n + (priceOf(p.card.id) || 0), 0)
    : null;

  const cards = currentPack.cards
    .map(
      (p) => `
      <figure class="sum-card r-${esc(p.card.rarity)}">
        <img src="${esc(p.card.image || '')}" alt="${esc(p.card.name)}" loading="lazy">
        <figcaption>${esc(p.card.name)}</figcaption>
      </figure>`
    )
    .join('');

  // The one number worth keeping: what the slot table pays out, per rarity.
  const rows = [...PACK.LADDER]
    .reverse()
    .filter((r) => odds[r] != null)
    .map((r) => {
      const got = counts[r] || 0;
      const seen = packRun.hits[r] || 0;
      return `
        <tr${got ? ' class="is-hit"' : ''}>
          <th><span class="dot r-${esc(r)}"></span>${esc(titleCase(r))}</th>
          <td>${pctText(odds[r])}</td>
          <td class="oi">${oneIn(odds[r])}</td>
          <td>${got || '—'}</td>
          <td class="run">${seen || '—'}</td>
        </tr>`;
    })
    .join('');

  const best = currentPack.cards
    .map((p) => p.card.rarity)
    .sort((a, b) => PACK.LADDER.indexOf(b) - PACK.LADDER.indexOf(a))[0];

  packStage.innerHTML = `
    <div class="pack-summary">
      <div class="sum-head">
        <span class="sum-best r-${esc(best)}">${esc(titleCase(best))} pull</span>
        <h3>${esc(packSetName(packSetId))} — ${currentPack.cards.length} cards</h3>
        ${value == null ? '' : `<span class="sum-value">${money(value)} of cardboard</span>`}
      </div>

      <div class="sum-cards">${cards}</div>

      <div class="sum-odds">
        <h4>Chance of hitting each rarity in a pack</h4>
        <table>
          <thead>
            <tr><th>Rarity</th><th>Per pack</th><th class="oi">Roughly</th><th>This pack</th>
                <th class="run">Session (${packRun.opened})</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="pack-note">Odds are computed from the slot table, not tracked.
          The session column is counted in memory and is gone on reload — no pull
          is written to your collection or saved anywhere.</p>
      </div>

      <div class="sum-actions">
        <button class="btn btn-pack" type="button" data-act="again">Open another ${esc(packSetId)}</button>
        <button class="btn" type="button" data-act="choose">Different set</button>
        <button class="btn btn-quiet" type="button" data-act="close">Done</button>
      </div>
    </div>`;
}

function openPackFor(setId) {
  packSetId = setId;
  packPhase = 'sealed';
  currentPack = PACK.openPack({ cards: CARDS, setId });
  packAt = -1;
  el('pack-title').textContent = `${packSetName(setId)} booster`;
  renderPackSealed();
}

function packChoose() {
  packPhase = 'choose';
  currentPack = null;
  packSetId = null;
  packAt = -1;
  el('pack-title').textContent = 'Open a pack';
  renderPackChoose();
}

/** The tear, then the cards. The delay is the animation's own length. */
function ripPack() {
  if (packPhase !== 'sealed') return;
  packPhase = 'ripping';
  el('booster').classList.add('is-torn');
  sfx.rip();
  setTimeout(() => {
    if (packPhase !== 'ripping') return; // closed mid-tear
    packPhase = 'reveal';
    renderPackReveal();
  }, 950);
}

el('btn-pack').addEventListener('click', () => {
  setMenu(false);
  // Touching the context inside the opening gesture keeps later sounds allowed.
  audio();
  if (!PACK_SETS.length) {
    toast('No set in the data has enough cards to fill a pack');
    return;
  }
  packChoose();
  packModal.showModal();
});

packStage.addEventListener('click', (e) => {
  const pick = e.target.closest('.pack-pick');
  if (pick) {
    openPackFor(pick.dataset.set);
    return;
  }
  if (e.target.closest('#booster')) {
    ripPack();
    return;
  }

  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'reveal-all') return revealAll();
  if (act === 'again') return openPackFor(packSetId);
  if (act === 'choose') return packChoose();
  if (act === 'close') return packModal.close();

  // Anywhere else on the stage during the reveal turns the next card over.
  if (packPhase === 'reveal') advanceReveal();
});

el('pack-close').addEventListener('click', () => packModal.close());

el('pack-mute').addEventListener('click', () => {
  prefs.packMuted = !prefs.packMuted;
  savePrefs();
  syncMuteBtn();
});

function syncMuteBtn() {
  const btn = el('pack-mute');
  btn.textContent = prefs.packMuted ? '🔇' : '🔊';
  btn.setAttribute('aria-pressed', String(prefs.packMuted));
  btn.title = prefs.packMuted ? 'Unmute pack sounds' : 'Mute pack sounds';
}

// Space and the arrows are how you'd click through a pack without a mouse.
// Bound to the document rather than the dialog: rendering the next phase
// discards whatever had focus, and focus lands back on <body> — outside the
// dialog's subtree — so a listener on the modal would stop hearing keys.
document.addEventListener('keydown', (e) => {
  if (!packModal.open || packPhase !== 'reveal') return;
  if (e.key !== ' ' && e.key !== 'Enter' && e.key !== 'ArrowRight') return;
  // Buttons on the stage keep their own activation.
  if (e.target.closest?.('button')) return;
  e.preventDefault();
  advanceReveal();
});

// Leaving mid-pack drops it — there's nothing to save, so nothing to warn about.
packModal.addEventListener('close', () => {
  packPhase = 'choose';
  currentPack = null;
  packStage.innerHTML = '';
});

packModal.addEventListener('click', (e) => {
  if (e.target === packModal) packModal.close();
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

// A remembered sort can name an option that isn't offered — a price order saved
// before data/prices.js went missing — so fall back rather than showing nothing.
state.sort = SORTS.some((s) => s.id === prefs.sort) ? prefs.sort : '';
bindSort();
syncMuteBtn();

render();
