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
- **Sets** — per-set completion bars.
- **Export / Import** — JSON backup. `localStorage` is per-browser and gets
  wiped if you clear site data, so export occasionally.

## Refreshing card data

Card data is baked into `data/cards.js` at sync time rather than fetched at
runtime. A local file works offline and costs nothing at page load, and browsers
can't call these APIs directly anyway — RiftScribe sends no
`Access-Control-Allow-Origin` header.

When a new set drops:

```sh
node sync-cards.mjs     # ~30 s
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
app.js           filtering, stats, persistence, export/import
sync-cards.mjs   pulls cards from the RiftScribe API
data/cards.js    generated — loaded by index.html (window.RIFTBOUND_DATA)
data/cards.json  generated — same payload, for any other tooling (git-ignored)
```

`data/cards.json` isn't committed; run `node sync-cards.mjs` to produce it.

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
needs a key), [Piltover Archive](https://piltoverarchive.com),
[RiftStorm](https://riftstorm.gg). Only `sync-cards.mjs` would need to change —
the app just reads `window.RIFTBOUND_DATA`.
