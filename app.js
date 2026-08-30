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

/**
 * Two markets, not one currency in two units. TCGplayer sells in US dollars and
 * Cardmarket in euros, and the same card genuinely differs between them — often
 * far past any exchange rate. So EUR shows Cardmarket's own figure where there
 * is one, and USD/GBP stay TCGplayer converted at the stored ECB rate.
 *
 * Every accessor below therefore returns a number *already in the selected
 * currency*, and money() only formats. Mixing a converted price into a
 * Cardmarket view would be the one genuinely wrong thing to do.
 */
const onCardmarket = () => currency === 'EUR' && !!PRICE_META?.cardmarket;

/** 'cm' when this card's figure is a real Cardmarket one, 'tcg' otherwise. */
const priceSourceOf = (id) =>
  onCardmarket() && typeof PRICES[id]?.cm === 'number' ? 'cm' : 'tcg';

/** Reads one of the price fields and puts it in the selected currency. */
function inCurrency(id, cmKey, usdKey) {
  const e = PRICES[id];
  if (!e) return null;
  if (onCardmarket() && typeof e[cmKey] === 'number') return e[cmKey];
  return typeof e[usdKey] === 'number' ? e[usdKey] * RATES[currency] : null;
}

const priceOf = (id) => inCurrency(id, 'cm', 'm');
const prevPriceOf = (id) => inCurrency(id, 'cmp', 'p');
/** Foil price. Falls back to the normal one so a foil is never valued at nothing. */
const foilPriceOf = (id) => inCurrency(id, 'cmf', 'f') ?? priceOf(id);

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
  saveTimer = setTimeout(persist, 150);
}

/**
 * Writes the collection out now. `fromCloud` marks a write that *came from* the
 * server, so sync doesn't echo it straight back as a fresh local change.
 */
function persist({ fromCloud = false } = {}) {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
  } catch (err) {
    toast('Could not save — storage may be full');
  }
  if (!fromCloud) window.RiftboundCloud?.onLocalChange?.();
}

const KNOWN_IDS = new Set(CARDS.map((c) => c.id));

/**
 * Coerces arbitrary parsed JSON into the collection shape. Shared by the file
 * importer and by cloud sync — neither should trust what it's handed, and both
 * want unknown ids dropped rather than carried around forever.
 */
function sanitize(incoming) {
  const clean = {};
  let skipped = 0;
  for (const [id, v] of Object.entries(incoming || {})) {
    if (!KNOWN_IDS.has(id)) { skipped++; continue; }
    const q = Math.min(99, Math.max(0, parseInt(v?.q, 10) || 0));
    const f = Math.min(99, Math.max(0, parseInt(v?.f, 10) || 0));
    const w = !!v?.w;
    if (q > 0 || f > 0 || w) clean[id] = { q, f, w };
  }
  return { clean, skipped };
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

/**
 * Formats a figure that is already in the selected currency — the price
 * accessors convert (or don't) at the point they read the data, since a
 * Cardmarket euro must never be multiplied by an exchange rate.
 */
function money(v) {
  // Past a thousand the cents are noise on a figure that moves daily.
  return fmt(currency, v >= 1000 ? 0 : 2).format(v);
}

/* ---------------- visiting another collector ---------------- */

/**
 * Someone else's public collection, shown in place of your own — `{ handle,
 * data, updatedAt }`, or null when you're looking at your own.
 *
 * Every read of "how many of this card are there" in the whole app goes through
 * the four accessors below, so pointing them at a guest's data turns the grid,
 * the search box, all six filters, the sorts, the set-progress panel and the
 * value breakdown into a reader for that collection. That's the entire reason
 * this is one variable rather than a second screen: a visiting view built out of
 * its own markup would have to grow its own copy of all of it.
 *
 * The one thing that must never follow is a write. setEntry refuses while this
 * is set, and cloud.js is never handed a guest's data to push.
 */
let viewing = null;

/** The collection every read resolves against — theirs while visiting. */
const shown = () => viewing?.data || collection;

/**
 * `q` counts ordinary copies and `f` counts foils. They're separate because
 * foils price separately — often several times the normal card — so folding
 * them into one number would misstate what a collection is worth. An entry
 * saved before foils existed simply has no `f`, which reads as zero.
 */
const qtyOf = (id) => shown()[id]?.q || 0;
const foilOf = (id) => shown()[id]?.f || 0;
/** Every physical copy of a card, foil or not — what "do I own this" means. */
const copiesOf = (id) => qtyOf(id) + foilOf(id);
const wishOf = (id) => !!shown()[id]?.w;

function setEntry(id, patch) {
  // A visitor's binder is read-only. Every control that reaches here is hidden
  // while visiting; this is the backstop for a stale node or a keyboard route
  // into one, and it guarantees the guard lives next to the write rather than
  // being re-argued at each of the four call sites.
  if (viewing) return;

  const cur = collection[id] || { q: 0, f: 0, w: false };
  const next = { ...cur, ...patch };
  const q = Math.max(0, next.q | 0);
  const f = Math.max(0, next.f | 0);
  if (q <= 0 && f <= 0 && !next.w) delete collection[id];
  else collection[id] = { q, f, w: !!next.w };
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

  // A foil-only card is still a card you own, so these count both columns.
  const q = copiesOf(c.id);
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
  {
    id: 'qty-desc',
    label: 'Sort: Quantity high → low',
    // Every physical copy, foils included — the number on the tile's badge. The
    // reverse isn't offered: it would open on a thousand cards you own none of.
    // The grid re-sorts on the next filter change rather than while you tap
    // +/−, so a stack you're counting out doesn't slide away under the cursor.
    cmp: byNumeric((c) => copiesOf(c.id), -1),
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
 * "A rune of any domain" — the game's own rainbow rune — as a CSS paint. Kept
 * beside the single-domain form below so the rules text, the card dots and the
 * domain filter can't drift into three different sets of rune colours.
 */
const RAINBOW_RUNE =
  'conic-gradient(var(--f-fury),var(--f-order),var(--f-body),' +
  'var(--f-calm),var(--f-mind),var(--f-chaos),var(--f-fury))';

/** The colour of one domain's rune. An unknown domain falls back to colourless. */
const runePaint = (domain) =>
  domain === 'rainbow' ? RAINBOW_RUNE : `var(--f-${esc(domain)}, var(--f-colorless))`;

/**
 * Market price plus the move since the previous sync. The stack value only shows
 * once you own more than one, otherwise it just repeats the unit price.
 */
function priceHTML(c, q, f = 0) {
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

  // Foils are their own market — usually dearer — so the stack is priced in two
  // parts rather than multiplying everything by the normal price.
  const fp = foilPriceOf(c.id);
  const worth = p * q + (fp ?? 0) * f;
  const copies = q + f;
  const stackTitle = f
    ? `${q} normal at ${money(p)} + ${f} foil at ${money(fp ?? 0)}`
    : `${copies} copies`;
  const stack =
    copies > 1 ? `<span class="stack" title="${esc(stackTitle)}">${money(worth)}</span>` : '';

  // Only shown when the selected market quotes a foil of its own, rather than
  // repeating the normal price with a sparkle on it.
  const cm = priceSourceOf(c.id) === 'cm';
  const ownFoil = typeof PRICES[c.id]?.[cm ? 'cmf' : 'f'] === 'number';
  const market = cm ? 'Cardmarket' : 'TCGplayer';
  const foilNote = ownFoil
    ? `<span class="price-foil" title="${market} foil price">${money(foilPriceOf(c.id))}✦</span>`
    : '';

  return `<div class="card-price"><span class="price" title="${market} price, ${esc(
    PRICE_META.synced
  )}">${money(p)}</span>${delta}${foilNote}${stack}</div>`;
}

function cardHTML(c) {
  const q = qtyOf(c.id);
  const f = foilOf(c.id);
  const copies = q + f;
  const w = wishOf(c.id);
  const img = c.image || c.image_full || '';
  const num = String(c.collector_number).padStart(3, '0') + (c.variant ? c.variant : '');
  const dots = c.domains
    .map(
      (d) => `<span class="dot" style="background:${runePaint(d)}" title="${esc(d)}"></span>`
    )
    .join('');

  return `
    <article class="card ${copies > 0 ? 'is-owned' : ''} ${w ? 'is-wish' : ''}" data-id="${esc(c.id)}">
      <div class="card-img" data-act="detail" title="${esc(c.name)} — click for details">
        ${
          img
            ? `<img src="${esc(img)}" alt="${esc(c.name)}" loading="lazy" decoding="async">`
            : // Cards the sync built from TCGplayer have no art to link to.
              `<div class="card-noart" title="No art available for this card yet">
                 <span class="noart-name">${esc(c.name)}</span>
                 <span class="noart-note">no art yet</span>
               </div>`
        }
        <span class="qty-badge" ${copies > 0 ? '' : 'hidden'}>${copies}</span>
        <span class="foil-badge" ${f > 0 ? '' : 'hidden'} title="${f} foil${f === 1 ? '' : 's'}">${f}✦</span>
        ${
          viewing
            ? // Their wishlist is worth seeing — it's half of why you'd look —
              // but as a mark, not a control you could press.
              w
              ? `<span class="wish-mark" title="On ${esc(viewing.handle)}'s wishlist">★</span>`
              : ''
            : `<button class="wish-btn ${w ? 'on' : ''}" type="button"
                data-act="wish" title="Toggle wishlist"
                aria-label="Toggle wishlist for ${esc(c.name)}"
                aria-pressed="${w}">${w ? '★' : '☆'}</button>`
        }
      </div>
      <div class="card-body">
        <!-- A real button, so the detail view has a keyboard route in: the image
             above it is the obvious click target but can't take focus. -->
        <button class="card-name" type="button" data-act="detail"
                title="${esc(c.description || c.name)}">${esc(c.name)}</button>
        <div class="card-meta">
          <span class="dots">${dots}</span>
          <span style="color:var(--r-${esc(c.rarity)}, #7d8896)">${esc(c.rarity)}</span>
          <span class="num">${esc(c.set_id)}-${esc(num)}</span>
        </div>
        ${priceHTML(c, q, f)}
        ${viewing ? haveHTML(q, f) : steppersHTML(c, q, f)}
      </div>
    </article>`;
}

/** The two counters you edit your own collection with. */
const steppersHTML = (c, q, f) => `
  <div class="stepper">
    <button type="button" data-act="dec" aria-label="Remove one" ${q === 0 ? 'disabled' : ''}>−</button>
    <input type="number" min="0" max="99" value="${q}" data-act="qty"
           aria-label="Copies of ${esc(c.name)} owned">
    <button type="button" data-act="inc" aria-label="Add one">+</button>
  </div>
  <div class="stepper stepper-foil" title="Foil copies">
    <button type="button" data-act="fdec" aria-label="Remove one foil" ${f === 0 ? 'disabled' : ''}>−</button>
    <input type="number" min="0" max="99" value="${f}" data-act="fqty"
           aria-label="Foil copies of ${esc(c.name)} owned">
    <button type="button" data-act="finc" aria-label="Add one foil">+</button>
    <span class="foil-tag" aria-hidden="true">✦</span>
  </div>`;

/**
 * What the steppers become while visiting. The row keeps their height so the
 * grid doesn't reflow into a different shape the moment you open a collection —
 * cards you were looking at stay where they were.
 */
function haveHTML(q, f) {
  const copies = q + f;
  if (!copies) return `<div class="have is-none">Doesn't have this</div>`;
  return `
    <div class="have">
      <b>${copies}</b> cop${copies === 1 ? 'y' : 'ies'}${
        f ? ` <span class="have-foil" title="${f} foil${f === 1 ? '' : 's'}">${f}✦</span>` : ''
      }
    </div>`;
}

function render() {
  const list = CARDS.filter(matches).sort(sortCmp(state.sort));
  grid.innerHTML = list.map(cardHTML).join('');
  el('empty').hidden = list.length > 0;
  el('result-count').textContent =
    `${list.length} card${list.length === 1 ? '' : 's'} shown`;
  // Rebuilt here rather than only on entering a collection: the "vs yours" half
  // of it goes stale the moment another device syncs a change of your own.
  renderViewBar();
  renderStats();
  updateFilterBadge();
  paintDomainSwatch();
}

/** Refresh one tile in place so the grid doesn't jump while you tap +/−. */
function refreshCard(id) {
  // Nothing can change a guest's tile, and it has no steppers to write back to.
  if (viewing) return;
  const node = grid.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!node) return;
  const q = qtyOf(id);
  const f = foilOf(id);
  const copies = q + f;
  const w = wishOf(id);

  node.classList.toggle('is-owned', copies > 0);
  node.classList.toggle('is-wish', w);

  const badge = node.querySelector('.qty-badge');
  badge.textContent = copies;
  badge.hidden = copies === 0;

  const foilBadge = node.querySelector('.foil-badge');
  foilBadge.textContent = `${f}✦`;
  foilBadge.hidden = f === 0;
  foilBadge.title = `${f} foil${f === 1 ? '' : 's'}`;

  const wishBtn = node.querySelector('.wish-btn');
  wishBtn.classList.toggle('on', w);
  wishBtn.textContent = w ? '★' : '☆';
  wishBtn.setAttribute('aria-pressed', String(w));

  node.querySelector('[data-act="qty"]').value = q;
  node.querySelector('[data-act="dec"]').disabled = q === 0;
  node.querySelector('[data-act="fqty"]').value = f;
  node.querySelector('[data-act="fdec"]').disabled = f === 0;

  // The stack total depends on the count, so this row has to be redrawn too.
  const priceRow = node.querySelector('.card-price');
  if (priceRow) {
    const card = CARDS.find((c) => c.id === id);
    priceRow.outerHTML = priceHTML(card, q, foilOf(id));
  }

  renderStats();
}

/* ---------------- stats ---------------- */

/**
 * Worth of everything owned, promos included — they sit outside set completion
 * but they're still money on the shelf. Also returns the per-card line values,
 * which the breakdown panel reuses rather than walking the collection twice.
 *
 * Takes the collection explicitly so the visiting bar can price yours and theirs
 * in the same currency without swapping `viewing` in and out to do it.
 */
function collectionValue(src = shown()) {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  // Cards the selected market doesn't list, valued at a converted US price.
  let converted = 0;
  const lines = [];

  for (const c of CARDS) {
    const q = src[c.id]?.q || 0;
    const f = src[c.id]?.f || 0;
    const copies = q + f;
    if (!copies) continue;
    const p = priceOf(c.id);
    if (p == null) {
      unpriced += copies;
      continue;
    }
    priced += copies;
    // Counted per printing: Cardmarket can list a card's normal copy and not its
    // foil, so a single card can be partly quoted and partly converted.
    if (onCardmarket()) {
      if (priceSourceOf(c.id) !== 'cm') converted += q;
      if (typeof PRICES[c.id]?.cmf !== 'number') converted += f;
    }
    // Foils carry their own market price, so a line is the two stacks added.
    const fp = foilPriceOf(c.id) ?? p;
    const line = p * q + fp * f;
    total += line;
    // `unit` drives the breakdown's "x at y each"; with a mixed stack the
    // blended figure is the honest one.
    lines.push({ card: c, q: copies, foils: f, unit: line / copies, line });
  }

  lines.sort((a, b) => b.line - a.line);
  return { total, priced, unpriced, converted, lines };
}

/**
 * The headline figures for any collection — yours or a visitor's. Promos are
 * left out of `unique` for the same reason the completion percentage leaves them
 * out (they aren't part of a set you can finish) but counted everywhere copies
 * are, because a promo in a binder is still a card in a binder.
 */
function summarise(src) {
  let unique = 0;
  let copies = 0;
  let foils = 0;
  let wish = 0;
  for (const c of COLLECTABLE) {
    const e = src[c.id];
    if (!e) continue;
    const n = (e.q || 0) + (e.f || 0);
    if (n > 0) {
      unique++;
      copies += n;
      foils += e.f || 0;
    }
    if (e.w) wish++;
  }
  return { unique, copies, foils, wish };
}

function renderStats() {
  const { unique: uniqueOwned, copies: totalCopies, foils: foilCopies, wish: wishCount } =
    summarise(shown());
  const pct = COLLECTABLE.length
    ? Math.round((uniqueOwned / COLLECTABLE.length) * 100)
    : 0;

  const open = prefs.showDetails;
  const val = PRICE_DATA ? collectionValue() : null;

  // One control for the lot: the worth chip is also the handle for the panel
  // holding set progress and the per-card value breakdown. Without a price sync
  // there's no figure to show, so the handle falls back to a plain label — and
  // it falls back while visiting too, because the bar above is already reporting
  // their worth next to yours, which is the more useful of the two figures.
  const toggleHTML =
    val && !viewing
      ? `<button type="button" class="stat-value" id="stat-toggle" aria-expanded="${open}"
          aria-controls="stats-panel"
          title="${onCardmarket() ? 'Cardmarket' : 'TCGplayer'} value of every copy you own${
            val.unpriced ? ` · ${val.unpriced} copies have no price data` : ''
          }${
            onCardmarket() && val.converted
              ? ` · ${val.converted} priced from TCGplayer instead, converted, because Cardmarket doesn't list them`
              : ''
          }. Click for set progress and the breakdown.">
         <span class="stat-value-label">Collection worth</span>
         <span class="stat-value-num">${money(val.total)}</span>
         <span class="stat-caret" aria-hidden="true">${open ? '▴' : '▾'}</span>
       </button>`
      : `<button type="button" class="stat-value is-bare" id="stat-toggle" aria-expanded="${open}"
            aria-controls="stats-panel"
            title="Completion per set${val ? ', and the cards carrying the value' : ''}">
           <span class="stat-value-label">${viewing ? 'Their set progress' : 'Set progress'}</span>
           <span class="stat-caret" aria-hidden="true">${open ? '▴' : '▾'}</span>
         </button>`;

  // Only worth offering when the price file carries a rate to convert with.
  const currencyHTML =
    CURRENCY_CODES.length > 1
      ? `<select id="cur-sel" class="sel sel-cur" aria-label="Display market and currency"
            title="${
              PRICE_META.cardmarket
                ? `EUR shows Cardmarket's own European prices (${esc(PRICE_META.cardmarket.priced)} cards). USD and GBP show TCGplayer's US prices${
                    PRICE_META.ratesDate
                      ? `, GBP converted at the rate of ${esc(PRICE_META.ratesDate)}`
                      : ''
                  }. The two markets genuinely differ — this is a change of market, not just of units`
                : `Prices come from TCGplayer in US dollars${
                    PRICE_META.ratesDate
                      ? `. Other currencies are converted at the rate of ${esc(PRICE_META.ratesDate)}, not sourced from a European marketplace`
                      : ''
                  }`
            }">${CURRENCY_CODES.map(
              (c) =>
                `<option value="${c}"${c === currency ? ' selected' : ''}>${c} ${CURRENCIES[c]}</option>`
            ).join('')}</select>`
      : '';

  // Visiting, the same four counts are already in the bar above with yours
  // beside them — so the line here keeps only the two controls rather than
  // repeating them a second time three centimetres lower.
  el('statline').innerHTML =
    toggleHTML +
    currencyHTML +
    (viewing
      ? ''
      : `<span><b>${uniqueOwned}</b> / ${COLLECTABLE.length} unique <span class="pct">(${pct}%)</span></span>` +
        `<span><b>${totalCopies}</b> total copies</span>` +
        (foilCopies
          ? `<span title="Counted inside the total, priced at the foil market"><b>${foilCopies}</b> foil</span>`
          : '') +
        `<span><b>${wishCount}</b> on wishlist</span>`);

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
      const owned = inSet.filter((c) => copiesOf(c.id) > 0).length;
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
        <span class="value-label">${
          viewing ? `${esc(viewing.handle)}'s collection worth` : 'Collection worth'
        }</span>
        <span class="value-big">${money(val.total)}</span>
        <span class="value-meta">
          ${val.priced.toLocaleString('en-US')} copies priced${
            val.unpriced ? ` · ${val.unpriced} with no sales data` : ''
          }<br>
          ${
            onCardmarket()
              ? `Cardmarket, ${esc(PRICE_META.synced)} — European prices, not converted${
                  val.converted
                    ? `<br>${val.converted} ${
                        val.converted === 1 ? 'copy is' : 'copies are'
                      } valued at a converted TCGplayer price, having no Cardmarket listing`
                    : ''
                }`
              : `TCGplayer market, ${esc(PRICE_META.synced)}${
                  currency === 'USD'
                    ? ''
                    : `<br>Converted from USD at ${RATES[currency]} ${esc(currency)}/USD${
                        PRICE_META.ratesDate ? `, ${esc(PRICE_META.ratesDate)}` : ''
                      }`
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
          : `<div class="value-top"><h4>${
              viewing ? 'Nothing in this collection yet' : 'Nothing owned yet'
            }</h4></div>`
      }
    </div>`;
}

/* ---------------- the visiting bar ---------------- */

const viewBar = el('view-bar');

/** Rough enough to answer "is this collection current?" and no more. */
function agoText(iso) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 2) return 'updated just now';
  if (mins < 60) return `updated ${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `updated ${days} day${days === 1 ? '' : 's'} ago`;
  return `updated ${Math.round(days / 30)} months ago`;
}

/**
 * Their figure said in terms of yours. A ratio beats a difference here because
 * two collections can sit an order of magnitude apart and "+1,204" tells you
 * nothing about that — but a ratio needs a denominator, so an empty side of the
 * comparison gets a sentence instead of a percentage.
 */
function versus(theirs, mine, fmtN = (n) => n.toLocaleString('en-US')) {
  if (!mine) return theirs ? 'you have none yet' : 'neither of you';
  const ratio = theirs / mine;
  // Past a doubling a percentage stops being readable: "3,410% of yours" is a
  // figure you have to decode, "34× yours" is one you can see. Below it the
  // percentage is the better of the two — "89% of yours" beats "0.9× yours".
  const rel =
    ratio >= 2
      ? `${ratio.toFixed(ratio < 10 ? 1 : 0)}× your`
      : `${Math.round(ratio * 100)}% of your`;
  return `${rel} ${fmtN(mine)}`;
}

/** Their headline figures, each with yours underneath it. */
function renderViewBar() {
  if (!viewing) {
    viewBar.hidden = true;
    viewBar.innerHTML = '';
    return;
  }

  const theirs = summarise(viewing.data);
  const mine = summarise(collection);
  const when = agoText(viewing.updatedAt);

  const stat = (label, value, vs) => `
    <div class="vc">
      <span class="vc-label">${label}</span>
      <span class="vc-num">${value}</span>
      <span class="vc-vs">${esc(vs)}</span>
    </div>`;

  const rows = [
    stat(
      'Unique cards',
      `${theirs.unique.toLocaleString('en-US')} <small>/ ${COLLECTABLE.length}</small>`,
      versus(theirs.unique, mine.unique)
    ),
    stat('Total copies', theirs.copies.toLocaleString('en-US'), versus(theirs.copies, mine.copies)),
    stat('Foils', theirs.foils.toLocaleString('en-US'), versus(theirs.foils, mine.foils)),
    stat('On wishlist', theirs.wish.toLocaleString('en-US'), versus(theirs.wish, mine.wish)),
  ];

  if (PRICE_DATA) {
    const theirWorth = collectionValue(viewing.data).total;
    const myWorth = collectionValue(collection).total;
    rows.push(stat('Worth', money(theirWorth), versus(theirWorth, myWorth, money)));
  }

  viewBar.innerHTML = `
    <div class="view-head">
      <p class="view-who">
        <span class="view-eye" aria-hidden="true">◍</span>
        Looking through <b>${esc(viewing.handle)}</b>'s collection${
          when ? ` <span class="view-when">${esc(when)}</span>` : ''
        }
      </p>
      <button class="btn view-exit" type="button" data-view="exit">Back to mine</button>
    </div>
    <div class="view-compare">${rows.join('')}</div>
    <p class="view-note">The search box, every filter and every sort work on their
      cards while this is up. Nothing here can change either collection.</p>`;
  viewBar.hidden = false;
}

/**
 * Enter or leave visiting mode. `next` is `{ handle, data, updatedAt }`, and its
 * `data` must already have been through sanitize() — it arrived over the network
 * from another account, and an unrecognised card id is the least of what a blob
 * from elsewhere could be carrying.
 */
function setViewing(next) {
  viewing = next
    ? {
        handle: String(next.handle || 'A collector'),
        data: next.data || {},
        updatedAt: next.updatedAt || null,
      }
    : null;

  // The deck builder, the pack opener and the exporters all speak about *your*
  // collection. Leaving one of them up over someone else's cards would misstate
  // whose they are, so the buttons go away (CSS) and anything already open is
  // closed here.
  if (viewing) {
    deckModal.close();
    packModal.close();
    cardModal.close();
    setMenu(false);
  }

  document.body.classList.toggle('is-viewing', !!viewing);
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Announced rather than called: the address bar wants to follow this, and
  // "Back to mine" is a button app.js owns, so an event is what lets social.js
  // keep the ?u= link in step without app.js knowing a URL is involved.
  document.dispatchEvent(
    new CustomEvent('riftbound:viewing', { detail: viewing ? { handle: viewing.handle } : null })
  );
}

viewBar.addEventListener('click', (e) => {
  if (e.target.closest('[data-view="exit"]')) setViewing(null);
});

/* ---------------- card detail ---------------- */

/**
 * Riftcodex ships rules text as one unbroken run carrying the game's own inline
 * codes: `:rb_energy_3:` for a cost, `:rb_rune_calm:` for a coloured rune,
 * `:rb_might:` and `:rb_exhaust:` for the two loose symbols, `[Keyword]` for
 * keywords and `[&gt;]` for the arrow that introduces a levelled effect. There
 * is no separator between abilities at all — a reminder text's closing bracket
 * runs straight into the next sentence — so the paragraph breaks have to be
 * inferred before any of it reads as rules text.
 */

/**
 * Riftcodex leaves a couple of HTML entities in the text it publishes — `&gt;`
 * on the 122 cards with a levelled effect, `&quot;` on 24 — so they have to be
 * decoded back to characters before the text is escaped again for display.
 * Ampersand last, or `&amp;gt;` would decode twice.
 */
const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** `[>]` and `[>>]` are arrows into a levelled effect, not keywords. Keyed on
 *  the escaped forms, which is what the bracket pass below is matching. */
const RULES_ARROWS = { '&gt;': '→', '&gt;&gt;': '⇒' };

const SYMBOLS = {
  ':rb_might:': '<span class="sym sym-might" title="Might">✦</span>',
  ':rb_exhaust:': '<span class="sym sym-exhaust" title="Exhaust">⟳</span>',
};

function symbolHTML(token) {
  if (SYMBOLS[token]) return SYMBOLS[token];

  const energy = /^:rb_energy_(\d+):$/.exec(token);
  if (energy) return `<span class="sym sym-energy" title="${energy[1]} Energy">${energy[1]}</span>`;

  const rune = /^:rb_rune_([a-z]+):$/.exec(token);
  if (rune) {
    // Rainbow means "a rune of any domain", so it gets every domain colour
    // rather than one of them.
    const rainbow = rune[1] === 'rainbow';
    const style = `background:${runePaint(rune[1])}`;
    return `<span class="sym sym-rune" style="${style}" title="${
      rainbow ? 'Rune of any domain' : `${esc(titleCase(rune[1]))} rune`
    }"></span>`;
  }

  // An unknown code is shown as its bare word rather than swallowed: a future
  // set's symbol should still read as something rather than vanish.
  return `<span class="sym sym-text">${esc(token.replace(/^:rb_|:$/g, '').replace(/_/g, ' '))}</span>`;
}

function rulesHTML(text) {
  if (!text) return '';

  let t = esc(decodeEntities(text))
    // A closing bracket that runs straight into the next word ends an ability.
    .replace(/\)(?=[^\s)])/g, ')\n')
    // …as does a sentence or a reminder immediately followed by a new keyword.
    // `[Level 3][&gt;]` is spared because its `[` follows a `]`, not a stop.
    .replace(/([.)])\s*(?=\[)/g, '$1\n');

  // Reminder text is the game restating a keyword; dim it so the actual rules
  // stand out. Done before the bracket pass, whose markup contains no brackets.
  t = t.replace(/\(([^()]*)\)/g, '<i class="rules-note">($1)</i>');

  t = t.replace(/\[([^\][]{1,24})\]/g, (whole, inner) =>
    RULES_ARROWS[inner]
      ? `<span class="rules-arrow">${RULES_ARROWS[inner]}</span>`
      : `<b class="rules-kw">${inner}</b>`
  );

  t = t.replace(/:rb_[a-z0-9_]+:/g, symbolHTML);

  return t
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${line}</p>`)
    .join('');
}

/**
 * Cardmarket's Riftbound category, searched by name.
 *
 * Their product search is token based, which makes the punctuation between a
 * champion and their title the one thing worth removing: our catalogue writes
 * both `Vi - Destructive` and `Kai'Sa, Survivor` depending on the set, and
 * neither separator is certain to be the one Cardmarket printed. Sending
 * `Vi Destructive` matches either way.
 *
 * The exact query string can't be verified from here — Cardmarket answers
 * automated requests with a 403 — so this is built to fail softly: a name that
 * finds nothing still lands on their Riftbound search page, not a 404.
 */
const cardmarketUrl = (card) =>
  'https://www.cardmarket.com/en/Riftbound/Products/Search?searchString=' +
  encodeURIComponent(plainName(card).replace(/\s*[,\-–—]\s*/g, ' '));

/**
 * TCGplayer, where the dollar prices come from. Cards carry their product id,
 * so this is an exact link; the few synthesised from the search feed without
 * one fall back to a name search.
 */
const tcgplayerUrl = (card) =>
  card.tcgplayer_id
    ? `https://www.tcgplayer.com/product/${encodeURIComponent(card.tcgplayer_id)}`
    : `https://www.tcgplayer.com/search/riftbound-league-of-legends-trading-card-game/product` +
      `?q=${encodeURIComponent(plainName(card))}`;

const cardModal = el('card-modal');
let detailId = null;

const chips = (label, values) =>
  values?.length
    ? `<div class="detail-chips"><span class="detail-chips-label">${esc(label)}</span>${values
        .map((v) => `<span class="chip">${esc(titleCase(v))}</span>`)
        .join('')}</div>`
    : '';

/** Energy / Might / Power, skipping the ones this card type doesn't print. */
function statPills(card) {
  const pills = [
    ['Energy', card.stats.energy],
    ['Might', card.stats.might],
    ['Power', card.stats.power],
  ].filter(([, v]) => v != null);
  if (!pills.length) return '';
  return `<div class="detail-stats">${pills
    .map(
      ([k, v]) =>
        `<div class="detail-stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`
    )
    .join('')}</div>`;
}

/** Both markets side by side, each labelled with where the figure came from. */
function detailPrices(card) {
  if (!PRICE_DATA) return '';
  const p = priceOf(card.id);
  if (p == null) {
    return `<div class="detail-prices"><span class="detail-price none">No sales data for
      this printing</span></div>`;
  }
  const cm = priceSourceOf(card.id) === 'cm';
  const market = cm ? 'Cardmarket' : 'TCGplayer';
  const fp = typeof PRICES[card.id]?.[cm ? 'cmf' : 'f'] === 'number' ? foilPriceOf(card.id) : null;
  const was = prevPriceOf(card.id);
  const pct = was > 0 ? Math.round(((p - was) / was) * 100) : 0;

  return `<div class="detail-prices">
    <div class="detail-price"><b>${money(p)}</b><span>${esc(market)} normal</span></div>
    ${fp == null ? '' : `<div class="detail-price"><b>${money(fp)}✦</b><span>${esc(market)} foil</span></div>`}
    ${
      Math.abs(pct) >= 3 && Math.abs(p - was) >= 0.05
        ? `<div class="detail-price"><b class="delta ${pct > 0 ? 'up' : 'down'}">${
            pct > 0 ? '↑' : '↓'
          }${Math.abs(pct)}%</b><span>since ${esc(PRICE_META.previousSync || 'last sync')}</span></div>`
        : ''
    }
  </div>`;
}

/** The counters and the wishlist toggle, for a card in your own collection. */
const detailSteppersHTML = (q, f, w) => `
  <div class="detail-own">
    <div class="stepper">
      <button type="button" data-detail="dec" aria-label="Remove one" ${q === 0 ? 'disabled' : ''}>−</button>
      <input type="number" min="0" max="99" value="${q}" data-detail="qty" aria-label="Copies owned">
      <button type="button" data-detail="inc" aria-label="Add one">+</button>
    </div>
    <div class="stepper stepper-foil" title="Foil copies">
      <button type="button" data-detail="fdec" aria-label="Remove one foil" ${f === 0 ? 'disabled' : ''}>−</button>
      <input type="number" min="0" max="99" value="${f}" data-detail="fqty" aria-label="Foil copies owned">
      <button type="button" data-detail="finc" aria-label="Add one foil">+</button>
      <span class="foil-tag" aria-hidden="true">✦</span>
    </div>
    <button class="btn btn-quiet detail-wish ${w ? 'on' : ''}" type="button"
            data-detail="wish" aria-pressed="${w}">${w ? '★ Wishlisted' : '☆ Wishlist'}</button>
  </div>`;

/**
 * Both sides at once. The grid has room for one number per tile, so this is the
 * one place that can answer what you actually opened someone else's card to ask:
 * they have this many, and you have that many.
 */
const detailCompareHTML = (q, f, w, mineQ, mineF) => `
  <div class="detail-own is-visiting">
    <span class="detail-have">
      <b>${esc(viewing.handle)}</b>
      ${q + f ? `has <b>${q + f}</b>${f ? ` <span class="have-foil">${f}✦</span>` : ''}` : 'has none'}
      ${w ? '<span class="wish-mark" title="On their wishlist">★</span>' : ''}
    </span>
    <span class="detail-have is-mine">
      You
      ${
        mineQ + mineF
          ? `have <b>${mineQ + mineF}</b>${
              mineF ? ` <span class="have-foil">${mineF}✦</span>` : ''
            }`
          : 'have none'
      }
    </span>
  </div>`;

function renderCardDetail() {
  const card = CARDS.find((c) => c.id === detailId);
  const body = el('card-modal-body');
  if (!card) {
    body.innerHTML = '';
    return;
  }

  const q = qtyOf(card.id);
  const f = foilOf(card.id);
  const w = wishOf(card.id);
  // Only read while visiting, where `q`/`f` above are the other collector's.
  const mineQ = collection[card.id]?.q || 0;
  const mineF = collection[card.id]?.f || 0;
  const img = card.image_full || card.image || '';
  const num = String(card.collector_number).padStart(3, '0') + (card.variant || '');
  const typeLine = [card.supertype, card.type].filter(Boolean).join(' ');

  body.innerHTML = `
    <button class="detail-close icon-btn" type="button" data-detail="close" aria-label="Close">✕</button>

    <div class="detail-art">
      ${
        img
          ? `<img src="${esc(img)}" alt="${esc(card.name)}" decoding="async">`
          : `<div class="card-noart"><span class="noart-name">${esc(card.name)}</span>
               <span class="noart-note">no art yet</span></div>`
      }
    </div>

    <div class="detail-info">
      <h2 class="detail-name">${esc(card.name)}</h2>
      <p class="detail-line">
        <span class="dots">${domainDots(card)}</span>
        <span>${esc(typeLine)}</span>
        <span class="detail-sep">·</span>
        <span style="color:var(--r-${esc(card.rarity)}, var(--text-dim))">${esc(titleCase(card.rarity))}</span>
        <span class="detail-sep">·</span>
        <span>${esc(setNameOf(card.set_id))} ${esc(card.set_id)}-${esc(num)}</span>
      </p>

      ${statPills(card)}
      ${chips('Keywords', card.keywords)}
      ${chips('Tags', card.tags)}

      ${card.description ? `<div class="detail-rules">${rulesHTML(card.description)}</div>` : ''}
      ${card.flavor_text ? `<p class="detail-flavor">${esc(card.flavor_text)}</p>` : ''}
      ${card.artist ? `<p class="detail-artist">Art by ${esc(card.artist)}</p>` : ''}

      ${detailPrices(card)}

      ${viewing ? detailCompareHTML(q, f, w, mineQ, mineF) : detailSteppersHTML(q, f, w)}

      <div class="detail-links">
        <a class="btn" href="${esc(cardmarketUrl(card))}" target="_blank" rel="noopener noreferrer">
          Cardmarket ↗</a>
        <a class="btn btn-quiet" href="${esc(tcgplayerUrl(card))}" target="_blank" rel="noopener noreferrer">
          TCGplayer ↗</a>
      </div>
    </div>`;
}

function openCardDetail(id) {
  if (!CARDS.some((c) => c.id === id)) return;
  detailId = id;
  renderCardDetail();
  cardModal.showModal();
}

cardModal.addEventListener('click', (e) => {
  if (e.target === cardModal) return cardModal.close();

  const btn = e.target.closest('[data-detail]');
  if (!btn || btn.tagName === 'INPUT' || !detailId) return;

  const id = detailId;
  const act = btn.dataset.detail;
  if (act === 'close') return cardModal.close();
  if (act === 'inc') setEntry(id, { q: qtyOf(id) + 1 });
  else if (act === 'dec') setEntry(id, { q: qtyOf(id) - 1 });
  else if (act === 'finc') setEntry(id, { f: foilOf(id) + 1 });
  else if (act === 'fdec') setEntry(id, { f: foilOf(id) - 1 });
  else if (act === 'wish') setEntry(id, { w: !wishOf(id) });
  else return;

  renderCardDetail();
  // The grid is still behind the dialog, so its tile has to keep up. It may not
  // be rendered at all — a card opened from a suggested deck can sit outside
  // the current filters — which refreshCard already treats as nothing to do.
  refreshCard(id);
});

cardModal.addEventListener('change', (e) => {
  const input = e.target.closest('[data-detail="qty"], [data-detail="fqty"]');
  if (!input || !detailId) return;
  const n = Math.min(99, Math.max(0, parseInt(input.value, 10) || 0));
  setEntry(detailId, input.dataset.detail === 'fqty' ? { f: n } : { q: n });
  renderCardDetail();
  refreshCard(detailId);
});

cardModal.addEventListener('close', () => {
  detailId = null;
});

/* ---------------- events ---------------- */

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.tagName === 'INPUT') return;
  const id = btn.closest('.card')?.dataset.id;
  if (!id) return;

  const act = btn.dataset.act;
  if (act === 'detail') return openCardDetail(id);
  if (act === 'inc') setEntry(id, { q: qtyOf(id) + 1 });
  else if (act === 'dec') setEntry(id, { q: qtyOf(id) - 1 });
  else if (act === 'finc') setEntry(id, { f: foilOf(id) + 1 });
  else if (act === 'fdec') setEntry(id, { f: foilOf(id) - 1 });
  else if (act === 'wish') setEntry(id, { w: !wishOf(id) });
  else return;

  refreshCard(id);
});

grid.addEventListener('change', (e) => {
  const input = e.target.closest('[data-act="qty"], [data-act="fqty"]');
  if (!input) return;
  const id = input.closest('.card')?.dataset.id;
  if (!id) return;
  const n = Math.min(99, Math.max(0, parseInt(input.value, 10) || 0));
  setEntry(id, input.dataset.act === 'fqty' ? { f: n } : { q: n });
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
  // Asked of the document rather than of a named list, so a dialog added later
  // — the collector browser was one — is covered without anyone remembering to
  // come back and add it here.
  if (document.querySelector('dialog[open]')) return;

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

/**
 * `optionStyle` inline-styles each value's `<option>`, for a menu whose entries
 * carry more than their wording — the domains name runes, and a rune is a
 * colour before it's a word. Only `color` survives inside an `<option>`, and
 * Safari drops even that, so it stays decoration — paintDomainSwatch() draws
 * the chip every browser shows.
 */
function bindSelect(id, key, label, values, labelFn = (v) => v, optionStyle = null) {
  const sel = el(id);
  sel.innerHTML =
    `<option value="">${label}</option>` +
    values
      .map(
        (v) =>
          `<option value="${esc(v)}"${
            optionStyle ? ` style="${optionStyle(v)}"` : ''
          }>${esc(labelFn(v))}</option>`
      )
      .join('');
  sel.addEventListener('change', () => {
    state[key] = sel.value;
    render();
  });
}

/**
 * Colours the chip beside the domain filter with the rune you've picked, or
 * with the rainbow rune — the game's "any domain" — while the filter is off.
 * Driven from render() rather than from the select's own handler, so Reset and
 * anything else that puts the filter back get it for free.
 */
function paintDomainSwatch() {
  el('domain-wrap').style.setProperty(
    '--swatch',
    state.domain ? runePaint(state.domain) : RAINBOW_RUNE
  );
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
  // The export menu lives inside the panel on this layout — folding the panel
  // away with it still expanded would leave it open behind the burger.
  if (!open) setExportMenu(false);
}

menuBtn.addEventListener('click', () => setMenu(!menuOpen()));

// Anything outside the header dismisses it, the way a dropdown should.
document.addEventListener('click', (e) => {
  if (menuOpen() && !e.target.closest('.topbar')) setMenu(false);
});

document.addEventListener('keydown', (e) => {
  // An open export menu takes the Escape first — one press shouldn't dismiss
  // both it and the panel it's sitting in.
  if (
    e.key === 'Escape' && menuOpen() && !exportOpen() &&
    !deckModal.open && !packModal.open && !cardModal.open && !importModal.open
  ) {
    setMenu(false);
  }
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

/**
 * Every saved entry paired with its card, in set then collector-number order so
 * a text or CSV export reads like a binder rather than like localStorage.
 * Cards that vanished from the data file are dropped — an id nothing can resolve
 * is worse than a missing row in a file meant for another application.
 */
function exportRows() {
  const byId = new Map(CARDS.map((c) => [c.id, c]));
  return Object.entries(collection)
    .map(([id, e]) => ({
      card: byId.get(id),
      q: Math.max(0, e?.q | 0),
      f: Math.max(0, e?.f | 0),
      w: !!e?.w,
    }))
    .filter((r) => r.card && (r.q > 0 || r.f > 0 || r.w))
    .sort(
      (a, b) =>
        a.card.set_id.localeCompare(b.card.set_id) ||
        a.card.collector_number - b.card.collector_number
    );
}

/**
 * Splits each entry into one row per printing, the way other trackers file
 * them: a normal stack and a foil stack are different things to own and price.
 * A wishlist-only entry still emits its single row so the flag survives.
 */
function printingRows(rows) {
  const out = [];
  for (const r of rows) {
    if (r.q > 0) out.push({ card: r.card, qty: r.q, foil: false, w: r.w });
    if (r.f > 0) out.push({ card: r.card, qty: r.f, foil: true, w: r.w });
    if (r.q === 0 && r.f === 0) out.push({ card: r.card, qty: 0, foil: false, w: r.w });
  }
  return out;
}

const setNameOf = (id) => META.sets.find((s) => s.id === id)?.name || id;

/** Card number as other trackers expect it: zero-padded, treatment dropped. */
const cardNo = (card) => String(card.collector_number).padStart(3, '0');

/**
 * The number with its treatment marker, the way the grid prints it — `007a` for
 * an alternate art. Anything meant to be read back has to carry it, or a card
 * and its alternate art are the same row.
 */
const printedNo = (card) => `${cardNo(card)}${card.variant || ''}`;

/**
 * The id riftbound.gg (dotgg) files cards under: set code, dash, padded number —
 * `OGN-066`. 1171 of our 1320 cards land on one of theirs directly; the rest are
 * looked up by name instead, which their importer falls back to on its own.
 */
const dotggId = (card) => `${card.set_id}-${cardNo(card)}`;

/**
 * The same printing as the RiftCore family of trackers files it: set code, dash,
 * padded number, then the treatment marker in upper case — `OGN-007A` for the
 * alternate art, `OGN-299*` for a signature. Their readers take exactly three
 * uppercase alphanumerics for the number and at most one letter or star after
 * it, so `PR`'s two-letter set code is the one thing here they can't parse; its
 * 13 promos come through as unrecognised rows rather than as the wrong card.
 */
const riftcoreId = (card) => `${card.set_id}-${cardNo(card)}${(card.variant || '').toUpperCase()}`;

/**
 * The name without the treatment suffix we carry and other catalogues don't:
 * riftbound.gg lists one `Ahri - Alluring`, not a separate `(Alternate Art)`
 * printing, so the bare name is what a name lookup has to be given. Worth 27
 * extra cards over sending ours verbatim.
 */
const plainName = (card) => window.RiftboundDeck.cardName(card);

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The shapes a collection can leave here in. JSON is the round-trip format the
 * importer reads back; the rest are one-way and shaped for other tools, so they
 * carry printed identifiers (set + number) rather than this app's ids.
 */
const EXPORT_FORMATS = {
  json: {
    ext: 'json',
    mime: 'application/json',
    build: () =>
      JSON.stringify(
        { app: 'riftbound-collection', version: 1, exportedAt: new Date().toISOString(), collection },
        null,
        2
      ),
  },

  csv: {
    ext: 'csv',
    mime: 'text/csv',
    build: (rows) => {
      // Prices follow the currency picked in the header, so the column is
      // labelled with the code — a bare number in the wrong money is a trap.
      // Name comes last on purpose: 75 of our card names contain a comma, and
      // an importer that splits on commas instead of parsing quotes shifts every
      // column that follows one. Last means there's nothing left to shift.
      const head = [
        'Card ID', 'Set Code', 'Set Name', 'Card Number', 'Quantity', 'Foil', 'Wishlist',
        'Rarity', 'Type', 'Domains', `Unit Price (${currency})`, `Total Price (${currency})`, 'Name',
      ];
      const lines = printingRows(rows).map((r) => {
        // Each row is priced as the printing it actually is. The accessors
        // already answer in the selected currency, so there's nothing to convert.
        const p = r.foil ? foilPriceOf(r.card.id) : priceOf(r.card.id);
        const unit = p == null ? '' : p.toFixed(2);
        const total = p == null ? '' : (p * r.qty).toFixed(2);
        return [
          // Card Number carries the treatment marker the riftbound.gg-shaped
          // Card ID beside it has to leave out — `007a`, the way the grid prints
          // it — so this file can be read back without 007 and 007a merging.
          dotggId(r.card), r.card.set_id, setNameOf(r.card.set_id), printedNo(r.card),
          r.qty, r.foil ? 'yes' : 'no', r.w ? 'yes' : 'no',
          r.card.rarity, r.card.type, r.card.domains.join(' / '), unit, total, plainName(r.card),
        ].map(csvCell).join(',');
      });
      // BOM first, or Excel opens UTF-8 card names as mojibake.
      return `﻿${[head.join(','), ...lines].join('\r\n')}\r\n`;
    },
  },

  /**
   * riftbound.gg's importer recognises four header names and reads nothing else:
   * `card id`, `quantity`, `foil`, `name`. It splits rows on commas without
   * honouring quotes, so the name is parked in the last column, where a comma in
   * it can't shift anything that matters. Nothing but their importer reads this
   * file, so it skips the BOM the spreadsheet CSV needs.
   */
  rbgg: {
    ext: 'csv',
    slug: '-riftbound-gg',
    mime: 'text/csv',
    build: (rows) =>
      `${['Card ID,Quantity,Foil,Name']
        .concat(
          printingRows(rows)
            .filter((r) => r.qty > 0) // a row at 0 is dropped on their side anyway
            .map((r) => `${dotggId(r.card)},${r.qty},${r.foil ? 1 : 0},${plainName(r.card)}`)
        )
        .join('\r\n')}\r\n`,
  },

  /**
   * The shape the rest of the ecosystem sniffs for. OpenRift — which reads four
   * trackers' exports and writes all four back out — recognises a collection by
   * its first line, and `RIFTCORE COLLECTION EXPORT` is the one that gets a file
   * in; from there it converts on to Piltover Archive and RiftMana. Our own CSV
   * matches none of those signatures, which is why it bounced off every importer
   * it was fed to.
   *
   * The difference that matters is how a foil is spelled. Ours emits one row per
   * printing with a `Foil` column beside a single quantity, so a reader that
   * doesn't know that column sees two rows for one card — three normals and two
   * foils either becomes five normals or loses the foils entirely. This format
   * carries the two counts in two columns, `Standard Qty` and `Foil Qty`, which
   * is how the collection is stored here in the first place: `q` and `f`.
   *
   * Rare, Epic and Showcase cards have no non-foil printing, so their readers
   * take the standard count of one as foil too. Both counts still land on the
   * card as copies, so a total is never lost — but it's why a plain copy of an
   * Epic arrives foil. Wishlist-only rows are left out; there's no quantity in
   * them to import.
   */
  riftcore: {
    ext: 'csv',
    slug: '-riftcore',
    mime: 'text/csv',
    build: (rows) => {
      const head = [
        'Card ID', 'Card Name', 'Set', 'Card Number', 'Type', 'Rarity', 'Domain',
        'Standard Qty', 'Foil Qty',
      ];
      // Two lines of preamble before the header, the way RiftCore writes them:
      // the first is the signature the importers match on, and a second opening
      // `Exported from` is a line their row loop already knows to skip.
      const out = [
        'RIFTCORE COLLECTION EXPORT',
        `Exported from Riftbound Collection on ${new Date().toISOString().slice(0, 10)}`,
        head.join(','),
      ];
      for (const r of rows) {
        if (r.q === 0 && r.f === 0) continue;
        out.push(
          [
            riftcoreId(r.card), plainName(r.card), setNameOf(r.card.set_id), cardNo(r.card),
            r.card.type, r.card.rarity, r.card.domains.join(' / '), r.q, r.f,
          ].map(csvCell).join(',')
        );
      }
      return `${out.join('\r\n')}\r\n`;
    },
  },

  txt: {
    ext: 'txt',
    mime: 'text/plain',
    build: (rows) => {
      const owned = rows.filter((r) => r.q > 0 || r.f > 0);
      const wished = rows.filter((r) => r.w);
      const copies = owned.reduce((a, r) => a + r.q + r.f, 0);
      const foils = owned.reduce((a, r) => a + r.f, 0);

      const out = [
        'Riftbound collection',
        `Exported ${new Date().toISOString().slice(0, 10)}`,
        `${owned.length} unique cards · ${copies} total copies` +
          (foils ? ` · ${foils} foil` : ''),
      ];

      let set = null;
      for (const r of owned) {
        if (r.card.set_id !== set) {
          set = r.card.set_id;
          out.push('', `${setNameOf(set)} (${set})`, '-'.repeat(setNameOf(set).length + set.length + 3));
        }
        // Foils are called out inline rather than given their own line, so the
        // list still reads as one row per card the way a binder does.
        const foil = r.f ? ` [${r.f} foil]` : '';
        // The number carries its treatment marker, the way the grid prints it —
        // without it `007` names both the card and its alternate art, and the
        // list can't be read back into a collection.
        out.push(`${r.q + r.f}x ${r.card.name} (${set} ${printedNo(r.card)})${foil}`);
      }

      if (wished.length) {
        out.push('', 'Wishlist', '--------');
        for (const r of wished) out.push(`${r.card.name} (${r.card.set_id} ${printedNo(r.card)})`);
      }
      return `${out.join('\n')}\n`;
    },
  },

  tcg: {
    ext: 'txt',
    // Shares an extension with the plain list, so it earns its own file name.
    slug: '-tcgplayer',
    mime: 'text/plain',
    // Mass-entry boxes take "quantity name" and nothing else — no header, and no
    // wishlist-only rows, since a card you don't own has no quantity to enter.
    // The box has no syntax for a printing either, so foils are folded into the
    // count; picking the foil is something you do in the cart.
    build: (rows) =>
      `${rows
        .filter((r) => r.q + r.f > 0)
        .map((r) => `${r.q + r.f} ${r.card.name}`)
        .join('\n')}\n`,
  },
};

const EXPORT_LABELS = {
  json: 'JSON',
  csv: 'CSV',
  rbgg: 'a riftbound.gg file',
  riftcore: 'a collection-tracker file',
  txt: 'a text list',
  tcg: 'a TCGplayer list',
};

function runExport(format) {
  const spec = EXPORT_FORMATS[format];
  if (!spec) return;

  const rows = exportRows();
  if (!rows.length) {
    toast('Nothing to export yet — mark some cards first');
    return;
  }

  const text = spec.build(rows);
  const blob = new Blob([text], { type: `${spec.mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const day = new Date().toISOString().slice(0, 10);
  a.download = `riftbound-collection-${day}${spec.slug || ''}.${spec.ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Collection exported as ${EXPORT_LABELS[format]}`);
}

/* ---------------- export menu ---------------- */

const exportWrap = el('export-wrap');
const exportBtn = el('btn-export');
const exportMenu = el('export-menu');

const exportOpen = () => exportMenu.classList.contains('is-open');

function setExportMenu(open) {
  exportMenu.classList.toggle('is-open', open);
  exportBtn.setAttribute('aria-expanded', String(open));
  // Inside the burger panel the menu unfolds in the flow, and the panel is a
  // scroller — a long list of filters below it can leave the last formats
  // off screen. Nothing to nudge on the wide layout, where it floats.
  if (open && !wideLayout.matches) {
    exportMenu.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

exportBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setExportMenu(!exportOpen());
});

// Hover only where there's a real pointer: on a touch screen the first tap
// would open the menu and the click that follows would close it again.
const hoverPointer = window.matchMedia('(hover: hover)');
let hoverTimer;

exportWrap.addEventListener('pointerenter', (e) => {
  if (e.pointerType !== 'mouse' || !hoverPointer.matches) return;
  clearTimeout(hoverTimer);
  setExportMenu(true);
});

// A short grace period, so cutting the corner between button and menu — or
// sliding past on the way to Import — doesn't shut it in your face.
exportWrap.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'mouse' || !hoverPointer.matches) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => setExportMenu(false), 260);
});

exportMenu.addEventListener('click', (e) => {
  const item = e.target.closest('[data-format]');
  if (!item) return;
  setExportMenu(false);
  setMenu(false);
  runExport(item.dataset.format);
});

document.addEventListener('click', (e) => {
  if (exportOpen() && !e.target.closest('#export-wrap')) setExportMenu(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !exportOpen()) return;
  setExportMenu(false);
  exportBtn.focus();
});

/* ---------------- import ---------------- */

/**
 * A file arriving here was written by something else, so nothing about it is
 * taken on trust. Rather than recognising four vendors' formats by signature,
 * the reader finds its own header row and works out what each column *means* —
 * every collection CSV in this ecosystem is the same handful of columns under
 * different names, and OpenRift's `Finish`, Piltover Archive's `Variant Label`
 * and our own `Foil` all answer one question. A tracker nobody here has heard
 * of imports too, as long as it names its columns plainly.
 */

const normName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Rows of cells. Quoted fields, embedded commas and newlines, `""` escapes. The
 * separator is sniffed rather than assumed: a spreadsheet saved anywhere the
 * comma is a decimal point writes semicolons, and plenty of tools write tabs.
 */
function readCSV(text) {
  const src = text.replace(/^\uFEFF/, '');
  const first = src.split('\n').find((l) => l.trim()) || '';
  const count = (ch) => first.split(ch).length - 1;
  const sep = count('\t') > count(',') ? '\t' : count(';') > count(',') ? ';' : ',';

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      // A doubled quote inside a quoted field is one literal quote.
      if (ch !== '"') cell += ch;
      else if (src[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }

  // A blank line carries nothing, and a preamble tends to leave several.
  return rows.filter((r) => r.some((c) => c.trim()));
}

/**
 * Header names seen in the wild, by what they mean. Order matters twice: roles
 * are claimed in the order listed here, and within a role the first alias that
 * appears wins — so RiftCore's `Card ID` takes the code and leaves its
 * `Card Number` alone, while a file with only a bare number still has something
 * to try.
 */
const IMPORT_COLUMNS = {
  code: ['card id', 'cardid', 'card_id', 'variant number', 'printing', 'code', 'id', 'card number', 'number'],
  // Claimed only when something better already took the id, which is exactly
  // when it's useful: a `Card ID` that drops the treatment marker beside a
  // `Card Number` that keeps it is the one chance to tell 007 from 007a.
  num: ['card number', 'collector number', 'collector no', 'number', 'no'],
  name: ['card name', 'cardname', 'card', 'name'],
  normal: ['standard qty', 'normal qty', 'non-foil qty', 'nonfoil qty', 'regular qty'],
  foilQty: ['foil qty', 'foil quantity', 'foils'],
  qty: ['quantity', 'qty', 'count', 'owned', 'copies', 'total qty'],
  finish: ['finish', 'foil', 'variant label', 'variant type', 'treatment', 'printing type'],
  wish: ['wishlist', 'want', 'wanted', 'wishlisted'],
  set: ['set code', 'set prefix', 'set'],
};

const headerKey = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Maps a candidate header row to `{ role: columnIndex }`, or null when it isn't
 * a header at all. A row has to name something identifying *and* something
 * countable to qualify, which is what keeps a title line, a preamble banner or
 * a spreadsheet's totals row from being read as columns.
 */
function columnRoles(cells) {
  const headers = cells.map(headerKey);
  const roles = {};
  const claimed = new Set();

  for (const [role, aliases] of Object.entries(IMPORT_COLUMNS)) {
    for (const alias of aliases) {
      const i = headers.indexOf(alias);
      if (i !== -1 && !claimed.has(i)) {
        roles[role] = i;
        claimed.add(i);
        break;
      }
    }
  }

  const identifies = roles.code !== undefined || roles.name !== undefined;
  const counts = roles.qty !== undefined || roles.normal !== undefined || roles.foilQty !== undefined;
  return identifies && counts ? roles : null;
}

/** The first row that reads as a header, within reach of a preamble. */
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const roles = columnRoles(rows[i]);
    if (roles) return { at: i, roles };
  }
  return null;
}

/**
 * Every spelling of a printing we answer to, built once and kept. Values are
 * arrays because 69 codes and 152 names are shared by more than one of our cards
 * — Organized Play waves reusing collector numbers, reprints sharing a name — so
 * the importer can report a row as ambiguous instead of picking in silence.
 * CARDS is already in set-then-number order, making the first entry the
 * earliest-printed card, which is the pick.
 */
let importLookup = null;

function buildImportLookup() {
  const byCode = new Map();
  const byName = new Map();
  const add = (map, key, card) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(card);
    else map.set(key, [card]);
  };

  for (const card of CARDS) {
    const set = card.set_id.toLowerCase();
    // The id carries Riftcodex's own number segment, which is how a rune keeps
    // the printed `R05` alongside the plain `005` our own exports write.
    const seg = card.id.split('~')[0].split('-')[1] || '';
    add(byCode, `${set}-${cardNo(card)}${card.variant || ''}`, card);
    if (seg && seg !== `${cardNo(card)}${card.variant || ''}`) add(byCode, `${set}-${seg}`, card);
    add(byName, normName(card.name), card);
    const plain = normName(plainName(card));
    if (plain !== normName(card.name)) add(byName, plain, card);
  }
  return { byCode, byName };
}

/**
 * The spellings of one incoming code worth trying, best first, plus whatever the
 * code itself said about the finish. Piltover Archive hangs `-Foil` off the end
 * of its variant number, RiftMana marks a promo with `-p`, RiftCore writes `S`
 * where the game prints a star, and a collector number may or may not be padded.
 */
function codeKeys(raw) {
  let s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  let foil = false;
  if (s.endsWith('-foil')) { foil = true; s = s.slice(0, -5); }
  s = s.replace(/-(?:p|promo)$/, '');
  if (!s) return { keys: [], foil };

  const m = /^([a-z]{2,4})-?([a-z]*)(\d+)([a-z*]?)$/.exec(s);
  if (!m) return { keys: [s], foil };

  const [, set, prefix, digits, rawMark] = m;
  const mark = rawMark === 's' ? '*' : rawMark;
  const pad = digits.padStart(3, '0');
  const keys = [];
  const push = (k) => { if (!keys.includes(k)) keys.push(k); };
  push(`${set}-${prefix}${digits}${mark}`);
  push(`${set}-${prefix}${pad}${mark}`);
  push(`${set}-${prefix}${pad}`);
  push(`${set}-${pad}${mark}`);
  push(`${set}-${pad}`);
  return { keys, foil };
}

/** Reads a foil/finish cell however the file spells it. */
const readsAsFoil = (v) => /^(1|y|yes|true|foil|holo|premium)\b/i.test(String(v || '').trim());
const readsAsTrue = (v) => /^(1|y|yes|true)\b/i.test(String(v || '').trim());

const readCount = (v) => {
  const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? Math.min(99, n) : 0;
};

/**
 * Accumulates resolved rows into a collection-shaped map, keeping both the
 * counts that landed and the rows that didn't. Two rows for one card — a normal
 * row and a foil row, which is how our own CSV and OpenRift's file spell a
 * stack — add up rather than the second overwriting the first.
 */
function makeTally() {
  const tally = {
    entries: {},
    unresolved: [],
    read: 0,
    ambiguous: 0,
    /** `hit` is one of our cards, or null when nothing answered to the row. */
    take(hit, label, { q = 0, f = 0, w = false } = {}) {
      if (!q && !f && !w) return;
      tally.read++;
      if (!hit) {
        if (tally.unresolved.length < 400) tally.unresolved.push(label);
        return;
      }
      const cur = tally.entries[hit.id] || { q: 0, f: 0, w: false };
      tally.entries[hit.id] = {
        q: Math.min(99, cur.q + q),
        f: Math.min(99, cur.f + f),
        w: cur.w || w,
      };
    },
  };
  return tally;
}

/**
 * Resolves a row to one of our cards. A code that answers for exactly one card
 * settles it. Otherwise the name gets a turn, because a name pointing at a
 * single card beats a code pointing at several — our own text export keeps
 * `(Alternate Art)` in the name where the `(OGN 007)` beside it can't tell the
 * two printings apart. The name is only allowed to decide within the set the
 * code named, or a reprint elsewhere would win an argument it isn't in.
 */
function resolveCard(code, name) {
  importLookup ||= buildImportLookup();
  const { keys } = codeKeys(code);

  let byCode = null;
  for (const key of keys) {
    const hit = importLookup.byCode.get(key);
    if (hit) { byCode = hit; break; }
  }
  if (byCode?.length === 1) return { card: byCode[0], ambiguous: false };

  const named = importLookup.byName.get(normName(name)) || [];
  const set = keys[0]?.split('-')[0];
  const fitting = set ? named.filter((c) => c.set_id.toLowerCase() === set) : named;
  if (fitting.length === 1) return { card: fitting[0], ambiguous: false };

  if (byCode) return { card: byCode[0], ambiguous: true };
  if (named.length) return { card: named[0], ambiguous: named.length > 1 };
  return { card: null, ambiguous: false };
}

/** A table, read by what its columns mean rather than by whose format it is. */
function importTable(rows) {
  const header = findHeader(rows);
  if (!header) return null;

  const { at, roles } = header;
  const tally = makeTally();
  const cell = (row, role) =>
    roles[role] === undefined ? '' : String(row[roles[role]] ?? '').trim();

  for (let i = at + 1; i < rows.length; i++) {
    const row = rows[i];
    let code = cell(row, 'code');
    const name = cell(row, 'name');
    // RiftCore repeats its banner under the header rather than above it.
    if (/^exported from/i.test(code)) continue;

    // A file that split the set into its own column — or that only had a bare
    // collector number to give — gets them put back together.
    if (code && !code.includes('-')) {
      const set = cell(row, 'set');
      if (/^[a-z]{2,4}$/i.test(set)) code = `${set}-${code}`;
    }

    const foil = codeKeys(code).foil || readsAsFoil(cell(row, 'finish'));
    // Two count columns is the shape that needs no inference — it's how this app
    // stores a stack, and how RiftCore and RiftMana write one.
    const split = roles.normal !== undefined || roles.foilQty !== undefined;
    const total = readCount(cell(row, 'qty'));
    const q = split ? readCount(cell(row, 'normal')) : foil ? 0 : total;
    const f = split ? readCount(cell(row, 'foilQty')) : foil ? total : 0;
    const w = roles.wish !== undefined && readsAsTrue(cell(row, 'wish'));

    // Either column can be the more specific one. Our own CSV pairs a
    // riftbound.gg-shaped `OGN-007` with a `007a` that still knows which
    // printing it is; RiftCore does the reverse, `OGN-007A` beside a bare `007`.
    // So both are asked, most specific first — and carrying a treatment marker
    // is what "more specific" means.
    const num = cell(row, 'num');
    const set = /^([a-z]{2,4})/i.exec(code)?.[1] || cell(row, 'set');
    const fromNum = num && /^[a-z]{2,4}$/i.test(set) ? `${set}-${num}` : '';
    const marked = (c) => /\d[a-z*]$/i.test(c);
    const candidates = [code, fromNum]
      .filter(Boolean)
      .sort((a, b) => Number(marked(b)) - Number(marked(a)));

    let hit = { card: null, ambiguous: false };
    for (const candidate of candidates) {
      const found = resolveCard(candidate, name);
      if (found.card && !found.ambiguous) { hit = found; break; }
      if (found.card && !hit.card) hit = found;
    }
    if (hit.ambiguous) tally.ambiguous++;
    tally.take(hit.card, name || code || `row ${i + 1}`, { q, f, w });
  }
  return tally.read ? tally : null;
}

/**
 * A plain list: `3x Ashe, Frost Archer (OGN 012) [1 foil]` from our own text
 * export, or the bare `3 Ashe, Frost Archer` a mass-entry box takes. The
 * wishlist section of our export carries no counts, so a `Wishlist` heading
 * turns the countless lines below it from noise into wishlist entries.
 */
function importList(text) {
  const tally = makeTally();
  let wishSection = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^-+$/.test(line)) continue;
    // Our own export's summary line opens with a count but describes no card.
    if (line.includes('·')) continue;
    if (/^wishlist$/i.test(line)) { wishSection = true; continue; }

    const counted = /^(\d+)\s*[x×]?\s+(.*\S)$/.exec(line);
    if (!counted && !wishSection) continue;

    const body = counted ? counted[2] : line;
    const total = counted ? readCount(counted[1]) : 0;
    // `(OGN 012)` or `(OGN-012)` — the printed identifier our text export adds.
    const at = /\(([A-Za-z]{2,4})[\s-]([A-Za-z0-9*]{1,5})\)\s*(?:\[|$)/.exec(body);
    const foils = /\[(\d+)\s*foils?\]/i.exec(body);
    const f = Math.min(total, foils ? readCount(foils[1]) : 0);
    // Only the trailing identifier and foil note come off. A bracket earlier in
    // the line belongs to the name — `Fury Rune (Alternate Art)` is the whole
    // reason the name can settle what the collector number can't.
    const name = body
      .replace(/\s*\[[^\]]*\]\s*$/, '')
      .replace(/\s*\([A-Za-z]{2,4}[\s-][A-Za-z0-9*]{1,5}\)\s*$/, '')
      .trim();
    if (!at && !name) continue;

    const { card, ambiguous } = resolveCard(at ? `${at[1]}-${at[2]}` : '', name);
    if (ambiguous) tally.ambiguous++;
    tally.take(card, name || line, counted ? { q: total - f, f } : { w: true });
  }
  return tally.read ? tally : null;
}

/** Our own backup: card ids straight through, with no resolving to do. */
function importBackup(text) {
  const data = JSON.parse(text);
  const incoming = data.collection ?? data;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return null;

  const { clean, skipped } = sanitize(incoming);
  const tally = makeTally();
  tally.entries = clean;
  tally.read = Object.keys(clean).length + skipped;
  for (let i = 0; i < skipped && i < 400; i++) tally.unresolved.push('a card id this catalogue has no row for');
  return tally.read ? tally : null;
}

/**
 * Works out what a file is and reads it. JSON is tried first because it's ours
 * and unambiguous; everything else falls through the table reader to the list
 * reader, which is the loosest thing that can still be believed.
 */
function readImport(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const tally = importBackup(trimmed);
      if (tally) return { kind: 'backup', tally };
    } catch { /* not our JSON after all — let the table reader have it */ }
  }

  const table = importTable(readCSV(text));
  if (table) return { kind: 'table', tally: table };

  const list = importList(text);
  if (list) return { kind: 'list', tally: list };

  return null;
}

/* ---------------- import review ---------------- */

const importModal = el('import-modal');
/** The parsed file, waiting on a choice of how to apply it. */
let pendingImport = null;

const IMPORT_KINDS = {
  backup: 'a Riftbound Collection backup',
  table: 'a collection CSV',
  list: 'a card list',
};

/** Totals of a collection-shaped map, for the before-and-after lines. */
function tallyTotals(entries) {
  let cards = 0, copies = 0, foils = 0, wishes = 0;
  for (const e of Object.values(entries)) {
    if (e.q || e.f) cards++;
    copies += e.q + e.f;
    foils += e.f;
    if (e.w) wishes++;
  }
  return { cards, copies, foils, wishes };
}

/** What the collection becomes under each of the two choices. */
function mergedWith(entries, mode) {
  if (mode === 'replace') return { ...entries };
  const out = {};
  for (const [id, e] of Object.entries(collection)) out[id] = { ...e };
  for (const [id, e] of Object.entries(entries)) {
    const cur = out[id] || { q: 0, f: 0, w: false };
    out[id] = {
      q: Math.min(99, cur.q + e.q),
      f: Math.min(99, cur.f + e.f),
      w: cur.w || e.w,
    };
  }
  return out;
}

/**
 * The review step, and the reason Import stopped being a one-line confirm: a
 * file from another tracker never lands cleanly, and which rows didn't make it
 * is the thing worth knowing *before* the collection changes.
 */
function renderImportReview() {
  const { kind, tally } = pendingImport;
  const found = tallyTotals(tally.entries);
  const now = tallyTotals(collection);
  const after = tallyTotals(mergedWith(tally.entries, 'add'));
  const missed = tally.unresolved.length;

  el('import-sub').textContent =
    `Read ${IMPORT_KINDS[kind]} — ${tally.read} row${tally.read === 1 ? '' : 's'}.`;

  const samples = [...new Set(tally.unresolved)].slice(0, 6);
  const notes = [];
  if (tally.ambiguous) {
    notes.push(
      `<p class="import-note"><b>${tally.ambiguous}</b> row${
        tally.ambiguous === 1 ? '' : 's'
      } matched more than one card — several Organized Play printings share a
       collector number, and reprints share a name. Each went to the
       earliest-printed one.</p>`
    );
  }
  if (missed) {
    notes.push(
      `<p class="import-note"><b>${missed}</b> row${
        missed === 1 ? '' : 's'
      } matched no card here and will be left out${
        samples.length ? `: ${samples.map(esc).join(', ')}${missed > samples.length ? '…' : ''}` : '.'
      }</p>`
    );
  }

  el('import-body').innerHTML = `
    <div class="import-figs">
      <div class="import-fig"><b>${found.cards}</b><span>cards in the file</span></div>
      <div class="import-fig"><b>${found.copies}</b><span>copies${
        found.foils ? `, ${found.foils} foil` : ''
      }</span></div>
      ${found.wishes ? `<div class="import-fig"><b>${found.wishes}</b><span>wishlisted</span></div>` : ''}
    </div>
    ${notes.join('')}
    <ul class="import-choices">
      <li><b>Add</b> stacks the counts on top of what you already have —
        ${now.copies} copies become <b>${after.copies}</b>. Importing the same
        file twice counts it twice.</li>
      <li><b>Replace</b> clears your ${now.cards} card${
        now.cards === 1 ? '' : 's'
      } first, leaving only what's in the file. This is what restoring a backup
        wants.</li>
    </ul>`;
}

function closeImport() {
  pendingImport = null;
  if (importModal.open) importModal.close();
}

function applyImport(mode) {
  if (!pendingImport) return;
  const next = mergedWith(pendingImport.tally.entries, mode);
  const before = tallyTotals(collection);

  // The same pruning setEntry does, so an entry adding up to nothing isn't kept.
  collection = {};
  for (const [id, e] of Object.entries(next)) {
    if (e.q > 0 || e.f > 0 || e.w) collection[id] = { q: e.q, f: e.f, w: !!e.w };
  }

  const after = tallyTotals(collection);
  closeImport();
  save();
  render();
  toast(
    mode === 'replace'
      ? `Collection replaced — ${after.cards} cards, ${after.copies} copies`
      : `Added ${after.copies - before.copies} copies across ${after.cards} cards`
  );
}

el('btn-import').addEventListener('click', () => el('file-import').click());

el('file-import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  // Someone else's binder is read-only all the way down, and an import is the
  // largest write there is.
  if (viewing) {
    toast('Leave this collection before importing');
    return;
  }

  let parsed = null;
  try {
    parsed = readImport(await file.text());
  } catch {
    parsed = null;
  }

  if (!parsed) {
    toast('Nothing readable in that file — try a JSON backup, a collection CSV or a card list');
    return;
  }

  pendingImport = parsed;
  renderImportReview();
  setMenu(false);
  importModal.showModal();
});

el('import-add').addEventListener('click', () => applyImport('add'));
el('import-replace').addEventListener('click', () => applyImport('replace'));
el('import-cancel').addEventListener('click', closeImport);
el('import-close').addEventListener('click', closeImport);
// Escape and the backdrop close the dialog on their own; drop the file with it.
importModal.addEventListener('close', () => { pendingImport = null; });

/* ---------------- deck generator ---------------- */

const deckModal = el('deck-modal');
let currentDeck = null;

const CURVE_LABELS = { 2: '≤2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7+' };

function domainDots(card) {
  return card.domains
    .map((d) => `<span class="dot" style="background:${runePaint(d)}" title="${esc(d)}"></span>`)
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
      <button class="deck-row-name" type="button" data-card="${esc(c.id)}"
              title="Card details">${esc(pick.name)}</button>
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

  /* The plan the generator settled on, with the two halves of each theme shown
   * separately — a lopsided pair is the thing worth knowing, since it means the
   * collection could only supply one end of the loop. */
  const themes = (deck.themes || []).length
    ? `<div class="deck-themes">
        <span class="deck-themes-label">Built around</span>
        ${deck.themes
          .map(
            (t) =>
              `<span class="deck-theme" title="${t.enablers} card${
                t.enablers === 1 ? '' : 's'
              } that set it up, ${t.payoffs} that pay it off">${esc(t.label)}
               <b>${t.enablers}/${t.payoffs}</b></span>`
          )
          .join('')}
      </div>`
    : `<p class="deck-themes-none">No synergy runs deep enough in your collection to
        build around yet — this is your best cards, shaped to the curve.</p>`;

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
    ${themes}
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
    of your legal cards are <em>best</em> together is a judgement call. It ranks them
    on rarity, champion tags, energy curve and keyword density, then looks for the
    synergies your collection can actually field — discard, XP, empower and the rest —
    and trades cards one at a time while the deck as a whole keeps improving${
      deck.swaps ? ` (${deck.swaps} trade${deck.swaps === 1 ? '' : 's'} here)` : ''
    }. Click any card for its details.</p>`;
}

function buildDeck(legendId = null) {
  currentDeck = window.RiftboundDeck.buildDeck({
    cards: CARDS,
    // A foil is the same card across the table, so the pool counts every copy.
    qtyOf: copiesOf,
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
// A card name opens its details on top, leaving this dialog open underneath —
// closing the detail view puts you back on the list you were reading.
deckModal.addEventListener('click', (e) => {
  if (e.target === deckModal) return deckModal.close();
  const name = e.target.closest('[data-card]');
  if (name) openCardDetail(name.dataset.card);
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

/* ---------------- cloud seam ---------------- */

/**
 * The whole surface cloud.js and social.js are allowed to touch. Keeping it this
 * small means both stay add-ons: delete the two files and the config and the app
 * is exactly the local-only tracker it started as, with nothing to unpick.
 */
window.RiftboundApp = {
  getCollection: () => collection,
  /**
   * Replaces the collection with server data and redraws. Never echoes back.
   * Always your own collection — a visitor's arrives through setViewing, which
   * is the difference between reading someone's binder and overwriting yours.
   */
  applyCollection(next) {
    collection = sanitize(next).clean;
    persist({ fromCloud: true });
    render();
  },
  sanitize: (incoming) => sanitize(incoming).clean,
  toast,
  setViewing,
  /** The handle currently being visited, or null. */
  viewingHandle: () => viewing?.handle || null,
};

/* ---------------- init ---------------- */

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

bindSelect('f-set', 'set', 'All sets', META.sets.map((s) => s.id),
  (id) => META.sets.find((s) => s.id === id).name);
bindSelect('f-domain', 'domain', 'All domains', META.domains, titleCase, (d) =>
  `color:var(--f-${esc(d)}, var(--f-colorless))`
);
bindSelect('f-rarity', 'rarity', 'All rarities', META.rarities, titleCase);
bindSelect('f-type', 'type', 'All types', META.types);

// A remembered sort can name an option that isn't offered — a price order saved
// before data/prices.js went missing — so fall back rather than showing nothing.
state.sort = SORTS.some((s) => s.id === prefs.sort) ? prefs.sort : '';
bindSort();
syncMuteBtn();

render();
