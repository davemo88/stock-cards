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

    // Edge cache keyed by archetype (ignore ?refresh in the key).
    const cacheKey = new Request(`${url.origin}/decks?archetype=${slug}`, request);
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

    const resp = json(payload, 200, {
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
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

  return { generated: new Date().toISOString(), archetype: slug, count: decks.length, decks };
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
