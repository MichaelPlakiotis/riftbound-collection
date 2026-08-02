/*
 * Deck generator — builds a legal, playable Riftbound deck out of cards you own.
 *
 * Rules implemented, from the official Core Rules §103 (2026-03-30):
 *
 *   103.1.b   One Champion Legend, whose domains set the deck's Domain Identity.
 *   103.2.a   A single-domain card is legal if its domain is in the identity; a
 *             multi-domain card only if the identity contains *all* its domains.
 *   103.2.b   Main Deck of 40 cards: one Chosen Champion, plus Units/Gear/Spells.
 *   103.2.c   The Chosen Champion must be a champion unit whose champion tag
 *             matches the Legend's tag. Signature units are not champion units
 *             and cannot fill the slot.
 *   103.2.d   Up to 3 copies of any one named card, the Chosen Champion included.
 *             Cards with different names are different cards even when they are
 *             the same character.
 *   103.2.e   At most 3 Signature cards in total regardless of name, and every
 *             one must carry the Legend's champion tag.
 *   103.3     A separate Rune Deck of exactly 12 runes, all within the identity.
 *   103.4     Battlefields, no two sharing a name.
 *
 * The physical-collection constraint on top of all that: a card is only available
 * up to the number of copies actually owned, counted across printings.
 */

(function (global) {
  'use strict';

  const MAIN_DECK = 40;
  const RUNE_DECK = 12;
  const BATTLEFIELDS = 3;
  const MAX_COPIES = 3;
  const MAX_SIGNATURES = 3;

  /**
   * Printing treatments that decorate a name without changing the card. Riftbound
   * counts copies "by named card", and an alternate art is the same named card, so
   * these have to collapse before the 3-copy limit is applied. Deliberately an
   * explicit list rather than "strip any trailing bracket": if a future set adds a
   * treatment we don't know, the copies simply don't merge, which under-counts
   * what you own instead of building an illegal deck.
   */
  const TREATMENT =
    /\s*\((?:alternate art|signature|overnumbered|starter|metal|gg ez|launch exclusive|ultimate)\)\s*$/i;

  const cardName = (c) => c.name.replace(TREATMENT, '');

  /**
   * The 3-copy limit counts *named cards*, so reprints have to collapse onto one
   * key. Riftcodex punctuates Vendetta reprints with a comma where the earlier
   * sets used a dash — `Jayce, Man of Progress` and `Jayce - Man of Progress` are
   * one card. Without this the builder would legally-looking run six copies.
   * Checked across the whole catalogue: the 16 names this merges all agree on
   * type, supertype, domains, energy, might and power, so nothing distinct is
   * being conflated.
   */
  const cardKey = (c) =>
    cardName(c)
      .toLowerCase()
      .replace(/[,\-–—]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const MAIN_TYPES = new Set(['Unit', 'Spell', 'Gear']);

  /**
   * Copies allowed of one named card. The Unique keyword makes a card a one-of;
   * everything else caps at 3. Only three cards carry it today (the Spiritforged
   * legendary gear), but running 3 of one would silently make the deck illegal.
   */
  const copyLimit = (card) =>
    (card.keywords || []).some((k) => k.trim().toLowerCase() === 'unique') ||
    /\[\s*unique\s*\]/i.test(card.description || '')
      ? 1
      : MAX_COPIES;

  /** Rough power proxy — the game has no power rating, so rarity stands in. */
  const RARITY_SCORE = { common: 0, uncommon: 1, rare: 2.5, epic: 4, showcase: 4, promo: 2 };

  /* How a 40-card deck ought to be shaped. Both are targets, not hard limits:
   * if the collection can't fill a bucket the builder spills into the next pass. */
  const TYPE_TARGET = { Unit: 23, Spell: 11, Gear: 6 };
  const CURVE_TARGET = { 2: 8, 3: 9, 4: 9, 5: 7, 6: 4, 7: 3 };

  /** Energy 1 counts in the 2-bucket, everything 7+ in the 7-bucket. */
  const curveBucket = (energy) => Math.min(7, Math.max(2, energy ?? 4));

  /* ---------------- collection pool ---------------- */

  /**
   * Collapses owned cards into one entry per named card, summing copies across
   * printings and keeping the cheapest printing as the one to actually sleeve.
   */
  function buildPool(cards, qtyOf, priceOf) {
    const pool = new Map();
    for (const card of cards) {
      const qty = qtyOf(card.id);
      if (qty <= 0) continue;
      if (card.supertype === 'Token') continue; // Tokens are made in play, not deckbuilt.

      const key = cardKey(card);
      let entry = pool.get(key);
      if (!entry) {
        entry = { key, name: cardName(card), qty: 0, card, printings: [], tagSet: new Set() };
        pool.set(key, entry);
      }
      entry.qty += qty;
      entry.printings.push({ card, qty });
      for (const t of card.tags || []) entry.tagSet.add(t);
      // Prefer the cheapest printing as the representative, so a suggested deck
      // doesn't tell you to sleeve your $300 showcase copy.
      const price = priceOf(card.id);
      const best = priceOf(entry.card.id);
      if (price != null && (best == null || price < best)) {
        entry.card = card;
        entry.name = cardName(card);
      }
    }

    // Riftcodex drops region tags from some reprints (`Draven, Showboat` loses
    // Noxus), so the union across printings is what the physical card carries.
    for (const entry of pool.values()) {
      entry.card = { ...entry.card, tags: [...entry.tagSet] };
    }
    return pool;
  }

  /* ---------------- legality ---------------- */

  /**
   * Core Rules 103.2.a — the identity must contain every domain printed on the card.
   * Colourless isn't a domain, so it imposes no requirement and is legal anywhere;
   * every battlefield is printed colourless, which is why 103.4 qualifies the
   * restriction with "if applicable".
   */
  const inIdentity = (card, identity) =>
    card.domains.every((d) => d === 'colorless' || identity.has(d));

  const sharesTag = (card, tags) => card.tags.some((t) => tags.includes(t));

  /* ---------------- scoring ---------------- */

  function scoreCard(card, legend) {
    let s = RARITY_SCORE[card.rarity] ?? 0;

    // Cards built around the same champion as the Legend are the whole point.
    if (sharesTag(card, legend.tags)) s += 4;
    // Text that names the Legend's champion ("another Jinx unit", "Jinx you control").
    const text = card.description || '';
    if (legend.tags.some((t) => text.includes(t))) s += 2.5;

    if (card.supertype === 'Champion') s += 1.5;
    if (card.supertype === 'Signature') s += 3;

    // Cheap cards contribute on more turns; the curve quota handles the top end.
    s += Math.max(0, 4 - (card.stats.energy ?? 4)) * 0.4;
    // Two or three runes of one colour is a real cost in a two-domain deck.
    s -= Math.max(0, (card.stats.power ?? 0) - 1) * 0.8;
    // Keyword count is a crude but honest proxy for a card that does something.
    s += Math.min(2, (card.keywords || []).length * 0.4);

    return s;
  }

  /* ---------------- main deck ---------------- */

  function fillMain(candidates, legend, preset) {
    const chosen = [...preset];
    // Keyed on the canonical name, so reprints share one 3-copy budget.
    const takenByName = new Map(chosen.map((p) => [p.entry.key, p.count]));
    let total = chosen.reduce((n, p) => n + p.count, 0);
    let signatures = chosen
      .filter((p) => p.entry.card.supertype === 'Signature')
      .reduce((n, p) => n + p.count, 0);

    const typeLeft = { ...TYPE_TARGET };
    const curveLeft = { ...CURVE_TARGET };
    for (const p of chosen) {
      typeLeft[p.entry.card.type] = (typeLeft[p.entry.card.type] ?? 0) - p.count;
      const b = curveBucket(p.entry.card.stats.energy);
      curveLeft[b] -= p.count;
    }

    const ranked = candidates
      .map((entry) => ({ entry, score: scoreCard(entry.card, legend) }))
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

    /* Three passes, each looser than the last. The first respects both the type
     * mix and the energy curve; the second drops the curve; the third takes
     * anything legal, which is what keeps a thin collection from stalling at 32. */
    const passes = [
      (c) => (typeLeft[c.type] ?? 0) > 0 && curveLeft[curveBucket(c.stats.energy)] > 0,
      (c) => (typeLeft[c.type] ?? 0) > 0,
      () => true,
    ];

    for (const allows of passes) {
      for (const { entry } of ranked) {
        if (total >= MAIN_DECK) break;
        const card = entry.card;
        if (!allows(card)) continue;

        const already = takenByName.get(entry.key) || 0;
        let room = Math.min(entry.qty, copyLimit(card)) - already;
        if (room <= 0) continue;

        // 103.2.e — three Signature cards in total, not three of each.
        if (card.supertype === 'Signature') room = Math.min(room, MAX_SIGNATURES - signatures);
        if (room <= 0) continue;

        const take = Math.min(room, MAIN_DECK - total);
        if (take <= 0) continue;

        const existing = chosen.find((p) => p.entry.key === entry.key);
        if (existing) existing.count += take;
        else chosen.push({ name: entry.name, entry, count: take, score: scoreCard(card, legend) });

        takenByName.set(entry.key, already + take);
        total += take;
        typeLeft[card.type] = (typeLeft[card.type] ?? 0) - take;
        curveLeft[curveBucket(card.stats.energy)] -= take;
        if (card.supertype === 'Signature') signatures += take;
      }
      if (total >= MAIN_DECK) break;
    }

    return { picks: chosen, total };
  }

  /* ---------------- runes ---------------- */

  /**
   * Splits 12 runes across the identity's two domains in proportion to how much
   * coloured power the main deck actually demands, then trims to what's owned.
   */
  function pickRunes(runePool, identity, mainPicks) {
    const domains = [...identity];
    const demand = Object.fromEntries(domains.map((d) => [d, 0]));

    for (const pick of mainPicks) {
      const power = pick.entry.card.stats.power || 0;
      if (!power) continue;
      for (const d of pick.entry.card.domains) {
        if (demand[d] !== undefined) demand[d] += power * pick.count;
      }
    }

    const totalDemand = domains.reduce((n, d) => n + demand[d], 0);
    let want;
    if (!totalDemand) {
      want = Object.fromEntries(domains.map((d) => [d, Math.floor(RUNE_DECK / domains.length)]));
      want[domains[0]] += RUNE_DECK - Object.values(want).reduce((a, b) => a + b, 0);
    } else {
      // Floor of 4 so the off-domain is still castable on curve.
      const floor = domains.length === 2 ? 4 : 2;
      want = {};
      let assigned = 0;
      domains.forEach((d, i) => {
        if (i === domains.length - 1) {
          want[d] = RUNE_DECK - assigned;
        } else {
          const raw = Math.round((demand[d] / totalDemand) * RUNE_DECK);
          want[d] = Math.min(RUNE_DECK - floor * (domains.length - 1), Math.max(floor, raw));
          assigned += want[d];
        }
      });
      for (const d of domains) want[d] = Math.max(floor, Math.min(RUNE_DECK - floor, want[d]));
      // Rounding can drift off 12; put the difference on the heavier domain.
      let drift = RUNE_DECK - domains.reduce((n, d) => n + want[d], 0);
      const heavy = [...domains].sort((a, b) => demand[b] - demand[a]);
      for (let i = 0; drift !== 0 && i < 100; i++) {
        const d = heavy[i % heavy.length];
        want[d] += drift > 0 ? 1 : -1;
        drift += drift > 0 ? -1 : 1;
      }
    }

    const available = {};
    for (const d of domains) {
      available[d] = [...runePool.values()]
        .filter((e) => e.card.domains.includes(d))
        .reduce((n, e) => n + e.qty, 0);
    }

    // Take what's wanted, then let a domain with spare runes cover the shortfall.
    const take = {};
    let short = 0;
    for (const d of domains) {
      take[d] = Math.min(want[d], available[d]);
      short += want[d] - take[d];
    }
    for (const d of domains) {
      if (short <= 0) break;
      const spare = available[d] - take[d];
      const add = Math.min(spare, short);
      take[d] += add;
      short -= add;
    }

    const picks = [];
    for (const d of domains) {
      let need = take[d];
      const entries = [...runePool.values()]
        .filter((e) => e.card.domains.includes(d))
        .sort((a, b) => b.qty - a.qty);
      for (const e of entries) {
        if (need <= 0) break;
        const n = Math.min(e.qty, need);
        picks.push({ name: e.name, entry: e, count: n, domain: d });
        need -= n;
      }
    }

    return { picks, want, take, short, total: picks.reduce((n, p) => n + p.count, 0) };
  }

  /* ---------------- one legend ---------------- */

  function buildForLegend(legendEntry, pool, priceOf) {
    const legend = legendEntry.card;
    const identity = new Set(legend.domains);
    const issues = [];

    const legal = [];
    const runePool = new Map();
    const battlefieldPool = [];

    for (const entry of pool.values()) {
      const c = entry.card;
      if (c.type === 'Legend') continue;
      if (c.type === 'Rune') {
        if (inIdentity(c, identity)) runePool.set(entry.name, entry);
        continue;
      }
      // Battlefields are all colourless, so identity never excludes them.
      if (c.type === 'Battlefield') {
        if (inIdentity(c, identity)) battlefieldPool.push(entry);
        continue;
      }
      if (!MAIN_TYPES.has(c.type)) continue;
      if (!inIdentity(c, identity)) continue;
      // 103.2.e — a Signature card is only legal under its own champion's Legend.
      if (c.supertype === 'Signature' && !sharesTag(c, legend.tags)) continue;
      legal.push(entry);
    }

    // 103.2.c — Chosen Champion: a champion *unit* carrying the Legend's tag.
    const championOptions = legal
      .filter(
        (e) =>
          e.card.type === 'Unit' &&
          e.card.supertype === 'Champion' &&
          sharesTag(e.card, legend.tags)
      )
      .map((entry) => ({ entry, score: scoreCard(entry.card, legend) }))
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

    const champion = championOptions[0] || null;
    if (!champion) {
      return {
        ok: false,
        legend,
        legendEntry,
        blocked: `No champion unit tagged ${legend.tags.join('/')} in your collection — ` +
          `every deck needs a Chosen Champion.`,
        issues,
        score: -Infinity,
      };
    }

    const preset = [
      {
        name: champion.entry.name,
        entry: champion.entry,
        count: Math.min(champion.entry.qty, copyLimit(champion.entry.card)),
        score: champion.score,
        chosen: true,
      },
    ];

    const { picks: mainPicks, total: mainTotal } = fillMain(legal, legend, preset);
    const runes = pickRunes(runePool, identity, mainPicks);

    const seenBattlefield = new Set();
    const battlefields = battlefieldPool
      .map((entry) => ({ entry, score: scoreCard(entry.card, legend) }))
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      // 103.4 — no two battlefields may share a name, so one copy of each.
      .filter((b) => !seenBattlefield.has(b.entry.name) && seenBattlefield.add(b.entry.name))
      .slice(0, BATTLEFIELDS)
      .map((b) => ({ name: b.entry.name, entry: b.entry, count: 1 }));

    if (mainTotal < MAIN_DECK) {
      issues.push(`Main deck is ${mainTotal}/${MAIN_DECK} — ${MAIN_DECK - mainTotal} more ` +
        `${identity.size ? [...identity].join('/') : ''} cards needed.`);
    }
    if (runes.total < RUNE_DECK) {
      issues.push(`Rune deck is ${runes.total}/${RUNE_DECK} — ${RUNE_DECK - runes.total} more ` +
        `${[...identity].join('/')} runes needed.`);
    }
    if (battlefields.length < BATTLEFIELDS) {
      issues.push(`Only ${battlefields.length}/${BATTLEFIELDS} battlefields — ` +
        `${BATTLEFIELDS - battlefields.length} more with different names needed.`);
    }

    const curve = {};
    let units = 0;
    let value = 0;
    for (const p of mainPicks) {
      const b = curveBucket(p.entry.card.stats.energy);
      curve[b] = (curve[b] || 0) + p.count;
      if (p.entry.card.type === 'Unit') units += p.count;
    }
    for (const p of [...mainPicks, ...runes.picks, ...battlefields]) {
      const price = priceOf(p.entry.card.id);
      if (price != null) value += price * p.count;
    }
    const legendPrice = priceOf(legend.id);
    if (legendPrice != null) value += legendPrice;

    const complete =
      mainTotal >= MAIN_DECK && runes.total >= RUNE_DECK && battlefields.length >= BATTLEFIELDS;

    // Completeness dominates: a legal 40 always beats a stronger-but-short pile.
    const quality = mainPicks.reduce((n, p) => n + p.score * p.count, 0) / Math.max(1, mainTotal);
    const score =
      (complete ? 1000 : 0) + mainTotal * 4 + runes.total * 2 + battlefields.length * 3 + quality;

    return {
      ok: true,
      complete,
      legend,
      // The pool keeps the cheapest printing, whose name may carry a treatment
      // suffix; the plain name is what belongs on a decklist.
      legendName: legendEntry.name,
      legendEntry,
      identity: [...identity],
      champion: preset[0],
      main: mainPicks.sort(
        (a, b) =>
          (a.entry.card.stats.energy ?? 99) - (b.entry.card.stats.energy ?? 99) ||
          a.name.localeCompare(b.name)
      ),
      runes: runes.picks,
      battlefields,
      counts: { main: mainTotal, runes: runes.total, battlefields: battlefields.length, units },
      runeSplit: runes.take,
      curve,
      value,
      issues,
      score,
    };
  }

  /* ---------------- entry point ---------------- */

  /**
   * @param {object}   opts
   * @param {Array}    opts.cards    full card list
   * @param {Function} opts.qtyOf    (cardId) => copies owned
   * @param {Function} [opts.priceOf] (cardId) => market price or null
   * @param {string}   [opts.legendId] force a specific Legend, else the best is chosen
   */
  function buildDeck({ cards, qtyOf, priceOf = () => null, legendId = null }) {
    const pool = buildPool(cards, qtyOf, priceOf);

    const legends = [...pool.values()].filter((e) => e.card.type === 'Legend');
    if (!legends.length) {
      return {
        ok: false,
        reason: 'You don’t own a Champion Legend yet. Every deck is built around one.',
      };
    }

    const wanted = legendId
      ? legends.filter((e) => e.printings.some((p) => p.card.id === legendId) || e.name === legendId)
      : legends;
    if (!wanted.length) {
      return { ok: false, reason: 'That Legend isn’t in your collection.' };
    }

    const attempts = wanted
      .map((entry) => buildForLegend(entry, pool, priceOf))
      .sort((a, b) => b.score - a.score);

    const best = attempts[0];
    if (!best.ok) {
      return {
        ok: false,
        reason: best.blocked,
        attempts,
        legends: legends.map((e) => ({ name: e.name, card: e.card })),
      };
    }

    return {
      ...best,
      alternatives: attempts.slice(1, 6),
      legends: legends.map((e) => ({ name: e.name, card: e.card })),
    };
  }

  /**
   * Rewrites a card name into the form the deck sites use.
   *
   * Riftcodex writes the older sets as `Vi - Destructive` and prefixes extra
   * tags on some legends (`Yordle, Kennen - Heart of the Tempest`). Rift Atlas's
   * catalogue has no name containing " - " and none with two commas: the same
   * cards are `Vi, Destructive` and `Kennen, Heart of the Tempest`. So the last
   * " - " becomes ", " and anything before a comma on its left is dropped.
   *
   * Measured against their full 1240-card catalogue: 939 of our 941 names
   * resolve, up from 762 untransformed. The two that don't are Vendetta cards
   * missing from their catalogue entirely, which no rewrite can fix.
   */
  function atlasName(name) {
    const cut = name.lastIndexOf(' - ');
    if (cut === -1) return name;
    const left = name.slice(0, cut);
    const comma = left.lastIndexOf(', ');
    return `${comma === -1 ? left : left.slice(comma + 2)}, ${name.slice(cut + 3)}`;
  }

  /**
   * Plain-text decklist in the format Rift Atlas and the other importers parse.
   *
   * Their grammar, read off Rift Atlas's own parser and exporter:
   *   - a line only counts as a section header if it ends with `:`. The text is
   *     lowercased with all whitespace stripped and matched against a fixed
   *     alias table, so `MainDeck:` and `Main Deck:` both work — but
   *     `Main Deck (39)` does not, because the count stops it being a header at
   *     all and it gets read as a malformed card line.
   *   - entries are `<count> <name>`, optionally `<count> <name> [CODE]`
   *   - sections are separated by a blank line, in the order below
   *
   * Codes are left out because their exporter defaults to names only, and an
   * unresolvable code is a hard error where a name is merely looked up.
   *
   * The Chosen Champion is its own one-card section — the copy that starts in
   * the champion zone — and any further copies belong in MainDeck, so Champion
   * plus MainDeck comes to exactly 40.
   */
  function toText(deck) {
    if (!deck?.ok) return '';

    const section = (header, picks) =>
      `${header}\n${picks.map((p) => `${p.count} ${atlasName(p.name)}`).join('\n')}`.trimEnd();

    const champion = deck.main.find((p) => p.chosen);
    const mainDeck = deck.main
      .map((p) => (p.chosen ? { ...p, count: p.count - 1 } : p))
      .filter((p) => p.count > 0);

    return [
      section('Legend:', [{ name: deck.legendName, count: 1 }]),
      section('Champion:', champion ? [{ name: champion.name, count: 1 }] : []),
      section('MainDeck:', mainDeck),
      section('Battlefields:', deck.battlefields),
      section('Runes:', deck.runes),
      section('Sideboard:', []),
    ].join('\n\n');
  }

  global.RiftboundDeck = { buildDeck, toText, cardName, MAIN_DECK, RUNE_DECK, BATTLEFIELDS, MAX_COPIES };
})(typeof window !== 'undefined' ? window : globalThis);
