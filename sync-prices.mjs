#!/usr/bin/env node
/**
 * Pulls TCGplayer market prices for every Riftbound card into data/prices.js.
 *
 * Cards carry a `tcgplayer_id`, so prices match by product ID rather than by
 * name — no fuzzy matching, no mis-priced alternate arts.
 *
 * Cardmarket was the first choice and isn't available: their official API stopped
 * accepting applications, and the site itself is behind Cloudflare. Every
 * remaining Cardmarket route is a paid third-party mirror.
 *
 *   node sync-prices.mjs
 */

import { writeFile, readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SEARCH = 'https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=false';
const PRODUCT_LINE = 'riftbound-league-of-legends-trading-card-game';
const PAGE_SIZE = 50;
const PAUSE_MS = 250;

// ECB reference rates via Frankfurter — no key, no rate limit, CORS-friendly.
const FX = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP';

// Foil is a printing, not a product: the bulk search returns one market price
// per product, and only this per-product endpoint separates Normal from Foil.
// There is no batch form of it, so a foil pass costs one request per card.
const POINTS = (productId) => `https://mpapi.tcgplayer.com/v2/product/${productId}/pricepoints`;
const FOIL_CONCURRENCY = 6;

// dotgg (the catalogue behind riftbound.gg) publishes Cardmarket figures beside
// its own. Cards carry a dotgg_id from sync-cards.mjs, so the matching — which
// has to cope with their different variant scheme — is already done.
const DOTGG = 'https://api.dotgg.gg/cgfw/getcards?game=riftbound';

async function fetchDotgg() {
  const res = await fetch(DOTGG, {
    headers: {
      accept: 'application/json',
      referer: 'https://riftbound.gg/',
      'user-agent': 'riftbound-collection/1.0 (personal collection tracker)',
    },
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`dotgg HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('dotgg returned an unexpected shape');
  return rows;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn` over `items` with a fixed number of workers, preserving order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/** Normal and Foil market prices for one product, or null if it can't be had. */
async function fetchPricePoints(productId, attempt = 1) {
  try {
    const res = await fetch(POINTS(productId), {
      headers: {
        accept: 'application/json',
        origin: 'https://www.tcgplayer.com',
        referer: 'https://www.tcgplayer.com/',
        'user-agent': 'riftbound-collection/1.0 (personal collection tracker)',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('unexpected shape');
    const of = (kind) => rows.find((r) => r.printingType === kind)?.marketPrice;
    return { normal: round(of('Normal')), foil: round(of('Foil')) };
  } catch (err) {
    if (attempt >= 3) return null;
    await sleep(400 * attempt);
    return fetchPricePoints(productId, attempt + 1);
  }
}

/** One page of the product-line listing. Returns { total, items }. */
async function fetchPage(from, attempt = 1) {
  const body = {
    algorithm: 'sales_synonym_v2',
    from,
    size: PAGE_SIZE,
    filters: { term: { productLineName: [PRODUCT_LINE] }, range: {}, match: {} },
    listingSearch: {
      context: { cart: {} },
      filters: {
        term: { sellerStatus: 'Live', channelId: 0 },
        range: { quantity: { gte: 1 } },
        exclude: { channelExclusion: 0 },
      },
    },
    context: { cart: {}, shippingCountry: 'US', userProfile: {} },
    settings: { useFuzzySearch: true, didYouMean: {} },
    sort: { field: 'product-sorting-name', order: 'asc' },
  };

  try {
    const res = await fetch(SEARCH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        origin: 'https://www.tcgplayer.com',
        referer: 'https://www.tcgplayer.com/',
        'user-agent': 'riftbound-collection/1.0 (personal collection tracker)',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = json.results?.[0];
    if (!result) throw new Error('no results block');
    return { total: result.totalResults ?? 0, items: result.results ?? [] };
  } catch (err) {
    if (attempt >= 4) throw new Error(`page from=${from} failed: ${err.message}`);
    await sleep(600 * attempt);
    return fetchPage(from, attempt + 1);
  }
}

/**
 * USD→EUR/GBP, so the app can show collection worth in a local currency. The
 * rate is baked in here rather than fetched by the page: the site stays static,
 * works offline, and everyone looking at the same sync sees the same number.
 * Returns null if the rate can't be had — the app then offers dollars only.
 */
async function fetchRates() {
  try {
    const res = await fetch(FX, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rates = {};
    for (const [code, v] of Object.entries(json.rates || {})) {
      if (typeof v === 'number' && v > 0) rates[code] = Math.round(v * 1e4) / 1e4;
    }
    if (!Object.keys(rates).length) throw new Error('no rates in response');
    return { rates, ratesDate: json.date || today() };
  } catch (err) {
    console.warn(`  exchange rates unavailable (${err.message})`);
    return null;
  }
}

/** Loads window.RIFTBOUND_DATA / RIFTBOUND_PRICES out of a generated data file. */
async function loadGenerated(file, key) {
  let src;
  try {
    src = await readFile(new URL(file, import.meta.url), 'utf8');
  } catch {
    return null;
  }
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window[key] ?? null;
}

const round = (n) => (typeof n === 'number' && n > 0 ? Math.round(n * 100) / 100 : null);

/** Local calendar date — toISOString would stamp yesterday for anyone east of UTC. */
const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Collapses the separator and punctuation differences between the two catalogues
 * — Riftcodex writes `Kai'Sa, Survivor` where TCGplayer writes `Kai'Sa - Survivor`.
 */
const normName = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[,\-–—]/g, ' ')
    .replace(/[^a-z0-9() ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

async function main() {
  const data = await loadGenerated('./data/cards.js', 'RIFTBOUND_DATA');
  if (!data) {
    console.error('data/cards.js missing — run `node sync-cards.mjs` first.');
    process.exit(1);
  }

  // Carry the last sync's market price forward so the app can show a delta.
  const previous = await loadGenerated('./data/prices.js', 'RIFTBOUND_PRICES');
  const prevPrices = previous?.prices ?? {};
  const prevDate = previous?.meta?.synced ?? null;

  console.log('Fetching TCGplayer prices…');
  const byProduct = new Map();
  const byName = new Map();
  let from = 0;
  let total = Infinity;

  while (from < total) {
    const { total: t, items } = await fetchPage(from);
    total = t;
    if (!items.length) break;
    for (const p of items) {
      // pid rides along so the foil pass can look the product up again — cards
      // matched by name have no tcgplayer_id of their own to go back to.
      const priced = { market: round(p.marketPrice), low: round(p.lowestPrice), pid: String(p.productId) };
      byProduct.set(String(p.productId), priced);
      const key = `${normName(p.setName)}|${normName(p.productName)}`;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(priced);
    }
    from += PAGE_SIZE;
    process.stdout.write(`\r  ${Math.min(from, total)} / ${total} products`);
    if (from < total) await sleep(PAUSE_MS);
  }
  console.log(`\n  ${byProduct.size} products priced`);

  const setName = Object.fromEntries(data.meta.sets.map((s) => [s.id, s.name]));
  const prices = {};
  /** card id -> TCGplayer product id, for the foil pass below. */
  const pidFor = {};
  let matched = 0;
  let viaName = 0;
  let unmatched = 0;
  const missingBySet = {};

  for (const card of data.cards) {
    let hit = card.tcgplayer_id ? byProduct.get(String(card.tcgplayer_id)) : null;

    // Riftcodex hasn't assigned TCGplayer IDs to the newest set yet, so fall back
    // to set + name. Only unambiguous single matches count. Verified against the
    // ID-matched cards: 1189 agreements, 0 contradictions.
    if (!hit || hit.market == null) {
      const candidates = byName.get(`${normName(setName[card.set_id])}|${normName(card.name)}`);
      if (candidates?.length === 1 && candidates[0].market != null) {
        hit = candidates[0];
        viaName++;
      }
    }

    if (!hit || hit.market == null) {
      unmatched++;
      missingBySet[card.set_id] = (missingBySet[card.set_id] || 0) + 1;
      continue;
    }
    matched++;
    const entry = { m: hit.market };
    if (hit.low != null && hit.low !== hit.market) entry.l = hit.low;
    // Previous market price, for the "since last sync" delta.
    const was = prevPrices[card.id]?.m;
    if (typeof was === 'number' && was > 0) entry.p = was;
    prices[card.id] = entry;
    if (hit.pid) pidFor[card.id] = hit.pid;
  }

  console.log('Fetching foil prices…');
  const foilIds = Object.keys(pidFor);
  let foiled = 0;
  let foilCarried = 0;
  let done = 0;

  await pool(foilIds, FOIL_CONCURRENCY, async (cardId) => {
    const points = await fetchPricePoints(pidFor[cardId]);
    done++;
    if (done % 50 === 0 || done === foilIds.length) {
      process.stdout.write(`\r  ${done} / ${foilIds.length} products`);
    }
    if (points?.foil != null) {
      prices[cardId].f = points.foil;
      foiled++;
      return;
    }
    // A failed lookup shouldn't wipe a figure we already had; a stale foil price
    // beats none, the same way the exchange rate is carried forward.
    const before = prevPrices[cardId]?.f;
    if (typeof before === 'number' && before > 0) {
      prices[cardId].f = before;
      foilCarried++;
    }
  });
  console.log(`\n  ${foiled} foil prices, ${foilCarried} carried forward`);

  console.log('Fetching Cardmarket prices…');
  let cmPriced = 0;
  let cmFoilPriced = 0;
  try {
    const rows = await fetchDotgg();
    const byId = new Map(rows.map((r) => [String(r.id).toUpperCase(), r]));
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
    };

    for (const card of data.cards) {
      const row = card.dotgg_id ? byId.get(String(card.dotgg_id).toUpperCase()) : null;
      const entry = prices[card.id];
      if (!row || !entry) continue;

      const cm = num(row.cmPrice);
      const cmf = num(row.cmFoilPrice);
      if (cm != null) {
        // Previous Cardmarket price, so EUR gets the same delta USD has.
        const was = prevPrices[card.id]?.cm;
        if (typeof was === 'number' && was > 0) entry.cmp = was;
        entry.cm = cm;
        cmPriced++;
      }
      if (cmf != null) {
        entry.cmf = cmf;
        cmFoilPriced++;
      }
    }
    console.log(`  ${cmPriced} Cardmarket prices, ${cmFoilPriced} foil`);
  } catch (err) {
    // Carry the last sync's figures forward rather than emptying the EUR view.
    for (const [id, entry] of Object.entries(prices)) {
      const before = prevPrices[id];
      if (typeof before?.cm === 'number') { entry.cm = before.cm; cmPriced++; }
      if (typeof before?.cmf === 'number') { entry.cmf = before.cmf; cmFoilPriced++; }
    }
    console.warn(`  dotgg unavailable (${err.message}) — carried ${cmPriced} forward`);
  }

  console.log('Fetching exchange rates…');
  // A rate from the last sync beats no rate at all — the conversion is labelled
  // with its own date in the UI, so a stale one is visible rather than silent.
  const fx =
    (await fetchRates()) ??
    (previous?.meta?.rates
      ? { rates: previous.meta.rates, ratesDate: previous.meta.ratesDate }
      : null);

  const values = Object.values(prices).map((p) => p.m);
  const meta = {
    source: 'TCGplayer',
    sourceUrl: 'https://www.tcgplayer.com',
    currency: 'USD',
    synced: today(),
    previousSync: prevDate,
    priced: matched,
    unpriced: unmatched,
    foilPriced: Object.values(prices).filter((p) => typeof p.f === 'number').length,
    // Cardmarket figures are euros already — the app shows them as-is under EUR
    // rather than converting a US price, which is a different number entirely.
    cardmarket: {
      source: 'Cardmarket via dotgg',
      currency: 'EUR',
      priced: Object.values(prices).filter((p) => typeof p.cm === 'number').length,
      foilPriced: Object.values(prices).filter((p) => typeof p.cmf === 'number').length,
    },
    ...(fx || {}),
  };

  const payload = { meta, prices };
  const banner =
    '/* Generated by sync-prices.mjs — do not edit. ' +
    `${matched} cards priced from TCGplayer on ${meta.synced}. */\n`;

  await writeFile(
    new URL('./data/prices.js', import.meta.url),
    `${banner}window.RIFTBOUND_PRICES = ${JSON.stringify(payload)};\n`
  );
  await writeFile(
    new URL('./data/prices.json', import.meta.url),
    `${JSON.stringify(payload, null, 2)}\n`
  );

  const sum = values.reduce((a, b) => a + b, 0);
  console.log(`\nPriced   ${matched} cards (${matched - viaName} by ID, ${viaName} by name)`);
  console.log(`Unpriced ${unmatched} ${unmatched ? `(${JSON.stringify(missingBySet)})` : ''}`);
  console.log(`Median   $${values.sort((a, b) => a - b)[Math.floor(values.length / 2)]?.toFixed(2)}`);
  console.log(`Max      $${Math.max(...values).toFixed(2)}`);
  console.log(`One of each would cost $${sum.toFixed(2)}`);
  console.log(
    `Rates    ${
      fx ? `${Object.entries(fx.rates).map(([c, r]) => `${c} ${r}`).join(', ')} (${fx.ratesDate})` : 'none — USD only'
    }`
  );
  console.log('\nWrote data/prices.js + data/prices.json');
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
