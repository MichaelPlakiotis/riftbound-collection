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
  are dimmed so gaps are obvious at a glance. The second, quieter stepper below
  counts foils, which are priced separately — see [Foils](#foils).
- **☆** — wishlist flag.
- **Search** — matches card name, rules text, keywords and card ID. `Ctrl+F`
  (`Cmd+F` on Mac) jumps here instead of opening the browser's find bar, which
  would only search the cards currently on screen. `Esc` clears, then unfocuses.
- **Filters** — set, domain, rarity, type, plus All / Owned / Missing / Wishlist.
  "Missing" is your want-list for a given set. Cards spanning two domains (new
  in Vendetta) match either one. Promo sets are hidden by default and excluded
  from the overall completion figure; picking a promo set explicitly still shows
  it.
- **Sort** — the last dropdown in the filter bar reorders the grid: price high to
  low or low to high, energy cost either way, by card type (Legend, Unit, Spell,
  Gear, Rune, Battlefield — the order the deck panel groups them in, with each
  type's own curve inside it), or name. Cards with nothing to sort on — a card
  with no sales data, a Rune with no energy cost — always sink to the bottom
  rather than flipping to the top when you reverse the direction. Default is the
  order the sets were printed in, which also breaks ties everywhere else. The
  choice is remembered with the other preferences; Reset puts it back. Price
  orders only appear once a price sync has been run.
- **Collection worth** — total market value of everything you own, in the header,
  and the one control for the detail panel. Click it to show or hide: the
  breakdown (what the total is made of and the cards carrying most of it) and
  per-set progress bars — owned / total, percent, and value per set. Promos count
  here even though they sit outside set completion; they're still money on the
  shelf. Open or closed is remembered under `riftbound-prefs-v1`, kept separate
  from the collection so exports stay portable. Without a price sync the chip
  reads "Set progress" and opens the same panel minus the money.
- **Currency** — the dropdown beside the worth switches every figure in the app
  between USD, EUR and GBP, and is remembered with the other preferences. Read
  the caveat under [Currency](#currency): these are US market prices converted at
  a stored rate, not Cardmarket prices.
- **Set rows are also filters** — click one to narrow the grid to that set, click
  it again for everything. It drives the same filter as the set dropdown.
- **On narrow screens** (≤760px) everything except the brand and the search box
  folds behind a burger button, which opens as a dropdown over the grid — the
  full header was costing a phone most of its first screen of cards. The button
  carries a count of the filters currently applied, so a narrowed grid is never
  a mystery while the controls that caused it are out of sight.
- **Prices** — market price under each card, the value of your stack once you own
  more than one, and the move since the last sync. A move has to clear both 3%
  and 5¢ to show, otherwise a penny of rounding on a 5¢ common reads as ±20%.
- **Open a pack** — booster simulator. Pick a set, tear the wrapper, click through
  the cards one at a time. See below.
- **Build deck** — generates a legal, playable deck from cards you own. See
  below.
- **Export / Import** — `localStorage` is per-browser and gets wiped if you clear
  site data, so export occasionally. Export opens a format menu (hover or click,
  and it unfolds inline inside the burger panel on a phone):

  | Format | What it's for |
  | --- | --- |
  | **JSON** | Full backup — the only format Import reads back |
  | **CSV** | Spreadsheets and most collection trackers. One row per *printing*, so a card you hold in both finishes gets a normal row and a foil row: card id, set code, printed number, quantity, foil, wishlist flag, rarity, type, domains, unit/total price in the currency currently selected, and the name. Each row is priced as the printing it is. UTF-8 BOM so Excel doesn't mangle card names |
  | **riftbound.gg** | Four columns shaped for [riftbound.gg](https://riftbound.gg/collection/)'s collection importer, one row per printing. See below |
  | **Text** | Readable list grouped by set — `3x Ashe, Frost Archer (OGN 012)`, with `[1 foil]` appended when some are — and a wishlist section at the end |
  | **TCGplayer mass entry** | `3 Ashe, Frost Archer` lines for bulk-add boxes. Owned copies only, foils included in the count; a wishlist card has no quantity to enter |

  Everything but JSON is one-way and identifies cards the way they're printed
  (set code + zero-padded collector number) rather than by this app's internal
  ids, which is what makes them readable somewhere else.

### Importing into riftbound.gg

Their importer takes a CSV or plain text file up to 2 MB, detects the columns
itself — there is no manual mapping step — and then lists whatever it couldn't
recognise for you to resolve by hand. Two things about it drive the export:

- **It only knows four header names**: `card id`, `quantity`, `foil`, `name`
  (plus synonyms — `qty`, `count`, `owned`, `cardname`…). Everything else in the
  row is ignored, and matching is an exact, case-insensitive lookup on their card
  id or full name. No fuzzy matching.
- **It splits rows on commas without honouring quotes.** A properly quoted
  `"Ashe, Frost Archer"` still shifts every column after it, and if the quantity
  column lands on text, the row parses as 0 and is dropped *silently* — not even
  reported in the unresolved list. 75 of our card names contain a comma.

So both CSV exports put the name in the **last** column, where a comma in it can
shift nothing, and lead with a `Card ID` holding their identifier — set code, a
dash and the padded number, `OGN-066`. Names are written without our treatment
suffix (`(Alternate Art)`, `(Metal)`), since their catalogue lists one entry per
collector number and a suffixed name matches nothing.

Measured by running their own parser (lifted from their bundle) over an export of
all 1320 cards: **1312 import**, and the 8 that don't are Organized Play and
general promos their catalogue files under different codes entirely. They show up
in their "Needs attention" list, where you can point each at the right card.
Before this shape, the same file imported 1013 cards, dropped 75 rows without
saying so, and put 232 in the unresolved pile.

## Pack simulator

Pick a set, tear the wrapper open, and click through the cards one at a time —
`Space`, `Enter` or `→` work too, and **Reveal all** skips to the end. Rares,
Epics and Showcases arrive with a glow, a shockwave and a rising chime; the
chime is synthesised from oscillators at the moment it plays, because the site
ships no binary assets and makes no network calls. The 🔊 button mutes it and is
remembered.

**Nothing you open is saved.** No pull touches your collection or
`localStorage`, and the summary's session column is counted in memory and gone
on reload. The odds are the only thing that outlives the pack — and they're
computed from the slot table rather than recorded.

### Pack contents

The 14-card configuration Riot published for Origins:

| Slot | Count | Contents |
|------|-------|----------|
| Common | 7 | |
| Uncommon | 3 | |
| Rare or better | 2 | foil; 85% rare, 11% epic, 4% showcase |
| Foil | 1 | any rarity; usually common or uncommon, can upgrade |
| Rune or token | 1 | |

Riot publishes the per-*pack* rates but not the per-*slot* table behind them, so
the slot odds above are chosen to reproduce the rates that are published: two
rare slots at 11% and one foil slot at 4% put an Epic in
`1 − 0.89² × 0.96 = 24%` of packs and a Showcase in `1 − 0.96² × 0.99 = 8.8%`,
against the published [1 in 4 and 1 in 12](https://harlequinsgames.com/blogs/riftbound/riftbound-tcg-pull-rates-and-set-overview-origins-and-spiritforged).
Verified against 20,000 simulated packs per set. The summary reports what the
model actually does, not the target, so the figures always describe the pack you
just watched.

Sets adapt to what they printed:

- **Vendetta and Unleashed** have no showcase cards in the catalogue, so that 4%
  falls down the ladder onto Epic — a per-pack Epic rate of 31% instead of 24%.
- **Unleashed** printed neither runes nor tokens, so its packs are 13 cards.
- Only sets that can fill a pack from distinct cards are offered, which rules out
  the promo sets and the 24-card Proving Grounds deck.

Base slots draw plain printings only — `(Alternate Art)`, `(Signature)`,
`(Overnumbered)` and friends live in the showcase pool, which is what a showcase
hit *is*. Runes and the five `Token` cards are held back for the last slot;
without that a pack could open with eight runes, or put the Recruit token in a
slot that should hold a real card.

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

Prices also refresh on their own: `.github/workflows/sync-prices.yml` runs
`sync-prices.mjs` every day at 09:00 UTC and commits `data/prices.js` when the
numbers actually moved. Both hosts deploy from `main`, so the commit *is* the
publish step. It's a `workflow_dispatch` too, so the Actions tab has a button
for an unscheduled run. A daily cadence also gives `meta.previousSync` and the
per-card `p` field real meaning — the deltas in the UI become day-over-day
movement instead of "since whenever I last remembered to run this".

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
app.js           filtering, sorting, stats, prices, persistence, export/import, deck + pack UI
deck.js          deck generator — rules engine, no DOM dependency
pack.js          booster pack model — slot table and draws, no DOM dependency
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
third-party mirror. If you ever want true EU market figures, the fix is confined
to `sync-prices.mjs` — the app only reads `window.RIFTBOUND_PRICES`.

### Currency

`sync-prices.mjs` also pulls the ECB reference rate from
[Frankfurter](https://frankfurter.dev) and stores `meta.rates` alongside the
prices, so the page can show €/£ without calling out to anything at runtime —
it stays static, works offline, and everyone reading the same sync sees the same
figure. If the rate call fails the previous sync's rate is carried forward, and
if there has never been one the app simply offers dollars only.

Note what the conversion is and isn't: it's a **US market price expressed in
euros**, not a European market price. Cardmarket and TCGplayer genuinely differ
per card, so a converted figure is the right number for "what is my collection
worth" and the wrong one for "what will this cost me on Cardmarket". The picker's
tooltip and the breakdown panel both name the rate and its date.

## Accounts and cloud sync

Optional, and off until configured. With no Supabase project wired up the site
is exactly what it was: `localStorage`, no network, no account button — `cloud.js`
removes the button and returns before fetching anything. Signing in adds a copy
of the collection in Postgres on top of the local one; it never replaces the
local-first behaviour.

### Setting it up

1. Create a project at [supabase.com](https://supabase.com) (the free tier is
   plenty — this uses one small table).
2. **SQL Editor → New query**, paste `supabase-schema.sql`, Run. That creates the
   `collections` table and its Row Level Security policies.
3. **Authentication → Sign In / Providers → Email**: leave Email enabled and turn
   **Confirm email** *off*. Supabase's built-in mailer is rate-limited to a
   handful of messages an hour, which turns a few friends signing up into a
   support queue. With confirmation off, signup returns a session immediately.
4. **Authentication → URL Configuration**: add every origin the site is served
   from to **Redirect URLs** — the GitHub Pages URL *and* the Vercel one, plus
   `http://localhost:*` if you open it locally.
5. Copy the Project URL and the browser-safe key from **Settings → API** into
   `supabase-config.js`, and commit. Depending on how new the project is, that
   key is shown either as **anon `public`** (a JWT starting `eyJ`) or as
   **Publishable key** (starting `sb_publishable_`) under **Settings → API
   Keys**; the older `anon` key lives under that page's **Legacy API Keys** tab.
   The two are interchangeable here — same privileges, same RLS behaviour.

### On committing the anon key

It's meant to be public. It identifies the project, not a person, and grants
nothing by itself — every request still carries the signed-in user's token, and
the policies in `supabase-schema.sql` make Postgres filter by `auth.uid()` before
returning a row. The keys to never commit are `service_role` and `sb_secret_…`,
which bypass RLS entirely.

### How syncing resolves

The first time a device signs in to an account it **merges**: local and cloud are
two histories that both deserve to survive, so each card takes the larger
quantity and either side's wishlist flag. That's what makes "I've been tracking
on my laptop, now I'm signing in on my phone" do the obvious thing.

After that the cloud is authoritative. A device that sees a newer `updated_at`
than the one it last applied replaces its local copy wholesale. Merging on
*every* sync would look safer and be worse — it can never represent a removal, so
every card you ever sold would come back. The cost of the wholesale rule is that
two devices editing simultaneously resolve last-write-wins, which is the right
trade for a collection tracker.

The account button carries a dot: green synced, gold saving, amber offline. An
offline write isn't lost — it's in `localStorage` like always, and the next
successful push carries it up.

### What it costs at page load

Nothing, unless you use it. `vendor/supabase.js` (the client, vendored so the
site keeps its no-build-step, no-runtime-CDN shape) is injected on demand — only
when a stored session needs restoring or someone opens the sign-in dialog. A
visitor who never signs in fetches exactly what they always did.

## Foils

Foil copies are counted separately from ordinary ones, because they price
separately — often several times the normal card. A collection entry is
`{ q, f, w }`: `q` ordinary copies, `f` foils, `w` the wishlist flag. Entries
saved before foils existed have no `f`, which reads as zero, so nothing needed
migrating.

Each tile gets a second, quieter stepper under the main one. The count badge
shows every copy you own and a small iridescent badge underneath says how many
of those are foil, rather than putting two competing numbers side by side. The
price row shows the foil market price beside the normal one whenever TCGplayer
has both, so the gap is visible before you own either.

Everything downstream follows the split:

- **Collection worth** values each stack at its own price — two normals at $0.09
  plus three foils at $0.22 is $0.84, not five of anything.
- **CSV and riftbound.gg exports** emit one row per printing, which is how other
  trackers file them and what riftbound.gg's `foil` column expects.
- **Text export** folds them into one line per card — `5x Chaos Rune (UNL R05)
  [3 foil]` — since that list is meant to read like a binder.
- **TCGplayer mass entry** uses the combined count: that box has no syntax for a
  printing, and picking the foil is something you do in the cart.
- **The deck generator** counts every copy — a foil is the same card across the
  table.

`sync-prices.mjs` reads foil prices from a per-product endpoint, the only one
that separates Normal from Foil. There is no batch form, so it costs one request
per card — about 1,380 of them, run six at a time inside the same daily job. A
lookup that fails carries the previous sync's foil price forward rather than
dropping it, the same way the exchange rate is.

## Cards Riftcodex doesn't have

Riftcodex lags TCGplayer's catalogue. Most visibly it carries no Rune rows at
all for Unleashed or Spiritforged, so a rune pulled from either pack had nowhere
to go; 232 of TCGplayer's products had no counterpart here in total.

`sync-cards.mjs` keeps Riftcodex as the source of record and fills what it
lacks, rebuilding the card ID from the collector number. Collections are keyed
by ID, so a wrong guess is worse than an absent card — a synthetic ID colliding
with a real one silently rewrites what someone owns. Three guards apply:

1. the number has to match a shape we trust — `131/219` or `R05`, nothing else
2. the resulting ID must not already belong to a real card
3. no two products may claim the same ID

The predictor was checked by replaying it over the 1,049 products already held:
every one reproduces its real ID. On the current catalogue the guards admit 91
of the 232, including all 54 missing runes. The 141 left out are Prize Wall
metals whose IDs would have collided, tokens, and starred signature variants.

Synthesised cards carry type, domains, rarity, costs and often rules text, but
no art — TCGplayer's CDN refuses hotlinks — so the grid shows a labelled
placeholder that dims and brightens on ownership like a real image. Costs follow
Riftcodex's convention rather than TCGplayer's zeros, or a Rune claiming energy 0
would sort ahead of the cards the cost sorts deliberately sink. They're flagged
`partial: true`, and a real Riftcodex row takes over whenever one appears.
