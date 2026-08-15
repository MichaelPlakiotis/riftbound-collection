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

  /* ---------------- synergy themes ---------------- */

  /**
   * Riftbound's card pool is built around a handful of resource loops, and each
   * one comes in two halves: cards that *produce* the resource and cards that
   * *reward* having produced it. Neither half is worth much alone — a Level 3
   * body with no way to gain XP is a vanilla unit, and discard outlets with
   * nothing that cares about a full trash are pure card disadvantage — which is
   * exactly what a per-card score can't see, because in isolation both halves
   * look like ordinary cards of their rarity.
   *
   * So each theme declares both halves. A theme only earns a bonus when the
   * collection can field both, and the deck-level evaluation below rewards the
   * *pairs* the deck ends up with rather than the count of either side.
   *
   * Matching runs against the keyword list, the tags, the type, and the rules
   * text with reminder parentheses stripped out. Stripping matters: reminder
   * text restates the keyword it belongs to, so `[Hunt 2] (…gain 2 XP.)` would
   * otherwise register as an XP enabler twice, and every `[Empowered]` reminder
   * would register its card as an empowerer it isn't.
   */
  const THEMES = [
    {
      id: 'discard',
      label: 'Discard & trash',
      // "discard 1", "discard 2" — the imperative. Deliberately not a bare
      // \bdiscard\b, which would also catch "when you discard me", a card that
      // rewards the outlet rather than being one.
      enable: { text: [/\bdiscard \d/i] },
      payoff: {
        text: [
          /(?:when|whenever|if) you'?(?:ve)? ?discard/i,
          /you'?ve discarded/i,
          /\b(?:from|in) your trash\b/i,
          /cards in your trash/i,
        ],
      },
    },
    {
      id: 'xp',
      label: 'XP & levelling',
      // [Hunt N] is "gain N XP when I conquer or hold" — the reminder that says
      // so is stripped, so the keyword is what identifies it.
      enable: { keywords: ['hunt'], text: [/gain \d+ xp/i, /gain xp/i] },
      payoff: { keywords: ['level'], text: [/\[level \d/i, /spend \d+ xp/i, /\d\+ xp/i] },
    },
    {
      id: 'empower',
      label: 'Empower',
      enable: { keywords: ['empower'], text: [/\bempower\b/i] },
      payoff: { keywords: ['empowered'], text: [/\[empowered\]/i, /\bdisempower\b/i] },
    },
    {
      id: 'gear',
      label: 'Gear & equipment',
      enable: { types: ['Gear'], tags: ['Equipment'], keywords: ['equip'] },
      payoff: {
        keywords: ['weaponmaster'],
        text: [/gear you control/i, /number of gear/i, /friendly gear/i, /equipment attached/i],
      },
    },
    {
      id: 'runes',
      label: 'Rune ramp',
      enable: { keywords: ['add'], text: [/channel \d+ rune/i, /channel a rune/i] },
      payoff: {
        text: [/control \d+ or more runes/i, /for each rune you control/i, /runes you control/i],
      },
    },
    {
      id: 'tokens',
      label: 'Tokens & swarm',
      enable: { text: [/\btoken\b/i] },
      payoff: {
        keywords: ['legion'],
        text: [/other friendly units/i, /units you control/i, /for each (?:friendly |other )?unit/i],
      },
    },
    {
      id: 'spells',
      label: 'Spell slinging',
      enable: { types: ['Spell'] },
      payoff: {
        text: [/(?:when|whenever) you play a spell/i, /next spell you play/i, /spells you play/i,
          /with a spell/i, /spell from your trash/i],
      },
    },
    {
      id: 'hidden',
      label: 'Hidden cards',
      enable: { keywords: ['hidden'] },
      payoff: { text: [/from face down/i, /when you hide/i] },
    },
    {
      id: 'sacrifice',
      label: 'Sacrifice',
      // Inverted from how it reads: the Deathknell body is the payoff — it
      // *wants* to die — and the card that kills a friendly is the enabler.
      enable: { text: [/kill a friendly/i, /kill (?:a|an|one|two) [^.]{0,24}you control/i] },
      payoff: { keywords: ['deathknell'] },
    },
  ];

  /**
   * Rules text as the matchers see it: entities decoded, reminders removed.
   * Memoised, because building a deck for every Legend you own asks the same
   * question of the same card dozens of times, and this is three passes over a
   * string in the middle of it.
   */
  const RULES_CACHE = new WeakMap();
  function rulesText(card) {
    let text = RULES_CACHE.get(card);
    if (text === undefined) {
      text = (card.description || '')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\([^)]*\)/g, ' ');
      RULES_CACHE.set(card, text);
    }
    return text;
  }

  const sideHits = (side, card, text) =>
    (side.types || []).includes(card.type) ||
    (side.keywords || []).some((k) => (card.keywords || []).includes(k)) ||
    (side.tags || []).some((t) => (card.tags || []).includes(t)) ||
    (side.text || []).some((re) => re.test(text));

  /* A theme has to clear both floors before it's worth building toward: too few
   * enablers and the payoffs never come online, too few payoffs and the
   * enablers are a tax. Counted in copies, against a 40-card deck. */
  const MIN_ENABLERS = 5;
  const MIN_PAYOFFS = 3;
  /* Past this many copies a theme can't use more, so extra depth shouldn't keep
   * inflating its rank over a rival theme the collection supports just as well. */
  const THEME_CAP = 14;
  /** How many themes a single 40-card deck can meaningfully chase. */
  const MAX_THEMES = 2;
  /** The second theme is a subplot, and scored as one. */
  const THEME_WEIGHT = [1, 0.55];

  /**
   * Ranks the themes the legal pool can actually field, strongest first.
   *
   * Strength is "how many deck slots could this theme legitimately fill",
   * counted in owned copies and capped on each side, rather than a raw card
   * count — a theme with thirty payoffs and five enablers is not twice the deck
   * a theme with ten and ten is.
   */
  function detectThemes(candidates, legend) {
    const legendText = rulesText(legend);
    const ranked = [];

    // One pass over the pool for all nine themes, rather than nine over the pool.
    const enable = THEMES.map(() => 0);
    const payoff = THEMES.map(() => 0);
    for (const entry of candidates) {
      const text = rulesText(entry.card);
      const copies = Math.min(entry.qty, copyLimit(entry.card));
      THEMES.forEach((theme, i) => {
        if (sideHits(theme.enable, entry.card, text)) enable[i] += copies;
        if (sideHits(theme.payoff, entry.card, text)) payoff[i] += copies;
      });
    }

    THEMES.forEach((theme, i) => {
      const enablers = enable[i];
      const payoffs = payoff[i];
      if (enablers < MIN_ENABLERS || payoffs < MIN_PAYOFFS) return;

      let strength = Math.min(enablers, THEME_CAP) + Math.min(payoffs, THEME_CAP);
      // The Legend is the one card guaranteed to be in play every game, so a
      // theme its own text is built around is the theme the deck is built
      // around. Worth more than any amount of depth in the pool.
      if (
        sideHits(theme.enable, legend, legendText) ||
        sideHits(theme.payoff, legend, legendText)
      ) {
        strength *= 1.6;
      }
      ranked.push({ ...theme, enablers, payoffs, strength });
    });

    return ranked.sort((a, b) => b.strength - a.strength).slice(0, MAX_THEMES);
  }

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

  /* A card's own contribution to its theme. The payoff half is worth more than
   * the enabler half: enablers are usually generic and interchangeable, while
   * the payoff is the card the deck is actually trying to cast. */
  const ENABLE_BONUS = 1.6;
  const PAYOFF_BONUS = 2.4;

  function scoreCard(card, legend, themes = []) {
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

    // Pulling toward the themes the collection supports. This is only the
    // per-card half of it — whether the halves actually pair up is a property
    // of the finished deck, and priced in evaluate() below.
    const themeText = rulesText(card);
    themes.forEach((theme, i) => {
      const w = THEME_WEIGHT[i] ?? 0;
      if (sideHits(theme.enable, card, themeText)) s += ENABLE_BONUS * w;
      if (sideHits(theme.payoff, card, themeText)) s += PAYOFF_BONUS * w;
    });

    return s;
  }

  /**
   * Everything the fill and the search need to know about one candidate, worked
   * out once. The regexes above are far too expensive to re-run inside a search
   * loop that prices thousands of candidate swaps.
   */
  function candidateInfo(entry, legend, themes) {
    const card = entry.card;
    const text = rulesText(card);
    return {
      entry,
      card,
      key: entry.key,
      name: entry.name,
      type: card.type,
      bucket: curveBucket(card.stats.energy),
      signature: card.supertype === 'Signature',
      max: Math.min(entry.qty, copyLimit(card)),
      score: scoreCard(card, legend, themes),
      enables: themes.map((t) => sideHits(t.enable, card, text)),
      pays: themes.map((t) => sideHits(t.payoff, card, text)),
    };
  }

  /* ---------------- main deck ---------------- */

  /* ---- the deck as a whole ----
   *
   * Two things decide whether 40 cards work together that no per-card score can
   * see, so both are priced here rather than in scoreCard:
   *
   *   shape    how far the type mix and the energy curve have drifted from
   *            their targets. The greedy fill treats those targets as hard
   *            quotas it loosens when stuck; as a cost instead, the search can
   *            knowingly buy a slot off-curve for a card that's worth it.
   *   balance  how many enabler/payoff *pairs* the deck ended up with. Twelve
   *            payoffs and two enablers is a worse deck than seven and seven,
   *            and the card that unbalances it is individually the best one
   *            left — which is exactly why greedy keeps taking it.
   */

  const SHAPE_TYPE_COST = 1.1; // per card away from the type target
  const SHAPE_CURVE_COST = 0.7; // per card away from the curve target
  const THEME_PAIR = 1.0; // per payoff the deck can actually turn on
  const THEME_SKEW = 1.6; // per payoff it can't

  /**
   * Charged super-linearly on purpose. Bending the mix by a card or two is a
   * trade the search should be free to make for a card worth having; gutting a
   * whole slot of the deck — three spells where the plan wants eleven — is not.
   * A flat per-card cost prices those the same, and the search then spends the
   * cheap first card of the deviation over and over until the slot is empty.
   */
  const deviation = (have, want, unit) => {
    const off = Math.abs(have - want);
    return (off + off * off * 0.12) * unit;
  };

  const shapeCost = (state) => {
    let cost = 0;
    for (const t of Object.keys(TYPE_TARGET)) {
      cost += deviation(state.type[t] || 0, TYPE_TARGET[t], SHAPE_TYPE_COST);
    }
    for (const b of Object.keys(CURVE_TARGET)) {
      cost += deviation(state.curve[b] || 0, CURVE_TARGET[b], SHAPE_CURVE_COST);
    }
    return cost;
  };

  const balanceValue = (state) => {
    let value = 0;
    for (let i = 0; i < state.themeE.length; i++) {
      const w = THEME_WEIGHT[i] ?? 0;
      const e = state.themeE[i];
      const p = state.themeP[i];
      /* Deliberately asymmetric. A payoff with nothing to turn it on is a dead
       * card and the deck is strictly worse for it, so it's penalised harder
       * than a pair is rewarded — half-committing to a theme should score below
       * ignoring it. A surplus *enabler* is not the same failure: an extra
       * discard outlet still discards, and a spell is still a spell, which
       * matters because the gear and spell themes count a whole card type as
       * their enabling half. */
      value += (THEME_PAIR * Math.min(e, p) - THEME_SKEW * Math.max(0, p - e)) * w;
    }
    return value;
  };

  const evaluate = (state) => state.quality - shapeCost(state) + balanceValue(state);

  /** Running tallies, so a candidate swap can be priced without rebuilding the deck. */
  function newState(themeCount) {
    return {
      counts: new Map(), // entry key -> copies in the deck
      infos: new Map(), // entry key -> its candidate record
      type: {},
      curve: {},
      themeE: new Array(themeCount).fill(0),
      themeP: new Array(themeCount).fill(0),
      quality: 0,
      signatures: 0,
      total: 0,
    };
  }

  /** Adds `n` copies of a candidate to the tallies; `n` may be negative. */
  function place(state, info, n) {
    const now = (state.counts.get(info.key) || 0) + n;
    if (now <= 0) state.counts.delete(info.key);
    else state.counts.set(info.key, now);
    state.infos.set(info.key, info);

    state.type[info.type] = (state.type[info.type] || 0) + n;
    state.curve[info.bucket] = (state.curve[info.bucket] || 0) + n;
    state.quality += info.score * n;
    state.total += n;
    if (info.signature) state.signatures += n;
    for (let i = 0; i < state.themeE.length; i++) {
      if (info.enables[i]) state.themeE[i] += n;
      if (info.pays[i]) state.themeP[i] += n;
    }
  }

  /**
   * Greedy first pass: rank by card score and take copies until the deck is
   * full, in three passes each looser than the last. The first respects both
   * the type mix and the energy curve; the second drops the curve; the third
   * takes anything legal, which is what keeps a thin collection from stalling
   * at 32. Where it gets the mix wrong — and it does, because a full bucket in
   * the first pass shuts out cards that later passes then take out of order —
   * refine() below is what puts it right.
   */
  function fillMain(infos, preset, themeCount) {
    const state = newState(themeCount);
    for (const p of preset) place(state, p.info, p.count);

    const typeLeft = { ...TYPE_TARGET };
    const curveLeft = { ...CURVE_TARGET };
    for (const t of Object.keys(state.type)) typeLeft[t] = (typeLeft[t] ?? 0) - state.type[t];
    for (const b of Object.keys(state.curve)) curveLeft[b] -= state.curve[b];

    const ranked = [...infos].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const passes = [
      (i) => (typeLeft[i.type] ?? 0) > 0 && curveLeft[i.bucket] > 0,
      (i) => (typeLeft[i.type] ?? 0) > 0,
      () => true,
    ];

    for (const allows of passes) {
      for (const info of ranked) {
        if (state.total >= MAIN_DECK) break;
        if (!allows(info)) continue;

        let room = info.max - (state.counts.get(info.key) || 0);
        // 103.2.e — three Signature cards in total, not three of each.
        if (info.signature) room = Math.min(room, MAX_SIGNATURES - state.signatures);
        const take = Math.min(room, MAIN_DECK - state.total);
        if (take <= 0) continue;

        place(state, info, take);
        typeLeft[info.type] = (typeLeft[info.type] ?? 0) - take;
        curveLeft[info.bucket] -= take;
      }
      if (state.total >= MAIN_DECK) break;
    }

    return state;
  }

  /**
   * How many swaps the search may accept. Every legend the collection holds
   * gets its own build, so this runs once per legend on a click — and it
   * converges long before the cap in practice, because best-improvement runs
   * out of improving swaps quickly once the shape is right.
   */
  const MAX_SWAPS = 24;

  /**
   * How many candidates the search will consider bringing in. The pool for a
   * large collection runs to hundreds of cards, and pricing every one of them
   * against every card in the deck, every round, for every Legend owned, is the
   * whole cost of the build. The cards ranked two hundredth by score are not
   * the ones an improving swap is hiding in, so the search looks at the best of
   * them — which still leaves it four times more alternatives than the deck has
   * slots.
   */
  const SEARCH_POOL = 120;

  /**
   * Second pass: repeatedly trade the single copy whose replacement improves the
   * *deck* most, until nothing improves it. This is what the greedy fill can't
   * do — it commits to a card the moment it comes up in the ranking and never
   * reconsiders, so a strong 3-drop that arrived after the 3-bucket filled is
   * gone for good even though the cards that filled it scored less.
   *
   * The swap is always one-for-one, so it can only run on a deck that reached
   * 40. A short deck has already taken every legal copy in the collection and
   * there's nothing left to trade with.
   */
  function refine(state, allInfos, protectedKey) {
    if (state.total < MAIN_DECK) return 0;

    const infos = [...allInfos]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, SEARCH_POOL);

    let swaps = 0;
    while (swaps < MAX_SWAPS) {
      const before = evaluate(state);
      let best = null;
      // Snapshotted, because pricing a swap takes a card out of the deck and
      // puts it back — which for a one-of means deleting the key and re-adding
      // it, and a live Map iterator would then hand it back a second time.
      const held = [...state.counts];

      for (const add of infos) {
        if ((state.counts.get(add.key) || 0) >= add.max) continue;

        for (const [dropKey, copies] of held) {
          if (dropKey === add.key) continue;
          // The Chosen Champion is a rules requirement, not a card choice —
          // its last copy is the one card the search may never trade away.
          if (dropKey === protectedKey && copies <= 1) continue;

          const drop = state.infos.get(dropKey);
          // 103.2.e caps signatures at three across the deck; trading one
          // signature for another keeps the count where it is.
          if (add.signature && !drop.signature && state.signatures >= MAX_SIGNATURES) continue;

          place(state, drop, -1);
          place(state, add, 1);
          const gain = evaluate(state) - before;
          place(state, add, -1);
          place(state, drop, 1);

          // The epsilon is doing real work: the tallies are added to and
          // subtracted from in floating point thousands of times, so "no
          // change" arrives as a number a hair either side of zero, and
          // accepting one of those would loop the search on a no-op.
          if (gain > (best ? best.gain : 1e-6)) best = { add, drop, gain };
        }
      }

      if (!best) break;
      place(state, best.drop, -1);
      place(state, best.add, 1);
      swaps++;
    }
    return swaps;
  }

  /** Tallies back into the pick list the rest of the builder speaks. */
  const statePicks = (state, protectedKey) =>
    [...state.counts].map(([key, count]) => {
      const info = state.infos.get(key);
      return {
        name: info.name,
        entry: info.entry,
        count,
        score: info.score,
        ...(key === protectedKey ? { chosen: true } : {}),
      };
    });

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

    // Which resource loops this collection can actually field under this
    // Legend. Everything scored from here on is scored against them.
    const themes = detectThemes(legal, legend);
    const infos = legal.map((entry) => candidateInfo(entry, legend, themes));

    // 103.2.c — Chosen Champion: a champion *unit* carrying the Legend's tag.
    const championOptions = infos
      .filter(
        (i) => i.type === 'Unit' && i.card.supertype === 'Champion' && sharesTag(i.card, legend.tags)
      )
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

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

    const state = fillMain(infos, [{ info: champion, count: champion.max }], themes.length);
    const swaps = refine(state, infos, champion.key);

    const mainPicks = statePicks(state, champion.key);
    const mainTotal = state.total;
    const runes = pickRunes(runePool, identity, mainPicks);

    const seenBattlefield = new Set();
    const battlefields = battlefieldPool
      .map((entry) => ({ entry, score: scoreCard(entry.card, legend, themes) }))
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
    // Below that, decks are compared on the same deck-level figure the search
    // was optimising, per card so a short deck isn't flattered by its own size.
    const quality = evaluate(state) / Math.max(1, mainTotal);
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
      champion: mainPicks.find((p) => p.chosen),
      /* What the deck is trying to do, and how many of its cards are holding up
       * each end of it — the honest way to show whether the plan came together
       * or the collection could only supply one half of it. */
      themes: themes.map((t, i) => ({
        id: t.id,
        label: t.label,
        enablers: state.themeE[i],
        payoffs: state.themeP[i],
      })),
      swaps,
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
