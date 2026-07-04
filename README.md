# Izzet Prowess — unusual card scan

Live: **https://prowess-proxy.david-3f9.workers.dev/**

A Cloudflare Worker that scans the [MTGGoldfish Modern Izzet Prowess archetype
page](https://www.mtggoldfish.com/archetype/modern-izzet-prowess) for recent
decklists and highlights cards that deviate from a **stock list**. The Worker
both serves the static page and provides the data API — one deploy, one URL.

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
the columns balance. Ranges only widen what counts as "normal": a count inside
the range still shows its delta (to keep the swap math complete) but isn't
flagged. This is how a fetch trade surfaces — cut a Fiery Islet for a 3rd
Mountain and the `-1 Fiery Islet` is balanced by `+1 Mountain`; run 9 fetches
instead of 10 and `-1 Fetchland` shows without inflating the badge.

## Archetypes

The dropdown is driven by `ARCHETYPES` in `worker/public/index.html`; the Worker
scrapes any `?archetype=<slug>`. An archetype only gets comparison/highlighting
when it has an entry in `STOCKS` — otherwise its recent decks are listed plainly.

## Editing the stock list

Edit the relevant `STOCKS[<slug>]` entry (`main` with numbers/ranges, `side` as
a list of names) in `worker/public/index.html`.

## Deploying

```
cd worker
npx wrangler deploy
```

Deploys both the page (`public/`) and the API from a single Worker.
