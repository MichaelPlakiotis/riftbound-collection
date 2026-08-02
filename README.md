# Riftbound Collection Tracker

Tracker for an IRL Riftbound (Riot's LoL TCG) card collection.

**Live: https://michaelplakiotis.github.io/riftbound-collection/**

No server, no build step, no install — opening `index.html` locally works too.

> Your collection is stored in `localStorage`, which is per-origin. The live site
> and a local copy therefore keep **separate** collections; use Export/Import to
> move data between them. Pick one as home — the phone-friendly live site is the
> obvious choice.

## Usage

- **`+` / `−` / type a number** — copies you own. Owned cards light up; unowned
  are dimmed so gaps are obvious at a glance.
- **☆** — wishlist flag.
- **Search** — matches card name, rules text, keywords and card ID. `Ctrl+F`
  (`Cmd+F` on Mac) jumps here instead of opening the browser's find bar, which
  would only search the cards currently on screen. `Esc` clears, then unfocuses.
- **Filters** — set, domain, rarity, type, plus All / Owned / Missing / Wishlist.
  "Missing" is your want-list for a given set. Cards spanning two domains (new
  in Vendetta) match either one. Promo sets are hidden by default and excluded
  from the overall completion figure; picking a promo set explicitly still shows
  it.
- **Set progress** — a panel of per-set completion bars (owned / total, percent,
  and value once prices are synced). Each row is also a shortcut: click one to
  filter the grid to that set, click it again to go back to everything. Unlike
  the overall figure, these rows count promos.
- **Collection worth** — total market value of everything you own, in the header.
  Click it for the breakdown: what the total is made of, the cards carrying most
  of it, and value per set. Promos count here even though they sit outside set
  completion — they're still money on the shelf. The **✕** on the chip hides the
  number (per-card prices stay); the preference is remembered under
  `riftbound-prefs-v1`, separate from the collection so exports stay portable.
- **Prices** — market price under each card, the value of your stack once you own
  more than one, and the move since the last sync. A move has to clear both 3%
  and 5¢ to show, otherwise a penny of rounding on a 5¢ common reads as ±20%.
- **Build deck** — generates a legal, playable deck from cards you own. See
  below.
- **Export / Import** — JSON backup. `localStorage` is per-browser and gets
  wiped if you clear site data, so export occasionally.

## Deck generator

Picks the Legend your collection best supports, then builds around it. Every
constraint in the official [Core Rules](https://www.riftbound.one/rules/riftbound-core-rules.pdf)
§103 is enforced exactly:

| Rule | Enforced |
|------|----------|
| 103.1.b | One Champion Legend; its two domains set the Domain Identity |
| 103.2.a | Single-domain cards need their domain in the identity; multi-domain cards need *all* of theirs |
| 103.2.b | Main deck of exactly 40, Chosen Champion included |
| 103.2.c | Chosen Champion is a champion **unit** sharing the Legend's champion tag — signature units don't qualify |
| 103.2.d | Max 3 copies of a named card — 1 for cards with **Unique** |
| 103.2.e | Max 3 Signature cards *in total*, all carrying the Legend's tag |
| 103.3 | Separate 12-card rune deck, all within the identity |
| 103.4 | 3 battlefields, no two sharing a name |

On top of the rules, it only ever uses copies you actually own — counted across
printings, since an alternate art is the same named card.

Two data quirks it has to work around, both verified against the full catalogue:

- Riftcodex punctuates Vendetta reprints with a comma where earlier sets used a
  dash. `Jayce, Man of Progress` and `Jayce - Man of Progress` are one card, and
  16 pairs are affected — without merging them the builder would happily run six
  copies. All 16 agree on type, domains, energy, might and power, so nothing
  distinct gets conflated.
- Some reprints drop their region tags (`Draven, Showboat` loses Noxus), so tags
  are unioned across printings.

**What isn't exact:** which of your legal cards are *best* together. That's
approximated from rarity, champion-tag synergy, text that names your champion,
energy curve, colour requirements and keyword density, aiming for ~23 units and
a curve peaking at 3–4 energy. Runes are split in proportion to the coloured
power your chosen cards actually demand, with a floor of 4 so the off-domain
stays castable. Treat the list as a strong first draft, not a tuned decklist.

If your collection can't reach 40, you get the best partial deck plus exactly
what's missing — which doubles as a shopping list.

### Copy list

**Copy list** produces the format [Rift Atlas](https://riftatlas.com) and the
other importers parse:

```
Legend:
1 Kennen, Heart of the Tempest

Champion:
1 Kennen, Storm of Shuriken

MainDeck:
3 Teemo, Scout
2 Kennen, Storm of Shuriken
...
```

Three things their parser is strict about, each of which broke the first version:

- A line is only a section header if it **ends with a colon**. `Main Deck (39)`
  isn't a header — the count makes it fall through and be read as a broken card
  line, which cascades into "every section is missing".
- The Chosen Champion is its **own one-card section**. Further copies belong in
  `MainDeck`, so that Champion + MainDeck is exactly 40, not 41.
- Names must match their catalogue. Riftcodex writes older sets as
  `Vi - Destructive` and prefixes tags on some legends
  (`Yordle, Kennen - Heart of the Tempest`); their catalogue contains no name
  with a dash and none with two commas. The export rewrites the last `" - "` to
  `", "` and drops anything before a comma to its left, which takes name
  resolution from 762/941 to **939/941** against their real 1240-card
  catalogue. The two that still fail are Vendetta cards missing from their
  catalogue entirely.

Verified by extracting Rift Atlas's own `parseDecklist` from their site bundle
and running generated decks through it: 10/10 accepted, zero errors, zero
warnings, and every card name resolving.

## Refreshing card data

Card data is baked into `data/cards.js` at sync time rather than fetched at
runtime. A local file works offline and costs nothing at page load, and browsers
can't call these APIs directly anyway — RiftScribe sends no
`Access-Control-Allow-Origin` header.

When a new set drops:

```sh
node sync-cards.mjs     # ~30 s
node sync-prices.mjs    # ~15 s — run this one whenever you want fresh prices
```

Set names and release dates come from the API, so a new set needs no code
change.

Your collection lives in `localStorage`, not in `cards.js`, so re-syncing never
touches it. Quantities key off card ID, and IDs are stable across syncs — and
identical between Riftcodex and RiftScribe, so even switching data source back
would preserve your counts.

### Why the sync deduplicates

Riftcodex returns 1451 rows for 1320 actual cards, and the two causes need
opposite handling:

- A freshly released set gets **ingested twice** — same card, same art, one row
  linked to TCGplayer and one stub, occasionally under a slightly different name
  (`Shen, Scourge of Shadows (Alternate Art)` vs plain). 131 of these collapse.
- 16 promos are **genuinely two products under one ID**: `Yasuo - Unforgiven` and
  `Yasuo - Unforgiven (Metal)` are both `opp-259-298`. Different cards to own, so
  both are kept and the second gets a `~2` suffix.

Artwork can't separate these — every duplicate group shares one image URL — but
TCGplayer IDs can: two distinct IDs means two real products, a stub has none.
The base printing always sorts first and keeps the clean ID.

## Layout

```
index.html       markup
styles.css       styles
app.js           filtering, stats, prices, persistence, export/import, deck UI
deck.js          deck generator — rules engine, no DOM dependency
sync-cards.mjs   pulls cards from the Riftcodex API
sync-prices.mjs  pulls market prices from TCGplayer
data/cards.js    generated — loaded by index.html (window.RIFTBOUND_DATA)
data/prices.js   generated — loaded by index.html (window.RIFTBOUND_PRICES)
data/*.json      generated — same payloads, for other tooling (git-ignored)
```

The `.json` twins aren't committed; the sync scripts produce them. Prices are
optional — with no `data/prices.js` the app simply omits every price.

`deck.js` deliberately touches no DOM, so the rules engine can be exercised
straight from Node.

## Data source

[Riftcodex](https://riftcodex.com) community API (no auth, no key). Unofficial
fan project, not affiliated with Riot Games. Card art is served from Riot's own
CDN, which is Sanity-backed — appending `w=320&fm=webp` turns a 721 KB PNG into
a 19 KB thumbnail, which is what the grid loads.

Currently 1320 cards / 1171 collectable + 149 promos, across:

| Set | Name | Cards |
|-----|------|-------|
| VEN | Vendetta | 227 |
| UNL | Unleashed | 280 |
| SFD | Spiritforged | 288 |
| OGN | Origins | 352 |
| OGS | Origins: Proving Grounds | 24 |
| OPP / PR / JDG | promo sets | 149 |

Riftcodex was chosen over [RiftScribe](https://riftscribe.gg) because RiftScribe
is missing Vendetta and the promo sets (950 cards vs 1320), has no multi-domain
data, and guesses at set names. Both use the same card IDs.

Other options: [Scrydex](https://scrydex.com/docs/riftbound/cards) (has pricing,
$29/mo minimum), [Piltover Archive](https://piltoverarchive.com),
[RiftStorm](https://riftstorm.gg). Only `sync-cards.mjs` would need to change —
the app just reads `window.RIFTBOUND_DATA`.

## Price source

TCGplayer market prices, in USD, matched on the `tcgplayer_id` each card already
carries — so no fuzzy name matching and no mis-priced alternate arts. One paged
request per 50 products covers the whole game in about 30 calls.

96 Vendetta cards have no Riftcodex TCGplayer ID yet, so those fall back to a
set + name match, accepted only when it resolves to exactly one product. Checked
against the 1189 ID-matched cards, the name match agrees on all 1189 and
contradicts none. Coverage is 1304 of 1320 cards; the remaining 16 are Metal
promos with no sales history and 5 Vendetta cards not yet listed.

**Cardmarket was the first choice and isn't usable.** Their official API
[stopped accepting applications](https://help.cardmarket.com/en/cardmarket-api),
the site itself is behind Cloudflare, and every remaining route is a paid
third-party mirror. If you ever want EUR figures, the fix is confined to
`sync-prices.mjs` — the app only reads `window.RIFTBOUND_PRICES`.
