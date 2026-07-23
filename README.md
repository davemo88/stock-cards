# Izzet Prowess — unusual card scan

Live: **https://prowess-proxy.david-3f9.workers.dev/**

A Cloudflare Worker that scans MTGGoldfish Modern archetype pages for recent
decklists and highlights cards that deviate from a **stock list**. The Worker
both serves the static page and provides the data API — one deploy, one URL.

Two archetype tabs, both served by the same `index.html` (the page picks its
config from the URL path):

- **Izzet Prowess** at `/` — scrapes
  [modern-izzet-prowess](https://www.mtggoldfish.com/archetype/modern-izzet-prowess)
  (merged with its `modern-izzet-cutter` rename).
- **Grixis Reanimator** at `/grixis-reanimator` — scrapes
  [modern-grixis-reanimator](https://www.mtggoldfish.com/archetype/modern-grixis-reanimator);
  its stock list comes from the card breakdown on that archetype homepage.

Per-archetype config (slug, title, stock list, localStorage keys) lives in the
`ARCHETYPES` map in `worker/public/index.html`; the server-side stock copies
live in `DEFAULT_STOCKS` in `worker/worker.js` (keep them in sync). Each
archetype gets its own shared history under its own KV key, and the 6-hour cron
advances every tracked archetype.

## How it works

```
Browser  ── GET /       ─► Worker static asset (index.html)
         ── GET /decks  ─► Worker script ──scrapes + caches (30 min)─► mtggoldfish.com
                                                                         │ JSON
index.html  ◄── diffs each deck vs the stock list in the browser ────────┘
            └── renders the list + hover side-panel
```

- **`worker/public/index.html`** — the whole page. On load it fetches parsed
  decks from `/decks` (same origin), diffs each against the stock list *in the
  browser*, and renders a list with unusual cards highlighted plus a hover
  side-panel showing the full decklist. The stock list and diff rules live
  here, so tweaking them is a one-file edit.
- **`worker/worker.js`** — the Worker. Serves the static page, and on `/decks`
  fetches the archetype page + each decklist, parses them, and returns JSON. It
  caches at the edge for 30 minutes so mtggoldfish isn't re-scraped on every
  visit. `?refresh=1` bypasses the cache; `?archetype=<slug>` scans a different
  archetype.
- **`prowess_scan.py`** — a standalone offline generator that produces a
  self-contained static report (no Worker needed). Useful for a one-off snapshot.

## Find events

The **📍 find events** button in the header looks up nearby paper Modern events
through the [WotC event locator](https://locator.wizards.com/)'s backing API
(`api.tabletop.wizards.com`, proxied by the Worker's `/events` route). It first
asks for browser geolocation; declining falls back to a US ZIP code (geocoded
via zippopotam.us). Results — soonest first — show date/time, event name, shop
(linked to its website), address (linked to Google Maps), entry fee, and
distance in miles.

## Comparison rules

The maindeck and sideboard are compared identically, and each deck's
differences are laid out in four columns — the maindeck pair, a divider, then
the sideboard pair:

Every card's delta is measured from its **nominal** stock count (see Ranges),
so the added and removed columns always balance for a fixed-size deck.

- **md added** (orange) / **sb added** (blue) — copies *above* nominal, shown as
  `+N Card`. Includes brand-new cards and overages of a stock card.
- **md removed** (purple) / **sb removed** (teal) — copies *below* nominal, shown
  as `-N Card`. Includes partial reductions and full cuts.
- A delta whose count still sits **inside the allowed range** is shown like any
  other chip (so the columns reconcile) but does **not** count toward the badge —
  e.g. a deck on 9 fetchlands vs a `10 (8-10)` stock shows `-1 Fetchland` without
  being flagged as unusual. The "hide in-range moves" toggle drops those chips.
- **Fetchlands** (the classic 10 + Prismatic Vista / Fabled Passage) are
  bucketed into one virtual `Fetchland` so mana-base fetch swaps don't flag.
- Hover any card name (chips, decklist panel, stock bar) for a Scryfall image.

### Nominals and ranges

A stock count carries a **nominal** (its count in the real list — the reference
all deltas are measured from) and an allowed **range**. Three forms:

- `4` — nominal 4, exact.
- `"2-3"` — range 2–3, nominal = the low end (2).
- `"10 (8-10)"` — nominal 10, allowed range 8–10.

The nominals should sum to the real deck size (60 maindeck / 15 sideboard) so
the columns balance. Ranges widen what counts as "normal": an in-range delta is
never flagged (no badge), and it is **only shown when it's needed to balance the
notable diffs**. Concretely, per zone the app keeps the smallest set of in-range
chips that covers the out-of-range residual and drops the rest — so a
self-canceling mana shuffle (`+1 Mountain`, `+1 Steam Vents`, `-2 Fetchland`)
disappears when the real diffs already balance, but a `-1 Consign to Memory`
that makes room for a `+2 Tormod's Crypt` still shows.

## Meta swaps (auto-applied)

On every load, after diffing all lists against the stock list, the page checks
each zone (**maindeck and sideboard**) for a **swap that has taken over the
majority**: a brand-new card that **more than 50%** of the scraped lists now
run. When one is found:

- A **notification banner** at the top announces it in the same diff format used
  per deck — e.g. `MD +1 Flashback` (md-added colour) *replaces* `-1 Mutagenic
  Growth` (md-removed colour), or `SB +1 Into the Flood Maw` *replaces*
  `-1 Prismari Charm`, each with the adoption count (`18/30 lists, 60%`).
- The swap is **folded into the stock list**: the new card is added (as a
  tolerant `size (0-size)` flex slot) and a slot is freed **without cutting a
  card the field still plays**. The swap-out is chosen as an *abandoned* stock
  card (now in ≤50% of lists) if one exists; otherwise the lowest-prevalence
  **over-provisioned** card — one whose nominal exceeds its **mode** (most common
  count) — is trimmed toward its mode. E.g. Consign to Memory is nominally
  `4 (3-4)` but its mode is 3, so it trims to `3 (3-4)` to make room for Into the
  Flood Maw; Prismari Charm (run in 19/30) is left alone. This keeps the zone
  balanced (60 maindeck / 15 sideboard). The diffs, digest, and top stock display
  all re-render against the updated list.

The swap itself is recomputed fresh each load from live data and is **not**
persisted — if the meta shifts back, the swap stops being applied. A manual edit
via the stock editor becomes the base the swap folds into.

### Version history (shared, server-side)

Each time the effective (post-swap) stock list **changes**, that version is
appended to a timeline stamped with the date/time it was applied and the swaps
that produced it, capped at 50 entries. Repeat records of an unchanged stock
list are de-duplicated. A **history navigator** below the banner lets you cycle
back through earlier versions (`◀` / `▶`, plus *jump to latest*); selecting an
older version re-diffs every deck, the digest, and the stock display against it.

The timeline is stored **on the Worker** in a KV namespace
(`prowess-stock-list-history`, bound as `env.STOCK_HISTORY`) so it is **shared** —
a brand-new visitor sees the whole history, not just their own browser's. The
Worker computes the swaps itself (a server-side mirror of the client logic, so
`DEFAULT_STOCK` is duplicated in `worker.js` and must be kept in sync), records a
new version whenever the effective list changes, and returns the timeline in the
`/decks` payload. It advances from three triggers:

- **the 6-hour cron** (`crons = ["0 */6 * * *"]`) — a `scheduled()` handler that
  re-scrapes and records even with no visitors;
- **any fresh scrape on `/decks`** — including a visitor pressing **↻ refresh**
  (`?refresh=1` bypasses the edge cache), which records a new version if the
  swap has changed;

A normal cached load neither re-scrapes nor writes — it serves the timeline as
of the cached payload. The browser still mirrors the latest server timeline into
`localStorage` (`prowess-stock-history-v1`) as an offline fallback, and computes
the history locally if the Worker returns none.

The **full stock list** is shown at the top in the same rich format as the deck
lists — grouped by card type with mana symbols — but laid out as a **row of type
columns** rather than the vertical hover side-panel.

## Editing the stock list

The **✎ edit stock list** button
opens a textarea to edit the stock list live — one card per line
(`4 Lightning Bolt`, `2 (2-3) Mountain`, `10 (8-10) Fetchland`), with a
`Sideboard` line splitting the two sections. **Apply** re-diffs every deck and
saves the edit to `localStorage` (this browser only); **Reset to default**
restores the built-in list and clears the saved copy.

The built-in defaults live in the `ARCHETYPES` map in
`worker/public/index.html` (one stock list per tab); edits are saved per
archetype.

## Deploying

```
cd worker
npx wrangler deploy
```

Deploys both the page (`public/`) and the API from a single Worker.
