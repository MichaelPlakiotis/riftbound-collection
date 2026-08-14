#!/usr/bin/env node
// Pulls the full Riftbound card list from the Riftcodex community API and
// writes it to data/cards.js so the tracker works offline from file://.
//
//   node sync-cards.mjs
//
// Riftcodex is used over RiftScribe because it carries the Vendetta (VEN) set,
// the promo sets, real set names, and multi-domain data. Card IDs are identical
// between the two APIs (`ogn-214a-298`), so switching sources does not orphan a
// saved collection.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.riftcodex.com';
const PAGE_SIZE = 100; // server rejects anything above ~200
const THUMB = 'w=320&fm=webp&q=80'; // Riot's CDN is Sanity-backed: 721KB png -> 19KB webp

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, 'data');

async function getJSON(path, attempt = 1) {
  try {
    const res = await fetch(`${API}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 4) throw new Error(`${path} failed after 4 tries: ${err.message}`);
    await new Promise((r) => setTimeout(r, 400 * attempt));
    return getJSON(path, attempt + 1);
  }
}

async function fetchAllCards() {
  const out = [];
  for (let page = 1; ; page++) {
    const res = await getJSON(`/cards?size=${PAGE_SIZE}&page=${page}&sort=public_code&dir=1`);
    out.push(...res.items);
    process.stdout.write(`\r  fetched ${out.length}/${res.total}`);
    if (page >= res.pages) break;
  }
  process.stdout.write('\n');
  return out;
}

/** Most complete row wins: one linked to TCGplayer, then most recently updated. */
const bestOf = (rows) =>
  [...rows].sort(
    (a, b) =>
      (b.tcgplayer_id ? 1 : 0) - (a.tcgplayer_id ? 1 : 0) ||
      (b.metadata?.updated_on || '').localeCompare(a.metadata?.updated_on || '') ||
      String(a.id).localeCompare(String(b.id))
  )[0];

/**
 * Riftcodex serves 1451 rows for 1304 distinct card IDs, for two different
 * reasons that have to be told apart:
 *
 *  - A newly released set gets ingested twice. Both rows are the same card with
 *    the same art, and only one is linked to TCGplayer — the other is a stub,
 *    sometimes under a slightly different name ("… (Alternate Art)" vs plain).
 *    All 131 of these collapse to the complete row.
 *  - 16 promos are genuinely two products under one ID: "Yasuo - Unforgiven" and
 *    "Yasuo - Unforgiven (Metal)" are both `opp-259-298`. They're separate cards
 *    to own, so each keeps its own count.
 *
 * Art can't tell these apart (every duplicate group shares one image URL), but
 * TCGplayer IDs can: two distinct IDs means two real products, while a stub row
 * has none. That splits all 147 groups correctly with nothing left over.
 *
 * Ordering is deterministic so IDs stay stable across syncs and never orphan a
 * saved collection; the base printing sorts first and keeps the clean ID.
 */
function dedupe(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.riftbound_id)) byId.set(r.riftbound_id, []);
    byId.get(r.riftbound_id).push(r);
  }

  const out = [];
  let collapsed = 0;
  let suffixed = 0;

  for (const [rid, group] of byId) {
    const productIds = [...new Set(group.map((r) => r.tcgplayer_id).filter(Boolean))];

    if (productIds.length <= 1) {
      collapsed += group.length - 1;
      out.push({ ...bestOf(group), riftbound_id: rid });
      continue;
    }

    // Several real products share this ID. Rows with no TCGplayer ID are stubs
    // of one of them and can't be attributed, so they're dropped.
    collapsed += group.filter((r) => !r.tcgplayer_id).length;

    productIds
      .map((t) => bestOf(group.filter((r) => r.tcgplayer_id === t)))
      .sort((a, b) => a.name.localeCompare(b.name) || String(a.tcgplayer_id).localeCompare(String(b.tcgplayer_id)))
      .forEach((row, i) => {
        if (i > 0) suffixed++;
        out.push({ ...row, riftbound_id: i === 0 ? rid : `${rid}~${i + 1}` });
      });
  }

  return { cards: out, collapsed, suffixed };
}

/**
 * `ogn-214a-298` -> `a`, `unl-229*-219` -> `*`. Codes whose number segment isn't
 * numeric at all (`ven-r01`, `ven-sp2-006`) have no variant marker.
 */
function variantOf(riftboundId) {
  const seg = String(riftboundId || '').split('~')[0].split('-')[1] || '';
  const m = /^\d+(.+)$/.exec(seg);
  return m ? m[1].toLowerCase() : '';
}

/** Pull bracketed rules terms out of card text: "[Burn 1]" -> "burn". */
function keywordsOf(text) {
  const found = new Set();
  for (const m of (text || '').matchAll(/\[([A-Za-z][A-Za-z\s'–—-]*?)(?:\s+\d+)?\]/g)) {
    found.add(m[1].trim().toLowerCase());
  }
  return [...found];
}

function thumbUrl(url) {
  if (!url) return '';
  return url + (url.includes('?') ? '&' : '?') + THUMB;
}

function normalize(c) {
  const plain = c.text?.plain ?? null;
  return {
    id: c.riftbound_id,
    name: c.name,
    set_id: c.set?.set_id ?? '',
    collector_number: c.collector_number,
    variant: variantOf(c.riftbound_id),
    rarity: (c.classification?.rarity || '').toLowerCase(),
    type: c.classification?.type || '',
    supertype: c.classification?.supertype || null,
    domains: c.classification?.domain?.length ? c.classification.domain.map((d) => d.toLowerCase()) : ['colorless'],
    stats: {
      energy: c.attributes?.energy ?? null,
      might: c.attributes?.might ?? null,
      power: c.attributes?.power ?? null,
    },
    description: plain,
    flavor_text: c.text?.flavour ?? null,
    keywords: keywordsOf(plain),
    tags: c.tags ?? [],
    orientation: c.orientation || 'portrait',
    image: thumbUrl(c.media?.image_url),
    image_full: c.media?.image_url || '',
    artist: c.media?.artist ?? null,
    tcgplayer_id: c.tcgplayer_id ?? null,
    alternate_art: !!c.metadata?.alternate_art,
    // >1 for extra printings that share a card ID (e.g. the Metal promos)
    printing: Number(String(c.riftbound_id).split('~')[1] || 1),
  };
}

/* ---------------- TCGplayer supplement ---------------- */

const TCG_SEARCH = 'https://mp-search-api.tcgplayer.com/v1/search/request?q=&isList=false';
const TCG_LINE = 'riftbound-league-of-legends-trading-card-game';

/**
 * Riftcodex lags TCGplayer's catalogue — as of writing it carries no Rune rows
 * at all for Unleashed or Spiritforged, so a rune pulled from either pack simply
 * doesn't exist in the tracker. TCGplayer lists every printed product and, in
 * `customAttributes`, enough to build a usable card: collector number, type,
 * domain, costs, rarity and often the rules text.
 */
async function fetchTcgProducts() {
  const out = [];
  let from = 0;
  let total = Infinity;

  while (from < total) {
    const res = await fetch(TCG_SEARCH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        origin: 'https://www.tcgplayer.com',
        referer: 'https://www.tcgplayer.com/',
        'user-agent': 'riftbound-collection/1.0 (personal collection tracker)',
      },
      body: JSON.stringify({
        algorithm: 'sales_synonym_v2',
        from,
        size: 50,
        filters: { term: { productLineName: [TCG_LINE] }, range: {}, match: {} },
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
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`TCGplayer HTTP ${res.status}`);
    const result = (await res.json()).results?.[0];
    if (!result) throw new Error('TCGplayer returned no results block');
    total = result.totalResults ?? 0;
    out.push(...(result.results ?? []));
    from += 50;
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

/**
 * Rebuilds the Riftbound ID a card would carry if Riftcodex knew about it.
 * Verified against the 1049 products we already hold: every one reproduces its
 * real ID exactly. Two number shapes are trustworthy and nothing else is:
 *
 *   "131/219" -> unl-131-219     ordinary collector number over set size
 *   "R05"     -> unl-r05         runes, which Vendetta already numbers this way
 *
 * Tokens ("T02 // T04"), signature variants (a starred collector number) and
 * alternate arts ("084a/166") get no ID — their real shape isn't predictable
 * from here, and a wrong guess is worse than an absent card, because
 * collections key off the ID.
 */
function predictId(product) {
  const code = (product.setCode || '').toLowerCase();
  const num = String(product.customAttributes?.number || '');
  if (!code) return null;

  const numbered = /^(\d+)\/(\d+)$/.exec(num);
  if (numbered) return `${code}-${numbered[1].padStart(3, '0')}-${numbered[2]}`;

  const rune = /^R(\d+)([a-z]?)$/i.exec(num);
  if (rune) return `${code}-r${rune[1].padStart(2, '0')}${(rune[2] || '').toLowerCase()}`;

  return null;
}

/** TCGplayer writes rules text as HTML; the app expects Riftcodex's plain text. */
const plainText = (html) =>
  html
    ? String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : null;

/** "Champion Unit" -> type Unit, supertype Champion. "Rune" -> type Rune. */
function typeOf(cardType) {
  const raw = (cardType || []).join(' ').trim();
  if (!raw || raw === 'None') return { type: '', supertype: null };
  const parts = raw.split(/\s+/);
  return {
    type: parts[parts.length - 1],
    supertype: parts.length > 1 ? parts.slice(0, -1).join(' ') : null,
  };
}

/**
 * TCGplayer writes "0" wherever a cost doesn't apply; Riftcodex writes null, and
 * the app leans on that — the price/cost sorts deliberately sink cards with
 * nothing to sort on, so a Rune claiming energy 0 would jump ahead of them.
 * Mirrored from the real rows: Battlefields, Legends and Runes carry no stats at
 * all, and `might` belongs to Units alone.
 */
function statsFor(type, attr) {
  const none = { energy: null, might: null, power: null };
  if (['Battlefield', 'Legend', 'Rune'].includes(type)) return none;

  const num = (v) => (v == null || v === '' ? null : Number(v));
  const zeroIsNothing = (v) => (num(v) ? num(v) : null);

  return {
    energy: num(attr.energyCost),
    might: type === 'Unit' ? num(attr.might) : null,
    power: zeroIsNothing(attr.powerCost),
  };
}

function synthesise(product, id) {
  const attr = product.customAttributes || {};
  const { type, supertype } = typeOf(attr.cardType);
  const domains = String(attr.domain || '')
    .split(';')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d && d !== 'none');
  const num = /^(\d+)/.exec(String(attr.number || ''));
  const runeNum = /^R(\d+)/i.exec(String(attr.number || ''));
  const description = plainText(attr.description);
  const rarity = String(attr.rarityDbName || '').toLowerCase();

  return {
    id,
    name: product.productName,
    set_id: product.setCode,
    collector_number: Number(num?.[1] ?? runeNum?.[1] ?? 0),
    // Only the rune IDs carry a variant letter; numbered ones are accepted only
    // in their plain "131/219" form.
    variant: /-r\d+([a-z])$/.exec(id)?.[1] || '',
    rarity: rarity === 'none' ? '' : rarity,
    type,
    supertype,
    domains: domains.length ? domains : ['colorless'],
    stats: statsFor(type, attr),
    description,
    flavor_text: attr.flavorText || null,
    keywords: keywordsOf(description),
    tags: attr.tag ? String(attr.tag).split(';').map((t) => t.trim()).filter(Boolean) : [],
    orientation: 'portrait',
    // TCGplayer's CDN answers 403 to anything it didn't serve the page for, so
    // there is no art for these. The app shows a labelled placeholder instead.
    image: '',
    image_full: '',
    artist: null,
    tcgplayer_id: product.productId ? String(product.productId) : null,
    alternate_art: /\(alternate art\)/i.test(product.productName),
    printing: 1,
    // Marks a card the app built itself rather than one Riftcodex served.
    partial: true,
  };
}

/**
 * Adds cards TCGplayer lists and Riftcodex doesn't. Three guards, because a bad
 * ID is worse than a missing card — collections are keyed by ID, so a synthetic
 * card that collides with a real one silently rewrites what someone owns:
 *
 *  1. the ID has to come from a number shape we trust (see predictId)
 *  2. it must not already belong to a real card
 *  3. two products must not want the same ID
 *
 * On the current catalogue that admits 91 of 232 unmatched products, including
 * every missing rune. The rest — Prize Wall metals, tokens, signature variants —
 * are left out rather than guessed at.
 */
function supplement(cards, products) {
  const knownSets = new Set(cards.map((c) => c.set_id));
  const byProduct = new Set(cards.map((c) => String(c.tcgplayer_id)).filter(Boolean));
  const byId = new Set(cards.map((c) => c.id));

  const norm = (s) =>
    String(s).toLowerCase().replace(/[,\-–—]/g, ' ').replace(/[^a-z0-9() ]/g, '').replace(/\s+/g, ' ').trim();
  const byName = new Set(cards.map((c) => `${norm(c.name)}|${c.set_id}`));

  const unmatched = products.filter(
    (p) =>
      !byProduct.has(String(p.productId)) &&
      !byName.has(`${norm(p.productName)}|${p.setCode}`)
  );

  // Count first: an ID two products both claim is ambiguous, so neither gets it.
  const wanted = new Map();
  for (const p of unmatched) {
    const id = predictId(p);
    if (id) wanted.set(id, (wanted.get(id) || 0) + 1);
  }

  const added = [];
  const skipped = { noId: 0, collision: 0, ambiguous: 0, unknownSet: 0 };

  for (const p of unmatched) {
    const id = predictId(p);
    if (!id) { skipped.noId++; continue; }
    if (!knownSets.has(p.setCode)) { skipped.unknownSet++; continue; }
    if (byId.has(id)) { skipped.collision++; continue; }
    if (wanted.get(id) > 1) { skipped.ambiguous++; continue; }
    added.push(synthesise(p, id));
    byId.add(id);
  }

  return { added, skipped, unmatched: unmatched.length };
}

/* ---------------- art for the cards TCGplayer can't illustrate ---------------- */

// riftbound.gg runs on dotgg, whose card API is public and serves art from its
// own CDN. It's the same catalogue this app already targets for the riftbound.gg
// export, so the ID scheme is one we're used to.
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

/**
 * Our ID to dotgg's, best guess first. They file variants their own way and the
 * differences are worth spelling out, because matching the wrong row would hang
 * another printing's art on a card:
 *
 *   ogn-166a-298 -> OGN-166a      alternate art keeps the letter
 *   unl-229*-219 -> UNL-229-STAR  our star is their -STAR
 *   unl-r05      -> UNL-R05       runes, numbered the same way
 *   ogn-166-298  -> OGN-166       plain
 */
function dotggCandidates(card) {
  const set = card.set_id;
  const seg = String(card.id).split('-')[1] || '';

  const rune = /^r(\d+)([a-z]?)$/i.exec(seg);
  if (rune) return [`${set}-R${rune[1].padStart(2, '0')}${rune[2] || ''}`];

  const n = String(card.collector_number).padStart(3, '0');
  const letter = (/^\d+([a-z])/i.exec(seg) || [])[1] || '';
  const out = [];
  if (/\*/.test(seg)) out.push(`${set}-${n}-STAR`);
  if (letter) out.push(`${set}-${n}${letter}`);
  out.push(`${set}-${n}`);
  if (card.rarity === 'promo') out.push(`${set}-${n}-P`);
  return out;
}

/**
 * Records each card's dotgg counterpart and fills art for the ones that have
 * none — those built from TCGplayer, whose CDN answers 403 to anything it didn't
 * serve the page for. Cards already carrying Riot's own art keep it: it's the
 * better image and it already works.
 *
 * The ID is stored rather than just consumed, so sync-prices.mjs can pick up
 * Cardmarket figures for the same card without repeating this matching.
 */
function linkDotgg(cards, rows) {
  const byId = new Map(rows.map((r) => [String(r.id).toUpperCase(), r]));
  let linked = 0;
  let illustrated = 0;

  for (const card of cards) {
    for (const cand of dotggCandidates(card)) {
      const hit = byId.get(cand.toUpperCase());
      if (!hit) continue;
      card.dotgg_id = hit.id;
      linked++;
      if (!card.image && hit.image) {
        card.image = hit.image;
        card.image_full = hit.image;
        illustrated++;
      }
      break;
    }
  }
  return { linked, illustrated };
}

async function main() {
  console.log('Syncing Riftbound cards from Riftcodex...');

  const setsRes = await getJSON('/sets?size=100');
  const rawCards = await fetchAllCards();

  const { cards: unique, collapsed, suffixed } = dedupe(rawCards.filter((c) => c.riftbound_id));
  console.log(
    `  ${rawCards.length} rows -> ${unique.length} cards ` +
      `(${collapsed} duplicate rows collapsed, ${suffixed} alternate printings kept)`
  );

  console.log('Checking TCGplayer for cards Riftcodex is missing...');
  let extra = [];
  try {
    const products = await fetchTcgProducts();
    const { added, skipped, unmatched } = supplement(unique.map(normalize), products);
    extra = added;
    console.log(
      `  ${products.length} products, ${unmatched} unmatched -> ${added.length} added ` +
        `(skipped ${skipped.noId} unpredictable, ${skipped.collision} would collide, ` +
        `${skipped.ambiguous} ambiguous, ${skipped.unknownSet} unknown set)`
    );
  } catch (err) {
    // A supplement is a bonus, not a dependency — a bad day at TCGplayer should
    // still leave you with a complete Riftcodex sync.
    console.warn(`  TCGplayer unavailable (${err.message}) — Riftcodex data only`);
  }

  const cards = [...unique.map(normalize), ...extra].sort(
    (a, b) =>
      a.set_id.localeCompare(b.set_id) ||
      a.collector_number - b.collector_number ||
      a.variant.localeCompare(b.variant)
  );

  const artless = cards.filter((c) => !c.image).length;
  console.log(`Matching against dotgg (${artless} cards still need art)...`);
  try {
    const { linked, illustrated } = linkDotgg(cards, await fetchDotgg());
    console.log(
      `  ${linked} cards linked, ${illustrated} illustrated, ${artless - illustrated} still art-less`
    );
  } catch (err) {
    // Art and Cardmarket prices are both bonuses; a bad day at dotgg costs the
    // sync nothing that Riftcodex already provided.
    console.warn(`  dotgg unavailable (${err.message}) — no art fill, no Cardmarket link`);
  }

  const counts = cards.reduce((acc, c) => ((acc[c.set_id] = (acc[c.set_id] || 0) + 1), acc), {});

  const sets = setsRes.items
    .map((s) => ({
      id: s.set_id,
      name: s.name,
      total: counts[s.set_id] || 0,
      released: s.published_on ? s.published_on.slice(0, 10) : null,
      // Promo sets aren't part of normal set completion, so the app can hide them.
      promo: /promotional/i.test(s.name),
    }))
    .filter((s) => s.total > 0)
    .sort((a, b) => (a.promo - b.promo) || (b.released || '').localeCompare(a.released || ''));

  const uniq = (fn) => [...new Set(cards.flatMap(fn))].filter(Boolean).sort();

  const meta = {
    syncedAt: new Date().toISOString(),
    source: 'https://riftcodex.com',
    totalCards: cards.length,
    sets,
    domains: uniq((c) => c.domains),
    rarities: uniq((c) => [c.rarity]),
    types: uniq((c) => [c.type]),
  };

  await mkdir(DATA_DIR, { recursive: true });
  const payload = { meta, cards };

  await writeFile(join(DATA_DIR, 'cards.json'), JSON.stringify(payload, null, 2), 'utf8');
  // The .js copy is what index.html loads: a <script> tag works from file://,
  // fetch() on a local .json does not.
  await writeFile(
    join(DATA_DIR, 'cards.js'),
    `// Generated by sync-cards.mjs on ${meta.syncedAt} - do not edit by hand.\n` +
      `window.RIFTBOUND_DATA = ${JSON.stringify(payload)};\n`,
    'utf8'
  );

  console.log(`\nDone. ${cards.length} cards across ${sets.length} sets:`);
  for (const s of sets) {
    console.log(
      `  ${s.id.padEnd(4)} ${s.name.padEnd(38)} ${String(s.total).padStart(4)}` +
        (s.promo ? '  (promo)' : '')
    );
  }
  console.log('\nWrote data/cards.js and data/cards.json');
}

main().catch((err) => {
  console.error('\nSync failed:', err.message);
  process.exit(1);
});
