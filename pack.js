/*
 * Booster pack simulator — draws a pack out of a set's card pool.
 *
 * Slot structure and rates follow the published Origins configuration: 14 cards
 * as 7 commons, 3 uncommons, 2 "rare or better" foils, 1 foil of any rarity and
 * 1 token-or-rune slot, with Epics landing in roughly one pack in four and
 * alt-art/showcase treatments around one in twelve.
 *   https://harlequinsgames.com/blogs/riftbound/riftbound-tcg-pull-rates-and-set-overview-origins-and-spiritforged
 *   https://playriftbound.com/en-us/news/announcements/collectability-in-riftbound-origins/
 *
 * Riot publishes the per-pack Epic rate but not the per-slot table behind it, so
 * the slot odds below are chosen to reproduce the rates that *are* published —
 * see PACK_ODDS_TARGET. odds() reports what the model actually does rather than
 * repeating the target, so the figures shown to a reader always describe the
 * simulation they just watched.
 *
 * Nothing here touches the collection: a pack is generated, shown and dropped.
 */

(function (global) {
  'use strict';

  /** The published per-pack rates this model is tuned against. */
  const PACK_ODDS_TARGET = { epic: 0.25, showcase: 0.083 };

  /**
   * Rarity order, weakest first — an upgrade that a set can't supply (Vendetta
   * and Unleashed have no showcase printings) falls back down this ladder rather
   * than silently dropping a card from the pack.
   */
  const LADDER = ['common', 'uncommon', 'rare', 'epic', 'showcase'];

  /**
   * Slots, in the order they sit in the pack. Every `odds` table sums to 1.
   *
   * Two rare slots at 11% epic and one foil slot at 4% put an Epic in
   * 1 - 0.89² × 0.96 = 24.0% of packs and a showcase in
   * 1 - 0.96² × 0.99 = 8.8%, which is the published 1-in-4 and 1-in-12.
   */
  const SLOTS = [
    { n: 7, label: 'Common', odds: { common: 1 } },
    { n: 3, label: 'Uncommon', odds: { uncommon: 1 } },
    {
      n: 2,
      label: 'Rare or better',
      foil: true,
      odds: { rare: 0.85, epic: 0.11, showcase: 0.04 },
    },
    {
      n: 1,
      label: 'Foil',
      foil: true,
      odds: { common: 0.55, uncommon: 0.3, rare: 0.1, epic: 0.04, showcase: 0.01 },
    },
    // Real packs finish on a token or a rune, both of which the catalogue does
    // carry. A set that printed neither (Unleashed) opens one card lighter.
    { n: 1, label: 'Rune or token', bonus: true },
  ];

  /**
   * Printing treatments that mark a card as a chase version rather than the
   * ordinary printing. The base slots draw from plain printings only; the
   * showcase pool is where the treated ones live. Same list as the deck builder
   * uses — kept local so either file can be dropped in on its own.
   */
  const TREATMENT =
    /\s*\((?:alternate art|signature|overnumbered|starter|metal|gg ez|launch exclusive|ultimate)\)\s*$/i;

  const isTreated = (c) => TREATMENT.test(c.name);

  /**
   * Splits a set into the pools the slots draw from. Runes and tokens are pulled
   * out of the rarity pools because they have a slot of their own — both are
   * printed at common, so a pack could otherwise open with eight runes, or with
   * the Recruit token in a slot that should hold a real card.
   */
  function poolsFor(cards, setId) {
    const inSet = cards.filter((c) => c.set_id === setId);
    const pools = { common: [], uncommon: [], rare: [], epic: [], showcase: [], bonus: [] };

    for (const c of inSet) {
      if (c.rarity === 'showcase') {
        pools.showcase.push(c);
        continue;
      }
      if (isTreated(c)) continue;
      if (c.type === 'Rune' || c.supertype === 'Token') {
        pools.bonus.push(c);
        continue;
      }
      if (pools[c.rarity]) pools[c.rarity].push(c);
    }
    return pools;
  }

  /** Highest rarity at or below `rarity` that this set can actually supply. */
  function available(pools, rarity) {
    for (let i = LADDER.indexOf(rarity); i >= 0; i--) {
      if (pools[LADDER[i]].length) return LADDER[i];
    }
    return null;
  }

  /**
   * Per-slot rarity odds after the set's own gaps are folded in, so a set with no
   * showcase printings shows the 4% living on its Epics rather than a rate it
   * can never pay out.
   */
  function effectiveOdds(slot, pools) {
    const out = {};
    for (const [rarity, p] of Object.entries(slot.odds)) {
      const r = available(pools, rarity);
      if (r) out[r] = (out[r] || 0) + p;
    }
    return out;
  }

  const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

  function pickRarity(odds, rng) {
    let roll = rng();
    let last;
    for (const [rarity, p] of Object.entries(odds)) {
      last = rarity;
      if ((roll -= p) < 0) return rarity;
    }
    return last; // float dust on the last bucket
  }

  /**
   * Sets you can open. A pack needs seven distinct commons and three uncommons,
   * which rules out the promo sets and the 24-card Proving Grounds deck.
   */
  function openableSets(cards, sets) {
    return sets.filter((s) => {
      if (s.promo) return false;
      const p = poolsFor(cards, s.id);
      return p.common.length >= 7 && p.uncommon.length >= 3 && p.rare.length >= 2;
    });
  }

  /**
   * Chance of at least one card of each rarity in a pack, from the slot table
   * this set actually rolls — the one thing the simulator reports that outlives
   * the pack itself.
   */
  function odds(cards, setId) {
    const pools = poolsFor(cards, setId);
    const miss = {}; // P(no card of this rarity), accumulated across slots

    for (const slot of SLOTS) {
      if (slot.bonus) continue;
      const eff = effectiveOdds(slot, pools);
      for (const r of LADDER) {
        miss[r] = (miss[r] ?? 1) * Math.pow(1 - (eff[r] || 0), slot.n);
      }
    }

    const out = {};
    for (const r of LADDER) {
      if (!pools[r].length) continue;
      out[r] = 1 - miss[r];
    }
    return out;
  }

  /**
   * One pack. Cards are drawn without replacement, so a pack never doubles up —
   * the pools are hundreds deep, so this only ever bites on tiny sets.
   *
   * @returns {{setId: string, cards: Array, counts: Object}}
   */
  function openPack({ cards, setId, rng = Math.random }) {
    const pools = poolsFor(cards, setId);
    const used = new Set();
    const out = [];

    const draw = (pool) => {
      const free = pool.filter((c) => !used.has(c.id));
      if (!free.length) return null;
      const c = pick(free, rng);
      used.add(c.id);
      return c;
    };

    for (const slot of SLOTS) {
      if (slot.bonus) {
        const c = pools.bonus.length ? draw(pools.bonus) : null;
        if (c) out.push({ card: c, slot: slot.label, foil: false });
        continue;
      }

      const eff = effectiveOdds(slot, pools);
      for (let i = 0; i < slot.n; i++) {
        const rarity = pickRarity(eff, rng);
        const c = draw(pools[rarity]) || draw(pools[available(pools, rarity)] || []);
        if (c) out.push({ card: c, slot: slot.label, foil: !!slot.foil || c.rarity === 'showcase' });
      }
    }

    // Best last: a pack that ends on its Epic reveals better than one that opens
    // with it, and the physical product stacks the hits at the back too.
    out.sort((a, b) => LADDER.indexOf(a.card.rarity) - LADDER.indexOf(b.card.rarity));

    const counts = {};
    for (const p of out) counts[p.card.rarity] = (counts[p.card.rarity] || 0) + 1;

    return { setId, cards: out, counts };
  }

  global.RiftboundPack = { openPack, odds, openableSets, SLOTS, LADDER, PACK_ODDS_TARGET };
})(window);
