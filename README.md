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

- **md new** (orange) / **sb new** (blue) — a card not in the stock list, shown
  as `+N Card`.
- **md count off** (purple) / **sb count off** (teal) — a stock card whose count
  falls outside its stock range, shown as a signed delta `+/-N Card` (e.g. a
  deck on 3 copies vs a stock 4 shows `-1 Card`). An absent stock card is just
  count 0, so it folds in here as `-N Card`. The "ignore count deltas" toggle
  hides this whole category.
- **Fetchlands** (the classic 10 + Prismatic Vista / Fabled Passage) are
  bucketed into one virtual `Fetchland` so mana-base fetch swaps don't flag.
- Hover any card name (chips, decklist panel, stock bar) for a Scryfall image.

### Ranges

A stock count (maindeck *or* sideboard) may be a number (`4`) or a **range
string**:

- `"2-3"` — only flags when the deck runs fewer than 2 or more than 3.
- `"0-2"` — a flex slot: 0–2 copies are fine and its absence never flags.
- Give the whole fetch bucket a range with a `"Fetchland": "8-10"` stock entry.

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
