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

- **Maindeck** — flags cards absent from the stock maindeck *and* cards whose
  count differs (count matters). The "ignore count deltas" toggle hides the
  latter.
- **Sideboard** — presence vs absence only.
- **Fetchlands** (the classic 10 + Prismatic Vista / Fabled Passage) are
  bucketed into one virtual `Fetchland` so mana-base fetch swaps don't flag.

## Editing the stock list

Edit `STOCK_MAIN` / `STOCK_SIDE` in `worker/public/index.html`. To point at a
different archetype, change `ARCHETYPE` there — the Worker accepts any
`?archetype=<slug>`.

## Deploying

```
cd worker
npx wrangler deploy
```

Deploys both the page (`public/`) and the API from a single Worker.
