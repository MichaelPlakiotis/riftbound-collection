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

async function main() {
  console.log('Syncing Riftbound cards from Riftcodex...');

  const setsRes = await getJSON('/sets?size=100');
  const rawCards = await fetchAllCards();

  const { cards: unique, collapsed, suffixed } = dedupe(rawCards.filter((c) => c.riftbound_id));
  console.log(
    `  ${rawCards.length} rows -> ${unique.length} cards ` +
      `(${collapsed} duplicate rows collapsed, ${suffixed} alternate printings kept)`
  );

  const cards = unique
    .map(normalize)
    .sort(
      (a, b) =>
        a.set_id.localeCompare(b.set_id) ||
        a.collector_number - b.collector_number ||
        a.variant.localeCompare(b.variant)
    );

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
