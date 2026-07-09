// prowess-proxy — fetches an MTGGoldfish archetype page + its decklists,
// parses them server-side, and returns JSON with CORS headers so a static
// site (GitHub Pages) can render fresh decks on load.
//
// Routes:
//   GET /decks?archetype=<slug>   -> { generated, archetype, decks: [...] }
//   GET /health                   -> "ok"
// Query:
//   ?refresh=1  bypasses the edge cache and re-scrapes.
//
// Results are cached at the edge for CACHE_TTL seconds so mtggoldfish is not
// hit on every visitor load.

const BASE = "https://www.mtggoldfish.com";
const DEFAULT_ARCHETYPE = "modern-izzet-prowess";
const CACHE_TTL = 1800; // 30 min
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) prowess-proxy/1.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// KV key for the shared stock-list history, and the cap on retained versions.
const HISTORY_KEY = "stock-history";
const HISTORY_MAX = 50;

// All fetchlands collapse into one bucket so mana-base fetch swaps don't flag.
const FETCHLANDS = new Set([
  "Arid Mesa", "Scalding Tarn", "Wooded Foothills", "Bloodstained Mire",
  "Flooded Strand", "Polluted Delta", "Marsh Flats", "Misty Rainforest",
  "Verdant Catacombs", "Windswept Heath", "Prismatic Vista", "Fabled Passage",
]);
const FETCH_BUCKET = "Fetchland";

// The base stock list the swap engine measures against. KEEP IN SYNC with
// DEFAULT_STOCK in public/index.html — this is the server-side copy so the
// shared history can be computed without a browser. A count is a number (4),
// a range "2-3", or a nominal + range "10 (8-10)".
const DEFAULT_STOCK = {
  main: {
    "Thundering Falls": 1, "Slickshot Show-Off": 4, "Violent Urge": 2,
    "Cori-Steel Cutter": 4, "Mishra's Bauble": 4, "Lightning Bolt": 4,
    "Preordain": 4, "Mutagenic Growth": 4, "Steam Vents": "3 (3-4)", "Monastery Swiftspear": 4,
    "Lava Dart": 4, "Fiery Islet": 2, "Mountain": "3 (2-3)",
    "Expressive Iteration": 4, "Dragon's Rage Channeler": 4,
    "Fetchland": "9 (8-10)",
  },
  side: {
    "Meltdown": 2, "Consign to Memory": "4 (3-4)", "Unholy Heat": "3 (2-3)",
    "Spell Pierce": 2, "Murktide Regent": 1, "Tormod's Crypt": "2 (1-3)", "Prismari Charm": 1,
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (url.pathname === "/health") {
      return new Response("ok", { headers: CORS });
    }
    if (url.pathname !== "/decks") {
      return json({ error: "not found" }, 404);
    }

    const slug = sanitizeSlug(url.searchParams.get("archetype") || DEFAULT_ARCHETYPE);
    const refresh = url.searchParams.get("refresh") === "1";

    // Edge cache keyed by archetype (ignore ?refresh in the key). Bump the
    // version when the payload shape changes so stale caches are skipped.
    const cacheKey = new Request(`${url.origin}/decks?archetype=${slug}&v=5`, request);
    const cache = caches.default;
    if (!refresh) {
      const hit = await cache.match(cacheKey);
      if (hit) return withCors(hit);
    }

    let payload;
    try {
      payload = await scrape(slug);
    } catch (err) {
      return json({ error: "scrape failed", detail: String(err) }, 502);
    }

    // Fold this scrape into the shared stock-list history (Izzet Prowess only —
    // DEFAULT_STOCK is archetype-specific) and return it so a fresh visitor sees
    // the whole timeline, not just their own localStorage.
    if (slug === DEFAULT_ARCHETYPE) {
      try {
        payload.history = await recordHistoryKV(env, payload.decks);
      } catch (_) {
        payload.history = await loadHistoryKV(env).catch(() => []);
      }
    }

    // Only cache a payload whose Scryfall enrichment succeeded. If it failed
    // (rate-limit / cold worker), `types` is empty and every card would render
    // as "Other"; caching that would poison every visitor for CACHE_TTL. Serve
    // the degraded payload once, uncached, so the next load re-runs enrichment.
    const enriched = payload.decks.length === 0 ||
      Object.keys(payload.types || {}).length > 0;
    const resp = json(payload, 200, {
      "Cache-Control": enriched ? `public, max-age=${CACHE_TTL}` : "no-store",
    });
    if (enriched) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },

  // Cron trigger (see wrangler.toml [triggers]): advance the shared history on a
  // schedule so it keeps up with the meta even when nobody visits the site.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const payload = await scrape(DEFAULT_ARCHETYPE);
          await recordHistoryKV(env, payload.decks);
        } catch (_) { /* best effort; next tick retries */ }
      })(),
    );
  },
};

// --------------------------------------------------------------------------- //
async function scrape(slug) {
  const html = await fetchText(`${BASE}/archetype/${slug}`);
  const tournaments = parseArchetype(html);

  // Fetch every unique deck's plaintext list in parallel.
  const ids = [...new Set(tournaments.flatMap((t) => t.decks.map((d) => d.id)))];
  const deckTexts = await Promise.all(
    ids.map((id) =>
      fetchText(`${BASE}/deck/download/${id}`)
        .then((txt) => [id, parseDeckText(txt)])
        .catch(() => [id, null]),
    ),
  );
  const byId = new Map(deckTexts);

  const decks = [];
  for (const t of tournaments) {
    for (const row of t.decks) {
      const parsed = byId.get(row.id);
      if (!parsed || Object.keys(parsed.main).length === 0) continue;
      decks.push({
        id: row.id,
        place: row.place,
        player: row.player,
        tourney: t.name,
        date: t.date,
        url: `${BASE}/deck/${row.id}`,
        main: parsed.main,
        side: parsed.side,
      });
    }
  }

  const names = [...new Set(decks.flatMap((d) =>
    [...Object.keys(d.main), ...Object.keys(d.side)]))];
  const { mana, types, cmc } = await fetchCards(names);

  return {
    generated: new Date().toISOString(), archetype: slug,
    count: decks.length, decks, mana, types, cmc,
  };
}

// name -> { mana_cost, primary type, cmc } via Scryfall's bulk collection API.
async function fetchCards(names) {
  const mana = {}, types = {}, cmc = {};
  for (let i = 0; i < names.length; i += 75) {
    const identifiers = names.slice(i, i + 75).map((name) => ({ name }));
    try {
      // Retry a couple of times so a transient rate-limit doesn't leave the
      // whole batch un-typed (which would render every card as "Other").
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST",
          headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ identifiers }),
        });
        if (r.ok) break;
      }
      if (!r.ok) continue;
      const j = await r.json();
      for (const c of j.data || []) {
        const face = c.card_faces && c.card_faces[0];
        const mc = c.mana_cost || (face && face.mana_cost) || "";
        if (mc) mana[c.name] = mc;
        types[c.name] = category(c.type_line || (face && face.type_line) || "");
        cmc[c.name] = typeof c.cmc === "number" ? c.cmc : 0;
      }
    } catch (_) { /* leave those cards without symbols/types */ }
  }
  return { mana, types, cmc };
}

function category(typeLine) {
  const t = typeLine.split("//")[0];
  if (/\bLand\b/.test(t)) return "Land";
  if (/\bCreature\b/.test(t)) return "Creature";
  if (/\bPlaneswalker\b/.test(t)) return "Planeswalker";
  if (/\bInstant\b/.test(t)) return "Instant";
  if (/\bSorcery\b/.test(t)) return "Sorcery";
  if (/\bArtifact\b/.test(t)) return "Artifact";
  if (/\bEnchantment\b/.test(t)) return "Enchantment";
  if (/\bBattle\b/.test(t)) return "Battle";
  return "Other";
}

async function fetchText(target) {
  const r = await fetch(target, {
    headers: { "User-Agent": UA, Accept: "text/html,text/plain,*/*" },
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`${target} -> HTTP ${r.status}`);
  return r.text();
}

// --------------------------------------------------------------------------- //
// Parsing (ported from prowess_scan.py)
function parseArchetype(html) {
  const tournaments = [];
  const hdr =
    /<h4>\s*<a href="\/tournament\/(\d+)">([\s\S]*?)<\/a>[\s\S]*?<nobr>on\s*([\d-]+)<\/nobr>/g;
  const heads = [...html.matchAll(hdr)];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const start = h.index + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : html.length;
    const block = html.slice(start, end);
    const name = unescapeHtml(h[2].replace(/\s+\d{4}-\d\d-\d\d\s*$/, "").trim());

    const rows = [];
    for (const tr of block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const seg = tr[1];
      const did = seg.match(/href="\/deck\/(\d+)#online"/);
      if (!did) continue;
      const place = seg.match(/column-place'>\s*([\s\S]*?)\s*<\/td>/);
      const player = seg.match(/\/player\/[^"]+">([^<]+)<\/a>/);
      rows.push({
        id: did[1],
        place: place ? unescapeHtml(place[1].trim()) : "",
        player: player ? unescapeHtml(player[1].trim()) : "?",
      });
    }
    if (rows.length) tournaments.push({ id: h[1], name, date: h[3], decks: rows });
  }
  return tournaments;
}

function parseDeckText(text) {
  const main = {};
  const side = {};
  let sawBlank = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      sawBlank = true;
      continue;
    }
    const m = line.match(/^(\d+)\s+(.*\S)$/);
    if (!m) continue;
    const target = sawBlank ? side : main;
    const name = m[2].trim();
    target[name] = (target[name] || 0) + parseInt(m[1], 10);
  }
  return { main, side };
}

function unescapeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function sanitizeSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 80) || DEFAULT_ARCHETYPE;
}

// --------------------------------------------------------------------------- //
// Swap engine (server-side mirror of the logic in public/index.html). Detects a
// brand-new card that a majority (>50%) of lists run, in each zone, and folds it
// into the stock list. Kept intentionally parallel to the client so the shared
// history matches what a browser would compute.
function parseStock(spec) {
  if (typeof spec === "number") return { nom: spec, min: spec, max: spec };
  const s = String(spec).trim();
  let m = s.match(/^(\d+)\s*\(\s*(\d+)\s*-\s*(\d+)\s*\)$/);
  if (m) return { nom: +m[1], min: +m[2], max: +m[3] };
  m = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) return { nom: +m[1], min: +m[1], max: +m[2] };
  const n = parseInt(s, 10) || 0;
  return { nom: n, min: n, max: n };
}
function bucketDeck(counts) {
  const out = {};
  for (const [name, n] of Object.entries(counts)) {
    const key = FETCHLANDS.has(name) ? FETCH_BUCKET : name;
    out[key] = (out[key] || 0) + n;
  }
  return out;
}
function bucketStock(spec) {
  const out = {};
  for (const [name, s] of Object.entries(spec)) {
    const r = parseStock(s);
    const key = FETCHLANDS.has(name) ? FETCH_BUCKET : name;
    out[key] = out[key]
      ? { nom: out[key].nom + r.nom, min: out[key].min + r.min, max: out[key].max + r.max }
      : { ...r };
  }
  return out;
}
// Per-zone add/rem arrays: [name, delta, deckCount, range, inRange].
function compareZone(counts, stockB) {
  const add = [], rem = [];
  const names = new Set([...Object.keys(counts), ...Object.keys(stockB)]);
  for (const name of names) {
    const n = counts[name] || 0;
    const r = stockB[name] || { nom: 0, min: 0, max: 0 };
    const delta = n - r.nom;
    if (delta === 0) continue;
    const inRange = n >= r.min && n <= r.max;
    (delta > 0 ? add : rem).push([name, delta, n, r, inRange]);
  }
  return { add, rem };
}
function diffDeck(deck, stock) {
  const cm = compareZone(bucketDeck(deck.main), bucketStock(stock.main));
  const cs = compareZone(bucketDeck(deck.side || {}), bucketStock(stock.side));
  return { addMain: cm.add, remMain: cm.rem, addSide: cs.add, remSide: cs.rem };
}
// Mode (most common count, ties -> higher) and prevalence (# lists running it)
// of every card in a set of bucketed deck counts. The mode is the "most common
// value" a range's nominal should represent.
function zoneStats(bucketedCounts) {
  const stat = {};
  for (const bc of bucketedCounts) {
    for (const [name, v] of Object.entries(bc)) {
      const s = stat[name] || (stat[name] = { dist: new Map(), prev: 0, total: bucketedCounts.length });
      if (v > 0) s.prev++;
      s.dist.set(v, (s.dist.get(v) || 0) + 1);
    }
  }
  for (const [name, s] of Object.entries(stat)) {
    // include implicit zeros for lists that don't run the card
    const zeros = s.total - s.prev;
    if (zeros > 0) s.dist.set(0, (s.dist.get(0) || 0) + zeros);
    let mode = 0, best = -1;
    for (const [v, c] of s.dist) if (c > best || (c === best && v > mode)) { best = c; mode = v; }
    s.mode = mode;
  }
  return stat;
}
function detectSwaps(decks, stock) {
  if (!decks.length) return [];
  const total = decks.length;
  const perDeck = decks.map((dk) => diffDeck(dk, stock));
  const zones = [
    { zone: "main", add: "addMain", stockB: bucketStock(stock.main),
      stats: zoneStats(decks.map((dk) => bucketDeck(dk.main))) },
    { zone: "side", add: "addSide", stockB: bucketStock(stock.side),
      stats: zoneStats(decks.map((dk) => bucketDeck(dk.side || {}))) },
  ];
  const swaps = [];
  for (const z of zones) {
    // Swap-in candidates: cards not in stock that a majority of lists run.
    const lists = new Map(), counts = new Map();
    for (const d of perDeck) {
      for (const [name, , n, , inRange] of d[z.add]) {
        if (inRange || z.stockB[name]) continue;
        lists.set(name, (lists.get(name) || 0) + 1);
        const c = counts.get(name) || new Map();
        c.set(n, (c.get(n) || 0) + 1);
        counts.set(name, c);
      }
    }
    for (const [name, nLists] of lists) {
      if (nLists * 2 <= total) continue;              // must be run by >50%
      let size = 1, best = 0;                          // its modal (played) count
      for (const [n, c] of counts.get(name)) if (c > best) { best = c; size = n; }
      // Find room WITHOUT cutting a card the field still plays: prefer an
      // abandoned stock card (<=50%), else the lowest-prevalence card that is
      // over-provisioned (nominal > its mode) by at least `size`. Trimming it
      // toward its mode frees the slot.
      let out = null, oStat = null, oNom = 0, oReason = null;
      for (const cn of Object.keys(z.stockB)) {
        const s = z.stats[cn] || { mode: 0, prev: 0 };
        const nom = z.stockB[cn].nom;
        const abandoned = s.prev * 2 <= total;
        const capacity = abandoned ? nom : Math.max(0, nom - s.mode);
        if (capacity < size) continue;
        const better = !out || s.prev < oStat.prev ||
          (s.prev === oStat.prev && (nom - s.mode) > (oNom - oStat.mode));
        if (better) { out = cn; oStat = s; oNom = nom; oReason = abandoned ? "abandoned" : "trim"; }
      }
      if (!out) continue;                              // nothing safe to trim -> skip
      swaps.push({
        zone: z.zone, in: name, inSize: size, inLists: nLists, total,
        out, outBefore: oNom, outAfter: oNom - size, outMode: oStat.mode,
        outPrev: oStat.prev, reason: oReason,
      });
    }
  }
  return swaps;
}
function applySwapsToStock(stock, swaps) {
  const s = { main: { ...stock.main }, side: { ...stock.side } };
  for (const sw of swaps) {
    const zone = s[sw.zone];
    zone[sw.in] = `${sw.inSize} (0-${sw.inSize})`;
    if (sw.out && zone[sw.out] != null) {
      const cur = parseStock(zone[sw.out]);
      const newNom = cur.nom - sw.inSize;
      if (newNom <= 0) delete zone[sw.out];
      else {
        const max = Math.max(cur.max, cur.nom);
        zone[sw.out] = newNom === max ? `${newNom}` : `${newNom} (${newNom}-${max})`;
      }
    }
  }
  return s;
}
// Order-independent identity of a stock list, to detect real changes.
const stockKey = (s) =>
  JSON.stringify([Object.entries(s.main).sort(), Object.entries(s.side).sort()]);

function computeEffective(decks) {
  const swaps = detectSwaps(decks, DEFAULT_STOCK);
  const effective = swaps.length ? applySwapsToStock(DEFAULT_STOCK, swaps)
    : { main: { ...DEFAULT_STOCK.main }, side: { ...DEFAULT_STOCK.side } };
  return { effective, swaps };
}

// Read the shared history from KV, collapsing any accidental duplicate versions
// (a rare consequence of two concurrent writers appending the same change).
async function loadHistoryKV(env) {
  if (!env || !env.STOCK_HISTORY) return [];
  try {
    const raw = await env.STOCK_HISTORY.get(HISTORY_KEY);
    if (!raw) return [];
    const h = JSON.parse(raw);
    if (!Array.isArray(h)) return [];
    const out = [];
    for (const e of h) {
      if (!e || !e.stock || !e.stock.main || !e.stock.side) continue;
      const last = out[out.length - 1];
      if (last && stockKey(last.stock) === stockKey(e.stock)) continue;
      out.push(e);
    }
    return out;
  } catch (_) {
    return [];
  }
}
// Append the current effective stock to the shared history iff it changed.
// Returns the (possibly updated) history array.
async function recordHistoryKV(env, decks) {
  const hist = await loadHistoryKV(env);
  if (!env || !env.STOCK_HISTORY) return hist;
  const { effective, swaps } = computeEffective(decks);
  const last = hist[hist.length - 1];
  if (last && stockKey(last.stock) === stockKey(effective)) return hist;
  hist.push({ time: new Date().toISOString(), stock: effective, swaps });
  const trimmed = hist.length > HISTORY_MAX ? hist.slice(-HISTORY_MAX) : hist;
  await env.STOCK_HISTORY.put(HISTORY_KEY, JSON.stringify(trimmed));
  return trimmed;
}

// --------------------------------------------------------------------------- //
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function withCors(resp) {
  const r = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}
