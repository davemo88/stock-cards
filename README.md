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

- **md added** (orange) / **sb added** (blue) — copies *above* the stock max,
  shown as `+N Card`. Includes brand-new cards (expected 0) and overages of a
  stock card (e.g. 2 Spell Snare vs a stock 1 → `+1 Spell Snare`).
- **md removed** (purple) / **sb removed** (teal) — copies *below* the stock min,
  shown as `-N Card`. Includes partial reductions (3 vs a stock 4 → `-1 Card`)
  and full cuts (0 vs a stock 4 → `-4 Card`). The "ignore count deltas" toggle
  keeps only brand-new cards and full cuts, hiding pure quantity changes.
- **Fetchlands** (the classic 10 + Prismatic Vista / Fabled Passage) are
  bucketed into one virtual `Fetchland` so mana-base fetch swaps don't flag.
- Hover any card name (chips, decklist panel, stock bar) for a Scryfall image.

### Ranges

A stock count (maindeck *or* sideboard) may be a number (`4`) or a **range
string**:

- `"2-3"` — only flags when the deck runs fewer than 2 or more than 3.
- `"0-2"` — a flex slot: 0–2 copies are fine and its absence never flags.
- Give the whole fetch bucket a range with a `"Fetchland": "8-10"` stock entry.

Because a within-range move is invisible, a swap can leave the columns
unbalanced (cut a Fiery Islet, add a 3rd Mountain within its `2-3` range → only
the `-1` shows). To keep the picture complete, a within-range increase above the
low end of its range is **revealed as a muted, dashed `rng` chip** in the added
column, so the hidden half of the swap still appears and the columns reconcile.
Muted reveals don't count toward the badge, and the `Fetchland` bucket is left
quiet so the mana base doesn't generate noise.

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
